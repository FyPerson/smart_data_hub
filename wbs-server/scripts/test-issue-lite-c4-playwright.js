/**
 * C4 UI 验证（Playwright）· 数据开发换壳 入口切换
 * 换壳方案 v0.1 §5 C4 / docs/local/HANDOFF.md 附录 A
 *
 * 验证：
 *   - 导航"数据开发"指向 /Issue_Lite.html（换壳后 13 页统一，抽查几页）
 *   - admin：头像下拉含"🗂️ 数据开发（完整版）"→ /Issue_Tracker.html（重型页挪 admin 下拉）
 *   - 非 admin(示例用户A user)：下拉不含"数据开发（完整版）"
 *   - 重型页 Issue_Tracker.html 对 admin 仍可正常加载（原封不动）
 *
 * [#106 S4b1] 不再自 spawn 服务、不再写死端口 3399、不再按端口杀进程、不再等日志轮询：经 scripts/lib/test-env.js 自起临时隔离实例
 *   （来源 = 本检出本地库快照），也可由 TEST_* 变量组指向已起好的隔离实例；浏览器在 ready 之后才启动，页面地址由 ready 之后的 BASE 拼出。
 */
'use strict';
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let BASE = null;   // ready() 之后赋值
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${detail || ''}`); } }
async function issueLiteServiceReady() {
    try {
        const hr = await fetch(`${BASE}/api/health/ready`);
        const hb = await hr.json().catch(() => null);
        const m = hb && hb.modules && hb.modules.issue_lite;
        if (!m || m.ready !== true) return false;
        return (await fetch(`${BASE}/api/issue-lite`)).status === 401;
    } catch (_) { return false; }
}
async function loginGoto(context, token, page_path) {
    const page = await context.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}${page_path}`, { waitUntil: 'load' });
    return page;
}

(async () => {
    await fx.ready();   // 先于任何网络请求 / 浏览器：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪
    BASE = fx.BASE;
    // 服务就绪 = 两次真实请求：health/ready 里 issue_lite 模块 ready + 未带 token 访问列表 401（服务确实在应答 issue_lite 路由）
    const ready = await issueLiteServiceReady();
    ok('health/ready issue_lite 就绪 + 未带 token 列表 401', ready);

    const browser = await chromium.launch();
    try {
        const adminTok = await fx.signAs(fx.ADMIN_ID);   // 1 admin
        const userTok = await fx.signAs(fx.CONTACT_ID);  // 3 示例用户A user

        // admin 视角：抽查 Dashboard + Data_Collab 的 nav 指向 + 下拉
        const ctxA = await browser.newContext();
        const pageA = await loginGoto(ctxA, adminTok, '/Dashboard.html');
        await pageA.waitForTimeout(1200);
        const navHref = await pageA.locator('a.nav-item:has-text("数据开发")').getAttribute('href').catch(() => null);
        ok('Dashboard 导航"数据开发"→ /Issue_Lite.html', navHref === '/Issue_Lite.html', `href=${navHref}`);
        // 下拉"数据开发（完整版）"（DOM 存在即可，无需 hover 展开）
        const fullEntry = pageA.locator('.dropdown-content a:has-text("数据开发（完整版）")');
        const fullCount = await fullEntry.count();
        const fullHref = fullCount ? await fullEntry.getAttribute('href') : null;
        ok('admin 下拉含"数据开发（完整版）"→ /Issue_Tracker.html', fullCount > 0 && fullHref === '/Issue_Tracker.html', `count=${fullCount} href=${fullHref}`);
        await ctxA.close();

        // admin 直接开重型页：仍正常加载（原封不动）
        const ctxA2 = await browser.newContext();
        const errsHeavy = [];
        const pageHeavy = await loginGoto(ctxA2, adminTok, '/Issue_Tracker.html');
        pageHeavy.on('console', m => { if (m.type() === 'error') errsHeavy.push(m.text()); });
        await pageHeavy.waitForTimeout(1500);
        const heavyTitle = await pageHeavy.title();
        const heavyTable = await pageHeavy.locator('#issueListTable').count();
        ok('重型页 Issue_Tracker 对 admin 仍可加载（标题+表格在）', heavyTitle.includes('数据开发') && heavyTable > 0, `title=${heavyTitle} table=${heavyTable}`);
        ok('重型页无 console error', errsHeavy.length === 0, errsHeavy.slice(0, 3).join(' | '));
        await ctxA2.close();

        // 非 admin 视角：下拉不含"数据开发（完整版）"
        const ctxU = await browser.newContext();
        const pageU = await loginGoto(ctxU, userTok, '/Dashboard.html');
        await pageU.waitForTimeout(1200);
        const userFull = await pageU.locator('.dropdown-content a:has-text("数据开发（完整版）")').count();
        ok('非 admin 下拉不含"数据开发（完整版）"', userFull === 0, `count=${userFull}`);
        const navHrefU = await pageU.locator('a.nav-item:has-text("数据开发")').getAttribute('href').catch(() => null);
        ok('非 admin 导航"数据开发"→ /Issue_Lite.html', navHrefU === '/Issue_Lite.html');
        await ctxU.close();

    } catch (e) {
        ok('C4 UI 执行', false, e.message);
    } finally {
        try { await browser.close(); } catch (_) { /* 浏览器已关闭 */ }
        try { await fx.teardown(); } catch (e) { ok('teardown（收掉自起实例）', false, e.message); }
    }

    console.log(`\n总判定：${fail === 0 ? '✅ C4 UI PASS' : '❌ C4 UI FAIL'}（${pass} 通过 / ${fail} 失败）`);
    fx.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + 10 秒 unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('C4 UI 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
