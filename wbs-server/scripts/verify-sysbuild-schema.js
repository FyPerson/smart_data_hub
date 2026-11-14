// 验证脚本：项目管理（系统建设记录）模块结构——建表、约束、索引、就绪合约
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §6；日期 CHECK 口径见 v1.2 §3.0 / §8
//
// 用法：node scripts/verify-sysbuild-schema.js             跑全部用例
//       node scripts/verify-sysbuild-schema.js --self-test 对 routes/sysbuild/schema.js 逐一注入变异，每个变异
//         在子进程里重跑，必须至少一条判红
//
// 夹具：require 真实模块工厂（routes/sysbuild/index.js），依赖用替身，库文件与上传根放进程私有临时目录。
//   约束用例在模块建好的库上用外部连接直接 INSERT（只测 DDL 本身，不经路由）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { spawnSync } = require('child_process');

const MODULE_DIR_DEFAULT = path.join(__dirname, '..', 'routes', 'sysbuild');
const argIdx = process.argv.indexOf('--module-dir');
const MODULE_DIR = argIdx > 0 ? process.argv[argIdx + 1] : MODULE_DIR_DEFAULT;
const SELF_TEST = process.argv.includes('--self-test');

const silentLogger = { info() {}, warn() {}, error() {} };
const pass = (req, res, next) => next();
const tmpDirs = [];
const modules = [];
const extConns = [];

function newRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-schema-'));
  tmpDirs.push(dir);
  return dir;
}
function makeModule(root) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const factory = require(path.join(MODULE_DIR, 'index.js'));
  const m = factory({
    logger: silentLogger, DB_FILE: path.join(root, 'case.db'), authenticateToken: pass,
    UPLOAD_DIR: path.join(root, 'uploads'), normalizeAttachmentExt: (n) => path.extname(n).toLowerCase(),
    safeDeleteFileSync: () => true, COLLAB_ALLOWED_EXTS_UNION: ['.png'], READONLY_LEADER_IDS: [6, 11], WRITE_ALLOWED_ROLES: ['admin', 'publisher', 'user'], enableTestHooks: true, busyTimeoutMs: 300,
    // C6b：工厂新增的两个必需依赖（本脚本只测结构，不触发通知，替身不会被调用）
    dingtalkNotify: { getAccessToken: async () => 'x', getUserIdByMobile: async () => 'x', sendMarkdownToUser: async () => ({}), classifyError: () => ({}) },
    readSystemConfig: async () => null,
  });
  modules.push(m);
  return m;
}
function schemaMod() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(MODULE_DIR, 'schema.js'));
}
function openExt(file) {
  return new Promise((resolve, reject) => {
    const c = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(c)));
    extConns.push(c);
  });
}
const run = (c, sql, p) => new Promise((res, rej) => c.run(sql, p || [], function cb(e) { if (e) rej(e); else res(this); }));
const all = (c, sql, p) => new Promise((res, rej) => c.all(sql, p || [], (e, r) => (e ? rej(e) : res(r))));
async function expectConstraint(c, sql, params, label) {
  let err = null;
  try { await run(c, sql, params); } catch (e) { err = e; }
  assert.ok(err && err.code === 'SQLITE_CONSTRAINT', `${label}: 应被约束拒绝，实际 ${err ? err.message : '成功写入'}`);
}
async function expectOk(c, sql, params, label) {
  try { return await run(c, sql, params); } catch (e) { throw new Error(`${label}: 应写入成功，实际 ${e.message}`); }
}

let shared = null; // 一个建好的库，约束用例共用（各用例用 SAVEPOINT 回滚，互不影响）
async function sharedDb() {
  if (shared) return shared;
  const root = newRoot();
  const m = makeModule(root);
  await m.initSchema();
  assert.strictEqual(m.getReadiness().ready, true, `初始化失败: ${m._internals.db.getState().initError}`);
  const c = await openExt(path.join(root, 'case.db'));
  shared = { root, m, c };
  return shared;
}
async function inSavepoint(c, fn) {
  await run(c, 'SAVEPOINT t');
  try { await fn(); } finally { await run(c, 'ROLLBACK TO t'); await run(c, 'RELEASE t'); }
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// 10 号 M-5：表名与索引名用手写清单全等对拍（不复用被测常量）
const EXPECTED_TABLES = ['sysbuild_projects', 'sysbuild_parties', 'sysbuild_members', 'sysbuild_appointments', 'sysbuild_delegations',
  'sysbuild_invitations', 'sysbuild_batches', 'sysbuild_nodes', 'sysbuild_node_schedule_records', 'sysbuild_modules', 'sysbuild_items',
  'sysbuild_item_versions', 'sysbuild_packages', 'sysbuild_package_versions', 'sysbuild_package_item_revisions', 'sysbuild_materials',
  'sysbuild_material_versions', 'sysbuild_entries', 'sysbuild_entry_items', 'sysbuild_entry_actions', 'sysbuild_changes',
  'sysbuild_confirm_tasks', 'sysbuild_confirm_task_revisions', 'sysbuild_confirmations', 'sysbuild_views', 'sysbuild_golive_events',
  'sysbuild_notices', 'sysbuild_notice_attempts', 'sysbuild_notice_receipts', 'sysbuild_notice_objections', 'sysbuild_comments', 'sysbuild_attachments',
  'sysbuild_attachment_bindings', 'sysbuild_attachment_refs', 'sysbuild_frozen_attachments', 'sysbuild_batch_relations', 'sysbuild_routing_snapshots',
  'sysbuild_history_imports', 'sysbuild_send_intents', 'sysbuild_card_instances', 'sysbuild_guide_state', 'sysbuild_events'];
const EXPECTED_INDEXES = ['idx_sysbuild_projects_pm', 'idx_sysbuild_parties_project', 'uq_sysbuild_parties_one_dev', 'idx_sysbuild_members_project',
  'idx_sysbuild_members_user', 'uq_sysbuild_members_active_user', 'idx_sysbuild_appointments_party', 'uq_sysbuild_appointments_active',
  'idx_sysbuild_delegations_party', 'uq_sysbuild_delegations_active', 'idx_sysbuild_invitations_member', 'uq_sysbuild_batches_seq',
  'uq_sysbuild_batches_default', 'idx_sysbuild_nodes_project', 'uq_sysbuild_nodes_golive', 'idx_sysbuild_schedule_node',
  'uq_sysbuild_schedule_baseline', 'idx_sysbuild_modules_project', 'uq_sysbuild_items_code', 'uq_sysbuild_item_versions_no',
  'idx_sysbuild_packages_project', 'uq_sysbuild_packages_project_single', 'uq_sysbuild_packages_batch_single', 'uq_sysbuild_package_versions_no', 'uq_sysbuild_package_versions_effective',
  'uq_sysbuild_package_versions_pending', 'uq_sysbuild_package_versions_draft', 'uq_sysbuild_modules_name', 'idx_sysbuild_pkg_item_rev_version', 'uq_sysbuild_materials_key', 'uq_sysbuild_material_versions_no',
  'idx_sysbuild_entries_project', 'idx_sysbuild_entries_type', 'idx_sysbuild_entry_items_entry', 'idx_sysbuild_entry_items_item',
  'idx_sysbuild_entry_actions_entry', 'idx_sysbuild_changes_project', 'idx_sysbuild_confirm_tasks_project', 'uq_sysbuild_task_revisions_no',
  'uq_sysbuild_task_revisions_pending', 'idx_sysbuild_task_revisions_member', 'idx_sysbuild_confirmations_revision', 'uq_sysbuild_confirmations_revision',
  'idx_sysbuild_confirmations_object', 'idx_sysbuild_views_user_object', 'idx_sysbuild_golive_batch', 'idx_sysbuild_notices_project',
  'idx_sysbuild_notice_attempts_notice', 'idx_sysbuild_notice_receipts_attempt', 'uq_sysbuild_notice_objections', 'idx_sysbuild_comments_object',
  'idx_sysbuild_attachments_project', 'idx_sysbuild_bindings_owner', 'uq_sysbuild_attachment_refs', 'idx_sysbuild_attachment_refs_owner', 'uq_sysbuild_frozen', 'idx_sysbuild_frozen_attachment',
  'idx_sysbuild_batch_relations_from', 'idx_sysbuild_batch_relations_to', 'idx_sysbuild_routing_part', 'idx_sysbuild_routing_batch',
  'idx_sysbuild_history_imports_project', 'idx_sysbuild_send_intents_status', 'idx_sysbuild_card_instances_revision',
  'idx_sysbuild_events_project', 'idx_sysbuild_events_object', 'uq_sysbuild_changes_package'];

test('真实工厂初始化：表名与索引名与手写清单全等（42 表 / 67 索引）；上传子目录已预建；单飞', async () => {
  const root = newRoot();
  const m = makeModule(root);
  const p1 = m.initSchema();
  assert.strictEqual(m.initSchema(), p1, '两次调用返回同一个 Promise');
  await p1;
  assert.strictEqual(m.getReadiness().ready, true);
  const c = await openExt(path.join(root, 'case.db'));
  const rows = await all(c, "SELECT type, name FROM sqlite_master WHERE name LIKE 'sysbuild\\_%' ESCAPE '\\' OR name LIKE 'idx\\_sysbuild\\_%' ESCAPE '\\' OR name LIKE 'uq\\_sysbuild\\_%' ESCAPE '\\'");
  assert.deepStrictEqual(rows.filter((r) => r.type === 'table').map((r) => r.name).sort(), [...EXPECTED_TABLES].sort(), '表名');
  assert.deepStrictEqual(rows.filter((r) => r.type === 'index').map((r) => r.name).sort(), [...EXPECTED_INDEXES].sort(), '索引名');
  assert.strictEqual(EXPECTED_TABLES.length, 42);
  assert.strictEqual(EXPECTED_INDEXES.length, 67);
  assert.ok(fs.statSync(path.join(root, 'uploads', 'sysbuild')).isDirectory());
});

test('重启：已建库直接核对通过并就绪（第二个工厂实例同一文件）', async () => {
  const { root } = await sharedDb();
  const m2 = makeModule(root);
  await m2.initSchema();
  assert.strictEqual(m2.getReadiness().ready, true, m2._internals.db.getState().initError);
});

test('就绪对抗：同名但缺约束的 sysbuild_projects → 未就绪，错误指出该表', async () => {
  const root = newRoot();
  const c = await openExt(path.join(root, 'case.db'));
  await run(c, 'CREATE TABLE sysbuild_projects (id INTEGER PRIMARY KEY, system_name TEXT)');
  const m = makeModule(root);
  await m.initSchema();
  const st = m._internals.db.getState();
  assert.strictEqual(st.ready, false);
  assert.ok(/sysbuild_projects/.test(st.initError), st.initError);
});

test('就绪对抗：部分唯一索引被改成无 WHERE → 未就绪', async () => {
  const root = newRoot();
  const c = await openExt(path.join(root, 'case.db'));
  const { SCHEMA_OBJECTS } = schemaMod();
  for (const o of SCHEMA_OBJECTS) {
    if (o.name === 'uq_sysbuild_batches_default') await run(c, 'CREATE UNIQUE INDEX uq_sysbuild_batches_default ON sysbuild_batches(project_id)');
    else await run(c, o.sql);
  }
  const m = makeModule(root);
  await m.initSchema();
  assert.ok(/uq_sysbuild_batches_default/.test(m._internals.db.getState().initError || ''));
});

const BAD_DATES = ['2026-02-30', '2025-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-01-00', '2026-1-01', '20260101', '1999-12-31', '2100-01-01', '2026-01-01 '];
const GOOD_DATES = ['2000-01-01', '2099-12-31', '2024-02-29'];
test('日期 CHECK：可空列（projects.initiated_on）负例全拒、正例与 NULL 通过', async () => {
  const { c } = await sharedDb();
  const sql = "INSERT INTO sysbuild_projects(system_name, build_type, pm_user_id, created_by, initiated_on) VALUES ('s','inhouse',1,1,?)";
  await inSavepoint(c, async () => {
    for (const d of BAD_DATES) await expectConstraint(c, sql, [d], `initiated_on=${JSON.stringify(d)}`);
    for (const d of GOOD_DATES) await expectOk(c, sql, [d], `initiated_on=${d}`);
    await expectOk(c, sql, [null], 'initiated_on=NULL');
  });
});

test('日期 CHECK：非空列（history_imports.original_date）负例全拒、NULL 拒绝、正例通过', async () => {
  const { c } = await sharedDb();
  const sql = "INSERT INTO sysbuild_history_imports(project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (1,'node',1,'node_closed','张三','时任负责人',?,1)";
  await inSavepoint(c, async () => {
    for (const d of BAD_DATES) await expectConstraint(c, sql, [d], `original_date=${JSON.stringify(d)}`);
    await expectConstraint(c, sql, [null], 'original_date=NULL');
    for (const d of GOOD_DATES) await expectOk(c, sql, [d], `original_date=${d}`);
  });
});

test('枚举越界与时间戳显式 NULL 被拒；payload_json 非法 JSON 被拒', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    await expectConstraint(c, "INSERT INTO sysbuild_projects(system_name, build_type, pm_user_id, created_by) VALUES ('s','other',1,1)", [], 'build_type 越界');
    await expectConstraint(c, "INSERT INTO sysbuild_projects(system_name, build_type, pm_user_id, created_by, status) VALUES ('s','inhouse',1,1,'done')", [], 'status 越界');
    await expectConstraint(c, "INSERT INTO sysbuild_projects(system_name, build_type, pm_user_id, created_by, created_at) VALUES ('s','inhouse',1,1,NULL)", [], 'created_at NULL');
    await expectConstraint(c, "INSERT INTO sysbuild_events(object_type, event_type, payload_json, operator_id, operator_name) VALUES ('p','x_y','{bad',1,'a')", [], 'payload 非法 JSON');
    await expectConstraint(c, "INSERT INTO sysbuild_events(object_type, event_type, operator_id, operator_name) VALUES ('p','Bad-Type',1,'a')", [], 'event_type 形态');
    await expectOk(c, "INSERT INTO sysbuild_events(object_type, event_type, payload_json, operator_id, operator_name) VALUES ('p','project_created','{\"a\":1}',1,'a')", [], 'event 正例');
    await expectConstraint(c, "INSERT INTO sysbuild_projects(system_name, build_type, pm_user_id, created_by, oa_number) VALUES ('s','inhouse',1,1,'12a')", [], 'OA 号非数字');
  });
});

test('行级约束：成员身份、补充登记天数、无书面证据原因、改期原因、基线引用内容包', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    await expectConstraint(c, 'INSERT INTO sysbuild_members(project_id, added_by) VALUES (1,1)', [], '成员无账号也无姓名');
    await expectOk(c, "INSERT INTO sysbuild_members(project_id, person_name, added_by) VALUES (1,'外部张三',1)", [], '无账号外部人员');
    const entry = "INSERT INTO sysbuild_entries(project_id, type, operator_user_id, operator_identity_snapshot, period, days_after_close, title, body, no_written_evidence, no_evidence_reason) VALUES (1,'issue',1,'{}',?,?,'t','b',?,?)";
    await expectConstraint(c, entry, ['supplement', null, 0, null], '补充登记缺天数');
    await expectConstraint(c, entry, ['process', 3, 0, null], '过程登记带天数');
    await expectConstraint(c, entry, ['process', null, 1, '太短'], '无书面证据原因 <10 字');
    await expectOk(c, entry, ['supplement', 2, 1, '电话沟通，没有会议纪要留存'], '补充登记正例');
    const sch = "INSERT INTO sysbuild_node_schedule_records(node_id, kind, planned_start, planned_end, actual_date, reason, package_version_id, created_by) VALUES (1,?,?,?,?,?,?,1)";
    await expectConstraint(c, sch, ['baseline', '2026-11-01', '2026-11-05', null, null, null], '基线缺内容包版本');
    await expectConstraint(c, sch, ['plan_change', '2026-11-01', '2026-11-05', null, null, null], '改期缺原因');
    await expectConstraint(c, sch, ['plan_change', '2026-11-06', '2026-11-05', null, 'x', null], '计划起晚于止');
    await expectConstraint(c, sch, ['actual_start', null, null, null, null, null], '实际记录缺日期');
    await expectOk(c, sch, ['baseline', '2026-11-01', '2026-11-05', null, null, 7], '基线正例');
  });
});

test('行级约束：确认记录的四种方式', async () => {
  const { c } = await sharedDb();
  const sql = `INSERT INTO sysbuild_confirmations(task_revision_id, object_type, object_version_id, actor_user_id, actual_confirmer, identity_basis, method, decision, checkbox_text, reason, view_id, external_date, proxy_by, card_instance_id, dingtalk_user_id)
    VALUES (?, 'package_version', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await inSavepoint(c, async () => {
    await expectConstraint(c, sql, [1, 9, null, null, 'platform', 'confirm', '我已阅读', null, null, null, null, null, null], '平台确认缺浏览记录');
    await expectOk(c, sql, [1, 9, null, null, 'platform', 'confirm', '我已阅读', null, 5, null, null, null, null], '平台确认正例');
    await expectConstraint(c, sql, [1, 9, null, null, 'platform', 'object', '我已阅读', null, 5, null, null, null, null], '异议缺原因');
    await expectConstraint(c, sql, [3, null, '李四', '时任负责人', 'history', 'confirm', null, null, null, '2025-06-01', 1, null, null], '历史补录挂在当前修订上');
    await expectConstraint(c, sql, [null, null, '李四', '时任负责人', 'history', 'confirm', null, null, null, '2025-06-01', null, null, null], '历史补录缺录入人');
    await expectOk(c, sql, [null, null, '李四', '时任负责人', 'history', 'confirm', null, null, null, '2025-06-01', 1, null, null], '历史补录正例');
    // 反方向（C1b 预筛 M5-A）：非历史补录的确认必须挂在任务修订上
    await expectConstraint(c, sql, [null, 9, null, null, 'platform', 'confirm', '我已阅读', null, 5, null, null, null, null], '平台确认不挂修订');
    await expectConstraint(c, sql, [null, 9, null, null, 'card', 'confirm', null, null, null, null, null, 7, 'ding1'], '卡片确认不挂修订');
    await expectConstraint(c, sql, [null, null, '王五', '授权代表', 'proxy', 'confirm', null, null, null, '2026-10-01', 1, null, null], '代录不挂修订');
    await expectConstraint(c, sql, [2, null, '王五', '授权代表', 'proxy', 'confirm', null, null, null, '2026-10-01', null, null, null], '代录缺代录人');
    await expectConstraint(c, sql, [2, null, '王五', '授权代表', 'proxy', 'confirm', '我已阅读', null, null, '2026-10-01', 1, null, null], '代录生成勾选');
    await expectConstraint(c, sql, [2, 9, null, null, 'card', 'confirm', null, null, null, null, null, null, null], '卡片缺实例与钉钉账号');
  });
});

test('C4a D42 一修订一决策：同一任务修订只能有一条确认记录（部分唯一）；历史补录（修订为空）不受限；不同修订各一条', async () => {
  const { c } = await sharedDb();
  const conf = `INSERT INTO sysbuild_confirmations(task_revision_id, object_type, object_version_id, actor_user_id, actual_confirmer, identity_basis, method, decision, checkbox_text, reason, view_id, external_date, proxy_by)
    VALUES (?, 'package_version', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await inSavepoint(c, async () => {
    await expectOk(c, conf, [101, 9, null, null, 'platform', 'confirm', '我已阅读', null, 5, null, null], '修订 101 的首条确认');
    await expectConstraint(c, conf, [101, 9, null, null, 'platform', 'confirm', '我已阅读', null, 5, null, null], '同一修订第二条同决策');
    await expectConstraint(c, conf, [101, 9, null, null, 'platform', 'object', '我已阅读', '有异议', 5, null, null], '同一修订第二条不同决策');
    await expectOk(c, conf, [102, 9, null, null, 'platform', 'reject', '我已阅读', '不认可', 5, null, null], '修订 102 的首条确认');
    const hist = [null, null, '李四', '时任负责人', 'history', 'confirm', null, null, null, '2025-06-01', 1];
    await expectOk(c, conf, hist, '历史补录第一条（修订为空）');
    await expectOk(c, conf, hist, '历史补录第二条（修订为空，不受唯一限制）');
  });
});

test('部分唯一索引：默认批次 / 上线里程碑 / 待确认修订 / 生效包版本 / 现任负责人 / 开发方 各至多一个', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    await expectOk(c, "INSERT INTO sysbuild_batches(project_id, seq, name, is_default) VALUES (1,1,'默认',1)", [], '默认批次');
    await expectConstraint(c, "INSERT INTO sysbuild_batches(project_id, seq, name, is_default) VALUES (1,2,'又一个默认',1)", [], '第二个默认批次');
    await expectOk(c, "INSERT INTO sysbuild_batches(project_id, seq, name, is_default) VALUES (1,2,'第二批',0)", [], '非默认批次');
    const node = "INSERT INTO sysbuild_nodes(project_id, batch_id, name, sort_order, is_golive_milestone, status) VALUES (1,1,'n',1,?,?)";
    await expectOk(c, node, [1, 'not_started'], '上线里程碑');
    await expectConstraint(c, node, [1, 'not_started'], '同批第二个上线里程碑');
    await expectConstraint(c, "INSERT INTO sysbuild_nodes(project_id, batch_id, name, sort_order, is_golive_milestone, status) VALUES (1,2,'n',1,1,'cancelled')", [], '上线里程碑取消');
    const rev = "INSERT INTO sysbuild_confirm_task_revisions(task_id, rev_no, required_member_id, status, status_reason, created_by) VALUES (1,?,1,?,?,1)";
    await expectOk(c, rev, [1, 'pending', null], '待确认修订');
    await expectConstraint(c, rev, [2, 'pending', null], '同任务第二个待确认修订');
    await expectOk(c, rev, [2, 'superseded', '改发'], '已替代修订');
    const pv = "INSERT INTO sysbuild_package_versions(package_id, version_no, status, effective_at, snapshot_json, created_by) VALUES (1,?,?,?,'{}',1)";
    await expectOk(c, pv, [1, 'effective', '2026-10-28 10:00:00'], '生效版本');
    await expectConstraint(c, pv, [2, 'effective', '2026-10-28 11:00:00'], '同包第二个生效版本');
    await expectConstraint(c, pv, [2, 'draft', '2026-10-28 11:00:00'], '草稿带生效时间');
    const ap = "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at) VALUES (1,?,'active',1,'2026-10-28 10:00:00')";
    await expectOk(c, ap, [1], '现任负责人');
    await expectConstraint(c, ap, [2], '同参与方第二个现任负责人');
    const party = "INSERT INTO sysbuild_parties(project_id, side, name, created_by) VALUES (1,?,?,1)";
    await expectOk(c, party, ['dev', '开发方'], '开发方');
    await expectConstraint(c, party, ['dev', '第二个开发方'], '同项目第二个开发方');
    await expectOk(c, party, ['demand', '人力部'], '需求部门可多个');
    await expectOk(c, party, ['demand', '财务部'], '需求部门可多个');
  });
});

test('C1b 预筛修订：包版本替代 / 任职授权撤回 / 生效代表人唯一 / 改期证据与更正对象 / 项目层不得有上线里程碑', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    // H2：从未生效的待确认版本可以被替代；草稿 / 待确认不得有生效时间；同包至多一个待确认版本
    const pv = "INSERT INTO sysbuild_package_versions(package_id, version_no, status, effective_at, snapshot_json, created_by) VALUES (5,?,?,?,'{}',1)";
    await expectOk(c, pv, [1, 'superseded', null], '待确认版本被替代（无生效时间）');
    await expectOk(c, pv, [2, 'superseded', '2026-10-28 09:00:00'], '曾生效版本被替代');
    await expectOk(c, pv, [3, 'pending', null], '待确认版本');
    await expectConstraint(c, pv, [4, 'pending', null], '同包第二个待确认版本');
    await expectConstraint(c, pv, [4, 'pending', '2026-10-28 09:00:00'], '待确认带生效时间');
    await expectConstraint(c, pv, [4, 'effective', null], '生效缺生效时间');
    // M1：未生效即撤回
    await expectOk(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, end_reason) VALUES (2,1,'withdrawn',1,'邀请撤回')", [], '任职撤回');
    await expectOk(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by) VALUES (2,1,1,'withdrawn',1)", [], '授权撤回');
    // M2：每个参与方至多一位生效代表人
    const dl = "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (3,?,1,'active',1,'2026-10-28 09:00:00')";
    await expectOk(c, dl, [1], '生效代表人');
    await expectConstraint(c, dl, [2], '同参与方第二位生效代表人');
    // M3 / M4：改期记录的无书面证据、实际日期更正的对象
    const sch = "INSERT INTO sysbuild_node_schedule_records(node_id, kind, planned_start, planned_end, actual_date, corrects_kind, reason, package_version_id, no_written_evidence, no_evidence_reason, created_by) VALUES (1,?,?,?,?,?,?,?,?,?,1)";
    await expectConstraint(c, sch, ['plan_change', '2026-11-01', '2026-11-05', null, null, '开发方延期', null, 1, '太短'], '改期无书面证据原因不足 10 字');
    await expectOk(c, sch, ['plan_change', '2026-11-01', '2026-11-05', null, null, '开发方延期', null, 1, '电话沟通，开发方口头提出延期'], '改期无书面证据正例');
    await expectConstraint(c, sch, ['actual_correct', null, null, '2026-11-03', null, '录错', null, 0, null], '更正缺更正对象');
    await expectConstraint(c, sch, ['actual_start', null, null, '2026-11-03', 'actual_end', null, null, 0, null], '非更正带更正对象');
    await expectConstraint(c, sch, ['actual_correct', null, null, '2026-11-03', 'baseline', '录错', null, 0, null], '更正对象越界');
    await expectOk(c, sch, ['actual_correct', null, null, '2026-11-03', 'actual_end', '录错', null, 0, null], '更正正例');
    // M5-C：项目层节点（无批次）不得是上线里程碑
    await expectConstraint(c, "INSERT INTO sysbuild_nodes(project_id, batch_id, name, sort_order, is_golive_milestone) VALUES (1,NULL,'p',1,1)", [], '项目层节点挂上线里程碑');
  });
});

test('C3b 结构：内容包类型与批次、每项目 / 每批唯一索引、包版本 form、附件引用表的唯一与枚举（负例 + 对照正例）', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    const pk = 'INSERT INTO sysbuild_packages(project_id, batch_id, type, created_by) VALUES (?,?,?,1)';
    // D41：类型枚举去掉 overall_batch_req；batch_req / batch_accept 必须挂批次，其余类型的挂批次规则不变
    await expectConstraint(c, pk, [10, null, 'overall_batch_req'], '包类型 overall_batch_req 已不在枚举内');
    await expectConstraint(c, pk, [10, null, 'batch_accept'], 'batch_accept 缺批次');
    await expectConstraint(c, pk, [10, null, 'batch_req'], 'batch_req 缺批次');
    await expectConstraint(c, pk, [10, 5, 'overall'], 'overall 挂了批次');
    await expectOk(c, pk, [10, null, 'change'], 'change 不挂批次');
    await expectOk(c, pk, [10, null, 'change'], 'change 不限个数');
    // 每项目 initiation / overall / closing 各至多一个
    for (const t of ['initiation', 'overall', 'closing']) {
      await expectOk(c, pk, [11, null, t], `${t} 首个`);
      await expectConstraint(c, pk, [11, null, t], `${t} 同项目第二个`);
      await expectOk(c, pk, [12, null, t], `${t} 别的项目可以有`);
    }
    // 每批 batch_req / batch_accept 各至多一个；同批两种类型可并存；不同批互不影响
    await expectOk(c, pk, [13, 21, 'batch_req'], '批次需求包首个');
    await expectConstraint(c, pk, [13, 21, 'batch_req'], '同批第二个批次需求包');
    await expectOk(c, pk, [13, 21, 'batch_accept'], '同批的批次验收包与批次需求包并存');
    await expectConstraint(c, pk, [13, 21, 'batch_accept'], '同批第二个批次验收包');
    await expectOk(c, pk, [13, 22, 'batch_accept'], '别的批次的验收包');
    // 包版本 form：只能是 overall / overall_batch_req 或空
    //   （同包至多一个草稿，所以只有版本 1 是草稿，其余版本用已替代状态）
    const pv = "INSERT INTO sysbuild_package_versions(package_id, version_no, form, status, snapshot_json, created_by) VALUES (30,?,?,?,'{}',1)";
    await expectConstraint(c, pv, [1, 'bogus', 'draft'], 'form 越界');
    await expectConstraint(c, pv, [1, '', 'draft'], 'form 空串');
    await expectOk(c, pv, [1, 'overall', 'draft'], 'form=overall');
    await expectOk(c, pv, [2, 'overall_batch_req', 'superseded'], 'form=overall_batch_req');
    await expectOk(c, pv, [3, null, 'superseded'], 'form 为空');
    // 预筛可选加固：每个包同一时刻至多一个草稿版本；模块名项目内唯一（大小写敏感）
    await expectConstraint(c, pv, [4, null, 'draft'], '同包第二个草稿版本');
    await expectOk(c, "INSERT INTO sysbuild_package_versions(package_id, version_no, status, snapshot_json, created_by) VALUES (31,1,'draft','{}',1)", [], '别的包可以有自己的草稿');
    await expectOk(c, pv, [5, null, 'pending'], '待确认版本不占草稿名额');
    const md = 'INSERT INTO sysbuild_modules(project_id, name, created_by) VALUES (?,?,1)';
    await expectOk(c, md, [40, '财务模块'], '模块首个');
    await expectConstraint(c, md, [40, '财务模块'], '同项目同名模块');
    await expectOk(c, md, [41, '财务模块'], '别的项目同名模块');
    await expectOk(c, md, [40, '财务模块2'], '同项目不同名');
    await expectOk(c, md, [40, 'Abc'], '大小写敏感：Abc');
    await expectOk(c, md, [40, 'abc'], '大小写敏感：abc 与 Abc 不同名');
    // 附件引用：同一附件对同一对象至多一条；owner_type 在绑定枚举内
    const ref = 'INSERT INTO sysbuild_attachment_refs(project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (1,?,?,?,1)';
    await expectOk(c, ref, [90, 'item_version', 7], '引用首条');
    await expectConstraint(c, ref, [90, 'item_version', 7], '同一附件对同一对象第二条引用');
    await expectOk(c, ref, [90, 'item_version', 8], '同一附件引用另一对象');
    await expectOk(c, ref, [91, 'item_version', 7], '另一附件引用同一对象');
    await expectOk(c, ref, [90, 'material_version', 7], '同一附件、同号不同类型的对象');
    await expectConstraint(c, ref, [92, 'bogus_owner', 7], '引用的 owner_type 越界');
    await expectConstraint(c, 'INSERT INTO sysbuild_attachment_refs(project_id, attachment_id, owner_type, owner_id) VALUES (1,93,\'item_version\',9)', [], '引用缺 ref_by');
  });
});

// M5-B：可更新列与枚举用手写期望表全等对拍（不复用被测常量；被测改了必须同步改这里）
const EXPECTED_UPDATABLE = {
  sysbuild_projects: ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on', 'pm_user_id', 'status', 'history_window', 'updated_at'], // C3a：build_type 移出（方案 v1.2 D44）
  sysbuild_parties: ['name'],
  sysbuild_members: ['joined_at', 'removed_at', 'removed_reason'],
  sysbuild_appointments: ['status', 'effective_at', 'ended_at', 'end_reason'],
  sysbuild_delegations: ['status', 'effective_at', 'revoked_at', 'revoke_reason'],
  sysbuild_invitations: ['status', 'responded_at'],
  sysbuild_batches: ['status', 'name', 'superseded_by', 'transfer_change_id', 'dev_assignee_member_id'],
  sysbuild_nodes: ['name', 'sort_order', 'status', 'opened_at', 'closed_at', 'updated_at'],
  sysbuild_modules: ['name'],
  sysbuild_items: ['module_id'],
  sysbuild_item_versions: ['proposer_status', 'deny_reason'],
  sysbuild_package_versions: ['status', 'effective_at', 'snapshot_json', 'form', 'parent_overall_version_id', 'updated_at'], // C4a 修订批 P32：form / parent 提交时重算回写
  sysbuild_changes: ['status', 'package_version_id', 'updated_at'],
  sysbuild_confirm_task_revisions: ['status', 'status_reason', 'updated_at'],
  sysbuild_comments: ['upgraded_entry_id', 'voided_at', 'void_reason'],
  sysbuild_attachments: ['deleted_at', 'deleted_by', 'masked_at', 'masked_by', 'mask_reason'],
  sysbuild_send_intents: ['status', 'attempts', 'last_error', 'updated_at'],
  sysbuild_card_instances: ['status'],
};
// 10 号 M-5：枚举按值集合全等（同数量替换也能检出）
const EXPECTED_ENUMS = {
  buildType: ['outsource', 'procurement', 'inhouse'],
  projectStatus: ['active', 'paused', 'terminated', 'closed'],
  historyWindow: ['never', 'open', 'closed'],
  partySide: ['demand', 'dev'],
  appointmentStatus: ['pending', 'active', 'rejected', 'ended', 'withdrawn'],
  delegationStatus: ['pending_owner', 'pending_accept', 'active', 'rejected', 'revoked', 'withdrawn'],
  invitationKind: ['join', 'appointment'],
  invitationStatus: ['pending', 'accepted', 'declined', 'withdrawn'],
  batchStatus: ['planning', 'active', 'live', 'transferred', 'superseded'],
  nodeStatus: ['not_started', 'in_progress', 'closed', 'cancelled'],
  scheduleKind: ['baseline', 'plan_change', 'actual_start', 'actual_end', 'actual_correct'],
  proposerStatus: ['pending', 'confirmed', 'proxy_confirmed', 'denied'],
  packageType: ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing'], // C3b：方案 v1.2 D41 去掉 overall_batch_req
  packageForm: ['overall', 'overall_batch_req'], // C3b：包版本形态（只在总体规划包的版本上填写）
  packageVersionStatus: ['draft', 'pending', 'effective', 'superseded'],
  itemRevisionOp: ['add', 'remove'],
  entryType: ['note', 'material', 'lesson', 'benefit', 'correction', 'feedback', 'issue'],
  entryPurpose: ['general', 'dev_note', 'deliverable'],
  commitmentFlagSource: ['submitter', 'pm'],
  entryPeriod: ['process', 'supplement'],
  entryAction: ['conclude', 'for_reference', 'correct', 'void', 'link_change', 'link_sys_issue', 'assign_items', 'split', 'escalate', 'mark_commitment', 'adjudicate', 'unmark_commitment', 'mark_risk', 'unmark_risk'],
  conclusionKind: ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'no_further', 'project_terminated'],
  basisKind: ['dev_note_version', 'pm_verify'],
  changeStatus: ['draft', 'pending', 'effective', 'withdrawn'],
  confirmObjectType: ['package_version', 'item_version', 'invitation', 'delegation', 'dev_entry', 'conclusion', 'adjudication', 'handover'],
  confirmPurpose: ['package_confirm', 'proposer_confirm', 'accept_invitation', 'delegation_grant', 'delegation_accept', 'dev_key_confirm', 'conclusion_confirm', 'adjudicate', 'handover_accept', 'handover_accept_issue', 'handover_no_further'], // C6a：交接确认两种用途
  revisionStatus: ['pending', 'confirmed', 'objected', 'rejected', 'invalid', 'superseded'],
  confirmMethod: ['platform', 'card', 'proxy', 'history'],
  confirmDecision: ['confirm', 'object', 'reject'],
  viewSource: ['page', 'self_submit', 'card_render'],
  goliveKind: ['golive', 'revoke', 'regolive'],
  noticeKind: ['schedule_change', 'for_reference'],
  noticeChannel: ['dingtalk', 'platform'],
  noticeResult: ['sent', 'failed'],
  readStatus: ['unknown', 'read', 'unread'],
  commentObjectType: ['entry', 'item', 'package_version', 'node'],
  bindingOwnerType: ['entry', 'item_version', 'material_version', 'confirmation', 'change', 'golive_event', 'history_import', 'comment', 'schedule_record', 'package_version', 'event'],
  frozenObjectType: ['package_version', 'item_version', 'entry', 'material_version', 'change'],
  batchRelationKind: ['split', 'merge', 'replace', 'transfer'],
  route: ['project', 'sys_iteration', 'pending'],
  routingBasis: ['in_plan', 'planned_detail', 'out_of_plan', 'undetermined'], // C5 S-S1b D39：判定依据类别
  noticeObjectionMode: ['return_to_handling', 'supplement_entry', 'to_pm'], // C5 S-S1b：知会异议的处理方式；C6b 加 to_pm（改期知会转 PM，不带异议登记）
  historyFactType: ['appointment', 'delegation', 'package_effective', 'node_closed', 'golive'],
  sendIntentStatus: ['pending', 'sent', 'failed'],
  cardStatus: ['sent', 'updated', 'expired'],
};
const EXPECTED_CONDITIONAL = {
  sysbuild_package_versions: { snapshot_json: "status = 'draft'", form: "status = 'draft'", parent_overall_version_id: "status = 'draft'" }, // C4a 修订批 P32：form / parent 只在草稿条件下回写
  sysbuild_members: { joined_at: 'joined_at IS NULL' },
  // C4a：提出人状态与任务修订终态都只从「待确认」转入
  sysbuild_item_versions: { proposer_status: "proposer_status = 'pending'", deny_reason: "proposer_status = 'pending'" },
  sysbuild_confirm_task_revisions: { status: "status = 'pending'", status_reason: "status = 'pending'" },
  sysbuild_batches: { status: 'status = ?' }, // C4a 修订批三 M-1 / C6a：批次状态转移（规划中 → 进行中、进行中 ↔ 已上线）WHERE 都带旧值条件，旧值作参数传入
  sysbuild_projects: { history_window: 'history_window = ?' }, // C4b Q-S2：历史补录窗口三态转移都带旧值条件（history.js 一处写）
  sysbuild_send_intents: { status: 'status = ?' }, // C6b：发送意图状态转移（notify.js 记发送结果一处写）都带旧值条件，旧值作参数传入
};
test('可更新列登记表与手写期望表全等；枚举按值全等；条件更新合约全等', async () => {
  const { UPDATABLE_COLUMNS, ENUMS, CONDITIONAL_UPDATES } = schemaMod();
  assert.deepStrictEqual(Object.keys(UPDATABLE_COLUMNS).sort(), Object.keys(EXPECTED_UPDATABLE).sort(), '登记的表');
  for (const [t, cols] of Object.entries(EXPECTED_UPDATABLE)) {
    assert.deepStrictEqual([...UPDATABLE_COLUMNS[t]].sort(), [...cols].sort(), `${t} 可更新列`);
  }
  assert.deepStrictEqual(Object.keys(ENUMS).sort(), Object.keys(EXPECTED_ENUMS).sort(), '枚举名');
  for (const [k, vals] of Object.entries(EXPECTED_ENUMS)) assert.deepStrictEqual([...ENUMS[k]].sort(), [...vals].sort(), `枚举 ${k} 的值`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(CONDITIONAL_UPDATES)), EXPECTED_CONDITIONAL, '条件更新合约');
  for (const [t, cols] of Object.entries(EXPECTED_CONDITIONAL)) {
    for (const col of Object.keys(cols)) assert.ok(UPDATABLE_COLUMNS[t].includes(col), `${t}.${col} 须同时在可更新列里`);
  }
});

test('10 号修订：确认任务必绑版本、无版本对象版本号 = 对象号、撤回状态无生效时间、已读回执独立成表', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    const ct = "INSERT INTO sysbuild_confirm_tasks(project_id, object_type, object_id, object_version_id, purpose, created_by) VALUES (1,?,?,?,?,1)";
    await expectConstraint(c, ct, ['package_version', 1, null, 'package_confirm'], '确认任务缺版本');
    await expectConstraint(c, ct, ['invitation', 5, 6, 'accept_invitation'], '邀请的版本号不等于对象号');
    await expectOk(c, ct, ['invitation', 5, 5, 'accept_invitation'], '邀请正例');
    await expectOk(c, ct, ['package_version', 1, 3, 'package_confirm'], '内容包正例');
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at) VALUES (9,1,'withdrawn',1,'2026-10-28 09:00:00')", [], '任职撤回带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at) VALUES (9,1,'pending',1,'2026-10-28 09:00:00')", [], '任职待接受带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (9,1,1,'withdrawn',1,'2026-10-28 09:00:00')", [], '授权撤回带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (9,1,1,'rejected',1,'2026-10-28 09:00:00')", [], '授权拒绝带生效时间');
    await expectOk(c, "INSERT INTO sysbuild_notice_receipts(attempt_id, read_status) VALUES (1,'read')", [], '已读回执');
    await expectConstraint(c, "INSERT INTO sysbuild_notice_receipts(attempt_id, read_status) VALUES (1,'seen')", [], '回执状态越界');
    await expectOk(c, "INSERT INTO sysbuild_attachment_bindings(attachment_id, owner_type, owner_id, bound_by) VALUES (88,'event',3,1)", [], '凭据挂在事件上');
  });
});

test('C5 知会异议表：原因非空白、同一知会至多一条异议（唯一索引）、办理动作枚举含 D43 新增三项', async () => {
  const { c } = await sharedDb();
  const ins = "INSERT INTO sysbuild_notice_objections(notice_id, actor_user_id, member_id, reason, mode) VALUES (?, 1, 1, ?, 'return_to_handling')";
  await inSavepoint(c, async () => {
    await expectConstraint(c, ins, [501, '   '], '异议原因空白');
    await expectOk(c, ins, [501, '界面意见不是无实质内容'], '异议正例');
    await expectConstraint(c, ins, [501, '再异议一次'], '同一知会重复异议');
    await expectOk(c, ins, [502, '另一条知会'], '另一条知会可以异议');
    for (const a of ['unmark_commitment', 'mark_risk', 'unmark_risk', 'mark_commitment']) {
      await expectOk(c, 'INSERT INTO sysbuild_entry_actions(entry_id, action, created_by) VALUES (9, ?, 1)', [a], `办理动作 ${a}`);
    }
    await expectConstraint(c, 'INSERT INTO sysbuild_entry_actions(entry_id, action, created_by) VALUES (9, ?, 1)', ['bogus_action'], '办理动作越界');
  });
});

test('C5 S-S1b 判定快照按类别分支 CHECK（D39）、知会异议处理方式与异议登记引用、登记的拆分来源与异议对象互斥', async () => {
  const { c } = await sharedDb();
  const snap = "INSERT INTO sysbuild_routing_snapshots(entry_id, part_no, overall_package_version_id, item_version_id, committed_batch_id, golive_event_id, route, basis_category) VALUES (1, 1, ?, ?, ?, ?, ?, ?)";
  await inSavepoint(c, async () => {
    // 尚未判定：route = pending ⇔ basis_category = undetermined，判定列全空
    await expectOk(c, snap, [null, null, null, null, 'pending', 'undetermined'], '尚未判定正例');
    await expectConstraint(c, snap, [null, null, null, null, 'pending', 'in_plan'], 'pending 配 in_plan');
    await expectConstraint(c, snap, [null, null, null, null, 'project', 'undetermined'], 'undetermined 配 project');
    await expectConstraint(c, snap, [7, null, null, null, 'pending', 'undetermined'], '尚未判定带总体包版本');
    await expectConstraint(c, snap, [null, 8, null, null, 'pending', 'undetermined'], '尚未判定带条目版本');
    await expectConstraint(c, snap, [null, null, 9, null, 'pending', 'undetermined'], '尚未判定带承诺批次');
    await expectConstraint(c, snap, [null, null, null, 5, 'pending', 'undetermined'], '尚未判定带上线事件');
    // 已生效规划内：总体包版本、条目版本必填；去向留项目须有承诺批次，转系统迭代须有上线事件
    await expectOk(c, snap, [7, 8, 9, null, 'project', 'in_plan'], '规划内留项目正例');
    await expectOk(c, snap, [7, 8, 9, 5, 'sys_iteration', 'in_plan'], '规划内转系统迭代正例');
    await expectConstraint(c, snap, [null, 8, 9, null, 'project', 'in_plan'], '规划内缺总体包版本');
    await expectConstraint(c, snap, [7, null, 9, null, 'project', 'in_plan'], '规划内缺条目版本');
    await expectConstraint(c, snap, [7, 8, null, null, 'project', 'in_plan'], '规划内留项目缺承诺批次');
    await expectConstraint(c, snap, [7, 8, 9, null, 'sys_iteration', 'in_plan'], '规划内转系统迭代缺上线事件');
    // 规划内待细化：须有条目版本，去向只能是留项目；允许没有生效总体包
    await expectOk(c, snap, [null, 8, null, null, 'project', 'planned_detail'], '待细化正例（无总体包）');
    await expectConstraint(c, snap, [null, null, null, null, 'project', 'planned_detail'], '待细化缺条目版本');
    await expectConstraint(c, snap, [null, 8, null, null, 'sys_iteration', 'planned_detail'], '待细化转系统迭代');
    // 规划外：不带条目版本，去向是转系统迭代或留项目；允许没有条目与上线事件
    await expectOk(c, snap, [null, null, null, null, 'sys_iteration', 'out_of_plan'], '规划外转系统迭代正例（无上线事件）');
    await expectOk(c, snap, [null, null, null, null, 'project', 'out_of_plan'], '规划外留项目正例');
    await expectConstraint(c, snap, [null, 8, null, null, 'project', 'out_of_plan'], '规划外带条目版本');
    await expectConstraint(c, snap, [null, null, null, null, 'pending', 'out_of_plan'], '规划外 pending');
    await expectConstraint(c, snap, [null, null, null, null, 'project', 'bogus'], '判定依据类别越界');
    await expectConstraint(c, "INSERT INTO sysbuild_routing_snapshots(entry_id, part_no, route, basis_category) VALUES (1, 1, 'pending', NULL)", [], '判定依据类别缺失');
    // 知会异议：处理方式二选一；supplement_entry 必有异议登记引用，return_to_handling 不带
    const obj = 'INSERT INTO sysbuild_notice_objections(notice_id, actor_user_id, member_id, reason, mode, objection_entry_id) VALUES (?, 1, 1, ?, ?, ?)';
    await expectOk(c, obj, [601, '回到办理', 'return_to_handling', null], '回到办理正例');
    await expectOk(c, obj, [602, '收口后异议', 'supplement_entry', 55], '生成补充登记正例');
    await expectConstraint(c, obj, [603, '缺引用', 'supplement_entry', null], 'supplement_entry 缺异议登记');
    await expectConstraint(c, obj, [604, '多余引用', 'return_to_handling', 56], 'return_to_handling 带异议登记');
    await expectConstraint(c, obj, [605, '越界', 'bogus', null], '处理方式越界');
    // C6b：改期知会异议转 PM（to_pm）不带异议登记；带引用则被「supplement_entry ⇔ 有登记」的 CHECK 拒绝
    await expectOk(c, obj, [607, '改期知会异议', 'to_pm', null], 'C6b to_pm 正例');
    await expectConstraint(c, obj, [608, '多余引用', 'to_pm', 57], 'C6b to_pm 带异议登记');
    await expectConstraint(c, "INSERT INTO sysbuild_notice_objections(notice_id, actor_user_id, member_id, reason) VALUES (606, 1, 1, '缺处理方式')", [], '处理方式必填');
    // 登记：拆分来源（parent_entry_id）、异议对象（objects_entry_id）、修订来源（revision_of_entry_id，C5 S-S1c）三者至多一个非空
    const entry = "INSERT INTO sysbuild_entries(project_id, type, operator_user_id, operator_identity_snapshot, period, title, body, parent_entry_id, objects_entry_id, revision_of_entry_id) VALUES (1,'issue',1,'{}','process','t','b',?,?,?)";
    await expectOk(c, entry, [null, null, null], '都空');
    await expectOk(c, entry, [5, null, null], '只有拆分来源');
    await expectOk(c, entry, [null, 6, null], '只有异议对象');
    await expectOk(c, entry, [null, null, 7], '只有修订来源');
    await expectConstraint(c, entry, [5, 6, null], '拆分来源与异议对象并存');
    await expectConstraint(c, entry, [5, null, 7], '拆分来源与修订来源并存');
    await expectConstraint(c, entry, [null, 6, 7], '异议对象与修订来源并存');
    await expectConstraint(c, entry, [5, 6, 7], '三者并存');
  });
});

test('C5 S-S1c 结构：办理记录的变更号只用于 conclude / link_change、转正式变更必带、挂靠变更必带；变更包一对一（唯一索引）', async () => {
  const { c } = await sharedDb();
  const act = 'INSERT INTO sysbuild_entry_actions(entry_id, action, conclusion_kind, change_id, created_by) VALUES (9, ?, ?, ?, 1)';
  const chg = 'INSERT INTO sysbuild_changes(project_id, package_id, title, body, affects_json, created_by) VALUES (1, ?, \'t\', \'b\', \'{}\', 1)';
  await inSavepoint(c, async () => {
    await expectOk(c, act, ['conclude', 'to_change', 3], '转正式变更结论带变更号');
    await expectConstraint(c, act, ['conclude', 'to_change', null], '转正式变更结论缺变更号');
    await expectConstraint(c, act, ['conclude', 'handled', 3], '非转变更结论带变更号');
    await expectOk(c, act, ['conclude', 'handled', null], '普通结论不带变更号');
    await expectOk(c, act, ['link_change', null, 3], '挂靠变更带变更号');
    await expectConstraint(c, act, ['link_change', null, null], '挂靠变更缺变更号');
    await expectConstraint(c, act, ['correct', null, 3], '更正带变更号');
    await expectConstraint(c, act, ['for_reference', null, 3], '仅供参考带变更号');
    await expectOk(c, chg, [41], '变更正例');
    await expectConstraint(c, chg, [41], '同一变更包对应两条变更');
    await expectOk(c, chg, [42], '另一个变更包可以有自己的变更');
    await expectConstraint(c, "INSERT INTO sysbuild_changes(project_id, title, body, affects_json, created_by) VALUES (1, 't', 'b', '{}', 1)", [], '变更缺变更包编号');
  });
});

test('附件：SHA-256 形态、文件名唯一、一个附件只能绑定一次、遮蔽必须写原因', async () => {
  const { c } = await sharedDb();
  const sha = 'a'.repeat(64);
  const att = 'INSERT INTO sysbuild_attachments(project_id, file_name, original_name, size, sha256, uploaded_by) VALUES (1,?,?,1,?,1)';
  await inSavepoint(c, async () => {
    await expectConstraint(c, att, ['f1', 'a.png', 'A'.repeat(64)], 'SHA 大写');
    await expectConstraint(c, att, ['f1', 'a.png', 'a'.repeat(63)], 'SHA 长度');
    const r = await expectOk(c, att, ['f1', 'a.png', sha], '附件正例');
    await expectConstraint(c, att, ['f1', 'b.png', sha], '文件名重复');
    await expectOk(c, "INSERT INTO sysbuild_attachment_bindings(attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'entry', 1, 1)", [r.lastID], '绑定');
    await expectConstraint(c, "INSERT INTO sysbuild_attachment_bindings(attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'entry', 2, 1)", [r.lastID], '重复绑定');
    await expectConstraint(c, "UPDATE sysbuild_attachments SET masked_at = '2026-10-28 10:00:00', masked_by = 1 WHERE id = ?", [r.lastID], '遮蔽缺原因');
  });
});

test('可更新列登记表：每张登记表与每一列都真实存在', async () => {
  const { c } = await sharedDb();
  const { UPDATABLE_COLUMNS, TABLE_NAMES } = schemaMod();
  for (const [table, cols] of Object.entries(UPDATABLE_COLUMNS)) {
    assert.ok(TABLE_NAMES.includes(table), `登记了不存在的表 ${table}`);
    const info = await all(c, `PRAGMA table_info(${table})`);
    const names = info.map((r) => r.name);
    for (const col of cols) assert.ok(names.includes(col), `${table}.${col} 不存在`);
  }
});

async function runAll() {
  let failed = 0;
  for (const t of cases) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  ✗ ${t.name}\n      ${e && e.message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  return failed;
}

async function cleanup() {
  for (const c of extConns) await new Promise((res) => c.close(() => res()));
  for (const m of modules) {
    const conn = m._internals.db.getConnForTest && m._internals.db.getConnForTest();
    if (conn) await new Promise((res) => sqlite3.Database.prototype.close.call(conn, () => res()));
  }
  for (const dir of tmpDirs) removeTree(dir);
}
function removeTree(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) removeTree(path.join(p, f));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  } catch (e) {
    console.error(`  [清理] 未删除（保留现场）: ${p} — ${e.message}`);
  }
}

// 每个变异登记 expect = 期望变红的用例名前缀；只有该用例确实变红才算检出（C1b 预筛 M5）。
const MUTATIONS = [
  { id: '日期 CHECK 去掉 date() 非空', expect: '日期 CHECK', from: " AND date(${col},'+0 days') IS NOT NULL", to: '' },
  { id: '日期 CHECK 去掉范围', expect: '日期 CHECK', from: " AND ${col} BETWEEN '2000-01-01' AND '2099-12-31'", to: '' },
  { id: '默认批次唯一索引去掉 WHERE', expect: '部分唯一索引', from: "['uq_sysbuild_batches_default', 'sysbuild_batches(project_id) WHERE is_default = 1', true]", to: "['uq_sysbuild_batches_default', 'sysbuild_batches(project_id, is_default)', false]" },
  { id: '待确认修订唯一性去掉', expect: '部分唯一索引', from: "['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \\'pending\\'', true]", to: "['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \\'pending\\'', false]" },
  { id: '历史补录可挂当前修订', expect: '行级约束：确认记录', from: "    CHECK ((method = 'history') = (task_revision_id IS NULL)),\n", to: '' },
  { id: '非历史补录可不挂修订（单向）', expect: '行级约束：确认记录', from: "    CHECK ((method = 'history') = (task_revision_id IS NULL)),", to: "    CHECK (method <> 'history' OR task_revision_id IS NULL)," },
  { id: '历史补录可不填录入人', expect: '行级约束：确认记录', from: "    CHECK (method NOT IN ('proxy','history') OR proxy_by IS NOT NULL),", to: "    CHECK (method <> 'proxy' OR proxy_by IS NOT NULL)," },
  { id: '补充登记天数约束去掉', expect: '行级约束：成员身份', from: "    CHECK ((period = 'supplement') = (days_after_close IS NOT NULL)),\n", to: '' },
  { id: '附件可重复绑定', expect: '附件：', from: '    attachment_id INTEGER NOT NULL UNIQUE,', to: '    attachment_id INTEGER NOT NULL,' },
  { id: '可更新列登记不存在的列', expect: '可更新列登记表', from: "  sysbuild_modules: ['name'],", to: "  sysbuild_modules: ['name', 'no_such_col']," },
  { id: '条目版本可更新业务内容列', expect: '可更新列登记表与手写', from: "  sysbuild_item_versions: ['proposer_status', 'deny_reason'],", to: "  sysbuild_item_versions: ['proposer_status', 'deny_reason', 'content']," },
  { id: '时间戳允许 NULL', expect: '枚举越界与时间戳', from: `const TS = "DATETIME NOT NULL DEFAULT (datetime('now','localtime'))";`, to: `const TS = "DATETIME DEFAULT (datetime('now','localtime'))";` },
  { id: '项目层节点可挂上线里程碑', expect: 'C1b 预筛修订', from: "    CHECK (is_golive_milestone = 0 OR (batch_id IS NOT NULL AND status <> 'cancelled')),", to: "    CHECK (is_golive_milestone = 0 OR status <> 'cancelled')," },
  { id: '待确认版本不能被替代（旧 CHECK）', expect: 'C1b 预筛修订', from: "    CHECK (status <> 'effective' OR effective_at IS NOT NULL),", to: "    CHECK (status NOT IN ('effective','superseded') OR effective_at IS NOT NULL)," },
  { id: '同包可有多个待确认版本', expect: 'C1b 预筛修订', from: "['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \\'pending\\'', true]", to: "['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \\'pending\\'', false]" },
  { id: '同参与方可有多位生效代表人', expect: 'C1b 预筛修订', from: "['uq_sysbuild_delegations_active', 'sysbuild_delegations(party_id) WHERE status = \\'active\\'', true]", to: "['uq_sysbuild_delegations_active', 'sysbuild_delegations(party_id) WHERE status = \\'active\\'', false]" },
  { id: '任职无撤回状态', expect: 'C1b 预筛修订', from: "  appointmentStatus: ['pending', 'active', 'rejected', 'ended', 'withdrawn'],", to: "  appointmentStatus: ['pending', 'active', 'rejected', 'ended']," },
  { id: '改期无书面证据不校验原因', expect: 'C1b 预筛修订', from: "    CHECK (corrects_kind IS NULL OR corrects_kind IN ('actual_start','actual_end')),\n    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))", to: "    CHECK (corrects_kind IS NULL OR corrects_kind IN ('actual_start','actual_end'))" },
  { id: '实际日期更正可不指明对象', expect: 'C1b 预筛修订', from: "    CHECK ((kind = 'actual_correct') = (corrects_kind IS NOT NULL)),\n", to: '' },
  { id: '枚举同数量替换（read→seen）', expect: '可更新列登记表与手写', from: "  readStatus: ['unknown', 'read', 'unread'],", to: "  readStatus: ['unknown', 'seen', 'unread']," },
  { id: '索引改名', expect: '真实工厂初始化', from: "['idx_sysbuild_notice_receipts_attempt', 'sysbuild_notice_receipts(attempt_id, id)'],", to: "['idx_sysbuild_notice_receipts_att', 'sysbuild_notice_receipts(attempt_id, id)']," },
  { id: '确认任务版本可空', expect: '10 号修订', from: '    object_version_id INTEGER NOT NULL,\n    purpose TEXT NOT NULL', to: '    object_version_id INTEGER,\n    purpose TEXT NOT NULL' },
  { id: '无版本对象版本号不校验', expect: '10 号修订', from: ",\n    CHECK (object_type NOT IN ('invitation','delegation') OR object_version_id = object_id)", to: '' },
  { id: '任职撤回可带生效时间', expect: '10 号修订', from: "    CHECK (status IN ('active','ended') OR effective_at IS NULL),\n", to: '' },
  { id: '条件更新合约放宽', expect: '可更新列登记表与手写', from: "snapshot_json: \"status = 'draft'\"", to: 'snapshot_json: "1 = 1"' },
  { id: 'C3b batch_accept 可不挂批次（CHECK 只剩 batch_req）', expect: 'C3b 结构', from: "CHECK (type NOT IN ('batch_req','batch_accept') OR batch_id IS NOT NULL),", to: "CHECK (type NOT IN ('batch_req') OR batch_id IS NOT NULL)," },
  { id: 'C3b batch_req 可不挂批次（CHECK 只剩 batch_accept）', expect: 'C3b 结构', from: "CHECK (type NOT IN ('batch_req','batch_accept') OR batch_id IS NOT NULL),", to: "CHECK (type NOT IN ('batch_accept') OR batch_id IS NOT NULL)," },
  { id: 'C3b 包类型枚举恢复 overall_batch_req', expect: 'C3b 结构', from: "  packageType: ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing'],", to: "  packageType: ['initiation', 'overall', 'batch_req', 'overall_batch_req', 'batch_accept', 'change', 'closing']," },
  { id: 'C3b 包类型枚举同数量替换（change→chg）', expect: '可更新列登记表与手写', from: "  packageType: ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing'],", to: "  packageType: ['initiation', 'overall', 'batch_req', 'batch_accept', 'chg', 'closing']," },
  { id: 'C3b 每项目唯一索引漏掉 closing', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'initiation\\',\\'overall\\')', true]" },
  { id: 'C3b 每项目唯一索引漏掉 initiation', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'overall\\',\\'closing\\')', true]" },
  { id: 'C3b 每项目唯一索引改成非唯一', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', false]" },
  { id: 'C3b 每批唯一索引漏掉 batch_accept', expect: 'C3b 结构', from: "WHERE type IN (\\'batch_req\\',\\'batch_accept\\')', true]", to: "WHERE type IN (\\'batch_req\\')', true]" },
  { id: 'C3b 每批唯一索引不含类型列（同批两种类型不能并存）', expect: 'C3b 结构', from: "['uq_sysbuild_packages_batch_single', 'sysbuild_packages(batch_id, type) WHERE", to: "['uq_sysbuild_packages_batch_single', 'sysbuild_packages(batch_id) WHERE" },
  { id: 'C3b 包版本 form 无 CHECK', expect: 'C3b 结构', from: "    form TEXT ${inList('form', E.packageForm, true)},", to: '    form TEXT,' },
  { id: 'C3b form 枚举同数量替换', expect: '可更新列登记表与手写', from: "  packageForm: ['overall', 'overall_batch_req'],", to: "  packageForm: ['overall', 'overall_batch'],", },
  { id: 'C3b 附件引用唯一索引改成非唯一', expect: 'C3b 结构', from: "['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true]", to: "['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', false]" },
  { id: 'C3b 附件引用唯一索引漏掉 owner_type', expect: 'C3b 结构', from: "'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true]", to: "'sysbuild_attachment_refs(attachment_id, owner_id)', true]" },
  { id: 'C3b 附件引用 owner_type 无枚举 CHECK', expect: 'C3b 结构', from: "    owner_type TEXT NOT NULL ${inList('owner_type', E.bindingOwnerType)},\n    owner_id INTEGER NOT NULL,\n    ref_by INTEGER NOT NULL,", to: '    owner_type TEXT NOT NULL,\n    owner_id INTEGER NOT NULL,\n    ref_by INTEGER NOT NULL,' },
  { id: 'C3b 草稿版本唯一索引改成非唯一', expect: 'C3b 结构', from: "['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', false]" },
  { id: 'C3b 草稿版本唯一索引把待确认也算进去', expect: 'C3b 结构', from: "'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "'sysbuild_package_versions(package_id) WHERE status IN (\\'draft\\',\\'pending\\')', true]" },
  { id: 'C3b 草稿版本唯一索引不看状态（所有版本互斥）', expect: 'C3b 结构', from: "'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "'sysbuild_package_versions(package_id) WHERE version_no >= 1', true]" },
  { id: 'C3b 模块名唯一索引改成非唯一', expect: 'C3b 结构', from: "['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, name)', true]", to: "['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, name)', false]" },
  { id: 'C3b 模块名唯一索引不含项目（跨项目也不能同名）', expect: 'C3b 结构', from: "['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, name)', true]", to: "['uq_sysbuild_modules_name', 'sysbuild_modules(name)', true]" },
  { id: 'C3b 模块名唯一索引忽略大小写', expect: 'C3b 结构', from: "['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, name)', true]", to: "['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, lower(name))', true]" },
  { id: 'C4a D42 一修订一决策唯一索引改成非唯一', expect: 'C4a D42', from: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', true]", to: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', false]" },
  // 注：「唯一索引去掉 WHERE task_revision_id IS NOT NULL」是等价变异（SQLite 唯一索引里多个 NULL 互不冲突），所以不登记；历史补录（修订为空）不受限由上面用例的两条历史补录正例钉住。
  { id: 'C4a D42 唯一索引加上决策列（同修订不同决策可并存）', expect: 'C4a D42', from: "'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', true]", to: "'sysbuild_confirmations(task_revision_id, decision) WHERE task_revision_id IS NOT NULL', true]" },
  { id: 'C4a 条件更新合约漏掉任务修订的 status_reason', expect: '可更新列登记表与手写', from: "  sysbuild_confirm_task_revisions: Object.freeze({ status: \"status = 'pending'\", status_reason: \"status = 'pending'\" }),", to: "  sysbuild_confirm_task_revisions: Object.freeze({ status: \"status = 'pending'\" })," },
  { id: 'C4a P32 条件更新合约漏掉 form', expect: '可更新列登记表与手写', from: "Object.freeze({ snapshot_json: \"status = 'draft'\", form: \"status = 'draft'\", parent_overall_version_id: \"status = 'draft'\" })", to: "Object.freeze({ snapshot_json: \"status = 'draft'\", parent_overall_version_id: \"status = 'draft'\" })" },
  { id: 'C4a P32 条件更新合约把 parent_overall_version_id 放宽', expect: '可更新列登记表与手写', from: "parent_overall_version_id: \"status = 'draft'\" })", to: "parent_overall_version_id: \"1 = 1\" })" },
  { id: 'C4a 条件更新合约放宽提出人状态', expect: '可更新列登记表与手写', from: "sysbuild_item_versions: Object.freeze({ proposer_status: \"proposer_status = 'pending'\", deny_reason: \"proposer_status = 'pending'\" }),", to: "sysbuild_item_versions: Object.freeze({ proposer_status: \"1 = 1\", deny_reason: \"proposer_status = 'pending'\" })," },
  // ── C5 S-S1b：判定快照按类别分支 CHECK（D39）、知会异议处理方式、登记的拆分 / 异议互斥 ──
  { id: 'C5 S-S1b pending 与 undetermined 不绑定', expect: 'C5 S-S1b', from: "    CHECK ((route = 'pending') = (basis_category = 'undetermined')),\n", to: '' },
  { id: 'C5 S-S1b 尚未判定可带判定列', expect: 'C5 S-S1b', from: "    CHECK (basis_category <> 'undetermined' OR (overall_package_version_id IS NULL AND item_version_id IS NULL AND committed_batch_id IS NULL AND golive_event_id IS NULL)),\n", to: '' },
  { id: 'C5 S-S1b 规划内可缺总体包版本', expect: 'C5 S-S1b', from: "OR (overall_package_version_id IS NOT NULL AND item_version_id IS NOT NULL AND route IN ('project', 'sys_iteration')", to: "OR (item_version_id IS NOT NULL AND route IN ('project', 'sys_iteration')" },
  { id: 'C5 S-S1b 规划内可缺条目版本', expect: 'C5 S-S1b', from: "OR (overall_package_version_id IS NOT NULL AND item_version_id IS NOT NULL AND route IN ('project', 'sys_iteration')", to: "OR (overall_package_version_id IS NOT NULL AND route IN ('project', 'sys_iteration')" },
  { id: 'C5 S-S1b 规划内留项目可缺承诺批次', expect: 'C5 S-S1b', from: "(route <> 'project' OR committed_batch_id IS NOT NULL)", to: '(1 = 1)' },
  { id: 'C5 S-S1b 规划内转系统迭代可缺上线事件', expect: 'C5 S-S1b', from: "(route <> 'sys_iteration' OR golive_event_id IS NOT NULL)", to: '(1 = 1)' },
  { id: 'C5 S-S1b 待细化可缺条目版本', expect: 'C5 S-S1b', from: "CHECK (basis_category <> 'planned_detail' OR (item_version_id IS NOT NULL AND route = 'project')),", to: "CHECK (basis_category <> 'planned_detail' OR route = 'project')," },
  { id: 'C5 S-S1b 待细化可转系统迭代', expect: 'C5 S-S1b', from: "CHECK (basis_category <> 'planned_detail' OR (item_version_id IS NOT NULL AND route = 'project')),", to: "CHECK (basis_category <> 'planned_detail' OR item_version_id IS NOT NULL)," },
  { id: 'C5 S-S1b 规划外可带条目版本', expect: 'C5 S-S1b', from: "CHECK (basis_category <> 'out_of_plan' OR (item_version_id IS NULL AND route IN ('sys_iteration', 'project')))", to: "CHECK (basis_category <> 'out_of_plan' OR route IN ('sys_iteration', 'project'))" },
  { id: 'C5 S-S1b 判定依据类别无枚举 CHECK', expect: 'C5 S-S1b', from: "basis_category TEXT NOT NULL ${inList('basis_category', E.routingBasis)},", to: 'basis_category TEXT NOT NULL,' },
  { id: 'C5 S-S1b 判定依据类别枚举同数量替换', expect: '可更新列登记表与手写', from: "  routingBasis: ['in_plan', 'planned_detail', 'out_of_plan', 'undetermined'],", to: "  routingBasis: ['in_plan', 'planned', 'out_of_plan', 'undetermined']," },
  { id: 'C5 S-S1b 知会异议 supplement_entry 可缺异议登记', expect: 'C5 S-S1b', from: "    CHECK ((mode = 'supplement_entry') = (objection_entry_id IS NOT NULL))", to: "    CHECK (objection_entry_id IS NULL OR mode = 'supplement_entry')" },
  { id: 'C5 S-S1b 知会异议 return_to_handling 可带异议登记', expect: 'C5 S-S1b', from: "    CHECK ((mode = 'supplement_entry') = (objection_entry_id IS NOT NULL))", to: "    CHECK (mode <> 'supplement_entry' OR objection_entry_id IS NOT NULL)" },
  { id: 'C6b 知会异议处理方式枚举去掉 to_pm', expect: 'C5 S-S1b', from: "noticeObjectionMode: ['return_to_handling', 'supplement_entry', 'to_pm'],", to: "noticeObjectionMode: ['return_to_handling', 'supplement_entry']," },
  { id: 'C6b 发送意图状态转移的条件更新登记被去掉', expect: '可更新列登记表与手写', from: "  sysbuild_send_intents: Object.freeze({ status: 'status = ?' }),\n", to: '' },
  { id: 'C5 S-S1b 知会异议处理方式无枚举 CHECK', expect: 'C5 S-S1b', from: "mode TEXT NOT NULL ${inList('mode', E.noticeObjectionMode)},", to: 'mode TEXT NOT NULL,' },
  { id: 'C5 S-S1b 知会异议处理方式可空', expect: 'C5 S-S1b', from: "mode TEXT NOT NULL ${inList('mode', E.noticeObjectionMode)},", to: "mode TEXT ${inList('mode', E.noticeObjectionMode, true)}," },
  { id: 'C5 S-S1b 登记的拆分来源与异议对象可并存', expect: 'C5 S-S1b', from: '    CHECK ((parent_entry_id IS NOT NULL) + (objects_entry_id IS NOT NULL) + (revision_of_entry_id IS NOT NULL) <= 1),\n', to: '' },
  // ── C5 S-S1c：登记三选一互斥、办理记录变更号、变更包一对一 ──
  { id: 'C5 S-S1c 拆分来源与异议对象互斥放宽成只管修订来源', expect: 'C5 S-S1b', from: '(parent_entry_id IS NOT NULL) + (objects_entry_id IS NOT NULL) + (revision_of_entry_id IS NOT NULL) <= 1', to: '(parent_entry_id IS NOT NULL) + (revision_of_entry_id IS NOT NULL) <= 1' },
  { id: 'C5 S-S1c 修订来源可与拆分来源并存', expect: 'C5 S-S1b', from: '(parent_entry_id IS NOT NULL) + (objects_entry_id IS NOT NULL) + (revision_of_entry_id IS NOT NULL) <= 1', to: '(parent_entry_id IS NOT NULL) + (objects_entry_id IS NOT NULL) <= 1' },
  { id: 'C5 S-S1c 变更号可用于任何办理动作', expect: 'C5 S-S1c 结构', from: "    CHECK (change_id IS NULL OR action IN ('conclude','link_change')),\n", to: '' },
  { id: 'C5 S-S1c 转正式变更结论可缺变更号', expect: 'C5 S-S1c 结构', from: "    CHECK (action <> 'conclude' OR ((conclusion_kind = 'to_change') = (change_id IS NOT NULL))),\n", to: "    CHECK (action <> 'conclude' OR (conclusion_kind = 'to_change' OR change_id IS NULL)),\n" },
  { id: 'C5 S-S1c 非转变更结论可带变更号', expect: 'C5 S-S1c 结构', from: "    CHECK (action <> 'conclude' OR ((conclusion_kind = 'to_change') = (change_id IS NOT NULL))),\n", to: "    CHECK (action <> 'conclude' OR (conclusion_kind <> 'to_change' OR change_id IS NOT NULL)),\n" },
  { id: 'C5 S-S1c 挂靠变更可缺变更号', expect: 'C5 S-S1c 结构', from: "    CHECK (action <> 'link_change' OR change_id IS NOT NULL)`],", to: '    CHECK (1 = 1)`],' },
  { id: 'C5 S-S1c 变更包唯一索引改成非唯一', expect: 'C5 S-S1c 结构', from: "['uq_sysbuild_changes_package', 'sysbuild_changes(package_id)', true]", to: "['uq_sysbuild_changes_package', 'sysbuild_changes(package_id)', false]" },
  { id: 'C5 S-S1c 变更可缺变更包编号', expect: 'C5 S-S1c 结构', from: '    package_id INTEGER NOT NULL,\n    title TEXT NOT NULL,\n    body TEXT NOT NULL,\n    ${JSON_COL(\'affects_json\', false)},', to: '    package_id INTEGER,\n    title TEXT NOT NULL,\n    body TEXT NOT NULL,\n    ${JSON_COL(\'affects_json\', false)},' },
  { id: 'build_type 重新放进可更新列（C3a / D44）', expect: '可更新列登记表与手写', from: "  sysbuild_projects: ['system_name', 'phase_name', 'goal',", to: "  sysbuild_projects: ['system_name', 'phase_name', 'build_type', 'goal'," },
];

// 子进程结果分三类（同 verify-sysbuild-db.js，09 号 M-4）：检出 / 未检出 / 异常（不计为检出）。
function runChild(args) {
  const r = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 300000 });
  const m = /^(\d+)\/(\d+) 通过\s*$/m.exec(r.stdout || '');
  const passedN = m ? Number(m[1]) : null;
  const totalN = m ? Number(m[2]) : null;
  if (r.error || r.signal || m === null) return { kind: 'abnormal', detail: (r.error && r.error.message) || r.signal || ((r.stderr || '').split('\n').slice(-4).join(' | ') || '无汇总行') };
  if (r.status === 1 && passedN < totalN) return { kind: 'red', detail: `${passedN}/${totalN}`, stdout: r.stdout };
  if (r.status === 0 && passedN === totalN) return { kind: 'green', detail: `${passedN}/${totalN}` };
  return { kind: 'abnormal', detail: `退出码 ${r.status} 与汇总 ${passedN}/${totalN} 不一致` };
}

function selfTest() {
  const base = runChild(['--module-dir', MODULE_DIR_DEFAULT]);
  if (base.kind !== 'green') {
    console.log(`  ✗ 未变异基线不是全绿（${base.kind}：${base.detail}），变异自检无意义，终止`);
    return 1;
  }
  console.log(`  ✓ 未变异基线 ${base.detail} 全绿`);
  const src = fs.readFileSync(path.join(MODULE_DIR_DEFAULT, 'schema.js'), 'utf8').replace(/\r\n/g, '\n');
  const sqliteAbs = JSON.stringify(require.resolve('sqlite3'));
  function makeModuleDir(schemaText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-schema-mut-'));
    const abs = (m) => JSON.stringify(require.resolve(m));
    for (const f of fs.readdirSync(MODULE_DIR_DEFAULT).filter((n) => n.endsWith('.js') && n !== 'schema.js')) {
      const text = fs.readFileSync(path.join(MODULE_DIR_DEFAULT, f), 'utf8')
        .split("require('sqlite3')").join(`require(${sqliteAbs})`)
        .split("require('express')").join(`require(${abs('express')})`)
        .split("require('multer')").join(`require(${abs('multer')})`);
      fs.writeFileSync(path.join(dir, f), text);
    }
    fs.writeFileSync(path.join(dir, 'schema.js'), schemaText);
    return dir;
  }
  // 分类器自检（09-R M-1）：加载不起来的模块必须判为异常，不能被算作检出。
  const brokenDir = makeModuleDir(`${src}\n这一行不是合法的 JavaScript(\n`);
  const broken = runChild(['--module-dir', brokenDir]);
  removeTree(brokenDir);
  if (broken.kind !== 'abnormal') {
    console.log(`  ✗ 分类器自检：语法错误的模块被判为 ${broken.kind}（应为异常），变异结果不可信，终止`);
    return 1;
  }
  console.log(`  ✓ 分类器自检：语法错误的模块判为异常（${broken.detail}）`);
  // 10 号 M-6：JS 能加载但 DDL 无效（夹具建不起来）也必须判为异常，不能被算作某条约束用例的检出。
  const badDdlFrom = '    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    system_name TEXT NOT NULL,';
  if (src.split(badDdlFrom).length - 1 !== 1) {
    console.log('  ✗ 分类器自检（DDL 无效）锚点不唯一，终止');
    return 1;
  }
  const badDdlDir = makeModuleDir(src.replace(badDdlFrom, '    id INTEGER PRIMARY KEY AUTOINCREMENT,,\n    system_name TEXT NOT NULL,'));
  const badDdl = runChild(['--module-dir', badDdlDir]);
  removeTree(badDdlDir);
  if (badDdl.kind !== 'abnormal') {
    console.log(`  ✗ 分类器自检：DDL 无效的模块被判为 ${badDdl.kind}（应为异常），变异结果不可信，终止`);
    return 1;
  }
  console.log(`  ✓ 分类器自检：DDL 无效的模块判为异常（${badDdl.detail}）`);
  let weak = 0;
  for (const mu of MUTATIONS) {
    const count = src.split(mu.from).length - 1;
    if (count !== 1) { console.log(`  ✗ [${mu.id}] 变异锚点出现 ${count} 次（应恰好 1 次）`); weak += 1; continue; }
    const dir = makeModuleDir(src.replace(mu.from, mu.to));
    const res = runChild(['--module-dir', dir]);
    // 只有期望的那条用例变红才算检出；变红的是别的用例说明断言打偏了
    const hit = res.kind === 'red' && res.stdout.split('\n').some((l) => l.startsWith(`  ✗ ${mu.expect}`));
    const label = hit ? `判红（${res.detail}，命中「${mu.expect}」）`
      : res.kind === 'red' ? `判红但未命中期望用例「${mu.expect}」`
        : res.kind === 'green' ? '未判红（断言无判别力）' : `异常（${res.detail}），不计为检出`;
    console.log(`  ${hit ? '✓' : '✗'} [${mu.id}] ${label}`);
    if (!hit) weak += 1;
    removeTree(dir);
  }
  console.log(`\n变异自检：${MUTATIONS.length - weak}/${MUTATIONS.length} 判红`);
  return weak;
}

(async () => {
  if (SELF_TEST) { process.exitCode = selfTest() === 0 ? 0 : 1; return; }
  // 09-R M-1：先在用例循环外加载被测模块；加载失败用独立退出码 3、不打印汇总行（归为异常）。
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(path.join(MODULE_DIR, 'index.js'));
    schemaMod();
  } catch (e) {
    console.log(`被测模块加载失败（不计为用例失败）: ${e && e.message}`);
    process.exitCode = 3;
    return;
  }
  // 10 号 M-6：共享夹具（真实工厂建库 + 就绪）也在用例循环前建好；建不起来是「异常」，不是某条约束用例失败。
  try {
    await sharedDb();
  } catch (e) {
    console.log(`共享夹具初始化失败（不计为用例失败）: ${e && e.message}`);
    await cleanup();
    process.exitCode = 3;
    return;
  }
  const failed = await runAll();
  await cleanup();
  process.exitCode = failed === 0 ? 0 : 1;
})();
