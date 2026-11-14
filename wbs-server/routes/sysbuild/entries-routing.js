// routes/sysbuild/entries-routing.js — 项目管理（系统建设记录）模块：问题分流判定、判定快照、处理项（子登记）与待判定归属（C5 S-S1b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1「关联内容已上线后」、§4.3（判定流程 1–7、尚未判定、跨批次拆分、换批与拆分）、§4.5、§6.2 判定快照行与「C5 增量」D39。
//   派单 = docs/local/系统建设记录/送审准备/C5_S-S1b_分流与收口_派单_20261105.md（含 0b 补充裁定；本文口径与方案冲突时以派单为准）。
//
// 本文件只放「在调用方 withRead / withWriteTxn 回调里用 q 调用」的助手，不注册路由：entries.js（写登记 / 办理动作 / 知会异议）共用。
//   依赖只有 rules / db / packages / entries-core，不依赖 entries.js，避免成环。
// 分流只看「当前生效总体规划」里条目的承诺批次（packages.resolveCurrentPlan，**单一来源**，不看待处理版本，也不另写取数）；批次「当前有效上线」= 该批最后一条上线事件是 golive / regolive
//   （不是 revoke），且当前时刻晚于该事件时刻（时间比较在 SQL 里做，库内时间戳同形态；不用只有日期的 todayProvider）。
// 判定快照只追加（sysbuild_routing_snapshots 不在 UPDATABLE_COLUMNS）：快照挂在「承载去向的登记」名下——单个登记就是它自己，拆分后各处理项（子登记）各挂各的；part_no = 处理项序号
//   （从 1 起，按 去留项目 → 转系统迭代 → 尚未判定 的顺序），一个登记的当前去向 = 它名下最后一条快照（同一次判定的各行去向一致）。快照里一行对应一个条目（尚未判定整组只有一行，判定列全空）。
'use strict';
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { resolveCurrentPlan } = require('./packages');
const core = require('./confirm-core');
const entries = require('./entries-core');

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);

// 分流去向的组别（也是 planParts 的顺序）：project = 未上线，留项目办理；sys_iteration = 已上线，转系统迭代；pending = 不在生效总体规划里（或没有承诺批次），进待判定，由 PM 三选一。
const GROUP_ORDER = Object.freeze(['project', 'sys_iteration', 'pending']);
const CANCELLED_WITH_PARENT_TEXT = '随原登记取消';
const ASSIGN_BASES =Object.freeze(['planned_detail', 'in_plan', 'out_of_plan']);
const ASSIGN_ROUTES = Object.freeze(['project', 'sys_iteration']);

// 批次「当前有效上线」：返回 { id（上线事件编号） } 或 null。最后一条事件是撤销（revoke）= 未上线；当前时刻不晚于事件时刻（时钟回拨 / 同一秒）也按未上线。
//   C6a：判据收口到 entries-core.batchLiveState（唯一判定，分流 / 变更重核 / 结项 / 上线接口共用）。
async function liveGoliveOf(q, batchId) {
  const st = await entries.batchLiveState(q, batchId);
  return st.live ? { id: st.last.id } : null;
}

// 逐条目归类。cur = packages.resolveCurrentPlan 的结果。条目不在生效总体规划里、或在规划里却没有承诺批次 → pending（不参与自动分流，由 PM 三选一，派单 0b）；
//   其余按承诺批次是否当前有效上线分 project / sys_iteration，并带上快照要记的依据（总体包版本、条目版本、承诺批次、上线事件）。
async function classifyItems(q, cur, itemIds) {
  const out = [];
  const liveOfBatch = {};
  for (const itemId of itemIds) {
    const cell = hasKey(cur.byItem, itemId) ? cur.byItem[itemId] : null;
    if (cell === null || cell.committed_batch_id === null || cell.committed_batch_id === undefined) { out.push({ item_id: itemId, group: 'pending' }); continue; }
    const bid = cell.committed_batch_id;
    if (!hasKey(liveOfBatch, bid)) liveOfBatch[bid] = await liveGoliveOf(q, bid);
    const live = liveOfBatch[bid];
    out.push({
      item_id: itemId, group: live ? 'sys_iteration' : 'project', overall_package_version_id: cell.overall_version_id, item_version_id: cell.item_version_id,
      committed_batch_id: bid, golive_event_id: live ? live.id : null,
    });
  }
  return out;
}
// 处理项划分（纯函数）：没有条目 → 一个「尚未判定」项；有条目 → 按组别各一项（顺序固定）。
function planParts(classified) {
  if (classified.length === 0) return [{ route: 'pending', items: [] }];
  const parts = [];
  for (const g of GROUP_ORDER) {
    const items = classified.filter((c) => c.group === g);
    if (items.length > 0) parts.push({ route: g, items });
  }
  return parts;
}
// 一个处理项要追加的快照行（纯函数）：已生效规划内（in_plan）按条目一行；尚未判定整项一行、判定列全空。
function snapshotRowsOfPart(part) {
  if (part.route === 'pending') {
    return [{ route: 'pending', basis_category: 'undetermined', overall_package_version_id: null, item_version_id: null, committed_batch_id: null, golive_event_id: null }];
  }
  return part.items.map((c) => ({
    route: part.route, basis_category: 'in_plan', overall_package_version_id: c.overall_package_version_id, item_version_id: c.item_version_id,
    committed_batch_id: c.committed_batch_id, golive_event_id: c.golive_event_id,
  }));
}
// 追加判定快照（挂在承载去向的登记名下）。triggerActionId：首次判定为空，办理动作触发的判定带该动作编号。返回新行编号数组。
async function appendSnapshots(q, entryId, partNo, rows, triggerActionId) {
  const ids = [];
  for (const r of rows) {
    const ins = await q.run(
      `INSERT INTO sysbuild_routing_snapshots (entry_id, part_no, overall_package_version_id, item_version_id, committed_batch_id, golive_event_id, trigger_action_id, route, basis_category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, partNo, r.overall_package_version_id, r.item_version_id, r.committed_batch_id, r.golive_event_id, triggerActionId === undefined ? null : triggerActionId, r.route, r.basis_category]
    );
    ids.push(ins.lastID);
  }
  return ids;
}
// 全部条目已上线时「拒绝新增」的响应附带清单：已上线条目（编号、需求编号 R-nn）及其承诺批次与上线事件
async function describeLiveItems(q, classified) {
  const out = [];
  for (const c of classified.filter((x) => x.group === 'sys_iteration')) {
    const it = await q.get('SELECT code FROM sysbuild_items WHERE id = ?', [c.item_id]);
    const b = await q.get('SELECT name, seq FROM sysbuild_batches WHERE id = ?', [c.committed_batch_id]);
    out.push({ item_id: c.item_id, code: it ? it.code : null, batch_id: c.committed_batch_id, batch_name: b ? b.name : null, golive_event_id: c.golive_event_id });
  }
  return out;
}
// 拒绝新增（§4.1 表「关联内容已上线后：关闭新增」）：409 SYSBUILD_STATE，响应另带 guide = sys_iteration 与已上线条目 / 批次清单。
async function liveRejection(q, classified) {
  const live = await describeLiveItems(q, classified);
  return Object.assign(stateError('关联的需求条目所在批次已正式上线，项目内不再接受新增，请到系统迭代受理渠道提单'), { extra: { guide: 'sys_iteration', live_items: live } });
}

// 子登记（处理项）：复制原登记的 类型 / 用途 / 来源方 / 时段 / 标题 / 标志 / 证据声明 / 登记人身份快照（P93 判定确认人要用），body 写「由第 N 条登记按分流归属拆出」并引用原文；
//   附件不复制（详情回读原登记附件）。parent_entry_id = 原登记。条目关联：本项的条目（item_version_id 取原登记名下该条目的最新一行），assigned_by_action_id = 触发动作（自动拆分为空）。
async function createChildEntry(q, parent, parentItemRows, itemIds, triggerActionId, derived, actorId, user) {
  const body = `由第 ${parent.id} 条登记按分流归属拆出。\n\n【原登记内容】\n${parent.body}`;
  // 预筛 M-1：子项继承原登记的「当前」标记，不丢 PM 补标——风险 = 当前风险；涉及承诺 = 初始 ∨ 当前（子项的初始标记由此守住「初始带标记不能标仅供参考」）：
  //   初始为 1 取原来源；初始为 0 而当前为真（只由 PM 补标）来源记 pm。derived 缺省（登记提交时自动拆分，还没有办理记录）按初始值。
  //   修订批 2 L-1：父登记「初始带标记、当前已被 PM 取消」时，子项保留初始 1（与原来源），并在同一事务给每个子项追加一条取消的办理记录（text「随原登记取消」，created_by = 执行拆分的 PM），
  //   使子项当前值 = false、同时仍受 M2 初始值约束（初始带承诺的登记不能标仅供参考）。
  const risk = parent.is_risk === 1 || (derived && derived.risk_current === true) ? 1 : 0;
  const commitment = parent.commitment_flag === 1 || (derived && derived.commitment_current === true) ? 1 : 0;
  const commitmentSource = parent.commitment_flag === 1 ? parent.commitment_flag_source : (commitment === 1 ? 'pm' : null);
  const id = await entries.insertEntryRow(q, {
    projectId: parent.project_id, nodeId: parent.node_id, type: parent.type, purpose: parent.purpose, commitment, commitmentSource,
    isRisk: risk, sourcePartyId: parent.source_party_id, sourceName: parent.source_name, operatorUserId: parent.operator_user_id,
    snapshotJson: parent.operator_identity_snapshot, period: parent.period, days: parent.days_after_close, businessDate: parent.business_date, title: parent.title, body,
    noEvidence: parent.no_written_evidence, noEvidenceReason: parent.no_evidence_reason, parentEntryId: parent.id, objectsEntryId: null,
  });
  if (derived) {
    // 预筛 3 轮 L：补写的「随原登记取消」办理记录同样发 entry_action_recorded 事件（与办理动作端点同形，payload.via = split_cancel 标明来源），不留无事件的办理记录
    const recordCancel = async (action) => {
      const r = await q.run('INSERT INTO sysbuild_entry_actions (entry_id, action, text, created_by) VALUES (?, ?, ?, ?)', [id, action, CANCELLED_WITH_PARENT_TEXT, actorId]);
      await writeEvent(q, {
        projectId: parent.project_id, objectType: 'entry', objectId: id, eventType: 'entry_action_recorded',
        payload: { action_id: r.lastID, action, conclusion_kind: null, sys_issue_no: null, assignee_text: null, task_id: null, notice_id: null, closed_revision_ids: [], via: 'split_cancel', parent_entry_id: parent.id },
        operatorId: Number(actorId), operatorName: core.operatorNameOf(user),
      });
    };
    if (parent.commitment_flag === 1 && derived.commitment_current !== true) await recordCancel('unmark_commitment');
    if (parent.is_risk === 1 && derived.risk_current !== true) await recordCancel('unmark_risk');
  }
  for (const itemId of itemIds) {
    const rows = parentItemRows.filter((r) => r.item_id === itemId);
    if (rows.length === 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：拆分的条目不在原登记名下');
    const last = rows.reduce((a, b) => (b.id > a.id ? b : a));
    await q.run('INSERT INTO sysbuild_entry_items (entry_id, item_id, item_version_id, assigned_by_action_id) VALUES (?, ?, ?, ?)', [id, itemId, last.item_version_id, triggerActionId === undefined ? null : triggerActionId]);
  }
  return id;
}
// 按处理项拆分：原登记成为「已拆分容器」，每个处理项一条子登记 + 各自的判定快照（part_no = 处理项序号）。返回 [{ part_no, route, entry_id, snapshot_ids }]。
//   parts 里每项的 items 取 { item_id }；triggerActionId：自动拆分为空，手动 split 为 split 动作编号。
async function splitIntoParts(q, parent, parentItemRows, parts, triggerActionId, derived, actorId, user) {
  const out = [];
  let n = 0;
  for (const part of parts) {
    n += 1;
    const entryId = await createChildEntry(q, parent, parentItemRows, part.items.map((c) => c.item_id), triggerActionId, derived, actorId, user);
    const snapshotIds = await appendSnapshots(q, entryId, n, snapshotRowsOfPart(part), triggerActionId);
    out.push({ part_no: n, route: part.route, entry_id: entryId, snapshot_ids: snapshotIds });
  }
  return out;
}

// ── 手动拆分（办理动作 split）：PM 给条目分组 ─────────────────────────────────────────────────────────────
// groups = [[条目编号…], …]：至少两组、每组非空、同一条目不进两组、并集 = 登记名下全部不同条目（不能漏条目，否则被漏的条目没有处理项）。每组走一次分流判定，
//   组内条目的去向必须一致（既有未上线又有已上线的要拆开；规划内与规划外的也要拆开）。返回 parts（同 planParts 的项）。
async function planManualSplit(q, projectId, entryItemIds, groups) {
  if (!Array.isArray(groups) || groups.length < 2) throw invalid('至少分成两组', 'groups');
  if (groups.length > 20) throw invalid('一次最多分 20 组', 'groups');
  const seen = [];
  const parsed = [];
  for (const g of groups) {
    if (!Array.isArray(g) || g.length === 0) throw invalid('每组至少有一个条目', 'groups');
    const ids = g.map((v) => {
      const id = rules.parseId(v);
      if (!id) throw invalid('条目编号不合法', 'groups');
      return id;
    });
    for (const id of ids) {
      if (!entryItemIds.includes(id)) throw invalid('分组里有不属于本登记关联条目的编号', 'groups');
      if (seen.includes(id)) throw invalid('同一个条目不能进入两组', 'groups');
      seen.push(id);
    }
    parsed.push(ids);
  }
  if (seen.length !== entryItemIds.length) throw invalid('分组必须包含本登记关联的全部条目', 'groups');
  const cur = await resolveCurrentPlan(q, projectId);
  const parts = [];
  let k = 0;
  for (const ids of parsed) {
    k += 1;
    const classified = await classifyItems(q, cur, ids);
    const ps = planParts(classified);
    if (ps.length !== 1) throw stateError(`第 ${k} 组里的条目分流归属不一致（既有未上线的、已上线的或不在生效总体规划里的），请按归属拆开`);
    parts.push(ps[0]);
  }
  return parts;
}

// ── 待判定归属（办理动作 assign_items）：PM 三选一 / 普通补选归属 ───────────────────────────────────────────
// 输入 { basis, itemIds, route }（basis ∈ planned_detail / in_plan / out_of_plan，依据文字 text 由端点另存），opts.isChild = 登记是拆出的处理项。返回 { route, basis, rows（快照行）, links（归属后的完整关联集合 [{ item_id, item_version_id }]，
//   端点逐条写 entry_items，assigned_by_action_id = 本动作）}；混合去向（非子项）另返回 route = 'mixed' 与 parts。
//   ① planned_detail 规划内尚未细化：关联本项目新建的条目版本（不在生效总体规划里的条目，或规划里条目的更新版本），去向留项目；不要求生效总体包、上线事件。
//   ② in_plan 已生效规划内：条目都须在生效总体规划里且有承诺批次；全部已上线 → 去向转系统迭代（已上线功能缺陷，须有上线事件）；全部未上线 → 留项目（普通补选归属，须有承诺批次）；
//      未上线与已上线混在一起 → 409（请先手动拆分）；有不在规划里的 → 409。去向由条目的上线状态决定，请求里不带 route。
//   ③ out_of_plan 规划外：不关联条目；去向由 PM 选 sys_iteration 或 project（留项目的只能转正式变更，rules.entry_conclude 判）。
async function planAssignment(q, projectId, input, opts) {
  const { basis, itemIds, route } = input;
  if (!ASSIGN_BASES.includes(basis)) throw invalid(`判定依据类别必须是 ${ASSIGN_BASES.join(' / ')} 之一`, 'basis_category');
  if (basis === 'out_of_plan') {
    if (itemIds.length > 0) throw invalid('规划外不关联需求条目', 'item_ids');
    if (!ASSIGN_ROUTES.includes(route)) throw invalid(`规划外必须选择去向：${ASSIGN_ROUTES.join(' / ')}`, 'route');
    return {
      route, basis, links: [],
      rows: [{ route, basis_category: 'out_of_plan', overall_package_version_id: null, item_version_id: null, committed_batch_id: null, golive_event_id: null }],
    };
  }
  if (itemIds.length === 0) throw invalid('请选择要关联的需求条目', 'item_ids');
  if (route !== undefined && route !== null) throw invalid('去向由条目的上线状态判定，不需要选择（只有规划外要选去向）', 'route');
  const cur = await resolveCurrentPlan(q, projectId);
  for (const itemId of itemIds) {
    const item = await q.get('SELECT id FROM sysbuild_items WHERE id = ? AND project_id = ?', [itemId, projectId]);
    if (!item) throw invalid('需求条目不存在或不属于本项目', 'item_ids');
  }
  if (basis === 'planned_detail') {
    const rows = [];
    const links = [];
    for (const itemId of itemIds) {
      const last = await q.get('SELECT id, version_no FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1', [itemId]);
      if (!last) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：需求条目没有版本');
      if (hasKey(cur.byItem, itemId) && cur.byItem[itemId].item_version_id === last.id) {
        throw stateError('该条目已是生效总体规划里的现行版本，不属于「规划内尚未细化」，请按「已生效规划内」归属');
      }
      // Q1（方案 §4.3 换批与拆分：已上线条目的后续增强一律建新条目）：规划里的条目承诺批次已正式上线，它的新版本不能当作「规划内尚未细化」留在项目里
      if (hasKey(cur.byItem, itemId) && cur.byItem[itemId].committed_batch_id !== null && cur.byItem[itemId].committed_batch_id !== undefined
        && (await liveGoliveOf(q, cur.byItem[itemId].committed_batch_id)) !== null) {
        throw stateError('已上线条目的增强须建新条目，不能作为「规划内尚未细化」归属');
      }
      links.push({ item_id: itemId, item_version_id: last.id });
      rows.push({
        route: 'project', basis_category: 'planned_detail', overall_package_version_id: cur.overall_version_id, item_version_id: last.id, committed_batch_id: null, golive_event_id: null,
      });
    }
    return { route: 'project', basis, rows, links };
  }
  // in_plan
  const classified = await classifyItems(q, cur, itemIds);
  if (classified.some((c) => c.group === 'pending')) throw stateError('有条目不在生效总体规划里（或规划里没有承诺批次），请按「规划内尚未细化」或「规划外」归属');
  const groups = Array.from(new Set(classified.map((c) => c.group)));
  if (groups.length !== 1) {
    // codex 25 M3：混合去向（既有未上线又有已上线）。拆出的处理项不能再拆 → 409；非子项登记在同一事务里写关联并按去向自动拆成子登记（端点用 parts 调 splitIntoParts，快照触发动作 = 本次归属动作）。
    //   预筛 3 轮 L（codex 25-R L）：不能再拆（子项 / 需要开发方认可的登记）时，提示拆成两件事办——未上线部分单独补选归属，已上线部分到系统迭代受理渠道提单；响应带 guide = sys_iteration 与已上线条目清单
    //   修订批 3 N1：开发方负责人未认可（not_approved）的登记同样不能自动拆分（取消涉及承诺后不再「需要认可」，但拆分会洗掉未认可），提示改为「请修订重提」，响应仍带 guide / 已上线条目
    if (opts && opts.noSplitNotApproved === true) {
      throw Object.assign(stateError(rules.ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE), { extra: { guide: 'sys_iteration', live_items: await describeLiveItems(q, classified) } });
    }
    if (opts && (opts.isChild === true || opts.noSplit === true)) {
      throw Object.assign(stateError('未上线部分请单独补选归属；已上线部分请到系统迭代受理渠道提单'), { extra: { guide: 'sys_iteration', live_items: await describeLiveItems(q, classified) } });
    }
    return {
      route: 'mixed', basis, parts: planParts(classified), rows: [],
      links: classified.map((c) => ({ item_id: c.item_id, item_version_id: c.item_version_id })),
    };
  }
  const part = { route: groups[0], items: classified };
  return {
    route: part.route, basis, rows: snapshotRowsOfPart(part),
    links: classified.map((c) => ({ item_id: c.item_id, item_version_id: c.item_version_id })),
  };
}

// ── 异议的执行前提事实（预筛 L-2，读接口 actions.object 与执行同源）──────────────────────────────────────
// 被异议登记名下的条目是否全部已上线（办理类、有条目、全部所在批次当前有效上线 → 执行会 409 引导系统迭代）、所在节点是否已取消（执行会 409）。
//   返回 { itemsAllLive, nodeCancelled }（布尔）。判定复用 classifyItems / planParts，不另写第二份口径。
async function objectionFacts(q, entry, facts) {
  let itemsAllLive = false;
  if (rules.ENTRY_HANDLED_TYPES.includes(entry.type)) {
    const itemIds = Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))); // 当前关联（codex 25 M2），不含被补选归属替代的历史关联
    if (itemIds.length > 0) {
      const parts = planParts(await classifyItems(q, await resolveCurrentPlan(q, entry.project_id), itemIds));
      itemsAllLive = parts.length === 1 && parts[0].route === 'sys_iteration';
    }
  }
  let nodeCancelled = false;
  if (entry.node_id !== null && entry.node_id !== undefined) {
    const n = await q.get('SELECT status FROM sysbuild_nodes WHERE id = ?', [entry.node_id]);
    nodeCancelled = !!n && n.status === 'cancelled';
  }
  return { itemsAllLive, nodeCancelled };
}

module.exports = {
  objectionFacts,
  GROUP_ORDER, ASSIGN_BASES, ASSIGN_ROUTES,
  liveGoliveOf, classifyItems, planParts, snapshotRowsOfPart, appendSnapshots, describeLiveItems, liveRejection,
  createChildEntry, splitIntoParts, planManualSplit, planAssignment,
};
