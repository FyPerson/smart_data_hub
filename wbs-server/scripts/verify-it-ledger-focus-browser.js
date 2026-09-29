'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
  const f=await createFixture();let browser;const results=[];
  try{
    const created=await f.api('POST','',{category:'server',name:'原始名称',u_height:1,placement:{kind:'depot'}});assert.equal(created.status,201);
    const source=fs.readFileSync(path.join(__dirname,'../public/assets/js/it-ledger.js'),'utf8');
    const fixed="    ($('#itlModalBody input:not([disabled]),#itlModalBody select:not([disabled])') || $('#itlModalClose')).focus();";
    assert.equal(source.split(fixed).length,2);
    const mutant=source.replace(fixed,"    requestAnimationFrame(() => ($('#itlModalBody input:not([disabled]),#itlModalBody select:not([disabled])') || $('#itlModalClose')).focus());");
    browser=await chromium.launch({headless:true});
    for(const [name,script,expected] of [['fixed',source,{name:'原始名称',height:'5'}],['old-delayed-focus',mutant,{name:'5原始名称',height:'1'}]]){
      const c=await browser.newContext();await c.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await c.newPage();
      await p.route('**/assets/js/it-ledger.js?*',r=>r.fulfill({status:200,contentType:'application/javascript',body:script}));
      await p.goto(f.base+'/IT_Ledger.html#all');await p.locator('#itlTable [data-action="edit"]').waitFor();
      // Controlled animation-frame gate reproduces input arriving before old autofocus.
      await p.evaluate(()=>{window.__frames=[];window.requestAnimationFrame=callback=>{window.__frames.push(callback);return window.__frames.length;};});
      await p.locator('#itlTable [data-action="edit"]').click();await p.locator('[name="u_height"]').waitFor();
      await p.locator('[name="u_height"]').focus();await p.keyboard.press('Control+A');
      await p.evaluate(()=>{for(const callback of window.__frames.splice(0))callback(performance.now());});
      await p.keyboard.insertText('5');
      const actual={name:await p.locator('[name="name"]').inputValue(),height:await p.locator('[name="u_height"]').inputValue()};
      assert.deepEqual(actual,expected,name);results.push({name,actual});console.log('[OK] '+name+' '+JSON.stringify(actual));await c.close();
    }
    const rows=await f.all('SELECT name,u_height FROM it_assets');assert.deepEqual(rows,[{name:'原始名称',u_height:1}]);console.log('[OK] 测试不提交修改，真实数据库保持原值');
    fs.writeFileSync(path.join(f.dir,'focus-result.json'),JSON.stringify({results,unchanged:rows},null,2));console.log('FOCUS_BROWSER PASS=3 FAIL=0 ARTIFACTS='+f.dir);
  }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
