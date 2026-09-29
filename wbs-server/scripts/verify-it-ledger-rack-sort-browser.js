'use strict';
const assert=require('assert/strict'),{chromium}=require('playwright');const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser,pass=0;console.log('ISOLATED_ARTIFACTS='+f.dir);
 const check=(name,ok)=>{assert.ok(ok,name);pass++;console.log('[OK] '+name);};
 try{
  const order=2**53,r=await f.api('POST','/racks',{name:'整数排序边界',u_total:42,sort_order:order});check('后端接受非安全但合法整数排序',r.status===201&&r.body.sort_order===order);
  browser=await chromium.launch({headless:true});const c=await browser.newContext();await c.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await c.newPage();await p.goto(f.base+'/IT_Ledger.html#racks');await p.locator('[data-manage-rack="'+r.body.id+'"]').click();await p.locator('[name="sort_order"]').fill(String(-order));await p.locator('#itlSubmit').click();
  await p.waitForFunction(()=>!document.querySelector('#itlModal').classList.contains('open')||document.querySelector('#itlFormError').textContent.length>0,undefined,{timeout:10000});
  check('前端合法整数排序保存成功',!await p.locator('#itlModal').isVisible());
  const row=(await f.api('GET','/racks')).body.items.find(x=>x.id===r.body.id);check('实际落库排序精确',row.sort_order===-order);
  console.log(`RACK_SORT_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
