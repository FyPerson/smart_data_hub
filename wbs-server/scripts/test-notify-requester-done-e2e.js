/**
 * 导出人通知业务方 + 发数据 e2e 烟雾测试（2026-05-29，方案 v1.1）
 *
 * 覆盖 notify-requester-done endpoint 的守卫/状态/范围/附件/路径校验 +
 *   notify-read-status?recipient=requester_done 已读分支 + 24h 窗口。
 *
 * 钉钉策略（同 test-admin-direct-e2e）：本地无真钉钉环境，三步发送会失败——
 *   故本脚本聚焦"钉钉调用【之前】的守卫逻辑"（权限/状态/范围/附件/路径，T2-T8）+
 *   已读跟踪分支（用 setCollabState 直接造 done_* 状态，T11-T14）。
 *   三步全成功（T1）/ 部分失败矩阵 done_* 不落（T9）需真钉钉环境或浏览器实测验证。
 *
 * 运行：先起服务（node server.js），再 node scripts/test-notify-requester-done-e2e.js
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const createdFixtureIds = [];

async function createAdminDirect(token, exporterId, oaNo, { requesterPhone = '13800001111' } = {}) {
    // admin 直派模式：只传 exporter_user_id（与 contact_person_id 二选一，v1.72.3 CONFLICTING_ASSIGN_MODE）
    // 2026-06-09 codex 78 收件人修复：收件人=业务方负责人（requester_phone 反查钉钉），
    //   fixture 默认带假手机号让用例走过 phone 空判（fail-fast 在附件检查之前）；
    //   测 REQUESTER_PHONE_EMPTY 分支时显式传 requesterPhone: null
    return fx.apiCall('POST', '/api/collab/requests', token, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'notify-requester-test',
        requester_phone: requesterPhone,
        description: '导出通知业务方 e2e 测试单',
        deadline: '2026-12-31 18:00:00',
        exporter_user_id: exporterId,
        target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
}

async function notifyRequesterDone(token, id) {
    return fx.apiCall('POST', `/api/collab/requests/${id}/notify-requester-done`, token, {});
}

async function readStatus(token, id, recipient) {
    return fx.apiCall('GET', `/api/collab/requests/${id}/notify-read-status?recipient=${recipient}`, token);
}

async function getCollab(id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(fx.DB_PATH);
        db.get('SELECT * FROM collab_requests WHERE id=?', [id], (err, row) => {
            db.close(); err ? reject(err) : resolve(row);
        });
    });
}

// 造一条 admin_direct + DONE + 有效 exporter + result_data active 附件的测试单
async function makeDoneDirectFixture(adminToken, oaNo, { withActiveResultData = true, contactId = fx.CONTACT_ID, requesterPhone } = {}) {
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, oaNo,
        requesterPhone === undefined ? {} : { requesterPhone });
    if (cr.status !== 200) throw new Error(`create 失败 ${cr.status} ${JSON.stringify(cr.body)}`);
    const id = cr.body.id;
    createdFixtureIds.push(id);
    // 推进到 DONE（admin_direct 创建已是 EXPORTING + exporter_user_id 已设）
    await fx.setCollabState(id, { status: 'DONE', contact_person_id: contactId });
    if (withActiveResultData) {
        // 造一条 active result_data 附件（xlsx）
        await new Promise((resolve, reject) => {
            const db = new sqlite3.Database(fx.DB_PATH);
            db.run(
                `INSERT INTO collab_attachments
                    (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status)
                 VALUES (?, 'result_data', ?, ?, ?, ?, 'active')`,
                [id, `collab/_e2e/${id}_result.xlsx`, '测试数据.xlsx', fx.EXPORTER_ID, 'exporter', ],
                (err) => { db.close(); err ? reject(err) : resolve(); }
            );
        });
    }
    return id;
}

const tests = [];
function defTest(name, fn) { tests.push({ name, fn }); }

// ============================================================
// T2：权限——非本单 exporter 点 → 403 NOT_OWN_EXPORTER
// ============================================================
defTest('T2: 非本单 exporter 通知 → 403 NOT_OWN_EXPORTER', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T2_${Date.now()}`);
    // VIEWER2（示例客服B，非本单 exporter，也非 admin）
    const otherToken = await fx.signAs(fx.VIEWER2_ID);
    const res = await notifyRequesterDone(otherToken, id);
    if (res.status !== 403 || res.body.code !== 'NOT_OWN_EXPORTER') {
        throw new Error(`expected 403 NOT_OWN_EXPORTER, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T3：权限——admin 代发放行（走到钉钉前不报 403/409）
// ============================================================
defTest('T3: admin 代发放行 → 走过守卫到附件物理检查 409 RESULT_DATA_FILE_MISSING', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T3_${Date.now()}`);
    const res = await notifyRequesterDone(adminToken, id);
    // M-1 白名单断言（不用排除式假绿）：admin 走过权限/状态/范围/附件唯一/扩展名守卫后，
    //   因 fixture 是假路径（物理文件不存在）必返 409 RESULT_DATA_FILE_MISSING——
    //   这个确定终态既证明 admin 放行，又顺带覆盖 M-3 的 RESULT_DATA_FILE_MISSING 分支
    if (res.status !== 409 || res.body.code !== 'RESULT_DATA_FILE_MISSING') {
        throw new Error(`expected 409 RESULT_DATA_FILE_MISSING (admin 放行+假路径), got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T4：状态——非 DONE → 409 INVALID_STATE_FOR_NOTIFY
// ============================================================
defTest('T4: 非 DONE 状态通知 → 409 INVALID_STATE_FOR_NOTIFY', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const cr = await createAdminDirect(adminToken, fx.EXPORTER_ID, `OA_NRD_T4_${Date.now()}`);
    // L-1：先断言 create 成功，失败时报错聚焦（区分 fixture 失败 vs 待测接口失败）
    if (cr.status !== 200 || !cr.body.id) throw new Error(`fixture create 失败 ${cr.status} ${JSON.stringify(cr.body)}`);
    createdFixtureIds.push(cr.body.id);
    // 创建后是 EXPORTING，不推进 DONE
    const res = await notifyRequesterDone(adminToken, cr.body.id);
    if (res.status !== 409 || res.body.code !== 'INVALID_STATE_FOR_NOTIFY') {
        throw new Error(`expected 409 INVALID_STATE_FOR_NOTIFY, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T5：范围——normal 路径放行（2026-06-09 codex 78：不再限定 admin_direct，
//   normal forward 单 DONE + 有效 exporter + 有 phone → 走到附件物理检查）
// ============================================================
defTest('T5: normal 路径通知放行 → 走过范围守卫到 409 RESULT_DATA_FILE_MISSING', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T5_${Date.now()}`);
    // 改成 normal 路径（模拟 forward 产生 exporter 的 normal 单 DONE）
    await fx.setCollabState(id, { assign_mode: 'normal' });
    const res = await notifyRequesterDone(adminToken, id);
    // 白名单断言（同 T3 模式）：放行后因 fixture 假路径必停在物理检查——证明范围已放开
    if (res.status !== 409 || res.body.code !== 'RESULT_DATA_FILE_MISSING') {
        throw new Error(`expected 409 RESULT_DATA_FILE_MISSING (normal 放行+假路径), got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T5b：权限——exporter_user_id=0 占位 + 非 admin → 403 NOT_OWN_EXPORTER
//   （范围守卫已删，hasValidExporter 仍在权限守卫起作用：占位单非 admin 无人可发）
// ============================================================
defTest('T5b: exporter_user_id=0 占位 + 非 admin → 403 NOT_OWN_EXPORTER', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T5b_${Date.now()}`);
    await fx.setCollabState(id, { exporter_user_id: 0 });
    // 用原 exporter 用户调（exporter_user_id 已被清 0，hasValidExporter=false → 403）
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);
    const res = await notifyRequesterDone(exporterToken, id);
    if (res.status !== 403 || res.body.code !== 'NOT_OWN_EXPORTER') {
        throw new Error(`expected 403 NOT_OWN_EXPORTER (占位值非 admin), got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T5c：范围——exporter_user_id=0 占位 + admin → 409 NOT_EXPORTER_PATH
//   （codex 79 H-1：范围硬守卫，admin 也不能对无有效 exporter 的 DONE 单发送）
// ============================================================
defTest('T5c: exporter_user_id=0 占位 + admin → 409 NOT_EXPORTER_PATH', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T5c_${Date.now()}`);
    await fx.setCollabState(id, { exporter_user_id: 0 });
    const res = await notifyRequesterDone(adminToken, id);
    if (res.status !== 409 || res.body.code !== 'NOT_EXPORTER_PATH') {
        throw new Error(`expected 409 NOT_EXPORTER_PATH (admin+占位值被范围守卫拦), got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T6：业务方负责人手机号空 → 400 REQUESTER_PHONE_EMPTY
//   （2026-06-09 codex 78：收件人=requester_phone 反查；原 contact_person 无钉钉
//    REQUESTER_NO_DINGTALK 分支已删除——不再读 contact_person）
// ============================================================
defTest('T6: requester_phone 空 → 400 REQUESTER_PHONE_EMPTY', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T6_${Date.now()}`, { requesterPhone: null });
    const res = await notifyRequesterDone(adminToken, id);
    if (res.status !== 400 || res.body.code !== 'REQUESTER_PHONE_EMPTY') {
        throw new Error(`expected 400 REQUESTER_PHONE_EMPTY, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T7：result_data 0 个 active → 409 RESULT_DATA_MISSING
// ============================================================
defTest('T7: 无 active result_data → 409 RESULT_DATA_MISSING', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T7_${Date.now()}`, { withActiveResultData: false });
    const res = await notifyRequesterDone(adminToken, id);
    if (res.status !== 409 || res.body.code !== 'RESULT_DATA_MISSING') {
        throw new Error(`expected 409 RESULT_DATA_MISSING, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T8：result_data 多个 active → 409 RESULT_DATA_AMBIGUOUS
// ============================================================
defTest('T8: 多个 active result_data → 409 RESULT_DATA_AMBIGUOUS', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T8_${Date.now()}`);
    // 再插一条 active result_data
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(fx.DB_PATH);
        db.run(
            `INSERT INTO collab_attachments
                (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status)
             VALUES (?, 'result_data', ?, ?, ?, ?, 'active')`,
            [id, `collab/_e2e/${id}_result2.xlsx`, '测试数据2.xlsx', fx.EXPORTER_ID, 'exporter'],
            (err) => { db.close(); err ? reject(err) : resolve(); }
        );
    });
    const res = await notifyRequesterDone(adminToken, id);
    if (res.status !== 409 || res.body.code !== 'RESULT_DATA_AMBIGUOUS') {
        throw new Error(`expected 409 RESULT_DATA_AMBIGUOUS, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T8b：result_data 非 xlsx → 409 RESULT_DATA_NOT_XLSX（codex 54 M-2）
// ============================================================
defTest('T8b: result_data 非 xlsx → 409 RESULT_DATA_NOT_XLSX', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T8b_${Date.now()}`, { withActiveResultData: false });
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(fx.DB_PATH);
        db.run(
            `INSERT INTO collab_attachments
                (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status)
             VALUES (?, 'result_data', ?, ?, ?, ?, 'active')`,
            [id, `collab/_e2e/${id}_result.csv`, '测试数据.csv', fx.EXPORTER_ID, 'exporter'],
            (err) => { db.close(); err ? reject(err) : resolve(); }
        );
    });
    const res = await notifyRequesterDone(adminToken, id);
    if (res.status !== 409 || res.body.code !== 'RESULT_DATA_NOT_XLSX') {
        throw new Error(`expected 409 RESULT_DATA_NOT_XLSX, got ${res.status} ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T11：已读跟踪——造 done_notify_message_key + done_read_at 已固化 → read:true 直接返回
// ============================================================
defTest('T11: done_read_at 已固化 → notify-read-status 返 read:true cached', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T11_${Date.now()}`);
    await fx.setCollabState(id, {
        done_notified_at: '2026-05-29 10:00:00',
        done_notify_message_key: 'e2e_fake_key_t11',
        done_read_at: '2026-05-29 10:30:00'
    });
    const res = await readStatus(adminToken, id, 'requester_done');
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.read !== true) throw new Error(`expected read:true, got ${JSON.stringify(res.body)}`);
    if (!res.body.cached) throw new Error(`expected cached:true (固化值直接返回), got ${JSON.stringify(res.body)}`);
});

// ============================================================
// T12：24h 窗口——done_notified_at 超 24h 未固化 read_at → unread_expired（codex 53 M-2）
// ============================================================
defTest('T12: 通知超 24h 未读 → read_status=unread_expired', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T12_${Date.now()}`);
    // 造 25 小时前的通知 + 有 message_key（过 message_key 校验）+ read_at 未固化
    const past = new Date(Date.now() - 25 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const pastStr = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())} ${pad(past.getHours())}:${pad(past.getMinutes())}:${pad(past.getSeconds())}`;
    await fx.setCollabState(id, {
        done_notified_at: pastStr,
        done_notify_message_key: 'e2e_fake_key_t12',
        done_read_at: null
    });
    const res = await readStatus(adminToken, id, 'requester_done');
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.read_status !== 'unread_expired') {
        throw new Error(`expected read_status=unread_expired, got ${JSON.stringify(res.body)}`);
    }
});

// ============================================================
// T12b：未通知（done_notified_at 为 NULL）→ 400 尚未通知
// ============================================================
defTest('T12b: done_notified_at 为 NULL → 400 尚未通知', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T12b_${Date.now()}`);
    const res = await readStatus(adminToken, id, 'requester_done');
    if (res.status !== 400) throw new Error(`expected 400 (尚未通知), got ${res.status} ${JSON.stringify(res.body)}`);
});

// ============================================================
// T17：回归——recipient 非法值 → 400
// ============================================================
defTest('T17: notify-read-status recipient 非法值 → 400', async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const id = await makeDoneDirectFixture(adminToken, `OA_NRD_T17_${Date.now()}`);
    const res = await readStatus(adminToken, id, 'bogus_recipient');
    if (res.status !== 400) throw new Error(`expected 400 (非法 recipient), got ${res.status} ${JSON.stringify(res.body)}`);
});

// ============================================================
// 主流程
// ============================================================
(async () => {
    console.log('=== 导出通知业务方 notify-requester-done e2e 烟雾测试 ===');
    console.log('（钉钉三步成功路径 T1 / 部分失败 T9 需真钉钉或浏览器实测，本脚本测守卫/状态/范围/附件/已读分支）\n');
    let passed = 0, failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✅ ${t.name}`);
            passed++;
        } catch (e) {
            console.error(`❌ ${t.name}`);
            console.error(`   ${e.message}`);
            failed++;
        }
    }
    console.log(`\n清理 ${createdFixtureIds.length} 条测试 fixture...`);
    for (const id of createdFixtureIds) {
        try { await fx.cleanup(id); } catch (e) { /* ignore */ }
    }
    console.log(`\n结果：${passed} passed / ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
