'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createFixture } = require('./it-ledger-browser-fixture');
async function main() {
  const f = await createFixture({ cleanup: true }); let browser, pass = 0;
  const artifacts = path.resolve(__dirname, '../../_temp/plan-b-verification'); fs.mkdirSync(artifacts, { recursive: true });
  const check = (label, value) => { assert.ok(value, label); pass++; console.log('[OK] ' + label); };
  const api = async (method, url, body, status = 200, user = 1) => { const r = await f.api(method, url, body, user); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  try {
    const racks = [];
    for (const name of ['A01', 'A02']) racks.push(await api('POST', '/racks', { room: '示例机房', name, u_total: 42 }, 201));
    const host = await api('POST', '', { category: 'server', name: '业务应用服务器', u_height: 2, slot_count: 4, attrs: { ip: '192.0.2.1', purpose: '业务应用', os: 'Windows Server' }, placement: { kind: 'rack', rack_id: racks[0].id, u_start: 3 } }, 201);
    await api('POST', '', { category: 'server', name: '数据服务节点', u_height: 2, placement: { kind: 'rack', rack_id: racks[1].id, u_start: 5 } }, 201);
    for (const body of [{category:'laptop',name:'备用笔记本',placement:{kind:'depot'}},{category:'desktop',name:'研发终端',placement:{kind:'custodian',custodian_name:'测试人员',location_text:'办公区'}},{category:'software',name:'数据库授权'},{category:'subscription',name:'运维平台订阅',expires_at:'2027-09-29'}]) await api('POST', '', body, 201);
    await api('PUT', '/floors/F1', { name: '办公一层', rooms: [{ id: 'R1', name: '研发办公室', w: 100, h: 100 }] });
    await api('POST', '', { category:'ap',name:'办公室 AP',placement:{kind:'room',floor_id:'F1',room_id:'R1',pos:{x:.4,y:.5}} }, 201);
    const sheet = await api('POST', '/inspections/sheets', { room_name: '示例机房' }, 201, 2);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width:1440, height:1000 } });
    await context.addInitScript(() => localStorage.setItem('token', 'fixture-1'));
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    for (const tab of ['all','racks','depot','aps','terminals','software','stocktakes','reconciles','inspections']) {
      await page.goto(f.base + '/IT_Ledger.html#' + tab);
      await page.locator('[data-tab="' + tab + '"][aria-current=page]').waitFor();
      await page.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy') && !document.querySelector('#itlContent').textContent.includes('正在读取'));
      const styles = await page.evaluate(() => ({ selected: getComputedStyle(document.querySelector('[data-tab][aria-current]')).backgroundColor, width:document.documentElement.scrollWidth, header:document.querySelector('#itlViewTitle').textContent }));
      check(tab + ' 方案 B 选中态及桌面布局', styles.selected === 'rgb(223, 237, 226)' && styles.width === 1440);
      await page.screenshot({ path:path.join(artifacts, tab + '.png') });
      for (const width of [768,390]) {
        await page.setViewportSize({width,height:900});
        check(tab + ' 窄屏无页面横向溢出 ' + width, await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(width===390) await page.screenshot({path:path.join(artifacts,tab+'-mobile.png')});
      }
      await page.setViewportSize({width:1440,height:1000});
    }
    await page.goto(f.base + '/IT_Ledger.html#all'); await page.locator('#itlTable').waitFor();
    await page.locator('[data-detail="' + host.id + '"]').click(); await page.locator('#itlDrawer.open').waitFor();
    check('详情抽屉使用暖白底', await page.locator('#itlDrawerBody').evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(255, 254, 251)');
    await page.screenshot({path:path.join(artifacts,'asset-detail.png')}); await page.locator('#itlDrawerClose').click();
    await page.locator('#itlRegister').click(); await page.locator('#itlModal.open').waitFor();
    check('登记弹窗方案 B 主操作', await page.locator('#itlSubmit').evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(46, 120, 97)');
    await page.screenshot({path:path.join(artifacts,'asset-register.png')}); await page.locator('#itlModalCancel').click();
    await page.goto(f.base + '/IT_Ledger.html#inspections'); await page.locator('[data-insp-continue="' + sheet.id + '"]').click();
    await page.locator('#itlSheetRoute').waitFor();
    check('六段登记顺序与初始展开', JSON.stringify(await page.locator('[data-workflow-section]').evaluateAll(nodes=>nodes.map(el=>[el.dataset.workflowSection,el.open]))) === JSON.stringify([['basic',true],['room',true],['rack',false],['device',false],['remark',false],['review',false]]));
    check('提交按钮在固定底栏', await page.locator('#itlFormFooter #itlFormSubmit').count() === 1 && await page.locator('#itlFormFooter').evaluate(el=>getComputedStyle(el).position)==='fixed');
    const device = sheet.items.find(it=>it.section==='device');
    await page.locator('[data-missing-key="unfilled:' + device.id + '"]').click();
    check('缺项自动展开设备并聚焦', await page.locator('[data-workflow-section=device]').evaluate(el=>el.open) && await page.locator('[data-seg-ok="' + device.id + '"]').evaluate(el=>el===document.activeElement));
    check('人工观察与可选采集提示', (await page.locator('[data-workflow-section=device]').innerText()).includes('现场观察即可登记') && (await page.locator('[data-collection-state]').first().innerText()).includes('现场观察登记'));
    await page.locator('[data-seg-ok="' + device.id + '"]').click();
    await page.waitForFunction(()=>document.querySelector('#itlFormSavedAt').textContent.includes('草稿已保存'));
    check('自动保存重绘保留展开', await page.locator('[data-workflow-section=device]').evaluate(el=>el.open));
    check('真实路由持久化人工判断', (await api('GET','/inspections/sheets/'+sheet.id,undefined,200,2)).items.find(it=>it.id===device.id).result==='ok');
    await page.locator('#itlSheetExpandAll').click();
    check('全部展开六段', await page.locator('[data-workflow-section][open]').count()===6);
    await page.locator('[data-workflow-section=rack] > summary').click();
    await page.locator('#itlSheetRoute [data-workflow-go=room]').click();
    const num = sheet.items.find(it=>it.item_key==='temperature'); await page.locator('[data-num-id="'+num.id+'"]').fill('23.5');
    await page.waitForFunction(()=>document.querySelector('#itlFormSavedAt').textContent.includes('草稿已保存'));
    check('自动保存不会展开用户收起的机柜段', !(await page.locator('[data-workflow-section=rack]').evaluate(el=>el.open)));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(artifacts,'inspection-form.png')});
    for(const width of [1024,768,390]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(artifacts,'inspection-'+width+'.png')});
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))console.log('OVERFLOW',await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().width>innerWidth).map(e=>({tag:e.tagName,cls:e.className,id:e.id,width:e.getBoundingClientRect().width,overflow:getComputedStyle(e).overflow})).slice(0,20)));
      check('巡检窄屏无页面溢出 '+width, await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    check('浏览器无脚本异常', errors.length===0);
    fs.writeFileSync(path.join(artifacts,'result.json'),JSON.stringify({pass,errors,scope:'Nine views, common surfaces, Plan B inspection workflow',artifacts},null,2));
    console.log('PLAN_B_BROWSER PASS='+pass+' FAIL=0');
  } finally { if(browser) await browser.close(); await f.close(); }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
