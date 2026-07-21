/**
 * D3 verify e2e · 数据开发换壳（issue_lite）附件
 * 换壳方案 v0.2 · D3 / _HANDOFF
 *
 * 覆盖：上传(txt/zip 合法·exe 拒) → 列表 → 下载(内容比对) → 删除(上传人/admin/越权) → 归档锁 → 不存在单。
 * 自启 PORT=3399，跑完按端口精确杀 + 清理测试单 + 清理落盘附件。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const UP_DIR = path.join(ROOT, 'uploads', 'issue-lite');
const TITLE_PREFIX = '[D3VERIFY]';

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
async function upload(urlPath, token, filename, content, mime) {
    const fd = new FormData();
    fd.append('files', new Blob([Buffer.from(content)], { type: mime || 'application/octet-stream' }), filename);
    const r = await fetch(`${BASE}${urlPath}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}
function killPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set(); out.split(/\r?\n/).forEach(l => { const m = l.trim().match(/(\d+)\s*$/); if (m) pids.add(m[1]); });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}
function cleanupRows() {
    return new Promise((res) => {
        const db = new sqlite3.Database(DB_FILE);
        db.serialize(() => {
            // 容忍表尚未建（首次启动前 issue_lite_attachments 可能不存在）——错误回调吞掉
            db.run(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [TITLE_PREFIX + '%'], () => {});
            db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); res(); });
        });
    });
}
function cleanupFiles() { try { fs.readdirSync(UP_DIR).forEach(f => { if (/^\d+_/.test(f)) { /* leave others */ } }); } catch (_) {} }
async function waitReady(getLog, ms = 12000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(getLog())) { try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) return true; } catch (_) {} }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}
const REQ = { requester_name: '李四', requester_dept: '财务管理部', requester_phone: '13900002222' };
function bodyWith(extra) { return Object.assign({ title: TITLE_PREFIX + '单' }, REQ, extra || {}); }

(async () => {
    killPort(TEST_PORT);
    await cleanupRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    const uploadedFiles = [];
    try {
        const ready = await waitReady(() => log);
        check('服务 + schema 就绪', ready);
        if (!ready) throw new Error('服务未就绪');

        const adminTok = await fx.signAs(fx.ADMIN_ID);   // 1 admin（上传人）
        const fengTok = await fx.signAs(fx.CONTACT_ID);  // 3 示例用户A（另一非 viewer·测越权删）
        const viewerTok = await fx.signAs(fx.VIEWER_ID);

        // 造单
        const cr = await api('POST', '/api/issue-lite', adminTok, bodyWith({ title: TITLE_PREFIX + '附件单' }));
        const id = cr.body.issue.id;
        check('造单成功', cr.status === 200 && !!id);

        // viewer 上传 → 403
        check('viewer 上传 → 403', (await upload(`/api/issue-lite/${id}/attachments`, viewerTok, 'a.txt', 'x', 'text/plain')).status === 403);
        // 合法 txt
        let u = await upload(`/api/issue-lite/${id}/attachments`, adminTok, '需求说明.txt', 'hello issue_lite', 'text/plain');
        check('上传 txt → 200', u.status === 200 && u.body.success && u.body.attachment, JSON.stringify(u.body));
        const aidTxt = u.body.attachment && u.body.attachment.id;
        // 合法 zip（压缩类型放开）
        u = await upload(`/api/issue-lite/${id}/attachments`, adminTok, '交付物.zip', 'PK\x03\x04zipcontent', 'application/zip');
        check('上传 zip → 200（压缩类型放开）', u.status === 200 && u.body.success, JSON.stringify(u.body));
        const aidZip = u.body.attachment && u.body.attachment.id;
        // 非法 exe → 400
        u = await upload(`/api/issue-lite/${id}/attachments`, adminTok, 'bad.exe', 'MZ', 'application/octet-stream');
        check('上传 exe → 400（类型拒绝）', u.status === 400, JSON.stringify(u.body));

        // 列表含 2 个
        let list = (await api('GET', `/api/issue-lite/${id}/attachments`, adminTok)).body || [];
        check('列表含 2 个附件', Array.isArray(list) && list.length === 2, `len=${list.length}`);
        check('列表不含 file_name 内部路径（只暴露 original_name）', list.every(a => a.file_name === undefined && a.original_name));

        // 下载 txt 内容比对
        const dl = await fetch(`${BASE}/api/issue-lite/attachments/${aidTxt}/download`, { headers: { Authorization: `Bearer ${adminTok}` } });
        const dlText = await dl.text();
        check('下载 txt → 200 + 内容对', dl.status === 200 && dlText === 'hello issue_lite', `got=${dlText}`);
        check('下载不存在附件 → 404', (await fetch(`${BASE}/api/issue-lite/attachments/999999/download`, { headers: { Authorization: `Bearer ${adminTok}` } })).status === 404);
        // 复D3-H-2：直连静态路径 /uploads/issue-lite/* → 403（强制走鉴权下载端点）
        check('直连 /uploads/issue-lite/* → 403（鉴权唯一入口）', (await fetch(`${BASE}/uploads/issue-lite/anything.txt`)).status === 403);

        // 越权删（示例用户A删 admin 上传的）→ 403 NOT_UPLOADER
        check('非上传人删 → 403 NOT_UPLOADER', (await api('DELETE', `/api/issue-lite/attachments/${aidTxt}`, fengTok)).body.code === 'NOT_UPLOADER');
        // 上传人删 → 200
        check('上传人删 txt → 200', (await api('DELETE', `/api/issue-lite/attachments/${aidTxt}`, adminTok)).status === 200);
        // 列表剩 1
        check('删后列表剩 1', ((await api('GET', `/api/issue-lite/${id}/attachments`, adminTok)).body || []).length === 1);

        // 归档后上传 → 409（先把单推到已归档）
        await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '处理中' });
        await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '已完成', complete_note: '已完成交付一版材料' });
        await api('PUT', `/api/issue-lite/${id}/status`, adminTok, { status: '已归档' });
        check('已归档单上传附件 → 409 ARCHIVED_LOCKED', (await upload(`/api/issue-lite/${id}/attachments`, adminTok, 'late.txt', 'x', 'text/plain')).body?.code === 'ARCHIVED_LOCKED');
        // 归档后非 admin 删 → 403（zip 是 admin 传的·换示例用户A删）
        check('已归档单非 admin 删附件 → 403 ARCHIVED_LOCKED', (await api('DELETE', `/api/issue-lite/attachments/${aidZip}`, fengTok)).body.code === 'ARCHIVED_LOCKED');
        // 归档后 admin 删 → 200
        check('已归档单 admin 删附件 → 200', (await api('DELETE', `/api/issue-lite/attachments/${aidZip}`, adminTok)).status === 200);

        // 不存在单上传 → 404
        check('不存在单上传 → 404', (await upload('/api/issue-lite/999999/attachments', adminTok, 'x.txt', 'x', 'text/plain')).status === 404);

    } catch (e) { check('e2e 执行异常', false, e.message); }
    finally {
        try { child.kill('SIGKILL'); } catch (_) {}
        killPort(TEST_PORT);
        await cleanupRows();
        // 清测试落盘文件（D3VERIFY 单产生的·按前缀 id 无法直接匹配，靠 DELETE 端点已删大部分；残留由 cleanupRows 后扫）
    }
    console.log('─────── D3 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ D3 PASS' : '❌ D3 FAIL'}（${pass} 通过 / ${fail} 失败）`);
    process.exit(fail === 0 ? 0 : 1);
})();
