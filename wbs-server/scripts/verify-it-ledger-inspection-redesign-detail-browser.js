'use strict';
const assert=require('assert/strict'),fs=require('fs');const {chromium}=require('playwright');const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;const equal=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);pass++;console.log('[OK] '+name);};
async function main(){
 const f=await createFixture({cleanup:true});let browser;
 const api=async(method,url,body,uid=2,status=200)=>{const r=await f.api(method,url,body,uid);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
 const upload=async(s,slot,target)=>{const fd=new FormData();fd.append('slot',slot);fd.append('target_id',String(target));fd.append('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'巡检.png');assert.equal((await fetch(f.base+'/api/it-assets/inspections/sheets/'+s.id+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-2'},body:fd})).status,201);};
 try{
  const racks=[];for(let i=1;i<=2;i++)racks.push(await api('POST','/racks',{room:'详情测试',name:'机柜'+i,u_total:24},1,201));
  for(let i=1;i<=2;i++)await api('POST','',{category:'server',name:'服务器'+i,u_height:1,placement:{kind:'rack',rack_id:racks[0].id,u_start:i}},1,201);
  let s=await api('POST','/inspections/sheets',{room_name:'详情测试'},2,201);
  const bad=s.items.find(it=>it.section==='rack'&&it.target_id===racks[1].id);
  s=await api('PUT','/inspections/sheets/'+s.id,{expected_version:s.version,remark:'检查完成',items:s.items.map(it=>({id:it.id,result:it.value_kind==='check'?(it.id===bad.id?'bad':'ok'):null,number_value:it.value_kind==='number'?(it.item_key==='temperature'?30:45):null,note:it.id===bad.id?'柜门锁待维修':null}))});
  for(const r of racks)await upload(s,'rack_front',r.id);await upload(s,'item',bad.id);
  s=await api('POST','/inspections/sheets/'+s.id+'/submit',{expected_version:s.version},1);
  await api('POST','/inspections/sheets/archive',{items:[{id:s.id,expected_version:s.version}]},1);
  s=await api('GET','/inspections/sheets/'+s.id,undefined,1);
  await api('POST','/inspections/sheets/'+s.id+'/unarchive',{expected_version:s.version,reason:'复核'},1);
  s=await api('GET','/inspections/sheets/'+s.id,undefined,1);
  browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addInitScript(()=>localStorage.setItem('token','fixture-1'));const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(f.base+'/IT_Ledger.html#inspections');await page.locator('[data-insp-view="'+s.id+'"]').click();await page.locator('#itlSheetMetrics').waitFor();};
  await open();
  equal('DD五项指标全等',await page.locator('[data-metric-value]').allTextContents(),['18 / 18','1','3 / 3','30 ℃','45 %']);
  equal('DD参考范围超出弱提示',await page.locator('#itlSheetMetrics>div').nth(3).locator('small').innerText(),'参考 18–27 · 超出参考范围');
  equal('DD机房正常标签全等',await page.locator('[data-normal-section="room"] .itl-normal-tag').allTextContents(),['空调运行','UPS 与供电','消防设施','门禁与门锁','漏水与地面','卫生与杂物']);
  equal('DD机柜合并与逐项标签全等',await page.locator('[data-normal-section="rack"] .itl-normal-tag').allTextContents(),['机柜1 四项正常','机柜2 · 运行指示灯','机柜2 · 线缆与标签','机柜2 · PDU 与电源']);
  equal('DD设备正常标签逐台全等',await page.locator('[data-normal-section="device"] .itl-normal-tag').allTextContents(),['服务器1','服务器2']);
  equal('DD正常项默认展开',await page.locator('.itl-normal-tag').evaluateAll(nodes=>nodes.every(el=>el.getBoundingClientRect().height>0)),true);
  equal('DD异常说明在结果最前',await page.locator('#itlSheetResults').evaluate(el=>el.querySelector('.itl-sheet-bad-list').compareDocumentPosition(el.querySelector('.itl-sheet-ok'))&Node.DOCUMENT_POSITION_FOLLOWING),4);
  equal('DD异常说明保留',await page.locator('.itl-sheet-bad-list p').innerText(),'柜门锁待维修');
  equal('DD操作记录含创建且倒序',await page.locator('[data-log-action]').allTextContents(),['撤回归档','归档','提交巡检','开始填写']);
  equal('DD操作人姓名全等',await page.locator('[data-log-actor]').allTextContents(),['测试管理员','测试管理员','测试管理员','测试维护员']);
  equal('DD日志ID顺序全等',await page.locator('[data-log-id]').evaluateAll(nodes=>nodes.map(el=>Number(el.dataset.logId))),[s.log[3].id,s.log[2].id,s.log[1].id,s.log[0].id]);
  equal('DD左右栏几何',await page.locator('.itl-sheet-detail-layout').evaluate(el=>el.querySelector('.itl-sheet-detail-main').getBoundingClientRect().right<=el.querySelector('.itl-sheet-detail-side').getBoundingClientRect().left),true);
  equal('DD照片三张保留',await page.locator('.itl-sheet-detail-side [data-detail-photo-view]').count(),3);
  await page.waitForFunction(()=>[...document.querySelectorAll('.itl-sheet-detail-side img')].every(img=>img.complete&&img.naturalWidth>0));
  equal('DD照片网格三列',await page.locator('.itl-sheet-photo-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
  fs.mkdirSync(require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign'),{recursive:true});await page.screenshot({path:require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign/detail.png'),fullPage:true});
  await f.run('DELETE FROM users WHERE id=2');await page.evaluate(id=>window.ITLedger.openInspectionSheet(id),s.id);await page.locator('#itlSheetMetrics').waitFor();
  equal('DD缺失用户回退操作人编号',await page.locator('[data-log-actor]').allTextContents(),['测试管理员','测试管理员','测试管理员','操作人 #2']);
  // Deleted sheet uses its actual read-only API response, never fabricated actions.
  await api('DELETE','/inspections/sheets/'+s.id,{expected_version:s.version,reason:'测试删除'},1);
  await page.evaluate(id=>window.ITLedger.openInspectionSheet(id),s.id);await page.locator('#itlSheetResults').waitFor();
  equal('DD已删除单零可写控件',await page.locator('#itlContent input:not([disabled]),#itlContent textarea:not([disabled]),#itlSheetEdit,#itlSheetDelete,#itlSheetUnarchive,[data-photo-upload],[data-photo-delete],[data-seg-ok],[data-seg-bad]').count(),0);
  equal('DD已删除提示明确',await page.locator('#itlContent .itl-notice').innerText().then(t=>t.includes('这张巡检单已删除')),true);
  equal('DD无浏览器异常',errors,[]);await ctx.close();
  // A real owner losing write permission can read an incomplete draft: fallback tags remain visible.
  await f.run("INSERT INTO users(id,username,display_name,role) VALUES(2,'fixture-write','测试维护员','user')");
  const draft=await api('POST','/inspections/sheets',{room_name:'详情测试'},2,201);
  await f.run("UPDATE it_asset_acl SET level='read' WHERE user_id=2");
  const ro=await browser.newContext();await ro.addInitScript(()=>localStorage.setItem('token','fixture-2'));const p=await ro.newPage();await p.goto(f.base+'/IT_Ledger.html#inspections');await p.locator('[data-insp-view="'+draft.id+'"]').click();await p.locator('#itlSheetMetrics').waitFor();
  equal('DD未填读数指标兜底',await p.locator('[data-metric-value]').allTextContents(),['0 / 18','0','0 / 2','—','—']);
  equal('DD未填标签完整展示',await p.locator('.itl-normal-tag').allTextContents(),[
   '温度（℃，参考 18–27） · 未填','湿度（%，参考 40–60） · 未填','空调运行 · 未填','UPS 与供电 · 未填','消防设施 · 未填','门禁与门锁 · 未填','漏水与地面 · 未填','卫生与杂物 · 未填',
   '机柜1 · 柜门锁闭 · 未填','机柜1 · 运行指示灯 · 未填','机柜1 · 线缆与标签 · 未填','机柜1 · PDU 与电源 · 未填','机柜2 · 柜门锁闭 · 未填','机柜2 · 运行指示灯 · 未填','机柜2 · 线缆与标签 · 未填','机柜2 · PDU 与电源 · 未填','服务器1 · 未填','服务器2 · 未填']);
  equal('DD无异常标题立即可见',await p.locator('#itlSheetResults>header .itl-sheet-clear').innerText(),'本次无异常项');
  equal('DD只读草稿没有编辑控件',await p.locator('#itlFormActionbar,input:not([disabled]),textarea:not([disabled])').count(),0);
  await ro.close();console.log('REDESIGN_DETAIL_BROWSER PASS='+pass+' FAIL=0');
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);console.log('REDESIGN_DETAIL_BROWSER PASS='+pass+' FAIL=1');process.exitCode=1;});
