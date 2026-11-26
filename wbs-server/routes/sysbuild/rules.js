// routes/sysbuild/rules.js — 项目管理（系统建设记录）模块的最小权限助手
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §5（权限）、§4.5（项目状态与写入）
//   用户 2026-10-28 拍板：C1c 先建「最小权限助手」，C2 在同一组函数上扩展，不另起一套。
//
// 本文件只放两类东西：
//   1. 纯函数——动作判定（canXxx）与项目状态判定（projectAllowsWrite），不读库；
//   2. loadProjectAccess——在调用方传入的 q（withRead / withWriteTxn 回调里的查询助手）上读库，
//      不自开连接、不自开事务。
// 检查顺序固定（§5.3）：参数 400 → 项目不存在 404 → 既非 admin / 成员 / 只读账号 404（不暴露项目存在）
//   → 动作权限不满足 403 → 项目状态不允许写 409。assertCan 按这个顺序抛错，调用方不要自己拆开排序。
'use strict';
const { makeError } = require('./db');
const schema = require('./schema');
const { ACCEPTANCE_NODE_KEYS, ACTIVE_BATCH_STATUSES } = require('./templates');

// 所有「看不见 / 不存在」的 404 共用这一句（同一状态码、code、message）：不可借提示区分编号是否存在。
//   附件端点里的 404 也经 rules.notFound() 取，不得另写文案。
const NOT_FOUND = () => makeError(404, 'SYSBUILD_NOT_FOUND', '项目或附件不存在');

// 正整数 id 解析：只接受十进制正整数字符串或正整数；其余返回 null（调用方回 400）。
function parseId(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || !/^[1-9]\d{0,14}$/.test(v)) return null;
  return Number(v);
}

// 文本入参的控制字符判定（C3a 预筛 L1）：C0 控制字符（\u0000–\u001F）与 \u007F 一律拒收，保留换行 \n、回车 \r、制表 \t。
//   所有文本入参的解析函数（plan.js / projects.js / membership.js 的 readText、attachments.js 的遮蔽原因）共用这一个判定，
//   命中返回 400 SYSBUILD_INVALID_INPUT；否则 NUL 等字符会落到库内 CHECK 以 500 暴露。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // eslint-disable-line no-control-regex
function hasControlChar(s) {
  return typeof s === 'string' && CONTROL_CHAR_RE.test(s);
}

// ── 读库：项目 + 调用者在该项目中的身份 ─────────────────────────────────────────────────
// 返回 { project, isAdmin, isPm, isMember, isReadonly }；项目不存在时 project 为 null，其余全 false。
//   isMember：sysbuild_members 里有「已加入、未移出」的行；PM 视为成员（PM 不一定有成员行）。
//   readonlyIds：只读账号 id 集合（数组或 Set，调用方从平台配置取）；只读账号对写入有否决权（§5.1）。
//   必须显式传入：缺失或类型不对抛 500 SYSBUILD_INTERNAL，不回落为空集合（回落会让只读账号静默拥有写权限）。
async function loadProjectAccess(q, projectId, user, opts) {
  const ro = opts && opts.readonlyIds;
  if (!(Array.isArray(ro) || ro instanceof Set)) {
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：只读账号集合未提供');
  }
  const readonlyIds = new Set(Array.from(ro).map(Number));
  const uid = Number(user && user.id);
  const project = await q.get('SELECT id, pm_user_id, status, build_type FROM sysbuild_projects WHERE id = ?', [projectId]);
  if (!project) return { project: null, isAdmin: false, isPm: false, isMember: false, isReadonly: false };
  const isAdmin = !!user && user.role === 'admin';
  const isReadonly = readonlyIds.has(uid);
  const isPm = Number(project.pm_user_id) === uid;
  let isMember = isPm;
  if (!isMember) {
    const row = await q.get(
      'SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND joined_at IS NOT NULL AND removed_at IS NULL LIMIT 1',
      [projectId, uid]
    );
    isMember = !!row;
  }
  return { project, isAdmin, isPm, isMember, isReadonly };
}

// ── 动作判定（纯函数；本段四个附件判定是 C1c 的；C2a 的项目级判定在下面「C2a」段，M-S2 在同处追加成员与授权类）────────
// §5.2「查看 / 下载 / 预览附件」：admin、成员、只读账号。
function canViewAttachments(access) {
  return !!(access.isAdmin || access.isMember || access.isReadonly);
}
// 暂存时尚未挂记录，所以按「可写项目的人」判断：admin 或成员，且不是只读账号。
//   §5.1 只读账号对写入有否决权，对 admin 同样生效（admin 角色且在只读名单里也不能暂存），
//   所以否决放在最外层，不放进「成员」那一支。
//   挂记录时的「随所挂记录的权限」由各记录的提交接口（C3 起）判断。
function canStageAttachment(access) {
  return !!(!access.isReadonly && (access.isAdmin || access.isMember));
}
// §10.3 受控遮蔽由 PM 执行；只读账号即使是 PM 也不行。
function canMaskAttachment(access) {
  return !!(access.isPm && !access.isReadonly);
}
// 方案未写软删除的执行人。主会话按「只收窄不放宽」暂定与遮蔽相同（PM 且不是只读账号），
//   已记入锚点待追认；追认结果改这一处即可。
function canSoftDeleteAttachment(access) {
  return !!(access.isPm && !access.isReadonly);
}

// C4c R-S1 需求确认单导出（方案 §5.2「导出需求确认单」行：全部身份为「是」；§2.2 不变量 9：导出读提交时冻结的快照与附件清单）：
//   可见（canViewProject，与 assertVisible 同一份判定）+ 版本已提交过（待确认 / 已生效 / 已被替代）。草稿版本没有冻结快照，不可导出（R-D2）。
//   不属于 OBJECT_OPS 的写动作体系（不改任何状态、不查项目状态表）：读端点 GET …/confirmation-sheet 的执行与 packages.js versionActions 的 export_sheet 标志都调用这一个函数。
//   版本状态用显式白名单，不用「不是草稿」的否定式：库里出现表外状态时 fail-closed 判不可导出。
const SHEET_EXPORT_VERSION_STATUSES = Object.freeze(['pending', 'effective', 'superseded']);
function canExportConfirmationSheet(access, ver) {
  return !!(canViewProject(access) && ver && SHEET_EXPORT_VERSION_STATUSES.includes(ver.status));
}

// ── C2a：身份汇总与项目级动作判定 ───────────────────────────────────────────────────────
// 平台身份（不依赖具体项目）：admin / 只读账号 / 角色是否在平台写入角色名单内。建项目、列全部项目、指定 PM 这类没有项目对象的动作用它判定。
//   opts.readonlyIds：只读账号 id 集合；opts.writeRoles：平台写接口允许的角色（server.js 的 WRITE_ALLOWED_ROLES，排除 viewer）。两者都必填，缺失抛 500。
function platformIdentity(user, opts) {
  const ro = (opts || {}).readonlyIds;
  if (!(Array.isArray(ro) || ro instanceof Set)) {
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：只读账号集合未提供');
  }
  const wr = (opts || {}).writeRoles;
  if (!(Array.isArray(wr) || wr instanceof Set)) {
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：平台写入角色集合未提供');
  }
  const readonlyIds = new Set(Array.from(ro).map(Number));
  const writeRoles = new Set(Array.from(wr));
  return {
    isAdmin: !!user && user.role === 'admin',
    isReadonly: readonlyIds.has(Number(user && user.id)),
    roleCanWrite: !!user && writeRoles.has(user.role),
  };
}

// 「已加入、未移出」的成员行过滤（别名 m）。loadProjectIdentity 与详情接口的负责人 / 代表人 / 成员判断共用这一个片段，
//   避免两处各写一份而漂移（预筛 M2：已移出的人不能再以负责人 / 代表人名义出现）。
const MEMBER_ACTIVE_SQL = 'm.removed_at IS NULL AND m.joined_at IS NOT NULL';

// C4a 开放提交确认的内容包类型（派单 P22）：其余类型 C5 / C6 起可用。提交动作的类型判定、读接口 / 提交端点的「必需确认人 / 立项前置」事实、
//   以及 P35「待确认内容包期间不能新建需求部门参与方」的待确认包类型清单都读这一份（修订批二 LOW-5：不再各写一份字面量）。
//   C6a（P22 收尾）：加入批次验收包（batch_accept）与结项包（closing）。
const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'batch_accept', 'closing']);
const SUBMITTABLE_TYPES_SQL_LIST = SUBMITTABLE_PACKAGE_TYPES.map((x) => `'${x}'`).join(', ');
// 待确认互斥（C6a，主会话裁定 P139）：同一项目内，总体规划 / 批次验收 / 结项三类包同一时刻最多一个版本处于待确认（立项包不在内；C5 后互斥类型即 EXCLUSIVE_PENDING_PACKAGE_TYPES 这三类）：验收包与结项包按提交时的现行规划冻结，
//   待确认期间规划不能再变。packages.js versionFactsOf 取「项目里已待确认的另一类（或另一个）包」的类型作为事实 otherPendingPackage，rules.package_version_submit 统一判定（提交标志与执行同源）。
//   中文名用于 409 文案「已有待确认的内容包：<类型>，须先撤回或等确认完成」。
const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'batch_accept', 'closing']);
const EXCLUSIVE_PENDING_SQL_LIST = EXCLUSIVE_PENDING_PACKAGE_TYPES.map((x) => `'${x}'`).join(', ');
const PACKAGE_TYPE_LABELS = Object.freeze({ overall: '总体规划', batch_accept: '批次验收', closing: '结项', initiation: '立项' });
// C5（R10 / F2 / F4）：保留的输入口按最终取值清单校验；写端（packages.js 建包入口）与读端（create_package_types）只读 PACKAGE_TYPES_FINAL，C8 缩枚举时一并对照。
// 通用登记只接收 general。请求校验与登记元数据共用这份清单，数据库不存用途列。
const PACKAGE_TYPES_FINAL = Object.freeze(['initiation', 'overall', 'batch_accept', 'closing']);
const ENTRY_PURPOSES_FINAL = Object.freeze(['general']);

// 在已有项目可见性上补齐当前成员、有效任职和授权，再取本项目的业务写入事实。
async function completeIdentity(q, access, user) {
  const identity = Object.assign({}, access, {
    memberId: null, partyId: null, ownerOfParties: [], delegateOfParties: [],
    userId: Number(user && user.id), hasDevParty: false, // C2b：本人用户编号（本人确认类动作与「发起人本人」判定用）；本项目是否已有开发方参与方（actions.party_sides 用）
    hasPendingContentPackage: false, // C4a P35：本项目是否有待确认的立项包 / 总体规划包版本（新建需求部门参与方的拒绝条件，actions.party_sides 用）
  });
  if (!access.project) return identity;
  const projectId = access.project.id;
  const uid = Number(user && user.id);
  const mine = await q.get(
    `SELECT m.id AS id, m.party_id AS party_id FROM sysbuild_members m WHERE m.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL} ORDER BY m.id LIMIT 1`,
    [projectId, uid]
  );
  if (mine) { identity.memberId = mine.id; identity.partyId = mine.party_id; }
  const owners = await q.all(
    `SELECT a.party_id AS party_id FROM sysbuild_appointments a
       JOIN sysbuild_members m ON m.id = a.member_id
       JOIN sysbuild_parties p ON p.id = a.party_id
      WHERE a.status = 'active' AND p.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL}
      ORDER BY a.party_id`,
    [projectId, uid]
  );
  identity.ownerOfParties = owners.map((r) => r.party_id);
  const delegates = await q.all(
    `SELECT d.party_id AS party_id FROM sysbuild_delegations d
       JOIN sysbuild_members m ON m.id = d.member_id
       JOIN sysbuild_parties p ON p.id = d.party_id
      WHERE d.status = 'active' AND p.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL}
      ORDER BY d.party_id`,
    [projectId, uid]
  );
  identity.delegateOfParties = delegates.map((r) => r.party_id);
  const devParty = await q.get("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'dev' LIMIT 1", [projectId]);
  identity.hasDevParty = !!devParty;
  const pendingPkg = await q.get(
    `SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type IN (${SUBMITTABLE_TYPES_SQL_LIST}) AND v.status = 'pending' LIMIT 1`,
    [projectId]
  );
  identity.hasPendingContentPackage = !!pendingPkg;
  return identity;
}
async function loadProjectIdentity(q, projectId, user, opts) {
  const access = await loadProjectAccess(q, projectId, user, opts);
  return completeIdentity(q, access, user);
}

// 项目状态 × 动作对照（§4.5 表「项目状态 × 动作对照」逐行写成数据；状态检查与页面 actions 共用这一张表）。
//   键 = 动作类别，值 = { 状态: 是否允许 }。未登记的类别 / 状态一律拒绝（新类别漏登记时不会默认放行）。
//   对应关系：maintain = 维护定稿材料、节点开始 / 重开 / 增删改名、草稿编辑、发起内容包确认、改期；
//     **节点收口单列为 close**（方案 v1.2 §4.5 状态 × 动作表第二行：进行中是、已暂停否、已终止否、已结项否）——暂停时拒绝收口只来自这一行，
//     端点里不得另写「暂停时不能收口」的特例判断；上线（确认试运行结束）本就单列为 golive；
//   accept = 作出推进类确认（内容包确认、进度汇报登记等；**不含**接受 / 拒绝加入、任职、授权，见下面 D3）；
//   resolve = 既有登记的更正与作废（C6 起；结论确认、异议、负责人裁定已随 S4 / S7 删除），**同时并入方案表第 5 行「既有登记继续办理」**
//     （该行四态为 是 / 是 / 是 / 是，与 resolve 完全相同，不单列类别，预筛 L1）；
//   register_process / register_supplement / comment / attachment = 写登记（过程 / 补充）、评论、附件；golive = 确认试运行结束；
//   g7 = G7 后评价；membership = 成员与授权变更；
//   basics = 项目基本信息（C2a 新增类别，方案表未单列：与 maintain 同口径，进行中 / 已暂停可改，已终止 / 已结项不可；
//     已结项要补 OA 号等基本信息，先由 admin 重开，主会话裁定 D4 保留此口径）。
//   D3（主会话裁定）：**接受 / 拒绝加入、任职、授权按 membership 类别判项目状态**（不按 accept）。理由：membership 在已结项为「是」
//     （补登与 G7 需要邀请人进来），若接受类按 accept（已结项「否」），已结项能发邀请却没人能接受，形成死路（闸门 × 回路）。
//     C2b 的接受 / 拒绝端点（membership.js）据此判：rules.checkOp 对 invitation_* / delegation_accept / delegation_decline 都查 membership 行。
//   状态转移（暂停 / 恢复 / 终止 / 重开）与更换 PM / 接管只由 admin 做，任何状态都可做，不在本表，状态转移受 STATUS_TRANSITIONS 约束。
//   D2（主会话裁定）：更换 PM / 接管是「成员与授权变更：已终止 否」字面口径的显式例外，已终止 / 已结项也可做。理由：终止后 PM 仍需以
//     「项目已终止」为结论关闭既有登记（§4.5 第 3 行），PM 位置空缺或在不能操作的人手里会让终止项目的收尾卡住；admin 要接管就必须有成员行
//     （PM 判定之外的可见性、附件与登记都按成员行），所以更换 PM 可能新增一行成员行，这是该例外的一部分。
const PROJECT_ACTION_TABLE = Object.freeze({
  basics: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),
  maintain: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),
  close: Object.freeze({ active: true, paused: false, terminated: false, closed: false }),
  accept: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),
  resolve: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),
  register_process: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),
  register_supplement: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),
  comment: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),
  attachment: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),
  golive: Object.freeze({ active: true, paused: false, terminated: false, closed: false }),
  g7: Object.freeze({ active: false, paused: false, terminated: false, closed: true }),
  membership: Object.freeze({ active: true, paused: true, terminated: false, closed: true }),
});

// 项目状态是否允许某类写入：查 PROJECT_ACTION_TABLE。未登记的 kind 或状态一律拒绝。
//   kind = 'attachment' 的结果与 C1c 一致（四态都允许；§4.5：已终止 / 已结项仍可写补充登记与评论，附件随之）。
function projectAllowsWrite(status, kind) {
  if (!Object.prototype.hasOwnProperty.call(PROJECT_ACTION_TABLE, kind)) return false;
  const row = PROJECT_ACTION_TABLE[kind];
  if (!Object.prototype.hasOwnProperty.call(row, status)) return false;
  return row[status] === true;
}

// 项目状态转移表（§4.5：暂停、恢复、终止、重开由 admin；结项只由 C6 整体结项节点收口产生，POST status 不能转入 closed）。
const STATUS_TRANSITIONS = Object.freeze({
  active: Object.freeze(['paused', 'terminated']),
  paused: Object.freeze(['active', 'terminated']),
  terminated: Object.freeze(['active']),
  closed: Object.freeze(['active']),
});

// 项目级动作判定。签名统一 (identity, project, target?) => boolean；identity 来自 loadProjectIdentity。
//   只读账号对写入一票否决（§5.1），否决放在最外层，对 admin 与 PM 同样生效。
function canViewProject(identity) {
  return !!(identity.project && (identity.isAdmin || identity.isMember || identity.isReadonly));
}
// 列全部项目（scope=all）：admin 与只读账号。参数是 platformIdentity 的结果。
function canListAll(platform) {
  return !!(platform.isAdmin || platform.isReadonly);
}
// 建项目：登录的、非只读账号、且角色在平台写入角色名单内（WRITE_ALLOWED_ROLES，排除 viewer；D1）的用户（建项人即 PM；admin 可代建）。
//   平台已在 authenticateToken 里核对账号 active。
function canCreateProject(platform) {
  return !!(!platform.isReadonly && platform.roleCanWrite);
}
// 改基本信息：PM 本人（admin 经「接管」成为 PM 后才可）。
function canEditProjectBasics(identity) {
  return !!(identity.isPm && !identity.isReadonly);
}
// 暂停 / 恢复 / 终止 / 重开：admin。
function canChangeProjectStatus(identity) {
  return !!(identity.isAdmin && !identity.isReadonly);
}
// 更换 PM / 接管：admin（任何项目状态都可做，D2 显式例外，见上面表注释）。
function canChangePm(identity) {
  return !!(identity.isAdmin && !identity.isReadonly);
}
// 新 PM 不能兼任某方的现任领导或负责人，也不能带着参与方成员归属接管。
function pmClash(identity) {
  if (identity.ownerOfParties.length > 0 || identity.delegateOfParties.length > 0) {
    return { code: 'clash', message: '该用户在本项目是某一方的领导或负责人，PM 不得兼任' };
  }
  if (identity.partyId !== null && identity.partyId !== undefined) {
    return { code: 'in_party', message: '该用户在本项目属于某参与方，PM 的成员身份不能挂在参与方下，请先让其离开该方' };
  }
  return null;
}

// 参与方及人员管理继续遵循 membership 项目状态行，入口和读模型共用动作判断。
function ownsParty(identity, partyId) {
  return Array.isArray(identity.ownerOfParties) && identity.ownerOfParties.includes(Number(partyId));
}
function canActAsPm(identity) {
  if (identity.isReadonly) return false;
  return !!identity.isPm;
}
const noStateLimit = () => null;
const PROXY_FACT_UNKNOWN_MESSAGE = '无法确定代录的前置事实，请刷新后重试';
const SELF_TARGET_MESSAGE = '不能对自己执行该管理操作';
function isSelfManagedTarget(identity, target) {
  return target.targetUserId !== null && target.targetUserId !== undefined && Number(target.targetUserId) === Number(identity.userId);
}
const batchNoEdit = (t) => t.batchStatus === 'live';
// 总体规划待确认期间节点排期 / 取消节点的拒绝文案（C4a P34；读接口 actions 与写端点共用 OBJECT_OPS 的判定，这里只放文案）。
const OVERALL_PENDING_PLAN_MESSAGE = '总体规划待确认中，排期已随包冻结；如需修改请撤回提交';
// 新建需求部门参与方时本项目有待确认的立项包 / 总体规划包（C4a P35）：必需确认人集合已随提交生成，新方不在其中。
const PENDING_PACKAGE_PARTY_MESSAGE = '有待确认的内容包，请先撤回提交';
// 提交确认的项目级前置文案（C4a 修订批二 MED-1：提交标志与执行同源，两端都经 OBJECT_OPS.package_version_submit 给出，不在端点里另写一份）。
const NO_DEMAND_PARTY_MESSAGE = '项目还没有需求部门参与方，无法确定必需确认人';
const PARENT_SUPERSEDED_MESSAGE = '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿';
const CONFIRMERS_UNKNOWN_MESSAGE = '无法确定必需确认人，请刷新后重试';
// C6a：批次验收包 / 结项包提交的前置文案与事实缺失文案（提交标志与执行同源，经 OBJECT_OPS.package_version_submit）。
const BATCH_FACT_UNKNOWN_MESSAGE = '无法确定批次状态，请刷新后重试';
const CLOSING_FACT_UNKNOWN_MESSAGE = '无法确定批次上线情况，请刷新后重试';
const PENDING_FACT_UNKNOWN_MESSAGE = '无法确定项目里是否已有待确认的内容包，请刷新后重试';
// parent_overall_version_id 在提交时按现行总体规划版本重写的包类型（packages.js computeFormAndParent / rewriteFormAndParent）：草稿期间总体规划换版不挡提交
const PARENT_REWRITTEN_AT_SUBMIT_TYPES = Object.freeze(['batch_accept', 'closing']);
// C6a 上线
const GOLIVE_FACT_UNKNOWN_MESSAGE = '无法确定上线前置事实，请刷新后重试';
function goliveBatchStateMessage(batchStatus) {
  if (batchStatus === 'live') return '批次已正式上线';
  if (batchStatus === 'planning') return '批次还没有进入进行中，不能确认试运行结束';
  return BATCH_FACT_UNKNOWN_MESSAGE;
}
function goliveBlockedMessage(blockers) {
  return `上线前置条件未满足：${blockers.map((b) => b.message).join('；')}`;
}
function closingNotReadyMessage(cn) {
  const parts = [];
  if (Array.isArray(cn.notLive) && cn.notLive.length > 0) parts.push(`以下批次还没有正式上线：${cn.notLive.join('、')}`);
  return `不能提交结项：${parts.join('；') || CLOSING_FACT_UNKNOWN_MESSAGE}`;
}
const INITIATION_NOT_EFFECTIVE_MESSAGE = '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后才能确认需求与范围）';
// 总体规划包提交前须计划齐全（codex 19 号 H-1 / P43）：基线只能来自被确认的计划。文案后接缺计划的节点标签（顿号分隔）。
const PLANS_UNKNOWN_MESSAGE = '无法确定节点计划是否齐全，请刷新后重试';
// ── C3b：内容包的判定（方案 v1.2 §5.2）──────────────────────────────────────────────────
// 内容包版本的草稿判定：草稿期才能编辑 snapshot（条件更新的 SQL 里另有 status = 'draft' 兜底）。
const draftVersionState = (t) => (t.versionStatus === 'draft' ? null : '只有草稿版本可以修改');
// ── C5 S-S1a：登记与办理（方案 v1.4 §4.1 登记规则表、§5.2 动作矩阵；C6 起办理只剩更正与作废，结论、异议、拆分、开发方认可等规则已删）──────────────────────────────────────────
const ENTRY_VOIDED_MESSAGE = '登记已作废，不能再办理';
const entryNotVoided = (t) => {
  if (t.voided === true) return ENTRY_VOIDED_MESSAGE;
  if (t.voided !== false) return PROXY_FACT_UNKNOWN_MESSAGE; // fail-closed：事实没取到一律拒绝
  return null;
};
// 写登记：admin（可非成员）、PM、本项目已加入未移出的成员；只读账号一票否决（含 admin 与 PM 本人）。非成员且非 admin / 只读的人在可见性一步已 404。
function canRegisterEntry(identity) {
  return !!(!identity.isReadonly && (identity.isAdmin || identity.isMember));
}
// 更正 / 作废：登记人本人或 PM；只读账号一票否决。t.isRegistrant = 操作人就是登记的 operator_user_id。
function canCorrectOrVoidEntry(identity, project, t) {
  if (identity.isReadonly) return false;
  return !!(identity.isPm || t.isRegistrant === true);
}
const OBJECT_OPS = Object.freeze({
  party_add: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.side === 'dev' && t.hasDevParty) return '本项目已有开发方参与方，每个项目至多一个';
      return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35
    },
  }),
  party_rename: Object.freeze({ can: canActAsPm, state: noStateLimit }),
  member_add: Object.freeze({ can: canActAsPm, noSelf: true, state: noStateLimit }),
  member_remove: Object.freeze({
    can: canActAsPm,
    noSelf: true,
    state: (t) => {
      if (t.removed) return '该成员已移出';
      return t.isPmRow ? 'PM 本人的成员行不能移出，要更换 PM 请走更换 PM' : null;
    },
  }),
  party_people: Object.freeze({ can: canActAsPm, state: noStateLimit }),
  appointment_end: Object.freeze({ can: canActAsPm, noSelf: true, state: (t) => (t.status === 'active' ? null : '只有现任的任职可以结束') }),
  delegation_revoke: Object.freeze({ can: canActAsPm, noSelf: true, state: (t) => (t.status === 'active' ? null : '只有生效中的授权可以撤销') }),
  // ── C3a：批次 / 节点 / 排期（方案 v1.2 §3.2、§4.4、§4.5；派单 §3.5）─────────────────────────────────────────────────
  // 谁：以 PM 身份行事（非只读且本人就是本项目 PM；admin 接管后才是 PM，§5.2「改期」「节点开始 / 收口 / 重开」行）。
  // 对象状态（state）只看 target 里的事实，不读库；target 由 plan.js 的 batchTarget / nodeTarget 构造，读接口的 actions 与写端点走同一份：
  //   节点类 target = { nodeStatus, templateKey, isMilestone, isProjectLayer, batchStatus（项目层节点为 null）, hasBaseline, hasActual: { actual_start, actual_end }, corrects? }；
  //   批次类 target = { batchStatus }。
  batch_update: Object.freeze({ can: canActAsPm, state: () => null }),
  node_start: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.nodeStatus !== 'not_started') return '只有未开始的节点可以开始';
      if (t.devStartReady === 'ok' || t.devStartReady === 'not_dev_node') return null;
      return '开发节点开始条件无法读取，请刷新后重试';
    },
  }),
  node_close: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.nodeStatus !== 'in_progress') return '只有进行中的节点可以收口';
      // C6a：整体验收结项（p_closing）可以收口了（原预筛 D3 的拒绝去掉）：它的前置（结项包已生效、每个有效批次已正式上线、结项包晚于每个批次最后一条上线事件、项目整体未结过程登记）
      //   在 plan.js closeBlockers，收口同一事务里项目转入已结项（plan.js 收口端点）。
      return t.isMilestone ? '正式上线里程碑以上线事件收口，不能走节点收口' : null;
    },
  }),
  node_reopen: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.nodeStatus !== 'closed') return '只有已收口的节点可以重开';
      if (t.isMilestone) return '正式上线里程碑不能重开，请走撤销上线';
      return t.batchStatus === 'live' ? '批次已正式上线，本批节点不能重开，须先由 admin 撤销上线' : null;
    },
  }),
  node_cancel: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.isProjectLayer) return '项目层节点按模板固定，不能取消';
      if (t.nodeStatus !== 'not_started') return '只有未开始的节点可以取消';
      if (t.isMilestone) return '正式上线里程碑不能取消';
      if ([ACCEPTANCE_NODE_KEYS.outsource, ACCEPTANCE_NODE_KEYS.procurement].includes(t.templateKey)) return '承载验收确认的预设阶段不能取消';
      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE; // C4a P34：总体规划待确认期间排期已随包冻结，取消节点也会改变将形成的基线
      return batchNoEdit(t) ? '批次已正式上线，不能取消节点' : null;
    },
  }),
  node_rename: Object.freeze({ can: canActAsPm, state: (t) => (t.nodeStatus === 'cancelled' ? '已取消的节点不能改名' : null) }),
  node_add: Object.freeze({ can: canActAsPm, state: (t) => (batchNoEdit(t) ? '批次已正式上线，不能新增节点' : null) }),
  node_reorder: Object.freeze({ can: canActAsPm, state: (t) => (batchNoEdit(t) ? '批次已正式上线，不能调整节点顺序' : null) }),
  schedule_plan: Object.freeze({
    can: canActAsPm,
    // 预筛 D1：已取消一律拒绝；已收口的节点「还没有 baseline」时仍可补草稿期计划（否则缺计划的已收口节点会永久挡住 b_req / p_overall 收口，
    //   只能靠重开 + 级联脱困），已有 baseline 后已收口节点不能再改计划（基线形成时计划已齐全）。
    //   C4a P34：本项目的总体规划版本待确认期间（t.overallPending），任何节点都不能设计划 / 改期——总体排期基线是确认对象（方案 §3.1），
    //   排期随提交冻结；新增节点仍允许（没有计划不进基线）。要改先撤回提交。
    state: (t) => {
      if (t.nodeStatus === 'cancelled') return '已取消的节点不能修改计划';
      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE;
      return t.nodeStatus === 'closed' && t.hasBaseline ? '已有基线的已收口节点不能修改计划' : null;
    },
  }),
  // 更正实际开始 / 实际结束（预筛 M3）：被更正的那类实际记录必须已存在；更正实际结束还要求节点当前已收口（未收口时实际结束不生效，
  //   更正只会留下一条看不见的记录）。读接口按种类拆成 correct_actual_start / correct_actual_end 两个标志，各带对应的 corrects。
  //   target.corrects 缺省 = 任一类可更正即可（仅防御，读接口不再用）。
  schedule_correct: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.nodeStatus === 'cancelled') return '已取消的节点不能更正实际日期';
      if (t.corrects === 'actual_end' && t.nodeStatus !== 'closed') return '只有已收口的节点可以更正实际结束';
      const has = t.hasActual || {};
      const kinds = t.corrects ? [t.corrects] : ['actual_start', 'actual_end'];
      return kinds.some((k) => has[k] === true) ? null : '该节点还没有可更正的实际日期记录';
    },
  }),
  // ── C3b：内容包与版本（方案 v1.2 §2.3、§4.5；派单 C3b §3.2）────────────────────────────
  // target 约定（端点的 target 构造函数与读接口 actions 共用同一份）：
  //   包创建 { type, exists（该项目 / 该批次已有同类型包）, batchStatus（batch_accept 的批次状态）}；
  //   包版本新建 { packageType, hasDraft, hasPending, hasEffective, batchStatus（批次包所在批次的状态；项目级包缺省）}；
  //   包版本编辑 { versionStatus, batchStatus（同上）}。
  // C8候选材料只追加，不自动成为执行依据。收口后先重开节点；已取消或批次冻结拒绝。
  material_version_create: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (!['not_started', 'in_progress', 'closed'].includes(t.nodeStatus)) return '已取消的阶段不能维护材料';
      if (t.batchStatus !== undefined && !ACTIVE_BATCH_STATUSES.includes(t.batchStatus)) return '批次当前状态不允许维护材料';
      return null;
    },
  }),
  package_create: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      // C5（R10）：包类型已在建包入口按最终清单（PACKAGE_TYPES_FINAL）拒绝，这里的 type 只会是清单里的值；第一期不建批次需求包（单批项目的批次需求并入总体规划包的合并形态，§2.3）。
      if (t.exists) return '该项目（或该批次）已有同类型的内容包，每个只能有一个';
      return null;
    },
  }),
  package_version_create: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      // D1（预筛裁定）：总体规划包已有生效版本时不能直接建草稿——范围已确认后不再出新版本（核心原则 4 / 不变量 2）。
      //   立项包、结项包、验收包不受此限。
      if (t.packageType === 'overall' && t.hasEffective) return '范围已确认，不能再出新版本';
      // S4（主会话自决）：每个包同一时刻至多一个草稿版本；库内另有「同包至多一个待确认版本」的唯一索引，这里先拒绝，不留给约束报 500。
      if (t.hasDraft) return '该内容包已有草稿版本，请先在草稿上修改';
      return t.hasPending ? '该内容包已有待确认的版本，请等待处理后再建新版本' : null;
    },
  }),
  package_version_edit: Object.freeze({ can: canActAsPm, state: draftVersionState }),
  // ── C4a：内容包提交确认 / 撤回、确认任务改发 / 决策（方案 v1.2 §4.2、§4.5、§5.2「发起确认」「作出确认」；派单 C4a P22–P28）──────────────────
  // state 可以返回字符串（409 SYSBUILD_STATE）或 { code, message }（409 带指定错误码，如 SYSBUILD_TASK_SUPERSEDED）。
  // target 约定：
  //   提交 { versionStatus, packageType, batchStatus, confirmersMissing, initiationEffective（仅总体规划包判）, planMissing（仅总体规划包判）, scopeRejection（仅立项包判）}；撤回 { versionStatus, packageType, batchStatus }；
  //   改发 { objectType, objectStatus（所在对象版本状态：包版本 status）, revisionStatus（当前修订）, batchStatus }；
  //   决策 { isRequired（本人是当前修订的必需确认人）, currentRevisionId, revisionStatus, objectVersionId, objectPending, qualificationLoss（失去资格的原因，无则空）,
  //     revisionIdGiven / objectVersionIdGiven（请求带的值；读接口 actions 不带，缺省不判）}。
  // 提交标志（读接口 actions.submit）与提交执行同源（修订批二 MED-1）：标志承诺「权限、对象状态（草稿 + 类型开放 + 批次未冻结）、立项前置（总体规划包）、
  //   必需确认人齐全」，修订批三 H-1 起再加「计划齐全（总体规划包）」；这些项目级事实 packages.js versionFactsOf 在读写两端用同一个函数取
  //   （confirmersMissing / initiationEffective / planMissing，缺失按 fail-closed 拒绝）。
  package_version_submit: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';
      // C5 S-S1c（C4 / C5 交接）：草稿建立时继承的现行总体规划版本已被替代 → 请基于现行规划重建草稿。批次需求包（第一期没有，类型本身不开放提交）共用这一条，
      //   排在「类型是否开放」之前，批次需求包的纯规则用例据此直接断言；事实由 packages.js versionFactsOf 取（只在 === true 时拒绝，缺失不拒）。
      //   C6a：批次验收包 / 结项包「只引用验收 / 结项时的现行版本」（§2.2 不变量 2），提交时 parent 按现行版本重写（packages.rewriteFormAndParent），草稿期间总体规划换版不算「过期草稿」，
      //   不拒绝（否则这两类包没有别的办法重建草稿——建新草稿要求本包没有草稿）。生效之后换版的过期由上线前置 ACCEPT_STALE / p_closing 前置 CLOSING_STALE 另挡（P168，见 packages.js computeFormAndParent 注释的三处共同保证）；总体规划包 / 批次需求包的 parent 不重写，仍按本条拒绝。
      if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;
      if (!SUBMITTABLE_PACKAGE_TYPES.includes(t.packageType)) return '该类型的内容包 C5 / C6 起可用提交确认';
      // C6a 批次验收包：只有「进行中」的批次可以提交验收（规划中或已上线均拒绝）。事实没取到拒绝。
      if (t.packageType === 'batch_accept' && t.batchStatus !== 'active') {
        if (t.batchStatus === 'planning') return '批次还没有进入进行中，不能提交批次验收';
        return t.batchStatus === 'live' ? '批次已正式上线，不能再提交批次验收' : BATCH_FACT_UNKNOWN_MESSAGE;
      }
      // C6a 结项包：项目内每个有效批次（不含已转出 / 被替代）都已正式上线（entries-core.batchLiveState）；不满足 409 并列出批次。
      //   closingNotReady = null（满足）或 { notLive: [批次名] }；事实没取到拒绝（packages.js versionFactsOf 在读写两端同源取）。
      if (t.packageType === 'closing') {
        const cn = t.closingNotReady;
        if (cn === undefined) return CLOSING_FACT_UNKNOWN_MESSAGE;
        if (cn !== null) return closingNotReadyMessage(cn);
      }
      // C6a 待确认互斥（P139）：总体规划 / 批次验收 / 结项三类包（C5 后互斥类型即这三类）同一项目同一时刻最多一个待确认版本；otherPendingPackage = 其他已待确认包的类型（null = 没有；undefined = 事实没取到，拒绝）。
      if (EXCLUSIVE_PENDING_PACKAGE_TYPES.includes(t.packageType)) {
        if (t.otherPendingPackage === undefined) return PENDING_FACT_UNKNOWN_MESSAGE;
        if (t.otherPendingPackage !== null) return `已有待确认的内容包：${PACKAGE_TYPE_LABELS[t.otherPendingPackage] || t.otherPendingPackage}，须先撤回或等确认完成`;
      }
      // 必需确认人齐全（P23）：confirmersMissing = null（齐全）或 { noParty, missing: [参与方（缺…）] }；undefined = 事实没取到，fail-closed。
      const cm = t.confirmersMissing;
      if (cm === undefined) return CONFIRMERS_UNKNOWN_MESSAGE;
      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少必需确认人：${cm.missing.join('、')}`;
      // G0 前置（P37，方案 §2.3「G0 立项通过 → 总体范围与批次规划生效」）：只对总体规划包；立项包自己的提交是这个前置本身。
      if (t.packageType === 'overall' && t.initiationEffective !== true) return INITIATION_NOT_EFFECTIVE_MESSAGE;
      // 计划齐全（codex 19 号 H-1 / P43，只对总体规划包）：planMissing = null（齐全）或缺计划的节点标签数组；undefined = 事实没取到，fail-closed。
      if (t.packageType === 'overall') {
        if (t.planMissing === undefined) return PLANS_UNKNOWN_MESSAGE;
        if (t.planMissing !== null) return t.planMissing;
      }
      // 51 号 HIGH-1：送审内容本身被拒（集合重核、材料不可用）时原样报出原因与错误码，先于评估事实；不能让用户误以为评估不可读而去作废有效评估。
      if (t.scopeRejection) return t.scopeRejection;
      if (t.packageType === 'initiation' && t.initiationBasis !== 'ok') return '请选入「立项依据」中带可用附件的一版，或在立项依据卡片填写无书面依据原因（10–500字）';
      if (t.packageType === 'overall' && t.pairedBasis !== true) return '请选入「需求文档」中带可用附件的一版';
      if (t.packageType === 'batch_accept' && t.pairedBasis !== true) return '请选入「验收记录」中带可用附件的一版';
      if (t.packageType === 'closing' && t.missingCards) return '以下必做事项尚未完成，不能发起结项确认：' + t.missingCards;
      if (t.packageType === 'closing' && t.pendingWork) return t.pendingWork;
      if (t.hasConfirmationText !== true) return { code: 'SYSBUILD_STATE', field: 'snapshot_json.text', message: '请填写本版确认正文后再发起确认' };
      return null;
    },
  }),
  package_version_withdraw: Object.freeze({
    can: canActAsPm,
    state: (t) => (t.versionStatus === 'pending' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回'),
  }),
  // 改发的修订状态：待确认 / 有异议 / 不认可，以及「已失效」——项目终止时全部待确认修订被置为已失效（P38），重开后由 PM 改发；
  //   撤回提交产生的已失效修订不会走到这里（版本已不是待确认，上一条先拦下）。
  //   reissueBlocked = 改发解析的结果（confirm.js resolveReissue：当前没有可作为确认人的负责人 / 代表人，或新人在本版本已以另一身份确认，P36）。
  //   读接口 actions.reissue 与执行共用这条判定，标志为真则执行必 2xx（L3①）。
  confirm_reissue: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.objectType !== 'package_version') return '该类型的确认任务不支持改发';
      if (t.objectStatus !== 'pending') return '任务所在的版本已不是待确认，不能改发';
      if (!['pending', 'objected', 'rejected', 'invalid'].includes(t.revisionStatus)) return '只有待确认、有异议、不认可或已失效的修订可以改发';
      return t.reissueBlocked || null;
    },
  }),
  // 作出确认：只认「本人是当前修订的必需确认人」。**不**带只读否决——方案 §5.1：只读账号「也只能查看和作出本人的确认类动作」（确认、有异议…）；
  //   领导只读账号正是部门负责人这类必需确认人。派单 P27 写「项目只读账号 403」与方案 §5.1 冲突，按方案（P31：主会话 11-01 裁定保持现状，
  //   即 confirm_decide 不带只读否决；P27 该句被更正）。
  confirm_decide: Object.freeze({
    can: (identity, project, t) => t.isRequired === true,
    state: (t) => {
      if (t.revisionIdGiven !== undefined && t.revisionIdGiven !== t.currentRevisionId) return { code: 'SYSBUILD_TASK_SUPERSEDED', message: '该确认任务已被改发或替代，请刷新后重试' };
      if (t.objectVersionIdGiven !== undefined && t.objectVersionIdGiven !== t.objectVersionId) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本与任务不符，请刷新后重试' };
      if (t.revisionStatus !== 'pending') return '该任务修订已处理，不能再次决策';
      if (!t.objectPending) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本已不在待确认状态' };
      return t.qualificationLoss || null;
    },
  }),
  // ── C5 S-S1a 登记与办理（方案 v1.4 §4.1、§4.2 办理结论 / 异议裁定、§4.5 状态 × 动作、§5.2；派单 C5_S-S1a §3–§7）──────────────────────────────────────────
  // 写登记：时段由服务端判定，过程登记按 register_process 类、补充登记按 register_supplement 类判项目状态（已终止 / 已结项只能写补充登记）；谁能写两类一样。
  //   target = {}（写登记没有对象状态；业务规则——用途 / 证据 / 来源方——在端点里按 400 / 409 判）。
  entry_create_process: Object.freeze({ can: canRegisterEntry, state: noStateLimit }),
  entry_create_supplement: Object.freeze({ can: canRegisterEntry, state: noStateLimit }),
  // 意见与阶段任务有独立状态，普通角色走项目维护，砍需求本人表态走确认类别。
  opinion_create: Object.freeze({ can: canRegisterEntry, state: noStateLimit }),
  opinion_triage: Object.freeze({
    can: canActAsPm,
    state: (t) => t.opinionStatus === 'triage' ? null : '这条意见已完成初判，请刷新后查看',
  }),
  opinion_assess: Object.freeze({
    can: (identity, project, t) => !identity.isReadonly && (identity.isPm || t.isDevResponsible === true),
    state: (t) => t.opinionStatus === 'assessment' ? null : '这条意见当前无需开发评估，请刷新后查看',
  }),
  opinion_dispose: Object.freeze({
    can: canActAsPm,
    state: (t) => t.opinionStatus === 'disposition' ? null : '这条意见当前不在待定去向，请刷新后查看',
  }),
  opinion_cut_decide: Object.freeze({
    // 本人与原确认相同，拥有本部门当前授权的只读账号也可亲自表态。
    can: (identity, project, t) => t.isCutResponsible === true,
    state: (t) => t.opinionStatus === 'cut_approval' && t.cutStatus === 'pending' ? null : '当前已无可提交的本人表态，请刷新后查看',
  }),
  opinion_cut_withdraw: Object.freeze({
    can: canActAsPm,
    state: (t) => t.opinionStatus === 'cut_approval' ? null : '这条意见当前没有待撤回的同意事项',
  }),
  work_task_create: Object.freeze({ can: canActAsPm, state: noStateLimit }),
  work_task_result: Object.freeze({
    can: (identity, project, t) => !identity.isReadonly && (identity.isPm || (identity.isMember && identity.userId === t.assigneeUserId)),
    state: (t) => t.taskStatus === 'pending' ? null : '这条任务已有结果，请刷新后查看',
  }),
  // 办理动作 target（entries-core.entryTarget 构造，读接口逐对象 actions 与写端点同一份）：
  //   { formKind, formKindHint, formUnreadable, isRegistrant, registrantWasPm（登记时身份快照 is_pm；C6 后没有规则读它，留待后续清理）, voided, type }。C6 起办理只剩更正与作废。
  //   事实没取到（undefined）一律 fail-closed 拒绝。
  entry_correct: Object.freeze({ can: canCorrectOrVoidEntry, state: entryNotVoided }),
  entry_void: Object.freeze({
    can: canCorrectOrVoidEntry,
    state: (t) => {
      if (t.formKind === 'report_cycle' || t.formKindHint === 'report_cycle') return '汇报节奏不可作废，请新登记一条节奏替代';
      const v = entryNotVoided(t);
      if (v) return v;
      return null;
    },
  }),
  //   写进度汇报（entry-forms.assertFormRegistrant 与元数据 devAllowed 用；C6 起通用登记不再有开发方用途）：开发方负责人、开发方代表人、PM 代登；其他人（含需求方、admin 非成员）403。项目状态类别 accept。
  //   target = { devPartyId（本项目开发方参与方编号，没有为 null） }；来源方须是开发方等业务规则在端点里按 400 判。只读账号一票否决。
  entry_create_dev: Object.freeze({
    can: (identity, project, t) => {
      if (identity.isReadonly) return false;
      if (identity.isPm) return true;
      if (t.devPartyId === null || t.devPartyId === undefined) return false;
      const dp = Number(t.devPartyId);
      return ownsParty(identity, dp) || (Array.isArray(identity.delegateOfParties) && identity.delegateOfParties.includes(dp));
    },
    state: noStateLimit,
  }),
  // ── C6a 上线（方案 §3.2 :467、§4.5 状态机、§5.2 :855–857；派单 C6a §3–§8）──────────────────────────────────────
  // 确认试运行结束（正式上线 / 再上线）：PM（admin 接管后），项目状态类别 golive（只有「进行中」，暂停 409 SYSBUILD_PROJECT_READONLY）。
  //   target = { batchStatus, blockers }：blockers = 上线前置未满足项（golive-core.goliveBlockersOf：本批节点未收口 / 验收包未生效或引用的规划已过期 / 有待确认的范围包，按当时状态现算，
  //   读接口 actions.golive 与执行同一个函数），undefined = 事实没取到，拒绝。上线本身只认批次状态 = 进行中。
  golive: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.batchStatus !== 'active') return goliveBatchStateMessage(t.batchStatus);
      if (!Array.isArray(t.blockers)) return GOLIVE_FACT_UNKNOWN_MESSAGE;
      return t.blockers.length > 0 ? { code: 'SYSBUILD_GOLIVE_BLOCKED', message: goliveBlockedMessage(t.blockers) } : null;
    },
  }),
  // 撤销正式上线：**admin**（§5.2 :856，非只读账号；不需要先接管），写原因（端点解析）；项目状态类别 maintain（进行中 / 已暂停可，已终止 / 已结项 409，已结项须先由 admin 重开项目）。
  //   target = { batchStatus, closingPending }：批次状态须为已上线（live）；本项目有待确认的结项包 409（P150：先撤回结项包）。事实没取到拒绝。
  revoke_golive: Object.freeze({
    can: canChangeProjectStatus,
    state: (t) => {
      if (t.batchStatus !== 'live') return t.batchStatus === undefined ? BATCH_FACT_UNKNOWN_MESSAGE : '只有已正式上线的批次可以撤销上线';
      if (t.closingPending === true) return '本项目有待确认的结项包，请先撤回结项包再撤销上线';
      return t.closingPending === false ? null : PENDING_FACT_UNKNOWN_MESSAGE;
    },
  }),
});
// 每个动作适用的项目状态类别（PROJECT_ACTION_TABLE 的键）。checkOp 只查这张表，不再把类别写死（C3a：节点收口是 close，其余维护类是 maintain）。
//   冻结表：键集合必须与 OBJECT_OPS 全等（下面的加载断言，新增动作漏登记这里 = 模块加载即抛错）；checkOp 对未登记动作再抛 500，没有缺省类别。
const OP_KIND = Object.freeze({
  party_add: 'membership',
  party_rename: 'membership',
  member_add: 'membership',
  member_remove: 'membership',
  party_people: 'membership',
  appointment_end: 'membership',
  delegation_revoke: 'membership',
  batch_update: 'maintain',
  node_start: 'maintain',
  node_close: 'close',
  node_reopen: 'maintain',
  node_cancel: 'maintain',
  node_rename: 'maintain',
  node_add: 'maintain',
  node_reorder: 'maintain',
  schedule_plan: 'maintain',
  schedule_correct: 'maintain',
  // C3b：内容包的草稿编辑都属「维护」类（方案 v1.2 §4.5：草稿编辑（内容包）进行中 / 已暂停可，已终止 / 已结项否）
  material_version_create: 'maintain',
  package_create: 'maintain',
  package_version_create: 'maintain',
  package_version_edit: 'maintain',
  // C4a：发起确认（提交 / 撤回 / 改发）属「维护」类（§4.5：发起内容包确认 进行中 / 已暂停可，已终止 / 已结项否）；作出确认属「作出推进类确认」accept 类
  //   （进行中 / 已暂停可，已终止 / 已结项否）。
  package_version_submit: 'maintain',
  package_version_withdraw: 'maintain',
  confirm_reissue: 'maintain',
  confirm_decide: 'accept',
  // C5 S-S1a：写登记按时段分两类（已终止 / 已结项只能写补充登记）；既有登记的更正 / 作废 = 继续办理
  //   （resolve：四态都允许，方案 §4.5 表「既有登记继续办理」行）。更正 / 作废派单未指定类别，主会话待追认，暂同 resolve。
  entry_create_process: 'register_process',
  entry_create_supplement: 'register_supplement',
  opinion_create: 'maintain',
  opinion_triage: 'maintain',
  opinion_assess: 'maintain',
  opinion_dispose: 'maintain',
  opinion_cut_decide: 'accept',
  opinion_cut_withdraw: 'maintain',
  work_task_create: 'maintain',
  work_task_result: 'maintain',
  entry_correct: 'resolve',
  entry_void: 'resolve',
  // C6 R6：登记进度汇报（开发方负责人 / 代表人 / PM 代登）；认可任务已删，不再有「需要负责人认可」（accept 类，已终止 / 已结项否）
  entry_create_dev: 'accept',
  // C6a：确认试运行结束（上线 / 再上线）= golive 类（只有进行中）；撤销上线 = 维护类（仅 admin，已终止 / 已结项 409）。
  golive: 'golive',
  revoke_golive: 'maintain',
});
const OP_KIND_MISSING = Object.keys(OBJECT_OPS).filter((k) => !Object.prototype.hasOwnProperty.call(OP_KIND, k));
const OP_KIND_EXTRA = Object.keys(OP_KIND).filter((k) => !Object.prototype.hasOwnProperty.call(OBJECT_OPS, k) || !Object.prototype.hasOwnProperty.call(PROJECT_ACTION_TABLE, OP_KIND[k]));
if (OP_KIND_MISSING.length > 0 || OP_KIND_EXTRA.length > 0) {
  throw new Error(`rules.js: OP_KIND 与 OBJECT_OPS 不全等（漏登记: ${OP_KIND_MISSING.join(',') || '无'}；多余或类别不在状态表: ${OP_KIND_EXTRA.join(',') || '无'}）`);
}
// 判定一个动作。允许返回 null，否则返回业务拒绝。
function checkOp(op, identity, project, target) {
  if (!Object.prototype.hasOwnProperty.call(OBJECT_OPS, op)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：动作未登记');
  const def = OBJECT_OPS[op];
  const t = target || {};
  if (!def.can(identity, project, t)) return { status: 403, code: 'SYSBUILD_FORBIDDEN', message: '没有权限执行该操作' };
  // 项目状态类别取 OP_KIND（硬门：未登记的动作报 500，没有缺省类别；C2 动作全是 membership，C3a 起节点收口是 close）。
  if (!Object.prototype.hasOwnProperty.call(OP_KIND, op)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：动作未登记项目状态类别');
  if (!projectAllowsWrite(project.status, OP_KIND[op])) return { status: 409, code: 'SYSBUILD_PROJECT_READONLY', message: '当前项目状态不允许该写入' };
  // L1：登记办理与读接口 actions 共用此处；不可读表单只保留作废出口（entry_void 只核汇报节奏不可作废与是否已作废，C6 起无引用保护）。
  if (op.startsWith('entry_') && op !== 'entry_void' && t.formUnreadable === true) return { status: 409, code: 'SYSBUILD_STATE', message: '表单无法读取，除作废外不能办理，请先作废后重新登记' };
  if (def.noSelf && isSelfManagedTarget(identity, t)) return { status: 409, code: 'SYSBUILD_STATE', message: SELF_TARGET_MESSAGE };
  const msg = def.state(t);
  if (msg) return typeof msg === 'string' ? { status: 409, code: 'SYSBUILD_STATE', message: msg } : {
    status: [400, 500].includes(msg.status) ? msg.status : 409, code: msg.code, message: msg.message,
    ...(msg.field ? { field: msg.field } : {}), ...(msg.pending_work ? { pending_work: msg.pending_work } : {}),
  };
  return null;
}
function opAllowed(op, identity, project, target) {
  return checkOp(op, identity, project, target) === null;
}
function assertOp(op, identity, project, target) {
  const v = checkOp(op, identity, project, target);
  if (v) throw Object.assign(makeError(v.status, v.code, v.message),
    v.field ? { field: v.field } : {}, v.pending_work ? { pending_work: v.pending_work } : {});
}
// 读接口返回的 actions：每个标志 = 与写端点完全相同的「动作判定 + 项目状态查表」。前端不自行推算。
//   edit_basics：canEditProjectBasics 且状态表允许 basics；change_status / status_targets：canChangeProjectStatus，
//   targets 取自 STATUS_TRANSITIONS（POST status 的合法 to 集合，别的 to 一律 409）；
//   change_pm：canChangePm，**只表示「可以发起」**——新 PM 候选人由请求指定，不合格（不存在 / 停用 / 只读 / 角色不在写入名单 → 400；
//     兼任 / 有待接受成员行 / 属参与方 / 已是 PM → 409）是执行时对候选人的校验，不进这个标志；
//   takeover：canChangePm 且本人还不是 PM 且 pmClash(本人身份) 为 null（POST pm 把自己设为 PM 时目标就是本人，所以对本人调用同一个 pmClash）。
function actionsFor(identity, project) {
  const status = project.status;
  const editBasics = canEditProjectBasics(identity, project) && projectAllowsWrite(status, 'basics');
  const changeStatus = canChangeProjectStatus(identity, project);
  const changePm = canChangePm(identity, project);
  const partySides = ['demand', 'dev'].filter((side) => opAllowed('party_add', identity, project, { side, hasDevParty: !!identity.hasDevParty, hasPendingContentPackage: !!identity.hasPendingContentPackage }));
  return {
    edit_basics: editBasics,
    change_status: changeStatus,
    status_targets: changeStatus ? Array.from(STATUS_TRANSITIONS[status] || []) : [],
    change_pm: changePm,
    takeover: changePm && !identity.isPm && pmClash(identity) === null,
    // C2b：项目级成员与参与方管理。party_sides = 可以新建的参与方类别（开发方每项目至多一个），add_party 即 party_sides 非空。
    add_party: partySides.length > 0,
    party_sides: partySides,
    add_member: opAllowed('member_add', identity, project, {}),
    view_send_intents: canActAsPm(identity),
    // C5 S-S1a：能否写登记（任一时段可写即真：已终止 / 已结项只能写补充登记，时段由服务端按关联节点 / 项目是否收口判定，页面不让用户选）。
    create_entry: opAllowed('entry_create_process', identity, project, {}) || opAllowed('entry_create_supplement', identity, project, {}),
    create_opinion: opAllowed('opinion_create', identity, project),
  };
}

// ── 按 §5.3 顺序检查 ───────────────────────────────────────────────────────────────────
// 可见性：项目不存在、或调用者既非 admin / 成员 / 只读账号 → 404（不暴露项目存在）。判定交给 canViewProject（可见性只有一份）。
function assertVisible(access) {
  if (!access.project) throw NOT_FOUND();
  if (!canViewProject(access)) throw NOT_FOUND();
}
// 可见 → 动作权限（403）→ 项目状态（409）。writeKind 缺省表示读动作，不查状态。
function assertCan(access, canFn, opts) {
  assertVisible(access);
  if (!canFn(access, access.project)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');
  const writeKind = opts && opts.writeKind;
  if (writeKind && !projectAllowsWrite(access.project.status, writeKind)) {
    throw makeError(409, 'SYSBUILD_PROJECT_READONLY', '当前项目状态不允许该写入');
  }
}

module.exports = {
  parseId, hasControlChar, notFound: NOT_FOUND,
  loadProjectAccess, loadProjectIdentity, completeIdentity, platformIdentity, MEMBER_ACTIVE_SQL, pmClash,
  canViewAttachments, canStageAttachment, canMaskAttachment, canSoftDeleteAttachment, canExportConfirmationSheet,
  canViewProject, canListAll, canCreateProject, canEditProjectBasics, canChangeProjectStatus, canChangePm,
  PROJECT_ACTION_TABLE, STATUS_TRANSITIONS, projectAllowsWrite, actionsFor,
  SUBMITTABLE_PACKAGE_TYPES, EXCLUSIVE_PENDING_PACKAGE_TYPES, EXCLUSIVE_PENDING_SQL_LIST, PACKAGE_TYPE_LABELS,
  PACKAGE_TYPES_FINAL, ENTRY_PURPOSES_FINAL,
  canActAsPm, ownsParty, OBJECT_OPS, OP_KIND, checkOp, opAllowed, assertOp,
  assertVisible, assertCan,
};
