// Real route handlers, Express HTTP and isolated in-memory SQLite; no real DB or DingTalk.
'use strict';
// Host zone pinned to UTC so the '+08 canonical read_at' assertions discriminate on any machine:
// a writer that formats with process-local fields would produce 04:34:56 here instead of 12:34:56.
process.env.TZ='UTC';
if(new Date('2026-09-27T04:34:56Z').getTimezoneOffset()!==0)throw Error('TZ pin to UTC did not take effect in this Node runtime; the +08 read-time assertions would not discriminate');
const fs=require('fs'),path=require('path'),vm=require('vm'),http=require('http'),assert=require('assert/strict');
const acorn=require('acorn'),express=require('express'),sqlite=require('sqlite3');
const dt=require('../utils/dingtalk-notify');
const { listenOnSafePort } = require('./lib/listen-safe-port');
const db=new sqlite.Database(':memory:');
const run=(sql,p=[])=>new Promise((res,rej)=>db.run(sql,p,function(e){e?rej(e):res(this);}));
const get=(sql,p=[])=>new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const all=(sql,p=[])=>new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
const noop=()=>{},mw=(req,res,next)=>{req.user={id:1,role:'admin',username:'admin'};next();};
const logger={info:noop,warn:noop,error:console.error,debug:noop};
let readResult={readDetails:[],readUserIds:[],raw:{messageReadInfoList:[]}},queries=0,external=0,server,liteRace=null;   // external: every config read / token / userid / read-status call
async function serverRun(sql,params){
 if(liteRace&&sql.startsWith('UPDATE issue_lite SET notify_read_at=')){
  const fresh=liteRace==='read'?'2026-09-27 12:34:56':null;liteRace=null;
  await run("UPDATE issue_lite SET notify_message_key='newer-message',notify_read_at=? WHERE id=1",[fresh]);
 }
 return run(sql,params);
}
const saved=Object.fromEntries(['getReadStatus','getAccessToken','getUserIdByMobile','resolveRequesterDingUserId'].map(k=>[k,dt[k]]));
Object.assign(dt,{getReadStatus:async()=>{queries++;external++;return readResult;},getAccessToken:async()=>{external++;return 'token';},getUserIdByMobile:async()=>{external++;return 'u';},resolveRequesterDingUserId:async()=>{external++;return {ok:true,userid:'u'};}});
const deps={...require('./_sys-attach-test-deps'),logger,db,dbRunAsync:run,dbGetAsync:get,dbAllAsync:all,authenticateToken:mw,requireAdmin:mw,requirePublisherOrAdmin:mw,readSystemConfig:async()=>{external++;return 'test-config';},callDingtalkWithTokenRetry:async(_a,_b,token,fn)=>fn(token)};
const sys=require('../routes/sys-iteration')(deps),correction=require('../routes/corrections')(deps);
const app=express();app.use(express.json());app.use('/api',sys.router);app.use('/api/corrections',correction.router);

// server.js cannot be required without its process-wide side effects. Register its
// exact three production route expressions and field map in a dependency context.
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const ast=acorn.parse(source,{ecmaVersion:'latest'});
const paths=['/api/issues/:id/notify-read-status','/api/issue-lite/:id/notify-read-status','/api/collab/requests/:id/notify-read-status'];
const selected=ast.body.filter(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'&&n.expression.callee.object?.name==='app'&&paths.includes(n.expression.arguments[0]?.value));
assert.equal(selected.length,3,'exact three production routes');
const map=ast.body.find(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name==='ISSUE_READ_FIELD_MAP'));
assert.ok(map);
vm.runInNewContext([map,...selected].map(n=>source.slice(n.start,n.end)).join('\n'),{app,authenticateToken:mw,requireIssueSchemaReady:mw,requireIssueLiteSchemaReady:mw,dbGetAsync:get,dbRunAsync:serverRun,readSystemConfig:deps.readSystemConfig,callDingtalkWithTokenRetry:deps.callDingtalkWithTokenRetry,dingtalkNotify:dt,formatNotifyReadTime:require('../utils/notify-read-time').formatNotifyReadTime,logger,Date,console});
function ready(){return new Promise((resolve,reject)=>{const t=setInterval(()=>{const states=[sys._internals.SYS_SCHEMA_STATE,correction._internals.CORRECTION_SCHEMA_STATE];if(states.some(s=>s.error)){clearInterval(t);clearTimeout(deadline);reject(Error(JSON.stringify(states)));}else if(states.every(s=>s.ready)){clearInterval(t);clearTimeout(deadline);resolve();}},10);const deadline=setTimeout(()=>{clearInterval(t);reject(Error('schema readiness timeout'));},10000);});}
function request(url){return new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:url},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('request timeout')));});}
async function main(){
 let pass=0;
 try{
  await run('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT, phone TEXT, dingtalk_user_id TEXT)');
  await run("INSERT INTO users VALUES(1,'admin','管理员','admin','active','13800000001','u'),(5,'dev','开发','user','active','13800000005','u'),(13,'liaison','对接人','user','active','19900000024','u')");
  sys.initSchema();correction.initSchema();await ready();
  await run('CREATE TABLE issues(id INTEGER PRIMARY KEY, assigned_to INTEGER, requester_phone TEXT, notified_at TEXT, notify_message_key TEXT, read_at TEXT, notify_status TEXT, requester_notified_at TEXT, requester_notify_message_key TEXT, requester_read_at TEXT, requester_notify_status TEXT)');
  await run('CREATE TABLE issue_lite(id INTEGER PRIMARY KEY, notify_target_id INTEGER, requester_phone TEXT, notify_status TEXT, notify_at TEXT, notify_message_key TEXT, notify_read_at TEXT, est_notify_status TEXT, est_notify_at TEXT, est_notify_message_key TEXT, est_notify_read_at TEXT, req_notify_status TEXT, req_notify_at TEXT, req_notify_message_key TEXT, req_notify_read_at TEXT)');
  await run('CREATE TABLE collab_requests(id INTEGER PRIMARY KEY,created_by INTEGER,requester_name TEXT,requester_phone TEXT,developer_id INTEGER,notified_at TEXT,notify_message_key TEXT,read_at TEXT,done_notified_at TEXT,done_notify_message_key TEXT,done_read_at TEXT)');
  const recent=new Date(Date.now()-3600000).toISOString();
  await run("INSERT INTO issues(id,assigned_to,notified_at,notify_message_key,notify_status) VALUES(1,5,?,'issue-key','sent')",[recent]);
  await run("INSERT INTO issue_lite(id,notify_target_id,notify_at,notify_message_key,notify_status) VALUES(1,5,?,'lite-key','sent')",[recent]);
  await run("INSERT INTO collab_requests(id,created_by,developer_id,requester_name,requester_phone,notified_at,notify_message_key,done_notified_at,done_notify_message_key) VALUES(1,1,5,'业务方','13800000001',?,'collab-key',?,'done-key')",[recent,recent]);
  await run("INSERT INTO sys_issues(id,type,status,title,system_name,source,created_by,created_by_name,intake_liaison_id) VALUES(1,'bug','处理中','测试','BMS','内部',1,'管理员',13)");
  await run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,notify_status,notify_message_key,notified_at) VALUES(1,5,'开发','sent','sys-key',?)",[recent]);
  await run("INSERT INTO sys_releases(id,release_no,title,status,created_by,created_by_name) VALUES(1,'READ-1','测试','计划中',1,'管理员')");
  await run("INSERT INTO sys_release_executors(release_id,user_id,user_name,notify_status,notify_message_key,notified_at,added_by,added_by_name) VALUES(1,5,'开发','sent','exec-key',?,1,'管理员')",[recent]);
  await run("INSERT INTO correction_requests(id,source_system,location_info,requester_name,requester_phone,created_by,created_by_name,assigned_to,status,notify_status,notified_at,notify_message_key,correction_group_id,completion_notify_status,completion_notify_message_key,completion_notified_at) VALUES(1,'BMS','测试','业务方','13800000001',1,'管理员',5,'FIXED','sent',?,'correction-key',1,'sent','done-key',?)",[recent,recent]);
  await run("INSERT INTO correction_requesters(id,correction_request_id,requester_name,requester_phone,is_primary,seq,completion_notify_status,completion_notify_message_key,completion_notified_at) VALUES(1,1,'业务方','13800000001',1,1,'sent','done-key',?)",[recent]);
  await run("INSERT INTO correction_requests(id,source_system,location_info,requester_name,created_by,created_by_name,status,correction_group_id,rework_parent_id,rework_seq,completion_notify_status,completion_notify_message_key,completion_notified_at) VALUES(2,'BMS','返工测试','业务方',1,'管理员','FIXED',1,1,1,'sent','rework-key',?)",[recent]);
  server=http.createServer(app);await listenOnSafePort(server);
  const cases=[
   ['issues','/api/issues/1/notify-read-status','issues','read_at',1],
   ['lite','/api/issue-lite/1/notify-read-status','issue_lite','notify_read_at',1],
   ['collab','/api/collab/requests/1/notify-read-status','collab_requests','read_at',1],
   ['correction-dev','/api/corrections/1/notify-read-status?recipient=dev','correction_requests','read_at',1],
   ['correction-done','/api/corrections/1/notify-read-status?recipient=done&requester_id=1','correction_requesters','completion_read_at',1],
   ['correction-rework','/api/corrections/2/notify-read-status?recipient=done','correction_requests','completion_read_at',2],
   ['sys-dev','/api/sys-issues/1/notify-read-status?type=dev&dev_user_id=5','sys_issue_dev_assignees','read_at',1],
   ['executor','/api/sys-releases/1/executors/5/read-status','sys_release_executors','read_at',1],
  ];
  for(const [name,url,table,column,id]of (process.argv.includes('--window-only')?[]:cases)){
   for(const state of ['unqueryable','unread','read']){
    // Fixed seconds timestamp 2026-09-27T04:34:56Z: every DingTalk-timestamp writer must persist the +08 value below.
    readResult={readDetails:state==='unqueryable'?[]:[{userId:'u',readStatus:state==='read'?'READ':'UNREAD',readTimestamp:Math.floor(Date.parse('2026-09-27T04:34:56Z')/1000)}],readUserIds:state==='read'?['u']:[],raw:{messageReadInfoList:[]}};
    const before=await get('SELECT * FROM '+table+' WHERE id=?',[id]);
    const r=await request(url);assert.equal(r.status,200,name+' '+JSON.stringify(r.body));
    assert.equal(r.body.read_status,state,'[C2] '+name+' '+state);assert.equal(r.body.read,state==='read');
    if(state==='unqueryable')assert.equal(r.body.unqueryable_reason,'not_listed');
    const after=await get('SELECT * FROM '+table+' WHERE id=?',[id]);
    if(state!=='read')assert.deepEqual(after,before,'non-read state must not write '+name);else { assert.ok(after[column],'read persisted '+name); if(['issues','lite','sys-dev'].includes(name)){assert.match(after[column],/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,'[75] stable format '+name);assert.notEqual((await get('SELECT julianday(?) AS n',[after[column]])).n,null,'[75] SQLite can parse '+name);}
     // executor records the confirmation moment via SQLite localtime by design; every other writer formats DingTalk's timestamp.
     if(name!=='executor'){assert.equal(after[column],'2026-09-27 12:34:56','[75] '+name+' persists +08 canonical read time');assert.equal(r.body.read_at,'2026-09-27 12:34:56','[75] '+name+' returns +08 canonical read time');} }
    pass++;console.log('[OK] '+name+' '+state);
   }
   const cached=await request(url);assert.equal(cached.body.read_status,'read','cached read '+name);pass++;
   const sentColumn=name==='lite'?'notify_at':name.startsWith('correction-')&&name!=='correction-dev'?'completion_notified_at':'notified_at';
   await run('UPDATE '+table+' SET '+column+'=NULL,'+sentColumn+'=? WHERE id=?',[new Date(Date.now()-8*86400000).toISOString(),id]);
   // Read-window precheck (user 2026-09-28): even if DingTalk would answer READ, an 8-day-old notice
   // without a persisted read time is answered "expired" before any config read or outbound call.
   readResult={readDetails:[{userId:'u',readStatus:'READ',readTimestamp:Math.floor(Date.parse('2026-09-27T04:34:56Z')/1000)}],readUserIds:['u'],raw:{messageReadInfoList:[{userId:'u',readStatus:'READ'}]}};
   const q0=queries,e0=external,expired=await request(url);assert.equal(expired.status,200,name+' expired');
   assert.equal(expired.body.read_status,'unqueryable','[C2] '+name+' expired state');
   assert.equal(expired.body.unqueryable_reason,'expired','[C2] '+name+' expired reason');
   assert.equal(expired.body.read,false,'[C2] '+name+' expired read flag');assert.equal(expired.body.read_at,null,'[C2] '+name+' expired read_at');
   assert.equal(queries-q0,0,'[C2] '+name+' expired does not query DingTalk');
   assert.equal(external-e0,0,'[C2] '+name+' expired makes no external call (config/token/userid/read-status)');
   assert.equal((await get('SELECT '+column+' AS v FROM '+table+' WHERE id=?',[id])).v,null,'[C2] '+name+' expired writes nothing');pass++;
   // Persisted read time outranks the window: 8 days old + read_at present -> cached read, no external call.
   await run('UPDATE '+table+' SET '+column+'=? WHERE id=?',['2026-09-20 10:00:00',id]);
   const e1=external,cachedOld=await request(url);
   assert.deepEqual([cachedOld.status,cachedOld.body.read,cachedOld.body.read_status,cachedOld.body.cached,cachedOld.body.read_at],[200,true,'read',true,'2026-09-20 10:00:00'],'[C2] '+name+' 8-day cached read wins');
   assert.equal(external-e1,0,'[C2] '+name+' 8-day cached read makes no external call');
   await run('UPDATE '+table+' SET '+column+'=NULL WHERE id=?',[id]);pass++;
  }
  if(!process.argv.includes('--window-only'))for(const state of ['unqueryable','read']){
   await run("UPDATE issue_lite SET notify_read_at=NULL,notify_at=?,notify_message_key='old-message' WHERE id=1",[recent]);
   readResult={readDetails:[{userId:'u',readStatus:'READ',readTimestamp:Date.now()}],readUserIds:['u']};
   let response;try{liteRace=state;response=await request('/api/issue-lite/1/notify-read-status');}finally{liteRace=null;}
   assert.equal(response.status,200);assert.equal(response.body.superseded,true);
   assert.equal(response.body.read_status,state,'[C2] superseded '+state);assert.equal(response.body.read,state==='read');
   assert.equal(response.body.unqueryable_reason,state==='read'?undefined:'not_listed');
   assert.equal(response.body.read_at,state==='read'?'2026-09-27 12:34:56':null);pass++;
  }
  // Replaces legacy T12 (user decision 2026-09-28): inside 7 days the endpoint queries DingTalk and
  // judges by evidence; from 7 days on, with no persisted read time, it answers "expired" without any
  // call, whatever DingTalk would have said. READ inside the window uses a millisecond timestamp and
  // must persist the +08 canonical time (collab ms/s normalization).
  const readMs=Date.parse('2026-09-27T04:34:56Z');
  const UNREAD_R={readDetails:[{userId:'u',readStatus:'UNREAD'}],readUserIds:[],raw:{messageReadInfoList:[{userId:'u',readStatus:'UNREAD'}]}};
  const EMPTY_R={readDetails:[],readUserIds:[],raw:{messageReadInfoList:[]}};
  const READ_R={readDetails:[{userId:'u',readStatus:'READ',readTimestamp:readMs}],readUserIds:['u'],raw:{messageReadInfoList:[{userId:'u',readStatus:'READ',readTimestamp:readMs}]}};
  const windowCases=[
   [25,'UNREAD',UNREAD_R,'unread',undefined,null,1],
   [25,'READ ms',READ_R,'read',undefined,'2026-09-27 12:34:56',1],
   [167,'empty',EMPTY_R,'unqueryable','not_listed',null,1],
   [192,'UNREAD',UNREAD_R,'unqueryable','expired',null,0],
   [192,'empty',EMPTY_R,'unqueryable','expired',null,0],
   [192,'READ',READ_R,'unqueryable','expired',null,0],
  ];
  for(const [hours,label,result,state,reason,readAt,calls]of windowCases){
   await run('UPDATE collab_requests SET done_read_at=NULL,done_notified_at=? WHERE id=1',[new Date(Date.now()-hours*3600000).toISOString()]);
   readResult=result;
   const before=queries,r=await request('/api/collab/requests/1/notify-read-status?recipient=requester_done');
   const name='[T12] '+hours+' hours '+label;
   assert.equal(r.status,200,name);assert.equal(r.body.read_status,state,name);assert.equal(r.body.unqueryable_reason,reason,name+' reason');
   assert.equal(r.body.read_at,readAt,name+' read_at');assert.equal(queries-before,calls,name+' DingTalk calls');
   const [row]=await all('SELECT done_read_at FROM collab_requests WHERE id=1');assert.equal(row.done_read_at,readAt,name+' persisted read_at');
   pass++;console.log('[OK] T12 '+hours+' hours '+label+' -> '+state);
  }
  console.log('READ_ENDPOINTS PASS='+pass+' FAIL=0');
 }finally{Object.assign(dt,saved);if(server)await new Promise(resolve=>server.close(resolve));await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
