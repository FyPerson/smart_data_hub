/**
 * C4 UI 验证（Playwright）· 数据开发换壳 入口切换
 * 换壳方案 v0.1 §5 C4 / _HANDOFF
 *
 * 验证：
 *   - 导航"数据开发"指向 /Issue_Lite.html（换壳后 13 页统一，抽查几页）
 *   - admin：头像下拉含"🗂️ 数据开发（完整版）"→ /Issue_Tracker.html（重型页挪 admin 下拉）
 *   - 非 admin(示例用户A user)：下拉不含"数据开发（完整版）"
 *   - 重型页 Issue_Tracker.html 对 admin 仍可正常加载（原封不动）
 *
 * 自启 PORT=3399，跑完按端口精确杀。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${detail || ''}`); } }
function killPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set(); out.split(/\r?\n/).forEach(l => { const m = l.trim().match(/(\d+)\s*$/); if (m) pids.add(m[1]); });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}
async function loginGoto(context, token, page_path) {
    const page = await context.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}${page_path}`, { waitUntil: 'load' });
    return page;
}

(async () => {
    killPort(TEST_PORT);
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    const deadline = Date.now() + 12000; let ready = false;
    while (Date.now() < deadline) {
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(log)) { try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) { ready = true; break; } } catch (_) {} }
        await new Promise(r => setTimeout(r, 400));
    }
    ok('服务就绪', ready);

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
        await browser.close();
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
    }

    console.log(`\n总判定：${fail === 0 ? '✅ C4 UI PASS' : '❌ C4 UI FAIL'}（${pass} 通过 / ${fail} 失败）`);
    process.exit(fail === 0 ? 0 : 1);
})();
