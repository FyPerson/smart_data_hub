'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser,pass=0;console.log('ISOLATED_ARTIFACTS='+f.dir);
 function check(name,ok){assert.ok(ok,name);pass++;console.log('[OK] '+name);}
 try{
  const rack=await f.api('POST','/racks',{name:'矮视口',u_total:42});assert.equal(rack.status,201);
  const host=await f.api('POST','',{category:'server',name:'矮视口主机',u_height:2,slot_count:8,placement:{kind:'rack',rack_id:rack.body.id,u_start:1}});assert.equal(host.status,201);
  browser=await chromium.launch({headless:true});const c=await browser.newContext({viewport:{width:1100,height:600}});await c.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await c.newPage();
  await p.goto(f.base+'/IT_Ledger.html#racks');await p.locator('.itl-rack-title').click();await p.locator('[data-select-rack-asset="'+host.body.id+'"]').click();
  const reachable=async selector=>{const b=await p.locator(selector).boundingBox();return b&&b.x>=0&&b.y>=0&&b.x+b.width<=1100&&b.y+b.height<=600;};
  check('1100x600机柜关闭可达',await reachable('[data-rack-command="close"]'));
  check('1100x600机柜盘位入口可达',await reachable('[data-rack-command="disks"]'));
  await p.screenshot({path:path.join(f.dir,'c13-rack-1100x600.png')});
  await p.locator('[data-rack-command="disks"]').click();await p.locator('.itl-disk-grid').waitFor();
  check('1100x600盘位关闭可达',await reachable('#itlHardwareClose'));
  await p.locator('[data-disk-slot="1"]').click();check('1100x600空盘位可点击',await p.locator('[data-disk-op="disk_mount"]').isVisible());
  await p.screenshot({path:path.join(f.dir,'c13-disks-1100x600.png')});
  await p.locator('#itlHardwareClose').click();check('返回机柜仍可关闭',await reachable('[data-rack-command="close"]'));await p.locator('[data-rack-command="close"]').click();
  check('关闭后无遮挡',!await p.locator('#itlRackOverlay').isVisible());
  console.log(`C13_LOW_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
