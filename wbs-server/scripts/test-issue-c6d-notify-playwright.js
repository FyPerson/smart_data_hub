/**
 * v1.74.0 C7/c6d — 通知开发按钮「点击 → UI 反馈」端到端 Playwright 实测
 *
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-c6d-notify-playwright.js
 *
 * 背景（盘点 2026-06-01）：c6c 已验通知按钮**存在性**（C7/C8），但未验"点击后 UI 反馈"。
 *   唯一缺的端到端环 = 点通知开发按钮 → 真发/降级 → toast + 详情页通知徽章状态变化。本脚本补这一环。
 *
 * 测法（不骚扰真人钉钉）：
 *   D1 成功态：page.route 拦截 notify-developer 返 mock 成功 → 验 toast「通知已发送」（前端乐观反馈链路）
 *   D2 失败态：指派给**无 phone** 用户(id=8 示例开发A)，点击走**真 endpoint** → no_phone 在发送前短路
 *             → 落 notify_status='failed'+notify_error='no_phone'（零真发）→ loadIssues 重读 db
 *             → 详情页徽章真变「失败」+ hover title=no_phone（验真实 db→UI 渲染链路）
 *   D3 异步弹窗踩坑预防：notify-developer **不弹 confirm**（notifyAction 无 confirm），但仍挂 dialog
 *             自动 accept 兜底，且点击用 fire-and-forget 不死等（沿用 c6b reason modal 防 hang 范式）
 *   D4 控制台无 JS 报错
 *
 * ⚠️ 测试残留清理（踩坑预防）：finally 删测试单 + hang/中断后须清 issue 4 表残留再重启 server
 *   （否则下次启动撞 C1 硬门槛标 schema error → 全 endpoint 503）。
 */
'use strict';
const path = require('path');
const fs = require('fs');   // 〔P6-A〕D2b⁗ 源码级断言要读 server.js
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1, DEV_WITH_PHONE = 19, DEV_NO_PHONE = 8;

async function signAs(uid) {
    const u = await new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get('SELECT id,username,display_name,role FROM users WHERE id=?', [uid], (e, r) => { db.close(); e ? rej(e) : res(r); }); });
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}
function dbGet(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }
async function apiCreate(token, body) { const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).id; }
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
async function apiAssign(token, id, devId) { await fetch(`${BASE_URL}/api/issues/${id}/assign`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: devId }) }); }
async function apiStatus(token, id, status, reason) { const b = { status }; if (reason) b.last_transition_reason = reason; await fetch(`${BASE_URL}/api/issues/${id}/status`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }
// 〔N5-5b〕挂起断言通道——沿用本仓既有惯例（test-badge-computed-playwright.js:366 `skipped()` 同形态：
//   带 code、单列收集、**不计入 PASS/FAIL**）。只用于"实现侧有已登记待裁定项、断言现在既不该绿也不该红"
//   的场景：假绿会把缺陷盖掉，带病红会让套件长期红成噪音、真红灯反而没人看。
const skips = [];
function skipped(code, label, reason) { skips.push({ code, label, reason }); console.log(`  ⏭️  [SKIP:${code}] ${label} — ${reason}`); }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => {
        if (m.type() !== 'error') return;
        // D2 故意触发 no_phone → 502，浏览器把 502 资源加载计为 console error；这是预期业务失败非 JS bug，过滤掉。
        // 只保留真正的 JS 运行时报错（非"Failed to load resource"的 HTTP 状态噪声）。
        // 〔34 号 MED 收窄·2026-08-09〕**不再在采集期做任何丢弃**。原实现在这里无条件扔掉一切
        //   `Failed to load resource … 50[02]`——不看是哪个 URL、也不看有几条，等于给"任何 500/502
        //   资源报错"开了一张全局免罪符（D2 的 502 就是这么一直没露过面的）。
        //   改为**原样采集 + 带上 URL**，把"哪些算预期噪声"的判断挪到 D4 断言处按**路径**精确收窄，
        //   并对预期条数做**等值断言**（见文件末 D4）。text 与 url 用 ` @@ ` 拼接，既保留原有打印形态，
        //   也让断言侧能按路径过滤。
        const loc = (m.location && m.location()) || {};
        errs.push(m.text() + ' @@ ' + (loc.url || '(no-url)'));
    });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    // D3 踩坑预防：任何弹 dialog（confirm/alert）自动 accept，避免 evaluate 死等
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    page._errs = errs;
    return page;
}

const created = [];
async function main() {
    const adminToken = await signAs(ADMIN_ID);
    console.log('\n══════ v1.74.0 c6d 通知按钮「点击→UI 反馈」实测 ══════');

    // 造数：① 指派有 phone 开发 + 处理中（D1 mock 成功用）② 指派无 phone 开发 + 处理中（D2 no_phone 真路径用）
    const idOk = await apiCreate(adminToken, { title: 'c6d通知成功测试', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idOk);
    await apiAssign(adminToken, idOk, DEV_WITH_PHONE);
    await apiStatus(adminToken, idOk, '处理中');

    const idNoPhone = await apiCreate(adminToken, { title: 'c6d通知失败测试', type: '数据质量', requester_dept: '市场营销部', requester_name: '李', description: 'x' });
    created.push(idNoPhone);
    await apiAssign(adminToken, idNoPhone, DEV_NO_PHONE);
    await apiStatus(adminToken, idNoPhone, '处理中');

    const browser = await chromium.launch();
    let allErrs = [];
    try {
        // ===== D1 成功态：page.route mock notify-developer 成功 → toast「通知已发送」=====
        const p1 = await gotoAs(browser, adminToken);
        // 拦截 notify-developer：返 mock 成功（不真打 endpoint、不真发钉钉）
        await p1.route('**/api/issues/*/notify-developer', route =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message_key: 'mock_pqk' }) })
        );
        await p1.evaluate(id => openDrawer(id), idOk);
        await p1.waitForTimeout(600);
        // 详情页应有"通知开发"按钮（前置校验）
        const hasNotifyBtn = await p1.evaluate(() => document.getElementById('drawerBody').innerText.includes('通知开发'));
        must(hasNotifyBtn, 'D1a 详情页含「通知开发」按钮（前置）');
        // fire-and-forget 点击（D3：不 await 会潜在弹窗的链路；notifyAction 内部 async）
        await p1.evaluate(id => { notifyAction(id, 'notify-developer'); }, idOk);
        // 等 toast 出现（成功 toast 文案「通知已发送」）
        const toastOk = await p1.waitForFunction(() => {
            const t = document.body.innerText;
            return t.includes('通知已发送');
        }, { timeout: 5000 }).then(() => true).catch(() => false);
        must(toastOk, 'D1b 点击通知开发 → toast「通知已发送」（乐观反馈链路）');
        allErrs = allErrs.concat(p1._errs);
        await p1.close();

        // ===== D2 失败态：no_phone 真路径 → 徽章真变「失败」+ hover no_phone =====
        const p2 = await gotoAs(browser, adminToken);
        await p2.evaluate(id => openDrawer(id), idNoPhone);
        await p2.waitForTimeout(500);
        // 点击通知开发（真打 endpoint → dev id=8 无 phone → 短路落 failed，零真发钉钉）
        // 用 waitForResponse 锚定 notify-developer 请求真完成（不靠 fire-and-forget 时序猜，避免读 db 太早）
        const [notifyResp] = await Promise.all([
            p2.waitForResponse(r => /\/api\/issues\/\d+\/notify-developer/.test(r.url()), { timeout: 8000 }).catch(() => null),
            p2.evaluate(id => { notifyAction(id, 'notify-developer'); }, idNoPhone),
        ]);
        must(notifyResp && notifyResp.status() === 502, `D2a notify-developer 真打后端返 502（实际 ${notifyResp && notifyResp.status()}）`);
        // 〔断言同步·通知统一 J8·2026-08-09〕原断言等的是**后端 message 原文**（"未绑定手机号/无法推送"，
        //   前端当时是 `showToast(body.error)` 直出）。通知统一把五页失败文案统一收编到**冻结映射表**
        //   （J8：未知码固定「未知原因」、不透传后端原文）⇒ IT 这条 toast 现在出的是表里的
        //   `no_phone → 业务方未填手机号`。属**断言该改**：变的是"从哪拿文案"，不是"有没有反馈"。
        //   仍断言 toast 真的出现（失败不静默红线），只是把期望文案换成冻结表的值。
        const toastFail = await p2.waitForFunction(() => /通知失败（/.test(document.body.innerText), { timeout: 5000 }).then(() => true).catch(() => false);
        const toastText = await p2.evaluate(() => {
            const m = document.body.innerText.match(/通知失败（[^）]*）/);
            return m ? m[0] : '(未捕获到 toast)';
        });
        // 〔断言同步·J8〕**当前可得的准确面**照常硬断言：失败必须有可见反馈（"失败绝不静默"红线），
        //   且文案已不再透传后端原文（收编到冻结映射表）。这两点现在就成立，不打折。
        must(toastFail, `D2b 失败后必有可见 toast 反馈（失败不静默红线·实得："${toastText}"）`);
        must(/^通知失败（/.test(toastText) && !/未绑定手机号，无法推送钉钉/.test(toastText),
            `D2b' toast 走冻结映射表模板「通知失败（{原因}）」，不再透传后端原文句（J8·实得："${toastText}"）`);
        // 〔P6-A 收口·2026-08-09 用户裁定选项 A〕原本这一格是 [SKIP:P6]（归因错但修法越界）。
        //   后端已按 A 把 reason 放进 body（server.js sendIssueDingtalkRaw 四分支），itErrText 第 2 级
        //   即可命中 ⇒ **挂起转硬断言**：no_phone 必须译成「收件人未填手机号」，不再是笼统的「钉钉服务异常」。
        must(/收件人未填手机号/.test(toastText),
            `★D2b″〔P6-A〕no_phone 归因准确：toast 应为「通知失败（收件人未填手机号）」（实得："${toastText}"）`);
        must(!/钉钉服务异常/.test(toastText),
            `★D2b‴〔P6-A 对照面〕**绝不再落 HTTP 502 档的「钉钉服务异常」**——那是修前的错误归因（把"这个人没填手机号"说成"钉钉坏了"）`);
        // 同形态另 3 条（:11952 cls.hint / :11962 钉钉用户查询失败 / :11974 重试取 token 失败）同批已改，
        //   但它们要造态得让**真实钉钉外呼失败**（拿不到 token / 反查不到 userId），本地无法在零外呼前提下
        //   构造 ⇒ 不在本套件补用例，改由**源码级断言**锁住"四分支都把 reason 放进了 body"（见下）。
        {
            const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
            const fnStart = srv.indexOf('async function sendIssueDingtalkRaw');
            const fnBody = fnStart >= 0 ? srv.slice(fnStart, srv.indexOf('\n}', fnStart)) : '';
            const failReturns = (fnBody.match(/return \{ ok: false[^\n]*/g) || []);
            //   ⚠️ 判据不能写成 `/body: \{[^}]*\breason:/`——no_phone 那条的 error 是模板串，里面的
            //   `${targetUser.display_name || 'user#' + targetUser.id}` **自带一个 `}`**，`[^}]*` 到那儿就断了，
            //   于是把已经带 reason 的行误判成没带（初版就这么错过一次）。改成"取 `body: {` 之后的整段再找 reason"。
            const noReason = failReturns.filter((l) => {
                const i = l.indexOf('body: {');
                return i < 0 || !/\breason:/.test(l.slice(i));
            });
            must(fnBody.length > 0 && failReturns.length === 7 && noReason.length === 1,
                `★D2b⁗〔P6-A 源码级〕sendIssueDingtalkRaw 的失败返回**全部把 reason 放进 body**` +
                `（实测 ${failReturns.length} 条失败返回，仅 ${noReason.length} 条未带＝no_config，它的 error 是已登记字面量、走第 3 级即可）`,
                noReason.length > 1 ? '未带 reason 的：' + noReason.map((s) => s.trim().slice(0, 60)).join(' | ') : '');
        }
        // 验后端真落库 failed + no_phone
        const row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [idNoPhone]);
        must(row.notify_status === 'failed' && row.notify_error === 'no_phone', `D2c 后端真落 failed+no_phone（实际 ${row.notify_status}/${row.notify_error}）`);
        // notifyAction 失败分支不 reload+reopen，故手动重开详情验徽章读 db 渲染
        await p2.evaluate(() => loadIssues());
        await p2.waitForTimeout(400);
        await p2.evaluate(id => openDrawer(id), idNoPhone);
        await p2.waitForTimeout(500);
        // 〔状态徽章统一 S5a-fix MED-9〕两处选择器/正则随通知徽章改名同步：
        //   `.notify-badge` → `.u-notify-badge`（前端统一 C 轮 base 加 u- 前缀，本断言当时漏改，
        //   一直选不到元素、badge 恒为 null——测试是"红着的"还是"绿着的"取决于 must 的写法，
        //   这类断言必须跟着渲染改动一起改，否则它保护的东西早就没了）；
        //   `notify-failed` → `n-failed`（S5a 口径二前缀统一）。
        const badge = await p2.evaluate(() => {
            const b = document.querySelector('#drawerBody .u-notify-badge');
            return b ? { cls: b.className, text: b.textContent.trim(), title: b.getAttribute('title') } : null;
        });
        must(badge && /(?<![\w-])n-failed(?![\w-])/.test(badge.cls) && badge.text === '失败', `D2d 详情页通知徽章真变「失败」（实际 ${JSON.stringify(badge)}）`);
        // 〔S5a-fix2 L〕补三态渲染断言 + class token 集精确断言。
        //   原来只验 failed 一态，而 S5a 把 class 前缀与色值全换了一遍——
        //   sent / not_sent 两态换错了名字或漏了规则，这个套件一样是绿的。
        //   token 集精确断言（恰好 base + 一个修饰类）另防"旧类名与新类名同时挂上"这种半迁移状态。
        // 〔S5a-fix3 项 4〕三态走**真实渲染路径**：调生产用的 notifyBadge() 产出 HTML、
        //   插进真 DOM、再从 DOM 读回 class token 集与可见文案。
        //   上一版是直接拼 `'u-notify-badge ' + itNotifyClass(st)`——那验的是 gate，
        //   验不到 notifyBadge 自己拼 class 时有没有漏 base、有没有多挂一个类、文案对不对。
        const notifyRendered = await p2.evaluate(() => {
            const out = {};
            const host = document.createElement('div');
            host.id = '__notifyProbeHost';
            document.body.appendChild(host);
            for (const st of ['sent', 'not_sent', 'failed']) {
                // 〔断言同步·Q13/0b-9①〕探针值分两种：**已登记 reason** 验"译成中文"，
                //   **未登记值** 验"落未知原因、绝不原样外显"（Q13 收编后 title 不再是 raw notify_error）。
                host.innerHTML = notifyBadge({ notify_status: st, notify_error: st === 'failed' ? 'no_phone' : null });
                const el = host.querySelector('.u-notify-badge');
                out[st] = el
                    ? { tokens: [...el.classList].sort().join(' '), text: el.textContent.trim(), title: el.getAttribute('title') }
                    : null;
            }
            // 未登记态保留 gate 单测（notifyBadge 的 label 三元只认三态，走不到"未知 label"）
            out.__gateUnknown = typeof itNotifyClass === 'function' ? itNotifyClass('__nope__') : 'NO_GATE';
            // 〔Q13 对照组〕未登记的 notify_error 必须落「未知原因」——防"把后端码原样当 title"回潮
            host.innerHTML = notifyBadge({ notify_status: 'failed', notify_error: 'probe-err-未登记' });
            const elU = host.querySelector('.u-notify-badge');
            out.__unregisteredTitle = elU ? elU.getAttribute('title') : null;
            host.remove();
            return out;
        });
        must(notifyRendered.sent && notifyRendered.sent.tokens === 'n-sent u-notify-badge' && notifyRendered.sent.text === '已通知',
            `D2f sent 态真实渲染：token 集 [n-sent u-notify-badge] + 文案「已通知」（实际 ${JSON.stringify(notifyRendered.sent)}）`);
        must(notifyRendered.not_sent && notifyRendered.not_sent.tokens === 'n-not_sent u-notify-badge' && notifyRendered.not_sent.text === '未通知',
            `D2g not_sent 态真实渲染：token 集 [n-not_sent u-notify-badge] + 文案「未通知」（实际 ${JSON.stringify(notifyRendered.not_sent)}）`);
        // 〔断言同步·Q13〕title 期望从 raw notify_error 换成**冻结映射表中文**（收编理由同 D2b）。
        must(notifyRendered.failed && notifyRendered.failed.tokens === 'n-failed u-notify-badge' && notifyRendered.failed.text === '失败' && /未填手机号/.test(notifyRendered.failed.title || ''),
            `D2h failed 态真实渲染：token 集 + 文案「失败」+ title 走映射表中文（实际 ${JSON.stringify(notifyRendered.failed)}）`);
        must(notifyRendered.__gateUnknown === '', `D2i 未登记态 gate 返回空串（降级为无修饰类的裸 base·实际 ${JSON.stringify(notifyRendered.__gateUnknown)}）`);
        must(notifyRendered.__unregisteredTitle === '未知原因',
            `D2j〔Q13 对照组〕未登记 notify_error 的 title 落「未知原因」，绝不原样外显后端码（实际 ${JSON.stringify(notifyRendered.__unregisteredTitle)}）`);
        // 〔断言同步·0b-9①/Q13〕同一处徽章 title：raw `no_phone` → 中文。注意本文件 D2d 早已按中文断言过
        //   （它一直是绿的），而本条还停在 raw ⇒ 是**半更新**状态，此处补齐，两条自此同口径。
        must(badge && /未填手机号/.test(badge.title || ''), `D2e 失败徽章 hover title 走映射表中文（Q13 收编·实际 ${badge && badge.title}）`);
        allErrs = allErrs.concat(p2._errs);
        await p2.close();

        // ===== D5〔P6-A 家族扩收〕notify-requester-done 通道的 requester_phone_empty 归因 =====
        //   与 D2b″ 同一条病、同一个修法家族：`sendIssueDingtalkToRequester` 的失败分支原先也把 reason
        //   留在 body 之外 ⇒ 前端落 HTTP 档显「钉钉服务异常」。本单**本地可造态且零外呼**：
        //   业务方手机号为空时，helper 首行就 return（在读钉钉配置/取 token **之前**），一条钉钉都不会发。
        {
            const idReqNoPhone = await apiCreate(adminToken, {
                title: 'c6d业务方完成通知-无手机号', type: '数据质量', requester_dept: '市场营销部',
                requester_name: '无手机号业务方', description: 'P6-A 家族扩收用例',
            });
            created.push(idReqNoPhone);
            // 端点闸：仅「已关闭」可通知业务方完成。⚠️ 状态机不允许直接跳（ISSUE_STATUS_TRANSITIONS:163
            //   待处理→处理中→待验证→已关闭），必须逐级走；直接置「已关闭」会 409，
            //   进而让本用例拿到「当前状态不可通知」而不是我们要验的归因（初版就这么错过一次）。
            await apiAssign(adminToken, idReqNoPhone, DEV_NO_PHONE);
            await apiStatus(adminToken, idReqNoPhone, '处理中');
            await apiStatus(adminToken, idReqNoPhone, '待验证');
            //   ⚠️ 转「已关闭」**必须带完成说明**，否则 400 REASON_REQUIRED，状态停在「待验证」，
            //   本用例就会拿到「当前状态不可通知」而不是要验的归因（实测踩过一次，留痕）。
            await apiStatus(adminToken, idReqNoPhone, '已关闭', 'P6-A 家族扩收用例：完成说明占位');
            const p5 = await gotoAs(browser, adminToken);
            p5.on('dialog', (d) => d.accept());   // 无验收地址时会弹软二次确认，自动 accept
            await p5.evaluate((id) => openDrawer(id), idReqNoPhone);
            await p5.waitForTimeout(500);
            await p5.evaluate((id) => { notifyRequesterDone(id); }, idReqNoPhone);
            await p5.waitForFunction(() => /通知失败（/.test(document.body.innerText), { timeout: 6000 }).catch(() => {});
            const t5 = await p5.evaluate(() => {
                const m = document.body.innerText.match(/通知失败（[^）]*）/);
                return m ? m[0] : '(未捕获到 toast)';
            });
            must(/业务方未填手机号/.test(t5),
                `★D5〔P6-A 家族扩收〕requester_phone_empty 归因准确：应为「通知失败（业务方未填手机号）」（实得："${t5}"）`);
            must(!/钉钉服务异常/.test(t5),
                `★D5' 对照面：**不再落 HTTP 档的「钉钉服务异常」**（修前该分支同样把"业务方没填手机号"说成"钉钉坏了"）`);
            allErrs = allErrs.concat(p5._errs);
            await p5.close();
        }

        // ===== D6〔P6-A 家族扩收·源码级〕同族两个 helper 的失败返回一致性 =====
        //   家族里另几条分支（cls.hint / 钉钉号查询失败 / 重试取 token）要造态得让**真实钉钉外呼失败**，
        //   本地零外呼前提下构造不出来 ⇒ 照 D2b⁗ 前例用源码级断言兜住，两个 helper 同一把尺子。
        {
            const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
            for (const [fn, total] of [['sendIssueDingtalkRaw', 7], ['sendIssueDingtalkToRequester', 8]]) {
                const st = srv.indexOf('async function ' + fn);
                const fnBody = st >= 0 ? srv.slice(st, srv.indexOf('\n}', st)) : '';
                const rets = fnBody.match(/return \{ ok: false[^\n]*/g) || [];
                const miss = rets.filter((l) => { const i = l.indexOf('body: {'); return i < 0 || !/\breason:/.test(l.slice(i)); });
                must(rets.length === total && miss.length === 1 && /no_config/.test(miss[0]),
                    `★D6〔P6-A 家族〕${fn}：${rets.length} 条失败返回中恰 1 条不带 body.reason，且就是 no_config` +
                    `（它的 error 是冻结表 §8 已登记字面量，走第 3 级即可）`,
                    miss.length !== 1 ? '未带 reason 的：' + miss.map((s) => s.trim().slice(0, 70)).join(' | ') : '');
            }
        }

        // 〔34 号 MED 收窄〕本套件**有意**打两个会失败的通知端点（D2 notify-developer→502、
        //   D5 notify-requester-done→400），浏览器各记一条 `Failed to load resource`——那是网络层信息不是
        //   JS 报错。但"凡是资源报错都放过"太宽：别的接口真挂了也会被一起放过。故按两条收窄：
        //     ① **只**放过 URL 命中本用例预期失败端点的资源报错（路径白名单，逐个列明）；
        //     ② 预期噪声做**等值断言**（=EXPECTED_NOISE），不再只是打印——多了少了都判红：
        //        多了＝冒出计划外的失败请求；少了＝我们以为在测的失败路径其实没被触发（用例空转）。
        //   其余一切资源报错与 JS 异常一律计入真异常。
        const EXPECTED_FAIL_ENDPOINTS = [/\/api\/issues\/\d+\/notify-developer\b/, /\/api\/issues\/\d+\/notify-requester-done\b/];
        const isResource = (e) => /Failed to load resource/i.test(e);
        const resourceNoise = allErrs.filter((e) => isResource(e) && EXPECTED_FAIL_ENDPOINTS.some((re) => re.test(e)));
        const realErrs = allErrs.filter((e) => !(isResource(e) && EXPECTED_FAIL_ENDPOINTS.some((re) => re.test(e))));
        const EXPECTED_NOISE = 2;   // D2 的 502 ×1 + D5 的 400 ×1（实测钉住；变了必须回来解释为什么）
        must(realErrs.length === 0,
            `D4 控制台无 JS 报错（真报错/计划外资源报错 ${realErrs.length} 个${realErrs.length ? ': ' + realErrs.slice(0, 2).join(' | ') : ''}）`);
        must(resourceNoise.length === EXPECTED_NOISE,
            `★D4' 预期失败端点的资源报错**等值** ${EXPECTED_NOISE} 条（D2 notify-developer 502 + D5 notify-requester-done 400）` +
            `——实得 ${resourceNoise.length} 条；多了＝冒出计划外失败请求，少了＝该失败的路径没被真正触发`);
    } finally {
        await browser.close();
        for (const id of created) await apiDelete(adminToken, id);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL / ${skips.length} SKIP`);
    if (skips.length) {
        console.log('  挂起项（不计入 PASS/FAIL·各自指向已登记待裁定编号）：');
        skips.forEach((s) => console.log(`    · [${s.code}] ${s.label}`));
    }
    console.log(fail === 0 ? '  🎉 c6d 通知按钮点击→UI 反馈实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('c6d 实测异常:', e); process.exit(1); });
