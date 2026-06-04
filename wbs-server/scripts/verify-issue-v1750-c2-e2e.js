/**
 * v1.75.0 commit B — C2 改人守卫 + migration 真实 sqlite 端到端验证（对齐 v1.74.5 真实 db 端到端范式）
 *
 * 用法：node scripts/verify-issue-v1750-c2-e2e.js（自建临时 db，跑完即删，不碰生产 task_pool.db）
 *
 * 覆盖（真实 sqlite3 + 真实 ALTER/事务，验证纯函数镜像之外的"真实落库 + 事务原子性"）：
 *   M1 migration 幂等：重复跑 ALTER 不报错（duplicate column 忽略）+ PRAGMA 复查列到位
 *   C2-1 改派+已通知 → 重置 notify_*（sent→not_sent）+ 系统评论落库（is_system=1）+ pending 被清
 *   C2-2 改派+未通知 → notify_status 不动 + pending_reassign 被写 + 无系统评论
 *   C2-3 首派 → 仅设 assigned_to + 无系统评论 + notify 保持 not_sent
 *   C2-4 事务原子性：系统评论 INSERT 与 issues UPDATE 同事务（构造 INSERT 失败 → UPDATE 回滚）
 *
 * ⚠️ 安全：临时 db 文件建在 os.tmpdir()，绝不连生产 task_pool.db；finally 删临时文件。
 */
'use strict';

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `issue_v1750_e2e_${process.pid}.db`);

let pass = 0, fail = 0;
function check(name, cond, msg) {
    if (cond) { console.log('  ✅ ' + name); pass++; }
    else { console.log('  ❌ ' + name + (msg ? ' — ' + msg : '')); fail++; }
}

const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
const all = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
const cols = (db, t) => all(db, `PRAGMA table_info("${t}")`).then(rs => rs.map(r => r.name));

// 镜像 server.js runIssueV1750Migration 的 ALTER 列表（幂等）
async function migrate(db) {
    const alters = [
        ['issues', 'dingtalk_chat_id', 'TEXT'],
        ['issues', 'dingtalk_open_conversation_id', 'TEXT'],
        ['issues', 'dingtalk_chat_created_at', 'DATETIME'],
        ['issues', 'dingtalk_chat_created_by', 'INTEGER'],
        ['issues', 'dingtalk_chat_name', 'TEXT'],
        ['issue_comments', 'is_system', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [t, c, ty] of alters) {
        try { await run(db, `ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`); }
        catch (e) { if (!/duplicate column name/.test(e.message)) throw e; }
    }
}

// 镜像 server.js C2 "改派+已通知" 重置事务
async function c2ResetTx(db, id, newId, newName, operatorId, oldName) {
    const sysComment = `🔄【系统】负责人由「${oldName}」改为「${newName}」，原通知已失效，请重新通知新负责人。`;
    await run(db, 'BEGIN IMMEDIATE');
    try {
        await run(db, `UPDATE issues SET assigned_to=?, assigned_to_name=?,
            notify_status='not_sent', notified_at=NULL, notify_message_key=NULL, read_at=NULL, notify_error=NULL,
            pending_reassign_from_id=NULL, pending_reassign_from_name=NULL,
            pending_reassign_to_id=NULL, pending_reassign_to_name=NULL,
            reassigned_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`,
            [newId, newName, id]);
        await run(db, `INSERT INTO issue_comments (issue_id, user_id, user_name, content, is_system) VALUES (?,?,?,?,1)`,
            [id, operatorId, '系统', sysComment]);
        await run(db, 'COMMIT');
    } catch (e) { try { await run(db, 'ROLLBACK'); } catch (_) {} throw e; }
}

async function main() {
    console.log('\n══════ v1.75.0 commit B — C2 + migration 真实 sqlite 端到端 ══════');
    if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
    const db = new sqlite3.Database(TMP_DB);
    try {
        // 建最小 issues / issue_comments（不含 v1.75.0 列，模拟旧表）
        await run(db, `CREATE TABLE issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, assigned_to INTEGER, assigned_to_name TEXT,
            notify_status TEXT NOT NULL DEFAULT 'not_sent', notified_at DATETIME, notify_message_key TEXT,
            notify_error TEXT, read_at DATETIME, requester_notify_status TEXT DEFAULT 'not_sent', requester_read_at DATETIME,
            pending_reassign_from_id INTEGER, pending_reassign_from_name TEXT,
            pending_reassign_to_id INTEGER, pending_reassign_to_name TEXT, reassigned_at DATETIME,
            updated_at DATETIME )`);
        await run(db, `CREATE TABLE issue_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')) )`);

        // ── M1 migration 幂等 ──
        await migrate(db);
        await migrate(db);  // 第二次：duplicate column 应被忽略，不抛
        const ic = await cols(db, 'issues');
        const cc = await cols(db, 'issue_comments');
        check('M1a migration 跑两次不报错（幂等）', true);
        check('M1b issues 5 新列到位', ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'].every(c => ic.includes(c)), `实际列：${ic.join(',')}`);
        check('M1c issue_comments is_system 到位', cc.includes('is_system'));
        // is_system DEFAULT 0 验证：插普通评论不带 is_system → 应为 0（用 issue_id=99 隔离，不污染后续 C2-1 的 issue_id=1）
        await run(db, `INSERT INTO issue_comments (issue_id,user_id,user_name,content) VALUES (99,1,'u','普通评论')`);
        const plain = await get(db, `SELECT is_system FROM issue_comments WHERE issue_id=99`);
        check('M1d 普通评论 is_system 默认 0', plain && Number(plain.is_system) === 0, `实际 ${plain && plain.is_system}`);

        // ── C2-1 改派+已通知 → 重置 + 系统评论 + 清 pending ──
        await run(db, `INSERT INTO issues (id,title,assigned_to,assigned_to_name,notify_status,notified_at,notify_message_key,read_at,
            pending_reassign_from_id,pending_reassign_to_id) VALUES (1,'单A',3,'张三','sent','2026-06-03 10:00','mk_123','2026-06-03 10:05',2,3)`);
        await c2ResetTx(db, 1, 5, '李四', 9, '张三');
        const a1 = await get(db, `SELECT assigned_to,assigned_to_name,notify_status,notified_at,notify_message_key,read_at,notify_error,
            pending_reassign_from_id,pending_reassign_to_id,requester_notify_status FROM issues WHERE id=1`);
        check('C2-1a 新负责人已更新（assigned_to=5/李四）', Number(a1.assigned_to) === 5 && a1.assigned_to_name === '李四');
        check('C2-1b 开发侧 notify_* 全重置（status=not_sent + 余字段 NULL）',
            a1.notify_status === 'not_sent' && a1.notified_at === null && a1.notify_message_key === null && a1.read_at === null && a1.notify_error === null,
            `实际 status=${a1.notify_status} notified_at=${a1.notified_at} mk=${a1.notify_message_key} read=${a1.read_at}`);
        check('C2-1c pending_reassign_* 被清', a1.pending_reassign_from_id === null && a1.pending_reassign_to_id === null);
        check('C2-1d 业务方 requester_notify_* 未被碰（物理隔离）', a1.requester_notify_status === 'not_sent');
        const sc = await get(db, `SELECT user_id,user_name,content,is_system FROM issue_comments WHERE issue_id=1`);
        check('C2-1e 系统评论落库（is_system=1 + 含原→新姓名）',
            sc && Number(sc.is_system) === 1 && /张三/.test(sc.content) && /李四/.test(sc.content) && sc.user_name === '系统' && Number(sc.user_id) === 9,
            `实际 ${JSON.stringify(sc)}`);

        // ── C2-2 改派+未通知 → 不重置（走 pending 写入逻辑，模拟现有 endpoint）──
        await run(db, `INSERT INTO issues (id,title,assigned_to,assigned_to_name,notify_status) VALUES (2,'单B',3,'张三','not_sent')`);
        // 模拟 pending 分支 UPDATE（不重置 notify_*，写 pending_reassign）
        await run(db, `UPDATE issues SET assigned_to=5,assigned_to_name='李四',
            pending_reassign_from_id=3,pending_reassign_from_name='张三',pending_reassign_to_id=5,pending_reassign_to_name='李四',
            reassigned_at=datetime('now','localtime') WHERE id=2`);
        const a2 = await get(db, `SELECT notify_status,pending_reassign_from_id,pending_reassign_to_id FROM issues WHERE id=2`);
        const sc2 = await get(db, `SELECT COUNT(*) c FROM issue_comments WHERE issue_id=2 AND is_system=1`);
        check('C2-2a 未通知改派：notify_status 不动（仍 not_sent）', a2.notify_status === 'not_sent');
        check('C2-2b 未通知改派：pending_reassign 被写（供 notify-reassign）', Number(a2.pending_reassign_from_id) === 3 && Number(a2.pending_reassign_to_id) === 5);
        check('C2-2c 未通知改派：无系统评论', Number(sc2.c) === 0);

        // ── C2-3 首派 → 仅设 assigned_to，无系统评论 ──
        await run(db, `INSERT INTO issues (id,title,assigned_to,notify_status) VALUES (3,'单C',NULL,'not_sent')`);
        await run(db, `UPDATE issues SET assigned_to=5,assigned_to_name='李四' WHERE id=3`);
        const sc3 = await get(db, `SELECT COUNT(*) c FROM issue_comments WHERE issue_id=3 AND is_system=1`);
        const a3 = await get(db, `SELECT assigned_to,notify_status FROM issues WHERE id=3`);
        check('C2-3a 首派：assigned_to 设置 + notify 保持 not_sent', Number(a3.assigned_to) === 5 && a3.notify_status === 'not_sent');
        check('C2-3b 首派：无系统评论', Number(sc3.c) === 0);

        // ── C2-5 脏状态兜底（codex 39 M-1）：assigned_to=NULL 但 notify_status='sent' → reset 兜底清理 ──
        //   §8 约束②显式兜底：无真实负责人却已通知（不一致脏态）也走 reset 链路，重置 notify_* + 系统评论留痕
        await run(db, `INSERT INTO issues (id,title,assigned_to,assigned_to_name,notify_status,notified_at,notify_message_key)
            VALUES (6,'单脏',NULL,NULL,'sent','2026-06-03 10:00','mk_dirty')`);
        // 模拟 server reset 链路（assigned_to=NULL + sent → needResetGuard=true，fromLabel='未指派'）
        await c2ResetTx(db, 6, 5, '李四', 9, '未指派');
        const a6 = await get(db, `SELECT assigned_to,notify_status,notify_message_key FROM issues WHERE id=6`);
        const sc6 = await get(db, `SELECT content,is_system FROM issue_comments WHERE issue_id=6`);
        check('C2-5a 脏状态兜底：notify_* 被重置（sent→not_sent + message_key 清）',
            a6.notify_status === 'not_sent' && a6.notify_message_key === null);
        check('C2-5b 脏状态兜底：系统评论留痕（含"未指派→李四"+is_system=1）',
            sc6 && Number(sc6.is_system) === 1 && /未指派/.test(sc6.content) && /李四/.test(sc6.content), `实际 ${JSON.stringify(sc6)}`);

        // ── C2-4 事务原子性：系统评论 INSERT 失败 → UPDATE 回滚 ──
        await run(db, `INSERT INTO issues (id,title,assigned_to,assigned_to_name,notify_status) VALUES (4,'单D',3,'张三','sent')`);
        let rolledBack = false;
        await run(db, 'BEGIN IMMEDIATE');
        try {
            await run(db, `UPDATE issues SET assigned_to=5,assigned_to_name='李四',notify_status='not_sent' WHERE id=4`);
            // 故意触发失败：issue_id NOT NULL 约束（传 NULL）
            await run(db, `INSERT INTO issue_comments (issue_id,user_id,user_name,content,is_system) VALUES (NULL,9,'系统','x',1)`);
            await run(db, 'COMMIT');
        } catch (e) { try { await run(db, 'ROLLBACK'); rolledBack = true; } catch (_) {} }
        const a4 = await get(db, `SELECT assigned_to,notify_status FROM issues WHERE id=4`);
        check('C2-4a 系统评论 INSERT 失败触发回滚', rolledBack);
        check('C2-4b 回滚后 UPDATE 未生效（assigned_to 仍=3/notify 仍 sent）',
            Number(a4.assigned_to) === 3 && a4.notify_status === 'sent', `实际 assigned_to=${a4.assigned_to} notify=${a4.notify_status}`);

    } catch (e) {
        console.log('  ❌ 端到端异常：' + e.message);
        fail++;
    } finally {
        await new Promise(r => db.close(r));
        try { if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB); } catch (_) {}
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 v1.75.0 commit B 真实 sqlite 端到端全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
