/**
 * S2 前端 Playwright 冒烟——需求跟踪（Issue_Tracker.html）录入附件 picker 化
 * 对齐 Data_Correction S1 的 corrPicker* 范式（本页命名 tr 前缀，见 trPickerCollect/trPickerRender/
 * trPickerRemove/trPickerFiles/trPickerReset/trPickerOnPick，Issue_Tracker.html 内联实现，不抽共享层）。
 *
 * 用法：本地 server（3000）已启动到最新分支代码后：node scripts/test-tracker-attach-picker-playwright.js
 * 对齐 test-corr-upload-preview-playwright.js / test-issue-tracker-paste-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 覆盖：
 *   U1 建单弹窗打开 → formAttachments + attachmentPreview 均 isVisible()（先断可达性，S1 教训）
 *   U2 选择文件（图片+非图片）→ picker 数组+预览出现（图片缩略图/非图片图标分支）+ input.value 立即清空
 *   U3 追加而非覆盖（贴图 + 再次选择）
 *   U4 删除单张 → 其余保留
 *   U5 两处清空点（resetIssueForm via openCreateModal 重开 / openEditModal 编辑态）均生效
 *   U6 提交链拿到的是数组内容：route mock POST /api/issues + /api/issues/*\/attachments（不真写库），
 *      断言 attachments 端点被调用 3 次、且逐次校验方法/Content-Type/请求体携带的文件名分别对应
 *      proof_a.png / proof_b.png / list.xlsx（不止数调用次数——调用次数不足以排除"发空 FormData"
 *      "字段名写错"“重复传同一个文件"等退化场景）。uploadAttachments 是逐个文件单独 POST，非一次性
 *      FormData 多文件。
 *   U7 反证：通过 page.route 拦截本 browser context 拿到的 Issue_Tracker.html 响应体，临时把其中
 *      trPickerFiles() 的实现替换成读 input.files（仅内存中的响应文本被替换，磁盘上的
 *      Issue_Tracker.html 全程不写入），确认 U6 断言在这份被篡改的实现下会变红，再卸载拦截还原。
 *   U8 全程 0 console error
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const HTML_PATH = path.join(__dirname, '..', 'public', 'Issue_Tracker.html');

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

// 造临时测试文件（1x1 PNG + 假 xlsx），同 test-corr-upload-preview-playwright.js 范式
function makeTmpFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-attach-'));
    const png1 = path.join(dir, 'proof_a.png');
    const png2 = path.join(dir, 'proof_b.png');
    const xlsx = path.join(dir, 'list.xlsx');
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000-1f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082'.replace(/-/g, ''), 'hex');
    fs.writeFileSync(png1, pngBytes);
    fs.writeFileSync(png2, pngBytes);
    fs.writeFileSync(xlsx, Buffer.from('PKfake-xlsx-for-preview-test'));
    return { dir, png1, png2, xlsx };
}

(async () => {
    console.log('=== 需求跟踪 录入附件 picker 化 Playwright 实测 ===\n');
    const tmp = makeTmpFiles();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await context.newPage();
    const consoleErrors = [];
    // U6/U7 用 mock 的假 issueId（88888/88889）触发真实 submitIssue() 成功路径，其内部会紧接着
    // openDrawer(issueId) 去 GET 详情——这个 id 在真实 DB 里不存在，后端会如实返回 404（openDrawer 对
    // !res.ok 静默 return，无 JS 抛错，但 Chrome 自己仍会打一条网络层 "Failed to load resource" 日志）。
    // 豁免仅在 allow404 标志开启的窗口内生效（对齐 test-corr-upload-preview-playwright.js 的 allow409/
    // allow400 范式），防全局豁免掩盖其他接口意外 404 的回归。
    let allow404 = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allow404 && /Failed to load resource.*404/.test(m.text())) return;
        consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE_URL}/Issue_Tracker.html`, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // ===== U1 建单弹窗打开 → 目标容器可达性（S1 教训：先断 isVisible 再操作）=====
        console.log('U1. 建单弹窗打开 → input + 预览容器均可见');
        await page.evaluate(() => openCreateModal());
        await page.waitForSelector('#createModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const inputVisible = await page.locator('#formAttachments').isVisible();
        const previewVisible = await page.evaluate(() => UPaste.isVisible(document.getElementById('attachmentPreview')));
        expect(inputVisible, `formAttachments 确实可见（实际 ${inputVisible}）`);
        expect(previewVisible, `attachmentPreview 确实可达（UPaste.isVisible 口径，空 div 有 getClientRects，实际 ${previewVisible}）`);

        // ===== U2 选择文件（图片+非图片）=====
        // codex 审 16 复审 LOW 采纳：注释按实际覆盖面收窄——本段只覆盖 xlsx 这一条非图片分支（走 📊），
        //   pdf 的 📄 分支未覆盖（当前实现里除 pdf 外所有非图片都走 📊，故不写成"非图片分支"以免读成全覆盖）。
        console.log('\nU2. 选择文件 → picker 数组+预览出现（图片 + xlsx 非图片分支）');
        await page.setInputFiles('#formAttachments', [tmp.png1, tmp.xlsx]);
        await page.waitForTimeout(150);
        let arr = await page.evaluate(() => trPickerFiles().map(f => f.name));
        let items = await page.evaluate(() => document.querySelectorAll('#attachmentPreview .tr-picker-item').length);
        let imgs = await page.evaluate(() => document.querySelectorAll('#attachmentPreview img').length);
        let hasIcon = await page.evaluate(() => document.getElementById('attachmentPreview').innerHTML.includes('📊'));
        expect(arr.length === 2 && items === 2, `选 1 图+1 xlsx → picker 数组2项+预览2项（实际 ${arr.length}/${items}）`);
        expect(imgs === 1, `图片渲染缩略图1个（实际 ${imgs}）`);
        expect(hasIcon, 'xlsx 渲染 📊 占位图标（非图片分支）');
        const inputCleared = await page.evaluate(() => document.getElementById('formAttachments').value === '');
        expect(inputCleared, '选择后 input.value 立即清空（数组才是真相源）');

        // ===== U3 追加而非覆盖（贴图 + 再次选择两种途径都验）=====
        console.log('\nU3. 追加而非覆盖');
        await page.setInputFiles('#formAttachments', [tmp.png2]);
        await page.waitForTimeout(150);
        let arr2 = await page.evaluate(() => trPickerFiles().map(f => f.name));
        expect(arr2.length === 3, `再次选择 → 追加而非覆盖（实际 ${arr2.length}）`);
        // 贴图追加（复用 T1 同款 dispatchPaste 逻辑，内联一次）
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
        let arr3 = await page.evaluate(() => trPickerFiles().map(f => f.name));
        expect(arr3.length === 4 && arr3.some(n => /^粘贴截图_/.test(n)), `贴图追加 → 长度4（实际 ${arr3.length}/${JSON.stringify(arr3)}）`);

        // ===== U4 删除单张 → 其余保留 =====
        console.log('\nU4. 删除单张 → 其余保留');
        await page.evaluate(() => trPickerRemove(0)); // 删第0项（proof_a.png）
        await page.waitForTimeout(100);
        const afterRemove = await page.evaluate(() => trPickerFiles().map(f => f.name));
        expect(afterRemove.length === 3 && !afterRemove.includes('proof_a.png') && afterRemove.includes('list.xlsx'), `删除第1项 → 剩3项、已删项不在、其余保留（实际 ${JSON.stringify(afterRemove)}）`);

        // ===== U5 两处清空点 =====
        // codex 审 16 M-1（判误报，仍补注释消歧义）：closeCreateModal()（Issue_Tracker.html 内）只
        //   remove('open') class，不调 resetIssueForm()；清空实际发生在 openCreateModal() → 内部调用
        //   的 resetIssueForm()（该函数内含 trPickerReset()）。下面这行 close+open 连续调用，断言测的
        //   是"重开路径"（openCreateModal 触发的 reset），不是"关闭本身触发清空"——两者语义不同，
        //   若关闭本身也要清空需要另加断言，本用例不覆盖那个场景。
        console.log('\nU5. 两处清空点（重开建单弹窗 / 编辑态）均生效');
        await page.evaluate(() => { closeCreateModal(); openCreateModal(); });
        await page.waitForTimeout(150);
        const resetCreate = await page.evaluate(() => ({
            len: trPickerFiles().length,
            html: document.getElementById('attachmentPreview').innerHTML,
        }));
        expect(resetCreate.len === 0 && resetCreate.html === '', `重开建单弹窗 → picker 数组与预览均清空（实际 ${resetCreate.len}）`);

        // 编辑态清空：mock 详情接口，进 openEditModal 前先选1个文件制造"有文件待清"前置条件
        await page.setInputFiles('#formAttachments', [tmp.xlsx]);
        await page.waitForTimeout(150);
        const beforeEdit = await page.evaluate(() => trPickerFiles().length);
        expect(beforeEdit === 1, `进入编辑态前置：已选1个文件（实际 ${beforeEdit}）`);
        await page.route(/\/api\/issues\/\d+$/, route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                id: 77777, title: 'mock', type: '看板/报表需求', source: '业务方', priority: 'P2',
                requester_dept: '市场营销部', requester_name: 'mock', raw_requirement: '', description: '',
                acceptance_url: '', deadline: '', related_table: '', error_time: '', data_domain: '', assigned_to: null,
            }),
        }));
        await page.evaluate(() => openEditModal(77777));
        await page.waitForTimeout(200);
        const afterEditReset = await page.evaluate(() => ({
            len: trPickerFiles().length,
            html: document.getElementById('attachmentPreview').innerHTML,
            inputVal: document.getElementById('formAttachments').value,
        }));
        expect(afterEditReset.len === 0 && afterEditReset.html === '' && afterEditReset.inputVal === '', `进入编辑态 → picker 数组/预览/input 均清空（实际 ${afterEditReset.len}）`);
        await page.unroute(/\/api\/issues\/\d+$/);
        await page.evaluate(() => closeCreateModal());

        // ===== U6 提交链拿到的是数组内容（route mock，不真写库）=====
        console.log('\nU6. 提交链读取 picker 数组（route mock 断请求次数）');
        await page.evaluate(() => openCreateModal());
        await page.waitForTimeout(150);
        await page.fill('#formTitle', 'S2 picker 提交链冒烟');
        await page.selectOption('#formRequesterDept', '市场营销部');
        await page.fill('#formRequesterName', 'S2冒烟');
        await page.setInputFiles('#formAttachments', [tmp.png1, tmp.png2, tmp.xlsx]);
        await page.waitForTimeout(150);
        const preSubmitLen = await page.evaluate(() => trPickerFiles().length);
        expect(preSubmitLen === 3, `提交前 picker 数组含3个文件（实际 ${preSubmitLen}）`);

        let createCalls = 0;
        let attachCalls = [];
        await page.route('**/api/issues', route => {
            if (route.request().method() !== 'POST') return route.continue();
            createCalls++;
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 88888 }) });
        });
        // codex 审 16 MEDIUM 采纳：只数调用次数不足以排除"发空 FormData / 字段名写错 / 重复传同一个
        //   文件"等退化场景（三种退化下调用次数仍恰好是 3，断言照样绿）。改为逐次捕获方法/Content-Type/
        //   请求体（postDataBuffer 转 latin1 保字节 1:1，避免二进制内容破坏文本匹配），后面按文件名+
        //   字段名逐条核对。
        await page.route(/\/api\/issues\/88888\/attachments$/, async route => {
            const req = route.request();
            const buf = await req.postDataBuffer();
            attachCalls.push({
                method: req.method(),
                contentType: (req.headers()['content-type'] || ''),
                bodyText: buf ? buf.toString('latin1') : '',
            });
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        });
        allow404 = true;   // submitIssue 成功后会 openDrawer(88888)，该 id 不存在于真实 DB，预期 404
        await page.evaluate(() => submitIssue());
        await page.waitForTimeout(800);
        expect(createCalls === 1, `建单 POST 恰好调用1次（实际 ${createCalls}）`);
        expect(attachCalls.length === 3, `附件端点被调用次数 = picker 数组长度3（uploadAttachments 逐文件单独 POST，实际 ${attachCalls.length}）`);
        const allPost = attachCalls.every(c => c.method === 'POST');
        const allMultipart = attachCalls.every(c => /multipart\/form-data/i.test(c.contentType));
        expect(allPost, `三次请求方法均为 POST（实际 ${JSON.stringify(attachCalls.map(c => c.method))}）`);
        expect(allMultipart, `三次请求 Content-Type 均含 multipart/form-data（实际 ${JSON.stringify(attachCalls.map(c => c.contentType))}）`);
        // 三次请求分别携带 proof_a.png/proof_b.png/list.xlsx，且字段名为 uploadAttachments 实际用的
        //   'files'（fd.append('files', f)，Issue_Tracker.html 内 uploadAttachments）——防"发空
        //   FormData"（无 filename 匹配）与"重复传同一文件"（某个文件名匹配不到）两类退化。
        const expectedNames = ['proof_a.png', 'proof_b.png', 'list.xlsx'];
        const nameHits = expectedNames.map(n => attachCalls.some(c => c.bodyText.includes(`name="files"; filename="${n}"`)));
        expect(nameHits.every(Boolean), `三次请求分别携带 name="files" 的 proof_a.png/proof_b.png/list.xlsx（命中情况 ${JSON.stringify(Object.fromEntries(expectedNames.map((n, i) => [n, nameHits[i]])))}）`);
        // codex 审 16 复审 LOW 采纳：上面的 some() 只保证"每个期望文件名在某次请求里出现过"，锁不住
        //   "逐文件单独 POST"这个语义——若 uploadAttachments 退化成每次请求都带全部 3 个文件，调用次数
        //   仍是 3、nameHits 仍全 true，断言照样绿。故再加两条：每个请求体只含 1 个文件项 + 三次请求的
        //   文件名集合（排序后）与期望完全相等（既防重复传同一文件，也防漏传/多传）。
        const perCallFileCounts = attachCalls.map(c => (c.bodyText.match(/name="files"; filename="/g) || []).length);
        expect(perCallFileCounts.every(n => n === 1), `每次请求只携带 1 个文件项（逐文件单独 POST，实际 ${JSON.stringify(perCallFileCounts)}）`);
        const sentNames = attachCalls.map(c => ((c.bodyText.match(/name="files"; filename="([^"]+)"/) || [])[1]) || '(none)').sort();
        expect(JSON.stringify(sentNames) === JSON.stringify([...expectedNames].sort()), `三次请求的文件名集合与期望一一对应（实际 ${JSON.stringify(sentNames)}）`);
        await page.waitForTimeout(150);   // 等 404 的 console 日志落地后再关豁免（对齐 allow409 范式）
        allow404 = false;
        await page.unroute('**/api/issues');
        await page.unroute(/\/api\/issues\/88888\/attachments$/);
        await page.evaluate(() => closeDrawer());
        await page.evaluate(() => closeCreateModal());

        // ===== U7 反证：临时把 trPickerFiles() 改回读 input.files，确认 U6 断言变红，再还原 =====
        //   不直接改磁盘上的 Issue_Tracker.html（server 3000 是共享实例，直接改生产文件风险大——
        //   哪怕 try/finally 兜底还原，测试进程中途被杀/异常都可能让文件长时间处于篡改态）。改用
        //   page.route 拦截该 HTML 文档请求本身，只替换本浏览器 context 拿到的响应体，磁盘文件全程不动。
        console.log('\nU7. 反证（route 拦截响应体，临时让 trPickerFiles() 读 input.files，确认 U6 断言变红）');
        const originalHtml = fs.readFileSync(HTML_PATH, 'utf8');
        // codex 审 16 MEDIUM 采纳：改正则定位，不逐字符匹配具体缩进/换行风格（CRLF/LF、大括号换行
        //   方式等排版变化都不受影响，只锁函数名+返回语句这两个语义锚点）。
        const TR_PICKER_FILES_RE = /function\s+trPickerFiles\s*\(\s*\)\s*\{\s*return\s+TR_ATTACH_FILES\.slice\(\)\s*;\s*\}/;
        const tamperedFnSrc = "function trPickerFiles() { return Array.from(document.getElementById('formAttachments').files || []); }";
        const locateMatch = originalHtml.match(TR_PICKER_FILES_RE);
        if (!locateMatch) {
            // 定位失败：立即判反证用例失败，不带着"页面到底有没有被篡改"这种不确定状态继续跑依赖篡改的
            // 后续断言（篡改从未发生，route/goto 全部跳过——U8 之前没有任何遗留的 route/状态污染）。
            expect(false, 'U7 前置：正则定位不到 trPickerFiles() 原始实现，反证判据不成立——已跳过本用例依赖篡改的全部后续断言（如实报告，不猜测结果）');
        } else {
            const tamperedHtml = originalHtml.replace(TR_PICKER_FILES_RE, tamperedFnSrc);
            // codex 审 16 复审 MEDIUM 采纳：route 卸载放进局部 try/finally。⚠️ 定性说明——当前**没有**
            //   实际影响：本段若中途抛异常会直接跳到外层 finally 的 browser.close()，整个 browser 关掉，
            //   残留 route 不会作用于任何东西，U8 也不会执行。加这层是**防未来**：一旦有人在外层 finally
            //   里加截图/诊断页面之类的收尾逻辑，挂着的 HTML 拦截会让诊断产物取到被篡改的页面而非真实实现。
            let htmlRouted = false, apiRouted = false;
            try {
            await page.route('**/Issue_Tracker.html', route => route.fulfill({
                status: 200, contentType: 'text/html; charset=utf-8', body: tamperedHtml,
            }));
            htmlRouted = true;
            await page.goto(`${BASE_URL}/Issue_Tracker.html`, { waitUntil: 'load' });
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            await page.evaluate(() => openCreateModal());
            await page.waitForTimeout(150);
            await page.fill('#formTitle', 'S2 反证冒烟');
            await page.selectOption('#formRequesterDept', '市场营销部');
            await page.fill('#formRequesterName', '反证');
            await page.setInputFiles('#formAttachments', [tmp.png1, tmp.png2, tmp.xlsx]); // onchange 仍会清空 input.value（trPickerOnPick 未改）
            await page.waitForTimeout(150);
            let tamperedCreateCalls = 0;
            let tamperedAttachCalls = [];
            await page.route('**/api/issues', route => {
                if (route.request().method() !== 'POST') return route.continue();
                tamperedCreateCalls++;
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 88889 }) });
            });
            await page.route(/\/api\/issues\/88889\/attachments$/, async route => {
                tamperedAttachCalls.push(1);
                await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
            });
            apiRouted = true;
            allow404 = true;   // 同上：submitIssue 成功后会 openDrawer(88889)，同样是不存在于真实 DB 的假 id
            await page.evaluate(() => submitIssue());
            await page.waitForTimeout(800);
            // 反证判据：篡改后 trPickerFiles() 读的是已被 trPickerOnPick 清空的 input.files → 恒为 0 项，
            //   附件端点应 0 次调用（U6 的"=3"断言在这份代码下会变红）。
            expect(tamperedCreateCalls === 1, `反证前置：建单 POST 仍调用1次（实际 ${tamperedCreateCalls}）`);
            expect(tamperedAttachCalls.length === 0, `反证：篡改后附件端点被调用0次（U6 的"=3"断言在此变红，证明 U6 真的依赖 trPickerFiles() 数组实现，实际 ${tamperedAttachCalls.length}）`);
            await page.waitForTimeout(150);
            await page.evaluate(() => closeDrawer());
            // 注：try 块内各行保持原缩进，只为压低本次 diff 噪声（JS 不依赖缩进）；下面 finally 才是本次新增。
            } finally {
                allow404 = false;   // 移进 finally：异常路径也要关豁免，否则后续用例的真 404 会被静默吞掉
                // 清理自身再抛异常会掩盖原始失败，故整体 try/catch 吞掉并打印（原始异常继续向外传）
                try {
                    if (apiRouted) {
                        await page.unroute('**/api/issues');
                        await page.unroute(/\/api\/issues\/88889\/attachments$/);
                    }
                    if (htmlRouted) await page.unroute('**/Issue_Tracker.html');
                    // 还原：卸载 HTML 拦截后重新加载，确保后续（若有）用例跑在磁盘上真实、从未被改动过的实现上
                    await page.goto(`${BASE_URL}/Issue_Tracker.html`, { waitUntil: 'load' });
                    await page.waitForLoadState('networkidle');
                    await page.waitForTimeout(300);
                } catch (cleanupErr) {
                    console.log(`  ⚠️ U7 清理阶段异常（不掩盖原始失败）：${cleanupErr.message}`);
                }
            }
        }

        // ===== U8 console 健康 =====
        console.log('\nU8. console 健康');
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? '：' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);
    } finally {
        await browser.close();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    }

    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
