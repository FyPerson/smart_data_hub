// routes/sysbuild/notify.js — 项目管理（系统建设记录）模块：钉钉通知（事务外发送、结果回写、补发、模块就绪时扫描）与 PM 补发 / 我的待办端点（C6b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §9.1（站内待办）、§9.2（钉钉通知 / 发送意图）、§4.4（改期知会）、§7（GET /my/todo）。
//   派单 = docs/local/系统建设记录/送审准备/C6_C6b_通知待办改期知会_派单_20261107.md §1–§5。
//
// 两个工厂：
//   createNotifier(opts)      发送侧。opts：{ db, logger, dingtalkNotify（utils/dingtalk-notify.js 模块对象或同形替身）, getSystemConfig（key → 解密后的值或 null，server.js 注入 readSystemConfig）, readonlyIds（只读账号集合，发送前复核收件人资格用）, backgroundJobs? }。
//                             · wrapDb(db)：返回包装后的 db——withWriteTxn 给回调的 q 挂上本事务的意图清单（q.sendIntentIds），**事务提交成功后**在事务外（setImmediate）逐条发送；回调抛错 / 回滚不发。其余成员原样透传。
//                             · deliverIntent(id, o)：发送一条意图（读收件人 → 配置 → 钉钉 → 条件更新回写 + 事件）。**发送失败不回滚、不影响任何业务状态**；同一进程内用内存集合标记「发送中」的意图编号，已在发送中的直接跳过（P156）。
//                             · resendProject(projectId, user)：PM 补发（本项目 failed 的全部 + pending 且创建超过 5 分钟的）；scan()：模块就绪时扫描（pending 与 failed 且 attempts < 3），只在后台任务开关为 on 时由 onReady 触发（P157）。
//                             · whenIdle()：当前没有排队 / 在途发送时 resolve（测试等待发送完成的信号，不用固定 sleep）。
//   createNotifyRoutes(ctx)   GET /projects/:id/send-intents（PM）、POST /projects/:id/send-intents/resend（PM）、GET /my/todo。
// 状态机（sysbuild_send_intents.status，条件更新 WHERE 带旧状态，影响行数 0 = 别处已处理，本次不再写）：
//   pending → sent（发送成功，attempts + 1） / failed（发送失败，attempts + 1，last_error 写原因）；
//   failed → sent / failed（补发或扫描重试，attempts + 1）；
//   pending / failed → sent（跳过：引用对象已不需要这条通知——修订已不是待确认、邀请已处理等；attempts 不变，last_error 写「无需发送：原因」）；sent 是终态。
//   外发前复核的顺序（修订批 3）：先按与账号状态无关的条件判永久失格（→ 跳过），全部满足才看可恢复的条件（收件人账号停用 / 项目已终止的邀请与授权 → failed，attempts + 1，账号恢复 / 项目重开后补发 / 扫描能送出）；
//   首次加载意图时复核一次，**每次实际调用钉钉发送前**（取令牌、手机号反查之后，以及令牌刷新后的重试之前）再复核一次，结论不变才发。
//   修订批 4：外发前复核还核**最新账号行**——账号行不在了跳过（收件人账号已不存在）；钉钉号 / 反查用的手机号与解析地址时不同，就按最新账号行重新解析地址并再复核，用最新地址外发（O1）。
//   发送调用 / 刷新令牌 / 手机号反查抛出的异常，系统性判定与渠道返回的错误同一个出口（isSystemicReason：网络类 + 限流 / 无权限，O3）。
// 软成功判定参照 server.js sendCollabDingtalkRaw：errcode 非 0、收件人在 invalid / flowControlled / filtered 名单里、无 processQueryKey 都当失败。
// 安全：last_error / 事件 payload 不含 access_token、appSecret、robotCode、手机号、钉钉号；写入前统一过 scrub。
'use strict';
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const entriesCore = require('./entries-core');
const goliveCore = require('./golive-core');
const notifyCore = require('./notify-core');
const notifySchedule = require('./notify-schedule');
const membership = require('./membership'); // 修订批 2（M2）：邀请 / 授权的「可操作」判定与站内入口共用

const { PURPOSES, REF_TYPES, ROUTES } = notifyCore;
const SYSTEM_OPERATOR = Object.freeze({ id: 0, display_name: '系统' }); // schema.js 约定②：系统操作人名一律「系统」
const TODO_ITEM_CAP = 50; // GET /my/todo 每类最多返回的条数（counts 仍是全量）
const RESEND_BATCH_CAP = 100; // 一次补发最多处理的条数（其余下次再补，响应带 remaining）
const SCAN_BATCH_CAP = 200;
const INTENT_STATUSES = Object.freeze(['pending', 'sent', 'failed']);

// 消息标题 / 路由文案（集中定义）
const KIND_TITLES = Object.freeze({
  [PURPOSES.CONFIRM_REQUEST]: '待确认',
  [PURPOSES.CONFIRM_REISSUE]: '待确认（已改发给您）',
  [PURPOSES.DECISION_OBJECTED]: '确认被提出异议或不认可',
  [PURPOSES.INVITATION]: '项目邀请',
  [PURPOSES.DELEGATION_ACCEPT]: '授权待接受',
  [PURPOSES.SCHEDULE_NOTICE]: '改期知会',
});
const OWNER_TITLE = '【系统建设记录】有事项需要您处理';
const OWNER_TEXT = '您有一项事项需要处理，请打开平台查看。';
const LINK_LABEL = '打开确认';
// L7：改期知会对负责人是「知会」不是「请您处理」，固定文案与确认类区分（仍不带对象摘要，只给固定文案 + 链接）
const NOTICE_OWNER_TITLE = '【系统建设记录】改期知会';
const NOTICE_OWNER_TEXT = '有一条改期知会，请查看。';
const NOTICE_LINK_LABEL = '打开查看';
// 发送失败里「系统性」的原因（网络 / 钉钉服务端 / 响应不可解析）：补发遇到第一个就中止本批（L4）
const SYSTEMIC_NET_REASONS = Object.freeze(['network', 'server_5xx', 'invalid_response']);
const SYSTEMIC_APP_REASONS = Object.freeze(['rate_limit', 'no_scope']); // errcode 90018 限流、60011 应用未开通权限（LOW-b）
// 修订批 4（codex 28-R2 O3）：「系统性失败」的判定只有这一个出口——渠道返回的错误（judgeChannelResponse）与调用抛出的异常（sendOneInner 各 catch 分支）都用它，
//   不再各写各的（原先抛异常分支只看网络类，限流 / 无权限被抛出时判成非系统性，补发 / 扫描不中止）。
const isSystemicReason = (reason) => SYSTEMIC_NET_REASONS.includes(reason) || SYSTEMIC_APP_REASONS.includes(reason);

const PROJECT_TERMINATED_FAIL = Object.freeze({ reason: 'project_terminated', error: '项目已终止，暂时无法发送（项目重开后补发 / 扫描会再试）' }); // P187：可恢复的失败（不是「无需发送」）
const NO_ACCOUNT_STATE = Object.freeze({ ignoreAccountStatus: true }); // 修订批 3：发送前复核先不看账号状态（confirm-core.eligibleSqlOf / notify-schedule.scheduleNoticeObjectorFacts 的 o）
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const trimText = (v) => (typeof v === 'string' ? v.trim() : '');
function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
// 去掉文本里的敏感值（令牌 / 密钥 / 机器人编码），再截断
function scrub(text, secrets) {
  let s = String(text === null || text === undefined ? '' : text);
  for (const v of secrets || []) {
    if (typeof v === 'string' && v.length >= 4) s = s.split(v).join('***');
  }
  return s.length > 200 ? s.slice(0, 200) : s;
}
function normalizeBaseUrl(raw) {
  const v = trimText(raw).replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/i.test(v) ? v : '';
}

// 渠道响应判定（修订批 3 / codex N2）：**逐次留痕（channel_results）与最终结果共用这一个函数**，不各写一份——渠道返回后先判定，再把这次的结果追加进留痕。
//   res：sendMarkdownToUser 的返回（可空 = 空响应）；ctx：{ classify, errorText(c)（errcode 分支的脱敏原因文本）, dingUserId }。
//   返回 { ok, reason（留痕里的原因，不带阶段前缀）, failReason（最终结果的 reason，errcode 分支带 send_ 前缀）, error, errcode, systemic, tokenExpired }；
//   判失败的情形：errcode 非 0、机器人编码无效（新版 batchSend 返回 { code, message }）、收件人在 invalid / flowControlled / filtered 名单里、没有消息标识（含空响应）。
function judgeChannelResponse(res, ctx) {
  const bad = (reason, failReason, error, extra) => Object.assign({ ok: false, reason, failReason, error, errcode: null, systemic: false, tokenExpired: false }, extra || {});
  const listHas = (arr) => Array.isArray(arr) && arr.map((v) => String(v).trim()).includes(ctx.dingUserId);
  if (res && res.errcode && res.errcode !== 0) {
    const c = ctx.classify(res);
    const reason = c.reason || 'errcode';
    // LOW-b（修订批 2）：限流（90018）、应用未开通权限（60011）是整个应用 / 凭证层面的问题，换哪个收件人都一样——系统性失败（补发 / 扫描中止本批）
    return bad(reason, `send_${reason}`, ctx.errorText(c), { errcode: res.errcode, systemic: isSystemicReason(c.reason), tokenExpired: c.reason === 'token_expired' });
  }
  // LOW-b：机器人编码无效 / 未启用（新版 batchSend 不返回 errcode，而是 { code, message }）也是应用层面的系统性失败
  if (res && typeof res.code === 'string' && /robot/i.test(`${res.code} ${typeof res.message === 'string' ? res.message : ''}`)) {
    return bad('robot_code_invalid', 'robot_code_invalid', 'send:robot_code_invalid：机器人编码无效或机器人未启用，消息未送达', { systemic: true });
  }
  if (res && listHas(res.invalidStaffIdList)) return bad('user_invalid', 'user_invalid', 'send:user_invalid：收件人的钉钉账号失效或已离职，消息未送达');
  if (res && listHas(res.flowControlledStaffIdList)) return bad('rate_limit', 'rate_limit', 'send:rate_limit：钉钉发送被限流，消息未送达');
  if (res && listHas(res.filteredStaffIdList)) return bad('filtered', 'filtered', 'send:filtered：消息被钉钉规则过滤，未送达');
  if (!res || !res.processQueryKey) return bad('no_query_key', 'no_query_key', 'send:no_query_key：钉钉未返回消息标识，发送状态未确认');
  return { ok: true, reason: 'ok', failReason: null, error: null, errcode: null, systemic: false, tokenExpired: false };
}

// 被有异议 / 不认可的修订是否仍待 PM 处理：它是任务的最新修订（没有改发，由调用方判），且被确认的对象还是「现行」（内容包版本仍待确认、条目没有新版本、登记没有新的结论类动作……）。
//   待办 handle 类（revision_declined）与发送侧复核 decision_objected（describeRef）共用。row：{ object_type, object_id, object_version_id }。
async function declinedStillOpen(q, row) {
  if (row.object_type === 'package_version') {
    const v = await q.get('SELECT status FROM sysbuild_package_versions WHERE id = ?', [row.object_version_id]);
    return !!v && v.status === 'pending';
  }
  if (row.object_type === 'item_version') {
    const m = await q.get('SELECT MAX(id) AS id FROM sysbuild_item_versions WHERE item_id = ?', [row.object_id]);
    return !!m && m.id === row.object_version_id;
  }
  if (row.object_type === 'conclusion' || row.object_type === 'adjudication') {
    const later = await q.get("SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND id > ? AND action IN ('conclude', 'for_reference', 'void', 'escalate') LIMIT 1", [row.object_id, row.object_version_id]);
    return !later;
  }
  if (row.object_type === 'dev_entry') {
    // L8：开发方关键事项的认可被否后，PM 可以改登记（出新的登记 revision_of_entry_id）、也可以作废 / 把它办结——这三种都不再待处理
    const re = await q.get('SELECT id FROM sysbuild_entries WHERE revision_of_entry_id = ? LIMIT 1', [row.object_id]);
    if (re) return false;
    const e = await q.get(`SELECT ${entriesCore.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [row.object_id]);
    if (!e) return false;
    const facts = await entriesCore.loadEntryFacts(q, e, { skipChildren: true });
    return !entriesCore.entryResolved(facts.derived); // entryResolved = 已作废 / 有有效结论 / 拆分子项全部已结（单一「已结」口径）
  }
  if (row.object_type === 'handover') return goliveCore.fingerprintIsCurrent(q, row.object_id, row.object_version_id);
  return true;
}

// ── 发送侧 ─────────────────────────────────────────────────────────────────────────────────────────────────────
function createNotifier(opts) {
  for (const k of ['db', 'logger', 'dingtalkNotify', 'getSystemConfig', 'readonlyIds']) {
    if (opts[k] === undefined) throw new Error('routes/sysbuild/notify 缺参数: ' + k);
  }
  if (!(Array.isArray(opts.readonlyIds) || opts.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/notify 参数 readonlyIds 必须是数组或 Set');
  for (const f of ['getAccessToken', 'getUserIdByMobile', 'sendMarkdownToUser', 'classifyError']) {
    if (typeof opts.dingtalkNotify[f] !== 'function') throw new Error('routes/sysbuild/notify 参数 dingtalkNotify 缺方法: ' + f);
  }
  if (typeof opts.getSystemConfig !== 'function') throw new Error('routes/sysbuild/notify 参数 getSystemConfig 必须是函数');
  const { db, logger, dingtalkNotify, getSystemConfig } = opts;
  const accessOpts = () => ({ readonlyIds: opts.readonlyIds });
  const backgroundJobs = opts.backgroundJobs === true;
  // 修订批 2（M1 / M3）：扫描每批条数、补发单次上限可注入（用例里设小值造出「积压超过一批」）；缺省取常量
  const scanBatchCap = Number.isSafeInteger(opts.scanBatchCap) && opts.scanBatchCap > 0 ? opts.scanBatchCap : SCAN_BATCH_CAP;
  const resendBatchCap = Number.isSafeInteger(opts.resendBatchCap) && opts.resendBatchCap > 0 ? opts.resendBatchCap : RESEND_BATCH_CAP;
  const inFlight = {}; // 意图编号 → true：同一进程内正在发送的意图（防重，P156）
  let active = 0; // 已排队 / 在途的发送工作数（dispatch 批次、就绪扫描，以及直接调用的 deliverIntent / resendProject / scan，L1）
  const idleWaiters = [];
  let readyScanned = false;

  function settleIdle() {
    if (active > 0) return;
    while (idleWaiters.length > 0) idleWaiters.shift()();
  }
  function whenIdle() {
    return new Promise((resolve) => {
      if (active === 0) resolve(); else idleWaiters.push(resolve);
    });
  }
  // L1（修订批 2）：统一跟踪在途的发送工作——deliverIntent / resendProject / scan 被直接调用（补发端点、测试、运维脚本）也计入，whenIdle 等到它们结束。
  async function track(fn) {
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      settleIdle();
    }
  }
  const escapeMd = typeof dingtalkNotify.escapeMarkdown === 'function' ? dingtalkNotify.escapeMarkdown : (s) => String(s === null || s === undefined ? '' : s);

  // 配置：凭证三项 + platform_base_url。读取失败 / 缺失一律按 null，由发送流程判「配置缺失」。
  async function readConfig() {
    const out = {};
    for (const [k, key] of [['appKey', 'dingtalk_app_key'], ['appSecret', 'dingtalk_app_secret'], ['robotCode', 'dingtalk_robot_code'], ['baseUrl', 'platform_base_url']]) {
      let v = null;
      try { v = await getSystemConfig(key); } catch (e) { v = null; logger.warn(`[sysbuild] 通知读取配置 ${key} 失败: ${scrub(e && e.message)}`); }
      out[k] = typeof v === 'string' ? v : null;
    }
    return out;
  }

  // 收件人是否「本项目某需求部门的现任负责人」（需求方负责人只给固定文案 + 链接，不带对象摘要，§9.2）
  async function isDemandOwnerUser(q, projectId, userId) {
    const r = await q.get(
      `SELECT a.id AS id FROM sysbuild_appointments a
         JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_parties p ON p.id = a.party_id
        WHERE a.status = 'active' AND p.project_id = ? AND p.side = 'demand' AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL} LIMIT 1`,
      [projectId, userId]
    );
    return !!r;
  }
  async function revisionSummary(q, rev) {
    const entryTitle = async () => {
      const e = await q.get('SELECT title FROM sysbuild_entries WHERE id = ?', [rev.object_id]);
      return e ? e.title : '（登记已不存在）';
    };
    if (rev.object_type === 'package_version') {
      const v = await q.get('SELECT p.type AS type, v.version_no AS version_no FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE v.id = ?', [rev.object_version_id]);
      return v ? `${rules.PACKAGE_TYPE_LABELS[v.type] || v.type}内容包第 ${v.version_no} 版待确认` : '内容包待确认';
    }
    if (rev.object_type === 'item_version') {
      const it = await q.get('SELECT it.code AS code FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?', [rev.object_version_id]);
      return it ? `需求条目 ${it.code} 待您确认` : '需求条目待您确认';
    }
    if (rev.object_type === 'conclusion') return `登记「${await entryTitle()}」的办理结论待确认`;
    if (rev.object_type === 'adjudication') return `登记「${await entryTitle()}」待您裁定`;
    if (rev.object_type === 'dev_entry') return `开发方关键事项「${await entryTitle()}」待认可`;
    if (rev.object_type === 'handover') return `登记「${await entryTitle()}」的上线交接待确认`;
    return '有一项确认任务待处理';
  }
  // 意图引用的业务对象：返回 { skip（无需发送的原因，空 = 要发）, summary, route }。
  //   修订批 1（K1）：**发送前复核收件人此刻仍然有资格收这条通知**（首次发送、补发、就绪扫描都走这里）——意图是业务事务里按「当时」的人写下的，
  //   之后成员被移出、PM 更换、代表人更换、账号停用都会让「当时的收件人」不再适用，这时不外发（跳过：status sent、attempts 不变、last_error「无需发送：…」）。
  //   各用途的复核口径：确认类 = 与站内「待我确认」同一个函数（confirm-core.confirmAvailabilityBlock）+ 必需确认人就是收件人 + 修订仍待确认且是该任务最新修订；
  //   decision_objected = 收件人仍是项目现任 PM + 该修订仍是任务最新修订且异议 / 不认可仍待处理（declinedStillOpen）；schedule_notice = 接收人成员未移出、账号与收件人一致、仍是该参与方现任负责人；
  //   通用 = 账号存在且 active（loadIntentData）。邀请 / 授权仍按被引用对象的状态判。user：收件人账号行（可空，空时由 sendOne 报 no_user）。
  //   修订批 3（预筛 MED-B）：本函数**一律不把账号状态并进判定**（NO_ACCOUNT_STATE：确认类的资格复核、改期知会的「现任负责人」都传 ignoreAccountStatus），先按永久失格条件判跳过；
  //   账号停用是可恢复的，由 loadIntentData 在「没有任何永久失格」之后才记 failed（user_disabled）。返回 { skip（永久失格，无需发送）| fail: { reason, error }（可恢复，记 failed）| 要发 }。
  async function describeRef(q, intent, user) {
    const pid = intent.project_id;
    if (intent.ref_type === REF_TYPES.REVISION) {
      const rev = await q.get(
        `SELECT r.id AS id, r.status AS status, r.rev_no AS rev_no, r.required_member_id AS required_member_id, r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id,
                m.user_id AS required_user_id, t.project_id AS project_id, t.object_type AS object_type, t.object_id AS object_id, t.object_version_id AS object_version_id, t.purpose AS purpose,
                (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = r.task_id) AS latest_rev_no
           FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id LEFT JOIN sysbuild_members m ON m.id = r.required_member_id WHERE r.id = ?`,
        [intent.ref_id]
      );
      if (!rev) return { skip: '修订已不存在', summary: '', route: ROUTES.project(pid) };
      const skipWith = (why) => ({ skip: why, summary: '', route: ROUTES.confirm(pid, rev.id) });
      if (intent.purpose === PURPOSES.CONFIRM_REQUEST || intent.purpose === PURPOSES.CONFIRM_REISSUE) {
        if (rev.status !== 'pending') return skipWith('修订已不是待确认');
        if (rev.rev_no !== rev.latest_rev_no) return skipWith('修订已被改发（不是该任务的最新修订）');
        if (rev.required_user_id === null || rev.required_user_id === undefined || Number(rev.required_user_id) !== Number(intent.recipient_user_id)) return skipWith('收件人已不是该修订的必需确认人');
        if (user) {
          const block = await core.confirmAvailabilityBlock(q, rev, user, accessOpts(), {}, NO_ACCOUNT_STATE);
          if (block !== null) return skipWith(`收件人此刻不能作出确认：${block}`);
        }
      } else if (intent.purpose === PURPOSES.DECISION_OBJECTED) {
        const proj = await q.get('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid]);
        if (!proj || proj.pm_user_id === null || proj.pm_user_id === undefined || Number(proj.pm_user_id) !== Number(intent.recipient_user_id)) return skipWith('收件人已不是本项目现任项目经理');
        if (rev.rev_no !== rev.latest_rev_no) return skipWith('该确认已改发（不是该任务的最新修订）');
        if (!(await declinedStillOpen(q, rev))) return skipWith('该确认的异议 / 不认可已处理（已改发或已出新版本）');
      }
      const base = await revisionSummary(q, rev);
      return { skip: '', summary: intent.purpose === PURPOSES.DECISION_OBJECTED ? `有确认被提出异议或不认可：${base}` : base, route: ROUTES.confirm(pid, rev.id) };
    }
    if (intent.ref_type === REF_TYPES.INVITATION) {
      // M2（修订批 2）：邀请发送前复核——邀请仍待处理、被邀请成员行的账号就是收件人且未移出（加入邀请允许尚未加入）、项目未终止、
      //   收件人此刻对这条邀请「可操作」（接受或拒绝，membership.invitationActionsOf，与 GET /my/invitations 的 actions、待办 accept 类同一个函数）。
      //   成员移出 / 换负责人本身会级联撤回待处理的邀请与授权（membership.cascadeMemberRemoval / endAppointment），这里是纵深防御：级联漏掉的、或收件人账号与意图不符的也不外发。
      const inv = await q.get(`${membership.INVITATION_SELECT} WHERE i.id = ?`, [intent.ref_id]);
      if (!inv) return { skip: '邀请已不存在', summary: '', route: ROUTES.project(pid) };
      const skipWith = (why) => ({ skip: why, summary: '', route: ROUTES.invitation(pid, inv.id) });
      if (inv.status !== 'pending') return skipWith('邀请已处理');
      if (inv.user_id === null || inv.user_id === undefined || Number(inv.user_id) !== Number(intent.recipient_user_id)) return skipWith('被邀请人的账号与邀请不符');
      if (inv.removed_at !== null) return skipWith('被邀请人已被移出本项目');
      if (inv.project_status === 'terminated') {
        // P187（修订批 3）：项目终止是可恢复的（管理员可以重开），待处理的邀请重开后仍有效——记 failed（可恢复，重开后补发 / 扫描能送出），不记「无需发送」终态。
        //   但终止之外的永久失格仍要先排除：把项目状态换成 active 再问一次「可操作」，仍不可操作 = 终止之外另有原因（邀请人失权、任职已变等）→ 跳过。
        if (user) {
          const act = await membership.invitationActionsOf(q, user, Object.assign({}, inv, { project_status: 'active' }), accessOpts());
          if (!act.accept && !act.decline) return skipWith('收件人此刻不能处理这条邀请');
        }
        return { fail: PROJECT_TERMINATED_FAIL, summary: '', route: ROUTES.invitation(pid, inv.id) };
      }
      if (user) {
        const act = await membership.invitationActionsOf(q, user, inv, accessOpts());
        if (!act.accept && !act.decline) return skipWith('收件人此刻不能处理这条邀请');
      }
      return { skip: '', summary: inv.kind === 'join' ? '邀请您加入本项目' : '提议您担任参与方负责人', route: ROUTES.invitation(pid, inv.id) };
    }
    if (intent.ref_type === REF_TYPES.DELEGATION) {
      const d = await q.get(`${membership.DELEGATION_ITEM_SELECT} WHERE d.id = ?`, [intent.ref_id]);
      if (!d) return { skip: '授权已不存在', summary: '', route: ROUTES.project(pid) };
      const skipWith = (why) => ({ skip: why, summary: '', route: ROUTES.delegation(pid, d.id) });
      if (d.status !== 'pending_accept') return skipWith('授权已不在待接受状态');
      if (d.user_id === null || d.user_id === undefined || Number(d.user_id) !== Number(intent.recipient_user_id)) return skipWith('被授权人的账号与授权不符');
      if (d.removed_at !== null) return skipWith('被授权人已被移出本项目');
      if (d.project_status === 'terminated') {
        if (user) {
          const act = await membership.delegationActionsOf(q, user, Object.assign({}, d, { project_status: 'active' }), accessOpts());
          if (!act.accept && !act.decline) return skipWith('收件人此刻不能处理这条授权');
        }
        return { fail: PROJECT_TERMINATED_FAIL, summary: '', route: ROUTES.delegation(pid, d.id) };
      }
      if (user) {
        const act = await membership.delegationActionsOf(q, user, d, accessOpts());
        if (!act.accept && !act.decline) return skipWith('收件人此刻不能处理这条授权');
      }
      return { skip: '', summary: '授权您担任参与方代表人，等待您接受', route: ROUTES.delegation(pid, d.id) };
    }
    if (intent.ref_type === REF_TYPES.NOTICE) {
      const n = await q.get('SELECT id, kind, recipient_member_id FROM sysbuild_notices WHERE id = ?', [intent.ref_id]);
      if (!n) return { skip: '知会已不存在', summary: '', route: ROUTES.project(pid) };
      if (intent.purpose === PURPOSES.SCHEDULE_NOTICE) {
        // K1：改期知会只发给「此刻仍是该参与方现任负责人」的接收人本人（与知会异议资格同一份事实 notify-schedule.scheduleNoticeObjectorFacts）
        const skipWith = (why) => ({ skip: why, summary: '', route: ROUTES.notice(pid, n.id) });
        const mem = await q.get('SELECT removed_at, joined_at FROM sysbuild_members WHERE id = ?', [n.recipient_member_id]);
        if (!mem || mem.removed_at !== null || mem.joined_at === null) return skipWith('接收人已不是本项目成员');
        const facts = await notifySchedule.scheduleNoticeObjectorFacts(q, n, NO_ACCOUNT_STATE);
        if (facts.recipientUserId === null || facts.recipientUserId !== Number(intent.recipient_user_id)) return skipWith('接收人账号与知会不符');
        if (!facts.stillOwner) return skipWith('接收人已不是该参与方的现任负责人');
      }
      return { skip: '', summary: '正式上线里程碑的计划日期推后，请查看改期知会', route: ROUTES.notice(pid, n.id) };
    }
    return { skip: '', summary: '', route: ROUTES.project(pid) };
  }
  async function loadIntentData(q, id) {
    const intent = await q.get('SELECT id, project_id, purpose, ref_type, ref_id, recipient_user_id, channel, status, attempts FROM sysbuild_send_intents WHERE id = ?', [id]);
    if (!intent) return null;
    const user = await q.get('SELECT id, role, status, phone, dingtalk_user_id FROM users WHERE id = ?', [intent.recipient_user_id]);
    const project = await q.get('SELECT id, system_name FROM sysbuild_projects WHERE id = ?', [intent.project_id]);
    // K1 通用：收件人账号已停用（status 不是 active）→ 不外发。P186（修订批 2）：账号停用是可恢复的条件，记 failed（可被补发 / 扫描在账号恢复后重试），不记「无需发送」终态。
    //   修订批 3（预筛 MED-B）：先按与账号状态无关的条件复核（describeRef，永久失格 → skip），全部满足、**只是**账号停用才记 failed：
    //   否则「停用 + 已移出 / 已确认 / 已改发 / 前任 PM / 知会接收人移出」会被记成可恢复的失败，账号一恢复就外发过期通知（探针 probe_disabled_combo X1–X5）。
    //   可恢复的失败共两种：账号停用（user_disabled）、项目已终止的邀请 / 授权（project_terminated，P187，describeRef 返回 fail）；同时出现时取 describeRef 的（项目终止）。
    const disabled = !!user && user.status !== 'active';
    const ref = await describeRef(q, intent, user || null);
    let failWith = null;
    if (!ref.skip) {
      if (ref.fail) failWith = ref.fail;
      else if (disabled) failWith = { reason: 'user_disabled', error: '收件人账号已停用，暂时无法发送（账号恢复后补发 / 扫描会再试）' };
    }
    return {
      intent, user: user || null, systemName: project ? project.system_name : '',
      failWith, skip: ref.skip || '', summary: ref.summary, route: ref.route,
      ownerRecipient: await isDemandOwnerUser(q, intent.project_id, intent.recipient_user_id),
    };
  }

  // 消息：markdown 标题 + 一句摘要 + 「打开确认」链接（platform_base_url + 页面路由）；收件人是需求部门负责人时只给固定文案 + 链接（§9.2）。
  function buildMessage(data, baseUrl) {
    const link = `${baseUrl}${data.route}`;
    if (data.ownerRecipient && data.intent.purpose === PURPOSES.SCHEDULE_NOTICE) {
      // L7：改期知会的收件人是需求部门现任负责人，只给固定文案 + 链接；用知会口吻，与「有事项需要您处理」的确认类固定文案区分
      return { title: NOTICE_OWNER_TITLE, text: `### ${NOTICE_OWNER_TITLE}\n\n${NOTICE_OWNER_TEXT}\n\n[${NOTICE_LINK_LABEL}](${link})`, link };
    }
    if (data.ownerRecipient) {
      return { title: OWNER_TITLE, text: `### ${OWNER_TITLE}\n\n${OWNER_TEXT}\n\n[${LINK_LABEL}](${link})`, link };
    }
    const title = `【系统建设记录】${KIND_TITLES[data.intent.purpose] || '通知'}`;
    return { title, text: `### ${title}\n\n**项目**：${escapeMd(data.systemName)}\n\n${escapeMd(data.summary)}\n\n[${LINK_LABEL}](${link})`, link };
  }

  const fail = (reason, error, extra) => Object.assign({ outcome: 'failed', reason, error }, extra || {});
  // 复核结论（首次加载与外发前复核共用）：永久失格 → 跳过（status sent、attempts 不变）；可恢复（账号停用 / 项目已终止的邀请与授权）→ failed；都不是 → null（可以发）。顺序即优先级：永久失格盖过可恢复。
  const verdictOf = (data) => {
    if (data.skip) return { outcome: 'skipped', reason: data.skip };
    if (data.failWith) return fail(data.failWith.reason, data.failWith.error);
    return null;
  };
  // 发送一条（不抛错；失败以返回值表达）。凭证 / 令牌只在这个函数的局部变量里。
  async function sendOne(data) {
    const trail = [];
    const r = await sendOneInner(data, trail);
    r.channelResults = trail; // M4：本次 deliverIntent 内每次实际渠道调用的脱敏结果（attempts 口径：一次 deliverIntent 计 1 次，子尝试只记在这里）
    return r;
  }
  async function sendOneInner(data, trail) {
    const cfg = await readConfig();
    if (!cfg.appKey || !cfg.appSecret || !cfg.robotCode) return fail('no_config', '钉钉配置缺失（凭证未填写）', { systemic: true });
    const secrets = [cfg.appKey, cfg.appSecret, cfg.robotCode];
    const classify = (x) => {
      try { return dingtalkNotify.classifyError(x) || {}; } catch (e) { return {}; }
    };
    const why = (stage, c, e) => `${stage}:${c.reason || 'error'}${c.errcode !== undefined ? ` errcode=${c.errcode}` : ''}${c.hint ? `：${c.hint}` : (e && e.message ? `：${e.message}` : '')}`;
    if (!data.user) return fail('no_user', '收件人账号不存在');
    let token;
    try {
      token = await dingtalkNotify.getAccessToken(cfg.appKey, cfg.appSecret);
    } catch (e) {
      const c = classify(e);
      return fail(`gettoken_${c.reason || 'error'}`, scrub(why('gettoken', c, e), secrets), { errcode: c.errcode, systemic: true }); // L4：取令牌失败 = 凭证 / 网络问题，换哪个收件人都一样
    }
    secrets.push(token);
    // O1（修订批 4 / codex 28-R2）：收件人的钉钉地址 = 账号上的钉钉号，缺失时按手机号反查。解析地址所依据的输入（addrKeyOf：有钉钉号看钉钉号，没有看手机号）记下来，
    //   外发前复核时与最新账号行比较，变了就重新解析（resolveAddress）。返回 { dingUserId } 或失败结果（带 outcome）。只在内存里用，不回写 users 表（P155：sysbuild 是独立连接，不跨模块写平台表）。
    const addrKeyOf = (u) => {
      const d = trimText(u && u.dingtalk_user_id);
      return d ? `d:${d}` : `p:${trimText(u && u.phone)}`;
    };
    const resolveAddress = async (u, tok) => {
      const direct = trimText(u.dingtalk_user_id);
      if (direct) return { dingUserId: direct };
      const phone = trimText(u.phone);
      if (!phone) return fail('no_dingtalk_id', '收件人没有钉钉号，也没有手机号可反查');
      let looked;
      try {
        looked = trimText(await dingtalkNotify.getUserIdByMobile(tok, phone));
      } catch (e) {
        const c = classify(e);
        return fail(`get_by_mobile_${c.reason || 'error'}`, scrub(why('get_by_mobile', c, e), secrets.concat([phone])), { errcode: c.errcode, systemic: isSystemicReason(c.reason) });
      }
      if (!looked) return fail('no_dingtalk_id', '手机号反查没有得到钉钉号');
      return { dingUserId: looked };
    };
    let usedAddrKey = addrKeyOf(data.user);
    const addr0 = await resolveAddress(data.user, token);
    if (addr0.outcome) return addr0;
    let dingUserId = addr0.dingUserId;
    const baseUrl = normalizeBaseUrl(cfg.baseUrl);
    if (baseUrl === '') logger.warn(`[sysbuild] 发送意图 #${data.intent.id}：platform_base_url 缺失或不合法，链接退化为相对路径（不算发送失败）`);
    // N3（修订批 3 / codex N3）：取令牌、手机号反查都可能耗时，收件人资格可能在这期间变化——**每次实际调用钉钉发送前**（这里，以及令牌刷新后的重试之前）按同一套顺序重新复核一次：
    //   与账号状态无关的条件先判（永久失格 → 跳过），都满足、只是账号停用 / 项目已终止 → failed；复核结果用来重算消息（「需求部门负责人只给链接」的限制随当时的身份变化）。
    let cur = data;
    const recheck = async () => {
      const fresh = await db.withRead((q) => loadIntentData(q, data.intent.id));
      if (!fresh) return { outcome: 'skipped', reason: '意图已不存在' };
      if (fresh.intent.status !== data.intent.status) return { outcome: 'skipped', reason: '意图状态已被其他处理改变' }; // 条件更新随后会判 conflict，不会覆盖别处的结果
      // O1（修订批 4）：账号行在取令牌 / 反查期间被删除 → 不外发（永久失格，跳过）。放在判定之前：没有账号行，后面按账号做的复核都做不全。
      if (!fresh.user) return { outcome: 'skipped', reason: '收件人账号已不存在' };
      const v = verdictOf(fresh);
      if (v) return v;
      cur = Object.assign({}, data, { user: fresh.user, summary: fresh.summary, route: fresh.route, ownerRecipient: fresh.ownerRecipient, systemName: fresh.systemName });
      return null;
    };
    // O1：复核之后再核最新账号行上的钉钉地址——解析地址所依据的输入（钉钉号 / 反查用的手机号）与此刻的账号行不一致，就按最新账号行重新解析（取令牌 / 刷新令牌 / 反查期间账号被更正的情形），
    //   然后**再复核一次**（重新解析本身也要时间）；重新解析失败按现有失败路径返回，不外发。地址一直在变（有界重复 3 轮仍不稳定）→ failed（可恢复），不外发。tok：重新解析时反查手机号用的令牌。
    const settle = async (tok) => {
      for (let round = 0; round < 3; round += 1) {
        const v = await recheck();
        if (v) return v;
        const key = addrKeyOf(cur.user);
        if (key === usedAddrKey) return null;
        const re = await resolveAddress(cur.user, tok);
        if (re.outcome) return re;
        dingUserId = re.dingUserId;
        usedAddrKey = key;
      }
      return fail('recipient_changing', '收件人的钉钉账号信息在发送前持续变化，本次未发送（稍后补发 / 扫描会再试）');
    };
    const verdict1 = await settle(token);
    if (verdict1) return verdict1;
    let msg = buildMessage(cur, baseUrl);
    let res;
    const attempt = async (useToken) => dingtalkNotify.sendMarkdownToUser(useToken, cfg.robotCode, [dingUserId], msg.title, msg.text);
    // N2：渠道响应判定（模块级 judgeChannelResponse）——逐次留痕与最终结果共用
    const judge = (x) => judgeChannelResponse(x, { classify, errorText: (c) => scrub(why('send', c, null), secrets.concat([dingUserId])), dingUserId });
    // M4（修订批 2）：每次实际的渠道调用（首次发送、令牌失效后的刷新令牌与重发）各留一条脱敏结果，由 sendOne 的包装带回、recordResult 写进事件的 response.channel_results。
    //   修订批 3（N2）：渠道返回后**先判定再追加**该次结果（软失败名单、机器人错误、空响应都记 failed，与最终结果一致）；调用抛错的另走 noteThrown。
    const noteJudged = (stage, x, j) => {
      trail.push({ stage, outcome: j.ok ? 'ok' : 'failed', reason: j.reason, errcode: j.errcode, process_query_key: j.ok ? scrub(String(x.processQueryKey), secrets) : null });
    };
    const noteThrown = (stage, err) => {
      const c = classify(err);
      trail.push({ stage, outcome: 'failed', reason: c.reason || 'error', errcode: c.errcode === undefined ? null : c.errcode, process_query_key: null });
    };
    try {
      res = await attempt(token);
    } catch (e) {
      noteThrown('send', e);
      const c = classify(e);
      return fail(`send_${c.reason || 'error'}`, scrub(why('send', c, e), secrets.concat([dingUserId])), { errcode: c.errcode, systemic: isSystemicReason(c.reason) });
    }
    let j = judge(res);
    noteJudged('send', res, j);
    if (!j.ok && j.tokenExpired) {
      // 令牌失效：清缓存取新令牌重发一次（对齐平台 sendCollabDingtalkRaw）
      let fresh;
      try {
        if (typeof dingtalkNotify.clearCachedToken === 'function') dingtalkNotify.clearCachedToken();
        fresh = await dingtalkNotify.getAccessToken(cfg.appKey, cfg.appSecret);
      } catch (e) {
        noteThrown('refresh_token', e);
        const c2 = classify(e);
        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: isSystemicReason(c2.reason) });
      }
      secrets.push(fresh);
      const verdict2 = await settle(fresh); // N3：刷新令牌期间收件人可能被移出 / 停用——重试前再复核，不发第二次；O1：期间钉钉号被更正的，重试发到最新地址
      if (verdict2) return verdict2;
      msg = buildMessage(cur, baseUrl);
      try {
        res = await attempt(fresh);
      } catch (e) {
        noteThrown('retry', e);
        const c2 = classify(e);
        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: isSystemicReason(c2.reason) });
      }
      j = judge(res);
      noteJudged('retry', res, j);
    }
    if (!j.ok) return fail(j.failReason, j.error, { errcode: j.errcode, systemic: j.systemic });
    // K3：成功时带回渠道返回的消息标识（processQueryKey），由 recordResult 写进事件 response 与 notice_attempts.response_code
    return { outcome: 'sent', reason: 'ok', error: null, link: msg.link, queryKey: scrub(String(res.processQueryKey), secrets) };
  }

  // 记结果：条件更新（WHERE 带旧状态）+ 一条 send_intent_attempted 事件（渠道返回摘要）+ 改期知会另记 sysbuild_notice_attempts。返回对外结果。
  async function recordResult(data, r, o) {
    const intent = data.intent;
    const op = (o && o.operator) || SYSTEM_OPERATOR;
    return db.withWriteTxn(async (q) => {
      let up;
      let toStatus;
      let attemptsAfter = intent.attempts;
      let lastError;
      if (r.outcome === 'sent') {
        toStatus = 'sent'; attemptsAfter = intent.attempts + 1; lastError = null;
        up = await q.run("UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?", [toStatus, lastError, intent.id, intent.status]);
      } else if (r.outcome === 'failed') {
        toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = r.error;
        up = await q.run("UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?", [toStatus, lastError, intent.id, intent.status]);
      } else {
        toStatus = 'sent'; lastError = `无需发送：${r.reason}`;
        up = await q.run("UPDATE sysbuild_send_intents SET status = ?, last_error = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?", [toStatus, lastError, intent.id, intent.status]);
      }
      if (up.changes === 0) return { id: intent.id, outcome: 'conflict' };
      await writeEvent(q, {
        projectId: intent.project_id, objectType: 'send_intent', objectId: intent.id, eventType: 'send_intent_attempted',
        payload: {
          intent_id: intent.id, purpose: intent.purpose, ref_type: intent.ref_type, ref_id: intent.ref_id, recipient_user_id: intent.recipient_user_id, channel: intent.channel,
          outcome: r.outcome, from_status: intent.status, to_status: toStatus, attempts_after: attemptsAfter, via: (o && o.via) || 'auto',
          response: r.outcome === 'skipped' ? Object.assign({ skipped: r.reason }, Array.isArray(r.channelResults) && r.channelResults.length > 0 ? { channel_results: r.channelResults } : {}) : { reason: r.reason, errcode: r.errcode === undefined ? null : r.errcode, error: lastError, process_query_key: r.outcome === 'sent' && r.queryKey ? r.queryKey : null, channel_results: Array.isArray(r.channelResults) ? r.channelResults : [] },
        },
        operatorId: Number(op.id), operatorName: operatorNameOf(op),
      });
      if (intent.purpose === PURPOSES.SCHEDULE_NOTICE && r.outcome !== 'skipped') {
        await q.run("INSERT INTO sysbuild_notice_attempts (notice_id, channel, result, response_code) VALUES (?, 'dingtalk', ?, ?)", [intent.ref_id, r.outcome, r.outcome === 'sent' ? (r.queryKey || 'ok') : scrub(r.reason)]); // K3：成功记渠道返回的 processQueryKey，取不到写 'ok'
      }
      return { id: intent.id, outcome: r.outcome, reason: r.reason, attempts: attemptsAfter, systemic: r.systemic === true };
    });
  }

  // 发送一条意图。o：{ operator?, via? }。绝不抛错（异常也以 outcome = 'error' 返回并写日志）。
  function deliverIntent(id, o) {
    return track(async () => {
      if (inFlight[id] === true) return { id, outcome: 'in_flight' };
      inFlight[id] = true;
      try {
        const data = await db.withRead((q) => loadIntentData(q, id));
        if (!data) return { id, outcome: 'gone' };
        if (data.intent.status === 'sent') return { id, outcome: 'already_sent' };
        const r = verdictOf(data) || await sendOne(data);
        return await recordResult(data, r, o);
      } catch (e) {
        logger.error(`[sysbuild] 发送意图 #${id} 处理异常: ${scrub(e && e.message)}`);
        return { id, outcome: 'error', message: scrub(e && e.message) };
      } finally {
        delete inFlight[id];
      }
    });
  }
  // 事务提交后在事务外发送本事务写下的意图：不阻塞响应（setImmediate），一条一条发。
  function dispatch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    active += 1;
    setImmediate(async () => {
      try {
        for (const id of ids) await deliverIntent(id, { via: 'auto' });
      } catch (e) {
        logger.error(`[sysbuild] 通知派发异常: ${scrub(e && e.message)}`);
      } finally {
        active -= 1;
        settleIdle();
      }
    });
  }
  // 包装 db：withWriteTxn 的回调 q 上挂本事务的意图清单；回调正常返回、事务提交成功之后才派发。
  function wrapDb(inner) {
    return Object.assign({}, inner, {
      withWriteTxn: async (fn) => {
        const ids = [];
        const out = await inner.withWriteTxn((q) => { q.sendIntentIds = ids; return fn(q); });
        dispatch(ids.slice());
        return out;
      },
    });
  }

  const tally = (results) => {
    const t = { total: results.length, sent: 0, failed: 0, skipped: 0, other: 0 };
    for (const r of results) {
      if (r.outcome === 'sent') t.sent += 1;
      else if (r.outcome === 'failed') t.failed += 1;
      else if (r.outcome === 'skipped') t.skipped += 1;
      else t.other += 1;
    }
    return t;
  };
  // PM 补发：本项目 status = failed 的全部，以及 pending 且创建超过 5 分钟的（覆盖「提交后、发送前进程退出」）。
  function resendProject(projectId, user) {
    return track(async () => {
      // M3（修订批 2）：同一读快照里取候选条数（rows）与候选总数（total），remaining = 总数 - 本次已处理；中止时同样按总数算（不再用 rows.length 低报）
      const snap = await db.withRead(async (q) => {
        const where = `project_id = ? AND (status = 'failed' OR (status = 'pending' AND created_at <= datetime('now','localtime', ?)))`;
        const args = [projectId, `-${notifyCore.RESEND_PENDING_MINUTES} minutes`];
        // N1（修订批 3 / codex N1）：候选按「最近尝试时间升序」取——从未尝试的（attempts = 0）最先，其余按 updated_at（每次尝试都会刷新）从旧到新，刚失败的自然排后；
        //   updated_at 只到秒，同一秒内的再按 attempts 少的在前、最后按 id。这样上限小于候选数、前几条又持续因个人原因失败时，尾部有效意图也会在后续几次补发里轮到（不再永远卡在前 N 条）。remaining 口径不变。
        const rows = await q.all(`SELECT id FROM sysbuild_send_intents WHERE ${where} ORDER BY (attempts > 0), updated_at, attempts, id LIMIT ?`, args.concat([resendBatchCap]));
        const tot = await q.get(`SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE ${where}`, args);
        return { rows, total: tot ? Number(tot.n) : rows.length };
      });
      const results = [];
      // L4：遇到第一个「系统性」失败（取令牌 / 配置缺失 / 网络类 / 限流 / 应用无权限 / 机器人编码无效）就中止本批——后面的收件人会遇到同样的问题，继续发只会白白多记一轮失败和 attempts；剩余的计入 remaining，下次补发再处理。
      let aborted = null;
      for (const r of snap.rows) {
        const x = await deliverIntent(r.id, { operator: user, via: 'resend' });
        results.push(x);
        if (x.outcome === 'failed' && x.systemic === true) { aborted = { intent_id: x.id, reason: x.reason }; break; }
      }
      const counts = tally(results);
      counts.remaining = snap.total - results.length;
      return { counts, results, aborted };
    });
  }
  // 模块就绪时扫描：pending 与 failed 且 attempts < 3 的意图（所有项目）。返回各条结果计数。
  //   M1（修订批 2）：按 id 游标分批（每批 ≤ scanBatchCap），直到本轮候选处理完；批间 setImmediate 让出事件循环；游标只前进，所以本轮内失败的意图不会被重复重试（下一轮扫描 / 补发再处理）。
  //   修订批 3（预筛 LOW-1）：与补发同一规则——遇到第一个系统性失败（取令牌 / 配置缺失 / 网络类 / 限流 / 应用无权限 / 机器人编码无效）就停止本轮，返回 aborted；后面的收件人会遇到同样的问题，继续扫只会白白多记一轮失败和 attempts（下一轮扫描 / PM 补发再处理）。
  function scan() {
    return track(async () => {
      const results = [];
      let cursor = 0;
      let aborted = null;
      for (;;) {
        const rows = await db.withRead((q) => q.all(
          "SELECT id FROM sysbuild_send_intents WHERE id > ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?)) ORDER BY id LIMIT ?",
          [cursor, notifyCore.SCAN_MAX_ATTEMPTS, scanBatchCap]
        ));
        if (rows.length === 0) break;
        for (const r of rows) {
          const x = await deliverIntent(r.id, { via: 'scan' });
          results.push(x);
          if (x.outcome === 'failed' && x.systemic === true) { aborted = { intent_id: x.id, reason: x.reason }; break; }
        }
        if (aborted !== null) break;
        cursor = rows[rows.length - 1].id;
        if (rows.length < scanBatchCap) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return Object.assign(tally(results), { results, aborted });
    });
  }
  // 模块就绪（initSchema 成功）后调用一次：后台任务开关为 on 才扫描；隔离实例默认 off，不扫（P157）。
  function onReady() {
    if (!backgroundJobs || readyScanned) return false;
    readyScanned = true;
    active += 1;
    setImmediate(async () => {
      try {
        const done = await scan();
        if (done.aborted) logger.warn(`[sysbuild] 就绪扫描发送意图遇到系统性失败，本轮中止（意图 #${done.aborted.intent_id}：${scrub(done.aborted.reason)}）`);
      } catch (e) { logger.error(`[sysbuild] 就绪扫描发送意图失败: ${scrub(e && e.message)}`); } finally { active -= 1; settleIdle(); }
    });
    return true;
  }

  return { wrapDb, dispatch, deliverIntent, resendProject, scan, onReady, whenIdle, _internals: { buildMessage, normalizeBaseUrl, scrub, inFlightCount: () => Object.keys(inFlight).length } };
}

// ── 端点：PM 补发 / 发送意图列表 / 我的待办 ─────────────────────────────────────────────────────────────────────
function createNotifyRoutes(ctx) {
  for (const k of ['db', 'logger', 'notifier', 'myConfirmationItems', 'myNoticeItems', 'myInvitationItems']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/notify 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/notify 参数 readonlyIds 必须是数组或 Set');
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/notify 参数 writeRoles 必须是数组或 Set');
  const { db, logger, notifier } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 通知 / 待办接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  function bodyOf(req) {
    const b = req.body;
    if (b === undefined || b === null) return {};
    if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
    return b;
  }
  // 项目可见（非成员 404）→ 本人是 PM 且非只读账号（否则 403；admin 要接管成为 PM 后才行）。补发 / 列表不核项目状态：补发不改业务，四种项目状态都可。
  async function loadPmAccess(q, pid, user) {
    const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
    rules.assertVisible(access);
    if (!rules.canActAsPm(access)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');
    return access;
  }

  // ── GET /sysbuild/projects/:id/send-intents?status=：本项目的发送意图（PM；不含手机号 / 钉钉号等敏感字段）──
  router.get('/sysbuild/projects/:id/send-intents', handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const qs = req.query || {};
    let status = null;
    if (qs.status !== undefined && qs.status !== '') {
      if (typeof qs.status !== 'string' || !INTENT_STATUSES.includes(qs.status)) throw invalid(`status 必须是 ${INTENT_STATUSES.join(' / ')} 之一`, 'status');
      status = qs.status;
    }
    const out = await db.withRead(async (q) => {
      await loadPmAccess(q, pid, req.user);
      const rows = await q.all(
        `SELECT i.id AS id, i.purpose AS purpose, i.ref_type AS ref_type, i.ref_id AS ref_id, i.recipient_user_id AS recipient_user_id, COALESCE(u.display_name, u.username) AS recipient_name,
                i.channel AS channel, i.status AS status, i.attempts AS attempts, i.last_error AS last_error, i.created_at AS created_at, i.updated_at AS updated_at
           FROM sysbuild_send_intents i LEFT JOIN users u ON u.id = i.recipient_user_id
          WHERE i.project_id = ? AND (? IS NULL OR i.status = ?) ORDER BY i.id DESC`,
        [pid, status, status]
      );
      return { project_id: pid, items: rows, failed_count: await notifyCore.failedIntentCount(q, pid), needs_offline_count: await notifyCore.needsOfflineCount(q, pid), offline_items: await notifyCore.needsOfflineItems(q, pid), actions: { resend: true } };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/send-intents/resend：PM 补发（失败的 + 创建超过 5 分钟仍 pending 的）──
  router.post('/sysbuild/projects/:id/send-intents/resend', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    for (const k of Object.keys(bodyOf(req))) throw invalid(`不支持的字段 ${k}`, k);
    const user = req.user;
    await db.withRead((q) => loadPmAccess(q, pid, user));
    const done = await notifier.resendProject(pid, user);
    await db.withWriteTxn((q) => writeEvent(q, {
      projectId: pid, objectType: 'project', objectId: pid, eventType: 'send_intents_resent', payload: { counts: done.counts, intent_ids: done.results.map((r) => r.id), aborted: done.aborted },
      operatorId: Number(user.id), operatorName: operatorNameOf(user),
    }));
    res.json({ project_id: pid, counts: done.counts, aborted: done.aborted, results: done.results.map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason === undefined ? null : r.reason })) });
  }));

  // ── GET /sysbuild/my/todo：我的待办（全部从现有数据派生，不建通知表，§9.1）──────────────────────────────────
  //   返回 { counts, items }，items 是 { 类别: [...] }（每类最多 TODO_ITEM_CAP 条，counts 是全量）。类别与数据源：
  //   confirm = myConfirmationItems（与 GET /my/confirmations 同源，计数即顶部角标）；handle（PM 所担任项目）= 未办结的办理类登记（含补充登记）+ 被有异议 / 不认可且 PM 尚未改发或出新版本的修订；
  //   routing = 待判定的登记（PM 看所担任项目的全部，其他成员只看本人登记的，与 entries ?routing=pending 同口径）；notice = myNoticeItems 里 actions.object 为真（仍可提异议）的知会（P182）；
  //   accept = 待我接受的邀请与授权（myInvitationItems，与 GET /my/invitations 同源，P183），counts.badge = confirm + accept；
  //   objection（PM）= 改期知会异议（转 PM）；send_failed（PM）= 补发能处理的发送失败（失败的意图 / 待发送超时的 pending）；needs_offline（PM，P188）= 须线下通知的（无账号负责人的改期知会，补发处理不了，与项目视图同口径）；overdue（PM，P154）= 所担任项目内创建超过 OVERDUE_DAYS 天仍待确认的修订。
  //   已终止 / 已结项的项目：confirm 照「待我确认」现有过滤（C4a / C5 P81 口径）；其余类别不按项目状态过滤。读接口不写浏览记录。
  //   修订批 1：handle 类的「未办结登记」取数是 entries-core.unresolvedProcessEntriesOf(q, pid, { anyPeriod: true, rows: true })（L9：与节点收口前置共用同一个循环体，不复制）；
  //   declinedStillOpen 在本文件顶部（模块级），发送侧复核 decision_objected 也调它。
  router.get('/sysbuild/my/todo', handle(async (req, res) => {
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withRead(async (q) => {
      const cap = (arr) => arr.slice(0, TODO_ITEM_CAP);
      const items = { confirm: [], accept: [], handle: [], routing: [], notice: [], objection: [], send_failed: [], needs_offline: [], overdue: [] };
      const counts = { confirm: 0, accept: 0, handle: 0, routing: 0, notice: 0, objection: 0, send_failed: 0, needs_offline: 0, overdue: 0 };

      const confirms = await ctx.myConfirmationItems(q, user);
      counts.confirm = confirms.length;
      items.confirm = cap(confirms);

      // P183：accept = 待我接受的邀请与授权（GET /my/invitations 同源 myInvitationItems）；顶部角标 counts.badge = confirm + accept
      const inv = await ctx.myInvitationItems(q, user);
      //   kind = invitation / delegation（邀请视图自带的 kind = join / appointment 改放 invitation_kind，免得被覆盖）
      //   P185（修订批 2）：只计「此刻可操作」的（actions.accept 或 actions.decline 为真，与 GET /my/invitations 每条的 actions 同一个判定）——已终止项目里待处理的邀请 / 授权、邀请人失权后接受不了也拒绝不了的等不进待办和角标
      const actionable = (i) => !!i.actions && (i.actions.accept === true || i.actions.decline === true);
      const accepts = inv.invitations.filter(actionable).map((i) => Object.assign({}, i, { kind: 'invitation', invitation_kind: i.kind })).concat(inv.delegations.filter(actionable).map((d) => Object.assign({}, d, { kind: 'delegation' })));
      counts.accept = accepts.length;
      items.accept = cap(accepts);

      // P182：notice 只列「仍可提异议」的知会（actions.object === true，与 GET /my/notices 每条的 actions.object 同一个判定）——不再列已不能异议、或没有处理手段的知会
      const notices = (await ctx.myNoticeItems(q, user)).filter((i) => i.actions && i.actions.object === true);
      counts.notice = notices.length;
      items.notice = cap(notices);

      // 我所担任 PM 的项目（含各状态）；非只读限制只作用于写，这里是读
      //   项目按编号从新到旧（每类超过 50 条时，截断保留较新项目的条目；counts 仍是全量）
      const pmProjects = await q.all('SELECT id, system_name, status FROM sysbuild_projects WHERE pm_user_id = ? ORDER BY id DESC', [uid]);
      const handle = [];
      const objection = [];
      const sendFailed = [];
      const needsOffline = [];
      const overdue = [];
      for (const p of pmProjects) {
        for (const e of await entriesCore.unresolvedProcessEntriesOf(q, p.id, { anyPeriod: true, rows: true })) {
          handle.push({ kind: 'entry_unresolved', project_id: p.id, system_name: p.system_name, entry_id: e.id, title: e.title, node_id: e.node_id, created_at: e.created_at });
        }
        const declined = await q.all(
          `SELECT r.id AS revision_id, r.status AS status, r.updated_at AS decided_at, t.id AS task_id, t.object_type AS object_type, t.object_id AS object_id, t.object_version_id AS object_version_id, t.purpose AS purpose
             FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
            WHERE t.project_id = ? AND r.status IN ('objected', 'rejected')
              AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)
            ORDER BY r.id`,
          [p.id]
        );
        for (const d of declined) {
          if (!(await declinedStillOpen(q, d))) continue;
          handle.push({
            kind: 'revision_declined', project_id: p.id, system_name: p.system_name, task_id: d.task_id, revision_id: d.revision_id, status: d.status,
            purpose: d.purpose, object_type: d.object_type, object_id: d.object_id, decided_at: d.decided_at,
          });
        }
        const objs = await q.all(
          `SELECT o.id AS objection_id, o.notice_id AS notice_id, o.reason AS reason, o.created_at AS created_at, n.ref_id AS record_id
             FROM sysbuild_notice_objections o JOIN sysbuild_notices n ON n.id = o.notice_id WHERE n.project_id = ? AND o.mode = 'to_pm' ORDER BY o.id DESC`,
          [p.id]
        );
        for (const o of objs) objection.push({ project_id: p.id, system_name: p.system_name, objection_id: o.objection_id, notice_id: o.notice_id, record_id: o.record_id, reason: o.reason, created_at: o.created_at });
        // send_failed：失败的发送意图 + 待发送超时的 pending（L3），补发能处理的；needs_offline：没有发送意图、最后一次尝试失败的改期知会（K2 / P184：负责人没有平台账号，须线下通知，补发处理不了）。
        //   P188（修订批 3）：两类拆开计数与列条目，口径与项目视图的 notify.send_failed / notify.needs_offline 同一份（notify-core.failedSendItems / failedIntentCount、needsOfflineItems / needsOfflineCount）。
        for (const f of await notifyCore.failedSendItems(q, p.id)) sendFailed.push(Object.assign({ project_id: p.id, system_name: p.system_name }, f));
        for (const f of await notifyCore.needsOfflineItems(q, p.id)) needsOffline.push(Object.assign({ project_id: p.id, system_name: p.system_name }, f));
        const late = await q.all(
          `SELECT r.id AS revision_id, r.created_at AS created_at, t.id AS task_id, t.purpose AS purpose, t.object_type AS object_type, t.object_id AS object_id
             FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
            WHERE t.project_id = ? AND r.status = 'pending' AND r.created_at <= datetime('now','localtime', ?) ORDER BY r.id`,
          [p.id, `-${notifyCore.OVERDUE_DAYS} days`]
        );
        for (const l of late) overdue.push({ project_id: p.id, system_name: p.system_name, task_id: l.task_id, revision_id: l.revision_id, purpose: l.purpose, object_type: l.object_type, object_id: l.object_id, created_at: l.created_at });
      }
      counts.handle = handle.length; items.handle = cap(handle);
      counts.objection = objection.length; items.objection = cap(objection);
      counts.send_failed = sendFailed.length; items.send_failed = cap(sendFailed);
      counts.needs_offline = needsOffline.length; items.needs_offline = cap(needsOffline);
      counts.overdue = overdue.length; items.overdue = cap(overdue);

      // 待判定：PM 看所担任项目的全部，其他成员只看本人登记的（项目可见 = PM 或已加入未移出的成员）
      const visible = await q.all(
        `SELECT p.id AS id, p.system_name AS system_name, p.pm_user_id AS pm_user_id FROM sysbuild_projects p
          WHERE p.pm_user_id = ? OR EXISTS (SELECT 1 FROM sysbuild_members m WHERE m.project_id = p.id AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL}) ORDER BY p.id DESC`,
        [uid, uid]
      );
      const routing = [];
      for (const p of visible) {
        const isPm = Number(p.pm_user_id) === uid;
        const rows = await q.all(
          `SELECT ${entriesCore.ENTRY_COLS} FROM sysbuild_entries
            WHERE project_id = ? AND (SELECT s.route FROM sysbuild_routing_snapshots s WHERE s.entry_id = sysbuild_entries.id ORDER BY s.id DESC LIMIT 1) = 'pending' ORDER BY id DESC`,
          [p.id]
        );
        for (const e of rows) {
          if (!isPm && Number(e.operator_user_id) !== uid) continue;
          const facts = await entriesCore.loadEntryFacts(q, e);
          if (entriesCore.entryResolved(facts.derived)) continue;
          if (facts.routing === null || facts.routing.route !== 'pending') continue;
          routing.push({ project_id: p.id, system_name: p.system_name, entry_id: e.id, title: e.title, node_id: e.node_id, created_at: e.created_at });
        }
      }
      counts.routing = routing.length; items.routing = cap(routing);
      counts.badge = counts.confirm + counts.accept; // P183：顶部角标 = 待我确认 + 待我接受
      return { counts, items };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createNotifier, createNotifyRoutes, TODO_ITEM_CAP, RESEND_BATCH_CAP, scrub, normalizeBaseUrl };
