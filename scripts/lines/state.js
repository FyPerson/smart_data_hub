/**
 * 线路登记表与唯一状态更新入口（#106 多线并行改造 · S2a · 方案 W2「控制根定位」「线路登记表」「唯一状态更新入口」）
 *
 * 控制根：<主工作区根>/docs/local/多线并行/_state/（不进 git），下有 lines.json（登记表）与 locks/state.lock（状态锁）。
 *   resolveControlRoot 经 `git rev-parse --git-common-dir` 找到主仓库 .git，主工作区根 = 其父目录；主工作区与任一 linked worktree 解析结果相同。
 *
 * 状态锁（操作系统级、持有者死亡即自动释放）：把 locks/state.lock 当作一个空 SQLite 库打开，`BEGIN EXCLUSIVE` 取锁、COMMIT 后关闭连接释放。
 *   SQLite 在 Windows 上用 LockFileEx 字节区锁，进程退出（含被强杀）时由系统释放——没有过期 / 超时接管 / 判断旧进程死没死的逻辑；
 *   持有者活着时不论多久都不会被接管，等待方 busyTimeout 到期后抛 STATE_LOCK_TIMEOUT。进程内再加一条 FIFO 队列，避免同一进程里多个连接争抢占满线程池。
 *   持锁期间补丁函数必须是同步函数；返回 Promise（或 thenable）即抛 STATE_PATCH_ASYNC 并放弃本次写入；持锁期间不等待其他锁、不执行外部命令（方案「锁顺序」）。
 *
 * 写入口只有：updateLine / updateConfig / createLine / removeLineRecord（都走 mutate：取锁 → 重读 → 校验整体 → 应用补丁 → 再次校验 → 写同目录临时文件并 fsync → renameSync 原子替换 → 释放锁）。
 *   模块不导出任何「整体写回登记表」的函数。updateLine 的补丁函数只拿到该线记录的深拷贝，结构上拿不到其他线的记录。
 *   读：readState 也在锁内读——Windows 上 renameSync 替换目标期间，同时读该文件可能遇到 EPERM / EBUSY，锁内读避开这种瞬时冲突（比「证明锁外读不冲突」简单可靠）。
 *       例外：锁文件不存在（从来没人写过）时没有可争用的写者，锁外直接读登记表（不存在则视为空表），不为读取而建目录。
 *   登记表损坏（JSON 解析失败 / 结构校验失败）→ 抛 STATE_CORRUPT，绝不静默重置为空表；文件不存在 → 空表（首次使用）。
 *
 * 错误码（err.code）：STATE_BAD_ARGS / STATE_NO_GIT / STATE_LOCK_TIMEOUT / STATE_LOCK_FAILED / STATE_CORRUPT / STATE_READ_FAILED / STATE_VERSION_NEWER / STATE_VERSION_OLDER /
 *   STATE_INVALID_PATCH / STATE_PATCH_ASYNC / STATE_NO_SUCH_LINE / STATE_LINE_EXISTS / STATE_BAD_NAME / STATE_NO_FREE_SLOT / STATE_BAD_TRANSITION / STATE_FIELD_IMMUTABLE /
 *   STATE_PROCESS_REGISTERED / STATE_REPLACE_FAILED / STATE_WRITE_FAILED / STATE_LOCK_UNCERTAIN / STATE_LINE_BUSY / STATE_LINE_REENTRANT / STATE_LOCK_ORDER / STATE_GENERATION_MISMATCH。
 *   补丁函数自己抛出的错误（含 throw null / undefined / 0 / false / '' 这类假值）原样抛出（登记表未变、锁已释放）。
 *
 * 修复批 1（codex 09）：①临时文件循环 writeSync 直到写满（零进展 = 错误）、fsync 成功后才 rename，任一步失败关 fd、删临时文件、抛 STATE_WRITE_FAILED；
 *   ②连接关闭 / COMMIT / ROLLBACK 的错误不再被吞：显式跟踪事务是否结束，COMMIT 失败补 ROLLBACK，业务异常优先保留并附 cleanupErrors，队列在任何路径都被释放；
 *   ③成败用独立布尔 hasFailure 区分，补丁抛假值也 ROLLBACK 并原样重抛；④async 补丁（原生 AsyncFunction 或返回真 Promise）先挂 .catch 再拒绝，不留未处理拒绝；
 *   ⑤补丁结果与初始化数据在 JSON 往返之前按字段类型表校验（undefined / 非有限数 / 函数 / Symbol / BigInt / toJSON / 非纯对象 / 数组空位 / 存取器 / 环）；
 *   ⑥排队等待计入 lockTimeoutMs：截止时间从调用开始算，FIFO 等待超时报 STATE_LOCK_TIMEOUT 且不破坏队列顺序，剩余时间作为 sqlite busyTimeout（"至少等待"这么久，不是精确值）。
 * 修复批 1 追加（Opus 预筛裁定 3b）：⑦COMMIT 在 rename 成功后失败 → 记警告、补 ROLLBACK、照常 close、按成功返回；⑧nowIso 在锁内算；⑨非 ENOENT 读错误报 STATE_READ_FAILED；
 *   ⑩调 git 时从 env 去掉 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_INDEX_FILE；⑪测试接缝一律经 _internal.setTestHooks，不进公开 API 的 opts；
 *   ⑫createLine 的 opts.guard(others) 在锁内同步执行（S2b 的同模块闸门）；⑬转 removing / removed 要求结果记录 process === null（STATE_PROCESS_REGISTERED），转 removed 同一次写清空 yield_request；
 *   ⑭version 大于本代码报 STATE_VERSION_NEWER、小于报 STATE_VERSION_OLDER；⑮解析前去掉开头一个 BOM，写回不带 BOM。
 * 修复批 2（codex 09-R）：⑯ROLLBACK 与 close 都失败 → 保留连接引用并把该控制根标记为「锁状态不确定」，之后本进程对它的任何调用立即报 STATE_LOCK_UNCERTAIN；
 *   ⑰stateWritten 由 atomicWrite 在 rename 成功后显式记录（读与无变化路径不再标 true）；⑱createLine 的 init 在首次校验后、等锁之前立即快照；
 *   ⑲util.types.isPromise 识别真实 Promise（含其他执行上下文），经 Promise.prototype.then.call 挂拒绝处理；⑳建目录 / 生成缓冲区 / openSync 失败也统一报 STATE_WRITE_FAILED。
 * 修复批 2 追加（2b 裁定）：收尾失败口径按「事务是否已结束」统一——COMMIT 或 ROLLBACK 成功即事务已结束、close 成功即锁已释放，收尾失败只发进程警告（写明失败步骤与是否真写入）并按成功返回；
 *   只有「事务可能未结束且 close 失败」才报 STATE_LOCK_UNCERTAIN（stateWritten 反映是否真写入）并标记该控制根（修复批 3 起按控制根隔离，见下），本进程后续调用立即同码失败。
 * 修复批 3（codex 09-R2，收口批）：
 *   ㉑「锁状态不确定」按**规范化控制根**隔离（键 = 控制根路径，Windows 下小写）：状态锁或任何一条线级锁收尾失败且事务可能未结束，整个控制根都标记；
 *     之后本进程对该控制根的所有公开入口——readState（含「锁文件不存在」的快捷分支）、updateLine / updateConfig / createLine / removeLineRecord、withLineLock——一进入就查，命中立即 STATE_LOCK_UNCERTAIN（消息提示重启本进程）。
 *     具体失败的锁文件与连接作诊断保留（entries），连接在进程退出时由系统释放。
 *   ㉒两个锁函数在排队等到前驱之后、打开锁库之前再查一次标记（排在失败调用后面的调用不再去 BEGIN）。
 *   ㉓线级锁的重入判定用「活动令牌」：AsyncLocalStorage 里存 锁键 → 共享持有令牌（含 active 标志），asyncFn 结束即置失效；重入检查只认活动令牌，
 *     嵌套上下文共享祖先令牌（不复制成员关系），所以外层已退出后才运行的延迟回调再取同线锁不会误报重入。
 *   ㉔updateLine / removeLineRecord 在入口同步捕获并校验 opts.expectGeneration，锁内只用快照，不再读原 opts（等锁期间改 opts 取消不了代次保护）。
 *   ㉕线级锁收尾错误与状态锁统一：业务异常路径上 COMMIT / ROLLBACK / close 的失败经 attachCleanupErrors 附到业务异常（附不上——原始值或冻结对象——就发进程警告）；
 *     锁不确定时标记控制根并在异常 / 警告里写明需重启；BEGIN 失败后的 close 错误附到取锁错误上。
 *
 * 线级操作锁 withLineLock(controlRoot, name, asyncFn, opts)（2c，S2b 删线用）：与状态锁同一机制（sqlite3 BEGIN EXCLUSIVE，文件 locks/line-<线名小写>.lock，持有者死亡由系统释放，没有接管逻辑），
 *   区别是可以跨 await 持有整个操作（line new / remove / start / stop，期间可执行外部命令）。等待超过 opts.lockTimeoutMs（默认 15 秒）报 STATE_LINE_BUSY。
 *   **锁顺序：线级锁 → 状态锁**；持有状态锁期间（补丁 / guard / syncFn 里）不得等线级锁，调用即报 STATE_LOCK_ORDER。同一异步调用链内对同一线重入直接报 STATE_LINE_REENTRANT（不支持重入，
 *   用 AsyncLocalStorage 区分「重入」与「别的调用链在排队」）；同进程里别的调用链对同一线的调用 FIFO 排队。线名不分大小写。不同线的线级锁互不阻塞。
 *   **重入检测的覆盖边界**：只覆盖持锁调用链的延续；经锁外创建的事件源（锁外建的 EventEmitter / 定时器 / 连接）在持锁期间再次进入同一线，不属于持锁调用链，会排队到超时报 STATE_LINE_BUSY。
 *   **嵌套持有不同线的线级锁时，必须按线名小写排序依次取**；否则两条反序的调用链会互相等待直到 STATE_LINE_BUSY（本模块不做死锁检测）。
 *   参数 / 锁顺序 / 重入三项检查同步抛出（withLineLock 本身不是 async 函数，通过检查后才进入异步取锁）：在补丁函数里误调用时补丁本身抛错 → ROLLBACK、不写盘、不留未处理拒绝。
 *
 * 记录代次 generation（2c）：createLine 生成 crypto.randomUUID() 写进记录，之后不可改（IMMUTABLE_LINE_FIELDS），移入 history 时保留，整个登记表内唯一；同名重建得到新代次。
 *   updateLine / removeLineRecord 接受 opts.expectGeneration，与当前记录代次不符报 STATE_GENERATION_MISMATCH（登记表不变）——用来防止旧操作按过期信息改到「同名重建后的新线」。
 *
 * 线记录的 process 字段 = null 或 { pid, start_time, cmd, instance }；结构校验只核这四个必需子键，**允许附加子键**（如 S2c 的 state: 'starting' / 'running'），不拒绝也不改写。
 *
 * 结构版本规则：登记表的字段集（线记录字段、config 字段、顶层字段）一旦变化，STATE_VERSION 必须同步升级（旧代码读到更高版本报 STATE_VERSION_NEWER，不会改写）。
 *   本批新增 generation 字段时还没有任何真实登记表，所以保持 STATE_VERSION = 1；此后任何字段集变化都必须升版本并写迁移。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { types } = require('util');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const sqlite3 = require(path.join(__dirname, '..', '..', 'wbs-server', 'node_modules', 'sqlite3'));

const STATE_VERSION = 1;
const CONTROL_SUBPATH = ['docs', 'local', '多线并行', '_state'];
const SLOT_PORTS = Object.freeze({ 1: 3100, 2: 3200, 3: 3300 });   // 生产缺省的槽位 ↔ 端口表（仍对外导出，不变）
/**
 * 当前生效的槽位 ↔ 端口表：缺省就是 SLOT_PORTS；只能经 _internal.setSlotPortsForTest 在本进程内存里替换（给自检用，让测试不占真实线用的 3100 / 3200 / 3300）。
 * 登记表校验（validateState）与新线分配（createLine）都读它；它不写进 lines.json（登记表里只有每条线自己的 slot / port）。
 */
let currentSlotPorts = SLOT_PORTS;
/** 测试端口表不得取的端口：3000（主服务）与真实线的三个槽位端口（派生自 SLOT_PORTS，不另写一份）。保证测试永远不与真实线、主服务撞端口。 */
const RESERVED_TEST_PORTS = Object.freeze([3000, ...Object.values(SLOT_PORTS)]);
/**
 * 测试专用：把当前端口表换成 table = [槽位 1 的端口, 槽位 2 的端口, 槽位 3 的端口]；传 null / undefined 还原为生产缺省。
 * 不合规一律抛 StateError(STATE_BAD_ARGS)，且不改当前表：不是恰好三个元素的数组（少槽 / 多槽）、含非整数或不在 1024–65535 的值、含 3000 或 3100 / 3200 / 3300 之一、三个端口有重复。
 */
function setSlotPortsForTest(table) {
    if (table === null || table === undefined) { currentSlotPorts = SLOT_PORTS; return; }
    if (!Array.isArray(table) || table.length !== 3) throw new StateError('STATE_BAD_ARGS', '测试端口表必须是恰好 3 个端口的数组（槽位 1、2、3）');
    for (const p of table) {
        if (!(Number.isInteger(p) && p >= 1024 && p <= 65535)) throw new StateError('STATE_BAD_ARGS', '测试端口表里的端口必须是 1024–65535 的整数');
    }
    for (const p of table) {
        if (RESERVED_TEST_PORTS.includes(p)) throw new StateError('STATE_BAD_ARGS', `测试端口表不得含 ${RESERVED_TEST_PORTS.join(' / ')}（主服务与真实线的槽位端口）`);
    }
    if (new Set(table).size !== 3) throw new StateError('STATE_BAD_ARGS', '测试端口表里的三个端口必须互不相同');
    currentSlotPorts = Object.freeze({ 1: table[0], 2: table[1], 3: table[2] });
}
const LIFECYCLES = Object.freeze(['creating', 'ready', 'removing', 'removed', 'failed']);
// 允许的 lifecycle 转换（同态不变不算转换）
const LIFECYCLE_TRANSITIONS = Object.freeze({
    creating: Object.freeze(['ready', 'failed']),
    ready: Object.freeze(['removing']),
    failed: Object.freeze(['removing', 'creating']),
    removing: Object.freeze(['removed', 'failed']),
    removed: Object.freeze([]),
});
const INTEGRATION_STATES = Object.freeze(['idle', 'verifying', 'verified', 'conflict', 'merging', 'merged']);
const DEPS_MODES = Object.freeze(['shared', 'independent']);
const MODES = Object.freeze(['normal', 'drill']);
const DEFAULT_LOCK_TIMEOUT_MS = 15000;
// Windows 上 renameSync 替换目标遇到杀毒 / 索引器瞬时占用会报 EPERM / EACCES / EBUSY：最多 12 次，间隔 20ms * 次数（上限 200ms），合计约 1.5 秒；
//   再失败说明不是瞬时占用，删临时文件并报错，登记表保持旧内容。
const REPLACE_RETRY_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_MAX_ATTEMPTS = 12;

class StateError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'StateError';
        this.code = code;
        if (extra && extra.cause) this.cause = extra.cause;
    }
}

const deepCopy = (v) => JSON.parse(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

/**
 * JSON 往返之前的输入校验：登记表只存 JSON 能原样往返的纯数据。往返会静默改写的值一律在往返之前拒绝——
 * undefined（对象里的键被丢掉、数组里变 null）、NaN / Infinity / -0（变 null / 0）、函数、Symbol、BigInt、带 toJSON 的对象（换成别的值）、
 * 非纯对象（Date / Map / 类实例，原型不是 Object.prototype 或 null）、数组空位与数组上的多余属性、存取器与不可枚举属性（getter 被求值 / 属性被丢）、Symbol 键、循环引用。
 * 口径与字段类型表一致：字段类型表里的值（字符串、数字、布尔、null、纯对象、纯数组）全部通过。返回第一个问题的描述，合法返回 null。
 */
function findUnserializable(v, at, stack) {
    if (v === null) return null;
    switch (typeof v) {
        case 'string': case 'boolean': return null;
        case 'number':
            if (!Number.isFinite(v)) return `${at} 是非有限数字（${String(v)}），JSON 往返会变成 null`;
            if (Object.is(v, -0)) return `${at} 是 -0，JSON 往返会变成 0`;
            return null;
        case 'undefined': return `${at} 是 undefined，JSON 往返会静默丢掉`;
        case 'function': return `${at} 是函数`;
        case 'symbol': return `${at} 是 Symbol`;
        case 'bigint': return `${at} 是 BigInt`;
        default: break;
    }
    if (stack.includes(v)) return `${at} 含循环引用`;
    const proto = Object.getPrototypeOf(v);
    const isArr = Array.isArray(v);
    if (isArr ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) return `${at} 不是纯${isArr ? '数组' : '对象'}（原型不是 ${isArr ? 'Array' : 'Object'}.prototype${isArr ? '' : ' 或 null'}）`;
    if (!isArr && 'toJSON' in v) return `${at} 带 toJSON，JSON 往返会换成别的值`;
    const keys = Reflect.ownKeys(v);
    if (keys.some((k) => typeof k === 'symbol')) return `${at} 带 Symbol 键，JSON 往返会丢掉`;
    const names = keys.filter((k) => !(isArr && k === 'length'));
    if (isArr) {
        if (names.length !== v.length || !names.every((k, i) => k === String(i))) return `${at} 是有空位或带多余属性的数组`;
    }
    stack.push(v);
    try {
        for (const k of names) {
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!('value' in d)) return `${at}.${k} 是存取器属性，JSON 往返会求值`;
            if (!d.enumerable) return `${at}.${k} 是不可枚举属性，JSON 往返会丢掉`;
            const p = findUnserializable(d.value, `${at}.${k}`, stack);
            if (p) return p;
        }
    } finally { stack.pop(); }
    return null;
}
/** 不合法即抛 code 指定的 StateError（补丁结果用 STATE_INVALID_PATCH，初始化数据用 STATE_BAD_ARGS）。必须在 JSON 往返 / deepCopy 之前调用。 */
function assertSerializable(v, at, code) {
    const problem = findUnserializable(v, at, []);
    if (problem) throw new StateError(code, `${problem}；本次写入已放弃`);
}

// ---------------------------------------------------------------- 线名与槽位

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/;
const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 线名唯一性不分大小写（Windows 文件系统不分大小写）。 */
function nameKey(name) { return name.toLowerCase(); }
/** 合法返回 null，否则返回原因。 */
function checkLineName(name) {
    if (typeof name !== 'string') return '线名必须是字符串';
    if (name.length < 1 || name.length > 32) return '线名长度必须是 1–32';
    if (!NAME_RE.test(name)) return '线名只允许 ASCII 字母、数字、连字符，且首尾必须是字母或数字';
    if (name.toLowerCase() === 'main') return '线名不得为 main';
    if (name.toLowerCase().startsWith('test-')) return '线名不得以 test- 开头（派生测试实例保留）';
    if (RESERVED_DEVICE_RE.test(name)) return '线名不得是 Windows 保留设备名';
    return null;
}
/** lifecycle 不是 removed 的线都占槽（含 failed）。 */
function occupiesSlot(rec) { return rec.lifecycle !== 'removed'; }
function checkLifecycleTransition(from, to) {
    if (!LIFECYCLES.includes(from) || !LIFECYCLES.includes(to)) return false;
    if (from === to) return true;
    return LIFECYCLE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------- 结构校验

const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINE_FIELDS = Object.freeze(['name', 'generation', 'lifecycle', 'failed_step', 'integration', 'yield_request', 'module', 'branch', 'worktree', 'slot', 'port', 'surface', 'deps_mode', 'process', 'created_at', 'updated_at']);
const HISTORY_EXTRA_FIELDS = Object.freeze(['removed_at']);
const CONFIG_FIELDS = Object.freeze(['integration_branch', 'integration_workspace', 'mode']);

const strOrNull = (v) => v === null || isNonEmptyString(v);
const isTimeString = (v) => isNonEmptyString(v) && !Number.isNaN(Date.parse(v));

function validateRecord(name, rec, inHistory, problems) {
    const at = `lines.${name}`;
    if (!isPlainObject(rec)) { problems.push(`${at} 不是对象`); return; }
    const allowed = new Set(inHistory ? LINE_FIELDS.concat(HISTORY_EXTRA_FIELDS) : LINE_FIELDS);
    for (const k of Object.keys(rec)) if (!allowed.has(k)) problems.push(`${at} 含未知字段 ${k}`);
    for (const k of LINE_FIELDS) if (!(k in rec)) problems.push(`${at} 缺少字段 ${k}`);
    if (rec.name !== name) problems.push(`${at}.name 与键名不一致`);
    if (!(typeof rec.generation === 'string' && GENERATION_RE.test(rec.generation))) problems.push(`${at}.generation 必须是 UUID 字符串`);
    const nameProblem = checkLineName(rec.name);
    if (!inHistory && nameProblem) problems.push(`${at}.name 非法：${nameProblem}`);
    if (!LIFECYCLES.includes(rec.lifecycle)) problems.push(`${at}.lifecycle 取值非法`);
    else if (inHistory && rec.lifecycle !== 'removed') problems.push(`${at}.lifecycle 在 history 里必须是 removed`);
    else if (!inHistory && rec.lifecycle === 'removed') problems.push(`${at}.lifecycle 为 removed 的记录必须移入 history`);
    if (rec.lifecycle === 'failed') { if (!isNonEmptyString(rec.failed_step)) problems.push(`${at}.failed_step 在 failed 时必须是非空字符串`); }
    else if (rec.failed_step !== null) problems.push(`${at}.failed_step 非 failed 时必须是 null`);
    if (inHistory && !isTimeString(rec.removed_at)) problems.push(`${at}.removed_at 必须是时间字符串`);
    // integration：只校验取值合法（转换规则归 S7）；verified 附 B、H，conflict 附原因
    const ig = rec.integration;
    if (!isPlainObject(ig) || !INTEGRATION_STATES.includes(ig.state)) problems.push(`${at}.integration.state 取值非法`);
    else {
        if (ig.state === 'verified' && !(isNonEmptyString(ig.B) && isNonEmptyString(ig.H))) problems.push(`${at}.integration 为 verified 时必须带非空的 B、H`);
        if (ig.state === 'conflict' && !isNonEmptyString(ig.reason)) problems.push(`${at}.integration 为 conflict 时必须带非空的 reason`);
    }
    if (rec.yield_request !== null && !isPlainObject(rec.yield_request)) problems.push(`${at}.yield_request 必须是 null 或对象`);
    for (const k of ['module', 'branch', 'worktree']) if (!strOrNull(rec[k])) problems.push(`${at}.${k} 必须是 null 或非空字符串`);
    if (!(rec.surface === null || isNonEmptyString(rec.surface) || (Array.isArray(rec.surface) && rec.surface.every(isNonEmptyString)))) problems.push(`${at}.surface 必须是 null、非空字符串或非空字符串数组`);
    if (!DEPS_MODES.includes(rec.deps_mode)) problems.push(`${at}.deps_mode 取值非法`);
    if (!(Number.isInteger(rec.slot) && Object.prototype.hasOwnProperty.call(currentSlotPorts, rec.slot))) problems.push(`${at}.slot 必须是 1、2、3`);
    else if (rec.port !== currentSlotPorts[rec.slot]) problems.push(`${at}.port 与槽位不对应（槽位 ${rec.slot} 应为 ${currentSlotPorts[rec.slot]}）`);
    const p = rec.process;
    if (p !== null && (rec.lifecycle === 'removing' || rec.lifecycle === 'removed')) problems.push(`${at}.process 在 lifecycle 为 ${rec.lifecycle} 时必须是 null`);
    if (p !== null) {
        if (!isPlainObject(p)) problems.push(`${at}.process 必须是 null 或对象`);
        else {
            if (!(Number.isSafeInteger(p.pid) && p.pid > 0)) problems.push(`${at}.process.pid 必须是正整数`);
            if (!(isNonEmptyString(p.start_time) || (typeof p.start_time === 'number' && Number.isFinite(p.start_time)))) problems.push(`${at}.process.start_time 必须是非空字符串或数字`);
            if (!isNonEmptyString(p.cmd)) problems.push(`${at}.process.cmd 必须是非空字符串`);
            if (!isNonEmptyString(p.instance)) problems.push(`${at}.process.instance 必须是非空字符串`);
        }
    }
    if (!isTimeString(rec.created_at)) problems.push(`${at}.created_at 必须是时间字符串`);
    if (!isTimeString(rec.updated_at)) problems.push(`${at}.updated_at 必须是时间字符串`);
}

/** 整体结构校验，返回问题数组（空数组 = 合法）。 */
function validateState(state) {
    const problems = [];
    if (!isPlainObject(state)) return ['登记表不是对象'];
    for (const k of Object.keys(state)) if (!['version', 'config', 'lines', 'history'].includes(k)) problems.push(`含未知顶层字段 ${k}`);
    if (state.version !== STATE_VERSION) problems.push(`version 必须是 ${STATE_VERSION}`);
    const c = state.config;
    if (!isPlainObject(c)) problems.push('config 不是对象');
    else {
        for (const k of Object.keys(c)) if (!CONFIG_FIELDS.includes(k)) problems.push(`config 含未知字段 ${k}`);
        if (!strOrNull(c.integration_branch)) problems.push('config.integration_branch 必须是 null 或非空字符串');
        if (!strOrNull(c.integration_workspace)) problems.push('config.integration_workspace 必须是 null 或非空字符串');
        if (!MODES.includes(c.mode)) problems.push('config.mode 取值非法');
    }
    if (!isPlainObject(state.lines)) problems.push('lines 不是对象');
    else {
        const seenKeys = new Map();
        const seenSlots = new Map();
        for (const name of Object.keys(state.lines)) {
            const rec = state.lines[name];
            validateRecord(name, rec, false, problems);
            const k = nameKey(name);
            if (seenKeys.has(k)) problems.push(`线名 ${name} 与 ${seenKeys.get(k)} 重名（不分大小写）`);
            else seenKeys.set(k, name);
            if (isPlainObject(rec) && occupiesSlot(rec)) {
                if (seenSlots.has(rec.slot)) problems.push(`槽位 ${rec.slot} 被 ${seenSlots.get(rec.slot)} 与 ${name} 同时占用`);
                else seenSlots.set(rec.slot, name);
            }
        }
    }
    if (!Array.isArray(state.history)) problems.push('history 不是数组');
    else state.history.forEach((rec, i) => { if (isPlainObject(rec) && isNonEmptyString(rec.name)) validateRecord(rec.name, rec, true, problems); else problems.push(`history[${i}] 不是带 name 的对象`); });
    // 代次在整个登记表（lines + history）内唯一：同名重建必须得到新代次，两条记录不得共用同一代次
    if (isPlainObject(state.lines) && Array.isArray(state.history)) {
        const seenGen = new Map();
        const all = Object.keys(state.lines).map((n) => [`lines.${n}`, state.lines[n]]).concat(state.history.map((r, i) => [`history[${i}]`, r]));
        for (const [at, rec] of all) {
            if (!isPlainObject(rec) || typeof rec.generation !== 'string') continue;
            if (seenGen.has(rec.generation)) problems.push(`${at}.generation 与 ${seenGen.get(rec.generation)} 重复`);
            else seenGen.set(rec.generation, at);
        }
    }
    return problems;
}

function emptyState() {
    return { version: STATE_VERSION, config: { integration_branch: null, integration_workspace: null, mode: 'normal' }, lines: {}, history: [] };
}

// ---------------------------------------------------------------- 控制根

/**
 * 控制根。传了 controlRoot 直接用（测试与演练）；否则在 cwd 执行 `git rev-parse --git-common-dir`（execFileSync，不经 shell），
 * 主仓库 .git 的父目录 = 主工作区根，控制根 = <主工作区根>/docs/local/多线并行/_state。测试注入经 _internal.setTestHooks({ execFileSync })。
 * 调 git 时从 env 去掉 GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_INDEX_FILE：调用方环境里残留这些变量（例如在 git hook 里被调用）会让 git 无视 cwd，解析到别的仓库。
 */
const GIT_ENV_STRIP = Object.freeze(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);
function resolveControlRoot({ cwd, controlRoot } = {}) {
    if (controlRoot !== undefined && controlRoot !== null) {
        if (!isNonEmptyString(controlRoot)) throw new StateError('STATE_BAD_ARGS', 'resolveControlRoot：controlRoot 必须是非空字符串');
        return path.resolve(controlRoot);
    }
    if (!isNonEmptyString(cwd)) throw new StateError('STATE_BAD_ARGS', 'resolveControlRoot：未传 controlRoot 时必须传 cwd');
    const exec = hooks.execFileSync || execFileSync;
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (GIT_ENV_STRIP.includes(k.toUpperCase())) delete env[k];   // Windows 环境变量名不分大小写
    let out;
    try {
        out = exec('git', ['rev-parse', '--git-common-dir'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
        throw new StateError('STATE_NO_GIT', `resolveControlRoot：在 ${cwd} 执行 git rev-parse --git-common-dir 失败：${e && e.message}`, { cause: e });
    }
    const commonDir = path.resolve(cwd, String(out).trim());
    if (path.basename(commonDir).toLowerCase() !== '.git') {
        throw new StateError('STATE_NO_GIT', `resolveControlRoot：git 公共目录 ${commonDir} 不是名为 .git 的主仓库目录（裸库 / 子模块不支持）`);
    }
    let mainRoot = path.dirname(commonDir);
    try { mainRoot = fs.realpathSync.native(mainRoot); } catch (_) { /* 路径不存在时按原样 */ }
    return path.join(mainRoot, ...CONTROL_SUBPATH);
}

function pathsOf(controlRoot) {
    if (!isNonEmptyString(controlRoot)) throw new StateError('STATE_BAD_ARGS', 'controlRoot 必须是非空字符串');
    const root = path.resolve(controlRoot);
    return { root, linesFile: path.join(root, 'lines.json'), locksDir: path.join(root, 'locks'), lockFile: path.join(root, 'locks', 'state.lock') };
}

// ---------------------------------------------------------------- 状态锁

// 测试钩子（只经 _internal.setTestHooks 设置，不进公开 API 的 opts）：默认全为 null，正常路径只在「钩子非 null」时多走一层转发，行为不变。
//   writeSync(fd, buf, off, len, pos)：替换 atomicWrite 里的 fs.writeSync（注入短写 / 零进展 / 报错）
//   renameSync(from, to)：替换 atomicWrite 里的 fs.renameSync（注入 EPERM / 在 rename 前挂住）
//   execFileSync：替换 resolveControlRoot 里的 child_process.execFileSync
//   dbRun(db, sql, real)：替换对锁库执行的 BEGIN / COMMIT / ROLLBACK（记录 SQL 序列、注入失败、延迟）
//   dbClose(db, real)：替换连接关闭（注入关闭失败）
//   beforeBegin(remainingMs)：取锁（BEGIN EXCLUSIVE）发出前调用一次，参数是剩余预算，即传给 sqlite busyTimeout 的值
//   openSync(path, flags)：替换 atomicWrite 里创建临时文件的 fs.openSync（注入磁盘满等）
const TEST_HOOK_NAMES = Object.freeze(['writeSync', 'renameSync', 'openSync', 'execFileSync', 'dbRun', 'dbClose', 'beforeBegin']);
const hooks = { writeSync: null, renameSync: null, openSync: null, execFileSync: null, dbRun: null, dbClose: null, beforeBegin: null };
/** 整体替换钩子集合：没列出的钩子复位为 null；传 null / {} 即全部复位。未知钩子名报错（防拼写错误让注入静默失效）。 */
function setTestHooks(next) {
    const given = next || {};
    for (const k of Object.keys(given)) if (!TEST_HOOK_NAMES.includes(k)) throw new StateError('STATE_BAD_ARGS', `setTestHooks：未知钩子 ${k}`);
    for (const k of TEST_HOOK_NAMES) hooks[k] = typeof given[k] === 'function' ? given[k] : null;
}

function openLockDb(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => (err ? reject(err) : resolve(db)));
    });
}
const dbRunReal = (db, sql) => new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
const dbRun = (db, sql) => (hooks.dbRun ? hooks.dbRun(db, sql, dbRunReal) : dbRunReal(db, sql));
/** 关闭失败要传播（以前吞掉）：调用方决定是并入业务异常还是单独报错。 */
const dbCloseReal = (db) => new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
const dbClose = (db) => (hooks.dbClose ? hooks.dbClose(db, dbCloseReal) : dbCloseReal(db));
const isBusyError = (e) => !!e && (/SQLITE_BUSY/.test(String(e.code || '')) || /SQLITE_BUSY|database is locked/i.test(String(e.message || '')));

/** 执行一步清理 / 事务动作；成功返回 null，失败返回 { error }（包一层，因为失败值本身可能是 null / undefined 这类假值）。 */
async function attempt(fn) {
    try { await fn(); return null; } catch (error) { return { error }; }
}
const describeErr = (e) => (e && e.message) || String(e);
/**
 * 把清理失败信息挂到业务异常上（不吞）；uncertain 时同时挂 lockUncertain 标记。业务异常是原始值（null / 0 / '' 等）或冻结对象挂不上时，改发进程警告（锁不确定时警告里写明需重启）。
 * what = '状态锁' / '线级锁'，只用于警告文字。
 */
function attachCleanupErrors(failure, cleanupErrors, uncertain, what) {
    if (cleanupErrors.length === 0) return;
    if ((typeof failure === 'object' && failure !== null) || typeof failure === 'function') {
        try {
            Object.defineProperty(failure, 'cleanupErrors', { value: cleanupErrors, configurable: true, writable: true, enumerable: false });
            if (uncertain) Object.defineProperty(failure, 'lockUncertain', { value: true, configurable: true, writable: true, enumerable: false });
            return;
        } catch (_) { /* 落到下面的警告 */ }
    }
    const restart = uncertain ? '；该控制根的锁状态不确定（事务可能未结束），本进程后续调用将立即失败，需重启本进程' : '';
    process.emitWarning(`${what || '状态锁'}清理失败（业务异常无法携带附加信息）：${cleanupErrors.map(describeErr).join('；')}${restart}`, 'StateLockCleanupWarning');
}

// 进程内 FIFO 队列：同一进程里的多个调用依次取锁（跨进程互斥仍由 SQLite 文件锁负责）
const inProcessQueues = new Map();
// 「锁状态不确定」的控制根（修复批 3：按规范化控制根隔离，不再按单个锁文件）：状态锁或任一线级锁在「事务可能未结束且 close 失败」时，连接可能仍持有事务锁。
//   整个控制根标记为不确定，之后本进程对它的任何公开入口立即报 STATE_LOCK_UNCERTAIN（要重启进程）。键 = 规范化控制根路径（win32 下小写）；
//   值 = { entries: [{ lockFile, db, since, errors }] }：具体失败的锁与连接作诊断保留（也不让连接被回收），连接在进程退出时由系统释放。
const uncertainRoots = new Map();
const rootKeyOf = (root) => (process.platform === 'win32' ? root.toLowerCase() : root);   // root 已经 path.resolve 过（pathsOf）
function markRootUncertain(paths, entry) {
    const k = rootKeyOf(paths.root);
    const u = uncertainRoots.get(k) || { entries: [] };
    u.entries.push(entry);
    uncertainRoots.set(k, u);
}
/** 公开入口一进入、以及排队等到前驱之后：该控制根被标记为不确定就立即 STATE_LOCK_UNCERTAIN。what 只用于消息。 */
function assertRootCertain(paths, what) {
    const u = uncertainRoots.get(rootKeyOf(paths.root));
    if (!u) return;
    const locks = u.entries.map((e) => path.basename(e.lockFile)).join('、');
    throw new StateError('STATE_LOCK_UNCERTAIN', `本进程内控制根 ${paths.root} 的锁状态不确定（此前 ${locks} 收尾失败：事务可能未结束且关闭连接失败，连接可能仍持有事务锁）：${what}不再尝试取锁，请重启本进程`);
}
// 线级锁：当前异步调用链已持有的线级锁（AsyncLocalStorage：区分「重入」与「别的调用链在排队」）。存 Map<锁键, 持有令牌>，令牌 { active } 在 asyncFn 结束时置失效，
//   重入检查只认活动令牌；嵌套上下文沿用祖先的令牌对象（共享，不复制成员关系）。状态锁持有计数（>0 表示正处在持状态锁的同步段里）
const lineLockStore = new AsyncLocalStorage();
let inStateLockSync = 0;

/** 真实 Promise（含其他执行上下文，如 vm 里创建的）：挂空拒绝处理，吃掉它将来的拒绝。普通 thenable 不碰它的 then。 */
function swallowRejection(p) {
    if (types.isPromise(p)) Promise.prototype.then.call(p, undefined, () => {});
}

/**
 * 取锁 → 同步执行 syncFn → 释放锁。syncFn 必须是同步函数，返回 thenable 抛 STATE_PATCH_ASYNC。
 * 持有者进程死亡由操作系统释放文件锁；这里没有任何过期 / 接管逻辑。
 * 预算：lockTimeoutMs 从调用开始算，进程内 FIFO 排队等待与 sqlite 等待共用一份预算；排队超时同样报 STATE_LOCK_TIMEOUT。
 */
async function withStateLock(paths, opts, syncFn) {
    const timeoutMs = opts && Number.isFinite(opts.lockTimeoutMs) && opts.lockTimeoutMs >= 0 ? opts.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const queueKey = process.platform === 'win32' ? paths.lockFile.toLowerCase() : paths.lockFile;
    assertRootCertain(paths, '状态锁');   // 一进入就查（按控制根隔离）
    const prev = inProcessQueues.get(queueKey) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    inProcessQueues.set(queueKey, tail);
    tail.then(() => { if (inProcessQueues.get(queueKey) === tail) inProcessQueues.delete(queueKey); });
    // 保序来自 tail = prev.then(() => mine)：后继等的是 tail，tail 要等 prev 完成之后才会 resolve；所以任何调用（含排队超时的）在 finally 里立即 release() 都不会让后继越过前驱。
    try {
        let timer;
        const got = await Promise.race([
            prev.then(() => true),
            new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
        ]);
        clearTimeout(timer);
        if (!got) {
            throw new StateError('STATE_LOCK_TIMEOUT', `进程内排队至少等待了 ${timeoutMs}ms 仍未轮到（排队时间计入预算；前面的持有者仍活着时不会被接管）：${paths.lockFile}`);
        }
        assertRootCertain(paths, '状态锁');   // 出队后复查：排队期间前驱可能刚把控制根标记为不确定，轮到我时不再去打开锁库 / BEGIN
        fs.mkdirSync(paths.locksDir, { recursive: true });
        let db;
        try {
            db = await openLockDb(paths.lockFile);
        } catch (e) {
            throw new StateError('STATE_LOCK_FAILED', `无法打开状态锁文件 ${paths.lockFile}：${describeErr(e)}`, { cause: e });
        }
        const remainingMs = Math.max(0, deadline - Date.now());
        try {
            db.configure('busyTimeout', remainingMs);
            if (hooks.beforeBegin) hooks.beforeBegin(remainingMs);
            await dbRun(db, 'BEGIN EXCLUSIVE');
        } catch (e) {
            const closed = await attempt(() => dbClose(db));
            const err = isBusyError(e)
                ? new StateError('STATE_LOCK_TIMEOUT', `至少等待了约 ${remainingMs}ms 仍未取到状态锁（总预算 ${timeoutMs}ms，含排队；持有者仍活着时不会被接管）：${paths.lockFile}`, { cause: e })
                : new StateError('STATE_LOCK_FAILED', `取状态锁失败：${describeErr(e)}`, { cause: e });
            attachCleanupErrors(err, closed ? [closed.error] : [], false, '状态锁');
            throw err;
        }
        let txOpen = true;            // BEGIN 之后事务一直开着，直到 COMMIT 或 ROLLBACK 成功
        let hasFailure = false;       // 独立布尔：补丁可能抛 null / undefined / 0 / false / ''，不能拿异常值本身判断成败
        let failure;
        let result;
        const track = { written: false };   // 由 atomicWrite 在 rename 成功后置 true：stateWritten 只反映真实写入，不能由「syncFn 成功」推断（读和无变化路径也成功）
        inStateLockSync++;   // 持锁期间：线级锁 withLineLock 在此期间被调用即报 STATE_LOCK_ORDER（锁顺序 线级锁 → 状态锁）
        try {
            result = syncFn(track);
            if (result && typeof result.then === 'function') {
                hasFailure = true;
                failure = new StateError('STATE_PATCH_ASYNC', '持锁期间只允许同步操作：补丁函数返回了 Promise / thenable，本次写入已放弃');
            }
        } catch (e) {
            hasFailure = true;
            failure = e;
        } finally {
            inStateLockSync--;
        }
        const cleanupErrors = [];   // 失败的收尾步骤的底层错误（ROLLBACK / close），失败路径挂到业务异常上
        const failedSteps = [];     // 失败的收尾步骤的文字（含成功路径上的 COMMIT），写进警告
        let commitFailed = false;
        if (!hasFailure) {
            const committed = await attempt(() => dbRun(db, 'COMMIT'));
            if (committed) { commitFailed = true; failedSteps.push(`COMMIT 失败：${describeErr(committed.error)}`); } else txOpen = false;
        }
        if (txOpen) {
            const rolled = await attempt(() => dbRun(db, 'ROLLBACK'));
            if (rolled) { cleanupErrors.push(rolled.error); failedSteps.push(`ROLLBACK 失败：${describeErr(rolled.error)}`); } else txOpen = false;
        }
        const closed = await attempt(() => dbClose(db));
        if (closed) { cleanupErrors.push(closed.error); failedSteps.push(`关闭连接失败：${describeErr(closed.error)}`); }
        // 口径（事务是否已结束）：close 成功即连接没了、锁已释放；COMMIT 或 ROLLBACK 成功即事务已结束（连接句柄留着也不持锁，进程退出时由系统释放）。
        //   只有「事务可能未结束（没有 COMMIT / ROLLBACK 成功）且 close 失败」时，连接可能仍持有事务锁：保留连接引用、把这个控制根标记为不确定，后续调用立即报 STATE_LOCK_UNCERTAIN。
        const uncertain = txOpen && !!closed;
        if (uncertain) markRootUncertain(paths, { lockFile: paths.lockFile, db, since: Date.now(), errors: cleanupErrors.slice() });
        if (hasFailure) {
            attachCleanupErrors(failure, cleanupErrors, uncertain, '状态锁');   // 附不上（原始值 / 冻结对象）就发警告，锁不确定时警告写明需重启
            throw failure;
        }
        const wroteText = track.written ? '登记表已写入' : '本次没有写登记表';
        if (uncertain) {
            // 业务本身成功，但锁状态不确定：必须报错让调用方知道（stateWritten 只在登记表真被 rename 替换过时为 true）
            const err = new StateError('STATE_LOCK_UNCERTAIN', `${wroteText}，但状态锁收尾失败且事务可能未结束，该控制根的锁状态不确定（本进程内后续调用将立即失败，请重启进程）：${failedSteps.join('；')}`, { cause: cleanupErrors[0] });
            err.stateWritten = track.written;
            err.lockUncertain = true;
            attachCleanupErrors(err, cleanupErrors, true, '状态锁');
            throw err;
        }
        if (failedSteps.length) {
            // 事务已结束 / 锁已释放：收尾失败只记警告，按成功返回（警告写实际失败的步骤与是否真写入）
            process.emitWarning(`状态锁收尾步骤失败（${wroteText}，锁已释放，按成功返回）：${failedSteps.join('；')}`, commitFailed ? 'StateLockCommitWarning' : 'StateLockCleanupWarning');
        }
        return result;
    } finally {
        release();
    }
}

/**
 * 线级操作锁（2c）：取 locks/line-<线名小写>.lock 的 BEGIN EXCLUSIVE → await asyncFn() → 释放。可跨 await 持有整个操作，期间可执行外部命令，也可调用本模块的状态读写入口
 * （锁顺序：线级锁 → 状态锁）。持有者进程死亡由系统释放，没有超时接管；等待超过 opts.lockTimeoutMs（含进程内排队）报 STATE_LINE_BUSY。
 * 同一调用链内对同一线重入报 STATE_LINE_REENTRANT（大小写不同的同一线也算；只认「活动令牌」：外层 asyncFn 已结束后才运行的延迟回调不算重入）；
 * 在持有状态锁的同步段里调用报 STATE_LOCK_ORDER；线名不合法报 STATE_BAD_NAME；参数 / 锁顺序 / 重入这三项检查**同步抛出**（见下方包装）；
 * 控制根被标记为锁状态不确定报 STATE_LOCK_UNCERTAIN（进入即查，排队出队后再查，返回被拒绝的 Promise）。返回 asyncFn 的返回值。
 * 覆盖边界：重入检测只覆盖持锁调用链的延续（AsyncLocalStorage 随 await / 回调传播）；经锁外创建的事件源（锁外建的 EventEmitter / 定时器 / 连接）在持锁期间再次进入同一线，
 *   不属于持锁调用链，会排队到超时报 STATE_LINE_BUSY（等于自己等自己）——不要这样写。
 * 嵌套持有不同线的线级锁时必须按线名小写排序依次取，否则两条反序的调用链会互相等待直到 STATE_LINE_BUSY（本模块不做死锁检测）。
 * 调用方约束：因为上述三项检查同步抛出，必须在 async 函数内调用（`return S.withLineLock(...)` / `await S.withLineLock(...)`）或用 try 包裹；
 *   在非 async 回调里写 `S.withLineLock(...).catch(h)` 接不住这三类错误，会变成未捕获异常。
 */
function withLineLock(controlRoot, name, asyncFn, opts) {
    // 同步包装：参数 / 锁顺序 / 重入三项「调用方用错」的检查同步抛出（不是返回被拒绝的 Promise）——在补丁函数里误调用时，补丁本身抛错 → 状态锁 ROLLBACK、不写盘，
    //   也不会留下一个没人处理的被拒绝 Promise。通过检查后才进入异步取锁。
    const problem = checkLineName(name);
    if (problem) throw new StateError('STATE_BAD_NAME', `线名 ${JSON.stringify(name)} 非法：${problem}`);
    if (typeof asyncFn !== 'function') throw new StateError('STATE_BAD_ARGS', 'withLineLock：asyncFn 必须是函数');
    const paths = pathsOf(controlRoot);
    const lockFile = path.join(paths.locksDir, `line-${name.toLowerCase()}.lock`);
    const key = process.platform === 'win32' ? lockFile.toLowerCase() : lockFile;
    if (inStateLockSync > 0) throw new StateError('STATE_LOCK_ORDER', `持有状态锁期间不得等线级锁（锁顺序：线级锁 → 状态锁）：${name}`);
    const held = lineLockStore.getStore();   // Map<锁键, 持有令牌> | undefined
    const heldToken = held && held.get(key);
    if (heldToken && heldToken.active) throw new StateError('STATE_LINE_REENTRANT', `线 ${name} 的线级锁在当前调用链里已被持有，不支持重入`);
    return acquireLineLock(paths, lockFile, key, name, asyncFn, opts, held);
}
async function acquireLineLock(paths, lockFile, key, name, asyncFn, opts, held) {
    assertRootCertain(paths, `线 ${name} 的线级锁`);   // 进入时查、出队后再查（按控制根隔离）；已在跨进程 BEGIN 忙等中的调用不再复查——那种情况下 asyncFn 里第一个状态调用会立即报 STATE_LOCK_UNCERTAIN
    const timeoutMs = opts && Number.isFinite(opts.lockTimeoutMs) && opts.lockTimeoutMs >= 0 ? opts.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const prev = inProcessQueues.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    inProcessQueues.set(key, tail);
    tail.then(() => { if (inProcessQueues.get(key) === tail) inProcessQueues.delete(key); });
    try {
        let timer;
        const got = await Promise.race([
            prev.then(() => true),
            new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
        ]);
        clearTimeout(timer);
        if (!got) throw new StateError('STATE_LINE_BUSY', `线 ${name} 正被本进程内另一个操作占用，排队至少等待了 ${timeoutMs}ms（持有者仍活着时不会被接管）`);
        assertRootCertain(paths, `线 ${name} 的线级锁`);   // 出队后复查（同状态锁）
        fs.mkdirSync(paths.locksDir, { recursive: true });
        let db;
        try {
            db = await openLockDb(lockFile);
        } catch (e) {
            throw new StateError('STATE_LOCK_FAILED', `无法打开线级锁文件 ${lockFile}：${describeErr(e)}`, { cause: e });
        }
        const remainingMs = Math.max(0, deadline - Date.now());
        try {
            db.configure('busyTimeout', remainingMs);
            await dbRun(db, 'BEGIN EXCLUSIVE'); // LINE-BEGIN
        } catch (e) {
            const closed = await attempt(() => dbClose(db));   // BEGIN 没成功就没有事务；close 失败的错误附到取锁错误上，不丢
            const err = isBusyError(e)
                ? new StateError('STATE_LINE_BUSY', `线 ${name} 正被占用，至少等待了约 ${remainingMs}ms（总预算 ${timeoutMs}ms，含排队；持有者仍活着时不会被接管）`, { cause: e })
                : new StateError('STATE_LOCK_FAILED', `取线级锁失败：${describeErr(e)}`, { cause: e });
            attachCleanupErrors(err, closed ? [closed.error] : [], false, '线级锁');
            throw err;
        }
        let hasFailure = false;
        let failure;
        let result;
        // 持有令牌：asyncFn 一结束（成功 / 失败 / 抛假值）就置失效；嵌套上下文沿用祖先仍活动的令牌对象，自己的令牌加在最后
        const token = { active: true };
        const store = new Map();
        if (held) for (const [k, t] of held) if (t.active) store.set(k, t);
        store.set(key, token);
        try {
            result = await lineLockStore.run(store, () => asyncFn());
        } catch (e) {
            hasFailure = true;
            failure = e;
        } finally {
            token.active = false;
        }
        // 收尾：COMMIT（失败则 ROLLBACK）；线级锁库是空库，不涉及数据。口径同状态锁：事务已结束或 close 成功即锁已释放，只有「事务可能未结束且 close 失败」才算不确定。
        //   每一步失败的底层错误都收进 cleanupErrors（业务异常路径上附到业务异常，不吞）；failedSteps 是同一批失败的文字，写进警告 / 错误消息。
        const cleanupErrors = [];
        const failedSteps = [];
        let txOpen = true;
        const committed = await attempt(() => dbRun(db, 'COMMIT'));
        if (committed) {
            cleanupErrors.push(committed.error);
            failedSteps.push(`COMMIT 失败：${describeErr(committed.error)}`);
            const rolled = await attempt(() => dbRun(db, 'ROLLBACK'));
            if (rolled) { cleanupErrors.push(rolled.error); failedSteps.push(`ROLLBACK 失败：${describeErr(rolled.error)}`); } else txOpen = false;
        } else {
            txOpen = false;
        }
        const closed = await attempt(() => dbClose(db));
        if (closed) { cleanupErrors.push(closed.error); failedSteps.push(`关闭连接失败：${describeErr(closed.error)}`); }
        const uncertain = txOpen && !!closed;
        if (uncertain) markRootUncertain(paths, { lockFile, db, since: Date.now(), errors: cleanupErrors.slice() });
        if (hasFailure) {
            attachCleanupErrors(failure, cleanupErrors, uncertain, '线级锁');   // 附不上（原始值 / 冻结对象）就发警告，锁不确定时警告写明需重启
            throw failure;
        }
        if (uncertain) {
            const err = new StateError('STATE_LOCK_UNCERTAIN', `线 ${name} 的操作已完成，但线级锁收尾失败且事务可能未结束，该控制根的锁状态不确定（本进程内对它的后续调用将立即失败，请重启进程）：${failedSteps.join('；')}`, { cause: cleanupErrors[0] });
            err.lockUncertain = true;
            attachCleanupErrors(err, cleanupErrors, true, '线级锁');
            throw err;
        }
        if (failedSteps.length) process.emitWarning(`线级锁收尾步骤失败（锁已释放，按成功返回）：${failedSteps.join('；')}`, 'StateLockCleanupWarning');
        return result;
    } finally {
        release();
    }
}

// ---------------------------------------------------------------- 读写

function loadRegistry(paths) {
    let text;
    try {
        text = fs.readFileSync(paths.linesFile, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return emptyState();
        // 读不了（权限、EISDIR、EBUSY……）不等于内容损坏：单独的错误码，调用方不会误以为登记表坏了
        throw new StateError('STATE_READ_FAILED', `无法读取登记表 ${paths.linesFile}（读文件失败，不是内容损坏）：${e && e.message}`, { cause: e });
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 容忍开头一个 BOM（记事本等编辑器会加）；写回不带 BOM
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
        throw new StateError('STATE_CORRUPT', `登记表 ${paths.linesFile} 不是合法 JSON（不会被重置，请人工处理）：${e && e.message}`, { cause: e });
    }
    // 多个检出共用同一个控制根：别的检出的线路工具可能写了更高版本的结构，旧代码不得按旧规则校验后改写
    if (isPlainObject(parsed) && Number.isInteger(parsed.version)) {
        if (parsed.version > STATE_VERSION) throw new StateError('STATE_VERSION_NEWER', `登记表 ${paths.linesFile} 的结构版本 ${parsed.version} 高于本代码支持的 ${STATE_VERSION}：请用主工作区的线路工具（不会被改写）`);
        if (parsed.version < STATE_VERSION) throw new StateError('STATE_VERSION_OLDER', `登记表 ${paths.linesFile} 的结构版本 ${parsed.version} 低于本代码的 ${STATE_VERSION}：迁移尚未实现（不会被改写）`);
    }
    const problems = validateState(parsed);
    if (problems.length) throw new StateError('STATE_CORRUPT', `登记表 ${paths.linesFile} 结构校验失败（不会被重置，请人工处理）：${problems.slice(0, 5).join('；')}`);
    return parsed;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** 同目录临时文件 + fsync + renameSync 原子替换；EPERM / EACCES / EBUSY 有界重试，最终失败删临时文件并报错。 */
function atomicWrite(paths, state, opts, track) {
    const rename = hooks.renameSync || fs.renameSync;
    const write = hooks.writeSync || fs.writeSync;
    const open = hooks.openSync || fs.openSync;
    let tmp = null;
    let fd = null;
    let fdOpen = false;   // 还没拿到文件描述符：失败时只清临时文件，不关 fd
    try {
        fs.mkdirSync(paths.root, { recursive: true });
        // 持锁者独占写，所以目录里任何残留的临时文件都是上次崩溃留下的
        try {
            for (const n of fs.readdirSync(paths.root)) if (n.startsWith('lines.json.tmp-')) { try { fs.unlinkSync(path.join(paths.root, n)); } catch (_) { /* 下次再清 */ } }
        } catch (_) { /* ignore */ }
        tmp = path.join(paths.root, `lines.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        // 先生成完整 Buffer；fs.writeSync 可能只写一部分（返回值小于长度），所以循环写到全部写完，零进展视为错误（否则死循环）
        const buf = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fd = open(tmp, 'w');
        fdOpen = true;
        let off = 0;
        while (off < buf.length) {
            const n = write(fd, buf, off, buf.length - off, null);
            if (!(Number.isInteger(n) && n > 0 && n <= buf.length - off)) {
                throw new StateError('STATE_WRITE_FAILED', `写临时文件 ${tmp} 没有进展或返回值非法（writeSync 返回 ${String(n)}，已写 ${off}/${buf.length} 字节）`);
            }
            off += n;
        }
        fs.fsyncSync(fd);
        fdOpen = false;
        fs.closeSync(fd);   // 关闭失败同样算写入失败
    } catch (e) {
        // 任一步失败（建目录、生成缓冲区、创建临时文件、写、fsync、关闭）：关 fd、删临时文件、统一抛 STATE_WRITE_FAILED；登记表还是旧内容（rename 之前不会碰它）
        if (fdOpen) { try { fs.closeSync(fd); } catch (_) { /* 以原错误为准 */ } }
        if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* 没建出来 / 残留的临时文件下次写入时清理 */ } }
        if (e instanceof StateError) throw e;
        throw new StateError('STATE_WRITE_FAILED', `写临时文件失败（已删除临时文件，登记表保持旧内容）：${describeErr(e)}`, { cause: e });
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= REPLACE_MAX_ATTEMPTS; attempt++) {
        try { rename(tmp, paths.linesFile); if (track) track.written = true; return; } catch (e) {
            lastErr = e;
            if (!e || !REPLACE_RETRY_CODES.includes(e.code)) break;
            sleepSync(Math.min(20 * attempt, 200));
        }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* 残留的临时文件下次写入时清理 */ }
    throw new StateError('STATE_REPLACE_FAILED', `原子替换登记表失败（已删除临时文件，登记表保持旧内容）：${lastErr && lastErr.message}`, { cause: lastErr });
}

/** 唯一写通道：取锁 → 重读 → 变更 → 再次校验 → 原子替换 → 释放。mutator(state, ctx) 同步修改传入的 state 副本并返回要交给调用方的值。 */
async function mutate(controlRoot, mutator, opts) {
    const paths = pathsOf(controlRoot);
    return withStateLock(paths, opts, (track) => {
        // 时间戳在持锁之后取：排队等待不会让 updated_at 早于前一个写者的写入时刻
        const now = (opts && typeof opts.now === 'function' ? opts.now() : new Date());
        const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
        const current = loadRegistry(paths);   // 重读（取锁之后）
        const next = deepCopy(current);
        const ret = mutator(next, { nowIso });
        // 无变化不写盘
        if (JSON.stringify(next) === JSON.stringify(current)) return ret;
        const problems = validateState(next);
        if (problems.length) throw new StateError('STATE_INVALID_PATCH', `变更后的登记表结构校验失败，本次写入已放弃：${problems.slice(0, 5).join('；')}`);
        atomicWrite(paths, next, opts, track);
        return ret;
    });
}

function runPatch(patchFn, copy) {
    if (typeof patchFn !== 'function') throw new StateError('STATE_BAD_ARGS', 'patchFn 必须是函数');
    // 原生 async 函数调用前就拒绝：连调用都不做，没有 Promise 产生，也就没有未处理拒绝
    if (patchFn.constructor && patchFn.constructor.name === 'AsyncFunction') throw new StateError('STATE_PATCH_ASYNC', '补丁函数必须是同步函数：收到 async 函数，本次写入已放弃（未调用）');
    const result = patchFn(copy);
    if (result && typeof result.then === 'function') {
        // 返回了真实 Promise（非 async 写法，如 Promise.reject()）：先挂空 catch 吃掉它将来的拒绝，再抛错，否则进程出现 unhandledRejection。
        //   用 util.types.isPromise 识别（含其他执行上下文创建的 Promise），经 Promise.prototype.then.call 挂处理；普通 thenable 不碰它的 then（可能有副作用），只同步拒绝。
        swallowRejection(result);
        throw new StateError('STATE_PATCH_ASYNC', '补丁函数必须是同步函数：返回了 Promise / thenable，本次写入已放弃');
    }
    if (result === undefined) { assertSerializable(copy, '补丁结果', 'STATE_INVALID_PATCH'); return copy; }
    if (!isPlainObject(result)) throw new StateError('STATE_INVALID_PATCH', '补丁函数必须返回 undefined（改动传入的拷贝）或对象');
    assertSerializable(result, '补丁结果', 'STATE_INVALID_PATCH');
    return result;
}

const IMMUTABLE_LINE_FIELDS = Object.freeze(['name', 'generation', 'slot', 'port', 'created_at']);

/** 在 next（登记表副本）里对一条线应用补丁：深拷贝给补丁、校验不可变字段与 lifecycle 转换、bump updated_at、removed 移入 history。 */
function applyLinePatch(next, key, patchFn, nowIso) {
    const before = next.lines[key];
    const copy = deepCopy(before);
    const after = deepCopy(runPatch(patchFn, copy));
    for (const f of IMMUTABLE_LINE_FIELDS) {
        if (after[f] !== before[f]) throw new StateError('STATE_FIELD_IMMUTABLE', `线 ${key} 的字段 ${f} 不可通过更新入口修改`);
    }
    if (!checkLifecycleTransition(before.lifecycle, after.lifecycle)) {
        throw new StateError('STATE_BAD_TRANSITION', `线 ${key} 的 lifecycle 不允许 ${before.lifecycle} → ${after.lifecycle}`);
    }
    // 状态不变量（与是否发生转换无关）：任何写入后 lifecycle 为 removing / removed 的记录，process 必须为 null（先停实例、清 process，再转；已在 removing 的线也不能再登记进程）。
    //   判的是写入后的记录，同一次写里先清 process 再转是允许的。结构校验（validateRecord）同样检查：登记表里出现违反的记录 → STATE_CORRUPT。
    if ((after.lifecycle === 'removing' || after.lifecycle === 'removed') && after.process !== null) {
        throw new StateError('STATE_PROCESS_REGISTERED', `线 ${key} 的 lifecycle 为 ${after.lifecycle}，process 必须为 null（先停实例并清空 process；removing / removed 的线不能再登记进程）`);
    }
    if (after.lifecycle === 'removed') after.yield_request = null;   // 线没了，让路请求随之作废；同一次写清空
    if (JSON.stringify(after) !== JSON.stringify(before)) after.updated_at = nowIso;
    if (after.lifecycle === 'removed') {
        // 槽位在线转为 removed 时释放：记录移入 history
        delete next.lines[key];
        next.history.push(Object.assign(after, { removed_at: nowIso }));
    } else {
        next.lines[key] = after;
    }
    return after;
}

function findKey(state, name) {
    if (typeof name !== 'string') return null;
    const k = nameKey(name);
    for (const key of Object.keys(state.lines)) if (nameKey(key) === k) return key;
    return null;
}

// ---------------------------------------------------------------- 导出的读写函数

/** 锁内读；锁文件从未被创建过（没人写过）时直接读文件，不为读取而创建目录。返回登记表的深拷贝。 */
async function readState(controlRoot, opts) {
    const paths = pathsOf(controlRoot);
    assertRootCertain(paths, '读登记表');   // 含下面「锁文件不存在」的快捷分支：快捷分支不经过 withStateLock，必须自己查
    if (!fs.existsSync(paths.lockFile)) return deepCopy(loadRegistry(paths));
    return withStateLock(paths, opts, () => deepCopy(loadRegistry(paths)));
}

/**
 * 入口同步捕获 opts.expectGeneration：给了就必须是字符串（等锁之前先查参数），返回字符串快照（没给返回 undefined = 不检查）。
 * 之后锁内只用这个快照，不再读原 opts——调用方在等锁期间改 opts（改成 undefined / 别的类型）取消不了代次保护。
 */
function captureExpectGeneration(opts) {
    const v = opts ? opts.expectGeneration : undefined;   // 只读一次
    if (v !== undefined && typeof v !== 'string') throw new StateError('STATE_BAD_ARGS', 'opts.expectGeneration 必须是字符串');
    return v;
}
/** 锁内、应用补丁之前：记录代次与入口快照的 expectGen 不符即放弃（登记表不变）。旧操作按过期信息动「同名重建后的新线」会在这里被挡下。 */
function assertGeneration(rec, key, expectGen) {
    if (expectGen !== undefined && rec.generation !== expectGen) {
        throw new StateError('STATE_GENERATION_MISMATCH', `线 ${key} 的代次与期望不符（期望 ${expectGen}，当前 ${rec.generation}）：这条线可能已被删除并同名重建，本次操作已放弃`);
    }
}

/** 更新一条线。patchFn 同步，拿到该线记录的深拷贝；返回 undefined（改拷贝）或新记录对象。返回更新后的记录（深拷贝）。 */
async function updateLine(controlRoot, name, patchFn, opts) {
    const expectGen = captureExpectGeneration(opts);
    return mutate(controlRoot, (state, ctx) => {
        const key = findKey(state, name);
        if (key === null) throw new StateError('STATE_NO_SUCH_LINE', `没有这条线：${name}`);
        assertGeneration(state.lines[key], key, expectGen);
        return deepCopy(applyLinePatch(state, key, patchFn, ctx.nowIso));
    }, opts);
}

/** 更新全局配置。patchFn 同步，拿到 config 的深拷贝。返回更新后的 config（深拷贝）。 */
async function updateConfig(controlRoot, patchFn, opts) {
    return mutate(controlRoot, (state) => {
        const result = deepCopy(runPatch(patchFn, deepCopy(state.config)));
        state.config = result;
        return deepCopy(result);
    }, opts);
}

const CREATE_INIT_FIELDS = Object.freeze(['module', 'branch', 'worktree', 'surface', 'deps_mode']);

/**
 * 建线：锁内分配最小空闲槽位（lifecycle 不是 removed 的线都占槽，含 failed），lifecycle = creating。返回新记录。
 * opts.guard(others)：锁内、重读之后、分配槽位之前同步执行（S2b 的同模块闸门）；others 是其他未 removed 线的只读深拷贝，每项只含 name / module / surface / lifecycle。
 *   guard 抛错即放弃本次写入并原样抛出；guard 是 async 函数或返回 Promise / thenable 同补丁规则以 STATE_PATCH_ASYNC 拒绝。
 */
async function createLine(controlRoot, name, init, opts) {
    const problem = checkLineName(name);
    if (problem) throw new StateError('STATE_BAD_NAME', `线名 ${JSON.stringify(name)} 非法：${problem}`);
    const given = init === undefined || init === null ? {} : init;
    if (!isPlainObject(given)) throw new StateError('STATE_BAD_ARGS', 'createLine：init 必须是对象');
    assertSerializable(given, 'init', 'STATE_BAD_ARGS');   // 在 deepCopy（JSON 往返）之前校验，不让往返悄悄改写输入
    for (const k of Object.keys(given)) if (!CREATE_INIT_FIELDS.includes(k)) throw new StateError('STATE_BAD_ARGS', `createLine：init 含不支持的字段 ${k}`);
    // 首次校验与白名单检查之后、任何 await（等锁）之前立即快照：调用方在等锁期间改原对象（改成 NaN、加 undefined 字段）不影响落盘内容；锁内只用快照
    const initSnapshot = deepCopy(given);
    return mutate(controlRoot, (state, ctx) => {
        if (findKey(state, name) !== null) throw new StateError('STATE_LINE_EXISTS', `线 ${name} 已存在（线名不分大小写）`);
        if (opts && opts.guard !== undefined && opts.guard !== null) {
            if (typeof opts.guard !== 'function') throw new StateError('STATE_BAD_ARGS', 'createLine：opts.guard 必须是函数');
            if (opts.guard.constructor && opts.guard.constructor.name === 'AsyncFunction') throw new StateError('STATE_PATCH_ASYNC', 'guard 必须是同步函数：收到 async 函数，本次写入已放弃（未调用）');
            const others = Object.values(state.lines).filter(occupiesSlot)
                .map((r) => deepCopy({ name: r.name, module: r.module, surface: r.surface, lifecycle: r.lifecycle }));
            const verdict = opts.guard(others);
            if (verdict && typeof verdict.then === 'function') {
                swallowRejection(verdict);
                throw new StateError('STATE_PATCH_ASYNC', 'guard 必须是同步函数：返回了 Promise / thenable，本次写入已放弃');
            }
        }
        const used = new Set(Object.values(state.lines).filter(occupiesSlot).map((r) => r.slot));
        const slot = [1, 2, 3].find((s) => !used.has(s));
        if (slot === undefined) throw new StateError('STATE_NO_FREE_SLOT', '3 个槽位都被占用（lifecycle 不是 removed 的线都占槽，含 failed）');
        const rec = {
            name, generation: crypto.randomUUID(), lifecycle: 'creating', failed_step: null, integration: { state: 'idle' }, yield_request: null,
            module: null, branch: null, worktree: null, slot, port: currentSlotPorts[slot], surface: null, deps_mode: 'shared', process: null,
            created_at: ctx.nowIso, updated_at: ctx.nowIso,
        };
        Object.assign(rec, deepCopy(initSnapshot));
        state.lines[name] = rec;
        return deepCopy(rec);
    }, opts);
}

/** 删线记录：要求 lifecycle 已是 removing，转为 removed 并移入 history，释放槽位。返回移入 history 的记录。 */
async function removeLineRecord(controlRoot, name, opts) {
    const expectGen = captureExpectGeneration(opts);
    return mutate(controlRoot, (state, ctx) => {
        const key = findKey(state, name);
        if (key === null) throw new StateError('STATE_NO_SUCH_LINE', `没有这条线：${name}`);
        assertGeneration(state.lines[key], key, expectGen);
        return deepCopy(applyLinePatch(state, key, (r) => { r.lifecycle = 'removed'; }, ctx.nowIso));
    }, opts);
}

module.exports = {
    STATE_VERSION, SLOT_PORTS, LIFECYCLES, INTEGRATION_STATES, DEFAULT_LOCK_TIMEOUT_MS, StateError,
    resolveControlRoot, readState, updateLine, updateConfig, createLine, removeLineRecord, withLineLock,
    checkLineName, checkLifecycleTransition, validateState,
    _internal: { setTestHooks, findUnserializable, setSlotPortsForTest },   // 测试接缝与内部函数，不属于写入口；调用方限于 verify 脚本，以及 line.js（仅在 --control-root / --lines-root / --main-root 三个根覆盖参数全给时才调用 setSlotPortsForTest，见 line.js 的 --slot-ports 处理）
};
