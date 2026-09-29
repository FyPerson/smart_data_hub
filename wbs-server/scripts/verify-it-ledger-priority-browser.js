'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser,pass=0;console.log('ISOLATED_ARTIFACTS='+f.dir);
 const check=(label,value)=>{assert.ok(value,label);pass++;console.log('[OK] '+label);};
 const create=async body=>{const r=await f.api('POST','',body);assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
 try{
  const r1=(await f.api('POST','/racks',{name:'甲柜',u_total:200})).body,r2=(await f.api('POST','/racks',{name:'乙柜',u_total:24})).body;
  const host=await create({category:'server',name:'可定位服务器',u_height:2,slot_count:2,fin_amount:7890,placement:{kind:'rack',rack_id:r1.id,u_start:10}});
  await f.api('PUT','/floors/F2',{name:'二楼',rooms:[{id:'R1',name:'空房',w:8,h:5},{id:'R2',name:'研发室',w:12.5,h:8}]});
  const ap=await create({category:'ap',name:'可定位AP',placement:{kind:'depot'}});assert.equal((await f.api('POST','/'+ap.id+'/actions/ap_place',{expected_version:ap.version,floor_id:'F2',room_id:'R2',pos:{x:.3,y:.7}})).status,200);
  const bulk=[];for(let i=0;i<55;i++)bulk.push(await create({category:'laptop',name:'批量资产'+String(i).padStart(2,'0'),asset_no:'B-'+i,placement:{kind:'depot'}}));
  browser=await chromium.launch({headless:true});const c=await browser.newContext({viewport:{width:1440,height:960}});await c.addInitScript(()=>{if(!localStorage.getItem('token'))localStorage.setItem('token','fixture-1');});
  const p=await c.newPage(),errors=[],writes=[];p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.url().includes('/api/it-assets')&&r.method()!=='GET')writes.push(r.url());});
  await p.goto(f.base+'/IT_Ledger.html#all');await p.locator('#itlTable').waitFor();
  await p.locator('#itlSearch').fill('批量');await p.locator('#itlCategory').selectOption('laptop');await p.locator('#itlStatus').selectOption('in_depot');await p.locator('th[data-sort-by="name"]').click();await p.locator('th[data-sort-by="name"]').click();await p.locator('[data-page-nav="next"]').click();
  check('筛选结果第二页',await p.locator('#itlPager').innerText().then(s=>s.includes('第 2 / 3')));
  const firstName=await p.locator('#itlTable [data-detail]').first().innerText();
  await p.locator('#itlTable [data-detail]').first().click();await p.locator('.itl-detail-group').first().waitFor();check('详情分为三组',await p.locator('.itl-detail-group h3').allTextContents().then(x=>x.join(',')==='基本信息,位置与归属,采购与财务'));
  await p.locator('#itlDrawerClose').click();check('关闭详情保留页码与排序',await p.locator('#itlTable [data-detail]').first().innerText()===firstName&&(await p.locator('#itlPager').innerText()).includes('第 2'));
  // #itlRefresh removed: this check is specifically about an in-place refresh preserving page/sort context,
  // distinct from the full-reload persistence check three lines below — trigger ITLedger.refresh() directly.
  await p.evaluate(()=>ITLedger.refresh());check('刷新保留页码与排序',await p.locator('#itlTable [data-detail]').first().innerText()===firstName&&(await p.locator('#itlPager').innerText()).includes('第 2'));
  // refresh() re-renders and schedules its own scroll restore via requestAnimationFrame (restoreContext); let that
  // pending frame settle before this block drives scroll itself, or the two race and the manual scroll gets undone.
  await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await p.evaluate(()=>window.scrollTo(0,350));await p.waitForFunction(()=>scrollY>100);const scrollBefore=await p.evaluate(()=>scrollY);
  await p.reload();await p.locator('#itlTable').waitFor();await p.waitForFunction(()=>scrollY>100);check('浏览器刷新恢复筛选与页面',await p.locator('#itlSearch').inputValue()==='批量'&&await p.locator('#itlCategory').inputValue()==='laptop'&&await p.locator('#itlStatus').inputValue()==='in_depot'&&(await p.locator('#itlPager').innerText()).includes('第 2'));
  check('浏览器刷新恢复滚动位置',Math.abs((await p.evaluate(()=>scrollY))-scrollBefore)<5);
  await p.locator('[data-page-nav="next"]').click();for(const a of bulk.slice(50)){assert.equal((await f.api('POST','/'+a.id+'/actions/mark_status',{expected_version:a.version,status:'faulty'})).status,200);}
  await p.evaluate(()=>ITLedger.refresh());check('结果页数减少时回退到末页',(await p.locator('#itlPager').innerText()).includes('第 2 / 2'));
  await p.locator('#itlTable [data-action="edit"]').first().click();await p.locator('[name="note"]').fill('验证编辑返回上下文');const edited=p.waitForResponse(r=>r.request().method()==='PUT'&&/\/api\/it-assets\/\d+$/.test(r.url()));await p.locator('#itlSubmit').click();check('编辑真实200',(await edited).status()===200);await p.locator('.itl-detail-group').first().waitFor();await p.locator('#itlDrawerClose').click();check('编辑返回仍是原页原顺序',await p.locator('#itlTable [data-detail]').first().innerText()===firstName&&(await p.locator('#itlPager').innerText()).includes('第 2'));
  await p.locator('#itlSearch').fill('批量资产00');check('主动筛选回第一页',(await p.locator('#itlPager').innerText()).includes('第 1 / 1'));
  await p.locator('#itlCategory').selectOption('');await p.locator('#itlStatus').selectOption('');await p.locator('#itlSearch').fill('可定位服务器');await p.locator('#itlTable [data-detail]').click();await p.locator('.itl-detail-group').first().waitFor();check('管理员财务值保留',(await p.locator('#itlDrawerBody').innerText()).includes('7890'));await p.screenshot({path:path.join(f.dir,'priority-detail-groups.png'),fullPage:true});
  await p.locator('#itlDrawerClose').click();const writesBefore=writes.length;await p.locator('#itlTable [data-locate]').click();await p.locator('.itl-face-device.itl-selected').waitFor();check('只定位服务器不进入写模式',await p.locator('.itl-face-device.itl-selected').getAttribute('data-select-rack-asset')===String(host.id)&&await p.locator('[data-rack-command="cancel"]').count()===0&&writes.length===writesBefore);
  check('深U位定位高亮可见',await p.locator('.itl-face-device.itl-selected').isVisible());
  await p.locator('[data-rack-command="move"]').click();await p.locator('[data-switch-rack="'+r2.id+'"]').click();await p.locator('[data-u="3"]').hover();check('机柜目标预览含原位置与范围',(await p.locator('#itlRackTargetPreview').innerText()).includes('甲柜 · U10–11 → 乙柜 · U3–4'));
  const move=p.waitForResponse(r=>r.url().endsWith('/actions/rack_move'));await p.locator('[data-u="3"]').click();check('机柜迁移真实200',(await move).status()===200);await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();check('机柜反馈含设备和新位置',(await p.locator('#itlRackMessage').innerText()).includes('可定位服务器 → 乙柜 · U3–4'));
  await p.locator('[data-rack-command="close"]').click();await p.locator('[data-tab="all"]').click();check('定位返回保留搜索',await p.locator('#itlSearch').inputValue()==='可定位服务器');await p.locator('#itlSearch').fill('可定位AP');await p.locator('#itlTable [data-locate]').click();await p.locator('.itl-ap-point.itl-selected').waitFor();check('AP定位实际楼层房间和点位',await p.locator('[data-floor="F2"]').getAttribute('aria-current')==='page'&&await p.locator('[data-room-select="R2"]').getAttribute('aria-current')==='true');
  await p.reload();await p.locator('.itl-ap-point.itl-selected').waitFor();check('AP房间与选中点刷新恢复',await p.locator('[data-room="R2"]').count()===1);
  await p.locator('[data-action="ap_relocate"]').click();await p.locator('[data-room-select="R1"]').click();check('AP显示原位置与目标房间',(await p.locator('.itl-location-preview').innerText()).includes('二楼 · 研发室 → 二楼 · 空房'));
  const apmove=p.waitForResponse(r=>r.url().endsWith('/actions/ap_relocate'));await p.locator('[data-room="R1"]').focus();await p.keyboard.press('Enter');check('AP移位真实200',(await apmove).status()===200);await p.locator('#itlToast').filter({hasText:'AP位置已保存'}).waitFor();check('AP反馈含设备与新房间',(await p.locator('#itlToast').innerText()).includes('可定位AP → 二楼 · 空房'));
  await p.screenshot({path:path.join(f.dir,'priority-ap-feedback.png'),fullPage:true});
  const saved=await p.evaluate(()=>sessionStorage.getItem('itl-workspace-context-v1'));check('只存UI上下文不含令牌或财务',saved&&!saved.includes('fixture-1')&&!saved.includes('7890')&&!saved.includes('fin_amount'));
  await p.evaluate(()=>localStorage.setItem('token','fixture-3'));await p.reload();await p.locator('#itlTabs').waitFor();await p.locator('[data-tab="all"]').click();check('换账号清空旧筛选',await p.locator('#itlSearch').inputValue()==='');await p.locator('#itlSearch').fill('可定位服务器');await p.locator('#itlTable [data-detail]').click();await p.locator('.itl-detail-group').first().waitFor();check('只读详情无财务与编辑',(await p.locator('#itlDrawerBody').innerText()).includes('采购信息')&&!(await p.locator('#itlDrawerBody').innerText()).includes('7890')&&await p.locator('#itlDrawerBody [data-action="edit"]').count()===0);
  const roWrites=writes.length;await p.locator('#itlDrawerBody [data-locate]').click();await p.locator('.itl-face-device.itl-selected').waitFor();check('只读可定位且无写请求',writes.length===roWrites&&await p.locator('[data-rack-command="move"]').count()===0);
  // #itlRefresh removed: reload replaces the manual click — no open drawer/overlay here (just closed the rack
  // command panel), and this matches the platform's own recovery text now ("请重新打开页面").
  await p.locator('[data-rack-command="close"]').click();await f.run('DELETE FROM it_asset_acl WHERE user_id=3');await p.reload();await p.waitForFunction(()=>document.querySelector('#itlAccess').textContent==='尚未获准访问');check('撤权清理持久上下文',await p.evaluate(()=>sessionStorage.getItem('itl-workspace-context-v1')===null));
  check('无未捕获浏览器异常',errors.length===0);fs.writeFileSync(path.join(f.dir,'priority-result.json'),JSON.stringify({pass,errors},null,2));console.log(`PRIORITY_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
