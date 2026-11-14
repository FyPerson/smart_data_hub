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
  const project = await q.get('SELECT id, pm_user_id, status FROM sysbuild_projects WHERE id = ?', [projectId]);
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
const SUBMITTABLE_PACKAGE_TYPES = Object.freeze(['overall', 'initiation', 'change', 'batch_accept', 'closing']);
const SUBMITTABLE_TYPES_SQL_LIST = SUBMITTABLE_PACKAGE_TYPES.map((x) => `'${x}'`).join(', ');
// 待确认互斥（C6a，主会话裁定 P139）：同一项目内，总体规划 / 变更 / 批次验收 / 结项四类包同一时刻最多一个版本处于待确认（立项包不在内）：验收包与结项包按提交时的现行规划冻结，
//   待确认期间规划不能再变。packages.js versionFactsOf 取「项目里已待确认的另一类（或另一个）包」的类型作为事实 otherPendingPackage，rules.package_version_submit 统一判定（提交标志与执行同源）。
//   中文名用于 409 文案「已有待确认的内容包：<类型>，须先撤回或等确认完成」。
const EXCLUSIVE_PENDING_PACKAGE_TYPES = Object.freeze(['overall', 'change', 'batch_accept', 'closing']);
const EXCLUSIVE_PENDING_SQL_LIST = EXCLUSIVE_PENDING_PACKAGE_TYPES.map((x) => `'${x}'`).join(', ');
const PACKAGE_TYPE_LABELS = Object.freeze({ overall: '总体规划', change: '变更', batch_accept: '批次验收', closing: '结项', initiation: '立项', batch_req: '批次需求' });

// 在 loadProjectAccess 之上补齐 §5.1 的项目身份：本人成员行、所属参与方、现任负责人的参与方、生效代表人的参与方、
//   指向本人的待处理邀请（C2b 起窄范围入口 GET /my/invitations 自己按本人查询，这里的集合给 pmClash / 身份卡用）、是否有待接受的成员行、
//   名下是否有待处理的任职 / 授权提议。
//   项目不存在时只返回 loadProjectAccess 的结果加空集合。
//   成员行与任职 / 授权一律要求「已加入、未移出」的成员行：待接受与已移出的人没有项目身份。
//   分两步是为了让端点先做可见性（loadProjectAccess → assertVisible），看不见的人不用再付后面的查询（预筛 L6）：
//   端点用 loadProjectAccess + completeIdentity；loadProjectIdentity 是两步合一的便捷入口。
async function completeIdentity(q, access, user) {
  const identity = Object.assign({}, access, {
    memberId: null, partyId: null, ownerOfParties: [], delegateOfParties: [], pendingInvitations: [], pendingMemberRow: false, hasPendingProposal: false,
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
  const invs = await q.all(
    `SELECT i.id AS id, i.kind AS kind, i.appointment_id AS appointment_id FROM sysbuild_invitations i
       JOIN sysbuild_members m ON m.id = i.member_id
      WHERE i.project_id = ? AND m.user_id = ? AND i.status = 'pending' AND m.removed_at IS NULL
      ORDER BY i.id`,
    [projectId, uid]
  );
  identity.pendingInvitations = invs.map((r) => ({ id: r.id, kind: r.kind, appointment_id: r.appointment_id }));
  const pendingRow = await q.get(
    'SELECT m.id AS id FROM sysbuild_members m WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL AND m.joined_at IS NULL LIMIT 1',
    [projectId, uid]
  );
  identity.pendingMemberRow = !!pendingRow;
  // 待处理的任职 / 授权提议：任职 pending；授权 pending_owner（等负责人确认）/ pending_accept（等本人接受）。只看未移出的成员行。
  const proposal = await q.get(
    `SELECT m.id AS id FROM sysbuild_members m
      WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL
        AND (EXISTS (SELECT 1 FROM sysbuild_appointments a WHERE a.member_id = m.id AND a.status = 'pending')
          OR EXISTS (SELECT 1 FROM sysbuild_delegations d WHERE d.member_id = m.id AND d.status IN ('pending_owner', 'pending_accept')))
      LIMIT 1`,
    [projectId, uid]
  );
  identity.hasPendingProposal = !!proposal;
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
//   对应关系：maintain = 维护定稿材料、节点开始 / 重开 / 增删改名、草稿编辑、发起内容包确认、正式变更、改期；
//     **节点收口单列为 close**（方案 v1.2 §4.5 状态 × 动作表第二行：进行中是、已暂停否、已终止否、已结项否）——暂停时拒绝收口只来自这一行，
//     端点里不得另写「暂停时不能收口」的特例判断；上线（确认试运行结束）本就单列为 golive；
//   accept = 作出推进类确认（内容包、开发方关键事项等；**不含**接受 / 拒绝加入、任职、授权，见下面 D3）；
//   resolve = 既有登记的结论确认、异议、负责人裁定，**同时并入方案表第 5 行「既有登记继续办理（结论、确认、异议、转迭代）」**
//     （该行四态为 是 / 是 / 是 / 是，与 resolve 完全相同，不单列类别，预筛 L1）；
//   register_process / register_supplement / comment / attachment = 写登记（过程 / 补充）、评论、附件；golive = 确认试运行结束；
//   history_import = 历史事实导入（「时间窗内」由历史补录窗口另行判断）；g7 = G7 后评价；membership = 成员与授权变更；
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
  history_import: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),
  // C4b Q-S2 预筛 P67：关闭「历史补录中」窗口不受项目状态限制（已终止 / 已结项也能关；关闭只收窄能力）。开启 / 重开 / 补录 / 导入仍按上一行 history_import。
  history_close: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),
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
// P179（修订批 7，预筛 5 LOW-2）：上线事件的历史导入除按 history_import 类（进行中 / 已暂停可）判项目状态外，**另按 golive 类（确认试运行结束行）判**——导入上线 = 补记一次上线，只在进行中可做，
//   已暂停时与普通上线一样 409 SYSBUILD_PROJECT_READONLY。history.js 的 golive 导入与项目读接口 actions.history_import_golive 共用这一个函数（同源）。返回 null = 允许，否则 { status, code, message }。
const GOLIVE_IMPORT_PROJECT_MESSAGE = '项目当前状态不允许上线：暂停（或终止 / 结项）时不能导入上线事件，请先恢复为进行中';
function goliveImportProjectBlock(projectStatus) {
  return projectAllowsWrite(projectStatus, 'golive') ? null : { status: 409, code: 'SYSBUILD_PROJECT_READONLY', message: GOLIVE_IMPORT_PROJECT_MESSAGE };
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
// 「新 PM」候选人在本项目的身份是否挡住担任 PM；不挡返回 null，挡住返回 { code, message }。参数是候选人自己的项目身份（completeIdentity 的结果）。
//   更换 PM 的端点对目标用户调用它，actions.takeover 对本人调用同一个函数（预筛 M1：标志与执行同源）。三种挡法：
//   · clash：是本项目某一方的现任负责人 / 生效代表人，或名下有待处理的任职 / 授权提议（PM 不得兼任，§5.1）；
//   · pending_member：有待接受的成员行（先撤回邀请或让本人接受，预筛 M3 硬门：不替本人把成员行置为已加入）；
//   · in_party：已加入的成员行属于某参与方（PM 成员行 party_id 必须为空，须先离开该方，D5）。
function pmClash(identity) {
  if (identity.ownerOfParties.length > 0 || identity.delegateOfParties.length > 0 || identity.hasPendingProposal) {
    return { code: 'clash', message: '该用户在本项目是某一方的负责人 / 代表人或有待处理的任职 / 授权提议，PM 不得兼任' };
  }
  if (identity.pendingMemberRow) {
    return { code: 'pending_member', message: '该用户在本项目有待接受的成员邀请，请先撤回邀请或由本人接受后再更换' };
  }
  if (identity.partyId !== null && identity.partyId !== undefined) {
    return { code: 'in_party', message: '该用户在本项目属于某参与方，PM 的成员身份不能挂在参与方下，请先让其离开该方' };
  }
  return null;
}

// ── C2b：参与方、成员、任职、授权、邀请（M-S2）──────────────────────────────────────────────
// 方案 §5.1 / §5.2 / §4.5；派单 C2b。本域所有动作的项目状态一律查 PROJECT_ACTION_TABLE 的 membership 类别（D3：接受 / 拒绝加入、任职、
// 授权也按 membership 判，已终止拒绝、已结项允许）。动作判定函数签名 (identity, project, target) => boolean；只读账号对写入一票否决，
// 唯一例外是 §5.1 列明的「本人确认类」（接受 / 拒绝加入、任职、授权）与「授权 / 撤销本方代表人」（负责人本方）。
// 一个动作 = 一条 OBJECT_OPS 登记：can（谁）+ state（对象当前状态允许吗，返回 null 或 409 文案）+ 可选 requal（接受时的资格重核，
// 不满足即 stale：端点把邀请 / 授权提议置为已撤回后报 409）。写端点用 assertOp / checkOp，读接口的逐对象 actions 用 opAllowed——
// 同一张表、同一个顺序（权限 403 → 项目状态 409 → 对象状态 409 → 资格重核 409），前端不推算。
function ownsParty(identity, partyId) {
  return Array.isArray(identity.ownerOfParties) && identity.ownerOfParties.includes(Number(partyId));
}
function isSelfTarget(identity, target) {
  return target.userId !== null && target.userId !== undefined && Number(target.userId) === Number(identity.userId);
}
// 成员 / 参与方 / 任职管理与发邀请（方案 §5.2「添加 / 移出成员、指定负责人、发邀请」：admin 与 PM 都是「是」）：
//   非只读账号，且是本项目 PM 或 admin（admin 不必先接管）。只读账号一票否决，对 admin 同样生效。
//   D2 硬门（主会话裁定）：管理动作不得作用于操作人本人——由端点对目标逐一核对，不在这个判定里。
function canManageMembership(identity) {
  if (identity.isReadonly) return false;
  return !!(identity.isPm || identity.isAdmin);
}
// 「以 PM 身份行事」：非只读且本人就是本项目 PM。PM 发起代表人授权（待负责人确认）、PM 撤回授权提议只认这个身份——
//   admin 未接管时不是 PM，不能代 PM 授权（D4：接管后才可）。
function canActAsPm(identity) {
  if (identity.isReadonly) return false;
  return !!identity.isPm;
}
// 发起授权时的初始状态：本方现任负责人发起 = 本人提交即确认（含只读账号，§5.1），直接待被授权人接受；PM 发起 = 待负责人确认；其他人 null（403）。
function delegationInitialStatus(identity, partyId) {
  if (ownsParty(identity, partyId)) return 'pending_accept';
  if (canActAsPm(identity)) return 'pending_owner';
  return null;
}
// 撤回授权提议：以 PM 身份行事的人；或发起人本人且仍是本方负责人（L2：前 PM 发起的提议，换 PM 后他不再能撤回；
//   负责人是只读账号时仍可撤回自己发起的——那是「授权 / 撤销本方代表人」，§5.1）。
function canWithdrawDelegation(identity, project, target) {
  if (canActAsPm(identity)) return true;
  return Number(target.proposed_by) === Number(identity.userId) && ownsParty(identity, target.party_id);
}
const noStateLimit = () => null;
// C4b Q-S1 代录文案（预筛 D3 / L6）
const PROXY_SELF_MESSAGE = '本人请在平台确认，不能由项目经理代录自己的确认';
const PROXY_FACT_UNKNOWN_MESSAGE = '无法确定代录的前置事实，请刷新后重试';
const PROPOSER_DENIED_REISSUE_MESSAGE = '提出人已不认可，请对条目出新版本'; // codex 21 号 M1
// C4b Q-S2：历史补录窗口与当前确认任务按对象互斥（P58）。target.historyConflict = confirm-core 的 *HistoryConflict 助手结果：null = 无冲突，字符串 = 409 文案，
//   其余（undefined 等，事实没取到）一律拒绝（fail-closed）。读接口 actions 与写端点用同一个构造，所以标志与执行同源。
const historyConflictState = (t) => {
  if (t.historyConflict === null) return null;
  return typeof t.historyConflict === 'string' && t.historyConflict !== '' ? t.historyConflict : PROXY_FACT_UNKNOWN_MESSAGE;
};
// 历史补录窗口三态与四个动作（方案 §4.2 时间窗；锚点 P51 / Q-D2 / Q-D3）。target.historyWindow = 项目当前窗口状态（never / open / closed），不是三值之一视为事实没取到，拒绝。
const HISTORY_WINDOW_STATES = Object.freeze(['never', 'open', 'closed']);
const HISTORY_WINDOW_UNKNOWN_MESSAGE = '无法确定历史补录窗口状态，请刷新后重试';
const HISTORY_WINDOW_NOT_OPEN_MESSAGE = '历史补录窗口未开启，请先由项目经理开启';
// 历史事实导入开放的五类（Q-D3：上线事件 golive 随 C6a 开放，对象 = 批次）
const HISTORY_IMPORT_FACT_TYPES = Object.freeze(['appointment', 'delegation', 'package_effective', 'node_closed', 'golive']);
const pendingOwnerState = (t) => {
  if (t.status !== 'pending_owner') return '只有待负责人确认的授权提议可以处理';
  return t.appointmentIsCurrent ? null : '授权所依据的负责人任职已变化，请重新发起授权';
};
const pendingAcceptState = (t) => (t.status === 'pending_accept' ? null : '只有待被授权人接受的授权提议可以处理');
const pendingInvitationState = (t) => (t.status === 'pending' ? null : '该邀请已处理或已撤回');
const requalOf = (t) => t.requalReason || null;
// D2 / codex 16 号 M-1：管理动作（noSelf 登记的）不得作用于操作人本人——target.targetUserId 是被作用对象的用户编号
//   （移出成员 = 成员行的用户；撤回 / 结束任职 = 任职成员的用户；加成员 = 被邀请的用户；提议任职 = 被任命成员的用户）。
//   对 PM 与 admin 同样生效；无账号成员（targetUserId 为空）不适用。由有权的另一个人去做。
//   加成员 / 提议任职的目标由请求体指定，详情 actions 没有对象可算，端点在读到目标后用 assertNotSelfTarget 走同一个判定。
const SELF_TARGET_MESSAGE = '不能对自己执行该管理操作';
function isSelfManagedTarget(identity, target) {
  return target.targetUserId !== null && target.targetUserId !== undefined && Number(target.targetUserId) === Number(identity.userId);
}
// 批次状态集合（C3a）：已转出 / 被替代的批次不再维护；已正式上线的批次另外不能增删节点、重开节点（N-D2）。
const BATCH_FROZEN_STATUSES = Object.freeze(['transferred', 'superseded']);
const BATCH_NO_EDIT_STATUSES = Object.freeze(['live', 'transferred', 'superseded']);
const batchFrozen = (t) => BATCH_FROZEN_STATUSES.includes(t.batchStatus);
const batchNoEdit = (t) => BATCH_NO_EDIT_STATUSES.includes(t.batchStatus);
// 批次已转出 / 被替代：本批节点的全部写动作统一拒绝（预筛 D4，含重开）。各节点动作用它包一层自己的对象状态规则，不逐动作手写这条。
const withFrozenBatch = (stateFn) => (t) => stateFn(t) || (batchFrozen(t) ? '批次已转出或被替代，本批节点不能再写入' : null);
// 总体规划待确认期间节点排期 / 取消节点的拒绝文案（C4a P34；读接口 actions 与写端点共用 OBJECT_OPS 的判定，这里只放文案）。
const OVERALL_PENDING_PLAN_MESSAGE = '总体规划待确认中，排期已随包冻结；如需修改请撤回提交';
// 新建需求部门参与方时本项目有待确认的立项包 / 总体规划包（C4a P35）：必需确认人集合已随提交生成，新方不在其中。
const PENDING_PACKAGE_PARTY_MESSAGE = '有待确认的内容包，请先撤回提交';
// 提交确认的项目级前置文案（C4a 修订批二 MED-1：提交标志与执行同源，两端都经 OBJECT_OPS.package_version_submit 给出，不在端点里另写一份）。
const NO_DEMAND_PARTY_MESSAGE = '项目还没有需求部门参与方，无法确定必需确认人';
// P174：交接确认被不认可 / 有异议后重新发起的拒绝文案（没带答复）与「没有需要答复的不认可却带了答复」的文案
//   LOW-1（修订批 4）：文案里的出路不列「裁定」——adjudicate 办理动作未开放（裁定走确认任务，不写这条办理动作），解除不认可的新结论类动作实际可用的只有 给结论 / 仅供参考 / 作废。
const DECLINED_REPLY_MESSAGE = '该登记已有代表人作出不认可 / 有异议，须先写答复（reply）再重新发起交接确认，或先给出新的结论（给结论 / 仅供参考 / 作废）；更正、记单号、标或取消风险都不解除';
const NO_REPLY_NEEDED_MESSAGE = '该登记没有需要答复的不认可 / 有异议，不需要答复';
// P175（修订批 4）：答复只在该项仍需交接确认时有效；有未解除的不认可却已不需要确认（兜底，正常路径下取消风险已被 entry_unmark_risk 挡住）时，唯一出路是新的结论类动作
const DECLINED_NO_NEED_MESSAGE = '该登记已有代表人作出不认可 / 有异议，答复只在仍需交接确认时有效；须先给出新的结论（给结论 / 仅供参考 / 作废）才能解除';
// P175：不认可只能经代表人重新决定或新的结论类动作解除，PM 不能靠取消风险标记单方面使该项不再需要确认
//   P177（修订批 5）：PM 的答复只解锁重新发起、不解除不认可，所以文案改为「须由代表人对重新发起的确认作出确认，或给出新的结论」
const UNMARK_RISK_DECLINED_MESSAGE = '该登记的交接确认已被代表人不认可，须先写答复重新发起、由代表人对重新发起的确认作出确认，或给出新的结论；在此之前不能取消风险标记';
// P176（修订批 4）：交接确认（接受带此问题上线 / 不再处理）的代录只放无平台账号的代表人；有账号的代表人须本人在平台上作出
const HANDOVER_ACCOUNT_PROXY_MESSAGE = '有平台账号的代表人须本人在平台确认交接事项';
const PARENT_SUPERSEDED_MESSAGE = '草稿所基于的总体规划版本已被替代，请基于现行规划重建草稿';
const CHANGE_FACT_UNKNOWN_MESSAGE = '无法确定变更的前置事实，请刷新后重试';
const CONFIRMERS_UNKNOWN_MESSAGE = '无法确定必需确认人，请刷新后重试';
// C6a：批次验收包 / 结项包提交的前置文案与事实缺失文案（提交标志与执行同源，经 OBJECT_OPS.package_version_submit）。
const BATCH_FACT_UNKNOWN_MESSAGE = '无法确定批次状态，请刷新后重试';
const CLOSING_FACT_UNKNOWN_MESSAGE = '无法确定批次上线情况，请刷新后重试';
const PENDING_FACT_UNKNOWN_MESSAGE = '无法确定项目里是否已有待确认的内容包，请刷新后重试';
// parent_overall_version_id 在提交时按现行总体规划版本重写的包类型（packages.js computeFormAndParent / rewriteFormAndParent）：草稿期间总体规划换版不挡提交
const PARENT_REWRITTEN_AT_SUBMIT_TYPES = Object.freeze(['batch_accept', 'closing']);
// C6a 上线与交接
const GOLIVE_FACT_UNKNOWN_MESSAGE = '无法确定上线前置事实，请刷新后重试';
const HANDOVER_NEED_KINDS = Object.freeze(['accept_issue', 'no_further']); // 交接确认的两种用途（accept_issue → handover_accept_issue，no_further → handover_no_further）
const HANDOVER_STATE_LABELS = Object.freeze({ pending: '待确认', confirmed: '已确认', declined: '有代表人未通过', incomplete: '部分参与方尚无任务' });
function goliveBatchStateMessage(batchStatus) {
  if (batchStatus === 'live') return '批次已正式上线';
  if (batchStatus === 'planning') return '批次还没有进入进行中，不能确认试运行结束';
  if (BATCH_FROZEN_STATUSES.includes(batchStatus)) return '批次已转出或被替代，不能上线';
  return BATCH_FACT_UNKNOWN_MESSAGE;
}
function goliveBlockedMessage(blockers) {
  return `上线前置条件未满足：${blockers.map((b) => b.message).join('；')}`;
}
function closingNotReadyMessage(cn) {
  const parts = [];
  if (Array.isArray(cn.notLive) && cn.notLive.length > 0) parts.push(`以下批次还没有正式上线：${cn.notLive.join('、')}`);
  if (Array.isArray(cn.transferNoChange) && cn.transferNoChange.length > 0) parts.push(`以下已转出的批次没有已生效的变更包：${cn.transferNoChange.join('、')}`);
  return `不能提交结项：${parts.join('；') || CLOSING_FACT_UNKNOWN_MESSAGE}`;
}
const INITIATION_NOT_EFFECTIVE_MESSAGE = '项目立项包还没有生效版本，总体规划不能提交确认（立项通过后总体范围与批次规划才生效）';
// 总体规划包提交前须计划齐全（codex 19 号 H-1 / P43）：基线只能来自被确认的计划。文案后接缺计划的节点标签（顿号分隔）。
const PLAN_MISSING_MESSAGE_HEAD = '以下节点还没有计划起止日期，总体规划提交前须先补齐（总体排期基线是确认对象）：';
const PLANS_UNKNOWN_MESSAGE = '无法确定节点计划是否齐全，请刷新后重试';
// ── C3b：需求条目 / 内容包的判定（方案 v1.2 §4.1、§5.2「登记需求条目」）──────────────────────────────────────────────────
// 登记需求条目：PM、全部成员（负责人 / 代表人 / 一般成员）；admin 未接管不是成员 → 403；只读账号一票否决。isMember 已含 PM。
function canRegisterItem(identity) {
  return !!(!identity.isReadonly && identity.isMember);
}
// S1（主会话自决，锚点 N9 待追认）：条目出新版本的人 = PM（admin 接管后），或该条目的登记人（created_by）本人且仍是非只读的已加入成员；
//   其他成员不能给别人的条目出新版本（只收窄，不放宽）。target.isCreator 由端点用 Number(item.created_by) === Number(user.id) 算出。
function canCreateItemVersion(identity, project, t) {
  if (identity.isReadonly) return false;
  return !!(identity.isPm || (identity.isMember && t.isCreator === true));
}
// 模块名项目内唯一（S5，trim 后比较、大小写敏感）：端点先查同项目是否已有同名模块（改名时排除自己），把结果放进 target.nameTaken。
const moduleNameState = (t) => (t.nameTaken ? '本项目已有同名模块' : null);
// 内容包版本的草稿判定：草稿期才能编辑 snapshot、修订条目集合（条件更新的 SQL 里另有 status = 'draft' 兜底）。
const draftVersionState = (t) => (t.versionStatus === 'draft' ? null : '只有草稿版本可以修改');
// ── C5 S-S1a：登记与办理（方案 v1.4 §4.1 登记规则表与结论确认、§4.2 办理结论 / 异议裁定两行、§5.2 动作矩阵、§6.3 派生值）──────────────────────────────────────────
// 登记当前结论状态（服务端按办理记录 + 确认任务修订派生，entries-core.js deriveEntryState；不存储）：
//   none 无结论｜pending_confirm 待确认｜confirmed 已确认｜objected 有异议｜escalated 裁定中｜adjudicated 裁定通过（最终）｜adjudication_rejected 裁定未通过｜
//   settled_no_confirm 已确定（不需确认）｜for_reference 仅供参考｜for_reference_objected 仅供参考被异议｜voided 已作废｜
//   terminated_conclusion_lapsed 项目已终止结论失效（M-b：「项目已终止」结论只在项目当前状态为已终止时算有效结论；项目重开 / 非终止后派生为本状态，不属有效结论，PM 须重新给结论）。
const ENTRY_CONCLUSION_STATES = Object.freeze([
  'none', 'pending_confirm', 'confirmed', 'objected', 'escalated', 'adjudicated', 'adjudication_rejected', 'settled_no_confirm', 'for_reference', 'for_reference_objected', 'voided',
  'terminated_conclusion_lapsed',
  // 预筛 Q4：「转正式变更」结论所挂的变更被撤回后失效（与 terminated_conclusion_lapsed 同模式：不属有效结论、可再给结论 / 标仅供参考、收口前置算未结；变更生效则结论保持有效）
  'to_change_lapsed',
  // S-S1b：已拆分容器（有子登记的原登记）。容器本身不能办理（409），状态由子项派生：子项全部「已结」时视为有结论（entries-core.entryResolved）；本状态不在有效结论集合里
  'split_container',
]);
// 「有效结论」（方案 §4.1 / 本批派单 §4）：已确定（不需确认）、已确认、裁定通过、仅供参考。已有有效结论时不能再给结论 / 标仅供参考 / 作废；S-S1b 节点收口前置复用这一个集合。
const EFFECTIVE_CONCLUSION_STATES = Object.freeze(['settled_no_confirm', 'confirmed', 'adjudicated', 'for_reference']);
// 可再次给结论 / 标仅供参考的当前状态。派单 §4 列的是 {无结论, 有异议, 裁定未通过, 仅供参考被异议}；派单 §6「新的 conclude / for_reference 让上一条结论的待确认修订 → superseded」
//   隐含「待确认」期间可改结论（方案 §4.2 办理结论行「PM 改结论后失效、重新发起」），所以两处都加入 pending_confirm（派单内部不一致，按 §6 补，报告列出）。
//   M-b：terminated_conclusion_lapsed（项目已终止结论在项目重开后失效）两处都放行（标仅供参考仍受「曾被异议」「承诺标记」两道限制）。
const CONCLUDE_FROM_STATES = Object.freeze(['none', 'pending_confirm', 'objected', 'adjudication_rejected', 'for_reference_objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);
const FOR_REFERENCE_FROM_STATES = Object.freeze(['none', 'pending_confirm', 'objected', 'terminated_conclusion_lapsed', 'to_change_lapsed']);
// 有未结异议的状态（P94，预筛修订批）：有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议。异议未解决时，作废不能由 PM 一方单独决定（否则 PM 可用作废绕开提出方的异议与负责人裁定），只有登记人本人可作废。
const ENTRY_OPEN_OBJECTION_STATES = Object.freeze(['objected', 'escalated', 'adjudication_rejected', 'for_reference_objected']);
const ENTRY_HANDLED_TYPES = Object.freeze(['feedback', 'issue']); // 「办理类」：意见与反馈、问题与处理（方案 §4.1）
const ENTRY_DEV_PURPOSES = Object.freeze(['dev_note', 'deliverable']); // C5 S-S1c：开发方处理说明 / 正式交付物提交——需要开发方负责人认可，不进分流、不可拆分
// 修订批 3 H2（codex 26）：需要开发方负责人认可的登记 = 作出推进类确认（accept：已终止 / 已结项否）。登记（含一般用途 + 开发方来源 + 涉及承诺）与 PM 补标涉及承诺都会建认可任务 /
//   本人提交并确认，所以建任务的唯一落点（entries-core.requestDevConfirm）与读接口 actions.mark_commitment（entry_mark_commitment.state）共用这一个判定。
//   返回 null（可建）或 { code, message }（checkOp / requestDevConfirm 原样用作 409）；项目状态不是 accept 类允许的（含未知状态）一律拒绝。
const DEV_CONFIRM_PROJECT_MESSAGE = '项目已终止 / 已结项，开发方关键事项不能再提交认可';
const ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE = '开发方负责人未认可的登记不能拆分，请修订重提'; // 修订批 3 N1：手动拆分（rules）与补选归属的混合去向自动拆分（entries.js / entries-routing.planAssignment）共用
function devConfirmProjectBlock(projectStatus) {
  return projectAllowsWrite(projectStatus, 'accept') ? null : { code: 'SYSBUILD_PROJECT_READONLY', message: DEV_CONFIRM_PROJECT_MESSAGE };
}
const ENTRY_VOIDED_MESSAGE = '登记已作废，不能再办理';
const ENTRY_CONFIRMER_UNAVAILABLE_MESSAGE = '来源方暂无代表人，请先完成授权';
const ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE = '规划外且留在项目内的问题只能转正式变更';
const ENTRY_SYS_ITERATION_ROUTE_MESSAGE = '已上线部分须转系统迭代，结论只能是「转系统迭代」';
const ENTRY_SYS_ITERATION_REFERENCE_MESSAGE = '已上线部分须转系统迭代，不能标仅供参考';
// 手动拆分只允许从这些结论状态出发（预筛 H-1）：只有尚未给结论的登记
const ENTRY_SPLIT_FROM_STATES = Object.freeze(['none']);
// 提异议资格的依据（entries-core.objectorBasisOf）：登记人本人 / 原结论的确认人 / 来源方现任负责人或生效代表人 / 来源方为空时需求方与开发方的任一成员
const ENTRY_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party', 'party_member']);
// 结论 / 裁定任务的 target.objectType；conclusion_confirm 任务 = conclusion，adjudicate 任务 = adjudication
const ENTRY_TASK_OBJECT_TYPES = Object.freeze(['conclusion', 'adjudication']);
const ENTRY_SPLIT_CONTAINER_MESSAGE = '该登记已拆分，请在拆出的处理项上办理';
const entryNotVoided = (t) => {
  if (t.voided === true) return ENTRY_VOIDED_MESSAGE;
  if (t.voided !== false) return PROXY_FACT_UNKNOWN_MESSAGE; // fail-closed：事实没取到一律拒绝
  return t.isSplitContainer === true ? ENTRY_SPLIT_CONTAINER_MESSAGE : null; // S-S1b：已拆分容器上的办理动作一律 409（容器没有该事实时按普通登记）
};
const entryStateKnown = (t) => (ENTRY_CONCLUSION_STATES.includes(t.conclusionState) ? null : PROXY_FACT_UNKNOWN_MESSAGE);
// 确认人解析结果（entries-core.resolveConclusionConfirmer 的 kind）：none / owner / delegate 可办理；unavailable = 需要代表人而来源方暂无 → 409；其余（事实没取到）拒绝。
const entryConfirmerState = (t) => {
  if (t.confirmer === 'none' || t.confirmer === 'owner' || t.confirmer === 'delegate') return null;
  return t.confirmer === 'unavailable' ? ENTRY_CONFIRMER_UNAVAILABLE_MESSAGE : PROXY_FACT_UNKNOWN_MESSAGE;
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
// 对知会提异议：知会接收人本人，或来源方现任负责人（方案 §5.2「对知会提异议：负责人本方」）。不带只读否决——与确认类动作同口径（§5.1：只读账号可作出本人的确认 / 异议）。
// codex 25 M1：仅供参考知会的异议资格 = 接收人本人，或与「对已有结论的登记提异议」同源的资格（entries-core.objectorBasisOf：原登记人 / 当前结论确认人 / 来源方现任负责人或代表人）。
//   有知会的仅供参考登记不经 objects_entry_id，所以普通原登记人和换授权后的现任代表人只能走这里。
const NOTICE_OBJECTOR_BASES = Object.freeze(['registrant', 'confirmer', 'source_party']);
const canObjectNotice = (identity, project, t) => t.isRecipient === true || NOTICE_OBJECTOR_BASES.includes(t.objectorBasis);
const OBJECT_OPS = Object.freeze({
  party_add: Object.freeze({
    can: canManageMembership,
    state: (t) => {
      if (t.side === 'dev' && t.hasDevParty) return '本项目已有开发方参与方，每个项目至多一个';
      return t.side === 'demand' && t.hasPendingContentPackage ? PENDING_PACKAGE_PARTY_MESSAGE : null; // C4a P35
    },
  }),
  party_rename: Object.freeze({ can: canManageMembership, state: noStateLimit }),
  member_add: Object.freeze({ can: canManageMembership, noSelf: true, state: noStateLimit }),
  member_remove: Object.freeze({
    can: canManageMembership,
    noSelf: true,
    state: (t) => {
      if (t.removed) return '该成员已移出';
      return t.isPmRow ? 'PM 本人的成员行不能移出，要更换 PM 请走更换 PM' : null;
    },
  }),
  appointment_propose: Object.freeze({ can: canManageMembership, noSelf: true, state: (t) => (t.hasPendingAppointment ? '该参与方已有待接受的任职提议，请先撤回' : null) }),
  appointment_withdraw: Object.freeze({ can: canManageMembership, noSelf: true, state: (t) => (t.status === 'pending' ? null : '只有待接受的任职提议可以撤回') }),
  appointment_end: Object.freeze({ can: canManageMembership, noSelf: true, state: (t) => (t.status === 'active' ? null : '只有现任的任职可以结束') }),
  delegation_propose: Object.freeze({
    can: (identity, project, t) => delegationInitialStatus(identity, t.party_id) !== null,
    state: (t) => {
      if (!t.currentAppointmentId) return '该参与方没有现任负责人，不能授权代表人';
      return t.hasPendingDelegation ? '本方已有待处理的授权提议，请先撤回或等待处理' : null;
    },
  }),
  // C4b Q-S2：任职 / 授权的本人入口（邀请接受、授权批准、授权接受）也受历史补录窗口互斥约束（P58，预筛 L9），与代录入口同一个事实。
  delegation_approve: Object.freeze({ can: (identity, project, t) => ownsParty(identity, t.party_id), state: (t) => pendingOwnerState(t) || historyConflictState(t) }),
  delegation_reject: Object.freeze({ can: (identity, project, t) => ownsParty(identity, t.party_id), state: pendingOwnerState }),
  delegation_revoke: Object.freeze({ can: (identity, project, t) => ownsParty(identity, t.party_id), state: (t) => (t.status === 'active' ? null : '只有生效中的授权可以撤销') }),
  delegation_withdraw: Object.freeze({
    can: canWithdrawDelegation,
    state: (t) => (t.status === 'pending_owner' || t.status === 'pending_accept' ? null : '只有待处理的授权提议可以撤回'),
  }),
  delegation_accept: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: (t) => pendingAcceptState(t) || historyConflictState(t), requal: requalOf }),
  delegation_decline: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: pendingAcceptState }),
  invitation_accept: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: (t) => pendingInvitationState(t) || historyConflictState(t), requal: requalOf }),
  // 拒绝不重核资格（M1 ①，与授权拒绝一致）：邀请人失权后受邀人仍能明确回绝，不被重核卡死。
  invitation_decline: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: pendingInvitationState }),
  // ── C3a：批次 / 节点 / 排期（方案 v1.2 §3.2、§4.4、§4.5；派单 §3.5）─────────────────────────────────────────────────
  // 谁：以 PM 身份行事（非只读且本人就是本项目 PM；admin 接管后才是 PM，§5.2「改期」「节点开始 / 收口 / 重开」行）。
  // 对象状态（state）只看 target 里的事实，不读库；target 由 plan.js 的 batchTarget / nodeTarget 构造，读接口的 actions 与写端点走同一份：
  //   节点类 target = { nodeStatus, templateKey, isMilestone, isProjectLayer, batchStatus（项目层节点为 null）, hasBaseline, hasActual: { actual_start, actual_end }, corrects? }；
  //   批次类 target = { batchStatus }。
  // 违反时按各动作内的书写顺序给出第一条（派单 §3.5 表）；批次已转出 / 被替代时本批节点的全部写动作由 withFrozenBatch 统一拒绝（预筛 D4），排在各动作自己的对象状态规则之后。
  batch_update: Object.freeze({ can: canActAsPm, state: (t) => (batchFrozen(t) ? '批次已转出或被替代，不能再修改' : null) }),
  node_start: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => (t.nodeStatus !== 'not_started' ? '只有未开始的节点可以开始' : null)),
  }),
  node_close: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => {
      if (t.nodeStatus !== 'in_progress') return '只有进行中的节点可以收口';
      // C6a：整体验收结项（p_closing）可以收口了（原预筛 D3 的拒绝去掉）：它的前置（结项包已生效、每个有效批次已正式上线、结项包晚于每个批次最后一条上线事件、项目整体未结过程登记）
      //   在 plan.js closeBlockers，收口同一事务里项目转入已结项（plan.js 收口端点）。历史导入不收 p_closing（history.js loadNodeFact）。
      return t.isMilestone ? '正式上线里程碑以上线事件收口，不能走节点收口' : null;
    }),
  }),
  node_reopen: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => {
      if (t.nodeStatus !== 'closed') return '只有已收口的节点可以重开';
      if (t.isMilestone) return '正式上线里程碑不能重开，请走撤销上线';
      return t.batchStatus === 'live' ? '批次已正式上线，本批节点不能重开，须先由 admin 撤销上线' : null;
    }),
  }),
  node_cancel: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.isProjectLayer) return '项目层节点按模板固定，不能取消';
      if (t.nodeStatus !== 'not_started') return '只有未开始的节点可以取消';
      if (t.isMilestone) return '正式上线里程碑不能取消';
      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE; // C4a P34：总体规划待确认期间排期已随包冻结，取消节点也会改变将形成的基线
      return batchNoEdit(t) ? '批次已正式上线、已转出或被替代，不能取消节点' : null;
    },
  }),
  node_rename: Object.freeze({ can: canActAsPm, state: withFrozenBatch((t) => (t.nodeStatus === 'cancelled' ? '已取消的节点不能改名' : null)) }),
  node_add: Object.freeze({ can: canActAsPm, state: (t) => (batchNoEdit(t) ? '批次已正式上线、已转出或被替代，不能新增节点' : null) }),
  node_reorder: Object.freeze({ can: canActAsPm, state: (t) => (batchNoEdit(t) ? '批次已正式上线、已转出或被替代，不能调整节点顺序' : null) }),
  schedule_plan: Object.freeze({
    can: canActAsPm,
    // 预筛 D1：已取消一律拒绝；已收口的节点「还没有 baseline」时仍可补草稿期计划（否则缺计划的已收口节点会永久挡住 b_req / p_overall 收口，
    //   只能靠重开 + 级联脱困），已有 baseline 后已收口节点不能再改计划（基线形成时计划已齐全）。
    //   C4a P34：本项目的总体规划版本待确认期间（t.overallPending），任何节点都不能设计划 / 改期——总体排期基线是确认对象（方案 §3.1），
    //   排期随提交冻结；新增节点仍允许（没有计划不进基线）。要改先撤回提交。
    state: withFrozenBatch((t) => {
      if (t.nodeStatus === 'cancelled') return '已取消的节点不能修改计划';
      if (t.overallPending) return OVERALL_PENDING_PLAN_MESSAGE;
      return t.nodeStatus === 'closed' && t.hasBaseline ? '已有基线的已收口节点不能修改计划' : null;
    }),
  }),
  // 更正实际开始 / 实际结束（预筛 M3）：被更正的那类实际记录必须已存在；更正实际结束还要求节点当前已收口（未收口时实际结束不生效，
  //   更正只会留下一条看不见的记录）。读接口按种类拆成 correct_actual_start / correct_actual_end 两个标志，各带对应的 corrects。
  //   target.corrects 缺省 = 任一类可更正即可（仅防御，读接口不再用）。
  schedule_correct: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => {
      if (t.nodeStatus === 'cancelled') return '已取消的节点不能更正实际日期';
      if (t.corrects === 'actual_end' && t.nodeStatus !== 'closed') return '只有已收口的节点可以更正实际结束';
      const has = t.hasActual || {};
      const kinds = t.corrects ? [t.corrects] : ['actual_start', 'actual_end'];
      return kinds.some((k) => has[k] === true) ? null : '该节点还没有可更正的实际日期记录';
    }),
  }),
  // ── C3b：模块 / 需求条目 / 内容包与版本 / 条目集合修订（方案 v1.2 §4.1、§2.3、§4.5；派单 C3b §3.2）────────────────────────────
  // target 约定（端点的 target 构造函数与读接口 actions 共用同一份）：
  //   模块类 { nameTaken }；条目类 { isCreator }；
  //   包创建 { type, exists（该项目 / 该批次已有同类型包）, batchStatus（batch_accept 的批次状态）}；
  //   包版本新建 { packageType, hasDraft, hasPending, hasEffective, batchStatus（批次包所在批次的状态；项目级包缺省）}；
  //   包版本编辑 { versionStatus, batchStatus（同上）}；
  //   条目集合修订 { versionStatus, packageType, batchStatus（批次包所在批次的状态）, inSet（本次要加 / 删的条目是否在集合里；读接口 actions 不带，缺省不判）,
  //     commitBatchStatus（add 的承诺批次状态，缺省不判）}。
  module_create: Object.freeze({ can: canActAsPm, state: moduleNameState }),
  module_rename: Object.freeze({ can: canActAsPm, state: moduleNameState }),
  item_create: Object.freeze({ can: canRegisterItem, state: noStateLimit }),
  item_version_create: Object.freeze({ can: canCreateItemVersion, state: noStateLimit }),
  item_set_module: Object.freeze({ can: canActAsPm, state: noStateLimit }),
  // C8候选材料只追加，不自动成为执行依据。收口后先重开节点；已取消或批次冻结拒绝。
  material_version_create: Object.freeze({ can: canActAsPm, state: withFrozenBatch((t) => ['not_started', 'in_progress'].includes(t.nodeStatus) ? null : '节点已收口或取消，不能直接追加候选材料版本，请先按权限重开节点') }),
  package_create: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      // S2（主会话自决）：第一期不建批次需求包——单批项目的批次需求并入总体规划包的合并形态（§2.3）；变更包只经正式变更产生（C5），本接口拒绝。
      if (t.type === 'batch_req') return '单批项目的批次需求在总体规划包里维护';
      if (t.type === 'change') return '变更包只经正式变更产生，不能在这里创建';
      if (t.exists) return '该项目（或该批次）已有同类型的内容包，每个只能有一个';
      return batchFrozen(t) ? '批次已转出或被替代，不能再建内容包' : null;
    },
  }),
  package_version_create: Object.freeze({
    can: canActAsPm,
    // D2（预筛裁定）：批次包所在批次已转出 / 被替代时一律拒绝（withFrozenBatch，与 C3a 节点动作同族）。
    state: withFrozenBatch((t) => {
      // D1（预筛裁定）：总体规划包已有生效版本时不能直接建草稿——冻结内容只能经正式变更修改（核心原则 4 / 不变量 2；变更包生效时才产生新的完整总体规划版本，C5）。
      //   立项包、结项包、验收包不受此限。
      if (t.packageType === 'overall' && t.hasEffective) return '总体规划已生效，修改须经正式变更（C5）';
      // C5 S-S1c：变更包版本只经正式变更产生（建变更时的第一版草稿，出新版本走 POST /changes/:cid/new-version），不开放通用建版本端点
      if (t.packageType === 'change') return '变更包版本只经正式变更产生，不能在这里创建';
      // S4（主会话自决）：每个包同一时刻至多一个草稿版本；库内另有「同包至多一个待确认版本」的唯一索引，这里先拒绝，不留给约束报 500。
      if (t.hasDraft) return '该内容包已有草稿版本，请先在草稿上修改';
      return t.hasPending ? '该内容包已有待确认的版本，请等待处理后再建新版本' : null;
    }),
  }),
  package_version_edit: Object.freeze({ can: canActAsPm, state: withFrozenBatch(draftVersionState) }),
  package_item_add: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.versionStatus !== 'draft') return '只有草稿版本可以修订条目集合';
      // D2：批次包所在批次已冻结时先报这一条（批次包按 S3 本来就不能修订集合，这里让提示指向真正的原因）。
      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';
      // S3（主会话自决）：C3 只在总体规划包的版本上做条目集合修订；其他类型的包版本只编辑 snapshot_json。C5 S-S1c：变更包版本是「提议的下一版完整总体规划」，同样可以修订集合。
      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';
      if (t.inSet === true) return '该条目已在集合中，如需换版本请先移出';
      return batchFrozen({ batchStatus: t.commitBatchStatus }) ? '承诺批次已转出或被替代，不能再挂条目' : null;
    },
  }),
  package_item_remove: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.versionStatus !== 'draft') return '只有草稿版本可以修订条目集合';
      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';
      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';
      return t.inSet === false ? '该条目版本不在集合中' : null;
    },
  }),
  // ── C4a：内容包提交确认 / 撤回、确认任务改发 / 决策（方案 v1.2 §4.2、§4.5、§5.2「发起确认」「作出确认」；派单 C4a P22–P28）──────────────────
  // state 可以返回字符串（409 SYSBUILD_STATE）或 { code, message }（409 带指定错误码，如 SYSBUILD_TASK_SUPERSEDED）。
  // target 约定：
  //   提交 { versionStatus, packageType, batchStatus, confirmersMissing, initiationEffective（仅总体规划包判）, planMissing（仅总体规划包判）}；撤回 { versionStatus, batchStatus }；
  //   改发 { objectType, objectStatus（所在对象版本状态：包版本 status）, revisionStatus（当前修订）, batchStatus }；
  //   决策 { isRequired（本人是当前修订的必需确认人）, currentRevisionId, revisionStatus, objectVersionId, objectPending, qualificationLoss（失去资格的原因，无则空）,
  //     revisionIdGiven / objectVersionIdGiven（请求带的值；读接口 actions 不带，缺省不判）}。
  // 提交标志（读接口 actions.submit）与提交执行同源（修订批二 MED-1）：标志承诺「权限、对象状态（草稿 + 类型开放 + 批次未冻结）、立项前置（总体规划包）、
  //   必需确认人齐全」，修订批三 H-1 起再加「计划齐全（总体规划包）」；这些项目级事实 packages.js versionFactsOf 在读写两端用同一个函数取
  //   （confirmersMissing / initiationEffective / planMissing，缺失按 fail-closed 拒绝）。
  //   **不承诺**条目集合的提交时重核（P24：集合非空、承诺批次、方向类证据等，confirm.js recheckOverallSet 只在执行时做）——标志为真时执行仍可能因集合重核失败 409。
  package_version_submit: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => {
      if (t.versionStatus !== 'draft') return '只有草稿版本可以提交确认';
      // C5 S-S1c（C4 / C5 交接）：草稿建立时继承的现行总体规划版本已被替代 → 请基于现行规划重建草稿。批次需求包（第一期没有，类型本身不开放提交）与变更包共用这一条，
      //   排在「类型是否开放」之前，批次需求包的纯规则用例据此直接断言；事实由 packages.js versionFactsOf 取（只在 === true 时拒绝，缺失不拒）。
      //   C6a：批次验收包 / 结项包「只引用验收 / 结项时的现行版本」（§2.2 不变量 2），提交时 parent 按现行版本重写（packages.rewriteFormAndParent），草稿期间总体规划换版不算「过期草稿」，
      //   不拒绝（否则这两类包没有别的办法重建草稿——建新草稿要求本包没有草稿）。生效之后换版的过期由上线前置 ACCEPT_STALE / p_closing 前置 CLOSING_STALE 另挡（P168，见 packages.js computeFormAndParent 注释的三处共同保证）；变更包 / 总体规划包 / 批次需求包的 parent 不重写，仍按本条拒绝。
      if (t.parentSuperseded === true && !PARENT_REWRITTEN_AT_SUBMIT_TYPES.includes(t.packageType)) return PARENT_SUPERSEDED_MESSAGE;
      if (!SUBMITTABLE_PACKAGE_TYPES.includes(t.packageType)) return '该类型的内容包 C5 / C6 起可用提交确认';
      // C4b Q-S2（P58）：历史补录窗口开启期间，该内容包已有历史导入 / 历史补录记录 → 不能发起当前确认任务（fail-closed：事实没取到拒绝）。
      const hc = historyConflictState(t);
      if (hc) return hc;
      // C5 S-S1c 变更包：变更须仍是草稿（撤回 / 已提交 / 已生效的变更不能再提交），且本项目同一时刻至多一个待确认的变更（并行的变更会互相覆盖生效后的完整总体规划）。fail-closed：事实没取到拒绝。
      if (t.packageType === 'change') {
        if (t.changeStatus !== 'draft') return '该变更已不是草稿状态，不能提交确认';
        if (t.otherChangePending !== false) return t.otherChangePending === true ? '本项目已有待确认的变更，请等待其处理完成或撤回后再提交' : CHANGE_FACT_UNKNOWN_MESSAGE;
        // 预筛 M2：方向类证据提交时重核（附件被软删除 / 未声明无书面证据）；与 recheckOverallSet 的条目证据同口径，fail-closed
        if (t.changeEvidenceOk !== true) return t.changeEvidenceOk === false ? '该变更的方向类证据已不齐（附件被删除或未声明无书面证据），请补充后再提交' : CHANGE_FACT_UNKNOWN_MESSAGE;
      }
      // C6a 批次验收包：只有「进行中」的批次可以提交验收（规划中 / 已上线 / 已转出 / 被替代一律 409；已转出 / 被替代已被外层 withFrozenBatch 先拦）。事实没取到拒绝。
      if (t.packageType === 'batch_accept' && t.batchStatus !== 'active') {
        if (t.batchStatus === 'planning') return '批次还没有进入进行中，不能提交批次验收';
        return t.batchStatus === 'live' ? '批次已正式上线，不能再提交批次验收' : BATCH_FACT_UNKNOWN_MESSAGE;
      }
      // C6a 结项包：项目内每个有效批次（不含已转出 / 被替代）都已正式上线（entries-core.batchLiveState），已转出的批次须有已生效的变更包；不满足 409 并列出批次。
      //   closingNotReady = null（满足）或 { notLive: [批次名], transferNoChange: [批次名] }；事实没取到拒绝（packages.js versionFactsOf 在读写两端同源取）。
      if (t.packageType === 'closing') {
        const cn = t.closingNotReady;
        if (cn === undefined) return CLOSING_FACT_UNKNOWN_MESSAGE;
        if (cn !== null) return closingNotReadyMessage(cn);
      }
      // C6a 待确认互斥（P139）：总体规划 / 变更 / 批次验收 / 结项四类包同一项目同一时刻最多一个待确认版本；otherPendingPackage = 其他已待确认包的类型（null = 没有；undefined = 事实没取到，拒绝）。
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
        if (t.planMissing !== null) return `${PLAN_MISSING_MESSAGE_HEAD}${t.planMissing.join('、')}`;
      }
      return null;
    }),
  }),
  package_version_withdraw: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => (t.versionStatus === 'pending' ? null : '只有待确认的版本可以撤回提交，已生效的版本不能撤回')),
  }),
  // ── C5 S-S1c 正式变更（方案 v1.4 §4.1 表「正式变更」、§4.2「范围变更包」、§4.5「正式变更」与维护类同行、§7）──────────────────────────────────────────
  // 建变更：PM（admin 接管后）；前提是总体规划已有生效版本（没有时修改总体规划草稿即可，不需要变更）。target = { overallEffective }；事实没取到拒绝。方向类证据与引用登记在端点里按 400 判。
  change_create: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.overallEffective === true) return null;
      return t.overallEffective === false ? '总体规划尚未生效，直接修改总体规划草稿' : CHANGE_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 出新版本（「有异议：PM 答复或出新版本」）：PM。两种情形——变更待确认且已有人提异议 / 不认可（同一事务让待确认版本退位后建新草稿），或变更草稿所基于的总体规划版本已被替代（重建草稿，否则永远提交不了）。
  //   target = { changeStatus, hasObjection（待确认版本的当前修订里有 有异议 / 不认可）, staleDraft（草稿的继承来源已被替代）}。
  change_new_version: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.changeStatus === 'effective') return '该变更已生效，不能再出新版本';
      if (t.changeStatus === 'withdrawn') return '该变更已撤回，不能再出新版本，请新建变更';
      if (t.changeStatus === 'pending') {
        if (t.hasObjection === true) return null;
        return t.hasObjection === false ? '没有收到异议，请等待确认或撤回变更' : CHANGE_FACT_UNKNOWN_MESSAGE;
      }
      if (t.changeStatus === 'draft') {
        if (t.staleDraft === true) return null;
        return t.staleDraft === false ? '草稿仍基于现行总体规划，请直接在草稿上修改' : CHANGE_FACT_UNKNOWN_MESSAGE;
      }
      return CHANGE_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 改发的修订状态：待确认 / 有异议 / 不认可，以及「已失效」——项目终止时全部待确认修订被置为已失效（P38），重开后由 PM 改发；
  //   撤回提交产生的已失效修订不会走到这里（版本已不是待确认，上一条先拦下）。
  //   reissueBlocked = 改发解析的结果（confirm.js resolveReissue：当前没有可作为确认人的负责人 / 代表人，或新人在本版本已以另一身份确认，P36）。
  //   读接口 actions.reissue 与执行共用这条判定，标志为真则执行必 2xx（L3①）。
  //   C4b P48：改发放开到提出人任务（item_version）——重解析 = 条目当前版本的提出人成员仍是确认人（平台或代录），解析结果同样经 reissueBlocked 传入；
  //   邀请 / 授权类任务（代录时同事务建立并立即确认，C4b P45）没有改发。
  confirm_reissue: Object.freeze({
    can: canActAsPm,
    state: withFrozenBatch((t) => {
      if (!['package_version', 'item_version', 'dev_entry', 'handover'].includes(t.objectType)) return '该类型的确认任务不支持改发'; // C6a：交接确认任务（handover）可改发（重新解析该参与方的生效代表人）
      // C4b codex 21 号 M1（收窄 P48）：提出人已不认可（proposer_status = denied）后不能改发——方案 §4.2「补正产生新版本」，出路是条目出新版本；不新增 denied → pending 的写法。
      //   有异议（objected）不改提出人状态（仍 pending），可以改发。
      if (t.objectType === 'item_version' && t.objectStatus === 'denied') return PROPOSER_DENIED_REISSUE_MESSAGE;
      if (t.objectStatus !== 'pending') return '任务所在的版本已不是待确认，不能改发';
      if (!['pending', 'objected', 'rejected', 'invalid'].includes(t.revisionStatus)) return '只有待确认、有异议、不认可或已失效的修订可以改发';
      // C4b Q-S2（P58）：窗口开启期间，该内容包 / 条目已有历史记录 → 不能改发（fail-closed）。
      const hc = historyConflictState(t);
      if (hc) return hc;
      return t.reissueBlocked || null;
    }),
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
  // ── C4b Q-S1 代录（方案 §4.2「代录」、§5.2「代录、历史补录」行：PM 列为是，其余身份（含 admin 非 PM）一律否，P50）──────────────────────────────
  // 谁：以 PM 身份行事（canActAsPm：非只读且本人就是本项目 PM）。有账号的人在平台外确认也走代录，所以不要求必需确认人无账号（任职接受 / 授权两步例外：有账号的人有本人入口，见下）。
  // confirm_proxy target = { proxyable（任务用途是内容包确认 / 提出人确认）, currentRevisionId, revisionStatus, objectVersionId, objectPending, qualificationLoss（同 decide 的资格复核，无则 null）,
  //   requiredIsSelf（必需确认人就是操作人本人，预筛 D3 / P60）, historyConflict（Q-S2 挂点：历史补录窗口与本对象冲突的文案，无则 null）,
  //   revisionIdGiven / objectVersionIdGiven（请求带的值；读接口 actions 不带，缺省不判）}。
  //   项目状态类别同 decide：accept（推进类确认，已终止 / 已结项 409）。
  //   fail-closed（预筛 L6）：proxyable / objectPending 必须为 true，requiredIsSelf 必须为 false，qualificationLoss / historyConflict 必须为 null——事实没取到（undefined）一律拒绝。
  confirm_proxy: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.proxyable !== true) return '该类型的确认任务不能代录';
      // 下面两条的操作数顺序与 confirm_decide 的同类判定相反，语义完全相同，只是为了让变异自检的锚点在本文件里各自唯一（无其他含义）。
      if (t.revisionIdGiven !== undefined && t.currentRevisionId !== t.revisionIdGiven) return { code: 'SYSBUILD_TASK_SUPERSEDED', message: '该确认任务已被改发或替代，请刷新后重试' };
      if (t.objectVersionIdGiven !== undefined && t.objectVersionId !== t.objectVersionIdGiven) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本与任务不符，请刷新后重试' };
      if (t.revisionStatus !== 'pending') return '该任务修订已处理，不能再代录';
      if (t.objectPending !== true) return { code: 'SYSBUILD_VERSION_CHANGED', message: '确认的对象版本已不在待确认状态，不能代录' };
      // P176（修订批 4，预筛 3 MED）：交接确认（handover_accept_issue / handover_no_further）的代录只放无平台账号的代表人（accountlessOnly = 任务用途是交接确认；requiredHasAccount = 当前修订的必需确认人
      //   有平台账号）——有账号的代表人须本人在平台确认（方案 §4.2 :613 交接渠道只写平台），否则 PM 可在答复后代录「确认」覆盖有账号代表人在平台上的不认可。其他用途不受影响（accountlessOnly 为假 / 缺省不判）。
      //   accountlessOnly 为真时 requiredHasAccount 没取到按拒绝。
      if (t.accountlessOnly === true) {
        if (t.requiredHasAccount === true) return HANDOVER_ACCOUNT_PROXY_MESSAGE;
        if (t.requiredHasAccount !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      }
      // 预筛 D3 / P60：PM 不能代录自己的确认（代录绕过本人浏览与勾选，自己代自己等于绕过平台确认）。
      if (t.requiredIsSelf === true) return PROXY_SELF_MESSAGE;
      if (t.requiredIsSelf !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      if (t.qualificationLoss !== null) return t.qualificationLoss || PROXY_FACT_UNKNOWN_MESSAGE;
      if (t.historyConflict !== null) return t.historyConflict || PROXY_FACT_UNKNOWN_MESSAGE;
      return null;
    },
  }),
  // 无账号成员的任职接受代录：target = { status（任职）, memberActive（成员已加入未移出）, hasAccount, accountDisabled（有账号但账号停用）}；
  //   有账号的成员走邀请，由本人接受；账号停用的成员不能作为确认人（区别于「有账号请本人处理」，预筛 L10）。fail-closed（L6）：hasAccount 必须为 false。
  appointment_proxy_accept: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.status !== 'pending') return '只有待接受的任职提议可以代录接受';
      if (t.memberActive !== true) return '该成员已移出或尚未加入本项目，不能代录接受';
      // C4b Q-S2（P58，预筛 L9）：窗口开启期间，该任职已有历史导入 → 不能代录接受（fail-closed）。
      const hc = historyConflictState(t);
      if (hc) return hc;
      if (t.hasAccount === false) return null;
      return t.accountDisabled === true ? '该成员账号已停用，不能作为确认人' : '该成员有平台账号，请由本人通过邀请接受任职';
    },
  }),
  // 无账号成员的授权代录（两步按当前状态决定）：target = delegationTarget（status / appointmentIsCurrent / requalReason）+ { ownerHasAccount, memberHasAccount, ownerAccountDisabled, memberAccountDisabled }。
  //   待负责人确认（pending_owner）→ 代录负责人批准，要求现任负责人无账号；待被授权人接受（pending_accept）→ 代录本人接受，要求被授权人无账号。有账号的一方走本人入口；账号停用的一方不能作为确认人（L10）。
  //   fail-closed（L6）：该步的 HasAccount 必须为 false，requalReason 必须为 null。
  //   C4b 偏离③（预筛注明）：授权提议所依据的任职 / 被授权人资格失效时，代录只返回 409、不先把提议置为已撤回——与本人接受入口（先撤回再 409）有意不同，PM 可手动撤回。
  delegation_proxy: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.status === 'pending_owner') {
        const s = pendingOwnerState(t);
        if (s) return s;
        const hcOwner = historyConflictState(t); // C4b Q-S2（P58）：该授权已有历史导入 → 不能代录批准
        if (hcOwner) return hcOwner;
        // codex 21 号 M2：批准一步也要核对被授权人资格（被授权人已移出 / 被设为 PM 等），与接受一步一致；requalReason 必须为 null，undefined 拒绝。
        if (t.requalReason !== null) return t.requalReason || PROXY_FACT_UNKNOWN_MESSAGE;
        if (t.ownerHasAccount === false) return null;
        return t.ownerAccountDisabled === true ? '现任负责人账号已停用，不能作为确认人' : '现任负责人有平台账号，请由负责人本人批准';
      }
      if (t.status === 'pending_accept') {
        const hcAccept = historyConflictState(t); // C4b Q-S2（P58）：该授权已有历史导入 → 不能代录接受
        if (hcAccept) return hcAccept;
        if (t.requalReason !== null) return t.requalReason || PROXY_FACT_UNKNOWN_MESSAGE;
        if (t.memberHasAccount === false) return null;
        return t.memberAccountDisabled === true ? '被授权人账号已停用，不能作为确认人' : '被授权人有平台账号，请由本人接受授权';
      }
      return '只有待处理的授权提议可以代录';
    },
  }),
  // ── C4b Q-S2：历史补录中时间窗、历史补录、历史事实导入（方案 §4.2、§4.5、§5.2「历史补录 / 历史事实导入、开启 / 关闭」行；锚点 Q3 / P51–P58）──────────────────
  // 项目状态类别：history_import（进行中 / 已暂停可，已终止 / 已结项否，§4.5 表「历史事实导入」行）。target.historyWindow = 项目窗口状态（读接口 actions 与写端点都取项目行的同一列）。
  // 开启（never → open）、关闭（open → closed）：本项目 PM（canActAsPm：admin 非 PM 不行，只读 PM 否）；重开（closed → open）：admin（非只读，P51，原因由端点要求）。
  //   其余组合 409，文案区分当前状态；窗口状态不是三值之一（事实没取到）拒绝。
  history_window_open: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (!HISTORY_WINDOW_STATES.includes(t.historyWindow)) return HISTORY_WINDOW_UNKNOWN_MESSAGE;
      if (t.historyWindow === 'open') return '历史补录窗口已经开启';
      return t.historyWindow === 'closed' ? '历史补录窗口已关闭，重新开启需要 admin 写原因' : null;
    },
  }),
  history_window_close: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (!HISTORY_WINDOW_STATES.includes(t.historyWindow)) return HISTORY_WINDOW_UNKNOWN_MESSAGE;
      if (t.historyWindow === 'never') return '历史补录窗口还没有开启';
      return t.historyWindow === 'closed' ? '历史补录窗口已经关闭' : null;
    },
  }),
  history_window_reopen: Object.freeze({
    can: canChangeProjectStatus,
    state: (t) => {
      if (!HISTORY_WINDOW_STATES.includes(t.historyWindow)) return HISTORY_WINDOW_UNKNOWN_MESSAGE;
      if (t.historyWindow === 'never') return '历史补录窗口还没有开启过，请由项目经理开启';
      if (t.historyWindow === 'open') return '历史补录窗口已经开启';
      // P67 重开冲突检查：本项目任何「有历史导入或历史补录记录的对象」上存在当前待处理的修订 / 待接受项 → 409，文案由端点现取（列出对象）。
      //   reopenBlock：null = 无冲突，字符串 = 文案；读接口 actions 的项目级标志带 projectLevel: true（只承诺 权限 + 项目状态 + 窗口状态，冲突在执行时现查）；
      //   两者都不是（执行端点漏传）一律拒绝（fail-closed）。
      //   【写死约束，预筛 LOW-4】`projectLevel: true` 只供读接口 actions 与端点第一道项目级判定使用；执行路径（带 reopenBlock 的第二道判定）严禁传入——
      //   传入即绕过冲突检查（等于关掉 P67）。history 套件有变异「第二道判定带 projectLevel」证明这一点会被用例判红。
      if (t.projectLevel === true || t.reopenBlock === null) return null;
      return typeof t.reopenBlock === 'string' && t.reopenBlock !== '' ? t.reopenBlock : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 历史补录（只记录已发生的确认事实，不挂当前任务、不改任何状态）：本项目 PM，窗口 open（Q-D2）。
  history_confirmation_record: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (!HISTORY_WINDOW_STATES.includes(t.historyWindow)) return HISTORY_WINDOW_UNKNOWN_MESSAGE;
      return t.historyWindow === 'open' ? null : HISTORY_WINDOW_NOT_OPEN_MESSAGE;
    },
  }),
  // 历史事实导入：本项目 PM，窗口 open。target.factType 缺省 = 读接口 actions 的项目级标志（只承诺 权限 + 项目状态 + 窗口开启，对象级冲突仍在执行时 409）；
  //   执行端点带 factType（五类之一，C6a 起含 golive；其余值拒绝）与 importBlock（该类事实的对象要求 / 冲突判定结果，history.js 现取：null = 通过，字符串 = 409 文案，其余拒绝）。
  history_fact_import: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (!HISTORY_WINDOW_STATES.includes(t.historyWindow)) return HISTORY_WINDOW_UNKNOWN_MESSAGE;
      if (t.historyWindow !== 'open') return HISTORY_WINDOW_NOT_OPEN_MESSAGE;
      if (t.factType === undefined) return null;
      if (!HISTORY_IMPORT_FACT_TYPES.includes(t.factType)) return '不支持的历史事实类型';
      if (t.importBlock === null) return null;
      return typeof t.importBlock === 'string' && t.importBlock !== '' ? t.importBlock : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // ── C5 S-S1a 登记与办理（方案 v1.4 §4.1、§4.2 办理结论 / 异议裁定、§4.5 状态 × 动作、§5.2；派单 C5_S-S1a §3–§7）──────────────────────────────────────────
  // 写登记：时段由服务端判定，过程登记按 register_process 类、补充登记按 register_supplement 类判项目状态（已终止 / 已结项只能写补充登记）；谁能写两类一样。
  //   target = {}（写登记没有对象状态；业务规则——用途 / 证据 / 来源方——在端点里按 400 / 409 判）。
  entry_create_process: Object.freeze({ can: canRegisterEntry, state: noStateLimit }),
  entry_create_supplement: Object.freeze({ can: canRegisterEntry, state: noStateLimit }),
  // 办理动作 target（entries-core.entryTarget 构造，读接口逐对象 actions 与写端点同一份）：
  //   { isRegistrant, registrantWasPm（登记时身份快照 is_pm；作废规则用）, voided, type, conclusionState, commitmentCurrent, commitmentInitial（登记时的初始承诺标记）, refObjectedEver（本登记任一仅供参考知会曾被异议）, riskCurrent, declineOutstanding（P175：有未解除的交接确认不认可；entry_unmark_risk 用，只对当前带风险标记的问题类查库）,
  //     confirmer（none / owner / delegate / unavailable）, confirmerProxyOnly（确认人是无账号成员，仅 for_reference 判）, owner（ok / missing / proxy_only，仅 escalate 判）, projectStatus, kind（conclude 的 conclusion_kind；读接口 actions 不带，缺省不判）}。
  //   事实没取到（undefined）一律 fail-closed 拒绝。
  entry_correct: Object.freeze({ can: canCorrectOrVoidEntry, state: entryNotVoided }),
  entry_void: Object.freeze({
    can: canCorrectOrVoidEntry,
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '该登记已有有效结论，不能作废';
      // C5 S-S1c：已被某条结论引用为办理依据（basis_kind = dev_note_version）的开发方处理说明不能作废，否则结论的依据就没了
      if (t.usedAsBasis === true) return '该登记已被引用为办理依据，不能作废';
      // 预筛 L2：已被开发方改期引用为关键事项（节点改期记录的 dev_key_entry_id）同样不能作废
      if (t.usedAsScheduleKey === true) return '该登记已被引用为改期依据（关键事项），不能作废';
      // P94 / M-a：有未结异议时只有「登记人本人且登记时身份不是 PM」可作废；PM 代登的登记（登记人 = PM）有未结异议时任何人都不能作废，只能给结论 / 交裁定收尾
      //   （registrantWasPm 取登记时的身份快照；事实没取到按「不是登记人豁免」拒绝）
      if (ENTRY_OPEN_OBJECTION_STATES.includes(t.conclusionState) && !(t.isRegistrant === true && t.registrantWasPm === false)) return '有未结异议，不能由 PM 作废';
      return null;
    },
  }),
  entry_conclude: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以给结论';
      if (EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '该登记已有有效结论，不能再次给结论；文字有误请用更正';
      // M-c：项目已终止且给「项目已终止」结论时，允许从裁定中（escalated）收尾——端点同一事务把待确认的裁定修订置 superseded；其他结论类别从裁定中仍 409。
      //   （项目非已终止时 escalated + project_terminated 落到下面「只能在项目已终止时」那条 409。）
      const closeEscalatedByTermination = t.conclusionState === 'escalated' && t.kind === 'project_terminated';
      if (!CONCLUDE_FROM_STATES.includes(t.conclusionState) && !closeEscalatedByTermination) return '当前结论状态不允许再给结论（裁定中请等待负责人裁定）';
      if (t.kind === 'project_terminated' && t.projectStatus !== 'terminated') return '「项目已终止」只能在项目已终止时作为结论';
      // S-S1b（派单 §3 ③）：判定依据类别为「规划外」且去向留在项目内的登记，结论只能是转正式变更（S-S1c 起开放，须带 change_id，端点校验），「项目已终止」收尾除外；读接口 actions 不带 kind，缺省不判
      if (t.route === 'project' && t.basisCategory === 'out_of_plan' && t.kind !== undefined && t.kind !== 'to_change' && t.kind !== 'project_terminated') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;
      // 预筛 M-2：去向是转系统迭代（route = sys_iteration）的处理项，结论只能是「转系统迭代」（项目已终止收尾除外）；读接口 actions 不带 kind，缺省不判（conclude_kinds 逐类别带 kind 判）
      if (t.route === 'sys_iteration' && t.kind !== undefined && t.kind !== 'to_sys_iteration' && t.kind !== 'project_terminated') return ENTRY_SYS_ITERATION_ROUTE_MESSAGE;
      // P96：「项目已终止」结论不需要确认人（不建任务、不要求来源方有代表人），直接已确定。L-d：这里确认人事实没取到（undefined）也放行，是 fail-closed 的**显式例外**
      //   （该结论根本不用确认人，不依赖这项事实）；其余结论类别照旧要求确认人可解析，事实没取到拒绝
      return t.kind === 'project_terminated' ? null : entryConfirmerState(t);
    },
  }),
  entry_for_reference: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (t.type !== 'feedback') return '只有意见与反馈可以标仅供参考';
      // 预筛 M-2 / M-3：转系统迭代的处理项须转系统迭代；规划外且留项目的只能转正式变更——都不能用「仅供参考」绕开
      if (t.route === 'sys_iteration') return ENTRY_SYS_ITERATION_REFERENCE_MESSAGE;
      if (t.route === 'project' && t.basisCategory === 'out_of_plan') return ENTRY_OUT_OF_PLAN_PROJECT_MESSAGE;
      if (t.commitmentCurrent === true) return '带「涉及承诺」标记的登记不能标仅供参考';
      if (t.commitmentCurrent !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      // M2（预筛修订批，派单「当前或初始」）：登记时的初始「涉及承诺」标记即使后来被取消，也不能标仅供参考
      if (t.commitmentInitial === true) return '登记时带「涉及承诺」标记的登记不能标仅供参考';
      if (t.commitmentInitial !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      // M1：本登记的仅供参考知会曾被异议后，不得再用「改结论 → 再标仅供参考」两步绕回仅供参考（待确认状态只对从未被异议的登记放行）
      if (t.refObjectedEver === true) return '本登记的仅供参考已被异议，须给结论并经确认';
      if (t.refObjectedEver !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      if (EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '该登记已有有效结论，不能再标仅供参考';
      if (!FOR_REFERENCE_FROM_STATES.includes(t.conclusionState)) return '当前结论状态不允许标仅供参考';
      const cs = entryConfirmerState(t);
      if (cs) return cs;
      // codex 24 M1：确认人是无账号成员（代表人 / 负责人本人，只能由 PM 代录）时，仅供参考的知会没人看得到，也就没人能提异议——不允许标仅供参考，请给结论（可代录确认）。
      //   confirmerProxyOnly 来自确认人解析（entries-core.entryTarget）；事实没取到按拒绝。普通 conclude 不受影响（结论确认任务可代录）。
      if (t.confirmerProxyOnly === true) return '确认人没有平台账号，看不到仅供参考知会，请给结论（可代录确认）';
      return t.confirmerProxyOnly === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  entry_mark_commitment: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (t.commitmentCurrent === true) return '该登记已标注涉及承诺';
      if (t.commitmentCurrent !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      // 修订批 3 H2：来源方为开发方的一般登记补标涉及承诺会建开发方认可任务（entries.js 补标分支），项目已终止 / 已结项不能再提交认可；读接口 actions 与执行同源。事实没取到按拒绝
      if (t.markNeedsDevTask === true) {
        const blocked = devConfirmProjectBlock(t.projectStatus);
        if (blocked) return blocked;
      } else if (t.markNeedsDevTask !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      return t.conclusionState === 'for_reference' ? '已标仅供参考的登记不能补标涉及承诺' : null;
    },
  }),
  entry_unmark_commitment: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t);
      if (v) return v;
      if (t.commitmentCurrent === false) return '该登记当前没有涉及承诺标记';
      return t.commitmentCurrent === true ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  entry_mark_risk: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t);
      if (v) return v;
      if (t.type !== 'issue') return '只有问题与处理类可以标风险';
      if (t.riskCurrent === true) return '该登记已标风险';
      return t.riskCurrent === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  entry_unmark_risk: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t);
      if (v) return v;
      if (t.type !== 'issue') return '只有问题与处理类可以标风险';
      // P175（修订批 4）：该登记有未解除的不认可（golive-core.declineOutstandingOf，跨批次：任一批次的交接确认被不认可都算）时不能取消风险标记——取消后该项不再需要交接确认，
      //   等于 PM 单方面解除代表人的不认可；出路 = 写答复请代表人重新决定，或给出新的结论类动作。target.declineOutstanding 由 entries-core.entryTarget 给（读接口 actions 同源）。事实没取到拒绝。
      if (t.riskCurrent === false) return '该登记当前没有风险标记';
      if (t.riskCurrent === true && t.declineOutstanding === true) return UNMARK_RISK_DECLINED_MESSAGE;
      return t.riskCurrent === true && t.declineOutstanding === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 交负责人裁定：当前结论状态 = 有异议；来源方须有现任负责人，且负责人有平台账号（裁定只在平台作出，派单 §6「adjudicate 不加入代录」——
  //   无账号负责人的裁定任务无人能决策、登记会卡在「裁定中」，所以建任务前拒绝，PM 仍可改结论重新发起；报告列为取舍）。
  entry_escalate: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (t.conclusionState !== 'objected') return '只有「有异议」的结论可以交负责人裁定';
      if (t.owner === 'missing') return '来源方没有现任负责人，无法交负责人裁定';
      if (t.owner === 'proxy_only') return '来源方负责人没有平台账号，裁定只能在平台作出，请改结论后重新发起确认';
      return t.owner === 'ok' ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // ── C5 S-S1b：拆分 / 待判定归属 / 记系统迭代单号 / 对已有有效结论的登记提异议 ─────────────────────────────────────────────────────────
  //   手动拆分（PM）：办理类、未作废、不是已拆分容器（entryNotVoided）、不是拆出的处理项、没有有效结论、关联条目至少两个（target.distinctItemCount）。分组本身的校验（条目归属、
  //   每组去向一致）在端点里按 400 / 409 判。
  entry_split: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以拆分';
      // C5 S-S1c（派单 0b 冲突 5）：开发方处理说明 / 正式交付物用途的登记不进分流；需要开发方负责人认可的登记（来源方为开发方且带涉及承诺）不可拆分
      if (ENTRY_DEV_PURPOSES.includes(t.purpose)) return '开发方处理说明 / 正式交付物用途的登记不进分流，不能拆分';
      if (t.needsDevConfirm === true) return '需要开发方负责人认可的登记不能拆分';
      // 修订批 3 N1（预筛快看）：开发方负责人未认可（not_approved）的登记，即使 PM 取消了涉及承诺（不再「需要认可」），也不能拆分——子项没有认可任务，拆分会把未认可洗掉；出路是修订重提。事实没取到按拒绝
      if (t.devConfirmStatus === 'not_approved') return ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE;
      if (typeof t.devConfirmStatus !== 'string') return PROXY_FACT_UNKNOWN_MESSAGE;
      if (t.isChild === true) return '拆出的处理项不能再拆分';
      if (t.isChild !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      // 预筛 H-1：只有尚未给结论（none）的登记可以拆分。拆分后子项没有办理记录，待确认 / 有异议 / 裁定中 / 裁定未通过 / 仅供参考被异议 / 项目已终止结论失效的登记若能拆，
      //   就把未结异议和「曾被异议」洗掉（子项可直接标仅供参考或作废，容器按子项「已结」后节点即可收口）。
      if (!ENTRY_SPLIT_FROM_STATES.includes(t.conclusionState)) return '只有尚未给结论的登记可以拆分';
      // 修订批 2 M-2：PM 已按「规划外 / 规划内待细化」人工归属的登记不能拆（拆分每组重新分流，会把 PM 的人工归属洗回待判定）；只允许依据为 in_plan、undetermined 或从未分流的（依据缺失）
      if (t.basisCategory === 'out_of_plan' || t.basisCategory === 'planned_detail') return '已按规划外 / 规划内待细化归属的登记不能拆分';
      if (!(t.distinctItemCount >= 2)) return '登记关联的需求条目少于两个，无法拆分';
      return null;
    },
  }),
  //   待判定归属（PM）：办理类、未作废、不是容器，且当前去向是「尚未判定」（route = pending）。换批 / 重新归属本批不开放（§4.3，第二期），所以已有去向的登记 409。
  //   依据类别、条目与去向的组合在端点里按 400 / 409 判。
  entry_assign_items: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理需要分流归属';
      if (ENTRY_DEV_PURPOSES.includes(t.purpose)) return '开发方处理说明 / 正式交付物用途的登记不进分流，不需要归属'; // C5 S-S1c（派单 0b 冲突 5）
      // Q4 + codex 25 H1（收紧 P113）：只有尚未给结论（none）的登记可以补选归属。结论是在旧去向下作出的：待确认 / 裁定中 / 有异议的结论若能在归属改变后再确认生效，
      //   就绕过「去向转系统迭代只能转系统迭代 / 规划外留项目只能转正式变更」的结论限制；有效结论更不能事后改去向。
      if (t.conclusionState !== 'none') return '已给结论的登记不能补选归属';
      if (t.route === 'pending') return null;
      return t.route === undefined ? PROXY_FACT_UNKNOWN_MESSAGE : '该登记已有分流归属，不能重新归属（换批与拆分随第二期开放）';
    },
  }),
  //   记系统迭代单号（PM）：按上线分界转系统迭代的登记，项目里记单号（方案 §4.1 表「关联内容已上线后」、§4.2 D34 第三行）。只追加办理记录，不改结论状态；办理类、未作废、不是容器即可。
  entry_link_sys_issue: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      return ENTRY_HANDLED_TYPES.includes(t.type) ? null : '只有意见与反馈、问题与处理可以记系统迭代单号';
    },
  }),
  //   挂靠变更（link_change，C5 S-S1c）：PM 给已有结论（conclude 动作）的办理类登记补挂变更号；只追加办理记录，不改结论状态。change_id 的归属 / 状态校验在端点里（409）。
  entry_link_change: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以挂靠变更';
      if (t.hasConclusion === true) return null;
      return t.hasConclusion === false ? '该登记还没有结论，请先给结论（结论选「转正式变更」会同时挂靠变更）' : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  //   写开发方关键事项（purpose = dev_note / deliverable，C5 S-S1c）：开发方负责人、开发方代表人、PM 代登；其他人（含需求方、admin 非成员）403。项目状态类别 accept（需要开发方负责人认可，已终止 / 已结项不能作出认可）。
  //   target = { devPartyId（本项目开发方参与方编号，没有为 null） }；开发方暂无负责人 / 来源方须是开发方等业务规则在端点里按 409 / 400 判。只读账号一票否决。
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
  //   对已有有效结论的登记提异议（D34 / P97）：生成一条异议登记（节点未收口 = 过程登记，已收口 = 补充登记），不撤回原确认。谁：t.objectorBasis（entries-core.objectorBasisOf；null = 无资格）。
  //   项目状态按 resolve 类（§4.5「既有登记的结论确认、异议」四态都允许）；不带只读一票否决——与知会异议同口径（§5.1 只读账号可作出本人的确认 / 异议）。
  entry_object: Object.freeze({
    can: (identity, project, t) => ENTRY_OBJECTOR_BASES.includes(t.objectorBasis),
    state: (t) => {
      const v = entryNotVoided(t) || entryStateKnown(t);
      if (v) return v;
      if (!ENTRY_HANDLED_TYPES.includes(t.type)) return '只有意见与反馈、问题与处理可以提异议';
      // Q3：仅供参考的登记只有「对知会提异议」一个入口（节点收口前回到办理，收口后由知会异议的 supplement_entry 模式承接），不经 objects_entry_id
      //   修订批 2 M-1：只在「存在仅供参考知会」时走知会路径（t.hasRefNotice）；PM 本人 / 内部成员登记的仅供参考没有知会（不需确认，没有接收人），没有知会可异议，改走本入口。事实取不到按拒绝。
      if (t.conclusionState === 'for_reference' && t.hasRefNotice === true) return '仅供参考的登记请对知会提异议';
      if (t.conclusionState === 'for_reference' && t.hasRefNotice !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      if (!EFFECTIVE_CONCLUSION_STATES.includes(t.conclusionState)) return '该登记还没有有效结论：结论待确认时请在确认任务里提异议，仅供参考请对知会提异议';
      // 预筛 L-2：读接口 actions.object 与执行同源——关联条目全部所在批次已上线（执行会 409 引导系统迭代）、所在节点已取消（执行会 409）时标志为假。
      //   事实由 entries.js 的异议 target 构造；执行端点对这两项传 false，由 createEntryCore 带 guide 的 409 接手（见 entries.js 说明）。事实没取到按拒绝。
      if (t.itemsAllLive === true) return '关联的需求条目所在批次已正式上线，项目内不再接受新增，请到系统迭代受理渠道提单';
      if (t.nodeCancelled === true) return '该登记所在节点已取消，不能再关联新登记';
      return t.itemsAllLive === false && t.nodeCancelled === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 对知会提异议：target = { isRecipient, objectorBasis, objected（该知会已有异议）, entryVoided, entryState（登记当前结论状态）, isLatest（该知会是登记最新的一条仅供参考知会）}。
  notice_object: Object.freeze({
    can: canObjectNotice,
    state: (t) => {
      if (t.objected === true) return '该知会已提过异议，同一知会只能异议一次';
      if (t.objected !== false) return PROXY_FACT_UNKNOWN_MESSAGE;
      const v = entryNotVoided({ voided: t.entryVoided });
      if (v) return v;
      if (t.isLatest !== true || t.entryState !== 'for_reference') return '该登记当前不是「仅供参考」状态，不能再对这条知会提异议';
      return null;
    },
  }),
  // C6b：对改期知会（kind = schedule_change）提异议（P158，替换 C5 的占位）：只有接收人本人、且仍是需求部门现任负责人（已卸任的接收人、其他负责人、PM、其他成员一律 403）；
  //   target = { isRecipient, stillOwner, objected }。异议转 PM（mode = to_pm），不阻塞改期；每条知会至多一条异议。项目状态类别 resolve（四态都可，与仅供参考知会异议同口径；接收人是只读账号也可提）。
  schedule_notice_object: Object.freeze({
    can: (identity, project, t) => t.isRecipient === true && t.stillOwner === true,
    state: (t) => {
      if (t.objected === true) return '该知会已提过异议，同一知会只能异议一次';
      return t.objected === false ? null : PROXY_FACT_UNKNOWN_MESSAGE;
    },
  }),
  // 结论确认 / 负责人裁定任务的决策、代录、改发：判定与内容包任务的 confirm_decide / confirm_proxy 完全同一份（委托，不复制），只是项目状态类别按 resolve 判
  //   （方案 §4.5「既有登记的结论确认、异议、负责人裁定」四态都允许；confirm_decide / confirm_proxy 本身是 accept 类，已终止 / 已结项 409）。
  //   委托用惰性引用：此时 OBJECT_OPS 还在初始化，调用时才取。
  entry_conclusion_decide: Object.freeze({
    can: (identity, project, t) => OBJECT_OPS.confirm_decide.can(identity, project, t),
    state: (t) => OBJECT_OPS.confirm_decide.state(t),
  }),
  entry_conclusion_proxy: Object.freeze({
    can: (identity, project, t) => OBJECT_OPS.confirm_proxy.can(identity, project, t),
    state: (t) => OBJECT_OPS.confirm_proxy.state(t),
  }),
  // 改发：只有待确认的修订（有异议的结论请改结论或交裁定；裁定未通过请改结论）；对象（该结论 / 裁定）须仍是登记的当前结论。reissueBlocked = 重新解析确认人的结果（confirm.js）。
  entry_conclusion_reissue: Object.freeze({
    can: (identity) => canActAsPm(identity),
    state: (t) => {
      if (!ENTRY_TASK_OBJECT_TYPES.includes(t.objectType)) return '该类型的确认任务不支持改发';
      if (t.revisionStatus !== 'pending') return '只有待确认的修订可以改发；有异议的结论请改结论或交负责人裁定';
      if (!(t.objectPending === true)) return '该结论已不是登记的当前结论，不能改发'; // 写成否定式：C4b 的变异锚点钉在 confirm_proxy 里那句 `!== true`，这里不得再出现同一文本
      return t.reissueBlocked ? t.reissueBlocked : null; // 同上：C4a 的变异锚点钉在 confirm_reissue 里的 `t.reissueBlocked || null`
    },
  }),
  // ── C6a 上线与交接（方案 §3.2 :467、§4.2 :613、§4.3 上线交接清单与 v1.5 细则、§4.5 状态机、§5.2 :855–857；派单 C6a §3–§8）──────────────────────────────────────
  // 确认试运行结束（正式上线 / 再上线）：PM（admin 接管后），项目状态类别 golive（只有「进行中」，暂停 409 SYSBUILD_PROJECT_READONLY）。
  //   target = { batchStatus, blockers }：blockers = 上线前置未满足项（golive-core.goliveBlockersOf：本批节点未收口 / 验收包未生效 / 交接集合有未清项，按当时完整集合现算，
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
  // 发起交接确认（接受带此问题上线 / 不再处理）：PM（admin 接管后），项目状态类别 maintain；确认人 = 每个需求部门的生效代表人各一条（全部确认才算通过）。
  //   target = { batchStatus, inSet（该登记在本批交接集合里）, resolved（已办结）, needKind（accept_issue / no_further / null = 不需要交接确认）, allCovered（每个需求部门在当前问题状态下
  //   都已有交接确认任务）, confirmState（已有任务时的整体状态：pending / confirmed / declined / incomplete）, confirmersMissing（还没有任务的参与方里缺生效代表人：null = 齐全，
  //   否则 { noParty, missing }）}。事实没取到（undefined）一律拒绝。读接口每项 actions.handover_request 与 POST …/handover/requests 同一个 target 构造（golive-core.handoverRequestTarget）。
  handover_request: Object.freeze({
    can: canActAsPm,
    state: (t) => {
      if (t.batchStatus !== 'active') return t.batchStatus === undefined ? BATCH_FACT_UNKNOWN_MESSAGE : '批次不是进行中，不能发起交接确认';
      if (t.inSet !== true) return t.inSet === false ? '该登记不在本批的上线交接集合里' : GOLIVE_FACT_UNKNOWN_MESSAGE;
      if (t.resolved !== true) return t.resolved === false ? '该登记还没有办结，请先给出结论' : GOLIVE_FACT_UNKNOWN_MESSAGE;
      // P173（取代 P165 的「同一指纹」口径）：代表人对该登记作出过不认可 / 有异议（confirmState = 'declined'，golive-core.declineOutstandingOf：当前或历史上任一不认可的修订之后，
      //   该登记还没有出现新的结论类动作——给结论 / 仅供参考 / 作废；adjudicate 为预留）→ 不能重新发起，也不能改发（confirm.resolveReissue）；更正、记单号、标 / 取消风险都不解除，
      //   已不需要确认时也一样（仍判未清）。出路 = 给出新的结论类动作。排在「不需要确认」之前，让拒绝文案指向真正的原因。
      //   P174（方案 §4.2 :633-634）：PM 带答复（reply）重新发起——t.replyGiven = 本次带了合法答复；带答复时被不认可的任务生成新修订（不算「已有任务」），由代表人重新决定（P175 起不再有「只记答复」的路）。
      //   P177（修订批 5，取代 P174 的「答复解除」）：答复只解锁重新发起，**不解除**不认可——解除要代表人对新修订作出确认或登记出现新的结论类动作（golive-core.outstandingDeclinesOf）；
      //   confirmState = 'declined' 在这里指「待答复的不认可」（未解除且还没被答复）。没有需要答复的不认可时带答复 409。
      //   P175（修订批 4）：答复只在该项**仍需交接确认**时有效——不需要确认（needKind null）却有未解除的不认可时，答复一律 409（原「只记答复即清」的路去掉，取消风险已被 entry_unmark_risk 挡住，
      //   这里是兜底），唯一出路是新的结论类动作。
      const replyOk = t.confirmState === 'declined' && t.replyGiven === true;
      if (t.confirmState === 'declined' && !replyOk) return t.needKind === null ? DECLINED_NO_NEED_MESSAGE : DECLINED_REPLY_MESSAGE;
      if (t.confirmState !== 'declined' && t.replyGiven === true) return NO_REPLY_NEEDED_MESSAGE;
      if (t.needKind === null) return replyOk ? DECLINED_NO_NEED_MESSAGE : '该登记不需要交接确认';
      if (!HANDOVER_NEED_KINDS.includes(t.needKind)) return GOLIVE_FACT_UNKNOWN_MESSAGE;
      if (t.allCovered === true && !replyOk) return `该登记已有当前有效的交接确认任务（${HANDOVER_STATE_LABELS[t.confirmState] || '处理中'}），请在任务上处理（待确认的任务可代录、可换人改发）或等待确认`;
      if (t.allCovered !== false && !(replyOk && t.allCovered === true)) return GOLIVE_FACT_UNKNOWN_MESSAGE;
      const cm = t.confirmersMissing;
      if (cm === undefined) return CONFIRMERS_UNKNOWN_MESSAGE;
      if (cm !== null) return cm.noParty ? NO_DEMAND_PARTY_MESSAGE : `以下参与方缺少生效代表人，无法发起交接确认：${cm.missing.join('、')}`;
      return null;
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
  appointment_propose: 'membership',
  appointment_withdraw: 'membership',
  appointment_end: 'membership',
  delegation_propose: 'membership',
  delegation_approve: 'membership',
  delegation_reject: 'membership',
  delegation_revoke: 'membership',
  delegation_withdraw: 'membership',
  delegation_accept: 'membership',
  delegation_decline: 'membership',
  invitation_accept: 'membership',
  invitation_decline: 'membership',
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
  // C3b：模块 / 条目 / 内容包的草稿编辑都属「维护」类（方案 v1.2 §4.5：草稿编辑（模块、条目、内容包）进行中 / 已暂停可，已终止 / 已结项否）
  module_create: 'maintain',
  module_rename: 'maintain',
  item_create: 'maintain',
  item_version_create: 'maintain',
  item_set_module: 'maintain',
  material_version_create: 'maintain',
  package_create: 'maintain',
  package_version_create: 'maintain',
  package_version_edit: 'maintain',
  package_item_add: 'maintain',
  package_item_remove: 'maintain',
  // C4a：发起确认（提交 / 撤回 / 改发）属「维护」类（§4.5：发起内容包确认 进行中 / 已暂停可，已终止 / 已结项否）；作出确认属「作出推进类确认」accept 类
  //   （进行中 / 已暂停可，已终止 / 已结项否）。
  package_version_submit: 'maintain',
  package_version_withdraw: 'maintain',
  confirm_reissue: 'maintain',
  confirm_decide: 'accept',
  // C4b Q-S1：代录内容包 / 提出人确认 = 作出推进类确认（accept，与 decide 同一行）；任职接受 / 授权代录按 membership 类（与本人接受同一行，D3）。
  confirm_proxy: 'accept',
  appointment_proxy_accept: 'membership',
  delegation_proxy: 'membership',
  // C4b Q-S2：窗口三个动作、历史补录、历史事实导入 = history_import 类（§4.5 表「历史事实导入」行：进行中 / 已暂停是，已终止 / 已结项否）。
  history_window_open: 'history_import',
  history_window_close: 'history_close',
  history_window_reopen: 'history_import',
  history_confirmation_record: 'history_import',
  history_fact_import: 'history_import',
  // C5 S-S1a：写登记按时段分两类（已终止 / 已结项只能写补充登记）；其余办理（更正 / 作废 / 结论 / 仅供参考 / 标记 / 交裁定 / 知会异议 / 结论确认 / 裁定）= 既有登记继续办理
  //   （resolve：四态都允许，方案 §4.5 表「既有登记继续办理」「既有登记的结论确认、异议、负责人裁定」两行）。更正 / 作废派单未指定类别，主会话待追认，暂同 resolve。
  entry_create_process: 'register_process',
  entry_create_supplement: 'register_supplement',
  entry_correct: 'resolve',
  entry_void: 'resolve',
  entry_conclude: 'resolve',
  entry_for_reference: 'resolve',
  entry_mark_commitment: 'resolve',
  entry_unmark_commitment: 'resolve',
  entry_mark_risk: 'resolve',
  entry_unmark_risk: 'resolve',
  entry_escalate: 'resolve',
  notice_object: 'resolve',
  schedule_notice_object: 'resolve',
  entry_conclusion_decide: 'resolve',
  entry_conclusion_proxy: 'resolve',
  entry_conclusion_reissue: 'resolve',
  // C5 S-S1b：拆分 / 待判定归属 / 记单号 / 提异议 = 既有登记继续办理（resolve：四态都允许；异议同 §4.5「既有登记的结论确认、异议」行）
  entry_split: 'resolve',
  entry_assign_items: 'resolve',
  entry_link_sys_issue: 'resolve',
  entry_object: 'resolve',
  // C5 S-S1c：挂靠变更 = 既有登记继续办理（resolve）；建变更 / 出新版本 = 维护类（§4.5「正式变更」与维护类同行）；写开发方关键事项 = 需要开发方负责人认可（accept 类，已终止 / 已结项否）
  entry_link_change: 'resolve',
  entry_create_dev: 'accept',
  change_create: 'maintain',
  change_new_version: 'maintain',
  // C6a：确认试运行结束（上线 / 再上线）= golive 类（只有进行中）；撤销上线 = 维护类（仅 admin，已终止 / 已结项 409）；发起交接确认 = 维护类（PM）；
  //   交接确认的决策（作出确认）沿用 confirm_decide：accept 类（推进类确认，已终止 / 已结项 409）。
  golive: 'golive',
  revoke_golive: 'maintain',
  handover_request: 'maintain',
});
const OP_KIND_MISSING = Object.keys(OBJECT_OPS).filter((k) => !Object.prototype.hasOwnProperty.call(OP_KIND, k));
const OP_KIND_EXTRA = Object.keys(OP_KIND).filter((k) => !Object.prototype.hasOwnProperty.call(OBJECT_OPS, k) || !Object.prototype.hasOwnProperty.call(PROJECT_ACTION_TABLE, OP_KIND[k]));
if (OP_KIND_MISSING.length > 0 || OP_KIND_EXTRA.length > 0) {
  throw new Error(`rules.js: OP_KIND 与 OBJECT_OPS 不全等（漏登记: ${OP_KIND_MISSING.join(',') || '无'}；多余或类别不在状态表: ${OP_KIND_EXTRA.join(',') || '无'}）`);
}
// 判定一个动作；允许返回 null，否则返回 { status, code, message[, stale] }。
//   stale = 对象状态都对、但接受时的资格重核不通过（邀请人已无权 / 依据的任职已变化等）：端点要把对象置为已撤回、提交后再报 409。
function checkOp(op, identity, project, target) {
  if (!Object.prototype.hasOwnProperty.call(OBJECT_OPS, op)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：动作未登记');
  const def = OBJECT_OPS[op];
  const t = target || {};
  if (!def.can(identity, project, t)) return { status: 403, code: 'SYSBUILD_FORBIDDEN', message: '没有权限执行该操作' };
  // 项目状态类别取 OP_KIND（硬门：未登记的动作报 500，没有缺省类别；C2 动作全是 membership，C3a 起节点收口是 close）。
  if (!Object.prototype.hasOwnProperty.call(OP_KIND, op)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：动作未登记项目状态类别');
  if (!projectAllowsWrite(project.status, OP_KIND[op])) return { status: 409, code: 'SYSBUILD_PROJECT_READONLY', message: '当前项目状态不允许该写入' };
  if (def.noSelf && isSelfManagedTarget(identity, t)) return { status: 409, code: 'SYSBUILD_STATE', message: SELF_TARGET_MESSAGE };
  const msg = def.state(t);
  if (msg) return typeof msg === 'string' ? { status: 409, code: 'SYSBUILD_STATE', message: msg } : { status: 409, code: msg.code, message: msg.message };
  if (def.requal) {
    const why = def.requal(t);
    if (why) return { status: 409, code: 'SYSBUILD_STATE', message: why, stale: true };
  }
  return null;
}
function opAllowed(op, identity, project, target) {
  return checkOp(op, identity, project, target) === null;
}
function assertOp(op, identity, project, target) {
  const v = checkOp(op, identity, project, target);
  if (v) throw makeError(v.status, v.code, v.message);
}
// 目标由请求体指定的管理动作（加成员、提议任职）：读到目标用户后，用与 checkOp 同一个本人判定再核一次。
function assertNotSelfTarget(op, identity, targetUserId) {
  if (!Object.prototype.hasOwnProperty.call(OBJECT_OPS, op) || !OBJECT_OPS[op].noSelf) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：动作未登记本人目标限制');
  if (isSelfManagedTarget(identity, { targetUserId })) throw makeError(409, 'SYSBUILD_STATE', SELF_TARGET_MESSAGE);
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
    // C4b Q-S2：历史补录中窗口的三个动作与「可录历史补录 / 可导入历史事实」（与 history.js 的写端点同一张 OBJECT_OPS 表、同一个 target：project.history_window）。
    //   history_import 标志只承诺 权限 + 项目状态 + 窗口开启；对象级的要求与冲突（版本属本项目、任职待接受等）仍可能在执行时 409。
    history_window_open: opAllowed('history_window_open', identity, project, { historyWindow: project.history_window }),
    history_window_close: opAllowed('history_window_close', identity, project, { historyWindow: project.history_window }),
    history_window_reopen: opAllowed('history_window_reopen', identity, project, { historyWindow: project.history_window, projectLevel: true }),
    history_confirm: opAllowed('history_confirmation_record', identity, project, { historyWindow: project.history_window }),
    history_import: opAllowed('history_fact_import', identity, project, { historyWindow: project.history_window }),
    // P179：能否导入上线事件（golive 类事实）= history_import 的权限 / 窗口 / 项目状态 + 项目状态另按 golive 类（只有进行中）；与 history.js 的 golive 导入同一个 goliveImportProjectBlock
    history_import_golive: opAllowed('history_fact_import', identity, project, { historyWindow: project.history_window }) && goliveImportProjectBlock(project.status) === null,
    // C5 S-S1a：能否写登记（任一时段可写即真：已终止 / 已结项只能写补充登记，时段由服务端按关联节点 / 项目是否收口判定，页面不让用户选）。
    create_entry: opAllowed('entry_create_process', identity, project, {}) || opAllowed('entry_create_supplement', identity, project, {}),
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
  BATCH_FROZEN_STATUSES, PROJECT_ACTION_TABLE, STATUS_TRANSITIONS, projectAllowsWrite, goliveImportProjectBlock, actionsFor,
  SUBMITTABLE_PACKAGE_TYPES, EXCLUSIVE_PENDING_PACKAGE_TYPES, EXCLUSIVE_PENDING_SQL_LIST, PACKAGE_TYPE_LABELS, HANDOVER_NEED_KINDS,
  ENTRY_CONCLUSION_STATES, EFFECTIVE_CONCLUSION_STATES, CONCLUDE_FROM_STATES, FOR_REFERENCE_FROM_STATES, ENTRY_HANDLED_TYPES, ENTRY_DEV_PURPOSES,
  devConfirmProjectBlock, DEV_CONFIRM_PROJECT_MESSAGE, ENTRY_DEV_NOT_APPROVED_SPLIT_MESSAGE,
  canManageMembership, canActAsPm, canRegisterItem, canCreateItemVersion, delegationInitialStatus, ownsParty, OBJECT_OPS, OP_KIND, checkOp, opAllowed, assertOp, assertNotSelfTarget,
  assertVisible, assertCan,
};
