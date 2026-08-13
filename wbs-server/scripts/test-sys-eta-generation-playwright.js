/**
 * 系统迭代·组 A「预计完成时间自动生成 + 超时受理/超时指派强制填写」前端 Playwright 冒烟
 * （方案 §2·docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-eta-generation-playwright.js
 *
 * ⚠️ 为何新建独立文件而非扩展 test-sys-intake-liaison-playwright.js（方案允许"或按套件结构新建"）：
 *   实测发现该文件 T1「GET intake-liaisons 恰返回 1 个候选」的前提在当前真实生产库（task_pool.db）下
 *   已不成立（现有 8 个 eligible 候选，非该文件编写时的 1 个——库随时间自然增长了受理人候选池，与本次
 *   组 A 改动无关），T1 断言失败导致 T2 建单表单交互异常、T3 因此 timeout，整个脚本在到达 T6（受理弹窗）
 *   之前就已崩溃退出——这是**改动前就存在**的环境漂移，不是本次引入的回归，不在组 A 范围内修，故另建
 *   不依赖该前提的独立文件覆盖本次新增的 UI 行为。
 *
 * 覆盖：
 *   T0【F-2 新增·2026-08-13】前端镜像函数 siComputeSysDefaultEta 与后端 computeSysDefaultEta 边界向量
 *       逐条核对——bug 15:00 分界（前一秒/当刻/后一秒）+ 跨月 + 跨年 + 非 bug 全 7 天 weekday 覆盖
 *       （周一~周三→当周五、周四~周日→下周五），独立复算不复用被测公式。
 *   T1 受理弹窗必填流：SLA 已超 + ETA 为空 → 字段出现且带必填星号/超时受理提示文案 → 留空提交被拒
 *       （错误 toast + 弹窗不关）→ 填未来值提交成功
 *   T2 提示条对照·显示：SLA 未超 + deadline 早于自动生成的 ETA → 字段出现（选填，C11 预警文案）→
 *       受理成功后 toast 含"超出业务方期望 N 天"+"受理弹窗会出现设定入口"新措辞；详情页展示 F-1
 *       "系统自动生成"来源提示
 *   T3 ★对照组·常态隐藏：SLA 未超 + 无 deadline（三情形全不命中）→ ETA 字段组整体隐藏（与 T1/T2 的
 *       "出现"成对）→ 受理成功后仅普通"受理通过" toast，不含超出提示
 *   T4 改派弹窗必填流：既有 ETA 已过期 → 字段出现且带必填星号/过期提示文案 → 留空提交被拒 → 填未来值
 *       + 改派原因 + 成员变更一并提交成功
 *   T5【F-2 改造·2026-08-13 重写】改派弹窗常态流：既有 ETA 非空且未过期（两情形均不命中）→ ETA 字段组
 *       整体隐藏（与 T4 成对）→ 仅改成员仍可正常提交，ETA 原样保留
 *   T6【F-2 新增】指派弹窗常态流：受理自动生成的 ETA 非空且未过期 → ETA 字段组整体隐藏 → 仅选成员仍可
 *       正常提交（siModalAssign 自己的渲染分支在"隐藏"方向的独立覆盖，不只依赖 T4 对同一底层判据函数
 *       的"必填"方向覆盖）
 *   T7【codex 368 号 MED-1 收口·2026-08-13】指派弹窗反向兜底：既有 ETA 非空且未过期（真实应隐藏，
 *       siAssignReassignEtaVisibility 判"隐藏"）→ page.evaluate 直调 siRevealEtaFieldOnFallback 强制
 *       渲染字段（模拟客户端时钟偏快导致的误判展示，与真实"服务端要求必填"触发路径同一份 DOM 操作、
 *       仅触发原因不同）→ 填未来值提交 → 服务端按真实时钟判定其实未过期，返回 409 ETA_NOT_EXPIRED →
 *       字段组+理由块被收起、容器内出现"已收起，请直接重新提交"提示、弹窗不关 → 不改任何输入直接再次
 *       提交 → 成功（ETA 原样保留，未被那次被拒的填值污染）。★对照组：同一弹窗内未强制渲染的常态隐藏
 *       路径（T6 已覆盖，此处不重复起新夹具，仅在 T7 断言链末尾复核一次"未强制渲染时字段确实不存在"，
 *       证明本组的"存在"是显式造出来的，不是环境本来就如此）。
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

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `eta-fail-${name}.png`);
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

// ── 时间 helper（同既有 verify-sys-* 惯例：动态生成，不硬编码未来/过去字面量）──────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmt(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`; }
function addDays(dt, d) { const c = new Date(dt); c.setDate(c.getDate() + d); return c; }
function addMinutes(dt, m) { return new Date(dt.getTime() + m * 60000); }
// datetime-local input 值格式：'YYYY-MM-DDTHH:MM'
function fmtDatetimeLocalInput(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}T${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }

const FAR_PAST_CREATED = '2020-01-01 08:00:00';   // bug 类型：默认 SLA(2020-01-02 17:00) 早已过去，稳定判"已超"

let seq = 0;
async function mkBugViaApi(adminTok, createdAt, extra = {}) {
    seq++;
    const r = await fetch(`${BASE_URL}/api/sys-issues`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
        body: JSON.stringify({
            intake_contract_version: 2, type: 'bug', title: `ETA-FE-探针-${seq}`, system_name: 'BMS', source: '内部',
            description: `ETA 前端探针夹具-${seq}`, intake_liaison_id: LIAISON_ID, ...extra,
        }),
    });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(body)}`);
    const id = body.id;
    if (createdAt) await dbRun(`UPDATE sys_issues SET created_at = ? WHERE id = ?`, [createdAt, id]);
    return id;
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    console.log('\n══════ 系统迭代·组A 预计完成时间自动生成 前端 Playwright 冒烟 ══════');

    const createdIds = [];
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T0【F-2 新增·用户拍板 P3】前端镜像函数 siComputeSysDefaultEta 与后端 computeSysDefaultEta
        //   逐条核对边界向量——抽自 scripts/verify-sys-eta-generation.js 的 [P]/[P2] 组，独立复算手法：
        //   非 bug 分支用 addDays 在动态取得的"本周一"上直接推日历日，不复用被测的 isoDow 公式，避免
        //   测试与实现共享同一处错误互相掩护（同 [P2] 注释的既有纪律）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T0：前端 ETA 默认 SLA 镜像函数边界向量核对（siComputeSysDefaultEta） ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(300);

            // bug 类型：15:00 分界（14:59:59/15:00:00/15:00:01）+ 跨月 + 跨年（与 verify-sys-eta-generation.js
            //   [P] 组逐字同值，两侧共用同一批固定日期文本，方便对照排错）。
            const bugCases = [
                ['2026-08-12 14:59:59', '2026-08-12 17:00:00', '14:59:59（15:00 分界前一秒）'],
                ['2026-08-12 15:00:00', '2026-08-13 17:00:00', '15:00:00（分界当刻）'],
                ['2026-08-12 15:00:01', '2026-08-13 17:00:00', '15:00:01（分界后一秒）'],
                ['2026-08-31 15:30:00', '2026-09-01 17:00:00', '跨月（8/31→9/1）'],
                ['2026-12-31 15:30:00', '2027-01-01 17:00:00', '跨年（12/31→1/1）'],
            ];
            for (const [input, expected, label] of bugCases) {
                const got = await page.evaluate((v) => window.siComputeSysDefaultEta(v, 'bug'), input);
                await shotOnFail(page, got === expected, `t0-bug-${input}`, `bug 类型 ${label}：${input} → 期望 ${expected}（实得 ${got}）`);
            }

            // 非 bug 类型：动态取"本周一"，独立用 addDays 推日历日（不复用被测 isoDow 公式）——
            //   周一~周三→本周一+4（当周五）；周四~周日→本周一+11（下周五）。至少覆盖周一/周三/周四/周日。
            const today = new Date();
            const isoDowToday = ((today.getDay() + 6) % 7) + 1;
            const monday = addDays(today, -(isoDowToday - 1));
            const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            const offsets = [4, 4, 4, 11, 11, 11, 11];
            for (let i = 0; i < 7; i++) {
                const createdDay = addDays(monday, i);
                createdDay.setHours(10, 0, 0, 0);   // 任意非边界时刻——非 bug 类型不涉及 15:00 分界
                const target = addDays(monday, offsets[i]);
                const expected = `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} 17:00:00`;
                const got = await page.evaluate(([v, t]) => window.siComputeSysDefaultEta(v, t), [fmt(createdDay), 'improvement']);
                await shotOnFail(page, got === expected, `t0-nonbug-${dayNames[i]}`, `非 bug 类型 ${dayNames[i]}建单（${fmt(createdDay)}）→ 期望 ${expected}（实得 ${got}）`);
            }

            await shotOnFail(page, page._consoleErrors.length === 0, 't0-console-clean', `T0 全程无非预期 JS 报错（实得 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T1：受理弹窗必填流——SLA 已超 + ETA 为空 → 留空提交被拒，填未来值提交成功
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1：受理弹窗必填流（SLA 已超 + ETA 为空）──');
            const id = await mkBugViaApi(adminTok, FAR_PAST_CREATED);
            createdIds.push(id);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const etaField = page.locator('#f_dev_estimated_at');
            await shotOnFail(page, (await etaField.count()) === 1, 't1-eta-field-exists', '受理弹窗存在 #f_dev_estimated_at 预计完成时间输入框');
            // 【F-2 新增】①现值为空∧受理时刻已超默认 SLA（超时受理）→ 必填标注 + 对应提示文案
            const t1LabelHtml = await etaField.locator('xpath=preceding-sibling::label[1]').innerHTML();
            await shotOnFail(page, /u-req/.test(t1LabelHtml), 't1-eta-required-star', `F-2：超时受理情形 → ETA 字段 label 含必填星号（实得="${t1LabelHtml}"）`);
            const t1MBodyText = await page.locator('#siMBody').textContent();
            await shotOnFail(page, /受理已超时，请填写预计完成时间才能提交/.test(t1MBodyText), 't1-eta-overdue-hint', 'F-2：超时受理情形 → 展示"受理已超时"提示文案');

            // 留空提交 → 服务端拒绝（INTAKE_ESTIMATE_REQUIRED），弹窗留着供补填
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toastEmpty = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, /预计完成时间/.test(toastEmpty), 't1-empty-rejected-toast', `留空提交 → toast 含服务端拒绝文案（实得："${toastEmpty}"）`);
            const modalStillOpen1 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalStillOpen1 === 1, 't1-modal-stays-open', '留空提交被拒后弹窗仍打开（可补填重试）');
            const rowAfterReject = await dbGet('SELECT dev_estimated_at, status FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowAfterReject.dev_estimated_at === null, 't1-zero-side-effect', `零副作用：dev_estimated_at 仍为空（实得=${rowAfterReject.dev_estimated_at}）`);

            // 补填未来值 → 提交成功
            const futureVal = fmtDatetimeLocalInput(addDays(new Date(), 3));
            await etaField.fill(futureVal);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const modalClosed1 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosed1 === 0, 't1-fill-future-success', '补填未来值提交 → 受理成功，弹窗关闭');
            const rowAfterOk = await dbGet('SELECT dev_estimated_at, status FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, !!rowAfterOk.dev_estimated_at, `t1-db-value-written`, `库内 dev_estimated_at 已写入（实得=${rowAfterOk.dev_estimated_at}）`);
            await shotOnFail(page, rowAfterOk.status === '待处理', 't1-db-status', `受理后 status=待处理（实得=${rowAfterOk.status}）`);

            // "Failed to load resource...400" 是浏览器对本组故意触发的拒绝请求的原生网络日志（同
            //   test-sys-intake-liaison-playwright.js T6/A3 对 403 噪音的既有豁免范式），非 JS 层未捕获异常。
            const t1UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[04]/.test(e));
            await shotOnFail(page, t1UnexpectedErrors.length === 0, 't1-console-clean', `T1 全程无非预期 JS 报错（已知 400 网络日志噪音已豁免，实得 ${t1UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T2：提示条对照·显示——SLA 未超 + deadline 早于自动生成的 ETA → toast 含"超出业务方期望"
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T2：提示条对照·显示（SLA 未超 + deadline 早于自动生成 ETA）──');
            // created_at=当前时刻（保证 SLA 未超，自动生成分支）；deadline 设为昨天，必然早于任何未来生成的 ETA。
            const yesterday = addDays(new Date(), -1);
            const deadlineStr = `${yesterday.getFullYear()}-${pad2(yesterday.getMonth() + 1)}-${pad2(yesterday.getDate())}`;
            const id = await mkBugViaApi(adminTok, fmt(new Date()), { deadline: deadlineStr });
            createdIds.push(id);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            // 【F-2 新增】③现值为空∧SLA 未超∧deadline 非空∧默认 SLA 值将晚于 deadline（C11 预警）
            //   → 字段出现但为选填（无必填星号），展示预警文案。
            const t2EtaField = page.locator('#f_dev_estimated_at');
            await shotOnFail(page, (await t2EtaField.count()) === 1, 't2-eta-field-exists-c11', 'F-2：C11 预警情形 → ETA 字段出现（非隐藏）');
            const t2LabelHtml = await t2EtaField.locator('xpath=preceding-sibling::label[1]').innerHTML();
            await shotOnFail(page, !/u-req/.test(t2LabelHtml), 't2-eta-not-required', `F-2：C11 预警情形 → 字段选填，无必填星号（实得="${t2LabelHtml}"）`);
            const t2MBodyText = await page.locator('#siMBody').textContent();
            await shotOnFail(page, /默认生成将超出业务方期望 \d+ 天，可在此直接设定/.test(t2MBodyText), 't2-eta-c11-hint', 'F-2：C11 预警情形 → 展示"默认生成将超出业务方期望…可在此直接设定"提示文案');
            await page.click('#siMConfirm');   // 留空 → 自动生成分支
            await page.waitForTimeout(600);
            const toastT2 = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, /超出业务方期望/.test(toastT2), 't2-overrun-prompt-shown', `deadline 早于自动生成 ETA → toast 含"超出业务方期望"提示（实得："${toastT2}"）`);
            await shotOnFail(page, /超出期望时受理弹窗会出现设定入口/.test(toastT2), 't2-toast-f2-wording', 'F-2 要点④：toast 文案已同步改为"超出期望时受理弹窗会出现设定入口"语义');
            const rowT2 = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, !!rowT2.dev_estimated_at, 't2-auto-generated', `已自动生成 ETA（实得=${rowT2.dev_estimated_at}）`);

            // 【F-1 新增·用户拍板 P1】详情页 ETA 字段区应展示"系统自动生成"来源提示——受理留空走自动
            //   生成分支，此刻其后未发生任何人工写入。
            await page.waitForTimeout(300);
            const t2DetailText = await page.locator('#siDBody').textContent();
            await shotOnFail(page, /由系统按默认 SLA 自动生成，如与实际不符请通过估时调整/.test(t2DetailText), 't2-detail-auto-gen-hint', 'F-1a：详情页 ETA 字段区展示"系统自动生成"来源提示');

            await shotOnFail(page, page._consoleErrors.length === 0, 't2-console-clean', `T2 全程无 JS 报错（${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3：★对照组·提示条不显示——SLA 未超 + 无 deadline → 仅普通"受理通过" toast，无超出提示
        //   （与 T2 成对：同样走自动生成分支，唯一变量是有无 deadline，证明提示条不是恒显）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T3：★对照组·提示条不显示（SLA 未超 + 无 deadline）──');
            const id = await mkBugViaApi(adminTok, fmt(new Date()));   // 无 deadline
            createdIds.push(id);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            // 【F-2 新增·成对断言核心】常态受理——现值为空∧SLA 未超∧无 deadline（三情形全不命中）
            //   → ETA 字段组整体隐藏（与 T1/T2 的"出现"两例成对，构成"显示/隐藏两个方向都有用例"）。
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 0, 't3-eta-field-hidden', 'F-2：常态受理（不超时/不预警）→ ETA 字段组整体隐藏');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const toastT3 = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, toastT3.includes('受理通过') && !/超出业务方期望/.test(toastT3), 't3-plain-success-toast', `无 deadline → toast 为普通"受理通过"、不含超出提示（实得："${toastT3}"）`);
            const rowT3 = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, !!rowT3.dev_estimated_at, 't3-auto-generated', `已自动生成 ETA（实得=${rowT3.dev_estimated_at}）——证明本组与 T2 走的是同一分支，唯一变量是有无 deadline`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't3-console-clean', `T3 全程无 JS 报错（${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4：指派（改派）弹窗必填流——既有 ETA 已过期 → 留空提交被拒，填未来值+改派原因+成员变更一并成功
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T4：指派（改派）弹窗必填流（既有 ETA 已过期）──');
            const id = await mkBugViaApi(adminTok, fmt(new Date()));
            createdIds.push(id);
            // 受理 + 指派给示例开发A(8，本地真实 active 非 viewer 账号，同 test-sys-intake-liaison-playwright.js
            //   T6/A3 既有用例复用同一账号)，再直接把 ETA 改成过期值（跳过等待，聚焦本组要测的必填闸）。
            let r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: '{}' });
            if (r.status !== 200) throw new Error(`T4 前置：受理未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: JSON.stringify({ assigned_to: 8 }) });
            if (r.status !== 200) throw new Error(`T4 前置：指派未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            const expiredVal = fmt(addMinutes(new Date(), -30));
            await dbRun(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("改派")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const reassignEtaField = page.locator('#f_dev_estimated_at');
            await shotOnFail(page, (await reassignEtaField.count()) === 1, 't4-eta-field-exists', '改派弹窗存在 #f_dev_estimated_at 预计完成时间输入框');
            // 【F-2 新增】②现值非空∧已过期 → 必填标注 + 对应提示文案
            const t4LabelHtml = await reassignEtaField.locator('xpath=preceding-sibling::label[1]').innerHTML();
            await shotOnFail(page, /u-req/.test(t4LabelHtml), 't4-eta-required-star', `F-2：既有 ETA 已过期情形 → 字段 label 含必填星号（实得="${t4LabelHtml}"）`);
            const t4MBodyText = await page.locator('#siMBody').textContent();
            await shotOnFail(page, /原预计完成时间已过期，请填写新值才能提交/.test(t4MBodyText), 't4-eta-expired-hint', 'F-2：既有 ETA 已过期情形 → 展示"原预计完成时间已过期"提示文案');

            // 勾选一名额外开发成员（示例开发B id9，本地真实 active 非 viewer 账号）+ 填调整原因，但不填 ETA → 应被服务端拒绝
            const mbody = page.locator('#siMBody');
            await mbody.locator('.si-member-chk[value="9"]').check();
            await page.fill('#f_reason', 'ETA 前端探针-改派');
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toastT4Empty = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, /预计完成时间/.test(toastT4Empty), 't4-empty-rejected-toast', `留空提交 → toast 含服务端拒绝文案（实得："${toastT4Empty}"）`);
            const modalStillOpenT4 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalStillOpenT4 === 1, 't4-modal-stays-open', '留空提交被拒后弹窗仍打开');
            const rowT4Reject = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT4Reject.dev_estimated_at === expiredVal, 't4-zero-side-effect', `零副作用：ETA 未变（实得=${rowT4Reject.dev_estimated_at}）`);
            const rosterT4Reject = await dbAll('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
            await shotOnFail(page, rosterT4Reject.length === 1, 't4-roster-unchanged', `零副作用：roster 未变（实得 ${rosterT4Reject.length} 人）`);

            // 补填未来值 → 提交成功（roster+ETA 一并落地）
            const futureVal4 = fmtDatetimeLocalInput(addDays(new Date(), 4));
            await reassignEtaField.fill(futureVal4);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const modalClosedT4 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedT4 === 0, 't4-fill-future-success', '补填未来值提交 → 改派成功，弹窗关闭');
            const rowT4Ok = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT4Ok.dev_estimated_at !== expiredVal && !!rowT4Ok.dev_estimated_at, 't4-db-value-updated', `库内 ETA 已更新（实得=${rowT4Ok.dev_estimated_at}）`);
            const rosterT4Ok = await dbAll('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
            await shotOnFail(page, rosterT4Ok.length === 2, 't4-roster-updated', `roster 差量同时生效（实得 ${rosterT4Ok.length} 人）`);
            const tlT4 = await dbGet(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? ORDER BY id DESC LIMIT 1`, [id]);
            await shotOnFail(page, !!tlT4 && tlT4.summary && tlT4.summary.includes('超时指派'), 't4-timeline-note', `timeline 新增"超时指派"记录（实得：${JSON.stringify(tlT4)}）`);

            const t4UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[04]/.test(e));
            await shotOnFail(page, t4UnexpectedErrors.length === 0, 't4-console-clean', `T4 全程无非预期 JS 报错（已知 400 网络日志噪音已豁免，实得 ${t4UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T5【F-2 改造·2026-08-13 重写】改派弹窗常态流——既有 ETA 非空且未过期时，两情形均不命中
        //   （siAssignReassignEtaVisibility 判"隐藏"），ETA 字段组整体不出现；旧口径下"未过期格显式
        //   填值 → 409 拒绝"这条分支随字段整体隐藏而在正常 UI 路径下不再可达（用户没有输入框可填），
        //   该负例仍由 scripts/verify-sys-eta-generation.js [MED-2] 端点级覆盖，不在前端套件重复；
        //   本组改测"字段确实缺席 + 仅改成员也能正常提交"这条新增的常态路径，并保留 note 引导语校验
        //   ——note 已随 F-2 精简为通用说明，不再含 ETA 专属措辞，故本组不再断言那句旧文案。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T5：改派弹窗常态流（既有 ETA 非空且未过期 → 字段隐藏，仅改成员仍可提交）──');
            const id = await mkBugViaApi(adminTok, fmt(new Date()));   // created_at=当前时刻 → SLA 未超
            createdIds.push(id);
            // 受理（自动生成，非过期）+ 指派给示例开发A(8)，此刻 dev_estimated_at 非空且未过期。
            let r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: '{}' });
            if (r.status !== 200) throw new Error(`T5 前置：受理未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: JSON.stringify({ assigned_to: 8 }) });
            if (r.status !== 200) throw new Error(`T5 前置：指派未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            const rowT5Before = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            if (!rowT5Before.dev_estimated_at) throw new Error(`T5 前置失败：受理自动生成的 dev_estimated_at 应非空，实得 ${rowT5Before.dev_estimated_at}`);

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("改派")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 【F-2 新增·成对断言核心】现值非空且未过期——两情形均不命中 → ETA 字段组整体隐藏
            //   （与 T4 的"出现"一例成对，构成"显示/隐藏两个方向都有用例"）；理由块容器仍在 DOM（无条件
            //   渲染）但因 etaEl 缺席、siWireEtaOverrunReasonBlock 早退，保持默认 display:none。
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 0, 't5-eta-field-hidden', 'F-2：既有 ETA 非空且未过期（常态）→ 改派弹窗 ETA 字段组整体隐藏');
            const t5ReasonBlockVisible = await page.locator('#si-eta-reason-reassign').isVisible().catch(() => false);
            await shotOnFail(page, t5ReasonBlockVisible === false, 't5-reason-block-hidden', 'F-2 联动：ETA 字段缺席时超容差理由块保持隐藏（无法展开）');

            // 勾选一名额外开发成员（示例开发B id9）+ 填调整原因，不碰 ETA（无输入框可碰）→ 应正常提交成功
            const mbody5 = page.locator('#siMBody');
            await mbody5.locator('.si-member-chk[value="9"]').check();
            await page.fill('#f_reason', 'ETA 前端探针-常态仅改成员');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const modalClosedT5 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedT5 === 0, 't5-submit-success', 'ETA 字段隐藏时仅改成员 → 改派成功，弹窗关闭');
            const rowT5Ok = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT5Ok.dev_estimated_at === rowT5Before.dev_estimated_at, 't5-eta-unchanged-on-success', `ETA 仍原样保留（字段隐藏未提交该键，实得=${rowT5Ok.dev_estimated_at}）`);
            const rosterT5Ok = await dbAll('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
            await shotOnFail(page, rosterT5Ok.length === 2, 't5-roster-updated', `roster 差量已生效（实得 ${rosterT5Ok.length} 人）`);

            const t5UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
            await shotOnFail(page, t5UnexpectedErrors.length === 0, 't5-console-clean', `T5 全程无非预期 JS 报错（实得 ${t5UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T6【F-2 新增】指派弹窗常态流——受理自动生成的 ETA 非空且未过期，指派时两情形均不命中
        //   （与 T1 的受理必填、T4 的改派必填互为"三弹窗各测到至少一次"的补充覆盖；siModalAssign 与
        //   siModalReassign 共用同一份 siAssignReassignEtaVisibility/siEtaFieldGroupHtml，T4 已验证
        //   该函数本身在"必填"方向正确，本组专测 siModalAssign 自己的渲染分支在"隐藏"方向同样正确
        //   ——不能只信任"函数对、调用点应该也对"这层假设）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T6：指派弹窗常态流（受理自动生成 ETA 非空且未过期 → 字段隐藏，仅选成员仍可提交）──');
            const id = await mkBugViaApi(adminTok, fmt(new Date()));   // created_at=当前时刻 → SLA 未超
            createdIds.push(id);
            let r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: '{}' });
            if (r.status !== 200) throw new Error(`T6 前置：受理未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            const rowT6Before = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            if (!rowT6Before.dev_estimated_at) throw new Error(`T6 前置失败：受理自动生成的 dev_estimated_at 应非空，实得 ${rowT6Before.dev_estimated_at}`);

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("指派")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 0, 't6-eta-field-hidden', 'F-2：受理自动生成的 ETA 非空且未过期（常态）→ 指派弹窗 ETA 字段组整体隐藏');

            const mbody6 = page.locator('#siMBody');
            await mbody6.locator('.si-collab-chk[value="8"]').check();   // 示例开发A
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const modalClosedT6 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedT6 === 0, 't6-submit-success', 'ETA 字段隐藏时仅选成员 → 指派成功，弹窗关闭');
            const rowT6Ok = await dbGet('SELECT dev_estimated_at, assigned_to FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT6Ok.dev_estimated_at === rowT6Before.dev_estimated_at, 't6-eta-unchanged-on-success', `ETA 仍原样保留（字段隐藏未提交该键，实得=${rowT6Ok.dev_estimated_at}）`);
            await shotOnFail(page, Number(rowT6Ok.assigned_to) === 8, 't6-assignee-set', `指派已生效（实得 assigned_to=${rowT6Ok.assigned_to}）`);

            const t6UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
            await shotOnFail(page, t6UnexpectedErrors.length === 0, 't6-console-clean', `T6 全程无非预期 JS 报错（实得 ${t6UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T7【codex 368 号 MED-1 收口】指派弹窗反向兜底——前端本地时钟偏快误判"应展示必填 ETA"，
        //   服务端按真实时钟判定其实未过期 → 409 ETA_NOT_EXPIRED → 字段应被自动收起，用户直接重提即可。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T7：指派弹窗反向兜底（前端误判展示 + 服务端判未过期 → 字段收起，重提成功）──');
            const id = await mkBugViaApi(adminTok, fmt(new Date()));   // created_at=当前时刻 → SLA 未超
            createdIds.push(id);
            let r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: '{}' });
            if (r.status !== 200) throw new Error(`T7 前置：受理未 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
            const rowT7Before = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            if (!rowT7Before.dev_estimated_at) throw new Error(`T7 前置失败：受理自动生成的 dev_estimated_at 应非空，实得 ${rowT7Before.dev_estimated_at}`);

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            await page.click('#siDActions button:has-text("指派")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 真实场景：既有 ETA 非空且未过期 → siAssignReassignEtaVisibility 判"隐藏"，字段本不该出现
            //   （与 T6 前置断言同款，先确认起点确实是"隐藏"，本组的"出现"是接下来显式造出来的）。
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 0, 't7-eta-field-hidden-before-force', 'T7 前置：未强制渲染时字段确实不存在（与 T6 同前提，证明"出现"不是环境本来如此）');

            // 勾选一名开发成员（供两次提交复用，checkbox 状态在字段被替换/收起期间不受影响）。
            const mbody7 = page.locator('#siMBody');
            await mbody7.locator('.si-collab-chk[value="8"]').check();   // 示例开发A

            // 【codex 368 号 MED-1】模拟客户端时钟偏快：直调与 F-2 要点③同一份揭示函数强制渲染 ETA
            //   字段（与"服务端要求必填"触发路径复用同一段 DOM 操作，仅触发原因不同——真实场景里这段
            //   DOM 是前端本地时钟误判"已超时"触发的，此处用同一函数直接造出等价结果，不依赖真的把
            //   系统时钟调快）。
            await page.evaluate(({ boxId, reasonId }) => {
                window.siRevealEtaFieldOnFallback(boxId, reasonId, 'bug', null);
            }, { boxId: 'si-eta-box-assign', reasonId: 'si-eta-reason-assign' });
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 1, 't7-eta-field-force-shown', '强制渲染后 #f_dev_estimated_at 确实出现（模拟前端误判）');

            // 填一个未来值提交——服务端按真实时钟判定既有 ETA 其实未过期，应 409 ETA_NOT_EXPIRED。
            const futureVal7 = fmtDatetimeLocalInput(addDays(new Date(), 6));
            await page.locator('#f_dev_estimated_at').fill(futureVal7);
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);

            const modalStillOpenT7 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalStillOpenT7 === 1, 't7-modal-stays-open', '409 被拒后弹窗仍打开（可直接重提，不逼用户关窗重开）');
            const rowT7Denied = await dbGet('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT7Denied.dev_estimated_at === rowT7Before.dev_estimated_at, 't7-zero-side-effect', `零副作用：ETA 未被那次被拒的填值污染（实得=${rowT7Denied.dev_estimated_at}）`);

            // 【核心断言】ETA 字段组应已被收起（元素移出 DOM），容器内换成收起提示文案；理由块同步收起。
            await shotOnFail(page, (await page.locator('#f_dev_estimated_at').count()) === 0, 't7-eta-field-collapsed', 'F-2 反向兜底：409 ETA_NOT_EXPIRED 后字段组已被收起（元素移出 DOM）');
            const t7BoxText = await page.locator('#si-eta-box-assign').textContent();
            await shotOnFail(page, /服务端判定当前预计完成时间未过期、无需填写/.test(t7BoxText) && /请直接重新提交/.test(t7BoxText), 't7-collapse-hint-text', `F-2 反向兜底：容器内出现收起提示文案（实得="${t7BoxText}"）`);
            const t7ReasonBlockVisible = await page.locator('#si-eta-reason-assign').isVisible().catch(() => false);
            await shotOnFail(page, t7ReasonBlockVisible === false, 't7-reason-block-collapsed', 'F-2 反向兜底：超容差理由块同步收起（display:none）');

            // 不改任何输入，直接再次点击提交——字段已不存在，body 不再携带 dev_estimated_at，服务端按
            // "未提供"分支放行，指派应正常成功。
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const modalClosedT7 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedT7 === 0, 't7-resubmit-success', '收起后直接重提 → 指派成功，弹窗关闭（用户无需任何额外操作）');
            const rowT7Ok = await dbGet('SELECT dev_estimated_at, assigned_to FROM sys_issues WHERE id=?', [id]);
            await shotOnFail(page, rowT7Ok.dev_estimated_at === rowT7Before.dev_estimated_at, 't7-eta-unchanged-final', `ETA 全程原样保留（实得=${rowT7Ok.dev_estimated_at}）`);
            await shotOnFail(page, Number(rowT7Ok.assigned_to) === 8, 't7-assignee-set', `指派已生效（实得 assigned_to=${rowT7Ok.assigned_to}）`);

            const t7UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
            await shotOnFail(page, t7UnexpectedErrors.length === 0, 't7-console-clean', `T7 全程无非预期 JS 报错（实得 ${t7UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）`);
            await page.close();
        }

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

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
