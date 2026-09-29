// Execute the actual page query functions with controlled responses and real CSS.
// No application server, real DB, user session or external notification is involved.
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),acorn=require('acorn');
const {chromium}=require('playwright');
const root=path.join(__dirname,'../public');
function sourceFunction(file,name){
 const html=fs.readFileSync(path.join(root,file),'utf8'),found=[];
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
  if(!match[1].trim())continue;
  const tree=acorn.parse(match[1],{ecmaVersion:'latest'});
  for(const node of tree.body)if(node.type==='FunctionDeclaration'&&node.id.name===name)found.push(match[1].slice(node.start,node.end));
 }
 assert.equal(found.length,1,file+' '+name+' unique actual function');return found[0];
}
async function main(){
 const browser=await chromium.launch({headless:true});let pass=0;
 try{
  const cases=[
   ['Data_Collab.html','checkReadStatus','readStatusBox_developer',[1,'developer']],
   ['Data_Correction.html','queryReadStatus','corrReadBox_dev',[1,'dev']],
   ['Issue_Tracker.html','checkIssueReadStatus','readStatusBox_1_issue_developer',[1,'issue_developer']],
   ['Issue_Lite.html','notifyRead','ilReadBox_peer',[1,'peer']],
   ['Sys_Iteration.html','siQueryReadStatus','siReadBox_dev',[ 'dev',5]],
   ['Sys_Iteration.html','siExecutorRowReadStatus','siExecReadBox_1_5',[1,5]],
  ];
  for(const [file,name,box,args]of cases){
   const page=await browser.newPage();
   try{
    await page.route('http://notify.test/**',route=>route.fulfill({body:'<!doctype html><html><body></body></html>',contentType:'text/html'}));
    await page.goto('http://notify.test/');
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'assets/css/style.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'assets/css/components.css'),'utf8')});
    await page.evaluate(box=>{
     document.body.innerHTML='<span id="reference" class="u-nt-muted">reference</span><span id="plain">plain</span><span class="u-nr-read-result" id="'+box+'"></span><button id="siExecReadBtn1_5">查询</button>';
     window.currentDrawerId=1;window.siDetail={issue:{id:1}};window.siReadBoxId=()=>box;
     window.fetch=window.authFetch=async()=>({ok:true,json:async()=>window.response});
     window.siApi=async()=>({ok:true,data:window.response});window.toasts=[];window.refreshes=0;
     window.showToast=(text)=>window.toasts.push(text);
     window.openDetail=window.openDrawer=window.refreshDrawer=window.siAfterAction=window.siOpenBatchDetail=async()=>{window.refreshes++;};
     window.escapeHtml=window.esc=text=>String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;');
     window.fmtDate=window.formatFullTime=window.ilFmtTime=window.siFmtDT=text=>String(text);
    },box);
    await page.addScriptTag({content:sourceFunction(file,name)});
    for(const [reason,text,title]of [
     ['expired','— 超期无法查询','钉钉只保留约 7 天的已读记录'],
     ['not_listed','— 暂时无法查询','钉钉未返回该收件人的已读记录，可稍后再查'],
    ]){
     const actual=await page.evaluate(async({name,args,box,reason})=>{
      window.response={read:false,read_status:'unqueryable',unqueryable_reason:reason};await window[name](...args);
      const node=document.getElementById(box),span=node.firstElementChild,reference=document.getElementById('reference');
      return {text:node.textContent,title:span.title,color:getComputedStyle(span).color,referenceColor:getComputedStyle(reference).color,plainColor:getComputedStyle(document.getElementById('plain')).color,refreshes:window.refreshes,buttonDisabled:document.getElementById('siExecReadBtn1_5').disabled};
     },{name,args,box,reason});
     assert.equal(actual.text,text,'[C3] '+name+' '+reason+' text');assert.equal(actual.title,title,'[C3] '+name+' '+reason+' title');
     assert.equal(actual.color,actual.referenceColor,'[C3] muted computed color');assert.notEqual(actual.referenceColor,actual.plainColor,'[C3] muted rule is live (differs from plain text)');assert.equal(actual.refreshes,0,'third state must not refresh');assert.equal(actual.buttonDisabled,false);
     pass++;console.log('[OK] '+name+' '+reason+' exact text/title/computed color');
    }
    if(name.startsWith('si'))for(const reason of ['expired','not_listed']){
     const actual=await page.evaluate(async({name,args,box,reason})=>{document.getElementById(box)?.remove();window.toasts=[];window.response={read:false,read_status:'unqueryable',unqueryable_reason:reason};await window[name](...args);return window.toasts;},{name,args,box,reason});
     assert.deepEqual(actual,[reason==='expired'?'超期无法查询':'暂时无法查询'],'[C3] '+name+' toast');pass++;
    }
   }finally{await page.close();}
  }
  console.log('THREE_STATE_BROWSER PASS='+pass+' FAIL=0');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
