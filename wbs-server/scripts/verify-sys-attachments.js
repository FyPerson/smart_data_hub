// 验证脚本：系统迭代 C3b 附件（上传 / submit 绑 round_no / 下载 / 删除 / supersede）
//   用法：node scripts/verify-sys-attachments.js
//
// in-process express app（挂真实 router）+ 内存库 + 真实临时落盘（_sys-attach-test-deps）+ 自签 token，覆盖：
//   1. 上传 delivery/screenshot（开发本人·开发中，round_no=NULL 暂存）/ spec（admin·非作废）
//   2. 上传权限/状态/类型/无文件负向（403/409/400）
//   3. submit 绑 delivery+screenshot round_no（11-H2/RC-M4）+ timeline round_no
//   4. orphan 回滚：submit 传非法 id → 400 + 整事务 ROLLBACK（已传 id 不被绑、status 不变）
//   5. spec 不被 submit 绑定（11-H2）
//   6. supersede（10-M1 旧 spec superseded + 新 active）+ active 过滤（详情仅 active）
//   7. 12-M1 二次 WHERE attachment_type 守卫：spec supersede 不误伤 delivery
//   8. 下载（admin/指派开发 200，其他 403，不存在 404，作废非 admin 403）
//   9. 删除（未绑 delivery 上传本人 / spec admin；已绑 delivery 409；非授权 403）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./_sys-attach-test-deps');   // A9：物理删除/越界路径断言用真实落盘根
const absOf = (relFileName) => path.join(UPLOAD_DIR, relFileName);   // file_name 相对 UPLOAD_DIR

const SECRET = 'verify-sys-attach-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // C3b：真实临时落盘 + normalizeAttachmentExt/safeDeleteFileSync/ALLOWED_FILE_DIRS
});
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);

let server, port;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

// JSON 端点
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// multipart 上传（fileName=null → 不带文件，测 NO_FILE）
function upload(path, tok, fields, fileName, fileBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysAttBoundary' + (path.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(fileBuf || png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
// 下载（不解析 body，只取 status + 字节数）
function download(path, tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { 'Authorization': 'Bearer ' + tok } },
      (r) => { let n = 0; r.on('data', c => n += c.length); r.on('end', () => resolve({ status: r.statusCode, bytes: n })); });
    req.on('error', reject); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function seedDev(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  const tok = assignTo === 5 ? devTok : dev2Tok;
  r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
const ATT = (id) => `/api/sys-issues/${id}/attachments`;
const attRow = (attId) => get('SELECT id, attachment_type, round_no, status FROM sys_issue_attachments WHERE id=?', [attId]);
const activeAtts = (id) => all("SELECT id, attachment_type, round_no FROM sys_issue_attachments WHERE issue_id=? AND status='active' ORDER BY id", [id]);

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ── [1] 上传 delivery / screenshot / spec（正向）──
    const id1 = await seedDev(5);
    let r = await upload(ATT(id1), devTok, { attachment_type: 'delivery' }, 'a.png');
    assert.strictEqual(r.status, 200, 'delivery 上传 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const d1 = r.body.attachments[0].id;
    let row = await attRow(d1);
    assert.strictEqual(row.attachment_type, 'delivery'); assert.strictEqual(row.round_no, null); assert.strictEqual(row.status, 'active');
    ok('上传 delivery（开发本人·开发中）→ 200，round_no=NULL 暂存 active');

    r = await upload(ATT(id1), devTok, { attachment_type: 'screenshot' }, 's.png');
    assert.strictEqual(r.status, 200, 'screenshot 200');
    const s1 = r.body.attachments[0].id;
    assert.strictEqual((await attRow(s1)).round_no, null);
    ok('上传 screenshot（开发本人）→ 200，round_no=NULL 暂存');

    r = await upload(ATT(id1), adminTok, { attachment_type: 'spec' }, 'spec.pdf');
    assert.strictEqual(r.status, 200, 'spec 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const spec1 = r.body.attachments[0].id;
    assert.strictEqual((await attRow(spec1)).round_no, null);
    ok('上传 spec（admin）→ 200，round_no=NULL（永不被 submit 绑）');

    // ── [2] 上传负向（权限/状态/类型/无文件）──
    r = await upload(ATT(id1), devTok, { attachment_type: 'spec' }, 'x.pdf');
    assert.strictEqual(r.status, 403, 'spec 非 admin 403'); assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT');
    ok('上传 spec by 开发 → 403（需求材料仅 admin）');
    r = await upload(ATT(id1), adminTok, { attachment_type: 'delivery' }, 'x.png');
    assert.strictEqual(r.status, 403, 'delivery 非 assignee(admin) 403');
    ok('上传 delivery by admin（非 assignee）→ 403');
    r = await upload(ATT(id1), dev2Tok, { attachment_type: 'delivery' }, 'x.png');
    assert.strictEqual(r.status, 403, 'delivery 非本人开发 403');
    ok('上传 delivery by dev2（非指派本人）→ 403');
    r = await upload(ATT(id1), devTok, { attachment_type: 'bogus' }, 'x.png');
    assert.strictEqual(r.status, 400, 'type 非法 400'); assert.strictEqual(r.body.code, 'INVALID_ATTACHMENT_TYPE');
    ok('上传 attachment_type=bogus → 400 INVALID_ATTACHMENT_TYPE');
    r = await upload(ATT(id1), devTok, { attachment_type: 'delivery' }, null);
    assert.strictEqual(r.status, 400, '无文件 400'); assert.strictEqual(r.body.code, 'NO_FILE');
    ok('上传无文件 → 400 NO_FILE');

    // ── [3] submit 绑 round_no：判断① delivery-only（screenshot/spec 松散不绑，SSOT 11-H2/RC-M4）+ A2 严格校验 ──
    // A2：attachment_ids 非数组 / 含非正整数 → 400
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { summary: 'x', attachment_ids: 'notarray' });
    assert.strictEqual(r.status, 400, 'attachment_ids 非数组 400'); assert.strictEqual(r.body.code, 'SUBMIT_ATTACHMENT_INVALID');
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { summary: 'x', attachment_ids: [d1, 'bad'] });
    assert.strictEqual(r.status, 400, 'attachment_ids 含非整数 400'); assert.strictEqual(r.body.code, 'SUBMIT_ATTACHMENT_INVALID');
    assert.strictEqual((await attRow(d1)).round_no, null, 'A2：非法校验先于绑定，d1 未绑（整事务回滚）');
    ok('A2：submit attachment_ids 非数组 / 含非正整数 → 400（不静默丢弃）+ 整事务回滚');
    // 判断①：screenshot 误入 attachment_ids → 400（与 spec 同为松散，不可绑）
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { summary: '完成', attachment_ids: [d1, s1] });
    assert.strictEqual(r.status, 400, 'submit 含 screenshot id 400'); assert.strictEqual(r.body.code, 'SUBMIT_ATTACHMENT_INVALID');
    assert.strictEqual((await attRow(d1)).round_no, null, 'd1 未绑（整事务回滚）');
    ok('判断①：submit 传 screenshot id → 400（delivery-only，screenshot 松散不绑）+ 整事务回滚');
    // 仅传 delivery → 200，d1 绑 round=1；s1(screenshot)/spec1 保持松散 NULL
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { summary: '完成', attachment_ids: [d1] });
    assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual((await attRow(d1)).round_no, 1, 'delivery 绑 round_no=1');
    assert.strictEqual((await attRow(s1)).round_no, null, 'screenshot 松散 round_no=NULL（不绑，判断①）');
    assert.strictEqual((await attRow(spec1)).round_no, null, 'spec round_no=NULL（不绑，11-H2）');
    const tl = await get("SELECT round_no FROM sys_issue_timeline WHERE issue_id=? AND event_type='submit'", [id1]);
    assert.strictEqual(tl.round_no, 1, 'submit timeline round_no=1');
    ok('submit 仅绑 delivery round_no=1 + timeline round_no=1；screenshot/spec 松散不绑（判断① delivery-only）');

    // 详情 GET active（含 round_no 供前端分组）+ A7 specAttachments/hasSpecAttachment
    r = await call('GET', `/api/sys-issues/${id1}`, adminTok);
    assert.strictEqual(r.body.attachments.length, 3, '详情 3 个 active 附件');
    assert.ok(r.body.attachments.every(a => 'round_no' in a), 'A9：每个附件含 round_no 供前端分组');
    assert.strictEqual(r.body.hasSpecAttachment, true, 'A7 hasSpecAttachment=true');
    assert.strictEqual(r.body.specAttachments.length, 1, 'A7 specAttachments 1 个');
    assert.strictEqual(r.body.specAttachments[0].id, spec1, 'A7 specAttachments=spec 子集');
    ok('详情 GET active 附件 + 每附件 round_no + A7 specAttachments/hasSpecAttachment（12-M2）');

    // ── [4] orphan 回滚：submit 传非法 id → 400 + 整事务 ROLLBACK ──
    const id2 = await seedDev(5);
    r = await upload(ATT(id2), devTok, { attachment_type: 'delivery' }, 'b.png');
    const d2 = r.body.attachments[0].id;
    r = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, { summary: 'x', attachment_ids: [d2, 999999] });
    assert.strictEqual(r.status, 400, 'submit 含非法 id 400'); assert.strictEqual(r.body.code, 'SUBMIT_ATTACHMENT_INVALID');
    assert.strictEqual((await attRow(d2)).round_no, null, 'orphan 回滚：合法 id d2 未被绑（仍 NULL）');
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id2])).status, '开发中', 'orphan 回滚：status 仍开发中（整事务 ROLLBACK）');
    ok('orphan 回滚：submit 含非法 id → 400 + d2 未绑 + status 不变（BEGIN IMMEDIATE 整事务 ROLLBACK）');

    // ── [5] spec 不被 submit 绑：传 spec id 进 attachment_ids → 400（白名单排除 spec）──
    const id3 = await seedDev(5);
    r = await upload(ATT(id3), devTok, { attachment_type: 'delivery' }, 'c.png'); const d3 = r.body.attachments[0].id;
    r = await upload(ATT(id3), adminTok, { attachment_type: 'spec' }, 'sp.pdf'); const spec3 = r.body.attachments[0].id;
    r = await call('POST', `/api/sys-issues/${id3}/submit`, devTok, { summary: 'x', attachment_ids: [d3, spec3] });
    assert.strictEqual(r.status, 400, '传 spec id submit 400');
    assert.strictEqual((await attRow(spec3)).round_no, null, 'spec 不被绑');
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id3])).status, '开发中', 'spec 误传整事务回滚');
    // 仅传 delivery → 成功
    r = await call('POST', `/api/sys-issues/${id3}/submit`, devTok, { summary: 'x', attachment_ids: [d3] });
    assert.strictEqual(r.status, 200, '仅 delivery submit 200');
    assert.strictEqual((await attRow(d3)).round_no, 1, 'd3 绑 round_no=1');
    ok('spec id 误入 attachment_ids → 400 整事务回滚；仅传 delivery → 200 绑 round=1（11-H2 白名单）');

    // ── [6] supersede（10-M1）+ active 过滤 ──
    const id4 = await seedDev(5);
    r = await upload(ATT(id4), adminTok, { attachment_type: 'spec' }, 'v1.pdf'); const specA = r.body.attachments[0].id;
    r = await upload(ATT(id4), adminTok, { attachment_type: 'spec', supersede_id: String(specA) }, 'v2.pdf'); const specB = r.body.attachments[0].id;
    assert.strictEqual(r.status, 200, 'spec 替换 200');
    assert.strictEqual((await attRow(specA)).status, 'superseded', '旧 spec superseded');
    assert.strictEqual((await attRow(specB)).status, 'active', '新 spec active');
    const act4 = await activeAtts(id4);
    assert.ok(act4.every(a => a.id !== specA), 'active 过滤：旧 spec 不在 active 列表');
    assert.ok(act4.some(a => a.id === specB), '新 spec 在 active 列表');
    ok('supersede：旧 spec superseded + 新 active；详情 active 过滤排除旧 spec（10-M1）');

    // ── [7] 12-M1 二次 WHERE attachment_type 守卫：spec supersede 不误伤 delivery ──
    const id5 = await seedDev(5);
    r = await upload(ATT(id5), devTok, { attachment_type: 'delivery' }, 'd.png'); const d5 = r.body.attachments[0].id;
    r = await upload(ATT(id5), adminTok, { attachment_type: 'spec', supersede_id: String(d5) }, 'sp5.pdf');   // 用 spec 上传去 supersede 一个 delivery id
    assert.strictEqual(r.status, 200, 'spec 上传 200');
    assert.strictEqual((await attRow(d5)).status, 'active', '12-M1：delivery 未被 spec-supersede 误伤（仍 active）');
    assert.strictEqual((await attRow(d5)).round_no, null, '12-M1：delivery round_no 未动');
    ok('12-M1：spec supersede 的二次 WHERE attachment_type=spec → 不误伤 delivery（仍 active）');

    // ── [8] 下载（权限 + 不存在 + 作废）──
    const dlPath = (id, attId) => `/api/sys-issues/${id}/attachments/${attId}/download`;
    let dl = await download(dlPath(id1, d1), adminTok);
    assert.strictEqual(dl.status, 200, '下载 admin 200'); assert.ok(dl.bytes > 0, '下载有字节');
    ok('下载：admin → 200 + 字节 > 0');
    dl = await download(dlPath(id1, d1), devTok);
    assert.strictEqual(dl.status, 200, '下载 assignee 200');
    ok('下载：指派开发本人 → 200');
    dl = await download(dlPath(id1, d1), dev2Tok);
    assert.strictEqual(dl.status, 403, '下载非授权 403');
    ok('下载：dev2（非 admin/非 assignee）→ 403');
    dl = await download(dlPath(id1, 888888), adminTok);
    assert.strictEqual(dl.status, 404, '下载不存在 404');
    ok('下载：不存在 attId → 404');
    // 跨单越权：用 id2 的路径取 id1 的附件 id（二次 WHERE issue_id 不匹配）→ 404
    dl = await download(dlPath(id2, d1), adminTok);
    assert.strictEqual(dl.status, 404, '跨单附件 404');
    ok('下载：跨单 attId（issue_id 不匹配二次 WHERE）→ 404');

    // ── [9] 删除（未绑 delivery 本人 / spec admin / 已绑 409 / 非授权 403）──
    const id6 = await seedDev(5);
    r = await upload(ATT(id6), devTok, { attachment_type: 'delivery' }, 'e.png'); const d6 = r.body.attachments[0].id;
    r = await call('DELETE', `/api/sys-issues/${id6}/attachments/${d6}`, dev2Tok);
    assert.strictEqual(r.status, 403, '非上传本人删 403');
    ok('删除未绑 delivery by dev2（非上传本人/非 admin）→ 403');
    r = await call('DELETE', `/api/sys-issues/${id6}/attachments/${d6}`, devTok);
    assert.strictEqual(r.status, 200, '上传本人删未绑 delivery 200');
    assert.strictEqual(await attRow(d6), undefined, '物理删除（行不存在）');
    ok('删除未绑 delivery by 上传本人 → 200 + 物理删行');
    // 已绑 delivery（id1 的 d1 round=1）删 → 409
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${d1}`, adminTok);
    assert.strictEqual(r.status, 409, '已绑 delivery 删 409'); assert.strictEqual(r.body.code, 'ATTACHMENT_BOUND_NOT_DELETABLE');
    ok('删除已绑 delivery（round NOT NULL）→ 409 ATTACHMENT_BOUND_NOT_DELETABLE（交付历史留痕）');
    // spec 删除：dev → 403 / admin → 200
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${spec1}`, devTok);
    assert.strictEqual(r.status, 403, 'spec 删 by dev 403');
    ok('删除 spec by dev → 403（需求材料仅 admin）');
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${spec1}`, adminTok);
    assert.strictEqual(r.status, 200, 'spec 删 by admin 200');
    assert.strictEqual(await attRow(spec1), undefined, 'spec 物理删除');
    ok('删除 spec by admin → 200 + 物理删 + timeline note');

    // ── [10] 作废单上传 spec → 409 ──
    const id7 = await seedDev(5);
    await call('POST', `/api/sys-issues/${id7}/void`, adminTok, { reason: '不做了' });
    r = await upload(ATT(id7), adminTok, { attachment_type: 'spec' }, 'v.pdf');
    assert.strictEqual(r.status, 409, '作废单上传 spec 409'); assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT');
    ok('上传 spec 到已作废单 → 409 INVALID_STATE_FOR_ATTACHMENT');
    // 作废单下载 by 非 admin → 403（行 assigned_to=5，dev 是 assignee 但作废 → 403）
    const id8 = await seedDev(5);
    r = await upload(ATT(id8), devTok, { attachment_type: 'delivery' }, 'f.png'); const d8 = r.body.attachments[0].id;
    await call('POST', `/api/sys-issues/${id8}/void`, adminTok, { reason: 'x' });
    dl = await download(dlPath(id8, d8), devTok);
    assert.strictEqual(dl.status, 403, '作废单非 admin 下载 403');
    ok('下载已作废单附件 by 指派开发 → 403（SYS_ISSUE_VOIDED）；admin 仍可下载');
    dl = await download(dlPath(id8, d8), adminTok);
    assert.strictEqual(dl.status, 200, '作废单 admin 下载 200');
    ok('下载已作废单附件 by admin → 200');

    // ── [11] A9：多轮 round_no（submit→return→submit 应得 round 2，闭 MAX+1 序列，非恒 1）──
    const idR = await seedDev(5);
    r = await upload(ATT(idR), devTok, { attachment_type: 'delivery' }, 'r1.png'); const dr1 = r.body.attachments[0].id;
    r = await call('POST', `/api/sys-issues/${idR}/submit`, devTok, { summary: '第一轮', attachment_ids: [dr1] });
    assert.strictEqual(r.status, 200, '第一轮 submit 200');
    assert.strictEqual((await attRow(dr1)).round_no, 1, '第一轮 delivery round_no=1');
    await call('POST', `/api/sys-issues/${idR}/return`, adminTok, { reason: '列不齐' });            // 回开发中 + 清 dev_estimated_at
    await call('POST', `/api/sys-issues/${idR}/estimate`, devTok, { dev_estimated_at: '2026-08-02 10:00' });  // 新一轮重填
    r = await upload(ATT(idR), devTok, { attachment_type: 'delivery' }, 'r2.png'); const dr2 = r.body.attachments[0].id;
    r = await call('POST', `/api/sys-issues/${idR}/submit`, devTok, { summary: '第二轮', attachment_ids: [dr2] });
    assert.strictEqual(r.status, 200, '第二轮 submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual((await attRow(dr2)).round_no, 2, '第二轮 delivery round_no=2（MAX+1）');
    assert.strictEqual((await attRow(dr1)).round_no, 1, '第一轮 delivery round_no 仍=1（历史不变）');
    const subs = await all("SELECT round_no FROM sys_issue_timeline WHERE issue_id=? AND event_type='submit' ORDER BY round_no", [idR]);
    assert.deepStrictEqual(subs.map(x => x.round_no), [1, 2], '两轮 submit timeline round_no=[1,2]');
    ok('A9 多轮：submit→return→submit 得 round 1/2（MAX+1 序列正确，非恒 1）');

    // ── [12] A9：supersede 端点级 active 过滤 + superseded 软信号（A4）──
    const idSp = await seedDev(5);
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec' }, 'old.pdf'); const specOld = r.body.attachments[0].id;
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec', supersede_id: String(specOld) }, 'new.pdf'); const specNew = r.body.attachments[0].id;
    assert.strictEqual(r.body.superseded, true, 'A4 supersede 命中 → superseded=true');
    r = await call('GET', `/api/sys-issues/${idSp}`, adminTok);
    assert.ok(r.body.attachments.every(a => a.id !== specOld), '详情端点 active 过滤：旧 spec 不在 attachments');
    assert.ok(r.body.specAttachments.some(a => a.id === specNew) && r.body.specAttachments.every(a => a.id !== specOld), 'specAttachments 仅含新 spec');
    ok('A9：supersede 后详情端点 active 过滤排除旧 spec（端点级）+ A4 superseded=true');
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec', supersede_id: '999999' }, 'miss.pdf');
    assert.strictEqual(r.body.superseded, false, 'A4 supersede 不命中 → superseded=false（软信号，新件仍保留）');
    ok('A4：supersede_id 不命中 → superseded=false 软信号');

    // ── [13] A9：下载路径越界 403（污染 file_name=../../）+ 物理删除落盘断言 ──
    const idP = await seedDev(5);
    r = await upload(ATT(idP), devTok, { attachment_type: 'delivery' }, 'phys.png'); const dPhys = r.body.attachments[0].id;
    const dPhysFile = (await get('SELECT file_name FROM sys_issue_attachments WHERE id=?', [dPhys])).file_name;
    assert.ok(fs.existsSync(absOf(dPhysFile)), '上传后文件真实落盘');
    await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, round_no, file_name, original_name, uploaded_by, uploaded_by_name, status) VALUES (?,?,?,?,?,?,?,'active')`,
      [idP, 'spec', null, '../../evil.txt', 'evil.txt', 1, 'admin']);
    const evil = await get('SELECT id FROM sys_issue_attachments WHERE issue_id=? AND file_name=?', [idP, '../../evil.txt']);
    dl = await download(dlPath(idP, evil.id), adminTok);   // admin 有权限 → 403 必来自路径守卫
    assert.strictEqual(dl.status, 403, '越界 file_name 下载 403（A5 SYS_UPLOAD_BASE 子树守卫）');
    ok('A9：污染 file_name=../../ 越界 → 下载 403 ILLEGAL_FILE_PATH（A5）');
    r = await call('DELETE', `/api/sys-issues/${idP}/attachments/${dPhys}`, devTok);
    assert.strictEqual(r.status, 200, '删除未绑 delivery 200');
    assert.ok(!fs.existsSync(absOf(dPhysFile)), 'A9：删除后物理文件真消失（非仅删 DB 行）');
    ok('A9：删除未绑 delivery → DB 行删 + 物理文件真消失（落盘断言，验 safeDeleteFileSync）');

    // ── [14] A9：负向扩展名（不在白名单）→ 400（fileFilter 防线）──
    const idE = await seedDev(5);
    for (const fn of ['m.exe', 'v.svg', 'noext']) {
      r = await upload(ATT(idE), devTok, { attachment_type: 'delivery' }, fn);
      assert.strictEqual(r.status, 400, `${fn} → 400`);
    }
    ok('A9：上传 exe/svg/无扩展名 → 400（fileFilter 扩展名白名单防线）');

    console.log(`\n✅ verify-sys-attachments 全部通过（${passed} 项断言）`);
  } finally {
    server.close();
    db.close();
  }
}
main().catch((e) => { console.error('❌ verify-sys-attachments 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
