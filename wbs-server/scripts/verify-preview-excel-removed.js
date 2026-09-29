// Runtime Express routing proof. Isolated code copy, new temporary SQLite files,
// synthetic keys, no .env copy, no listening socket and no startup callbacks.
'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');

function matchingHandlers(stack,url) {
  let count=0;
  for(const layer of stack) {
    if(!layer.match(url))continue;
    if(layer.route) {
      for(const handler of layer.route.stack) {
        assert.equal(typeof handler.handle,'function','route handler must be callable');
        count++;
      }
    } else if(layer.handle && Array.isArray(layer.handle.stack)) {
      count+=matchingHandlers(layer.handle.stack,url.slice(layer.path.length)||'/');
    }
  }
  return count;
}

if(process.argv[2]==='--child') {
  const isolated=path.resolve(process.argv[3]);
  const express=require('express'),sqlite=require('sqlite3');
  let captured;
  const originalListen=express.application.listen,OriginalDatabase=sqlite.Database;
  express.application.listen=function(){captured=this;return {close(){}};};
  sqlite.Database=function(filename,...rest){
    const resolved=path.resolve(filename);
    assert.ok(resolved.startsWith(isolated+path.sep),'every database must be inside the fresh isolated tree');
    return new OriginalDatabase(resolved,...rest);
  };
  sqlite.Database.prototype=OriginalDatabase.prototype;
  try {
    require(path.join(isolated,'server.js'));
    assert.ok(captured?._router?.stack,'runtime app stack captured after all routes registered');
    const count=matchingHandlers(captured._router.stack,'/api/preview/excel/x');
    assert.equal(count,0,'[preview-removed] matching runtime route handler count must be zero');
    // Prove the walker sees nested handlers and does not infer absence from HTTP 404.
    const probe=express(),router=express.Router();
    router.get('/excel/:filename',(_req,res)=>res.sendStatus(404));
    probe.use('/api/preview',router);
    assert.equal(matchingHandlers(probe._router.stack,'/api/preview/excel/x'),1,'nested 404 handler still counts');
    probe.get('/api/preview/excel/:filename',(_req,res)=>res.sendStatus(200));
    assert.equal(matchingHandlers(probe._router.stack,'/api/preview/excel/x'),2,'direct and nested handlers both count');
    console.log('PREVIEW_REMOVED PASS=4 FAIL=0 runtime_handlers='+count);
  }catch(error){console.error(error.stack);process.exitCode=1;}
  finally{express.application.listen=originalListen;sqlite.Database=OriginalDatabase;}
  // No event-loop turn is needed: registration is synchronous, and shutdown prevents
  // asynchronous migrations/background tasks from starting in this disposable child.
  process.exit(process.exitCode||0);
} else {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-route-'));
  try {
    console.log('ISOLATED_TREE='+dir);
    function copy(source,dest) {
      const stat=fs.lstatSync(source);
      assert.equal(stat.isSymbolicLink(),false,'fixture source must not contain junctions');
      if(stat.isDirectory()) {
        fs.mkdirSync(dest,{recursive:true});
        for(const name of fs.readdirSync(source))copy(path.join(source,name),path.join(dest,name));
      }else fs.copyFileSync(source,dest);
    }
    for(const name of ['server.js','package.json','routes','utils'])copy(path.join(root,name),path.join(dir,name));
    const r=spawnSync(process.execPath,[__filename,'--child',dir],{
      cwd:dir,encoding:'utf8',timeout:300000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,
      env:{...process.env,PORT:'0',JWT_SECRET:'preview-route-isolated-test-key',DB_ENCRYPTION_KEY:'0'.repeat(32),
        NODE_PATH:[path.join(root,'node_modules'),path.join(root,'..','node_modules'),process.env.NODE_PATH||''].join(path.delimiter)}
    });
    process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
    assert.equal(r.status,0,'isolated runtime route proof must pass');
  }finally{
    assert.equal(path.dirname(dir),os.tmpdir());
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
