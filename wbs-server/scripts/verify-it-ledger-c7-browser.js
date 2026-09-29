'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright');
const {createFixture} = require('./it-ledger-browser-fixture');
let pass=0;
function check(name,condition) { assert.ok(condition,name); console.log('[OK] '+name); pass++; }
async function main() {
  const fixture = await createFixture();
  console.log('ISOLATED_ARTIFACTS='+fixture.dir);
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:1366,height:768}});
    await context.addInitScript(() => localStorage.setItem('token','fixture-1'));
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',e => errors.push(e.message));
    await page.goto(fixture.base+'/IT_Ledger.html');
    await page.locator('#itlRegister').waitFor({state:'visible'});
    check('九个分层视图入口',await page.locator('#itlTabs [data-tab]').count() === 9);
    check('首次进入默认全部资产',await page.locator('#itlTable').isVisible()&&await page.locator('[data-tab="all"]').getAttribute('aria-current')==='page');await page.locator('[data-tab="depot"]').click();
    check('空库三栏',await page.locator('.itl-lane .itl-empty').count() === 3);
    await page.locator('[data-it-ledger-entry]').waitFor({state:'attached'});
    check('admin全局入口依/me出现',await page.locator('[data-it-ledger-entry]').count() === 1);
    await page.locator('#itlRegister').click();
    await page.locator('#itlForm [name="name"]').waitFor();
    await page.locator('#itlSubmit').click();
    check('必填错误在名称旁',await page.locator('#itlField-name-error').innerText() === '请填写资产名称。');
    const assetName='<img src=x onerror="window.__xss=1">主机';
    await page.locator('[name="name"]').fill(assetName);
    await page.locator('[name="sn"]').fill(' c7-sn ');
    await page.locator('[name="slot_count"]').fill('4');
    await page.locator('[name="fin_amount"]').fill('12345');
    await page.locator('[name="attrs.ip"]').fill('192.0.2.10');
    const created=page.waitForResponse(r => r.url().endsWith('/api/it-assets') && r.request().method()==='POST');
    await page.locator('#itlSubmit').click();
    check('真实登记201',(await created).status() === 201);
    await page.locator('#itlDrawerBody .itl-kv').first().waitFor();
    let assets=(await fixture.api('GET','')).body.items;
    const host=assets.find(a => a.sn === 'C7-SN');
    check('落库规范化与位置',host?.name === assetName && host.status === 'in_depot' && host.slot_count === 4 && host.attrs.ip === '192.0.2.10');
    check('admin详情可见真实财务值',(await page.locator('#itlDrawerBody').innerText()).includes('12345'));
    check('名称无HTML执行',await page.evaluate(() => !window.__xss && document.querySelectorAll('#itlDrawer img').length === 0));
    check('登记时间线有中文动作',(await page.locator('.itl-timeline').innerText()).includes('登记'));
    await page.locator('#itlDrawerClose').click();
    const disk=await fixture.api('POST','',{category:'disk',name:'随装测试盘',sn:'C7-DISK',placement:{kind:'host',parent_asset_id:host.id,slot_no:1},peer_versions:{[host.id]:host.version}});
    check('真实宿主装盘登记201',disk.status === 201);
    // #itlRefresh removed: reload replaces the manual click. Drawer is already closed and the depot tab
    // survives via the workspace context captured on pagehide, so no state needs preserving here.
    await page.reload();
    await page.getByText('随机 1 盘',{exact:true}).waitFor();
    check('随装盘不重复为主卡',await page.locator('.itl-card').count() === 1);
    await page.getByText('随机 1 盘',{exact:true}).click();
    check('随装盘展开可查',await page.getByRole('button',{name:'随装测试盘',exact:true}).isVisible());
    await page.locator('[data-tab="all"]').click();
    await page.locator('#itlSearch').fill('C7-SN');
    check('全部列表全量搜索',await page.locator('#itlTable tbody tr').count() === 1 && (await page.locator('#itlTable tbody').innerText()).includes('C7-SN'));
    await page.locator('#itlTable [data-action="edit"]').click();
    await page.locator('#itlForm [name="name"]').waitFor();
    const latest=(await fixture.api('GET','/'+host.id)).body.asset;
    check('制造并发编辑200',(await fixture.api('PUT','/'+host.id,{expected_version:latest.version,note:'其他人已更新'})).status === 200);
    const conflictAssets=await fixture.all('SELECT * FROM it_assets ORDER BY id'),conflictEvents=await fixture.all('SELECT * FROM it_asset_events ORDER BY id');
    await page.locator('[name="name"]').fill('不可覆盖并发');
    const conflict=page.waitForResponse(r => r.url().endsWith('/api/it-assets/'+host.id) && r.request().method()==='PUT');
    await page.locator('#itlSubmit').click();
    check('陈旧版本真实409',(await conflict).status() === 409);
    await page.getByText(/资料已被其他操作更新/).first().waitFor();
    check('冲突锁定旧表单不重提',await page.locator('#itlSubmit').isDisabled());
    check('冲突拒写保留并发内容',(await fixture.api('GET','/'+host.id)).body.asset.note === '其他人已更新');
    check('版本冲突资产完整行不变',JSON.stringify(await fixture.all('SELECT * FROM it_assets ORDER BY id'))===JSON.stringify(conflictAssets));
    check('版本冲突事件完整行不变',JSON.stringify(await fixture.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(conflictEvents));
    await page.locator('#itlModalCancel').click();
    await page.locator('#itlRegister').click();
    await page.locator('[name="name"]').fill('重复序列号');
    await page.locator('[name="sn"]').fill('C7-SN');
    const duplicateAssets=await fixture.all('SELECT * FROM it_assets ORDER BY id'),duplicateEvents=await fixture.all('SELECT * FROM it_asset_events ORDER BY id');
    await page.locator('#itlSubmit').click();
    await page.locator('#itlFormError').filter({hasText:/序列|SN|sn/}).waitFor();
    check('重复SN拒绝后没有新行',(await fixture.api('GET','')).body.items.length === 2);
    check('重复SN资产完整行不变',JSON.stringify(await fixture.all('SELECT * FROM it_assets ORDER BY id'))===JSON.stringify(duplicateAssets));
    check('重复SN事件完整行不变',JSON.stringify(await fixture.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(duplicateEvents));
    await page.setViewportSize({width:900,height:540});
    const bounds=await page.locator('#itlSubmit').boundingBox();
    check('矮视口保存按钮可达',bounds && bounds.y>=0 && bounds.y+bounds.height<=540);
    await page.screenshot({path:path.join(fixture.dir,'c7-low-viewport.png'),fullPage:true});
    await page.locator('#itlModalCancel').click();
    // Exercise all six placement payloads through the real form, not synthetic requests.
    const floor=await fixture.api('PUT','/floors/C7-F',{name:'测试楼层',rooms:[{id:'R1',name:'测试房间',w:100,h:100}]});
    check('测试楼层真实建成',floor.status === 200);
    const rackResult=await fixture.api('POST','/racks',{name:'C7-A',u_total:42});
    check('测试机柜真实建成',rackResult.status===201);
    const rack=rackResult.body;
    const placements=[
      {category:'server',kind:'rack',values:{'placement.rack_id':String(rack.id),'placement.u_start':'5'},check:a=>a.rack_id===rack.id&&a.u_start===5},
      {category:'disk',kind:'host',values:{'placement.parent_asset_id':String(host.id),'placement.slot_no':'2'},check:a=>a.parent_asset_id===host.id&&a.slot_no===2},
      {category:'laptop',kind:'custodian',values:{'placement.custodian_name':'张三','placement.location_text':'201'},check:a=>a.custodian_name==='张三'&&a.location_text==='201'},
      {category:'other',kind:'place',values:{'placement.location_text':'档案室'},check:a=>a.location_text==='档案室'&&a.u_height===0},
      // AP 登记落库房：三个房间位置列必须留空，坐标只能由 AP 平面上的 ap_place 写入。
      {category:'ap',kind:'depot',values:{'placement.status':'in_depot'},check:a=>a.status==='in_depot'&&a.floor_id===null&&a.room_id===null&&a.pos===null},
      {category:'desktop',kind:'depot',values:{'placement.status':'faulty'},check:a=>a.status==='faulty'&&a.custodian_name===null},
      {category:'software',values:{},check:a=>a.status==='active'&&a.expires_at===null},
      {category:'subscription',values:{expires_at:'2026-10-01'},check:a=>a.status==='active'&&a.expires_at==='2026-10-01'}
    ];
    for(const scenario of placements) {
      if(await page.locator('#itlDrawer').evaluate(el=>el.classList.contains('open'))) await page.locator('#itlDrawerClose').click();
      await page.locator('#itlRegister').click();
      await page.locator('[name="category"]').selectOption(scenario.category);
      await page.locator('[name="name"]').fill('C7-'+scenario.category);
      if(scenario.kind) await page.locator('[name="placement.kind"]').selectOption(scenario.kind);
      for(const [key,value] of Object.entries(scenario.values)) {
        const control=page.locator(`[name="${key}"]`);
        if(await control.evaluate(el=>el.tagName==='SELECT')) await control.selectOption(value); else await control.fill(value);
      }
      const posted=page.waitForResponse(r=>r.url().endsWith('/api/it-assets')&&r.request().method()==='POST');
      await page.locator('#itlSubmit').click(); const response=await posted;
      const saved=await response.json(); check(scenario.category+' 表单真实登记/位置闭环',response.status()===201&&scenario.check(saved));
      await page.locator('#itlModal').waitFor({state:'hidden'});
      if(scenario.category==='ap') { await page.locator('[data-tab="aps"][aria-current="page"]').waitFor(); check('AP登记跳到平面',await page.locator('[data-tab="aps"]').getAttribute('aria-current')==='page'); }
      else await page.locator('#itlDrawerBody .itl-kv').first().waitFor();
    }
    // Verify the same form does not stringify unchanged existing attrs values.
    const sw=(await fixture.api('GET','')).body.items.find(a=>a.name==='C7-software');
    await fixture.api('PUT','/'+sw.id,{expected_version:sw.version,attrs:{license_count:4,installed_on:['测试终端']}});
    await page.locator('#itlDrawerClose').click();
    // Negative lock: the registration form must offer AP no placement kind but depot.
    //   Re-adding 'room' here would silently restore synthetic room-centre coordinates.
    await page.locator('#itlRegister').click();
    await page.locator('[name="category"]').selectOption('ap');
    const apKinds=await page.locator('[name="placement.kind"] option').evaluateAll(list=>list.map(option=>option.value));
    check('AP 登记位置方式恰为库房一项',JSON.stringify(apKinds)==='["depot"]');
    check('AP 登记表单不含楼层与房间控件',await page.locator('[name="placement.floor_id"]').count()===0&&await page.locator('[name="placement.room_id"]').count()===0);
    await page.locator('#itlModalClose').click();
    await page.locator('#itlModal').waitFor({state:'hidden'});
    await page.locator('[data-tab="all"]').click(); await page.locator('#itlSearch').fill('C7-software');
    await page.locator('#itlTable [data-action="edit"]').click(); await page.locator('[name="name"]').waitFor();
    check('软件编辑不提交到期字段',await page.locator('[name="expires_at"]').count()===0);
    await page.locator('[name="note"]').fill('保留属性类型');
    const edited=page.waitForResponse(r=>r.url().endsWith('/api/it-assets/'+sw.id)&&r.request().method()==='PUT');
    await page.locator('#itlSubmit').click(); check('正常编辑真实200',(await edited).status()===200);
    const swAfter=(await fixture.api('GET','/'+sw.id)).body.asset;
    check('未修改attrs保留数字与数组类型',swAfter.attrs.license_count===4&&Array.isArray(swAfter.attrs.installed_on)&&swAfter.note==='保留属性类型');
    // Hold the first real detail response, then release after another detail is displayed.
    let releaseDetail, detailArrived;
    const heldDetail=new Promise(resolve=>{releaseDetail=resolve;});
    const arrivedDetail=new Promise(resolve=>{detailArrived=resolve;});
    await page.route('**/api/it-assets/'+host.id,async route=>{const response=await route.fetch();detailArrived();await heldDetail;await route.fulfill({response});});
    await page.evaluate(id=>{window.__oldDetail=ITLedger.detail(id);},host.id); await arrivedDetail;
    await page.evaluate(id=>ITLedger.detail(id),sw.id);
    releaseDetail(); await page.evaluate(()=>window.__oldDetail); await page.unroute('**/api/it-assets/'+host.id);
    check('晚到的旧详情不得覆盖新详情',await page.locator('#itlDrawerTitle').innerText()==='C7-software');
    // Two simultaneous permission refreshes must produce only the newest menu entry.
    let releaseMenu, menuArrived;
    const heldMenu=new Promise(resolve=>{releaseMenu=resolve;});
    const arrivedMenu=new Promise(resolve=>{menuArrived=resolve;});
    let meRequests=0;
    await page.route('**/api/it-assets/me',async route=>{const response=await route.fetch();if(++meRequests===1){menuArrived();await heldMenu;}await route.fulfill({response});});
    await page.evaluate(()=>{window.__oldMenuRefresh=refreshITLedgerEntry(document.getElementById('userProfileArea'));}); await arrivedMenu;
    await page.evaluate(()=>refreshITLedgerEntry(document.getElementById('userProfileArea')));
    releaseMenu(); await page.evaluate(()=>window.__oldMenuRefresh);
    await page.unroute('**/api/it-assets/me');
    check('并发菜单刷新只保留一个最新入口',await page.locator('[data-it-ledger-entry]').count()===1);
    await page.locator('#itlDrawerClose').click(); await page.locator('[data-tab="depot"]').click();
    const desktop=(await fixture.api('GET','')).body.items.find(a=>a.name==='C7-desktop');
    const card=page.locator('.itl-card').filter({has:page.getByRole('button',{name:'C7-desktop',exact:true})});
    await card.locator('.itl-menu summary').click(); await card.locator('[data-action="mark_status"]').click();
    await page.locator('[name="status"]').selectOption('to_retire');
    const marked=page.waitForResponse(r=>r.url().endsWith('/actions/mark_status'));
    await page.locator('#itlSubmit').click(); check('库房改栏真实200',(await marked).status()===200);
    await page.locator('#itlModal').waitFor({state:'hidden'});
    await page.locator('.itl-lane').filter({hasText:'待报废'}).locator('.itl-card').filter({hasText:'C7-desktop'}).waitFor();
    check('改栏版本只加一次',(await fixture.api('GET','/'+desktop.id)).body.asset.version===desktop.version+1);
    await card.locator('.itl-menu summary').click(); await card.locator('[data-action="retire"]').click();
    const retired=page.waitForResponse(r=>r.url().endsWith('/actions/retire'));
    await page.locator('#itlSubmit').click(); check('报废真实200',(await retired).status()===200);
    await card.waitFor({state:'detached'});
    const retiredDetail=(await fixture.api('GET','/'+desktop.id)).body;
    check('报废不删档且保留完整时间线',retiredDetail.asset.status==='retired'&&retiredDetail.asset.version===desktop.version+2&&retiredDetail.events.map(e=>e.action).join(',')==='register,mark_status,retire');
    // Real roles; fresh contexts avoid previous admin data retained in DOM/storage.
    for (const uid of [2,3,4]) {
      const ctx=await browser.newContext(); await ctx.addInitScript(uid => localStorage.setItem('token','fixture-'+uid),uid);
      const p=await ctx.newPage(); p.on('pageerror',e => errors.push(e.message));
      await p.goto(fixture.base+'/IT_Ledger.html#all');
      await p.locator('#itlAccess').filter({hasText:uid===4 ? '尚未获准访问' : uid===2 ? '可登记' : '只读'}).waitFor();
      check('role '+uid+' 登记按钮权限',await p.locator('#itlRegister').isVisible() === (uid===2));
      if (uid!==4) {
        await p.locator('[data-detail="'+host.id+'"]').click();
        await p.locator('#itlDrawerBody .itl-kv').first().waitFor();
        const txt=await p.locator('#itlDrawerBody').innerText();
        check('role '+uid+' 财务隔离且资产存在',txt.includes('C7-SN') && !txt.includes('12345') && !txt.includes('购置金额'));
        if (uid===2) {
          await p.locator('#itlDrawerBody [data-action="edit"]').click(); await p.locator('[name="name"]').waitFor(); check('write编辑无财务字段',await p.locator('[name^="fin_"]').count() === 0);
          const before=await fixture.all('SELECT * FROM it_assets ORDER BY id');
          const eventsBefore=await fixture.all('SELECT * FROM it_asset_events ORDER BY id');
          await fixture.run('DELETE FROM it_asset_acl WHERE user_id=2');
          await p.locator('[name="name"]').fill('撤权后禁止写入');
          const rejected=p.waitForResponse(r=>r.url().endsWith('/api/it-assets/'+host.id)&&r.request().method()==='PUT');
          await p.locator('#itlSubmit').click(); check('打开表单后撤权真实403',(await rejected).status()===403);
          await p.locator('#itlModal').waitFor({state:'hidden'});
          check('403同步清除旧权限文案',await p.locator('#itlAccess').innerText()==='尚未获准访问');
          check('撤权清空页面与抽屉数据',await p.locator('#itlContent').innerText()===''&&await p.locator('#itlDrawerBody').innerText()==='');
          check('撤权失败资产完整行无变更',JSON.stringify(await fixture.all('SELECT * FROM it_assets ORDER BY id'))===JSON.stringify(before));
          check('撤权失败事件完整行无变更',JSON.stringify(await fixture.all('SELECT * FROM it_asset_events ORDER BY id'))===JSON.stringify(eventsBefore));
          await fixture.run("INSERT INTO it_asset_acl(user_id,level,granted_by) VALUES(2,'write',1)");
        }
      } else check('无ACL不渲染资产',!(await p.locator('#itlContent').innerText()).includes('C7-SN'));
      const workspaceMe=p.waitForResponse(r => r.url().endsWith('/api/it-assets/me'));
      await p.goto(fixture.base+'/My_Workspace.html');
      await p.locator('#welcomeText').filter({hasText:'欢迎回来'}).waitFor();
      await workspaceMe;
      if(uid===2) await p.locator('#itLedgerExpiryCard').waitFor({state:'visible'});
      check('role '+uid+' 工作台到期卡权限',await p.locator('#itLedgerExpiryCard').isVisible() === (uid===2));
      await ctx.close();
    }
    check('浏览器无未捕获异常',errors.length===0 || (console.log(errors),false));
    fs.writeFileSync(path.join(fixture.dir,'result.json'),JSON.stringify({pass,fail:0,errors},null,2));
    console.log(`C7_BROWSER PASS=${pass} FAIL=0`);
  } finally { if(browser) await browser.close(); await fixture.close(); }
}
main().catch(error => {console.error(error.stack); console.error(`C7_BROWSER PASS=${pass} FAIL=1`); process.exitCode=1;});
