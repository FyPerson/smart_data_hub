/**
 * #106 S4-x 自检：test-env 收尾助手 finish(code) + 夹具关库等回调（_test-fixture.js 的 setCollabState / cleanup）+ 夹具转调 finish
 *
 * 背景（lib/test-env.js 头注释 finish(code) 一节有完整对照实验）：Node v24.11.1 / Windows 上 fetch 刚完成就 process.exit() 会以 libuv 断言崩溃；
 *   只设 process.exitCode 让事件循环自然结束则正常。finish(code) = 设退出码 + 一个 unref() 的兜底计时器（默认 10000ms 后 process.exit(code)）。
 *
 * 安全约束：不起测试实例、不打开任何业务库、不读 .env、除 127.0.0.1 外不联网。
 *   - 节 A（进程内，经接缝 _internals.finishDeps / finishState / state）：参数校验、teardown 前置、退出码、unref、兜底到时、幂等 / 冲突、默认值；
 *   - 节 F（进程内）：夹具 setCollabState / cleanup 关库「等回调再落定」（用临时 sqlite 文件 + 包住 Database.prototype.close 注入延时 / 错误），夹具 finish 转调 test-env；
 *   - 节 B（真实子进程）：父进程起本机 http 假服务（/api/version 应答隔离实例身份）+ 临时库（带 _sdh_instance 身份），子进程以变量组形态 ready()（合成变量组，真实 ready 路径，
 *     所以退出码哨兵已装上）、fetch 假服务两次、teardown、finish(0)：退出码 0、无断言崩溃、耗时远小于兜底时长；对照组 process.exit(0) 只记录不断言；
 *     兜底（ref 的句柄 + finish(3)）、哨兵（ready 后不 teardown / 不 finish 自然结束 → 70）、finish(5) 不被改成 70。
 *   假服务的应答形态要贴近真实服务（分块应答 / 大体积正文），否则复现不了崩溃：小体积一次写完的应答下 fetch 后立即 process.exit 不崩；对照组（B.4）因此会在本机复现崩溃，但只记录不断言（运行时缺陷，不同机器上可能不复现）。
 *   选择合成变量组而不是「用接缝把 test-env 置为已 teardown」：真实 ready() 才会装上退出码哨兵（process.exit 包装 + beforeExit / exit 监听），那正是 finish 要与之共存的现场；
 *   且变量组形态不起服务进程，子进程只用到父进程的假服务。
 *
 *   - 修复批 1：teardown 落定按「尝试」代次记账（A.15–A.18）、teardown 失败不被 finish(0) 洗成 0（A.17 / B.10）、裸调 teardown() 失败仍是未处理的拒绝（B.9）、
 *     节 B 的资源清理保护与故障注入（B.8：自检自己以 --only=B --inject-fault=identity-db 再跑一遍，要求记录失败并在有界时间内非零退出）。
 *
 * 参数（变异自证接缝，正常运行不传）：--test-env=<test-env.js 绝对路径>、--fixture=<_test-fixture.js 绝对路径>（二者须是同一目录结构：夹具 require('./lib/test-env')）；
 *   --only=<A,F,B,B8>（只跑指定的节，B.8 的子进程用）、--inject-fault=identity-db（节 B 在身份库初始化处注入失败）。
 * 输出：每条断言一行 `CHECK <编号> PASS|FAIL <标题>`；对照组 / 耗时等记录行以 `NOTE` 开头；末行 `verify-test-env-finish PASS=<n> FAIL=<n>`。退出码 0 = 全绿。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { listenOnSafePort } = require('./lib/listen-safe-port');

const args = process.argv.slice(2);
const argVal = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };
const TE_PATH = path.resolve(argVal('--test-env=') || path.join(__dirname, 'lib', 'test-env.js'));
const FX_PATH = path.resolve(argVal('--fixture=') || path.join(__dirname, '_test-fixture.js'));
const ONLY = argVal('--only=') ? argVal('--only=').split(',').map((s) => s.trim()).filter(Boolean) : null;
const want = (sec) => ONLY === null || ONLY.includes(sec);
const INJECT = argVal('--inject-fault=');

const sqlite3 = require('sqlite3');
const instanceDb = require('../utils/instance-db');
const te = require(TE_PATH);
const I = te._internals;

let PASS = 0;
let FAIL = 0;
function check(id, title, ok, detail) {
    if (ok) PASS++; else FAIL++;
    console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'} ${title}`);
    if (!ok && detail !== undefined) console.log(`         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const note = (s) => console.log(`NOTE ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (fn) => { try { fn(); return null; } catch (e) { return e && e.code ? e.code : `NON_TE:${e && e.message}`; } };
const errMsg = async (p) => { try { await p; return null; } catch (e) { return e && e.message ? e.message : String(e); } };

const SAVED_EXIT_CODE = process.exitCode;
const restoreExit = () => { process.exitCode = SAVED_EXIT_CODE; };

/** 每个场景前复位 test-env 的进程级记忆（含 finish 接缝回到默认），再装本场景的接缝：兜底时长 40ms、计时器记账（返回真实句柄）、exit 记账（不真退出） */
function scenario(fallbackMs) {
    I.resetForTest();
    const rec = { timers: [], exits: [] };
    I.finishDeps.fallbackMs = fallbackMs === undefined ? 40 : fallbackMs;
    I.finishDeps.setTimeout = (fn, ms) => { const h = setTimeout(fn, ms); rec.timers.push({ ms, h }); return h; };
    I.finishDeps.exit = (c) => { rec.exits.push(c); };
    return rec;
}

// ---------------------------------------------------------------- 节 A：test-env.finish（进程内）

async function sectionA() {
    // A.1 非法 code
    {
        const rec = scenario();
        await te.teardown();
        const bad = [-1, 256, 1.5, NaN, Infinity, '0', null, undefined, {}, true];
        const wrong = bad.filter((v) => errCode(() => te.finish(v)) !== 'TE_BAD_FINISH_CODE');
        check('A.1', 'finish(code)：-1 / 256 / 1.5 / NaN / Infinity / "0" / null / undefined / {} / true 一律 TE_BAD_FINISH_CODE，且不设退出码、不装计时器',
            wrong.length === 0 && rec.timers.length === 0 && process.exitCode === SAVED_EXIT_CODE, { wrong: wrong.map(String), timers: rec.timers.length, exitCode: process.exitCode });
        restoreExit();
    }
    // A.2 合法边界
    {
        const r = [];
        for (const v of [0, 255]) {
            const rec = scenario();
            await te.teardown();
            r.push({ v, thrown: errCode(() => te.finish(v)), exitCode: process.exitCode, timers: rec.timers.length });
            restoreExit();
        }
        check('A.2', 'finish(code)：边界值 0 与 255 合法（不抛、退出码即所给值、装一个计时器）',
            r.every((x) => x.thrown === null && x.exitCode === x.v && x.timers === 1), r);
    }
    // A.3 参数校验先于 teardown 前置
    {
        scenario();
        const c1 = errCode(() => te.finish(256));
        const c2 = errCode(() => te.finish('x'));
        check('A.3', '参数校验先于 teardown 前置：从未 teardown 时传非法 code 得到 TE_BAD_FINISH_CODE（不是 TE_FINISH_BEFORE_TEARDOWN）', c1 === 'TE_BAD_FINISH_CODE' && c2 === 'TE_BAD_FINISH_CODE', { c1, c2 });
        restoreExit();
    }
    // A.4 未 teardown
    {
        const rec = scenario();
        const c = errCode(() => te.finish(0));
        check('A.4', '从未调用 teardown() 就 finish → TE_FINISH_BEFORE_TEARDOWN，且无副作用（退出码不变、无计时器、finish 不自己调 teardown）',
            c === 'TE_FINISH_BEFORE_TEARDOWN' && rec.timers.length === 0 && process.exitCode === SAVED_EXIT_CODE && I.sentinel.teardownCalled === false,
            { c, timers: rec.timers.length, exitCode: process.exitCode, teardownCalled: I.sentinel.teardownCalled });
        restoreExit();
    }
    // A.5 teardown 进行中 → 抛；落定后 → 可调用
    {
        const rec = scenario();
        let release;
        I.state.promise = new Promise((r) => { release = r; });   // 就绪「还在进行」：teardown 会等它落定，所以 teardown 处于进行中
        const tp = te.teardown();
        const during = errCode(() => te.finish(0));
        release(null);
        await tp;
        const after = errCode(() => te.finish(0));
        check('A.5', 'teardown() 进行中 finish → TE_FINISH_BEFORE_TEARDOWN；await 落定后同一调用成功', during === 'TE_FINISH_BEFORE_TEARDOWN' && after === null && rec.timers.length === 1, { during, after, timers: rec.timers.length });
        restoreExit();
    }
    // A.6 teardown 失败也算落定
    {
        const rec = scenario();
        const injected = new Error('stop boom');
        injected.code = 'TI_CLEANUP_FAILED';
        injected.dataDir = 'X:/data-dir';
        I.state.env = { _handle: { stop: async () => { throw injected; } } };
        I.state.promise = Promise.resolve(I.state.env);
        let got = null;
        try { await te.teardown(); } catch (e) { got = e; }
        const c = errCode(() => te.finish(1));
        check('A.6', '（登记的设计选择）teardown() 失败（拒绝）也算落定：失败后 finish(1) 不抛、退出码 1——由调用方把 teardown 失败并入 code；抛出的就是注入的那个错误对象（同一性，code / dataDir 保留，不是重新包装的新 Error）',
            got === injected && got.code === 'TI_CLEANUP_FAILED' && got.dataDir === 'X:/data-dir' && c === null && process.exitCode === 1 && rec.timers.length === 1,
            { sameObject: got === injected, code: got && got.code, dataDir: got && got.dataDir, c, exitCode: process.exitCode, timers: rec.timers.length });
        restoreExit();
    }
    // A.14 失败后重试进行中：不沿用上一次失败留下的「已落定」
    {
        const rec = scenario();
        let release;
        let calls = 0;
        I.state.env = { _handle: { stop: () => { calls++; if (calls === 1) return Promise.reject(new Error('stop boom')); return new Promise((r) => { release = r; }); } } };
        I.state.promise = Promise.resolve(I.state.env);
        const m1 = await errMsg(te.teardown());          // 第一次失败（落定）
        const retry = te.teardown();                      // 重试：stop() 挂起，进行中
        await sleep(20);                                  // 让 teardownCore 跑到 await h.stop()
        const during = errCode(() => te.finish(0));
        release();
        await retry;
        const after = errCode(() => te.finish(0));
        check('A.14', 'teardown() 失败后重试：重试进行中 finish → TE_FINISH_BEFORE_TEARDOWN（不沿用上一次失败留下的「已落定」）；重试成功落定后可调用',
            m1 === 'stop boom' && calls === 2 && during === 'TE_FINISH_BEFORE_TEARDOWN' && after === null && rec.timers.length === 1, { m1, calls, during, after, timers: rec.timers.length });
        restoreExit();
    }
    // A.7–A.9、A.13 正常调用
    {
        const rec = scenario(40);
        await te.teardown();
        const before = rec.exits.length;
        te.finish(4);
        const exitCodeNow = process.exitCode;
        const exitsRightAfter = rec.exits.length;
        const timer = rec.timers[0];
        check('A.7', 'finish(4)：process.exitCode 被设为 4', exitCodeNow === 4, exitCodeNow);
        check('A.8', '兜底计时器：只装一个、时长取接缝 fallbackMs（40）、已 unref（hasRef() 为 false，不阻止进程退出）',
            rec.timers.length === 1 && timer.ms === 40 && timer.h.hasRef() === false, { n: rec.timers.length, ms: timer && timer.ms, hasRef: timer && timer.h.hasRef() });
        check('A.13', 'finish 本身不立即退出：调用返回时注入的 exit 一次都没被调用', before === 0 && exitsRightAfter === 0, { before, exitsRightAfter });
        await sleep(200);
        check('A.9', '到时（40ms 后）调用注入的 exit，且恰好一次、带正确 code（4）', rec.exits.length === 1 && rec.exits[0] === 4, rec.exits);
        restoreExit();
    }
    // A.10 / A.11 幂等与冲突
    {
        const rec = scenario(5000);
        await te.teardown();
        te.finish(4);
        const again = errCode(() => te.finish(4));
        check('A.10', '重复调用同一 code 幂等：不抛、不再装计时器', again === null && rec.timers.length === 1, { again, timers: rec.timers.length });
        const conflict = errCode(() => te.finish(5));
        check('A.11', '重复调用不同 code → TE_FINISH_CONFLICT，退出码与计时器都不变', conflict === 'TE_FINISH_CONFLICT' && process.exitCode === 4 && rec.timers.length === 1, { conflict, exitCode: process.exitCode, timers: rec.timers.length });
        I.resetForTest();   // 清掉 5000ms 的计时器
        restoreExit();
    }
    // A.12 默认值：先装上假的接缝（scenario），resetForTest 之后必须回到「生产默认函数」——按行为核对，不只看 typeof
    {
        const rec = scenario(777);
        I.resetForTest();
        const t0 = rec.timers.length;
        let fired = false;
        const h = I.finishDeps.setTimeout(() => { fired = true; }, 10);
        await sleep(60);
        const realExit = process.exit;
        const realExited = [];
        process.exit = (c) => { realExited.push(c); };   // 默认 exit 接缝是惰性调用 process.exit：临时替身截住，证明它真的走到 process.exit
        try { I.finishDeps.exit(7); } finally { process.exit = realExit; }
        check('A.12', '接缝默认值不变：兜底时长 10000ms（FINISH_FALLBACK_MS 与 finishDeps.fallbackMs）；resetForTest 之后计时器接缝是真实计时器（真的触发、不再记入上一个场景的账）、exit 接缝真的调用 process.exit（不再记入上一个场景的账）',
            te.FINISH_FALLBACK_MS === 10000 && I.finishDeps.fallbackMs === 10000 && h && typeof h.hasRef === 'function' && fired && rec.timers.length === t0 && realExited.length === 1 && realExited[0] === 7 && rec.exits.length === 0,
            { exported: te.FINISH_FALLBACK_MS, seam: I.finishDeps.fallbackMs, fired, staleTimers: rec.timers.length - t0, realExited, staleExits: rec.exits });
    }
    // A.15 codex 16 M1 的交错顺序：第一次 teardown 返回 d1 → 调用方给 d1 挂「失败就重试」→ 第二次 teardown 复用同一个尝试 → 尝试失败 → 重试挂起中：finish 必须抛；释放重试后才允许
    {
        const rec = scenario();
        let release;
        let calls = 0;
        I.state.env = { _handle: { stop: () => { calls++; if (calls === 1) return Promise.reject(new Error('stop boom')); return new Promise((r) => { release = r; }); } } };
        I.state.promise = Promise.resolve(I.state.env);
        let retry = null;
        const d1 = te.teardown();
        const retried = d1.catch(() => { retry = te.teardown(); });   // 调用方先给第一次的结果挂失败重试
        const d2 = te.teardown();                                      // 第二次调用复用同一个尝试（同一个原 promise）
        const d2m = errMsg(d2);
        await retried;
        await d2m;
        await sleep(20);
        const during = errCode(() => te.finish(0));
        release();
        await retry;
        const after = errCode(() => te.finish(0));
        check('A.15', 'codex 16 交错顺序：失败重试挂起期间 finish → TE_FINISH_BEFORE_TEARDOWN（旧调用的落定回调不能把重试中的状态改回已落定）；释放重试并 await 之后才允许',
            calls === 2 && retry !== null && during === 'TE_FINISH_BEFORE_TEARDOWN' && after === null && rec.timers.length === 1, { calls, during, after, timers: rec.timers.length });
        restoreExit();
    }
    // A.16 复用已完成的结果不误抛：await teardown(); teardown(); finish(0)（第二次不 await）
    {
        const rec = scenario();
        let stops = 0;
        I.state.env = { _handle: { stop: async () => { stops++; } } };
        I.state.promise = Promise.resolve(I.state.env);
        await te.teardown();
        const again = te.teardown();   // 复用已完成的结果，不 await
        const thrown = errCode(() => te.finish(0));
        await again;
        check('A.16', '复用已完成的 teardown 结果：await teardown(); teardown()（不 await）; finish(0) 不误抛，且没有再次停实例', thrown === null && stops === 1 && rec.timers.length === 1 && process.exitCode === 0, { thrown, stops, timers: rec.timers.length, exitCode: process.exitCode });
        restoreExit();
    }
    // A.17 teardown 失败后 finish(0)：不抛、实际退出码 1、stderr 有原因行；finish(1) 不受影响；之后重试成功则 finish(0) 为 0
    {
        const cap = [];
        const realWS = fs.writeSync;
        fs.writeSync = function patchedWriteSync(fd, ...rest) { if (fd === 2) { cap.push(String(rest[0])); return Buffer.byteLength(String(rest[0])); } return realWS.call(this, fd, ...rest); };
        let r0; let r1; let r2;
        try {
            const rec = scenario();
            I.state.env = { _handle: { stop: async () => { throw new Error('stop boom'); } } };
            I.state.promise = Promise.resolve(I.state.env);
            await errMsg(te.teardown());
            const thrown = errCode(() => te.finish(0));
            r0 = { thrown, exitCode: process.exitCode, timers: rec.timers.length, stderr: cap.slice(), failedFlag: I.sentinel.teardownFailed };
            // 再调一次 finish(0)：幂等按调用方传入的值比（不是按实际退出码 1 比），不抛、退出码仍为 1、不再装计时器、不再写原因行
            r0.again = errCode(() => te.finish(0));
            r0.exitCodeAfterAgain = process.exitCode;
            r0.timersAfterAgain = rec.timers.length;
            r0.stderrAfterAgain = cap.length;
            await sleep(80);
            r0.exits = rec.exits.slice();
            restoreExit();
            const rec1 = scenario();
            I.state.env = { _handle: { stop: async () => { throw new Error('stop boom'); } } };
            I.state.promise = Promise.resolve(I.state.env);
            cap.length = 0;
            await errMsg(te.teardown());
            const t1 = errCode(() => te.finish(1));
            r1 = { thrown: t1, exitCode: process.exitCode, stderr: cap.slice(), timers: rec1.timers.length };
            restoreExit();
            scenario();
            let fail = true;
            I.state.env = { _handle: { stop: async () => { if (fail) { fail = false; throw new Error('stop boom'); } } } };
            I.state.promise = Promise.resolve(I.state.env);
            await errMsg(te.teardown());
            await te.teardown();   // 重试成功：失败标记随新一代尝试清掉
            cap.length = 0;
            const t2 = errCode(() => te.finish(0));
            r2 = { thrown: t2, exitCode: process.exitCode, stderr: cap.slice() };
        } finally { fs.writeSync = realWS; restoreExit(); }
        check('A.17', 'teardown 失败后：finish(0) 不抛、退出码实际为 1（兜底到时也用 1）、stderr 写一行原因；再调一次 finish(0) 仍不抛、退出码仍为 1（幂等按传入值比）；finish(1) 仍为 1 且不写该行；失败后重试成功再 finish(0) 为 0',
            r0.thrown === null && r0.exitCode === 1 && r0.timers === 1 && r0.failedFlag === true && r0.stderr.length === 1 && /最近一次 teardown 失败，退出码由 0 改为 1/.test(r0.stderr[0]) && r0.exits.length === 1 && r0.exits[0] === 1
            && r0.again === null && r0.exitCodeAfterAgain === 1 && r0.timersAfterAgain === 1 && r0.stderrAfterAgain === 1
            && r1.thrown === null && r1.exitCode === 1 && r1.stderr.length === 0
            && r2.thrown === null && r2.exitCode === 0 && r2.stderr.length === 0, { r0, r1, r2 });
    }
    // A.18 resetForTest 让旧回调失效：teardown 进行中被 reset，之后旧尝试落定，不能把新场景的状态置为已落定
    {
        scenario();
        let release;
        I.state.promise = new Promise((r) => { release = r; });
        const old = te.teardown();   // 进行中（等就绪落定）
        I.resetForTest();
        release(null);
        await old;
        const settledAfter = I.sentinel.teardownSettled;
        const failedAfter = I.sentinel.teardownFailed;
        // 失败分支：旧尝试的 stop() 挂起，reset 之后才拒绝
        scenario();
        let rejectStop;
        I.state.env = { _handle: { stop: () => new Promise((_, rej) => { rejectStop = rej; }) } };
        I.state.promise = Promise.resolve(I.state.env);
        const oldFail = errMsg(te.teardown());
        await sleep(20);
        I.resetForTest();
        rejectStop(new Error('late stop boom'));
        const lateMsg = await oldFail;
        const settledAfterFail = I.sentinel.teardownSettled;
        const failedAfterFail = I.sentinel.teardownFailed;
        check('A.18', 'resetForTest 让旧尝试的落定回调失效：reset 之后旧 teardown 成功落定 / 失败落定，都不把 teardownSettled / teardownFailed 改掉（保持 false）；失败仍照常抛给调用方',
            settledAfter === false && failedAfter === false && settledAfterFail === false && failedAfterFail === false && lateMsg === 'late stop boom', { settledAfter, failedAfter, settledAfterFail, failedAfterFail, lateMsg });
        restoreExit();
    }
    // A.19 旧尝试在 reset 之后不再读写 state（代次变了就 return / 不动）：G1 不去停新场景的句柄，G2 失败时不清新尝试的 teardownPromise，G3 成功时不把新场景标成 tornDown
    {
        // G1：旧尝试还在等就绪，reset 后装了新 env，旧尝试醒来
        scenario();
        let releaseReady;
        I.state.promise = new Promise((r) => { releaseReady = r; });
        const oldG1 = te.teardown();
        I.resetForTest();
        let newStops = 0;
        I.state.env = { _handle: { stop: async () => { newStops++; } } };
        I.state.promise = Promise.resolve(I.state.env);
        releaseReady(null);
        await oldG1;
        await sleep(10);
        const g1 = { newStops, tornDown: I.state.tornDown };
        // G2：旧尝试的 stop() 挂起，reset 后新尝试已建立，旧尝试才失败
        scenario();
        let rejectOld;
        I.state.env = { _handle: { stop: () => new Promise((_, rej) => { rejectOld = rej; }) } };
        I.state.promise = Promise.resolve(I.state.env);
        const oldG2 = errMsg(te.teardown());
        await sleep(20);
        I.resetForTest();
        I.state.env = { _handle: { stop: () => new Promise(() => {}) } };
        I.state.promise = Promise.resolve(I.state.env);
        const newG2 = te.teardown();   // 新尝试：建立自己的 teardownPromise，永不落定
        newG2.catch(() => {});
        await sleep(20);
        const beforeReject = I.state.teardownPromise !== null;
        rejectOld(new Error('late stop boom 2'));
        const g2Msg = await oldG2;
        await sleep(10);
        const g2 = { beforeReject, afterReject: I.state.teardownPromise !== null, g2Msg };
        // G3：旧尝试的 stop() 挂起，reset 后旧尝试才成功
        scenario();
        let resolveOld;
        I.state.env = { _handle: { stop: () => new Promise((r) => { resolveOld = r; }) } };
        I.state.promise = Promise.resolve(I.state.env);
        const oldG3 = te.teardown();
        await sleep(20);
        I.resetForTest();
        resolveOld();
        await oldG3;
        await sleep(10);
        const g3 = { tornDown: I.state.tornDown };
        check('A.19', '旧尝试（resetForTest 之后才醒来）不再读写新场景的 state：G1 不去停新场景的 env 句柄也不置 tornDown；G2 失败时不清新尝试的 teardownPromise（旧尝试的失败仍抛给它自己的调用方）；G3 成功时不把新场景置为 tornDown',
            g1.newStops === 0 && g1.tornDown === false && g2.beforeReject === true && g2.afterReject === true && g2.g2Msg === 'late stop boom 2' && g3.tornDown === false, { g1, g2, g3 });
        I.resetForTest();
        restoreExit();
    }
    I.resetForTest();
    restoreExit();
}

// ---------------------------------------------------------------- 节 F：夹具

function openDb(file) {
    return new Promise((resolve, reject) => { const d = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(d))); });
}
const dbRun = (d, sql) => new Promise((resolve, reject) => d.run(sql, (e) => (e ? reject(e) : resolve())));
const dbAll = (d, sql) => new Promise((resolve, reject) => d.all(sql, (e, rows) => (e ? reject(e) : resolve(rows))));
const dbClose = (d) => new Promise((resolve) => d.close(() => resolve()));

/** 包住 Database.prototype.close：带回调时把回调延后 delayMs 触发（可注入错误）；不带回调直接转调。记账：calls / cbFired */
function patchClose({ delayMs, injectErr }) {
    const proto = sqlite3.Database.prototype;
    const orig = proto.close;
    const rec = { calls: 0, cbFired: false };
    proto.close = function patchedClose(cb) {
        rec.calls++;
        if (typeof cb !== 'function') return orig.call(this);
        return orig.call(this, (e) => { setTimeout(() => { rec.cbFired = true; cb(injectErr || e); }, delayMs); });
    };
    return { rec, restore: () => { proto.close = orig; } };
}

async function sectionF(tmp) {
    const fx = require(FX_PATH);
    check('F.6', '夹具导出 finish（函数）', typeof fx.finish === 'function', typeof fx.finish);

    // F.7 转调 test-env：非法 code 由 test-env 的校验抛出；合法 code 落到 test-env 的 finishState
    {
        const rec = scenario(5000);
        await te.teardown();
        const bad = errCode(() => fx.finish(256));
        let thrown = null;
        try { fx.finish(2); } catch (e) { thrown = e && e.code; }
        check('F.7', '夹具 finish(code) 转调 test-env.finish：256 → TE_BAD_FINISH_CODE；2 → test-env 的 finishState.code === 2 且装了一个计时器',
            bad === 'TE_BAD_FINISH_CODE' && thrown === null && I.finishState.code === 2 && rec.timers.length === 1, { bad, thrown, code: I.finishState.code, timers: rec.timers.length });
        I.resetForTest();
        restoreExit();
    }

    const goodDb = path.join(tmp, 'fx-good.db');
    const noTableDb = path.join(tmp, 'fx-notable.db');
    {
        const d = await openDb(goodDb);
        await dbRun(d, 'CREATE TABLE collab_requests (id INTEGER PRIMARY KEY, status TEXT)');
        await dbRun(d, "INSERT INTO collab_requests (id, status) VALUES (1, 'A')");
        await dbClose(d);
        const d2 = await openDb(noTableDb);
        await dbRun(d2, 'CREATE TABLE other (x INTEGER)');
        await dbClose(d2);
    }
    const asReady = (dbPath) => { I.resetForTest(); I.state.env = { baseUrl: 'http://127.0.0.1:1', dbPath, jwtSecret: 'x', instance: 'test-fx', live: false }; I.state.promise = Promise.resolve(I.state.env); };
    const readRows = async () => { const d = await openDb(goodDb); try { return await dbAll(d, 'SELECT id, status FROM collab_requests ORDER BY id'); } finally { await dbClose(d); } };

    // F.1 setCollabState 等 close 回调
    {
        asReady(goodDb);
        const p = patchClose({ delayMs: 80 });
        let firedAtResolve = null;
        let err = null;
        try { await fx.setCollabState(1, { status: 'B' }); firedAtResolve = p.rec.cbFired; } catch (e) { err = e; } finally { p.restore(); }
        const rows = await readRows();
        check('F.1', 'setCollabState：关库回调（被延后 80ms）触发之后才 resolve（不再 db.close() 后立即落定），UPDATE 确实生效',
            err === null && firedAtResolve === true && p.rec.calls === 1 && rows[0] && rows[0].status === 'B', { err: err && err.message, firedAtResolve, calls: p.rec.calls, rows });
    }
    // F.2 cleanup 等 close 回调
    {
        asReady(goodDb);
        const p = patchClose({ delayMs: 80 });
        let firedAtResolve = null;
        let err = null;
        try { await fx.cleanup(1); firedAtResolve = p.rec.cbFired; } catch (e) { err = e; } finally { p.restore(); }
        const rows = await readRows();
        check('F.2', 'cleanup：关库回调（被延后 80ms）触发之后才 resolve，DELETE 确实生效', err === null && firedAtResolve === true && p.rec.calls === 1 && rows.length === 0, { err: err && err.message, firedAtResolve, calls: p.rec.calls, rows });
    }
    // 还原一行供后面用例
    {
        const d = await openDb(goodDb);
        await dbRun(d, "INSERT INTO collab_requests (id, status) VALUES (1, 'A')");
        await dbClose(d);
    }
    // F.3 / F.4 close 错误向上传
    {
        asReady(goodDb);
        const p = patchClose({ delayMs: 10, injectErr: new Error('close boom') });
        let m1; let m2;
        try { m1 = await errMsg(fx.setCollabState(1, { status: 'C' })); m2 = await errMsg(fx.cleanup(1)); } finally { p.restore(); }
        check('F.3', 'setCollabState：UPDATE 成功、关库回调带错 → 拒绝为该关库错误', m1 === 'close boom', m1);
        check('F.4', 'cleanup：DELETE 成功、关库回调带错 → 拒绝为该关库错误', m2 === 'close boom', m2);
    }
    // F.5 语句错误优先于关库错误
    {
        // 两个失败调用各建独立的关库记录（close 回调延后 80ms 触发、带注入的关库错误）；在「捕获到拒绝」的那一刻读该次记录的 cbFired——
        //   语句失败时也必须等关库回调触发之后才 reject（`db.close(); reject(err); return;` 这类提前拒绝会让 cbFired 仍为 false）
        const one = async (dbFile, call) => {
            asReady(dbFile);
            const p = patchClose({ delayMs: 80, injectErr: new Error('close boom') });
            let msg = null;
            let firedAtReject = null;
            try {
                try { await call(); } catch (e) { msg = e && e.message; firedAtReject = p.rec.cbFired; }
            } finally { p.restore(); }
            return { msg, firedAtReject, calls: p.rec.calls };
        };
        const u = await one(goodDb, () => fx.setCollabState(1, { friction_note: 'x' }));   // 表里没有这一列：UPDATE 报 no such column
        const d = await one(noTableDb, () => fx.cleanup(1));                                 // 库里没有 collab_requests：DELETE 报 no such table
        check('F.5', '语句出错时：拒绝的是语句错误（no such column / no such table）而不是关库错误；每次调用恰好关库一次；且是等该次关库回调（延后 80ms）触发之后才拒绝（捕获到拒绝时该次回调已触发）',
            /no such column/i.test(u.msg || '') && /no such table/i.test(d.msg || '') && u.calls === 1 && d.calls === 1 && u.firedAtReject === true && d.firedAtReject === true, { u, d });
    }
    I.resetForTest();
    restoreExit();
}

// ---------------------------------------------------------------- 节 B：真实子进程

const INSTANCE = 'test-finish1';
const CHILD_JS_SRC = [
    "'use strict';",
    'const mode = process.argv[2];',
    'const te = require(process.env.CHILD_TE);',
    'te._internals.resetForTest({ wbsDir: process.env.CHILD_WBS });',
    'if (process.env.CHILD_FALLBACK_MS) te._internals.finishDeps.fallbackMs = Number(process.env.CHILD_FALLBACK_MS);',
    "const hit = async (p) => { const r = await fetch(process.env.TEST_BASE_URL + p); await r.text(); return r.status; };",
    "const failHandle = () => Object.defineProperty(te._internals.state.env, '_handle', { value: { stop: async () => { throw new Error('stop boom'); } } });",
    '(async () => {',
    '  await te.ready();',
    "  if (mode === 'sentinel') { await hit('/api/health/ready'); console.log('done'); return; }",
    "  const s1 = await hit('/api/health/ready');",
    "  const s2 = await hit('/api/issue-lite');",
    "  if (mode === 'td_bare_fail') { failHandle(); te.teardown(); console.log('end'); return; }",
    "  if (mode === 'td_fail_finish0') { failHandle(); await te.teardown().catch(() => {}); te.finish(0); return; }",
    "  if (mode === 'td_fail_finish1') { failHandle(); await te.teardown().catch(() => {}); te.finish(1); return; }",
    "  if (mode === 'td_fail_natural') { failHandle(); await te.teardown().catch(() => {}); return; }",
    '  await te.teardown();',
    "  console.log('done ' + s1 + ' ' + s2);",
    "  if (mode === 'td_ok_natural') return;",
    "  if (mode === 'finish0') te.finish(0);",
    "  else if (mode === 'finish5') te.finish(5);",
    "  else if (mode === 'exit0') process.exit(0);",
    "  else if (mode === 'fallback3') { setInterval(function () {}, 1000); te.finish(3); }",
    "  else throw new Error('unknown mode ' + mode);",
    '})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });',
    '',
].join('\n');

async function sectionB(tmp) {
    // 假服务
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'fake', mode: 'isolated', instance: INSTANCE }));
        // 应答形态要贴近真实服务，否则复现不了崩溃：小体积一次写完的应答（几十字节）下 fetch 后立即 process.exit 不崩（探针实测 8/8 退出码 0）；
        // 分块应答（先 write 一段、过几毫秒再 end）或大体积正文下 8/8 崩溃（退出码 3221226505 = 0xC0000409，stderr 为 libuv 断言）。
        if (req.url.startsWith('/api/issue-lite')) { res.statusCode = 401; res.write('{"error":'); return void setTimeout(() => res.end('"no token"}'), 5); }
        return res.end(JSON.stringify({ ok: true, path: req.url, rows: new Array(4000).fill({ a: 'x'.repeat(40) }) }));
    });
    await listenOnSafePort(server);   // 不让系统分配临时端口：本机临时端口区间覆盖 3000–3300（verify-no-listen-zero 守卫）
    // 监听之后的全部初始化与用例都在 sectionBBody 里，由这个 try/finally 兜底关掉假服务（codex 16 M2：初始化中途抛错也不能留下监听句柄把自检进程拖住）
    try { await sectionBBody(server, tmp); } finally {
        await new Promise((r) => { try { server.closeAllConnections(); } catch (_) { /* 旧版本没有 */ } server.close(() => r()); });
    }
}

async function sectionBBody(server, tmp) {
    const port = server.address().port;
    const dbPath = path.join(tmp, 'inst.db');
    const wbsDir = path.join(tmp, 'wbs');
    const childJs = path.join(tmp, 'child.js');
    fs.mkdirSync(wbsDir);
    fs.writeFileSync(childJs, CHILD_JS_SRC);
    if (INJECT === 'identity-db') throw new Error('注入的故障：身份库初始化失败（--inject-fault=identity-db）');
    await instanceDb._internal.writeInstanceIdentity(dbPath, { instanceId: INSTANCE, parent: 'main', from: 'verify-test-env-finish' });

    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(TEST_|SDH_)/i.test(k)) baseEnv[k] = v;
    const runChild = (mode, extra) => new Promise((resolve) => {
        const env = Object.assign({}, baseEnv, {
            TEST_INSTANCE: INSTANCE, TEST_BASE_URL: `http://127.0.0.1:${port}`, TEST_DB_PATH: dbPath, TEST_JWT_SECRET: 'finish-suite-secret',
            CHILD_TE: TE_PATH, CHILD_WBS: wbsDir,
        }, extra || {});
        const t0 = performance.now();
        const child = spawn(process.execPath, [childJs, mode], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let timedOut = false;
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) { /* 句柄在手 */ } }, 60000);
        // 'close' 在进程退出且 stdio 管道读完之后触发（比 'exit' 稳：不丢最后一段输出）
        child.on('close', (code, signal) => {
            clearTimeout(killer);
            resolve({ code, signal, stdout, stderr, ms: performance.now() - t0, timedOut });
        });
    });
    const firstLine = (s) => String(s || '').split(/\r?\n/).find((l) => l.trim() !== '') || '';

    {
        // B.1–B.3：finish(0) × 5
        const runs = [];
        for (let i = 0; i < 5; i++) runs.push(await runChild('finish0', { CHILD_FALLBACK_MS: '8000' }));
        runs.forEach((r, i) => note(`finish(0) 第 ${i + 1} 次：exit=${r.code} signal=${r.signal} 耗时=${Math.round(r.ms)}ms timedOut=${r.timedOut}${r.stderr ? ` stderr首行=${firstLine(r.stderr).slice(0, 120)}` : ''}`));
        check('B.1', 'ready → fetch 两次 → teardown → finish(0)，连跑 5 次：退出码全部为 0（不是崩溃码，也不是哨兵的 70）', runs.every((r) => r.code === 0 && r.signal === null && !r.timedOut), runs.map((r) => ({ code: r.code, signal: r.signal })));
        check('B.2', '同上 5 次：stdout 有 done、stderr 无 Assertion failed / UV_HANDLE_CLOSING（无 libuv 断言崩溃）',
            runs.every((r) => /done 200 401/.test(r.stdout) && !/Assertion failed|UV_HANDLE_CLOSING/.test(r.stderr)), runs.map((r) => firstLine(r.stderr).slice(0, 160) || firstLine(r.stdout)));
        const maxMs = Math.max(...runs.map((r) => r.ms));
        check('B.3', '同上 5 次：耗时远小于兜底时长（兜底设 8000ms，最慢一次 < 5000ms：事件循环自然结束，没等兜底计时器）', maxMs < 5000, { maxMs: Math.round(maxMs) });

        // B.4 对照组：只记录，不断言
        for (let i = 0; i < 5; i++) {
            const r = await runChild('exit0');
            note(`对照组 process.exit(0) 第 ${i + 1} 次（只记录、不断言）：exit=${r.code} signal=${r.signal} 耗时=${Math.round(r.ms)}ms stderr首行=${firstLine(r.stderr).slice(0, 160) || '(空)'}`);
        }

        // B.5 兜底
        const fb = await runChild('fallback3', { CHILD_FALLBACK_MS: '1500' });
        note(`兜底 finish(3)：exit=${fb.code} 耗时=${Math.round(fb.ms)}ms`);
        check('B.5', '兜底：留一个 ref 的句柄（setInterval）后 finish(3)，进程在兜底时长（1500ms）之后才以 3 退出（不是自然结束，也不挂起）',
            fb.code === 3 && !fb.timedOut && fb.ms >= 1400 && fb.ms < 20000 && /done/.test(fb.stdout), { code: fb.code, ms: Math.round(fb.ms), timedOut: fb.timedOut });

        // B.6 哨兵
        const sen = await runChild('sentinel');
        check('B.6', '哨兵未被削弱：ready 成功后不 teardown、不 finish、不 exit，自然结束 → 退出码 70 且 stderr 有「退出码兜底」', sen.code === 70 && /退出码兜底/.test(sen.stderr), { code: sen.code, stderr: firstLine(sen.stderr).slice(0, 120) });

        // B.7 finish(5)
        const f5 = await runChild('finish5', { CHILD_FALLBACK_MS: '8000' });
        check('B.7', 'teardown 之后 finish(5) 并自然结束：退出码 5（取 process.exitCode，不被哨兵改成 70）', f5.code === 5 && !f5.timedOut, { code: f5.code });

        // B.9 裸调 teardown()（不 await 不 catch）且失败：原 promise 的拒绝由内部处理器接收并在返回的派生 promise 里原样重新抛出，调用方不消费派生 promise → 仍是未处理的拒绝 → 退出码非零
        const bare = await runChild('td_bare_fail');
        // 注意：退出码不一定是 1——未处理的拒绝在 fetch 刚完成时终止进程，本机上会撞同一个 libuv 断言（崩溃码 3221226505）；判据是「非零（不是静默的 0，也不是哨兵的 70）且 stderr 有失败原因」
        check('B.9', '子进程里裸调 teardown()（不 await、不 catch）且 teardown 失败：返回的派生 promise 原样重新抛出，调用方不消费它 → 仍产生未处理拒绝，进程以非零退出码结束（不是静默的 0，也不是哨兵的 70），stderr 里有失败原因 stop boom（H1 的判别落在 stderr 子判据上：v3 起「非零」已由哨兵自然排空分支兜底）',
            bare.code !== 0 && bare.code !== null && bare.code !== 70 && !bare.timedOut && /stop boom/.test(bare.stderr), { code: bare.code, timedOut: bare.timedOut, stderr: firstLine(bare.stderr).slice(0, 160) });

        // B.10 / B.11 teardown 失败后 finish(0) / finish(1)
        const f0 = await runChild('td_fail_finish0', { CHILD_FALLBACK_MS: '8000' });
        check('B.10', '`await teardown().catch(() => {}); finish(0)`（teardown 失败被吞掉）：退出码实际为 1，stderr 有「最近一次 teardown 失败，退出码由 0 改为 1」一行，不抛错',
            f0.code === 1 && !f0.timedOut && /最近一次 teardown 失败，退出码由 0 改为 1/.test(f0.stderr) && !/TestEnvError|TE_FINISH/.test(f0.stderr), { code: f0.code, timedOut: f0.timedOut, stderr: firstLine(f0.stderr).slice(0, 160) });
        const f1 = await runChild('td_fail_finish1', { CHILD_FALLBACK_MS: '8000' });
        check('B.11', '`await teardown().catch(() => {}); finish(1)`：退出码 1，且既不写 finish 的「由 0 改为 1」，也不写哨兵的「退出码兜底」（已非零的退出码保持原值，只有 0 才被改）', f1.code === 1 && !f1.timedOut && !/由 0 改为 1/.test(f1.stderr) && !/退出码兜底/.test(f1.stderr), { code: f1.code, timedOut: f1.timedOut, stderr: firstLine(f1.stderr).slice(0, 160) });

        // B.12 / B.13 哨兵的自然排空分支：teardown 失败（被吞掉）后自然结束 → 1 + 原因行；teardown 成功后自然结束 → 仍是 0
        const nf = await runChild('td_fail_natural');
        check('B.12', '`await teardown().catch(() => {}); return;`（teardown 失败被吞掉，不 finish、不 exit，自然结束）：退出码 1（不是 0，也不是 70），stderr 有「最近一次 teardown 失败」的哨兵原因行',
            nf.code === 1 && !nf.timedOut && /退出码兜底：最近一次 teardown 失败/.test(nf.stderr) && !/被改为 70/.test(nf.stderr), { code: nf.code, timedOut: nf.timedOut, stderr: firstLine(nf.stderr).slice(0, 160) });
        const no = await runChild('td_ok_natural');
        check('B.13', '`await teardown(); return;`（teardown 成功后自然结束）：退出码仍为 0，stderr 没有哨兵原因行',
            no.code === 0 && !no.timedOut && !/退出码兜底/.test(no.stderr), { code: no.code, timedOut: no.timedOut, stderr: firstLine(no.stderr).slice(0, 160) });
    }
}

/** B.8 故障注入：自检自己以 --only=B --inject-fault=identity-db 再跑一遍，节 B 在身份库初始化处抛错。要求：记录失败（Z.B FAIL）、汇总行在、非零退出、有界时间内结束（假服务被 finally 关掉，没有监听句柄拖住进程） */
async function sectionB8(tmp) {
    const sub = path.join(tmp, 'b8');
    fs.mkdirSync(sub);
    const childArgs = [__filename, '--only=B', '--inject-fault=identity-db', `--tmp=${sub}`, `--test-env=${TE_PATH}`, `--fixture=${FX_PATH}`];
    const t0 = performance.now();
    const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, childArgs, { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = ''; let timedOut = false;
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        const k = setTimeout(() => { timedOut = true; try { c.kill(); } catch (_) { /* 句柄在手 */ } }, 30000);
        c.on('close', (code, signal) => { clearTimeout(k); resolve({ code, signal, out, err, timedOut }); });
    });
    const ms = performance.now() - t0;
    check('B.8', '故障注入（身份库初始化失败）：自检子进程记录失败（CHECK Z.B FAIL 与汇总行 FAIL=1）、退出码非零、在 20 秒内自行结束（假服务已被关掉，没有监听句柄拖住进程；挂起会被判为超时）',
        !r.timedOut && r.code === 1 && /CHECK Z\.B FAIL/.test(r.out) && /verify-test-env-finish PASS=0 FAIL=1/.test(r.out) && ms < 20000, { code: r.code, timedOut: r.timedOut, ms: Math.round(ms), out: r.out.slice(-300), err: r.err.slice(0, 200) });
}

// ---------------------------------------------------------------- main

function cleanupTmp(tmp) {
    // 不用 fs.rmSync（本仓库路径含中文时 Node v24 静默出错）：逐个 unlink / rmdir
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            if (st.isDirectory()) { walk(p); fs.rmdirSync(p); } else fs.unlinkSync(p);
        }
    };
    try { walk(tmp); fs.rmdirSync(tmp); } catch (e) { note(`临时目录清理未完成：${tmp}（${e.message}）`); }
}

/** 节内未捕获的异常记成一条失败（编号 Z.<节>），后面的节照常跑——一节抛错不能让整套悄悄少跑 */
async function guarded(sec, fn) {
    try { await fn(); } catch (e) { check(`Z.${sec}`, `节 ${sec} 抛出未预期的异常（该节后续断言未执行）`, false, (e && e.stack) || String(e)); }
}

let FINISHED = false;
// 自检进程在跑完之前就退出（例如被测代码在进程内真的调了 process.exit）：不能留下「无汇总行、退出码 0」的假绿
process.on('exit', () => {
    if (FINISHED) return;
    try { fs.writeSync(1, `CHECK Z.1 FAIL 自检进程在跑完之前退出（退出码 ${process.exitCode === undefined ? 0 : process.exitCode}；被测代码在进程内调用了真实的 process.exit？）\n`); } catch (_) { /* 无处可写 */ }
    process.exitCode = 1;
});

async function main() {
    const TMP_ARG = argVal('--tmp=');   // B.8 的子进程用：临时目录由父进程建在自己的临时目录里、由父进程清理
    const tmp = TMP_ARG || fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-finish-'));
    try {
        if (want('A')) await guarded('A', sectionA);
        if (want('F')) await guarded('F', () => sectionF(tmp));
        if (want('B')) await guarded('B', () => sectionB(tmp));
        if (want('B8')) await guarded('B8', () => sectionB8(tmp));
    } finally {
        I.resetForTest();
        restoreExit();
        if (!TMP_ARG) cleanupTmp(tmp);
    }
    FINISHED = true;
    console.log(`verify-test-env-finish PASS=${PASS} FAIL=${FAIL}`);
    process.exitCode = FAIL === 0 ? 0 : 1;
}

main().catch((e) => {
    FINISHED = true;
    console.log(`CHECK Z.0 FAIL 自检主流程异常\n         ${(e && e.stack) || e}`);
    console.log(`verify-test-env-finish PASS=${PASS} FAIL=${FAIL + 1}`);
    process.exitCode = 1;
});
