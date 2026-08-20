/**
 * S4 前端 Playwright 冒烟——数据开发台账页（Issue_Lite.html）Ctrl+V 贴图共享层接入
 * 方案 docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二/§三
 * 对齐 test-sys-paste-playwright.js / test-quick-log-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 覆盖（S4 交付物 §3 最低要求 5 项）：
 *   T1 抽屉打开、唯一目标 #attList 可见 → 纯图粘贴自动收入，走既有 uploadAttach（无前端预校验，
 *      直接调用既有上传函数、真实 POST /api/issue-lite/:id/attachments 落库，附件清单刷新）
 *   T2 抽屉打开，焦点在页面其他可编辑元素（搜索框）+ 图文混合粘贴 → 放行，不触发上传
 *   T3 抽屉打开 + 页面注入第二个假目标区（真实调用 UPaste.register，非 mock 被测逻辑）→ 2 候选+无点击
 *      记忆不猜，toast UPaste.MSG_MULTI_NO_MEMORY（S1b·R2：S6 起记忆命中则归属，本用例未点击任何候选，
 *      天然落无记忆分支）
 *   T4 抽屉关闭（position:fixed 平移出视口，非 display:none）→ 粘贴不收（M1 同款空作用域哨兵验证点，
 *      toast UPaste.MSG_NO_CANDIDATE）
 *   T5 全程 0 console error
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-issue-lite-paste-playwright.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const PREFIX = '[ILPWTEST]';

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `il-paste-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); } catch (_) { /* ignore */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// codex S4 复审 MED-2 采纳：imageCount 支持一次粘贴装多张图（默认 1，向后兼容原调用点）。
async function dispatchPaste(page, { withImage = true, imageCount = 1, withText = false, textValue = '', textType = 'text/plain', focusSelector = null } = {}) {
    return page.evaluate(({ b64, withImage, imageCount, withText, textValue, textType, focusSelector }) => {
        const dt = new DataTransfer();
        if (withImage) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            for (let n = 0; n < imageCount; n++) {
                dt.items.add(new File([bytes], 'clipboard-image-' + n, { type: 'image/png' }));
            }
        }
        if (withText) dt.items.add(textValue, textType);
        if (focusSelector) { const el = document.querySelector(focusSelector); if (el) el.focus(); }
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.dispatchEvent(evt);
        return { defaultPrevented: evt.defaultPrevented };
    }, { b64: TINY_PNG_B64, withImage, imageCount, withText, textValue, textType, focusSelector });
}

function dbRun(sql, params) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.run(sql, params || [], function (err) { db.close(); resolve({ err, lastID: this && this.lastID }); });
    });
}
function dbAll(sql, params) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.all(sql, params || [], function (err, rows) { db.close(); resolve(err ? [] : (rows || [])); });
    });
}

const UPLOAD_DIR = path.join(ROOT, 'uploads');
const ISSUE_LITE_UPLOAD_SUBDIR = path.resolve(UPLOAD_DIR, 'issue-lite');

// codex S6 复审 HIGH 采纳：删表行前先按测试单据的附件 file_name 解析磁盘实际落盘路径并物理删除，
// 防止反复跑本套件在 uploads/issue-lite 下无界累积残留文件。越界防御：解析出的绝对路径必须真落在
// uploads/issue-lite 子目录内才删；不在子目录内（file_name 异常/被篡改）只 warn 跳过，不越界删除。
// 返回本次“尝试删除”的绝对路径清单，供 main() finally 后做“物理文件确已不存在”的闭环断言。
async function cleanupTestAttachmentFiles() {
    const rows = await dbAll(
        `SELECT file_name FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`,
        [PREFIX + '%']);
    const attempted = [];
    for (const row of rows) {
        const fileName = row && row.file_name;
        if (!fileName) continue;
        const fullPath = path.resolve(UPLOAD_DIR, fileName);
        if (!fullPath.startsWith(ISSUE_LITE_UPLOAD_SUBDIR + path.sep)) {
            console.log(`  ⚠️  跳过越界路径（不在 uploads/issue-lite 子目录内，不删）: file_name="${fileName}" → 解析后="${fullPath}"`);
            continue;
        }
        attempted.push(fullPath);
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {
            console.log(`  ⚠️  物理文件删除失败: ${fullPath}（${e.message}）`);
        }
    }
    return attempted;
}

async function cleanup() {
    const attemptedPaths = await cleanupTestAttachmentFiles();
    try { await dbRun(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [PREFIX + '%']); } catch (_) { /* ignore */ }
    try { await dbRun(`DELETE FROM issue_lite WHERE title LIKE ?`, [PREFIX + '%']); } catch (_) { /* ignore */ }
    return attemptedPaths;
}

async function main() {
    await cleanup();
    const adminTok = await fx.signAs(fx.ADMIN_ID);
    console.log('\n══════ S4 前端 Playwright 冒烟（数据开发台账 贴图共享层接入） ══════');

    const browser = await chromium.launch();
    try {
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Issue_Lite.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // 造一条测试单（走真实建单 API，需求方三字段齐全，避免走到「自主发起默认值」以外的分支）
        const created = await page.evaluate(async (prefix) => {
            const r = await fetch('/api/issue-lite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ title: prefix + '贴图接入测试单', requester_name: '测试员', requester_dept: '市场营销部', requester_phone: '13800001111' }),
            });
            const j = await r.json().catch(() => ({}));
            return { ok: r.ok, id: j && j.issue && j.issue.id };
        }, PREFIX);
        await shotOnFail(page, created.ok && !!created.id, 't0-fixture-created', `前置：造测试单成功（实得=${JSON.stringify(created)}）`);
        const issueId = created.id;

        // ═══════════════════════════════════════════════════════════
        // T1：抽屉打开、唯一目标 #attList 可见 → 纯图粘贴自动收入，真实走 uploadAttach 上传落库
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1：抽屉打开，纯图粘贴自动收入并真实上传 ──');
        await page.evaluate((id) => openDrawer(id), issueId);
        await page.waitForSelector('#drawer.open', { timeout: 5000 });
        await page.waitForTimeout(400);
        const attListVisible = await page.locator('#attList').isVisible();
        await shotOnFail(page, attListVisible, 't1-target-visible', `T1 前置：#attList 可见（实得=${attListVisible}）`);
        const r1 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1.defaultPrevented === true, 't1-default-prevented', `T1 defaultPrevented=true（实得=${r1.defaultPrevented}）`);
        await page.waitForTimeout(800);   // 真实网络上传 + loadAttachments 刷新，多留时间
        const attListText1 = await page.locator('#attList').textContent();
        await shotOnFail(page, /粘贴截图_/.test(attListText1 || ''), 't1-uploaded-and-listed', `T1 上传成功后附件清单出现"粘贴截图_"文件名（实得="${(attListText1 || '').trim().slice(0, 80)}"）`);
        const attCountText1 = await page.locator('#attCount').textContent();
        await shotOnFail(page, (attCountText1 || '').includes('1'), 't1-count-updated', `T1 附件计数徽标更新为含 1（实得="${attCountText1}"）`);

        // ═══════════════════════════════════════════════════════════
        // T1b（codex S4 复审 MED-2 采纳）：一次粘贴 2 张图 → 恰好新增 2 个"粘贴截图_"附件。
        //   同时是 MED-1（codex 曾疑"busy 锁吞多图第二张"，主会话核实为误报）的实证反证：collect 回调
        //   内 `for...of` + `await uploadAttach(...)` 顺序等待整个 async 函数（含 finally 释放 busy），
        //   若锁真的会吞图，这里应该只新增 1 个而非 2 个。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1b：一次粘贴 2 张图 → 顺序 await 全部收入，busy 锁不吞图 ──');
        const beforeCount1b = await page.evaluate(() => (drawerAtts || []).length);
        const r1b = await dispatchPaste(page, { withImage: true, imageCount: 2 });
        await shotOnFail(page, r1b.defaultPrevented === true, 't1b-default-prevented', `T1b defaultPrevented=true（实得=${r1b.defaultPrevented}）`);
        await page.waitForTimeout(1200);   // 两次真实网络上传顺序 await，多留时间
        const afterCount1b = await page.evaluate(() => (drawerAtts || []).length);
        await shotOnFail(page, afterCount1b === beforeCount1b + 2, 't1b-both-uploaded', `T1b 一次粘贴2张图 → 附件清单恰好新增 2 个，非 1 个（前=${beforeCount1b}，后=${afterCount1b}）`);
        const pasteNamedCount1b = await page.evaluate(() => (drawerAtts || []).filter(a => /^粘贴截图_/.test(a.original_name || '')).length);
        await shotOnFail(page, pasteNamedCount1b === afterCount1b, 't1b-names-prefixed', `T1b 全部附件均以"粘贴截图_"命名（贴图命名数=${pasteNamedCount1b}，附件总数=${afterCount1b}）`);

        // ═══════════════════════════════════════════════════════════
        // T2（S2·第三缺陷修复语义反转，拍板出处 memory paste_defect_leads.md 2026-08-20 用户决策之二·
        //   双通道投递）：焦点在页面其他可编辑元素（搜索框）+ 图文混合粘贴 → 双通道：文本不拦截 + 图片
        //   同步投递（抽屉打开时 #attList 是唯一候选，单候选场景恒归属，无需先点击）。原断言"附件清单
        //   未变化（未误传）"把丢图钉死在案，需反转——搜索框仍是本页唯一有意义的可编辑焦点入口，图文
        //   混合贴图不该因为焦点恰好不在附件区就把图片吞掉。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T2：焦点在搜索框 + 图文混合粘贴 → 双通道（文本不拦截+图片同步投递到 attList/真实上传） ──');
        const searchSelector = (await page.locator('#filterSearch').count()) > 0 ? '#filterSearch' : 'input[type="text"]';
        const beforeCount2 = await page.evaluate(() => (drawerAtts || []).length);
        const r2 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '搜索关键词混合粘贴', focusSelector: searchSelector });
        await shotOnFail(page, r2.defaultPrevented === false, 't2-default-not-prevented', `T2 文本通道：e.defaultPrevented=false（不拦截，实得=${r2.defaultPrevented}）`);
        await page.waitForTimeout(800);   // 真实网络上传 + loadAttachments 刷新，同 T1 留时间
        const afterCount2 = await page.evaluate(() => (drawerAtts || []).length);
        await shotOnFail(page, afterCount2 === beforeCount2 + 1, 't2-image-delivered', `T2 图片通道：图片同步投递并真实上传到 attList，附件数 +1（前=${beforeCount2}/后=${afterCount2}，若实现退化回旧版丢图这条会红）`);
        const attListText2 = await page.locator('#attList').textContent();
        await shotOnFail(page, /粘贴截图_/.test(attListText2 || ''), 't2-image-listed', `T2 图片通道：上传成功后附件清单出现"粘贴截图_"文件名（实得="${(attListText2 || '').trim().slice(0, 80)}"）`);

        // ═══════════════════════════════════════════════════════════
        // T3：注入第二个假目标区（真实调用 UPaste.register，非 mock 被测逻辑）→ 2 候选不猜，toast
        // ═══════════════════════════════════════════════════════════
        // S1b·R2 预筛修复：S6 起"2 候选"不再恒拒——记忆命中则归属，仅"2 候选+无点击记忆"才拒绝
        //   （拍板出处：memory paste_defect_leads.md 2026-08-20 A1 拍板）。本用例全程未点击 #attList
        //   或注入的假目标区，天然落在"无记忆"分支，断言改为同源引用 UPaste.MSG_MULTI_NO_MEMORY。
        // S1c·L6 预筛旁注：#ilFakePasteTarget 直接挂在 document.body 下，未传 clickScopeOf ⇒ 按
        //   candidateHost 缺省回落 el.parentElement ⇒ 该假候选的"宿主"就是 document.body——意味着
        //   本 register/unregister 窗口内（201-215 行）**任意一次点击**（不管点在页面哪里）都会命中
        //   这个假候选，若同时还命中另一个真候选（如 #attList），就会构成"命中数≥2"的歧义，被歧义守卫
        //   拦下不写记忆。窗口内**勿新增**依赖点击记忆归属（lastClickedKey）生效/不生效的用例——这个假
        //   候选会把结果搅浑，真要测点击记忆归属请照 test-corr-paste-playwright.js 的 T3c/T3d 范式另起
        //   独立场景（点击真实候选自己的宿主容器，不与本类"挂 body 的假候选"共存）。
        console.log('\n── T3：注入第二个可见候选目标 + 未点击(无记忆) → 拒绝，toast MSG_MULTI_NO_MEMORY ──');
        await page.evaluate(() => {
            const d = document.createElement('div');
            d.id = 'ilFakePasteTarget';
            d.style.cssText = 'position:fixed;top:10px;left:10px;width:10px;height:10px;';
            document.body.appendChild(d);
            window.__ilFakeUnregister = UPaste.register({ selector: '#ilFakePasteTarget', collect: () => {} });
        });
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r3 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r3.defaultPrevented === true, 't3-default-prevented', `T3 仍 preventDefault（实得=${r3.defaultPrevented}）`);
        await page.waitForTimeout(400);
        const toast3 = await page.locator('#toast-container').textContent().catch(() => '');
        const msgMultiNoMemory3 = await page.evaluate(() => UPaste.MSG_MULTI_NO_MEMORY);
        await shotOnFail(page, toast3.includes(msgMultiNoMemory3), 't3-toast', `T3 toast 含 UPaste.MSG_MULTI_NO_MEMORY（同源引用="${msgMultiNoMemory3}"，实得="${toast3}"）`);
        await page.evaluate(() => { window.__ilFakeUnregister(); const el = document.getElementById('ilFakePasteTarget'); if (el) el.remove(); });

        // ═══════════════════════════════════════════════════════════
        // T4：抽屉关闭（position:fixed 平移出视口）→ 粘贴不收（M1 同款空作用域哨兵）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T4：抽屉关闭 → 粘贴不收（M1 空作用域哨兵，防误判"仍可见"） ──');
        await page.evaluate(() => closeDrawer());
        await page.waitForTimeout(300);
        const drawerOpenCount4 = await page.locator('#drawer.open').count();
        await shotOnFail(page, drawerOpenCount4 === 0, 't4-drawer-closed', `T4 前置：抽屉已关闭（实得=${drawerOpenCount4}）`);
        // 关键验证点：即便抽屉是 position:fixed 平移出视口（非 display:none），getClientRects 仍会报告
        // "有布局盒"——若 scopeResolver 没有显式返回空作用域哨兵，这里会错误地把 #attList 判成可见候选。
        const attListStillHasRects = await page.evaluate(() => document.getElementById('attList').getClientRects().length > 0);
        await shotOnFail(page, attListStillHasRects, 't4-precondition-rects', `T4 前置确认：#attList 关闭态仍有 ClientRects（证明必须靠显式作用域哨兵，非可见性判定本身就能拦，实得=${attListStillHasRects}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r4 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r4.defaultPrevented === true, 't4-default-prevented', `T4 无可判定目标仍 preventDefault（实得=${r4.defaultPrevented}）`);
        await page.waitForTimeout(400);
        const toast4 = await page.locator('#toast-container').textContent().catch(() => '');
        const msgNoCandidate4 = await page.evaluate(() => UPaste.MSG_NO_CANDIDATE);
        await shotOnFail(page, toast4.includes(msgNoCandidate4), 't4-toast', `T4 toast 含 UPaste.MSG_NO_CANDIDATE（同源引用="${msgNoCandidate4}"，实得="${toast4}"）`);

        // ═══════════════════════════════════════════════════════════
        // T5：全程 0 console error
        // ═══════════════════════════════════════════════════════════
        await shotOnFail(page, page._consoleErrors.length === 0, 't5-console-clean', `T5 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
        const cleanedPaths = await cleanup();
        // codex S6 复审 HIGH 采纳：清理闭环——不能只信"表行删了"，实证磁盘上测试单据对应的附件物理文件
        // （本轮 T1/T1b 真实上传落库的贴图）也确已不存在，防止 DB 干净但 uploads/issue-lite 无界堆积。
        const stillOnDisk = cleanedPaths.filter(p => fs.existsSync(p));
        // codex S6 定点复审 MED 采纳：attempted 必须 ≥1——本套件 T1/T1b 必真实上传附件，若"0 个尝试删除"
        // 说明 file_name 落库契约变了（纯文件名/绝对路径/带 uploads 前缀等被越界防御跳过），此时"残留=0"
        // 是假绿，必须红灯逼人重看清理路径解析，而不是静默通过。
        must(cleanedPaths.length >= 1, `清理闭环前置：至少尝试删除 1 个物理文件（实得=${cleanedPaths.length}——为 0 说明 file_name 契约变化被越界防御全跳过）`);
        must(stillOnDisk.length === 0, `清理闭环：测试单据对应附件物理文件已不存在（尝试删=${cleanedPaths.length} 个，仍残留=${stillOnDisk.length}${stillOnDisk.length ? '：' + stillOnDisk.join(' | ') : ''}）`);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 数据开发台账贴图接入 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 数据开发台账贴图接入 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
