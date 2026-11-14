// 验证脚本库：项目管理（系统建设记录）模块 C4b Q-S2——「历史补录中」时间窗、历史补录、历史事实导入、与当前确认任务按对象互斥（#113 段 5 C4b）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261102_v1.3.md §4.2（历史补录、历史事实导入、冲突检查）、§4.5、§5.2、§6.2、§7「确认」组
//   派单：docs/local/系统建设记录/送审准备/C4b_Q-S2_时间窗历史补录导入_派单_20261104.md（契约 2.1–2.5；锚点 Q3 = Q-D2 / Q-D3，Q9 = P51–P58）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects；窗口开关、历史补录、历史导入、提交、代录全部走生产端点。只有这几类直接写库：
//   ① 需求部门参与方、现任任职 / 生效授权 / 待处理授权提议（membership 套件另有端点用例，这里只要「这个状态的任职 / 授权」）；② 附件行（暂存）；
//   ③ 把任务修订的创建时间回拨到固定日期（代录的外部确认日期下限取修订创建日；历史补录与历史导入没有下限，P63 / P54）；事件时间是真实时钟，进程内夹具的「今天」是注入的 2026-11-15，依赖事件时间的断言必须先把事件时间写库为固定值；
//   ④ 构造「库内与生产路径不可达」的状态：已有历史导入行的待处理任职 / 授权（互斥判定的事实来源）、待确认修订的授权任务、第二个草稿版本等。
// 日期约定：回拨后的修订创建时间 = FLOOR_AT（2026-10-20 09:00:00）只服务代录用例；历史补录的外部日期与历史导入的原日期都没有下限，只要求不晚于今天（P63 / P54）。
'use strict';
const assert = require('assert');
const path = require('path');

const FLOOR_AT = '2026-10-20 09:00:00';
const FLOOR = '2026-10-20';
const OK_DATE = '2026-10-25';
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
const EV_NO_WRITTEN = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' };

function defineHistoryCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  const stageAtt = (pid, uid, ch) => H.stageAtt(pid, uid, /^[0-9a-f]$/.test(ch) ? ch : (ch.charCodeAt(0) % 16).toString(16));
  const { newProject, defaultBatchId, mkItem, mkPackage, mkVersion, addToSet, tasksOf, planAllNodes, seedEffectiveInitiation, seedParty, confirmAll } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const rowOf = (table, id) => sqlGet(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const today = () => (T.getFixedToday && T.getFixedToday()) || localDate(new Date());
  const winUrl = (pid) => `/sysbuild/projects/${pid}/history-window`;
  const confUrl = (pid) => `/sysbuild/projects/${pid}/history-confirmations`;
  const impUrl = (pid) => `/sysbuild/projects/${pid}/history-imports`;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '历史补录用例' });

  // ── 场景与请求体助手 ───────────────────────────────────────────────────────────────────────────
  async function winBody(pid, action, extra, uid) {
    return Object.assign({ action, attachment_ids: [await stageAtt(pid, uid || U.pm, 'w')] }, extra || {});
  }
  async function openWin(pid) {
    const r = await post(U.pm, winUrl(pid), await winBody(pid, 'open'));
    assert.strictEqual(r.status, 200, r.text);
    return r;
  }
  async function closeWin(pid) {
    const r = await post(U.pm, winUrl(pid), await winBody(pid, 'close'));
    assert.strictEqual(r.status, 200, r.text);
    return r;
  }
  const windowOf = async (pid) => (await sqlGet('SELECT history_window FROM sysbuild_projects WHERE id = ?', [pid])).history_window;
  async function addNaMember(pid, party, name) {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, person_name: name });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.member.id;
  }
  // 凭据三字段（附件由 PM 暂存）；extra 覆盖 / 用 undefined 去掉某个键
  async function evid(pid, extra) {
    return Object.assign({ actual_confirmer: '甲部张主任', identity_basis: '甲部现任负责人，当年的会议纪要', attachment_ids: [await stageAtt(pid, U.pm, 'p')] }, extra || {});
  }
  const confBody = async (pid, objectType, vid, decision, extra) => Object.assign(
    { object_type: objectType, object_version_id: vid, decision, external_date: OK_DATE }, decision === 'confirm' ? {} : { reason: '当年对方提出异议' }, await evid(pid), extra || {}
  );
  const impBody = async (pid, factType, objectId, extra) => Object.assign({ fact_type: factType, object_id: objectId, original_date: OK_DATE }, await evid(pid), extra || {});
  const backdate = async (table, ids) => { for (const id of ids) await sqlRun(`UPDATE ${table} SET created_at = ? WHERE id = ?`, [FLOOR_AT, id]); };

  // 待确认的总体规划包（甲部 own / del 有账号）+ 一条提出人为有账号成员 m1 的条目（提出人任务待确认）：提交后各对象创建时间回拨到 FLOOR_AT
  async function mkPending() {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid);
    const mProp = await addMember(pid, U.m1);
    const item = await mkItem(pid, { proposer_name: undefined, proposer_member_id: mProp });
    const ivid = item.versions[0].id;
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    await addToSet(pv, ivid, await defaultBatchId(pid));
    await planAllNodes(pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    const itask = await sqlGet(
      `SELECT t.id AS tid, r.id AS rid FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id
        WHERE t.object_type = 'item_version' AND t.object_version_id = ? ORDER BY r.rev_no DESC LIMIT 1`, [ivid]
    );
    assert.ok(itask, '提出人任务应已生成');
    // 只回拨任务修订（代录的外部日期下限取修订创建日，用例需要固定下限）。**不回拨包版本 / 条目版本的 created_at**（预筛 HIGH-1 / P63）：历史补录没有日期下限，
    //   版本在生产里就是「3002 切换当天在平台新建」的，回拨它会构造出生产路径到不了的状态、盖住「下限挡住全部历史日期」的缺陷。
    await backdate('sysbuild_confirm_task_revisions', [...tasks.map((t) => t.rev_id), itask.rid]);
    return { pid, A, mProp, item, ivid, pk, pv, tasks, itask };
  }
  // 一个项目当前可观察的全部状态（历史补录 / 被拒的请求不得改动其中任何一项）
  const stateSnap = async (pid) => JSON.stringify([
    await sqlAll('SELECT v.id, v.status, v.effective_at, v.form FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? ORDER BY v.id', [pid]),
    await sqlAll('SELECT r.id, r.status FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY r.id', [pid]),
    await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [pid]),
    await sqlAll('SELECT iv.id, iv.proposer_status, iv.deny_reason FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE it.project_id = ? ORDER BY iv.id', [pid]),
    await sqlAll('SELECT a.id, a.status, a.effective_at FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id WHERE p.project_id = ? ORDER BY a.id', [pid]),
    await sqlAll('SELECT d.id, d.status, d.effective_at FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id WHERE p.project_id = ? ORDER BY d.id', [pid]),
    await sqlAll('SELECT id, status, opened_at, closed_at FROM sysbuild_nodes WHERE project_id = ? ORDER BY id', [pid]),
    await sqlAll('SELECT id, status FROM sysbuild_batches WHERE project_id = ? ORDER BY id', [pid]),
    await sqlAll('SELECT r.id FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? ORDER BY r.id', [pid]),
    await sqlAll('SELECT id FROM sysbuild_history_imports WHERE project_id = ? ORDER BY id', [pid]),
    await sqlAll("SELECT c.id FROM sysbuild_confirmations c WHERE c.method = 'history' ORDER BY c.id"),
    await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type IN ('history_import', 'event') ORDER BY id"),
    await sqlAll('SELECT id FROM sysbuild_events WHERE project_id = ? ORDER BY id', [pid]),
  ]);
  // 内容包生效的可观察结果（普通路径与历史导入路径用同一个断言函数比对，不含编号 / 时刻）
  async function effectSnap(pid, vid) {
    const v = await sqlGet('SELECT status, form FROM sysbuild_package_versions WHERE id = ?', [vid]);
    const baselines = await sqlAll(
      `SELECT n.template_key AS k, r.planned_start AS s, r.planned_end AS e, r.package_version_id AS pv FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id
        WHERE n.project_id = ? AND r.kind = 'baseline' ORDER BY n.id`, [pid]
    );
    const batches = (await sqlAll('SELECT status FROM sysbuild_batches WHERE project_id = ? ORDER BY id', [pid])).map((b) => b.status);
    const frozen = await countOf("SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ?", [vid]);
    const nonBaseline = await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'plan_change'", [pid]);
    // 节点计划快照（MED-2）：普通生效 = 提交事件的 node_plans；导入生效 = 导入事件的 node_plans；两条路径同形，按模板键比对（不含节点 / 批次编号）
    const evT = await sqlGet(
      "SELECT payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type IN ('package_version_submitted', 'history_fact_imported') ORDER BY id DESC LIMIT 1", [vid]
    );
    const plansSnap = (JSON.parse(evT.payload_json).node_plans || []).map((p) => [p.template_key, p.name, p.layer, p.batch_name, p.planned_start, p.planned_end]);
    const frozenIds = (await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY attachment_id", [vid])).length;
    return { status: v.status, form: v.form, baselines: baselines.map((b) => [b.k, b.s, b.e, b.pv === vid]), batches, frozen, frozenIds, plans: nonBaseline, plansSnap };
  }
  // 总体规划包导入场景：无任何成员 / 任职（P56 不要求确认人齐全），立项包已生效（夹具），一条带证据附件的条目，计划齐全，窗口已开启
  async function mkImportScene(opt) {
    const o = opt || {};
    const pid = await newProject();
    await openWin(pid);
    // 立项包：经历史导入生效（原日期 2026-10-20），而不是夹具直接写生效——总体规划导入的原日期不得早于立项包生效日（P68 ④），夹具写的生效时刻是「此刻」，会把后续合法的历史日期全挡掉
    if (!o.noInitiation) {
      const ipv = await mkVersion(await mkPackage(pid, 'initiation'));
      const ri = await post(U.pm, impUrl(pid), await impBody(pid, 'package_effective', ipv, { original_date: FLOOR }));
      assert.strictEqual(ri.status, 201, ri.text);
    }
    const att = await stageAtt(pid, U.pm, 'a');
    const item = await mkItem(pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const pk = await mkPackage(pid, 'overall');
    if (o.beforeVersion) await o.beforeVersion(pid); // 用例钩子：建草稿版本之前改变项目现状（如形态回写用例先造第二个批次）
    const pv = await mkVersion(pk);
    if (o.afterVersion) await o.afterVersion(pid, pv); // 建好草稿之后、导入之前改变项目现状
    // 包材料附件（LOW-4）：绑定在包版本上（owner_type = package_version），提交 / 导入时随包冻结
    const matAtt = await stageAtt(pid, U.pm, 'm');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [matAtt, pv, U.pm]);
    if (!o.emptySet) await addToSet(pv, item.versions[0].id, await defaultBatchId(pid));
    if (!o.noPlans) await planAllNodes(pid);
    return { pid, att, matAtt, item, pk, pv };
  }

  // ── 1 时间窗 ─────────────────────────────────────────────────────────────────────────────────
  test('C4b 历史 窗口：状态机全组合——open（never → open，PM）/ close（open → closed，PM）/ reopen（closed → open，admin 写原因）；其余组合 409；每个动作写事件并以 owner_type = event 绑定凭据；被拒的请求不改任何状态', async () => {
    const pid = await newProject();
    const url = winUrl(pid);
    assert.strictEqual(await windowOf(pid), 'never');
    const w0 = await get(U.pm, `/sysbuild/projects/${pid}`);
    assert.strictEqual(w0.body.project.history_window, 'never');
    // 400 参数形态（先于一切数据库检查）
    const shapes = [
      [{ x: 1 }, 'x', '多余键'], [{ action: undefined }, 'action', '缺 action'], [{ action: 'pause' }, 'action', 'action 枚举'], [{ action: 7 }, 'action', 'action 非文本'],
      [{ attachment_ids: undefined }, 'attachment_ids', '缺凭据'], [{ attachment_ids: [] }, 'attachment_ids', '空凭据'], [{ attachment_ids: 'a' }, 'attachment_ids', '凭据非数组'],
      [{ attachment_ids: [0] }, 'attachment_ids', '凭据编号非法'], [{ reason: '甲'.repeat(501) }, 'reason', '原因 501 字'],
    ];
    for (const [extra, field, label] of shapes) {
      const r = await post(U.pm, url, await winBody(pid, 'open', extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    }
    const dup = await stageAtt(pid, U.pm, 'd');
    expectErr(await post(U.pm, url, await winBody(pid, 'open', { attachment_ids: [dup, dup] })), 400, 'SYSBUILD_INVALID_INPUT', '凭据重复');
    expectErr(await post(U.pm, '/sysbuild/projects/abc/history-window', await winBody(pid, 'open')), 400, 'SYSBUILD_INVALID_INPUT', '项目编号非法');
    // 404 / 403
    expectErr(await post(U.pm, '/sysbuild/projects/99999999/history-window', await winBody(pid, 'open')), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
    expectErr(await post(U.out, url, await winBody(pid, 'open')), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    await addMember(pid, U.m1);
    await addMember(pid, U.ro);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.admin, 'admin 非 PM'], [U.ro, '只读账号成员']]) {
      expectErr(await post(uid, url, await winBody(pid, 'open', null, uid)), 403, 'SYSBUILD_FORBIDDEN', `${label} 开启`);
    }
    // never 状态下 close / reopen 都是 409
    expectErr(await post(U.pm, url, await winBody(pid, 'close')), 409, 'SYSBUILD_STATE', 'never 下关闭');
    expectErr(await post(U.admin, url, await winBody(pid, 'reopen', { reason: '补' }, U.admin)), 409, 'SYSBUILD_STATE', 'never 下重开');
    assert.strictEqual(await windowOf(pid), 'never', '被拒的动作不改窗口');
    assert.strictEqual((await eventsOf(pid, 'history_window_opened')).length, 0);
    // open：PM 成功，凭据绑定在事件行上
    const att = await stageAtt(pid, U.pm, 'o');
    const ro = await post(U.pm, url, { action: 'open', reason: '客户服务平台切换补录', attachment_ids: [att] });
    assert.strictEqual(ro.status, 200, ro.text);
    assert.deepStrictEqual([ro.body.history_window, ro.body.attachment_ids], ['open', [att]]);
    assert.strictEqual(await windowOf(pid), 'open');
    const opened = await eventsOf(pid, 'history_window_opened');
    assert.strictEqual(opened.length, 1);
    assert.deepStrictEqual(JSON.parse(opened[0].payload_json), { from: 'never', to: 'open', reason: '客户服务平台切换补录' });
    assert.deepStrictEqual([opened[0].object_type, opened[0].object_id, opened[0].operator_id], ['project', pid, U.pm]);
    assert.deepStrictEqual(await sqlAll('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att]), [{ owner_type: 'event', owner_id: opened[0].id, bound_by: U.pm }]);
    const pr = await get(U.pm, `/sysbuild/projects/${pid}`);
    assert.strictEqual(pr.body.project.history_window, 'open');
    // 凭据附件不能普通软删除（P59 同模式：event 凭据）——删除端点在进程内夹具里没有挂载，由 verify-sysbuild-attachments.js 的 D1 用例（含 event）与变异覆盖
    // open 下再开启 / 重开 409
    expectErr(await post(U.pm, url, await winBody(pid, 'open')), 409, 'SYSBUILD_STATE', 'open 下再开启');
    expectErr(await post(U.admin, url, await winBody(pid, 'reopen', { reason: '补' }, U.admin)), 409, 'SYSBUILD_STATE', 'open 下重开');
    // close：admin 非 PM / 成员不行；PM 成功
    expectErr(await post(U.admin, url, await winBody(pid, 'close', null, U.admin)), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM 关闭');
    expectErr(await post(U.m1, url, await winBody(pid, 'close', null, U.m1)), 403, 'SYSBUILD_FORBIDDEN', '成员关闭');
    const rc = await post(U.pm, url, await winBody(pid, 'close', { reason: '补录完成' }));
    assert.strictEqual(rc.status, 200, rc.text);
    assert.strictEqual(await windowOf(pid), 'closed');
    assert.deepStrictEqual(await payloads(pid, 'history_window_closed'), [{ from: 'open', to: 'closed', reason: '补录完成' }]);
    // closed：PM 不能再开启、不能关闭、不能重开；重开要 admin 且必须写原因
    expectErr(await post(U.pm, url, await winBody(pid, 'open')), 409, 'SYSBUILD_STATE', 'closed 下 PM 开启');
    expectErr(await post(U.pm, url, await winBody(pid, 'close')), 409, 'SYSBUILD_STATE', 'closed 下再关闭');
    expectErr(await post(U.pm, url, await winBody(pid, 'reopen', { reason: '补' })), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能重开');
    expectErr(await post(U.m1, url, await winBody(pid, 'reopen', { reason: '补' }, U.m1)), 403, 'SYSBUILD_FORBIDDEN', '成员不能重开');
    const noReason = await post(U.admin, url, await winBody(pid, 'reopen', null, U.admin));
    expectErr(noReason, 400, 'SYSBUILD_INVALID_INPUT', '重开不写原因');
    assert.strictEqual(noReason.body.field, 'reason');
    expectErr(await post(U.admin, url, await winBody(pid, 'reopen', { reason: '   ' }, U.admin)), 400, 'SYSBUILD_INVALID_INPUT', '重开原因空白');
    assert.strictEqual(await windowOf(pid), 'closed');
    const rr = await post(U.admin, url, await winBody(pid, 'reopen', { reason: '发现遗漏的历史任职需补录' }, U.admin));
    assert.strictEqual(rr.status, 200, rr.text);
    assert.strictEqual(await windowOf(pid), 'open');
    assert.deepStrictEqual(await payloads(pid, 'history_window_reopened'), [{ from: 'closed', to: 'open', reason: '发现遗漏的历史任职需补录' }]);
    const evR = (await eventsOf(pid, 'history_window_reopened'))[0];
    assert.deepStrictEqual(await sqlAll("SELECT owner_type, owner_id FROM sysbuild_attachment_bindings WHERE owner_type = 'event' AND owner_id = ?", [evR.id]), [{ owner_type: 'event', owner_id: evR.id }]);
    assert.strictEqual(evR.operator_id, U.admin);
    // 重开后可再关闭（open → closed → open 可循环，只是重开须 admin 写原因）
    assert.strictEqual((await post(U.pm, url, await winBody(pid, 'close'))).status, 200);
    // 项目状态：已暂停可做；已终止 / 已结项 409
    const p2 = await newProject();
    assert.strictEqual((await setStatus(p2, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, winUrl(p2), await winBody(p2, 'open'))).status, 200, '已暂停可开启');
    assert.strictEqual((await setStatus(p2, 'terminated')).status, 200);
    // P67：关闭不受项目状态限制（已终止 / 已结项也能关，关闭只收窄能力）；开启 / 重开仍受限
    const tc = await post(U.pm, winUrl(p2), await winBody(p2, 'close'));
    assert.strictEqual(tc.status, 200, `已终止项目可关闭 ${tc.text}`);
    assert.strictEqual(await windowOf(p2), 'closed');
    expectErr(await post(U.admin, winUrl(p2), await winBody(p2, 'reopen', { reason: 'x' }, U.admin)), 409, 'SYSBUILD_PROJECT_READONLY', '已终止重开');
    expectErr(await post(U.pm, winUrl(p2), await winBody(p2, 'open')), 409, 'SYSBUILD_PROJECT_READONLY', '已终止开启（项目状态先于窗口状态判定）');
    const p5 = await newProject();
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed', history_window = 'open' WHERE id = ?", [p5]);
    assert.strictEqual((await post(U.pm, winUrl(p5), await winBody(p5, 'close'))).status, 200, '已结项项目可关闭');
    assert.strictEqual(await windowOf(p5), 'closed');
    const pr5 = await get(U.admin, `/sysbuild/projects/${p5}`);
    assert.strictEqual(pr5.body.actions.history_window_reopen, false, '已结项项目重开标志为假');
    const p3 = await newProject();
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [p3]);
    expectErr(await post(U.pm, winUrl(p3), await winBody(p3, 'open')), 409, 'SYSBUILD_PROJECT_READONLY', '已结项开启');
    assert.strictEqual(await windowOf(p3), 'never');
    // 事务一致：附件校验失败（别人的附件）整体回滚，窗口不变、不留事件
    const p4 = await newProject();
    const other = await stageAtt(p4, U.m2, 'x');
    const bad = await post(U.pm, winUrl(p4), { action: 'open', attachment_ids: [other] });
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '别人的凭据附件');
    assert.strictEqual(await windowOf(p4), 'never', '凭据校验失败回滚，窗口不变');
    assert.strictEqual((await eventsOf(p4, 'history_window_opened')).length, 0, '不留窗口事件');
  });

  test('C4b 历史 窗口 actions：项目读接口返回 history_window 与三个窗口动作标志 + 历史补录 / 导入标志，标志 ⇔ 执行（同一张 OBJECT_OPS 表）', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const flags = async (uid) => {
      const r = await get(uid, `/sysbuild/projects/${pid}`);
      assert.strictEqual(r.status, 200, r.text);
      const a = r.body.actions;
      return [r.body.project.history_window, a.history_window_open, a.history_window_close, a.history_window_reopen, a.history_confirm, a.history_import];
    };
    assert.deepStrictEqual(await flags(U.pm), ['never', true, false, false, false, false]);
    assert.deepStrictEqual(await flags(U.admin), ['never', false, false, false, false, false], 'admin 非 PM：开启 / 关闭否；never 下重开否');
    assert.deepStrictEqual(await flags(U.m1), ['never', false, false, false, false, false]);
    await openWin(pid);
    assert.deepStrictEqual(await flags(U.pm), ['open', false, true, false, true, true]);
    assert.deepStrictEqual(await flags(U.admin), ['open', false, false, false, false, false]);
    assert.deepStrictEqual(await flags(U.m1), ['open', false, false, false, false, false]);
    await closeWin(pid);
    assert.deepStrictEqual(await flags(U.pm), ['closed', false, false, false, false, false], '关闭后 PM 不能再开启 / 重开，也不能补录 / 导入');
    assert.deepStrictEqual(await flags(U.admin), ['closed', false, false, true, false, false], '关闭后只有 admin 可重开');
    // 标志为真则执行必 2xx；标志为假则执行 409/403（逐一对照）
    const r = await post(U.admin, winUrl(pid), await winBody(pid, 'reopen', { reason: '补' }, U.admin));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.actions, { open: false, close: false, reopen: false }, '写端点响应里的动作标志按操作人（admin 非 PM）重算：开启 / 关闭否（PM 专属），open 状态下重开否');
  });

  // ── 2 历史补录 ───────────────────────────────────────────────────────────────────────────────
  const statePart = async (pid) => JSON.stringify(JSON.parse(await stateSnap(pid)).slice(0, 9)); // 业务状态部分（不含历史记录 / 附件绑定 / 事件）
  test('C4b 历史 补录：窗口内 PM 录入过去的确认事实（method = history、不挂任务修订、proxy_by = 当前用户、凭据 owner_type = confirmation），不改任何状态（含提出人状态）、不满足当前任务；任务 / 版本详情把历史补录与当前修订的记录分开返回', async () => {
    const s = await mkPending();
    const url = confUrl(s.pid);
    expectErr(await post(U.pm, url, await confBody(s.pid, 'package_version', s.pv, 'confirm')), 409, 'SYSBUILD_STATE', '窗口未开启');
    await openWin(s.pid);
    const snap0 = await stateSnap(s.pid);
    const state0 = await statePart(s.pid);
    const good = (extra) => confBody(s.pid, 'package_version', s.pv, 'confirm', extra);
    // 400 参数形态
    const shapes = [
      [{ x: 1 }, 'x'], [{ object_type: undefined }, 'object_type'], [{ object_type: 'invitation' }, 'object_type'], [{ object_type: 'dev_entry' }, 'object_type'],
      [{ object_version_id: 'abc' }, 'object_version_id'], [{ object_version_id: undefined }, 'object_version_id'], [{ decision: 'maybe' }, 'decision'], [{ decision: undefined }, 'decision'],
      [{ external_date: undefined }, 'external_date'], [{ external_date: '2026-02-30' }, 'external_date'], [{ actual_confirmer: '  ' }, 'actual_confirmer'], [{ identity_basis: undefined }, 'identity_basis'],
      [{ attachment_ids: undefined }, 'attachment_ids'], [{ attachment_ids: [] }, 'attachment_ids'],
    ];
    for (const [extra, field] of shapes) {
      const r = await post(U.pm, url, await good(extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `参数 ${field}`);
      assert.strictEqual(r.body.field, field);
    }
    const rNoAtt = await post(U.pm, url, await good({ attachment_ids: undefined }));
    assert.ok(rNoAtt.body.message.startsWith('历史补录必须附'), `缺凭据的文案按动作名「历史补录」，实际 ${rNoAtt.body.message}`);
    const rObj = await post(U.pm, url, await confBody(s.pid, 'package_version', s.pv, 'object', { reason: undefined }));
    expectErr(rObj, 400, 'SYSBUILD_INVALID_INPUT', 'object 缺原因');
    assert.strictEqual(rObj.body.field, 'reason');
    expectErr(await post(U.pm, url, await confBody(s.pid, 'package_version', s.pv, 'reject', { reason: '   ' })), 400, 'SYSBUILD_INVALID_INPUT', 'reject 原因空白');
    // 404 / 403
    expectErr(await post(U.out, url, await good()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.m1, url, await good()), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.admin, url, await good()), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM');
    expectErr(await post(U.own, url, await good()), 403, 'SYSBUILD_FORBIDDEN', '必需确认人（负责人）本人');
    // 409：对象版本不存在 / 属别的项目 / 条目版本属别的项目
    const other = await newProject();
    const otherItem = await mkItem(other);
    expectErr(await post(U.pm, url, await good({ object_version_id: 99999999 })), 409, 'SYSBUILD_STATE', '版本不存在');
    expectErr(await post(U.pm, url, await confBody(s.pid, 'item_version', otherItem.versions[0].id, 'confirm')), 409, 'SYSBUILD_STATE', '别的项目的条目版本');
    const otherPv = await mkVersion(await mkPackage(other, 'initiation'));
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [otherPv]); // 非草稿：否则草稿 409（P66）会遮蔽归属判定
    expectErr(await post(U.pm, url, await confBody(s.pid, 'package_version', otherPv, 'confirm')), 409, 'SYSBUILD_STATE', '别的项目的包版本');
    // 409 先于 400 日期范围
    expectErr(await post(U.pm, url, await good({ object_version_id: 99999999, external_date: addDays(today(), 1) })), 409, 'SYSBUILD_STATE', '409 先于日期范围');
    // 400 日期范围：上限 = 今天，没有下限（P63）；附件可用性
    const late = await post(U.pm, url, await good({ external_date: addDays(today(), 1) }));
    expectErr(late, 400, 'SYSBUILD_INVALID_INPUT', '晚于今天');
    assert.strictEqual(late.body.field, 'external_date');
    assert.ok(late.body.message.includes('外部确认日期不能晚于今天'), `文案实际 ${late.body.message}`);
    // P63：没有下限——平台当天才建的版本（生产路径到得了的状态：这里的版本创建于今天），过去的外部日期照样成功（成功路径见下面的 r1 / old）
    const vCreated = (await rowOf('sysbuild_package_versions', s.pv)).created_at.slice(0, 10);
    assert.ok(vCreated > FLOOR, `版本创建日 ${vCreated} 晚于 ${FLOOR}：用例构造的是「平台当天新建的版本 + 过去的外部日期」`);
    const foreign = await stageAtt(other, U.pm, 's');
    expectErr(await post(U.pm, url, await good({ attachment_ids: [foreign] })), 400, 'SYSBUILD_INVALID_INPUT', '别的项目的附件');
    assert.strictEqual(await stateSnap(s.pid), snap0, '被拒绝的请求不改任何状态（含历史记录 / 附件绑定 / 事件）');
    // 项目状态：已终止 409
    const p2 = await newProject();
    await openWin(p2);
    const it2 = await mkItem(p2);
    assert.strictEqual((await setStatus(p2, 'terminated')).status, 200);
    expectErr(await post(U.pm, confUrl(p2), await confBody(p2, 'item_version', it2.versions[0].id, 'confirm')), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    // 成功：包版本确认（外部日期 2026-10-20，早于版本在平台上的创建日）、包版本不认可（边界：外部日期 = 今天）、条目版本不认可
    const a1 = await stageAtt(s.pid, U.pm, 'h');
    const old = await post(U.pm, url, await good({ external_date: '2001-03-04' }));
    assert.strictEqual(old.status, 201, `很早的外部日期也应成功（没有下限）${old.text}`);
    const r1 = await post(U.pm, url, await good({ external_date: FLOOR, attachment_ids: [a1] }));
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual(r1.body.attachment_ids, [a1]);
    assert.deepStrictEqual(r1.body.confirmation, { id: r1.body.confirmation.id, method: 'history', label: '历史补录', object_type: 'package_version', object_version_id: s.pv, decision: 'confirm', external_date: FLOOR });
    const c1 = await rowOf('sysbuild_confirmations', r1.body.confirmation.id);
    assert.deepStrictEqual(c1, {
      id: c1.id, task_revision_id: null, object_type: 'package_version', object_version_id: s.pv, actor_user_id: null, actual_confirmer: '甲部张主任', identity_basis: '甲部现任负责人，当年的会议纪要',
      method: 'history', decision: 'confirm', checkbox_text: null, reason: null, view_id: null, external_date: FLOOR, proxy_by: U.pm, card_instance_id: null, dingtalk_user_id: null, created_at: c1.created_at,
    });
    assert.deepStrictEqual(await sqlAll('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [a1]), [{ owner_type: 'confirmation', owner_id: c1.id, bound_by: U.pm }]);
    assert.deepStrictEqual((await payloads(s.pid, 'history_confirmation_recorded')).filter((p) => p.confirmation_id === c1.id), [{
      confirmation_id: c1.id, object_type: 'package_version', object_version_id: s.pv, decision: 'confirm', method: 'history', actual_confirmer: '甲部张主任',
      identity_basis: '甲部现任负责人，当年的会议纪要', external_date: FLOOR, attachment_ids: [a1], reason: null,
    }]);
    const ev1 = (await eventsOf(s.pid, 'history_confirmation_recorded'))[0];
    assert.deepStrictEqual([ev1.object_type, ev1.object_id], ['package_version', s.pv]);
    assert.strictEqual((await eventsOf(s.pid, 'confirm_proxy_recorded')).length, 0, '历史补录不写代录事件');
    const r2 = await post(U.pm, url, await good({ decision: 'reject', reason: '当年对方明确不认可', external_date: today() }));
    assert.strictEqual(r2.status, 201, `外部日期 = 今天应通过 ${r2.text}`);
    const r3 = await post(U.pm, url, await confBody(s.pid, 'item_version', s.ivid, 'reject'));
    assert.strictEqual(r3.status, 201, r3.text);
    assert.strictEqual((await rowOf('sysbuild_confirmations', r3.body.confirmation.id)).reason, '当年对方提出异议');
    // 不改任何状态（P53）：版本仍待确认、修订仍待确认、提出人状态仍 pending、没有新任务
    assert.strictEqual(await statePart(s.pid), state0, '历史补录不改业务状态');
    assert.deepStrictEqual((await tasksOf(s.pv)).map((t) => t.status), ['pending', 'pending']);
    assert.strictEqual((await sqlGet('SELECT proposer_status FROM sysbuild_item_versions WHERE id = ?', [s.ivid])).proposer_status, 'pending', '提出人不认可的历史补录不改提出人状态');
    // 读：任务详情把历史补录与当前修订的记录分开返回
    const d = await H.openTask(U.pm, s.tasks[0].task_id);
    assert.strictEqual(d.status, 200, d.text);
    assert.deepStrictEqual(d.body.confirmations, [], '当前修订没有确认记录（历史补录不混进来）');
    assert.deepStrictEqual(d.body.history_confirmations.map((c) => [c.method, c.label, c.decision, c.external_date, c.attachment_ids.length, c.proxy_by]), [['history', '历史补录', 'confirm', '2001-03-04', 1, U.pm], ['history', '历史补录', 'confirm', FLOOR, 1, U.pm], ['history', '历史补录', 'reject', today(), 1, U.pm]]);
    const di = await H.openTask(U.pm, s.itask.tid);
    assert.deepStrictEqual(di.body.history_confirmations.map((c) => [c.object_type, c.decision]), [['item_version', 'reject']]);
    const dv = await get(U.pm, `/sysbuild/package-versions/${s.pv}`);
    assert.strictEqual(dv.status, 200, dv.text);
    assert.deepStrictEqual(dv.body.history_confirmations.map((c) => c.decision), ['confirm', 'confirm', 'reject']);
    assert.deepStrictEqual(dv.body.history_imports, []);
    const lst = await get(U.pm, `/sysbuild/projects/${s.pid}/history-confirmations?object_type=package_version&object_version_id=${s.pv}`);
    assert.deepStrictEqual(lst.body.history_confirmations.map((c) => c.id), [old.body.confirmation.id, r1.body.confirmation.id, r2.body.confirmation.id]);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}/history-confirmations`)).body.history_confirmations.length, 4, '无过滤：本项目全部历史补录');
    // LOW-6：历史补录记录的附件与任务详情确认记录同一种视图（attachments 含遮蔽 / 删除标记，遮蔽的不返回原名）
    assert.deepStrictEqual(lst.body.history_confirmations[1].attachments.map((x) => [x.attachment_id, x.masked, x.name, x.deleted, x.deleted_by]), [[a1, false, '确认证据.txt', false, null]]);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = 1, mask_reason = '含敏感信息' WHERE id = ?", [a1]);
    const lm = await get(U.pm, `/sysbuild/projects/${s.pid}/history-confirmations?object_type=package_version&object_version_id=${s.pv}`);
    assert.deepStrictEqual(lm.body.history_confirmations[1].attachments.map((x) => [x.masked, x.name]), [[true, null]]);
    assert.ok(!JSON.stringify(lm.body.history_confirmations[1]).includes('确认证据'), '遮蔽后这条历史补录记录整体不含原名');
    await sqlRun('UPDATE sysbuild_attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?', ['2026-10-31 10:00:00', U.admin, a1]);
    const ld = (await get(U.pm, `/sysbuild/projects/${s.pid}/history-confirmations?object_type=package_version&object_version_id=${s.pv}`)).body.history_confirmations[1];
    assert.deepStrictEqual([ld.attachment_ids, ld.attachments[0].deleted, ld.attachments[0].deleted_by], [[a1], true, U.admin], '已软删除的凭据仍列出并标删除人');
    const dvm = await get(U.pm, `/sysbuild/package-versions/${s.pv}`);
    assert.deepStrictEqual(dvm.body.history_confirmations[1].attachments.map((x) => [x.masked, x.name, x.deleted]), [[true, null, true]], '版本详情同一视图');
    assert.strictEqual((await get(U.out, `/sysbuild/projects/${s.pid}/history-confirmations`)).status, 404);
    // 当前必需确认人照常在平台确认，全部确认后版本生效（历史补录不满足也不阻挡当前任务）
    assert.strictEqual((await H.openAndDecide(U.own, s.tasks[0].task_id, 'confirm')).status, 200);
    const last = await H.openAndDecide(U.del, s.tasks[1].task_id, 'confirm');
    assert.deepStrictEqual([last.status, last.body.effective], [200, true]);
  });

  test('C4b 历史 补录 冻结与草稿（P66）：草稿内容包版本不能补录（409）；条目版本补录时在同一事务里冻结其附件清单（已冻结则跳过、重复补录不重复冻结）；非草稿版本照常补录', async () => {
    const pid = await newProject();
    await openWin(pid);
    const pk = await mkPackage(pid, 'initiation');
    const pvDraft = await mkVersion(pk);
    const snap0 = await stateSnap(pid);
    const d = await post(U.pm, confUrl(pid), await confBody(pid, 'package_version', pvDraft, 'confirm'));
    expectErr(d, 409, 'SYSBUILD_STATE', '草稿版本不能补录');
    assert.ok(d.body.message.includes('草稿'), `提示实际 ${d.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap0, '被拒不改任何状态');
    // 版本导入生效（不再是草稿）后可以补录
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'package_effective', pvDraft))).status, 201);
    assert.strictEqual((await post(U.pm, confUrl(pid), await confBody(pid, 'package_version', pvDraft, 'confirm'))).status, 201, '非草稿版本照常补录');
    // 条目版本：没有提出人任务（只填姓名）→ 附件未冻结；补录后冻结
    const frozenOf = (ivid) => sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'item_version' AND object_version_id = ? ORDER BY attachment_id", [ivid]);
    const att = await stageAtt(pid, U.pm, 'f');
    const item = await mkItem(pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const ivid = item.versions[0].id;
    assert.deepStrictEqual(await frozenOf(ivid), [], '补录前未冻结');
    const r1 = await post(U.pm, confUrl(pid), await confBody(pid, 'item_version', ivid, 'confirm'));
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual((await frozenOf(ivid)).map((x) => x.attachment_id), [att], '补录同一事务冻结条目版本附件');
    assert.strictEqual((await eventsOf(pid, 'attachment_frozen')).filter((e) => JSON.parse(e.payload_json).object_version_id === ivid).length, 1);
    const r2 = await post(U.pm, confUrl(pid), await confBody(pid, 'item_version', ivid, 'reject'));
    assert.strictEqual(r2.status, 201, `重复补录不因已冻结而失败 ${r2.text}`);
    assert.deepStrictEqual((await frozenOf(ivid)).map((x) => x.attachment_id), [att], '重复补录不重复冻结');
    // 已冻结（提出人任务生成时）：补录跳过冻结，不重复
    const mProp = await addMember(pid, U.m1);
    const att2 = await stageAtt(pid, U.pm, 'g');
    const item2 = await mkItem(pid, { proposer_name: undefined, proposer_member_id: mProp, attachment_ids: [att2], no_written_evidence: undefined, no_evidence_reason: undefined });
    const iv2 = item2.versions[0].id;
    assert.deepStrictEqual((await frozenOf(iv2)).map((x) => x.attachment_id), [att2], '提出人任务生成时已冻结');
    assert.strictEqual((await post(U.pm, confUrl(pid), await confBody(pid, 'item_version', iv2, 'confirm'))).status, 201);
    assert.deepStrictEqual((await frozenOf(iv2)).map((x) => x.attachment_id), [att2], '已冻结则跳过');
  });

  test('C4b 历史 窗口 重开冲突（P67）：重开时本项目有历史记录的对象上仍有当前待处理的修订 / 待接受项 → 409 列出对象；处理完（撤回 / 代录 / 失效）后可重开；开启（never → open）不做此检查', async () => {
    const s = await mkPending();
    await openWin(s.pid);
    assert.strictEqual((await post(U.pm, confUrl(s.pid), await confBody(s.pid, 'package_version', s.pv, 'confirm'))).status, 201);
    assert.strictEqual((await post(U.pm, confUrl(s.pid), await confBody(s.pid, 'item_version', s.ivid, 'confirm'))).status, 201);
    await closeWin(s.pid);
    const reopen = async () => post(U.admin, winUrl(s.pid), await winBody(s.pid, 'reopen', { reason: '补录遗漏的历史确认' }, U.admin));
    const r1 = await reopen();
    expectErr(r1, 409, 'SYSBUILD_STATE', '有待处理任务时重开');
    assert.ok(r1.body.message.includes(`内容包版本 #${s.pv}`), `列出内容包版本，实际 ${r1.body.message}`);
    assert.ok(r1.body.message.includes(`条目版本 #${s.ivid}`), `列出条目版本，实际 ${r1.body.message}`);
    assert.strictEqual(await windowOf(s.pid), 'closed', '被拒不改窗口');
    assert.strictEqual((await eventsOf(s.pid, 'history_window_reopened')).length, 0);
    // 标志只承诺项目级（权限 + 项目状态 + 窗口状态）：有冲突时标志仍为真，执行时 409
    assert.strictEqual((await get(U.admin, `/sysbuild/projects/${s.pid}`)).body.actions.history_window_reopen, true);
    // 撤回内容包版本（窗口已关闭，互斥不拦）→ 内容包的待处理修订撤回后为 invalid（confirm.js:349 withdraw 调 closePendingRevision(…, 'invalid')；改发才是 superseded），只剩条目
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${s.pv}/withdraw`, { reason: '重新提交' })).status, 200);
    const r2 = await reopen();
    expectErr(r2, 409, 'SYSBUILD_STATE', '只剩条目');
    assert.ok(!r2.body.message.includes('内容包版本'), `内容包已处理，实际 ${r2.body.message}`);
    assert.ok(r2.body.message.includes(`条目版本 #${s.ivid}`));
    // 条目任务由 PM 代录确认（窗口已关闭）后可重开
    const itBody = Object.assign({ revision_id: s.itask.rid, object_version_id: s.ivid, decision: 'confirm' }, await evid(s.pid, { external_date: OK_DATE }));
    assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${s.itask.tid}/proxy`, itBody)).status, 200);
    const r3 = await reopen();
    assert.strictEqual(r3.status, 200, r3.text);
    assert.strictEqual(await windowOf(s.pid), 'open');
    // 任职 / 授权的待接受（有历史导入行）同样拦重开
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const ap = await mkPendingAppt(pid, party, '无账号负责人');
    const partyB = await addParty(pid, '乙部', 'demand');
    const mO = await addNaMember(pid, partyB, '乙部负责人');
    const apt = await addAppointment(partyB, mO, 'active');
    const mD = await addNaMember(pid, partyB, '乙部代表人');
    const dg = await addDelegation(partyB, mD, apt, 'pending_accept');
    for (const [ot, oid] of [['appointment', ap.aid], ['delegation', dg]]) {
      await sqlRun(
        "INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, ?, ?, ?, '张三', '当年文件', '2026-10-01', ?)",
        [pid, ot, oid, ot, U.pm]
      );
    }
    await closeWin(pid);
    const rp = await post(U.admin, winUrl(pid), await winBody(pid, 'reopen', { reason: '补' }, U.admin));
    expectErr(rp, 409, 'SYSBUILD_STATE', '待接受的任职 / 授权');
    assert.ok(rp.body.message.includes(`任职 #${ap.aid}`) && rp.body.message.includes(`授权 #${dg}`), `实际 ${rp.body.message}`);
    // 开启（never → open）不做此检查：没有历史记录
    const p0 = await newProject();
    assert.strictEqual((await post(U.pm, winUrl(p0), await winBody(p0, 'open'))).status, 200);
  });

  test('C4b 历史 窗口 重开冲突 按对象判（LOW-1）：窗口关闭期间当前修订变为 objected（包版本仍 pending / 条目 proposer_status 仍 pending）→ 重开 409 并列出该对象；条目旧版本（已不是最新）不拦；处理完后可重开', async () => {
    const s = await mkPending();
    await openWin(s.pid);
    const item2 = await mkItem(s.pid, { proposer_name: undefined, proposer_member_id: s.mProp });
    const iv2a = item2.versions[0].id;
    const t2a = await sqlGet(
      `SELECT t.id AS tid, r.id AS rid FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'item_version' AND t.object_version_id = ?`, [iv2a]
    );
    assert.ok(t2a, '第二个条目的提出人任务应已生成');
    for (const [ot, vid] of [['package_version', s.pv], ['item_version', s.ivid], ['item_version', iv2a]]) {
      assert.strictEqual((await post(U.pm, confUrl(s.pid), await confBody(s.pid, ot, vid, 'confirm'))).status, 201);
    }
    await closeWin(s.pid);
    await backdate('sysbuild_confirm_task_revisions', [t2a.rid]);
    const proxyOf = async (tid, rid, vid, decision) => post(U.pm, `/sysbuild/confirm-tasks/${tid}/proxy`, Object.assign(
      { revision_id: rid, object_version_id: vid, decision }, decision === 'confirm' ? {} : { reason: '对方提出异议' }, await evid(s.pid, { external_date: OK_DATE })
    ));
    // 窗口关闭期间：包任务与两条提出人任务的当前修订全部代录为「有异议」——对象本身仍待确认
    for (const t of s.tasks) assert.strictEqual((await proxyOf(t.task_id, t.rev_id, s.pv, 'object')).status, 200);
    assert.strictEqual((await proxyOf(s.itask.tid, s.itask.rid, s.ivid, 'object')).status, 200);
    assert.strictEqual((await proxyOf(t2a.tid, t2a.rid, iv2a, 'object')).status, 200);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ? AND r.status = 'pending'", [s.pid]), 0, '所有当前修订都不再是 pending');
    assert.strictEqual((await rowOf('sysbuild_package_versions', s.pv)).status, 'pending', '包版本仍待确认');
    assert.deepStrictEqual([(await rowOf('sysbuild_item_versions', s.ivid)).proposer_status, (await rowOf('sysbuild_item_versions', iv2a)).proposer_status], ['pending', 'pending'], '条目提出人状态仍待确认（有异议不改）');
    const reopen = async () => post(U.admin, winUrl(s.pid), await winBody(s.pid, 'reopen', { reason: '补录遗漏的历史确认' }, U.admin));
    const r1 = await reopen();
    expectErr(r1, 409, 'SYSBUILD_STATE', '修订已 objected 但对象仍待确认');
    for (const part of [`内容包版本 #${s.pv}（`, `条目版本 #${s.ivid}（`, `条目版本 #${iv2a}（`]) assert.ok(r1.body.message.includes(part), `应列出 ${part}，实际 ${r1.body.message}`);
    assert.strictEqual(await windowOf(s.pid), 'closed', '被拒不改窗口');
    // 第二个条目出新版本：旧版本 iv2a 不再是最新（它的修订虽仍是 objected、proposer_status 仍是 pending），不再拦重开；新版本的提出人任务待确认，改列新版本
    const nv = await post(U.pm, `/sysbuild/items/${item2.id}/versions`, { content: '补正后的需求', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(nv.status, 201, nv.text);
    const iv2b = nv.body.item_version_id;
    const t2b = await sqlGet(
      `SELECT t.id AS tid, r.id AS rid FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.object_type = 'item_version' AND t.object_version_id = ?`, [iv2b]
    );
    assert.ok(t2b, '新版本应生成提出人任务');
    assert.strictEqual((await rowOf('sysbuild_item_versions', iv2a)).proposer_status, 'pending', '旧版本的提出人状态仍留 pending（所以不能只看 proposer_status）');
    const r2 = await reopen();
    expectErr(r2, 409, 'SYSBUILD_STATE', '改列新版本');
    assert.ok(r2.body.message.includes(`条目版本 #${iv2b}（`), `列出新版本，实际 ${r2.body.message}`);
    assert.ok(!r2.body.message.includes(`条目版本 #${iv2a}（`), `旧版本不再列出，实际 ${r2.body.message}`);
    // 逐个处理：撤回包版本（版本已被替代 superseded、修订 invalid，不再 pending）→ 不再列内容包
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${s.pv}/withdraw`, { reason: '重新提交' })).status, 200);
    const r3 = await reopen();
    expectErr(r3, 409, 'SYSBUILD_STATE', '包已撤回');
    assert.ok(!r3.body.message.includes('内容包版本'), `实际 ${r3.body.message}`);
    // iv1：改发（objected 的修订不会被替代，新修订 rev+1）后由 PM 代录确认 → proxy_confirmed；iv2b 的待确认修订直接代录确认
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${s.itask.tid}/reissue`, { reason: '重新确认' });
    assert.strictEqual(rs.status, 200, rs.text);
    await backdate('sysbuild_confirm_task_revisions', [rs.body.revision.id]);
    assert.strictEqual((await proxyOf(s.itask.tid, rs.body.revision.id, s.ivid, 'confirm')).status, 200);
    const r4 = await reopen();
    expectErr(r4, 409, 'SYSBUILD_STATE', '只剩 iv2b');
    assert.ok(r4.body.message.includes(`条目版本 #${iv2b}（`) && !r4.body.message.includes(`条目版本 #${s.ivid}（`), `实际 ${r4.body.message}`);
    await backdate('sysbuild_confirm_task_revisions', [t2b.rid]);
    assert.strictEqual((await proxyOf(t2b.tid, t2b.rid, iv2b, 'confirm')).status, 200);
    const r5 = await reopen();
    assert.strictEqual(r5.status, 200, r5.text);
    assert.strictEqual(await windowOf(s.pid), 'open');
  });

  // ── 3 历史事实导入：公共 ──────────────────────────────────────────────────────────────────────
  async function mkPendingAppt(pid, party, name) {
    const m = await addNaMember(pid, party, name);
    const r = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: m });
    assert.strictEqual(r.status, 201, r.text);
    return { m, aid: r.body.appointment.id };
  }
  test('C4b 历史 导入 公共：检查顺序（400 形态 → 404 → 403 → 409 项目状态 / 窗口 / golive / 对象 → 400 日期与附件）；golive 409；写入 history_imports + 凭据 + 事件；不产生也不满足任何当前确认任务；被拒不改任何状态', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const ap = await mkPendingAppt(pid, party, '无账号负责人');
    const url = impUrl(pid);
    const good = (extra) => impBody(pid, 'appointment', ap.aid, extra);
    // 窗口未开启：409（先于对象判定）
    expectErr(await post(U.pm, url, await good()), 409, 'SYSBUILD_STATE', '窗口未开启');
    await openWin(pid);
    const snap0 = await stateSnap(pid);
    const shapes = [
      [{ x: 1 }, 'x'], [{ fact_type: undefined }, 'fact_type'], [{ fact_type: 'unknown' }, 'fact_type'], [{ object_id: 'abc' }, 'object_id'], [{ object_id: undefined }, 'object_id'],
      [{ actual_confirmer: undefined }, 'actual_confirmer'], [{ actual_confirmer: '甲'.repeat(101) }, 'actual_confirmer'], [{ identity_basis: '  ' }, 'identity_basis'],
      [{ original_date: undefined }, 'original_date'], [{ original_date: '2026-13-01' }, 'original_date'], [{ original_date: '2026/10/25' }, 'original_date'],
      [{ attachment_ids: undefined }, 'attachment_ids'], [{ attachment_ids: [] }, 'attachment_ids'], [{ attachment_ids: [0] }, 'attachment_ids'],
    ];
    for (const [extra, field] of shapes) {
      const r = await post(U.pm, url, await good(extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `参数 ${field}`);
      assert.strictEqual(r.body.field, field);
    }
    expectErr(await post(U.out, url, await good()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    await addMember(pid, U.m1);
    expectErr(await post(U.m1, url, await good()), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.admin, url, await good()), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM');
    // golive（C6a 起开放，对象 = 批次）：对象编号不存在 / 不属本项目 → 409 与其他类事实同口径（完整的成功 / 前置用例在 sysbuild-api-suite-golive.js）；非 PM 对 golive 仍是 403
    const gl = await post(U.pm, url, await impBody(pid, 'golive', 99999999));
    expectErr(gl, 409, 'SYSBUILD_STATE', 'golive');
    assert.strictEqual(gl.body.message, '对象不存在或不属于本项目');
    expectErr(await post(U.m1, url, await impBody(pid, 'golive', 1)), 403, 'SYSBUILD_FORBIDDEN', '非 PM 对 golive 先 403');
    // 对象不存在 / 属别的项目：409；409 先于 400 日期范围
    const other = await newProject();
    const oParty = await addParty(other, '乙部', 'demand');
    const oAp = await mkPendingAppt(other, oParty, '别项目无账号负责人');
    expectErr(await post(U.pm, url, await good({ object_id: oAp.aid })), 409, 'SYSBUILD_STATE', '别的项目的任职');
    expectErr(await post(U.pm, url, await good({ object_id: 99999999 })), 409, 'SYSBUILD_STATE', '任职不存在');
    expectErr(await post(U.pm, url, await good({ object_id: 99999999, original_date: addDays(today(), 1) })), 409, 'SYSBUILD_STATE', '409 先于日期范围');
    // 400 日期（只要求不晚于今天，没有下限）与附件可用性
    const late = await post(U.pm, url, await good({ original_date: addDays(today(), 1) }));
    expectErr(late, 400, 'SYSBUILD_INVALID_INPUT', '晚于今天');
    assert.strictEqual(late.body.field, 'original_date');
    assert.ok(late.body.message.startsWith('原日期不能晚于今天'), `历史导入的日期名叫「原日期」，实际 ${late.body.message}`);
    const foreign = await stageAtt(other, U.pm, 's');
    expectErr(await post(U.pm, url, await good({ attachment_ids: [foreign] })), 400, 'SYSBUILD_INVALID_INPUT', '别的项目的附件');
    assert.strictEqual(await stateSnap(pid), snap0, '被拒绝的导入不改任何状态');
    // 已终止项目 409
    const p2 = await newProject();
    const pa2 = await addParty(p2, '丙部', 'demand');
    const ap2 = await mkPendingAppt(p2, pa2, '终止项目的无账号负责人');
    await openWin(p2);
    assert.strictEqual((await setStatus(p2, 'terminated')).status, 200);
    expectErr(await post(U.pm, impUrl(p2), await impBody(p2, 'appointment', ap2.aid)), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    // 成功（原日期很早，没有下限）：写 history_imports + 凭据 + 事件；不产生也不满足任何当前确认任务
    const tasks0 = await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [pid]);
    const att = await stageAtt(pid, U.pm, 'i');
    const ok = await post(U.pm, url, await good({ original_date: '2001-01-02', attachment_ids: [att], actual_confirmer: '甲部老张', identity_basis: '2001 年任命文件' }));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual(ok.body.history_import, { id: ok.body.history_import.id, fact_type: 'appointment', object_type: 'appointment', object_id: ap.aid, original_date: '2001-01-02', label: '历史导入' });
    assert.deepStrictEqual(ok.body.attachment_ids, [att]);
    const hi = await rowOf('sysbuild_history_imports', ok.body.history_import.id);
    assert.deepStrictEqual(hi, {
      id: hi.id, project_id: pid, object_type: 'appointment', object_id: ap.aid, fact_type: 'appointment', actual_confirmer: '甲部老张', identity_basis: '2001 年任命文件',
      original_date: '2001-01-02', imported_by: U.pm, imported_at: hi.imported_at,
    });
    assert.deepStrictEqual(await sqlAll('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att]), [{ owner_type: 'history_import', owner_id: hi.id, bound_by: U.pm }]);
    assert.deepStrictEqual(await payloads(pid, 'history_fact_imported'), [{
      history_import_id: hi.id, fact_type: 'appointment', object_type: 'appointment', object_id: ap.aid, original_date: '2001-01-02', actual_confirmer: '甲部老张',
      identity_basis: '2001 年任命文件', attachment_ids: [att],
    }]);
    const ev = (await eventsOf(pid, 'history_fact_imported'))[0];
    assert.deepStrictEqual([ev.object_type, ev.object_id, ev.operator_id], ['appointment', ap.aid, U.pm]);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [pid]), tasks0, '导入不产生任何当前确认任务');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ?', [pid]), 0, '导入不写任何任务修订的确认记录');
    // 原日期 = 今天通过（边界）：再造一条任职导入
    const pa3 = await addParty(pid, '丁部', 'demand');
    const ap3 = await mkPendingAppt(pid, pa3, '丁部无账号负责人');
    assert.strictEqual((await post(U.pm, url, await impBody(pid, 'appointment', ap3.aid, { original_date: today() }))).status, 201, '原日期 = 今天应通过');
    // 读：历史导入列表带凭据与「历史导入」标记
    const lst = await get(U.pm, `/sysbuild/projects/${pid}/history-imports`);
    assert.strictEqual(lst.status, 200, lst.text);
    assert.deepStrictEqual(lst.body.history_imports.map((h) => [h.fact_type, h.label, h.attachment_ids.length]), [['appointment', '历史导入', 1], ['appointment', '历史导入', 1]]);
    // LOW-6：历史导入记录的附件与任务详情确认记录同一种视图（遮蔽的不返回原名，已删除标删除人）
    assert.deepStrictEqual(lst.body.history_imports[0].attachments.map((x) => [x.attachment_id, x.masked, x.name, x.deleted]), [[att, false, '确认证据.txt', false]]);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = 1, mask_reason = '含敏感信息' WHERE id = ?", [att]);
    await sqlRun('UPDATE sysbuild_attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?', ['2026-10-31 10:00:00', U.admin, att]);
    const lm = (await get(U.pm, `/sysbuild/projects/${pid}/history-imports`)).body.history_imports[0];
    assert.deepStrictEqual(lm.attachments.map((x) => [x.masked, x.name, x.deleted, x.deleted_by]), [[true, null, true, U.admin]]);
    assert.ok(!JSON.stringify(lm).includes('确认证据'), '遮蔽后导入记录整体不含原名');
    assert.strictEqual((await get(U.out, `/sysbuild/projects/${pid}/history-imports`)).status, 404);
    // 关闭窗口后拒绝导入（时间窗关闭后不能再导入）
    const pa4 = await addParty(pid, '戊部', 'demand');
    const ap4 = await mkPendingAppt(pid, pa4, '戊部无账号负责人');
    await closeWin(pid);
    expectErr(await post(U.pm, url, await impBody(pid, 'appointment', ap4.aid)), 409, 'SYSBUILD_STATE', '窗口关闭后导入');
    expectErr(await post(U.pm, confUrl(pid), await confBody(pid, 'package_version', 1, 'confirm')), 409, 'SYSBUILD_STATE', '窗口关闭后补录');
  });

  // ── 4 导入：任职 ─────────────────────────────────────────────────────────────────────────────
  test('C4b 历史 导入 任职：待接受任职 → 现任（effective_at = 原日期 00:00:00，不走负责人更换级联）；本方已有现任 / 有待接受的邀请 / 状态不符 / 成员已移出 → 409，不覆盖当前生效状态', async () => {
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const ap = await mkPendingAppt(pid, party, '无账号负责人');
    const r = await post(U.pm, impUrl(pid), await impBody(pid, 'appointment', ap.aid, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.result, { status: 'active', withdrawn_invitation_ids: [] });
    const a = await rowOf('sysbuild_appointments', ap.aid);
    assert.deepStrictEqual([a.status, a.effective_at, a.ended_at], ['active', `${OK_DATE} 00:00:00`, null]);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_invitations WHERE appointment_id = ?', [ap.aid]), 0, '无账号任职导入不建邀请');
    assert.strictEqual((await eventsOf(pid, 'appointment_activated')).length, 1);
    assert.strictEqual((await eventsOf(pid, 'appointment_ended')).length, 0, '没有现任更换级联');
    assert.deepStrictEqual(await payloads(pid, 'appointment_activated'), [{ party_id: party, member_id: ap.m, replaced: [] }]);
    // 已导入的任职不能再导入（状态不符）
    const reAp = await post(U.pm, impUrl(pid), await impBody(pid, 'appointment', ap.aid));
    expectErr(reAp, 409, 'SYSBUILD_STATE', '已是现任');
    assert.ok(reAp.body.message.includes('待接受的任职提议'), `状态不符的提示实际 ${reAp.body.message}`);
    // 本方已有现任：历史任职不覆盖当前生效状态（现任不变、待接受的任职不变）
    const m2 = await addNaMember(pid, party, '第二位无账号成员');
    const pend = await addAppointment(party, m2, 'pending');
    const snap = await stateSnap(pid);
    const c = await post(U.pm, impUrl(pid), await impBody(pid, 'appointment', pend));
    expectErr(c, 409, 'SYSBUILD_STATE', '本方已有现任');
    assert.ok(c.body.message.includes('现任'), `提示实际 ${c.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap, '被拒不改任何状态');
    assert.strictEqual((await rowOf('sysbuild_appointments', ap.aid)).status, 'active');
    // P65：有账号成员的待接受任职带一条待接受的邀请——导入成功，同一事务里邀请置为 withdrawn（原因「历史导入」，写事件留痕），之后 /my/invitations 不再列出
    const p2 = await newProject();
    const party2 = await addParty(p2, '乙部', 'demand');
    const mj = await post(U.pm, `/sysbuild/projects/${p2}/members`, { party_id: party2, user_id: U.m1 });
    assert.strictEqual(mj.status, 201, mj.text);
    assert.strictEqual((await post(U.m1, `/sysbuild/my/invitations/${mj.body.invitation.id}/accept`, {})).status, 200);
    const pr = await post(U.pm, `/sysbuild/parties/${party2}/appointments`, { member_id: mj.body.member.id });
    assert.strictEqual(pr.status, 201, pr.text);
    assert.ok(pr.body.invitation, '有账号成员的任职提议带待接受邀请');
    const invId = pr.body.invitation.id;
    assert.deepStrictEqual((await get(U.m1, '/sysbuild/my/invitations')).body.invitations.map((i) => i.id), [invId], '导入前邀请在我的邀请里');
    await openWin(p2);
    const inv = await post(U.pm, impUrl(p2), await impBody(p2, 'appointment', pr.body.appointment.id, { original_date: OK_DATE }));
    assert.strictEqual(inv.status, 201, inv.text);
    assert.deepStrictEqual(inv.body.result, { status: 'active', withdrawn_invitation_ids: [invId] });
    const ia = await rowOf('sysbuild_appointments', pr.body.appointment.id);
    assert.deepStrictEqual([ia.status, ia.effective_at], ['active', `${OK_DATE} 00:00:00`]);
    const ir = await rowOf('sysbuild_invitations', invId);
    assert.strictEqual(ir.status, 'withdrawn');
    assert.notStrictEqual(ir.responded_at, null, '撤回的邀请带响应时间（库内 CHECK）');
    assert.deepStrictEqual((await get(U.m1, '/sysbuild/my/invitations')).body.invitations, [], '撤回后不再列出');
    expectErr(await get(U.m1, `/sysbuild/my/invitations/${invId}`), 404, 'SYSBUILD_NOT_FOUND', '撤回的邀请不可再看');
    expectErr(await post(U.m1, `/sysbuild/my/invitations/${invId}/accept`, {}), 409, 'SYSBUILD_STATE', '撤回的邀请不可再接受');
    assert.deepStrictEqual(await payloads(p2, 'invitation_withdrawn'), [{ kind: 'appointment', member_id: mj.body.member.id, appointment_id: pr.body.appointment.id, reason: '历史导入', via: 'history_import' }]);
    // 状态不符：任职已撤回（PM 撤回任职即撤回邀请）→ 导入 409
    const party2b = await addParty(p2, '乙二部', 'demand');
    const mj2 = await post(U.pm, `/sysbuild/projects/${p2}/members`, { party_id: party2b, user_id: U.m2 });
    assert.strictEqual((await post(U.m2, `/sysbuild/my/invitations/${mj2.body.invitation.id}/accept`, {})).status, 200);
    const pr2 = await post(U.pm, `/sysbuild/parties/${party2b}/appointments`, { member_id: mj2.body.member.id });
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${pr2.body.appointment.id}/withdraw`, {})).status, 200);
    expectErr(await post(U.pm, impUrl(p2), await impBody(p2, 'appointment', pr2.body.appointment.id)), 409, 'SYSBUILD_STATE', '任职已撤回（状态不符）');
    // P68 ③：本方已有结束日期晚于原日期的任职 → 不能导入比已结束任期更早的现任（原日期 = 结束日当天可以）
    const p4 = await newProject();
    const party4 = await addParty(p4, '丁部', 'demand');
    const old4 = await mkPendingAppt(p4, party4, '前任无账号负责人');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', effective_at = '2026-09-01 00:00:00', ended_at = '2026-10-28 10:00:00', end_reason = '离任' WHERE id = ?", [old4.aid]);
    const new4 = await mkPendingAppt(p4, party4, '继任无账号负责人');
    await openWin(p4);
    const snap4 = await stateSnap(p4);
    const c4 = await post(U.pm, impUrl(p4), await impBody(p4, 'appointment', new4.aid, { original_date: '2026-10-25' }));
    expectErr(c4, 409, 'SYSBUILD_STATE', '早于已结束任期');
    assert.ok(c4.body.message.includes('2026-10-28') && c4.body.message.includes('2026-10-25'), `文案写明冲突日期，实际 ${c4.body.message}`);
    assert.strictEqual(await stateSnap(p4), snap4);
    assert.strictEqual((await post(U.pm, impUrl(p4), await impBody(p4, 'appointment', new4.aid, { original_date: '2026-10-28' }))).status, 201, '原日期 = 结束日当天可以');
    // P70：原日期与前任结束日同一天 → 生效时刻取前任的 ended_at（不写 00:00:00，防同日任期重叠 / 倒挂）；比较仍按日
    const new4Row = await rowOf('sysbuild_appointments', new4.aid);
    assert.deepStrictEqual([new4Row.status, new4Row.effective_at], ['active', '2026-10-28 10:00:00'], '同日取前任 ended_at');
    assert.ok(new4Row.effective_at >= (await rowOf('sysbuild_appointments', old4.aid)).ended_at, '继任生效时刻不早于前任结束时刻');
    // 原日期晚于前任结束日 → 仍写原日期 00:00:00
    const p4b = await newProject();
    const party4b = await addParty(p4b, '丁二部', 'demand');
    const old4b = await mkPendingAppt(p4b, party4b, '前任无账号负责人');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', effective_at = '2026-09-01 00:00:00', ended_at = '2026-10-28 10:00:00', end_reason = '离任' WHERE id = ?", [old4b.aid]);
    const new4b = await mkPendingAppt(p4b, party4b, '继任无账号负责人');
    await openWin(p4b);
    assert.strictEqual((await post(U.pm, impUrl(p4b), await impBody(p4b, 'appointment', new4b.aid, { original_date: '2026-10-29' }))).status, 201);
    assert.strictEqual((await rowOf('sysbuild_appointments', new4b.aid)).effective_at, '2026-10-29 00:00:00', '不同日仍写 00:00:00');
    // 成员已移出 / 尚未加入：409
    const p3 = await newProject();
    const party3 = await addParty(p3, '丙部', 'demand');
    const ap3 = await mkPendingAppt(p3, party3, '将被移出的无账号成员');
    await sqlRun("UPDATE sysbuild_members SET removed_at = '2026-10-22 10:00:00', removed_reason = '离项' WHERE id = ?", [ap3.m]);
    await openWin(p3);
    expectErr(await post(U.pm, impUrl(p3), await impBody(p3, 'appointment', ap3.aid)), 409, 'SYSBUILD_STATE', '成员已移出');
    await sqlRun('UPDATE sysbuild_members SET removed_at = NULL, removed_reason = NULL, joined_at = NULL WHERE id = ?', [ap3.m]);
    expectErr(await post(U.pm, impUrl(p3), await impBody(p3, 'appointment', ap3.aid)), 409, 'SYSBUILD_STATE', '成员尚未加入');
    assert.strictEqual((await rowOf('sysbuild_appointments', ap3.aid)).status, 'pending');
  });

  // ── 5 导入：授权 ─────────────────────────────────────────────────────────────────────────────
  test('C4b 历史 导入 授权：待负责人确认 / 待本人接受 → 生效（effective_at = 原日期 00:00:00）；本方已有生效代表人 / 依据任职不是现任 / 有待确认的任务修订 / 状态不符 / 成员已移出 → 409', async () => {
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const mOwn = await addNaMember(pid, party, '无账号负责人');
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addNaMember(pid, party, '无账号代表人');
    const mDel2 = await addNaMember(pid, party, '第二位代表人');
    // pending_owner → active：历史上批准与接受都发生过，先推进到待接受（via history_import）再生效
    const dOwner = await addDelegation(party, mDel, apt, 'pending_owner');
    const r = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dOwner, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    const d = await rowOf('sysbuild_delegations', dOwner);
    assert.deepStrictEqual([d.status, d.effective_at], ['active', `${OK_DATE} 00:00:00`]);
    assert.deepStrictEqual(await payloads(pid, 'delegation_approved'), [{ party_id: party, member_id: mDel, via: 'history_import' }]);
    // LOW-3：批准日共用助手——历史导入推进的批准事件（via = history_import）带 skipHistoryImport 时被跳过（返回 null），不带时取它的事件时间。
    //   端点上这条分支不可达（带这种事件的授权已是 active，导入不会再核对它），只能直接调助手；history.js 传不传这个选项同样不可达，不单配变异（等价变异）
    const coreDir = T.getModuleDir() || path.join(__dirname, '../../routes/sysbuild');
    const coreForApproval = require(path.join(coreDir, 'confirm-core.js'));
    const qShim = { all: sqlAll, get: sqlGet, run: sqlRun };
    assert.strictEqual(await coreForApproval.delegationApprovedOn(qShim, dOwner, { skipHistoryImport: true }), null);
    assert.strictEqual(typeof (await coreForApproval.delegationApprovedOn(qShim, dOwner)), 'string');
    assert.strictEqual(typeof (await coreForApproval.delegationApprovedOn(qShim, dOwner, {})), 'string');
    assert.strictEqual((await eventsOf(pid, 'delegation_activated')).length, 1);
    assert.strictEqual((await eventsOf(pid, 'delegation_revoked')).length, 0, '没有代表人更换级联');
    // 本方已有生效代表人：409，不覆盖
    const dAcc = await addDelegation(party, mDel2, apt, 'pending_accept');
    const c = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dAcc));
    expectErr(c, 409, 'SYSBUILD_STATE', '本方已有生效代表人');
    assert.ok(c.body.message.includes('代表人'), `提示实际 ${c.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_delegations', dAcc)).status, 'pending_accept');
    const reDl = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dOwner));
    expectErr(reDl, 409, 'SYSBUILD_STATE', '已生效（状态不符）');
    assert.ok(reDl.body.message.includes('待处理的授权提议'), `状态不符的提示实际 ${reDl.body.message}`);
    // pending_accept → active（另一方）
    const party2 = await addParty(pid, '乙部', 'demand');
    const mO2 = await addNaMember(pid, party2, '乙部负责人');
    const apt2 = await addAppointment(party2, mO2, 'active');
    const mD2 = await addNaMember(pid, party2, '乙部代表人');
    const dd2 = await addDelegation(party2, mD2, apt2, 'pending_accept');
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dd2))).status, 201);
    assert.strictEqual((await rowOf('sysbuild_delegations', dd2)).status, 'active');
    assert.strictEqual((await eventsOf(pid, 'delegation_approved')).length, 1, 'pending_accept 的导入不写批准事件');
    // 依据任职不是现任 / 成员已移出 / 有待确认的任务修订
    const party3 = await addParty(pid, '丙部', 'demand');
    const mO3 = await addNaMember(pid, party3, '丙部负责人');
    const apt3 = await addAppointment(party3, mO3, 'active');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '离任' WHERE id = ?", [apt3]);
    const mD3 = await addNaMember(pid, party3, '丙部代表人');
    const dd3 = await addDelegation(party3, mD3, apt3, 'pending_accept');
    expectErr(await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dd3)), 409, 'SYSBUILD_STATE', '依据任职不是现任');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'active', effective_at = '2026-10-02 10:00:00', ended_at = NULL WHERE id = ?", [apt3]);
    await sqlRun("UPDATE sysbuild_members SET removed_at = '2026-10-22 10:00:00', removed_reason = '离项' WHERE id = ?", [mD3]);
    expectErr(await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dd3)), 409, 'SYSBUILD_STATE', '被授权人已移出');
    await sqlRun('UPDATE sysbuild_members SET removed_at = NULL, removed_reason = NULL WHERE id = ?', [mD3]);
    const tk = await sqlRun("INSERT INTO sysbuild_confirm_tasks (project_id, object_type, object_id, object_version_id, purpose, party_id, created_by) VALUES (?, 'delegation', ?, ?, 'delegation_accept', ?, ?)", [pid, dd3, dd3, party3, U.pm]);
    await sqlRun("INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, status, created_by) VALUES (?, 1, ?, 'pending', ?)", [tk.lastID, mD3, U.pm]);
    const pend = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dd3));
    expectErr(pend, 409, 'SYSBUILD_STATE', '有待确认的任务修订');
    assert.ok(pend.body.message.includes('任务修订'), `提示实际 ${pend.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_delegations', dd3)).status, 'pending_accept');
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'invalid', status_reason = '作废' WHERE task_id = ?", [tk.lastID]);
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dd3))).status, 201, '待确认修订失效后可导入');
  });

  // ── 6 导入：内容包生效 ───────────────────────────────────────────────────────────────────────
  test('C4b 历史 导入 内容包：总体规划包导入 → 版本 effective（effective_at = 原日期 00:00:00）、基线形成、合并形态推进批次、冻结附件；与普通路径（提交 + 全部确认）的可观察结果逐项一致（同一断言函数比对）；不要求确认人齐全', async () => {
    const s = await mkImportScene();
    const batch = await defaultBatchId(s.pid);
    const snap0 = await stateSnap(s.pid);
    const r = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', s.pv, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.result.status, r.body.result.superseded_version_ids, r.body.result.baseline_node_ids.length, r.body.result.advanced_batch_ids], ['effective', [], 6, [batch]]);
    const v = await rowOf('sysbuild_package_versions', s.pv);
    assert.deepStrictEqual([v.status, v.effective_at, v.form], ['effective', `${OK_DATE} 00:00:00`, 'overall_batch_req']);
    assert.strictEqual((await eventsOf(s.pid, 'package_version_effective')).filter((e) => e.object_id === s.pv).length, 1, '本版本生效事件一条（项目里另有立项包的导入生效事件）');
    assert.strictEqual((await eventsOf(s.pid, 'baseline_formed')).length, 6);
    assert.strictEqual((await eventsOf(s.pid, 'batch_status_changed')).length, 1);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE project_id = ?', [s.pid]), 0, '导入不生成任何确认任务（不要求确认人，项目里一个成员 / 任职都没有）');
    assert.notStrictEqual(await stateSnap(s.pid), snap0);
    const hi = await get(U.pm, `/sysbuild/package-versions/${s.pv}`);
    assert.deepStrictEqual(hi.body.history_imports.map((h) => [h.fact_type, h.label, h.original_date]), [['package_effective', '历史导入', OK_DATE]], '版本详情凭 history_imports 识别历史导入');
    // 普通路径：同样的项目形态走提交 + 全部确认
    const pid2 = await newProject();
    await seedParty(pid2, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid2);
    const att2 = await stageAtt(pid2, U.pm, 'a');
    const item2 = await mkItem(pid2, { attachment_ids: [att2], no_written_evidence: undefined, no_evidence_reason: undefined });
    const pk2 = await mkPackage(pid2, 'overall');
    const pv2 = await mkVersion(pk2);
    const matAtt2 = await stageAtt(pid2, U.pm, 'm');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [matAtt2, pv2, U.pm]);
    await addToSet(pv2, item2.versions[0].id, await defaultBatchId(pid2));
    await planAllNodes(pid2);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`)).status, 200);
    await confirmAll(pv2);
    const imported = await effectSnap(s.pid, s.pv);
    const ordinary = await effectSnap(pid2, pv2);
    assert.deepStrictEqual(imported, ordinary, '导入与普通生效的可观察结果一致（含节点计划快照）');
    assert.deepStrictEqual([imported.status, imported.form, imported.baselines.length, imported.batches, imported.frozen], ['effective', 'overall_batch_req', 6, ['active'], 2], '冻结 = 条目版本附件 + 包材料附件');
    assert.ok(imported.baselines.every((b) => b[3] === true), '基线引用本版本');
    assert.strictEqual(imported.plansSnap.length, 6, '节点计划快照 6 个节点');
    // LOW-4：包材料附件随包冻结（item 附件 + 材料附件）
    assert.deepStrictEqual((await sqlAll("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY attachment_id", [s.pv])).map((x) => x.attachment_id), [s.att, s.matAtt].sort((a, b) => a - b), '导入冻结条目附件与包材料附件');
    // MED-2：导入事件带节点计划快照与（若有变化）形态回写项；读接口 history_imports[].node_plans 取自它（没有提交事件时 submittedNodePlans 的后备来源）
    const impEv = (await payloads(s.pid, 'history_fact_imported')).find((p) => p.fact_type === 'package_effective' && p.object_id === s.pv);
    assert.ok(Array.isArray(impEv.node_plans) && impEv.node_plans.length === 6, '导入事件带 node_plans');
    assert.deepStrictEqual(hi.body.history_imports[0].node_plans, impEv.node_plans, '版本详情的导入记录带同一份节点计划快照');
    assert.deepStrictEqual(impEv.node_plans[0], Object.assign({}, impEv.node_plans[0], { planned_start: '2026-11-02', planned_end: '2026-11-30' }));
    // LOW-3：形态回写项与提交事件同名（form_from / form_to，只在变化时）：草稿建在项目只有 1 个有效批次时 form 已是合并形态，所以这里没有变化项
    assert.ok(!('form_from' in impEv) && !('form_to' in impEv));
    // 重复导入 / 非草稿 / 别的项目的版本：409
    const again = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', s.pv));
    expectErr(again, 409, 'SYSBUILD_STATE', '已生效不能再导入');
    assert.ok(again.body.message.includes('导入历史生效'), `提示实际（导入自己的草稿检查，不是提交规则的文案）${again.body.message}`);
    expectErr(await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', pv2)), 409, 'SYSBUILD_STATE', '别的项目的版本');
    // 提交前置（P56，同 C4a）：计划不齐 / 立项包未生效 / 条目集合为空 → 409；被拒的导入不改任何状态
    const np = await mkImportScene({ noPlans: true });
    const sNp = await stateSnap(np.pid);
    const rNp = await post(U.pm, impUrl(np.pid), await impBody(np.pid, 'package_effective', np.pv));
    expectErr(rNp, 409, 'SYSBUILD_STATE', '计划不齐');
    assert.ok(rNp.body.message.includes('计划起止日期'), `提示实际 ${rNp.body.message}`);
    const ni = await mkImportScene({ noInitiation: true });
    const rNi = await post(U.pm, impUrl(ni.pid), await impBody(ni.pid, 'package_effective', ni.pv));
    expectErr(rNi, 409, 'SYSBUILD_STATE', '立项包未生效');
    assert.ok(rNi.body.message.includes('立项包'), `提示实际 ${rNi.body.message}`);
    const ne = await mkImportScene({ emptySet: true });
    const rNe = await post(U.pm, impUrl(ne.pid), await impBody(ne.pid, 'package_effective', ne.pv));
    expectErr(rNe, 409, 'SYSBUILD_STATE', '条目集合为空');
    assert.ok(rNe.body.message.includes('集合为空'), `提示实际 ${rNe.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_package_versions', np.pv)).status, 'draft');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_frozen_attachments WHERE object_type = ? AND object_version_id = ?', ['package_version', ne.pv]), 0, '被拒的导入不冻结附件');
    assert.ok(sNp.length > 0);
    // 集合重核：条目的承诺批次被去掉（直接写库构造）→ 409 列出条目编号
    const nb = await mkImportScene();
    await sqlRun('UPDATE sysbuild_package_item_revisions SET committed_batch_id = NULL WHERE package_version_id = ?', [nb.pv]);
    const rNb = await post(U.pm, impUrl(nb.pid), await impBody(nb.pid, 'package_effective', nb.pv));
    expectErr(rNb, 409, 'SYSBUILD_STATE', '条目没有承诺批次');
    assert.ok(rNb.body.message.includes('没有承诺批次'), `提示实际 ${rNb.body.message}`);
  });

  test('C4b 历史 导入 内容包（立项包与冲突）：立项包导入生效不形成基线；同一内容包已有 effective / pending 版本 → 409；类型限 overall / initiation（P55）', async () => {
    const pid = await newProject();
    const pk = await mkPackage(pid, 'initiation');
    const pv1 = await mkVersion(pk);
    await openWin(pid);
    const r = await post(U.pm, impUrl(pid), await impBody(pid, 'package_effective', pv1, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.result, { status: 'effective', superseded_version_ids: [], baseline_node_ids: [], advanced_batch_ids: [] });
    const v1 = await rowOf('sysbuild_package_versions', pv1);
    assert.deepStrictEqual([v1.status, v1.effective_at], ['effective', `${OK_DATE} 00:00:00`]);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline'", [pid]), 0, '立项包不形成基线');
    // 同包已有生效版本：新草稿不能再导入（不覆盖）
    const pv2 = await mkVersion(pk);
    const c = await post(U.pm, impUrl(pid), await impBody(pid, 'package_effective', pv2));
    expectErr(c, 409, 'SYSBUILD_STATE', '同包已有生效版本');
    assert.ok(c.body.message.includes('已有生效或待确认'), `提示实际 ${c.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_package_versions', pv1)).status, 'effective');
    assert.strictEqual((await rowOf('sysbuild_package_versions', pv2)).status, 'draft');
    // 同包有待确认版本（夹具：把第一个版本置为待确认并补一个草稿）
    const p2 = await newProject();
    const pk2 = await mkPackage(p2, 'initiation');
    const a1 = await mkVersion(pk2);
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [a1]);
    const a2 = (await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, snapshot_json, created_by) VALUES (?, 2, NULL, 'draft', '{}', ?)", [pk2, U.pm])).lastID;
    await openWin(p2);
    expectErr(await post(U.pm, impUrl(p2), await impBody(p2, 'package_effective', a2)), 409, 'SYSBUILD_STATE', '同包有待确认版本');
    // 类型限 overall / initiation（P55）：结项包版本 409
    const p3 = await newProject();
    const pk3 = await mkPackage(p3, 'closing');
    const cv = await mkVersion(pk3);
    await openWin(p3);
    const rt = await post(U.pm, impUrl(p3), await impBody(p3, 'package_effective', cv));
    expectErr(rt, 409, 'SYSBUILD_STATE', '结项包');
    assert.ok(rt.body.message.includes('不支持历史生效导入'), `提示实际 ${rt.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_package_versions', cv)).status, 'draft');
  });

  // ── 7 导入：节点收口 ─────────────────────────────────────────────────────────────────────────
  test('C4b 历史 导入 节点：未开始 / 进行中的节点 → closed（closed_at = 原日期 00:00:00；未开始的 opened_at 一并写原日期）；收口阻塞项（P57）/ 里程碑 / 整体验收结项 / 已收口 / 已取消 / 原日期早于实际开始 / 别的项目 → 409', async () => {
    const pid = await newProject();
    const seeded = await seedEffectiveInitiation(pid);
    // 夹具写的立项包生效时刻是真实时钟；P68 ⑥ 起节点收口原日期不得早于立项包生效日，这里先把生效时刻写库为固定值（不依赖真实时钟）
    await sqlRun("UPDATE sysbuild_package_versions SET effective_at = ? WHERE id = ?", [FLOOR_AT, seeded.pv]);
    await openWin(pid);
    const nodeId = async (key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
    const recKinds = async (nid) => (await sqlAll('SELECT kind, actual_date FROM sysbuild_node_schedule_records WHERE node_id = ? ORDER BY id', [nid])).map((x) => [x.kind, x.actual_date]);
    // 未开始 → closed（立项与授权：立项包已生效，无阻塞）
    const nIni = await nodeId('p_initiation');
    const r = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nIni, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.result, { status: 'closed', from: 'not_started' });
    const n = await rowOf('sysbuild_nodes', nIni);
    assert.deepStrictEqual([n.status, n.opened_at, n.closed_at], ['closed', `${OK_DATE} 00:00:00`, `${OK_DATE} 00:00:00`]);
    assert.deepStrictEqual(await recKinds(nIni), [['actual_start', OK_DATE], ['actual_end', OK_DATE]]);
    const planView = await get(U.pm, `/sysbuild/projects/${pid}/plan`);
    const pn = planView.body.nodes.find((x) => x.id === nIni);
    assert.deepStrictEqual([pn.status, pn.actual_start, pn.actual_end], ['closed', OK_DATE, OK_DATE], '计划视图按实际开始 / 结束记录派生');
    // 已收口 / 已取消 / 里程碑 / 整体验收结项 / 收口阻塞
    const rClosed = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nIni));
    expectErr(rClosed, 409, 'SYSBUILD_STATE', '已收口');
    assert.ok(rClosed.body.message.includes('已收口或已取消'), `提示实际 ${rClosed.body.message}`);
    const nDev = await nodeId('b_dev');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'cancelled' WHERE id = ?", [nDev]);
    const rCancel = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev));
    expectErr(rCancel, 409, 'SYSBUILD_STATE', '已取消');
    assert.ok(rCancel.body.message.includes('已收口或已取消'), `提示实际 ${rCancel.body.message}`);
    assert.deepStrictEqual(await sqlAll("SELECT object_type, fact_type FROM sysbuild_history_imports WHERE project_id = ? AND object_id = ?", [pid, nIni]), [{ object_type: 'node', fact_type: 'node_closed' }], '节点导入记录 object_type = node');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'not_started' WHERE id = ?", [nDev]);
    const ms = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', await nodeId('b_golive')));
    expectErr(ms, 409, 'SYSBUILD_STATE', '上线里程碑');
    assert.ok(ms.body.message.includes('上线'), `提示实际 ${ms.body.message}`);
    const cl = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', await nodeId('p_closing')));
    expectErr(cl, 409, 'SYSBUILD_STATE', '整体验收结项');
    assert.ok(cl.body.message.includes('整体验收结项'), `提示实际 ${cl.body.message}`);
    const snapBlock = await stateSnap(pid);
    const bl = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', await nodeId('p_overall')));
    expectErr(bl, 409, 'SYSBUILD_STATE', '收口阻塞（总体规划包未生效 / 计划缺失）');
    assert.ok(bl.body.message.includes('收口前置条件未满足'), `提示实际 ${bl.body.message}`);
    assert.ok(bl.body.message.includes('总体规划包'), `提示实际 ${bl.body.message}`);
    assert.strictEqual(await stateSnap(pid), snapBlock, '被拒的导入不改任何状态');
    // 别的项目的节点
    const other = await newProject();
    const oNode = (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [other, 'b_dev'])).id;
    expectErr(await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', oNode)), 409, 'SYSBUILD_STATE', '别的项目的节点');
    // 进行中：实际开始 = 今天（真实开始），原日期更早 → 409（历史收口不能早于实际开始）；回拨实际开始后可导入，opened_at 不改写
    const st = await post(U.pm, `/sysbuild/nodes/${nDev}/start`, {});
    assert.strictEqual(st.status, 200, st.text);
    // P68 ①：节点在平台上于 opened_at（今天）开始，不能导入更早的收口——文案写明开始日
    const platformStart = (await rowOf('sysbuild_nodes', nDev)).opened_at.slice(0, 10);
    const early = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev, { original_date: OK_DATE }));
    expectErr(early, 409, 'SYSBUILD_STATE', '原日期早于平台开始日');
    assert.ok(early.body.message.includes(`节点在平台上于 ${platformStart} 开始`) && early.body.message.includes(OK_DATE), `提示实际 ${early.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_nodes', nDev)).status, 'in_progress');
    // 平台开始日回拨到 10-21（节点早在 10-21 就开始了）后，原日期仍早于实际开始记录（今天）→ 仍 409（实际开始 / 更正后的实际开始）
    await sqlRun("UPDATE sysbuild_nodes SET opened_at = '2026-10-21 10:00:00' WHERE id = ?", [nDev]);
    const openedAt = '2026-10-21 10:00:00';
    const early2 = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev, { original_date: OK_DATE }));
    expectErr(early2, 409, 'SYSBUILD_STATE', '原日期早于实际开始');
    assert.ok(early2.body.message.includes('实际开始'), `提示实际 ${early2.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_nodes', nDev)).status, 'in_progress');
    // 原日期 = 平台开始日当天可以（边界）：对另一个未开始节点不适用，这里用 opened_at 当天验证 ① 不误拦：先把原日期设为 10-21 当天并回拨实际开始
    await sqlRun("UPDATE sysbuild_node_schedule_records SET actual_date = '2026-10-21' WHERE node_id = ? AND kind = 'actual_start'", [nDev]);
    const sameDay = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev, { original_date: '2026-10-20' }));
    expectErr(sameDay, 409, 'SYSBUILD_STATE', '早于平台开始日一天');
    assert.strictEqual((await rowOf('sysbuild_nodes', nDev)).status, 'in_progress');
    // 原日期 = 平台开始日 = 实际开始日（边界：不早于即可）
    const ok = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev, { original_date: '2026-10-21' }));
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual(ok.body.result, { status: 'closed', from: 'in_progress' });
    const nd = await rowOf('sysbuild_nodes', nDev);
    // P70：原日期与平台开始日同一天 → closed_at 取 opened_at（原为 2026-10-21 00:00:00，会早于 opened_at 10:00:00 造成倒挂）
    assert.deepStrictEqual([nd.status, nd.opened_at, nd.closed_at], ['closed', openedAt, openedAt], '进行中节点的 opened_at 不改写，同日 closed_at 取 opened_at');
    assert.ok(nd.closed_at >= nd.opened_at, 'closed_at 不早于 opened_at');
    assert.deepStrictEqual(await recKinds(nDev), [['actual_start', '2026-10-21'], ['actual_end', '2026-10-21']]);
    assert.deepStrictEqual((await payloads(pid, 'history_fact_imported')).map((p) => [p.fact_type, p.object_id]), [['node_closed', nIni], ['node_closed', nDev]]);
  });

  // ── 7a 导入：节点收口依赖内容包的日期（P68 ⑥ / H4）与收口时刻不倒挂（P70 / H5）────────────────────────────
  const nodeIdOf = async (pid, key) => (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [pid, key])).id;
  test('C4b 历史 导入 节点 依赖包（P68 ⑥ / H4）：收口前置要求某内容包已生效的节点（立项与授权 / 总体范围与批次规划 / 需求确认 / 用户验收测试），收口原日期不得早于该包的生效日——409 且文案列出包版本与日期，生效日当天可以；包类型表与 closeBlockers 一一对应', async () => {
    // ① 立项与授权：立项包生效日写库固定为 2026-10-22
    const pid = await newProject();
    const seeded = await seedEffectiveInitiation(pid);
    await sqlRun('UPDATE sysbuild_package_versions SET effective_at = ? WHERE id = ?', ['2026-10-22 00:00:00', seeded.pv]);
    await openWin(pid);
    const nIni = await nodeIdOf(pid, 'p_initiation');
    const snap = await stateSnap(pid);
    const e1 = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nIni, { original_date: '2026-10-21' }));
    expectErr(e1, 409, 'SYSBUILD_STATE', '早于立项包生效日');
    for (const part of ['项目立项包', `版本 #${seeded.pv}`, '2026-10-22', '2026-10-21']) assert.ok(e1.body.message.includes(part), `文案应含 ${part}，实际 ${e1.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap, '被拒不改任何状态');
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nIni, { original_date: '2026-10-22' }))).status, 201, '原日期 = 立项包生效日当天可以');
    // ② 总体规划包（导入生效于 OK_DATE）：总体范围与批次规划 / 需求确认两个节点
    const s = await mkImportScene();
    const ov = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', s.pv, { original_date: OK_DATE }));
    assert.strictEqual(ov.status, 201, ov.text);
    const dayBefore = addDays(OK_DATE, -1);
    for (const key of ['p_overall', 'b_req']) {
      const nid = await nodeIdOf(s.pid, key);
      const sn = await stateSnap(s.pid);
      const e = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'node_closed', nid, { original_date: dayBefore }));
      expectErr(e, 409, 'SYSBUILD_STATE', `${key} 早于总体规划包生效日`);
      for (const part of ['总体规划包', `版本 #${s.pv}`, OK_DATE, dayBefore]) assert.ok(e.body.message.includes(part), `${key} 文案应含 ${part}，实际 ${e.body.message}`);
      assert.strictEqual(await stateSnap(s.pid), sn, `${key} 被拒不改任何状态`);
      assert.strictEqual((await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'node_closed', nid, { original_date: OK_DATE }))).status, 201, `${key} 原日期 = 总体规划包生效日当天可以`);
    }
    // ③ 外包项目的用户验收测试：本批批次验收包（C6 才开放提交，这里直接写库构造一个已生效版本，生效日固定）
    const po = await newProject('outsource');
    await openWin(po);
    const batchId = await defaultBatchId(po);
    const bpk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, 'batch_accept', ?)", [po, batchId, U.pm])).lastID;
    const bpv = (await sqlRun(
      "INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, 'effective', '2026-10-25 00:00:00', '{}', ?)", [bpk, U.pm]
    )).lastID;
    // 别的批次的批次验收包（更大的版本编号、更早的生效日 2026-10-23）：核对必须按本节点所在批次限定，不取别批的包（K4 起取最早生效日，所以别批的包要更早才能暴露不限批次）
    const b2 = (await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 2, '第 2 批', 0, 'planning')", [po])).lastID;
    const bpk2 = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, 'batch_accept', ?)", [po, b2, U.pm])).lastID;
    await sqlRun("INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, 1, NULL, 'effective', '2026-10-23 00:00:00', '{}', ?)", [bpk2, U.pm]);
    const nUat = await nodeIdOf(po, 'b_uat');
    const e3 = await post(U.pm, impUrl(po), await impBody(po, 'node_closed', nUat, { original_date: dayBefore }));
    expectErr(e3, 409, 'SYSBUILD_STATE', '早于批次验收包生效日');
    for (const part of ['批次验收包', `版本 #${bpv}`, OK_DATE, dayBefore]) assert.ok(e3.body.message.includes(part), `文案应含 ${part}，实际 ${e3.body.message}`);
    assert.strictEqual((await post(U.pm, impUrl(po), await impBody(po, 'node_closed', nUat, { original_date: OK_DATE }))).status, 201, '原日期 = 批次验收包生效日当天可以');
    // ④ 不依赖内容包的节点（开发完成）不受这条限制
    const nDev = await nodeIdOf(po, 'b_dev');
    assert.strictEqual((await post(U.pm, impUrl(po), await impBody(po, 'node_closed', nDev, { original_date: '2026-10-01' }))).status, 201, '不依赖内容包的节点任意早的历史日期都可以');
    // ⑤ 对拍（K1）：包类型表（plan.js closePackageRequirement）与收口前置（closeBlockers）逐模板键对应——
    //   a) 有 PACKAGE_NOT_EFFECTIVE 阻塞的键 = 表里非空的键；
    //   b) 表里非空的键：只让表里写的那个包（need.type）生效 → 不报 PACKAGE_NOT_EFFECTIVE；去掉它 → 报；只让别的包生效 → 仍报。「依赖哪个包」从这组断言推出来，不手写期望
    const dir = T.getModuleDir() || path.join(__dirname, '../../routes/sysbuild');
    const planMod = require(path.join(dir, 'plan.js'));
    const tpl = require(path.join(dir, 'templates.js'));
    const keys = new Set([...tpl.PROJECT_NODES.map((x) => x.key), ...Object.values(tpl.BATCH_NODES).flatMap((arr) => arr.map((x) => x.key))]);
    assert.ok(keys.has('b_uat') && keys.has('p_initiation') && keys.has('b_req') && keys.has('p_overall'), '模板键集合应含四个依赖包的节点');
    for (const key of keys) {
      const node = { id: 1, batch_id: key.startsWith('b_') ? 7 : null, template_key: key, status: 'not_started', current_plan: { start: '2026-10-01', end: '2026-10-02' } };
      const blocked = planMod.closeBlockers(node, [node], {}).some((b) => b.code === 'PACKAGE_NOT_EFFECTIVE');
      const need = planMod.closePackageRequirement(node);
      assert.strictEqual(need !== null, blocked, `模板键 ${key}：closePackageRequirement 与 closeBlockers 的包前置必须一致`);
      if (need === null) continue;
      // 三种事实各自「只有这一项生效」的构造（批次验收包按节点所在批次 7 记）
      // C5 S-S1b：facts 须带登记事实（entryUnresolved），缺失时 closeBlockers 报 ENTRY_FACTS_MISSING（fail-closed）；这里的手写 facts 补上空清单，本对拍只看包前置
      //   C6a：整体验收结项依赖结项包（facts.closing 是 entries-core.closingFactsOf 的结果：结项包生效时刻 + 批次上线情况；批次都已上线、没有转出 / 上线事件更新时只剩包生效这一项前置）
      const only = {
        initiation: { initiation: true, entryUnresolved: [] }, overall: { overall: true, entryUnresolved: [] }, batch_accept: { batchAccept: { 7: true }, entryUnresolved: [] },
        closing: { closing: { closingEffectiveAt: '2026-10-25 00:00:00', notLive: [], transferNoChange: [], goliveNewer: [] }, entryUnresolved: [] },
      };
      assert.ok(Object.prototype.hasOwnProperty.call(only, need.type), `模板键 ${key} 的包类型 ${need.type} 应是 initiation / overall / batch_accept 之一`);
      const pkgBlock = (facts) => planMod.closeBlockers(node, [node], facts).some((b) => b.code === 'PACKAGE_NOT_EFFECTIVE');
      assert.strictEqual(pkgBlock(only[need.type]), false, `模板键 ${key}：只让表里写的包（${need.type}）生效，closeBlockers 不应再报包未生效`);
      assert.strictEqual(pkgBlock({ entryUnresolved: [] }), true, `模板键 ${key}：包都未生效应报`);
      for (const other of Object.keys(only)) {
        if (other !== need.type) assert.strictEqual(pkgBlock(only[other]), true, `模板键 ${key}：只让别的包（${other}）生效仍应报——它依赖的是 ${need.type}`);
      }
      // 批次验收包按本节点所在批次：别的批次的包生效不算
      if (need.type === 'batch_accept') {
        assert.strictEqual(pkgBlock({ batchAccept: { 99: true } }), true, `模板键 ${key}：别的批次的批次验收包生效不算`);
        assert.strictEqual(need.batchId, 7, `模板键 ${key}：批次验收包的批次取节点所在批次`);
      } else {
        assert.strictEqual(need.batchId, null, `模板键 ${key}：非批次验收包不按批次限定`);
      }
    }
  });

  test('C4b 历史 导入 节点 包多版本（K4）：依赖包的「生效日」取最早生效的版本——立项包 v1 于 2025-03 生效、v2 于 2026-10 替代后，2025-06 的立项收口、2025-06 生效的总体规划及其收口、外包项目 2025-06 的用户验收测试收口（批次验收包同样多版本）都应成功', async () => {
    const insVer = async (pkgId, no, status, at) => (await sqlRun(
      'INSERT INTO sysbuild_package_versions (package_id, version_no, form, status, effective_at, snapshot_json, created_by) VALUES (?, ?, NULL, ?, ?, \'{}\', ?)', [pkgId, no, status, at, U.pm]
    )).lastID;
    // 总体规划场景：不经导入的立项包，直接构造 v1（superseded，2025-03-01）+ v2（effective，2026-10-20）
    const s = await mkImportScene({ noInitiation: true });
    const ipk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, NULL, 'initiation', ?)", [s.pid, U.pm])).lastID;
    await insVer(ipk, 1, 'superseded', '2025-03-01 00:00:00');
    await insVer(ipk, 2, 'effective', '2026-10-20 00:00:00');
    // 立项与授权节点收口 2025-06-01：⑥ 比较的是立项包最早生效日（2025-03-01），不是当前版本（2026-10-20）
    const nIni = await nodeIdOf(s.pid, 'p_initiation');
    const rIni = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'node_closed', nIni, { original_date: '2025-06-01' }));
    assert.strictEqual(rIni.status, 201, `立项节点 2025-06-01 应成功（最早生效 2025-03-01）：${rIni.text}`);
    const nOv = await nodeIdOf(s.pid, 'p_overall');
    // 总体规划包 2025-06-01 生效：④ 比较立项包最早生效日
    const rOv = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', s.pv, { original_date: '2025-06-01' }));
    assert.strictEqual(rOv.status, 201, `总体规划 2025-06-01 应成功（立项包最早生效 2025-03-01）：${rOv.text}`);
    // 总体规划包再出一个 v2 替代 v1，然后收口总体范围与批次规划 2025-06-01：⑥ 取总体规划包最早生效日（2025-06-01）
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [s.pv]);
    await insVer(s.pk, 2, 'effective', '2026-10-21 00:00:00');
    const rNodeOv = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'node_closed', nOv, { original_date: '2025-06-01' }));
    assert.strictEqual(rNodeOv.status, 201, `总体规划节点 2025-06-01 应成功（最早生效 2025-06-01）：${rNodeOv.text}`);
    const nReq = await nodeIdOf(s.pid, 'b_req');
    const eReq = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'node_closed', nReq, { original_date: '2025-05-31' }));
    expectErr(eReq, 409, 'SYSBUILD_STATE', '早于总体规划包最早生效日仍拒绝');
    assert.ok(eReq.body.message.includes('2025-06-01') && eReq.body.message.includes('2025-05-31'), `文案实际 ${eReq.body.message}`);
    // 外包项目：批次验收包 v1（superseded，2025-03-01）+ v2（effective，2026-10-25）
    const po = await newProject('outsource');
    await openWin(po);
    const batchId = await defaultBatchId(po);
    const bpk = (await sqlRun("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, 'batch_accept', ?)", [po, batchId, U.pm])).lastID;
    await insVer(bpk, 1, 'superseded', '2025-03-01 00:00:00');
    await insVer(bpk, 2, 'effective', '2026-10-25 00:00:00');
    const nUat = await nodeIdOf(po, 'b_uat');
    const rUat = await post(U.pm, impUrl(po), await impBody(po, 'node_closed', nUat, { original_date: '2025-06-01' }));
    assert.strictEqual(rUat.status, 201, `用户验收测试 2025-06-01 应成功（批次验收包最早生效 2025-03-01）：${rUat.text}`);
  });

  test('C4b 历史 导入 节点 收口时刻（P70 / H5）：原日期与平台开始日同一天时 closed_at 取 opened_at；晚于开始日仍写原日期 00:00:00（比较按日，写入按时刻）', async () => {
    const pid = await newProject();
    await openWin(pid);
    const nDev = await nodeIdOf(pid, 'b_dev');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nDev}/start`, {})).status, 200);
    await sqlRun("UPDATE sysbuild_nodes SET opened_at = '2026-10-21 10:00:00' WHERE id = ?", [nDev]);
    await sqlRun("UPDATE sysbuild_node_schedule_records SET actual_date = '2026-10-21' WHERE node_id = ? AND kind = 'actual_start'", [nDev]);
    const r = await post(U.pm, impUrl(pid), await impBody(pid, 'node_closed', nDev, { original_date: '2026-10-22' }));
    assert.strictEqual(r.status, 201, r.text);
    const n = await rowOf('sysbuild_nodes', nDev);
    assert.deepStrictEqual([n.opened_at, n.closed_at], ['2026-10-21 10:00:00', '2026-10-22 00:00:00'], '晚于开始日：写原日期 00:00:00');
    const p2 = await newProject();
    await openWin(p2);
    const n2 = await nodeIdOf(p2, 'b_dev');
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${n2}/start`, {})).status, 200);
    await sqlRun("UPDATE sysbuild_nodes SET opened_at = '2026-10-21 15:30:00' WHERE id = ?", [n2]);
    await sqlRun("UPDATE sysbuild_node_schedule_records SET actual_date = '2026-10-21' WHERE node_id = ? AND kind = 'actual_start'", [n2]);
    assert.strictEqual((await post(U.pm, impUrl(p2), await impBody(p2, 'node_closed', n2, { original_date: '2026-10-21' }))).status, 201);
    const m2 = await rowOf('sysbuild_nodes', n2);
    assert.deepStrictEqual([m2.opened_at, m2.closed_at], ['2026-10-21 15:30:00', '2026-10-21 15:30:00'], '同日：closed_at 取 opened_at，不倒挂');
  });

  // ── 7c 读接口按对象编号读时核归属（H1，codex 22 号）────────────────────────────────────────────
  test('C4b 历史 读 跨项目（H1）：可见项目甲的用户传项目乙的包版本 / 条目版本编号读历史补录 → 409 且不泄露任何字段（含不存在的编号同一文案）；甲项目的无过滤列表与历史导入列表不含乙的记录；读取函数自身按项目限定（第二层）', async () => {
    const b = await mkPending();
    await openWin(b.pid);
    const bPk = await post(U.pm, confUrl(b.pid), await confBody(b.pid, 'package_version', b.pv, 'confirm', { actual_confirmer: '乙项目保密确认人' }));
    assert.strictEqual(bPk.status, 201, bPk.text);
    assert.strictEqual((await post(U.pm, confUrl(b.pid), await confBody(b.pid, 'item_version', b.ivid, 'confirm', { actual_confirmer: '乙项目保密确认人' }))).status, 201);
    const bi = await mkImportScene();
    assert.strictEqual((await post(U.pm, impUrl(bi.pid), await impBody(bi.pid, 'package_effective', bi.pv, { original_date: OK_DATE }))).status, 201);
    const a = await newProject();
    await openWin(a);
    // 另一个只看得到甲项目的账号（一般成员 U.m2：不在乙项目的 mkPending / mkImportScene 里，K5）
    await addMember(a, U.m2);
    expectErr(await get(U.m2, `/sysbuild/projects/${b.pid}`), 404, 'SYSBUILD_NOT_FOUND', 'U.m2 看不到乙项目');
    assert.strictEqual((await get(U.m2, `/sysbuild/projects/${a}`)).status, 200, 'U.m2 看得到甲项目');
    const rd = (uid, pid, ot, vid) => get(uid, `${confUrl(pid)}?object_type=${ot}&object_version_id=${vid}`);
    for (const uid of [U.pm, U.m2]) {
      for (const [ot, vid] of [['package_version', b.pv], ['item_version', b.ivid], ['package_version', 99999999], ['item_version', 99999999]]) {
        const r = await rd(uid, a, ot, vid);
        expectErr(r, 409, 'SYSBUILD_STATE', `用户 ${uid} 读 ${ot} #${vid}`);
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['code', 'message'], '只有错误码与文案，没有对象字段');
        assert.ok(!r.text.includes('乙项目保密确认人') && !r.text.includes('身份依据') && !r.text.includes('attachment'), `响应不得泄露字段：${r.text}`);
      }
    }
    // 乙项目自己读：200 且带记录（对照）
    const ok = await rd(U.pm, b.pid, 'package_version', b.pv);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(ok.body.history_confirmations.map((x) => x.actual_confirmer), ['乙项目保密确认人']);
    // 甲项目无过滤列表 / 历史导入列表不含乙的记录
    assert.deepStrictEqual((await get(U.pm, confUrl(a))).body.history_confirmations, []);
    assert.deepStrictEqual((await get(U.pm, impUrl(a))).body.history_imports, []);
    assert.ok((await get(U.pm, impUrl(bi.pid))).body.history_imports.length >= 1, '对照：乙的导入列表有记录');
    // 第二层：读取函数自身按项目限定（端点第一层挡不到的直接调用）
    const dir = T.getModuleDir() || path.join(__dirname, '../../routes/sysbuild');
    const coreMod = require(path.join(dir, 'confirm-core.js'));
    const q = { all: sqlAll, get: sqlGet, run: sqlRun };
    assert.deepStrictEqual(await coreMod.historyConfirmationsOf(q, a, 'package_version', b.pv), [], '甲项目读乙的包版本：空');
    assert.deepStrictEqual(await coreMod.historyConfirmationsOf(q, a, 'item_version', b.ivid), [], '甲项目读乙的条目版本：空');
    assert.strictEqual((await coreMod.historyConfirmationsOf(q, b.pid, 'package_version', b.pv)).length, 1, '乙项目读自己的：有');
    assert.strictEqual((await coreMod.historyConfirmationsOf(q, b.pid, 'item_version', b.ivid)).length, 1);
    assert.deepStrictEqual(await coreMod.historyImportsOf(q, a, 'package_version', bi.pv), [], '甲项目读乙的导入：空');
    assert.strictEqual((await coreMod.historyImportsOf(q, bi.pid, 'package_version', bi.pv)).length, 1);
    for (const bad of [undefined, null, 0, '5', -1]) {
      await assert.rejects(() => coreMod.historyConfirmationsOf(q, bad, 'package_version', b.pv), `项目编号 ${String(bad)} 非法：fail-closed`);
      await assert.rejects(() => coreMod.historyImportsOf(q, bad, 'package_version', bi.pv), `项目编号 ${String(bad)} 非法：fail-closed`);
    }
    await assert.rejects(() => coreMod.historyConfirmationsOf(q, b.pid, 'node', b.pv), '对象类型未登记：fail-closed');
    // K7：历史导入读取的对象类型白名单（五类合法，其余抛错；C6a 加入 batch = 上线事件导入）
    for (const ot of ['appointment', 'delegation', 'package_version', 'node', 'batch']) {
      assert.ok(Array.isArray(await coreMod.historyImportsOf(q, b.pid, ot, 1)), `${ot} 是合法对象类型`);
    }
    for (const badType of ['item_version', 'golive', 'package_effective', '', undefined, null]) {
      await assert.rejects(() => coreMod.historyImportsOf(q, bi.pid, badType, bi.pv), `历史导入读取对象类型 ${String(badType)} 未登记：fail-closed`);
    }
  });

  // ── 7d 导入：PM 不得兼任参与方负责人 / 代表人（H2，codex 22 号）──────────────────────────────────
  test('C4b 历史 导入 PM 兼任（H2）：任职 / 授权提议建立之后目标成员成为本项目 PM → 导入 409（同事务重核），状态、凭据绑定、事件都不变；无账号成员与非 PM 的有账号成员照常导入', async () => {
    // 构造说明：正常路径上，PM 更换（更换 PM 端点）会拒绝「新 PM 是某方现任 / 有待接受提议」，所以「提议之后目标成员成了 PM」只能直接写库构造
    const asPm = async (pid, uid) => sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [uid, pid]);
    const impAs = async (uid, pid, factType, oid) => {
      const body = Object.assign(await impBody(pid, factType, oid), { attachment_ids: [await stageAtt(pid, uid, 'q')] });
      return post(uid, impUrl(pid), body);
    };
    // 任职：有账号成员 U.m1 被提议为负责人（带邀请）
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const mj = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, user_id: U.m1 });
    assert.strictEqual(mj.status, 201, mj.text);
    assert.strictEqual((await post(U.m1, `/sysbuild/my/invitations/${mj.body.invitation.id}/accept`, {})).status, 200);
    const pr = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: mj.body.member.id });
    assert.strictEqual(pr.status, 201, pr.text);
    const aid = pr.body.appointment.id;
    await asPm(pid, U.m1);
    const snap = await stateSnap(pid);
    const r1 = await impAs(U.m1, pid, 'appointment', aid);
    expectErr(r1, 409, 'SYSBUILD_STATE', '目标成员是 PM（任职）');
    assert.ok(r1.body.message.includes('PM 不得兼任参与方负责人'), `文案实际 ${r1.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap, '被拒不改任何状态 / 凭据绑定 / 事件');
    assert.strictEqual((await rowOf('sysbuild_appointments', aid)).status, 'pending');
    assert.strictEqual((await rowOf('sysbuild_invitations', pr.body.invitation.id)).status, 'pending', '待接受的邀请不被撤回');
    await asPm(pid, U.pm); // 对照：PM 换回后，同一提议（有账号、非 PM）照常导入
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'appointment', aid))).status, 201);
    // 授权：有账号成员 U.m2 被提议为代表人
    const p2 = await newProject();
    await openWin(p2);
    const party2 = await addParty(p2, '乙部', 'demand');
    const mOwn = await addNaMember(p2, party2, '无账号负责人');
    await addAppointment(party2, mOwn, 'active');
    const mj2 = await post(U.pm, `/sysbuild/projects/${p2}/members`, { party_id: party2, user_id: U.m2 });
    assert.strictEqual(mj2.status, 201, mj2.text);
    assert.strictEqual((await post(U.m2, `/sysbuild/my/invitations/${mj2.body.invitation.id}/accept`, {})).status, 200);
    const pd = await post(U.pm, `/sysbuild/parties/${party2}/delegations`, { member_id: mj2.body.member.id });
    assert.strictEqual(pd.status, 201, pd.text);
    const did = pd.body.delegation.id;
    await asPm(p2, U.m2);
    const snap2 = await stateSnap(p2);
    const r2 = await impAs(U.m2, p2, 'delegation', did);
    expectErr(r2, 409, 'SYSBUILD_STATE', '目标成员是 PM（授权）');
    assert.ok(r2.body.message.includes('PM 不得兼任参与方代表人'), `文案实际 ${r2.body.message}`);
    assert.strictEqual(await stateSnap(p2), snap2, '被拒不改任何状态 / 凭据绑定 / 事件');
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'pending_owner');
    await asPm(p2, U.pm);
    assert.strictEqual((await post(U.pm, impUrl(p2), await impBody(p2, 'delegation', did))).status, 201);
  });

  // ── 7e 导入：授权原日期不得早于其依据任职的生效日（P69 / H3）──────────────────────────────────────
  test('C4b 历史 导入 授权晚于任职（P69 / H3）：授权的原日期早于其依据的负责人任职的生效日 → 409（文案写明任职生效日与原日期），当天可以；任职与授权都经历史导入时，授权原日期早于任职导入的原日期同样 409', async () => {
    // 平台已有现任（夹具生效于 2026-10-02）：授权原日期 10-01 → 409，10-02 当天 → 201
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const mOwn = await addNaMember(pid, party, '无账号负责人');
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addNaMember(pid, party, '无账号代表人');
    const dg = await addDelegation(party, mDel, apt, 'pending_accept');
    const snap = await stateSnap(pid);
    const e = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dg, { original_date: '2026-10-01' }));
    expectErr(e, 409, 'SYSBUILD_STATE', '早于依据任职生效日');
    assert.ok(e.body.message.includes('2026-10-02') && e.body.message.includes('2026-10-01'), `文案实际 ${e.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap, '被拒不改任何状态');
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', dg, { original_date: '2026-10-02' }))).status, 201, '原日期 = 任职生效日当天可以');
    // 任职与授权都经历史导入：任职原日期 10-25，授权原日期 10-24 → 409；10-25 → 201
    const p2 = await newProject();
    await openWin(p2);
    const party2 = await addParty(p2, '乙部', 'demand');
    const ap2 = await mkPendingAppt(p2, party2, '无账号负责人');
    const mD2 = await addNaMember(p2, party2, '无账号代表人');
    assert.strictEqual((await post(U.pm, impUrl(p2), await impBody(p2, 'appointment', ap2.aid, { original_date: '2026-10-25' }))).status, 201);
    const dg2 = await addDelegation(party2, mD2, ap2.aid, 'pending_owner');
    const snap2 = await stateSnap(p2);
    const e2 = await post(U.pm, impUrl(p2), await impBody(p2, 'delegation', dg2, { original_date: '2026-10-24' }));
    expectErr(e2, 409, 'SYSBUILD_STATE', '授权早于同批导入的任职');
    assert.ok(e2.body.message.includes('2026-10-25') && e2.body.message.includes('2026-10-24'), `文案实际 ${e2.body.message}`);
    assert.strictEqual(await stateSnap(p2), snap2);
    assert.strictEqual((await rowOf('sysbuild_delegations', dg2)).status, 'pending_owner');
    assert.strictEqual((await post(U.pm, impUrl(p2), await impBody(p2, 'delegation', dg2, { original_date: '2026-10-25' }))).status, 201, '同日可以');
    // 「现任任职读不到生效日 → 拒绝」的 fail-closed 分支，库内 CHECK（active 必有 effective_at）使它构造不出来，只靠代码审阅 / 静态保证，不配用例
  });

  // ── 7b 导入：历史日期与平台已发生的步骤、已导入事实不得自相矛盾（P68）────────────────────────────────
  const APPROVED_AT = '2026-10-28 10:00:00'; // 平台批准事件的时间写库固定（事件 created_at 是真实时钟，期望值不得取自它）
  const APPROVED_ON = '2026-10-28';
  test('C4b 历史 导入 一致性（P68）：授权 ②（平台批准日 / 代录批准的外部日期）、授权 ③（已撤销授权）、内容包 ④（立项包生效日）、节点 ⑤（曾走普通收口路径）——日期自相矛盾 409 且文案写明冲突对象与日期，边界日当天可以', async () => {
    // ② 授权已在平台上被负责人批准：原日期不得早于批准日（PM 提议 → 负责人本人在平台批准，批准事件的操作日期 = 真实今天）
    const pid = await newProject();
    await openWin(pid);
    const party = await addParty(pid, '甲部', 'demand');
    const mOwn = await addMember(pid, U.own, { party });
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addMember(pid, U.del, { party });
    const prop = await post(U.pm, `/sysbuild/parties/${party}/delegations`, { member_id: mDel });
    assert.strictEqual(prop.status, 201, prop.text);
    const did = prop.body.delegation.id;
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${did}/approve`, {})).status, 200);
    // 批准事件时间写库为固定值（事件 created_at 取真实时钟）：批准日 = 2026-10-28，原日期 OK_DATE（10-25）早于它
    const evUp = await sqlRun("UPDATE sysbuild_events SET created_at = ? WHERE object_type = 'delegation' AND object_id = ? AND event_type = 'delegation_approved'", [APPROVED_AT, did]);
    assert.strictEqual(evUp.changes, 1, '应恰有一条平台批准事件被固定时间');
    const approvedOn = APPROVED_ON;
    const snap = await stateSnap(pid);
    const c2 = await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', did, { original_date: OK_DATE }));
    expectErr(c2, 409, 'SYSBUILD_STATE', '早于平台批准日');
    assert.ok(c2.body.message.includes(APPROVED_ON) && c2.body.message.includes(OK_DATE), `文案写明批准日与原日期，实际 ${c2.body.message}`);
    assert.strictEqual(await stateSnap(pid), snap, '被拒不改任何状态');
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'delegation', did, { original_date: approvedOn }))).status, 201, '原日期 = 批准日当天可以');
    // P70（K3，同对象同日）：平台批准（带时刻）且原日期与批准事件同一天 → effective_at 取批准事件的时刻，不写 00:00:00
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).effective_at, APPROVED_AT, '同日取平台批准事件的时刻');
    // 原日期晚于批准日 → 写原日期 00:00:00
    const pk = await newProject();
    await openWin(pk);
    const partyK = await addParty(pk, '甲二部', 'demand');
    const mOwnK = await addMember(pk, U.own, { party: partyK });
    await addAppointment(partyK, mOwnK, 'active');
    const mDelK = await addMember(pk, U.del, { party: partyK });
    const propK = await post(U.pm, `/sysbuild/parties/${partyK}/delegations`, { member_id: mDelK });
    assert.strictEqual(propK.status, 201, propK.text);
    const didK = propK.body.delegation.id;
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${didK}/approve`, {})).status, 200);
    await sqlRun("UPDATE sysbuild_events SET created_at = ? WHERE object_type = 'delegation' AND object_id = ? AND event_type = 'delegation_approved'", [APPROVED_AT, didK]);
    assert.strictEqual((await post(U.pm, impUrl(pk), await impBody(pk, 'delegation', didK, { original_date: '2026-10-29' }))).status, 201);
    assert.strictEqual((await rowOf('sysbuild_delegations', didK)).effective_at, '2026-10-29 00:00:00', '不同日仍写 00:00:00');
    // ② 代录批准：批准日取代录确认记录的外部日期（凭据上的日期），不取操作日期
    const p2 = await newProject();
    await openWin(p2);
    const party2 = await addParty(p2, '乙部', 'demand');
    const mO2 = await addNaMember(p2, party2, '无账号负责人');
    const apt2 = await addAppointment(party2, mO2, 'active');
    const mD2 = await addNaMember(p2, party2, '无账号代表人');
    const pr2 = await post(U.pm, `/sysbuild/parties/${party2}/delegations`, { member_id: mD2 });
    assert.strictEqual(pr2.status, 201, pr2.text);
    const did2 = pr2.body.delegation.id;
    await backdate('sysbuild_delegations', [did2]);
    // 窗口开启期间该授权尚无历史导入记录：代录批准（P58 互斥只在有历史导入后拦）
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${did2}/proxy`, await evid(p2, { external_date: '2026-10-28', expected_step: 'grant' }))).status, 200);
    const c2p = await post(U.pm, impUrl(p2), await impBody(p2, 'delegation', did2, { original_date: '2026-10-25' }));
    expectErr(c2p, 409, 'SYSBUILD_STATE', '早于代录批准的外部日期');
    assert.ok(c2p.body.message.includes('2026-10-28'), `文案写明代录批准日，实际 ${c2p.body.message}`);
    assert.strictEqual((await post(U.pm, impUrl(p2), await impBody(p2, 'delegation', did2, { original_date: '2026-10-28' }))).status, 201, '原日期 = 代录批准日当天可以');
    assert.strictEqual((await rowOf('sysbuild_delegations', did2)).effective_at, '2026-10-28 00:00:00', '代录批准只有日期没有时刻：同日仍写 00:00:00');
    assert.ok(apt2 > 0);
    // ③ 本方已有撤销日期晚于原日期的授权
    const p3 = await newProject();
    await openWin(p3);
    const party3 = await addParty(p3, '丙部', 'demand');
    const mO3 = await addNaMember(p3, party3, '负责人');
    const apt3 = await addAppointment(party3, mO3, 'active');
    const mOld = await addNaMember(p3, party3, '前任代表人');
    const dOld = await addDelegation(party3, mOld, apt3, 'active');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-28 10:00:00', revoke_reason = '换人' WHERE id = ?", [dOld]);
    const mNew = await addNaMember(p3, party3, '继任代表人');
    const dNew = await addDelegation(party3, mNew, apt3, 'pending_accept');
    const c3 = await post(U.pm, impUrl(p3), await impBody(p3, 'delegation', dNew, { original_date: '2026-10-25' }));
    expectErr(c3, 409, 'SYSBUILD_STATE', '早于已撤销授权');
    assert.ok(c3.body.message.includes('2026-10-28') && c3.body.message.includes('2026-10-25'), `文案写明撤销日与原日期，实际 ${c3.body.message}`);
    assert.strictEqual((await post(U.pm, impUrl(p3), await impBody(p3, 'delegation', dNew, { original_date: '2026-10-28' }))).status, 201, '原日期 = 撤销日当天可以');
    // P70：同日 → 生效时刻取已撤销授权的 revoked_at
    assert.strictEqual((await rowOf('sysbuild_delegations', dNew)).effective_at, '2026-10-28 10:00:00', '同日取前任授权的 revoked_at');
    // 原日期晚于撤销日 → 写原日期 00:00:00
    const p3b = await newProject();
    await openWin(p3b);
    const party3b = await addParty(p3b, '丙二部', 'demand');
    const mO3b = await addNaMember(p3b, party3b, '负责人');
    const apt3b = await addAppointment(party3b, mO3b, 'active');
    const mOld3b = await addNaMember(p3b, party3b, '前任代表人');
    const dOld3b = await addDelegation(party3b, mOld3b, apt3b, 'active');
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-28 10:00:00', revoke_reason = '换人' WHERE id = ?", [dOld3b]);
    const mNew3b = await addNaMember(p3b, party3b, '继任代表人');
    const dNew3b = await addDelegation(party3b, mNew3b, apt3b, 'pending_accept');
    assert.strictEqual((await post(U.pm, impUrl(p3b), await impBody(p3b, 'delegation', dNew3b, { original_date: '2026-10-29' }))).status, 201);
    assert.strictEqual((await rowOf('sysbuild_delegations', dNew3b)).effective_at, '2026-10-29 00:00:00', '不同日仍写 00:00:00');
    // ④ 总体规划包：原日期不得早于立项包生效日（场景里立项包以 2026-10-20 导入生效）
    const s4 = await mkImportScene();
    const snap4 = await stateSnap(s4.pid);
    const c4 = await post(U.pm, impUrl(s4.pid), await impBody(s4.pid, 'package_effective', s4.pv, { original_date: '2026-10-19' }));
    expectErr(c4, 409, 'SYSBUILD_STATE', '早于立项包生效日');
    assert.ok(c4.body.message.includes(FLOOR) && c4.body.message.includes('2026-10-19'), `文案写明立项包生效日与原日期，实际 ${c4.body.message}`);
    assert.strictEqual(await stateSnap(s4.pid), snap4, '被拒不改任何状态');
    const ok4 = await post(U.pm, impUrl(s4.pid), await impBody(s4.pid, 'package_effective', s4.pv, { original_date: FLOOR }));
    assert.strictEqual(ok4.status, 201, `原日期 = 立项包生效日当天可以 ${ok4.text}`);
    // ⑤ 节点曾走普通路径收口（收口后又重开成进行中）→ 拒绝导入
    const p5 = await newProject();
    await openWin(p5);
    const nDev = (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = ?', [p5, 'b_dev'])).id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nDev}/start`, {})).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nDev}/close`, {})).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${nDev}/reopen`, { reason: '重做' })).status, 200);
    assert.strictEqual((await rowOf('sysbuild_nodes', nDev)).status, 'in_progress');
    const snap5 = await stateSnap(p5);
    const c5 = await post(U.pm, impUrl(p5), await impBody(p5, 'node_closed', nDev, { original_date: today() }));
    expectErr(c5, 409, 'SYSBUILD_STATE', '曾走普通收口路径');
    assert.ok(c5.body.message.includes('普通收口路径'), `提示实际 ${c5.body.message}`);
    assert.strictEqual(await stateSnap(p5), snap5, '被拒不改任何状态');
  });

  test('C4b 历史 导入 归属守卫（MED-4）：别的项目的草稿内容包版本 / 待处理授权导入 409，对方状态不变（对象本身完全可导入，只差归属）', async () => {
    // 别项目的草稿总体规划包版本（完整可导入的场景）
    const b = await mkImportScene();
    const a = await newProject();
    await openWin(a);
    const snapB = await stateSnap(b.pid);
    const r = await post(U.pm, impUrl(a), await impBody(a, 'package_effective', b.pv));
    expectErr(r, 409, 'SYSBUILD_STATE', '别项目的草稿包版本');
    assert.strictEqual(r.body.message, '对象不存在或不属于本项目');
    assert.strictEqual((await rowOf('sysbuild_package_versions', b.pv)).status, 'draft', '对方仍是草稿');
    assert.strictEqual(await stateSnap(b.pid), snapB, '对方项目没有任何变化');
    // 别项目的待处理授权（完整可导入：依据任职现任、成员在场、本方没有生效代表人）
    const pb = await newProject();
    const partyB = await addParty(pb, '乙部', 'demand');
    const mO = await addNaMember(pb, partyB, '负责人');
    const aptB = await addAppointment(partyB, mO, 'active');
    const mD = await addNaMember(pb, partyB, '代表人');
    const dB = await addDelegation(partyB, mD, aptB, 'pending_accept');
    const rd = await post(U.pm, impUrl(a), await impBody(a, 'delegation', dB));
    expectErr(rd, 409, 'SYSBUILD_STATE', '别项目的待处理授权');
    assert.strictEqual(rd.body.message, '对象不存在或不属于本项目');
    assert.strictEqual((await rowOf('sysbuild_delegations', dB)).status, 'pending_accept', '对方授权状态不变');
  });

  test('C4b 历史 导入 内容包（形态回写）：草稿建好后项目有效批次数变化 → 导入时按现状重算并回写 form，变化项 form_from / form_to 记进导入事件（与提交事件同名）', async () => {
    const s = await mkImportScene({
      beforeVersion: async (pid) => { await sqlRun("INSERT INTO sysbuild_batches (project_id, seq, name, status) VALUES (?, 2, '第 2 批', 'planning')", [pid]); },
      afterVersion: async (pid, pv) => {
        assert.strictEqual((await rowOf('sysbuild_package_versions', pv)).form, 'overall', '两个有效批次时草稿形态为普通总体');
        const b1 = await defaultBatchId(pid);
        await sqlRun("UPDATE sysbuild_batches SET status = 'superseded', superseded_by = ? WHERE project_id = ? AND seq = 2", [b1, pid]);
      },
    });
    const r = await post(U.pm, impUrl(s.pid), await impBody(s.pid, 'package_effective', s.pv, { original_date: OK_DATE }));
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual((await rowOf('sysbuild_package_versions', s.pv)).form, 'overall_batch_req', '重算后回写合并形态');
    const ev = (await payloads(s.pid, 'history_fact_imported')).find((p) => p.fact_type === 'package_effective' && p.object_id === s.pv);
    assert.deepStrictEqual([ev.form_from, ev.form_to, 'parent_from' in ev], ['overall', 'overall_batch_req', false]);
  });

  // ── 8 窗口与当前确认任务按对象互斥 ────────────────────────────────────────────────────────────
  const HC_MSG = '历史补录中：该对象已有历史记录，关闭窗口后再发起';
  test('C4b 历史 互斥：内容包（提交 / 改发 / 代录）与条目（提出人任务代录 / 改发 / 不生成新任务）——窗口 open 且该对象已有历史记录时 409，标志同源为假；窗口关闭后恢复；平台决策不受影响', async () => {
    const s = await mkPending();
    await openWin(s.pid);
    const proxyBody = async (task, decision) => Object.assign({ revision_id: task.rev_id, object_version_id: task.object_version_id, decision }, await evid(s.pid, { external_date: OK_DATE }));
    // 没有历史记录时不互斥：任务详情的代录 / 改发标志为真
    const d0 = await H.openTask(U.pm, s.tasks[0].task_id);
    assert.deepStrictEqual([d0.body.actions.proxy, d0.body.actions.reissue], [true, true]);
    // 内容包历史补录之后：包任务代录 / 改发 409
    assert.strictEqual((await post(U.pm, confUrl(s.pid), await confBody(s.pid, 'package_version', s.pv, 'confirm'))).status, 201);
    const snap = await stateSnap(s.pid);
    const px = await post(U.pm, `/sysbuild/confirm-tasks/${s.tasks[0].task_id}/proxy`, await proxyBody(s.tasks[0], 'confirm'));
    expectErr(px, 409, 'SYSBUILD_STATE', '包任务代录');
    assert.strictEqual(px.body.message, HC_MSG);
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${s.tasks[0].task_id}/reissue`, { reason: '换人' });
    expectErr(rs, 409, 'SYSBUILD_STATE', '包任务改发');
    assert.strictEqual(rs.body.message, HC_MSG);
    assert.strictEqual(await stateSnap(s.pid), snap, '被拒不改任何状态');
    const d1 = await H.openTask(U.pm, s.tasks[0].task_id);
    assert.deepStrictEqual([d1.body.actions.proxy, d1.body.actions.reissue, d1.body.actions.decide], [false, false, false], '标志同源为假');
    // 提交：撤回后新草稿提交也被拒（该内容包已有历史补录记录）；版本详情 submit 标志为假
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${s.pv}/withdraw`, { reason: '重新提交' })).status, 200);
    const pv2 = await mkVersion(s.pk); // 新草稿沿用上一版本的条目集合
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv2}`)).body.actions.submit, false);
    const sb = await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`);
    expectErr(sb, 409, 'SYSBUILD_STATE', '内容包提交');
    assert.strictEqual(sb.body.message, HC_MSG);
    // 对照（按对象，不是整项目封锁；也防「全库里别处有历史记录」被误当作本对象有）：同一项目、窗口仍开启时，另一条没有历史记录的条目照常生成提出人任务
    const itemB = await mkItem(s.pid, { proposer_name: undefined, proposer_member_id: s.mProp });
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [itemB.versions[0].id]), 1, '没有历史记录的条目不受互斥');
    // 条目：对该条目版本做历史补录后，提出人任务代录 / 改发 409，条目出新版本不再生成任务
    assert.strictEqual((await post(U.pm, confUrl(s.pid), await confBody(s.pid, 'item_version', s.ivid, 'confirm'))).status, 201);
    const itBody = Object.assign({ revision_id: s.itask.rid, object_version_id: s.ivid, decision: 'confirm' }, await evid(s.pid, { external_date: OK_DATE }));
    const ip = await post(U.pm, `/sysbuild/confirm-tasks/${s.itask.tid}/proxy`, itBody);
    expectErr(ip, 409, 'SYSBUILD_STATE', '提出人任务代录');
    assert.strictEqual(ip.body.message, HC_MSG);
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${s.itask.tid}/reissue`, { reason: '换人' }), 409, 'SYSBUILD_STATE', '提出人任务改发');
    const dI = await H.openTask(U.pm, s.itask.tid);
    assert.deepStrictEqual([dI.body.actions.proxy, dI.body.actions.reissue], [false, false]);
    const v2 = await post(U.pm, `/sysbuild/items/${s.item.id}/versions`, Object.assign({ content: '需求：第二版' }, EV_NO_WRITTEN));
    assert.strictEqual(v2.status, 201, v2.text);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [v2.body.item_version_id]), 0, '窗口内该条目已有历史补录 → 不生成新的提出人任务');
    // 窗口关闭后恢复：包提交通过；条目再出新版本生成提出人任务
    await closeWin(s.pid);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv2}`)).body.actions.submit, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`)).status, 200, '窗口关闭后恢复提交');
    const v3 = await post(U.pm, `/sysbuild/items/${s.item.id}/versions`, Object.assign({ content: '需求：第三版' }, EV_NO_WRITTEN));
    assert.strictEqual(v3.status, 201, v3.text);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [v3.body.item_version_id]), 1, '窗口关闭后生成提出人任务');
    // 内容包历史导入同样互斥（initiation 包导入后，窗口开启期间新草稿的提交被拒）
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    const pk = await mkPackage(pid, 'initiation');
    const iv1 = await mkVersion(pk);
    await openWin(pid);
    assert.strictEqual((await post(U.pm, impUrl(pid), await impBody(pid, 'package_effective', iv1))).status, 201);
    const iv2 = await mkVersion(pk);
    const si = await post(U.pm, `/sysbuild/package-versions/${iv2}/submit`);
    expectErr(si, 409, 'SYSBUILD_STATE', '历史导入后提交');
    assert.strictEqual(si.body.message, HC_MSG);
    // 别的内容包不受影响（按对象，不是整项目封锁）：总体规划包提交不被立项包的历史导入拦下（这里被其他前置拦下，但不是互斥文案）
    const pko = await mkPackage(pid, 'overall');
    const ov = await mkVersion(pko);
    const so = await post(U.pm, `/sysbuild/package-versions/${ov}/submit`);
    assert.notStrictEqual(so.body && so.body.message, HC_MSG, '别的内容包不被互斥');
  });

  test('C4b 历史 互斥：任职 / 授权——窗口 open 且该任职 / 授权已有历史导入时，代录与本人入口（邀请接受 / 授权接受 / 授权批准）一律 409、标志为假；窗口关闭后恢复', async () => {
    // 任职代录（无账号成员）
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const ap = await mkPendingAppt(pid, party, '无账号负责人');
    await backdate('sysbuild_appointments', [ap.aid]);
    await openWin(pid);
    const fixImport = (objectType, objectId) => sqlRun(
      "INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, ?, ?, ?, '张三', '当年文件', '2026-10-01', ?)",
      [pid, objectType, objectId, objectType, U.pm]
    );
    await fixImport('appointment', ap.aid);
    const px = await post(U.pm, `/sysbuild/appointments/${ap.aid}/proxy-accept`, await evid(pid, { external_date: OK_DATE }));
    expectErr(px, 409, 'SYSBUILD_STATE', '任职代录');
    assert.strictEqual(px.body.message, HC_MSG);
    const det = await get(U.pm, `/sysbuild/projects/${pid}`);
    assert.strictEqual(det.body.appointments.find((a) => a.id === ap.aid).actions.proxy_accept, false, '标志同源为假');
    // 授权代录（无账号成员，接受一步）
    const partyD = await addParty(pid, '乙部', 'demand'); // 另一方：任职代录会结束本方原现任并连带处理其授权，两条互斥各用一方
    const mOwn = await addNaMember(pid, partyD, '无账号负责人二');
    const apt = await addAppointment(partyD, mOwn, 'active');
    const mDel = await addNaMember(pid, partyD, '无账号代表人');
    const dlg = await addDelegation(partyD, mDel, apt, 'pending_accept');
    await backdate('sysbuild_delegations', [dlg]);
    await fixImport('delegation', dlg);
    const dp = await post(U.pm, `/sysbuild/delegations/${dlg}/proxy`, await evid(pid, { external_date: OK_DATE, expected_step: 'accept' }));
    expectErr(dp, 409, 'SYSBUILD_STATE', '授权代录');
    assert.strictEqual(dp.body.message, HC_MSG);
    assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}`)).body.delegations.find((x) => x.id === dlg).actions.proxy, false);
    // 对照（按对象，不是整项目封锁；也防「全库里别处有历史导入」被误当作本对象有）：同一项目、窗口仍开启时，另一方没有历史导入的任职照常可代录
    const partyE = await addParty(pid, '丙部', 'demand');
    const apE = await mkPendingAppt(pid, partyE, '无历史记录的无账号负责人');
    await backdate('sysbuild_appointments', [apE.aid]);
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${apE.aid}/proxy-accept`, await evid(pid, { external_date: OK_DATE }))).status, 200, '没有历史导入的任职不受互斥');
    // 窗口关闭后恢复：两条代录都能做
    await closeWin(pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${ap.aid}/proxy-accept`, await evid(pid, { external_date: OK_DATE }))).status, 200, '窗口关闭后任职代录恢复');
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${dlg}/proxy`, await evid(pid, { external_date: OK_DATE, expected_step: 'accept' }))).status, 200, '窗口关闭后授权代录恢复');
    // 本人入口：邀请接受（任职类）、授权接受、授权批准
    const p2 = await newProject();
    const party2 = await addParty(p2, '乙部', 'demand');
    const mj = await post(U.pm, `/sysbuild/projects/${p2}/members`, { party_id: party2, user_id: U.m1 });
    assert.strictEqual((await post(U.m1, `/sysbuild/my/invitations/${mj.body.invitation.id}/accept`, {})).status, 200);
    const pr = await post(U.pm, `/sysbuild/parties/${party2}/appointments`, { member_id: mj.body.member.id });
    const invId = pr.body.invitation.id;
    await openWin(p2);
    await sqlRun(
      "INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, 'appointment', ?, 'appointment', '张三', '当年文件', '2026-10-01', ?)",
      [p2, pr.body.appointment.id, U.pm]
    );
    const my = await get(U.m1, '/sysbuild/my/invitations');
    assert.strictEqual(my.body.invitations.find((i) => i.id === invId).actions.accept, false, '邀请接受标志为假');
    expectErr(await post(U.m1, `/sysbuild/my/invitations/${invId}/accept`, {}), 409, 'SYSBUILD_STATE', '邀请接受');
    assert.strictEqual((await rowOf('sysbuild_invitations', invId)).status, 'pending');
    // 授权接受 / 批准（有账号：负责人 own，被授权人 m2）
    const p3 = await newProject();
    const party3 = await addParty(p3, '丙部', 'demand');
    const mO = await addMember(p3, U.own, { party: party3 });
    const apt3 = await addAppointment(party3, mO, 'active');
    const mD = await addMember(p3, U.m2, { party: party3 });
    const dAcc = await addDelegation(party3, mD, apt3, 'pending_accept');
    await openWin(p3);
    const fix3 = (id) => sqlRun(
      "INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, 'delegation', ?, 'delegation', '张三', '当年文件', '2026-10-01', ?)",
      [p3, id, U.pm]
    );
    await fix3(dAcc);
    expectErr(await post(U.m2, `/sysbuild/delegations/${dAcc}/accept`, {}), 409, 'SYSBUILD_STATE', '授权接受');
    assert.strictEqual((await rowOf('sysbuild_delegations', dAcc)).status, 'pending_accept');
    assert.strictEqual((await get(U.m2, '/sysbuild/my/invitations')).body.delegations.find((x) => x.id === dAcc).actions.accept, false);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'withdrawn' WHERE id = ?", [dAcc]);
    const mD2 = await addMember(p3, U.m1, { party: party3 });
    const dOwn = await addDelegation(party3, mD2, apt3, 'pending_owner');
    await fix3(dOwn);
    expectErr(await post(U.own, `/sysbuild/delegations/${dOwn}/approve`, {}), 409, 'SYSBUILD_STATE', '授权批准');
    assert.strictEqual((await rowOf('sysbuild_delegations', dOwn)).status, 'pending_owner');
    await closeWin(p3);
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${dOwn}/approve`, {})).status, 200, '窗口关闭后授权批准恢复');
    await closeWin(p2);
    assert.strictEqual((await post(U.m1, `/sysbuild/my/invitations/${invId}/accept`, {})).status, 200, '窗口关闭后邀请接受恢复');
  });

  // ── 9 rules 手写矩阵 ─────────────────────────────────────────────────────────────────────────
  test('C4b 历史 rules：五个新动作的身份 × 项目状态 × 窗口状态矩阵手写核对；类别 history_import 行；golive / 不支持类型 / importBlock 缺失 fail-closed；历史互斥事实缺失一律拒绝；事件类型已登记', async () => {
    const R = T.getMods().rules;
    const pm = { isPm: true, isReadonly: false };
    const adminNotPm = { isAdmin: true, isPm: false, isReadonly: false };
    const nots = [[adminNotPm, 'admin 非 PM'], [{ isMember: true, isPm: false, isReadonly: false }, '一般成员'], [{ isPm: false, isReadonly: false }, '无项目身份'], [{ isPm: true, isReadonly: true }, '只读 PM']];
    const historyRow = { active: true, paused: true, terminated: false, closed: false };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.PROJECT_ACTION_TABLE.history_import)), { active: true, paused: true, terminated: false, closed: false }, 'history_import 行手写');
    for (const op of ['history_window_open', 'history_window_reopen', 'history_confirmation_record', 'history_fact_import']) assert.strictEqual(R.OP_KIND[op], 'history_import', `${op} 的类别`);
    // P67：关闭窗口不受项目状态限制（单列 history_close 行，四态全是）
    assert.strictEqual(R.OP_KIND.history_window_close, 'history_close');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.PROJECT_ACTION_TABLE.history_close)), { active: true, paused: true, terminated: true, closed: true }, 'history_close 行手写');
    // 重开的目标：projectLevel: true = 读接口项目级标志；执行端点带 reopenBlock（null / 文案）
    const win = (hw, op) => (op === 'history_window_reopen' ? { historyWindow: hw, projectLevel: true } : { historyWindow: hw });
    // 窗口三动作：谁 × 窗口状态
    const matrix = [['history_window_open', 'never'], ['history_window_close', 'open'], ['history_window_reopen', 'closed']];
    for (const [op, okFrom] of matrix) {
      const who = op === 'history_window_reopen' ? adminNotPm : pm;
      for (const hw of ['never', 'open', 'closed']) {
        assert.strictEqual(R.opAllowed(op, who, { status: 'active' }, win(hw, op)), hw === okFrom, `${op} × 窗口 ${hw}`);
        if (hw !== okFrom) assert.strictEqual(R.checkOp(op, who, { status: 'active' }, win(hw, op)).code, 'SYSBUILD_STATE', `${op} × ${hw} 的错误码`);
      }
      const rowOf4 = op === 'history_window_close' ? { active: true, paused: true, terminated: true, closed: true } : historyRow;
      for (const [st, ok] of Object.entries(rowOf4)) assert.strictEqual(R.opAllowed(op, who, { status: st }, win(okFrom, op)), ok, `${op} × 项目 ${st}`);
      if (op === 'history_window_close') assert.strictEqual(R.checkOp(op, who, { status: 'terminated' }, win(okFrom, op)), null, '已终止也能关闭');
      else assert.strictEqual(R.checkOp(op, who, { status: 'terminated' }, win(okFrom, op)).code, 'SYSBUILD_PROJECT_READONLY');
      assert.strictEqual(R.checkOp(op, { isMember: true }, { status: 'active' }, win(okFrom, op)).code, 'SYSBUILD_FORBIDDEN');
      for (const hw of [undefined, null, '', 'bogus']) assert.strictEqual(R.opAllowed(op, who, { status: 'active' }, hw === undefined ? {} : win(hw, op)), false, `${op} 窗口状态 ${String(hw)} fail-closed`);
    }
    // 重开冲突检查（P67）：reopenBlock null 放行，字符串原样 409，缺失（既无 projectLevel 也无 reopenBlock）/ 空串 / 非字符串 fail-closed
    const rop = (extra) => R.checkOp('history_window_reopen', adminNotPm, { status: 'active' }, Object.assign({ historyWindow: 'closed' }, extra));
    assert.strictEqual(rop({ reopenBlock: null }), null);
    assert.deepStrictEqual([rop({ reopenBlock: '内容包版本 #1' }).status, rop({ reopenBlock: '内容包版本 #1' }).message], [409, '内容包版本 #1']);
    for (const bad of [{}, { reopenBlock: undefined }, { reopenBlock: '' }, { reopenBlock: false }, { reopenBlock: 0 }]) assert.notStrictEqual(rop(bad), null, `重开冲突事实 ${JSON.stringify(bad)} 缺失 / 非法：fail-closed`);
    // 谁：开启 / 关闭 / 补录 / 导入 = PM（admin 非 PM、只读 PM、成员都否）；重开 = admin（PM 否、只读 admin 否）
    for (const [op, okFrom] of [['history_window_open', 'never'], ['history_window_close', 'open'], ['history_confirmation_record', 'open'], ['history_fact_import', 'open']]) {
      for (const [who, label] of nots) assert.strictEqual(R.opAllowed(op, who, { status: 'active' }, win(okFrom)), false, `${op}：${label}`);
    }
    assert.strictEqual(R.opAllowed('history_window_reopen', pm, { status: 'active' }, win('closed', 'history_window_reopen')), false, 'PM 不能重开');
    assert.strictEqual(R.opAllowed('history_window_reopen', { isAdmin: true, isReadonly: true }, { status: 'active' }, win('closed', 'history_window_reopen')), false, '只读 admin 不能重开');
    assert.strictEqual(R.opAllowed('history_window_reopen', { isMember: true }, { status: 'active' }, win('closed', 'history_window_reopen')), false);
    // 历史补录：窗口 open 才行
    for (const hw of ['never', 'open', 'closed']) assert.strictEqual(R.opAllowed('history_confirmation_record', pm, { status: 'active' }, win(hw)), hw === 'open', `补录 × 窗口 ${hw}`);
    for (const [st, ok] of Object.entries(historyRow)) assert.strictEqual(R.opAllowed('history_confirmation_record', pm, { status: st }, win('open')), ok, `补录 × 项目 ${st}`);
    assert.strictEqual(R.opAllowed('history_confirmation_record', pm, { status: 'active' }, {}), false, '补录缺窗口事实 fail-closed');
    // 历史事实导入：项目级标志（无 factType）与带 factType 的执行判定
    for (const hw of ['never', 'open', 'closed']) assert.strictEqual(R.opAllowed('history_fact_import', pm, { status: 'active' }, win(hw)), hw === 'open', `导入 × 窗口 ${hw}`);
    const imp = (extra) => R.checkOp('history_fact_import', pm, { status: 'active' }, Object.assign({ historyWindow: 'open' }, extra));
    for (const ft of ['appointment', 'delegation', 'package_effective', 'node_closed', 'golive']) { // C6a：golive 与其他类同矩阵（对象前置由 history.js loadGoliveFact 现取，importBlock 给出）
      assert.strictEqual(imp({ factType: ft, importBlock: null }), null, `${ft} 放行`);
      assert.deepStrictEqual([imp({ factType: ft, importBlock: '对象冲突' }).status, imp({ factType: ft, importBlock: '对象冲突' }).message], [409, '对象冲突'], `${ft} 对象冲突原文 409`);
      assert.notStrictEqual(imp({ factType: ft }), null, `${ft} importBlock 缺失 fail-closed`);
      assert.notStrictEqual(imp({ factType: ft, importBlock: undefined }), null);
      assert.notStrictEqual(imp({ factType: ft, importBlock: '' }), null, '空文案不当作通过');
    }
    assert.strictEqual(imp({ factType: 'bogus', importBlock: null }).message, '不支持的历史事实类型');
    assert.strictEqual(R.checkOp('history_fact_import', pm, { status: 'active' }, { historyWindow: 'closed', factType: 'golive' }).message, '历史补录窗口未开启，请先由项目经理开启', '窗口未开启先于 golive');
    // 历史互斥事实 historyConflict（P58）：null 放行，字符串原样 409，其余（缺失 / 空串 / 非字符串）拒绝
    const chk = (op, t, st) => R.checkOp(op, pm, { status: st || 'active' }, t);
    const ownerP = { isPm: false, ownerOfParties: [3], userId: 50, isReadonly: false };
    const selfP = { isPm: false, userId: 50, isReadonly: false };
    const hcCases = [
      ['package_version_submit', pm, { versionStatus: 'draft', packageType: 'initiation', confirmersMissing: null }],
      ['confirm_reissue', pm, { objectType: 'package_version', objectStatus: 'pending', revisionStatus: 'objected', reissueBlocked: null }],
      ['confirm_proxy', pm, { proxyable: true, currentRevisionId: 7, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, requiredIsSelf: false, qualificationLoss: null }],
      ['appointment_proxy_accept', pm, { status: 'pending', memberActive: true, hasAccount: false, accountDisabled: false }],
      ['delegation_proxy', pm, { status: 'pending_accept', appointmentIsCurrent: true, requalReason: null, ownerHasAccount: true, ownerAccountDisabled: false, memberHasAccount: false, memberAccountDisabled: false }],
      ['delegation_proxy', pm, { status: 'pending_owner', appointmentIsCurrent: true, requalReason: null, ownerHasAccount: false, ownerAccountDisabled: false, memberHasAccount: true, memberAccountDisabled: false }],
      ['invitation_accept', selfP, { status: 'pending', kind: 'appointment', userId: 50, requalReason: null }],
      ['delegation_accept', selfP, { status: 'pending_accept', party_id: 3, userId: 50, requalReason: null }],
      ['delegation_approve', ownerP, { status: 'pending_owner', party_id: 3, appointmentIsCurrent: true, requalReason: null }],
    ];
    for (const [op, who, base] of hcCases) {
      const call = (hc, drop) => {
        const t = Object.assign({}, base);
        if (!drop) t.historyConflict = hc;
        return R.checkOp(op, who, { status: 'active' }, t);
      };
      assert.strictEqual(call(null), null, `${op}：无冲突放行`);
      const c = call('历史补录中：测试文案');
      assert.deepStrictEqual([c && c.status, c && c.message], [409, '历史补录中：测试文案'], `${op}：冲突文案原样 409`);
      assert.notStrictEqual(call(undefined, true), null, `${op}：historyConflict 缺失 fail-closed`);
      assert.notStrictEqual(call(''), null, `${op}：空串不当作无冲突`);
      assert.notStrictEqual(call(false), null, `${op}：false 不当作无冲突`);
    }
    // 外部日期助手：下限含标签；NO_DATE_FLOOR 只由调用方显式给；下限缺失 fail-closed（500）
    const core = require(require('path').join(T.getModuleDir(), 'confirm-core.js'));
    assert.doesNotThrow(() => core.assertProxyDate('2026-10-20', '2026-10-20 09:00:00', '2026-11-15', '任职提议的创建日期'));
    const e1 = (() => { try { core.assertProxyDate('2026-10-19', '2026-10-20 09:00:00', '2026-11-15', '任职提议的创建日期'); } catch (e) { return e; } return null; })();
    assert.deepStrictEqual([e1.status, e1.message, e1.field], [400, '外部确认日期不能早于任职提议的创建日期（2026-10-20）', 'external_date']);
    assert.doesNotThrow(() => core.assertProxyDate('2001-01-01', core.NO_DATE_FLOOR, '2026-11-15'));
    const e2 = (() => { try { core.assertProxyDate('2026-11-16', core.NO_DATE_FLOOR, '2026-11-15', undefined, 'original_date', '原日期'); } catch (e) { return e; } return null; })();
    assert.deepStrictEqual([e2.status, e2.field, e2.message], [400, 'original_date', '原日期不能晚于今天（2026-11-15）']);
    const e2b = (() => { try { core.assertProxyDate('2026-11-16', core.NO_DATE_FLOOR, '2026-11-15'); } catch (e) { return e; } return null; })();
    assert.strictEqual(e2b.message, '外部确认日期不能晚于今天（2026-11-15）', '日期名缺省为外部确认日期');
    // 凭据解析的动作名：缺失 500；缺凭据文案按动作名
    const ev0 = { external_date: '2026-10-20', actual_confirmer: '甲', identity_basis: '乙' };
    const ee = (what) => { try { core.readProxyEvidence(ev0, what); } catch (e) { return e; } return null; };
    assert.strictEqual(ee(undefined).status, 500, '动作名缺失不静默沿用');
    assert.strictEqual(ee('历史补录').message, '历史补录必须附至少 1 个凭据附件');
    assert.strictEqual(ee('代录').message, '代录必须附至少 1 个凭据附件');
    for (const bad of [null, undefined, '', 'x']) {
      const e3 = (() => { try { core.assertProxyDate('2001-01-01', bad, '2026-11-15', '标签'); } catch (e) { return e; } return null; })();
      assert.strictEqual(e3 && e3.status, 500, `下限 ${String(bad)} 不能静默当作没有下限`);
    }
    // 事件类型登记
    const types = require(require('path').join(T.getModuleDir(), 'events.js')).EVENT_TYPES;
    for (const t of ['history_window_opened', 'history_window_closed', 'history_window_reopened', 'history_confirmation_recorded', 'history_fact_imported']) assert.ok(types.includes(t), `事件类型 ${t} 已登记`);
    // 条件更新合约登记
    const schema = require(require('path').join(T.getModuleDir(), 'schema.js'));
    assert.strictEqual(schema.CONDITIONAL_UPDATES.sysbuild_projects.history_window, 'history_window = ?');
    assert.ok(chk);
  });
}

// ── 变异（由 sysbuild-api-suite.js 登记到 MUTATIONS 末尾）：每条登记 expect；锚点在被测副本里恰好出现一次 ─────────────────────────────────────────
const W = 'C4b 历史 窗口：';
const WA = 'C4b 历史 窗口 actions';
const CF = 'C4b 历史 补录';
const CFD = 'C4b 历史 补录 冻结与草稿';
const WR = 'C4b 历史 窗口 重开冲突';
const WL1 = 'C4b 历史 窗口 重开冲突 按对象判';
const H1P = 'C4b 历史 读 跨项目';
const H2P = 'C4b 历史 导入 PM 兼任';
const P69P = 'C4b 历史 导入 授权晚于任职';
const HN4 = 'C4b 历史 导入 节点 依赖包';
const HN5 = 'C4b 历史 导入 节点 收口时刻';
const HN6 = 'C4b 历史 导入 节点 包多版本';
const P68 = 'C4b 历史 导入 一致性';
const MED4 = 'C4b 历史 导入 归属守卫';
const IC = 'C4b 历史 导入 公共';
const IA = 'C4b 历史 导入 任职';
const ID = 'C4b 历史 导入 授权';
const IP = 'C4b 历史 导入 内容包';
const IN = 'C4b 历史 导入 节点';
const X = 'C4b 历史 互斥';
const RL = 'C4b 历史 rules';
const m = (id, expect, file, from, to) => ({ id: `C4b Q-S2：${id}`, expect, edits: [{ file, from, to }] });
const HISTORY_MUTATIONS = [
  // ── 时间窗：状态机与身份（rules）──
  m('窗口开启：closed 状态下 PM 也能再开启（P51）', [W, RL], 'rules.js', "return t.historyWindow === 'closed' ? '历史补录窗口已关闭，重新开启需要 admin 写原因' : null;", 'return null;'),
  m('窗口关闭：never 状态下也能关闭', [W, RL], 'rules.js', "if (t.historyWindow === 'never') return '历史补录窗口还没有开启';", ''),
  m('窗口关闭：closed 状态下可再关闭', [W, RL], 'rules.js', "return t.historyWindow === 'closed' ? '历史补录窗口已经关闭' : null;", 'return null;'),
  m('窗口重开：never 状态下也能重开', [W, RL], 'rules.js', "if (t.historyWindow === 'never') return '历史补录窗口还没有开启过，请由项目经理开启';", ''),
  m('窗口重开：open 状态下可重开', [W, RL], 'rules.js', "if (t.historyWindow === 'open') return '历史补录窗口已经开启';\n      // P67 重开冲突检查", '// P67 重开冲突检查'),
  m('窗口开启：admin 非 PM 也能开启', [W, WA, RL], 'rules.js', 'history_window_open: Object.freeze({\n    can: canActAsPm,', 'history_window_open: Object.freeze({\n    can: canManageMembership,'),
  m('窗口关闭：admin 非 PM 也能关闭', [W, WA, RL], 'rules.js', 'history_window_close: Object.freeze({\n    can: canActAsPm,', 'history_window_close: Object.freeze({\n    can: canManageMembership,'),
  m('窗口重开：PM 也能重开（P51 只限 admin）', [W, WA, RL], 'rules.js', 'history_window_reopen: Object.freeze({\n    can: canChangeProjectStatus,', 'history_window_reopen: Object.freeze({\n    can: canActAsPm,'),
  m('历史补录：admin 非 PM 也能补录', [CF, RL], 'rules.js', 'history_confirmation_record: Object.freeze({\n    can: canActAsPm,', 'history_confirmation_record: Object.freeze({\n    can: canManageMembership,'),
  m('历史导入：admin 非 PM 也能导入', [IC, RL], 'rules.js', 'history_fact_import: Object.freeze({\n    can: canActAsPm,', 'history_fact_import: Object.freeze({\n    can: canManageMembership,'),
  m('窗口开启的项目状态类别改成 resolve（已终止也能开启）', [W, RL], 'rules.js', "history_window_open: 'history_import',", "history_window_open: 'resolve',"),
  m('历史导入的项目状态类别改成 resolve', [IC, RL], 'rules.js', "history_fact_import: 'history_import',", "history_fact_import: 'resolve',"),
  m('历史补录的项目状态类别改成 resolve', [CF, RL], 'rules.js', "history_confirmation_record: 'history_import',", "history_confirmation_record: 'resolve',"),
  m('history_import 状态行放行已终止', [W, RL], 'rules.js', 'history_import: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),', 'history_import: Object.freeze({ active: true, paused: true, terminated: true, closed: false }),'),
  // ── 时间窗：端点 ──
  m('重开不要求原因', [W], 'history.js', "const reason = readReason(body.reason, '重开原因', action === 'reopen');", "const reason = readReason(body.reason, '重开原因', false);"),
  m('窗口动作不要求凭据附件', [W], 'history.js', "const attachmentIds = core.readEvidenceAttachmentIds(body.attachment_ids, '时间窗动作');", "const attachmentIds = body.attachment_ids === undefined ? [] : core.readEvidenceAttachmentIds(body.attachment_ids, '时间窗动作');"),
  m('窗口转移写错目标态', [W], 'history.js', '[act.to, pid, cur]', '[cur, pid, cur]'),
  m('关闭窗口写成开启事件', [W], 'history.js', "event: 'history_window_closed' }),", "event: 'history_window_opened' }),"),
  m('窗口凭据绑定到别的所属类型', [W], 'history.js', "ownerType: 'event', ownerId: ev.lastID", "ownerType: 'history_import', ownerId: ev.lastID"),
  m('actions：重开标志恒为假', [WA], 'rules.js', "history_window_reopen: opAllowed('history_window_reopen', identity, project, { historyWindow: project.history_window, projectLevel: true }),", 'history_window_reopen: false,'),
  m('actions：开启标志不看窗口状态', [WA], 'rules.js', "history_window_open: opAllowed('history_window_open', identity, project, { historyWindow: project.history_window }),", "history_window_open: opAllowed('history_window_open', identity, project, { historyWindow: 'never' }),"),
  m('actions：补录标志恒为真', [WA], 'rules.js', "history_confirm: opAllowed('history_confirmation_record', identity, project, { historyWindow: project.history_window }),", 'history_confirm: true,'),
  m('actions：导入标志只看身份不看窗口', [WA], 'rules.js', "history_import: opAllowed('history_fact_import', identity, project, { historyWindow: project.history_window }),", 'history_import: !!identity.isPm,'),
  // ── 历史补录 ──
  m('历史补录接受任意对象类型', [CF], 'history.js', 'if (objectType === null) throw invalid(', 'if (false) throw invalid('),
  m('历史补录对象类型清单多收邀请', [CF], 'history.js', "const HISTORY_OBJECT_TYPES = Object.freeze(['package_version', 'item_version']);", "const HISTORY_OBJECT_TYPES = Object.freeze(['package_version', 'item_version', 'invitation']);"),
  m('历史补录不核对包版本属本项目', [CF], 'history.js', "WHERE v.id = ? AND p.project_id = ?', [objectVersionId, pid]", "WHERE v.id = ? AND ? > 0', [objectVersionId, pid]"), // 末轮 H1：读接口新增同形查询，锚点带上写端点特有的参数名保持唯一
  m('历史补录不核对条目版本属本项目', [CF], 'history.js', "WHERE iv.id = ? AND it.project_id = ?', [objectVersionId, pid]", "WHERE iv.id = ? AND ? > 0', [objectVersionId, pid]"),
  m('历史补录不核对外部日期上限', [CF], 'history.js', 'core.assertProxyDate(evidence.externalDate, core.NO_DATE_FLOOR, today());', ''),
  m('P63：历史补录套用「此刻」作下限（版本是平台当天新建的，下限会挡住全部历史日期）', [CF], 'history.js', 'core.assertProxyDate(evidence.externalDate, core.NO_DATE_FLOOR, today());', "core.assertProxyDate(evidence.externalDate, core.localDateString(new Date()), today(), '对象版本的创建日期');"),
  m('任务详情不返回历史补录', [CF], 'confirm.js', "history_confirmations: c.obj.kind === 'package_version' || c.obj.kind === 'item_version' ? await core.historyConfirmationsOf(q, c.task.project_id, c.obj.kind, c.task.object_version_id) : [],", 'history_confirmations: [],'),
  m('版本详情不返回历史补录', [CF], 'packages.js', "history_confirmations: await confirmCore.historyConfirmationsOf(q, pkg.project_id, 'package_version', vid),", 'history_confirmations: [],'),
  m('版本详情不返回历史导入', [IP], 'packages.js', "history_imports: await confirmCore.historyImportsOf(q, pkg.project_id, 'package_version', vid),", 'history_imports: [],'),
  m('历史补录记录的标记写成代录', [CF], 'confirm-core.js', "r.label = '历史补录';", "r.label = '代录';"),
  m('历史导入记录的标记写成代录', [IP], 'confirm-core.js', "r.label = '历史导入';", "r.label = '代录';"),
  m('历史补录事件不挂对象版本', [CF], 'confirm-core.js', "await emit(q, user, o.projectId, o.objectType, o.objectVersionId, 'history_confirmation_recorded', {", "await emit(q, user, o.projectId, o.objectType, 0, 'history_confirmation_recorded', {"),
  // ── 历史导入：公共 ──
  // C6a：原变异「golive 导入放行」随 golive 开放去掉；换成「开放清单漏掉 golive」（rules 矩阵与导入公共用例判红）
  m('导入开放清单漏掉 golive', [IC, RL], 'rules.js', "const HISTORY_IMPORT_FACT_TYPES = Object.freeze(['appointment', 'delegation', 'package_effective', 'node_closed', 'golive']);", "const HISTORY_IMPORT_FACT_TYPES = Object.freeze(['appointment', 'delegation', 'package_effective', 'node_closed']);"),
  m('导入不支持的事实类型放行', [RL], 'rules.js', "if (!HISTORY_IMPORT_FACT_TYPES.includes(t.factType)) return '不支持的历史事实类型';", ''),
  m('导入 importBlock 缺失放行', [RL], 'rules.js', 'if (t.importBlock === null) return null;', 'if (!t.importBlock) return null;'),
  m('导入不核对窗口开启', [IC, RL], 'rules.js', 'if (t.historyWindow !== \'open\') return HISTORY_WINDOW_NOT_OPEN_MESSAGE;', ''),
  m('导入不核对原日期上限', [IC], 'history.js', "core.assertProxyDate(d, core.NO_DATE_FLOOR, today(), undefined, 'original_date', '原日期');", ''),
  m('导入原日期套用下限', [IC], 'history.js', "core.assertProxyDate(d, core.NO_DATE_FLOOR, today(), undefined, 'original_date', '原日期');", "core.assertProxyDate(d, '2026-10-20 09:00:00', today(), '创建日', 'original_date', '原日期');"),
  m('导入记录实际确认人与身份依据写反', [IC], 'history.js', '[pid, objectType, objectId, factType, actualConfirmer, identityBasis, d, uid]', '[pid, objectType, objectId, factType, identityBasis, actualConfirmer, d, uid]'),
  m('导入凭据绑定到别的所属类型', [IC], 'history.js', "ownerType: 'history_import', ownerId: ins.lastID", "ownerType: 'confirmation', ownerId: ins.lastID"),
  m('导入事件不挂对象', [IC], 'history.js', "await emit(q, user, pid, objectType, objectId, 'history_fact_imported', Object.assign({", "await emit(q, user, pid, 'project', pid, 'history_fact_imported', Object.assign({"),
  m('节点导入记录的对象类型写错', [IN], 'history.js', "package_effective: 'package_version', node_closed: 'node', golive: 'batch' });", "package_effective: 'package_version', node_closed: 'nodes', golive: 'batch' });"),
  m('外部日期助手：原日期字段名写死 external_date', [IC, RL], 'confirm-core.js', "const f = field === undefined ? 'external_date' : field;", "const f = 'external_date';"),
  m('外部日期助手：不识别「没有下限」常量', [IC, RL], 'confirm-core.js', 'if (floorAt === NO_DATE_FLOOR) return;', ''),
  m('外部日期助手：下限缺失静默放行', [RL], 'confirm-core.js', "if (typeof floorAt !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}/.test(floorAt) || typeof floorLabel !== 'string' || floorLabel === '') {", 'if (false) {'),
  // ── 导入：任职 ──
  m('任职导入不核对属本项目', [IC], 'history.js', 'if (!a || a.project_id !== pid) return { block: NOT_IN_PROJECT };', 'if (!a) return { block: NOT_IN_PROJECT };'),
  m('任职导入不核对状态', [IA], 'history.js', "if (a.status !== 'pending') return { block: '只有待接受的任职提议可以导入历史生效' };", ''),
  m('任职导入不核对成员在场', [IA], 'history.js', "if (a.removed_at !== null || a.joined_at === null) return { block: '该成员已移出或尚未加入本项目，不能导入任职' };", ''),
  m('任职导入不核对本方现任（覆盖当前生效状态）', [IA], 'history.js', "if (cur) return { block: '该参与方已有现任负责人，历史任职不能覆盖当前生效状态' };", ''),
  m('P65：任职导入不撤回待接受的邀请', [IA], 'history.js', "await membership.withdrawInvitationsOfAppointment(q, user, data.id, { reason: '历史导入', via: 'history_import' });", ''),
  m('P65：任职导入的邀请撤回原因 / 来源写错', [IA], 'history.js', "{ reason: '历史导入', via: 'history_import' });\n    // 本方此刻没有现任", "{ reason: '撤回', via: 'platform' });\n    // 本方此刻没有现任"),
  m('任职导入不写原日期', [IA], 'history.js', 'await membership.activateAppointment(q, user, pid, data, data.sameDayAt || at);', 'await membership.activateAppointment(q, user, pid, data);'), // Q-S2 末轮 H5：锚点随同日取 ended_at 改写
  m('任职生效时刻参数被忽略', [IA], 'membership.js', '[effectiveAt === undefined ? null : effectiveAt, a.id]', '[null, a.id]'),
  // ── 导入：授权 ──
  m('授权导入不核对状态', [ID], 'history.js', "if (d.status !== 'pending_owner' && d.status !== 'pending_accept') return { block: '只有待处理的授权提议可以导入历史生效' };", ''),
  m('授权导入不核对依据任职现任', [ID], 'history.js', "if (d.appointment_status !== 'active') return { block: '授权所依据的负责人任职不是现任，不能导入授权' };", ''),
  m('授权导入不核对被授权人在场', [ID], 'history.js', "if (d.removed_at !== null || d.joined_at === null) return { block: '被授权人已移出或尚未加入本项目，不能导入授权' };", ''),
  m('授权导入不核对本方已有生效代表人', [ID], 'history.js', "if (cur) return { block: '该参与方已有生效代表人，历史授权不能覆盖当前生效状态' };", ''),
  m('授权导入不核对待确认的任务修订', [ID], 'history.js', "if (pend) return { block: '该授权有待确认的任务修订（当前有效任务），请先使其失效' };", ''),
  m('待负责人确认的授权导入不先推进到待接受', [ID], 'history.js', "if (data.status === 'pending_owner') await membership.moveDelegation(", "if (false) await membership.moveDelegation("),
  m('授权导入不写原日期', [ID], 'history.js', "await membership.activateDelegation(q, user, pid, Object.assign({}, data, { status: 'pending_accept' }), data.sameDayAt || at);", "await membership.activateDelegation(q, user, pid, Object.assign({}, data, { status: 'pending_accept' }));"), // Q-S2 末轮 H5：锚点随同日取 revoked_at 改写
  m('授权生效时刻参数被忽略', [ID], 'membership.js', '[effectiveAt === undefined ? null : effectiveAt, d.id]', '[null, d.id]'),
  // ── 导入：内容包 ──
  m('内容包导入不核对草稿状态', [IP], 'history.js', "if (ver.status !== 'draft') return { block: '只有草稿版本可以导入历史生效' };", ''),
  m('内容包导入不限类型', [IP], 'history.js', "if (!HISTORY_IMPORT_PACKAGE_TYPES.includes(pkg.type)) return { block: '该类型的内容包不支持历史生效导入' };", ''), // 预筛 M1：锚点随清单独立改写
  m('内容包导入放行正式变更', ['C5 预筛4轮：历史导入不接变更包'], 'history.js', "if (pkg.type === 'change') return { block: '正式变更不支持历史生效导入' };", ''),
  m('内容包导入不核对同包已有生效 / 待确认版本', [IP], 'history.js', "if (other) return { block: '该内容包已有生效或待确认的版本（已走普通路径 / 有当前任务），历史版本不能覆盖' };", ''),
  m('内容包导入要求确认人齐全（P56 不要求）', [IP], 'history.js', 'Object.assign({}, facts, { confirmersMissing: null, historyConflict: null })', 'Object.assign({}, facts, { historyConflict: null })'),
  m('内容包导入不重核条目集合', [IP], 'history.js', "const set = pkg.type === 'overall' ? await ctx.recheckOverallSet(q, pkg, ver) : [];", 'const set = [];'),
  m('内容包导入的生效时刻取此刻', [IP], 'history.js', '{ effectiveAt: at, recordedPlans: plans }', '{ effectiveAt: null, recordedPlans: plans }'),
  m('内容包导入不交节点计划清单（基线来源核对缺记录）', [IP], 'history.js', '{ effectiveAt: at, recordedPlans: plans }', '{ effectiveAt: at, recordedPlans: undefined }'),
  m('内容包导入不冻结条目版本附件', [IP], 'history.js', 'for (const it of set) {\n      await attachmentHelpers.freezeAttachmentSet(', 'for (const it of []) {\n      await attachmentHelpers.freezeAttachmentSet('),
  m('内容包导入不经待确认态（生效写入的旧状态条件不满足）', [IP], 'history.js', 'const pend = await q.run("UPDATE sysbuild_package_versions SET status = \'pending\', updated_at', 'const pend = await q.run("UPDATE sysbuild_package_versions SET updated_at'),
  m('生效写入忽略传入的生效时刻', [IP], 'confirm-core.js', '[o.effectiveAt, ver.id]', '[null, ver.id]'),
  m('基线来源核对忽略传入的节点计划清单', [IP], 'confirm-core.js', 'const recorded = recordedOverride !== undefined ? recordedOverride : await submittedNodePlans(q, versionId);', 'const recorded = await submittedNodePlans(q, versionId);'),
  // ── 导入：节点 ──
  m('节点导入不核对已收口 / 已取消', [IN], 'history.js', "if (node.status === 'closed' || node.status === 'cancelled') return { block: '节点已收口或已取消，不能导入收口' };", ''),
  m('节点导入不套用收口对象规则（里程碑 / 整体验收结项）', [IN], 'history.js', "isProjectLayer: node.batch_id === null, batchStatus: batch ? batch.status : null,\n    });\n    if (st) return { block: typeof st === 'string' ? st : st.message };", "isProjectLayer: node.batch_id === null, batchStatus: batch ? batch.status : null,\n    });"),
  m('节点导入不核对收口前置阻塞（P57）', [IN], 'history.js', 'if (blockers.length > 0) return { block:', 'if (false) return { block:'),
  m('节点导入不核对原日期不早于实际开始', [IN], 'history.js', 'if (startDay !== null && startDay > date) throw stateError(', 'if (false) throw stateError('),
  m('节点收口时刻不取原日期', [IN], 'history.js', "const { node, startDay } = data;\n    const at = dayStart(date);", "const { node, startDay } = data;\n    const at = '2026-01-01 00:00:00';"),
  m('节点导入不写实际结束记录', [IN], 'history.js', "await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)\", [node.id, date, Number(user.id)]);", ''),
  m('未开始节点导入不写实际开始记录', [IN], 'history.js', "await q.run(\"INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)\", [node.id, date, Number(user.id)]);", ''),
  // ── 互斥：判定助手 ──
  m('互斥：窗口 closed 也算开启', [X], 'confirm-core.js', "return r.history_window === 'open';", "return r.history_window !== 'never';"),
  m('互斥：内容包不看历史导入', [X], 'confirm-core.js', 'if (imp) return HISTORY_CONFLICT_MESSAGE;\n  const conf = await q.get(', 'const conf = await q.get('),
  m('互斥：内容包历史补录判定取反', [X], 'confirm-core.js', "c.object_type = 'package_version' AND v.package_id IN (${marks}) LIMIT 1", "c.object_type = 'package_version' AND v.package_id NOT IN (${marks}) LIMIT 1"), // 预筛 M3：ids 数组后锚点随之改写
  m('互斥：条目历史补录判定取反', [X], 'confirm-core.js', 'iv.item_id = ? LIMIT 1', 'iv.item_id <> ? LIMIT 1'),
  m('互斥：任职 / 授权历史导入判定取反', [X], 'confirm-core.js', "WHERE object_type = ? AND object_id = ? LIMIT 1', [kind, objectId]);", "WHERE object_type = ? AND object_id <> ? LIMIT 1', [kind, objectId]);"),
  m('互斥：条目有历史补录仍生成提出人任务', [X], 'confirm-core.js', 'if ((await itemHistoryConflict(q, o.projectId, o.itemId)) !== null) return null;', ''),
  // ── 互斥：规则层 ──
  m('互斥：提交不看历史冲突', [X, RL], 'rules.js', 'const hc = historyConflictState(t);\n      if (hc) return hc;\n      // C5 S-S1c 变更包', '// C5 S-S1c 变更包'), // S-S1c：互斥判定后面插入了变更包分支，锚点随之改写
  m('互斥：改发不看历史冲突', [X, RL], 'rules.js', 'const hc = historyConflictState(t);\n      if (hc) return hc;\n      return t.reissueBlocked || null;', 'return t.reissueBlocked || null;'),
  m('互斥：任职代录不看历史冲突', [X, RL], 'rules.js', 'const hc = historyConflictState(t);\n      if (hc) return hc;\n      if (t.hasAccount === false) return null;', 'if (t.hasAccount === false) return null;'),
  m('互斥：授权代录批准不看历史冲突', [RL], 'rules.js', 'const hcOwner = historyConflictState(t); // C4b Q-S2（P58）：该授权已有历史导入 → 不能代录批准\n        if (hcOwner) return hcOwner;', ''),
  m('互斥：授权代录接受不看历史冲突', [X, RL], 'rules.js', 'const hcAccept = historyConflictState(t); // C4b Q-S2（P58）：该授权已有历史导入 → 不能代录接受\n        if (hcAccept) return hcAccept;', ''),
  m('互斥：邀请接受不看历史冲突', [X, RL], 'rules.js', 'state: (t) => pendingInvitationState(t) || historyConflictState(t), requal: requalOf }),', 'state: pendingInvitationState, requal: requalOf }),'),
  m('互斥：授权接受不看历史冲突', [X, RL], 'rules.js', 'state: (t) => pendingAcceptState(t) || historyConflictState(t), requal: requalOf }),', 'state: pendingAcceptState, requal: requalOf }),'),
  m('互斥：授权批准不看历史冲突', [X, RL], 'rules.js', 'state: (t) => pendingOwnerState(t) || historyConflictState(t) }),', 'state: pendingOwnerState }),'),
  m('互斥：历史冲突事实缺失放行（fail-open）', [RL], 'rules.js', 'return typeof t.historyConflict === \'string\' && t.historyConflict !== \'\' ? t.historyConflict : PROXY_FACT_UNKNOWN_MESSAGE;', 'return typeof t.historyConflict === \'string\' && t.historyConflict !== \'\' ? t.historyConflict : null;'),
  // ── 互斥：接线 ──
  m('互斥：代录目标不取历史冲突', [X], 'confirm.js', 'historyConflict: await proxyWindowConflict(q, c),', 'historyConflict: null,'),
  m('互斥：改发解析不取历史冲突', [X], 'confirm.js', 'const historyConflict = await proxyWindowConflict(q, c);', 'const historyConflict = null;'),
  m('互斥：改发目标不带历史冲突', [X], 'confirm.js', 'reissueBlocked: res.blocked, historyConflict: res.historyConflict,', 'reissueBlocked: res.blocked, historyConflict: null,'),
  m('互斥：包任务不看历史冲突', [X], 'confirm.js', "if (c.obj.kind === 'package_version') return core.packageHistoryConflict(q, c.task.project_id, await core.historyPackageIdsOf(q, c.obj.pkg));", "if (c.obj.kind === 'package_version') return null;"), // S-S1c：变更包按总体规划包判，锚点随之改写（预筛 M3：函数改名 historyPackageIdsOf）
  m('互斥：条目任务不看历史冲突', [X], 'confirm.js', "if (c.obj.kind === 'item_version') return core.itemHistoryConflict(q, c.task.project_id, c.obj.iv.item_id);", "if (c.obj.kind === 'item_version') return null;"),
  m('互斥：提交事实不取历史冲突', [X], 'packages.js', 'facts.historyConflict = await confirmCore.packageHistoryConflict(q, pkg.project_id, await confirmCore.historyPackageIdsOf(q, pkg));', 'facts.historyConflict = null;'), // S-S1c：versionFactsOf 改成逐项赋值，锚点随之改写
  m('互斥：任职读接口不取历史冲突', [X], 'membership.js', 'const apptConflict = await appointmentConflictOf(q, a);', 'const apptConflict = null;'),
  m('互斥：任职代录执行不取历史冲突', [X], 'membership.js', 'appointmentProxyTarget(a, await appointmentConflictOf(q, a)));', 'appointmentProxyTarget(a, null));'),
  m('互斥：授权代录执行不取历史冲突', [X], 'membership.js', "rules.assertOp('delegation_proxy', identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));", "rules.assertOp('delegation_proxy', identity, identity.project, delegationTarget(d, identity.project, null));"),
  m('互斥：授权批准执行不取历史冲突', [X], 'membership.js', 'rules.assertOp(opName, identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));', 'rules.assertOp(opName, identity, identity.project, delegationTarget(d, identity.project, null));'),
  m('互斥：授权接受执行不取历史冲突', [X], 'membership.js', 'const verdict = rules.checkOp(opName, identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));', 'const verdict = rules.checkOp(opName, identity, identity.project, delegationTarget(d, identity.project, null));'),
  m('互斥：授权列表读接口不取历史冲突', [X], 'membership.js', 'const t = delegationTarget(d, project, await delegationConflictOf(q, d));\n    delegations.push({', 'const t = delegationTarget(d, project, null);\n    delegations.push({'),
  m('互斥：我的授权入口读接口不取历史冲突', [X], 'membership.js', 'const t = delegationTarget(d, project, await delegationConflictOf(q, d));\n  return { project, accept', 'const t = delegationTarget(d, project, null);\n  return { project, accept'), // 修订批 2（M2 / P185）：可操作判定抽成 membership.delegationActionsOf，锚点随之换位置
  m('互斥：邀请接受执行不取历史冲突', [X], 'membership.js', 'readonlySetOf(ctx.readonlyIds), await invitationConflictOf(q, row)));', 'readonlySetOf(ctx.readonlyIds), null));'),
  m('互斥：邀请读接口不取历史冲突', [X], 'membership.js', 'const t = invitationTarget(project, row, row.appt_status, readonlySetOf(accessOpts.readonlyIds), await invitationConflictOf(q, row));', 'const t = invitationTarget(project, row, row.appt_status, readonlySetOf(accessOpts.readonlyIds), null);'), // 修订批 2（M2 / P185）：抽成 membership.invitationActionsOf
  m('互斥：任职类邀请不看任职的历史导入', [X], 'membership.js', "const invitationConflictOf = (q, inv) => (inv.kind === 'appointment'", "const invitationConflictOf = (q, inv) => (inv.kind === 'never'"),
  // ── 预筛修订批（fix1）：P66 历史补录的对象状态与条目附件冻结 ──
  m('P66：草稿内容包版本可补录', [CFD], 'history.js', "if (objectType === 'package_version' && obj.status === 'draft') throw stateError(", 'if (false) throw stateError('),
  m('P66：条目补录不冻结附件', [CFD], 'history.js', 'if (!frozen) {', 'if (false) {'),
  m('P66：条目补录对已冻结的重复冻结', [CFD], 'history.js', 'if (!frozen) {', 'if (true) {'),
  // ── P67：窗口关闭不受项目状态限制；重开冲突检查 ──
  m('P67：关闭窗口的项目状态类别改回 history_import（已终止不能关）', [W, RL], 'rules.js', "history_window_close: 'history_close',", "history_window_close: 'history_import',"),
  m('P67：history_close 行不放行已终止', [W, RL], 'rules.js', 'history_close: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),', 'history_close: Object.freeze({ active: true, paused: true, terminated: false, closed: true }),'),
  m('P67：history_close 行不放行已结项', [W, RL], 'rules.js', 'history_close: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),', 'history_close: Object.freeze({ active: true, paused: true, terminated: true, closed: false }),'),
  m('P67：重开不做冲突检查', [WR], 'history.js', "if (action === 'reopen') rules.assertOp(act.op, access, access.project, { historyWindow: cur, reopenBlock: await reopenBlockOf(q, pid) });", ''),
  m('P67：重开冲突规则放行缺失事实（fail-open）', [RL], 'rules.js', 'if (t.projectLevel === true || t.reopenBlock === null) return null;', 'if (t.projectLevel === true || !t.reopenBlock) return null;'),
  m('P67：重开冲突检查漏内容包', [WR], 'history.js', 'for (const r of pk) objs.push(`内容包版本 #${r.id}（有待确认的任务）`);', ''),
  m('P67：重开冲突检查漏条目', [WR], 'history.js', 'for (const r of it) objs.push(`条目版本 #${r.id}（提出人确认待处理）`);', ''),
  m('P67：重开冲突检查漏任职', [WR], 'history.js', 'for (const r of ap) objs.push(`任职 #${r.id}（待接受）`);', ''),
  m('P67：重开冲突检查漏授权', [WR], 'history.js', 'for (const r of dg) objs.push(`授权 #${r.id}（待处理）`);', ''),
  m('P67：重开冲突检查把已退回（非 pending）的包版本也算', [WR], 'history.js', "JOIN sysbuild_package_versions v ON v.id = t.object_version_id AND v.status = 'pending'", 'JOIN sysbuild_package_versions v ON v.id = t.object_version_id'), // Q-S2 末轮 LOW-1：锚点随「按对象判」改写
  m('P67：actions 的重开标志不带项目级声明（恒拒绝）', [WA], 'rules.js', "history_window_reopen: opAllowed('history_window_reopen', identity, project, { historyWindow: project.history_window, projectLevel: true }),", "history_window_reopen: opAllowed('history_window_reopen', identity, project, { historyWindow: project.history_window }),"),
  // ── P68：历史日期与平台已发生步骤 / 已导入事实不得自相矛盾 ──
  m('P68 ①：进行中节点不核对平台开始日', [IN], 'history.js', "if (node.status === 'in_progress' && node.opened_at && date < String(node.opened_at).slice(0, 10)) {", 'if (false) {'),
  m('P68 ①：平台开始日当天被拒（< 写成 <=）', [IN], 'history.js', 'date < String(node.opened_at).slice(0, 10)', 'date <= String(node.opened_at).slice(0, 10)'),
  m('P68 ②：授权不核对平台批准日', [P68], 'history.js', 'if (date < approvedOn) return { block:', 'if (false) return { block:'),
  m('P68 ②：批准日当天被拒（< 写成 <=）', [P68], 'history.js', 'if (date < approvedOn) return { block:', 'if (date <= approvedOn) return { block:'),
  m('P68 ②：代录批准的批准日不取外部日期', [P68], 'confirm-core.js', 'if (g) return g.external_date;', 'if (false) return g.external_date;'), // Q-S2 末轮 LOW-3：取法抽到 confirm-core.js delegationApprovedOn，锚点换文件
  m('P68 ③：任职导入不核对已结束任期', [IA], 'history.js', 'if (ended) return { block:', 'if (false) return { block:'),
  m('P68 ③：已结束任期的方向写反', [IA], 'history.js', "AND status = 'ended' AND substr(ended_at, 1, 10) > ?", "AND status = 'ended' AND substr(ended_at, 1, 10) < ?"),
  m('P68 ③：结束日当天被拒（> 写成 >=）', [IA], 'history.js', "AND status = 'ended' AND substr(ended_at, 1, 10) > ?", "AND status = 'ended' AND substr(ended_at, 1, 10) >= ?"),
  m('P68 ③：授权导入不核对已撤销授权', [P68], 'history.js', 'if (revoked) return { block:', 'if (false) return { block:'),
  m('P68 ④：总体规划不核对立项包生效日', [P68], 'history.js', 'if (ini && date < String(ini.effective_at).slice(0, 10)) return', 'if (false) return'),
  m('P68 ④：立项包生效日当天被拒（< 写成 <=）', [P68], 'history.js', 'date < String(ini.effective_at).slice(0, 10)', 'date <= String(ini.effective_at).slice(0, 10)'),
  m('P68 ⑤：节点曾走普通收口路径仍可导入', [P68], 'history.js', 'if (closedEv) return { block:', 'if (false) return { block:'),
  // ── MED-2 计划快照 / MED-4 归属守卫 ──
  m('MED-2：导入事件不带 node_plans', [IP], 'history.js', 'eventExtra: Object.assign({}, changed, plans === undefined ? {} : { node_plans: plans }),', 'eventExtra: Object.assign({}, changed),'),
  m('MED-2：没有提交事件时不读导入事件的快照', [IP], 'confirm-core.js', "AND event_type = 'history_fact_imported' ORDER BY id DESC LIMIT 1\",\n      [versionId]", "AND event_type = 'no_such_event' ORDER BY id DESC LIMIT 1\",\n      [versionId]"),
  m('MED-4：授权导入不核对属本项目', [MED4], 'history.js', 'if (!d || d.project_id !== pid) return { block: NOT_IN_PROJECT };', 'if (!d) return { block: NOT_IN_PROJECT };'),
  m('MED-4：内容包导入不核对属本项目', [MED4], 'history.js', 'if (!ver || !pkg || pkg.project_id !== pid) return { block: NOT_IN_PROJECT };', 'if (!ver || !pkg) return { block: NOT_IN_PROJECT };'),
  // ── LOW-2 文案 / LOW-3 形态回写 / LOW-4 包材料附件 / LOW-6 附件视图与 payload ──
  m('LOW-2：历史补录缺凭据的文案沿用「代录」', [CF], 'history.js', "core.readProxyEvidence(body, '历史补录')", "core.readProxyEvidence(body, '代录')"),
  m('LOW-2：历史导入的日期名沿用「外部确认日期」', [IC], 'history.js', "'original_date', '原日期');\n      const at = dayStart(d);", "'original_date', undefined);\n      const at = dayStart(d);"),
  m('LOW-2：凭据解析缺动作名不拦', [RL], 'confirm-core.js', "if (typeof what !== 'string' || what === '') throw internalError('凭据解析缺动作名');", ''),
  m('LOW-3：导入不回写形态（只重算不写）', [IP], 'history.js', 'const { calc, changed } = await packages.rewriteFormAndParent(q, pkg, ver);', 'const calc = await packages.computeFormAndParent(q, pkg); const changed = {};'),
  m('LOW-3：导入事件不记形态变化项', [IP], 'history.js', 'eventExtra: Object.assign({}, changed, plans === undefined', 'eventExtra: Object.assign({}, plans === undefined'),
  m('LOW-4：导入不冻结包材料附件', [IP], 'history.js', "await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: ver.id, ownerType: 'package_version', ownerId: ver.id, operatorId: uid, operatorName: opName, projectId: pid });", ''),
  m('LOW-6：历史补录记录不带附件视图', [CF], 'confirm-core.js', "r.label = '历史补录';\n    await attachConfirmationEvidence(q, r);", "r.label = '历史补录';"),
  m('LOW-6：历史导入记录不带附件视图', [IC], 'confirm-core.js', 'await attachImportEvidence(q, r);', ''),
  m('LOW-6：导入事件 payload 不带身份依据', [IC], 'history.js', 'identity_basis: identityBasis, attachment_ids: bound,', 'attachment_ids: bound,'),
  // ── Q-S2 末轮小修批（预筛 5L + codex 22 号 H1–H5）──
  // LOW-1 重开冲突按对象判：包版本 status = pending（且有任务）、条目 proposer_status = pending（且有提出人任务、是最新版本）
  m('LOW-1：重开冲突把包版本退回按修订状态判（当前修订 objected 即不拦）', [WL1], 'history.js', "JOIN sysbuild_package_versions v ON v.id = t.object_version_id AND v.status = 'pending'", "JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id AND r.status = 'pending'\n         JOIN sysbuild_package_versions v ON v.id = t.object_version_id"),
  m('LOW-1：重开冲突把条目退回按修订状态判（当前修订 objected 即不拦）', [WL1], 'history.js', "JOIN sysbuild_item_versions iv ON iv.id = t.object_version_id AND iv.proposer_status = 'pending'", "JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id AND r.status = 'pending'\n         JOIN sysbuild_item_versions iv ON iv.id = t.object_version_id"),
  m('LOW-1：重开冲突不看条目提出人状态（已确认的提出人也拦）', [WL1, WR], 'history.js', "JOIN sysbuild_item_versions iv ON iv.id = t.object_version_id AND iv.proposer_status = 'pending'", 'JOIN sysbuild_item_versions iv ON iv.id = t.object_version_id'),
  m('LOW-1：重开冲突把条目的旧版本也算（去掉最新版本条件）', [WL1], 'history.js', 'AND iv.version_no = (SELECT MAX(iv9.version_no) FROM sysbuild_item_versions iv9 WHERE iv9.item_id = iv.item_id)', 'AND 1 = 1'), // K6：「最新版本」按 version_no 取，与 confirm.js resolveReissue（MAX(version_no)）同口径
  // LOW-4 projectLevel 只供读接口与第一道判定：执行路径第二道判定带它 = 绕过冲突检查
  m('LOW-4：重开执行路径第二道判定带 projectLevel（绕过冲突检查）', [WR], 'history.js', "if (action === 'reopen') rules.assertOp(act.op, access, access.project, { historyWindow: cur, reopenBlock: await reopenBlockOf(q, pid) });", "if (action === 'reopen') rules.assertOp(act.op, access, access.project, { historyWindow: cur, projectLevel: true, reopenBlock: await reopenBlockOf(q, pid) });"),
  // P69 / H3 授权原日期不得早于依据任职的生效日
  m('P69：授权导入不核对依据任职的生效日', [P69P], 'history.js', 'if (date < baseOn) return { block:', 'if (false) return { block:'),
  m('P69：依据任职生效日当天被拒（< 写成 <=）', [P69P], 'history.js', 'if (date < baseOn) return { block:', 'if (date <= baseOn) return { block:'),
  m('P69：依据任职的生效日取任职提议创建日而不是 effective_at', [P69P], 'history.js', '(SELECT ap.effective_at FROM sysbuild_appointments ap WHERE ap.id = d.appointment_id) AS appointment_effective_at', '(SELECT ap.created_at FROM sysbuild_appointments ap WHERE ap.id = d.appointment_id) AS appointment_effective_at'),
  // LOW-3 批准日取法共用：历史导入要跳过自己写的批准事件
  m('LOW-3：批准日取法不跳过历史导入写的批准事件', [ID], 'confirm-core.js', "if (o && o.skipHistoryImport === true) {", 'if (false) {'),
  // H1 读接口按对象编号读时核归属（两层）
  m('H1：读接口不核对象版本属路径项目（第一层）', [H1P], 'history.js', 'if (!owned) throw stateError(NOT_IN_PROJECT);', ''),
  m('H1：读取函数不按项目限定包版本（第二层）', [H1P], 'confirm-core.js', "? 'JOIN sysbuild_package_versions ov ON ov.id = c.object_version_id JOIN sysbuild_packages op ON op.id = ov.package_id WHERE op.project_id = ?'", "? 'WHERE ? IS NOT NULL'"),
  m('H1：读取函数不按项目限定条目版本（第二层）', [H1P], 'confirm-core.js', ": 'JOIN sysbuild_item_versions ov ON ov.id = c.object_version_id JOIN sysbuild_items op ON op.id = ov.item_id WHERE op.project_id = ?';", ": 'WHERE ? IS NOT NULL';"),
  m('H1：历史导入读取不按项目限定', [H1P], 'confirm-core.js', 'FROM sysbuild_history_imports h WHERE h.project_id = ? AND h.object_type = ? AND h.object_id = ? ORDER BY h.id', 'FROM sysbuild_history_imports h WHERE ? IS NOT NULL AND h.object_type = ? AND h.object_id = ? ORDER BY h.id'),
  m('H1：读取函数缺项目编号不拦（fail-open）', [H1P], 'confirm-core.js', "if (!Number.isInteger(projectId) || projectId <= 0) throw internalError('历史补录读取缺项目编号');", ''),
  m('H1：历史导入读取缺项目编号不拦（fail-open）', [H1P], 'confirm-core.js', "if (!Number.isInteger(projectId) || projectId <= 0) throw internalError('历史导入读取缺项目编号');", ''),
  m('H1：读取函数对象类型未登记不拦', [H1P], 'confirm-core.js', "if (objectType !== 'package_version' && objectType !== 'item_version') throw internalError('历史补录读取的对象类型未登记');", ''),
  // H2 PM 不得兼任参与方负责人 / 代表人
  m('H2：任职导入不重核 PM 兼任', [H2P], 'history.js', "if (await isPmUserOf(q, pid, a.user_id)) return { block: 'PM 不得兼任参与方负责人，该成员已是本项目 PM，不能导入任职' };", ''),
  m('H2：授权导入不重核 PM 兼任', [H2P], 'history.js', "if (await isPmUserOf(q, pid, d.user_id)) return { block: 'PM 不得兼任参与方代表人，被授权人已是本项目 PM，不能导入授权' };", ''),
  m('H2：PM 判定对无账号成员恒真（无账号成员也被拒）', [IA, ID], 'confirm-core.js', 'const isProjectPmUser = (userId, pmUserId) => userId !== null && userId !== undefined && Number(userId) === Number(pmUserId);', 'const isProjectPmUser = (userId, pmUserId) => userId === null || userId === undefined || Number(userId) === Number(pmUserId);'),
  m('H2：PM 判定恒假', [H2P], 'confirm-core.js', 'const isProjectPmUser = (userId, pmUserId) => userId !== null && userId !== undefined && Number(userId) === Number(pmUserId);', 'const isProjectPmUser = () => false;'),
  m('H2：PM 兼任判定不读当前 pm_user_id（恒与 -1 比）', [H2P], 'history.js', 'return core.isProjectPmUser(userId, pr.pm_user_id);', 'return core.isProjectPmUser(userId, -1);'),
  // H4 节点收口依赖内容包的日期（P68 ⑥）
  m('P68 ⑥：节点收口不核对依赖包的生效日', [HN4], 'history.js', 'if (date < effOn) return { block:', 'if (false) return { block:'),
  m('P68 ⑥：依赖包生效日当天被拒（< 写成 <=）', [HN4], 'history.js', 'if (date < effOn) return { block:', 'if (date <= effOn) return { block:'),
  m('P68 ⑥：整个依赖包日期检查跳过', [HN4], 'history.js', 'if (need !== null) {', 'if (false) {'),
  m('P68 ⑥：批次验收包不按批次限定（取别批的包）', [HN4], 'history.js', '(? IS NULL OR p.batch_id = ?)', '(? IS NULL OR ? IS NOT NULL)'),
  m('P68 ⑥：包类型表漏需求确认节点', [HN4], 'plan.js', "if (node.template_key === 'b_req') return { type: 'overall', batchId: null, label: '总体规划包' };", ''),
  m('P68 ⑥：包类型表漏用户验收测试节点', [HN4], 'plan.js', "if (node.template_key === 'b_uat') return { type: 'batch_accept', batchId: node.batch_id, label: '批次验收包' };", ''),
  m('P68 ⑥：包类型表把立项节点指向总体规划包', [HN4], 'plan.js', "if (node.template_key === 'p_initiation') return { type: 'initiation', batchId: null, label: '项目立项包' };", "if (node.template_key === 'p_initiation') return { type: 'overall', batchId: null, label: '总体规划包' };"),
  m('P68 ⑥：包类型表给开发完成节点也挂了依赖（与 closeBlockers 不一致）', [HN4], 'plan.js', "  return null;\n}\n\n// 计划写入的两种方式", "  if (node.template_key === 'b_dev') return { type: 'overall', batchId: null, label: '总体规划包' };\n  return null;\n}\n\n// 计划写入的两种方式"),
  // H5 / P70 写入按时刻防倒挂
  m('P70：进行中节点同日收口仍写 00:00:00（closed_at 早于 opened_at）', [HN5, IN], 'history.js', "const closedAt = node.opened_at && String(node.opened_at).slice(0, 10) === date ? node.opened_at : at;", 'const closedAt = at;'),
  m('P70：进行中节点晚于开始日也取 opened_at', [HN5], 'history.js', "const closedAt = node.opened_at && String(node.opened_at).slice(0, 10) === date ? node.opened_at : at;", 'const closedAt = node.opened_at ? node.opened_at : at;'),
  m('P70：任职同日仍写 00:00:00', [IA], 'history.js', 'await membership.activateAppointment(q, user, pid, data, data.sameDayAt || at);', 'await membership.activateAppointment(q, user, pid, data, at);'),
  m('P70：任职不同日也取前任 ended_at', [IA], 'history.js', "AND status = 'ended' AND substr(ended_at, 1, 10) = ? ORDER BY ended_at DESC LIMIT 1\", [a.party_id, date]);", "AND status = 'ended' ORDER BY ended_at DESC LIMIT 1\", [a.party_id]);"),
  m('P70：授权同日仍写 00:00:00', [P68], 'history.js', "Object.assign({}, data, { status: 'pending_accept' }), data.sameDayAt || at);", "Object.assign({}, data, { status: 'pending_accept' }), at);"),
  m('P70：授权不同日也取已撤销授权的 revoked_at', [P68], 'history.js', "AND status = 'revoked' AND substr(revoked_at, 1, 10) = ? ORDER BY revoked_at DESC LIMIT 1\", [d.party_id, date]);", "AND status = 'revoked' ORDER BY revoked_at DESC LIMIT 1\", [d.party_id]);"),
  // MED-1 时钟脱钩（批准事件时间写库固定）本身不是代码变异能测的；这里再补一条：批准日来源取不到平台批准事件时间（共用助手返回旧日期）必须判红
  // ── Q-S2 收尾小修批（K1–K7）──
  m('K1：包类型表把需求确认节点指向立项包（对拍「依赖哪个包」判红）', [HN4], 'plan.js', "if (node.template_key === 'b_req') return { type: 'overall', batchId: null, label: '总体规划包' };", "if (node.template_key === 'b_req') return { type: 'initiation', batchId: null, label: '项目立项包' };"),
  m('K1：包类型表把批次验收包的批次取空（不按本节点批次）', [HN4], 'plan.js', "if (node.template_key === 'b_uat') return { type: 'batch_accept', batchId: node.batch_id, label: '批次验收包' };", "if (node.template_key === 'b_uat') return { type: 'batch_accept', batchId: null, label: '批次验收包' };"),
  m('K3：平台批准且同日仍写 00:00:00（不取批准事件时刻）', [P68], 'history.js', "String(approvedAt).slice(0, 10) === date ? String(approvedAt) : null;", 'false ? String(approvedAt) : null;'),
  m('K3：代录批准的日期（无时刻）也当作同日时刻（去掉长度判断）', [P68], 'history.js', 'String(approvedAt).length >= 19 && String(approvedAt).slice(0, 10) === date', 'String(approvedAt).slice(0, 10) === date'),
  m('K3：批准事件不同日也取批准时刻', [P68], 'history.js', "String(approvedAt).length >= 19 && String(approvedAt).slice(0, 10) === date ? String(approvedAt) : null;", 'String(approvedAt).length >= 19 ? String(approvedAt) : null;'),
  m('K4：总体规划核对立项包生效日退回取当前版本', [HN6], 'history.js', "p.type = 'initiation' AND v.effective_at IS NOT NULL ORDER BY v.effective_at ASC, v.id ASC LIMIT 1", "p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1"),
  m('K4：节点收口核对依赖包生效日退回取当前版本', [HN6], 'history.js', '(? IS NULL OR p.batch_id = ?) AND v.effective_at IS NOT NULL ORDER BY v.effective_at ASC, v.id ASC LIMIT 1', "(? IS NULL OR p.batch_id = ?) AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1"),
  m('K7：历史导入读取不限对象类型', [H1P], 'confirm-core.js', "if (!['appointment', 'delegation', 'package_version', 'node', 'batch'].includes(objectType)) throw internalError('历史导入读取的对象类型未登记');", ''),
  m('K7：历史导入读取的白名单漏 node', [H1P], 'confirm-core.js', "['appointment', 'delegation', 'package_version', 'node', 'batch'].includes(objectType)", "['appointment', 'delegation', 'package_version', 'batch'].includes(objectType)"),
  m('LOW-3：共用助手不取平台批准事件时间（返回固定旧日期）', [P68], 'confirm-core.js', "    return e.created_at;\n  }\n  return null;", "    return '2000-01-01 00:00:00';\n  }\n  return null;"),
];

module.exports = { defineHistoryCases, HISTORY_MUTATIONS };
