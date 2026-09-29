/* C11 self-stocktakes. Reports never silently write asset state. */
(function(){
  'use strict';
  const L=window.ITLedger,{$,esc}=L;
  const labels={pending:'待核对',found:'账实相符',missing:'未找到',mismatch:'不一致'},classes={pending:'sem-wait',found:'sem-done',missing:'sem-failed',mismatch:'sem-hold'};
  const keys=['status','rack_id','u_start','parent_asset_id','slot_no','custodian_name','location_text','floor_id','room_id','pos','version'];
  const numeric=new Set(['rack_id','u_start','parent_asset_id','slot_no','version']);
  let selected=null,batch=null,sequence=0,filter='',grouping='auto',differencesOnly=false,context=null,subview='stocktakes';
  const inventoryViews={stocktakes:{label:'自检盘点',render:()=>load().catch(e=>L.notice(e.message))}};
  const resultBadge=result=>UnifyHelpers.statusBadgeByMap(result,classes,labels[result]||result);
  function expectedLocation(value){if(value.rack_id)return `${L.state.racks.find(r=>r.id===value.rack_id)?.name||'机柜 #'+value.rack_id} · 起始 U${value.u_start}`;return L.location(value);}
  function renderInventory(key){
    subview=key;$('#itlContent').innerHTML=`<p class="itl-muted">${key==='stocktakes'?'核对实物与台账的位置、状态，记录差异并跟进处理。':'核对财务册与资产台账，保留核实结果与回交记录。'}</p><section id="itlInventoryContent"><div class="itl-empty">正在读取…</div></section>`;
    inventoryViews[key].render();
  }
  async function load(){
    const seq=++sequence,id=selected;const data=await L.api('/stocktakes'+(id?'/'+id:''));
    if(seq!==sequence||L.state.tab!=='stocktakes'||subview!=='stocktakes'||!$('#itlInventoryContent'))return;
    if(id){batch=data;renderBatch();}else{batch=null;renderList(data);}
  }
  function renderList(items){
    $('#itlInventoryContent').innerHTML=`<div class="itl-toolbar"><h2>自检盘点批次</h2>${L.canWrite()?'<button type="button" class="u-btn-primary" data-stock-command="create">＋ 发起盘点</button>':''}</div><div class="u-corr-table-wrap"><table class="u-corr-table"><thead><tr><th>批次</th><th>状态</th><th>四类结果</th><th>发起时间</th><th>备注</th></tr></thead><tbody>${items.map(b=>`<tr><td><button type="button" class="itl-link" data-stock-open="${b.id}">${esc(b.title)}</button></td><td>${b.status==='closed'?'已关闭':'进行中'}</td><td>${Object.entries(labels).map(([k,label])=>`${label} ${b.counts[k]}`).join(' · ')}</td><td>${esc(b.created_at)}</td><td>${esc(b.note||'—')}</td></tr>`).join('')||'<tr><td colspan="5" class="itl-empty">暂无盘点批次</td></tr>'}</tbody></table></div>`;
  }
  function group(item){
    const e=item.expected;const parent=batch.items.find(i=>i.asset_id===e.parent_asset_id),rackId=e.rack_id||parent?.expected.rack_id;
    const rackName=id=>L.state.racks.find(r=>r.id===id)?.name||'#'+id;
    const floorName=id=>L.state.floors.find(f=>f.id===id)?.name||id;
    if(grouping==='rack')return rackId?'机柜 · '+rackName(rackId):e.parent_asset_id?'宿主 #'+e.parent_asset_id+'（无快照机柜位置）':'无机柜位置';
    if(grouping==='depot')return ['in_depot','faulty','to_retire'].includes(e.status)?'库房 · '+L.statuses[e.status]:'非库房';
    if(grouping==='custodian')return '保管人 · '+(e.custodian_name||'未指定');
    if(grouping==='floor')return e.floor_id?'楼层 · '+floorName(e.floor_id):'无楼层位置';
    if(['in_depot','faulty','to_retire'].includes(e.status))return '库房 · '+L.statuses[e.status];
    if(rackId)return '机柜 · '+rackName(rackId);if(e.parent_asset_id)return '宿主 #'+e.parent_asset_id+'（无快照机柜位置）';
    if(e.floor_id)return '楼层 · '+floorName(e.floor_id);if(e.custodian_name)return '保管人 · '+e.custodian_name;if(e.location_text)return '位置 · '+e.location_text;return L.statuses[e.status]||'未分组';
  }
  function renderBatch(){
    const b=batch,counts=b.status==='closed'?b.summary:b.counts;
    $('#itlInventoryContent').innerHTML=`<div class="itl-toolbar"><button type="button" class="u-btn-secondary" data-stock-command="back">返回批次列表</button><h2>${esc(b.title)}</h2><span>${b.status==='closed'?'已关闭 · 汇总已冻结':'进行中'}</span>${L.canWrite()?'<button type="button" class="u-btn-secondary" data-stock-command="batch-note">批次备注</button>':''}${L.isAdmin()&&b.status==='open'?'<button type="button" class="u-btn-primary" data-stock-command="close">关闭盘点</button>':''}</div><p class="itl-muted">${Object.entries(labels).map(([k,label])=>`${label} ${counts[k]}`).join(' · ')}${b.status==='closed'&&counts.pending?' · 含未核对条目':''}</p><p>${esc(b.note||'')}</p><div class="itl-toolbar"><label>按快照分组 <select id="itlStockGroup">${[['auto','自动位置'],['rack','机柜'],['depot','库房栏'],['custodian','保管人'],['floor','楼层']].map(([k,v])=>`<option value="${k}"${k===grouping?' selected':''}>${v}</option>`).join('')}</select></label><label>定位 <input id="itlStockSearch" type="search" value="${esc(filter)}" placeholder="当前名称 / SN / 编号"></label><span class="itl-muted">位置按快照；资产名、SN与房间名称取当前档案。发起后新增资产不自动加入。</span></div><div id="itlStockItems"></div>`;
    $('#itlStockSearch').addEventListener('input',e=>{filter=e.target.value;renderItems();});$('#itlStockGroup').addEventListener('change',e=>{grouping=e.target.value;renderItems();});renderItems();
    if(b.status==='closed'){const label=document.createElement('label');label.innerHTML=`<input type="checkbox" id="itlStockDifferences"${differencesOnly?' checked':''}> 只看差异（未找到 / 不一致）`;$('#itlStockSearch').closest('.itl-toolbar').appendChild(label);$('#itlStockDifferences').addEventListener('change',e=>{differencesOnly=e.target.checked;renderItems();});}
  }
  function renderItems(){
    const groups=new Map(),items=batch.items.filter(i=>(batch.status!=='closed'||!differencesOnly||['missing','mismatch'].includes(i.result))&&[i.current?.name,i.current?.sn,i.current?.asset_no,i.asset_id].some(v=>String(v??'').toLowerCase().includes(filter.toLowerCase())));
    for(const item of items){const g=group(item);if(!groups.has(g))groups.set(g,[]);groups.get(g).push(item);}
    $('#itlStockItems').innerHTML=[...groups].map(([g,rows])=>`<section class="itl-stock-group"><h3>${esc(g)} · ${rows.length}</h3>${rows.map(i=>`<article class="itl-stock-item" data-stock-item="${i.id}"><header><strong>${i.current?L.assetButton(i.current):'资产 #'+i.asset_id+'（当前记录不可用）'}</strong><span class="itl-muted">SN ${esc(i.current?.sn||'—')}</span>${resultBadge(i.result)}${i.resolved_op_id?'<span class="itl-resolved">已关联处置</span>':''}</header>${i.version_changed?'<p class="itl-stock-changed">快照后台账有更新</p>':''}<div class="itl-stock-locations"><span>快照：${esc(expectedLocation(i.expected))}</span><span>当前：${esc(i.current?L.location(i.current):'记录不可用')}</span></div><details${i.changed_fields.length?' open':''}><summary>快照 / 当前字段比较</summary><table class="itl-stock-compare"><thead><tr><th>字段</th><th>快照值</th><th>台账当前值</th></tr></thead><tbody>${keys.map(k=>`<tr${i.changed_fields.includes(k)?' class="itl-field-difference"':''}><th>${L.fields[k]||k}</th><td>${esc(L.valueText(k,i.expected[k]))}</td><td>${esc(L.valueText(k,i.current?.[k]))}</td></tr>`).join('')}</tbody></table></details>${i.actual?`<p>人工核实值：${esc(JSON.stringify(i.actual))}</p>`:''}<p class="itl-muted">${esc(i.note||'')}${i.checked_at?' · '+esc(i.checked_at)+' / 核对人 #'+i.checked_by:''}</p>${i.resolved_op_id?`<p class="itl-op">处置编号 ${esc(i.resolved_op_id)}</p>`:''}<div class="itl-actions">${L.canWrite()&&batch.status==='open'?`<button type="button" class="u-btn-secondary" data-stock-check="${i.id}">核对</button>`:''}${L.canWrite()?`<button type="button" class="itl-link" data-stock-note="${i.id}">备注</button>`:''}${L.canWrite()&&batch.status==='closed'&&['missing','mismatch'].includes(i.result)&&!i.resolved_op_id&&i.current?`<button type="button" class="u-btn-secondary" data-stock-resolve="${i.id}">处理差异</button>`:''}</div></article>`).join('')}</section>`).join('')||'<div class="itl-empty">没有匹配的盘点明细</div>';
  }
  function createBatch(){
    if(!L.canWrite())return;L.openModal('发起自检盘点',`${L.formField('title','批次名称','',{required:true})}<div class="itl-stock-scope"><label><input type="checkbox" name="all_categories" checked> 不限制类别</label><select name="categories" multiple disabled aria-label="盘点类别">${Object.entries(L.categories).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select><label><input type="checkbox" name="all_racks" checked> 不限制机柜</label><select name="rack_ids" multiple disabled aria-label="盘点机柜">${L.state.racks.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select><label><input type="checkbox" name="depot_only"> 仅库房三栏</label></div><p class="u-hint">取消“不限制”后未选任何项，表示空范围。各限制取交集；机柜范围含随装盘。</p>${L.formField('note','备注','',{textarea:true})}`,async form=>{
      const title=form.elements.title.value.trim();if(!title)throw new Error('请填写批次名称。');const scope={};if(!form.elements.all_categories.checked)scope.categories=[...form.elements.categories.selectedOptions].map(o=>o.value);if(!form.elements.all_racks.checked)scope.rack_ids=[...form.elements.rack_ids.selectedOptions].map(o=>Number(o.value));if(form.elements.depot_only.checked)scope.depot_only=true;
      const created=await L.api('/stocktakes',{method:'POST',body:JSON.stringify({title,scope,note:form.elements.note.value||null})});L.closeModal(true);selected=created.id;await load();L.toast('盘点快照已创建');
    });const form=$('#itlForm');for(const [all,select]of [['all_categories','categories'],['all_racks','rack_ids']])form.elements[all].addEventListener('change',()=>{form.elements[select].disabled=form.elements[all].checked;});
  }
  async function checkItem(itemId){
    const b=await L.api('/stocktakes/'+selected),item=b.items.find(i=>i.id===itemId);if(!item||b.status!=='open'||!L.canWrite()){L.notice('关闭后只能修改备注。');return;}
    const actual=item.actual||{};
    L.openModal('核对 · '+(item.current?.name||'#'+item.asset_id),`${L.formField('result','核对结果',item.result,{choices:Object.entries(labels)})}<fieldset id="itlActualFields"><legend>人工核实值（仅填写实际核实的字段）</legend>${keys.map(k=>`<div class="itl-actual-field"><label><input type="checkbox" data-actual-key="${k}"${Object.hasOwn(actual,k)?' checked':''}> ${L.fields[k]||k}</label>${k==='pos'?`${L.formField('actual.pos.x','房间内 X',actual.pos?.x??'',{type:'number',min:0,max:1,step:'any'})}${L.formField('actual.pos.y','房间内 Y',actual.pos?.y??'',{type:'number',min:0,max:1,step:'any'})}`:L.formField('actual.'+k,L.fields[k]||k,actual[k]??'',numeric.has(k)?{type:'number',min:1}:{})}</div>`).join('')}<p class="u-hint">不勾选的字段不提交；没有填写具体字段时保留空对象，不能据此推断台账实际值。</p></fieldset>${L.formField('note','备注',item.note,{textarea:true})}`,async form=>{
      const result=form.elements.result.value;let value=null;
      if(result==='mismatch'){value={};for(const input of form.querySelectorAll('[data-actual-key]:checked')){const k=input.dataset.actualKey;
        if(k==='pos'){const x=form.elements['actual.pos.x'].value,y=form.elements['actual.pos.y'].value;if(x===''&&y==='')value.pos=null;else{if(x===''||y===''||![Number(x),Number(y)].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('pos须同时填写0–1之间的x/y。');value.pos={x:Number(x),y:Number(y)};}}
        else{const raw=form.elements['actual.'+k].value;if(numeric.has(k)){if(raw===''&&k!=='version')value[k]=null;else{const n=Number(raw);if(raw===''||!Number.isSafeInteger(n)||n<=0)throw new Error('位置编号或版本须为正整数。');value[k]=n;}}else value[k]=raw===''?null:raw;}
      }}
      try{await L.api(`/stocktakes/${b.id}/items/${itemId}`,{method:'PUT',body:JSON.stringify({result,actual:value,note:form.elements.note.value||null})});}catch(error){if(error.status===400&&error.field==='status')await load();throw error;}L.closeModal(true);await load();
    });const toggle=()=>{$('#itlActualFields').hidden=$('#itlForm').elements.result.value!=='mismatch';};$('#itlForm').elements.result.addEventListener('change',toggle);toggle();
    for(const checkbox of document.querySelectorAll('#itlActualFields [data-actual-key]')){const sync=()=>checkbox.closest('.itl-actual-field').querySelectorAll('input:not([type="checkbox"])').forEach(input=>{input.disabled=!checkbox.checked;});checkbox.addEventListener('change',sync);sync();}
  }
  async function noteForm(itemId){
    if(!L.canWrite())return;const b=await L.api('/stocktakes/'+selected),item=itemId?b.items.find(i=>i.id===itemId):null;
    L.openModal(itemId?'条目备注':'批次备注',L.formField('note','备注',itemId?item?.note:b.note,{textarea:true,wide:true}),async form=>{await L.api(`/stocktakes/${b.id}${itemId?'/items/'+itemId:''}/note`,{method:'PUT',body:JSON.stringify({note:form.elements.note.value||null})});L.closeModal(true);await load();});
  }
  async function closeBatch(){
    if(!L.isAdmin())return;const b=await L.api('/stocktakes/'+selected);L.openModal('关闭盘点',`<p>${esc(b.title)}：仍有 ${b.counts.pending} 条待核对。关闭后核对结果冻结，备注仍可修改。</p><label><input type="checkbox" name="force"> 强制关闭，并把待核对计入冻结汇总</label>`,async form=>{await L.api('/stocktakes/'+b.id+'/close',{method:'POST',body:JSON.stringify({force:form.elements.force.checked})});L.closeModal(true);await load();},'确认关闭');
  }
  function paintBanner(){
    let banner=$('#itlResolutionBanner');if(!context){banner?.remove();return;}if(!banner){banner=document.createElement('div');banner.id='itlResolutionBanner';banner.className='itl-resolution-banner';$('#itlTabs').before(banner);}
    banner.innerHTML=`正在处理盘点差异：${esc(context.name)} · 条目 #${context.itemId}。仅在最后一步勾选关联。 <button type="button" class="itl-link" data-stock-context="view">查看处理资产</button> <button type="button" class="itl-link" data-stock-open="${context.batchId}">返回盘点</button> <button type="button" class="itl-link" data-stock-context="cancel">结束本次处理</button>`;
  }
  async function resolve(itemId){
    if(!L.canWrite())return;const b=await L.api('/stocktakes/'+selected),item=b.items.find(i=>i.id===itemId);
    if(!item||b.status!=='closed'||!['missing','mismatch'].includes(item.result)||item.resolved_op_id||!item.current){L.notice('此项当前不能发起差异处置。');await load();return;}
    L.notice('');context={batchId:b.id,itemId,assetId:item.asset_id,name:item.current.name,item};paintBanner();await L.detail(item.asset_id);
  }
  L.resolutionAssetId=()=>context?.assetId;
  L.clearStocktakeResolution=()=>{context=null;paintBanner();};
  L.resolutionChoice=(assetId,suffix)=>!context||context.assetId!==assetId?'':`<label class="itl-resolution-choice" for="itlFinal-${suffix}"><input id="itlFinal-${suffix}" type="checkbox" data-stocktake-final="${context.itemId}"> 本次是 ${esc(context.name)} 的最后一步：保存操作并关联盘点差异 #${context.itemId}</label>`;
  L.resolutionProtocol=(assetId,root)=>{const input=root?.querySelector('[data-stocktake-final]:checked');if(!input)return {};if(!context||context.assetId!==assetId||Number(input.dataset.stocktakeFinal)!==context.itemId)throw new Error('操作主资产与差异条目不一致，请重新打开处理窗口。');return {stocktake_item_id:context.itemId};};
  L.resolutionCommitted=itemId=>{if(context?.itemId!==itemId)return;selected=context.batchId;context=null;paintBanner();L.closeDrawer();L.notice('处置已与盘点差异关联，可返回盘点批次查看。');};
  L.resolutionIntermediate=assetId=>{if(context?.assetId!==assetId)return;L.closeDrawer();paintBanner();L.notice('本步骤已保存，盘点差异尚未关联；可继续处理或只记备注。');};
  L.decorateAssetDetail=(a,root)=>{
    if(!context||context.assetId!==a.id)return;const actual=context.item.actual||{},panel=document.createElement('section');panel.className='itl-resolution-detail';
    panel.innerHTML=`<h3>盘点差异 · ${labels[context.item.result]}</h3><p class="itl-muted">核对值不是自动修改指令；不能确认实物时，只在盘点条目记录“待核实”。</p><table class="itl-stock-compare"><thead><tr><th>字段</th><th>盘点人工核实值</th><th>台账当前值</th></tr></thead><tbody>${keys.filter(k=>Object.hasOwn(actual,k)||['status','version'].includes(k)).map(k=>`<tr><th>${L.fields[k]}</th><td>${Object.hasOwn(actual,k)?esc(L.valueText(k,actual[k])):'未填写'}</td><td>${esc(L.valueText(k,a[k]))}</td></tr>`).join('')}</tbody></table><p>选择标准操作；多步处理时仅最后一步勾选关联。</p><div class="itl-resolution-menu">${L.menu(a)}</div>`;root.prepend(panel);
  };
  L.registerInventoryView=(key,view)=>{inventoryViews[key]=view;L.registerView(key,{render:()=>renderInventory(key)});};L.showInventoryView=key=>{if(inventoryViews[key])L.setTab(key);};
  L.currentInventoryView=()=>subview;
  L.registerView('stocktakes',{render:()=>renderInventory('stocktakes')});
  L.registerView('inventory-hooks',{onAccessLost(){sequence++;batch=null;context=null;paintBanner();Object.values(inventoryViews).forEach(v=>v.onAccessLost?.());}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-stock-open],[data-stock-command],[data-stock-check],[data-stock-note],[data-stock-resolve],[data-stock-context]');if(!b)return;
    const task=async()=>{
      if(b.dataset.stockOpen){selected=Number(b.dataset.stockOpen);subview='stocktakes';L.closeDrawer();L.setTab('stocktakes');return;}
      if(b.dataset.stockCheck)return checkItem(Number(b.dataset.stockCheck));if(b.dataset.stockNote)return noteForm(Number(b.dataset.stockNote));if(b.dataset.stockResolve)return resolve(Number(b.dataset.stockResolve));
      if(b.dataset.stockContext){if(b.dataset.stockContext==='cancel'){context=null;paintBanner();L.closeDrawer();}else if(context)await L.detail(context.assetId);return;}
      if(b.dataset.stockCommand==='create')createBatch();if(b.dataset.stockCommand==='back'){selected=null;await load();}if(b.dataset.stockCommand==='batch-note')await noteForm();if(b.dataset.stockCommand==='close')await closeBatch();
    };task().catch(error=>L.notice(error.message));
  });
})();
