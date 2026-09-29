// One unchanged golden assertion, run against either original or isolated mutant.
'use strict';
const fs=require('fs'),path=require('path');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const [kind,factoryPath,evidence]=process.argv.slice(2);
 const f=await createFixture({factoryPath});
 const call=async(method,url,body,status)=>{const r=await f.api(method,url,body);if(r.status!==status)throw Error('SETUP '+JSON.stringify(r));return r.body;};
 const snapshot=async()=>{const out={};for(const table of ['it_assets','it_asset_events','it_stocktakes','it_stocktake_items'])out[table]=await f.all('SELECT * FROM '+table+' ORDER BY id');return out;};
 try{
  let request,expectedStatus,expectedCode;
  if(kind==='version'){
   const a=await call('POST','',{category:'other',name:'version probe',placement:{kind:'depot'}},201);
   request=()=>f.api('POST','/'+a.id+'/actions/mark_status',{expected_version:a.version+10,status:'faulty'});expectedStatus=409;expectedCode='VERSION_CONFLICT';
  }else if(kind==='overlap'){
   const rack=await call('POST','/racks',{name:'probe',u_total:42},201);
   await call('POST','',{category:'server',name:'occupied',u_height:2,placement:{kind:'rack',rack_id:rack.id,u_start:1}},201);
   const a=await call('POST','',{category:'server',name:'moving',u_height:2,placement:{kind:'depot'}},201);
   request=()=>f.api('POST','/'+a.id+'/actions/rack_in',{expected_version:a.version,rack_id:rack.id,u_start:1});expectedStatus=409;expectedCode='RACK_SLOT_OCCUPIED';
  }else if(kind==='closed'){
   await call('POST','',{category:'other',name:'closed probe',placement:{kind:'depot'}},201);
   const b=await call('POST','/stocktakes',{title:'probe'},201);
   const detail=await call('GET','/stocktakes/'+b.id,undefined,200);
   if(detail.items.length!==1)throw Error('SETUP item count');
   await call('POST','/stocktakes/'+b.id+'/close',{force:true},200);
   request=()=>f.api('PUT','/stocktakes/'+b.id+'/items/'+detail.items[0].id,{result:'found'});expectedStatus=400;expectedCode='LEDGER_BAD_REQUEST';
  }else throw Error('Unknown probe');
  const before=await snapshot(),response=await request(),after=await snapshot();
  const unchanged=JSON.stringify(before)===JSON.stringify(after);
  const ok=response.status===expectedStatus&&response.body.code===expectedCode&&unchanged;
  fs.writeFileSync(evidence,JSON.stringify({kind,expectedStatus,expectedCode,response,before,after,unchanged,assertion:'golden rejection and complete rows unchanged',ok},null,2));
  console.log('TARGET_ASSERTION '+(ok?'PASS':'FAIL'));process.exitCode=ok?0:1;
 }finally{
  await f.close();
  // Only this fixture's exact files; unexpected leftovers are errors, never recursive deletion.
  for(const name of ['fixture.db','fixture.db-journal']){const p=path.join(f.dir,name);if(fs.existsSync(p))fs.unlinkSync(p);}
  const sources=path.join(f.dir,'sources');if(fs.existsSync(sources))fs.rmdirSync(sources);
  fs.rmdirSync(f.dir);
 }
}
main().catch(e=>{console.error('PROBE_SETUP_OR_RUNTIME_ERROR',e);process.exitCode=2;});
