/**
 * 数据协作·终态通知记录展示（通知归档态统一 C1）前端 Playwright UI 实测
 *
 * 用法：node scripts/test-collab-terminal-notify-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 覆盖（纯客户端 DOM 断言，直接 UPDATE collab_requests 造终态字段组合，不走真实工作流/钉钉）：
 *   S1 归档单（status=ARCHIVED，曾 DONE+已通知业务方(未读+有key)+已转发导出人+已通知预计(未读+有key)）
 *      → 区块保留 / 记录可见（已通知业务方 / 已转发导出人 / 已通知预计）/ 写按钮全消失 / 查询已读按钮保留
 *      → 角色可见性：exporter（非 forward 圈）看不到导出人记录，但能看到业务方记录（own exporter）
 *   S2 软删除作废单（archived_at 非空、status='DONE' 未终归档）→ 降级文案（未通知/未转发/未通知需求方），无写按钮
 *   S3 从未通知单（终态但全空 + 未走导出路径 + 无预计值）→ 业务方"尚未通知"、导出人块不渲染、预计块不渲染
 *   S4 脏数据单（read_at 有但 notified_at 空 / exporter_name 空但已转发 / expected_notify_status 未知枚举）
 *      → 降级正确、0 处 NaN / Invalid Date
 *   全程 0 console error
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = fx.BASE;
const DB_PATH = fx.DB_PATH;

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

const createdFixtureIds = [];

function patchCollab(id, fields) {
    const cols = Object.keys(fields);
    if (cols.length === 0) return Promise.resolve();
    const sets = cols.map(c => `${c}=?`).join(', ');
    const params = cols.map(c => fields[c]);
    params.push(id);
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(`UPDATE collab_requests SET ${sets} WHERE id=?`, params, function (err) {
            db.close();
            err ? reject(err) : resolve(this);
        });
    });
}

// 造 1 个 active result_data 附件（S8 交付区需要交付文件列表；FK CASCADE 随 cleanup 一并删）
function insertActiveResultData(collabId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status, submission_version)
             VALUES (?, 'result_data', 'collab/test/c1_s8_result.xlsx', 'c1_s8_result.xlsx', ?, '示例用户B', 'active', 1)`,
            [collabId, fx.DEV1_ID],
            function (err) { db.close(); err ? reject(err) : resolve(this.lastID); }
        );
    });
}

// 每次调用起一个全新 context（而非复用同一 page 反复登录）：
//   login.html 的 checkAuth() 若发现 localStorage 已有上一轮遗留的合法 token，会异步校验后
//   window.location.href 跳转 /Task_Pool.html，与本次 evaluate 写新 token 竞态（"Execution context
//   was destroyed" 的根因）。全新 context 天然无残留 token，彻底避开这条竞态，比清 localStorage 更稳。
async function openDetailAndGetHtml(browser, token, id, consoleErrors) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (consoleErrors) {
        page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    }
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Data_Collab.html?id=${id}`, { waitUntil: 'load' });
    await page.waitForSelector('#detailDrawer.open', { timeout: 5000 });
    // 等 openDetail 的 fetch + renderDetail 完整落地（M3 同款节奏）
    await page.waitForTimeout(500);
    const html = await page.locator('#detailBody').innerHTML();
    const text = await page.locator('#detailBody').innerText();
    await context.close();
    return { html, text };
}

function assertBlock(html, mustInclude, mustExclude, label) {
    for (const s of mustInclude) {
        expect(html.includes(s), `${label}：应包含「${s}」`);
    }
    for (const s of mustExclude) {
        expect(!html.includes(s), `${label}：不应包含「${s}」`);
    }
}

(async () => {
    console.log('=== C1 数据协作·终态通知记录展示 Playwright UI 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];

    try {
        // ===== 造 4 个 fixture（各自独立，基于 createPendingFixture 的 contact/dev 指派）=====
        console.log('0. 造种子（S1-S4）');
        const s1 = await fx.createPendingFixture();
        createdFixtureIds.push(s1.id);
        await patchCollab(s1.id, {
            status: 'ARCHIVED',
            exporter_user_id: fx.EXPORTER_ID,
            exporter_name: '示例开发A',
            forwarded_to_exporter_at: '2026-07-01 10:00:00',
            done_notified_at: '2026-07-02 15:00:00',
            done_notify_message_key: 'MSGKEY-S1-DONE',
            done_read_at: null,
            requester_name: '张三',
            dev_estimated_at: '2026-07-03 00:00:00',
            expected_notify_status: 'sent',
            expected_notified_at: '2026-07-01 09:00:00',
            expected_notify_message_key: 'MSGKEY-S1-EXP',
            expected_read_at: null,
            contact_notified_at: '2026-06-30 08:00:00',
            contact_notify_message_key: 'MSGKEY-S1-CONTACT',
            contact_read_at: '2026-06-30 08:30:00',
            notified_at: '2026-06-30 09:00:00',
            notify_message_key: 'MSGKEY-S1-DEV',
            read_at: '2026-06-30 09:30:00',
        });

        const s2 = await fx.createPendingFixture();
        createdFixtureIds.push(s2.id);
        await patchCollab(s2.id, {
            status: 'DONE',                       // 未终归档，仅软删除作废
            archived_at: '2026-07-05 12:00:00',
            archived_reason: 'C1 e2e 测试作废',
            exporter_user_id: fx.EXPORTER_ID,
            exporter_name: '示例开发A',
            forwarded_to_exporter_at: null,        // engaged 但未转发 → "未转发给导出人"
            done_notified_at: null,                // 从未通知业务方
            requester_name: '李四',
            dev_estimated_at: '2026-07-04 00:00:00',
            expected_notify_status: 'not_sent',    // 从未通知需求方
        });

        const s3 = await fx.createPendingFixture();
        createdFixtureIds.push(s3.id);
        await patchCollab(s3.id, {
            status: 'ARCHIVED',
            exporter_user_id: null,
            exporter_name: null,
            forwarded_to_exporter_at: null,         // 未 engaged → 导出人块不渲染
            done_notified_at: null,
            requester_name: '王五',
            dev_estimated_at: null,                 // 无预计值 → 预计块不渲染
        });

        const s4 = await fx.createPendingFixture();
        createdFixtureIds.push(s4.id);
        await patchCollab(s4.id, {
            status: 'ARCHIVED',
            exporter_user_id: fx.EXPORTER_ID,
            exporter_name: null,                    // 脏数据：已转发但姓名缺失
            forwarded_to_exporter_at: '2026-07-06 08:00:00',
            done_notified_at: null,                 // 脏数据：read_at 有但 notified_at 空
            done_read_at: '2026-07-06 09:00:00',
            requester_name: '赵六',
            dev_estimated_at: '2026-07-06 00:00:00',
            // 注：expected_notify_status 列有 DB CHECK(IN not_sent/sent/failed/no_phone)，非法枚举值
            // 无法通过合法 UPDATE 写入（该分支已通过 verify-collab-terminal-notify.js 的字符串哨兵覆盖，
            // 运行时不可达——仅历史脏库迁移场景理论触发）。这里改测同样"脏"但可合法写入的组合：
            // failed + 残留 expected_read_at（对应任务书 §5.D 表格 failed 行"残留 read_at→加·数据异常"）
            expected_notify_status: 'failed',
            expected_read_at: '2026-07-06 10:30:00',
            contact_notified_at: 'not-a-valid-date',       // 脏数据：非法日期字符串
            contact_notify_message_key: null,
            contact_read_at: null,
        });

        // ===== §7 sweep 补：S5/S6/S7 三态验证 voided 单写按钮收口（保留 val-box/通知记录框）=====
        // S5 voided-at-PENDING_ASSIGN：验收区"指派开发"消失 + 对接人通知块无"通知对接人"按钮（记录/标题框留）
        const s5 = await fx.createPendingFixture();
        createdFixtureIds.push(s5.id);
        await patchCollab(s5.id, {
            status: 'PENDING_ASSIGN',
            archived_at: '2026-07-07 12:00:00',
            archived_reason: 'C1 §7 e2e PENDING_ASSIGN voided',
            contact_notified_at: null,             // 未通知对接人 → "尚未通知对接人"（终态无按钮无 hint）
            requester_name: '钱七',
        });

        // S6 voided-at-PENDING：验收区 developer"上传交付物"/admin"改派开发"消失 + 开发通知块无"通知开发"按钮
        const s6 = await fx.createPendingFixture();
        createdFixtureIds.push(s6.id);
        await patchCollab(s6.id, {
            status: 'PENDING',
            archived_at: '2026-07-07 13:00:00',
            archived_reason: 'C1 §7 e2e PENDING voided',
            notified_at: null,                     // 未通知开发 → "尚未通知开发"（终态无按钮无 hint）
            requester_name: '孙八',
        });

        // S7 voided-at-SUBMITTED+failed：验收区"重新上传交付物"/"旁路放行"消失（"❌ 验收失败 + 错误详情"框留）
        const s7 = await fx.createPendingFixture();
        createdFixtureIds.push(s7.id);
        await patchCollab(s7.id, {
            status: 'SUBMITTED',
            sql_validation_status: 'failed',
            sql_validation_error: 'C1 §7 e2e smoke failed detail line',
            submission_version: 1,
            archived_at: '2026-07-07 14:00:00',
            archived_reason: 'C1 §7 e2e SUBMITTED failed voided',
            requester_name: '周九',
        });

        // ===== codex MED-1/2 收口验证：S8/S9 =====
        // S8 voided-at-DONE + active 交付附件（开发本人视角）：交付区无删除/重新上传按钮，交付文件列表仍在
        const s8 = await fx.createPendingFixture();
        createdFixtureIds.push(s8.id);
        await insertActiveResultData(s8.id);   // 1 个 active result_data → 交付区渲染 + 业务方完成通知前提
        await patchCollab(s8.id, {
            status: 'DONE',                        // 完成态
            done_notified_at: '2026-07-08 10:00:00',
            done_notify_message_key: 'MSGKEY-S8-DONE',
            archived_at: '2026-07-08 11:00:00',    // DONE 之后被作废（voided-at-DONE，status 仍 DONE）
            archived_reason: 'C1 MED-1 e2e DONE voided',
            requester_name: '吴十',
        });

        // S9 voided-at-EXPORTING（dev 已通知）：开发通知记录可见（装配层放行），无通知/重新通知按钮
        const s9 = await fx.createPendingFixture();
        createdFixtureIds.push(s9.id);
        await patchCollab(s9.id, {
            status: 'EXPORTING',                   // EXPORTING 阶段被作废
            exporter_user_id: fx.EXPORTER_ID,
            exporter_name: '示例开发A',
            forwarded_to_exporter_at: '2026-07-08 12:00:00',
            notified_at: '2026-07-08 09:00:00',    // 开发已通知（记录完整）
            notify_message_key: 'MSGKEY-S9-DEV',
            read_at: null,
            archived_at: '2026-07-08 13:00:00',
            archived_reason: 'C1 MED-2 e2e EXPORTING voided',
            requester_name: '郑十一',
        });

        // S10 用户反馈（2026-07-12）：终态【已读】态 业务方/预计 记录须【通知时间 + 已读时间两行都显】（对齐 dev/contact）
        const s10 = await fx.createPendingFixture();
        createdFixtureIds.push(s10.id);
        await patchCollab(s10.id, {
            status: 'ARCHIVED',
            done_notified_at: '2026-07-09 15:00:00',
            done_notify_message_key: 'MSGKEY-S10-DONE',
            done_read_at: '2026-07-09 16:00:00',            // 业务方已读
            requester_name: '陈十二',
            dev_estimated_at: '2026-07-09 00:00:00',
            expected_notify_status: 'sent',
            expected_notified_at: '2026-07-09 09:00:00',
            expected_notify_message_key: 'MSGKEY-S10-EXP',
            expected_read_at: '2026-07-09 10:00:00',        // 需求方·预计已读
        });

        const adminToken = s1.adminToken;
        const exporterToken = await fx.signAs(fx.EXPORTER_ID);
        const devToken = s6.dev1Token;  // dev1 = 示例用户B id=19，S6/S7/S8/S9 fixture 的被指派开发

        // ===== S1：归档单（admin 视角）=====
        console.log('\n1. S1 归档单（admin 视角）— 区块保留/记录可见/写按钮消失/查询已读保留');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s1.id, consoleErrors);
            assertBlock(html, [
                '✅ 已于 2026-07-02 15:00 通知业务方 张三 并发送数据',   // 业务方记录
                '✅ 已转发给信息技术部 - 示例开发A · 于 2026-07-01 10:00',  // 导出人记录
                '预计完成时间',                                          // 预计区块标题保留
                '✅ 已于 2026-07-01 09:00 通知 张三·预计完成',           // 预计记录（含需求方名·对齐活跃态 expected 分支）
                'checkReadStatus(',                                      // 只读查询动作保留（至少 1 处）
            ], [
                'onclick="notifyRequesterDone(',
                'onclick="openForwardToExporterDialog(',
                'onclick="notifyExpected(',
                'onclick="openEstimateModal(',
                'onclick="triggerNotify(',
            ], 'S1(admin)');
            expect(!text.includes('NaN') && !text.includes('Invalid Date'), 'S1(admin)：无 NaN / Invalid Date');
        }

        // ===== S1：exporter 视角（非 forward 圈）=====
        console.log('\n2. S1 角色可见性（exporter=示例开发A，非 forward 圈）— 看不到导出人记录，能看到业务方记录，看不到预计区块');
        {
            const { html } = await openDetailAndGetHtml(browser, exporterToken, s1.id, consoleErrors);
            expect(!html.includes('已转发给信息技术部 - 示例开发A'), 'S1(exporter)：导出人记录不可见（非 forward 圈）');
            expect(html.includes('通知业务方 张三 并发送数据'), 'S1(exporter)：业务方记录可见（own exporter 在权限集内）');
            expect(!/detail-section-title">预计完成时间</.test(html), 'S1(exporter)：预计完成区块不可见（非 dev/admin/creator）');
        }

        // ===== S2：软删除作废单（admin 视角）=====
        console.log('\n3. S2 软删除作废单 — 降级文案（未通知/未转发），无写按钮');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s2.id, consoleErrors);
            assertBlock(html, [
                '尚未通知业务方负责人 李四',
                '未转发给导出人',
                '尚未通知需求方·预计完成',
            ], [
                'onclick="notifyRequesterDone(',
                'onclick="openForwardToExporterDialog(',
                'onclick="notifyExpected(',
                'onclick="openEstimateModal(',
            ], 'S2(admin)');
            expect(!text.includes('NaN') && !text.includes('Invalid Date'), 'S2(admin)：无 NaN / Invalid Date');
        }

        // ===== S3：从未通知单（admin 视角）=====
        console.log('\n4. S3 从未通知单 — 业务方"尚未通知"，导出人/预计块不渲染（未 engaged / 无预计值）');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s3.id, consoleErrors);
            expect(html.includes('尚未通知业务方负责人 王五'), 'S3：业务方"尚未通知"记录可见');
            expect(!html.includes('该数据支持从业务系统前端导出'), 'S3：导出人块不渲染（未 engaged）');
            expect(!/detail-section-title">预计完成时间</.test(html), 'S3：预计完成区块不渲染（无预计值）');
            expect(!text.includes('NaN') && !text.includes('Invalid Date'), 'S3：无 NaN / Invalid Date');
        }

        // ===== S4：脏数据单（admin 视角）=====
        console.log('\n5. S4 脏数据单 — 降级正确、0 处 NaN/Invalid Date');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s4.id, consoleErrors);
            assertBlock(html, [
                '已转发给（原导出人已不可用）',                 // 姓名缺失降级
                '（通知时间缺失）',                              // done_read_at 有但 notified_at 空
                '上次通知失败',                                  // failed + 残留 read_at → 数据异常降级
                '数据异常',
                '已读状态不可查',                                // contact 非法日期 + 无 key → 纯文字降级
            ], [
                'onclick="notifyRequesterDone(',
                'onclick="openForwardToExporterDialog(',
                'onclick="notifyExpected(',
            ], 'S4(admin)');
            expect(!text.includes('NaN'), 'S4：无 NaN（含非法日期字符串 contact_notified_at 场景）');
            expect(!text.includes('Invalid Date'), 'S4：无 Invalid Date 文案');
        }

        // ===== §7 sweep：S5 voided-at-PENDING_ASSIGN（admin 视角）=====
        console.log('\n6. §7 S5 voided-at-PENDING_ASSIGN — 无"指派开发"+对接人块无"通知对接人"按钮/hint，val-box/记录框留');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s5.id, consoleErrors);
            // 验收区：写按钮消失，只读标题框保留
            expect(!html.includes('onclick="openAssignDialog('), 'S5：验收区"指派开发"按钮消失');
            expect(html.includes('等指派开发') || html.includes('指派开发'), 'S5：验收区"指派开发"记录框保留');
            // 对接人通知块：终态无"通知对接人"按钮 + 无"（仅管理员可触发通知）"hint（作废单不误导）
            expect(!html.includes('>通知对接人</button>'), 'S5：对接人块"通知对接人"按钮消失');
            expect(!html.includes('（仅管理员可触发通知）'), 'S5：对接人块终态 hint 隐藏（不误导作废单）');
            expect(html.includes('尚未通知对接人'), 'S5：对接人"尚未通知"记录文字保留');
            expect(!text.includes('NaN') && !text.includes('Invalid Date'), 'S5：无 NaN / Invalid Date');
        }

        // ===== §7 sweep：S6 voided-at-PENDING（developer + admin 双视角）=====
        console.log('\n7. §7 S6 voided-at-PENDING — developer 无"上传交付物"/admin 无"改派开发"+开发通知块无按钮，记录框留');
        {
            // developer 视角
            const { html: devHtml, text: devText } = await openDetailAndGetHtml(browser, devToken, s6.id, consoleErrors);
            expect(!devHtml.includes('onclick="openSubmitDeliveryDialog('), 'S6(dev)：验收区"上传交付物"按钮消失');
            expect(devHtml.includes('尚未提交交付物'), 'S6(dev)：验收区"尚未提交交付物"记录框保留');
            expect(!devHtml.includes('>通知开发</button>'), 'S6(dev)：开发通知块"通知开发"按钮消失');
            expect(!devHtml.includes('（仅管理员/本单对接人可触发通知）'), 'S6(dev)：开发通知块终态 hint 隐藏');
            expect(devHtml.includes('尚未通知开发'), 'S6(dev)：开发"尚未通知"记录文字保留');
            expect(!devText.includes('NaN') && !devText.includes('Invalid Date'), 'S6(dev)：无 NaN / Invalid Date');

            // admin 视角
            const { html: admHtml } = await openDetailAndGetHtml(browser, adminToken, s6.id, consoleErrors);
            expect(!admHtml.includes('onclick="openAssignDialog('), 'S6(admin)：验收区"改派开发"按钮消失');
            expect(admHtml.includes('已指派给'), 'S6(admin)：验收区"已指派给"记录框保留');
        }

        // ===== §7 sweep：S7 voided-at-SUBMITTED+failed（developer + admin 双视角）=====
        console.log('\n8. §7 S7 voided-at-SUBMITTED+failed — 无"重新上传"/"旁路放行"，"验收失败+错误详情"框留');
        {
            const { html: devHtml, text: devText } = await openDetailAndGetHtml(browser, devToken, s7.id, consoleErrors);
            expect(!devHtml.includes('onclick="openRetryDialog('), 'S7(dev)：验收区"重新上传交付物"按钮消失');
            expect(devHtml.includes('验收失败'), 'S7(dev)：验收区"❌ 验收失败"记录框保留');
            expect(devHtml.includes('C1 §7 e2e smoke failed detail line'), 'S7(dev)：验收失败错误详情保留');
            expect(!devText.includes('NaN') && !devText.includes('Invalid Date'), 'S7(dev)：无 NaN / Invalid Date');

            const { html: admHtml } = await openDetailAndGetHtml(browser, adminToken, s7.id, consoleErrors);
            expect(!admHtml.includes('onclick="openBypassDialog('), 'S7(admin)：验收区"旁路放行"按钮消失');
            expect(admHtml.includes('验收失败'), 'S7(admin)：验收区"❌ 验收失败"记录框保留');
        }

        // ===== codex MED-1：S8 voided-at-DONE + active 交付附件 =====
        //   交付区写按钮收口 → developer 本人视角（交付区无角色门，只 canModifyDelivery gate 按钮）
        //   业务方·完成终态记录可见性=admin/exporter/creator（dev 不在集内，故记录从 admin 视角验证）
        console.log('\n9. MED-1 S8 voided-at-DONE — 交付区无删除/重传按钮、交付文件列表仍在（dev）；业务方完成终态记录可见（admin）');
        {
            // developer 本人视角：交付区写按钮消失 + 交付文件列表仍在
            const { html: devHtml, text: devText } = await openDetailAndGetHtml(browser, devToken, s8.id, consoleErrors);
            expect(!devHtml.includes('onclick="deleteDeliveryAttachment('), 'S8(dev)：交付附件"删除"按钮消失');
            expect(!devHtml.includes('重新上传交付物'), 'S8(dev)：底部"🔄 重新上传交付物"按钮消失');
            expect(devHtml.includes('c1_s8_result.xlsx'), 'S8(dev)：交付文件名保留');
            expect(devHtml.includes('delivery-link'), 'S8(dev)：交付文件下载链接保留');
            expect(!devText.includes('NaN') && !devText.includes('Invalid Date'), 'S8(dev)：无 NaN / Invalid Date');

            // admin 视角（creator+admin，业务方完成记录可见集内）：终态记录可见，发送按钮消失
            const { html: admHtml } = await openDetailAndGetHtml(browser, adminToken, s8.id, consoleErrors);
            expect(admHtml.includes('通知业务方 吴十 并发送数据'), 'S8(admin)：业务方·完成终态记录可见（voided-at-DONE 走终态分支）');
            expect(!admHtml.includes('onclick="notifyRequesterDone('), 'S8(admin)：业务方·完成发送按钮消失');
            // admin 也是 developer？否——admin(id=1)≠dev1(id=19)，交付区 canModifyDelivery=false，同样无删除/重传按钮
            expect(!admHtml.includes('onclick="deleteDeliveryAttachment('), 'S8(admin)：非本单开发，交付删除按钮本就不显（回归确认）');
        }

        // ===== codex MED-2：S9 voided-at-EXPORTING（dev 已通知，developer + admin 双视角）=====
        console.log('\n10. MED-2 S9 voided-at-EXPORTING — 开发通知记录可见（装配层放行），无通知/重新通知按钮');
        {
            const { html: devHtml, text: devText } = await openDetailAndGetHtml(browser, devToken, s9.id, consoleErrors);
            expect(devHtml.includes('已于 2026-07-08 09:00 通知开发'), 'S9(dev)：开发通知终态记录可见（装配层放行终态 EXPORTING）');
            expect(!devHtml.includes('>通知开发</button>') && !devHtml.includes('>重新通知</button>'), 'S9(dev)：开发通知块无通知/重新通知按钮');
            expect(!devText.includes('NaN') && !devText.includes('Invalid Date'), 'S9(dev)：无 NaN / Invalid Date');

            const { html: admHtml } = await openDetailAndGetHtml(browser, adminToken, s9.id, consoleErrors);
            expect(admHtml.includes('已于 2026-07-08 09:00 通知开发'), 'S9(admin)：开发通知终态记录可见');
            expect(!admHtml.includes('>通知开发</button>') && !admHtml.includes('>重新通知</button>'), 'S9(admin)：开发通知块无通知/重新通知按钮');
        }

        // ===== S10 用户反馈：终态【已读】态 通知时间 + 已读时间两行都显（对齐 dev/contact）=====
        console.log('\n11. S10 终态已读态一致性 — 业务方/预计 记录【通知时间 + 已读时间都显】');
        {
            const { html, text } = await openDetailAndGetHtml(browser, adminToken, s10.id, consoleErrors);
            assertBlock(html, [
                '✅ 已于 2026-07-09 15:00 通知业务方 陈十二 并发送数据',   // 业务方·通知时间（已读态仍显·修复点）
                '📖 陈十二 已读 · 于 2026-07-09 16:00',                    // 业务方·已读时间（两行都在）
                '✅ 已于 2026-07-09 09:00 通知 陈十二·预计完成',          // 预计·通知时间（已读态仍显·修复点）
                '📖 陈十二 已读 · 于 2026-07-09 10:00',                    // 预计·已读时间（两行都在）
            ], [
                'onclick="notifyRequesterDone(',
                'onclick="notifyExpected(',
                'onclick="openEstimateModal(',
            ], 'S10(admin) 终态已读态一致性');
            expect(!text.includes('NaN') && !text.includes('Invalid Date'), 'S10：无 NaN / Invalid Date');
        }

        // ===== 全程 console 健康 =====
        console.log('\n12. console 健康');
        expect(consoleErrors.length === 0,
            `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''}）`);

    } catch (e) {
        console.error('\n!! 运行异常：', e.stack || e.message);
        fail++;
    } finally {
        await browser.close();
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.warn(`cleanup ${id} failed: ${e.message}`); }
        }
        console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
