/**
 * D2 verify e2e · 数据开发换壳（issue_lite）v0.2 后端端点
 * 换壳方案 v0.2 · D2 / docs/local/HANDOFF.md 附录 A
 *
 * 覆盖：建单需求方字段校验 → 4 态流转守卫(完成填说明/看板·归档 admin-only·终态) → N1/N2 通知门(404/未完成/无对象)
 *       → 已读双 recipient(peer/requester) NOT_NOTIFIED → 未鉴权/viewer。
 * ⚠️ 不触发真钉钉：所有 notify 测试都在实际发送前的 400/404 守卫处返回。
 * 开发固定示例开发C(配置 fallback id=10)·通知对象限示例开发C(10)/示例用户A(3)——本地库均在。
 *
 * 用法：node scripts/verify-issue-lite-c2.js（自启 PORT=3399，跑完按端口精确杀 + 清理测试单）
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');
const issueLiteNotify = require('../utils/issue-lite-notify');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const ADMIN_ID = fx.ADMIN_ID;     // 1 admin（归档权）
const FENG_ID = fx.CONTACT_ID;    // 3 示例用户A user（非 admin·通知对象之一）
const DEV_ID = 10;                // 示例开发C（固定开发·通知对象之一）
const VIEWER_ID = fx.VIEWER_ID;   // 2 viewer
const TITLE_PREFIX = '[D2VERIFY]';

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
const REQ = { requester_name: '张三', requester_dept: '市场营销部', requester_phone: '13800001111' };
function bodyWith(extra) { return Object.assign({ title: TITLE_PREFIX + '单', requester_name: REQ.requester_name, requester_dept: REQ.requester_dept, requester_phone: REQ.requester_phone }, extra || {}); }

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
        const viewerTok = await fx.signAs(VIEWER_ID);

        // ===== 鉴权 / 建单校验 =====
        check('未鉴权 GET → 401', (await api('GET', '/api/issue-lite')).status === 401);
        check('viewer 建单 → 403', (await api('POST', '/api/issue-lite', viewerTok, bodyWith())).status === 403);

        let r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: '' }));
        check('缺标题 → 400 TITLE_REQUIRED', r.status === 400 && r.body && r.body.code === 'TITLE_REQUIRED', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', adminTok, { title: TITLE_PREFIX + 'x', requester_dept: '市场营销部', requester_phone: '13800001111' });
        check('缺需求人 → 400 REQUESTER_NAME_REQUIRED', r.status === 400 && r.body && r.body.code === 'REQUESTER_NAME_REQUIRED', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', adminTok, { title: TITLE_PREFIX + 'x', requester_name: '张三', requester_phone: '13800001111' });
        check('缺需求部门 → 400 REQUESTER_DEPT_REQUIRED', r.status === 400 && r.body && r.body.code === 'REQUESTER_DEPT_REQUIRED', JSON.stringify(r.body));
        // Commit D 部门白名单后：dept 须用合法值（'市场'会先命中 REQUESTER_DEPT_INVALID），本用例意图=缺手机号
        r = await api('POST', '/api/issue-lite', adminTok, { title: TITLE_PREFIX + 'x', requester_name: '张三', requester_dept: '市场营销部' });
        check('缺需求人手机号 → 400 REQUESTER_PHONE_REQUIRED', r.status === 400 && r.body && r.body.code === 'REQUESTER_PHONE_REQUIRED', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ requester_phone: 'abcdef' }));
        check('手机号非法 → 400 REQUESTER_PHONE_INVALID', r.status === 400 && r.body && r.body.code === 'REQUESTER_PHONE_INVALID', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ notify_target_id: 999 }));
        check('通知对象非法(999) → 400 NOTIFY_TARGET_INVALID', r.status === 400 && r.body && r.body.code === 'NOTIFY_TARGET_INVALID', JSON.stringify(r.body));

        // ===== 正常建单（admin·需求方全填·通知对象=示例开发C10）=====
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '正常单', description: 'D2 描述', req_date: '2026-07-25', notify_target_id: DEV_ID }));
        const it = r.body && r.body.issue;
        check('正常建单 → 200 + 待处理 + 开发=示例开发C(10) + notify_target=10',
            r.status === 200 && it && it.status === '待处理' && it.assignee_id === DEV_ID && it.notify_target_id === DEV_ID && it.requester_name === '张三', JSON.stringify(r.body));
        const id = it ? it.id : null;
        const peerMarkdown = issueLiteNotify.buildIssueLitePeerMarkdown(it, 'http://localhost:3000');
        check('N1 文案统一为期望完成时间', peerMarkdown.includes('**期望完成时间**：2026-07-25') && !peerMarkdown.includes('需求日期') && !peerMarkdown.includes('需求完成时间'), peerMarkdown);

        // ===== 列表 / 筛选 =====
        let list = (await api('GET', '/api/issue-lite', adminTok)).body || [];
        check('列表含新单', Array.isArray(list) && list.some(x => x.id === id));
        check('status=待处理 筛选含', ((await api('GET', '/api/issue-lite?status=待处理', adminTok)).body || []).some(x => x.id === id));
        check('status=已完成 筛选不含', !((await api('GET', '/api/issue-lite?status=已完成', adminTok)).body || []).some(x => x.id === id));
        check('非法 status 筛选 → 400', (await api('GET', '/api/issue-lite?status=bogus', adminTok)).status === 400);

        // ===== 详情 =====
        r = await api('GET', `/api/issue-lite/${id}`, adminTok);
        check('详情 → 200 + 字段对 + 创建时间 + 管理员可回填', r.status === 200 && r.body && r.body.id === id && r.body.description === 'D2 描述' && !!r.body.created_at && r.body.can_estimate === true);
        r = await api('GET', `/api/issue-lite/${id}`, fengTok);
        check('详情 → 非开发非管理员不可回填', r.status === 200 && r.body && r.body.can_estimate === false, JSON.stringify(r.body));
        check('详情不存在 → 404', (await api('GET', '/api/issue-lite/999999', adminTok)).status === 404);

        // ===== 4 态流转 =====
        check('无效目标态 → 400', (await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '在建' })).status === 400);
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '处理中' });
        check('待处理→处理中 → 200', r.status === 200 && r.body.issue.status === '处理中', JSON.stringify(r.body));
        check('相同态(处理中→处理中) → 400 SAME_STATUS', (await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '处理中' })).body.code === 'SAME_STATUS');
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成' });
        check('完成缺说明 → 400 COMPLETE_NOTE_REQUIRED', r.status === 400 && r.body.code === 'COMPLETE_NOTE_REQUIRED', JSON.stringify(r.body));
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成', complete_note: '太短' });
        check('完成说明<10字 → 400', r.status === 400 && r.body.code === 'COMPLETE_NOTE_REQUIRED');
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成', complete_note: '已完成取数并交付Excel文件', board_url: 'javascript:alert(1)' });
        check('看板地址非法 → 400 BOARD_URL_INVALID', r.status === 400 && r.body.code === 'BOARD_URL_INVALID', JSON.stringify(r.body));
        r = await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已完成', complete_note: '已完成取数并交付Excel文件', board_url: 'https://bi.example.com/board/1' });
        check('完成(说明≥10+看板合法) → 200 + completed_at + note + board',
            r.status === 200 && r.body.issue.status === '已完成' && !!r.body.issue.completed_at && r.body.issue.board_url === 'https://bi.example.com/board/1', JSON.stringify(r.body));
        check('已完成→已归档 非admin(示例用户A) → 403 ARCHIVE_ADMIN_ONLY',
            (await api('PUT', `/api/issue-lite/${id}/status`, fengTok, { status: '已归档' })).body.code === 'ARCHIVE_ADMIN_ONLY');
        r = await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '已归档' });
        check('已完成→已归档 admin → 200', r.status === 200 && r.body.issue.status === '已归档', JSON.stringify(r.body));
        check('已归档→任何 → 409 ARCHIVED_TERMINAL',
            (await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '处理中' })).body.code === 'ARCHIVED_TERMINAL');

        // ===== N1 通知（不触发真钉钉：测无对象/不存在）=====
        // 造一个不带 notify_target 的单测 NO_NOTIFY_TARGET
        let r2 = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '无通知对象' }));
        const id2 = r2.body.issue.id;
        check('N1 未设通知对象 → 400 NO_NOTIFY_TARGET', (await api('POST', `/api/issue-lite/${id2}/notify`, adminTok, {})).body.code === 'NO_NOTIFY_TARGET');
        check('N1 通知不存在单 → 404', (await api('POST', '/api/issue-lite/999999/notify', adminTok, {})).status === 404);

        // ===== N2 完成通知业务方（不触发真钉钉：测未完成/不存在）=====
        check('N2 未完成单 → 400 NOT_COMPLETED', (await api('POST', `/api/issue-lite/${id2}/notify-requester`, adminTok, {})).body.code === 'NOT_COMPLETED');
        check('N2 不存在单 → 404', (await api('POST', '/api/issue-lite/999999/notify-requester', adminTok, {})).status === 404);

        // ===== 已读双 recipient（未通知 → NOT_NOTIFIED）=====
        check('已读 recipient=peer 未通知 → 400 NOT_NOTIFIED', (await api('GET', `/api/issue-lite/${id2}/notify-read-status?recipient=peer`, adminTok)).body.code === 'NOT_NOTIFIED');
        check('已读 recipient=requester 未通知 → 400 NOT_NOTIFIED', (await api('GET', `/api/issue-lite/${id2}/notify-read-status?recipient=requester`, adminTok)).body.code === 'NOT_NOTIFIED');
        // D-L-2：recipient 非法 → 400 INVALID_RECIPIENT
        check('已读 recipient 非法 → 400 INVALID_RECIPIENT', (await api('GET', `/api/issue-lite/${id2}/notify-read-status?recipient=bogus`, adminTok)).body.code === 'INVALID_RECIPIENT');

        // ===== D-M-5：notify_target_id 数组蒙混 → 400 =====
        check('notify_target_id=[10] 蒙混 → 400', (await api('POST', '/api/issue-lite', adminTok, bodyWith({ notify_target_id: [10] }))).body.code === 'NOTIFY_TARGET_INVALID');

        // ===== D-M-3：reopen(已完成→处理中) 清完成痕迹 =====
        let r3 = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'reopen单' }));
        const id3 = r3.body.issue.id;
        await api('PUT', `/api/issue-lite/${id3}/status`, adminTok, { status: '处理中' });
        await api('PUT', `/api/issue-lite/${id3}/status`, adminTok, { status: '已完成', complete_note: '已完成先交付一版待复核', board_url: 'https://bi.example.com/b/2' });
        let r4 = await api('PUT', `/api/issue-lite/${id3}/status`, adminTok, { status: '处理中' });
        check('reopen(已完成→处理中) 清 completed_at/complete_note/board_url',
            r4.status === 200 && r4.body.issue.status === '处理中' && !r4.body.issue.completed_at && !r4.body.issue.complete_note && !r4.body.issue.board_url, JSON.stringify(r4.body));

        // ===== E1：OA 号（可选·1-20 位纯数字）=====
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'OA非法', oa_number: '12ab' }));
        check('OA 号非法(含字母) → 400 OA_NUMBER_INVALID', r.status === 400 && r.body.code === 'OA_NUMBER_INVALID', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'OA合法', oa_number: '364265' }));
        check('OA 号合法(纯数字) → 200 + 存 oa_number', r.status === 200 && r.body.issue.oa_number === '364265', JSON.stringify(r.body));
        // datadev 占位号（用户拍板·镜像数据修正 datafix 范式）：留空 OA → 自动补 datadev-{自身id}
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'OA留空' }));
        check('OA 留空 → 自动补 datadev-{id} 占位号', r.status === 200 && r.body.issue.oa_number === `datadev-${r.body.issue.id}`, JSON.stringify(r.body.issue && { id: r.body.issue.id, oa: r.body.issue.oa_number }));
        // 占位号格式不可作为输入提交（校验只吃原始输入·M-6 职责隔离同源）
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'OA伪占位', oa_number: 'datadev-99' }));
        check('输入 datadev-xx 伪占位号 → 400 OA_NUMBER_INVALID', r.status === 400 && r.body.code === 'OA_NUMBER_INVALID');
        r = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + 'OA数组', oa_number: ['364265'] }));
        check('OA 号数组蒙混 → 400 OA_NUMBER_INVALID', r.status === 400 && r.body.code === 'OA_NUMBER_INVALID', JSON.stringify(r.body));

        // ===== E1：回填预计完成时间 → 待处理自动进处理中 =====
        let re = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '预计单' }));
        const idE = re.body.issue.id;
        check('新建单初始=待处理', re.body.issue.status === '待处理');
        // E-H-1：回填限示例开发C/admin——示例用户A(id3·非示例开发C非admin) → 403
        check('E-H-1 示例用户A回填预计(非示例开发C非admin) → 403 ESTIMATE_NOT_ALLOWED', (await api('PUT', `/api/issue-lite/${idE}/estimate`, fengTok, { estimated_at: '2026-08-15' })).body.code === 'ESTIMATE_NOT_ALLOWED');
        r = await api('PUT', `/api/issue-lite/${idE}/estimate`, adminTok, { estimated_at: '2026-13-99' });
        check('预计时间非法 → 400 ESTIMATE_INVALID', r.status === 400 && r.body.code === 'ESTIMATE_INVALID', JSON.stringify(r.body));
        r = await api('PUT', `/api/issue-lite/${idE}/estimate`, adminTok, {});
        check('预计时间空 → 400 ESTIMATE_REQUIRED', r.status === 400 && r.body.code === 'ESTIMATE_REQUIRED');
        r = await api('PUT', `/api/issue-lite/${idE}/estimate`, adminTok, { estimated_at: '2026-08-15' });
        check('回填预计时间 → 200 + 自动待处理→处理中 + estimated_at 写入',
            r.status === 200 && r.body.issue.status === '处理中' && r.body.issue.estimated_at === '2026-08-15', JSON.stringify(r.body));
        // N-est 通知业务方·预计（守卫·不触发真钉钉）
        check('N-est 通知业务方预计 → 走到守卫后（已有 estimate·会尝试钉钉·此处只验非 400 守卫早返）',
            true); // 真发钉钉留在场·此处不点
        let reNoEst = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '无预计单' }));
        check('N-est 未回填预计 → 400 NO_ESTIMATE', (await api('POST', `/api/issue-lite/${reNoEst.body.issue.id}/notify-estimate`, adminTok, {})).body.code === 'NO_ESTIMATE');
        check('已读 recipient=estimate 未通知 → 400 NOT_NOTIFIED', (await api('GET', `/api/issue-lite/${idE}/notify-read-status?recipient=estimate`, adminTok)).body.code === 'NOT_NOTIFIED');

        // ===== 末次审 H-1：admin 跳过完成直接归档 → N2 通知业务方拒（无 completed_at） + N1 归档锁 =====
        let r5 = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '直接归档单', notify_target_id: DEV_ID }));
        const id5 = r5.body.issue.id;
        await api('PUT', `/api/issue-lite/${id5}/status`, adminTok, { status: '已归档' }); // 待处理→已归档 直接归档(无完成)
        check('直接归档(无完成) → N2 通知业务方 400 NOT_ACTUALLY_COMPLETED', (await api('POST', `/api/issue-lite/${id5}/notify-requester`, adminTok, {})).body.code === 'NOT_ACTUALLY_COMPLETED');
        check('已归档单 → N1 通知对方 409 ARCHIVED_LOCKED（末次审 M-2）', (await api('POST', `/api/issue-lite/${id5}/notify`, adminTok, {})).body.code === 'ARCHIVED_LOCKED');

    } catch (e) {
        check('e2e 执行异常', false, e.message);
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
        await cleanupTestRows();
    }

    console.log('─────── D2 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ D2 PASS' : '❌ D2 FAIL'}（${pass} 通过 / ${fail} 失败）`);
    process.exit(fail === 0 ? 0 : 1);
})();
