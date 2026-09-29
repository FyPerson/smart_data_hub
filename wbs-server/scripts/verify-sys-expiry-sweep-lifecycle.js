'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const acorn=require('acorn');
(async()=>{
 let pass=0;const check=(name,ok)=>{assert.ok(ok,name);pass++;console.log('[OK] '+name);};
 const src=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const ast=acorn.parse(src,{ecmaVersion:'latest'});
 const declarations=ast.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations);
 const sys=declarations.find(n=>n.id.name==='sysIterModule');
 check('生产模块明确启用后台扫描',sys&&sys.init.arguments[0].properties.some(p=>p.key.name==='expirySweepEnabled'&&p.value.value===true));
 for(const signal of ['SIGINT','SIGTERM'])check(signal+'绑定真正停服入口',ast.body.some(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'&&n.expression.callee.object?.name==='process'&&n.expression.callee.property?.name==='on'&&n.expression.arguments[0]?.value===signal&&n.expression.arguments[1]?.name==='stopService'));
 const calls=[];let finish;const held=new Promise(r=>finish=r);
 const context=vm.createContext({serviceStopping:false,sysIterModule:{stopExpirySweep:async()=>{calls.push('stop-start');await held;calls.push('stop-end');}},closeMssqlPools:async()=>calls.push('mssql'),closeMysqlPools:async()=>calls.push('mysql'),process:{exit:code=>calls.push('exit:'+code)}});
 const shutdown=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='stopService');
 assert.ok(shutdown&&shutdown.async);vm.runInContext(src.slice(shutdown.start,shutdown.end),context);const pending=context.stopService();await context.stopService();
 check('重复停服不重复关闭且等待扫描',JSON.stringify(calls)===JSON.stringify(['stop-start']));
 finish();await pending;check('停扫完成后才关闭连接池并退出',JSON.stringify(calls)===JSON.stringify(['stop-start','stop-end','mssql','mysql','exit:0']));
 console.log(`PASS=${pass} FAIL=0`);
})().catch(e=>{console.error(e);console.log('PASS=0 FAIL=1');process.exitCode=1;});
