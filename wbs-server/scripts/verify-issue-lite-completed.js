/**
 * Commit C verify e2e · 数据开发台账 实际完成时间防回归
 * 作废与查询优化 v0.1 §4（completed_at 既定规则验收·不新增不改名字段）
 *
 * 覆盖（§4 规则 1-7 逐条钉·codex 15 加固：哨兵种子证明"清掉已有留痕"而非"从未写入"）：
 *   [1] 建单后 completed_at=NULL → 首次标记完成写入（completed_at + complete_note + board_url）
 *   [2] 列表值 = 详情值（同一 completed_at 字段同源）
 *   [3] SQL 种入 N2 四件套哨兵 → 重开到处理中：completed_at/complete_note/board_url + 哨兵全清空
 *   [3b] 种入 est_notify_* 哨兵 → 重开后 estimated_at + 哨兵逐项原值保持（预计链路与完成周期无关）
 *   [4] 再次标记完成写入**新**时间（时间戳解析断言差 ≥1000ms，不靠字典序）
 *   [5] N2 双条件门证毕：已归档无 completed_at → NOT_ACTUALLY_COMPLETED；待处理种 completed_at 哨兵 → NOT_COMPLETED
 *   [6] 已完成单作废保留完成事实（completed_at/complete_note/board_url 三项全等）
 * ⚠️ 不触发真钉钉：N2 只测 400 门挡路径；通知留痕用 SQL 哨兵造，不真发。
 *
 * 用法：node scripts/verify-issue-lite-completed.js（自启 PORT=3399，跑完按端口精确杀 + 清理测试单）
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const ADMIN_ID = fx.ADMIN_ID;
const FENG_ID = fx.CONTACT_ID;
const TITLE_PREFIX = '[CPLVERIFY]';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
    if (cond) { pass++; results.push(`  ✅ ${name}`); }
    else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}
async function api(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}
// codex 15 C-1：解析 netstat 本地地址列做**精确端口**比较（findstr :3399 子串匹配会误命中 33990-33999）
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
function cleanupTestRows() {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); resolve(); });
    });
}
async function waitReady(getLog, ms = 12000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(getLog())) {
            try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) return true; } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}
function bodyWith(title) {
    return { title: TITLE_PREFIX + title, requester_name: '张三', requester_dept: '市场营销部', requester_phone: '13800001111' };
}
// SQL 哨兵种子（codex 15 C-2/C-3/C-4）：通知留痕/completed_at 无法经 API 造出（会触真钉钉），直接落库种非空哨兵
function dbRun(sql, params) {
    return new Promise((resolve) => {
        const d = new sqlite3.Database(DB_FILE);
        d.run(sql, params, function (e) { const c = e ? -1 : this.changes; d.close(() => resolve(c)); });
    });
}
// 'YYYY-MM-DD HH:MM:SS'（datetime localtime）→ 毫秒时间戳（codex 15 C-6：真解析，不靠字典序）
const toMs = (s) => new Date(String(s).replace(' ', 'T')).getTime();
const NOTE1 = '第一次完成：看板已交付并核对口径';
const NOTE2 = '第二次完成：修订后重新交付看板';

(async () => {
    killPort(TEST_PORT);
    await cleanupTestRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });

    try {
        const ready = await waitReady(() => log);
        check('服务 + issue_lite schema 就绪', ready);
        if (!ready) throw new Error('服务未就绪');

        const adminTok = await fx.signAs(ADMIN_ID);
        const fengTok = await fx.signAs(FENG_ID);

        // ===== [1] 首次完成 =====
        let r = await api('POST', '/api/issue-lite', fengTok, bodyWith('完成周期'));
        const id = r.body.issue.id;
        check('[1-前置] 建单后 completed_at 为 NULL（防预填旧值漏检·codex 15 C-5）', r.status === 200 && r.body.issue.completed_at === null);
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成', complete_note: NOTE1, board_url: 'https://bi.example/b1' });
        const first = r.body.issue;
        check('[1] 首次完成写入 completed_at + note + board', r.status === 200 && !!first.completed_at
            && first.complete_note === NOTE1 && first.board_url === 'https://bi.example/b1', JSON.stringify(r.body));

        // ===== [2] 列表值 = 详情值 =====
        const inList = ((await api('GET', '/api/issue-lite?status=已完成', fengTok)).body || []).find(x => x.id === id);
        const inDetail = (await api('GET', `/api/issue-lite/${id}`, fengTok)).body;
        check('[2] 列表 completed_at === 详情 completed_at（同源）', !!inList && inList.completed_at === inDetail.completed_at
            && inDetail.completed_at === first.completed_at, `list=${inList && inList.completed_at} detail=${inDetail.completed_at}`);

        // ===== [3] 重开清空完成痕迹 + N2 四件套（种哨兵证明"清掉已有留痕"，非"从未写入"·codex 15 C-2）=====
        const n2Seed = await dbRun(
            `UPDATE issue_lite SET req_notify_status='sent', req_notify_at='2026-07-22T10:00:00.000Z',
                    req_notify_message_key='SEED_N2_KEY', req_notify_read_at='2026-07-22 10:05:00' WHERE id=?`, [id]);
        check('[3-前置] N2 四件套哨兵种入成功', n2Seed === 1);
        await new Promise(rs => setTimeout(rs, 1100)); // 秒级时间戳，确保二次完成时间可区分
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '处理中' });
        const reopened = r.body.issue;
        check('[3] 重开清空 completed_at/complete_note/board_url', r.status === 200 && reopened.completed_at === null
            && reopened.complete_note === null && reopened.board_url === null, JSON.stringify(r.body));
        check('[3] 重开把已有 N2 四件套哨兵全部清空(req_notify_*)', reopened.req_notify_status === null && reopened.req_notify_at === null
            && reopened.req_notify_message_key === null && reopened.req_notify_read_at === null, JSON.stringify(reopened && { s: reopened.req_notify_status, a: reopened.req_notify_at }));

        // [3b] 带预计链路的单：回填预计（进处理中）→ 种 est_notify_* 哨兵 → 完成 → 重开 → est 链路逐项原值不动（codex 15 C-3/C-7）
        r = await api('POST', '/api/issue-lite', fengTok, bodyWith('预计不误伤'));
        const id2 = r.body.issue.id;
        r = await api('PUT', `/api/issue-lite/${id2}/estimate`, adminTok, { estimated_at: '2026-08-15' });
        check('[3b-前置] admin 回填预计 → 200 进处理中', r.status === 200 && r.body.issue.status === '处理中');
        const estSeed = await dbRun(
            `UPDATE issue_lite SET est_notify_status='sent', est_notify_at='SEED_EST_AT',
                    est_notify_message_key='SEED_EST_KEY', est_notify_read_at='SEED_EST_READ' WHERE id=?`, [id2]);
        check('[3b-前置] est_notify_* 哨兵种入成功', estSeed === 1);
        r = await api('PUT', `/api/issue-lite/${id2}/status`, fengTok, { status: '已完成', complete_note: NOTE1 });
        check('[3b-前置] id2 完成 → 200', r.status === 200);
        r = await api('PUT', `/api/issue-lite/${id2}/status`, fengTok, { status: '处理中' });
        const rp2 = r.body.issue;
        check('[3b] 重开不清 estimated_at 且 est_notify_* 哨兵逐项原值保持（预计链路与完成周期无关）',
            r.status === 200 && rp2.estimated_at === '2026-08-15' && rp2.est_notify_status === 'sent'
            && rp2.est_notify_at === 'SEED_EST_AT' && rp2.est_notify_message_key === 'SEED_EST_KEY' && rp2.est_notify_read_at === 'SEED_EST_READ',
            JSON.stringify(rp2 && { e: rp2.estimated_at, s: rp2.est_notify_status, a: rp2.est_notify_at }));

        // ===== [4] 再次完成写入新时间（时间戳解析断言 ≥1s·codex 15 C-6）=====
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成', complete_note: NOTE2, board_url: 'https://bi.example/b2' });
        const second = r.body.issue;
        const msDiff = toMs(second.completed_at) - toMs(first.completed_at);
        check('[4] 再次完成写入新 completed_at（时间戳差 ≥1000ms·不复用首次）', r.status === 200 && !!second.completed_at
            && Number.isFinite(msDiff) && msDiff >= 1000, `first=${first.completed_at} second=${second.completed_at} diff=${msDiff}ms`);
        check('[4] 再次完成的说明/看板为新值（不残留首次）', second.complete_note === NOTE2 && second.board_url === 'https://bi.example/b2');

        // ===== [5] N2 双条件门（状态 AND completed_at 缺一不可·codex 15 C-4）=====
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith('直接归档'));
        const id3 = r.body.issue.id;
        r = await api('PUT', `/api/issue-lite/${id3}/status`, adminTok, { status: '已归档' });
        check('[5-前置] 直接归档 → 200 已归档且 completed_at 仍 NULL', r.status === 200 && r.body.issue.status === '已归档' && r.body.issue.completed_at === null);
        r = await api('POST', `/api/issue-lite/${id3}/notify-requester`, adminTok);
        check('[5a] 已归档但无 completed_at 发 N2 → 400 NOT_ACTUALLY_COMPLETED（completed_at 条件）', r.status === 400 && r.body.code === 'NOT_ACTUALLY_COMPLETED', JSON.stringify(r.body));
        // 反例：待处理单 SQL 种 completed_at 哨兵 → 仍被状态条件挡（证明双条件 AND 而非只查 completed_at）
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith('状态门反例'));
        const id4 = r.body.issue.id;
        check('[5b-前置] id4 建单为待处理且 completed_at=NULL（复L-2·钉死反例前置态）', r.status === 200 && r.body.issue.status === '待处理' && r.body.issue.completed_at === null);
        const cSeed = await dbRun(`UPDATE issue_lite SET completed_at='2026-07-22 10:00:00' WHERE id=?`, [id4]);
        check('[5-前置] 待处理单种 completed_at 哨兵成功', cSeed === 1);
        r = await api('POST', `/api/issue-lite/${id4}/notify-requester`, adminTok);
        check('[5b] 待处理但有 completed_at 发 N2 → 400 NOT_COMPLETED（状态条件·双条件 AND 证毕）', r.status === 400 && r.body.code === 'NOT_COMPLETED', JSON.stringify(r.body));

        // ===== [6] 已完成单作废保留完成事实（含 board_url·codex 15 C-10）=====
        r = await api('POST', `/api/issue-lite/${id}/void`, fengTok, { reason: '业务方撤回需求，作废留痕' });
        check('[6] 作废保留 completed_at/complete_note/board_url 三项全等（曾经完成的事实不抹）', r.status === 200
            && r.body.issue.completed_at === second.completed_at && r.body.issue.complete_note === NOTE2
            && r.body.issue.board_url === 'https://bi.example/b2', JSON.stringify(r.body.issue && { c: r.body.issue.completed_at, n: r.body.issue.complete_note, b: r.body.issue.board_url }));
    } catch (e) {
        fail++;
        results.push(`  ❌ 异常中断：${e.message}`);
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
        await new Promise(r => setTimeout(r, 500));
        await cleanupTestRows();
    }

    console.log('─────── Commit C 完成时间防回归 verify ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? `✅ PASS（${pass}/${pass + fail}）` : `❌ FAIL（${fail} 项失败 / 共 ${pass + fail}）`}`);
    process.exit(fail === 0 ? 0 : 1);
})();
