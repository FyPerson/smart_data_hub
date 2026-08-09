/**
 * test-notify-unify-acceptance-playwright.js — 通知统一 N5-5c 最小验收矩阵（方案 §7）
 *
 * 矩阵三轴：**动作态**（已发送/失败带原因/无手机号/不可发/发送中/未通知）×**查已读六态**
 *   ×**两视口**（1440 / 1024）；断言面＝**文案 + 槽类**（u-nt-* 真生效），并把每格截图入视觉基线。
 *
 * ══════ ⚠️ 钉钉安全边界（沿用本仓既定惯例·开工前已实测复核）══════
 *   本地 task_pool.db 装的是**真实生产钉钉凭证**（app_key/secret/robot_code 三项均已设置），
 *   而 `sys_notify_dry_run` 开关**只覆盖 2 个端点**（routes/sys-iteration/index.js:11137 执行人行级通知、
 *   :13704 notify-liaison-test），全仓仅此两处检查点；其余约 27 个通道**点了就真发**，且开关值非法时
 *   fail-open 按真发。故本套件采用**零真实外呼**的两条既定解法，全程不点任何非 dry-run 覆盖的发送按钮：
 *     ① **SQL 直接造态**——状态句/槽类矩阵全部靠直写库列渲染，不经任何发送链路（同
 *        test-sys-intake-liaison T4/T6 手法）；
 *     ② **Playwright route 拦截**——需要走点击链路的（查已读六态/批量五态/发送中态）一律在浏览器
 *        网络层接管请求，真实后端与钉钉**完全不触达**（同 test-sys-liaison-test-frontend LT-T8a 手法）。
 *   造数收件人一律指向夹具自身写入的假名，不指向真实员工手机号。
 *
 * 用法：本地 server（3000）已启动后 → node scripts/test-notify-unify-acceptance-playwright.js
 *   截图落 scripts/__screenshots__/notify-unify/（首次运行即基线；已存在则另存 .actual.png 供人工比对）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SHOT_DIR = path.join(__dirname, '__screenshots__', 'notify-unify');

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

let pass = 0, fail = 0;
const skips = [];
const shots = [];
function must(c, m, extra) { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m + (extra ? ' → ' + extra : '')); } return !!c; }
function skipped(code, label, reason) { skips.push({ code, label, reason }); console.log(`  ⏭️  [SKIP:${code}] ${label} — ${reason}`); }

const RUN_TAG = Date.now();
const created = { sys: [], collab: [] };

// 视觉基线：首次跑生成 .png 基线；已有基线则另存 .actual.png，不覆盖（人工比对后再决定是否更新）
async function shot(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const base = path.join(SHOT_DIR, name + '.png');
    const isNew = !fs.existsSync(base);
    const target = isNew ? base : path.join(SHOT_DIR, name + '.actual.png');
    await page.screenshot({ path: target, fullPage: false });
    shots.push({ name, file: path.basename(target), status: isNew ? '新建基线' : '已有基线·另存 actual 待比对' });
}

async function newPage(browser, token, url, viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
    await page.evaluate((t) => localStorage.setItem('token', t), token);
    await page.goto(url, { waitUntil: 'load' });
    page._errs = errs;
    return { ctx, page };
}

// ── 夹具：SI bug 单（bug 流才同时有 dev/relay/creator/requester 四通道通知区）──
async function seedSysBug(title, devId, devName, patch = {}) {
    const cols = Object.keys(patch);
    const ins = await run(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name,
            assigned_to, assigned_to_name, assigned_at, intake_required, oa_number, intake_liaison_id
            ${cols.length ? ',' + cols.join(',') : ''})
         VALUES ('bug', '处理中', ?, 'BMS', '内部', 1, '管理员', ?, ?, datetime('now','localtime'), 1, '2026080077', 13
            ${cols.length ? ',' + cols.map(() => '?').join(',') : ''})`,
        [title, devId, devName, ...cols.map((c) => patch[c])]
    );
    const id = ins.lastID;
    created.sys.push(id);
    await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
               VALUES (?, ?, ?, 1, 'code_submitted')`, [id, devId, devName]);
    return id;
}
async function setDevNotify(issueId, patch) {
    const cols = Object.keys(patch);
    await run(`UPDATE sys_issue_dev_assignees SET ${cols.map((c) => c + '=?').join(',')} WHERE issue_id=?`,
        [...cols.map((c) => patch[c]), issueId]);
}

// 打开 SI 抽屉并抓通知区某一行的文本 + 槽类
async function siRow(page, issueId, labelKeyword) {
    await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), issueId);
    await page.waitForTimeout(700);
    return page.evaluate((kw) => {
        const row = [...document.querySelectorAll('#siDBody .u-notify-row')].find((r) => r.textContent.includes(kw));
        if (!row) return null;
        const slotEl = row.querySelector('[class*="u-nt-"]');
        return {
            text: row.textContent.replace(/\s+/g, ' ').trim(),
            slot: slotEl ? [...slotEl.classList].find((c) => c.startsWith('u-nt-')) : null,
            // 槽类**真生效**校验：读 computed color，防"类名挂上但被页内规则压死"（D-2 那种死类）
            color: slotEl ? getComputedStyle(slotEl).color : null,
            btns: [...row.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), d: b.disabled })),
        };
    }, labelKeyword);
}

(async () => {
    let browser;
    try {
        console.log('\n══════ 通知统一 N5-5c 最小验收矩阵（文案 × 槽类 × 六态 × 两视口）══════');
        console.log('  安全模式：零真实外呼（SQL 造态 + route 拦截·不点任何非 dry-run 覆盖的发送按钮）\n');

        const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1`);
        const dev = await get(`SELECT id, username, display_name, role FROM users WHERE role='user' AND status='active' ORDER BY id LIMIT 1`);
        if (!admin || !dev) throw new Error('库中缺 active admin/user，无法造 token');
        const adminTok = jwt.sign({ id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });

        browser = await chromium.launch();

        // ══════ A 组 · 动作态 × 状态句 × 槽类（SQL 造态·零点击）══════
        console.log('── A 组：SI 动作态矩阵（状态句 + 槽类 + computed 真生效）──');
        const A_CASES = [
            { key: 'sent', patch: { notify_status: 'sent', notified_at: '2026-08-09 10:00:00' }, wantText: '✅ 已于', wantSlot: 'u-nt-ok', why: '已发送状态句（语序统一 DC 版）' },
            { key: 'read', patch: { notify_status: 'sent', notified_at: '2026-08-09 10:00:00', read_at: '2026-08-09 11:00:00' }, wantText: '📖 已读 · 通知于', wantSlot: 'u-nt-ok', why: '已读双时刻（dev 通道双列齐全）' },
            { key: 'failed_reason', patch: { notify_status: 'failed', notify_error: 'no_phone' }, wantText: '⚠️ 通知失败（收件人未填手机号），可重试', wantSlot: 'u-nt-fail', why: 'S2/J8 失败句带中文原因（映射表）' },
            { key: 'failed_unreg', patch: { notify_status: 'failed', notify_error: '未登记码xyz' }, wantText: '⚠️ 通知失败（未知原因），可重试', wantSlot: 'u-nt-fail', why: '未登记码落「未知原因」，绝不外显后端码' },
            { key: 'failed_noerr', patch: { notify_status: 'failed', notify_error: null }, wantText: '⚠️ 通知失败，可重试', wantSlot: 'u-nt-fail', why: 'error 为空退无原因版，不出空括号' },
            // ⚠️ 'sending' **不放在 dev 通道**：子表 sys_issue_dev_assignees 的 CHECK 只允许
            //   not_sent/sent/failed（实测 SQLITE_CONSTRAINT），该态全站只有 liaison_test 通道会产生
            //   （见 Sys_Iteration.html siNotifyStatusText 的 'sending' 分支注释）⇒ 移到下方 A2 组按真实通道验。
            { key: 'not_sent', patch: { notify_status: 'not_sent' }, wantText: '— 未发送钉钉通知', wantSlot: 'u-nt-muted', why: '未发送态' },
        ];
        const idA = await seedSysBug(`5c-动作态矩阵-${RUN_TAG}`, dev.id, dev.display_name);
        const { ctx: ctxA, page: pA } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1440, height: 900 });
        for (const c of A_CASES) {
            await setDevNotify(idA, Object.assign({ notify_status: null, notified_at: null, read_at: null, notify_error: null }, c.patch));
            const r = await siRow(pA, idA, '开发 ');
            if (!must(!!r, `A/${c.key} 通知行渲染出来了（${c.why}）`)) continue;
            must(r.text.includes(c.wantText), `A/${c.key} 文案命中「${c.wantText}」`, `实得："${r.text.slice(0, 90)}"`);
            must(r.slot === c.wantSlot, `A/${c.key} 槽类=${c.wantSlot}`, `实得 ${r.slot}`);
            // 槽类真生效：computed color 必须**不是**默认继承色（防死类回潮）
            must(!!r.color && r.color !== 'rgb(0, 0, 0)', `A/${c.key} 槽类 computed 生效（color=${r.color}）`);
            await shot(pA, `A-${c.key}-1440`);
        }
        // ── A2 组：liaison_test 通道（全站唯一有 'sending' 态 + J20 dry-run 后缀 + J17 永不出已读句）──
        console.log('\n── A2 组：liaison_test 通道（sending 态 / J20 后缀 / J17 结构性闭口）──');
        const insLT = await run(
            `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name,
                assigned_to, assigned_to_name, assigned_at, intake_required, oa_number, intake_liaison_id,
                liaison_test_cycle_no, liaison_test_notify_cycle_no, liaison_test_recipient_id, liaison_test_recipient_name,
                liaison_test_notify_status)
             VALUES ('feature','待对接测试',?,'BMS','内部',1,'管理员',?,?,datetime('now','localtime'),1,'2026080078',13,
                     1,1,13,'示例对接人','sending')`,
            [`5c-liaison态-${RUN_TAG}`, dev.id, dev.display_name]);
        const idLT = insLT.lastID; created.sys.push(idLT);
        const { ctx: ctxA2, page: pA2 } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1440, height: 900 });
        {
            const r = await siRow(pA2, idLT, '对接测试');
            if (must(!!r, 'A2 liaison_test 行渲染')) {
                must(r.text.includes('⏳ 发送中…'), 'A2/sending 状态句「⏳ 发送中…」（全站唯一产出该态的通道）', `实得："${r.text.slice(0, 70)}"`);
                must(r.slot === 'u-nt-run', 'A2/sending 槽类=u-nt-run', `实得 ${r.slot}`);
                must(!!r.color && r.color !== 'rgb(0, 0, 0)', `A2/sending 槽类 computed 生效（color=${r.color}）`);
            }
            await shot(pA2, 'A2-liaison-sending-1440');
            // J20/D-1：dry-run 后缀统一 +（J17）该通道永不出已读句
            await run(`UPDATE sys_issues SET liaison_test_notify_status='sent', liaison_test_notified_at='2026-08-09 10:00:00',
                       liaison_test_notify_message_key='dryrun-5c', liaison_test_read_at='2026-08-09 11:00:00' WHERE id=?`, [idLT]);
            const r2 = await siRow(pA2, idLT, '对接测试');
            if (must(!!r2, 'A2 dry-run 态行渲染')) {
                must(r2.text.includes('（演练·未真实发送）'), 'A2/J20 行标签 dry-run 后缀统一为「（演练·未真实发送）」', `实得："${r2.text.slice(0, 70)}"`);
                must(!r2.text.includes('📖 已读'), '★A2/J17 该通道**永不出已读句**——即便库里被写了 liaison_test_read_at（本用例故意写了脏值），行内也不得出现「📖 已读」', `实得："${r2.text.slice(0, 80)}"`);
                must(r2.text.includes('✅ 已于'), 'A2/J17 仍正常出已发送句（闭口的是已读句，不是整行）');
            }
            await shot(pA2, 'A2-liaison-dryrun-1440');
        }
        await ctxA2.close();
        await ctxA.close();

        // ══════ B 组 · 查已读六态（route 拦截·零外呼）══════
        console.log('\n── B 组：SI 查已读六态（route 拦截接管·真实端点与钉钉零触达）──');
        await setDevNotify(idA, { notify_status: 'sent', notified_at: '2026-08-09 10:00:00', read_at: null, notify_error: null, notify_message_key: 'dryrun-5c-fake' });
        const B_CASES = [
            { key: 'unread', body: { read: false, read_status: 'unread' }, want: '⏳ 尚未读取', slot: 'u-nt-warn' },
            { key: 'unresolved', body: { read: false, read_status: 'recipient_unresolved' }, want: '⚠️ 收件人未解析，无法查询已读', slot: 'u-nt-warn' },
            // 〔read 态特殊〕它是**唯一会触发固化刷新**的分支。mock 下后端并没真落 read_at，
            //   刷新后该行仍渲染查已读按钮 ⇒ 结果框被重渲染成空（这正是"刷新真的发生了"的证据）。
            //   故本格不断言结果框留字，改断言**铁律本身**：refreshes===1（详见下方 refreshes 计数）。
            { key: 'read', body: { read: true, read_at: '2026-08-09 12:00:00' }, want: null, slot: null, wantRefresh: 1 },
            { key: 'fail_502', status: 502, body: { reason: 'rate_limit' }, want: '⚠️ 查询失败（钉钉发送被限流）', slot: 'u-nt-fail' },
            { key: 'fail_500_raw', status: 500, body: { error: 'SQLITE_ERROR: no such column xyz' }, want: '⚠️ 查询失败（未知原因）', slot: 'u-nt-fail' },
            { key: 'snapshot_missing', status: 400, body: { code: 'HISTORICAL_SNAPSHOT_MISSING' }, want: '⚠️ 历史记录无快照，无法查询已读', slot: 'u-nt-warn' },
        ];
        const { ctx: ctxB, page: pB } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1440, height: 900 });
        // 〔D6 铁律计数器〕统计"查已读点击之后"发生的**详情 GET** 次数：
        //   siAfterAction → siRenderDrawer 会打一次 `GET /api/sys-issues/{id}`。
        //   只有已读态准刷新（后端固化了 read_at，刷新是把行内换成权威显示）；其余五态后端零状态变化，
        //   刷新纯负收益且会把刚写的结果框冲掉（Collab 那条 HIGH 的同构形态）。
        let detailGets = 0;
        pB.on('request', (r) => { if (new RegExp(`/api/sys-issues/${idA}(\\?|$)`).test(r.url())) detailGets++; });
        for (const c of B_CASES) {
            await pB.route('**/api/sys-issues/*/notify-read-status*', (route) =>
                route.fulfill({ status: c.status || 200, contentType: 'application/json', body: JSON.stringify(c.body) }));
            await pB.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
            await pB.waitForTimeout(600);
            detailGets = 0;   // 归零：只数"点击查已读之后"的刷新
            const clicked = await pB.evaluate(() => {
                const row = [...document.querySelectorAll('#siDBody .u-notify-row')].find((r) => r.textContent.includes('开发 '));
                const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.includes('查询已读'));
                if (b) { b.click(); return true; }
                return false;
            });
            if (!must(clicked, `B/${c.key} 找到并点击「查询已读」（route 已接管·不触达真实端点）`)) { await pB.unroute('**/api/sys-issues/*/notify-read-status*'); continue; }
            await pB.waitForTimeout(500);
            const box = await pB.evaluate(() => {
                const el = document.querySelector('[id^="siReadBox_"]');
                if (!el) return null;
                const s = el.querySelector('[class*="u-nt-"]');
                return { text: el.textContent.trim(), slot: s ? [...s.classList].find((c) => c.startsWith('u-nt-')) : null };
            });
            if (c.want !== null) {
                if (must(!!box, `B/${c.key} 行内结果框存在（D6：结果不再走 toast）`)) {
                    must(box.text.includes(c.want), `B/${c.key} 结果框文案命中「${c.want}」`, `实得："${box.text}"`);
                    must(box.slot === c.slot, `B/${c.key} 结果框槽类=${c.slot}`, `实得 ${box.slot}`);
                }
            }
            // ★D6 铁律：已读态 refreshes===1，其余五态必须 ===0
            const wantRefresh = c.wantRefresh || 0;
            must(detailGets === wantRefresh,
                `★B/${c.key} D6 铁律：查已读后详情刷新次数=${wantRefresh}` +
                (wantRefresh ? '（已读态才刷新——后端已固化 read_at，刷新是把行内换成权威显示）'
                             : '（后端零状态变化 ⇒ 刷新纯负收益，且会把刚写的结果框冲掉＝Collab 那条 HIGH 的同构形态）'),
                `实得 ${detailGets}`);
            await shot(pB, `B-read-${c.key}-1440`);
            await pB.unroute('**/api/sys-issues/*/notify-read-status*');
        }
        // 超窗态：SI 后端零产出（J7 显式闭口）——不实现即不应有该文案，反向断言
        must(!(await pB.content()).includes('已超过钉钉可查询时间'),
            'B/超窗态 J7 显式闭口：SI 不实现 unread_expired（页面无该文案＝没造死分支）');
        await ctxB.close();

        // ══════ C 组 · R1 批量五态（route 拦截）══════
        console.log('\n── C 组：R1 批量五态（notify-resume-dev·route 拦截）──');
        const idC = await seedSysBug(`5c-批量五态-${RUN_TAG}`, dev.id, dev.display_name);
        const C_CASES = [
            { key: 'all_ok', results: [{ ok: true }, { ok: true }], want: '2 人已发送', lvl: 'success' },
            { key: 'partial', results: [{ ok: true }, { ok: false }], want: '1 人成功，1 人失败（可重试）', lvl: 'warning' },
            { key: 'all_fail', results: [{ ok: false }, { ok: false }], want: '2 人均发送失败（可重试）', lvl: 'error' },
            { key: 'idempotent', results: [{ ok: false, skipped: true }], want: '无新增发送（可能已被其他请求认领）', lvl: 'info' },
        ];
        const { ctx: ctxC, page: pC } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1440, height: 900 });
        for (const c of C_CASES) {
            await pC.route('**/api/sys-issues/*/notify-resume-dev', (route) =>
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: c.results }) }));
            await pC.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idC);
            await pC.waitForTimeout(600);
            const ok = await pC.evaluate(() => {
                const row = [...document.querySelectorAll('#siDBody .u-notify-row')].find((r) => r.textContent.includes('重启通知开发'));
                const b = row && [...row.querySelectorAll('button')].find((x) => x.textContent.includes('发送通知'));
                if (b) { b.click(); return true; }
                return false;
            });
            if (!must(ok, `C/${c.key} 找到并点击重启批量「发送通知」（route 接管）`)) { await pC.unroute('**/api/sys-issues/*/notify-resume-dev'); continue; }
            await pC.waitForTimeout(500);
            const toast = await pC.evaluate(() => {
                const t = document.querySelector('#toast-container');
                return t ? t.textContent.trim() : '';
            });
            must(toast.includes(c.want), `C/${c.key} 聚合 toast 命中「${c.want}」（R1 五态·J10）`, `实得："${toast}"`);
            await shot(pC, `C-batch-${c.key}-1440`);
            await pC.unroute('**/api/sys-issues/*/notify-resume-dev');
            await pC.waitForTimeout(3200);   // 等 toast 自然消失，避免污染下一格
        }
        skipped('R1-空目标', 'C/empty 批量五态第 5 态「没有可通知的对象」',
            '前端不可达（roster 为空时整行不渲染·siRenderResumeNotifyRow 首行 return），矩阵 J10 已标 mock-only ⇒ 不造死分支用例');
        await ctxC.close();

        // ══════ D 组 · 发送中 disabled（route 延迟拦截）══════
        console.log('\n── D 组：S15 发送中 disabled（route 延迟·请求在途时取按钮态）──');
        const idD = await seedSysBug(`5c-发送中态-${RUN_TAG}`, dev.id, dev.display_name);
        const { ctx: ctxD, page: pD } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1440, height: 900 });
        await pD.route('**/api/sys-issues/*/notify-developer', async (route) => {
            await new Promise((r) => setTimeout(r, 1500));   // 拖住请求，制造"在途"窗口
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notify_status: 'sent' }) });
        });
        await pD.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idD);
        await pD.waitForTimeout(600);
        await pD.evaluate(() => {
            const row = [...document.querySelectorAll('#siDBody .u-notify-row')].find((r) => r.textContent.includes('开发 '));
            const b = row && [...row.querySelectorAll('button')].find((x) => /发送通知|重新通知/.test(x.textContent));
            if (b) b.click();
        });
        await pD.waitForTimeout(400);
        const inflight = await pD.evaluate(() => {
            const row = [...document.querySelectorAll('#siDBody .u-notify-row')].find((r) => r.textContent.includes('开发 '));
            const b = row && row.querySelector('button');
            return b ? { t: b.textContent.trim(), d: b.disabled } : null;
        });
        must(inflight && inflight.d === true && inflight.t === '发送中…',
            `D/发送中 请求在途时按钮 disabled 且文案「发送中…」（S15/J23）`, `实得 ${JSON.stringify(inflight)}`);
        await shot(pD, 'D-sending-1440');
        await pD.unroute('**/api/sys-issues/*/notify-developer');
        await ctxD.close();

        // ══════ E 组 · 窄视口（1024）复跑关键态 ══════
        console.log('\n── E 组：窄视口 1024 复跑（布局不塌 + 槽类不变）──');
        const { ctx: ctxE, page: pE } = await newPage(browser, adminTok, `${BASE_URL}/Sys_Iteration.html`, { width: 1024, height: 800 });
        for (const c of [A_CASES[2], A_CASES[0]]) {   // 失败带原因 + 已发送
            await setDevNotify(idA, Object.assign({ notify_status: null, notified_at: null, read_at: null, notify_error: null }, c.patch));
            const r = await siRow(pE, idA, '开发 ');
            if (!must(!!r, `E/${c.key}@1024 通知行渲染`)) continue;
            must(r.text.includes(c.wantText) && r.slot === c.wantSlot,
                `E/${c.key}@1024 文案与槽类与 1440 一致（响应式不改语义）`, `实得 slot=${r.slot} text="${r.text.slice(0, 60)}"`);
            await shot(pE, `E-${c.key}-1024`);
        }
        must((pE._errs || []).length === 0, `E 全程无 console error（实得 ${(pE._errs || []).length} 条）`,
            (pE._errs || []).slice(0, 2).join(' | '));
        await ctxE.close();

        // ══════ 亲验项（留 N6 观察指引·不在自动化范围）══════
        console.log('\n── 须用户亲验项（自动化断言覆盖不到·留 N6 观察指引）──');
        for (const [code, label, why] of [
            ['N6-1', 'Data_Collab toast 位置 top:20px 是否被页头遮挡', 'D7 迁移把页内版 top:80px 收敛到共享版 20px；遮挡与否是观感判断，像素断言易假绿'],
            ['N6-2', '窄视口多条 toast 堆叠观感', '共享版改堆叠（原页内版单例顶替），多条并存的可读性需人眼'],
            ['N6-3', 'S2 两处观感项（失败句原因括号长度 / 行内换行）', '文案长度因通道而异，断言只能锁文本不能锁观感'],
            ['N6-4', 'Issue_Lite ilFmtTime 时间显示观感', 'N2b 遗留观察项'],
            ['N6-5', '★N4-fix 11 处死类根治的视觉变化', 'Data_Collab `.notify-status-text` 去 color 后 u-nt-* 首次真生效：灰 #4b5563 → 各自语义色。**预期变化非回归**，基线需按新态重拍'],
        ]) skipped(code, label, why);

        console.log(`\n  合计 ${pass} PASS / ${fail} FAIL / ${skips.length} SKIP`);
        console.log(`  截图 ${shots.length} 张 → ${SHOT_DIR}`);
        shots.forEach((s) => console.log(`    · ${s.file}（${s.status}）`));
        if (skips.length) { console.log('  挂起/亲验项：'); skips.forEach((s) => console.log(`    · [${s.code}] ${s.label}`)); }
        console.log(fail === 0 ? '\n  🎉 5c 验收矩阵通过' : '\n  🚫 存在失败项');
    } catch (e) {
        console.error('\n  💥 套件异常：', e && e.message);
        fail++;
    } finally {
        if (browser) await browser.close();
        // 夹具清理（本套件只造 sys_issues，逐条删）
        for (const id of created.sys) {
            await run(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [id]).catch(() => {});
            await run(`DELETE FROM sys_issues WHERE id=?`, [id]).catch(() => {});
        }
        const left = await get(`SELECT COUNT(*) n FROM sys_issues WHERE title LIKE ?`, [`5c-%-${RUN_TAG}`]).catch(() => ({ n: -1 }));
        console.log(`  夹具清理：已删 ${created.sys.length} 单，残留校验 = ${left && left.n}（应为 0）`);
        db.close();
        process.exit(fail === 0 ? 0 : 1);
    }
})();
