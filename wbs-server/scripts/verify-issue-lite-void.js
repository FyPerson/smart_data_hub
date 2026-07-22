/**
 * Commit B verify e2e · 数据开发台账 作废后端 + 跨端守卫
 * 作废与查询优化 v0.1 §3.2-3.4/§10.1 / docs/local/HANDOFF.md
 *
 * 覆盖：作废权限(建单人/其他普通用户/admin/viewer) → 来源态(待处理/处理中/已完成可·已归档不可·重复 409)
 *       → 原因校验(缺/短/超长/非字符串) → 列表可见性(默认隐藏·admin 含已作废·非 admin 403·非法值 400)
 *       → 详情可见性(非 admin 403·admin 可见+can_void) → 已完成单作废保留 completed_at
 *       → 作废后 9 条写路径全部拒绝(status/estimate/N1/N-est/N2/create-chat/附件传/附件删/notify-target)
 *       → 附件只读(列表/下载仍可) → 后补通知对象(空缺可补·权限·已设 409·非法 400)
 * ⚠️ 不触发真钉钉：voided/参数守卫全部先于钉钉调用返回；不对"有通知对象的正常单"调 notify。
 *
 * 用法：node scripts/verify-issue-lite-void.js（自启 PORT=3399，跑完按端口精确杀 + 清理测试单）
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const ADMIN_ID = fx.ADMIN_ID;     // 1 admin
const FENG_ID = fx.CONTACT_ID;    // 3 示例用户A（非 admin）
const DEV_ID = 10;                // 示例开发C（固定开发·非 admin）
const VIEWER_ID = fx.VIEWER_ID;   // 2 viewer
const TITLE_PREFIX = '[VOIDVERIFY]';

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
async function upload(id, token, name, content) {
    const fd = new FormData();
    fd.append('files', new Blob([content], { type: 'text/plain' }), name);
    const r = await fetch(`${BASE}/api/issue-lite/${id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
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
        db.serialize(() => {
            db.run(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [TITLE_PREFIX + '%'], () => {});
            db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); resolve(); });
        });
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
const REASON = '误建重复登记，走作废流程';
function bodyWith(title, extra) {
    return Object.assign({ title: TITLE_PREFIX + title, requester_name: '张三', requester_dept: '市场营销部', requester_phone: '13800001111' }, extra || {});
}

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
        const devTok = await fx.signAs(DEV_ID);
        const viewerTok = await fx.signAs(VIEWER_ID);

        // ===== 建 5 张测试单 =====
        // A：示例开发C建（待处理·作废权限主战场） B：示例用户A建（处理中作废） C：示例用户A建（已完成作废+9 写路径）
        // E：示例用户A建无通知对象（后补主战场） F：示例开发C建无通知对象（后补权限）
        const mk = async (tok, title, extra) => (await api('POST', '/api/issue-lite', tok, bodyWith(title, extra))).body.issue;
        const A = await mk(devTok, 'A待处理');
        const B = await mk(fengTok, 'B处理中');
        const C = await mk(fengTok, 'C已完成');
        const E = await mk(fengTok, 'E后补');
        const F = await mk(devTok, 'F后补权限');
        check('5 张测试单建单成功', A && B && C && E && F && [A, B, C, E, F].every(x => x.id && x.voided_at === null));

        // ===== 作废：原因校验 =====
        let r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, {});
        check('无原因 → 400 VOID_REASON_REQUIRED', r.status === 400 && r.body.code === 'VOID_REASON_REQUIRED', JSON.stringify(r.body));
        r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, { reason: '太短' });
        check('原因<5字 → 400', r.status === 400 && r.body.code === 'VOID_REASON_REQUIRED');
        r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, { reason: 'x'.repeat(501) });
        check('原因>500字 → 400 VOID_REASON_TOO_LONG', r.status === 400 && r.body.code === 'VOID_REASON_TOO_LONG');
        r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, { reason: 12345 });
        check('原因非字符串 → 400', r.status === 400 && r.body.code === 'VOID_REASON_REQUIRED');

        // ===== 作废：权限 =====
        r = await api('POST', `/api/issue-lite/${A.id}/void`, viewerTok, { reason: REASON });
        check('viewer 作废 → 403', r.status === 403);
        r = await api('POST', `/api/issue-lite/${A.id}/void`, fengTok, { reason: REASON });
        check('其他普通用户作废他人单 → 403 VOID_NOT_ALLOWED', r.status === 403 && r.body.code === 'VOID_NOT_ALLOWED', JSON.stringify(r.body));
        r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, { reason: REASON });
        check('建单人作废自己的待处理单 → 200 + 留痕齐', r.status === 200 && r.body.issue.voided_at && r.body.issue.voided_by === DEV_ID
            && r.body.issue.voided_by_name && r.body.issue.void_reason === REASON && r.body.issue.status === '待处理', JSON.stringify(r.body));
        r = await api('POST', `/api/issue-lite/${A.id}/void`, devTok, { reason: REASON });
        check('重复作废 → 409 ALREADY_VOIDED', r.status === 409 && r.body.code === 'ALREADY_VOIDED');

        // ===== 作废：来源态 =====
        await api('PUT', `/api/issue-lite/${B.id}/status`, fengTok, { status: '处理中' });
        r = await api('POST', `/api/issue-lite/${B.id}/void`, adminTok, { reason: REASON });
        check('admin 作废他人处理中单 → 200 + 原状态保留处理中', r.status === 200 && r.body.issue.status === '处理中' && r.body.issue.voided_at, JSON.stringify(r.body));

        // C：先传附件（供作废后删除测试）→ 完成 → 作废
        r = await upload(C.id, fengTok, 'void_test.txt', 'attachment before void');
        const attId = r.body && r.body.attachment && r.body.attachment.id;
        check('C 单作废前上传附件成功', r.status === 200 && attId, JSON.stringify(r.body));
        await api('PUT', `/api/issue-lite/${C.id}/status`, fengTok, { status: '已完成', complete_note: '看板交付完成，字段口径已对齐' });
        const cDone = (await api('GET', `/api/issue-lite/${C.id}`, fengTok)).body;
        check('C 单已完成且有 completed_at', cDone.status === '已完成' && !!cDone.completed_at);
        r = await api('POST', `/api/issue-lite/${C.id}/void`, fengTok, { reason: REASON });
        check('已完成单可作废且保留 completed_at/complete_note', r.status === 200 && r.body.issue.voided_at
            && r.body.issue.completed_at === cDone.completed_at && r.body.issue.complete_note === cDone.complete_note, JSON.stringify(r.body));

        // 已归档不可作废
        const D = await mk(adminTok, 'D归档');
        await api('PUT', `/api/issue-lite/${D.id}/status`, adminTok, { status: '已归档' });
        r = await api('POST', `/api/issue-lite/${D.id}/void`, adminTok, { reason: REASON });
        check('已归档不可作废 → 409 ARCHIVED_NOT_VOIDABLE', r.status === 409 && r.body.code === 'ARCHIVED_NOT_VOIDABLE', JSON.stringify(r.body));

        // ===== 列表可见性 =====
        let list = (await api('GET', '/api/issue-lite', fengTok)).body || [];
        check('默认列表不含已作废（A/B/C 均隐藏）', ![A.id, B.id, C.id].some(i => list.some(x => x.id === i)));
        check('默认列表仍含正常单 E/F', [E.id, F.id].every(i => list.some(x => x.id === i)));
        r = await api('GET', '/api/issue-lite?include_voided=1', fengTok);
        check('非 admin include_voided=1 → 403', r.status === 403 && r.body.code === 'INCLUDE_VOIDED_ADMIN_ONLY');
        r = await api('GET', '/api/issue-lite?include_voided=abc', adminTok);
        check('include_voided 非法值 → 400', r.status === 400 && r.body.code === 'INVALID_INCLUDE_VOIDED');
        list = (await api('GET', '/api/issue-lite?include_voided=1', adminTok)).body || [];
        check('admin 含已作废可见 A/B/C', [A.id, B.id, C.id].every(i => list.some(x => x.id === i)));

        // ===== 详情可见性 =====
        r = await api('GET', `/api/issue-lite/${A.id}`, fengTok);
        check('非 admin 看已作废详情 → 403 VOIDED_FORBIDDEN', r.status === 403 && r.body.code === 'VOIDED_FORBIDDEN');
        r = await api('GET', `/api/issue-lite/${A.id}`, devTok);
        check('建单人看自己已作废详情同样 403（可见性只认 admin）', r.status === 403 && r.body.code === 'VOIDED_FORBIDDEN');
        r = await api('GET', `/api/issue-lite/${A.id}`, adminTok);
        check('admin 看已作废详情 → 200 + 作废字段 + can_void=false', r.status === 200 && r.body.voided_at && r.body.void_reason === REASON && r.body.can_void === false, JSON.stringify(r.body && { v: r.body.voided_at, cv: r.body.can_void }));
        r = await api('GET', `/api/issue-lite/${E.id}`, fengTok);
        check('正常单建单人 can_void=true', r.status === 200 && r.body.can_void === true);
        r = await api('GET', `/api/issue-lite/${E.id}`, devTok);
        check('正常单非建单人普通用户 can_void=false', r.status === 200 && r.body.can_void === false);

        // ===== 作废后 9 条写路径全部拒绝（用 C：已完成后作废·由 admin/各角色发起均 409）=====
        r = await api('PUT', `/api/issue-lite/${C.id}/status`, adminTok, { status: '处理中' });
        check('①status → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('PUT', `/api/issue-lite/${C.id}/estimate`, adminTok, { estimated_at: '2026-08-01' });
        check('②estimate → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('POST', `/api/issue-lite/${C.id}/notify`, adminTok);
        check('③N1 notify → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('POST', `/api/issue-lite/${C.id}/notify-estimate`, adminTok);
        check('④N-est → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('POST', `/api/issue-lite/${C.id}/notify-requester`, adminTok);
        check('⑤N2 → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('POST', `/api/issue-lite/${C.id}/create-chat`, fengTok);
        check('⑥create-chat → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await upload(C.id, fengTok, 'after_void.txt', 'should be rejected');
        check('⑦附件上传 → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('DELETE', `/api/issue-lite/attachments/${attId}`, fengTok);
        check('⑧附件删除 → 409 VOIDED_LOCKED（admin 同样拒）', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('DELETE', `/api/issue-lite/attachments/${attId}`, adminTok);
        check('⑧b admin 删已作废单附件 → 409', r.status === 409 && r.body.code === 'VOIDED_LOCKED');
        r = await api('PUT', `/api/issue-lite/${C.id}/notify-target`, fengTok, { notify_target_id: DEV_ID });
        check('⑨notify-target → 409 VOIDED_LOCKED', r.status === 409 && r.body.code === 'VOIDED_LOCKED');

        // ===== 已作废单附件只读（admin 可列表/下载；非 admin 旁路 403——codex 14 H-3 写读同源）=====
        r = await api('GET', `/api/issue-lite/${C.id}/attachments`, adminTok);
        check('admin 读已作废单附件列表 → 200', r.status === 200 && Array.isArray(r.body) && r.body.some(x => x.id === attId));
        const dl = await fetch(`${BASE}/api/issue-lite/attachments/${attId}/download`, { headers: { Authorization: `Bearer ${await fx.signAs(ADMIN_ID)}` } });
        check('admin 下载已作废单附件 → 200', dl.status === 200 && (await dl.text()) === 'attachment before void');
        r = await api('GET', `/api/issue-lite/${C.id}/attachments`, fengTok);
        check('非 admin 读已作废单附件列表 → 403（旁路封堵）', r.status === 403 && r.body.code === 'VOIDED_FORBIDDEN', JSON.stringify(r.body));
        const dl2 = await fetch(`${BASE}/api/issue-lite/attachments/${attId}/download`, { headers: { Authorization: `Bearer ${fengTok}` } });
        let dl2Body = null; try { dl2Body = await dl2.json(); } catch (_) {}
        check('非 admin 按 aid 直连下载已作废单附件 → 403 VOIDED_FORBIDDEN（旁路封堵·验业务码防其它 403 误通过）',
            dl2.status === 403 && dl2Body && dl2Body.code === 'VOIDED_FORBIDDEN', JSON.stringify(dl2Body));

        // 条件 DELETE 层回归钉（codex 14 复审 L-3）：顺序请求打不到该防线（前置读检查先拦），
        //   直接对已作废父单的附件执行端点同款条件 DELETE SQL，钉住"作废后 SQL 层也删不动"
        const sqlChanges = await new Promise((resolve) => {
            const d = new sqlite3.Database(DB_FILE);
            d.run(`DELETE FROM issue_lite_attachments WHERE id = ? AND issue_lite_id IN (SELECT id FROM issue_lite WHERE voided_at IS NULL)`,
                [attId], function (e) { const c = e ? -1 : this.changes; d.close(() => resolve(c)); });
        });
        const attStill = (await api('GET', `/api/issue-lite/${C.id}/attachments`, adminTok)).body || [];
        check('条件 DELETE 对已作废父单 changes=0 且附件仍在（SQL 层防线钉住）',
            sqlChanges === 0 && attStill.some(x => x.id === attId), `changes=${sqlChanges}`);

        // ===== 并发边界（codex 14 M-2）：双 void 恰一个成功；后到者拿明确归类码 =====
        const G = await mk(fengTok, 'G并发');
        const [v1, v2] = await Promise.all([
            api('POST', `/api/issue-lite/${G.id}/void`, fengTok, { reason: REASON }),
            api('POST', `/api/issue-lite/${G.id}/void`, adminTok, { reason: REASON }),
        ]);
        const okCnt = [v1, v2].filter(x => x.status === 200).length;
        const conflict = [v1, v2].find(x => x.status === 409);
        check('双 void 并发：恰一个 200、一个 409', okCnt === 1 && !!conflict, `v1=${v1.status} v2=${v2.status}`);
        check('并发后到者错误码为 ALREADY_VOIDED（重读归类·不漂移为通用码）',
            conflict && conflict.body && conflict.body.code === 'ALREADY_VOIDED', conflict && JSON.stringify(conflict.body));

        // ===== 后补通知对象（E 示例用户A建·F 示例开发C建，均未选）=====
        r = await api('PUT', `/api/issue-lite/${E.id}/notify-target`, fengTok, { notify_target_id: 999 });
        check('后补非法对象(999) → 400 NOTIFY_TARGET_INVALID', r.status === 400 && r.body.code === 'NOTIFY_TARGET_INVALID');
        r = await api('PUT', `/api/issue-lite/${E.id}/notify-target`, fengTok, { notify_target_id: [DEV_ID] });
        check('后补对象数组蒙混 → 400', r.status === 400 && r.body.code === 'NOTIFY_TARGET_INVALID');
        r = await api('PUT', `/api/issue-lite/${F.id}/notify-target`, fengTok, { notify_target_id: DEV_ID });
        check('非建单人普通用户后补他人单 → 403', r.status === 403 && r.body.code === 'NOTIFY_TARGET_NOT_ALLOWED');
        r = await api('PUT', `/api/issue-lite/${E.id}/notify-target`, fengTok, { notify_target_id: DEV_ID });
        check('建单人后补空缺 → 200 + notify_target_id 写入', r.status === 200 && r.body.issue.notify_target_id === DEV_ID, JSON.stringify(r.body));
        // 末次审 M-2 后：示例用户A传 FENG_ID 会先命中 SELF_NOTIFY_TARGET——改用 admin 试改（非本人），仍验「已选定不可更改」
        r = await api('PUT', `/api/issue-lite/${E.id}/notify-target`, adminTok, { notify_target_id: FENG_ID });
        check('已选定不可更改 → 409 TARGET_ALREADY_SET', r.status === 409 && r.body.code === 'TARGET_ALREADY_SET', JSON.stringify(r.body));
        r = await api('PUT', `/api/issue-lite/${F.id}/notify-target`, adminTok, { notify_target_id: FENG_ID });
        check('admin 后补他人单 → 200', r.status === 200 && r.body.issue.notify_target_id === FENG_ID);
        r = await api('PUT', `/api/issue-lite/${D.id}/notify-target`, adminTok, { notify_target_id: FENG_ID });
        check('已归档单后补 → 409 ARCHIVED_LOCKED', r.status === 409 && r.body.code === 'ARCHIVED_LOCKED');
        r = await api('PUT', `/api/issue-lite/${E.id}/notify-target`, viewerTok, { notify_target_id: DEV_ID });
        check('viewer 后补 → 403', r.status === 403);
        // 末次审 M-2：后补是不可逆写入——服务端拒选本人（防单据永久卡在「对象是本人无法重选」）
        const H = await mk(devTok, 'H自选本人');
        r = await api('PUT', `/api/issue-lite/${H.id}/notify-target`, devTok, { notify_target_id: DEV_ID });
        check('后补选本人 → 400 SELF_NOTIFY_TARGET', r.status === 400 && r.body.code === 'SELF_NOTIFY_TARGET', JSON.stringify(r.body));

        // 末次审 M-3 SQL 层钉（轻复审 M-2 澄清：此为 **SQL 语义钉**非生产路径钉——生产 DELETE 行为契约由
        //   上方顺序 e2e（前置 403/409）钉住；本断言只文档化条件谓词语义，生产 SQL 若改动需人工同步此处）
        const X = await mk(fengTok, 'X归档附件');
        r = await upload(X.id, fengTok, 'arch_pin.txt', 'archived attachment');
        const archAttId = r.body && r.body.attachment && r.body.attachment.id;
        check('[夹具] X 单上传附件成功', !!archAttId);
        r = await api('PUT', `/api/issue-lite/${X.id}/status`, adminTok, { status: '已归档' });
        check('[夹具] X 归档 → 200', r.status === 200);
        const archChanges = await new Promise((resolve) => {
            const d = new sqlite3.Database(DB_FILE);
            d.run(`DELETE FROM issue_lite_attachments WHERE id = ? AND issue_lite_id IN (SELECT id FROM issue_lite WHERE voided_at IS NULL AND status != '已归档')`,
                [archAttId], function (e) { const c = e ? -1 : this.changes; d.close(() => resolve(c)); });
        });
        const archList = (await api('GET', `/api/issue-lite/${X.id}/attachments`, adminTok)).body || [];
        check('非 admin 条件 DELETE 对已归档父单 changes=0 且附件仍在（SQL 层防线钉住）', archChanges === 0 && archList.some(x => x.id === archAttId), `changes=${archChanges}`);
    } catch (e) {
        fail++;
        results.push(`  ❌ 异常中断：${e.message}`);
    } finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
        await new Promise(r => setTimeout(r, 500));
        await cleanupTestRows();
    }

    console.log('─────── Commit B 作废后端 verify ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? `✅ PASS（${pass}/${pass + fail}）` : `❌ FAIL（${fail} 项失败 / 共 ${pass + fail}）`}`);
    process.exit(fail === 0 ? 0 : 1);
})();
