// #208 C3：从真实 HTML AST 提取实际函数，验证版本关系、转义、协议与生命周期登记。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),acorn=require('acorn');
const file=process.env.C3_HTML_SOURCE||path.join(__dirname,'../public/Sys_Iteration.html');
const html=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
const script=Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),m=>m[1]).filter(x=>x.trim()).join('\n');
const ast=acorn.parse(script,{ecmaVersion:'latest'}), functions=new Map();
function walk(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&n.id)functions.set(n.id.name,script.slice(n.start,n.end));for(const [k,v]of Object.entries(n)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}}
walk(ast);
const names=['esc','siHoldNoteIsOrigin','siBuildHoldNoteIndex','siHoldNotePayload','siHoldNoteVersion','siHoldNoteOrphanText',
 'siHoldNoteAttachmentsAt','siHoldNoteAttachmentHtml','siHoldNoteChangeHtml','siRenderHoldNoteHtml','siHoldNoteOwnerId','siHoldNoteFormData',
 'siAttExt','siTlAttIsImage','siTlThumbHtml','siTlAttLinkHtml'];
for(const name of names)assert.ok(functions.has(name),'missing function '+name);
const token=id=>'e30.'+Buffer.from(JSON.stringify({id})).toString('base64url')+'.signature';
// 时间线图片预览（2026-11-21）：SI_IMG_EXTS 是 const 不在函数提取面内，从真实源码取字面量，不在测试里另抄一份。
const imgExtsSrc=/const SI_IMG_EXTS = (\[[^\]]*\]);/.exec(html);assert.ok(imgExtsSrc,'missing SI_IMG_EXTS');
const context={siDetail:null,siFmtDT:String,siOpenId:1,currentUser:{id:1},getToken:()=>token(1),atob,FormData,File,SI_IMG_EXTS:JSON.parse(imgExtsSrc[1].replace(/'/g,'"'))};
vm.createContext(context);vm.runInContext(names.map(n=>functions.get(n)).join('\n'),context);
let passed=0;function check(label,fn){try{fn();passed++;console.log('PASS '+label);}catch(e){throw new Error('FAIL '+label+': '+e.message,{cause:e});}}
const bad='<img src=x onerror=globalThis.__hnXss=1>.pdf';
const payload=(content,extra={})=>JSON.stringify({note_date:'2026-01-01',content,...extra});
const origin={id:10,event_type:'note',action_code:'hold_note',ref_id:null,payload_json:payload('<b>safe text</b>'),operator_name:bad,created_at:'time'};
const edit1={...origin,id:11,action_code:'hold_note_edit',ref_id:10,payload_json:payload('edit',{added_attachments:[{original_name:'资料.zip'}]})};
const edit2={...edit1,id:12,payload_json:payload('current',{removed_attachments:[{id:101,original_name:bad}]})};
context.siDetail={issue:{id:1,hold_note_editable_ids:[10]},hold_note_attachments:[
 {id:101,note_id:10,added_event_id:10,removed_event_id:12,status:'removed',original_name:bad},
 {id:102,note_id:10,added_event_id:11,removed_event_id:null,status:'active',original_name:'资料.zip'},
 {id:999,note_id:999,added_event_id:10,removed_event_id:null,status:'active',original_name:'foreign.pdf'}]};
check('C3 version attachments',()=>{
 for(const [event,expected]of [[10,[101]],[11,[101,102]],[12,[102]]])assert.deepStrictEqual(Array.from(context.siHoldNoteAttachmentsAt(10,event),a=>a.id),expected);
});
check('C3 current history escape',()=>{
 const index=context.siBuildHoldNoteIndex([edit2,origin,edit1]);
 const output=context.siRenderHoldNoteHtml(origin,index.byOrigin.get(10));
 assert.strictEqual((output.match(/siDownloadHoldNoteAtt\(/g)||[]).length,5);
 assert.ok(output.includes('移除了 &lt;img'));assert.ok(!output.includes('<img'));assert.ok(!output.includes('foreign.pdf'));
 assert.ok(output.includes('查看历史'));assert.ok(output.includes('编辑'));
});
check('C3 void keeps downloads',()=>{
 const voided={...origin,id:13,action_code:'hold_note_void',ref_id:10,payload_json:JSON.stringify({reason:bad})};
 const output=context.siRenderHoldNoteHtml(origin,context.siBuildHoldNoteIndex([origin,edit1,edit2,voided]).byOrigin.get(10));
 assert.ok(output.includes('已作废'));assert.ok(output.includes('siDownloadHoldNoteAtt('));
 assert.ok(!output.includes('onclick="siHoldNoteEdit'));assert.ok(!output.includes('<img'));
});
check('timeline image attachments thumbnail only, others download',()=>{
 const saved=context.siDetail;
 const imgBad='<img src=x onerror=globalThis.__hnXss=1>.PNG';
 context.siDetail={issue:{id:1},hold_note_attachments:[
  {id:201,note_id:20,added_event_id:20,removed_event_id:null,status:'active',original_name:'截图.png'},
  {id:202,note_id:20,added_event_id:20,removed_event_id:null,status:'active',original_name:imgBad},
  {id:203,note_id:20,added_event_id:20,removed_event_id:null,status:'active',original_name:'说明.pdf'}]};
 try{
  const out=context.siHoldNoteAttachmentHtml(20,20);
  // [时间线只留缩略图·2026-11-22 用户定] 两张图片各只有一个小图占位（不再有文件名按钮与 ⬇），pdf 只有原下载按钮。
  const THUMB='<img class="si-clickable-thumb si-att-thumb si-tl-thumb" ';
  const items=out.replace(/^<ul class="si-hn-attachments">|<\/ul>$/g,'').split('</li>').filter(Boolean).map(s=>s.replace(/^<li>/,''));
  assert.strictEqual(items.length,3,out);
  for(const it of items.slice(0,2))assert.ok(it.startsWith(THUMB)&&it.endsWith('data-att-kind="hold">')&&it.split('<').length-1===1&&!/onclick=/.test(it),'image item is exactly one thumbnail: '+it);
  assert.ok(items[0].includes(' title="截图.png（点击放大）" '),'hover shows the full file name: '+items[0]);
  assert.strictEqual((out.match(/siDownloadHoldNoteAtt\(1,(\d+)\)/g)||[]).join('|'),'siDownloadHoldNoteAtt(1,203)','only the pdf has a download button');
  assert.ok(!out.includes('siPreviewAttImage')&&!out.includes('⬇'),'no filename preview entry and no download icon for images');
  // 图片项合法地带一个小图占位 <img>，所以「不含 <img」改成：注入的原样标签不出现、每个 <img 都是缩略图占位、
  //   占位个数与编号恰为两张图片（pdf 没有），且都标 hold 端点。
  assert.ok(!out.includes('<img src=x'),'image file name must be escaped');
  assert.strictEqual(out.split('<img').length-1,out.split(THUMB).length-1,'every <img must be a timeline thumbnail placeholder');
  assert.strictEqual((out.match(/data-att-issue="1" data-att-id="(\d+)" data-att-name="[^"]*" data-att-kind="hold">/g)||[]).map(s=>/data-att-id="(\d+)"/.exec(s)[1]).join('|'),'201|202',out);
  assert.ok(!/<img[^>]*\ssrc=/.test(out.replace(/"[^"]*"/g,'""')),'placeholders carry no src (filled by siLoadAttThumbs)');   // 先抹掉属性值：转义后的坏文件名里含「src=」字样
  const att=context.siTlAttLinkHtml(7,{id:31,original_name:'凭证.JPEG'}),doc=context.siTlAttLinkHtml(7,{id:32,original_name:'交付.xlsx'});
  assert.ok(att.startsWith(THUMB)&&att.endsWith('data-att-issue="7" data-att-id="31" data-att-name="凭证.JPEG">')&&att.split('<').length-1===1&&!att.includes('onclick')&&!att.includes('data-att-kind'),'image entry is exactly one thumbnail: '+att);
  assert.ok(att.includes(' title="凭证.JPEG（点击放大）" '),att);
  assert.ok(!doc.includes('siPreviewAttImage')&&doc.includes('onclick="siDownloadAtt(7,32)"')&&!doc.includes('<img'),doc);
  const badAtt=context.siTlAttLinkHtml(7,{id:33,original_name:imgBad});
  assert.ok(!badAtt.includes('<img src=x')&&badAtt.split('<img').length-1===1&&badAtt.startsWith(THUMB),badAtt);
  for(const n of ['a.jpg','a.jpeg','a.gif','a.webp','a.bmp','A.PNG'])assert.strictEqual(context.siTlAttIsImage(n),true,n);
  for(const n of ['a.pdf','a.png.zip','png','',null,undefined])assert.strictEqual(context.siTlAttIsImage(n),false,String(n));
 }finally{context.siDetail=saved;}
});
check('C3 payload degradation',()=>{
 for(const payload_json of ['bad','[]','null','"x"'])assert.strictEqual(context.siHoldNoteChangeHtml({payload_json}),'');
 assert.strictEqual(context.siHoldNoteChangeHtml({payload_json:JSON.stringify({added_attachments:'bad',removed_attachments:[null]})}),'');
});
check('C3 FormData snapshot',()=>{
 const selection={files:[new File(['a'],'one.pdf')],removedIds:[101]};
 const data=context.siHoldNoteFormData({note_date:'2026-01-01',content:'text'},selection);
 selection.files.length=0;selection.removedIds.length=0;
 assert.strictEqual(data.get('content'),'text');assert.strictEqual(data.get('remove_attachment_ids'),'[101]');assert.strictEqual(data.getAll('files')[0].name,'one.pdf');
});
check('C3 account ownership',()=>{
 assert.strictEqual(context.siHoldNoteOwnerId(),1);context.getToken=()=>token(2);assert.strictEqual(context.siHoldNoteOwnerId(),0);
 context.currentUser={id:2};assert.strictEqual(context.siHoldNoteOwnerId(),2);context.getToken=()=>null;assert.strictEqual(context.siHoldNoteOwnerId(),0);
});
check('C3 picker reset lifecycle',()=>{
 for(const name of ['siOpenDrawer','siCloseDrawer','siCloseModal'])assert.ok(/\[[^\]]*'hold-note'[^\]]*\]\.forEach\(k => siPickerReset\(k\)\)/.test(functions.get(name)),name+' must reset hold-note');
 assert.ok(functions.get('siHoldNoteOpenForm').includes('siPickerReset(key)'));
 assert.ok(functions.get('siModal').includes("siPickerReset('hold-note')"));
 assert.ok(functions.get('siPickerCollect').includes('data-busy="1"'));
});
check('C3 audit snapshot section',()=>assert.ok(html.includes("['hold_note_attachments_json', '暂缓备注附件快照']")));
console.log('C3 note UI: '+passed+' groups passed');
