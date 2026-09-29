'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');const {createFixture}=require('./it-ledger-browser-fixture');const {trackWriteRefresh}=require('./it-ledger-refresh-wait');
let pass=0;const results=[];function check(name,ok){assert.ok(ok,name);pass++;results.push(name);console.log('[OK] '+name);}
async function main(){
  const f=await createFixture();let browser;console.log('ISOLATED_ARTIFACTS='+f.dir);
  const get=async id=>(await f.api('GET','/'+id)).body.asset;
  const snapshot=async()=>({assets:await f.all('SELECT * FROM it_assets ORDER BY id'),events:await f.all('SELECT * FROM it_asset_events ORDER BY id')});
  async function create(body){const r=await f.api('POST','',body);assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
  try{
    const rr=await f.api('POST','/racks',{name:'C9柜',u_total:12});assert.equal(rr.status,201);const rack=rr.body;
    const a=await create({category:'server',name:'旧机A',u_height:2,slot_count:4,placement:{kind:'rack',rack_id:rack.id,u_start:1}});
    const b=await create({category:'server',name:'宿主B',u_height:2,slot_count:4,placement:{kind:'rack',rack_id:rack.id,u_start:5}});
    const c=await create({category:'server',name:'新机C',u_height:2,slot_count:4,placement:{kind:'depot'}});
    const old=await create({category:'disk',name:'原盘',sn:'C9-OLD',placement:{kind:'host',parent_asset_id:a.id,slot_no:1},peer_versions:{[a.id]:a.version}});
    const spare=await create({category:'disk',name:'替换盘',sn:'C9-SPARE',placement:{kind:'depot'}});
    const loose=await create({category:'disk',name:'装盘测试',sn:'C9-MOUNT',placement:{kind:'depot'}});
    check('真实夹具三机三盘',Number.isSafeInteger(c.id)&&Number.isSafeInteger(loose.id));
    const readOnlyBefore=await snapshot();let readOnlyError;
    try{await f.all("UPDATE it_assets SET name='不得写入'");}catch(error){readOnlyError=error;}
    check('快照助手真实只读拒写',readOnlyError?.code==='SQLITE_READONLY');
    check('只读拒写后全部资产事件不变',JSON.stringify(await snapshot())===JSON.stringify(readOnlyBefore));
    browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1280,height:800}});await ctx.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await ctx.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));const settled=trackWriteRefresh(p);
    await p.goto(f.base+'/IT_Ledger.html#racks');await p.locator('.itl-rack-title').click();await p.locator('[data-select-rack-asset="'+a.id+'"]').click();await p.locator('[data-rack-command="disks"]').click();await p.locator('.itl-disk-grid').waitFor();
    check('盘位四列',await p.locator('.itl-disk-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)===4);
    check('机柜来源返回文案',await p.locator('#itlHardwareClose').innerText()==='返回机柜');
    await p.locator('[data-disk-slot="1"]').click();check('在位宿主换移拆三入口',await p.locator('[data-disk-op]').count()===3);
    const aBefore=await get(a.id),oldBefore=await get(old.id);
    await p.locator('[data-disk-op="disk_swap"]').click();await p.locator('[name="new_disk_id"]').selectOption(String(spare.id));await p.locator('[name="to"]').selectOption('to_retire');
    let response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_swap'));await p.locator('#itlSubmit').click();let r=await response;check('换盘真实200',r.status()===200);
    const body=r.request().postDataJSON();check('换盘peer精确新盘与宿主',Object.keys(body.peer_versions).sort().join(',')===[a.id,spare.id].sort((x,y)=>String(x).localeCompare(String(y))).join(','));
    await p.locator('#itlModal').waitFor({state:'hidden'});let replaced=await get(spare.id),removed=await get(old.id),host=await get(a.id);
    check('换盘三行状态位置版本',removed.status==='to_retire'&&removed.parent_asset_id===null&&removed.version===oldBefore.version+1&&replaced.parent_asset_id===a.id&&replaced.slot_no===1&&replaced.version===spare.version+1&&host.version===aBefore.version+1);
    let events=await f.all('SELECT * FROM it_asset_events WHERE op_id=?',[ (await r.json()).op_id]);check('换盘真实三行事件',events.length===3&&events.filter(e=>e.role==='primary').length===1&&events.filter(e=>e.role==='affected').length===2);
    await p.locator('[data-disk-slot="1"]').click();await p.locator('[data-disk-op="disk_move"]').click();
    check('移盘目标排除源宿主',await p.locator('[name="parent_asset_id"] option[value="'+a.id+'"]').count()===0);
    await p.locator('[name="parent_asset_id"]').selectOption(String(b.id));await p.locator('[name="slot_no"]').fill('2');const aMove=await get(a.id),bMove=await get(b.id);
    response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_move'));await p.locator('#itlSubmit').click();r=await response;check('移盘真实200',r.status()===200);
    check('移盘peer精确两宿主',Object.keys(r.request().postDataJSON().peer_versions).sort().join(',')===[a.id,b.id].sort((x,y)=>String(x).localeCompare(String(y))).join(','));
    replaced=await get(spare.id);check('移盘主与两宿主各版本加一',replaced.parent_asset_id===b.id&&replaced.slot_no===2&&replaced.version===spare.version+2&&(await get(a.id)).version===aMove.version+1&&(await get(b.id)).version===bMove.version+1);
    await p.locator('#itlModal').waitFor({state:'hidden'});await p.keyboard.press('Escape');check('Esc仅关闭盘位保留机柜',!await p.locator('#itlHardwareOverlay').isVisible()&&await p.locator('#itlRackOverlay').isVisible());
    await p.locator('[data-select-rack-asset="'+b.id+'"]').click();await p.locator('[data-rack-command="disks"]').click();await p.locator('[data-disk-slot="2"]').click();await p.locator('[data-disk-op="disk_unmount"]').click();
    await p.locator('[name="to"]').waitFor();check('拆盘去向仅两值',(await p.locator('[name="to"] option').evaluateAll(els=>els.map(e=>e.value))).join(',')==='in_depot,faulty');await p.locator('[name="to"]').selectOption('faulty');
    response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_unmount'));await p.locator('#itlSubmit').click();r=await response;check('拆盘真实200',r.status()===200);check('拆盘peer仅宿主',Object.keys(r.request().postDataJSON().peer_versions).join(',')===String(b.id));
    check('拆出故障散盘清装载',(await get(spare.id)).status==='faulty'&&(await get(spare.id)).parent_asset_id===null&&(await get(spare.id)).slot_no===null);
    // #itlRefresh removed: wait for the page's own refresh requested after this write (it-ledger-refresh-wait.js),
    // not a forced refresh, so a missing post-write refresh fails instead of passing.
    await p.locator('#itlModal').waitFor({state:'hidden'});await settled();
    // A stale occupancy snapshot must not veto a valid server-side request.
    const staleDiskRoute=async route=>{const response=await route.fetch();const data=await response.json();data.items.push({id:999999,category:'disk',status:'in_service',parent_asset_id:b.id,slot_no:1});await route.fulfill({response,json:data});await p.unroute(f.base+'/api/it-assets',staleDiskRoute);};
    await p.route(f.base+'/api/it-assets',staleDiskRoute);
    await p.locator('[data-disk-slot="1"]').click();await p.locator('[data-disk-op="disk_mount"]').click();await p.locator('[name="new_disk_id"]').selectOption(String(loose.id));
    check('盘位旧快照占用提示保留',(await p.locator('#itlDiskTargetHint').innerText()).includes('已占：1。提交时服务器再次校验。'));

    response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_mount'));await p.locator('#itlSubmit').click();r=await response;check('装盘真实200',r.status()===200);check('装盘peer仅目标宿主',Object.keys(r.request().postDataJSON().peer_versions).join(',')===String(b.id));
    check('装盘落B槽1在用',(await get(loose.id)).parent_asset_id===b.id&&(await get(loose.id)).slot_no===1&&(await get(loose.id)).status==='in_service');await p.locator('#itlModal').waitFor({state:'hidden'});
    let currentDisk=loose;
    for(const to of ['faulty','in_depot']){
      const replacement=await create({category:'disk',name:'换盘去向'+to,placement:{kind:'depot'}});
      await p.locator('[data-disk-slot="1"]').click();await p.locator('[data-disk-op="disk_swap"]').click();await p.locator('[name="new_disk_id"]').selectOption(String(replacement.id));await p.locator('[name="to"]').selectOption(to);
      response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_swap'));await p.locator('#itlSubmit').click();r=await response;check('换盘旧盘去向'+to,r.status()===200&&(await get(currentDisk.id)).status===to&&(await get(replacement.id)).parent_asset_id===b.id);await p.locator('#itlModal').waitFor({state:'hidden'});currentDisk=replacement;
    }
    await p.locator('[data-disk-slot="1"]').click();await p.locator('[data-disk-op="disk_unmount"]').click();await p.locator('[name="to"]').waitFor();host=await get(b.id);check('制造宿主并发编辑200',(await f.api('PUT','/'+b.id,{expected_version:host.version,note:'并发编辑'})).status===200);const before=await snapshot();
    response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_unmount'));await p.locator('#itlSubmit').click();r=await response;check('旧宿主版本精确409',r.status()===409&&(await r.json()).code==='VERSION_CONFLICT');
    check('拒绝拆盘资产事件完整行相同',JSON.stringify(await snapshot())===JSON.stringify(before));check('冲突旧表单禁止重提',await p.locator('#itlSubmit').isDisabled());await p.locator('#itlModalCancel').click();await p.locator('#itlHardwareClose').click();
    // Replacement guide: interrupt after unmount, reload, select IDs again, continue from state.
    host=await get(a.id);const migrate=await create({category:'disk',name:'待迁移盘',placement:{kind:'host',parent_asset_id:a.id,slot_no:1},peer_versions:{[a.id]:host.version}});
    await p.locator('[data-select-rack-asset="'+a.id+'"]').click();await p.locator('[data-rack-command="replace"]').click();await p.locator('[name="wizard_new"]').selectOption(String(c.id));check('向导首先提示旧机下架',(await p.locator('.itl-wizard-next').innerText()).includes('下一步：旧机下架'));
    await p.locator('[data-hardware-command="wizard-out"]').click();response=p.waitForResponse(r=>r.url().endsWith('/actions/rack_out'));await p.locator('#itlSubmit').click();check('向导旧机下架200',(await response).status()===200);await p.locator('.itl-wizard-next').filter({hasText:'逐盘拆出'}).waitFor();
    await p.locator('[data-wizard-disks="'+a.id+'"]').click();await p.locator('[data-disk-slot="1"]').click();check('库房宿主仅拆盘',await p.locator('[data-disk-op]').count()===1&&await p.locator('[data-disk-op="disk_unmount"]').count()===1);
    await p.locator('[data-disk-op="disk_unmount"]').click();response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_unmount'));await p.locator('#itlSubmit').click();check('库房拆到可用200',(await response).status()===200);await p.locator('#itlModal').waitFor({state:'hidden'});await p.locator('#itlHardwareClose').click();await p.locator('.itl-wizard-next').filter({hasText:'新机上架选位'}).waitFor();
    check('逐步真实状态决定下一步',(await get(a.id)).status==='in_depot'&&(await get(migrate.id)).parent_asset_id===null);
    await p.goto(f.base+'/IT_Ledger.html#depot');await p.reload();const oldCard=p.locator('.itl-card').filter({has:p.getByRole('button',{name:'旧机A',exact:true})});await oldCard.locator('.itl-menu summary').click();await oldCard.locator('[data-action="replace_machine"]').click();await p.locator('[name="wizard_new"]').waitFor();check('刷新未持久化向导选择',await p.locator('[name="wizard_new"]').inputValue()==='');await p.locator('[name="wizard_new"]').selectOption(String(c.id));check('重新选机恢复下一步',(await p.locator('.itl-wizard-next').innerText()).includes('新机上架选位'));
    await p.locator('[data-hardware-command="wizard-rack-in"]').click();await p.locator('[data-u="1"].itl-can-place').waitFor();response=p.waitForResponse(r=>r.url().endsWith('/actions/rack_in'));await p.locator('[data-u="1"]').click();check('向导复用C8选位上架200',(await response).status()===200);await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();await p.locator('[data-rack-command="resume_replace"]').click();await p.locator('.itl-wizard-next').filter({hasText:'逐盘装入新机'}).waitFor();
    await p.locator('[data-wizard-disks="'+c.id+'"]').click();await p.locator('[data-disk-slot="1"]').click();await p.locator('[data-disk-op="disk_mount"]').click();await p.locator('[name="new_disk_id"]').selectOption(String(migrate.id));response=p.waitForResponse(r=>r.url().endsWith('/actions/disk_mount'));await p.locator('#itlSubmit').click();check('向导装入新机200',(await response).status()===200);await p.locator('#itlModal').waitFor({state:'hidden'});check('迁移终态旧机空新机带盘',(await get(a.id)).status==='in_depot'&&(await get(c.id)).status==='in_service'&&(await get(migrate.id)).parent_asset_id===c.id);
    await p.setViewportSize({width:900,height:540});const box=await p.locator('#itlHardwareClose').boundingBox();check('540px盘位返回可达',box&&box.y>=0&&box.y+box.height<=540);await p.screenshot({path:path.join(f.dir,'c9-low.png'),fullPage:true});
    const readContext=await browser.newContext();await readContext.addInitScript(()=>localStorage.setItem('token','fixture-3'));const read=await readContext.newPage();await read.goto(f.base+'/IT_Ledger.html#all');await read.locator('[data-detail="'+c.id+'"]').click();await read.getByRole('button',{name:'打开盘位',exact:true}).click();await read.locator('[data-disk-slot="1"]').click();check('只读可查盘位而无写入口',await read.locator('.itl-disk-slot').count()===4&&await read.locator('[data-disk-op]').count()===0);await readContext.close();
    const huge=await create({category:'server',name:'百万盘位测试',u_height:1,slot_count:1000000,placement:{kind:'depot'}});
    await p.goto(f.base+'/IT_Ledger.html#all');await p.reload();await p.locator('[data-detail="'+huge.id+'"]').click();await p.getByRole('button',{name:'打开盘位',exact:true}).click();await p.locator('#itlDiskJump').waitFor();
    check('大容量只渲染48格',await p.locator('.itl-disk-slot').count()===48);await p.locator('#itlDiskJump').fill('1000000');await p.locator('[data-hardware-command="jump"]').click();check('最后合法盘位可达',await p.locator('[data-disk-slot="1000000"]').count()===1&&await p.locator('.itl-disk-slot').count()===1);
    check('库房宿主空位不显示装盘',await p.locator('[data-disk-op="disk_mount"]').count()===0);
    await p.evaluate(id=>{ITLedger.state.assets=ITLedger.state.assets.filter(a=>a.id!==id);document.querySelector('[data-hardware-command="jump"]').click();},huge.id);
    check('盘位跳转目标消失中文提示并关闭',!(await p.locator('#itlHardwareOverlay').isVisible())&&(await p.locator('#itlNotice').innerText()).includes('宿主已不存在或已无盘位'));
    await p.evaluate(id=>ITLedger.openDisks(id),huge.id);await p.locator('[data-disk-page="next"]').waitFor();
    await p.evaluate(id=>{ITLedger.state.assets=ITLedger.state.assets.filter(a=>a.id!==id);document.querySelector('[data-disk-page="next"]').click();},huge.id);
    check('盘位翻页目标消失中文提示并关闭',!(await p.locator('#itlHardwareOverlay').isVisible())&&(await p.locator('#itlNotice').innerText()).includes('宿主已不存在或已无盘位'));
    check('浏览器无未捕获异常',errors.length===0||(console.log(errors),false));fs.writeFileSync(path.join(f.dir,'c9-result.json'),JSON.stringify({pass,fail:0,results,errors},null,2));console.log(`C9_BROWSER PASS=${pass} FAIL=0`);
  }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);console.error(`C9_BROWSER PASS=${pass} FAIL=1`);process.exitCode=1;});
