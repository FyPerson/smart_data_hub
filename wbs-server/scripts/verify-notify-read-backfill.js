'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),rawAssert=require('assert/strict'),sqlite=require('sqlite3'),{spawnSync}=require('child_process');
let pass=0;const assert={equal(...args){rawAssert.equal(...args);pass++;},deepEqual(...args){rawAssert.deepEqual(...args);pass++;},ok(...args){rawAssert.ok(...args);pass++;}};
const {READ_COLUMNS,TIMELINE_KEY_MAX,timelineKeyMatches,isCanonical}=require('./backfill-notify-read-time-format');
// Production DingTalk processQueryKey shape: 44-char base64. Hand-built, not derived from the script.
const K5='Qm9vN2tLeFp3UjRzVGI4TmNZMWRGNmdIM2pLNWFFMHU=';
const K6='WnFwM0tMcjdUdjJtTmI4WXcxc0Q2ZkczaEo1YUUwdU8=';
const K6_OTHER=K6.slice(0,39)+(K6[39]==='A'?'B':'A')+K6.slice(40);   // same first 39, differs at index 39
const K7='UjJkVDhuTHc0cVpiNnlNM3hDMWZHN2hKOWtBNXNQMGU=';
const K8='TDRmWTduQnEyc1hjOHdSNnZLMWRIM2dNOWpUNWFaMHU=';
// A key whose first 40 chars hold a phone-shaped run: the writer's sanitizer turns 13812345678 into 138****5678.
const K9='Zx9Q13812345678pLmN4rTy7uVwQe2sHf8jKc5bXgA0=';
const K9_MASKED_TAIL='Zx9Q138****5678pLmN4rTy7uVwQe2sHf8jKc5bX';   // sanitize(key) keeps length, then slice(0,40)
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'read-time-backfill-')),file=path.join(dir,'copy.db');let db;
 const open=(f=file)=>new Promise((resolve,reject)=>{db=new sqlite.Database(f,e=>e?reject(e):resolve());});
 const close=()=>new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
 const run=(sql,p=[])=>new Promise((resolve,reject)=>db.run(sql,p,e=>e?reject(e):resolve()));
 const all=(sql)=>new Promise((resolve,reject)=>db.all(sql,(e,rows)=>e?reject(e):resolve(rows)));
 const script=path.join(__dirname,'backfill-notify-read-time-format.js');
 const env={...process.env,NODE_PATH:[path.join(__dirname,'..','node_modules'),process.env.NODE_PATH||''].join(path.delimiter)};
 function exec(scriptFile,args,success,label='[C5] backfill run'){const r=spawnSync(process.execPath,[scriptFile,...args],{encoding:'utf8',env,timeout:300000,killSignal:'SIGKILL'});assert.equal(r.status,success?0:1,label+' exit code\n'+r.stdout+r.stderr);return success?JSON.parse(r.stdout):r.stderr;}
 function invoke(apply=false,success=true){return exec(script,['--db',file,...(apply?['--apply']:[])],success);}
 try{
  // Write-side tripwire: the matching rule depends on recordSysNotifyTimeline truncating to 40.
  const indexSrc=fs.readFileSync(path.join(__dirname,'..','routes','sys-iteration','index.js'),'utf8');
  assert.equal(indexSrc.split('message_key=${sanitizeAuditText(messageKeyOrErr, 40)}').length-1,1,'[C5] timeline writer still truncates keys to 40');
  assert.equal(TIMELINE_KEY_MAX,40);
  for(const k of [K5,K6,K6_OTHER,K7,K8])assert.equal(k.length,44,'[C5] fixture keys are production length');
  assert.equal(K6.slice(0,39),K6_OTHER.slice(0,39));assert.ok(K6.slice(0,40)!==K6_OTHER.slice(0,40));
  assert.equal(K9.length,44);assert.ok(K9.slice(0,40).includes('13812345678')&&K9_MASKED_TAIL!==K9.slice(0,40),'[C5] masked fixture differs from the raw prefix');
  assert.deepEqual(['2026-02-28 23:59:59','2024-02-29 00:00:00','2026-02-30 06:00:00','2025-02-29 06:00:00','2026-13-40 25:61:61','2026-01-01 24:00:00','2026-01-01 00:60:00','2026-8-4 06:08:09'].map(isCanonical),[true,true,false,false,false,false,false,false],'[C5] canonical values must be real calendar times');
  assert.deepEqual([timelineKeyMatches(K5.slice(0,40),K5),timelineKeyMatches(K5,K5),timelineKeyMatches(K5.slice(0,39),K5),timelineKeyMatches('key-10','key-1'),timelineKeyMatches('',''),timelineKeyMatches('x',null)],[true,false,false,false,false,false],'[C5] match is exact 40-char prefix only');

  await open();
  for(const [table,columns]of Object.entries(READ_COLUMNS)){
   await run(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,${columns.map(c=>c+' TEXT').join(',')}${table==='sys_issues'?',intake_notify_status TEXT,intake_notify_message_key TEXT,intake_notified_at TEXT':''})`);
   await run(`INSERT INTO ${table}(id,${columns.join(',')}) VALUES(1,${columns.map(()=>'?').join(',')})`,columns.map(()=>'2026/8/4 6:08:09'));
  }
  await run('CREATE TABLE sys_issue_timeline(id INTEGER PRIMARY KEY,issue_id INTEGER,action_code TEXT,summary TEXT,created_at TEXT)');
  await run("INSERT INTO issues(id,read_at,requester_read_at) VALUES(2,'garbage','2026/13/4 6:08:09')");
  await run("INSERT INTO issues(id,read_at) VALUES(3,'2026-02-30 06:00:00')");   // canonical shape, impossible date → invalid
  await run("INSERT INTO issues(id,read_at) VALUES(4,'2026-02-28 23:59:59')");   // real canonical value → already_canonical
  for(const [id,key]of [[1,'key-1'],[2,'key-2'],[3,'key-3'],[4,'key-4'],[5,K5],[6,K6],[7,K7],[8,K8],[9,'key-9'],[10,'key-10x'],[11,K9]]){
   await run("INSERT OR IGNORE INTO sys_issues(id) VALUES(?)",[id]);
   await run("UPDATE sys_issues SET intake_notify_status='sent',intake_notify_message_key=? WHERE id=?",[key,id]);
  }
  const timeline=(id,issue,key,date,channel='对接人受理')=>run('INSERT INTO sys_issue_timeline VALUES(?,?,\'notify_sent\',?,?)',[id,issue,`发送${channel}通知 → 测试：成功（message_key=${key}）`,date]);
  await timeline(1,1,'key-1','2026-08-04 06:00:00');await timeline(2,1,'key-10','2026-08-05 06:00:00');
  await timeline(3,2,'other-key-2','2026-08-06 06:00:00');await timeline(4,2,'key-2','2026-08-06 07:00:00','建单人');
  await timeline(5,3,'key-3','2026-08-07 06:00:00');await timeline(6,3,'key-3','2026-08-08 06:00:00');
  await timeline(7,4,'key-4','bad-time');
  await timeline(8,5,K5.slice(0,40),'2026-08-09 06:00:00');                       // production shape → match
  await timeline(9,6,K6_OTHER.slice(0,40),'2026-08-10 06:00:00');                 // differs at char 40 → unmatched
  await timeline(10,7,K7.slice(0,40),'2026-08-11 06:00:00');await timeline(11,7,K7.slice(0,40),'2026-08-11 07:00:00');   // ambiguous
  await timeline(12,8,K8,'2026-08-12 06:00:00');                                  // untruncated tail is not the writer's shape → unmatched
  await timeline(13,9,'key-9','2026-13-40 25:61:61');                             // canonical shape, impossible time → invalid_time
  await timeline(14,10,'key-10x','2025-02-29 06:00:00');                          // Feb 29 in a common year → invalid_time
  await timeline(15,11,K9_MASKED_TAIL,'2026-08-13 06:00:00');                     // writer masked a phone-like run → unmatched
  await close();db=null;

  // --live runs against a copied install (scripts/ + ../task_pool.db) so the real database is never involved.
  const install=path.join(dir,'install'),liveScript=path.join(install,'scripts','backfill-notify-read-time-format.js'),liveDb=path.join(install,'task_pool.db');
  fs.mkdirSync(path.dirname(liveScript),{recursive:true});fs.copyFileSync(script,liveScript);fs.copyFileSync(file,liveDb);
  const liveBefore=fs.readFileSync(liveDb);
  assert.ok(exec(liveScript,['--live','--apply'],false,'[D2] live apply without backup refused').includes('requires --backup'),'[D2] live apply without backup refused');
  assert.ok(exec(liveScript,['--backup',path.join(dir,'b0.db')],false,'[D2] backup without live refused').includes('only used with --live --apply'),'[D2] backup without live refused');
  assert.ok(exec(liveScript,['--live','--db',file],false,'[D2] live with db refused').includes('do not combine'),'[D2] live with db refused');
  assert.ok(exec(liveScript,['--db',liveDb],false,'[D2] install db via --db still refused').includes('without --live'),'[D2] install db via --db still refused');
  fs.writeFileSync(path.join(dir,'taken.db'),'x');
  assert.ok(exec(liveScript,['--live','--apply','--backup',path.join(dir,'taken.db')],false,'[D2] existing backup target refused').includes('must name a new file'),'[D2] existing backup target refused');
  const liveDry=exec(liveScript,['--live'],true,'[D2] live dry-run');assert.deepEqual([liveDry.mode,liveDry.target,liveDry.backup,liveDry.would_change],['dry-run','live',null,13],'[D2] live dry-run report');
  assert.deepEqual(fs.readFileSync(liveDb),liveBefore,'[D2] refusals and live dry-run write zero bytes');
  assert.equal(fs.existsSync(path.join(dir,'b0.db')),false);
  const backupFile=path.join(dir,'backup.db');
  const liveApplied=exec(liveScript,['--live','--apply','--backup',backupFile],true,'[D2] live apply with verified backup');
  assert.deepEqual([liveApplied.mode,liveApplied.target,liveApplied.backup,liveApplied.applied],['apply','live',backupFile,13],'[D2] live apply report');
  await open(backupFile);assert.deepEqual(await all('SELECT read_at FROM issues WHERE id=1'),[{read_at:'2026/8/4 6:08:09'}],'[D2] backup holds the pre-change snapshot');
  assert.deepEqual(await all('SELECT id FROM sys_issues WHERE intake_notified_at IS NOT NULL'),[],'[D2] backup has no backfilled intake times');await close();db=null;
  await open(liveDb);assert.deepEqual(await all('SELECT read_at FROM issues WHERE id=1'),[{read_at:'2026-08-04 06:08:09'}],'[D2] live rows normalized in place');
  assert.deepEqual(await all('SELECT id,intake_notified_at FROM sys_issues WHERE intake_notified_at IS NOT NULL ORDER BY id'),[{id:1,intake_notified_at:'2026-08-04 06:00:00'},{id:5,intake_notified_at:'2026-08-09 06:00:00'}],'[D2] live intake backfill');await close();db=null;

  const before=fs.readFileSync(file);const dry=invoke();assert.equal(dry.mode,'dry-run');assert.equal(dry.applied,0);assert.equal(dry.would_change,13,'[C5] dry run candidate count');assert.deepEqual(fs.readFileSync(file),before,'[C5] dry-run zero bytes written');
  assert.equal(dry.invalid_read_values,3,'[C5] invalid values counted');assert.equal(dry.already_canonical,1,'[C5] only real calendar values count as canonical');assert.equal(dry.intake_unmatched,4,'[C5] unmatched keys preserved');assert.equal(dry.intake_ambiguous,2,'[C5] ambiguous keys preserved');assert.equal(dry.intake_invalid_time,3,'[C5] invalid timeline counted');
  const applied=invoke(true);assert.equal(applied.applied,13,'[C5] applied exact count');
  await open();
  for(const [table,columns]of Object.entries(READ_COLUMNS)){
   const [row]=await all(`SELECT ${columns.join(',')} FROM ${table} WHERE id=1`);
   assert.deepEqual(row,Object.fromEntries(columns.map(c=>[c,'2026-08-04 06:08:09'])),'[C5] exact normalized values '+table);
  }
  assert.deepEqual(await all('SELECT id,intake_notified_at FROM sys_issues ORDER BY id'),[{id:1,intake_notified_at:'2026-08-04 06:00:00'},{id:2,intake_notified_at:null},{id:3,intake_notified_at:null},{id:4,intake_notified_at:null},{id:5,intake_notified_at:'2026-08-09 06:00:00'},{id:6,intake_notified_at:null},{id:7,intake_notified_at:null},{id:8,intake_notified_at:null},{id:9,intake_notified_at:null},{id:10,intake_notified_at:null},{id:11,intake_notified_at:null}],'[C5] exact 40-char prefix match only, no latest/ambiguous fallback, impossible times and masked keys stay NULL');
  assert.deepEqual(await all('SELECT id,read_at,requester_read_at FROM issues WHERE id IN (2,3,4) ORDER BY id'),[{id:2,read_at:'garbage',requester_read_at:'2026/13/4 6:08:09'},{id:3,read_at:'2026-02-30 06:00:00',requester_read_at:null},{id:4,read_at:'2026-02-28 23:59:59',requester_read_at:null}],'[C5] invalid and already-canonical values retained');
  await close();db=null;const again=invoke(true);assert.equal(again.applied,0,'[C5] idempotent apply');assert.equal(again.would_change,0);
  // A later update fails: all earlier updates must roll back in the one transaction.
  await open();await run("UPDATE issues SET read_at='2026/8/4 6:08:09' WHERE id=1");await run("UPDATE issue_lite SET notify_read_at='2026/8/4 6:08:09' WHERE id=1");
  await run("CREATE TRIGGER fail_backfill BEFORE UPDATE ON issue_lite BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  await close();db=null;invoke(true,false);
  await open();assert.deepEqual(await all('SELECT read_at FROM issues WHERE id=1'),[{read_at:'2026/8/4 6:08:09'}],'[C5] failed apply rolls back earlier table');await close();db=null;
  console.log('BACKFILL PASS='+pass+' FAIL=0 dry-run=13 apply=13 rerun=0 invalid=3 canonical=1 unmatched=4 ambiguous=2 invalid_timeline=3 live=7');
 }finally{if(db)await close();rawAssert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
