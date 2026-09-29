'use strict';
const assert=require('assert/strict'),path=require('path'),fs=require('fs');
const {chromium}=require('playwright');const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;const results=[];function check(name,ok){assert.ok(ok,name);pass++;results.push(name);console.log('[OK] '+name);}
async function main(){
  const f=await createFixture();console.log('ISOLATED_ARTIFACTS='+f.dir);let browser;
  try{
    const a=(await f.api('POST','/racks',{name:'A',u_total:12})).body,b=(await f.api('POST','/racks',{name:'B',u_total:12})).body;
    const host=(await f.api('POST','',{category:'server',name:'C8主机',u_height:2,slot_count:2,placement:{kind:'rack',rack_id:a.id,u_start:3}})).body;
    const disk=(await f.api('POST','',{category:'disk',name:'C8随装盘',placement:{kind:'host',parent_asset_id:host.id,slot_no:1},peer_versions:{[host.id]:host.version}})).body;
    const spare=(await f.api('POST','',{category:'server',name:'C8备机',u_height:2,placement:{kind:'depot'}})).body;
    check('真实夹具资产非空',Number.isSafeInteger(host.id)&&Number.isSafeInteger(disk.id)&&Number.isSafeInteger(spare.id));
    browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:720}});
    await context.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.goto(f.base+'/IT_Ledger.html#racks');await p.locator('.itl-rack-summary').first().waitFor();
    check('真实机柜阵列两柜',await p.locator('.itl-rack-summary').count()===2);
    check('总览刻度1/5/10/顶端12',JSON.stringify(await p.locator('.itl-rack-summary').first().locator('.itl-rack-scale span').allTextContents())===JSON.stringify(['1','12','5','10']));
    check('设备方案B浅色中性底与类型侧条',await p.locator('.itl-rack-device').evaluate(el=>getComputedStyle(el).backgroundColor==='rgb(213, 223, 205)'&&getComputedStyle(el).borderLeftColor==='rgb(176, 122, 76)'));
    await p.locator('.itl-rack-title[data-open-rack="'+a.id+'"]').click();await p.locator('#itlRackOverlay').waitFor({state:'visible'});
    await p.locator('[data-select-rack-asset="'+host.id+'"]').click();await p.locator('[data-rack-command="move"]').click();
    await p.locator('[data-u="4"].itl-can-place').waitFor();
    check('排除自身后部分重叠位置可选',await p.locator('[data-u="4"]').evaluate(el=>el.classList.contains('itl-can-place')));
    await p.locator('[data-u="4"]').hover();check('悬停预览整段2U',await p.locator('.itl-preview').count()===2);
    const relocated=p.waitForResponse(r=>r.url().endsWith('/actions/rack_relocate'));await p.locator('[data-u="4"]').click();check('同柜走rack_relocate真实200',(await relocated).status()===200);
    await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();
    let current=(await f.api('GET','/'+host.id)).body.asset;check('移位主版本+1且起点正确',current.u_start===4&&current.version===host.version+2);
    await p.locator('[data-rack-command="move"]').click();await p.locator('[data-rack-command="cancel"]').waitFor();await p.locator('[data-switch-rack="'+b.id+'"]').click();
    const moved=p.waitForResponse(r=>r.url().endsWith('/actions/rack_move'));await p.locator('[data-u="2"]').click();check('跨柜走rack_move真实200',(await moved).status()===200);
    await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();current=(await f.api('GET','/'+host.id)).body.asset;check('迁柜位置正确',current.rack_id===b.id&&current.u_start===2);
    await p.locator('[data-rack-command="out"]').click();await p.locator('[name="to"]').selectOption('faulty');const off=p.waitForResponse(r=>r.url().endsWith('/actions/rack_out'));await p.locator('#itlSubmit').click();check('下架故障真实200',(await off).status()===200);
    await p.locator('#itlModal').waitFor({state:'hidden'});const hd=(await f.api('GET','/'+host.id)).body,dd=(await f.api('GET','/'+disk.id)).body;
    check('下架随装盘同栏且装载关系保留',hd.asset.status==='faulty'&&hd.asset.rack_id===null&&dd.asset.status==='faulty'&&dd.asset.parent_asset_id===host.id);
    check('下架主关联事件同操作号',hd.events.at(-1).action==='rack_out'&&hd.events.at(-1).op_id===dd.events.at(-1).op_id&&dd.events.at(-1).role==='affected');
    await p.locator('[data-rack-command="close"]').click();await p.locator('[data-tab="depot"]').click();
    const card=p.locator('.itl-card').filter({has:p.getByRole('button',{name:'C8备机',exact:true})});await card.locator('summary').click();await card.locator('[data-action="rack_in"]').click();await p.locator('#itlRackOverlay').waitFor({state:'visible'});
    check('库房入口进入同一选位',await p.locator('[data-rack-command="cancel"]').isVisible());
    await p.keyboard.press('Escape');check('Esc先取消选位保留浮层',await p.locator('#itlRackOverlay').isVisible()&&await p.locator('[data-rack-command="cancel"]').count()===0);
    await p.keyboard.press('Escape');check('再次Esc关闭浮层',!await p.locator('#itlRackOverlay').isVisible());
    await card.locator('summary').click();await card.locator('[data-action="rack_in"]').click();await p.locator('[data-u="6"].itl-can-place').waitFor();
    const blocker=await f.api('POST','',{category:'server',name:'并发占位',u_height:1,placement:{kind:'rack',rack_id:a.id,u_start:6}});check('并发占位成功201',blocker.status===201);
    const before=await f.all('SELECT * FROM it_assets ORDER BY id'),events=await f.all('SELECT * FROM it_asset_events ORDER BY id');
    const conflict=p.waitForResponse(r=>r.url().endsWith('/actions/rack_in'));await p.locator('[data-u="6"]').click();check('旧选位真实重叠409',(await conflict).status()===409);
    await p.locator('#itlRackMessage').filter({hasText:/重叠|占用/}).waitFor();
    check('冲突退出旧意图不重提',await p.locator('[data-rack-command="cancel"]').count()===0);
    check('冲突资产完整行不变',JSON.stringify(await f.all('SELECT * FROM it_assets ORDER BY id'))===JSON.stringify(before));
    check('冲突事件完整行不变',JSON.stringify(await f.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(events));
    await p.setViewportSize({width:900,height:540});const close=await p.locator('[data-rack-command="close"]').boundingBox();check('540px关闭按钮可达',close&&close.y>=0&&close.y+close.height<=540);
    await p.screenshot({path:path.join(f.dir,'c8-rack-low.png'),fullPage:true});
    await p.locator('[data-rack-command="close"]').click();await p.locator('[data-tab="racks"]').click();await p.locator('[data-rack-command="create"]').click();
    await p.locator('[name="name"]').fill('C8新柜');const created=p.waitForResponse(r=>r.url().endsWith('/racks')&&r.request().method()==='POST');await p.locator('#itlSubmit').click();check('admin页面建柜201',(await created).status()===201);
    await p.locator('.itl-rack-title').filter({hasText:'C8新柜'}).waitFor();check('新柜即时进入阵列',await p.locator('.itl-rack-summary').count()===3);
    // Positive rack_in and both remaining rack_out destinations through the real UI.
    for(const to of ['in_depot','to_retire']){
      const existing=(await f.api('GET','/'+host.id)).body.asset;
      if(existing.status!=='in_depot')check('准备可用状态200',(await f.api('POST','/'+host.id+'/actions/mark_status',{expected_version:existing.version,status:'in_depot'})).status===200);
      // #itlRefresh removed: reload replaces the manual click. No drawer/overlay is open at this point
      // (the previous loop iteration already closed the rack overlay), and the very next line switches tab explicitly.
      await p.reload();await p.locator('[data-tab="depot"]').click();
      const hostCard=p.locator('.itl-card').filter({has:p.getByRole('button',{name:'C8主机',exact:true})});await hostCard.locator('.itl-menu summary').click();await hostCard.locator('[data-action="rack_in"]').click();await p.locator('[data-u="2"].itl-can-place').waitFor();
      // Client snapshot says occupied; authoritative database has a free interval.
      await p.evaluate(rackId=>ITLedger.state.assets.push({id:999999,category:'server',name:'旧占位快照',status:'in_service',rack_id:rackId,u_start:2,u_height:2}),a.id);
      const on=p.waitForResponse(r=>r.url().endsWith('/actions/rack_in'));await p.locator('[data-u="2"]').click();check('库房上架真实200 '+to,(await on).status()===200);await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();
      const beforeOut=(await f.api('GET','/'+host.id)).body.asset, diskBefore=(await f.api('GET','/'+disk.id)).body.asset;
      await p.locator('[data-rack-command="out"]').click();await p.locator('[name="to"]').selectOption(to);const out=p.waitForResponse(r=>r.url().endsWith('/actions/rack_out'));await p.locator('#itlSubmit').click();check('下架'+to+'真实200',(await out).status()===200);await p.locator('#itlModal').waitFor({state:'hidden'});
      const hostAfter=(await f.api('GET','/'+host.id)).body.asset,diskAfter=(await f.api('GET','/'+disk.id)).body.asset;
      check('下架'+to+'两行同步且各版本加一',hostAfter.status===to&&diskAfter.status===to&&hostAfter.version===beforeOut.version+1&&diskAfter.version===diskBefore.version+1);
      await p.locator('[data-rack-command="close"]').click();
    }
    const huge=(await f.api('POST','/racks',{name:'大范围机柜测试',u_total:1000000000})).body;
    // #itlRefresh removed: reload replaces the manual click; no drawer/overlay open here either.
    await p.reload();await p.locator('[data-tab="racks"]').click();await p.locator('.itl-rack-title[data-open-rack="'+huge.id+'"]').click();await p.locator('#itlRackJump').waitFor();
    check('超大合法U数有限DOM且顶端可达',await p.locator('.itl-u-row').count()===120&&await p.locator('[data-u="1000000000"]').count()===1);
    await p.locator('#itlRackJump').fill('120');await p.locator('[data-rack-command="jump"]').click();check('远端跳转最底U可达',await p.locator('[data-u="1"]').count()===1&&await p.locator('.itl-u-row').count()===120);
    await p.locator('[data-rack-command="close"]').click();
    await p.evaluate(id=>ITLedger.openRack(id),huge.id);await p.locator('#itlRackJump').waitFor();
    await p.evaluate(id=>{ITLedger.state.racks=ITLedger.state.racks.filter(r=>r.id!==id);document.querySelector('[data-rack-command="jump"]').click();},huge.id);
    check('机柜跳转目标消失中文提示并关闭',!(await p.locator('#itlRackOverlay').isVisible())&&(await p.locator('#itlNotice').innerText()).includes('机柜已不存在'));
    await p.evaluate(()=>ITLedger.refresh());
    // Exact full-row checks for management rejection. UI must retain the field error.
    await p.locator('.itl-rack-summary [data-manage-rack="'+a.id+'"]').click();await p.locator('[name="u_total"]').fill('5');
    const shrinkAssets=await f.all('SELECT * FROM it_assets ORDER BY id'),shrinkEvents=await f.all('SELECT * FROM it_asset_events ORDER BY id');
    const racksBefore=await f.all('SELECT * FROM it_racks ORDER BY id');const shrink=p.waitForResponse(r=>r.url().endsWith('/racks/'+a.id)&&r.request().method()==='PUT');await p.locator('#itlSubmit').click();const shrinkResponse=await shrink;if(shrinkResponse.status()!==409)console.log('SHRINK_DIAGNOSTIC',shrinkResponse.status(),await shrinkResponse.text(),await f.all('SELECT id,name,rack_id,u_start,u_height,status FROM it_assets'));check('缩容低于占用真实409',shrinkResponse.status()===409);
    check('拒绝缩容机柜完整行不变',JSON.stringify(await f.all('SELECT * FROM it_racks ORDER BY id'))===JSON.stringify(racksBefore));await p.locator('#itlModalCancel').click();
    check('拒绝缩容资产事件完整行不变',JSON.stringify(await f.all('SELECT * FROM it_assets ORDER BY id'))===JSON.stringify(shrinkAssets)&&JSON.stringify(await f.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(shrinkEvents));
    await p.locator('.itl-rack-summary [data-manage-rack="'+a.id+'"]').click();await p.locator('#itlDeleteRack').click();
    const beforeDelete={racks:await f.all('SELECT * FROM it_racks ORDER BY id'),assets:await f.all('SELECT * FROM it_assets ORDER BY id'),events:await f.all('SELECT * FROM it_asset_events ORDER BY id')};
    const refused=p.waitForResponse(r=>r.url().endsWith('/racks/'+a.id)&&r.request().method()==='DELETE');await p.locator('#itlSubmit').click();check('删除占用机柜真实409',(await refused).status()===409);
    check('拒绝删除三表完整行不变',JSON.stringify({racks:await f.all('SELECT * FROM it_racks ORDER BY id'),assets:await f.all('SELECT * FROM it_assets ORDER BY id'),events:await f.all('SELECT * FROM it_asset_events ORDER BY id')})===JSON.stringify(beforeDelete));await p.locator('#itlModalCancel').click();
    const empty=(await f.api('GET','/racks')).body.items.find(r=>r.name==='C8新柜');
    await p.locator('.itl-rack-summary [data-manage-rack="'+empty.id+'"]').click();await p.locator('[name="u_total"]').fill('48');const resized=p.waitForResponse(r=>r.url().endsWith('/racks/'+empty.id)&&r.request().method()==='PUT');await p.locator('#itlSubmit').click();check('空柜修改真实200',(await resized).status()===200);await p.locator('#itlModal').waitFor({state:'hidden'});
    check('修改总U真实落库',(await f.api('GET','/racks')).body.items.find(r=>r.id===empty.id).u_total===48);
    await p.locator('.itl-rack-summary [data-manage-rack="'+empty.id+'"]').click();await p.locator('#itlDeleteRack').click();const deleted=p.waitForResponse(r=>r.url().endsWith('/racks/'+empty.id)&&r.request().method()==='DELETE');await p.locator('#itlSubmit').click();check('空柜删除真实200',(await deleted).status()===200);await p.locator('#itlModal').waitFor({state:'hidden'});
    check('删除空柜不制造资产事件',JSON.stringify(await f.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(beforeDelete.events));
    for(const uid of [2,3]){
      const ctx=await browser.newContext();await ctx.addInitScript(id=>localStorage.setItem('token','fixture-'+id),uid);const page=await ctx.newPage();
      await page.goto(f.base+'/IT_Ledger.html#racks');await page.locator('.itl-rack-summary').first().waitFor();check('角色'+uid+'无机柜管理入口',await page.locator('[data-manage-rack],[data-rack-command="create"]').count()===0);
      await page.locator('.itl-rack-title[data-open-rack="'+a.id+'"]').click();await page.locator('[data-select-rack-asset="'+blocker.body.id+'"]').click();check('角色'+uid+'位置写操作权限',await page.locator('[data-rack-command="move"]').count()===(uid===2?1:0));
      await ctx.close();
    }
    check('浏览器无未捕获异常',errors.length===0||(console.log(errors),false));
    fs.writeFileSync(path.join(f.dir,'c8-result.json'),JSON.stringify({pass,fail:0,results,errors},null,2));console.log(`C8_BROWSER PASS=${pass} FAIL=0`);
  }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);console.error(`C8_BROWSER PASS=${pass} FAIL=1`);process.exitCode=1;});
