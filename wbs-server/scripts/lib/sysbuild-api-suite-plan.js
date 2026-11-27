// 验证脚本库：项目管理（系统建设记录）模块 C3a——默认批次与节点模板、节点动作、排期与改期、§4.5 收口闸门（#113 段 3 N-S1）的用例
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.3 / §3 / §4.4 / §4.5 / §5 / §7
//   派单：docs/local/系统建设记录/送审准备/C3a_批次节点排期_派单_20261030.md §4
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 的 defineCases() 末尾调用 definePlanCases(T) 登记（同一套夹具、同一个变异自检）。
//   T = 套件注入的夹具与助手。期望值一律手写，不取自被测代码。
// 夹具规则：建项一律走 POST /projects（生产路径）；暂停 / 终止走 admin POST /projects/:id/status。只有一种状态仍直接写库，
//   并在用例名里标「夹具」：批次 status = live（及里程碑已收口）。C4a 起「节点已有 baseline」改走生产路径（见下方 produceEffectiveOverall 说明）。
'use strict';
const assert = require('assert');

// ── 手写期望表（节点模板，方案 v1.2 §3）──────────────────────────────────────────────────────
const PROJECT_TPL = {
  p_initiation: ['立项与授权', 'G0', 10],
  p_contract: ['采购与合同', 'CONTRACT', 20],
  p_overall: ['需求与范围确认', 'G1', 30],
  p_closing: ['结项', 'G6', 40],
};
const PROJECT_KEYS = {
  outsource: ['p_initiation', 'p_contract', 'p_overall', 'p_closing'],
  procurement: ['p_initiation', 'p_contract', 'p_overall', 'p_closing'],
  inhouse: ['p_initiation', 'p_overall', 'p_closing'],
};
const BATCH_TPL = {
  outsource: [
    ['b_design', '设计阶段', 'G2', false], ['b_dev', '开发阶段', 'G3', false], ['b_test', '测试阶段', 'G4', false],
    ['b_uat', '验收阶段', 'G4', false], ['b_golive', '上线', 'G5', false], ['b_trial', '试运行阶段（结束即正式上线）', 'G5', true],
  ],
  procurement: [
    ['b_req', '需求调研', 'G1', false], ['b_config', '配置阶段', 'G2+G3', false], ['b_training', '培训与验收阶段', 'G4', false],
    ['b_golive', '上线', 'G5', false], ['b_trial', '试运行阶段（结束即正式上线）', 'G5', true],
  ],
  inhouse: [
    ['b_dev', '开发阶段（含设计）', 'G2+G3', false], ['b_golive', '上线（含测试与验收）', 'G4+G5', true],
  ],
};
const MILESTONE_KEY = { outsource: 'b_trial', procurement: 'b_trial', inhouse: 'b_golive' };

// ── 日期小工具（用例自己的，不取自被测代码）─────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// 节点动作的 8 个 actions 标志（C3a 预筛 M3 / D7：更正实际日期按种类拆成两个）。
const NODE_FLAGS = ['cancel', 'close', 'correct_actual_end', 'correct_actual_start', 'rename', 'reopen', 'schedule_plan', 'start'];
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmt(new Date(y, m - 1, d + n));
}

const T_C6_R2 = 'C6 R2：排计划与改期不收 dev_key_entry_id';

function definePlanCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment } = T;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const patch = (uid, url, body) => api(uid, 'PATCH', url, body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  let projSeq = 0;
  let attSeq = 0;
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async function newProject(buildType, pm) {
    projSeq += 1;
    return T.createEmptyProjectFixture(pm || U.pm, { system_name: `计划测试项目${projSeq}`, build_type: buildType || 'outsource' });
  }
  async function planOf(uid, pid) {
    const r = await get(uid, `/sysbuild/projects/${pid}/plan`);
    assert.strictEqual(r.status, 200, r.text);
    return r.body;
  }
  const keyOf = (plan, key) => plan.nodes.find((n) => n.template_key === key);
  const idOf = async (pid, key, uid) => keyOf(await planOf(uid || U.pm, pid), key).id;
  const defaultBatchId = async (pid) => (await sqlGet('SELECT id FROM sysbuild_batches WHERE project_id = ? AND is_default = 1', [pid])).id;
  const startNode = (uid, nid) => post(uid, `/sysbuild/nodes/${nid}/start`);
  const closeNode = (uid, nid) => post(uid, `/sysbuild/nodes/${nid}/close`);
  const reopenNode = (uid, nid, reason) => post(uid, `/sysbuild/nodes/${nid}/reopen`, reason === undefined ? {} : { reason });
  const cancelNode = (uid, nid, reason) => post(uid, `/sysbuild/nodes/${nid}/cancel`, reason === undefined ? {} : { reason });
  const setPlan = (uid, nid, start, end, extra) => post(uid, `/sysbuild/nodes/${nid}/schedule`, Object.assign({ kind: 'plan', planned_start: start, planned_end: end }, extra || {}));
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '计划用例' });
  const recordsOf = (nid) => sqlAll('SELECT * FROM sysbuild_node_schedule_records WHERE node_id = ? ORDER BY id', [nid]);
  const nodeRow = (nid) => sqlGet('SELECT * FROM sysbuild_nodes WHERE id = ?', [nid]);
  // 给本项目全部未取消节点（可按 filter 缩小）写一条草稿期计划。每条必须 201：不再放过 400（预筛 L10：放过会掩盖准备步骤失败）。
  async function planAll(pid, filter) {
    const plan = await planOf(U.pm, pid);
    for (const n of plan.nodes) {
      if (n.status === 'cancelled') continue;
      if (filter && !filter(n)) continue;
      const r = await setPlan(U.pm, n.id, '2026-11-02', '2026-11-30');
      assert.strictEqual(r.status, 201, `${n.template_key} 写计划: ${r.text}`);
    }
  }
  // C4a 修订批：收口「立项与授权 / 总体范围与批次规划 / 需求确认」的前置是对应内容包已生效（PACKAGE_NOT_EFFECTIVE，plan.js closeBlockers）。
  //   ensureEffective(pid, 'initiation' | 'overall')：经生产路径让立项包（或总体规划包——它会先让立项包生效）生效，项目没有需求部门参与方时先补一个；已有生效版本则不动。
  //   总体规划生效会按各节点当前计划形成基线，所以调用前先 planAll；生效后这些节点的计划修改走改期规则（要原因与证据）。
  async function ensureEffective(pid, which) {
    const C = T.confirm;
    if (!(await sqlGet("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' LIMIT 1", [pid]))) await C.seedParty(pid, '甲部', U.own, U.del);
    const eff = (type) => sqlGet("SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = ? AND v.status = 'effective'", [pid, type]);
    if (which === 'overall') {
      if (!(await eff('overall'))) await C.produceEffectiveOverall(pid);
    } else if (!(await eff('initiation'))) {
      await C.produceEffectiveInitiation(pid);
    }
  }
  //   夹具版（本文件里只有「actions 同源」用）：直接写立项包与总体规划包的生效版本，不形成基线。该用例要对每个节点的每个标志各调用一次对应端点，
  //   总体规划经生产路径生效后节点带基线，设计划标志为真时的执行要原因与证据（400），会改变用例要验证的东西，所以这里用夹具并在用例名里注明。
  async function seedEffectivePackagesFixture(pid) {
    await T.confirm.seedEffectiveInitiation(pid);
    const pk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, NULL, 'overall', ?)", [pid, U.pm])).lastID;
    await sqlRun(
      "INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, 'overall_batch_req', 'effective', datetime('now','localtime'), '{}', ?)",
      [pk, U.pm]
    );
    // 本批批次验收包也生效（夹具：批次验收包的提交 C6 才开放）——否则迭代到 b_uat 时「收口」标志为真、执行却被 PACKAGE_NOT_EFFECTIVE 挡住
    const batchId = await defaultBatchId(pid);
    const pa = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, 'batch_accept', ?)", [pid, batchId, U.pm])).lastID;
    await sqlRun(
      "INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, 'effective', datetime('now','localtime'), '{}', ?)",
      [pa, U.pm]
    );
  }
  // 「今天」以服务端为准（预筛 L9）：用一个专用项目开始一个节点，读返回的实际开始日期。进程内夹具注入固定的 todayProvider（getFixedToday），
  //   实例模式下服务端用本机本地日期，用例不自己取墙钟；用到相对今天的日期（逾期天数）也基于这个值。
  let cachedToday = null;
  async function serverToday() {
    if (cachedToday) return cachedToday;
    const pid = await newProject('inhouse');
    const r = await startNode(U.pm, await idOf(pid, 'p_initiation'));
    assert.strictEqual(r.status, 200, r.text);
    cachedToday = r.body.node.actual_start;
    const fixed = T.getFixedToday ? T.getFixedToday() : null;
    if (fixed) assert.strictEqual(cachedToday, fixed, '进程内夹具注入的 todayProvider 必须生效（服务端记的实际日期 = 注入值）');
    return cachedToday;
  }
  // 直接写库插一条已暂存的附件行（夹具：真实暂存是 multipart 上传，由 verify-sysbuild-attachments.js 覆盖；这里只需要一个「本人在本项目暂存、未绑定」的附件，
  //   供改期的 bindStagedAttachments 校验与绑定）。
  async function stageAttachment(pid, uid) {
    attSeq += 1;
    const r = await sqlRun(
      "INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (?, ?, '证据.txt', 'text/plain', 3, ?, 0, ?)",
      [pid, `c3a-${runTag}-${attSeq}.txt`, 'a'.repeat(64), uid]
    );
    return r.lastID;
  }
  // C4a 交接 ②：原夹具①（直接插 effective 的总体规划版本 + baseline）已全部改走生产路径——T.confirm.produceEffectiveOverall(pid)：
  //   补需求部门参与方 + 总体规划包草稿，提交并由各必需确认人确认后生效，生效时按各节点当前计划形成基线；生效之后尚无基线的节点第一次设计划 = 基线。

  // ── 手写期望：动作 → 项目状态类别（rules.OP_KIND）与状态表 close 行 ─────────────────────────────
  test('rules：OP_KIND 与状态表——键集合与 OBJECT_OPS 全等；每个动作的类别手写核对；close 行四态手写；checkOp 对未登记动作 500', async () => {
    const R = T.getMods().rules;
    const expected = {
      party_add: 'membership', party_rename: 'membership', member_add: 'membership', member_remove: 'membership',
      party_people: 'membership', appointment_end: 'membership', delegation_revoke: 'membership',
      batch_update: 'maintain', node_start: 'maintain', node_close: 'close', node_reopen: 'maintain', node_cancel: 'maintain',
      node_rename: 'maintain', node_add: 'maintain', node_reorder: 'maintain', schedule_plan: 'maintain', schedule_correct: 'maintain',
      // C3b 新动作（本测试断言键集合全等，随 OBJECT_OPS 同步；C3b 围栏外的一处改动，见 C3b 报告「偏离」；#212 C7 起模块 / 条目 / 条目集合修订的七个键删除）
      package_create: 'maintain', package_version_create: 'maintain', package_version_edit: 'maintain',
      material_version_create: 'maintain', // C8材料候选版本仍是维护类，不因只追加而允许已终止/结项写入。
      // C4a 新动作（同上：本测试断言键集合全等，随 OBJECT_OPS 同步）
      package_version_submit: 'maintain', package_version_withdraw: 'maintain', confirm_reissue: 'maintain', confirm_decide: 'accept',
      // C5 S-S1a 登记与办理（同上：随 OBJECT_OPS 同步；类别手写：写登记按时段分 register_process / register_supplement，其余办理 = resolve 行）；#212 C6 起办理动作只剩更正与作废，
      //   办理规则键（结论 / 仅供参考 / 标记 / 交裁定 / 知会异议 / 结论确认 / 拆分 / 归属 / 记单号 / 对已有结论提异议 / 改期知会异议，共 15 个）随 S4 / S7 删除
      entry_create_process: 'register_process', entry_create_supplement: 'register_supplement',
      opinion_create: 'maintain', opinion_triage: 'maintain', opinion_assess: 'maintain',
      opinion_dispose: 'maintain', opinion_cut_decide: 'accept', opinion_cut_withdraw: 'maintain',
      work_task_create: 'maintain', work_task_result: 'maintain',
      entry_correct: 'resolve', entry_void: 'resolve',
      // C5 S-S1c（同上：随 OBJECT_OPS 同步；类别手写）：写开发方关键事项（C6 后只服务进度汇报登记权限）= accept（已终止 / 已结项否）；挂靠变更 / 建变更 / 变更出新版本三个规则随 C5 删除
      entry_create_dev: 'accept',
      // C6a（同上：随 OBJECT_OPS 同步；类别手写，矩阵在 sysbuild-api-suite-golive.js 的 rules 用例）：确认试运行结束 = golive 行（只有进行中）；撤销上线 = maintain
      golive: 'golive', revoke_golive: 'maintain',
    };
    assert.deepStrictEqual(Object.keys(R.OP_KIND).sort(), Object.keys(expected).sort(), 'OP_KIND 键集合');
    assert.deepStrictEqual(Object.keys(R.OP_KIND).sort(), Object.keys(R.OBJECT_OPS).sort(), 'OP_KIND 与 OBJECT_OPS 全等');
    for (const [op, kind] of Object.entries(expected)) assert.strictEqual(R.OP_KIND[op], kind, `${op} 的类别`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.PROJECT_ACTION_TABLE.close)), { active: true, paused: false, terminated: false, closed: false }, 'close 行');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.PROJECT_ACTION_TABLE.maintain)), { active: true, paused: true, terminated: false, closed: false }, 'maintain 行');
    for (const [st, ok] of [['active', true], ['paused', false], ['terminated', false], ['closed', false]]) assert.strictEqual(R.projectAllowsWrite(st, 'close'), ok, `close × ${st}`);
    assert.throws(() => R.checkOp('no_such_op', { isPm: true }, { status: 'active' }, {}), (e) => e.status === 500 && e.code === 'SYSBUILD_INTERNAL', '未登记动作必须 500，不得有缺省类别');
  });

  // 预筛 L4：加载断言要有直接测试——把 rules.js 的源码改成「OP_KIND 缺一项 / 类别不在状态表 / 多一项」后在原目录下编译，加载必须抛错；原样编译必须不抛。
  test('rules：OP_KIND 加载断言——OP_KIND 缺一项、类别不在状态表、多出未知动作的 rules 副本加载即抛错；原样加载不抛', async () => {
    const Module = require('module');
    const fs = require('fs');
    const path = require('path');
    const dir = T.getModuleDir();
    const file = path.join(dir, 'rules.js');
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const load = (text) => {
      const m = new Module(file, module);
      m.filename = file;
      m.paths = Module._nodeModulePaths(dir);
      m._compile(text, file);
      return m.exports;
    };
    const anchor = "  node_close: 'close',";
    assert.strictEqual(src.split(anchor).length - 1, 1, '锚点应恰好出现一次');
    assert.doesNotThrow(() => load(src), '原样加载不抛');
    assert.throws(() => load(src.replace(`${anchor}\n`, '')), (e) => /OP_KIND/.test(e.message) && /node_close/.test(e.message), '缺 node_close');
    assert.throws(() => load(src.replace(anchor, "  node_close: 'no_such_kind',")), (e) => /OP_KIND/.test(e.message), '类别不在状态表');
    assert.throws(() => load(src.replace(anchor, `${anchor}\n  no_such_op: 'maintain',`)), (e) => /OP_KIND/.test(e.message) && /no_such_op/.test(e.message), '多出未知动作');
  });
  // H1：模板表保持，项目层结项是唯一需检查确认的阶段。
  test('收口前置：普通阶段无内容包条件，仅项目层结项保留', async () => {
    const dir = T.getModuleDir();
    const planMod = require(require('path').join(dir, 'plan.js'));
    const tpl = require(require('path').join(dir, 'templates.js'));
    const keys = new Set([...tpl.PROJECT_NODES.map((x) => x.key), ...Object.values(tpl.BATCH_NODES).flatMap((arr) => arr.map((x) => x.key))]);
    for (const key of keys) {
      const node = { id: 1, batch_id: key.startsWith('b_') ? 7 : null, template_key: key, status: 'in_progress' };
      const blockers = planMod.closeBlockers(node, {});
      if (key === 'p_closing') assert.ok(blockers.some((b) => b.code === 'PACKAGE_NOT_EFFECTIVE'));
      else assert.deepStrictEqual(blockers, [], key + ' 普通阶段没有包或计划前置');
    }
  });

  // ── 1 建项带出结构 ───────────────────────────────────────────────────────────────────────────
  test('建项带出结构：三种建设方式——默认批次恰 1 个、项目层节点集合（自研无 p_contract）、批次层模板键与顺序、里程碑恰一个且键正确、合并节点 g_stage、事件 batch_created ×1 与 node_created × 节点数', async () => {
    for (const bt of ['outsource', 'procurement', 'inhouse']) {
      const pid = await newProject(bt);
      const plan = await planOf(U.pm, pid);
      const { estimated_completion: completion, ...planProject } = plan.project;
      assert.deepStrictEqual(planProject, { id: pid, build_type: bt, status: 'active', golive_progress: { live: 0, total: 1 } });
      assert.deepStrictEqual([completion.date, completion.days_remaining, completion.tone, completion.delay_days], [null, null, null, null]);
      assert.match(completion.as_of, /^\d{4}-\d\d-\d\d$/);
      assert.strictEqual(plan.batches.length, 1, `${bt} 默认批次恰 1 个`);
      const b = plan.batches[0];
      assert.deepStrictEqual({ seq: b.seq, name: b.name, is_default: b.is_default, status: b.status, dev: b.dev_assignee_member_id }, { seq: 1, name: '第 1 批', is_default: true, status: 'planning', dev: null });
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_batches WHERE project_id = ?', [pid])).n, 1);
      const projectNodes = plan.nodes.filter((n) => n.batch_id === null).sort((x, y) => x.sort_order - y.sort_order);
      assert.deepStrictEqual(projectNodes.map((n) => n.template_key), PROJECT_KEYS[bt], `${bt} 项目层节点集合与顺序`);
      for (const n of projectNodes) {
        const [name, g, sort] = PROJECT_TPL[n.template_key];
        assert.deepStrictEqual([n.name, n.g_stage, n.sort_order, n.is_golive_milestone, n.status], [name, g, sort, false, 'not_started'], `${bt} ${n.template_key}`);
      }
      const batchNodes = plan.nodes.filter((n) => n.batch_id === b.id).sort((x, y) => x.sort_order - y.sort_order);
      assert.deepStrictEqual(batchNodes.map((n) => [n.template_key, n.name, n.g_stage, n.is_golive_milestone]), BATCH_TPL[bt], `${bt} 批次层节点（键 / 名称 / g_stage / 里程碑）与顺序`);
      assert.deepStrictEqual(batchNodes.map((n) => n.sort_order), BATCH_TPL[bt].map((_, i) => (i + 1) * 10), `${bt} sort_order 10、20…`);
      const milestones = plan.nodes.filter((n) => n.is_golive_milestone);
      assert.strictEqual(milestones.length, 1, `${bt} 里程碑恰一个`);
      assert.strictEqual(milestones[0].template_key, MILESTONE_KEY[bt], `${bt} 里程碑键`);
      assert.strictEqual(plan.nodes.some((n) => n.g_stage === 'G7'), false, '第一期不生成 G7');
      const total = projectNodes.length + batchNodes.length;
      assert.strictEqual(plan.nodes.length, total);
      assert.strictEqual((await eventsOf(pid, 'batch_created')).length, 1);
      const created = await payloads(pid, 'node_created');
      assert.strictEqual(created.length, total, `${bt} node_created 条数`);
      assert.deepStrictEqual(created.map((p) => p.template_key).sort(), [...PROJECT_KEYS[bt], ...BATCH_TPL[bt].map((x) => x[0])].sort());
      const mile = created.find((p) => p.template_key === MILESTONE_KEY[bt]);
      assert.deepStrictEqual(mile, { template_key: MILESTONE_KEY[bt], name: BATCH_TPL[bt].find((x) => x[3])[1], g_stage: BATCH_TPL[bt].find((x) => x[3])[2], batch_id: b.id, is_golive_milestone: true, source: 'template' });
      const expectedEvents = [
        ...PROJECT_KEYS[bt].map((key) => ({ template_key: key, name: PROJECT_TPL[key][0], g_stage: PROJECT_TPL[key][1], batch_id: null, is_golive_milestone: false, source: 'template' })),
        ...BATCH_TPL[bt].map(([key, name, g, milestone]) => ({ template_key: key, name, g_stage: g, batch_id: b.id, is_golive_milestone: milestone, source: 'template' })),
      ];
      assert.deepStrictEqual(created, expectedEvents, `${bt} 节点事件按模板写入顺序完整核对`);
      assert.deepStrictEqual((await payloads(pid, 'batch_created'))[0], { seq: 1, name: '第 1 批', is_default: true });
      // PM 的初始动作标志：可开始、不可收口 / 重开 / 取消里程碑
      const firstBatchNode = keyOf(plan, BATCH_TPL[bt][0][0]);
      assert.strictEqual(firstBatchNode.actions.start, true, `${bt} 新建阶段无需计划和节奏即可开始`);
      if (bt === 'inhouse') {
        assert.strictEqual((await startNode(U.pm, firstBatchNode.id)).status, 200, '自研开发节点可先开工');
        assert.strictEqual((await startNode(U.pm, keyOf(plan, 'p_initiation').id)).status, 200, '立项节点可以开始');
      }
      assert.strictEqual(firstBatchNode.actions.close, false);
      assert.strictEqual(firstBatchNode.actions.reopen, false);
      assert.strictEqual(firstBatchNode.actions.cancel, true);
      assert.strictEqual(keyOf(plan, MILESTONE_KEY[bt]).actions.cancel, false, '里程碑不可取消');
    }
  });

  // ── 2 PATCH build_type ──────────────────────────────────────────────────────────────────────
  test('PATCH 项目：带 build_type → 400 且库值不变（D44）；不带时其余字段照常可改', async () => {
    const pid = await newProject('outsource');
    for (const v of ['inhouse', 'outsource', 'zzz']) {
      const r = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { build_type: v });
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `build_type=${v}`);
      assert.strictEqual(r.body.field, 'build_type');
    }
    expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '夹带', build_type: 'inhouse' }), 400, 'SYSBUILD_INVALID_INPUT', '夹带 build_type');
    const row = await sqlGet('SELECT build_type, goal FROM sysbuild_projects WHERE id = ?', [pid]);
    assert.deepStrictEqual(row, { build_type: 'outsource', goal: null }, '被拒的请求不改任何列');
    const ok = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '新目标', phase_name: '二期' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(ok.body.changed.sort(), ['goal', 'phase_name']);
    assert.strictEqual(ok.body.project.build_type, 'outsource');
    assert.deepStrictEqual(await sqlGet('SELECT build_type, goal, phase_name FROM sysbuild_projects WHERE id = ?', [pid]), { build_type: 'outsource', goal: '新目标', phase_name: '二期' });
  });

  // ── 3 开始 / 收口 / 重开 基本流 ────────────────────────────────────────────────────────────────
  test('开始 / 收口 / 重开：状态、opened_at / closed_at、actual 记录、事件手写核对；重复开始 / 未开始收口 409；无前置的节点不被其他节点缺计划阻塞', async () => {
    const pid = await newProject('outsource');
    const nid = await idOf(pid, 'b_design');
    const day = await serverToday();
    let r = await closeNode(U.pm, nid);
    expectErr(r, 409, 'SYSBUILD_STATE', '未开始就收口');
    r = await startNode(U.pm, nid);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.node.status, 'in_progress');
    assert.strictEqual(r.body.node.actual_start, day);
    assert.strictEqual(r.body.node.actual_end, null);
    let row = await nodeRow(nid);
    assert.ok(row.opened_at && row.closed_at === null, 'opened_at 已写、closed_at 空');
    expectErr(await startNode(U.pm, nid), 409, 'SYSBUILD_STATE', '重复开始');
    r = await closeNode(U.pm, nid);
    assert.strictEqual(r.status, 200, `b_design 没有计划也能收口（缺计划只阻塞 b_req / p_overall）: ${r.text}`);
    assert.strictEqual(r.body.node.status, 'closed');
    assert.strictEqual(r.body.node.actual_end, day);
    row = await nodeRow(nid);
    assert.ok(row.closed_at, 'closed_at 已写');
    let recs = await recordsOf(nid);
    assert.deepStrictEqual(recs.map((x) => [x.kind, x.actual_date]), [['actual_start', day], ['actual_end', day]]);
    assert.ok(recs.every((x) => x.created_by === U.pm));
    expectErr(await closeNode(U.pm, nid), 409, 'SYSBUILD_STATE', '重复收口');
    expectErr(await reopenNode(U.pm, nid), 400, 'SYSBUILD_INVALID_INPUT', '重开缺原因');
    expectErr(await reopenNode(U.pm, nid, '   '), 400, 'SYSBUILD_INVALID_INPUT', '重开原因空白');
    expectErr(await reopenNode(U.pm, nid, 'x'.repeat(501)), 400, 'SYSBUILD_INVALID_INPUT', '重开原因 501 字');
    r = await reopenNode(U.pm, nid, '  验收发现问题  ');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.node.status, 'in_progress');
    assert.strictEqual(r.body.node.actual_end, null, '重开后实际结束为空');
    row = await nodeRow(nid);
    assert.strictEqual(row.closed_at, null);
    assert.ok(row.opened_at, '重开保留 opened_at');
    recs = await recordsOf(nid);
    assert.strictEqual(recs.length, 2, '重开不写实际记录（历史保留）');
    expectErr(await reopenNode(U.pm, nid, '再重开'), 409, 'SYSBUILD_STATE', '进行中不能重开');
    assert.deepStrictEqual(await payloads(pid, 'node_started'), [{ actual_date: day }]);
    assert.deepStrictEqual(await payloads(pid, 'node_closed'), [{ actual_date: day }]);
    assert.deepStrictEqual(await payloads(pid, 'node_reopened'), [{ reason: '验收发现问题' }]);
    assert.deepStrictEqual((await eventsOf(pid, 'node_started')).map((e) => [e.object_type, e.object_id, e.operator_id]), [['node', nid, U.pm]]);
    assert.strictEqual((await eventsOf(pid, 'node_cascade_reopened')).length, 0, '没有后续已收口节点，不写级联事件');
    const sched = await get(U.pm, `/sysbuild/nodes/${nid}/schedule`);
    assert.strictEqual(sched.status, 200, sched.text);
    assert.deepStrictEqual(sched.body.records.map((x) => x.kind), ['actual_start', 'actual_end']);
    assert.deepStrictEqual(sched.body.records.map((x) => x.attachment_ids), [[], []]);
    assert.deepStrictEqual(sched.body.node, { id: nid, name: '设计阶段', status: 'in_progress' });
  });

  // ── 4 暂停 ─────────────────────────────────────────────────────────────────────────────────
  test('暂停：开始、改名、改计划、重开允许；收口 409 SYSBUILD_PROJECT_READONLY 且节点不变；plan 里 actions.close=false 而 start / schedule_plan 为真；恢复后收口成功', async () => {
    const pid = await newProject('outsource');
    const design = await idOf(pid, 'b_design');
    const dev = await idOf(pid, 'b_dev');
    const uat = await idOf(pid, 'b_uat');
    await T.confirm.prepareDevStart(pid, dev); // L2 §10：暂停矩阵仅测项目状态，显式备好开发开始门。
    assert.strictEqual((await startNode(U.pm, design)).status, 200);
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    expectErr(await closeNode(U.pm, design), 409, 'SYSBUILD_PROJECT_READONLY', '暂停时收口');
    assert.strictEqual((await nodeRow(design)).status, 'in_progress', '被拒的收口不改节点');
    assert.strictEqual((await recordsOf(design)).length, 1, '被拒的收口不写 actual_end');
    assert.strictEqual((await startNode(U.pm, dev)).status, 200, '暂停时可开始');
    assert.strictEqual((await patch(U.pm, `/sysbuild/nodes/${dev}`, { name: '开发完成（暂停中改名）' })).status, 200, '暂停时可改名');
    assert.strictEqual((await setPlan(U.pm, dev, '2026-11-03', '2026-11-20')).status, 201, '暂停时可改计划');
    const plan = await planOf(U.pm, pid);
    const nDesign = plan.nodes.find((n) => n.id === design);
    assert.strictEqual(nDesign.actions.close, false, '暂停时不给收口按钮');
    assert.strictEqual(nDesign.actions.schedule_plan, true);
    assert.strictEqual(nDesign.actions.rename, true);
    assert.strictEqual(plan.nodes.find((n) => n.id === uat).actions.start, true);
    assert.strictEqual(plan.project.status, 'paused');
    // 暂停时重开允许（maintain）：先恢复收口一个，再暂停重开
    assert.strictEqual((await setStatus(pid, 'active')).status, 200);
    const closed = await closeNode(U.pm, design);
    assert.strictEqual(closed.status, 200, `恢复后收口成功: ${closed.text}`);
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    const re = await reopenNode(U.pm, design, '暂停期间重开');
    assert.strictEqual(re.status, 200, `暂停时重开允许: ${re.text}`);
  });

  // ── 5 终止 / 已结项 ────────────────────────────────────────────────────────────────────────────
  test('终止与已结项：全部写动作 409 SYSBUILD_PROJECT_READONLY，节点 / 批次 actions 全 false（夹具：已结项状态直接写库——结项由 C6 的整体结项产生，C3a 没有生产路径）', async () => {
    for (const final of ['terminated', 'closed']) {
      const pid = await newProject('outsource');
      const closedNode = await idOf(pid, 'b_design');
      const running = await idOf(pid, 'b_dev');
      const idle = await idOf(pid, 'b_uat');
      assert.strictEqual((await startNode(U.pm, closedNode)).status, 200);
      assert.strictEqual((await closeNode(U.pm, closedNode)).status, 200);
      await T.confirm.prepareDevStart(pid, running);
      assert.strictEqual((await startNode(U.pm, running)).status, 200);
      const batchId = await defaultBatchId(pid);
      if (final === 'terminated') assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
      else await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [pid]);
      const order = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
      const calls = [
        ['开始', () => startNode(U.pm, idle)],
        ['收口', () => closeNode(U.pm, running)],
        ['重开', () => reopenNode(U.pm, closedNode, '终止后重开')],
        ['取消', () => cancelNode(U.pm, idle, '终止后取消')],
        ['改名', () => patch(U.pm, `/sysbuild/nodes/${idle}`, { name: '改名' })],
        ['新增节点', () => post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: '新节点' })],
        ['重排', () => post(U.pm, `/sysbuild/batches/${batchId}/node-order`, { node_ids: order })],
        ['改计划', () => setPlan(U.pm, idle, '2026-11-02', '2026-11-09')],
        ['更正实际', () => post(U.pm, `/sysbuild/nodes/${running}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '更正' })],
        ['批次改名', () => patch(U.pm, `/sysbuild/batches/${batchId}`, { name: '改名批次' })],
      ];
      for (const [label, fn] of calls) expectErr(await fn(), 409, 'SYSBUILD_PROJECT_READONLY', `${final} ${label}`);
      const plan = await planOf(U.pm, pid);
      for (const n of plan.nodes) {
        assert.deepStrictEqual(Object.keys(n.actions).sort(), NODE_FLAGS, `${final} ${n.template_key} actions 标志集合`);
        assert.deepStrictEqual(NODE_FLAGS.map((f) => n.actions[f]), NODE_FLAGS.map(() => false), `${final} ${n.template_key} actions 全 false`);
      }
      for (const b of plan.batches) assert.deepStrictEqual(b.actions, { update: false, add_node: false, reorder: false, golive: false, revoke_golive: false }); // C6a：批次 actions 另有 golive / revoke_golive
      assert.strictEqual((await nodeRow(idle)).status, 'not_started');
    }
  });

  // ── 6 收口前置 ─────────────────────────────────────────────────────────────────────────────
  test('收口前置：需求调研、范围、立项、验收没有计划和确认前置', async () => {
    for (const [buildType, keys] of [['procurement', ['b_req', 'p_overall', 'p_initiation']], ['outsource', ['b_uat']]]) {
      const pid = await newProject(buildType);
      const base = await planOf(U.pm, pid);
      for (const key of keys) {
        const nid = keyOf(base, key).id;
        assert.deepStrictEqual(keyOf(base, key).close_blockers, []);
        assert.strictEqual((await startNode(U.pm, nid)).status, 200);
        const view = keyOf(await planOf(U.pm, pid), key);
        assert.deepStrictEqual(view.close_blockers, []);
        assert.strictEqual(view.actions.close, true);
        const close = await closeNode(U.pm, nid);
        assert.strictEqual(close.status, 200, close.text);
        assert.strictEqual((await nodeRow(nid)).status, 'closed');
        assert.deepStrictEqual((await recordsOf(nid)).map((row) => row.kind), ['actual_start', 'actual_end']);
      }
    }
  });

  // ── 7 里程碑 ───────────────────────────────────────────────────────────────────────────────
  test('里程碑：进行中的里程碑收口 409、取消 409（actions.close / cancel 为 false）；自研里程碑是 b_golive', async () => {
    const pid = await newProject('outsource');
    const mile = await idOf(pid, 'b_trial');
    let r = await cancelNode(U.pm, mile, '想取消');
    expectErr(r, 409, 'SYSBUILD_STATE', '未开始的里程碑取消');
    assert.ok(/里程碑/.test(r.body.message), r.body.message);
    assert.strictEqual((await startNode(U.pm, mile)).status, 200, '里程碑可以开始');
    r = await closeNode(U.pm, mile);
    expectErr(r, 409, 'SYSBUILD_STATE', '里程碑收口');
    assert.ok(/上线事件/.test(r.body.message), r.body.message);
    assert.strictEqual((await nodeRow(mile)).status, 'in_progress');
    const v = keyOf(await planOf(U.pm, pid), 'b_trial');
    assert.strictEqual(v.actions.close, false);
    assert.strictEqual(v.actions.cancel, false);
    assert.strictEqual((await recordsOf(mile)).length, 1, '被拒的收口不写 actual_end');
    const pid2 = await newProject('inhouse');
    const m2 = await idOf(pid2, 'b_golive');
    assert.strictEqual((await startNode(U.pm, m2)).status, 200);
    expectErr(await closeNode(U.pm, m2), 409, 'SYSBUILD_STATE', '自研里程碑收口');
  });

  // 预筛 M2：「里程碑不能重开」要被单独钉住，不能被 live 检查遮蔽——批次保持 planning（非 live），只有里程碑规则能拒绝。
  test('里程碑：已收口的里程碑不能重开（夹具：里程碑直接写成已收口，批次非 live）——409 提示含「里程碑」且不含「批次已正式上线」；reopen 标志为 false', async () => {
    const pid = await newProject('outsource');
    const mile = await idOf(pid, 'b_trial');
    // 夹具：里程碑已收口（正式上线事件在后续提交产生）；批次保持默认的 planning
    await sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = '2026-10-30 10:00:00', closed_at = '2026-10-30 11:00:00' WHERE id = ?", [mile]);
    assert.strictEqual((await sqlGet('SELECT b.status AS s FROM sysbuild_batches b JOIN sysbuild_nodes n ON n.batch_id = b.id WHERE n.id = ?', [mile])).s, 'planning');
    const r = await reopenNode(U.pm, mile, '想重开里程碑');
    expectErr(r, 409, 'SYSBUILD_STATE', '里程碑重开（批次非 live）');
    assert.ok(/里程碑/.test(r.body.message) && /撤销上线/.test(r.body.message), r.body.message);
    assert.ok(!/批次已正式上线/.test(r.body.message), `不应是 live 检查的提示: ${r.body.message}`);
    assert.strictEqual((await nodeRow(mile)).status, 'closed');
    assert.strictEqual((await eventsOf(pid, 'node_reopened')).length, 0);
    assert.strictEqual((await planOf(U.pm, pid)).nodes.find((n) => n.id === mile).actions.reopen, false);
  });

  // 为级联场景加一个已存在节点之前的普通批次节点，保持同批次与排序的判别力。
  async function prependBatchNode(pid) {
    const batchId = await defaultBatchId(pid);
    const plan = await planOf(U.pm, pid);
    const oldOrder = plan.nodes.filter((node) => node.batch_id === batchId).map((node) => node.id);
    const created = await post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: '前置普通节点', g_stage: 'G1' });
    assert.strictEqual(created.status, 201, created.text);
    const first = created.body.node.id;
    const reordered = await post(U.pm, `/sysbuild/batches/${batchId}/node-order`, { node_ids: [first, ...oldOrder] });
    assert.strictEqual(reordered.status, 200, reordered.text);
    return first;
  }

  // ── 8 单节点重开 ─────────────────────────────────────────────────────────────────────────────
  test('重开只改当前阶段：同层、不同层与兄弟项目原样', async () => {
    const pid = await newProject('outsource');
    const earlier = await prependBatchNode(pid);
    const plan = await planOf(U.pm, pid);
    const id = (k) => keyOf(plan, k).id;
    const [design, dev, tst] = [id('b_design'), id('b_dev'), id('b_test')];
    // 先给两层全部节点写计划，再让排在 A 之前的普通节点保持已收口。
    await planAll(pid);
    await ensureEffective(pid, 'overall'); // 收口 p_initiation / p_overall 的内容包前置。
    // 预筛 L11：自建兄弟项目，让「级联只限本项目」不靠别的用例遗留的数据——兄弟项目的项目层 p_overall（sort 30）已收口，
    //   项目层节点的 batch_id 都是 NULL，级联 SQL 若丢了 project_id 条件，重开本项目 p_initiation 时会把它也退回。
    const sibling = await newProject('outsource');
    await planAll(sibling);
    await ensureEffective(sibling, 'overall');
    const sibOverall = await idOf(sibling, 'p_overall');
    assert.strictEqual((await startNode(U.pm, sibOverall)).status, 200);
    assert.strictEqual((await closeNode(U.pm, sibOverall)).status, 200);
    assert.strictEqual((await startNode(U.pm, earlier)).status, 200);
    assert.strictEqual((await closeNode(U.pm, earlier)).status, 200);
    for (const k of ['b_design', 'b_dev', 'b_test']) {
      if (k === 'b_dev') await T.confirm.prepareDevStart(pid, id(k));
      assert.strictEqual((await startNode(U.pm, id(k))).status, 200, k);
      assert.strictEqual((await closeNode(U.pm, id(k))).status, 200, `${k} 收口`);
    }
    // 项目层：立项已收口（sort 10），用于证明批次层重开不波及项目层
    assert.strictEqual((await startNode(U.pm, id('p_initiation'))).status, 200);
    assert.strictEqual((await closeNode(U.pm, id('p_initiation'))).status, 200);
    // b_uat 保持未开始：级联只动已收口的
    const r = await reopenNode(U.pm, design, '设计返工');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.cascaded_node_ids, []);
    assert.strictEqual((await nodeRow(dev)).status, 'closed');
    assert.strictEqual((await nodeRow(tst)).status, 'closed');
    for (const nid of [design]) {
      const row = await nodeRow(nid);
      assert.strictEqual(row.status, 'in_progress');
      assert.strictEqual(row.closed_at, null);
    }
    assert.strictEqual((await nodeRow(earlier)).status, 'closed', '排在 A 之前的节点不受影响');
    assert.strictEqual((await nodeRow(id('p_initiation'))).status, 'closed', '项目层节点不受影响');
    assert.strictEqual((await nodeRow(id('b_uat'))).status, 'not_started', '未收口的节点不动');
    assert.deepStrictEqual(await payloads(pid, 'node_reopened'), [{ reason: '设计返工' }]);
    const casc = await eventsOf(pid, 'node_cascade_reopened');
    assert.deepStrictEqual(casc, []);
    assert.strictEqual((await recordsOf(dev)).filter((x) => x.kind.startsWith('actual_')).length, 2, '级联不写实际记录（只有开始 / 收口各一条；另有一条是 planAll 写的计划）');
    // 重新按顺序收口后，重开中间节点只级联它之后的
    assert.strictEqual((await closeNode(U.pm, design)).status, 200);
    const r2 = await reopenNode(U.pm, dev, '开发返工');
    assert.strictEqual(r2.status, 200, r2.text);
    assert.deepStrictEqual(r2.body.cascaded_node_ids, []);
    assert.strictEqual((await nodeRow(tst)).status, 'closed');
    assert.strictEqual((await nodeRow(design)).status, 'closed', '更早的节点不退回');
    // 项目层重开：p_overall（sort 30）已收口 → 重开 p_initiation（sort 10）只级联项目层，批次层已收口节点不动
    assert.strictEqual((await startNode(U.pm, id('p_overall'))).status, 200);
    assert.strictEqual((await closeNode(U.pm, id('p_overall'))).status, 200);
    const r3 = await reopenNode(U.pm, id('p_initiation'), '立项补充');
    assert.strictEqual(r3.status, 200, r3.text);
    assert.deepStrictEqual(r3.body.cascaded_node_ids, []);
    assert.strictEqual((await nodeRow(id('p_overall'))).status, 'closed');
    assert.strictEqual((await nodeRow(design)).status, 'closed', '项目层重开不波及批次层');
    assert.strictEqual((await nodeRow(earlier)).status, 'closed');
    assert.strictEqual((await nodeRow(sibOverall)).status, 'closed', '级联只限本项目：兄弟项目的项目层节点不受影响');
    assert.strictEqual((await eventsOf(sibling, 'node_cascade_reopened')).length, 0);
  });

  test('重开普通阶段不修改已关闭的里程碑，自身仍受原规则', async () => {
    const pid = await newProject('inhouse');
    const req = await prependBatchNode(pid);
    await planAll(pid);
    await ensureEffective(pid, 'overall'); // 批次经合并包生效进入 active。
    const dev = await idOf(pid, 'b_dev');
    const mile = await idOf(pid, 'b_golive');
    for (const nid of [req, dev]) {
      if (nid === dev) await T.confirm.prepareDevStart(pid, dev);
      assert.strictEqual((await startNode(U.pm, nid)).status, 200);
      assert.strictEqual((await closeNode(U.pm, nid)).status, 200);
    }
    // 夹具：里程碑已收口（正式上线事件在后续提交；这里批次保持 active（合并包生效时由 planning 推进，M-1），不是 live，免得被 live 检查遮蔽）
    await sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = '2026-10-30 10:00:00', closed_at = '2026-10-30 11:00:00' WHERE id = ?", [mile]);
    const r = await reopenNode(U.pm, req, '需求变化');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await nodeRow(req)).status, 'in_progress');
    assert.strictEqual((await nodeRow(dev)).status, 'closed', '整个重开不发生：中间节点仍已收口');
    assert.strictEqual((await nodeRow(mile)).status, 'closed');
    assert.strictEqual((await eventsOf(pid, 'node_reopened')).length, 1);
    assert.strictEqual((await eventsOf(pid, 'node_cascade_reopened')).length, 0);
    // 中间节点 dev 排在里程碑之前，重开它同样会级联到里程碑，同样被拦
    assert.strictEqual((await reopenNode(U.pm, dev, '只重开开发')).status, 200);
    expectErr(await reopenNode(U.pm, mile, '不能重开里程碑'), 409, 'SYSBUILD_STATE');
  });

  // ── 预筛 D3 → C6a：p_closing 的收口随整体结项实现（对象规则不再拒绝，前置在 closeBlockers；成功路径与项目转入已结项见 sysbuild-api-suite-golive.js）──────────────────────────
  test('整体验收结项（D3 → C6a）：p_closing 进行中走节点收口端点，结项包未生效且批次未正式上线 → 409 SYSBUILD_CLOSE_BLOCKED（blockers 列出两项）；close 标志只承诺权限与状态（为真），卡片缺项使标志为假；节点与记录不变；项目状态不变', async () => {
    const pid = await newProject('outsource');
    const closing = await idOf(pid, 'p_closing');
    assert.deepStrictEqual(keyOf(await planOf(U.pm, pid), 'p_closing').close_blockers, [], '只有进行中的节点展示结项阻塞');
    assert.strictEqual((await startNode(U.pm, closing)).status, 200, 'p_closing 可以开始');
    const r = await closeNode(U.pm, closing);
    expectErr(r, 409, 'SYSBUILD_CLOSE_BLOCKED', 'p_closing 收口');
    assert.deepStrictEqual(r.body.blockers.map((b) => b.code), ['REQUIRED_CARDS_INCOMPLETE'], '结项包未生效 + 批次未正式上线（项目整体没有未结登记）');
    assert.ok(r.body.blockers[0].message.includes('结项 · 结项确认'), r.body.blockers[0].message);
    assert.ok(r.body.blockers[0].message.includes('第 1 批'), r.body.blockers[0].message);
    assert.strictEqual((await nodeRow(closing)).status, 'in_progress');
    assert.strictEqual((await recordsOf(closing)).length, 1, '被拒的收口不写 actual_end');
    const cn = (await planOf(U.pm, pid)).nodes.find((n) => n.id === closing);
    assert.strictEqual(cn.actions.close, false, '卡片缺项正式阻止收口');
    assert.deepStrictEqual(cn.close_blockers.map((b) => b.code), ['REQUIRED_CARDS_INCOMPLETE'], '读接口的阻塞项与收口端点同一个函数');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_projects WHERE id = ?', [pid])).status, 'active', '被拒不结项');
    // 其他项目层节点（p_initiation）不受影响（收口它的前置：立项包已生效）
    const init = await idOf(pid, 'p_initiation');
    await ensureEffective(pid, 'initiation');
    assert.strictEqual((await startNode(U.pm, init)).status, 200);
    assert.strictEqual((await closeNode(U.pm, init)).status, 200);
  });

  // ── 9 夹具 live ────────────────────────────────────────────────────────────────────────────
  test('夹具 live：批次已正式上线——重开本批节点 409、取消 / 新增 / 重排 409；里程碑已收口不可重开；actions 同步为 false', async () => {
    const pid = await newProject('outsource');
    const batchId = await defaultBatchId(pid);
    const design = await idOf(pid, 'b_design');
    const uat = await idOf(pid, 'b_uat');
    const mile = await idOf(pid, 'b_trial');
    assert.strictEqual((await startNode(U.pm, design)).status, 200);
    assert.strictEqual((await closeNode(U.pm, design)).status, 200);
    // 夹具：批次 live、里程碑已收口（C3a 无法经生产路径到达，上线事件在后续提交）
    await sqlRun("UPDATE sysbuild_batches SET status = 'live' WHERE id = ?", [batchId]);
    await sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = '2026-10-30 10:00:00', closed_at = '2026-10-30 11:00:00' WHERE id = ?", [mile]);
    const order = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
    let r = await reopenNode(U.pm, design, '上线后想重开');
    expectErr(r, 409, 'SYSBUILD_STATE', 'live 重开');
    assert.ok(/撤销上线/.test(r.body.message), r.body.message);
    assert.strictEqual((await nodeRow(design)).status, 'closed');
    r = await reopenNode(U.pm, mile, '重开里程碑');
    expectErr(r, 409, 'SYSBUILD_STATE', '里程碑重开');
    assert.ok(/撤销上线/.test(r.body.message), r.body.message);
    expectErr(await cancelNode(U.pm, uat, '上线后取消'), 409, 'SYSBUILD_STATE', 'live 取消');
    assert.strictEqual((await nodeRow(uat)).status, 'not_started');
    expectErr(await post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: '上线后新增' }), 409, 'SYSBUILD_STATE', 'live 新增');
    expectErr(await post(U.pm, `/sysbuild/batches/${batchId}/node-order`, { node_ids: [...order].reverse() }), 409, 'SYSBUILD_STATE', 'live 重排');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_nodes WHERE batch_id = ?', [batchId])).n, order.length, '被拒的新增不留行');
    const plan = await planOf(U.pm, pid);
    assert.strictEqual(plan.nodes.find((n) => n.id === design).actions.reopen, false);
    assert.strictEqual(plan.nodes.find((n) => n.id === mile).actions.reopen, false);
    assert.strictEqual(plan.nodes.find((n) => n.id === uat).actions.cancel, false);
    assert.deepStrictEqual(plan.batches[0].actions, { update: true, add_node: false, reorder: false, golive: false, revoke_golive: false }, 'live 批次仍可改名 / 承接人（C6a：golive 为假——批次不是进行中；revoke_golive 为假——本用例读的是 PM，撤销上线只有 admin）');
    // live 批次的节点仍可开始、改名（规则只限制重开 / 取消 / 增删 / 重排）
    assert.strictEqual((await startNode(U.pm, uat)).status, 200);
    assert.strictEqual((await patch(U.pm, `/sysbuild/nodes/${uat}`, { name: '上线后改名' })).status, 200);
  });

  // ── 10 取消 ────────────────────────────────────────────────────────────────────────────────
  test('取消：未开始可取消（原因必填）；进行中 409；项目层节点 409；取消后 actions 全 false、改计划 / 改名 409；事件手写核对', async () => {
    const pid = await newProject('outsource');
    const uat = await idOf(pid, 'b_test');
    const dev = await idOf(pid, 'b_dev');
    const contract = await idOf(pid, 'p_contract');
    const init = await idOf(pid, 'p_initiation');
    expectErr(await cancelNode(U.pm, uat), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await cancelNode(U.pm, uat, '  '), 400, 'SYSBUILD_INVALID_INPUT', '原因空白');
    const r = await cancelNode(U.pm, uat, '  本批不做验收测试  ');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.node.status, 'cancelled');
    assert.deepStrictEqual(Object.keys(r.body.node.actions).sort(), NODE_FLAGS, '取消后 actions 标志集合');
    assert.deepStrictEqual(NODE_FLAGS.map((f) => r.body.node.actions[f]), NODE_FLAGS.map(() => false), '取消后 actions 全 false');
    assert.deepStrictEqual(await payloads(pid, 'node_cancelled'), [{ reason: '本批不做验收测试' }]);
    expectErr(await setPlan(U.pm, uat, '2026-11-02', '2026-11-09'), 409, 'SYSBUILD_STATE', '取消后改计划');
    expectErr(await patch(U.pm, `/sysbuild/nodes/${uat}`, { name: '改名' }), 409, 'SYSBUILD_STATE', '取消后改名');
    expectErr(await startNode(U.pm, uat), 409, 'SYSBUILD_STATE', '取消后开始');
    expectErr(await cancelNode(U.pm, uat, '再取消'), 409, 'SYSBUILD_STATE', '重复取消');
    await T.confirm.prepareDevStart(pid, dev);
    assert.strictEqual((await startNode(U.pm, dev)).status, 200);
    expectErr(await cancelNode(U.pm, dev, '进行中取消'), 409, 'SYSBUILD_STATE', '进行中取消');
    assert.strictEqual((await nodeRow(dev)).status, 'in_progress', '被拒的取消不改节点');
    const pr = await cancelNode(U.pm, contract, '想取消合同');
    expectErr(pr, 409, 'SYSBUILD_STATE', '项目层未开始节点取消');
    assert.ok(/项目层/.test(pr.body.message), pr.body.message);
    assert.strictEqual((await nodeRow(contract)).status, 'not_started');
    assert.strictEqual((await startNode(U.pm, init)).status, 200);
    const pr2 = await cancelNode(U.pm, init, '想取消立项');
    expectErr(pr2, 409, 'SYSBUILD_STATE', '项目层进行中节点取消');
    assert.ok(/项目层/.test(pr2.body.message), '项目层判断先于状态判断：' + pr2.body.message);
    assert.strictEqual((await eventsOf(pid, 'node_cancelled')).length, 1);
  });

  // ── 11 新增 / 改名 / 重排 ──────────────────────────────────────────────────────────────────────
  test('新增 + 改名 + 重排：新增追加在末尾（sort_order = 最大 + 10）、非里程碑、事件 source=custom；g_stage 与名称校验；改名同名不写事件；重排缺 / 多 / 重复 / 他批节点 → 400，成功后 sort_order 按新顺序', async () => {
    const pid = await newProject('outsource');
    const batchId = await defaultBatchId(pid);
    const url = `/sysbuild/batches/${batchId}/nodes`;
    const templateCount = BATCH_TPL.outsource.length;
    const r = await post(U.pm, url, { name: '  数据迁移演练  ', g_stage: 'G3' });
    assert.strictEqual(r.status, 201, r.text);
    const nn = r.body.node;
    assert.deepStrictEqual([nn.name, nn.g_stage, nn.sort_order, nn.template_key, nn.is_golive_milestone, nn.status, nn.batch_id], ['数据迁移演练', 'G3', (templateCount + 1) * 10, null, false, 'not_started', batchId]);
    const evs = await payloads(pid, 'node_created');
    assert.deepStrictEqual(evs[evs.length - 1], { template_key: null, name: '数据迁移演练', g_stage: 'G3', batch_id: batchId, is_golive_milestone: false, source: 'custom' });
    const r2 = await post(U.pm, url, { name: '无环节节点' });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.deepStrictEqual([r2.body.node.g_stage, r2.body.node.sort_order], [null, (templateCount + 2) * 10]);
    const count = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_nodes WHERE batch_id = ?', [batchId])).n;
    assert.strictEqual(await count(), templateCount + 2);
    for (const [body, field, label] of [
      [{ name: '   ' }, 'name', '名称空白'], [{}, 'name', '缺名称'], [{ name: 'n'.repeat(61) }, 'name', '名称 61 字'], [{ name: 5 }, 'name', '名称非文本'],
      [{ name: 'x', g_stage: 'G9' }, 'g_stage', 'G9'], [{ name: 'x', g_stage: 'G2+G3' }, 'g_stage', '合并写法不对自定义节点开放'], [{ name: 'x', g_stage: 3 }, 'g_stage', '非文本'], [{ name: 'x', foo: 1 }, 'foo', '多余的键'],
    ]) {
      const rr = await post(U.pm, url, body);
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, field, `${label} 的 field`);
    }
    assert.strictEqual(await count(), templateCount + 2, '被拒的新增不留行');
    for (const g of ['G0', 'CONTRACT', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) assert.strictEqual((await post(U.pm, url, { name: `环节${g}`, g_stage: g })).status, 201, g);
    assert.strictEqual((await post(U.pm, url, { name: 'n'.repeat(60) })).status, 201, '名称 60 字通过');
    assert.strictEqual(await count(), templateCount + 2 + 9 + 1, '通过的新增各写一行');
    // 改名
    const nid = nn.id;
    let rn = await patch(U.pm, `/sysbuild/nodes/${nid}`, { name: '  数据迁移（改名）  ' });
    assert.strictEqual(rn.status, 200, rn.text);
    assert.strictEqual(rn.body.node.name, '数据迁移（改名）');
    assert.strictEqual(rn.body.changed, true);
    assert.deepStrictEqual(await payloads(pid, 'node_renamed'), [{ before: '数据迁移演练', after: '数据迁移（改名）' }]);
    rn = await patch(U.pm, `/sysbuild/nodes/${nid}`, { name: '数据迁移（改名）' });
    assert.strictEqual(rn.status, 200);
    assert.strictEqual(rn.body.changed, false);
    assert.strictEqual((await eventsOf(pid, 'node_renamed')).length, 1, '同名不写事件');
    for (const [body, label] of [[{ name: '' }, '空'], [{ name: 'n'.repeat(61) }, '61 字'], [{}, '缺名称'], [{ name: 'x', g_stage: 'G1' }, '多余的键']]) {
      expectErr(await patch(U.pm, `/sysbuild/nodes/${nid}`, body), 400, 'SYSBUILD_INVALID_INPUT', `改名 ${label}`);
    }
    assert.strictEqual((await patch(U.pm, `/sysbuild/nodes/${await idOf(pid, 'b_trial')}`, { name: '试运行结束（改名）' })).status, 200, '里程碑可改名');
    // 重排：含已取消节点的整批
    const uat = await idOf(pid, 'b_test');
    assert.strictEqual((await cancelNode(U.pm, uat, '本批不做')).status, 200);
    const cur = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((x) => x.id);
    const orderUrl = `/sysbuild/batches/${batchId}/node-order`;
    const otherProjectNode = await idOf(pid, 'p_overall');
    for (const [ids, label] of [
      [cur.slice(1), '缺一个（含已取消节点的整批才算）'], [[...cur, otherProjectNode], '多一个他批（项目层）节点'], [[...cur.slice(0, -1), cur[0]], '重复'],
      [[...cur.slice(0, -1), otherProjectNode], '换成他批节点'], [[...cur, cur[0]], '多一个重复'], [[], '空数组'],
    ]) {
      expectErr(await post(U.pm, orderUrl, { node_ids: ids }), 400, 'SYSBUILD_INVALID_INPUT', `重排 ${label}`);
    }
    expectErr(await post(U.pm, orderUrl, { node_ids: 'abc' }), 400, 'SYSBUILD_INVALID_INPUT', '重排非数组');
    expectErr(await post(U.pm, orderUrl, {}), 400, 'SYSBUILD_INVALID_INPUT', '重排缺 node_ids');
    expectErr(await post(U.pm, orderUrl, { node_ids: [0, ...cur.slice(1)] }), 400, 'SYSBUILD_INVALID_INPUT', '重排编号不合法');
    const after = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((x) => x.id);
    assert.deepStrictEqual(after, cur, '被拒的重排不改顺序');
    assert.strictEqual((await eventsOf(pid, 'nodes_reordered')).length, 0);
    const reversed = [...cur].reverse();
    const ro = await post(U.pm, orderUrl, { node_ids: reversed });
    assert.strictEqual(ro.status, 200, ro.text);
    const rows = await sqlAll('SELECT id, sort_order FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order', [batchId]);
    assert.deepStrictEqual(rows.map((x) => x.id), reversed);
    assert.deepStrictEqual(rows.map((x) => x.sort_order), reversed.map((_, i) => (i + 1) * 10), 'sort_order 重写为 10、20…');
    assert.deepStrictEqual(await payloads(pid, 'nodes_reordered'), [{ before: cur, after: reversed }]);
    const noop = await post(U.pm, orderUrl, { node_ids: reversed });
    assert.strictEqual(noop.status, 200);
    assert.strictEqual(noop.body.changed, false);
    assert.strictEqual((await eventsOf(pid, 'nodes_reordered')).length, 1, '顺序不变不写事件');
    // 字符串编号也只收十进制正整数
    expectErr(await post(U.pm, orderUrl, { node_ids: reversed.map((x) => `${x}x`) }), 400, 'SYSBUILD_INVALID_INPUT', '重排字符串编号');
  });

  // ── 12 草稿期计划 ──────────────────────────────────────────────────────────────────────────────
  test('草稿期计划：可反复改，当前计划 = 最后一条且不形成基线；原因可选（缺省写固定文案）；日期非法 / 起 > 止 / 与当前相同 / 带改期专用字段 → 400；已收口且无基线仍可补计划（D1）、生产路径生效形成 baseline 后已收口 409；已取消 409；事件带 draft 标记；逾期天数', async () => {
    const pid = await newProject('outsource');
    const design = await idOf(pid, 'b_design');
    const dev = await idOf(pid, 'b_dev');
    let r = await setPlan(U.pm, design, '2026-11-02', '2026-11-10');
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.node.current_plan, { start: '2026-11-02', end: '2026-11-10' });
    assert.strictEqual(r.body.node.baseline, null);
    assert.strictEqual(r.body.node.diff_days, null);
    r = await setPlan(U.pm, design, '2026-11-03', '2026-11-12', { reason: '  排期顺延  ' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.node.current_plan, { start: '2026-11-03', end: '2026-11-12' }, '当前计划 = 最后一条');
    const recs = await recordsOf(design);
    assert.deepStrictEqual(recs.map((x) => [x.kind, x.planned_start, x.planned_end, x.reason]), [
      ['plan_change', '2026-11-02', '2026-11-10', '草稿期计划'], ['plan_change', '2026-11-03', '2026-11-12', '排期顺延'],
    ]);
    assert.ok(recs.every((x) => x.no_written_evidence === 0 && x.source_party_id === null));
    const evs = await payloads(pid, 'node_plan_set');
    assert.strictEqual(evs.length, 2);
    // 预筛 D6：事件里的原因与库内记录一致（没填写固定文案），并标 draft: true
    assert.deepStrictEqual(evs[0], { record_id: recs[0].id, before: null, after: { start: '2026-11-02', end: '2026-11-10' }, reason: '草稿期计划', draft: true });
    assert.deepStrictEqual(evs[1], { record_id: recs[1].id, before: { start: '2026-11-02', end: '2026-11-10' }, after: { start: '2026-11-03', end: '2026-11-12' }, reason: '排期顺延', draft: true });
    assert.strictEqual((await eventsOf(pid, 'node_rescheduled')).length, 0, '草稿期不是改期');
    const bad = [
      [{ planned_start: '2026-13-01', planned_end: '2026-12-01' }, 'planned_start', '月份 13'], [{ planned_start: '2026-11-02', planned_end: '2026-02-30' }, 'planned_end', '2 月 30 日'],
      [{ planned_start: '2026-11-10', planned_end: '2026-11-02' }, 'planned_end', '起 > 止'], [{ planned_end: '2026-11-02' }, 'planned_start', '缺起'], [{ planned_start: '2026-11-02' }, 'planned_end', '缺止'],
      [{ planned_start: '1999-12-31', planned_end: '2026-11-02' }, 'planned_start', '1999 年'], [{ planned_start: '20261102', planned_end: '20261110' }, 'planned_start', '无连字符'],
      [{ planned_start: '2026-11-03', planned_end: '2026-11-12' }, 'planned_start', '与当前计划相同'],
      [{ planned_start: '2026-11-02', planned_end: '2026-11-09', source_party_id: 1 }, 'body', '草稿期带提出方'],
      [{ planned_start: '2026-11-02', planned_end: '2026-11-09', no_written_evidence: true }, 'body', '草稿期带无书面证据'],
      [{ planned_start: '2026-11-02', planned_end: '2026-11-09', reason: 'x'.repeat(501) }, 'reason', '原因 501 字'],
    ];
    for (const [body, field, label] of bad) {
      const rr = await post(U.pm, `/sysbuild/nodes/${design}/schedule`, Object.assign({ kind: 'plan' }, body));
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, field, `${label} 的 field`);
    }
    expectErr(await post(U.pm, `/sysbuild/nodes/${design}/schedule`, { planned_start: '2026-11-02', planned_end: '2026-11-09' }), 400, 'SYSBUILD_INVALID_INPUT', '缺 kind');
    expectErr(await post(U.pm, `/sysbuild/nodes/${design}/schedule`, { kind: 'baseline', planned_start: '2026-11-02', planned_end: '2026-11-09' }), 400, 'SYSBUILD_INVALID_INPUT', 'kind=baseline 不接受');
    assert.strictEqual((await recordsOf(design)).length, 2, '被拒的请求不留记录');
    // 逾期天数：未收口且计划止 < 今天（「今天」以服务端为准，进程内夹具注入固定值）。放在总体规划生效之前：生效后写计划走改期式写入（要原因与证据，H-1 / P43），不再是草稿期。
    const today = await serverToday();
    r = await setPlan(U.pm, dev, addDays(today, -10), addDays(today, -3));
    assert.strictEqual(r.body.node.overdue_days, 3, '未开始且计划止早于今天 3 天');
    await T.confirm.prepareDevStart(pid, dev);
    assert.strictEqual((await startNode(U.pm, dev)).body.node.overdue_days, 3, '进行中同样逾期');
    r = await setPlan(U.pm, dev, addDays(today, -2), today);
    assert.strictEqual(r.body.node.overdue_days, 0, '计划止 = 今天不算逾期');
    r = await setPlan(U.pm, dev, addDays(today, -2), addDays(today, 5));
    assert.strictEqual(r.body.node.overdue_days, 0);
    r = await setPlan(U.pm, dev, addDays(today, -9), addDays(today, -1));
    assert.strictEqual(r.body.node.overdue_days, 1);
    const closedDev = await closeNode(U.pm, dev);
    assert.strictEqual(closedDev.status, 200, closedDev.text);
    assert.strictEqual(closedDev.body.node.overdue_days, 0, '已收口不算逾期');
    // 预筛 D1：已收口的节点「还没有 baseline」时仍可补草稿期计划（否则缺计划的已收口节点会永久挡住 b_req / p_overall 收口）；已有 baseline 后已收口节点 409；已取消 409。
    assert.strictEqual((await startNode(U.pm, design)).status, 200);
    assert.strictEqual((await closeNode(U.pm, design)).status, 200);
    const closedPlan = await setPlan(U.pm, design, '2026-12-01', '2026-12-09');
    assert.strictEqual(closedPlan.status, 201, `已收口且无基线的节点可补草稿期计划: ${closedPlan.text}`);
    assert.deepStrictEqual(closedPlan.body.node.current_plan, { start: '2026-12-01', end: '2026-12-09' });
    assert.strictEqual(closedPlan.body.node.status, 'closed', '补计划不改节点状态');
    assert.strictEqual(closedPlan.body.node.actions.schedule_plan, true);
    // C4a 交接 ②：该节点形成 baseline 改走生产路径（总体规划包提交 + 全部确认，生效时按当前计划形成基线）后，已收口节点不能再改计划
    const acceptance = await idOf(pid, 'b_uat');
    assert.strictEqual((await setPlan(U.pm, acceptance, '2026-12-01', '2026-12-09')).status, 201);
    await T.confirm.produceEffectiveOverall(pid);
    assert.strictEqual((await recordsOf(design)).filter((x) => x.kind === 'baseline').length, 0);
    await T.confirm.acceptEffective(pid, await defaultBatchId(pid));
    assert.strictEqual((await startNode(U.pm, acceptance)).status, 200);
    assert.strictEqual((await closeNode(U.pm, acceptance)).status, 200);
    const designBase = await recordsOf(acceptance);
    assert.deepStrictEqual(designBase.filter((x) => x.kind === 'baseline').map((x) => [x.planned_start, x.planned_end]), [['2026-12-01', '2026-12-09']], '生效时按最后一条草稿计划形成基线');
    expectErr(await setPlan(U.pm, acceptance, '2026-12-02', '2026-12-10'), 409, 'SYSBUILD_STATE', '已收口且有基线改计划');
    assert.strictEqual((await planOf(U.pm, pid)).nodes.find((n) => n.id === acceptance).actions.schedule_plan, false);
    const uat = await idOf(pid, 'b_test');
    assert.strictEqual((await cancelNode(U.pm, uat, '不做')).status, 200);
    expectErr(await setPlan(U.pm, uat, '2026-12-01', '2026-12-09'), 409, 'SYSBUILD_STATE', '已取消改计划');
  });

  // ── 13 夹具 baseline 改期 ──────────────────────────────────────────────────────────────────────
  test('baseline 改期（生产路径生效后）：缺原因 400；无证据 400 SYSBUILD_EVIDENCE_REQUIRED；无书面证据原因 < 10 字 400；带暂存附件成功且绑定 owner_type=schedule_record；开发方来源 409；成功后当前计划 = 新值、基线不变、差值正确', async () => {
    const pid = await newProject('outsource');
    const dev = await idOf(pid, 'p_closing');
    // 基线经实际确认路径形成；推迟结项的计划止须提供证据。
    //   （修订批三 H-1 撤销了「生效后首次设计划直接写基线」，所以不能再先生效、后设计划）
    assert.strictEqual((await setPlan(U.pm, dev, '2026-11-01', '2026-11-20')).status, 201);
    await T.confirm.produceEffectiveOverall(pid);
    const url = `/sysbuild/nodes/${dev}/schedule`;
    const plan = (start, end, extra) => post(U.pm, url, Object.assign({ kind: 'plan', planned_start: start, planned_end: end }, extra || {}));
    let v = keyOf(await planOf(U.pm, pid), 'p_closing');
    assert.deepStrictEqual([v.baseline, v.current_plan, v.diff_days], [{ start: '2026-11-01', end: '2026-11-20' }, { start: '2026-11-01', end: '2026-11-20' }, 0]);
    // 缺原因
    expectErr(await plan('2026-11-01', '2026-11-25', { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' }), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    // 无证据
    expectErr(await plan('2026-11-01', '2026-11-25', { reason: '需求变化' }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '无证据');
    expectErr(await plan('2026-11-01', '2026-11-25', { reason: '需求变化', attachment_ids: [] }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '空附件列表');
    expectErr(await plan('2026-11-01', '2026-11-25', { reason: '需求变化', no_written_evidence: false }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', 'no_written_evidence=false');
    // 无书面证据原因不足 10 字
    let rr = await plan('2026-11-01', '2026-11-25', { reason: '需求变化', no_written_evidence: true, no_evidence_reason: '口头说的' });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '原因不足 10 字');
    assert.strictEqual(rr.body.field, 'no_evidence_reason');
    expectErr(await plan('2026-11-01', '2026-11-25', { reason: '需求变化', no_written_evidence: true }), 400, 'SYSBUILD_INVALID_INPUT', '声明无书面证据却无原因');
    // 预筛 M1：用真实暂存附件——附件不存在时会被绑定校验的 400 遮蔽，删掉「附件与无书面证据互斥」这条规则也仍是 400，用例就没有判别力。
    //   断言：被拒、记录数不变、附件没被绑定（仍可用于之后的提交）。
    const mutexAtt = await stageAttachment(pid, U.pm);
    rr = await plan('2026-11-01', '2026-11-25', { reason: '需求变化', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排', attachment_ids: [mutexAtt] });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '附件与无书面证据同时给');
    assert.strictEqual(rr.body.field, 'no_written_evidence');
    assert.strictEqual((await recordsOf(dev)).length, 2, '互斥被拒：记录数不变（草稿期计划 + 生效时形成的 baseline）');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [mutexAtt])).n, 0, '互斥被拒：附件未被绑定');
    rr = await plan('2026-11-01', '2026-11-25', { reason: '需求变化', no_evidence_reason: '口头电话确认了本次顺延安排' });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '未声明却给原因');
    assert.strictEqual(rr.body.field, 'no_evidence_reason', '与「无证据」(EVIDENCE_REQUIRED) 区分：给了原因却没声明');
    expectErr(await plan('2026-11-01', '2026-11-20', { reason: '需求变化', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' }), 400, 'SYSBUILD_INVALID_INPUT', '与当前计划相同');
    assert.strictEqual((await recordsOf(dev)).length, 2, '被拒的请求不留记录（只有草稿期计划与生效时形成的 baseline）');
    // 开发方来源 409；需求方来源可以；他项目参与方 400
    const devParty = await addParty(pid, '开发商', 'dev');
    const demandParty = await addParty(pid, '财务部', 'demand');
    const otherPid = await newProject('inhouse');
    const foreign = await addParty(otherPid, '外部门', 'demand');
    const goodEvidence = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' };
    // C6（R2，甲类）：开发方来源的改期不再要求引用已认可的关键事项（旧版 409 SYSBUILD_STATE 随 R2 取消），不带 dev_key_entry_id 的开发方来源改期成功——断言移到「C6 R2」用例的 R2-ctl-resched-dev-nokey；本用例不再核这一条（避免它写一条记录改变下面的记录数）
    rr = await plan('2026-11-01', '2026-11-25', Object.assign({ reason: '需求变化', source_party_id: foreign }, goodEvidence));
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '他项目参与方');
    assert.strictEqual(rr.body.field, 'source_party_id');
    assert.strictEqual((await recordsOf(dev)).length, 2);
    // 成功 1：无书面证据 + 需求方来源
    let ok = await plan('2026-11-01', '2026-11-25', Object.assign({ reason: '  业务方要求加做一项  ', source_party_id: demandParty }, goodEvidence));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.node.baseline, ok.body.node.current_plan, ok.body.node.diff_days], [{ start: '2026-11-01', end: '2026-11-20' }, { start: '2026-11-01', end: '2026-11-25' }, 5]);
    let recs = await recordsOf(dev);
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual([recs[2].kind, recs[2].reason, recs[2].source_party_id, recs[2].no_written_evidence, recs[2].no_evidence_reason, recs[2].created_by], ['plan_change', '业务方要求加做一项', demandParty, 1, '口头电话确认了本次顺延安排', U.pm]);
    let ev = await payloads(pid, 'node_rescheduled');
    assert.deepStrictEqual(ev[0], {
      record_id: recs[2].id, before: { start: '2026-11-01', end: '2026-11-20' }, after: { start: '2026-11-01', end: '2026-11-25' }, reason: '业务方要求加做一项',
      source_party_id: demandParty, no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排', attachment_ids: [],
    });
    // 成功 2：暂存附件；PM / 信息技术部提出（来源空）
    const att = await stageAttachment(pid, U.pm);
    ok = await plan('2026-11-01', '2026-11-15', { reason: '提前上线', attachment_ids: [att] });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([ok.body.node.current_plan, ok.body.node.diff_days, ok.body.node.baseline], [{ start: '2026-11-01', end: '2026-11-15' }, -5, { start: '2026-11-01', end: '2026-11-20' }]);
    recs = await recordsOf(dev);
    assert.deepStrictEqual([recs[3].source_party_id, recs[3].no_written_evidence, recs[3].no_evidence_reason], [null, 0, null]);
    const bind = await sqlGet('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att]);
    assert.deepStrictEqual(bind, { owner_type: 'schedule_record', owner_id: recs[3].id, bound_by: U.pm });
    assert.strictEqual((await eventsOf(pid, 'attachment_bound')).filter((event) => event.object_id === att).length, 1);
    ev = await payloads(pid, 'node_rescheduled');
    assert.deepStrictEqual(ev[1].attachment_ids, [att]);
    // 他人的暂存附件 / 同一附件重复使用 → 400，记录不留
    const theirs = await stageAttachment(pid, U.m1);
    expectErr(await plan('2026-11-01', '2026-11-16', { reason: '再改', attachment_ids: [theirs] }), 400, 'SYSBUILD_INVALID_INPUT', '他人上传的附件');
    expectErr(await plan('2026-11-01', '2026-11-16', { reason: '再改', attachment_ids: [att] }), 400, 'SYSBUILD_INVALID_INPUT', '附件已被使用');
    assert.strictEqual((await recordsOf(dev)).length, 4, '附件校验失败整体回滚（记录不留）');
    // 读接口：证据标记与绑定附件编号
    const sched = await get(U.pm, url);
    assert.strictEqual(sched.status, 200, sched.text);
    assert.deepStrictEqual(sched.body.records.map((x) => [x.kind, x.no_written_evidence, x.attachment_ids]), [['plan_change', false, []], ['baseline', false, []], ['plan_change', true, []], ['plan_change', false, [att]]]);
    assert.strictEqual(sched.body.records[1].package_version_id > 0, true);
    // 基线不变（至多一条 baseline）
    assert.strictEqual((await sqlGet("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [dev])).n, 1);
    // 总体规划生效后，新增节点先保存初始计划，改期从下一条开始。
    const added = await post(U.pm, `/sysbuild/batches/${await defaultBatchId(pid)}/nodes`, { name: '生效后新增的节点' });
    assert.strictEqual(added.status, 201, added.text);
    const addedId = added.body.node.id;
    const noBase = await setPlan(U.pm, addedId, '2026-11-02', '2026-11-09');
    assert.strictEqual(noBase.status, 201, noBase.text);
    const noBaseOk = await setPlan(U.pm, addedId, '2026-11-02', '2026-11-10', { reason: '调整新增节点排期' });
    assert.strictEqual(noBaseOk.status, 201, noBaseOk.text);
    assert.deepStrictEqual((await recordsOf(addedId)).map((x) => x.kind), ['plan_change', 'plan_change']);
    assert.strictEqual((await payloads(pid, 'node_rescheduled')).length, 3);
  });

  // ── 14 实际更正 ────────────────────────────────────────────────────────────────────────────────
  test('实际更正：无原记录 409；更正后读接口取更正值；重开后实际结束为空（历史保留）、再收口取新值；缺原因 / 日期非法 / corrects 非法 400；已取消 409', async () => {
    const pid = await newProject('outsource');
    const nid = await idOf(pid, 'b_design');
    const url = `/sysbuild/nodes/${nid}/schedule`;
    const correct = (corrects, date, reason) => post(U.pm, url, Object.assign({ kind: 'actual_correct', corrects, actual_date: date }, reason === undefined ? {} : { reason }));
    expectErr(await correct('actual_start', '2026-10-01', '补录'), 409, 'SYSBUILD_STATE', '未开始无实际开始');
    assert.strictEqual((await recordsOf(nid)).length, 0);
    assert.strictEqual((await startNode(U.pm, nid)).status, 200);
    // 预筛 M3：进行中的节点更正实际结束不生效（实际结束仅收口时取值）——要求节点已收口，否则 409，不留一条看不见的记录；读接口标志按种类拆开。
    const early = await correct('actual_end', '2026-10-05', '补录');
    expectErr(early, 409, 'SYSBUILD_STATE', '进行中节点更正实际结束');
    assert.ok(/已收口/.test(early.body.message), early.body.message);
    assert.strictEqual((await recordsOf(nid)).length, 1, '被拒的更正不留记录（只有开始那一条）');
    assert.strictEqual((await eventsOf(pid, 'node_actual_corrected')).length, 0, '被拒的更正不写事件');
    const flagsOf = async () => (await planOf(U.pm, pid)).nodes.find((n) => n.id === nid).actions;
    let fl = await flagsOf();
    assert.strictEqual('schedule_correct' in fl, false, '旧的合并标志不再返回');
    assert.deepStrictEqual([fl.correct_actual_start, fl.correct_actual_end], [true, false], '进行中：可更正实际开始，不可更正实际结束');
    expectErr(await correct('actual_start', '2026-10-01'), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await correct('actual_start', '2026-02-30', '日期错'), 400, 'SYSBUILD_INVALID_INPUT', '日期非法');
    expectErr(await correct('baseline', '2026-10-01', '错'), 400, 'SYSBUILD_INVALID_INPUT', 'corrects 非法');
    expectErr(await correct(undefined, '2026-10-01', '错'), 400, 'SYSBUILD_INVALID_INPUT', '缺 corrects');
    let r = await correct('actual_start', '2026-10-01', '  当时漏记  ');
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.node.actual_start, '2026-10-01', '读接口取更正值');
    let recs = await recordsOf(nid);
    assert.deepStrictEqual([recs[1].kind, recs[1].corrects_kind, recs[1].actual_date, recs[1].reason, recs[1].planned_start], ['actual_correct', 'actual_start', '2026-10-01', '当时漏记', null]);
    const day = await serverToday();
    assert.deepStrictEqual((await payloads(pid, 'node_actual_corrected'))[0], { record_id: recs[1].id, corrects: 'actual_start', before: day, after: '2026-10-01', reason: '当时漏记' });
    assert.strictEqual(r.body.node.actual_end, null, '未收口实际结束为空');
    assert.strictEqual((await closeNode(U.pm, nid)).status, 200);
    fl = await flagsOf();
    assert.deepStrictEqual([fl.correct_actual_start, fl.correct_actual_end], [true, true], '已收口：两种都可更正');
    // 预筛 D7：更正后实际开始不得晚于实际结束，实际结束不得早于实际开始（已收口时才有实际结束）→ 400，不留记录
    //   （17 号 M-1 起未来日期单独被拒，所以这里先把实际结束更正到较早的过去日期，再造「开始晚于结束」，保证先后校验本身被单独钉住）
    assert.strictEqual((await correct('actual_end', '2026-10-03', '先把结束改早')).status, 201);
    const before = (await recordsOf(nid)).length;
    let rr = await correct('actual_start', '2026-10-04', '想把开始改到收口之后');
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '开始晚于结束');
    assert.strictEqual(rr.body.field, 'actual_date');
    rr = await correct('actual_end', '2026-09-30', '想把结束改到开始之前');
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '结束早于开始');
    assert.strictEqual(rr.body.field, 'actual_date');
    assert.strictEqual((await recordsOf(nid)).length, before, '先后校验被拒不留记录');
    assert.strictEqual((await correct('actual_end', '2026-10-01', '同一天允许')).status, 201, '实际结束 = 实际开始（同一天）允许');
    r = await correct('actual_end', '2026-10-05', '收口日期录错');
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.node.actual_end, '2026-10-05');
    assert.strictEqual(keyOf(await planOf(U.pm, pid), 'b_design').actual_end, '2026-10-05');
    // 重开：实际结束为空，历史记录保留
    r = await reopenNode(U.pm, nid, '返工');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.node.actual_end, null, '重开后实际结束为空');
    assert.strictEqual(r.body.node.actual_start, '2026-10-01', '实际开始保持更正值');
    // 预筛 M3：重开后节点留有历史 actual_end 记录，但当前未收口——更正实际结束必须被拒（否则写入一条不生效的记录），标志同步为 false
    fl = await flagsOf();
    assert.deepStrictEqual([fl.correct_actual_start, fl.correct_actual_end], [true, false], '重开后：可更正实际开始，不可更正实际结束');
    const nBefore = (await recordsOf(nid)).length;
    const reRej = await correct('actual_end', '2026-10-06', '重开后想更正结束');
    expectErr(reRej, 409, 'SYSBUILD_STATE', '重开后更正实际结束');
    assert.ok(/已收口/.test(reRej.body.message), reRej.body.message);
    assert.strictEqual((await recordsOf(nid)).length, nBefore, '被拒的更正不留记录');
    recs = await recordsOf(nid);
    assert.deepStrictEqual(recs.map((x) => x.kind), ['actual_start', 'actual_correct', 'actual_end', 'actual_correct', 'actual_correct', 'actual_correct']);
    // 再收口：新的 actual_end 取代历史
    r = await closeNode(U.pm, nid);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.node.actual_end, day, '再收口取新值');
    // 已取消
    const uat = await idOf(pid, 'b_test');
    assert.strictEqual((await cancelNode(U.pm, uat, '不做')).status, 200);
    expectErr(await post(U.pm, `/sysbuild/nodes/${uat}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '错' }), 409, 'SYSBUILD_STATE', '已取消');
  });

  // ── codex 17 号 M-1：实际日期不倒置 ────────────────────────────────────────────────────────────
  test('实际日期不倒置（17 号 M-1）：开始后把实际开始更正为未来 → 400（不留记录不写事件）；已收口后把实际结束更正为未来 → 400；「今天」本身允许；重开再收口后实际结束 ≥ 实际开始', async () => {
    const day = await serverToday();
    const future = addDays(day, 1);
    const pid = await newProject('outsource');
    const nid = await idOf(pid, 'b_design');
    const url = `/sysbuild/nodes/${nid}/schedule`;
    const correct = (corrects, date) => post(U.pm, url, { kind: 'actual_correct', corrects, actual_date: date, reason: '更正' });
    assert.strictEqual((await startNode(U.pm, nid)).status, 200);
    let r = await correct('actual_start', future);
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', '把实际开始更正为未来');
    assert.strictEqual(r.body.field, 'actual_date');
    assert.ok(/今天/.test(r.body.message), r.body.message);
    assert.strictEqual((await recordsOf(nid)).length, 1, '被拒的更正不留记录（只有开始那一条）');
    assert.strictEqual((await eventsOf(pid, 'node_actual_corrected')).length, 0, '被拒的更正不写事件');
    // 原链路「开始 → 更正为未来 → 当天收口」被堵住：实际开始仍是今天，收口后实际结束 = 今天 ≥ 实际开始
    r = await closeNode(U.pm, nid);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.node.actual_end >= r.body.node.actual_start, `实际结束 ${r.body.node.actual_end} 不得早于实际开始 ${r.body.node.actual_start}`);
    r = await correct('actual_end', future);
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', '把实际结束更正为未来');
    assert.strictEqual(r.body.field, 'actual_date');
    assert.strictEqual((await correct('actual_start', day)).status, 201, '实际开始更正为今天允许（边界）');
    assert.strictEqual((await correct('actual_end', day)).status, 201, '实际结束更正为今天允许（边界）');
    // 重开 → 再收口：新的实际结束不早于实际开始
    r = await reopenNode(U.pm, nid, '返工');
    assert.strictEqual(r.status, 200, r.text);
    r = await closeNode(U.pm, nid);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.node.actual_end >= r.body.node.actual_start, '重开再收口后实际结束 ≥ 实际开始');
  });

  test('收口防御（17 号 M-1，夹具：进程内把注入的 todayProvider 往回拨；实例模式没有注入点，本用例直接通过）：实际开始晚于收口日期 → 409 且节点不变、不写 actual_end；复原后可收口', async () => {
    const day = await serverToday();
    if (!T.setFixedToday(day)) return; // 实例模式：服务端用本机日期，无法构造
    const pid = await newProject('outsource');
    const nid = await idOf(pid, 'b_design');
    assert.strictEqual((await startNode(U.pm, nid)).status, 200);
    assert.strictEqual((await planOf(U.pm, pid)).nodes.find((n) => n.id === nid).actual_start, day);
    try {
      T.setFixedToday(addDays(day, -5));
      const r = await closeNode(U.pm, nid);
      expectErr(r, 409, 'SYSBUILD_STATE', '实际开始晚于收口日期');
      assert.ok(/实际开始晚于收口日期/.test(r.body.message) && /更正实际开始/.test(r.body.message), r.body.message);
      assert.strictEqual((await nodeRow(nid)).status, 'in_progress', '被拒的收口不改节点');
      assert.deepStrictEqual((await recordsOf(nid)).map((x) => x.kind), ['actual_start'], '被拒的收口不写 actual_end');
      assert.strictEqual((await eventsOf(pid, 'node_closed')).length, 0);
    } finally {
      T.setFixedToday(day);
    }
    const ok = await closeNode(U.pm, nid);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.node.actual_end, day);
  });

  // ── codex 17 号 L-1：请求体不是对象 ──────────────────────────────────────────────────────────
  test('请求体不是对象（17 号 L-1）：数组根值 → 400 field body、不执行（plan.js start / schedule、projects.js PATCH 与建项、membership.js 移出成员与建参与方）；无请求体与空对象照常', async () => {
    const pid = await newProject('outsource');
    const dev = await idOf(pid, 'b_dev');
    const memberRow = await addMember(pid, U.m1);
    const beforeProjects = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects')).n;
    const beforeParties = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ?', [pid])).n;
    for (const bad of [[], ['x'], [{ reason: '原因' }]]) {
      const label = JSON.stringify(bad);
      let r = await post(U.pm, `/sysbuild/nodes/${dev}/start`, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `plan start ${label}`);
      assert.strictEqual(r.body.field, 'body');
      r = await post(U.pm, `/sysbuild/nodes/${dev}/schedule`, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `plan schedule ${label}`);
      assert.strictEqual(r.body.field, 'body');
      r = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `projects PATCH ${label}`);
      assert.strictEqual(r.body.field, 'body');
      r = await post(U.pm, '/sysbuild/projects', bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `projects POST ${label}`);
      assert.strictEqual(r.body.field, 'body');
      r = await post(U.pm, `/sysbuild/members/${memberRow}/remove`, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `membership remove ${label}`);
      assert.strictEqual(r.body.field, 'body');
      r = await post(U.pm, `/sysbuild/projects/${pid}/parties`, bad);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `membership parties ${label}`);
      assert.strictEqual(r.body.field, 'body');
    }
    assert.strictEqual((await nodeRow(dev)).status, 'not_started', '数组请求体不得执行开始');
    assert.strictEqual((await sqlGet('SELECT removed_at FROM sysbuild_members WHERE id = ?', [memberRow])).removed_at, null, '数组请求体不得移出成员');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects')).n, beforeProjects, '数组请求体不得建项');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ?', [pid])).n, beforeParties, '数组请求体不得建参与方');
    assert.strictEqual((await sqlGet('SELECT goal FROM sysbuild_projects WHERE id = ?', [pid])).goal, null);
    // 无请求体照常（按空对象）：start 不需要任何字段
    await T.confirm.prepareDevStart(pid, dev);
    const none = await api(U.pm, 'POST', `/sysbuild/nodes/${dev}/start`);
    assert.strictEqual(none.status, 200, none.text);
    const empty = await post(U.pm, `/sysbuild/nodes/${await idOf(pid, 'b_test')}/start`, {});
    assert.strictEqual(empty.status, 200, empty.text);
  });

  // ── 15 权限────────────────────────────────────────────────────────────────────────────────
  test('权限：一般成员、参与方负责人、只读账号（成员）、只读账号是 PM（夹具：改库换 PM）、admin 未接管 → 全部写动作 403；admin 接管后可写、原 PM 变一般成员 403；非成员读写都 404；只读账号 / admin 可读 plan', async () => {
    const pid = await newProject('outsource');
    await addMember(pid, U.m1);
    await addMember(pid, U.ro);
    // 预筛 L6：参与方现任负责人（本方负责人）不是 PM，同样不能写批次 / 节点 / 排期。
    const ownParty = await addParty(pid, '财务部');
    const ownMember = await addMember(pid, U.own, { party: ownParty });
    await addAppointment(ownParty, ownMember, 'active');
    const batchId = await defaultBatchId(pid);
    const plan = await planOf(U.pm, pid);
    const dev = keyOf(plan, 'b_dev').id;
    const design = keyOf(plan, 'b_design').id;
    const order = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
    assert.strictEqual((await startNode(U.pm, design)).status, 200, '准备：一个进行中节点');
    await T.confirm.prepareDevStart(pid, dev); // L2 §10：权限负例保留，PM 正向标志满足新门。
    const writes = (uid) => [
      ['开始', () => startNode(uid, dev)], ['收口', () => closeNode(uid, design)], ['重开', () => reopenNode(uid, design, '原因')], ['取消', () => cancelNode(uid, dev, '原因')],
      ['改名', () => patch(uid, `/sysbuild/nodes/${dev}`, { name: '改名' })], ['新增', () => post(uid, `/sysbuild/batches/${batchId}/nodes`, { name: '新节点' })],
      ['重排', () => post(uid, `/sysbuild/batches/${batchId}/node-order`, { node_ids: order })], ['改计划', () => setPlan(uid, dev, '2026-11-02', '2026-11-09')],
      ['更正实际', () => post(uid, `/sysbuild/nodes/${design}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '错' })],
      ['批次改名', () => patch(uid, `/sysbuild/batches/${batchId}`, { name: '改名' })],
    ];
    for (const [who, uid] of [['一般成员', U.m1], ['参与方负责人', U.own], ['只读账号（成员）', U.ro], ['admin 未接管', U.admin]]) {
      for (const [label, fn] of writes(uid)) expectErr(await fn(), 403, 'SYSBUILD_FORBIDDEN', `${who} ${label}`);
    }
    // 读：只读账号、admin、成员、负责人都能读 plan，且 actions 全 false
    for (const uid of [U.ro, U.admin, U.m1, U.own]) {
      const p = await planOf(uid, pid);
      for (const n of p.nodes) assert.deepStrictEqual(NODE_FLAGS.map((f) => n.actions[f]), NODE_FLAGS.map(() => false), `uid ${uid} ${n.template_key}`);
      assert.deepStrictEqual(p.batches[0].actions, { update: false, add_node: false, reorder: false, golive: false, revoke_golive: false });
      assert.strictEqual((await get(uid, `/sysbuild/nodes/${dev}/schedule`)).status, 200);
    }
    assert.strictEqual(keyOf(await planOf(U.pm, pid), 'b_dev').actions.start, true, 'PM 自己有');
    // 非成员 404（读写）
    expectErr(await get(U.out, `/sysbuild/projects/${pid}/plan`), 404, 'SYSBUILD_NOT_FOUND', '非成员读 plan');
    expectErr(await get(U.out, `/sysbuild/nodes/${dev}/schedule`), 404, 'SYSBUILD_NOT_FOUND', '非成员读排期');
    for (const [label, fn] of writes(U.out)) expectErr(await fn(), 404, 'SYSBUILD_NOT_FOUND', `非成员 ${label}`);
    expectErr(await get(U.pm, '/sysbuild/projects/99999999/plan'), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
    expectErr(await startNode(U.pm, 99999999), 404, 'SYSBUILD_NOT_FOUND', '节点不存在');
    expectErr(await patch(U.pm, '/sysbuild/batches/99999999', { name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '批次不存在');
    // 参数 400 先于存在性 / 权限
    expectErr(await post(U.out, '/sysbuild/nodes/abc/start'), 400, 'SYSBUILD_INVALID_INPUT', '节点编号非法');
    expectErr(await reopenNode(U.out, dev), 400, 'SYSBUILD_INVALID_INPUT', '参数 400 先于 404');
    // 只读账号是 PM（夹具：改库把 PM 换成只读账号）也不能写
    const roPid = await newProject('inhouse');
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.ro, roPid]);
    const roDev = await idOf(roPid, 'b_dev', U.ro);
    expectErr(await startNode(U.ro, roDev), 403, 'SYSBUILD_FORBIDDEN', '只读账号是 PM');
    assert.strictEqual(keyOf(await planOf(U.ro, roPid), 'b_dev').actions.start, false);
    // admin 接管后可写；原 PM 退为一般成员
    const tk = await post(U.admin, `/sysbuild/projects/${pid}/pm`, { pm_user_id: U.admin, reason: '接管' });
    assert.strictEqual(tk.status, 200, tk.text);
    assert.strictEqual((await startNode(U.admin, dev)).status, 200, '接管后 admin 可写');
    expectErr(await startNode(U.pm, keyOf(await planOf(U.admin, pid), 'b_test').id), 403, 'SYSBUILD_FORBIDDEN', '原 PM 不再是 PM');
  });

  // ── 16 批次 PATCH ──────────────────────────────────────────────────────────────────────────
  test('批次 PATCH：改名；承接人须是开发方已加入成员（需求方成员 / 已移出 / 他项目成员 / 不存在 → 409）；可置空；同值不写事件；参数 400', async () => {
    const pid = await newProject('outsource');
    const batchId = await defaultBatchId(pid);
    const url = `/sysbuild/batches/${batchId}`;
    let r = await patch(U.pm, url, { name: '  一期首批  ' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { batch: { id: batchId, name: '一期首批', dev_assignee_member_id: null }, changed: ['name'] });
    assert.deepStrictEqual(await payloads(pid, 'batch_updated'), [{ before: { name: '第 1 批' }, after: { name: '一期首批' } }]);
    r = await patch(U.pm, url, { name: '一期首批' });
    assert.deepStrictEqual(r.body.changed, []);
    assert.strictEqual((await eventsOf(pid, 'batch_updated')).length, 1, '同值不写事件');
    for (const [body, label] of [[{}, '空体'], [{ name: '' }, '名称空白'], [{ name: 'n'.repeat(61) }, '名称 61 字'], [{ name: 5 }, '名称非文本'], [{ status: 'live' }, '改状态'], [{ name: 'x', seq: 2 }, '夹带 seq'], [{ dev_assignee_member_id: 0 }, '承接人 0'], [{ dev_assignee_member_id: 'abc' }, '承接人非数字']]) {
      expectErr(await patch(U.pm, url, body), 400, 'SYSBUILD_INVALID_INPUT', label);
    }
    assert.strictEqual((await sqlGet('SELECT status, name FROM sysbuild_batches WHERE id = ?', [batchId])).status, 'planning', '改状态被拒');
    // 承接人
    const devParty = await addParty(pid, '开发商', 'dev');
    const demandParty = await addParty(pid, '财务部', 'demand');
    const mDev = await addMember(pid, U.m1, { party: devParty });
    const mDemand = await addMember(pid, U.m2, { party: demandParty });
    const mGone = await addMember(pid, U.cand, { party: devParty, removed: true });
    const otherPid = await newProject('inhouse');
    const otherDev = await addParty(otherPid, '别家开发', 'dev');
    const mOther = await addMember(otherPid, U.x1, { party: otherDev });
    for (const [mid, label] of [[mDemand, '需求方成员'], [mGone, '已移出'], [mOther, '他项目成员'], [99999999, '不存在']]) {
      expectErr(await patch(U.pm, url, { dev_assignee_member_id: mid }), 409, 'SYSBUILD_STATE', `承接人 ${label}`);
    }
    assert.strictEqual((await sqlGet('SELECT dev_assignee_member_id AS d FROM sysbuild_batches WHERE id = ?', [batchId])).d, null);
    r = await patch(U.pm, url, { dev_assignee_member_id: mDev });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.changed, ['dev_assignee_member_id']);
    assert.strictEqual((await planOf(U.pm, pid)).batches[0].dev_assignee_member_id, mDev);
    // 预筛 D5：读接口标「承接人已移出」——承接人有效时 dev_assignee_active 为 true；成员被移出后批次仍指向他，标志变 false，由 PM 重新指定
    assert.strictEqual((await planOf(U.pm, pid)).batches[0].dev_assignee_active, true, '承接人是开发方已加入成员');
    const gone = await post(U.pm, `/sysbuild/members/${mDev}/remove`, { reason: '离项' });
    assert.strictEqual(gone.status, 200, gone.text);
    const afterGone = (await planOf(U.pm, pid)).batches[0];
    assert.strictEqual(afterGone.dev_assignee_member_id, mDev, '不级联改批次：仍指向已移出的成员');
    assert.strictEqual(afterGone.dev_assignee_active, false, '承接人已移出');
    r = await patch(U.pm, url, { name: '两项一起', dev_assignee_member_id: null });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.changed.sort(), ['dev_assignee_member_id', 'name']);
    assert.deepStrictEqual((await payloads(pid, 'batch_updated')).pop(), { before: { name: '一期首批', dev_assignee_member_id: mDev }, after: { name: '两项一起', dev_assignee_member_id: null } });
    assert.strictEqual((await sqlGet('SELECT dev_assignee_member_id AS d FROM sysbuild_batches WHERE id = ?', [batchId])).d, null, '可置空');
    assert.strictEqual((await planOf(U.pm, pid)).batches[0].dev_assignee_active, false, '没有承接人时为 false');
    await sqlRun("UPDATE sysbuild_batches SET status = 'live' WHERE id = ?", [batchId]);
    assert.strictEqual((await patch(U.pm, url, { name: '已上线后改名' })).status, 200);
  });

  // 已上线批次：用私有夹具命中未开始、进行中节点上的批次限制，再走真实上线补验已收口节点。
  test('C8 已上线批次动作矩阵：批次与节点自身限制分别生效', async () => {
    const pid = await newProject('outsource');
    const bid = await defaultBatchId(pid);
    const closed = await idOf(pid, 'b_design');
    const idle = await idOf(pid, 'b_golive');
    const running = await idOf(pid, 'b_dev');
    assert.strictEqual((await startNode(U.pm, closed)).status, 200);
    assert.strictEqual((await closeNode(U.pm, closed)).status, 200);
    await T.confirm.prepareDevStart(pid, running);
    assert.strictEqual((await startNode(U.pm, running)).status, 200);
    await sqlRun("UPDATE sysbuild_batches SET status = 'live' WHERE id = ?", [bid]);
    const plan = await planOf(U.pm, pid);
    const batch = plan.batches.find((b) => b.id === bid);
    assert.deepStrictEqual([batch.actions.update, batch.actions.add_node, batch.actions.reorder], [true, false, false]);
    assert.strictEqual(plan.nodes.find((n) => n.id === closed).actions.reopen, false);
    assert.strictEqual(plan.nodes.find((n) => n.id === idle).actions.cancel, false);
    const order = plan.nodes.filter((n) => n.batch_id === bid).map((n) => n.id).reverse();
    const stateOf = async (batchId) => ({
      nodes: await sqlAll('SELECT id, name, status, sort_order FROM sysbuild_nodes WHERE batch_id = ? ORDER BY id', [batchId]),
      scheduleCount: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id IN (SELECT id FROM sysbuild_nodes WHERE batch_id = ?)', [batchId])).n,
    });
    const before = await stateOf(bid);
    const blocked = [
      await reopenNode(U.pm, closed, '仍未结束'),
      await cancelNode(U.pm, idle, '取消普通上线阶段'),
      await post(U.pm, `/sysbuild/batches/${bid}/nodes`, { name: '新增节点' }),
      await post(U.pm, `/sysbuild/batches/${bid}/node-order`, { node_ids: order }),
    ];
    for (const result of blocked) {
      expectErr(result, 409, 'SYSBUILD_STATE');
      assert.ok(result.body.message.includes('批次已正式上线'), result.text);
    }
    assert.deepStrictEqual(await stateOf(bid), before, '被拒的动作没有修改节点或排期');
    assert.deepStrictEqual([plan.nodes.find((n) => n.id === idle).actions.rename,
      plan.nodes.find((n) => n.id === idle).actions.schedule_plan,
      plan.nodes.find((n) => n.id === running).actions.correct_actual_start], [true, true, true]);
    assert.strictEqual((await patch(U.pm, `/sysbuild/nodes/${idle}`, { name: '调整测试名称' })).status, 200);
    assert.strictEqual((await setPlan(U.pm, idle, '2026-11-02', '2026-11-09')).status, 201);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${running}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '更正开工日期' })).status, 201);
    const cancelled = await idOf(pid, 'b_test');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE id = ?", [cancelled]);
    const denied = await patch(U.pm, `/sysbuild/nodes/${cancelled}`, { name: '不应改名' });
    expectErr(denied, 409, 'SYSBUILD_STATE');
    assert.strictEqual(denied.body.message, '已取消的节点不能改名');

    const actualProject = await newProject('inhouse');
    await T.confirm.produceEffectiveOverall(actualProject);
    const actualBatch = await defaultBatchId(actualProject);
    await T.confirm.readyForGolive(actualProject, actualBatch);
    await T.confirm.productionGolive(actualBatch);
    const actualPlan = await planOf(U.pm, actualProject);
    const actualBatchView = actualPlan.batches.find((b) => b.id === actualBatch);
    assert.deepStrictEqual([actualBatchView.live, actualBatchView.actions.add_node, actualBatchView.actions.reorder], [true, false, false]);
    const finished = keyOf(actualPlan, 'b_dev');
    assert.strictEqual(finished.status, 'closed');
    assert.strictEqual(finished.actions.reopen, false);
    const realOrder = actualPlan.nodes.filter((n) => n.batch_id === actualBatch).map((n) => n.id).reverse();
    const liveBefore = await stateOf(actualBatch);
    const liveRequests = [
      [() => reopenNode(U.pm, finished.id, '线上节点返工'), '批次已正式上线，本批节点不能重开，须先由 admin 撤销上线'],
      [() => post(U.pm, '/sysbuild/batches/' + actualBatch + '/nodes', { name: '上线后新增节点' }), '批次已正式上线，不能新增节点'],
      [() => post(U.pm, '/sysbuild/batches/' + actualBatch + '/node-order', { node_ids: realOrder }), '批次已正式上线，不能调整节点顺序'],
    ];
    for (const [send, message] of liveRequests) {
      const rejected = await send();
      expectErr(rejected, 409, 'SYSBUILD_STATE');
      assert.strictEqual(rejected.body.message, message);
      assert.deepStrictEqual(await stateOf(actualBatch), liveBefore);
    }
    assert.deepStrictEqual([finished.actions.rename, finished.actions.schedule_plan, finished.actions.correct_actual_end], [true, true, true]);
    assert.strictEqual((await patch(U.pm, '/sysbuild/nodes/' + finished.id, { name: '上线后调整阶段名称' })).status, 200);
    const noBaseline = await stateOf(actualBatch);
    const reschedule = await setPlan(U.pm, finished.id, '2026-11-03', '2026-11-13');
    expectErr(reschedule, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(reschedule.body.field, 'reason');
    assert.strictEqual(finished.has_baseline, false);
    assert.deepStrictEqual(await stateOf(actualBatch), noBaseline);
    const correction = await post(U.pm, '/sysbuild/nodes/' + finished.id + '/schedule', {
      kind: 'actual_correct', corrects: 'actual_end', actual_date: finished.actual_start, reason: '上线后更正阶段结束日期',
    });
    assert.strictEqual(correction.status, 201, correction.text);
    assert.strictEqual(correction.body.node.actual_end, finished.actual_start);
  });

  // ── 预筛 D6：草稿期计划的标记 ────────────────────────────────────────────────────────────────
  test('草稿期标记（D6，生产路径生效形成 baseline）：排期记录的 is_draft_plan = 写入时节点尚无 baseline；基线形成后的改期与基线本身不是草稿期；事件 node_plan_set 标 draft、node_rescheduled 不带', async () => {
    const pid = await newProject('outsource');
    const nid = await idOf(pid, 'b_uat');
    const url = `/sysbuild/nodes/${nid}/schedule`;
    assert.strictEqual((await setPlan(U.pm, nid, '2026-11-02', '2026-11-10')).status, 201);
    assert.strictEqual((await setPlan(U.pm, nid, '2026-11-03', '2026-11-12', { reason: '顺延一天' })).status, 201);
    let sched = await get(U.pm, url);
    assert.deepStrictEqual(sched.body.records.map((x) => [x.kind, x.is_draft_plan]), [['plan_change', true], ['plan_change', true]], '无基线时全是草稿期');
    await T.confirm.produceEffectiveOverall(pid); // C4a 交接 ②：基线经生产路径形成（生效时取最后一条草稿计划 11-03 ~ 11-12）
    const re = await setPlan(U.pm, nid, '2026-11-03', '2026-11-18', { reason: '范围增加', no_written_evidence: true, no_evidence_reason: '电话沟通后口头确认的延期' });
    assert.strictEqual(re.status, 201, re.text);
    sched = await get(U.pm, url);
    assert.deepStrictEqual(sched.body.records.map((x) => [x.kind, x.is_draft_plan]), [['plan_change', true], ['plan_change', true], ['baseline', false], ['plan_change', false]], '基线之前的 plan_change 是草稿期；基线与之后的改期不是');
    // 只看本节点的事件：H-1 之后总体规划包提交前助手给其余节点补了草稿期计划，项目范围内的 node_plan_set 事件不止本节点这两条
    const ofNode = async (type) => (await eventsOf(pid, type)).filter((e) => e.object_id === nid).map((e) => JSON.parse(e.payload_json));
    const drafts = await ofNode('node_plan_set');
    assert.deepStrictEqual(drafts.map((p) => [p.reason, p.draft]), [['草稿期计划', true], ['顺延一天', true]]);
    const resched = await ofNode('node_rescheduled');
    assert.strictEqual(resched.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resched[0], 'draft'), false, '改期事件不带 draft');
  });

  // ── 预筛 L8：严格键白名单 ──────────────────────────────────────────────────────────────────
  test('严格键白名单（L8）：start / close / reopen / cancel / schedule（plan 与 actual_correct 各自的键集）/ node-order 带多余键 → 400 且 field 是多余的键，节点 / 事件 / 排期记录都不变', async () => {
    const pid = await newProject('outsource');
    const batchId = await defaultBatchId(pid);
    const dev = await idOf(pid, 'b_dev');
    const design = await idOf(pid, 'b_design');
    const tst = await idOf(pid, 'b_test');
    const uat = await idOf(pid, 'b_uat');
    assert.strictEqual((await startNode(U.pm, design)).status, 200);
    assert.strictEqual((await startNode(U.pm, tst)).status, 200);
    assert.strictEqual((await closeNode(U.pm, tst)).status, 200);
    const order = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
    const snapshot = async () => ({
      nodes: await sqlAll('SELECT id, name, status, sort_order FROM sysbuild_nodes WHERE project_id = ? ORDER BY id', [pid]),
      events: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [pid])).n,
      records: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id IN (SELECT id FROM sysbuild_nodes WHERE project_id = ?)', [pid])).n,
    });
    const before = await snapshot();
    const cases = [
      ['start', () => post(U.pm, `/sysbuild/nodes/${dev}/start`, { foo: 1 }), 'foo'],
      ['close', () => post(U.pm, `/sysbuild/nodes/${design}/close`, { foo: 1 }), 'foo'],
      ['reopen', () => post(U.pm, `/sysbuild/nodes/${tst}/reopen`, { reason: '原因', foo: 1 }), 'foo'],
      ['cancel', () => post(U.pm, `/sysbuild/nodes/${uat}/cancel`, { reason: '原因', foo: 1 }), 'foo'],
      ['schedule plan', () => post(U.pm, `/sysbuild/nodes/${dev}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-09', foo: 1 }), 'foo'],
      ['schedule plan 带更正专用键', () => post(U.pm, `/sysbuild/nodes/${dev}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-09', corrects: 'actual_start' }), 'corrects'],
      ['schedule actual_correct', () => post(U.pm, `/sysbuild/nodes/${design}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '错', foo: 1 }), 'foo'],
      ['schedule actual_correct 带计划专用键', () => post(U.pm, `/sysbuild/nodes/${design}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: '错', planned_start: '2026-11-02' }), 'planned_start'],
      ['node-order', () => post(U.pm, `/sysbuild/batches/${batchId}/node-order`, { node_ids: [...order].reverse(), foo: 1 }), 'foo'],
    ];
    for (const [label, fn, field] of cases) {
      const r = await fn();
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    }
    assert.deepStrictEqual(await snapshot(), before, '被拒的请求不改任何节点、不写事件、不留排期记录');
  });

  // ── 预筛 L1：文本入参拒收控制字符 ──────────────────────────────────────────────────────────
  test('文本入参拒收控制字符（L1，C2 侧与 plan 侧）：NUL、\\u001F、\\u007F → 400 SYSBUILD_INVALID_INPUT 且不写库；换行 / 回车 / 制表保留（plan.js 节点名 / 原因、projects.js 系统名 / 目标、membership.js 参与方名 / 移出原因）', async () => {
    const BAD = ['x\u0000y', 'x\u001Fy', 'x\u007Fy', '\u0000'];
    const OK_TEXT = 'a\nb\tc\rd';
    const pid = await newProject('outsource');
    const batchId = await defaultBatchId(pid);
    const design = await idOf(pid, 'b_design');
    const dev = await idOf(pid, 'b_dev');
    const uat = await idOf(pid, 'b_uat');
    assert.strictEqual((await startNode(U.pm, design)).status, 200);
    assert.strictEqual((await closeNode(U.pm, design)).status, 200);
    const nodeCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_nodes WHERE batch_id = ?', [batchId])).n;
    const total = async () => ({
      nodes: await nodeCount(),
      events: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ?', [pid])).n,
      records: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id IN (SELECT id FROM sysbuild_nodes WHERE project_id = ?)', [pid])).n,
      parties: (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ?', [pid])).n,
    });
    const memberRow = await addMember(pid, U.m1);
    const before = await total();
    const beforeProj = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects')).n;
    const calls = (bad) => [
      ['plan 新增节点名', 'name', () => post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: bad })],
      ['plan 改节点名', 'name', () => patch(U.pm, `/sysbuild/nodes/${uat}`, { name: bad })],
      ['plan 批次改名', 'name', () => patch(U.pm, `/sysbuild/batches/${batchId}`, { name: bad })],
      ['plan 重开原因', 'reason', () => reopenNode(U.pm, design, bad)],
      ['plan 取消原因', 'reason', () => cancelNode(U.pm, uat, bad)],
      ['plan 草稿计划原因', 'reason', () => setPlan(U.pm, dev, '2026-11-02', '2026-11-09', { reason: bad })],
      ['plan 更正原因', 'reason', () => post(U.pm, `/sysbuild/nodes/${design}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: '2026-10-01', reason: bad })],
      ['projects 建项系统名', 'system_name', () => post(U.pm, '/sysbuild/projects', { system_name: bad, build_type: 'inhouse' })],
      ['projects 改目标', 'goal', () => api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: bad })],
      ['membership 参与方名', 'name', () => post(U.pm, `/sysbuild/projects/${pid}/parties`, { side: 'demand', name: bad })],
      ['membership 移出原因', 'reason', () => post(U.pm, `/sysbuild/members/${memberRow}/remove`, { reason: bad })],
    ];
    for (const bad of BAD) {
      for (const [label, field, fn] of calls(bad)) {
        const r = await fn();
        expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `${label}（${JSON.stringify(bad)}）`);
        assert.strictEqual(r.body.field, field, `${label} 的 field`);
      }
    }
    assert.deepStrictEqual(await total(), before, '被拒的请求不写库');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects')).n, beforeProj, '被拒的建项不留项目');
    assert.strictEqual((await sqlGet('SELECT goal FROM sysbuild_projects WHERE id = ?', [pid])).goal, null);
    assert.strictEqual((await sqlGet('SELECT removed_at FROM sysbuild_members WHERE id = ?', [memberRow])).removed_at, null);
    // 换行 / 回车 / 制表保留：原样通过（trim 只去首尾空白）
    const okNode = await post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: OK_TEXT });
    assert.strictEqual(okNode.status, 201, okNode.text);
    assert.strictEqual(okNode.body.node.name, OK_TEXT);
    const okGoal = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: OK_TEXT });
    assert.strictEqual(okGoal.status, 200, okGoal.text);
    assert.strictEqual(okGoal.body.project.goal, OK_TEXT);
    const okParty = await post(U.pm, `/sysbuild/projects/${pid}/parties`, { side: 'demand', name: '甲\n乙', leader_user_id: U.fixtureLeader, representative_user_id: U.fixtureRepresentative });
    assert.strictEqual(okParty.status, 201, okParty.text);
  });

  // ── 预筛 L5：建项结构写入的原子性 ──────────────────────────────────────────────────────────────
  test('建项原子性（L5，夹具：测试库临时触发器让节点写入中途失败）：建项事务里带出结构中途失败 → 整个建项回滚（项目 / 成员 / 批次 / 节点 / 事件都不留）；撤掉触发器后同名再建成功', async () => {
    const name = `原子性项目${runTag}`;
    const counts = async () => sqlGet(
      'SELECT (SELECT COUNT(*) FROM sysbuild_projects) AS projects, (SELECT COUNT(*) FROM sysbuild_members) AS members, (SELECT COUNT(*) FROM sysbuild_batches) AS batches, (SELECT COUNT(*) FROM sysbuild_nodes) AS nodes, (SELECT COUNT(*) FROM sysbuild_events) AS events',
      []
    );
    const before = await counts();
    // 触发器只在本用例的 try 内存在；让 p_closing（项目层最后一个节点）写入失败，此时项目 / 成员 / 批次 / 前面的节点都已写入同一事务。
    await sqlRun("CREATE TRIGGER trg_c3a_atomic_probe BEFORE INSERT ON sysbuild_nodes WHEN NEW.template_key = 'p_closing' BEGIN SELECT RAISE(ABORT, 'c3a atomic probe'); END", []);
    try {
      const r = await post(U.pm, '/sysbuild/projects', { system_name: name, build_type: 'inhouse', ...T.fixturePeople() });
      assert.strictEqual(r.status, 500, `带出结构失败应整体失败: ${r.text}`);
      assert.deepStrictEqual(await counts(), before, '整个建项回滚：项目 / 成员 / 批次 / 节点 / 事件行数都不变');
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects WHERE system_name = ?', [name])).n, 0);
    } finally {
      await sqlRun('DROP TRIGGER IF EXISTS trg_c3a_atomic_probe', []);
    }
    const ok = await post(U.pm, '/sysbuild/projects', { system_name: name, build_type: 'inhouse', ...T.fixturePeople() });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual((await planOf(U.pm, ok.body.project.id)).nodes.length, 3 + 2, '撤掉触发器后结构完整（自研 3 个项目层 + 2 个批次层）');
  });

  // ── 17 actions 同源 ────────────────────────────────────────────────────────────────────────
  test('actions 同源：对 plan 返回的每个节点、每个标志，实际调用对应端点的成败与标志一致（覆盖未开始 / 进行中 / 已收口 / 已取消 / 里程碑 / 暂停；内容包生效为夹具——生产路径生效后节点带基线，设计划标志为真的执行要原因与证据）', async () => {
    const day = await serverToday();
    for (const projectStatus of ['active', 'paused']) {
      const pid = await newProject('outsource');
      await planAll(pid);
      await seedEffectivePackagesFixture(pid); // 收口 p_initiation 的内容包前置（夹具）。
      const plan = await planOf(U.pm, pid);
      const id = (k) => keyOf(plan, k).id;
      // b_golive、b_test、p_initiation 已收口，b_design 进行中，b_dev 已取消，b_uat、p_contract 未开始，里程碑 b_trial 进行中。
      for (const k of ['b_golive', 'b_test', 'p_initiation']) { assert.strictEqual((await startNode(U.pm, id(k))).status, 200, k); assert.strictEqual((await closeNode(U.pm, id(k))).status, 200, `${k} 收口`); }
      for (const k of ['b_design', 'b_trial']) assert.strictEqual((await startNode(U.pm, id(k))).status, 200, k);
      assert.strictEqual((await cancelNode(U.pm, id('b_dev'), '不做')).status, 200);
      if (projectStatus === 'paused') assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
      const nodeIds = plan.nodes.map((n) => n.id);
      let seqNo = 0;
      const callFor = (flag, nid) => {
        seqNo += 1;
        switch (flag) {
          case 'start': return startNode(U.pm, nid);
          case 'close': return closeNode(U.pm, nid);
          case 'reopen': return reopenNode(U.pm, nid, '同源检查');
          case 'cancel': return cancelNode(U.pm, nid, '同源检查');
          case 'rename': return patch(U.pm, `/sysbuild/nodes/${nid}`, { name: `同源改名${seqNo}` });
          // 夹具里总体规划已生效（H-1：此后写计划一律走改期规则，原因与证据必填，无论节点有没有基线），所以带上原因与无书面证据声明；标志为假的节点在状态检查就 409，不看这些字段
          case 'schedule_plan': return setPlan(U.pm, nid, addDays('2027-01-01', seqNo), addDays('2027-03-01', seqNo), { reason: '同源检查', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次同源检查' });
          // 更正的日期要满足先后校验与「不晚于今天」：开始更正到很早的日期，结束更正到今天
          case 'correct_actual_start': return post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'actual_correct', corrects: 'actual_start', actual_date: addDays('2026-01-01', seqNo), reason: '同源检查' });
          default: return post(U.pm, `/sysbuild/nodes/${nid}/schedule`, { kind: 'actual_correct', corrects: 'actual_end', actual_date: day, reason: '同源检查' });
        }
      };
      const flags = ['start', 'close', 'reopen', 'cancel', 'rename', 'schedule_plan', 'correct_actual_start', 'correct_actual_end'];
      const seen = { true: 0, false: 0 };
      for (const nid of nodeIds) {
        for (const flag of flags) {
          const before = (await planOf(U.pm, pid)).nodes.find((n) => n.id === nid);
          const flagValue = before.actions[flag];
          const res = await callFor(flag, nid);
          const label = `${projectStatus} ${before.template_key}(${before.status}) ${flag}`;
          // C6a：p_closing 的 close 标志只承诺权限与状态（与其他节点同口径，阻塞项单独给）；本场景没有结项包 / 批次没有正式上线，执行被 SYSBUILD_CLOSE_BLOCKED 拦下，是预期（成功路径见 sysbuild-api-suite-golive.js）
          const closeBlocked = flag === 'close' && before.template_key === 'p_closing' && res.status === 409 && !!res.body && res.body.code === 'SYSBUILD_CLOSE_BLOCKED';
          if (flagValue) assert.ok(res.status === 200 || res.status === 201 || closeBlocked, `${label}: 标志为真但执行失败 ${res.status} ${res.text}`);
          else assert.strictEqual(res.status, 409, `${label}: 标志为假但执行没有被 409 拒绝 ${res.status} ${res.text}`);
          seen[flagValue] += 1;
        }
      }
      assert.ok(seen.true > 10 && seen.false > 10, `两种结果都要覆盖到：${JSON.stringify(seen)}`);
      // 批次级标志
      const b = (await planOf(U.pm, pid)).batches[0];
      const batchId = b.id;
      const order = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
      const rb = await patch(U.pm, `/sysbuild/batches/${batchId}`, { name: `批次${projectStatus}` });
      assert.strictEqual(rb.status === 200, b.actions.update, 'batch update');
      assert.strictEqual((await post(U.pm, `/sysbuild/batches/${batchId}/nodes`, { name: '同源新增' })).status === 201, b.actions.add_node, 'add_node');
      const cur = (await sqlAll('SELECT id FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [batchId])).map((r) => r.id);
      assert.strictEqual(cur.length, order.length + 1);
      assert.strictEqual((await post(U.pm, `/sysbuild/batches/${batchId}/node-order`, { node_ids: [...cur].reverse() })).status === 200, b.actions.reorder, 'reorder');
    }
  });

  // ═══════════════════════ C6 新增（生效清单 4.3 第 1 条）：R2 排计划与改期不收 dev_key_entry_id ═══════════════════════
  //   先采集后汇总（照 4.3 采集规则）：每个请求格记 { 请求标签、HTTP 状态、业务码、field、message、响应键集合 } 与该项目 sysbuild_node_schedule_records 增量，不预先断言状态码；汇总阶段按标签逐格断言。
  //   请求集合：R2 原 23 个 + 缺 / 非法 kind 带键 14 个（R2K-*）+ 身份格 36 个（R2ID-*）= 73（另 4 个 actual_correct 格 RC12-*，单列）。
  test(`${T_C6_R2}——键出现即拒（含 null、不看值），先于 kind、日期字段、可见性与权限；开发方来源不带键的改期 201（甲类）；被拒请求不落改期记录`, async () => {
    const C = T.confirm;
    // ── 夹具 ──
    const mkModeProject = async (resched) => {
      const pid = await newProject('outsource');
      const dev = await idOf(pid, 'b_dev');
      const demandParty = await C.seedParty(pid, '需求部门', U.own, U.del);
      if (resched) {
        await planAll(pid);
        await ensureEffective(pid, 'overall'); // 总体规划生效后进入改期式写入（原因必填、方向类证据）；生效时按各节点当前计划形成基线
      }
      const devParty = await addParty(pid, '开发商', 'dev');
      const mx1 = await addMember(pid, U.x1, { party: devParty });
      await addAppointment(devParty, mx1, 'active');
      await addMember(pid, U.x3, { party: devParty });
      await addMember(pid, U.m1, { party: demandParty.party });
      return { pid, dev, demand: demandParty.party, devParty };
    };
    const draft = await mkModeProject(false);
    const rs = await mkModeProject(true);
    const recCount = async (s) => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records WHERE node_id IN (SELECT id FROM sysbuild_nodes WHERE project_id = ?)', [s.pid])).n;
    const EVI = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次顺延安排' };
    const REC = {};
    const send = async (label, s, uid, body, nodeId) => {
      const before = await recCount(s);
      const r = await post(uid, `/sysbuild/nodes/${nodeId || s.dev}/schedule`, body);
      REC[label] = { r, delta: (await recCount(s)) - before, status: r.status, code: r.body && r.body.code, field: r.body && r.body.field, message: r.body && r.body.message, keys: Object.keys(r.body || {}).sort() };
    };
    const drf = (extra) => Object.assign({ kind: 'plan', planned_start: '2026-11-02', planned_end: '2027-01-11' }, extra || {});
    const rsc = (extra) => Object.assign({ kind: 'plan', planned_start: '2026-11-03', planned_end: '2026-12-31', reason: '客户方要求顺延' }, EVI, extra || {});
    const KEY_VAL = 7; // 有效编号取非 1 的值（D 批 -lit1 格另用字面编号 1，L-6）
    // ① 键出现即拒、不看值
    await send('R2-3a', draft, U.pm, drf({ dev_key_entry_id: null }));
    await send('R2-3b', rs, U.pm, rsc({ source_party_id: rs.demand, dev_key_entry_id: null }));
    await send('R2-3c', rs, U.pm, rsc({ dev_key_entry_id: null }));
    await send('R2-3d', rs, U.pm, rsc({ source_party_id: rs.devParty, dev_key_entry_id: null }));
    await send('R2-3e', draft, U.pm, drf({ dev_key_entry_id: KEY_VAL }));
    await send('R2-2', rs, U.pm, rsc({ source_party_id: rs.devParty, dev_key_entry_id: KEY_VAL }));
    for (const [tag, v] of [['empty', ''], ['zero', 0], ['abc', 'abc']]) {
      await send(`R2-4-draft-${tag}`, draft, U.pm, drf({ dev_key_entry_id: v }));
      for (const [src, sp] of [['dev', rs.devParty], ['demand', rs.demand], ['none', null]]) await send(`R2-4-resched-${src}-${tag}`, rs, U.pm, rsc(Object.assign({ dev_key_entry_id: v }, sp === null ? {} : { source_party_id: sp })));
    }
    // ② 先于其他字段校验：开始晚于结束 + 键，先报键
    await send('R2-3f-null', draft, U.pm, drf({ planned_start: '2027-02-01', planned_end: '2027-01-11', dev_key_entry_id: null }));
    await send('R2-3f-valid', draft, U.pm, drf({ planned_start: '2027-02-01', planned_end: '2027-01-11', dev_key_entry_id: KEY_VAL }));
    // ③ 保留（对照）：不带键成功
    await send('R2-ctl-draft-nokey', draft, U.pm, drf());
    await send('R2-ctl-resched-demand-nokey', rs, U.pm, rsc({ source_party_id: rs.demand }));
    // ④ 甲类 R2-1：开发方来源不带键 201（旧 409）
    const rsDevBefore = await recCount(rs);
    await send('R2-ctl-resched-dev-nokey', rs, U.pm, rsc({ planned_end: '2026-12-30', source_party_id: rs.devParty }));
    REC.devRow = await sqlGet('SELECT source_party_id FROM sysbuild_node_schedule_records WHERE id = ?', [REC['R2-ctl-resched-dev-nokey'].r.body.record_id || 0]);
    REC.devEv = (await payloads(rs.pid, 'node_rescheduled')).filter((p) => p.record_id === REC['R2-ctl-resched-dev-nokey'].r.body.record_id); // 193-M1：按 record_id 精确取本格事件，不取项目最后一条（漏发时会误取前一格需求方改期的事件）
    REC.devBeforeN = rsDevBefore;
    // ⑤ kind=actual_correct 带该键同样先被拒（旧值实采 RC12-actual-correct-*）
    const reqNode = await idOf(rs.pid, 'p_initiation');
    assert.strictEqual((await startNode(U.pm, reqNode)).status, 200, '夹具：立项节点开工（actual_correct 对照需要已开始的节点）');
    const today0 = await serverToday();
    const ac = (extra) => Object.assign({ kind: 'actual_correct', corrects: 'actual_start', actual_date: addDays(today0, -1), reason: '更正开始日期' }, extra || {});
    await send('RC12-actual-correct-valuekey', rs, U.pm, ac({ dev_key_entry_id: KEY_VAL }), reqNode);
    await send('RC12-actual-correct-nullkey', rs, U.pm, ac({ dev_key_entry_id: null }), reqNode);
    await send('RC12-actual-correct-badbody', rs, U.pm, ac({ corrects: 'bogus', dev_key_entry_id: KEY_VAL }), reqNode);
    await send('RC12-actual-correct-ctl', rs, U.pm, ac(), reqNode);
    // ⑦ 缺 / 非法 kind 时键检查先于 kind 校验（R2K-*，每模式 7 格：不带 kind 带有效编号 / 字面编号 1 / null、kind: xyz 带 null / 有效编号、两个不带键的对照）
    for (const [mode, s, build] of [['draft', draft, drf], ['resched', rs, rsc]]) {
      const noKind = (extra) => { const b = build(extra); delete b.kind; return b; };
      await send(`R2K-${mode}-nokind-key-valid`, s, U.pm, noKind({ dev_key_entry_id: KEY_VAL }));
      await send(`R2K-${mode}-nokind-key-lit1`, s, U.pm, noKind({ dev_key_entry_id: 1 }));
      await send(`R2K-${mode}-nokind-key-null`, s, U.pm, noKind({ dev_key_entry_id: null }));
      await send(`R2K-${mode}-xyz-key-null`, s, U.pm, build({ kind: 'xyz', dev_key_entry_id: null }));
      await send(`R2K-${mode}-xyz-key-valid`, s, U.pm, build({ kind: 'xyz', dev_key_entry_id: KEY_VAL }));
      await send(`R2K-${mode}-nokind-nokey`, s, U.pm, noKind());
      await send(`R2K-${mode}-xyz-nokey`, s, U.pm, build({ kind: 'xyz' }));
    }
    // ⑧ 身份格（R2ID-*）：6 个身份 × 草稿期 / 改期式 × 带键（null / 有效编号）+ 不带键对照
    const IDS = [['out', U.out], ['ro', U.ro], ['m1', U.m1], ['x3', U.x3], ['own', U.own], ['x1', U.x1]];
    for (const [mode, s, build] of [['draft', draft, drf], ['resched', rs, rsc]]) {
      for (const [who, uid] of IDS) {
        await send(`R2ID-${mode}-${who}-null`, s, uid, build({ dev_key_entry_id: null }));
        await send(`R2ID-${mode}-${who}-valid`, s, uid, build({ dev_key_entry_id: KEY_VAL }));
        await send(`R2ID-${mode}-${who}-nokey`, s, uid, build());
      }
    }
    // ── 汇总 ──
    const fails = [];
    const c = (label, fn) => { try { fn(); } catch (e) { fails.push(`[${label}] ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
    const KEY_REJECT = (label) => c(label, () => {
      const r = REC[label];
      assert.deepStrictEqual([r.status, r.code, r.field, r.message], [400, 'SYSBUILD_INVALID_INPUT', 'dev_key_entry_id', '不支持的字段 dev_key_entry_id'], `${label}: ${r.r.text}`);
      assert.deepStrictEqual(r.keys, ['code', 'field', 'message']);
      assert.strictEqual(r.delta, 0, '被拒不落改期记录');
    });
    for (const l of ['R2-3a', 'R2-3b', 'R2-3c', 'R2-3d', 'R2-3e', 'R2-2', 'R2-3f-null', 'R2-3f-valid']) KEY_REJECT(l);
    for (const tag of ['empty', 'zero', 'abc']) { KEY_REJECT(`R2-4-draft-${tag}`); for (const src of ['dev', 'demand', 'none']) KEY_REJECT(`R2-4-resched-${src}-${tag}`); }
    for (const l of ['R2-ctl-draft-nokey', 'R2-ctl-resched-demand-nokey']) c(l, () => { assert.strictEqual(REC[l].status, 201, REC[l].r.text); assert.deepStrictEqual(REC[l].keys, ['node', 'record_id']); assert.strictEqual(REC[l].delta, 1); });
    c('R2-ctl-resched-dev-nokey（甲类：旧 409，新 201）', () => {
      const r = REC['R2-ctl-resched-dev-nokey']; assert.strictEqual(r.status, 201, r.r.text); assert.strictEqual(r.delta, 1);
      assert.deepStrictEqual(REC.devRow, { source_party_id: rs.devParty }, '记录行的来源方是请求指定的开发方参与方');
      assert.strictEqual(REC.devEv.length, 1, '本格改期恰发一条 node_rescheduled 事件');
      assert.strictEqual(REC.devEv[0].source_party_id, rs.devParty, '事件 payload 的 source_party_id = 请求的开发方参与方');
      assert.ok(!('dev_key_entry_id' in REC.devEv[0]), '事件 node_rescheduled 的 payload 无该键');
    });
    for (const l of ['RC12-actual-correct-valuekey', 'RC12-actual-correct-nullkey', 'RC12-actual-correct-badbody']) KEY_REJECT(l);
    c('RC12-actual-correct-ctl（日期更正 201 对照，增量 +1）', () => { assert.strictEqual(REC['RC12-actual-correct-ctl'].status, 201, REC['RC12-actual-correct-ctl'].r.text); assert.strictEqual(REC['RC12-actual-correct-ctl'].delta, 1); });
    for (const mode of ['draft', 'resched']) {
      for (const k of ['nokind-key-valid', 'nokind-key-lit1', 'nokind-key-null', 'xyz-key-null', 'xyz-key-valid']) KEY_REJECT(`R2K-${mode}-${k}`);
      for (const k of ['nokind-nokey', 'xyz-nokey']) c(`R2K-${mode}-${k}`, () => { const r = REC[`R2K-${mode}-${k}`]; assert.deepStrictEqual([r.status, r.code, r.field, r.message], [400, 'SYSBUILD_INVALID_INPUT', 'kind', 'kind 必须是 plan 或 actual_correct']); assert.strictEqual(r.delta, 0); });
      for (const [who] of IDS) {
        KEY_REJECT(`R2ID-${mode}-${who}-null`); KEY_REJECT(`R2ID-${mode}-${who}-valid`);
        c(`R2ID-${mode}-${who}-nokey`, () => { const r = REC[`R2ID-${mode}-${who}-nokey`]; assert.deepStrictEqual([r.status, r.code, r.keys], who === 'out' ? [404, 'SYSBUILD_NOT_FOUND', ['code', 'message']] : [403, 'SYSBUILD_FORBIDDEN', ['code', 'message']]); assert.strictEqual(r.delta, 0); });
      }
    }
    assert.strictEqual(fails.length, 0, fails.join(' ‖ '));
  });
}

// ── 变异（锚点必须在被测文件副本里恰好出现一次）──────────────────────────────────────────────────
const PLAN_MUTATIONS = [
  { id: 'C3a 状态表 close 行：暂停放行收口', expect: ['暂停：', 'rules：OP_KIND'], edits: [{ file: 'rules.js', from: 'close: Object.freeze({ active: true, paused: false, terminated: false, closed: false }),', to: 'close: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),' }] },
  { id: 'C3a checkOp 回退写死 membership 类别', expect: ['暂停：', '终止与已结项'], edits: [{ file: 'rules.js', from: 'if (!projectAllowsWrite(project.status, OP_KIND[op])) return', to: "if (!projectAllowsWrite(project.status, 'membership')) return" }] },
  // 两处一起改：OP_KIND 缺 node_close（动作未登记）+ 加载断言删掉（否则模块加载即抛错，子进程判「异常」不计检出）。效果：checkOp 对 node_close 走未登记硬门 → 500，收口用例判红。
  { id: 'C3a OP_KIND 缺 node_close 且加载断言删掉（收口动作未登记 → checkOp 500）', expect: ['开始 / 收口 / 重开'], edits: [
    { file: 'rules.js', from: "  node_close: 'close',\n", to: '' },
    { file: 'rules.js', from: 'if (OP_KIND_MISSING.length > 0 || OP_KIND_EXTRA.length > 0) {', to: 'if (false) {' },
  ] },
  // 只删加载断言（OP_KIND 本身完整）：行为上无任何差异，只有「加载断言」直接测试（把 OP_KIND 改坏的 rules 副本必须加载即抛错）能判红。
  { id: 'C3a 只删 OP_KIND 加载断言（预筛 L4：直接测试）', expect: ['rules：OP_KIND 加载断言'], edits: [{ file: 'rules.js', from: 'if (OP_KIND_MISSING.length > 0 || OP_KIND_EXTRA.length > 0) {', to: 'if (false) {' }] },
  { id: 'C3a OP_KIND 把 node_close 记成 maintain（暂停仍可收口）', expect: ['rules：OP_KIND', '暂停：'], edits: [{ file: 'rules.js', from: "  node_close: 'close',", to: "  node_close: 'maintain'," }] },
  { id: 'C3a 里程碑收口检查删掉', expect: ['里程碑：'], edits: [{ file: 'rules.js', from: "return t.isMilestone ? '正式上线里程碑以上线事件收口，不能走节点收口' : null;", to: 'return null;' }] },
  // C3a 原变异「p_closing 收口拦截删掉（D3）」随 C6a 去掉（对象规则不再拒绝 p_closing）；换成两条：结项包前置 / 批次上线前置被删，该用例判红
  {"id":"C6a p_closing 收口前置：批次未正式上线也放行","expect":["B3.2 结项保留未被卡片覆盖的批次阻塞"],"edits":[{"file":"plan.js","from":"if (unlistedBatches.length > 0) out.push(","to":"if (false) out.push("}]},
  { id: 'C6a p_closing 收口前置：结项包未生效也放行', expect: ['C6a 上线：纯函数'], edits: [{ file: 'plan.js', from: "if (!(f.closing && typeof f.closing.closingEffectiveAt === 'string') && !closingCards.some", to: "if (false && !closingCards.some" }] },
  { id: 'C3a 重开里程碑检查只删该行（批次非 live，预筛 M2）', expect: ['里程碑：'], edits: [{ file: 'rules.js', from: "if (t.isMilestone) return '正式上线里程碑不能重开，请走撤销上线';", to: '' }] },
  { id: 'C3a 重开 live 批次检查删掉（N-D2）', expect: ['夹具 live'], edits: [{ file: 'rules.js', from: "return t.batchStatus === 'live' ? '批次已正式上线，本批节点不能重开，须先由 admin 撤销上线' : null;", to: 'return null;' }] },
  { id: 'C3a 取消 / 新增 / 重排的 live 检查删掉', expect: ['夹具 live'], edits: [{ file: 'rules.js', from: "const batchNoEdit = (t) => t.batchStatus === 'live';", to: 'const batchNoEdit = () => false;' }] },
  { id: 'C3a 取消的「未开始」检查删掉（状态判断与条件更新一并去掉）', expect: ['取消：'], edits: [
    { file: 'rules.js', from: "if (t.nodeStatus !== 'not_started') return '只有未开始的节点可以取消';", to: '' },
    { file: 'plan.js', from: "SET status = 'cancelled', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'", to: "SET status = 'cancelled', updated_at = datetime('now','localtime') WHERE id = ?" },
  ] },
  { id: 'C3a 项目层节点取消检查删掉', expect: ['取消：'], edits: [{ file: 'rules.js', from: "if (t.isProjectLayer) return '项目层节点按模板固定，不能取消';", to: '' }] },
  { id: 'C3a 里程碑取消检查删掉', expect: ['里程碑：'], edits: [{ file: 'rules.js', from: "if (t.isMilestone) return '正式上线里程碑不能取消';", to: '' }] },
  { id: 'C3a 已取消节点可改名（状态判断与条件更新一并去掉）', expect: ['取消：'], edits: [
    { file: 'rules.js', from: "(t) => (t.nodeStatus === 'cancelled' ? '已取消的节点不能改名' : null)", to: '() => null' },
    { file: 'plan.js', from: "WHERE id = ? AND status <> 'cancelled'", to: 'WHERE id = ?' },
  ] },
  // D1：已收口节点没有基线时可补草稿期计划；有基线后不可。两条变异各只动一处。
  { id: 'C3a 已收口节点一律不能改计划（回到 D1 之前，缺计划的已收口节点永久挡路）', expect: ['草稿期计划'], edits: [{ file: 'rules.js', from: "return t.nodeStatus === 'closed' && t.hasBaseline ? '已有基线的已收口节点不能修改计划' : null;", to: "return t.nodeStatus === 'closed' ? '已有基线的已收口节点不能修改计划' : null;" }] },
  { id: 'C3a 已有基线的已收口节点也能改计划（D1 的另一半删掉）', expect: ['草稿期计划'], edits: [{ file: 'rules.js', from: "return t.nodeStatus === 'closed' && t.hasBaseline ? '已有基线的已收口节点不能修改计划' : null;", to: 'return null;' }] },
  { id: 'C3a 已取消节点可改计划', expect: ['取消：'], edits: [{ file: 'rules.js', from: "if (t.nodeStatus === 'cancelled') return '已取消的节点不能修改计划';", to: '' }] },
  { id: 'C3a 重排的排列校验删掉', expect: ['新增 + 改名 + 重排'], edits: [{ file: 'plan.js', from: 'if (ids.length !== curIds.length || !ids.every((id) => curIds.includes(id))) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3a PATCH 恢复接受 build_type（D44）', expect: ['PATCH 项目：'], edits: [{ file: 'projects.js', from: "const BASIC_FIELDS = ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on'];", to: "const BASIC_FIELDS = ['system_name', 'phase_name', 'build_type', 'goal', 'oa_number', 'initiated_on'];" }] },
  { id: 'C3a 建项不带出默认批次与节点', expect: ['建项带出结构'], edits: [{ file: 'projects.js', from: 'await seedProjectStructure(q, { projectId: pid, buildType: values.build_type, operatorId: uid, operatorName: operatorNameOf(user) });', to: '' }] },
  { id: 'C3a 自研里程碑键改错（落在 b_dev）', expect: ['建项带出结构'], edits: [
    { file: 'templates.js', from: "n('b_dev', '开发阶段（含设计）', 'G2+G3'),", to: "n('b_dev', '开发阶段（含设计）', 'G2+G3', true)," },
    { file: 'templates.js', from: "n('b_golive', '上线（含测试与验收）', 'G4+G5', true),", to: "n('b_golive', '上线（含测试与验收）', 'G4+G5')," },
  ] },
  { id: 'C3a 自研也生成 p_contract', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "types: Object.freeze(['outsource', 'procurement']) }),", to: "types: Object.freeze(['outsource', 'procurement', 'inhouse']) })," }] },
  { id: 'C3a 采购的合并节点 g_stage 写成单值', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "n('b_config', '配置阶段', 'G2+G3'),", to: "n('b_config', '配置阶段', 'G2')," }] },
  { id: '#212 B2.1 外包恢复批次需求确认节点', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "n('b_design', '设计阶段', 'G2'),", to: "n('b_req', '需求确认', 'G1'),\n    n('b_design', '设计阶段', 'G2')," }] },
  { id: '#212 B2.1 自研恢复批次需求确认节点', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "n('b_dev', '开发阶段（含设计）', 'G2+G3'),", to: "n('b_req', '需求确认', 'G1'),\n    n('b_dev', '开发阶段（含设计）', 'G2+G3')," }] },
  { id: '#212 B2.1 采购漏建需求调研节点', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "    n('b_req', '需求调研', 'G1'),\n", to: '' }] },
  { id: '#212 B2.1 外包正式上线里程碑提前到上线节点', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "n('b_uat', '验收阶段', 'G4'),\n    n('b_golive', '上线', 'G5'),\n    n('b_trial', '试运行阶段（结束即正式上线）', 'G5', true),", to: "n('b_uat', '验收阶段', 'G4'),\n    n('b_golive', '上线', 'G5', true),\n    n('b_trial', '试运行阶段（结束即正式上线）', 'G5')," }] },
  { id: '#212 B2.1 采购正式上线里程碑提前到上线节点', expect: ['建项带出结构'], edits: [{ file: 'templates.js', from: "n('b_training', '培训与验收阶段', 'G4'),\n    n('b_golive', '上线', 'G5'),\n    n('b_trial', '试运行阶段（结束即正式上线）', 'G5', true),", to: "n('b_training', '培训与验收阶段', 'G4'),\n    n('b_golive', '上线', 'G5', true),\n    n('b_trial', '试运行阶段（结束即正式上线）', 'G5')," }] },
  { id: 'C3a 改期证据校验删掉（无附件也无声明）', expect: ['baseline 改期', 'B4.2 首排并发'], edits: [{ file: 'plan.js', from: 'if (evidenceRequired && !noEvidence && attachmentIds.length === 0) {', to: 'if (false) {' }] },
  { id: 'C3a 无书面证据原因 10 字校验删掉', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: 'if (noEvidence && (noEvidenceReason === null || Array.from(noEvidenceReason).length < EVIDENCE_REASON_MIN)) {', to: 'if (false) {' }] },
  { id: 'C3a 改期原因必填检查删掉', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: "if (reason === null) throw invalid('改期必须填写原因', 'reason');", to: '' }] },
  // S-S1c：开发方来源由「一律 409」改为「须引用已认可的关键事项」，锚点随之改到 if 块
  { id: 'C3a 改期不绑定证据附件', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: "const bound = attachmentIds.length > 0\n        ? await attachmentHelpers.bindStagedAttachments(", to: "const bound = false\n        ? await attachmentHelpers.bindStagedAttachments(" }] },
  { id: 'C3a 草稿期计划放过改期专用字段', expect: ['草稿期计划'], edits: [{ file: 'plan.js', from: 'if (sourcePartyId !== null || attachmentIds.length > 0 || body.no_written_evidence !== undefined || noEvidenceReason !== null) {', to: 'if (false) {' }] }, // S-S1c：判定里加了 devKeyEntryId
  { id: 'C3a 草稿期同值不拒绝', expect: ['草稿期计划'], edits: [{ file: 'plan.js', from: "if (same) throw invalid('新计划与当前计划相同，无需修改', 'planned_start');", to: '' }] },
  { id: 'C3a 实际结束「仅收口时」条件删掉', expect: ['实际更正'], edits: [{ file: 'plan.js', from: "actual_end: node.status === 'closed' ? lastActual(recs, 'actual_end') : null,", to: "actual_end: lastActual(recs, 'actual_end')," }] },
  { id: 'C3a 更正不检查原记录存在', expect: ['实际更正'], edits: [{ file: 'rules.js', from: "return kinds.some((k) => has[k] === true) ? null : '该节点还没有可更正的实际日期记录';", to: 'return null;' }] },
  { id: 'C3a 与基线差改用起点', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: 'daysBetween(baseline.end, current.end)', to: 'daysBetween(baseline.start, current.start)' }] },
  { id: 'C3a 逾期天数把已收口也算上', expect: ['草稿期计划'], edits: [{ file: 'plan.js', from: "(node.status === 'not_started' || node.status === 'in_progress') && current", to: 'current' }] },
  { id: 'C3a 开始不记 actual_start', expect: ['开始 / 收口 / 重开'], edits: [{ file: 'plan.js', from: `await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [nid, day, Number(user.id)]);`, to: '' }] },
  { id: 'C3a 收口不记 actual_end', expect: ['开始 / 收口 / 重开'], edits: [{ file: 'plan.js', from: `await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [nid, day, Number(user.id)]);`, to: '' }] },
  { id: 'C3a 重开不要求原因', expect: ['开始 / 收口 / 重开'], edits: [{ file: 'plan.js', from: "const reason = readText(bodyOf(req).reason, 'reason', '重开原因', REASON_MAX, true);", to: "const reason = readText(bodyOf(req).reason, 'reason', '重开原因', REASON_MAX, false);" }] },
  { id: 'C3a 重开不清 closed_at', expect: ['开始 / 收口 / 重开'], edits: [{ file: 'plan.js', from: "SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'\",\n        [nid]", to: "SET status = 'in_progress', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'\",\n        [nid]" }] },
  { id: 'C3a actions.close 改用 maintain 类判定（node_rename）', expect: ['暂停：', 'actions 同源'], edits: [{ file: 'plan.js', from: "['close', 'node_close', null]", to: "['close', 'node_rename', null]" }] },
  { id: 'C3a actions.reopen 不看批次 live（改用 node_rename 判定）', expect: ['夹具 live', 'actions 同源'], edits: [{ file: 'plan.js', from: "['reopen', 'node_reopen', null]", to: "['reopen', 'node_rename', null]" }] },
  // 预筛 M3 / D7：更正实际结束要求已收口；标志按种类拆开；先后校验
  { id: 'C3a 更正实际结束不要求已收口（M3）', expect: ['实际更正'], edits: [{ file: 'rules.js', from: "if (t.corrects === 'actual_end' && t.nodeStatus !== 'closed') return '只有已收口的节点可以更正实际结束';", to: '' }] },
  { id: 'C3a correct_actual_end 标志不带 corrects（按任一类判，进行中也为真）', expect: ['实际更正', 'actions 同源'], edits: [{ file: 'plan.js', from: "['correct_actual_end', 'schedule_correct', 'actual_end']", to: "['correct_actual_end', 'schedule_correct', null]" }] },
  { id: 'C3a 更正先后校验：开始晚于结束放行（D7）', expect: ['实际更正'], edits: [{ file: 'plan.js', from: "throw invalid(corrects === 'actual_start' ? '更正后的实际开始不能晚于实际结束' : '更正后的实际结束不能早于实际开始', 'actual_date');", to: 'void 0;' }] },
  { id: 'C3a 更正先后校验：只校验开始不校验结束（D7）', expect: ['实际更正'], edits: [{ file: 'plan.js', from: "const endAfter = corrects === 'actual_end' ? actualDate : (node.status === 'closed' ? lastActual(recs, 'actual_end') : null);", to: "const endAfter = corrects === 'actual_end' ? null : (node.status === 'closed' ? lastActual(recs, 'actual_end') : null);" }] },
  // 预筛 D4：批次冻结统一判定
  // 预筛 D5 / D6
  { id: 'C3a dev_assignee_active 恒为 true（D5）', expect: ['批次 PATCH'], edits: [{ file: 'plan.js', from: 'dev_assignee_active: hasKey(data.activeAssignees, b.id),', to: 'dev_assignee_active: true,' }] },
  { id: 'C3a dev_assignee_active 查询不排除已移出成员（D5）', expect: ['批次 PATCH'], edits: [{ file: 'plan.js', from: "AND p.side = 'dev' AND ${rules.MEMBER_ACTIVE_SQL}`,\n      [projectId]", to: "AND p.side = 'dev'`,\n      [projectId]" }] },
  { id: 'C3a is_draft_plan 恒为 plan_change（基线之后的改期也算草稿，D6）', expect: ['草稿期标记'], edits: [{ file: 'plan.js', from: "is_draft_plan: r.kind === 'plan_change' && (!baseline || r.id < baseline.id),", to: "is_draft_plan: r.kind === 'plan_change'," }] },
  { id: 'C3a 草稿计划事件不带 draft 标记（D6）', expect: ['草稿期计划', '草稿期标记'], edits: [{ file: 'plan.js', from: 'reason: loggedReason, draft: !hasEffectiveOverall,', to: 'reason: loggedReason,' }] },
  { id: 'C3a 草稿计划事件原因仍写 null（D6）', expect: ['草稿期计划', '草稿期标记'], edits: [{ file: 'plan.js', from: 'reason: loggedReason, draft: !hasEffectiveOverall,', to: 'reason, draft: !hasEffectiveOverall,' }] },
  // 预筛 M1：互斥规则各自只删一处
  { id: 'C3a 删掉「附件与无书面证据互斥」（M1：真实暂存附件）', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: "if (noEvidence && attachmentIds.length > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');", to: '' }] },
  { id: 'C3a 删掉「未声明无书面证据却给原因」', expect: ['baseline 改期'], edits: [{ file: 'plan.js', from: "if (!noEvidence && noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');", to: '' }] },
  // 预筛 L3
  { id: 'C3a close_blockers 对未开始节点也计算（L3）', expect: ['整体验收结项（D3'], edits: [{ file: 'plan.js', from: "close_blockers: n.status === 'in_progress' ? closeBlockers(n, data.facts) : [],", to: 'close_blockers: closeBlockers(n, data.facts),' }] },
  // 预筛 L5：建项结构原子性
  // 注：「吞掉带出结构的错误、事务照常提交」这种变异检不出来也不需要检——db.js 的事务标记会拒绝提交已出错语句的事务（等价变异，已试过：自检未判红）。
  //   能破坏原子性的诚实写法是把带出结构挪到建项事务之外的第二个事务：项目已提交，结构失败时留下没有批次 / 节点的半成品。
  { id: 'C3a 带出结构挪到建项事务之外的第二个事务（半成品项目，L5）', expect: ['建项原子性'], edits: [
    { file: 'projects.js', from: 'await seedProjectStructure(q, { projectId: pid, buildType: values.build_type, operatorId: uid, operatorName: operatorNameOf(user) });', to: '' },
    { file: 'projects.js', from: 'res.status(201).json(out);', to: 'await db.withWriteTxn((q2) => seedProjectStructure(q2, { projectId: out.project.id, buildType: values.build_type, operatorId: uid, operatorName: operatorNameOf(user) }));\n    res.status(201).json(out);' },
  ] },
  // 预筛 L8：各端点的键白名单各删一处
  { id: 'C3a start 端点放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "onlyKeys(body, ['start_note', 'attachment_ids']);", to: '' }] },
  { id: 'C3a close 端点放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "onlyKeys(body, ['complete_node_ids']);", to: '' }] },
  { id: 'C3a reopen 端点放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "onlyKeys(bodyOf(req), ['reason']);\n    const reason = readText(bodyOf(req).reason, 'reason', '重开原因'", to: "const reason = readText(bodyOf(req).reason, 'reason', '重开原因'" }] },
  { id: 'C3a cancel 端点放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "onlyKeys(bodyOf(req), ['reason']);\n    const reason = readText(bodyOf(req).reason, 'reason', '取消原因'", to: "const reason = readText(bodyOf(req).reason, 'reason', '取消原因'" }] },
  { id: 'C3a schedule(plan) 放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "if (kind === 'plan') onlyKeys(", to: 'if (false) onlyKeys(' }] },
  { id: 'C3a schedule(actual_correct) 放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "else onlyKeys(body, ['kind', 'corrects', 'actual_date', 'reason']);", to: 'else void 0;' }] },
  { id: 'C3a node-order 放过多余键（L8）', expect: ['严格键白名单'], edits: [{ file: 'plan.js', from: "onlyKeys(bodyOf(req), ['node_ids']);", to: '' }] },
  // 预筛 L1：控制字符（共用判定一处 + 三份 readText 各一处）
  { id: 'C3a 控制字符判定漏掉 NUL（L1）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'rules.js', from: 'const CONTROL_CHAR_RE = /[\\u0000-\\u0008\\u000B', to: 'const CONTROL_CHAR_RE = /[\\u0001-\\u0008\\u000B' }] },
  { id: 'C3a 控制字符判定漏掉 DEL（L1）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'rules.js', from: '\\u000E-\\u001F\\u007F]/;', to: '\\u000E-\\u001F]/;' }] },
  { id: 'C3a 控制字符判定连制表 / 换行也拒（L1：保留 \\n \\r \\t）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'rules.js', from: '/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/;', to: '/[\\u0000-\\u001F\\u007F]/;' }] },
  { id: 'C3a plan.js 的 readText 不拒控制字符（L1）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'plan.js', from: 'if (rules.hasControlChar(v)) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3a projects.js 的 readText 不拒控制字符（L1）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'projects.js', from: 'if (rules.hasControlChar(v)) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3a membership.js 的 readText 不拒控制字符（L1）', expect: ['文本入参拒收控制字符'], edits: [{ file: 'membership-people.js', from: 'if (rules.hasControlChar(text)) throw invalid(', to: 'if (false) throw invalid(' }] },
  // 预筛 L9：进程内固定 todayProvider 必须被服务端使用
  { id: 'C3a 开始节点记的实际日期不取 todayProvider（L9：进程内注入值被忽略）', expect: ['开始 / 收口 / 重开'], edits: [{ file: 'plan.js', from: "      const day = today();\n      await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start'", to: "      const day = localDateString(new Date());\n      await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start'" }] },
  // codex 17 号 M-1：实际日期不倒置
  { id: 'C3a 更正实际日期不拒未来日期（17 号 M-1）', expect: ['实际日期不倒置'], edits: [{ file: 'plan.js', from: 'if (actualDate > today()) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3a 收口不核实际开始是否晚于收口日期（17 号 M-1 防御，进程内往回拨 todayProvider）', expect: ['收口防御'], edits: [{ file: 'plan.js', from: 'if (lastStart !== null && lastStart > day) throw stateError(', to: 'if (false) throw stateError(' }] },
  // codex 17 号 L-1：三份 bodyOf 各自拒数组请求体
  { id: 'C3a plan.js 的 bodyOf 放过数组请求体（17 号 L-1）', expect: ['请求体不是对象'], edits: [{ file: 'plan.js', from: "if (typeof b !== 'object' || Array.isArray(b)) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3a projects.js 的 bodyOf 放过数组请求体（17 号 L-1）', expect: ['请求体不是对象'], edits: [{ file: 'projects.js', from: "if (typeof b !== 'object' || Array.isArray(b)) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3a membership.js 的 bodyOf 放过数组请求体（17 号 L-1）', expect: ['请求体不是对象'], edits: [{ file: 'membership.js', from: "if (typeof req.body !== 'object' || Array.isArray(req.body)) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3a canActAsPm 去掉只读否决', expect: ['权限：'], edits: [{ file: 'rules.js', from: '  if (identity.isReadonly) return false;\n  return !!(identity.isPm || identity.isSuper === true);', to: '  return !!(identity.isPm || identity.isSuper === true);' }] },
  { id: 'C3a 节点动作改用「PM 或 admin」判定（admin 未接管可写）', expect: ['权限：'], edits: [{ file: 'rules.js', from: "node_start: Object.freeze({\n    can: canActAsPm,", to: "node_start: Object.freeze({\n    can: (identity) => !identity.isReadonly && (identity.isPm || identity.isAdmin)," }] },
  { id: 'C3a 承接人校验删掉', expect: ['批次 PATCH'], edits: [{ file: 'plan.js', from: "if (!ok) throw stateError('开发承接人须是本项目开发方已加入、未移出的成员');", to: '' }] },
  { id: 'C3a 承接人校验不看参与方类别（需求方成员也放行）', expect: ['批次 PATCH'], edits: [{ file: 'plan.js', from: "WHERE m.id = ? AND m.project_id = ? AND p.project_id = ? AND p.side = 'dev' AND ${rules.MEMBER_ACTIVE_SQL}", to: 'WHERE m.id = ? AND m.project_id = ? AND p.project_id = ? AND ${rules.MEMBER_ACTIVE_SQL}' }] },
  { id: 'C3a 新增节点把里程碑标志写成 1', expect: ['新增 + 改名 + 重排'], edits: [{ file: 'plan.js', from: "VALUES (?, ?, NULL, ?, ?, ?, 0)',", to: "VALUES (?, ?, NULL, ?, ?, ?, 1)'," }] },
  { id: 'C3a 新增节点 g_stage 不校验', expect: ['新增 + 改名 + 重排'], edits: [{ file: 'plan.js', from: "if (typeof body.g_stage !== 'string' || !G_STAGES.includes(body.g_stage)) throw invalid(", to: "if (typeof body.g_stage !== 'string') throw invalid(" }] },
  { id: 'C3a 改名同名也写事件', expect: ['新增 + 改名 + 重排'], edits: [{ file: 'plan.js', from: 'if (name !== node.name) {', to: 'if (true) {' }] },
  // #212 C2 新增（N1，清单 4.4 ②）：现有 confirm 套件 2550–2554 只守五键里各键「该报不报」，抓不到「多出一个键」
  { id: '收口前置：上线节点也要求总体规划包生效', expect: ['收口前置：普通阶段无内容包条件'], edits: [{ file: 'plan.js', from: "if (node.template_key !== 'p_closing' || node.batch_id !== null) return [];", to: "if (node.template_key === 'b_golive') return [{ code: 'PACKAGE_NOT_EFFECTIVE' }]; if (node.template_key !== 'p_closing' || node.batch_id !== null) return [];" }] },
  // ── #212 C6 新增变异（A.3 N1–N3：R2 键检查；N4 在 sysbuild-api-suite-golive.js 的 R3 / R5 用例旁）──
  { id: 'C6 R2：排计划键检查被去掉', expect: [T_C6_R2], edits: [{ file: 'plan.js', from: "if (hasKey(body, 'dev_key_entry_id')) throw invalid('不支持的字段 dev_key_entry_id', 'dev_key_entry_id');", to: '' }] },
  { id: 'C6 R2：键检查晚于 kind 校验', expect: [T_C6_R2], edits: [{ file: 'plan.js', from: "    if (hasKey(body, 'dev_key_entry_id')) throw invalid('不支持的字段 dev_key_entry_id', 'dev_key_entry_id');\n    const kind = body.kind;\n    if (kind !== 'plan' && kind !== 'actual_correct') throw invalid('kind 必须是 plan 或 actual_correct', 'kind');", to: "    const kind = body.kind;\n    if (kind !== 'plan' && kind !== 'actual_correct') throw invalid('kind 必须是 plan 或 actual_correct', 'kind');\n    if (hasKey(body, 'dev_key_entry_id')) throw invalid('不支持的字段 dev_key_entry_id', 'dev_key_entry_id');" }] },
  { id: 'C6 R2：键检查按值判断', expect: [T_C6_R2], edits: [{ file: 'plan.js', from: "if (hasKey(body, 'dev_key_entry_id')) throw invalid(", to: "if (hasKey(body, 'dev_key_entry_id') && body.dev_key_entry_id !== null) throw invalid(" }] },
];

module.exports = { definePlanCases, PLAN_MUTATIONS };
