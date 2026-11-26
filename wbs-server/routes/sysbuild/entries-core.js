// routes/sysbuild/entries-core.js — 项目管理（系统建设记录）模块：登记与办理的共用助手（C5 S-S1a；C6 起只剩登记、更正、作废）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记、办理结论的确认、仅供参考）、§4.2「办理结论」「异议裁定」两行、
//   §5.2、§6.3（登记当前状态 = 办理记录 + 确认任务状态，派生不存储）。派单 = docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md。
//
// 本文件只放「在调用方 withRead / withWriteTxn 回调里用 q 调用」的助手，不注册路由：entries.js（登记、更正、作废端点）与 confirm.js 共用。
//   依赖只有 db / entry-forms，不依赖 entries.js / confirm.js，避免成环。
// 状态一律派生：C6 之后登记只剩「是否作废」一项状态，由 deriveEntryState（纯函数）按办理记录归并，不落列。
'use strict';
const { makeError } = require('./db');
const forms = require('./entry-forms');

const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const ENTRY_COLS = `id, project_id, node_id, type, source_party_id, source_name, operator_user_id,
  operator_identity_snapshot, period, days_after_close, business_date, title, body, no_written_evidence, no_evidence_reason, routing_json, created_at`;
const ACTION_COLS = 'id, entry_id, action, text, created_by, created_at';

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

async function memberNameOf(q, memberId) {
  const m = await q.get(
    'SELECT COALESCE(u.display_name, u.username) AS name FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?',
    [memberId]
  );
  return m ? m.name : null;
}

// ── 登记当前状态派生（纯函数）──────────────────────────────────────────────────────────────────
// 入参：entry（只为保持调用形态，不读取）、actions（按编号升序的办理记录）。C6 起登记只剩更正与作废两种办理，状态只有「是否作废」：出现 void 办理记录即作废，correct 不改变状态。
function deriveEntryState(entry, actions) {
  let voided = false;
  for (const a of actions) {
    switch (a.action) {
      case 'void': voided = true; break;
      default: break; // correct 不改变状态
    }
  }
  return { voided };
}

// 登记的办理事实（读接口与写端点同一份）：办理记录与派生状态。
async function loadEntryFacts(q, entry) {
  const actions = await q.all(`SELECT ${ACTION_COLS} FROM sysbuild_entry_actions WHERE entry_id = ? ORDER BY id`, [entry.id]);
  const derived = deriveEntryState(entry, actions);
  return { actions, derived };
}

// 写一条登记行。f 的字段名见下；noEvidence 是 0 / 1，snapshotJson 是已序列化的身份快照文本。返回新行编号。
async function insertEntryRow(q, f) {
  const ins = await q.run(
    `INSERT INTO sysbuild_entries (project_id, node_id, type, source_party_id, source_name, operator_user_id,
       operator_identity_snapshot, period, days_after_close, business_date, title, body, no_written_evidence, no_evidence_reason, routing_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.projectId, f.nodeId, f.type, f.sourcePartyId, f.sourceName === undefined ? null : f.sourceName, f.operatorUserId,
      f.snapshotJson, f.period, f.days, f.businessDate, f.title, f.body, f.noEvidence, f.noEvidence === 1 ? f.noEvidenceReason : null, forms.serializeEntryForm(f.form)]
  );
  return ins.lastID;
}

// ── 批次「是否已正式上线」（C6a，**唯一判定**，方案 §4.3 v1.5 上线判定 P106）──────────────────────────────────────────
// 返回 { last, live }：last = 该批最后一条上线事件（按编号）{ id, kind, reason, created_by, created_at }，没有事件为 null；
//   live = 最后一条事件的 kind 是 golive / regolive（不是 revoke），且当前时刻**严格晚于**事件 created_at（同一秒也算未上线）。
//   当前时刻与事件时刻都取库内同形态的本地时间文本（'YYYY-MM-DD HH:MM:SS'，同一条查询里取，字符串比较等价于时间比较）。
//   结项前置、项目上线进度、上线接口都读这一个函数；
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
// 结项前置的事实（批次验收 / 结项包提交与 p_closing 收口共用，C6a）：
//   notLive = 项目批次中还没有正式上线的 [{ id, name }]；
//   goliveNewer = 已上线批次中，最后一条上线事件不早于结项包生效的 [{ id, name }]（撤销后再上线，结项包须重新确认；没有生效的结项包时为空）；
//   closingEffectiveAt = 现行生效结项包版本的生效时刻（没有为 null）；closingStale = 现行生效结项包版本的 parent 不是现行总体规划版本（P168）；
//   packagePending = 项目里有待确认版本的内容包类型（P164，去重按类型排序，空数组 = 没有）。
async function closingFactsOf(q, projectId) {
  const eff = await q.get(
    `SELECT v.id AS id, v.effective_at AS effective_at, v.parent_overall_version_id AS parent_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type = 'closing' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,
    [projectId]
  );
  const batches = await q.all('SELECT id, seq, name FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
  // P168：现行生效结项包版本引用的总体规划版本（parent）必须仍是现行总体规划版本（总体规划换版后，结项包确认的是旧规划，须重新确认）；
  //   P164：项目里有任何待确认的内容包版本时不能整体结项（待确认的包生效会改写结项依据）。现行总体规划版本只读 packages.effectiveOverallVersionId 这一处（延迟 require：packages 依赖本文件）。
  const curOverall = await require('./packages').effectiveOverallVersionId(q, projectId);
  const pendingRows = await q.all(
    `SELECT DISTINCT p.type AS type FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND v.status = 'pending' ORDER BY p.type`,
    [projectId]
  );
  const out = {
    closingEffectiveAt: eff ? eff.effective_at : null, closingStale: !!eff && eff.parent_id !== curOverall, packagePending: pendingRows.map((r) => r.type),
    notLive: [], goliveNewer: [],
  };
  for (const b of batches) {
    const st = await batchLiveState(q, b.id);
    if (!st.live) out.notLive.push({ id: b.id, name: b.name });
    else if (eff && !(st.last.created_at < eff.effective_at)) out.goliveNewer.push({ id: b.id, name: b.name });
  }
  return out;
}

// 办理动作的 target（读接口逐对象 actions 与写端点同一份；rules.OBJECT_OPS.entry_* 据此判定）。extra 覆盖 / 追加。
//   C6 之后只服务更正与作废两个动作：事实清单只剩表单类别、登记人与登记时身份、是否作废与登记类型。
//   q / project 不参与判定（只为保持调用形态，函数体内无异步读取）。
async function entryTarget(q, project, entry, facts, user, extra) {
  const formView = forms.readEntryForm(entry);
  return Object.assign({
    formKind: formView.form_kind,
    formKindHint: forms.formKindHint(entry),
    formUnreadable: formView.form_unreadable,
    isRegistrant: Number(entry.operator_user_id) === Number(user.id),
    registrantWasPm: (() => { const s = parseSnapshot(entry); return typeof s.is_pm === 'boolean' ? s.is_pm : undefined; })(), // M-a：登记时身份是 PM（PM 代登 / PM 本人登记）；快照缺失或无布尔值 → undefined。C6 后没有任何规则读这个字段（唯一消费方「有未结异议时不能由 PM 作废」随 C6 删除），留待后续清理；不要依赖它
    voided: facts.derived.voided,
    type: entry.type,
  }, extra || {});
}

async function devPartyIdOf(q, projectId) {
  const p = await q.get("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'dev' LIMIT 1", [projectId]);
  return p ? p.id : null;
}
async function isDevParty(q, partyId) {
  if (partyId === null || partyId === undefined) return false;
  return !!(await q.get("SELECT id FROM sysbuild_parties WHERE id = ? AND side = 'dev'", [partyId]));
}

module.exports = {
  ENTRY_COLS, ACTION_COLS,
  daysBetween, projectEndedOn, decideEntryPeriod, operatorSnapshotOf, parseSnapshot,
  memberNameOf,
  insertEntryRow, deriveEntryState, loadEntryFacts, entryTarget,
  batchLiveState, closingFactsOf,
  devPartyIdOf, isDevParty,
};
