/**
 * C2b/C2c（交互体验优化·变更流通知全手动 + 按钮共存修）— Playwright 浏览器冒烟
 *
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-c2b-change-notify-playwright.js
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1, DEV_B = 19;   // admin 自己 + 另一开发（id 19 有 phone，c6d 范式同款）

function dbGet(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }
function dbRun(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.run(sql, p, function (e) { db.close(); e ? rej(e) : res(this); }); }); }
async function signAs(uid) {
    const u = await dbGet('SELECT id,username,display_name,role FROM users WHERE id=?', [uid]);
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
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
async function main() {
    const adminToken = await signAs(ADMIN_ID);
    console.log('\n══════ C2b/C2c 变更流通知全手动 + 按钮共存修 浏览器冒烟 ══════');

    // 造数：建变更流(feature)单 → schedule
    const c = await api(adminToken, 'POST', '/api/sys-issues', {
        type: 'feature', title: 'C2b冒烟测试单', system_name: '智数协同', source: '内部', description: 'x',
    });
    if (c.status !== 200 && c.status !== 201) { console.error('建单失败', c.status, c.json); process.exit(1); }
    createdId = c.json.id;
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
        const cBug = await api(adminToken, 'POST', '/api/sys-issues', {
            type: 'bug', title: 'C回归bug单', system_name: '智数协同', source: '生产故障', description: 'x',
        });
        if (cBug.status === 200 || cBug.status === 201) {
            cBugId = cBug.json.id;
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
            must(false, `C 回归造 bug 单失败（${cBug.status}）`);
        }

        must(allErrs.length === 0, `B4 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
    } finally {
        await browser.close();
        if (createdId) { const d = await api(adminToken, 'DELETE', `/api/sys-issues/${createdId}`); console.log(`  · 清理测试单 #${createdId}（${d.status}）`); }
        if (cBugId) { const d = await api(adminToken, 'DELETE', `/api/sys-issues/${cBugId}`); console.log(`  · 清理 C 回归 bug 单 #${cBugId}（${d.status}）`); }
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C2b/C2c 浏览器冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('C2b 冒烟异常:', e); process.exit(1); });
