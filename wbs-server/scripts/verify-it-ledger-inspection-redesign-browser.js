'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;
function equal(name,actual,expected){assert.deepEqual(actual,expected,name);pass++;console.log('[OK] '+name);}
async function main(){
 const f=await createFixture({cleanup:true}); let browser;
 const api=async(method,url,body,uid=2,status=200)=>{const r=await f.api(method,url,body,uid);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
 const draft=room=>api('POST','/inspections/sheets',{room_name:room},2,201);
 const photo=async(s,slot,target,uid)=>{const fd=new FormData();fd.append('slot',slot);fd.append('target_id',String(target));fd.append('file',new Blob([Buffer.from([255,216,255,224,0,0,255,217])],{type:'image/jpeg'}),'front.jpg');assert.equal((await fetch(f.base+'/api/it-assets/inspections/sheets/'+s.id+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-'+uid},body:fd})).status,201);};
 async function submit(room,uid=2,bad=false){
  const s=await draft(room),badItem=s.items.find(it=>it.item_key==='aircon');
  const filled=await api('PUT','/inspections/sheets/'+s.id,{expected_version:s.version,items:s.items.map(it=>({id:it.id,result:it.value_kind==='check'?(bad&&it.id===badItem.id?'bad':'ok'):null,number_value:it.value_kind==='number'?(it.item_key==='temperature'?22:45):null,note:bad&&it.id===badItem.id?'检查异常':null}))},uid);
  await photo(s,'rack_front',s.scope.racks[0].id,uid);if(bad)await photo(s,'item',badItem.id,uid);
  return api('POST','/inspections/sheets/'+s.id+'/submit',{expected_version:filled.version},uid);
 }
 try{
  const start=(await f.all("SELECT date('now','localtime') AS day"))[0].day;
  const [y,m,d]=start.split('-').map(Number);
  const before=days=>new Date(y,m-1,d-days,12).toISOString();
  for(const room of ['Alpha','Beta','Due','Never','Ninety','OldDraft','PastYear'])await api('POST','/racks',{name:room+'柜',room,u_total:20},1,201);
  const a=await submit('Alpha'); const ad=await draft('Alpha');
  const b=await submit('Beta',1,true);
  const c=await submit('Due');await api('POST','/inspections/sheets/archive',{items:[{id:c.id,expected_version:c.version}]},1);
  await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[before(91),c.id]);
  const e=await submit('Ninety');await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[before(90),e.id]);
  const od=await draft('OldDraft');await f.run('UPDATE it_inspection_sheets SET created_at=? WHERE id=?',[before(90),od.id]);
  const py=await submit('PastYear');await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[new Date(y-1,0,1,12).toISOString(),py.id]);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>localStorage.setItem('token','fixture-1'));
  const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/inspections/sheets')&&r.method()==='GET')requests.push(new URL(r.url()).pathname+new URL(r.url()).search);});
  await page.goto(f.base+'/IT_Ledger.html#inspections');await page.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
  const ids=()=>page.locator('[data-insp-row]').evaluateAll(rows=>rows.map(r=>Number(r.dataset.inspRow)));
  const counts=()=>page.locator('#itlInspStatusTabs b').allTextContents();
  const initial=await ids(),initialCounts=await counts();
  const states=await page.locator('[data-insp-room-status]').allTextContents();
  const title=await page.locator('#itlInspMonth').innerText();
  await page.locator('#itlInspTimeFilter').selectOption('all');const all=await ids();
  await page.locator('#itlInspTimeFilter').selectOption('year');const year=await ids();
  await page.locator('#itlInspTimeFilter').selectOption('90');
  const end=(await f.all("SELECT date('now','localtime') AS day"))[0].day;
  equal('RD运行期间跨日，请重跑',end,start);
  equal('RD90天草稿始终显示',initial.includes(od.id),true);
  equal('RD默认90天提交边界全等',initial,[od.id,e.id,b.id,ad.id,a.id]);
  equal('RD全部时间全等',all,[py.id,od.id,e.id,c.id,b.id,ad.id,a.id]);
  const expectedYear=[od.id,e.id,c.id,b.id,ad.id,a.id].filter(id=>id!==e.id&&id!==c.id || (id===e.id?before(90):before(91)).slice(0,4)===String(y));
  equal('RD今年排除去年提交',year,expectedYear);
  equal('RD默认时间选项',await page.locator('#itlInspTimeFilter').inputValue(),'90');
  equal('RD卡片状态优先草稿',states,['填写中','本月已巡检','本月未巡检','本月未巡检','本月未巡检','填写中','本月未巡检']);
  equal('RD标题月份机房数全等',title,y+' 年 '+m+' 月 · 7 个机房，2 个本月已巡检');
  equal('RD初始页签计数全等',initialCounts,['5','2','3','1','0']);
  equal('RD概览进度值与草稿及历史记录全等',await page.locator('#itlInspOverview progress').evaluateAll(nodes=>nodes.map(n=>n.value)),[0,100,100,0,100,0,100]);
  equal('RD警示描边为语义色',await page.locator('[data-insp-room="Never"]').evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--sem-hold-bd)';el.append(probe);const r={actual:getComputedStyle(el).borderTopColor,expected:getComputedStyle(probe).color};probe.remove();return r.actual===r.expected;}),true);
  equal('RD从未巡检文案',await page.locator('[data-insp-room="Never"] p').first().innerText(),'尚无巡检记录');
  const columns=await page.locator('#itlInspOverview').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);equal('RD宽屏一行五卡',columns,5);
  await page.locator('#itlInspSearch').fill('aLpHa');
  equal('RD搜索后页签计数全等',await counts(),['2','1','1','0','0']);
  equal('RD机房搜索不区分大小写',await ids(),[ad.id,a.id]);
  await page.locator('[data-insp-status="draft"]').click();equal('RD页签筛选结果',await ids(),[ad.id]);
  await page.locator('[data-insp-status=""]').click();await page.locator('#itlInspSearch').fill('测试维护员');
  // The list's inspector remains its creator; Beta's proxy submitter only changes overview attribution.
  equal('RD按巡检人搜索',await ids(),[od.id,e.id,b.id,ad.id,a.id]);
  await page.locator('#itlInspSearch').fill('不存在');equal('RD无匹配计数',await counts(),['0','0','0','0','0']);
  await page.locator('#itlInspSearch').fill('');await page.locator('#itlInspRoomFilter').selectOption('Beta');
  equal('RD机房下拉结果',await ids(),[b.id]);equal('RD机房下拉计数',await counts(),['1','0','1','1','0']);
  await page.locator('[data-insp-status="abnormal"]').click();equal('RD异常页签结果',await ids(),[b.id]);
  equal('RD筛选不追加请求',requests,['/api/it-assets/inspections/sheets/overview','/api/it-assets/inspections/sheets']);
  equal('RD管理员唯一可见主按钮',await page.locator('.itl-page .u-btn-primary:visible').count(),1);
  equal('RD巡检只显示业务标题行',await page.locator('.itl-page > .itl-heading').evaluate(el=>getComputedStyle(el).display),'none');
  equal('RD管理员勾选与已删除',await page.locator('#itlInspCheckAll,#itlInspOpenDeleted').count(),2);
  await page.locator('[data-insp-check="'+b.id+'"]').check();equal('RD批量归档仍可用',await page.locator('#itlInspBatchArchive').innerText(),'批量归档（1）');
  await page.locator('#itlInspSearch').fill('no-match');equal('RD筛选清理隐藏勾选',await page.locator('#itlInspBatchArchive').isHidden(),true);
  // Select-all may only pick archivable rows the current filters show; hidden submitted sheets stay out of batch archive.
  await page.locator('#itlInspSearch').fill('');await page.locator('#itlInspCheckAll').check();
  equal('RD全选只选当前可见行',await page.locator('[data-insp-check]:checked').evaluateAll(n=>n.map(x=>Number(x.dataset.inspCheck))),[b.id]);
  equal('RD全选批量数只计可见行',await page.locator('#itlInspBatchArchive').innerText(),'批量归档（1）');
  await page.locator('#itlInspCheckAll').uncheck();
  await page.locator('#itlInspSearch').fill('');await page.locator('#itlInspRoomFilter').selectOption('');await page.locator('[data-insp-status=""]').click();
  // Browser clock drift cannot change the server-derived day.
  await page.evaluate(()=>{window.__realDateNow=Date.now;Date.now=()=>0;});
  try{await page.locator('#itlInspTimeFilter').selectOption('90');equal('RD浏览器时钟漂移不影响筛选',await ids(),[od.id,e.id,b.id,ad.id,a.id]);}finally{await page.evaluate(()=>{Date.now=window.__realDateNow;delete window.__realDateNow;});}
  const serverTime=await page.evaluate(()=>window.ITLedger.state.serverTime);
  try{
    await page.evaluate(()=>window.ITLedger.state.serverTime=null);await page.locator('#itlInspTimeFilter').selectOption('90');
    equal('RD未知服务器日期只保留草稿',await ids(),[od.id,ad.id]);
  }finally{await page.evaluate(value=>window.ITLedger.state.serverTime=value,serverTime);await page.locator('#itlInspTimeFilter').selectOption('90');}
  await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[before(-1),e.id]);
  try{
    await page.reload();await page.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
    equal('RD未来提交不计入近90天',await ids(),[od.id,b.id,ad.id,a.id]);
  }finally{await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?',[before(90),e.id]);await page.reload();await page.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);}
  await page.locator('#itlInspSearch').fill('Alpha');await page.locator('#itlInspTimeFilter').selectOption('all');
  await page.locator('[data-tab="racks"]').click();await page.locator('[data-tab="inspections"]').click();await page.locator('#itlInspSearch').waitFor();
  equal('RD离开清理新增筛选',await page.locator('#itlInspSearch').inputValue(),'');equal('RD离开恢复默认时间',await page.locator('#itlInspTimeFilter').inputValue(),'90');
  await page.waitForFunction(()=>document.querySelectorAll('[data-insp-room]').length===7);
  equal('RD重入概览进度值全等',await page.locator('#itlInspOverview progress').evaluateAll(nodes=>nodes.map(n=>n.value)),[0,100,100,0,100,0,100]);
  fs.mkdirSync(require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign'),{recursive:true});await page.screenshot({path:require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign/list.png'),fullPage:true});
  equal('RD无浏览器异常',errors,[]);
  await context.close();
  const reader=await browser.newContext();await reader.addInitScript(()=>localStorage.setItem('token','fixture-3'));const rp=await reader.newPage();
  await rp.goto(f.base+'/IT_Ledger.html#inspections');await rp.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
  equal('RD他人草稿概览不泄露异常',await rp.locator('[data-insp-room="Alpha"]').innerText().then(t=>t.includes('异常')),false);
  equal('RD他人草稿不计异常页签',await rp.locator('[data-insp-status="abnormal"] b').innerText(),'1');
  await reader.close();
  console.log('REDESIGN_BROWSER PASS='+pass+' FAIL=0');
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);console.log('REDESIGN_BROWSER PASS='+pass+' FAIL=1');process.exitCode=1;});
