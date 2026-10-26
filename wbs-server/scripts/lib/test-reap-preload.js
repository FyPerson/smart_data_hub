/**
 * 测试预加载片段（#106 S3c 修复批 1 · 第 2 节）：node --require 在加载任何被测模块之前装上，套件进程自己和所有辅助进程共用同一份。
 *
 * 一个文件做三件事（缺一不可，所以放在一起）：
 *   ① sqlite3 路径守卫：只放行私有根内的库。普通路径解析成绝对路径再 realpath 核；`file:` URI 解析出真实路径再核（authority 只接受空或 localhost、百分号解码、
 *      Windows 盘符前导斜杠）；内存库**只认** `''`、`':memory:'`、`'file::memory:'` 三个字面串（硬门：查询串里的 mode=memory 不再放行，`?mode=memory&mode=rwc` 之类按路径部分核）；**解析不了就拒绝**。
 *      覆盖 sqlite3.Database 与 sqlite3.cached.Database。拒绝发生在真正打开之前。
 *   ② `.env` 读取守卫：基名以 `.env` 开头的文件只许读私有根内的。覆盖 fs.readFileSync / fs.readFile / fs.promises.readFile（以及 openSync / open / promises.open / createReadStream）和 process.loadEnvFile，
 *      路径可以是字符串、Buffer、file: URL 对象（loadEnvFile 不给路径、给 undefined 或 null 时按 cwd 下的 .env 核）。拒绝发生在真正读取之前。
 *   ③ 包住启动器的 startTestInstance：句柄一返回就追加登记到登记文件（kind=instance，带 PID、精确创建时间、数据根）；登记失败 → 先 stop() 这个刚起的实例再抛错，不留孤儿；
 *      stop 也失败时条目仍留在回收器内存（登记前先进内存），登记失败记入 reaper.failures（删除闸门不放行）。外层 reaper.reapAll 重试回收**只对调用了 reapAll 的进程成立**；
 *      没调 reapAll 的辅助进程里留下的实例，靠启动器 spawn 的 detached: false 的作业对象随辅助进程结束（该保证由启动器承担，见下面 ③ 里的注释）。
 *
 * 配置（环境变量，由套件设置；子进程继承）：
 *   SDH_REAP_PRIV        私有根（必需）
 *   SDH_REAP_REGISTRY    登记文件（必需，套件先用 initRegistry 建好）
 *   SDH_REAP_OWNER       本进程登记时的归属（缺省 helper）
 *   SDH_REAP_LABEL       启动器句柄登记时的 label（缺省 batch；修复批 2 新增）
 *   SDH_REAP_VIOLATIONS  守卫违规记录文件（JSONL，可选；追加写）
 *   SDH_REAP_TI          启动器路径（可选；给了才包 startTestInstance）
 *   SDH_REAP_LIB         回收模块路径（缺省同目录 test-reap.js；自检变异用）
 * 导出（也挂在 globalThis.__sdhReapPreload 上，后加载的脚本可取）：{ reaper, config, violations(), probes(), opened(), withProbe(fn), parseSqliteTarget, envPathViolation }。
 * withProbe：守卫自检时临时把违规记到 probes 而不是 violations（套件末尾要求 violations 为空）。
 */
'use strict';

if (globalThis.__sdhReapPreload) {
    module.exports = globalThis.__sdhReapPreload;
} else {
    const fs = require('fs');
    const path = require('path');
    const { fileURLToPath } = require('url');

    const need = (k) => {
        const v = process.env[k];
        if (!v) throw new Error(`test-reap-preload：缺少环境变量 ${k}`);
        return v;
    };
    const PRIV = need('SDH_REAP_PRIV');
    const REGISTRY = need('SDH_REAP_REGISTRY');
    const OWNER = process.env.SDH_REAP_OWNER || 'helper';
    const VIOLATIONS_FILE = process.env.SDH_REAP_VIOLATIONS || null;
    const TI_PATH = process.env.SDH_REAP_TI || null;
    const LABEL = process.env.SDH_REAP_LABEL || 'batch';   // 启动器句柄的登记 label（缺省 'batch'，S3c 现有行为不变；别的套件可以用环境变量改）
    const reapLib = require(process.env.SDH_REAP_LIB || './test-reap');

    const fold = (p) => String(p).toLowerCase();
    const privReal = fs.realpathSync.native(PRIV);
    const insidePriv = (real) => fold(real).startsWith(fold(privReal) + path.sep);
    const realOf = (abs) => {
        try { return fs.realpathSync.native(abs); } catch (_) {
            try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch (_2) { return abs; }
        }
    };

    const violations = [];
    const probes = [];
    const opened = [];
    let probeDepth = 0;
    function violate(kind, target, message) {
        const rec = { kind, path: target };
        if (probeDepth > 0) probes.push(rec);
        else {
            violations.push(rec);
            if (VIOLATIONS_FILE) { try { fs.appendFileSync(VIOLATIONS_FILE, `${JSON.stringify(rec)}\n`); } catch (_) { /* 记录写失败也要抛错（下面 throw） */ } }
        }
        const err = new Error(`GUARD_TRIPPED: ${message}`);
        err.code = 'GUARD_TRIPPED';
        return err;
    }
    async function withProbe(fn) {
        probeDepth += 1;
        try { return await fn(); } finally { probeDepth -= 1; }
    }

    // ------------------------------------------------------------ ① sqlite3 路径守卫
    /** 解析 sqlite3.Database 的文件名 → { kind: 'memory' } | { kind: 'path', abs } | { kind: 'reject', why }。纯函数 */
    function parseSqliteTarget(file) {
        const reject = (why) => ({ kind: 'reject', why });
        if (typeof file !== 'string') return reject('文件名不是字符串，无法核对真实路径');
        // 内存库只认这三个字面串（硬门，不加智能放行）：其余 file: URI 一律按路径部分核真实路径，查询串（含 mode=memory）不参与任何放行判断
        if (file === '' || file === ':memory:' || file === 'file::memory:') return { kind: 'memory' };
        if (!file.startsWith('file:')) return { kind: 'path', abs: path.resolve(file) };
        const dec = (s) => decodeURIComponent(s);
        try {
            let rest = file.slice(5);
            const hash = rest.indexOf('#');
            if (hash >= 0) rest = rest.slice(0, hash);
            const q = rest.indexOf('?');
            if (q >= 0) rest = rest.slice(0, q);
            let p = rest;
            if (p.startsWith('//')) {
                const slash = p.indexOf('/', 2);
                const authority = slash < 0 ? p.slice(2) : p.slice(2, slash);
                if (authority !== '' && authority.toLowerCase() !== 'localhost') return reject('URI 的 authority 不是空或 localhost');
                p = slash < 0 ? '' : p.slice(slash);
            }
            p = dec(p);
            if (p === '') return reject('URI 路径为空');
            if (p.includes('\0')) return reject('URI 路径含 NUL');
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
            return { kind: 'path', abs: path.resolve(p) };
        } catch (e) {
            return reject(`URI 解析失败（${e && e.message}）`);
        }
    }
    const sqlite3 = require('sqlite3');
    /** 打开之前的核对（Database 与 cached.Database 共用）：解析不了 / 私有根之外 → 抛 GUARD_TRIPPED，不碰真实打开 */
    function checkSqliteOpen(file, rest) {
        const t = parseSqliteTarget(file);
        if (t.kind === 'reject') throw violate('db', String(file), `拒绝打开解析不了的库文件名（${t.why}）：${String(file).slice(0, 160)}`);
        if (t.kind === 'path') {
            opened.push({ file: t.abs, flags: typeof rest[0] === 'number' ? rest[0] : null });
            const real = realOf(t.abs);
            if (!insidePriv(real)) throw violate('db', t.abs, `试图打开私有根之外的库 ${t.abs}`);
        }
    }
    {
        const RealDatabase = sqlite3.Database;
        function GuardedDatabase(file, ...rest) {
            checkSqliteOpen(file, rest);
            return new RealDatabase(file, ...rest);
        }
        GuardedDatabase.prototype = RealDatabase.prototype;
        sqlite3.Database = GuardedDatabase;
    }
    // sqlite3.cached.Database 闭包里引用的是未包装的原始 Database，不经上面的包装：单独包住（预筛 v2 L2）
    if (sqlite3.cached && typeof sqlite3.cached.Database === 'function') {
        const realCached = sqlite3.cached.Database;
        sqlite3.cached.Database = function guardedCachedDatabase(file, ...rest) {
            checkSqliteOpen(file, rest);
            return realCached.call(this, file, ...rest);
        };
    }

    // ------------------------------------------------------------ ② .env 读取守卫
    /** 路径参数（字符串 / Buffer / file: URL 对象）若指向私有根外的 .env 开头文件 → { path }，否则 null。其他类型（fd 等）不管 */
    function envPathViolation(p) {
        let s = null;
        if (typeof p === 'string') s = p;
        else if (Buffer.isBuffer(p)) s = p.toString('utf8');
        else if (p && typeof p === 'object' && typeof p.href === 'string' && p.protocol === 'file:') { try { s = fileURLToPath(p); } catch (_) { return null; } }
        if (s === null) return null;
        if (!/^\.env/i.test(path.basename(s))) return null;
        const abs = path.resolve(s);
        if (insidePriv(realOf(abs))) return null;
        return { path: abs };
    }
    const wrapSync = (obj, name) => {
        const real = obj[name];
        if (typeof real !== 'function') return;
        obj[name] = function guardedEnvSync(p, ...rest) {
            const v = envPathViolation(p);
            if (v) throw violate('env', v.path, `试图读取私有根之外的 .env：${v.path}`);
            return real.call(this, p, ...rest);
        };
    };
    const wrapPromise = (obj, name) => {
        const real = obj[name];
        if (typeof real !== 'function') return;
        obj[name] = function guardedEnvPromise(p, ...rest) {
            const v = envPathViolation(p);
            if (v) return Promise.reject(violate('env', v.path, `试图读取私有根之外的 .env：${v.path}`));
            return real.call(this, p, ...rest);
        };
    };
    for (const n of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) wrapSync(fs, n);
    for (const n of ['readFile', 'open']) wrapPromise(fs.promises, n);
    // process.loadEnvFile(path?)：不经 fs 的 JS 包装直接读文件（预筛 v2 L2）。不给路径时读 cwd 下的 .env，所以按 '.env' 核。
    // 「不给路径」= undefined **或 null**（Node 只在 path != null 时才校验并使用传入的路径，null 与不传等价；预筛 v3 L2 / 14T-R2 M3），所以用 p == null 判
    if (typeof process.loadEnvFile === 'function') {
        const realLoad = process.loadEnvFile;
        process.loadEnvFile = function guardedLoadEnvFile(p, ...rest) {
            const v = envPathViolation(p == null ? '.env' : p);
            if (v) throw violate('env', v.path, `试图读取私有根之外的 .env：${v.path}`);
            return realLoad.call(this, p, ...rest);
        };
    }

    // ------------------------------------------------------------ ③ 启动器句柄的立即登记
    const reaper = reapLib.createReaper({ file: REGISTRY, owner: OWNER });
    if (TI_PATH) {
        const ti = require(TI_PATH);
        const orig = ti.startTestInstance;
        ti.startTestInstance = async function registeringStart(...a) {
            const h = await orig.apply(this, a);
            try {
                reaper.trackInstance(LABEL, h);   // 同一个延续里、句柄返回给调用方之前
            } catch (e) {
                violate('reg', String(h && h.pid), `实例登记失败：${e && e.message}`);
                // 先 stop() 这个刚起的实例再抛错，不留孤儿。stop 也失败时调用方拿不到 h：条目已由 trackInstance 在落盘之前放进了回收器内存（带 stop），
                // 不丢——登记失败已记入 reaper.failures，删除闸门不放行（修复批 2）。
                // 重试回收的前提：**本进程调用了 reaper.reapAll**（套件主进程在最终流程里调；它会重试 stop()、再按「PID + 创建时间」终止）。
                // 没有调用 reapAll 的辅助进程（例如 verify-test-batch-suite 的 batch-helper / 通用入口）里，内存条目没有重试的机会，进程一结束就丢；这时留下的实例只靠
                // 启动器 spawn 的 detached: false（test-instance.js:516；:502 的注释称作业对象会随父进程结束连带结束服务）收场——这条保证由启动器承担，本文件与 S3c 套件不验证它
                try { await h.stop(); } catch (se) { e.stopError = se && se.message ? se.message : String(se); }
                throw e;
            }
            return h;
        };
    }

    const api = {
        reaper, parseSqliteTarget, envPathViolation, withProbe,
        config: { priv: PRIV, privReal, registry: REGISTRY, owner: OWNER, label: LABEL, violationsFile: VIOLATIONS_FILE },
        violations: () => violations.slice(),
        probes: () => probes.slice(),
        opened: () => opened.slice(),
    };
    globalThis.__sdhReapPreload = api;
    module.exports = api;
}
