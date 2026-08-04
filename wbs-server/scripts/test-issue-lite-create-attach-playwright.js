/**
 * S3/S5 前端 Playwright 冒烟——数据开发（Issue_Lite.html）建单/编辑弹窗附件 picker 化 + 提交链
 * 三阶段任务最后一处：S1 Data_Correction（corrPicker*）/ S2 Issue_Tracker（trPicker*）之后，
 * 本页新增建单时可带附件——picker 七件套命名 il 前缀（ilPickerCollect/ilPickerRender/
 * ilPickerRemove/ilPickerFiles/ilPickerReset/ilPickerOnPick），Issue_Lite.html 内联实现，
 * 沿用 trPicker* 的扁平数组形状（本页仅 1 个上传点，不用 Data_Correction 那种 key→字典）。
 *
 * ⭐ S5（2026-08-04 用户回场推翻 S3 口径）：编辑弹窗也显示附件区并可传附件——编辑弹窗与详情页调
 *   同一个 uploadAttach/同一个端点，不是两条会漂移的写入路径，S3 当初"编辑隐藏"的顾虑过度了。
 *   涉及 openEditLite 显隐反转、submitCreate 编辑分支加上传循环、isImageArea 去掉
 *   `&& !editLiteId.value` 排除子句三处改动，见 P5/P5b/P6c/P7b/P9b。
 *
 * 对齐 test-tracker-attach-picker-playwright.js（S2）套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 与既有 test-issue-lite-paste-playwright.js（S4 贴图接入·抽屉 #attList 单目标）的分工：
 *   该文件覆盖抽屉内粘贴的既有行为，未改动；本文件覆盖建单/编辑弹窗 picker 机制 + 提交链 +
 *   双容器互斥（抽屉与建单弹窗真实同开）等行为，职责不同新建独立文件（同 S1→S2 的既有分文件先例）。
 *
 * 覆盖：
 *   P1 建单弹窗打开 → ilCreateAttachInput + ilCreateAttachPreview 均可达（先断可见性，S1/S2 教训）
 *   P2 选择文件（图片+xlsx 非图片分支）→ picker 数组+预览出现，input.value 立即清空
 *   P3 贴图追加（非覆盖）
 *   P4 删除单张 → 其余保留
 *   P5 两处清空点：重开建单弹窗 / 切到真实单据的编辑态（均生效）；⭐ S5 起编辑态下
 *      #ilCreateAttachGroup 仍显示（不再隐藏），重开建单弹窗同样恢复显示
 *   P5b（S5）编辑态附件区可达性（isVisible 前置）+ 选择文件 + 贴图（真派发 paste 事件走完整共享层
 *      链路，非只手工调 ilPickerCollect 验数组）
 *   P6 两步提交路径（route mock，不真写库）：POST /api/issue-lite 恰好 1 次 + 附件端点恰好 N 次，
 *      逐次核对方法/Content-Type/请求体文件名（同 S2 U6 强度：每次请求仅 1 个文件项 + 文件名集合
 *      排序后与期望完全相等，不止数调用次数）
 *   P6b 响应无有效 id 防御分支：mock 建单成功但响应缺 issue 字段 → 附件端点 0 次调用 + 对应 toast
 *   P7 真实建单 + mock 附件端点失败 → 单据不被删除（真实 GET 复核）+ toast 提示到详情页补传
 *   P6c（S5）编辑提交链（route mock，同 P6 强度）：PUT 恰好 1 次 + 附件端点恰好 N 次，同款逐次核对
 *   P7b（S5）真实编辑保存 + mock 附件端点失败 → 保存不回滚（真实 GET 复核）+ toast 提示补传
 *   P8 抽屉 + 建单弹窗真实同开 → 贴图 2 容器不猜，toast 拦截（多容器互斥，非 T3 那种注入假目标）
 *   P9 反证：page.route 拦截本 browser context 拿到的 Issue_Lite.html 响应体，临时让 ilPickerFiles()
 *      退化读 input.files（磁盘文件全程不动），确认 P6 的附件端点调用次数断言在此变红，再卸载还原
 *   P9b（S5）反证：篡改 isImageArea 恢复排除编辑态的旧判据（`&& !editLiteId.value`），确认编辑态
 *      贴图不再被共享层收入、P5b 断言在此变红，再卸载还原
 *   P10 全程 0 console error（豁免窗口内的预期 404）
 *
 * 用法：本地 server（3000）已启动到最新分支代码后：node scripts/test-issue-lite-create-attach-playwright.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const HTML_PATH = path.join(__dirname, '..', 'public', 'Issue_Lite.html');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const ISSUE_LITE_UPLOAD_SUBDIR = path.resolve(UPLOAD_DIR, 'issue-lite');
const PREFIX = '[ILCREATEATTACH]';

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

// 造临时测试文件（2 张 1x1 PNG + 1 个假 xlsx），同 test-tracker-attach-picker-playwright.js 范式
function makeTmpFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-create-attach-'));
    const png1 = path.join(dir, 'proof_a.png');
    const png2 = path.join(dir, 'proof_b.png');
    const xlsx = path.join(dir, 'list.xlsx');
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000-1f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082'.replace(/-/g, ''), 'hex');
    fs.writeFileSync(png1, pngBytes);
    fs.writeFileSync(png2, pngBytes);
    fs.writeFileSync(xlsx, Buffer.from('PKfake-xlsx-for-preview-test'));
    return { dir, png1, png2, xlsx };
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
// 同 test-issue-lite-paste-playwright.js 范式：先按落盘 file_name 物理删附件，越界路径不删只 warn
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
            console.log(`  ⚠️  跳过越界路径（不在 uploads/issue-lite 子目录内，不删）: file_name="${fileName}"`);
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
    await cleanupTestAttachmentFiles();
    try { await dbRun(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [PREFIX + '%']); } catch (_) { /* ignore */ }
    try { await dbRun(`DELETE FROM issue_lite WHERE title LIKE ?`, [PREFIX + '%']); } catch (_) { /* ignore */ }
}

(async () => {
    console.log('=== 数据开发 建单弹窗附件 picker 化 + 两步提交 Playwright 实测 ===\n');
    await cleanup();
    const tmp = makeTmpFiles();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await context.newPage();
    const consoleErrors = [];
    // P6/P6b/P9 用 mock 假 issueId（88888/88889），submitCreate 成功后会 openDrawer(假id) 触发对不存在
    // id 的真实 GET → 404；P7 故意 mock 附件端点返回 500 来验证"失败不回滚"。Chrome 对非 2xx fetch 都会
    // 打一条 "Failed to load resource" 日志——两个豁免各自只在对应窗口开启（对齐
    // test-tracker-attach-picker-playwright.js 的 allow404 范式，500 是本文件因 P7 新增的同款豁免）。
    let allow404 = false;
    let allow500 = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allow404 && /Failed to load resource.*404/.test(m.text())) return;
        if (allow500 && /Failed to load resource.*500/.test(m.text())) return;
        consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    let fixtureId = null;
    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE_URL}/Issue_Lite.html`, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // 前置：真实造 1 条 fixture 单（P5 编辑态 / P8 双容器互斥都要开真实抽屉，需要真实存在的 id）
        const fixtureRes = await page.evaluate(async (prefix) => {
            const r = await fetch('/api/issue-lite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ title: prefix + 'fixture单', requester_name: '测试员', requester_dept: '市场营销部', requester_phone: '13800001111' }),
            });
            const j = await r.json().catch(() => ({}));
            return { ok: r.ok, id: j && j.issue && j.issue.id };
        }, PREFIX);
        expect(fixtureRes.ok && !!fixtureRes.id, `前置：造 fixture 单成功（实得=${JSON.stringify(fixtureRes)}）`);
        fixtureId = fixtureRes.id;

        // ===== P1 建单弹窗打开 → 目标容器可达性（S1/S2 教训：先断 isVisible 再操作）=====
        console.log('P1. 建单弹窗打开 → input + 预览容器均可见');
        await page.evaluate(() => openCreateModal());
        await page.waitForSelector('#createModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const inputVisible = await page.locator('#ilCreateAttachInput').isVisible();
        const previewVisible = await page.evaluate(() => UPaste.isVisible(document.getElementById('ilCreateAttachPreview')));
        const groupVisible = await page.locator('#ilCreateAttachGroup').isVisible();
        expect(inputVisible, `ilCreateAttachInput 确实可见（实际 ${inputVisible}）`);
        expect(previewVisible, `ilCreateAttachPreview 确实可达（UPaste.isVisible 口径，实际 ${previewVisible}）`);
        expect(groupVisible, `新建模式 #ilCreateAttachGroup 可见（实际 ${groupVisible}）`);

        // ===== P2 选择文件（图片+非图片）=====
        console.log('\nP2. 选择文件 → picker 数组+预览出现（图片 + xlsx 非图片分支）');
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1, tmp.xlsx]);
        await page.waitForTimeout(150);
        let arr = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        let items = await page.evaluate(() => document.querySelectorAll('#ilCreateAttachPreview .il-picker-item').length);
        let imgs = await page.evaluate(() => document.querySelectorAll('#ilCreateAttachPreview img').length);
        let hasIcon = await page.evaluate(() => document.getElementById('ilCreateAttachPreview').innerHTML.includes('📊'));
        expect(arr.length === 2 && items === 2, `选 1 图+1 xlsx → picker 数组2项+预览2项（实际 ${arr.length}/${items}）`);
        expect(imgs === 1, `图片渲染缩略图1个（实际 ${imgs}）`);
        expect(hasIcon, 'xlsx 渲染 📊 占位图标（非图片分支）');
        const inputCleared = await page.evaluate(() => document.getElementById('ilCreateAttachInput').value === '');
        expect(inputCleared, '选择后 input.value 立即清空（数组才是真相源）');

        // ===== P3 贴图追加（非覆盖）=====
        console.log('\nP3. 贴图追加（非覆盖）');
        const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
            if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
            document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        }, TINY_PNG_B64);
        await page.waitForTimeout(300);
        let arr3 = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        expect(arr3.length === 3 && arr3.some(n => /^粘贴截图_/.test(n)), `贴图追加 → 长度3（实际 ${arr3.length}/${JSON.stringify(arr3)}）`);

        // ===== P4 删除单张 → 其余保留 =====
        console.log('\nP4. 删除单张 → 其余保留');
        await page.evaluate(() => ilPickerRemove(0)); // 删第0项（proof_a.png）
        await page.waitForTimeout(100);
        const afterRemove = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        expect(afterRemove.length === 2 && !afterRemove.includes('proof_a.png') && afterRemove.includes('list.xlsx'), `删除第1项 → 剩2项、已删项不在、其余保留（实际 ${JSON.stringify(afterRemove)}）`);

        // ===== P5 两处清空点 + 编辑态显隐（S5 起：编辑态也显示附件区，reset 仍保留）=====
        console.log('\nP5. 两处清空点（重开建单弹窗 / 切到真实单据编辑态）均生效，编辑态附件区仍显示（S5 起）');
        await page.evaluate(() => { closeCreateModal(); openCreateModal(); });
        await page.waitForTimeout(150);
        const resetCreate = await page.evaluate(() => ({
            len: ilPickerFiles().length,
            html: document.getElementById('ilCreateAttachPreview').innerHTML,
            groupDisplay: document.getElementById('ilCreateAttachGroup').style.display,
        }));
        expect(resetCreate.len === 0 && resetCreate.html === '', `重开建单弹窗 → picker 数组与预览均清空（实际 ${resetCreate.len}）`);
        expect(resetCreate.groupDisplay === 'block', `重开建单弹窗 → 附件区恢复显示（实际 display=${resetCreate.groupDisplay}）`);

        // 编辑态清空：先选1个文件制造"有文件待清"前置条件，再切真实单据编辑态
        await page.setInputFiles('#ilCreateAttachInput', [tmp.xlsx]);
        await page.waitForTimeout(150);
        const beforeEdit = await page.evaluate(() => ilPickerFiles().length);
        expect(beforeEdit === 1, `进入编辑态前置：已选1个文件（实际 ${beforeEdit}）`);
        await page.evaluate((id) => openEditLite(id), fixtureId);
        await page.waitForTimeout(300);
        const afterEditReset = await page.evaluate(() => ({
            len: ilPickerFiles().length,
            html: document.getElementById('ilCreateAttachPreview').innerHTML,
            inputVal: document.getElementById('ilCreateAttachInput').value,
            groupDisplay: document.getElementById('ilCreateAttachGroup').style.display,
            modalOpen: document.getElementById('createModal').classList.contains('open'),
        }));
        expect(afterEditReset.len === 0 && afterEditReset.html === '' && afterEditReset.inputVal === '', `进入编辑态 → picker 数组/预览/input 均清空（防上次新建选的文件串到编辑态，实际 ${afterEditReset.len}）`);
        expect(afterEditReset.groupDisplay === 'block', `⭐ S5：编辑态 → #ilCreateAttachGroup 仍显示（用户回场推翻 S3"编辑隐藏"口径，实际 display=${afterEditReset.groupDisplay}）`);
        expect(afterEditReset.modalOpen, '编辑态前置：确实进了编辑弹窗（can_edit 服务端投影通过）');

        // ===== P5b（S5）编辑态附件区可达性 + 可选文件 + 可贴图（真验共享层没拦，非只验数组）=====
        console.log('\nP5b. 编辑态附件区可达性 + 选择文件 + 贴图（真走 UPaste 共享层）');
        const editInputVisible = await page.locator('#ilCreateAttachInput').isVisible();
        const editPreviewVisible = await page.evaluate(() => UPaste.isVisible(document.getElementById('ilCreateAttachPreview')));
        const editGroupVisible = await page.locator('#ilCreateAttachGroup').isVisible();
        expect(editInputVisible, `⭐ 编辑态 ilCreateAttachInput 确实可见（可达性前置，实际 ${editInputVisible}）`);
        expect(editPreviewVisible, `⭐ 编辑态 ilCreateAttachPreview 确实可达（UPaste.isVisible 口径，实际 ${editPreviewVisible}）`);
        expect(editGroupVisible, `⭐ 编辑态 #ilCreateAttachGroup 确实可见（实际 ${editGroupVisible}）`);
        // 编辑态选择文件：走同一个 picker，行为应与新建态一致
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1]);
        await page.waitForTimeout(150);
        const editSelectArr = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        const editSelectItems = await page.evaluate(() => document.querySelectorAll('#ilCreateAttachPreview .il-picker-item').length);
        expect(editSelectArr.length === 1 && editSelectArr[0] === 'proof_a.png' && editSelectItems === 1,
            `编辑态选择文件 → picker 数组+预览均出现（实际 ${JSON.stringify(editSelectArr)}/${editSelectItems}）`);
        // 编辑态贴图：真实派发 paste 事件，验证共享层 UPaste 真的把编辑态的 #ilCreateAttachPreview 判成候选
        // （这是本轮 isImageArea 去掉 `!editLiteId.value` 排除子句要守住的行为——不是象征性地手工调
        // ilPickerCollect，要走真实 document paste 监听器 + scopeResolver + isImageArea 全链路）。
        const editPaste = await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
            if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
            const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            document.dispatchEvent(evt);
            return { defaultPrevented: evt.defaultPrevented };
        }, TINY_PNG_B64);
        await page.waitForTimeout(300);
        const editAfterPasteArr = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        expect(editPaste.defaultPrevented === true, `⭐ 编辑态贴图 defaultPrevented=true（共享层确实拦截了默认粘贴，实际 ${editPaste.defaultPrevented}）`);
        expect(editAfterPasteArr.length === 2 && editAfterPasteArr.some(n => /^粘贴截图_/.test(n)),
            `⭐ 编辑态贴图真正被 UPaste 共享层收入 picker 数组（长度2，非只验数组被手工改过，实际 ${JSON.stringify(editAfterPasteArr)}）`);
        await page.evaluate(() => closeCreateModal());

        // ===== P6 两步提交路径（route mock，不真写库）=====
        console.log('\nP6. 两步提交路径（route mock 断请求次数 + 内容）');
        await page.evaluate(() => openCreateModal());
        await page.waitForTimeout(150);
        await page.fill('#fTitle', PREFIX + 'S3 picker 提交链冒烟');
        await page.selectOption('#fReqDept', '市场营销部');
        await page.fill('#fReqName', 'S3冒烟');
        await page.fill('#fReqPhone', '13800002222');
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1, tmp.png2, tmp.xlsx]);
        await page.waitForTimeout(150);
        const preSubmitLen = await page.evaluate(() => ilPickerFiles().length);
        expect(preSubmitLen === 3, `提交前 picker 数组含3个文件（实际 ${preSubmitLen}）`);

        let createCalls = 0;
        let attachCalls = [];
        await page.route(/\/api\/issue-lite$/, route => {
            if (route.request().method() !== 'POST') return route.continue();
            createCalls++;
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, issue: { id: 88888 } }) });
        });
        // 只数调用次数不足以排除"发空 FormData/字段名写错/重复传同一文件"等退化场景（同 S2 U6 教训）——
        // 逐次捕获方法/Content-Type/请求体，后面按文件名+字段名逐条核对。
        // codex 审 17 MEDIUM 修复的配套断言：建单两步提交传了 skipRefresh，成功后**不应**再 GET 附件列表
        //   —— 抽屉此刻尚未打开、刷新本就无意义；更要紧的是 loadAttachments 一旦抛错会被 uploadAttach 的
        //   catch 吞掉并 return false，把**已上传成功**的文件计入失败名单，用户据此重复补传就产生重复附件
        //   （即"刷新失败"被错报成"上传失败"）。统计非 POST 请求即可锁住这一点——不加这条断言，
        //   skipRefresh 将来被误删也没人发现（修了不测住 = 下次静默回归）。
        const attachNonPostCalls = [];
        await page.route(/\/api\/issue-lite\/88888\/attachments$/, async route => {
            const req = route.request();
            if (req.method() !== 'POST') { attachNonPostCalls.push(req.method()); return route.continue(); }
            const buf = await req.postDataBuffer();
            attachCalls.push({
                method: req.method(),
                contentType: (req.headers()['content-type'] || ''),
                bodyText: buf ? buf.toString('latin1') : '',
            });
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, attachment: { id: 1 } }) });
        });
        allow404 = true;   // submitCreate 成功后会 openDrawer(88888)，该 id 不存在于真实 DB，预期 404
        await page.evaluate(() => submitCreate());
        await page.waitForTimeout(900);
        expect(createCalls === 1, `建单 POST 恰好调用1次（实际 ${createCalls}）`);
        expect(attachCalls.length === 3, `附件端点被调用次数 = picker 数组长度3（uploadAttach 逐文件单独 POST，实际 ${attachCalls.length}）`);
        const allPost = attachCalls.every(c => c.method === 'POST');
        const allMultipart = attachCalls.every(c => /multipart\/form-data/i.test(c.contentType));
        expect(allPost, `三次请求方法均为 POST（实际 ${JSON.stringify(attachCalls.map(c => c.method))}）`);
        expect(allMultipart, `三次请求 Content-Type 均含 multipart/form-data（实际 ${JSON.stringify(attachCalls.map(c => c.contentType))}）`);
        const expectedNames = ['proof_a.png', 'proof_b.png', 'list.xlsx'];
        const nameHits = expectedNames.map(n => attachCalls.some(c => c.bodyText.includes(`name="files"; filename="${n}"`)));
        expect(nameHits.every(Boolean), `三次请求分别携带 name="files" 的 proof_a.png/proof_b.png/list.xlsx（命中情况 ${JSON.stringify(Object.fromEntries(expectedNames.map((n, i) => [n, nameHits[i]])))}）`);
        // 每个请求体只含 1 个文件项 + 三次请求的文件名集合（排序后）与期望完全相等——防"一次请求带全部
        // 3 个文件"这种退化（调用次数与 nameHits 仍会照样绿，需单独锁"逐文件单独 POST"这个语义）。
        const perCallFileCounts = attachCalls.map(c => (c.bodyText.match(/name="files"; filename="/g) || []).length);
        expect(perCallFileCounts.every(n => n === 1), `每次请求只携带 1 个文件项（逐文件单独 POST，实际 ${JSON.stringify(perCallFileCounts)}）`);
        const sentNames = attachCalls.map(c => ((c.bodyText.match(/name="files"; filename="([^"]+)"/) || [])[1]) || '(none)').sort();
        expect(JSON.stringify(sentNames) === JSON.stringify([...expectedNames].sort()), `三次请求的文件名集合与期望一一对应（实际 ${JSON.stringify(sentNames)}）`);
        expect(attachNonPostCalls.length === 0, `建单两步提交未触发附件列表刷新 GET（skipRefresh 生效，实际非 POST 请求 ${JSON.stringify(attachNonPostCalls)}）`);
        await page.waitForTimeout(150);
        allow404 = false;
        await page.unroute(/\/api\/issue-lite$/);
        await page.unroute(/\/api\/issue-lite\/88888\/attachments$/);
        await page.evaluate(() => closeDrawer());

        // ===== P6b 响应无有效 id 防御分支 =====
        console.log('\nP6b. 响应无有效 id 防御分支：附件端点 0 次调用 + toast 提示');
        await page.evaluate(() => openCreateModal());
        await page.waitForTimeout(150);
        await page.fill('#fTitle', PREFIX + 'S3 无效id防御分支');
        await page.selectOption('#fReqDept', '市场营销部');
        await page.fill('#fReqName', 'S3冒烟b');
        await page.fill('#fReqPhone', '13800003333');
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1]);
        await page.waitForTimeout(150);
        let create6bCalls = 0;
        let attach6bCalls = 0;
        await page.route(/\/api\/issue-lite$/, route => {
            if (route.request().method() !== 'POST') return route.continue();
            create6bCalls++;
            // 故意不带 issue 字段，模拟契约漂移（submitCreate 内 `if (j.issue)` 短路，连 openDrawer 都不会触发，
            // 不会产生对不存在 id 的真实 GET，故本段不需要 allow404）
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await page.route(/\/api\/issue-lite\/\d+\/attachments$/, route => {
            if (route.request().method() !== 'POST') return route.continue();
            attach6bCalls++;
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        await page.evaluate(() => submitCreate());
        await page.waitForTimeout(700);
        expect(create6bCalls === 1, `建单 POST 仍调用1次（实际 ${create6bCalls}）`);
        expect(attach6bCalls === 0, `响应无 issue 字段 → 附件端点 0 次调用（实际 ${attach6bCalls}）`);
        const toast6b = await page.locator('#toast-container').textContent().catch(() => '');
        expect(toast6b.includes('响应异常') && toast6b.includes('补传'), `P6b toast 提示响应异常需补传（实得="${toast6b}"）`);
        await page.unroute(/\/api\/issue-lite$/);
        await page.unroute(/\/api\/issue-lite\/\d+\/attachments$/);

        // ===== P7 真实建单 + mock 附件端点失败 → 单据不被删除 =====
        console.log('\nP7. 真实建单 + 附件上传失败 → 单据不被删除，toast 提示补传');
        await page.evaluate(() => openCreateModal());
        await page.waitForTimeout(150);
        const p7Title = PREFIX + 'S3 附件失败不回滚';
        await page.fill('#fTitle', p7Title);
        await page.selectOption('#fReqDept', '市场营销部');
        await page.fill('#fReqName', 'S3冒烟c');
        await page.fill('#fReqPhone', '13800004444');
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1]);
        await page.waitForTimeout(150);
        // 附件端点 mock 为失败（500），建单端点不 mock（真实 POST，真实落库）
        await page.route(/\/api\/issue-lite\/\d+\/attachments$/, route => {
            if (route.request().method() !== 'POST') return route.continue();
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传失败' }) });
        });
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        allow500 = true;   // P7 故意 mock 附件端点 500，Chrome 会为此打一条 Failed to load resource 日志
        const [createResp] = await Promise.all([
            page.waitForResponse(r => /\/api\/issue-lite$/.test(r.url()) && r.request().method() === 'POST', { timeout: 8000 }),
            page.evaluate(() => submitCreate()),
        ]);
        const createBody = await createResp.json().catch(() => ({}));
        const p7Id = createBody && createBody.issue && createBody.issue.id;
        expect(createResp.ok() && !!p7Id, `P7 前置：真实建单成功（实得 ok=${createResp.ok()} id=${p7Id}）`);
        await page.waitForTimeout(800);
        const toast7 = await page.locator('#toast-container').textContent().catch(() => '');
        expect(toast7.includes('单已创建') && toast7.includes('上传失败') && toast7.includes('补传'), `P7 toast 提示单已创建+上传失败+补传（实得="${toast7}"）`);
        await page.waitForTimeout(150);
        allow500 = false;
        await page.unroute(/\/api\/issue-lite\/\d+\/attachments$/);
        // 真实复核：单据仍存在（未被回滚删除）
        if (p7Id) {
            const verify = await page.evaluate(async (id) => {
                const r = await fetch('/api/issue-lite/' + id, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
                const j = await r.json().catch(() => ({}));
                return { ok: r.ok, title: j && j.title };
            }, p7Id);
            expect(verify.ok && verify.title === p7Title, `P7 复核：单据未被删除，真实 GET 仍返回原标题（实得=${JSON.stringify(verify)}）`);
        } else {
            expect(false, 'P7 复核跳过：未拿到有效 id（前置已判失败）');
        }
        await page.evaluate(() => closeDrawer());

        // ===== P6c（S5）编辑提交链强断言：PUT 1 次 + 附件端点 N 次（route mock，同 P6 强度）=====
        console.log('\nP6c. 编辑提交链（route mock 断请求次数 + 内容）');
        await page.evaluate((id) => openEditLite(id), fixtureId);
        await page.waitForTimeout(300);
        await page.fill('#fTitle', PREFIX + 'S5 编辑提交链冒烟');
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1, tmp.png2, tmp.xlsx]);
        await page.waitForTimeout(150);
        const preSubmitEditLen = await page.evaluate(() => ilPickerFiles().length);
        expect(preSubmitEditLen === 3, `编辑提交前 picker 数组含3个文件（实际 ${preSubmitEditLen}）`);

        let editPutCalls = 0;
        let editAttachCalls = [];
        const editAttachNonPostCalls = [];
        const editByIdRe = new RegExp(`/api/issue-lite/${fixtureId}$`);
        const editAttachRe = new RegExp(`/api/issue-lite/${fixtureId}/attachments$`);
        await page.route(editByIdRe, route => {
            if (route.request().method() !== 'PUT') return route.continue();
            editPutCalls++;
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        // 同 P6：不止数调用次数，逐次核对方法/Content-Type/请求体文件名，且验证 skipRefresh 生效
        // （编辑分支同样传了 skipRefresh:true，不该在两步提交期间触发附件列表 GET）。
        await page.route(editAttachRe, async route => {
            const req = route.request();
            // codex 审 19 MEDIUM 收口：非 POST 请求同时记下"发生时已完成几次 POST"，用于**归因**——
            //   仅统计总数无法区分「上传期间意外刷新」与「抽屉渲染的正常刷新」，两者还可能互相抵消。
            //   上传期间的刷新必然夹在 POST 之间（afterPosts < 3），抽屉渲染的必然在全部上传之后（=3）。
            if (req.method() !== 'POST') { editAttachNonPostCalls.push({ method: req.method(), afterPosts: editAttachCalls.length }); return route.continue(); }
            const buf = await req.postDataBuffer();
            editAttachCalls.push({
                method: req.method(),
                contentType: (req.headers()['content-type'] || ''),
                bodyText: buf ? buf.toString('latin1') : '',
            });
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, attachment: { id: 1 } }) });
        });
        await page.evaluate(() => submitCreate());
        await page.waitForTimeout(900);
        expect(editPutCalls === 1, `编辑 PUT 恰好调用1次（实际 ${editPutCalls}）`);
        expect(editAttachCalls.length === 3, `附件端点被调用次数 = picker 数组长度3（uploadAttach 逐文件单独 POST，实际 ${editAttachCalls.length}）`);
        const editAllPost = editAttachCalls.every(c => c.method === 'POST');
        const editAllMultipart = editAttachCalls.every(c => /multipart\/form-data/i.test(c.contentType));
        expect(editAllPost, `三次请求方法均为 POST（实际 ${JSON.stringify(editAttachCalls.map(c => c.method))}）`);
        expect(editAllMultipart, `三次请求 Content-Type 均含 multipart/form-data（实际 ${JSON.stringify(editAttachCalls.map(c => c.contentType))}）`);
        const editExpectedNames = ['proof_a.png', 'proof_b.png', 'list.xlsx'];
        const editNameHits = editExpectedNames.map(n => editAttachCalls.some(c => c.bodyText.includes(`name="files"; filename="${n}"`)));
        expect(editNameHits.every(Boolean), `三次请求分别携带 name="files" 的 proof_a.png/proof_b.png/list.xlsx（命中情况 ${JSON.stringify(Object.fromEntries(editExpectedNames.map((n, i) => [n, editNameHits[i]])))}）`);
        const editPerCallFileCounts = editAttachCalls.map(c => (c.bodyText.match(/name="files"; filename="/g) || []).length);
        expect(editPerCallFileCounts.every(n => n === 1), `每次请求只携带 1 个文件项（逐文件单独 POST，实际 ${JSON.stringify(editPerCallFileCounts)}）`);
        const editSentNames = editAttachCalls.map(c => ((c.bodyText.match(/name="files"; filename="([^"]+)"/) || [])[1]) || '(none)').sort();
        expect(JSON.stringify(editSentNames) === JSON.stringify([...editExpectedNames].sort()), `三次请求的文件名集合与期望一一对应（实际 ${JSON.stringify(editSentNames)}）`);
        // ⚠️ 与 P6 不同：P6 建单用假 id（88888），openDrawer 对不存在 id 的详情 GET 会 404 提前 return，
        //   连 loadAttachments 都摸不到，故 P6 那条断言是"0 次"。这里 editId=fixtureId 是**真实存在**的单据，
        //   openDrawer 会走到底、自身必然触发 1 次附件列表 GET（属正常抽屉渲染，与 skipRefresh 无关）。
        //   ⭐ codex 审 19 MEDIUM 收口：**只断总数=1 的归因不够**——它无法证明这 1 次来自 openDrawer，
        //   也挡不住"上传期间多刷 1 次 + openDrawer 因时序没触发"这种互相抵消的情形。改为按 afterPosts
        //   归因：上传期间的刷新必然夹在 POST 之间（afterPosts<3），抽屉渲染的必然在全部上传之后（=3）。
        //   ⚠️ 复审指出仍有一处理论盲区：第 3 次上传后、openDrawer 前若发生异常 GET，也会记成 afterPosts=3
        //   被误归因为抽屉渲染。**未加 drawer 阶段标记**，理由：skipRefresh 是**同一个参数**，失效必然
        //   同时影响全部 3 次上传 ⇒ afterPosts=1、2 的 GET 必然出现并被上面那条断言抓到；"只有最后一次
        //   异常刷新"在 uploadAttach 的代码结构上不存在这种可能。若将来 uploadAttach 改成按次决定是否
        //   刷新（例如"最后一次才刷"），本盲区才会成真——届时需补 drawer 阶段标记。
        const editUploadPhaseGets = editAttachNonPostCalls.filter(c => c.afterPosts < 3);
        const editDrawerPhaseGets = editAttachNonPostCalls.filter(c => c.afterPosts === 3);
        expect(editUploadPhaseGets.length === 0,
            `⭐ 编辑提交 skipRefresh 生效：**上传期间**（3 次 POST 之间）零附件列表 GET —— skipRefresh 失效时`
            + ` 这里会出现 3 次（afterPosts=1/2/3 各一），实际 ${JSON.stringify(editUploadPhaseGets)}`);
        expect(editDrawerPhaseGets.length === 1 && editDrawerPhaseGets[0].method === 'GET',
            `⭐ 上传全部完成后由 openDrawer 正常渲染触发 1 次附件列表 GET（真实单据的抽屉必然拉一次），`
            + ` 实际 ${JSON.stringify(editDrawerPhaseGets)}`);
        await page.unroute(editByIdRe);
        await page.unroute(editAttachRe);
        await page.evaluate(() => closeDrawer());

        // ===== P7b（S5）真实编辑保存 + mock 附件端点失败 → 保存不回滚 =====
        console.log('\nP7b. 真实编辑保存 + 附件上传失败 → 保存不回滚，toast 提示补传');
        await page.evaluate((id) => openEditLite(id), fixtureId);
        await page.waitForTimeout(300);
        const p7bTitle = PREFIX + 'S5 编辑附件失败不回滚';
        await page.fill('#fTitle', p7bTitle);
        await page.setInputFiles('#ilCreateAttachInput', [tmp.png1]);
        await page.waitForTimeout(150);
        // 附件端点 mock 为失败（500），编辑保存端点不 mock（真实 PUT，真实落库）
        await page.route(editAttachRe, route => {
            if (route.request().method() !== 'POST') return route.continue();
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传失败' }) });
        });
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        allow500 = true;   // 故意 mock 附件端点 500，Chrome 会为此打一条 Failed to load resource 日志
        const [editPutResp] = await Promise.all([
            page.waitForResponse(r => editByIdRe.test(r.url()) && r.request().method() === 'PUT', { timeout: 8000 }),
            page.evaluate(() => submitCreate()),
        ]);
        expect(editPutResp.ok(), `P7b 前置：真实编辑保存成功（实得 ok=${editPutResp.ok()}）`);
        await page.waitForTimeout(800);
        const toast7b = await page.locator('#toast-container').textContent().catch(() => '');
        expect(toast7b.includes('已保存') && toast7b.includes('上传失败') && toast7b.includes('补传'), `P7b toast 提示已保存+上传失败+补传（实得="${toast7b}"）`);
        await page.waitForTimeout(150);
        allow500 = false;
        await page.unroute(editAttachRe);
        // 真实复核：编辑保存的新标题确实持久化（未因附件上传失败被回滚）
        const verify7b = await page.evaluate(async (id) => {
            const r = await fetch('/api/issue-lite/' + id, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const j = await r.json().catch(() => ({}));
            return { ok: r.ok, title: j && j.title };
        }, fixtureId);
        expect(verify7b.ok && verify7b.title === p7bTitle, `P7b 复核：编辑保存未被回滚，真实 GET 返回新标题（实得=${JSON.stringify(verify7b)}）`);
        await page.evaluate(() => closeDrawer());

        // ===== P8 抽屉 + 建单弹窗真实同开 → 贴图 2 容器不猜（多容器互斥） =====
        console.log('\nP8. 抽屉 + 建单弹窗真实同开 → 贴图不猜，toast 拦截');
        await page.evaluate((id) => openDrawer(id), fixtureId);
        await page.waitForSelector('#drawer.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.evaluate(() => openCreateModal());
        await page.waitForTimeout(200);
        const bothOpen = await page.evaluate(() => ({
            drawer: document.getElementById('drawer').classList.contains('open'),
            modal: document.getElementById('createModal').classList.contains('open'),
        }));
        expect(bothOpen.drawer && bothOpen.modal, `P8 前置：抽屉与建单弹窗确实同开（实得=${JSON.stringify(bothOpen)}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r8 = await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
            if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
            const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            document.dispatchEvent(evt);
            return { defaultPrevented: evt.defaultPrevented };
        }, TINY_PNG_B64);
        expect(r8.defaultPrevented === true, `P8 仍 preventDefault（实得=${r8.defaultPrevented}）`);
        await page.waitForTimeout(400);
        const toast8 = await page.locator('#toast-container').textContent().catch(() => '');
        expect(toast8.includes('请先点击目标附件区再粘贴'), `P8 toast 提示不猜（实得="${toast8}"）`);
        // 复核：抽屉/建单弹窗各自的附件区确未被误收（贴图未落进任一容器）
        const p8Unaffected = await page.evaluate(() => ilPickerFiles().length === 0);
        expect(p8Unaffected, 'P8 复核：建单弹窗 picker 数组未被误收贴图（仍为 0）');
        await page.evaluate(() => { closeCreateModal(); closeDrawer(); });
        await page.waitForTimeout(200);

        // ===== P9 反证：篡改 ilPickerFiles() 退化读 input.files，确认 P6 断言变红 =====
        console.log('\nP9. 反证（route 拦截响应体，临时让 ilPickerFiles() 读 input.files，确认附件端点调用数变红）');
        const originalHtml = fs.readFileSync(HTML_PATH, 'utf8');
        const IL_PICKER_FILES_RE = /function\s+ilPickerFiles\s*\(\s*\)\s*\{\s*return\s+IL_CREATE_FILES\.slice\(\)\s*;\s*\}/;
        const tamperedFnSrc = "function ilPickerFiles() { return Array.from(document.getElementById('ilCreateAttachInput').files || []); }";
        const locateMatch = originalHtml.match(IL_PICKER_FILES_RE);
        if (!locateMatch) {
            expect(false, 'P9 前置：正则定位不到 ilPickerFiles() 原始实现，反证判据不成立——已跳过本用例依赖篡改的全部后续断言（如实报告，不猜测结果）');
        } else {
            const tamperedHtml = originalHtml.replace(IL_PICKER_FILES_RE, tamperedFnSrc);
            let htmlRouted = false, apiRouted = false;
            try {
                await page.route('**/Issue_Lite.html', route => route.fulfill({
                    status: 200, contentType: 'text/html; charset=utf-8', body: tamperedHtml,
                }));
                htmlRouted = true;
                await page.goto(`${BASE_URL}/Issue_Lite.html`, { waitUntil: 'load' });
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(400);
                await page.evaluate(() => openCreateModal());
                await page.waitForTimeout(150);
                await page.fill('#fTitle', PREFIX + 'S3 反证冒烟');
                await page.selectOption('#fReqDept', '市场营销部');
                await page.fill('#fReqName', '反证');
                await page.fill('#fReqPhone', '13800005555');
                await page.setInputFiles('#ilCreateAttachInput', [tmp.png1, tmp.png2, tmp.xlsx]); // onchange 仍会清空 input.value（ilPickerOnPick 未改）
                await page.waitForTimeout(150);
                let tamperedCreateCalls = 0;
                let tamperedAttachCalls = [];
                await page.route(/\/api\/issue-lite$/, route => {
                    if (route.request().method() !== 'POST') return route.continue();
                    tamperedCreateCalls++;
                    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, issue: { id: 88889 } }) });
                });
                await page.route(/\/api\/issue-lite\/88889\/attachments$/, route => {
                    if (route.request().method() !== 'POST') return route.continue();
                    tamperedAttachCalls.push(1);
                    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
                });
                apiRouted = true;
                allow404 = true;   // submitCreate 成功后会 openDrawer(88889)，同样是不存在于真实 DB 的假 id
                await page.evaluate(() => submitCreate());
                await page.waitForTimeout(900);
                expect(tamperedCreateCalls === 1, `反证前置：建单 POST 仍调用1次（实际 ${tamperedCreateCalls}）`);
                expect(tamperedAttachCalls.length === 0, `反证：篡改后附件端点被调用0次（P6 的"=3"断言在此变红，证明 P6 真的依赖 ilPickerFiles() 数组实现，实际 ${tamperedAttachCalls.length}）`);
                await page.waitForTimeout(150);
                await page.evaluate(() => closeDrawer());
            } finally {
                allow404 = false;
                try {
                    if (apiRouted) {
                        await page.unroute(/\/api\/issue-lite$/);
                        await page.unroute(/\/api\/issue-lite\/88889\/attachments$/);
                    }
                    if (htmlRouted) await page.unroute('**/Issue_Lite.html');
                    await page.goto(`${BASE_URL}/Issue_Lite.html`, { waitUntil: 'load' });
                    await page.waitForLoadState('networkidle');
                    await page.waitForTimeout(300);
                } catch (cleanupErr) {
                    console.log(`  ⚠️ P9 清理阶段异常（不掩盖原始失败）：${cleanupErr.message}`);
                }
            }
        }

        // ===== P9b（S5）反证：篡改 isImageArea 恢复排除编辑态的旧判据，确认编辑态贴图变红 =====
        //   本任务的核心修复是去掉 isImageArea 里 `&& !editLiteId.value` 这个排除子句（不去掉编辑态贴图
        //   会被共享层拦掉）。把它篡改加回去，验证 P5b 那两条"编辑态贴图真被收入"断言会变红。
        console.log('\nP9b. 反证（S5 isImageArea 修复）：恢复 !editLiteId.value 排除子句，确认编辑态贴图不再被收（P5b 断言在此变红）');
        const originalHtml2 = fs.readFileSync(HTML_PATH, 'utf8');
        const IL_IS_IMAGE_AREA_RE = /if \(key === 'ilCreateAttachPreview'\) \{\s*const cm = document\.getElementById\('createModal'\);\s*return canWrite\(\) && !!\(cm && cm\.classList\.contains\('open'\)\);\s*\}/;
        const locateMatch2 = originalHtml2.match(IL_IS_IMAGE_AREA_RE);
        if (!locateMatch2) {
            expect(false, 'P9b 前置：正则定位不到 isImageArea 当前实现，反证判据不成立——已跳过本用例依赖篡改的全部后续断言（如实报告，不猜测结果）');
        } else {
            const tamperedHtml2 = originalHtml2.replace(IL_IS_IMAGE_AREA_RE,
                "if (key === 'ilCreateAttachPreview') { const cm = document.getElementById('createModal'); return canWrite() && !!(cm && cm.classList.contains('open')) && !document.getElementById('editLiteId').value; }");
            let htmlRouted2 = false;
            try {
                await page.route('**/Issue_Lite.html', route => route.fulfill({
                    status: 200, contentType: 'text/html; charset=utf-8', body: tamperedHtml2,
                }));
                htmlRouted2 = true;
                await page.goto(`${BASE_URL}/Issue_Lite.html`, { waitUntil: 'load' });
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(400);
                await page.evaluate((id) => openEditLite(id), fixtureId);
                await page.waitForTimeout(300);
                const beforeTamperedPaste = await page.evaluate(() => ilPickerFiles().length);
                await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
                await page.evaluate((b64) => {
                    const bin = atob(b64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const dt = new DataTransfer();
                    dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
                    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
                    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                }, TINY_PNG_B64);
                await page.waitForTimeout(400);
                const afterTamperedPaste = await page.evaluate(() => ilPickerFiles().length);
                const tamperedToast = await page.locator('#toast-container').textContent().catch(() => '');
                expect(afterTamperedPaste === beforeTamperedPaste,
                    `反证：篡改后编辑态贴图不再被收入 picker 数组（P5b"贴图后长度2"断言在此变红——数组长度维持不变，实际前=${beforeTamperedPaste} 后=${afterTamperedPaste}）`);
                expect(tamperedToast.includes('请先点击目标附件区再粘贴'),
                    `反证：编辑态候选被 isImageArea 排除后共享层判定 0 候选，弹出「请先点击目标附件区再粘贴」（实得="${tamperedToast}"）`);
                await page.evaluate(() => closeCreateModal());
            } finally {
                try {
                    if (htmlRouted2) await page.unroute('**/Issue_Lite.html');
                    await page.goto(`${BASE_URL}/Issue_Lite.html`, { waitUntil: 'load' });
                    await page.waitForLoadState('networkidle');
                    await page.waitForTimeout(300);
                } catch (cleanupErr) {
                    console.log(`  ⚠️ P9b 清理阶段异常（不掩盖原始失败）：${cleanupErr.message}`);
                }
            }
        }

        // ===== P10 console 健康 =====
        console.log('\nP10. console 健康');
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? '：' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);
    } finally {
        await browser.close();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
        await cleanup();
    }

    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
