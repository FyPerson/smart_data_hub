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
 'siHoldNoteAttachmentsAt','siHoldNoteAttachmentHtml','siHoldNoteChangeHtml','siRenderHoldNoteHtml','siHoldNoteOwnerId','siHoldNoteFormData'];
for(const name of names)assert.ok(functions.has(name),'missing function '+name);
const token=id=>'e30.'+Buffer.from(JSON.stringify({id})).toString('base64url')+'.signature';
const context={siDetail:null,siFmtDT:String,siOpenId:1,currentUser:{id:1},getToken:()=>token(1),atob,FormData,File};
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
