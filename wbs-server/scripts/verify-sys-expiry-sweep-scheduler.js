'use strict';
const assert=require('node:assert/strict');
const {createExpirySweep,nextEight}=require('../routes/sys-iteration/expiry-sweep');
function fakeTimers(){let seq=0;const tasks=new Map();return {tasks,setTimer(fn,delay){const id=++seq;tasks.set(id,{fn,delay});return id;},clearTimer(id){tasks.delete(id);},async fire(){assert.equal(tasks.size,1);const [id,item]=tasks.entries().next().value;tasks.delete(id);await item.fn();}};}
module.exports={fakeTimers};
async function main(){
  let pass=0;const check=(name,ok)=>{assert.ok(ok,name);pass++;console.log('[OK] '+name);};
  check('闰年跨月',nextEight('2028-02-28 08:00:00')==='2028-02-29 08:00:00');
  check('跨年',nextEight('2030-12-31 23:59:59')==='2031-01-01 08:00:00');
  check('8点前下一次为当天',nextEight('2030-01-01 07:59:59')==='2030-01-01 08:00:00');
  assert.throws(()=>nextEight('2030-02-31 00:00:00'));check('坏时钟拒绝',true);
  const timers=fakeTimers(),logs=[];let now='2030-12-31 07:59:59',calls=0,ready=true,fail=false;
  const job=createExpirySweep({isReady:()=>ready,readNow:async()=>now,listCandidates:async()=>{calls++;if(fail)throw Error('read failed');return [];},expireOne:async()=>true,logger:{info(){},error(...a){logs.push(a);}},setTimer:timers.setTimer,clearTimer:timers.clearTimer});
  check('启动重复调用不叠定时器',job.start()&&!job.start()&&timers.tasks.size===1);
  await timers.fire();check('启动补扫',calls===1&&job.status().due==='2030-12-31 08:00:00');
  check('精确调到一秒后8点',timers.tasks.values().next().value.delay===1000);
  now='2030-12-31 08:00:00';await timers.fire();check('恰8点扫描',calls===2);
  await timers.fire();check('同日早唤醒不重复扫',calls===2);
  now='2031-01-03 09:00:00';await timers.fire();check('休眠跨过多天补扫一次',calls===3&&job.status().due==='2031-01-04 08:00:00');
  now='2031-01-02 07:59:59';await timers.fire();check('时钟回拨调整下一8点',calls===3&&job.status().due==='2031-01-02 08:00:00');
  now='2031-01-02 08:00:00';fail=true;await timers.fire();check('失败保留日志并延后重试(598 M-1:时钟已读到时重试点=now+1分钟)',logs.length===1&&job.status().due==='2031-01-02 08:01:00'&&timers.tasks.values().next().value.delay===60000);
  fail=false;now='2031-01-02 08:01:00';await timers.fire();check('恢复后到重试点补扫(598 M-1)',calls===5);
  await job.stop();check('停止取消定时器',timers.tasks.size===0);
  check('重启可用',job.start());ready=false;await timers.fire();check('schema未就绪不扫数据',calls===5);
  ready=true;await timers.fire();check('schema恢复后启动补扫',calls===6);
  await job.stop();
  const pendingTimers=fakeTimers();let releaseClock,lateScans=0;
  const heldClock=new Promise(resolve=>releaseClock=resolve);
  const late=createExpirySweep({isReady:()=>true,readNow:()=>heldClock,listCandidates:async()=>{lateScans++;return[];},expireOne:async()=>false,logger:{info(){},error(){}},setTimer:pendingTimers.setTimer,clearTimer:pendingTimers.clearTimer});
  late.start();const oldTick=pendingTimers.fire();await late.stop();late.start();releaseClock('2030-01-01 09:00:00');await oldTick;
  check('停止重启后旧时钟续体不扫描也不叠定时器',lateScans===0&&pendingTimers.tasks.size===1);
  await pendingTimers.fire();check('新代次正常独立启动',lateScans===1&&pendingTimers.tasks.size===1);await late.stop();
  // Claude 外审 LOW-2：同一张单持续失败按 1/2/4… 分钟退避（上限 60 分钟，且不越过下一个 8 点），成功即清零。
  const backoffTimers=fakeTimers(),backoffLogs=[];let bNow='2031-03-01 09:00:00',bScans=0,bFail=true;
  const backoff=createExpirySweep({isReady:()=>true,readNow:async()=>bNow,listCandidates:async()=>{bScans++;return ['s1'];},expireOne:async()=>{if(bFail)throw Error('still failing');return true;},logger:{info(){},error(...a){backoffLogs.push(a);}},setTimer:backoffTimers.setTimer,clearTimer:backoffTimers.clearTimer});
  backoff.start();await backoffTimers.fire();
  check('首次失败1分钟后重试',backoff.status().due==='2031-03-01 09:01:00'&&backoff.status().failStreak===1);
  bNow='2031-03-01 09:00:30';await backoffTimers.fire();check('未到重试点只唤醒不重扫',bScans===1&&backoffLogs.length===1);
  bNow='2031-03-01 09:01:00';await backoffTimers.fire();check('第二次失败2分钟后重试',bScans===2&&backoff.status().due==='2031-03-01 09:03:00');
  bNow='2031-03-01 09:03:00';await backoffTimers.fire();check('第三次失败4分钟后重试',bScans===3&&backoff.status().due==='2031-03-01 09:07:00');
  for(let i=0;i<8;i++){bNow=backoff.status().due;await backoffTimers.fire();}
  check('退避封顶60分钟',backoff.status().failStreak===11&&backoff.status().due==='2031-03-01 '+String(Number(bNow.slice(11,13))+1).padStart(2,'0')+bNow.slice(13));
  check('持续失败时日志条数等于实际重扫次数（不再每分钟一条）',backoffLogs.length===bScans&&bScans===11);
  bNow='2031-03-02 07:30:00';await backoffTimers.fire();check('退避不越过下一个8点',backoff.status().due==='2031-03-02 08:00:00');
  bFail=false;bNow='2031-03-02 08:00:00';await backoffTimers.fire();check('成功后清零并回到每日8点',backoff.status().failStreak===0&&backoff.status().due==='2031-03-03 08:00:00');
  await backoff.stop();
  const readTimers=fakeTimers();let readFails=0;
  const readJob=createExpirySweep({isReady:()=>true,readNow:async()=>{readFails++;throw Error('clock down');},listCandidates:async()=>[],expireOne:async()=>true,logger:{info(){},error(){}},setTimer:readTimers.setTimer,clearTimer:readTimers.clearTimer});
  readJob.start();await readTimers.fire();const d1=readTimers.tasks.values().next().value.delay;await readTimers.fire();const d2=readTimers.tasks.values().next().value.delay;
  check('调度异常同样退避',readFails===2&&d1===60000&&d2===120000);await readJob.stop();
  // codex 598 M-1：列候选出错累积到封顶后，07:30 再出错——重试点截到当天 08:00，恢复后 08:00 照常扫描。
  const capTimers=fakeTimers();let cNow='2031-04-01 00:00:00',cFail=true,cScans=0;
  const capJob=createExpirySweep({isReady:()=>true,readNow:async()=>cNow,listCandidates:async()=>{if(cFail)throw Error('db busy');cScans++;return [];},expireOne:async()=>true,logger:{info(){},error(){}},setTimer:capTimers.setTimer,clearTimer:capTimers.clearTimer});
  capJob.start();await capTimers.fire();
  for(let i=0;i<9;i++){cNow=capJob.status().due;await capTimers.fire();}
  check('598:列候选出错同样指数退避并封顶60分钟',capJob.status().failStreak===10&&capJob.status().due==='2031-04-01 '+String(Number(cNow.slice(11,13))+1).padStart(2,'0')+cNow.slice(13),capJob.status());
  cNow='2031-04-02 07:30:00';await capTimers.fire();
  check('598:封顶后07:30出错重试点截到08:00',capJob.status().due==='2031-04-02 08:00:00');
  cFail=false;cNow='2031-04-02 08:00:00';await capTimers.fire();
  check('598:恢复后08:00照常扫描并清零',cScans===1&&capJob.status().failStreak===0&&capJob.status().due==='2031-04-03 08:00:00');
  // codex 598 R-1：stop/start 之间保留 failStreak（同一实例的故障史），重启后再失败继续累加、成功即清零。
  cFail=true;cNow='2031-04-03 08:00:00';await capTimers.fire();const streakBefore=capJob.status().failStreak;
  await capJob.stop();capJob.start();await capTimers.fire();
  check('598 R-1:重启保留failStreak且再失败继续累加',streakBefore===1&&capJob.status().failStreak===2);
  cFail=false;cNow=capJob.status().due;await capTimers.fire();check('598 R-1:重启后成功清零',capJob.status().failStreak===0);await capJob.stop();
  console.log(`PASS=${pass} FAIL=0`);
}
if(require.main===module)main().catch(e=>{console.error(e);console.log('PASS=0 FAIL=1');process.exitCode=1;});
