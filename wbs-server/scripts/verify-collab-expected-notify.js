/**
 * verify-collab-expected-notify.js
 *
 * collab「开发回填预计完成时间 + 建单人通知需求方·预计完成」核心逻辑验证（v1.90.0，方案 §4）
 *
 * 用法：node scripts/verify-collab-expected-notify.js   （自包含，无需启动 server、无需钉钉）
 *
 * 验证策略说明（⚠️ verify 移植局限，已知）：
 *   collab 端点内联在 server.js（非可挂载 router），notify-expected 含外部钉钉 IO，
 *   纯 HTTP e2e 既要起服务又要 mock 钉钉、且 H-1 发送窗口竞态无法靠 HTTP 时序复现。
 *   故本脚本聚焦"SQL 层 + 纯逻辑"正确性（最难靠浏览器实测覆盖的部分）：
 *     - normalizeCollabDatetime 归一化 + 同分钟 unchanged 判定（class #1）
 *     - 四态 helper 的字段不变量（class #7）
 *     - 任何有效变更 → reset 通知态清干净（class #2）
 *     - force_resend sent→failed 清旧 message_key / read_at（class #3）
 *     - phone 空 → no_phone 落 REQUESTER_PHONE_EMPTY（class #4 的落库语义）
 *     - H-1 发送快照守卫：guardDevAt / status 不匹配 → changes=0 不写（class #6 核心）
 *     - ALLOW_PAST_MINUTES=2 边界（v1.3 L-2）
 *   HTTP 层行为（#4 的"先落库再 400"、#5 expected 已读开发 403）由部署前浏览器实测覆盖。
 *
 *   SQL/归一化逻辑是从 server.js 镜像而来（移植，非直接 require——helper 内联未导出）。
 *   末段"漂移哨兵"读 server.js 断言真实 helper + 守卫子句 + RC-M1 failedPersistedOr409 路由仍在，
 *   若有人删了守卫 / 改了 helper，本脚本会失败（缓解镜像与真相源脱节）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        passed++; console.log(`  ✓ ${name}`);
    }).catch((e) => {
        failed++; failures.push({ name, err: e.message });
        console.log(`  ✗ ${name} — ${e.message}`);
    });
}

// ---- in-memory db helpers（sqlite3 异步，对齐生产驱动）----
const db = new sqlite3.Database(':memory:');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (err) { err ? rej(err) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (err, row) => err ? rej(err) : res(row)));

// ---- normalizeCollabDatetime：从 server.js:12184 镜像 ----
function normalizeCollabDatetime(raw) {
    if (raw === undefined || raw === null) return null;
    let dv = String(raw).trim().replace('T', ' ');
    if (!dv) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?$/.exec(dv);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
    const dt = new Date(y, mo - 1, d, h, mi, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
    const p = n => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:00`;
}

// ---- 四态 helper：从 server.js:12203-12232 镜像（含 H-1 守卫；返 changes===1）----
const resetExpectedNotifyNotSent = (id) => run(
    `UPDATE collab_requests SET expected_notify_status='not_sent', expected_notified_at=NULL, expected_notify_message_key=NULL, expected_read_at=NULL, expected_notify_error=NULL WHERE id=?`, [id]);
const setExpectedNotifyNoPhone = (id) => run(
    `UPDATE collab_requests SET expected_notify_status='no_phone', expected_notified_at=NULL, expected_notify_message_key=NULL, expected_read_at=NULL, expected_notify_error='REQUESTER_PHONE_EMPTY' WHERE id=?`, [id]);
const setExpectedNotifyFailed = (id, error, guardDevAt) => run(
    `UPDATE collab_requests SET expected_notify_status='failed', expected_notified_at=NULL, expected_notify_message_key=NULL, expected_read_at=NULL, expected_notify_error=? WHERE id=? AND status='PENDING' AND dev_estimated_at=?`,
    [String(error || 'other'), id, guardDevAt]).then(r => r.changes === 1);
const setExpectedNotifySent = (id, messageKey, guardDevAt) => run(
    `UPDATE collab_requests SET expected_notify_status='sent', expected_notified_at=datetime('now','localtime'), expected_notify_message_key=?, expected_read_at=NULL, expected_notify_error=NULL WHERE id=? AND status='PENDING' AND dev_estimated_at=?`,
    [messageKey, id, guardDevAt]).then(r => r.changes === 1);

// 模拟 reply-estimate "有效变更 → UPDATE + reset / 同分钟 → unchanged" 决策（server.js:14916-14933 逻辑）
async function applyReplyEstimate(id, rawInput) {
    const normalized = normalizeCollabDatetime(rawInput);
    if (!normalized) return { code: 'INVALID_ESTIMATE' };
    const row = await get('SELECT dev_estimated_at FROM collab_requests WHERE id=?', [id]);
    const oldVal = row.dev_estimated_at || null;
    if (oldVal === normalized) return { code: 'unchanged', normalized };  // 同分钟：不写
    await run(`UPDATE collab_requests SET dev_estimated_at=? WHERE id=? AND status='PENDING' AND developer_id=?`,
        [normalized, id, row_developer_id]);
    await resetExpectedNotifyNotSent(id);  // 无条件重置（方案 H-1）
    return { code: 'updated', normalized };
}
let row_developer_id = 7;  // fixture developer

// 四态字段不变量断言（class #7）：not_sent/failed/no_phone 三态 notified/key/read 必全 NULL；sent 必有 notified+key、error NULL
function assertInvariant(row) {
    const st = row.expected_notify_status;
    assert.ok(['not_sent', 'sent', 'failed', 'no_phone'].includes(st), `状态枚举非法: ${st}`);
    if (st === 'sent') {
        assert.ok(row.expected_notified_at, 'sent 必有 notified_at');
        assert.ok(row.expected_notify_message_key, 'sent 必有 message_key');
        assert.strictEqual(row.expected_notify_error, null, 'sent 的 error 必 NULL');
    } else {
        assert.strictEqual(row.expected_notified_at, null, `${st} 的 notified_at 必 NULL`);
        assert.strictEqual(row.expected_notify_message_key, null, `${st} 的 message_key 必 NULL`);
        assert.strictEqual(row.expected_read_at, null, `${st} 的 read_at 必 NULL`);
    }
}

async function seedPending(id, devAt) {
    await run(`INSERT INTO collab_requests (id, status, developer_id, created_by, dev_estimated_at, expected_notify_status) VALUES (?, 'PENDING', 7, 1, ?, 'not_sent')`, [id, devAt]);
}

async function main() {
    // 真实 schema 的 CHECK 约束一并建，顺带验证 CHECK 拦非法枚举
    await run(`CREATE TABLE collab_requests (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        developer_id INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        dev_estimated_at DATETIME,
        expected_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK(expected_notify_status IN ('not_sent','sent','failed','no_phone')),
        expected_notified_at DATETIME,
        expected_notify_message_key TEXT,
        expected_read_at DATETIME,
        expected_notify_error TEXT
    )`);

    console.log('— normalizeCollabDatetime / 同分钟 unchanged（class #1）—');
    await check('归一化秒位恒 :00', () => {
        assert.strictEqual(normalizeCollabDatetime('2099-01-02T14:30'), '2099-01-02 14:30:00');
        assert.strictEqual(normalizeCollabDatetime('2099-01-02 14:30:45'), '2099-01-02 14:30:00');
    });
    await check('越界/空/非法 → null', () => {
        assert.strictEqual(normalizeCollabDatetime('2099-02-30T10:00'), null);  // 2 月 30 越界
        assert.strictEqual(normalizeCollabDatetime(''), null);
        assert.strictEqual(normalizeCollabDatetime('not-a-date'), null);
        assert.strictEqual(normalizeCollabDatetime(null), null);
    });
    await check('同分钟（秒不同）→ unchanged 零写入', async () => {
        await seedPending(1, '2099-01-02 14:30:00');
        await setExpectedNotifySent(1, 'KEY-1', '2099-01-02 14:30:00');  // 先置 sent
        const before = await get('SELECT * FROM collab_requests WHERE id=1');
        const r = await applyReplyEstimate(1, '2099-01-02T14:30');  // 同分钟（归一化相等）
        assert.strictEqual(r.code, 'unchanged', '同分钟应返 unchanged');
        const after = await get('SELECT * FROM collab_requests WHERE id=1');
        assert.strictEqual(after.expected_notify_status, before.expected_notify_status, '同分钟不应重置通知态');
        assert.strictEqual(after.expected_notify_message_key, before.expected_notify_message_key, '同分钟不应清 key');
    });

    console.log('— 有效变更 → reset 通知态清干净（class #2）—');
    for (const seedState of ['sent', 'failed', 'no_phone']) {
        await check(`改预估 → 从 ${seedState} 重置为 not_sent 且字段全清`, async () => {
            const id = 10 + ['sent', 'failed', 'no_phone'].indexOf(seedState);
            await seedPending(id, '2099-03-01 09:00:00');
            if (seedState === 'sent') await setExpectedNotifySent(id, 'KEY-X', '2099-03-01 09:00:00');
            else if (seedState === 'failed') await setExpectedNotifyFailed(id, 'send_failed', '2099-03-01 09:00:00');
            else await setExpectedNotifyNoPhone(id);
            // 模拟 read_at 已固化（sent 场景）
            if (seedState === 'sent') await run(`UPDATE collab_requests SET expected_read_at='2099-03-01 09:05:00' WHERE id=?`, [id]);
            const r = await applyReplyEstimate(id, '2099-03-01T10:30');  // 改到新分钟
            assert.strictEqual(r.code, 'updated');
            const row = await get('SELECT * FROM collab_requests WHERE id=?', [id]);
            assert.strictEqual(row.expected_notify_status, 'not_sent', '应重置 not_sent');
            assert.strictEqual(row.expected_notified_at, null);
            assert.strictEqual(row.expected_notify_message_key, null);
            assert.strictEqual(row.expected_read_at, null);
            assert.strictEqual(row.expected_notify_error, null);
            assert.strictEqual(row.dev_estimated_at, '2099-03-01 10:30:00');
        });
    }

    console.log('— force_resend sent→failed 清旧 key/read_at（class #3）—');
    await check('sent(含 key+read_at) → failed 清 key/read_at、置 error', async () => {
        await seedPending(20, '2099-04-01 08:00:00');
        await setExpectedNotifySent(20, 'OLD-KEY', '2099-04-01 08:00:00');
        await run(`UPDATE collab_requests SET expected_read_at='2099-04-01 08:10:00' WHERE id=20`);
        const ok = await setExpectedNotifyFailed(20, 'send_failed', '2099-04-01 08:00:00');  // force_resend 重发失败
        assert.strictEqual(ok, true, 'guard 匹配应写入成功');
        const row = await get('SELECT * FROM collab_requests WHERE id=20');
        assert.strictEqual(row.expected_notify_status, 'failed');
        assert.strictEqual(row.expected_notify_message_key, null, '旧 key 必清');
        assert.strictEqual(row.expected_read_at, null, '旧 read_at 必清');
        assert.strictEqual(row.expected_notify_error, 'send_failed');
        assertInvariant(row);
    });

    console.log('— phone 空 → no_phone 落 REQUESTER_PHONE_EMPTY（class #4 落库语义）—');
    await check('no_phone：status=no_phone + error=REQUESTER_PHONE_EMPTY + 其余清', async () => {
        await seedPending(30, '2099-05-01 08:00:00');
        await setExpectedNotifySent(30, 'K', '2099-05-01 08:00:00');  // 先 sent
        await setExpectedNotifyNoPhone(30);  // 再次发现 phone 空
        const row = await get('SELECT * FROM collab_requests WHERE id=30');
        assert.strictEqual(row.expected_notify_status, 'no_phone');
        assert.strictEqual(row.expected_notify_error, 'REQUESTER_PHONE_EMPTY');
        assert.strictEqual(row.expected_notify_message_key, null);
        assert.strictEqual(row.expected_notified_at, null);
        assertInvariant(row);
    });
    // codex 104 M-1 取舍佐证：no_phone 不绑 guard，但"改预估 reset 后再 no_phone"是本次新尝试的正确结果，非 stale 覆盖
    await check('no_phone 无 guard：reset 后再 no_phone = 正确的"本次无手机号"新结果（非 stale 覆盖）', async () => {
        await seedPending(31, '2099-05-01 08:00:00');
        await setExpectedNotifySent(31, 'K0', '2099-05-01 08:00:00');   // 旧：已 sent
        await applyReplyEstimate(31, '2099-05-01T10:00');              // 开发改预估 → reset not_sent + 新预估
        let row = await get('SELECT * FROM collab_requests WHERE id=31');
        assert.strictEqual(row.expected_notify_status, 'not_sent', '改预估后应先 reset');
        await setExpectedNotifyNoPhone(31);                            // 建单人再次发起通知、发现无手机号
        row = await get('SELECT * FROM collab_requests WHERE id=31');
        assert.strictEqual(row.expected_notify_status, 'no_phone', 'no_phone 是本次新尝试的正确结果');
        assert.strictEqual(row.expected_notify_error, 'REQUESTER_PHONE_EMPTY');
        assert.strictEqual(row.dev_estimated_at, '2099-05-01 10:00:00', '预估仍是 reset 时的新值');
        assertInvariant(row);
    });

    console.log('— H-1 发送快照守卫：单据已变 → changes=0 不写（class #6）—');
    await check('sent 落库 guardDevAt 过期（发送中改预估）→ 不写、保持 not_sent', async () => {
        await seedPending(40, '2099-06-01 08:00:00');
        // 发送窗口内开发把预估改成 09:00（reset 成 not_sent）
        await applyReplyEstimate(40, '2099-06-01T09:00');
        // 旧发送线程拿着 08:00 的快照回来落 sent → guard 不匹配
        const ok = await setExpectedNotifySent(40, 'STALE-KEY', '2099-06-01 08:00:00');
        assert.strictEqual(ok, false, 'guard 过期应返 false（changes=0）');
        const row = await get('SELECT * FROM collab_requests WHERE id=40');
        assert.strictEqual(row.expected_notify_status, 'not_sent', '不应被旧 sent 覆盖');
        assert.strictEqual(row.expected_notify_message_key, null, '不应写入旧 key');
    });
    await check('failed 落库 guardDevAt 过期 → 不写（RC-M1 调用方据此返 409）', async () => {
        await seedPending(41, '2099-06-01 08:00:00');
        await applyReplyEstimate(41, '2099-06-01T09:30');  // 改派/改预估，reset
        const ok = await setExpectedNotifyFailed(41, 'token_failed', '2099-06-01 08:00:00');
        assert.strictEqual(ok, false, 'guard 过期 failed 也应返 false');
        const row = await get('SELECT * FROM collab_requests WHERE id=41');
        assert.strictEqual(row.expected_notify_status, 'not_sent', 'failed 不应覆盖 reset 后的 not_sent');
    });
    await check('status 非 PENDING（如 EXPORTING）→ guard 拦截不写', async () => {
        await seedPending(42, '2099-06-01 08:00:00');
        await run(`UPDATE collab_requests SET status='EXPORTING' WHERE id=42`);
        const ok = await setExpectedNotifySent(42, 'K', '2099-06-01 08:00:00');
        assert.strictEqual(ok, false, '非 PENDING 应被 guard 拦');
    });
    await check('guard 全匹配（status=PENDING + devAt 一致）→ 正常写入', async () => {
        await seedPending(43, '2099-06-01 08:00:00');
        const ok = await setExpectedNotifySent(43, 'GOOD-KEY', '2099-06-01 08:00:00');
        assert.strictEqual(ok, true);
        const row = await get('SELECT * FROM collab_requests WHERE id=43');
        assert.strictEqual(row.expected_notify_status, 'sent');
        assert.strictEqual(row.expected_notify_message_key, 'GOOD-KEY');
        assertInvariant(row);
    });

    console.log('— schema CHECK 拦非法枚举（class #7 兜底）—');
    await check('写入非法 expected_notify_status → CHECK 报错', async () => {
        await assert.rejects(
            run(`INSERT INTO collab_requests (id, status, expected_notify_status) VALUES (99, 'PENDING', 'bogus')`),
            /CHECK/i, 'CHECK 约束应拦非法枚举'
        );
    });

    console.log('— ALLOW_PAST_MINUTES=2 边界（v1.3 L-2，纯逻辑）—');
    await check('早于当前 2 分钟内允许、超 2 分钟拒', () => {
        const ALLOW_PAST_MINUTES = 2;
        const now = Date.now();
        const within = now - 90 * 1000;       // 1.5 min ago
        const beyond = now - 3 * 60 * 1000;   // 3 min ago
        assert.ok(!(within < now - ALLOW_PAST_MINUTES * 60 * 1000), '2 分钟内不应判过去');
        assert.ok(beyond < now - ALLOW_PAST_MINUTES * 60 * 1000, '超 2 分钟应判过去');
    });

    // ===== 漂移哨兵：读 server.js 真相源，断言镜像未脱节 =====
    console.log('— 漂移哨兵：server.js 真相源比对 —');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    await check('4 个 expected helper 仍存在于 server.js', () => {
        for (const fn of ['resetExpectedNotifyNotSent', 'setExpectedNotifyNoPhone', 'setExpectedNotifyFailed', 'setExpectedNotifySent']) {
            assert.ok(serverSrc.includes(`function ${fn}(`), `缺 helper: ${fn}`);
        }
    });
    await check('H-1 守卫子句 status=PENDING AND dev_estimated_at=? 仍在 sent/failed helper', () => {
        const guardCount = (serverSrc.match(/WHERE id=\? AND status='PENDING' AND dev_estimated_at=\?/g) || []).length;
        assert.ok(guardCount >= 2, `守卫子句应 ≥2 处（sent+failed），实测 ${guardCount}`);
    });
    await check('RC-M1：failedPersistedOr409 已定义且 setExpectedNotifyFailed 仅经它调用（≥5 失败路径路由）', () => {
        assert.ok(serverSrc.includes('const failedPersistedOr409 = async'), '缺 failedPersistedOr409 定义');
        // setExpectedNotifyFailed 出现处：1 处函数定义 + 1 处 helper 内调用（其余失败路径都走 failedPersistedOr409）
        const callMatches = (serverSrc.match(/setExpectedNotifyFailed\(/g) || []).length;
        assert.strictEqual(callMatches, 2, `setExpectedNotifyFailed 应只剩 2 处（定义 + helper 内单一调用），实测 ${callMatches}`);
        // 定义是 `const failedPersistedOr409 = async`（无紧跟括号），故 `failedPersistedOr409(` 只数到 5 个调用点 = 5 条失败路径
        const routed = (serverSrc.match(/failedPersistedOr409\(/g) || []).length;
        assert.strictEqual(routed, 5, `failedPersistedOr409 应 5 处调用（5 条失败路径全路由），实测 ${routed}`);
    });
    await check('notify-expected 成功路径绑 H-1 守卫返 409 CONCURRENT_UPDATE_DURING_NOTIFY', () => {
        assert.ok(serverSrc.includes('CONCURRENT_UPDATE_DURING_NOTIFY'), '缺并发守卫错误码');
    });

    db.close();
    console.log(`\n=== verify-collab-expected-notify: ${passed} passed / ${failed} failed ===`);
    if (failed > 0) {
        for (const f of failures) console.log(`   ✗ ${f.name}: ${f.err}`);
        process.exit(1);
    }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
