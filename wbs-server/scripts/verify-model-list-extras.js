// verify-model-list-extras.js — #77 C4-api 列表追加字段（acceptance.stages / acceptance.prevResult / impl_obj_names）
//
// 覆盖（HTTP，自起隔离实例，零本机库、零真实外发；夹具只在服务停止时写，服务运行期间测试进程只持只读连接）：
//   一、手写期望：每个夹具行的 acceptance.state / stages / prevResult / at（stale 例）与 impl_obj_names 逐值相等；
//   二、形状：acceptance 非 null 的行键集合恰为 at, prevResult, rows, stages, state；prevResult 非 null ⇔ state === 'stale'；impl_obj_names 恒为字符串数组；rel 仍在；
//   三、同源：impl_obj_names 与 rel.obj 等长，并与 GET /api/models/:id/relations 的 objects 按同一显示名规则逐项相等（含顺序）；
//       stages 与 GET /api/models/validation-status/batch 的 phases.structure / data 相等（stages 为 null 时 batch 不含这两个阶段）；
//   四、出错路径：对象名查询抛错 → 200、每行 impl_obj_names === null、acceptance 与 rel 照常；验收取数抛错 → 200、每行 acceptance === null、impl_obj_names 照常；
//   五、SQL 条数：列表请求的处理器内 SQL 恒为 5 条（不随模型数增长）：keyword 恰命中 1 行与全量 ≥ 80 行各 3 次取最小值，二者相等且 === 5，语句前缀序列与手写清单逐条相同。
//   （authenticateToken 的 1 条在计数窗口外；验收记录查询在 N > 400 时按 ⌈N/400⌉ 增长，既有设计，分块边界由 verify-model-acceptance.js 覆盖。）
//   六、详情接口（#77 C5，GET /api/models/:id 追加 acceptance，抽屉概览「最近验收」读它）：每个夹具行的详情 acceptance 键集合恰为 at, prevResult, reason, rows, stages, state（比列表多一个 reason）；
//       state / stages / prevResult / at / rows / reason 逐值等于手写期望（pass / warn / fail / partial〔缺结构、缺数据各一〕/ stale〔prevResult 为 pass 与 warn 两种，DIM 与 ODS 各有〕/ none / 非 DIM·DWD·ODS 分层的 none / companion）；
//       除 reason 外与同一模型的列表行 acceptance 逐字段相等（同口径、不带 opts.task）；验收取数抛错 → 详情仍 200、acceptance === null、其余字段照常；不存在的 id 仍 404；之后恢复。
//       修复批 L6 补两类夹具：① 验收记录的 config_rev 为 NULL（迁移前遗留，不属于任何版本，只能当「更早版本」）导致的 stale——ODS 一条 pass（prevResult = pass、at = 该记录）、DIM 结构 pass + 数据 warn（prevResult = warn、at = 数据那条，更新的一条）；
//       ② 已删除（软删）模型 lx_del_pass：列表不返回它（一·已删模型不在列表里），所以只断言详情（期望手写：DWD 结构 T1 pass + 数据 T2 pass → pass / stages pass·pass / at T2 / rows 10 / reason 空），不与列表对拍。自证 D7：把 NULL 版本的记录当成当前版本 → 一·手写期望判红。
//       codex 44Tc 补两类夹具：① 当前版本双阶段夹具里两个阶段记录的 total_rows 互不相同（dwdRows：结构 3 / 数据 17；dimRowsOld：结构更新 3 / 数据更旧 17），详情 rows 手写 = 数据阶段记录的 17（判定口径：DIM / DWD 取数据阶段决定记录的 total_rows）；
//       ② 阶段结果混合的当前版本夹具（dimPW：结构 pass / 数据 warn；dwdWP：结构 warn / 数据 pass），手写 stages 保留两个阶段各自的实际结果、总体 warn。自证 D8（rows 取结构阶段记录）/ D9（总体 warn 时两个阶段都置 warn）。
//       放在本套件的理由：这里已有每个 state 的夹具与手写期望表、自起隔离实例、对 server.js 副本做「观察钩子 + 破坏性变异」的机制；详情 acceptance 与列表 acceptance 是同一判定的两个出口，同夹具对拍最直接。
//
// 观察钩子（只改临时目录里的副本，不改被测逻辑）：包共享 db 的 all/get/each/run/exec/prepare 记 SQL 前 120 字；包 listObjectNamesByModel 与 listModelObjects（对象名的两种取法受同一旗标）、验收取数的旗标文件抛错。
// 威胁模型：只证明「诚实实现写错时会判红」；期望值全部手写；SQL 计数钩子包的是共享连接的实例方法，另开连接绕过不在威胁模型内。
// 等价变异不列：去掉 listObjectNamesByModel 里的 ${LIVE_MODEL_PRED} 只影响已删模型的关系，已删模型不在列表里，列表层不可观察（lx_obj_delmodel 的不在列表由一覆盖）。
//   另一个等价变异：去掉排序次键 l.object_id（ORDER BY l.model_id, l.sort_no）——同一模型内 (model_id, object_id) 是 model_impl_links 的主键，同 sort_no 的并列行按主键索引扫描天然按对象 id 出现，不可观察（同族先例：verify-model-relations.js 对 ORDER BY l.sort_no, o.id 的说明）。
// 不去重（C-6）：lx_obj_main 同时挂了同显示名、不同类型的 TABLE 与 VIEW（dbo.lx_tgt），期望名字出现两次且 impl_obj_names.length === rel.obj；变异 L8 钉住。
// SQL 计数钩子除包 db 的实例方法外，也包 sqlite3.Statement.prototype 的 run / get / all / each（对 prepare 返回的语句逐次执行计数；先例 verify-model-config-rev-http.js SQL_TRACE_SRC）；变异 L9（对象名改为 prepare 一次、逐行执行）钉住。
//
// 变异自证（--self-test）：对被测源码副本逐个做破坏性改动，须使本套件判红且「首条」FAIL 以 expectPrefix 开头；超时或被杀计为失败。
//   单个变异：node scripts/verify-model-list-extras.js --mutation=<id>
// 运行：node scripts/verify-model-list-extras.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./verify-model-config-rev-http.js');

const IMPL = ['routes', 'model-center', 'impl-objects.js'];
const SRV = ['server.js'];
const ACC = ['routes', 'model-center', 'acceptance.js'];
const NL = String.fromCharCode(10);
// 副本里注入的 SQL 计数钩子源码：包共享 db 的实例方法（prepare 另给返回的语句对象打标）+ sqlite3.Statement.prototype 的 run / get / all / each（预编译语句的每次执行也计一条）；
//   对象名旗标存在时 prepare 也抛错（对象名的任何取法都受同一旗标，N+1 变异才会先于「出错路径」暴露在 SQL 条数上）
const TRACE_HOOK_SRC = (nameFlag) => String.raw`const __lxNorm = (q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 120); for (const __m of ['all', 'get', 'each', 'run', 'exec', 'prepare']) { const __o = db[__m]; db[__m] = function (sql, ...a) { if (Array.isArray(globalThis.__lxTrace)) globalThis.__lxTrace.push(__lxNorm(sql)); if (__m === 'prepare') { if (require('fs').existsSync(${JSON.stringify(nameFlag)})) throw new Error('injected prepare'); const __st = __o.call(this, sql, ...a); try { __st.__lxSql = sql; } catch (e) { /* ignore */ } return __st; } return __o.call(this, sql, ...a); }; } for (const __m of ['run', 'get', 'all', 'each']) { const __S = require('sqlite3').Statement.prototype; const __o = __S[__m]; __S[__m] = function (...a) { if (Array.isArray(globalThis.__lxTrace) && this.__lxSql !== undefined) globalThis.__lxTrace.push(__lxNorm(this.__lxSql)); return __o.apply(this, arguments); }; }`;

const MUTATIONS = [
  { id: 'names-no-live-object', label: 'L1 对象名查询去掉已删对象过滤', expectPrefix: '一·', file: IMPL,
    from: '              WHERE ${LIVE_MODEL_PRED} AND ${LIVE_OBJECT_PRED}\n              ORDER BY l.model_id, l.sort_no, l.object_id',
    to: '              WHERE ${LIVE_MODEL_PRED}\n              ORDER BY l.model_id, l.sort_no, l.object_id' },
  { id: 'names-no-sort-no', label: 'L2 对象名排序去掉 sort_no', expectPrefix: '一·', file: IMPL,
    from: 'ORDER BY l.model_id, l.sort_no, l.object_id', to: 'ORDER BY l.model_id, l.object_id' },
  { id: 'names-n-plus-1', label: 'L3 对象名改成逐行调 listModelObjects（N+1）', expectPrefix: '五·', file: SRV,
    from: ['            const nameMap = await implObjectsModule.listObjectNamesByModel();', '            for (const r of rows) r.impl_obj_names = nameMap.get(Number(r.id)) || [];'].join(NL),
    to: '            for (const r of rows) { const objs = await implObjectsModule.listModelObjects(r.id); r.impl_obj_names = objs.map((o) => (o.schema_name ? o.schema_name + "." + o.obj_name : o.obj_name)); }' },
  { id: 'names-dedupe', label: 'L8 listObjectNamesByModel 返回前去重', expectPrefix: '一·', file: IMPL,
    from: '        return map;', to: '        for (const [k, v] of map) map.set(k, [...new Set(v)]);\n        return map;' },
  { id: 'names-prepare-n-plus-1', label: 'L9 对象名改用 db.prepare 预编译一次后逐行执行（N+1）', expectPrefix: '五·', file: SRV,
    from: ['            const nameMap = await implObjectsModule.listObjectNamesByModel();', '            for (const r of rows) r.impl_obj_names = nameMap.get(Number(r.id)) || [];'].join(NL),
    to: ['            const __st = db.prepare("SELECT o.schema_name AS s, o.obj_name AS n FROM model_impl_links l JOIN model_impl_objects o ON o.id = l.object_id WHERE l.model_id = ? AND o.is_deleted = 0 ORDER BY l.sort_no, l.object_id");',
      '            for (const r of rows) r.impl_obj_names = (await new Promise((resolve, reject) => __st.all(r.id, (e, rs) => (e ? reject(e) : resolve(rs))))).map((x) => (x.s ? x.s + "." + x.n : x.n));',
      '            __st.finalize();'].join(NL) },
  { id: 'names-no-schema', label: 'L4 显示名不拼 schema', expectPrefix: '一·', file: IMPL,
    from: 'r.schema_name ? `${r.schema_name}.${r.obj_name}` : r.obj_name', to: 'r.obj_name' },
  { id: 'stages-null', label: 'L5 stages 投影恒为 null', expectPrefix: '一·', file: SRV,
    from: 'r.acceptance.stages = ev.stages ? { structure: ev.stages.structure, data: ev.stages.data } : null;', to: 'r.acceptance.stages = null;' },
  { id: 'prev-ignores-state', label: 'L6 prevResult 投影不看 state', expectPrefix: '一·', file: SRV,
    from: "r.acceptance.prevResult = ev.state === 'stale' ? (ev.prevResult ?? null) : null;", to: "r.acceptance.prevResult = ev.prevResult ?? 'pass';" },
  { id: 'names-no-try-catch', label: 'L7 去掉对象名块的 try / catch', expectPrefix: '四·', file: SRV,
    from: ['        try {', '            const nameMap = await implObjectsModule.listObjectNamesByModel();', '            for (const r of rows) r.impl_obj_names = nameMap.get(Number(r.id)) || [];',
      '        } catch (nameErr) {', "            logger.error('Failed to attach implementation object names to model list:', nameErr);", '            for (const r of rows) r.impl_obj_names = null;', '        }'].join(NL),
    to: ['        const nameMap = await implObjectsModule.listObjectNamesByModel();', '        for (const r of rows) r.impl_obj_names = nameMap.get(Number(r.id)) || [];'].join(NL) },
  // —— #77 C5：详情接口 acceptance（改的是 GET /api/models/:id 处理器里的行，与上面 L5 / L6 改的列表处理器行互不重叠）
  { id: 'detail-stages-null', label: 'D1 详情 stages 投影恒为 null', expectPrefix: '六·', file: SRV,
    from: 'model.acceptance.stages = accEv.stages ? { structure: accEv.stages.structure, data: accEv.stages.data } : null;', to: 'model.acceptance.stages = null;' },
  { id: 'detail-prev-ignores-state', label: 'D2 详情 prevResult 投影不看 state', expectPrefix: '六·', file: SRV,
    from: "model.acceptance.prevResult = accEv.state === 'stale' ? (accEv.prevResult ?? null) : null;", to: "model.acceptance.prevResult = accEv.prevResult ?? 'pass';" },
  { id: 'detail-no-reason', label: 'D3 详情不带 reason（置空串）', expectPrefix: '六·', file: SRV,
    from: "model.acceptance.reason = accEv.reason || '';", to: "model.acceptance.reason = '';" },
  { id: 'detail-with-task', label: 'D4 详情判定误带 opts.task（门禁口径，与列表不同口径）', expectPrefix: '六·', file: SRV,
    from: 'const accEv = evaluateAcceptance(model, await fetchRecordsByModelId(db, model.id));', to: "const accEv = evaluateAcceptance(model, await fetchRecordsByModelId(db, model.id), { task: { created_at: '2099-01-01 00:00:00' } });" },
  { id: 'detail-no-try-catch', label: 'D5 详情去掉 acceptance 的 try / catch（取数抛错拖垮详情）', expectPrefix: '六·', file: SRV,
    from: ['        } catch (accErr) {', "            logger.error('Failed to attach acceptance to model detail:', accErr);", '            model.acceptance = null;', '        }'].join(NL),
    to: ['        } finally {', '            void 0;', '        }'].join(NL) },
  { id: 'detail-error-not-null', label: 'D6 详情取数抛错时 acceptance 不置 null（置成 none 假值）', expectPrefix: '六·', file: SRV,
    from: ["            logger.error('Failed to attach acceptance to model detail:', accErr);", '            model.acceptance = null;'].join(NL),
    to: ["            logger.error('Failed to attach acceptance to model detail:', accErr);", "            model.acceptance = { state: 'none', at: null, rows: null, stages: null, prevResult: null, reason: '尚无验收记录' };"].join(NL) },
  // —— #77 C5 修复批 L6：改的是判定服务副本（只在临时目录里改），不是处理器
  { id: 'detail-null-rev-as-current', label: 'D7 判定服务把 config_rev 为 NULL 的验收记录当成当前版本', expectPrefix: '一·', file: ACC,
    from: 'if (recRev == null || modelRev == null) return false;', to: ['if (modelRev == null) return false;', '    if (recRev == null) return true;'].join(NL) },
  // —— codex 44Tc：改的是判定服务副本 / 详情处理器的行
  { id: 'detail-rows-from-structure', label: 'D8 判定服务 rows 取结构阶段记录（详情与列表同源；详情手写期望里结构 / 数据行数不同）', expectPrefix: '六·', file: ACC,
    from: 'const rows = dataRec ? rowsOf(dataRec) : (decisive ? rowsOf(decisive) : null);', to: 'const rows = structureRec ? rowsOf(structureRec) : (decisive ? rowsOf(decisive) : null);' },
  { id: 'detail-warn-both-stages', label: 'D9 详情在总体 warn 时把两个阶段都置 warn（丢掉已通过阶段的真实结果）', expectPrefix: '六·', file: SRV,
    from: 'model.acceptance.stages = accEv.stages ? { structure: accEv.stages.structure, data: accEv.stages.data } : null;',
    to: "model.acceptance.stages = accEv.stages ? (accEv.state === 'warn' ? { structure: 'warn', data: 'warn' } : { structure: accEv.stages.structure, data: accEv.stages.data }) : null;" },
];
const mutArg = process.argv.find((x) => x.startsWith('--mutation='));
const MUTATION = mutArg ? MUTATIONS.find((m) => m.id === mutArg.slice('--mutation='.length)) : null;
if (mutArg && !MUTATION) { console.log('FAIL 未知变异：' + mutArg); process.exit(1); }

function selfTest() {
  let pass = 0, fail = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [__filename, '--mutation=' + m.id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.signal) { fail++; console.log('FAIL 变异 ' + m.label + '：超时或被杀（' + ((r.error && r.error.code) || r.signal) + '），不计为判红'); continue; }
    const out = (r.stdout || '') + (r.stderr || '');
    const fails = out.split(NL).filter((l) => l.startsWith('FAIL '));
    if (r.status !== 0 && fails.length > 0 && fails[0].startsWith('FAIL ' + m.expectPrefix)) { pass++; console.log('  变异 ' + m.label + ' → 判红（' + fails.length + ' 条失败；首条：' + fails[0].slice(0, 110) + '）'); }
    else { fail++; console.log('FAIL 变异 ' + m.label + '：' + (r.status === 0 ? '没有任何断言变红' : '变红了但首条失败不是预期的「' + m.expectPrefix + '」类断言：' + (fails[0] || out.slice(-300)).slice(0, 200))); }
  }
  console.log('verify-model-list-extras --self-test PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
}

// 显示名规则（手写，与服务端同一约定：schema 为真值 → schema.obj，否则 obj）
const dispName = (o) => (o.schema_name ? `${o.schema_name}.${o.obj_name}` : o.obj_name);
const T1 = '2026-09-30 10:00:00';
const T2 = '2026-09-30 10:05:00';
const XSS_NAME = `x'<img src=x onerror=alert(1)>&#39;"`;

async function main() {
  if (!process.env.JWT_SECRET || !process.env.DB_ENCRYPTION_KEY) { console.log('FAIL 缺少 JWT_SECRET / DB_ENCRYPTION_KEY（读自 wbs-server/.env）'); process.exit(1); }
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${detail === undefined ? '' : NL + '  ' + detail}`); } };
  const J = (v) => JSON.stringify(v);

  const runDir = H.makeRunDir('lx');
  const { copyRoot } = H.copyCode(H.ROOT, path.join(runDir, 'svc'), 'after', { withPublic: true });
  const traceFile = path.join(runDir, 'trace.jsonl');
  const nameFlag = path.join(runDir, 'inject-names-fail.flag');
  const accFlag = path.join(runDir, 'inject-acc-fail.flag');
  const srv = path.join(copyRoot, 'server.js');
  // a) 装配行之后：包共享 db 的实例方法记 SQL；包 listObjectNamesByModel（旗标文件存在即抛错）
  const ASSEMBLE = 'const modelRelationsModule = createModelRelations({ db, logger, authenticateToken, implObjects: implObjectsModule });';
  H.replaceExactlyOnce(srv, ASSEMBLE, [ASSEMBLE,
    TRACE_HOOK_SRC(nameFlag),
    "for (const __fn of ['listObjectNamesByModel', 'listModelObjects']) { const __o = implObjectsModule[__fn]; implObjectsModule[__fn] = (...a) => (require('fs').existsSync(" + J(nameFlag) + ") ? Promise.reject(new Error('injected ' + __fn)) : __o(...a)); }"].join(NL), 'lx 钩子 a');
  // b) 处理起点之后开窗
  H.replaceExactlyOnce(srv, 'const listStartedAt = Date.now();', 'const listStartedAt = Date.now(); globalThis.__lxTrace = [];', 'lx 钩子 b');
  // c) 响应之前把窗口内容写文件并关窗（只改列表处理器末尾：以 rel 的 catch 收尾为锚）
  H.replaceExactlyOnce(srv, '            for (const r of rows) r.rel = null;\n        }\n        res.json(rows);',
    '            for (const r of rows) r.rel = null;\n        }\n        require(\'fs\').appendFileSync(' + J(traceFile) + ', JSON.stringify({ stmts: globalThis.__lxTrace || [], rows: rows.length }) + String.fromCharCode(10)); globalThis.__lxTrace = null;\n        res.json(rows);', 'lx 钩子 c');
  // d) 验收取数前：旗标文件存在即抛错
  H.replaceExactlyOnce(srv, 'const recordMap = await fetchRecordsByModelIds(db, rows.map(r => r.id));\n            for (const r of rows) {\n                const ev = evaluateAcceptance(r, recordMap.get(Number(r.id)) || []);',
    'if (require(\'fs\').existsSync(' + J(accFlag) + ')) throw new Error(\'injected acc\');\n            const recordMap = await fetchRecordsByModelIds(db, rows.map(r => r.id));\n            for (const r of rows) {\n                const ev = evaluateAcceptance(r, recordMap.get(Number(r.id)) || []);', 'lx 钩子 d');
  // e) C5 详情处理器的验收取数前：旗标文件存在即抛错（与 d 同做法；锚点是详情处理器里的那一行，列表处理器里没有这一行）
  const detailAccFlag = path.join(runDir, 'inject-detail-acc-fail.flag');
  H.replaceExactlyOnce(srv, '            const accEv = evaluateAcceptance(model, await fetchRecordsByModelId(db, model.id));',
    '            if (require(\'fs\').existsSync(' + J(detailAccFlag) + ')) throw new Error(\'injected detail acc\');\n            const accEv = evaluateAcceptance(model, await fetchRecordsByModelId(db, model.id));', 'lx 钩子 e');
  if (MUTATION) H.replaceExactlyOnce(path.join(copyRoot, ...MUTATION.file), MUTATION.from, MUTATION.to, MUTATION.label);

  const dbPath = path.join(runDir, 'fixture.db');
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const svc = H.makeService({ copyRoot, dbPath, tag: 'svc', gate });
  const api = H.makeApi(() => svc.baseUrl);
  let rd = null;
  try {
    await H.createFreshDb(svc);
    const w = await H.openWriter(dbPath, gate);
    const fx = H.makeFixtures(w);
    const ids = {}, oids = {};
    let admin;
    const mk = async (key, f) => { ids[key] = await fx.model({ table_comment: 'cmt_' + f.table_name, ...f }); return ids[key]; };
    const nowSql = "datetime('now','localtime')";
    const mkObj = async (key, o) => {
      const r = await w.run(`INSERT INTO model_impl_objects (obj_type, schema_name, obj_name, summary, reg_hash, hash_algo, is_deleted, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ${nowSql}, ${nowSql}, 'fx', 'fx')`, [o.type, o.schema || null, o.name, o.summary || null, null, null, o.deleted ? 1 : 0]);
      oids[key] = r.lastID; return r.lastID;
    };
    const link = (mkey, okey, role, sort) => w.run(`INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?, ?, ?, ?, ${nowSql}, 'fx')`,
      [ids[mkey], typeof okey === 'number' ? okey : oids[okey], role, sort || 0]);
    // 期望表：key → { st: state, stages: {structure,data}|null, prev: 'pass'|'warn'|null, at?: 时间（stale 例）, names: [...] }
    const WANT = {};
    try {
      await w.get('PRAGMA journal_mode = WAL');
      admin = await fx.user('lx_admin', 'admin');
      // ── 验收夹具（config_rev 显式；record 的 rev 缺省 = 模型当前版本）──
      await mk('dimS', { table_name: 'lx_dim_partial_s', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimS, { phase: 'structure', result: 'pass', time: T1 });
      WANT.dimS = { st: 'partial', stages: { structure: 'pass', data: null }, prev: null };
      await mk('dimD', { table_name: 'lx_dim_partial_d', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimD, { phase: 'data', result: 'warn', time: T1 });
      WANT.dimD = { st: 'partial', stages: { structure: null, data: 'warn' }, prev: null };
      await mk('dwdAll', { table_name: 'lx_dwd_all_warn', layer: 'DWD', config_rev: 2 }); await fx.record(ids.dwdAll, { phase: 'all', result: 'warn', time: T1 });
      WANT.dwdAll = { st: 'warn', stages: { structure: 'warn', data: 'warn' }, prev: null };
      await mk('dwdFail', { table_name: 'lx_dwd_fail_pass', layer: 'DWD', config_rev: 2 }); await fx.record(ids.dwdFail, { phase: 'structure', result: 'fail', time: T1 }); await fx.record(ids.dwdFail, { phase: 'data', result: 'pass', time: T2 });
      WANT.dwdFail = { st: 'fail', stages: { structure: 'fail', data: 'pass' }, prev: null };
      await mk('dwdLower', { table_name: 'lx_dwd_lower_pass', layer: 'dwd', config_rev: 2 }); await fx.record(ids.dwdLower, { phase: 'structure', result: 'pass', time: T1 }); await fx.record(ids.dwdLower, { phase: 'data', result: 'pass', time: T2 });
      WANT.dwdLower = { st: 'pass', stages: { structure: 'pass', data: 'pass' }, prev: null };
      await mk('odsPass', { table_name: 'lx_ods_pass', layer: 'ODS', config_rev: 2 }); await fx.record(ids.odsPass, { phase: null, result: 'pass', time: T1 });
      WANT.odsPass = { st: 'pass', stages: null, prev: null };
      await mk('odsStaleWarn', { table_name: 'lx_ods_stale_warn', layer: 'ODS', config_rev: 2 }); await fx.record(ids.odsStaleWarn, { phase: null, result: 'warn', time: T1, rev: 1 });
      WANT.odsStaleWarn = { st: 'stale', stages: null, prev: 'warn', at: T1 };
      await mk('dimStale', { table_name: 'lx_dim_stale', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimStale, { phase: 'structure', result: 'pass', time: T1, rev: 1 }); await fx.record(ids.dimStale, { phase: 'data', result: 'warn', time: T2, rev: 1 });
      WANT.dimStale = { st: 'stale', stages: null, prev: 'warn', at: T2 };
      await mk('odsStalePass', { table_name: 'lx_ods_stale_pass', layer: 'ODS', config_rev: 2 }); await fx.record(ids.odsStalePass, { phase: null, result: 'pass', time: T1, rev: 1 }); await fx.record(ids.odsStalePass, { phase: null, result: 'fail', time: T2, rev: 1 });
      WANT.odsStalePass = { st: 'stale', stages: null, prev: 'pass', at: T1 };
      // 修复批 L6：验收记录 config_rev 为 NULL（迁移前遗留）：不属于任何版本，只能当「更早版本」→ stale（prevResult 取其中最新的通过 / 有警告记录，at 同）
      await mk('odsNullRev', { table_name: 'lx_ods_null_rev', layer: 'ODS', config_rev: 2 }); await fx.record(ids.odsNullRev, { phase: null, result: 'pass', time: T1, rev: null });
      WANT.odsNullRev = { st: 'stale', stages: null, prev: 'pass', at: T1 };
      await mk('dimNullRev', { table_name: 'lx_dim_null_rev', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimNullRev, { phase: 'structure', result: 'pass', time: T1, rev: null }); await fx.record(ids.dimNullRev, { phase: 'data', result: 'warn', time: T2, rev: null });
      WANT.dimNullRev = { st: 'stale', stages: null, prev: 'warn', at: T2 };
      // codex 44Tc M1 / M2：当前版本的双阶段夹具——两个阶段记录的 total_rows 互不相同（fx.record 固定写 10，建好后按 model_id + test_time 改），且阶段结果有混合（不是两个阶段同结果）
      const setRows = (key, time, n) => w.run('UPDATE model_test_records SET total_rows = ? WHERE model_id = ? AND test_time = ?', [n, ids[key], time]);
      await mk('dwdRows', { table_name: 'lx_dwd_rows', layer: 'DWD', config_rev: 2 }); await fx.record(ids.dwdRows, { phase: 'structure', result: 'pass', time: T1 }); await fx.record(ids.dwdRows, { phase: 'data', result: 'pass', time: T2 }); await setRows('dwdRows', T1, 3); await setRows('dwdRows', T2, 17);
      WANT.dwdRows = { st: 'pass', stages: { structure: 'pass', data: 'pass' }, prev: null };   // rows 取数据阶段记录（17），不是结构阶段（3）；at 取最新决定记录（T2）
      await mk('dimRowsOld', { table_name: 'lx_dim_rows_old', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimRowsOld, { phase: 'structure', result: 'pass', time: T2 }); await fx.record(ids.dimRowsOld, { phase: 'data', result: 'pass', time: T1 }); await setRows('dimRowsOld', T2, 3); await setRows('dimRowsOld', T1, 17);
      WANT.dimRowsOld = { st: 'pass', stages: { structure: 'pass', data: 'pass' }, prev: null };   // 结构阶段更新（T2、3 行），数据阶段更旧（T1、17 行）：at = 最新的 T2，rows 仍取数据阶段的 17（不是「最新决定记录」的 3）
      await mk('dimPW', { table_name: 'lx_dim_pass_warn', layer: 'DIM', config_rev: 2 }); await fx.record(ids.dimPW, { phase: 'structure', result: 'pass', time: T1 }); await fx.record(ids.dimPW, { phase: 'data', result: 'warn', time: T2 }); await setRows('dimPW', T1, 5); await setRows('dimPW', T2, 7);
      WANT.dimPW = { st: 'warn', stages: { structure: 'pass', data: 'warn' }, prev: null };   // 当前版本 DIM：结构 pass、数据 warn → 总体 warn，stages 保留两个阶段各自的结果
      await mk('dwdWP', { table_name: 'lx_dwd_warn_pass', layer: 'DWD', config_rev: 2 }); await fx.record(ids.dwdWP, { phase: 'structure', result: 'warn', time: T1 }); await fx.record(ids.dwdWP, { phase: 'data', result: 'pass', time: T2 }); await setRows('dwdWP', T1, 4); await setRows('dwdWP', T2, 9);
      WANT.dwdWP = { st: 'warn', stages: { structure: 'warn', data: 'pass' }, prev: null };   // 当前版本 DWD：结构 warn、数据 pass → 总体 warn，stages 保留 warn / pass
      // 修复批 L6：已删除（软删）模型——列表不返回，详情仍给 acceptance（只断言详情，期望手写，见「六」末段）
      await mk('delPass', { table_name: 'lx_del_pass', layer: 'DWD', config_rev: 2, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' }); await fx.record(ids.delPass, { phase: 'structure', result: 'pass', time: T1 }); await fx.record(ids.delPass, { phase: 'data', result: 'pass', time: T2 });
      await mk('dimNone', { table_name: 'lx_dim_none', layer: 'DIM', config_rev: 2 });
      WANT.dimNone = { st: 'none', stages: null, prev: null };
      // ── 对象夹具（伴生 / 主表）──
      await mk('objMain', { table_name: 'lx_obj_main', layer: 'DWD', config_rev: 2 });
      WANT.objMain = { st: 'none', stages: null, prev: null, names: ['dbo.lx_tgt', '日清任务', 'dbo.lx_tgt', 'dbo.usp_lx_a', 'tr_lx_ddl'] };
      await mk('compAcc', { table_name: 'lx_comp_acc', layer: 'DWD', config_mode: 'companion', companion_of: ids.objMain, config_rev: 2 });
      await fx.record(ids.compAcc, { phase: 'structure', result: 'pass', time: T1 }); await fx.record(ids.compAcc, { phase: 'data', result: 'pass', time: T2 });
      WANT.compAcc = { st: 'companion', stages: null, prev: null };
      await mk('adsPass', { table_name: 'lx_ads_pass', layer: 'ADS', config_rev: 2 }); await fx.record(ids.adsPass, { phase: null, result: 'pass', time: T1 });
      WANT.adsPass = { st: 'none', stages: null, prev: null };
      await mkObj('oP', { type: 'PROC', schema: 'dbo', name: 'usp_lx_a' });
      await mkObj('oT', { type: 'TABLE', schema: 'dbo', name: 'lx_tgt' });
      await mkObj('oF', { type: 'FDL_TASK', name: '日清任务' });
      await mkObj('oD', { type: 'FDL_TASK', name: '已删对象 lx', deleted: true });
      await mkObj('oG', { type: 'TRIGGER', schema: null, name: 'tr_lx_ddl' });
      await mkObj('oX', { type: 'FDL_TASK', name: XSS_NAME });
      await mkObj('oR', { type: 'FDL_TASK', name: '对象 R' });
      await mkObj('oV', { type: 'VIEW', schema: 'dbo', name: 'lx_tgt' });   // 与 oT 同显示名、不同类型（M1：钉住「不去重」）
      await link('objMain', 'oP', 'p', 2); await link('objMain', 'oT', 't', 1); await link('objMain', 'oF', 'f', 1); await link('objMain', 'oD', 'd', 0);
      await link('objMain', 99999999, '悬空对象', 0); await link('objMain', 'oG', 'g', 3); await link('objMain', 'oV', 'v', 1);
      await mk('objShared', { table_name: 'lx_obj_shared', layer: 'DWD', config_rev: 2 }); await link('objShared', 'oF', 'f', 0);
      WANT.objShared = { st: 'none', stages: null, prev: null, names: ['日清任务'] };
      await mk('objXss', { table_name: 'lx_obj_xss', layer: 'DWD', config_rev: 2 }); await link('objXss', 'oX', 'x', 0);
      WANT.objXss = { st: 'none', stages: null, prev: null, names: [XSS_NAME] };
      await mk('objComp', { table_name: 'lx_obj_comp', layer: 'DWD', config_mode: 'companion', companion_of: ids.objMain, config_rev: 2 }); await link('objComp', 'oR', 'r', 0);
      WANT.objComp = { st: 'companion', stages: null, prev: null, names: ['对象 R'] };
      await mk('objOnlyDel', { table_name: 'lx_obj_onlydel', layer: 'DWD', config_rev: 2 }); await link('objOnlyDel', 'oD', 'd', 0);
      WANT.objOnlyDel = { st: 'none', stages: null, prev: null, names: [] };
      await mk('objDelModel', { table_name: 'lx_obj_delmodel', layer: 'DWD', config_rev: 2, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' }); await link('objDelModel', 'oF', 'f', 0);
      // ── 填充：70 个 ODS 无记录模型 ──
      for (let i = 1; i <= 70; i++) await mk('fill' + i, { table_name: 'lx_fill_' + String(i).padStart(2, '0'), layer: 'ODS', config_rev: 2 });
      await w.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await w.close(); }
    await svc.start();
    rd = await H.openReader(dbPath);
    const tok = admin.token;
    const GET = (p) => api('GET', p, { token: tok });
    const list = await GET('/api/models');
    const rows = list.json || [];
    const byKey = (k) => rows.find((r) => r.id === ids[k]);
    check('一·列表 200 且 ≥ 80 行', list.status === 200 && Array.isArray(rows) && rows.length >= 80, `${list.status} ${rows.length}`);
    check('一·已删模型不在列表里', !byKey('objDelModel'));
    // 一、手写期望
    for (const [k, want] of Object.entries(WANT)) {
      const row = byKey(k);
      const names = want.names || [];
      const got = row ? { st: row.acceptance && row.acceptance.state, stages: row.acceptance ? row.acceptance.stages : undefined, prev: row.acceptance ? row.acceptance.prevResult : undefined, names: row.impl_obj_names } : null;
      const exp = { st: want.st, stages: want.stages, prev: want.prev, names };
      check(`一·手写期望：${k}（state / stages / prevResult / impl_obj_names）`, J(got) === J(exp), `got=${J(got)}\n  want=${J(exp)}`);
      if (want.at) check(`一·手写期望：${k} 的 at = ${want.at}`, row && row.acceptance && row.acceptance.at === want.at, J(row && row.acceptance));
    }
    check('一·手写期望：lx_obj_xss 的对象名原文一字不差（服务端不转义）', byKey('objXss') && byKey('objXss').impl_obj_names[0] === XSS_NAME);
    // 二、形状
    {
      const bad = [];
      for (const r of rows) {
        if (r.acceptance !== null) {
          if (Object.keys(r.acceptance).sort().join() !== 'at,prevResult,rows,stages,state') bad.push(`${r.table_name}: acceptance 键 ${Object.keys(r.acceptance).sort().join()}`);
          if ((r.acceptance.prevResult !== null) !== (r.acceptance.state === 'stale')) bad.push(`${r.table_name}: prevResult=${J(r.acceptance.prevResult)} state=${r.acceptance.state}`);
        } else bad.push(`${r.table_name}: acceptance 为 null`);
        if (!Array.isArray(r.impl_obj_names) || !r.impl_obj_names.every((x) => typeof x === 'string')) bad.push(`${r.table_name}: impl_obj_names 不是字符串数组`);
        if (!r.rel) bad.push(`${r.table_name}: rel 缺失`);
      }
      check(`二·形状：${rows.length} 行 acceptance 键集合 / prevResult ⇔ stale / impl_obj_names 字符串数组 / rel 仍在`, bad.length === 0, bad.slice(0, 5).join(NL + '  '));
    }
    // 三、同源
    {
      const names = [], stagesBad = [];
      const batch = await GET('/api/models/validation-status/batch?ids=' + rows.map((r) => r.id).join(','));
      check('三·同源：batch 接口 200', batch.status === 200 && batch.json && typeof batch.json === 'object', `${batch.status} ${batch.text.slice(0, 120)}`);
      for (const r of rows) {
        if (r.impl_obj_names.length !== r.rel.obj) names.push(`${r.table_name}: names.length=${r.impl_obj_names.length} rel.obj=${r.rel.obj}`);
        const rr = await GET(`/api/models/${r.id}/relations`);
        const fromRel = rr.status === 200 ? rr.json.objects.map(dispName) : ['status ' + rr.status];
        if (J(fromRel) !== J(r.impl_obj_names)) names.push(`${r.table_name}: list=${J(r.impl_obj_names)} relations=${J(fromRel)}`);
        const ph = ((batch.json || {})[r.id] || {}).phases || {};
        if (r.acceptance && r.acceptance.stages) {
          const s = r.acceptance.stages;
          const gs = ph.structure ? ph.structure.result : null, gd = ph.data ? ph.data.result : null;
          if (s.structure !== gs || s.data !== gd) stagesBad.push(`${r.table_name}: stages=${J(s)} batch=${J({ structure: gs, data: gd })}`);
        } else if (ph.structure || ph.data) stagesBad.push(`${r.table_name}: stages=null 但 batch 带了阶段 ${J(Object.keys(ph))}`);
      }
      check(`三·同源：${rows.length} 行 impl_obj_names 与 rel.obj 等长、且与 /relations 的 objects 显示名逐项相等（含顺序）`, names.length === 0, names.slice(0, 5).join(NL + '  '));
      check(`三·同源：${rows.length} 行 stages 与 batch 的 phases.structure / data 一致（null 时 batch 不含这两个阶段）`, stagesBad.length === 0, stagesBad.slice(0, 5).join(NL + '  '));
    }
    // 四、出错路径
    {
      const rawGet = async (p) => { try { const r = await fetch(svc.baseUrl + p, { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(8000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ } return { status: r.status, json: j, text: t }; } catch (e) { return { status: 0, json: null, text: String(e && e.message) }; } };
      fs.writeFileSync(nameFlag, 'x');
      const a = await rawGet('/api/models');
      fs.unlinkSync(nameFlag);
      check('四·出错路径：对象名查询抛错 → 200、每行 impl_obj_names === null，acceptance 与 rel 照常非 null', a.status === 200 && Array.isArray(a.json) && a.json.length > 0 && a.json.every((x) => x.impl_obj_names === null && x.acceptance !== null && x.rel !== null), J({ status: a.status, head: a.text.slice(0, 160) }));
      fs.writeFileSync(accFlag, 'x');
      const b = await rawGet('/api/models');
      fs.unlinkSync(accFlag);
      check('四·出错路径：验收取数抛错 → 200、每行 acceptance === null，impl_obj_names 照常是数组', b.status === 200 && Array.isArray(b.json) && b.json.length > 0 && b.json.every((x) => x.acceptance === null && Array.isArray(x.impl_obj_names)), J({ status: b.status, head: b.text.slice(0, 160) }));
      const c = await rawGet('/api/models');
      check('四·出错路径之后：服务仍可用，列表恢复（impl_obj_names 为数组）', c.status === 200 && Array.isArray(c.json) && c.json.every((x) => Array.isArray(x.impl_obj_names)), J({ status: c.status, head: c.text.slice(0, 160) }));
    }
    // 五、SQL 条数
    {
      const readTrace = () => (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split(NL).filter(Boolean).map((l) => JSON.parse(l)) : []);
      const measure = async (p, wantRows) => {
        const best = [];
        for (let i = 0; i < 3; i++) {
          const before = readTrace().length;
          const r = await GET(p);
          const tr = readTrace().slice(before);
          if (r.status !== 200 || tr.length !== 1) { best.push({ bad: `status=${r.status} 窗口记录 ${tr.length} 条` }); continue; }
          const rowsOk = wantRows(tr[0].rows);
          best.push({ n: tr[0].stmts.length, stmts: tr[0].stmts, rows: tr[0].rows, rowsOk });
        }
        return best;
      };
      const one = await measure('/api/models?keyword=lx_ods_pass', (n) => n === 1);
      const all = await measure('/api/models', (n) => n >= 80);
      const good = (arr) => arr.filter((x) => !x.bad && x.rowsOk);
      const pick = (arr) => good(arr).sort((x, y) => x.n - y.n)[0];
      const o1 = pick(one), oa = pick(all);
      console.log('SQL 条数（keyword 恰命中 1 行）：' + J(one.map((x) => x.bad || x.n)) + ' → 最小 ' + (o1 ? o1.n : 'n/a'));
      console.log('SQL 条数（全量）：' + J(all.map((x) => x.bad || x.n)) + ' → 最小 ' + (oa ? oa.n : 'n/a'));
      if (o1) console.log('语句序列（1 行）：' + NL + o1.stmts.map((s, i) => `  ${i + 1}. ${s}`).join(NL));
      check('五·SQL 条数：两种请求各 3 次都得到有效记录（行数符合：恰 1 行 / ≥ 80 行）', good(one).length === 3 && good(all).length === 3, J({ one, all: all.map((x) => x.bad || x.rows) }));
      check('五·SQL 条数：恰 1 行与 ≥ 80 行的最小条数相等且 === 5（与模型数无关）', !!o1 && !!oa && o1.n === oa.n && o1.n === 5, J({ one: o1 && o1.n, all: oa && oa.n }));
      const PRE = ['SELECT dm.*,', 'SELECT id, model_id, test_time', 'SELECT l.model_id AS model_id, o.schema_name', 'SELECT l.model_id AS model_id, COUNT(*)', 'SELECT id, table_name, table_comment, layer, status, config_mode, dim_config, is_deleted FROM data_models'];
      const seqOk = (x) => !!x && x.stmts.length === PRE.length && PRE.every((p, i) => x.stmts[i].startsWith(p));
      check('五·SQL 条数：最小那次的语句前缀序列与手写清单逐条相同（主查询 → 验收记录 → 对象名聚合 → 对象计数 → 全量模型）', seqOk(o1) && seqOk(oa), J({ one: o1 && o1.stmts, all: oa && oa.stmts }));
    }
    // 六、详情接口 acceptance（C5）。手写期望：reason / rows（每条验收记录 total_rows = 10；stale / none / companion 的 rows 为 null；partial 取唯一那条决定记录的行数）
    {
      const REASON_STALE = '模型配置在最近一次验收之后已变更，请重新验收';
      const WANT_DETAIL = {
        dimS: { reason: '缺少数据阶段验收', rows: 10, at: T1 },           // 缺数据：只有结构阶段（T1）
        dimD: { reason: '缺少结构阶段验收', rows: 10, at: T1 },           // 缺结构：只有数据阶段（T1）
        dwdAll: { reason: '', rows: 10, at: T1 },                          // warn（一条 all 记录 T1）
        dwdFail: { reason: '最近一次验收未通过', rows: 10, at: T2 },       // fail（结构 fail T1 + 数据 pass T2；决定记录里最新的是 T2）
        dwdLower: { reason: '', rows: 10, at: T2 },                        // pass（layer 小写 dwd；结构 T1 + 数据 T2）
        odsPass: { reason: '', rows: 10, at: T1 },                         // ODS pass
        odsStaleWarn: { reason: REASON_STALE, rows: null, at: T1 },        // stale，prevResult = warn；at = 更早版本那条通过记录的时间
        dimStale: { reason: REASON_STALE, rows: null, at: T2 },            // DIM stale，prevResult = warn，stages = null（stale 不带阶段）；at = 更早版本里最新的一条（数据 warn T2）
        odsStalePass: { reason: REASON_STALE, rows: null, at: T1 },        // stale，prevResult = pass；更新的 fail（T2）不是「通过记录」，at 取通过的 T1
        odsNullRev: { reason: REASON_STALE, rows: null, at: T1 },          // 修复批 L6：记录 config_rev 为 NULL → 不属于当前版本 → stale，prevResult = pass
        dimNullRev: { reason: REASON_STALE, rows: null, at: T2 },          // 修复批 L6：DIM 两条 NULL 版本记录（结构 pass T1、数据 warn T2）→ stale，prevResult = warn，at = 更新的那条（T2），stages = null
        dwdRows: { reason: '', rows: 17, at: T2 },                          // codex 44Tc M1：结构 3 行（T1）+ 数据 17 行（T2）→ rows = 17
        dimRowsOld: { reason: '', rows: 17, at: T2 },                       // codex 44Tc M1：结构 3 行（T2，更新）+ 数据 17 行（T1，更旧）→ at = T2、rows = 17（取数据阶段记录）
        dimPW: { reason: '', rows: 7, at: T2 },                             // codex 44Tc M2：结构 pass 5 行（T1）+ 数据 warn 7 行（T2）→ warn、rows = 7
        dwdWP: { reason: '', rows: 9, at: T2 },                             // codex 44Tc M2：结构 warn 4 行（T1）+ 数据 pass 9 行（T2）→ warn、rows = 9
        dimNone: { reason: '尚无验收记录', rows: null, at: null },         // none
        objMain: { reason: '尚无验收记录', rows: null, at: null },
        compAcc: { reason: '伴生表不独立验收', rows: null, at: null },     // companion（有 pass 记录也不独立判定）
        adsPass: { reason: '该分层暂无验收判定规则', rows: null, at: null }, // 非 DIM / DWD / ODS 分层 → none
        objShared: { reason: '尚无验收记录', rows: null, at: null },
        objXss: { reason: '尚无验收记录', rows: null, at: null },
        objComp: { reason: '伴生表不独立验收', rows: null, at: null },
        objOnlyDel: { reason: '尚无验收记录', rows: null, at: null },
      };
      check('六·前提：手写期望表覆盖 WANT 里的每个夹具、且 pass / warn / fail / partial×2 / stale×5（prevResult warn×3 + pass×2；其中 config_rev 为 NULL 的两个）/ none / companion 各有（不是空转）',
        J(Object.keys(WANT_DETAIL).sort()) === J(Object.keys(WANT).sort()) && ['pass', 'warn', 'fail', 'partial', 'stale', 'none', 'companion'].every((s) => Object.values(WANT).some((w) => w.st === s)), J({ w: Object.keys(WANT).sort(), d: Object.keys(WANT_DETAIL).sort() }));
      const KEYS = 'at,prevResult,reason,rows,stages,state';
      for (const [k, want] of Object.entries(WANT)) {
        const d = await GET(`/api/models/${ids[k]}`);
        const a = d.json && d.json.acceptance;
        check(`六·${k}：详情 200、id 一致，acceptance 是对象且键集合恰为 ${KEYS}`, d.status === 200 && d.json && d.json.id === ids[k] && !!a && typeof a === 'object' && Object.keys(a).sort().join() === KEYS, J({ status: d.status, id: d.json && d.json.id, keys: a && Object.keys(a).sort() }));
        if (!a) continue;
        const exp = { state: want.st, stages: want.stages, prevResult: want.prev, at: WANT_DETAIL[k].at, rows: WANT_DETAIL[k].rows, reason: WANT_DETAIL[k].reason };
        const got = { state: a.state, stages: a.stages, prevResult: a.prevResult, at: a.at, rows: a.rows, reason: a.reason };
        check(`六·${k}：state / stages / prevResult / at / rows / reason 逐值等于手写期望`, J(got) === J(exp), `got=${J(got)}\n  want=${J(exp)}`);
        const row = byKey(k);
        const same = ['state', 'at', 'rows', 'stages', 'prevResult'].filter((f) => J(a[f]) !== J(row.acceptance[f]));
        check(`六·${k}：除 reason 外与列表行 acceptance 逐字段相等（state / at / rows / stages / prevResult，同口径）`, same.length === 0, J({ differ: same, detail: a, list: row.acceptance }));
      }
      // 已删除（软删）模型：列表不返回；详情仍 200、is_deleted = 1，acceptance 按同一判定给出（手写期望：DWD 结构 pass T1 + 数据 pass T2 → pass、stages pass / pass、at = T2、rows = 10、reason 空、prevResult null）
      {
        const dd = await GET(`/api/models/${ids.delPass}`);
        const da = dd.json && dd.json.acceptance;
        check(`六·delPass（软删除）：详情 200、id 一致、is_deleted = 1，acceptance 是对象且键集合恰为 ${KEYS}`, dd.status === 200 && dd.json && dd.json.id === ids.delPass && dd.json.is_deleted === 1 && !!da && typeof da === 'object' && Object.keys(da).sort().join() === KEYS, J({ status: dd.status, id: dd.json && dd.json.id, del: dd.json && dd.json.is_deleted, keys: da && Object.keys(da).sort() }));
        const expDel = { state: 'pass', stages: { structure: 'pass', data: 'pass' }, prevResult: null, at: T2, rows: 10, reason: '' };
        const gotDel = da ? { state: da.state, stages: da.stages, prevResult: da.prevResult, at: da.at, rows: da.rows, reason: da.reason } : null;
        check('六·delPass（软删除）：state / stages / prevResult / at / rows / reason 逐值等于手写期望（只断言详情；列表不返回已删模型，不与列表对拍）', J(gotDel) === J(expDel), `got=${J(gotDel)}\n  want=${J(expDel)}`);
        check('六·delPass（软删除）：确实不在列表里（前提：详情有它、列表没有，才说得上「只断言详情」）', !byKey('delPass'));
      }
      // 出错路径：验收取数抛错 → 详情 200、acceptance === null、其余字段（id / table_name / layer）照常；之后恢复
      const rawGet2 = async (p) => { try { const r = await fetch(svc.baseUrl + p, { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(8000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ } return { status: r.status, json: j, text: t }; } catch (e) { return { status: 0, json: null, text: String(e && e.message) }; } };
      fs.writeFileSync(detailAccFlag, 'x');
      const bad = await rawGet2(`/api/models/${ids.dwdLower}`);
      fs.unlinkSync(detailAccFlag);
      check('六·出错路径：验收取数抛错 → 详情 200、acceptance === null（不是 none 假值）、id / table_name / layer 照常', bad.status === 200 && bad.json && bad.json.acceptance === null && bad.json.id === ids.dwdLower && bad.json.table_name === 'lx_dwd_lower_pass' && bad.json.layer === 'dwd', J({ status: bad.status, head: bad.text.slice(0, 200) }));
      const back = await rawGet2(`/api/models/${ids.dwdLower}`);
      check('六·出错路径之后：详情恢复（acceptance.state === pass）', back.status === 200 && back.json && back.json.acceptance && back.json.acceptance.state === 'pass', J({ status: back.status, head: back.text.slice(0, 200) }));
      const nf = await rawGet2('/api/models/99999999');
      check('六·不存在的 id 仍 404 且 error =「模型不存在」', nf.status === 404 && nf.json && nf.json.error === '模型不存在', J({ status: nf.status, head: nf.text.slice(0, 120) }));
    }
  } finally {
    if (rd) await rd.close();
    await svc.stop().catch(() => {});
    check('收尾：服务运行期间测试进程写库次数为 0', gate.writes === 0, String(gate.writes));
  }
  console.log(`verify-model-list-extras PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? process.exitCode || 0 : 1;
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch((e) => { console.log('FAIL 套件异常：' + (e && e.stack || e)); process.exit(1); });
