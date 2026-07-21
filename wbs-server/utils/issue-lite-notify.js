/**
 * 数据开发换壳·轻量协作台账（issue_lite）· 钉钉通知 markdown builder（薄编排）
 * 换壳方案 v0.2 · D2
 *
 * 设计（照 utils/issue-notify.js 范式，最大复用最小重复）：
 *   本模块只提供 issue_lite 专属 markdown builder + 深链——通用无状态部件全部复用 issueNotify：
 *     ① issueSafeText（markdown 文本转义，内部走 dingtalk-notify.escapeMarkdown）
 *     ② sanitizeUrl（board_url 进 markdown link 前的 URL 安全校验）
 *   实际钉钉发送/已读走 server.js 顶层通用 helper（sendIssueDingtalkRaw / sendIssueDingtalkToRequester /
 *   callDingtalkWithTokenRetry+getReadStatus），本文件不重复那套脆弱响应解析。
 *   ⚠️ 绝不改 dingtalk-notify.js / issue-notify.js（只 require 复用其无状态纯函数）。
 *
 * v0.2 两类通知：
 *   N1 建单通知对方（示例开发C/示例用户A）：buildIssueLitePeerMarkdown —— 深链指 /Issue_Lite.html
 *   N2 完成通知业务方（需求人手机号）：buildIssueLiteRequesterDoneMarkdown —— 带看板地址 board_url
 */
'use strict';

const issueNotify = require('./issue-notify'); // 复用 issueSafeText / sanitizeUrl（通用无状态）

/** 极简台账深链（指向极简页；id 须正整数否则返空，杜绝注入） */
function buildIssueLiteDeepLink(id, platformBaseUrl) {
    const baseUrl = (platformBaseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return '';
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) return '';
    return `${baseUrl}/Issue_Lite.html?id=${idNum}`;
}

/**
 * N1 建单通知对方（示例开发C/示例用户A）：推被选中的通知对象，告知有新数据开发单 + 需求方信息。
 * @param {Object} rec  issue_lite 行
 * @param {string} platformBaseUrl
 */
function buildIssueLitePeerMarkdown(rec, platformBaseUrl) {
    const link = buildIssueLiteDeepLink(rec.id, platformBaseUrl);
    const st = issueNotify.issueSafeText;
    const lines = [
        '### 📋 有一条新的数据开发单',
        '',
        `**标题**：${st(rec.title)}`,
        `**需求方**：${st(rec.requester_dept)} ${st(rec.requester_name)}`,
        rec.req_date ? `**期望完成时间**：${st(rec.req_date)}` : '',
        '',
    ];
    if (rec.description) {
        lines.push('**需求描述**：', st(rec.description), '');
    }
    if (link) {
        lines.push('---', `📍 [打开平台查看 →](${link})`);
    }
    if (rec.created_by_name) {
        lines.push('', `> 登记人：${st(rec.created_by_name)}`);
    }
    return lines.filter(l => l !== '').join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * N-estimate 通知业务方·预计完成时间（照数据修正 estimate）：告知需求人预计完成时间。
 * @param {Object} rec  issue_lite 行（含 estimated_at）
 */
function buildIssueLiteEstimateMarkdown(rec) {
    const st = issueNotify.issueSafeText;
    const lines = [
        '### ⏳ 您提的数据需求已排期',
        '',
        `**需求**：${st(rec.title)}`,
        '',
        `您（${st(rec.requester_dept)} ${st(rec.requester_name)}）提出的数据开发需求已开始处理。`,
        `**预计完成时间**：${st(rec.estimated_at)}`,
        '',
        '---',
        '> 如有疑问可回复本钉钉或联系数据负责人',
    ];
    return lines.join('\n');
}

/**
 * N2 完成通知业务方（需求人）：告知需求已完成，带看板地址（board_url 过 sanitizeUrl）。
 * board_url 为空 → 发纯文本完成通知（无链接段）。
 * @param {Object} rec  issue_lite 行（含 complete_note / board_url）
 */
function buildIssueLiteRequesterDoneMarkdown(rec) {
    const st = issueNotify.issueSafeText;
    // board_url 进 markdown link 前过 sanitizeUrl（拒非 http/https + 控制字符 + `)` 等注入字符）
    const link = issueNotify.sanitizeUrl(rec.board_url);
    const lines = [
        '### ✅ 您提的数据需求已完成',
        '',
        `**需求**：${st(rec.title)}`,
        '',
        `您（${st(rec.requester_dept)} ${st(rec.requester_name)}）提出的数据开发需求已完成。`,
    ];
    if (rec.complete_note) {
        lines.push('', '**完成说明**：', st(rec.complete_note));
    }
    if (link) {
        lines.push('', '**看板地址**：', `📊 [打开看板 →](${link})`);
    }
    lines.push('', '---', '> 如有问题可回复本钉钉或联系数据负责人');
    return lines.join('\n');
}

module.exports = {
    buildIssueLiteDeepLink,
    buildIssueLitePeerMarkdown,             // N1 建单通知对方
    buildIssueLiteEstimateMarkdown,         // N-est 通知业务方·预计完成时间
    buildIssueLiteRequesterDoneMarkdown,    // N2 完成通知业务方
};
