'use strict';
const assert=require('assert/strict');
const {chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser;let pass=0;
 const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);pass++;console.log('[OK] '+name);};
 try{
  const rack=(await f.api('POST','/racks',{name:'债清理机柜',u_total:240})).body;
  const spare=(await f.api('POST','',{category:'server',name:'债清理备机',u_height:2,slot_count:4,placement:{kind:'depot'}})).body;
  const disk=(await f.api('POST','',{category:'disk',name:'债清理散盘',placement:{kind:'depot'}})).body;
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  await context.addInitScript(()=>{if(!localStorage.getItem('token'))localStorage.setItem('token','fixture-1');});
  const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(f.base+'/IT_Ledger.html#racks');await p.locator('.itl-rack-title').click();
  await p.locator('[data-u="240"]').click();await p.locator('[name="asset_id"]').selectOption(String(spare.id));await p.locator('#itlSubmit').click();
  await p.waitForFunction(()=>document.querySelector('[data-rack-command="cancel"]')||document.querySelector('#itlFormError').textContent,{},{timeout:5000});
  check('[B1] 无客户端快照阻断',await p.locator('[data-rack-command="cancel"]').count(),1);
  check('[B1] 快照放不下仍进入选位',await p.locator('#itlRackMessage').textContent(),'当前快照显示这个位置放不下整段设备；提交时服务器再次校验。');
  const response=p.waitForResponse(r=>r.url().endsWith('/actions/rack_in'));
  await p.locator('[data-u="230"]').click();check('[B1] 由服务器确认新选位',(await response).status(),200);
  await p.locator('#itlRackMessage').filter({hasText:'位置已保存'}).waitFor();
  check('[B6] 机柜几何计算样式',await p.evaluate(id=>({row:getComputedStyle(document.querySelector('.itl-u-row')).height,cell:getComputedStyle(document.querySelector('.itl-u-cell')).height,left:getComputedStyle(document.querySelector('[data-select-rack-asset="'+id+'"]')).left,height:getComputedStyle(document.querySelector('[data-select-rack-asset="'+id+'"]')).height}),spare.id),{row:'28px',cell:'27px',left:'48px',height:'54px'});
  await p.evaluate(()=>{const refresh=ITLedger.refresh;window.debtRefreshes=0;ITLedger.refresh=(...args)=>{window.debtRefreshes++;return refresh(...args);};ITLedger.state.racks=[];document.querySelector('[data-window="down"]').click();});
  check('[B2] 翻页时机柜消失主动刷新',await p.evaluate(()=>window.debtRefreshes),1);
  check('[B2] 翻页时机柜消失关闭浮层',await p.locator('#itlRackOverlay').isVisible(),false);
  await p.evaluate(id=>ITLedger.openRack(id),rack.id);await p.locator('[data-u="240"]').waitFor();
  await p.evaluate(()=>{window.debtRefreshes=0;ITLedger.state.racks=[];document.querySelector('[data-u="240"]').click();});
  check('[B2] 选库房时机柜消失主动刷新',await p.evaluate(()=>window.debtRefreshes),1);
  check('[B2] 选择库房设备前机柜消失关闭浮层',await p.locator('#itlRackOverlay').isVisible(),false);
  const second=(await f.api('POST','',{category:'server',name:'过期弹窗备机',u_height:1,placement:{kind:'depot'}})).body;
  await p.evaluate(id=>ITLedger.openRack(id),rack.id);await p.locator('[data-u="240"]').click();
  await p.locator('[name="asset_id"]').selectOption(String(second.id));
  await p.evaluate(()=>{window.debtRefreshes=0;ITLedger.state.racks=[];});await p.locator('#itlSubmit').click();
  check('[B2] 弹窗提交时机柜消失主动刷新',await p.evaluate(()=>window.debtRefreshes),1);
  check('[B2] 过期选位弹窗关闭',await p.locator('#itlModal').isVisible(),false);
  await p.evaluate(id=>ITLedger.openDisks(id),spare.id);await p.locator('[data-disk-slot="4"]').click();
  const routePattern='**/api/it-assets';
  await p.route(routePattern,async route=>{
   const response=await route.fetch(),body=await response.json();
   body.items=body.items.map(a=>a.id===spare.id?{...a,slot_count:1}:a);
   await route.fulfill({response,json:body});
  });
  await p.locator('[data-disk-op="disk_mount"]').click();await p.locator('[name="new_disk_id"]').selectOption(String(disk.id));
  await p.unroute(routePattern);
  let mounted=null;p.on('response',r=>{if(r.url().endsWith('/actions/disk_mount'))mounted=r;});
  await p.locator('#itlSubmit').click();
  await p.waitForFunction(()=>!document.querySelector('#itlModal').classList.contains('open')||document.querySelector('#itlFormError').textContent,{},{timeout:5000});
  check('[B1] 旧盘位容量快照不阻止真实请求',mounted?.status(),200);
  await p.locator('#itlModal').waitFor({state:'hidden'});
  check('[B1] 实际落库盘位',(await f.api('GET','/'+disk.id)).body.asset.slot_no,4);
  const accessSnapshot=()=>p.evaluate(()=>({level:ITLedger.state.level,text:document.querySelector('#itlAccess').textContent,register:getComputedStyle(document.querySelector('#itlRegister')).display,tabs:getComputedStyle(document.querySelector('#itlTabs')).display}));
  const emptyAccess={level:null,text:'尚未获准访问',register:'none',tabs:'none'};
  for(const mode of ['refresh-token','storage']) {
    await p.evaluate(()=>localStorage.setItem('token','fixture-2'));await p.reload();
    await p.waitForFunction(()=>ITLedger.state.level==='write'&&document.querySelector('#itlAccess').textContent.includes('可登记与维护'));
    let release,arrive;const arrived=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
    await p.route('**/api/it-assets/me',async route=>{arrive();await gate;await route.continue();});
    try {
      await p.evaluate(mode=>{localStorage.setItem('token','fixture-3');if(mode==='storage')window.dispatchEvent(new StorageEvent('storage',{key:'token'}));else window.debtRefresh=ITLedger.refresh();},mode);
      await Promise.race([arrived,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('permission request timeout')),5000);t.unref();})]);
      check('[B5] '+mode+' 换号立即清空权限UI',await accessSnapshot(),emptyAccess);
    }finally{release();}
    await p.waitForFunction(()=>ITLedger.state.level==='read'&&!document.querySelector('#itlContent').hasAttribute('aria-busy'));
    await p.unroute('**/api/it-assets/me');
  }
  await p.route('**/api/it-assets/debt-forbidden',route=>route.fulfill({status:403,json:{code:'NO_ACCESS'}}));
  await p.evaluate(()=>ITLedger.api('/debt-forbidden').catch(()=>{}));
  check('[B5] 403清空权限UI',await accessSnapshot(),emptyAccess);
  await p.unroute('**/api/it-assets/debt-forbidden');
  await p.route('**/api/it-assets/me',route=>route.fulfill({status:200,json:{level:null}}));
  await p.evaluate(()=>ITLedger.refresh());check('[B5] 非授权响应清空权限UI',await accessSnapshot(),emptyAccess);
  await p.unroute('**/api/it-assets/me');
  await p.evaluate(()=>localStorage.setItem('token','fixture-2'));await p.reload();
  await p.waitForFunction(()=>ITLedger.state.level==='write'&&!document.querySelector('#itlContent').hasAttribute('aria-busy'));
  const diagnostics=[];p.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
  await p.evaluate(async()=>{delete ITLedger.state.views.racks;ITLedger.state.tab='racks';await ITLedger.refresh();});
  check('[B7] 加载失败文案',await p.locator('#itlContent').textContent(),'该视图加载失败，请刷新页面');
  check('[B7] 加载失败诊断',diagnostics,['[ITLedger] view failed to load: racks']);
  check('[B2] 浏览器无异常',errors,[]);
  console.log('DEBT_BROWSER PASS='+pass+' FAIL=0');
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
