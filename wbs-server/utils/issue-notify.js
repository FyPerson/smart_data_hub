/**
 * 需求跟踪模块 · 钉钉通知 helper（v1.74.0 C2）
 * 方案见 docs/local/需求跟踪升级_方案_20260531_v1.1.md §3
 *
 * 设计范式（C2 codex 审主动标注的偏离点，已与用户拍板）：
 *   方案 §3.5 骨架把 readSystemConfig + dbRunAsync 写进 helper 内部（厚 helper）。
 *   但本项目 utils/ 既有范式 = 纯封装（dingtalk-notify.js 不读 config、不碰 DB，token/robotCode 靠入参）。
 *   为对齐既有架构 + 避免 utils 反向依赖 server.js（循环依赖）+ 与 collab notify endpoint 同构，
 *   本模块只做纯函数：① markdown builder ② issueSafeText ③ 薄发送函数 sendIssueMarkdown
 *   （token/robotCode/dingUserId 入参，返回结果对象，不读 config、不落库）。
 *   取 config + getAccessToken + 反查 dingUserId + 落库 notify_* 全留 C3 endpoint（与 collab 完全一致）。
 *
 * markdown 安全：所有用户输入字段进 markdown 前必经 issueSafeText（复用 dingtalk-notify.js 既有
 *   escapeMarkdown，**不新建 markdownEscape**——codex 03/06 H-1/L-1 反复强调）。
 */

'use strict';

const dingtalkNotify = require('./dingtalk-notify');

// ── 平台深链（复用 collab _buildDeepLink 模式，指向需求跟踪页面）──
// codex 08 M-2：issueId 须为整数才拼链接，非整数返空（暴露调用方传错，且杜绝 &/)/换行 污染 markdown 链接）
function buildIssueDeepLink(issueId, platformBaseUrl) {
    const baseUrl = (platformBaseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return '';
    const idNum = Number(issueId);
    if (!Number.isInteger(idNum) || idNum <= 0) return '';
    return `${baseUrl}/Issue_Tracker.html?id=${idNum}`;
}

/**
 * URL 安全处理（codex 08 H-1）：业务录入的 acceptance_url 要进 markdown link destination，
 * escapeMarkdown 不适合 URL 本体（会破坏链接），故单独校验：
 *   ① trim ② new URL() 解析，仅允许 http/https（拒 javascript: / data: 等恶意 scheme）
 *   ③ 含括号 ( )、尖括号 < >、反斜杠 \、空白/控制字符（任一都会破坏 markdown link destination）的一律拒绝（codex 09 L-1：注释与正则对齐）
 * 不合法返回 '' → 调用方据此降级为纯文本无链接（与 acceptance_url 为空同处理）。
 * @returns {string} 安全 URL 或 ''（不合法）
 */
function sanitizeUrl(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    // 拒绝：控制字符(\x00-\x1F\x7F) + 所有空白(\s) + 括号 ()  + 尖括号 <> + 反斜杠 \（任一都会破坏 markdown link destination）
    if (/[\x00-\x20\x7F\s()<>\\]/.test(s)) return '';
    let u;
    try { u = new URL(s); } catch (_) { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return s;
}

/**
 * Markdown 安全文本（v1.0.5 H-1/L-1：复用 dingtalk-notify.js 既有 escapeMarkdown + 截断，不新建 markdownEscape）
 * @param {*} text     原始文本（任意类型，null/undefined → ''）
 * @param {number} maxLen  截断长度（默认 500，与 escapeMarkdown 内置上限一致）
 */
function issueSafeText(text, maxLen = 500) {
    if (text === null || text === undefined || text === '') return '';
    // escapeMarkdown 已做控制字符净化 + markdown 特殊字符转义 + 500 截断；此处再按 maxLen 收紧
    return dingtalkNotify.escapeMarkdown(String(text)).slice(0, maxLen);
}

// ── markdown builder（4 个，§3.2-§3.4b）──
// 约定：所有 issue 字段经 issueSafeText；platformBaseUrl 为空时省略深链段（最佳努力）

/** 通知 #1 指派（§3.2）：推被指派开发 */
function buildIssueAssignedMarkdown(issue, platformBaseUrl) {
    const link = buildIssueDeepLink(issue.id, platformBaseUrl);
    const lines = [
        '### 📋 你收到一个新的数据需求',
        '',
        `**类型**：${issueSafeText(issue.type)}`,
        `**优先级**：${issueSafeText(issue.priority)}`,
        `**标题**：${issueSafeText(issue.title)}`,
        '',
        `**业务方**：${issueSafeText(issue.requester_dept)} ${issueSafeText(issue.requester_name)}`,
        issue.deadline ? `**截止日期**：${issueSafeText(issue.deadline)}` : '',
        '',
    ];
    if (issue.description) {
        lines.push('**描述**：', issueSafeText(issue.description), '');
    }
    if (link) {
        lines.push('---', `📍 [打开平台查看 →](${link})`);
    }
    if (issue.created_by_name) {
        lines.push('', `> 录入人：${issueSafeText(issue.created_by_name)}`);
    }
    return lines.filter(l => l !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 通知 #2 改派 - 新负责人（§3.3） */
function buildIssueReassignedMarkdownForNew(issue, previousName, platformBaseUrl) {
    const link = buildIssueDeepLink(issue.id, platformBaseUrl);
    const lines = [
        '### 🔄 需求转派给你',
        '',
        `**标题**：${issueSafeText(issue.title)}`,
        `**原负责人**：${issueSafeText(previousName || '-')} → **现负责人**：${issueSafeText(issue.assigned_to_name || '你')}（你）`,
        '',
        `**优先级**：${issueSafeText(issue.priority)}`,
        issue.deadline ? `**截止日期**：${issueSafeText(issue.deadline)}` : '',
        `**业务方**：${issueSafeText(issue.requester_dept)} ${issueSafeText(issue.requester_name)}`,
    ];
    if (link) {
        lines.push('', '---', `📍 [打开平台查看 →](${link})`);
    }
    return lines.filter(l => l !== '').join('\n');
}

/** 通知 #2 改派 - 原负责人（§3.4） */
function buildIssueReassignedMarkdownForOld(issue, newName) {
    return [
        '### 🔄 需求已转交他人',
        '',
        `**标题**：${issueSafeText(issue.title)}`,
        `你的负责需求已转给：**${issueSafeText(newName || '-')}**`,
    ].join('\n');
}

/**
 * 通知 #3 业务方完成（§3.4b）：复用 acceptance_url 字段发链接，不新增上传
 * acceptance_url 为空 → 发纯文本完成通知（无链接段），调用方据 link_included 前端提示
 */
function buildIssueCompletedMarkdownForRequester(issue) {
    // codex 08 H-1：acceptance_url 进 markdown link 前过 sanitizeUrl（拒非 http/https + 控制字符 + `)` 等注入字符）
    const link = sanitizeUrl(issue.acceptance_url);
    const lines = [
        '### ✅ 您提的数据需求已完成',
        '',
        `**需求**：${issueSafeText(issue.title)}`,
        `**类型**：${issueSafeText(issue.type)}`,
        '',
        `您（${issueSafeText(issue.requester_dept)} ${issueSafeText(issue.requester_name)}）提出的需求已完成并验收通过。`,
    ];
    if (link) {
        // link 已过 sanitizeUrl（http/https + 无注入字符），安全进 markdown link destination
        lines.push('', '**查看成果**：', `📊 [打开预览/验收地址 →](${link})`);
    }
    lines.push('', '---', `> 完成确认：${issueSafeText(issue.closed_by_name || issue.created_by_name || '管理员')}`, '> 如有问题可回复本钉钉或联系数据负责人');
    return lines.join('\n');
}

/**
 * 薄发送函数：组装钉钉单聊 markdown 推送（纯封装，不读 config 不落库）
 * 调用方（C3 endpoint）负责：取 config → getAccessToken → 反查 dingUserId → 调本函数 → 据返回落库 notify_*
 *
 * ⚠️ 失败有两条路径（对齐 collab server.js:11556-11589 范式，grep 真相源所得）：
 *   ① HTTP 5xx / 非 JSON → sendMarkdownToUser 抛错 → catch 分支
 *   ② errcode≠0（token 失效/用户不存在等）→ **sendMarkdownToUser 不抛错**，errcode 放返回对象里 → 须手动判
 *   本函数两条都识别为 success:false。token_expired 的伪重试**不在此层**——helper 不持有 appKey/appSecret，
 *   只把 reason='token_expired' 透传，由 C3 endpoint 决定是否 clearCachedToken + 重新 getAccessToken 重试。
 *
 * @param {Object} opts
 * @param {string} opts.token        access_token（调用方 getAccessToken 拿到）
 * @param {string} opts.robotCode    钉钉机器人 code
 * @param {string} opts.dingUserId   接收人钉钉 user_id（调用方反查拿到）
 * @param {string} opts.title        钉钉标题
 * @param {string} opts.markdown     已渲染好的 markdown（调用方用 buildIssueXxx 生成）
 * @returns {Promise<{success:boolean, message_key?:string, errcode?:*, reason?:string, clearUserId?:boolean}>}
 *          成功 {success:true, message_key}；失败 {success:false, errcode, reason}（已 classifyError，不抛）
 *          clearUserId=true 表示该 dingUserId 失效，调用方应清 users.dingtalk_user_id（对齐 collab cls.clearUserId）
 */
async function sendIssueMarkdown(opts) {
    const { token, robotCode, dingUserId, title, markdown } = opts || {};
    // codex 08 L-2：title/markdown 也纳入参数防御（空值提前拦，暴露调用方 bug 而非变远端业务错误）
    const missing = [];
    if (!token) missing.push('token');
    if (!robotCode) missing.push('robotCode');
    if (!dingUserId) missing.push('dingUserId');
    if (!title) missing.push('title');
    if (!markdown) missing.push('markdown');
    if (missing.length) {
        return { success: false, errcode: 'bad_args', reason: `缺少参数：${missing.join('/')}` };
    }
    let resp;
    try {
        resp = await dingtalkNotify.sendMarkdownToUser(token, robotCode, [dingUserId], title, markdown);
    } catch (err) {
        // 路径①：HTTP 5xx / 非 JSON 抛错
        const cls = dingtalkNotify.classifyError(err);
        return { success: false, errcode: cls.errcode, reason: cls.reason, errmsg: cls.errmsg };
    }
    // 成功判定：对齐项目既有正确范式 dingtalkSendOk（server.js:15080）——钉钉新版机器人 batchSend API
    //   (api.dingtalk.com/v1.0/robot/oToMessages/batchSend) 成功时**不返回 errcode**，只返回 processQueryKey；
    //   仅失败（token 失效/用户不存在等）才返回 errcode≠0。原"errcode===0 才成功"是套用了老版 oapi 的预期，
    //   导致正常成功响应（无 errcode）被误判失败 → invalid_response → 前端报"钉钉推送失败"（生产实证 2026-06-03）。
    //   实证成功响应：{flowControlledStaffIdList:[],invalidStaffIdList:[],filteredStaffIdList:[],processQueryKey:"..."}
    //
    // 判定分层（codex 复审加固：errcode 收紧 + 失败用户列表检查 + message_key 软失败三层防御）：
    //   ① errcode 存在且 trim 后非空、非 '0' → 一律失败（codex #1：避免 '-1'/' 88'/'abc' 等非纯数字码被吞成软成功）；
    //      纯数字码走 classifyError 精确分类（token/user 失效等），非数字码兜 invalid_response。
    //   ② invalidStaffIdList 含目标 dingUserId（或非空）→ 失败 user_invalid + clearUserId（codex #2 high：对齐
    //      dingtalkSendOk，"有 processQueryKey 但该用户在无效列表" = 钉钉没真送达，必须当失败，否则重蹈本次 bug 对称覆辙）。
    //   ③ flowControlled/filtered 列表含目标用户 → 失败（限流/被过滤，未送达）。
    //   ④ 以上都过 → 看 processQueryKey：有 → success；无 → success:true+message_key_missing:true
    //      （"发了但无法跟踪已读"，C3 endpoint 据此返 502 提示重试；保留 codex 12 H-2 契约）。
    const ec = resp ? resp.errcode : undefined;
    const ecStr = (ec === null || ec === undefined || ec === false) ? '' : String(ec).trim();
    if (ecStr !== '' && ecStr !== '0') {
        // 纯数字业务码 → classifyError 精确分类；非纯数字（'abc' 等异常码）→ 兜 invalid_response
        const cls = /^\d+$/.test(ecStr)
            ? dingtalkNotify.classifyError({ errcode: Number(ecStr), errmsg: resp.errmsg })
            : { reason: 'invalid_response', errcode: ec, errmsg: resp.errmsg || '钉钉返回非预期 errcode', clearUserId: false };
        return { success: false, errcode: cls.errcode, reason: cls.reason, errmsg: cls.errmsg, clearUserId: !!cls.clearUserId };
    }
    // 失败用户列表检查（codex #2 high）：单聊只发一个 dingUserId，任一列表命中该用户即未送达。
    //   钉钉对 uid 失效/离职放 invalidStaffIdList；限流放 flowControlledStaffIdList；被规则过滤放 filteredStaffIdList。
    const target = String(dingUserId).trim();
    // codex 复审 low：列表元素也 trim 归一化，防钉钉回显带空白漏判（与 errcode trim 同源）
    const inList = (arr) => Array.isArray(arr) && arr.map(v => String(v).trim()).includes(target);
    if (inList(resp && resp.invalidStaffIdList)) {
        return { success: false, reason: 'user_invalid', errmsg: `目标用户在 invalidStaffIdList（uid 失效/离职）`, clearUserId: true };
    }
    if (inList(resp && resp.flowControlledStaffIdList)) {
        return { success: false, reason: 'rate_limit', errmsg: `目标用户被限流（flowControlledStaffIdList）`, clearUserId: false };
    }
    if (inList(resp && resp.filteredStaffIdList)) {
        return { success: false, reason: 'invalid_response', errmsg: `目标用户被过滤（filteredStaffIdList）`, clearUserId: false };
    }
    // 全部通过：processQueryKey 即 message_key（已读跟踪用）；缺失则标记让 C3 决策（保留 codex 12 H-2 语义）
    const messageKey = resp && resp.processQueryKey ? resp.processQueryKey : null;
    return { success: true, message_key: messageKey, message_key_missing: !messageKey };
}

module.exports = {
    buildIssueDeepLink,
    sanitizeUrl,                              // codex 08 H-1：acceptance_url 进 markdown 前的 URL 安全校验
    issueSafeText,                            // v1.0.5 H-1/L-1：复用 escapeMarkdown + 截断，替代新建 markdownEscape
    buildIssueAssignedMarkdown,               // 通知 #1
    buildIssueReassignedMarkdownForNew,       // 通知 #2 新负责人
    buildIssueReassignedMarkdownForOld,       // 通知 #2 原负责人
    buildIssueCompletedMarkdownForRequester,  // 通知 #3 业务方完成
    sendIssueMarkdown,                        // 薄发送（纯封装，不读 config 不落库）
};
