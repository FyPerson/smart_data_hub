// #208 C1：内存库 + 进程私有文件 + 真实 HTTP；不读取业务库、固定端口或生产凭证。
// 当前只验 C1 读底座。C2 上传/移除、C3 浏览器另交付，不以这些夹具声称已实现写功能。
'use strict';
const productionMode = process.argv.includes('--production-hook-check');
process.env.SYS_TEST_HOOKS = productionMode ? '0' : '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');
const { listenOnSafePort } = require('./lib/listen-safe-port');
const attachDeps = require('./_sys-attach-test-deps');
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(e) { e ? reject(e) : resolve(this); }));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));
const secret = 'verify-208-c1-local-only';
const noop = () => {};
const authenticateToken = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), secret); next(); }
  catch (_) { res.status(401).json({ error: 'unauthorized' }); }
};
const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403);

const factory = require('../routes/sys-iteration');
let watchedDownloadReads = 0, onDownloadRequest = null;
const mod = factory({ ...attachDeps, logger: { info: noop, warn: noop, error: noop, debug: noop }, db,
  dbRunAsync: run, dbAllAsync: all, dbGetAsync: (sql, params) => {
    if (sql.includes('SELECT id, type, status, intake_liaison_id, release_id, release_assignee_id FROM sys_issues')) watchedDownloadReads++;
    return get(sql, params);
  }, authenticateToken, requireAdmin });
const I = mod._internals;
let server, port, passed = 0;
const token = id => jwt.sign({ id, username: 'u' + id, display_name: 'u' + id, role: id === 1 ? 'admin' : 'user' }, secret);
const call = (method, url, id = 1, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, method, path: url,
    headers: { Authorization: 'Bearer ' + token(id), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
      const bytes = Buffer.concat(chunks), raw = bytes.toString('utf8'); let json = null;
      try { json = JSON.parse(raw); } catch (_) {}
      resolve({ status: res.statusCode, json, raw, bytes });
    });
  });
  req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
  req.on('error', reject); if (data) req.write(data); req.end();
});
async function check(label, fn) {
  try { await fn(); passed++; console.log('PASS ' + label); }
  catch (e) { throw new Error('FAIL ' + label + ': ' + e.message, { cause: e }); }
}
const expectedStatus = (res, status) => assert.strictEqual(res.status, status, res.raw);
async function waitReady() {
  for (let i = 0; i < 500; i++) {
    if (I.SYS_SCHEMA_STATE.ready) return;
    if (I.SYS_SCHEMA_STATE.error) throw new Error(I.SYS_SCHEMA_STATE.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('schema timeout');
}
async function note(issueId, action, refId, payload, summary = 'safe text') {
  return (await run(`INSERT INTO sys_issue_timeline
    (issue_id,event_type,action_code,ref_id,operator_id,operator_name,summary,payload_json)
    VALUES (?,'note',?,?,1,'u1',?,?)`, [issueId, action, refId, summary, payload])).lastID;
}
async function attachment(issueId, noteId, eventId, status = 'active', name = 'note-secret.pdf') {
  const rel = `sys-iteration/${issueId}/hold-notes/${noteId}-${eventId}-${status}.pdf`;
  const abs = path.join(attachDeps.UPLOAD_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'file-' + status);
  const id = (await run(`INSERT INTO sys_issue_hold_note_attachments
    (issue_id,note_id,added_event_id,file_name,original_name,file_size,mime_type,status,uploaded_by,uploaded_by_name,
     removed_at,removed_by,removed_by_name,removed_event_id) VALUES (?,?,?,?,?,?,'application/pdf',?,1,'u1',?,?,?,?)`,
    [issueId,noteId,eventId,rel,name,Buffer.byteLength('file-'+status),status,status === 'removed' ? '2026-01-02 00:00:00' : null,
      status === 'removed' ? 1 : null,status === 'removed' ? 'u1' : null,status === 'removed' ? eventId + 1 : null])).lastID;
  return { id, rel, abs };
}
async function main() {
  mod.initSchema(); await waitReady();
  await run(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,status TEXT DEFAULT 'active',phone TEXT,dingtalk_user_id TEXT)`);
  for (const id of [1,5,7,8,9,13]) await run('INSERT INTO users(id,username,display_name,role) VALUES (?,?,?,?)', [id,'u'+id,'u'+id,id===1?'admin':'user']);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    // 测试期请求到达信号：next 执行后 handler 会等待读锁，不用 sleep 推测其是否已进入。
    if (onDownloadRequest && req.url.includes('/hold-note-attachments/')) setImmediate(onDownloadRequest);
    next();
  });
  app.use('/api', mod.router);
  server = await listenOnSafePort(app); port = server.address().port;
  const issueId = (await run(`INSERT INTO sys_issues
    (type,status,title,system_name,created_by,created_by_name,assigned_to,assigned_to_name,tech_lead_id,intake_liaison_id)
    VALUES ('feature','已暂缓','C1 fixture','BMS',1,'u1',5,'u5',7,13)`)).lastID;
  await run(`INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,is_primary) VALUES (?,5,'u5',1)`, [issueId]);
  await run(`INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,is_primary,removed_at) VALUES (?,8,'u8',0,'2026-01-01')`, [issueId]);
  const detail = id => call('GET', '/api/sys-issues/' + issueId, id);
  assert.strictEqual(I.__testHooks.holdNoteAfterTimelineReadHook, null, 'R-L1 default null');
  if (productionMode) {
    let calls = 0;
    I.__testHooks.holdNoteAfterTimelineReadHook = () => { calls++; throw new Error('production hook executed'); };
    await check('R-L1 production hook disabled', async () => { expectedStatus(await detail(1), 200); assert.strictEqual(calls, 0); });
    return;
  }
  await check('C1 schema', async () => {
    const cols = (await all('PRAGMA table_info(sys_issue_hold_note_attachments)')).map(x => x.name);
    assert.strictEqual(cols.length, 16);
    assert.deepStrictEqual(cols.filter(x=>x!=='id').sort(), I.SYS_HOLD_NOTE_ATTACHMENTS_KEY_COLS.slice().sort());
    assert.ok(I.SYS_REQUIRED_TABLES.includes('sys_issue_hold_note_attachments'));
    assert.ok((await all('PRAGMA index_list(sys_issue_hold_note_attachments)')).some(x=>x.name==='idx_sys_hold_note_attach_issue_note'));
  });
  await check('C1 audit upgrade and repeat', async () => {
    const prior = await all('PRAGMA table_info(sys_issue_delete_audit)');
    for (const c of ['hold_note_attachments_json','hold_note_attachment_count']) await run('ALTER TABLE sys_issue_delete_audit DROP COLUMN ' + c);
    await run(`INSERT INTO sys_issue_delete_audit
      (issue_id,issue_json,timeline_json,attachments_json,dev_assignees_json,dev_commits_json,dev_events_json,
       release_snapshots_json,fast_release_executors_json,operator_id,operator_name,reason,deleted_at)
      VALUES (99999,'{}','[]','[]','[]','[]','[]','[]','[]',1,'u1','old fixture','2026-01-01 00:00:00')`);
    await I.runSysMigration(); assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true);
    assert.deepStrictEqual(await get('SELECT hold_note_attachments_json,hold_note_attachment_count FROM sys_issue_delete_audit WHERE issue_id=99999'),
      {hold_note_attachments_json:'[]',hold_note_attachment_count:0});
    const after = await all('PRAGMA table_info(sys_issue_delete_audit)');
    const shape = list => list.filter(c=>c.name.startsWith('hold_note_')).map(c=>({name:c.name,type:c.type,notnull:c.notnull,default:c.dflt_value})).sort((a,b)=>a.name.localeCompare(b.name));
    assert.deepStrictEqual(shape(after), shape(prior)); await I.runSysMigration();
    assert.deepStrictEqual(shape(await all('PRAGMA table_info(sys_issue_delete_audit)')), shape(prior));
  });
  await check('L-4 row contract', async () => {
    const row = await get('SELECT * FROM sys_issues WHERE id=?', [issueId]);
    for (const col of ['id','type','intake_liaison_id','release_id','release_assignee_id']) {
      for (const undefinedValue of [false,true]) {
        const bad = {...row}; if (undefinedValue) bad[col] = undefined; else delete bad[col];
        await assert.rejects(I.sysCanReadIssueAttachments(bad, {id:1,role:'admin'}), e=>e.code==='SYS_ATTACHMENT_ROW_CONTRACT');
      }
      const inherited = Object.create(row);
      await assert.rejects(I.sysCanReadIssueAttachments(inherited, {id:1,role:'admin'}), e=>e.code==='SYS_ATTACHMENT_ROW_CONTRACT');
    }
    for (const values of [{id:0},{id:1.5},{type:''},{type:null}]) await assert.rejects(I.sysCanReadIssueAttachments({...row,...values},{id:1,role:'admin'}));
    const nullable = {...row,intake_liaison_id:null,release_id:null,release_assignee_id:null};
    assert.strictEqual(await I.sysCanReadIssueAttachments(nullable,{id:1,role:'admin'}),true);
    assert.strictEqual(await I.sysCanReadIssueAttachments(nullable,{id:9,role:'user'}),false);
  });
  const filename = 'NOTE-MARKER.pdf', legacyName = 'LEGACY-MARKER.txt';
  const payload = JSON.stringify({note_date:'2026-01-01',content:'safe',added_attachments:[{original_name:filename}],removed_attachments:[{id:4,original_name:filename}]});
  const origin = await note(issueId,'hold_note',null,payload);
  const edit = await note(issueId,'hold_note_edit',origin,payload);
  const orphan = await note(issueId,'hold_note_edit',999999,payload);
  const legacy = await note(issueId,'attachment_added',null,JSON.stringify({attachments:[{original_name:legacyName}]}),legacyName);
  const activeFile = await attachment(issueId,origin,origin,'active',filename);
  const removedFile = await attachment(issueId,origin,origin,'removed',filename);
  await check('C1 CHECK constraints', async () => {
    for (const sql of ["status='bad'","file_size=-1","file_size=1.5","issue_id=0","note_id=-1","added_event_id=0","uploaded_by=0","removed_at='x'","status='removed'", "removed_by=2.5"])
      await assert.rejects(run('UPDATE sys_issue_hold_note_attachments SET ' + sql + ' WHERE id=?',[activeFile.id]), /CHECK/);
    await assert.rejects(run('UPDATE sys_issue_hold_note_attachments SET removed_event_id=added_event_id WHERE id=?',[removedFile.id]),/CHECK/);
    await assert.rejects(run('UPDATE sys_issue_hold_note_attachments SET file_name=? WHERE id=?',[activeFile.rel,removedFile.id]),/UNIQUE/);
  });
  await check('M-1 pure payload fail closed', async () => {
    for (const malformed of ['{"added_attachments":"'+filename+'"', 'null', '[]', '"'+filename+'"', '42', 'true']) {
      const source = [{event_type:'note',action_code:'hold_note_edit',payload_json:malformed}];
      assert.strictEqual(I.sysProjectHoldNoteTimeline(source,false)[0].payload_json,null);
      assert.strictEqual(source[0].payload_json,malformed);
    }
    for (const badField of [{original_name:filename},filename,7,null]) {
      const raw = JSON.stringify({content:'safe',added_attachments:badField,removed_attachments:badField});
      const result = I.sysProjectHoldNoteTimeline([{event_type:'note',action_code:'hold_note',payload_json:raw}],false);
      assert.deepStrictEqual(JSON.parse(result[0].payload_json),{content:'safe'});
    }
  });
  await check('M-1 M-2 HTTP projection', async () => {
    const before = await all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id',[issueId]);
    const denied = await detail(7); expectedStatus(denied,200);
    assert.deepStrictEqual(denied.json.hold_note_attachments,[]);
    assert.ok(!denied.raw.includes(filename),'no NOTE-MARKER in response');
    for (const id of [origin,edit,orphan]) assert.deepStrictEqual(JSON.parse(denied.json.timeline.find(x=>x.id===id).payload_json),{note_date:'2026-01-01',content:'safe'});
    const oldEvent = denied.json.timeline.find(x=>x.id===legacy);
    assert.strictEqual(oldEvent.summary,legacyName); assert.ok(oldEvent.payload_json.includes(legacyName));
    const allowed = await detail(1); expectedStatus(allowed,200);
    assert.strictEqual(allowed.json.hold_note_attachments.length,2);
    assert.ok(!('file_name' in allowed.json.hold_note_attachments[0]));
    assert.strictEqual(allowed.json.timeline.find(x=>x.id===origin).payload_json,payload);
    assert.deepStrictEqual(await all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id',[issueId]),before);
  });
  await check('M-1 R-L1 damaged HTTP hook', async () => {
    let calls = 0;
    I.__testHooks.holdNoteAfterTimelineReadHook = ({timeline}) => { calls++; timeline.find(x=>x.id===orphan).payload_json = '{"added_attachments":"' + filename; };
    try {
      const result = await detail(7); expectedStatus(result,200);
      assert.strictEqual(calls,1); assert.strictEqual(result.json.timeline.find(x=>x.id===orphan).payload_json,null);
      assert.ok(!result.raw.includes(filename));
      assert.strictEqual((await get('SELECT payload_json FROM sys_issue_timeline WHERE id=?',[orphan])).payload_json,payload);
    } finally { I.__testHooks.holdNoteAfterTimelineReadHook = null; }
  });
  await check('C1 note readers serialize', async () => {
    let reach, release, arrived;
    const reached = new Promise(r=>{ reach=r; }), gate = new Promise(r=>{ release=r; });
    const received = new Promise(r=>{ arrived=r; });
    const timer = setTimeout(release,5000); // 只作失败兜底，不参与先后顺序断言。
    I.__testHooks.detailHoldHook = async () => { reach(); await gate; };
    const reading = detail(1);
    let downloading;
    try {
      await Promise.race([reached,reading.then(()=>{throw new Error('did not reach read lock hook');})]);
      const before = watchedDownloadReads;
      onDownloadRequest = arrived;
      downloading = call('GET','/api/sys-issues/'+issueId+'/hold-note-attachments/'+activeFile.id+'/download');
      await Promise.race([received,downloading.then(()=>{throw new Error('request arrival signal missing');})]);
      assert.strictEqual(watchedDownloadReads,before,'download must not query its row while another sys reader holds lock');
      release(); expectedStatus(await reading,200); expectedStatus(await downloading,200);
      assert.strictEqual(watchedDownloadReads,before+1);
    } finally {
      release(); clearTimeout(timer); onDownloadRequest=null; I.__testHooks.detailHoldHook=null;
      await Promise.allSettled([reading,downloading]);
    }
  });
  await check('C1 downloads and role gates', async () => {
    const url = '/api/sys-issues/' + issueId + '/hold-note-attachments/' + activeFile.id + '/download';
    for (const id of [1,5,8,13]) { const res=await call('GET',url,id); expectedStatus(res,200); assert.strictEqual(res.raw,'file-active'); }
    for (const id of [7,9]) expectedStatus(await call('GET',url,id),403);
    const removedUrl = '/api/sys-issues/' + issueId + '/hold-note-attachments/' + removedFile.id + '/download';
    await note(issueId,'hold_note_void',origin,JSON.stringify({reason:'void'}));
    for (const status of ['已暂缓','待评估','已作废']) {
      await run('UPDATE sys_issues SET status=? WHERE id=?',[status,issueId]);
      expectedStatus(await call('GET',removedUrl,1),200);
    }
    await run("UPDATE sys_issues SET status='已暂缓' WHERE id=?",[issueId]);
    const bad = await attachment(issueId,999999,origin,'active','orphan-file.pdf');
    expectedStatus(await call('GET','/api/sys-issues/'+issueId+'/hold-note-attachments/'+bad.id+'/download'),404);
    await run('DELETE FROM sys_issue_hold_note_attachments WHERE id=?',[bad.id]); fs.unlinkSync(bad.abs);
    const stored = await get('SELECT file_name FROM sys_issue_hold_note_attachments WHERE id=?',[activeFile.id]);
    for (const rel of ['../outside.txt','another-module/file.txt']) {
      await run('UPDATE sys_issue_hold_note_attachments SET file_name=? WHERE id=?',[rel,activeFile.id]);
      const res=await call('GET',url); expectedStatus(res,403); assert.strictEqual(res.json.code,'ILLEGAL_FILE_PATH');
    }
    await run('UPDATE sys_issue_hold_note_attachments SET file_name=? WHERE id=?',[stored.file_name,activeFile.id]);
  });
  await check('C1 deletion rollback files unchanged', async () => {
    await run(`CREATE TRIGGER c1_fail_audit BEFORE INSERT ON sys_issue_delete_audit BEGIN SELECT RAISE(ABORT,'audit injected failure'); END`);
    try {
      const before = await all('SELECT * FROM sys_issue_hold_note_attachments WHERE issue_id=? ORDER BY id',[issueId]);
      expectedStatus(await call('DELETE','/api/sys-issues/'+issueId,1,{reason:'fixture cleanup'}),500);
      assert.deepStrictEqual(await all('SELECT * FROM sys_issue_hold_note_attachments WHERE issue_id=? ORDER BY id',[issueId]),before);
      assert.strictEqual(fs.readFileSync(activeFile.abs,'utf8'),'file-active');
      assert.strictEqual(fs.readFileSync(removedFile.abs,'utf8'),'file-removed');
      assert.strictEqual((await get('SELECT count(*) n FROM sys_issue_delete_audit WHERE issue_id=?',[issueId])).n,0);
    } finally { await run('DROP TRIGGER c1_fail_audit'); }
  });
  await check('C1 deletion audit snapshot files', async () => {
    await run('UPDATE sys_issue_hold_note_attachments SET original_name=? WHERE id=?',['contact-13800000012.pdf',activeFile.id]);
    const before = await all('SELECT * FROM sys_issue_hold_note_attachments WHERE issue_id=? ORDER BY id',[issueId]);
    expectedStatus(await call('DELETE','/api/sys-issues/'+issueId,1,{reason:'fixture cleanup'}),200);
    assert.strictEqual((await get('SELECT count(*) n FROM sys_issue_hold_note_attachments WHERE issue_id=?',[issueId])).n,0);
    const audit=await get('SELECT * FROM sys_issue_delete_audit WHERE issue_id=?',[issueId]);
    assert.deepStrictEqual(JSON.parse(audit.hold_note_attachments_json),before);
    assert.strictEqual(audit.hold_note_attachment_count,2);
    assert.ok(!fs.existsSync(activeFile.abs)); assert.ok(!fs.existsSync(removedFile.abs));
    const response=await call('GET','/api/sys-issue-delete-audit/'+audit.id); expectedStatus(response,200);
    assert.ok(!response.json.hold_note_attachments_json.includes('13800000012'));
    assert.ok(response.json.hold_note_attachments_json.includes('138****0012'));
    assert.ok(audit.hold_note_attachments_json.includes('13800000012'));
    const list=await call('GET','/api/sys-issue-delete-audit'); expectedStatus(list,200);
    assert.strictEqual(list.json.items.find(x=>x.issue_id===issueId).hold_note_attachment_count,2);
    assert.ok(!('hold_note_attachments_json' in list.json.items[0]));
    expectedStatus(await call('GET','/api/sys-issues/'+issueId+'/hold-note-attachments/'+activeFile.id+'/download'),404);
  });
  await check('R-L1 production hook gate subprocess', async () => {
    const r=spawnSync(process.execPath,[...process.execArgv,__filename,'--production-hook-check'],{env:{...process.env},encoding:'utf8',timeout:20000});
    assert.strictEqual(r.status,0,r.stdout+r.stderr);
  });
  await check('C1 missing column fails readiness', async () => {
    await run('ALTER TABLE sys_issue_hold_note_attachments DROP COLUMN mime_type');
    await I.runSysMigration(); assert.strictEqual(I.SYS_SCHEMA_STATE.ready,false);
  });
}
(async () => {
  try { await main(); console.log('C1 hold note attachments: '+passed+' groups passed'); }
  catch(e) { console.error(e.stack); process.exitCode=1; }
  finally { if(server) await new Promise(resolve=>server.close(resolve)); await new Promise(resolve=>db.close(resolve)); }
})();
