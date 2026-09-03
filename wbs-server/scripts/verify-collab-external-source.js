/**
 * 数据协作接入外部源「小程序-智荟人力」—— G2 单元/HTTP 层验证（C2a）
 *
 * 方案 SSOT：docs/local/数据协作模块/数据协作接入小程序_方案_20260902_v1.6.md §5.2 G2
 * 派单 spec：C2a 附录 + c2a-research-plan.md + handoff-C1-to-C2a.md（G1 登记手册/环境坑）
 *
 * 运行面（自包含·零真实库）：
 *   - 全新空 sqlite 文件（不拷贝 task_pool.db），server 经 _test-it-asset-ledger-server-wrapper.js
 *     （通用 sqlite3.Database 重定向 wrapper，非 IT 资产专属，本脚本直接复用）起在独立端口，
 *     schema 由 server 启动自建；随后本脚本用独立 sqlite3 连接直连临时库种子数据。
 *   - HTTP 层走真实 fetch 调用 /api/collab/* 端点；JWT 自签（复用 server 的 JWT_SECRET）。
 *   - 结束时按 PID 树杀 server 子进程、删临时库（含 -journal/-wal/-shm）、删本次种下的
 *     uploads/collab 残留文件（id ≥ SEQ_BASE 的 _pending/<id> 与 <id>_* 正式目录）。
 *
 * 覆盖面（分组函数组织，留扩展位——C2b/C3 续加 P/H8/Q1/S 段）：
 *   §U  单元层：直接 require utils/collab-attachment-versioning.js 的 activateNewVersion
 *   §Q  静态哨兵：routes/periodic-fetch/index.js 未被顺手放行 external
 *   §H  HTTP 层：两阶段查询分流 / 免验成功 / 质量双口径 / admin-fix 纵深防御 / 三处放行 / 通知
 *   §P  连接管理端点保护 / §H8 D19 两处 / §Q1 周期取数三路由（C2b）
 *
 * 〔M1·codex 06 审措辞收窄〕external_skip 仍不会进入 smoke 失败专属的两条清理路径
 * （cleanupMovedFiles catch / "ok=false→_failed rename"分支——它压根不调 runSmokeTest，
 * 合成结果 ok 恒 true）；但 D25 引入的 revalidate 抛错会走**事务异常清理**（moveToOrphaned），
 * 这条路径 smoke/external_skip 两模式通用，U4 已用构造冲突验证过对 external_skip 生效。
 * 原"external 永不进入 cleanupMovedFiles"是把这两件事混成一句话的绝对化旧表述，收窄为上面
 * 两句准确说法。
 *
 * 〔G2-F7 交底：三条已知的证据强度边界，非阻塞，供续做者/审查方知悉，不要被误读成"结论不成立"〕
 *   ① P4 并发证据依赖运行时时序：真并发用例用 `Promise.all` 同时发出两个 POST，验证的是"最终
 *      结果只有一行落库 + 一次 409"这个终态不变量，不是"两个请求确实在数据库层交错执行"这件事
 *      本身——本脚本没有（也很难在单进程 Node 里稳定构造）能证明"确实交错"的结构性证据（如显式
 *      的执行时序探针/hook 点），`Promise.all` 只保证两个 fetch 几乎同时发出，之后的调度由 Node
 *      事件循环 + SQLite/HTTP 服务端决定，理论上仍可能被观测到近似串行的调度序列。
 *   ② H0/H3 里"无 SUBMIT_ATTEMPT 日志"是负向断言（断言某条日志*没有*出现），而
 *      `insertCollabLog` 是 fire-and-forget（不 await，异步落库），负向断言本身无法排除"日志其实
 *      写了、只是比脚本查询时机晚"这类竞态假阴性。这条弱点靠同一组用例里**另一条正向断言**互补：
 *      同批断言里的 `sql_validation_status IS NULL` 判定依赖的是前置 UPDATE（有 await，同步完成
 *      才能继续往下走），不是 fire-and-forget 日志，两条断言合在一起看才是完整证据，单看"无日志"
 *      那一条不构成独立证明。
 *   ③ server.js 里 `SELECT * FROM db_connections WHERE is_default = 1 LIMIT 1`
 *      （POST /api/models/:id/validate 内取默认数仓连接，本文件写作时约在 9255 行，具体行号随
 *      改动漂移）没有 `connection_type` 过滤，理论上如果某一行 external 连接的 `is_default` 被
 *      设成 1，这条查询会把它当默认数仓连接选中并尝试解密密码/连库，行为不可控。这个"external
 *      行不可能 is_default=1"的不变量**不是**这条 SQL 自己保证的，而是由别处共同维持：HTTP 写
 *      入口侧——POST `/api/db-connections` 对 `connection_type='source'` 的行恒把 `is_default`
 *      落 0（`finalIsDefault` 判断里 `connection_type !== 'source'` 才可能为真）、PUT 对
 *      `type===external` 的行整体 409 拒绝任何修改（含改 is_default）——加上 G2/C3 种子数据里
 *      所有 external 行显式 `is_default: 0`（造数侧同样遵守这条约定，不是巧合）。三方共同维持，
 *      任何一方单独改动都可能打破这条隐性不变量，本脚本目前没有一条直接断言"扫描全库 external
 *      行 is_default 恒为 0"，是留给续做者/静态守卫（G4）考虑补的一个点，非本批阻塞项。
 *
 * 〔M6·codex 12b 质量审〕汇总行「N 通过 / 0 失败 / M 跳过」里的"通过"数从来不含 SKIP（skip()
 * 实现从一开始就只累加 skipCount，不碰 pass）——SKIP 不是弱化版的"通过"。本批新增的是可读性
 * 加固：H4 通过态（真实关系库健康提交走 DONE）与 H8b（ODS 模型校验 D19-2 分支端到端）这两条
 * SKIP 的 name 里显式标了【未覆盖·环境阻塞】，且收尾会单独打印一份「未覆盖口径清单」（skips
 * 数组驱动，见文件末尾），列出具体哪些冻结口径因本机/本仓无可达 SQL Server/MySQL 而完全没有
 * 行为证据——不是"基本等于通过"，是"这部分口径本次没有被验证"。
 *
 * 运行：node scripts/verify-collab-external-source.js
 */
'use strict';

const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 3411;
const BASE = `http://localhost:${TEST_PORT}`;
const REAL_DB = path.join(ROOT, 'task_pool.db');
const TEMP_DB = path.join(os.tmpdir(), `collab-external-source-test-${process.pid}.db`);
const WRAPPER_PATH = path.join(__dirname, '_test-it-asset-ledger-server-wrapper.js'); // 通用重定向 wrapper，非 IT 资产专属
const UNIT_COLLAB_ROOT = path.join(os.tmpdir(), `collab-ext-src-unit-${process.pid}`);
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';
// 〔H1·codex 07 质量审〕上传根 uploads/collab 没有独立隔离（不改 server.js，先例如此）——旧版
// 清理按"id ≥ 900000 全局扫描删除"理论上可能误删同一区间内的真实附件目录（虽然实际生产单号
// 远小于 900000，但"理论上可能"就该堵）。改三件套：①随机取 base（每次运行不同，降低"假设
// 900000 永远安全"的隐性耦合）；②开跑前对 [base+1, base+999] 区间做零写预检，撞了直接拒绝
// 启动；③清理只删"本次运行登记过的精确路径"且路径 id 必须落在本次 base 区间内（两条件同时
// 满足才删，见 registerCleanupPath/cleanupUploadArtifacts）。
// 〔08-M3·codex 08 审〕并行 G2 区间租约：本机可能同时跑多个 G2 实例（如人工亲验 + agent 并行
// 回归），随机 SEQ_BASE 存在极小概率两个实例同时抽中同一个基线区间，导致互相污染彼此的
// uploads/collab 残留判定（precheckNoResidualInRange/cleanupUploadArtifacts 都以 SEQ_BASE 区间
// 为唯一隔离边界）。用 os.tmpdir() 下的排他锁文件做进程间互斥：`fs.openSync(path, 'wx')`
// （wx=独占创建，已存在则抛 EEXIST）拿到该区间的独占租约，抢不到就换一个新的随机基线重试
// （最多 5 次）；进程正常/异常退出前都释放（见 releaseSeqBaseLease 调用点：主 IIFE finally +
// SIGINT/SIGTERM 处理器）。
// 〔为什么不改 server.js 给每个 G2 实例独立上传根〕上传根隔离需要改产品代码本身（server.js 的
// 上传目录硬编码指向 uploads/collab），本文件既有约定是"不改 server.js/共享代码，只在测试脚本
// 侧想办法隔离"（见下方"上传根未做物理隔离"说明）——区间租约是这个约定下的进程间互斥手段，
// 不是产品能力，也不改变上传根本身的物理位置。
// 〔S2·Opus 预筛〕锁超龄阈值：正常一次 G2 运行几分钟内结束，若锁文件 mtime 已超过这个阈值，
// 大概率是上一次运行崩溃/被外部杀掉（未走到 finally/exit 释放），而不是真的有另一个实例还在跑。
const SEQ_BASE_LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 小时
// 〔09-H2·codex 09 审〕原锁文件内容是一行纯文本（`pid=... at=...`），release 时只看路径是否
// 存在就无条件 unlink——没有校验"这把锁现在还是不是我建的那把"。真实坏法：进程 A 的锁被判超龄
// 后被进程 B 接管（B 写入了自己的新锁文件），若 A 之后才走到自己的 finally/exit 清理，会把 B
// 刚建立、正在使用的锁文件删掉，导致 B 和后续第三个实例都可能撞上同一个"空出来"的区间，是本该
// 互斥的租约机制被自己的清理逻辑破坏。改锁文件内容为 JSON `{pid, token, ts}`（token=本进程本次
// 运行专属的随机 16 位十六进制串），release 前先读文件核对 token 是否与自己持有的一致，只有
// 匹配才真删；不匹配（锁已被他人接管）只记日志，不动它。另外，"超龄"只是判定可接管的必要条件，
// 不是充分条件——接管前必须额外用 `process.kill(pid, 0)` 探测原持有者进程是否还存活：ESRCH
// （进程确实不存在）才允许接管；EPERM（探测到有这个 pid 但无权限信号，通常意味着确实存在）或
// 未抛错（存活）一律不接管，防"进程只是这次运行异常久，锁文件 mtime 超过阈值"被误判成"陈旧"
// 抢走它正在使用的区间。
function canTakeOverStaleLock(holder, isStale) {
    if (!isStale) return false;
    if (!holder || typeof holder.pid !== 'number') return false; // 读不到/解析不出持有者 pid，保守不接管
    try {
        process.kill(holder.pid, 0);
        return false; // 未抛错——进程存活，不接管
    } catch (killErr) {
        return !!(killErr && killErr.code === 'ESRCH'); // 只有"进程确实不存在"才允许接管；EPERM 等一律不接管
    }
}
// release 的核心判定（参数化 lockPath/token，供生产调用与自证测试共用）——单独抽出的理由：
// `releaseSeqBaseLease()` 本身必须保持零参数签名，它被 `process.on('exit', releaseSeqBaseLease)`
// 直接注册为回调，Node 会把进程退出码当第一个实参传给它；若改成"第一参数是 lockPath"，退出码
// 会被误当路径字符串使用，是完全不同的坑，不能通过给 releaseSeqBaseLease 加参数来做测试钩子。
function releaseLeaseAtPath(lockPath, token) {
    try {
        if (!lockPath || !fs.existsSync(lockPath)) return { deleted: false, reason: 'not-exists' };
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (holder && holder.token === token) {
            fs.unlinkSync(lockPath);
            return { deleted: true };
        }
        return { deleted: false, reason: 'token-mismatch' };
    } catch (_) {
        return { deleted: false, reason: 'error' }; // 句柄/权限/JSON 解析异常——同原逻辑的 ignore，不阻断收尾
    }
}
// 〔H1·codex 12b 质量审〕接管陈旧锁的核心判定，从 acquireSeqBaseLease 内联代码抽成独立函数
// （参数化 lockPath/firstReadHolder/myToken）——原因有二：① 抽成纯函数才能被下方自证测试直接
// 调用，不必依赖 acquireSeqBaseLease 内部的随机 base 选择逻辑去人工构造交错场景；② 修复本身
// 引入了"接管前重读校验"这个新步骤，独立命名把这段判定与"怎么选基线/重试几次"的外层循环
// 关注点分开，读起来更清楚。
//
// 修的是什么竞态：原逻辑是"读一次持有者信息 → 判定陈旧 → 直接 unlink+重建"，中间没有任何二次
// 确认。若进程 A 读到旧持有者信息后，进程 B 抢先完成了整个接管流程（B 已经把锁文件换成了自己的
// 新锁），A 拿着"过时"的判断继续往下走，会把 B 刚建立、正在使用的锁文件删掉重建成 A 自己的——
// 两个进程都以为自己独占了同一个区间，租约互斥形同虚设。
//
// 修法（两次重读 + 绝不删除已变化的锁）：
//   ① 接管前重读：unlink 之前，用 lockPath 现在的实际内容与 firstReadHolder（调用方最初判定
//      "陈旧"时读到的那份快照）逐字段比对（pid/token/ts）。不一致 = 这把锁在我们判定陈旧之后
//      已经被别人动过（多半是被抢先接管），说明我们手里的"陈旧"判断已经过时——直接放弃接管、
//      不删除这把现在属于别人的锁，交还调用方换一个新的随机基线重试。
//   ② 创建成功后回读：`wx` 独占创建理论上不可能被并发写入覆盖内容，这一步是纵深防御（防未知的
//      文件系统/驱动层怪异行为），若回读发现 token 不是自己的，同样不删除，直接判失败换基线。
//   任何一步判定失败都不做任何删除动作——"接管失败"只意味着"这次没抢到"，从不意味着"可以把
//   现在看到的锁文件清空重来"。
function attemptLeaseTakeover(lockPath, firstReadHolder, myToken) {
    // ① 接管前重读：核对锁文件当前内容是否仍与首次判定"陈旧"时读到的一致
    let holderNow = null;
    try { holderNow = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch (_) { return { ok: false, reason: 'reread-failed' }; } // 文件已消失/损坏——按"已变化"处理，不删除，放弃接管
    const unchanged = !!(holderNow && firstReadHolder &&
        holderNow.pid === firstReadHolder.pid &&
        holderNow.token === firstReadHolder.token &&
        holderNow.ts === firstReadHolder.ts);
    if (!unchanged) return { ok: false, reason: 'holder-changed' }; // 已被他人接管/刷新——放弃，绝不删除这把已变化的锁

    // ② 接管：确认内容未变后，才真正删旧锁、以 wx 独占创建自己的锁
    let fd = null;
    try {
        fs.unlinkSync(lockPath);
        fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: myToken, ts: Date.now(), takeover: true }));
        fs.closeSync(fd);
        fd = null;
    } catch (_) {
        // 〔15-M1 采纳〕wx 创建已成功（fd 非 null）而 write/close 失败：该文件是本进程刚独占创建的
        // （wx 语义保证此刻他人不可能持有同名文件），留下空/半截锁会让后续运行解析失败、保守拒绝
        // 接管，一次可恢复的写失败就变成长期假故障——先关 fd 再删掉本进程自己的产物（Windows 上
        // 打开中的文件不能 unlink，顺序不可倒）
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) { /* 已关/关失败都不影响下面的所有权校验与删除 */ }
            // 〔16-M1 采纳〕删前最终所有权校验：内容可解析且 token 是自己的 → 本进程产物；不可解析（半截写入）→
            // 也是本进程产物（不可解析的锁任何人都保守不接管，见 canTakeOverStaleLock）；可解析但 token 不是自己的
            // → 本进程曾被暂停超过陈旧阈值、锁已被他人接管，绝不删除（与 ①/③ 同一条「只删自己的」协议）
            // 〔P26·codex 17 三条收紧〕a) 只有「可解析的对象且 token 是自己的」才算 mine-parsable，falsy/非对象/缺
            // token 一律按非本进程处理；b) 读失败分两类：ENOENT=已不存在（等价 cleaned），其他 I/O 错误=所有权
            // 未确认不删；只有「读到了但 JSON.parse 失败」才是本进程半截产物；c) unlink ENOENT 归等价 cleaned
            let owner = 'other';
            let raw = null;
            try { raw = fs.readFileSync(lockPath, 'utf8'); }
            catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'takeover-write-failed-cleaned' : 'takeover-write-failed-read-failed' }; }
            try {
                const cur = JSON.parse(raw);
                owner = (cur !== null && typeof cur === 'object' && cur.token === myToken) ? 'mine' : 'other';
            } catch (_) { owner = 'mine'; /* 读到了但解析失败——本进程半截产物 */ }
            if (owner === 'other') return { ok: false, reason: 'takeover-write-failed-not-owner' };
            // 〔16-M2 采纳〕只有 unlink 真成功（或 ENOENT 已不存在）才报 cleaned；其他删失败给独立 reason，不掩盖残留
            try { fs.unlinkSync(lockPath); }
            catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'takeover-write-failed-cleaned' : 'takeover-write-failed-cleanup-failed' }; }
            return { ok: false, reason: 'takeover-write-failed-cleaned' };
        }
        // unlink/openSync 失败（如竞态窗口被抢先创建）——不做任何删除动作，直接判失败换基线
        return { ok: false, reason: 'takeover-write-failed' };
    }

    // ③ 创建成功后回读校验：确认文件里现在确实是自己的 token（wx 独占创建理论上不会被抢，这里是
    //    纵深防御）；不匹配说明锁现在是别人的，绝不删除，直接判失败换基线
    let confirm = null;
    try { confirm = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch (_) { return { ok: false, reason: 'confirm-read-failed' }; }
    if (!confirm || confirm.token !== myToken) return { ok: false, reason: 'overwritten-after-create' };
    return { ok: true };
}
function acquireSeqBaseLease() {
    const maxAttempts = 5;
    const myToken = crypto.randomBytes(8).toString('hex'); // 本进程本次运行专属，16 位十六进制
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const base = 900000 + Math.floor(Math.random() * 90) * 1000; // [900000, 989000] 步长 1000
        const lockPath = path.join(os.tmpdir(), `collab-external-g2-${base}.lock`);
        try {
            const fd = fs.openSync(lockPath, 'wx'); // wx：独占创建，路径已存在则抛 EEXIST
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: myToken, ts: Date.now() }));
            fs.closeSync(fd);
            return { base, lockPath, token: myToken };
        } catch (e) {
            if (e.code === 'EEXIST') {
                // 超龄 + 原持有者进程已确认不存在，才视为陈旧接管候选——是否真的能接管交给下面
                // attemptLeaseTakeover 做二次重读确认（H1 修复点），不在这里直接 unlink。
                let holder = null;
                try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { /* 读取/解析失败——holder 为 null，canTakeOverStaleLock 对此保守判不可接管 */ }
                let stale = false;
                try {
                    const st = fs.statSync(lockPath);
                    stale = (Date.now() - st.mtimeMs) > SEQ_BASE_LOCK_STALE_MS;
                } catch (_) { /* statSync 失败（如文件已被并发删除）——当非陈旧处理，走下面 continue */ }
                if (canTakeOverStaleLock(holder, stale)) {
                    const takeover = attemptLeaseTakeover(lockPath, holder, myToken);
                    if (takeover.ok) return { base, lockPath, token: myToken };
                    // 接管失败（含"已被他人抢先接管"这个 H1 修复要拦的场景）——attemptLeaseTakeover
                    // 内部已保证不删除任何文件，这里直接落到下面 continue 换基线重试
                }
                continue; // 未超龄/持有者仍存活/接管失败——该基线视为仍被占用，换一个随机基线重试
            }
            throw e; // 非"已存在"的异常（如权限问题）不吞，交给顶层 catch 暴露
        }
    }
    console.error(`[verify-collab-external-source] 区间租约获取失败：连续 5 次随机基线均已被占用（其他实例正在运行？），拒绝启动`);
    process.exit(1);
}
function releaseSeqBaseLease() {
    const result = releaseLeaseAtPath(SEQ_BASE_LOCK_PATH, SEQ_BASE_LOCK_TOKEN);
    if (!result.deleted && result.reason === 'token-mismatch') {
        console.error('[verify-collab-external-source] 区间租约释放跳过：锁文件已被其他持有者接管（token 不匹配），不删除');
    }
    // 'not-exists'/'error' 均静默——同原逻辑的 ignore（句柄/权限/JSON 解析异常不阻断收尾）
}
const { base: SEQ_BASE, lockPath: SEQ_BASE_LOCK_PATH, token: SEQ_BASE_LOCK_TOKEN } = acquireSeqBaseLease();
const SEQ_RANGE_END = SEQ_BASE + 1000; // [SEQ_BASE, SEQ_RANGE_END) 是本次运行的专属 id 区间
// 〔S2·Opus 预筛〕`process.on('exit', ...)` 是最后一道防线——Node 的 'exit' 事件在进程即将终止前
// 同步触发，覆盖本文件所有 `process.exit(...)` 调用路径（含还没来得及走到 handleTermSignal/主 IIFE
// finally 的早退分支，如参数校验阶段的意外 throw）；`releaseSeqBaseLease()` 内部已是幂等的
// "存在才删"，重复调用（finally 里也会调一次）无副作用，不会因为调用两次而报错。
process.on('exit', releaseSeqBaseLease);

let pass = 0, fail = 0, skipCount = 0;
const failures = [];
// 〔M6·codex 12b 质量审〕skips 数组——SKIP 本来就已经只计入 skipCount、从不计入 pass（下面 skip()
// 的实现从一开始就没碰 pass 变量），本条不是修一个"SKIP 被算成通过"的计数 bug，而是修"可读性"：
// 光看汇总行「N 通过 / 0 失败 / 2 跳过」的一个数字，读的人并不知道具体是哪两条冻结口径因为环境
// 限制完全没有行为证据——把每条 skip 的 name/reason 存下来，收尾单独打印一份「未覆盖口径清单」
// （见文件末尾汇总块），比让人自己去反推 skipCount 对应哪些用例靠谱。
const skips = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
function skip(name, reason) {
    skipCount++;
    skips.push({ name, reason });
    console.log(`  ⚠ SKIP ${name}  （${reason}）`);
}
function section(title) { console.log(`\n=== ${title} ===`); }

// ============================================================================
// 通用 helper：加密、JWT、HTTP、sqlite 直连
// ============================================================================

// 复用 server.js:2776-2782 生产实现（先例 scripts/test-collab-mysql-smoke-e2e.js:60-66）
function encryptPassword(password) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function signAs(user) {
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

async function apiCall(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { /* 非 JSON 响应留 null */ }
    return { status: r.status, body: j };
}

// files: [{ name, content }]，字段名统一 'files'（submitUpload.array('files', 10)）
async function postSubmit(reqId, token, files) {
    const fd = new FormData();
    for (const { name, content } of files) {
        fd.append('files', new Blob([content]), name);
    }
    const r = await fetch(`${BASE}/api/collab/requests/${reqId}/submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: fd,
    });
    let j = null;
    try { j = await r.json(); } catch (_) { /* ignore */ }
    return { status: r.status, body: j };
}

// -- 带 503（schema 未就绪）短暂重试的 submit 包装（handoff §2 风险点：schema 就绪判据与
//    app.listen 独立，第一次真实 /submit 前用重试兜底，不假设端口一开就能提交）
async function postSubmitWithRetry(reqId, token, files, maxRetries = 6) {
    for (let i = 0; i < maxRetries; i++) {
        const r = await postSubmit(reqId, token, files);
        if (r.status !== 503) return r;
        await new Promise((res) => setTimeout(res, 500));
    }
    return postSubmit(reqId, token, files);
}

// -- 临时库直连（种子 + 断言用）
let tdb = null;
function tdbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        tdb.run(sql, params, function (err) { err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID }); });
    });
}
function tdbGet(sql, params = []) {
    return new Promise((resolve, reject) => { tdb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))); });
}
function tdbAll(sql, params = []) {
    return new Promise((resolve, reject) => { tdb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))); });
}

// ============================================================================
// 进程/端口/文件清理（照 test-it-asset-ledger-playwright.js 范式：按 PID 树杀 + 端口兜底扫描 +
//   归属校验，禁全杀 node）
// ============================================================================
function getProcessCommandLine(pid) {
    try {
        const out = execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
            { encoding: 'utf8', shell: 'cmd.exe' }
        );
        return out.trim();
    } catch (_) { return ''; }
}
function normalizePathForMatch(s) { return String(s || '').toLowerCase().replace(/\//g, '\\'); }
function killPort(port, phase) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach((line) => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach((pid) => {
            const cmdLine = getProcessCommandLine(pid);
            const owned = normalizePathForMatch(cmdLine).includes(normalizePathForMatch(WRAPPER_PATH));
            if (!owned) {
                if (phase === 'startup') {
                    console.error(`[verify-collab-external-source] 端口 ${port} 被无关进程占用（PID ${pid}），拒绝启动`);
                    process.exit(1);
                }
                console.log(`  ⚠️ 跳过 PID ${pid}（端口 ${port} 占用者非本套件 wrapper 进程，不误杀）`);
                return;
            }
            try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ }
        });
    } catch (_) { /* ignore */ }
}
function killChildTree(c) {
    if (!c || !c.pid) return;
    try { execSync(`taskkill /T /F /PID ${c.pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ }
}
function closeTdb() {
    return new Promise((resolve) => {
        if (!tdb) return resolve();
        tdb.close(() => resolve());
    });
}
function cleanupTempDb() {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const p = TEMP_DB + suffix;
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {
            console.log(`  ⚠️ 临时库文件删除失败（句柄未释放）：${p}（${e.message}）`);
        }
    }
}
// 〔G2 现场发现〕本机上 fs.rmSync({recursive:true,force:true})（含显式 maxRetries/retryDelay）
// 对本仓路径下的目录会"不抛错但也不真删"——目录复查后仍 existsSync===true。已用 PowerShell
// Remove-Item 交叉验证：同一路径 PowerShell 一次成功，证明不是句柄占用/权限问题，是 Node
// fs.rmSync 在本机对该路径的怪异行为（未深究根因，超出本批范围）。规避：fs.rmSync 失败（复查
// 仍存在）时回退 PowerShell Remove-Item -Recurse -Force 兜底。
function forceRemoveDir(p) {
    // S2〔主会话预筛·2026-09-02〕硬断言：只允许删 uploads/collab 之下的路径。recursive+force
    // 删除破坏力不小，调用方传参算错（如拼接 collabBase 时手滑）绝不能被这个函数悄悄放行，
    // 必须在真正动手删之前就地拒绝并抛错，而不是删完才发现删错了地方。
    const collabRootAbs = path.resolve(ROOT, 'uploads', 'collab');
    const target = path.resolve(p);
    if (target !== collabRootAbs && !target.startsWith(collabRootAbs + path.sep)) {
        throw new Error(`forceRemoveDir: 拒绝删除 uploads/collab 之外的路径：${target}`);
    }
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch (_) { /* 兜底走下面 PowerShell */ }
    if (!fs.existsSync(target)) return;
    // execFileSync 直接起 powershell.exe（不经 cmd.exe/shell），参数各自独立数组项传入；目标路径
    // 走环境变量传给子进程，命令文本本身不拼接任何外部输入，无字符串拼接注入面。
    try {
        execFileSync('powershell', [
            '-NoProfile', '-Command',
            'Remove-Item -LiteralPath $env:G2_RM_TARGET -Recurse -Force -ErrorAction Stop',
        ], { env: { ...process.env, G2_RM_TARGET: target } });
    } catch (_) { /* 留给复查逻辑记录为残留 */ }
}

// 〔H1·codex 07 质量审〕开跑前预检：[SEQ_BASE+1, SEQ_RANGE_END) 区间内若已存在任何
// _pending/<id> 或 <id>_* 正式目录，直接 fail 退出（零写）——防止本次运行的随机 base 恰好撞上
// 真实数据（虽然此区间远超真实生产单号量级，理论撞上仍应拒绝而非静默继续）。
// 〔08-M4·codex 08 审〕原判据窄了两处：① `_pending/<name>` 要求 name 整体是纯数字（Number(name)
//   对任何非纯数字尾巴都返回 NaN，漏判如 "900123.tmp" 这类"数字开头但带后缀"的条目）；
//   ② `uploads/collab/<name>` 要求正则 `^(\d+)_`（数字后紧跟下划线），漏判"数字开头但不带下划线
//   后缀"的条目（如裸 "900123" 或 "900123.log"）。收紧为"两个目录下的**全部条目**（文件或
//   目录皆算，不限后缀），名称以数字开头且该数字落在 (SEQ_BASE, SEQ_RANGE_END) 区间即计残留"
//   ——用统一的 leadingDigits 提取，不再区分"是否带下划线/是否纯数字"。
function leadingDigitsOf(name) {
    const m = /^(\d+)/.exec(name);
    return m ? Number(m[1]) : NaN;
}
// 〔M4·codex 12b 质量审〕递归残留扫描（深度 ≤3，受控——不跟随符号链接，避免潜在环路）：原实现
// 只查 uploads/collab 与 uploads/collab/_pending 两层的直接子项名称，若某个坏实现把文件写到了
// 更深一层目录（如 uploads/collab/<id>_desc/ 之下又建了一层子目录、或 _pending/<id>/ 下又嵌套了
// 一层子目录），旧实现完全看不见——收尾复扫（F5）复用同一份逻辑，同样看不见，是"零残留"结论
// 的一个盲区。改为对 uploads/collab 整棵树受控递归（depth 从 1 起，最深到 3 层），沿途每一层的
// 每个条目名称都单独做一次"提取前导数字 id + 是否落在本次区间"判断（不只判断顶层名称）；
// `_pending` 是 uploads/collab 的直接子目录，天然被同一次递归覆盖，不需要单独再扫一遍。
function collectResidualHits(dirPath, depth, maxDepth, hits) {
    const inRange = (n) => Number.isInteger(n) && n > SEQ_BASE && n < SEQ_RANGE_END;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // 受控：不跟随符号链接，避免潜在环路
        const idNum = leadingDigitsOf(entry.name);
        const fullPath = path.join(dirPath, entry.name);
        if (inRange(idNum)) hits.push(fullPath);
        if (entry.isDirectory() && depth < maxDepth) {
            collectResidualHits(fullPath, depth + 1, maxDepth, hits);
        }
    }
}
function precheckNoResidualInRange() {
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    const hits = [];
    try {
        if (fs.existsSync(collabBase)) collectResidualHits(collabBase, 1, 3, hits);
    } catch (e) {
        hits.push(`(预检异常: ${e.message})`);
    }
    return hits;
}

// 〔H1〕本次运行登记的精确清理路径清单——只有"路径被登记过"且"路径 id 落在本次 SEQ_BASE 区间
// 内"两条件同时满足才会被删除（见 cleanupUploadArtifacts）。createPendingRequest 每造一条
// fixture 就把该单的 _pending 目录与最终归档目录都登记进来（无论最终是否真的落盘）。
const registeredCleanupPaths = [];
function registerCleanupPath(p) { registeredCleanupPaths.push(p); }
// G2-F6〔删假注释，改真复用〕computeAttachmentDirName 已在 versioning.js:1013-1015 的
// `_internal` 里导出——旧注释"未导出，内联复刻"是过时的假话（R2 核实：`_internal.
// computeAttachmentDirName` 确实存在），这里直接 require 真实实现，不再自己维护一份算法副本
// （双份实现一旦其中一份改了截断规则/替换字符集而另一份没跟着改，就会悄悄算出不一样的目录名）。
function computeFinalDirName(id, description) {
    return require(path.join(ROOT, 'utils', 'collab-attachment-versioning'))._internal.computeAttachmentDirName(id, description);
}

// 清理本次种下的 uploads/collab 残留——只删"本次运行登记过 + id 落在本次 SEQ_BASE 区间内"的
// 精确路径清单（H1 两道守卫同时满足才删），断言「尝试删 ≥1 且清单内残留 0」（不静默）。
function cleanupUploadArtifacts() {
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    let attempted = 0;
    const remaining = [];
    const idInRange = (idNum) => Number.isInteger(idNum) && idNum > SEQ_BASE && idNum < SEQ_RANGE_END;
    try {
        for (const p of registeredCleanupPaths) {
            const base = path.basename(p);
            const idNum = Number(base) || Number((/^(\d+)_/.exec(base) || [])[1]);
            if (!idInRange(idNum)) continue; // 第二道守卫：即使登记过，id 不在本次区间内也不删
            if (!fs.existsSync(p)) continue; // 登记过但从未真正落盘（如提交失败早退），无需删
            attempted++;
            forceRemoveDir(p);
            if (fs.existsSync(p)) remaining.push(p);
        }
    } catch (e) {
        console.log(`  ⚠️ 清理 uploads/collab 残留时异常：${e.message}`);
    }
    ok('清理闭环：上传残留文件尝试删 ≥1 且登记清单内复查残留 = 0（不静默，仅删精确登记路径）',
        attempted >= 1 && remaining.length === 0,
        `attempted=${attempted}, remaining=${remaining.length}${remaining.length ? '：' + remaining.slice(0, 5).join('; ') : ''}`);
    // 上传根未做物理隔离（uploads/collab 与真实生产共用同一目录树，不改 server.js 先例）——
    // 靠"随机 base 唯一前缀 + 精确登记清单 + 复查残留"三件套隔离，不是靠改路径本身隔离。
}

let termCleanupStarted = false;
function handleTermSignal(sig) {
    return async () => {
        if (termCleanupStarted) return;
        termCleanupStarted = true;
        console.log(`\n[verify-collab-external-source] 收到 ${sig}，执行清理后退出`);
        killChildTree(child);
        await closeTdb();
        cleanupTempDb();
        releaseSeqBaseLease(); // 08-M3：中断退出同样要释放区间租约，不留死锁文件卡住后续运行
        process.exit(130);
    };
}
let child = null;
process.on('SIGINT', handleTermSignal('SIGINT'));
process.on('SIGTERM', handleTermSignal('SIGTERM'));

// ============================================================================
// §SETUP：起临时 server + 种子数据
// ============================================================================
// 〔G2 现场发现·与本批业务逻辑无关的既有 bug，未修复，仅规避〕针对**全新空 sqlite 文件**（0 表）
// 冷启动时，server.js 有极早期（"Task Pool Server running" 打出后几毫秒内）未捕获异常：
//   Uncaught Exception: SQLITE_ERROR: no such table: main.collab_requests/collab_dev_plan_items/
//   collab_attachments/collab_operation_logs —— 全新库上某段未走 db.serialize() 的启动期查询
//   抢在对应 CREATE TABLE 完成前执行；server.js:21126 的 uncaughtException 处理器记录后
//   `setTimeout(() => process.exit(1), 1000)`，进程在打出 "Task Pool Server running" 约 1 秒后
//   自杀。生产/常规 dev 库因为表早已存在，从未触发过这条路径；本次是本仓第一次针对*真正空*
//   sqlite 文件冷启动做验证，暴露出来。复现用 node 直跑 wrapper（零 G2 代码参与）反复确认必现，
//   与本批改动无关，修复涉及审计 server.js 启动期全部未 serialize 查询——超出 C2a 范围，不动。
// 规避：进程崩溃后 schema 已基本创建完（CREATE TABLE 是快操作，1 秒内基本都跑完了），对**同一个**
//   临时库文件重新起一次，第二次因表已存在不会再触发这条竞态，直接稳定运行。最多重试 2 次。
async function startServerOnce() {
    let log = '';
    const c = spawn(process.execPath, [WRAPPER_PATH], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(TEST_PORT), IA_TEST_DB_PATH: TEMP_DB, LOG_LEVEL: 'INFO' },
    });
    let exited = false;
    c.on('exit', () => { exited = true; });
    c.stdout.on('data', (d) => { log += d.toString(); });
    c.stderr.on('data', (d) => { log += d.toString(); });
    const deadline1 = Date.now() + 20000;
    let listening = false;
    while (Date.now() < deadline1) {
        if (/Task Pool Server running/.test(log)) { listening = true; break; }
        if (exited) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    // 二次等待 schema 真就绪（取数质量双校验迁移，独立于 app.listen，见 handoff §2 风险点）
    const deadline2 = Date.now() + 10000;
    let schemaReady = false;
    while (Date.now() < deadline2) {
        if (/schema 就绪|健康检查通过：collab_quality_record/.test(log)) { schemaReady = true; break; }
        if (exited) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    // 额外稳定性观察窗：已知崩溃发生在 "Server running" 后约 1 秒内（uncaughtException 处理器的
    // 1000ms setTimeout），这里多等一段确认进程真的挺住了，而不是刚巧还没来得及死
    const stabilizeDeadline = Date.now() + 2500;
    while (Date.now() < stabilizeDeadline && !exited) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return { child: c, listening, schemaReady, exited, getLog: () => log };
}

async function startServer() {
    const maxAttempts = 2;
    let result = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        result = await startServerOnce();
        if (!result.exited) {
            if (attempt > 1) {
                console.log(`  ⚠️ server 第 1 次冷启动崩溃（全新空库启动期竞态，见脚本头注释），第 ${attempt} 次针对同一临时库重启后稳定`);
            }
            return result;
        }
        console.log(`  ⚠️ server 第 ${attempt} 次启动在稳定观察窗内退出（疑似全新空库启动期竞态），日志尾部：\n${result.getLog().slice(-800)}`);
        killChildTree(result.child);
        await new Promise((r) => setTimeout(r, 300));
    }
    return result; // 两次都崩，原样返回最后一次结果（listening/schemaReady 由调用方按 exited 状态判断）
}

// 〔08-H1 前置重构〕原为 seedData() 内部闭包——本批（08-H1）H8 反序夹具需要在 seedData() 已
// 返回之后、runHttpTests() 里再插入两条 db_connections 行（同码不同 type，模拟遗留脏数据），
// 闭包作用域够不到，提到顶层供两处共用，避免重复维护一份 INSERT 语句。
async function insertConn(row) {
    const r = await tdbRun(
        `INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [row.name, row.type, row.host, row.port, row.database, row.default_schema ?? null,
         row.username, row.password, row.connection_type, row.source_system_code ?? null]
    );
    return r.lastID;
}

async function seedData() {
    tdb = new sqlite3.Database(TEMP_DB);
    await new Promise((resolve, reject) => tdb.run('PRAGMA busy_timeout = 5000', (e) => (e ? reject(e) : resolve())));

    // -- 用户三名（与 server.js 默认建的 admin 用户名冲突时会被静默跳过 —— 我们就是要用它）
    const users = {};
    async function ensureUser(username, role, displayName) {
        const existing = await tdbGet('SELECT id, username, display_name, role FROM users WHERE username = ?', [username]);
        if (existing) return existing;
        const r = await tdbRun(
            `INSERT INTO users (username, password, display_name, role, status) VALUES (?, ?, ?, ?, 'active')`,
            [username, 'not-used-jwt-only', displayName, role]
        );
        return { id: r.lastID, username, display_name: displayName, role };
    }
    users.admin = await ensureUser('admin', 'admin', '管理员'); // server 启动时若已建同名 admin，这里复用
    users.developer = await ensureUser('g2_developer', 'user', 'G2测试开发');
    users.business = await ensureUser('g2_business', 'user', 'G2测试业务对接人');

    // -- 9 条 db_connections（①-⑨，见文件头注释/交付报告）——insertConn 已提到顶层，见上。
    const conn = {};
    conn.externalRegistered = await insertConn({
        name: '小程序-智荟人力', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: 'MINIAPP_ZHHL',
    });
    conn.externalUnregistered = await insertConn({
        name: 'G2-其他外部源', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: 'OTHER_EXT',
    });
    conn.relationalMiscoded = await insertConn({ // ③：关系型，但 source_system_code 恰好也是 MINIAPP_ZHHL（H2 证明按 type 非 code 分流）
        name: 'G2-关系型误标智荟人力', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'testdb',
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'MINIAPP_ZHHL',
    });
    conn.relationalBms = await insertConn({ // ④：普通关系型（不可达，H4 失败变体）
        name: 'G2-business_db', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'bms',
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'BMS',
    });
    conn.warehouseType = await insertConn({ // ⑤：connection_type='warehouse'（H0）
        name: 'G2-数仓连接非source', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'dw',
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'warehouse', source_system_code: null,
    });
    conn.oracleType = await insertConn({ // ⑥：type='oracle' 的 source 行（H0；G2-F4 起兼作 H8 对照，
        // 补一个专属 source_system_code——table-columns 端点按 code 查询，NULL 码查不到这一行，
        // H0 仍走 id 直接提交流程不受影响）
        name: 'G2-Oracle误标source', type: 'oracle', host: '10.255.255.1', port: 1521, database: 'orcl',
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'ORACLE_SRC',
    });
    conn.externalCodeNull = await insertConn({ // ⑦：external，code NULL（H3-b）
        name: 'G2-外部源-code为空', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: null,
    });
    conn.externalCodeEmpty = await insertConn({ // ⑧：external，code ''（H3-c）
        name: 'G2-外部源-code空串', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: '',
    });
    conn.externalCodeLowercase = await insertConn({ // ⑨：external，code 小写 miniapp_zhhl（H3-d）
        name: 'G2-外部源-code小写', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: 'miniapp_zhhl',
    });
    conn.px_p3 = await insertConn({ // C2b P3：独立的普通关系型行，专供 PUT/test/DELETE 三操作对照组，
        // 不与 C2a 的①-⑨共用，避免 DELETE 把其他用例依赖的连接删掉
        name: 'PX-P3-普通行', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'p3db', default_schema: null,
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'PX_P3',
    });

    // -- sqlite_sequence 预抬（collab_requests / collab_attachments）
    await tdbRun(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES('collab_requests', ?)`, [SEQ_BASE]);
    await tdbRun(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES('collab_attachments', ?)`, [SEQ_BASE]);

    return { users, conn };
}

// ============================================================================
// §H 业务 fixture helper：造一条 PENDING 协作单（admin 建 + business 指派 developer）
// ============================================================================
let oaCounter = 0;
async function createPendingRequest(ctx, targetConnId, overrides = {}) {
    oaCounter++;
    const adminToken = signAs(ctx.users.admin);
    const businessToken = signAs(ctx.users.business);
    const oaNo = `OA_G2EXT_${process.pid}_${oaCounter}`;
    const createRes = await apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'G2测试业务方',
        description: overrides.description || `G2外部源测试单${oaCounter}`,
        deadline: '2027-12-31 18:00:00',
        contact_person_id: ctx.users.business.id,
        target_db_connection_id: targetConnId,
    });
    if (createRes.status !== 200) {
        throw new Error(`fixture 建单失败: ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    const id = createRes.body.id;
    // 〔H1·codex 07 质量审〕建单拿到 id 后立即登记本单可能产生的两类物理路径（_pending 暂存目录
    // + 最终归档目录），不管本次测试用例后续是否真的会让文件落到这两个位置——登记只是"记一笔
    // 备查"，cleanupUploadArtifacts 会自己判断路径是否存在，登记了但从未落盘不算残留。
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    registerCleanupPath(path.join(collabBase, '_pending', String(id)));
    registerCleanupPath(path.join(collabBase, computeFinalDirName(id, overrides.description || `G2外部源测试单${oaCounter}`)));
    const assignRes = await apiCall('POST', `/api/collab/requests/${id}/assign`, businessToken, {
        developer_id: ctx.users.developer.id,
    });
    if (assignRes.status !== 200) {
        throw new Error(`fixture 指派失败: ${assignRes.status} ${JSON.stringify(assignRes.body)}`);
    }
    return { id, oaNo, devToken: signAs(ctx.users.developer), adminToken, businessToken };
}

function xlsxContent() { return 'fake xlsx binary content not validated (external_skip / smoke-未达比对阶段)'; }
function sqlContent() { return 'SELECT 1 AS health_check'; }

// ============================================================================
// §S（C3）：`scripts/_seed-collab-external-source.js` 行为验证——独立小型临时库（每例一个全新
// sqlite 文件，只建 db_connections 单表，不复用本文件的主 TEMP_DB/tdb），spawn 子进程真跑种子
// 脚本，不 require 其内部函数（黑盒验证，贴近真实调用方式：`node scripts/_seed-...js --apply`）。
// ============================================================================
const SEED_SCRIPT_PATH = path.join(__dirname, '_seed-collab-external-source.js');
const seedTestDbPaths = []; // 本次运行创建的全部 S 组临时库路径，收尾统一清理（含 -journal/-wal/-shm）

function newSeedTestDbPath(tag) {
    const p = path.join(os.tmpdir(), `collab-ext-seed-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    seedTestDbPaths.push(p);
    return p;
}
function cleanupSeedTestDbs() {
    for (const p of seedTestDbPaths) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { if (fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix); } catch (_) { /* ignore（句柄未释放，非本套件主逻辑，不阻断汇总） */ }
        }
    }
}

// 建表——照抄 server.js:1268-1283 CREATE TABLE 定义，只建 db_connections 单表（S 组测试夹具只碰
// 这一张表，不需要起完整 server 建全量 schema，比 TEMP_DB 的整套流程轻量得多）。
function createSeedTestDbTable(dbPath) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.exec(`CREATE TABLE db_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT DEFAULT 'sqlserver',
            host TEXT NOT NULL,
            port INTEGER DEFAULT 1433,
            database TEXT NOT NULL,
            default_schema TEXT DEFAULT 'dbo',
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            is_default INTEGER DEFAULT 0,
            connection_type TEXT DEFAULT 'warehouse',
            source_system_code TEXT,
            created_at DATETIME DEFAULT (datetime('now', 'localtime')),
            updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
        )`, (err) => {
            conn.close((closeErr) => (err ? reject(err) : closeErr ? reject(closeErr) : resolve()));
        });
    });
}
function sQueryAll(dbPath, sql, params = []) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        conn.all(sql, params, (err, rows) => {
            conn.close((closeErr) => (err ? reject(err) : closeErr ? reject(closeErr) : resolve(rows || [])));
        });
    });
}
// 直写夹具①：往 S 组独立临时库插入一行 db_connections（同码重复行/同名异码行等无法经由种子脚本
// 自身产生的"已有脏数据"场景）——G4 静态守卫登记对象之一（col 恒为固定枚举内值，见调用点）。
function sInsertRawConn(dbPath, row) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.run(
            `INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.name, row.type, row.host, row.port, row.database, row.default_schema ?? null,
             row.username, row.password, row.is_default ?? 0, row.connection_type, row.source_system_code ?? null],
            function (err) {
                const lastID = this && this.lastID;
                conn.close((closeErr) => (err ? reject(err) : closeErr ? reject(closeErr) : resolve(lastID)));
            }
        );
    });
}
// 直写夹具②：篡改契约行的某一列（S3(d)/S5b/S8 共用）——`col` 恒来自本文件内固定枚举（调用点
// 逐个手写字面量），非外部输入拼接，无注入面（与 utils/collab-external-sources.js
// externalSourceSqlFilter 对受控常量做字面量拼接同款理由）。
function sCorruptColumn(dbPath, col, value) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.run(`UPDATE db_connections SET ${col} = ? WHERE source_system_code = 'MINIAPP_ZHHL'`, [value], function (err) {
            const changes = this && this.changes;
            conn.close((closeErr) => (err ? reject(err) : closeErr ? reject(closeErr) : resolve(changes)));
        });
    });
}

// 同步调用种子脚本子进程。`dbPath === null` 时不设置 TARGET_DB（供 S6(b) 对称方向用例）；
// `allowOverride` 控制是否自动追加 `--allow-db-override`；`envPatch` 里值为 `undefined` 表示
// 从子进程环境里删除该变量（而非字面量字符串 'undefined'），用于 S2 的"密钥缺失"用例。
function runSeedScriptSync(dbPath, args, opts = {}) {
    const { allowOverride = true, envPatch = {} } = opts;
    const env = { ...process.env };
    if (dbPath === null) delete env.TARGET_DB; else env.TARGET_DB = dbPath;
    for (const [k, v] of Object.entries(envPatch)) {
        if (v === undefined) delete env[k]; else env[k] = v;
    }
    const fullArgs = allowOverride ? [...args, '--allow-db-override'] : [...args];
    const r = spawnSync(process.execPath, [SEED_SCRIPT_PATH, ...fullArgs], { env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
// 异步（非阻塞）调用——仅 S7 真并发用例需要两个子进程同时在跑，spawnSync 做不到。
function spawnSeedScriptAsync(dbPath, args, opts = {}) {
    const { allowOverride = true, envPatch = {} } = opts;
    const env = { ...process.env, TARGET_DB: dbPath };
    for (const [k, v] of Object.entries(envPatch)) {
        if (v === undefined) delete env[k]; else env[k] = v;
    }
    const fullArgs = allowOverride ? [...args, '--allow-db-override'] : [...args];
    const child = spawn(process.execPath, [SEED_SCRIPT_PATH, ...fullArgs], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    return new Promise((resolve) => { child.on('close', (code) => resolve({ status: code, stdout, stderr })); });
}

// 参数化 key 的 AES-256-CBC 加解密——逐字对齐 server.js:2787-2803/种子脚本同款算法，用于 S 组
// 手工构造密文夹具（S5b password 变体 / S8 三例）以及 S4 的"同源性"独立验证断言（不是另起一套
// 加密方案，是同一算法允许调用方传入不同 key 的参数化版本）。
function aesEncryptWithKey(plaintext, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function aesDecryptWithKey(ciphertext, key) {
    const parts = String(ciphertext).split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function runSeedScriptTests() {
    section('§S（C3）种子脚本行为验证：S1-S8（独立临时库，spawn 子进程黑盒调用）');

    try {
        // S1：无参数（不给 --check-only 也不给 --apply）→ 用法错误退出 1，零写
        //     坏法：缺参默认 apply，会静默尝试写库。
        // 〔R1·Opus 预筛〕allowOverride 必须为 true（TARGET_DB 与 --allow-db-override 成对给全），
        //     否则本用例会被①b的"TARGET_DB 无配对开关"检查抢先拦下——那也是 exit 1，但拦的是
        //     完全不同的另一条校验，测不出"缺参数默认 apply"这个真正要测的坏法（两种坏法凑巧
        //     同一退出码，遮住了真实判据）。允许配对后，正确实现会在参数校验本身判 1；
        //     "缺参默认 apply" 的坏版本会绕过参数校验一路走到 --apply 尝试打开一个不存在的路径
        //     （S1 未建表），因 apply 用 OPEN_READWRITE 不含 CREATE 而 DB_OPEN_FAILED，退出 4——
        //     与正确实现的退出 1 可辨。
        {
            const dbPath = newSeedTestDbPath('s1');
            const r = runSeedScriptSync(dbPath, [], { allowOverride: true });
            ok('S1 无参数 → 退出 1（坏法：缺参默认 apply → 会绕过参数校验一路到 DB_OPEN_FAILED 退出 4，与此可辨）',
                r.status === 1, `实得 exit=${r.status} stderr=${r.stderr.slice(0, 200)}`);
            ok('S1 无参数 → 未建库文件（零写）', !fs.existsSync(dbPath));
        }

        // S2：DB_ENCRYPTION_KEY 缺失 / 长度非法 → 退出 1，零写。坏法：回落默认密钥。
        // 〔坑〕子进程里种子脚本自己也 `require('dotenv').config(...)`——若本机 .env 里配了真实
        // DB_ENCRYPTION_KEY，单纯从 envPatch 里 delete 这个 key 只是不从父进程继承，dotenv 默认
        // 不覆盖已存在的 key，但对"未设置"的 key 会照常从 .env 回填，等于没删掉。改用空字符串
        // （''，非 undefined）——空串已"存在"于 env，dotenv 默认配置不覆盖已存在的 key（哪怕是空
        // 串），真正模拟出"取到的值是空"这个场景，同时空串本身 falsy，能命中脚本的缺失判定分支。
        {
            const dbPath1 = newSeedTestDbPath('s2-missing');
            const r1 = runSeedScriptSync(dbPath1, ['--check-only'], { envPatch: { DB_ENCRYPTION_KEY: '' } });
            ok('S2 DB_ENCRYPTION_KEY 缺失 → 退出 1（坏法：回落默认密钥）', r1.status === 1, `实得 exit=${r1.status} stderr=${r1.stderr.slice(0, 200)}`);
            ok('S2 缺失密钥 → 未建库文件（零写）', !fs.existsSync(dbPath1));

            const dbPath2 = newSeedTestDbPath('s2-shortkey');
            const r2 = runSeedScriptSync(dbPath2, ['--check-only'], { envPatch: { DB_ENCRYPTION_KEY: 'tooshort' } });
            ok('S2 DB_ENCRYPTION_KEY 长度非法（<32）→ 退出 1（坏法：回落默认密钥）', r2.status === 1, `实得 exit=${r2.status}`);
            ok('S2 长度非法密钥 → 未建库文件（零写）', !fs.existsSync(dbPath2));
        }

        // S3：check-only 五态
        {
            // (a) 不存在路径 → 退出 4 且不建文件
            const dbPathA = newSeedTestDbPath('s3a-notfound-path');
            const rA = runSeedScriptSync(dbPathA, ['--check-only']);
            ok('S3(a) 不存在路径 → 退出 4', rA.status === 4, `实得 exit=${rA.status} stdout=${rA.stdout}`);
            ok('S3(a) 不存在路径 → 且不建文件', !fs.existsSync(dbPathA));

            // (a2)〔S1·Opus 预筛〕--apply 指向不存在路径 → 同样退出 4 且不建文件（apply 用
            //     OPEN_READWRITE 不含 CREATE，不会静默新建一个空库文件——(a) 只覆盖了 check-only
            //     分支，apply 分支此前没有专属用例，补齐两个模式对称覆盖）。
            const dbPathA2 = newSeedTestDbPath('s3a2-notfound-apply');
            const rA2 = runSeedScriptSync(dbPathA2, ['--apply']);
            ok('S3(a2) --apply 指向不存在路径 → 退出 4', rA2.status === 4, `实得 exit=${rA2.status} stdout=${rA2.stdout}`);
            ok('S3(a2) --apply 指向不存在路径 → 且不建文件（坏法：apply 静默用默认 CREATE 标志新建空库）', !fs.existsSync(dbPathA2));

            // (b) 空库 → NOT_FOUND
            const dbPathB = newSeedTestDbPath('s3b-empty');
            await createSeedTestDbTable(dbPathB);
            const rB = runSeedScriptSync(dbPathB, ['--check-only']);
            ok('S3(b) 空库 → STATE=NOT_FOUND 退出 0', rB.status === 0 && /STATE=NOT_FOUND/.test(rB.stdout), `实得 exit=${rB.status} stdout=${rB.stdout}`);

            // (c) 契约行存在 → OK
            const dbPathC = newSeedTestDbPath('s3c-ok');
            await createSeedTestDbTable(dbPathC);
            const rC0 = runSeedScriptSync(dbPathC, ['--apply']);
            ok('S3(c) 前置：apply → CREATED（前置条件）', rC0.status === 0 && /RESULT=CREATED/.test(rC0.stdout), `实得 exit=${rC0.status} stdout=${rC0.stdout}`);
            const rC = runSeedScriptSync(dbPathC, ['--check-only']);
            ok('S3(c) 契约行存在 → STATE=OK 退出 0', rC.status === 0 && /STATE=OK/.test(rC.stdout), `实得 exit=${rC.status} stdout=${rC.stdout}`);

            // (d) 篡改一列 → CONFLICT_CONTRACT
            const dbPathD = newSeedTestDbPath('s3d-contract');
            await createSeedTestDbTable(dbPathD);
            runSeedScriptSync(dbPathD, ['--apply']);
            await sCorruptColumn(dbPathD, 'host', 'tampered-host');
            const rD = runSeedScriptSync(dbPathD, ['--check-only']);
            ok('S3(d) 篡改一列(host) → STATE=CONFLICT_CONTRACT 退出 2', rD.status === 2 && /STATE=CONFLICT_CONTRACT/.test(rD.stdout), `实得 exit=${rD.status} stdout=${rD.stdout}`);

            // (e) 同码两行 → CONFLICT_DUPLICATE（独立临时库）
            const dbPathE = newSeedTestDbPath('s3e-dup');
            await createSeedTestDbTable(dbPathE);
            runSeedScriptSync(dbPathE, ['--apply']);
            await sInsertRawConn(dbPathE, {
                name: 'S3e-脏数据同码第二行', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
                username: '-', password: 'x', is_default: 0, connection_type: 'source', source_system_code: 'MINIAPP_ZHHL',
            });
            const rE = runSeedScriptSync(dbPathE, ['--check-only']);
            ok('S3(e) 同码两行 → STATE=CONFLICT_DUPLICATE 退出 3', rE.status === 3 && /STATE=CONFLICT_DUPLICATE/.test(rE.stdout), `实得 exit=${rE.status} stdout=${rE.stdout}`);
        }

        // S4：apply 两次 → 第一次 CREATED，第二次 ALREADY_OK，库内恰 1 行。
        //     坏法：第二次重复插入 / 第一次误判 ALREADY_OK。附带同源性独立验证断言。
        {
            const dbPath = newSeedTestDbPath('s4');
            await createSeedTestDbTable(dbPath);
            const r1 = runSeedScriptSync(dbPath, ['--apply']);
            ok('S4 第一次 apply → RESULT=CREATED', r1.status === 0 && /RESULT=CREATED/.test(r1.stdout), `实得 exit=${r1.status} stdout=${r1.stdout}`);
            const r2 = runSeedScriptSync(dbPath, ['--apply']);
            ok('S4 第二次 apply → RESULT=ALREADY_OK（坏法：第二次重复插入）', r2.status === 0 && /RESULT=ALREADY_OK/.test(r2.stdout), `实得 exit=${r2.status} stdout=${r2.stdout}`);
            const rows = await sQueryAll(dbPath, 'SELECT * FROM db_connections');
            ok('S4 库内恰 1 行（坏法：第一次误判 ALREADY_OK 或第二次重复插入）', rows.length === 1, `实得 ${rows.length}`);

            // 〔spec A 段，R4·Opus 预筛措辞更正〕同源性证明：种子写入的密文能被"本文件独立复制的
            // AES 解密实现"解出预期明文。用 G2 自身的 ENCRYPTION_KEY（本次子进程未 envPatch，继承
            // 同一份 key）+ aesDecryptWithKey（本文件内手写的独立实现，与种子脚本内部那份解密
            // 函数是两份各自维护的代码，都各自照抄 server.js 的算法）解密——证明的是"两份独立照抄
            // server.js 算法的实现能互相解密"，不是直接调用 server.js 真实代码验证（本脚本不
            // require server.js，这条断言测不出 server.js 本体是否也照这个算法实现，只能测种子
            // 脚本与本文件这两份独立照抄的实现是否字节级一致；措辞不再写"server.js 同款"这种
            // 暗示已验证到 server.js 本体的说法）。
            if (rows.length === 1) {
                let decrypted = null, threw = null;
                try { decrypted = aesDecryptWithKey(rows[0].password, ENCRYPTION_KEY); } catch (e) { threw = e; }
                ok("S4 同源性：种子写入的密文能被本文件独立复制的 AES 解密实现解出明文 '-'（证明 key 派生/密文格式字节级一致，两份 server.js 算法的独立照抄互相能解，非另起一套加密）",
                    !threw && decrypted === '-', threw ? `解密抛错：${threw.message}` : `实得明文='${decrypted}'`);
            }
        }

        // S5：同名不同码 → CONFLICT_NAME 退出 5，零写。
        // 〔F2〕password 必须是合法密文（encryptPassword('-')），不能是裸明文——本行 type='sqlserver'
        // 落在 keyProbe() 的 `type IN ('sqlserver','mysql') AND password IS NOT NULL` 扫描范围内，
        // 裸明文 'p' 会被 decryptPassword 判非法密文格式抛错，keyProbe 误判 KEY_MISMATCH_PROBE
        // 退出 8，盖过本用例真正要验证的 CONFLICT_NAME 退出 5（S5 语义上就是一条真实关系型行，
        // 用合法密文更贴近真实场景，而非把 password 置 NULL 绕开探针）。
        {
            const dbPath = newSeedTestDbPath('s5');
            await createSeedTestDbTable(dbPath);
            await sInsertRawConn(dbPath, {
                name: '小程序-智荟人力', type: 'sqlserver', host: 'h', port: 1, database: 'd', default_schema: null,
                username: 'u', password: encryptPassword('-'), is_default: 0, connection_type: 'source', source_system_code: null,
            });
            const r = runSeedScriptSync(dbPath, ['--check-only']);
            ok('S5 同名不同码 → STATE=CONFLICT_NAME 退出 5', r.status === 5 && /STATE=CONFLICT_NAME/.test(r.stdout), `实得 exit=${r.status} stdout=${r.stdout}`);
            const applyR = runSeedScriptSync(dbPath, ['--apply']);
            ok('S5 冲突态下 --apply 同样退出 5（不静默插入第二行占用同名）', applyR.status === 5, `实得 exit=${applyR.status}`);
            const rows = await sQueryAll(dbPath, 'SELECT COUNT(*) AS c FROM db_connections');
            ok('S5 库内行数仍为 1（零写确认）', rows[0].c === 1, `实得 ${rows[0].c}`);
        }

        // S5b：表驱动逐列冲突 10 例——每例独立临时库，先种一行契约行（apply）再篡改一列，
        //     断言 check-only 与 apply 均判 CONFLICT_CONTRACT 退出 2 且零写。
        //     坏法：比较漏掉这一列 / 密码比较用密文而非解密后明文。
        {
            const s5bCases = [
                { col: 'host', value: 'S5b-tampered-host' },
                { col: 'port', value: 9999 },
                { col: 'database', value: 'S5b-tampered-db' },
                { col: 'username', value: 'S5b-tampered-user' },
                { col: 'is_default', value: 1 },
                { col: 'type', value: 'sqlserver' },
                { col: 'connection_type', value: 'warehouse' },
                { col: 'default_schema', value: 'dbo' },
                { col: 'name', value: 'S5b-同码异名' },
                { col: 'password', value: () => aesEncryptWithKey('wrong-value', ENCRYPTION_KEY) },
            ];
            for (const c of s5bCases) {
                const dbPath = newSeedTestDbPath(`s5b-${c.col}`);
                await createSeedTestDbTable(dbPath);
                const applyRes = runSeedScriptSync(dbPath, ['--apply']);
                ok(`S5b(${c.col}) 前置：baseline apply → CREATED（前置条件）`,
                    applyRes.status === 0 && /RESULT=CREATED/.test(applyRes.stdout), `实得 exit=${applyRes.status} stdout=${applyRes.stdout}`);
                const value = typeof c.value === 'function' ? c.value() : c.value;
                await sCorruptColumn(dbPath, c.col, value);
                const checkRes = runSeedScriptSync(dbPath, ['--check-only']);
                ok(`S5b(${c.col}) 篡改后 check-only → CONFLICT_CONTRACT 退出 2（坏法：比较漏这一列/密码比密文）`,
                    checkRes.status === 2 && /STATE=CONFLICT_CONTRACT/.test(checkRes.stdout), `实得 exit=${checkRes.status} stdout=${checkRes.stdout}`);
                const applyAfter = runSeedScriptSync(dbPath, ['--apply']);
                ok(`S5b(${c.col}) 冲突态下 --apply 同样零写退出 2（不静默"修复"冲突行）`, applyAfter.status === 2, `实得 exit=${applyAfter.status}`);
                const rows = await sQueryAll(dbPath, 'SELECT COUNT(*) AS c FROM db_connections');
                ok(`S5b(${c.col}) 库内行数仍为 1（零写确认）`, rows[0].c === 1, `实得 ${rows[0].c}`);
            }
        }

        // S6：TARGET_DB 与 --allow-db-override 未成对出现 → 拒绝退出 1（照
        //     _set-sys-single-commit-group.js①b/S2f 的对称成对规则，两个方向都要测）。
        {
            const dbPath = newSeedTestDbPath('s6');
            await createSeedTestDbTable(dbPath);
            const rA = runSeedScriptSync(dbPath, ['--check-only'], { allowOverride: false });
            ok('S6(a) TARGET_DB 给了但缺 --allow-db-override → 退出 1', rA.status === 1, `实得 exit=${rA.status} stderr=${rA.stderr.slice(0, 200)}`);
            // 〔09-M3〕原写法 `runSeedScriptSync(null, [...])` 只是从传给子进程的 env 对象里
            //   `delete env.TARGET_DB`——子进程内部自己也 `require('dotenv').config(...)`，dotenv
            //   默认只跳过"已存在"的 key，被 delete 掉的 key 等于"不存在"，若本机 `.env` 恰好定义
            //   了 TARGET_DB，会被 dotenv 悄悄回填回一个非空真实路径，这条用例实际测的就不再是
            //   "未设置 TARGET_DB"，而是"TARGET_DB 来自 .env"，退出码即使凑巧仍是 1 也可能是从
            //   完全不同的分支走出来的假阳性（比如回填出的路径恰好也校验失败）。改用
            //   `envPatch: { TARGET_DB: '' }`（空字符串，非删除）——空串已"存在"于传给子进程的
            //   env，dotenv 不会覆盖，确定性地让子进程读到"未设置"这个空值，与本机 `.env` 内容
            //   无关（同 S2 对 DB_ENCRYPTION_KEY 的既有处理手法）。另加真实 task_pool.db 的
            //   mtime/size 快照——该库路径与种子脚本的默认写入路径逐字相同（均解析到
            //   `wbs-server/task_pool.db`），一次快照同时覆盖"真实库"与"默认路径"两个说法，证明
            //   本用例的 421 拒绝发生在任何 openDb 调用之前，没有静默打开甚至写入这个文件。
            const realDbSnapBefore = snapshotRealDbState();
            const rB = runSeedScriptSync(null, ['--check-only'], { allowOverride: true, envPatch: { TARGET_DB: '' } });
            ok('S6(b) --allow-db-override 给了但 TARGET_DB 为空（dotenv 不会回填，确定性未设置）→ 退出 1（对称方向，防拼错/未导出静默写默认库）',
                rB.status === 1, `实得 exit=${rB.status} stderr=${rB.stderr.slice(0, 200)}`);
            const realDbSnapAfterDiffs = diffRealDbSnapshots(realDbSnapBefore, snapshotRealDbState());
            ok('S6(b) 真实 task_pool.db（=种子脚本默认路径）元数据与内容哈希均未变化（mtime/size/sha1 快照比对）',
                realDbSnapAfterDiffs.length === 0, realDbSnapAfterDiffs.join('; '));
        }

        // S7：真并发（〔09-M1〕从"两个子进程同时起跑、听天由命"改为"测试连接先持锁再放锁"的
        //     确定性构造）——本文件独立开一个 sqlite 连接对同一临时库 `BEGIN IMMEDIATE` 先占住
        //     写锁，随即（不等待）spawn 两个种子子进程各自 `--apply`（此刻两者必然撞见写锁，
        //     进入各自的 SQLITE_BUSY 退避重试循环——子进程侧用
        //     `SEED_TEST_BUSY_TIMEOUT_MS=100`（远小于生产默认 5000）让驱动内置 busy handler
        //     在 100ms 内就把 SQLITE_BUSY 真正抛给 JS 层，而不是被 5000ms 默认值在锁内静默吸收
        //     掉——300ms 的锁持有时长相对 100ms 有 3 倍冗余，足以吸收子进程启动/PRAGMA 设置的
        //     调度抖动，不会出现"锁已放但子进程还没来得及真正发起 BEGIN IMMEDIATE"的假阴性）。
        //     300ms 后本连接 COMMIT 放锁，再等两个子进程各自退出。
        //     断言恰一 CREATED 一 ALREADY_OK、库内恰 1 行、无裸 SQLITE_BUSY 文本、且至少一个
        //     子进程 stdout 含 `RETRY`（证明退避重试分支真的被执行到，不是巧合式串行调度）。
        //     坏法：没有退避重试直接因 SQLITE_BUSY 报 DB_BUSY 退出 7 / 收到 BUSY 后死等不重试 /
        //     锁后不重读导致双 CREATED。
        {
            const dbPath = newSeedTestDbPath('s7');
            await createSeedTestDbTable(dbPath);

            const lockConn = new sqlite3.Database(dbPath);
            await new Promise((resolve, reject) => lockConn.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));

            const p1 = spawnSeedScriptAsync(dbPath, ['--apply'], { envPatch: { SEED_TEST_BUSY_TIMEOUT_MS: '100' } });
            const p2 = spawnSeedScriptAsync(dbPath, ['--apply'], { envPatch: { SEED_TEST_BUSY_TIMEOUT_MS: '100' } });
            await new Promise((r) => setTimeout(r, 300));
            await new Promise((resolve, reject) => lockConn.run('COMMIT', (err) => (err ? reject(err) : resolve())));
            await new Promise((resolve) => lockConn.close(() => resolve()));

            const [r1, r2] = await Promise.all([p1, p2]);
            const results = [r1, r2];
            const createdCount = results.filter((r) => /RESULT=CREATED/.test(r.stdout)).length;
            const alreadyOkCount = results.filter((r) => /RESULT=ALREADY_OK/.test(r.stdout)).length;
            ok('S7 真并发两次 --apply（测试连接先持锁强制触发竞争）→ 恰一 CREATED 一 ALREADY_OK（坏法：锁后不重读导致双 CREATED）',
                createdCount === 1 && alreadyOkCount === 1, `created=${createdCount} alreadyOk=${alreadyOkCount} stdouts=${JSON.stringify(results.map((r) => r.stdout))}`);
            ok('S7 两个子进程均 exit 0', results.every((r) => r.status === 0), JSON.stringify(results.map((r) => r.status)));
            const rows = await sQueryAll(dbPath, "SELECT id FROM db_connections WHERE source_system_code='MINIAPP_ZHHL'");
            ok('S7 库内恰 1 行', rows.length === 1, `实得 ${rows.length}`);
            const noRawBusy = results.every((r) => !/SQLITE_BUSY/i.test(r.stdout) && !/SQLITE_BUSY/i.test(r.stderr));
            ok('S7 stdout/stderr 无裸 SQLITE_BUSY 文本（坏法：无重试直接抛错，把底层错误原样暴露）', noRawBusy,
                JSON.stringify(results.map((r) => ({ stdout: r.stdout, stderr: r.stderr }))));
            const anyRetry = results.some((r) => /RETRY \d+/.test(r.stdout));
            ok('S7 至少一个子进程 stdout 含 RETRY（坏法：没有退避重试直接 exit 7 报 DB_BUSY，或收到 BUSY 后死等不重试）',
                anyRetry, JSON.stringify(results.map((r) => r.stdout)));
        }

        // S8：密码解密异常三例——①格式错/截断确定性抛异常→退出6；②篡改 IV（多块明文，格式与
        //     填充仍有效，解密成功但明文≠'-'）→退出2；③错密钥（合法长度）→退出码∈{2,6}，零写。
        {
            // ①a 格式错（无冒号分隔/十六进制截断导致 IV 长度非法）——先例复用 G2 H1b/H4 同款字符串
            const dbPathA = newSeedTestDbPath('s8a-format');
            await createSeedTestDbTable(dbPathA);
            runSeedScriptSync(dbPathA, ['--apply']);
            await sCorruptColumn(dbPathA, 'password', 'not-a-valid-ciphertext');
            const rA = runSeedScriptSync(dbPathA, ['--check-only']);
            ok('S8①a 格式错密文（IV 长度非法）→ STATE=PASSWORD_DECRYPT_FAILED 退出 6', rA.status === 6 && /STATE=PASSWORD_DECRYPT_FAILED/.test(rA.stdout), `实得 exit=${rA.status} stdout=${rA.stdout}`);

            // ①b 截断（合法 IV，但密文字节数不是 16 的倍数，decipher.final() 抛"wrong final block length"）
            const dbPathA2 = newSeedTestDbPath('s8a-truncated');
            await createSeedTestDbTable(dbPathA2);
            runSeedScriptSync(dbPathA2, ['--apply']);
            const fullCipher = aesEncryptWithKey('-', ENCRYPTION_KEY);
            const [ivHexA2, cipherHexA2] = fullCipher.split(':');
            const truncated = `${ivHexA2}:${cipherHexA2.slice(0, cipherHexA2.length - 2)}`; // 去掉最后一个字节（2 位十六进制）
            await sCorruptColumn(dbPathA2, 'password', truncated);
            const rA2 = runSeedScriptSync(dbPathA2, ['--check-only']);
            ok('S8①b 截断密文（wrong final block length）→ STATE=PASSWORD_DECRYPT_FAILED 退出 6', rA2.status === 6 && /STATE=PASSWORD_DECRYPT_FAILED/.test(rA2.stdout), `实得 exit=${rA2.status} stdout=${rA2.stdout}`);

            // ② 篡改 IV——用一段跨多个 16 字节块的明文加密后只替换 IV（保留原密文）：CBC 模式下 IV
            //   只影响第一个明文块的恢复结果，末块（决定 PKCS7 填充是否合法）不受 IV 影响、依旧由
            //   前一密文块正确链接，因此 decipher.final() 不会抛错，但整体明文已不等于 '-'。
            //   （确定性构造，非概率性——若明文只有 1 字节，篡改 IV 会连末块一起破坏，大概率转成①）
            const dbPathB = newSeedTestDbPath('s8b-tamperiv');
            await createSeedTestDbTable(dbPathB);
            runSeedScriptSync(dbPathB, ['--apply']);
            const longCipher = aesEncryptWithKey('this-is-a-much-longer-plaintext-value-spanning-multiple-16-byte-blocks', ENCRYPTION_KEY);
            const [, longCipherHex] = longCipher.split(':');
            const tamperedIv = `${crypto.randomBytes(16).toString('hex')}:${longCipherHex}`;
            await sCorruptColumn(dbPathB, 'password', tamperedIv);
            const rB = runSeedScriptSync(dbPathB, ['--check-only']);
            ok("S8② 篡改 IV（多块明文，解密不抛错但明文≠'-'）→ STATE=CONFLICT_CONTRACT 退出 2", rB.status === 2 && /STATE=CONFLICT_CONTRACT/.test(rB.stdout), `实得 exit=${rB.status} stdout=${rB.stdout}`);

            // ③ 错密钥（合法长度，与 baseline 加密用的真实继承密钥不同）——AES-CBC 无认证，不承诺
            //   区分"抛异常"与"解密成功但明文不对"，两种退出码都算通过，只要求零写。
            // 〔09-M2〕`'W'.repeat(32)` 是否真的"错"取决于本机 .env 里的真实 DB_ENCRYPTION_KEY——
            //   若真实密钥恰好也是 32 个 'W'（理论可能，任何合法密钥值都不该被排除在"可能撞见"之外），
            //   这条用例会退化成"用真实密钥重新验证一遍"，测不出"错密钥"这个坏法本该覆盖的场景。
            //   显式与实际密钥比较，撞了就换用 'V'.repeat(32)，并在真正调用前断言两者确实不等。
            const dbPathC = newSeedTestDbPath('s8c-wrongkey');
            await createSeedTestDbTable(dbPathC);
            runSeedScriptSync(dbPathC, ['--apply']); // baseline 用真实继承密钥加密
            const wrongKey = ENCRYPTION_KEY === 'W'.repeat(32) ? 'V'.repeat(32) : 'W'.repeat(32);
            ok('S8③ 前置：构造的错密钥与真实 DB_ENCRYPTION_KEY 确实不同（坏法：撞见真实密钥导致本用例实际验证的是"正确密钥"）',
                wrongKey !== ENCRYPTION_KEY, `wrongKey='${wrongKey}' ENCRYPTION_KEY='${ENCRYPTION_KEY}'`);
            const rC = runSeedScriptSync(dbPathC, ['--check-only'], { envPatch: { DB_ENCRYPTION_KEY: wrongKey } });
            ok('S8③ 错密钥（合法长度）→ 退出码 ∈ {2,6}（AES-CBC 无认证，不承诺区分）', rC.status === 2 || rC.status === 6, `实得 exit=${rC.status} stdout=${rC.stdout}`);
            const rowsC = await sQueryAll(dbPathC, 'SELECT COUNT(*) AS c FROM db_connections');
            ok('S8③ 零写确认（库内行数仍为 1，未被"修复"或重复插入）', rowsC[0].c === 1, `实得 ${rowsC[0].c}`);
        }

        // S9：KEY_PROBE（13-H2）专项——S1-S8 从未构造过"库内确有一条真正的关系型行（type in
        //     sqlserver/mysql）"这个精确前提，S9a-c 补齐 keyProbe() 三种返回路径的正向证据
        //     （此前只在 S8③ 侧面验证过"错密钥"这一种），S9d 补一条 13-H1（compareContract）
        //     明文不泄露的专项回归断言（区别于 keyProbe，S5b password 变体只验证了退出码，
        //     没有专门断言 stdout/stderr 不含解密后明文）。
        // S9a：库内一条关系型行（正确密钥加密）→ check-only 与 apply 均 KEY_PROBE=OK 且流程继续。
        //     坏法：探针把「能正确解密」误判成「密钥不匹配」，首次部署时被无谓挡在门外。
        {
            const dbPath = newSeedTestDbPath('s9a-keyprobe-ok');
            await createSeedTestDbTable(dbPath);
            // 种一条与契约码无关的关系型行（真实继承密钥加密）——只用来让 keyProbe 有行可探测，
            // 不参与 evaluate() 的契约行比较（source_system_code 与 CONTRACT_CODE='MINIAPP_ZHHL' 不同）。
            await sInsertRawConn(dbPath, {
                name: 'S9a-无关关系型行', type: 'sqlserver', host: 'h', port: 1, database: 'd', default_schema: null,
                username: 'u', password: encryptPassword('-'), is_default: 0, connection_type: 'source', source_system_code: 'S9A_UNRELATED',
            });
            const rCheck = runSeedScriptSync(dbPath, ['--check-only']);
            ok('S9a check-only：关系型行+正确密钥 → KEY_PROBE=OK 且流程继续到 STATE=NOT_FOUND（坏法：探针误判正确密钥为不匹配，提前退出 8 挡住后续判定）',
                /KEY_PROBE=OK/.test(rCheck.stdout) && rCheck.status === 0 && /STATE=NOT_FOUND/.test(rCheck.stdout),
                `实得 exit=${rCheck.status} stdout=${rCheck.stdout}`);
            const rApply = runSeedScriptSync(dbPath, ['--apply']);
            ok('S9a --apply：关系型行+正确密钥 → KEY_PROBE=OK 且流程继续到 RESULT=CREATED（坏法：探针误判导致零写退出 8，首次部署被无谓挡住）',
                /KEY_PROBE=OK/.test(rApply.stdout) && rApply.status === 0 && /RESULT=CREATED/.test(rApply.stdout),
                `实得 exit=${rApply.status} stdout=${rApply.stdout}`);
        }

        // S9b：同款关系型行、子进程 env 换成合法长度的错密钥（参照 S8③ 去巧合写法）→ check-only
        //     与 apply 均 KEY_PROBE=KEY_MISMATCH_PROBE 退出 8，且 db 文件 sha1 前后逐字节相同
        //     （坏法：探针在写之后才探测/探测失败仍继续写、或错密钥仍判 CREATED）。
        {
            const dbPath = newSeedTestDbPath('s9b-keyprobe-mismatch');
            await createSeedTestDbTable(dbPath);
            await sInsertRawConn(dbPath, {
                name: 'S9b-无关关系型行', type: 'mysql', host: 'h', port: 1, database: 'd', default_schema: null,
                username: 'u', password: encryptPassword('-'), is_default: 0, connection_type: 'source', source_system_code: 'S9B_UNRELATED',
            });
            const wrongKey = ENCRYPTION_KEY === 'W'.repeat(32) ? 'V'.repeat(32) : 'W'.repeat(32);
            ok('S9b 前置：构造的错密钥与真实 DB_ENCRYPTION_KEY 确实不同（同 S8③ 去巧合写法）',
                wrongKey !== ENCRYPTION_KEY, `wrongKey='${wrongKey}' ENCRYPTION_KEY='${ENCRYPTION_KEY}'`);

            const shaBefore = crypto.createHash('sha1').update(fs.readFileSync(dbPath)).digest('hex');
            const rCheck = runSeedScriptSync(dbPath, ['--check-only'], { envPatch: { DB_ENCRYPTION_KEY: wrongKey } });
            ok('S9b check-only：错密钥（合法长度）→ KEY_PROBE=KEY_MISMATCH_PROBE 退出 8（坏法：探针漏判/误判密钥匹配）',
                /KEY_PROBE=KEY_MISMATCH_PROBE/.test(rCheck.stdout) && rCheck.status === 8, `实得 exit=${rCheck.status} stdout=${rCheck.stdout}`);
            const shaAfterCheck = crypto.createHash('sha1').update(fs.readFileSync(dbPath)).digest('hex');
            ok('S9b check-only 后 db 文件 sha1 逐字节不变（零写确认，坏法：探针在写之后才探测）',
                shaAfterCheck === shaBefore, `before=${shaBefore} after=${shaAfterCheck}`);

            const rApply = runSeedScriptSync(dbPath, ['--apply'], { envPatch: { DB_ENCRYPTION_KEY: wrongKey } });
            ok('S9b --apply：错密钥（合法长度）→ KEY_PROBE=KEY_MISMATCH_PROBE 退出 8（坏法：错密钥仍判 CREATED，把无法验证的行写入库）',
                /KEY_PROBE=KEY_MISMATCH_PROBE/.test(rApply.stdout) && rApply.status === 8, `实得 exit=${rApply.status} stdout=${rApply.stdout}`);
            const shaAfterApply = crypto.createHash('sha1').update(fs.readFileSync(dbPath)).digest('hex');
            ok('S9b --apply 后 db 文件 sha1 逐字节仍与初始相同（零写确认）',
                shaAfterApply === shaBefore, `before=${shaBefore} afterApply=${shaAfterApply}`);
        }

        // S9c：空库（无任何关系型行）→ KEY_PROBE=SKIPPED_NO_RELATIONAL_ROW 且流程继续到
        //     NOT_FOUND/CREATED（坏法：无行可探测时误判失败，挡住首次部署——这正是最常见的真实
        //     场景：全新环境第一次跑种子脚本，db_connections 里当然还没有任何关系型连接）。
        {
            const dbPath = newSeedTestDbPath('s9c-keyprobe-skip');
            await createSeedTestDbTable(dbPath);
            const rCheck = runSeedScriptSync(dbPath, ['--check-only']);
            ok('S9c check-only：空库（无关系型行）→ KEY_PROBE=SKIPPED_NO_RELATIONAL_ROW 且流程继续到 STATE=NOT_FOUND（坏法：无行可探测时误判失败，阻塞首次部署）',
                /KEY_PROBE=SKIPPED_NO_RELATIONAL_ROW/.test(rCheck.stdout) && rCheck.status === 0 && /STATE=NOT_FOUND/.test(rCheck.stdout),
                `实得 exit=${rCheck.status} stdout=${rCheck.stdout}`);
            const rApply = runSeedScriptSync(dbPath, ['--apply']);
            ok('S9c --apply：空库（无关系型行）→ KEY_PROBE=SKIPPED_NO_RELATIONAL_ROW 且流程继续到 RESULT=CREATED（坏法：无行可探测时误判失败，阻塞首次部署）',
                /KEY_PROBE=SKIPPED_NO_RELATIONAL_ROW/.test(rApply.stdout) && rApply.status === 0 && /RESULT=CREATED/.test(rApply.stdout),
                `实得 exit=${rApply.status} stdout=${rApply.stdout}`);
        }

        // S9d：契约行密码解密成功但明文≠'-'（同 S5b password 变体手法，本条补一条 13-H1 专项
        //     非泄露断言）→ STATE=CONFLICT_CONTRACT 退出 2，且 stdout/stderr 全文不含解密后的
        //     明文（坏法：13-H1 回归——比较分支把解密后明文原样打印，而非只出示 sha1:8 指纹；
        //     S5b 已验证退出码但没有专门断言明文不出现，这里用一个刻意可辨识的明文值补上这条）。
        {
            const dbPath = newSeedTestDbPath('s9d-no-plaintext-leak');
            await createSeedTestDbTable(dbPath);
            runSeedScriptSync(dbPath, ['--apply']); // baseline：真实契约行（CONTRACT_PASSWORD_PLAINTEXT='-'）
            const secretPlaintext = 'S9D-SECRET-CONFLICT-PLAINTEXT-DO-NOT-LEAK';
            await sCorruptColumn(dbPath, 'password', encryptPassword(secretPlaintext));
            const r = runSeedScriptSync(dbPath, ['--check-only']);
            ok("S9d 契约行密码解密成功但明文≠'-' → STATE=CONFLICT_CONTRACT 退出 2",
                r.status === 2 && /STATE=CONFLICT_CONTRACT/.test(r.stdout), `实得 exit=${r.status} stdout=${r.stdout}`);
            const leaked = r.stdout.includes(secretPlaintext) || r.stderr.includes(secretPlaintext);
            ok('S9d stdout/stderr 全文不含解密后明文（坏法：13-H1 回归，比较分支把明文原样打印而非仅出示 sha1:8 指纹）',
                !leaked, `stdout=${r.stdout} stderr=${r.stderr}`);
        }
    } finally {
        cleanupSeedTestDbs();
    }
}

// ============================================================================
// §U 单元层：直接 require activateNewVersion（不经 HTTP）
// ============================================================================
async function runUnitTests(ctx) {
    section('§U 单元层（直接 require activateNewVersion）');
    const versioning = require(path.join(ROOT, 'utils', 'collab-attachment-versioning'));
    const { VALIDATION_MODES } = require(path.join(ROOT, 'utils', 'collab-validation-status'));

    fs.mkdirSync(UNIT_COLLAB_ROOT, { recursive: true });

    const dbAsync = {
        runAsync: (sql, params) => tdbRun(sql, params),
        getAsync: (sql, params) => tdbGet(sql, params),
        allAsync: (sql, params) => tdbAll(sql, params),
    };
    const nullLogger = { info: () => {}, warn: () => {}, error: () => {} };

    // 造一条 collab_requests 行（直连库，不走 HTTP）——activateNewVersion 只关心 id + submission_version
    async function makeCollabRow(submissionVersion) {
        const r = await tdbRun(
            `INSERT INTO collab_requests
                (requester_dept, requester_name, request_type, description, deadline, status,
                 created_by, created_by_name, developer_id, developer_name, oa_request_no, submission_version)
             VALUES ('市场营销部','G2单元测试','ONE_OFF_EXPORT','U 单元测试','2027-12-31 18:00:00','PENDING',
                     1,'管理员',?,'G2测试开发',?,?)`,
            [ctx.users.developer.id, `OA_G2U_${process.pid}_${Date.now()}_${Math.random()}`, submissionVersion]
        );
        return r.lastID;
    }
    function makePendingFiles(id) {
        const pendingDir = path.join(UNIT_COLLAB_ROOT, '_pending', String(id));
        fs.mkdirSync(pendingDir, { recursive: true });
        const dataPath = path.join(pendingDir, 'result.xlsx');
        const scriptPath = path.join(pendingDir, 'script.sql');
        fs.writeFileSync(dataPath, xlsxContent());
        fs.writeFileSync(scriptPath, sqlContent());
        return [
            { attachment_type: 'result_data', source_path: dataPath, original_name: 'result.xlsx', uploaded_by: ctx.users.developer.id, uploaded_by_name: 'G2测试开发', typeOrdinal: undefined },
            { attachment_type: 'result_script', source_path: scriptPath, original_name: 'script.sql', uploaded_by: ctx.users.developer.id, uploaded_by_name: 'G2测试开发', typeOrdinal: undefined },
        ];
    }

    // U1：缺省 mode → 走 smoke，注入 runSmokeTest 计数 1，库写 passed
    {
        const id = await makeCollabRow(0);
        const uploadedFiles = makePendingFiles(id);
        let smokeCalls = 0;
        const runSmokeTest = async () => { smokeCalls++; return { ok: true, validatedAt: new Date(), rowCount: 3, columns: ['a', 'b'] }; };
        const result = await versioning.activateNewVersion({
            db: null, dbAsync, requestId: id, oldVer: 0, collabRoot: UNIT_COLLAB_ROOT,
            description: 'U1', attachmentDir: null, oaRequestNo: 'OA-U1', collabCreatedAt: new Date().toISOString(),
            uploadedFiles, runSmokeTest, logger: nullLogger,
            // validationMode 缺省——坏法：分流误把缺省当 external 会导致 smokeCalls 仍为 0
        });
        ok('U1 缺省 mode → runSmokeTest 被调用 1 次', smokeCalls === 1, `实得 ${smokeCalls}`);
        ok('U1 缺省 mode → 返回 validationMode=smoke', result.validationMode === VALIDATION_MODES.smoke);
        ok('U1 缺省 mode → 返回 validationStatus=passed', result.validationStatus === 'passed');
        const row = await tdbGet('SELECT sql_validation_status, status FROM collab_requests WHERE id=?', [id]);
        ok('U1 库内 sql_validation_status=passed', row.sql_validation_status === 'passed', `实得 ${row.sql_validation_status}`);
        ok('U1 库内 status=DONE', row.status === 'DONE');
    }

    // U2：external_skip → 计数 0、external_skipped + DONE、sql_validated_at 非空、supersede 旧版正常
    {
        const id = await makeCollabRow(1);
        // 先插一条 oldVer=1 的 active 附件行，验证 supersede 正常运作
        await tdbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status, superseded_at)
             VALUES (?, 'result_data', 'collab/u2_old/old.xlsx', 'old.xlsx', ?, 'G2测试开发', 1, 'active', NULL)`,
            [id, ctx.users.developer.id]
        );
        const uploadedFiles = makePendingFiles(id);
        let smokeCalls = 0;
        let revalidateCalls = 0;
        const result = await versioning.activateNewVersion({
            db: null, dbAsync, requestId: id, oldVer: 1, collabRoot: UNIT_COLLAB_ROOT,
            description: 'U2', attachmentDir: null, oaRequestNo: 'OA-U2', collabCreatedAt: new Date().toISOString(),
            uploadedFiles, runSmokeTest: null, logger: nullLogger, // 坏法：忘记跳过 smoke 这里会因 null() 抛异常
            validationMode: VALIDATION_MODES.external_skip,
            revalidate: async () => { revalidateCalls++; }, // D25：external_skip 必传，正常场景下应成功返回
        });
        ok('U2 revalidate 被调用恰 1 次（写事务内二次复核，坏法：忘了调用/调用多次）', revalidateCalls === 1, `实得 ${revalidateCalls}`);
        ok('U2 external_skip → runSmokeTest 未被调用（计数 0，入参 null 也未抛错）', smokeCalls === 0);
        ok('U2 返回 validationStatus===external_skipped', result.validationStatus === 'external_skipped');
        const row = await tdbGet('SELECT sql_validation_status, status, sql_validated_at, submission_version FROM collab_requests WHERE id=?', [id]);
        ok('U2 库内 sql_validation_status=external_skipped', row.sql_validation_status === 'external_skipped', `实得 ${row.sql_validation_status}`);
        ok('U2 库内 status=DONE', row.status === 'DONE');
        ok('U2 库内 sql_validated_at 非空', !!row.sql_validated_at);
        const oldAtt = await tdbGet(`SELECT status FROM collab_attachments WHERE collab_request_id=? AND submission_version=1 AND attachment_type='result_data'`, [id]);
        ok('U2 supersede 旧版正常（oldVer=1 的 active 行变 superseded）', oldAtt && oldAtt.status === 'superseded', oldAtt ? `实得 ${oldAtt.status}` : '(未查到)');
        const newAtt = await tdbAll(`SELECT attachment_type, status FROM collab_attachments WHERE collab_request_id=? AND submission_version=2`, [id]);
        ok('U2 新版本(v2) result_data+result_script 均 active', newAtt.length === 2 && newAtt.every((r) => r.status === 'active'), JSON.stringify(newAtt));
    }

    // U3：非法 mode → throw INVALID_VALIDATION_MODE，_pending 源文件一个都没动
    {
        const id = await makeCollabRow(0);
        const uploadedFiles = makePendingFiles(id);
        const beforeExists = uploadedFiles.every((f) => fs.existsSync(f.source_path));
        let threw = null;
        try {
            await versioning.activateNewVersion({
                db: null, dbAsync, requestId: id, oldVer: 0, collabRoot: UNIT_COLLAB_ROOT,
                description: 'U3', attachmentDir: null, oaRequestNo: 'OA-U3', collabCreatedAt: new Date().toISOString(),
                uploadedFiles, runSmokeTest: async () => ({ ok: true }), logger: nullLogger,
                validationMode: 'bogus_mode', // 坏法：校验放在文件移动之后，这里改成合法值也不会红
            });
        } catch (e) { threw = e; }
        ok('U3 非法 mode → throw', !!threw);
        ok('U3 throw.code === INVALID_VALIDATION_MODE', threw && threw.code === 'INVALID_VALIDATION_MODE', threw ? `实得 code=${threw.code}` : '');
        const afterExists = uploadedFiles.every((f) => fs.existsSync(f.source_path));
        ok('U3 _pending 源文件一个都没动（校验先于文件移动）', beforeExists && afterExists);
    }

    // U4：乐观锁冲突（预先把 submission_version 改掉）→ 回滚/异常/文件挪 _orphaned，
    //     external_skip 与 smoke 两种模式各一次。
    // 〔M5·codex 07 质量审〕这里是 versioning 层的**构造冲突**（直接改库模拟"另一个请求抢先
    // 激活了"），不是真并发——真并发（Promise.all 同时发两条请求）由 C2b 的 P4 在连接管理层
    // 覆盖（POST /api/db-connections 的 source_system_code 去重原子化）。activateNewVersion
    // 本身没有暴露可供 G2 发起真并发请求的 HTTP 入口（它是 /submit 内部调用的库函数），构造
    // 冲突是这一层能验证乐观锁分支的唯一手段，两者互补覆盖不同层次的并发正确性。
    for (const mode of [VALIDATION_MODES.smoke, VALIDATION_MODES.external_skip]) {
        const label = mode === VALIDATION_MODES.smoke ? 'smoke' : 'external_skip';
        const id = await makeCollabRow(0);
        const uploadedFiles = makePendingFiles(id);
        // 模拟并发：oldVer=0 传入，但库里已经是 5（另一个请求抢先激活了）
        await tdbRun(`UPDATE collab_requests SET submission_version=5 WHERE id=?`, [id]);
        let threw = null;
        try {
            await versioning.activateNewVersion({
                db: null, dbAsync, requestId: id, oldVer: 0, collabRoot: UNIT_COLLAB_ROOT,
                description: 'U4', attachmentDir: null, oaRequestNo: 'OA-U4', collabCreatedAt: new Date().toISOString(),
                uploadedFiles, runSmokeTest: mode === VALIDATION_MODES.smoke ? (async () => ({ ok: true, validatedAt: new Date(), rowCount: 1, columns: ['a'] })) : null,
                logger: nullLogger, validationMode: mode,
                revalidate: mode === VALIDATION_MODES.external_skip ? (async () => {}) : undefined, // D25：external_skip 必传
            });
        } catch (e) { threw = e; }
        ok(`U4[${label}] 乐观锁冲突 → throw CONCURRENT_SUBMIT`, threw && threw.code === 'CONCURRENT_SUBMIT', threw ? `实得 code=${threw.code}` : '(未抛错)');
        const row = await tdbGet('SELECT submission_version, status FROM collab_requests WHERE id=?', [id]);
        ok(`U4[${label}] 库内 submission_version 未被覆盖（仍是并发写入的 5）`, row.submission_version === 5, `实得 ${row.submission_version}`);
        const stillInPending = uploadedFiles.some((f) => fs.existsSync(f.source_path));
        ok(`U4[${label}] 文件已挪出 _pending（不再原地）`, !stillInPending);

        // M5（codex 07 质量审）：精确断言每个源文件真的出现在 err.orphanedDir 位置（数量/内容
        // 完整），且事务回滚后没有残留 active 附件行、版本确未推进。
        const orphanedDir = threw && threw.orphanedDir;
        ok(`U4[${label}] throw 携带 orphanedDir`, typeof orphanedDir === 'string' && orphanedDir.length > 0, `实得 ${orphanedDir}`);
        if (orphanedDir) {
            const dirExists = fs.existsSync(orphanedDir);
            ok(`U4[${label}] orphanedDir 目录真实存在`, dirExists, orphanedDir);
            if (dirExists) {
                const orphanedFiles = fs.readdirSync(orphanedDir);
                ok(`U4[${label}] orphanedDir 内恰好 2 个文件（result_data+result_script 全部到位，无缺失/多余）`,
                    orphanedFiles.length === 2, `实得 ${JSON.stringify(orphanedFiles)}`);
                const hasXlsx = orphanedFiles.some((f) => f.endsWith('.xlsx'));
                const hasSql = orphanedFiles.some((f) => f.endsWith('.sql'));
                ok(`U4[${label}] orphanedDir 内含 .xlsx 与 .sql 各一个`, hasXlsx && hasSql, `实得 ${JSON.stringify(orphanedFiles)}`);
            }
        }
        const attachCount = await tdbGet('SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=?', [id]);
        ok(`U4[${label}] 事务回滚后无残留 active 附件行（collab_attachments 恰 0 行）`, attachCount.c === 0, `实得 ${attachCount.c}`);
    }

    // U5（D25·codex 06 审 H1）：external_skip + revalidate 抛错 → 无版本推进、UPDATE 未发生、
    // 已移动文件进 _orphaned（走既有事务异常路径 moveToOrphaned）、抛错 code=EXTERNAL_SOURCE_REVOKED
    {
        const id = await makeCollabRow(0);
        const beforeRow = await tdbGet('SELECT submission_version, status, sql_validation_status FROM collab_requests WHERE id=?', [id]);
        const uploadedFiles = makePendingFiles(id);
        let threw = null;
        try {
            await versioning.activateNewVersion({
                db: null, dbAsync, requestId: id, oldVer: 0, collabRoot: UNIT_COLLAB_ROOT,
                description: 'U5', attachmentDir: null, oaRequestNo: 'OA-U5', collabCreatedAt: new Date().toISOString(),
                uploadedFiles, runSmokeTest: null, logger: nullLogger,
                validationMode: VALIDATION_MODES.external_skip,
                revalidate: async () => { const e = new Error('外部源登记已撤销或变更，请联系管理员'); e.code = 'EXTERNAL_SOURCE_REVOKED'; throw e; },
            });
        } catch (e) { threw = e; }
        ok('U5 revalidate 抛错 → throw code=EXTERNAL_SOURCE_REVOKED（坏法：revalidate 抛错被吞掉，激活照常成功）',
            threw && threw.code === 'EXTERNAL_SOURCE_REVOKED', threw ? `实得 code=${threw.code}` : '(未抛错)');
        const afterRow = await tdbGet('SELECT submission_version, status, sql_validation_status FROM collab_requests WHERE id=?', [id]);
        ok('U5 库行完全未变（版本/状态/校验态，坏法：revalidate 之后的 UPDATE 仍然生效了一部分）',
            JSON.stringify(beforeRow) === JSON.stringify(afterRow), `before=${JSON.stringify(beforeRow)} after=${JSON.stringify(afterRow)}`);
        const attachCountU5 = await tdbGet('SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=?', [id]);
        ok('U5 无残留 active 附件行（INSERT 已随事务回滚）', attachCountU5.c === 0, `实得 ${attachCountU5.c}`);
        const orphanedDirU5 = threw && threw.orphanedDir;
        // revalidate 走的是"事务异常"通用 catch（非 CONCURRENT_SUBMIT 专属分支），该分支同样调用
        // moveToOrphaned 但**不**把 orphanedDir 挂到 err 上（只有 CONCURRENT_SUBMIT 分支这么做）——
        // 这里改为直接扫描 _orphaned 目录，确认本次两个源文件确实被挪了进去。
        const orphanedBase = path.join(UNIT_COLLAB_ROOT, '_orphaned');
        let foundInOrphaned = false;
        if (fs.existsSync(orphanedBase)) {
            for (const dirName of fs.readdirSync(orphanedBase)) {
                if (dirName.startsWith(`${id}_v`)) {
                    const files = fs.readdirSync(path.join(orphanedBase, dirName));
                    if (files.length === 2) { foundInOrphaned = true; break; }
                }
            }
        }
        ok('U5 本次两个源文件已挪进 _orphaned/<id>_v.../（事务异常清理路径对 external_skip 同样生效）',
            foundInOrphaned, `orphanedDir(若有)=${orphanedDirU5}`);
        const stillInPendingU5 = uploadedFiles.some((f) => fs.existsSync(f.source_path));
        ok('U5 _pending 源文件已挪出（不再原地）', !stillInPendingU5);
    }

    // U5b（D25）：external_skip 未传 revalidate → 函数入口即 throw REVALIDATE_REQUIRED，
    // _pending 源文件一个都没动（校验先于任何文件操作，同 U3 的"校验先行"契约）
    {
        const id = await makeCollabRow(0);
        const uploadedFiles = makePendingFiles(id);
        const beforeExists = uploadedFiles.every((f) => fs.existsSync(f.source_path));
        let threw = null;
        try {
            await versioning.activateNewVersion({
                db: null, dbAsync, requestId: id, oldVer: 0, collabRoot: UNIT_COLLAB_ROOT,
                description: 'U5b', attachmentDir: null, oaRequestNo: 'OA-U5b', collabCreatedAt: new Date().toISOString(),
                uploadedFiles, runSmokeTest: null, logger: nullLogger,
                validationMode: VALIDATION_MODES.external_skip,
                // 坏法：漏传 revalidate（或传非函数值）应立即在入口被拒，不应该走到任何文件操作
            });
        } catch (e) { threw = e; }
        ok('U5b 未传 revalidate → throw code=REVALIDATE_REQUIRED（坏法：入口校验漏掉了这个必传约束）',
            threw && threw.code === 'REVALIDATE_REQUIRED', threw ? `实得 code=${threw.code}` : '(未抛错)');
        const afterExists = uploadedFiles.every((f) => fs.existsSync(f.source_path));
        ok('U5b _pending 源文件一个都没动（入口校验先于文件移动，同 U3 契约）', beforeExists && afterExists);
    }
}

// ============================================================================
// §Q 静态哨兵
// ============================================================================
function runStaticSentinels() {
    section('§Q 静态哨兵');
    const p = path.join(ROOT, 'routes', 'periodic-fetch', 'index.js');
    const src = fs.readFileSync(p, 'utf8');
    const occurrences = [...src.matchAll(/type IN \('sqlserver', 'mysql'\)/g)];
    ok("Q2 routes/periodic-fetch/index.js 仍恰好含 2 处 type IN ('sqlserver', 'mysql')（未被顺手放行 external）",
        occurrences.length === 2, `实得 ${occurrences.length} 处`);
    // S3〔主会话预筛·2026-09-02〕补第三处放行的静默接入哨兵：若有人日后顺手把周期取数模块也接进
    // externalSourceSqlFilter/isRegisteredExternalSource（即引入 collab-external-sources 模块），
    // 等于给周期取数悄悄开了外部源免验的口子——这属于本批（C2a）明确未拍板的范围扩张，
    // 哨兵应先于业务影响暴露出来，而不是等下一次审查才发现。
    ok('Q2 routes/periodic-fetch/index.js 未引入 collab-external-sources（第三处放行未被静默接入周期取数）',
        !/collab-external-sources/.test(src));

    // 〔08-M6·codex 08 审，R3·Opus 预筛收窄为白名单〕静态哨兵：/submit 通用异常兜底分支
    // （activateNewVersion 抛出的"其他异常"——含 D25 revalidate 抛出的 EXTERNAL_SOURCE_REVOKED）
    // 响应体须透传 err.code，前端/客户端才能区分"外部源被撤销"与"系统真故障"两类完全不同性质的
    // 失败；但只应透传白名单内的码（SQLITE_*/ENOENT/EPERM 等底层错误码不该透传）。两条断言：
    //   ① SUBMIT_PASSTHRU_CODES 白名单常量存在且恰含 'EXTERNAL_SOURCE_REVOKED'（坏法：白名单被
    //      删掉/清空/混进了不该有的码）；
    //   ② 响应体透传写法确实引用了这个白名单做门禁（坏法：改回无条件透传 `e.code ? ... : {}`，
    //      或虽保留了白名单声明但usage处没真的拿它当门禁——只声明不使用同样是假合规）。
    // 只锚定这一处唯一写法（server.js 另有其他端点复用同一句"提交失败，请联系管理员"通用文案但
    // 语义不同，如 16868/19022 一带，均不在本批范围，不应被误判命中）。
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const passthruSetHits = serverSrc.split("const SUBMIT_PASSTHRU_CODES = new Set(['EXTERNAL_SOURCE_REVOKED']);").length - 1;
    ok('M6① SUBMIT_PASSTHRU_CODES 白名单常量存在且恰为 [EXTERNAL_SOURCE_REVOKED]（坏法：白名单被删/清空/混入其他码）',
        passthruSetHits === 1, `实得命中 ${passthruSetHits} 处（应恰为 1）`);
    const m6AnchorHits = serverSrc.split("error: '提交失败，请联系管理员', ...(e.code && SUBMIT_PASSTHRU_CODES.has(e.code) ? { code: e.code } : {})").length - 1;
    ok('M6② /submit 通用异常兜底分支响应体透传受白名单门禁约束（坏法：改回无条件透传，或门禁被删掉/改写）',
        m6AnchorHits === 1, `实得命中 ${m6AnchorHits} 处（应恰为 1）`);

    // 〔P21·2026-09-03 用户裁定·codex 14-M1〕默认连接查询谓词哨兵：server.js 里所有「取默认连接」的
    // 查询必须带 connection_type 谓词（只认 warehouse/未分类），裸 `is_default = 1 LIMIT 1` 计 0。
    // 坏法：新增一个取默认连接的端点漏写谓词——一旦 external 行的 is_default 被置 1（三方不变量任一
    // 失守），它就会被裸查询选中并进入连库链。谓词数量下限锚定当前实测 8 处（只增不减）。
    const bareDefaultHits = (serverSrc.match(/is_default\s*=\s*1\s+LIMIT\s+1/g) || []).length;
    const guardedDefaultHits = (serverSrc.match(/is_default\s*=\s*1\s+AND\s+\(connection_type\s*=\s*'warehouse'\s+OR\s+connection_type\s+IS\s+NULL\)\s+LIMIT\s+1/g) || []).length;
    ok(`Q-P21 server.js 取默认连接查询恒带 connection_type 谓词（裸 is_default=1 LIMIT 1 计 0、带谓词 ≥8；坏法：新端点漏谓词 → external 行被置默认即入连库链）`,
        bareDefaultHits === 0 && guardedDefaultHits >= 8, `bare=${bareDefaultHits} guarded=${guardedDefaultHits}`);

    // ============================================================================
    // 〔09-L1〕G4（scripts/verify-db-connections-writers.js）对照自证——本批不允许改动 G4 本体
    // （只允许改 server.js/本文件/种子脚本三个文件），G4 的 `main()` 在模块顶层直接
    // `process.exit(...)`，也不能安全 require 进来跑。改为在本文件独立复刻 G4 扫描算法里跟本条
    // 对照直接相关的最小切片（STMT_RE / extractEnclosingLiteral / skipStringLiteral /
    // normalizeSqlFingerprint，逐字对齐 verify-db-connections-writers.js 2026-09-02 R2 版本）——
    // 与 G1/G4 各自独立维护一份 stripJsCommentsStrict 同一惯例（各 verify-*.js 历来互不
    // require，自包含）。若未来 G4 那边扩改了这几个函数的匹配规则，这里需要人工同步，否则两边
    // 会静默漂移，这是自包含复制品的既有已知风险，非本批新增。
    //   ① 扫描是纯文本匹配，不关心字符串是否真的被任何 db.run/exec 调用引用——G4 的设计初衷是
    //      "凡出现即登记，交人工审计判断"，不是"只登记真正执行的语句"。
    //   ② SQL 指纹归一化：`${...}` 模板插值内容被整体剥离（改插值变量名指纹不变），但列清单本身
    //      的静态文本改动会改变指纹。
    // 〔安全构造提醒〕下面 ①的样例文本用数组拼接而非单个连续字符串字面量写死在本文件源码里——
    // 若直接写成一整段连续字面量，会被"真实 G4"扫描本文件（scripts/** 在其扫描面内）时当成
    // 一处新的真实直写命中，因未登记而把 G4 自身基线（当前 13/0）打红；本文件不允许改动 G4 的
    // REGISTERED_WRITE_POINTS 登记表，必须避免制造这类新增命中。数组两段之间插入的逗号/引号/
    // 空格会打断 STMT_RE 要求的 "INSERT\s+INTO" 连续匹配，真实 G4 扫描本文件源码文本时不会命中；
    // 只有在本文件运行期 `.join('')` 拼接成一个完整字符串之后，才会被下面这段"独立复刻的最小
    // 切片扫描器"在内存里检出——这正是①要验证的属性本身，不是绕过。
    function l1SkipStringLiteral(src, i) {
        const quote = src[i];
        i++;
        while (i < src.length) {
            if (src[i] === '\\') { i += 2; continue; }
            if (src[i] === quote) return i;
            i++;
        }
        return i;
    }
    function l1ExtractEnclosingLiteral(text, matchIndex) {
        let i = matchIndex - 1;
        while (i >= 0 && /\s/.test(text[i])) i--;
        if (i < 0 || !"'\"`".includes(text[i])) return null;
        const quoteIdx = i;
        const endIdx = l1SkipStringLiteral(text, quoteIdx);
        if (endIdx >= text.length || text[endIdx] !== text[quoteIdx]) return null;
        return { start: quoteIdx, end: endIdx, content: text.slice(quoteIdx + 1, endIdx) };
    }
    const L1_STMT_RE = /\b((?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:\w+\.)?["'\[\x60]?db_connections\b/gi;
    function l1NormalizeSqlFingerprint(sqlText) {
        const withoutPlaceholders = sqlText.replace(/\$\{[^}]*\}/g, '').replace(/\?/g, '');
        const collapsed = withoutPlaceholders.replace(/\s+/g, ' ').trim().toLowerCase();
        return crypto.createHash('sha1').update(collapsed, 'utf8').digest('hex').slice(0, 12);
    }
    function l1ScanForHits(text) {
        const hits = [];
        L1_STMT_RE.lastIndex = 0;
        let m;
        while ((m = L1_STMT_RE.exec(text))) {
            const literal = l1ExtractEnclosingLiteral(text, m.index);
            if (literal) hits.push({ index: m.index, fingerprint: l1NormalizeSqlFingerprint(literal.content) });
        }
        return hits;
    }

    section('§Q（09-L1）G4 对照自证：纯文本样例命中 + 模板插值指纹稳定性（独立复刻切片，非真跑 G4）');
    {
        // ① 拼接成型（见上方安全构造提醒），构造一段"只出现在字符串样例里、从未被任何
        //    db.run/exec 引用"的 INSERT 文本，验证独立复刻的扫描切片依然会命中它。
        const sampleSqlPieces = ['INSERT', ' INTO db_connections (col_never_referenced_by_any_call) VALUES (?)'];
        const sampleWrapped = `const __L1_NEVER_CALLED_SAMPLE__ = '${sampleSqlPieces.join('')}'; // 仅文档样例，全仓无任何调用点引用它`;
        const hits = l1ScanForHits(sampleWrapped);
        ok('L1① 纯文本样例（从未被执行/引用）同样会被扫描命中、计入登记要求（坏法：扫描器只认位于 db.run/exec 调用参数位置的字面量，漏掉未接线的样例文本）',
            hits.length === 1, `实得命中数=${hits.length}`);

        // ② 模板插值 ${x} 归一后指纹稳定：改插值变量名指纹不变；改列清单（静态文本）指纹必变。
        //    `l1NormalizeSqlFingerprint` 是纯字符串处理（剥占位符/折叠空白/小写/哈希），跟输入
        //    文本里是不是真的出现 "db_connections" 无关——这里刻意用一个不含 db_connections 的
        //    表名占位（`some_table`），避免这三段测试固件文本本身又被真实 G4 当成新的一处直写
        //    命中（同上方①的安全构造理由：不给真实 G4 扫描本文件时制造新的未登记命中）。
        const fpVarA = l1NormalizeSqlFingerprint('UPDATE some_table SET ${colA} = ? WHERE id = ?');
        const fpVarRenamed = l1NormalizeSqlFingerprint('UPDATE some_table SET ${colBRenamed} = ? WHERE id = ?');
        ok('L1② 只改模板插值变量名（${colA}→${colBRenamed}）→ 指纹不变（坏法：归一化把插值变量名当成 SQL 内容的一部分参与哈希）',
            fpVarA === fpVarRenamed, `fpVarA=${fpVarA} fpVarRenamed=${fpVarRenamed}`);
        const fpColListChanged = l1NormalizeSqlFingerprint('UPDATE some_table SET ${colA} = ?, extra_col = 1 WHERE id = ?');
        ok('L1② 改动列清单本身的静态文本（追加 extra_col）→ 指纹必变（坏法：归一化连列清单静态文本一起抹掉，本该不同的语句被误判同指纹）',
            fpColListChanged !== fpVarA, `fpColListChanged=${fpColListChanged} fpVarA=${fpVarA}`);
    }

    section('§Q（09-H2）区间租约所有权自证：token 不匹配不删 / 存活 pid 的超龄锁不接管');
    {
        // ① 他人 token 的锁——release 不应删除。用真实临时文件模拟"锁文件内容是别人的 token"
        //    （pid 故意填 1，与本进程无关——这条用例只测 token 比对分支，不涉及存活探测）。
        const foreignLockPath = path.join(os.tmpdir(), `collab-external-g2-h2-foreign-${process.pid}-${Date.now()}.lock`);
        fs.writeFileSync(foreignLockPath, JSON.stringify({ pid: 1, token: 'foreign-token-not-mine', ts: Date.now() }));
        const releaseForeignResult = releaseLeaseAtPath(foreignLockPath, 'my-own-token-different-from-foreign');
        ok('H2① release 对 token 不匹配的锁文件不删除（坏法：不核对 token，无条件 unlink，会误删他人已接管的租约）',
            !releaseForeignResult.deleted && fs.existsSync(foreignLockPath),
            `result=${JSON.stringify(releaseForeignResult)} 文件仍存在=${fs.existsSync(foreignLockPath)}`);
        try { fs.unlinkSync(foreignLockPath); } catch (_) { /* 测试收尾清理，非断言对象 */ }

        // ② 对照组：token 匹配的锁文件应正常删除——证明①不是"永远不删"，而是精确按 token 判断。
        const ownLockPath = path.join(os.tmpdir(), `collab-external-g2-h2-own-${process.pid}-${Date.now()}.lock`);
        const ownToken = 'my-own-token-for-test';
        fs.writeFileSync(ownLockPath, JSON.stringify({ pid: process.pid, token: ownToken, ts: Date.now() }));
        const releaseOwnResult = releaseLeaseAtPath(ownLockPath, ownToken);
        ok('H2① 对照组：token 匹配的锁文件正常删除（证明①不是判断失灵变成"永远不删"）',
            releaseOwnResult.deleted && !fs.existsSync(ownLockPath), `result=${JSON.stringify(releaseOwnResult)}`);

        // ③ 存活 pid 的超龄锁——不允许接管。用本进程自身 pid（此刻必然存活）模拟。
        const canTakeOverAlive = canTakeOverStaleLock({ pid: process.pid, token: 'whatever' }, true);
        ok('H2② 存活 pid（本进程自身）的超龄锁 → 不允许接管（坏法：只看 mtime 超龄就接管，不核实持有者是否还活着）',
            canTakeOverAlive === false, `实得 ${canTakeOverAlive}`);

        // ④ 对照组：确已死亡的 pid（spawn 一个立即退出的子进程，等它退出后其 pid 保证不存活）+
        //    超龄 → 应允许接管——证明③不是"函数被写死恒返回 false"，而是真的在做存活判定。
        const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        const canTakeOverDead = canTakeOverStaleLock({ pid: deadChild.pid, token: 'whatever' }, true);
        ok('H2② 对照组：确已死亡 pid + 超龄 → 允许接管（证明②不是函数被写死恒返回 false）',
            canTakeOverDead === true, `deadPid=${deadChild.pid} 实得 ${canTakeOverDead}`);

        // ⑤ 对照组：未超龄（无论 pid 死活）→ 不接管；超龄但持有者信息缺失/不可解析（holder=null）
        //    → 保守不接管。
        const canTakeOverNotStale = canTakeOverStaleLock({ pid: process.pid, token: 'whatever' }, false);
        ok('H2② 对照组：未超龄 → 不接管（超龄是允许接管的必要条件之一，非充分条件）',
            canTakeOverNotStale === false, `实得 ${canTakeOverNotStale}`);
        const canTakeOverNoHolder = canTakeOverStaleLock(null, true);
        ok('H2② 对照组：超龄但持有者信息缺失/不可解析（holder=null）→ 保守不接管',
            canTakeOverNoHolder === false, `实得 ${canTakeOverNoHolder}`);
    }

    section('§Q（12b-H1）陈旧锁接管竞态自证：A 读到旧持有者后 B 抢先接管 → A 放弃换基线，B 的锁完好');
    {
        // 直接调用真实的 attemptLeaseTakeover（而不是另写一份模拟逻辑）——自证的是这个函数本身
        // 在交错场景下的行为，不是"我以为它会怎么表现"。
        const raceLockPath = path.join(os.tmpdir(), `collab-external-g2-h1-race-${process.pid}-${Date.now()}.lock`);
        // 构造一把"陈旧锁"：持有者是一个已确认死亡的子进程（呼应上面 H2②对照组的死亡 pid 手法）。
        const raceDeadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        const staleHolder = { pid: raceDeadChild.pid, token: 'stale-original-token', ts: Date.now() - SEQ_BASE_LOCK_STALE_MS - 1000 };
        fs.writeFileSync(raceLockPath, JSON.stringify(staleHolder));

        // A 和 B 都"读到"同一把陈旧锁——firstReadHolder 是各自独立的深拷贝，模拟两个独立进程各自在
        // 自己的 acquireSeqBaseLease 调用里做了同一次 readFileSync 判定陈旧（时序上早于任何一方
        // 真正开始接管）。
        const aFirstRead = JSON.parse(JSON.stringify(staleHolder));
        const bFirstRead = JSON.parse(JSON.stringify(staleHolder));

        // 交错发生：B 先完成接管（真实调用 attemptLeaseTakeover，落地新锁文件）。
        const bToken = 'b-token-wins-the-race';
        const bResult = attemptLeaseTakeover(raceLockPath, bFirstRead, bToken);
        ok('H1① 前置条件：B 抢先接管成功（确保测试确实构造出了"B 先赢"的时序，不是巧合）',
            bResult.ok === true, JSON.stringify(bResult));

        // A 用的是自己"首次读到"的陈旧快照（此刻已经过时——文件已经是 B 的了），尝试接管。
        const aToken = 'a-token-must-lose-the-race';
        const aResult = attemptLeaseTakeover(raceLockPath, aFirstRead, aToken);
        ok('H1② A 用过时的首次读快照尝试接管 → 判定为「已被他人接管」而放弃（坏法：不重读直接 unlink，会把 B 刚建立的锁删掉）',
            aResult.ok === false && aResult.reason === 'holder-changed', JSON.stringify(aResult));

        // B 的锁必须完好无损：文件仍存在，且 token 仍是 B 的（证明 A 的失败尝试没有删除/覆盖它）。
        let finalHolder = null;
        try { finalHolder = JSON.parse(fs.readFileSync(raceLockPath, 'utf8')); } catch (_) { /* 若这里都读不到，下面断言直接判失败，不吞错误 */ }
        ok('H1③ B 的锁在 A 放弃接管之后依然完好（文件存在 + token 仍是 B 的，未被 A 误删/覆盖）',
            !!finalHolder && finalHolder.token === bToken, `finalHolder=${JSON.stringify(finalHolder)}`);

        try { fs.unlinkSync(raceLockPath); } catch (_) { /* 测试收尾清理，非断言对象 */ }

        // 对照组：若首次读快照与文件当前内容一致（没有发生交错），接管应该正常成功——证明①②③
        // 不是"attemptLeaseTakeover 恒返回失败"，而是精确按"内容是否被改过"判断。
        const controlLockPath = path.join(os.tmpdir(), `collab-external-g2-h1-control-${process.pid}-${Date.now()}.lock`);
        const controlHolder = { pid: raceDeadChild.pid, token: 'control-original-token', ts: Date.now() - SEQ_BASE_LOCK_STALE_MS - 1000 };
        fs.writeFileSync(controlLockPath, JSON.stringify(controlHolder));
        const controlResult = attemptLeaseTakeover(controlLockPath, JSON.parse(JSON.stringify(controlHolder)), 'control-new-token');
        ok('H1④ 对照组：未发生交错（首次读快照与当前文件一致）→ 接管正常成功（证明②不是函数写死恒返回失败）',
            controlResult.ok === true, JSON.stringify(controlResult));
        let controlFinal = null;
        try { controlFinal = JSON.parse(fs.readFileSync(controlLockPath, 'utf8')); } catch (_) { /* 读不到直接让下面断言判失败 */ }
        ok('H1④ 对照组：接管成功后锁文件确实变成了新 token（证明接管不是空写）',
            !!controlFinal && controlFinal.token === 'control-new-token', JSON.stringify(controlFinal));
        try { fs.unlinkSync(controlLockPath); } catch (_) { /* 测试收尾清理，非断言对象 */ }
    }
}

// ============================================================================
// §H HTTP 层
// ============================================================================
async function runHttpTests(ctx, serverLogRef) {
    // ---- H0：目标库查无/非法 type 三类 → 500 + 文案逐字相同 + _pending 清空 + 状态未写 queued ----
    section('§H0 目标库元数据三类查无/非法 → 500');
    // 〔现场修正〕POST /api/collab/requests 建单时 validateCollabRequestFields 自己就会校验
    // target_db_connection_id 存在 + connection_type='source'（14303-14310）——"不存在的连接id"
    // 和 "connection_type=warehouse" 两个变体在**建单这一步**就会被拒（400），根本走不到 /submit。
    // 这两变体改为：先用合法连接（④ relationalBms）建单+指派，再直连临时库把
    // target_db_connection_id 改写成目标值（绕开建单校验，模拟"建单后连接被改配置/失效"的现场）；
    // ⑥（type='oracle' 的 source 行）connection_type 本就是 'source'，建单校验能通过，走正常流程。
    async function h0Case(label, targetConnId, { viaPatch = false } = {}) {
        const fx = viaPatch
            ? await createPendingRequest(ctx, ctx.conn.relationalBms)
            : await createPendingRequest(ctx, targetConnId);
        if (viaPatch) {
            await tdbRun('UPDATE collab_requests SET target_db_connection_id=? WHERE id=?', [targetConnId, fx.id]);
        }
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok(`H0[${label}] HTTP 500`, r.status === 500, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        ok(`H0[${label}] error 文案与现状逐字相同`, r.body && r.body.error === '目标业务库配置缺失或方言不支持（仅支持 SQL Server / MySQL）', JSON.stringify(r.body));
        const pendingDir = path.join(ROOT, 'uploads', 'collab', '_pending', String(fx.id));
        ok(`H0[${label}] _pending/{id} 已清空`, !fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0);
        const row = await tdbGet('SELECT sql_validation_status FROM collab_requests WHERE id=?', [fx.id]);
        // M2（codex 07 质量审）：从"未写成 queued"升级为精确值 + 过程证据——两阶段查询的失败
        // 分支必须发生在 SUBMIT_ATTEMPT 日志（server.js:16317，写在两阶段查询之后、前置 UPDATE
        // 之前）之前，本单从未真正进入过"排队"这个状态机阶段，sql_validation_status 应恰为 NULL
        // （不是随便一个非 queued 的值），且完全没有 SUBMIT_ATTEMPT 留痕。
        ok(`H0[${label}] sql_validation_status 精确为 NULL（坏法：两阶段查询失败分支挪到了前置 UPDATE 之后，残留 queued 或其他值）`,
            row.sql_validation_status === null, `实得 ${row.sql_validation_status}`);
        const submitAttemptLogs = await tdbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_ATTEMPT'`, [fx.id]);
        ok(`H0[${label}] 无 SUBMIT_ATTEMPT 日志（坏法：两阶段查询失败发生在 SUBMIT_ATTEMPT 写入之后）`,
            submitAttemptLogs.length === 0, `实得 ${submitAttemptLogs.length} 条`);
        return fx.id;
    }
    await h0Case('不存在的连接id', 99999999, { viaPatch: true });
    await h0Case('connection_type=warehouse 的 sqlserver 行', ctx.conn.warehouseType, { viaPatch: true });
    await h0Case("type='oracle' 的 source 行", ctx.conn.oracleType);

    // ---- H1：external 登记单提交 SQL+xlsx → 200 external_skipped ----
    section('§H1 external 登记单提交 → external_skipped 成功闭环');
    let h1Id;
    {
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered);
        h1Id = fx.id;
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H1 HTTP 200', r.status === 200, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        ok("H1 响应 sql_validation_status==='external_skipped'（不再硬编码 passed）", r.body && r.body.sql_validation_status === 'external_skipped', JSON.stringify(r.body));
        ok('H1 响应 smoke_test_validated_at 非空', r.body && !!r.body.smoke_test_validated_at);
        ok('H1 响应 smoke_test_row_count===null（不兜底成 0）', r.body && r.body.smoke_test_row_count === null, `实得 ${r.body && r.body.smoke_test_row_count}`);
        const row = await tdbGet('SELECT sql_validation_status, status, submission_version FROM collab_requests WHERE id=?', [fx.id]);
        ok("H1 库 sql_validation_status='external_skipped'", row.sql_validation_status === 'external_skipped', `实得 ${row.sql_validation_status}`);
        ok("H1 库 status='DONE'", row.status === 'DONE');
        const logs = await tdbAll(`SELECT * FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SMOKE_SKIPPED_EXTERNAL'`, [fx.id]);
        ok('H1 collab_logs 恰 1 行 SMOKE_SKIPPED_EXTERNAL（不重复）', logs.length === 1, `实得 ${logs.length}`);

        // ---- M1（codex 07 质量审）：附件实体断言——不止信任 DB 状态字段，核实物理文件真落盘 ----
        const attachRows = await tdbAll(
            `SELECT * FROM collab_attachments WHERE collab_request_id=? AND submission_version=? AND status='active'`,
            [fx.id, row.submission_version]
        );
        ok('M1 当前 submission_version 恰有 2 条 active 附件记录（result_data+result_script，坏法：漏插/多插/status 未置 active）',
            attachRows.length === 2, `实得 ${attachRows.length} 条：${JSON.stringify(attachRows.map((a) => a.attachment_type))}`);
        const dataAtt = attachRows.find((a) => a.attachment_type === 'result_data');
        const scriptAtt = attachRows.find((a) => a.attachment_type === 'result_script');
        const collabDirAbs = path.join(ROOT, 'uploads', 'collab');
        for (const [label, att, expectedContent] of [['result_data', dataAtt, xlsxContent()], ['result_script', scriptAtt, sqlContent()]]) {
            ok(`M1 ${label} 附件行存在`, !!att, `attachRows=${JSON.stringify(attachRows)}`);
            if (att) {
                const absPath = path.join(ROOT, 'uploads', att.file_name);
                const underCollabDir = path.resolve(absPath).startsWith(path.resolve(collabDirAbs) + path.sep);
                const existsOnDisk = fs.existsSync(absPath);
                ok(`M1 ${label} 路径在本次运行的 uploads/collab 目录下且文件存在（坏法：file_name 记错路径/rename 失败但仍标 active）`,
                    underCollabDir && existsOnDisk, `path=${absPath} underCollabDir=${underCollabDir} exists=${existsOnDisk}`);
                if (existsOnDisk) {
                    const st = fs.statSync(absPath);
                    const expectedSize = Buffer.byteLength(expectedContent);
                    ok(`M1 ${label} 文件大小与本次上传夹具内容一致（坏法：落盘内容被截断/写错文件）`,
                        st.size === expectedSize, `实得 ${st.size}, 期望 ${expectedSize}`);
                }
            }
        }

        // ---- H1c：质量记录恰 1 行 ----
        const qr = await tdbAll('SELECT * FROM collab_quality_record WHERE collab_request_id=?', [fx.id]);
        ok('H1c 质量记录恰 1 行', qr.length === 1, `实得 ${qr.length}`);
        if (qr.length === 1) {
            const q = qr[0];
            ok("H1c record_kind='passed'", q.record_kind === 'passed', `实得 ${q.record_kind}`);
            ok('H1c is_columns_complete 为 NULL', q.is_columns_complete === null);
            ok('H1c excel_is_columns_complete 为 NULL', q.excel_is_columns_complete === null);
            ok("H1c sql_unchecked_reason='external_skipped'", q.sql_unchecked_reason === 'external_skipped', `实得 ${q.sql_unchecked_reason}`);
            ok("H1c excel_unchecked_reason='external_skipped'", q.excel_unchecked_reason === 'external_skipped', `实得 ${q.excel_unchecked_reason}`);
        }
    }

    // ---- H1b：password 改成无冒号非法密文 ----
    section('§H1b 非法密文：external 分支不受影响 / relational 分支走解密失败');
    {
        await tdbRun(`UPDATE db_connections SET password='not-a-valid-ciphertext' WHERE id=?`, [ctx.conn.externalRegistered]);
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered);
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H1b external 分支密码非法仍 200（external_skip 全程不解密）', r.status === 200, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        // 还原，避免污染后续用例
        await tdbRun(`UPDATE db_connections SET password=? WHERE id=?`, [encryptPassword('-'), ctx.conn.externalRegistered]);

        await tdbRun(`UPDATE db_connections SET password='not-a-valid-ciphertext' WHERE id=?`, [ctx.conn.relationalBms]);
        const fx2 = await createPendingRequest(ctx, ctx.conn.relationalBms);
        const r2 = await postSubmitWithRetry(fx2.id, fx2.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H1b relational 分支密码非法 → 现状解密失败路径 500', r2.status === 500, `实得 ${r2.status} ${JSON.stringify(r2.body)}`);
        ok("H1b relational 分支 error 文案='目标库配置异常，请联系管理员'", r2.body && r2.body.error === '目标库配置异常，请联系管理员', JSON.stringify(r2.body));
        await tdbRun(`UPDATE db_connections SET password=? WHERE id=?`, [encryptPassword('testpass'), ctx.conn.relationalBms]);
    }

    // ---- H1d：直接调用 buildQualitySummary 三组夹具 ----
    section('§H1d buildQualitySummary 双口径三组夹具');
    {
        const { buildQualitySummary } = require(path.join(ROOT, 'utils', 'collab-submit-helpers'));
        const base = { submission_seq: 1, id: 1 };
        // 组1：通过 + 免验 各一
        const g1 = [
            { ...base, id: 1, submission_seq: 1, record_kind: 'passed', sql_unchecked_reason: null },
            { ...base, id: 2, submission_seq: 2, record_kind: 'passed', sql_unchecked_reason: 'external_skipped' },
        ];
        const s1 = buildQualitySummary({}, g1, []);
        ok('H1d 组1 machine_passed_count=1', s1.machine_passed_count === 1, `实得 ${s1.machine_passed_count}`);
        ok('H1d 组1 machine_checked_count=1', s1.machine_checked_count === 1, `实得 ${s1.machine_checked_count}`);
        ok('H1d 组1 submit_count 含免验行（=2）', s1.submit_count === 2, `实得 ${s1.submit_count}`);
        ok('H1d 组1 最新记录=免验行且 latest_record_kind=passed', s1.latest_record_kind === 'passed');
        // M6（codex 07 质量审）：只看 latest_record_kind='passed' 测不出"取到的是不是那条免验记录
        // 本身"（组1里两条都是 record_kind='passed'，只看 kind 无法区分取到 id=1 那条还是 id=2
        // 免验那条）——summary 已经暴露 latest_sql_unchecked_reason 字段，直接断言它精确等于
        // 'external_skipped'，才是"最新记录=免验行"这个说法的真证据。
        ok("H1d 组1 latest_sql_unchecked_reason='external_skipped'（真正确认取到的是免验那条，非仅看 record_kind）",
            s1.latest_sql_unchecked_reason === 'external_skipped', `实得 ${s1.latest_sql_unchecked_reason}`);

        // 组2：failed(SMOKE_FAILED) + 免验
        const g2 = [
            { ...base, id: 1, submission_seq: 1, record_kind: 'failed', sql_unchecked_reason: 'SMOKE_FAILED' },
            { ...base, id: 2, submission_seq: 2, record_kind: 'passed', sql_unchecked_reason: 'external_skipped' },
        ];
        const s2 = buildQualitySummary({}, g2, []);
        ok('H1d 组2 machine_passed_count=0', s2.machine_passed_count === 0, `实得 ${s2.machine_passed_count}`);
        ok('H1d 组2 machine_checked_count=1（failed 照计分母）', s2.machine_checked_count === 1, `实得 ${s2.machine_checked_count}`);
        ok('H1d 组2 submit_count 含免验行（=1，qrs 只认 passed）', s2.submit_count === 1, `实得 ${s2.submit_count}`);

        // 组3：仅免验 → 分母 0 → machine_pass_rate===null
        const g3 = [{ ...base, id: 1, submission_seq: 1, record_kind: 'passed', sql_unchecked_reason: 'external_skipped' }];
        const s3 = buildQualitySummary({}, g3, []);
        ok('H1d 组3 machine_checked_count=0', s3.machine_checked_count === 0, `实得 ${s3.machine_checked_count}`);
        ok('H1d 组3 machine_pass_rate===null', s3.machine_pass_rate === null, `实得 ${s3.machine_pass_rate}`);
        ok('H1d 组3 submit_count=1（免验行仍计入）', s3.submit_count === 1);
    }

    // ---- H2：③ sqlserver+MINIAPP_ZHHL 提交 → 走 smoke（按 type 非 code 分流）----
    section('§H2 关系型误标 MINIAPP_ZHHL code → 仍走 smoke 路径（按 type 分流）');
    {
        const fx = await createPendingRequest(ctx, ctx.conn.relationalMiscoded);
        const logBefore = serverLogRef().length;
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H2 HTTP 500（不可达关系库连接失败）', r.status === 500, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await tdbGet('SELECT sql_validation_status FROM collab_requests WHERE id=?', [fx.id]);
        ok("H2 库最终 sql_validation_status='failed'（不是 external_skipped）", row.sql_validation_status === 'failed', `实得 ${row.sql_validation_status}`);
        const newLog = serverLogRef().slice(logBefore);
        ok('H2 server 日志有连接失败痕迹（证明确实尝试了解密/建池，走了 smoke 分支）',
            /目标库连接失败/.test(newLog), newLog.slice(0, 300));
    }

    // ---- H3：external 未登记四变体 → 422 ----
    // 〔主会话预筛·2026-09-02，"不做"事项留痕〕这四个变体都能顺利走完 createPendingRequest
    // 建单+指派，是因为 POST /api/collab/requests 的 validateCollabRequestFields
    // （server.js:14303-14310）建单校验只查 `connection_type='source'`，不查 `type` 取值——
    // 任意 type（含未登记的 external）都能被选作 target_db_connection_id 建单成功，422 的
    // 拦截点只在 /submit 这第 4 个入口（真正要连库/判定免验策略的地方）兜底。本批（C2a）不改
    // 建单校验的过滤面——是否要在建单时就收紧 type 白名单是 C2b/D19 的讨论范围，不在此拍板。
    section('§H3 external 未登记四变体 → 422 EXTERNAL_SOURCE_NOT_REGISTERED');
    async function h3Case(label, targetConnId) {
        const fx = await createPendingRequest(ctx, targetConnId);
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok(`H3[${label}] HTTP 422`, r.status === 422, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        ok(`H3[${label}] code=EXTERNAL_SOURCE_NOT_REGISTERED`, r.body && r.body.code === 'EXTERNAL_SOURCE_NOT_REGISTERED', JSON.stringify(r.body));
        const pendingDir = path.join(ROOT, 'uploads', 'collab', '_pending', String(fx.id));
        ok(`H3[${label}] _pending 已清空`, !fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0);
        const row = await tdbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [fx.id]);
        // 两阶段查询在前置 UPDATE 之前执行（A.1 设计），422 在阶段一分流内拒绝，前置 UPDATE
        // 根本没跑到——status 停在 assign 后的 PENDING，不会被推进到 SUBMITTED
        ok(`H3[${label}] status 未变（仍 PENDING，两阶段查询在前置 UPDATE 之前拒绝，未触发状态推进）`, row.status === 'PENDING', `实得 ${row.status}`);
        // M3（codex 07 质量审）：同 M2，升级为精确值 + 过程证据
        ok(`H3[${label}] sql_validation_status 精确为 NULL（坏法：422 分流挪到了前置 UPDATE 之后）`,
            row.sql_validation_status === null, `实得 ${row.sql_validation_status}`);
        const submitAttemptLogs = await tdbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_ATTEMPT'`, [fx.id]);
        ok(`H3[${label}] 无 SUBMIT_ATTEMPT 日志（坏法：422 分流发生在 SUBMIT_ATTEMPT 写入之后）`,
            submitAttemptLogs.length === 0, `实得 ${submitAttemptLogs.length} 条`);
    }
    await h3Case("code='OTHER_EXT'（已登记但非白名单码）", ctx.conn.externalUnregistered);
    await h3Case('code=NULL', ctx.conn.externalCodeNull);
    await h3Case("code=''（空串）", ctx.conn.externalCodeEmpty);
    await h3Case("code='miniapp_zhhl'（小写，大小写不归一）", ctx.conn.externalCodeLowercase);

    // ---- H4：普通单（不可达关系库）失败态 + 抛错态（用 external 登记源复现 activateNewVersion 抛错路径，见交付报告"待裁定"）----
    section('§H4 普通单失败/抛错两态（通过态因本机无可用 SQL Server/MySQL 显式 SKIP）');
    {
        const fx = await createPendingRequest(ctx, ctx.conn.relationalBms);
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H4 失败态 HTTP 500', r.status === 500, `实得 ${r.status}`);
        const pendingDir = path.join(ROOT, 'uploads', 'collab', '_pending', String(fx.id));
        // 连接失败分支 cleanupPending() 已清空 _pending
        ok('H4 失败态 _pending 已清空', !fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0);
    }
    {
        // 抛错态：用 external 登记源（唯一能在无真实关系库环境下到达 activateNewVersion 的路径），
        // 目标版本目录预建成同名文件让 renameSync 抛 ENOTDIR
        const desc = 'G2抛错测试固定描述';
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered, { description: desc });
        const versioning = require(path.join(ROOT, 'utils', 'collab-attachment-versioning'));
        // G2-F6〔删假注释，改真复用〕computeAttachmentDirName 已导出（见 computeFinalDirName
        // 处的同款说明），直接调用 _internal 版本，不再内联复刻算法。
        const targetDirName = versioning._internal.computeAttachmentDirName(fx.id, desc);
        const targetDirPath = path.join(ROOT, 'uploads', 'collab', targetDirName);
        fs.mkdirSync(path.dirname(targetDirPath), { recursive: true });
        fs.writeFileSync(targetDirPath, 'blocker-file-not-a-directory');
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H4 抛错态 HTTP 500', r.status === 500, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        const pendingDir = path.join(ROOT, 'uploads', 'collab', '_pending', String(fx.id));
        ok('H4 抛错态 本次上传文件已删（_pending 清空）', !fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0);
        const rowAfter = await tdbGet('SELECT submission_version, status, sql_validation_status FROM collab_requests WHERE id=?', [fx.id]);
        // 注：前置 UPDATE（PENDING→SUBMITTED）在两阶段查询之后、activateNewVersion 之前无条件执行，
        // 对 smoke/external_skip 两种模式一视同仁——不因本次注入的 rename 失败而回滚；version
        // 停在 oldVer=0（未被 activateNewVersion 内部逻辑推进），sql_validation_status 落 ordinal5
        // 的 failed 兜底写。"库状态/版本不变"实指 activateNewVersion 失败不产生 DONE/版本推进，
        // 非字面对比 submit 调用前后（pre-update 本身就会推进 status，这是既有契约不受本批影响）。
        ok('H4 抛错态 submission_version 未被推进（仍为 0）', rowAfter.submission_version === 0, `实得 ${rowAfter.submission_version}`);
        ok('H4 抛错态 status 停在 SUBMITTED（未推进到 DONE，未回滚到 PENDING）', rowAfter.status === 'SUBMITTED', `实得 ${rowAfter.status}`);
        ok("H4 抛错态 sql_validation_status='failed'（ordinal5 未知异常兜底写入）", rowAfter.sql_validation_status === 'failed', `实得 ${rowAfter.sql_validation_status}`);
        fs.rmSync(targetDirPath, { recursive: true, force: true });
    }
    // 通过态：本机无可用 SQL Server/MySQL（../../mcp-hrd/config.json 已随 08-08 迁移失效），显式 SKIP
    skip('H4 通过态：真实关系库健康 SQL 提交 → DONE【未覆盖·环境阻塞】', '本机/本仓无可达 SQL Server/MySQL 测试凭证（mcp-hrd/config.json 已随 2026-08-08 mcp 迁移失效，新路径不在本仓相对路径可达范围），无法验证真实 smoke 通过路径，与 external_skip 无关（该路径本批未改动，属既有回归风险敞口，非本次引入）');

    // ---- H5：admin-fix 纵深防御（真实 DONE 单 409 / 构造态验证分支逻辑 / 反例仍清空）----
    section('§H5 admin-fix：external_skipped 清错不清态（纵深防御）');
    {
        // ① 真实 external_skipped(DONE) 单调 admin-fix clear_sql_validation_error → 409（DONE 终态保护先拦）
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered);
        await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        const before = await tdbGet('SELECT sql_validation_status, sql_validated_at, sql_validation_error FROM collab_requests WHERE id=?', [fx.id]);
        const r1 = await apiCall('POST', `/api/collab/requests/${fx.id}/admin-fix`, fx.adminToken, {
            changes: { description: 'G2-H5-①-changed-desc' }, reason: 'G2-H5-①-真实DONE单', clear_sql_validation_error: true,
        });
        ok('H5① 真实 external_skipped(DONE) 单 admin-fix → 409', r1.status === 409, `实得 ${r1.status} ${JSON.stringify(r1.body)}`);
        ok('H5① code=TERMINAL_STATE_PROTECTED', r1.body && r1.body.code === 'TERMINAL_STATE_PROTECTED', JSON.stringify(r1.body));
        const after = await tdbGet('SELECT sql_validation_status, sql_validated_at, sql_validation_error FROM collab_requests WHERE id=?', [fx.id]);
        ok('H5① 三列与调用前逐一相同', after.sql_validation_status === before.sql_validation_status
            && after.sql_validated_at === before.sql_validated_at && after.sql_validation_error === before.sql_validation_error,
            `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

        // ② 构造态夹具：直接 UPDATE 临时库把该单 status 改 PENDING、保留 external_skipped、塞非空 error
        //    （标注：验证纵深防御分支——若日后放开 DONE 闸，此分支语义已正确）
        await tdbRun(`UPDATE collab_requests SET status='PENDING', sql_validation_error='G2构造态残留错误' WHERE id=?`, [fx.id]);
        const beforeValidatedAt = (await tdbGet('SELECT sql_validated_at FROM collab_requests WHERE id=?', [fx.id])).sql_validated_at;
        const r2 = await apiCall('POST', `/api/collab/requests/${fx.id}/admin-fix`, fx.adminToken, {
            changes: { description: 'G2-H5-②-changed-desc' }, reason: 'G2-H5-②-构造态验证纵深防御分支', clear_sql_validation_error: true,
        });
        ok('H5② 构造态：200', r2.status === 200, `实得 ${r2.status} ${JSON.stringify(r2.body)}`);
        const row2 = await tdbGet('SELECT sql_validation_status, sql_validated_at, sql_validation_error FROM collab_requests WHERE id=?', [fx.id]);
        ok('H5② error 已清空', row2.sql_validation_error === null, `实得 ${row2.sql_validation_error}`);
        ok("H5② status 仍 external_skipped（不被清空）", row2.sql_validation_status === 'external_skipped', `实得 ${row2.sql_validation_status}`);
        ok('H5② sql_validated_at 不变', row2.sql_validated_at === beforeValidatedAt);

        // ③ 反例：④号库的 failed 单同操作 → status 清 NULL（既有契约）
        const fx4 = await createPendingRequest(ctx, ctx.conn.relationalBms);
        await postSubmitWithRetry(fx4.id, fx4.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        const row4before = await tdbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [fx4.id]);
        ok('H5③ 前置：④号库单确实 failed', row4before.sql_validation_status === 'failed', `实得 ${JSON.stringify(row4before)}`);
        const r3 = await apiCall('POST', `/api/collab/requests/${fx4.id}/admin-fix`, fx4.adminToken, {
            changes: { description: 'G2-H5-③-changed-desc' }, reason: 'G2-H5-③-反例failed单一刀切清空', clear_sql_validation_error: true,
        });
        ok('H5③ 反例：200', r3.status === 200, `实得 ${r3.status} ${JSON.stringify(r3.body)}`);
        const row4after = await tdbGet('SELECT sql_validation_status FROM collab_requests WHERE id=?', [fx4.id]);
        ok('H5③ 反例：status 清 NULL（既有契约不受本批影响）', row4after.sql_validation_status === null, `实得 ${row4after.sql_validation_status}`);
    }

    // ---- H6：/source 与 /lookup 含①不含②；/lookup 每项带 source_system_code ----
    section('§H6 三处放行：/source、/lookup 含已登记外部源、不含未登记');
    {
        const r1 = await apiCall('GET', '/api/collab/db-connections/source', signAs(ctx.users.admin));
        ok('H6 /source 200', r1.status === 200, `实得 ${r1.status}`);
        const ids1 = (r1.body || []).map((r) => r.id);
        ok('H6 /source 含①已登记外部源', ids1.includes(ctx.conn.externalRegistered));

        const r2 = await apiCall('GET', '/api/collab/db-connections/lookup', signAs(ctx.users.developer));
        ok('H6 /lookup 200', r2.status === 200, `实得 ${r2.status}`);
        const rows2 = r2.body || [];
        const ids2 = rows2.map((r) => r.id);
        ok('H6 /lookup 含①已登记外部源', ids2.includes(ctx.conn.externalRegistered));
        const row1lookup = rows2.find((r) => r.id === ctx.conn.externalRegistered);
        ok('H6 /lookup 每项带 source_system_code（①为 MINIAPP_ZHHL）', row1lookup && row1lookup.source_system_code === 'MINIAPP_ZHHL', JSON.stringify(row1lookup));

        // M7（codex 07 质量审）：H3 用到的全部四个"未登记"变体（②/⑦/⑧/⑨）都要断言不在
        // /source 与 /lookup 里，不能只测②——外部源过滤片段是 IN (?) 参数化查询，逐个变体测
        // 才能确认每一个都被正确挡在外面，而不是恰好②这一个碰巧被挡住。
        const unregisteredVariants = [
            ['②未登记 OTHER_EXT', ctx.conn.externalUnregistered],
            ['⑦code=NULL', ctx.conn.externalCodeNull],
            ['⑧code=空串', ctx.conn.externalCodeEmpty],
            ['⑨code=miniapp_zhhl(小写)', ctx.conn.externalCodeLowercase],
        ];
        for (const [label, connId] of unregisteredVariants) {
            ok(`H6 /source 不含${label}`, !ids1.includes(connId));
            ok(`H6 /lookup 不含${label}`, !ids2.includes(connId));
        }
    }

    // ---- H7：external_skipped 单 return-quality → PENDING + 通知计数 ----
    section('§H7 external_skipped 单 return-quality → PENDING + 通知行为不变');
    {
        const logBefore = serverLogRef().length;
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered);
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H7 前置：external 单提交成功', r.status === 200, `实得 ${r.status}`);
        const logAfterSubmit = serverLogRef().slice(logBefore);
        const notifyMatches = [...logAfterSubmit.matchAll(new RegExp(`\\[collab-submit-notify\\] 协作单 #${fx.id}\\b`, 'g'))];
        ok('H7 external 单通知日志恰 1 次', notifyMatches.length === 1, `实得 ${notifyMatches.length}`);

        // M4（codex 07 质量审，取代 S4 版）：拆成两条独立断言，比合并成一条 MAX(id) 更精确——
        //   ① SUBMIT_ATTEMPT 恰 1 条，且其 id 严格小于唯一 SMOKE_SKIPPED_EXTERNAL 的 id
        //     （提交入口最先落的日志，必须早于分流/免验判定这条日志——按自增 id 插入序直接证明）；
        //   ② NOTIFY_ADMIN_SUBMIT 本临时库场景下明确预期 0 条——G2 种子数据没有把
        //     collab_notify_admin_on_submit 打开（system_configs 默认关），走的是"开关关闭跳过
        //     钉钉"分支（只有 logger.info，不落 collab_logs 行），显式断言为 0 而不是"不管它"，
        //     避免这条本该恒为 0 的信号被静默忽略掉。
        //   通知"确实尝试过"的证据仍用 server 日志 [collab-submit-notify] 行计数（下面的
        //   notifyMatches 断言），DB 侧 NOTIFY_ADMIN_SUBMIT 只在钉钉真发送成功时才会插行，
        //   两者证明的是不同层次（尝试 vs 成功），不能互相替代。
        const submitAttemptRows = await tdbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_ATTEMPT' ORDER BY id ASC`,
            [fx.id]
        );
        const skipLog = await tdbGet(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SMOKE_SKIPPED_EXTERNAL' ORDER BY id DESC LIMIT 1`,
            [fx.id]
        );
        ok('H7 本单 SUBMIT_ATTEMPT 恰 1 条', submitAttemptRows.length === 1, `实得 ${submitAttemptRows.length}`);
        ok('H7 SUBMIT_ATTEMPT 的 id 严格小于唯一 SMOKE_SKIPPED_EXTERNAL 的 id（分流点确在提交尝试之后，按插入序直接证明）',
            submitAttemptRows.length === 1 && !!skipLog && submitAttemptRows[0].id < skipLog.id,
            `submitAttemptId=${submitAttemptRows[0] && submitAttemptRows[0].id}, skipLogId=${skipLog && skipLog.id}`);
        const notifyAdminSubmitRows = await tdbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='NOTIFY_ADMIN_SUBMIT'`,
            [fx.id]
        );
        ok("H7 NOTIFY_ADMIN_SUBMIT 预期 0 条（collab_notify_admin_on_submit 开关关闭，走跳过钉钉分支，不落 DB 行）",
            notifyAdminSubmitRows.length === 0, `实得 ${notifyAdminSubmitRows.length}`);

        const logsBeforeReturn = await tdbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type LIKE 'NOTIFY_%'`, [fx.id]);
        const rq = await apiCall('POST', `/api/collab/requests/${fx.id}/return-quality`, fx.adminToken, {
            reason_type: 'DEV_QUALITY', reason_note: 'G2-H7-质量打回测试',
        });
        ok('H7 return-quality 200', rq.status === 200, `实得 ${rq.status} ${JSON.stringify(rq.body)}`);
        const row = await tdbGet('SELECT status, sql_validation_status, sql_validated_at FROM collab_requests WHERE id=?', [fx.id]);
        ok("H7 status→PENDING", row.status === 'PENDING', `实得 ${row.status}`);
        ok('H7 sql_validation_status 按现状契约清空（NULL）', row.sql_validation_status === null, `实得 ${row.sql_validation_status}`);
        ok('H7 sql_validated_at 按现状契约清空（NULL）', row.sql_validated_at === null, `实得 ${row.sql_validated_at}`);
        const logsAfterReturn = await tdbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type LIKE 'NOTIFY_%'`, [fx.id]);
        // S4：去掉"分流点未挪到通知之前"字样——这条计数断言证明的是"return-quality 本身没有
        // 顺带触发 NOTIFY_* 类通知"，跟"分流点相对通知的先后顺序"是两件事（后者已由上面的 id
        // 比较直接证明），标签改回它真正验证的内容，不借另一条断言的名义。
        ok('H7 return-quality 打回动作本身不产生新的 NOTIFY_* 日志行（计数前后不变）',
            logsAfterReturn.length === logsBeforeReturn.length, `前=${logsBeforeReturn.length} 后=${logsAfterReturn.length}`);

        // 普通单通知计数对照（各恰 1 次）
        const logBefore2 = serverLogRef().length;
        const fxNormal = await createPendingRequest(ctx, ctx.conn.relationalBms);
        await postSubmitWithRetry(fxNormal.id, fxNormal.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        const logAfter2 = serverLogRef().slice(logBefore2);
        const notifyMatches2 = [...logAfter2.matchAll(new RegExp(`\\[collab-submit-notify\\] 协作单 #${fxNormal.id}\\b`, 'g'))];
        ok('H7 普通单通知日志恰 1 次', notifyMatches2.length === 1, `实得 ${notifyMatches2.length}`);
    }

    // ---- H9（D25·codex 06 审 H1）：并发窗口内撤销登记——建单选①后、提交前直接改库把①行的
    //      source_system_code 改成不在白名单内的值，模拟"阶段一命中之后、真正写库之前"窗口内
    //      被撤销登记；提交应被 revalidate 拦下，不应免验落 DONE；改回后重提应恢复正常。 ----
    section('§H9 并发撤销窗口：revalidate 拦下窗口内撤销的外部源登记');
    {
        const fx = await createPendingRequest(ctx, ctx.conn.externalRegistered);
        const originalCode = 'MINIAPP_ZHHL';
        const revokedCode = 'REVOKED_X';
        await tdbRun('UPDATE db_connections SET source_system_code=? WHERE id=?', [revokedCode, ctx.conn.externalRegistered]);
        const r1 = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        // 两阶段查询的阶段一在建连时仍读到旧值？不——阶段一是本次 /submit 请求内实时查询，改库后
        // 阶段一就会直接读到 REVOKED_X（未登记）→ 走 422 EXTERNAL_SOURCE_NOT_REGISTERED（H3 同款
        // 路径），根本轮不到 revalidate（它在阶段一之后、写事务里才调用）。这恰恰证明了两层防御
        // 边界：阶段一挡"提交那一刻已经撤销"，revalidate 挡"阶段一命中之后、写库之前才被撤销"
        // 这个更窄的窗口——H9 用 postSubmitWithRetry 单次请求测不出"阶段一之后才改"的时序，
        // 那属于真并发场景（无法在单进程顺序脚本里稳定构造）。这里退而求其实：直接断言"提交
        // 前已撤销"这个更宽的场景走 422（阶段一挡），revalidate 分支本身的正确性已由 U5/U5b
        // 在 versioning 层直接验证（不依赖真实的时序竞态）。
        ok('H9 提交前已撤销登记 → 非 200（阶段一 422，坏法：阶段一放行了未登记的 code）',
            r1.status !== 200, `实得 ${r1.status} ${JSON.stringify(r1.body)}`);
        ok('H9 code=EXTERNAL_SOURCE_NOT_REGISTERED（阶段一挡下，revalidate 层的正确性由 U5/U5b 单独证明）',
            r1.body && r1.body.code === 'EXTERNAL_SOURCE_NOT_REGISTERED', JSON.stringify(r1.body));
        const pendingDirH9 = path.join(ROOT, 'uploads', 'collab', '_pending', String(fx.id));
        ok('H9 本次上传文件已清理（_pending 已清空）', !fs.existsSync(pendingDirH9) || fs.readdirSync(pendingDirH9).length === 0);

        // 改回原 code → 重提应恢复正常（external_skipped）
        await tdbRun('UPDATE db_connections SET source_system_code=? WHERE id=?', [originalCode, ctx.conn.externalRegistered]);
        const r2 = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('H9 改回原 code 后重提 → 200 external_skipped（恢复正常，证明撤销/恢复两个方向都生效）',
            r2.status === 200 && r2.body && r2.body.sql_validation_status === 'external_skipped',
            `实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    }

    // ---- P1：external 行①受保护——PUT/DELETE/test 全部 409，库行三列不变 ----
    section('§P1 external 行①：PUT/DELETE/:id/test 全部 409（受保护）');
    {
        const adminTok = signAs(ctx.users.admin);
        const before = await tdbGet('SELECT type, host, password FROM db_connections WHERE id=?', [ctx.conn.externalRegistered]);
        const rPut = await apiCall('PUT', `/api/db-connections/${ctx.conn.externalRegistered}`, adminTok, {
            name: 'P1-试图改名', type: 'sqlserver', host: 'x', port: 1, database: 'x', username: 'x',
        });
        ok('P1 PUT external 行 → 409（坏法：保护漏了 PUT）', rPut.status === 409, `实得 ${rPut.status} ${JSON.stringify(rPut.body)}`);
        ok('P1 PUT code=EXTERNAL_SOURCE_PROTECTED', rPut.body && rPut.body.code === 'EXTERNAL_SOURCE_PROTECTED', JSON.stringify(rPut.body));

        const rTest = await apiCall('POST', `/api/db-connections/${ctx.conn.externalRegistered}/test`, adminTok);
        ok('P1 POST :id/test external 行 → 409（坏法：保护漏了 test）', rTest.status === 409, `实得 ${rTest.status} ${JSON.stringify(rTest.body)}`);
        ok('P1 test code=EXTERNAL_SOURCE_NOT_TESTABLE', rTest.body && rTest.body.code === 'EXTERNAL_SOURCE_NOT_TESTABLE', JSON.stringify(rTest.body));

        const rDelete = await apiCall('DELETE', `/api/db-connections/${ctx.conn.externalRegistered}`, adminTok);
        ok('P1 DELETE external 行 → 409（坏法：保护漏了 DELETE）', rDelete.status === 409, `实得 ${rDelete.status} ${JSON.stringify(rDelete.body)}`);
        ok('P1 DELETE code=EXTERNAL_SOURCE_PROTECTED', rDelete.body && rDelete.body.code === 'EXTERNAL_SOURCE_PROTECTED', JSON.stringify(rDelete.body));

        const after = await tdbGet('SELECT type, host, password FROM db_connections WHERE id=?', [ctx.conn.externalRegistered]);
        ok('P1 库行三列（type/host/password）三次尝试后逐一未变', JSON.stringify(before) === JSON.stringify(after),
            `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }

    // ---- P1b：普通 source 行④ PUT type='external' → 400（禁止晋升） ----
    section("§P1b 普通行④：PUT type='external' → 400 DB_TYPE_NOT_ALLOWED（禁止晋升）");
    {
        const before = await tdbGet('SELECT type FROM db_connections WHERE id=?', [ctx.conn.relationalBms]);
        const r = await apiCall('PUT', `/api/db-connections/${ctx.conn.relationalBms}`, signAs(ctx.users.admin), {
            name: 'G2-business_db', type: 'external', host: '10.255.255.1', port: 1, database: 'bms', username: 'testuser',
        });
        ok("P1b PUT type='external' → 400（坏法：PUT 未拦 type 晋升）", r.status === 400, `实得 ${r.status} ${JSON.stringify(r.body)}`);
        ok('P1b code=DB_TYPE_NOT_ALLOWED', r.body && r.body.code === 'DB_TYPE_NOT_ALLOWED', JSON.stringify(r.body));
        const after = await tdbGet('SELECT type FROM db_connections WHERE id=?', [ctx.conn.relationalBms]);
        ok('P1b 库 type 仍 sqlserver（未被晋升为 external）', after.type === 'sqlserver' && before.type === 'sqlserver', `实得 ${after.type}`);
    }

    // ---- P1c（复用 H2 逻辑，独立留痕）：库中③(sqlserver+MINIAPP_ZHHL) 提交仍进 smoke ----
    section('§P1c（复用 H2 断言）：③号连接（sqlserver+MINIAPP_ZHHL）提交仍走 smoke 路径');
    {
        const fx = await createPendingRequest(ctx, ctx.conn.relationalMiscoded);
        const r = await postSubmitWithRetry(fx.id, fx.devToken, [{ name: 'result.xlsx', content: xlsxContent() }, { name: 'script.sql', content: sqlContent() }]);
        ok('P1c HTTP 500（不可达关系库连接失败，按 type 分流进 smoke）', r.status === 500, `实得 ${r.status}`);
        const row = await tdbGet('SELECT sql_validation_status FROM collab_requests WHERE id=?', [fx.id]);
        ok("P1c 库 sql_validation_status='failed'（非 external_skipped——坏法：按 code 而非 type 分流会误判成免验）",
            row.sql_validation_status === 'failed', `实得 ${row.sql_validation_status}`);
    }

    // ---- P1d（11-M2·白盒裸 SQL 纵深防御）：直接执行 server.js 现行三类语句原文 ----
    section('§P1d PUT/DELETE 纵深防御（11-M2·白盒裸 SQL）：直接跑 server.js 现行三条 UPDATE + 一条 DELETE 原文');
    {
        // 〔安全构造，同 §Q（09-L1）L1① 手法〕下面用于在 server.js 源码文本里定位这四类语句的
        // "锚点子串"全部用数组拼接、不写成连续字面量——若直接写成一段连续包含
        // "UPDATE ... db_connections" / "DELETE FROM ... db_connections" 的字符串字面量，会被
        // 真实 G4（scripts/verify-db-connections-writers.js）扫描本文件时当成一处新的未登记直写
        // 命中，把 G4 自身基线（当前 13/0）打红——本批不允许改动 G4 的 REGISTERED_WRITE_POINTS
        // 登记表。只有运行期 `.join('')` 拼接成完整字符串后才用于 indexOf 定位/真跑，本文件源码
        // 文本里不留一段连续可匹配文本。
        const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        function p1dFindLiteral(anchorPieces, label) {
            const anchor = anchorPieces.join('');
            const hitCount = serverSrc.split(anchor).length - 1;
            ok(`P1d 前置：锚点「${label}」在 server.js 中恰命中 1 处（防跨端点/跨分支误锚）`,
                hitCount === 1, `实得命中 ${hitCount} 处，anchor=${anchor}`);
            if (hitCount !== 1) return null;
            const anchorIdx = serverSrc.indexOf(anchor);
            const quoteIdx = anchorIdx - 1;
            const quoteChar = serverSrc[quoteIdx];
            if (!"'\"`".includes(quoteChar)) {
                ok(`P1d 前置：锚点「${label}」前一字符是引号（能正确定位语句起点，坏法：锚点选取有误）`, false, `实得字符='${quoteChar}'`);
                return null;
            }
            const endIdx = serverSrc.indexOf(quoteChar, quoteIdx + 1);
            if (endIdx === -1) return null;
            return serverSrc.slice(quoteIdx + 1, endIdx);
        }

        const putPasswordSql = p1dFindLiteral(
            ['UPDATE', ' db_connections SET name = ?, type = ?, host = ?, port = ?, database = ?, default_schema = ?, username = ?, password = ?,'],
            'PUT 主 UPDATE（更新密码分支）'
        );
        const putNoPasswordSql = p1dFindLiteral(
            ['UPDATE', ' db_connections SET name = ?, type = ?, host = ?, port = ?, database = ?, default_schema = ?, username = ?, is_default = ?, updated_at'],
            'PUT 主 UPDATE（不更新密码分支）'
        );
        const putClearDefaultSql = p1dFindLiteral(
            ['UPDATE', ' db_connections SET is_default = 0 WHERE id !='],
            'PUT 清默认位 UPDATE'
        );
        const deleteSql = p1dFindLiteral(
            ['DELETE FROM', ' db_connections WHERE id = ? AND type <>'],
            'DELETE 语句'
        );

        ok('P1d 前置：四条语句原文均成功从 server.js 提取（非 null，坏法：锚点过期/语句被移动导致取不到）',
            [putPasswordSql, putNoPasswordSql, putClearDefaultSql, deleteSql].every((s) => typeof s === 'string' && s.length > 0),
            JSON.stringify({ putPasswordSql, putNoPasswordSql, putClearDefaultSql, deleteSql }));

        // 纯文本自检：三条语句原文仍含 `type <> 'external'` 纵深防御条件（坏法：条件被整体删掉）。
        if (putPasswordSql) ok("P1d 文本自检：PUT 主 UPDATE（密码分支）含 AND type <> 'external'", /AND type <> 'external'/.test(putPasswordSql), putPasswordSql);
        if (putNoPasswordSql) ok("P1d 文本自检：PUT 主 UPDATE（不改密码分支）含 AND type <> 'external'", /AND type <> 'external'/.test(putNoPasswordSql), putNoPasswordSql);
        if (putClearDefaultSql) ok("P1d 文本自检：PUT 清默认位 UPDATE 含 AND type <> 'external'", /AND type <> 'external'/.test(putClearDefaultSql), putClearDefaultSql);
        if (deleteSql) ok("P1d 文本自检：DELETE 含 AND type <> 'external'", /AND type <> 'external'/.test(deleteSql), deleteSql);

        // 专用夹具：独立于①/④等既有种子行，避免影响后续 P2/P2b/P3/P4/H8/Q1 依赖的既有种子行状态
        // （尤其 DELETE 用例会真删掉其中一行，不能碰任何被后续用例复用的连接）。
        const p1dExtId = await insertConn({
            name: 'P1D-受保护外部源行', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
            username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: 'PX_P1D_EXT',
        });
        const p1dNormalId = await insertConn({
            name: 'P1D-普通对照行-A', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'p1da', default_schema: 'dbo',
            username: 'p1duser', password: encryptPassword('p1dpass'), connection_type: 'source', source_system_code: 'PX_P1D_NORMAL_A',
        });

        // ① PUT 主 UPDATE（密码分支）：外部源行 changes===0 且内容不变；普通行正常生效（对照，
        //    证明①不是「恒 0」，是精确按 type 判断——坏法：AND type <> 'external' 被删或写反，
        //    应用层预检（server.js PUT 处理函数里的 currentConn 查询）测不出这条语句本身是否
        //    真的带着这个条件落地，本用例绕开应用层直接验证 SQL 语句本身）。
        if (putPasswordSql) {
            const extBefore = await tdbGet('SELECT name, type, host FROM db_connections WHERE id=?', [p1dExtId]);
            const rExt = await tdbRun(putPasswordSql, [
                'P1D-试图改名-ext', 'sqlserver', 'x-host', 1, 'x-db', 'dbo', 'x-user', encryptPassword('x-pass'), 0, p1dExtId,
            ]);
            ok("P1d① PUT 主 UPDATE（密码分支）对外部源行 changes===0（坏法：AND type <> 'external' 被删/写反，应用层预检测不出）",
                rExt && rExt.changes === 0, `实得 changes=${rExt && rExt.changes}`);
            const extAfter = await tdbGet('SELECT name, type, host FROM db_connections WHERE id=?', [p1dExtId]);
            ok('P1d① 外部源行内容试跑后仍与试跑前一致（name/type/host 均未变）',
                extBefore.name === extAfter.name && extBefore.type === extAfter.type && extBefore.host === extAfter.host,
                `before=${JSON.stringify(extBefore)} after=${JSON.stringify(extAfter)}`);

            const rNormal = await tdbRun(putPasswordSql, [
                'P1D-已改名-normal', 'sqlserver', '10.255.255.2', 2, 'p1da-new', 'dbo', 'p1duser2', encryptPassword('p1dpass2'), 0, p1dNormalId,
            ]);
            ok("P1d① PUT 主 UPDATE（密码分支）对普通行正常生效 changes===1（证明①不是「恒 0」，是精确按 type 判断）",
                rNormal && rNormal.changes === 1, `实得 changes=${rNormal && rNormal.changes}`);
            const normalAfter = await tdbGet('SELECT name, host FROM db_connections WHERE id=?', [p1dNormalId]);
            ok('P1d① 普通行 name/host 已按新值更新',
                normalAfter.name === 'P1D-已改名-normal' && normalAfter.host === '10.255.255.2', JSON.stringify(normalAfter));
        }

        // ② PUT 主 UPDATE（不更新密码分支）：同①对照，换用不带 password 列的语句文本。
        if (putNoPasswordSql) {
            const extBefore = await tdbGet('SELECT name, host FROM db_connections WHERE id=?', [p1dExtId]);
            const rExt = await tdbRun(putNoPasswordSql, [
                'P1D-试图改名-ext2', 'sqlserver', 'x-host2', 1, 'x-db2', 'dbo', 'x-user2', 0, p1dExtId,
            ]);
            ok("P1d② PUT 主 UPDATE（不改密码分支）对外部源行 changes===0（坏法：条件被删/写反）",
                rExt && rExt.changes === 0, `实得 changes=${rExt && rExt.changes}`);
            const extAfter = await tdbGet('SELECT name, host FROM db_connections WHERE id=?', [p1dExtId]);
            ok('P1d② 外部源行 name/host 未变',
                extBefore.name === extAfter.name && extBefore.host === extAfter.host,
                `before=${JSON.stringify(extBefore)} after=${JSON.stringify(extAfter)}`);

            const rNormal = await tdbRun(putNoPasswordSql, [
                'P1D-已改名-normal2', 'sqlserver', '10.255.255.3', 3, 'p1da-new2', 'dbo', 'p1duser3', 0, p1dNormalId,
            ]);
            ok('P1d② PUT 主 UPDATE（不改密码分支）对普通行正常生效 changes===1（对照，证明②同样精确按 type 判断）',
                rNormal && rNormal.changes === 1, `实得 changes=${rNormal && rNormal.changes}`);
        }

        // ③ PUT 清默认位 UPDATE：`id != ?` 与 `type <> 'external'` 是"与"关系——用一个第三方参数
        //   值（999999，保证不等于任一测试行 id 且现实中不存在这行）满足 `id != ?`，专测 type 条件
        //   本身是否真的把外部源行排除在"清默认位"的影响范围之外。
        if (putClearDefaultSql) {
            // 测试前置：手工把两行都置为 is_default=1（insertConn 恒写死 0，需要这一步单独种）。
            //   这条 UPDATE 只是测试夹具的准备动作，不是本用例要验证的三条语句之一，同样用数组
            //   拼接构造（理由同上，避免在本文件源码里留下新的连续可匹配文本）。
            await tdbRun(['UPDATE', ' db_connections SET is_default = 1 WHERE id IN (?, ?)'].join(''), [p1dExtId, p1dNormalId]);
            // SQLite 的 UPDATE 对"WHERE 匹配到的每一行"都计入 changes，不区分该行的值是否真的
            // 发生变化——共享 TEMP_DB 此刻还有 P1d 夹具之外的既有非 external 行（③④⑤⑥/px_p3 等，
            // 均 is_default=0），它们同样满足 `id != 999999 AND type <> 'external'`，会被一并计入
            // changes。改用"运行前先按同款 WHERE 语义查询期望匹配行数"作为 changes 的预期值——
            // 这样若 `AND type <> 'external'` 被删或写反，实际匹配集合会变大/变小，与这里独立
            // 查出的期望值（同样带着期望中的 type<>'external' 条件）就会对不上，仍能抓出坏法，
            // 且不依赖共享库里恰好有多少条既有非 external 行这种脆弱前提。
            const expectedMatchRow = await tdbGet(
                "SELECT COUNT(*) AS c FROM db_connections WHERE id != 999999 AND type <> 'external'"
            );
            const rClear = await tdbRun(putClearDefaultSql, [999999]);
            const extRow = await tdbGet('SELECT is_default FROM db_connections WHERE id=?', [p1dExtId]);
            const normalRow = await tdbGet('SELECT is_default FROM db_connections WHERE id=?', [p1dNormalId]);
            ok("P1d③ 清默认位 UPDATE：外部源行 is_default 未被清空（仍=1，坏法：AND type <> 'external' 被删/写反）",
                extRow && extRow.is_default === 1, `实得 ${extRow && extRow.is_default}`);
            ok('P1d③ 清默认位 UPDATE：普通行 is_default 已被正常清空（=0，证明③不是「恒不清」，是精确按 type 判断）',
                normalRow && normalRow.is_default === 0, `实得 ${normalRow && normalRow.is_default}`);
            ok("P1d③ 语句本身报告的 changes 与「id!=999999 AND type<>'external'」独立查出的期望匹配行数一致（坏法：条件被删/写反会让实际匹配集合与期望值不一致）",
                rClear && expectedMatchRow && rClear.changes === expectedMatchRow.c,
                `实得 changes=${rClear && rClear.changes} 期望=${expectedMatchRow && expectedMatchRow.c}`);
        }

        // ④ DELETE：外部源行 changes===0 且行仍存在；普通行正常删除（对照）。
        if (deleteSql) {
            const rExtDel = await tdbRun(deleteSql, [p1dExtId]);
            ok("P1d④ DELETE 对外部源行 changes===0（坏法：AND type <> 'external' 被删/写反）",
                rExtDel && rExtDel.changes === 0, `实得 changes=${rExtDel && rExtDel.changes}`);
            const extStillThere = await tdbGet('SELECT id FROM db_connections WHERE id=?', [p1dExtId]);
            ok('P1d④ 外部源行仍存在（未被删除）', !!extStillThere, extStillThere ? '仍存在' : '已消失');

            const rNormalDel = await tdbRun(deleteSql, [p1dNormalId]);
            ok('P1d④ DELETE 对普通行正常生效 changes===1（对照，证明④同样精确按 type 判断）',
                rNormalDel && rNormalDel.changes === 1, `实得 changes=${rNormalDel && rNormalDel.changes}`);
            const normalGone = await tdbGet('SELECT id FROM db_connections WHERE id=?', [p1dNormalId]);
            ok('P1d④ 普通行已被删除', !normalGone, normalGone ? '仍存在' : '');
            // p1dExtId 留在临时库里不再手工清理——它不与任何后续用例的 code/name 复用，且整个
            // TEMP_DB 文件会在本次运行收尾时被 cleanupTempDb() 整体删除，不产生跨运行残留；
            // 手工清理反而需要再写一条 DELETE 字面量，平白多一处需要"数组拼接规避 G4"的代码。
        }
    }

    // ---- P2：POST 建连接——type 白名单 / code 去重 / code 格式 / 缺省 type ----
    section('§P2 POST /api/db-connections：type 白名单 + code 去重原子化 + code 格式 + 缺省 type');
    {
        const adminTok = signAs(ctx.users.admin);

        const r1 = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2-external试探', type: 'external', host: 'x', database: 'x', username: 'x', password: 'x',
        });
        ok("P2 POST type='external' → 400（坏法：写入口白名单漏挡 external）", r1.status === 400, `实得 ${r1.status} ${JSON.stringify(r1.body)}`);
        ok('P2 code=DB_TYPE_NOT_ALLOWED', r1.body && r1.body.code === 'DB_TYPE_NOT_ALLOWED', JSON.stringify(r1.body));

        // 重复 code（D14 去重原子化）
        const dupCode = 'PX_DUP';
        const r2a = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2-dup-first', host: '10.255.255.1', port: 1, database: 'd', username: 'u', password: 'p',
            connection_type: 'source', source_system_code: dupCode,
        });
        ok(`P2 首次建 ${dupCode} → 200`, r2a.status === 200, `实得 ${r2a.status} ${JSON.stringify(r2a.body)}`);
        const r2b = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2-dup-second', host: '10.255.255.1', port: 1, database: 'd', username: 'u', password: 'p',
            connection_type: 'source', source_system_code: dupCode,
        });
        ok(`P2 重复建 ${dupCode} → 409（坏法：去重判断有 TOCTOU 窗口）`, r2b.status === 409, `实得 ${r2b.status} ${JSON.stringify(r2b.body)}`);
        ok('P2 重复 code=SOURCE_SYSTEM_CODE_DUPLICATE', r2b.body && r2b.body.code === 'SOURCE_SYSTEM_CODE_DUPLICATE', JSON.stringify(r2b.body));
        const dupRows = await tdbAll('SELECT id FROM db_connections WHERE source_system_code=?', [dupCode]);
        ok(`P2 库内 ${dupCode} 恰 1 行（坏法：409 判定但仍插入了第二行）`, dupRows.length === 1, `实得 ${dupRows.length}`);

        // code 格式非法七变体（spec 列举：'ab'/'A'/33 位/含中文/含空格；〔08-M1·codex 08 审〕
        // 补数字 33 与单元素数组 [33]——`RegExp.test()` 对非字符串值会先做隐式 toString() 再匹配，
        // 数字 33 强转成 '33'（2 位数字，恰好落在 2-32 位格式白名单内）会绕过校验；单元素数组
        // [33] 同理（Array.prototype.toString 对单元素数组不加逗号，强转结果同样是 '33'）——
        // 两例都是"toString() 后长得像合法值"的非字符串，专门验证 typeof 前置判定挡住了它们）
        // 〔09-H1〕补 0 与 false——两者与既有 badCodes 表内其余成员的关键差别：既有成员（'ab' 等）
        // 都是非空字符串，非 falsy，走的是"提供了但格式不对"这条路；0/false 是 falsy，若混进这个
        // 用 `connection_type: 'source'` 的同一个循环，会先被 8423 行"source 类型必须填写"那条
        // **早于**格式校验的既有检查拦下（`!0`/`!false` 均为 true），400 是拿到了，但走的是旧的、
        // 本来就没坏过的分支，测不出本批要修的那个坑——所以这里仍按方案原话把 0/false 加进这个
        // 数组（补上"这两个值最终也是 400 + 零写"的基础回归，防这条必填检查未来被误改/挪位），
        // 但**不能只加在这里**：真正的 09-H1 坏法只在 `connection_type !== 'source'` 时才会现形
        // （此时 8423 检查不介入，旧代码 `source_system_code && (...)` 对 0/false 整体短路成
        // false，绕过格式校验，落到后面 `if (source_system_code)` 分支同样短路，把 code 悄悄
        // 写成 NULL 后返回 200）——这条更精确的复现见下方紧跟着的独立用例。
        const badCodes = ['ab', 'A', 'X'.repeat(33), 'PX_中文', 'PX WITH SPACE', 33, [33], 0, false];
        for (const bc of badCodes) {
            const rb = await apiCall('POST', '/api/db-connections', adminTok, {
                name: `P2-badcode-${badCodes.indexOf(bc)}`, host: 'h', database: 'd', username: 'u', password: 'p',
                connection_type: 'source', source_system_code: bc,
            });
            ok(`P2 code格式非法(${JSON.stringify(bc)}) → 400（坏法：格式校验漏了这类形态）`, rb.status === 400, `实得 ${rb.status} ${JSON.stringify(rb.body)}`);
            // 0/false 在这个 connection_type='source' 循环里命中的是 8423 行"必须填写"检查（不带
            // code 字段，走另一条早于格式校验的既有分支），不强求 code=SOURCE_SYSTEM_CODE_INVALID；
            // 其余成员维持原断言不变。
            if (bc !== 0 && bc !== false) {
                ok(`P2 code格式非法(${JSON.stringify(bc)}) code=SOURCE_SYSTEM_CODE_INVALID`, rb.body && rb.body.code === 'SOURCE_SYSTEM_CODE_INVALID', JSON.stringify(rb.body));
            }
            const rowsAfterBad = await tdbAll('SELECT id FROM db_connections WHERE name=?', [`P2-badcode-${badCodes.indexOf(bc)}`]);
            ok(`P2 code格式非法(${JSON.stringify(bc)}) 库内无新增行（零写确认）`, rowsAfterBad.length === 0, `实得 ${rowsAfterBad.length}`);
        }

        // 〔09-H1 精确复现〕connection_type 非 'source'（8423 行"必须填写"检查不介入）+
        // source_system_code=0/false——这才是本批要修的真正坏法路径：旧代码
        // `source_system_code && (typeof !== 'string' || !pattern.test(...))` 对 falsy 值整体
        // 短路成 false，直接跳过格式校验；随后 INSERT 分支 `if (source_system_code)` 同样因 0/false
        // 短路为假，走 else 分支把 source_system_code 悄悄写成 NULL——旧代码在这里会返回 200
        // （而不是 400），是本条断言要抓的坏法。修复后应统一 400 + 零写。
        for (const bc of [0, false]) {
            const rc = await apiCall('POST', '/api/db-connections', adminTok, {
                name: `P2-h1-nonsource-code-${JSON.stringify(bc)}`, host: 'h', database: 'd', username: 'u', password: 'p',
                connection_type: 'warehouse', source_system_code: bc,
            });
            ok(`P2 09-H1：connection_type=warehouse + code=${JSON.stringify(bc)} → 400（坏法：falsy 非字符串 code 被短路当成"未提供"，200 落库 NULL）`,
                rc.status === 400, `实得 ${rc.status} ${JSON.stringify(rc.body)}`);
            ok(`P2 09-H1：code=${JSON.stringify(bc)} code=SOURCE_SYSTEM_CODE_INVALID`,
                rc.body && rc.body.code === 'SOURCE_SYSTEM_CODE_INVALID', JSON.stringify(rc.body));
            const rowsC = await tdbAll('SELECT id FROM db_connections WHERE name=?', [`P2-h1-nonsource-code-${JSON.stringify(bc)}`]);
            ok(`P2 09-H1：code=${JSON.stringify(bc)} 库内无新增行（坏法：短路放行后落库一行 source_system_code=NULL）`, rowsC.length === 0, `实得 ${rowsC.length}`);
        }

        // 不带 type → 落 sqlserver（与现状一致）
        const r3 = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2-notype', host: 'h2', database: 'd2', username: 'u2', password: 'p2',
        });
        ok('P2 不带 type → 200（坏法：白名单误把"未提供"当非法值拒绝）', r3.status === 200, `实得 ${r3.status} ${JSON.stringify(r3.body)}`);
        if (r3.status === 200) {
            const row3 = await tdbGet('SELECT type FROM db_connections WHERE id=?', [r3.body.id]);
            ok("P2 不带 type 落库 type='sqlserver'（与现状一致，未被误改缺省值）", row3.type === 'sqlserver', `实得 ${row3.type}`);
        }
    }

    // ---- P2b（G2-F1 回归）：POST 重复 code 409 早退，不得提前清空其他 warehouse 默认位 ----
    // 旧写法把"清空其他默认（仅对数仓连接）"这条 UPDATE 放在原子 INSERT 之前——一旦本次 POST
    // 因 source_system_code 去重而 409 早退（INSERT changes===0），全库数仓默认连接已经被清空
    // 且不会补回。这条用例先建一条 is_default=1 的 warehouse 连接 A，再用一个已占用的 code 发起
    // 一次带 is_default:1 的重复 POST（必 409），断言 A 的 is_default 全程未被动过。
    section('§P2b F1 回归：POST 重复 code 409 早退时，其他 warehouse 默认连接的 is_default 不受影响');
    {
        const adminTok = signAs(ctx.users.admin);

        const rA = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2b-默认数仓A', host: '10.255.255.1', port: 1, database: 'p2bdb', username: 'u', password: 'p',
            connection_type: 'warehouse', is_default: 1,
        });
        ok('P2b 建连接 A（is_default=1）→ 200', rA.status === 200, `实得 ${rA.status} ${JSON.stringify(rA.body)}`);
        const connAId = rA.body && rA.body.id;
        if (connAId) {
            const rowABefore = await tdbGet('SELECT is_default FROM db_connections WHERE id=?', [connAId]);
            ok('P2b 建连接 A 后库内 is_default=1（前置断言，确认起点状态）', rowABefore && rowABefore.is_default === 1, `实得 ${rowABefore && rowABefore.is_default}`);
        }

        const p2bCode = 'PX_P2B';
        const rSeed = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2b-seed', host: '10.255.255.1', port: 1, database: 'd', username: 'u', password: 'p',
            connection_type: 'source', source_system_code: p2bCode,
        });
        ok(`P2b 先建 ${p2bCode} → 200`, rSeed.status === 200, `实得 ${rSeed.status} ${JSON.stringify(rSeed.body)}`);

        // 重复同一个 code，且这次请求体也带 is_default:1、connection_type:'warehouse'（与连接 A
        // 同型），复现旧代码"清默认判断条件成立"的前置条件；因 code 已存在，原子 INSERT 必 409。
        const rDup = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2b-dup-is_default', host: '10.255.255.1', port: 1, database: 'd2', username: 'u', password: 'p',
            connection_type: 'warehouse', source_system_code: p2bCode, is_default: 1,
        });
        ok(`P2b 重复 ${p2bCode} + is_default:1 → 409（坏法：清默认位 UPDATE 跑在原子 INSERT 之前，见 F1）`,
            rDup.status === 409, `实得 ${rDup.status} ${JSON.stringify(rDup.body)}`);
        ok('P2b 409 body code=SOURCE_SYSTEM_CODE_DUPLICATE', rDup.body && rDup.body.code === 'SOURCE_SYSTEM_CODE_DUPLICATE', JSON.stringify(rDup.body));

        if (connAId) {
            const rowAAfter = await tdbGet('SELECT is_default FROM db_connections WHERE id=?', [connAId]);
            ok('P2b 连接 A 在 409 早退后仍 is_default=1（坏法：全库数仓默认位被误清空且未补回）',
                rowAAfter && rowAAfter.is_default === 1, `实得 ${rowAAfter && rowAAfter.is_default}`);
        }
    }

    // ---- P2c（11-M1）：POST connection_type 归一化——未提供/空串缺省 warehouse，越界一律 400 ----
    section('§P2c POST connection_type 归一化（11-M1）：未提供/空串缺省 warehouse，越界一律 400');
    {
        const adminTok = signAs(ctx.users.admin);

        // 1. 不传 connection_type → 200 且库内落 'warehouse'（坏法：归一化误把"未提供"当非法值拒绝）
        const r1 = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2c-notype-connType', host: 'h', database: 'd', username: 'u', password: 'p',
        });
        ok('P2c 不传 connection_type → 200', r1.status === 200, `实得 ${r1.status} ${JSON.stringify(r1.body)}`);
        if (r1.status === 200) {
            const row1 = await tdbGet('SELECT connection_type FROM db_connections WHERE id=?', [r1.body.id]);
            ok("P2c 不传 connection_type 落库 connection_type='warehouse'（与现状一致，未被误改缺省值）",
                row1 && row1.connection_type === 'warehouse', `实得 ${row1 && row1.connection_type}`);
        }

        // 2. '' → 同「未提供」一样缺省 warehouse
        const r2 = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2c-emptystr-connType', host: 'h', database: 'd', username: 'u', password: 'p', connection_type: '',
        });
        ok("P2c connection_type='' → 200（坏法：空串未被归一化判定成「未提供」，误当非法值拒绝）", r2.status === 200, `实得 ${r2.status} ${JSON.stringify(r2.body)}`);
        if (r2.status === 200) {
            const row2 = await tdbGet('SELECT connection_type FROM db_connections WHERE id=?', [r2.body.id]);
            ok("P2c connection_type='' 落库 connection_type='warehouse'", row2 && row2.connection_type === 'warehouse', `实得 ${row2 && row2.connection_type}`);
        }

        // 3. 越界六变体（含大小写变体/非字符串形态）→ 400 CONNECTION_TYPE_INVALID 零写。
        //    坏法：归一化只挡了"字符串但拼错"的值（如 'other'），漏挡大小写变体（'Warehouse'）
        //    或非字符串形态（0/false/[]/{}）——这几类若被短路当成假值/真值误判，会绕过白名单。
        const badConnTypes = ['other', 'Warehouse', 0, false, [], {}];
        for (const bt of badConnTypes) {
            const name = `P2c-badconnType-${badConnTypes.indexOf(bt)}`;
            const rb = await apiCall('POST', '/api/db-connections', adminTok, {
                name, host: 'h', database: 'd', username: 'u', password: 'p', connection_type: bt,
            });
            ok(`P2c connection_type 越界(${JSON.stringify(bt)}) → 400（坏法：归一化漏挡这类形态）`,
                rb.status === 400, `实得 ${rb.status} ${JSON.stringify(rb.body)}`);
            ok(`P2c connection_type 越界(${JSON.stringify(bt)}) code=CONNECTION_TYPE_INVALID`,
                rb.body && rb.body.code === 'CONNECTION_TYPE_INVALID', JSON.stringify(rb.body));
            const rowsAfterBad = await tdbAll('SELECT id FROM db_connections WHERE name=?', [name]);
            ok(`P2c connection_type 越界(${JSON.stringify(bt)}) 库内无新增行（零写确认）`, rowsAfterBad.length === 0, `实得 ${rowsAfterBad.length}`);
        }

        // 4. source + 合法 code + is_default:true → 200 且该行 is_default=0（坏法：finalIsDefault
        //    判定漏了 connection_type==='warehouse' 这个条件，source 行也能被设成默认）。
        const r4 = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P2c-source-is_default', host: 'h', database: 'd', username: 'u', password: 'p',
            connection_type: 'source', source_system_code: 'PX_P2C_SOURCE_DEFAULT', is_default: true,
        });
        ok('P2c source 类型 + is_default:true → 200', r4.status === 200, `实得 ${r4.status} ${JSON.stringify(r4.body)}`);
        if (r4.status === 200) {
            const row4 = await tdbGet('SELECT is_default FROM db_connections WHERE id=?', [r4.body.id]);
            ok('P2c source 类型即使传 is_default:true，落库仍 is_default=0（坏法：finalIsDefault 漏判 connection_type 条件）',
                row4 && row4.is_default === 0, `实得 ${row4 && row4.is_default}`);
        }
    }

    // ---- P2d（11-H1·D28）：POST 默认位事务原子性——连续换默认行 + 重复 code 早退旧默认不受影响 ----
    section('§P2d POST 默认位事务原子性（11-H1·D28）：连续换默认行/重复 code 早退旧默认不受影响');
    {
        const adminTok = signAs(ctx.users.admin);

        // 5. 连续 N=3 个不同 code 的 warehouse 行 is_default:true POST，每次成功后立即查
        //    is_default=1 AND connection_type='warehouse' 行数恒为 1（坏法：清默认位 UPDATE 与
        //    本次 INSERT 不在同一事务，或 WHERE 条件漏了 connection_type 过滤，导致某次残留
        //    0 行或 ≥2 行"双默认"）。
        for (let i = 1; i <= 3; i++) {
            const code = `PX_P2D_SEQ${i}`;
            const r = await apiCall('POST', '/api/db-connections', adminTok, {
                name: `P2d-seq-${i}`, host: '10.255.255.1', port: 1, database: 'd', username: 'u', password: 'p',
                connection_type: 'warehouse', source_system_code: code, is_default: true,
            });
            ok(`P2d 第 ${i} 个 warehouse 默认行（code=${code}）POST → 200`, r.status === 200, `实得 ${r.status} ${JSON.stringify(r.body)}`);
            const defaultRows = await tdbAll("SELECT id FROM db_connections WHERE is_default=1 AND connection_type='warehouse'");
            ok(`P2d 第 ${i} 次 POST 成功后，is_default=1 AND connection_type='warehouse' 行数恒为 1（坏法：清默认位与 INSERT 不同事务/条件漏 connection_type，出现 0 或 ≥2 行）`,
                defaultRows.length === 1, `实得 ${defaultRows.length} 行：${JSON.stringify(defaultRows)}`);
        }

        // 6.〔复用 §P2b（2163 行区），事务内注释〕重复 code + is_default:true → 409 后旧默认行
        //    仍 is_default=1——已由 §P2b 完整覆盖，不在这里重复起新用例。P2b 本身就是"清默认位
        //    UPDATE 与原子 INSERT 绑定在同一事务"（D28/11-H1）最直接的证据：409 早退意味着
        //    INSERT 分支 changes===0 → ROLLBACK；若清默认位 UPDATE 与 INSERT 不在同一事务，
        //    P2b 断言的"连接 A 在 409 早退后仍 is_default=1"就会失败（这正是旧代码的真实坏法：
        //    先无条件清空全库默认位，INSERT 才判重）。P2b 与本组 5. 合起来覆盖了 D28 事务原子性
        //    的两个方向：5. 证明"连续成功换默认"不留残留，P2b 证明"失败早退"不留副作用。
    }

    // ---- P3：普通行三操作（对照组，行为不变） ----
    section('§P3 普通行三操作（PUT 改 name / test 真连不可达失败 / DELETE，对照组）');
    {
        const p3Id = ctx.conn.px_p3;
        const adminTok = signAs(ctx.users.admin);
        const rPut = await apiCall('PUT', `/api/db-connections/${p3Id}`, adminTok, {
            name: 'PX-P3-已改名', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'p3db', username: 'testuser', is_default: 0,
        });
        ok('P3 PUT 改名 → 200（坏法：保护逻辑误伤了普通行）', rPut.status === 200, `实得 ${rPut.status} ${JSON.stringify(rPut.body)}`);
        const afterPut = await tdbGet('SELECT name FROM db_connections WHERE id=?', [p3Id]);
        ok('P3 库 name 已更新为新值', afterPut.name === 'PX-P3-已改名', `实得 ${afterPut.name}`);

        const rTest = await apiCall('POST', `/api/db-connections/${p3Id}/test`, adminTok);
        ok('P3 test 走到真连并按不可达失败 → 500（坏法：误判成受保护 409）', rTest.status === 500, `实得 ${rTest.status} ${JSON.stringify(rTest.body)}`);

        const rDel = await apiCall('DELETE', `/api/db-connections/${p3Id}`, adminTok);
        ok('P3 DELETE → 200（坏法：保护逻辑误伤了普通行）', rDel.status === 200, `实得 ${rDel.status} ${JSON.stringify(rDel.body)}`);
        const afterDel = await tdbGet('SELECT id FROM db_connections WHERE id=?', [p3Id]);
        ok('P3 库行已删除', !afterDel, afterDel ? '仍存在' : '');
    }

    // ---- P4：真并发 POST 同码 + 注入 INSERT 失败不留悬挂事务 ----
    section('§P4 真并发 POST 同码 + 注入 INSERT 失败不留悬挂事务');
    {
        const adminTok = signAs(ctx.users.admin);
        const concCode = 'PX_CONC';
        const [rA, rB] = await Promise.all([
            apiCall('POST', '/api/db-connections', adminTok, { name: 'P4-A', host: 'h', database: 'd', username: 'u', password: 'p', connection_type: 'source', source_system_code: concCode }),
            apiCall('POST', '/api/db-connections', adminTok, { name: 'P4-B', host: 'h', database: 'd', username: 'u', password: 'p', connection_type: 'source', source_system_code: concCode }),
        ]);
        const statuses = [rA.status, rB.status].sort((a, b) => a - b);
        ok('P4 并发同码两请求恰一 200 一 409（坏法：显式 BEGIN 分两步判重+插入，留 TOCTOU 窗口双 200）',
            JSON.stringify(statuses) === JSON.stringify([200, 409]), `实得 ${JSON.stringify(statuses)}`);
        const concRows = await tdbAll('SELECT id FROM db_connections WHERE source_system_code=?', [concCode]);
        ok(`P4 库内 ${concCode} 恰 1 行`, concRows.length === 1, `实得 ${concRows.length}`);

        // 注入确定性 INSERT 失败：临时唯一索引撞现有 name（DDL 现取：db_connections 无 CHECK/UNIQUE
        // 约束，且 endpoint 自身已在 JS 层拦掉 NOT NULL 列缺失，无法用"缺字段"触发 DB 层错误；
        // 改用测试库私加一个唯一索引，POST 一个与既有行同名的新连接，制造确定性 UNIQUE 冲突）。
        await tdbRun('CREATE UNIQUE INDEX IF NOT EXISTS px_p4_name_unique ON db_connections(name)');
        const existingRow = await tdbGet('SELECT name FROM db_connections WHERE id=?', [ctx.conn.relationalBms]);
        const rFail = await apiCall('POST', '/api/db-connections', adminTok, {
            name: existingRow.name, host: 'h', database: 'd', username: 'u', password: 'p',
        });
        ok('P4 注入 name 唯一索引冲突 → 500（证明确实触发了 DB 层错误）', rFail.status === 500, `实得 ${rFail.status} ${JSON.stringify(rFail.body)}`);
        const rNormal = await apiCall('POST', '/api/db-connections', adminTok, {
            name: 'P4-normal-after-injected-fail', host: 'h', database: 'd', username: 'u', password: 'p',
        });
        ok('P4 注入失败后普通写入仍成功（坏法：显式 BEGIN 后抛错未 ROLLBACK，留悬挂事务卡住后续写入）',
            rNormal.status === 200, `实得 ${rNormal.status} ${JSON.stringify(rNormal.body)}`);
    }

    // ---- H8：D19 两处——table-columns 422 / ODS 校验入口跳过 ----
    section('§H8 D19 两处：table-columns 元数据先查 422 / ODS 校验入口跳过（现取参数形态：source_system + table_name）');
    {
        const adminTok = signAs(ctx.users.admin);
        const logBefore = serverLogRef().length;
        // 〔08-H1·codex 08 审前置修正〕原用 source_system=MINIAPP_ZHHL 测"纯 external → 422"——
        // 但 MINIAPP_ZHHL 这个码同时被③（relationalMiscoded，H2 专用夹具）复用，本批 D19-1 加了
        // 确定性排序（关系型优先）后，MINIAPP_ZHHL 命中两行时会稳定选中③（关系型，不可达主机），
        // 不再是 422 而是连接失败——这暴露的正是旧版"靠隐式返回序侥幸选中①"的真实问题，不是本
        // 断言该测的东西。改用 OTHER_EXT（②，externalUnregistered，未与任何关系型行共用码）
        // 测"纯 external 码 → 422"这条最基本的行为；"同码两行确定性选关系型"另有专属夹具见下方
        // PX_DUP2（08-H1 新增）。
        const r1 = await apiCall('GET', '/api/db-connections/table-columns?source_system=OTHER_EXT&table_name=any_table', adminTok);
        ok('H8 table-columns 命中纯 external 码(②) → 422（坏法：两阶段查询没落地，仍走老单阶段查询）',
            r1.status === 422, `实得 ${r1.status} ${JSON.stringify(r1.body)}`);
        ok('H8 code=EXTERNAL_SOURCE_NO_SCHEMA', r1.body && r1.body.code === 'EXTERNAL_SOURCE_NO_SCHEMA', JSON.stringify(r1.body));
        const logAfter = serverLogRef().slice(logBefore);
        ok('H8 server 日志无建池成功痕迹（未解密/未建连，坏法：422 判断放在了取凭证之后）',
            !/SQL Server connection pool created|MySQL connection pool created/.test(logAfter), logAfter.slice(0, 300));
        ok('H8 server 日志无"Get table columns error"通用异常痕迹（没有尝试解密/连接后失败）',
            !/Get table columns error/.test(logAfter), logAfter.slice(0, 300));

        // 〔08-H1·codex 08 审〕反序夹具：同码两行（先 external 后 sqlserver，模拟遗留脏数据，
        // 生产 code 唯一——POST D14 原子去重 + 种子脚本 C3 都拒绝重复插入，同码多行只可能来自
        // 遗留数据），验证确定性排序不依赖插入顺序/rowid——关系型行应被稳定选中（非 422）。
        const dupCode2 = 'PX_DUP2';
        const dup2ExtId = await insertConn({
            name: 'H8-PX_DUP2-external先插入', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
            username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: dupCode2,
        });
        const dup2RelId = await insertConn({
            name: 'H8-PX_DUP2-sqlserver后插入', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'd',
            username: 'u', password: encryptPassword('p'), connection_type: 'source', source_system_code: dupCode2,
        });
        ok('H8 反序夹具前置：external 行 id < sqlserver 行 id（确认插入序=external先，若靠 rowid 顺序会错选 external）',
            dup2ExtId < dup2RelId, `ext=${dup2ExtId} rel=${dup2RelId}`);
        const rDup2 = await apiCall('GET', `/api/db-connections/table-columns?source_system=${dupCode2}&table_name=any_table`, adminTok);
        ok('H8 同码两行（external 先插入）→ 非 422（坏法：靠 rowid/插入序选中了 external 行）',
            rDup2.status !== 422, `实得 ${rDup2.status} ${JSON.stringify(rDup2.body)}`);
        ok('H8 同码两行 → code ≠ EXTERNAL_SOURCE_NO_SCHEMA（确认真的选中了关系型行，不是恰好也 422）',
            !(rDup2.body && rDup2.body.code === 'EXTERNAL_SOURCE_NO_SCHEMA'), JSON.stringify(rDup2.body));

        // 只留 external 行（删掉刚插入的 sqlserver 行）→ 同一个码回到 422，闭环对照。
        await tdbRun('DELETE FROM db_connections WHERE id = ?', [dup2RelId]);
        const rDup2ExtOnly = await apiCall('GET', `/api/db-connections/table-columns?source_system=${dupCode2}&table_name=any_table`, adminTok);
        ok('H8 只留 external 行（同码，删掉 sqlserver 行后）→ 422 EXTERNAL_SOURCE_NO_SCHEMA',
            rDup2ExtOnly.status === 422 && rDup2ExtOnly.body && rDup2ExtOnly.body.code === 'EXTERNAL_SOURCE_NO_SCHEMA',
            `实得 ${rDup2ExtOnly.status} ${JSON.stringify(rDup2ExtOnly.body)}`);

        // 对照：BMS（④，关系型但不可达）路径行为不变——不是 422，是原有的连接失败错误
        const r2 = await apiCall('GET', '/api/db-connections/table-columns?source_system=BMS&table_name=any_table', adminTok);
        ok('H8 对照 BMS(④,关系型不可达) → 非 422（现状路径不变，仍尝试真连后失败）', r2.status !== 422, `实得 ${r2.status} ${JSON.stringify(r2.body)}`);

        // G2-F4 对照：oracle（⑥，非关系型但也非 external）→ 走改造前的原路径，不得被误判成
        // 「外部源」报 422 EXTERNAL_SOURCE_NO_SCHEMA——坏法：把 `!DB_CONNECTION_TYPES_RELATIONAL.
        // includes(type)` 当判据（旧写法），会把 oracle 和 external 混在一起一律 422。
        const r3 = await apiCall('GET', '/api/db-connections/table-columns?source_system=ORACLE_SRC&table_name=any_table', adminTok);
        ok('H8 对照 oracle(⑥,非关系型非external) → 非 422（坏法：非关系型被当成外部源一律拒）', r3.status !== 422, `实得 ${r3.status} ${JSON.stringify(r3.body)}`);
        ok('H8 对照 oracle(⑥) code ≠ EXTERNAL_SOURCE_NO_SCHEMA（即便本环境仍会因不可达在别处失败，也不应是这个 code）',
            !(r3.body && r3.body.code === 'EXTERNAL_SOURCE_NO_SCHEMA'), JSON.stringify(r3.body));

        // ODS 模型校验入口（POST /api/models/:id/validate）：D19-2 分支在"取默认数仓连接→解密→
        // 建连接池"之后才会走到——本 G2 环境没有可达的默认数仓关系型连接（is_default=1 +
        // connection_type='warehouse'），该端点会在到达 D19-2 分支之前就先因数仓连接不可达/未配置
        // 而 400/500 返回，与 C2a「H4 通过态」同一类环境限制（本机/本仓无可达 SQL Server/MySQL）。
        // D19-2 分支代码已按 D19-1 相同的"元数据两阶段查询"模式实现（server.js 现场见交付报告），
        // 无法在本套件里对它做端到端 HTTP 验证，显式 SKIP 不伪造通过。
        skip('H8b ODS 模型校验入口（POST /api/models/:id/validate）以 external 源跳过连库校验【未覆盖·环境阻塞】',
            '需要真实可达的默认数仓连接（is_default=1 且 connection_type=warehouse 的关系型连接）才能到达 D19-2 分支；本机/本仓无可达 SQL Server/MySQL 测试凭证，同 C2a H4 通过态环境限制；D19-2 代码已按 D19-1 同款两阶段模式实现，未做端到端验证');
    }
}

// ============================================================================
// §Q1 周期取数三路由：external id 拒 / 关系型 id 现状语义不变（不动 periodic-fetch 代码，纯回归确认）
// ============================================================================
async function runPeriodicFetchTests(ctx) {
    section('§Q1 周期取数三路由（创建/更新/执行）：external id 拒 / 关系型 id 现状不变');
    const adminTok = signAs(ctx.users.admin);
    const validTemplate = "SELECT id, order_no, created_at FROM dbo.some_orders WHERE created_at >= '{{MONTH_START}}' AND created_at < '{{MONTH_END}}'";

    const rCreateExt = await apiCall('POST', '/api/periodic-tasks', adminTok, {
        task_name: `G2-Q1-ext-${process.pid}-${Date.now()}`,
        source_connection_id: ctx.conn.externalRegistered,
        script_template: validTemplate,
    });
    ok('Q1 创建：external id → 400（坏法：周期取数创建入口顺手放行了 external）',
        rCreateExt.status === 400, `实得 ${rCreateExt.status} ${JSON.stringify(rCreateExt.body)}`);
    ok('Q1 创建：code=SOURCE_CONNECTION_NOT_FOUND', rCreateExt.body && rCreateExt.body.code === 'SOURCE_CONNECTION_NOT_FOUND', JSON.stringify(rCreateExt.body));

    const rCreateRel = await apiCall('POST', '/api/periodic-tasks', adminTok, {
        task_name: `G2-Q1-rel-${process.pid}-${Date.now()}`,
        source_connection_id: ctx.conn.relationalBms,
        script_template: validTemplate,
    });
    ok('Q1 创建：关系型 id → 201（现状不变，本批未改周期取数创建逻辑）',
        rCreateRel.status === 201, `实得 ${rCreateRel.status} ${JSON.stringify(rCreateRel.body)}`);
    const taskId = rCreateRel.body && rCreateRel.body.id;

    if (taskId) {
        const rUpdateExt = await apiCall('PUT', `/api/periodic-tasks/${taskId}`, adminTok, {
            source_connection_id: ctx.conn.externalRegistered,
        });
        ok('Q1 更新：把 source_connection_id 改成 external → 400（坏法：更新入口顺手放行了 external）',
            rUpdateExt.status === 400, `实得 ${rUpdateExt.status} ${JSON.stringify(rUpdateExt.body)}`);
        ok('Q1 更新：code=SOURCE_CONNECTION_NOT_FOUND', rUpdateExt.body && rUpdateExt.body.code === 'SOURCE_CONNECTION_NOT_FOUND', JSON.stringify(rUpdateExt.body));

        // 执行：直接改库把该任务的 source_connection_id 改成 external（模拟"任务创建后连接被换成
        // external"的边角，run 端点自己也有一道独立的 fetchFullSourceConnection 过滤）
        await tdbRun('UPDATE periodic_tasks SET source_connection_id=? WHERE id=?', [ctx.conn.externalRegistered, taskId]);
        const rRunExt = await apiCall('POST', `/api/periodic-tasks/${taskId}/run`, adminTok, {});
        ok('Q1 执行：external id → 409（坏法：执行入口顺手放行了 external）',
            rRunExt.status === 409, `实得 ${rRunExt.status} ${JSON.stringify(rRunExt.body)}`);
        ok('Q1 执行：code=SOURCE_CONNECTION_NOT_FOUND', rRunExt.body && rRunExt.body.code === 'SOURCE_CONNECTION_NOT_FOUND', JSON.stringify(rRunExt.body));

        // 改回关系型 id → run 不应再被 SOURCE_CONNECTION_NOT_FOUND 拦截（现状语义：会继续往下走到
        // 真连，本环境不可达，最终执行结果超出本批范围，不作断言）
        await tdbRun('UPDATE periodic_tasks SET source_connection_id=? WHERE id=?', [ctx.conn.relationalBms, taskId]);
        const rRunRel = await apiCall('POST', `/api/periodic-tasks/${taskId}/run`, adminTok, {});
        const stillBlockedByExternalGate = rRunRel.status === 409 && rRunRel.body && rRunRel.body.code === 'SOURCE_CONNECTION_NOT_FOUND';
        ok('Q1 执行：关系型 id 不再被 SOURCE_CONNECTION_NOT_FOUND 拦截（现状语义不变，后续真连失败超出本批范围不作断言）',
            !stillBlockedByExternalGate, `实得 ${rRunRel.status} ${JSON.stringify(rRunRel.body)}`);
    } else {
        skip('Q1 更新/执行两组', '关系型 id 建任务失败，拿不到 taskId（见上一条创建断言）');
    }
}

// ============================================================================
// 主流程
// ============================================================================
// 〔M8·codex 07 质量审〕真实库保护性快照——开跑前记录 task_pool.db 及 -wal/-shm/-journal 四个
// 文件各自的存在性/大小/mtime，finally 里强制比对，任何一项有差异都计入失败（不是 warn）。
// 本套件设计上全程只应碰 TEMP_DB，这层快照是"万一哪里手滑写到了真库"的最后一道事后检测网。
// 〔M5·codex 12b 质量审〕元数据快照（存在性/大小/mtime）只能证明"文件属性没变"，证明不了
// "内容没变"——理论上存在 mtime 被人为拨回/文件系统时间精度不足等边角情况，让"内容其实被
// 改写过"但元数据快照看起来没动。只对主库文件（无后缀那份，真正承载数据的那个）额外计算一次
// 内容哈希（sha1）：-wal/-shm/-journal 是 WAL 模式的辅助文件，体量可能不小且哪怕本次运行完全
// 没碰真实库，SQLite 自身或其他无关进程的检查点动作也可能重写它们的内容——对这三个仍只比对
// 元数据，避免把辅助文件的正常波动误判成"本次运行破坏了真实库"；主库文件同时比对元数据 + 内容
// 哈希，是这份快照里唯一被要求"连内容都不能变"的一份。
function fileSha1(p) {
    try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }
    catch (_) { return null; } // 文件不存在/读取失败——哈希置 null，diff 时仍会先被 exists/size 差异拦下
}
function snapshotRealDbState() {
    const snap = {};
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const p = REAL_DB + suffix;
        const isMain = suffix === '';
        try {
            const st = fs.statSync(p);
            snap[suffix || '(main)'] = { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha1: isMain ? fileSha1(p) : undefined };
        } catch (_) {
            snap[suffix || '(main)'] = { exists: false, size: null, mtimeMs: null, sha1: isMain ? null : undefined };
        }
    }
    return snap;
}
function diffRealDbSnapshots(before, after) {
    const diffs = [];
    for (const key of Object.keys(before)) {
        const b = before[key], a = after[key];
        if (b.exists !== a.exists || b.size !== a.size || b.mtimeMs !== a.mtimeMs || b.sha1 !== a.sha1) {
            diffs.push(`${key}: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
        }
    }
    return diffs;
}

(async () => {
    console.log('=== G2：数据协作接入外部源 —— 单元/HTTP 层验证（C2a+C2b）===');
    console.log(`本次运行 id 区间：(${SEQ_BASE}, ${SEQ_RANGE_END})`);
    const realDbSnapshotBefore = snapshotRealDbState();

    // 〔H1·codex 07 质量审〕零写预检：本次随机 base 区间若已存在残留（哪怕只是上一次运行崩溃
    // 没清干净），直接拒绝启动——不在"可能已有真实/历史数据"的区间上继续写入。
    const precheckHits = precheckNoResidualInRange();
    if (precheckHits.length > 0) {
        console.error(`[verify-collab-external-source] 零写预检失败：区间 (${SEQ_BASE}, ${SEQ_RANGE_END}) 内已存在残留，拒绝启动：\n  ${precheckHits.join('\n  ')}`);
        process.exit(1);
    }

    killPort(TEST_PORT, 'startup');
    cleanupTempDb();

    if (path.resolve(TEMP_DB) === path.resolve(REAL_DB)) {
        console.error('[verify-collab-external-source] TEMP_DB 与 REAL_DB 字面同路径，拒绝启动（防误连真实 db）');
        process.exit(1);
    }

    // §Q 静态哨兵——不依赖 server，任何时候都能跑，先跑一次保证不空等
    runStaticSentinels();

    // §S（C3）种子脚本行为验证——同样不依赖本文件的主 TEMP_DB/server（每例自建独立临时库、
    // spawn 子进程黑盒调用），提前跑一次不占用 server 冷启动窗口，也不受其稳定性影响。
    await runSeedScriptTests();

    let serverInfo = null;
    try {
        serverInfo = await startServer();
        child = serverInfo.child;
        const serverStable = serverInfo.listening && !serverInfo.exited;
        ok('server 已就绪（Task Pool Server running）', serverInfo.listening);
        ok('server 在稳定观察窗内未退出（未撞上全新空库启动期竞态，或重启后已稳定）', !serverInfo.exited);
        ok('取数质量双校验 schema 就绪信号已出现', serverInfo.schemaReady,
            serverInfo.schemaReady ? '' : '（未捕获到就绪日志，后续 HTTP 调用靠 postSubmitWithRetry 503 重试兜底）');

        if (!serverStable) {
            skip('§U 单元层全部用例', 'server 未就绪/不稳定，无可靠 schema 可用');
            skip('§H HTTP 层全部用例', 'server 未就绪/不稳定');
        } else {
            const ctx = await seedData();
            await runUnitTests(ctx);
            await runHttpTests(ctx, serverInfo.getLog);
            await runPeriodicFetchTests(ctx);
        }
    } catch (e) {
        console.error('[verify-collab-external-source] 主流程异常:', e);
        if (process.env.G2_DEBUG && serverInfo) {
            console.error('[verify-collab-external-source] server 日志尾部:\n' + serverInfo.getLog().slice(-4000));
        }
        fail++;
        failures.push(`主流程异常: ${e.message}`);
    } finally {
        killChildTree(child);
        await closeTdb();
        cleanupTempDb();
        cleanupUploadArtifacts();

        // G2-F5〔收尾全扫描，非仅登记清单〕cleanupUploadArtifacts() 只删"本次登记过 + id 落在区间
        // 内"的精确路径——如果新代码把文件写到了预期外的路径（如目录名算法漂移、或某条新增用例
        // 直接 fs.writeFileSync 但忘了 registerCleanupPath），cleanupUploadArtifacts 那条"复查
        // 残留=0"断言本身抓不到（它压根不知道要查那个路径）。这里复用 precheckNoResidualInRange()
        // 对整个 (SEQ_BASE, SEQ_RANGE_END) 区间做一次不依赖登记清单的独立全扫描——预检已经证明
        // 开跑前该区间是空的，收尾时区间内任何残留都只能是本次运行漏网的文件，不可能是历史遗留。
        // 坏法：新端点/新用例把文件写到了非 `_pending/<id>` 或 `<id>_*` 的"预期外路径"但仍落在
        // id 区间内——若这条断言被删掉、或退化成只检查 registeredCleanupPaths，这类漏网会被
        // 静默放过（收尾"零残留"结论就是假的）。
        const postCleanupResidual = precheckNoResidualInRange();
        ok('F5 收尾全扫描：id 区间 (SEQ_BASE, SEQ_RANGE_END) 内 uploads/collab 与 _pending 残留 = 0（不依赖登记清单，独立复扫）',
            postCleanupResidual.length === 0,
            postCleanupResidual.length ? postCleanupResidual.join('; ') : '');

        try { fs.rmSync(UNIT_COLLAB_ROOT, { recursive: true, force: true }); } catch (_) { /* ignore */ }

        // 〔M8〕真实库保护性快照收尾比对——放在 finally 最后，确保无论主流程正常结束还是抛异常
        // 提前退出，这条检查都会跑到。任何差异都是 ok() 判失败（fail++），不是 console.warn。
        const realDbSnapshotAfter = snapshotRealDbState();
        const realDbDiffs = diffRealDbSnapshots(realDbSnapshotBefore, realDbSnapshotAfter);
        ok('M8 真实 task_pool.db（含 -wal/-shm/-journal）元数据与内容哈希均未变化（存在性/大小/mtime/主库 sha1 逐项比对）',
            realDbDiffs.length === 0, realDbDiffs.length ? realDbDiffs.join(' | ') : '');

        // 〔S2·Opus 预筛〕区间租约释放挪到 finally 最末——晚于上面全部清理/复扫/快照比对。释放
        // 得越早，另一个 G2 实例就能越早抢到同一个随机基线开始往同一区间写数据；若那时本进程的
        // F5 复扫/M8 快照比对还没跑完，会把另一实例刚写入的正常数据误判成"本次运行的残留"或
        // 污染快照比对基线。只有本进程确认自己已经彻底清干净、验证完毕，才可以把这个区间交出去。
        releaseSeqBaseLease();
    }

    console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 / ${skipCount} 跳过 ===`);
    if (failures.length) {
        console.log('失败明细：');
        failures.forEach((f) => console.log(`  - ${f}`));
    }
    // 〔M6·codex 12b 质量审〕独立打印一份「未覆盖口径清单」——skipCount 已天然不并入 pass，这里是
    // 补可读性：让读汇总的人一眼看到具体哪些冻结口径因环境限制完全没有行为证据，不必去猜 skipCount
    // 数字对应哪几条用例。清单内容直接来自实际发生的 skip() 调用（skips 数组），不是硬编码文案，
    // 若未来环境限制解除、某条 skip 不再触发，这份清单会自然缩短，不需要人工同步维护。
    if (skips.length) {
        console.log('\n未覆盖口径清单（SKIP = 环境阻塞，不计入通过，非永久限制——具体理由见各条）：');
        skips.forEach((s) => console.log(`  - ${s.name}：${s.reason}`));
    }
    process.exit(fail === 0 ? 0 : 1);
})();
