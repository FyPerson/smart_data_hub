'use strict';

/**
 * 每日定时任务调度工厂（#77 C2b-2，方案 v0.9 §4.4「核验时机」+ §6.1 C2b ⑦）。
 *
 * 复制自 routes/sys-iteration/expiry-sweep.js 并参数化：
 *   · 触发时刻不再写死 08:00，由 atHour / atMinute 给定（本模块用 07:30）；
 *   · 日志标签不再写死「#73」，由 label 给定；
 *   · 候选 / 处理函数换成 listCandidates / processOne，处理函数的失败只计入 failed、不影响其余对象（串行）；
 *   · 启动时默认不补跑（runOnStart = false）：expiry-sweep 的启动补跑是授权到期语义所需，每日核验要读生产库，
 *     不应在每次进程重启时全量读一遍——首次唤醒只排定下一个触发点。
 * 退避只用于「整轮失败」（读时钟 / 列候选出错）：按 1、2、4 … 分钟退避至多 1 小时，且不越过下一个触发点；
 *   读不到时钟时保留已排定的 due（不清空），时钟恢复后若已过 due 立即补跑，不会因一次读钟失败把当天的触发顺延到次日。
 * 单个对象核验失败由 processOne 自己落库（last_error），不触发整轮重跑。
 *
 * 时钟：全部按 SQLite localtime 的公民时间字符串 'YYYY-MM-DD HH:MM:SS' 做日历运算（与平台授权到期同一口径）；
 * readNow / setTimer / clearTimer 可注入，验证脚本据此钉死时钟。
 */

function civilMillis(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw Error('Invalid daily sweep clock');
    const time = Date.parse(value.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19).replace('T', ' ') !== value) throw Error('Invalid daily sweep clock');
    return time;
}
const civilText = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const civilAdd = (value, ms) => civilText(civilMillis(value) + ms);
const pad2 = (n) => String(n).padStart(2, '0');

/** 下一个触发点：严格晚于 value 的最近一个 atHour:atMinute:00 */
function nextAt(value, atHour, atMinute) {
    const now = civilMillis(value);
    let next = civilMillis(`${value.slice(0, 10)} ${pad2(atHour)}:${pad2(atMinute)}:00`);
    if (next <= now) next += 86400000;
    return civilText(next);
}

const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 3600000;

function createDailySweep({ label, atHour, atMinute, isReady, readNow, listCandidates, processOne, logger, isTerminal, runOnStart = false, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23 || !Number.isInteger(atMinute) || atMinute < 0 || atMinute > 59) throw new Error('createDailySweep：atHour / atMinute 非法');
    for (const [k, v] of Object.entries({ isReady, readNow, listCandidates, processOne, logger })) if (!v) throw new Error(`createDailySweep：缺少 ${k}`);
    let started = false;
    let stopped = false;
    let timer = null;
    let inFlight = null;
    let due = null;
    let lastResult = null;
    let epoch = 0;
    let failStreak = 0;
    let terminated = false;   // 终态：队列已永久停止接收（isTerminal() 为真）时收到 stopped ⇒ 不再排任何定时器
    const retryDelay = () => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failStreak - 1, 16));

    async function execute() {
        const generation = epoch;
        const result = { scanned: 0, ok: 0, failed: [], skipped: false, cancelled: false, stopped: false, terminal: false };
        if (stopped || !isReady()) { result.skipped = true; return result; }
        const ids = await listCandidates();
        for (const id of ids) {
            if (stopped || generation !== epoch) { result.cancelled = true; break; }
            result.scanned++;
            try {
                const out = await processOne(id);
                // processOne 返回 { outcome: 'stopped' }（核验队列已停止接收）：既不计 ok 也不计 failed，记为 stopped 并结束本轮
                if (out && out.outcome === 'stopped') { result.stopped = true; result.terminal = typeof isTerminal === 'function' && !!isTerminal(); break; }   // terminal：核验队列已永久停止接收（不依赖 stopService 先后顺序）
                // processOne 返回 { outcome: 'error' }（核验读取失败已自行落库）也计入 failed，不算 ok
                if (out && out.outcome === 'error') result.failed.push(id); else result.ok++;
            } catch (error) {
                result.failed.push(id);
                logger.error(`[${label}] 处理失败`, { id, message: error && error.message });
            }
        }
        lastResult = result;
        logger.info(`[${label}] 本轮完成`, result);
        return result;
    }
    function runNow() {
        if (inFlight) return inFlight;
        inFlight = execute().finally(() => { inFlight = null; });
        return inFlight;
    }
    function schedule(delay) {
        if (!started || stopped) return;
        const generation = epoch;
        timer = setTimer(() => tick(generation), delay);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }
    async function tick(generation) {
        if (generation !== epoch || stopped) return;
        timer = null;
        let delay = 60000;
        let now = null;
        let clockOk = false;
        try {
            now = await readNow(); civilMillis(now); clockOk = true;
            if (generation !== epoch || stopped) return;
            let stoppedRound = false;
            let skippedRound = false;
            if (due && due > nextAt(now, atHour, atMinute)) due = nextAt(now, atHour, atMinute);   // 墙钟被往回拨时不得跳过下一个触发点
            if (due === null && !runOnStart) due = nextAt(now, atHour, atMinute);
            else if (due === null || now >= due) {
                const result = await runNow();
                if (generation !== epoch || stopped) return;
                // execute() 的消费方只有这里（runNow 的另一个出口是 status / 导出的 runNow，目前没有外部调用方）。
                // stopped 契约（核验队列已停止接收，本轮在中途结束）：
                //   ① 这一轮不算成功：不清零 failStreak（退避状态原样保留），不把 due 推进到「下一天」，due 保持不动（仍 <= now）；
                //   ② 只在进程仍然存活时按既有逻辑继续排下一次唤醒（固定 60 秒，不自旋）；
                //   ③ 停服后重启不补跑：runOnStart 默认 false，启动只排定下一个触发点，与「启动不补跑」一致；中断的这一轮靠徽章 7 天待重核窗口兜底，没有补偿扫描。
                // 未就绪 / 被取消：due 保持不动（仍 <= now），下一次唤醒继续补跑，不能顺延到明天
                //   ④ 终态（result.terminal：核验队列已永久停止接收）：tick 直接结束、不再排任何定时器，不每 60 秒空转重试；
                //   ⑤ 末次合并审 M3：未就绪（skipped）的这一轮同样固定 60 秒后再看，due 不动（仍 <= now）——否则 due 已过时按「due - now」算出的间隔 <= 0 会被钳成 1ms，未就绪期间空转
                if (result.stopped) { stoppedRound = true; if (result.terminal) terminated = true; }
                else if (result.skipped) { skippedRound = true; }
                else if (!result.cancelled) { failStreak = 0; due = nextAt(now, atHour, atMinute); }
            }
            if (due) delay = Math.max(1, Math.min(60000, civilMillis(due) - civilMillis(now)));
            if (stoppedRound || skippedRound) delay = 60000;
        } catch (error) {
            if (generation !== epoch || stopped) return;
            failStreak++;
            if (clockOk) {
                const retryAt = civilAdd(now, retryDelay());
                const next = nextAt(now, atHour, atMinute);
                due = retryAt < next ? retryAt : next;
                delay = Math.max(1, Math.min(60000, civilMillis(due) - civilMillis(now)));
            } else { delay = retryDelay(); }   // 读不到时钟：保留 due（不清空、不改排次日），按退避重试；时钟恢复后若已过 due 就补跑
            logger.error(`[${label}] 调度失败`, { message: error && error.message, failStreak, retryAt: due, nextWakeMs: delay });
        } finally { if (generation === epoch && !terminated) schedule(delay); }
    }
    function start() {
        if (started) return false;
        epoch++; started = true; stopped = false; terminated = false; due = null; schedule(0); return true;
    }
    async function stop() {
        epoch++; started = false; stopped = true;
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (inFlight) await inFlight.catch(() => {});
    }
    return { start, stop, runNow, status: () => ({ started, stopped, terminated, running: !!inFlight, due, failStreak, lastResult }) };
}

module.exports = { createDailySweep, civilMillis, nextAt };
