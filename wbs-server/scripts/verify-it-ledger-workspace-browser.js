'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser,pass=0;console.log('ISOLATED_ARTIFACTS='+f.dir);
 const check=(name,value)=>{assert.ok(value,name);pass++;console.log('[OK] '+name);};
 try{
  const rack=(await f.api('POST','/racks',{name:'生产示例机柜',u_total:24})).body;
  const a=(await f.api('POST','',{category:'server',name:'设备名称用于测试长文案不会撑破布局',u_height:2,slot_count:4,fin_amount:12345,attrs:{ip:'192.0.2.9',purpose:'测试用途',os:'Microsoft Windows Server 2008 R2 Enterprise'},placement:{kind:'rack',rack_id:rack.id,u_start:3}})).body;
  check('真实路由建资产',Number.isInteger(a.id));
  for(const body of [{category:'laptop',name:'库房备用笔记本',placement:{kind:'depot'}},{category:'desktop',name:'办公终端',placement:{kind:'custodian',custodian_name:'测试保管人',location_text:'办公区'}},{category:'subscription',name:'年度订阅',expires_at:'2027-09-22'}]){const created=await f.api('POST','',body);check('补充真实视图夹具 '+body.category,created.status===201);}
  browser=await chromium.launch({headless:true});const c=await browser.newContext({viewport:{width:1440,height:960}});await c.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(f.base+'/IT_Ledger.html#all');await p.locator('#itlTable').waitFor();
  const geometry=await p.evaluate(()=>{const n=document.querySelector('#itlTabs').getBoundingClientRect(),m=document.querySelector('.itl-page').getBoundingClientRect();return {left:n.right<=m.left,count:document.querySelectorAll('#itlTabs [data-tab]').length};});
  check('桌面左侧九视图分层导航',geometry.left&&geometry.count===9);
  // Flat grouped navigation (2026-09-23 user decision): exact groups and order, no collapse toggle, labels never navigate.
  const navLayout=await p.evaluate(()=>[...document.querySelectorAll('#itlTabs .itl-nav-group')].map(g=>(g.querySelector('.itl-nav-group-label')?.textContent||'')+':'+[...g.querySelectorAll('[data-tab]')].map(b=>b.dataset.tab).join('/')).join('|'));
  check('导航平铺分组且顺序全等',navLayout===':all|按位置:racks/depot/aps|按类型:terminals/software|核对作业:stocktakes/reconciles/inspections');
  check('没有折叠开关且分组标题不是导航项',await p.locator('[data-assets-toggle],#itlAssetSubnav').count()===0&&await p.locator('#itlTabs .itl-nav-group-label[data-tab],#itlTabs .itl-nav-group-label button').count()===0&&await p.locator('[data-inventory-view]').count()===0);
  // One primary action per screen on the page layer (drawers, dialogs and overlays keep their own).
  const pagePrimaries=()=>p.evaluate(()=>[...document.querySelectorAll('.itl-page .u-btn-primary')].filter(b=>!b.closest('#itlDrawer,.u-modal,.itl-modal,[class*="overlay"],[class*="dialog"]')&&b.offsetParent!==null).map(b=>b.textContent.trim()));
  const primaryByView={};
  for(const view of ['all','racks','depot','aps','terminals','software','stocktakes','reconciles','inspections']){await p.evaluate(v=>location.hash=v,view);await p.locator(`[data-tab="${view}"][aria-current="page"]`).waitFor();await p.waitForTimeout(150);primaryByView[view]=await pagePrimaries();}
  // C4：旧总览与机房巡检子页已由巡检台账列表替换（C6）。改探同一条规则
  // 在新视图的"已删除"子屏（管理员专属，itlInspOpenDeleted/itlInspBackToList）上仍然成立。
  await p.evaluate(()=>location.hash='inspections');await p.locator('#itlInspOpenDeleted').click();await p.locator('#itlInspBackToList').waitFor();primaryByView.deleted=await pagePrimaries();await p.locator('#itlInspBackToList').click();
  // Rule agreed with the user: at most one primary per screen (never several); asset views lead with 登记设备, work views never do.
  check('每屏页面层最多一个主按钮',Object.values(primaryByView).every(x=>x.length<=1)&&['all','racks','depot','aps','terminals','software'].every(v=>primaryByView[v].length===1&&primaryByView[v][0].includes('登记设备'))&&['stocktakes','reconciles','deleted','inspections'].every(v=>!primaryByView[v].some(t=>t.includes('登记设备'))));
  await p.evaluate(()=>location.hash='all');await p.locator('[data-tab="all"][aria-current="page"]').waitFor();
  // Single-line header: title and primary action share one row, no breadcrumb; admins see only the count.
  const head=await p.evaluate(()=>{const t=document.querySelector('#itlViewTitle').getBoundingClientRect(),r=document.querySelector('#itlRegister').getBoundingClientRect();return {sameRow:t.top<r.bottom&&r.top<t.bottom,crumb:document.querySelectorAll('.itl-heading .itl-eyebrow').length,access:document.querySelector('#itlAccess').textContent,count:document.querySelectorAll('#itlTable tbody tr').length};});
  check('页头单行且无面包屑',head.sameRow&&head.crumb===0&&/^台账共 \d+ 项$/.test(head.access));
  await p.locator('[data-tab="all"]').click();check('全部资产点击保持总表',await p.locator('#itlTable').isVisible()&&await p.locator('[data-tab="all"]').getAttribute('aria-current')==='page');
  await p.evaluate(()=>location.hash='racks');await p.locator('.itl-rack-frame').waitFor();check('子视图深链接直接选中',await p.locator('[data-tab="racks"]').getAttribute('aria-current')==='page'&&await p.locator('#itlTabs [aria-current="page"]').count()===1);
  // Rack panel: frequency order (detail link, 常用, 位置变更 with 下架 last in red), no accent button, free runs summarised in the subtitle.
  await p.locator('.itl-rack-frame').first().click();await p.locator('[data-select-rack-asset="'+a.id+'"]').click();await p.locator('#itlRackPanel [data-rack-command="out"]').waitFor();
  const rackPanel=await p.evaluate(()=>{const panel=document.querySelector('#itlRackPanel');return {order:[...panel.querySelectorAll('[data-rack-command]')].map(b=>b.dataset.rackCommand).join(','),groups:[...panel.querySelectorAll('.itl-panel-group-label')].map(x=>x.textContent).join(','),primary:panel.querySelectorAll('.u-btn-primary').length,danger:panel.querySelector('[data-rack-command="out"]').classList.contains('itl-btn-danger-text'),free:document.querySelectorAll('.itl-free-runs,[data-free-start]').length,sub:document.querySelector('#itlRackSub').textContent};});
  check('机柜面板按频率分组且空段收为摘要',rackPanel.order==='detail,disks,edit,move,replace,out'&&rackPanel.groups==='常用,位置变更'&&rackPanel.primary===0&&rackPanel.danger&&rackPanel.free===0&&/ · 最大连续空段 \d+U（U\d+–\d+）$/.test(rackPanel.sub));
  await p.locator('[data-rack-command="close"]').click();
  await p.goto(f.base+'/IT_Ledger.html#inventory');await p.locator('#itlInventoryContent table').waitFor();check('旧inventory链接兼容盘点',await p.locator('[data-tab="stocktakes"]').getAttribute('aria-current')==='page'&&await p.locator('#itlViewTitle').innerText()==='盘点');
  await p.goto(f.base+'/IT_Ledger.html#reconciles');await p.locator('#itlInventoryContent table').waitFor();check('对账独立深链接刷新保留',await p.locator('[data-tab="reconciles"]').getAttribute('aria-current')==='page'&&await p.locator('#itlViewTitle').innerText()==='对账');await p.locator('[data-tab="all"]').click();
  check('标题对应当前视图',await p.locator('#itlViewTitle').innerText()==='全部资产');
  await p.locator('[data-tab="depot"]').click();await p.locator('.itl-module-name').click();await p.locator('[data-tab="all"][aria-current]').waitFor();check('模块标题链接同步全部资产',await p.locator('#itlViewTitle').innerText()==='全部资产');await p.locator('[data-tab="all"]').click();
  await p.locator('[data-density="compact"]').click();check('紧凑密度可切换',await p.locator('#itlTable').evaluate(el=>el.classList.contains('itl-table-compact')));
  const contentBefore=await p.locator('#itlContent').boundingBox();
  await p.locator('[data-detail="'+a.id+'"]').click();await p.locator('#itlDrawerBody .itl-kv').first().waitFor();
  await p.waitForFunction(()=>Math.abs(document.querySelector('#itlDrawer').getBoundingClientRect().right-innerWidth)<1);
  check('宽屏同样是遮罩抽屉',await p.locator('#itlDrawer').getAttribute('aria-modal')==='true'&&await p.locator('#itlDrawerOverlay').isVisible());
  const contentAfter=await p.locator('#itlContent').boundingBox();check('打开抽屉不压缩或移动列表',contentBefore.x===contentAfter.x&&contentBefore.width===contentAfter.width);
  const sys=fs.readFileSync(path.join(__dirname,'../public/Sys_Iteration.html'),'utf8');
  const css=['si-overlay','si-overlay.open','si-drawer','si-drawer.open'].map(cls=>sys.match(new RegExp('\\.'+cls.replace('.','\\.')+'\\s*\\{[^}]+\\}'))[0]).join('\n');
  const reference=await c.newPage();await reference.setContent('<style>body{margin:0}'+css+'</style><div class="si-overlay open"></div><div class="si-drawer open"></div>');
  const measure=async(page,drawer,overlay)=>page.evaluate(([d,o])=>{const e=document.querySelector(d),r=e.getBoundingClientRect(),style=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,position:style.position,shadow:style.boxShadow,duration:style.transitionDuration.split(',')[0],overlay:getComputedStyle(document.querySelector(o)).backgroundColor};},[drawer,overlay]);
  check('实际几何遮罩动画与系统迭代一致',JSON.stringify(await measure(p,'#itlDrawer','#itlDrawerOverlay'))===JSON.stringify(await measure(reference,'.si-drawer','.si-overlay')));await reference.close();
  const headerBefore=await p.locator('#itlDrawer .u-drawer-header').boundingBox(),pageScroll=await p.evaluate(()=>scrollY);
  await p.locator('#itlDrawerBody').evaluate(el=>el.scrollTop=250);check('正文独立滚动且标题固定',await p.locator('#itlDrawerBody').evaluate(el=>el.scrollTop>0)&&await p.evaluate(()=>scrollY)===pageScroll&&(await p.locator('#itlDrawer .u-drawer-header').boundingBox()).y===headerBefore.y);
  await p.keyboard.press('Escape');check('按系统迭代普通抽屉不响应Escape关闭',await p.locator('#itlDrawer').evaluate(el=>el.classList.contains('open')));
  await p.locator('#itlDrawerBody').evaluate(el=>el.scrollTop=0);await p.screenshot({path:path.join(f.dir,'workspace-all-detail.png'),fullPage:true});
  await p.locator('#itlDrawerOverlay').click({position:{x:20,y:150}});await p.locator('#itlDrawer').waitFor({state:'hidden'});await p.waitForFunction(()=>document.querySelector('#itlDrawerBody').childElementCount===0);
  check('点击遮罩关闭并清理详情',!await p.locator('#itlDrawerOverlay').isVisible());
  await p.locator('[data-detail-row="'+a.id+'"] td').nth(2).click();await p.locator('#itlDrawerBody .itl-kv').first().waitFor();check('点击整行非操作区打开详情',await p.locator('#itlDrawerTitle').innerText()==='设备名称用于测试长文案不会撑破布局');
  // Drawer fields follow the platform u-kv layout only: label above value everywhere, location first, config split into fields.
  const kvShape=await p.evaluate(()=>{const items=[...document.querySelectorAll('#itlAssetProfile .u-kv-item')],label=i=>i.querySelector(':scope>label')?.textContent;return {n:items.length,stacked:items.every(i=>{const l=i.querySelector(':scope>label'),v=i.querySelector(':scope>.v');return !!l&&!!v&&l.getBoundingClientRect().bottom<=v.getBoundingClientRect().top+1;}),first:label(items[0]),attrs:items.filter(i=>['IP','用途','操作系统'].includes(label(i))).map(i=>label(i)+(i.classList.contains('full')?':full':':half')).join(','),legacy:document.querySelectorAll('.itl-attribute-line,.itl-detail-location').length};});
  check('抽屉字段统一为上下结构且配置拆为独立字段',kvShape.n>10&&kvShape.stacked&&kvShape.first==='当前位置'&&kvShape.attrs==='IP:half,用途:half,操作系统:full'&&kvShape.legacy===0);await p.locator('#itlDrawerClose').click();await p.locator('#itlDrawer').waitFor({state:'hidden'});
  await p.locator('[data-tab="depot"]').click();check('关闭后切换视图无残留',await p.locator('#itlDrawerBody').innerText()==='');
  // Asset cards: category is the heading, the name stays the detail button, actions are small secondary buttons, cards do not stretch.
  const cardShape=()=>p.evaluate(()=>[...document.querySelectorAll('#itlContent .itl-card')].map(c=>({kind:c.querySelector('.itl-card-kind')?.firstChild?.textContent.trim(),name:c.querySelector('.itl-card-name[data-detail]')?.textContent,width:Math.round(c.getBoundingClientRect().width),bare:c.querySelectorAll('.itl-actions .itl-link').length,buttons:[...c.querySelectorAll('.itl-actions [data-action]')].map(b=>b.classList.contains('u-btn-secondary')&&b.classList.contains('itl-btn-sm'))})));
  const depotCards=await cardShape();
  await p.evaluate(()=>location.hash='terminals');await p.locator('[data-tab="terminals"][aria-current="page"]').waitFor();await p.locator('#itlContent .itl-card-grid').first().waitFor();const terminalCards=await cardShape();
  const office=terminalCards.find(c=>c.name==='办公终端');
  // Card actions live only in the ⋯ menu; action labels carry no trailing ellipsis (platform uses it only for in-progress text).
  const menus=await p.evaluate(()=>[...document.querySelectorAll('#itlContent .itl-card')].map(c=>({name:c.querySelector('.itl-card-name')?.textContent,labels:[...c.querySelectorAll('.itl-menu-panel button')].map(b=>b.textContent),actions:c.querySelectorAll('.itl-actions').length})));
  check('卡片操作只在菜单且文案无省略号',menus.find(m=>m.name==='办公终端')?.labels.join(',')==='编辑资料,换保管人,移位置,归还'&&menus.every(m=>m.actions===0&&m.labels.every(l=>!l.includes('…'))));
  check('卡片以类别为标题且不再拉满整行',depotCards.some(c=>c.name==='库房备用笔记本'&&c.kind==='笔记本')&&!!office&&office.kind==='台式机'&&office.buttons.length===0&&[...depotCards,...terminalCards].every(c=>c.kind&&c.name&&c.bare===0)&&terminalCards.every(c=>c.width<=420));
  await p.evaluate(()=>location.hash='depot');await p.locator('[data-tab="depot"][aria-current="page"]').waitFor();
  const depotCard=p.locator('.itl-card').filter({has:p.getByRole('button',{name:'库房备用笔记本',exact:true})});await depotCard.locator('.itl-menu summary').click();check('卡片菜单点击后保持打开',await depotCard.locator('.itl-menu').evaluate(el=>el.open));await p.locator('.itl-lane h2').first().click();check('点击菜单外关闭',!await depotCard.locator('.itl-menu').evaluate(el=>el.open));await depotCard.locator('.itl-menu summary').click();await depotCard.locator('[data-action="edit"]').click();await p.locator('#itlModal.open').waitFor();check('菜单操作仍可打开编辑',await p.locator('#itlModal').evaluate(el=>el.classList.contains('open')));await p.locator('#itlModalClose').click();
  await p.locator('[data-tab="all"]').click();check('密度跨视图保留',await p.locator('#itlTable').evaluate(el=>el.classList.contains('itl-table-compact')));
  // Narrow screens: deep links to right-hand views keep the current nav item inside the scrolling row (codex 31 M1).
  await p.setViewportSize({width:390,height:700});const navVisible=[];
  for(const view of ['stocktakes','inspections','software']){await p.evaluate(v=>location.hash=v,view);await p.locator(`[data-tab="${view}"][aria-current="page"]`).waitFor();navVisible.push(await p.evaluate(v=>{const n=document.querySelector('#itlTabs').getBoundingClientRect(),b=document.querySelector(`#itlTabs [data-tab="${v}"]`).getBoundingClientRect();return b.left>=n.left-1&&b.right<=n.right+1;},view));}
  await p.reload();await p.locator('[data-tab="software"][aria-current="page"]').waitFor();navVisible.push(await p.evaluate(()=>{const n=document.querySelector('#itlTabs').getBoundingClientRect(),b=document.querySelector('#itlTabs [aria-current="page"]').getBoundingClientRect();return b.left>=n.left-1&&b.right<=n.right+1;}));
  check('窄屏深链接选中项在导航可视区内',navVisible.every(Boolean));await p.setViewportSize({width:1440,height:960});await p.evaluate(()=>location.hash='all');await p.locator('#itlTable').waitFor();
  for(const width of [1100,768,390]){
   await p.setViewportSize({width,height:600});await p.locator('[data-detail="'+a.id+'"]').click();await p.locator('#itlDrawerBody .itl-kv').first().waitFor();
   check(width+'详情为模态抽屉',await p.locator('#itlDrawer').getAttribute('aria-modal')==='true');
   await p.waitForFunction(()=>{const r=document.querySelector('#itlDrawerClose').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
   const box=await p.locator('#itlDrawerClose').boundingBox();check(width+'关闭可达',box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=600);
   await p.locator('#itlDrawerClose').click();await p.locator('#itlDrawer').waitFor({state:'hidden'});check(width+'页面无横向溢出',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await p.setViewportSize({width:1440,height:960});await p.locator('[data-tab="racks"]').click();await p.locator('.itl-rack-frame[data-open-rack]').click();await p.locator('#itlRackOverlay').waitFor({state:'visible'});check('示意图直接进入正视图且无右侧摘要',(await p.locator('#itlRackTitle').innerText()).includes('生产示例机柜')&&await p.locator('.itl-overview-panel').count()===0);await p.locator('[data-rack-command="close"]').click();await p.screenshot({path:path.join(f.dir,'workspace-racks.png'),fullPage:true});
  for(const width of [1440,768,390]){await p.setViewportSize({width,height:900});if(width===768){console.log('NAV_GEOMETRY',await p.evaluate(()=>[document.querySelector('.navbar'),document.querySelector('.itl-sidebar')].map(el=>({rect:el.getBoundingClientRect().toJSON(),pos:getComputedStyle(el).position}))));await p.screenshot({path:path.join(f.dir,'workspace-nav-768.png')});}for(const tab of ['depot','terminals','software','stocktakes','reconciles']){await p.locator('[data-tab="'+tab+'"]').click();if(['stocktakes','reconciles'].includes(tab))await p.locator('#itlInventoryContent table').waitFor();check(width+' '+tab+' 页面无横向溢出',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===1440)await p.screenshot({path:path.join(f.dir,'workspace-'+tab+'.png'),fullPage:true});}}
  // --- Auto refresh (no button): plan v0.5 D14 / §6.1. Dedicated context + fake clock so timing stays isolated
  // from every earlier check in this file (scroll position, density, drawers, etc. above are untouched by this).
  const acContext=await browser.newContext({viewport:{width:1440,height:960}});await acContext.addInitScript(()=>localStorage.setItem('token','fixture-1'));
  const ac=await acContext.newPage();const acErrors=[];ac.on('pageerror',e=>acErrors.push(e.message));
  let meCount=0,stockCount=0;ac.on('request',r=>{if(r.url().endsWith('/api/it-assets/me'))meCount++;if(r.url().endsWith('/api/it-assets/stocktakes'))stockCount++;});
  // Arrival signal for negative checks (no sleeps): a refresh issues its /me fetch synchronously inside the triggering
  // handler, so a sentinel fetched afterwards is observed after any /me the trigger would have caused.
  const sentinel=async()=>{const seen=ac.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await ac.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  const setVisibility=state=>ac.evaluate(value=>{Object.defineProperty(document,'visibilityState',{value,configurable:true});document.dispatchEvent(new Event('visibilitychange'));},state);
  const meResponse=()=>ac.waitForResponse(r=>r.url().endsWith('/api/it-assets/me'));
  await ac.goto(f.base+'/IT_Ledger.html#all');await ac.locator('#itlTable').waitFor();
  check('没有刷新按钮',await ac.locator('#itlRefresh').count()===0);
  await ac.clock.install();
  // 1) Still inside the 10s throttle right after load: switching tabs must not fire a second /me.
  meCount=0;await ac.locator('[data-tab="depot"]').click();await ac.locator('[data-tab="depot"][aria-current="page"]').waitFor();await sentinel();
  check('节流内切页签不产生新的/me请求',meCount===0);
  // 2) Past the throttle a tab switch refreshes once, and a view that loads its own data loads it once (the switch
  // must not render from cache and then render again after the refresh).
  await ac.clock.fastForward(11000);meCount=0;stockCount=0;
  let meWait=meResponse();
  await ac.locator('[data-tab="stocktakes"]').click();await ac.locator('[data-tab="stocktakes"][aria-current="page"]').waitFor();await meWait;
  await ac.waitForFunction(()=>!document.querySelector('#itlContent').hasAttribute('aria-busy'));await ac.locator('#itlInventoryContent').waitFor();await sentinel();
  check('过节流后切页签产生一次/me请求',meCount===1);
  check('切页签自动刷新时视图只加载一次',stockCount===1);
  // 3) C0b (plan v0.5 §6.1, D14 decision A): window re-visibility no longer refreshes at all — the
  // `visibilitychange` listener that used to call autoRefresh('visible') was deleted outright, not merely
  // re-gated. Exercise it in the exact plain-browsing "all" tab state the old allow-list (VISIBLE_REFRESH_TABS)
  // would have refreshed, so a zero /me here proves the listener itself is gone, not just blocked by some other
  // condition; the stale notice staying put is a second, independent signal that refresh() never ran. This single
  // check replaces the old checks 3/5/8 (all variants of "re-visibility refreshes/doesn't refresh some tab or
  // state") — none of that allow-list machinery exists anymore for any tab or drawer state to vary against.
  await ac.locator('[data-tab="all"]').click();await ac.locator('#itlTable').waitFor();
  await ac.evaluate(()=>ITLedger.notice('过期提示'));
  // 4) Becoming hidden never refreshes (kept from the old file, still meaningful: proves toggling visibilityState
  // to 'hidden' triggers nothing, same as the next line proves for 'visible').
  await ac.clock.fastForward(11000);meCount=0;await setVisibility('hidden');await sentinel();
  check('窗口变为不可见不刷新',meCount===0);
  meCount=0;await setVisibility('visible');await sentinel();
  check('过节流后窗口重新可见不再产生任何/me请求(D14 A：可见性监听已整体删除)',meCount===0);
  check('过期提示未被自动清除(证明没有任何刷新发生)',!await ac.locator('#itlNotice').isHidden());
  const waitIdle=()=>ac.waitForFunction(()=>!document.querySelector('#itlContent').hasAttribute('aria-busy'));
  // 10b) A tab switch that starts a refresh shows a placeholder; if that refresh fails the cached view comes back
  // (no refresh button is left to recover with) and the notice explains the failure.
  await ac.clock.fastForward(11000);await ac.route('**/api/it-assets/me',route=>route.abort(),{times:1});
  await ac.locator('[data-tab="depot"]').click();await ac.locator('#itlNotice').waitFor({state:'visible'});await ac.locator('#itlContent .itl-depot').waitFor();await waitIdle();
  check('切页签刷新失败时回到缓存视图不停在占位',!(await ac.locator('#itlContent').innerText()).includes('正在读取…'));
  // B) C0b: with a modal open, a tab switch cannot be triggered by a real pointer click — the modal backdrop
  // (`.u-modal-overlay`, position:fixed inset:0, z-index 1100 in it-ledger.css) covers the entire viewport
  // including the tab nav — even where `.itl-sidebar` gets a z-index at all (the narrow mobile media query sets
  // it to 30), that is far below the modal's 1100, so the backdrop still wins regardless of viewport width — so
  // `elementFromPoint` at a tab button's centre resolves to the backdrop, never the button, and a real Playwright
  // click() would time out waiting for it to become actionable. The only path left to reach setTab() while a
  // modal is open is programmatic (hashchange — back/forward or a typed URL); exercise that and confirm it still
  // falls back to a cache render, zero /me (autoRefresh() sees the open modal and returns false — the one guard
  // kept from the old function).
  await ac.clock.fastForward(11000);meWait=meResponse();await ac.locator('[data-tab="all"]').click();await meWait;await waitIdle();
  await ac.clock.fastForward(11000);
  await ac.locator('#itlRegister').click();await ac.locator('#itlModal.open').waitFor();
  // L2（C0c）：不只断言"命中的不是页签按钮"，直接断言命中元素本身就在弹窗里——否则命中第三个无关元素
  // 也会被误判成"被弹窗遮挡"。
  const depotTabCovered=await ac.evaluate(()=>{const btn=document.querySelector('[data-tab="depot"]');const r=btn.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!(hit&&hit.closest('#itlModal'));});
  check('弹窗打开时页签按钮被弹窗背板完全遮挡(elementFromPoint命中弹窗本体而非页签)',depotTabCovered);
  // M2（C0c，C4追加修正·codex 39）：hashchange是异步派发的，若先sentinel()再断言setTab副作用，sentinel
  // 可能在setTab真正跑到autoRefresh()判断之前就已经发出并收敛，把"还没跑到"误判成"跑了但零/me"的假阳性。
  // 改为先等setTab确实执行完（aria-current切到depot、内容区已按缓存渲染出库房视图），再sentinel确认零/me。
  meCount=0;await ac.evaluate(()=>{location.hash='depot';});
  await ac.locator('[data-tab="depot"][aria-current="page"]').waitFor();
  await ac.locator('#itlContent .itl-depot').waitFor();
  const depotHashResult=await ac.evaluate(()=>({tab:ITLedger.state.tab,current:document.querySelector('[data-tab="depot"]')?.getAttribute('aria-current')}));
  check('弹窗打开时hashchange确实执行了setTab(state.tab与aria-current都已切到depot)',depotHashResult.tab==='depot'&&depotHashResult.current==='page',depotHashResult);
  // L7（C4b顺手修）：这里原本还有一条"`.itl-depot`.count()>0"的断言——挪位后已经恒真：:159 的
  // `.waitFor()`已经显式等到这个元素出现/可见才往下走，同一个选择器紧接着再 count()>0 判定不了任何
  // 新信息，纯粹是把已经保证过的事实又断言了一遍。直接删掉，不留只测"我刚等过的东西还在"这种断言。
  await sentinel();
  check('弹窗打开时hashchange切页签不产生/me请求(autoRefresh对开着的弹窗返回false，按缓存渲染)',meCount===0);
  // C) C0b: closing the modal / closing the drawer no longer flushes anything — pendingAutoRefresh and
  // flushAutoRefresh were deleted outright, so both closes must now produce zero /me (the old checks 10c/10d
  // expected exactly one /me here, from the deferred-refresh mechanism this batch removes).
  // L1（C0c）：紧邻上面的hashchange（切到depot那一次）已经在旧实现里构造出会被记成pending的触发——
  // 旧autoRefreshBlocked('tab')对"弹窗打开"恒返回true，会把pendingAutoRefresh记成'tab'；此刻早已过
  // 节流（本段开头已fastForward(11000)两次，距最近一次真实刷新远超10s）。加一次clock.runFor(1)让
  // 旧closeModal末尾可能的setTimeout(0)补刷有机会真正执行，再用sentinel确认零/me——不是"从来没触发
  // 过pending所以关闭自然什么都不做"这种假阴性。
  meCount=0;await ac.locator('#itlModalCancel').click();await ac.locator('#itlModal').waitFor({state:'hidden'});
  await ac.clock.runFor(1);await sentinel();
  check('关闭弹窗后不再补一次/me请求(D14 A：补刷机制已删；紧邻的hashchange已构造出旧实现会记成pending的触发，且早已过节流，确认真的没有兜底)',meCount===0);
  await ac.clock.fastForward(11000);meWait=meResponse();await ac.locator('[data-tab="all"]').click();await meWait;await waitIdle();
  await ac.locator('#itlTable [data-detail-row]').first().click();await ac.locator('#itlDrawer.open').waitFor();
  // M1（C0c，C4追加修正·codex 39，L7再订正措辞·C4b）：紧邻上面「全部资产」点击刚产生一次真实刷新，
  // 此刻仍在10秒节流窗口内——旧visibleRefreshAllowed()对`state.detailId!==null`恒返回false，派发
  // visibilitychange会被旧autoRefresh('visible')记成pendingAutoRefresh='visible'，但真正的触发点
  // 不是"时间流逝本身"，是旧closeDrawer()末尾调用flushAutoRefresh()——flushAutoRefresh 只在被调用
  // 的那一刻检查节流是否已过，过了才真的发/me；fastForward(11000) 单独发生在抽屉仍开着时不会触发
  // 任何刷新（旧机制没有"过了节流就自动补发"这回事，必须等到 closeDrawer 这个调用点）。所以顺序是：
  // 先fastForward推过节流(:185)——保证"轮到 closeDrawer 检查时"节流条件已满足，再关抽屉(:186)——
  // 这一步才是旧机制里 flushAutoRefresh 真正被调用、发出/me的那个时间点，再 runFor(1) 让
  // closeDrawer 末尾可能的 setTimeout(0) 有机会真正跑完，最后 sentinel 确认零/me。直接断言零/me
  // （不做这套铺垫）会把"节流本身还没过"和"补刷机制已删"两种情况混成假绿。
  await setVisibility('visible');
  await ac.clock.fastForward(11000);
  meCount=0;await ac.locator('#itlDrawerClose').click();await ac.locator('#itlDrawer').waitFor({state:'hidden'});
  await ac.clock.runFor(1);await sentinel();
  check('关闭抽屉后不再补一次/me请求(D14 A：补刷机制已删；旧机制的触发点是closeDrawer本身,此刻节流已过,若补刷仍在会在这一步真实发出/me)',meCount===0);
  // M3（C0c）：正向用例守住 notice('')（it-ledger.js:141）——上面几条反向用例全部走"零/me"分支，从
  // 来没有真的执行到 autoRefresh() 里 notice('') 这一行；如果这行被删掉，前面的用例不会变红。这里
  // 反过来构造一次会真正刷新的场景，证明刷新确实清空了过期提示。
  await ac.clock.fastForward(11000);meCount=0;meWait=meResponse();
  await ac.evaluate(()=>ITLedger.notice('过期提示2'));
  await ac.locator('[data-tab="racks"]').click();await meWait;await waitIdle();
  check('过节流切页签真实刷新时产生恰1次/me请求',meCount===1);
  check('过节流切页签真实刷新清除过期提示(notice(\'\')生效,M3)',await ac.locator('#itlNotice').isHidden());
  // 10e) An edited form in the view being left behind does not block the tab switch's refresh.
  await ac.evaluate(()=>{const form=document.createElement('form');form.dataset.autoRefreshOld='1';form.innerHTML='<input name="old" value="">';document.getElementById('itlContent').appendChild(form);});
  await ac.locator('#itlContent form[data-auto-refresh-old] [name="old"]').fill('dirty');
  await ac.clock.fastForward(11000);meCount=0;meWait=meResponse();
  await ac.locator('[data-tab="depot"]').click();await meWait;await waitIdle();
  check('离开页签的未保存表单不阻断切页签刷新',meCount===1);
  // 10f) A refresh that fails after the login changed mid-request must not render the previous account's cache.
  {
    let releaseMe;const held=new Promise(r=>{releaseMe=r;});
    const holdMe=async route=>{await held;await route.abort();};
    await ac.route('**/api/it-assets/me',holdMe,{times:1});
    const meSent=ac.waitForRequest(r=>r.url().endsWith('/api/it-assets/me'));
    await ac.evaluate(()=>{ITLedger.refresh();});await meSent;
    await ac.evaluate(()=>localStorage.setItem('token','fixture-3'));
    const failed=ac.waitForEvent('requestfailed',r=>r.url().endsWith('/api/it-assets/me'));releaseMe();await failed;await sentinel();
    check('刷新中登录变化不回退渲染旧账号缓存',await ac.locator('#itlContent #itlTable, #itlContent .itl-depot, #itlContent .itl-card').count()===0&&(await ac.locator('#itlNotice').innerText()).includes('登录状态已变化'));
    await ac.evaluate(()=>localStorage.setItem('token','fixture-1'));
  }
  // 10g) A superseded refresh that fails late must not put an error notice over the newer refresh's result.
  {
    await ac.evaluate(()=>{ITLedger.notice('');});
    let releaseOld;const held=new Promise(r=>{releaseOld=r;});
    await ac.route('**/api/it-assets/me',async route=>{await held;await route.abort();},{times:1});
    const oldSent=ac.waitForRequest(r=>r.url().endsWith('/api/it-assets/me'));
    await ac.evaluate(()=>{ITLedger.refresh();});await oldSent;
    await ac.evaluate(()=>ITLedger.refresh());
    const failed=ac.waitForEvent('requestfailed',r=>r.url().endsWith('/api/it-assets/me'));releaseOld();await failed;await sentinel();
    check('被取代的旧刷新晚到失败不显示错误提示',await ac.locator('#itlNotice').isHidden());
  }
  // 11) Static check: every old "请刷新..." phrasing is gone from source and its replacement is present.
  const jsDir=path.join(__dirname,'../public/assets/js');const src=name=>fs.readFileSync(path.join(jsDir,name),'utf8');
  const textPairs=[
    {file:'it-ledger.js',oldText:'访问权限已变化，请刷新页面。',newText:'访问权限已变化，请重新打开页面。'},
    {file:'it-ledger.js',oldText:'请刷新核对后再决定是否重试。',newText:'请重新打开页面核对后再决定是否重试。'},
    {file:'it-ledger.js',oldText:'访问权限已变化。请刷新重新核验。',newText:null},
    {file:'it-ledger.js',oldText:'登录状态已变化，请刷新重新核验。',newText:'登录状态已变化，请重新打开页面。'},
    {file:'it-ledger.js',oldText:null,newText:"INSPECTION_PHASE_CHANGED: '巡检提交状态已变化，已更新为最新状态，请重新上传。'"},
    {file:'it-ledger-disks.js',oldText:'装载关系已变化，请刷新后重选。',newText:'装载关系已变化，已更新为最新数据，请重新选择。'},
    {file:'it-ledger-disks.js',oldText:'刷新页面后重新选择两台机器即可查看下一步。',newText:'重新打开页面后再选择两台机器即可查看下一步。'},
    {file:'it-ledger-evidence.js',oldText:'附件读取失败，请刷新核验权限',newText:'附件读取失败，请稍后重试。'},
    {file:'it-ledger-evidence.js',oldText:null,newText:'访问权限已变化，请重新打开页面。'},
    {file:'it-ledger-racks.js',oldText:'机柜已不存在，请刷新选择。',newText:'机柜已不存在，已更新为最新数据，请重新选择。'},
    {file:'it-ledger-racks.js',oldText:'机柜已不存在，请刷新列表。',newText:'机柜已不存在，已更新为最新数据。'},
    {file:'it-ledger-racks.js',oldText:'请关闭窗口',newText:null},
    {file:'it-ledger-racks.js',oldText:'设备位置已变化，请刷新后重新定位。',newText:'设备位置已变化，已更新为最新数据，请重新定位。'},
    {file:'it-ledger-aps.js',oldText:'AP位置已变化或已拆下，请刷新后重新定位。',newText:'AP位置已变化或已拆下，已更新为最新数据，请重新定位。'},
    {file:'it-ledger-inspections.js',oldText:'id="itlReloadInspections"',newText:null},
  ];
  const staticOk=textPairs.every(({file,oldText,newText})=>{const body=src(file);return (oldText===null||!body.includes(oldText))&&(newText===null||body.includes(newText));});
  check('刷新类提示文案静态替换到位',staticOk);
  errors.push(...acErrors);await acContext.close();
  check('无浏览器异常',errors.length===0);fs.writeFileSync(path.join(f.dir,'workspace-result.json'),JSON.stringify({pass,errors},null,2));console.log(`WORKSPACE_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
