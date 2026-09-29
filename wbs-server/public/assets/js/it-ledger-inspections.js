/* Server-detail "device inspection" tab: read-only summary of this asset's inspection records. */
// C7（长任务 E · 巡检台账改版，方案 v0.6 §6「it-ledger-inspections.js」条 / §7「v0.6 追加退役」段，
// 用户 2026-09-25 16:5x 裁定 A）：单独设备巡检退役——本文件不再挂一键采集按钮、判断表单、附件区、
// 快照详情展开；只渲染该设备的巡检记录摘要表（采集时间 / 所属巡检单 / 采集状态 / 告警数 / 判断
// 结果），点击「所属巡检单」列可点的行跳去对应巡检单（L.openInspectionSheet，inspection-sheets.js
// 导出，本文件不了解巡检单内部状态机）。采集、判断、说明、照片只在巡检单内完成。
(function(){
 'use strict';const L=window.ITLedger,{$,esc}=L;let sequence=0,mount=null;const tabs=new Map();
 const statuses={success:'采集完成',partial:'部分采集',failed:'采集失败'};
 const results={ok:'正常',bad:'异常'};
 const time=s=>s?new Date(s).toLocaleString('zh-CN'):'—';
 // L2（C7-c，Opus预筛）：current(seq) 这层过期响应守卫——它挡的是"切换到另一台服务器/离开详情后，
 // 迟到的历史数据落地"这类竞态。prescreen 变异实测（P7，把守卫去掉重跑全套）证明：即使去掉这层守卫
 // 也不会产生任何可观察的错误——render() 用闭包变量 bound 捕获的是发起请求那一刻的 host 元素，用户
 // 切换资产时 mountAssetInspection 会创建一个全新的 host 节点挂到 DOM 里，旧的 host 从未被摘掉过
 // （mountAssetInspection 每次都新建，不复用），迟到的响应即使不被拦，写的也是这个已经从未挂载/或已
 // 经从文档树脱离的旧节点，屏幕上什么都不会变。这层守卫因此只是纵深防御（防止未来渲染结构改成"复用
 // 同一个host节点"之类写法后悄悄引入真实的竞态），本文件不为它单独写测试用例——不是漏测，是当前
 // 结构下确实没有能让它产生可观察差异的构造。
 function current(seq){return seq===sequence&&!!mount&&mount.host.isConnected&&L.state.detailId===mount.asset.id;}
 // C7：受限行（他人草稿等，restricted:true）只带 id/asset_id/started_at/sheet_ref/restricted 五个
 // 键（inspections.js GET / 的响应白名单，方案 §4.2）——采集时间只能取 started_at，采集状态/告警数/
 // 判断结果这三列在受限行上一律显示"—"（没有对应字段可读，不是数据缺失,是权限收窄的预期结果）。
 // 不属于任何巡检单的历史记录（sheet_ref 为 null，生产不存在，只有本地测试数据）显示「单独巡检
 // （已停用）」文字，不可点——单独巡检入口已退役，这类记录之后也不会再产生。
 // L10（C7-c，Opus预筛）：管理员看到的已删除单linkable行（sheet_ref.status==='deleted'）按钮文字后
 // 补"（已删除）"——原来只有status字段本身带着这个信号，界面上完全看不出这张能点开的单其实已经被
 // 删了，点进去才发现是只读详情，体验上是个惊讶；这里直接在摘要表就提前说清楚。
 function attributionCell(r){
  if(!r.sheet_ref)return '<span class="itl-muted">单独巡检（已停用）</span>';
  if(!r.sheet_ref.linkable)return esc(r.sheet_ref.text);
  const suffix=r.sheet_ref.status==='deleted'?'（已删除）':'';
  return `<button type="button" class="itl-link" data-open-sheet="${r.sheet_ref.id}">${esc(r.sheet_ref.text+suffix)}</button>`;
 }
 // L3（C7-c，Opus预筛）：采集时间列可见行与受限行统一用 started_at——受限行只有这一个字段可读
 // （见上方白名单注释），可见行原来用 completed_at，两档取的不是同一件事，同一列却隐含两种口径，
 // 统一成 started_at（采集发起时刻，两档都取得到，语义一致）。
 function rowHtml(r){
  if(r.restricted)return `<tr><td>${esc(time(r.started_at))}</td><td>${attributionCell(r)}</td><td><span class="itl-muted">—</span></td><td><span class="itl-muted">—</span></td><td><span class="itl-muted">—</span></td></tr>`;
  const alerts=Number.isFinite(r.alert_count)?r.alert_count+' 项':'未取得';
  const result=results[r.item_result]||'未判断';
  return `<tr><td>${esc(time(r.started_at))}</td><td>${attributionCell(r)}</td><td>${esc(statuses[r.collection_status]||r.collection_status)}</td><td>${esc(alerts)}</td><td>${esc(result)}</td></tr>`;
 }
 async function render(){
  if(!mount?.host.isConnected)return;
  const bound=mount,assetId=bound.asset.id,seq=++sequence;bound.host.innerHTML='<div class="itl-empty">正在读取本机巡检记录…</div>';
  try{
   const history=await L.api('/inspections?asset_id='+assetId);if(!current(seq))return;
   const body=history.items.map(rowHtml).join('');
   bound.host.innerHTML=history.items.length
    ?`<div id="itlInspectionRoot"><p class="itl-muted">当前服务器的巡检记录摘要，最近100条；采集与判断在「巡检台账」中进行。</p><div class="itl-inspection-table"><table class="u-corr-table"><thead><tr><th>采集时间</th><th>所属巡检单</th><th>采集状态</th><th>告警数</th><th>判断结果</th></tr></thead><tbody>${body}</tbody></table></div></div>`
    :'<div class="itl-empty">暂无巡检记录，巡检在「巡检台账」中进行。</div>';
   bound.host.querySelectorAll('[data-open-sheet]').forEach(b=>b.onclick=()=>L.openInspectionSheet(Number(b.dataset.openSheet)));
  }catch(e){if(current(seq))bound.host.innerHTML=`<div class="itl-empty">${esc(e.message)}</div>`;}
 }
 L.unmountAssetInspection=()=>{sequence++;mount=null;};
 L.mountAssetInspection=(asset,root)=>{
  sequence++;mount=null;if(asset.category!=='server')return;
  const profile=$('#itlAssetProfile',root);if(!profile)return;
  const nav=document.createElement('nav');nav.className='itl-detail-tabs';nav.setAttribute('aria-label','服务器详情');nav.innerHTML='<button type="button" data-server-detail-tab="profile">资产资料</button><button type="button" data-server-detail-tab="inspection">设备巡检</button>';
  const host=document.createElement('section');host.id='itlAssetInspections';profile.before(nav);root.appendChild(host);mount={asset,host};
  function select(tab){if(!host.isConnected)return;tabs.set(asset.id,tab);profile.hidden=tab==='inspection';host.hidden=tab!=='inspection';nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.serverDetailTab===tab)));if(tab==='inspection')render();}
  nav.querySelectorAll('button').forEach(b=>b.onclick=()=>select(b.dataset.serverDetailTab));select(tabs.get(asset.id)||'profile');
 };
 L.registerView('inspection-hooks',{onAccessLost(){sequence++;mount=null;tabs.clear();}});
})();
