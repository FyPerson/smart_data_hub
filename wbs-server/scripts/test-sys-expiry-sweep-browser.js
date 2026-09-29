'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright');
const start=require('./lib/sys-expiry-fixture');
(async()=>{
 const f=await start();let browser;let pass=0;const check=(name,ok)=>{assert.ok(ok,name);pass++;console.log('[OK] '+name);};
 const dir=process.env.SYS_EXPIRY_ARTIFACT_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'expiry-ui-'));fs.mkdirSync(dir,{recursive:true});
 try{
  const old=await f.seed();const now=(await f.get("SELECT datetime('now','localtime') AS n")).n;const active=await f.seed(now,['pending']);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('token','fixture-admin'));
  await page.goto(f.base+'/Sys_Iteration.html',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof META_OK!=='undefined'&&META_OK&&currentUser&&currentUser.id===1);
  const open=async id=>{await page.evaluate(id=>siOpenDrawer(id),id);await page.waitForFunction(id=>siDetail&&siDetail.issue.id===id,id);};
  await open(old);
  check('未扫描旧授权真实API标记过期',await page.evaluate(()=>siDetail.issue.fast_release_auth_expired===1));
  check('过期不显示红条',await page.evaluate(()=>siFastlaneAuthWindowHtml(siDetail.issue)===''));
  check('扫描前不伪造超时时间线',!(await page.locator('.si-timeline').innerText()).includes('授权超时收回'));
  const beforeStatus=(await f.get('SELECT status FROM sys_issues WHERE id=?',[old])).status;
  const result=await f.mod._internals.expirySweep.runNow();check('无需用户写动作直接扫描',result.expired===1);
  await open(old);
  const text=await page.locator('.si-timeline').innerText();
  check('真实时间线显示系统操作及超时事实',text.includes('授权超时收回')&&text.includes('系统')&&text.includes('执行人甲'));
  check('时间线不把已确认人列为未确认',!text.includes('未确认执行人：执行人甲、执行人乙'));
  check('扫描后主状态不变且执行人已清',(await f.get('SELECT status FROM sys_issues WHERE id=?',[old])).status===beforeStatus&&await page.evaluate(()=>siDetail.fast_release_executors.length===0));
  await page.locator('.si-timeline').screenshot({path:path.join(dir,'01-expired-timeline.png')});
  await open(active);
  check('进行中仍显示截止和剩余小时',await page.evaluate(()=>{const html=siFastlaneAuthWindowHtml(siDetail.issue);return html.includes('先行上线窗口截止')&&html.includes('剩余约');}));
  check('未过期不提前写超时事件',!(await page.locator('.si-timeline').innerText()).includes('授权超时收回'));
  await page.locator('.si-gate-hint').filter({hasText:'先行上线窗口截止'}).screenshot({path:path.join(dir,'02-active-window.png')});
  const mixed=await page.evaluate(()=>siFastlaneAuthWindowHtml({fast_release_auth_expired:1,fast_release_active_auth:1,fast_release_auth_deadline:'2030-01-02 08:00:00'}));
  check('矛盾投影不误显示有效窗口',mixed==='');
  check('页面无运行异常',errors.length===0);
  console.log('BROWSER_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.stop();}
})().catch(e=>{console.error(e);console.log('PASS=0 FAIL=1');process.exitCode=1;});
