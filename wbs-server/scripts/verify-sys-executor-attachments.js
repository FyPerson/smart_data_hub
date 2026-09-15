// #78: isolated in-memory DB + unique temporary uploads; real HTTP read/write permission checks.
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const UPLOAD_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sys-executor-att-'));   // A9：物理删除/越界路径断言用真实落盘根
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
  ...require('./_sys-attach-test-deps'), UPLOAD_DIR, ALLOWED_FILE_DIRS: [UPLOAD_DIR],   // C3b：真实临时落盘 + normalizeAttachmentExt/safeDeleteFileSync/ALLOWED_FILE_DIRS
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
const check = (actual, expected, label) => { assert.deepStrictEqual(actual, expected, label); passed++; };
const token = id => jwt.sign({ id, username: 'person' + id, display_name: 'Person ' + id, role: 'user' }, SECRET);
async function seed(type, releaseId = null) {
  const r = await run(`INSERT INTO sys_issues(type,status,title,system_name,created_by,created_by_name,release_id)
    VALUES (?,'开发中','executor attachments','BMS',1,'Admin',?)`, [type, releaseId]);
  const id = r.lastID;
  if (type === 'bug') await run("UPDATE sys_issues SET status='处理中' WHERE id=?", [id]);
  const dir = path.join(UPLOAD_DIR, 'sys-iteration', String(id));
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of ['spec', 'delivery', 'screenshot']) {
    const name = kind + '.txt';
    fs.writeFileSync(path.join(dir, name), kind);
    await run(`INSERT INTO sys_issue_attachments(issue_id,attachment_type,file_name,original_name,uploaded_by,uploaded_by_name,status)
      VALUES (?,?,?,?,1,'Admin','active')`, [id, kind, `sys-iteration/${id}/${name}`, name]);
  }
  return id;
}
async function assertRead(id, uid, allowed) {
  const tok = token(uid);
  const r = await call('GET', `/api/sys-issues/${id}`, tok);
  check(r.status, allowed ? 200 : 403, `detail ${id}/${uid}`);
  if (allowed) {
    check(r.body.attachments.map(a => a.attachment_type).sort(), ['delivery','screenshot','spec'], 'all three types');
    check(r.body.specAttachments.length, 1, 'spec subset');
    check(r.body.hasSpecAttachment, true, 'spec presence');
  }
  for (const a of await all('SELECT * FROM sys_issue_attachments WHERE issue_id=?', [id])) {
    const d = await download(`/api/sys-issues/${id}/attachments/${a.id}/download`, tok);
    check(d.status, allowed ? 200 : 403, `download ${id}/${uid}/${a.attachment_type}`);
    if (allowed) check(d.bytes, Buffer.byteLength(a.attachment_type), 'actual file bytes');
  }
}
async function assertNoWrite(id, uid) {
  const tok = token(uid);
  const before = await all('SELECT * FROM sys_issue_attachments WHERE issue_id=? ORDER BY id', [id]);
  for (const kind of ['spec','delivery','screenshot']) {
    const r = await upload(`/api/sys-issues/${id}/attachments`, tok, { attachment_type: kind }, 'attempt.png', png);
    check(r.status, 403, `upload ${kind} forbidden for executor`);
  }
  for (const a of before) {
    const r = await call('DELETE', `/api/sys-issues/${id}/attachments/${a.id}`, tok);
    check(r.status, 403, 'delete forbidden for executor');
    check(fs.existsSync(absOf(a.file_name)), true, 'file retained');
  }
  check(await all('SELECT * FROM sys_issue_attachments WHERE issue_id=? ORDER BY id', [id]), before, 'no attachment mutation');
}
async function main() {
  mod.initSchema(); await waitReady();
  await run(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,status TEXT,phone TEXT,dingtalk_user_id TEXT)`);
  for (const id of [1,5,6,20,21]) await run('INSERT INTO users VALUES (?,?,?,?,?,?,NULL)', [id,'person'+id,'Person '+id,id===1?'admin':'user','active','']);
  const app=express(); app.use(express.json()); app.use('/api',mod.router);
  await new Promise(resolve => { server=app.listen(0,'127.0.0.1',()=>{port=server.address().port;resolve();}); });
  const rel=await run("INSERT INTO sys_releases(release_no,created_by,created_by_name) VALUES ('TEST-78',1,'Admin')");
  await run("INSERT INTO sys_release_executors(release_id,user_id,user_name,added_by,added_by_name) VALUES (?,20,'Executor',1,'Admin')",[rel.lastID]);
  const batch=await seed('improvement',rel.lastID);
  const fast=await seed('bug');
  await run("INSERT INTO sys_fast_release_executors(issue_id,user_id,user_name,added_by,added_by_name) VALUES (?,20,'Executor',1,'Admin')",[fast]);
  for (const id of [batch,fast]) {
    await assertRead(id,20,true); await assertNoWrite(id,20); await assertRead(id,21,false);
    const wrong=await download(`/api/sys-issues/${id}/attachments/999999/download`,token(20));
    check(wrong.status,404,'authorized user still cannot download nonexistent attachment');
  }
  // Detail short-circuit must not hide attachments from dual-role executors.
  await run('UPDATE sys_issues SET tech_lead_id=20,tech_lead_name=? WHERE id=?',['Executor',fast]);
  await assertRead(fast,20,true);
  await run('UPDATE sys_issues SET tech_lead_id=NULL,tech_lead_name=NULL,assigned_to=20 WHERE id=?',[fast]);
  await assertRead(fast,20,true);
  await run('UPDATE sys_issues SET assigned_to=NULL WHERE id=?',[fast]);
  // Read-permission fixture, not a publication-workflow test: both records are published.
  await run("UPDATE sys_releases SET status='已发布',released_at=datetime('now','localtime') WHERE id=?",[rel.lastID]);
  await run("UPDATE sys_issues SET status='已上线',released_at=datetime('now','localtime') WHERE id=?",[batch]);
  await assertRead(batch,20,true);
  await run("UPDATE sys_releases SET status='计划中',released_at=NULL WHERE id=?",[rel.lastID]);
  await run("UPDATE sys_issues SET status='开发中',released_at=NULL WHERE id=?",[batch]);
  await run("UPDATE sys_release_executors SET removed_at=datetime('now','localtime'),removed_by=1,removed_by_name='Admin' WHERE user_id=20");
  await assertRead(batch,20,false);
  await run("UPDATE sys_fast_release_executors SET removed_at=datetime('now','localtime'),removed_by=1,removed_by_name='Admin' WHERE user_id=20");
  await assertRead(fast,20,false);
  // Losing executor identity does not remove independent developer/historical read permission.
  for (const id of [batch,fast]) {
    await run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name) VALUES (?,20,'Developer')",[id]);
    await assertRead(id,20,true);
    await run("UPDATE sys_issue_dev_assignees SET removed_at=datetime('now','localtime') WHERE issue_id=?",[id]);
    await assertRead(id,20,true);
    await run('DELETE FROM sys_issue_dev_assignees WHERE issue_id=?',[id]);
  }
  // Technical-lead-only identity remains unable to read attachments.
  const tech=await seed('feature');
  await run('UPDATE sys_issues SET tech_lead_id=21,tech_lead_name=? WHERE id=?',['Tech',tech]);
  const r=await call('GET',`/api/sys-issues/${tech}`,token(21));
  check(r.status,200,'tech lead may read detail'); check(r.body.attachments,[],'tech lead attachments hidden');
  check(r.body.specAttachments,[],'tech lead spec hidden'); check(r.body.hasSpecAttachment,false,'tech lead presence hidden');
  const a=await get('SELECT id FROM sys_issue_attachments WHERE issue_id=?',[tech]);
  check((await download(`/api/sys-issues/${tech}/attachments/${a.id}/download`,token(21))).status,403,'tech lead download forbidden');
  check((await download(`/api/sys-issues/${batch}/attachments/${a.id}/download`,adminTok)).status,404,'cross-issue attachment rejected');
  // Legacy bug executor already has detail permission and must have matching download permission.
  const legacy=await seed('bug');
  await run('UPDATE sys_issues SET release_assignee_id=20 WHERE id=?',[legacy]);
  await assertRead(legacy,20,true); await assertNoWrite(legacy,20);
  const expired=await get('SELECT id FROM sys_issue_attachments WHERE issue_id=?',[legacy]);
  await run("UPDATE sys_issue_attachments SET status='superseded' WHERE id=?",[expired.id]);
  check((await download(`/api/sys-issues/${legacy}/attachments/${expired.id}/download`,token(20))).status,404,'superseded file rejected');
  // Restored batch member loses access when the issue is detached.
  await run('UPDATE sys_release_executors SET removed_at=NULL,removed_by=NULL,removed_by_name=NULL');
  await run('UPDATE sys_issues SET release_id=NULL WHERE id=?',[batch]);
  await assertRead(batch,20,false);
  // Deletion-state fixture mirrors release DELETE cleanup; this verifies read revocation, not the write workflow.
  await run('UPDATE sys_issues SET release_id=? WHERE id=?',[rel.lastID,batch]);
  await assertRead(batch,20,true);
  await run('DELETE FROM sys_release_executors WHERE release_id=?',[rel.lastID]);
  await run('DELETE FROM sys_releases WHERE id=?',[rel.lastID]);
  await run('UPDATE sys_issues SET release_id=NULL WHERE id=?',[batch]);
  await assertRead(batch,20,false);
  console.log(`#78 executor attachments: ${passed} checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>db.close(resolve));
  // Only this process's unique mkdtemp directory is removed.
  fs.rmSync(UPLOAD_DIR,{recursive:true,force:true});
});

