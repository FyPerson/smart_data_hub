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
const rec = require('./lib/sysbuild-mut-record'); // C1c：机器基线输出，只在 SYSBUILD_MUT_RECORD=1 时多打 @@CASE / @@MUT 行

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
async function expectConstraint(c, sql, params, label, expectedMessage) {
  let err = null;
  try { await run(c, sql, params); } catch (e) { err = e; }
  assert.ok(err && err.code === 'SQLITE_CONSTRAINT', `${label}: 应被约束拒绝，实际 ${err ? err.message : '成功写入'}`);
  if (expectedMessage) assert.ok(err.message.includes(expectedMessage), label + ': ' + err.message);
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
const EXPECTED_TABLES = ['sysbuild_projects', 'sysbuild_parties', 'sysbuild_members', 'sysbuild_appointments',
  'sysbuild_delegations', 'sysbuild_batches', 'sysbuild_nodes',
  'sysbuild_node_schedule_records', 'sysbuild_packages', 'sysbuild_package_versions', 'sysbuild_materials',
  'sysbuild_material_versions', 'sysbuild_entries', 'sysbuild_entry_actions', 'sysbuild_confirm_tasks',
  'sysbuild_confirm_task_revisions', 'sysbuild_confirmations', 'sysbuild_views', 'sysbuild_golive_events',
  'sysbuild_notices', 'sysbuild_notice_attempts', 'sysbuild_attachments', 'sysbuild_attachment_bindings',
  'sysbuild_attachment_refs', 'sysbuild_frozen_attachments', 'sysbuild_send_intents', 'sysbuild_card_instances',
  'sysbuild_guide_state', 'sysbuild_events', 'sysbuild_opinions', 'sysbuild_tasks', 'sysbuild_cut_approvals'];
const EXPECTED_INDEXES = ['idx_sysbuild_projects_pm', 'idx_sysbuild_parties_project', 'uq_sysbuild_parties_one_dev', 'idx_sysbuild_members_project',
  'idx_sysbuild_members_user', 'uq_sysbuild_members_active_user', 'idx_sysbuild_appointments_party', 'uq_sysbuild_appointments_active',
  'idx_sysbuild_delegations_party', 'uq_sysbuild_delegations_active', 'uq_sysbuild_batches_seq',
  'uq_sysbuild_batches_default', 'idx_sysbuild_nodes_project', 'uq_sysbuild_nodes_golive', 'idx_sysbuild_schedule_node',
  'uq_sysbuild_schedule_baseline', 'idx_sysbuild_packages_project', 'uq_sysbuild_packages_project_single', 'uq_sysbuild_packages_batch_single',
  'uq_sysbuild_package_versions_no', 'uq_sysbuild_package_versions_effective', 'uq_sysbuild_package_versions_pending', 'uq_sysbuild_package_versions_draft',
  'uq_sysbuild_materials_key', 'uq_sysbuild_material_versions_no', 'idx_sysbuild_entries_project', 'idx_sysbuild_entries_type',
  'idx_sysbuild_entry_actions_entry', 'idx_sysbuild_confirm_tasks_project', 'uq_sysbuild_task_revisions_no', 'uq_sysbuild_task_revisions_pending',
  'idx_sysbuild_task_revisions_member', 'idx_sysbuild_confirmations_revision', 'uq_sysbuild_confirmations_revision', 'idx_sysbuild_confirmations_object',
  'idx_sysbuild_views_user_object', 'idx_sysbuild_golive_batch', 'idx_sysbuild_notices_project', 'idx_sysbuild_notice_attempts_notice',
  'idx_sysbuild_attachments_project', 'idx_sysbuild_bindings_owner', 'uq_sysbuild_attachment_refs', 'idx_sysbuild_attachment_refs_owner',
  'uq_sysbuild_frozen', 'idx_sysbuild_frozen_attachment', 'idx_sysbuild_send_intents_status', 'idx_sysbuild_card_instances_revision',
  'idx_sysbuild_events_project', 'idx_sysbuild_events_object',
  'idx_sysbuild_opinions_project_status', 'idx_sysbuild_opinions_adjustment', 'idx_sysbuild_tasks_project_status',
  'idx_sysbuild_tasks_node', 'uq_sysbuild_tasks_source_opinion', 'uq_sysbuild_cut_approvals_party'];

test('真实工厂初始化：表名与索引名与手写清单全等（32 表 / 55 索引）；上传子目录已预建；单飞', async () => {
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
  assert.strictEqual(EXPECTED_TABLES.length, 32);
  assert.strictEqual(EXPECTED_INDEXES.length, 55);
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

test('日期 CHECK：实际开始日期（结构要求非空）负例全拒、NULL 拒绝、正例通过', async () => {
  const { c } = await sharedDb();
  const sql = "INSERT INTO sysbuild_node_schedule_records(node_id, kind, actual_date, created_by) VALUES (1,'actual_start',?,1)";
  await inSavepoint(c, async () => {
    for (const d of BAD_DATES) await expectConstraint(c, sql, [d], `actual_date=${JSON.stringify(d)}`);
    await expectConstraint(c, sql, [null], 'actual_date=NULL');
    for (const d of GOOD_DATES) await expectOk(c, sql, [d], `actual_date=${d}`);
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
    await expectConstraint(c, "INSERT INTO sysbuild_members(project_id, added_by, joined_at) VALUES (1,1,'2026-10-01 10:00:00')", [], '成员无账号也无姓名');
    await expectOk(c, "INSERT INTO sysbuild_members(project_id, user_id, added_by, joined_at) VALUES (1,9,1,'2026-10-01 10:00:00')", [], '有效账号成员');
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

test('行级约束：确认记录的平台、卡片方式及退出值', async () => {
  const { c } = await sharedDb();
  const sql = `INSERT INTO sysbuild_confirmations(task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, reason, view_id, card_instance_id, dingtalk_user_id)
    VALUES (?, 'package_version', 1, 9, ?, ?, ?, ?, ?, ?, ?)`;
  await inSavepoint(c, async () => {
    await expectConstraint(c, sql, [1, 'platform', 'confirm', '我已阅读', null, null, null, null], '平台确认缺浏览记录');
    await expectOk(c, sql, [1, 'platform', 'confirm', '我已阅读', null, 5, null, null], '平台确认正例');
    await expectConstraint(c, sql, [2, 'platform', 'object', '我已阅读', null, 5, null, null], '异议缺原因');
    await expectConstraint(c, sql, [null, 'platform', 'confirm', '我已阅读', null, 5, null, null], '平台确认不挂修订');
    await expectConstraint(c, sql, [null, 'card', 'confirm', null, null, null, 7, 'ding'], '卡片确认不挂修订');
    await expectConstraint(c, sql, [2, 'card', 'confirm', null, null, null, null, null], '卡片缺实例与钉钉账号');
    await expectOk(c, sql, [2, 'card', 'confirm', null, null, null, 7, 'ding'], '卡片确认正例');
    for (const method of ['proxy', 'history']) {
      await expectConstraint(c, sql, [3, method, 'confirm', null, null, null, null, null], '退出方式被拒');
    }
  });
});

test('C4a D42 一修订一决策：单修订唯一且引用必填，不同修订各一条', async () => {
  const { c } = await sharedDb();
  const conf = `INSERT INTO sysbuild_confirmations(task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, reason, view_id)
    VALUES (?, 'package_version', 1, 9, 'platform', ?, '我已阅读', ?, 5)`;
  await inSavepoint(c, async () => {
    await expectOk(c, conf, [101, 'confirm', null], '修订 101 的首条确认');
    await expectConstraint(c, conf, [101, 'confirm', null], '同一修订第二条同决策');
    await expectConstraint(c, conf, [101, 'object', '有异议'], '同一修订第二条不同决策');
    await expectOk(c, conf, [102, 'reject', '不认可'], '修订 102 的首条确认');
    await expectConstraint(c, conf, [null, 'confirm', null], '修订必须存在');
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

test('C1b 预筛修订：包版本替代 / 成员与任职授权时间 / 生效负责人唯一 / 改期证据与更正对象 / 项目层不得有上线里程碑', async () => {
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
    // 直接指定后只保存生效后的记录，终止身份仍保留原生效时间。
    await expectOk(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at, ended_at, end_reason) VALUES (2,1,'ended',1,'2026-10-01 09:00:00','2026-10-02 09:00:00','任职结束')", [], '保留已结束的任职');
    await expectOk(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at, revoked_at, revoke_reason) VALUES (2,1,1,'revoked',1,'2026-10-01 09:00:00','2026-10-02 09:00:00','授权撤销')", [], '保留已撤销的授权');
    const noJoin = 'NOT NULL constraint failed: sysbuild_members.joined_at';
    const noAppointmentTime = 'NOT NULL constraint failed: sysbuild_appointments.effective_at';
    const noDelegationTime = 'NOT NULL constraint failed: sysbuild_delegations.effective_at';
    await expectConstraint(c, "INSERT INTO sysbuild_members(project_id, user_id, added_by) VALUES (1,42,1)", [], '成员须有加入时间', noJoin);
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by) VALUES (10,1,'active',1)", [], '生效任职须有生效时间', noAppointmentTime);
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, ended_at, end_reason) VALUES (2,1,'ended',1,'2026-10-02 09:00:00','任职结束')", [], '已结束任职须有生效时间', noAppointmentTime);
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by) VALUES (10,1,1,'active',1)", [], '生效授权须有生效时间', noDelegationTime);
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, revoked_at, revoke_reason) VALUES (2,1,1,'revoked',1,'2026-10-02 09:00:00','授权撤销')", [], '已撤销授权须有生效时间', noDelegationTime);
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
    await expectConstraint(c, pk, [10, null, 'change'], '变更包已经退出');
    // 每项目 initiation / overall / closing 各至多一个
    for (const t of ['initiation', 'overall', 'closing']) {
      await expectOk(c, pk, [11, null, t], `${t} 首个`);
      await expectConstraint(c, pk, [11, null, t], `${t} 同项目第二个`);
      await expectOk(c, pk, [12, null, t], `${t} 别的项目可以有`);
    }
    // 每批 batch_req / batch_accept 各至多一个；同批两种类型可并存；不同批互不影响
    await expectConstraint(c, pk, [13, 21, 'batch_req'], '批次需求包已经退出');
    await expectOk(c, pk, [13, 21, 'batch_accept'], '第一份批次验收包');
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
    // 附件引用：同一附件对同一对象至多一条；owner_type 在绑定枚举内
    const ref = 'INSERT INTO sysbuild_attachment_refs(project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (1,?,?,?,1)';
    await expectOk(c, ref, [90, 'package_version', 7], '引用首条');
    await expectConstraint(c, ref, [90, 'package_version', 7], '同一附件对同一对象第二条引用');
    await expectOk(c, ref, [90, 'package_version', 8], '同一附件引用另一对象');
    await expectOk(c, ref, [91, 'package_version', 7], '另一附件引用同一对象');
    await expectOk(c, ref, [90, 'material_version', 7], '同一附件、同号不同类型的对象');
    await expectConstraint(c, ref, [92, 'bogus_owner', 7], '引用的 owner_type 越界');
    await expectConstraint(c, 'INSERT INTO sysbuild_attachment_refs(project_id, attachment_id, owner_type, owner_id) VALUES (1,93,\'package_version\',9)', [], '引用缺 ref_by');
  });
});

// M5-B：可更新列与枚举用手写期望表全等对拍（不复用被测常量；被测改了必须同步改这里）
test('V9 意见和任务结构：评估工时、结论、任务来源与本人表态约束', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    const opinion = "INSERT INTO sysbuild_opinions(project_id,author_user_id,author_name,author_side,title,body,assessment_source,assessment_text,assessment_hours,assessed_by,assessed_at) VALUES (8,1,'项目成员','dev','意见','正文','self','本人说明',?,1,'2026-11-25 08:30:00')";
    await expectOk(c, opinion, [0], '合法的零工时');
    await expectConstraint(c, opinion, [-1], '工时不为负数');
    await expectConstraint(c, "INSERT INTO sysbuild_opinions(project_id,author_user_id,author_name,author_side,title,body,status) VALUES (8,1,'项目成员','dev','意见','正文','concluded')", [], '已结论必须有实际结果');
    const task = "INSERT INTO sysbuild_tasks(project_id,node_id,source_opinion_id,title,assignee_user_id,planned_on,created_by) VALUES (8,20,?,'任务',2,?,1)";
    await expectOk(c, task, [null, null], '手工任务可无来源和日期');
    await expectOk(c, task, [null, '2026-11-25'], '多个手工任务可无意见来源');
    await expectOk(c, task, [7, null], '一条本期意见生成一个任务');
    await expectConstraint(c, task, [7, '2026-11-25'], '不允许同一意见重复生成任务');
    await expectConstraint(c, task, [8, '2026-02-30'], '任务日期须为真实日期');
    const approval = "INSERT INTO sysbuild_cut_approvals(project_id,opinion_id,party_id,party_name,status) VALUES (8,7,1,'需求部门',?)";
    await expectConstraint(c, approval, ['agree'], '本人表态须有操作者和授权依据');
    await expectOk(c, approval, ['pending'], '每个部门一条待同意');
    await expectConstraint(c, approval, ['pending'], '单意见同部门不可重复');
  });
});

const EXPECTED_UPDATABLE = {
  sysbuild_projects: ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on', 'pm_user_id', 'status', 'updated_at'], // C3a：build_type 移出（方案 v1.2 D44）
  sysbuild_parties: ['name'],
  sysbuild_members: ['removed_at', 'removed_reason'],
  sysbuild_appointments: ['status', 'ended_at', 'end_reason'],
  sysbuild_delegations: ['status', 'revoked_at', 'revoke_reason'],
  sysbuild_batches: ['status', 'name', 'dev_assignee_member_id'],
  sysbuild_nodes: ['name', 'sort_order', 'status', 'opened_at', 'closed_at', 'updated_at'],
  sysbuild_package_versions: ['status', 'effective_at', 'snapshot_json', 'form', 'parent_overall_version_id', 'updated_at'], // C4a 修订批 P32：form / parent 提交时重算回写
  sysbuild_confirm_task_revisions: ['status', 'status_reason', 'updated_at'],
  sysbuild_attachments: ['deleted_at', 'deleted_by', 'masked_at', 'masked_by', 'mask_reason'],
  sysbuild_send_intents: ['status', 'attempts', 'last_error', 'updated_at'],
  sysbuild_card_instances: ['status'],
  sysbuild_opinions: ['category', 'status', 'triage_text', 'triaged_by', 'triaged_at', 'needs_assessment', 'skip_reason',
    'assessment_text', 'assessment_hours', 'assessment_source', 'assessed_by', 'assessed_at', 'assessed_for_user_id', 'assessed_for_delegation_id',
    'outcome', 'outcome_text', 'resolved_by', 'resolved_at', 'cut_scope_version_id', 'adjustment_version_id', 'updated_at'],
  sysbuild_tasks: ['status', 'result_text', 'resolved_by', 'resolved_at'],
  sysbuild_cut_approvals: ['status', 'decided_by', 'delegation_id', 'decision_text', 'decided_at'],
};
// 10 号 M-5：枚举按值集合全等（同数量替换也能检出）
const EXPECTED_ENUMS = {
  buildType: ['outsource', 'procurement', 'inhouse'],
  projectStatus: ['active', 'paused', 'terminated', 'closed'],
  partySide: ['demand', 'dev'],
  appointmentStatus: ['active', 'ended'],
  delegationStatus: ['active', 'revoked'],
  batchStatus: ['planning', 'active', 'live'],
  nodeStatus: ['not_started', 'in_progress', 'closed', 'cancelled'],
  scheduleKind: ['baseline', 'plan_change', 'actual_start', 'actual_end', 'actual_correct'],
  packageType: ['initiation', 'overall', 'batch_accept', 'closing'],
  packageForm: ['overall', 'overall_batch_req'], // C3b：包版本形态（只在总体规划包的版本上填写）
  packageVersionStatus: ['draft', 'pending', 'effective', 'superseded'],
  entryType: ['note', 'material', 'lesson', 'benefit', 'correction', 'feedback', 'issue'],
  entryPeriod: ['process', 'supplement'],
  entryAction: ['correct', 'void'],
  confirmObjectType: ['package_version'],
  confirmPurpose: ['package_confirm'],
  revisionStatus: ['pending', 'confirmed', 'objected', 'rejected', 'invalid', 'superseded'],
  confirmMethod: ['platform', 'card'],
  confirmDecision: ['confirm', 'object', 'reject'],
  viewSource: ['page', 'self_submit', 'card_render'],
  goliveKind: ['golive', 'revoke', 'regolive'],
  noticeKind: ['schedule_change'],
  noticeChannel: ['dingtalk', 'platform'],
  noticeResult: ['sent', 'failed'],
  bindingOwnerType: ['entry', 'material_version', 'golive_event', 'schedule_record', 'package_version', 'opinion', 'opinion_assessment', 'work_task'],
  frozenObjectType: ['package_version', 'entry', 'material_version'],
  sendIntentStatus: ['pending', 'sent', 'failed'],
  cardStatus: ['sent', 'updated', 'expired'],
  opinionSide: ['demand', 'dev', 'internal'],
  opinionCategory: ['requirement', 'problem', 'improvement', 'cut'],
  opinionStatus: ['triage', 'assessment', 'disposition', 'cut_approval', 'concluded'],
  opinionOutcome: ['now', 'next', 'no', 'cut_agreed', 'scope_kept'],
  assessmentSource: ['self', 'dev', 'proxy'],
  workTaskStatus: ['pending', 'done', 'cancelled'],
  cutApprovalStatus: ['pending', 'agree', 'object'],
};
const EXPECTED_CONDITIONAL = {
  sysbuild_package_versions: { snapshot_json: "status = 'draft'", form: "status = 'draft'", parent_overall_version_id: "status = 'draft'" }, // C4a 修订批 P32：form / parent 只在草稿条件下回写
  sysbuild_members: { removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' },
  sysbuild_appointments: { status: "status = 'active'", ended_at: "status = 'active'", end_reason: "status = 'active'" },
  sysbuild_delegations: { status: "status = 'active'", revoked_at: "status = 'active'", revoke_reason: "status = 'active'" },
  // C4a：提出人状态与任务修订终态都只从「待确认」转入
  sysbuild_confirm_task_revisions: { status: "status = 'pending'", status_reason: "status = 'pending'" },
  sysbuild_batches: { status: 'status = ?' }, // C4a 修订批三 M-1 / C6a：批次状态转移（规划中 → 进行中、进行中 ↔ 已上线）WHERE 都带旧值条件，旧值作参数传入
  sysbuild_send_intents: { status: 'status = ?' }, // C6b：发送意图状态转移（notify.js 记发送结果一处写）都带旧值条件，旧值作参数传入
  sysbuild_opinions: { status: 'status = ?' },
  sysbuild_tasks: { status: "status = 'pending'" },
  sysbuild_cut_approvals: { status: "status = 'pending'" },
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

test('10 号修订：确认任务必绑版本、旧确认对象拒绝、撤回状态无生效时间', async () => {
  const { c } = await sharedDb();
  await inSavepoint(c, async () => {
    const ct = "INSERT INTO sysbuild_confirm_tasks(project_id, object_type, object_id, object_version_id, purpose, created_by) VALUES (1,?,?,?,?,1)";
    await expectConstraint(c, ct, ['package_version', 1, null, 'package_confirm'], '确认任务缺版本');
    await expectConstraint(c, ct, ['invitation', 5, 6, 'accept_invitation'], '邀请的版本号不等于对象号');
    await expectConstraint(c, ct, ['invitation', 5, 5, 'accept_invitation'], '旧邀请任务不再可写');
    await expectOk(c, ct, ['package_version', 1, 3, 'package_confirm'], '内容包正例');
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at) VALUES (9,1,'withdrawn',1,'2026-10-28 09:00:00')", [], '任职撤回带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_appointments(party_id, member_id, status, proposed_by, effective_at) VALUES (9,1,'pending',1,'2026-10-28 09:00:00')", [], '任职待接受带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (9,1,1,'withdrawn',1,'2026-10-28 09:00:00')", [], '授权撤回带生效时间');
    await expectConstraint(c, "INSERT INTO sysbuild_delegations(party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (9,1,1,'rejected',1,'2026-10-28 09:00:00')", [], '授权拒绝带生效时间');
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
      if (rec.enabled()) console.log(rec.caseLine(t.name, e));
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
  { id: 'B5.1 任务来源意见可重复', expect: 'V9 意见和任务结构', from: "['uq_sysbuild_tasks_source_opinion', 'sysbuild_tasks(source_opinion_id) WHERE source_opinion_id IS NOT NULL', true]", to: "['uq_sysbuild_tasks_source_opinion', 'sysbuild_tasks(source_opinion_id) WHERE source_opinion_id IS NOT NULL']" },
  { id: 'B5.1 结构允许负工时', expect: 'V9 意见和任务结构', from: 'assessment_hours BETWEEN 0 AND 1.7976931348623157e308', to: 'assessment_hours BETWEEN -10 AND 1.7976931348623157e308' },
  { id: 'B5.1 库允许无本人信息的砍需求同意', expect: 'V9 意见和任务结构', from: "(status <> 'pending' AND decided_by IS NOT NULL AND delegation_id IS NOT NULL AND decided_at IS NOT NULL)", to: "(status <> 'pending')" },
  { id: 'C8 成员账号误退回可空', expect: '行级约束：成员身份', from: 'user_id INTEGER NOT NULL,\n    joined_at', to: 'user_id INTEGER,\n    joined_at' },
  { id: '日期 CHECK 去掉 date() 非空', expect: '日期 CHECK', from: " AND date(${col},'+0 days') IS NOT NULL", to: '' },
  { id: '日期 CHECK 去掉范围', expect: '日期 CHECK', from: " AND ${col} BETWEEN '2000-01-01' AND '2099-12-31'", to: '' },
  { id: '默认批次唯一索引去掉 WHERE', expect: '部分唯一索引', from: "['uq_sysbuild_batches_default', 'sysbuild_batches(project_id) WHERE is_default = 1', true]", to: "['uq_sysbuild_batches_default', 'sysbuild_batches(project_id, is_default)', false]" },
  { id: '待确认修订唯一性去掉', expect: '部分唯一索引', from: "['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \\'pending\\'', true]", to: "['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \\'pending\\'', false]" },
  { id: '非历史补录可不挂修订（单向）', expect: '行级约束：确认记录', from: "task_revision_id INTEGER NOT NULL,\n    object_type", to: "task_revision_id INTEGER,\n    object_type" },
  { id: '补充登记天数约束去掉', expect: '行级约束：成员身份', from: "    CHECK ((period = 'supplement') = (days_after_close IS NOT NULL)),\n", to: '' },
  { id: '附件可重复绑定', expect: '附件：', from: '    attachment_id INTEGER NOT NULL UNIQUE,', to: '    attachment_id INTEGER NOT NULL,' },
  { id: '可更新列登记不存在的列', expect: '可更新列登记表', from: "  sysbuild_parties: ['name'],", to: "  sysbuild_parties: ['name', 'no_such_col']," },
  { id: '时间戳允许 NULL', expect: '枚举越界与时间戳', from: `const TS = "DATETIME NOT NULL DEFAULT (datetime('now','localtime'))";`, to: `const TS = "DATETIME DEFAULT (datetime('now','localtime'))";` },
  { id: '项目层节点可挂上线里程碑', expect: 'C1b 预筛修订', from: "    CHECK (is_golive_milestone = 0 OR (batch_id IS NOT NULL AND status <> 'cancelled')),", to: "    CHECK (is_golive_milestone = 0 OR status <> 'cancelled')," },
  { id: '待确认版本不能被替代（旧 CHECK）', expect: 'C1b 预筛修订', from: "    CHECK (status <> 'effective' OR effective_at IS NOT NULL),", to: "    CHECK (status NOT IN ('effective','superseded') OR effective_at IS NOT NULL)," },
  { id: '同包可有多个待确认版本', expect: 'C1b 预筛修订', from: "['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \\'pending\\'', true]", to: "['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \\'pending\\'', false]" },
  { id: '同参与方可有多位生效代表人', expect: 'C1b 预筛修订', from: "['uq_sysbuild_delegations_active', 'sysbuild_delegations(party_id) WHERE status = \\'active\\'', true]", to: "['uq_sysbuild_delegations_active', 'sysbuild_delegations(party_id) WHERE status = \\'active\\'', false]" },
  { id: '改期无书面证据不校验原因', expect: 'C1b 预筛修订', from: "    CHECK (corrects_kind IS NULL OR corrects_kind IN ('actual_start','actual_end')),\n    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))", to: "    CHECK (corrects_kind IS NULL OR corrects_kind IN ('actual_start','actual_end'))" },
  { id: '实际日期更正可不指明对象', expect: 'C1b 预筛修订', from: "    CHECK ((kind = 'actual_correct') = (corrects_kind IS NOT NULL)),\n", to: '' },
  { id: '枚举同数量替换（read→seen）', expect: '可更新列登记表与手写', from: "  batchStatus: ['planning', 'active', 'live'],", to: "  batchStatus: ['planning', 'active', 'unrecognized']," },
  { id: '索引改名', expect: '真实工厂初始化', from: "['idx_sysbuild_notice_attempts_notice', 'sysbuild_notice_attempts(notice_id, id)'],", to: "['idx_sysbuild_notice_attempts_renamed', 'sysbuild_notice_attempts(notice_id, id)']," },
  { id: '确认任务版本可空', expect: '10 号修订', from: '    object_version_id INTEGER NOT NULL,\n    purpose TEXT NOT NULL', to: '    object_version_id INTEGER,\n    purpose TEXT NOT NULL' },
  { id: '#212 B2.3 成员加入时间可空', expect: 'C1b 预筛修订', from: '    joined_at DATETIME NOT NULL,', to: '    joined_at DATETIME,' },
  { id: '#212 B2.3 任职生效时间可空', expect: 'C1b 预筛修订', from: '    effective_at DATETIME NOT NULL,\n    ended_at DATETIME,', to: '    effective_at DATETIME,\n    ended_at DATETIME,' },
  { id: '#212 B2.3 授权生效时间可空', expect: 'C1b 预筛修订', from: '    effective_at DATETIME NOT NULL,\n    revoked_at DATETIME,', to: '    effective_at DATETIME,\n    revoked_at DATETIME,' },
  { id: '#212 B2.3 任职恢复 pending', expect: '10 号修订', from: "  appointmentStatus: ['active', 'ended'],", to: "  appointmentStatus: ['active', 'ended', 'pending']," },
  { id: '#212 B2.3 授权恢复 rejected', expect: '10 号修订', from: "  delegationStatus: ['active', 'revoked'],", to: "  delegationStatus: ['active', 'revoked', 'rejected']," },
  { id: '条件更新合约放宽', expect: '可更新列登记表与手写', from: "snapshot_json: \"status = 'draft'\"", to: 'snapshot_json: "1 = 1"' },
  { id: 'C3b batch_accept 可不挂批次（CHECK 只剩 batch_req）', expect: 'C3b 结构', from: "CHECK (type <> 'batch_accept' OR batch_id IS NOT NULL),", to: "" },
  { id: 'C3b 包类型枚举恢复 overall_batch_req', expect: 'C3b 结构', from: "  packageType: ['initiation', 'overall', 'batch_accept', 'closing'],", to: "  packageType: ['initiation', 'overall', 'batch_req', 'overall_batch_req', 'batch_accept', 'change', 'closing']," },
  { id: 'C3b 包类型枚举同数量替换（change→chg）', expect: '可更新列登记表与手写', from: "  packageType: ['initiation', 'overall', 'batch_accept', 'closing'],", to: "  packageType: ['initiation', 'overall', 'batch_accept', 'unrecognized']," },
  { id: 'C3b 每项目唯一索引漏掉 closing', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'initiation\\',\\'overall\\')', true]" },
  { id: 'C3b 每项目唯一索引漏掉 initiation', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'overall\\',\\'closing\\')', true]" },
  { id: 'C3b 每项目唯一索引改成非唯一', expect: 'C3b 结构', from: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', true]", to: "WHERE type IN (\\'initiation\\',\\'overall\\',\\'closing\\')', false]" },
  { id: 'C3b 每批唯一索引漏掉 batch_accept', expect: 'C3b 结构', from: "'sysbuild_packages(batch_id, type) WHERE type =", to: "'sysbuild_packages(batch_id, type) WHERE type <>" },
  { id: 'C3b 包版本 form 无 CHECK', expect: 'C3b 结构', from: "    form TEXT ${inList('form', E.packageForm, true)},", to: '    form TEXT,' },
  { id: 'C3b form 枚举同数量替换', expect: '可更新列登记表与手写', from: "  packageForm: ['overall', 'overall_batch_req'],", to: "  packageForm: ['overall', 'overall_batch'],", },
  { id: 'C3b 附件引用唯一索引改成非唯一', expect: 'C3b 结构', from: "['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true]", to: "['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', false]" },
  { id: 'C3b 附件引用唯一索引漏掉 owner_type', expect: 'C3b 结构', from: "'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true]", to: "'sysbuild_attachment_refs(attachment_id, owner_id)', true]" },
  { id: 'C3b 附件引用 owner_type 无枚举 CHECK', expect: 'C3b 结构', from: "    owner_type TEXT NOT NULL ${inList('owner_type', E.bindingOwnerType)},\n    owner_id INTEGER NOT NULL,\n    ref_by INTEGER NOT NULL,", to: '    owner_type TEXT NOT NULL,\n    owner_id INTEGER NOT NULL,\n    ref_by INTEGER NOT NULL,' },
  { id: 'C3b 草稿版本唯一索引改成非唯一', expect: 'C3b 结构', from: "['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', false]" },
  { id: 'C3b 草稿版本唯一索引把待确认也算进去', expect: 'C3b 结构', from: "'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "'sysbuild_package_versions(package_id) WHERE status IN (\\'draft\\',\\'pending\\')', true]" },
  { id: 'C3b 草稿版本唯一索引不看状态（所有版本互斥）', expect: 'C3b 结构', from: "'sysbuild_package_versions(package_id) WHERE status = \\'draft\\'', true]", to: "'sysbuild_package_versions(package_id) WHERE version_no >= 1', true]" },
  { id: 'C4a D42 一修订一决策唯一索引改成非唯一', expect: 'C4a D42', from: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)', true]", to: "['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)', false]" },
  // 注：「唯一索引去掉 WHERE task_revision_id IS NOT NULL」是等价变异（SQLite 唯一索引里多个 NULL 互不冲突），所以不登记；历史补录（修订为空）不受限由上面用例的两条历史补录正例钉住。
  { id: 'C4a D42 唯一索引加上决策列（同修订不同决策可并存）', expect: 'C4a D42', from: "'sysbuild_confirmations(task_revision_id)', true]", to: "'sysbuild_confirmations(task_revision_id, decision)', true]" },
  { id: 'C4a 条件更新合约漏掉任务修订的 status_reason', expect: '可更新列登记表与手写', from: "  sysbuild_confirm_task_revisions: Object.freeze({ status: \"status = 'pending'\", status_reason: \"status = 'pending'\" }),", to: "  sysbuild_confirm_task_revisions: Object.freeze({ status: \"status = 'pending'\" })," },
  { id: 'C4a P32 条件更新合约漏掉 form', expect: '可更新列登记表与手写', from: "Object.freeze({ snapshot_json: \"status = 'draft'\", form: \"status = 'draft'\", parent_overall_version_id: \"status = 'draft'\" })", to: "Object.freeze({ snapshot_json: \"status = 'draft'\", parent_overall_version_id: \"status = 'draft'\" })" },
  { id: 'C4a P32 条件更新合约把 parent_overall_version_id 放宽', expect: '可更新列登记表与手写', from: "parent_overall_version_id: \"status = 'draft'\" })", to: "parent_overall_version_id: \"1 = 1\" })" },
  // ── C5 S-S1b：判定快照按类别分支 CHECK（D39）、知会异议处理方式、登记的拆分 / 异议互斥 ──
  { id: 'C6b 发送意图状态转移的条件更新登记被去掉', expect: '可更新列登记表与手写', from: "  sysbuild_send_intents: Object.freeze({ status: 'status = ?' }),\n", to: '' },
  // ── C5 S-S1c：登记三选一互斥、办理记录变更号、变更包一对一 ──
  { id: 'build_type 重新放进可更新列（C3a / D44）', expect: '可更新列登记表与手写', from: "  sysbuild_projects: ['system_name', 'phase_name', 'goal',", to: "  sysbuild_projects: ['system_name', 'phase_name', 'build_type', 'goal'," },
];

// 子进程结果分三类（同 verify-sysbuild-db.js，09 号 M-4）：检出 / 未检出 / 异常（不计为检出）。
function runChild(args) {
  const r = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 300000 });
  const m = /^(\d+)\/(\d+) 通过\s*$/m.exec(r.stdout || '');
  const passedN = m ? Number(m[1]) : null;
  const totalN = m ? Number(m[2]) : null;
  if (r.error || r.signal || m === null) return { kind: 'abnormal', detail: (r.error && r.error.message) || r.signal || ((r.stderr || '').split('\n').slice(-4).join(' | ') || '无汇总行') };
  if (r.status === 1 && passedN < totalN) return { kind: 'red', detail: `${passedN}/${totalN}`, stdout: r.stdout, caseDetails: rec.parseCaseLines(r.stdout) };
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
    if (count !== 1) { console.log(`  ✗ [${mu.id}] 变异锚点出现 ${count} 次（应恰好 1 次）`); weak += 1; if (rec.enabled()) console.log(rec.mutLine('schema', mu.id, rec.VERDICT.ANCHOR, [], `变异锚点出现 ${count} 次（应恰好 1 次）`)); continue; }
    const dir = makeModuleDir(src.replace(mu.from, mu.to));
    const res = runChild(['--module-dir', dir]);
    // 只有期望的那条用例变红才算检出；变红的是别的用例说明断言打偏了
    const hit = res.kind === 'red' && res.stdout.split('\n').some((l) => l.startsWith(`  ✗ ${mu.expect}`));
    const label = hit ? `判红（${res.detail}，命中「${mu.expect}」）`
      : res.kind === 'red' ? `判红但未命中期望用例「${mu.expect}」`
        : res.kind === 'green' ? '未判红（断言无判别力）' : `异常（${res.detail}），不计为检出`;
    console.log(`  ${hit ? '✓' : '✗'} [${mu.id}] ${label}`);
    if (!hit) weak += 1;
    if (rec.enabled()) console.log(rec.mutLine('schema', mu.id, hit ? rec.VERDICT.RED : (res.kind === 'abnormal' ? rec.VERDICT.ABNORMAL : rec.VERDICT.WEAK), res.kind === 'red' ? (res.caseDetails || []) : (res.kind === 'abnormal' ? [{ case: null, errorClass: null, message: res.detail }] : []), hit || res.kind !== 'red' ? null : '判红但未命中期望用例'));
    removeTree(dir);
  }
  console.log(`\n变异自检：${MUTATIONS.length - weak}/${MUTATIONS.length} 判红`);
  return weak;
}

// 只读导出（#212 C1b，供 scripts/sysbuild-step1/mutation-check.js 读取）：变异登记与用例名清单；下面的入口只在直接运行本脚本时执行。
module.exports = { MUTATIONS, CASE_NAMES: cases.map((c) => c.name) };
if (require.main === module) (async () => {
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
