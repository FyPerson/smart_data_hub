// routes/sysbuild/entries-core.js — 项目管理（系统建设记录）模块：登记与办理的共用助手（C5 S-S1a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记、办理结论的确认、仅供参考）、§4.2「办理结论」「异议裁定」两行、
//   §5.2、§6.3（登记当前状态 = 办理记录 + 确认任务状态，派生不存储）。派单 = docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md。
//
// 本文件只放「在调用方 withRead / withWriteTxn 回调里用 q 调用」的助手，不注册路由：entries.js（登记 / 办理 / 知会端点）与 confirm.js（结论确认 / 裁定任务的对象分支）共用。
//   依赖只有 rules / db / events / confirm-core，不依赖 entries.js / confirm.js，避免成环。
// 状态一律派生：登记当前结论状态、涉及承诺与风险的当前值都不落列，由 deriveEntryState（纯函数）按办理记录 + 结论 / 裁定任务当前修订 + 最新一条仅供参考知会的异议归并。
'use strict';
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');

const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
  projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
});

const ENTRY_COLS = `id, project_id, node_id, type, purpose, commitment_flag, commitment_flag_source, is_risk, source_party_id, source_name, operator_user_id,
  operator_identity_snapshot, period, days_after_close, business_date, title, body, no_written_evidence, no_evidence_reason, parent_entry_id, objects_entry_id, revision_of_entry_id, created_at`;
const SNAPSHOT_COLS = 'id, entry_id, part_no, overall_package_version_id, item_version_id, committed_batch_id, golive_event_id, decided_at, trigger_action_id, route, basis_category';
const ACTION_COLS = 'id, entry_id, action, conclusion_kind, basis_kind, basis_ref, text, sys_issue_no, assignee_text, change_id, created_by, created_at';
const SUPERSEDED_BY_NEW_CONCLUSION = 'PM 已改结论';
const ENTRY_VOIDED_REASON = '登记已作废';
// M-c：项目已终止时 PM 以「项目已终止」结论从裁定中收尾，待确认的裁定修订 → superseded 的原因
const ESCALATED_CLOSED_BY_TERMINATION_REASON = '项目已终止，PM 以项目已终止结论关闭';

// ── 时段（方案 §4.1「登记时段由系统判定」）─────────────────────────────────────────────────────
// 天数差（按日期，后者减前者，不为负）：from / to 的前 10 位必须是 YYYY-MM-DD，否则 500（库内时间戳形态异常不静默当 0）。
function daysBetween(fromDate, toDate) {
  const f = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromDate));
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(toDate));
  if (!f || !t) throw internalError('日期形态异常，无法计算收口后天数');
  const ms = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3])) - Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3]));
  return Math.max(0, Math.round(ms / 86400000));
}
// 项目整体已终止 / 已结项的日期（P92 / P95）：项目没有终止 / 结项时刻列（结项只由 C6 整体结项节点收口产生，C6 未做），取「项目状态改为 toStatus」的最后一条事件时刻
//   （终止后重开又终止，以最后一次为准）；没有这样的事件（夹具直接写库）时取项目 updated_at。
async function projectEndedOn(q, projectId, toStatus) {
  const evs = await q.all("SELECT created_at, payload_json FROM sysbuild_events WHERE object_type = 'project' AND object_id = ? AND event_type = 'project_status_changed' ORDER BY id DESC", [projectId]);
  for (const e of evs) {
    let to = null;
    try { to = (JSON.parse(e.payload_json) || {}).to; } catch (_) { to = null; }
    if (to === toStatus) return e.created_at;
  }
  const p = await q.get('SELECT updated_at FROM sysbuild_projects WHERE id = ?', [projectId]);
  if (!p) throw internalError('项目不存在，无法计算终止 / 结项日期');
  return p.updated_at;
}
// 关联项目整体时按项目是否已「结束」判补充登记：已终止、已结项（P95，方案 §4.1「关联项目整体的，以项目是否已结项判定」，终止后同样不再有进行中的过程）。
const PROJECT_ENDED_STATUSES = Object.freeze(['terminated', 'closed']);
// 返回 { period, days }：关联节点 → 节点已收口 = 补充登记（收口后第 days 天，登记日 − 节点收口日，按服务器本地日期）；关联项目整体（node 为 null）→ 项目已终止 / 已结项 = 补充登记（天数按终止 / 结项日）。
//   判定结果在登记时固化进登记行，之后节点重开或再收口都不改写。today 由调用方注入（todayProvider）。
async function decideEntryPeriod(q, project, node, today) {
  if (node !== null) {
    if (node.status !== 'closed') return { period: 'process', days: null };
    if (typeof node.closed_at !== 'string') throw internalError('已收口的节点缺少收口时刻');
    return { period: 'supplement', days: daysBetween(node.closed_at, today) };
  }
  if (!PROJECT_ENDED_STATUSES.includes(project.status)) return { period: 'process', days: null };
  return { period: 'supplement', days: daysBetween(await projectEndedOn(q, project.id, project.status), today) };
}

// ── 登记人身份快照（登记时固化）──────────────────────────────────────────────────────────────────
// 方案 §4.1：确认人按信息来源方定，PM 代登与「本人提出」要能事后区分——快照记操作时身份（是否 admin / PM / 本方负责人 / 代表人 / 信息技术部内部成员，及成员编号、参与方编号）。
//   信息技术部内部成员 = 已加入未移出、没有参与方、不是 PM 的成员行。identity 来自 rules.completeIdentity。
function operatorSnapshotOf(identity) {
  const partyId = identity.partyId === undefined ? null : identity.partyId;
  return {
    is_admin: identity.isAdmin === true,
    is_pm: identity.isPm === true,
    is_owner: partyId !== null && Array.isArray(identity.ownerOfParties) && identity.ownerOfParties.includes(partyId),
    is_delegate: partyId !== null && Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(partyId),
    is_internal: identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined && partyId === null,
    member_id: identity.memberId === undefined ? null : identity.memberId,
    party_id: partyId,
  };
}
function parseSnapshot(entry) {
  try {
    const s = JSON.parse(entry.operator_identity_snapshot);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch (_) { return {}; }
}

// ── 确认人解析（方案 §4.2「办理结论」行，D30；单一函数：读接口、conclude / for_reference 执行、改发共用）──────────────────────────
// 返回 { kind, partyId, memberId, appointmentId, delegationId, proxyOnly, reason }：
//   none        来源方为空——登记人是 PM（本人登记）/ 信息技术部内部成员 / admin 非成员：不需要确认（reason = pm / internal / admin）
//   owner       来源方是需求方 / 开发方，且登记人本人（非 PM 代登）**登记时**就是该方负责人（身份快照 is_owner 为真、快照参与方 = 来源方），**此刻**仍是该方现任负责人：
//               负责人本人确认（专用权限，只用于本人提出的登记，不扩展为负责人代行代表人的业务确认；P93：登记后才被任命的、登记时是负责人后来卸任的，都走代表人）
//   delegate    其余：该方生效代表人
//   unavailable 需要代表人而该方暂无生效代表人：fail-closed，conclude / for_reference 拒绝 409（负责人不代行代表人的业务确认）
//   确认人可以是无账号成员（proxyOnly = true，只能由 PM 代录，C4b Q-D1 口径）。
async function resolveConclusionConfirmer(q, entry) {
  if (entry.source_party_id === null || entry.source_party_id === undefined) {
    const s = parseSnapshot(entry);
    return { kind: 'none', partyId: null, memberId: null, appointmentId: null, delegationId: null, proxyOnly: false, reason: s.is_pm === true ? 'pm' : (s.is_internal === true ? 'internal' : 'admin') };
  }
  const partyId = entry.source_party_id;
  const party = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [partyId, entry.project_id]);
  if (!party) throw internalError('登记的来源方不属于本项目');
  const snap = parseSnapshot(entry);
  const owner = await core.currentOwner(q, partyId);
  if (owner && snap.is_pm !== true && snap.is_owner === true && snap.party_id === partyId) {
    const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [owner.memberId]);
    if (m && m.user_id !== null && Number(m.user_id) === Number(entry.operator_user_id)) {
      return { kind: 'owner', partyId, memberId: owner.memberId, appointmentId: owner.appointmentId, delegationId: null, proxyOnly: owner.proxyOnly, reason: null };
    }
  }
  const dlg = await core.currentDelegate(q, partyId);
  if (dlg) return { kind: 'delegate', partyId, memberId: dlg.memberId, appointmentId: null, delegationId: dlg.delegationId, proxyOnly: dlg.proxyOnly, reason: null };
  return { kind: 'unavailable', partyId, memberId: null, appointmentId: null, delegationId: null, proxyOnly: false, reason: null };
}
// 交负责人裁定的必需确认人 = 来源方现任负责人。返回 { state: ok / missing / proxy_only, owner }（规则层 entry_escalate 据 state 判）。
async function resolveAdjudicator(q, entry) {
  if (entry.source_party_id === null || entry.source_party_id === undefined) return { state: 'missing', owner: null };
  const owner = await core.currentOwner(q, entry.source_party_id);
  if (!owner) return { state: 'missing', owner: null };
  return { state: owner.proxyOnly ? 'proxy_only' : 'ok', owner };
}
async function memberNameOf(q, memberId) {
  const m = await q.get(
    'SELECT COALESCE(u.display_name, u.username, m.person_name) AS name FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?',
    [memberId]
  );
  return m ? m.name : null;
}
// 读接口的确认人展示（resolveConclusionConfirmer 的结果 + 姓名 / 身份文字）
async function confirmerView(q, conf) {
  const out = { kind: conf.kind, member_id: conf.memberId, name: null, role: null, proxy_only: conf.proxyOnly === true, text: null };
  if (conf.kind === 'none') out.text = '不需要';
  else if (conf.kind === 'unavailable') out.text = '暂无代表人';
  else {
    out.name = await memberNameOf(q, conf.memberId);
    out.role = conf.kind === 'owner' ? '负责人' : '代表人';
    out.text = `${out.role}${out.name ? `：${out.name}` : ''}`;
  }
  return out;
}

// ── 登记当前状态派生（纯函数）──────────────────────────────────────────────────────────────────
// 入参：entry（commitment_flag / is_risk 初始值）、actions（按编号升序的办理记录）、revisionStatusOfAction（普通对象：结论动作 / 交裁定动作的编号 → 其确认任务当前修订的状态；
//   没有任务的结论动作不在其中 = 不需要确认）、latestRefObjected（最新一条仅供参考知会是否已被异议）。不用 Map：静态守卫 S5 对 `.get(` 接收者只认 q。
//   结论动作 → 状态：无任务 = 已确定（不需确认）；修订 pending / confirmed / objected = 待确认 / 已确认 / 有异议；
//   交裁定动作 → 状态：pending / confirmed / rejected = 裁定中 / 裁定通过 / 裁定未通过。
//   superseded / invalid 的修订只会出现在已被后续动作覆盖（或登记已作废）的结论上，不会是最终状态——最终状态落在这样的修订上说明库内数据自相矛盾，500。
const CONCLUDE_STATE_OF_REVISION = Object.freeze({ pending: 'pending_confirm', confirmed: 'confirmed', objected: 'objected', superseded: null, invalid: null });
const ADJUDICATE_STATE_OF_REVISION = Object.freeze({ pending: 'escalated', confirmed: 'adjudicated', rejected: 'adjudication_rejected', superseded: null, invalid: null });
//   projectStatus（项目当前状态，M-b）：「项目已终止」结论（conclusion_kind = project_terminated，不需确认）只在项目当前状态为 terminated 时算有效结论；项目重开 / 不是已终止时
//   最终状态为 terminated_conclusion_lapsed（不属有效结论集合，PM 须重新给结论）。项目再次终止后又恢复有效。缺失（非文本）按库内数据自相矛盾抛 500。
//   changeStatusOf（预筛 Q4，可选，普通对象：变更编号 → 变更状态）：结论为「转正式变更」（conclusion_kind = to_change，带 change_id）且所挂变更已撤回（withdrawn）时，有效的结论落到 to_change_lapsed
//   （不属有效结论、属可再给结论的状态，与 terminated_conclusion_lapsed 同模式；收口前置算未结）。未传 / 没有该变更的状态按「没撤回」处理。
//   修订批 3 L6（P135）：裁定通过（adjudicated）不可逆，不受变更撤回影响——to_change 结论经负责人裁定通过后，所挂变更再被撤回也不落到 to_change_lapsed（失效只作用于已确定 / 已确认两种状态，
//   下面的失效条件不含 adjudicated；裁定通过后再给结论 / 作废本就 409，所以这条结论不会被「变更撤回」悄悄替换）。
function deriveEntryState(entry, actions, revisionStatusOfAction, latestRefObjected, projectStatus, changeStatusOf) {
  if (typeof projectStatus !== 'string') throw internalError('派生登记状态缺项目当前状态');
  let voided = false;
  let commitment = entry.commitment_flag === 1;
  let risk = entry.is_risk === 1;
  let state = 'none';
  let current = null;
  let pendingResolved = true; // 最终状态是否已落在有效的映射上（false = 落在 superseded / invalid 的修订上）
  for (const a of actions) {
    switch (a.action) {
      case 'void': voided = true; break;
      case 'mark_commitment': commitment = true; break;
      case 'unmark_commitment': commitment = false; break;
      case 'mark_risk': risk = true; break;
      case 'unmark_risk': risk = false; break;
      case 'conclude': {
        current = a;
        if (!hasKey(revisionStatusOfAction, a.id)) { state = 'settled_no_confirm'; pendingResolved = true; break; }
        const st = revisionStatusOfAction[a.id];
        if (!hasKey(CONCLUDE_STATE_OF_REVISION, st)) throw internalError(`结论确认的修订状态 ${st} 未登记`);
        state = CONCLUDE_STATE_OF_REVISION[st];
        pendingResolved = state !== null;
        break;
      }
      case 'for_reference':
        current = a; state = 'for_reference'; pendingResolved = true;
        break;
      case 'escalate': {
        if (!hasKey(revisionStatusOfAction, a.id)) throw internalError('交负责人裁定的动作缺少裁定任务');
        const st = revisionStatusOfAction[a.id];
        if (!hasKey(ADJUDICATE_STATE_OF_REVISION, st)) throw internalError(`裁定的修订状态 ${st} 未登记`);
        state = ADJUDICATE_STATE_OF_REVISION[st];
        pendingResolved = state !== null;
        break;
      }
      default: break; // correct 等不改变状态
    }
  }
  if (!voided && !pendingResolved) throw internalError('登记的最终结论落在已被替代或已失效的修订上');
  if (state === 'for_reference' && latestRefObjected === true) state = 'for_reference_objected';
  if (state === 'settled_no_confirm' && current !== null && current.action === 'conclude' && current.conclusion_kind === 'project_terminated' && projectStatus !== 'terminated') {
    state = 'terminated_conclusion_lapsed';
  }
  if ((state === 'settled_no_confirm' || state === 'confirmed') && current !== null && current.action === 'conclude' && current.conclusion_kind === 'to_change'
    && current.change_id !== null && current.change_id !== undefined && changeStatusOf && changeStatusOf[current.change_id] === 'withdrawn') {
    state = 'to_change_lapsed';
  }
  return {
    voided,
    conclusion_state: voided ? 'voided' : state,
    current,
    commitment_current: commitment,
    risk_current: risk,
  };
}

// 登记的办理事实（读接口与写端点同一份）：办理记录、结论 / 裁定任务及当前修订、仅供参考知会及其异议、派生状态。
async function loadEntryFacts(q, entry, opts) {
  const actions = await q.all(`SELECT ${ACTION_COLS} FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id`, [entry.id]);
  const tasks = await q.all(
    "SELECT id, object_type, object_version_id, purpose, party_id, created_by, created_at FROM sysbuild_confirm_tasks WHERE object_type IN ('conclusion', 'adjudication') AND object_id = ? ORDER BY id",
    [entry.id]
  );
  const revisionStatusOfAction = {};
  const taskRows = [];
  for (const t of tasks) {
    const rev = await core.latestRevision(q, t.id);
    if (!rev) throw internalError('结论确认任务没有修订');
    revisionStatusOfAction[t.object_version_id] = rev.status;
    taskRows.push({ task: t, revision: rev });
  }
  const notices = await q.all(
    "SELECT id, kind, ref_type, ref_id, recipient_member_id, created_by, created_at FROM sysbuild_notices WHERE kind = 'for_reference' AND ref_type = 'entry' AND ref_id = ? ORDER BY id",
    [entry.id]
  );
  const noticeRows = [];
  for (const n of notices) {
    const objection = await q.get('SELECT id, notice_id, actor_user_id, member_id, reason, mode, objection_entry_id, created_at FROM sysbuild_notice_objections WHERE notice_id = ?', [n.id]);
    noticeRows.push({ notice: n, objection: objection || null });
  }
  const latest = noticeRows.length > 0 ? noticeRows[noticeRows.length - 1] : null;
  const proj = await q.get('SELECT status FROM sysbuild_projects WHERE id = ?', [entry.project_id]);
  if (!proj) throw internalError('登记所属项目不存在');
  // 收口后的知会异议（mode = supplement_entry）不改变原登记状态（原登记保持仅供参考，异议走另一条补充登记），所以派生只认「回到办理」的异议
  // 预筛 Q4：「转正式变更」结论所挂的变更状态（只取当前结论用得到的变更；批量取不必要，登记结论动作很少）
  const changeStatusOf = {};
  for (const a of actions) {
    if (a.action === 'conclude' && a.conclusion_kind === 'to_change' && a.change_id !== null && a.change_id !== undefined && !hasKey(changeStatusOf, a.change_id)) {
      const ch = await q.get('SELECT status FROM sysbuild_changes WHERE id = ?', [a.change_id]);
      if (ch) changeStatusOf[a.change_id] = ch.status;
    }
  }
  const derivedOwn = deriveEntryState(entry, actions, revisionStatusOfAction, latest !== null && returnedToHandling(latest.objection), proj.status, changeStatusOf);
  // 拆分：有子登记的登记是「已拆分容器」，状态由子项派生（子项不再拆分，子项的事实不再向下找子项）
  const children = opts && opts.skipChildren === true ? [] : await q.all(`SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE parent_entry_id = ? ORDER BY id`, [entry.id]);
  const childFacts = [];
  for (const c of children) childFacts.push({ entry: c, facts: await loadEntryFacts(q, c, { skipChildren: true }) });
  const derived = childFacts.length > 0 ? deriveContainerState(derivedOwn, childFacts) : derivedOwn;
  const itemRows = await q.all('SELECT id, item_id, item_version_id, assigned_by_action_id FROM sysbuild_entry_items WHERE entry_id = ? ORDER BY id', [entry.id]);
  const currentItemRows = currentItemRowsOf(itemRows, actions);
  // 预筛 L-1：已拆分容器没有「当前去向」（旧快照只作历史保留，去向由各子项承载），置 null——待判定列表、详情 routing、awaiting_sys_iteration 都因此不再把容器当成待判定 / 待转迭代
  const routing = childFacts.length > 0 ? null : await currentRoutingOf(q, entry.id);
  return { actions, taskRows, noticeRows, latestNotice: latest, derived, childFacts, itemRows, currentItemRows, routing };
}
// 登记「当前关联」的条目行（单一函数，codex 25 M2；拆分、提异议、关联条目数、子项条目复制都用它，不直接用全部 itemRows）：
//   没有 assign_items 办理记录 → 全部关联行（首次关联：登记时的关联；子项则是拆分时写的关联）；
//   有 assign_items → 最近一次归属写下的完整集合（assign 每次把归属后的全部条目各写一行，assigned_by_action_id = 该动作；规划外归属写不出行 = 空集）。
//   被替代的历史关联仍留在 itemRows（详情 items_history）。itemRows、actions 都按编号升序。
function currentItemRowsOf(itemRows, actions) {
  let last = null;
  for (const a of actions) {
    if (a.action === 'assign_items') last = a;
  }
  if (last === null) return itemRows;
  return itemRows.filter((r) => r.assigned_by_action_id === last.id);
}
const returnedToHandling = (objection) => objection !== null && objection.mode === 'return_to_handling';

// 写一条登记行（主端点、拆分子登记、收口后异议登记共用）。f 的字段名见下；commitment / isRisk / noEvidence 是 0 / 1，snapshotJson 是已序列化的身份快照文本。返回新行编号。
async function insertEntryRow(q, f) {
  const ins = await q.run(
    `INSERT INTO sysbuild_entries (project_id, node_id, type, purpose, commitment_flag, commitment_flag_source, is_risk, source_party_id, source_name, operator_user_id,
       operator_identity_snapshot, period, days_after_close, business_date, title, body, no_written_evidence, no_evidence_reason, parent_entry_id, objects_entry_id, revision_of_entry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.projectId, f.nodeId, f.type, f.purpose, f.commitment, f.commitmentSource, f.isRisk, f.sourcePartyId, f.sourceName === undefined ? null : f.sourceName, f.operatorUserId,
      f.snapshotJson, f.period, f.days, f.businessDate, f.title, f.body, f.noEvidence, f.noEvidence === 1 ? f.noEvidenceReason : null,
      f.parentEntryId === undefined ? null : f.parentEntryId, f.objectsEntryId === undefined ? null : f.objectsEntryId, f.revisionOfEntryId === undefined ? null : f.revisionOfEntryId]
  );
  return ins.lastID;
}

// ── 分流归属与拆分（C5 S-S1b）─────────────────────────────────────────────────────────────────────
// 一个登记（或处理项）当前的分流归属 = 它名下最后一条判定快照（同一次判定的各行去向一致）；没有快照（办理类以外的登记、S-S1b 之前的存量）= null。
async function currentRoutingOf(q, entryId) {
  const row = await q.get(`SELECT ${SNAPSHOT_COLS} FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id DESC LIMIT 1`, [entryId]);
  return row || null;
}
// ── 批次「是否已正式上线」（C6a，**唯一判定**，方案 §4.3 v1.5 上线判定 P106）──────────────────────────────────────────
// 返回 { last, live }：last = 该批最后一条上线事件（按编号）{ id, kind, reason, created_by, created_at }，没有事件为 null；
//   live = 最后一条事件的 kind 是 golive / regolive（不是 revoke），且当前时刻**严格晚于**事件 created_at（同一秒也算未上线）。
//   当前时刻与事件时刻都取库内同形态的本地时间文本（'YYYY-MM-DD HH:MM:SS'，同一条查询里取，字符串比较等价于时间比较）。
//   分流判定（entries-routing.liveGoliveOf）、变更集合重核（confirm.recheckOverallSet）、结项前置、项目上线进度、交接 / 上线接口都读这一个函数；
//   batches.status 仍随上线 / 撤销在同一事务里维护（编辑类守卫读它），但「已正式上线」的判断不读 status。
const LIVE_EVENT_KINDS = Object.freeze(['golive', 'regolive']);
async function batchLiveState(q, batchId) {
  const ev = await q.get(
    "SELECT id, kind, reason, created_by, created_at, datetime('now','localtime') AS now_at FROM sysbuild_golive_events WHERE batch_id = ? ORDER BY id DESC LIMIT 1",
    [batchId]
  );
  if (!ev) return { last: null, live: false };
  const last = { id: ev.id, kind: ev.kind, reason: ev.reason, created_by: ev.created_by, created_at: ev.created_at };
  return { last, live: LIVE_EVENT_KINDS.includes(ev.kind) && typeof ev.now_at === 'string' && ev.now_at > ev.created_at };
}
// 已上线批次的承诺条目版本集合冻结（P163 / P169 / P170，属编辑类守卫）：判据 = 批次状态 'live' **或** batchLiveState 判已上线。
//   status 随上线 / 撤销在同一事务里维护，上线后同一秒内 batchLiveState 还判未上线（P106 严格晚于），冻结不能留这一秒的窗口（P170）；撤销上线后两者都不成立。
async function isFrozenLiveBatch(q, batchId) {
  const b = await q.get('SELECT status FROM sysbuild_batches WHERE id = ?', [batchId]);
  if (b && b.status === 'live') return true;
  return (await batchLiveState(q, batchId)).live;
}
// 冻结判定（变更包提交时的集合重核 confirm.recheckOverallSet 与变更生效时 confirm-core.applyChangeEffect 共用这一个函数，不另写）：
//   curByItem = 生效前现行规划的 byItem（packages.resolveCurrentPlan）；set = 新集合 [{ item_id, item_version_id, committed_batch_id }]。
//   返回 { frozen, removed }（条目编号数组）：frozen = 新集合里承诺到已上线批次、却与现行规划里该条目不是「同一条目版本且同一承诺批次」的（往已上线批次加条目 / 换版本 / 移入）；
//   removed = 现行规划里承诺到已上线批次、新集合里已不存在的条目（移出）。合起来即「已上线批次的承诺条目版本集合在新旧规划里必须完全相同」。
async function liveFreezeBreaches(q, curByItem, set) {
  const cache = {};
  const frozenBatch = async (bid) => {
    if (bid === null || bid === undefined) return false;
    if (!Object.prototype.hasOwnProperty.call(cache, bid)) cache[bid] = await isFrozenLiveBatch(q, bid);
    return cache[bid];
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const frozen = [];
  const removed = [];
  for (const it of set) {
    if (!(await frozenBatch(it.committed_batch_id))) continue;
    const c = has(curByItem, it.item_id) ? curByItem[it.item_id] : null;
    if (c === null || c.item_version_id !== it.item_version_id || c.committed_batch_id !== it.committed_batch_id) frozen.push(it.item_id);
  }
  const newByItem = {};
  for (const it of set) newByItem[Number(it.item_id)] = it;
  for (const k of Object.keys(curByItem).sort((a, b) => Number(a) - Number(b))) {
    const c = curByItem[k];
    if (!(await frozenBatch(c.committed_batch_id))) continue;
    const n = has(newByItem, Number(c.item_id)) ? newByItem[Number(c.item_id)] : null;
    if (n === null || n.committed_batch_id !== c.committed_batch_id) removed.push(c.item_id); // 移出，或换到别的承诺批次（版本不同但批次不变的已在 frozen 里）
  }
  return { frozen, removed };
}
// 结项前置的事实（批次验收 / 结项包提交与 p_closing 收口共用，C6a）：
//   notLive = 有效批次（非已转出、非被替代）里还没有正式上线的 [{ id, name }]；transferNoChange = 已转出批次里没有已生效变更包的 [{ id, name }]（第一期没有生产路径转出批次，照写）；
//   goliveNewer = 有效且已上线的批次里，最后一条上线事件的时刻不早于结项包生效时刻的 [{ id, name }]（撤销后再上线，结项包须重新确认，P141；没有生效的结项包时为空）；
//   closingEffectiveAt = 现行生效结项包版本的生效时刻（没有为 null）；closingStale = 现行生效结项包版本的 parent 不是现行总体规划版本（P168）；
//   packagePending = 项目里有待确认版本的内容包类型（P164，去重按类型排序，空数组 = 没有）。
async function closingFactsOf(q, projectId) {
  const eff = await q.get(
    `SELECT v.id AS id, v.effective_at AS effective_at, v.parent_overall_version_id AS parent_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type = 'closing' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,
    [projectId]
  );
  const batches = await q.all('SELECT id, seq, name, status, transfer_change_id FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
  // P168：现行生效结项包版本引用的总体规划版本（parent）必须仍是现行总体规划版本（经正式变更换版后，结项包确认的是旧规划，须重新确认）；
  //   P164：项目里有任何待确认的内容包版本时不能整体结项（待确认的包生效会改写结项依据）。现行总体规划版本只读 packages.effectiveOverallVersionId 这一处（延迟 require：packages 依赖本文件）。
  const curOverall = await require('./packages').effectiveOverallVersionId(q, projectId);
  const pendingRows = await q.all(
    `SELECT DISTINCT p.type AS type FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND v.status = 'pending' ORDER BY p.type`,
    [projectId]
  );
  const out = {
    closingEffectiveAt: eff ? eff.effective_at : null, closingStale: !!eff && eff.parent_id !== curOverall, packagePending: pendingRows.map((r) => r.type),
    notLive: [], transferNoChange: [], goliveNewer: [],
  };
  for (const b of batches) {
    if (b.status === 'superseded') continue;
    if (b.status === 'transferred') {
      const ch = b.transfer_change_id === null ? null : await q.get('SELECT status FROM sysbuild_changes WHERE id = ?', [b.transfer_change_id]);
      if (!ch || ch.status !== 'effective') out.transferNoChange.push({ id: b.id, name: b.name });
      continue;
    }
    const st = await batchLiveState(q, b.id);
    if (!st.live) out.notLive.push({ id: b.id, name: b.name });
    else if (eff && !(st.last.created_at < eff.effective_at)) out.goliveNewer.push({ id: b.id, name: b.name });
  }
  return out;
}
// 已拆分容器的派生状态（纯函数）：conclusion_state 恒为 split_container（容器本身不能办理）；split_resolved = 全部子项「已结」（视为有结论，收口前置按它判）。
//   childFacts = [{ entry, facts }]（facts = loadEntryFacts 的结果，只用 derived）。
function deriveContainerState(derivedOwn, childFacts) {
  const kids = childFacts.map((c) => ({ id: c.entry.id, conclusion_state: c.facts.derived.conclusion_state, resolved: entryResolved(c.facts.derived) }));
  return Object.assign({}, derivedOwn, { conclusion_state: 'split_container', split_resolved: kids.every((k) => k.resolved), split_children: kids });
}
// 「已结」（单一口径，收口前置与待判定共用，不另写第二份）：已作废、有有效结论（rules.EFFECTIVE_CONCLUSION_STATES）、或已拆分容器的子项全部已结。
//   terminated_conclusion_lapsed 不在有效结论集合里，所以算未结。
function entryResolved(derived) {
  if (derived.voided === true) return true;
  if (derived.conclusion_state === 'split_container') return derived.split_resolved === true;
  return rules.EFFECTIVE_CONCLUSION_STATES.includes(derived.conclusion_state);
}
// 本项目内「过程登记里办理类、未作废、没有有效结论」的登记（含拆出的子项；已拆分容器按子项判，自己不列）：节点收口前置（plan.js loadPlanData）的取数。
//   返回 [{ id, node_id }]（节点为空 = 项目整体）。
//   C6b 修订批 1（L9）：可选第三参 opts——{ anyPeriod: true } 不限时段（含补充登记）、{ rows: true } 返回完整登记行（默认只返回 { id, node_id }）；待办 handle 类（notify.js）用 { anyPeriod, rows }，
//   与节点收口前置共用同一个循环体与「已结」口径，不另写副本。缺省行为不变。
async function unresolvedProcessEntriesOf(q, projectId, opts) {
  const o = opts || {};
  const marks = rules.ENTRY_HANDLED_TYPES.map(() => '?').join(', ');
  const rows = await q.all(
    `SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE project_id = ? ${o.anyPeriod === true ? '' : "AND period = 'process' "}AND type IN (${marks}) ORDER BY id`,
    [projectId].concat(rules.ENTRY_HANDLED_TYPES)
  );
  const out = [];
  for (const e of rows) {
    const kid = await q.get('SELECT id FROM sysbuild_entries WHERE parent_entry_id = ? LIMIT 1', [e.id]);
    if (kid) continue; // 已拆分容器：由子项判
    const facts = await loadEntryFacts(q, e, { skipChildren: true });
    if (!entryResolved(facts.derived)) out.push(o.rows === true ? e : { id: e.id, node_id: e.node_id });
  }
  return out;
}
// 节点「收口后有未结异议」条数（D34）：异议补充登记（objects_entry_id 非空、时段 = 补充、挂在节点上）里没有「已结」的。返回 { [节点编号]: 条数 }。
async function postCloseObjectionsOf(q, projectId) {
  const rows = await q.all(
    `SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE project_id = ? AND objects_entry_id IS NOT NULL AND period = 'supplement' AND node_id IS NOT NULL ORDER BY id`,
    [projectId]
  );
  const out = {};
  for (const e of rows) {
    const facts = await loadEntryFacts(q, e);
    if (!entryResolved(facts.derived)) out[e.node_id] = (hasKey(out, e.node_id) ? out[e.node_id] : 0) + 1;
  }
  return out;
}
// 谁能对这条（已有有效结论的）登记提异议（D34 / P97）：返回依据文字，没有资格返回 null。依据：登记人本人 → registrant；原结论 / 裁定的确认人 → confirmer；
//   来源方的现任负责人或生效代表人 → source_party；来源方为空（PM / 内部成员 / admin 登记，结论不需要确认）→ 需求方、开发方的任一成员 → party_member（§4.1「需求方、开发方成员可以提异议」）。
//   codex 25 M4：「确认人」只认当前有效结论的确认修订的必需确认人——当前结论动作对应任务的最新修订已确认（confirmed），或最近一次交裁定的任务最新修订已确认；
//   被替换 / 被替代 / 有异议的旧结论的确认人不再因此有资格（仍是成员的按其他依据判）。facts = loadEntryFacts 的结果。
async function objectorBasisOf(q, entry, facts, identity, user) {
  const me = Number(user.id);
  // 预筛 3 轮 L：「原登记人」依据要求登记时身份不是 PM（快照 is_pm 为假；快照缺失 / 无布尔值按拒绝）——PM 代登的登记，PM 不能对自己标的仅供参考 / 已有结论提异议；
  //   来源方为空的 PM 本人登记本来就没有知会。
  if (Number(entry.operator_user_id) === me && parseSnapshot(entry).is_pm === false) return 'registrant';
  const memberIds = [];
  const cur = facts.derived.current;
  if (cur && cur.action === 'conclude') {
    for (const tr of facts.taskRows) {
      if (tr.task.object_type === 'conclusion' && tr.task.object_version_id === cur.id && tr.revision.status === 'confirmed') memberIds.push(tr.revision.required_member_id);
    }
  }
  //   codex 25-R M：裁定确认人只在当前派生状态 = adjudicated（裁定通过，最终态，不可逆）时才算——裁定通过后不能再给结论 / 作废，所以不会遇到「结论已被替换而旧裁定确认人仍有资格」。
  const lastEscalate = [...facts.actions].reverse().find((a) => a.action === 'escalate');
  if (lastEscalate && facts.derived.conclusion_state === 'adjudicated') {
    for (const tr of facts.taskRows) {
      if (tr.task.object_type === 'adjudication' && tr.task.object_version_id === lastEscalate.id && tr.revision.status === 'confirmed') memberIds.push(tr.revision.required_member_id);
    }
  }
  for (const mid of memberIds) {
    const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [mid]);
    if (m && m.user_id !== null && Number(m.user_id) === me) return 'confirmer';
  }
  if (entry.source_party_id !== null && entry.source_party_id !== undefined) {
    const pid = entry.source_party_id;
    if (rules.ownsParty(identity, pid) || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(pid))) return 'source_party';
    return null;
  }
  if (identity.isMember === true && identity.isPm !== true && identity.partyId !== null && identity.partyId !== undefined) return 'party_member';
  return null;
}

// 办理动作的 target（读接口逐对象 actions 与写端点同一份；rules.OBJECT_OPS.entry_* 据此判定）。extra 覆盖 / 追加（如 kind）。
async function entryTarget(q, project, entry, facts, user, extra) {
  const conf = await resolveConclusionConfirmer(q, entry);
  const adj = await resolveAdjudicator(q, entry);
  // C5 S-S1c：开发方关键事项事实——是否需要开发方负责人认可（用途为处理说明 / 交付物，或来源方为开发方且当前带涉及承诺）、是否已被引用为办理依据、是否已有结论（挂靠变更用）
  const needsDev = await entryNeedsDevConfirm(q, entry, facts.derived.commitment_current === true);
  // 修订批 3：devConfirmStatus = 该登记最近一条认可任务的认可状态（none / pending / approved / not_approved / lapsed；N1 拆分判定用）；
  //   markNeedsDevTask = PM 补标涉及承诺会建认可任务（一般用途 + 来源方为开发方，与 entries.js 补标分支同一条件；H2 项目状态判定用）
  const devConfirmStatus = (await devConfirmOf(q, entry)).status;
  const markNeedsDevTask = entry.purpose === 'general' && (await isDevParty(q, entry.source_party_id));
  const usedAsBasis = entry.purpose === 'dev_note'
    ? !!(await q.get("SELECT id FROM sysbuild_entry_actions WHERE basis_kind = 'dev_note_version' AND basis_ref = ? LIMIT 1", [entry.id]))
    : false;
  // 预筛 L2：已被开发方改期引用为关键事项（schedule_records.dev_key_entry_id）的登记也不能作废（改期记录的依据不能消失），任何用途
  const usedAsScheduleKey = !!(await q.get('SELECT id FROM sysbuild_node_schedule_records WHERE dev_key_entry_id = ? LIMIT 1', [entry.id]));
  // P175（修订批 4）：该登记有未解除的不认可（交接确认任务任一批次、任一需求部门的 rejected / objected 修订，之后没有新的结论类动作，被不认可的部门也没有在其后重新确认；P177：答复不解除）——entry_unmark_risk 据此拒绝取消风险标记。
  //   只有问题与处理类、当前带风险标记的登记才可能用到（别的登记取消风险本来就 409），其余不查库直接给 false。golive-core 顶层依赖本文件，所以在这里延迟 require（同 packages）。
  const declineOutstanding = entry.type === 'issue' && facts.derived.risk_current === true ? await require('./golive-core').declineOutstandingOf(q, entry.id) : false;
  return Object.assign({
    declineOutstanding,
    purpose: entry.purpose,
    needsDevConfirm: needsDev,
    devConfirmStatus,
    markNeedsDevTask,
    usedAsBasis,
    usedAsScheduleKey,
    hasConclusion: facts.derived.current !== null && facts.derived.current !== undefined && facts.derived.current.action === 'conclude',
    isRegistrant: Number(entry.operator_user_id) === Number(user.id),
    registrantWasPm: (() => { const s = parseSnapshot(entry); return typeof s.is_pm === 'boolean' ? s.is_pm : undefined; })(), // M-a：登记时身份是 PM（PM 代登 / PM 本人登记）；快照缺失或无布尔值 → undefined，rules 按拒绝（预筛快看 L2，主会话改）
    voided: facts.derived.voided,
    type: entry.type,
    conclusionState: facts.derived.conclusion_state,
    commitmentCurrent: facts.derived.commitment_current,
    commitmentInitial: entry.commitment_flag === 1, // M2：登记时的初始承诺标记（取消后仍不能标仅供参考）
    refObjectedEver: facts.noticeRows.some((nr) => returnedToHandling(nr.objection)), // M1：本登记任一仅供参考知会曾被异议并回到办理（S-S1b：收口后生成补充登记的异议不算，原登记保持仅供参考）
    riskCurrent: facts.derived.risk_current,
    confirmer: conf.kind,
    confirmerProxyOnly: conf.proxyOnly === true, // codex 24 M1：确认人是无账号成员（none / unavailable 恒 false）
    owner: adj.state,
    projectStatus: project.status,
    // C5 S-S1b：拆分 / 分流 / 异议相关事实。isSplitContainer = 已拆分容器（任何办理动作 409）；isChild = 拆出的处理项（不再拆分）；
    //   distinctItemCount = 登记关联的不同条目数（手动拆分至少 2 个）；route / basisCategory = 当前分流归属（没有判定快照 = undefined，rules 对不需要它的动作不判）。
    hasRefNotice: facts.latestNotice !== null && facts.latestNotice !== undefined, // 本登记存在仅供参考知会（有知会 = 只能对知会提异议；没有 = 经 objects_entry_id 提异议）
    isSplitContainer: facts.derived.conclusion_state === 'split_container',
    isChild: entry.parent_entry_id !== null && entry.parent_entry_id !== undefined,
    distinctItemCount: new Set(facts.currentItemRows.map((r) => r.item_id)).size,
    route: facts.routing ? facts.routing.route : undefined,
    basisCategory: facts.routing ? facts.routing.basis_category : undefined,
  }, extra || {});
}

// ── C5 S-S1c 开发方关键事项（方案 v1.4 §4.1 表「开发方处理说明」「正式交付物提交」「涉及承诺」行、§4.2「本人提交并确认」）─────────────────────────────────────────────
// 需要开发方负责人认可的登记 = 用途为开发方处理说明 / 正式交付物，或来源方是开发方且带「涉及承诺」标记（初始或 PM 补标，取当前值）。认可任务 = object_type dev_entry、object_id = object_version_id = 登记编号、
//   purpose dev_key_confirm、必需确认人 = 开发方现任负责人；认可状态由「该登记最近一条认可任务的当前修订」派生（不落列）：pending 待认可｜approved 已认可｜not_approved 负责人未认可（不认可 / 有异议）｜lapsed 已失效（项目终止 / 取消承诺）。
const DEV_PURPOSES = rules.ENTRY_DEV_PURPOSES;
const DEV_CANCELLED_COMMITMENT_REASON = '已取消涉及承诺';
const DEV_VOIDED_REASON = '登记已作废';
async function devPartyIdOf(q, projectId) {
  const p = await q.get("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'dev' LIMIT 1", [projectId]);
  return p ? p.id : null;
}
async function isDevParty(q, partyId) {
  if (partyId === null || partyId === undefined) return false;
  return !!(await q.get("SELECT id FROM sysbuild_parties WHERE id = ? AND side = 'dev'", [partyId]));
}
async function entryNeedsDevConfirm(q, entry, commitmentCurrent) {
  if (DEV_PURPOSES.includes(entry.purpose)) return true;
  return commitmentCurrent === true && (await isDevParty(q, entry.source_party_id));
}
const DEV_STATUS_OF_REVISION = Object.freeze({ pending: 'pending', confirmed: 'approved', rejected: 'not_approved', objected: 'not_approved', invalid: 'lapsed', superseded: 'lapsed' });
// 该登记最近一条认可任务及其当前修订；没有任务 → { task: null, revision: null, status: 'none' }。
async function devConfirmOf(q, entry) {
  const task = await q.get(
    "SELECT id, object_type, object_id, object_version_id, purpose, party_id, created_by, created_at FROM sysbuild_confirm_tasks WHERE object_type = 'dev_entry' AND object_id = ? ORDER BY id DESC LIMIT 1",
    [entry.id]
  );
  if (!task) return { task: null, revision: null, status: 'none' };
  const rev = await core.latestRevision(q, task.id);
  if (!rev) throw internalError('开发方关键事项认可任务没有修订');
  if (!hasKey(DEV_STATUS_OF_REVISION, rev.status)) throw internalError(`开发方认可修订状态 ${rev.status} 未登记`);
  return { task, revision: rev, status: DEV_STATUS_OF_REVISION[rev.status] };
}
const entryVoidedOf = async (q, entryId) => !!(await q.get("SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'void' LIMIT 1", [entryId]));
// 登记可否作「已认可的关键事项」被引用（办理依据 / 改期引用）：已认可且未作废。返回 { ok, reason }。
async function devApprovalUsable(q, entry) {
  if (await entryVoidedOf(q, entry.id)) return { ok: false, reason: '该登记已作废' };
  const dc = await devConfirmOf(q, entry);
  if (dc.status === 'approved') return { ok: true, reason: null };
  return { ok: false, reason: dc.status === 'none' ? '该登记不是需要开发方负责人认可的关键事项' : (dc.status === 'pending' ? '开发方负责人尚未认可' : (dc.status === 'not_approved' ? '开发方负责人未认可' : '该登记的认可已失效')) };
}
// 建认可任务（登记 / PM 补标涉及承诺时在写事务内调用）：已有当前有效认可（待认可或已认可）→ 不重复，返回 { created: false }；开发方暂无负责人 → 409「开发方暂无负责人」；
//   先冻结登记附件（与结论任务共用 ensureEntryFrozen 的一份清单），再建任务与首条修订。本人提交并确认：登记人就是开发方现任负责人（有账号，非 PM 代登）→ 同一事务写浏览记录
//   （source self_submit，冻结清单照实记）+ 平台确认记录（确认），修订当场已确认，不留待确认。返回 { created, taskId, revisionId, requiredMemberId, selfSubmit }。
async function devOwnerSelfSubmit(q, user, owner, operatorUserId, registrantIsPm) {
  if (registrantIsPm === true || !owner) return false;
  const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [owner.memberId]);
  return !!m && m.user_id !== null && Number(m.user_id) === Number(user.id) && Number(operatorUserId) === Number(user.id);
}
async function requestDevConfirm(q, user, attachmentHelpers, entry, opts) {
  // 修订批 3 H2（codex 26）：提交认可 = 作出推进类确认，项目已终止 / 已结项一律 409（登记与 PM 补标共用本入口；整笔回滚，不留登记 / 任务 / 确认记录）。先于「已有当前认可」的早返回：这类登记不再新增任何认可动作
  const proj = await q.get('SELECT status FROM sysbuild_projects WHERE id = ?', [entry.project_id]);
  if (!proj) throw internalError('项目不存在，无法建开发方认可任务');
  const projectBlock = rules.devConfirmProjectBlock(proj.status);
  if (projectBlock) throw makeError(409, projectBlock.code, projectBlock.message);
  const cur = await devConfirmOf(q, entry);
  if (cur.status === 'pending' || cur.status === 'approved') return { created: false, taskId: cur.task.id, revisionId: cur.revision.id, requiredMemberId: cur.revision.required_member_id, selfSubmit: false };
  // 修订批 3 L5（预筛快看）：负责人已表示未认可（不认可 / 有异议）的登记，PM 取消承诺后再补标：承诺标记照常写入，但不建新认可任务、状态保持「负责人未认可」（与处理说明用途同口径，出路只有修订重提，
  //   见 entries.js revision_of_entry_id）；洗白（取消承诺后拆分）由 rules entry_split / assign 混合补选的 devConfirmStatus 判定拦住（N1）。原预筛 M5 的 409 改为不建任务。
  if (cur.status === 'not_approved') return { created: false, taskId: cur.task.id, revisionId: cur.revision.id, requiredMemberId: cur.revision.required_member_id, selfSubmit: false };
  const devParty = await devPartyIdOf(q, entry.project_id);
  const owner = devParty === null ? null : await core.currentOwner(q, devParty);
  if (!owner) throw stateError('开发方暂无负责人，请先完成任职');
  const selfSubmit = !!opts && await devOwnerSelfSubmit(q, user, owner, entry.operator_user_id, opts.registrantIsPm);
  // 预筛 Q2（主会话定论）：本人提交并确认 = 负责人本人登记，等同勾选确认——请求必须带 self_confirm_text 且等于固定确认文案（缺失或不等 → 400，整笔回滚）；确认记录写实际提交的文案
  if (selfSubmit && (!opts || opts.selfConfirmText !== core.CHECKBOX_TEXTS.confirm)) {
    throw Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', `本人登记需要认可的事项视同本人确认，请带 self_confirm_text 并与确认文案一致：「${core.CHECKBOX_TEXTS.confirm}」`), { field: 'self_confirm_text' });
  }
  await ensureEntryFrozen(q, attachmentHelpers, user, entry);
  const t = await core.createTaskWithRevision(q, user, {
    projectId: entry.project_id, objectType: 'dev_entry', objectId: entry.id, objectVersionId: entry.id, purpose: 'dev_key_confirm', partyId: devParty,
    requiredMemberId: owner.memberId, basisAppointmentId: owner.appointmentId, basisDelegationId: null,
    notify: !selfSubmit, // C6b：本人提交并确认的修订当场已确认，不给本人发「请确认」
  });
  if (selfSubmit) {
    const uid = Number(user.id);
    const frozen = await core.frozenSetOf(q, 'entry', entry.id);
    const v = await q.run("INSERT INTO sysbuild_views (user_id, object_type, object_version_id, source, frozen_attachment_set) VALUES (?, 'dev_entry', ?, 'self_submit', ?)", [uid, entry.id, JSON.stringify(frozen)]);
    await core.settleRevision(q, t.revisionId, 'confirmed');
    const cf = await q.run(
      "INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, reason, view_id) VALUES (?, 'dev_entry', ?, ?, 'platform', 'confirm', ?, NULL, ?)",
      [t.revisionId, entry.id, uid, opts.selfConfirmText, v.lastID]
    );
    await emit(q, user, entry.project_id, 'confirm_task', t.taskId, 'confirmation_recorded', {
      confirmation_id: cf.lastID, revision_id: t.revisionId, object_type: 'dev_entry', object_version_id: entry.id, decision: 'confirm', method: 'platform', view_id: v.lastID, reason: null, self_submit: true,
    });
  }
  return { created: true, taskId: t.taskId, revisionId: t.revisionId, requiredMemberId: owner.memberId, selfSubmit };
}
// 登记作废 / 取消涉及承诺时让待确认的认可修订失效（只处理待确认的；已认可的不动）。reason 写进修订状态原因。返回被关闭的修订编号数组。
async function invalidatePendingDevRevisions(q, user, entry, reason) {
  const rows = await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.object_type = 'dev_entry' AND t.object_id = ? AND r.status = 'pending' ORDER BY r.id`,
    [entry.id]
  );
  for (const row of rows) {
    await core.closePendingRevision(q, row.revision_id, 'invalid', reason);
    await emit(q, user, entry.project_id, 'confirm_task', row.task_id, 'confirm_revision_invalidated', { revision_id: row.revision_id, object_type: 'dev_entry', object_version_id: entry.id, reason, entry_id: entry.id });
  }
  return rows.map((r) => r.revision_id);
}
// 认可任务的对象视图（confirm.js loadObject / objectView 用）。返回 null = 登记不存在。
//   pending（decide 的 objectPending）：登记未作废且本任务是该登记最近一条认可任务；status = pending（修订待确认或已失效，可改发）/ settled（已有结果）/ voided；devStatus = 认可状态派生值。
async function loadDevTaskObject(q, task) {
  const entry = await q.get(`SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [task.object_id]);
  if (!entry) return null;
  const voided = await entryVoidedOf(q, entry.id);
  const dc = await devConfirmOf(q, entry);
  const isLatest = dc.task !== null && dc.task.id === task.id;
  const own = await core.latestRevision(q, task.id);
  let status = 'settled';
  if (voided) status = 'voided';
  else if (own && (own.status === 'pending' || own.status === 'invalid')) status = 'pending';
  // 预筛 M4 / L1：改发的两个事实随对象带出（confirm.js resolveReissue 用）——本任务是否是该登记最新一条认可任务；登记当前是否仍需要开发方负责人认可（取消涉及承诺后为假）
  const needsDevConfirm = voided ? false : await entryNeedsDevConfirm(q, entry, (await loadEntryFacts(q, entry, { skipChildren: true })).derived.commitment_current === true);
  return { entry, voided, pending: !voided && isLatest, isLatest, needsDevConfirm, status, devStatus: dc.status };
}
async function devEntryTaskObjectView(q, task, obj) {
  const e = obj.entry;
  const facts = await loadEntryFacts(q, e, { skipChildren: true });
  return {
    type: 'dev_entry',
    entry: {
      id: e.id, project_id: e.project_id, node_id: e.node_id, type: e.type, purpose: e.purpose, title: e.title, body: e.body, business_date: e.business_date,
      period: e.period, days_after_close: e.days_after_close, source_party_id: e.source_party_id, operator_user_id: e.operator_user_id,
      commitment_current: facts.derived.commitment_current, risk_current: facts.derived.risk_current, revision_of_entry_id: e.revision_of_entry_id,
      no_written_evidence: e.no_written_evidence === 1, no_evidence_reason: e.no_evidence_reason, created_at: e.created_at,
    },
    voided: obj.voided,
    dev_confirm_state: obj.devStatus,
  };
}

// ── 办理动作的写助手（在写事务内）──────────────────────────────────────────────────────────────────
// 登记附件的冻结清单（冻结对象类型 entry、对象版本号 = 登记编号）：首次给结论时冻结，已冻结过就不重复冻结（以首次为准，结论 / 裁定任务共用这一份；
//   登记附件只在登记时绑定，首次冻结之后清单不会再变）。返回冻结清单。
async function ensureEntryFrozen(q, attachmentHelpers, user, entry) {
  const existing = await q.get("SELECT id FROM sysbuild_frozen_attachments WHERE object_type = 'entry' AND object_version_id = ? LIMIT 1", [entry.id]);
  if (!existing) {
    // 拆分子项的附件不复制，结论确认要能看到原证据：冻结清单取原登记（容器）名下的附件，冻结键仍挂子项自己（object_version_id = 子项编号）
    const sourceId = entry.parent_entry_id !== null && entry.parent_entry_id !== undefined ? entry.parent_entry_id : entry.id;
    await attachmentHelpers.freezeAttachmentSet(q, {
      objectType: 'entry', objectVersionId: entry.id, ownerType: 'entry', ownerId: sourceId,
      operatorId: Number(user.id), operatorName: core.operatorNameOf(user), projectId: entry.project_id,
    });
  }
  return core.frozenSetOf(q, 'entry', entry.id);
}
// 本登记全部「待确认」的结论 / 裁定修订 → superseded（新结论替代，原因「PM 已改结论」）或 invalid（登记作废）。返回被关闭的修订编号数组。
//   adjudicationReason（可选）：裁定任务（object_type adjudication）的待确认修订用这个原因，缺省沿用 reason（M-c）。
async function closePendingEntryRevisions(q, user, entry, to, reason, adjudicationReason) {
  const rows = await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id, t.object_type AS object_type, t.object_version_id AS object_version_id
       FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.object_type IN ('conclusion', 'adjudication') AND t.object_id = ? AND r.status = 'pending' ORDER BY r.id`,
    [entry.id]
  );
  for (const row of rows) {
    const why = row.object_type === 'adjudication' && adjudicationReason !== undefined ? adjudicationReason : reason;
    await core.closePendingRevision(q, row.revision_id, to, why);
    await emit(q, user, entry.project_id, 'confirm_task', row.task_id, to === 'invalid' ? 'confirm_revision_invalidated' : 'confirm_revision_superseded', {
      revision_id: row.revision_id, object_type: row.object_type, object_version_id: row.object_version_id, reason: why, entry_id: entry.id,
    });
  }
  return rows.map((r) => r.revision_id);
}

// ── 结论 / 裁定任务的对象视图（confirm.js 的 loadObject / objectView 用）──────────────────────────────────
// 任务 task（object_type conclusion / adjudication）所指的登记、结论动作 / 交裁定动作及「是否仍是当前」。返回 null 表示库内对象缺失（调用方按 500 处理）。
//   pending（供 decideTarget.objectPending）：任务对应的动作仍是登记的当前结论 / 裁定，且登记未作废、状态仍是待确认 / 裁定中。
async function loadEntryTaskObject(q, task) {
  const entry = await q.get(`SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [task.object_id]);
  if (!entry) return null;
  const action = await q.get(`SELECT ${ACTION_COLS} FROM sysbuild_entry_actions WHERE id = ? AND entry_id = ?`, [task.object_version_id, entry.id]);
  if (!action) return null;
  const facts = await loadEntryFacts(q, entry);
  const d = facts.derived;
  let pending = false;
  if (task.object_type === 'conclusion') {
    pending = action.action === 'conclude' && d.current !== null && d.current.id === action.id && d.conclusion_state === 'pending_confirm';
  } else {
    const lastEscalate = [...facts.actions].reverse().find((a) => a.action === 'escalate');
    pending = action.action === 'escalate' && lastEscalate !== undefined && lastEscalate.id === action.id && d.conclusion_state === 'escalated';
  }
  return { entry, action, facts, pending, status: d.conclusion_state };
}
// 确认页的对象内容：登记原文、结论原文（conclude 动作行）、异议历史（各结论确认的「有异议」决策 + 仅供参考知会的异议）；裁定任务另带交裁定动作与被裁定的结论。
async function entryTaskObjectView(q, task, obj) {
  const { entry, action, facts } = obj;
  const e = entry;
  const conclusion = task.object_type === 'conclusion'
    ? action
    : [...facts.actions].reverse().find((a) => a.action === 'conclude' && a.id < action.id) || null;
  const objections = [];
  for (const tr of facts.taskRows) {
    if (tr.task.object_type !== 'conclusion') continue;
    const cfs = await q.all(
      `SELECT c.id AS id, c.task_revision_id AS revision_id, c.decision AS decision, c.reason AS reason, c.method AS method, c.created_at AS created_at
         FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id
        WHERE r.task_id = ? AND c.decision = 'object' ORDER BY c.id`,
      [tr.task.id]
    );
    for (const c of cfs) objections.push({ source: 'conclusion_confirm', conclusion_action_id: tr.task.object_version_id, confirmation_id: c.id, reason: c.reason, method: c.method, created_at: c.created_at });
  }
  for (const nr of facts.noticeRows) {
    if (nr.objection) objections.push({ source: 'notice', notice_id: nr.notice.id, reason: nr.objection.reason, created_at: nr.objection.created_at });
  }
  return {
    type: task.object_type,
    entry: {
      id: e.id, project_id: e.project_id, node_id: e.node_id, type: e.type, purpose: e.purpose, title: e.title, body: e.body, business_date: e.business_date,
      period: e.period, days_after_close: e.days_after_close, source_party_id: e.source_party_id, operator_user_id: e.operator_user_id,
      commitment_current: facts.derived.commitment_current, risk_current: facts.derived.risk_current,
      no_written_evidence: e.no_written_evidence === 1, no_evidence_reason: e.no_evidence_reason, created_at: e.created_at,
    },
    conclusion: conclusion ? {
      action_id: conclusion.id, kind: conclusion.conclusion_kind, text: conclusion.text, sys_issue_no: conclusion.sys_issue_no, assignee_text: conclusion.assignee_text,
      created_at: conclusion.created_at, created_by: conclusion.created_by,
    } : null,
    escalation: task.object_type === 'adjudication' ? { action_id: action.id, text: action.text, created_at: action.created_at, created_by: action.created_by } : null,
    objections,
    entry_state: obj.status,
  };
}

module.exports = {
  ENTRY_COLS, ACTION_COLS, SNAPSHOT_COLS, SUPERSEDED_BY_NEW_CONCLUSION, ENTRY_VOIDED_REASON, ESCALATED_CLOSED_BY_TERMINATION_REASON,
  daysBetween, projectEndedOn, decideEntryPeriod, operatorSnapshotOf, parseSnapshot,
  resolveConclusionConfirmer, resolveAdjudicator, memberNameOf, confirmerView,
  insertEntryRow, deriveEntryState, deriveContainerState, entryResolved, currentItemRowsOf, loadEntryFacts, entryTarget, currentRoutingOf, unresolvedProcessEntriesOf, postCloseObjectionsOf, objectorBasisOf,
  batchLiveState, isFrozenLiveBatch, liveFreezeBreaches, closingFactsOf,
  ensureEntryFrozen, closePendingEntryRevisions,
  loadEntryTaskObject, entryTaskObjectView,
  // C5 S-S1c 开发方关键事项
  DEV_CANCELLED_COMMITMENT_REASON, DEV_VOIDED_REASON, devPartyIdOf, isDevParty, entryNeedsDevConfirm, devConfirmOf, devApprovalUsable, devOwnerSelfSubmit, requestDevConfirm, invalidatePendingDevRevisions,
  loadDevTaskObject, devEntryTaskObjectView,
};
