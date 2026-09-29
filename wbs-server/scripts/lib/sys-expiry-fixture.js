'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { listenOnSafePort } = require('./listen-safe-port');
const express = require('express'), sqlite3 = require('sqlite3');
module.exports = async function startFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'sys-expiry-'));
  const db = new sqlite3.Database(':memory:');
  const trace = [], logs = [], hooks = {};
  const rawRun = (sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this);}));
  const rawAll = (sql,args=[]) => new Promise((resolve,reject)=>db.all(sql,args,(e,rows)=>e?reject(e):resolve(rows)));
  const run = async (sql,args=[]) => { trace.push(sql); if(hooks.beforeRun) await hooks.beforeRun(sql,args); const result=await rawRun(sql,args); if(hooks.afterRun) await hooks.afterRun(sql,args); return result; };
  const all = async (sql,args=[]) => { const rows=await rawAll(sql,args); if(hooks.afterAll) await hooks.afterAll(sql,args,rows); return rows; };
  const get = async (sql,args=[]) => (await all(sql,args))[0];
  const user = {id:1,username:'test-admin',display_name:'测试管理员',role:'admin'};
  const auth = (req,res,next) => { if(req.headers.authorization!=='Bearer fixture-admin')return res.status(401).json({error:'未登录'});req.user=user;next(); };
  const logger = Object.fromEntries(['info','warn','error','debug'].map(level=>[level,(...args)=>logs.push({level,args})]));
  let server, mod;
  const stop = async () => {
    if(mod) await mod.stopExpirySweep();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
    const sub=path.join(root,'sys-iteration');if(fs.existsSync(sub))fs.rmdirSync(sub);fs.rmdirSync(root);
  };
  try {
    await run("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT,status TEXT DEFAULT 'active',phone TEXT,dingtalk_user_id TEXT)");
    await run("INSERT INTO users(id,username,display_name,role) VALUES(1,'test-admin','测试管理员','admin'),(5,'dev','测试开发','user'),(13,'wangtaotao','测试对接人','user'),(20,'executor','执行人甲','user'),(21,'executor2','执行人乙','user')");
    mod=require('../../routes/sys-iteration')({ logger,db,dbRunAsync:run,dbGetAsync:get,dbAllAsync:all,authenticateToken:auth,requireAdmin:(req,res,next)=>next(),
      ...require('../_sys-attach-test-deps'),UPLOAD_DIR:root,ALLOWED_FILE_DIRS:[root],expirySweepClock:options.clock,
      expirySweepTimers:options.timers,expirySweepEnabled:options.enabled===true });
    mod.initSchema(); if(options.stopBeforeReady)await mod.stopExpirySweep(); const deadline=Date.now()+15000;
    while(!mod._internals.SYS_SCHEMA_STATE.ready){if(mod._internals.SYS_SCHEMA_STATE.error||Date.now()>deadline)throw Error(mod._internals.SYS_SCHEMA_STATE.error||'schema timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    const app=express();app.use(express.json());app.use((req,res,next)=>{if(hooks.onRequest)hooks.onRequest(req);next();});app.use('/api',mod.router);
    app.get('/api/auth/me',auth,(req,res)=>res.json(user));
    app.use(express.static(path.resolve(__dirname,'../../public'),{etag:false,maxAge:0}));
    server=await listenOnSafePort(app); // #95: shared safe-port helper (20000-49999, bind retry on EADDRINUSE/EACCES only)
    const base='http://127.0.0.1:'+server.address().port;
    const api=async(method,url,body)=>{const r=await fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json',Connection:'close'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json()};};
    let seq=0;
    async function seed(authAt='2020-01-01 12:00:00', states=['pending','done']){
      const r=await api('POST','/sys-issues',{intake_contract_version:2,type:'bug',title:'到期扫描测试-'+(++seq),system_name:'BMS',source:'内部',description:'合成授权数据',intake_liaison_id:13});
      if(r.status!==201)throw Error(JSON.stringify(r));const id=r.body.id;
      await run("UPDATE sys_issues SET status='处理中',assigned_to=5,assigned_to_name='测试开发',fast_release_auth_by=1,fast_release_auth_by_name='测试管理员',fast_release_auth_at=?,fast_release_auth_note='测试授权' WHERE id=?",[authAt,id]);
      for(let index=0;index<states.length;index++)await run("INSERT INTO sys_fast_release_executors(issue_id,user_id,user_name,exec_status,executed_at,added_by,added_by_name) VALUES(?,?,?,?,?,1,'测试管理员')",[id,20+index,index?'执行人乙':'执行人甲',states[index],states[index]==='done'?'2020-01-01 15:00:00':null]);
      return id;
    }
    return {mod,db,api,base,seed,run,rawRun,all,get,trace,logs,hooks,stop};
  }catch(e){await stop();throw e;}
};
