// verify-model-relations.js — #77 C2b-3 关系接口与列表关系计数（方案 v0.9 §4.5 / §6.1 C2b ⑥）
//
// 覆盖：
//   一、上游两端一致性对拍：服务端 require 的 UMD 模块得到的上游，与在 vm 里按浏览器方式（window 全局）加载同一文件得到的结果，对同一组夹具深度相等，
//       并与手写期望相等；
//   二、列表关系计数的 300ms 日志（进程内注入假时钟，不睡眠）；
//   三、objectState 判定函数（四种取值 + 多条件同时成立的优先级组合）；
//   四、HTTP：/downstream 改前改后逐项相等（期望值 = 改前代码在同一夹具上的实测输出，手写进本文件）、/relations 明细、objectState 四值与边界、
//       列表 rel 三计数（手写期望 + 与 /relations 三个数组长度逐行一致）、已删对象 / 已删模型不计入、权限（未登录 401）。
//
// 运行面：自包含、零本机库、零真实外发——直接复用 verify-model-config-rev-http.js 导出的起服务工具；
//   空库由被测代码自建，夹具在服务停止时写入，服务运行期间测试进程只持只读连接；不读不写 wbs-server/task_pool.db，不连网。
// 威胁模型：只证明「诚实实现写错时会判红」；期望值全部手写（不调用被测模块的函数或常量计算），不用固定 sleep。
//
// 变异自证（--self-test）：对被测源码副本逐个做破坏性改动，须使本套件判红且「首条」FAIL 以 expectPrefix 开头（严格因果）；超时或被杀计为失败。
//   单个变异：node scripts/verify-model-relations.js --mutation=<id>
// 改前基线：node scripts/verify-model-relations.js --dump-downstream 在夹具上打印 /downstream 的原始输出（改前代码上跑出的结果即本文件的手写期望来源）。
//
// 运行：node scripts/verify-model-relations.js        （--tmp=<目录> 或环境变量 MC_C1C_TMP 可指定临时根目录）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const H = require('./verify-model-config-rev-http.js');

const REL = ['routes', 'model-center', 'model-relations.js'];
const IMPL = ['routes', 'model-center', 'impl-objects.js'];

const MUTATIONS = [
  { id: 'upstream-copy', label: 'R-1 上游改成复制版逻辑（不再用前端模块，复制一份且键名写成 tableName）', expectPrefix: '两端一致性', file: REL,
    from: "    return kit.normalizeModelDetail({\n        layer: model.layer, config_mode: model.config_mode, companion_of: model.companion_of,\n        dim_config: parseDimConfig(model.dim_config),\n    }).sources;",
    to: "    const cfg = parseDimConfig(model.dim_config);\n    if (!cfg || model.companion_of || model.config_mode === 'custom' || !['DIM', 'DWD'].includes(layer)) return [];\n    return (Array.isArray(cfg.sourceTables) ? cfg.sourceTables : []).map((t) => ({ name: String((t && t.tableName) || ''), alias: String((t && t.alias) || ''), isPrimary: !!(t && t.isPrimary), joinType: (t && t.joinType) || null, joinCondition: (t && t.joinCondition) || null }));" },
  { id: 'no-slow-log', label: 'R-2 去掉 300ms 日志', expectPrefix: '300ms 日志：耗时 301', file: REL, from: 'if (elapsed > SLOW_MS) logger.warn(', to: 'if (false) logger.warn(' },
  { id: 'state-listed-last', label: 'R-3 objectState：listed 判定挪到最后', expectPrefix: 'objectState 判定：标准配置且有对象', file: REL,
    from: "    if (objectCount > 0) return 'listed';\n    if (model.companion_of != null) return 'companion';\n    if (!model.config_mode || model.config_mode === 'standard') return 'standard';\n    if (model.config_mode === 'custom') return 'pending';\n    return 'standard';",
    to: "    if (model.companion_of != null) return 'companion';\n    if (!model.config_mode || model.config_mode === 'standard') return 'standard';\n    if (model.config_mode === 'custom') return 'pending';\n    if (objectCount > 0) return 'listed';\n    return 'standard';" },
  { id: 'state-companion-after-standard', label: 'R-4 objectState：companion 判定挪到 standard / pending 之后', expectPrefix: 'objectState 判定：伴生表且配置方式为 standard', file: REL,
    from: "    if (model.companion_of != null) return 'companion';\n    if (!model.config_mode || model.config_mode === 'standard') return 'standard';\n    if (model.config_mode === 'custom') return 'pending';\n    return 'standard';",
    to: "    if (!model.config_mode || model.config_mode === 'standard') return 'standard';\n    if (model.config_mode === 'custom') return 'pending';\n    if (model.companion_of != null) return 'companion';\n    return 'standard';" },
  { id: 'down-count-other-rule', label: 'R-5 列表下游计数改用另一套规则（区分大小写）', expectPrefix: '列表 rel（手写期望）', file: REL,
    from: 'down: findDownstreamCandidates(r, allModels).length,',
    to: "down: allModels.filter((m) => m.id !== r.id && (m.is_deleted == null || m.is_deleted === 0) && m.dim_config != null && String(m.dim_config).includes(String(r.table_name || '\\u0000'))).length," },
  { id: 'obj-count-unfiltered', label: 'R-6 obj 计数不过滤已删对象', expectPrefix: '列表 rel（手写期望）', file: IMPL,
    from: '              WHERE ${LIVE_OBJECT_PRED} AND ${LIVE_MODEL_PRED}\n              GROUP BY l.model_id',
    to: '              WHERE ${LIVE_MODEL_PRED}\n              GROUP BY l.model_id' },
  { id: 'relations-deleted-model-objects', label: 'R-7 /relations 的对象明细不过滤已删模型', expectPrefix: '已删模型的 /relations', file: IMPL,
    from: 'WHERE l.model_id = ? AND ${LIVE_OBJECT_PRED} AND ${LIVE_MODEL_PRED}', to: 'WHERE l.model_id = ? AND ${LIVE_OBJECT_PRED}' },
  { id: 'relations-deleted-object', label: 'R-8 /relations 的对象明细不过滤已删对象', expectPrefix: 'objectState（HTTP）：sOnlyDelObj', file: IMPL,
    from: 'WHERE l.model_id = ? AND ${LIVE_OBJECT_PRED} AND ${LIVE_MODEL_PRED}', to: 'WHERE l.model_id = ? AND ${LIVE_MODEL_PRED}' },
  { id: 'down-includes-deleted', label: 'R-9 下游匹配不再排除已删模型', expectPrefix: 'GET /downstream：', file: REL,
    from: '        if (m.is_deleted != null && m.is_deleted !== 0) continue;\n', to: '' },
  { id: 'down-includes-self', label: 'R-10 下游匹配不再排除自身', expectPrefix: 'GET /downstream：', file: REL,
    from: '        if (m.id === selfId) continue;\n', to: '' },
  { id: 'down-no-escape', label: 'R-11 下游匹配把 table_name 当 LIKE 通配符（% 与 _ 不按字面量）', expectPrefix: 'GET /downstream：', file: REL,
    from: '        if (text === null || !text.includes(needle)) continue;',
    to: "        if (text === null) continue;\n        const re = new RegExp(needle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').replace(/%/g, '.*').replace(/_/g, '.'));\n        if (!re.test(text)) continue;" },
  { id: 'list-no-started-at', label: 'R-13 列表接口不再把请求起点传给 attachRelCounts', expectPrefix: '列表起点', file: ['server.js'],
    from: 'await modelRelationsModule.attachRelCounts(rows, { startedAt: listStartedAt });', to: 'await modelRelationsModule.attachRelCounts(rows, {});' },
  { id: 'list-started-at-zero', label: 'R-14 列表接口传给 attachRelCounts 的起点恒为 0', expectPrefix: '列表起点', file: ['server.js'],
    from: 'await modelRelationsModule.attachRelCounts(rows, { startedAt: listStartedAt });', to: 'await modelRelationsModule.attachRelCounts(rows, { startedAt: 0 });' },
  { id: 'list-started-at-reuse-prev', label: 'R-19 列表接口把上一次请求的起点当作本次起点（陈旧 1-5ms，跨进程容差内）', expectPrefix: '列表起点', file: ['server.js'],
    from: 'await modelRelationsModule.attachRelCounts(rows, { startedAt: listStartedAt });',
    to: 'await modelRelationsModule.attachRelCounts(rows, { startedAt: ((prev) => { globalThis.__relPrevStart = listStartedAt; return prev === undefined ? listStartedAt : prev; })(globalThis.__relPrevStart) });' },
  { id: 'down-sort-layer-only', label: 'R-15 下游排序只按 layer（去掉 table_name 次键，同层按 id）', expectPrefix: 'GET /downstream：', file: REL,
    from: 'cmpBinary(x.layer, y.layer) || cmpBinary(x.table_name, y.table_name) || (x.id - y.id)', to: 'cmpBinary(x.layer, y.layer) || (x.id - y.id)' },
  // 注：「对象明细只按 sort_no 排（去掉 o.id 次键）」是等价变异——SQLite 按 (model_id, object_id) 主键索引扫描 model_impl_links，同 sort_no 的并列行天然按对象 id 出现，任何用例都无法令其变红，故不列入。
  { id: 'objects-sort-id-only', label: 'R-17 对象明细只按 o.id 排（忽略 sort_no）', expectPrefix: 'sListed 的 /relations', file: IMPL,
    from: 'ORDER BY l.sort_no, o.id', to: 'ORDER BY o.id' },
  { id: 'list-no-try-catch', label: 'R-18 去掉列表接口里 rel 计数的 try / catch', expectPrefix: 'L4 出错路径：列表', file: ['server.js'],
    from: ['        try {', '            await modelRelationsModule.attachRelCounts(rows, { startedAt: listStartedAt });', '        } catch (relErr) {',
      "            logger.error('Failed to attach relation counts to model list:', relErr);", '            for (const r of rows) r.rel = null;', '        }'].join(String.fromCharCode(10)),
    to: '        await modelRelationsModule.attachRelCounts(rows, { startedAt: listStartedAt });' },
  { id: 'down-case-sensitive', label: 'R-12 下游匹配区分大小写', expectPrefix: 'GET /downstream：', file: REL,
    from: '        v = m.dim_config == null ? null : asciiLower(String(m.dim_config));', to: '        v = m.dim_config == null ? null : String(m.dim_config);' },
];
const mutArg = process.argv.find((x) => x.startsWith('--mutation='));
const MUTATION = mutArg ? MUTATIONS.find((m) => m.id === mutArg.slice('--mutation='.length)) : null;
if (mutArg && !MUTATION) { console.log('FAIL 未知变异：' + mutArg); process.exit(1); }
const DUMP = process.argv.includes('--dump-downstream');

function selfTest() {
  let pass = 0, fail = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [__filename, '--mutation=' + m.id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.signal) { fail++; console.log('FAIL 变异 ' + m.label + '：超时或被杀（' + ((r.error && r.error.code) || r.signal) + '），不计为判红'); continue; }
    const out = (r.stdout || '') + (r.stderr || '');
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL '));
    if (r.status !== 0 && fails.length > 0 && fails[0].startsWith('FAIL ' + m.expectPrefix)) { pass++; console.log('  变异 ' + m.label + ' → 判红（' + fails.length + ' 条失败；首条因果断言：' + fails[0].slice(0, 200) + '）'); }
    else { fail++; console.log('FAIL 变异 ' + m.label + '：' + (r.status === 0 ? '没有任何断言变红' : '变红了但首条失败不是预期的「' + m.expectPrefix + '」类断言：' + (fails[0] || out.slice(-300)).slice(0, 200))); }
  }
  console.log('verify-model-relations --self-test PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
}

// ───────────────────────────── 夹具（全部手写）─────────────────────────────
const cfgJson = (o) => JSON.stringify(o);
// 下游夹具：目标模型 + 候选 / 非候选。同一 layer（DWD）内的三个候选按「期望顺序的逆序」插入（id 顺序与期望的 table_name 顺序相反），
//   这样次键 table_name 才有判别力：只按 layer 排（或靠 id 次序）会得到 c7、c2、c5，而期望是 c5、c2、c7。table_comment 一律 'cmt_<table_name>'，除特别注明。
const DOWN_FIX = [
  // 目标 T：'dwd_order'
  { key: 'T', table_name: 'dwd_order', layer: 'DWD', status: 'ONLINE', dim_config: cfgJson({ version: 1, sourceTables: [{ name: 'ods_t_a', alias: 'a', isPrimary: true }], note: 'self mention dwd_order' }) },
  // 命中
  { key: 'c1', table_name: 'dim_cust_a', layer: 'DIM', status: 'DEVELOPING', config_mode: 'custom', dim_config: cfgJson({ sourceTables: [{ name: 'dwd_order' }] }) },
  { key: 'c7', table_name: 'dwd_nulldel', layer: 'DWD', status: 'ONLINE', is_deleted: null, dim_config: cfgJson({ sourceTables: [{ name: 'dwd_order' }] }) },
  { key: 'c2', table_name: 'dwd_big', layer: 'DWD', status: 'ONLINE', dim_config: cfgJson({ sourceTables: [{ name: 'DWD_ORDER' }] }) },
  { key: 'c5', table_name: 'Dwd_Case', layer: 'DWD', status: 'ONLINE', dim_config: cfgJson({ sourceTables: [{ name: 'dwd_order' }] }) },
  { key: 'c3', table_name: 'dwd_arch', layer: 'dwd', status: 'OFFLINE', dim_config: cfgJson({ sourceTables: [{ name: 'dwd_order_detail' }] }) },
  { key: 'c4', table_name: 'ods_note', layer: 'ods', status: 'ONLINE', dim_config: JSON.stringify(cfgJson({ sourceTables: [{ name: 'dwd_order' }] })) },   // 双重 JSON 编码
  // 不命中
  { key: 'n1', table_name: 'dwd_null_cfg', layer: 'DWD', status: 'ONLINE', dim_config: null },
  { key: 'n2', table_name: 'dwd_wild', layer: 'DWD', status: 'ONLINE', dim_config: cfgJson({ sourceTables: [{ name: 'dwdXorder' }] }) },     // _ 不是通配符
  { key: 'n3', table_name: 'dwd_deleted', layer: 'DWD', status: 'ONLINE', is_deleted: 1, dim_config: cfgJson({ sourceTables: [{ name: 'dwd_order' }] }) },
  // 含 LIKE 元字符与反斜杠的目标 T2：table_name = p%q_r\s
  { key: 'T2', table_name: 'p%q_r\\s', layer: 'DWD', status: 'ONLINE', dim_config: null },
  { key: 'e1', table_name: 'esc_hit1', layer: 'DWD', status: 'ONLINE', dim_config: 'x p%q_r\\s y' },
  { key: 'e2', table_name: 'esc_hit2', layer: 'DIM', status: 'ONLINE', dim_config: 'P%Q_R\\S' },
  { key: 'e3', table_name: 'esc_miss1', layer: 'DWD', status: 'ONLINE', dim_config: 'pXq_r\\s' },
  { key: 'e4', table_name: 'esc_miss2', layer: 'DWD', status: 'ONLINE', dim_config: 'p%qXr\\s' },
  { key: 'e5', table_name: 'esc_miss3', layer: 'DWD', status: 'ONLINE', dim_config: 'p%q_rXs' },
  // 空表名 T3
  { key: 'T3', table_name: '', layer: 'DWD', status: 'ONLINE', dim_config: null },
];
// /downstream 的改前输出（改前代码——server.js 内联 SQL——在上面夹具上的实测结果，逐行核对过排序规则：layer 二进制序 DIM < DWD < dwd < ods，同层按 table_name 二进制序，大写在小写前）。
const DOWN_EXPECT = {
  T: ['c1', 'c5', 'c2', 'c7', 'c3', 'c4'],
  T2: ['e2', 'e1'],
  T3: [],
};

// 上游夹具（也用于两端一致性对拍）：model = 抽屉所需字段 + 期望上游
const UP_FIX = [
  { key: 'u1', layer: 'DWD', dim_config: { sourceTables: [{ name: 'ods_a', alias: 'a', isPrimary: true }, { name: 'ods_b', alias: 'b', joinType: 'LEFT', joinCondition: 'a.id = b.id' }] },
    expect: [{ name: 'ods_a', alias: 'a', isPrimary: true, joinType: null, joinCondition: null }, { name: 'ods_b', alias: 'b', isPrimary: false, joinType: 'LEFT', joinCondition: 'a.id = b.id' }] },
  { key: 'u2', layer: 'DIM', dim_config: { sourceTables: [{ name: '  ods_c  ', alias: ' c ', joinType: '' }] },
    expect: [{ name: 'ods_c', alias: 'c', isPrimary: false, joinType: null, joinCondition: null }] },
  { key: 'u3', layer: 'dwd', dim_config: { sourceTables: [{ tableName: 'only_old_key' }, { name: 'ods_d', isPrimary: 1 }] },
    expect: [{ name: '', alias: '', isPrimary: false, joinType: null, joinCondition: null }, { name: 'ods_d', alias: '', isPrimary: true, joinType: null, joinCondition: null }] },
  { key: 'u4', layer: 'DWD', dim_config: { sourceTables: 'not-an-array' }, expect: [] },
  { key: 'u5', layer: 'DWD', dim_config: { other: 1 }, expect: [] },
  { key: 'u6', layer: 'DWD', config_mode: 'custom', dim_config: { sourceTables: [{ name: 'ods_custom' }] }, expect: [] },
  { key: 'u7', layer: 'DWD', companion_of: 12345, dim_config: { sourceTables: [{ name: 'ods_comp' }] }, expect: [] },
  { key: 'u8', layer: 'ADS', dim_config: { sourceTables: [{ name: 'ods_ads' }] }, expect: [] },
  { key: 'u9', layer: 'DWD', dim_config: null, expect: [] },
];

async function main() {
  if (!process.env.JWT_SECRET || !process.env.DB_ENCRYPTION_KEY) { console.log('FAIL 缺少 JWT_SECRET / DB_ENCRYPTION_KEY（读自 wbs-server/.env）'); process.exit(1); }
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`); } };
  const J = (v) => JSON.stringify(v);

  const runDir = H.makeRunDir('rel');
  const { copyRoot } = H.copyCode(H.ROOT, path.join(runDir, 'svc'), 'after', { withPublic: true });
  // 观察钩子（只改临时目录里的副本，不改被测逻辑）：包一层 attachRelCounts，把每次调用收到的 startedAt 与调用时刻追加写入观察文件，供「列表起点」用例核对
  const obsFile = path.join(runDir, 'attach-calls.jsonl');
  const failFlag = path.join(runDir, 'inject-fail.flag');   // 该文件存在时，副本里 countObjectsByModel / listModelObjects 一律抛错（L4 出错路径用例）
  H.replaceExactlyOnce(path.join(copyRoot, 'server.js'), 'const modelRelationsModule = createModelRelations({ db, logger, authenticateToken, implObjects: implObjectsModule });',
    ['const modelRelationsModule = createModelRelations({ db, logger, authenticateToken, implObjects: implObjectsModule });',
      'const __origAttach = modelRelationsModule.attachRelCounts;',
      "const __failFlag = " + JSON.stringify(failFlag) + ";",
      "for (const __fn of ['countObjectsByModel', 'listModelObjects']) { const __o = implObjectsModule[__fn]; implObjectsModule[__fn] = (...a) => (require('fs').existsSync(__failFlag) ? Promise.reject(new Error('injected ' + __fn)) : __o(...a)); }",
      "modelRelationsModule.attachRelCounts = async (rows, opts) => { require('fs').appendFileSync(" + JSON.stringify(obsFile) + ", JSON.stringify({ startedAt: opts ? opts.startedAt : null, calledAt: Date.now() }) + String.fromCharCode(10)); return __origAttach(rows, opts); };"].join('\n'), '观察钩子');
  if (MUTATION) H.replaceExactlyOnce(path.join(copyRoot, ...MUTATION.file), MUTATION.from, MUTATION.to, MUTATION.label);
  process.env.NODE_PATH = path.join(H.ROOT, 'node_modules');
  require('node:module')._initPaths();
  const createModelRelations = require(path.join(copyRoot, ...REL));

  if (!DUMP) {
    // ═════════ 一、上游两端一致性对拍 ═════════
    {
      const src = fs.readFileSync(path.join(copyRoot, 'public', 'assets', 'js', 'model-detail-normalize.js'), 'utf8');
      const win = {};
      vm.runInNewContext(src, { window: win });   // 浏览器方式：window 全局存在、无 module
      const browserKit = win.ModelDetailKit;
      check('两端一致性：vm 里按浏览器方式加载得到 ModelDetailKit', !!browserKit && typeof browserKit.normalizeModelDetail === 'function');
      for (const f of UP_FIX) {
        const model = { layer: f.layer, config_mode: f.config_mode, companion_of: f.companion_of, dim_config: f.dim_config === null ? null : JSON.stringify(f.dim_config) };
        const server = createModelRelations.upstreamOfModel(model);
        const browser = browserKit.normalizeModelDetail({ layer: f.layer, config_mode: f.config_mode, companion_of: f.companion_of, dim_config: f.dim_config }).sources;
        check(`两端一致性：${f.key}（${f.layer}）服务端 require 的结果 = 浏览器方式加载的结果`, J(server) === J(browser), `server=${J(server)} browser=${J(browser)}`);
        check(`上游（手写期望）：${f.key}（${f.layer}）`, J(server) === J(f.expect), `got=${J(server)} want=${J(f.expect)}`);
      }
      // dim_config 的存储形态：双重 JSON 编码与不可解析文本
      const dbl = createModelRelations.upstreamOfModel({ layer: 'DWD', dim_config: JSON.stringify(JSON.stringify({ sourceTables: [{ name: 'ods_dbl' }] })) });
      check('上游：双重 JSON 编码的 dim_config 可解析', J(dbl) === J([{ name: 'ods_dbl', alias: '', isPrimary: false, joinType: null, joinCondition: null }]), J(dbl));
      check('上游：不可解析的 dim_config ⇒ 空', J(createModelRelations.upstreamOfModel({ layer: 'DWD', dim_config: 'not json {' })) === '[]');
      // ODS：source_system · source_table
      const o1 = createModelRelations.upstreamOfModel({ layer: 'ods', source_system: ' ERP ', source_table: 'T_ORDER' });
      check('上游（ODS）：source_system · source_table（去首尾空白）', J(o1) === J([{ source_system: 'ERP', source_table: 'T_ORDER' }]), J(o1));
      check('上游（ODS）：只有源系统也算一条', J(createModelRelations.upstreamOfModel({ layer: 'ODS', source_system: 'ERP', source_table: '' })) === J([{ source_system: 'ERP', source_table: null }]));
      check('上游（ODS）：两者都空 ⇒ 空', J(createModelRelations.upstreamOfModel({ layer: 'ODS', source_system: '', source_table: null })) === '[]');
      check('上游（ODS）：忽略 dim_config', J(createModelRelations.upstreamOfModel({ layer: 'ODS', dim_config: JSON.stringify({ sourceTables: [{ name: 'x' }] }) })) === '[]');
    }

    // ═════════ 二、300ms 日志（假时钟，不睡眠；用记录器断言「恰好几条」）═════════
    {
      const runCase = async (elapsed) => {
        const logs = { warn: [], error: [], info: [] };
        const logger = { warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)), info: (m) => logs.info.push(String(m)) };
        const dbStub = { all: (sql, params, cb) => cb(null, [{ id: 1, table_name: 'a', table_comment: '', layer: 'DWD', status: 'ONLINE', config_mode: 'standard', dim_config: null, is_deleted: 0 }]), get: (s, p, cb) => cb(null, null) };
        const impl = { countObjectsByModel: async () => new Map([[1, 2]]), listModelObjects: async () => [] };
        const mod = createModelRelations({ db: dbStub, logger, authenticateToken: (q, r, n) => n(), implObjects: impl, now: () => 5000 + elapsed });
        const rows = [{ id: 1, table_name: 'a', layer: 'DWD', config_mode: 'standard', dim_config: null }];
        await mod.attachRelCounts(rows, { startedAt: 5000 });
        return { logs, rows };
      };
      const r301 = await runCase(301);
      check('300ms 日志：耗时 301ms ⇒ 恰好 1 条 warn，写明耗时与行数', r301.logs.warn.length === 1 && /301ms/.test(r301.logs.warn[0]) && /1 行/.test(r301.logs.warn[0]), J(r301.logs));
      const r300 = await runCase(300);
      check('300ms 日志：耗时恰好 300ms（不超过）⇒ 0 条 warn', r300.logs.warn.length === 0, J(r300.logs));
      const r0 = await runCase(0);
      check('300ms 日志：耗时 0ms ⇒ 0 条 warn，且 rel 照常附加', r0.logs.warn.length === 0 && J(r0.rows[0].rel) === J({ obj: 2, up: 0, down: 0 }), J(r0));
    }

    // ═════════ 三、objectState 判定（按方案 §4.5 原句的顺序取第一个成立的；含多条件同时成立的组合）═════════
    {
      const S = createModelRelations.decideObjectState;
      const t = (name, model, count, want) => check(`objectState 判定：${name} ⇒ ${want}`, S(model, count) === want, `got=${S(model, count)}`);
      t('标准配置且有对象', { config_mode: 'standard', companion_of: null }, 2, 'listed');
      t('custom 且有对象', { config_mode: 'custom', companion_of: null }, 1, 'listed');
      t('伴生表且有对象（历史残留关系）', { config_mode: 'companion', companion_of: 5 }, 1, 'listed');
      t('伴生表且配置方式为 standard', { config_mode: 'standard', companion_of: 5 }, 0, 'companion');
      t('伴生表且配置方式为 custom', { config_mode: 'custom', companion_of: 5 }, 0, 'companion');
      t('伴生表且配置方式为 companion', { config_mode: 'companion', companion_of: 5 }, 0, 'companion');
      t('标准配置无对象', { config_mode: 'standard', companion_of: null }, 0, 'standard');
      t('配置方式为空（平台视同 standard）', { config_mode: null, companion_of: null }, 0, 'standard');
      t('custom 且无对象（未接入登记）', { config_mode: 'custom', companion_of: null }, 0, 'pending');
      t('未知配置方式兜底', { config_mode: 'config', companion_of: null }, 0, 'standard');
    }
  }

  // ═════════ 四、HTTP ═════════
  const dbPath = path.join(runDir, 'fixture.db');
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const svc = H.makeService({ copyRoot, dbPath, tag: 'svc', gate });
  const api = H.makeApi(() => svc.baseUrl);
  let rd = null;
  try {
    await H.createFreshDb(svc);
    const w = await H.openWriter(dbPath, gate);
    const fx = H.makeFixtures(w);
    const ids = {};    // 模型键 → id
    const oids = {};   // 对象键 → id（两张表的 id 序列相互独立，必须分开存）
    let admin, viewer;
    const mk = async (key, f) => { ids[key] = await fx.model({ table_comment: 'cmt_' + f.table_name, ...f }); return ids[key]; };
    const nowSql = "datetime('now','localtime')";
    const mkObj = async (key, o) => {
      const r = await w.run(`INSERT INTO model_impl_objects (obj_type, schema_name, obj_name, summary, reg_hash, hash_algo, is_deleted, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ${nowSql}, ${nowSql}, 'fx', 'fx')`, [o.type, o.schema || null, o.name, o.summary || null, o.reg_hash || null, o.reg_hash ? 'norm_v1' : null, o.deleted ? 1 : 0]);
      oids[key] = r.lastID; return r.lastID;
    };
    const link = (mkey, okey, role, sort) => w.run(`INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?, ?, ?, ?, ${nowSql}, 'fx')`,
      [typeof mkey === 'number' ? mkey : ids[mkey], typeof okey === 'number' ? okey : oids[okey], role, sort || 0]);
    try {
      await w.get('PRAGMA journal_mode = WAL');
      admin = await fx.user('rl_admin', 'admin');
      viewer = await fx.user('rl_viewer', 'viewer');
      for (const f of DOWN_FIX) { const { key, ...rest } = f; await mk(key, rest); }
      if (!DUMP) {
        for (const f of UP_FIX) {
          const { key, expect, ...rest } = f;
          await mk('up_' + key, { table_name: 'rl_up_' + key, layer: f.layer, config_mode: f.config_mode || 'standard', dim_config: f.dim_config === null ? null : JSON.stringify(f.dim_config), companion_of: f.companion_of || null });
        }
        await mk('upOds', { table_name: 'rl_up_ods', layer: 'ods', source_system: 'ERP', source_table: 'T_ORDER' });
        await mk('upOdsEmpty', { table_name: 'rl_up_ods_empty', layer: 'ODS', source_system: null, source_table: null });
        // objectState 夹具（layer DWD、dim_config 空；名字不会出现在任何 dim_config 里）
        await mk('parent', { table_name: 'st_parent', layer: 'DWD', config_mode: 'standard' });
        await mk('sListed', { table_name: 'st_listed', layer: 'DWD', config_mode: 'standard' });
        await mk('sListed2', { table_name: 'st_listed2', layer: 'DWD', config_mode: 'standard' });
        await mk('sStd', { table_name: 'st_std', layer: 'DWD', config_mode: 'standard' });
        await mk('sStdNull', { table_name: 'st_std_null', layer: 'DWD', config_mode: null });
        await mk('sCustomNone', { table_name: 'st_custom_none', layer: 'DWD', config_mode: 'custom' });
        await mk('sCustomListed', { table_name: 'st_custom_listed', layer: 'DWD', config_mode: 'custom' });
        await mk('sComp', { table_name: 'st_comp', layer: 'DWD', config_mode: 'companion', companion_of: ids.parent });
        await mk('sCompStd', { table_name: 'st_comp_std', layer: 'DWD', config_mode: 'standard', companion_of: ids.parent });
        await mk('sCompCustom', { table_name: 'st_comp_custom', layer: 'DWD', config_mode: 'custom', companion_of: ids.parent });
        await mk('sCompListed', { table_name: 'st_comp_listed', layer: 'DWD', config_mode: 'companion', companion_of: ids.parent });
        await mk('sConfig', { table_name: 'st_config', layer: 'DWD', config_mode: 'config' });
        await mk('sOnlyDelObj', { table_name: 'st_only_del_obj', layer: 'DWD', config_mode: 'standard' });
        await mk('sDel', { table_name: 'st_deleted', layer: 'DWD', config_mode: 'standard', is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });
        // 对象与关系
        await mkObj('oA', { type: 'PROC', schema: 'dbo', name: 'usp_rel_a', summary: '对象 A', reg_hash: 'h-a' });
        await mkObj('oB', { type: 'FDL_TASK', name: '日清任务', summary: '对象 B' });
        await mkObj('oX', { type: 'TABLE', schema: 'dbo', name: 'tgt_tbl', summary: '对象 X' });
        await mkObj('oDel', { type: 'FDL_TASK', name: '已删对象 D', deleted: true });
        await mkObj('oC', { type: 'FDL_TASK', name: '对象 C' });
        await mkObj('oD', { type: 'FDL_TASK', name: '对象 D2' });
        await mkObj('oE', { type: 'FDL_TASK', name: '对象 E' });
        await link('sListed', 'oA', 'A/B 切换发布', 2);
        await link('sListed', 'oX', '目标表', 1);      // 与 oB 同 sort_no，且比 oB 先插入：只有按 o.id 的次键才能得到 oB、oX
        await link('sListed', 'oB', '日清任务', 1);
        await link('sListed', 'oDel', '已删对象的关系', 0);
        await link('sListed', 99999999, '指向物理不存在的对象', 0);
        await link('sListed2', 'oB', '共享对象的另一职责', 0);
        await link('sCustomListed', 'oC', 'custom 的对象', 0);
        await link('sCompListed', 'oD', '伴生表历史残留', 0);
        await link('sOnlyDelObj', 'oDel', '只剩已删对象', 0);
        await link('sDel', 'oE', '已删模型的关系', 0);
      }
      await w.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await w.close(); }
    await svc.start();
    rd = await H.openReader(dbPath);
    const tok = admin.token;
    const GET = (p, token) => api('GET', p, { token: token === undefined ? tok : token });

    // 把 /downstream 的候选换成 fixture 键，便于对照手写期望
    const idToKey = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const objToKey = Object.fromEntries(Object.entries(oids).map(([k, v]) => [v, k]));
    const rowOf = (key) => { const f = DOWN_FIX.find((x) => x.key === key); return { id: ids[key], table_name: f.table_name, table_comment: 'cmt_' + f.table_name, layer: f.layer, status: f.status, config_mode: f.config_mode || 'standard' }; };

    if (DUMP) {
      for (const k of ['T', 'T2', 'T3']) {
        const r = await GET(`/api/models/${ids[k]}/downstream`);
        console.log(`DOWNSTREAM ${k} status=${r.status} table_name=${J(r.json && r.json.table_name)} candidates=${J(((r.json && r.json.candidates) || []).map((c) => idToKey[c.id]))}`);
        console.log(`  raw=${r.text}`);
      }
      const nf = await GET('/api/models/99999999/downstream');
      console.log(`DOWNSTREAM 404 status=${nf.status} body=${nf.text}`);
      return;
    }

    // ── 权限 ──
    {
      const noTok = await api('GET', `/api/models/${ids.T}/relations`);
      check('权限：未登录访问 /relations ⇒ 401', noTok.status === 401, `${noTok.status} ${noTok.text}`);
      const vw = await GET(`/api/models/${ids.T}/relations`, viewer.token);
      check('权限：只读角色登录后可访问 /relations ⇒ 200', vw.status === 200, `${vw.status} ${vw.text.slice(0, 120)}`);
      const nf = await GET('/api/models/99999999/relations');
      check('/relations：模型不存在 ⇒ 404', nf.status === 404 && nf.json && nf.json.error === '模型不存在', `${nf.status} ${nf.text}`);
      const bad = await GET('/api/models/abc/relations');
      check('/relations：非数字 id ⇒ 404（同模型详情端点）', bad.status === 404, `${bad.status} ${bad.text}`);
    }

    // ── /downstream 改前改后逐项相等 ──
    for (const k of ['T', 'T2', 'T3']) {
      const f = DOWN_FIX.find((x) => x.key === k);
      const r = await GET(`/api/models/${ids[k]}/downstream`);
      const want = { table_name: f.table_name, candidates: DOWN_EXPECT[k].map(rowOf) };
      check(`GET /downstream：${k}（${J(f.table_name)}）响应与改前逐项相等（含排序、字段、字段类型）`, r.status === 200 && r.text === J(want), `got=${r.text}\n  want=${J(want)}`);
    }
    {
      const nf = await GET('/api/models/99999999/downstream');
      check('GET /downstream：模型不存在 ⇒ 404 + 原错误体', nf.status === 404 && nf.text === J({ error: '模型不存在' }), `${nf.status} ${nf.text}`);
      const noTok = await api('GET', `/api/models/${ids.T}/downstream`);
      check('GET /downstream：未登录 ⇒ 401', noTok.status === 401);
      // /relations 的 downstream 与 /downstream 的 candidates 逐项相等（同源）
      for (const k of ['T', 'T2', 'T3']) {
        const a = await GET(`/api/models/${ids[k]}/downstream`);
        const b = await GET(`/api/models/${ids[k]}/relations`);
        check(`/relations.downstream = /downstream.candidates：${k}`, b.status === 200 && J(b.json.downstream) === J(a.json.candidates), `rel=${J(b.json && b.json.downstream)}\n  down=${J(a.json && a.json.candidates)}`);
      }
    }

    // ── /relations：上游与下游明细 ──
    {
      const rT = await GET(`/api/models/${ids.T}/relations`);
      check('/relations（T）：upstream 为其 sourceTables、downstream 6 条', rT.status === 200
        && J(rT.json.upstream) === J([{ name: 'ods_t_a', alias: 'a', isPrimary: true, joinType: null, joinCondition: null }])
        && J(rT.json.downstream.map((c) => idToKey[c.id])) === J(DOWN_EXPECT.T), J(rT.json));
      check('/relations：响应只含 upstream / downstream / objects / objectState 四个键', J(Object.keys(rT.json).sort()) === J(['downstream', 'objectState', 'objects', 'upstream']), J(Object.keys(rT.json)));
      for (const f of UP_FIX) {
        const r = await GET(`/api/models/${ids['up_' + f.key]}/relations`);
        check(`/relations 上游（手写期望）：${f.key}（${f.layer}）`, r.status === 200 && J(r.json.upstream) === J(f.expect), `got=${J(r.json && r.json.upstream)}`);
      }
      const ro = await GET(`/api/models/${ids.upOds}/relations`);
      check('/relations 上游：ODS 取 source_system · source_table', J(ro.json.upstream) === J([{ source_system: 'ERP', source_table: 'T_ORDER' }]), J(ro.json));
      const roe = await GET(`/api/models/${ids.upOdsEmpty}/relations`);
      check('/relations 上游：ODS 两者皆空 ⇒ 空', J(roe.json.upstream) === '[]', J(roe.json));
    }

    // ── objectState 四值与边界 ──
    {
      const states = [
        ['sListed', 'listed', '标准配置且有对象'], ['sListed2', 'listed', '共享对象'], ['sCustomListed', 'listed', 'custom 且有对象'],
        ['sCompListed', 'listed', '伴生表带历史残留关系（方案原句顺序：有对象先判）'],
        ['sComp', 'companion', '伴生表（config_mode=companion）'], ['sCompStd', 'companion', '伴生表且 config_mode=standard'], ['sCompCustom', 'companion', '伴生表且 config_mode=custom'],
        ['sStd', 'standard', '标准配置无对象'], ['sStdNull', 'standard', 'config_mode 为空'], ['sConfig', 'standard', '未知 config_mode 兜底'],
        ['sOnlyDelObj', 'standard', '唯一的关系指向已删对象 ⇒ 视为无对象'],
        ['sCustomNone', 'pending', 'custom 且无对象'],
      ];
      for (const [key, want, what] of states) {
        const r = await GET(`/api/models/${ids[key]}/relations`);
        check(`objectState（HTTP）：${key}（${what}）⇒ ${want}`, r.status === 200 && r.json.objectState === want, `${r.status} ${r.text.slice(0, 200)}`);
      }
    }

    // ── /relations 的对象明细：过滤、排序、字段 ──
    {
      const r = await GET(`/api/models/${ids.sListed}/relations`);
      const objs = (r.json && r.json.objects) || [];
      const brief = objs.map((o) => ({ k: objToKey[o.id], type: o.obj_type, name: o.obj_name, role: o.role, sort: o.sort_no, badges: o.badges }));
      const want = [
        { k: 'oB', type: 'FDL_TASK', name: '日清任务', role: '日清任务', sort: 1, badges: { doc: null, reg: null } },
        { k: 'oX', type: 'TABLE', name: 'tgt_tbl', role: '目标表', sort: 1, badges: { doc: null, reg: null } },
        { k: 'oA', type: 'PROC', name: 'usp_rel_a', role: 'A/B 切换发布', sort: 2, badges: { doc: 'unverified', reg: 'unverified' } },
      ];
      check('sListed 的 /relations：对象明细 = 3 条有效对象（已删对象、指向不存在对象的关系不显示），按 sort_no 再按对象 id 排序，带职责与 badges', r.status === 200 && J(brief) === J(want), J(brief));
      const keys = objs[0] ? Object.keys(objs[0]).sort() : [];
      const wantKeys = ['badges', 'created_at', 'created_by', 'db_connection_id', 'doc_hash', 'doc_path', 'doc_reported_at', 'has_reg_source', 'hash_algo', 'id', 'last_attempt_at', 'last_error', 'obj_name', 'obj_type', 'prod_hash', 'prod_missing', 'reg_hash', 'role', 'schema_name', 'sort_no', 'summary', 'updated_at', 'updated_by', 'verified_at'];
      check('sListed 的 /relations：对象字段集合固定（不含 reg_source 登记源码）', J(keys) === J(wantKeys), J(keys));
      const r2 = await GET(`/api/models/${ids.sListed2}/relations`);
      check('共享对象：另一模型的 /relations 里职责是它自己的', r2.json.objects.length === 1 && r2.json.objects[0].role === '共享对象的另一职责' && r2.json.objects[0].id === oids.oB, J(r2.json.objects.map((o) => [o.id, o.role])));
      const rd1 = await GET(`/api/models/${ids.sDel}/relations`);
      check('已删模型的 /relations：照常 200（同模型详情端点），其关系按「模型已删」被过滤 ⇒ objects 为空', rd1.status === 200 && J(rd1.json.objects) === '[]' && rd1.json.objectState === 'standard', `${rd1.status} ${rd1.text.slice(0, 200)}`);
      const rod = await GET(`/api/models/${ids.sOnlyDelObj}/relations`);
      check('只剩已删对象的模型：/relations objects 为空', rod.status === 200 && J(rod.json.objects) === '[]', J(rod.json.objects));
    }

    // ── 列表 rel 三计数 ──
    {
      const list = await GET('/api/models');
      check('列表：200 且每行都有 rel { obj, up, down }', list.status === 200 && Array.isArray(list.json) && list.json.length > 0
        && list.json.every((r) => r.rel && Object.keys(r.rel).sort().join() === 'down,obj,up' && ['obj', 'up', 'down'].every((k) => Number.isInteger(r.rel[k]) && r.rel[k] >= 0)), list.text.slice(0, 200));
      {
        const readObs = () => (fs.existsSync(obsFile) ? fs.readFileSync(obsFile, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)) : []);
        const obsBefore = readObs();
        const before = obsBefore.length;
        const prevCall = obsBefore[before - 1];   // 29T H2：上一条调用记录 = 上面第一次列表请求的那条（同一服务进程时钟）
        const tReq = Date.now();
        const again = await GET('/api/models');
        const tResp = Date.now();
        const calls = readObs().slice(before);
        const c = calls[0];
        // tReq / tResp 取自测试进程，startedAt / calledAt 取自服务进程：跨进程毫秒时钟可差 1ms（段 3 实测偶发红），
        // 跨进程两处比较留 SKEW 容差；服务进程内部的 startedAt ≤ calledAt 仍严格。陈旧起点会早于请求远超 SKEW，判别力不变
        const SKEW = 5;
        check('列表起点：一次列表请求恰好调用 attachRelCounts 一次，收到的 startedAt 是处理起点（请求发出时刻 ≤ startedAt ≤ 调用时刻 ≤ 响应时刻，跨进程比较容差 5ms）',
          again.status === 200 && calls.length === 1 && Number.isFinite(c.startedAt) && tReq - SKEW <= c.startedAt && c.startedAt <= c.calledAt && c.calledAt <= tResp + SKEW, J({ calls, tReq, tResp }));
        // 29T H2：服务进程内部的严格比较（同一时钟、无容差）。本次起点必须严格晚于上一次请求的调用时刻，
        // 否则起点是复用上一次请求的值（1-5ms 的陈旧值能穿过上面的跨进程容差）。上一条记录不存在 ⇒ 判红
        check('列表起点（服务进程时钟）：本次 startedAt 严格大于上一条调用记录（第一次列表请求）的 calledAt',
          !!prevCall && Number.isFinite(prevCall.calledAt) && calls.length === 1 && c.startedAt > prevCall.calledAt, J({ prevCall, calls }));
      }
      const byKey = (key) => (list.json || []).find((r) => r.id === ids[key]);
      const wantRel = {
        T: { obj: 0, up: 1, down: 6 }, T2: { obj: 0, up: 0, down: 2 }, T3: { obj: 0, up: 0, down: 0 },
        c1: { obj: 0, up: 0, down: 0 }, c3: { obj: 0, up: 1, down: 0 },
        sListed: { obj: 3, up: 0, down: 0 }, sListed2: { obj: 1, up: 0, down: 0 }, sCustomListed: { obj: 1, up: 0, down: 0 }, sCompListed: { obj: 1, up: 0, down: 0 },
        sStd: { obj: 0, up: 0, down: 0 }, sOnlyDelObj: { obj: 0, up: 0, down: 0 }, sCustomNone: { obj: 0, up: 0, down: 0 },
        up_u1: { obj: 0, up: 2, down: 0 }, up_u2: { obj: 0, up: 1, down: 0 }, up_u3: { obj: 0, up: 2, down: 0 }, up_u6: { obj: 0, up: 0, down: 0 },
        upOds: { obj: 0, up: 1, down: 0 }, upOdsEmpty: { obj: 0, up: 0, down: 0 },
      };
      const got = {};
      for (const k of Object.keys(wantRel)) { const row = byKey(k); got[k] = row ? row.rel : undefined; }
      check('列表 rel（手写期望）：T / T2 / T3 / 候选 / 对象计数 / 上游计数', J(got) === J(wantRel), `got=${J(got)}\n  want=${J(wantRel)}`);
      check('列表：已删模型不在列表里（n3、sDel）', !byKey('n3') && !byKey('sDel'));
      // 与 /relations 同源：每行 up / down / obj 等于该模型 /relations 三个数组的长度
      let mismatch = [];
      for (const row of list.json) {
        const rr = await GET(`/api/models/${row.id}/relations`);
        const d = rr.status === 200 ? { up: rr.json.upstream.length, down: rr.json.downstream.length, obj: rr.json.objects.length } : { status: rr.status };
        if (J(d) !== J({ up: row.rel.up, down: row.rel.down, obj: row.rel.obj })) mismatch.push(`${row.table_name}: rel=${J(row.rel)} relations=${J(d)}`);
      }
      check(`列表 rel 与 /relations 同源：${list.json.length} 行逐行 up / down / obj 等于明细数组长度`, mismatch.length === 0, mismatch.slice(0, 5).join('\n  '));
      // 筛选后的列表：下游 / 对象计数仍按全量模型算
      const filtered = await GET('/api/models?keyword=dwd_order');
      const ft = (filtered.json || []).find((r) => r.id === ids.T);
      // L4 出错路径：关系查询抛错时，列表仍 200 且每行 rel 为 null（附加信息不拖垮列表）；/relations 返回 500 + 固定文案（不外溢内部错误）
      {
        fs.writeFileSync(failFlag, 'x');
        let lf, rf;
        try {
          const lr = await fetch(svc.baseUrl + '/api/models', { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(8000) });
          const lt = await lr.text();
          lf = { status: lr.status, text: lt };
        } catch (e) { lf = { status: 0, text: String(e && e.message) }; }
        let rows = null; try { rows = JSON.parse(lf.text); } catch (e) { /* 非 JSON */ }
        check('L4 出错路径：列表在关系计数抛错时仍返回 200，且每一行 rel 为 null', lf.status === 200 && Array.isArray(rows) && rows.length > 0 && rows.every((x) => x.rel === null), J({ status: lf.status, head: lf.text.slice(0, 200) }));
        try {
          const rr = await fetch(svc.baseUrl + '/api/models/' + ids.T + '/relations', { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(8000) });
          rf = { status: rr.status, text: await rr.text() };
        } catch (e) { rf = { status: 0, text: String(e && e.message) }; }
        check('L4 出错路径：/relations 在查询抛错时返回 500，响应体严格等于固定文案（不含内部错误信息）', rf.status === 500 && rf.text === J({ error: '关系查询失败' }), J(rf));
        fs.unlinkSync(failFlag);
      }
      check('列表带筛选（keyword）：下游计数仍对全量模型匹配（筛选结果只有目标自身一行，down 仍为 6）', filtered.status === 200 && filtered.json.length === 1 && ft && J(ft.rel) === J({ obj: 0, up: 1, down: 6 }), filtered.text.slice(0, 300));
    }
  } finally {
    if (rd) await rd.close();
    await svc.stop().catch(() => {});
    check('收尾：服务运行期间测试进程写库次数为 0', gate.writes === 0, String(gate.writes));
  }
  if (!DUMP) console.log(`verify-model-relations PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? process.exitCode || 0 : 1;
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack || e)); process.exit(1); });
