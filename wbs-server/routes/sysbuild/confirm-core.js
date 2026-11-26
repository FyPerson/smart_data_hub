// routes/sysbuild/confirm-core.js — 项目管理（系统建设记录）模块：确认任务与修订、必需确认人解析、资格复核、内容包生效与基线形成的共用助手（C4a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 3 / 5 / 9、§3.1（总体排期基线）、§4.2（确认规则表）、§4.4（基线）、§4.5、§6.2。
//   派单 = docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md（P23 / P26 / P28 / P29）与 C4a_修订批派单_20261101.md（P31–P41）。
//
// 本文件只放「在调用方 withWriteTxn 回调里用 q 调用」的事务内助手，不注册路由：confirm.js（提交 / 撤回 / 改发 / 浏览 / 决策）、
//   projects.js（终止项目时失效待确认修订）共用。
//   依赖只有 rules / db / events，避免与 packages.js 成环。
// 所有状态写入都带旧状态条件并核对影响行数（0 → 409）；SQL 只经 q 助手（静态守卫 S5）；不 DELETE（S3）。
'use strict';
const { currentScopePlans, submittedNodePlans, snapshotError, validDate } = require('./scope-plans');
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
// checkboxTextsOf(purpose) 是任务详情（checkbox_texts）与决策校验共用的唯一取法；各用途现在都取 CHECKBOX_TEXTS（保留参数，调用方到 C6 整理）。
function checkboxTextsOf(purpose) {
  return CHECKBOX_TEXTS;
}
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
// 确认任务的冻结清单就是任务自己的 (object_type, object_version_id)（C6 起没有挂在登记上的结论 / 裁定 / 认可任务；冻结对象类型 entry 的取值留 C8）。
//   返回 { objectType, versionId }：读任务详情、决策比对冻结清单、冻结助手共用这一个映射。
function frozenKeyOfTask(task) {
  return { objectType: task.object_type, versionId: task.object_version_id };
}
async function frozenSetOfTask(q, task) {
  const k = frozenKeyOfTask(task);
  return frozenSetOf(q, k.objectType, k.versionId);
}

// ── 必需确认人解析（P23 / P44）与资格复核同源（预筛 M1）──────────────────────────────────────────────
// 「可作为确认人」的唯一判定：成员已加入且未移出（rules.MEMBER_ACTIVE_SQL）+ 有平台账号且账号状态 active。
//   账号停用的成员不是确认人——视为缺人；user_id 为空（无账号）或用户行不存在同理（左连接后 u.status 为空，判假）。
//   解析（currentOwner / currentDelegate）、改发、资格复核（qualificationLoss）、待我确认全部调用这一份，
//   任职 / 授权是否仍生效是另一层（依据检查），不在本片段里。别名约定：成员 m、用户 u（一律左连接 users）。
const CONFIRMER_ELIGIBLE_SQL = `${rules.MEMBER_ACTIVE_SQL} AND u.status = 'active'`;
// C6b 修订批 3（预筛 MED-B）：发送侧要先按「与账号状态无关」的条件复核（账号停用是可恢复的，不能盖过永久失格——否则停用 + 已移出 / 已确认 / 已改发的意图会被记成可恢复的失败，账号一恢复就外发过期通知）。
//   o.ignoreAccountStatus === true 时只看成员已加入未移出，不看账号状态；站内入口（待我确认 / 作出确认 / 改发）一律不传 o，口径不变。
const eligibleSqlOf = (o) => (o && o.ignoreAccountStatus === true ? rules.MEMBER_ACTIVE_SQL : CONFIRMER_ELIGIBLE_SQL);
// 成员 memberId 此刻可作为确认人？返回 { id, user_id, party_id }，不可则 null。
async function eligibleMember(q, memberId, o) {
  const r = await q.get(
    `SELECT m.id AS id, m.user_id AS user_id, m.party_id AS party_id FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND ${eligibleSqlOf(o)}`,
    [memberId]
  );
  return r || null;
}
// 参与方 partyId 的现任负责人：生效任职 + 可作为确认人的成员；没有返回 null。
async function currentOwner(q, partyId, o) {
  const r = await q.get(
    `SELECT a.id AS appointment_id, a.member_id AS member_id, m.user_id AS user_id FROM sysbuild_appointments a
       JOIN sysbuild_members m ON m.id = a.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE a.party_id = ? AND a.status = 'active' AND ${eligibleSqlOf(o)} ORDER BY a.id DESC LIMIT 1`,
    [partyId]
  );
  return r ? { appointmentId: r.appointment_id, memberId: r.member_id } : null;
}
// 参与方 partyId 的生效代表人（每方至多一位，uq_sysbuild_delegations_active）；没有返回 null。
async function currentDelegate(q, partyId, o) {
  const r = await q.get(
    `SELECT d.id AS delegation_id, d.member_id AS member_id, m.user_id AS user_id FROM sysbuild_delegations d
       JOIN sysbuild_members m ON m.id = d.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE d.party_id = ? AND d.status = 'active' AND ${eligibleSqlOf(o)} ORDER BY d.id DESC LIMIT 1`,
    [partyId]
  );
  return r ? { delegationId: r.delegation_id, memberId: r.member_id } : null;
}
// 知悉发给仍在任的领导。账号停用由发送服务统一作为可恢复失败处理。
async function currentDemandLeaderUser(q, projectId, partyId) {
  const owner = await currentOwner(q, partyId, { ignoreAccountStatus: true });
  if (!owner) return null;
  const user = await q.get(
    `SELECT u.id FROM sysbuild_members m JOIN users u ON u.id = m.user_id JOIN sysbuild_parties p ON p.id = m.party_id
      WHERE m.id = ? AND m.party_id = ? AND m.project_id = ? AND p.project_id = m.project_id AND p.side = 'demand'`,
    [owner.memberId, partyId, projectId]
  );
  return user ? user.id : null;
}

// B3.1：立项由需求方领导确认，其余三个关口由需求方负责人确认。每个需求部门一人。
const PACKAGE_CONFIRMER_ROLES = Object.freeze({ initiation: 'owner', overall: 'delegate', batch_accept: 'delegate', closing: 'delegate' });
async function resolvePackageConfirmers(q, projectId, packageType) {
  if (!Object.hasOwn(PACKAGE_CONFIRMER_ROLES, packageType)) throw internalError('内容包确认角色未登记');
  const role = PACKAGE_CONFIRMER_ROLES[packageType];
  const parties = await q.all("SELECT id, name FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' ORDER BY sort_order, id", [projectId]);
  const out = { noParty: parties.length === 0, entries: [], missing: [] };
  for (const p of parties) {
    if (role === 'owner') {
      const owner = await currentOwner(q, p.id);
      if (owner) out.entries.push({ partyId: p.id, kind: role, memberId: owner.memberId, appointmentId: owner.appointmentId, delegationId: null });
      else out.missing.push(`${p.name}（缺现任领导）`);
    } else {
      const dlg = await currentDelegate(q, p.id);
      if (dlg) out.entries.push({ partyId: p.id, kind: role, memberId: dlg.memberId, appointmentId: null, delegationId: dlg.delegationId });
      else out.missing.push(`${p.name}（缺生效负责人）`);
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

// 来源以任务绑定的任职或授权为准。历史角色与新角色各自有稳定的对象编号。
async function directAssignmentRole(q, projectId, partyId, revision) {
  const appointmentId = revision.basis_appointment_id;
  const delegationId = revision.basis_delegation_id;
  if (!!appointmentId === !!delegationId) return null;
  const objectType = appointmentId ? 'appointment' : 'delegation';
  const eventType = appointmentId ? 'appointment_activated' : 'delegation_activated';
  const event = await q.get(
    'SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND object_type = ? AND object_id = ? AND event_type = ? ORDER BY id LIMIT 1',
    [projectId, objectType, appointmentId || delegationId, eventType]
  );
  if (!event) return null;
  let payload;
  try { payload = JSON.parse(event.payload_json); } catch (_) { return null; }
  if (!payload || payload.source !== 'direct_assignment' || payload.party_id !== partyId || payload.member_id !== revision.required_member_id) return null;
  return appointmentId ? '领导' : '负责人';
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
    if (!a || a.status !== 'active' || a.member_id !== rev.required_member_id) return '必需确认人所依据的领导任职已不再生效，请联系项目经理改发';
  }
  if (rev.basis_delegation_id !== null) {
    const d = await q.get('SELECT status, member_id FROM sysbuild_delegations WHERE id = ?', [rev.basis_delegation_id]);
    if (!d || d.status !== 'active' || d.member_id !== rev.required_member_id) return '必需确认人所依据的负责人授权已不再生效，请联系项目经理改发';
  }
  return null;
}
// C6b 修订批 1（K1）：必需确认人**此刻**还能在平台上对这条待确认修订作出确认吗？站内「待我确认」（confirm.js myConfirmationItems）与钉钉发送侧（notify.js describeRef，首次发送 / 补发 / 就绪扫描）
//   共用这一个判定，不各写一份：项目对该用户可见 → 项目状态允许作出这类确认（accept 类；已终止 / 已结项的项目不列）→ 资格复核（qualificationLoss：成员已移出、账号停用、任职 / 授权失效）。
//   rev：{ project_id, purpose, required_member_id, basis_appointment_id, basis_delegation_id }；user：{ id, role }；accessOpts：{ readonlyIds, writeRoles }；cache：调用方在同一批里复用的对象（按项目缓存可见性与状态，可空）。
//   返回 null = 此刻还能确认，否则原因文案。o（可空）：{ ignoreAccountStatus: true } = 不把账号状态并进判定（只有钉钉发送侧传，见 eligibleSqlOf）。
async function confirmAvailabilityBlock(q, rev, user, accessOpts, cache, o) {
  const memo = cache || {};
  if (!Object.prototype.hasOwnProperty.call(memo, rev.project_id)) {
    const access = await rules.loadProjectAccess(q, rev.project_id, user, accessOpts);
    memo[rev.project_id] = {
      visible: rules.canViewProject(access), canDecide: !!access.project && rules.projectAllowsWrite(access.project.status, rules.OP_KIND.confirm_decide),
    };
  }
  const info = memo[rev.project_id];
  if (!info.visible) return '收件人看不到该项目';
  if (!info.canDecide) return '项目当前状态不允许作出这项确认';
  return qualificationLoss(q, rev, o);
}

// ── P36 同一人不能在同一参与方同时以负责人和代表人身份确认 ────────────────────────────────────────────
// 已确认的修订保持有效（确认记录绑定当时的修订与版本，不变量 5）；但改发时若解析出的新人已在本版本、同一参与方的另一类任务上确认过，改发 409。
//   P42（主会话 11-01 裁定，登记不改逻辑）：这条冲突只看**同一参与方**——同一时刻一个用户只有一条未移出的成员行（所以只属于一个参与方），同一人在本版本的
//   不同参与方各确认一次，意味着他先后在不同部门任职（先在甲部确认、移出后到乙部再确认），这是接受的；不跨参与方拦。
//   task = 被改发任务行（object_version_id / party_id / id）；memberId = 改发后的必需确认人成员。返回冲突时 true。
//   「同一人」= 同一 user_id。
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
  return rows.some((r) => r.user_id === me.user_id);
}

// ── 任务与修订 ─────────────────────────────────────────────────────────────────────────────────
// 新建一条确认任务 + 首条修订（rev_no = 1，待确认）。o：projectId、objectType、objectId、objectVersionId、purpose、partyId（可空）、
//   requiredMemberId、basisAppointmentId / basisDelegationId（可空）。返回 { taskId, revisionId }。
//   C6b：同一事务里给必需确认人写一条发送意图（有平台账号的；无账号成员不建，notify-core.enqueueRevisionIntent）。所有新任务都经本函数（内容包提交），
//   所以首修订的通知挂在这一处。
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
  await notifyCore.enqueueRevisionIntent(q, { projectId: o.projectId, revisionId: r.lastID, requiredMemberId: o.requiredMemberId });
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

// 终止项目时，在同一事务中失效本项目的待确认修订。
// 列表与结构枚举一起校验，新增确认用途必须明确登记其终止行为。
const INVALIDATED_ON_TERMINATE_PURPOSES = Object.freeze(['package_confirm']);
const RETAINED_ON_TERMINATE_PURPOSES = Object.freeze([]);
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


// ── 内容包生效与基线（P28）────────────────────────────────────────────────────────────────────────────
// 内容包版本 ver（status = pending）的全部必需任务当前修订都已确认？tasks 为空视为未满足（提交时必然生成任务，没有任务的版本不生效）。
//   P36 防御：同一参与方的各任务当前修订的确认人必须是不同的人，否则不生效（正常路径下改发已拦下，这里是兜底）。「同一人」按 user_id。
//   本函数只看当前修订的状态，不读 confirmations.method。
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
    const k = `${r.party_id}:${r.user_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

// 基线只来自确认人看到的提交快照。核定当前身份和日期后再写入。
async function formBaselines(q, user, projectId, versionId) {
  const project = await q.get('SELECT build_type FROM sysbuild_projects WHERE id = ?', [projectId]);
  if (!project) throw snapshotError();
  const recorded = await submittedNodePlans(q, projectId, versionId);
  const current = await currentScopePlans(q, projectId, project.build_type);
  if (current.blocked || recorded.length !== current.entries.length) throw snapshotError();
  for (const [i, item] of recorded.entries()) {
    const actual = current.entries[i];
    if (['node_id', 'template_key', 'batch_id', 'planned_start', 'planned_end'].some((key) => item[key] !== actual[key])) throw snapshotError();
  }
  const formed = [];
  for (const { node_id: nodeId, planned_start: start, planned_end: end } of recorded) {
    const existing = await q.get("SELECT package_version_id, planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind = 'baseline'", [nodeId]);
    if (existing) {
      if (existing.package_version_id !== versionId || existing.planned_start !== start || existing.planned_end !== end) throw snapshotError();
      continue;
    }
    const ins = await q.run(
      "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, package_version_id, created_by) VALUES (?, 'baseline', ?, ?, ?, ?)",
      [nodeId, start, end, versionId, Number(user.id)]
    );
    await emit(q, user, projectId, 'node', nodeId, 'baseline_formed', {
      record_id: ins.lastID, package_version_id: versionId, planned_start: start, planned_end: end, via: 'package_effective',
    });
    formed.push(nodeId);
  }
  return formed;
}

// 最后一条必需任务的当前修订变为已确认时调用（同一事务内）：版本 pending → effective，同包原生效版本 → superseded，总体规划包形成基线。
//   尚有任务未确认时什么也不做。返回 { effective: boolean, superseded: [版本编号], baselineNodes: [节点编号], advancedBatches: [批次编号] }。
//   登记残余（C4a 修订批）：sysbuild_package_versions.status 有 draft / pending / effective / superseded 四种合法旧状态，放不进 CONDITIONAL_UPDATES 的单片段白名单，
//   所以本文件与 confirm.js 里每处写 status 的 UPDATE 都自己带旧状态条件（WHERE … AND status = '…'）并核影响行数，静态守卫（S2）不覆盖这几处。
async function takeEffectIfComplete(q, user, projectId, pkg, ver) {
  if (!(await allPackageTasksConfirmed(q, ver.id))) return { effective: false, superseded: [], baselineNodes: [], advancedBatches: [] };
  return applyPackageEffect(q, user, projectId, pkg, ver);
}
async function applyPackageEffect(q, user, projectId, pkg, ver) {
  await materialsCore.assertMaterialFreezes(q, projectId, ver);
  // 先让同包原生效版本退位（库内每包至多一个 effective 版本，uq_sysbuild_package_versions_effective）。
  const olds = await q.all("SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND status = 'effective' AND id <> ? ORDER BY id", [pkg.id, ver.id]);
  for (const old of olds) {
    const r = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'effective'", [old.id]);
    if (r.changes === 0) throw stateError('内容包版本状态已变化，请刷新后重试');
    await emit(q, user, projectId, 'package_version', old.id, 'package_version_superseded', { package_id: pkg.id, replaced_by: ver.id });
  }
  const up = await q.run(
    "UPDATE sysbuild_package_versions SET status = 'effective', effective_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
    [ver.id]
  );
  if (up.changes === 0) throw stateError('内容包版本状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'package_version', ver.id, 'package_version_effective', { package_id: pkg.id, version_no: ver.version_no, replaced: olds.map((x) => x.id) });
  const baselineNodes = pkg.type === 'overall' ? await formBaselines(q, user, projectId, ver.id) : [];
  const advancedBatches = pkg.type === 'overall' && ver.form === 'overall_batch_req' ? await advancePlanningBatches(q, user, projectId, ver.id) : [];
  return { effective: true, superseded: olds.map((x) => x.id), baselineNodes, advancedBatches };
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

function localDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 把一条待确认修订置为终态 confirmed / objected / rejected（条件更新带「status = 'pending'」，影响行数 0 → 409）。
async function settleRevision(q, revisionId, toStatus) {
  const r = await q.run(
    "UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
    [toStatus, revisionId]
  );
  if (r.changes === 0) throw stateError('确认任务修订状态已变化，请刷新后重试');
}

// ── 附件视图（任务详情的确认记录共用，C4b Q-S2 预筛 LOW-6：从 confirm.js 移到这里，只一份实现）─────────────────────────
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

module.exports = {
  CHECKBOX_TEXTS, checkboxTextsOf, PROJECT_TERMINATED_REASON, operatorNameOf,
  settleRevision, localDateString, validDate,
  attachmentView,
  frozenSetOf, frozenKey, frozenSetOfTask, frozenKeyOfTask, INVALIDATED_ON_TERMINATE_PURPOSES, RETAINED_ON_TERMINATE_PURPOSES, assertTerminatePurposeClassification,
  CONFIRMER_ELIGIBLE_SQL, eligibleMember, currentOwner, currentDelegate, currentDemandLeaderUser, resolvePackageConfirmers, confirmersMissing, directAssignmentRole, qualificationLoss, confirmAvailabilityBlock, confirmedOnOtherRoleBySameUser,
  createTaskWithRevision, latestRevision, closePendingRevision, invalidatePendingRevisionsOfProject,
  submittedNodePlans, advancePlanningBatches,
  allPackageTasksConfirmed, formBaselines, takeEffectIfComplete,
};
