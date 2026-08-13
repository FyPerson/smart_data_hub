/**
 * 系统迭代·组 C·SC2「ETA 超容差理由 UI」前端 Playwright 冒烟
 * （方案 §3C.8·docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-eta-overrun-reason-playwright.js
 *
 * ⚠️ 为何新建独立文件而非扩展 test-sys-eta-generation-playwright.js（组 A 主题）：本文件测的是组 C 的
 *   超容差理由块（不是组 A 的自动生成/必填闸），且组 A 文件的全部夹具都是 bug 类型——bug 不参与容差
 *   判定（§3C.2 明文），复用其夹具会让"理由块会不会展开"这条断言天然恒假、测不出真实行为。同既有
 *   verify-sys-eta-generation.js（组 A）/ verify-sys-eta-overrun-snapshot.js（组 C）两文件按组拆分的
 *   既有惯例。
 *
 * 覆盖（至少一页真实链路，siModalEstimate 弹窗——estimate 端点在同一单上可重复调用，最适合演示
 *   "输入变化→理由块动态展开/收起"这条前端行为，且该端点必填闸门①天然带出"打开即预填现值"场景）：
 *   T1 初始不显示：受理自动生成的 ETA 距 deadline 尚在容差内 → 打开「修改预计完成」弹窗理由块初始隐藏
 *   T1b【F-1 新增·用户拍板 P1，2026-08-13】自动生成来源提示：此刻 ETA 仍来自受理自动生成、其后无任何
 *       人工写入 → 弹窗展示"由系统按默认 SLA 于受理/指派时自动生成"提示，且与既有 F2"最近一次估时/
 *       评估"提示互斥（不同时出现）
 *   T2 live 展开：在 T1 基础上把 ETA 改填到超容差的新日期（input 事件触发）→ 理由块展开
 *   T3 前端拦截零副作用：理由块已展开但未填理由 → 点确定被前端拦截（toast 提示，未发起网络请求）→
 *       弹窗仍打开、库内 dev_estimated_at 未变
 *   T4 补填理由提交成功：选择原因标签 + 填写说明 → 提交成功，弹窗关闭，库内理由两列落库
 *   T5 重开预填 + live 收起：重新打开弹窗 → 理由块因现值仍超容差而初始展开（预填理由文本）→ 把 ETA
 *       改填回容差内（input 事件触发）→ 理由块收起 → 提交成功，库内理由两列被清空（C7）
 *   T5b【F-1 对照·成对断言，2026-08-13】T4 的 estimate 提交已是一次人工写入——重开弹窗应改展示既有
 *       F2"最近一次估时/评估"提示，"系统自动生成"提示消失（与 T1b 成对，证明判定随最新写入事件切换）
 *   T4c/T5c【修复 b 成对断言，2026-08-13】详情页正文只读理由展示——用户实测发现的展示缺口（此前唯一
 *       出口是重开估时弹窗预填，正文无任何只读展示）：T4 提交成功后详情页应渲染 #si-eta-overrun-
 *       reason-readonly 且内容正确（T4c）；T5 改回容差内提交成功后该块应消失（T5c，列空整块不渲染）。
 *   T6【追加批·2026-08-13·codex 370-MED-1 采纳·独立夹具】活体安全回归：reason_note 含 HTML 特殊字符
 *       （`<img src=x onerror=alert(1)>"&'`）走真实超容差提交 → 详情只读块/时间线均以纯文本呈现原文
 *       （textContent 含原文 + 全程零新增 <img> + 零 alert/confirm dialog）、列表页该行正常渲染无异常。
 *       静态层（verify-sys-timeline-summary-escape 8/8 等）证明的是源码有没有 esc()，本组补的是真实
 *       浏览器渲染出来到底安不安全这条活体证据。
 *   （各 T 段末尾均各自断言"全程无非预期 console error"，非独立编号项）
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人
const DEV_ID = 8;        // 示例开发A（本地真实 active 非 viewer 账号，同 test-sys-eta-generation-playwright.js T4/T5 既有复用账号）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `eta-reason-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
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

// ── 时间 helper（同既有 verify-sys-*/test-sys-eta-generation-playwright.js 惯例：动态生成，不硬编码
//   未来/过去字面量）。容差=5（improvement，本脚本类型固定用 improvement）。──────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDateOnly(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
function addDays(dt, d) { const c = new Date(dt); c.setDate(c.getDate() + d); return c; }
function fmtDatetimeLocalInput(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }

let seq = 0;
async function mkChangeViaApi(adminTok, deadlineStr) {
    seq++;
    const r = await fetch(`${BASE_URL}/api/sys-issues`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
        body: JSON.stringify({
            intake_contract_version: 2, type: 'improvement', title: `ETA-理由-探针-${seq}`, system_name: 'BMS', source: '内部',
            description: `ETA 超容差理由前端探针夹具-${seq}`, intake_liaison_id: LIAISON_ID,
            needs_feasibility: 0, deadline: deadlineStr,
        }),
    });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(body)}`);
    return body.id;
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    console.log('\n══════ 系统迭代·组C·SC2 ETA 超容差理由 UI 前端 Playwright 冒烟 ══════');

    const createdIds = [];
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1-T5：单条真实链路——一个 improvement 单从受理到估时弹窗多轮交互
        // ═══════════════════════════════════════════════════════════════
        // deadline 设为未来 60 天（远离"现在"，保证受理自动生成的 ETA——近期几天内——必然落在容差内，
        //   T1 天然不展开；后续手动填的"超容差新值"再相对这个 deadline 往后推，两者不会互相干扰）。
        const deadlineStr = fmtDateOnly(addDays(new Date(), 60));
        const id = await mkChangeViaApi(adminTok, deadlineStr);
        createdIds.push(id);

        let r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ risk_level: '二级' }),   // 留空 dev_estimated_at → C11 自动生成分支（近期值，容差内）
        });
        if (r.status !== 200) throw new Error(`前置：受理未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
        r = await fetch(`${BASE_URL}/api/sys-issues/${id}/set-oa-number`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ oa_number: String(Date.now()) }),
        });
        if (r.status !== 200) throw new Error(`前置：补 OA 未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
        r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ assigned_to: DEV_ID }),
        });
        if (r.status !== 200) throw new Error(`前置：指派未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
        const rowAfterAssign = await dbGet('SELECT dev_estimated_at, eta_overrun_reason_code FROM sys_issues WHERE id=?', [id]);
        if (!rowAfterAssign.dev_estimated_at) throw new Error(`前置失败：受理自动生成的 dev_estimated_at 应非空，实得 ${rowAfterAssign.dev_estimated_at}`);
        if (rowAfterAssign.eta_overrun_reason_code) throw new Error(`前置失败：C11 自动生成不应写理由，实得 ${rowAfterAssign.eta_overrun_reason_code}`);

        // 以「开发」（在册成员，非 admin）身份打开——estimate 端点走 assertDevMember，与真实使用者一致。
        const devTok = await signAs(DEV_ID);
        const page = await loginPage(browser, devTok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);

        const blockSel = '#si-eta-reason-estimate';
        const codeSel = '#f_eta_overrun_reason_code';
        const noteSel = '#f_eta_overrun_reason_note';
        const etaSel = '#f_dev_estimated_at';

        // ── T1：初始不显示（受理自动生成的 ETA 在容差内）──────────────────────────────
        console.log('\n── T1：修改预计完成弹窗初始打开——理由块隐藏（现值在容差内）──');
        await page.click('#siDActions button:has-text("修改预计完成")');
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        await shotOnFail(page, (await page.locator(etaSel).count()) === 1, 't1-eta-field-exists', '估时弹窗存在 #f_dev_estimated_at');
        await shotOnFail(page, (await page.locator(blockSel).count()) === 1, 't1-block-exists', '估时弹窗存在理由块容器 #si-eta-reason-estimate');
        const t1Visible = await page.locator(blockSel).isVisible();
        await shotOnFail(page, t1Visible === false, 't1-block-hidden', `初始打开（现值在容差内）→ 理由块隐藏（实得 visible=${t1Visible}）`);
        // ── T1b【F-1·用户拍板 P1 新增】自动生成来源提示——受理留空走 C11 自动生成分支，此刻之后未发生
        //   任何人工写入（assign 未带 dev_estimated_at，仅走"现值非空未过期"no-op 分支）→ 弹窗字段上方
        //   应展示"由系统按默认 SLA 于受理/指派时自动生成"提示（siEstimateFilledHint 的自动生成分支，
        //   与既有"最近一次估时/评估"分支互斥，见 Sys_Iteration.html siEtaIsAutoGenerated 一带）。
        const mBodyText1 = await page.locator('#siMBody').textContent();
        await shotOnFail(page, /由系统按默认 SLA 于受理\/指派时自动生成/.test(mBodyText1), 't1b-auto-gen-hint-shown', 'F-1：ETA 现值为自动生成来源 → 弹窗展示"系统自动生成"提示行');
        await shotOnFail(page, !/最近一次估时\/评估由/.test(mBodyText1), 't1b-f2-hint-not-shown', 'F-1：自动生成分支命中时，既有 F2"最近一次估时/评估"提示不应同时出现（两分支互斥）');

        // ── T2：live 展开（改填超容差新值，input 事件触发）─────────────────────────────
        console.log('\n── T2：填入超容差新 ETA（deadline+20 天，容差 5 天）→ 理由块 live 展开 ──');
        const overrunEtaVal = fmtDatetimeLocalInput(addDays(new Date(deadlineStr + 'T10:00:00'), 20));
        await page.locator(etaSel).fill(overrunEtaVal);
        await page.waitForTimeout(150);
        const t2Visible = await page.locator(blockSel).isVisible();
        await shotOnFail(page, t2Visible === true, 't2-block-shown', `填入超容差新值（gap=20 天 > 容差 5 天）→ 理由块展开（实得 visible=${t2Visible}）`);

        // ── T3：前端拦截零副作用（理由块已展开但未填）───────────────────────────────
        console.log('\n── T3：理由块已展开但未填理由 → 点确定被前端拦截，零副作用 ──');
        const requestsBeforeT3 = [];
        const onReq = (req) => { if (req.url().includes('/api/sys-issues/') && req.url().includes('/estimate')) requestsBeforeT3.push(req.url()); };
        page.on('request', onReq);
        await page.click('#siMConfirm');
        await page.waitForTimeout(400);
        page.off('request', onReq);
        const toastT3 = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, /超期原因/.test(toastT3), 't3-frontend-reject-toast', `未填理由点确定 → toast 含"超期原因"提示（前端拦截，实得："${toastT3}"）`);
        await shotOnFail(page, requestsBeforeT3.length === 0, 't3-no-network-call', `前端拦截应在发起网络请求之前——未观测到 /estimate 请求（实得 ${requestsBeforeT3.length} 次）`);
        const modalStillOpenT3 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalStillOpenT3 === 1, 't3-modal-stays-open', '被前端拦截后弹窗仍打开');
        const rowT3 = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
        await shotOnFail(page, rowT3.dev_estimated_at === rowAfterAssign.dev_estimated_at, 't3-zero-side-effect', `零副作用：库内 dev_estimated_at 未变（实得=${rowT3.dev_estimated_at}）`);

        // ── T4：补填理由提交成功 ───────────────────────────────────────────────
        console.log('\n── T4：补填原因标签+说明 → 提交成功，理由落库 ──');
        await page.selectOption(codeSel, '需求变更');
        await page.fill(noteSel, 'Playwright T4 前端探针超期理由说明');
        // improvement 类型走本弹窗的 effortApplicable 分支——工期（人日）同为必填闸门①的一部分，
        //   非本组测试重点但不填会在理由校验通过后卡在工期必填提示，与本 T4 断言无关但会阻断流程。
        await page.fill('#f_estimated_effort_days', '2');
        await page.click('#siMConfirm');
        await page.waitForTimeout(600);
        const modalClosedT4 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalClosedT4 === 0, 't4-submit-success', '补填理由后提交成功，弹窗关闭');
        const rowT4 = await dbGet('SELECT dev_estimated_at, eta_overrun_reason_code, eta_overrun_reason_note FROM sys_issues WHERE id=?', [id]);
        await shotOnFail(page, rowT4.dev_estimated_at !== rowAfterAssign.dev_estimated_at, 't4-eta-updated', `库内 ETA 已更新为超容差新值（实得=${rowT4.dev_estimated_at}）`);
        await shotOnFail(page, rowT4.eta_overrun_reason_code === '需求变更', 't4-reason-code-saved', `理由标签已落库（实得=${rowT4.eta_overrun_reason_code}）`);
        await shotOnFail(page, rowT4.eta_overrun_reason_note === 'Playwright T4 前端探针超期理由说明', 't4-reason-note-saved', `理由说明已落库（实得=${rowT4.eta_overrun_reason_note}）`);
        // ── T4c【修复 b·成对断言】详情页只读理由展示——弹窗关闭后 siAfterAction 已刷新抽屉，正文应
        //   出现只读超期原因块（#si-eta-overrun-reason-readonly，唯一出口不再是"重开弹窗预填"）。
        const readonlyBlock = page.locator('#si-eta-overrun-reason-readonly');
        await shotOnFail(page, (await readonlyBlock.count()) === 1, 't4c-readonly-block-shown', '修复 b：提交超容差理由后，详情页正文应渲染只读理由块');
        const readonlyText = await readonlyBlock.textContent().catch(() => '');
        await shotOnFail(page, /超期原因：需求变更——Playwright T4 前端探针超期理由说明/.test(readonlyText || ''),
          't4c-readonly-block-content', `修复 b：只读理由块内容应含理由标签+说明，实得="${readonlyText}"`);

        // ── T5：重开预填 + live 收起 + 清理由提交成功 ─────────────────────────────
        console.log('\n── T5：重开弹窗理由块预填展开 → 改填容差内新值 → 理由块收起 → 提交后理由清空 ──');
        await page.click('#siDActions button:has-text("修改预计完成")');
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const t5InitVisible = await page.locator(blockSel).isVisible();
        await shotOnFail(page, t5InitVisible === true, 't5-block-shown-on-reopen', `重开弹窗——现值仍超容差 → 理由块初始即展开（实得 visible=${t5InitVisible}）`);
        const t5CodeVal = await page.locator(codeSel).inputValue();
        await shotOnFail(page, t5CodeVal === '需求变更', 't5-reason-prefilled', `理由块预填现有理由标签（实得="${t5CodeVal}"）`);
        // ── T5b【F-1 对照·成对断言】T4 的 estimate 提交已是一次人工写入——重开弹窗应展示既有 F2"最近
        //   一次估时/评估"提示，不再展示 F-1 的"系统自动生成"提示（与 T1b 成对：写入前 auto=true，
        //   写入后 auto=false，证明判定会随最新写入事件切换，不是恒定值）。
        const mBodyText5 = await page.locator('#siMBody').textContent();
        await shotOnFail(page, /最近一次估时\/评估由/.test(mBodyText5), 't5b-f2-hint-shown', 'F-1 对照：T4 人工写入后重开 → 展示既有 F2"最近一次估时/评估"提示');
        await shotOnFail(page, !/由系统按默认 SLA 于受理\/指派时自动生成/.test(mBodyText5), 't5b-auto-gen-hint-gone', 'F-1 对照：T4 人工写入后重开 → 不再展示"系统自动生成"提示');

        const withinToleranceVal = fmtDatetimeLocalInput(addDays(new Date(deadlineStr + 'T10:00:00'), -1));   // gap=-1（早于 deadline，远小于容差 5，稳定判不超；边界值=5 已由后端单元测试覆盖，本处不重复）
        await page.locator(etaSel).fill(withinToleranceVal);
        await page.waitForTimeout(150);
        const t5AfterFillVisible = await page.locator(blockSel).isVisible();
        await shotOnFail(page, t5AfterFillVisible === false, 't5-block-hides-live', `改填容差内新值（input 事件）→ 理由块 live 收起（实得 visible=${t5AfterFillVisible}）`);

        await page.click('#siMConfirm');
        await page.waitForTimeout(600);
        const modalClosedT5 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalClosedT5 === 0, 't5-submit-success', '改容差内提交成功，弹窗关闭');
        const rowT5 = await dbGet('SELECT dev_estimated_at, eta_overrun_reason_code, eta_overrun_reason_note FROM sys_issues WHERE id=?', [id]);
        await shotOnFail(page, rowT5.eta_overrun_reason_code === null, 't5-reason-cleared', `⭐ 改回容差内后理由两列被清空（C7「期望保留、理由作废」，实得=${rowT5.eta_overrun_reason_code}）`);
        await shotOnFail(page, rowT5.eta_overrun_reason_note === null, 't5-reason-note-cleared', `理由说明同样清空（实得=${rowT5.eta_overrun_reason_note}）`);
        await shotOnFail(page, rowT5.dev_estimated_at !== rowT4.dev_estimated_at, 't5-eta-changed', `ETA 确已被真实改写（实得=${rowT5.dev_estimated_at}）`);
        // ── T5c【修复 b·成对断言】改回容差内后理由列已清空 → 详情页只读理由块应消失（列空整块不渲染，
        //   不留空壳 kv-item）——与 T4c 成对，证明展示随最新落库值切换，不是"曾经出现过就常驻"。
        await shotOnFail(page, (await page.locator('#si-eta-overrun-reason-readonly').count()) === 0,
          't5c-readonly-block-gone', '修复 b：改回容差内提交成功后，详情页只读理由块应消失');

        // 403 噪音说明：本脚本以非 admin 的在册开发（DEV_ID=8）身份打开整页，页面初始化会连带请求若干
        //   admin-only 端点（如 /sys-issues/intake-liaisons，requireAdmin）——同 test-sys-intake-liaison-
        //   playwright.js T6/A3 对 403 噪音的既有豁免范式，属浏览器原生网络日志，非 JS 层未捕获异常。
        const unexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[0349]/.test(e));
        await shotOnFail(page, unexpectedErrors.length === 0, 't-console-clean', `全程无非预期 JS 报错（已知 400/403/409 网络日志噪音已豁免，实得 ${unexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）${unexpectedErrors.length ? '：' + JSON.stringify(unexpectedErrors) : ''}`);
        await page.close();

        // ═══════════════════════════════════════════════════════════════
        // T6【追加批·2026-08-13·codex 370-MED-1 采纳·活体安全回归】reason_note 是用户自由文本，现已
        //   进 timeline summary + 详情只读块（本次两项修复的直接产物）。静态层已证：前端时间线面表达式级
        //   转义守卫（verify-sys-timeline-summary-escape 8/8）+ 详情块/徽章 title 全走 esc()——但静态分析
        //   证明的是"源码里有没有 esc( 调用"，不是"真实浏览器渲染出来到底安不安全"。本组用含 HTML 特殊
        //   字符的理由说明走一遍真实超容差提交，在真实 DOM 里实测：①详情只读块纯文本呈现（无新增 <img>/
        //   无 alert 弹窗/console 无报错）②时间线该行同样纯文本呈现③列表页无异常。独立夹具，自建自清。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n══════ T6：★活体安全回归——reason_note 含 HTML 特殊字符 ══════');
        const deadlineStrT6 = fmtDateOnly(addDays(new Date(), 60));
        const idT6 = await mkChangeViaApi(adminTok, deadlineStrT6);
        createdIds.push(idT6);

        let rT6 = await fetch(`${BASE_URL}/api/sys-issues/${idT6}/intake-accept`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ risk_level: '二级' }),
        });
        if (rT6.status !== 200) throw new Error(`T6 前置：受理未 200，实得 ${rT6.status} ${JSON.stringify(await rT6.json().catch(() => null))}`);
        rT6 = await fetch(`${BASE_URL}/api/sys-issues/${idT6}/set-oa-number`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ oa_number: String(Date.now()) }),
        });
        if (rT6.status !== 200) throw new Error(`T6 前置：补 OA 未 200，实得 ${rT6.status} ${JSON.stringify(await rT6.json().catch(() => null))}`);
        rT6 = await fetch(`${BASE_URL}/api/sys-issues/${idT6}/assign`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
            body: JSON.stringify({ assigned_to: DEV_ID }),
        });
        if (rT6.status !== 200) throw new Error(`T6 前置：指派未 200，实得 ${rT6.status} ${JSON.stringify(await rT6.json().catch(() => null))}`);

        const pageT6 = await loginPage(browser, devTok);   // 复用 T1-T5 已签发的开发身份 token
        // 叠加一个独立 dialog 计数监听（loginPage 内已挂一次 d.accept()，Playwright 允许同事件多监听器
        //   并存互不冲突）——用于证明"全程零 alert/confirm 触发"，不只是"触发了但被自动接掉不算数"。
        const dialogsT6 = [];
        pageT6.on('dialog', d => { dialogsT6.push(d.message()); });
        await pageT6.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idT6}`);
        await pageT6.waitForLoadState('networkidle');
        await pageT6.waitForTimeout(600);

        const overrunEtaValT6 = fmtDatetimeLocalInput(addDays(new Date(deadlineStrT6 + 'T10:00:00'), 20));   // gap=20 天，稳定超容差 5
        const maliciousNote = `<img src=x onerror=alert(1)>"&'`;   // 标签+事件属性+双引号+&+单引号混合体

        await pageT6.click('#siDActions button:has-text("修改预计完成")');
        await pageT6.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await pageT6.waitForTimeout(200);
        await pageT6.locator('#f_dev_estimated_at').fill(overrunEtaValT6);
        await pageT6.waitForTimeout(150);
        await pageT6.selectOption('#f_eta_overrun_reason_code', '需求变更');
        await pageT6.fill('#f_eta_overrun_reason_note', maliciousNote);
        await pageT6.fill('#f_estimated_effort_days', '2');   // improvement 类型 effortApplicable 必填闸门①
        await pageT6.click('#siMConfirm');
        await pageT6.waitForTimeout(600);
        const modalClosedT6 = await pageT6.locator('#siModalOverlay.open').count();
        await shotOnFail(pageT6, modalClosedT6 === 0, 't6-submit-success', 'T6：恶意 reason_note 超容差提交成功，弹窗关闭');

        const rowT6 = await dbGet('SELECT eta_overrun_reason_note FROM sys_issues WHERE id=?', [idT6]);
        await shotOnFail(pageT6, rowT6.eta_overrun_reason_note === maliciousNote,
            't6-note-stored-verbatim', `T6：库内理由说明原样落库（后端不做 HTML 处理，与既有 summary 存原文口径一致），实得="${rowT6.eta_overrun_reason_note}"`);

        // ① 详情只读块以纯文本呈现——textContent 含原文，且详情正文（只读块+时间线共用 #siDBody）
        //   无任何新增 <img> 元素（若被当 HTML 解析，<img src=x onerror=...> 会真的生成一个 img 节点）。
        const readonlyLocT6 = pageT6.locator('#si-eta-overrun-reason-readonly');
        await shotOnFail(pageT6, (await readonlyLocT6.count()) === 1, 't6-readonly-block-shown', 'T6①：详情只读块已渲染');
        const readonlyTextT6 = await readonlyLocT6.textContent().catch(() => '');
        await shotOnFail(pageT6, (readonlyTextT6 || '').includes(maliciousNote),
            't6-readonly-text-verbatim', `T6①：只读块 textContent 含原文（纯文本呈现），实得="${readonlyTextT6}"`);
        const imgCountT6 = await pageT6.locator('#siDBody img').count();
        await shotOnFail(pageT6, imgCountT6 === 0, 't6-no-injected-img', `T6①：详情正文（只读块+时间线）无新增 <img> 元素——证明未被当 HTML 解析，实得 ${imgCountT6} 个`);

        // ② 时间线该行同样纯文本呈现（siRenderTimeline 走既有 esc() 兜底分支，见 estimate summary 拼接）。
        const timelineTextT6 = await pageT6.locator('.si-timeline').textContent().catch(() => '');
        await shotOnFail(pageT6, (timelineTextT6 || '').includes(maliciousNote),
            't6-timeline-text-verbatim', `T6②：时间线正文含原文（纯文本呈现），实得片段="${(timelineTextT6 || '').slice(0, 200)}"`);

        // alert/confirm 等 dialog 全程零触发——比"console 无报错"更直接的执行证据。
        await shotOnFail(pageT6, dialogsT6.length === 0, 't6-no-dialog-triggered', `T6：全程无 alert/confirm 等 dialog 触发（实得 ${dialogsT6.length} 次：${JSON.stringify(dialogsT6)}）`);

        // ③ 列表页无异常——该行正常渲染（未因恶意输入崩溃），且行内无异常注入的 <img>。
        const rowSelT6 = `tr[onclick="siOpenDrawer(${idT6})"]`;
        await shotOnFail(pageT6, (await pageT6.locator(rowSelT6).count()) === 1, 't6-list-row-intact', 'T6③：列表页该行正常渲染（未因恶意输入崩溃）');
        await shotOnFail(pageT6, (await pageT6.locator(`${rowSelT6} img`).count()) === 0, 't6-list-row-no-img', 'T6③：列表该行无异常注入的 <img> 元素');

        const t6UnexpectedErrors = pageT6._consoleErrors.filter(e => !/Failed to load resource.*40[0349]/.test(e));
        await shotOnFail(pageT6, t6UnexpectedErrors.length === 0, 't6-console-clean', `T6：全程无非预期 JS 报错（实得 ${t6UnexpectedErrors.length} 个 / 原始 ${pageT6._consoleErrors.length} 个）${t6UnexpectedErrors.length ? '：' + JSON.stringify(t6UnexpectedErrors) : ''}`);
        await pageT6.close();

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
    } finally {
        await browser.close();
        // 夹具清理（issue 删除会级联相关子表，同既有 verify-sys-* 惯例）
        for (const id of createdIds) {
            try {
                await dbRun('DELETE FROM sys_issue_timeline WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issue_dev_events WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issue_dev_assignees WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        const remain = await dbGet(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${createdIds.map(() => '?').join(',') || 'NULL'})`, createdIds);
        console.log(`  🧹 夹具已清理（残留 ${remain ? remain.c : 0} 条，应为 0）`);
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) process.exit(1);
    }
}

main();
