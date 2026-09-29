'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const startFixture = require('./lib/sys-archive-origin-fixture');

(async () => {
  const f = await startFixture(); let browser; let pass = 0;
  const dir = process.env.ARCHIVE_ORIGIN_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(),'sys-archive-browser-'));
  fs.mkdirSync(dir, { recursive:true });
  const check = (name, yes) => { assert.ok(yes, name); pass++; console.log('[OK] ' + name); };
  try {
    browser = await chromium.launch({ headless:true });
    const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    let closeRequests = 0;
    page.on('request', req => { if (/\/sys-issues\/\d+\/close$/.test(req.url())) closeRequests++; });
    await page.addInitScript(() => localStorage.setItem('token','fixture-1'));
    await page.goto(f.base + '/Sys_Iteration.html', { waitUntil:'networkidle' });
    await page.waitForFunction(() => typeof META_OK !== 'undefined' && META_OK && currentUser && currentUser.id === 1);
    const open = async id => {
      await page.evaluate(id => siOpenDrawer(id), id);
      await page.waitForFunction(id => siDetail && siDetail.issue.id === id, id);
    };
    const showModal = async id => {
      await open(id);
      await page.locator('#siDActions').getByRole('button',{ name:'归档', exact:true }).click();
      await page.locator('#siModalOverlay.open').waitFor();
    };
    const select = page.locator('#f_archive_origin_code');
    const note = page.locator('#f_archive_origin_note');
    const confirm = page.locator('#siMConfirm');
    const id = await f.seed('bug');
    const da = await f.run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,dev_status,no_code_reason,resolved_at,round_no) VALUES(?,5,'测试开发 <tag>','no_code','合成免代码交付',datetime('now','localtime'),1)",[id]);
    const bugNote = '已有开发原因 <img src=x onerror="window.archiveXss=1">';
    await f.run("INSERT INTO sys_issue_dev_events(issue_id,dev_assignee_id,action,from_status,to_status,operator_id,payload_json,created_at) VALUES(?,?,'no_code','pending','no_code',5,?,datetime('now','localtime'))",[id,da.lastID,JSON.stringify({bug_cause_note:bugNote,no_code_reason:'合成免代码交付'})]);
    const oldDa = await f.run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,dev_status,no_code_reason,resolved_at,round_no,removed_at) VALUES(?,5,'历史开发','no_code','旧说明',datetime('now','localtime'),1,datetime('now','localtime'))",[id]);
    await f.run("INSERT INTO sys_issue_dev_events(issue_id,dev_assignee_id,action,operator_id,payload_json,created_at) VALUES(?,?,'no_code',5,?,datetime('now','localtime'))",[id,oldDa.lastID,JSON.stringify({bug_cause_note:'历史原因不得当作本轮参考'})]);
    await showModal(id);
    check('九类加空选项且无默认分类', await select.locator('option').count() === 10 && await select.inputValue() === '');
    check('bug 本轮开发原因显示并转义', (await page.locator('#siMBody').innerText()).includes(bugNote) && await page.locator('#siMBody img').count() === 0);
    check('开发原因带实际轮次且排除已移出成员', (await page.locator('#siMBody').innerText()).includes('第1轮') && !(await page.locator('#siMBody').innerText()).includes('历史原因不得当作本轮参考'));
    await confirm.click(); await page.waitForFunction(() => !document.querySelector('#siMConfirm').disabled);
    check('未选原因不发请求', closeRequests === 0 && await select.isVisible());
    await select.selectOption('other');
    check('其他说明仍显示且提示必填', await note.isVisible() && await note.getAttribute('aria-required') === 'true');
    await confirm.click(); await page.waitForFunction(() => !document.querySelector('#siMConfirm').disabled);
    check('其他空说明不发请求', closeRequests === 0);
    await note.fill('😀'.repeat(501)); await confirm.click(); await page.waitForFunction(() => !document.querySelector('#siMConfirm').disabled);
    check('前端按码点拦501字', closeRequests === 0);
    const text = '归档说明 <img src=x onerror="window.archiveXss=1">\n第二行';
    await note.fill(text);
    // Real backend failure must retain the user's form; no mocked success response.
    await f.run("CREATE TEMP TRIGGER browser_archive_fault BEFORE INSERT ON sys_issue_timeline WHEN NEW.action_code='close' BEGIN SELECT RAISE(ABORT,'browser archive fault'); END");
    await confirm.click(); await page.waitForFunction(() => !document.querySelector('#siMConfirm').disabled);
    check('失败保留输入与选择', await note.inputValue() === text && await select.inputValue() === 'other');
    check('失败没有归档', (await f.get('SELECT status FROM sys_issues WHERE id=?',[id])).status === '已上线');
    await f.run('DROP TRIGGER browser_archive_fault');
    await page.locator('#siModalOverlay .si-modal').screenshot({ path:path.join(dir,'01-archive-form.png') });
    let releaseRequest, reachedRequest;
    const hold = new Promise(resolve => { releaseRequest = resolve; });
    const reached = new Promise(resolve => { reachedRequest = resolve; });
    const closeRoute = '**/sys-issues/' + id + '/close';
    await page.route(closeRoute, async route => { reachedRequest(); await hold; await route.continue(); });
    const beforeClick = closeRequests;
    await confirm.click();
    await reached;
    check('提交期间按钮禁用', await confirm.isDisabled());
    await page.evaluate(() => document.getElementById('siMConfirm').click());
    check('连续点击不重复发归档请求', closeRequests === beforeClick + 1);
    releaseRequest();
    await page.waitForFunction(id => siDetail && siDetail.issue.id === id && siDetail.issue.status === '已关闭',id);
    await page.unroute(closeRoute);
    check('成功刷新详情与关闭表单', await page.locator('#siArchiveOriginDetail').isVisible() && await page.locator('#siModalOverlay.open').count() === 0);
    check('详情显示原因完整说明且无XSS', (await page.locator('#siArchiveOriginDetail').innerText()).includes(text) && await page.locator('#siArchiveOriginDetail img').count() === 0 && !(await page.evaluate(() => window.archiveXss)));
    const saved = await f.get("SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='close'",[id]);
    check('浏览器真实归档写入数据库', JSON.parse(saved.payload_json).archive_origin.note === text);
    check('连续点击只有一条归档事件', (await f.get("SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE issue_id=? AND action_code='close'",[id])).n === 1);
    check('开发原因原值保持', JSON.parse((await f.get('SELECT payload_json FROM sys_issue_dev_events WHERE dev_assignee_id=?',[da.lastID])).payload_json).bug_cause_note === bugNote);
    await page.locator('#siArchiveOriginDetail').screenshot({ path:path.join(dir,'02-archive-detail.png') });
    for (const type of ['feature','improvement','config']) {
      const item = await f.seed(type); await showModal(item);
      check(type+'无默认原因', await select.inputValue() === '');
      await select.selectOption('routine_maintenance');
      check(type+'普通原因说明可选且一直可见', await note.isVisible() && await note.getAttribute('aria-required') === 'false');
      if (type === 'config') await note.fill('A'.repeat(500));
      await confirm.click(); await page.waitForFunction(id => siDetail && siDetail.issue.id === id && siDetail.issue.status === '已关闭',item);
      check(type+(type === 'config' ? '500字说明归档成功' : '空说明归档成功'), (await page.locator('#siArchiveOriginDetail').innerText()).includes('日常运维或配置需要'));
      if (type === 'config') check('500字无空格说明完整显示且不溢出', await page.locator('#siArchiveOriginDetail').evaluate(el => el.innerText.includes('A'.repeat(500)) && el.scrollWidth <= el.clientWidth + 1));
    }
    const legacy = await f.seed('feature','已关闭'); await open(legacy);
    check('历史未记录正常显示', (await page.locator('#siArchiveOriginDetail').innerText()).includes('未记录'));
    const renderChecks = await page.evaluate(() => {
      const old = {id:1,event_type:'status_change',action_code:'close',to_status:'已关闭',payload_json:JSON.stringify({archive_origin:{version:1,code:'other',label:'其他',note:'上一轮'}})};
      const newer = {...old,id:3,payload_json:JSON.stringify({archive_origin:{version:1,code:'new_business',label:'新增业务需要',note:'本轮'}})};
      return {
        open:siRenderArchiveOrigin({status:'开发中'},[old]),
        mixed:siRenderArchiveOrigin({status:'已关闭'},[old,{id:2,event_type:'status_change',action_code:'reopen',to_status:'开发中'}]),
        latest:siRenderArchiveOrigin({status:'已关闭'},[newer,old]),
        timeline:siRenderTimeline([old,newer],[],'合成任务'),
        malformed:siRenderArchiveOrigin({status:'已关闭'},[{...old,payload_json:'broken'}]),
      };
    });
    check('重开不把旧原因冒充本轮', renderChecks.open === '' && !renderChecks.mixed.includes('上一轮'));
    check('详情按事件id取最新归档', renderChecks.latest.includes('本轮') && !renderChecks.latest.includes('上一轮'));
    check('时间线保留多轮完整原因', renderChecks.timeline.includes('上一轮') && renderChecks.timeline.includes('本轮'));
    check('畸形历史载荷安全降级', renderChecks.malformed.includes('未记录'));
    check('无浏览器运行异常', pageErrors.length === 0);
    console.log('BROWSER_ARTIFACTS=' + dir); console.log(`PASS=${pass} FAIL=0`);
  } finally { if (browser) await browser.close(); await f.stop(); }
})().catch(e => { console.error(e); console.log('PASS=0 FAIL=1'); process.exitCode=1; });
