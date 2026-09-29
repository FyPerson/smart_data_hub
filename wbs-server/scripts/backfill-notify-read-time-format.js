// Two modes. Rehearsal: --db <offline-copy.db> [--apply]. Production: --live [--apply --backup <new-file.db>]
// targets this install's ../task_pool.db; --apply first takes a VACUUM INTO backup and verifies it.
// Default is always dry-run, which opens SQLite read-only.
'use strict';
const fs=require('fs'),path=require('path'),sqlite=require('sqlite3');
const READ_COLUMNS={
 issues:['read_at','requester_read_at'],
 issue_lite:['notify_read_at','est_notify_read_at','req_notify_read_at'],
 sys_issue_dev_assignees:['read_at'],
 sys_issues:['relay_read_at','creator_read_at','release_assignee_read_at','intake_read_at','requester_read_at'],
};
// Timeline summaries keep the key through sanitizeAuditText(key, 40) (routes/sys-iteration/index.js
// recordSysNotifyTimeline): DingTalk keys are 44 chars, so the summary holds the first 40. A key that
// the sanitizer masked no longer equals its own prefix and stays unmatched rather than guessed.
const TIMELINE_KEY_MAX=40;
const LIVE_DB=path.resolve(__dirname,'../task_pool.db');
const legacy=/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/;
const canonical=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// Calendar and clock round trip: rejects month 13, Feb 30, Feb 29 in a common year, hour 24, minute 60.
function isRealDateTime(year,month,day,hour,minute,second){
 const probe=new Date(0);probe.setUTCFullYear(year,month-1,day);probe.setUTCHours(hour,minute,second,0);
 return probe.getUTCFullYear()===year&&probe.getUTCMonth()===month-1&&probe.getUTCDate()===day&&probe.getUTCHours()===hour&&probe.getUTCMinutes()===minute&&probe.getUTCSeconds()===second;
}
function normalizeLegacy(value){
 const m=typeof value==='string'?legacy.exec(value):null;if(!m)return null;
 const [year,month,day,hour,minute,second]=m.slice(1).map(Number);
 if(!isRealDateTime(year,month,day,hour,minute,second))return null;
 const p=n=>String(n).padStart(2,'0');return `${m[1]}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`;
}
function isCanonical(value){
 const m=typeof value==='string'?canonical.exec(value):null;
 return !!m&&isRealDateTime(...m.slice(1).map(Number));
}
function timelineKeyMatches(tail,key){
 return typeof key==='string'&&key.length>0&&tail===key.slice(0,TIMELINE_KEY_MAX);
}
function sameFile(a,b){
 if(a.toLowerCase()===b.toLowerCase())return true;
 if(!fs.existsSync(b))return false;
 const x=fs.statSync(a),y=fs.statSync(b);return x.dev===y.dev&&x.ino===y.ino;
}
function validatePath(file,live){
 const resolved=fs.realpathSync(path.resolve(file));
 if(!fs.statSync(resolved).isFile())throw Error('--db must name an existing ordinary database file');
 if(!live&&sameFile(resolved,LIVE_DB))throw Error('Refusing live task_pool.db without --live');
 return resolved;
}
function openDb(file,mode){
 return new Promise((resolve,reject)=>{const db=new sqlite.Database(file,mode,e=>e?reject(e):resolve(db));});
}
const closeDb=db=>new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
// Backup must be a fresh file; after VACUUM INTO it has to pass integrity_check and carry the same
// per-table row counts as the source, otherwise nothing is applied.
async function takeVerifiedBackup(db,all,backup){
 const target=path.resolve(backup);
 if(fs.existsSync(target))throw Error('--backup must name a new file: '+target);
 if(!fs.existsSync(path.dirname(target)))throw Error('--backup directory does not exist: '+path.dirname(target));
 await new Promise((resolve,reject)=>db.run('VACUUM INTO ?',[target],e=>e?reject(e):resolve()));
 const copy=await openDb(target,sqlite.OPEN_READONLY);
 try{
  const copyAll=sql=>new Promise((resolve,reject)=>copy.all(sql,(e,rows)=>e?reject(e):resolve(rows)));
  const [check]=await copyAll('PRAGMA integrity_check');
  if(!check||check.integrity_check!=='ok')throw Error('Backup integrity_check failed: '+JSON.stringify(check));
  for(const table of [...Object.keys(READ_COLUMNS),'sys_issue_timeline']){
   const [a]=await all(`SELECT count(*) AS n FROM ${table}`),[b]=await copyAll(`SELECT count(*) AS n FROM ${table}`);
   if(a.n!==b.n)throw Error('Backup row count differs for '+table);
  }
 }finally{await closeDb(copy);}
 return target;
}
async function backfill(file,{apply=false,live=false,backup=null}={}){
 if(live&&apply&&!backup)throw Error('--live --apply requires --backup <new-file.db>');
 if(backup&&!(live&&apply))throw Error('--backup is only used with --live --apply');
 const resolved=validatePath(file,live);
 const db=await openDb(resolved,apply?sqlite.OPEN_READWRITE:sqlite.OPEN_READONLY);
 const run=(sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this);}));
 const all=(sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,rows)=>e?reject(e):resolve(rows)));
 let transaction=false;
 try{
  const backupFile=backup?await takeVerifiedBackup(db,all,backup):null;
  await run(apply?'BEGIN IMMEDIATE':'BEGIN');transaction=true;
  const changes=[],report={mode:apply?'apply':'dry-run',target:live?'live':'copy',backup:backupFile,read_changes:0,intake_changes:0,already_canonical:0,invalid_read_values:0,intake_unmatched:0,intake_ambiguous:0,intake_invalid_time:0,samples:[]};
  for(const [table,columns]of Object.entries(READ_COLUMNS)){
   const actual=(await all(`PRAGMA table_info(${table})`)).map(c=>c.name);
   for(const column of ['id',...columns])if(!actual.includes(column))throw Error('Missing required schema '+table+'.'+column);
   for(const column of columns)for(const row of await all(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)){
    const next=normalizeLegacy(row.value);
    if(next!==null){changes.push({table,column,id:row.id,old:row.value,value:next});report.read_changes++;}
    else if(isCanonical(row.value))report.already_canonical++;
    else report.invalid_read_values++;
   }
  }
  const pending=await all("SELECT id,intake_notify_message_key FROM sys_issues WHERE intake_notify_status='sent' AND intake_notified_at IS NULL");
  for(const row of pending){
   const candidates=await all("SELECT summary,created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'",[row.id]);
   const matches=candidates.filter(t=>{
    const match=typeof t.summary==='string'&&/^发送对接人受理通知 → [\s\S]*：成功（message_key=([^）]*)）$/.exec(t.summary);
    return match&&timelineKeyMatches(match[1],row.intake_notify_message_key);
   });
   if(matches.length===0){report.intake_unmatched++;continue;}
   if(matches.length!==1){report.intake_ambiguous++;continue;}
   const value=matches[0].created_at;
   if(!isCanonical(value)){report.intake_invalid_time++;continue;}
   changes.push({table:'sys_issues',column:'intake_notified_at',id:row.id,old:null,value});report.intake_changes++;
  }
  report.samples=changes.slice(0,10);report.would_change=changes.length;report.applied=0;
  if(apply)for(const item of changes){
   // table/column come exclusively from the above hardcoded maps, never CLI input.
   const r=await run(`UPDATE ${item.table} SET ${item.column}=? WHERE id=? AND ${item.column} IS ?`,[item.value,item.id,item.old]);
   if(r.changes!==1)throw Error('Backfill row changed concurrently: '+item.table+'.'+item.column+'#'+item.id);
   report.applied++;
  }
  await run('COMMIT');transaction=false;return report;
 }finally{
  try{if(transaction)await run('ROLLBACK');}finally{await closeDb(db);}
 }
}
if(require.main===module){
 const usage='Usage: --db <offline-copy.db> [--apply] | --live [--apply --backup <new-file.db>]';
 const args=process.argv.slice(2);let file=null,apply=false,live=false,backup=null;
 try{
  for(let i=0;i<args.length;i++){
   if(args[i]==='--db'&&!file&&args[i+1]&&!args[i+1].startsWith('--'))file=args[++i];
   else if(args[i]==='--backup'&&!backup&&args[i+1]&&!args[i+1].startsWith('--'))backup=args[++i];
   else if(args[i]==='--apply'&&!apply)apply=true;
   else if(args[i]==='--live'&&!live)live=true;
   else throw Error(usage);
  }
  if(backup&&!(live&&apply))throw Error('--backup is only used with --live --apply');
  if(live&&file)throw Error('--live targets this install\'s task_pool.db; do not combine it with --db');
  if(live)file=LIVE_DB;
  if(!file)throw Error('Explicit --db <offline-copy.db> or --live is required');
  backfill(file,{apply,live,backup}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
 }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={backfill,normalizeLegacy,isCanonical,timelineKeyMatches,READ_COLUMNS,TIMELINE_KEY_MAX};
