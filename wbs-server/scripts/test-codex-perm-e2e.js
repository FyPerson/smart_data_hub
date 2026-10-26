/**
 * codex 十六审 #1 #2 权限收敛回归测试（2026-05-19）
 *
 * 用法：node scripts/test-codex-perm-e2e.js
 * 前置：[#106 S3b] 经 test-env 自起临时隔离实例（来源 = 本检出本地库快照，里面要有协作单作前置数据；没有则 SKIP 退出 0——这是本脚本原有口径）。
 *   不再打 3000、不再读真实库 / 真实 .env。
 *
 * 覆盖：
 *   P1 admin 查任意 detail → 200
 *   P2 dev1 查不属于自己的 detail → 403（codex #1）
 *   P3 contact 查自己作为对接人的 detail → 200
 *   P4 dev1 查自己作为开发的 detail → 200
 *   P5 dev1 不传 my_role 查列表 → 仅返自己的单（codex #2）
 *   P6 contact 不传 my_role 查列表 → 仅返自己的单
 *   P7 非 admin 用 developer_id 查他人单 → 403（codex #2）
 *   P8 contact 在 PENDING 状态调 notify → 不是 403（codex #3）
 *   P9 admin 在 PENDING_ASSIGN 状态调 notify → 不是 403（codex #6 配套）
 *   P10 dev1 在 PENDING 状态调 notify → 403（确认权限收紧后开发不能自己 notify）
 */
'use strict';

const testEnv = require('./lib/test-env');

const ADMIN_ID = 1;
const CONTACT_ID = 3;     // 示例用户A user
const DEV1_ID = 19;       // 示例用户B user

// 被测服务地址 / 实例库 / 实例密钥都来自 test-env（ready() 完成之前不可用）；签 token 用实例库里的 users 行 + 实例密钥
async function loginAs(userId) {
    return testEnv.signToken(userId);
}

async function apiCall(method, path, token, body = null) {
    const opts = { method, headers: { 'Authorization': `Bearer ${token}` } };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${testEnv.env().baseUrl}${path}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

/**
 * 取到的协作单列表的判定（纯函数；verify-test-env 的静态守卫把它从源码里抽出来做表驱动单测，不实跑本脚本）：
 *   200 且确为数组且长度 0 → 'SKIP'（原有口径：库里没有协作单作前置数据）；200 且为非空数组 → 'OK'；
 *   其余一律 'FAIL'——非 200、响应体不是数组（null / 对象 / 字符串）、没有响应，都不能当成 SKIP 退出 0（否则服务挂了 / 鉴权坏了会显示成「跳过」）。
 */
function classifyCollabList(res) {
    if (!res || res.status !== 200 || !Array.isArray(res.body)) return 'FAIL';
    return res.body.length === 0 ? 'SKIP' : 'OK';
}

// 收尾：先收掉自起的实例（await teardown），再用 testEnv.finish(code) 设退出码并让进程自然结束；teardown 失败计失败。
//   finish 只设退出码、不终止执行，调用点之后必须是 return 或函数结束。静态守卫的 FINISH_NOT_LAST 不覆盖这里的本地包装函数 finish，调用点靠人工核对：
//   入口函数里 gate 为 FAIL、gate 为 SKIP 两处提前收尾之后都 return，末尾汇总处一处是入口函数的最后一条语句。
async function finish(code) {
    try { await testEnv.teardown(); } catch (e) { console.error('teardown 失败：' + e.message); code = code || 1; }
    testEnv.finish(code);   // teardown 已落定（成功或失败都已处理）；只设退出码、让事件循环自然结束（见 lib/test-env.js finish）
}

(async () => {
    let pass = 0, fail = 0;
    const check = (name, ok, detail) => {
        const tag = ok ? '✅' : '❌';
        if (ok) pass++; else fail++;
        console.log(`${tag} ${name} — ${detail}`);
    };

    await testEnv.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    const adminTok = await loginAs(ADMIN_ID);
    const contactTok = await loginAs(CONTACT_ID);
    const dev1Tok = await loginAs(DEV1_ID);

    // 取 admin 拉全部列表数据
    const allRes = await apiCall('GET', '/api/collab/requests?my_role=admin', adminTok);
    // [#106 S3b 修复批 2a] 判定见 classifyCollabList：非 200 / 响应结构异常（不是数组）都是失败（退出码非零），只有「200 且确为数组且长度 0」才 SKIP 退出 0
    const gate = classifyCollabList(allRes);
    if (gate === 'FAIL') {
        console.error(`FAIL: 取协作单列表失败或响应结构异常（status=${allRes.status} body=${JSON.stringify(allRes.body === undefined ? null : allRes.body).slice(0, 160)}）`);
        await finish(1);
        return;
    }
    if (gate === 'SKIP') {
        console.log('SKIP: 当前无协作单，请先跑 test-collab-two-level-e2e.js 准备数据');
        await finish(0);
        return;
    }
    console.log(`准备数据：${allRes.body.length} 条单`);

    // P1 admin 看任意 detail → 200
    const sample = allRes.body[0];
    {
        const r = await apiCall('GET', `/api/collab/requests/${sample.id}`, adminTok);
        check('P1 admin 看任意 detail', r.status === 200, `status=${r.status}`);
    }

    // P2 dev1 看不属于自己的 detail（找一个 contact 不是 19、developer 不是 19 的单）
    const dev1Outsider = allRes.body.find(r =>
        Number(r.contact_person_id) !== DEV1_ID &&
        (Number(r.developer_id) !== DEV1_ID || Number(r.developer_id) === 0)
    );
    if (dev1Outsider) {
        const r = await apiCall('GET', `/api/collab/requests/${dev1Outsider.id}`, dev1Tok);
        check('P2 dev1 看外人 detail → 403',
              r.status === 403,
              `#${dev1Outsider.id} (contact=${dev1Outsider.contact_person_id} dev=${dev1Outsider.developer_id}) → status=${r.status} code=${r.body && r.body.code}`);
    } else {
        console.log('SKIP P2: 没找到 dev1 视角"外人"单');
    }

    // P3 contact 看自己作为对接人的 detail
    const contactOwn = allRes.body.find(r => Number(r.contact_person_id) === CONTACT_ID);
    if (contactOwn) {
        const r = await apiCall('GET', `/api/collab/requests/${contactOwn.id}`, contactTok);
        check('P3 contact 看自己的 detail', r.status === 200, `#${contactOwn.id} → status=${r.status}`);
    }

    // P4 dev1 看自己作为开发的 detail
    const dev1Own = allRes.body.find(r => Number(r.developer_id) === DEV1_ID);
    if (dev1Own) {
        const r = await apiCall('GET', `/api/collab/requests/${dev1Own.id}`, dev1Tok);
        check('P4 dev1 看自己的 detail', r.status === 200, `#${dev1Own.id} → status=${r.status}`);
    }

    // P5 dev1 不传 my_role 查列表
    {
        const r = await apiCall('GET', '/api/collab/requests', dev1Tok);
        const allSelf = r.body && r.body.every(item =>
            Number(item.contact_person_id) === DEV1_ID ||
            (Number(item.developer_id) === DEV1_ID && Number(item.developer_id) !== 0)
        );
        check('P5 dev1 默认列表仅返自己', r.status === 200 && allSelf,
              `count=${r.body && r.body.length} all_self=${allSelf}`);
    }

    // P6 contact 不传 my_role 查列表
    {
        const r = await apiCall('GET', '/api/collab/requests', contactTok);
        const allSelf = r.body && r.body.every(item =>
            Number(item.contact_person_id) === CONTACT_ID ||
            (Number(item.developer_id) === CONTACT_ID && Number(item.developer_id) !== 0)
        );
        check('P6 contact 默认列表仅返自己', r.status === 200 && allSelf,
              `count=${r.body && r.body.length} all_self=${allSelf}`);
    }

    // P7 非 admin 用 developer_id 查他人单
    {
        const r = await apiCall('GET', '/api/collab/requests?developer_id=8', dev1Tok);
        check('P7 dev1 查他人 developer_id → 403',
              r.status === 403,
              `status=${r.status} err=${r.body && r.body.error}`);
    }

    // P8 contact 在 PENDING 状态调 notify（钉钉可能因 phone 配置失败，但应不是 403）
    const pendingOwn = allRes.body.find(r => r.status === 'PENDING' && Number(r.contact_person_id) === CONTACT_ID);
    if (pendingOwn) {
        const r = await apiCall('POST', `/api/collab/requests/${pendingOwn.id}/notify`, contactTok);
        check('P8 contact 在 PENDING 调 notify → 不是 403',
              r.status !== 403,
              `#${pendingOwn.id} → status=${r.status} code=${r.body && r.body.code} err=${r.body && r.body.error}`);
    } else {
        console.log('SKIP P8: 没找到 contact=3 的 PENDING 单');
    }

    // P9 admin 在 PENDING_ASSIGN 状态调 notify
    const pendingAssign = allRes.body.find(r => r.status === 'PENDING_ASSIGN');
    if (pendingAssign) {
        const r = await apiCall('POST', `/api/collab/requests/${pendingAssign.id}/notify`, adminTok);
        check('P9 admin 在 PENDING_ASSIGN 调 notify → 不是 403',
              r.status !== 403,
              `#${pendingAssign.id} → status=${r.status} code=${r.body && r.body.code} err=${r.body && r.body.error}`);
    } else {
        console.log('SKIP P9: 没找到 PENDING_ASSIGN 单');
    }

    // P10 dev1 在 PENDING 状态调 notify（即使是被指派的本人，方案 §6 也不允许 dev 自己通知自己）
    const pendingDev1 = allRes.body.find(r => r.status === 'PENDING' && Number(r.developer_id) === DEV1_ID);
    if (pendingDev1) {
        const r = await apiCall('POST', `/api/collab/requests/${pendingDev1.id}/notify`, dev1Tok);
        check('P10 dev1 在 PENDING 调 notify → 403',
              r.status === 403,
              `#${pendingDev1.id} → status=${r.status} code=${r.body && r.body.code}`);
    } else {
        console.log('SKIP P10: 没找到 dev1 是开发的 PENDING 单');
    }

    console.log(`\n=== 汇总 ${pass} pass / ${fail} fail ===`);
    await finish(fail > 0 ? 1 : 0);
})().catch(async e => {
    console.error('ERROR:', e.message);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(2);
});
