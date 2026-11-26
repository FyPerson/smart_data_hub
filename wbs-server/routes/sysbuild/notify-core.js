// routes/sysbuild/notify-core.js — 项目管理（系统建设记录）模块：通知的事务内助手（发送意图登记）与常量（C6b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §9.2（钉钉通知 / 发送意图）、§6.2（sysbuild_send_intents）。
//   派单 = docs/local/系统建设记录/送审准备/C6_C6b_通知待办改期知会_派单_20261107.md §2。
//
// 本文件只放两类东西，且都不依赖钉钉、不注册路由、不 require 其他业务模块（只 db 的 makeError），所以 confirm-core / golive-core / membership / plan 都能直接 require 而不成环：
//   1. 常量：发送意图的用途 / 引用类型、页面路由（链接里的路由集中在这里定义，C7 页面按它解析）、补发 / 超期的时间常量；
//   2. 在调用方 withWriteTxn 回调里用 q 调用的助手：enqueueSendIntent（写一条 pending 的发送意图，登记到本事务的意图清单）与几个「按对象找收件人再写意图」的包装。
// 事务外的发送、结果回写、补发、模块就绪时扫描在 notify.js（createNotifier）。
// 发送意图与业务写入同一事务：事务回滚则意图随之不存在；事务提交后由 notify.wrapDb 的 withWriteTxn 包装在事务外触发发送（意图清单 q.sendIntentIds 由包装挂上，没有包装时意图留在 pending，等补发 / 扫描）。
'use strict';
const { makeError } = require('./db');

// Count failed and overdue pending intents from the same predicate in both views.
const PENDING_TIMEOUT_TEXT = '待发送超时';
const intentFailedWhere = "(i.status = 'failed' OR (i.status = 'pending' AND i.created_at <= datetime('now','localtime', ?)))";
// 发送意图的用途（purpose 列无库内 CHECK，由本表校验）
const PURPOSES = Object.freeze({
  CONFIRM_REQUEST: 'confirm_request', // 确认任务修订生成（首修订）→ 必需确认人
  CONFIRM_REISSUE: 'confirm_reissue', // 确认任务改发（含 P174 答复后改发）→ 新的必需确认人
  DECISION_OBJECTED: 'decision_objected', // 修订被决策为有异议 / 不认可 → 项目 PM
  SCHEDULE_NOTICE: 'schedule_notice', // 改期知会 → 需求部门现任负责人
  LEADER_CONFIRMATION_NOTICE: 'leader_confirmation_notice',
  OPINION_ASSESS: 'opinion_assess_notice',
  OPINION_READY: 'opinion_ready_notice',
  OPINION_RESULT: 'opinion_result_notice',
  OPINION_CUT: 'opinion_cut_notice',
});
const PURPOSE_LIST = Object.freeze(Object.values(PURPOSES));
const LEADER_CONFIRMATION_SUBJECTS = Object.freeze({ overall: '范围', batch_accept: '验收', closing: '结项' });
// 发送意图指向的业务对象类型
const REF_TYPES = Object.freeze({
  REVISION: 'confirm_revision',
  NOTICE: 'notice',
  OPINION: 'opinion',
  CUT_APPROVAL: 'cut_approval',
});
const REF_TYPE_LIST = Object.freeze(Object.values(REF_TYPES));

// 页面路由供通知链接使用，rev 固定指向确认任务修订号。
const PAGE = '/Sys_Build.html';
const ROUTES = Object.freeze({
  project: (projectId) => `${PAGE}?project=${projectId}`,
  confirm: (projectId, revisionId) => `${PAGE}?project=${projectId}&rev=${revisionId}`,
  notice: (projectId, noticeId) => `${PAGE}?project=${projectId}&notice=${noticeId}`,
  opinion: (projectId, opinionId) => `${PAGE}?project=${projectId}&tab=opinions&opinion=${opinionId}`,
  sendIntents: (projectId) => `${PAGE}?project=${projectId}&view=send-intents`,
});

// 时间常量（集中定义）
const RESEND_PENDING_MINUTES = 5; // 补发：pending 创建超过这么久才算「提交后、发送前进程退出」
const SCAN_MAX_ATTEMPTS = 3; // 模块就绪时扫描：failed 且尝试次数小于它的才重发
const OVERDUE_DAYS = 3; // 待办 overdue：PM 所担任项目内创建超过这么多天仍待确认的修订（P154：「领导多日未处理 → PM」的派生替代，不做自动推送）

const internal = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);

// 在写事务内写一条 pending 的发送意图，返回意图编号；同时把编号登记到本事务的意图清单（q.sendIntentIds，由 notify.wrapDb 挂上）。
//   a：{ projectId, purpose, refType, refId, recipientUserId }。入参不合法 = 编程错误，抛 500（事务随之回滚）。
async function enqueueSendIntent(q, a) {
  if (!a || !Number.isSafeInteger(a.projectId) || a.projectId <= 0) throw internal('发送意图缺项目编号');
  if (!PURPOSE_LIST.includes(a.purpose)) throw internal('发送意图用途未登记');
  if (!REF_TYPE_LIST.includes(a.refType)) throw internal('发送意图引用类型未登记');
  if (!Number.isSafeInteger(a.refId) || a.refId <= 0) throw internal('发送意图缺引用编号');
  if (!Number.isSafeInteger(a.recipientUserId) || a.recipientUserId <= 0) throw internal('发送意图缺收件人');
  const ins = await q.run(
    "INSERT INTO sysbuild_send_intents (project_id, purpose, ref_type, ref_id, recipient_user_id, channel, status) VALUES (?, ?, ?, ?, ?, 'dingtalk', 'pending')",
    [a.projectId, a.purpose, a.refType, a.refId, a.recipientUserId]
  );
  if (Array.isArray(q.sendIntentIds)) q.sendIntentIds.push(ins.lastID);
  return ins.lastID;
}

// 成员 memberId 的平台账号编号；成员不存在返回 null。
async function userOfMember(q, memberId) {
  if (memberId === null || memberId === undefined) return null;
  const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [memberId]);
  return m && m.user_id !== null && m.user_id !== undefined ? Number(m.user_id) : null;
}

// 确认任务修订生成 / 改发 → 该修订的必需确认人（有平台账号的）。返回意图编号，不建返回 null。
//   写入点只有两处（confirm-core.createTaskWithRevision 首修订、confirm.js 改发），都在这个助手上汇合。
async function enqueueRevisionIntent(q, o) {
  const uid = await userOfMember(q, o.requiredMemberId);
  if (uid === null) return null;
  return enqueueSendIntent(q, {
    projectId: o.projectId, purpose: o.reissue === true ? PURPOSES.CONFIRM_REISSUE : PURPOSES.CONFIRM_REQUEST,
    refType: REF_TYPES.REVISION, refId: o.revisionId, recipientUserId: uid,
  });
}

// 修订被决策为有异议 / 不认可 → 项目 PM（项目现任 PM）。C6b 修订批 1（L6）：作出决策的人本人就是项目 PM 时不写——他刚刚自己作出的决策不需要再通知自己。
//   （「PM 就是决策人」是可达的：决策人本人账号与项目现任 PM 的账号相同，例如对该包版本不认可的确认；原注释写「身份不会重叠」不成立。）o.actorUserId = 作出决策的账号编号。
async function enqueuePmIntent(q, o) {
  const p = await q.get('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [o.projectId]);
  if (!p || p.pm_user_id === null || p.pm_user_id === undefined) return null;
  if (o.actorUserId !== undefined && Number(p.pm_user_id) === Number(o.actorUserId)) return null;
  return enqueueSendIntent(q, { projectId: o.projectId, purpose: o.purpose, refType: o.refType, refId: o.refId, recipientUserId: Number(p.pm_user_id) });
}

async function failedIntentCount(q, projectId) {
  const a = await q.get(`SELECT COUNT(*) AS n FROM sysbuild_send_intents i WHERE i.project_id = ? AND ${intentFailedWhere}`, [projectId, `-${RESEND_PENDING_MINUTES} minutes`]);
  return a ? Number(a.n) : 0;
}
// 待办 send_failed 类的条目（项目内，按 id 从新到旧）：补发能处理的两种，kind = intent_failed / intent_pending_timeout，条目与 counts 同口径。
async function failedSendItems(q, projectId) {
  const rows = await q.all(
    `SELECT i.id AS id, i.status AS status, i.purpose AS purpose, i.ref_type AS ref_type, i.ref_id AS ref_id, i.attempts AS attempts, i.last_error AS last_error, i.updated_at AS updated_at
       FROM sysbuild_send_intents i WHERE i.project_id = ? AND ${intentFailedWhere} ORDER BY i.id DESC`,
    [projectId, `-${RESEND_PENDING_MINUTES} minutes`]
  );
  const items = rows.map((f) => ({
    kind: f.status === 'failed' ? 'intent_failed' : 'intent_pending_timeout', intent_id: f.id, notice_id: null, purpose: f.purpose, ref_type: f.ref_type, ref_id: f.ref_id, attempts: f.attempts,
    last_error: f.status === 'failed' ? f.last_error : PENDING_TIMEOUT_TEXT, updated_at: f.updated_at,
  }));
  return items;
}

module.exports = {
  PURPOSES, PURPOSE_LIST, LEADER_CONFIRMATION_SUBJECTS, REF_TYPES, REF_TYPE_LIST, ROUTES, PAGE,
  RESEND_PENDING_MINUTES, SCAN_MAX_ATTEMPTS, OVERDUE_DAYS,
  enqueueSendIntent, userOfMember, enqueueRevisionIntent, enqueuePmIntent, failedIntentCount, failedSendItems, PENDING_TIMEOUT_TEXT,
};
