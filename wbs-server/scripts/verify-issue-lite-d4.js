/**
 * D4 verify e2e · 数据开发换壳（issue_lite）拉群守卫
 * 换壳方案 v0.2 · D4 / docs/local/HANDOFF.md 附录 A
 *
 * ⚠️ 拉群会真建钉钉群——本 verify **只测钉钉调用前的守卫**（权限/幂等/id），绝不触发真建群。
 *    真建群 e2e 需用户在场（会真拉群）。授权路径靠"预置 open_conv_id 幂等短路"安全验证。
 * [#106 S3b] 不再自 spawn 在写死的 3399、不再按端口杀进程、不再读写真实库：经 scripts/lib/test-env.js 自起临时隔离实例
 *   （来源 = 本检出本地库快照，钉钉走替身、周期任务关闭），也可由 TEST_* 变量组指向已起好的隔离实例；跑完收掉实例并清理测试单。
 */
'use strict';
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const DEV_ID = 10; // 示例开发C
const TITLE_PREFIX = '[D4VERIFY]';

let BASE = null;
let DB_FILE = null;

let pass = 0, fail = 0; const results = [];
function check(name, cond, detail) { if (cond) { pass++; results.push(`  ✅ ${name}`); } else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); } }
async function api(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}
function cleanupRows() {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE); db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); res(); }); });
}
function setOpenConv(id, val) {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE); db.run(`UPDATE issue_lite SET dingtalk_open_conversation_id=?, dingtalk_chat_id=?, dingtalk_chat_name=? WHERE id=?`, [val, 'cid_' + id, '[数据开发]测试群', id], () => { db.close(); res(); }); });
}
const REQ = { requester_name: '王五', requester_dept: '交付运营部', requester_phone: '13700003333' };
function bodyWith(extra) { return Object.assign({ title: TITLE_PREFIX + '单' }, REQ, extra || {}); }

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句（静态守卫硬规则，S3b 修复批 2a）：失败直接落到末尾的 .catch（打印并以非零退出），不会先吞掉失败再继续做 I/O
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪
    let ready = false;
    try {
        BASE = fx.BASE;
        DB_FILE = fx.DB_PATH;
        await cleanupRows();
        // 未带 token 访问 issue_lite 列表须 401：服务确实在应答 issue_lite 路由（不是别的服务占着端口）
        ready = (await api('GET', '/api/issue-lite', null)).status === 401;
        check('服务 + schema 就绪', ready);
        if (!ready) throw new Error('服务未就绪');

        const adminTok = await fx.signAs(fx.ADMIN_ID);   // 1 admin（建单人）
        const fengTok = await fx.signAs(fx.CONTACT_ID);  // 3 示例用户A（非建单人·非示例开发C·群主但无拉群权）
        const devTok = await fx.signAs(DEV_ID);          // 10 示例开发C
        const viewerTok = await fx.signAs(fx.VIEWER_ID);

        // 造单（admin 建）
        const id = (await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '拉群单' }))).body.issue.id;

        // 守卫：id 非法 / 不存在 / viewer / 无权
        check('id 非法 → 400', (await api('POST', '/api/issue-lite/abc/create-chat', adminTok, {})).status === 400);
        check('不存在单 → 404', (await api('POST', '/api/issue-lite/999999/create-chat', adminTok, {})).status === 404);
        check('viewer 拉群 → 403', (await api('POST', `/api/issue-lite/${id}/create-chat`, viewerTok, {})).status === 403);
        // 示例用户A(3)：非建单人(admin=1) 且非示例开发C(10) → 403 NOT_ALLOWED（即便他是群主也无拉群权）
        check('非建单人非示例开发C(示例用户A) → 403 NOT_ALLOWED', (await api('POST', `/api/issue-lite/${id}/create-chat`, fengTok, {})).body.code === 'NOT_ALLOWED');

        // 幂等短路（预置 open_conv）→ 授权路径安全验证（不触发真钉钉）
        await setOpenConv(id, 'openconv_test_123');
        // 建单人(admin) 拉 → 过权限 → 幂等返回
        let r = await api('POST', `/api/issue-lite/${id}/create-chat`, adminTok, {});
        check('建单人拉·已建群 → 200 idempotent', r.status === 200 && r.body.idempotent === true && r.body.open_conversation_id === 'openconv_test_123', JSON.stringify(r.body));
        // 示例开发C 拉 → 过权限（isDeveloper）→ 幂等返回（验证示例开发C有拉群权·不触发真钉钉）
        r = await api('POST', `/api/issue-lite/${id}/create-chat`, devTok, {});
        check('示例开发C拉·已建群 → 200 idempotent（示例开发C有拉群权）', r.status === 200 && r.body.idempotent === true, JSON.stringify(r.body));

        // 末次审 M-2：已归档单拉群 → 409 ARCHIVED_LOCKED（在幂等/钉钉前）
        const id2 = (await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '归档拉群单' }))).body.issue.id;
        await api('PUT', `/api/issue-lite/${id2}/status`, adminTok, { status: '已归档' });
        check('已归档单拉群 → 409 ARCHIVED_LOCKED', (await api('POST', `/api/issue-lite/${id2}/create-chat`, adminTok, {})).body.code === 'ARCHIVED_LOCKED');

    } catch (e) { check('e2e 执行异常', false, e.message); }
    finally {
        if (DB_FILE) await cleanupRows();
        try { await fx.teardown(); } catch (e) { check('teardown（收掉自起实例）', false, e.message); }
    }
    console.log('─────── D4 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ D4 PASS' : '❌ D4 FAIL'}（${pass} 通过 / ${fail} 失败）·真建群 e2e 需在场`);
    fx.finish(fail === 0 ? 0 : 1);   // 成功路径：finally 里已 await teardown；只设退出码、让事件循环自然结束（见 lib/test-env.js finish）
})().catch(async (e) => {
    // ready() 失败（或收尾阶段的意外异常）：打印并以非零退出；teardown 在 ready 失败时没有实例可收，失败也不再抛
    console.error('D4 verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
