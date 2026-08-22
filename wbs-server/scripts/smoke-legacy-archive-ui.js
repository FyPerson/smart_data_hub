/**
 * 历史台账归档 Playwright 冒烟——独立页 Legacy_Archive.html（A4）
 * 方案 SSOT：docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §5/§6/§7
 * A3 已冻结的四端点 API 契约：routes/legacy-archive/index.js
 *
 * harness 范式对齐：
 *   - JWT 注入 + login.html 中继跳转（照 test-quick-log-playwright.js/test-sys-paste-playwright.js
 *     同款：鉴权页直接 goto 会被 checkAuth 销毁 context）
 *   - 真库导入一个批次 + --activate（照 scripts/verify-legacy-archive-api.js 同款"真库 + 彻底清理"
 *     范式，含 MED1 现存 active 批次保护/恢复——若跑本脚本时 dev 库已有真实 active 批次，会在
 *     finally 里把它的 active 状态恢复回来，不让"跑一次冒烟"变成"悄悄改动了生产可见的活动批次"）。
 *     复用 A2 已产出的 manifest/payload（tmp/legacy-archive-manifest.json + tmp/legacy-archive-payload/），
 *     不重新跑 Python 提取，直接跑 Node 装载脚本 import-legacy-archive.js。
 *
 * 用法：node scripts/smoke-legacy-archive-ui.js
 *   端口 3000 若已有服务在跑（本分支代码）则直接复用，不重复起服务、结束时也不关闭；
 *   若未起，本脚本会自行 spawn server.js 并在结束时关闭 + 释放端口。
 *
 * 覆盖（45 项理论满值断言，动态扣减环境依赖分支后对拍，含 codex 10/11 两号审查采纳的加固）：
 *   T0  无 active 批次时（导入前）：横幅显示 notice + 不渲染任何 tab
 *   T1  admin-only 页面级守卫：非 admin 直接 goto 被拒（alert+跳转 Task_Pool.html）+ 全程零
 *       /api/legacy-archive/* 请求 + 全局导航 admin 下拉含「历史台账归档」入口 → /Legacy_Archive.html，
 *       非 admin 下拉不含；admin 正常进入不被跳转
 *   T2  8 个数据集 tab 渲染 + bug_list tab 显示 row_count=8232
 *   T3  bug_list 默认列表：每页 50 行 + 分页栏显示"共 8232 条"
 *   L1  徽章双向：已知无图行在默认（未筛选）第一页不显示 📷 徽章（正向命中行显示徽章见 T5）
 *   M2守卫（codex 11）：抽屉代际令牌负向自证——模拟快速连点两行（page.evaluate 直触发
 *       window.laOpenDrawer，fire-and-forget），先点行响应被人为拖慢 1200ms，断言其迟到响应到达后
 *       不覆盖已渲染的后点行内容（feedback_async_callback_session_token 范式）
 *   T4  关键字筛选：命中数与服务端 LIKE 查询独立复算一致（服务端筛选生效，非前端假筛选）
 *   T5  含图行精确显示 📷 image_count 徽章（按 row id 定位，非"某行有"，数字与库内 images 数组长度一致）
 *   T6  行详情抽屉：字段数=18(list)+2(detail)=20 + 恰 2 个 detail 字段标注"旁注列"（none 字段不显示文本）
 *   M2字段集合（codex 10）：DOM 实际展示字段名集合精确等于 rows/:id API 独立复算的 18+2 个 list/detail
 *       字段名（非只比数量）+ 显式证一个 none 字段名（如某图片外溢列）不出现在抽屉 DOM 内
 *   T7  截图：抽屉内图片 blob 回填数与库内 images 数组长度一致 + 鼠标点击灯箱打开/关闭
 *   M3截图键盘（codex 11）a11y：聚焦截图缩略图后 Enter 打开灯箱 + Escape 逐层关闭（先关灯箱、
 *       再关抽屉）
 *   L3  负向自证：mock 图片端点返回 200 但 Content-Type: text/html（模拟反代/中间件异常兜底页）→
 *       前端 blob.type mime 校验生效，0 张 <img> 被创建、全部降级"图缺失"占位，不渲染破图
 *   T8  切换 tab：bms_maint 分页栏显示"共 378 条" + 搜索框被清空（鼠标点击）
 *   M3tab键盘（codex 11）a11y：方向键在 tablist 内移动焦点并即时切换数据集（roving tabindex：
 *       仅当前 tab tabindex=0，切换后焦点随之移动到新的当前 tab）
 *   T9  全程 0 console error（两页面，非 admin 页面豁免既有落地页噪音）
 *   finally  M1①：导入成功即赋值 batchId（不等激活也成功），保证激活失败时 finally 仍能定位清理；
 *            M1②+M4（codex 11 新增 datasets/rows 两表逐表复核）：cleanupBatch 抛异常/DELETE 有
 *            错误/legacy_archive_batches|datasets|rows 三表任一未归零/目录未删/原 active 批次未
 *            恢复，均计入 must() 断言（fail>0 → 非零退出），不再只打日志静默吞掉清理失败
 *   末尾  M1（codex 11）动态断言总数锚：EXPECTED_ASSERTIONS = MAX_ASSERTIONS(45) - skippedAssertions
 *         （T0/L1/M2字段集合三处环境依赖分支各自的跳过数），与真实 must() 触发总数对拍
 *
 * 清理：finally 里彻底清理本次导入的批次（三表 DELETE + uploads/legacy-archive/<batch_id>/ 目录）+
 *   若测试前已有 active 批次则恢复其 active 状态；照 verify-legacy-archive-api.js
 *   cleanupBatch/removeDirManual 同款范式（本机 fs.rmSync 递归对大目录静默 no-op 的已知环境缺陷，
 *   同源复用手写递归实现）——清理结果本身也是断言（见上方 M1②+M4），不是纯日志。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync, spawn, execSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const TEST_PORT = 3000;
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'task_pool.db');
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'legacy-archive-playwright-shots');

const ADMIN_ID = fx.ADMIN_ID;      // 1，admin
const NONADMIN_ID = fx.CONTACT_ID; // 3，role=user（非 admin）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res) => db.run(sql, params, function (e) { res({ err: e, changes: this && this.changes }); }));

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `legacy-archive-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: p, fullPage: true });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图失败不影响主流程 */ }
    }
}
// 成功路径也留证——feedback_layer_green 变体三纪律：造完观察数据必回看真实 DOM，不只信断言绿。
async function shotAlways(page, name) {
    try {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const p = path.join(SCREENSHOT_DIR, `legacy-archive-${name}.png`);
        await page.screenshot({ path: p, fullPage: true });
        console.log(`     📸 留证截图: ${p}`);
        return p;
    } catch (_) { return null; }
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => {
        if (m.type() === 'error') {
            const loc = m.location() || {};
            consoleErrors.push({ text: m.text(), url: loc.url || '' });
        }
    });
    page.on('pageerror', e => consoleErrors.push({ text: 'pageerror: ' + e.message, url: '' }));
    const dialogMessages = [];
    page.on('dialog', d => { dialogMessages.push(d.message()); d.accept(); });
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    page._dialogMessages = dialogMessages;
    return page;
}

// netstat 精确端口比较（findstr 子串匹配会误命中，对齐 verify-legacy-archive-api.js/verify-quick-log 范式）
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(line => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ } });
    } catch (_) { /* ignore */ }
}

function execFileSyncSafe(cmd, args) {
    try {
        return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT }) };
    } catch (e) {
        return { ok: false, out: (e && e.stdout ? String(e.stdout) : '') + '\n' + (e && e.stderr ? String(e.stderr) : ''), message: e && e.message };
    }
}

// ---- 目录彻底清理（逐字对齐 verify-legacy-archive-api.js removeDirManual/removeDirWithRetry：
//   本机 fs.rmSync 对含大量文件的目录静默 no-op 的已知环境缺陷，手写递归 unlink + symlink/junction
//   只删链接节点本身不递归进目标 + EPERM 只读位重试）----
function removeDirManual(dir) {
    const rootSt = fs.lstatSync(dir);
    if (rootSt.isSymbolicLink()) {
        try { fs.unlinkSync(dir); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir); else throw e; }
        return;
    }
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
        const full = path.join(dir, name);
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) {
            try { fs.unlinkSync(full); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(full); else throw e; }
            continue;
        }
        if (st.isDirectory()) { removeDirManual(full); continue; }
        try {
            fs.unlinkSync(full);
        } catch (e) {
            if (e && e.code === 'EPERM') { fs.chmodSync(full, 0o666); fs.unlinkSync(full); } else throw e;
        }
    }
    fs.rmdirSync(dir);
}
async function removeDirWithRetry(dir, { maxRetries = 5 } = {}) {
    if (!fs.existsSync(dir)) return true;
    const delays = [50, 100, 200, 300, 300];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (!fs.existsSync(dir)) return true;
        try { removeDirManual(dir); if (!fs.existsSync(dir)) return true; } catch (_) { /* 单文件级瞬时锁，下一轮重试 */ }
        await new Promise((res) => setTimeout(res, delays[attempt] || 300));
    }
    return !fs.existsSync(dir);
}

// ---- 前置：往真实 dev 库导一个批次（M1①·codex 10 采纳：拆成"导入"与"激活"两步，导入成功即
//   可拿到 batchId 并交给调用方立刻赋值给外层变量——不等激活也成功才赋值。若激活随后失败，外层
//   batchId 已经落地，finally 仍能找到并清理这个"已导入未激活"的半成品批次，不会在真库留下孤儿数据）----
async function importBatchOnly() {
    const preMaxRow = await dbGet(`SELECT MAX(id) AS m FROM legacy_archive_batches`);
    const preMax = (preMaxRow && preMaxRow.m) || 0;

    const importResult = execFileSyncSafe('node', ['scripts/import-legacy-archive.js']);
    if (!importResult.ok) throw new Error(`前置导入失败（import-legacy-archive.js）：${importResult.message}\n${importResult.out}`);

    let batchId = null;
    const m = /batch #(\d+) 导入完成并置 verified/.exec(importResult.out);
    if (m) {
        batchId = Number(m[1]);
    } else {
        const newRows = await dbAll(`SELECT id FROM legacy_archive_batches WHERE id > ? ORDER BY id ASC`, [preMax]);
        if (!newRows || newRows.length !== 1) {
            throw new Error(`前置导入未能从输出中解析出 batch id，兜底查询（id > ${preMax}）也未能唯一确认新增批次（实得 ${JSON.stringify(newRows)}）：\n${importResult.out}`);
        }
        batchId = newRows[0].id;
        console.log(`⚠️ [兜底] 前置导入输出文案未匹配到预期正则，改用 id>preMax(${preMax}) 兜底拿到 batch #${batchId}`);
    }
    return batchId;
}

// ---- 前置：激活已导入的批次（独立于 importBatchOnly，见上方 M1① 注释） ----
async function activateBatch(batchId) {
    const activateResult = execFileSyncSafe('node', ['scripts/import-legacy-archive.js', '--activate', String(batchId)]);
    if (!activateResult.ok) throw new Error(`前置激活失败（--activate ${batchId}）：${activateResult.message}\n${activateResult.out}`);
    const statusRow = await dbGet(`SELECT status FROM legacy_archive_batches WHERE id = ?`, [batchId]);
    if (!statusRow || statusRow.status !== 'active') {
        throw new Error(`前置激活后 db 查证 batch #${batchId} 状态非 active（实得 ${statusRow ? statusRow.status : '(不存在)'}）：\n${activateResult.out}`);
    }
}

async function cleanupBatch(batchId) {
    if (!batchId) return { dirRemoved: null, deleteErrors: [], datasetIds: [] };
    const deleteErrors = [];
    const datasetRows = await dbAll(`SELECT id FROM legacy_archive_datasets WHERE batch_id = ?`, [batchId]);
    // M4（codex 11 采纳）：把删除前记下的 dataset id 列表也返回给调用方——datasets 表本身删完之后就
    // 再也无法用 batch_id join 出这批 dataset_id 了，finally 里要逐表复核 legacy_archive_rows 是否
    // 真归零，必须在这里（删除动作之前）就把 datasetIds 保存下来随结果带出去。
    const datasetIds = (datasetRows || []).map(r => r.id);
    for (const ds of (datasetRows || [])) {
        const r = await dbRun(`DELETE FROM legacy_archive_rows WHERE dataset_id = ?`, [ds.id]);
        if (r.err) deleteErrors.push(`DELETE rows(dataset_id=${ds.id}): ${r.err.message}`);
    }
    const dsDel = await dbRun(`DELETE FROM legacy_archive_datasets WHERE batch_id = ?`, [batchId]);
    if (dsDel.err) deleteErrors.push(`DELETE datasets(batch_id=${batchId}): ${dsDel.err.message}`);
    const batchDel = await dbRun(`DELETE FROM legacy_archive_batches WHERE id = ?`, [batchId]);
    if (batchDel.err) deleteErrors.push(`DELETE batches(id=${batchId}): ${batchDel.err.message}`);
    const dir = path.join(ROOT, 'uploads', 'legacy-archive', String(batchId));
    const dirRemoved = await removeDirWithRetry(dir);
    return { dir, dirRemoved, deleteErrors, datasetIds };
}

async function waitReady(getLog, ms = 20000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (/\[历史台账归档\] ✅ .*legacy-archive 接口放行/.test(getLog())) {
            try { const r = await fetch(`${BASE_URL}/api/legacy-archive/datasets`); if (r.status === 401) return true; } catch (_) { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

// 服务端 escapeLikeKeyword 逐字复刻（routes/legacy-archive/index.js），供 T4 独立复算命中数用——
// 不信任"UI 显示了数字"本身，必须与服务端 LIKE 语义独立算一遍核对，防"前端显示对了但其实没真筛"。
function escapeLikeKeyword(s) {
    return String(s || '').replace(/[\\%_]/g, m => '\\' + m);
}

// 从样本行 search_text 挑一个"服务端 LIKE 命中数 <= 50（保证全部命中落在默认第一页）"的筛选词——
// 优先短词，短词命中数超阈值就换更长的切片收窄，避免因命中行过多导致样本行（唯一已知含图的行）
// 被分页挤出第一页，让 T5 badge 断言产生偶发 flaky。
async function pickDistinctiveTerm(datasetId, searchText) {
    const base = String(searchText || '').trim();
    if (!base) return null;
    for (const len of [4, 6, 8, 10, 14, 20, 30, 50]) {
        const term = base.slice(0, len).trim();
        if (!term) continue;
        const escTerm = escapeLikeKeyword(term.toLowerCase());
        const row = await dbGet(
            `SELECT COUNT(*) c FROM legacy_archive_rows WHERE dataset_id = ? AND search_text LIKE ? ESCAPE '\\'`,
            [datasetId, '%' + escTerm + '%']
        );
        const count = row ? row.c : null;
        if (count !== null && count >= 1 && count <= 50) return { term, count };
    }
    return null;
}

async function main() {
    let batchId = null;
    let ownServer = null;
    let ownServerLog = '';
    let originalActiveId = null;
    // M1（codex 11 采纳）：EXPECTED_ASSERTIONS 从写死的常量改为动态——三处分支（T0/L1/M2 none 字段）
    // 依赖运行时环境条件（当时 dev 库有没有 active 批次/默认第一页有没有无图行/bug_list 有没有非空
    // name 的 none 字段），条件不满足时对应断言会被跳过而非计入 fail。跳过几条就从理论满值里减几条，
    // 而不是死钉一个只在"全部条件都命中"这一种环境下才成立的数字——避免"已有 active 批次场景下锚点
    // 必然判红"这种自相矛盾。见文末锚点计算处 MAX_ASSERTIONS + skippedAssertions。
    let skippedAssertions = 0;
    console.log('\n══════ 历史台账归档 Playwright 冒烟（独立页 Legacy_Archive.html） ══════');

    // ===== 前置：确认/启动 server =====
    let serverAlreadyUp = false;
    try {
        const r = await fetch(`${BASE_URL}/api/legacy-archive/datasets`);
        serverAlreadyUp = (r.status === 401 || r.status === 200);
    } catch (_) { serverAlreadyUp = false; }
    if (!serverAlreadyUp) {
        console.log('[前置] 端口 3000 未起服务，自行 spawn server.js（本分支代码）…');
        killPort(TEST_PORT);
        ownServer = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
        ownServer.stdout.on('data', d => { ownServerLog += d.toString(); });
        ownServer.stderr.on('data', d => { ownServerLog += d.toString(); });
        const ready = await waitReady(() => ownServerLog);
        if (!ready) { console.error('❌ server 未就绪：' + ownServerLog.slice(-2000)); process.exit(1); }
        console.log('[前置] server 已就绪（本脚本自起，结束时会关闭）');
    } else {
        console.log('[前置] 端口 3000 已有服务在跑，复用（本脚本不负责关闭它）');
    }

    const browser = await chromium.launch();
    try {
        const adminTok = await fx.signAs(ADMIN_ID);
        const nonAdminTok = await fx.signAs(NONADMIN_ID);

        // MED1：记录测试前是否已有 active 批次——若有，本次 import+activate 会把它 retire 掉
        // （runActivate 既定语义），finally 里需要把它的 active 状态恢复回来，不能让"跑一次冒烟"
        // 变成"悄悄改动了生产可见的活动批次"。当前 dev 库实测无 active 批次，但防线不依赖这个当前事实。
        const originalActiveRow = await dbGet(`SELECT id FROM legacy_archive_batches WHERE status = 'active'`);
        originalActiveId = originalActiveRow ? originalActiveRow.id : null;
        if (originalActiveId) console.log(`[前置·MED1] 检测到已存在 active 批次 #${originalActiveId}，本次冒烟完成后会恢复其 active 状态`);
        else console.log('[前置·MED1] 当前无 active 批次，冒烟完成后无需恢复');

        // ═══════════════════════════════════════════════
        // T0：导入前——无 active 批次，前端渲染 notice 横幅 + 不渲染任何 tab
        // ═══════════════════════════════════════════════
        console.log('\n── T0：无 active 批次 → 横幅 notice + 无 tab ──');
        if (originalActiveId) {
            skippedAssertions += 2; // M1：T0 两条断言依赖"当时无 active 批次"这个环境条件，条件不满足则跳过
            console.log('  ⚠️ 已存在 active 批次，无法构造"无批次"态，T0 两条断言计为跳过（不计入 pass/fail，已同步计入 skippedAssertions）');
        } else {
            const t0Page = await loginPage(browser, adminTok);
            await t0Page.goto(`${BASE_URL}/Legacy_Archive.html`);
            await t0Page.waitForLoadState('networkidle');
            await t0Page.waitForTimeout(500);
            const bannerText = await t0Page.locator('#laBanner').textContent().catch(() => '');
            await shotOnFail(t0Page, /暂无活动归档批次/.test(bannerText || ''), 't0-notice-banner', `T0 无 active 批次时横幅含"暂无活动归档批次"（实得="${bannerText}"）`);
            const tabsEmpty = await t0Page.locator('.la-tab').count();
            await shotOnFail(t0Page, tabsEmpty === 0, 't0-no-tabs', `T0 无 active 批次时不渲染任何 tab（实得=${tabsEmpty}）`);
            await shotAlways(t0Page, 't0-empty-banner');
            await t0Page.close();
        }

        // ===== 前置：真实导入 + 激活（真库） =====
        console.log('\n[前置] 导入一个批次（真实 dev 库，复用已产出的 manifest/payload）…');
        // M1①：导入成功即赋值给外层 batchId——即便下一步 activateBatch 抛错，finally 也能定位并清理
        // 这个"已导入未激活"的半成品批次，不留孤儿数据在真库。
        batchId = await importBatchOnly();
        console.log(`[前置] batch #${batchId} 已导入（pending→verified）`);
        await activateBatch(batchId);
        console.log(`[前置] batch #${batchId} 已激活（active）`);

        // 采样：bug_list 内一行带图片的样本行（供 T4/T5/T6/T7 复用）
        const sampleRow = await dbGet(
            `SELECT r.id, r.row_index, r.excel_row, r.images, r.search_text, d.id AS dataset_id
               FROM legacy_archive_rows r
               JOIN legacy_archive_datasets d ON r.dataset_id = d.id
              WHERE d.batch_id = ? AND d.dataset_key = 'bug_list' AND r.images IS NOT NULL AND r.images != '[]'
              ORDER BY r.id ASC LIMIT 1`,
            [batchId]
        );
        if (!sampleRow) throw new Error('前置采样失败：batch #' + batchId + ' 的 bug_list 内未找到任何带图片的行');
        const sampleImages = JSON.parse(sampleRow.images);
        const termInfo = await pickDistinctiveTerm(sampleRow.dataset_id, sampleRow.search_text);
        if (!termInfo) throw new Error('前置采样失败：样本行 search_text 找不到"服务端 LIKE 命中数 <=50"的筛选词');
        console.log(`[前置] 样本行 id=${sampleRow.id} excel_row=${sampleRow.excel_row} 含图 ${sampleImages.length} 张；筛选词="${termInfo.term}" 服务端预期命中 ${termInfo.count} 行`);

        // ═══════════════════════════════════════════════
        // T1：admin-only 页面级守卫 + 全局导航入口
        // ═══════════════════════════════════════════════
        console.log('\n── T1：非 admin 访问被拒 + admin 正常进入 + 全局导航 admin 下拉入口 ──');
        const naPage = await loginPage(browser, nonAdminTok);
        const naRequests = [];
        naPage.on('request', req => naRequests.push(req.url()));
        await naPage.goto(`${BASE_URL}/Legacy_Archive.html`);
        await naPage.waitForLoadState('networkidle');
        await naPage.waitForTimeout(500);
        const naFinalUrl = naPage.url();
        await shotOnFail(naPage, naFinalUrl.includes('/Task_Pool.html'), 't1a-na-redirected', `T1a 非 admin 访问 Legacy_Archive.html 被拒并跳转 Task_Pool.html（实得落地=${naFinalUrl}）`);
        await shotOnFail(naPage, naPage._dialogMessages.some(m => m.includes('需要管理员权限')), 't1a-na-alert', `T1a 弹出「需要管理员权限」提示（实得=${JSON.stringify(naPage._dialogMessages)}）`);
        const naHitApi = naRequests.some(u => u.includes('/api/legacy-archive/'));
        await shotOnFail(naPage, naHitApi === false, 't1a-na-no-request', `T1a 非 admin 全程零 /api/legacy-archive/* 请求（实得命中=${naHitApi}，请求总数=${naRequests.length}）`);
        const naMenuCnt = await naPage.locator('.dropdown a[href="/Legacy_Archive.html"]').count();
        await shotOnFail(naPage, naMenuCnt === 0, 't1c-na-no-menu', `T1c 非 admin 下拉菜单不含「历史台账归档」入口（实得=${naMenuCnt}）`);

        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Legacy_Archive.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        const adminFinalUrl = page.url();
        await shotOnFail(page, adminFinalUrl.includes('/Legacy_Archive.html'), 't1b-admin-not-redirected', `T1b admin 访问 Legacy_Archive.html 未被跳转（实得落地=${adminFinalUrl}）`);
        const adminMenuCnt = await page.locator('.dropdown a[href="/Legacy_Archive.html"]').count();
        await shotOnFail(page, adminMenuCnt === 1, 't1c-admin-menu', `T1c admin 下拉菜单含「历史台账归档」入口（实得=${adminMenuCnt}）`);

        // ═══════════════════════════════════════════════
        // T2：8 个数据集 tab + bug_list row_count
        // ═══════════════════════════════════════════════
        console.log('\n── T2：8 个数据集 tab 渲染 ──');
        const tabCount = await page.locator('.la-tab').count();
        await shotOnFail(page, tabCount === 8, 't2-eight-tabs', `T2 页面渲染 8 个数据集 tab（实得=${tabCount}）`);
        const bugTabText = await page.locator('.la-tab[data-key="bug_list"]').textContent().catch(() => '');
        await shotOnFail(page, /8232/.test(bugTabText || ''), 't2-bug-tab-count', `T2 bug_list tab 含 row_count=8232（实得文本="${bugTabText}"）`);

        // ═══════════════════════════════════════════════
        // T3：bug_list 默认列表 + 分页 total=8232
        // ═══════════════════════════════════════════════
        console.log('\n── T3：bug_list 默认列表渲染 + 分页 total=8232 ──');
        await page.waitForSelector('#laTblBox table', { timeout: 8000 }).catch(() => { });
        const rowCount = await page.locator('#laTblBox tbody tr').count();
        await shotOnFail(page, rowCount === 50, 't3-page-rows', `T3 默认每页渲染 50 行（实得=${rowCount}）`);
        const pagerText0 = await page.locator('#laPager').textContent().catch(() => '');
        await shotOnFail(page, /共\s*8232\s*条/.test(pagerText0 || ''), 't3-total-8232', `T3 分页栏显示"共 8232 条"（实得="${pagerText0}"）`);
        await shotAlways(page, 't3-default-list');

        // ═══════════════════════════════════════════════
        // L1：徽章双向——一条已知无图行在默认（未筛选）第一页上不显示徽章
        // ═══════════════════════════════════════════════
        console.log('\n── L1：无图行不显示徽章（默认第一页，未筛选态） ──');
        const noImageRow = await dbGet(
            `SELECT id, row_index FROM legacy_archive_rows
              WHERE dataset_id = ? AND row_index <= 50 AND (images IS NULL OR images = '[]')
              ORDER BY row_index ASC LIMIT 1`,
            [sampleRow.dataset_id]
        );
        if (noImageRow) {
            const noImgTr = page.locator(`tr[data-row-id="${noImageRow.id}"]`);
            const noImgBadgeCount = await noImgTr.locator('.la-imgbadge').count();
            await shotOnFail(page, noImgBadgeCount === 0, 'l1-no-badge-on-no-image-row',
                `L1 已知无图行（id=${noImageRow.id}，row_index=${noImageRow.row_index}）默认列表不显示 📷 徽章（实得徽章数=${noImgBadgeCount}）`);
        } else {
            skippedAssertions += 1; // M1：L1 断言依赖"默认第一页内存在无图行"这个环境条件
            console.log('  ⚠️ L1：默认第一页（row_index<=50）内未找到无图行，断言跳过（不计入 pass/fail，环境依赖：已同步计入 skippedAssertions，不影响后续用例）');
        }

        // ═══════════════════════════════════════════════
        // M2 负向自证（codex 11 采纳·feedback_async_callback_session_token 范式）：抽屉代际守卫——
        // 模拟"快速连点两行"，先点行的响应被人为拖慢，断言先点行的迟到响应到达后**不得覆盖**已渲染的
        // 后点行。实现方式：抽屉一旦打开会渲染一个覆盖全屏的遮罩（.u-drawer-overlay），鼠标没法在
        // 遮罩之下再点第二行 <tr>（会被遮罩拦截/误触发关闭）——改用 page.evaluate 直接触发页面全局
        // 函数 window.laOpenDrawer(id)（与 <tr> 的 click handler 调用的是同一个函数，语义等价），
        // 且刻意不 return 内部 Promise（fire-and-forget），让两次触发之间的时间间隔逼近真实连点。
        // ═══════════════════════════════════════════════
        console.log('\n── M2：抽屉代际守卫（模拟快速连点两行，先点行的延迟响应不得覆盖后点行内容） ──');
        const guardRowATr = page.locator('#laTblBox tbody tr').nth(0);
        const guardRowBTr = page.locator('#laTblBox tbody tr').nth(1);
        const guardRowAId = await guardRowATr.getAttribute('data-row-id');
        const guardRowBId = await guardRowBTr.getAttribute('data-row-id');
        const guardRowBNo = (await guardRowBTr.locator('td').first().textContent() || '').trim();
        await page.route('**/api/legacy-archive/rows/**', async (route) => {
            if (route.request().url().endsWith(`/rows/${guardRowAId}`)) {
                await new Promise(r => setTimeout(r, 1200)); // 人为拖慢先点行 A 的响应
            }
            await route.continue();
        });
        await page.evaluate((id) => { window.laOpenDrawer(Number(id)); }, guardRowAId); // 触发 A（响应被拖慢，不等其完成）
        await page.evaluate((id) => { window.laOpenDrawer(Number(id)); }, guardRowBId); // 几乎同时触发 B（响应正常速度，先到达）
        await page.waitForTimeout(800); // B 的快响应此刻应已渲染；A 的延迟响应（1200ms）尚未到达
        const titleAfterFastClick = await page.locator('#laDrawerTitle').textContent().catch(() => '');
        await shotOnFail(page, titleAfterFastClick.includes(`第 ${guardRowBNo} 行`), 'm2-guard-fast-response-wins',
            `M2 快速连点后（A 延迟/B 正常），抽屉先显示后点的 B 行内容（实得标题="${titleAfterFastClick}"，期望含"第 ${guardRowBNo} 行"）`);
        await page.waitForTimeout(1500); // 等 A 的延迟响应也真正到达（1200ms 延迟 + 处理余量）
        const titleAfterStaleArrival = await page.locator('#laDrawerTitle').textContent().catch(() => '');
        await shotOnFail(page, titleAfterStaleArrival.includes(`第 ${guardRowBNo} 行`), 'm2-guard-stale-response-discarded',
            `M2 代际守卫生效：A 的延迟响应到达后仍显示 B 行内容，未被旧响应覆盖（实得标题="${titleAfterStaleArrival}"，期望仍含"第 ${guardRowBNo} 行"）`);
        await page.unroute('**/api/legacy-archive/rows/**');
        await page.locator('#laDrawerClose').click();
        await page.waitForTimeout(300);

        // ═══════════════════════════════════════════════
        // T4/T5：关键字筛选生效（服务端命中数独立复算一致）+ 含图行精确显示徽章
        // ═══════════════════════════════════════════════
        console.log('\n── T4/T5：关键字筛选（服务端命中数核对）+ 含图行精确徽章 ──');
        await page.fill('#laSearchInput', termInfo.term);
        await page.waitForTimeout(300 + 500); // 300ms 前端防抖 + 请求往返
        const cntText = await page.locator('#laCnt').textContent().catch(() => '');
        await shotOnFail(page, cntText.trim() === `筛得 ${termInfo.count} 行`, 't4-filter-count-match',
            `T4 筛选后计数区显示"筛得 ${termInfo.count} 行"（与服务端 LIKE 独立复算一致，实得="${cntText}"）`);
        const filteredRowCount = await page.locator('#laTblBox tbody tr').count();
        await shotOnFail(page, filteredRowCount === termInfo.count, 't4-filter-row-render',
            `T4 筛选后渲染行数=服务端命中数（实得渲染=${filteredRowCount}，期望=${termInfo.count}）`);

        const sampleTr = page.locator(`tr[data-row-id="${sampleRow.id}"]`);
        const sampleTrCount = await sampleTr.count();
        await shotOnFail(page, sampleTrCount === 1, 't5-sample-row-visible', `T5 样本行（id=${sampleRow.id}）确实出现在筛选后的第一页（实得命中=${sampleTrCount}）`);
        const badgeText = await sampleTr.locator('.la-imgbadge').textContent().catch(() => '');
        await shotOnFail(page, badgeText.trim() === `📷 ${sampleImages.length}`, 't5-img-badge-exact',
            `T5 样本行精确显示"📷 ${sampleImages.length}"徽章（实得="${badgeText}"）`);
        await shotAlways(page, 't4-t5-filtered-list');

        // ═══════════════════════════════════════════════
        // T6/T7：行详情抽屉 + 字段可见性 + 截图 + 灯箱
        // ═══════════════════════════════════════════════
        console.log('\n── T6/T7：行详情抽屉 + 字段可见性 + 截图 + 灯箱 ──');
        await sampleTr.click();
        await page.waitForSelector('#laDrawer.open', { timeout: 5000 });
        await page.waitForTimeout(500);
        const kvCount = await page.locator('#laDrawerBody .la-kv .la-k').count();
        await shotOnFail(page, kvCount === 20, 't6-kv-count', `T6 抽屉字段数=18(list)+2(detail)=20（实得=${kvCount}，none 字段不应出现在此计数内）`);
        const asideTagCount = await page.locator('#laDrawerBody .la-kv .la-k:has-text("旁注列")').count();
        await shotOnFail(page, asideTagCount === 2, 't6-detail-tagged', `T6 恰 2 个 detail 旁注列被标注"（旁注列）"（实得=${asideTagCount}）`);

        // M2（codex 10 采纳）：字段可见性不满足于"数对了"——独立调 rows/:id API 拿真实 columns 元数据，
        // 与 DOM 实际渲染的字段名集合逐一比对（不只比数量，比"是不是这些字段"），并显式证一个 none
        // 字段名确实不出现在 DOM 里（而不是只信"数量对了所以内容也该对"）。
        const detailApiRes = await fetch(`${BASE_URL}/api/legacy-archive/rows/${sampleRow.id}`, { headers: { Authorization: `Bearer ${adminTok}` } });
        const detailApiBody = await detailApiRes.json();
        const expectedVisibleNames = new Set((detailApiBody.columns || [])
            .filter(c => c && (c.visibility === 'list' || c.visibility === 'detail'))
            .map(c => c.name));
        const domNamesRaw = await page.locator('#laDrawerBody .la-kv .la-k').allTextContents();
        const domNameSet = new Set(domNamesRaw.map(n => n.replace(/（旁注列）\s*$/, '').trim()));
        const missingFromDom = [...expectedVisibleNames].filter(n => !domNameSet.has(n));
        const extraInDom = [...domNameSet].filter(n => !expectedVisibleNames.has(n));
        console.log(`  [M2 比对] 期望字段名集合（${expectedVisibleNames.size}）=${JSON.stringify([...expectedVisibleNames])}`);
        console.log(`  [M2 比对] DOM 实际字段名集合（${domNameSet.size}）=${JSON.stringify([...domNameSet])}`);
        console.log(`  [M2 比对] 缺失=${JSON.stringify(missingFromDom)}；多余=${JSON.stringify(extraInDom)}`);
        await shotOnFail(page,
            missingFromDom.length === 0 && extraInDom.length === 0 && domNameSet.size === expectedVisibleNames.size,
            't6-field-name-set-exact',
            `M2 抽屉展示字段名集合精确等于 bug_list 18 个 list + 2 个 detail 字段名（缺失=${JSON.stringify(missingFromDom)}，多余=${JSON.stringify(extraInDom)}）`);

        const noneCol = (detailApiBody.columns || []).find(c => c && c.visibility === 'none' && c.name && c.name.trim());
        if (noneCol) {
            const noneAbsentFromKvSet = !domNameSet.has(noneCol.name);
            const drawerBodyText = await page.locator('#laDrawerBody').textContent();
            const noneAbsentFromFullText = !drawerBodyText.includes(noneCol.name);
            await shotOnFail(page, noneAbsentFromKvSet && noneAbsentFromFullText, 't6-none-field-absent',
                `M2 none 字段名"${noneCol.name}"（visibility=none）不出现在抽屉 DOM 内（kv 集合命中=${!noneAbsentFromKvSet}，抽屉全文命中=${!noneAbsentFromFullText}）`);
        } else {
            skippedAssertions += 1; // M1：M2(codex10) none-field-absent 断言依赖"bug_list 存在非空 name 的 none 字段"
            console.log('  ⚠️ M2：未找到带非空 name 的 none 字段，"none 不出现"断言跳过（不计入 pass/fail，已同步计入 skippedAssertions）');
        }

        await page.waitForTimeout(1500); // 等图片 blob 逐张回填
        const shotCount = await page.locator('#laDrawerBody img.la-shot').count();
        await shotOnFail(page, shotCount === sampleImages.length, 't7-shot-count-exact',
            `T7 抽屉内渲染截图数=库内 images 数组长度（实得=${shotCount}，期望=${sampleImages.length}）`);
        await shotAlways(page, 't6-t7-drawer-open');

        await page.locator('#laDrawerBody img.la-shot').first().click();
        await page.waitForSelector('#laLightbox.show', { timeout: 3000 });
        const lbVisible = await page.locator('#laLightbox.show').count();
        await shotOnFail(page, lbVisible === 1, 't7-lightbox-open', `T7 点击截图打开灯箱（实得可见=${lbVisible}）`);
        await shotAlways(page, 't7-lightbox');
        await page.locator('#laLightbox').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);
        const lbClosed = await page.locator('#laLightbox.show').count();
        await shotOnFail(page, lbClosed === 0, 't7-lightbox-close', `T7 再次点击灯箱空白处关闭（实得可见=${lbClosed}）`);

        // ═══════════════════════════════════════════════
        // M3 a11y：截图缩略图键盘可达（聚焦后 Enter 打开灯箱）+ Escape 逐层关闭（灯箱→抽屉）
        // ═══════════════════════════════════════════════
        console.log('\n── M3 a11y：截图缩略图 Enter 打开灯箱 + Escape 逐层关闭（灯箱→抽屉） ──');
        await page.locator('#laDrawerBody img.la-shot').first().focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const lbVisibleKb = await page.locator('#laLightbox.show').count();
        await shotOnFail(page, lbVisibleKb === 1, 'm3-img-enter-opens-lightbox', `M3 聚焦截图缩略图后按 Enter 打开灯箱（实得可见=${lbVisibleKb}）`);
        await page.keyboard.press('Escape'); // 灯箱在上，第一次 Escape 关灯箱
        await page.waitForTimeout(300);
        const lbClosedByEscape = await page.locator('#laLightbox.show').count();
        await shotOnFail(page, lbClosedByEscape === 0, 'm3-escape-closes-lightbox', `M3 Escape 关闭灯箱（实得可见=${lbClosedByEscape}）`);
        await page.keyboard.press('Escape'); // 灯箱已关，第二次 Escape 关抽屉
        await page.waitForTimeout(300);
        const drawerClosedByEscape = await page.locator('#laDrawer.open').count();
        await shotOnFail(page, drawerClosedByEscape === 0, 'm3-escape-closes-drawer', `M3 灯箱关闭后再按 Escape，抽屉随之关闭（实得 open 计数=${drawerClosedByEscape}）`);

        // ═══════════════════════════════════════════════
        // L3 负向自证：图片端点异常态（200 但 Content-Type 非 image/*，如反代/中间件兜底页）
        // → 前端 mime 校验生效，降级"图缺失"占位，不创建破图 <img>
        // ═══════════════════════════════════════════════
        console.log('\n── L3：mock 图片端点返回 HTML 200 → 前端降级"图缺失"占位，不渲染破图 ──');
        // 防御性关闭：上面 M3 的 Escape 链已把抽屉关掉，这里若发现仍是打开态（比如未来 M3 段被删/改）
        // 才补点关闭按钮，避免在已关闭的抽屉（滑出屏幕，Playwright 判定不可点击）上误触发超时。
        if (await page.locator('#laDrawer.open').count() > 0) {
            await page.locator('#laDrawerClose').click();
            await page.waitForTimeout(300);
        }
        await page.route('**/api/legacy-archive/images/**', route => {
            route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>not an image</body></html>' });
        });
        await sampleTr.click(); // 重新打开同一行抽屉，触发 laLoadDrawerImage 重新拉取（本次会命中 mock 路由）
        await page.waitForSelector('#laDrawer.open', { timeout: 5000 });
        await page.waitForTimeout(1500);
        const mockedShotCount = await page.locator('#laDrawerBody img.la-shot').count();
        await shotOnFail(page, mockedShotCount === 0, 'l3-mime-guard-no-broken-img',
            `L3 mime 校验生效：mock 非图片响应（Content-Type: text/html）后抽屉内 0 张 <img> 被创建（实得=${mockedShotCount}，防破图）`);
        const missingPlaceholderCount = await page.locator('#laDrawerBody .la-shot-missing:has-text("图缺失")').count();
        await shotOnFail(page, missingPlaceholderCount === sampleImages.length, 'l3-mime-guard-placeholder',
            `L3 mime 校验生效：${sampleImages.length} 张图均降级为"图缺失"占位（实得占位数=${missingPlaceholderCount}）`);
        await shotAlways(page, 'l3-mime-mock-placeholder');
        await page.unroute('**/api/legacy-archive/images/**');

        await page.locator('#laDrawerClose').click();
        await page.waitForTimeout(300);
        const drawerClosed = await page.locator('#laDrawer.open').count();
        await shotOnFail(page, drawerClosed === 0, 't6-drawer-closed', `T6 抽屉关闭按钮生效（实得 open 计数=${drawerClosed}）`);

        // ═══════════════════════════════════════════════
        // T8：切换数据集 tab
        // ═══════════════════════════════════════════════
        console.log('\n── T8：切换数据集 tab（bug_list → bms_maint） ──');
        await page.locator('.la-tab[data-key="bms_maint"]').click();
        await page.waitForTimeout(700);
        const bmsPagerText = await page.locator('#laPager').textContent().catch(() => '');
        await shotOnFail(page, /共\s*378\s*条/.test(bmsPagerText || ''), 't8-switch-tab', `T8 切到 bms_maint 后分页显示"共 378 条"（实得="${bmsPagerText}"）`);
        const bmsSearchCleared = await page.locator('#laSearchInput').inputValue();
        await shotOnFail(page, bmsSearchCleared === '', 't8-search-reset', `T8 切 tab 后搜索框被清空（实得="${bmsSearchCleared}"）`);
        await shotAlways(page, 't8-tab-switched');

        // ═══════════════════════════════════════════════
        // M3 a11y：.la-tab 键盘可达——方向键在 tablist 间移动焦点并即时切换数据集（roving tabindex）
        // ═══════════════════════════════════════════════
        console.log('\n── M3 a11y：数据集 tab 键盘切换（方向键） ──');
        const activeTabKeyBefore = await page.locator('.la-tab.on').getAttribute('data-key');
        await page.locator(`#la-tab-${activeTabKeyBefore}`).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(700);
        const activeTabKeyAfter = await page.locator('.la-tab.on').getAttribute('data-key');
        await shotOnFail(page, !!activeTabKeyAfter && activeTabKeyAfter !== activeTabKeyBefore, 'm3-tab-keyboard-switch',
            `M3 方向键 ArrowRight 切换了当前数据集（切换前=${activeTabKeyBefore}，切换后=${activeTabKeyAfter}）`);
        const focusedTabKeyAfter = await page.evaluate(() => {
            const el = document.activeElement;
            return el && el.dataset ? el.dataset.key : null;
        });
        await shotOnFail(page, focusedTabKeyAfter === activeTabKeyAfter, 'm3-tab-keyboard-focus-roving',
            `M3 切换后焦点随之移动到新的当前 tab（roving tabindex，实得聚焦 key=${focusedTabKeyAfter}，当前 tab key=${activeTabKeyAfter}）`);

        // ═══════════════════════════════════════════════
        // T9：0 console error（两页面）
        // ═══════════════════════════════════════════════
        console.log('\n── T9：全程 0 console error ──');
        await shotOnFail(page, page._consoleErrors.length === 0, 't9-console-clean-admin',
            `T9 admin page（T1-T8 全流程）无 JS 报错（实得=${page._consoleErrors.length}${page._consoleErrors.length ? '：' + page._consoleErrors.map(e => e.text).slice(0, 3).join(' | ') : ''}）`);

        const naLandedOnTaskPool = /Task_Pool\.html/.test(naPage.url());
        const naAllowlistedErrors = naPage._consoleErrors.filter(e =>
            naLandedOnTaskPool && /at authFetch \(.*\/assets\/js\/app\.js/.test(e.text) && /TypeError: Failed to fetch/.test(e.text));
        const naUnexpectedErrors = naPage._consoleErrors.filter(e => !naAllowlistedErrors.includes(e));
        await shotOnFail(naPage, naUnexpectedErrors.length === 0, 't9-console-clean-nonadmin',
            `T9 非 admin page（守卫拦截+跳转全流程，豁免 ${naAllowlistedErrors.length} 条落地页既有噪音）无意外 JS 报错（实得=${naUnexpectedErrors.length}${naUnexpectedErrors.length ? '：' + naUnexpectedErrors.map(e => e.text).slice(0, 3).join(' | ') : ''}）`);

        await page.close();
        await naPage.close();
    } finally {
        await browser.close();
        console.log('\n[清理] 清理导入的批次…');
        // M1②（codex 10 采纳）：清理失败不能只打日志静默过去——之前 cleanupBatch 抛异常被 .catch 吞掉、
        // 行数/目录复核只 console.log 不 must()，脚本会在真库清理失败的情况下仍然 exit 0，谎报"冒烟全绿"。
        // 现在全部改成真断言：cleanupBatch 抛异常/DELETE 有错误/行未归零/目录未删/原 active 未恢复，
        // 任一条都计入 fail，最终 `if (fail > 0) process.exit(1)` 会如实反映清理失败。
        let cleanupResult = null;
        let cleanupThrew = null;
        if (batchId) {
            try { cleanupResult = await cleanupBatch(batchId); } catch (e) { cleanupThrew = e; }
        }
        if (batchId) {
            must(!cleanupThrew, `M1②清理：cleanupBatch(#${batchId}) 未抛异常${cleanupThrew ? `（实得=${cleanupThrew.message}）` : ''}`);
            const remainBatchRow = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_batches WHERE id=?`, [batchId]).catch(() => null);
            must(!!remainBatchRow && remainBatchRow.c === 0, `M1②清理：batch #${batchId} legacy_archive_batches 行数归零（实得剩余=${remainBatchRow ? remainBatchRow.c : '查询失败'}）`);
            // M4（codex 11 采纳）：生产不开 PRAGMA foreign_keys，删 legacy_archive_batches 不会级联，
            // cleanupBatch 是手写逐表 DELETE（rows→datasets→batches）——只查 batches 一张表干净不能
            // 代表 datasets/rows 也真的删空了，须逐表独立复核，任一漏删都要判红而不是被 batches 的绿掩盖。
            const remainDatasetsRow = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_datasets WHERE batch_id=?`, [batchId]).catch(() => null);
            must(!!remainDatasetsRow && remainDatasetsRow.c === 0, `M4清理：legacy_archive_datasets 行数归零（batch_id=${batchId}，实得剩余=${remainDatasetsRow ? remainDatasetsRow.c : '查询失败'}）`);
            const datasetIds = (cleanupResult && cleanupResult.datasetIds) || [];
            let remainRowsCount = null;
            if (datasetIds.length > 0) {
                const placeholders = datasetIds.map(() => '?').join(',');
                const remainRowsRow = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_rows WHERE dataset_id IN (${placeholders})`, datasetIds).catch(() => null);
                remainRowsCount = remainRowsRow ? remainRowsRow.c : null;
            }
            // datasetIds 为空只有两种可能：①cleanupThrew（异常路径，上面已判红，这里不能借"没查"就悄悄
            // 给绿）②正常完成但本批次真的没有任何 dataset（本模块每批次恒 8 个数据集，理论不会发生）——
            // 两种情况都不给"未知即通过"的默认值，remainRowsCount 非精确 0 一律判红，不留可乘之机。
            must(remainRowsCount === 0, `M4清理：legacy_archive_rows 行数归零（涉及 ${datasetIds.length} 个 dataset_id，实得剩余=${remainRowsCount === null ? '未知（datasetIds 为空或查询失败）' : remainRowsCount}）`);
            const dirPath = path.join(ROOT, 'uploads', 'legacy-archive', String(batchId));
            const dirStillThere = fs.existsSync(dirPath);
            must(!dirStillThere, `M1②清理：uploads/legacy-archive/${batchId}/ 目录已删除（实得仍存在=${dirStillThere}）`);
            const hasDeleteErrors = !!(cleanupResult && cleanupResult.deleteErrors && cleanupResult.deleteErrors.length);
            must(!hasDeleteErrors, `M1②清理：DELETE 无错误${hasDeleteErrors ? `（实得=${JSON.stringify(cleanupResult.deleteErrors)}）` : ''}`);
        }
        // 无条件跑同一条 check（originalActiveId 为 null 时天然满足）——EXPECTED_ASSERTIONS 常量不随
        // "跑本脚本时 dev 库当时有没有 active 批次"这个外部环境状态漂移（对齐 verify-legacy-archive-api.js MED1 同款处理）。
        let restoreOk = true;
        if (originalActiveId) {
            const restore = await dbRun(`UPDATE legacy_archive_batches SET status='active' WHERE id=? AND status='retired'`, [originalActiveId]);
            restoreOk = !restore.err && restore.changes === 1;
        }
        must(restoreOk, `M1②清理：原 active 批次（如有）已恢复为 active（${originalActiveId ? `id=${originalActiveId}` : '本次冒烟前无 active 批次，天然满足，未做任何恢复动作'}）`);
        db.close();
        if (ownServer) {
            ownServer.kill();
            await new Promise(r => setTimeout(r, 500));
            killPort(TEST_PORT);
            console.log('[清理] 已关闭本脚本自起的 server + 释放端口');
        }
    }

    // 断言总数锚（M1·codex 11 采纳：从写死常量改为动态，对齐 verify-legacy-archive-api.js MED3
    // 同款精神但适配本文件"部分断言依赖运行时环境条件"的现实）：不满足于"分子分母恒等的假 N/N"，
    // 用"理论满值 MAX_ASSERTIONS - 实际跳过数 skippedAssertions"与真实 must() 触发总数对拍——新增/
    // 删除断言忘了同步 MAX_ASSERTIONS，或新增了条件分支忘了在跳过处 skippedAssertions+=N，都会被
    // 下面判红。MAX_ASSERTIONS=45（假设全部条件分支都命中时的断言总数，逐条见文件内 shotOnFail/must
    // 调用点，语义分组如下）：
    //   T0(2) + T1(6) + T2(2) + T3(2) + L1(1) + M2守卫(2) + T4(2) + T5(2) + T6基础(2) +
    //   M2字段集合(2) + T7(3) + M3截图键盘(3) + L3(2) + T6关闭(1) + T8(2) + M3tab键盘(2) +
    //   T9(2) + finally M1②+M4(6) + finally 原active恢复(1) = 45
    // 可跳过的 4 条（T0 两条/L1 一条/M2 none 字段一条）已在各自分支用 skippedAssertions+=N 记录，
    // 例如测试前 dev 库已有真实 active 批次时 T0 会跳 2 条——此时 EXPECTED 相应降到 43，不会像旧版
    // 写死 36 那样在"已有 active 批次"这个完全合理的环境下产生"锚点必然判红"的自相矛盾。
    const MAX_ASSERTIONS = 45;
    const EXPECTED_ASSERTIONS = MAX_ASSERTIONS - skippedAssertions;
    const actualAssertionCount = pass + fail; // 快照——不含本条锚点断言自己
    must(actualAssertionCount === EXPECTED_ASSERTIONS,
        `断言总数锚：实际=${actualAssertionCount} 期望=${EXPECTED_ASSERTIONS}（MAX=${MAX_ASSERTIONS} - 已跳过=${skippedAssertions}；可能新增/删除了断言未同步 MAX_ASSERTIONS，或新增条件分支忘了同步 skippedAssertions）`);

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 历史台账归档 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 历史台账归档 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
