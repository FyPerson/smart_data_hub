// 验证脚本：取数交付质量记录 v3.0 Commit D — 打回开发 return-quality
// 用法：node scripts/verify-return-quality.js
// 模式：临时内存 sqlite 复刻 collab_requests（精简）+ collab_return_record + operation_logs，
//   直接测 transitionToDevPending 骨架函数 + 模拟 endpoint 的 extraWrites（return_record + log 同事务）。
//   HTTP 层权限校验（authenticateToken/contact_person）留给 e2e/浏览器实测，本脚本测核心状态机/事务/乐观锁。
//
// 覆盖开发计划 D 验证矩阵 + 用户 3 决策：
//   - DONE → PENDING 转换成功 + return_record + log 同事务写入
//   - EXPORTING 源状态拒绝（fromStatus 收紧，不接受三级转发状态）
//   - 乐观锁 submission_version：版本不符拒（changes=0 STALE_STATE）
//   - 重复打回：第二次状态已 PENDING → changes=0 拒（防重复计返工 M-5）
//   - 同事务回滚：extraWrites 抛错 → status 不变 + return_record 不写（原子 M-4）
//   - archived 双轨守卫拦截
//   - 4 reason_type 各自写库 + 仅 DEV_QUALITY is_rework=1（M-5）
//   - extraGuards 参数错位自检：IS NULL 守卫不 push undefined
const assert = require('assert');
const sqlite3 = require('sqlite3');
const { transitionToDevPending } = require('../utils/collab-submit-helpers');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const get = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbAsync = { runAsync: run };

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 精简 collab_requests（仅 D 用到的列）
const DDL_REQ = `CREATE TABLE collab_requests (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    submission_version INTEGER DEFAULT 0,
    contact_person_id INTEGER,
    archived_at TEXT,
    archived_final_at TEXT,
    done_at TEXT,
    sql_validated_at TEXT,
    sql_validation_status TEXT,
    sql_validation_error TEXT
)`;
const DDL_RETURN = `CREATE TABLE collab_return_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    collab_sub_item_id INTEGER,
    submission_seq INTEGER,
    returned_by INTEGER NOT NULL,
    returned_by_name TEXT NOT NULL,
    reason_type TEXT NOT NULL
        CHECK (reason_type IN ('DEV_QUALITY','REQ_CHANGE','ENV_ISSUE','BIZ_ADJUST')),
    reason_note TEXT,
    status_before TEXT,
    status_after TEXT,
    returned_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const DDL_LOG = `CREATE TABLE collab_operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collab_request_id INTEGER NOT NULL,
    operation_type TEXT NOT NULL,
    operator_id INTEGER NOT NULL,
    operator TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`;

// 模拟 endpoint 的 extraWrites（插 return_record + log，与 server.js 一致）
function makeExtraWrites(id, seq, userId, userName, reasonType, reasonNote) {
    return async (dbA) => {
        await dbA.runAsync(
            `INSERT INTO collab_return_record
                (collab_request_id, collab_sub_item_id, submission_seq,
                 returned_by, returned_by_name, reason_type, reason_note, status_before, status_after)
             VALUES (?, NULL, ?, ?, ?, ?, ?, 'DONE', 'PENDING')`,
            [id, seq, userId, userName, reasonType, reasonNote]
        );
        await dbA.runAsync(
            `INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason)
             VALUES (?, 'RETURN_QUALITY', ?, ?, ?)`,
            [id, userId, userName, JSON.stringify({ reason_type: reasonType, submission_seq: seq, is_rework: reasonType === 'DEV_QUALITY' })]
        );
    };
}

// 标准 extraGuards（与 endpoint 一致）
function guards(seq) {
    return [
        { sql: 'submission_version = ?', value: seq },
        { sql: 'archived_at IS NULL' },
        { sql: 'archived_final_at IS NULL' },
    ];
}

async function seedReq(id, { status = 'DONE', seq = 1, contact = 5, archived = null, finalArchived = null, doneAt = null } = {}) {
    await run('DELETE FROM collab_requests WHERE id=?', [id]);
    await run(`INSERT INTO collab_requests (id, status, submission_version, contact_person_id, archived_at, archived_final_at, done_at, sql_validated_at, sql_validation_status)
               VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, status, seq, contact, archived, finalArchived, doneAt, doneAt, doneAt ? 'passed' : null]);
}

async function main() {
    await run(DDL_REQ);
    await run(DDL_RETURN);
    await run(DDL_LOG);
    ok('内存库建表（collab_requests 精简 + return_record + operation_logs）');

    console.log('\n[核心状态转换 + 同事务写入]');

    // [1] DONE → PENDING + return_record + log 同事务
    {
        const id = 201;
        await seedReq(id, { status: 'DONE', seq: 2 });
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(2),
            extraWrites: makeExtraWrites(id, 2, 5, '示例用户A', 'DEV_QUALITY', '字段算错'),
        });
        assert.strictEqual(r.ok, true, '应转换成功');
        const req = await get('SELECT status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(req.status, 'PENDING', '状态应 PENDING');
        const rr = await get('SELECT * FROM collab_return_record WHERE collab_request_id=?', [id]);
        assert.strictEqual(rr.reason_type, 'DEV_QUALITY');
        assert.strictEqual(rr.submission_seq, 2, 'submission_seq 应=被打回版本');
        assert.strictEqual(rr.status_before, 'DONE');
        assert.strictEqual(rr.status_after, 'PENDING');
        const lg = await get(`SELECT * FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='RETURN_QUALITY'`, [id]);
        assert.ok(lg, 'operation_log 应写入');
        assert.ok(/"is_rework":true/.test(lg.reason), 'DEV_QUALITY 应 is_rework=true');
        ok('DONE→PENDING + return_record + log 同事务写入 / submission_seq 对齐 / 状态快照');
    }

    console.log('\n[源状态 + 乐观锁守卫]');

    // [2] EXPORTING 源状态拒绝（不接受三级转发状态）
    {
        const id = 202;
        await seedReq(id, { status: 'EXPORTING', seq: 1 });
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
            extraWrites: makeExtraWrites(id, 1, 5, '示例用户A', 'REQ_CHANGE', null),
        });
        assert.strictEqual(r.ok, false, 'EXPORTING 不应被 DONE 转换命中');
        assert.strictEqual(r.code, 'STALE_STATE');
        const req = await get('SELECT status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(req.status, 'EXPORTING', '状态应不变（EXPORTING 是三级转发链路）');
        const cnt = await get('SELECT COUNT(*) c FROM collab_return_record WHERE collab_request_id=?', [id]);
        assert.strictEqual(cnt.c, 0, '未命中不写 return_record');
        ok('EXPORTING 源状态 → STALE_STATE 拒 / 状态不变 / 不写 return_record（不碰三级转发链路）');
    }

    // [3] 乐观锁：submission_version 不符拒
    {
        const id = 203;
        await seedReq(id, { status: 'DONE', seq: 5 });
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(3),  // 传错版本 3≠5
            extraWrites: makeExtraWrites(id, 3, 5, '示例用户A', 'DEV_QUALITY', null),
        });
        assert.strictEqual(r.ok, false, '版本不符应拒');
        assert.strictEqual(r.code, 'STALE_STATE');
        const req = await get('SELECT status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(req.status, 'DONE', '状态应不变');
        ok('乐观锁 submission_version 不符 → STALE_STATE 拒 / 状态不变');
    }

    // [4] 重复打回：第二次状态已 PENDING → 拒（防重复计返工 M-5）
    {
        const id = 204;
        await seedReq(id, { status: 'DONE', seq: 1 });
        const args = {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
            extraWrites: makeExtraWrites(id, 1, 5, '示例用户A', 'DEV_QUALITY', null),
        };
        const r1 = await transitionToDevPending(dbAsync, args);
        assert.strictEqual(r1.ok, true, '首次打回成功');
        const r2 = await transitionToDevPending(dbAsync, args);  // 重复点击
        assert.strictEqual(r2.ok, false, '二次状态已 PENDING 应拒');
        assert.strictEqual(r2.code, 'STALE_STATE');
        const cnt = await get('SELECT COUNT(*) c FROM collab_return_record WHERE collab_request_id=?', [id]);
        assert.strictEqual(cnt.c, 1, '只 1 条 return_record（防重复计返工）');
        ok('重复打回 → 二次拒 / 只 1 条 return_record（防重复计返工 M-5）');
    }

    console.log('\n[同事务回滚原子性 + archived 守卫]');

    // [5] extraWrites 抛错 → 整事务回滚（status 不变 + return_record 不写）
    {
        const id = 205;
        await seedReq(id, { status: 'DONE', seq: 1 });
        let threw = false;
        try {
            await transitionToDevPending(dbAsync, {
                requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
                extraWrites: async () => { throw new Error('mock return_record 写爆'); },
            });
        } catch (e) { threw = true; }
        assert.strictEqual(threw, true, 'extraWrites 抛错应向上抛（调用方返 500）');
        const req = await get('SELECT status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(req.status, 'DONE', 'UPDATE 应被 ROLLBACK（状态不变）');
        const cnt = await get('SELECT COUNT(*) c FROM collab_return_record WHERE collab_request_id=?', [id]);
        assert.strictEqual(cnt.c, 0, 'return_record 不写');
        ok('extraWrites 抛错 → 整事务 ROLLBACK / status 不变 / return_record 不写（原子 M-4）');
    }

    // [6] archived_at 守卫拦截（软删除单不可打回）
    {
        const id = 206;
        await seedReq(id, { status: 'DONE', seq: 1, archived: '2026-06-08 10:00:00' });
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
            extraWrites: makeExtraWrites(id, 1, 5, '示例用户A', 'DEV_QUALITY', null),
        });
        assert.strictEqual(r.ok, false, 'archived 单应被守卫拦');
        ok('archived_at 非空 → STALE_STATE 拒（archived 双轨守卫，无占位符参数不错位）');
    }

    console.log('\n[4 reason_type + 返工口径]');

    // [7] 4 reason_type 各自写库 + 仅 DEV_QUALITY is_rework
    {
        const types = ['DEV_QUALITY', 'REQ_CHANGE', 'ENV_ISSUE', 'BIZ_ADJUST'];
        for (let i = 0; i < types.length; i++) {
            const id = 210 + i;
            await seedReq(id, { status: 'DONE', seq: 1 });
            await transitionToDevPending(dbAsync, {
                requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
                extraWrites: makeExtraWrites(id, 1, 5, '示例用户A', types[i], null),
            });
            const rr = await get('SELECT reason_type FROM collab_return_record WHERE collab_request_id=?', [id]);
            assert.strictEqual(rr.reason_type, types[i], `${types[i]} 应写库`);
        }
        // 仅 DEV_QUALITY 算返工
        const reworkCnt = await get(`SELECT COUNT(*) c FROM collab_return_record WHERE reason_type='DEV_QUALITY' AND collab_request_id IN (210,211,212,213)`);
        assert.strictEqual(reworkCnt.c, 1, '4 类中仅 1 条 DEV_QUALITY 计返工');
        ok('4 reason_type 各自写库 / 仅 DEV_QUALITY 计返工（M-5 聚合口径）');
    }

    // [8] extraGuards 参数错位自检：IS NULL 守卫不 push undefined（已在上面间接验证，这里显式确认 SQL 正确）
    {
        const id = 220;
        await seedReq(id, { status: 'DONE', seq: 7 });
        // 同时带占位符守卫（seq=7）+ 两个无占位符守卫，验证参数不错位（若错位 seq 会绑到 IS NULL 位置导致匹配失败）
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(7),
            extraWrites: makeExtraWrites(id, 7, 5, '示例用户A', 'ENV_ISSUE', null),
        });
        assert.strictEqual(r.ok, true, '混合占位符/无占位符守卫应正确匹配（参数不错位）');
        ok('extraGuards 混合（带?守卫 + IS NULL 守卫）参数不错位 → 正确命中');
    }

    console.log('\n[骨架 fail-fast 入参/守卫校验（codex 74 M-2/L-1）]');

    // [9] extraGuards 含 ? 但缺 value → 抛 INVALID_GUARD_PARAM（不伪装成 changes=0 并发）
    {
        const id = 230;
        await seedReq(id, { status: 'DONE', seq: 1 });
        let code = null;
        try {
            await transitionToDevPending(dbAsync, {
                requestId: id, fromStatus: 'DONE',
                extraGuards: [{ sql: 'submission_version = ?' }],  // 含 ? 但漏 value
                extraWrites: async () => {},
            });
        } catch (e) { code = e.code; }
        assert.strictEqual(code, 'INVALID_GUARD_PARAM', '含?缺value 应抛 INVALID_GUARD_PARAM');
        const req = await get('SELECT status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(req.status, 'DONE', '抛错前不应改状态（fail-fast 在拼 WHERE 阶段）');
        ok('extraGuards 含?缺value → 抛 INVALID_GUARD_PARAM（开发错误不伪装成并发冲突 M-2）');
    }

    // [10] extraGuards 不含 ? 却给 value → 抛 INVALID_GUARD_PARAM（防静默忽略）
    {
        let code = null;
        try {
            await transitionToDevPending(dbAsync, {
                requestId: 231, fromStatus: 'DONE',
                extraGuards: [{ sql: 'archived_at IS NULL', value: 'oops' }],  // 不含? 却传 value
                extraWrites: async () => {},
            });
        } catch (e) { code = e.code; }
        assert.strictEqual(code, 'INVALID_GUARD_PARAM', '不含?却给value 应抛 INVALID_GUARD_PARAM');
        ok('extraGuards 不含?却给value → 抛 INVALID_GUARD_PARAM（防静默忽略 M-2）');
    }

    // [11] 入参断言：requestId 非正整数 / fromStatus 空 → fail fast（L-1）
    {
        let c1 = null, c2 = null, c3 = null;
        try { await transitionToDevPending(dbAsync, { requestId: 0, fromStatus: 'DONE' }); } catch (e) { c1 = e.code; }
        try { await transitionToDevPending(dbAsync, { requestId: 1, fromStatus: '' }); } catch (e) { c2 = e.code; }
        try { await transitionToDevPending(dbAsync, { requestId: 1, fromStatus: 'DONE', extraGuards: [{ sql: '' }] }); } catch (e) { c3 = e.code; }
        assert.strictEqual(c1, 'INVALID_REQUEST_ID', 'requestId=0 应抛 INVALID_REQUEST_ID');
        assert.strictEqual(c2, 'INVALID_FROM_STATUS', 'fromStatus 空 应抛 INVALID_FROM_STATUS');
        assert.strictEqual(c3, 'INVALID_GUARD', 'guard.sql 空 应抛 INVALID_GUARD');
        ok('入参断言 fail fast：requestId/fromStatus/guard.sql 非法各自抛对应 code（L-1）');
    }

    console.log('\n[clearFields：DONE→PENDING 清已完成痕迹（codex 76 H-1 衍生）]');

    // [12] clearFields 清 done_at/sql_validated_at（DONE 打回后不残留旧完成时间）
    {
        const id = 240;
        await seedReq(id, { status: 'DONE', seq: 1, doneAt: '2026-06-08 12:00:00' });
        const before = await get('SELECT done_at, sql_validated_at, sql_validation_status FROM collab_requests WHERE id=?', [id]);
        assert.ok(before.done_at && before.sql_validated_at, '前置：DONE 单应有 done_at/sql_validated_at');
        const r = await transitionToDevPending(dbAsync, {
            requestId: id, fromStatus: 'DONE', extraGuards: guards(1),
            clearFields: ['done_at', 'sql_validated_at', 'sql_validation_status', 'sql_validation_error'],
            extraWrites: makeExtraWrites(id, 1, 5, '示例用户A', 'DEV_QUALITY', null),
        });
        assert.strictEqual(r.ok, true);
        const after = await get('SELECT status, done_at, sql_validated_at, sql_validation_status FROM collab_requests WHERE id=?', [id]);
        assert.strictEqual(after.status, 'PENDING');
        assert.strictEqual(after.done_at, null, 'done_at 应清空');
        assert.strictEqual(after.sql_validated_at, null, 'sql_validated_at 应清空');
        assert.strictEqual(after.sql_validation_status, null, 'sql_validation_status 应清空');
        ok('DONE→PENDING 清 done_at/sql_validated_at/sql_validation_status（不残留旧完成痕迹）');
    }

    // [13] clearFields 白名单防注入：非白名单字段抛 INVALID_CLEAR_FIELD
    {
        let code = null;
        try {
            await transitionToDevPending(dbAsync, {
                requestId: 241, fromStatus: 'DONE', extraGuards: guards(1),
                clearFields: ['status'],  // status 不在白名单（且改 status 会破坏语义）
                extraWrites: async () => {},
            });
        } catch (e) { code = e.code; }
        assert.strictEqual(code, 'INVALID_CLEAR_FIELD', '非白名单 clearField 应抛 INVALID_CLEAR_FIELD');
        ok('clearFields 白名单防注入：非白名单字段抛 INVALID_CLEAR_FIELD');
    }

    console.log(`\n✅ 全部通过：${passed} 项`);
}

main()
    .then(() => { db.close(); process.exit(0); })
    .catch(e => { console.error('❌ 验证失败：', e.message, '\n', e.stack); db.close(); process.exit(1); });
