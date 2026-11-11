// #208 C3：共享 test-env 临时实例，私有 HTML 副本；VM 与真实浏览器的目标断言必须判红。
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert'),acorn=require('acorn');
const {spawnSync}=require('child_process');
const testEnv=require('./lib/test-env');
const {deleteTreeNoFollow}=require('../../scripts/lines/line-common');
function changeOne(text,from,to,label){assert.strictEqual(text.split(from).length-1,1,'unique anchor '+label);return text.replace(from,to);}
function changeFunction(html,name,from,to){
 const script=Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),m=>m[1]).filter(x=>x.trim()).join('\n');
 const ast=acorn.parse(script,{ecmaVersion:'latest'}),matches=[];
 function walk(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&n.id&&n.id.name===name)matches.push(n);for(const [key,v]of Object.entries(n)){if(key==='start'||key==='end')continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}}
 walk(ast);assert.strictEqual(matches.length,1);const fn=script.slice(matches[0].start,matches[0].end);
 return changeOne(html,fn,changeOne(fn,from,to,name),name+' body');
}
async function main(){
 await testEnv.ready({readyTimeoutMs:180000});
 let failure=null,work,sourcePath,bytes,hash;
 try{
  sourcePath=path.join(__dirname,'../public/Sys_Iteration.html');bytes=fs.readFileSync(sourcePath);hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const source=bytes.toString('utf8').replace(/\r\n/g,'\n');work=fs.mkdtempSync(path.join(os.tmpdir(),'sys-note-c3-mutations-'));
  const simple=(from,to)=>(html=>changeOne(html,from,to,from.slice(0,35)));
  const fn=(name,from,to)=>(html=>changeFunction(html,name,from,to));
  const cases=[
   ['history-active-only','vm','C3 version attachments',simple('(a.removed_event_id == null || Number(a.removed_event_id) > Number(eventId))',"a.status === 'active'")],
   ['filename-not-escaped','vm','C3 current history escape',simple('>📎 ${esc(a.original_name || \'附件\')}</button>','>📎 ${a.original_name || \'附件\'}</button>')],
   ['delta-not-escaped','vm','C3 current history escape',simple("esc(label + names.join('、'))","label + names.join('、')")],
   ['remove-ids-lost','vm','C3 FormData snapshot',simple("data.append('remove_attachment_ids', JSON.stringify(selection.removedIds));","data.append('remove_attachment_ids', '[]');")],
   ['owner-account-not-bound','vm','C3 account ownership',simple('return Number.isSafeInteger(id) && id > 0 && currentUser && Number(currentUser.id) === id ? id : 0;','return Number.isSafeInteger(id) && id > 0 ? id : 0;')],
   ['close-reset-missing','vm','C3 picker reset lifecycle',fn('siCloseModal',"'hold-note'","'removed-hold-note'")],
   ['audit-section-missing','vm','C3 audit snapshot section',simple("['hold_note_attachments_json', '暂缓备注附件快照']","['missing_note_snapshot', '暂缓备注附件快照']")],
   ['busy-message-generic','browser','L-605-1 browser busy download',simple("res.status === 503 ? '系统繁忙，请稍后重试' : '下载失败，请刷新后重试'","res.status === 503 ? '下载失败' : '下载失败，请刷新后重试'")],
   ['late-toast-guard-missing','browser','C3 browser busy and late instance',simple('if (siModalInstanceSeq !== myInstance || siHoldNoteOwnerId() !== owner || Number(siOpenId) !== myIssue) return false;','if (siHoldNoteOwnerId() !== owner || Number(siOpenId) !== myIssue) return false;')],
   ['busy-controls-enabled','browser','C3 browser busy and late instance',simple("root.dataset.busy = '1'; controls.forEach(el => { el.disabled = true; });","root.dataset.busy = '1';")],
   ['busy-paste-accepted','browser','C3 browser busy and late instance',simple('if (key === \'hold-note\' && document.querySelector(\'#siHoldNoteExisting[data-busy="1"]\')) return 0;','// mutation: paste accepted while submitting')],
   ['replacement-reset-missing','browser','C3 browser drawer and auth cleanup',fn('siModal',"siPickerReset('hold-note');",'// mutation: no reset on modal replacement')],
   ['logout-reset-missing','browser','C3 browser logout cleanup',simple("window.addEventListener('pagehide', () => siPickerReset('hold-note'));",'// mutation: no note reset on pagehide')],
  ];
  for(const [name,kind,target,mutate]of cases){
   const variant=path.join(work,name+'.html');fs.writeFileSync(variant,mutate(source));
   const entry=kind==='vm'?'verify-sys-hold-note-ui.js':'test-sys-hold-note-playwright.js';
   const r=spawnSync(process.execPath,[path.join(__dirname,entry)],{encoding:'utf8',timeout:90000,maxBuffer:6*1024*1024,
    env:{...process.env,...testEnv.childEnv(),C3_HTML_SOURCE:variant}});
   const output=(r.stdout||'')+(r.stderr||'');
   assert.strictEqual(r.error,undefined,'mutation must finish '+name);
   assert.strictEqual(r.status,1,'mutation must assert-fail '+name+'\n'+output);
   assert.ok(output.includes('FAIL '+target),'wrong failure '+name+'\n'+output);
   assert.ok(!/TimeoutError|timeout/.test(output),'timeout is not a target assertion '+name+'\n'+output);
   console.log('RED '+name+' | exit=1 | FAIL '+target);
  }
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),hash);
  console.log('C3 mutations '+cases.length+'/'+cases.length+' red; HTML SHA256 '+hash+' unchanged');
 }catch(e){failure=e;}
 try{await testEnv.teardown();}catch(e){failure=failure||e;}
 if(failure){if(work)console.error('C3 mutation evidence retained: '+work);throw failure;}
 deleteTreeNoFollow(work,[]);fs.rmdirSync(work);
 testEnv.finish(0);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
