// #77 C2a：table_comment 拆分迁移脚本（方案 v0.9 §5.1 + §6.1 C2a ④⑤⑥）。
//
// 把「表注释」里夹带的实现细节（括号及之后）拆到新字段 impl_note，表注释只留短名。
//
// 设计原则：apply / revert 的「读当前值、写、写后核对、config_rev 断言」全部经同一个 HTTP 服务（--base-url + --token-file），
//   不接触任何库文件（不接受 --db）。写入走服务端专用原子条件写接口，只改 table_comment / impl_note 两列，不再有顺带规范化的副作用，
//   所以不需要备份库：还原所需的全部信息（每行写前的两列值 + 伴生行当时的父表归属）写进一份「执行回执」JSON（--receipt，独占新建）。
//   回执是普通 JSON 文件，不可能与服务库混淆。（C2a 修复 2：codex 24-R 两个 HIGH 都出在备份库——备份库与服务库无法证明分离、
//   revert 用当前归属而不是写前归属——同一子系统连续四轮 HIGH，按「质疑子系统本身」处理：整套备份库删除，改回执。）
//
// 信任模型（codex 24-R3：回执真实性）
//   - 回执与 admin token 同一信任级别：能跑 revert 的人本来就能直接调接口写任意值，所以回执只做结构与一致性校验，不验真伪（不做 HMAC / 签名）。
//   - 回执应与 token 文件同等保管，不要放在共享目录。
//   - revert 前建议先用 --dry-run 核对还原计划：dry-run 会发只读 GET（读当前值），不发任何 PUT、不创建回执。
// 还原顺序契约（codex 24-R4 / 24-R5：跨模型顺序）
//   - 每次条件写只改一行的 table_comment / impl_note，判定只依赖这一行自身（旧值、归属、删除状态、config_rev）。
//     comment-split 处理器只发一条单行 UPDATE 加一条变更日志；data_models 上没有触发器，也没有级联写。所以不同模型之间的还原互不依赖，
//     items 只保证同一 model_id 的链按 started_at 从最新到最旧执行，不同模型之间的先后不影响结果。
// 清单契约（codex 24-R3：null 语义）
//   - 清单 new_impl_note 为 null（含空串，解析时按 norm 视同 null）= 「不改 impl_note」。本脚本从不覆盖、也不清空已有 impl_note：
//     已有不同内容 ⇒ skipped-modified；当前 impl_note 为空 / NULL 且清单为 null ⇒ 只改表注释。
//
// 模式（三选一，必须显式给出）
//   --suggest (--db <库文件> | --base-url <url> --token-file <路径>) [--min-len 15] [--out <新 json 文件>]
//       只读取数：--db 只读打开库文件（拒绝本机正式库）；或经 HTTP GET /api/models 取列表（生产上对正式库出建议就用这种）。二选一。
//       筛出 table_comment 超过阈值的「非伴生、未删除」模型，按规则给出建议，打印对照表，--out 时写 JSON（含业务注释，不进仓库）。
//       规则：以第一个全角「（」或半角「(」为界，之前 = 建议短名，括号及之后 = 建议实现说明；
//       无括号且超过 30 字 = 需人工拟短名；括号开头 = 需人工拟短名；无括号且不超过 30 字 = 不拆（保持原样）。
//       登记不改：--db 在 ino 为 0 的文件系统上对正式库硬链接失去 dev+ino 层（suggest 只读打开，不写）。
//   --apply --list <定稿 json> --base-url <url> --token-file <路径> --receipt <新回执.json> --migration-id <id> [--dry-run] [--timeout-ms 30000] [--allow-skips]
//       定稿清单是唯一写入输入（字段：model_id、old_table_comment、new_table_comment、new_impl_note）。
//       逐行先 GET /api/models/:id 读当前值：已等于新值 = 已完成，跳过；与 old 不符（期间被人改过）= 跳过并列入报告；否则才写。
//       写入走专用原子条件写接口 PUT /api/models/:id/comment-split（仅 admin）：请求带 { expected, set, parent_only | companion_of }，
//       服务端把「旧值（NULL 安全）/ 未删除 / 归属」与写入合成同一条 UPDATE，不满足 → 409（脚本记 skipped-modified 并附 current），零写入；
//       只改 table_comment / impl_note 两列（B 类，不递增 config_rev）。
//       --receipt 必填：必须是不存在的新 .json 文件，fs.openSync(path, 'wx') 独占创建（已存在即拒绝，不覆盖）；所在目录须存在。
//       回执内容：{ format, migration_id, base_url（规范化）, list_path, started_at, finished_at, status, rows: [ { model_id, kind: 'parent' | 'companion',
//       parent_id（伴生行必填，父行 null）, before: { table_comment, impl_note, companion_of, is_deleted }（取自写前 GET 的同一行）,
//       before_meta: { config_rev, is_deleted, companion_of }（同一次写前 GET）, after_meta: { config_rev }（写后 GET）, put_sent, timed_out_put〔可选，仅 PUT 曾超时的行有，值恒为 true〕, target: { table_comment, impl_note }, state, reason } ] }。
//       条件写同时带 expected_config_rev（= 写前 GET 的 config_rev）：期间 config_rev 变过 ⇒ 409 ⇒ skipped-modified。
//       父行开始时已是目标值（already-target，本次未写）⇒ 不派生其伴生行（输出提示）。任何 error 一律停止（置 stopped，后面的行 not-processed）。
//       写前先把该行以 state = 'writing' 记入回执，写完再改为 written / done / skipped-* ——每次变动都「写临时文件再 rename 覆盖」（临时文件与回执同目录），
//       所以中途崩溃时回执仍是完整 JSON，且「写了但没来得及记结果」的行以 writing 留痕（revert 一并处理）。
//       伴生表：父表成功后重新 GET /api/models 取该父表当前伴生集合；伴生行 table_comment 按「新父表短名 + ' - 变更追踪'」重新派生，
//       同样走条件写（带 companion_of = 父 id）；伴生行读不到 / 已删除 → skipped-invalid，改挂到别的父表 → skipped-modified。
//   --revert --receipt <apply 产出的回执> --revert-receipt <新回执.json> --base-url <url> --token-file <路径> [--migration-id <id>] [--dry-run] [--timeout-ms 30000] [--allow-skips] [--inflight-cleared]
//       只读 apply 回执（format / migration_id〔命令行给了须一致〕/ base_url〔与命令行规范化后一致〕校验）。对全部 put_sent = true 的行（不论回执里记成什么状态：written / done / writing / error / timeout-unknown*；服务端 409 的行 put_sent 回落为 false、put_rejected = true，不还原）逆序还原，before 与 target 相同的无需还原：
//       仅当当前值等于 target 才写；条件写 expected 取当前 GET 到的值（= target）、set = 回执 before 的两列；父行带 parent_only: true，伴生行带 companion_of = 回执里的 parent_id（写前归属，不是当前行的 companion_of）；
//       条件写带 expected_config_rev = 回执 after_meta.config_rev（缺省取 before_meta.config_rev）。
//       服务端 409（含已改挂 / 已删除 / 值被改过 / config_rev 变过）→ skipped-modified（附当前值），零写入。当前值已等于 before = 已还原（done），但同样须未删除且归属与回执一致，否则 skipped-modified。
//       回执是不可信输入：发出任何请求之前做完整结构校验（rows / model_id / kind / parent_id / put_sent / before / target / before_meta / after_meta 类型，put_sent 与 already-target 行 model_id 不重复），任一不符整份拒绝；
//       多份回执：每份 started_at 须可解析且两两不同；按 started_at 逆序；同一模型相邻回执须衔接（较新 before = 较旧 target；较旧行结果不确定〔error / writing / timeout-unknown〕时也接受 = 较旧 before），否则拒绝。
//       revert 自身也写一份新回执（--revert-receipt，同样独占创建），记录每行结果。
//
// 超时与结果未知
//   - 所有 HTTP 调用用 AbortController 设总超时（--timeout-ms，默认 30000）。GET 超时 → 报错停止（不写）。
//   - 条件写 PUT 超时 → 不重试，先有界 GET 重读该行：两列等于目标值但行已删除 / 归属与条件写不符 → skipped-modified（不记 done）；两列等于目标值、归属相符且 config_rev 与写前相同 → done（推定已提交）；等于目标值但 config_rev 变了 → error 并停止
//     （不能记 done：期间有别的写入）；等于旧值 → timeout-unknown-not-applied；其他 → skipped-modified；重读也失败 → timeout-unknown-reread-failed 并停止。
//
//   - H6（末次合并审；复审 48 sol-H 改为整批确认）：PUT 超时后服务端的在途请求可能稍后才提交。共用判定 putResultUnknown(row)（唯一判定函数，复审 47A-H1 / 47C-HIGH 统一）为真当且仅当：state 以 timeout-unknown 开头；
//     或 put_sent 为真且 state 为 skipped-modified（只可能来自 PUT 超时后的 modified 归并：重读为第三个值 / 行已不存在 / 值为目标但已删除或归属不符；不依赖 timed_out_put，旧回执同样成立）；或 put_sent 为真且 state 为 writing（PUT 发出后进程被杀、回执来不及更新）。timed_out_put 只作信息。
//     apply 汇总只要有行满足该判定，就输出「有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原」，退出码恒非 0（不受 --allow-skips 豁免）；
//     revert 在任何写请求之前扫描全部来源回执（可多份 --receipt）里 put_sent 为真的行：只要有一行满足该判定且没带 --inflight-cleared，整次还原拒绝执行、零写入——
//       不看当前值（任何当前值分支都证明不了那个在途请求已经结束，只有重启服务才能），也不逐行放行其余行；结果状态为 blocked-inflight，inflight_unknown 为真，
//       报告与未完成清单列出触发的行（模型 id、来源状态、来源回执），输出提示，命令行退出码恒非 0（不受 --allow-skips 豁免）；revert 回执照常写出（记录这次被拒）；
//       --dry-run 同样报告「会被拒绝」（结果 blocked-inflight）并输出提示，退出码按干跑既有约定（只看 errors）。
//     操作员确认服务已重启、在途请求已终止后带 --inflight-cleared（仅 --revert）重跑，整批照常处理：当前值 = target → 还原；= 写前原值且归属正常 → done（reason 注明「操作员已确认在途请求已终止」）；已删除 / 改挂 / 第三个值 → skipped-modified。
//     done-presumed / rev-changed 的结果已由重读证实（目标值已落库），不算结果未知（收口批 2 LOW-4）。
//   - M12（末次合并审）：定稿清单校验与回执校验同口径——model_id 正整数、old_table_comment 去首尾空白后非空；任何写入之前整体拒绝。
//
// 结果与退出码
//   - 状态：applied / reverted（全部达到 written / done / reverted）｜partial（有任一 skipped-* / timeout-unknown* / not-processed / companions-unprocessed〔apply：父行已是目标值而伴生行尚未达到新派生值〕/ not-written-by-these-receipts〔revert：回执链最旧一项只是 already-target〕）｜failed（有 error）｜interrupted（中途停止、无 error）｜blocked-inflight（仅 revert：来源回执有 PUT 结果未知的行且没带 --inflight-cleared，整次拒绝、零写入；触发行记 blocked-inflight，其余行记 not-processed）｜dry-run。
//   - 中途停止后，清单里尚未处理的行以 not-processed 补进未完成清单。partial / failed / interrupted / blocked-inflight 进程退出码非 0；--allow-skips 只豁免 partial。
//
// 其他约束
//   - apply / revert 不接受 --db（传了即报错退出）。--dry-run：只打印计划，不创建回执、不发 PUT。
//   - 全程不得改变任何被处理模型的 config_rev（写前后 GET 断言，变了即报错停止）。
//   - 方案 §6.1 C2a ⑥：改短名后，生成脚本内嵌的 table_comment 会变，这些模型下一次 save-scripts 会递增 config_rev，需重新验收。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite = require('sqlite3');   // 仅 --suggest --db 只读打开库文件用

const LIVE_DB = path.resolve(__dirname, '../task_pool.db');
const COMPANION_SUFFIX = ' - 变更追踪';   // 与 server.js syncCompanionTable 的伴生派生格式一致（(parentModel.table_comment || '') + ' - 变更追踪'）
const REV_IMPACT_NOTE = '方案 §6.1 C2a ⑥：改短名后，生成脚本内嵌的 table_comment 会变，下一次 save-scripts 会递增 config_rev，该模型需重新验收';
const WRITTEN_FIELDS = new Set(['table_comment', 'impl_note', 'updated_at']);   // 比对规范化字段时排除
const RECEIPT_FORMAT = 'mc77-table-comment-receipt-v2';   // L5：v2 = 回执行带 before_meta / after_meta / put_rejected（v1 无这些字段，revert 不再接受；尚未上线，无存量回执）
const OLD_RECEIPT_FORMAT_V1 = 'mc77-table-comment-receipt-v1';
const REVERT_RECEIPT_FORMAT = 'mc77-table-comment-revert-receipt-v1';
const DEFAULT_TIMEOUT_MS = 30000;
const OK_STATES = new Set(['written', 'done', 'reverted', 'already-target']);
const ALREADY_TARGET_NOTE = '此行在本次运行前已是目标值，还原须同时提供更早的回执';
const INFLIGHT_HINT = '有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原；重启前不要还原——revert 在写请求之前扫描全部来源回执，有「PUT 曾超时或中途崩溃」结果未知的行就整次拒绝（blocked-inflight，零写入）；先重启服务、确认在途请求已终止，再带 --inflight-cleared 重跑';   // 末次合并审 H6 / 复审 48 整批确认
// P4：回执原子重写用的 rename（仅供验证脚本注入；默认 fs.renameSync）
const _ops = { rename: (a, b) => fs.renameSync(a, b) };

// ---------------------------------------------------------------- 路径工具

/**
 * 两个路径是否指向同一文件：字面路径（大小写不敏感）→ dev + ino（bigint：Windows 文件 id 为 64 位）。任一方 ino 为 0 = 「无法判定」，不使用 dev + ino 这一层。
 */
function sameFile(a, b) {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    if (x.ino === 0n || y.ino === 0n) return false;
    return x.dev === y.dev && x.ino === y.ino;
}

/** 规范化服务地址：origin（主机小写）+ 去尾斜杠的路径 */
function normalizeBaseUrl(u) {
    const s = String(u === undefined || u === null ? '' : u).trim();
    try { const x = new URL(s); return x.origin.toLowerCase() + x.pathname.replace(/\/+$/, ''); }
    catch (_) { return s.replace(/\/+$/, '').toLowerCase(); }
}

/** --suggest --db：只读打开的库文件；解析到本机正式库一律拒绝 */
function validateDbPath(file, liveDb) {
    if (!file) throw new Error('必须显式给出 --db <库文件>（本脚本没有默认库）');
    if (!fs.existsSync(path.resolve(file))) throw new Error('--db 指向的文件不存在: ' + file);
    const resolved = fs.realpathSync(path.resolve(file));
    if (!fs.statSync(resolved).isFile()) throw new Error('--db 必须是已存在的普通库文件');
    if (sameFile(resolved, liveDb)) throw new Error('拒绝指向 wbs-server/task_pool.db（本机正式库）：对正式库出建议请改用 --base-url + --token-file 经 HTTP 取数');
    return resolved;
}

function validateNewFilePath(p, label, otherResolved, liveDb) {
    const abs = path.resolve(p);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) throw new Error(`${label} 所在目录不存在: ${dir}`);
    const target = path.join(fs.realpathSync(dir), path.basename(abs));
    if (fs.existsSync(target)) throw new Error(`${label} 必须是一个不存在的新文件: ${target}`);
    if (sameFile(target, liveDb)) throw new Error(`${label} 不得指向正式库: ${target}`);
    if (otherResolved && sameFile(target, otherResolved)) throw new Error(`${label} 不得与 --db 相同: ${target}`);
    return target;
}

const openDb = (file, mode) => new Promise((resolve, reject) => {
    const db = new sqlite.Database(file, mode, e => (e ? reject(e) : resolve(db)));
});
const closeDb = db => new Promise((resolve, reject) => db.close(e => (e ? reject(e) : resolve())));
const makeAll = db => (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => (e ? reject(e) : resolve(rows))));

/** 空串 / NULL / undefined 视同空 */
const norm = v => (v === undefined || v === null || v === '') ? null : v;
const charLen = s => [...String(s)].length;
const MIG_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------------------------------------------------------------- 回执文件（独占创建 + 原子重写）

/** 独占创建回执文件：必须是不存在的新 .json；fs.openSync(path, 'wx') 是唯一的「不存在」判据（已存在即 EEXIST 拒绝，不覆盖） */
function createReceiptFile(p, label) {
    if (!p) throw new Error(`必须给 ${label} <新回执路径.json>`);
    const abs = path.resolve(p);
    if (path.extname(abs).toLowerCase() !== '.json') throw new Error(`${label} 必须是 .json 文件: ${abs}`);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) throw new Error(`${label} 所在目录不存在: ${dir}`);
    const target = path.join(fs.realpathSync(dir), path.basename(abs));
    let fd;
    try { fd = fs.openSync(target, 'wx'); }
    catch (e) {
        if (e && e.code === 'EEXIST') throw new Error(`${label} 必须是一个不存在的新文件（已存在，拒绝覆盖）: ${target}`);
        throw e;
    }
    // X8：独占创建后立即写入一份可解析的占位 JSON（不含 format，revert 会拒绝它）——首次原子重写就失败时，回执也不会是 0 字节的不可解析文件
    try { fs.writeSync(fd, JSON.stringify({ status: 'initializing' })); } finally { fs.closeSync(fd); }
    return target;
}

/** 原子重写：临时文件（与回执同目录，名字带 pid + 随机后缀）写完整内容再 rename 覆盖，中途崩溃时回执仍是上一份完整 JSON */
function writeJsonAtomic(file, obj) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    // P4：回执被别的进程短暂占用（Windows 上 EPERM / EBUSY / EACCES）时有界重试（共 5 次，间隔 100ms 递增），仍失败则清理临时文件后抛错
    for (let attempt = 1; ; attempt++) {
        try { _ops.rename(tmp, file); return; }
        catch (e) {
            const retryable = e && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code);
            if (!retryable || attempt >= 5) {
                try { fs.unlinkSync(tmp); } catch (_) { /* 已不存在 */ }
                throw e;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
        }
    }
}

const pickState = m => ({ table_comment: m.table_comment === undefined ? null : m.table_comment, impl_note: m.impl_note === undefined ? null : m.impl_note, companion_of: m.companion_of === undefined ? null : m.companion_of, is_deleted: m.is_deleted === undefined ? null : m.is_deleted });
const pickTarget = m => ({ table_comment: m.table_comment === undefined ? null : m.table_comment, impl_note: m.impl_note === undefined ? null : m.impl_note });

/** 报告行 → 回执行 */
function toReceiptRow(r) {
    const ofKind = r.of_kind || r.kind;
    return {
        model_id: r.model_id,
        kind: ofKind,
        parent_id: ofKind === 'companion' ? (r.parent_id === undefined ? null : r.parent_id) : null,
        before: r.before || null,
        ...(r.companion_ids ? { companion_ids: r.companion_ids } : {}),
        before_meta: r.before_meta || null,   // X1：写前 GET 同一行的 config_rev / is_deleted / companion_of
        after_meta: r.after_meta || null,     // X1：写后 GET 读到的 config_rev（B 类写入不递增，应等于 before_meta.config_rev）
        put_sent: r.put_sent === true,
        ...(r.timed_out_put === true ? { timed_out_put: true } : {}),   // 收口批 2 LOW-4：PUT 曾超时（任何结局）——信息字段，写进回执供人工核对；「结果未知」判定（putResultUnknown）不依赖它（复审口径调整：旧回执没有该字段也要成立）
        ...(r.put_rejected === true ? { put_rejected: true } : {}),   // HIGH-2：服务端 409 确定零写入，put_sent 回落为 false
        ...(r.source_receipt ? { source_state: r.source_state, source_receipt: r.source_receipt } : {}),   // 复审 48：revert 整批拒绝时，触发行的来源状态与来源回执（revert 回执里留痕）
        target: r.target || null,
        state: r.state,
        reason: r.error || r.reason || null
    };
}

/** 回执写入器：create 时独占创建并写初始内容；flush 原子重写；dry-run 时 create 返回 null 对象（什么都不做） */
function makeReceiptWriter(file, header, result) {
    const startedAt = new Date().toISOString();
    const flush = (finished) => {
        writeJsonAtomic(file, {
            ...header,
            started_at: startedAt,
            finished_at: finished ? new Date().toISOString() : null,
            status: finished ? result.status : 'running',
            rows: result.rows.map(toReceiptRow)
        });
    };
    flush(false);
    return { file, flush: () => flush(false), finish: () => flush(true) };
}

// ---------------------------------------------------------------- HTTP（服务是唯一的读写对象）

function readToken(file) {
    if (!file) throw new Error('必须给 --token-file <路径>');
    let text;
    try { text = fs.readFileSync(path.resolve(file), 'utf8').trim(); } catch (e) { throw new Error('token 文件读取失败: ' + e.message); }
    if (text.startsWith('{')) { try { text = String(JSON.parse(text).token || '').trim(); } catch (_) { /* 按原文处理 */ } }
    if (!text) throw new Error('token 文件为空');
    return text;
}

/** --timeout-ms 校验：正整数，缺省 30000 */
function parseTimeoutMs(v) {
    if (v === undefined || v === null) return DEFAULT_TIMEOUT_MS;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error('--timeout-ms 必须是正整数（毫秒）');
    return n;
}

/** 所有 HTTP 调用的总超时（连接 + 响应头 + 响应体）用 AbortController 兜住；超时抛 e.timeout = true 的错误 */
async function http(ctx, method, urlPath, body) {
    const timeoutMs = ctx.timeoutMs || DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(ctx.baseUrl.replace(/\/+$/, '') + urlPath, {
            method,
            headers: { Authorization: `Bearer ${ctx.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: ac.signal
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
        return { status: res.status, json, text };
    } catch (e) {
        if (ac.signal.aborted) {
            const err = new Error(`HTTP ${method} ${urlPath} 超时（${timeoutMs}ms 内未完成）`);
            err.timeout = true;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** GET /api/models/:id；404 返回 null；其他非 200 抛错 */
async function getModel(ctx, id) {
    const r = await http(ctx, 'GET', `/api/models/${id}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') throw new Error(`GET /api/models/${id} 返回 ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
}

async function listModels(ctx) {
    const r = await http(ctx, 'GET', '/api/models');
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GET /api/models 返回 ${r.status}: ${r.text.slice(0, 200)}`);
    // 列表接口的「最新活跃任务」LEFT JOIN 在两条未归档任务同秒时会把同一模型返回两行——按 id 去重（保留首行）
    const seen = new Set();
    return r.json.filter(m => { const k = String(m && m.id); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------------------------------------------------------------- 建议规则

/**
 * 单条建议。返回 { suggested_short, suggested_impl_note, needs_manual }
 *   第一个全角「（」或半角「(」为界：之前 = 短名，括号及之后 = 实现说明；
 *   界前为空（以括号开头）或无括号且超过 30 字 = 需人工拟短名；无括号且不超过 30 字 = 不拆，保持原样。
 */
function suggestSplit(comment) {
    const text = String(comment);
    const idxs = ['（', '('].map(ch => text.indexOf(ch)).filter(i => i >= 0);
    if (idxs.length > 0) {
        const i = Math.min(...idxs);
        const short = text.slice(0, i).trim();
        const impl = text.slice(i).trim();
        if (short === '') return { suggested_short: null, suggested_impl_note: null, needs_manual: true };
        return { suggested_short: short, suggested_impl_note: impl, needs_manual: false };
    }
    if (charLen(text) > 30) return { suggested_short: null, suggested_impl_note: null, needs_manual: true };
    return { suggested_short: text, suggested_impl_note: null, needs_manual: false };
}

function buildSuggestReport(rows, hasImpl, minLen, source) {
    const eligible = rows.filter(r => r.companion_of == null && (r.is_deleted === 0 || r.is_deleted == null) && r.table_comment != null)
        .sort((a, b) => (String(a.layer).localeCompare(String(b.layer))) || String(a.table_name).localeCompare(String(b.table_name)));
    const counts = { over_15: 0, over_20: 0, over_30: 0, population: eligible.length };
    const items = [];
    for (const r of eligible) {
        const n = charLen(r.table_comment);
        if (n > 15) counts.over_15++;
        if (n > 20) counts.over_20++;
        if (n > 30) counts.over_30++;
        if (n <= minLen) continue;
        const s = suggestSplit(r.table_comment);
        items.push({
            model_id: r.id,
            table_name: r.table_name,
            layer: r.layer,
            old_table_comment: r.table_comment,
            suggested_short: s.suggested_short,
            suggested_impl_note: s.suggested_impl_note,
            needs_manual: s.needs_manual,
            current_impl_note: hasImpl ? (r.impl_note === undefined ? null : r.impl_note) : null,
            rev_impact: REV_IMPACT_NOTE
        });
    }
    return { generated_at: new Date().toISOString(), source, min_len: minLen, impl_note_column_present: hasImpl, counts, notice: REV_IMPACT_NOTE, items };
}

async function runSuggest(liveDb, options) {
    const minLen = options.minLen === undefined ? 15 : Number(options.minLen);
    if (!Number.isInteger(minLen) || minLen < 0) throw new Error('--min-len 必须是非负整数');
    const viaHttp = !!options.baseUrl;
    if (viaHttp && options.db) throw new Error('--suggest 的 --db 与 --base-url 二选一');
    if (!viaHttp && !options.db) throw new Error('--suggest 必须给 --db <库文件>（只读）或 --base-url + --token-file（经 HTTP 取数）');
    if (viaHttp) {
        const token = readToken(options.tokenFile);
        const outTarget = options.out ? validateNewFilePath(options.out, '--out', null, liveDb) : null;
        const rows = await listModels({ baseUrl: options.baseUrl, token, timeoutMs: parseTimeoutMs(options.timeoutMs) });
        const hasImpl = rows.some(r => 'impl_note' in r);
        const report = buildSuggestReport(rows, hasImpl, minLen, `http:${options.baseUrl}`);
        if (outTarget) fs.writeFileSync(outTarget, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { status: 'suggested', report, out: outTarget };
    }
    const resolved = validateDbPath(options.db, liveDb);
    const outTarget = options.out ? validateNewFilePath(options.out, '--out', resolved, liveDb) : null;
    const db = await openDb(resolved, sqlite.OPEN_READONLY);   // 只读：任何写语句都会被 sqlite 拒绝
    try {
        const all = makeAll(db);
        const cols = (await all('PRAGMA table_info(data_models)')).map(c => c.name);
        for (const c of ['id', 'table_name', 'layer', 'table_comment', 'companion_of', 'is_deleted']) {
            if (!cols.includes(c)) throw new Error('data_models 缺少必需的列: ' + c);
        }
        const hasImpl = cols.includes('impl_note');
        const rows = await all(`SELECT id, table_name, layer, table_comment, companion_of, is_deleted${hasImpl ? ', impl_note' : ''} FROM data_models`);
        const report = buildSuggestReport(rows, hasImpl, minLen, `db:${resolved}`);
        report.db = resolved;
        if (outTarget) fs.writeFileSync(outTarget, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
        return { status: 'suggested', report, out: outTarget };
    } finally {
        await closeDb(db);
    }
}

// ---------------------------------------------------------------- 清单读取

function parseList(file) {
    if (!file) throw new Error('--apply 必须给 --list <定稿 json>');
    let data;
    try { data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
    catch (e) { throw new Error('定稿清单读取 / 解析失败: ' + e.message); }
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!arr) throw new Error('定稿清单必须是 JSON 数组（或带 items 数组的对象）');
    const seen = new Set();
    return arr.map((r, i) => {
        const at = `定稿清单第 ${i + 1} 行`;
        if (!r || typeof r !== 'object') throw new Error(`${at} 不是对象`);
        // 末次合并审 M12：清单校验与回执校验同口径（回执要求 model_id 为正整数、old_table_comment 去首尾空白后非空；清单更宽会让写入完成后回执被整份拒绝、无法还原）。任何写入之前整体拒绝
        if (!Number.isInteger(r.model_id) || r.model_id <= 0) throw new Error(`${at}: model_id 必须是正整数`);
        if (seen.has(r.model_id)) throw new Error(`${at}: model_id ${r.model_id} 重复`);
        seen.add(r.model_id);
        if (typeof r.old_table_comment !== 'string' || r.old_table_comment.trim() === '') throw new Error(`${at}: old_table_comment 必须是去掉首尾空白后非空的字符串`);
        if (typeof r.new_table_comment !== 'string' || r.new_table_comment.trim() === '') throw new Error(`${at}: new_table_comment 必须是非空字符串`);
        if (r.new_impl_note !== undefined && r.new_impl_note !== null && typeof r.new_impl_note !== 'string') throw new Error(`${at}: new_impl_note 必须是字符串或 null`);
        return { model_id: r.model_id, old_table_comment: r.old_table_comment, new_table_comment: r.new_table_comment, new_impl_note: norm(r.new_impl_note) };
    });
}

// ---------------------------------------------------------------- 写入通道（全部经服务）

const rowKey = v => (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;

/** 两次 GET 之间，除 table_comment / impl_note / updated_at 之外发生变化的字段 */
function diffRows(a, b) {
    const out = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (WRITTEN_FIELDS.has(k)) continue;
        if (rowKey(a[k] === undefined ? null : a[k]) !== rowKey(b[k] === undefined ? null : b[k])) out.push({ field: k, before: a[k] === undefined ? null : a[k], after: b[k] === undefined ? null : b[k] });
    }
    return out;
}

const sameTarget = (cur, t) => norm(cur.table_comment) === norm(t.table_comment) && norm(cur.impl_note) === norm(t.impl_note);

/**
 * 原子条件写：PUT /api/models/:id/comment-split，请求带 expected（= 刚 GET 到的当前值）与 set（目标值），companionOf 给了则服务端同句复核伴生归属，parentOnly 复核仍为父行。
 * 返回 { outcome, ... }：
 *   written           200，写后 GET 二次核对通过（值、config_rev 未变），带 normalized（其他字段的变化，正常为 []）
 *   conflict          409：服务端条件不满足（期间被人改过 / 已删除 / 改挂了父表），零写入，带 current
 *   done-presumed     PUT 超时后重读 = 目标值且 config_rev 与写前相同：推定已提交
 *   rev-changed       PUT 超时后重读 = 目标值但 config_rev 与写前不同：期间有别的写入，不能记 done（调用方记 error 并停止）
 *   not-applied       PUT 超时后重读 = 旧值：重读时未生效（在途请求可能稍后提交，重跑可收敛）
 *   modified          PUT 超时后重读 既不是目标也不是旧（或行已不存在）
 *   reread-failed     PUT 超时后重读也失败：结果未知
 * 其他异常（非 200 / 409、写后核对失败、config_rev 变化）直接抛错。PUT 不重试。
 */
async function condWrite(ctx, before, fields, label, companionOf, parentOnly, expectedRev) {
    const id = before.id;
    const expected = { table_comment: before.table_comment === undefined ? null : before.table_comment, impl_note: before.impl_note === undefined ? null : before.impl_note };
    const set = {
        table_comment: fields.table_comment !== undefined ? fields.table_comment : expected.table_comment,
        impl_note: fields.impl_note !== undefined ? fields.impl_note : expected.impl_note
    };
    const body = { expected, set };
    if (companionOf !== undefined) body.companion_of = companionOf;
    if (parentOnly === true) body.parent_only = true;   // 父行写一律带 parent_only，服务端同句复核 companion_of 仍为 NULL（GET 之后被转成伴生行 ⇒ 409）
    if (Number.isInteger(expectedRev)) body.expected_config_rev = expectedRev;   // X1：服务端同句复核 config_rev 仍等于它（被改过 ⇒ 409）
    let r;
    try {
        r = await http(ctx, 'PUT', `/api/models/${id}/comment-split`, body);
    } catch (e) {
        if (!e.timeout) throw e;
        // PUT 超时：服务端可能已提交——不重试，先有界 GET 重读，按「目标 / 旧值 / 其他」三态归并
        let cur;
        try { cur = await getModel(ctx, id); } catch (e2) { return { outcome: 'reread-failed', message: `${e.message}；重读失败：${e2.message}` }; }
        if (!cur) return { outcome: 'modified', message: `${e.message}；重读时模型已不存在`, current: null };
        const curState = { table_comment: cur.table_comment, impl_note: cur.impl_note, companion_of: cur.companion_of, is_deleted: cur.is_deleted };
        if (sameTarget(cur, set)) {
            // HIGH-1：推定已提交之前先核删除与归属（与服务端条件写同口径）——挂起期间行被删除 / 改挂 / 转成伴生行而值恰为目标值时，不能记 done
            const ownOk = (cur.is_deleted === 0 || cur.is_deleted == null) && (companionOf === undefined || cur.companion_of === companionOf) && (parentOnly !== true || cur.companion_of == null);
            if (!ownOk) return { outcome: 'modified', message: `${e.message}；重读 = 目标值，但行已被删除或归属与条件写不符（不记 done）`, current: curState };
            if (cur.config_rev !== before.config_rev) return { outcome: 'rev-changed', message: `${e.message}；重读 = 目标值，但 config_rev 已从 ${before.config_rev} 变为 ${cur.config_rev}（期间有别的写入，违反「全程不触碰 config_rev」），已停止` };
            return { outcome: 'done-presumed', afterMeta: { config_rev: cur.config_rev }, message: `${e.message}；重读 = 目标值（config_rev 未变），推定已提交` };
        }
        if (sameTarget(cur, expected)) return { outcome: 'not-applied', message: `${e.message}；重读时未生效（在途请求可能稍后提交，重跑可收敛）` };
        return { outcome: 'modified', message: `${e.message}；重读既不是目标值也不是旧值`, current: curState };
    }
    if (r.status === 409) return { outcome: 'conflict', current: (r.json && r.json.current) || null };
    if (r.status !== 200) throw new Error(`${label}: PUT /api/models/${id}/comment-split 返回 ${r.status}: ${r.text.slice(0, 200)}`);
    const after = await getModel(ctx, id);
    if (!after) throw new Error(`${label}: 写后读不到模型 ${id}`);
    for (const k of ['table_comment', 'impl_note']) {
        if (norm(after[k]) !== norm(set[k])) throw new Error(`${label}: 写后核对失败，${k} 实际为 ${JSON.stringify(after[k])}`);
    }
    if (after.config_rev !== before.config_rev) {
        const e = new Error(`${label}: config_rev 被改变（${before.config_rev} → ${after.config_rev}），违反「全程不触碰 config_rev」，已停止`);
        e.fatal = true;
        throw e;
    }
    return { outcome: 'written', afterMeta: { config_rev: after.config_rev }, normalized: diffRows(before, after) };
}

/** 把 condWrite 的结果落到报告行：返回是否停止；done-presumed 状态为 done（并列入 timeouts），written 由调用方给 written / reverted */
function applyOutcome(result, r, out, writtenState) {
    const note = (extra) => { r.reason = [r.reason, extra].filter(Boolean).join('；'); };
    const tm = (outcome) => result.timeouts.push({ model_id: r.model_id, kind: r.kind, state: r.state, outcome, message: out.message });
    if (out.afterMeta) r.after_meta = out.afterMeta;
    switch (out.outcome) {
        case 'written': r.state = writtenState; r.normalized_fields = out.normalized; return false;
        case 'conflict': r.state = 'skipped-modified'; r.put_sent = false; r.put_rejected = true; r.current = out.current; note(`条件写被服务端拒绝（409 precondition_failed：期间被改过 / 已删除 / 改挂了父表）：当前=${JSON.stringify(out.current)}`); return false;
        case 'done-presumed': r.state = 'done'; r.timed_out_put = true; note(out.message); tm(out.outcome); return false;
        case 'rev-changed': r.state = 'error'; r.error = out.message; r.timed_out_put = true; result.errors.push(`模型 ${r.model_id}: ${out.message}`); tm(out.outcome); return true;
        case 'not-applied': r.state = 'timeout-unknown-not-applied'; r.timed_out_put = true; note(out.message); tm(out.outcome); return false;
        case 'modified': r.state = 'skipped-modified'; r.timed_out_put = true; r.current = out.current || null; note(out.message); tm(out.outcome); return false;
        default: r.state = 'timeout-unknown-reread-failed'; r.timed_out_put = true; note(out.message); tm('reread-failed'); return true;   // 重读也失败：服务多半不可达，停止
    }
}

/**
 * 「PUT 结果未知」共用判定（末次合并审复审 47A-H1 / 47C-HIGH）：服务端的在途请求可能稍后才提交。为真当且仅当
 *   - state 以 timeout-unknown 开头；或
 *   - put_sent === true 且 state 为 skipped-modified（PUT 超时后重读归并为 modified）——不依赖 timed_out_put 字段，对不带该字段的旧回执同样成立：
 *     revert 只处理 put_sent 为真的行；put_sent 为真同时 state 为 skipped-modified 的行只可能来自「PUT 超时后的 modified 归并」——重读为第三个值、行已不存在、
 *     或值为目标但行已删除 / 归属不符（409 路径把 put_sent 回落为 false，其余 skipped-modified 赋值点都在发 PUT 之前；revert 自身 PUT 超时同样适用）；或
 *   - put_sent === true 且 state 为 writing（PUT 发出后进程被杀，回执来不及更新）。
 *   timed_out_put 字段仍写进回执作信息，不再参与判定。
 * 汇总的 inflight_unknown 与 revert 的整批门槛（runRevert 在任何写请求之前扫描全部来源回执）都用它，口径不得各写一份；revert 没有逐行判定（整批门槛之后没有第二份判定）。
 */
function putResultUnknown(row) {
    if (!row) return false;
    const st = String(row.state);
    return st.startsWith('timeout-unknown')
        || (row.put_sent === true && st === 'skipped-modified')
        || (row.put_sent === true && st === 'writing');
}

/** 汇总：未完成清单（机器可读）与最终状态。applied|reverted（全部 written / done / reverted）/ partial（有 skipped-* 或 timeout-unknown* 或 not-processed）/ failed（有 error）/ interrupted（中途停止无 error）/ blocked-inflight（仅 revert：来源回执有 PUT 结果未知的行且没带 --inflight-cleared，整次拒绝、零写入）；干跑保持 dry-run（outcome 仍按上述取值） */
function finalizeResult(result, okStatus) {
    result.unfinished = result.rows.filter(r => !OK_STATES.has(r.state) && r.state !== 'write')
        .map(r => ({ model_id: r.model_id, state: r.state, reason: r.error || r.reason || null, ...(r.companion_ids ? { companion_ids: r.companion_ids } : {}), ...(r.source_receipt ? { source_state: r.source_state, source_receipt: r.source_receipt } : {}) }));
    // 凡中途停止（GET 失败 / 超时、PUT 超时后重读也失败、config_rev 变化等）：有 error 行记 failed，否则记 interrupted；二者退出码恒非 0、不受 --allow-skips 豁免
    if (result.errors.length || result.rows.some(r => r.state === 'error')) { result.outcome = 'failed'; result.stopped = true; }   // X6：凡有 error 一律是「已停止」的终态，不可能是 applied / reverted
    else if (result.blockedInflight === true) result.outcome = 'blocked-inflight';   // 复审 48：revert 整批拒绝（来源回执有 PUT 结果未知的行且没带 --inflight-cleared），零写入；退出码恒非 0
    else if (result.stopped) result.outcome = 'interrupted';
    else if (result.unfinished.length) result.outcome = 'partial';
    else result.outcome = okStatus;
    if (result.status !== 'dry-run') result.status = result.outcome;
    // 末次合并审 H6：有写请求结果未知（putResultUnknown 为真的行；revert 被整批拒绝时同样为真）⇒ 在途请求可能稍后才提交，须先重启服务（在途请求随进程终止）再重跑或还原；
    //   命令行据此恒返回非 0（不受 --allow-skips 豁免），并输出 INFLIGHT_HINT
    result.inflight_unknown = result.blockedInflight === true || result.rows.some(r => putResultUnknown(r));
    summarizeCounts(result);
}

// ---------------------------------------------------------------- apply

/** 父表一行的计划：返回 { state, fields, reason }；state = done | write | skipped-modified | skipped-invalid */
function planParentRow(row, cur) {
    if (!cur) return { state: 'skipped-invalid', reason: '模型不存在' };
    if (cur.is_deleted === 1) return { state: 'skipped-invalid', reason: '模型已删除' };
    if (cur.companion_of != null) return { state: 'skipped-invalid', reason: '清单行指向伴生表（伴生行由父表派生，不接受直接列入清单）' };
    // Y2：全部比较统一过 norm（NULL / 空串 / undefined 视同空，与服务端条件写、sameTarget 同口径）；
    // 清单 new_impl_note 为 null（含空串）= 「不改 impl_note」——本脚本从不覆盖、也不清空已有 impl_note（已有不同内容 ⇒ skipped-modified）
    const needTc = norm(cur.table_comment) !== norm(row.new_table_comment);
    const needImpl = norm(row.new_impl_note) !== null && norm(cur.impl_note) !== norm(row.new_impl_note);
    if (!needTc && !needImpl) return { state: 'done', reason: '当前值已等于新值' };
    if (needTc && norm(cur.table_comment) !== norm(row.old_table_comment)) return { state: 'skipped-modified', reason: `table_comment 与清单 old 不符（期间被改过）：当前=${JSON.stringify(cur.table_comment)}` };
    if (needImpl && norm(cur.impl_note) !== null) return { state: 'skipped-modified', reason: `impl_note 已有不同内容：当前=${JSON.stringify(cur.impl_note)}` };
    const fields = {};
    if (needTc) fields.table_comment = row.new_table_comment;
    if (needImpl) fields.impl_note = row.new_impl_note;
    return { state: 'write', fields };
}

function planCompanion(parentRow, comp) {
    const derivedNew = parentRow.new_table_comment + COMPANION_SUFFIX;
    const derivedOld = parentRow.old_table_comment + COMPANION_SUFFIX;
    if (comp.table_comment === derivedNew) return { state: 'done', derivedNew, reason: '当前值已等于新派生值' };
    if (comp.table_comment === derivedOld) return { state: 'write', derivedNew, fields: { table_comment: derivedNew } };
    return { state: 'skipped-modified', derivedNew, reason: `伴生行 table_comment 不是按旧父表短名派生的标准形态（期望 ${JSON.stringify(derivedOld)}）：当前=${JSON.stringify(comp.table_comment)}` };
}

function summarizeCounts(result) {
    const c = {};
    for (const r of result.rows) {
        const key = `${r.kind}:${r.state}`;
        c[key] = (c[key] || 0) + 1;
    }
    result.counts = c;
}

function checkMode(options, mode) {
    if (options.db !== undefined) throw new Error(`--${mode} 不再接受 --db：读当前值 / 写 / 核对全部经 HTTP（--base-url + --token-file），还原信息写进执行回执（--receipt）`);
    if (!options.baseUrl) throw new Error('必须给 --base-url <url>');
}

async function runApply(liveDb, options) {
    checkMode(options, 'apply');
    if (!options.migrationId || !MIG_ID_RE.test(options.migrationId)) throw new Error('必须给 --migration-id <id>（仅字母数字 _ . -，≤64 字符）');
    if (options.revertReceipt !== undefined) throw new Error('--revert-receipt 只用于 --revert');
    if (options.inflightCleared !== undefined) throw new Error('--inflight-cleared 只用于 --revert');
    const migrationId = options.migrationId;
    const dryRun = !!options.dryRun;
    if (Array.isArray(options.receipt)) throw new Error('--apply 只接受一个 --receipt');
    if (!dryRun && !options.receipt) throw new Error('必须给 --receipt <新回执路径.json>（apply 把每行写前的值与归属写进这份独占新建的回执，revert 靠它还原）');
    const list = parseList(options.list);
    const token = readToken(options.tokenFile);
    const ctx = { baseUrl: options.baseUrl, token, timeoutMs: parseTimeoutMs(options.timeoutMs) };
    const result = { status: dryRun ? 'dry-run' : 'applied', migration_id: migrationId, rows: [], errors: [], timeouts: [], unfinished: [], counts: {}, notice: REV_IMPACT_NOTE };
    let receipt = null;
    if (!dryRun) {
        const receiptPath = createReceiptFile(options.receipt, '--receipt');
        receipt = makeReceiptWriter(receiptPath, { format: RECEIPT_FORMAT, migration_id: migrationId, base_url: normalizeBaseUrl(options.baseUrl), list_path: path.resolve(options.list) }, result);
        result.receipt = receiptPath;
    }
    const flush = () => { if (receipt) receipt.flush(); };
    try {
        const all = await listModels(ctx);
        if (!all.every(r => 'impl_note' in r)) throw new Error('服务返回的模型行没有 impl_note 字段：目标服务尚未上线 C2a 版本（启动补列），拒绝迁移');
        const rec = (r) => { result.rows.push(r); flush(); return r; };
        // X6：任何 error（GET / PUT 失败、非 200 / 409 响应、写后核对失败、config_rev 变化、超时）一律停止：置 stopped，后面的行以 not-processed 补进未完成清单
        const fail = (r, e) => { r.state = 'error'; r.error = e.message; result.errors.push(`模型 ${r.model_id}: ${e.message}`); result.stopped = true; flush(); return true; };
        // 写一行：先以 writing 记入回执（写了但没来得及记结果的崩溃情形也有留痕），写完改为结果并再记一次
        const writeRow = async (r, cur, fields, label, companionOf, parentOnly) => {
            if (!Number.isInteger(cur.config_rev)) return fail(r, new Error(`${label}: 服务返回的 config_rev 不是整数（${JSON.stringify(cur.config_rev)}），无法记写前版本，拒绝写入`));   // X1：回执要记 before_meta.config_rev，缺了就不写
            r.before = pickState(cur);
            r.before_meta = { config_rev: cur.config_rev, is_deleted: cur.is_deleted === undefined ? null : cur.is_deleted, companion_of: cur.companion_of === undefined ? null : cur.companion_of };   // X1：写前 GET 同一行的版本 / 删除 / 归属快照
            r.target = pickTarget({ table_comment: fields.table_comment !== undefined ? fields.table_comment : cur.table_comment, impl_note: fields.impl_note !== undefined ? fields.impl_note : cur.impl_note });
            r.state = 'writing'; r.put_sent = true; flush();   // P1：发出条件写请求前置 put_sent 并原子落盘（revert 据此处理所有可能已提交的行，不论后来记成什么状态）
            let stopNow = false;
            try {
                const out = await condWrite(ctx, cur, fields, label, companionOf, parentOnly, cur.config_rev);
                stopNow = applyOutcome(result, r, out, 'written');
            } catch (e) { stopNow = !!fail(r, e); }
            flush();
            return stopNow;
        };
        let stop = false;
        for (const row of list) {
            if (stop) break;
            let cur;
            try { cur = await getModel(ctx, row.model_id); }
            catch (e) { fail(rec({ kind: 'parent', model_id: row.model_id, table_name: null, state: 'error', reason: null, fields: null }), e); stop = true; continue; }   // GET 失败 / 超时：报错停止，不写
            if (cur && !('impl_note' in cur)) throw new Error('服务返回的模型行没有 impl_note 字段：目标服务尚未上线 C2a 版本，拒绝迁移');
            const plan = planParentRow(row, cur);
            const r = rec({ kind: 'parent', model_id: row.model_id, table_name: cur ? cur.table_name : null, state: plan.state === 'done' ? 'already-target' : plan.state, reason: plan.state === 'done' ? `${plan.reason}；${ALREADY_TARGET_NOTE}` : (plan.reason || null), fields: plan.fields || null, before: cur ? pickState(cur) : null, target: cur && plan.state === 'done' ? pickTarget(cur) : null });
            if (plan.state === 'write' && !dryRun) {
                if (await writeRow(r, cur, plan.fields, `模型 ${row.model_id}`, undefined, true)) stop = true;
                if (r.state === 'error') continue;
            }
            // 伴生行：父表由本次运行写入（written / 超时后推定已提交的 done）才派生；干跑也列出计划。
            // X4：父行开始时已是目标值（already-target，本次未写）不派生其伴生行——伴生行本身若在定稿清单里，由它自己的清单行处理（清单里的伴生行恒为 skipped-invalid）；输出提示
            const parentSettled = r.state === 'written' || r.state === 'done' || (dryRun && r.state === 'write');
            if (r.state === 'already-target') {
                r.reason = `${r.reason}；父行本次未写入，其伴生行不在本次处理（不派生）`;
                // X4b：不写伴生行，但若父行下仍有未删除的伴生行，记入未完成清单（status partial），防止「中途失败后重跑，伴生行永远不补写却报 applied」
                let pendAll;
                try { pendAll = await listModels(ctx); }
                catch (e) { fail(rec({ kind: 'companion-list', model_id: row.model_id, parent_id: null, table_name: null, state: 'error', reason: null, fields: null }), e); stop = true; continue; }
                // MED-3：只列「尚未达到新派生值」的伴生行（派生规则复用 planCompanion，不另写一份）；已是新派生值的不算未完成
                const pend = pendAll.filter(m => m.companion_of === row.model_id && (m.is_deleted === 0 || m.is_deleted == null) && planCompanion(row, m).state !== 'done').map(m => m.id).sort((a, b) => a - b);
                if (pend.length) rec({ kind: 'companion-list', model_id: row.model_id, parent_id: null, table_name: r.table_name, state: 'companions-unprocessed', companion_ids: pend, reason: `父行开始时已是目标值，其伴生行（${pend.join(', ')}）本次未处理，需人工核对是否已迁移`, fields: null });
            }
            if (parentSettled && !stop) {
                // 伴生集合以「父行成功之后」重新取得的列表为准，不用 apply 开始时的快照
                let freshAll;
                try { freshAll = await listModels(ctx); }
                catch (e) { fail(rec({ kind: 'companion-list', model_id: row.model_id, parent_id: row.model_id, table_name: null, state: 'error', reason: null, fields: null }), e); stop = true; continue; }
                const comps = freshAll.filter(m => m.companion_of === row.model_id && (m.is_deleted === 0 || m.is_deleted == null)).sort((a, b) => a.id - b.id);
                for (const compListRow of comps) {
                    if (stop) break;
                    let comp;
                    try { comp = await getModel(ctx, compListRow.id); }
                    catch (e) { fail(rec({ kind: 'companion', model_id: compListRow.id, parent_id: row.model_id, table_name: compListRow.table_name || null, state: 'error', reason: null, fields: null }), e); stop = true; continue; }
                    if (!comp) { rec({ kind: 'companion', model_id: compListRow.id, parent_id: row.model_id, table_name: compListRow.table_name || null, state: 'skipped-invalid', reason: '伴生行读不到（列表之后被删除）', fields: null }); continue; }
                    if (comp.is_deleted === 1) { rec({ kind: 'companion', model_id: comp.id, parent_id: row.model_id, table_name: comp.table_name, state: 'skipped-invalid', reason: '伴生行已删除', fields: null, before: pickState(comp) }); continue; }
                    if (comp.companion_of !== row.model_id) { rec({ kind: 'companion', model_id: comp.id, parent_id: row.model_id, table_name: comp.table_name, state: 'skipped-modified', reason: `伴生行已改挂到别的父表：当前 companion_of=${JSON.stringify(comp.companion_of)}`, fields: null, before: pickState(comp) }); continue; }
                    const cp = planCompanion(row, comp);
                    const cr = rec({ kind: 'companion', model_id: comp.id, parent_id: row.model_id, table_name: comp.table_name, state: cp.state === 'done' ? 'already-target' : cp.state, reason: cp.state === 'done' ? `${cp.reason}；${ALREADY_TARGET_NOTE}` : (cp.reason || null), fields: cp.fields || null, before: pickState(comp), target: cp.state === 'done' ? pickTarget(comp) : null });
                    if (cp.state === 'write' && !dryRun) {
                        if (await writeRow(cr, comp, cp.fields, `伴生模型 ${comp.id}`, row.model_id)) stop = true;
                    }
                }
                // 停止时，本父表尚未处理的伴生行补 not-processed
                if (stop) for (const c of comps) if (!result.rows.some(x => x.kind === 'companion' && x.model_id === c.id)) rec({ kind: 'companion', model_id: c.id, parent_id: row.model_id, table_name: c.table_name || null, state: 'not-processed', reason: '前面的步骤触发停止，本伴生行未处理', fields: null });
            }
        }
        // 停止后，清单里尚未处理的行补 not-processed 进未完成清单
        if (stop) {
            result.stopped = true;
            for (const row of list) if (!result.rows.some(x => x.kind === 'parent' && x.model_id === row.model_id)) rec({ kind: 'parent', model_id: row.model_id, table_name: null, state: 'not-processed', reason: '前面的行触发停止（GET 失败 / 超时、PUT 超时后重读失败等），本行未处理', fields: null });
        }
        finalizeResult(result, 'applied');
        if (receipt) receipt.finish();
        return result;
    } catch (e) {
        // 抛错退出前把已有进度如实落进回执（status 记 failed）
        result.stopped = true;   // X6：抛错退出同样是「已停止」
        if (receipt) { result.status = 'failed'; try { receipt.finish(); } catch (_) { /* 回执写不进去时以原错误为准 */ } }
        throw e;
    }
}

// ---------------------------------------------------------------- revert

/** 读 apply 回执并校验 format / migration_id / base_url / rows 形态 */
function loadApplyReceipt(file, options) {
    if (!file) throw new Error('--revert 必须给 --receipt <apply 产出的回执>');
    let data;
    try { data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
    catch (e) { throw new Error('回执读取 / 解析失败: ' + e.message); }
    if (data && typeof data === 'object' && data.format === OLD_RECEIPT_FORMAT_V1) throw new Error(`拒绝：回执 format 是旧版 ${OLD_RECEIPT_FORMAT_V1}（缺 before_meta / after_meta，无法做版本与归属核对），revert 只接受 ${RECEIPT_FORMAT}`);
    if (!data || typeof data !== 'object' || data.format !== RECEIPT_FORMAT) throw new Error(`拒绝：回执 format 不是 ${RECEIPT_FORMAT}（不是 apply 产出的回执）`);
    if (typeof data.migration_id !== 'string' || !MIG_ID_RE.test(data.migration_id)) throw new Error('拒绝：回执 migration_id 缺失或不合法');
    if (options.migrationId !== undefined && options.migrationId !== data.migration_id) throw new Error(`拒绝：--migration-id ${options.migrationId} 与回执 migration_id ${data.migration_id} 不一致`);
    if (data.base_url !== normalizeBaseUrl(options.baseUrl)) throw new Error(`拒绝：回执 base_url（${data.base_url}）与命令行 --base-url（${normalizeBaseUrl(options.baseUrl)}）不一致；回执不得跨服务使用`);
    validateReceiptRows(data.rows, file);
    return data;
}

const isPosInt = v => Number.isInteger(v) && v > 0;
const isStrOrNull = v => v === null || typeof v === 'string';
const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 两列（table_comment / impl_note）字段齐全且均为字符串或 null */
const hasValueCols = v => isPlainObj(v) && 'table_comment' in v && 'impl_note' in v && isStrOrNull(v.table_comment) && isStrOrNull(v.impl_note);

/**
 * X3：回执是不可信输入——在发出任何请求之前做完整结构校验（任一不符整份拒绝，零请求）：
 *   rows 每项为对象；model_id 正整数；kind ∈ { parent, companion, companion-list }；put_sent 为布尔；state 为字符串；
 *   伴生行 parent_id 正整数、父行 parent_id 为 null；
 *   put_sent = true（会被还原）的行：kind 只能是 parent / companion，before / target 两列字段齐全且均为字符串或 null，
 *     before_meta = { config_rev 整数, is_deleted 0 / null, companion_of 正整数或 null } 且与 kind / parent_id 一致（父行 null、伴生行 = parent_id），after_meta 缺省或 { config_rev 整数 }；
 *   state = already-target 的行：before / target 两列同样齐全；
 *   参与还原 / 衔接校验的行（put_sent 或 already-target）在同一回执内 model_id 不重复。
 */
function validateReceiptRows(rows, file) {
    if (!Array.isArray(rows)) throw new Error('拒绝：回执 rows 不是数组');
    const where = i => `回执 ${path.basename(String(file))} 第 ${i + 1} 行`;
    const seen = new Set();
    for (const [i, rw] of rows.entries()) {
        if (!isPlainObj(rw)) throw new Error(`拒绝：${where(i)} 不是对象`);
        if (!isPosInt(rw.model_id)) throw new Error(`拒绝：${where(i)} model_id 不是正整数`);
        if (!['parent', 'companion', 'companion-list'].includes(rw.kind)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）kind 不合法`);
        if (typeof rw.state !== 'string') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）state 不是字符串`);
        if (typeof rw.put_sent !== 'boolean') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）put_sent 不是布尔值`);
        if (rw.kind === 'parent' && rw.parent_id !== null) throw new Error(`拒绝：${where(i)}（父行 ${rw.model_id}）parent_id 必须为 null`);
        if (rw.kind === 'companion' && !isPosInt(rw.parent_id)) throw new Error(`拒绝：${where(i)}（伴生模型 ${rw.model_id}）缺少合法 parent_id（正整数），无法按写前归属还原`);
        if (rw.put_rejected !== undefined && typeof rw.put_rejected !== 'boolean') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）put_rejected 不是布尔值`);
        if (rw.timed_out_put !== undefined && typeof rw.timed_out_put !== 'boolean') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）timed_out_put 不是布尔值`);   // H6
        // Y3：put_rejected（服务端 409，确定零写入）只能出现在 put_sent = false 且 state = skipped-modified 的行上
        if (rw.put_rejected === true && !(rw.put_sent === false && rw.state === 'skipped-modified')) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）put_rejected 要求 put_sent = false 且 state = skipped-modified`);
        const restorable = rw.put_sent === true;
        if (restorable && rw.kind === 'companion-list') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）put_sent 行的 kind 只能是 parent / companion`);
        if (restorable || rw.state === 'already-target') {
            if (!hasValueCols(rw.before) || !hasValueCols(rw.target)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before / target 缺失或字段不全 / 类型不是「字符串或 null」`);
            // MED-2：before / target 的 table_comment 必须是 trim 后非空字符串（接口 set.table_comment 要求非空；null / 空串的回执必然不是本脚本产出，还原只会撞 400 或写出空表注释）
            if (typeof rw.before.table_comment !== 'string' || rw.before.table_comment.trim() === '' || typeof rw.target.table_comment !== 'string' || rw.target.table_comment.trim() === '') throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before / target 的 table_comment 必须是非空字符串`);
            // Y4：before 是 pickState 的四字段快照（apply 产出的 put_sent 行与 already-target 行都是）：table_comment 非空字符串（上面已核）、impl_note 字符串或 null（hasValueCols 已核）、
            //     companion_of 正整数或 null、is_deleted 0 或 null；且与 kind / parent_id 一致（父行 null、伴生行 = parent_id）
            const b = rw.before;
            if (!('companion_of' in b) || !('is_deleted' in b)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before 缺少 companion_of / is_deleted 字段`);
            if (!(b.companion_of === null || isPosInt(b.companion_of))) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before.companion_of 必须是正整数或 null`);
            if (!(b.is_deleted === null || b.is_deleted === 0)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before.is_deleted 必须是 0 或 null`);
            if (b.companion_of !== (rw.kind === 'companion' ? rw.parent_id : null)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}，${rw.state}）before.companion_of 与 kind / parent_id 不一致（父行须为 null，伴生行须等于 parent_id）`);
            if (seen.has(rw.model_id)) throw new Error(`拒绝：${where(i)} model_id ${rw.model_id} 在同一回执内重复`);
            seen.add(rw.model_id);
        }
        if (restorable) {
            const m = rw.before_meta;
            if (!isPlainObj(m) || !Number.isInteger(m.config_rev) || !(m.is_deleted === null || m.is_deleted === 0) || !(m.companion_of === null || isPosInt(m.companion_of))) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）before_meta 缺失或类型不对（须 { config_rev 整数, is_deleted 0 / null, companion_of 正整数 / null }）`);
            if (m.companion_of !== (rw.kind === 'companion' ? rw.parent_id : null)) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）before_meta.companion_of 与 kind / parent_id 不一致`);
            // Z2：comment-split 是 B 类写入、不递增 config_rev（递增则 apply 已记 error、after_meta 为 null）——after_meta 存在时其 config_rev 必须等于 before_meta.config_rev
            if (isPlainObj(rw.after_meta) && Number.isInteger(rw.after_meta.config_rev) && rw.after_meta.config_rev !== m.config_rev) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）after_meta.config_rev（${rw.after_meta.config_rev}）与 before_meta.config_rev（${m.config_rev}）不一致（B 类写入不递增 config_rev）`);
            if (rw.before.companion_of !== m.companion_of || rw.before.is_deleted !== m.is_deleted) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）before 快照的 companion_of / is_deleted 与 before_meta 不一致`);   // Y4
            if (rw.after_meta !== undefined && rw.after_meta !== null && !(isPlainObj(rw.after_meta) && Number.isInteger(rw.after_meta.config_rev))) throw new Error(`拒绝：${where(i)}（模型 ${rw.model_id}）after_meta 类型不对（须 { config_rev 整数 } 或 null）`);
        }
    }
}

/**
 * X5：多份回执的排序与衔接。多份时每份 started_at 必须是可解析的时间且两两不同（缺失 / 相同 ⇒ 顺序不可判定 ⇒ 拒绝）；按 started_at 逆序（最新的先）。
 * 同一 model_id 在多份回执里出现（put_sent 或 already-target 的行）按这个顺序组成链，相邻两份必须衔接：较新回执该行的 before = 较旧回执该行的 target；
 * 较旧行的结果不确定（state 不是 written / done / already-target，如 error / writing / timeout-unknown：请求可能没提交）时，也接受 = 较旧行的 before。否则拒绝。
 */
function orderAndCheckReceiptChain(rcps) {
    if (rcps.length > 1) {
        const seenAt = new Set();
        for (const x of rcps) {
            const t = typeof x.data.started_at === 'string' ? Date.parse(x.data.started_at) : NaN;
            if (Number.isNaN(t)) throw new Error(`拒绝：多份回执时每份都必须有可解析的 started_at（${path.basename(x.file)} 缺失或不合法），无法判定先后`);
            if (seenAt.has(t)) throw new Error(`拒绝：回执 ${path.basename(x.file)} 的 started_at 与另一份相同（${x.data.started_at}），无法判定先后`);
            seenAt.add(t);
            x.t = t;
        }
        rcps.sort((a, b) => b.t - a.t);
    }
    const chains = new Map();
    for (const x of rcps) for (const rw of x.data.rows) {
        if (!(rw.put_sent === true || rw.state === 'already-target')) continue;
        if (!chains.has(rw.model_id)) chains.set(rw.model_id, []);
        chains.get(rw.model_id).push({ file: x.file, rw });
    }
    const certain = new Set(['written', 'done', 'already-target']);
    for (const [id, arr] of chains) {
        for (let k = 0; k + 1 < arr.length; k++) {
            const newer = arr[k], older = arr[k + 1];
            // Y6：相邻回执里同一 model_id 的 kind 必须相同，伴生行的 parent_id 也必须相同（否则不是同一条归属链，值恰好衔接也不算）
            if (newer.rw.kind !== older.rw.kind || (newer.rw.parent_id !== older.rw.parent_id)) throw new Error(`拒绝：模型 ${id} 的回执链 kind / parent_id 不一致：较新回执 ${path.basename(newer.file)}（${newer.rw.kind}，parent_id=${newer.rw.parent_id}）与较旧回执 ${path.basename(older.file)}（${older.rw.kind}，parent_id=${older.rw.parent_id}）`);
            const linked = sameTarget(newer.rw.before, older.rw.target) || (!certain.has(older.rw.state) && sameTarget(newer.rw.before, older.rw.before));
            if (!linked) throw new Error(`拒绝：模型 ${id} 的回执链衔接不上：较新回执 ${path.basename(newer.file)} 的 before 不等于较旧回执 ${path.basename(older.file)} 的 target（中间有未提供的回执，或回执不属于同一条链）`);
        }
    }
    return chains;   // model_id → 回执链（最新的在前）
}

async function runRevert(liveDb, options) {
    checkMode(options, 'revert');
    if (options.migrationId !== undefined && !MIG_ID_RE.test(options.migrationId)) throw new Error('--migration-id 仅字母数字 _ . -，≤64 字符');
    const dryRun = !!options.dryRun;
    // P2：--receipt 可重复；按各回执 started_at 逆序（最新的先）逐份还原，每步只在当前值等于该份 target 时写——同一模型多份回执出现时，最终回到最早一份记录的 before
    const files = options.receipt === undefined ? [] : [].concat(options.receipt);
    if (files.length === 0) throw new Error('--revert 必须给 --receipt <apply 产出的回执>（可重复给多份）');
    const rcps = files.map(f => ({ file: f, data: loadApplyReceipt(f, options) }));
    const migId = rcps[0].data.migration_id;
    if (rcps.some(x => x.data.migration_id !== migId)) throw new Error('拒绝：多份回执的 migration_id 不一致');
    const chains = orderAndCheckReceiptChain(rcps);   // X5：started_at 校验 + 逆序 + 同一模型相邻回执衔接（全部在读 token / 发任何请求之前）
    const token = readToken(options.tokenFile);
    const ctx = { baseUrl: options.baseUrl, token, timeoutMs: parseTimeoutMs(options.timeoutMs) };
    const result = { status: dryRun ? 'dry-run' : 'reverted', migration_id: migId, rows: [], errors: [], timeouts: [], unfinished: [], counts: {}, notice: REV_IMPACT_NOTE };
    if (!dryRun && !options.revertReceipt) throw new Error('必须给 --revert-receipt <新回执路径.json>（revert 自身也写一份回执记录每行结果）');
    // P1：处理所有 put_sent 为 true 的行（不论回执里记成什么状态：写后核对失败 / 超时未知 / rev-changed 的行请求也可能已提交），每份回执内逆序
    const items = [];
    const srcFileOf = new Map();   // 复审 48：回执行 → 来源回执文件名（整批拒绝时报告触发行出自哪份回执）
    for (const x of rcps) for (const rw of x.data.rows.filter(r => r.put_sent === true).reverse()) { items.push(rw); srcFileOf.set(rw, path.basename(String(x.file))); }
    // MED-1：每条回执链的最旧一项若是 already-target（本次运行前就已是目标值、该回执没写）且没发过 PUT，说明更早的写入不在给定的回执里——
    // 这条链只能还原到较新回执的 before，不能回到原始值：列为 not-written-by-these-receipts（partial）；较新回执的还原照常进行
    const notWritten = [];
    for (const arr of chains.values()) { const oldest = arr[arr.length - 1].rw; if (oldest.state === 'already-target' && oldest.put_sent !== true) notWritten.push(oldest); }
    if (items.length === 0 && notWritten.length === 0) throw new Error(`回执（migration_id=${migId}）里没有可还原的行（没有 put_sent 的行）`);
    let receipt = null;
    if (!dryRun) {
        const rp = createReceiptFile(options.revertReceipt, '--revert-receipt');
        receipt = makeReceiptWriter(rp, { format: REVERT_RECEIPT_FORMAT, migration_id: migId, base_url: rcps[0].data.base_url, source_receipt: path.resolve(rcps[0].file), source_receipts: rcps.map(x => path.resolve(x.file)) }, result);
        result.receipt = rp;
    }
    const flush = () => { if (receipt) receipt.flush(); };
    try {
        // H6 整批确认（复审 48 sol-H，用户裁定）：任何写请求（包括读当前值的 GET）之前，扫描全部来源回执里 put_sent 为真的行——只要有一行 putResultUnknown 为真且没带 --inflight-cleared，
        //   整次还原拒绝执行、零写入：那个结果未知的在途请求可能稍后才提交，任何当前值（= target / = 写前原值 / 第三个值）都证明不了它已经结束，只有重启服务才能；也不逐行放行其余行。
        //   结果状态 blocked-inflight；触发行记 blocked-inflight（带来源状态与来源回执），其余行记 not-processed；revert 回执照常写出；干跑同样报告「会被拒绝」。
        const unknownRows = options.inflightCleared ? [] : items.filter(rw => putResultUnknown(rw));
        if (unknownRows.length) {
            for (const rw of items) {
                const bad = unknownRows.includes(rw);
                result.rows.push({
                    kind: 'revert', of_kind: rw.kind, parent_id: rw.kind === 'companion' ? rw.parent_id : null, model_id: rw.model_id, table_name: null,
                    state: bad ? 'blocked-inflight' : 'not-processed',
                    reason: bad ? `来源回执 ${srcFileOf.get(rw)} 中该行 state=${rw.state}、put_sent=true（PUT 结果未知，在途请求可能稍后才提交）：整次还原被拒绝，未发任何请求；先重启服务、确认在途请求已终止，再带 --inflight-cleared 重跑` : '整次还原被拒绝（来源回执里有 PUT 结果未知的行，见 blocked-inflight 行），本行未处理',
                    fields: null, before: null, target: pickTarget(rw.before),
                    ...(bad ? { source_state: rw.state, source_receipt: srcFileOf.get(rw) } : {})
                });
            }
            result.blockedInflight = true;
            flush();
            finalizeResult(result, 'reverted');
            if (receipt) receipt.finish();
            return result;
        }
        let stop = false;
        let idx = 0;
        for (; idx < items.length; idx++) {
            if (stop) break;
            const rw = items[idx];
            const label = `还原模型 ${rw.model_id}`;
            const r = { kind: 'revert', of_kind: rw.kind, parent_id: rw.kind === 'companion' ? rw.parent_id : null, model_id: rw.model_id, table_name: null, state: null, reason: null, fields: null, before: null, target: pickTarget(rw.before) };
            result.rows.push(r);
            let cur;
            try { cur = await getModel(ctx, rw.model_id); }
            catch (e) { r.state = 'error'; r.error = e.message; result.errors.push(`模型 ${rw.model_id}: ${e.message}`); stop = true; flush(); continue; }   // GET 失败 / 超时：报错停止，不写
            if (!cur) { r.state = 'skipped-invalid'; r.reason = '模型不存在'; flush(); continue; }
            r.table_name = cur.table_name;
            r.before = pickState(cur);   // 本次 revert 写前的值（revert 回执自己的 before）
            if (sameTarget(rw.before, rw.target)) { r.state = 'done'; r.reason = '回执里 before 已等于 target，无需还原'; flush(); continue; }
            if (!sameTarget(cur, rw.target)) {
                if (sameTarget(cur, rw.before)) {
                    // X2：当前值等于写前原值时，同样要核删除状态与写前归属（父行 companion_of 为空；伴生行 = 回执 parent_id）——被删除 / 改挂的行不能记 done
                    const ownOk = (cur.is_deleted === 0 || cur.is_deleted == null) && (rw.kind === 'companion' ? cur.companion_of === rw.parent_id : cur.companion_of == null);
                    // H6 整批确认：PUT 结果未知的行（putResultUnknown：timeout-unknown*；put_sent 为真且 state 为 skipped-modified；put_sent 为真且 state 为 writing）在整批门槛处（本循环之前）已拦下——
                    //   没带 --inflight-cleared 时整次拒绝、走不到这里，所以这里没有第二份「曾超时」判定，也没有逐行 uncertain；能走到这里的结果未知行必然带了 --inflight-cleared（操作员已确认在途请求已终止），
                    //   当前值 = 写前原值且归属正常 ⇒ done（reason 注明已确认）。done-presumed / rev-changed 的结果已由重读证实，本来就不算结果未知（收口批 2 LOW-4）。
                    if (ownOk) { r.state = 'done'; r.reason = '当前值已是写前原值（已还原 / 写入未生效）' + (putResultUnknown(rw) ? '；操作员已确认在途请求已终止（--inflight-cleared）' : ''); }
                    else { r.state = 'skipped-modified'; r.current = pickState(cur); r.reason = `当前值虽是写前原值，但行已被删除或归属与回执不符（回执写前归属：${rw.kind === 'companion' ? 'companion_of=' + rw.parent_id : '父行'}），不记 done：当前=${JSON.stringify({ is_deleted: cur.is_deleted, companion_of: cur.companion_of })}`; }
                }
                else { r.state = 'skipped-modified'; r.current = pickState(cur); r.reason = `当前 table_comment / impl_note 既不是回执的 target 也不是 before（期间被改过），不还原：当前=${JSON.stringify({ table_comment: cur.table_comment, impl_note: cur.impl_note })}`; }
                flush(); continue;
            }
            const fields = { table_comment: rw.before.table_comment, impl_note: rw.before.impl_note };
            r.state = 'write'; r.fields = fields;
            if (dryRun) continue;
            // 写前归属取自回执：父行 parent_only；伴生行 companion_of = 回执里的 parent_id（不是当前行的 companion_of）。
            // X1：版本条件 expected_config_rev = apply 写后读到的 config_rev（after_meta；没有则取写前 before_meta，B 类写入不递增）——版本变过（含删除后恢复、别的写入）⇒ 服务端 409 ⇒ skipped-modified
            const expRev = rw.after_meta && Number.isInteger(rw.after_meta.config_rev) ? rw.after_meta.config_rev : rw.before_meta.config_rev;
            r.state = 'writing'; r.put_sent = true; flush();
            try {
                const out = rw.kind === 'companion' ? await condWrite(ctx, cur, fields, label, rw.parent_id, undefined, expRev) : await condWrite(ctx, cur, fields, label, undefined, true, expRev);
                if (applyOutcome(result, r, out, 'reverted')) stop = true;
            } catch (e) {
                r.state = 'error'; r.error = e.message; result.errors.push(`模型 ${rw.model_id}: ${e.message}`);
                stop = true;   // X6：任何 error 一律停止
            }
            flush();
        }
        // 停止后，尚未处理的项补 not-processed
        if (stop) {
            result.stopped = true;
            for (let k = idx; k < items.length; k++) { const rw = items[k]; result.rows.push({ kind: 'revert', of_kind: rw.kind, parent_id: rw.kind === 'companion' ? rw.parent_id : null, model_id: rw.model_id, table_name: null, state: 'not-processed', reason: '前面的行触发停止，本行未处理', fields: null }); }
        }
        for (const rw of notWritten) result.rows.push({ kind: 'revert', of_kind: rw.kind, parent_id: rw.kind === 'companion' ? rw.parent_id : null, model_id: rw.model_id, table_name: null, state: 'not-written-by-these-receipts', reason: '该行在给定的回执里只以 already-target 出现（写入发生在更早的运行里），本次还原不了；请同时提供更早的回执', fields: null });
        finalizeResult(result, 'reverted');
        if (receipt) receipt.finish();
        return result;
    } catch (e) {
        result.stopped = true;
        if (receipt) { result.status = 'failed'; try { receipt.finish(); } catch (_) { /* 以原错误为准 */ } }
        throw e;
    }
}

// ---------------------------------------------------------------- 入口

/** 正式库路径只能通过这里注入（测试用假库）；命令行入口用模块默认的 run，不接受任何覆盖正式库路径的参数 */
function createRunner(config) {
    const liveDb = path.resolve(config && config.liveDb ? config.liveDb : LIVE_DB);
    return {
        liveDb,
        suggest: options => runSuggest(liveDb, options),
        apply: options => runApply(liveDb, options),
        revert: options => runRevert(liveDb, options)
    };
}
const DEFAULT_RUNNER = createRunner({ liveDb: LIVE_DB });

function parseArgs(argv) {
    const usage = '用法:\n'
        + '  --suggest (--db <库，只读> | --base-url <url> --token-file <路径>) [--min-len 15] [--out <新json>]\n'
        + '  --apply --list <定稿json> --base-url <url> --token-file <路径> --receipt <新回执.json> --migration-id <id> [--dry-run] [--timeout-ms 30000] [--allow-skips]\n'
        + '  --revert --receipt <apply产出的回执.json>（可重复） --revert-receipt <新回执.json> --base-url <url> --token-file <路径> [--migration-id <id>] [--dry-run] [--timeout-ms 30000] [--allow-skips] [--inflight-cleared]\n'
        + '信任模型：回执与 admin token 同一信任级别，只做结构 / 一致性校验、不验真伪；请与 token 文件同等保管，勿放共享目录；revert 前建议先 --dry-run 核对还原计划（dry-run 发只读 GET，不发 PUT、不创建回执）。\n'
        + '清单契约：new_impl_note 为 null（含空串）= 不改 impl_note；本脚本从不覆盖、也不清空已有 impl_note（已有不同内容 ⇒ skipped-modified）。\n'
        + '（apply / revert 不接受 --db：读写核对全经 HTTP；apply 的 --receipt 必须是不存在的新 .json 文件（独占创建），revert 只读它并另写 --revert-receipt；\n'
        + '  结果 partial（有跳过行）时退出码非 0，--allow-skips 时为 0；有写请求结果未知时恒非 0（--allow-skips 不豁免，并输出先重启服务的提示）；failed / interrupted 恒非 0；报告末尾输出未完成清单 JSON；\n'
        + '  --revert 的整批确认：在任何请求之前扫描全部来源回执里 put_sent 为真的行，只要有一行 PUT 结果未知（timeout-unknown* / put_sent 且 skipped-modified / put_sent 且 writing）且没带 --inflight-cleared，整次拒绝、零写入（结果 blocked-inflight，退出码恒非 0，--allow-skips 不豁免；--dry-run 同样报告会被拒绝）；\n'
        + '  先重启服务、确认在途请求已终止，再带 --inflight-cleared 重跑，整批照常处理）';
    const out = {};
    const withValue = { '--db': 'db', '--min-len': 'minLen', '--out': 'out', '--list': 'list', '--base-url': 'baseUrl', '--token-file': 'tokenFile', '--migration-id': 'migrationId', '--receipt': 'receipt', '--revert-receipt': 'revertReceipt', '--timeout-ms': 'timeoutMs' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (['--suggest', '--apply', '--revert'].includes(a)) {
            if (out.mode) throw new Error('--suggest / --apply / --revert 只能选一个\n' + usage);
            out.mode = a.slice(2);
        } else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--allow-skips') out.allowSkips = true;
        else if (a === '--inflight-cleared') out.inflightCleared = true;   // H6：仅 --revert；操作员确认服务已重启、在途请求已终止
        else if (withValue[a]) {
            if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(usage);
            if (a === '--receipt') { out.receipt = out.receipt === undefined ? argv[++i] : [].concat(out.receipt, argv[++i]); continue; }   // P2：--receipt 可重复（revert 用）
            if (out[withValue[a]] !== undefined) throw new Error(usage);
            out[withValue[a]] = argv[++i];
        } else throw new Error(usage);
    }
    if (!out.mode) throw new Error(usage);
    return out;
}

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function printSuggest(r) {
    console.log(`数据来源: ${r.source}（只读）  阈值: 表注释超过 ${r.min_len} 字  impl_note 列${r.impl_note_column_present ? '已存在' : '尚不存在（视为全空）'}`);
    console.log(`候选总体（非伴生、未删除、有注释）${r.counts.population} 个；超过 15 字 ${r.counts.over_15} / 超过 20 字 ${r.counts.over_20} / 超过 30 字 ${r.counts.over_30}`);
    console.log(`本次清单 ${r.items.length} 条（阈值 ${r.min_len}）：`);
    console.log([pad('id', 5), pad('layer', 6), pad('table_name', 36), pad('旧表注释', 40), pad('建议短名', 24), '建议实现说明 / 标记'].join(' | '));
    for (const it of r.items) {
        const tail = it.needs_manual ? '【需人工拟短名】' : (it.suggested_impl_note === null ? '（不拆，保持原样）' : it.suggested_impl_note);
        console.log([pad(it.model_id, 5), pad(it.layer, 6), pad(it.table_name, 36), pad(it.old_table_comment, 40), pad(it.suggested_short === null ? '-' : it.suggested_short, 24), tail].join(' | '));
    }
    console.log('注意: ' + r.notice);
}

function printPlan(r) {
    console.log(`模式: ${r.status}  migration_id=${r.migration_id}`);
    if (r.receipt) console.log(`回执: ${r.receipt}`);
    for (const row of r.rows) {
        console.log(`  [${row.kind}] 模型 ${row.model_id} ${row.table_name || ''} → ${row.state}${row.fields ? ' ' + JSON.stringify(row.fields) : ''}${row.reason ? '（' + row.reason + '）' : ''}${row.error ? ' 错误: ' + row.error : ''}`);
        if (row.normalized_fields && row.normalized_fields.length) console.log(`      随 PUT 规范化的字段: ${JSON.stringify(row.normalized_fields)}`);
    }
    console.log('汇总: ' + JSON.stringify(r.counts));
    if (r.outcome) console.log('结果: ' + r.outcome + (r.status === 'dry-run' ? '（干跑）' : ''));
    for (const t of (r.timeouts || [])) console.log(`  [PUT 超时] 模型 ${t.model_id}（${t.kind}）→ ${t.state}：${t.message}`);
    for (const e of r.errors) console.error('错误: ' + e);
    if (r.inflight_unknown) console.log('警告: ' + INFLIGHT_HINT);
    console.log('注意: ' + r.notice);
    console.log('未完成清单(JSON): ' + JSON.stringify(r.unfinished || []));
}

if (require.main === module) {
    (async () => {
        try {
            const opts = parseArgs(process.argv.slice(2));
            if (opts.mode === 'suggest') {
                const res = await DEFAULT_RUNNER.suggest(opts);
                printSuggest(res.report);
                if (res.out) console.log('清单已写入: ' + res.out);
            } else {
                const res = await DEFAULT_RUNNER[opts.mode](opts);
                printPlan(res);
                // failed / interrupted（中途停止）恒非 0，不受 --allow-skips 豁免；--allow-skips 只豁免 partial；干跑只看 errors
                //   H6：有写请求结果未知（inflight_unknown，含 revert 整批拒绝 blocked-inflight）恒非 0，同样不受 --allow-skips 豁免；干跑按既有约定只看 errors（干跑的 blocked-inflight 只报告「会被拒绝」）
                if (res.errors.length || res.status === 'failed' || res.status === 'interrupted' || res.status === 'blocked-inflight' || (res.inflight_unknown && res.status !== 'dry-run') || (res.status === 'partial' && !opts.allowSkips)) process.exitCode = 1;
            }
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    })();
}

module.exports = { createRunner, DEFAULT_RUNNER, DEFAULT_LIVE_DB: LIVE_DB, suggestSplit, COMPANION_SUFFIX, REV_IMPACT_NOTE, RECEIPT_FORMAT, REVERT_RECEIPT_FORMAT, normalizeBaseUrl, _ops };
