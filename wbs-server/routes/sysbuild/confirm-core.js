// routes/sysbuild/confirm-core.js — 项目管理（系统建设记录）模块：确认任务与修订、必需确认人解析、资格复核、内容包生效与基线形成的共用助手（C4a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 3 / 5 / 9、§3.1（总体排期基线）、§4.2（确认规则表）、§4.4（基线）、§4.5、§6.2。
//   派单 = docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md（P23 / P26 / P28 / P29）与 C4a_修订批派单_20261101.md（P31–P41）。
//
// 本文件只放「在调用方 withWriteTxn 回调里用 q 调用」的事务内助手，不注册路由：confirm.js（提交 / 撤回 / 改发 / 浏览 / 决策 / 代录）、items.js
//   （条目版本创建时生成提出人确认任务）、projects.js（终止项目时失效待确认修订）与 membership.js（C4b：任职接受 / 授权批准与接受的代录，建任务与修订、写代录确认记录）共用。
//   依赖只有 rules / db / events，避免与 packages.js、items.js 成环。
// 所有状态写入都带旧状态条件并核对影响行数（0 → 409）；SQL 只经 q 助手（静态守卫 S5）；不 DELETE（S3）。
'use strict';
const materialsCore = require('./materials-core');
const { attachmentStateFields } = require('./attachments');
const rules = require('./rules');
const schema = require('./schema'); // C5 预筛 L1：终止分类表的加载断言读确认用途枚举
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const notifyCore = require('./notify-core'); // C6b：确认任务修订生成时写发送意图（notify-core 只依赖 db，不成环）
const { attachmentDisplayName } = require('./attachments'); // 附件视图（遮蔽的附件不返回原名）；attachments.js 不依赖本文件，不成环

// 平台确认的固定勾选文案（服务端常量，§4.2「勾选与固定文案」）。按决策分设（codex 19 号 M-3）：三种决策不共用一句——共用「确认以上内容属实」时，
//   选「不认可」的记录里会同时保存认可内容属实的声明，审计证据自相矛盾。decide 的 checkbox_text 必须与**所选 decision 对应**的那一条逐字相等；
//   确认记录保存实际提交的文案（与该条逐字相等）。读接口（任务详情）把三条一并交给前端，按所选决策显示。三条都以「我已阅读以上全部内容」开头：勾选只证明已阅读，
//   认可 / 异议 / 不认可由 decision 本身表达。
const CHECKBOX_TEXTS = Object.freeze({
  confirm: '我已阅读以上全部内容，确认无误',
  object: '我已阅读以上全部内容，对其有异议（原因见下）',
  reject: '我已阅读以上全部内容，不认可（原因见下）',
});
// C6a 交接确认（对象类型 handover）的固定勾选文案：确认一条按用途（接受带此问题上线 / 不再处理）分设，不认可沿用通用那条；交接确认只认 确认 / 不认可，object 一条只为结构完整（不会被决策端点接受）。
//   checkboxTextsOf(purpose) 是任务详情（checkbox_texts）与决策校验共用的唯一取法，其他用途照旧取 CHECKBOX_TEXTS。
const HANDOVER_CHECKBOX_TEXTS = Object.freeze({
  handover_accept_issue: Object.freeze({
    confirm: '我已阅读以上全部内容，确认接受该问题带着上线',
    object: CHECKBOX_TEXTS.object,
    reject: CHECKBOX_TEXTS.reject,
  }),
  handover_no_further: Object.freeze({
    confirm: '我已阅读以上全部内容，确认该问题不再处理',
    object: CHECKBOX_TEXTS.object,
    reject: CHECKBOX_TEXTS.reject,
  }),
});
function checkboxTextsOf(purpose) {
  return Object.prototype.hasOwnProperty.call(HANDOVER_CHECKBOX_TEXTS, purpose) ? HANDOVER_CHECKBOX_TEXTS[purpose] : CHECKBOX_TEXTS;
}
const ITEM_SUPERSEDED_REASON = '条目已有新版本';
const PROJECT_TERMINATED_REASON = '项目已终止';

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);
const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
  projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: operatorNameOf(user),
});

// ── 冻结清单 ───────────────────────────────────────────────────────────────────────────────────
// 提交确认时冻结的附件清单（不变量 9）：[{ attachment_id, sha256 }]，按附件编号升序。浏览记录、决策、导出都读这份清单。
async function frozenSetOf(q, objectType, versionId) {
  const rows = await q.all(
    'SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = ? AND object_version_id = ? ORDER BY attachment_id',
    [objectType, versionId]
  );
  return rows.map((r) => ({ attachment_id: r.attachment_id, sha256: r.sha256 }));
}
// 比较用的规范串（浏览记录里存的 JSON 与库里现取的清单按它逐项比对，顺序已按编号固定）。
const frozenKey = (set) => JSON.stringify(set.map((r) => [r.attachment_id, r.sha256]));
// C5 S-S1a：办理结论确认与负责人裁定任务（object_type conclusion / adjudication）的冻结清单挂在登记上——冻结对象类型 entry、对象版本号 = 登记编号（首次给结论时冻结，
//   以首次为准）；浏览记录与确认记录仍按任务自己的 object_type / object_version_id（结论动作 / 交裁定动作的编号）记。其余任务的冻结清单就是任务自己的 (object_type, object_version_id)。
//   返回 { objectType, versionId }：读任务详情、决策比对冻结清单、冻结助手共用这一个映射。
const ENTRY_TASK_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);
//   C5 S-S1c：开发方关键事项认可任务（object_type dev_entry，object_id = 登记编号）同样冻结登记的附件清单（冻结对象类型 entry、版本号 = 登记编号），与结论任务共用 ensureEntryFrozen 的这一份。
//   C6a：交接确认任务（object_type handover，object_id = 登记编号）同样冻结登记的附件清单。
function frozenKeyOfTask(task) {
  if (task.object_type === 'conclusion' || task.object_type === 'adjudication' || task.object_type === 'dev_entry' || task.object_type === 'handover') return { objectType: 'entry', versionId: task.object_id };
  return { objectType: task.object_type, versionId: task.object_version_id };
}
async function frozenSetOfTask(q, task) {
  const k = frozenKeyOfTask(task);
  return frozenSetOf(q, k.objectType, k.versionId);
}

// ── 必需确认人解析（P23 / P44）与资格复核同源（预筛 M1）──────────────────────────────────────────────
// 「可作为确认人」的唯一判定（C4b P44 拆两档，取并集）：成员已加入且未移出（rules.MEMBER_ACTIVE_SQL）+
//   · 平台确认人 = 有平台账号且账号状态 active；
//   · 代录确认人 = 没有平台账号（user_id 为空，只能由 PM 代录）。
//   有账号但账号停用的成员两档都不是——仍视为缺人（停用账号可能是离职，不默认走代录）；user_id 非空但用户行不存在同理（左连接后 u.status 为空，判假）。
//   解析（currentOwner / currentDelegate / createProposerTask）、改发、资格复核（qualificationLoss）、待我确认全部调用这一份，
//   任职 / 授权是否仍生效是另一层（依据检查），不在本片段里。别名约定：成员 m、用户 u（一律左连接 users）。
const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND (m.user_id IS NULL OR u.status = 'active')`;
// C6b 修订批 3（预筛 MED-B）：发送侧要先按「与账号状态无关」的条件复核（账号停用是可恢复的，不能盖过永久失格——否则停用 + 已移出 / 已确认 / 已改发的意图会被记成可恢复的失败，账号一恢复就外发过期通知）。
//   o.ignoreAccountStatus === true 时只看成员已加入未移出，不看账号状态；站内入口（待我确认 / 作出确认 / 改发）一律不传 o，口径不变。
const eligibleSqlOf = (o) => (o && o.ignoreAccountStatus === true ? rules.MEMBER_ACTIVE_SQL : CONFIRMER_ELIGIBLE_SQL);
// 成员 memberId 此刻可作为确认人？返回 { id, user_id, party_id, proxy_only }，不可则 null。proxy_only = 没有平台账号（只能代录）。
async function eligibleMember(q, memberId, o) {
  const r = await q.get(
    `SELECT m.id AS id, m.user_id AS user_id, m.party_id AS party_id FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND ${eligibleSqlOf(o)}`,
    [memberId]
  );
  return r ? Object.assign({}, r, { proxy_only: r.user_id === null }) : null;
}
// 成员 memberId 没有平台账号（任务只能由 PM 代录）？成员不存在返回 false。读接口给任务 / 修订行补 proxy_only 用。
async function isProxyOnlyMember(q, memberId) {
  const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [memberId]);
  return !!m && m.user_id === null;
}
// 参与方 partyId 的现任负责人：生效任职 + 可作为确认人的成员；没有返回 null。proxyOnly = 该成员没有平台账号。
async function currentOwner(q, partyId, o) {
  const r = await q.get(
    `SELECT a.id AS appointment_id, a.member_id AS member_id, m.user_id AS user_id FROM sysbuild_appointments a
       JOIN sysbuild_members m ON m.id = a.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE a.party_id = ? AND a.status = 'active' AND ${eligibleSqlOf(o)} ORDER BY a.id DESC LIMIT 1`,
    [partyId]
  );
  return r ? { appointmentId: r.appointment_id, memberId: r.member_id, proxyOnly: r.user_id === null } : null;
}
// 参与方 partyId 的生效代表人（每方至多一位，uq_sysbuild_delegations_active）；没有返回 null。
async function currentDelegate(q, partyId) {
  const r = await q.get(
    `SELECT d.id AS delegation_id, d.member_id AS member_id, m.user_id AS user_id FROM sysbuild_delegations d
       JOIN sysbuild_members m ON m.id = d.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE d.party_id = ? AND d.status = 'active' AND ${CONFIRMER_ELIGIBLE_SQL} ORDER BY d.id DESC LIMIT 1`,
    [partyId]
  );
  return r ? { delegationId: r.delegation_id, memberId: r.member_id, proxyOnly: r.user_id === null } : null;
}
// 内容包的必需确认人集合：overall = 每个需求部门的负责人 + 生效代表人各一条；initiation = 每个需求部门的负责人一条（§4.2 前四行）。
//   返回 { noParty, entries: [{ partyId, kind: 'owner' | 'delegate', memberId, appointmentId, delegationId, proxyOnly }], missing: [文字] }。
//   proxyOnly = 该必需确认人没有平台账号（P44：任务只能由 PM 代录完成）。
//   C6a：批次验收包与总体规划包 / 变更包相同（§4.2 :609：每个需求部门负责人 + 生效代表人）；结项包只要每个需求部门的生效代表人（业务确认人，§4.2 :616），**不含负责人**。
const DELEGATE_CONFIRM_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing']);
async function resolvePackageConfirmers(q, projectId, packageType) {
  const parties = await q.all("SELECT id, name FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' ORDER BY sort_order, id", [projectId]);
  const out = { noParty: parties.length === 0, entries: [], missing: [] };
  for (const p of parties) {
    // 负责人一条：与历史行为一致，除结项包外的全部类型（含未列入白名单的类型，保持 C4a 起「每方负责人」的缺省）
    const wantOwner = packageType !== 'closing';
    const owner = wantOwner ? await currentOwner(q, p.id) : null;
    if (wantOwner && owner) out.entries.push({ partyId: p.id, kind: 'owner', memberId: owner.memberId, appointmentId: owner.appointmentId, delegationId: null, proxyOnly: owner.proxyOnly });
    else if (wantOwner) out.missing.push(`${p.name}（缺现任负责人）`);
    // C5 S-S1c：范围变更包的确认人与总体规划包相同（方案 §4.2「范围变更包 = 业务确认人 + 全部需求部门负责人」）：每个需求部门现任负责人 + 生效代表人
    if (DELEGATE_CONFIRM_PACKAGE_TYPES.includes(packageType)) {
      const dlg = await currentDelegate(q, p.id);
      if (dlg) out.entries.push({ partyId: p.id, kind: 'delegate', memberId: dlg.memberId, appointmentId: null, delegationId: dlg.delegationId, proxyOnly: dlg.proxyOnly });
      else out.missing.push(`${p.name}（缺生效代表人）`);
    }
  }
  return out;
}
// 必需确认人是否齐全（提交标志与提交执行共用，C4a 修订批二 MED-1）：齐全返回 null，否则 { noParty, missing }（noParty = 项目没有需求部门参与方；missing = 缺人的参与方文字）。
//   packages.js versionFactsOf 把它作为 confirmersMissing 放进提交的 target，rules.js package_version_submit 据此给出同文案的 409。
async function confirmersMissing(q, projectId, packageType) {
  const r = await resolvePackageConfirmers(q, projectId, packageType);
  if (r.noParty) return { noParty: true, missing: [] };
  return r.missing.length > 0 ? { noParty: false, missing: r.missing } : null;
}

// ── 资格复核（P27：decide 时核必需确认人此刻仍有资格）────────────────────────────────────────────────
// rev = 任务修订行（required_member_id / basis_appointment_id / basis_delegation_id）。仍有资格返回 null，否则返回原因文案（409 SYSBUILD_STATE）。
//   第一层 = 上面「可作为确认人」的同一份判定（成员已移出 / 未加入、账号不存在或已停用）；第二层 = 所依据的任职 / 授权仍生效且仍是这个人。
//   登记残余（C4a 修订批）：账号停用分支只能在进程内夹具测——真实实例的鉴权中间件会先拦下停用账号，打不到这里。
async function qualificationLoss(q, rev, o) {
  if (!(await eligibleMember(q, rev.required_member_id, o))) {
    const m = await q.get(
      'SELECT m.joined_at AS joined_at, m.removed_at AS removed_at FROM sysbuild_members m WHERE m.id = ?',
      [rev.required_member_id]
    );
    if (!m || m.removed_at !== null || m.joined_at === null) return '必需确认人已不是本项目成员，请联系项目经理改发';
    return '必需确认人的账号不可用，请联系项目经理改发';
  }
  if (rev.basis_appointment_id !== null) {
    const a = await q.get('SELECT status, member_id FROM sysbuild_appointments WHERE id = ?', [rev.basis_appointment_id]);
    if (!a || a.status !== 'active' || a.member_id !== rev.required_member_id) return '必需确认人所依据的负责人任职已不再生效，请联系项目经理改发';
  }
  if (rev.basis_delegation_id !== null) {
    const d = await q.get('SELECT status, member_id FROM sysbuild_delegations WHERE id = ?', [rev.basis_delegation_id]);
    if (!d || d.status !== 'active' || d.member_id !== rev.required_member_id) return '必需确认人所依据的代表人授权已不再生效，请联系项目经理改发';
  }
  return null;
}
// C6b 修订批 1（K1）：必需确认人**此刻**还能在平台上对这条待确认修订作出确认吗？站内「待我确认」（confirm.js myConfirmationItems）与钉钉发送侧（notify.js describeRef，首次发送 / 补发 / 就绪扫描）
//   共用这一个判定，不各写一份：项目对该用户可见 → 项目状态允许作出这类确认（办理结论确认 / 裁定按 resolve 类，其余按 accept 类；已终止 / 已结项的项目不列）→ 资格复核（qualificationLoss：成员已移出、账号停用、任职 / 授权失效）。
//   rev：{ project_id, purpose, required_member_id, basis_appointment_id, basis_delegation_id }；user：{ id, role }；accessOpts：{ readonlyIds, writeRoles }；cache：调用方在同一批里复用的对象（按项目缓存可见性与状态，可空）。
//   返回 null = 此刻还能确认，否则原因文案。o（可空）：{ ignoreAccountStatus: true } = 不把账号状态并进判定（只有钉钉发送侧传，见 eligibleSqlOf）。
async function confirmAvailabilityBlock(q, rev, user, accessOpts, cache, o) {
  const memo = cache || {};
  if (!Object.prototype.hasOwnProperty.call(memo, rev.project_id)) {
    const access = await rules.loadProjectAccess(q, rev.project_id, user, accessOpts);
    memo[rev.project_id] = {
      visible: rules.canViewProject(access), canDecide: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.confirm_decide),
      // C5：办理结论确认 / 裁定按 resolve 类判（已终止 / 已结项仍列出，方案 §4.5「既有登记的结论确认、异议、负责人裁定」），其余用途按 accept 类
      canResolve: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.entry_conclusion_decide),
    };
  }
  const info = memo[rev.project_id];
  if (!info.visible) return '收件人看不到该项目';
  if (!(ENTRY_TASK_PURPOSES.includes(rev.purpose) ? info.canResolve : info.canDecide)) return '项目当前状态不允许作出这项确认';
  return qualificationLoss(q, rev, o);
}

// ── P36 同一人不能在同一参与方同时以负责人和代表人身份确认 ────────────────────────────────────────────
// 已确认的修订保持有效（确认记录绑定当时的修订与版本，不变量 5）；但改发时若解析出的新人已在本版本、同一参与方的另一类任务上确认过，改发 409。
//   P42（主会话 11-01 裁定，登记不改逻辑）：这条冲突只看**同一参与方**——同一时刻一个用户只有一条未移出的成员行（所以只属于一个参与方），同一人在本版本的
//   不同参与方各确认一次，意味着他先后在不同部门任职（先在甲部确认、移出后到乙部再确认），这是接受的；不跨参与方拦。
//   task = 被改发任务行（object_version_id / party_id / id）；memberId = 改发后的必需确认人成员。返回冲突时 true。
//   C4b P44：「同一人」= 有账号时同一 user_id；无账号时同一 member_id（无账号成员的 user_id 都是空，不能互相等同）。
async function confirmedOnOtherRoleBySameUser(q, task, memberId) {
  const me = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [memberId]);
  if (!me) return false;
  const rows = await q.all(
    `SELECT m.id AS member_id, m.user_id AS user_id FROM sysbuild_confirm_tasks t
       JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND t.purpose = 'package_confirm' AND t.party_id = ? AND t.id <> ?
        AND r.status = 'confirmed' AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)`,
    [task.object_version_id, task.party_id, task.id]
  );
  return rows.some((r) => (me.user_id !== null ? r.user_id === me.user_id : r.member_id === memberId));
}

// ── 任务与修订 ─────────────────────────────────────────────────────────────────────────────────
// 新建一条确认任务 + 首条修订（rev_no = 1，待确认）。o：projectId、objectType、objectId、objectVersionId、purpose、partyId（可空）、
//   requiredMemberId、basisAppointmentId / basisDelegationId（可空）。返回 { taskId, revisionId }。
//   C6b：同一事务里给必需确认人写一条发送意图（有平台账号的；无账号成员不建，notify-core.enqueueRevisionIntent）。所有新任务都经本函数（内容包提交 / 提出人 / 结论 / 裁定 / 开发方认可 / 交接确认），
//   所以首修订的通知挂在这一处；o.notify === false = 修订当场就被确认或代录（本人提交并确认、代录），不发「请确认」。
async function createTaskWithRevision(q, user, o) {
  const uid = Number(user.id);
  const t = await q.run(
    'INSERT INTO sysbuild_confirm_tasks (project_id, object_type, object_id, object_version_id, purpose, party_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [o.projectId, o.objectType, o.objectId, o.objectVersionId, o.purpose, o.partyId === undefined ? null : o.partyId, uid]
  );
  const r = await q.run(
    "INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, created_by) VALUES (?, 1, ?, ?, ?, 'pending', ?)",
    [t.lastID, o.requiredMemberId, o.basisAppointmentId || null, o.basisDelegationId || null, uid]
  );
  await emit(q, user, o.projectId, 'confirm_task', t.lastID, 'confirm_task_created', {
    revision_id: r.lastID, rev_no: 1, object_type: o.objectType, object_id: o.objectId, object_version_id: o.objectVersionId, purpose: o.purpose,
    party_id: o.partyId === undefined ? null : o.partyId, required_member_id: o.requiredMemberId,
    basis_appointment_id: o.basisAppointmentId || null, basis_delegation_id: o.basisDelegationId || null,
  });
  if (o.notify !== false) await notifyCore.enqueueRevisionIntent(q, { projectId: o.projectId, revisionId: r.lastID, requiredMemberId: o.requiredMemberId });
  return { taskId: t.lastID, revisionId: r.lastID };
}

// 任务当前修订 = rev_no 最大的一条。
async function latestRevision(q, taskId) {
  return q.get(
    `SELECT id, task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, status_reason, created_by, created_at, updated_at
       FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1`,
    [taskId]
  );
}

// 把一条待确认修订置为 superseded / invalid（status_reason 必填，库内 CHECK 要求）；条件更新带「status = 'pending'」，影响行数 0 → 409。
async function closePendingRevision(q, revisionId, to, reason) {
  const r = await q.run(
    "UPDATE sysbuild_confirm_task_revisions SET status = ?, status_reason = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
    [to, reason, revisionId]
  );
  if (r.changes === 0) throw stateError('确认任务修订状态已变化，请刷新后重试');
}

// P38 终止项目：本项目全部待确认修订（内容包任务与条目提出人任务）→ 已失效。projects.js 在转入 terminated 的同一事务里调用。返回被失效的修订编号数组。
//   C4b 交接（主会话 11-01 裁定）：终止后已失效的**提出人**修订（条目版本任务）C4a 的改发不接（改发只开放内容包任务）；项目重开后由 C4b 的改发 / 代录接住（C4b P48：改发已放开到提出人任务）。
//   C5 S-S1a（方案 §4.5「既有登记的结论确认、异议、负责人裁定」在已终止 / 已结项仍可做）：只失效下面白名单用途（内容包 / 提出人 / 邀请授权类）的待确认修订；
//   办理结论确认（conclusion_confirm）与负责人裁定（adjudicate）不在失效表里，终止项目后仍是待确认、仍可决策。
//   L1（预筛修订批）：两张表必须把 schema.ENUMS.confirmPurpose 的每个值恰好分到一张里（全分类，模块加载时断言）——新增确认用途漏登记 = 加载即抛，不会因「不在白名单」而被静默放过（或静默失效）。
//   失效表 = 内容包 / 提出人 / 邀请授权类 + 开发方关键事项（推进类确认，终止后不可作出）+ 运维交接接收；保留表 = 办理结论确认与负责人裁定（§4.5「既有登记的结论确认、异议、负责人裁定」终止后仍可做）。
//   C6a：交接确认（接受带此问题上线 / 不再处理）是推进类确认（方案 §4.5「作出推进类确认」，已终止 / 已结项不可作出），归失效表。
const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm', 'proposer_confirm', 'accept_invitation', 'delegation_grant', 'delegation_accept', 'dev_key_confirm', 'handover_accept', 'handover_accept_issue', 'handover_no_further']);
const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze(['conclusion_confirm', 'adjudicate']);
// all = 全部确认用途（schema 枚举）；invalidated / retained = 两张表。每个 all 里的值必须恰好在一张表里，且两张表里没有 all 之外的值，否则抛错。
function assertTerminatePurposeClassification(all, invalidated, retained) {
  for (const p of all) {
    const n = (invalidated.includes(p) ? 1 : 0) + (retained.includes(p) ? 1 : 0);
    if (n !== 1) throw new Error(`confirm-core.js: 确认用途 ${p} 在「终止失效」「终止保留」两张表里${n === 0 ? '都没有登记' : '重复登记'}`);
  }
  for (const p of [...invalidated, ...retained]) {
    if (!all.includes(p)) throw new Error(`confirm-core.js: 终止分类表里的 ${p} 不是 schema 登记的确认用途`);
  }
}
assertTerminatePurposeClassification(schema.ENUMS.confirmPurpose, INVALIDATED_ON_TERMINATE_PURPOSES, RETAINED_ON_TERMINATE_PURPOSES);
async function invalidatePendingRevisionsOfProject(q, user, projectId, reason) {
  // 白名单在 JS 里过滤（SQL 的 WHERE 保持原样：C4a P38 的变异锚点钉在这句上）
  const rows = (await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id, t.object_type AS object_type, t.object_version_id AS object_version_id, t.purpose AS purpose
       FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.project_id = ? AND r.status = 'pending' ORDER BY r.id`,
    [projectId]
  )).filter((r) => INVALIDATED_ON_TERMINATE_PURPOSES.includes(r.purpose));
  for (const row of rows) {
    await closePendingRevision(q, row.revision_id, 'invalid', reason);
    await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_invalidated', {
      revision_id: row.revision_id, object_type: row.object_type, object_version_id: row.object_version_id, reason,
    });
  }
  return rows.map((r) => r.revision_id);
}

// ── P29 需求条目提出人确认 ─────────────────────────────────────────────────────────────────────────
// 条目版本创建时调用：提出人是本项目「可作为确认人」的成员（同上唯一判定：已加入未移出，且有平台账号并 active，或无账号——C4b P44 / P46：无账号成员也生成，只能代录）→
//   生成任务（object_type item_version、purpose proposer_confirm、object_id = 条目编号、object_version_id = 条目版本编号）与首条修订，并冻结该条目版本的附件清单。
//   只填姓名（没有成员编号，P47）/ 成员已不在 / 账号已停用 → 不生成，返回 null；补救 = PM 把此人登记为无账号成员后出条目新版本。
//   P39（主会话 11-01 裁定）：提出人就是项目负责人（PM）本人时照常生成并由其本人确认（方案 §5.2 提出人列优先）；「本人提交并确认」（self_submit）
//   留 C5 与关键事项一起做。
//   P33（主会话 11-01 裁定保持现状）：任务生成时就冻结该条目版本的附件清单——依据不变量 9「对象提交确认即冻结」，提出人确认的对象是条目版本，
//   生成任务就是提交确认。后果：这些附件之后只能受控遮蔽（masked），不能软删除；包提交时对同一批附件另按包版本再冻结一份。
async function createProposerTask(q, user, o) {
  if (o.proposerMemberId === null || o.proposerMemberId === undefined) return null;
  const m = await eligibleMember(q, o.proposerMemberId);
  if (!m) return null;
  const own = await q.get('SELECT id FROM sysbuild_members WHERE id = ? AND project_id = ?', [m.id, o.projectId]);
  if (!own) return null;
  // C4b Q-S2（P58）：历史补录窗口开启期间，该条目已有历史补录记录 → 不生成新的当前任务（窗口关闭后由 PM 对条目出新版本接上；改发在窗口开启期间同样被互斥拦下，没有改发出路）。
  if ((await itemHistoryConflict(q, o.projectId, o.itemId)) !== null) return null;
  await o.attachmentHelpers.freezeAttachmentSet(q, {
    objectType: 'item_version', objectVersionId: o.itemVersionId, ownerType: 'item_version', ownerId: o.itemVersionId,
    operatorId: Number(user.id), operatorName: operatorNameOf(user), projectId: o.projectId,
  });
  return createTaskWithRevision(q, user, {
    projectId: o.projectId, objectType: 'item_version', objectId: o.itemId, objectVersionId: o.itemVersionId, purpose: 'proposer_confirm',
    partyId: m.party_id, requiredMemberId: m.id, basisAppointmentId: null, basisDelegationId: null,
  });
}
// 同一条目出新版本时，旧版本仍待确认的提出人修订 → superseded（原因「条目已有新版本」）。返回被替代的修订条数。
async function supersedeProposerRevisions(q, user, projectId, itemId, newVersionId) {
  const rows = await q.all(
    `SELECT r.id AS revision_id, t.id AS task_id, t.object_version_id AS object_version_id FROM sysbuild_confirm_task_revisions r
       JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.object_type = 'item_version' AND t.object_id = ? AND t.object_version_id <> ? AND r.status = 'pending' ORDER BY r.id`,
    [itemId, newVersionId]
  );
  for (const row of rows) {
    await closePendingRevision(q, row.revision_id, 'superseded', ITEM_SUPERSEDED_REASON);
    await emit(q, user, projectId, 'confirm_task', row.task_id, 'confirm_revision_superseded', {
      revision_id: row.revision_id, object_version_id: row.object_version_id, reason: ITEM_SUPERSEDED_REASON, new_item_version_id: newVersionId,
    });
  }
  return rows.length;
}

// ── 总体排期基线来源（P34，方案 §3.1：总体排期基线是确认对象）────────────────────────────────────────
// 提交总体规划包时记录各未取消节点「当时的当前计划」（当前计划 = baseline 与 plan_change 中最后一条），按节点编号升序，写进提交事件 payload 的 node_plans；
//   总体规划待确认期间节点排期与取消节点被拒（rules.js OVERALL_PENDING_PLAN_MESSAGE），所以生效时形成的基线必须与这份记录一致，不一致 fail-closed（formBaselines）。
//   codex 19 号 H-2：这份记录同时是**确认页展示排期的唯一来源**——确认人看到的名称 / 层 / 批次 / 模板都取自提交时的快照，不取节点现值（待确认期间节点可改名，
//   现值会让先后打开的确认人看到不同的排期内容）。每项 = { node_id, name, layer（project / batch）, batch_id, batch_name, template_key, planned_start, planned_end }；
//   生效核对（formBaselines）仍只按 node_id + 日期。
async function currentNodePlans(q, projectId) {
  const nodes = await q.all(
    `SELECT n.id AS id, n.name AS name, n.template_key AS template_key, n.batch_id AS batch_id, b.name AS batch_name
       FROM sysbuild_nodes n LEFT JOIN sysbuild_batches b ON b.id = n.batch_id WHERE n.project_id = ? AND n.status <> 'cancelled' ORDER BY n.id`,
    [projectId]
  );
  const out = [];
  for (const n of nodes) {
    const cur = await q.get(
      "SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1",
      [n.id]
    );
    if (cur) {
      out.push({
        node_id: n.id, name: n.name, layer: n.batch_id === null ? 'project' : 'batch', batch_id: n.batch_id, batch_name: n.batch_name,
        template_key: n.template_key, planned_start: cur.planned_start, planned_end: cur.planned_end,
      });
    }
  }
  return out;
}

// ── 提交前置「计划齐全」（codex 19 号 H-1 / P43）─────────────────────────────────────────────────────
// 总体排期基线是确认对象（方案 §3.1）：基线只能来自被确认的计划，所以总体规划包提交前，应形成基线的节点必须已有当前计划（当前计划 = baseline 与 plan_change 中最后一条）——
//   合并形态（form = overall_batch_req，单批合并承载批次需求）= 项目内全部未取消节点（项目层 + 批次层）；普通形态（overall）= 项目层未取消节点。
//   form 用 packages.js computeFormAndParent 的提交时重算值（P32），不用草稿存的值。齐全返回 null，否则返回缺计划节点的标签数组（项目层 = 节点名，批次层 = 节点名（批次名）），
//   packages.js versionFactsOf 把它作为 planMissing 放进提交的 target，rules.js package_version_submit 据此给出 409（标志与执行同源，事实缺失 fail-closed）。
//   登记（没把握）：合并形态按字面包含「已转出 / 被替代批次」里未取消的节点——这些节点不能再设计划也不能取消，会让提交永远被挡；第一期没有生产路径产生这样的批次
//   （转出 / 被替代 C6 才有），开放时须改为排除冻结批次的节点（同步改 currentNodePlans 的对应口径）。
async function planMissingNodes(q, projectId, form) {
  const scope = form === 'overall_batch_req' ? '' : ' AND n.batch_id IS NULL';
  const rows = await q.all(
    `SELECT n.name AS name, n.batch_id AS batch_id, b.name AS batch_name FROM sysbuild_nodes n LEFT JOIN sysbuild_batches b ON b.id = n.batch_id
      WHERE n.project_id = ? AND n.status <> 'cancelled'${scope}
        AND NOT EXISTS (SELECT 1 FROM sysbuild_node_schedule_records r WHERE r.node_id = n.id AND r.kind IN ('baseline', 'plan_change'))
      ORDER BY CASE WHEN n.batch_id IS NULL THEN 0 ELSE 1 END, n.batch_id, n.sort_order, n.id`,
    [projectId]
  );
  return rows.length === 0 ? null : rows.map((r) => (r.batch_id === null ? r.name : `${r.name}（${r.batch_name}）`));
}
// 版本 versionId 提交时记录的节点计划清单；没有提交事件或事件里没有清单 → null。
async function submittedNodePlans(q, versionId) {
  let ev = await q.get(
    "SELECT payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted' ORDER BY id DESC LIMIT 1",
    [versionId]
  );
  // C4b Q-S2 MED-2：历史事实导入生效的版本没有提交事件，导入事务把当时的节点计划清单（与提交事件同形）写进 history_fact_imported 的 node_plans，这里作为只读后备来源。
  if (!ev) {
    ev = await q.get(
      "SELECT payload_json FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'history_fact_imported' ORDER BY id DESC LIMIT 1",
      [versionId]
    );
  }
  // 修订批 3 M2：变更生效派生的总体规划版本既没有提交事件也没有导入事件，它的节点计划快照 = 来源变更提交时记录的那份，生效事务把它写进 change_effective 事件（payload.node_plans，
  //   payload.new_overall_version_id = 本版本）；这里作为第三个只读后备。事件挂在 change 对象上，按项目圈定后在 JS 里按 new_overall_version_id 精确匹配（不用 SQL 层 json_extract 做谓词）。
  if (!ev) {
    const owner = await q.get('SELECT p.project_id AS project_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE v.id = ?', [versionId]);
    if (owner) {
      const evs = await q.all("SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND object_type = 'change' AND event_type = 'change_effective' ORDER BY id DESC", [owner.project_id]);
      for (const e of evs) {
        let p = null;
        try { p = JSON.parse(e.payload_json); } catch (_) { p = null; }
        if (p && p.new_overall_version_id === versionId) { ev = e; break; }
      }
    }
  }
  if (!ev) return null;
  let payload = null;
  try { payload = JSON.parse(ev.payload_json); } catch (_) { return null; }
  return payload && Array.isArray(payload.node_plans) ? payload.node_plans : null;
}

// ── 内容包生效与基线（P28）────────────────────────────────────────────────────────────────────────────
// 内容包版本 ver（status = pending）的全部必需任务当前修订都已确认？tasks 为空视为未满足（提交时必然生成任务，没有任务的版本不生效）。
//   P36 防御：同一参与方的各任务当前修订的确认人必须是不同的人，否则不生效（正常路径下改发已拦下，这里是兜底）。C4b P44：「同一人」有账号时按 user_id，
//   无账号时按 member_id（`m:<member_id>`）——两个无账号成员的 user_id 都是空，按 user_id 去重会把他们误判成同一人。
//   本函数只看当前修订的状态，不读 confirmations.method：平台确认与代录确认同等计入通过。
async function allPackageTasksConfirmed(q, versionId) {
  const rows = await q.all(
    `SELECT t.id AS task_id, t.party_id AS party_id, r.status AS status, m.user_id AS user_id, m.id AS member_id
       FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id JOIN sysbuild_members m ON m.id = r.required_member_id
      WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND t.purpose = 'package_confirm'
        AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)`,
    [versionId]
  );
  if (!(rows.length > 0 && rows.every((r) => r.status === 'confirmed'))) return false;
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.party_id}:${r.user_id !== null ? r.user_id : `m:${r.member_id}`}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

// 总体规划包版本生效时形成基线：项目内每个未取消、尚无 baseline、且有当前计划（最后一条 plan_change）的节点，写一条 baseline（planned = 当前计划，
//   引用本版本）；已有 baseline 的节点不动（基线不可覆盖，且库内每节点至多一条）。返回形成基线的节点编号数组。
//   P41（主会话 11-01 裁定，不改代码）C5 / 第二期交接：第一期单批，批次层节点的基线随总体规划包（合并形态，承载批次需求，P19）一并形成；开放多批次后，
//   批次层节点基线应随各自批次需求包生效形成，本函数现在按「项目内全部节点」一并处理，须改为按批次重审（C5 / 第二期立项时处理）。
//   P34 fail-closed 双向核对（修订批二 LOW-1 / LOW-2）：
//     正向：每个将形成基线的节点（无基线、未取消、有当前计划）其当前计划必须与提交事件里记录的 node_plans 逐项一致（总体规划待确认期间排期被冻结，
//       正常路径不可能不一致）；没有提交记录（recorded === null）时**只有存在需要形成基线的节点**才 500，否则正常生效——为 C5 变更包生效复用本函数留口
//       （变更包生效时可能没有节点需要形成基线，也没有 node_plans）；
//     反向：提交记录里的每个节点，生效时必须已有基线或本次形成了基线，两者都没有（节点已取消，或当前计划没了）→ 500。
//     任一不通过 → 500 SYSBUILD_INTERNAL，整个生效事务回滚。
//   C4b Q-S2：recordedOverride（可选）= 调用方现取的节点计划清单（currentNodePlans 的结果）。历史事实导入的内容包生效没有「提交事件」（版本没经过待确认），
//     导入事务里先取这份清单再调本函数，核对逻辑与普通路径完全相同（清单与现状必然一致，导入者对计划的认可由 P56 的前置「计划齐全」与凭据承担）；缺省（undefined）= 读提交事件。
async function formBaselines(q, user, projectId, versionId, recordedOverride) {
  const nodes = await q.all(
    `SELECT n.id AS id FROM sysbuild_nodes n
      WHERE n.project_id = ? AND n.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM sysbuild_node_schedule_records r WHERE r.node_id = n.id AND r.kind = 'baseline')
      ORDER BY n.id`,
    [projectId]
  );
  // 将形成基线的节点 = 上面的节点里有当前计划（最后一条 plan_change）的
  const toForm = [];
  for (const n of nodes) {
    const cur = await q.get(
      "SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'plan_change' ORDER BY id DESC LIMIT 1",
      [n.id]
    );
    if (!cur) continue;
    toForm.push({ id: n.id, cur });
  }
  const recorded = recordedOverride !== undefined ? recordedOverride : await submittedNodePlans(q, versionId);
  if (recorded === null && toForm.length > 0) throw internalError('总体规划提交事件缺少节点计划记录，无法核对基线来源');
  const formed = [];
  for (const { id, cur } of toForm) {
    const rec = (recorded || []).find((x) => x.node_id === id);
    if (!rec || rec.planned_start !== cur.planned_start || rec.planned_end !== cur.planned_end) {
      throw internalError(`节点 #${id} 的当前计划与总体规划提交时的记录不一致，基线不能形成`);
    }
    const ins = await q.run(
      "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, package_version_id, created_by) VALUES (?, 'baseline', ?, ?, ?, ?)",
      [id, cur.planned_start, cur.planned_end, versionId, Number(user.id)]
    );
    await emit(q, user, projectId, 'node', id, 'baseline_formed', {
      record_id: ins.lastID, package_version_id: versionId, planned_start: cur.planned_start, planned_end: cur.planned_end, via: 'package_effective',
    });
    formed.push(id);
  }
  for (const rec of recorded || []) {
    if (formed.includes(rec.node_id)) continue;
    const has = await q.get("SELECT id FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline' LIMIT 1", [rec.node_id]);
    if (!has) throw internalError(`节点 #${rec.node_id} 在总体规划提交时有计划记录，生效时却既没有基线、也不能形成基线（节点已取消或当前计划已变化）`);
  }
  return formed;
}

// 最后一条必需任务的当前修订变为已确认时调用（同一事务内）：版本 pending → effective，同包原生效版本 → superseded，总体规划包形成基线。
//   尚有任务未确认时什么也不做。返回 { effective: boolean, superseded: [版本编号], baselineNodes: [节点编号], advancedBatches: [批次编号] }。
//   登记残余（C4a 修订批）：sysbuild_package_versions.status 有 draft / pending / effective / superseded 四种合法旧状态，放不进 CONDITIONAL_UPDATES 的单片段白名单，
//   所以本文件与 confirm.js 里每处写 status 的 UPDATE 都自己带旧状态条件（WHERE … AND status = '…'）并核影响行数，静态守卫（S2）不覆盖这几处。
async function takeEffectIfComplete(q, user, projectId, pkg, ver) {
  if (!(await allPackageTasksConfirmed(q, ver.id))) return { effective: false, superseded: [], baselineNodes: [], advancedBatches: [] };
  return applyPackageEffect(q, user, projectId, pkg, ver, { effectiveAt: null, recordedPlans: undefined });
}
// 版本 ver（status = pending）生效的写入部分：普通路径（takeEffectIfComplete，全部必需任务已确认）与历史事实导入（history.js package_effective，C4b Q-S2）共用，不复制。
//   o.effectiveAt：生效时刻文本（'YYYY-MM-DD HH:MM:SS'，历史导入写原日期 00:00:00，P54）；null = 此刻。o.recordedPlans：交给 formBaselines 的节点计划清单（见其注释），undefined = 读提交事件。
async function applyPackageEffect(q, user, projectId, pkg, ver, o) {
  await materialsCore.assertMaterialFreezes(q, projectId, ver);
  // 先让同包原生效版本退位（库内每包至多一个 effective 版本，uq_sysbuild_package_versions_effective）。
  const olds = await q.all("SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND status = 'effective' AND id <> ? ORDER BY id", [pkg.id, ver.id]);
  for (const old of olds) {
    const r = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'effective'", [old.id]);
    if (r.changes === 0) throw stateError('内容包版本状态已变化，请刷新后重试');
    await emit(q, user, projectId, 'package_version', old.id, 'package_version_superseded', { package_id: pkg.id, replaced_by: ver.id });
  }
  const up = await q.run(
    "UPDATE sysbuild_package_versions SET status = 'effective', effective_at = COALESCE(?, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
    [o.effectiveAt, ver.id]
  );
  if (up.changes === 0) throw stateError('内容包版本状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'package_version', ver.id, 'package_version_effective', { package_id: pkg.id, version_no: ver.version_no, replaced: olds.map((x) => x.id) });
  // C5 S-S1c：变更包生效 = 同一事务生成新的完整总体规划版本（单一来源，不变量 2 / 10），基线随新总体版本形成，不推进批次（第一期单批已在进行中）
  if (pkg.type === 'change') {
    const ce = await applyChangeEffect(q, user, projectId, pkg, ver);
    return { effective: true, superseded: olds.map((x) => x.id), baselineNodes: ce.baselineNodes, advancedBatches: [], newOverallVersionId: ce.newOverallVersionId, oldOverallVersionId: ce.oldOverallVersionId };
  }
  const baselineNodes = pkg.type === 'overall' ? await formBaselines(q, user, projectId, ver.id, o.recordedPlans) : [];
  const advancedBatches = pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(q, user, projectId, ver.id) : [];
  return { effective: true, superseded: olds.map((x) => x.id), baselineNodes, advancedBatches };
}
// 变更包版本 ver（刚置为 effective）带来的写入（C5 S-S1c，applyPackageEffect 在 pkg.type = change 时调用，同一事务）：
//   ① 找到对应的变更（待确认、当前送审版本就是 ver）与总体规划包的现行生效版本 oldEff；ver 的继承来源必须就是 oldEff（提交时已核、同时至多一个待确认变更，这里再核一次，不一致 409 回滚——不静默覆盖别的变更的结果）；
//   ② oldEff → superseded，新建总体规划包版本（version_no + 1、effective、生效时刻 = 变更包版本的生效时刻、form 照 oldEff、parent 空、snapshot_json = 变更包版本快照），条目集合 = 变更包版本折叠集合（逐条写 add 修订）；
//   ③ 基线：按变更提交时记录的 node_plans 核对（formBaselines），已有基线的节点不动，基线引用新总体规划版本；④ changes.status → effective；⑤ 事件 change_effective（含新旧总体版本号）。
async function applyChangeEffect(q, user, projectId, pkg, ver) {
  await materialsCore.assertMaterialFreezes(q, projectId, ver);
  const { foldRevisions, setList } = require('./packages'); // 惰性引用：packages.js 顶层引用本文件，顶层互引会成环；调用时两边都已加载完
  const change = await q.get('SELECT id, status, package_version_id FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);
  if (!change || change.status !== 'pending' || change.package_version_id !== ver.id) throw internalError('变更包版本生效时找不到对应的待确认变更');
  const overallPkg = await q.get("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'overall'", [projectId]);
  const oldEff = overallPkg ? await q.get("SELECT id, version_no, form FROM sysbuild_package_versions WHERE package_id = ? AND status = 'effective'", [overallPkg.id]) : null;
  if (!oldEff) throw internalError('变更生效时项目没有生效的总体规划版本');
  // 防御（预筛 Q5，生产不可达）：提交时 parentSuperseded 已核、同一项目同一时刻至多一个待确认变更、总体规划包的生效版本只由变更生效（或历史导入，窗口内与变更互斥）替换，
  //   所以待确认变更生效时继承来源恒等于现行总体版本。留着只为库内数据自相矛盾时 409 回滚而不是静默覆盖别的变更的结果。
  if (ver.parent_overall_version_id !== oldEff.id) throw stateError('现行总体规划已被替代，该变更基于旧版本，请撤回后基于现行规划重新提交');
  const verRow = await q.get('SELECT snapshot_json, effective_at FROM sysbuild_package_versions WHERE id = ?', [ver.id]);
  const revRows = await q.all(
    `SELECT r.id AS id, r.op AS op, r.item_version_id AS item_version_id, r.committed_batch_id AS committed_batch_id, iv.item_id AS item_id
       FROM sysbuild_package_item_revisions r JOIN sysbuild_item_versions iv ON iv.id = r.item_version_id WHERE r.package_version_id = ? ORDER BY r.id`,
    [ver.id]
  );
  const set = setList(foldRevisions(revRows));
  // P169（冻结保证在「写入生效」这一刻成立，不只在提交时）：提交之后批次可能已上线（历史导入、夹具等），生效前再核一次——新总体规划版本里承诺到已上线批次的条目版本集合必须与
  //   生效前现行规划里完全相同（判定与提交时集合重核共用 entries-core.liveFreezeBreaches）。违反 409，整笔回滚（变更版本仍待确认、任务修订不变，可撤回）。
  const { resolveCurrentPlan } = require('./packages');
  const breaches = await require('./entries-core').liveFreezeBreaches(q, (await resolveCurrentPlan(q, projectId)).byItem, set);
  if (breaches.frozen.length > 0 || breaches.removed.length > 0) throw stateError('已上线批次的承诺条目已冻结，变更不能生效，请撤回该变更');
  const maxNo = await q.get('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [overallPkg.id]);
  const sup = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'effective'", [oldEff.id]);
  if (sup.changes === 0) throw stateError('内容包版本状态已变化，请刷新后重试');
  const ins = await q.run(
    "INSERT INTO sysbuild_package_versions (package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json, created_by) VALUES (?, ?, NULL, ?, 'effective', ?, ?, ?)",
    [overallPkg.id, maxNo.n + 1, oldEff.form, verRow.effective_at, verRow.snapshot_json, Number(user.id)]
  );
  const newId = ins.lastID;
  for (const it of set) {
    await q.run(
      "INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)",
      [newId, it.item_version_id, it.committed_batch_id, Number(user.id)]
    );
  }
  await emit(q, user, projectId, 'package_version', oldEff.id, 'package_version_superseded', { package_id: overallPkg.id, replaced_by: newId, via: 'change', change_id: change.id });
  await emit(q, user, projectId, 'package_version', newId, 'package_version_effective', {
    package_id: overallPkg.id, version_no: maxNo.n + 1, replaced: [oldEff.id], via: 'change', change_id: change.id, change_version_id: ver.id, item_count: set.length,
  });
  // 修订批 3 M1（codex 26）：变更提交时冻结的附件清单（条目附件、包附件、方向类证据，挂 (package_version, 变更版本)）逐行复制给新总体规划版本——编号与 sha256 照抄冻结时的值，不读附件现值——
  //   这样现行总体规划的冻结清单（确认单导出 / 冻结附件读取都按版本编号取）与确认人当时看到的一致。
  const frozenRows = await q.all('SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = ? AND object_version_id = ? ORDER BY attachment_id', ['package_version', ver.id]);
  for (const f of frozenRows) {
    await q.run('INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES (?, ?, ?, ?)', ['package_version', newId, f.attachment_id, f.sha256]);
  }
  await materialsCore.assertMaterialFreezes(q, projectId, { id: newId });
  // 修订批 3 M2：变更提交时记录的节点计划（node_plans）写进 change_effective 事件，新总体版本没有自己的提交事件，submittedNodePlans 对它按这个事件回退读取（只读后备，与历史导入事件同口径）
  const submittedPlans = await submittedNodePlans(q, ver.id);
  const baselineNodes = await formBaselines(q, user, projectId, newId, await submittedNodePlans(q, ver.id));
  const up = await q.run("UPDATE sysbuild_changes SET status = 'effective', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [change.id]);
  if (up.changes === 0) throw stateError('变更状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'change', change.id, 'change_effective', Object.assign({
    change_id: change.id, change_version_id: ver.id, old_overall_version_id: oldEff.id, old_overall_version_no: oldEff.version_no,
    new_overall_version_id: newId, new_overall_version_no: maxNo.n + 1, item_count: set.length, baseline_node_ids: baselineNodes,
  }, submittedPlans === null ? {} : { node_plans: submittedPlans }));
  return { newOverallVersionId: newId, oldOverallVersionId: oldEff.id, baselineNodes };
}

// 合并包生效推进批次（codex 19 号 M-1）：单批项目的批次需求由总体规划包的合并形态（overall_batch_req，P19）承载，方案「批次需求包生效后批次进入进行中」——
//   所以合并形态的总体规划版本生效的同一事务里，本项目「规划中」的批次条件更新为「进行中」（WHERE 带 status = ?，旧值 'planning'，schema.js CONDITIONAL_UPDATES 登记），核影响行数，
//   每个批次写一条 batch_status_changed 事件。已是进行中 / 已上线 / 已转出 / 被替代的批次不在选取范围内（不重复写）。不要求先「开始」任何节点。
//   C3 的节点开始端点没有推进批次状态的逻辑（plan.js 只改节点），所以没有可复用的函数，这里是批次状态推进的唯一落点。
//   C5 / 第二期交接：开放多批次后批次需求包（batch_req）生效按各自批次推进，本函数按「合并形态」判定，届时改为按包所挂批次处理。
async function advancePlanningBatches(q, user, projectId, versionId) {
  const rows = await q.all("SELECT id FROM sysbuild_batches WHERE project_id = ? AND status = 'planning' ORDER BY seq, id", [projectId]);
  for (const b of rows) {
    const r = await q.run('UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['active', b.id, 'planning']);
    if (r.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
    await emit(q, user, projectId, 'batch', b.id, 'batch_status_changed', { from: 'planning', to: 'active', via: 'package_effective', package_version_id: versionId });
  }
  return rows.map((b) => b.id);
}

// ── C4b 代录（派单 Q-S1：P45 / P49 / P50）──────────────────────────────────────────────────────────────
// 三个代录端点（confirm.js 的 /confirm-tasks/:tid/proxy、membership.js 的 /appointments/:aid/proxy-accept 与 /delegations/:did/proxy）共用的
//   请求体解析、外部日期范围、修订终态写入与确认记录写入。代录确认记录：method = 'proxy'、actor_user_id = 必需确认人的 user_id（无账号为空）、proxy_by = 操作的 PM、
//   外部确认日期 / 实际确认人 / 身份依据必填、checkbox_text 与 view_id 为空（库内 CHECK 已要求）；至少一个本人暂存的凭据附件以 owner_type = confirmation 绑定。
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const PROXY_CONFIRMER_MAX = 100;
const PROXY_BASIS_MAX = 500;
const PROXY_KEYS = Object.freeze(['external_date', 'actual_confirmer', 'identity_basis', 'attachment_ids']);
function validDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
function localDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function readProxyText(raw, field, label, max) {
  if (raw === undefined || raw === null) throw invalid(`${label}必填`, field);
  if (typeof raw !== 'string') throw invalid(`${label}必须是文本`, field);
  const v = raw.trim();
  if (v === '') throw invalid(`${label}必填`, field);
  if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field);
  if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
  return v;
}
// 解析代录请求体里的四个凭据字段（形态校验，400）；日期范围与附件可用性另在写事务里校验（assertProxyDate / bindStagedAttachments）。
//   what = 动作名（代录 / 历史补录），写进「必须附至少 1 个凭据附件」的 400 文案（预筛 LOW-2：文案按实际动作说）；缺失 → 500，不静默沿用别的动作名。
function readProxyEvidence(body, what) {
  if (typeof what !== 'string' || what === '') throw internalError('凭据解析缺动作名');
  const d = body.external_date;
  if (d === undefined || d === null || d === '') throw invalid('外部确认日期必填', 'external_date');
  if (!validDate(d)) throw invalid('外部确认日期必须是 YYYY-MM-DD 格式的有效日期（2000–2099）', 'external_date');
  const actualConfirmer = readProxyText(body.actual_confirmer, 'actual_confirmer', '实际确认人', PROXY_CONFIRMER_MAX);
  const identityBasis = readProxyText(body.identity_basis, 'identity_basis', '身份依据', PROXY_BASIS_MAX);
  return { externalDate: d, actualConfirmer, identityBasis, attachmentIds: readEvidenceAttachmentIds(body.attachment_ids, what) };
}
// 凭据附件编号列表的形态校验（至少 1 个、编号合法、不重复）：代录 / 历史补录 / 历史导入的凭据与时间窗动作的凭据共用；what = 动作名，写进 400 文案。
function readEvidenceAttachmentIds(raw, what) {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid(`${what}必须附至少 1 个凭据附件`, 'attachment_ids');
  const attachmentIds = raw.map((v) => {
    const id = rules.parseId(v);
    if (!id) throw invalid('附件编号不合法', 'attachment_ids');
    return id;
  });
  if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('附件编号重复', 'attachment_ids');
  return attachmentIds;
}
// 外部确认日期范围（P49）：不晚于今天（服务器本地日期，today 由调用方注入），不早于 floorAt 的日期部分（本修订 / 提议 / 对象版本的创建时间，库内 'YYYY-MM-DD HH:MM:SS'）。
//   floor 取「对象出现的那一天」：凭据日期早于它不可能对应这个版本 / 提议。floorLabel = 下限的名称，写进 400 文案（codex 21 号 / 预筛 L3：不同调用点的下限含义不同——
//   修订创建日 / 任职提议创建日 / 授权提议创建日 / 负责人批准日 / 对象版本创建日，文案不再统称「创建日期」）。
//   NO_DATE_FLOOR = 显式「没有下限」（C4b Q-S2 历史事实导入：原日期只要求不晚于今天，P54 补）；fail-closed：floorAt 既不是这个常量、也不是 'YYYY-MM-DD…' 文本 → 500，
//   不会因为调用方漏传 / 取到空值而静默变成「没有下限」。
const NO_DATE_FLOOR = Object.freeze({ noFloor: true });
//   field（可选）= 400 里报告的字段名，缺省 external_date；历史事实导入的日期叫 original_date。dateName（可选）= 文案里的日期名，缺省「外部确认日期」，历史导入写「原日期」（预筛 LOW-2）。
function assertProxyDate(externalDate, floorAt, today, floorLabel, field, dateName) {
  const f = field === undefined ? 'external_date' : field;
  const dn = dateName === undefined ? '外部确认日期' : dateName;
  if (externalDate > today) throw invalid(`${dn}不能晚于今天（${today}）`, f);
  if (floorAt === NO_DATE_FLOOR) return;
  if (typeof floorAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(floorAt) || typeof floorLabel !== 'string' || floorLabel === '') {
    throw internalError('外部确认日期的下限缺失');
  }
  const floor = String(floorAt).slice(0, 10);
  if (externalDate < floor) throw invalid(`${dn}不能早于${floorLabel}（${floor}）`, f);
}
// 授权的「负责人批准日」（授权表本身没有批准时间列），membership.js 的授权代录（接受一步的外部日期下限）与 history.js 的授权历史导入（P68 ②）共用，只一份取法（预筛 LOW-3）。
//   来源，按可靠性从高到低：① 批准一步是代录的 → 那条 delegation_grant 代录确认记录的 external_date（凭据上的日期，比操作日期更接近真实批准）；
//   ② 批准一步是平台批准 → 最近一条 delegation_approved 事件的 created_at（操作发生的服务器本地时间）；③ 都没有 → null，由调用方回落（授权代录取提议创建日；历史导入不核对）。
//   o.skipHistoryImport === true：忽略 payload.via = 'history_import' 的批准事件（历史导入推进到待接受时写的事件，不是平台上真实发生的批准）；解析不了 payload 的事件按真实事件算（更严）。
async function delegationApprovedOn(q, delegationId, o) {
  const g = await q.get(
    `SELECT c.external_date AS external_date FROM sysbuild_confirmations c
       JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
      WHERE t.object_type = 'delegation' AND t.object_id = ? AND t.purpose = 'delegation_grant' AND c.method = 'proxy' ORDER BY c.id DESC LIMIT 1`,
    [delegationId]
  );
  if (g) return g.external_date;
  const evs = await q.all("SELECT created_at, payload_json FROM sysbuild_events WHERE object_type = 'delegation' AND object_id = ? AND event_type = 'delegation_approved' ORDER BY id DESC", [delegationId]);
  for (const e of evs) {
    if (o && o.skipHistoryImport === true) {
      let via = null;
      try { via = (JSON.parse(e.payload_json) || {}).via || null; } catch (_) { via = null; }
      if (via === 'history_import') continue;
    }
    return e.created_at;
  }
  return null;
}
// 成员的平台账号是不是本项目 PM（无账号成员 userId 为空 → 否）。历史事实导入（history.js，H2）重核「PM 不得兼任参与方负责人 / 代表人」用；
//   membership.js 的普通入口（提议 / 邀请重核 / 授权提议）各自内联同一判定并配有各自的变异锚点，这里不改它们（见交付说明）。
const isProjectPmUser = (userId, pmUserId) => userId !== null && userId !== undefined && Number(userId) === Number(pmUserId);
// 把一条待确认修订置为终态 confirmed / objected / rejected（条件更新带「status = 'pending'」，影响行数 0 → 409）。
async function settleRevision(q, revisionId, toStatus) {
  const r = await q.run(
    "UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
    [toStatus, revisionId]
  );
  if (r.changes === 0) throw stateError('确认任务修订状态已变化，请刷新后重试');
}
// 写代录确认记录 + 绑定凭据附件 + 事件 confirm_proxy_recorded（同一写事务内，调用方已把修订置为终态）。
//   o：projectId、taskId、revisionId、objectType、objectVersionId、requiredMemberId、actorUserId（必需确认人的 user_id，无账号为 null）、decision（confirm / object / reject）、
//   reason（confirm 可空）、evidence（readProxyEvidence 的结果）。返回 { confirmationId, attachmentIds }。
//   C4b Q-S2：历史补录复用本函数——o.method = 'history'（缺省 'proxy'）时 revisionId / taskId / requiredMemberId 必须为 null（确认记录不挂任何当前任务修订，库内 CHECK 同样要求），
//   actorUserId 为 null，事件改写 history_confirmation_recorded（挂在对象版本上）；字段校验（readProxyEvidence）、凭据绑定（owner_type = confirmation）与 proxy_by 记法都与代录完全相同。
async function recordProxyConfirmation(q, user, attachmentHelpers, o) {
  const uid = Number(user.id);
  const ev = o.evidence;
  const method = o.method === undefined ? 'proxy' : o.method;
  if (method !== 'proxy' && method !== 'history') throw internalError('确认记录方式未登记');
  if ((method === 'history') !== (o.revisionId === null)) throw internalError('历史补录不挂任务修订、代录必须挂任务修订');
  const ins = await q.run(
    `INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, actual_confirmer, identity_basis, method, decision, reason, external_date, proxy_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.revisionId, o.objectType, o.objectVersionId, o.actorUserId, ev.actualConfirmer, ev.identityBasis, method, o.decision, o.reason, ev.externalDate, uid]
  );
  const bound = await attachmentHelpers.bindStagedAttachments(q, {
    projectId: o.projectId, userId: uid, attachmentIds: ev.attachmentIds, ownerType: 'confirmation', ownerId: ins.lastID, operatorName: operatorNameOf(user),
  });
  if (method === 'history') {
    await emit(q, user, o.projectId, o.objectType, o.objectVersionId, 'history_confirmation_recorded', {
      confirmation_id: ins.lastID, object_type: o.objectType, object_version_id: o.objectVersionId, decision: o.decision, method: 'history',
      actual_confirmer: ev.actualConfirmer, identity_basis: ev.identityBasis, external_date: ev.externalDate, attachment_ids: bound, reason: o.reason,
    });
  } else {
    await emit(q, user, o.projectId, 'confirm_task', o.taskId, 'confirm_proxy_recorded', {
      confirmation_id: ins.lastID, revision_id: o.revisionId, object_type: o.objectType, object_version_id: o.objectVersionId, required_member_id: o.requiredMemberId,
      decision: o.decision, method: 'proxy', actual_confirmer: ev.actualConfirmer, external_date: ev.externalDate, attachment_ids: bound, reason: o.reason,
    });
  }
  return { confirmationId: ins.lastID, attachmentIds: bound };
}

// ── C4b Q-S2 历史补录窗口：与当前确认任务按对象互斥（P58）──────────────────────────────────────────────
// 窗口 open 期间，某对象一旦有历史导入 / 历史补录记录，就不能再对它发起当前确认任务（提交、改发、代录、任职 / 授权的邀请接受与代录、提出人任务生成），
//   关闭窗口后恢复。判定都读库、按对象：内容包 = 该包任一版本；条目 = 该条目任一版本（历史补录挂的是条目版本，当前任务也是条目级的提出人确认）；任职 / 授权 = 该行本身。
//   返回 null（无冲突）或 409 文案；窗口不是 open（never / closed）一律 null。项目读不到按内部错误（调用方都在已加载项目之后）。
//   规则层把它当 fail-closed 的事实用：null = 无冲突，字符串 = 拒绝，其余（undefined 等）= 事实没取到，拒绝。
const HISTORY_CONFLICT_MESSAGE = '历史补录中：该对象已有历史记录，关闭窗口后再发起';
async function historyWindowIsOpen(q, projectId) {
  const r = await q.get('SELECT history_window FROM sysbuild_projects WHERE id = ?', [projectId]);
  if (!r) throw internalError('项目不存在，无法判定历史补录窗口');
  return r.history_window === 'open';
}
// 参与历史补录窗口互斥的「对象包」集合（C5 S-S1c，P58；预筛 M3：并集，不是替换）：变更包生效会替换总体规划包的生效版本，所以变更的提交 / 改发 / 代录的冲突 =
//   变更包自身（它的版本上补录过历史确认）∪ 总体规划包（窗口开启期间总体规划包有历史记录）任一有历史记录 → 409；其余包就是自己。返回包编号数组。
//   没有总体规划包（变更的前提不成立，不可达）只剩自己（没有历史记录 = 无冲突）。
async function historyPackageIdsOf(q, pkg) {
  if (pkg.type !== 'change') return [pkg.id];
  const o = await q.get("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'overall'", [pkg.project_id]);
  return o ? [pkg.id, o.id] : [pkg.id];
}
async function packageHistoryConflict(q, projectId, packageIds) {
  if (!(await historyWindowIsOpen(q, projectId))) return null;
  const ids = Array.isArray(packageIds) ? packageIds : [packageIds];
  const marks = ids.map(() => '?').join(', ');
  const imp = await q.get(
    `SELECT h.id AS id FROM sysbuild_history_imports h JOIN sysbuild_package_versions v ON v.id = h.object_id WHERE h.object_type = 'package_version' AND v.package_id IN (${marks}) LIMIT 1`,
    ids
  );
  if (imp) return HISTORY_CONFLICT_MESSAGE;
  const conf = await q.get(
    `SELECT c.id AS id FROM sysbuild_confirmations c JOIN sysbuild_package_versions v ON v.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'package_version' AND v.package_id IN (${marks}) LIMIT 1`,
    ids
  );
  return conf ? HISTORY_CONFLICT_MESSAGE : null;
}
async function itemHistoryConflict(q, projectId, itemId) {
  if (!(await historyWindowIsOpen(q, projectId))) return null;
  const conf = await q.get(
    "SELECT c.id AS id FROM sysbuild_confirmations c JOIN sysbuild_item_versions iv ON iv.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'item_version' AND iv.item_id = ? LIMIT 1",
    [itemId]
  );
  return conf ? HISTORY_CONFLICT_MESSAGE : null;
}
// kind = 'appointment' | 'delegation'（history_imports 的 object_type 与 fact_type 同名）
async function membershipHistoryConflict(q, projectId, kind, objectId) {
  if (kind !== 'appointment' && kind !== 'delegation') throw internalError('历史互斥的对象类型未登记');
  if (!(await historyWindowIsOpen(q, projectId))) return null;
  const imp = await q.get('SELECT id FROM sysbuild_history_imports WHERE object_type = ? AND object_id = ? LIMIT 1', [kind, objectId]);
  return imp ? HISTORY_CONFLICT_MESSAGE : null;
}
// ── 附件视图（任务详情的确认记录、历史补录、历史导入共用，C4b Q-S2 预筛 LOW-6：从 confirm.js 移到这里，只一份实现）─────────────────────────
// 统一格式：{ attachment_id, sha256, masked, name, size, mime_type }；遮蔽的附件 masked = true、name = null，不返回原名（Q8，经 attachmentDisplayName）。
async function attachmentView(q, frozen) {
  const out = [];
  for (const f of frozen) {
    const a = await q.get(`SELECT a.original_name AS original_name, a.masked_at AS masked_at, a.masked_by AS masked_by, a.mask_reason AS mask_reason,
      a.deleted_at AS deleted_at, a.deleted_by AS deleted_by, a.size AS size, a.mime_type AS mime_type, a.is_image AS is_image,
      COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
      FROM sysbuild_attachments a LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by WHERE a.id = ?`, [f.attachment_id]);
    out.push({
      attachment_id: f.attachment_id, sha256: f.sha256, masked: !!(a && a.masked_at), name: a ? attachmentDisplayName(a) : null,
      size: a ? a.size : null, mime_type: a ? a.mime_type : null,
      is_image: !!a && a.is_image === 1,
      ...attachmentStateFields(a),
    });
  }
  return out;
}
// 凭据附件视图（统一格式 + 删除标记叠加）：bound = 该记录名下全部绑定行（含已软删除的，不过滤）；方案 §10.3「记录里显示『已删除』与删除人」——
//   每项另补 deleted（是否已软删除）、deleted_by（删除人用户编号）、deleted_by_name（删除人显示名）、deleted_at。
async function evidenceViewOf(q, bound) {
  const view = await attachmentView(q, bound);
  return view.map((v, i) => Object.assign({}, v, {
    deleted: bound[i].deleted_at !== null, deleted_at: bound[i].deleted_at, deleted_by: bound[i].deleted_by, deleted_by_name: bound[i].deleted_by_name,
  }));
}
const EVIDENCE_COLS = `b.attachment_id AS attachment_id, a.sha256 AS sha256, a.deleted_at AS deleted_at, a.deleted_by AS deleted_by,
                COALESCE(du.display_name, du.username) AS deleted_by_name`;
// 一条确认记录 cf（需 cf.id）的凭据附件（owner_type = confirmation：代录确认、历史补录；平台确认没有，返回空）：补 attachment_ids 与 attachments。
//   attachment_ids 含该记录名下**全部**绑定（包括已软删除的），口径与 plan.js 改期证据读接口对齐。
async function attachConfirmationEvidence(q, cf) {
  const bound = await q.all(
    `SELECT ${EVIDENCE_COLS}
           FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id LEFT JOIN users du ON du.id = a.deleted_by
          WHERE b.owner_type = 'confirmation' AND b.owner_id = ? ORDER BY b.attachment_id`,
    [cf.id]
  );
  cf.attachment_ids = bound.map((x) => x.attachment_id);
  cf.attachments = await evidenceViewOf(q, bound);
}
// 一条历史导入记录 r（需 r.id）的凭据附件（owner_type = history_import）。
async function attachImportEvidence(q, r) {
  const bound = await q.all(
    `SELECT ${EVIDENCE_COLS}
           FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id LEFT JOIN users du ON du.id = a.deleted_by
          WHERE b.owner_type = 'history_import' AND b.owner_id = ? ORDER BY b.attachment_id`,
    [r.id]
  );
  r.attachment_ids = bound.map((x) => x.attachment_id);
  r.attachments = await evidenceViewOf(q, bound);
}
// 某对象版本的历史补录记录（读接口用，与当前修订的确认记录分开返回）：method = 'history' 的确认记录，每条带凭据附件（与任务详情确认记录同一种视图）与「历史补录」标记。
//   H1（codex 22 号）：必须带 projectId，查询里强制限定「对象版本属该项目」（包版本经内容包、条目版本经条目），不属于就查不到——读接口按对象编号读时，
//   可见项目甲的人传项目乙的版本编号读不到乙的历史确认。projectId 缺失 / 非法、objectType 不在两类之内 → 内部错误（fail-closed，不静默放开归属限定）。
async function historyConfirmationsOf(q, projectId, objectType, objectVersionId) {
  if (!Number.isInteger(projectId) || projectId <= 0) throw internalError('历史补录读取缺项目编号');
  if (objectType !== 'package_version' && objectType !== 'item_version') throw internalError('历史补录读取的对象类型未登记');
  const owner = objectType === 'package_version'
    ? 'JOIN sysbuild_package_versions ov ON ov.id = c.object_version_id JOIN sysbuild_packages op ON op.id = ov.package_id WHERE op.project_id = ?'
    : 'JOIN sysbuild_item_versions ov ON ov.id = c.object_version_id JOIN sysbuild_items op ON op.id = ov.item_id WHERE op.project_id = ?';
  const rows = await q.all(
    `SELECT c.id AS id, c.object_type AS object_type, c.object_version_id AS object_version_id, c.decision AS decision, c.reason AS reason, c.external_date AS external_date,
            c.actual_confirmer AS actual_confirmer, c.identity_basis AS identity_basis, c.proxy_by AS proxy_by, c.created_at AS created_at,
            (SELECT COALESCE(u.display_name, u.username) FROM users u WHERE u.id = c.proxy_by) AS proxy_by_name
       FROM sysbuild_confirmations c ${owner} AND c.method = 'history' AND c.object_type = ? AND c.object_version_id = ? ORDER BY c.id`,
    [projectId, objectType, objectVersionId]
  );
  for (const r of rows) {
    r.method = 'history';
    r.label = '历史补录';
    await attachConfirmationEvidence(q, r);
  }
  return rows;
}
// 某对象的历史导入记录（页面与导出凭它识别「历史导入」）：objectType = history_imports.object_type（appointment / delegation / package_version / node / batch，batch = C6a 上线事件导入）。
//   H1：同样必须带 projectId，查询按 history_imports.project_id 限定（写入时记的就是对象所属项目）。
async function historyImportsOf(q, projectId, objectType, objectId) {
  if (!Number.isInteger(projectId) || projectId <= 0) throw internalError('历史导入读取缺项目编号');
  // K7（codex 22-R L1）：对象类型白名单（与 history_imports.object_type 的四类一致），其余抛内部错误，不查库
  if (!['appointment', 'delegation', 'package_version', 'node', 'batch'].includes(objectType)) throw internalError('历史导入读取的对象类型未登记');
  const rows = await q.all(
    `SELECT h.id AS id, h.object_type AS object_type, h.object_id AS object_id, h.fact_type AS fact_type, h.actual_confirmer AS actual_confirmer, h.identity_basis AS identity_basis,
            h.original_date AS original_date, h.imported_by AS imported_by, h.imported_at AS imported_at,
            (SELECT COALESCE(u.display_name, u.username) FROM users u WHERE u.id = h.imported_by) AS imported_by_name
       FROM sysbuild_history_imports h WHERE h.project_id = ? AND h.object_type = ? AND h.object_id = ? ORDER BY h.id`,
    [projectId, objectType, objectId]
  );
  for (const r of rows) {
    r.label = '历史导入';
    await attachImportEvidence(q, r);
    // 内容包生效导入（总体规划包）另带导入时的节点计划快照（MED-2；没有提交事件时 submittedNodePlans 读导入事件里的快照）
    if (r.fact_type === 'package_effective') r.node_plans = await submittedNodePlans(q, r.object_id);
  }
  return rows;
}

module.exports = {
  CHECKBOX_TEXTS, checkboxTextsOf, ITEM_SUPERSEDED_REASON, PROJECT_TERMINATED_REASON, operatorNameOf,
  PROXY_KEYS, readProxyEvidence, readEvidenceAttachmentIds, readProxyText, assertProxyDate, NO_DATE_FLOOR, settleRevision, recordProxyConfirmation, localDateString, validDate,
  HISTORY_CONFLICT_MESSAGE, packageHistoryConflict, historyPackageIdsOf,itemHistoryConflict, membershipHistoryConflict, historyConfirmationsOf, historyImportsOf,
  attachmentView, attachConfirmationEvidence,
  frozenSetOf, frozenKey, frozenSetOfTask, frozenKeyOfTask, ENTRY_TASK_PURPOSES, INVALIDATED_ON_TERMINATE_PURPOSES, RETAINED_ON_TERMINATE_PURPOSES, assertTerminatePurposeClassification,
  CONFIRMER_ELIGIBLE_SQL, eligibleMember, isProxyOnlyMember, currentOwner, currentDelegate, resolvePackageConfirmers, confirmersMissing, qualificationLoss, confirmAvailabilityBlock, confirmedOnOtherRoleBySameUser,
  createTaskWithRevision, latestRevision, closePendingRevision, invalidatePendingRevisionsOfProject,
  createProposerTask, supersedeProposerRevisions, delegationApprovedOn, isProjectPmUser,
  currentNodePlans, submittedNodePlans, planMissingNodes, advancePlanningBatches,
  allPackageTasksConfirmed, formBaselines, takeEffectIfComplete, applyPackageEffect,
};
