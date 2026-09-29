/* Record corrections are explicit audited operations, separate from ordinary editing. */
(function(){
 'use strict';const L=window.ITLedger,{$,esc}=L;let sequence=0;
 const names={reclassify:'更正设备类别',void:'作废记录',delete:'撤销误建登记'};
 const scopes={active:'有效记录',voided:'已作废记录',deleted:'已删除记录'};
 const stamp=s=>s?new Date(s).toLocaleString('zh-CN'):'—';
 L.recordScopeControl=value=>`<label class="itl-record-scope">记录范围 <select data-record-scope>${Object.entries(scopes).map(([k,v])=>`<option value="${k}"${k===value?' selected':''}>${v}</option>`).join('')}</select></label>`;
 L.renderRecordArchive=async scope=>{
  if(scope==='active'){L.render();return;}if(!['voided','deleted'].includes(scope))return;
  L.closeDrawer();const seq=++sequence;$('#itlContent').innerHTML=`<section id="itlRecordArchive"><div class="itl-toolbar">${L.recordScopeControl(scope)}</div><p class="itl-muted">归档记录保留身份、历史和材料，不再参与正常业务；SN和资产编号仍保留。</p><div data-record-list>正在读取…</div></section>`;
  const root=$('#itlRecordArchive');try{const data=await L.api('?record_state='+scope);if(seq!==sequence||!root.isConnected)return;
   root.querySelector('[data-record-list]').innerHTML=`<div class="u-corr-table-wrap"><table class="u-corr-table"><thead><tr><th>资产</th><th>类别</th><th>编号</th><th>SN</th><th>记录状态</th></tr></thead><tbody>${data.items.map(a=>`<tr><td>${L.assetButton(a)}</td><td>${esc(L.categories[a.category])}</td><td>${esc(a.asset_no||'—')}</td><td>${esc(a.sn||'—')}</td><td>${esc(scopes[scope])}</td></tr>`).join('')||'<tr><td colspan="5" class="itl-empty">暂无此类记录</td></tr>'}</tbody></table></div>`;
  }catch(e){if(root.isConnected)root.querySelector('[data-record-list]').textContent=e.message;}
 };
 L.recordHistoryHTML=(control,history)=>`${control?`<div class="itl-notice"><strong>${esc(scopes[control.state])} · 只读</strong><p>${esc(control.reason)}</p><p>${esc(stamp(control.created_at))} · 操作人 #${control.operator_id}</p></div>`:''}${history.length?`<section class="u-detail-section itl-record-history"><h3>记录管理历史</h3>${[...history].reverse().map(r=>`<details><summary>${esc(names[r.action])} · ${esc(stamp(r.created_at))}</summary><p>${esc(r.reason)}</p>${r.action==='reclassify'?`<p>${esc(L.categories[r.before.category])} → ${esc(L.categories[r.after.category])}</p>`:''}<p class="itl-muted">操作人 #${r.operator_id} · 版本 ${r.before.version} → ${r.after.version}</p><details><summary>查看变更前后资料</summary><h4>变更前</h4><pre>${esc(JSON.stringify(r.before,null,2))}</pre><h4>变更后</h4><pre>${esc(JSON.stringify(r.after,null,2))}</pre></details></details>`).join('')}</section>`:''}`;
 L.mountAssetRecordControls=async(form,asset)=>{
  const original=JSON.stringify([...new FormData(form)].filter(([key])=>key!=='category'));
  const host=document.createElement('section');host.className='itl-record-controls';host.innerHTML='<h3>删除资产</h3><p class="itl-muted">正在核对删除条件…</p>';form.querySelector('.u-modal-body').append(host);
  const categoryHelp=form.querySelector('#itlCategoryChangeHelp');
  try{const info=await L.api('/'+asset.id+'/record-management');if(!host.isConnected)return;
   const select=form.elements.category;
   for(const option of select.options){const target=info.targets.find(t=>t.category===option.value);if(target&&!target.allowed){option.disabled=true;option.title=target.reason;}}
   select.disabled=false;
   const paintCategory=()=>{const target=info.targets.find(t=>t.category===select.value);categoryHelp.textContent=target?.allowed?`将从“${L.categories[asset.category]}”更正为“${L.categories[target.category]}”。保存后可继续补充新类别的专属资料；原类别不适用的字段会进入变更历史。`: '类别更正需单独核对并填写原因；选择其他可用类别后点“保存”。';};
   select.addEventListener('change',paintCategory);paintCategory();
   L.confirmCategoryChange=async(currentForm,currentAsset)=>{if(currentForm!==form||currentAsset.id!==asset.id)throw Error('请重新打开资产编辑页');const target=info.targets.find(t=>t.category===select.value);if(!target?.allowed)throw Object.assign(new Error(target?.reason||'此类别暂不能更正'),{field:'category'});if(JSON.stringify([...new FormData(form)].filter(([key])=>key!=='category'))!==original)throw Error('同时修改了其他资料，请先保存资料，再更正类别');openOperation(info,'reclassify',target.category);};
   host.innerHTML=`<h3>记录处置</h3>${info.delete_reason?`<p class="itl-muted">撤销误建登记不适用：${esc(info.delete_reason)}</p>`:`<p class="itl-muted">仅限从未投入使用、没有业务引用的误建记录。撤销后会从正常台账移出，历史和编号仍保留。</p><button type="button" class="u-btn-secondary" data-record-action="delete">撤销误建登记</button>`}${info.void_reason?'':`<details><summary>登记无效但已有使用历史？</summary><p class="itl-muted">可作废登记记录并保留完整历史。</p><button type="button" class="u-btn-secondary" data-record-action="void">作废记录</button></details>`}<details class="itl-purge-entry"><summary>高级操作：彻底删除</summary><p class="itl-muted">仅限从未使用、没有业务引用的误建记录。将永久移除资产资料及关联的 ${info.purge_events} 条操作事件，释放 SN 和资产编号；删除前的资料留存在管理员审计中，台账内无法恢复。</p><button type="button" class="u-btn-danger" data-purge-asset${info.purge_reason?' disabled':''}>彻底删除资产及历史</button>${info.purge_reason?`<p class="itl-muted">${esc(info.purge_reason)}</p>`:''}</details>`;
   host.querySelectorAll('[data-record-action]').forEach(b=>b.onclick=()=>{if(JSON.stringify([...new FormData(form)].filter(([key])=>key!=='category'))!==original||select.value!==asset.category){L.formError(new Error('有未保存的资料或类别修改，请先保存或恢复后再删除'));return;}openOperation(info,b.dataset.recordAction);});
   host.querySelector('[data-purge-asset]').onclick=()=>{if(JSON.stringify([...new FormData(form)].filter(([key])=>key!=='category'))!==original||select.value!==asset.category){L.formError(new Error('有未保存的资料或类别修改，请先保存或恢复后再彻底删除'));return;}openPurge(info);};
  }catch(e){if(host.isConnected)host.innerHTML=`<p class="itl-form-error">${esc(e.message)}</p>`;if(categoryHelp)categoryHelp.textContent='类别限制读取失败，请重新打开编辑页';}
 };
 function openPurge(info){
  const a=info.asset;
  L.openModal('彻底删除资产',`<div class="itl-notice"><strong>${esc(a.name)}</strong> · 资产 #${a.id}<p>资产资料和关联的 ${info.purge_events} 条操作事件将从台账永久移除，SN 和资产编号可重新使用；删除前的资料留存在管理员审计中。此操作无法恢复。</p></div>${L.formField('reason','删除原因','',{required:true,textarea:true,wide:true})}${L.formField('confirm_name','输入资产名称以确认','',{required:true,wide:true})}<label class="itl-record-confirm"><input type="checkbox" name="confirmed"> 我已核对删除范围</label>`,async form=>{
   if(!form.elements.confirmed.checked)throw Error('请先确认删除范围');
   const body={reason:form.elements.reason.value,confirm_name:form.elements.confirm_name.value,expected_version:a.version};
   if(!body.reason.trim())throw Error('请填写删除原因');
   if(body.confirm_name!==a.name)throw Error('输入的资产名称不一致');
   await L.api('/'+a.id+'/purge',{method:'DELETE',body:JSON.stringify(body)});
   L.closeModal(true);L.closeDrawer();L.setTab('all');await L.refresh();L.toast('资产及关联历史已彻底删除');
  },'确认彻底删除');
 }
 function openOperation(info,action,selectedCategory){
  const a=info.asset,choices=info.targets.filter(t=>t.allowed);
  L.openModal(names[action],`<p><strong>${esc(a.name)}</strong> · ${esc(L.categories[a.category])} · 资产 #${a.id}</p>${action==='reclassify'?`<div id="itlRecordPreview"></div>`:`<div class="itl-notice">${action==='void'?'作废的是登记记录，不代表实物设备报废。':'此处为可追溯的逻辑删除，不清除原始登记历史。'}记录将从正常列表移出；SN和资产编号仍保留，不可重复登记。提交后本界面不提供恢复。</div>`}${L.formField('reason','操作原因','',{required:true,textarea:true,wide:true})}<label class="itl-record-confirm"><input type="checkbox" name="confirmed"> 我已核对记录及操作影响</label>`,async form=>{
   if(!form.elements.confirmed.checked)throw Error('请先确认已核对记录及操作影响');
   const body={action,reason:form.elements.reason.value,expected_version:a.version,...(action==='reclassify'?{category:selectedCategory}:{})};
   if(!body.reason.trim())throw Error('请填写操作原因');await L.api('/'+a.id+'/record-management',{method:'POST',body:JSON.stringify(body)});L.closeModal(true);L.closeDrawer();await L.refresh();if(action==='reclassify')await L.detail(a.id);else{L.setTab('all');await L.renderRecordArchive(action==='void'?'voided':'deleted');await L.detail(a.id);}L.toast(names[action]+'已保存');
  },'确认'+names[action],{assetId:a.id});
  if(action==='reclassify'){const t=choices.find(t=>t.category===selectedCategory);$('#itlRecordPreview').innerHTML=`<div class="itl-record-preview"><p>${esc(L.categories[a.category])} → <strong>${esc(L.categories[t.category])}</strong></p><p>资产编号、SN、历史记录及合法的位置关系保留。</p><p>目标占用高度：${t.u_height}U · 盘位数：${t.slot_count}</p><p>保留属性：${esc(Object.keys(t.attrs).join('、')||'无同名专属字段')}</p><p>归档到旧快照的属性：${esc(t.archived_keys.join('、')||'无')}</p><p class="itl-muted">归档字段不带入新类别；原值可在记录管理历史查看。新类别其余专属资料可在更正后补齐。</p></div>`;}
 }
 document.addEventListener('change',e=>{if(e.target.matches('[data-record-scope]'))L.renderRecordArchive(e.target.value);});
 L.registerView('record-management-hooks',{onAccessLost(){sequence++;}});
})();
