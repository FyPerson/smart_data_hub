'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),http=require('http'),assert=require('assert/strict');
const express=require('express'),XLSX=require('xlsx');

module.exports=async function verifyR4({check,withTimeout,rawAllOn,rawRunOn,logger}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'it-reconcile-r4-')),serverRoot=path.join(root,'server'),db=path.join(root,'fixture.db');
  const uploads=path.join(serverRoot,'uploads'),archive=path.join(serverRoot,'archive'),publicRoot=path.join(serverRoot,'public'),store=path.join(serverRoot,'routes','it-ledger','uploads','it-reconcile');
  for(const dir of [uploads,archive,publicRoot,store])fs.mkdirSync(dir,{recursive:true});
  let mod,server;const all=(sql,args=[])=>withTimeout(rawAllOn(db,sql,args),5000,'R4 read'),run=(sql,args=[])=>withTimeout(rawRunOn(db,sql,args),5000,'R4 fixture write');
  const same=(a,b)=>{try{assert.deepStrictEqual(a,b);return true;}catch(_){return false;}};
  const snapshot=async()=>({assets:await all('SELECT * FROM it_assets ORDER BY id'),events:await all('SELECT * FROM it_asset_events ORDER BY id')});
  const readonlyState=async()=>{const result={};for(const table of ['it_assets','it_asset_events','it_stocktakes','it_stocktake_items','it_reconciles','it_reconcile_items'])result[table]=await all(`SELECT * FROM ${table} ORDER BY id`);return result;};
  try{
    await run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT)');for(const id of [1,2,3])await run('INSERT INTO users VALUES(?,?,?,?)',[id,'user'+id,'User '+id,id===1?'admin':'user']);
    // Clone production modules without changing business code; resolve only npm package imports
    // to the installed dependencies. This exercises the real __dirname-based default storage,
    // instead of proving only that an injected safer test directory is private.
    const sourceDir=path.resolve(__dirname,'../routes/it-ledger'),cloneDir=path.join(serverRoot,'routes','it-ledger');
    const builtins=new Set(require('module').builtinModules);
    for(const filename of fs.readdirSync(sourceDir).filter(name=>name.endsWith('.js'))){
      const code=fs.readFileSync(path.join(sourceDir,filename),'utf8').replace(/require\((['"])([^'"]+)\1\)/g,(literal,quote,name)=>name.startsWith('.')||builtins.has(name.replace(/^node:/,''))?literal:`require(${JSON.stringify(require.resolve(name))})`);
      fs.writeFileSync(path.join(cloneDir,filename),code,'utf8');
    }
    mod=require(path.join(cloneDir,'index.js'))({logger,DB_FILE:db,
      authenticateToken:(req,res,next)=>{if(!req.headers['x-test-id'])return res.status(401).json({code:'TEST_UNAUTHORIZED'});req.user={id:Number(req.headers['x-test-id']),role:req.headers['x-test-id']==='1'?'admin':'user'};next();},
      requireAdmin:(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({code:'LEDGER_FORBIDDEN'})});
    await withTimeout(mod.initSchema(),15000,'R4 init');check('R4临时ready',mod._internals.state.ready===true);
    const app=express();app.use(express.json());
    // F1 uses verbatim production static middleware with only filesystem roots/app injected.
    const serverSource=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
    const start="app.use(express.static(path.join(__dirname, 'public'), {",end="app.use('/archive', express.static(ARCHIVE_DIR));";
    assert.equal(serverSource.split(start).length,2);assert.equal(serverSource.split(end).length,2);
    const staticSource=serverSource.slice(serverSource.indexOf(start),serverSource.indexOf(end)+end.length);
    vm.runInNewContext(staticSource,{app,express,path,fs,__dirname:serverRoot,UPLOAD_DIR:uploads,ARCHIVE_DIR:archive},{timeout:5000});
    const allowedSource=serverSource.match(/const ALLOWED_FILE_DIRS = \[UPLOAD_DIR, ARCHIVE_DIR\];/g);assert.equal(allowedSource.length,1);
    const allowed=vm.runInNewContext(allowedSource[0]+' ALLOWED_FILE_DIRS;',{UPLOAD_DIR:uploads,ARCHIVE_DIR:archive});
    check('R4 F1私有物理目录不在任何公开根或白名单', [publicRoot,...allowed].every(dir=>path.relative(dir,store).startsWith('..'+path.sep)));
    app.use('/api',mod.router);server=await withTimeout(listenOnSafePort(app, null), 5000, 'R4 listen');
    const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/api/it-assets',headers=id=>id===null?{}:{'x-test-id':String(id??1)};
    async function api(method,url,body,id=1){const before=method==='GET'?await readonlyState():null;const result=await withTimeout((async()=>{const response=await fetch(base+url,{method,headers:{...headers(id),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};})(),15000,'R4 HTTP');if(before)check('R4读取无论成功/拒绝六表全等',same(before,await readonlyState()));return result;}
    async function ok(label,method,url,body,id=1){const before=await snapshot(),r=await api(method,url,body,id);check(label+':200',r.status===200,JSON.stringify(r));if(r.status!==200)throw Error(label);check(label+':资产事件全行全等',same(before,await snapshot()));return r.body;}
    const rows=[['a','=1+1',null,null,'Book Owner','Book Dept','+SUM(1,2)',9876],['N','Nullable',null,null,null,null,null,100],['amb','-2',null,null,null,null,null,200],['NEW','@cmd',null,null,null,null,null,300],['GONE','Gone',null,null,null,null,null,400]];
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['编号','资产名称','品牌','型号','责任人','部门','备注','金额'],...rows]),'固定资产');const original=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
    async function batch(){const before=await snapshot(),form=new FormData();form.append('file',new Blob([original]),'敏感财务盘点.xlsx');const response=await withTimeout(fetch(base+'/reconciles',{method:'POST',headers:headers(1),body:form}),15000,'R4 upload');const data=await response.json();check('R4上传201',response.status===201,JSON.stringify(data));if(response.status!==201)throw Error('R4 upload');check('R4上传不写资产事件',same(before,await snapshot()));return data;}
    for(const [id,level]of [[2,'write'],[3,'read']])check('R4ACL夹具',(await api('PUT',`/acl/${id}`,{level})).status===200);
    const definitions=[['A','Original A'],['N','Nullable'],['amb','Candidate 1'],['AMB','Candidate 2'],[null,'No number'],['BAD SPACE','Bad number'],['GONE','Gone']],ids=[];
    for(const [number,name]of definitions){const body={category:'laptop',name,brand:null,model:'',fin_amount:888,fin_vendor:'Private',fin_contract_no:'Contract',owner_name:number==='A'?'Ledger Owner':null,owner_dept:number==='A'?'Book Dept':null,asset_class:number==='A'?'fixed':null,sn:number==='A'?'SN-A':null,placement:number==='A'?{kind:'custodian',custodian_name:'User',location_text:'Old room'}:{kind:'depot',status:'in_depot'}};const r=await api('POST','',body);check('R4资产夹具201',r.status===201,JSON.stringify(r));if(r.status!==201)throw Error('R4 fixture');ids.push(r.body.id);await run('UPDATE it_assets SET asset_no=? WHERE id=?',[number,r.body.id]);}
    const b=await batch();let detail=await ok('R4详情','GET',`/reconciles/${b.id}`);check('R4七明细非空',detail.items.length===7);
    const find=key=>detail.items.find(item=>item.external_key===key),a=find('A'),n=find('N'),gone=find('GONE');
    const actual={name:'Observed independently',location_desc:'Actual room',owner_dept:null};
    for(const [item,result]of [[a,'mismatch'],[n,'found'],[gone,'missing'],[find('NEW'),'ledger_added'],[find('AMB'),'ledger_fixed']])await ok('R4关闭路径check','PUT',`/reconciles/${b.id}/items/${item.id}/check`,{result,...(result==='mismatch'?{actual}:{})},2);
    await ok('R4关闭路径bulk','PUT',`/reconciles/${b.id}/items/bulk-confirm-off-book`,{item_ids:detail.items.filter(item=>item.result==='not_in_sheet').map(item=>item.id)},2);
    await ok('R4关闭路径close','POST',`/reconciles/${b.id}/close`,{});
    await ok('R4公式前缀备注','PUT',`/reconciles/${b.id}/items/${a.id}/note`,{note:'\t=HYPERLINK("https://invalid.example")'},2);
    const oldRows=await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id',[b.id]);
    const edit=await api('PUT',`/${ids[0]}`,{expected_version:1,name:'Current A',model:'Changed',owner_name:'Updated Owner'});check('R4闭批后台账正常编辑',edit.status===200,JSON.stringify(edit));
    check('R4仅version变化夹具',(await api('PUT',`/${ids[1]}`,{expected_version:1,note:'Only metadata'})).status===200);
    check('R4事后补登记夹具',(await api('POST','',{category:'other',name:'Later NEW',asset_no:'NEW',placement:{kind:'depot',status:'in_depot'}})).status===201);
    await run("UPDATE it_assets SET asset_no='FIXED-CANDIDATE' WHERE id=?",[ids[2]]);await run('DELETE FROM it_assets WHERE id=?',[ids[6]]);
    const exportStart=Date.now();const exported=await ok('R4关闭路径export','GET',`/reconciles/${b.id}/export`),exportEnd=Date.now();
    const columns=[['external_asset_no','册面编号'],['external_dept','册面部门'],['external_device_type','册面设备名称'],['external_asset_name','册面资产名称'],['external_brand','册面品牌'],['external_model','册面型号'],['external_purchased_at','册面购置日期'],['external_amount','册面购置金额'],['external_owner_name','册面责任人'],['external_remark','册面备注'],['external_retired_hint','是否报废册'],['snapshot_asset_no','快照编号'],['snapshot_name','快照名称'],['snapshot_status','快照状态'],['snapshot_location_desc','快照位置'],['snapshot_owner_name','快照财务责任人'],['snapshot_owner_dept','快照财务部门'],['current_asset_no','台账编号'],['current_name','台账名称'],['current_category','类别'],['current_sn','SN'],['current_status','当前状态'],['current_location_desc','当前位置'],['current_owner_name','财务责任人'],['current_owner_dept','财务部门'],['current_asset_class','财务分类'],['current_custodian_name','使用保管人'],['link_state','台账关联状态'],['result','结果'],['ledger_no_state','台账编号情况'],['external_snapshot_diff','册面与快照差异'],['snapshot_current_diff','快照与当前差异'],['actual_fields','人工核实字段'],['checked_by','核对人'],['checked_at','核对时间'],['note','盘点备注']];
    check('R4admin36列手写顺序全等',same(exported.columns.map(col=>[col.key,col.label]),columns));
    check('R4四组/冻结三列/两隐藏列',same(exported.groups.map(group=>group.label),['册面','台账·建批次快照','台账·导出时实时','盘点'])&&same(exported.groups.map(group=>group.keys.length),[11,6,11,8])&&exported.freeze_columns===3&&same(exported.columns.filter(col=>col.hidden).map(col=>col.key),['external_device_type','external_remark']));
    check('R4每行恰36键且表头无重名',exported.rows.length===7&&exported.rows.every(row=>same(Object.keys(row),columns.map(col=>col[0])))&&new Set(exported.columns.map(col=>col.label)).size===36);
    check('R4时间戳及冻结说明/已全核实',Date.parse(exported.exported_at)>=exportStart&&Date.parse(exported.exported_at)<=exportEnd&&exported.notice.includes('核对结论在批次关闭后已冻结')&&exported.has_unverified===false);
    const ar=exported.rows.find(row=>row.external_asset_no==='a'),nr=exported.rows.find(row=>row.external_asset_no==='N'),amb=exported.rows.find(row=>row.external_asset_no==='amb'),missing=exported.rows.find(row=>row.external_asset_no==='NEW'),gr=exported.rows.find(row=>row.external_asset_no==='GONE');
    check('R4册面快照差异恰六映射且编号双向归一',ar.external_snapshot_diff==='name、owner_name');
    check('R4快照当前差异不含version',ar.snapshot_current_diff==='name、model、owner_name'&&nr.snapshot_current_diff==='');
    check('R4null和空串相等',nr.external_snapshot_diff==='');
    check('R4实际值/快照/当前三证据不混用',same(JSON.parse(ar.actual_fields),actual)&&ar.snapshot_name==='Original A'&&ar.current_name==='Current A'&&ar.snapshot_location_desc==='User / Old room');
    check('R4人工声明带明文提示',missing.result==='ledger_added（人工声明，待新批次验证）'&&amb.result==='ledger_fixed（人工声明，待新批次验证）');
    const currentKeys=columns.map(col=>col[0]).filter(key=>key.startsWith('current_'));
    check('R4无台账不按编号补关联',missing.link_state==='无对应台账'&&currentKeys.every(key=>missing[key]===null)&&missing.external_snapshot_diff==='不适用'&&missing.snapshot_current_diff==='不适用');
    check('R4歧义个数来自快照不随修复改变',amb.link_state==='编号歧义（2 条）'&&amb.ledger_no_state==='编号歧义'&&currentKeys.every(key=>amb[key]===null)&&amb.external_snapshot_diff==='不适用'&&amb.snapshot_current_diff==='不适用');
    check('R4原引用异常与未填字段分开',gr.link_state==='原引用异常'&&gr.snapshot_current_diff==='不适用'&&nr.link_state==='字段未填'&&ar.link_state==='');
    check('R4册外无比较对象不制造假差异',exported.rows.filter(row=>row.external_asset_no===null).every(row=>row.external_snapshot_diff==='不适用'));
    check('R4编号空/异常快照标签',exported.rows.some(row=>row.ledger_no_state==='未填编号')&&exported.rows.some(row=>row.ledger_no_state==='编号格式异常'));
    check('R4整个批次历史明细未被导出修改',same(oldRows,await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id',[b.id])));
    const sensitive=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,v])=>['fin_amount','fin_vendor','fin_contract_no','external_amount','stored_name'].includes(key)||sensitive(v));
    for(const id of [2,3]){
      const exp=await ok('R4非admin导出','GET',`/reconciles/${b.id}/export`,undefined,id),dt=await ok('R4非admin详情','GET',`/reconciles/${b.id}`,undefined,id),ls=await ok('R4非admin列表','GET','/reconciles',undefined,id);
      check('R4非admin35列/七行/嵌套无财务',same(exp.columns.map(col=>[col.key,col.label]),columns.filter(col=>col[0]!=='external_amount'))&&exp.rows.length===7&&!sensitive(exp)&&!sensitive(dt)&&!sensitive(ls)&&!exp.groups.some(group=>group.keys.includes('external_amount')));
      const row=exp.rows.find(row=>row.external_asset_no==='a');check('R4owner三列仍可见',row.current_owner_name==='Updated Owner'&&row.current_owner_dept==='Book Dept'&&row.current_asset_class==='fixed');
    }
    check('R4admin金额对照真实非空',ar.external_amount===9876);
    const financeExpected=['external_amount','fin_amount','fin_contract_no','fin_vendor'];check('R4财务集合手写全等',same([...mod._internals.FINANCE_FIELDS].sort(),financeExpected));
    for(const table of ['it_assets','it_asset_events','it_reconcile_items'])for(const col of await all(`PRAGMA table_info(${table})`))if(/^fin_|amount/i.test(col.name))check('R4财务命名提醒 '+table+'.'+col.name,financeExpected.includes(col.name));
    async function download(id,user=1){const before=await readonlyState();const result=await withTimeout((async()=>{const response=await fetch(base+`/reconciles/${id}/source-file`,{headers:headers(user)});return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};})(),15000,'R4 download');check('R4下载无论成功/拒绝六表全等',same(before,await readonlyState()));return result;}
    const stored=JSON.parse((await all('SELECT source_meta FROM it_reconciles WHERE id=?',[b.id]))[0].source_meta).stored_name;
    check('R4 F1按生产默认目录实际落盘',fs.readFileSync(path.join(store,stored)).equals(original));
    const dlBefore=await snapshot(),adminFile=await download(b.id);check('R4 F1 admin原件逐字节相等且闭批可下载',adminFile.status===200&&adminFile.bytes.equals(original));check('R4下载原始中文名/无stored_name/不缓存',decodeURIComponent(adminFile.headers.get('content-disposition')).includes('敏感财务盘点.xlsx')&&!adminFile.headers.get('content-disposition').includes(stored)&&adminFile.headers.get('cache-control').includes('no-store'));
    for(const user of [2,3,99,null]){const r=await download(b.id,user);check('R4 F1原件权限拒绝 '+user,r.status===(user===null?401:403)&&!r.bytes.equals(original));}
    check('R4原件下载族资产事件全等',same(dlBefore,await snapshot()));
    for(const user of [99,null]){const r=await api('GET',`/reconciles/${b.id}/export`,undefined,user);check('R4导出ACL '+user,r.status===(user===null?401:403));}
    const originalPath=path.join(store,stored);fs.renameSync(originalPath,originalPath+'.backup');check('R4文件缺失404',(await download(b.id)).status===404);fs.renameSync(originalPath+'.backup',originalPath);
    const sourceText=(await all('SELECT source_meta FROM it_reconciles WHERE id=?',[b.id]))[0].source_meta;await run('UPDATE it_reconciles SET source_meta=? WHERE id=?',[JSON.stringify({...JSON.parse(sourceText),stored_name:'../public/public.txt'}),b.id]);check('R4恶意存储名不能越界',(await download(b.id)).status===500);await run('UPDATE it_reconciles SET source_meta=? WHERE id=?',[sourceText,b.id]);
    // F1 direct HTTP requests keep raw URL encodings (fetch would normalize some dot segments).
    const rawRequest=url=>withTimeout(new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:url},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks)}));});req.on('error',reject);}),10000,'R4 F1 raw HTTP');
    for(const [dir,url]of [[publicRoot,'/public.txt'],[uploads,'/uploads/public.txt'],[archive,'/archive/public.txt']]){fs.writeFileSync(path.join(dir,'public.txt'),'R4 PUBLIC');const r=await rawRequest(url);check('R4 F1公开路由阳性 '+url,r.status===200&&r.bytes.toString()==='R4 PUBLIC');}
    // serve-static's default fallthrough passes pre-file 4xx to next(), so Express finally returns 404.
    const probes=[['/uploads/it-reconcile/'+stored,404],['/archive/it-reconcile/'+stored,404],['/routes/it-ledger/uploads/it-reconcile/'+stored,404],['/uploads/IT-RECONCILE/'+stored,404],['/uploads/it%2Dreconcile/'+stored,404],['/uploads/%69t-reconcile/'+stored,404],['/uploads/it-reconcile%2F'+stored,404],['/uploads/%2e%2e%2froutes%2fit-ledger%2fuploads%2fit-reconcile%2f'+stored,404],['/uploads/%2e%2e%5croutes%5cit-ledger%5cuploads%5cit-reconcile%5c'+stored,404],['/uploads/%252e%252e/routes/it-ledger/uploads/it-reconcile/'+stored,404]];
    for(const [url,status]of probes){const r=await rawRequest(url);check('R4 F1原件旁路 '+url,r.status===status&&!r.bytes.equals(original),`status=${r.status}`);}
    // F1 real attachExport -> browser vendor SheetJS -> actual XLSX bytes -> workbook readback.
    const vendor=require('../public/assets/vendor/xlsx.mini.min.js');let click,captured,error;
    const button={innerHTML:'Export',disabled:false,addEventListener:(event,fn)=>{assert.equal(event,'click');click=fn;}};
    const browser={window:{},document:{querySelector:()=>button},XLSX:{...vendor,writeFile:(wb,filename)=>{captured={wb,filename};}},console,Date};
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../public/assets/js/u-export.js'),'utf8'),browser,{timeout:5000});
    browser.window.UnifyHelpers.attachExport({buttonSelector:'#export',getViewRows:()=>exported.rows,columns:exported.columns,filename:'R4-F1',onError:e=>{error=e;}});assert.equal(typeof click,'function');click();
    check('R4 F1真实attachExport触发写出',!error&&!!captured&&captured.filename==='R4-F1.xlsx',error&&error.message);if(!captured)throw Error('F1 no workbook');
    const bytes=vendor.write(captured.wb,{type:'buffer',bookType:'xlsx'}),roundTrip=vendor.read(bytes,{type:'buffer',cellFormula:true}),sheet=roundTrip.Sheets[roundTrip.SheetNames[0]];
    const cells=Object.entries(sheet).filter(([key])=>!key.startsWith('!')).map(([,cell])=>cell);
    const safeCell=cell=>{assert.equal(cell.t,'s','R4_FORMULA_TEXT');assert.equal(Object.hasOwn(cell,'f'),false,'R4_FORMULA_TEXT');};
    let safe=true;try{cells.forEach(safeCell);}catch(_){safe=false;}check('R4 F1导出实际文件全为字符串且无公式',safe);
    for(const sample of ['=1+1','+SUM(1,2)','@cmd','-2','\t=HYPERLINK("https://invalid.example")'])check('R4 F1危险前缀保留原文 '+sample,cells.some(cell=>cell.v===sample&&cell.t==='s'&&!Object.hasOwn(cell,'f')));
    const badBook=vendor.utils.book_new();vendor.utils.book_append_sheet(badBook,{'!ref':'A1',A1:{t:'s',f:'1+1',v:'2'}},'Unsafe');const bad=vendor.read(vendor.write(badBook,{type:'buffer',bookType:'xlsx'}),{type:'buffer',cellFormula:true}).Sheets.Unsafe.A1;let hit=false;try{safeCell(bad);}catch(e){hit=e.code==='ERR_ASSERTION'&&e.message.includes('R4_FORMULA_TEXT');}check('R4 F1同判据能击中真实公式负对照',hit&&bad.t==='s'&&bad.f==='1+1');
    const open=await batch(),openExport=await ok('R4未核实导出提示','GET',`/reconciles/${open.id}/export`);check('R4未核实显著说明',openExport.has_unverified&&openExport.notice.includes('本批次含未核实项'));
    await ok('R4force关闭','POST',`/reconciles/${open.id}/close`,{force:true});check('R4force后提示保留',(await ok('R4force导出','GET',`/reconciles/${open.id}/export`)).notice.includes('本批次含未核实项'));
    const deletion=await batch(),delName=JSON.parse((await all('SELECT source_meta FROM it_reconciles WHERE id=?',[deletion.id]))[0].source_meta).stored_name;await ok('R4删除路径delete','DELETE',`/reconciles/${deletion.id}`);check('R4删除路径文件消失且下载404',!fs.existsSync(path.join(store,delName))&&(await download(deletion.id)).status===404);
  }finally{
    if(server)await withTimeout(new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())),5000,'R4 server close');
    if(mod)await withTimeout(mod.shutdown(),10000,'R4 shutdown');
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('it-reconcile-r4-'));
    fs.rmSync(root,{recursive:true,force:false});
  }
};
