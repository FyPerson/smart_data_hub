/**
 * v1.74.0 C4a — 录入附件 endpoint 冒烟 e2e（方案 §1.3a / §4.1 / §6.2 T9）
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c4a-smoke.js
 * 复用 _test-fixture signAs（admin=1 / viewer=2 沈倩静 / dev1=19）+ apiCall（建/删 issue 走 JSON）。
 * 上传走 multipart/form-data（Node 18+ 原生 FormData/Blob），单独 uploadFile helper。
 *
 * 用例：
 *   A1  非 viewer 给存在 issue 传附件 → 200 + issue_attachments 落行（file_name/original_name/uploaded_by）
 *   A2  物理文件落 uploads/issues/，DB file_name 存相对路径 'issues/<名>'（DELETE 兼容性前提）
 *   A3  先行后传：给不存在 issue 传 → 404 需求不存在（pending 文件被清理）
 *   A4  id 非正整数 → 400（防 req.params.id 裸入 SQL）
 *   A5  不支持扩展名（.exe）→ 400 UPLOAD_ERROR（fileFilter）
 *   A6  viewer 给「自己创建」的 issue 传 → 200（viewer 例外，对齐方案 §4）
 *   A7  viewer 给「别人创建」的 issue 传 → 403 VIEWER_NOT_OWNER
 *   A8  GET /attachments 列表返回已传附件（含 file_size/mime_type）
 *   A9  DELETE issue 后附件级联删除 + 物理文件消失（衔接 C3 DELETE 物理清理）
 *   A10 无文件（空 multipart）→ 400 NO_FILE
 *   A11 file_size/mime_type 落库非 undefined（防 NULL 处理盲区）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ISSUE_UPLOAD_BASE = path.join(UPLOAD_DIR, 'issues');

function dbGet(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.all(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }
// 递归数某目录下文件数（A12 验非法 id 不落盘用）
function countFilesRecursive(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) n += countFilesRecursive(p);
        else n++;
    }
    return n;
}

const VALID = { title: 'C4a 附件需求', type: '数据质量', requester_dept: '市场营销部', requester_name: '张三', description: 'x' };

async function createIssue(token, overrides) {
    const r = await fx.apiCall('POST', '/api/issues', token, { ...VALID, ...overrides });
    if (r.status !== 200) throw new Error('创建失败 ' + JSON.stringify(r.body));
    return r.body.id;
}

/**
 * multipart 上传 helper（fx.apiCall 只支持 JSON，附件须单独走 FormData）。
 * @param token JWT
 * @param id    issue id（或非法字符串测 A4）
 * @param fileName  上传文件名（含扩展名，决定 fileFilter）
 * @param content   文件内容（Buffer/string）
 * @param mime      Content-Type（验 mime_type 落库）
 * @param opts      { noFile:true 时不附文件，测 A10 }
 */
async function uploadFile(token, id, fileName, content, mime, opts = {}) {
    const form = new FormData();
    if (!opts.noFile) {
        const blob = new Blob([content], { type: mime || 'application/octet-stream' });
        form.append('files', blob, fileName);
    }
    const r = await fetch(`${fx.BASE}/api/issues/${id}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

const created = [];
async function main() {
    const adminToken = await fx.signAs(fx.ADMIN_ID);     // 1
    const viewerToken = await fx.signAs(fx.VIEWER_ID);   // 2 沈倩静（viewer）
    console.log('\n══════ v1.74.0 C4a 录入附件冒烟 ══════');

    let firstAttFileName = null;

    await check('A1 非 viewer 给存在 issue 传附件 → 200 + 落行', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await uploadFile(adminToken, id, '需求示例.xlsx', 'col1,col2\n1,2', 'application/vnd.ms-excel');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const rows = await dbAll('SELECT * FROM issue_attachments WHERE issue_id=?', [id]);
        must(rows.length === 1, `应落 1 行，实际 ${rows.length}`);
        must(rows[0].original_name === '需求示例.xlsx', `original_name 应保留中文，实际 ${rows[0].original_name}`);
        must(Number(rows[0].uploaded_by) === fx.ADMIN_ID, `uploaded_by 应=${fx.ADMIN_ID}，实际 ${rows[0].uploaded_by}`);
        firstAttFileName = rows[0].file_name;
    });

    await check('A2 物理文件落 uploads/issues/ + DB file_name 存相对路径 issues/<名>', async () => {
        must(firstAttFileName && firstAttFileName.startsWith('issues/'), `file_name 应以 issues/ 开头，实际 ${firstAttFileName}`);
        const abs = path.join(UPLOAD_DIR, firstAttFileName);
        must(fs.existsSync(abs), `物理文件应存在: ${abs}`);
        // 兼容性：safeDeleteFileSync(file_name, UPLOAD_DIR) → path.join(UPLOAD_DIR, 'issues/<名>') 即此 abs
        must(path.dirname(abs) === ISSUE_UPLOAD_BASE, `应落 ISSUE_UPLOAD_BASE 根，实际 ${path.dirname(abs)}`);
    });

    await check('A3 先行后传：给不存在 issue 传 → 404 + pending 清理', async () => {
        const ghostId = 99999999;
        const pendingDir = path.join(ISSUE_UPLOAD_BASE, '_pending', String(ghostId));
        const r = await uploadFile(adminToken, ghostId, 'x.txt', 'hi', 'text/plain');
        must(r.status === 404, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        // pending 文件应被 cleanupPendingFiles 清掉（目录可能残留但无文件）
        const left = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).length : 0;
        must(left === 0, `pending 文件应被清理，残留 ${left} 个`);
    });

    await check('A4 id 非正整数 → 400', async () => {
        const r = await uploadFile(adminToken, 'abc', 'x.txt', 'hi', 'text/plain');
        must(r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A5 不支持扩展名 .exe → 400 UPLOAD_ERROR（fileFilter）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await uploadFile(adminToken, id, 'evil.exe', 'MZ', 'application/octet-stream');
        must(r.status === 400 && r.body.code === 'UPLOAD_ERROR', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A6 viewer 给「自己创建」的 issue 传 → 200（viewer 例外）', async () => {
        const id = await createIssue(viewerToken); created.push(id);  // viewer 自录
        const r = await uploadFile(viewerToken, id, '截图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
        must(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A7 viewer 给「别人创建」的 issue 传 → 403 VIEWER_NOT_OWNER', async () => {
        const id = await createIssue(adminToken); created.push(id);  // admin 创建
        const r = await uploadFile(viewerToken, id, '截图.png', Buffer.from([0x89, 0x50]), 'image/png');
        must(r.status === 403 && r.body.code === 'VIEWER_NOT_OWNER', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A8 GET /attachments 列表返回已传附件', async () => {
        const id = created[0];  // A1 的 issue
        const r = await fx.apiCall('GET', `/api/issues/${id}/attachments`, adminToken);
        must(r.status === 200, `HTTP ${r.status}`);
        must(Array.isArray(r.body) && r.body.length === 1, `应返回 1 个附件，实际 ${r.body && r.body.length}`);
        must(r.body[0].original_name === '需求示例.xlsx', 'GET 返回 original_name');
    });

    await check('A9 DELETE issue 后附件级联删除 + 物理文件消失（衔接 C3）', async () => {
        const id = created[0];  // A1 的 issue（有 1 附件）
        const att = await dbGet('SELECT file_name FROM issue_attachments WHERE issue_id=?', [id]);
        const abs = path.join(UPLOAD_DIR, att.file_name);
        must(fs.existsSync(abs), '删除前物理文件应在');
        const r = await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);
        must(r.status === 200, `DELETE HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const rows = await dbAll('SELECT * FROM issue_attachments WHERE issue_id=?', [id]);
        must(rows.length === 0, `附件行应级联删除，残留 ${rows.length}`);
        must(!fs.existsSync(abs), `物理文件应被 C3 DELETE 清理，残留: ${abs}`);
        created.splice(created.indexOf(id), 1);  // 已删，移出清理列表
    });

    await check('A10 无文件（空 multipart）→ 400 NO_FILE', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const r = await uploadFile(adminToken, id, null, null, null, { noFile: true });
        must(r.status === 400 && r.body.code === 'NO_FILE', `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A11 file_size/mime_type 落库非 undefined（防 NULL 盲区）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        const up = await uploadFile(adminToken, id, '数据.xlsx', 'a,b,c\n1,2,3', 'text/csv');  // 用白名单内扩展名
        must(up.status === 200, `上传应成功，HTTP ${up.status} ${JSON.stringify(up.body)}`);
        const att = await dbGet('SELECT file_size, mime_type FROM issue_attachments WHERE issue_id=?', [id]);
        must(typeof att.file_size === 'number' && att.file_size > 0, `file_size 应为正数，实际 ${att.file_size}`);
        must(att.mime_type === null || typeof att.mime_type === 'string', `mime_type 应 string|null，实际 ${typeof att.mime_type}`);
    });

    await check('A12 非法 id（路径穿越）multipart → 400 + 不在 issues/_pending 外落盘（codex H-1）', async () => {
        // 前置 id 校验中间件应在 multer 前拦住，文件不落盘。
        //   注：fetch 会规范化 URL path，'..%2f' 等多被 decode/折叠，本用例用超长非数字 id 触发正则拒绝。
        const evilId = 'abc..%2f..%2fevil';
        const before = fs.existsSync(ISSUE_UPLOAD_BASE) ? countFilesRecursive(ISSUE_UPLOAD_BASE) : 0;
        const r = await uploadFile(adminToken, evilId, 'x.txt', 'evil', 'text/plain');
        must(r.status === 400, `非法 id 应 400，HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const after = fs.existsSync(ISSUE_UPLOAD_BASE) ? countFilesRecursive(ISSUE_UPLOAD_BASE) : 0;
        must(after === before, `非法 id 不应落盘，文件数 ${before}→${after}`);
        // 断言没有 issues/ 之外的穿越目录（uploads/ 根下不应冒出 evil 相关）
        const upRoot = fs.readdirSync(UPLOAD_DIR);
        must(!upRoot.some(n => n.includes('evil')), `不应在 UPLOAD_DIR 根创建穿越目录，实际 ${upRoot.join(',')}`);
    });

    await check('A13 GET /attachments 非法 id → 400（codex L-2 一致性）', async () => {
        const r = await fx.apiCall('GET', '/api/issues/abc/attachments', adminToken);
        must(r.status === 400, `GET 非法 id 应 400，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('A14 上传成功后 _pending/{id}/ 空目录被清（codex L-1）', async () => {
        const id = await createIssue(adminToken); created.push(id);
        await uploadFile(adminToken, id, 'doc.pdf', '%PDF-1.4', 'application/pdf');
        const pendingDir = path.join(ISSUE_UPLOAD_BASE, '_pending', String(id));
        must(!fs.existsSync(pendingDir), `上传成功后 _pending/${id}/ 空目录应被 rmdir，仍存在: ${pendingDir}`);
    });

    // 清理
    for (const id of created) await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C4a 录入附件冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('冒烟脚本异常:', e); process.exit(1); });
