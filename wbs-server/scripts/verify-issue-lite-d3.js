/**
 * D3 verify e2e · 数据开发换壳（issue_lite）附件
 * 换壳方案 v0.2 · D3 / docs/local/HANDOFF.md 附录 A
 *
 * 覆盖：上传(txt/zip 合法·exe 拒) → 列表 → 下载(内容比对) → 删除(上传人/admin/越权) → 归档锁 → 不存在单。
 * [#106 S4b1] 不再自 spawn 服务、不再写死端口 3399、不再按端口杀进程、不再等日志轮询、不再读写真实库：经 scripts/lib/test-env.js 自起临时隔离实例
 *   （来源 = 本检出本地库快照，钉钉走替身、周期任务关闭），也可由 TEST_* 变量组指向已起好的隔离实例；跑完收掉实例并清理测试单（附件由端点删除）。
 *   实例数据根的删除按形态分：自起实例时由 teardown 删除；变量组（共享实例）形态下 teardown 不做事，数据根由批跑器收实例时删除。
 */
'use strict';
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

let BASE = null;       // ready() 之后赋值
let DB_FILE = null;    // ready() 之后赋值（实例库）
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
function cleanupRows() {
    return new Promise((res) => {
        const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (oe) => {
            if (oe) return res(`打开实例库失败：${oe.message}`);   // 返回错误描述（null = 成功）；调用方计失败，不吞
            let attErr = null;
            db.serialize(() => {
                // 实例库是已就绪服务的快照，附件表必然存在：两条 DELETE 的错误都不吞
                db.run(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [TITLE_PREFIX + '%'], (e1) => { if (e1) attErr = e1; });
                db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], (e2) => {
                    db.close(() => res(attErr ? `DELETE 附件失败：${attErr.message}` : (e2 ? `DELETE 失败：${e2.message}` : null)));
                });
            });
        });
    });
}
// 服务就绪 = 两次真实请求：health/ready 里 issue_lite 模块 ready + 未带 token 访问列表 401（服务确实在应答 issue_lite 路由）
async function issueLiteServiceReady() {
    try {
        const hr = await fetch(`${BASE}/api/health/ready`);
        const hb = await hr.json().catch(() => null);
        const m = hb && hb.modules && hb.modules.issue_lite;
        if (!m || m.ready !== true) return false;
        return (await fetch(`${BASE}/api/issue-lite`)).status === 401;
    } catch (_) { return false; }
}
const REQ = { requester_name: '李四', requester_dept: '财务管理部', requester_phone: '13900002222' };
function bodyWith(extra) { return Object.assign({ title: TITLE_PREFIX + '单' }, REQ, extra || {}); }

(async () => {
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪
    try {
        BASE = fx.BASE;
        DB_FILE = fx.DB_PATH;
        const ce0 = await cleanupRows();
        if (ce0) check('清理历史测试单', false, ce0);
        const ready = await issueLiteServiceReady();
        check('health/ready issue_lite 就绪 + 未带 token 列表 401', ready);
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
        if (DB_FILE) { const ce = await cleanupRows(); if (ce) check('清理测试单', false, ce); }
        // 落盘附件：D3VERIFY 单的附件由 DELETE 端点删除，残留在实例数据根里：自起实例时随 teardown 一并删除，变量组（共享实例）形态下由批跑器收实例时删除
        try { await fx.teardown(); } catch (e) { check('teardown（收掉自起实例）', false, e.message); }
    }
    console.log('─────── D3 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ D3 PASS' : '❌ D3 FAIL'}（${pass} 通过 / ${fail} 失败）`);
    fx.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + 10 秒 unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('D3 verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
