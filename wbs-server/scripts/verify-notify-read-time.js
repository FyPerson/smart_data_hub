'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),acorn=require('acorn');
const {chromium}=require('playwright');
const {formatNotifyReadTime}=require('../utils/notify-read-time');
assert.equal(formatNotifyReadTime(0),'1970-01-01 08:00:00','[75] epoch formatting uses Shanghai');
assert.equal(formatNotifyReadTime(Date.parse('2026-08-04T08:38:37Z')),'2026-08-04 16:38:37','[75] millisecond formatting uses Shanghai');
assert.throws(()=>formatNotifyReadTime(Infinity),TypeError);
function extract(source,name){const tree=acorn.parse(source,{ecmaVersion:'latest'}),nodes=tree.body.filter(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.equal(nodes.length,1,name);return source.slice(nodes[0].start,nodes[0].end);}
async function main(){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/js/app.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../public/Sys_Iteration.html'),'utf8');
  const inline=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).find(s=>s.includes('function siFmtDT('));
  await page.addScriptTag({content:extract(app,'formatDateTimeUnified')+'\n'+extract(inline,'siFmtDT')+'\n'+extract(inline,'siFmtDTSec')+'\n'+extract(inline,'siRenderIntakeNotifyRow')});
  await page.evaluate(()=>{window.siIntakeLiaisonName=()=> '对接人';window.esc=String;window.siNotifyRowHtml=(...args)=>args;});
  for(const value of ['2026/8/4 16:38:37','2026-08-04 16:38:37']){
   const actual=await page.evaluate(v=>[formatDateTimeUnified(v),siFmtDT(v),siFmtDTSec(v)],value);
   assert.deepEqual(actual,['2026-08-04 16:38:37','2026-08-04 16:38','2026-08-04 16:38:37'],'[75] old/new browser display '+value);
   assert.equal(await page.evaluate(v=>siRenderIntakeNotifyRow({intake_notify_status:'sent',intake_notified_at:v},false,false)[3],value),value,'[75] intake row passes notified timestamp');
  }
  console.log('READ_TIME PASS=7 FAIL=0');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
