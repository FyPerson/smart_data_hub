'use strict';

// Civil timestamps come from SQLite localtime, the same clock as authorization
// deadlines. UTC below is only calendar arithmetic on those civil components.
function civilMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw Error('Invalid expiry sweep clock');
  const time = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,19).replace('T',' ') !== value) throw Error('Invalid expiry sweep clock');
  return time;
}
function nextEight(value) {
  const now = civilMillis(value);
  let next = civilMillis(value.slice(0,10) + ' 08:00:00');
  if (next <= now) next += 86400000;
  return new Date(next).toISOString().slice(0,19).replace('T',' ');
}

// No login account is created. Positive sentinel is required by the executor
// audit CHECK; the transaction adapter rejects any collision with a real user.
const SYSTEM_ACTOR = Object.freeze({ id:Number.MAX_SAFE_INTEGER, name:'系统' });

// Claude review LOW-2: a sheet that keeps failing used to be rescanned (and logged) every minute,
// about 1440 error lines a day. Consecutive failures now back off 1, 2, 4 ... minutes up to an hour;
// the retry never passes the next civil 08:00, and any clean run resets the streak.
const RETRY_BASE_MS = 60000, RETRY_MAX_MS = 3600000;
function civilAdd(value, ms) { return new Date(civilMillis(value) + ms).toISOString().slice(0,19).replace('T',' '); }

function createExpirySweep({ isReady, readNow, listCandidates, expireOne, logger, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let started = false, stopped = false, halted = false, timer = null, inFlight = null, due = null, lastResult = null, epoch = 0, failStreak = 0;
  const retryDelay = () => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failStreak - 1, 16));
  function halt() {
    halted = true;
    epoch++;
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  async function execute() {
    const generation = epoch;
    const result = { scanned:0, expired:0, failed:[], skipped:false, cancelled:false, halted:false };
    if (stopped || halted || !isReady()) { result.skipped = true; return result; }
    const ids = await listCandidates();
    for (const id of ids) {
      if (stopped || generation !== epoch) { result.cancelled = true; break; }
      result.scanned++;
      try { if (await expireOne(id)) result.expired++; }
      catch (error) {
        result.failed.push(id);
        logger.error('[系统迭代 #73] 授权到期扫描失败', { issueId:id, message:error.message });
        if (error.expirySweepFatal) { halt(); result.halted = true; break; }
      }
    }
    lastResult = result;
    logger.info('[系统迭代 #73] 授权到期扫描完成', result);
    return result;
  }
  function runNow() {
    if (inFlight) return inFlight;
    inFlight = execute().catch(error => {
      if (error.expirySweepFatal) { halt(); logger.error('[系统迭代 #73] 到期扫描已停止', { message:error.message }); }
      throw error;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }
  function schedule(delay) {
    if (!started || stopped || halted) return;
    const generation = epoch;
    timer = setTimer(() => tick(generation), delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  async function tick(generation) {
    if (generation !== epoch || stopped) return;
    timer = null;
    let delay = 60000, now = null, clockOk = false;
    try {
      now = await readNow(); civilMillis(now); clockOk = true;
      if (generation !== epoch || stopped) return;
      if (due && due > nextEight(now)) due = nextEight(now); // A backward wall-clock adjustment must not skip the next civil 08:00.
      if (due === null || now >= due) {
        const result = await runNow();
        if (generation !== epoch || stopped) return;
        // Not ready or cancelled: look again on the next wake. Failures retry with backoff; successful
        // authorization generations have already been cleared, so their real events cannot be duplicated.
        if (result.skipped || result.cancelled) due = null;
        else if (result.failed.length) {
          failStreak++;
          const retryAt = civilAdd(now, retryDelay()), eight = nextEight(now);
          due = retryAt < eight ? retryAt : eight;
        } else { failStreak = 0; due = nextEight(now); }
      }
      if (due) delay = Math.max(1, Math.min(60000, civilMillis(due) - civilMillis(now)));
    } catch (error) {
      if (generation !== epoch || stopped) return;
      failStreak++;
      if (clockOk) {
        // codex 598 M-1：时钟已读到（出错在列候选等后续步骤）——重试点同样不越过下一个 08:00，并维持至多每分钟唤醒。
        const retryAt = civilAdd(now, retryDelay()), eight = nextEight(now);
        due = retryAt < eight ? retryAt : eight;
        delay = Math.max(1, Math.min(60000, civilMillis(due) - civilMillis(now)));
      } else { due = null; delay = retryDelay(); } // 连数据库时钟都读不到：无从判定 08:00，按退避重试
      logger.error('[系统迭代 #73] 到期调度失败', { message:error.message, halted, failStreak, retryAt:due, nextWakeMs:delay });
    } finally { if (generation === epoch) schedule(delay); }
  }
  function start() {
    if (started || halted) return false;
    epoch++; started = true; stopped = false; due = null; schedule(0); return true;
  }
  async function stop() {
    epoch++; started = false; stopped = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (inFlight) await inFlight.catch(() => {});
  }
  return { start, stop, runNow, status:() => ({ started, stopped, halted, running:!!inFlight, due, failStreak, lastResult }) };
}

module.exports = { createExpirySweep, SYSTEM_ACTOR, civilMillis, nextEight };
