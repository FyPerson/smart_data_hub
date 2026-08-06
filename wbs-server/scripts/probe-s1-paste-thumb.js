/**
 * S1 长任务·数据开发页贴图三症状 A1/A3 探针（Issue_Lite.html）
 * 背景：docs/local/前端统一/任务_附件贴图补全_20260804.md §12
 *   A1 建单/编辑弹窗贴图后，预览区被 .u-modal-body{max-height:60vh;overflow-y:auto} 滚出可视区
 *      （附件预览区在表单最底部，ilPickerRender() 渲染后原本不滚动）——用户误以为"贴了没反应"。
 *   A3 详情抽屉附件区从来没有缩略图，loadAttachments 只渲染 "📎 文件名" 文字链接——本任务对齐
 *      Data_Correction 的"图片=缩略图+lightbox 放大"分层预览范式。
 *
 * 覆盖：
 *   A1 建单弹窗持续贴图直至 .u-modal-body 产生真实纵向溢出 → 每次 ilPickerRender() 后最后一项
 *      均被自动滚入可视区（block:'nearest'）
 *   A3-1 真实上传 1 张图片 + 1 个非图片附件 → 详情抽屉打开后图片附件出现 img[src^="blob:"]，
 *        非图片附件仍是纯文字链接（无 img）
 *   A3-2 点击缩略图 → lightbox 出现，大图复用缩略图同一 objectURL（不发第二次下载请求）
 *   A3-3 点大图本身不关闭；ESC / 点遮罩 / 点 × 均可关闭
 *   全程 0 console error + 测试产物（单据/附件/磁盘文件）闭环清理
 *
 * codex 256 号审查 6 项小收口后新增探针覆盖（M-5a/M-5b/M-6a/M-6b，代码修复 M-1~M-4/L-1 见
 * Issue_Lite.html 内联注释）：
 *   M-5a 编辑弹窗复用同一 createModal/#ilCreateAttachPreview → 溢出滚入行为在编辑态同样成立
 *   M-5b 溢出已成立后再连续追加 2 张图，每次单独断言最后一项仍完整可见（防"只滚第一次"）
 *   M-6a 打开抽屉前注册下载请求监听 → 全部 lightbox 开合交互结束后下载请求总数恰=1
 *   M-6b cleanup() 不再用 try/catch 静默吞 dbRun 的 err，末次清理断言 SQL 全部无错误
 *
 * codex 257 号审查 4M/2L 收口后再新增探针覆盖（代码修复 M-A 见 Issue_Lite.html ilCloseLightbox 内联
 * 注释——× 按钮自身 onclick 与父级 overlay onclick 双绑定导致冒泡二次执行，加幂等守卫收口）：
 *   M-B body overflow 四条关闭路径（×/ESC/遮罩/closeDrawer）精确恢复非空原值 'auto'；× 路径在 M-A
 *      修复前必红（其余三条路径均单次直调，不受该 bug 影响）；closeDrawer 路径另断言 revokeObjectURL
 *      触发 ≥1 次 + 大图 src 属性清空
 *   M-C 加固 M-5b：每轮追加断言 itemCount 精确等于「基准+本轮序号」+ 最后一项 title 属性确为本轮新增
 *      文件名，防"数组增长但渲染项漂移"/"最后一项其实是上一轮的"假绿
 *   M-D main() 开头预清理失败改硬阻断（process.exit(1)），不再只 console.warn
 *   L-A 编辑态补一次真实 ClipboardEvent('paste')，走完整 UPaste 共享层而非直调内部函数
 *   L-B 点击 lightbox 说明文字（caption）不关闭，img.src 不清空
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/probe-s1-paste-thumb.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const ISSUE_LITE_UPLOAD_SUBDIR = path.resolve(UPLOAD_DIR, 'issue-lite');
const PREFIX = '[S1PASTETHUMB]';

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }

function dbRun(sql, params) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.run(sql, params || [], function (err) { db.close(); resolve({ err, lastID: this && this.lastID }); });
    });
}
// codex 264 号末次合并审 M-4：err 时不再回落空数组静默吞错——原写法让"查询真失败"和"查询成功但
//   查出 0 行"两种截然不同的情况在返回值上无法区分，调用方只能拿到 []，会当成"没有附件要清"继续往
//   下走 DELETE，实际上是查询本身挂了（例如 db 忙/锁等瞬时故障），DB 记录随后仍被删掉，物理文件永远
//   没被枚举到、更没被 unlink——产生孤儿文件且没有任何报错信号。
function dbAll(sql, params) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.all(sql, params || [], function (err, rows) { db.close(); resolve({ rows: err ? [] : (rows || []), err }); });
    });
}
// 同 test-issue-lite-paste-playwright.js 范式：先按落盘 file_name 物理删附件，越界路径不删只 warn。
//   codex 264 M-4：查询失败时立即返回（queryErr 非 null），不再往下枚举/删除——调用方 cleanup() 据此
//   决定是否继续 DELETE（见下方，查询失败时 DB 删除整体跳过，不产生"文件没删、记录先删"的孤儿窗口）。
async function cleanupTestAttachmentFiles() {
    const { rows, err: queryErr } = await dbAll(
        `SELECT file_name FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`,
        [PREFIX + '%']);
    const attempted = [];
    if (queryErr) return { attempted, queryErr };
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
    return { attempted, queryErr: null };
}
// codex 256 M-6b：清理 SQL 的 err 不再被 try/catch 静默吞（dbRun 本身只 resolve({err,...})、从不 reject，
//   原 try/catch 是死代码，看着"兜底"实则永远不会命中）——改为收集每步 err 一并返回，调用方读返回值断言。
// codex 264 M-4：文件清单查询失败时（queryErr 非空）整个跳过 DB 删除、直接把该错误并入 errs 返回——
//   调用方 main() 的预清理阶段已有"errs 非空则 process.exit(1)"硬阻断（见下方 M-D 注释），此处只需
//   把 queryErr 正确纳入同一份 errs 数组，复用既有阻断路径，不需要另起一套信号。
async function cleanup() {
    const { attempted, queryErr } = await cleanupTestAttachmentFiles();
    if (queryErr) {
        return { attempted, errs: [{ step: 'select file_name for cleanup（DB 删除已整体跳过，防孤儿文件）', err: queryErr }] };
    }
    const errs = [];
    const r1 = await dbRun(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [PREFIX + '%']);
    if (r1 && r1.err) errs.push({ step: 'delete issue_lite_attachments', err: r1.err });
    const r2 = await dbRun(`DELETE FROM issue_lite WHERE title LIKE ?`, [PREFIX + '%']);
    if (r2 && r2.err) errs.push({ step: 'delete issue_lite', err: r2.err });
    return { attempted, errs };
}

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
    const preClean = await cleanup();
    // codex 257 M-D：预清理失败是前置条件失败，非断言失败——硬阻断而非仅提示（codex 256 M-6b 落地时
    //   只做 console.warn 不阻断，若在脏状态基础上继续跑，会污染后续精确计数类断言，例如
    //   attCountCheck.count===2）。errs 非空直接 process.exit(1)，不计入 must() 通过/失败统计。
    //   codex 264 M-4：errs 现同时覆盖"DELETE 执行失败"与"SELECT 文件清单失败"两类——后者复用同一份
    //   errs 数组即触发本处硬阻断，不需要另起判断分支。
    if (preClean && preClean.errs && preClean.errs.length) {
        console.error(`  ❌ 预清理 SQL 出现错误，前置条件不满足，阻断执行: ${JSON.stringify(preClean.errs.map(e => ({ step: e.step, message: e.err && e.err.message })))}`);
        process.exit(1);
    }
    console.log('\n══════ S1 探针：数据开发页贴图三症状 A1（picker 滚入可视区）+ A3（详情抽屉缩略图 + lightbox） ══════');

    const adminTok = await fx.signAs(fx.ADMIN_ID);
    const browser = await chromium.launch();
    const consoleErrors = [];
    try {
        // 视口用 1600×900——用户实报"1920@125% / 1600×900 下完全不可见"场景之一
        const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
        const page = await context.newPage();
        page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
        page.on('dialog', d => d.accept());

        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate(t => { localStorage.setItem('token', t); }, adminTok);
        await page.goto(`${BASE_URL}/Issue_Lite.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        // 造测试单
        const created = await page.evaluate(async (prefix) => {
            const r = await fetch('/api/issue-lite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ title: prefix + '贴图三症状探针单', requester_name: '测试员', requester_dept: '市场营销部', requester_phone: '13800001111' }),
            });
            const j = await r.json().catch(() => ({}));
            return { ok: r.ok, id: j && j.issue && j.issue.id };
        }, PREFIX);
        must(created.ok && !!created.id, `前置：造测试单成功（实得=${JSON.stringify(created)}）`);
        const issueId = created.id;

        // ═══════════════════════════════════════════════════════════
        // A1：建单弹窗持续贴图直至 .u-modal-body 产生真实纵向溢出 → 每次 ilPickerRender() 后
        //     最后一项均被自动滚入可视区（不猜固定张数就一定溢出，循环加到真溢出为止，封顶 30 张防死循环）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── A1：建单弹窗持续贴图 → 最后一项自动滚入 .u-modal-body 可视区 ──');
        await page.evaluate(() => openCreateModal());
        await page.waitForSelector('#createModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);

        const a1 = await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const modalBody = document.querySelector('#createModal .u-modal-body');
            const wrap = document.getElementById('ilCreateAttachPreview');
            let n = 0;
            let overflowDetected = false;
            const maxN = 30;
            while (n < maxN) {
                n++;
                ilPickerCollect([new File([bytes], `probe_img_${n}.png`, { type: 'image/png' })]);
                ilPickerRender();   // 被测行为：每次渲染后应把最后一项滚入可视区
                if (modalBody.scrollHeight > modalBody.clientHeight) { overflowDetected = true; break; }
            }
            const items = wrap.querySelectorAll('.il-picker-item');
            const last = items[items.length - 1];
            const lastRect = last.getBoundingClientRect();
            const bodyRect = modalBody.getBoundingClientRect();
            return {
                n, overflowDetected,
                itemCount: items.length,
                scrollTop: modalBody.scrollTop,
                lastTop: lastRect.top, lastBottom: lastRect.bottom,
                bodyTop: bodyRect.top, bodyBottom: bodyRect.bottom,
            };
        }, TINY_PNG_B64);
        must(a1.overflowDetected, `A1 前置：贴到第 ${a1.n} 张时 .u-modal-body 确已产生真实纵向溢出（scrollHeight>clientHeight，封顶30张，实得 overflowDetected=${a1.overflowDetected}）`);
        must(a1.itemCount === a1.n, `A1 前置：picker 项数与贴图次数一致（实得 itemCount=${a1.itemCount}，n=${a1.n}）`);
        must(a1.scrollTop > 0, `A1：溢出后 .u-modal-body 确实发生了滚动（scrollTop>0，实得=${a1.scrollTop}）`);
        const lastFullyVisible = a1.lastTop >= a1.bodyTop - 1 && a1.lastBottom <= a1.bodyBottom + 1;
        must(lastFullyVisible, `A1：最后一个 .il-picker-item 完整落在 .u-modal-body 可视窗口内（last=[${a1.lastTop.toFixed(1)},${a1.lastBottom.toFixed(1)}] body=[${a1.bodyTop.toFixed(1)},${a1.bodyBottom.toFixed(1)}]）`);

        // ═══════════════════════════════════════════════════════════
        // A1b（hotfix 20260806·贴图四件②，289-M 收口后更新）：picker 预览图点击放大——对齐详情抽屉
        //   缩略图行为（悬停 zoom-in 光标 + 点击 ilLightbox 弹出）。改前 img 无 onclick、无 zoom 光标，
        //   点击应无任何反应——cursor/show 两条断言在修复前必红。
        //   [289-M] lightbox 大图改用独立 URL.createObjectURL(file)（ilZoomUrl），不再复用 picker 缩略图
        //   自身的 IL_CREATE_URLS[idx]——两者现应是不同的 blob URL（各自独立生命周期），关闭 lightbox 后
        //   ilZoomUrl 应被 revoke，而 picker 缩略图自己的 URL 不受影响（src 属性不变）。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── A1b：picker 预览图点击放大（对齐详情抽屉 lightbox 行为 + 289-M 独立 URL 生命周期） ──');
        const pickerZoomBefore = await page.evaluate(() => {
            const wrap = document.getElementById('ilCreateAttachPreview');
            const firstImg = wrap.querySelector('.il-picker-item img');
            return {
                cursor: firstImg ? getComputedStyle(firstImg).cursor : null,
                lightboxShowBefore: document.getElementById('ilLightbox').classList.contains('show'),
                thumbSrcBefore: firstImg ? firstImg.src : null,
            };
        });
        must(pickerZoomBefore.cursor === 'zoom-in', `A1b：picker 预览图 cursor 为 zoom-in（对齐详情抽屉悬停行为，实得="${pickerZoomBefore.cursor}"）`);
        must(!pickerZoomBefore.lightboxShowBefore, `A1b 前置：点击前 ilLightbox 未 show（实得=${pickerZoomBefore.lightboxShowBefore}）`);

        // 打点：hook revokeObjectURL，记录调用参数序列（供关闭后断言只 revoke 了 zoom 专属 URL）
        await page.evaluate(() => {
            window.__ilRevokeCalls = [];
            const orig = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = function (u) { window.__ilRevokeCalls.push(u); return orig(u); };
        });

        await page.click('#ilCreateAttachPreview .il-picker-item img');
        await page.waitForTimeout(150);
        const pickerZoomAfter = await page.evaluate(() => {
            const lb = document.getElementById('ilLightbox');
            const img = document.getElementById('ilLightboxImg');
            const firstThumb = document.querySelector('#ilCreateAttachPreview .il-picker-item img');
            return { show: lb.classList.contains('show'), lbSrc: img.src, thumbSrc: firstThumb.src };
        });
        must(pickerZoomAfter.show, `A1b：点击 picker 预览图后 ilLightbox 出现 show 态（改前 img 无 onclick，本断言红→绿，实得=${pickerZoomAfter.show}）`);
        must(pickerZoomAfter.lbSrc.startsWith('blob:'), `A1b：lightbox 大图是 blob URL（独立 URL.createObjectURL，实得前缀=${pickerZoomAfter.lbSrc.slice(0, 24)}…）`);
        must(pickerZoomAfter.lbSrc !== pickerZoomAfter.thumbSrc, `A1b【289-M】：lightbox 大图与 picker 缩略图是两个不同的 objectURL（各自独立生命周期，非复用同一个，缩略图src前缀=${pickerZoomAfter.thumbSrc.slice(0, 24)}… 大图src前缀=${pickerZoomAfter.lbSrc.slice(0, 24)}…）`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const pickerZoomClosed = await page.evaluate(() => document.getElementById('ilLightbox').classList.contains('show'));
        must(!pickerZoomClosed, `A1b：ESC 关闭 ilLightbox 后恢复（实得 show=${pickerZoomClosed}）`);

        const ilRevokeState = await page.evaluate((expectedLbSrc) => {
            const firstThumb = document.querySelector('#ilCreateAttachPreview .il-picker-item img');
            return {
                revokeCalls: window.__ilRevokeCalls,
                thumbSrcAfterClose: firstThumb ? firstThumb.src : null,
            };
        }, pickerZoomAfter.lbSrc);
        must(ilRevokeState.revokeCalls.includes(pickerZoomAfter.lbSrc), `A1b【289-M】：关闭 lightbox 后 URL.revokeObjectURL 被调用且参数恰为 zoom 大图的 URL（实得调用序列=${JSON.stringify(ilRevokeState.revokeCalls)}，期望含=${pickerZoomAfter.lbSrc.slice(0, 30)}…）`);
        must(!ilRevokeState.revokeCalls.includes(pickerZoomBefore.thumbSrcBefore), `A1b【289-M】：关闭 lightbox 未误 revoke picker 缩略图自身的 URL（IL_CREATE_URLS 生命周期不受影响）`);
        must(ilRevokeState.thumbSrcAfterClose === pickerZoomBefore.thumbSrcBefore, `A1b【289-M】：picker 缩略图 src 关闭前后不变（未被牵连revoke导致失效，实得前后一致=${ilRevokeState.thumbSrcAfterClose === pickerZoomBefore.thumbSrcBefore}）`);
        // ⚠️ 不 delete window.__ilRevokeCalls / 不还原 URL.revokeObjectURL——下方 M-B④ 会再包一层自己的
        //   revokeObjectURL 钩子（window.__revokeCount），两层钩子链式调用互不干扰（M-B④ 的 orig 会调到
        //   本钩子、本钩子的 orig 调到真实 revoke）；若在此 delete 数组但保留钩子函数闭包引用它，后续任何
        //   revoke 调用都会因对 undefined 调用 .push 抛错，反而制造新的 console 报错，故保留不删。

        // ═══════════════════════════════════════════════════════════
        // M-5b（codex 256）：溢出已成立之后，再逐张追加 2 张图，每追加一张单独断言一次最后一项完整
        //   可见——防"只滚第一次就不再滚"的坏实现（ilPickerRender 若只在首次溢出时滚动，本断言必红）。
        // ═══════════════════════════════════════════════════════════
        for (let extra = 1; extra <= 2; extra++) {
            const b5b = await page.evaluate(({ b64, num }) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const modalBody = document.querySelector('#createModal .u-modal-body');
                const wrap = document.getElementById('ilCreateAttachPreview');
                ilPickerCollect([new File([bytes], `probe_img_extra_${num}.png`, { type: 'image/png' })]);
                ilPickerRender();
                const items = wrap.querySelectorAll('.il-picker-item');
                const last = items[items.length - 1];
                const lastRect = last.getBoundingClientRect();
                const bodyRect = modalBody.getBoundingClientRect();
                return { itemCount: items.length, lastTitle: last.getAttribute('title'), lastTop: lastRect.top, lastBottom: lastRect.bottom, bodyTop: bodyRect.top, bodyBottom: bodyRect.bottom };
            }, { b64: TINY_PNG_B64, num: extra });
            const fullyVisible5b = b5b.lastTop >= b5b.bodyTop - 1 && b5b.lastBottom <= b5b.bodyBottom + 1;
            must(fullyVisible5b, `M-5b：溢出已成立后连续追加第 ${extra} 张图，最后一项仍完整可见（防"只滚第一次"坏实现，last=[${b5b.lastTop.toFixed(1)},${b5b.lastBottom.toFixed(1)}] body=[${b5b.bodyTop.toFixed(1)},${b5b.bodyBottom.toFixed(1)}] itemCount=${b5b.itemCount}）`);
            // codex 257 M-C：防假绿——① itemCount 精确等于「基准 a1.n + 本轮序号」，非只判断"变多了"
            //   ② 最后一项的 title 属性确实是本轮新增文件名，非"最后一项其实还是上一轮那个、只是位置凑巧对上"
            const expectedCount5b = a1.n + extra;
            must(b5b.itemCount === expectedCount5b, `M-C：第 ${extra} 轮追加后 itemCount 精确等于基准${a1.n}+${extra}=${expectedCount5b}（实得=${b5b.itemCount}）`);
            must(!!b5b.lastTitle && b5b.lastTitle.includes(`probe_img_extra_${extra}.png`), `M-C：最后一项 title 属性确为本轮新增文件（防"最后一项其实是上一轮的"假绿，实得 title="${b5b.lastTitle}"，期望含="probe_img_extra_${extra}.png"）`);
        }

        await page.evaluate(() => { ilPickerReset(); closeCreateModal(); });
        await page.waitForTimeout(150);

        // ═══════════════════════════════════════════════════════════
        // M-5a（codex 256）：编辑弹窗复用同一个 createModal/#ilCreateAttachPreview（openEditLite →
        //   ilPickerReset），A1 的溢出滚入行为在编辑态同样要成立——建单弹窗单独测过不代表编辑弹窗
        //   也测过（两者共用同一渲染函数，但触发路径不同）。新建单的建单人=admin（探针 token），
        //   can_edit 应为 true（server.js：!voided_at && status!=='已归档' && role!=='viewer'）。
        //   坏形态：若 scrollIntoView 只在新建路径生效，或编辑态附件区没显示，下方断言必须失败。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── M-5a：编辑弹窗复用同一 picker → 溢出滚入行为在编辑态同样成立 ──');
        await page.evaluate((id) => openEditLite(id), issueId);
        // openEditLite 是 async 且要先 fetch 详情才回填标题，等标题变化最稳（不猜时间）
        await page.waitForFunction(() => {
            const el = document.getElementById('createModalTitle');
            return el && el.textContent.includes('编辑');
        }, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
        const editModalState = await page.evaluate(() => ({
            open: document.getElementById('createModal').classList.contains('open'),
            title: document.getElementById('createModalTitle').textContent,
        }));
        must(editModalState.open && editModalState.title.includes('编辑'), `M-5a 前置：openEditLite 成功进入编辑态（can_edit 服务端投影通过，实得=${JSON.stringify(editModalState)}）`);

        const a5a = await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const modalBody = document.querySelector('#createModal .u-modal-body');
            const wrap = document.getElementById('ilCreateAttachPreview');
            let n = 0;
            let overflowDetected = false;
            const maxN = 30;
            while (n < maxN) {
                n++;
                ilPickerCollect([new File([bytes], `probe_edit_img_${n}.png`, { type: 'image/png' })]);
                ilPickerRender();
                if (modalBody.scrollHeight > modalBody.clientHeight) { overflowDetected = true; break; }
            }
            const items = wrap.querySelectorAll('.il-picker-item');
            const last = items[items.length - 1];
            const lastRect = last.getBoundingClientRect();
            const bodyRect = modalBody.getBoundingClientRect();
            return {
                n, overflowDetected,
                itemCount: items.length,
                scrollTop: modalBody.scrollTop,
                lastTop: lastRect.top, lastBottom: lastRect.bottom,
                bodyTop: bodyRect.top, bodyBottom: bodyRect.bottom,
            };
        }, TINY_PNG_B64);
        must(a5a.overflowDetected, `M-5a：编辑态贴到第 ${a5a.n} 张时 .u-modal-body 确已产生真实纵向溢出（封顶30张，实得 overflowDetected=${a5a.overflowDetected}）`);
        must(a5a.itemCount === a5a.n, `M-5a：编辑态 picker 项数与贴图次数一致（实得 itemCount=${a5a.itemCount}，n=${a5a.n}）`);
        must(a5a.scrollTop > 0, `M-5a：编辑态溢出后 .u-modal-body 确实发生了滚动（scrollTop>0，实得=${a5a.scrollTop}）`);
        const lastFullyVisible5a = a5a.lastTop >= a5a.bodyTop - 1 && a5a.lastBottom <= a5a.bodyBottom + 1;
        must(lastFullyVisible5a, `M-5a：编辑态最后一个 .il-picker-item 完整落在 .u-modal-body 可视窗口内（last=[${a5a.lastTop.toFixed(1)},${a5a.lastBottom.toFixed(1)}] body=[${a5a.bodyTop.toFixed(1)},${a5a.bodyBottom.toFixed(1)}]）`);

        // ═══════════════════════════════════════════════════════════
        // L-A（codex 257）：编辑态真实粘贴——test-issue-lite-paste-playwright.js 只覆盖抽屉 #attList，
        //   未覆盖编辑弹窗路径。补一次真实 ClipboardEvent('paste')，走完整 UPaste 共享层
        //   （scopeResolver→isImageArea→collect），不是直调 ilPickerCollect 模拟。构造写法照抄
        //   test-issue-lite-create-attach-playwright.js P5b（S5）同源范式：blur 当前焦点、dispatch 到
        //   document，共享层按当前 open 弹窗（createModal 编辑态）路由。
        // ═══════════════════════════════════════════════════════════
        const beforePasteCount = a5a.n;
        const laPaste = await page.evaluate((b64) => {
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
        const laAfterPasteFiles = await page.evaluate(() => ilPickerFiles().map(f => f.name));
        must(laPaste.defaultPrevented === true, `L-A：编辑态真实粘贴 defaultPrevented=true（共享层确实拦截了默认粘贴，实得=${laPaste.defaultPrevented}）`);
        must(laAfterPasteFiles.length === beforePasteCount + 1 && laAfterPasteFiles.some(n => /^粘贴截图_/.test(n)),
            `L-A：编辑态真实粘贴被 UPaste 共享层真正收入 picker 数组（+1，非直调内部函数，期望长度=${beforePasteCount + 1}，实得=${JSON.stringify(laAfterPasteFiles)}）`);

        await page.evaluate(() => { ilPickerReset(); closeCreateModal(); });
        await page.waitForTimeout(150);

        // ═══════════════════════════════════════════════════════════
        // A3 前置：真实上传 1 张图片附件 + 1 个非图片附件（xlsx），走既有 #attachInput → onAttachPicked
        //   → uploadAttach 真实链路（同 test-issue-lite-d5-playwright.js 范式），非 mock
        // ═══════════════════════════════════════════════════════════
        console.log('\n── A3 前置：真实上传图片 + 非图片附件 ──');
        await page.evaluate((id) => { document.getElementById('attachInput').dataset.issueId = id; }, issueId);
        await page.setInputFiles('#attachInput', { name: 'probe_photo.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64') });
        await page.waitForTimeout(500);
        await page.evaluate((id) => { document.getElementById('attachInput').dataset.issueId = id; }, issueId);
        await page.setInputFiles('#attachInput', { name: 'probe_sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PKfake-xlsx-for-thumb-probe') });
        await page.waitForTimeout(500);

        const attCountCheck = await page.evaluate(async (id) => {
            const r = await fetch('/api/issue-lite/' + id + '/attachments', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const j = await r.json().catch(() => []);
            return { ok: r.ok, count: Array.isArray(j) ? j.length : -1, names: Array.isArray(j) ? j.map(a => a.original_name) : [] };
        }, issueId);
        must(attCountCheck.ok && attCountCheck.count === 2, `A3 前置：图片+非图片各1个共2个附件真实落库（实得=${JSON.stringify(attCountCheck)}）`);

        // ═══════════════════════════════════════════════════════════
        // M-6a（codex 256）：下载请求计数——把 A3-2「同 objectURL」的推断升级为显式请求计数。
        //   打开抽屉之前注册，覆盖 loadAttachments→ilLoadAttThumb 的首次 blob 拉取 + 下方全部
        //   lightbox 开合交互；图片附件仅应发生 1 次真实下载，多次点击缩略图/lightbox 开合复用同一
        //   objectURL 不应再发请求。
        // ═══════════════════════════════════════════════════════════
        const downloadRequests = [];
        const ATT_DOWNLOAD_RE = /\/api\/issue-lite\/attachments\/\d+\/download/;
        page.on('request', req => { if (ATT_DOWNLOAD_RE.test(req.url())) downloadRequests.push(req.url()); });

        // ═══════════════════════════════════════════════════════════
        // A3-1：详情抽屉打开 → 图片附件出现 blob 缩略图；非图片附件仍是纯文字链接（无 img）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── A3-1：详情抽屉图片附件缩略图 + 非图片附件保持纯文字链接 ──');
        await page.evaluate((id) => openDrawer(id), issueId);
        await page.waitForSelector('#drawer.open', { timeout: 5000 });
        // 轮询等待缩略图 blob 异步回填，不用固定 sleep（避免偶发慢导致误判）
        await page.waitForFunction(() => document.querySelectorAll('#attList img.il-att-thumb[src^="blob:"]').length > 0, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);

        const thumbState = await page.evaluate(() => {
            const box = document.getElementById('attList');
            return {
                totalThumbImgs: box.querySelectorAll('img.il-att-thumb').length,
                blobImgs: box.querySelectorAll('img.il-att-thumb[src^="blob:"]').length,
                text: box.textContent,
            };
        });
        must(thumbState.blobImgs === 1, `A3-1：出现 img[src^="blob:"] 恰好 1 个（图片附件，实得=${thumbState.blobImgs}）`);
        must(thumbState.totalThumbImgs === 1, `A3-1：.il-att-thumb 总数恰好 1 个（非图片附件不渲染 img，实得=${thumbState.totalThumbImgs}）`);
        must(thumbState.text.includes('probe_photo.png'), `A3-1：图片附件文件名文字链接仍在（实得含="${thumbState.text.includes('probe_photo.png')}"）`);
        must(thumbState.text.includes('probe_sheet.xlsx'), `A3-1：非图片附件文件名文字链接仍在（实得含="${thumbState.text.includes('probe_sheet.xlsx')}"）`);

        // ═══════════════════════════════════════════════════════════
        // A3-2/A3-3：点击缩略图 → lightbox 出现，大图复用同一 objectURL；点大图不关，ESC/遮罩/×均可关
        // ═══════════════════════════════════════════════════════════
        console.log('\n── A3-2/A3-3：点击缩略图 → lightbox 放大；复用同一 objectURL；点大图不关，ESC/遮罩/×可关 ──');
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        const lbAfterOpen = await page.evaluate(() => {
            const lb = document.getElementById('ilLightbox');
            const img = document.getElementById('ilLightboxImg');
            const thumb = document.querySelector('#attList img.il-att-thumb');
            return { show: lb.classList.contains('show'), imgSrc: img.src, thumbSrc: thumb.src };
        });
        must(lbAfterOpen.show, `A3-2：点击缩略图后 lightbox 出现 show 态（实得=${lbAfterOpen.show}）`);
        must(lbAfterOpen.imgSrc === lbAfterOpen.thumbSrc && lbAfterOpen.imgSrc.startsWith('blob:'), `A3-2：lightbox 大图与缩略图同一 objectURL，未发第二次下载请求（缩略图src前缀=${lbAfterOpen.thumbSrc.slice(0, 24)}… 大图src前缀=${lbAfterOpen.imgSrc.slice(0, 24)}…）`);

        // 点大图本身不关闭
        await page.click('#ilLightboxImg');
        await page.waitForTimeout(100);
        const lbAfterClickImg = await page.evaluate(() => document.getElementById('ilLightbox').classList.contains('show'));
        must(lbAfterClickImg, `A3-3：点击大图本身不关闭 lightbox（实得仍 show=${lbAfterClickImg}）`);

        // ESC 关闭
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const lbAfterEsc = await page.evaluate(() => document.getElementById('ilLightbox').classList.contains('show'));
        must(!lbAfterEsc, `A3-3：ESC 关闭 lightbox（实得 show=${lbAfterEsc}）`);

        // 重开 → 点遮罩空白角落关闭（非 ×、非大图）
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.click('#ilLightbox', { position: { x: 5, y: 5 } });
        await page.waitForTimeout(100);
        const lbAfterOverlay = await page.evaluate(() => document.getElementById('ilLightbox').classList.contains('show'));
        must(!lbAfterOverlay, `A3-3：点遮罩关闭 lightbox（实得 show=${lbAfterOverlay}）`);

        // 重开 → 点 × 关闭
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.click('.il-lightbox-close');
        await page.waitForTimeout(100);
        const lbAfterCloseBtn = await page.evaluate(() => document.getElementById('ilLightbox').classList.contains('show'));
        must(!lbAfterCloseBtn, `A3-3：点 × 关闭 lightbox（实得 show=${lbAfterCloseBtn}）`);

        // ═══════════════════════════════════════════════════════════
        // L-B（codex 257）：点大图说明文字（caption）不关闭——L-1 guard 已排除 caption id，这里补显式
        //   验证；caption 需非空（点缩略图打开时已带文件名 caption，见 loadAttachments 的
        //   data-lightbox-caption 属性）。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── L-B：点击说明文字（caption）不关闭 lightbox ──');
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        const captionText = await page.evaluate(() => document.getElementById('ilLightboxCaption').textContent);
        must(!!captionText, `L-B 前置：caption 非空（点缩略图打开时已带文件名，实得="${captionText}"）`);
        await page.click('#ilLightboxCaption');
        await page.waitForTimeout(100);
        const lbAfterCaptionClick = await page.evaluate(() => ({
            show: document.getElementById('ilLightbox').classList.contains('show'),
            imgSrc: document.getElementById('ilLightboxImg').src,
        }));
        must(lbAfterCaptionClick.show, `L-B：点击说明文字后 lightbox 仍 show（实得=${lbAfterCaptionClick.show}）`);
        must(lbAfterCaptionClick.imgSrc.startsWith('blob:'), `L-B：点击说明文字后大图 src 未被清空（实得前缀="${lbAfterCaptionClick.imgSrc.slice(0, 24)}…"）`);
        // 走一条正常路径关闭，恢复干净状态供下方 M-B 使用
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // ═══════════════════════════════════════════════════════════
        // M-B（codex 257）：body overflow 四条关闭路径精确恢复——先把 body overflow 设为非空可识别原值
        //   'auto'（模拟"页面本就有其他遮罩锁滚动"场景），依次走 ×/ESC/遮罩/closeDrawer 四条关闭路径
        //   （每条路径前重开 lightbox；closeDrawer 路径开着 lightbox 直接关抽屉），每条路径断言 overflow
        //   精确恢复为 'auto'。× 路径在 codex 257 M-A 修复前必红（× 按钮自身 onclick 与父级 overlay
        //   onclick 双绑定，点击冒泡使 ilCloseLightbox 连续执行两次，第二次把已恢复的 overflow 覆盖为
        //   已清空的 ilLbPrevOverflow('')）；ESC/遮罩/closeDrawer 均是单次直调，不受该 bug 影响。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── M-B：body overflow 四条关闭路径精确恢复（×/ESC/遮罩/closeDrawer） ──');
        await page.evaluate(() => { document.body.style.overflow = 'auto'; });

        // 路径①：×
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.click('.il-lightbox-close');
        await page.waitForTimeout(100);
        const mbClose = await page.evaluate(() => ({ overflow: document.body.style.overflow, show: document.getElementById('ilLightbox').classList.contains('show') }));
        must(mbClose.overflow === 'auto', `M-B①×路径：body overflow 精确恢复为 'auto'（实得="${mbClose.overflow}"）`);
        must(!mbClose.show, `M-B①×路径：lightbox 已关闭（实得 show=${mbClose.show}）`);

        // 路径②：ESC
        await page.evaluate(() => { document.body.style.overflow = 'auto'; });
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const mbEsc = await page.evaluate(() => ({ overflow: document.body.style.overflow, show: document.getElementById('ilLightbox').classList.contains('show') }));
        must(mbEsc.overflow === 'auto', `M-B②ESC路径：body overflow 精确恢复为 'auto'（实得="${mbEsc.overflow}"）`);
        must(!mbEsc.show, `M-B②ESC路径：lightbox 已关闭（实得 show=${mbEsc.show}）`);

        // 路径③：点遮罩
        await page.evaluate(() => { document.body.style.overflow = 'auto'; });
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.click('#ilLightbox', { position: { x: 5, y: 5 } });
        await page.waitForTimeout(100);
        const mbOverlay = await page.evaluate(() => ({ overflow: document.body.style.overflow, show: document.getElementById('ilLightbox').classList.contains('show') }));
        must(mbOverlay.overflow === 'auto', `M-B③遮罩路径：body overflow 精确恢复为 'auto'（实得="${mbOverlay.overflow}"）`);
        must(!mbOverlay.show, `M-B③遮罩路径：lightbox 已关闭（实得 show=${mbOverlay.show}）`);

        // 路径④：closeDrawer（开着 lightbox 直接关抽屉；hook revokeObjectURL 计数 + 断言大图 src 清空）
        await page.evaluate(() => { document.body.style.overflow = 'auto'; });
        await page.click('#attList img.il-att-thumb');
        await page.waitForTimeout(150);
        await page.evaluate(() => {
            window.__revokeCount = 0;
            const orig = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = function (u) { window.__revokeCount++; return orig(u); };
        });
        await page.evaluate(() => closeDrawer());
        await page.waitForTimeout(100);
        const mbDrawer = await page.evaluate(() => ({
            overflow: document.body.style.overflow,
            show: document.getElementById('ilLightbox').classList.contains('show'),
            imgSrcAttr: document.getElementById('ilLightboxImg').getAttribute('src'),
            revokeCount: window.__revokeCount,
        }));
        must(mbDrawer.overflow === 'auto', `M-B④closeDrawer路径：body overflow 精确恢复为 'auto'（实得="${mbDrawer.overflow}"）`);
        must(!mbDrawer.show, `M-B④closeDrawer路径：lightbox 已关闭（实得 show=${mbDrawer.show}）`);
        must(mbDrawer.imgSrcAttr === '', `M-B④closeDrawer路径：#ilLightboxImg src 属性已清空（实得="${mbDrawer.imgSrcAttr}"）`);
        must(mbDrawer.revokeCount >= 1, `M-B④closeDrawer路径：closeDrawer 触发 revokeObjectURL ≥1 次（实得=${mbDrawer.revokeCount}）`);

        // 测完把 overflow 还原空串，不残留探针状态
        await page.evaluate(() => { document.body.style.overflow = ''; });

        // M-6a：全部 lightbox 开合交互（含 L-B/M-B 新增路径）做完后，下载请求总数恰=1（图片附件首次
        //   加载 1 次；非图片附件不请求该端点；lightbox 反复开合复用同一 objectURL 不应触发第二次下载）
        must(downloadRequests.length === 1, `M-6a：附件下载端点请求总数恰=1（实得=${downloadRequests.length}${downloadRequests.length ? '：' + downloadRequests.join(' | ') : ''}）`);

        must(consoleErrors.length === 0, `全程 0 console error（实得 ${consoleErrors.length} 个${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
        const cleanupResult = await cleanup();
        const cleanedPaths = cleanupResult.attempted;
        const stillOnDisk = cleanedPaths.filter(p => fs.existsSync(p));
        must(cleanedPaths.length >= 1, `清理闭环前置：至少尝试删除 1 个物理文件（实得=${cleanedPaths.length}——为 0 说明 file_name 契约变化被越界防御全跳过）`);
        must(stillOnDisk.length === 0, `清理闭环：测试单据对应附件物理文件已不存在（尝试删=${cleanedPaths.length} 个，仍残留=${stillOnDisk.length}${stillOnDisk.length ? '：' + stillOnDisk.join(' | ') : ''}）`);
        // codex 256 M-6b：清理 SQL 全部无错误（err 全为 null/undefined）——此前两处 dbRun 的 err 被
        //   try/catch 静默吞，即使 DELETE 真失败测试仍会看似"清理成功"。
        must(cleanupResult.errs.length === 0, `M-6b：末次清理 SQL 全部无错误（实得 errs=${JSON.stringify(cleanupResult.errs.map(e => ({ step: e.step, message: e.err && e.err.message })))}）`);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ S1 探针（A1/A3）存在失败项'); process.exit(1); }
    console.log('  🎉 S1 探针（A1 贴图滚入可视区 + A3 缩略图+lightbox）全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
