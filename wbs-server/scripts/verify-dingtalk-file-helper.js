/**
 * 钉钉文件发送 helper 独立验证脚本（2026-05-29，方案 v1.1 rec 5）
 *
 * 覆盖 uploadMedia / sendFileToUser / buildRequesterDoneCard 的响应解析与错误分类。
 * mock 全局 fetch，不依赖真钉钉、不依赖运行中的服务。
 *
 * 运行：node scripts/verify-dingtalk-file-helper.js
 */
'use strict';

const assert = require('assert');
const d = require('../utils/dingtalk-notify.js');

let passed = 0, failed = 0;
async function t(name, fn) {
    const origFetch = global.fetch;
    try {
        await fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}\n   ${e.message}`);
        failed++;
    } finally {
        global.fetch = origFetch;
    }
}

// 记录 fetch 调用参数（L-2：断言请求构造正确，不只验响应解析）
let lastCall = null;
function mockFetch(status, jsonBody, { throwOnJson = false } = {}) {
    lastCall = null;
    global.fetch = async (url, opts) => {
        lastCall = { url, opts: opts || {} };
        return {
            status,
            json: async () => { if (throwOnJson) throw new Error('not json'); return jsonBody; },
            text: async () => JSON.stringify(jsonBody)
        };
    };
}

(async () => {
    console.log('=== 钉钉文件 helper 独立验证 ===\n');

    // --- uploadMedia ---
    await t('uploadMedia: 成功返 media_id + 请求构造正确（L-2）', async () => {
        mockFetch(200, { errcode: 0, media_id: '@media_xxx' });
        const id = await d.uploadMedia('tok&x', 'a.xlsx', Buffer.from('x'));
        assert.strictEqual(id, '@media_xxx');
        // L-2：断言请求构造——URL 含 media/upload + token 已 encode（tok&x → tok%26x）
        assert.ok(/\/media\/upload/.test(lastCall.url), 'URL 应含 media/upload');
        assert.ok(lastCall.url.includes('access_token=tok%26x'), 'token 应 encodeURIComponent');
        assert.strictEqual(lastCall.opts.method, 'POST', '应 POST');
        assert.ok(lastCall.opts.body instanceof FormData, 'body 应是 FormData（multipart）');
    });
    await t('uploadMedia: errcode!=0 抛错 + 带 dingtalkResp', async () => {
        mockFetch(200, { errcode: 40035, errmsg: 'bad' });
        try { await d.uploadMedia('tok', 'a.xlsx', Buffer.from('x')); throw new Error('应抛错'); }
        catch (e) { assert.ok(e.dingtalkResp, '应带 dingtalkResp'); assert.strictEqual(e.dingtalkResp.errcode, 40035); }
    });
    await t('uploadMedia: 5xx 抛错带 httpStatus', async () => {
        mockFetch(503, {});
        try { await d.uploadMedia('tok', 'a.xlsx', Buffer.from('x')); throw new Error('应抛错'); }
        catch (e) { assert.strictEqual(e.httpStatus, 503); }
    });
    await t('uploadMedia: 非 JSON 抛错带 httpStatus', async () => {
        mockFetch(200, null, { throwOnJson: true });
        try { await d.uploadMedia('tok', 'a.xlsx', Buffer.from('x')); throw new Error('应抛错'); }
        catch (e) { assert.ok(/non-JSON/.test(e.message), '应是 non-JSON 错误'); }
    });

    // --- sendFileToUser ---
    await t('sendFileToUser: 成功返原始响应 + 请求构造正确（L-2）', async () => {
        mockFetch(200, { processQueryKey: 'pqk', invalidStaffIdList: [] });
        const r = await d.sendFileToUser('tok', 'robotX', ['u1', 'u2'], '@m', 'a.xlsx');
        assert.strictEqual(r.processQueryKey, 'pqk');
        assert.deepStrictEqual(r.invalidStaffIdList, []);
        // L-2：断言请求构造——URL/header 双带 token + payload 含 sampleFile/mediaId/fileName/robotCode/userIds
        assert.ok(lastCall.url.includes('x-acs-dingtalk-access-token=tok'), 'URL query 应带 token');
        assert.strictEqual(lastCall.opts.headers['x-acs-dingtalk-access-token'], 'tok', 'header 应带 token（探针双带）');
        const payload = JSON.parse(lastCall.opts.body);
        assert.strictEqual(payload.msgKey, 'sampleFile', 'msgKey 应 sampleFile');
        assert.strictEqual(payload.robotCode, 'robotX', 'robotCode 透传');
        assert.deepStrictEqual(payload.userIds, ['u1', 'u2'], 'userIds 透传');
        const msgParam = JSON.parse(payload.msgParam);
        assert.strictEqual(msgParam.mediaId, '@m', 'mediaId 透传');
        assert.strictEqual(msgParam.fileName, 'a.xlsx', 'fileName 透传');
        assert.strictEqual(msgParam.fileType, 'xlsx', 'fileType=xlsx');
    });
    await t('sendFileToUser: errcode!=0 也原样返回（成功判断在调用方）', async () => {
        mockFetch(200, { errcode: 88, errmsg: 'x' });
        const r = await d.sendFileToUser('tok', 'robot', ['u1'], '@m', 'a.xlsx');
        assert.strictEqual(r.errcode, 88);
    });
    await t('sendFileToUser: invalidStaffIdList 非空也原样返回', async () => {
        mockFetch(200, { processQueryKey: 'pqk', invalidStaffIdList: ['u1'] });
        const r = await d.sendFileToUser('tok', 'robot', ['u1'], '@m', 'a.xlsx');
        assert.deepStrictEqual(r.invalidStaffIdList, ['u1']);
    });
    await t('sendFileToUser: 5xx 抛错带 httpStatus', async () => {
        mockFetch(502, {});
        try { await d.sendFileToUser('tok', 'robot', ['u1'], '@m', 'a.xlsx'); throw new Error('应抛错'); }
        catch (e) { assert.strictEqual(e.httpStatus, 502); }
    });
    await t('sendFileToUser: 非 JSON 抛错', async () => {
        mockFetch(200, null, { throwOnJson: true });
        try { await d.sendFileToUser('tok', 'robot', ['u1'], '@m', 'a.xlsx'); throw new Error('应抛错'); }
        catch (e) { assert.ok(/non-JSON/.test(e.message)); }
    });

    // --- buildRequesterDoneCard ---
    await t('buildRequesterDoneCard: 入参 escapeMarkdown 转义', async () => {
        const c = d.buildRequesterDoneCard({ oaRequestNo: 'OA-*1*', description: 'a_b', exporterName: '示例用户A' });
        assert.ok(c.text.includes('OA-\\*1\\*'), 'oaRequestNo 应转义');
        assert.ok(c.text.includes('a\\_b'), 'description 应转义');
        assert.ok(c.text.includes('示例用户A'), '含导出人名');
    });
    await t('buildRequesterDoneCard: exporterName 空 → 改"平台管理员"无末尾空白', async () => {
        const c = d.buildRequesterDoneCard({ oaRequestNo: 'OA-1', description: 'x' });
        assert.ok(c.text.includes('请联系平台管理员。'), '空名应转平台管理员');
        assert.ok(!c.text.includes('数据导出人 。'), '不应有末尾空白');
    });
    await t('buildRequesterDoneCard: description 空 → 不渲染需求行', async () => {
        const c = d.buildRequesterDoneCard({ oaRequestNo: 'OA-1', exporterName: '示例用户A' });
        assert.ok(!c.text.includes('**需求**'), 'description 空不应有需求行');
    });

    console.log(`\n结果：${passed} passed / ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
