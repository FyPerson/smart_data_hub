'use strict';

/**
 * #77 C1a：验收判定统一服务（routes/model-center/acceptance.js）纯函数验证。
 * 方案 v0.9 §4.1.2 规则 0-7 + 16 格真值表 + §7.1 第一条全组合。纯 node，不起服务、不碰数据库。
 *
 * 期望值一律手写表对拍，不用被测函数自己算。
 * 变异验证：设置环境变量 MC_ACCEPTANCE_MODULE 指向被临时改动的副本，再跑本脚本，应判红。
 * #77 C4-api：stale 附带 prevResult（11e 手写表 P1–P14 + 全局性质 G1 / G2 / G3 + stages 无键例）；
 *   对拍模式 --baseline-module=<path>：每次 run() 另用基线模块（改前的 acceptance.js）对同一输入的深拷贝求值，断言「新结果删去 prevResult 后的 JSON」与「基线结果的 JSON」逐字相等（键序也比），
 *   且基线结果不含 prevResult；输出「对拍 n 例 / 不一致 k」。不带该参数时不做对拍（FAMILY 照旧）。
 */

const path = require('path');

const moduleArg = process.argv.find(a => a.startsWith('--module='));
const modulePath = moduleArg
    ? path.resolve(moduleArg.slice('--module='.length))
    : (process.env.MC_ACCEPTANCE_MODULE
        ? path.resolve(process.env.MC_ACCEPTANCE_MODULE)
        : path.join(__dirname, '..', 'routes', 'model-center', 'acceptance.js'));
const { evaluateAcceptance, fetchRecordsByModelIds, fetchRecordsByModelId, latestParticipatingRecord } = require(modulePath);
const baselineArg = process.argv.find(a => a.startsWith('--baseline-module='));
const baselineEvaluate = baselineArg ? require(path.resolve(baselineArg.slice('--baseline-module='.length))).evaluateAcceptance : null;

const STATES = ['companion', 'pass', 'warn', 'fail', 'partial', 'stale', 'none'];
const SAME_SECOND_TEXT = '验收时间与任务创建时间在同一秒，请重新验收'; // 方案 §4.1.2 规则 1 原文

let checks = 0;
const failures = [];
const evaluated = []; // 收集所有判定结果，末尾统一断言 state 互斥 / gatePass 恒等
const inputs = [];    // 与 evaluated 一一对应的入参 { m, records, opts }（全局性质 G2 用）
const parity = { n: 0, bad: 0 };   // 对拍模式计数

function fail(label, detail) {
    failures.push(`${label}: ${detail}`);
    console.log(`[FAIL] ${label}: ${detail}`);
}

function eq(actual, expected, label) {
    checks++;
    if (actual !== expected) fail(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

let recSeq = 100;
function rec(time, result, phase, rev, extra) {
    const o = Object.assign({
        id: ++recSeq,
        test_time: time,
        overall_result: result,
        invalidated: 0,
        config_rev: rev,
        total_rows: 0,
        detail_json: phase ? JSON.stringify({ phase }) : JSON.stringify({ checks: [] })
    }, extra || {});
    return o;
}

function model(layer, rev, extra) {
    return Object.assign({ id: 1, layer, config_rev: rev, companion_of: null }, extra || {});
}

function run(m, records, opts) {
    // 对拍：基线用入参的深拷贝求值（先于新模块，避免任一方修改入参影响另一方）
    const base = baselineEvaluate ? baselineEvaluate(structuredClone(m), structuredClone(records), opts === undefined ? undefined : structuredClone(opts)) : null;
    const ev = evaluateAcceptance(m, records, opts);
    evaluated.push(ev);
    inputs.push({ m, records, opts });
    if (base) {
        parity.n++;
        checks++;
        const stripped = JSON.parse(JSON.stringify(ev));
        delete stripped.prevResult;
        if (JSON.stringify(stripped) !== JSON.stringify(base) || Object.prototype.hasOwnProperty.call(base, 'prevResult')) {
            parity.bad++;
            fail('对拍', `第 ${parity.n} 例（state=${ev.state}）：新结果删去 prevResult 后 ${JSON.stringify(stripped)} ≠ 基线 ${JSON.stringify(base)}`);
        }
    }
    return ev;
}

const T1 = '2026-09-30 10:00:00';
const T2 = '2026-09-30 10:05:00';
const T3 = '2026-09-30 10:10:00';
const T4 = '2026-09-30 10:15:00';

// ================= 1. DIM / DWD 两阶段 16 格真值表（逐格一例，期望手写） =================
// 行 = structure 阶段结果，列 = data 阶段结果；'-' = 缺
const TABLE = {
    pass: { pass: 'pass', warn: 'warn', fail: 'fail', '-': 'partial' },
    warn: { pass: 'warn', warn: 'warn', fail: 'fail', '-': 'partial' },
    fail: { pass: 'fail', warn: 'fail', fail: 'fail', '-': 'fail' },
    '-': { pass: 'partial', warn: 'partial', fail: 'fail', '-': 'none' }
};
for (const layer of ['DWD', 'DIM']) {
    for (const s of ['pass', 'warn', 'fail', '-']) {
        for (const d of ['pass', 'warn', 'fail', '-']) {
            const records = [];
            if (s !== '-') records.push(rec(T1, s, 'structure', 3));
            if (d !== '-') records.push(rec(T2, d, 'data', 3));
            const ev = run(model(layer, 3), records);
            eq(ev.state, TABLE[s][d], `16格 ${layer} structure=${s} data=${d}`);
        }
    }
}
// fail 含 pending 及任何其他值
eq(run(model('DWD', 3), [rec(T1, 'pending', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'fail', '16格 pending 归 fail');
eq(run(model('DWD', 3), [rec(T1, 'weird', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'fail', '16格 未知值归 fail');

// ================= 2. G2：all 阶段 =================
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3)]).state, 'pass', 'all 单条 pass => pass');
eq(run(model('DWD', 3), [rec(T1, 'warn', 'all', 3)]).state, 'warn', 'all 单条 warn => warn');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3), rec(T2, 'fail', 'all', 3)]).state, 'fail', 'G2：all 通过后 all 失败 => fail');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3), rec(T2, 'fail', 'all', 3)]).gatePass, false, 'G2：all 通过后 all 失败门禁不放行');
eq(run(model('DWD', 3), [rec(T1, 'fail', 'all', 3), rec(T2, 'pass', 'structure', 3), rec(T3, 'pass', 'data', 3)]).state, 'pass', 'all 失败后分阶段通过 => pass');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3), rec(T2, 'fail', 'structure', 3)]).state, 'fail', 'all 通过后 structure 失败 => fail');
eq(run(model('DWD', 3), [rec(T1, 'fail', 'all', 3), rec(T2, 'pass', 'structure', 3)]).state, 'fail', 'all 失败后仅 structure 通过：data 阶段仍取到失败的 all => fail');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3), rec(T2, 'warn', 'data', 3)]).state, 'warn', 'all 通过后 data warn => warn');

// ================= 3. ODS =================
for (const layerText of ['ODS', 'ods', 'Ods']) {
    eq(run(model(layerText, 2), [rec(T1, 'pass', null, 2)]).state, 'pass', `ODS(${layerText}) pass`);
    eq(run(model(layerText, 2), [rec(T1, 'warn', null, 2)]).state, 'warn', `ODS(${layerText}) warn`);
    eq(run(model(layerText, 2), [rec(T1, 'fail', null, 2)]).state, 'fail', `ODS(${layerText}) fail`);
    eq(run(model(layerText, 2), [rec(T1, 'pending', null, 2)]).state, 'fail', `ODS(${layerText}) pending => fail`);
    eq(run(model(layerText, 2), []).state, 'none', `ODS(${layerText}) 无记录 => none`);
}
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2), rec(T2, 'fail', null, 2)]).state, 'fail', 'ODS 最新一条 fail 压住旧 pass');
eq(run(model('ODS', 2), [rec(T1, 'fail', null, 2), rec(T2, 'pass', null, 2)]).state, 'pass', 'ODS 最新一条 pass 覆盖旧 fail');
// 大小写：layer 大小写同一分支（ods 与 ODS 行为一致）
eq(run(model('dwd', 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'pass', 'layer dwd 小写走 DIM/DWD 分支');
eq(run(model('dim', 3), [rec(T1, 'pass', 'structure', 3)]).state, 'partial', 'layer dim 小写走 DIM/DWD 分支（partial）');
// ODS 分支不认 phase 记录；DIM/DWD 分支不认无 phase 记录
eq(run(model('ODS', 2), [rec(T1, 'pass', 'structure', 2)]).state, 'none', 'ODS 分支：带 phase 的记录不进候选');
eq(run(model('DWD', 3), [rec(T1, 'pass', null, 3)]).state, 'none', 'DWD 分支：无 phase 记录不进候选');

// ================= 4. 其他分层 / 伴生 =================
for (const other of ['ADS', 'DM', '', null, 'xyz']) {
    const ev = run(model(other, 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3), rec(T3, 'pass', null, 3)]);
    eq(ev.state, 'none', `其他分层 ${JSON.stringify(other)} => none`);
    eq(ev.gatePass, false, `其他分层 ${JSON.stringify(other)} gatePass=false`);
}
{
    const ev = run(model('DWD', 3, { companion_of: 5 }), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3)]);
    eq(ev.state, 'companion', '伴生 DWD => companion（即使有通过记录）');
    eq(ev.gatePass, false, '伴生 gatePass=false');
    eq(run(model('ODS', 2, { companion_of: 9 }), [rec(T1, 'pass', null, 2)]).state, 'companion', '伴生 ODS => companion');
}

// ================= 5. config_rev：当前版本 / stale / NULL =================
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'stale', '仅旧版本通过 => stale');
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', null), rec(T2, 'pass', 'data', null)]).state, 'stale', 'config_rev IS NULL 记录通过 => stale（不属于当前版本）');
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', null), rec(T2, 'pass', 'data', null)]).gatePass, false, 'config_rev IS NULL 不放行');
eq(run(model('ODS', 4), [rec(T1, 'warn', null, 3)]).state, 'stale', 'ODS 旧版本 warn => stale');
eq(run(model('ODS', 4), [rec(T1, 'fail', null, 3)]).state, 'none', '仅旧版本且为 fail => none（无可背书的通过记录）');
eq(run(model('ODS', 4), [rec(T1, 'pass', null, 3, { invalidated: 1 })]).state, 'none', '旧版本通过但已失效 => none');
// 当前版本有候选时，旧版本记录不参与
eq(run(model('ODS', 4), [rec(T1, 'pass', null, 3), rec(T2, 'fail', null, 4)]).state, 'fail', '当前版本 fail，旧版本 pass 不救场');
eq(run(model('ODS', 4), [rec(T2, 'fail', null, 3), rec(T1, 'pass', null, 4)]).state, 'pass', '当前版本 pass，较新的旧版本 fail 不拖累');
// 夹具里 model.config_rev 为 NULL：任何记录都不匹配
eq(run(model('ODS', null), [rec(T1, 'pass', null, null)]).gatePass, false, '模型与记录 config_rev 都为 NULL 也不放行');

// ================= 6. invalidated =================
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { invalidated: 1 })]).state, 'none', 'invalidated=1 不进候选');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { invalidated: null })]).state, 'pass', 'invalidated NULL 视同 0');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { invalidated: undefined })]).state, 'pass', 'invalidated undefined 视同 0');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2), rec(T2, 'fail', null, 2, { invalidated: 1 })]).state, 'pass', '最新 fail 已失效 => 回落到旧 pass');

// ================= 7. semantic 不进候选 =================
eq(run(model('DIM', 3), [rec(T1, 'pass', 'semantic', 3)]).state, 'none', '仅 semantic 记录 => none');
eq(run(model('DIM', 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'semantic', 3)]).state, 'partial', 'semantic 不补 data 阶段 => partial');
eq(run(model('DIM', 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3), rec(T3, 'pass', 'semantic', 3)]).state, 'pass', 'semantic 存在与否不影响 pass');
eq(run(model('DIM', 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3), rec(T3, 'fail', 'semantic', 3)]).state, 'pass', 'semantic 失败也不拖累');
eq(run(model('DIM', 4), [rec(T1, 'pass', 'semantic', 3)]).state, 'none', '旧版本仅 semantic 通过不构成 stale');

// ================= 8. 同秒按 id 定先后 =================
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { id: 1 }), rec(T1, 'fail', null, 2, { id: 2 })]).state, 'fail', '同秒 id 大者为新（fail）');
eq(run(model('ODS', 2), [rec(T1, 'fail', null, 2, { id: 1 }), rec(T1, 'pass', null, 2, { id: 2 })]).state, 'pass', '同秒 id 大者为新（pass）');
eq(run(model('ODS', 2), [rec(T1, 'fail', null, 2, { id: 2 }), rec(T1, 'pass', null, 2, { id: 1 })]).state, 'fail', '同秒：数组顺序无关，id 大者 fail');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { id: 1 }), rec(T1, 'fail', 'structure', 3, { id: 2 }), rec(T2, 'pass', 'data', 3, { id: 3 })]).state, 'fail', '同秒 structure 两条，id 大者 fail');
eq(run(model('DWD', 3), [rec(T1, 'fail', 'structure', 3, { id: 2 }), rec(T1, 'pass', 'structure', 3, { id: 9 }), rec(T2, 'pass', 'data', 3, { id: 3 })]).state, 'pass', '同秒 structure 两条，id 大者 pass');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { id: 10 }), rec(T1, 'fail', null, 2, { id: 9 })]).state, 'pass', '同秒 id 10 vs 9：数值比较而非字符串比较');

// ================= 9. 任务创建时间（门禁，opts.task，严格大于） =================
{
    const tAt = '2026-09-30 10:05:00';
    const records = [rec(tAt, 'pass', null, 2)];
    const same = run(model('ODS', 2), records, { task: { created_at: tAt } });
    eq(same.gatePass, false, '任务创建与验收同秒 => 门禁拒绝（严格大于）');
    eq(same.reason, SAME_SECOND_TEXT, '同秒被拒 reason 为方案原文');
    const later = run(model('ODS', 2), [rec('2026-09-30 10:05:01', 'pass', null, 2)], { task: { created_at: tAt } });
    eq(later.gatePass, true, '验收晚任务创建 1 秒 => 放行');
    eq(later.state, 'pass', '验收晚任务创建 => pass');
    const earlier = run(model('ODS', 2), [rec('2026-09-30 10:04:59', 'pass', null, 2)], { task: { created_at: tAt } });
    eq(earlier.gatePass, false, '验收早于任务创建 => 拒绝（任务创建前的记录）');
    eq(earlier.reason === SAME_SECOND_TEXT, false, '早于任务创建不是同秒原因');
    // 无 opts.task：同一批记录只看版本，放行
    eq(run(model('ODS', 2), records).gatePass, true, '不带 opts.task 时同秒记录不被拒');
    // 任务删除重建后旧记录：新任务 created_at 晚于旧记录
    eq(run(model('ODS', 2), [rec('2026-09-29 09:00:00', 'pass', null, 2)], { task: { created_at: '2026-09-30 08:00:00' } }).gatePass, false, '任务删除重建后旧记录不放行');
    // DIM/DWD：两阶段都要晚于任务创建
    const dwdTask = { task: { created_at: T2 } };
    eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3), rec(T3, 'pass', 'data', 3)], dwdTask).state, 'partial', 'DWD 门禁：structure 早于任务、data 晚于任务 => partial');
    eq(run(model('DWD', 3), [rec(T3, 'pass', 'structure', 3), rec(T4, 'pass', 'data', 3)], dwdTask).gatePass, true, 'DWD 门禁：两阶段都晚于任务 => 放行');
    const dwdSame = run(model('DWD', 3), [rec(T2, 'pass', 'all', 3)], dwdTask);
    eq(dwdSame.gatePass, false, 'DWD 门禁：all 与任务同秒 => 拒绝');
    eq(dwdSame.reason, SAME_SECOND_TEXT, 'DWD 同秒拒绝 reason 为方案原文');
    // 版本过滤与时间过滤叠加：晚于任务但旧版本 => 不放行
    eq(run(model('ODS', 3), [rec(T4, 'pass', null, 2)], { task: { created_at: T2 } }).gatePass, false, '晚于任务但版本落后 => 不放行');
    // 旧 pass 被新 fail 压住
    eq(run(model('ODS', 2), [rec(T3, 'pass', null, 2), rec(T4, 'fail', null, 2)], { task: { created_at: T2 } }).gatePass, false, '任务后先 pass 再 fail => 不放行');
}

// ================= 10. at / rows =================
{
    const ev = run(model('ODS', 2), [rec(T1, 'pass', null, 2, { total_rows: 10 }), rec(T2, 'pass', null, 2, { total_rows: 25 })]);
    eq(ev.at, T2, 'ODS at = 最新候选 test_time');
    eq(ev.rows, 25, 'ODS rows = 最新候选 total_rows');
    const dv = run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { total_rows: 0 }), rec(T2, 'pass', 'data', 3, { total_rows: 77 })]);
    eq(dv.at, T2, 'DWD at = 决定记录中最新的 test_time');
    eq(dv.rows, 77, 'DWD rows = data 阶段记录 total_rows');
    eq(run(model('ODS', 2), []).at, null, '无记录 at=null');
    eq(run(model('ODS', 2), []).rows, null, '无记录 rows=null');
    eq(run(model('ODS', 4), [rec(T1, 'pass', null, 3)]).at, T1, 'stale at = 最近一条旧版本通过记录时间');
}

// ================= 11. 入参健壮性 =================
eq(run(model('ODS', 2), null).state, 'none', 'records=null => none');
eq(run(model('ODS', 2), undefined).state, 'none', 'records=undefined => none');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, '2')]).state, 'pass', 'config_rev 字符串 "2" 与数字 2 等价');
eq(run(model('DWD', 3), [{ id: 1, test_time: T1, overall_result: 'pass', invalidated: 0, config_rev: 3, total_rows: 1, detail_json: '{坏json "phase":"structure"}' }, rec(T2, 'pass', 'data', 3)]).state, 'pass', 'detail_json 非法 JSON 时退回正则取 phase');

// ================= 11b. 预筛补缺：时间优先于 id / stages 手写期望 / reason / L4 =================
// 时间更新但 id 更小：按 test_time 取新（id 只在同秒时定先后）
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { id: 50 }), rec(T2, 'fail', null, 2, { id: 10 })]).state, 'fail', '时间更新但 id 更小：ODS 取 test_time 更新的 fail');
eq(run(model('ODS', 2), [rec(T1, 'fail', null, 2, { id: 50 }), rec(T2, 'pass', null, 2, { id: 10 })]).state, 'pass', '时间更新但 id 更小：ODS 取 test_time 更新的 pass');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { id: 90 }), rec(T2, 'fail', 'structure', 3, { id: 20 }), rec(T3, 'pass', 'data', 3, { id: 5 })]).state, 'fail', '时间更新但 id 更小：structure 取 test_time 更新的 fail');

// stages.structure / stages.data 手写期望（[structure 输入, data 输入, 期望 stages.structure, 期望 stages.data]）
const STAGE_CASES = [
    ['pass', 'warn', 'pass', 'warn'],
    ['warn', 'pass', 'warn', 'pass'],
    ['fail', 'pass', 'fail', 'pass'],
    ['pass', 'fail', 'pass', 'fail'],
    ['pass', '-', 'pass', null],
    ['-', 'warn', null, 'warn'],
    ['-', 'fail', null, 'fail'],
    ['fail', '-', 'fail', null]
];
for (const layer of ['DIM', 'DWD']) {
    for (const [s, d, es, ed] of STAGE_CASES) {
        const records = [];
        if (s !== '-') records.push(rec(T1, s, 'structure', 3));
        if (d !== '-') records.push(rec(T2, d, 'data', 3));
        const ev = run(model(layer, 3), records);
        eq(ev.stages && ev.stages.structure, es, `stages ${layer} structure=${s} data=${d} => stages.structure`);
        eq(ev.stages && ev.stages.data, ed, `stages ${layer} structure=${s} data=${d} => stages.data`);
    }
}
{
    // all 记录同时计入两个阶段
    const ev = run(model('DWD', 3), [rec(T1, 'warn', 'all', 3)]);
    eq(ev.stages && ev.stages.structure, 'warn', 'stages：all warn 计入 structure');
    eq(ev.stages && ev.stages.data, 'warn', 'stages：all warn 计入 data');
    // stageDetail 取各阶段自己那条记录的时间 / 执行人
    const sd = run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { test_user: '甲' }), rec(T3, 'warn', 'data', 3, { test_user: '乙' })]).stageDetail;
    eq(sd.structure.test_time, T1, 'stageDetail.structure.test_time 取该阶段自己的记录');
    eq(sd.data.test_time, T3, 'stageDetail.data.test_time 取该阶段自己的记录');
    eq(sd.structure.test_user, '甲', 'stageDetail.structure.test_user');
    eq(sd.data.test_user, '乙', 'stageDetail.data.test_user');
}

// partial 两种 reason（手写原文）
eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3)]).reason, '缺少数据阶段验收', 'partial reason：缺数据阶段');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'data', 3)]).reason, '缺少结构阶段验收', 'partial reason：缺结构阶段');

// 早于任务创建 / 同秒 reason（手写原文）
eq(run(model('ODS', 2), [rec('2026-09-30 10:04:59', 'pass', null, 2)], { task: { created_at: '2026-09-30 10:05:00' } }).reason,
    '当前版本的验收记录早于任务创建时间，请重新验收', '早于任务创建 reason 原文');
eq(run(model('DWD', 3), [rec(T1, 'pass', 'all', 3)], { task: { created_at: T2 } }).reason,
    '当前版本的验收记录早于任务创建时间，请重新验收', 'DWD all 早于任务创建 reason 原文');
eq(run(model('ODS', 2), [rec(T2, 'pass', null, 2)], { task: { created_at: T2 } }).reason, SAME_SECOND_TEXT, '同秒 reason 原文（再核）');

// L4：opts.task 存在但 created_at 为空 => fail-closed
for (const badTask of [{}, { created_at: null }, { created_at: '' }, { created_at: '   ' }]) {
    const ev = run(model('ODS', 2), [rec(T4, 'pass', null, 2)], { task: badTask });
    eq(ev.gatePass, false, `L4 task=${JSON.stringify(badTask)} gatePass=false`);
    eq(ev.state, 'none', `L4 task=${JSON.stringify(badTask)} state=none`);
    eq(ev.reason, '任务缺少创建时间，无法判定验收是否晚于任务', `L4 task=${JSON.stringify(badTask)} reason 原文`);
}
eq(run(model('DWD', 3), [rec(T3, 'pass', 'all', 3)], { task: { created_at: null } }).gatePass, false, 'L4 DWD 同样 fail-closed');
eq(run(model('ODS', 2), [rec(T4, 'pass', null, 2)], { task: null }).gatePass, true, 'opts.task=null 视为不带任务条件');

// ================= 11c. codex 20T：混合版本 / semantic 混入 ODS / 字符串 invalidated / 入参不变 / S2 / S4 =================
// T1 混合版本（期望手写；当前版本 rev=3，旧版本 rev=2）
for (const layer of ['DIM', 'DWD']) {
    const M = model(layer, 3);
    eq(run(M, [rec(T1, 'fail', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'fail', `T1 ${layer} 当前版本 structure fail + data pass => fail`);
    eq(run(M, [rec(T1, 'pass', 'structure', 3)]).state, 'partial', `T1 ${layer} 当前版本仅 structure pass => partial`);
    eq(run(M, [rec(T1, 'pass', 'data', 3)]).state, 'partial', `T1 ${layer} 当前版本仅 data pass => partial`);
    // 当前版本 fail / partial，旧版本两阶段都 pass：不是 stale
    const oldBoth = [rec(T1, 'pass', 'structure', 2), rec(T1, 'pass', 'data', 2)];
    eq(run(M, oldBoth.concat([rec(T2, 'fail', 'structure', 3)])).state, 'fail', `T1 ${layer} 当前 fail + 旧两阶段 pass => fail（不是 stale）`);
    eq(run(M, oldBoth.concat([rec(T2, 'pass', 'structure', 3)])).state, 'partial', `T1 ${layer} 当前 partial + 旧两阶段 pass => partial（不是 stale）`);
    eq(run(M, oldBoth.concat([rec(T2, 'pass', 'data', 3)])).state, 'partial', `T1 ${layer} 当前仅 data pass + 旧两阶段 pass => partial`);
    // 当前版本两阶段 pass，旧版本 fail（含更晚的旧版本 fail）：pass
    eq(run(M, [rec(T4, 'fail', 'structure', 2), rec(T4, 'fail', 'data', 2), rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3)]).state, 'pass', `T1 ${layer} 当前两阶段 pass + 较新的旧版本 fail => pass`);
    eq(run(M, [rec(T1, 'fail', 'all', 2), rec(T2, 'pass', 'all', 3)]).state, 'pass', `T1 ${layer} 当前 all pass + 旧 all fail => pass`);
    // 旧版本 pass + 当前版本无记录 => stale（对照）
    eq(run(M, oldBoth).state, 'stale', `T1 ${layer} 仅旧版本两阶段 pass => stale（对照）`);
}

// S4：高于当前版本的记录既不当候选也不当旧版本
for (const layer of ['DWD', 'ODS']) {
    const ph = layer === 'ODS' ? [null, null] : ['structure', 'data'];
    const M = model(layer, 3);
    const hi = [rec(T1, 'pass', ph[0], 5)].concat(layer === 'ODS' ? [] : [rec(T2, 'pass', ph[1], 5)]);
    eq(run(M, hi).state, 'none', `S4 ${layer} 仅高于当前版本的 pass => none（不是 stale）`);
    eq(run(M, hi).gatePass, false, `S4 ${layer} 高版本记录不放行`);
    const ev = run(M, hi.concat([rec(T3, 'pass', ph[0], 2)]));
    eq(ev.state, 'stale', `S4 ${layer} 高版本被忽略、低版本 pass => stale`);
    eq(ev.at, T3, `S4 ${layer} stale.at 取低版本记录而非高版本`);
}
eq(run(model('ODS', 3), [rec(T4, 'pass', null, 9), rec(T1, 'pass', null, null)]).at, T1, 'S4 高版本 + NULL 版本：stale 取 NULL 版本那条');

// T2 ODS 混入 semantic
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2), rec(T3, 'fail', 'semantic', 2)]).state, 'pass', 'T2 semantic fail 作为最新记录不压住有效 ODS pass');
eq(run(model('ODS', 2), [rec(T1, 'fail', null, 2), rec(T3, 'pass', 'semantic', 2)]).state, 'fail', 'T2 semantic pass 作为最新记录不洗白 ODS fail');
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2), rec(T3, 'warn', 'semantic', 2)]).state, 'pass', 'T2 semantic warn 不把 ODS pass 变 warn');
eq(run(model('ODS', 2), [rec(T1, 'pass', 'semantic', 2)]).state, 'none', 'T2 只有 semantic pass => none');
eq(run(model('ODS', 2), [rec(T1, 'fail', 'semantic', 2), rec(T2, 'warn', 'semantic', 2)]).state, 'none', 'T2 只有 semantic fail/warn => none');
eq(run(model('ODS', 3), [rec(T1, 'pass', null, 2), rec(T2, 'pass', 'semantic', 3)]).state, 'stale', 'T2 旧版本 ODS pass + 当前版本仅 semantic => stale');
eq(run(model('ODS', 2), [rec(T1, 'pass', 'semantic', 2)]).gatePass, false, 'T2 只有 semantic 时门禁不放行');

// T4 invalidated 字符串
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { invalidated: '0' })]).state, 'pass', "T4 ODS invalidated '0' 参与");
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { invalidated: '1' })]).state, 'none', "T4 ODS invalidated '1' 排除");
eq(run(model('ODS', 3), [rec(T1, 'pass', null, 2, { invalidated: '1' })]).state, 'none', "T4 ODS 旧版本 invalidated '1' 不构成 stale");
eq(run(model('ODS', 3), [rec(T1, 'pass', null, 2, { invalidated: '0' })]).state, 'stale', "T4 ODS 旧版本 invalidated '0' 构成 stale");
eq(run(model('ODS', 3), [rec(T1, 'pass', null, 3, { invalidated: '0' }), rec(T2, 'fail', null, 3, { invalidated: '1' })]).state, 'pass', "T4 ODS 最新 fail 为 '1' 被排除 => 回落到 '0' 的 pass");
eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { invalidated: '0' }), rec(T2, 'pass', 'data', 3, { invalidated: '0' })]).state, 'pass', "T4 DWD invalidated '0' 两阶段参与 => pass");
eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { invalidated: '1' }), rec(T2, 'pass', 'data', 3, { invalidated: '0' })]).state, 'partial', "T4 DWD structure '1' 被排除 => partial");
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', 3, { invalidated: '1' }), rec(T2, 'pass', 'data', 3, { invalidated: '1' })]).state, 'none', "T4 DWD 旧版本两阶段 '1' => none");
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', 3, { invalidated: '0' }), rec(T2, 'pass', 'data', 3, { invalidated: '1' })]).state, 'stale', "T4 DWD 旧版本 structure '0' pass => stale");
eq(run(model('DWD', 4), [rec(T1, 'pass', 'structure', 4, { invalidated: '1' }), rec(T2, 'fail', 'data', 4, { invalidated: '0' }), rec(T3, 'pass', 'structure', 3, { invalidated: '0' })]).state, 'fail', "T4 DWD 当前版本 structure '1' 排除、data '0' fail => fail（旧版本 pass 不救场）");

// T5 evaluateAcceptance 不修改入参 records 的顺序与元素引用
function assertInputUntouched(label, m, records, opts) {
    const refs = records.slice();
    const snapshot = JSON.stringify(records);
    run(m, records, opts);
    eq(records.length, refs.length, `T5 ${label}：records 长度不变`);
    eq(records.every((r, i) => r === refs[i]), true, `T5 ${label}：records 顺序与元素引用不变`);
    eq(JSON.stringify(records), snapshot, `T5 ${label}：records 内容不变`);
}
assertInputUntouched('ODS 同秒多条（乱序）', model('ODS', 2),
    [rec(T2, 'pass', null, 2, { id: 7 }), rec(T1, 'fail', null, 2, { id: 9 }), rec(T2, 'fail', null, 2, { id: 8 }), rec(T3, 'pass', null, 1, { id: 3 })]);
assertInputUntouched('DWD 多阶段同秒（乱序）', model('DWD', 3),
    [rec(T3, 'pass', 'data', 3, { id: 12 }), rec(T1, 'fail', 'structure', 3, { id: 11 }), rec(T1, 'pass', 'structure', 3, { id: 10 }), rec(T2, 'pass', 'all', 3, { id: 13 }), rec(T2, 'pass', 'semantic', 3, { id: 14 })]);
assertInputUntouched('带任务条件 + stale 分支', model('DIM', 4),
    [rec(T3, 'pass', 'structure', 2, { id: 5 }), rec(T1, 'pass', 'data', 2, { id: 4 }), rec(T2, 'pass', 'all', 2, { id: 6 })], { task: { created_at: T2 } });

// S2 decisiveRecordId / stageDetail.id
eq(run(model('ODS', 2), [rec(T1, 'pass', null, 2, { id: 41 }), rec(T2, 'fail', null, 2, { id: 40 })]).decisiveRecordId, 40, 'S2 ODS decisiveRecordId = 最新候选（时间优先于 id）');
eq(run(model('ODS', 2), []).decisiveRecordId, null, 'S2 无记录 decisiveRecordId=null');
{
    const ev = run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { id: 21 }), rec(T3, 'warn', 'data', 3, { id: 20 })]);
    eq(ev.decisiveRecordId, 20, 'S2 DWD decisiveRecordId = 决定记录中最新者（data）');
    eq(ev.stageDetail.structure.id, 21, 'S2 stageDetail.structure.id');
    eq(ev.stageDetail.data.id, 20, 'S2 stageDetail.data.id');
    eq(run(model('DWD', 3), [rec(T1, 'pass', 'structure', 3, { id: 30 })]).decisiveRecordId, 30, 'S2 partial decisiveRecordId');
    eq(run(model('DWD', 4), [rec(T1, 'pass', 'all', 3, { id: 31 })]).decisiveRecordId, 31, 'S2 stale decisiveRecordId = 旧版本通过记录');
    eq(run(model('DWD', 4), [rec(T1, 'fail', 'all', 3, { id: 32 })]).decisiveRecordId, null, 'S2 none decisiveRecordId=null');
}

// ================= 11d. latestParticipatingRecord（validation-status 旧 status 语义）+ 视图层组合 + S2 补例 =================
{
    const idOf = r => (r ? r.id : null);
    const DWDM = model('DWD', 3);
    // 最新一条是 semantic → 取次新参与记录
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 61 }), rec(T3, 'pass', 'semantic', 3, { id: 62 })])), 61, 'LPR 最新是 semantic → 取次新参与记录');
    // 最新一条 invalidated=1 / '1' → 跳过
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 63 }), rec(T3, 'fail', 'data', 3, { id: 64, invalidated: 1 })])), 63, 'LPR 最新 invalidated=1 → 跳过');
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 65 }), rec(T3, 'fail', 'data', 3, { id: 66, invalidated: '1' })])), 65, "LPR 最新 invalidated='1' → 跳过");
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 67, invalidated: '0' })])), 67, "LPR invalidated='0' 参与");
    // 跨版本：不分版本，取时间最新
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 68 }), rec(T3, 'fail', 'data', 1, { id: 69 })])), 69, 'LPR 跨版本不分版本，取时间最新（旧版本那条）');
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T3, 'pass', 'all', 9, { id: 70 }), rec(T1, 'pass', 'structure', 3, { id: 71 })])), 70, 'LPR 高于当前版本的记录同样参与');
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T3, 'pass', 'all', null, { id: 72 }), rec(T1, 'pass', 'structure', 3, { id: 73 })])), 72, 'LPR config_rev 为 NULL 的记录同样参与');
    // phase 与 layer 的匹配
    eq(idOf(latestParticipatingRecord(model('ODS', 2), [rec(T3, 'pass', 'structure', 2, { id: 74 }), rec(T1, 'warn', null, 2, { id: 75 })])), 75, 'LPR ODS 模型上带 phase 的记录被排除');
    eq(idOf(latestParticipatingRecord(model('ods', 2), [rec(T1, 'warn', null, 2, { id: 76 })])), 76, 'LPR layer 小写 ods 同 ODS');
    eq(idOf(latestParticipatingRecord(model('DIM', 3), [rec(T3, 'pass', null, 3, { id: 77 }), rec(T1, 'pass', 'data', 3, { id: 78 })])), 78, 'LPR DIM 模型上无 phase 的记录被排除');
    eq(latestParticipatingRecord(model('DWD', 3), [rec(T1, 'pass', null, 3)]), null, 'LPR DWD 只有无 phase 记录 → null');
    eq(latestParticipatingRecord(model('ODS', 2), [rec(T1, 'pass', 'semantic', 2)]), null, 'LPR 只有 semantic → null');
    // 非标准 layer / 无记录
    for (const other of ['ADS', '', null, undefined, 'xyz']) {
        eq(latestParticipatingRecord(model(other, 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', null, 3)]), null, `LPR 非标准 layer ${JSON.stringify(other)} → null`);
    }
    eq(latestParticipatingRecord(DWDM, []), null, 'LPR 无记录 → null');
    eq(latestParticipatingRecord(DWDM, null), null, 'LPR records=null → null');
    // 同秒：id 大者
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 80 }), rec(T1, 'fail', 'data', 3, { id: 81 })])), 81, 'LPR 同秒 id 大者');
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'fail', 'data', 3, { id: 90 }), rec(T1, 'pass', 'structure', 3, { id: 82 })])), 90, 'LPR 同秒：数组顺序无关，id 大者');
    eq(idOf(latestParticipatingRecord(DWDM, [rec(T1, 'pass', 'structure', 3, { id: 10 }), rec(T1, 'pass', 'data', 3, { id: 9 })])), 10, 'LPR 同秒 id 数值比较（10 > 9）');

    // 视图层组合：复现 server.js buildValidationStatusView（约 9885-9900）——
    //   status 取 latestParticipatingRecord、state / gatePass 取 evaluateAcceptance
    const viewOf = (m, records) => {
        const ev = evaluateAcceptance(m, records);
        const legacy = latestParticipatingRecord(m, records);
        return { status: legacy ? legacy.overall_result : 'never', state: ev.state, gatePass: ev.gatePass };
    };
    const v1 = viewOf(model('DIM', 3), [rec(T1, 'pass', 'structure', 3)]);
    eq(v1.status, 'pass', '视图层 DIM 只有 structure=pass → status === pass');
    eq(v1.state, 'partial', '视图层 DIM 只有 structure=pass → state === partial');
    eq(v1.gatePass, false, '视图层 DIM 只有 structure=pass → gatePass=false');
    const v2 = viewOf(model('ODS', 4), [rec(T1, 'pass', null, 3)]);
    eq(v2.status, 'pass', '视图层 ODS 仅旧版本 pass → status === pass（不分版本）');
    eq(v2.state, 'stale', '视图层 ODS 仅旧版本 pass → state === stale');
    const v3 = viewOf(model('ODS', 2), []);
    eq(v3.status, 'never', '视图层无记录 → status === never');
    eq(v3.state, 'none', '视图层无记录 → state === none');
    const v4 = viewOf(model('DWD', 3), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3), rec(T3, 'fail', 'all', 2)]);
    eq(v4.status, 'fail', '视图层 status 取不分版本最新一条（旧版本 fail），与 state 无关');
    eq(v4.state, 'pass', '视图层 state 仍按当前版本判定 pass');

    // S2 补例：structure 在更晚时间、data 在更早时间 → decisiveRecordId 为 structure 那条
    const evLate = run(model('DWD', 3), [rec(T3, 'pass', 'structure', 3, { id: 51 }), rec(T1, 'pass', 'data', 3, { id: 52 })]);
    eq(evLate.decisiveRecordId, 51, 'S2 structure 更晚、data 更早 → decisiveRecordId 取 structure 那条（51）');
    eq(evLate.at, T3, 'S2 structure 更晚 → at 取 structure 的时间');
}

// ================= 11e. C4-api：stale 附带 prevResult；stages 键只在 DIM/DWD 有当前版本候选时才有 =================
{
    // prevResult = 决定 stale 的那条旧版本通过记录（与 at / decisiveRecordId 同一条）的 overall_result（取值 pass | warn）
    const P = (label, m, recs, prev, at, opts) => {
        const ev = run(m, recs, opts);
        eq(ev.state, 'stale', `11e ${label} state=stale`);
        eq(ev.prevResult, prev, `11e ${label} prevResult`);
        if (at !== undefined) eq(ev.at, at, `11e ${label} at`);
        return ev;
    };
    P('P1', model('ODS', 4), [rec(T1, 'pass', null, 3)], 'pass', T1);
    P('P2', model('ODS', 4), [rec(T1, 'warn', null, 3)], 'warn', T1);
    P('P3 更新的旧版本 fail 不是通过记录', model('ODS', 4), [rec(T1, 'pass', null, 3), rec(T2, 'fail', null, 3)], 'pass', T1);
    P('P4 按时间取新，不按版本号', model('ODS', 4), [rec(T3, 'warn', null, 2), rec(T1, 'pass', null, 3)], 'warn', T3);
    P('P5 同秒取 id 大者', model('ODS', 4), [rec(T1, 'pass', null, 3, { id: 5 }), rec(T1, 'warn', null, 3, { id: 6 })], 'warn', T1);
    P('P6 同秒取 id 大者（P5 对照）', model('ODS', 4), [rec(T1, 'pass', null, 3, { id: 6 }), rec(T1, 'warn', null, 3, { id: 5 })], 'pass', T1);
    P('P7 config_rev 为 NULL 的遗留记录', model('ODS', 3), [rec(T1, 'warn', null, null)], 'warn', T1);
    P('P8 高于当前版本的记录忽略', model('ODS', 3), [rec(T4, 'pass', null, 9), rec(T1, 'warn', null, 2)], 'warn', T1);
    P('P9 已失效的更新记录不参与', model('ODS', 3), [rec(T2, 'warn', null, 2, { invalidated: 1 }), rec(T1, 'pass', null, 2)], 'pass', T1);
    P('P10 DWD 分阶段：取最近一条旧版本通过记录', model('DWD', 4), [rec(T1, 'pass', 'structure', 3), rec(T2, 'warn', 'data', 3)], 'warn', T2);
    P('P11 DWD all 阶段', model('DWD', 4), [rec(T1, 'pass', 'all', 3)], 'pass', T1);
    P('P12 semantic 不参与', model('DIM', 4), [rec(T1, 'pass', 'structure', 3), rec(T3, 'warn', 'semantic', 3)], 'pass', T1);
    P('P13 口径：最近一条旧版本通过记录的结果，不是旧版本的整体判定', model('DIM', 4), [rec(T1, 'warn', 'structure', 3), rec(T2, 'fail', 'data', 3)], 'warn', T1);
    const p14 = P('P14 门禁路径（带 opts.task）同样附带', model('ODS', 3), [rec(T4, 'pass', null, 2)], 'pass', T4, { task: { created_at: T2 } });
    eq(p14.gatePass, false, '11e P14 gatePass 仍为 false（prevResult 不影响门禁）');
    // P15：stale 分支「原因被改写」子路径（门禁调用 + 当前版本有记录但都不晚于任务创建时间 + 存在旧版本通过记录）。prevResult 只取旧版本那条（warn），不取当前版本早于任务的那条（pass）
    const p15a = P('P15a 当前版本记录早于任务创建时间 → reason 改写为「早于任务」', model('ODS', 3), [rec(T1, 'pass', null, 3), rec(T1, 'warn', null, 2)], 'warn', T1, { task: { created_at: T2 } });
    eq(p15a.reason, '当前版本的验收记录早于任务创建时间，请重新验收', '11e P15a reason 为「早于任务」原文');
    eq(p15a.gatePass, false, '11e P15a gatePass 为 false');
    const p15b = P('P15b 当前版本记录与任务创建时间同一秒 → reason 改写为「同一秒」', model('ODS', 3), [rec(T2, 'pass', null, 3), rec(T1, 'warn', null, 2)], 'warn', T1, { task: { created_at: T2 } });
    eq(p15b.reason, SAME_SECOND_TEXT, '11e P15b reason 为「同一秒」原文');
    eq(p15b.gatePass, false, '11e P15b gatePass 为 false');
    // stages 无键例：ODS pass / ODS fail / DWD stale / DWD none / 伴生 / ADS
    const noStages = (label, ev) => eq('stages' in ev, false, `11e stages 无键：${label}`);
    noStages('ODS pass', run(model('ODS', 2), [rec(T1, 'pass', null, 2)]));
    noStages('ODS fail', run(model('ODS', 2), [rec(T1, 'fail', null, 2)]));
    noStages('DWD stale', run(model('DWD', 4), [rec(T1, 'pass', 'all', 3)]));
    noStages('DWD none', run(model('DWD', 4), []));
    noStages('伴生', run(model('DWD', 3, { companion_of: 9 }), [rec(T1, 'pass', 'structure', 3), rec(T2, 'pass', 'data', 3)]));
    noStages('ADS pass', run(model('ADS', 2), [rec(T1, 'pass', null, 2)]));
}

// ================= 12. 全局性质：state 互斥、gatePass 与 state 恒等 =================
for (const ev of evaluated) {
    checks++;
    const hits = STATES.filter(s => ev.state === s);
    if (hits.length !== 1) fail('state 互斥', `state=${JSON.stringify(ev.state)} 不属于且仅属于一个合法取值`);
    const expectedGate = ev.state === 'pass' || ev.state === 'warn';
    if (ev.gatePass !== expectedGate) fail('gatePass 恒等', `state=${ev.state} gatePass=${ev.gatePass}`);
    if (typeof ev.reason !== 'string') fail('reason 类型', `state=${ev.state} reason 非字符串`);
}
// C4-api 全局性质：G1 非 stale 无自有键 prevResult；G2 stale 的 prevResult ∈ {pass, warn} 且等于 records 里 decisiveRecordId 那条的 overall_result；
//   G3 自有键 stages ⇔（layer 大写后 ∈ {DIM, DWD}、非伴生、state ∈ {pass, warn, fail, partial}）——钉住列表投影「其余一律 null」所依赖的前提
evaluated.forEach((ev, i) => {
    const { m, records } = inputs[i];
    const has = (k) => Object.prototype.hasOwnProperty.call(ev, k);
    checks++;
    if (ev.state !== 'stale' && has('prevResult')) fail('G1 prevResult 键', `state=${ev.state} 不应带 prevResult`);
    if (ev.state === 'stale') {
        checks++;
        const dec = (records || []).find(r => r.id === ev.decisiveRecordId);
        if (!['pass', 'warn'].includes(ev.prevResult) || !dec || dec.overall_result !== ev.prevResult) fail('G2 prevResult', `prevResult=${JSON.stringify(ev.prevResult)} decisive=${JSON.stringify(dec && dec.overall_result)}`);
    }
    checks++;
    const wantStages = ['DIM', 'DWD'].includes(String(m.layer).toUpperCase()) && !m.companion_of && ['pass', 'warn', 'fail', 'partial'].includes(ev.state);
    if (has('stages') !== wantStages) fail('G3 stages 键', `layer=${m.layer} companion_of=${m.companion_of} state=${ev.state} 有 stages 键=${has('stages')}，期望 ${wantStages}`);
});
// 六种业务 state（pass/warn/fail/partial/stale/none）+ companion 全部被上面的用例覆盖到
{
    const seen = new Set(evaluated.map(e => e.state));
    for (const s of STATES) {
        checks++;
        if (!seen.has(s)) fail('覆盖', `用例里没有产生过 state=${s}`);
    }
}

// ================= 13. T3 取数助手（内存 sqlite 夹具） =================
async function fetchHelperTests() {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(':memory:');
    const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => (err ? rej(err) : res())));
    try {
        await dbRun(`CREATE TABLE model_test_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL, table_name TEXT,
            test_time DATETIME, test_user TEXT, overall_result TEXT, invalidated INTEGER DEFAULT 0,
            config_rev INTEGER, total_rows INTEGER, detail_json TEXT)`);
        const ins = (mid, time, user, result, rev) => dbRun(
            'INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, invalidated, config_rev, total_rows, detail_json) VALUES (?,?,?,?,?,?,?,?,?)',
            [mid, 't', time, user, result, 0, rev, 7, JSON.stringify({ phase: 'structure' })]);
        await ins(1, T1, '甲', 'pass', 1);
        await ins(1, T2, '乙', 'fail', 2);
        await ins(400, T1, '丙', 'pass', 1);   // 恰为第一块的最后一个 id
        await ins(401, T2, '丁', 'warn', 1);   // 第二块
        await ins(801, T3, '戊', 'pass', 1);   // 第三块
        await ins(999, T4, '己', 'pass', 1);   // 未被请求，不得出现

        // 空输入
        eq((await fetchRecordsByModelIds(db, [])).size, 0, 'T3 空数组 => 空 Map');
        eq((await fetchRecordsByModelIds(db, null)).size, 0, 'T3 null => 空 Map');
        eq((await fetchRecordsByModelIds(db, undefined)).size, 0, 'T3 undefined => 空 Map');

        // 重复 / 非法 id
        const messy = await fetchRecordsByModelIds(db, [1, '1', 1, 2, 'abc', null, undefined, '', NaN, 1.5, -3, 0]);
        eq(Array.from(messy.keys()).sort((a, b) => a - b).join(','), '1,2', 'T3 重复 / 非法 id 被丢弃，仅保留 1,2');
        eq(messy.get(1).length, 2, 'T3 重复 id 不重复取记录（model 1 共 2 条）');
        eq(messy.get(2).length, 0, 'T3 无记录 id 保留空数组');

        // 分块边界：400 / 401 / 801 个 id
        const range = n => Array.from({ length: n }, (_, i) => i + 1);
        for (const n of [400, 401, 801]) {
            const map = await fetchRecordsByModelIds(db, range(n));
            eq(map.size, n, `T3 ${n} 个 id => Map 大小 ${n}`);
            eq(map.get(1).length, 2, `T3 ${n} 个 id：model 1 两条`);
            eq(map.get(2).length, 0, `T3 ${n} 个 id：无记录 id 保留空数组`);
            eq(map.get(400).length, 1, `T3 ${n} 个 id：第一块末尾 id 400 归属正确`);
            eq(map.get(400)[0].test_user, '丙', `T3 ${n} 个 id：id 400 的记录属于它`);
            eq(map.has(999), false, `T3 ${n} 个 id：未请求的 id 999 不出现`);
            if (n >= 401) {
                eq(map.get(401).length, 1, `T3 ${n} 个 id：跨块 id 401 有记录`);
                eq(map.get(401)[0].test_user, '丁', `T3 ${n} 个 id：id 401 的记录归属正确`);
            }
            if (n >= 801) {
                eq(map.get(801).length, 1, `T3 ${n} 个 id：第三块 id 801 有记录`);
                eq(map.get(801)[0].test_user, '戊', `T3 ${n} 个 id：id 801 的记录归属正确`);
            }
            // 每条记录都落在自己 model_id 的桶里
            let misplaced = 0;
            for (const [key, rows] of map) for (const r of rows) if (Number(r.model_id) !== key) misplaced++;
            eq(misplaced, 0, `T3 ${n} 个 id：无错桶记录`);
        }

        // 单模型查询：列完整 + 无记录
        const single = await fetchRecordsByModelId(db, 1);
        eq(single.length, 2, 'T3 单模型查询返回该模型全部记录');
        eq(Object.keys(single[0]).sort().join(','),
            'config_rev,detail_json,id,invalidated,model_id,overall_result,test_time,test_user,total_rows',
            'T3 单模型查询列集合完整');
        eq((await fetchRecordsByModelId(db, 12345)).length, 0, 'T3 单模型无记录 => 空数组');
        // 批量与单个列集合一致
        eq(Object.keys((await fetchRecordsByModelIds(db, [1])).get(1)[0]).sort().join(','), Object.keys(single[0]).sort().join(','), 'T3 批量与单个查询列集合一致');
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

function finish() {
    if (baselineEvaluate) console.log(`对拍 ${parity.n} 例 / 不一致 ${parity.bad}`);
    if (failures.length) {
        console.log(`[FAIL] verify-model-acceptance：${failures.length} 条失败 / ${checks} 条断言；首条：${failures[0]}`);
        process.exit(1);
    }
    console.log(`[PASS] verify-model-acceptance：${checks} 条断言全绿（16 格真值表 × DIM/DWD、G2、ODS 大小写、stale/NULL、invalidated、semantic、同秒、任务时间、伴生、其他分层、混合版本、取数助手、prevResult / stages 键${baselineEvaluate ? "、对拍模式" : ""}）`);
}

fetchHelperTests().then(finish, err => {
    console.log(`[FAIL] verify-model-acceptance：取数助手测试异常 ${err && err.stack || err}`);
    process.exit(1);
});
