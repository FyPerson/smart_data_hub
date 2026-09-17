/**
 * 数据协作·多文件上传 M3 前端 Playwright UI 实测
 *
 * 用法：node scripts/test-collab-multifile-m3-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 覆盖（纯客户端，无需 warehouse）：
 *   T1 建单·数据范围多选 3 文件 → 预览 3 项
 *   T2 去重：重复选同 3 文件 → 仍 3 项（name+size+lastModified 去重，RC2-L2）
 *   T3 移除 1 个 → 2 项
 *   T4 超 5 个 → 截到 5 + toast
 *   T5 非法扩展名(.pdf) → 不入列
 *   T5b–T5f #68 数据模板同款：多选 / 去重 / 移除 / 超 5 / 非法扩展名
 *   T6 交付弹窗：脚本多选 2 + 数据多选 2 → 两预览各 2 项
 *   T7 交付校验：清空后点提交 → toast「请至少选择 1 个 SQL 脚本」（不发请求）
 *   + 全程 0 个 console error（JS 语法/运行时健康）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码
const ADMIN_ID = 1;

async function signAs(userId) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

// 造测试文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-pw-'));
function mk(name, content = 'x') { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; }
const ds1 = mk('ds1.txt'), ds2 = mk('ds2.xlsx'), ds3 = mk('ds3.xls'), ds4 = mk('ds4.txt'), ds5 = mk('ds5.txt'), ds6 = mk('ds6.txt');
const bad = mk('bad.pdf');
const tp1 = mk('tp1.xlsx'), tp2 = mk('tp2.xls'), tp3 = mk('tp3.xlsx'), tp4 = mk('tp4.xlsx'), tp5 = mk('tp5.xlsx'), tp6 = mk('tp6.xlsx');
const sc1 = mk('s1.sql'), sc2 = mk('s2.txt');
const da1 = mk('d1.xlsx'), da2 = mk('d2.xls');

async function previewCount(page, wrapId) {
    return await page.$$eval(`#${wrapId} .file-item`, els => els.length);
}

(async () => {
    console.log('=== M3 前端多文件 Playwright UI 实测 ===\n');
    const token = await signAs(ADMIN_ID);
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const consoleErrors = [];
    // 过滤 route.abort() 故意中断 submit 请求引起的资源加载失败（测试制品，非 app JS 错误）
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR_FAILED|ERR_ABORTED/.test(t)) return;
        consoleErrors.push(t);
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE_URL}/Data_Collab.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        // 打开新建协作单弹窗
        console.log('1. 建单·数据范围多文件');
        await page.click('button:has-text("新建协作单")');
        await page.waitForSelector('#newModal.open', { timeout: 3000 });
        await page.waitForTimeout(200);

        // T1: 多选 3 文件
        await page.setInputFiles('#f_data_scope', [ds1, ds2, ds3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 3, 'T1 数据范围多选 3 文件 → 预览 3 项');

        // T2: 重复选同 3 → 去重仍 3
        await page.setInputFiles('#f_data_scope', [ds1, ds2, ds3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 3, 'T2 重复选同文件 → 去重后仍 3 项');

        // T3: 移除第 1 个 → 2 项
        await page.click('#dataScopePreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 2, 'T3 移除 1 个 → 2 项');

        // T4: 再加到超 5 → 截到 5
        await page.setInputFiles('#f_data_scope', [ds1, ds4, ds5, ds6]); // 当前 2(ds2,ds3) + 尝试加 4 → ds1 新+ds4+ds5 到 5，ds6 被拒
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 5, 'T4 超 5 → 截到 5 项');

        // T5: 非法扩展名 .pdf 不入列
        const before = await previewCount(page, 'dataScopePreview');
        await page.setInputFiles('#f_data_scope', [bad]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === before, 'T5 .pdf 非法扩展名 → 不入列（数量不变）');

        console.log('\n1b. 建单·数据模板多文件（#68）');
        await page.setInputFiles('#f_template', [tp1, tp2, tp3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 3, 'T5b 数据模板多选 3 文件 → 预览 3 项');

        await page.setInputFiles('#f_template', [tp1, tp2, tp3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 3, 'T5c 重复选同文件 → 去重后仍 3 项');

        await page.click('#templatePreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 2, 'T5d 移除 1 个 → 2 项');

        await page.setInputFiles('#f_template', [tp1, tp4, tp5, tp6]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 5, 'T5e 超 5 → 截到 5 项');

        // ⚠️ codex 120-A M-1：T5e 之后列表已满 5，此时再选 .pdf，**即使扩展名校验被整个删掉**
        //   也会被容量上限拒掉 → "数量不变"照样绿，等于没测到扩展名过滤。先移除一项腾到 4 再测。
        await page.click('#templatePreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 4, 'T5f 前置：移除 1 项腾出容量 → 4 项（保证下条不被上限顶替）');
        await page.setInputFiles('#f_template', [bad]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'templatePreview') === 4, 'T5f 未满容量时选 .pdf → 仍 4 项（这时只可能是扩展名过滤拦下的）');
        const tplNames = await page.evaluate(() =>
            [...document.querySelectorAll('#templatePreview .file-name')].map(e => (e.textContent || '').trim()));
        expect(!tplNames.some(n => n.includes('bad.pdf')), `T5f 非法文件名未进入列表（实得 ${JSON.stringify(tplNames)}）`);

        // ═══════════════════════════════════════════════════════════════
        // T5g（codex 120-A M-2）：**真实提交契约** —— 选 3 个模板，提交时请求体里必须有 3 个
        //
        // 为什么必须有这条：本套件 T1–T5f 全停在"选择/预览层"（只看 input.files 与预览 DOM），
        //   接口层 e2e 自己构造 multipart 请求，展示层套件直接插库——**三层都绕过了前端那行
        //   `selectedTemplate.forEach(f => tplFormData.append('files', f))`**。把它改回只传第一项
        //   （即 #68 之前的单文件写法），上述三层照样全绿。这行正是 #68 写端的核心。
        //   ⚠️ 它还是一段"未来会被复制"的逻辑：将来若做「编辑态补传模板」，极可能照抄此处，
        //   届时单份/多份的分叉就有了——这是本条的真正立条理由，不是"核心代码都得有守卫"。
        //
        // 手法：两个端点全部 route 拦截并伪造成功响应 ⇒ **不写库、不落盘、无夹具需清理**，
        //   断言对象是**真实发出的 multipart 请求体**，不是内存变量。
        console.log('\n1c. 建单·真实提交契约（#68 A-2）');
        {
            // 重开弹窗以清空前面各用例的残留选择
            await page.evaluate(() => { const m = document.getElementById('newModal'); if (m) m.classList.remove('open'); });
            await page.waitForTimeout(150);
            await page.click('button:has-text("新建协作单")');
            await page.waitForSelector('#newModal.open', { timeout: 3000 });
            await page.waitForTimeout(300);
            expect(await previewCount(page, 'templatePreview') === 0, 'T5g 前置：重开弹窗后模板预览已清空（数组化后的重置路径）');

            const FAKE_ID = 999999;
            const captured = [];
            await page.route('**/api/collab/requests', async route => {
                if (route.request().method() !== 'POST') return route.fallback();
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: FAKE_ID }) });
            });
            await page.route(`**/api/collab/requests/${FAKE_ID}/attachments`, async route => {
                const body = (route.request().postDataBuffer() || Buffer.from('')).toString('latin1');
                const type = (body.match(/name="attachment_type"\r?\n\r?\n([^\r\n]+)/) || [])[1] || '(未知)';
                const names = [...body.matchAll(/filename="([^"]*)"/g)].map(m => m[1]);
                captured.push({ type, names });
                await route.fulfill({
                    status: 200, contentType: 'application/json',
                    body: JSON.stringify({ attachments: names.map((n, i) => ({ id: i + 1, original_name: n })), template_warnings: [] }),
                });
            });

            // 填必填项（select 的 option 由真实接口下发，取第一个非空值）
            await page.evaluate(() => {
                const setV = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } };
                const firstNonEmpty = (id) => {
                    const e = document.getElementById(id); if (!e) return '';
                    return [...e.options].map(o => o.value).find(v => v !== '') || '';
                };
                setV('f_oa_no', 'OA-T5G-' + Date.now());
                setV('f_dept', firstNonEmpty('f_dept'));
                setV('f_requester', '测试业务方');
                setV('f_deadline', '2030-01-01T10:00');
                setV('f_target_db', firstNonEmpty('f_target_db'));
                setV('f_contact', firstNonEmpty('f_contact'));
                setV('f_desc', 'T5g 提交契约用例：本请求已被 route 拦截，不落库');
            });
            await page.setInputFiles('#f_template', [tp1, tp2, tp3]);
            await page.waitForTimeout(200);
            expect(await previewCount(page, 'templatePreview') === 3, 'T5g 已选 3 个模板');

            await page.evaluate(() => { if (typeof submitNew === 'function') submitNew(); });
            await page.waitForTimeout(1200);

            const tplReq = captured.find(c => c.type === 'example_xlsx');
            expect(!!tplReq, `T5g 确实发出了 example_xlsx 上传请求（实得请求类型 ${JSON.stringify(captured.map(c => c.type))}）`);
            if (tplReq) {
                // ⭐ 判别力核心：断"3 个"而非">0 个"——改成只传首项时这里立刻红
                expect(tplReq.names.length === 3,
                    `⭐ T5g 请求体里带了 **3** 个模板文件（实得 ${tplReq.names.length} 个：${JSON.stringify(tplReq.names)}）——若前端改回只传首项，本条判红`);
                const base = p => String(p).split(/[\\/]/).pop();
                for (const f of [tp1, tp2, tp3]) {
                    expect(tplReq.names.some(n => base(n) === base(f)),
                        `T5g 请求体含 ${base(f)}（逐个核名，防"数量对了但传错文件"）`);
                }
            }
            await page.unroute('**/api/collab/requests');
            await page.unroute(`**/api/collab/requests/${FAKE_ID}/attachments`);
        }

        // 关闭新建弹窗
        await page.evaluate(() => { const m = document.getElementById('newModal'); if (m) m.classList.remove('open'); });

        // T6: 交付弹窗多文件（直接调 openSubmitDeliveryDialog 打开 UI，不依赖真实指派单）
        console.log('\n2. 交付结果多文件');
        // ⚠️ 2026-09-11 订正：实现侧后来新增了前置断言（openSubmitDeliveryDialog 开头
        //   `if (!currentDetail || String(currentDetail.id) !== String(id)) { toast; return; }`，
        //   R2·Opus 预筛收窄，防"详情已切到另一单但旧模板按钮还没重渲染"竞态用错单的目标库信息），
        //   而本处是直调、不经详情页 ⇒ 断言把弹窗挡住，T6/T7 恒超时。
        //   修法=直调前把 currentDetail 摆成同一单；该函数对 currentDetail 只用到 .id 与可选的
        //   .target_db_connection_id（后者有 `&&` 保护，不给即视为无目标库，不影响本组多文件断言）。
        await page.evaluate(() => { currentDetail = { id: 999999 }; openSubmitDeliveryDialog(999999); });
        await page.waitForSelector('#submitDeliveryModal.open', { timeout: 3000 });
        await page.waitForTimeout(200);
        await page.setInputFiles('#f_delivery_script', [sc1, sc2]);
        await page.setInputFiles('#f_delivery_data', [da1, da2]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'deliveryScriptPreview') === 2, 'T6 SQL 脚本多选 2 → 预览 2 项');
        expect(await previewCount(page, 'deliveryDataPreview') === 2, 'T6 结果数据多选 2 → 预览 2 项');

        // T7: 清空脚本后点提交 → 校验拦截（toast，不发请求）
        let submitFetchCalled = false;
        await page.route('**/api/collab/requests/**/submit', route => { submitFetchCalled = true; route.abort(); });
        await page.click('#deliveryScriptPreview .file-item:first-child .remove-btn');
        await page.click('#deliveryScriptPreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(100);
        expect(await previewCount(page, 'deliveryScriptPreview') === 0, 'T7 脚本清空 → 0 项');
        await page.click('#btnSubmitDelivery');
        await page.waitForTimeout(300);
        expect(submitFetchCalled === false, 'T7 无脚本点提交 → 客户端校验拦截，未发 submit 请求');

        // T8: 单文件回归——各选 1 个 → 预览各 1 项（零回归）
        console.log('\n3. 单文件回归 + FormData 顺序');
        await page.evaluate((id) => { currentDetail = { id }; openSubmitDeliveryDialog(id); }, 999998);
        await page.waitForTimeout(150);
        await page.setInputFiles('#f_delivery_script', [sc1]);
        await page.setInputFiles('#f_delivery_data', [da1]);
        await page.waitForTimeout(120);
        expect((await previewCount(page, 'deliveryScriptPreview')) === 1 && (await previewCount(page, 'deliveryDataPreview')) === 1,
            'T8 单文件各 1 → 预览各 1 项（零回归）');

        // T9: FormData 顺序——全部脚本在全部数据之前 append（对齐后端 smoke 取首脚本=上传首个）
        await page.evaluate((id) => { currentDetail = { id }; openSubmitDeliveryDialog(id); }, 999997);
        await page.waitForTimeout(150);
        await page.setInputFiles('#f_delivery_script', [sc1, sc2]);
        await page.setInputFiles('#f_delivery_data', [da1, da2]);
        await page.waitForTimeout(120);
        let capturedBody = null;
        await page.unroute('**/api/collab/requests/**/submit');
        await page.route('**/api/collab/requests/**/submit', route => { capturedBody = route.request().postData(); route.abort(); });
        await page.click('#btnSubmitDelivery');
        await page.waitForTimeout(300);
        const iS1 = capturedBody ? capturedBody.indexOf('s1.sql') : -1;
        const iS2 = capturedBody ? capturedBody.indexOf('s2.txt') : -1;
        const iD1 = capturedBody ? capturedBody.indexOf('d1.xlsx') : -1;
        expect(iS1 >= 0 && iS2 >= 0 && iD1 >= 0 && iS1 < iD1 && iS2 < iD1,
            `T9 FormData 全部脚本在全部数据之前（s1=${iS1},s2=${iS2},d1=${iD1}）`);

        // console 健康
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);

    } catch (e) {
        console.error('\n!! 运行异常：', e.message);
        fail++;
    } finally {
        await browser.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
        console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
