/* Registration/edit whitelist and category placement. No position writes through PUT. */
(function () {
  'use strict';
  const L = window.ITLedger, { esc, $ } = L;
  const attrs = { server: { ip:'IP', purpose:'用途', os:'操作系统' }, disk: { capacity:'容量', interface:'接口', form_factor:'规格' }, laptop: { cpu:'CPU', ram:'内存', os:'操作系统' }, desktop: { cpu:'CPU', ram:'内存', os:'操作系统' }, ap: { ssid_group:'SSID 组', mgmt_ip:'管理 IP' }, other: { subtype:'设备类型', ip:'IP' }, software: { version:'版本', license_count:'许可数量', installed_on:'安装位置' }, subscription: { cycle:'订阅周期', account_name:'账号名（不填密码或令牌）', renew_method:'续费方式', vendor_portal:'厂商入口' } };
  const placementNames = { depot:'库房', rack:'机柜在位', host:'装入宿主', custodian:'保管人领用', place:'放置在指定位置' };
  const nullable = value => value.trim() === '' ? null : value;
  const software = category => ['software','subscription'].includes(category);
  function input(name,label,value='',options={}) {
    const id = 'itlField-'+name.replace(/\./g,'-');
    let control;
    if (options.choices) control = `<select id="${id}" name="${esc(name)}"${options.disabled ? ' disabled' : ''}>${options.choices.map(([v,l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (options.textarea) control = `<textarea id="${id}" name="${esc(name)}" rows="3">${esc(value)}</textarea>`;
    else control = `<input id="${id}" name="${esc(name)}" type="${options.type || 'text'}" value="${esc(value)}"${options.min !== undefined ? ` min="${options.min}"` : ''}${options.max !== undefined ? ` max="${options.max}"` : ''}${options.type === 'number' ? ` step="${options.step || 1}"` : ''}${options.disabled ? ' disabled' : ''}${options.required ? ' required' : ''}>`;
    return `<div class="itl-field${options.wide ? ' itl-field-wide' : ''}"><label for="${id}">${esc(label)}${options.required ? ' <span class="u-req">*</span>' : ''}</label>${control}<span class="itl-field-error" id="${id}-error"></span></div>`;
  }
  function bad(field,message) { throw Object.assign(new Error(message), { field }); }
  function integer(form,name,min,max=Number.MAX_SAFE_INTEGER) {
    const raw = form.elements.namedItem(name)?.value;
    const value = Number(raw);
    if (raw === '' || !Number.isSafeInteger(value) || value < min || value > max) bad(name, `请填写 ${min} 至 ${max === Number.MAX_SAFE_INTEGER ? '安全整数上限' : max} 的整数。`);
    return value;
  }
  // AP 登记只落库房：房间内坐标必须由人在 AP 平面上显式点出（ap_place），
  //   不再由登记流程代填房间中心，避免"未确认位置"与实测位置在平面图上无法区分。
  //   后端 placement.kind='room' 契约保持不变，仅收前端入口。
  function kinds(category,height) { return category === 'server' || category === 'other' && height > 0 ? ['depot','rack'] : category === 'disk' ? ['depot','host'] : ['laptop','desktop'].includes(category) ? ['depot','custodian'] : category === 'ap' ? ['depot'] : category === 'other' ? ['depot','place'] : []; }
  let openingSequence = 0;
  L.openAssetForm = async function (id, prefill = {}) {
    if (!L.canWrite()) return;
    const seq = ++openingSequence;
    try {
      const detail=id?await L.api('/'+id):null;if(detail?.record_control)throw new Error('该记录已归档，只能查阅历史');const asset=detail?.asset||null;
      // Fetch reference choices for this intent; retain these versions for the whole dialog.
      const [assetList,racks] = await Promise.all([L.api(),L.api('/racks')]);
      if (seq !== openingSequence || !L.canWrite()) return;
      const references = { assets:assetList.items, racks:racks.items };
      const values = asset || { category:'server', name:'', u_height:1, slot_count:0, ...prefill };
      let category = values.category;
      const originalAttrText = {};
      const base = ['name','brand','model','sn','asset_no','owner_name','owner_dept'];
      const html = `<fieldset><legend>基本信息</legend><div class="itl-form-grid">${input('category','类别',category,{ choices:category===''?[['','请选择类别'],...Object.entries(L.categories)]:Object.entries(L.categories), required:true })}${asset?'<p id="itlCategoryChangeHelp" class="u-hint itl-field-wide">正在核对可变更的类别…</p>':''}${base.map(key => input(key,L.fields[key],values[key],{required:key === 'name'})).join('')}${input('asset_class','资产分类',values.asset_class,{choices:[['','未填写'],['fixed','固定资产'],['low_value','低值易耗']]})}${input('purchased_at','购置日期',values.purchased_at,{type:'date'})}<div id="itlCategoryFields" class="itl-form-grid itl-field-wide"></div>${L.isAdmin() ? input('fin_amount','购置金额',values.fin_amount,{type:'number',step:'any'})+input('fin_vendor','供应商',values.fin_vendor)+input('fin_contract_no','合同编号',values.fin_contract_no) : ''}${input('note','备注',values.note,{textarea:true,wide:true})}</div></fieldset><fieldset id="itlPlacementGroup"><legend>当前位置</legend><div id="itlPlacement" class="itl-form-grid"></div></fieldset>`;
      L.openModal(asset ? '编辑资产资料' : '登记设备',html,async form => {
        if (asset && form.elements.category.value !== asset.category) {
          await L.confirmCategoryChange(form,asset);
          return;
        }
        const get = name => form.elements.namedItem(name)?.value ?? '';
        if(!Object.hasOwn(L.categories,category))bad('category','请选择资产类别，不能根据册面名称自动推断。');
        if (!get('name').trim()) bad('name','请填写资产名称。');
        const payload = {};
        base.concat(['asset_class','purchased_at','note']).forEach(key => { payload[key] = key === 'name' ? get(key) : nullable(get(key)); });
        if (asset) { payload.expected_version = asset.version; Object.assign(payload,L.resolutionProtocol?.(asset.id,form)||{}); } else payload.category = category;
        if (!software(category) || !asset) {
          if (category === 'subscription' && !get('expires_at')) bad('expires_at','订阅必须填写到期日期。');
          payload.expires_at = nullable(get('expires_at'));
        }
        if (['server','other'].includes(category)) {
          payload.u_height = integer(form,'u_height',category === 'server' ? 1 : 0,category === 'server' ? 8 : undefined);
          payload.slot_count = integer(form,'slot_count',0);
        } else if (!asset) { payload.u_height = 0; payload.slot_count = 0; }
        const nextAttrs = {};
        for (const key of Object.keys(attrs[category])) {
          const text = get('attrs.'+key);
          if (asset && text === originalAttrText[key] && Object.hasOwn(asset.attrs,key)) nextAttrs[key] = asset.attrs[key];
          else if (text !== '') nextAttrs[key] = text;
        }
        payload.attrs = nextAttrs;
        if (L.isAdmin()) {
          payload.fin_vendor = nullable(get('fin_vendor')); payload.fin_contract_no = nullable(get('fin_contract_no'));
          payload.fin_amount = get('fin_amount') === '' ? null : Number(get('fin_amount'));
          if (payload.fin_amount !== null && !Number.isFinite(payload.fin_amount)) bad('fin_amount','金额必须是有效数字。');
        }
        if (!asset && !software(category)) {
          const kind = get('placement.kind');
          const p = { kind };
          if (kind === 'depot') p.status = get('placement.status');
          if (kind === 'rack') { p.rack_id = integer(form,'placement.rack_id',1); p.u_start = integer(form,'placement.u_start',1); }
          if (kind === 'host') {
            p.parent_asset_id = integer(form,'placement.parent_asset_id',1); p.slot_no = integer(form,'placement.slot_no',1);
            const host = references.assets.find(a => a.id === p.parent_asset_id);
            if (!host) bad('placement.parent_asset_id','请选择宿主设备。');
            payload.peer_versions = { [host.id]:host.version };
          }
          if (kind === 'custodian') { p.custodian_name = get('placement.custodian_name').trim(); p.location_text = nullable(get('placement.location_text')); if (!p.custodian_name) bad('placement.custodian_name','请填写保管人姓名。'); }
          if (kind === 'place') { p.location_text = get('placement.location_text').trim(); if (!p.location_text) bad('placement.location_text','请填写位置。'); }
          payload.placement = p;
        }
        const saved = await L.api(asset ? '/'+asset.id : '',{method:asset ? 'PUT' : 'POST',body:JSON.stringify(payload)});
        if(payload.stocktake_item_id)L.resolutionCommitted?.(payload.stocktake_item_id);
        L.closeModal(true); L.closeDrawer(); await L.refresh(); L.toast(asset ? '资料已保存' : '设备已登记');
        if (!asset && category === 'ap') L.setTab('aps');
        else await L.detail(saved.id);
      },'保存',{assetId:asset?.id});
      const form = $('#itlForm');
      if (asset) form.elements.category.disabled = true;
      function categoryFields() {
        if(!Object.hasOwn(attrs,category)){$('#itlCategoryFields').innerHTML='<p class="u-hint itl-field-wide">请先选择类别，再填写专属字段与当前位置。</p>';$('#itlPlacementGroup').hidden=true;$('#itlPlacement').replaceChildren();return;}
        const height = category === values.category ? values.u_height : category === 'server' ? 1 : 0;
        const count = category === values.category ? values.slot_count : 0;
        $('#itlCategoryFields').innerHTML = `${['server','other'].includes(category) ? input('u_height','占用 U 数',height,{type:'number',min:category === 'server' ? 1 : 0,max:category === 'server' ? 8 : undefined,required:true,disabled:!!asset?.rack_id})+input('slot_count','盘位数',count,{type:'number',min:0,required:true}) : ''}${!software(category) || !asset ? input('expires_at',software(category) ? '到期日期' : '质保到期日期',values.expires_at,{type:'date',required:category === 'subscription'}) : '<p class="u-hint itl-field-wide">软件和订阅的到期日期请通过“续费”调整。</p>'}${Object.entries(attrs[category]).map(([key,label]) => { const value = category === values.category ? values.attrs?.[key] : ''; const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); originalAttrText[key] = text; return input('attrs.'+key,label,text); }).join('')}`;
        form.elements.namedItem('u_height')?.addEventListener('input',placementFields);
        placementFields();
      }
      function placementFields() {
        if (asset) { $('#itlPlacementGroup').hidden = true; return; }
        const allowed = kinds(category,Number(form.elements.namedItem('u_height')?.value || 0));
        $('#itlPlacementGroup').hidden = !allowed.length;
        if (!allowed.length) { $('#itlPlacement').replaceChildren(); return; }
        const previous = form.elements.namedItem('placement.kind')?.value;
        $('#itlPlacement').innerHTML = input('placement.kind','位置方式',allowed.includes(previous) ? previous : allowed[0],{choices:allowed.map(k => [k,placementNames[k]])})+'<div id="itlPlacementFields" class="itl-form-grid itl-field-wide"></div>';
        form.elements.namedItem('placement.kind').addEventListener('change',placementDetails);
        placementDetails();
      }
      function placementDetails() {
        const kind = form.elements.namedItem('placement.kind').value;
        let html = '';
        if (kind === 'depot') html = input('placement.status','库房状态','in_depot',{choices:['in_depot','faulty','to_retire'].map(s => [s,L.statuses[s]])})+(category === 'ap' ? '<p class="u-hint itl-field-wide">AP 先登记进库房，随后在"AP 平面"页选中它并上架到房间内的真实位置。</p>' : '');
        if (kind === 'rack') html = input('placement.rack_id','机柜','',{required:true,choices:[['','请选择机柜'],...references.racks.map(r => [r.id,`${r.name} · ${r.u_total}U`])]})+input('placement.u_start','起始 U',1,{type:'number',min:1,required:true});
        if (kind === 'host') html = input('placement.parent_asset_id','宿主','',{required:true,choices:[['','请选择宿主'],...references.assets.filter(a => ['server','other'].includes(a.category) && a.slot_count > 0 && ['in_service','in_depot','faulty','to_retire'].includes(a.status) && a.u_height > 0).map(a => [a.id,`${a.name} · ${L.statuses[a.status]} · ${a.slot_count} 盘位`])]})+input('placement.slot_no','盘位编号',1,{type:'number',min:1,required:true});
        if (kind === 'custodian') html = input('placement.custodian_name','保管人姓名','',{required:true})+input('placement.location_text','位置（可选）');
        if (kind === 'place') html = input('placement.location_text','位置','',{required:true,wide:true});
        $('#itlPlacementFields').innerHTML = html;
      }
      if (!asset) form.elements.category.addEventListener('change',e => { category = e.target.value; categoryFields(); });
      categoryFields();
      if(asset)L.mountAssetRecordControls(form,asset);
    } catch (error) { L.notice(error.message); }
  };
  L.formField = input;
})();
