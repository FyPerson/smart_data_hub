// #208 C2：私有副本编译变异，命中目标断言且 exit=1 才认判红，不写工作区源码。
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert');
const {spawnSync}=require('child_process');
const {deleteTreeNoFollow}=require('../../scripts/lines/line-common');
const sourcePath=require.resolve('../routes/sys-iteration'), bytes=fs.readFileSync(sourcePath), source=bytes.toString('utf8').replace(/\r\n/g,'\n');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'), before=sha(bytes);
const work=fs.mkdtempSync(path.join(os.tmpdir(),'sys-note-c2-mutations-')), loader=path.join(work,'loader.cjs');
fs.writeFileSync(loader,`const Module=require('module'),fs=require('fs'),path=require('path'),load=Module._load;
Module._load=function(id,parent,isMain){const filename=Module._resolveFilename(id,parent,isMain);
if(filename!==process.env.C2_MUTATION_TARGET)return load.apply(this,arguments);
if(Module._cache[filename])return Module._cache[filename].exports;
const m=new Module(filename,parent);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));Module._cache[filename]=m;
m._compile(fs.readFileSync(process.env.C2_MUTATION_SOURCE,'utf8'),filename);return m.exports;};\n`);
const c=(name,changes,group,full=false)=>({name,changes,group,full});
const cases=[
 c('multipart-missing',[["sysUploadMw('files', 5, true), (req, res) => holdNoteSaveEndpoint(req, res, false)","(req, res, next) => next(), (req, res) => holdNoteSaveEndpoint(req, res, false)"]],'C2 JSON and multipart count'),
 c('allow-six-files',[["limits: { fileSize: ARCHIVE_MAX_SIZE + 1, files: 5 }","limits: { fileSize: ARCHIVE_MAX_SIZE + 1, files: 6 }"],["sysUploadMw('files', 5, true), (req, res) => holdNoteSaveEndpoint(req, res, false)","sysUploadMw('files', 6, true), (req, res) => holdNoteSaveEndpoint(req, res, false)"]],'C2 JSON and multipart count'),
 c('ordinary-size-50',[["spec:       { exts: SYS_BASE_EXTS.concat(ARCHIVE_EXTS), sizeByExt: ARCHIVE_SIZE_BY_EXT, defaultSize: 20 * 1024 * 1024 }","spec:       { exts: SYS_BASE_EXTS.concat(ARCHIVE_EXTS), sizeByExt: ARCHIVE_SIZE_BY_EXT, defaultSize: 50 * 1024 * 1024 }"]],'C2 real byte size boundaries',true),
 c('archive-boundary-off-by-one',[["limits: { fileSize: ARCHIVE_MAX_SIZE + 1, files: 5 }","limits: { fileSize: ARCHIVE_MAX_SIZE, files: 5 }"]],'C2 real byte size boundaries',true),
 c('exe-allowed',[["const SYS_BASE_EXTS = ['.jpg'","const SYS_BASE_EXTS = ['.exe', '.jpg'"]],'C2 file names whitelist and invalid text'),
 c('batch-rejection-guard-missing',[["req.__sysHoldNoteStrictUpload = true;","req.__sysHoldNoteStrictUpload = false;"]],'C2 file names whitelist and invalid text'),
 c('non-author-allowed',[["if (!(aid > 0) || Number(origin.operator_id) !== aid) return { ok: false, http: 403, code: 'HOLD_NOTE_NOT_AUTHOR'","if (false) return { ok: false, http: 403, code: 'HOLD_NOTE_NOT_AUTHOR'"]],'C2 authors and foreign remove ids'),
 c('old-round-allowed',[["if (!(nid > anchor)) return { ok: false, http: 409","if (false) return { ok: false, http: 409"]],'C2 state gates all types'),
 c('persisted-state-not-checked',[["if (!rowsMatch || !storedEvent || !Object.keys(eventFields).every(k => storedEvent[k] === eventFields[k]))","if (false)"]],'C2 rollback after real writes and recheck'),
 c('rollback-files-not-cleaned',[["if (state === 'rolledBack') for (const file of movedPaths)","if (false) for (const file of movedPaths)"]],'C2 rollback after real writes and recheck'),
 c('note-id-directory',[["const finalDir = path.join(SYS_UPLOAD_BASE, String(issueId), 'hold-notes');","const finalDir = path.join(SYS_UPLOAD_BASE, String(issueId), 'hold-notes', String(noteId));"]],'C2 versions remove retain bytes'),
 c('removed-bytes-deleted',[["if (SYS_TEST_HOOKS_ENABLED && __testHooks.holdNoteAfterPersistHook) {","for (const a of removing) fs.unlinkSync(path.resolve(UPLOAD_DIR, a.file_name));\n      if (SYS_TEST_HOOKS_ENABLED && __testHooks.holdNoteAfterPersistHook) {"]],'C2 versions remove retain bytes'),
 c('collision-overwrites',[["if (fs.existsSync(finalPath)) throw new SysTransitionError(500, 'HOLD_NOTE_FILE_COLLISION', '附件存储冲突，请重试');","// mutation: overwrite existing target"]],'L-1 L-2 R-L2 collision immutable target'),
 c('idle-rolls-back-foreign',[["if (state === 'inTxn') {\n        try { await dbRunAsync('ROLLBACK'); state = 'rolledBack'; }","if (state !== 'committed') {\n        try { await dbRunAsync('ROLLBACK'); state = 'rolledBack'; }"]],'C2 BEGIN failure preserves foreign transaction'),
 c('uncertain-files-deleted',[["if (state === 'rollbackUnconfirmed') {\n        try { logger.error('[系统迭代] 备注附件回滚未确认'","if (state === 'rollbackUnconfirmed') {\n        for (const p of movedPaths) fs.unlinkSync(p);\n        try { logger.error('[系统迭代] 备注附件回滚未确认'"]],'C2 rollback unconfirmed retains orphan and id reuse'),
 c('uuid-production-hook-active',[["SYS_TEST_HOOKS_ENABLED && __testHooks.holdNoteUuidHook ?","__testHooks.holdNoteUuidHook ?"]],'R-L2 production UUID guard subprocess'),
];
let complete=false;
try{
 for(const t of cases){
  let changed=source;
  for(const [from,to]of t.changes){assert.strictEqual(changed.split(from).length-1,1,'unique anchor '+t.name);changed=changed.replace(from,to);}
  const file=path.join(work,t.name+'.js');fs.writeFileSync(file,changed);
  const args=['-r',loader,path.join(__dirname,'verify-sys-hold-note-write.js'),...(t.full?[]:['--fast'])];
  const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:45000,maxBuffer:6*1024*1024,
    env:{...process.env,C2_MUTATION_TARGET:sourcePath,C2_MUTATION_SOURCE:file}});
  const output=(r.stdout||'')+(r.stderr||'');
  assert.strictEqual(r.error,undefined,'mutation must finish '+t.name);
  assert.strictEqual(r.status,1,'mutation must assert-fail '+t.name+'\n'+output);
  assert.ok(output.includes('FAIL '+t.group),'wrong failure '+t.name+'\n'+output);
  console.log('RED '+t.name+' | exit=1 | FAIL '+t.group);
 }
 assert.strictEqual(sha(fs.readFileSync(sourcePath)),before);
 console.log('mutations '+cases.length+'/'+cases.length+' red; source SHA256 '+before+' unchanged');complete=true;
}finally{
 assert.strictEqual(sha(fs.readFileSync(sourcePath)),before,'workspace source unchanged even on failure');
 if(complete){deleteTreeNoFollow(work,[]);fs.rmdirSync(work);}else console.error('mutation evidence retained: '+work);
}
