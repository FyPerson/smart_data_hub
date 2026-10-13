/* Information ledger common UI. Business contract unchanged; workspace UI: v0.9 §8. */
/* Refresh has no button: it triggers automatically on a tab switch only, throttled to once per 10s; an open modal
 * or a busy submit skips it, falling back to setTab's cache render (plan v0.5 §6.1, D14 decision A — C0b). Window re-visibility
 * refresh and the deferred "flush on modal/drawer close" mechanism were removed: rebuilding the view and drawer
 * on an unrelated trigger (tab focus) can stomp in-progress work; codex 34 / 34-R and the Opus prescreen found the
 * same HIGH three rounds running, so the user kept only the tab-switch trigger. */
(function () {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const businessTypes = window.ITAssetTypes;
  const categories = { server: '服务器', disk: '硬盘', laptop: '笔记本', desktop: '台式机', ap: '无线 AP', other: '其他设备', software: '软件', subscription: '订阅' };
  const statuses = { in_service: '在用', in_depot: '库房', faulty: '故障', to_retire: '待报废', retired: '已报废', active: '有效', cancelled: '已停用' };
  const statusClasses = { in_service: 'sem-active', in_depot: 'sem-staging', faulty: 'sem-failed', to_retire: 'sem-hold', retired: 'sem-archived', active: 'sem-active', cancelled: 'sem-voided' };
  // All-assets table (codex 50, plan D): category | asset (brand + model, name as sub-line) | purpose / extra info | status | SN.
  // Sortable keys are the columns themselves; the restore whitelist is derived from this list, never kept as a second copy.
  const subtypeLabels = { switch: '交换机', security: '安全设备', storage: '存储', printer: '打印机', ups: 'UPS' };
  const nameFlags = { 采集告警: 'alert', 暂定: 'tentative' };
  const allColumns = [['category', '类别'], ['asset_label', '资产'], ['purpose_label', '用途'], ['status', '状态'], ['sn', '序列号']];
  const actionNames = { register: '登记', update: '编辑资料', rack_in: '上架', rack_out: '下架', rack_move: '迁柜', rack_relocate: '柜内移位', mark_status: '调整库房状态', retire: '报废', disk_mount: '装盘', disk_unmount: '拆盘', disk_swap: '换盘', disk_move: '移盘', assign: '领用', reassign: '更换保管人', return: '归还', place: '放置', relocate: '移动位置', ap_place: '安装 AP', ap_relocate: '移动 AP', ap_unmount: '拆下 AP', renew: '续费', cancel: '停用' };
  const fields = { name: '名称', category: '类别', status: '状态', brand: '品牌', model: '型号', sn: '序列号', asset_no: '资产编号', owner_name: '责任人', owner_dept: '责任部门', asset_class: '资产分类', purchased_at: '购置日期', expires_at: '到期日期', u_height: '占用 U 数', slot_count: '盘位数', rack_id: '机柜', u_start: '起始 U', parent_asset_id: '宿主', slot_no: '盘位', custodian_name: '保管人', custodian_user_id: '保管人用户编号', location_text: '位置', floor_id: '楼层', room_id: '房间', pos: '房间内坐标', attrs: '类别属性', note: '备注', fin_amount: '购置金额', fin_vendor: '供应商', fin_contract_no: '合同编号', fin_changed: '财务字段变更', version: '版本', created_at: '登记时间', updated_at: '更新时间', disk_id: '硬盘编号' };
  const tabs = { all: '全部资产', racks: '机房', depot: '库房', aps: 'AP 房间', terminals: '终端与其他', software: '软件与订阅', stocktakes: '盘点', reconciles: '对账', inspections: '巡检' };
  const navGroups=[[null,['all']],['按位置',['racks','depot','aps']],['按类型',['terminals','software']],['核对作业',['stocktakes','reconciles','inspections']]];
  const errors = { VERSION_CONFLICT: '资料已被其他操作更新。已刷新列表，请关闭后重新打开，核对最新资料再提交。', INSPECTION_PHASE_CHANGED: '巡检提交状态已变化，已更新为最新状态，请重新上传。', LEDGER_FORBIDDEN: '访问权限已变化，请重新打开页面。', LEDGER_BUSY: '台账正忙，请稍后手动重试。', LEDGER_UNAVAILABLE: '台账暂不可用，请稍后重试。', SN_CONFLICT: '此序列号已经登记。', U_HEIGHT_LOCKED: '在架设备须先下架，才能修改占用高度。', RETIRE_BLOCKED_BY_DISKS: '设备仍有随装盘，请先逐盘拆出。', NO_OP_TRANSITION: '目标与当前状态相同，无需操作。' };
  const state = { level: null, assets: [], racks: [], floors: [], tab: 'all', search: '', category: '', status: '', listScope:'all', showAssetNo:false, showOwner:false, health:{}, healthDirty:false, detailId: null, sortBy: null, sortDir: 'desc', tablePage: 1, viewContexts: {}, scrollContexts: {}, views: {}, busy: false };
  let refreshSequence = 0, detailSequence = 0, drawerCleanupTimer, toastTimer, returnFocus, modalSubmit = null, modalBusy = false, modalStale = false, modalToken = 0;
  let lastRefreshAt = 0; const AUTO_REFRESH_MIN_MS = 10000;
  const contextKey='itl-workspace-context-v1';
  let contextOwner='',contextToken=null,contextReady=false,restoringContext=false,allSorter=null,contextFrame=0;
  function saveContext(){
    if(!contextReady||!state.level||getToken()!==contextToken)return;
    try{sessionStorage.setItem(contextKey,JSON.stringify({owner:contextOwner,tab:state.tab,search:state.search,category:state.category,status:state.status,listScope:state.listScope,showAssetNo:state.showAssetNo,showOwner:state.showOwner,sortBy:state.sortBy,sortDir:state.sortDir,tablePage:state.tablePage,viewContexts:state.viewContexts,scrollContexts:state.scrollContexts}));}catch(_){}
  }
  async function loadContext(){
    if(contextReady)return;
    contextToken=getToken();
    try{
      contextOwner=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(contextToken||'')))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const c=JSON.parse(sessionStorage.getItem(contextKey)||'null');
      if(c?.owner===contextOwner){
        if(typeof c.search==='string')state.search=c.search.slice(0,500);
        if(Object.hasOwn(businessTypes.byKey,c.category))state.category=c.category;
        state.listScope=['all','equipment','parts'].includes(c.listScope)?c.listScope:'all';state.showAssetNo=c.showAssetNo===true;state.showOwner=c.showOwner===true;
        if(Object.hasOwn(statuses,c.status))state.status=c.status;
        state.sortBy=[...allColumns,['asset_no'],['owner_name']].some(([key])=>key===c.sortBy)?c.sortBy:null;state.sortDir=c.sortDir==='asc'?'asc':'desc';
        state.tablePage=Number.isSafeInteger(c.tablePage)&&c.tablePage>0?c.tablePage:1;
        if(c.viewContexts&&typeof c.viewContexts==='object')state.viewContexts=c.viewContexts;
        if(c.scrollContexts&&typeof c.scrollContexts==='object')state.scrollContexts=c.scrollContexts;
        if(!locationHash()&&Object.hasOwn(tabs,c.tab==='inventory'?'stocktakes':c.tab))state.tab=c.tab==='inventory'?'stocktakes':c.tab;
      }else sessionStorage.removeItem(contextKey);
    }catch(_){}
    contextReady=true;
  }
  function captureContext(){
    if(restoringContext||!state.level)return;
    if(state.tab==='all'&&allSorter&&$('#itlTable')){const c=allSorter.getState();state.sortBy=c.sortBy;state.sortDir=c.sortDir;state.tablePage=c.page;}
    state.scrollContexts[state.tab]={y:window.scrollY,x:$('#itlContent .u-corr-table-wrap')?.scrollLeft||0};saveContext();
  }
  function restoreContext(){
    const c=state.scrollContexts[state.tab];cancelAnimationFrame(contextFrame);restoringContext=true;
    contextFrame=requestAnimationFrame(()=>{if(c){window.scrollTo({top:Number.isFinite(c.y)?c.y:0,behavior:'instant'});const el=$('#itlContent .u-corr-table-wrap');if(el)el.scrollLeft=Number.isFinite(c.x)?c.x:0;}restoringContext=false;saveContext();});
  }
  function rememberView(key,value){state.viewContexts[key]=value;saveContext();}
  const viewContext=key=>state.viewContexts[key]||{};
  function canLocate(a){return !!(a.rack_id||a.category==='ap'&&a.floor_id&&a.room_id);}
  function locateButton(a){return canLocate(a)?`<button type="button" class="itl-link" data-locate="${a.id}">定位设备</button>`:'';}
  async function locateAsset(id){
    if(!state.level)return;
    try{const {asset}=await api('/'+id);if(asset.rack_id){await ITLedger.locateRackAsset(asset);}else if(asset.category==='ap'&&asset.floor_id&&asset.room_id){await ITLedger.locateAPAsset(asset);}else notice('当前资产没有可定位的机柜或房间位置。');}catch(error){notice(error.message);}
  }
  const canWrite = () => state.level === 'admin' || state.level === 'write';
  const isAdmin = () => state.level === 'admin';
  const badge = status => UnifyHelpers.statusBadgeByMap(status, statusClasses, statuses[status] || status);
  const type = category => Object.hasOwn(categories, category) ? UnifyHelpers.typeTag(category, categories[category]) : esc(category);
  function toast(message) { $('#itlToast').textContent = message; $('#itlToast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#itlToast').hidden = true; }, 4500); }
  function notice(message) { $('#itlNotice').textContent = message; $('#itlNotice').hidden = !message; }
  function clearData() {
    contextReady=false;contextOwner='';contextToken=null;allSorter=null;state.search='';state.category='';state.status='';state.sortBy=null;state.sortDir='desc';state.tablePage=1;state.listScope='all';state.showAssetNo=false;state.showOwner=false;state.viewContexts={};state.scrollContexts={};cancelAnimationFrame(contextFrame);restoringContext=false;try{sessionStorage.removeItem(contextKey);}catch(_){}
    refreshSequence++; detailSequence++; state.assets = []; state.health = {}; state.healthDirty=false; state.racks = []; state.floors = [];
    Object.values(state.views).forEach(view => { if (view.onAccessLost) view.onAccessLost(); });
    closeModal(true); closeDrawer(); $('#itlDrawerBody').replaceChildren(); $('#itlContent').replaceChildren(); $('#itlContent').removeAttribute('aria-busy');
  }
  function resetAccessUI(text) {
    state.level = null; clearData();
    $('#itlAccess').textContent = text;
    $('#itlRegister').hidden = true; $('#itlTabs').hidden = true;
  }
  // codex 48 H-1：同一账号同一轮失权只写一次「访问权限已变化」短提示——之后陆续返回的 403（如设备明细预取）
  // 不再覆盖视图已给出的未保存原文全文提示。权限恢复（state.level 重新非空）或换号后重新计。
  let accessLostNoticeToken = null;
  async function api(path = '', options = {}) {
    const token = getToken();
    let response;
    try { response = await authFetch('/api/it-assets' + path, { ...options, headers: { ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
    catch (_) { throw Object.assign(new Error('网络异常，未能确认操作结果。请重新打开页面核对后再决定是否重试。'), { code: 'NETWORK' }); }
    // Claude 复核 49 M-3：两种 401 分开标记——authFetch 收到服务端真 401 会登出并返回 null（服务端已明确拒绝，
    // AUTH_REJECTED）；响应已到而本地换了号（请求已发出、结果未知，IDENTITY_CHANGED_IN_FLIGHT）。文案不变。
    if (!response) throw Object.assign(new Error('登录状态已变化。'), { status: 401, code: 'AUTH_REJECTED' });
    if (token !== getToken()) throw Object.assign(new Error('登录状态已变化。'), { status: 401, code: 'IDENTITY_CHANGED_IN_FLIGHT' });
    const serverTime = Date.parse(response.headers.get('Date'));
    if (Number.isFinite(serverTime)) state.serverTime = serverTime;
    const body = await response.json().catch(() => ({}));
    // codex 48 H-4：响应体读取期间可能换号——旧账号的响应（尤其 403）不得清空新账号界面或被当成新会话失权。
    if (token !== getToken()) throw Object.assign(new Error('登录状态已变化。'), { status: 401, code: 'IDENTITY_CHANGED_IN_FLIGHT' });
    if (!response.ok) {
      if (response.status === 403) {
        const repeat = state.level === null && accessLostNoticeToken === token;
        accessLostNoticeToken = token; resetAccessUI('尚未获准访问');
        if (!repeat) notice('访问权限已变化，请重新打开页面。');
      }
      throw Object.assign(new Error(errors[body.code] || body.message || body.error || `请求失败（${response.status}）`), body, { message: errors[body.code] || body.message || body.error || `请求失败（${response.status}）`, status: response.status });
    }
    if(path.startsWith('/inspections/sheets')&&['POST','PUT','DELETE'].includes(String(options.method||'GET').toUpperCase()))state.healthDirty=true;
    return body;
  }
  // capture=false: a tab switch refreshes before the new view has rendered, so the scroll position on screen still
  // belongs to the previous tab and must not be saved under the new one.
  async function refresh({ capture = true } = {}) {
    lastRefreshAt = performance.now();
    if(contextReady&&getToken()!==contextToken){resetAccessUI('尚未获准访问');}
    if (capture) captureContext();
    const refreshToken=getToken();
    const seq = ++refreshSequence;
    // aria-busy marks an in-flight refresh (assistive tech, and browser suites wait on it instead of forcing a refresh).
    $('#itlContent').setAttribute('aria-busy', 'true');
    try {
      const permission = await api('/me');
      if (seq !== refreshSequence) return;
      if (!['admin', 'write', 'read'].includes(permission.level)) {
        resetAccessUI('尚未获准访问'); $('#itlContent').innerHTML = '<div class="itl-empty">当前账号没有台账权限，请联系管理员。</div>'; return;
      }
      if (state.level && state.level !== permission.level) { closeModal(true); closeDrawer(); $('#itlDrawerBody').replaceChildren(); }
      await loadContext();if(seq!==refreshSequence)return;
      if(refreshToken!==getToken()){resetAccessUI('尚未获准访问');notice('登录状态已变化，请重新打开页面。');return;}
      state.level = permission.level;
      const [assets, racks, floors] = await Promise.all([api(), api('/racks'), api('/floors')]);
      if (seq !== refreshSequence) return;
      if(refreshToken!==getToken()){resetAccessUI('尚未获准访问');notice('登录状态已变化，请重新打开页面。');return;}
      state.assets = assets.items; state.health = assets.health||{}; state.healthDirty=false; state.racks = racks.items; state.floors = floors.items;
      state.expiringCount = permission.expiring_count;
      $('#itlAccess').textContent = `台账共 ${state.assets.length} 项${{ admin: '', write: ' · 可登记与维护', read: ' · 只读查阅' }[state.level]}`;
      $('#itlRegister').hidden = !canWrite(); $('#itlTabs').hidden = false; renderTabs(); render();
      Object.values(state.views).forEach(view => { if (view.onRefresh) view.onRefresh(); });
      if (state.detailId !== null) { if (state.assets.some(a => a.id === state.detailId)) detail(state.detailId, false); else closeDrawer(); }
    } catch (error) {
      // A superseded refresh must not report its late failure over the newer one's result.
      if (seq !== refreshSequence) return;
      // The login changed mid-request: the cache belongs to the previous account, so drop it instead of rendering it.
      if (refreshToken !== getToken()) { resetAccessUI('尚未获准访问'); notice('登录状态已变化，请重新打开页面。'); return; }
      notice(error.message);
      // A tab switch shows a placeholder until this refresh renders; on failure fall back to the cached view.
      if (state.level) render();
    }
    finally { if (seq === refreshSequence) $('#itlContent').removeAttribute('aria-busy'); }
  }
  // A refresh rebuilds the current view, the drawer and any overlay, dropping work in progress there (an upload
  // mid-way, a typed description, a placement checkbox, a stocktake or reconcile context). A tab switch has
  // already left that work behind, so it is the only trigger left (C0b, plan v0.5 §6.1 D14 decision A): an open
  // modal or a busy submit skips it — setTab falls back to a cache render; nothing is queued for later.
  // Returns true when a refresh started.
  function autoRefresh() {
    if ($('#itlModal').classList.contains('open') || modalBusy) return false;
    if (performance.now() - lastRefreshAt < AUTO_REFRESH_MIN_MS && !(state.tab==='all'&&state.healthDirty)) return false;
    notice(''); refresh({ capture: false }); return true;
  }
  // One primary action per screen: in work views (stocktakes, reconciles, room inspection) the view's own action leads.
  function syncHeaderEmphasis() { const work=['stocktakes','reconciles','inspections'].includes(state.tab); const b=$('#itlRegister'); b.classList.toggle('u-btn-primary',!work); b.classList.toggle('u-btn-secondary',work); }
  function renderTabs() {
    syncHeaderEmphasis();
    $('#itlViewTitle').textContent = tabs[state.tab];
    const paths={all:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',racks:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M7 7h10M7 12h10M7 17h10"/>',depot:'<path d="m3 9 9-6 9 6v11H3z"/><path d="M3 10h18M9 20v-7h6v7"/>',aps:'<path d="M3 9a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 15a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r="1"/>',terminals:'<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',software:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-3 2 3 2m6-4 3 2-3 2"/>',stocktakes:'<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 3h6M8 10h8M8 15h5"/>',reconciles:'<path d="M4 7h15l-3-3m3 3-3 3M20 17H5l3-3m-3 3 3 3"/>',inspections:'<path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2.5" width="6" height="3" rx="1"/><path d="m9 13 2 2 4-4"/>'};
    const button=key=>`<button type="button" data-tab="${key}"${state.tab===key?' aria-current="page"':''}><svg class="itl-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]}</svg><span>${tabs[key]}</span>${key==='software'&&state.expiringCount?`<span class="itl-nav-count">${esc(state.expiringCount)}</span>`:''}</button>`;
    $('#itlTabs').innerHTML=navGroups.map(([label,keys])=>`<div class="itl-nav-group">${label?`<div class="itl-nav-group-label">${label}</div>`:''}${keys.map(button).join('')}</div>`).join('');
    // Narrow screens flatten the groups into one scrolling row: keep the current view visible (horizontal scroll of the nav only).
    const nav=$('#itlTabs'),current=nav.querySelector('[aria-current="page"]');if(current&&nav.scrollWidth>nav.clientWidth){const n=nav.getBoundingClientRect(),c=current.getBoundingClientRect();nav.scrollLeft=Math.max(0,nav.scrollLeft+(c.left-n.left)-(n.width-c.width)/2);}
  }
  // 方案 v0.5 §6.1 末条：切页签前先给旧视图一次冲刷机会（巡检单填写页借此把写队列冲刷掉）——同步调用，
  // 不等它的返回值，视图自己的队列在后台继续发送，不阻塞本次切换。C5a-c：同页签重复点击（转换别名之后
  // 的 tab 与 state.tab 相同）不再调用 onLeave（不是"离开"，不该触发离开语义）；onLeave 本身包 try/catch
  // ——任何视图的 onLeave 抛错都只 console.warn，不挡住这次页签切换。
  function setTab(tab) { if(tab==='inventory')tab='stocktakes';if (!Object.hasOwn(tabs, tab)) return; captureContext();closeDrawer();if(tab!==state.tab){try{state.views[state.tab]?.onLeave?.();}catch(e){console.warn('onLeave failed',e);}}state.tab = tab; history.replaceState(null, '', '#'+tab); renderTabs();
    // Render from cache only when no refresh is starting: the refresh renders the view itself once data arrives.
    if (autoRefresh()) $('#itlContent').innerHTML = '<div class="itl-empty">正在读取…</div>'; else render(); }
  function location(asset) {
    if(asset.category==='laptop')return asset.custodian_name||(asset.custodian_user_id?'用户 #'+asset.custodian_user_id:asset.status==='in_service'?'保管人未填写':'未领用');
    if (asset.parent_asset_id) { const host = state.assets.find(a => a.id === asset.parent_asset_id); return `${host?.name || '宿主 #'+asset.parent_asset_id} · 盘位 ${asset.slot_no}`; }
    if (asset.rack_id) { const rack = state.racks.find(r => r.id === asset.rack_id); return `${rack?.name || '机柜 #'+asset.rack_id} · U${asset.u_start}–${asset.u_start + asset.u_height - 1}`; }
    if (asset.floor_id) { const floor = state.floors.find(f => f.id === asset.floor_id); return `${floor?.name || asset.floor_id} · ${floor?.rooms?.find(r => r.id === asset.room_id)?.name || asset.room_id}`; }
    if(asset.category==='software')return String(asset.attrs?.installed_on||'安装位置未填写');
    if(asset.category==='subscription')return '不适用';
    return [asset.custodian_name, asset.location_text].filter(Boolean).join(' · ') || (asset.status==='in_depot'?'位置待确认':(['software','subscription'].includes(asset.category)?'使用范围未填写':'位置未登记'));
  }
  const children = asset => state.assets.filter(a => a.parent_asset_id === asset.id);
  function assetButton(asset) { return `<button type="button" class="itl-link itl-card-name" data-detail="${asset.id}">${esc(asset.name)}</button>`; }
  // ── All-assets table cells (codex 50) ──
  const modelLabel = a => [a.brand, a.model].filter(Boolean).join(' ');
  const ipOf = a => a.attrs?.ip || a.attrs?.mgmt_ip || '';
  // Own keys only: a free-text sub-type such as "constructor" must not resolve to an Object prototype member (codex 52 M-1).
  const subtypeLabel = a => businessTypes.kind(a);
  // Known leading markers in the free-text name (e.g. 【采集告警】) become text tags so they stay visible when the name
  // drops to the sub-line; unknown 【…】 text stays in the name untouched.
  function nameParts(name) {
    let rest = String(name ?? ''); const flags = []; let m;
    while ((m = /^【([^】]+)】/.exec(rest)) && Object.hasOwn(nameFlags, m[1])) { flags.push(m[1]); rest = rest.slice(m[0].length); }
    return { flags, rest };
  }
  // Per-category extra information: structured fields only, never parsed out of free-text notes.
  function purposeInfo(a) { return {main:a.attrs?.purpose==null?'':String(a.attrs.purpose),sub:ipOf(a)}; }
  function listRow(a) {
    // A name made only of markers leaves nothing to show once they become tags; the accessible name keeps the raw name (codex 52 L-1).
    const info = purposeInfo(a), { flags, rest } = nameParts(a.name), label = modelLabel(a) || rest || '未命名资产';
    return { ...a, asset_label: label, purpose_label: [info.main, info.sub].filter(Boolean).join(' '), _info: info, _flags: flags, _rest: rest };
  }
  function categoryCell(a) { const sub = subtypeLabel(a); return esc(businessTypes.label(a)) + (sub ? `<div class="itl-cell-sub">${esc(sub)}</div>` : ''); }
  function assetCell(r) {
    const purpose = r.attrs?.purpose || '', ip = ipOf(r);
    // The sub-line repeats nothing: the name is hidden only when it is empty or exactly the label, the purpose, or "purpose IP".
    const redundant = !r._rest || [r.asset_label, purpose, `${purpose} ${ip}`.trim()].includes(r._rest);
    const tags = r._flags.filter(f=>f!=='采集告警').map(f => `<span class="itl-flag itl-flag-${nameFlags[f]}">${esc(f)}</span>`).join('');
    return `<div class="itl-cell-main"><button type="button" class="itl-link itl-card-name" data-detail="${r.id}" aria-label="${esc(r.name)}">${esc(r.asset_label)}</button>${healthCell(r)}${tags}</div>${redundant ? '' : `<div class="itl-cell-sub">${esc(r._rest)}</div>`}`;
  }
  function purposeCell(r) { return `${r._info.main ? esc(r._info.main) : (r._info.sub ? '' : '—')}${r._info.sub ? `<div class="itl-cell-sub">${esc(r._info.sub)}</div>` : ''}`; }
  function menu(asset) {
    if (!canWrite()) return '';
    const actions = [{ key: 'edit', label: '编辑资料' }];
    if (['in_depot','faulty','to_retire'].includes(asset.status) && !asset.parent_asset_id) {
      actions.push({ key: 'mark_status', label: '调整库房状态' });
      if (asset.status === 'to_retire' && !children(asset).length) actions.push({ key: 'retire', label: '确认报废' });
    }
    Object.values(state.views).forEach(view => { if (view.actions) actions.push(...view.actions(asset)); });
    return `<details class="itl-menu"><summary aria-label="${esc(asset.name)}的操作">⋯</summary><div class="itl-menu-panel">${actions.map(a => `<button type="button" data-action="${esc(a.key)}" data-id="${asset.id}">${esc(a.label)}</button>`).join('')}</div></details>`;
  }
  const categoryIcons={laptop:'<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',desktop:'<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',server:'<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',disk:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',ap:'<path d="M3 9a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 15a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r="1"/>',other:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',software:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-3 2 3 2m6-4 3 2-3 2"/>',subscription:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h4"/>'};
  // Asset card: the category is the heading so the device type is recognisable at a glance; the name stays the detail button.
  function assetCard(asset,{rows=[],extra='',actions=''}={}) {
    return `<article class="itl-card itl-asset-card"><div class="itl-card-top"><span class="itl-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${categoryIcons[asset.category]||categoryIcons.other}</svg></span><div class="itl-card-id"><div class="itl-card-kind">${esc(categories[asset.category]||asset.category)}${badge(asset.status)}</div>${assetButton(asset)}</div>${menu(asset)}</div>${rows.length?`<dl class="itl-card-rows">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v||'—')}</dd>`).join('')}</dl>`:''}${extra}${actions?`<div class="itl-actions">${actions}</div>`:''}</article>`;
  }
  function renderDepot() {
    $('#itlContent').innerHTML = `<div class="itl-depot">${['in_depot','faulty','to_retire'].map(status => {
      const assets = state.assets.filter(a => a.status === status && !a.parent_asset_id);
      return `<section class="itl-lane"><h2>${statuses[status]}<span>${assets.length} 件</span></h2>${assets.length ? assets.map(asset => {
        const disks = children(asset);
        return assetCard(asset,{rows:[['型号',[asset.brand,asset.model].filter(Boolean).join(' ')],['SN',asset.sn]],extra:disks.length ? `<details class="itl-children"><summary>随机 ${disks.length} 盘</summary><ul>${disks.map(d => `<li>盘位 ${d.slot_no} · ${assetButton(d)}</li>`).join('')}</ul></details>` : ''});
      }).join('') : `<div class="itl-empty">暂无${statuses[status]}设备</div>`}</section>`;
    }).join('')}</div>`;
  }
  function locationIntent(a) {
    if(!canWrite()||a.record_inactive||['retired','cancelled'].includes(a.status))return null;
    if(a.category==='software')return {key:'edit',label:'编辑安装位置'};
    if(a.category==='subscription')return null;
    if(a.category==='disk'){
      if(a.parent_asset_id){const host=state.assets.find(h=>h.id===a.parent_asset_id);return host&&host.u_height>0&&host.slot_count>0&&['in_service','in_depot','faulty','to_retire'].includes(host.status)?{key:'disk_positions',label:'管理盘位'}:null;}
      return a.status==='in_depot'?{key:'disk_mount',label:'装盘定位'}:null;
    }
    if(a.category==='server'||a.category==='other'&&a.u_height>0)return a.status==='in_depot'?{key:'rack_in',label:'上架设置位置'}:a.status==='in_service'&&a.rack_id?{key:'rack_position',label:'编辑机柜位置'}:null;
    if(a.category==='ap')return a.status==='in_depot'?{key:'ap_place',label:'安装定位'}:a.status==='in_service'?{key:'ap_relocate',label:'编辑安装位置'}:null;
    if(a.category==='laptop')return null;
    if(a.category==='desktop')return a.status==='in_depot'?{key:'assign',label:'领用并设置位置'}:a.status==='in_service'?{key:'relocate',label:'编辑位置'}:null;
    if(a.category==='other'&&a.u_height===0)return a.status==='in_depot'?{key:'place',label:'设置位置'}:a.status==='in_service'?{key:'relocate',label:'编辑位置'}:null;
    return null;
  }
  function locationEditButton(a){const intent=locationIntent(a);return intent?'<button type="button" class="itl-link" data-action="edit_location" data-id="'+a.id+'" aria-label="'+esc(a.name+'：'+intent.label)+'">'+esc(intent.label)+'</button>':'';}
  function custodyButtons(a){
    if(a.category!=='laptop'||!canWrite()||a.record_inactive)return '';
    const actions=a.status==='in_depot'?[['assign','领用']]:a.status==='in_service'?[['reassign','换保管人'],['return','归还']]:[];
    return actions.map(([key,label])=>'<button type="button" class="itl-link" data-action="'+key+'" data-id="'+a.id+'">'+label+'</button>').join('');
  }
  function healthCell(asset) {
    const h=state.health[asset.id];if(!h)return '';
    const at=h.observed_at?new Date(h.observed_at).toLocaleString('zh-CN',{hour12:false}):'时间未记录';
    if(!h.kind)return '<div class="itl-health-meta">'+esc(h.collection_status==='failed'?'采集失败 · 未形成结论':'部分采集 · 未形成结论')+'</div>';
    const later=h.latest_attempt&&h.latest_attempt.id!==h.source_inspection_id;
    const hint=[at,h.confirmed?'运维已判断':'待运维判断',later?'本次采集'+(h.latest_attempt.status==='failed'?'失败':'不完整'):''].filter(Boolean).join(' · ');
    const reason=[h.reason,h.evidence,'巡检时间：'+at].filter(Boolean).join('；');
    return '<span class="itl-health-badge itl-health-'+esc(h.kind)+'" title="'+esc(reason)+'">● '+esc(h.label)+'</span><div class="itl-health-meta">'+esc(hint)+'</div>';
  }
  function visibleAllColumns(){return [...allColumns,...(state.showAssetNo?[['asset_no','资产编号']]:[]),...(state.showOwner?[['owner_name','责任人']]:[])];}
  function businessOptions(selected){return '<option value="">全部类别</option>'+[...new Set(businessTypes.entries.map(e=>e.group))].map(group=>'<optgroup label="'+esc(group)+'">'+businessTypes.entries.filter(e=>e.group===group).map(e=>'<option value="'+e.key+'"'+(e.key===selected?' selected':'')+'>'+e.label+'</option>').join('')+'</optgroup>').join('');}
  function renderAll() {
    const columns=visibleAllColumns();
    $('#itlContent').innerHTML='<div class="itl-list-scopes" role="group" aria-label="资产范围">'+[['all','全部资产'],['equipment','整机与设备'],['parts','硬盘与部件']].map(([k,l])=>'<button type="button" data-list-scope="'+k+'" aria-pressed="'+(state.listScope===k)+'">'+l+'</button>').join('')+'</div><div class="u-filter-bar itl-toolbar"><label class="itl-list-search">搜索 <input id="itlSearch" type="search" value="'+esc(state.search)+'" placeholder="名称、型号、IP、序列号、编号、责任人"></label><label>类别 <select id="itlCategory">'+businessOptions(state.category)+'</select></label><label>状态 <select id="itlStatus"><option value="">全部状态</option>'+Object.entries(statuses).map(([k,v])=>'<option value="'+k+'"'+(k===state.status?' selected':'')+'>'+v+'</option>').join('')+'</select></label>'+ITLedger.recordScopeControl('active')+'<button type="button" class="u-btn-secondary" id="itlResetFilters">重置筛选</button></div><div class="itl-list-options"><span id="itlResultCount"></span><div><label><input type="checkbox" id="itlShowAssetNo"'+(state.showAssetNo?' checked':'')+'>资产编号</label><label><input type="checkbox" id="itlShowOwner"'+(state.showOwner?' checked':'')+'>责任人</label></div></div><div class="u-corr-table-wrap"><table id="itlTable" class="u-corr-table itl-table-compact"><thead><tr><th class="itl-sequence">序号</th>'+columns.map(([key,label])=>'<th class="u-sortable" data-sort-by="'+key+'">'+label+'<span class="u-sort-icon">⇅</span></th>').join('')+'<th>位置 / 保管人</th><th>操作</th></tr></thead><tbody></tbody></table></div><div class="itl-table-footer"><div id="itlPager" class="u-pagination"></div></div>';
    let count=0;
    const sorter=UnifyHelpers.attachTableSort({tableSelector:'#itlTable',fieldTypes: { id: 'number', category:'string',asset_label:'string',purpose_label:'string',status:'labelMap',sn:'string',asset_no:'string',owner_name:'string'},labelMaps:{status:statuses},defaultSort: { field: 'id', dir: 'desc' },pagination:{containerSelector:'#itlPager',pageSize:25},getList:()=>{
      const q=state.search.trim().toLowerCase();const rows=state.assets.filter(a=>(!state.category||businessTypes.key(a)===state.category)&&(!state.status||a.status===state.status)&&(state.listScope==='all'||(state.listScope==='parts'?a.category==='disk':!['disk','software','subscription'].includes(a.category)))).map(a=>{const row=listRow(a);row._category=a.category;row.category=businessTypes.label(a);return row;}).filter(r=>!q||[r.name,r.brand,r.model,r.asset_label,r.purpose_label,r.sn,r.asset_no,r.owner_name,r.owner_dept,r.attrs?.subtype,r.attrs?.device_type,r.category,subtypeLabel({...r,category:r._category})].some(v=>String(v??'').toLowerCase().includes(q)));count=rows.length;return rows;
    },render:rows=>{
      const paging=sorter.pager.getState();const rowStart=(paging.page-1)*paging.pageSize;
      $('#itlResultCount').textContent='显示 '+count+' / '+state.assets.length+' 项'+(state.listScope==='equipment'?' · 不含硬盘、软件与订阅':'');
      $('#itlTable tbody').innerHTML=rows.length?rows.map((r,index)=>{const a={...r,category:r._category};return '<tr data-detail-row="'+r.id+'" tabindex="0" aria-label="查看'+esc(r.name)+'"><td class="itl-sequence">'+(rowStart+index+1)+'</td><td>'+categoryCell(a)+'</td><td>'+assetCell(a)+'</td><td>'+purposeCell(r)+'</td><td>'+badge(r.status)+'</td><td>'+esc(r.sn||'—')+'</td>'+(state.showAssetNo?'<td>'+esc(r.asset_no||'—')+'</td>':'')+(state.showOwner?'<td>'+esc(r.owner_name||'未填写')+'</td>':'')+'<td>'+esc(location(a))+'<div class="itl-locate-entry">'+locateButton(a)+locationEditButton(a)+custodyButtons(a)+'</div></td><td>'+(canWrite()?'<button type="button" class="itl-link" data-action="edit" data-id="'+r.id+'">编辑</button>':'—')+'</td></tr>';}).join(''):'<tr><td colspan="'+(columns.length+3)+'" class="itl-empty">没有符合条件的资产</td></tr>';
    }});
    const restorePage=state.tablePage;sorter.init();const sortTh=state.sortBy?$('#itlTable th[data-sort-by="'+state.sortBy+'"]'):null;if(sortTh){sortTh.click();if(state.sortDir==='asc')sortTh.click();}else{state.sortBy=null;sorter.render();}sorter.pager.goToPage(restorePage);allSorter=sorter;state.tablePage=sorter.getState().page;
    $('#itlTable').addEventListener('click',e=>{if(e.target.closest('[data-sort-by]'))captureContext();});$('#itlPager').addEventListener('click',captureContext);
    [['#itlSearch','search','input'],['#itlCategory','category','change'],['#itlStatus','status','change']].forEach(([selector,key,event])=>$(selector).addEventListener(event,e=>{state[key]=e.target.value;state.tablePage=1;sorter.pager.goToPage(1);sorter.render();captureContext();}));
    document.querySelectorAll('[data-list-scope]').forEach(b=>b.onclick=()=>{state.listScope=b.dataset.listScope;state.tablePage=1;renderAll();captureContext();});
    [['#itlShowAssetNo','showAssetNo'],['#itlShowOwner','showOwner']].forEach(([selector,key])=>$(selector).onchange=e=>{captureContext();state[key]=e.target.checked;renderAll();captureContext();});
    $('#itlResetFilters').onclick=()=>{state.search='';state.category='';state.status='';state.tablePage=1;renderAll();captureContext();};
  }
  function render() {
    if (!state.level) return;
    try {
    if (state.views[state.tab]) return state.views[state.tab].render();
    if (state.tab === 'depot') return renderDepot();
    if (state.tab === 'all') return renderAll();
    console.error('[ITLedger] view failed to load:', state.tab);
    $('#itlContent').innerHTML = '<div class="itl-empty">该视图加载失败，请刷新页面</div>';
    } finally {restoreContext();}
  }
  function valueText(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (key === 'status') return statuses[value] || value;
    if (key === 'category') return categories[value] || value;
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  async function detail(id, focus = true) {
    clearTimeout(drawerCleanupTimer);
    const seq = ++detailSequence;
    if(focus)captureContext();
    const detailScroll=!focus?$('#itlDrawerBody').scrollTop:0;
    state.detailId = id;
    if (focus) returnFocus = document.activeElement;
    $('#itlWorkspace').classList.add('itl-detail-open');
    syncDetailMode();
    $('#itlDrawer').inert = false; $('#itlDrawer').classList.add('open'); $('#itlDrawerOverlay').classList.add('open');
    $('#itlDrawerTitle').textContent='正在读取…';$('#itlDrawerMeta').replaceChildren();
    $('#itlDrawerBody').textContent = '正在读取…'; if (focus) $('#itlDrawerClose').focus({preventScroll:true});
    try {
      const { asset, events,record_control,record_history=[] } = await api('/'+id);asset.record_inactive=!!record_control;
      if (seq !== detailSequence) return;
      $('#itlDrawerTitle').textContent = asset.name;
      $('#itlDrawerMeta').innerHTML=`${badge(asset.status)}<span>${esc(categories[asset.category])}</span><span>资产 #${asset.id}</span>`;
      const groups=[['基本信息',['category','brand','model','sn','asset_no','asset_class','attrs','note']],['位置与归属',['owner_name','owner_dept','custodian_name',...(asset.category==='laptop'&&asset.location_text?['location_text']:[]),'u_height','slot_count']],[isAdmin()?'采购与财务':'采购信息',['purchased_at','expires_at',...(isAdmin()?['fin_amount','fin_vendor','fin_contract_no']:[])]]];
      const attrLabels={device_type:'设备细分',subtype:'业务类别编码',ip:'IP',purpose:'用途',os:'操作系统',capacity:'容量',interface:'接口',form_factor:'规格',cpu:'CPU',ram:'内存',mgmt_ip:'管理IP',ssid_group:'SSID组'};
      // Platform u-kv layout only: every field is label-over-value; long values span the row, half-width ones come first.
      const kvItem=(label,value,full)=>`<div class="u-kv-item${full?' full':''}"><label>${label}</label><div class="v">${value}</div></div>`;
      const attrItems=Object.entries(asset.attrs||{}).map(([key,v])=>{const text=String(valueText(key,v));return {full:text.length>20,html:kvItem(esc(attrLabels[key]||key),esc(text),text.length>20)};}).sort((x,y)=>x.full-y.full).map(x=>x.html).join('');
      const groupItems=(index,keys)=>(index===0?kvItem(asset.category==='laptop'?'当前保管人':'当前位置',esc(location(asset)),true):'')+keys.map(k=>k==='attrs'?attrItems:kvItem(k==='location_text'&&asset.category==='laptop'?'历史位置（原记录）':fields[k],esc(valueText(k,asset[k])),k==='note')).join('');
      $('#itlDrawerBody').innerHTML = `<div id="itlDetailActions" class="u-action-bar u-action-bar-sticky">${record_control?'':locateButton(asset)+locationEditButton(asset)+custodyButtons(asset)}${canWrite()&&!record_control?`<button type="button" class="u-btn-secondary" data-action="edit" data-id="${asset.id}">编辑资料</button>`:''}</div><div id="itlAssetProfile">${ITLedger.recordHistoryHTML(record_control,[])}${groups.map(([title,keys],index)=>`<section class="u-detail-section itl-detail-group"><h3>${title}</h3><div class="u-kv-grid itl-kv">${groupItems(index,keys)}</div></section>`).join('')}<p class="itl-detail-version">记录版本 ${asset.version}</p><section class="u-detail-section"><h3>变更记录</h3><ol class="itl-timeline">${[...events].reverse().map(event => {
        const from = event.from_state || {}, to = event.to_state || {};
        const diff = [...new Set([...Object.keys(from),...Object.keys(to)])].map(k => `${fields[k] || k}：${valueText(k,from[k])} → ${valueText(k,to[k])}`).join('\n');
        return `<li><strong>${esc(actionNames[event.action] || event.action)} · ${esc(asset.name)}</strong>${event.role === 'affected' ? ' <span class="itl-muted">关联资产</span>' : ''}<p>${esc(diff)}</p>${event.related_asset_id ? `<p><button type="button" class="itl-link" data-detail="${event.related_asset_id}">查看关联资产 #${event.related_asset_id}</button></p>` : ''}${event.note ? `<p>${esc(event.note)}</p>` : ''}<div class="itl-muted">${esc(event.created_at)} · 操作人 #${esc(event.operator_id)}</div><div class="itl-op">${esc(event.op_id)}</div></li>`;
      }).join('') || '<li>暂无事件</li>'}</ol></section>${ITLedger.recordHistoryHTML(null,record_history)}</div>`;
      if (!record_control && asset.slot_count > 0 && ITLedger.openDisks) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'u-btn-secondary'; button.textContent = '打开盘位';
        button.addEventListener('click', () => ITLedger.openDisks(asset.id, 'detail'));
        $('#itlDetailActions').appendChild(button);
      }
      if(!record_control)ITLedger.decorateAssetDetail?.(asset, $('#itlDrawerBody'));
      ITLedger.mountAssetInspection?.(asset, $('#itlDrawerBody'));
      $('#itlDrawerBody').scrollTop=detailScroll;restoreContext();
    } catch (error) { if (seq === detailSequence) $('#itlDrawerBody').textContent = error.message; }
  }
  function syncDetailMode() { $('#itlDrawer').setAttribute('aria-modal','true'); }
  function clearDrawerContent(){if($('#itlDrawer').classList.contains('open'))return;$('#itlDrawerMeta').replaceChildren();$('#itlDrawerTitle').textContent='资产详情';$('#itlDrawerBody').replaceChildren();}
  function closeDrawer() {
    const wasOpen=$('#itlDrawer').classList.contains('open');ITLedger.unmountAssetInspection?.();detailSequence++;state.detailId=null;$('#itlWorkspace').classList.remove('itl-detail-open');
    $('#itlDrawer').classList.remove('open');$('#itlDrawer').inert=true;$('#itlDrawerOverlay').classList.remove('open');
    clearTimeout(drawerCleanupTimer);if(!state.level)clearDrawerContent();else drawerCleanupTimer=setTimeout(clearDrawerContent,300);
    restoreContext();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    if(wasOpen&&state.level)Object.values(state.views).forEach(view=>view.onDrawerClosed?.());
  }

  // C5a（段3补充，spec-C5.md「弹窗所有权」）：modalToken 每次 openModal 自增一次，L.currentModalToken()
  // 供写回调在 await 之后判断"当前弹窗是不是我自己打开的那个"——不是则不调用 closeModal(true)，避免
  // 后台写请求挂起期间用户开出的新弹窗被旧请求的收尾逻辑误关。openModal 内部自身的 closeModal(true)
  // （下一行）不受这条约束——"打开新弹窗时先关掉旧的"永远是有意的、无条件的替换，不是本条防的对象。
  function openModal(title, html, submit, label = '保存', meta = {}) {
    modalToken++;
    closeModal(true); returnFocus = document.activeElement; modalSubmit = submit;
    modalStale = false; $('#itlSubmit').disabled = false;
    $('#itlModalTitle').textContent = title; $('#itlModalBody').innerHTML = html + (meta.assetId ? ITLedger.resolutionChoice?.(meta.assetId, 'modal') || '' : ''); $('#itlFormError').textContent = ''; $('#itlSubmit').textContent = label;
    $('#itlModal').inert = false; $('#itlModal').classList.add('open');
    // The dialog is already in the DOM: focus synchronously, never steal later input.
    ($('#itlModalBody input:not([disabled]),#itlModalBody select:not([disabled])') || $('#itlModalClose')).focus();
  }
  function closeModal(force = false) { if (modalBusy && !force) return; modalSubmit = null; $('#itlModal').classList.remove('open'); $('#itlModal').inert = true; $('#itlModalBody').replaceChildren(); if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); }
  function formError(error) {
    $('#itlFormError').textContent = error.message;
    const field = [...document.querySelectorAll('#itlForm [name]')].find(el => el.name === error.field || (error.field === 'placement' && el.name === 'placement.kind'));
    if (field) { field.setAttribute('aria-invalid','true'); const box = field.closest('.itl-field')?.querySelector('.itl-field-error'); if (box) box.textContent = error.message; field.focus(); }
    if (error.code === 'VERSION_CONFLICT') { modalStale = true; $('#itlSubmit').disabled = true; refresh(); }
  }
  async function action(asset, name, params) {
    const root = $('#itlModal').classList.contains('open') ? $('#itlForm') : null;
    const binding = ITLedger.resolutionProtocol?.(asset.id, root) || {};
    const payload = { expected_version: asset.version, ...binding, ...params };
    const result = await api('/'+asset.id+'/actions/'+name, { method: 'POST', body: JSON.stringify(payload) });
    if (payload.stocktake_item_id) ITLedger.resolutionCommitted?.(payload.stocktake_item_id);
    else ITLedger.resolutionIntermediate?.(asset.id);
    return result;
  }
  async function dispatchAction(key, id) {
    if (!canWrite()) return;
    try {
      if (key === 'edit') return await ITLedger.openAssetForm(id);
      const detailRecord = await api('/'+id);
      const asset=detailRecord.asset;asset.record_inactive=!!detailRecord.record_control;
      if(key==='edit_location'){
        const intent=locationIntent(asset);if(!intent){notice('当前状态不支持位置操作，请核对资产状态后重试。');return;}
        if(intent.key==='edit')return ITLedger.openAssetForm(asset.id);
        if(intent.key==='disk_positions')return ITLedger.openDisks(asset.parent_asset_id,'detail',asset.id);
        if(intent.key==='rack_position')return ITLedger.openRack(asset.rack_id,asset);
        for(const view of Object.values(state.views))if(view.action&&await view.action(intent.key,asset))return;
        return;
      }
      if (key === 'mark_status' || key === 'retire') {
        openModal(key === 'retire' ? '确认报废' : '调整库房状态', `<p>${esc(asset.name)}</p>${key === 'retire' ? '<p>报废后不再出现在库房中，仍可在全部视图和时间线查阅。</p>' : `<label class="itl-field">目标状态<select name="status">${['in_depot','faulty','to_retire'].filter(s => s !== asset.status).map(s => `<option value="${s}">${statuses[s]}</option>`).join('')}</select></label>`}`, async form => { await action(asset,key,key === 'mark_status' ? { status: form.elements.status.value } : {}); closeModal(true); await refresh(); toast('操作已保存'); }, '确认', { assetId: asset.id });
      } else { for (const view of Object.values(state.views)) if (view.action && await view.action(key,asset)) break; }
    } catch (error) { notice(error.message); }
  }
  window.ITLedger = { $, esc, state, businessTypes, syncHeaderEmphasis, assetCard, categories, statuses, fields, canWrite, isAdmin, api, refresh, render, setTab, location, children, badge, type, menu, assetButton, rememberView, viewContext, detail, closeDrawer, toast, notice, openModal, closeModal, currentModalToken: () => modalToken, formError, action, valueText, registerView: (key, view) => { state.views[key] = view; } };
  document.addEventListener('DOMContentLoaded', () => {
    const requested = locationHash(); if (Object.hasOwn(tabs,requested)) state.tab = requested;
    $('#itlTabs').addEventListener('click', e => { const tab = e.target.closest('[data-tab]'); if (tab) setTab(tab.dataset.tab); });
    document.addEventListener('click',e=>{const current=e.target.closest('.itl-menu');document.querySelectorAll('.itl-menu[open]').forEach(menu=>{if(menu!==current||e.target.closest('.itl-menu-panel'))menu.open=false;});});
    $('#itlRegister').addEventListener('click', () => ITLedger.openAssetForm());
    document.addEventListener('click', e => { const button = e.target.closest('[data-detail],[data-action],[data-locate]'); if (!button) return; if(button.dataset.locate){locateAsset(Number(button.dataset.locate));return;} if (button.dataset.detail) detail(Number(button.dataset.detail)); else dispatchAction(button.dataset.action, Number(button.dataset.id)); });
    $('#itlContent').addEventListener('click',e=>{const row=e.target.closest('[data-detail-row]');if(row&&!e.target.closest('button,a,input,select,textarea,summary'))detail(Number(row.dataset.detailRow));});
    $('#itlContent').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-detail-row]')){e.preventDefault();detail(Number(e.target.dataset.detailRow));}});
    $('#itlDrawerClose').addEventListener('click', closeDrawer); $('#itlDrawerOverlay').addEventListener('click', closeDrawer);
    $('#itlModalClose').addEventListener('click', () => closeModal()); $('#itlModalCancel').addEventListener('click', () => closeModal());
    $('#itlForm').addEventListener('submit', async e => {
      e.preventDefault(); if (modalBusy || !modalSubmit || !canWrite()) return;
      modalBusy = true; $('#itlSubmit').disabled = true; $('#itlFormError').textContent = '';
      document.querySelectorAll('#itlForm [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
      document.querySelectorAll('#itlForm .itl-field-error').forEach(el => { el.textContent = ''; });
      try { await modalSubmit(e.target); } catch (error) { formError(error); }
      finally { modalBusy = false; $('#itlSubmit').disabled = modalStale; }
    });
    document.addEventListener('keydown', e => {
      if(e.key==='Escape'){const menu=document.querySelector('.itl-menu[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus();e.preventDefault();return;}}
      const active = $('#itlModal').classList.contains('open') ? $('#itlModal') : $('#itlDrawer').classList.contains('open') ? $('#itlDrawer') : null;
      if (!active) return;
      if (e.key === 'Escape' && active.id === 'itlModal') { e.preventDefault(); closeModal(); }
      if (e.key === 'Tab' && active.id === 'itlModal') { const items = [...active.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary')].filter(el => el.getClientRects().length); const first = items[0], last = items.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    });
    window.addEventListener('scroll',captureContext,{passive:true});
    window.addEventListener('pagehide',captureContext);
    window.addEventListener('storage',e=>{if(e.key==='token'){resetAccessUI('尚未获准访问');refresh();}});
    window.addEventListener('hashchange',()=>{const tab=locationHash();if(state.level&&tab!==state.tab)setTab(tab);});
    $('#itlDrawer').addEventListener('transitionend',e=>{if(e.target===$('#itlDrawer')&&e.propertyName==='transform')clearDrawerContent();});
    syncDetailMode();
    const platformNav=document.querySelector('nav.navbar');
    const syncNavHeight=()=>document.querySelector('.itl-workbench').style.setProperty('--itl-nav-height',platformNav.getBoundingClientRect().height+'px');
    new ResizeObserver(syncNavHeight).observe(platformNav);syncNavHeight();
    refresh();
  });
  function locationHash() { const hash=window.location.hash.slice(1).split('?')[0];return hash==='inventory'?'stocktakes':hash; }
})();
