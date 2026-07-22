/**
 * D4 verify e2e · 数据开发换壳（issue_lite）拉群守卫
 * 换壳方案 v0.2 · D4 / docs/local/HANDOFF.md 附录 A
 *
 * ⚠️ 拉群会真建钉钉群——本 verify **只测钉钉调用前的守卫**（权限/幂等/id），绝不触发真建群。
 *    真建群 e2e 需用户在场（会真拉群）。授权路径靠"预置 open_conv_id 幂等短路"安全验证。
 * 自启 PORT=3399，跑完按端口精确杀 + 清理测试单。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const DEV_ID = 10; // 示例开发C
const TITLE_PREFIX = '[D4VERIFY]';

let pass = 0, fail = 0; const results = [];
function check(name, cond, detail) { if (cond) { pass++; results.push(`  ✅ ${name}`); } else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); } }
async function api(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}
// codex 15 C-1 范式（F 收口 sweep）：netstat 本地地址列精确端口比较（findstr :3399 子串匹配会误命中 33990-33999）
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(line => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}
function cleanupRows() {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE); db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); res(); }); });
}
function setOpenConv(id, val) {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE); db.run(`UPDATE issue_lite SET dingtalk_open_conversation_id=?, dingtalk_chat_id=?, dingtalk_chat_name=? WHERE id=?`, [val, 'cid_' + id, '[数据开发]测试群', id], () => { db.close(); res(); }); });
}
async function waitReady(getLog, ms = 12000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(getLog())) { try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) return true; } catch (_) {} }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}
const REQ = { requester_name: '王五', requester_dept: '交付运营部', requester_phone: '13700003333' };
function bodyWith(extra) { return Object.assign({ title: TITLE_PREFIX + '单' }, REQ, extra || {}); }

(async () => {
    killPort(TEST_PORT);
    await cleanupRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    try {
        const ready = await waitReady(() => log);
        check('服务 + schema 就绪', ready);
        if (!ready) throw new Error('服务未就绪');

        const adminTok = await fx.signAs(fx.ADMIN_ID);   // 1 admin（建单人）
        const fengTok = await fx.signAs(fx.CONTACT_ID);  // 3 示例用户A（非建单人·非示例开发C·群主但无拉群权）
        const devTok = await fx.signAs(DEV_ID);          // 10 示例开发C
        const viewerTok = await fx.signAs(fx.VIEWER_ID);

        // 造单（admin 建）
        const id = (await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '拉群单' }))).body.issue.id;

        // 守卫：id 非法 / 不存在 / viewer / 无权
        check('id 非法 → 400', (await api('POST', '/api/issue-lite/abc/create-chat', adminTok, {})).status === 400);
        check('不存在单 → 404', (await api('POST', '/api/issue-lite/999999/create-chat', adminTok, {})).status === 404);
        check('viewer 拉群 → 403', (await api('POST', `/api/issue-lite/${id}/create-chat`, viewerTok, {})).status === 403);
        // 示例用户A(3)：非建单人(admin=1) 且非示例开发C(10) → 403 NOT_ALLOWED（即便他是群主也无拉群权）
        check('非建单人非示例开发C(示例用户A) → 403 NOT_ALLOWED', (await api('POST', `/api/issue-lite/${id}/create-chat`, fengTok, {})).body.code === 'NOT_ALLOWED');

        // 幂等短路（预置 open_conv）→ 授权路径安全验证（不触发真钉钉）
        await setOpenConv(id, 'openconv_test_123');
        // 建单人(admin) 拉 → 过权限 → 幂等返回
        let r = await api('POST', `/api/issue-lite/${id}/create-chat`, adminTok, {});
        check('建单人拉·已建群 → 200 idempotent', r.status === 200 && r.body.idempotent === true && r.body.open_conversation_id === 'openconv_test_123', JSON.stringify(r.body));
        // 示例开发C 拉 → 过权限（isDeveloper）→ 幂等返回（验证示例开发C有拉群权·不触发真钉钉）
        r = await api('POST', `/api/issue-lite/${id}/create-chat`, devTok, {});
        check('示例开发C拉·已建群 → 200 idempotent（示例开发C有拉群权）', r.status === 200 && r.body.idempotent === true, JSON.stringify(r.body));

        // 末次审 M-2：已归档单拉群 → 409 ARCHIVED_LOCKED（在幂等/钉钉前）
        const id2 = (await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '归档拉群单' }))).body.issue.id;
        await api('PUT', `/api/issue-lite/${id2}/status`, adminTok, { status: '已归档' });
        check('已归档单拉群 → 409 ARCHIVED_LOCKED', (await api('POST', `/api/issue-lite/${id2}/create-chat`, adminTok, {})).body.code === 'ARCHIVED_LOCKED');

    } catch (e) { check('e2e 执行异常', false, e.message); }
    finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
        await cleanupRows();
    }
    console.log('─────── D4 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ D4 PASS' : '❌ D4 FAIL'}（${pass} 通过 / ${fail} 失败）·真建群 e2e 需在场`);
    process.exit(fail === 0 ? 0 : 1);
})();
