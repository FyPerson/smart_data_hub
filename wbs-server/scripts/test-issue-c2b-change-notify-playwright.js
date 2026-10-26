/**
 * C2b/C2c（交互体验优化·变更流通知全手动 + 按钮共存修）— Playwright 浏览器冒烟
 *
 * 用法：node scripts/test-issue-c2b-change-notify-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   ⚠️ 已知既有红：建单缺 intake_contract_version（本脚本两处建 sys-issues 单都没带，服务端返回 400 CLIENT_CONTRACT_OUTDATED，见 routes/sys-iteration/index.js:7354-7361；
 *   第一处建单失败即抛错、退出码非零），登记 PROJECT_STATUS，契约修复另起小提交；本次迁移只改环境层，不修业务契约。
 *   造数（建单修好之后）：经 API 建 2 张 sys-issues 单（C2b冒烟测试单 / C回归bug单）并直连实例库改状态与通知列；收尾各自 DELETE 看状态码（200 / 404 算清掉，2 轮间隔 200ms），遗留计失败。
 *   收口批：两个夹具标题都带运行标记 RUN_TAG（[c2b-<pid>-<时间戳>]），清理先按标记补查；建单助手同时校验状态码与正整数编号，红的表现 = 「建单失败」抛错退 1（第一处建单）。
 *
 * 测点：
 *   B1（C2c 按钮共存修）：变更流「已排期」态详情页操作区 → 只有「指派」无「改派」按钮（reassign.from 去 D_PRE）
 *   B2（C2b 通知区改造）：变更流「开发中」态通知区 → 逐 dev「发送通知」按钮 + 无「自动派发」提示语 + 含缓解层「最近一次发送」文案
 *   B3（C2b 本人隐藏）：admin(id=1) 在册且是本人行 → 该行无「发送通知」按钮（自指守卫前端镜像）
 *   B4：控制台无 JS 报错
 *
 * 造数：admin 建变更流单(feature) → schedule(→已排期) → 【B1 在此态验】→ assign 两开发(含 admin 自己) → 开发中 → 【B2/B3 验】
 * ⚠️ finally 删测试单，清残留。不真发钉钉（只验渲染，不点发送按钮）。
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[c2b-<pid>-<时间戳>]，两个夹具标题都带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN_ID = 1, DEV_B = 19;   // admin 自己 + 另一开发（id 19 有 phone，c6d 范式同款）

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
async function dbRun(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.run(sql, p, function (e) { const ctx = { lastID: this && this.lastID, changes: this && this.changes }; db.close((ce) => { const err = e || ce; err ? rej(err) : res(ctx); }); }); });
}
async function dbAll(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.all(sql, p, (e, r) => { db.close((ce) => { const err = e || ce; err ? rej(err) : res(r); }); }); });
}
// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(uid) {
    return testEnv.signToken(uid);
}
async function api(token, method, url, body) {
    const r = await fetch(`${BASE_URL}${url}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { _raw: txt }; }
    return { status: r.status, json };
}
// [#106 S4d-2 收口批] 建单助手：状态码须为 200 / 201 且编号为正整数，不满足即抛错（原来编号 undefined 会被后面静默忽略）；服务端已落库而这里没拿到编号的，由 cleanupIssues 按 RUN_TAG 补查
async function createSysIssue(token, body) {
    const c = await api(token, 'POST', '/api/sys-issues', body);
    const id = c.json && c.json.id;
    if ((c.status !== 200 && c.status !== 201) || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败 ${c.status} ${JSON.stringify(c.json)}`);
    return id;
}

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 50[0-9]/.test(m.text())) errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    page._errs = errs;
    return page;
}

async function openDrawerText(page, id) {
    await page.evaluate(i => siOpenDrawer(i), id);
    await page.waitForTimeout(700);
    return page.evaluate(() => {
        const el = document.getElementById('siDrawerBody') || document.querySelector('.si-drawer') || document.body;
        return el.innerText;
    });
}

let createdId = null, cBugId = null;
let adminTokenG = null;   // [#106 S4d-2] 提到模块级，供入口 .catch 里尽力清理用

/**
 * [#106 S4d-2] 删一张 sys-issues 单：DELETE 看状态码（200 / 404 算清掉），失败再试一轮（共 2 轮，间隔 200ms）；返回 null = 已清，否则返回失败说明
 */
async function deleteIssueChecked(id, label) {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));
        try {
            const d = await api(adminTokenG, 'DELETE', `/api/sys-issues/${id}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' });
            console.log(`  · 清理${label} #${id}（${d.status}）`);
            // 成功 200（routes/sys-iteration/index.js:14080 `res.json({ ok: true, id })`）/ 不存在 404（:13953）；其余（400 / 409 / 503 / 500）一律算失败
            if (d.status === 200 || d.status === 404) return null;
            lastErr = `HTTP ${d.status} ${JSON.stringify(d.json).slice(0, 120)}`;
        } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    return lastErr;
}
/**
 * [#106 S4d-2] 清理两张造的单：各自独立（一张失败不影响另一张）；清掉才把对应编号置空（入口 .catch 里再调一次是幂等的）；返回失败说明数组。
 * 原来两个 DELETE 顺序执行、不看状态码，第一个抛错会跳过第二个
 */
async function cleanupIssues() {
    const errs = [];
    // [#106 S4d-2 收口批] 先按运行标记补查：建单请求服务端已落库而客户端没拿到编号的单（已登记的编号不重复清）
    const extra = [];
    if (RUN_TAG) {
        try { for (const r of await dbAll(`SELECT id FROM sys_issues WHERE title LIKE '%' || ? || '%'`, [RUN_TAG])) { if (r.id !== createdId && r.id !== cBugId) extra.push(r.id); } }
        catch (e) { errs.push(`按运行标记补查失败：${(e && e.message) || e}`); }
    }
    for (const id of extra) {
        const e = await deleteIssueChecked(id, ' 按标记补查到的单');
        if (e) errs.push(`补查到的单 #${id}: ${e}`);
    }
    if (createdId) {
        const e = await deleteIssueChecked(createdId, '测试单');
        if (e) errs.push(`测试单 #${createdId}: ${e}`); else createdId = null;
    }
    if (cBugId) {
        const e = await deleteIssueChecked(cBugId, ' C 回归 bug 单');
        if (e) errs.push(`C 回归 bug 单 #${cBugId}: ${e}`); else cBugId = null;
    }
    return errs;
}

async function main() {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    RUN_TAG = `[c2b-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    adminTokenG = adminToken;
    console.log('\n══════ C2b/C2c 变更流通知全手动 + 按钮共存修 浏览器冒烟 ══════');

    // 造数：建变更流(feature)单 → schedule
    // [#106 S4d-2] 原 process.exit(1) 改 throw：入口 .catch 里 teardown 后以 1 退出（既有红：建单缺 intake_contract_version，原样保留）
    createdId = await createSysIssue(adminToken, {
        type: 'feature', title: 'C2b冒烟测试单' + RUN_TAG, system_name: 'BMS', source: '内部', description: 'x', intake_liaison_id: 13,
    });
    console.log(`  · 建变更流单 #${createdId}（待评估）`);

    const browser = await chromium.launch();
    let allErrs = [];
    try {
        const sch = await api(adminToken, 'POST', `/api/sys-issues/${createdId}/schedule`, { priority: 'P2' });
        must(sch.status === 200, `造数：schedule → 已排期（${sch.status}）`);

        // ===== B1：已排期态 → 只有指派、无改派按钮 =====
        const p1 = await gotoAs(browser, adminToken);
        const t1 = await openDrawerText(p1, createdId);
        // 从操作区按钮取（详情页动作区）
        const acts1 = await p1.evaluate(() => {
            const box = document.getElementById('siDActions');
            return box ? box.innerText : '';
        });
        must(/指派/.test(acts1), `B1a 已排期态操作区含「指派」按钮`);
        must(!/改派/.test(acts1), `B1b 已排期态操作区**无**「改派」按钮（C2c 共存修·实际动作区="${acts1.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);
        // ===== A 回归（对抗审 HIGH）：已排期(D_PRE)态「管理开发成员」按钮隐藏（reassign 第二入口镜像 reassign.from）=====
        const manageBtnDPre = await p1.evaluate(() => {
            const secs = [...document.querySelectorAll('.u-detail-section')];
            const s = secs.find(x => /开发成员/.test(x.innerText));
            return s ? /管理开发成员/.test(s.innerHTML) : null;
        });
        must(manageBtnDPre === false, `A1 已排期(D_PRE)态**无**「管理开发成员」按钮（对抗审 HIGH 修·避免点击必 409 死按钮·实际=${manageBtnDPre}）`);
        allErrs = allErrs.concat(p1._errs);
        await p1.close();

        // ===== 造数 continue：assign 两开发（admin 自己 + DEV_B）→ 开发中 =====
        const asg = await api(adminToken, 'POST', `/api/sys-issues/${createdId}/assign`, { assigned_to: ADMIN_ID, collaborator_ids: [DEV_B] });
        must(asg.status === 200, `造数：assign → 开发中（${asg.status}）`);
        const st = await dbGet('SELECT status FROM sys_issues WHERE id=?', [createdId]);
        must(st.status === '开发中', `造数：主状态=开发中（实际 ${st.status}）`);

        // ===== B2：开发中态通知区 → 逐 dev 发送按钮 + 无自动派发提示 + 缓解层文案 =====
        const p2 = await gotoAs(browser, adminToken);
        const t2 = await openDrawerText(p2, createdId);
        const notifyHtml = await p2.evaluate(() => {
            // 定位通知区 section（h3 含「钉钉通知」）
            const secs = [...document.querySelectorAll('.u-detail-section')];
            const s = secs.find(x => /钉钉通知/.test(x.innerText));
            return s ? s.innerHTML : '';
        });
        must(!!notifyHtml, `B2a 变更流开发中态渲染出通知区（钉钉通知 section 存在）`);
        must(/发送通知/.test(notifyHtml), `B2b 通知区含「发送通知」按钮（逐 dev 手动·非只读三侧）`);
        must(!/自动派发/.test(notifyHtml), `B2c 通知区**无**「自动派发」旧提示语（已去除）`);
        must(/手动触发/.test(notifyHtml), `B2d 通知区含「手动触发」新提示语`);
        must(/最近一次发送/.test(notifyHtml), `B2e 缓解层：含「最近一次发送」动作语义文案（旧 sent 不误标当前动作）`);

        // ===== A 对照（对抗审 HIGH）：开发中(DEV·reassign.from 命中)态「管理开发成员」按钮显示 =====
        const manageBtnDev = await p2.evaluate(() => {
            const secs = [...document.querySelectorAll('.u-detail-section')];
            const s = secs.find(x => /开发成员/.test(x.innerText));
            return s ? /管理开发成员/.test(s.innerHTML) : null;
        });
        must(manageBtnDev === true, `A2 开发中(DEV)态**有**「管理开发成员」按钮（对照·reassign.from 命中态正常显示·实际=${manageBtnDev}）`);

        // ===== B3：admin(id=1) 本人在册 → 本人行无发送按钮 =====
        // 通知区 dev 行文本含 admin 显示名；本人行不应有「发送通知」按钮。用行级 DOM 判定。
        const selfRowHasSend = await p2.evaluate((selfId) => {
            const rows = [...document.querySelectorAll('.u-notify-row')];
            // 找含「发送通知/重新通知」按钮且 onclick 指向 selfId 的行——存在即违反本人隐藏
            for (const r of rows) {
                const btns = [...r.querySelectorAll('button')];
                for (const b of btns) {
                    const oc = b.getAttribute('onclick') || '';
                    if (/siNotifyDevSend\(/.test(oc) && oc.includes('(' + selfId + ')')) return true;
                }
            }
            return false;
        }, ADMIN_ID);
        must(!selfRowHasSend, `B3 admin 本人开发行**无**发送按钮（自指守卫前端镜像·siNotifyDevSend(1) 不出现）`);

        // DEV_B(19) 非本人行 → 应有发送按钮（对照，证明按钮机制本身工作）
        const otherRowHasSend = await p2.evaluate((otherId) => {
            const rows = [...document.querySelectorAll('.u-notify-row')];
            for (const r of rows) {
                for (const b of r.querySelectorAll('button')) {
                    const oc = b.getAttribute('onclick') || '';
                    if (/siNotifyDevSend\(/.test(oc) && oc.includes('(' + otherId + ')')) return true;
                }
            }
            return false;
        }, DEV_B);
        must(otherRowHasSend, `B3b 对照：非本人开发(#${DEV_B})行**有**发送按钮（证明按钮机制正常，非全被隐藏）`);

        allErrs = allErrs.concat(p2._errs);
        await p2.close();

        // ===== C 回归（对抗审 MED）：bug 主开发（非 admin 非对接人）通知区无「建单人发送」+ 无「查已读」按钮 =====
        // 造 bug 单 → assign user19(主开发·role=user·非白名单) → SQL 直推「待验证」(creator sendable 态·绕 submit 闸门造渲染态)
        let cBugCreateErr = null;
        try {
            cBugId = await createSysIssue(adminToken, {
                type: 'bug', title: 'C回归bug单' + RUN_TAG, system_name: 'BMS', source: '生产故障', description: 'x', intake_liaison_id: 13,
            });
        } catch (e) { cBugCreateErr = (e && e.message) || String(e); }
        if (cBugCreateErr === null) {
            await api(adminToken, 'POST', `/api/sys-issues/${cBugId}/assign`, { assigned_to: DEV_B });   // 待处理→处理中·DEV_B 成主开发代表
            // SQL 直推待验证 + dev_status=code_submitted（仅为渲染 creator sendable 行·不走状态机·测试库）
            await dbRun(`UPDATE sys_issues SET status='待验证' WHERE id=?`, [cBugId]);
            await dbRun(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted' WHERE issue_id=? AND removed_at IS NULL`, [cBugId]);
            // 造一条 creator sent 记录（让「查已读」按钮有机会渲染·验证权限旗标真去 isPrimaryDev）
            await dbRun(`UPDATE sys_issues SET creator_notify_status='sent', creator_notify_message_key='mock_ck', creator_notified_at=datetime('now','localtime') WHERE id=?`, [cBugId]);

            const dev19Token = await signAs(DEV_B);
            const p5 = await gotoAs(browser, dev19Token);
            await openDrawerText(p5, cBugId);
            const notifyHtml5 = await p5.evaluate(() => {
                const secs = [...document.querySelectorAll('.u-detail-section')];
                const s = secs.find(x => /钉钉通知/.test(x.innerText));
                return s ? s.innerHTML : '(无通知区)';
            });
            // 主开发能看到通知区（canSeeNotify 保留主开发可见·只读展示无害），但建单人行/查已读均无按钮
            const creatorHasSend = /siNotifyCreatorClick/.test(notifyHtml5);
            const anyQueryRead = /siQueryReadStatus/.test(notifyHtml5);
            must(!creatorHasSend, `C1 bug 主开发(非admin)通知区**无**「发送建单人通知」按钮（对抗审 MED 修·去 isPrimaryDev·避免点击必 403）`);
            must(!anyQueryRead, `C2 bug 主开发**无**任何「查已读」按钮（canQueryRead 去 isPrimaryDev·实际含查已读=${anyQueryRead}）`);
            allErrs = allErrs.concat(p5._errs);
            await p5.close();

            // 对照：admin 视角同单 → creator sent 行有查已读按钮（证明按钮机制正常，非全隐）
            const p6 = await gotoAs(browser, adminToken);
            await openDrawerText(p6, cBugId);
            const notifyHtml6 = await p6.evaluate(() => {
                const secs = [...document.querySelectorAll('.u-detail-section')];
                const s = secs.find(x => /钉钉通知/.test(x.innerText));
                return s ? s.innerHTML : '';
            });
            must(/siQueryReadStatus/.test(notifyHtml6), `C3 对照：admin 视角同单**有**「查已读」按钮（证明机制正常·非全隐）`);
            allErrs = allErrs.concat(p6._errs);
            await p6.close();
        } else {
            must(false, `C 回归造 bug 单失败（${cBugCreateErr}）`);
        }

        must(allErrs.length === 0, `B4 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
    } finally {
        try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
        const cleanupErrs = await cleanupIssues();
        for (const m of cleanupErrs) must(false, `清理失败（已重试 1 轮）：${m}`);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C2b/C2c 浏览器冒烟全部通过\n' : '  🚫 存在失败项\n');
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
    console.error('C2b 冒烟异常:', e);
    try { await cleanupIssues(); } catch (_) { /* 已在报错路径，尽力清理 */ }
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
