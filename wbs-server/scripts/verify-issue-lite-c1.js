/**
 * C1 verify · 数据开发换壳（issue_lite）schema 建表
 * 换壳方案 v0.1 §4 / docs/local/HANDOFF.md 附录 A C1
 *
 * 验证点：
 *   ① 服务就绪：GET /api/health/ready 里 issue_lite 模块 ready，且未带 token 访问列表 401（服务确实在应答 issue_lite 路由）
 *   ② 实例库里 issue_lite 表存在且 41 关键列全部到位（PRAGMA，含作废 4 列）
 *   ③ 三条索引 idx_issue_lite_status / idx_issue_lite_assignee / idx_issue_lite_voided 存在
 *
 * 用法：node scripts/verify-issue-lite-c1.js
 * [#106 S4b1] 不再自 spawn 服务、不再写死端口 3399、不再按端口杀进程、不再等日志轮询、不再读真实库：经 scripts/lib/test-env.js 自起临时隔离实例
 *   （来源 = 本检出本地库快照），也可由 TEST_* 变量组指向已起好的隔离实例。原「启动日志 ready 行」断言换成 health/ready 的 issue_lite 模块就绪（不依赖会演进的日志文案）。
 */
'use strict';
const sqlite3 = require('sqlite3');
const testEnv = require('./lib/test-env');

const REQUIRED_COLS = [
    'id', 'title', 'description', 'oa_number',
    'requester_name', 'requester_dept', 'requester_phone',
    'req_date', 'estimated_at', 'assignee_id', 'assignee_name', 'status',
    'complete_note', 'board_url',
    'notify_target_id', 'notify_status', 'notify_at', 'notify_message_key', 'notify_read_at',
    'est_notify_status', 'est_notify_at', 'est_notify_message_key', 'est_notify_read_at',
    'req_notify_status', 'req_notify_at', 'req_notify_message_key', 'req_notify_read_at',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at',
    'dingtalk_chat_created_by', 'dingtalk_chat_name',
    'created_by', 'created_by_name', 'created_at', 'completed_at', 'updated_at',
    // 作废软作废 4 列（作废与查询优化 v0.1 Commit A）
    'voided_at', 'voided_by', 'voided_by_name', 'void_reason'
];
// D1: 校验 status CHECK 为 4 态
const EXPECT_STATUS_CHECK = /CHECK\s*\(\s*status\s+IN\s*\(\s*'待处理'\s*,\s*'处理中'\s*,\s*'已完成'\s*,\s*'已归档'\s*\)/;

function checkDb(dbPath) {
    return new Promise((resolve) => {
        // 所有出口都等 db.close 的回调再 resolve：共享实例下 teardown 立即返回、脚本紧接着 process.exit，关库还在进行中会触发 libuv 断言（UV_HANDLE_CLOSING）
        let db = null;
        const done = (res) => db.close(() => resolve(res));
        db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) return resolve({ ok: false, msg: `打开 db 失败：${err.message}` });   // 没打开成功就没有可关的连接
            query();
        });
        const query = () => db.all(`PRAGMA table_info("issue_lite")`, (err, rows) => {
            if (err) return done({ ok: false, msg: `PRAGMA 失败：${err.message}` });
            const cols = (rows || []).map(r => r.name);
            const missing = REQUIRED_COLS.filter(c => !cols.includes(c));
            db.all(`SELECT name, type, sql FROM sqlite_master WHERE tbl_name='issue_lite' AND type IN ('index','trigger')`, (e2, idxRows) => {
                const idxNames = (idxRows || []).filter(r => r.type === 'index').map(r => r.name);
                let idxMissing = ['idx_issue_lite_status', 'idx_issue_lite_assignee', 'idx_issue_lite_voided'].filter(i => !idxNames.includes(i));
                // datadev 占位号触发器（codex 19 uxH-3·复审 uxL-1）：不止查名——断言定义含 AFTER INSERT +
                //   WHEN NEW.oa_number IS NULL + 'datadev-' || NEW.id（防 IF NOT EXISTS 保留同名陈旧定义）
                const trg = (idxRows || []).find(r => r.type === 'trigger' && r.name === 'trg_issue_lite_datadev_oa');
                const trgSql = (trg && trg.sql) || '';
                const trgOk = /AFTER\s+INSERT/i.test(trgSql) && /WHEN\s+NEW\.oa_number\s+IS\s+NULL/i.test(trgSql)
                    && /'datadev-'\s*\|\|\s*NEW\.id/i.test(trgSql);
                if (!trgOk) idxMissing = idxMissing.concat(['trg_issue_lite_datadev_oa(定义不符或缺失)']);
                db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='issue_lite'`, (e3, row) => {
                    if (missing.length) return done({ ok: false, msg: `issue_lite 缺列：${missing.join(',')}` });
                    if (idxMissing.length) return done({ ok: false, msg: `缺索引：${idxMissing.join(',')}` });
                    if (!row || !EXPECT_STATUS_CHECK.test(row.sql)) return done({ ok: false, msg: `status CHECK 非 4 态（待处理/处理中/已完成/已归档）` });
                    done({ ok: true, msg: `issue_lite 列齐(${cols.length}) + 索引齐 + status 4 态 CHECK`, cols });
                });
            });
        });
    });
}

// 服务就绪判定 = 两次真实请求的结果：① health/ready 里 issue_lite 模块 ready；② 未带 token 的列表 401
async function checkReady(baseUrl) {
    let hb = null;
    let hstatus = 0;
    try {
        const hr = await fetch(`${baseUrl}/api/health/ready`);
        hstatus = hr.status;
        try { hb = await hr.json(); } catch (_) { /* 非 JSON 视为未就绪 */ }
    } catch (e) { return { ok: false, msg: `health/ready 请求失败：${e.message}` }; }
    const mod = hb && hb.modules && hb.modules.issue_lite;
    if (!mod || mod.ready !== true) return { ok: false, msg: `health/ready 中 issue_lite 未就绪（HTTP ${hstatus}，issue_lite=${JSON.stringify(mod)}）` };
    let lstatus = 0;
    try { lstatus = (await fetch(`${baseUrl}/api/issue-lite`)).status; } catch (e) { return { ok: false, msg: `列表请求失败：${e.message}` }; }
    if (lstatus !== 401) return { ok: false, msg: `未带 token 访问 /api/issue-lite 应为 401，实得 ${lstatus}` };
    return { ok: true, msg: 'health/ready issue_lite 就绪 + 未带 token 列表 401' };
}

(async () => {
    await testEnv.ready();   // 先于任何网络 / 库访问：自起隔离实例（或核对 TEST_* 变量组）
    let readyRes = { ok: false, msg: '未执行' };
    let dbRes = { ok: false, msg: '未执行' };
    try {
        const e = testEnv.env();
        readyRes = await checkReady(e.baseUrl);
        dbRes = await checkDb(e.dbPath);
    } catch (e) {
        readyRes = { ok: false, msg: `执行异常：${e.message}` };
    } finally {
        try { await testEnv.teardown(); } catch (e) { readyRes = { ok: false, msg: `teardown 失败：${e.message}` }; }
    }

    console.log('─────── C1 verify 结果 ───────');
    console.log(`① 服务就绪：${readyRes.ok ? '✅ PASS · ' + readyRes.msg : '❌ FAIL · ' + readyRes.msg}`);
    console.log(`② db 表结构：${dbRes.ok ? '✅ PASS · ' + dbRes.msg : '❌ FAIL · ' + dbRes.msg}`);
    const pass = readyRes.ok && dbRes.ok;
    console.log(`\n总判定：${pass ? '✅ C1 PASS' : '❌ C1 FAIL'}`);
    testEnv.finish(pass ? 0 : 1);   // 收尾：teardown 之后设退出码 + 10 秒 unref 兜底，不直接 process.exit（Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('C1 verify 启动失败：', e && e.stack || e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
