/**
 * v1.74.0 C6b — 录入弹窗新增字段 Playwright UI 实测
 *
 * 用法：node scripts/test-issue-c6b-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：OA 单号常量原为固定的 OA-C6B-001，共享实例上会与残留 / 并行运行撞号，改为 `OA-C6B-<时间戳>`（OA_NO，每次运行唯一，按新值查库）；
 *   经 API / 页面建的需求单收尾按状态码清理（200 / 404 算清掉，每个编号单独 try，共 2 轮），崩溃遗留的按 OA_NO 兜底查出来一并清，遗留计失败。
 *   收口批：API 建的夹具标题带运行标记 RUN_TAG（[c6b-<pid>-<时间戳>]），清理再按标记补查；建单助手校验 HTTP 200 与正整数编号，不满足即抛错退 1。页面表单建的那张由 OA_NO 唯一号兜底（标题不带标记）。
 *
 * 验证：
 *   B1 admin 新建弹窗：原始诉求双框显示 + 指派给显示（M-4/H-1）
 *   B2 viewer 新建弹窗：原始诉求隐藏 + 指派给隐藏（M-4/H-1）
 *   B3 新建默认类型 = 看板/报表需求（M-6 修复，非旧"需求"）
 *   B4 业务方部门下拉不含"系统自动"（业务侧过滤）
 *   B5 必填校验：缺部门/姓名 → toast 阻断不提交
 *   B6 admin 完整录入 + 附件两阶段：issue 落库 + 附件落 issue_attachments
 *   B7 编辑模式回填：admin 编辑回填 raw_requirement/oa/部门/数据域
 *   B8 H-1 防清空：admin 编辑不动 raw_requirement → PUT 后原值保留
 *   B9 reason modal：转"已暂缓"弹 reason modal + 必填 + 提交带 last_transition_reason
 *   B10 控制台无 JS 报错
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
let OA_NO = null;      // [#106 S4d-2] ready() 之后赋值：OA-C6B-<时间戳>，每次运行唯一（原固定值 OA-C6B-001）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[c6b-<pid>-<时间戳>]，API 建的夹具标题带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN_ID = 1, VIEWER_ID = 2;

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(userId) {
    return testEnv.signToken(userId);
}
// [#106 S4d-2] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}
// close 等回调落定，关库错误不丢（语句错误优先）
async function dbGet(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.get(sql, p, (e, r) => { db.close((ce) => { const err = e || ce; err ? rej(err) : res(r); }); }); });
}
async function dbAll(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.all(sql, p, (e, r) => { db.close((ce) => { const err = e || ce; err ? rej(err) : res(r); }); }); });
}
// [#106 S4d-2] 返回状态码（原来丢弃，删除失败看不见）
async function apiDelete(token, id) { const r = await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); return r.status; }
// [#106 S4d-2 收口批] 建单助手校验状态码与正整数编号，不满足即抛错（原来 undefined 编号被清理过滤器静默忽略）；服务端已落库而这里没拿到编号的，由 cleanupCreated 按 RUN_TAG 补查
async function apiCreate(token, body) {
    const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    const id = j && j.id;
    if (r.status !== 200 || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败：HTTP ${r.status}，编号=${JSON.stringify(id)}，响应=${JSON.stringify(j).slice(0, 160)}`);
    return id;
}

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    page._errs = errs;
    return page;
}
const isVisible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e && getComputedStyle(e).display !== 'none'; }, sel);

const created = [];

/**
 * [#106 S4d-2] 清理造的需求单：先按 OA_NO 兜底查出页面提交后、脚本崩溃前未登记的单；再每个编号单独 try / catch，一个失败不中断后续；
 * 看状态码（200 / 404 算清掉），只把清理成功的编号移出追踪；失败的编号再试一轮（共 2 轮，间隔 200ms）；遗留逐个计失败。
 * 原来 `for (...) await apiDelete(...)` 不看状态码，一个抛错还会中断后面的清理
 */
async function cleanupCreated(adminToken) {
    try {
        const left = await dbAll('SELECT id FROM issues WHERE oa_number=?', [OA_NO]);
        for (const r of left) if (!created.includes(r.id)) created.push(r.id);
    } catch (e) { must(false, `清理前按 OA 单号兜底查询失败：${e && e.message}`); }
    try {   // [#106 S4d-2 收口批] 再按运行标记补查：建单请求服务端已落库、客户端读响应 / 解析失败而没登记编号的单
        const tagged = RUN_TAG ? await dbAll(`SELECT id FROM issues WHERE title LIKE '%' || ? || '%'`, [RUN_TAG]) : [];
        for (const r of tagged) if (!created.includes(r.id)) created.push(r.id);
    } catch (e) { must(false, `清理前按运行标记补查失败：${e && e.message}`); }
    const lastErr = new Map();
    for (let round = 0; round < 2; round++) {
        const pending = created.filter((id) => Number.isInteger(id));
        if (pending.length === 0) break;
        if (round > 0) await new Promise((r) => setTimeout(r, 200));
        for (const id of pending) {
            try {
                const st = await apiDelete(adminToken, id);
                if (st === 200 || st === 404) { created.splice(created.indexOf(id), 1); lastErr.delete(id); }
                else lastErr.set(id, `HTTP ${st}`);
            } catch (e) { lastErr.set(id, (e && e.message) || String(e)); }
        }
    }
    for (const id of created.filter((x) => Number.isInteger(x))) must(false, `清理测试需求单 #${id} 失败（已重试 1 轮）：${lastErr.get(id)}`);
}

async function main() {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    OA_NO = 'OA-C6B-' + Date.now();
    RUN_TAG = `[c6b-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    const viewerToken = await signAs(VIEWER_ID);
    console.log('\n══════ v1.74.0 C6b 录入弹窗 Playwright 实测 ══════');
    const browser = await chromium.launch();
    let allErrs = [];

    try {
        // ---- admin 视角 ----
        const ap = await gotoAs(browser, adminToken);
        await ap.click('button:has-text("新建需求")');
        await ap.waitForTimeout(400);

        must(await isVisible(ap, '#rawRequirementGroup'), 'B1 admin 弹窗：原始诉求双框显示（M-4）');
        must(await isVisible(ap, '#assignedToGroup'), 'B1 admin 弹窗：指派给显示（H-1）');
        const defType = await ap.$eval('#formType', e => e.value);
        must(defType === '看板/报表需求', `B3 新建默认类型=看板/报表需求（M-6，实际 ${defType}）`);
        const deptOpts = await ap.$$eval('#formRequesterDept option', os => os.map(o => o.value));
        must(!deptOpts.includes('系统自动'), 'B4 部门下拉不含"系统自动"（业务侧过滤）');

        // B5 必填校验
        await ap.fill('#formTitle', 'C6b校验测试');
        // 不填部门/姓名直接提交
        await ap.click('.modal-footer button.btn-primary:has-text("提交")');
        await ap.waitForTimeout(300);
        const stillOpen = await isVisible(ap, '#createModal');
        must(stillOpen, 'B5 缺部门/姓名 → 校验阻断弹窗不关');

        // B6 完整录入 + 附件两阶段
        await ap.selectOption('#formRequesterDept', '市场营销部');
        await ap.fill('#formRequesterName', '测试业务方');
        await ap.fill('#formRawRequirement', '业务方原话：想要个销售看板');
        await ap.fill('#formDescription', '梳理后：PBI 销售看板按月');
        await ap.fill('#formOaNumber', OA_NO);
        // 附件：用 setInputFiles 传一个内存文件
        await ap.setInputFiles('#formAttachments', { name: 'C6b示例.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('a,b\n1,2') });
        await ap.click('.modal-footer button.btn-primary:has-text("提交")');
        await ap.waitForTimeout(1200); // 等 POST + 附件上传
        const newIssue = await dbGet("SELECT id, raw_requirement, oa_number, requester_dept FROM issues WHERE oa_number=?", [OA_NO]);
        must(newIssue && newIssue.raw_requirement.includes('销售看板'), 'B6 完整录入落库（raw_requirement/oa/部门）');
        if (newIssue) {
            created.push(newIssue.id);
            const atts = await dbAll('SELECT original_name FROM issue_attachments WHERE issue_id=?', [newIssue.id]);
            must(atts.length === 1 && atts[0].original_name === 'C6b示例.xlsx', `B6 附件两阶段落库（${atts.length} 个）`);
        } else { must(false, 'B6 附件（issue 未创建跳过）'); }

        // B7+B8 编辑模式回填 + H-1 防清空
        if (newIssue) {
            await ap.evaluate(id => openEditModal(id), newIssue.id);
            await ap.waitForTimeout(700);
            const rawVal = await ap.$eval('#formRawRequirement', e => e.value);
            const oaVal = await ap.$eval('#formOaNumber', e => e.value);
            must(rawVal.includes('销售看板') && oaVal === OA_NO, 'B7 编辑回填 raw_requirement/oa');
            // B11 codex M-3：编辑模式隐藏指派下拉（PUT 不处理 assigned_to，显示会误导）
            must(!(await isVisible(ap, '#assignedToGroup')), 'B11 admin 编辑模式：指派下拉隐藏（M-3，PUT 不处理 assigned_to）');
            // 不动 raw_requirement，改标题后提交 → 验 raw_requirement 不被清空
            await ap.fill('#formTitle', 'C6b编辑后标题');
            await ap.click('.modal-footer button.btn-primary:has-text("提交")');
            await ap.waitForTimeout(800);
            const after = await dbGet('SELECT title, raw_requirement FROM issues WHERE id=?', [newIssue.id]);
            must(after.title === 'C6b编辑后标题' && after.raw_requirement.includes('销售看板'), 'B8 H-1：编辑不动 raw_requirement → 原值保留不被清空');
        }

        allErrs = allErrs.concat(ap._errs);
        await ap.close();

        // ---- viewer 视角 ----
        const vp = await gotoAs(browser, viewerToken);
        await vp.click('button:has-text("新建需求")');
        await vp.waitForTimeout(400);
        must(!(await isVisible(vp, '#rawRequirementGroup')), 'B2 viewer 弹窗：原始诉求隐藏（M-4）');
        must(!(await isVisible(vp, '#assignedToGroup')), 'B2 viewer 弹窗：指派给隐藏（H-1）');
        allErrs = allErrs.concat(vp._errs);
        await vp.close();

        // ---- B9 reason modal（admin 造单 → 转已暂缓）----
        const susId = await apiCreate(adminToken, { title: 'C6b暂缓测试' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: 'x', description: 'y' });
        created.push(susId);
        const rp = await gotoAs(browser, adminToken);
        await rp.evaluate(id => openDrawer(id), susId);
        await rp.waitForTimeout(600);
        // 点"转为已暂缓" → 应弹 reason modal（fire-and-forget：changeStatus 内部 await reason modal，
        //   不能 await evaluate 否则 modal 等用户输入永不 resolve 致 evaluate hang）
        await rp.evaluate(id => { changeStatus(id, '已暂缓', '待处理'); }, susId);
        await rp.waitForTimeout(400);
        const reasonOpen = await isVisible(rp, '#reasonModal');
        must(reasonOpen, 'B9 转"已暂缓"弹出 reason modal');
        // 空提交被拦
        await rp.click('#reasonModalConfirm');
        await rp.waitForTimeout(200);
        must(await isVisible(rp, '#reasonModal'), 'B9 reason 空 → 拦截不关');
        // 填 reason 提交
        await rp.fill('#reasonModalInput', '资源不足暂缓');
        await rp.click('#reasonModalConfirm');
        await rp.waitForTimeout(700);
        const susAfter = await dbGet('SELECT status, last_transition_reason FROM issues WHERE id=?', [susId]);
        must(susAfter.status === '已暂缓' && (susAfter.last_transition_reason || '').includes('资源不足'), 'B9 提交带 last_transition_reason 落库 + 状态=已暂缓');
        allErrs = allErrs.concat(rp._errs);
        await rp.close();

        must(allErrs.length === 0, `B10 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);

    } finally {
        try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
        await cleanupCreated(adminToken);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6b 录入弹窗实测全部通过\n' : '  🚫 存在失败项\n');
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
    console.error('实测脚本异常:', e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
