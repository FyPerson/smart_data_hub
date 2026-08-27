// 验证脚本：上线单管理体验优化 R-C4 —— sys_release_audit 批次级审计表 schema 断言（方案 20260824_v1.3 §3.0）
//   用法：node scripts/verify-sys-release-audit-schema.js
//
// ⚠️ 范围订正（452-M2，方案文末收口）：v1.2 初版设想"新库 CREATE 路径与旧库迁移路径分别建表逐列对拍"，
//   但 452-M2 现场核实——本表是方案首次引入，v1.0-v1.2 均未部署过，**不存在**"旧库已有该表但缺组合
//   CHECK"这种历史场景；`CREATE TABLE IF NOT EXISTS` 对新库/旧库走的是**同一条**路径，没有第二条可比对
//   的迁移路径。本文件因此把"两路径对拍"改造为「同一条建表路径在两个独立空库上各自新建一次，结果必须
//   逐列/逐索引字节相同」——验证的是该路径本身的**确定性/自洽性**（即"不存在隐藏的库状态依赖"），
//   与 452-M2 的结论互证而非矛盾。防御性 CHECK 检测（452-M2 原文"若发现已存在但缺 CHECK 的同名表必须
//   走事务内重建迁移"）落在本文件的静态自证断言里（sqlite_master.sql 文本扫描——见 [3] 组），而非production
//   runtime 迁移代码：production 侧目前没有、也不需要一条"检测到旧表缺 CHECK 就重建"的运行时分支，因为
//   该场景在当前代码库结构上不可达（无任何历史部署留下过这张表）；一旦真出现这种从未设想过的部署残留，
//   `CREATE TABLE IF NOT EXISTS` 会因表已存在而直接跳过（no-op），本文件的 sqlite_master.sql 扫描断言
//   会在下一次跑 verify 时立刻翻红——这就是"发现"的兜底手段。
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const noop = () => {};

const authenticateToken = (req, res, next) => next();
const requireAdmin = (req, res, next) => next();

function makeDbHandles() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  return { db, run, all, get };
}
function waitReadyOn(internals) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (internals.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (internals.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(internals.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}
async function buildModule({ db, run, get, all }) {
  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken, requireAdmin,
    ...require('./_sys-attach-test-deps'),
  });
  mod.initSchema();
  await waitReadyOn(mod._internals);
  return mod;
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function main() {
  // ── [1] 建表 + readiness 就绪 + 与 SYS_RELEASE_AUDIT_KEY_COLS（真实导出常量，写读同源）逐列对拍 ──────
  const h1 = makeDbHandles();
  const mod1 = await buildModule(h1);
  const I = mod1._internals;
  assert.ok(Array.isArray(I.SYS_RELEASE_AUDIT_KEY_COLS) && I.SYS_RELEASE_AUDIT_KEY_COLS.length === 12,
    `[1-pre] SYS_RELEASE_AUDIT_KEY_COLS 应恰 12 列，实得 ${I.SYS_RELEASE_AUDIT_KEY_COLS && I.SYS_RELEASE_AUDIT_KEY_COLS.length}`);
  ok('[1-pre] 导出常量 SYS_RELEASE_AUDIT_KEY_COLS 直读（RC-L2 防复刻漂移），非本文件另拼一份字面量列清单');

  const cols1 = await h1.all(`PRAGMA table_info(sys_release_audit)`);
  const colNames1 = cols1.map(c => c.name);
  assert.ok(colNames1.includes('id'), '[1a] 主键列 id 存在');
  for (const c of I.SYS_RELEASE_AUDIT_KEY_COLS) {
    assert.ok(colNames1.includes(c), `[1a] 关键列 ${c} 存在（PRAGMA table_info 实得列=${colNames1.join(',')}）`);
  }
  assert.strictEqual(colNames1.length, I.SYS_RELEASE_AUDIT_KEY_COLS.length + 1, `[1a] 列总数应恰为关键列+id=${I.SYS_RELEASE_AUDIT_KEY_COLS.length + 1}，实得 ${colNames1.length}（多列/少列都需要人工核实 DDL 与常量是否同步）`);
  ok(`[1a] PRAGMA table_info(sys_release_audit) 列名与 SYS_RELEASE_AUDIT_KEY_COLS 逐列对拍一致（含 id，共 ${colNames1.length} 列）`);

  // notnull/dflt_value 关键列逐一核对（DDL 冻结原文）
  const byName1 = Object.fromEntries(cols1.map(c => [c.name, c]));
  assert.strictEqual(byName1.release_id.notnull, 1, '[1b] release_id NOT NULL');
  assert.strictEqual(byName1.release_no.notnull, 1, '[1b] release_no NOT NULL');
  assert.strictEqual(byName1.action.notnull, 1, '[1b] action NOT NULL');
  assert.strictEqual(byName1.release_json.notnull, 1, '[1b] release_json NOT NULL');
  assert.strictEqual(byName1.changes_json.notnull, 0, '[1b] changes_json 可空（edit 专用，delete 时为 NULL）');
  assert.strictEqual(byName1.executors_json.notnull, 0, '[1b] executors_json 可空（delete 专用，edit 时为 NULL）');
  assert.strictEqual(byName1.member_issue_ids.notnull, 1, "[1b] member_issue_ids NOT NULL（DEFAULT '[]'）");
  assert.strictEqual(byName1.member_issue_ids.dflt_value, "'[]'", "[1b] member_issue_ids 默认值 '[]'");
  assert.strictEqual(byName1.member_count.notnull, 1, '[1b] member_count NOT NULL（DEFAULT 0）');
  assert.strictEqual(String(byName1.member_count.dflt_value), '0', '[1b] member_count 默认值 0');
  assert.strictEqual(byName1.reason.notnull, 0, '[1b] reason 可空（delete 必填走服务层守卫，DB 层不设 NOT NULL）');
  assert.strictEqual(byName1.operator_id.notnull, 1, '[1b] operator_id NOT NULL');
  assert.strictEqual(byName1.operator_name.notnull, 1, '[1b] operator_name NOT NULL');
  ok('[1b] notnull/dflt_value 逐列核对与 DDL 冻结原文一致（release_id/release_no/action/release_json/member_issue_ids/member_count/operator_id/operator_name 恒 NOT NULL；changes_json/executors_json/reason 可空）');

  // ── [2] 两索引均在 ──────────────────────────────────────────────────────────
  const idxList1 = await h1.all(`PRAGMA index_list(sys_release_audit)`);
  const idxNames1 = idxList1.map(i => i.name);
  assert.ok(idxNames1.includes('idx_sys_release_audit_release'), `[2] idx_sys_release_audit_release 存在，实得索引=${idxNames1.join(',')}`);
  assert.ok(idxNames1.includes('idx_sys_release_audit_created'), `[2] idx_sys_release_audit_created 存在，实得索引=${idxNames1.join(',')}`);
  ok('[2] PRAGMA index_list：idx_sys_release_audit_release / idx_sys_release_audit_created 均在');

  // ── [3] 452-M2 建表约束自证：sqlite_master.sql 含 CHECK 与两条形态子句 ──────────────────
  const ddlRow = await h1.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_release_audit'`);
  assert.ok(ddlRow && ddlRow.sql, '[3-pre] sqlite_master 能读到 sys_release_audit 的建表 DDL 原文');
  assert.ok(/CHECK/.test(ddlRow.sql), '[3a] DDL 原文含 CHECK 关键字（防"以为建了实际没建"——最基础的存在性）');
  assert.ok(ddlRow.sql.includes("action='edit'") && ddlRow.sql.includes('changes_json IS NOT NULL') && ddlRow.sql.includes('executors_json IS NULL'),
    '[3b] DDL 原文含 edit 形态子句字面量（action=\'edit\' ∧ changes_json IS NOT NULL ∧ executors_json IS NULL ∧ reason IS NULL）');
  assert.ok(ddlRow.sql.includes("action='delete'") && ddlRow.sql.includes('executors_json IS NOT NULL') && ddlRow.sql.includes('reason IS NOT NULL'),
    '[3c] DDL 原文含 delete 形态子句字面量（action=\'delete\' ∧ changes_json IS NULL ∧ executors_json IS NOT NULL ∧ reason IS NOT NULL）');
  ok('[3] 452-M2 建表约束自证通过：sqlite_master.sql 原文含 CHECK 与 edit/delete 两条形态子句的关键片段（非仅"表存在"这类弱断言）');

  // [472-MED-2] 负载最小语义六 CHECK 的存在性自证——同 [3a-3c] 精神，防"以为补了实际没建"。
  assert.ok(ddlRow.sql.includes('member_count >= 0'), '[3d] DDL 原文含 member_count >= 0 子句');
  assert.ok(ddlRow.sql.includes('json_valid(member_issue_ids)') && ddlRow.sql.includes("json_type(member_issue_ids) = 'array'"),
    '[3e] DDL 原文含 member_issue_ids 的 json_valid ∧ json_type=array 子句');
  assert.ok(ddlRow.sql.includes('json_valid(release_json)') && ddlRow.sql.includes("json_type(release_json) = 'object'"),
    '[3f] DDL 原文含 release_json 的 json_valid ∧ json_type=object 子句（472 复审收紧：快照恒对象）');
  assert.ok(ddlRow.sql.includes('json_array_length(changes_json) > 0'), '[3g] DDL 原文含 changes_json 非空数组子句（json_array_length > 0）');
  assert.ok(ddlRow.sql.includes("json_type(executors_json) = 'array'"), '[3h] DDL 原文含 executors_json 的 json_type=array 子句');
  assert.ok(ddlRow.sql.includes("trim(reason) <> ''"), "[3i] DDL 原文含 reason 去空白后非空子句（trim(reason) <> ''）");
  ok('[3-472] 472-MED-2 建表约束自证通过：sqlite_master.sql 原文含新增六条负载最小语义 CHECK 的关键片段');

  // [476-MED] member_count 一致性 CHECK 的存在性自证——同 [3d-3i] 精神：先证"DB 里真的建出来了这条
  //   约束"，再在下方 [4] 用真实 INSERT 证明它真的拦得住。ddlRow.sql 来自 sqlite_master（运行时编译后
  //   的 DDL 原文，非本文件另存的字面量副本），故这一条同时覆盖"源码 DDL 写对了"与"运行时表结构真的
  //   带上了这条约束"两面——两者本就是同一次 buildModule() 真实执行的产物，不存在需要分别对拍的两条路径。
  assert.ok(ddlRow.sql.includes('member_count = json_array_length(member_issue_ids)'),
    '[3j] DDL 原文含 member_count 一致性子句（CHECK (member_count = json_array_length(member_issue_ids))，476-MED 采纳）');
  ok('[3j] 476-MED 建表约束自证通过：sqlite_master.sql 原文含 member_count = json_array_length(member_issue_ids) 一致性子句');

  // ── [4] 451-M2 组合 CHECK 生效性：四种违规形态各一 → 必须被拒；两种合法形态 → 必须成功 ────────
  const baseRow = () => ({
    release_id: 1, release_no: 'R-CHECK-TEST', release_json: '{"id":1}', operator_id: 1, operator_name: '测试员',
  });
  async function tryInsert(fields) {
    const row = { ...baseRow(), ...fields };
    const cols = Object.keys(row);
    const ph = cols.map(() => '?').join(',');
    try {
      await h1.run(`INSERT INTO sys_release_audit (${cols.join(',')}) VALUES (${ph})`, cols.map(c => row[c]));
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e };
    }
  }
  // 违规① edit 带 reason（edit 分支要求 reason IS NULL）
  const v1 = await tryInsert({ action: 'edit', changes_json: '[]', executors_json: null, reason: '不该有' });
  assert.strictEqual(v1.ok, false, '[4a] 违规①：edit 带 reason 应被 CHECK 拒绝，实际却插入成功');
  ok('[4a] 违规①拒绝：action=edit 但 reason 非空（越过 edit 分支 reason IS NULL 要求）→ INSERT 失败');

  // 违规② edit 缺 changes_json（NULL）
  const v2 = await tryInsert({ action: 'edit', changes_json: null, executors_json: null, reason: null });
  assert.strictEqual(v2.ok, false, '[4b] 违规②：edit 缺 changes_json 应被 CHECK 拒绝，实际却插入成功');
  ok('[4b] 违规②拒绝：action=edit 但 changes_json 为 NULL（越过 edit 分支 changes_json IS NOT NULL 要求）→ INSERT 失败');

  // 违规③ delete 缺 executors_json（NULL）
  const v3 = await tryInsert({ action: 'delete', changes_json: null, executors_json: null, reason: '删除原因' });
  assert.strictEqual(v3.ok, false, '[4c] 违规③：delete 缺 executors_json 应被 CHECK 拒绝，实际却插入成功');
  ok('[4c] 违规③拒绝：action=delete 但 executors_json 为 NULL（越过 delete 分支 executors_json IS NOT NULL 要求）→ INSERT 失败');

  // 违规④ delete 缺 reason（NULL）
  const v4 = await tryInsert({ action: 'delete', changes_json: null, executors_json: '[]', reason: null });
  assert.strictEqual(v4.ok, false, '[4d] 违规④：delete 缺 reason 应被 CHECK 拒绝，实际却插入成功');
  ok('[4d] 违规④拒绝：action=delete 但 reason 为 NULL（越过 delete 分支 reason IS NOT NULL 要求）→ INSERT 失败');

  // 合法① edit 形态
  const g1 = await tryInsert({ action: 'edit', changes_json: '[{"field":"title","old":null,"new":"x"}]', executors_json: null, reason: null });
  assert.strictEqual(g1.ok, true, `[4e] 合法①：edit 标准形态应成功，实际失败：${g1.err && g1.err.message}`);
  ok('[4e] 合法①通过：action=edit ∧ changes_json 非空 ∧ executors_json/reason 均 NULL → INSERT 成功');

  // 合法② delete 形态
  const g2 = await tryInsert({ action: 'delete', changes_json: null, executors_json: '[{"user_id":5}]', reason: '建错批次带成员删' });
  assert.strictEqual(g2.ok, true, `[4f] 合法②：delete 标准形态应成功，实际失败：${g2.err && g2.err.message}`);
  ok('[4f] 合法②通过：action=delete ∧ changes_json NULL ∧ executors_json/reason 均非空 → INSERT 成功');
  ok('[4] 451-M2 组合 CHECK 生效性：四种违规形态各自被拒绝 + 两种合法形态各自成功（正反成对，防"CHECK 写了但语法错导致恒真"）');

  // ── [4-472] 472-MED-2 负载最小语义六 CHECK：六种违规形态各一，均须以 SQLITE_CONSTRAINT 拒绝 ──────
  //   （不是弱判据"随便什么错都算过"——必须精确是约束违反，不是语法错/绑定错混进来冒充红灯）。
  const editBase = { action: 'edit', changes_json: '[{"field":"title","old":null,"new":"x"}]', executors_json: null, reason: null };
  function assertConstraintRejected(result, label) {
    assert.strictEqual(result.ok, false, `${label} 应被 CHECK 拒绝，实际却插入成功`);
    assert.ok(result.err && /SQLITE_CONSTRAINT/.test(result.err.code || result.err.message || ''),
      `${label} 应以 SQLITE_CONSTRAINT 拒绝，实际报错=${result.err && (result.err.code || result.err.message)}`);
  }

  const v5 = await tryInsert({ ...editBase, member_count: -1 });
  assertConstraintRejected(v5, '[4g] 违规⑤ member_count=-1');
  ok('[4g] 违规⑤拒绝：member_count=-1（越过 member_count >= 0 要求）→ SQLITE_CONSTRAINT');

  const v6 = await tryInsert({ ...editBase, member_issue_ids: 'not-json' });
  assertConstraintRejected(v6, '[4h] 违规⑥ member_issue_ids=\'not-json\'');
  ok("[4h] 违规⑥拒绝：member_issue_ids='not-json'（非合法 JSON，越过 json_valid ∧ json_type=array 要求）→ SQLITE_CONSTRAINT");

  const v7 = await tryInsert({ ...editBase, release_json: 'not-json-at-all' });
  assertConstraintRejected(v7, '[4i] 违规⑦ release_json 非法 JSON');
  ok('[4i] 违规⑦拒绝：release_json 非法 JSON（越过 json_valid(release_json) 要求）→ SQLITE_CONSTRAINT');

  // [472 复审收紧] release_json 唯一写入点是 SELECT * 序列化（sys_releases 一行→JSON.stringify 恒产出
  // 对象），故不能只校验"合法 JSON"——'[]' 是合法 JSON 但顶层类型是数组非对象，同样该被拒。
  const v11 = await tryInsert({ ...editBase, release_json: '[]' });
  assertConstraintRejected(v11, "[4m] 违规⑪ release_json='[]'（合法 JSON 但数组非对象）");
  ok("[4m] 违规⑪拒绝：release_json='[]'（合法 JSON 数组，但顶层类型非 object，越过 json_type(release_json)='object' 要求，472 复审收紧）→ SQLITE_CONSTRAINT");

  const v8 = await tryInsert({ action: 'edit', changes_json: '[]', executors_json: null, reason: null });
  assertConstraintRejected(v8, "[4j] 违规⑧ action='edit'+changes_json='[]'（空数组）");
  ok('[4j] 违规⑧拒绝：action=\'edit\' 但 changes_json=\'[]\'（合法 JSON 数组但长度为 0，越过 json_array_length > 0 要求）→ SQLITE_CONSTRAINT（与姊妹用例 [4k] 区分"空数组"与"非法 JSON"两种不同违规成因）');

  const v9 = await tryInsert({ action: 'edit', changes_json: '', executors_json: null, reason: null });
  assertConstraintRejected(v9, "[4k] 违规⑨ action='edit'+changes_json=''（空字符串非法 JSON）");
  ok("[4k] 违规⑨拒绝：action='edit' 但 changes_json=''（非 NULL 故越过两形态 CHECK 的 IS NOT NULL 判据，但空串非合法 JSON，越过 json_valid 要求）→ SQLITE_CONSTRAINT");

  const v10 = await tryInsert({ action: 'delete', changes_json: null, executors_json: '[{"user_id":5}]', reason: '   ' });
  assertConstraintRejected(v10, "[4l] 违规⑩ action='delete'+reason='   '（空白串）");
  ok("[4l] 违规⑩拒绝：action='delete' 但 reason='   '（非 NULL 故越过两形态 CHECK 的 IS NOT NULL 判据，但 trim 后为空，越过 trim(reason)<>'' 要求）→ SQLITE_CONSTRAINT");

  ok('[4-472] 472-MED-2 组合 CHECK 生效性：七种违规形态各自被 SQLITE_CONSTRAINT 拒绝（member_count 负数/member_issue_ids 非 JSON/release_json 非 JSON/release_json 合法 JSON 但非对象/changes_json 空数组/changes_json 空字符串/reason 空白串）');

  // ── [4n·476-MED] member_count 与 member_issue_ids 元素数一致性 CHECK：结构合法但两个字段互相矛盾
  //   的坏行（形状各自合法——member_count 非负整数、member_issue_ids 是合法 JSON 数组——此前能插入
  //   成功，是本次 476 号采纳的缺口本身）。member_count=3 但数组只有 2 个元素，两边形状都合法，唯独
  //   数值对不上。
  const v12 = await tryInsert({ ...editBase, member_issue_ids: '[101,102]', member_count: 3 });
  assertConstraintRejected(v12, "[4n] 违规⑫ member_count=3 但 member_issue_ids 只有 2 个元素");
  ok('[4n] 违规⑫拒绝（476-MED）：member_count 与 json_array_length(member_issue_ids) 不一致（member_count=3 ∧ 数组长度=2，两字段各自形状合法但数值矛盾）→ SQLITE_CONSTRAINT');

  // 正例：member_count 与数组长度一致的行应成功插入——插入后立即删除（不留残留污染本文件其余断言/
  //   后续 [5] 组的空库假设），证明新 CHECK 不是"逢 member_count/member_issue_ids 组合必拒"的过宽实现
  //   （先红后绿范式：[4n] 已证"真的拦不一致"，本条证"一致的正常写入路径没被误伤"，正反成对）。
  const g3 = await tryInsert({ ...editBase, member_issue_ids: '[201,202,203]', member_count: 3 });
  assert.strictEqual(g3.ok, true, `[4o] 合法③：member_count 与数组长度一致（3=3）应成功插入，实际失败：${g3.err && g3.err.message}`);
  const g3Row = await h1.get(`SELECT id FROM sys_release_audit WHERE release_no = ? ORDER BY id DESC LIMIT 1`, ['R-CHECK-TEST']);
  assert.ok(g3Row && g3Row.id, '[4o-pre] 应能读回刚插入的合法③行以便清理');
  await h1.run(`DELETE FROM sys_release_audit WHERE id = ?`, [g3Row.id]);
  const g3Residual = await h1.get(`SELECT COUNT(*) c FROM sys_release_audit WHERE id = ?`, [g3Row.id]);
  assert.strictEqual(g3Residual.c, 0, '[4o-post] 合法③行清理后应零残留');
  ok('[4o] 合法③通过（476-MED 先红后绿范式）：member_count=3 与 member_issue_ids 元素数=3 一致 → INSERT 成功，随即删除且零残留');

  h1.db.close();

  // ⚠️ [S9 预筛登记] 本 [5] 组近恒真（静态 CREATE 两空库跑两次必同·缺陷检出力≈0，保留为 452-M2 的
  //   正面文档化验证）；[1b] 的 notnull/dflt_value 断言族无变异背书（方案 §6 原案"临时改可空判红"
  //   被 [6] 的 CHECK 变异替代——偏离登记，[4d] 有变异背书 [1b] 没有）；CAS WHERE 的 status='计划中'
  //   合取式无独立覆盖（与 status 门冗余·登记接受）；edit 守卫 [8]/[10a] 变异实例复用主套件同一
  //   :memory: 连接且各自 initSchema（各实例 mutex 独立而连接共享=跨实例串行化失效面·本文件末尾
  //   位置+数据不重叠故无害·登记知悉）。
  // ── [5] 建表路径确定性/自洽性（452-M2 订正："新库/旧库同一条路径"没有第二条可比对的迁移路径，
  //   改证该唯一路径本身在两个独立空库上重复执行结果字节相同）──────────────────────────
  const h2 = makeDbHandles();
  const mod2 = await buildModule(h2);
  const cols2 = await h2.all(`PRAGMA table_info(sys_release_audit)`);
  const idxList2 = await h2.all(`PRAGMA index_list(sys_release_audit)`);
  const normalizeCols = (cols) => cols.map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
  assert.deepStrictEqual(normalizeCols(cols1), normalizeCols(cols2),
    '[5a] 同一条 CREATE TABLE IF NOT EXISTS 路径在两个独立空库上各自新建一次，PRAGMA table_info 逐列（name/type/notnull/dflt_value/pk）必须字节相同（452-M2：不存在会产生分叉结果的第二条迁移路径）');
  assert.deepStrictEqual(idxList1.map(i => i.name).sort(), idxList2.map(i => i.name).sort(),
    '[5b] 两次独立建表的索引集合必须相同');
  const ddlRow2 = await h2.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_release_audit'`);
  assert.strictEqual(ddlRow2.sql, ddlRow.sql, '[5c] 两次独立建表的 sqlite_master.sql 原文逐字相同（DDL 无任何环境相关分支）');
  ok('[5] 建表路径确定性自证：同一条建表路径在两个独立空库上各自新建，列结构/索引/DDL 原文三者逐字相同（452-M2 结论的正面验证——CREATE TABLE IF NOT EXISTS 是新旧库唯一路径，本身不含隐藏的环境依赖分支）');
  h2.db.close();

  // ── [6] 活体变异：现场破坏 CHECK 的其中一条子句 → 原本会被拒绝的违规形态必须改为成功（判红） ──────
  //   把 edit 分支的 `executors_json IS NULL` 从组合 CHECK 里摘掉（模拟"DDL 被误改弱化"）——[4a] 那种
  //   "edit 带 reason" 违规此处换个角度：改造 delete 分支的 `reason IS NOT NULL` 判据，验证 [4d] 违规④
  //   （delete 缺 reason）会从"必须被拒"翻转为"能插入成功"，证明 [4d] 的红/绿真实依赖该子句存在。
  {
    const REAL_INDEX_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const REAL_SRC = fs.readFileSync(REAL_INDEX_PATH, 'utf8');
    const NEEDLE = "OR (action='delete' AND changes_json IS NULL     AND executors_json IS NOT NULL AND reason IS NOT NULL))";
    const occ = REAL_SRC.split(NEEDLE).length - 1;
    assert.strictEqual(occ, 1, `[6-pre] delete 形态 CHECK 子句文本定位必须唯一命中，实得 ${occ} 处——源码结构已变，需要人工核实并更新本变异脚本`);
    const mutatedSrc = REAL_SRC.replace(NEEDLE, "OR (action='delete' AND changes_json IS NULL     AND executors_json IS NOT NULL))");
    const tmpName = `.mutant-audit-${crypto.randomBytes(6).toString('hex')}.js`;
    const tmpPath = path.join(path.dirname(REAL_INDEX_PATH), tmpName);
    const h3 = makeDbHandles();
    try {
      fs.writeFileSync(tmpPath, mutatedSrc, 'utf8');
      delete require.cache[require.resolve(tmpPath)];
      const mmod = require(tmpPath)({
        logger: { info: noop, warn: noop, error: noop, debug: noop },
        db: h3.db, dbRunAsync: h3.run, dbGetAsync: h3.get, dbAllAsync: h3.all,
        authenticateToken, requireAdmin,
        ...require('./_sys-attach-test-deps'),
      });
      mmod.initSchema();
      await waitReadyOn(mmod._internals);
      let mutantOk = false, mutantErr = null;
      try {
        await h3.run(
          `INSERT INTO sys_release_audit (release_id, release_no, release_json, action, changes_json, executors_json, reason, operator_id, operator_name)
           VALUES (1, 'R-MUT', '{"id":1}', 'delete', NULL, '[]', NULL, 1, '测试员')`
        );
        mutantOk = true;
      } catch (e) { mutantErr = e; }
      assert.strictEqual(mutantOk, true, `[6] 活体变异应判红（此处"判红"体现为：真实代码会拒绝的 INSERT 在变异代码里插入成功）——若仍失败说明变异未生效，实际报错：${mutantErr && mutantErr.message}`);
    } finally {
      try { h3.db.close(); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
    ok('[6] 活体变异通过：摘掉组合 CHECK 里 delete 分支的 "reason IS NOT NULL" 子句后，[4d] 判定的"delete 缺 reason 应被拒绝" INSERT 在变异代码里插入成功——证明 [4d] 的拒绝真实依赖这条子句，不是别的巧合（同 spec 硬约束"活体变异：临时把某列改成可空/条件摘除 → 守卫必须判红"的等价体现）');
  }

  // ── [7] 472 回卷变异自证：摘掉 CHECK (member_count >= 0) → [4g] 的负数插入必须由拒转成 ──────────
  //   ⚠️ [476-MED 现场实测收口] 476 新增的 CHECK (member_count = json_array_length(member_issue_ids))
  //   对"任意合法数组"的 json_array_length 恒 >= 0，等式约束天然蕴含 member_count >= 0——本条新 CHECK
  //   在场时，member_count=-1 的插入即使摘掉了 member_count>=0 也仍会被新 CHECK 独立拦下（首跑实测撞见：
  //   [7] 判据不再成立，报"仍被拒绝"而非预期的"由拒转成"）。这不是本文件的缺陷，是**新约束在数学上
  //   subsume（蕴含覆盖）了旧约束**这一真实关系——member_count>=0 对"member_issue_ids 恒是合法数组"
  //   这个前提下已是冗余条款（DB 层仍保留两条 CHECK，双保险不因逻辑蕴含而删旧的一条，同 defense-in-
  //   depth 既有取舍）。要单独隔离验证"旧 member_count>=0 子句本身"的必要性，本变异须**同时**摘掉新
  //   增的一致性子句——否则测的就不是"这一条子句"，是"这两条子句的合取"，与变异测试"只改一处，看它
  //   是否是判红/判绿的充分必要原因"的精神相悖。
  {
    const REAL_INDEX_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const REAL_SRC = fs.readFileSync(REAL_INDEX_PATH, 'utf8');
    const NEEDLE = 'CHECK (member_count >= 0),';
    const occ = REAL_SRC.split(NEEDLE).length - 1;
    assert.strictEqual(occ, 1, `[7-pre] member_count>=0 CHECK 子句文本定位必须唯一命中，实得 ${occ} 处——源码结构已变，需要人工核实并更新本变异脚本`);
    const NEEDLE_476 = 'CHECK (member_count = json_array_length(member_issue_ids)),';
    const occ476 = REAL_SRC.split(NEEDLE_476).length - 1;
    assert.strictEqual(occ476, 1, `[7-pre] member_count 一致性 CHECK（476-MED）子句文本定位必须唯一命中，实得 ${occ476} 处——源码结构已变，需要人工核实并更新本变异脚本`);
    const mutatedSrc = REAL_SRC.replace(NEEDLE, '').replace(NEEDLE_476, '');
    const tmpName = `.mutant-audit-membercount-${crypto.randomBytes(6).toString('hex')}.js`;
    const tmpPath = path.join(path.dirname(REAL_INDEX_PATH), tmpName);
    const h4 = makeDbHandles();
    try {
      fs.writeFileSync(tmpPath, mutatedSrc, 'utf8');
      delete require.cache[require.resolve(tmpPath)];
      const mmod = require(tmpPath)({
        logger: { info: noop, warn: noop, error: noop, debug: noop },
        db: h4.db, dbRunAsync: h4.run, dbGetAsync: h4.get, dbAllAsync: h4.all,
        authenticateToken, requireAdmin,
        ...require('./_sys-attach-test-deps'),
      });
      mmod.initSchema();
      await waitReadyOn(mmod._internals);
      let mutantOk = false, mutantErr = null;
      try {
        await h4.run(
          `INSERT INTO sys_release_audit (release_id, release_no, release_json, action, changes_json, executors_json, reason, operator_id, operator_name, member_count)
           VALUES (1, 'R-MUT-MC', '{"id":1}', 'edit', '[{"field":"title","old":null,"new":"x"}]', NULL, NULL, 1, '测试员', -1)`
        );
        mutantOk = true;
      } catch (e) { mutantErr = e; }
      assert.strictEqual(mutantOk, true, `[7] 活体变异应判红（此处"判红"体现为：真实代码会拒绝的 member_count=-1 INSERT 在变异代码里插入成功）——若仍失败说明变异未生效，实际报错：${mutantErr && mutantErr.message}`);
    } finally {
      try { h4.db.close(); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
    ok('[7] 活体变异通过（472 回卷·476-MED 现场订正为同时摘掉两条子句）：member_count>=0 与 476 新增的一致性 CHECK 均摘掉后，[4g] 判定的"member_count=-1 应被拒绝" INSERT 才由拒转成——单摘前者不再够（新一致性 CHECK 数学上蕴含非负性，独立拦得住），证明"至少一条约束仍在管这件事"这条防线是真实的，不是巧合');
  }

  // ── [8·476-MED] 活体变异：摘掉新增的 CHECK (member_count = json_array_length(member_issue_ids))
  //   → [4n] 判定的"member_count 与数组长度不一致应被拒绝"必须由拒转成——同 [6]/[7] 同款范式（先红
  //   后绿：真实代码判红，变异代码里同一条 INSERT 判绿，证明拒绝真实依赖这条子句而非巧合）。
  {
    const REAL_INDEX_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const REAL_SRC = fs.readFileSync(REAL_INDEX_PATH, 'utf8');
    const NEEDLE = 'CHECK (member_count = json_array_length(member_issue_ids)),';
    const occ = REAL_SRC.split(NEEDLE).length - 1;
    assert.strictEqual(occ, 1, `[8-pre] member_count 一致性 CHECK 子句文本定位必须唯一命中，实得 ${occ} 处——源码结构已变，需要人工核实并更新本变异脚本`);
    const mutatedSrc = REAL_SRC.replace(NEEDLE, '');
    const tmpName = `.mutant-audit-membercount-consistency-${crypto.randomBytes(6).toString('hex')}.js`;
    const tmpPath = path.join(path.dirname(REAL_INDEX_PATH), tmpName);
    const h5 = makeDbHandles();
    try {
      fs.writeFileSync(tmpPath, mutatedSrc, 'utf8');
      delete require.cache[require.resolve(tmpPath)];
      const mmod = require(tmpPath)({
        logger: { info: noop, warn: noop, error: noop, debug: noop },
        db: h5.db, dbRunAsync: h5.run, dbGetAsync: h5.get, dbAllAsync: h5.all,
        authenticateToken, requireAdmin,
        ...require('./_sys-attach-test-deps'),
      });
      mmod.initSchema();
      await waitReadyOn(mmod._internals);
      let mutantOk = false, mutantErr = null;
      try {
        await h5.run(
          `INSERT INTO sys_release_audit (release_id, release_no, release_json, action, changes_json, executors_json, reason, operator_id, operator_name, member_issue_ids, member_count)
           VALUES (1, 'R-MUT-MC-CONSIST', '{"id":1}', 'edit', '[{"field":"title","old":null,"new":"x"}]', NULL, NULL, 1, '测试员', '[101,102]', 3)`
        );
        mutantOk = true;
      } catch (e) { mutantErr = e; }
      assert.strictEqual(mutantOk, true, `[8] 活体变异应判红（此处"判红"体现为：真实代码会拒绝的 member_count=3∧数组长度=2 INSERT 在变异代码里插入成功）——若仍失败说明变异未生效，实际报错：${mutantErr && mutantErr.message}`);
    } finally {
      try { h5.db.close(); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
    ok('[8] 活体变异通过（476-MED）：摘掉 CHECK (member_count = json_array_length(member_issue_ids)) 子句后，[4n] 判定的"member_count 与数组长度不一致应被拒绝" INSERT 在变异代码里插入成功——证明 [4n] 的拒绝真实依赖这条新子句，不是别的巧合');
  }

  console.log(`\n✅ verify-sys-release-audit-schema 全部通过（${passed} 组）`);
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); process.exit(1); });
