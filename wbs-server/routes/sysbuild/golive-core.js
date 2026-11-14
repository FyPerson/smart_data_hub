// routes/sysbuild/golive-core.js — 项目管理（系统建设记录）模块：上线与交接的共用助手（C6a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §3.2（:466–469 上线 / 试运行结束 / 里程碑）、§4.2（:613 交接项确认）、§4.3「上线交接清单」与 v1.5 细则
//   （P106 上线判定、P141–P151）、§4.5（状态机与项目状态 × 动作）、§5.2（:855–857）。派单 = docs/local/系统建设记录/送审准备/C6_C6a_上线交接结项_派单_20261107.md。
//
// 本文件只放「在调用方 withRead / withWriteTxn 回调里用 q 调用」的助手，不注册路由：golive.js（交接 / 上线 / 撤销端点）、plan.js（批次视图、收口前置）、history.js（上线事件导入）、
//   confirm.js（交接确认任务的对象分支）、entries.js（办理动作后让过期的交接确认失效）共用。依赖只有 rules / db / events / confirm-core / entries-core / packages（只取 effectiveOverallVersionId，packages 不依赖本文件），不依赖其余路由文件，避免成环。
//
// 交接集合（P146）= 本项目内、未作废、非已拆分容器的**办理类**（意见与反馈、问题与处理）登记里满足任一条的：(a) 当前去向留项目或转系统迭代且承诺批次含本批（P167），或当前去向留项目且承诺批次为空（P162，进每个批次的集合）；(b) 当前去向待判定；(c) 挂在本批节点上
//   （含里程碑节点上的过程登记、收口后异议补充登记）。已办结的也列出（带状态，用于快照与展示），能否上线只看每项的「已清」。
// 已清（P147）：已办结（entries-core.entryResolved），并且——结论为「业务确认不再处理」（no_further），或当前带风险标记且结论不是「已处理」「已采纳」（阻塞项）——还须有有效的交接确认
//   （每个需求部门的生效代表人各一条任务，全部确认；指纹仍等于当前值才算数）。
// 交接确认任务（P148 / P149）：object_type = handover、object_id = 登记编号、object_version_id = 发起时登记最后一条办理动作的编号（状态指纹）、purpose = handover_accept_issue /
//   handover_no_further、party_id = 需求部门；之后该登记有新的办理动作（或新的判定快照，快照只随办理动作产生）= 指纹变化：未完成的修订置已失效（原因「问题状态已变化」），已确认的也不再算数。
'use strict';
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const entries = require('./entries-core');
const packages = require('./packages'); // 现行总体规划版本的唯一来源（effectiveOverallVersionId）；packages 不依赖本文件，不成环
const notifyCore = require('./notify-core'); // C6b：P174 答复后改发的新修订写发送意图

const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);
const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
  projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
});

const HANDOVER_PURPOSE_OF = Object.freeze({ accept_issue: 'handover_accept_issue', no_further: 'handover_no_further' });
const HANDOVER_PURPOSES = Object.freeze(Object.keys(HANDOVER_PURPOSE_OF).map((k) => HANDOVER_PURPOSE_OF[k]));
const HANDLED_CONCLUSION_KINDS = Object.freeze(['handled', 'adopted']); // 有风险标记也不需要交接确认的两种结论
const HANDOVER_STATE_CHANGED_REASON = '问题状态已变化';
const HANDOVER_REVISION_STATUS_FAILED = Object.freeze(['objected', 'rejected']);

// ── 登记当前去向（取同一次判定的全部行）与状态指纹 ───────────────────────────────────────────────────────────────
// entries-core.currentRoutingOf 只取名下最后一条快照；一次判定可能一个条目一行（承诺批次可以不同），交接集合的「承诺批次含本批」要看这一次判定的全部行：
//   同一登记、同一处理项序号、同一触发动作（首次判定没有触发动作）的行 = 同一次判定。没有快照返回 []。
async function currentRoutingRowsOf(q, entryId) {
  const last = await entries.currentRoutingOf(q, entryId);
  if (!last) return [];
  return q.all(
    `SELECT ${entries.SNAPSHOT_COLS} FROM sysbuild_routing_snapshots WHERE entry_id = ? AND part_no = ? AND trigger_action_id IS ? ORDER BY id`,
    [entryId, last.part_no, last.trigger_action_id]
  );
}
// 该登记最后一条办理动作的编号（没有办理记录为 0）：交接确认的状态指纹（object_version_id）。
async function lastActionIdOf(q, entryId) {
  const r = await q.get('SELECT MAX(id) AS m FROM sysbuild_entry_actions WHERE entry_id = ?', [entryId]);
  return r && r.m !== null && r.m !== undefined ? r.m : 0;
}
// 指纹 versionId 是否仍是该登记的当前状态：没有更新的办理动作，也没有由更新的办理动作触发的判定快照（快照只随办理动作产生，所以后一项是前一项的显式复核，不是第二个来源）。
async function fingerprintIsCurrent(q, entryId, versionId) {
  if ((await lastActionIdOf(q, entryId)) !== versionId) return false;
  const snap = await q.get('SELECT id FROM sysbuild_routing_snapshots WHERE entry_id = ? AND trigger_action_id > ? LIMIT 1', [entryId, versionId]);
  return !snap;
}

// ── 每项的判定（纯函数）────────────────────────────────────────────────────────────────────────────────────────
// 结论种类：当前结论动作是 conclude → 它的 conclusion_kind；是 for_reference → 'for_reference'；没有 → null。
function conclusionKindOf(derived) {
  const cur = derived.current;
  if (!cur) return null;
  if (cur.action === 'conclude') return cur.conclusion_kind;
  return cur.action === 'for_reference' ? 'for_reference' : null;
}
// 需要哪种交接确认（P147）：未办结 → 不需要（先办结）；结论为 no_further → no_further；当前带风险标记且结论不是已处理 / 已采纳 → accept_issue（方案里的「阻塞项」）；其余不需要。
//   两种同时成立（不再处理 + 带风险）取 no_further：业务确认人确认「不再处理」已包含接受该问题不再办理的上线结果，不拆成两条确认。
function handoverNeedOf(derived, resolved) {
  const kind = conclusionKindOf(derived);
  if (!resolved) return { kind, need: null };
  if (kind === 'no_further') return { kind, need: 'no_further' };
  if (derived.risk_current === true && !HANDLED_CONCLUSION_KINDS.includes(kind)) return { kind, need: 'accept_issue' };
  return { kind, need: null };
}
// 交接确认任务的整体状态（纯函数）：valid = 指纹仍是当前的任务 [{ party_id, status（当前修订状态） }]；anyOld = 同用途下有过任务（指纹已过期）；parties = 全部需求部门编号。
//   none（从未发起）｜lapsed（有过任务但指纹已过期，要重新发起）｜declined（有任务被「有异议」或「不认可」）｜confirmed（每个需求部门都有任务且全部已确认）｜
//   incomplete（有任务但还有需求部门没有任务，如发起后新增的需求部门）｜pending（其余：有任务未确认完）。
//   declinedOutstanding（P173，缺省 false；P177 起传「待答复的不认可」= 未解除且还没被答复，replyPending）：为真 → 恒为 declined，不论当前指纹下有没有任务（更正等动作让旧任务过期后仍然）。
//   已答复但被不认可的部门还没重新确认时，最新修订是答复后生成的待确认修订 → pending（该项未清、取消风险 409，由 declineOutstandingOf 另挡）。
function handoverConfirmStateOf(valid, anyOld, parties, declinedOutstanding) {
  if (declinedOutstanding === true) return 'declined';
  if (valid.length === 0) return anyOld ? 'lapsed' : 'none';
  if (valid.some((t) => HANDOVER_REVISION_STATUS_FAILED.includes(t.status))) return 'declined';
  const covered = parties.length > 0 && parties.every((p) => valid.some((t) => t.party_id === p));
  if (!covered) return 'incomplete';
  return valid.every((t) => t.status === 'confirmed') ? 'confirmed' : 'pending';
}

// ── 未解除的不认可（P173）──────────────────────────────────────────────────────────────────────────────────────
// 交接确认被不认可 / 有异议（当前或历史上任一 rejected / objected 的交接修订，不论用途、需求部门）之后，该登记出现**新的结论类动作**（P177 起另有被不认可部门重新确认一条路，见下）——给结论（conclude）、仅供参考
//   （for_reference）、作废（void）、裁定（adjudicate，预留）——才解除；更正、记单号、标 / 取消风险、补选归属等都不解除。「之后」按动作编号判：交接任务只在指纹 = 登记最后一条办理动作编号
//   时才能作决策，所以不认可发生时该登记最后一条动作就是任务的 object_version_id（F），编号大于 F 的动作都晚于这次不认可。返回 true = 还有没解除的不认可。
//   P175（修订批 4）：取消风险标记也不能单方面解除——有未解除的不认可时 entry_unmark_risk 直接 409（entries-core.entryTarget 的 declineOutstanding），不认可只能经代表人重新决定并确认或新的结论类动作解除。
//   LOW-1（修订批 4）：C5 起裁定走确认任务（交负责人裁定 escalate 建裁定任务），不写 adjudicate 这条办理动作（entries.js ADJUDICATE_ACTION_MESSAGE 409），此项为预留；面向用户的文案不再把「裁定」列为出路。
const CONCLUSION_CLASS_ACTIONS = Object.freeze(['conclude', 'for_reference', 'void', 'adjudicate']);
//   P177（修订批 5，主会话裁定，取代 P174 的「答复解除」）：PM 的答复**只解锁「重新发起」，不解除不认可**。一条不认可 / 有异议的修订 r 的解除条件二者之一：
//     (a) 该登记出现新的结论类动作（编号大于 r 所属任务的指纹）；
//     (b) 被不认可的那个需求部门（同一登记、同一 party_id 的交接任务——同一任务的改发链，或指纹过期后按新指纹重建的任务）在 r 之后有一条**已确认**（confirmed）的修订，即代表人重新决定并确认。
//   「未解除的不认可」（outstandingDeclinesOf / declineOutstandingOf：供已清判定、entry_unmark_risk、集合项无任务时的 declined 状态用）**不看答复事件**；任一需求部门还有一条没被 (a)(b) 解除的就算未解除。
//   「待答复的不认可」（unrepliedDeclinesOf / replyPendingOf：供 reply_required、集合项 confirm.state = declined、handover_request 是否要求带答复用）= 未解除的不认可里还没被 handover_replied 事件
//   （payload.replied_revision_ids）答复过的；答复之后代表人再次不认可产生的新修订不在其中，需要再答复。事件只用来判「重新发起是否已带答复」。
async function outstandingDeclinesOf(q, entryId) {
  const rows = await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id, t.party_id AS party_id, t.object_version_id AS fp FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id
      WHERE t.object_type = 'handover' AND t.object_id = ? AND r.status IN (${HANDOVER_REVISION_STATUS_FAILED.map(() => '?').join(', ')}) ORDER BY r.id`,
    [entryId].concat(HANDOVER_REVISION_STATUS_FAILED)
  );
  const out = [];
  for (const r of rows) {
    const lifted = await q.get(
      `SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND id > ? AND action IN (${CONCLUSION_CLASS_ACTIONS.map(() => '?').join(', ')}) LIMIT 1`,
      [entryId, r.fp].concat(CONCLUSION_CLASS_ACTIONS)
    );
    if (lifted) continue; // (a)
    const reconfirmed = await q.get(
      `SELECT c.id AS id FROM sysbuild_confirm_task_revisions c JOIN sysbuild_confirm_tasks t ON t.id = c.task_id
        WHERE t.object_type = 'handover' AND t.object_id = ? AND t.party_id = ? AND c.id > ? AND c.status = 'confirmed' LIMIT 1`,
      [entryId, r.party_id, r.revision_id]
    );
    if (reconfirmed) continue; // (b)
    out.push(r);
  }
  return out;
}
async function declineOutstandingOf(q, entryId) {
  return (await outstandingDeclinesOf(q, entryId)).length > 0;
}
// 被答复过的修订编号集合（handover_replied 事件 payload.replied_revision_ids；坏的事件 JSON 忽略）。
async function repliedRevisionIdsOf(q, entryId) {
  const replied = new Set();
  const evs = await q.all("SELECT payload_json FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'handover_replied'", [entryId]);
  for (const ev of evs) {
    let p = null;
    try { p = JSON.parse(ev.payload_json); } catch (e) { p = null; }
    if (p && Array.isArray(p.replied_revision_ids)) for (const id of p.replied_revision_ids) replied.add(Number(id));
  }
  return replied;
}
// 未解除的不认可里还没被答复的修订（待答复）；outstanding 传入则不重查（调用方已查过）。
async function unrepliedDeclinesOf(q, entryId, outstanding) {
  const rows = outstanding === undefined ? await outstandingDeclinesOf(q, entryId) : outstanding;
  if (rows.length === 0) return [];
  const replied = await repliedRevisionIdsOf(q, entryId);
  const out = [];
  for (const r of rows) {
    if (replied.has(Number(r.revision_id))) continue;
    out.push(r);
  }
  return out;
}

// ── 交接集合 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function demandPartiesOf(q, projectId) {
  return q.all("SELECT id, name FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' ORDER BY sort_order, id", [projectId]);
}
// 一个登记某用途下的交接确认任务（含当前修订状态）：返回 { valid: [{ task_id, party_id, revision_id, status, required_member_id }], anyOld }。
async function handoverTasksOf(q, entryId, purpose, lastActionId) {
  const tasks = await q.all(
    "SELECT id, party_id, object_version_id FROM sysbuild_confirm_tasks WHERE object_type = 'handover' AND object_id = ? AND purpose = ? ORDER BY id",
    [entryId, purpose]
  );
  const snapshotOk = tasks.length === 0 ? true : await fingerprintIsCurrent(q, entryId, lastActionId);
  const valid = [];
  for (const t of tasks) {
    if (t.object_version_id !== lastActionId || !snapshotOk) continue;
    const rev = await core.latestRevision(q, t.id);
    if (!rev) throw internalError('交接确认任务没有修订');
    valid.push({ task_id: t.id, party_id: t.party_id, revision_id: rev.id, status: rev.status, required_member_id: rev.required_member_id });
  }
  return { valid, anyOld: tasks.length > valid.length };
}
// 本批的交接集合（逐项带判定）。parties = demandPartiesOf 的结果（调用方传入，只取一次）。返回按登记编号升序的数组。
async function handoverItemsOf(q, batch, parties) {
  const marks = rules.ENTRY_HANDLED_TYPES.map(() => '?').join(', ');
  const rows = await q.all(
    `SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE project_id = ? AND type IN (${marks}) ORDER BY id`,
    [batch.project_id].concat(rules.ENTRY_HANDLED_TYPES)
  );
  const nodeRows = await q.all('SELECT id FROM sysbuild_nodes WHERE batch_id = ?', [batch.id]);
  const batchNodes = new Set(nodeRows.map((n) => n.id));
  const partyIds = parties.map((p) => p.id);
  const out = [];
  for (const e of rows) {
    const kid = await q.get('SELECT id FROM sysbuild_entries WHERE parent_entry_id = ? LIMIT 1', [e.id]);
    if (kid) continue; // 已拆分容器：由子项判
    const facts = await entries.loadEntryFacts(q, e, { skipChildren: true });
    const d = facts.derived;
    if (d.voided === true) continue;
    const routeRows = await currentRoutingRowsOf(q, e.id);
    const route = routeRows.length > 0 ? routeRows[routeRows.length - 1].route : null;
    const committed = Array.from(new Set(routeRows.map((r) => r.committed_batch_id).filter((x) => x !== null && x !== undefined)));
    const sources = [];
    // P162 / P167：去向留项目或转系统迭代且承诺批次含本批 = 'committed'；去向留项目且承诺批次为空（补选「规划内待细化」「规划外」留项目写出的快照，没有承诺批次）= 'unbatched'，
    //   进每个批次的集合（它没有归属批次，不能因此放任未办结问题随任何一批上线）。转系统迭代的快照不会没有承诺批次以外的归属，规划外转系统迭代不进集合。
    if ((route === 'project' || route === 'sys_iteration') && committed.includes(batch.id)) sources.push('committed');
    if (route === 'project' && committed.length === 0) sources.push('unbatched');
    if (route === 'pending') sources.push('pending');
    if (e.node_id !== null && e.node_id !== undefined && batchNodes.has(e.node_id)) sources.push('node');
    if (sources.length === 0) continue;
    const resolved = entries.entryResolved(d);
    const { kind, need } = handoverNeedOf(d, resolved);
    const lastActionId = await lastActionIdOf(q, e.id);
    // P177：未解除的不认可（不看答复）与待答复的不认可（未解除里还没被答复的）分开：前者挡已清 / 取消风险，后者决定 confirm.state = declined 与 reply_required
    const outstandingDeclines = await outstandingDeclinesOf(q, e.id);
    const declinedOut = outstandingDeclines.length > 0;
    const replyPending = (await unrepliedDeclinesOf(q, e.id, outstandingDeclines)).length > 0;
    let confirm = { purpose: null, state: declinedOut ? 'declined' : 'none', fingerprint: lastActionId, tasks: [] };
    const reasons = [];
    // P173：有未解除的不认可时，即使该项已不再需要确认，也仍未清（须先有新的结论类动作）。P175（修订批 4）：取消风险已被挡住，这里是兜底（例如结论失效后未办结、库内直接改动）；
    //   不再需要确认时答复无效（rules.handover_request），所以文案只列新的结论类动作
    if (declinedOut && need === null) reasons.push('代表人对该登记作出过不认可 / 有异议，该项已不需要交接确认，须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除');
    if (need !== null) {
      const purpose = HANDOVER_PURPOSE_OF[need];
      const { valid, anyOld } = await handoverTasksOf(q, e.id, purpose, lastActionId);
      const state = handoverConfirmStateOf(valid, anyOld, partyIds, replyPending);
      confirm = {
        purpose, state, fingerprint: lastActionId,
        tasks: valid.map((t) => ({ task_id: t.task_id, party_id: t.party_id, revision_id: t.revision_id, status: t.status })),
      };
      if (state !== 'confirmed') reasons.push(need === 'no_further' ? '「业务确认不再处理」还没有全部需求部门代表人确认' : '「接受带此问题上线」还没有全部需求部门代表人确认');
    }
    if (!resolved) reasons.push('还没有办结');
    // 转系统迭代的结论沿用 C5 的必填校验（结论端点已要求单号与承接人）；这里对库内缺字段的数据兜底，不静默放行
    if (resolved && kind === 'to_sys_iteration') {
      const cur = d.current;
      const noNo = typeof cur.sys_issue_no !== 'string' || cur.sys_issue_no.trim() === '';
      const noWho = typeof cur.assignee_text !== 'string' || cur.assignee_text.trim() === '';
      if (noNo || noWho) reasons.push('转系统迭代的结论缺单号或承接人');
    }
    out.push({
      entry_id: e.id, type: e.type, title: e.title, node_id: e.node_id, parent_entry_id: e.parent_entry_id,
      sources, route, committed_batch_ids: committed,
      resolved, conclusion_state: d.conclusion_state, conclusion_kind: kind, risk_current: d.risk_current === true,
      is_blocker: d.risk_current === true && !HANDLED_CONCLUSION_KINDS.includes(kind),
      need_confirm: need, confirm,
      reply_required: confirm.state === 'declined' && need !== null, // P174：确认状态为 declined（未解除的不认可，或当前指纹下有被不认可的任务）——页面要显示答复框；重新发起须带 reply，或先给出新的结论类动作。P175：答复只在仍需交接确认时有效，不需要确认时没有可写的答复（只能给新的结论类动作）
      cleared: reasons.length === 0, reasons,
    });
  }
  return out;
}
const summaryOf = (items) => ({
  total: items.length,
  cleared: items.filter((i) => i.cleared).length,
  uncleared: items.filter((i) => !i.cleared).length,
  need_confirm: items.filter((i) => i.need_confirm !== null).length,
  confirmed: items.filter((i) => i.need_confirm !== null && i.confirm.state === 'confirmed').length,
});

// 发起交接确认的 target 构造（rules.OBJECT_OPS.handover_request；读接口每项 actions.handover_request 与 POST …/handover/requests 共用这一个函数）。
//   item = handoverItemsOf 里该登记的一项，不在集合里传 null；batch = 批次行；parties = demandPartiesOf 的结果。
//   replyGiven（P174）：本次发起带了合法的答复（POST 的 reply；读接口每项 actions.handover_request 传 item.reply_required，即「按页面会带答复」算）。带答复时，被不认可 / 有异议的任务
//   也要重新解析生效代表人（生成新修订），所以缺代表人的判定把它们和还没有任务的参与方一起算。
async function handoverRequestTarget(q, batch, item, parties, replyGiven) {
  if (item === null) return { batchStatus: batch.status, inSet: false };
  const reply = replyGiven === true;
  const covered = new Set(item.confirm.tasks.map((t) => t.party_id));
  const uncovered = parties.filter((p) => !covered.has(p.id));
  const redo = new Set(reply ? item.confirm.tasks.filter((t) => HANDOVER_REVISION_STATUS_FAILED.includes(t.status)).map((t) => t.party_id) : []);
  let confirmersMissing = null;
  if (parties.length === 0) confirmersMissing = { noParty: true, missing: [] };
  else {
    const missing = [];
    for (const p of parties.filter((x) => !covered.has(x.id) || redo.has(x.id))) {
      if (!(await core.currentDelegate(q, p.id))) missing.push(p.name);
    }
    if (missing.length > 0) confirmersMissing = { noParty: false, missing };
  }
  return {
    batchStatus: batch.status, inSet: true, resolved: item.resolved, needKind: item.need_confirm,
    allCovered: parties.length > 0 && uncovered.length === 0,
    confirmState: item.confirm.state,
    replyGiven: reply,
    confirmersMissing,
  };
}

// 项目里有待确认的总体规划或变更包版本？（P164 / P169）：普通上线前置 PLAN_PENDING、上线事件历史导入、plan.js 的排期冻结（P34）共用这一个函数。
async function planPendingOf(q, projectId) {
  const r = await q.get(
    `SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type IN ('overall', 'change') AND v.status = 'pending' LIMIT 1`,
    [projectId]
  );
  return !!r;
}
// 上线前置未满足项（P143 / P144 / P147，读接口 actions.golive 与执行共用）：本批除里程碑外、未取消的节点须全部已收口；本批批次验收包须已生效；交接集合每项已清（按传入的完整集合）。
//   返回 [{ code, message, … }]，空数组 = 满足。
//   only（P178，可选）：只取这些 code 的子集（缺省 = 全部）；上线事件历史导入取 IMPORT_GATE_CODES（PLAN_PENDING + HANDOVER_UNCLEARED），节点前置仍按导入专用规则（P166 / P171），验收包不要求（P52）。
async function goliveBlockersOf(q, batch, items, only) {
  const out = [];
  const want = (code) => only === undefined || only.includes(code);
  if (want('NODES_NOT_CLOSED')) {
    const open = await q.all(
      "SELECT id, name FROM sysbuild_nodes WHERE batch_id = ? AND is_golive_milestone = 0 AND status NOT IN ('closed', 'cancelled') ORDER BY sort_order, id",
      [batch.id]
    );
    if (open.length > 0) out.push({ code: 'NODES_NOT_CLOSED', message: `本批还有未收口的节点：${open.map((n) => n.name).join('、')}`, node_ids: open.map((n) => n.id) });
  }
  if (want('ACCEPT_NOT_EFFECTIVE') || want('ACCEPT_STALE')) {
    const acc = await q.get(
      `SELECT v.id AS id, v.parent_overall_version_id AS parent_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
        WHERE p.batch_id = ? AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1`,
      [batch.id]
    );
    if (!acc) { if (want('ACCEPT_NOT_EFFECTIVE')) out.push({ code: 'ACCEPT_NOT_EFFECTIVE', message: '本批批次验收包还没有生效版本' }); }
    // P168：验收包确认时引用的总体规划版本（parent）必须仍是现行总体规划版本；正式变更换版后，验收包确认的是旧规划，须基于现行规划重新提交并确认（草稿、提交时 parent 都按现行重写）。
    else if (want('ACCEPT_STALE') && acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {
      out.push({ code: 'ACCEPT_STALE', message: '本批批次验收包确认时引用的总体规划已被变更替换，须基于现行总体规划重新提交批次验收并确认' });
    }
  }
  // P164：项目里有待确认的总体规划或变更包版本时不能上线（它生效会换掉验收依据的规划版本）。
  if (want('PLAN_PENDING') && (await planPendingOf(q, batch.project_id))) out.push({ code: 'PLAN_PENDING', message: '项目里有待确认的总体规划或变更，须等确认完成或撤回后再上线' });
  if (want('HANDOVER_UNCLEARED')) {
    const unc = items.filter((i) => !i.cleared);
    if (unc.length > 0) {
      out.push({ code: 'HANDOVER_UNCLEARED', message: `上线交接集合里还有 ${unc.length} 项没有清（登记 ${unc.map((i) => `#${i.entry_id}`).join('、')}）`, entry_ids: unc.map((i) => i.entry_id) });
    }
  }
  return out;
}
// P178（预筛 4 HIGH，取代 P151 的「导入不要求交接已清」）：上线事件历史导入与普通上线共用交接闸门——待确认的规划 / 变更 + 交接集合每项已清；判定就是上面 goliveBlockersOf 的同一函数、同一份交接集合，
//   只取这两个 code。节点前置另按导入专用规则（P166 / P171 b_uat 豁免），验收包不要求（历史项目没有，P52）。返回 blockers 数组（空 = 过闸）。
const IMPORT_GATE_CODES = Object.freeze(['PLAN_PENDING', 'HANDOVER_UNCLEARED']);
async function importGateBlockersOf(q, batch) {
  const parties = await demandPartiesOf(q, batch.project_id);
  const items = await handoverItemsOf(q, batch, parties);
  return goliveBlockersOf(q, batch, items, IMPORT_GATE_CODES);
}

// 批次的交接视图（GET /batches/:bid/handover 与上线快照同源）：{ items, summary, blockers }。
async function handoverViewOf(q, batch) {
  const parties = await demandPartiesOf(q, batch.project_id);
  const items = await handoverItemsOf(q, batch, parties);
  return { parties, items, summary: summaryOf(items), blockers: await goliveBlockersOf(q, batch, items) };
}
// 写进上线事件 handover_snapshot_json 的内容 = 重核时的完整集合及每项判定（与 GET 返回的 items / summary 同一个函数产物）。extra 并入（历史导入写 { history_import: true }）。
const snapshotOf = (view, extra) => JSON.stringify(Object.assign({}, extra || {}, { items: view.items, summary: view.summary }));

// ── 批次视图的上线信息 ─────────────────────────────────────────────────────────────────────────────────────────
// 最后一条上线事件（kind、时刻、操作人、原因）与「是否已正式上线」（entries-core.batchLiveState，唯一判定）。operator_name 取用户显示名。
async function goliveInfoOf(q, batchId) {
  const st = await entries.batchLiveState(q, batchId);
  let last = null;
  if (st.last) {
    const u = await q.get('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [st.last.created_by]);
    last = { id: st.last.id, kind: st.last.kind, at: st.last.created_at, by: st.last.created_by, by_name: u ? u.n : null, reason: st.last.reason };
  }
  return { live: st.live, last_event: last };
}
// 本项目是否有待确认的结项包版本（撤销上线的前置，P150）。
async function closingPendingOf(q, projectId) {
  const r = await q.get(
    "SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'closing' AND v.status = 'pending' LIMIT 1",
    [projectId]
  );
  return !!r;
}
// 项目上线进度（§2.3 :443 / §6.3）：已正式上线的有效批次数 / 有效批次数；转出批次单列；撤销上线按当前有效上线状态计数。返回 { live, total, transferred }。
async function goliveProgressOf(q, projectId) {
  const bs = await q.all('SELECT id, status FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
  let live = 0;
  let total = 0;
  let transferred = 0;
  for (const b of bs) {
    if (b.status === 'superseded') continue;
    if (b.status === 'transferred') { transferred += 1; continue; }
    total += 1;
    if ((await entries.batchLiveState(q, b.id)).live) live += 1;
  }
  return { live, total, transferred };
}

// ── 上线 / 撤销 / 历史导入的写入（同一写事务内）──────────────────────────────────────────────────────────────────
// 实际日期：节点收口自动记的日期（与 plan.js 收口端点同口径）；最后一条实际开始（含更正）。
function lastActualStart(recs) {
  let v = null;
  for (const r of recs) {
    if (r.kind === 'actual_start' || (r.kind === 'actual_correct' && r.corrects_kind === 'actual_start')) v = r.actual_date;
  }
  return v;
}
async function milestoneOf(q, batchId) {
  return q.get(
    'SELECT id, project_id, name, status, opened_at FROM sysbuild_nodes WHERE batch_id = ? AND is_golive_milestone = 1',
    [batchId]
  );
}
// 里程碑节点 → 已收口（P145：未开始或进行中都可；照节点收口端点的做法记实际结束，写节点事件）。o：{ dateStr（实际日期）、atText（收口 / 开始时刻文本，缺省 = 此刻）、via、goliveEventId }。
async function closeMilestoneForGolive(q, user, projectId, batchId, o) {
  const node = await milestoneOf(q, batchId);
  if (!node) throw internalError('批次没有正式上线里程碑节点');
  const at = o.atText === undefined ? null : o.atText;
  if (node.status === 'in_progress') {
    const recs = await q.all("SELECT kind, actual_date, corrects_kind FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start', 'actual_correct') ORDER BY id", [node.id]);
    const start = lastActualStart(recs);
    if (start !== null && start > o.dateStr) throw stateError('里程碑节点的实际开始晚于上线日期，请先更正实际开始');
    const r = await q.run(
      "UPDATE sysbuild_nodes SET status = 'closed', closed_at = COALESCE(?, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'in_progress'",
      [at, node.id]
    );
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
  } else if (node.status === 'not_started') {
    const r = await q.run(
      "UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(?, datetime('now','localtime')), closed_at = COALESCE(?, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'",
      [at, at, node.id]
    );
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
    await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [node.id, o.dateStr, Number(user.id)]);
  } else {
    throw stateError('正式上线里程碑节点的状态不允许上线');
  }
  await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [node.id, o.dateStr, Number(user.id)]);
  await emit(q, user, projectId, 'node', node.id, 'node_closed', { actual_date: o.dateStr, via: o.via, golive_event_id: o.goliveEventId, from: node.status });
  return node.id;
}
// 上线事件落库 + 批次 进行中 → 已上线（条件更新）+ 里程碑节点收口 + 事件。o：{ batch, kind（golive / regolive）, snapshotJson, dateStr, createdAt（上线事件时刻，null = 此刻；历史导入写原日期 00:00:00）,
//   milestoneAt（里程碑节点的收口 / 开始时刻，null = 此刻；历史导入与原日期同日的 opened_at 取 opened_at，防 closed_at 早于 opened_at，同 history.js applyNode）, via }。
//   返回 { goliveEventId, milestoneNodeId }。调用方负责权限 / 状态 / 前置（golive.js 端点按当时完整集合重核；历史导入只核自己的前置）。
async function recordGolive(q, user, o) {
  const b = o.batch;
  const uid = Number(user.id);
  const ins = o.createdAt === null || o.createdAt === undefined
    ? await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by) VALUES (?, ?, ?, ?)', [b.id, o.kind, o.snapshotJson, uid])
    : await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, handover_snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [b.id, o.kind, o.snapshotJson, uid, o.createdAt]);
  const up = await q.run('UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['live', b.id, 'active']);
  if (up.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
  const milestoneNodeId = await closeMilestoneForGolive(q, user, b.project_id, b.id, { dateStr: o.dateStr, atText: o.milestoneAt === null ? undefined : o.milestoneAt, via: o.via, goliveEventId: ins.lastID });
  await emit(q, user, b.project_id, 'batch', b.id, 'golive_recorded', { kind: o.kind, golive_event_id: ins.lastID, via: o.via, milestone_node_id: milestoneNodeId });
  await emit(q, user, b.project_id, 'batch', b.id, 'batch_status_changed', { from: 'active', to: 'live', via: o.via, golive_event_id: ins.lastID });
  return { goliveEventId: ins.lastID, milestoneNodeId };
}
// 撤销上线（用户已拍板 T-D3）：revoke 事件（只追加）+ 批次 已上线 → 进行中 + 里程碑 已收口 → 进行中（写节点事件）；本批其他已收口节点不动（需要时 PM 按 D45 重开）。
async function recordRevoke(q, user, batch, reason) {
  const uid = Number(user.id);
  const ins = await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, reason, created_by) VALUES (?, ?, ?, ?)', [batch.id, 'revoke', reason, uid]);
  const up = await q.run('UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['active', batch.id, 'live']);
  if (up.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
  const node = await milestoneOf(q, batch.id);
  if (!node) throw internalError('批次没有正式上线里程碑节点');
  if (node.status === 'closed') {
    const r = await q.run("UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'", [node.id]);
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
    await emit(q, user, batch.project_id, 'node', node.id, 'node_reopened', { reason, via: 'revoke_golive', golive_event_id: ins.lastID });
  }
  await emit(q, user, batch.project_id, 'batch', batch.id, 'golive_revoked', { golive_event_id: ins.lastID, reason, milestone_node_id: node.id });
  await emit(q, user, batch.project_id, 'batch', batch.id, 'batch_status_changed', { from: 'live', to: 'active', via: 'revoke_golive', golive_event_id: ins.lastID });
  return { goliveEventId: ins.lastID, milestoneNodeId: node.id };
}

// ── 交接确认任务 ───────────────────────────────────────────────────────────────────────────────────────────────
// 发起（写事务内；调用方已用 rules.assertOp('handover_request') 判过权限 / 状态 / 前置）：给还没有当前任务的需求部门各建一条任务（确认人 = 该方生效代表人），先冻结登记附件
//   （与结论任务共用 entries-core.ensureEntryFrozen 的一份清单）。返回新任务 [{ task_id, revision_id, party_id, required_member_id, proxy_only }]。
async function createHandoverTasks(q, user, attachmentHelpers, entry, item, parties) {
  const covered = new Set(item.confirm.tasks.map((t) => t.party_id));
  const purpose = HANDOVER_PURPOSE_OF[item.need_confirm];
  if (!purpose) throw internalError('交接确认用途未登记');
  await entries.ensureEntryFrozen(q, attachmentHelpers, user, entry);
  const made = [];
  for (const p of parties) {
    if (covered.has(p.id)) continue;
    const dlg = await core.currentDelegate(q, p.id);
    if (!dlg) throw stateError(`${p.name}缺少生效代表人，无法发起交接确认`);
    const t = await core.createTaskWithRevision(q, user, {
      projectId: entry.project_id, objectType: 'handover', objectId: entry.id, objectVersionId: item.confirm.fingerprint, purpose, partyId: p.id,
      requiredMemberId: dlg.memberId, basisAppointmentId: null, basisDelegationId: dlg.delegationId,
    });
    made.push({ task_id: t.taskId, revision_id: t.revisionId, party_id: p.id, required_member_id: dlg.memberId, proxy_only: dlg.proxyOnly === true });
  }
  return made;
}
// P174 答复后重新发起（写事务内；调用方已用 rules.assertOp('handover_request') 判过，replyGiven = true）：
//   ① 写 handover_replied 事件（挂在登记上；payload = { entry_id, batch_id, replied_revision_ids（被答复的、当时还没被答复的不认可修订）, reply }）——答复的留痕，也是 unrepliedDeclinesOf（待答复）的判据；P177：答复**不**解除不认可，只解锁重新发起；
//   ② 当前指纹下被不认可 / 有异议的任务（同一任务）各生成新修订（rev_no + 1，重新解析该参与方当前的生效代表人，写 confirm_task_reissued，reason = 答复，via = handover_reply）——
//      与手工改发同一张修订表、同一种事件；已确认 / 待确认的任务不动。指纹已过期的旧任务不再算数，由随后的 createHandoverTasks 按当前指纹给没有任务的参与方建新任务。
//   返回 { eventId, reissued: [{ task_id, revision_id, party_id, required_member_id, proxy_only }] }。
async function recordHandoverReply(q, user, batch, entry, item, reply) {
  const unreplied = await unrepliedDeclinesOf(q, entry.id);
  const ev = await emit(q, user, entry.project_id, 'entry', entry.id, 'handover_replied', {
    entry_id: entry.id, batch_id: batch.id, replied_revision_ids: unreplied.map((r) => r.revision_id), reply,
  });
  const reissued = [];
  const links = []; // J1（27-R M1）：本次答复生成的每条修订与被答复修订的对应，写进 handover_requested 事件（answerLinksOf）
  for (const t of item.confirm.tasks) {
    if (!HANDOVER_REVISION_STATUS_FAILED.includes(t.status)) continue;
    const dlg = await core.currentDelegate(q, t.party_id);
    if (!dlg) throw stateError('该参与方当前没有生效代表人，无法重新发起交接确认');
    const prev = await core.latestRevision(q, t.task_id);
    const revNo = prev.rev_no + 1;
    const ins = await q.run(
      "INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, created_by) VALUES (?, ?, ?, NULL, ?, 'pending', ?)",
      [t.task_id, revNo, dlg.memberId, dlg.delegationId, Number(user.id)]
    );
    await emit(q, user, entry.project_id, 'confirm_task', t.task_id, 'confirm_task_reissued', {
      revision_id: ins.lastID, previous_revision_id: prev.id, rev_no: revNo, required_member_id: dlg.memberId,
      basis_appointment_id: null, basis_delegation_id: dlg.delegationId, reason: reply, via: 'handover_reply',
    });
    await notifyCore.enqueueRevisionIntent(q, { projectId: entry.project_id, revisionId: ins.lastID, requiredMemberId: dlg.memberId, reissue: true }); // C6b：P174 答复后改发的新修订，必需确认人收到发送意图
    reissued.push({ task_id: t.task_id, revision_id: ins.lastID, party_id: t.party_id, required_member_id: dlg.memberId, proxy_only: dlg.proxyOnly === true });
    links.push({ kind: 'reissued', task_id: t.task_id, revision_id: ins.lastID, party_id: t.party_id, replied_revision_id: prev.id });
  }
  return { eventId: ev.lastID, reissued, unreplied, links };
}
// J1（27-R M1，修订批 7）：带答复的那次重新发起写进 handover_requested 事件的关联 payload——reply_event_id = 本次 handover_replied 事件编号；reply_links = 本次**新建**（kind created，指纹过期后
//   按新指纹给没有当前任务的参与方建的）与**改发**（kind reissued，被不认可的任务生成的新修订）的 { kind, task_id, revision_id, party_id, replied_revision_id }（replied_revision_id = 该部门被答复的那条不认可修订，
//   新建的任务取本次被答复的、该部门最近一条不认可修订，没有为 null）。replied = recordHandoverReply 的返回，made = createHandoverTasks 的返回；没带答复为 { reply_event_id: null, reply_links: [] }。
function answerLinksOf(replied, made) {
  if (!replied) return { reply_event_id: null, reply_links: [] };
  const links = replied.links.slice();
  for (const t of made) {
    const mine = replied.unreplied.filter((r) => r.party_id === t.party_id).map((r) => r.revision_id);
    links.push({ kind: 'created', task_id: t.task_id, revision_id: t.revision_id, party_id: t.party_id, replied_revision_id: mine.length > 0 ? Math.max(...mine) : null });
  }
  return { reply_event_id: replied.eventId, reply_links: links };
}
// 登记有新的办理动作之后（entries.js 在办理动作写入后调用）：该登记未完成的交接确认修订 → 已失效（原因「问题状态已变化」）；已确认的不动（判「已清」时按指纹不再算数）。返回被失效的修订编号。
async function invalidateStaleHandoverRevisions(q, user, entry) {
  const last = await lastActionIdOf(q, entry.id);
  const rows = await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id, t.object_version_id AS object_version_id, t.purpose AS purpose FROM sysbuild_confirm_task_revisions r
       JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.object_type = 'handover' AND t.object_id = ? AND r.status = 'pending' AND t.object_version_id <> ? ORDER BY r.id`,
    [entry.id, last]
  );
  for (const row of rows) {
    await core.closePendingRevision(q, row.revision_id, 'invalid', HANDOVER_STATE_CHANGED_REASON);
    await emit(q, user, entry.project_id, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {
      revision_id: row.revision_id, object_type: 'handover', object_version_id: row.object_version_id, reason: HANDOVER_STATE_CHANGED_REASON, entry_id: entry.id,
    });
  }
  return rows.map((r) => r.revision_id);
}
// 交接确认任务的对象（confirm.js loadObject 用）。返回 null = 登记不存在。pending（decide 的 objectPending）= 指纹仍是当前状态（登记作废会产生新的办理动作，指纹随之过期）；
//   status：pending（指纹有效，可决策 / 改发）／ stale（登记状态已变化，任务作废）。
async function loadHandoverTaskObject(q, task) {
  const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [task.object_id]);
  if (!entry) return null;
  let current = await fingerprintIsCurrent(q, entry.id, task.object_version_id);
  if (current) {
    // LOW-1：指纹没变，登记的派生状态也可能变了而没有新办理动作（例如变更撤回让「转正式变更」结论派生为失效）——「当前已办结」且「所需用途 = 任务用途」才算对象仍是发起时的样子，
    //   否则视为对象已变化（修订不能再被确认，也不能改发）。
    const facts = await entries.loadEntryFacts(q, entry, { skipChildren: true });
    //   handoverNeedOf 在未办结时恒返回 need = null，所以「当前已办结」已包含在 need !== null 里；用途与任务用途相等再核一次（用途只随结论 / 风险标记变，它们变了指纹也变，这里是显式复核）。
    const need = handoverNeedOf(facts.derived, entries.entryResolved(facts.derived)).need;
    current = need !== null && HANDOVER_PURPOSE_OF[need] === task.purpose;
  }
  return { entry, pending: current, status: current ? 'pending' : 'stale' };
}
// ── PM 答复的只读视图（codex 27 M1，修订批 6）──────────────────────────────────────────────────────────────────
// 该登记的答复历史（handover_replied 事件，按事件编号升序）：[{ event_id, text（答复原文）, by（操作人用户编号）, by_name, at（事件时刻）, batch_id, replied_revision_ids }]。只读，不改任何状态与指纹。
async function repliesOf(q, entryId) {
  const evs = await q.all(
    "SELECT id, payload_json, operator_id, operator_name, created_at FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'handover_replied' ORDER BY id",
    [entryId]
  );
  return evs.map((ev) => {
    let p = null;
    try { p = JSON.parse(ev.payload_json); } catch (e) { p = null; }
    return {
      event_id: ev.id, text: p && typeof p.reply === 'string' ? p.reply : null, by: ev.operator_id, by_name: ev.operator_name, at: ev.created_at,
      batch_id: p && p.batch_id !== undefined ? p.batch_id : null,
      replied_revision_ids: p && Array.isArray(p.replied_revision_ids) ? p.replied_revision_ids.map(Number) : [],
    };
  });
}
// 与任务当前修订关联的答复，三层解析（J1 / 27-R M1，修订批 7）：
//   ① 重新发起事件里的直接关联：带答复的 handover_requested 事件 payload.reply_links 里有 revision_id = 当前修订 → 取 reply_event_id 对应的答复，replied_revision_id 取映射里记的
//      （覆盖指纹过期后按新指纹新建的任务，answerLinksOf 写入）；
//   ② 改发事件链：当前修订是因答复生成的（confirm_task_reissued，via = handover_reply，payload.revision_id = 当前修订）→ 答复 = replied_revision_ids 含 previous_revision_id 的那条；
//   ③ 回退（答复后又被 PM 手工改发，前两层都找不到）：沿同一任务的修订链继承上一条修订解析出的答复（replyByTaskChain），递归到任务第一条修订为止。
//   都找不到（首次发起 / 没有答复过的部门）→ null。replies = repliesOf 的结果。返回 { …该次答复, replied_revision_id }。
async function replyOfRevision(q, entryId, taskId, revisionId, replies) {
  const reqs = await q.all("SELECT payload_json FROM sysbuild_events WHERE object_type = 'entry' AND object_id = ? AND event_type = 'handover_requested' ORDER BY id", [entryId]);
  let link = null;
  let linkEventId = null;
  for (const ev of reqs) {
    let p = null;
    try { p = JSON.parse(ev.payload_json); } catch (e) { p = null; }
    if (!p || p.reply_event_id === null || p.reply_event_id === undefined || !Array.isArray(p.reply_links)) continue;
    for (const l of p.reply_links) {
      if (l && Number(l.revision_id) === Number(revisionId)) { link = l; linkEventId = Number(p.reply_event_id); }
    }
  }
  if (link !== null) {
    const linked = replies.find((r) => r.event_id === linkEventId);
    if (linked) return Object.assign({}, linked, { replied_revision_id: link.replied_revision_id === undefined ? null : link.replied_revision_id });
  }
  const evs = await q.all("SELECT payload_json FROM sysbuild_events WHERE object_type = 'confirm_task' AND object_id = ? AND event_type = 'confirm_task_reissued' ORDER BY id", [taskId]);
  let prev = null;
  let reason = null;
  for (const ev of evs) {
    let p = null;
    try { p = JSON.parse(ev.payload_json); } catch (e) { p = null; }
    if (p && p.via === 'handover_reply' && Number(p.revision_id) === Number(revisionId)) { prev = Number(p.previous_revision_id); reason = p.reason; }
  }
  if (prev === null) return replyByTaskChain(q, entryId, taskId, revisionId, replies);
  const hit = replies.filter((r) => r.replied_revision_ids.includes(prev)).pop();
  if (!hit) return { event_id: null, text: typeof reason === 'string' ? reason : null, by: null, by_name: null, at: null, batch_id: null, replied_revision_ids: [prev], replied_revision_id: prev };
  return Object.assign({}, hit, { replied_revision_id: prev });
}
// 第 ③ 层回退（C6b 残余⑦，取代按需求部门找最近一条不认可修订的做法）：沿**同一任务**的修订链继承——当前修订是手工改发出来的（没有映射、也不是因答复生成），
//   就取同一任务上一条修订（rev_no - 1）按 ① ② 解析出的答复，上一条也找不到就继续往前，递归到该任务第一条修订为止；第一条修订（rev_no = 1）没有上一条，返回 null
//   （首次发起或按新指纹新建的未带答复任务不套用任何旧答复；上一轮不认可已解除后，新一轮任务被手工改发，也不会挂出上一轮的答复，因为链不跨任务）。
async function replyByTaskChain(q, entryId, taskId, revisionId, replies) {
  const cur = await q.get('SELECT rev_no FROM sysbuild_confirm_task_revisions WHERE id = ? AND task_id = ?', [revisionId, taskId]);
  if (!cur) return null;
  const before = await q.get('SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ? AND rev_no = ?', [taskId, cur.rev_no - 1]); // 第一条修订（rev_no = 1）没有上一条
  if (!before) return null;
  return replyOfRevision(q, entryId, taskId, before.id, replies);
}
// 交接集合每项的最近一次答复（文字、答复人、时间）；没有答复为 null。
async function lastReplyOf(q, entryId) {
  const all = await repliesOf(q, entryId);
  if (all.length === 0) return null;
  const r = all[all.length - 1];
  return { event_id: r.event_id, text: r.text, by: r.by, by_name: r.by_name, at: r.at };
}
// 确认页的对象内容：登记原文、结论原文、风险标记、需要的交接确认种类（接受带此问题上线 / 不再处理）、指纹是否仍有效；
//   current_reply = 与当前修订关联的 PM 答复（代表人重新决定时要看到 PM 如何回应上一次不认可；当前修订不是因答复生成的为 null），reply_history = 该登记全部答复（按时间）。
async function handoverTaskObjectView(q, task, obj) {
  const e = obj.entry;
  const facts = await entries.loadEntryFacts(q, e, { skipChildren: true });
  const d = facts.derived;
  const cur = d.current;
  const replies = await repliesOf(q, e.id);
  const latest = await core.latestRevision(q, task.id);
  const currentReply = latest ? await replyOfRevision(q, e.id, task.id, latest.id, replies) : null;
  return {
    current_reply: currentReply,
    reply_history: replies,
    type: 'handover',
    purpose: task.purpose,
    entry: {
      id: e.id, project_id: e.project_id, node_id: e.node_id, type: e.type, purpose: e.purpose, title: e.title, body: e.body, business_date: e.business_date,
      period: e.period, days_after_close: e.days_after_close, source_party_id: e.source_party_id, operator_user_id: e.operator_user_id,
      commitment_current: d.commitment_current, risk_current: d.risk_current,
      no_written_evidence: e.no_written_evidence === 1, no_evidence_reason: e.no_evidence_reason, created_at: e.created_at,
    },
    conclusion: cur ? {
      action_id: cur.id, kind: conclusionKindOf(d), text: cur.text, sys_issue_no: cur.sys_issue_no, assignee_text: cur.assignee_text, created_at: cur.created_at, created_by: cur.created_by,
    } : null,
    conclusion_state: d.conclusion_state,
    fingerprint_current: obj.pending,
  };
}

module.exports = {
  HANDOVER_PURPOSE_OF, HANDOVER_PURPOSES, HANDOVER_STATE_CHANGED_REASON,
  currentRoutingRowsOf, lastActionIdOf, fingerprintIsCurrent, conclusionKindOf, handoverNeedOf, handoverConfirmStateOf, declineOutstandingOf, outstandingDeclinesOf, unrepliedDeclinesOf, recordHandoverReply,
  demandPartiesOf, handoverItemsOf, summaryOf, handoverRequestTarget, planPendingOf, goliveBlockersOf, importGateBlockersOf, IMPORT_GATE_CODES, handoverViewOf, snapshotOf,
  goliveInfoOf, closingPendingOf, goliveProgressOf, milestoneOf, closeMilestoneForGolive, recordGolive, recordRevoke,
  createHandoverTasks, invalidateStaleHandoverRevisions, loadHandoverTaskObject, handoverTaskObjectView, repliesOf, lastReplyOf, answerLinksOf,
};
