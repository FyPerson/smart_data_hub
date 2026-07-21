/**
 * D5 UI 冒烟（Playwright）· 数据开发换壳 Issue_Lite.html v0.2
 * 换壳 v0.2 · D5 / _HANDOFF
 *
 * 验证（纯 UI；后端逻辑由 D2/D3/D4 verify 覆盖）：建单全字段→列表需求方列→状态流转(处理中)→
 *   完成弹窗(说明+看板)→已完成渲染完成说明→附件上传/列表/删除→无 console error→viewer 隐藏建单。
 * ⚠️ 不点通知/拉群按钮（避免真钉钉）。自启 PORT=3399·跑完按端口精确杀 + 清理测试单/附件。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const SHOT = path.join(process.env.TEMP || '/tmp', 'issue-lite-d5.png');
const TITLE_PREFIX = '[D5UI]';

let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d || ''}`); } }
function killPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set(); out.split(/\r?\n/).forEach(l => { const m = l.trim().match(/(\d+)\s*$/); if (m) pids.add(m[1]); });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}
function cleanupRows() {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE); db.serialize(() => { db.run(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [TITLE_PREFIX + '%'], () => {}); db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); res(); }); }); });
}
async function loginAs(ctx, token) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}/Issue_Lite.html`, { waitUntil: 'load' });
    return page;
}

(async () => {
    killPort(TEST_PORT); await cleanupRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); }); child.stderr.on('data', d => { log += d.toString(); });
    const deadline = Date.now() + 12000; let ready = false;
    while (Date.now() < deadline) { if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(log)) { try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) { ready = true; break; } } catch (_) {} } await new Promise(r => setTimeout(r, 400)); }
    ok('服务就绪', ready);

    const browser = await chromium.launch();
    try {
        const adminTok = await fx.signAs(fx.ADMIN_ID);
        const viewerTok = await fx.signAs(fx.VIEWER_ID);
        const ctx = await browser.newContext();
        const errors = [];
        const page = await loginAs(ctx, adminTok);
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('dialog', d => d.accept());
        await page.waitForTimeout(1000);

        ok('标题正确', (await page.title()).includes('数据开发'));
        ok('新建登记按钮可见(非 viewer)', await page.locator('#btnNew').isVisible());

        // 建单全字段
        await page.click('#btnNew'); await page.waitForTimeout(300);
        ok('建单弹窗打开', await page.locator('#createModal.open').isVisible());
        const createModalText = await page.locator('#createModal').innerText();
        ok('建单弹窗统一为期望完成时间', createModalText.includes('期望完成时间') && !createModalText.includes('需求完成时间'));
        const t = TITLE_PREFIX + '合同取数';
        await page.fill('#fTitle', t);
        await page.fill('#fReqName', '赵六');
        await page.fill('#fReqDept', '市场营销部');
        await page.fill('#fReqPhone', '13811112222');
        await page.fill('#fReqDate', '2026-08-18');
        await page.fill('#fOa', '364265');
        await page.selectOption('#fNotifyTarget', '10');
        await page.fill('#fDesc', 'D5 UI 描述');
        await page.click('#btnSubmitCreate');
        await page.waitForTimeout(900);
        ok('建单后详情抽屉打开', await page.locator('#drawer.open').isVisible());
        // 列表：需求方列 + ID 带 # + 无附件/群列
        await page.click('#drawerOverlay'); await page.waitForTimeout(300);
        const rowHtml = await page.locator(`#ilTableBody tr:has-text("${t}")`).innerHTML().catch(() => '');
        ok('列表出现新单 + 需求方列(市场营销部 赵六)', rowHtml.includes('市场营销部') && rowHtml.includes('赵六'), rowHtml.slice(0, 80));
        ok('列表 ID 带 # 前缀', rowHtml.includes('#'));
        const heads = await page.locator('#issueLiteTable thead').innerText();
        ok('列表表头统一为期望完成时间', heads.includes('期望完成时间') && !heads.includes('需求完成时间'), heads.replace(/\n/g, '|'));
        ok('列表表头有 预计完成时间 + 无 附件/群', heads.includes('预计完成时间') && heads.includes('创建时间') && !heads.includes('附件') && !heads.includes('群'), heads.replace(/\n/g, '|'));

        // 打开详情：顶部操作栏进入预计完成弹窗 → 自动进处理中（对齐数据修正范式）
        await page.click(`#ilTableBody tr:has-text("${t}")`); await page.waitForTimeout(500);
        const beforeEta = await page.locator('#drawerBody').innerText();
        const detailCreatedAt = await page.locator('.il-detail-item:has(> label:text-is("创建时间")) .val').innerText();
        ok('详情显示期望完成时间且无旧文案', beforeEta.includes('期望完成时间') && beforeEta.includes('2026-08-18') && !beforeEta.includes('需求完成时间'));
        ok('详情显示非空创建时间值', /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(detailCreatedAt.trim()), detailCreatedAt);
        ok('预计回填入口位于顶部操作栏且无独立编辑区', (await page.locator('#drawerBody > .u-action-bar button:has-text("回复预计完成")').count()) === 1 && (await page.locator('#drawerBody > .u-detail-section h3:has-text("预计完成时间")').count()) === 0);
        // 单据仍在待处理态时，非开发非管理员不能看到回填入口（验证 can_estimate 前后端契约，不靠终态隐藏）。
        const ctx3 = await browser.newContext();
        const page3 = await loginAs(ctx3, await fx.signAs(fx.CONTACT_ID)); await page3.waitForTimeout(800);
        await page3.goto(`${BASE}/Issue_Lite.html?id=${await page.evaluate(() => currentDrawerId)}`, { waitUntil: 'load' }); await page3.waitForTimeout(700);
        ok('待处理态非开发非管理员不显示预计回填入口', (await page3.locator('#drawerBody button:has-text("预计完成")').count()) === 0);
        await ctx3.close();
        await page.click('#drawerBody > .u-action-bar button:has-text("回复预计完成")');
        ok('预计完成弹窗打开', await page.locator('#estimateModal.open').isVisible());
        await page.fill('#ilEtaInput', '2026-08-20');
        await page.click('#btnSubmitEstimate'); await page.waitForTimeout(800);
        const afterEta = await page.locator('#drawerBody').innerText();
        ok('回填预计 → 自动进处理中 + 显示预计时间', afterEta.includes('处理中') && afterEta.includes('2026-08-20'));
        ok('通知区有「通知业务方·预计」行', afterEta.includes('通知业务方·预计'));

        // 标记完成弹窗
        await page.click('#drawerBody button:has-text("标记完成")'); await page.waitForTimeout(300);
        ok('完成弹窗打开', await page.locator('#completeModal.open').isVisible());
        await page.fill('#cNote', '已完成取数并交付Excel文件一份');
        await page.fill('#cBoard', 'https://bi.example.com/board/9');
        await page.click('#btnSubmitComplete'); await page.waitForTimeout(800);
        const dbody = await page.locator('#drawerBody').innerText();
        ok('完成后渲染完成说明 + 已完成态', dbody.includes('已完成') && dbody.includes('已完成取数并交付Excel文件一份'));
        // 通知区（照数据修正范式）：通知 section + 业务方通知行显人名 + 发送通知按钮
        ok('详情有「通知」区 + 业务方行显需求人名 + 发送通知按钮',
            dbody.includes('通知') && dbody.includes('赵六') && (await page.locator('#drawerBody button:has-text("发送通知")').count()) > 0);
        ok('详情有「讨论群」区 + 拉群按钮', dbody.includes('讨论群') && (await page.locator('#drawerBody button:has-text("拉群讨论")').count()) > 0);

        // 附件上传
        const newId = await page.evaluate(() => currentDrawerId);
        await page.evaluate(id => { document.getElementById('attachInput').dataset.issueId = id; }, newId);
        await page.setInputFiles('#attachInput', { name: '交付说明.txt', mimeType: 'text/plain', buffer: Buffer.from('hello d5') });
        await page.waitForTimeout(900);
        ok('附件上传后出现在附件区', (await page.locator('#attList').innerText()).includes('交付说明.txt'));
        // 删除附件
        await page.click('#attList .del'); await page.waitForTimeout(700);
        ok('附件删除后消失', (await page.locator('#attList').innerText()).includes('暂无附件'));

        await page.screenshot({ path: SHOT, fullPage: true });
        ok('截图已保存', true, SHOT);
        ok('无 console error', errors.length === 0, errors.slice(0, 3).join(' | '));
        await ctx.close();

        // viewer：建单按钮隐藏
        const ctx2 = await browser.newContext();
        const page2 = await loginAs(ctx2, viewerTok); await page2.waitForTimeout(800);
        ok('viewer 建单按钮隐藏', !(await page2.locator('#btnNew').isVisible()));
        await ctx2.close();
    } catch (e) { ok('UI 冒烟执行', false, e.message); }
    finally { await browser.close(); try { child.kill('SIGKILL'); } catch (_) {} killPort(TEST_PORT); await cleanupRows(); }

    console.log(`\n总判定：${fail === 0 ? '✅ D5 UI PASS' : '❌ D5 UI FAIL'}（${pass} 通过 / ${fail} 失败）·截图 ${SHOT}`);
    process.exit(fail === 0 ? 0 : 1);
})();
