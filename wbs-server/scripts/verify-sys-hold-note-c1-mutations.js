// #208 C1 诚实实现写错的定点变异。只编译进程私有源码副本，工作区源码不改；不连接业务实例。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { deleteTreeNoFollow } = require('../../scripts/lines/line-common');
const sourcePath = require.resolve('../routes/sys-iteration');
const originalBytes = fs.readFileSync(sourcePath);
const original = originalBytes.toString('utf8').replace(/\r\n/g,'\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const before = hash(originalBytes);
const work = fs.mkdtempSync(path.join(os.tmpdir(),'sys-note-c1-mutations-'));
const loader = path.join(work,'loader.cjs');
// Module 编译的 filename 保持真实路径，因此依赖解析与正常运行一致；仅此子进程替换工厂源码。
fs.writeFileSync(loader, `const Module=require('module'),fs=require('fs'),path=require('path');
const load=Module._load;
Module._load=function(id,parent,isMain){
 const resolved=Module._resolveFilename(id,parent,isMain);
 if(resolved!==process.env.C1_MUTATION_TARGET)return load.apply(this,arguments);
 if(Module._cache[resolved])return Module._cache[resolved].exports;
 const m=new Module(resolved,parent);m.filename=resolved;m.paths=Module._nodeModulePaths(path.dirname(resolved));
 Module._cache[resolved]=m;m._compile(fs.readFileSync(process.env.C1_MUTATION_SOURCE,'utf8'),resolved);return m.exports;
};\n`);
const cases = [
  ['M1-parse-return-raw',"catch (_) { payload = null; }","catch (_) { return e; }",'verify-sys-hold-note-attach.js','FAIL M-1 pure payload fail closed'],
  ['M1-nonobject-return-raw',"return { ...e, payload_json: null };","return e;",'verify-sys-hold-note-attach.js','FAIL M-1 pure payload fail closed'],
  ['M1-field-type-bypass','delete payload.added_attachments;','if (Array.isArray(payload.added_attachments)) delete payload.added_attachments;','verify-sys-hold-note-attach.js','FAIL M-1 pure payload fail closed'],
  ['M1-orphan-leak',"if (e.event_type !== 'note' || !['hold_note', 'hold_note_edit'].includes(e.action_code)) return e;","if (e.ref_id === 999999 || e.event_type !== 'note' || !['hold_note', 'hold_note_edit'].includes(e.action_code)) return e;",'verify-sys-hold-note-attach.js','FAIL M-1 M-2 HTTP projection'],
  ['M1-response-bypass','timeline: sysProjectHoldNoteTimeline(timeline, canSeeAttachmentList)','timeline: timeline','verify-sys-hold-note-attach.js','FAIL M-1 M-2 HTTP projection'],
  ['M2-legacy-hidden',"!['hold_note', 'hold_note_edit'].includes(e.action_code)","!['hold_note', 'hold_note_edit', 'attachment_added'].includes(e.action_code)",'verify-sys-hold-note-attach.js','M2_LEGACY'],
  ['L3-executor-lost','return roster.active || roster.historical || await sysAttachmentExecutorCanRead(row, actor.id);','return roster.active || roster.historical;','verify-sys-executor-attachments.js','all three types'],
  ['L4-admin-before-contract',"const cols = ['id', 'type', 'intake_liaison_id', 'release_id', 'release_assignee_id'];","if (actor.role === 'admin') return true;\n    const cols = ['id', 'type', 'intake_liaison_id', 'release_id', 'release_assignee_id'];",'verify-sys-hold-note-attach.js','FAIL L-4 row contract'],
  ['L4-null-rejected','row[c] === undefined','row[c] == null','verify-sys-hold-note-attach.js','FAIL L-4 row contract'],
  ['RL1-production-hook',"if (SYS_TEST_HOOKS_ENABLED && __testHooks.holdNoteAfterTimelineReadHook)","if (__testHooks.holdNoteAfterTimelineReadHook)",'verify-sys-hold-note-attach.js','FAIL R-L1 production hook gate subprocess'],
  ['download-read-lock-missing','noteReadRelease = await sysTxnMutex.acquire(5000);','noteReadRelease = () => {};','verify-sys-hold-note-attach.js','FAIL C1 note readers serialize'],
  ['audit-snapshot-empty','JSON.stringify(holdNoteAtts)',"JSON.stringify([])",'verify-sys-hold-note-attach.js','FAIL C1 deletion audit snapshot files'],
  ['audit-delete-missing',"await dbRunAsync('DELETE FROM sys_issue_hold_note_attachments WHERE issue_id = ?', [id]);",'// mutation: omitted note attachment DELETE','verify-sys-hold-note-attach.js','FAIL C1 deletion audit snapshot files'],
  ['audit-files-removed-kept','for (const a of atts.concat(holdNoteAtts))','for (const a of atts.concat(holdNoteAtts.filter(a => a.status === \'active\')))','verify-sys-hold-note-attach.js','FAIL C1 deletion audit snapshot files'],
  ['audit-mask-omitted',"'release_snapshots_json', 'hold_note_attachments_json'];","'release_snapshots_json'];",'verify-sys-hold-note-attach.js','FAIL C1 deletion audit snapshot files'],
];
let complete = false;
try {
  for (const [name,from,to,test,expected] of cases) {
    assert.strictEqual(original.split(from).length-1,1,'unique mutation anchor '+name);
    let mutated=original.replace(from,to);
    // M2 的回归是假如裁剪 helper 顺手裁旧事件；主动改旧字段，HTTP 对照组必须判红。
    if (expected === 'M2_LEGACY') {
      const anchor='delete payload.removed_attachments;';
      assert.strictEqual(mutated.split(anchor).length-1,1);
      mutated=mutated.replace(anchor,anchor+"\n      if (e.action_code === 'attachment_added') return {...e,summary:'',payload_json:null};");
    }
    const target=path.join(work,name+'.js'); fs.writeFileSync(target,mutated);
    const r=spawnSync(process.execPath,['-r',loader,path.join(__dirname,test)],{encoding:'utf8',timeout:30000,
      env:{...process.env,C1_MUTATION_TARGET:sourcePath,C1_MUTATION_SOURCE:target},maxBuffer:4*1024*1024});
    const output=(r.stdout||'')+(r.stderr||'');
    assert.strictEqual(r.error,undefined,name+': execution must finish, not timeout');
    assert.strictEqual(r.status,1,name+': must fail assertions (not an abort)\n'+output);
    const wanted=expected==='M2_LEGACY'?'FAIL M-1 M-2 HTTP projection':expected;
    assert.ok(output.includes(wanted),name+': wrong failure, expected '+wanted+'\n'+output);
    console.log('RED '+name+' | exit='+r.status+' | '+wanted);
  }
  assert.strictEqual(hash(fs.readFileSync(sourcePath)),before,'workspace source SHA256 unchanged');
  console.log('mutations '+cases.length+'/'+cases.length+' red; source SHA256 '+before+' unchanged');
  complete = true;
} finally {
  assert.strictEqual(hash(fs.readFileSync(sourcePath)),before,'source must remain unchanged even on error');
  if (complete) { deleteTreeNoFollow(work,[]); fs.rmdirSync(work); }
  else console.error('mutation evidence retained: '+work);
}
