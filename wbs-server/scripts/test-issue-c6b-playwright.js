/**
 * v1.74.0 C6b — 录入弹窗新增字段 Playwright UI 实测
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c6b-playwright.js
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1, VIEWER_ID = 2;

async function signAs(userId) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId], (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
function dbGet(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }
function dbAll(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.all(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
async function apiCreate(token, body) { const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).id; }

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
async function main() {
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
        await ap.fill('#formOaNumber', 'OA-C6B-001');
        // 附件：用 setInputFiles 传一个内存文件
        await ap.setInputFiles('#formAttachments', { name: 'C6b示例.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('a,b\n1,2') });
        await ap.click('.modal-footer button.btn-primary:has-text("提交")');
        await ap.waitForTimeout(1200); // 等 POST + 附件上传
        const newIssue = await dbGet("SELECT id, raw_requirement, oa_number, requester_dept FROM issues WHERE oa_number='OA-C6B-001'");
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
            must(rawVal.includes('销售看板') && oaVal === 'OA-C6B-001', 'B7 编辑回填 raw_requirement/oa');
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
        const susId = await apiCreate(adminToken, { title: 'C6b暂缓测试', type: '数据质量', requester_dept: '市场营销部', requester_name: 'x', description: 'y' });
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
        await browser.close();
        for (const id of created) await apiDelete(adminToken, id);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6b 录入弹窗实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('实测脚本异常:', e); process.exit(1); });
