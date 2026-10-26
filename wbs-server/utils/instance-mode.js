/**
 * 运行模式判定（#106 多线并行改造 · S1a · W1 隔离实例运行契约）
 *
 * 方案 SSOT = docs/local/多线并行/多线并行改造_方案_20261015_v1.3.md 的 W1 小节（判定表四条互斥）。
 *
 * 两个入口：
 *   - resolveInstanceConfig({ env, checkoutDir, readFile })  纯函数，便于单测；不碰真实 process.env / fs。
 *   - getInstanceConfig()                                     进程级单例：首次调用用真实 process.env 与 fs 算一次并缓存。
 *
 * 判定（自上而下，命中第一条即按该条处理）：
 *   1. 不设 SDH_INSTANCE：有检出身份（wbs-server/.sdh-instance）→ 线服务；没有 → 正常模式。
 *   2. SDH_INSTANCE 等于检出身份                       → 线服务。
 *   3. SDH_INSTANCE 以 test- 开头                       → 派生测试实例：SDH_DATA_DIR 必填，其下必须有实例清单 sdh-instance.json，
 *                                                          清单 instance = SDH_INSTANCE；父检出身份 = 检出身份，没有则记 main；
 *                                                          数据根（真实路径）须在系统临时目录之内，且与检出目录互不包含。
 *   4. 其他一切                                          → 拒绝。
 * 隔离类变量（SDH_DB_FILE / SDH_DATA_DIR / SDH_EXTERNAL / SDH_BACKGROUND_JOBS）在正常模式出现任一个 → 拒绝，
 * 生产因此无法被误配成「静默停发通知」。
 *
 * 正常模式的取值与改造前逐字相同：dbFile = <wbs-server>/task_pool.db，uploads / archive / periodic-results 都在 wbs-server 下，
 * external = real，background = on，it-ledger 的两个可选注入目录为 null（server.js 不传，保持模块自带默认路径）。
 *
 * 本文件不 require sqlite3（库内身份核对在 instance-db.js），保证 collab-submit-helpers 之类的工具模块可以安全引用。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const ENV_FILE = '.env';
const IDENTITY_FILE = '.sdh-instance';
const MANIFEST_FILE = 'sdh-instance.json';
const ISOLATION_VARS = Object.freeze(['SDH_DB_FILE', 'SDH_DATA_DIR', 'SDH_EXTERNAL', 'SDH_BACKGROUND_JOBS']);
const TEST_PREFIX = 'test-';
const RESERVED_MAIN = 'main';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TEST_NAME_RE = /^test-[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/;

function refuse(code, message) {
    return Object.freeze({ refuse: true, code, message });
}

/** 取环境变量：未设置、空串、纯空白都视为「不设」（Windows 下空值本来就等于未设置）。 */
function envValue(env, name) {
    const raw = env ? env[name] : undefined;
    if (raw === undefined || raw === null) return undefined;
    const s = String(raw).trim();
    return s === '' ? undefined : s;
}

function isEnoent(e) {
    return !!(e && e.code === 'ENOENT');
}

/**
 * 解析运行模式。
 * @param {{ env: object, checkoutDir: string, readFile?: (p: string) => string, realpath?: (p: string) => string, platform?: string, tmpdir?: string }} opts
 *   platform 默认 process.platform，仅供单测模拟 win32 / 非 win32 的环境变量名大小写语义。
 *   tmpdir 默认 os.tmpdir()，测试实例的数据根必须位于其内（单测可注入）。
 *   readFile(p) 返回 utf8 文本；文件不存在须抛出带 code === 'ENOENT' 的错误（fs.readFileSync 原生行为）。
 *   realpath(p) 解析真实路径（默认 fs.realpathSync.native），用于测试实例的路径比较（清单 dir 与 SDH_DATA_DIR 同目录、数据根在临时目录内、
 *   与检出目录互不包含）；解析失败回退 path.resolve。
 * @returns {object} 配置对象，或 { refuse: true, code, message }
 *
 * 环境变量来源 = <checkoutDir>/.env 里的 SDH_* 与传入 env 合并：进程变量优先；win32 上 .env 内大小写不同的变体先出现者保留——
 * 复刻 dotenv 往 process.env 写入时「键已存在就跳过」的优先级。（.env 内**完全同名**的重复键由 dotenv.parse 自身处理，保留最后一个值，
 * 与真实 dotenv 加载结果一致。）
 * 这样判定结果与「在 dotenv 加载之前还是之后首次调用」无关——collab-submit-helpers 等工具模块在 server.js 加载 dotenv 之前就会触发首次判定。
 */
function resolveInstanceConfig(opts) {
    const procEnv = (opts && opts.env) || {};
    const checkoutDir = opts && opts.checkoutDir;
    const readFile = (opts && opts.readFile) || ((p) => fs.readFileSync(p, 'utf8'));
    const realpath = (opts && opts.realpath) || ((p) => fs.realpathSync.native(p));
    if (!checkoutDir || typeof checkoutDir !== 'string') {
        return refuse('CHECKOUT_DIR_REQUIRED', '内部错误：缺少 checkoutDir');
    }

    // ---- 环境：.env 里的 SDH_* 并入，进程变量优先；.env 不存在 / 读不了 / 解析不了都按空处理（与 dotenv 一致：静默忽略）----
    //   键名大小写：win32 上环境变量名不分大小写（process.env.sdh_external 与 SDH_EXTERNAL 是同一个变量），所以 win32 上进程变量与 .env 的键
    //   统一转大写再判定（只对 ASCII 字母转大写：避免 `ſdh_` 这类 Unicode 字符经 toUpperCase 变成 SDH_）；其他平台保持大小写敏感（与该平台
    //   process.env 语义一致）。win32 进程里不可能同时存在同名不同大小写的两个变量。
    //   优先级复刻 dotenv 写 process.env 的语义——「键已存在就跳过」：先放进程变量（归一后），再按 dotenv.parse 的键遍历顺序补入 .env 变量，
    //   仅当归一后的键尚不存在时才写入。所以进程变量优先；.env 内同名不同大小写的变体，win32 上先出现者保留（dotenv 也是先写先得）。
    //   「已存在」按键是否存在判断，与值是否为空串无关（.env 里 `SDH_INSTANCE=` 写成空串也会挡住后面的 `sdh_instance=…`，dotenv 同样如此）。
    const foldCase = ((opts && opts.platform) || process.platform) === 'win32';
    const normKey = (k) => (foldCase ? k.replace(/[a-z]+/g, (s) => s.toUpperCase()) : k);
    const env = {};
    for (const k of Object.keys(procEnv)) { if (procEnv[k] !== undefined) env[normKey(k)] = procEnv[k]; }
    try {
        const parsed = dotenv.parse(String(readFile(path.join(checkoutDir, ENV_FILE))));
        for (const k of Object.keys(parsed)) {
            const nk = normKey(k);
            if (nk.startsWith('SDH_') && !Object.prototype.hasOwnProperty.call(env, nk)) env[nk] = parsed[k];
        }
    } catch (_) { /* .env 读不了 / 解析不了：按空处理（与 dotenv 静默忽略一致） */ }

    // ---- 检出身份 ----
    let checkoutIdentity = null;
    let rawIdentity = null;
    try {
        rawIdentity = readFile(path.join(checkoutDir, IDENTITY_FILE));
    } catch (e) {
        if (!isEnoent(e)) {
            return refuse('IDENTITY_FILE_UNREADABLE', `无法读取实例标识文件 ${IDENTITY_FILE}：${e && e.message}`);
        }
    }
    if (rawIdentity !== null && rawIdentity !== undefined) {
        checkoutIdentity = String(rawIdentity).replace(/^﻿/, '').trim();
        if (checkoutIdentity === '') {
            return refuse('IDENTITY_FILE_EMPTY', `实例标识文件 ${IDENTITY_FILE} 存在但内容为空；拒绝按正常模式启动`);
        }
        const lower = checkoutIdentity.toLowerCase();
        if (!NAME_RE.test(checkoutIdentity) || lower === RESERVED_MAIN || lower.startsWith(TEST_PREFIX)) {
            return refuse('INVALID_CHECKOUT_IDENTITY',
                `实例标识文件 ${IDENTITY_FILE} 的线名不合法（须匹配 ${NAME_RE}，且不得为 main 或以 test- 开头）：${JSON.stringify(checkoutIdentity)}`);
        }
    }

    const sdhInstance = envValue(env, 'SDH_INSTANCE');
    const presentIsolationVars = ISOLATION_VARS.filter((n) => envValue(env, n) !== undefined);

    // ---- 判定表 ----
    let kind;
    let instance;
    if (sdhInstance === undefined) {
        if (checkoutIdentity === null) {
            // 正常模式
            if (presentIsolationVars.length > 0) {
                return refuse('ISOLATION_VAR_IN_NORMAL_MODE',
                    `正常模式（无 .sdh-instance、未设 SDH_INSTANCE）下不允许出现隔离类变量：${presentIsolationVars.join('、')}`);
            }
            return Object.freeze({
                mode: 'normal',
                kind: 'normal',
                instance: null,
                checkoutIdentity: null,
                parentIdentity: null,
                checkoutDir,
                dbFile: path.join(checkoutDir, 'task_pool.db'),
                dataRoot: checkoutDir,
                uploadDir: path.join(checkoutDir, 'uploads'),
                archiveDir: path.join(checkoutDir, 'archive'),
                periodicResultsDir: path.join(checkoutDir, 'periodic-results'),
                itReconcileDir: null,
                itInspectionSheetDir: null,
                external: 'real',
                background: 'on',
            });
        }
        kind = 'line';
        instance = checkoutIdentity;
    } else if (checkoutIdentity !== null && sdhInstance === checkoutIdentity) {
        kind = 'line';
        instance = checkoutIdentity;
    } else if (sdhInstance.startsWith(TEST_PREFIX)) {
        if (!TEST_NAME_RE.test(sdhInstance)) {
            return refuse('INVALID_INSTANCE_NAME', `测试实例身份不合法（须匹配 ${TEST_NAME_RE}）：${JSON.stringify(sdhInstance)}`);
        }
        kind = 'test';
        instance = sdhInstance;
    } else if (checkoutIdentity !== null) {
        return refuse('INSTANCE_IMPERSONATION',
            `SDH_INSTANCE=${JSON.stringify(sdhInstance)} 与本检出身份 ${JSON.stringify(checkoutIdentity)} 不符且不是 test- 测试实例，拒绝启动`);
    } else {
        return refuse('INSTANCE_WITHOUT_CHECKOUT_IDENTITY',
            `本检出没有 ${IDENTITY_FILE}（主工作区），SDH_INSTANCE 只允许 test- 开头的测试实例，收到 ${JSON.stringify(sdhInstance)}`);
    }

    // ---- 隔离模式默认值与变量校验 ----
    const externalRaw = envValue(env, 'SDH_EXTERNAL');
    if (externalRaw !== undefined && externalRaw !== 'stub') {
        return refuse('EXTERNAL_NOT_ALLOWED',
            `隔离模式下 SDH_EXTERNAL 只接受 stub（真实外发只在主工作区），收到 ${JSON.stringify(externalRaw)}`);
    }
    const backgroundRaw = envValue(env, 'SDH_BACKGROUND_JOBS');
    if (backgroundRaw !== undefined && backgroundRaw !== 'off' && backgroundRaw !== 'on') {
        return refuse('BACKGROUND_JOBS_INVALID', `SDH_BACKGROUND_JOBS 只接受 off / on，收到 ${JSON.stringify(backgroundRaw)}`);
    }

    const dbFileRaw = envValue(env, 'SDH_DB_FILE');
    if (dbFileRaw !== undefined && !path.isAbsolute(dbFileRaw)) {
        return refuse('PATH_NOT_ABSOLUTE', `SDH_DB_FILE 必须是绝对路径：${JSON.stringify(dbFileRaw)}`);
    }
    const dataDirRaw = envValue(env, 'SDH_DATA_DIR');
    if (dataDirRaw !== undefined && !path.isAbsolute(dataDirRaw)) {
        return refuse('PATH_NOT_ABSOLUTE', `SDH_DATA_DIR 必须是绝对路径：${JSON.stringify(dataDirRaw)}`);
    }

    let parentIdentity = null;
    if (kind === 'test') {
        if (dataDirRaw === undefined) {
            return refuse('TEST_DATA_DIR_REQUIRED', '测试实例必须设置 SDH_DATA_DIR（带实例清单的专属临时目录）');
        }
        // 测试实例的数据根必须是专属临时目录：真实路径位于系统临时目录之内，且与检出目录互不包含（线服务的数据根不受此限）。
        //   否则一份伪造的清单就能把数据根指向主工作区 wbs-server 或其上级，让测试实例的 uploads / archive 等写进检出目录。
        const realOrResolve = (p) => {
            let r;
            try { r = realpath(p); } catch (_) { r = path.resolve(p); }
            return process.platform === 'win32' ? r.toLowerCase() : r;
        };
        const containsOrEquals = (parentDir, childDir) => {
            const rel = path.relative(parentDir, childDir);
            // 只有完整的 `..` 路径段才算越出父目录；名字以 `..` 开头的普通子目录（如 `..data`）仍在父目录之内
            return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
        };
        const realData = realOrResolve(dataDirRaw);
        const realCheckout = realOrResolve(checkoutDir);
        if (containsOrEquals(realData, realCheckout) || containsOrEquals(realCheckout, realData)) {
            return refuse('TEST_DATA_DIR_OVERLAPS_CHECKOUT',
                `测试实例的数据根 ${JSON.stringify(dataDirRaw)} 与检出目录 ${JSON.stringify(checkoutDir)} 相同或互相包含`);
        }
        const tmpRoot = realOrResolve((opts && opts.tmpdir) || os.tmpdir());
        if (!containsOrEquals(tmpRoot, realData) || realData === tmpRoot) {
            return refuse('TEST_DATA_DIR_NOT_TEMP',
                `测试实例的数据根 ${JSON.stringify(dataDirRaw)} 必须是系统临时目录 ${JSON.stringify(tmpRoot)} 之内的专属子目录`);
        }
        let manifestText;
        try {
            manifestText = readFile(path.join(dataDirRaw, MANIFEST_FILE));
        } catch (e) {
            if (isEnoent(e)) {
                return refuse('TEST_MANIFEST_MISSING', `测试实例的数据目录缺少实例清单 ${MANIFEST_FILE}：${dataDirRaw}`);
            }
            return refuse('TEST_MANIFEST_UNREADABLE', `无法读取实例清单 ${MANIFEST_FILE}：${e && e.message}`);
        }
        let manifest;
        try {
            manifest = JSON.parse(String(manifestText).replace(/^﻿/, ''));
        } catch (e) {
            return refuse('TEST_MANIFEST_INVALID', `实例清单 ${MANIFEST_FILE} 不是合法 JSON：${e && e.message}`);
        }
        const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
            || !isNonEmptyString(manifest.instance) || !isNonEmptyString(manifest.parent)
            || !Number.isInteger(manifest.pid) || manifest.pid <= 0
            || !isNonEmptyString(manifest.createdAt) || !isNonEmptyString(manifest.dir)) {
            return refuse('TEST_MANIFEST_INVALID',
                `实例清单 ${MANIFEST_FILE} 缺字段或类型不对（须含 instance、parent、pid、createdAt、dir）`);
        }
        if (manifest.instance !== sdhInstance) {
            return refuse('TEST_MANIFEST_MISMATCH',
                `实例清单的 instance=${JSON.stringify(manifest.instance)} 与 SDH_INSTANCE=${JSON.stringify(sdhInstance)} 不符`);
        }
        // 清单记录的目录必须就是 SDH_DATA_DIR（防拿别的实例的清单配上另一个目录）。两边先解析真实路径再比较，规避 8.3 短名 / 大小写差异。
        const samePath = (a, b) => {
            const norm = (p) => {
                let r;
                try { r = realpath(p); } catch (_) { r = path.resolve(p); }
                return process.platform === 'win32' ? r.toLowerCase() : r;
            };
            return norm(a) === norm(b);
        };
        if (!samePath(manifest.dir, dataDirRaw)) {
            return refuse('TEST_MANIFEST_DIR_MISMATCH',
                `实例清单的 dir=${JSON.stringify(manifest.dir)} 与 SDH_DATA_DIR=${JSON.stringify(dataDirRaw)} 不是同一目录`);
        }
        parentIdentity = checkoutIdentity !== null ? checkoutIdentity : RESERVED_MAIN;
    }

    const dataRoot = dataDirRaw !== undefined ? path.resolve(dataDirRaw) : checkoutDir;
    return Object.freeze({
        mode: 'isolated',
        kind,
        instance,
        checkoutIdentity,
        parentIdentity,
        checkoutDir,
        dbFile: dbFileRaw !== undefined ? path.resolve(dbFileRaw) : path.join(checkoutDir, 'task_pool.db'),
        dataRoot,
        uploadDir: path.join(dataRoot, 'uploads'),
        archiveDir: path.join(dataRoot, 'archive'),
        periodicResultsDir: path.join(dataRoot, 'periodic-results'),
        itReconcileDir: path.join(dataRoot, 'it-reconcile'),
        itInspectionSheetDir: path.join(dataRoot, 'private', 'it-inspection-sheets'),
        external: 'stub',
        background: backgroundRaw === 'on' ? 'on' : 'off',
    });
}

// ---- 进程级单例 ----
let cached = null;

/** 首次调用用真实 process.env 与 fs 算一次并缓存；之后所有模块读同一份结果。 */
function getInstanceConfig() {
    if (cached === null) {
        cached = resolveInstanceConfig({
            env: process.env,
            checkoutDir: path.resolve(__dirname, '..'),
            readFile: (p) => fs.readFileSync(p, 'utf8'),
        });
    }
    return cached;
}

/** 仅供验证脚本在同一进程内换环境变量重算（生产代码不得调用）。 */
function _resetInstanceConfigForTest() {
    cached = null;
}

module.exports = {
    IDENTITY_FILE,
    MANIFEST_FILE,
    ISOLATION_VARS,
    resolveInstanceConfig,
    getInstanceConfig,
    _resetInstanceConfigForTest,
};
