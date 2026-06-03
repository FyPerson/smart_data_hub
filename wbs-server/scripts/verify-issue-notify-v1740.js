/**
 * v1.74.0 C2 — utils/issue-notify.js 验证脚本（纯函数，无 DB/网络）
 *
 * 用途：验证 issue-notify helper 的 markdown builder + issueSafeText + sendIssueMarkdown 三路径。
 *       纯封装设计 → 用 mock 替换 dingtalkNotify 的 sendMarkdownToUser 即可验三条返回路径。
 *
 * 检查项：
 *   1. issueSafeText 复用 escapeMarkdown（转义 markdown 特殊字符 + 控制字符 + 截断）
 *   2. buildIssueAssignedMarkdown 含关键字段 + 深链 + 用户输入被转义
 *   3. buildIssueReassignedMarkdownForNew/Old 含原→新负责人
 *   4. buildIssueCompletedMarkdownForRequester 有/无 acceptance_url 两态
 *   5. buildIssueDeepLink 尾斜杠归一 + 空 baseUrl 返空
 *   6. sendIssueMarkdown 三路径：成功(processQueryKey) / errcode≠0 不抛(手动判) / 抛错(catch)
 *   7. sendIssueMarkdown 参数缺失防御
 */

'use strict';

const assert = require('assert');
const path = require('path');

// 先加载真实 escapeMarkdown（issueSafeText 依赖它）——不 mock，验证真实复用
const issueNotify = require(path.join(__dirname, '..', 'utils', 'issue-notify'));
const dingtalkNotify = require(path.join(__dirname, '..', 'utils', 'dingtalk-notify'));

let pass = 0, fail = 0;
// 支持同步与 async fn：统一 await（同步 fn 的返回值 await 也安全）
async function check(name, fn) {
    try { await fn(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; }
}

const baseUrl = 'http://192.168.1.100:3000';
const sampleIssue = {
    id: 15,
    title: '市场部 5 月业绩分析看板',
    type: '看板/报表需求',
    priority: 'P2',
    requester_dept: '市场营销部',
    requester_name: '张三',
    deadline: '2026-06-15',
    description: '按区域/产品线汇总，月度趋势 + Top10',
    created_by_name: '示例用户A',
    assigned_to_name: '李四',
    acceptance_url: 'http://pbi.example.com/report/15',
};

console.log('\n══════ v1.74.0 C2 issue-notify 验证 ══════');

const realSend = dingtalkNotify.sendMarkdownToUser;

async function main() {
// 检查 1：issueSafeText 复用 escapeMarkdown
await check('检查1 issueSafeText 转义 markdown 特殊字符（复用 escapeMarkdown）', () => {
    const out = issueNotify.issueSafeText('a*b_c[d]');
    // escapeMarkdown 会给 * _ [ ] 加反斜杠
    assert.ok(out.includes('\\*') && out.includes('\\_') && out.includes('\\['), '特殊字符应被转义: ' + out);
});
await check('检查1b issueSafeText 控制字符净化 + 截断', () => {
    assert.strictEqual(issueNotify.issueSafeText(null), '');
    assert.strictEqual(issueNotify.issueSafeText(undefined), '');
    assert.strictEqual(issueNotify.issueSafeText(''), '');
    const long = issueNotify.issueSafeText('x'.repeat(600), 10);
    assert.strictEqual(long.length, 10, '截断到 maxLen=10，实际 ' + long.length);
    // 控制字符 → 空格（escapeMarkdown 行为）
    assert.ok(!/[\x00-\x1F]/.test(issueNotify.issueSafeText('a\x00b')), '控制字符应被净化');
});

// 检查 2：assigned markdown
await check('检查2 buildIssueAssignedMarkdown 含类型/优先级/标题/业务方/深链', () => {
    const md = issueNotify.buildIssueAssignedMarkdown(sampleIssue, baseUrl);
    assert.ok(md.includes('看板/报表需求'), '含类型');
    assert.ok(md.includes('P2'), '含优先级');
    assert.ok(md.includes('市场营销部') && md.includes('张三'), '含业务方');
    assert.ok(md.includes(`Issue_Tracker.html?id=15`), '含深链');
    assert.ok(md.includes('录入人'), '含录入人');
});
await check('检查2b assigned markdown 用户输入被转义（title 含特殊字符）', () => {
    const md = issueNotify.buildIssueAssignedMarkdown({ ...sampleIssue, title: 'a*b[c]' }, baseUrl);
    assert.ok(md.includes('a\\*b\\[c\\]'), 'title 特殊字符应转义: ' + md.slice(0, 80));
});
await check('检查2c assigned markdown 无 deadline/description 时省略对应段', () => {
    const md = issueNotify.buildIssueAssignedMarkdown(
        { id: 1, title: 't', type: '数据质量', priority: 'P1', requester_dept: '其他', requester_name: '王', created_by_name: '示例用户A' }, baseUrl);
    assert.ok(!md.includes('截止日期'), '无 deadline 应省略');
    assert.ok(!md.includes('**描述**'), '无 description 应省略');
});

// 检查 3：reassigned
await check('检查3 reassignedForNew 含原→新负责人', () => {
    const md = issueNotify.buildIssueReassignedMarkdownForNew(sampleIssue, '王五', baseUrl);
    assert.ok(md.includes('王五'), '含原负责人');
    assert.ok(md.includes('李四'), '含新负责人');
    assert.ok(md.includes('转派给你'), '标题');
});
await check('检查3b reassignedForOld 含转交目标', () => {
    const md = issueNotify.buildIssueReassignedMarkdownForOld(sampleIssue, '李四');
    assert.ok(md.includes('李四') && md.includes('转交他人'), '含目标 + 标题');
});

// 检查 4：completed（业务方）
await check('检查4 completedForRequester 有 acceptance_url → 含链接', () => {
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(sampleIssue);
    assert.ok(md.includes('已完成'), '标题');
    assert.ok(md.includes('http://pbi.example.com/report/15'), '含验收链接');
    assert.ok(md.includes('查看成果'), '含成果段');
});
await check('检查4b completedForRequester 无 acceptance_url → 纯文本无链接段', () => {
    const md = issueNotify.buildIssueCompletedMarkdownForRequester({ ...sampleIssue, acceptance_url: null });
    assert.ok(md.includes('已完成'), '标题仍在');
    assert.ok(!md.includes('查看成果'), '无链接段');
});

// 检查 5：深链
await check('检查5 buildIssueDeepLink 尾斜杠归一 + 空 baseUrl 返空', () => {
    assert.strictEqual(issueNotify.buildIssueDeepLink(15, 'http://x.com/'), 'http://x.com/Issue_Tracker.html?id=15');
    assert.strictEqual(issueNotify.buildIssueDeepLink(15, 'http://x.com///'), 'http://x.com/Issue_Tracker.html?id=15');
    assert.strictEqual(issueNotify.buildIssueDeepLink(15, ''), '');
    assert.strictEqual(issueNotify.buildIssueDeepLink(15, null), '');
});
await check('检查5b buildIssueDeepLink issueId 非整数返空（codex 08 M-2 防注入）', () => {
    assert.strictEqual(issueNotify.buildIssueDeepLink('15)injection', 'http://x.com'), '', '含注入字符应返空');
    assert.strictEqual(issueNotify.buildIssueDeepLink('abc', 'http://x.com'), '', '非数字应返空');
    assert.strictEqual(issueNotify.buildIssueDeepLink(0, 'http://x.com'), '', 'id<=0 应返空');
    assert.strictEqual(issueNotify.buildIssueDeepLink('15', 'http://x.com'), 'http://x.com/Issue_Tracker.html?id=15', '纯数字字符串归一为整数');
});
await check('检查5c sanitizeUrl 仅放行 http/https + 拒注入/恶意 scheme（codex 08 H-1）', () => {
    assert.strictEqual(issueNotify.sanitizeUrl('http://pbi.x.com/r/15'), 'http://pbi.x.com/r/15', 'http 放行');
    assert.strictEqual(issueNotify.sanitizeUrl('https://pbi.x.com/r/15'), 'https://pbi.x.com/r/15', 'https 放行');
    assert.strictEqual(issueNotify.sanitizeUrl('javascript:alert(1)'), '', '恶意 scheme 拒绝');
    assert.strictEqual(issueNotify.sanitizeUrl('http://x.com/a)b'), '', '含 ) 破坏 markdown link 拒绝');
    assert.strictEqual(issueNotify.sanitizeUrl('http://x.com/a b'), '', '含空格拒绝');
    assert.strictEqual(issueNotify.sanitizeUrl('http://x.com/a\nb'), '', '含换行拒绝');
    assert.strictEqual(issueNotify.sanitizeUrl(''), '', '空返空');
    assert.strictEqual(issueNotify.sanitizeUrl(null), '', 'null 返空');
});
await check('检查5d completedForRequester 恶意 acceptance_url → 降级纯文本无链接（H-1 端到端）', () => {
    const md = issueNotify.buildIssueCompletedMarkdownForRequester({ ...sampleIssue, acceptance_url: 'http://x.com/a)injection' });
    assert.ok(!md.includes('查看成果'), '不合法 URL 应降级无链接段');
    assert.ok(!md.includes(')injection'), '注入内容不应进 markdown');
});

// 检查 6：sendIssueMarkdown 三路径（mock dingtalkNotify.sendMarkdownToUser）
await check('检查6 sendIssueMarkdown 成功路径返回 message_key', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: 0, processQueryKey: 'pqk_123' });
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.message_key, 'pqk_123');
});
await check('检查6b sendIssueMarkdown errcode≠0 不抛 → success:false（手动判路径）', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: 88, errmsg: 'user not exist' });
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false, 'errcode≠0 应判失败');
    assert.strictEqual(r.reason, 'user_invalid', 'reason 应为 user_invalid');
    assert.strictEqual(r.clearUserId, true, 'errcode=88 应标 clearUserId');
});
await check('检查6c sendIssueMarkdown 抛错 → success:false（catch 路径）', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => { const e = new Error('batchSend HTTP 503'); e.httpStatus = 503; throw e; };
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false, '5xx 应判失败');
    assert.strictEqual(r.reason, 'server_5xx', 'reason 应为 server_5xx');
});
await check('检查6d sendIssueMarkdown token_expired reason 透传（不在 helper 重试）', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: 42001, errmsg: 'token expired' });
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.reason, 'token_expired', 'token_expired 透传给 C3 决定重试');
});
await check('检查6e sendIssueMarkdown 无 errcode 无 processQueryKey 的响应 → 软失败 message_key_missing（v1.74.4：不再硬判 invalid_response）', async () => {
    // v1.74.4 修复：钉钉新版 batchSend 成功不返 errcode，原"无 errcode 一律 invalid_response 硬失败"会误判正常成功响应。
    //   新契约：无 errcode 时以 processQueryKey 为成功凭据；无 processQueryKey 的畸形响应走 message_key_missing 软失败
    //   （server.js C3 据此返 502 提示重试，对用户行为与原硬失败一致——都不会落 sent）。
    const cases = [
        [{}, '{} 缺 errcode'],
        [{ errmsg: 'x' }, 'errmsg-only'],
        [{ errcode: null }, '{errcode:null}（Number(null)===0 陷阱）'],
        [{ errcode: '' }, "{errcode:''}（Number('')===0 陷阱）"],
        [{ errcode: false }, '{errcode:false}（Number(false)===0 陷阱）'],
        [{ errcode: undefined }, '{errcode:undefined}'],
    ];
    for (const [resp, desc] of cases) {
        dingtalkNotify.sendMarkdownToUser = async () => resp;
        const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
        assert.strictEqual(r.success, true, desc + ' 无 errcode → 不再硬失败');
        assert.strictEqual(r.message_key, null, desc + ' 无 processQueryKey → message_key 为 null');
        assert.strictEqual(r.message_key_missing, true, desc + ' 应标 message_key_missing 软失败（C3 返 502 重试）');
    }
});
await check('检查6e3 sendIssueMarkdown 钉钉新版成功响应（无 errcode + processQueryKey）→ success（v1.74.4 修复核心：原 bug 在此被误判失败）', async () => {
    // 生产实证响应：{flowControlledStaffIdList:[],invalidStaffIdList:[],filteredStaffIdList:[],processQueryKey:"..."}
    dingtalkNotify.sendMarkdownToUser = async () => ({
        flowControlledStaffIdList: [], invalidStaffIdList: [], filteredStaffIdList: [], processQueryKey: 'pqk_real'
    });
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true, '无 errcode + 有 processQueryKey 必须判成功（这正是被误判的 bug）');
    assert.strictEqual(r.message_key, 'pqk_real', 'processQueryKey 作 message_key');
    assert.strictEqual(r.message_key_missing, false, '有 processQueryKey 不标 missing');
});
await check('检查6e4 非纯数字/非零 errcode 字符串 → 一律失败（codex #1：避免被吞成软成功）', async () => {
    // codex 复审 #1：'-1' / ' 88' / '42001 ' / 'abc' 等非纯数字或带空格的 errcode 不能被当成"无业务码"软成功
    const cases = [
        ['-1', '负数字符串'],
        [' 88', '前导空格数字'],
        ['42001 ', '尾随空格 token 过期码'],
        ['abc', '非数字异常码'],
        [88, '纯数字非0（user_invalid）'],
    ];
    for (const [ecVal, desc] of cases) {
        dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: ecVal, errmsg: 'x' });
        const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
        assert.strictEqual(r.success, false, desc + '(' + JSON.stringify(ecVal) + ') 应判失败，不得软成功');
    }
    // 边界：纯空格 errcode 视同空（无业务码）→ 不因它判失败（应走 processQueryKey 判定）
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: '  ', processQueryKey: 'k' });
    const r2 = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r2.success, true, "'  ' 纯空格 errcode 视同无业务码 → 有 processQueryKey 仍成功");
});
await check('检查6e5 有 processQueryKey 但目标用户在失败列表 → 失败（codex #2 high：未送达不得误判成功）', async () => {
    // codex 复审 #2 high：对齐 dingtalkSendOk（server.js:15080）——单聊目标用户落入任一失败列表 = 钉钉没真送达
    dingtalkNotify.sendMarkdownToUser = async () => ({ processQueryKey: 'pqk', invalidStaffIdList: ['u'] });
    let r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false, 'invalidStaffIdList 含目标 → 失败');
    assert.strictEqual(r.reason, 'user_invalid', 'reason=user_invalid');
    assert.strictEqual(r.clearUserId, true, 'uid 失效应清缓存重查');

    dingtalkNotify.sendMarkdownToUser = async () => ({ processQueryKey: 'pqk', flowControlledStaffIdList: ['u'] });
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false, 'flowControlled 含目标 → 失败');
    assert.strictEqual(r.reason, 'rate_limit', 'reason=rate_limit');

    dingtalkNotify.sendMarkdownToUser = async () => ({ processQueryKey: 'pqk', filteredStaffIdList: ['u'] });
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false, 'filtered 含目标 → 失败');

    // 边界：失败列表存在但不含目标用户（如多人发送中别人失败）→ 目标仍成功
    dingtalkNotify.sendMarkdownToUser = async () => ({ processQueryKey: 'pqk', invalidStaffIdList: ['other'] });
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true, '失败列表不含目标用户 → 目标仍成功');
});
await check('检查6e2 sendIssueMarkdown errcode===0 / "0" 字符串 + processQueryKey 判成功（兼容老版 oapi 成功响应）', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: 0, processQueryKey: 'k1' });
    let r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true, 'errcode=0 成功');
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: '0', processQueryKey: 'k2' });
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true, "errcode='0' 字符串也成功");
});
await check('检查6f sendIssueMarkdown 成功但 processQueryKey 缺失 → 标 message_key_missing', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => ({ errcode: 0 }); // 成功但无 processQueryKey
    const r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, true, 'errcode=0 仍成功');
    assert.strictEqual(r.message_key, null);
    assert.strictEqual(r.message_key_missing, true, '缺 key 应标记让 C3 决策');
});

// 检查 7：参数缺失防御
await check('检查7 sendIssueMarkdown 缺参数 → bad_args 不发送（含 title/markdown，codex 08 L-2）', async () => {
    dingtalkNotify.sendMarkdownToUser = async () => { throw new Error('不应被调用'); };
    // 缺 dingUserId
    let r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', title: 'T', markdown: 'M' });
    assert.strictEqual(r.success, false); assert.strictEqual(r.errcode, 'bad_args');
    assert.ok(r.reason.includes('dingUserId'), 'reason 标明缺 dingUserId');
    // 缺 title（L-2 新增覆盖）
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', markdown: 'M' });
    assert.strictEqual(r.success, false); assert.ok(r.reason.includes('title'), 'reason 标明缺 title');
    // 缺 markdown（L-2 新增覆盖）
    r = await issueNotify.sendIssueMarkdown({ token: 't', robotCode: 'r', dingUserId: 'u', title: 'T' });
    assert.strictEqual(r.success, false); assert.ok(r.reason.includes('markdown'), 'reason 标明缺 markdown');
});

// 还原 mock
dingtalkNotify.sendMarkdownToUser = realSend;

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C2 issue-notify 全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('验证脚本异常:', e); process.exit(1); });
