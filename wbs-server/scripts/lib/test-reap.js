/**
 * 测试回收共享模块（#106 S3c 修复批 1 · 第 2 节）
 *
 * 为什么有它：「测试套件自己回收实例 / 进程、最后删私有根」在三个套件里连续出 HIGH（S3a 12T H1、S3b 13T H2 → 13T-R H1 / H2、S3c 14T H1 / H2），
 * 每个套件各写一套、各漏一处。这里把「登记 → 按身份回收 → 删除闸门」收成一份。S3c 套件先用；S3a / S3b 套件本批不改（是否改用随用户裁定）。
 *
 * 提供：
 *   ① 登记文件协议：私有根内一个**追加写**的 JSONL 文件（第一行是表头），每行一条记录
 *        { kind: 'instance' | 'proc', pid, startTime（精确创建时间，ISO 7 位小数；取不到时为 null）, dataDir?, instance?, label, owner }
 *      写失败即抛（ReapError REAP_REGISTRY_WRITE_FAILED，不吞）；读时损坏行 / 缺表头 / 未写完的末行 / 读取失败都计入 problems（不当成空登记）。
 *      同时把 { pid, start } 镜像追加到监督进程的登记文件（环境变量 S2C_TEST_REGISTRY，与 lines-test-supervisor.js 的协议一致：套件被强杀 / 超时后监督进程按这份登记回收），
 *      镜像写失败同样抛错；配了监督登记文件却没有精确创建时间的记录也抛（REAP_SUPERVISOR_NO_START_TIME，不再静默跳过）。所以套件、辅助进程、桩成员、孙进程**只写一次登记**，两层回收都能读到。
 *      **登记前先进内存**（修复批 2）：合法记录与句柄 / stop 先放进回收器内存、再落盘；写失败仍抛、记入 failures，但回收器内存里的条目不丢，外层 reapAll / verifyAllGone 仍能按身份把进程收掉。
 *      创建时间只接受约定的七位小数 ISO，其他精度按不合法记录拒绝登记（记入 failures），不补零当精确身份。
 *   ② 辅助进程立即登记：test-reap-preload.js（可 --require 的预加载片段，与库路径守卫 / .env 守卫同一个文件）包住启动器的 startTestInstance，句柄一返回就追加登记；
 *      桩成员 / 孙进程用 registerSelfFromEnv() 在做任何别的事之前先登记自己。
 *   ③ 按身份回收 reaper.reapAll()：对每条登记要求**明确的退出证据**——句柄已触发 exit，或精确身份查询为 dead / reused。
 *      创建时间缺失、查询抛错、未知状态、终止抛错、终止后仍 match、超过总截止，一律计入 left（不当成已消失）。仍 match 的先走实例的 stop() / 句柄，再按「PID + 创建时间」终止，终止后复核。
 *      回收有总截止（deadlineMs）。
 *   ④ 删除闸门 evalDeleteGate / reaper.finalGate：只有「待启动集合为空、放弃的批跑已落定、回收没有 left / 超截止 / 抛错、登记文件没有损坏、遗留清理没有保留项或失败项、
 *      **终检（新鲜读登记 + 逐项核身份，覆盖实例 / 辅助进程 / 成员 / 孙进程全部条目）全部有退出证据**、没有任何登记失败（第十条，修复批 2）」才 safe；否则判红并保留现场。
 *
 * 依赖注入：createReaper({ proc }) 可以替换 getStartTime / checkIdentity / killIfIdentity / killTree / isAlive（自检用来逐个构造「不确定」分支；trackChild 的免镜像两步判定依赖 isAlive）。
 * 绝不按裸 PID 终止；唯一的无创建时间终止路径是「句柄仍在手且 Node 认为它在运行」（PID 被句柄钉住）时的 killTree。
 */
'use strict';

const fs = require('fs');
const defaultProc = require('../../../scripts/lines/line-proc');

const KINDS = Object.freeze(['instance', 'proc']);
const REGISTRY_HEADER = '{"registry":"sdh-test-reap","v":1}';
/** 约定的精确创建时间：ISO UTC，**恰好七位小数**（line-proc 的 getStartTime 写出的格式）。其他精度（三位毫秒、六位微秒、八位……）一律不接受：底层 checkIdentity 对格式不符的值按「reused」处理，会被误当成已消失 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
/** 监督进程的登记文件环境变量（lines-test-supervisor.js 的 REGISTRY_ENV） */
const SUPERVISOR_REGISTRY_ENV = 'S2C_TEST_REGISTRY';
/** 本模块登记文件 / 归属的环境变量：子进程（辅助进程、桩成员、孙进程）继承后即可登记到同一份文件 */
const REGISTRY_ENV = 'SDH_REAP_REGISTRY';
const OWNER_ENV = 'SDH_REAP_OWNER';

class ReapError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ReapError';
        this.code = code;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describeErr = (e) => `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`;
const validStart = (s) => typeof s === 'string' && ISO_RE.test(s);

// ---------------------------------------------------------------- 登记文件协议

/** 校验并规范化一条记录；不合法抛 REAP_BAD_RECORD */
function normalizeRecord(input, defaultOwner) {
    const bad = (m) => new ReapError('REAP_BAD_RECORD', `登记记录不合法：${m}`);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw bad('不是对象');
    if (!KINDS.includes(input.kind)) throw bad(`kind 必须是 ${KINDS.join(' / ')}`);
    if (!(Number.isSafeInteger(input.pid) && input.pid > 0)) throw bad('pid 必须是正整数');
    const startTime = input.startTime === undefined ? null : input.startTime;
    if (startTime !== null && !validStart(startTime)) throw bad('startTime 必须是 null 或精确创建时间（ISO，7 位小数）');
    if (typeof input.label !== 'string' || input.label === '') throw bad('label 必须是非空字符串');
    const owner = input.owner === undefined ? defaultOwner : input.owner;
    if (typeof owner !== 'string' || owner === '') throw bad('owner 必须是非空字符串');
    if (input.dataDir !== undefined && input.dataDir !== null && typeof input.dataDir !== 'string') throw bad('dataDir 必须是字符串');
    if (input.instance !== undefined && input.instance !== null && typeof input.instance !== 'string') throw bad('instance 必须是字符串');
    const rec = { kind: input.kind, pid: input.pid, startTime, label: input.label, owner };
    if (typeof input.dataDir === 'string') rec.dataDir = input.dataDir;
    if (typeof input.instance === 'string') rec.instance = input.instance;
    return rec;
}

const recordKey = (r) => `${r.pid}|${r.startTime === null || r.startTime === undefined ? 'null' : r.startTime}`;

/** 全新创建登记文件（wx：已存在即失败）+ 写表头 + 读回核对。返回 null（成功）或问题文字 */
function initRegistry(file) {
    try {
        fs.writeFileSync(file, `${REGISTRY_HEADER}\n`, { flag: 'wx' });
        const back = readRegistryFile(file);
        if (back.problems.length) return `登记文件创建后读回校验不通过：${back.problems.join('；')}`;
        return null;
    } catch (e) {
        return `登记文件创建 / 写入 / 读回失败：${describeErr(e)}（${file}）`;
    }
}

/** 追加一条记录。写失败（含路径是目录 / 被删）抛 REAP_REGISTRY_WRITE_FAILED。文件必须已存在（initRegistry 建好），不在追加时悄悄新建 */
function appendRecord(file, rec) {
    const r = normalizeRecord(rec, rec && rec.owner);
    try {
        fs.statSync(file);
        fs.appendFileSync(file, `${JSON.stringify(r)}\n`);
    } catch (e) {
        throw new ReapError('REAP_REGISTRY_WRITE_FAILED', `登记写入失败（${r.label} pid ${r.pid}）：${describeErr(e)}`);
    }
    return r;
}

/** 严格读。返回 { records（按 pid + 创建时间去重）, problems }：problems 非空 = 登记通道失效（读取失败 / 缺表头 / 损坏行 / 末行没写完），调用方判失败，不当成空登记 */
function readRegistryFile(file) {
    const problems = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { records: [], problems: [`登记文件读取失败：${describeErr(e)}`] }; }
    if (text === '') return { records: [], problems: ['登记文件是空的（连表头都没有）'] };
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') problems.push('登记文件末行没有换行结尾（最后一次写入不完整）');
    else lines.pop();
    if (lines[0] !== REGISTRY_HEADER) problems.push('登记文件缺少表头（或表头被改动）');
    const seen = new Map();
    const records = [];
    for (let i = 1; i < lines.length; i += 1) {
        const raw = lines[i].replace(/\r$/, '');
        if (raw.trim() === '') continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { problems.push(`登记文件第 ${i + 1} 行不是合法 JSON：${JSON.stringify(raw.slice(0, 80))}`); continue; }
        let rec;
        try { rec = normalizeRecord(parsed, parsed && parsed.owner); } catch (e) { problems.push(`登记文件第 ${i + 1} 行：${e.message}`); continue; }
        const k = recordKey(rec);
        if (seen.has(k)) {
            const prev = seen.get(k);
            if (prev.dataDir === undefined && rec.dataDir !== undefined) prev.dataDir = rec.dataDir;
            if (prev.instance === undefined && rec.instance !== undefined) prev.instance = rec.instance;
            continue;
        }
        seen.set(k, rec);
        records.push(rec);
    }
    return { records, problems };
}

/**
 * 镜像到监督进程的登记文件：{ pid, start }（监督进程只认精确创建时间）。文件必须已存在（监督进程启动套件前创建并验证），不新建。
 * 配了监督登记文件（file 非空）却没有精确创建时间的记录**不再静默跳过**（监督进程回收不了它）：抛 REAP_SUPERVISOR_NO_START_TIME（fail-closed，由 register 计入登记失败）。没配监督登记文件时不镜像、不抛。
 * 唯一例外在 register：trackChild 的创建时间查询答复 null **且** proc.isAlive(pid) === false（两步判定：CIM 在进程活着时也可能静默返回空；isAlive 抛错按未退出处理）时不调用本函数——进程登记前已退出，没有东西可回收。
 */
function mirrorToSupervisor(file, rec) {
    if (!file) return;
    if (!validStart(rec.startTime)) {
        throw new ReapError('REAP_SUPERVISOR_NO_START_TIME', `监督进程登记需要精确创建时间，该记录没有（${rec.label} pid ${rec.pid}）：监督进程无法按身份回收它`);
    }
    try {
        fs.statSync(file);
        fs.appendFileSync(file, `${JSON.stringify({ pid: rec.pid, start: rec.startTime })}\n`);
    } catch (e) {
        throw new ReapError('REAP_SUPERVISOR_REGISTRY_WRITE_FAILED', `监督进程登记写入失败（${rec.label} pid ${rec.pid}）：${describeErr(e)}`);
    }
}

// ---------------------------------------------------------------- 回收器

const childRunning = (c) => !!c && c.exitCode === null && c.signalCode === null;
function waitChildExit(child, ms) {
    if (!childRunning(child) || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        let t = null;
        const done = () => { clearTimeout(t); resolve(); };
        t = setTimeout(done, ms);
        child.once('exit', done);
        child.once('error', () => { if (!childRunning(child)) done(); });
    });
}

/**
 * opts = { file（本模块登记文件，可为 null）, owner（缺省归属）, proc（可替换的进程工具）, supervisorRegistry（默认取环境变量 S2C_TEST_REGISTRY）,
 *          recheckMs（终止后复核窗口，默认 5000）, childWaitMs（句柄终止后等 exit 事件的上限，默认 3000）, stopWaitMs（实例 stop() 的等待上限，默认 20000） }
 */
function createReaper(opts) {
    const o = opts || {};
    const proc = Object.assign({}, defaultProc, o.proc || {});
    const file = o.file || null;
    const supervisorFile = o.supervisorRegistry === undefined ? (process.env[SUPERVISOR_REGISTRY_ENV] || null) : o.supervisorRegistry;
    const defaultOwner = o.owner || 'suite';
    const recheckMs = Number.isFinite(o.recheckMs) ? o.recheckMs : 5000;
    const childWaitMs = Number.isFinite(o.childWaitMs) ? o.childWaitMs : 3000;   // 句柄终止后等 exit 事件的上限
    const stopWaitMs = Number.isFinite(o.stopWaitMs) ? o.stopWaitMs : 20000;     // 实例 stop() 的等待上限
    const mem = new Map();        // key → { key, rec, child, stop }：本进程里有句柄 / stop 的条目
    const failures = [];          // 登记写入失败等（不吞）

    /** 把条目放进内存（登记文件里有没有它无关）：同一 PID + 创建时间合并，句柄 / stop 取新的、没有则保留旧的 */
    function holdInMemory(rec, ext) {
        const key = recordKey(rec);
        const prev = mem.get(key);
        mem.set(key, {
            key, rec: prev ? Object.assign({}, prev.rec, rec) : rec,
            child: (ext && ext.child) || (prev && prev.child) || null,
            stop: (ext && ext.stop) || (prev && prev.stop) || null,
        });
    }

    /** 记录本身不合法（登记不了）但句柄 / stop 在手：仍把它们放进内存（创建时间记 null，退出证据只能来自句柄），外层 reapAll 按句柄收；pid 都不合法就没有可收的东西 */
    function holdUnregistered(input, ext) {
        const i = input !== null && typeof input === 'object' ? input : {};
        if (!(Number.isSafeInteger(i.pid) && i.pid > 0)) return;
        if (!ext || (!ext.child && !ext.stop)) return;
        holdInMemory({ kind: KINDS.includes(i.kind) ? i.kind : 'proc', pid: i.pid, startTime: null, label: typeof i.label === 'string' && i.label !== '' ? i.label : 'unregistered', owner: defaultOwner }, ext);
    }

    /**
     * 登记一条记录。ext = { child, stop } 是本进程里的句柄。
     * 顺序：校验（不合法：记登记失败、句柄仍进内存、抛）→ **合法记录与句柄先放进内存** → 先写本模块登记文件 → 后镜像到监督进程登记文件；任何一步失败都记入 failures 并抛，
     * 但内存里的条目不丢：外层 reapAll / verifyAllGone / finalGate 仍能看到它、按身份把进程收掉（登记失败不再让进程脱离回收，14-R H1 / 14T-R H1）。
     */
    function register(input, ext) {
        let rec;
        try {
            rec = normalizeRecord(input, defaultOwner);
        } catch (e) {
            failures.push(e);
            holdUnregistered(input, ext);
            throw e;
        }
        holdInMemory(rec, ext);
        try {
            if (file) appendRecord(file, rec);
            // 创建时间查询答复 null 且 isAlive 确认该 PID 已不存在（进程在登记前已退出，例如用法错误的入口一闪而过）时，监督进程没有东西可回收：不要求镜像；
            // 其余没有精确创建时间的记录（查询失败 / 抛错 / 查询答复 null 但进程还活着 / 直接登记）镜像时 fail-closed
            if (!(ext && ext.processGone === true)) mirrorToSupervisor(supervisorFile, rec);
        } catch (e) {
            failures.push(e);
            throw e;
        }
        return rec;
    }

    /**
     * 登记自己 spawn 的子进程（句柄在手）：立即取精确创建时间（取不到 / 抛错记 null，退出证据只能来自句柄），返回记录；没有 pid（spawn 失败）返回 null。
     * 创建时间答复 null 时再问 proc.isAlive：只有它明确返回 false 才算「进程已不存在」（免监督镜像）；仍活着 / 抛错按未退出处理，镜像时 fail-closed。
     * 取到了但精度不符合约定（不是七位小数）→ 按不合法记录拒绝登记（计入登记失败并抛），句柄仍留在内存供回收，不补零当精确身份。
     */
    function trackChild(label, child, extra) {
        if (!child || !Number.isSafeInteger(child.pid)) return null;
        let start = null;
        let processGone = false;
        try {
            start = proc.getStartTime(child.pid);
            // 免镜像例外要两步判定（收口小批第 1 项 / 预筛 v3 L1）：创建时间查询答复 null 只是「CIM 查询成功但结果为空」，进程活着时 CIM 也可能静默返回空；
            // 所以还要 proc.isAlive(pid) === false 才认定「进程已不存在」。isAlive 抛错 / 不是函数 / 返回别的值一律按「未退出」处理（fail-closed）：照常要求镜像，镜像失败抛 REAP_SUPERVISOR_NO_START_TIME。
            if (start === null) {
                let alive = true;
                try { alive = proc.isAlive(child.pid) !== false; } catch (_) { alive = true; }
                processGone = !alive;
            }
        } catch (_) { start = null; }   // 抛错 = 查询失败（不能当成已退出）
        return register({ kind: 'proc', pid: child.pid, startTime: start === undefined ? null : start, label, owner: extra && extra.owner }, { child, processGone });
    }

    /** 登记启动器交出的实例句柄（kind=instance，带数据根，stop 绑定当时的真实 stop）。句柄的创建时间精度不符合约定同样拒绝登记（计入登记失败并抛），stop 仍留在内存 */
    function trackInstance(label, h) {
        if (!h || !Number.isSafeInteger(h.pid)) {
            // 没有 pid 的句柄登记不了：抛错之前先记入 failures（收口小批第 3 项），直接调 API 也不会让闸门放行
            const bad = new ReapError('REAP_BAD_RECORD', `登记记录不合法：实例句柄没有 pid（${label}）`);
            failures.push(bad);
            throw bad;
        }
        const stop = typeof h.stop === 'function' ? h.stop.bind(h) : null;
        return register({ kind: 'instance', pid: h.pid, startTime: h.startTime === undefined ? null : h.startTime, dataDir: h.dataDir || undefined, instance: h.instance || undefined, label }, { stop });
    }

    /** 本进程内存里的条目（含句柄）与登记文件的并集；problems = 登记文件读取 / 损坏问题 */
    function collect() {
        const problems = [];
        const byKey = new Map();
        if (file) {
            const r = readRegistryFile(file);
            problems.push(...r.problems);
            for (const rec of r.records) byKey.set(recordKey(rec), { key: recordKey(rec), rec, child: null, stop: null });
        }
        for (const [key, m] of mem) {
            const cur = byKey.get(key);
            if (cur) { cur.rec = Object.assign({}, cur.rec, m.rec); cur.child = m.child; cur.stop = m.stop; } else byKey.set(key, m);
        }
        return { entries: Array.from(byKey.values()), problems };
    }

    /** 不终止、只判退出证据：{ state: 'gone', evidence } | { state: 'alive' } | { state: 'unknown', reason } */
    function evaluate(e) {
        const c = e.child;
        if (c && !childRunning(c)) return { state: 'gone', evidence: 'handle-exit' };
        const start = e.rec.startTime;
        if (!validStart(start)) {
            if (childRunning(c)) return { state: 'alive' };   // 没有创建时间，但句柄在手且 Node 认为它在运行：PID 被句柄钉住
            return { state: 'unknown', reason: 'no-start-time（创建时间缺失，且没有句柄的退出证据）' };
        }
        let r;
        try { r = proc.checkIdentity({ pid: e.rec.pid, start_time: start }); } catch (err) { return { state: 'unknown', reason: `identity-query-failed（${describeErr(err)}）` }; }
        const s = r && r.state;
        if (s === 'dead' || s === 'reused') return { state: 'gone', evidence: `identity-${s}` };
        if (s === 'match') return { state: 'alive' };
        return { state: 'unknown', reason: `unknown-state（${String(s)}）` };
    }

    const item = (e, extra) => Object.assign({ key: e.key, kind: e.rec.kind, label: e.rec.label, owner: e.rec.owner, pid: e.rec.pid, startTime: e.rec.startTime, dataDir: e.rec.dataDir || null, instance: e.rec.instance || null }, extra || {});

    async function reapOne(e, deadline) {
        const rem = () => Math.max(0, deadline - Date.now());
        // 等待计时器可清理：stop() 先完成 / 拒绝时立即清除，不让引用计时器把进程自然退出拖慢到 stopWaitMs（默认 20 秒；14-R M / 14T-R M7）
        const runStop = async () => {
            let stopTimer = null;
            try {
                await Promise.race([
                    Promise.resolve().then(() => e.stop()),
                    new Promise((resolveWait) => { stopTimer = setTimeout(resolveWait, Math.min(stopWaitMs, rem())); }),
                ]);
            } catch (_) { /* 下面按身份复核 */ } finally { clearTimeout(stopTimer); }
        };
        let ev = evaluate(e);
        if (ev.state === 'gone') return { gone: true, forced: false, evidence: ev.evidence };
        if (ev.state === 'unknown') {
            // 没有创建时间（登记不上 / 精度不符）但实例的 stop() 在手：尽力 stop 一次（不能凭此判定已消失——没有退出证据仍计入 left，闸门不放行）
            if (!validStart(e.rec.startTime) && e.stop && rem() > 0) {
                await runStop();
                ev = evaluate(e);
                if (ev.state === 'gone') return { gone: true, forced: true, evidence: ev.evidence };
                return { gone: false, forced: true, reason: ev.reason || 'no-start-time（stop() 已尝试，仍无退出证据）' };
            }
            return { gone: false, forced: false, reason: ev.reason };
        }
        // 仍在：先让实例自己 stop()（句柄在手）
        if (e.stop && rem() > 0) {
            await runStop();
            ev = evaluate(e);
            if (ev.state === 'gone') return { gone: true, forced: true, evidence: ev.evidence };
            if (ev.state === 'unknown') return { gone: false, forced: true, reason: ev.reason };
        }
        // 句柄终止（Node 认为在运行时 PID 被钉住）
        if (childRunning(e.child) && rem() > 0) {
            try { e.child.kill(); } catch (_) { /* 下面按身份复核 */ }
            await waitChildExit(e.child, Math.min(childWaitMs, rem()));
            ev = evaluate(e);
            if (ev.state === 'gone') return { gone: true, forced: true, evidence: ev.evidence };
            if (ev.state === 'unknown') return { gone: false, forced: true, reason: ev.reason };
        }
        // 按「PID + 创建时间」终止；没有创建时间时只有句柄仍在手才允许按（被钉住的）PID 终止进程树
        let killNote = null;
        if (validStart(e.rec.startTime)) {
            try {
                const k = proc.killIfIdentity({ pid: e.rec.pid, start_time: e.rec.startTime });
                if (k && k.failed) killNote = 'kill-failed（终止命令报告失败）';
            } catch (err) { return { gone: false, forced: true, reason: `kill-threw（${describeErr(err)}）` }; }
        } else if (childRunning(e.child)) {
            try { if (proc.killTree(e.rec.pid) === false) killNote = 'kill-failed（终止命令报告失败）'; } catch (err) { return { gone: false, forced: true, reason: `kill-threw（${describeErr(err)}）` }; }
        }
        // 复核（有界）：终止后必须看到退出证据
        const end = Math.min(deadline, Date.now() + recheckMs);
        for (;;) {
            ev = evaluate(e);
            if (ev.state === 'gone') return { gone: true, forced: true, evidence: ev.evidence };
            if (ev.state === 'unknown') return { gone: false, forced: true, reason: ev.reason };
            if (Date.now() >= end) break;
            await sleep(Math.max(1, Math.min(200, end - Date.now())));
        }
        return { gone: false, forced: true, reason: killNote || 'still-alive-after-kill（终止后复核仍 match）' };
    }

    /**
     * 回收全部登记条目（登记文件 ∪ 本进程内存），整体有总截止 deadlineMs（默认 60 秒）。
     * 返回 { total（本次处理的条目数 = gone + left，**不含被 skip 的**）, skipped（被 skip 的条目数，新增字段）, gone: [item], forced: [item]（回收时仍活着，被回收器终止——被测代码没收干净）, left: [item + reason]（没有退出证据）, problems, timedOut }。
     * skip(entry) 只给自检的接缝用：被 skip 的条目既不处理也不计入 total / gone / forced / left（模拟「回收之后才出现 / 回收漏掉」的进程，只计入 skipped），只有终检 verifyAllGone 能发现它。
     */
    async function reapAll(ro) {
        const ropt = ro || {};
        const deadline = Date.now() + (Number.isFinite(ropt.deadlineMs) ? ropt.deadlineMs : 60000);
        const { entries, problems } = collect();
        const out = { total: 0, skipped: 0, gone: [], forced: [], left: [], problems, timedOut: false };
        for (const e of entries) {
            if (typeof ropt.skip === 'function' && ropt.skip(e)) { out.skipped += 1; continue; }
            out.total += 1;
            if (Date.now() >= deadline) { out.timedOut = true; out.left.push(item(e, { reason: 'deadline（回收总截止已到，未处理）' })); continue; }
            let r;
            try { r = await reapOne(e, deadline); } catch (err) { r = { gone: false, forced: false, reason: `reap-threw（${describeErr(err)}）` }; }
            if (r.forced) out.forced.push(item(e, { reason: r.reason }));
            if (r.gone) out.gone.push(item(e, { evidence: r.evidence })); else out.left.push(item(e, { reason: r.reason }));
        }
        if (Date.now() >= deadline && out.left.length > 0) out.timedOut = true;   // 总截止到点时仍有没拿到退出证据的条目：超截止
        return out;
    }

    /** 终检（不终止）：新鲜读登记 + 逐项核退出证据。{ ok, bad: [item + reason], problems, total } */
    function verifyAllGone() {
        const { entries, problems } = collect();
        const bad = [];
        for (const e of entries) {
            const ev = evaluate(e);
            if (ev.state !== 'gone') bad.push(item(e, { reason: ev.state === 'alive' ? 'still-alive（身份仍 match）' : ev.reason }));
        }
        return { ok: bad.length === 0 && problems.length === 0, bad, problems, total: entries.length };
    }

    /**
     * 最终删私有根的闸门：终检由本回收器新鲜计算，其余输入（待启动集合 / 回收结果 / 遗留清理）由调用方给。
     * 登记失败自动带上：调用方给的 registrationFailures（默认 0，例如预加载片段记下的登记类违规条数）原样交 evalDeleteGate 判合法性；
     * 本回收器的 failures.length 走 ownRegistrationFailures（覆盖调用方同名字段）。两者只相加、不相抵。
     * 返回 { safe, reasons, verify }：verify 就是这次算出的终检结果（新增字段，调用方想报告终检覆盖数时不必再调一次 verifyAllGone，省一遍逐条身份查询）。
     */
    function finalGate(inputs) {
        const verify = verifyAllGone();
        // 本回收器自己的 failures.length 走单独的输入 ownRegistrationFailures（调用方传的同名字段会被覆盖），外部 registrationFailures 原样交给 evalDeleteGate 判合法性：
        // 外部计数不能抵消本回收器的失败（本地 1 + 外部 -1 不再等于 0），非法值（字符串 / 布尔 / NaN / Infinity / 负数 / 小数）按失败处理（收口小批第 2 项）
        const gate = evalDeleteGate(Object.assign({}, inputs, { verify, ownRegistrationFailures: failures.length }));
        return Object.assign({}, gate, { verify });
    }

    return { register, trackChild, trackInstance, collect, evaluate, reapAll, verifyAllGone, finalGate, failures, file, owner: defaultOwner };
}

// ---------------------------------------------------------------- 删除闸门（纯函数）

/** 合法的失败计数：非负安全整数（字符串、布尔、NaN、Infinity、负数、小数、null 都不是） */
const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const describeVal = (v) => { try { return typeof v === 'string' ? JSON.stringify(v) : String(v); } catch (_) { return '[无法转成文字]'; } };

/**
 * 输入 i = { pendingStarts, pendingTimedOut, reap: { left, timedOut, problems }, reapErr, sweep: { kept, failed }, verify: { ok, bad, problems }, registrationFailures?（默认 0）, ownRegistrationFailures?（默认 0，finalGate 自动填本回收器的 failures.length）, extra?: [原因文字] }。
 * 十个条件任何一个不满足都 safe=false 并各给一条原因；safe=false 时调用方判红并保留现场（S3b 13T-R H2 的教训）。
 * 第十条「登记失败」：registrationFailures + ownRegistrationFailures > 0（登记写失败 / 镜像写失败 / 记录不合法 / 创建时间精度不符）→ 不放行——即使登记过的进程此刻都已确认消失（登记通道失效，登记集合不可信）。
 * 两个计数都 fail-closed（收口小批第 2 项）：给了但不是非负安全整数（字符串、布尔、NaN、Infinity、负数、小数、null）→ 同样按登记失败处理、不放行（一条原因）；不给（undefined）才取默认 0。合法值只相加、不相抵。
 */
function evalDeleteGate(i) {
    const reasons = [];
    const given = i.registrationFailures;
    const own = i.ownRegistrationFailures;
    const givenBad = given !== undefined && !isCount(given);
    const ownBad = own !== undefined && !isCount(own);
    const regFail = (isCount(given) ? given : 0) + (isCount(own) ? own : 0);
    if (i.pendingStarts > 0) reasons.push('还有未落定的启动');
    if (i.pendingTimedOut) reasons.push('放弃的批跑在等待截止内没有落定');
    if (i.reap.left.length > 0) reasons.push('登记进程回收后仍有没有退出证据的条目（创建时间缺失 / 身份查询失败 / 未知状态 / 终止失败 / 仍存活）');
    if (i.reap.timedOut) reasons.push('登记进程回收超截止');
    if (i.reap.problems.length > 0) reasons.push('登记文件有读取失败 / 损坏行 / 缺表头');
    if (i.reapErr) reasons.push('登记进程回收抛错');
    if (i.sweep.kept.length > 0) reasons.push('遗留清理有保留项');
    if (i.sweep.failed.length > 0) reasons.push('遗留清理有失败项');
    if (!i.verify.ok) reasons.push('终检：登记集合（实例 / 辅助进程 / 成员 / 孙进程）没有全部按身份确认消失');
    if (givenBad || ownBad) reasons.push(`登记失败计数输入不合法（registrationFailures=${describeVal(given)}，ownRegistrationFailures=${describeVal(own)}；合法值必须是非负安全整数），按登记失败处理：登记集合不可信，不放行${regFail > 0 ? `（其余合法计数合计 ${regFail} 次）` : ''}`);
    else if (regFail > 0) reasons.push(`登记失败 ${regFail} 次（登记写入 / 监督镜像 / 记录不合法 / 创建时间精度不符）：登记集合不可信，不放行`);
    for (const x of (i.extra || [])) reasons.push(String(x));
    return { safe: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- 子进程自登记

/**
 * 桩成员 / 孙进程 / 辅助进程在做任何别的事之前先登记自己（用 CIM 取**自己的精确创建时间**）。
 * 登记到环境变量 SDH_REAP_REGISTRY 指的文件和（若有）监督进程的 S2C_TEST_REGISTRY；两个都没有 → 抛 REAP_NO_REGISTRY。取不到创建时间、写失败都抛，调用方应在派生任何长寿子进程之前退出。
 * 返回记录。
 */
function registerSelfFromEnv(label, o) {
    const opt = o || {};
    const file = process.env[REGISTRY_ENV] || null;
    const sup = process.env[SUPERVISOR_REGISTRY_ENV] || null;
    if (!file && !sup) throw new ReapError('REAP_NO_REGISTRY', `没有可用的登记文件（环境变量 ${REGISTRY_ENV} / ${SUPERVISOR_REGISTRY_ENV} 都没设）`);
    const proc = Object.assign({}, defaultProc, opt.proc || {});
    const start = proc.getStartTime(process.pid);
    if (!validStart(start)) throw new ReapError('REAP_NO_START_TIME', `取不到自己（pid ${process.pid}）的精确创建时间`);
    const reaper = createReaper({ file, owner: opt.owner || process.env[OWNER_ENV] || 'member', supervisorRegistry: sup, proc });
    return reaper.register({ kind: 'proc', pid: process.pid, startTime: start, label });
}

module.exports = {
    createReaper, evalDeleteGate, registerSelfFromEnv, initRegistry, appendRecord, readRegistryFile, normalizeRecord, mirrorToSupervisor,
    ReapError, KINDS, REGISTRY_HEADER, REGISTRY_ENV, OWNER_ENV, SUPERVISOR_REGISTRY_ENV, ISO_RE,
    _internals: { recordKey, childRunning, waitChildExit },
};
