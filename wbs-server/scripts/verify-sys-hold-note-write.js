// #208 C2：实际 multipart + 内存库 + 私有落盘 + 可控交错/失败，不接业务库或固定端口。
'use strict';
const productionMode = process.argv.includes('--production-uuid-check');
process.env.SYS_TEST_HOOKS = productionMode ? '0' : '1';
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const express = require('express'), sqlite3 = require('sqlite3'), jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');
const { listenOnSafePort } = require('./lib/listen-safe-port');
const deps = require('./_sys-attach-test-deps');
const db = new sqlite3.Database(':memory:');
const run = (sql, p=[]) => new Promise((resolve,reject)=>db.run(sql,p,function(e){e?reject(e):resolve(this);}));
const all = (sql,p=[]) => new Promise((resolve,reject)=>db.all(sql,p,(e,r)=>e?reject(e):resolve(r)));
const get = (sql,p=[]) => new Promise((resolve,reject)=>db.get(sql,p,(e,r)=>e?reject(e):resolve(r)));
let inject = null, onDownloadRequest = null, downloadReads = 0; const sqlTrace=[];
async function tracedRun(sql,params=[]) {
  sqlTrace.push(sql);
  if (inject && sql.includes(inject.match)) {
    inject.hits++;
    if (inject.effect==='skip') return {lastID:999999,changes:1};
    throw new Error('C2 injected '+inject.match);
  }
  return run(sql,params);
}
const secret='verify-note-c2-local';
const authenticateToken=(req,res,next)=>{try{req.user=jwt.verify((req.headers.authorization||'').slice(7),secret);next();}catch(_){res.sendStatus(401);}};
const requireAdmin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403);
const noop=()=>{};
const mod=require('../routes/sys-iteration')({...deps,db,dbRunAsync:tracedRun,dbAllAsync:all,dbGetAsync:(sql,p)=>{
  if(sql.includes('SELECT id, type, status, intake_liaison_id, release_id, release_assignee_id FROM sys_issues'))downloadReads++;
  return get(sql,p);
},
  logger:{info:noop,warn:noop,error:noop,debug:noop},authenticateToken,requireAdmin});
const I=mod._internals;
const tok=id=>jwt.sign({id,username:'u'+id,display_name:'u'+id,role:[1,2].includes(id)?'admin':'user'},secret);
let server,port,passed=0;
const fixedUuid='11111111-2222-4333-8444-555555555555';
function call(method,url,id,body,contentType='application/json') {
  return new Promise((resolve,reject)=>{
    const bytes=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const req=http.request({host:'127.0.0.1',port,path:'/api'+url,method,headers:{Authorization:'Bearer '+tok(id),
      ...(bytes?{'Content-Type':contentType,'Content-Length':bytes.length}:{})}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('aborted',()=>reject(new Error('response aborted')));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch(_){}resolve({status:res.statusCode,json,raw});});
    });
    req.setTimeout(20000,()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);if(bytes)req.write(bytes);req.end();
  });
}
const file=(name='file.pdf',size=12)=>({name,data:Buffer.alloc(size,65)});
async function post(issueId,noteId=null,{id=1,files=[],fields={},json=false}={}) {
  const today=(await get("SELECT date('now','localtime') d")).d;
  const data={note_date:today,content:'note',...fields};
  const url='/sys-issues/'+issueId+'/hold-notes'+(noteId===null?'':'/'+noteId+'/edit');
  if(json)return call('POST',url,id,data);
  const boundary='note-c2-boundary';const parts=[];
  for(const [key,value]of Object.entries(data)){
    parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+(typeof value==='string'?value:JSON.stringify(value))+'\r\n'));
  }
  for(const f of files){parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="files"; filename="'+f.name+'"\r\nContent-Type: application/octet-stream\r\n\r\n'));parts.push(f.data);parts.push(Buffer.from('\r\n'));}
  parts.push(Buffer.from('--'+boundary+'--\r\n'));
  return call('POST',url,id,Buffer.concat(parts),'multipart/form-data; boundary='+boundary);
}
function status(r,expected,code){assert.strictEqual(r.status,expected,r.raw);if(code)assert.strictEqual(r.json&&r.json.code,code,r.raw);}
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){throw new Error('FAIL '+name+': '+e.message,{cause:e});}}
function within(p,label){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout')),10000);})]).finally(()=>clearTimeout(timer));}
async function ready(){for(let n=0;n<500;n++){if(I.SYS_SCHEMA_STATE.ready)return;if(I.SYS_SCHEMA_STATE.error)throw new Error(I.SYS_SCHEMA_STATE.error);await new Promise(r=>setTimeout(r,10));}throw new Error('readiness timeout');}
async function issue(type='feature',creator=1){
  const active=['feature','improvement'].includes(type)?'开发中':'处理中';
  const id=(await run(`INSERT INTO sys_issues(type,status,title,system_name,created_by,created_by_name,assigned_to,assigned_to_name,assigned_at)
    VALUES (?,?,'C2 fixture','BMS',?,'creator',5,'dev',datetime('now','localtime'))`,[type,active,creator])).lastID;
  await run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,is_primary) VALUES (?,5,'dev',1)",[id]);
  status(await call('POST','/sys-issues/'+id+'/hold',1,{reason:'hold fixture'}),200);
  return id;
}
const rows=id=>all('SELECT * FROM sys_issue_hold_note_attachments WHERE issue_id=? ORDER BY id',[id]);
function disk(){const found=[];function walk(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else found.push([path.relative(deps.UPLOAD_DIR,p).replace(/\\/g,'/'),fs.statSync(p).size]);}}walk(deps.UPLOAD_DIR);return found.sort((a,b)=>a[0].localeCompare(b[0]));}
async function snapshot(id){return {issue:await get('SELECT * FROM sys_issues WHERE id=?',[id]),timeline:await all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id',[id]),attachments:await rows(id),disk:disk()};}
async function refused(id,operation,expected,code){const before=await snapshot(id);const r=await operation();status(r,expected,code);assert.deepStrictEqual(await snapshot(id),before,'rejected request must have zero DB/disk side effects');return r;}
async function added(id,options={}){const r=await post(id,null,{files:[file()],...options});status(r,200);return r.json;}
async function main(){
  mod.initSchema();await ready();
  await run("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,status TEXT DEFAULT 'active',phone TEXT,dingtalk_user_id TEXT)");
  for(const id of [1,2,5,7,9])await run('INSERT INTO users(id,username,display_name,role) VALUES (?,?,?,?)',[id,'u'+id,'u'+id,[1,2].includes(id)?'admin':'user']);
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{if(onDownloadRequest&&req.url.includes('/hold-note-attachments/'))setImmediate(onDownloadRequest);next();});
  app.use('/api',mod.router);server=await listenOnSafePort(app);port=server.address().port;
  assert.strictEqual(I.__testHooks.holdNoteUuidHook,null);
  if(productionMode){
    const id=await issue();let calls=0;I.__testHooks.holdNoteUuidHook=()=>{calls++;return fixedUuid;};
    await check('R-L2 production UUID hook disabled',async()=>{await added(id);assert.strictEqual(calls,0);assert.ok(!(await rows(id))[0].file_name.includes(fixedUuid));});return;
  }
  await check('C2 JSON and multipart count',async()=>{
    const id=await issue();status(await post(id,null,{json:true}),200);
    status(await post(id,null),200);
    const first=await added(id,{files:Array.from({length:5},(_,i)=>file('first'+i+'.pdf'))});
    assert.strictEqual(first.added_attachments.length,5);assert.strictEqual(first.event_id,first.note_id);
    const second=await post(id,first.note_id,{files:[file('sixth.pdf')]});status(second,200);assert.strictEqual((await rows(id)).length,6);
    await refused(id,()=>post(id,null,{files:Array.from({length:6},(_,i)=>file('over'+i+'.pdf'))}),400);
  });
  if(!process.argv.includes('--fast'))await check('C2 real byte size boundaries',async()=>{
    const id=await issue(), bytes=Buffer.alloc(50*1024*1024+2,65);
    for(const [name,n,expected]of [['edge.pdf',20*1024*1024,200],['large.pdf',20*1024*1024+1,400],
      ['edge.zip',50*1024*1024,200],['large.zip',50*1024*1024+1,400],['edge.rar',12,200],['edge.7z',12,200]]){
      const action=()=>post(id,null,{files:[{name,data:bytes.subarray(0,n)}]});
      if(expected===200)status(await action(),200);else await refused(id,action,expected);
    }
    await refused(id,()=>post(id,null,{files:[{name:'oversized.zip',data:bytes},file('late-valid.pdf')]}),400,'LIMIT_FILE_SIZE');
  });
  await check('C2 file names whitelist and invalid text',async()=>{
    const id=await issue();
    for(const files of [[file('good.pdf'),file('bad.exe')],[file('bad.exe'),file('good.pdf')],[file('bad.svg')],[file('noext')],[file('bad\u0001.pdf')]])await refused(id,()=>post(id,null,{files}),400);
    for(const fields of [{content:''},{content:'x'.repeat(501)},{note_date:'2026-02-30'},{note_date:'2999-01-01'}])await refused(id,()=>post(id,null,{files:[file()],fields}),400);
    await refused(id,()=>post(0,null,{files:[file()]}),400);
    await refused(id,()=>post(id,0,{files:[file()]}),400);
    await refused(id,()=>post(id,null,{json:true,fields:{content:['a','b']}}),400);
    const boundary='duplicate-text', raw=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="note_date"\r\n\r\n2026-01-01\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="content"\r\n\r\na\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="content"\r\n\r\nb\r\n--'+boundary+'--\r\n');
    await refused(id,()=>call('POST','/sys-issues/'+id+'/hold-notes',1,raw,'multipart/form-data; boundary='+boundary),400);
  });
  await check('C2 authors and foreign remove ids',async()=>{
    const id=await issue(), n=await added(id), a=n.added_attachments[0].id;
    for(const who of [2,5,9])await refused(id,()=>post(id,n.note_id,{id:who,files:[file()],fields:{remove_attachment_ids:[a]}}),403);
    await refused(id,()=>post(id,null,{id:9,files:[file()]}),403);
    const second=await added(id);const other=await issue();const foreign=await added(other);
    for(const bad of [second.added_attachments[0].id,foreign.added_attachments[0].id,999999])await refused(id,()=>post(id,n.note_id,{files:[file()],fields:{remove_attachment_ids:[bad]}}),409,'HOLD_NOTE_ATTACHMENT_CONFLICT');
    for(const bad of [null,'oops',[a,a],[-1],['1'],[1.5],[Number.MAX_SAFE_INTEGER+1]])await refused(id,()=>post(id,n.note_id,{fields:{remove_attachment_ids:bad}}),400);
    await refused(id,()=>post(id,n.note_id,{json:true,fields:{remove_attachment_ids:JSON.stringify([a])}}),400);
    await refused(id,()=>post(id,null,{fields:{remove_attachment_ids:[a]}}),400);
    const created=await issue('feature',7), authored=await added(created,{id:7});
    status(await post(created,authored.note_id,{id:7,fields:{remove_attachment_ids:[authored.added_attachments[0].id]}}),200);
  });
  await check('C2 versions remove retain bytes',async()=>{
    const id=await issue(), n=await added(id,{files:[file('same.pdf')]});
    const a=(await rows(id))[0];const edit=await post(id,n.note_id,{files:[file('same.pdf')]});status(edit,200);
    const b=(await rows(id))[1];const removal=await post(id,n.note_id,{json:true,fields:{remove_attachment_ids:[a.id]}});status(removal,200);
    const stored=await rows(id), event=await get('SELECT * FROM sys_issue_timeline WHERE id=?',[removal.json.event_id]);
    assert.deepStrictEqual(JSON.parse(event.payload_json).removed_attachments,[{id:a.id,original_name:'same.pdf'}]);
    const at=e=>stored.filter(x=>x.added_event_id<=e&&(x.removed_event_id===null||x.removed_event_id>e)).map(x=>x.id);
    assert.deepStrictEqual(at(n.event_id),[a.id]);assert.deepStrictEqual(at(edit.json.event_id),[a.id,b.id]);assert.deepStrictEqual(at(removal.json.event_id),[b.id]);
    assert.ok(fs.existsSync(path.join(deps.UPLOAD_DIR,a.file_name)));assert.ok(stored.every(x=>/^sys-iteration\/\d+\/hold-notes\/[a-f\d-]+\.pdf$/.test(x.file_name)));
    status(await call('GET','/sys-issues/'+id+'/hold-note-attachments/'+a.id+'/download',1),200);
    await refused(id,()=>post(id,n.note_id,{fields:{remove_attachment_ids:[a.id]}}),409);
    const old=await post(id,null,{json:true});status(old,200);const later=await post(id,old.json.note_id,{files:[file()]});status(later,200);
    assert.strictEqual((await rows(id)).filter(x=>x.note_id===old.json.note_id&&x.added_event_id<=old.json.event_id).length,0);
  });
  await check('C2 state gates all types',async()=>{
    for(const type of ['feature','improvement','bug','config']){
      const id=await issue(type), n=await added(id);
      status(await call('POST','/sys-issues/'+id+'/resume',1,{reason:'resume fixture'}),200);
      await refused(id,()=>post(id,n.note_id,{files:[file()]}),409);
      status(await call('POST','/sys-issues/'+id+'/hold',1,{reason:'next hold'}),200);
      await refused(id,()=>post(id,n.note_id,{fields:{remove_attachment_ids:[n.added_attachments[0].id]}}),409);
      const fresh=await added(id);status(await call('POST','/sys-issues/'+id+'/hold-notes/'+fresh.note_id+'/void',1,{reason:'void note'}),200);
      await refused(id,()=>post(id,fresh.note_id,{files:[file()]}),409,'HOLD_NOTE_VOIDED');
      status(await call('POST','/sys-issues/'+id+'/void',1,{reason:'void issue'}),200);
      await refused(id,()=>post(id,null,{files:[file()]}),409);
    }
    const id=await issue();await run("DELETE FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold'",[id]);
    await refused(id,()=>post(id,null,{files:[file()]}),409,'HOLD_NOTE_NO_HOLD_ANCHOR');
  });
  await check('C2 rollback after real writes and recheck',async()=>{
    const id=await issue(), n=await added(id);let reached=false;
    for(const corrupt of ['throw','state','metadata','event']){
      I.__testHooks.holdNoteAfterPersistHook=async ({eventId,addedIds})=>{
        reached=true;assert.ok(addedIds.length===2);assert.ok((await rows(id)).some(x=>x.id===addedIds[0]));assert.ok(disk().some(x=>x[0].includes('/hold-notes/')));
        if(corrupt==='throw')throw new Error('after actual persistence');
        if(corrupt==='state')await run("UPDATE sys_issues SET status='已作废' WHERE id=?",[id]);
        if(corrupt==='metadata')await run("UPDATE sys_issue_hold_note_attachments SET original_name='wrong' WHERE id=?",[addedIds[0]]);
        if(corrupt==='event')await run("UPDATE sys_issue_timeline SET payload_json='{}' WHERE id=?",[eventId]);
      };
      try{reached=false;await refused(id,()=>post(id,n.note_id,{files:[file('one.pdf'),file('two.pdf')],fields:{remove_attachment_ids:[n.added_attachments[0].id]}}),corrupt==='state'?409:500);assert.ok(reached);}
      finally{I.__testHooks.holdNoteAfterPersistHook=null;}
    }
    status(await post(id,n.note_id,{json:true}),200);
  });
  await check('C2 SQL failures and persisted not intent',async()=>{
    const id=await issue(), n=await added(id);
    for(const [match,effect]of [['INSERT INTO sys_issue_hold_note_attachments','throw'],['INSERT INTO sys_issue_hold_note_attachments','skip'],['UPDATE sys_issue_hold_note_attachments','skip'],['COMMIT','throw']]){
      inject={match,effect,hits:0};try{await refused(id,()=>post(id,n.note_id,{files:[file()],fields:{remove_attachment_ids:[n.added_attachments[0].id]}}),500);assert.ok(inject.hits>0);}finally{inject=null;}
    }
    status(await post(id,n.note_id,{json:true}),200);
  });
  await check('C2 partial rename failure compensates first move',async()=>{
    const id=await issue();let calls=0;
    I.__testHooks.holdNoteUuidHook=()=>{
      calls++;
      if(calls===2){
        assert.ok(disk().some(x=>x[0].includes('/'+id+'/hold-notes/')),'first file really moved');
        const pending=disk().find(x=>x[0].startsWith('sys-iteration/_pending/'+id+'/')&&x[0].endsWith('two.pdf'));
        assert.ok(pending);fs.unlinkSync(path.join(deps.UPLOAD_DIR,pending[0]));
      }
      return calls===1?'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee':fixedUuid;
    };
    try{await refused(id,()=>post(id,null,{files:[file('one.pdf'),file('two.pdf')]}),500);assert.strictEqual(calls,2);}
    finally{I.__testHooks.holdNoteUuidHook=null;}
  });
  await check('C2 controlled interleavings',async()=>{
    for(const mode of ['resume','void','remove','delete']){
      const id=await issue(), n=await added(id), originalDisk=disk();let reached,release,paused=false;
      const waiting=new Promise(r=>{reached=r;}), gate=new Promise(r=>{release=r;});
      I.__testHooks.holdNoteBeforeLockHook=async info=>{if(info.issueId===id&&!paused){paused=true;reached();await gate;}};
      const pending=post(id,mode==='delete'?null:n.note_id,{files:[file('late.pdf')],fields:mode==='remove'?{remove_attachment_ids:[n.added_attachments[0].id]}:{}});
      try{
        await within(Promise.race([waiting,pending.then(()=>{throw new Error('missing before lock hook');})]),'reached');
        let middle;
        if(mode==='remove')middle=post(id,n.note_id,{json:true,fields:{remove_attachment_ids:[n.added_attachments[0].id]}});
        else if(mode==='void')middle=call('POST','/sys-issues/'+id+'/hold-notes/'+n.note_id+'/void',1,{reason:'middle void'});
        else middle=call(mode==='delete'?'DELETE':'POST','/sys-issues/'+id+(mode==='delete'?'':'/resume'),1,{reason:'middle action'});
        status(await within(middle,'middle'),200);release();status(await within(pending,'pending'),mode==='delete'?404:409);
        assert.deepStrictEqual(disk(),mode==='delete'?originalDisk.filter(x=>!x[0].startsWith('sys-iteration/'+id+'/')):originalDisk);
        const edits=await all("SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold_note_edit'",[id]);
        assert.strictEqual(edits.length,mode==='remove'?1:0);
        if(mode==='remove')assert.strictEqual((await rows(id))[0].status,'removed');
      }finally{release();I.__testHooks.holdNoteBeforeLockHook=null;await Promise.allSettled([pending]);}
    }
    status(await post(await issue(),null,{json:true}),200);
  });
  await check('C2 readers wait for commit',async()=>{
    const id=await issue();let reached,release,arrived,info;
    const waiting=new Promise(r=>{reached=r;}), gate=new Promise(r=>{release=r;}), arrival=new Promise(r=>{arrived=r;});
    I.__testHooks.holdNoteAfterPersistHook=async value=>{info=value;reached();await gate;};
    const pending=post(id,null,{files:[file()]});let downloading;
    try{
      await within(Promise.race([waiting,pending.then(()=>{throw new Error('missing persisted hook');})]),'persist reached');
      const before=downloadReads;onDownloadRequest=arrived;
      downloading=call('GET','/sys-issues/'+id+'/hold-note-attachments/'+info.addedIds[0]+'/download',1);
      await within(Promise.race([arrival,downloading.then(()=>{throw new Error('arrival missing');})]),'read arrived');
      assert.strictEqual(downloadReads,before,'uncommitted attachment cannot be read');
      release();status(await within(pending,'writer'),200);status(await within(downloading,'reader'),200);assert.strictEqual(downloadReads,before+1);
    }finally{release();onDownloadRequest=null;I.__testHooks.holdNoteAfterPersistHook=null;await Promise.allSettled([pending,downloading]);}
  });
  await check('L-1 L-2 R-L2 collision immutable target',async()=>{
    const id=await issue(), dir=path.join(deps.UPLOAD_DIR,'sys-iteration',String(id),'hold-notes');fs.mkdirSync(dir,{recursive:true});
    const target=path.join(dir,fixedUuid+'.pdf');fs.writeFileSync(target,'existing untouched bytes');
    I.__testHooks.holdNoteUuidHook=()=>fixedUuid;
    try{await refused(id,()=>post(id,null,{files:[file()]}),500,'HOLD_NOTE_FILE_COLLISION');assert.strictEqual(fs.readFileSync(target,'utf8'),'existing untouched bytes');}
    finally{I.__testHooks.holdNoteUuidHook=null;}
    const n=await added(id,{fields:{uuid:fixedUuid,file_name:'../../client.pdf'}});
    assert.ok(!(await rows(id)).find(x=>x.id===n.added_attachments[0].id).file_name.includes(fixedUuid));
  });
  await check('C2 BEGIN failure preserves foreign transaction',async()=>{
    const id=await issue();await run('BEGIN');await run("UPDATE sys_issues SET title='foreign pending' WHERE id=?",[id]);
    const start=sqlTrace.length;
    try{status(await post(id,null,{files:[file()]}),500);assert.strictEqual(sqlTrace.slice(start).filter(s=>s==='ROLLBACK').length,0);assert.strictEqual((await get('SELECT title FROM sys_issues WHERE id=?',[id])).title,'foreign pending');}
    finally{await run('ROLLBACK');}
    status(await post(id,null,{json:true}),200);
  });
  await check('C2 rollback unconfirmed retains orphan and id reuse',async()=>{
    const id=await issue();let eventId;
    I.__testHooks.holdNoteUuidHook=()=>fixedUuid;
    I.__testHooks.holdNoteAfterPersistHook=async info=>{eventId=info.eventId;throw new Error('uncertain rollback fixture');};
    inject={match:'ROLLBACK',effect:'throw',hits:0};
    try{status(await post(id,null,{files:[file()]}),500,'TXN_ROLLBACK_UNCONFIRMED');assert.strictEqual(inject.hits,1);assert.ok(fs.existsSync(path.join(deps.UPLOAD_DIR,'sys-iteration',String(id),'hold-notes',fixedUuid+'.pdf')));}
    finally{inject=null;I.__testHooks.holdNoteUuidHook=null;I.__testHooks.holdNoteAfterPersistHook=null;await run('ROLLBACK');}
    const next=await added(id);assert.strictEqual(next.note_id,eventId,'rolled back AUTOINCREMENT id really reused');
    assert.strictEqual((await rows(id)).length,1);assert.ok(!(await rows(id))[0].file_name.includes(fixedUuid));
    assert.ok(fs.existsSync(path.join(deps.UPLOAD_DIR,'sys-iteration',String(id),'hold-notes',fixedUuid+'.pdf')));
  });
  await check('C2 committed response failure retains data',async()=>{
    const id=await issue();I.__testHooks.holdNoteBeforeResponseHook=()=>{throw new Error('after commit');};
    try{status(await post(id,null,{files:[file()]}),500);assert.strictEqual((await rows(id)).length,1);const a=(await rows(id))[0];assert.ok(fs.existsSync(path.join(deps.UPLOAD_DIR,a.file_name)));assert.ok(await get('SELECT id FROM sys_issue_timeline WHERE id=?',[a.note_id]));}
    finally{I.__testHooks.holdNoteBeforeResponseHook=null;}
    I.__testHooks.holdNoteBeforeResponseHook=res=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');throw new Error('partial response after commit');};
    try{await assert.rejects(post(id,null,{files:[file()]}),/response aborted|socket hang up/);assert.strictEqual((await rows(id)).length,2);for(const a of await rows(id))assert.ok(fs.existsSync(path.join(deps.UPLOAD_DIR,a.file_name)));}
    finally{I.__testHooks.holdNoteBeforeResponseHook=null;}
    status(await post(id,null,{json:true}),200);
  });
  await check('R-L2 production UUID guard subprocess',async()=>{
    const r=spawnSync(process.execPath,[...process.execArgv,__filename,'--production-uuid-check'],{env:{...process.env},encoding:'utf8',timeout:20000});assert.strictEqual(r.status,0,r.stdout+r.stderr);
  });
}
(async()=>{try{await main();console.log('C2 hold note writes: '+passed+' groups passed');}catch(e){console.error(e.stack);process.exitCode=1;}finally{if(server)await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));}})();
