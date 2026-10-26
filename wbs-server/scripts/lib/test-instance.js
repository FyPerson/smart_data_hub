/**
 * 临时实例启动器（#106 S3a · W3「临时实例启动器」）
 *
 * 方案 SSOT = docs/local/多线并行/多线并行改造_方案_20261015_v1.3.md 的 W3 小节；派单 = docs/local/多线并行/派单/S3a_派单_临时实例启动器与就绪接口_20261018.md。
 * 用途：测试脚本需要一个「真服务」时，从本检出的库拍一份隔离快照，在系统临时目录里起一个 server.js 子进程（隔离模式、外发替身、周期任务关闭），
 *   就绪后把 { baseUrl, dbPath, dataDir, instance, jwtSecret, ... } 交给测试，测试结束 stop() 收进程、删目录。
 *
 * 导出：
 *   startTestInstance(options)           → Promise<{ baseUrl, port, instance, dbPath, dataDir, jwtSecret, pid, startTime, stop(), missingResources, resources, isolatedDb, modules, parent, startupRaceRetries }>
 *   sweepStaleTestInstances(options)     → Promise<{ scanned, removed: [dir], kept: [{ dir, reason }], failed: [{ dir, error }] }>
 *   常量 / 辅助：RESOURCE_NAMES、RESOURCE_ALIASES、STRIPPED_ENV_KEYS、DIR_PREFIX、MANIFEST_FILE、HEALTH_PATH、DEFAULT_*；_internals 给自检用。
 *
 * options（全部可选）：
 *   resources      命名资源集合，取 uploads / archive / private / periodic-results / reconcile（方案里的公开名；it-reconcile 是同义名，两者都映射到数据根下的 it-reconcile 目录）的不重复子集，默认空：
 *                  按「正常模式」的来源目录复制（copyTreeNoFollow，不用目录联接）到数据根对应位置，开始前对库里引用这些文件的表做存在性检查
 *   modules        'all'（默认）或模块名数组：等 /api/health/ready 里这些模块都 ready
 *   waitFor        'ready'（默认）| 'identity'：identity 只等 /api/version 的身份，不等模块（专测初始化失败的脚本用）
 *   readyTimeoutMs 就绪总期限（默认 90000，含端口重试之前的各次尝试各自重新计时）
 *   startupRaceRetries  启动期 SQLITE_BUSY 竞态（PROJECT_STATUS #122）的有界重试次数（默认 2，0 = 不重试）。**只在有可归因的 SQLITE_BUSY 证据时**重试，两种形态：
 *                  ① 就绪失败（超时，或**全部**未就绪模块都报告了不会自愈的终态码——见下面「提前结束等待」）且未就绪模块的码全是 INIT_FAILED / LEDGER_UNAVAILABLE / SQLITE_BUSY，并且有证据：
 *                     证据 = 未就绪码里有 SQLITE_BUSY（core 直接带 sqlite 的 code，不写日志，所以码本身就是证据），或服务日志里有 SQLITE_BUSY / database is locked 行（INIT_FAILED / LEDGER_UNAVAILABLE 要求这一条；
 *                     含「不影响启动」的行不计——代码作者已声明那类 BUSY 不影响就绪；逐模块把日志行对应到模块做不到，维持这个粗粒度，登记为残余）；
 *                  ② 服务进程提前退出（TI_SERVER_EXITED）且日志尾（最后 80 行）**同一行**同时含 Uncaught Exception 与 SQLITE_BUSY（真实崩溃行形如 `Uncaught Exception: [Error: SQLITE_BUSY: database is locked]`；分在两行不算）。
 *                  每次重试：先彻底收掉上一次的进程与数据根（失败收口没做干净则不重试）再从头重建；向 stderr 打印一行 STARTUP_RACE（含失败码与 BUSY 证据条数，不含日志原文）；返回值带 startupRaceRetries 计数。无 BUSY 证据的初始化失败直接失败。
 *   提前结束等待：模块就绪等待里，**只有全部未就绪的模块都已报告终态码**（不在 NON_TERMINAL_CODES 里：NOT_READY / LEDGER_NOT_READY 是「还在初始化」，没有码也算非终态）并且这个集合持续 TERMINAL_STABLE_MS 不变，才提前结束等待
 *                  （错误带 earlyEnd = true）；只要还有一个未就绪模块没有终态，就继续等到它就绪 / 也变终态 / 期限到。否则 core 已报 SQLITE_BUSY 而 it_ledger 还在 LEDGER_NOT_READY 时会被截断，
 *                  错过「it_ledger 稍后能正常完成」的竞态重试。
 *   就绪的含义：返回值是**返回时刻的快照**——所有被等待的模块在最后一次 /api/health/ready 读数里都是 ready，端口监听者就是本次子进程。快照之后才完成的晚到失败（initTable 的 SELECT 1 之后完成的嵌套 ALTER /
 *                  默认管理员 / 旧附件迁移分支）、A 类失败（无回调语句失败 → 未捕获异常 → server.js 的处理器等约 1 秒才退出）后那 1 秒的退出窗口，都不在保证内；交给测试的实例若随后不可用，测试会判红，不会假绿。
 *   —— 以下是测试接缝（verify-test-instance 用；正常使用不传）——
 *   sourceDbPath / sourceEncryptionKey   显式指定来源库与来源键（默认：本检出的库 + 本检出 .env 里的 DB_ENCRYPTION_KEY，见 planDefaultSource）
 *   resourceRoot                         资源来源根（默认本检出 wbs-server 目录）。父检出身份不可选：恒取本检出身份（服务端核对库内 parent 时也是这个值，传别的只会 PARENT_MISMATCH）
 *   serverJs / nodeArgs / extraEnv       被启动的 server 脚本（默认本检出 server.js）/ 脚本前的 node 参数（如 --require 守卫）/ 追加的子进程环境（不得含 SDH_* 与被剔除的键）
 *   maxPortAttempts / _hooks.beforeSpawn 端口重试上限（默认 5）/ 每次 spawn 前的钩子
 *
 * 安全约束（本文件自己的）：
 *   - 子进程环境 = 父进程环境，**不分大小写剔除全部 SDH_***，并剔除 PORT / JWT_SECRET / DB_ENCRYPTION_KEY / WEBHOOK_SECRET / SYS_TEST_HOOKS；再显式设置 SDH_INSTANCE / SDH_DB_FILE / SDH_DATA_DIR /
 *     SDH_EXTERNAL=stub / SDH_BACKGROUND_JOBS=off / 随机 JWT_SECRET / PORT；
 *   - **.env 白名单（S3a 修复批 1，主会话裁定 P1）**：被启动的 server.js 自己会 dotenv 读 <server.js 所在目录>/.env。启动器读该文件时同时取出全部**键名**（只取名：值不使用、不留存、不解密），
 *     在子进程环境里把白名单以外的键一律置空串（dotenv 不覆盖已存在的键，空串也算存在）。白名单 = scripts/lines/line-new.js 的 LINE_ENV_WHITELIST（线 .env 的同一口径：SYS_FASTLANE_ENABLE / LOG_LEVEL /
 *     NODE_ENV，依据见该文件逐键的 reader / why；本文件直接复用该常量，不复制）；JWT_SECRET / PORT / SDH_* 与 extraEnv 里的键由启动器显式设值，不在置空之列；父进程环境仍整体继承（node / git 需要）。
 *     **系统键例外（SYSTEM_ENV_KEYS_UPPER：PATH / PATHEXT / SYSTEMROOT / WINDIR / COMSPEC / TEMP / TMP / USERPROFILE / APPDATA / LOCALAPPDATA / HOMEDRIVE / HOMEPATH / TZ，不分大小写）**：.env 里出现这些键名、
 *     且子进程环境里已有该键（来自父环境）时不置空，保留父值（dotenv 本来就不覆盖已有键）；父环境没有该键则照旧置空。否则 .env 里一行 `Path=` / `TEMP=` 就会把子进程的 PATH / 临时目录清空。
 *     该文件不存在时行为不变（没有 .env 可读）；读不了（非 ENOENT）→ TI_ENV_FILE_UNREADABLE，不带着未知的 .env 启动。
 *   - 来源键只在本进程内使用：不打印、不写文件、不进子进程环境、不挂到返回值与错误对象；对外抛出的错误一律经 scrubError 脱敏；
 *   - 不用 fs.rmSync / fs.cpSync（Node v24 对含中文路径静默不删 / 乱写）：复制用 copyTreeNoFollow，删除用 deleteTreeNoFollow + rmdir + lstat 确认；
 *   - 终止进程只终止自己用 spawn 起的子进程（持有 ChildProcess 句柄，PID 被句柄钉住）；遗留目录的清理只认实例清单里「PID + 精确创建时间」（sweepStaleTestInstances）。
 * 只支持 Windows（进程身份 / 端口监听者查询沿用 scripts/lines/line-proc.js 的实现）。
 *
 * 已知残余（登记，不在本文件内处理）：
 *   - 剔除 + 显式空串（S3a 修复批 0，主会话裁定）：被启动的 server.js 自己会 dotenv 读取本检出的 <wbs-server>/.env（server.js 顶部）。dotenv 不覆盖进程里已存在的键（空串也算存在），
 *     只剔除的话这些键在子进程里「不存在」，.env 就能把真值带回来。所以 WEBHOOK_SECRET / SYS_TEST_HOOKS / DB_ENCRYPTION_KEY 在剔除之后显式设为空串（EMPTIED_ENV_KEYS）：
 *     WEBHOOK_SECRET 为空 → server.js 的 webhook 入口拒绝；SYS_TEST_HOOKS 只在 === '1' 时启用；DB_ENCRYPTION_KEY 在隔离模式下被忽略（S1a）。JWT_SECRET / PORT / SDH_* 照旧由启动器显式设置。
 *     用例 E1 用合成 .env 观测子进程里的实际值。
 *   - 复制进数据根的 periodic_task_runs.result_file_path 是来源检出下的绝对路径（runner.resolveSafeResultPath 要求落在本实例的 periodic-results 内），
 *     所以实例里这些历史行的结果文件即使被复制过来也不会被解析到（会自愈标成 missing）；本文件对它只核对「文件名在复制后的目录里」。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const dotenv = require('dotenv');

const WBS_DIR = path.resolve(__dirname, '..', '..');
const procLib = require('../../../scripts/lines/line-proc');
const common = require('../../../scripts/lines/line-common');
// line-new.js 无加载期副作用（S3a 修复批 1 实测：require 前后监听器 / 句柄 / 环境 / 工作目录均不变）；复用它的两份常量，避免与线工具漂移：
//   ATTACHMENT_SOURCES = 库里引用附件文件的表与列（资源引用检查）；LINE_ENV_WHITELIST = 线 .env 的白名单（子进程 .env 白名单）
const { ATTACHMENT_SOURCES, LINE_ENV_WHITELIST } = require('../../../scripts/lines/line-new');
const instanceDb = require('../../utils/instance-db');
const instanceMode = require('../../utils/instance-mode');
const { listenOnSafePort } = require('./listen-safe-port');

/** 资源名（内部 = 数据根下的目录名）；方案里的公开名 reconcile 经 RESOURCE_ALIASES 映射到 it-reconcile，两种写法都接受 */
const RESOURCE_NAMES = Object.freeze(['uploads', 'archive', 'private', 'periodic-results', 'it-reconcile']);
const RESOURCE_ALIASES = Object.freeze({ reconcile: 'it-reconcile' });
/** 子进程环境里无条件剔除的键（不分大小写）；SDH_* 另按前缀整体剔除 */
const STRIPPED_ENV_KEYS = Object.freeze(['PORT', 'JWT_SECRET', 'DB_ENCRYPTION_KEY', 'WEBHOOK_SECRET', 'SYS_TEST_HOOKS']);
/** 剔除之后在子进程环境里显式置空串的键（挡住被启动的 server.js 用 dotenv 从本检出 .env 把它们带回；PORT / JWT_SECRET / SDH_* 由启动器显式设值，不在此列） */
const EMPTIED_ENV_KEYS = Object.freeze(['WEBHOOK_SECRET', 'SYS_TEST_HOOKS', 'DB_ENCRYPTION_KEY']);
const DIR_PREFIX = 'sdh-test-';
const MANIFEST_FILE = instanceMode.MANIFEST_FILE;            // 'sdh-instance.json'
const SERVER_LOG_FILE = 'server.log';
const HEALTH_PATH = '/api/health/ready';
const VERSION_PATH = '/api/version';
const DEFAULT_READY_TIMEOUT_MS = 90000;
const DEFAULT_MAX_PORT_ATTEMPTS = 5;
const POLL_MS = 250;
const MISSING_LIST_CAP = 200;
const LOG_TAIL_LINES = 40;
const TEST_NAME_RE = /^test-[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/;
const SWEEP_DIR_RE = /^sdh-test-[A-Za-z0-9]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;
const KNOWN_OPTIONS = Object.freeze(['resources', 'modules', 'waitFor', 'readyTimeoutMs', 'startupRaceRetries', 'sourceDbPath', 'sourceEncryptionKey', 'resourceRoot', 'serverJs', 'nodeArgs', 'extraEnv', 'maxPortAttempts', '_hooks']);
const DEFAULT_STARTUP_RACE_RETRIES = 2;
const MAX_STARTUP_RACE_RETRIES = 5;
/** 启动期竞态的证据：服务日志里的 SQLite 忙 / 锁 */
const BUSY_LINE_RE = /SQLITE_BUSY|database is locked/i;
/** 含这几个字的 BUSY 行不计为就绪失败的证据（代码作者在日志里自己写明「不影响启动」，例如周期取数的僵尸 run 复位失败） */
const BUSY_HARMLESS_RE = /不影响启动/;
/** 形态 ② 看的日志尾行数 */
const CRASH_TAIL_LINES = 80;
/** 形态 ① 里允许出现的「未就绪模块码」：模块把 BUSY 折成 INIT_FAILED / LEDGER_UNAVAILABLE，core 直接带 sqlite 的 code（SQLITE_BUSY） */
const RACE_MODULE_CODES = Object.freeze(['INIT_FAILED', 'LEDGER_UNAVAILABLE', 'SQLITE_BUSY']);
/** 模块还在初始化中的码（非终态）；其余未就绪码视为不会自愈的终态 */
const NON_TERMINAL_CODES = Object.freeze(['NOT_READY', 'LEDGER_NOT_READY']);
/** 终态码要持续这么久才提前结束等待（防个别模块先记错后清除而误判） */
const TERMINAL_STABLE_MS = 1500;

/** 对外错误：code 固定枚举；附加字段（unreadyModules / logTail / dataDir 等）由调用点放进 extra */
class TestInstanceError extends Error {
    constructor(code, message, extra) {
        super(message);
        this.name = 'TestInstanceError';
        this.code = code;
        if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => String(p).replace(/\\/g, '/');
const upperAscii = (k) => String(k).replace(/[a-z]+/g, (s) => s.toUpperCase());
const randHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

// ---------------------------------------------------------------- 资源目录映射

/** 「正常模式」下各命名资源的来源目录（与 instance-mode 正常模式 / 各模块默认路径一致；it-reconcile 的默认落点见 routes/it-ledger/reconciles.js:15） */
function normalResourceDirs(root) {
    return {
        uploads: path.join(root, 'uploads'),
        archive: path.join(root, 'archive'),
        private: path.join(root, 'private'),                                   // 巡检照片在 private/it-inspection-sheets（it-ledger/index.js 默认：<DB 所在目录>/private/it-inspection-sheets）
        'periodic-results': path.join(root, 'periodic-results'),
        'it-reconcile': path.join(root, 'routes', 'it-ledger', 'uploads', 'it-reconcile'),
    };
}
/** 隔离模式（含测试实例）下各资源在数据根里的落点（instance-mode.js 隔离模式目录映射） */
function targetResourceDirs(dataDir) {
    return {
        uploads: path.join(dataDir, 'uploads'),
        archive: path.join(dataDir, 'archive'),
        private: path.join(dataDir, 'private'),
        'periodic-results': path.join(dataDir, 'periodic-results'),
        'it-reconcile': path.join(dataDir, 'it-reconcile'),
    };
}

// ---------------------------------------------------------------- 来源（默认路径 + 测试接缝）

function readCheckoutIdentity(wbsDir, readFile) {
    let raw = null;
    try { raw = readFile(path.join(wbsDir, instanceMode.IDENTITY_FILE)); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    if (raw === null || raw === undefined) return null;
    const t = String(raw).replace(/^﻿/, '').trim();
    return t === '' ? null : t;
}

/**
 * 默认来源规划（纯规划，不打开任何库）：
 *   正常检出（无 .sdh-instance）→ 来源 = <wbs>/task_pool.db，来源键 = <wbs>/.env 里的 DB_ENCRYPTION_KEY（只在进程内用），父身份 main，资源取 <wbs> 下的正常模式目录；
 *   线检出（有 .sdh-instance）→ 来源 = 线库（SDH_DB_FILE，缺省 <wbs>/task_pool.db），不传来源键（线库是隔离库），父身份 = 线名，资源取线的数据根；
 *   已经是测试实例 / 判定被拒绝 / 正常检出缺来源键 → 抛 TestInstanceError。
 * deps.env / deps.readFile / deps.readEnvFile 仅供自检注入合成目录；生产路径不传。
 */
function planDefaultSource(wbsDir, deps) {
    const d = deps || {};
    const env = d.env || process.env;
    const readFile = d.readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const readEnv = d.readEnvFile || common.readEnvFile;
    const cfg = instanceMode.resolveInstanceConfig({ env, checkoutDir: wbsDir, readFile });
    if (cfg.refuse) throw new TestInstanceError('TI_MODE_REFUSED', `本检出的运行模式判定被拒绝（${cfg.code}），不能派生测试实例：${cfg.message}`);
    if (cfg.kind === 'test') throw new TestInstanceError('TI_NESTED_TEST_INSTANCE', '当前进程环境已是测试实例（SDH_INSTANCE 以 test- 开头）：不在测试实例里再派生测试实例');
    if (cfg.mode === 'normal') {
        let envObj = null;
        try { envObj = readEnv(path.join(wbsDir, '.env')); } catch (e) { throw new TestInstanceError('TI_SOURCE_KEY_UNAVAILABLE', `读取 ${path.join(wbsDir, '.env')} 失败：${e && e.code ? e.code : 'error'}`); }
        const key = envObj && typeof envObj.DB_ENCRYPTION_KEY === 'string' ? envObj.DB_ENCRYPTION_KEY.trim() : '';
        if (!key) throw new TestInstanceError('TI_SOURCE_KEY_UNAVAILABLE', `本检出 ${path.join(wbsDir, '.env')} 里没有 DB_ENCRYPTION_KEY：无法解开来源库的非钉钉配置。确认要放弃这些配置时，显式传 sourceEncryptionKey: null（并指定 sourceDbPath）`);
        return { kind: 'normal', sourceDbPath: cfg.dbFile, sourceEncryptionKey: key, parent: 'main', resourceDirs: normalResourceDirs(wbsDir) };
    }
    // 线检出：来源是线库（隔离库，不传来源键）
    return {
        kind: 'line',
        sourceDbPath: cfg.dbFile,
        sourceEncryptionKey: undefined,
        parent: cfg.checkoutIdentity || cfg.instance,
        resourceDirs: {
            uploads: cfg.uploadDir,
            archive: cfg.archiveDir,
            private: path.join(cfg.dataRoot, 'private'),
            'periodic-results': cfg.periodicResultsDir,
            'it-reconcile': cfg.itReconcileDir,
        },
    };
}

function resolveSource(options) {
    if (options.sourceDbPath !== undefined) {
        if (typeof options.sourceDbPath !== 'string' || options.sourceDbPath === '') throw new TestInstanceError('TI_BAD_OPTIONS', 'sourceDbPath 必须是非空字符串');
        const parent = readCheckoutIdentity(WBS_DIR, (p) => fs.readFileSync(p, 'utf8')) || 'main';   // 恒取本检出身份（服务端 expectedParent 也是它）
        return { kind: 'explicit', sourceDbPath: options.sourceDbPath, sourceEncryptionKey: options.sourceEncryptionKey, parent, resourceDirs: normalResourceDirs(options.resourceRoot || WBS_DIR) };
    }
    if (options.sourceEncryptionKey !== undefined) throw new TestInstanceError('TI_BAD_OPTIONS', 'sourceEncryptionKey 只能与 sourceDbPath 一起显式指定');
    const plan = planDefaultSource(WBS_DIR);
    if (options.resourceRoot) plan.resourceDirs = normalResourceDirs(options.resourceRoot);
    return plan;
}

function validateOptions(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TestInstanceError('TI_BAD_OPTIONS', 'options 必须是对象');
    for (const k of Object.keys(options)) {
        if (!KNOWN_OPTIONS.includes(k)) throw new TestInstanceError('TI_BAD_OPTIONS', `未知选项 ${JSON.stringify(k)}（已知：${KNOWN_OPTIONS.join(' / ')}）`);
    }
    const resourcesIn = options.resources === undefined ? [] : options.resources;
    const isAlias = (r) => Object.prototype.hasOwnProperty.call(RESOURCE_ALIASES, r);
    if (!Array.isArray(resourcesIn) || !resourcesIn.every((r) => typeof r === 'string' && (RESOURCE_NAMES.includes(r) || isAlias(r)))) {
        throw new TestInstanceError('TI_BAD_OPTIONS', 'resources 必须是 uploads / archive / private / periodic-results / reconcile（同义名 it-reconcile）的不重复子集');
    }
    const resources = resourcesIn.map((r) => (isAlias(r) ? RESOURCE_ALIASES[r] : r));   // 公开名 → 内部目录名
    if (new Set(resources).size !== resources.length) throw new TestInstanceError('TI_BAD_OPTIONS', 'resources 里有重复项（reconcile 与 it-reconcile 是同一个资源）');
    const waitFor = options.waitFor === undefined ? 'ready' : options.waitFor;
    if (waitFor !== 'ready' && waitFor !== 'identity') throw new TestInstanceError('TI_BAD_OPTIONS', "waitFor 只接受 'ready' 或 'identity'");
    const modules = options.modules === undefined ? 'all' : options.modules;
    if (modules !== 'all' && !(Array.isArray(modules) && modules.length > 0 && modules.every((m) => typeof m === 'string' && /^[a-z][a-z0-9_]*$/.test(m)))) {
        throw new TestInstanceError('TI_BAD_OPTIONS', "modules 必须是 'all' 或非空的小写模块名数组");
    }
    const readyTimeoutMs = options.readyTimeoutMs === undefined ? DEFAULT_READY_TIMEOUT_MS : options.readyTimeoutMs;
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1000) throw new TestInstanceError('TI_BAD_OPTIONS', 'readyTimeoutMs 必须是 >= 1000 的整数');
    const startupRaceRetries = options.startupRaceRetries === undefined ? DEFAULT_STARTUP_RACE_RETRIES : options.startupRaceRetries;
    if (!Number.isSafeInteger(startupRaceRetries) || startupRaceRetries < 0 || startupRaceRetries > MAX_STARTUP_RACE_RETRIES) throw new TestInstanceError('TI_BAD_OPTIONS', `startupRaceRetries 必须是 0–${MAX_STARTUP_RACE_RETRIES} 的整数`);
    const maxPortAttempts = options.maxPortAttempts === undefined ? DEFAULT_MAX_PORT_ATTEMPTS : options.maxPortAttempts;
    if (!Number.isSafeInteger(maxPortAttempts) || maxPortAttempts < 1 || maxPortAttempts > 20) throw new TestInstanceError('TI_BAD_OPTIONS', 'maxPortAttempts 必须是 1–20 的整数');
    const nodeArgs = options.nodeArgs === undefined ? [] : options.nodeArgs;
    if (!Array.isArray(nodeArgs) || !nodeArgs.every((a) => typeof a === 'string')) throw new TestInstanceError('TI_BAD_OPTIONS', 'nodeArgs 必须是字符串数组');
    const extraEnv = options.extraEnv === undefined ? {} : options.extraEnv;
    if (extraEnv === null || typeof extraEnv !== 'object' || Array.isArray(extraEnv)) throw new TestInstanceError('TI_BAD_OPTIONS', 'extraEnv 必须是对象');
    for (const k of Object.keys(extraEnv)) {
        const up = upperAscii(k);
        if (up.startsWith('SDH_') || STRIPPED_ENV_KEYS.includes(up)) throw new TestInstanceError('TI_BAD_OPTIONS', `extraEnv 不得包含 SDH_* 或被剔除的键：${k}`);
        if (typeof extraEnv[k] !== 'string') throw new TestInstanceError('TI_BAD_OPTIONS', `extraEnv.${k} 必须是字符串`);
    }
    const serverJs = options.serverJs === undefined ? path.join(WBS_DIR, 'server.js') : options.serverJs;
    if (typeof serverJs !== 'string' || !path.isAbsolute(serverJs)) throw new TestInstanceError('TI_BAD_OPTIONS', 'serverJs 必须是绝对路径');
    const hooks = options._hooks === undefined ? {} : options._hooks;
    return { resources, waitFor, modules, readyTimeoutMs, startupRaceRetries, maxPortAttempts, nodeArgs, extraEnv, serverJs, hooks };
}

// ---------------------------------------------------------------- 子进程环境

/** .env 白名单（不分大小写比较）：线 .env 的同一口径，取自 scripts/lines/line-new.js 的 LINE_ENV_WHITELIST */
const ENV_FILE_WHITELIST_UPPER = Object.freeze(LINE_ENV_WHITELIST.map((w) => upperAscii(w.key)));
/** 启动器自己显式设值的键（不在 .env 置空之列） */
const LAUNCHER_EXPLICIT_UPPER = Object.freeze(['SDH_INSTANCE', 'SDH_DB_FILE', 'SDH_DATA_DIR', 'SDH_EXTERNAL', 'SDH_BACKGROUND_JOBS', 'JWT_SECRET', 'PORT']);
/**
 * 系统键（不分大小写）：.env 里即使出现这些键名，只要**子进程环境里已有**（来自父环境）就不置空——dotenv 不覆盖已有键，保留父值即可；置空反而会弄坏子进程
 * （PATH 空 → 找不到可执行文件；TEMP / TMP 空 → os.tmpdir() 变成系统目录，instance-mode 拒绝启动；TZ 空 → 时区变 UTC）。父环境里没有的系统键照旧置空（不让 .env 把值带进来）。
 */
const SYSTEM_ENV_KEYS_UPPER = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TZ']);

/**
 * 被启动的 server.js 会 dotenv 读 <server.js 所在目录>/.env：这里只取其中的**键名**（dotenv.parse 解析后只取 Object.keys，值立刻丢弃；不解密、不使用、不打印）。
 * 文件不存在 → []；读不了（非 ENOENT）→ TI_ENV_FILE_UNREADABLE（不带着未知的 .env 启动）。
 */
function readEnvFileKeyNames(serverJs) {
    const envFile = path.join(path.dirname(serverJs), '.env');
    let buf;
    try { buf = fs.readFileSync(envFile); } catch (e) {
        if (e && e.code === 'ENOENT') return [];
        throw new TestInstanceError('TI_ENV_FILE_UNREADABLE', `读取 ${envFile} 的键名失败：${e && e.code ? e.code : 'error'}`);
    }
    return Object.keys(dotenv.parse(buf));
}

/**
 * 子进程环境：父环境去掉全部 SDH_*（不分大小写）与 STRIPPED_ENV_KEYS，再显式设置本实例的值；路径一律正斜杠。
 * envFileKeys = 被启动的 server.js 的 .env 里的全部键名：白名单（LINE_ENV_WHITELIST）、启动器显式设值的键、extraEnv 里的键之外，一律置空串（挡住 dotenv 把 .env 里的值带回子进程）。
 */
function buildChildEnv(parentEnv, { instance, dbFile, dataDir, port, jwtSecret }, extraEnv, envFileKeys) {
    const env = {};
    for (const k of Object.keys(parentEnv)) {
        if (parentEnv[k] === undefined) continue;
        const up = upperAscii(k);
        if (up.startsWith('SDH_') || STRIPPED_ENV_KEYS.includes(up)) continue;
        env[k] = parentEnv[k];
    }
    for (const k of Object.keys(extraEnv || {})) {
        for (const k2 of Object.keys(env)) { if (upperAscii(k2) === upperAscii(k)) delete env[k2]; }
        env[k] = extraEnv[k];
    }
    Object.assign(env, {
        SDH_INSTANCE: instance,
        SDH_DB_FILE: fwd(dbFile),
        SDH_DATA_DIR: fwd(dataDir),
        SDH_EXTERNAL: 'stub',
        SDH_BACKGROUND_JOBS: 'off',
        JWT_SECRET: jwtSecret,
        PORT: String(port),
    });
    // 剔除之后显式置空串（不是不设）：server.js 顶部 dotenv 会读本检出的 .env，而 dotenv 不覆盖进程里已存在的键（空串也算存在），
    //   所以只有「存在且为空」才挡得住 .env 把这三个键带回子进程。消费方对空串的处理：WEBHOOK_SECRET 为空 → webhook 入口拒绝；SYS_TEST_HOOKS 只认 === '1'；DB_ENCRYPTION_KEY 隔离模式下被忽略。
    for (const k of EMPTIED_ENV_KEYS) env[k] = '';
    // .env 白名单：.env 里的其余键一律置空串（已存在同名键 —— 不分大小写 —— 就改它的值，不新增大小写变体）
    const keepUpper = new Set([...ENV_FILE_WHITELIST_UPPER, ...LAUNCHER_EXPLICIT_UPPER, ...Object.keys(extraEnv || {}).map(upperAscii)]);
    for (const k of envFileKeys || []) {
        const up = upperAscii(k);
        if (keepUpper.has(up)) continue;
        const existing = Object.keys(env).find((x) => upperAscii(x) === up);
        if (existing !== undefined && SYSTEM_ENV_KEYS_UPPER.includes(up)) continue;   // 系统键且父环境已有：保留父值（见 SYSTEM_ENV_KEYS_UPPER）
        env[existing === undefined ? k : existing] = '';
    }
    return env;
}

// ---------------------------------------------------------------- 数据根 / 清单 / 删除

function lstatOrNull(p) { return common.lstatOrNull(p); }

/** 在 os.tmpdir() 下独占建 sdh-test-<hex>/（mkdirSync 非递归：已存在即失败），返回绝对路径 */
function makeDataRoot() {
    for (let i = 0; i < 5; i += 1) {
        const dir = path.join(os.tmpdir(), DIR_PREFIX + randHex(5));
        try { fs.mkdirSync(dir); return dir; } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    }
    throw new TestInstanceError('TI_DATA_ROOT_FAILED', '独占创建数据根目录连续 5 次撞名');
}

function writeFileExclusive(file, text) { fs.writeFileSync(file, text, { flag: 'wx' }); }

/** 原子替换清单：先写同目录临时文件再 rename（读者要么读到旧版要么读到新版，不会读到半截） */
function replaceManifest(dataDir, manifest) {
    const final = path.join(dataDir, MANIFEST_FILE);
    const tmp = path.join(dataDir, `${MANIFEST_FILE}.tmp-${randHex(4)}`);
    fs.writeFileSync(tmp, JSON.stringify(manifest), { flag: 'wx' });
    try { fs.renameSync(tmp, final); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* 尽力 */ } throw e; }
}

/** 删数据根：deleteTreeNoFollow 删光内容，再 rmdir 根，lstat 确认。返回 null（成功）或问题文字 */
function removeDataRoot(dataDir) {
    try {
        if (lstatOrNull(dataDir) === null) return null;
        const st = fs.lstatSync(dataDir);
        if (st.isSymbolicLink() || !st.isDirectory()) return `${dataDir} 不是普通目录（链接或文件），拒绝删除`;
        // 根自己也核 realpath = 父目录真实路径 + 自己的名字（Windows 不分大小写）：根若经任何重解析点指到别处（lstat 认不出的类型），拒绝删除
        const realRoot = fs.realpathSync.native(dataDir);
        const expectRoot = path.join(fs.realpathSync.native(path.dirname(dataDir)), path.basename(dataDir));
        if (realRoot.toLowerCase() !== expectRoot.toLowerCase()) return `${dataDir} 的真实路径（${realRoot}）不是 父目录真实路径 + 自身名字（${expectRoot}），拒绝删除`;
        common.deleteTreeNoFollow(realRoot, []);
        fs.rmdirSync(dataDir);
        if (lstatOrNull(dataDir) !== null) return `删除后 ${dataDir} 仍然存在`;
        return null;
    } catch (e) {
        return `删除 ${dataDir} 失败：${e && e.message}`;
    }
}

// ---------------------------------------------------------------- 资源复制与引用检查

/**
 * 每个资源里「库中引用该目录下文件」的表——**从 scripts/lines/line-new.js 的 ATTACHMENT_SOURCES 派生**（线开单时的附件缺失检查用的是同一份清单，不再各存一份而漂移）。
 * kind：rel = 列值是相对资源目录（base 之下）的路径；abs-basename = 列值是绝对路径，只核基名在复制后的目录里；json-stored-name = 列值是 JSON，取其 stored_name。
 * task_pool.file_path（旧版单文件附件，status=ARCHIVED 时文件已被移到 archive 目录，见 server.js 归档处）按 status 拆成两条：非 ARCHIVED 对 uploads 核，ARCHIVED 对 archive 核（与 line-new.js 的 task_pool 判据同口径）。
 */
const SOURCE_ROOT_TO_RESOURCE = Object.freeze({ uploads: 'uploads', inspection: 'private', periodic: 'periodic-results', reconcile: 'it-reconcile', archive: 'archive' });
const SOURCE_KIND_TO_REF_KIND = Object.freeze({ plain: 'rel', json_stored_name: 'json-stored-name', periodic_abs: 'abs-basename' });
const TASK_POOL_ARCHIVED_SQL = "UPPER(COALESCE(status, '')) = 'ARCHIVED'";
const TASK_POOL_NOT_ARCHIVED_SQL = "UPPER(COALESCE(status, '')) <> 'ARCHIVED'";
function deriveResourceReferences(sources) {
    const out = { uploads: [], archive: [], private: [], 'periodic-results': [], 'it-reconcile': [] };
    for (const s of sources) {
        const and = (extra) => (s.where ? `${s.where} AND ${extra}` : extra);
        if (s.kind === 'task_pool') {
            out.uploads.push({ table: s.table, column: s.column, kind: 'rel', where: and(TASK_POOL_NOT_ARCHIVED_SQL) });
            out.archive.push({ table: s.table, column: s.column, kind: 'rel', where: and(TASK_POOL_ARCHIVED_SQL) });
            continue;
        }
        const res = SOURCE_ROOT_TO_RESOURCE[s.root];
        const kind = SOURCE_KIND_TO_REF_KIND[s.kind];
        if (!res || !kind) throw new Error(`内部错误：ATTACHMENT_SOURCES 里有无法映射的项 ${s.table}（root=${s.root} kind=${s.kind}）`);
        const ref = { table: s.table, column: s.column, kind };
        if (s.where) ref.where = s.where;
        if (s.root === 'inspection') ref.base = 'it-inspection-sheets';   // 巡检照片在 private/it-inspection-sheets 下
        out[res].push(ref);
    }
    return Object.freeze(out);
}
const RESOURCE_REFERENCES = deriveResourceReferences(ATTACHMENT_SOURCES);
/** 查不了的部分必须明说，不得静默跳过 */
const RESOURCE_UNCHECKED = Object.freeze({
    archive: '未建引用检查：archive 目录里除 task_pool.file_path（status=ARCHIVED 的旧版单文件附件）以外的文件（/api/docs 按目录扫描的文档）没有对应的引用表',
    private: '未建引用检查：private 目录下 it-inspection-sheets 以外的内容（若有）没有对应的引用表',
    uploads: null,
    'periodic-results': null,
    'it-reconcile': null,
});

function openReadonly(file) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(e) : resolve(db)));
    });
}
const dbAll = (db, sql, params) => new Promise((resolve, reject) => db.all(sql, params || [], (e, rows) => (e ? reject(e) : resolve(rows))));
const dbClose = (db) => new Promise((resolve) => db.close(() => resolve()));

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** 引用值 → 复制后目录里的绝对路径；null = 值不可解析（视为缺失，原因另给） */
function refTargetPath(ref, value, resourceDir) {
    if (ref.kind === 'abs-basename') {
        const base = path.win32.basename(String(value));
        return base === '' ? null : path.join(resourceDir, base);
    }
    let rel = String(value);
    if (ref.kind === 'json-stored-name') {
        let meta = null;
        try { meta = JSON.parse(rel); } catch (_) { return null; }
        if (!meta || typeof meta.stored_name !== 'string' || meta.stored_name === '') return null;
        rel = meta.stored_name;
    }
    if (ref.base) rel = `${ref.base}/${rel}`;
    const full = path.resolve(resourceDir, rel);
    const relBack = path.relative(path.resolve(resourceDir), full);
    if (relBack === '' || relBack === '..' || relBack.startsWith('..' + path.sep) || path.isAbsolute(relBack)) return null;
    return full;
}

/**
 * 开始前的存在性检查：读**目标库**（刚建好的隔离副本，只读打开）里引用所选资源的表，逐行核对复制后的目录里文件是否存在。
 * 返回 { missing: [{ resource, table, column, rowId, ref }]（最多 MISSING_LIST_CAP 条）, missingTotal, checked: [{ resource, table, column, rows, missing, tableAbsent }], unchecked: [{ resource, reason }] }。
 */
async function checkResourceReferences(dbPath, dataDir, resources) {
    const out = { missing: [], missingTotal: 0, checked: [], unchecked: [] };
    if (resources.length === 0) return out;
    const targets = targetResourceDirs(dataDir);
    const db = await openReadonly(dbPath);
    try {
        for (const res of resources) {
            const dir = targets[res];
            for (const ref of RESOURCE_REFERENCES[res]) {
                const exists = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [ref.table]);
                if (exists.length === 0) { out.checked.push({ resource: res, table: ref.table, column: ref.column, rows: 0, missing: 0, tableAbsent: true }); continue; }
                const rows = await dbAll(db, `SELECT rowid AS rid, ${quoteIdent(ref.column)} AS v FROM ${quoteIdent(ref.table)}${ref.where ? ` WHERE ${ref.where}` : ''}`);
                let miss = 0;
                let counted = 0;
                for (const r of rows) {
                    if (r.v === null || r.v === undefined || r.v === '') continue;
                    counted += 1;
                    const target = refTargetPath(ref, r.v, dir);
                    const present = target !== null && lstatOrNull(target) !== null;
                    if (present) continue;
                    miss += 1;
                    out.missingTotal += 1;
                    if (out.missing.length < MISSING_LIST_CAP) out.missing.push({ resource: res, table: ref.table, column: ref.column, rowId: r.rid, ref: String(r.v).slice(0, 200) });
                }
                out.checked.push({ resource: res, table: ref.table, column: ref.column, rows: counted, missing: miss, tableAbsent: false });
            }
            if (RESOURCE_UNCHECKED[res]) out.unchecked.push({ resource: res, reason: RESOURCE_UNCHECKED[res] });
        }
    } finally {
        await dbClose(db);
    }
    return out;
}

/** 复制所选资源（copyTreeNoFollow：不跟随链接，来源有链接即拒绝）；来源目录不存在 → 建空目录并记 sourceMissing */
function copyResources(resources, sourceDirs, dataDir) {
    const targets = targetResourceDirs(dataDir);
    const summary = [];
    for (const res of resources) {
        const src = sourceDirs[res];
        if (typeof src !== 'string' || src === '') throw new TestInstanceError('TI_RESOURCE_SOURCE_UNKNOWN', `资源 ${res} 没有可用的来源目录`);
        const st = lstatOrNull(src);
        if (st === null) {
            fs.mkdirSync(targets[res], { recursive: true });
            summary.push({ name: res, source: src, target: targets[res], sourceMissing: true, files: 0, dirs: 0, bytes: 0 });
            continue;
        }
        const stats = common.copyTreeNoFollow(src, targets[res]);   // 链接 / 重解析点 / 非常规文件：抛 LineError（LINE_LINK_REFUSED / LINE_UNSAFE_PATH / LINE_COPY_FAILED）
        summary.push({ name: res, source: src, target: targets[res], sourceMissing: false, files: stats.files, dirs: stats.dirs, bytes: stats.bytes });
    }
    return summary;
}

// ---------------------------------------------------------------- 子进程

function logSlice(logFile, fromOffset) {
    try {
        const buf = fs.readFileSync(logFile);
        return buf.subarray(Math.min(fromOffset, buf.length)).toString('utf8');
    } catch (_) { return ''; }
}
function tailLines(text, n) { return String(text).split(/\r?\n/).filter((l) => l !== '').slice(-n).join('\n'); }

const liveInstances = new Set();
let exitHookInstalled = false;
function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // 进程退出（正常退出 / process.exit / 未捕获异常）时尽力同步终止仍在跑的服务；数据根留给 sweepStaleTestInstances。
    //   测试进程被强杀时 exit 事件不触发，由 Windows 作业对象（spawn 非 detached）连带结束服务。
    process.on('exit', () => {
        for (const rec of liveInstances) {
            try { if (rec.child.exitCode === null && rec.child.signalCode === null) rec.child.kill(); } catch (_) { /* 尽力 */ }
        }
    });
}

function spawnServer(ctx, port, attempt) {
    const logOffset = (() => { try { return fs.statSync(ctx.logFile).size; } catch (_) { return 0; } })();
    const env = buildChildEnv(process.env, { instance: ctx.instance, dbFile: ctx.dbPath, dataDir: ctx.dataDir, port, jwtSecret: ctx.jwtSecret }, ctx.extraEnv, ctx.envFileKeys);
    const logFd = fs.openSync(ctx.logFile, 'a');
    let child;
    try {
        child = spawn(process.execPath, [...ctx.nodeArgs, ctx.serverJs], { cwd: WBS_DIR, env, stdio: ['ignore', logFd, logFd], detached: false, windowsHide: true });
    } finally {
        fs.closeSync(logFd);
    }
    const rec = { child, pid: child.pid, port, attempt, logOffset, exited: false, exitCode: null, signalCode: null, spawnError: null };
    rec.exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => { rec.exited = true; rec.exitCode = code; rec.signalCode = signal; resolve(); });
        child.once('error', (e) => { rec.spawnError = e; if (!child.pid) { rec.exited = true; resolve(); } });
    });
    return rec;
}

async function waitExit(rec, ms) {
    if (rec.exited) return true;
    // 截止计时器必须在赢了竞速之后清掉：留着一个没清的 8000ms 定时器会让事件循环再多活 8 秒（S3b 修复批 1 实测：stop() 177 毫秒完成，但自然结束的脚本要到这个定时器到点才退出）
    let timer = null;
    await Promise.race([rec.exitPromise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
    return rec.exited;
}

/**
 * 终止等待的截止（毫秒）。生产默认值 TERMINATE_WAIT_DEFAULT_MS = 8000，不得改。
 * `_hooks.terminateWaitMs` 是**只供自检的注入接缝**（S3b 修复批 2a）：套件在辅助进程里把它设成长截止（如 30 秒）后，「遗留的截止计时器」（waitExit 赢了竞速却没清计时器）
 * 会让进程多活到截止点，与正常的百毫秒量级差出两个数量级，判定就不必依赖 3 秒这类对机器负载敏感的墙钟阈值。生产代码从不写它；自检另有用例证明默认值仍是 8000。
 */
const TERMINATE_WAIT_DEFAULT_MS = 8000;
const _hooks = { terminateWaitMs: TERMINATE_WAIT_DEFAULT_MS };

/** 终止自己起的子进程：先按句柄终止进程树（Node 未认定退出时 PID 被句柄钉住），等退出；返回 { exited, notes } */
async function terminateChild(rec) {
    const notes = [];
    if (rec.exited) return { exited: true, notes };
    if (rec.child.exitCode === null && rec.child.signalCode === null && Number.isSafeInteger(rec.pid)) {
        try { if (!procLib.killTree(rec.pid)) notes.push('taskkill /T 报告失败，改用句柄终止'); } catch (e) { notes.push(`taskkill /T 异常：${e && e.message}`); }
    }
    if (!(await waitExit(rec, _hooks.terminateWaitMs))) {
        try { rec.child.kill(); } catch (_) { /* 下面按是否退出判定 */ }
        await waitExit(rec, _hooks.terminateWaitMs);
    }
    return { exited: rec.exited, notes };
}

// ---------------------------------------------------------------- 就绪

async function getJson(port, urlPath) {
    return procLib.httpGetJson(port, urlPath, 3000);
}

/**
 * 等 /api/version 的身份与模式；返回 { ok } | { exited } | { mismatch, version } | { timeout }。
 * 回答了但 instance 不是本次身份 → 立即判冒名（不继续等）。
 */
async function waitIdentity(rec, ctx, deadline) {
    for (;;) {
        if (rec.exited) return { exited: true };
        const r = await getJson(rec.port, VERSION_PATH);
        if (r.kind === 'ok' && r.status === 200) {
            // 不需要再检查 r.json 的形态：line-proc.js 的 httpGetJson 只在解析结果是非空普通对象时才返回 kind 'ok'（scripts/lines/line-proc.js:242 `json !== null && typeof json === 'object' && !Array.isArray(json)`），
            //   正文是 null / [] / "str" / 非 JSON 一律是 kind 'badbody'（:243），落到下面「继续等」的分支（占着端口的服务回这类正文时，本次子进程会因 EADDRINUSE 退出，走换端口重试）。
            //   套件 F10d 用「200 + 正文 null」的替身守着这条契约。
            const v = r.json;
            if (v.instance === ctx.instance && v.mode === 'isolated') return { ok: true, version: v };
            return { mismatch: true, version: { instance: v.instance === undefined ? null : v.instance, mode: v.mode === undefined ? null : v.mode } };
        }
        if (Date.now() >= deadline) return { timeout: true };
        await sleep(POLL_MS);
    }
}

/**
 * 「全部未就绪的模块都已是终态」时返回这些模块名，否则返回 []：想等的模块里凡未就绪的，每一个都必须已经报告了「不会自愈的终态码」（ready === false 且码是字符串、不在 NON_TERMINAL_CODES 里）。
 * 只要还有一个未就绪模块的码是 NOT_READY / LEDGER_NOT_READY（还在初始化）或根本没有码，就返回 []——不能提前结束（12-R M1：否则 core 已报 SQLITE_BUSY、it_ledger 还在 LEDGER_NOT_READY 时被截断，
 * classifyStartupRace 看到非竞态码就拒绝重试，稍后本来能正常完成的启动直接失败）。全部就绪也返回 []（那条路径由调用方先判 ok）。
 */
function terminalModules(modules, wanted) {
    if (!modules) return [];
    const names = wanted === 'all' ? Object.keys(modules) : wanted;
    const unready = names.filter((n) => !(modules[n] && modules[n].ready === true));
    if (unready.length === 0) return [];
    const isTerminal = (n) => !!modules[n] && modules[n].ready === false && typeof modules[n].code === 'string' && !NON_TERMINAL_CODES.includes(modules[n].code);
    return unready.every(isTerminal) ? unready : [];
}

/**
 * 等 /api/health/ready 里 wanted 模块（'all' = 响应里的全部）都 ready；返回 { ok, modules } | { exited } | { timeout, modules } | { terminal: [name], modules } | { noEndpoint } | { unknown: [name] }。
 * **全部未就绪模块**都报告了终态码（INIT_FAILED / LEDGER_UNAVAILABLE / LEDGER_DRAINING 等，不会自愈；见 terminalModules）并且这个集合持续 TERMINAL_STABLE_MS 不变 → 提前结束（terminal），不干等满期限；
 * 交给调用方判是否属于启动期竞态而重试。只要还有一个未就绪模块没有终态，就继续等（到它就绪 / 也变终态 / 期限到）。
 */
async function waitModules(rec, wanted, deadline) {
    let last = null;
    let terminalSince = null;
    let terminalKey = null;
    for (;;) {
        if (rec.exited) return { exited: true, modules: last };
        const r = await getJson(rec.port, HEALTH_PATH);
        if (r.kind === 'ok' && r.status === 404) return { noEndpoint: true };
        if (r.kind === 'ok' && r.json && r.json.modules && typeof r.json.modules === 'object') {
            last = r.json.modules;
            const names = wanted === 'all' ? Object.keys(last) : wanted;
            const unknown = names.filter((n) => !Object.prototype.hasOwnProperty.call(last, n));
            if (unknown.length) return { unknown, modules: last };
            if (names.length > 0 && names.every((n) => last[n] && last[n].ready === true)) return { ok: true, modules: last };
            const term = terminalModules(last, wanted);
            const key = term.map((n) => `${n}:${last[n].code}`).join(',');
            if (term.length === 0) { terminalSince = null; terminalKey = null; }
            else if (key !== terminalKey) { terminalSince = Date.now(); terminalKey = key; }
            else if (Date.now() - terminalSince >= TERMINAL_STABLE_MS) return { terminal: term, modules: last };
        }
        if (Date.now() >= deadline) return { timeout: true, modules: last };
        await sleep(POLL_MS);
    }
}

function unreadyList(modules, wanted) {
    if (!modules) return [];
    const names = wanted === 'all' ? Object.keys(modules) : wanted;
    return names.filter((n) => !(modules[n] && modules[n].ready === true)).map((n) => ({ name: n, code: modules[n] && typeof modules[n].code === 'string' ? modules[n].code : 'NO_REPORT' }));
}

// ---------------------------------------------------------------- 启动

let launcherStartTime = null;
function getLauncherStartTime() {
    if (launcherStartTime === null) launcherStartTime = procLib.getStartTime(process.pid);
    return launcherStartTime;
}

/**
 * 服务日志里的竞态证据（纯函数；只返回数字 / 布尔，不留日志原文）：
 *   busyCount —— 含 SQLITE_BUSY / database is locked、且**不含「不影响启动」**的行数（代码作者已声明含「不影响启动」的 BUSY 不影响就绪，不能当作就绪失败的证据）；
 *   crashBusy —— 日志尾（最后 CRASH_TAIL_LINES 个非空行）里是否有**同一行**同时含 Uncaught Exception 与 SQLITE_BUSY（真实 #122 崩溃行：`Uncaught Exception: [Error: SQLITE_BUSY: database is locked]`；
 *                分开在两行、或崩溃是别的错误而另一行恰好有 BUSY，都不算）。
 */
function scanRaceEvidence(fullLog) {
    const lines = String(fullLog).split(/\r?\n/);
    const busyCount = lines.filter((l) => BUSY_LINE_RE.test(l) && !BUSY_HARMLESS_RE.test(l)).length;
    const tail = lines.filter((l) => l !== '').slice(-CRASH_TAIL_LINES);
    const crashBusy = tail.some((l) => /Uncaught Exception/.test(l) && /SQLITE_BUSY/.test(l));
    return { busyCount, crashBusy };
}

/**
 * 这次失败是不是「启动期 SQLITE_BUSY 竞态」（见头注释 startupRaceRetries）。返回 null（不是，直接失败）或 { form, codes, busyCount }。
 * 证据来自 fail() 在删数据根之前对**完整**服务日志的扫描（scanRaceEvidence → e.busyCount / e.crashBusy）；失败收口没做干净（e.leftover / e.cleanupNotes）一律不重试。
 * 就绪失败形态：未就绪模块的码必须**全部**属于 RACE_MODULE_CODES，并且有证据：码里有 SQLITE_BUSY（core 直接带 sqlite 的 code，不写日志）本身就是证据；INIT_FAILED / LEDGER_UNAVAILABLE 另要求日志证据。
 */
function classifyStartupRace(e) {
    if (!e || e.leftover || e.cleanupNotes) return null;
    if (e.code === 'TI_READY_TIMEOUT' && Array.isArray(e.unreadyModules) && e.unreadyModules.length > 0
        && e.unreadyModules.every((m) => m && RACE_MODULE_CODES.includes(m.code))) {
        const busyCode = e.unreadyModules.some((m) => m.code === 'SQLITE_BUSY');
        const busyLog = Number.isSafeInteger(e.busyCount) && e.busyCount > 0;
        if (busyCode || busyLog) return { form: '就绪失败', codes: Array.from(new Set(e.unreadyModules.map((m) => m.code))).sort().join('/'), busyCount: Number.isSafeInteger(e.busyCount) ? e.busyCount : 0 };
    }
    if (e.code === 'TI_SERVER_EXITED' && e.crashBusy === true) return { form: '服务崩溃退出', codes: 'TI_SERVER_EXITED', busyCount: e.busyCount || 0 };
    return null;
}

async function startTestInstance(rawOptions) {
    const options = rawOptions === undefined ? {} : rawOptions;
    procLib.assertSupportedPlatform();
    const opt = validateOptions(options);
    const source = resolveSource(options);
    const envFileKeys = readEnvFileKeyNames(opt.serverJs);   // 只取键名（见 readEnvFileKeyNames）
    for (let retries = 0; ; retries += 1) {
        try {
            const handle = await startOnce(opt, source, envFileKeys);
            handle.startupRaceRetries = retries;
            return handle;
        } catch (e) {
            const race = classifyStartupRace(e);
            if (race === null || retries >= opt.startupRaceRetries) throw e;
            // 上一次的进程与数据根已由 startOnce 的失败收口收掉（classifyStartupRace 已确认没有残留）；下一轮从头重建
            process.stderr.write(`STARTUP_RACE 启动期 SQLITE_BUSY 竞态（${race.form}；失败码 ${race.codes}；日志里 BUSY 证据 ${race.busyCount} 条）：第 ${retries + 1}/${opt.startupRaceRetries} 次重试\n`);
        }
    }
}

async function startOnce(opt, source, envFileKeys) {
    const instance = `test-${randHex(5)}`;
    if (!TEST_NAME_RE.test(instance)) throw new TestInstanceError('TI_INTERNAL', `生成的实例身份不合法：${instance}`);
    const jwtSecret = randHex(32);
    const redactSecrets = [jwtSecret];
    if (typeof source.sourceEncryptionKey === 'string') redactSecrets.push(source.sourceEncryptionKey);
    const redact = common.makeRedactor(redactSecrets);

    // 来源库必须存在（只做 stat，不打开）：给出可操作的错误，而不是让 VACUUM INTO 报晦涩的 SQLite 错误
    let srcStat = null;
    try { srcStat = fs.statSync(source.sourceDbPath); } catch (_) { /* 下面统一报 */ }
    if (!srcStat || !srcStat.isFile()) throw new TestInstanceError('TI_SOURCE_MISSING', `来源库不存在或不是普通文件：${source.sourceDbPath}`);

    const dataDir = makeDataRoot();
    const ctx = {
        instance, jwtSecret, dataDir, dbPath: path.join(dataDir, 'instance.db'), logFile: path.join(dataDir, SERVER_LOG_FILE),
        nodeArgs: opt.nodeArgs, extraEnv: opt.extraEnv, serverJs: opt.serverJs, envFileKeys,
    };
    const state = { rec: null };
    const fail = async (err) => {
        // 失败收口：先收进程，再删数据根；任何一步没做到都把现场路径写进错误，不静默
        const e = err instanceof Error ? err : new Error(String(err));
        let tail = '';
        const notes = [];
        if (state.rec) {
            const fullLog = redact(logSlice(ctx.logFile, 0));
            tail = tailLines(fullLog, LOG_TAIL_LINES);
            // 启动期竞态的证据必须在删数据根之前取（scanRaceEvidence：完整日志里不含「不影响启动」的 BUSY 行数；日志尾同一行是否同时有 Uncaught Exception 与 SQLITE_BUSY）。只存数字 / 布尔，不存日志原文
            const ev = scanRaceEvidence(fullLog);
            e.busyCount = ev.busyCount;
            e.crashBusy = ev.crashBusy;
            const t = await terminateChild(state.rec);
            notes.push(...t.notes);
            if (!t.exited) notes.push(`服务进程 ${state.rec.pid} 没有退出（现场保留）`);
            else liveInstances.delete(state.rec);
        }
        let leftover = null;
        if (!state.rec || state.rec.exited) leftover = removeDataRoot(dataDir);
        else leftover = `服务进程仍在，数据根保留：${dataDir}`;
        if (!e.logTail && tail) e.logTail = tail;
        if (leftover) { e.leftover = leftover; e.dataDir = dataDir; e.message = `${e.message}（清理未完成：${leftover}）`; }
        if (notes.length) e.cleanupNotes = notes;
        common.scrubError(e, redact);
        throw e;
    };

    try {
        installExitHook();
        // 1. 清单（服务端启动时校验：instance / parent / pid 正整数 / createdAt / dir 必填；附加字段不影响校验）
        const manifest = { instance, parent: source.parent, pid: process.pid, pidStartTime: getLauncherStartTime(), createdAt: new Date().toISOString(), dir: fwd(dataDir) };
        writeFileExclusive(path.join(dataDir, MANIFEST_FILE), JSON.stringify(manifest));

        // 2. 建库（VACUUM INTO 快照 + 隔离化；来源键只在 createIsolatedDb 的作用域里流转）
        const isolatedDb = await instanceDb.createIsolatedDb({
            sourceDbPath: source.sourceDbPath, targetDbPath: ctx.dbPath, instanceId: instance, parent: source.parent, from: 'test-instance', sourceEncryptionKey: source.sourceEncryptionKey,
        });

        // 3. 命名资源集合：复制 + 存在性检查
        const resources = copyResources(opt.resources, source.resourceDirs, dataDir);
        const missingResources = await checkResourceReferences(ctx.dbPath, dataDir, opt.resources);

        // 4. 启动（端口被抢占时换端口重试，有上限）+ 5. 就绪
        let attempt = 0;
        let ready = null;
        let versionBody = null;
        while (ready === null) {
            attempt += 1;
            if (attempt > opt.maxPortAttempts) {
                throw new TestInstanceError('TI_PORT_EXHAUSTED', `连续 ${opt.maxPortAttempts} 次启动都因端口被占用而失败`, { attempts: opt.maxPortAttempts });
            }
            const probe = await listenOnSafePort(require('http').createServer(), null);
            const port = probe.address().port;
            await new Promise((r) => probe.close(() => r()));
            if (typeof opt.hooks.beforeSpawn === 'function') await opt.hooks.beforeSpawn({ port, attempt, dataDir });
            const rec = spawnServer(ctx, port, attempt);
            state.rec = rec;
            liveInstances.add(rec);
            if (!rec.pid) {
                throw new TestInstanceError('TI_SPAWN_FAILED', `服务进程没能启动：${rec.spawnError ? (rec.spawnError.code || rec.spawnError.message) : '未知'}`);
            }
            let startTime = null;
            try { startTime = procLib.getStartTime(rec.pid); } catch (_) { startTime = null; }
            const deadline = Date.now() + opt.readyTimeoutMs;

            const idr = await waitIdentity(rec, ctx, deadline);
            if (idr.exited) {
                const text = logSlice(ctx.logFile, rec.logOffset);
                if (/EADDRINUSE/.test(text)) {
                    if (attempt >= opt.maxPortAttempts) {
                        throw new TestInstanceError('TI_PORT_EXHAUSTED', `连续 ${opt.maxPortAttempts} 次启动都因端口被占用而失败（最后一次端口 ${port}）`, { attempts: opt.maxPortAttempts, exitCode: rec.exitCode });
                    }
                    liveInstances.delete(rec);
                    state.rec = null;
                    continue;   // 端口被别的进程抢走：换端口重试
                }
                const why = rec.spawnError ? `spawn 错误 ${rec.spawnError.code || rec.spawnError.message}` : '服务进程提前退出';
                throw new TestInstanceError('TI_SERVER_EXITED', `${why}（退出码 ${rec.exitCode}，信号 ${rec.signalCode}），未到达就绪`, { exitCode: rec.exitCode, signal: rec.signalCode });
            }
            if (idr.mismatch) {
                // 应答的身份不是本次实例：该应答任何时候都不被采信。再看端口监听者是不是本次子进程——
                //   不是（端口被别的服务占着，它先回答了；本次子进程会因 EADDRINUSE 退出，只是还没跑到监听）→ 收掉本次子进程，在尝试上限内换端口重试（别人的服务毫发无损：只终止自己 spawn 的句柄）；
                //   是本次子进程却身份不符（冒名 / 配置错）→ 照旧失败。查不到监听者（netstat 失败）→ fail-closed，按身份不符失败。
                const listeners = procLib.portListeners(port);
                const mismatchMsg = `端口 ${port} 上应答的服务身份不是本次实例（实际 instance=${JSON.stringify(idr.version.instance)} mode=${JSON.stringify(idr.version.mode)}，期望 ${instance} / isolated）`;
                if (listeners !== null && !listeners.includes(rec.pid)) {
                    if (attempt >= opt.maxPortAttempts) {
                        throw new TestInstanceError('TI_PORT_EXHAUSTED', `连续 ${opt.maxPortAttempts} 次启动都因端口被别的服务占用而失败（最后一次端口 ${port}，占用者 PID [${listeners.join(',')}]，应答身份 ${JSON.stringify(idr.version.instance)}）`, { attempts: opt.maxPortAttempts, actual: idr.version });
                    }
                    const t = await terminateChild(rec);
                    if (!t.exited) throw new TestInstanceError('TI_IDENTITY_MISMATCH', `${mismatchMsg}；端口被别的进程占用，但本次子进程 ${rec.pid} 没能收掉，无法安全换端口重试`, { actual: idr.version, cleanupNotes: t.notes });
                    liveInstances.delete(rec);
                    state.rec = null;
                    continue;   // 端口被别人占：换端口重试
                }
                throw new TestInstanceError('TI_IDENTITY_MISMATCH', mismatchMsg, { actual: idr.version });
            }
            if (idr.timeout) throw new TestInstanceError('TI_READY_TIMEOUT', `等 ${VERSION_PATH} 身份超时（${opt.readyTimeoutMs}ms）`, { unreadyModules: [{ name: '(identity)', code: 'NO_ANSWER' }] });
            versionBody = idr.version;

            let modulesReport = null;
            if (opt.waitFor === 'ready') {
                const mr = await waitModules(rec, opt.modules, deadline);
                if (mr.exited) throw new TestInstanceError('TI_SERVER_EXITED', `服务进程在模块就绪前退出（退出码 ${rec.exitCode}，信号 ${rec.signalCode}）`, { exitCode: rec.exitCode, signal: rec.signalCode });
                if (mr.noEndpoint) throw new TestInstanceError('TI_NO_HEALTH_ENDPOINT', `${HEALTH_PATH} 返回 404：被测 server.js 没有汇总就绪接口`);
                if (mr.unknown) throw new TestInstanceError('TI_UNKNOWN_MODULE', `请求等待的模块不在 ${HEALTH_PATH} 的返回里：${mr.unknown.join('、')}（返回的模块：${Object.keys(mr.modules).join('、')}）`, { unknownModules: mr.unknown });
                if (mr.timeout || mr.terminal) {
                    const list = unreadyList(mr.modules, opt.modules);
                    const head = mr.terminal ? `有模块已报告不会自愈的终态错误，提前结束等待（${mr.terminal.map((n) => `${n}(${mr.modules[n].code})`).join('、')}）` : `等模块就绪超时（${opt.readyTimeoutMs}ms）`;
                    throw new TestInstanceError('TI_READY_TIMEOUT', `${head}；未就绪模块：${list.length ? list.map((x) => `${x.name}(${x.code})`).join('、') : '（没有取得 /api/health/ready 的应答）'}`, { unreadyModules: list, earlyEnd: !!mr.terminal });
                }
                modulesReport = mr.modules;
            }

            // 端口监听者必须恰好是本次子进程（防别的进程抢占后冒充应答）
            const listeners = procLib.portListeners(port);
            if (listeners === null) throw new TestInstanceError('TI_PORT_CHECK_FAILED', `查不到端口 ${port} 的监听者（netstat 失败）：无法确认应答来自本次子进程，按失败处理`);
            if (!(listeners.length === 1 && listeners[0] === rec.pid)) {
                throw new TestInstanceError('TI_PORT_HIJACKED', `端口 ${port} 的监听者是 [${listeners.join(',')}]，不是本次子进程 ${rec.pid}`, { listeners });
            }
            ready = { rec, port, startTime, modulesReport };
        }

        // 6. 清单追加 serverPid / serverStartTime（服务端只在启动时读清单，此时已读完；用原子替换，读者不会读到半截）
        const { rec, port, startTime, modulesReport } = ready;
        if (startTime) replaceManifest(dataDir, Object.assign({}, manifest, { serverPid: rec.pid, serverStartTime: startTime, port }));
        else throw new TestInstanceError('TI_PROC_IDENTITY_FAILED', `取不到服务进程 ${rec.pid} 的创建时间，无法写入可供遗留清理核对的身份`);

        let stopPromise = null;
        const handle = {
            baseUrl: `http://127.0.0.1:${port}`,
            port, instance, dbPath: ctx.dbPath, dataDir, jwtSecret, pid: rec.pid, startTime, parent: source.parent,
            version: versionBody, modules: modulesReport, missingResources, resources, isolatedDb,
            logFile: ctx.logFile,
            // stop()：并发调用共享同一次清理；失败（进程没退出 / 数据根删不掉）后清空缓存，下一次 stop() 从当前状态继续（进程已退出就直接重试删目录）；成功后缓存成功结果（幂等）。
            stop() {
                if (stopPromise === null) {
                    const run = (async () => {
                        // 先收进程（句柄终止），等它真的退出，再删数据根并 lstat 确认；任何一步没做到都抛错并保留现场路径，不静默
                        const t = await terminateChild(rec);
                        if (!t.exited) {
                            throw new TestInstanceError('TI_CLEANUP_FAILED', `停止未完成：服务进程 ${rec.pid} 没有退出，数据根保留：${dataDir}`, { dataDir, pid: rec.pid, cleanupNotes: t.notes });
                        }
                        liveInstances.delete(rec);
                        const left = removeDataRoot(dataDir);
                        if (left) throw new TestInstanceError('TI_CLEANUP_FAILED', `停止未完成：${left}`, { dataDir, pid: rec.pid });
                    })();
                    stopPromise = run;
                    run.then(() => {}, () => { if (stopPromise === run) stopPromise = null; });   // 失败：允许重试（返回给调用方的仍是 run 本身，拒绝由调用方处理）
                }
                return stopPromise;
            },
        };
        // 交给调用方之后，服务子进程不再维持调用方的事件循环（S3b 修复批 1，codex 13 H1）：脚本不调 stop() / process.exit() 自然结束时，进程能在有界时间内退出，
        //   退出时由上面 installExitHook 的 'exit' 钩子同步终止服务；test-env 的 syncExitCleanup 再等服务进程真的退出（procLib.isAlive，靠本函数仍持有的子进程句柄防 PID 复用）后删数据根，
        //   「PID + 创建时间」只在兜底的 killIfIdentity 里用（400 毫秒内还没退出才走）。stdio 是日志文件描述符（不是管道），所以子进程句柄是唯一的引用。
        try { rec.child.unref(); } catch (_) { /* 尽力：失败只意味着自然结束的脚本要自己调 stop() */ }
        return handle;
    } catch (e) {
        return fail(e);
    }
}

// ---------------------------------------------------------------- 遗留清理

/**
 * 只扫 tmpRoot（默认 os.tmpdir()）下名字匹配 sdh-test-* 的目录。保留 / 删除判定：
 *   - 不是真目录（链接 / 文件）→ 保留（NOT_A_DIRECTORY）；
 *   - 没有清单 / 清单损坏 / 字段不合法 / dir 与目录不符 → 保留并报告原因（MANIFEST_MISSING / MANIFEST_INVALID / MANIFEST_DIR_MISMATCH）；
 *   - 清单里可核对的进程身份 = serverPid + serverStartTime、pid + pidStartTime（启动器自己）；一个都没有 → 保留（NO_PROCESS_IDENTITY）；
 *   - 任一身份的「PID + 精确创建时间」仍匹配现场进程 → 保留（PROCESS_ALIVE）；查询失败 → 保留（IDENTITY_QUERY_FAILED）；
 *   - 全部身份都确认已不存在（dead）或 PID 已被复用（创建时间不符）→ 删除。
 * 返回 { scanned, removed, kept, failed }。
 */
async function sweepStaleTestInstances(rawOptions) {
    const options = rawOptions === undefined ? {} : rawOptions;
    procLib.assertSupportedPlatform();
    for (const k of Object.keys(options)) { if (k !== 'tmpRoot') throw new TestInstanceError('TI_BAD_OPTIONS', `未知选项 ${JSON.stringify(k)}`); }
    const tmpRoot = options.tmpRoot === undefined ? os.tmpdir() : options.tmpRoot;
    const out = { scanned: 0, removed: [], kept: [], failed: [] };
    let names;
    try { names = fs.readdirSync(tmpRoot); } catch (e) { throw new TestInstanceError('TI_SWEEP_FAILED', `读取 ${tmpRoot} 失败：${e && e.code ? e.code : e && e.message}`); }
    for (const name of names.sort()) {
        if (!SWEEP_DIR_RE.test(name)) continue;
        const dir = path.join(tmpRoot, name);
        out.scanned += 1;
        const keep = (reason) => out.kept.push({ dir, reason });
        let st;
        try { st = fs.lstatSync(dir); } catch (_) { continue; }
        if (st.isSymbolicLink() || !st.isDirectory()) { keep('NOT_A_DIRECTORY'); continue; }
        let manifest = null;
        let text;
        try { text = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'); } catch (e) { keep(e && e.code === 'ENOENT' ? 'MANIFEST_MISSING' : 'MANIFEST_UNREADABLE'); continue; }
        try { manifest = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { keep('MANIFEST_INVALID'); continue; }
        const isStr = (v) => typeof v === 'string' && v.trim() !== '';
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !isStr(manifest.instance) || !TEST_NAME_RE.test(manifest.instance) || !isStr(manifest.parent)
            || !Number.isSafeInteger(manifest.pid) || manifest.pid <= 0 || !isStr(manifest.createdAt) || !isStr(manifest.dir)) { keep('MANIFEST_INVALID'); continue; }
        let sameDir = false;
        try { sameDir = common.samePath(manifest.dir, dir); } catch (_) { sameDir = false; }
        if (!sameDir) { keep('MANIFEST_DIR_MISMATCH'); continue; }
        // 进程身份字段：整组缺失（undefined）才算「没有这个身份」；字段**存在但不合法**（serverPid 不是正整数 / 创建时间不是标准 ISO 串 / 只有一半）→ 清单不可信，保留（MANIFEST_INVALID），
        //   不能静默忽略：否则一个存活的服务可能因它的身份字段格式不对而被当成「没有身份」，目录被删而服务还在跑。
        const has = (k) => manifest[k] !== undefined;
        const validIso = (v) => typeof v === 'string' && ISO_RE.test(v);
        const serverPidOk = Number.isSafeInteger(manifest.serverPid) && manifest.serverPid > 0;
        if ((has('serverPid') || has('serverStartTime')) && !(serverPidOk && validIso(manifest.serverStartTime))) { keep('MANIFEST_INVALID'); continue; }
        if (has('pidStartTime') && !validIso(manifest.pidStartTime)) { keep('MANIFEST_INVALID'); continue; }
        const ids = [];
        if (has('serverPid')) ids.push({ role: 'server', pid: manifest.serverPid, start_time: manifest.serverStartTime });
        if (has('pidStartTime')) ids.push({ role: 'launcher', pid: manifest.pid, start_time: manifest.pidStartTime });
        if (ids.length === 0) { keep('NO_PROCESS_IDENTITY'); continue; }
        let aliveRole = null;
        let queryFailed = null;
        for (const id of ids) {
            let r;
            try { r = procLib.checkIdentity({ pid: id.pid, start_time: id.start_time }); } catch (e) { queryFailed = `${id.role}：${e && e.code ? e.code : 'error'}`; break; }
            if (r.state === 'match') { aliveRole = id.role; break; }
        }
        if (queryFailed) { keep(`IDENTITY_QUERY_FAILED(${queryFailed})`); continue; }
        if (aliveRole) { keep(`PROCESS_ALIVE(${aliveRole})`); continue; }
        const left = removeDataRoot(dir);
        if (left) out.failed.push({ dir, error: left }); else out.removed.push(dir);
    }
    return out;
}

module.exports = {
    startTestInstance, sweepStaleTestInstances, TestInstanceError,
    RESOURCE_NAMES, RESOURCE_ALIASES, STRIPPED_ENV_KEYS, EMPTIED_ENV_KEYS, DIR_PREFIX, MANIFEST_FILE, HEALTH_PATH, VERSION_PATH, DEFAULT_READY_TIMEOUT_MS, DEFAULT_MAX_PORT_ATTEMPTS, DEFAULT_STARTUP_RACE_RETRIES, RESOURCE_REFERENCES,
    _internals: { planDefaultSource, buildChildEnv, readEnvFileKeyNames, normalResourceDirs, targetResourceDirs, refTargetPath, checkResourceReferences, removeDataRoot, unreadyList, classifyStartupRace, scanRaceEvidence, deriveResourceReferences, terminalModules, _hooks, TERMINATE_WAIT_DEFAULT_MS },
};
