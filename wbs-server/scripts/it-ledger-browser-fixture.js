/* Isolated real ledger router for browser checks. Never reads .env or task_pool.db.
 * Synthetic authentication is local to this random-port fixture; no production route changes.
 */
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3');
// L5（C7-c，Opus预筛）：records-browser.js/evidence-browser.js两处此前各自手写一份
// it_device_inspections的CREATE TABLE语句（同一份DDL两处维护，容易漂移）——改成直接调用生产代码
// inspection-collect.js的ensure(q)。ensure()只调用两次q.run(sql)（建表+建索引），不碰
// collector/recordManagement，构造时传null占位安全（不会被ensure用到，本文件也不调用collect的其它
// 任何方法）；q参数只要求有一个.run(sql,args)方法，f.run本身的签名（Promise<{lastID,changes}>）与
// 路由内部q.run完全兼容，直接把{run:f.run}传进去即可。
const createInspectionCollectForTests = require('../routes/it-ledger/inspection-collect');
const inspectionCollectDDL = createInspectionCollectForTests({ collector: null, recordManagement: null });
async function ensureDeviceInspectionsTable(f) { await inspectionCollectDDL.ensure({ run: f.run }); }
// C1（长任务 E · 巡检台账）：5 号是第二个写权限用户，专供「其他写权限者」角色测（不是巡检人也
//   不是管理员，用于验证 §4.1 权限矩阵里对既有单据全「否」的一行）。不进默认 ACL 插入——调用方
//   需要它时自己 `f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)")`，
//   保持其余既有套件（未显式插入 5 号 ACL 的用例）行为不变。
const users = [null, { id:1, username:'fixture-admin', display_name:'测试管理员', role:'admin' }, { id:2, username:'fixture-write', display_name:'测试维护员', role:'user' }, { id:3, username:'fixture-read', display_name:'测试查阅员', role:'user' }, { id:4, username:'fixture-none', display_name:'未授权测试员', role:'user' }, { id:5, username:'fixture-write2', display_name:'测试维护员二', role:'user' }];
// M4（G2A2b 必修）：违规谓词——写请求内、事务外的任何 SQL，不再按表名限定（旧版只认五张巡检单
//   相关表，是从两个具体高危路径反推出来的收窄，但"写路由锁外不读库"这条性质该覆盖全部表，不只是
//   已知出过事的那几张）。只在这里定义一次并导出（修 L5），sheets/photos/collect 三个接口测试文件
//   与正向对照/detach对照全部引用这一份，不在各处各写一份正则/条件。
// G3A（41S/41T 审查订正保证边界）→ G3A-b（M6：探针入口扩到 assertWrite）：这条谓词判定的前提
//   是 rec 来自 probeSql——只有经 routes/it-ledger/index.js 的 withRead / withWrite 注入的
//   q.get/all/run/assertWrite 四个入口才会调用 probeSql。保证范围只到这里为止：路由文件（或其
//   require 的本地助手模块）若自行引入数据库驱动、绕开这四个入口直接执行 SQL，根本不会产生
//   rec，这条谓词也就无从判定——那部分由 R10 结构规则挡住（G3A-b M5 起白名单式全等比较，覆盖
//   inspection-sheets.js / inspections.js / inspection-collect.js / inspection-photo-files.js
//   四个文件），不是本谓词或运行时探针本身的职责，不存在"任何写法都绕不过"这种无限定的保证。
function isProbeViolation(rec) { return rec.writeRequest === true && rec.inWriteTxn !== true; }
// M2（G2A2b 必修）：逐路由接通断言用的 method+path → 路由key 归一化——sheets/photos/collect 三个
//   接口测试文件共用同一份实现，不各自维护一份容易长歪的归一化逻辑。只认
//   /api/it-assets/inspections/sheets 这一族路径（巡检单路由），其它路径返回 null。
function normalizeInspectionRouteKey(method, fullPath) {
  const m = (method || '').toLowerCase();
  const p = (fullPath || '').split('?')[0];
  const prefix = '/api/it-assets/inspections/sheets';
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  if (rest === '') return m + ':/';
  if (rest === '/archive') return m + ':/archive';
  const segs = rest.split('/').filter(Boolean);
  if (segs.length === 1) return m + ':/:id';
  if (segs.length === 2 && ['submit', 'restore', 'unarchive', 'photos', 'pending-photos'].includes(segs[1])) return m + ':/:id/' + segs[1];
  if (segs.length === 3 && segs[1] === 'photos') return m + ':/:id/photos/:photoId';
  if (segs.length === 4 && segs[1] === 'items' && segs[3] === 'collect') return m + ':/:id/items/:itemId/collect';
  return m + ':' + rest;
}
async function createFixture(options = {}) {
  if (process.env.IT_LEDGER_E2E_COPY === '1' && !options.seedInternal) {
    const seed = await createFixture({...options,seedInternal:true});
    await seed.close();
    const seedHash = crypto.createHash('sha256').update(fs.readFileSync(seed.dbFile)).digest('hex');
    const fixture = await createFixture({...options,seedInternal:true,dbCopyPath:seed.dbFile,cleanup:true});
    fs.unlinkSync(seed.dbFile);
    const sourceDir=path.join(seed.dir,'sources');if(fs.existsSync(sourceDir))fs.rmdirSync(sourceDir);
    fs.rmdirSync(seed.dir);
    fs.writeFileSync(path.join(fixture.dir,'db-copy.json'),JSON.stringify({seed:seed.dbFile,copy:fixture.dbFile,seedHash,copyHash:fixture.copyHash,seedRemoved:!fs.existsSync(seed.dbFile)},null,2));
    return fixture;
  }
  // G2A2 Commit2（主会话裁定，未完成清单第1条）：sqlProbe:'collect' 便捷选项——夹具内部建一个
  //   收集器数组，暴露 probeViolations()/probeRecordCount() 给调用方，不用每个子套件各自手写
  //   收集器 + 断言样板。调用方仍需显式传 enableTestHooks:true（与其它测试专用 seam 同一道闸，
  //   不由本夹具替调用方决定）。options.sqlProbe 传函数时原样透传（sheets.js 走这条，自己收集）。
  // M1（G2A2b 必修）：sqlProbe:'collect' 但没开 enableTestHooks——这个便捷收集器永远收不到任何
  //   记录（探针本身在生产/非测试模式下是空操作），静默返回空数组会让调用方误以为"跑了但违规数
  //   为0"，其实是"根本没接通"，是彻头彻尾的假阴性。直接抛错，逼调用方要么同时传
  //   enableTestHooks:true，要么不要用这个便捷选项。
  let internalProbeRecords = null;
  let sqlProbeForFactory = options.sqlProbe;
  if (options.sqlProbe === 'collect') {
    if (options.enableTestHooks !== true) {
      throw new Error("createFixture: sqlProbe:'collect' 需要同时传 enableTestHooks:true，否则探针不会被接通（不静默返回空）");
    }
    internalProbeRecords = [];
    sqlProbeForFactory = (rec) => internalProbeRecords.push(rec);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'it-ledger-browser-'));
  const dbFile = path.join(dir,'fixture.db');
  let copyHash;
  if(options.dbCopyPath){fs.copyFileSync(options.dbCopyPath,dbFile);copyHash=crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');}
  const db = new sqlite3.Database(dbFile);
  const run = (sql,args=[]) => new Promise((resolve,reject) => db.run(sql,args,function (err) { err ? reject(err) : resolve({lastID:this.lastID,changes:this.changes}); }));
  // Assertions use a distinct read-only connection, never the fixture setup writer.
  const all = (sql,args=[]) => new Promise((resolve,reject) => {
    const reader = new sqlite3.Database(dbFile,sqlite3.OPEN_READONLY,openError => {
      if(openError){reject(openError);return;}
      reader.all(sql,args,(readError,rows) => reader.close(closeError => {
        const error=readError||closeError;error?reject(error):resolve(rows);
      }));
    });
  });
  if(!options.dbCopyPath){
    await run('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, display_name TEXT, role TEXT, status TEXT)');
    for (const u of users.filter(Boolean)) await run('INSERT INTO users VALUES (?,?,?,?,?,?)',[u.id,u.username,'unused-fixture',u.display_name,u.role,'active']);
  }
  const app = express(); app.use(express.json());
  const authenticateToken = (req,res,next) => {
    const token = /^Bearer fixture-([1-5])$/.exec(req.headers.authorization || '');
    if (!token) return res.status(401).json({error:'fixture login required'});
    req.user = {...users[Number(token[1])]}; next();
  };
  const requireAdmin = (req,res,next) => req.user?.role === 'admin' ? next() : res.status(403).json({error:'admin required'});
  // C2b：inspectionSheetTestHooks 只在调用方显式传时才透传（生产 fixture 用途默认不传，undefined）。
  // C2f：inspectionSheetTestHooks 会改写行为，index.js 只在 deps.enableTestHooks===true 时才真的
  //   把它交给 inspection-sheets.js——调用方需要这个注入点生效，必须显式在 options 里也传
  //   enableTestHooks:true（不传时即使传了 inspectionSheetTestHooks 也会被闸挡住，静默按 undefined
  //   处理），本夹具本身不替调用方决定，原样透传 options.enableTestHooks（默认 undefined）。
  // C2g：logger 可选透传——默认沿用原来"只打印不落变量"的实现（行为不变）；调用方需要断言"服务端
  //   error 日志里确实出现了某段唯一标记文本"时（如证明 500 来自某个精确限定的测试触发器，而不是
  //   同一事务里别的原因），传自己的 logger 对象把 error(...) 参数收进数组即可，不强制所有调用方
  //   改动。
  const logger = options.logger || {info(){},warn(){},error(...args){console.error(...args);}};
  // G2A2：sqlProbe 同 inspectionSheetTestHooks 的透传约定——只在调用方显式传时才带上，index.js
  //   只在 deps.enableTestHooks===true 时才真的把它接到 _testHooks.sqlProbe（不传即 undefined，
  //   其它测试不受影响）。
  const ledger = require(options.factoryPath || '../routes/it-ledger')({logger,DB_FILE:dbFile,authenticateToken,requireAdmin,reconcileStorageDir:path.join(dir,'sources'),inspectionStorageDir:path.join(dir,'evidence'),inspectionSheetStorageDir:path.join(dir,'sheet-photos'),inspectionSheetTestHooks:options.inspectionSheetTestHooks,enableTestHooks:options.enableTestHooks,inspectionCollector:options.inspectionCollector,sqlProbe:sqlProbeForFactory});
  await ledger.initSchema();
  if(!options.dbCopyPath)await run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (2,'write',1),(3,'read',1)");
  app.get('/api/auth/me',authenticateToken,(req,res) => res.json(req.user));
  app.use('/api',ledger.router);
  // Only unrelated platform startup endpoints are fixtures; every it-assets request is real.
  app.get(['/api/task-tips','/api/pool','/api/transfers/pending','/api/models','/api/admin/todos'],(req,res) => res.json([]));
  app.get('/api/my-workspace',authenticateToken,(req,res) => res.json({stats:{in_progress:0,pending_confirm:0,completed_week:0,completed_month:0,completed_total:0,published_count:0},claimed:[],my_pending_review:[],transfers:[],pending_confirm:[],published:[],my_completed:[]}));
  app.use(express.static(path.join(__dirname,'../public')));
  const server = await listenOnSafePort(app);
  const base = 'http://127.0.0.1:'+server.address().port;
  async function api(method,endpoint,body,uid=1) {
    const response = await fetch(base+'/api/it-assets'+endpoint,{method,headers:{Authorization:'Bearer fixture-'+uid,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const json = await response.json(); return {status:response.status,body:json};
  }
  // G2A2：透出 ledger._internals（含仅 enableTestHooks===true 时才有的 ledgerRequestContext）——
  // 供接口测试构造"写请求上下文里发生一次锁外读"的正向对照场景。不传 enableTestHooks 时
  // internals.ledgerRequestContext 就不存在，与生产装配一致，不影响既有不使用它的测试。
  // G2A2 Commit2：probeRecords()全量快照(浅拷贝)/probeViolations()按isProbeViolation过滤
  //   （M4：写请求内事务外的任何SQL，不再限定表名）/probeRecordCount()计数——sqlProbe不是
  //   'collect'时(调用方自己传函数)这三个方法返回空，不报错，调用方按需判断。
  function probeRecords() { return internalProbeRecords ? internalProbeRecords.slice() : []; }
  function probeViolations() { return probeRecords().filter(isProbeViolation); }
  function probeRecordCount() { return internalProbeRecords ? internalProbeRecords.length : 0; }
  // M2（G2A2b 必修）：接通断言的配套计数——本子套件内 writeRequest 且 inWriteTxn 的记录数，供
  //   调用方证明"探针确实跑过、不是零违规却也是空跑"（违规数为0 有两种可能：真的没违规，或者探针
  //   压根没接通，两者外观相同，必须额外证明后者不成立）。
  function probeInTxnCount() { return probeRecords().filter((r) => r.writeRequest === true && r.inWriteTxn === true).length; }
  return {dir,dbFile,base,api,run,all,copyHash,internals:ledger._internals,probeRecords,probeViolations,probeRecordCount,probeInTxnCount,async close(){
    await new Promise((resolve,reject) => server.close(err => err ? reject(err) : resolve())); await ledger.shutdown(); await new Promise((resolve,reject) => db.close(err => err ? reject(err) : resolve()));
    if(options.cleanup){
      const sources=path.join(dir,'sources'),evidence=path.join(dir,'evidence'),sheetPhotos=path.join(dir,'sheet-photos');
      const files=[dbFile,path.join(dir,'fixture.db-journal')].filter(p=>fs.existsSync(p));
      if(fs.existsSync(sources))for(const entry of fs.readdirSync(sources,{withFileTypes:true})){
        if(!entry.isFile())throw Error('Unexpected source entry: '+entry.name);
        files.push(path.join(sources,entry.name));
      }
      if(fs.existsSync(evidence))for(const entry of fs.readdirSync(evidence,{withFileTypes:true})){if(!entry.isFile())throw Error('Unexpected evidence entry');files.push(path.join(evidence,entry.name));}
      // C2：sheet-photos 目录同 evidence 写法——逐文件列入清单、不递归删（目录本身只在为空时 rmdir）。
      if(fs.existsSync(sheetPhotos))for(const entry of fs.readdirSync(sheetPhotos,{withFileTypes:true})){if(!entry.isFile())throw Error('Unexpected sheet-photos entry');files.push(path.join(sheetPhotos,entry.name));}
      for(const p of files){const rel=path.relative(dir,fs.realpathSync(p));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Cleanup outside fixture');}
      fs.writeFileSync(path.join(dir,'cleanup-manifest.json'),JSON.stringify({files,completed:false},null,2));
      for(const p of files)fs.unlinkSync(p);
      if(fs.existsSync(sources))fs.rmdirSync(sources);
      if(fs.existsSync(evidence))fs.rmdirSync(evidence);
      if(fs.existsSync(sheetPhotos))fs.rmdirSync(sheetPhotos);
      fs.writeFileSync(path.join(dir,'cleanup-manifest.json'),JSON.stringify({files,completed:files.every(p=>!fs.existsSync(p))},null,2));
    }
  }};
}
module.exports = {createFixture, isProbeViolation, normalizeInspectionRouteKey, ensureDeviceInspectionsTable};
