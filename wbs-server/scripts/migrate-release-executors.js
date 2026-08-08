#!/usr/bin/env node
/**
 * migrate-release-executors.js — 上线执行人多选与多人双确认：存量数据迁移
 *
 * 方案：docs/local/系统迭代/上线执行人多选与多人双确认_方案_20260806_v1.7.md §4.6
 * 目标：把 sys_releases.release_assignee_* 批次级单人执行人（8 列 + 迁移前的 10 列全家族）
 *   迁移为 sys_release_executors 逐人一行的新表。**只读预检 → 幂等迁移 → 台账**，绝不静默造
 *   时间/姓名补齐（方案 §4.6 原话）。
 *
 * 用法：
 *   node scripts/migrate-release-executors.js                    # dry-run（默认，只预检+统计，不写库）
 *   node scripts/migrate-release-executors.js --dry-run          # 同上，显式声明
 *   node scripts/migrate-release-executors.js --apply            # 真正执行（先自动快照备份）
 *   node scripts/migrate-release-executors.js --db <path>        # 指定库文件（默认 ../task_pool.db）
 *
 * ⚠️ 安全默认：不带 --apply 一律 dry-run。**dry-run 全程零写入**——不建 `_migration_log_release_executors`
 *   表、不写台账行，阻断清单/统计只打印到 stdout（照 migrate-commit-component-swap.js 既有范式，比
 *   "裸跑就是真写"更安全）。台账表的建表与写行**只在 --apply 真正跑通迁移事务时**、在同一事务内一并完成
 *   （见第三步）；--apply 但预检阶段即中止的场景同样不写台账（阻断清单只打 stdout，未进入迁移事务）。
 *   本地测试只准在 db 副本上跑 --apply，不许对本地真库跑写模式；生产何时迁由主会话/用户决定。
 *
 * 第一步 只读预检（P1-P9，方案 §4.6 表格，全部在写事务之前完成，含 P9）：
 *   P1  已发布∧assignee非空∧released_at 为 NULL 或非法日期串                        → 🔴 阻断
 *   P1b 已发布∧assignee非空∧旧 notify_status≠'sent'                                  → 🔴 阻断
 *   P2  assignee非空∧release_assignee_name 双参 trim 后为空                          → 🔴 阻断
 *   P3  release_assignee_id 非严格正整数（非空但非法：0/负数/非整数/字符串型）        → 🔴 阻断
 *   P4  created_by 非严格正整数 ∨ created_by_name 双参 trim 后为空                    → 🔴 阻断
 *   P5  notify_status='sent'∧notified_at 为 NULL 或非法日期串                        → 🔴 阻断
 *   P6  notify_status='failed'∧notify_error 双参 trim 后为空                         → 🔴 阻断
 *       ⭐ 298-L1（codex 审）写实澄清：P6 刻意**强于** DDL CHECK（新表 CHECK 只要求 notify_error
 *       IS NOT NULL，不判是否 trim 后非空——方案 §4.1 该分支注释原话"宁松勿紧"，是给应用层的正常写路径
 *       留空间）。P6 是**迁移质量门**，不是"与 DDL 逐字对齐"的判据——迁移只做一次，历史脏值（纯空格/
 *       Tab 之类的"看似有值实则无意义"的 notify_error）此时不清干净，将来就成了永久卡在新表里的脏数据，
 *       没有第二次预检机会。严格口径保留不放宽——排查出的空白错误信息本就该走人工清洗，不是软件问题。
 *   P7  notify_status∈(sent/sending/failed/stale)∧assignee为空（脏数据，全状态口径） → 🟡 报告+跳过
 *       ⚠️ 口径注意：P7 是全状态（已发布+计划中）口径；迁移映射里只有「计划中」子集落
 *       skipCounts.dirty_p7，「已发布」子集落 skipCounts.no_history（历史无执行人事实，
 *       两者处置理由不同，不强行合并成同一个数字——见下方打印时的口径拆分）。
 *   P8  notify_status='sending'（将迁为 stale）                                       → 🟡 报告
 *   P9  计划中∧迁移后在册执行人=1人 → ℹ️ 信息性提示（**用户拍板决策 7 第三次修正·方案 v1.7 二订**：
 *       执行人下限 2→1 后，单人批次本身就是合法的可发布终态，不再需要 admin 撤销重选——本项从 🟡"需要
 *       处理"降级为纯知悉性列示，`computeP9Merged` 计算逻辑与报告面本身保留不删〔仍值得让运维一眼看到
 *       "这批 release 迁移后是单人批次"这个事实，只是不再暗示"这是个问题"〕）。
 *       ⭐ 298-M2 修复后：写事务前先只读查一次「真实库既有在册子表行数」，与本次迁移计划（toInsert）
 *       合并判定，dry-run 与 apply 均在写之前输出——覆盖"该 release 已有子表行（早迁过/已手工加过执行
 *       人）、幂等闸跳过，但真实库里本来就只有 1 名在册执行人"这类批次（此前只看 toInsert 计划会漏报）。
 *       apply 成功后另有一道基于真实库状态的权威复核（见第三步之后）——预检期合并判定已覆盖绝大多数
 *       场景，二道复核是"提交后"视角的再确认，双保险而非互补缺口。
 *
 *   任一 🔴 项命中即整体中止（dry-run/apply 均零写入，阻断清单只打 stdout），输出人工修复清单。
 *
 * 第二步 迁移（幂等）：
 *   幂等闸——该 release_id 在 sys_release_executors 已有任意行（含软删）→ 整条跳过。**前提：目标表必须
 *   已存在**（本脚本不建表，C0 建表由 index.js initSchema 负责——服务启动即建；若表不存在，第一步预检阶段
 *   直接硬中止，见下方 ensureTargetTableExists）。
 *   映射规则见方案 §4.6 表格：
 *     已发布∧assignee非空∧旧ns='sent'        → 插 1 行：sent / done，executed_at=released_at
 *     已发布∧assignee非空∧旧ns≠'sent'        → 不迁（P1b 已阻断）
 *     已发布∧assignee为空                    → 不插（历史无执行人事实，不编造）
 *     计划中∧sent                             → 插 1 行：sent / pending
 *     计划中∧sending                          → 插 1 行：stale / pending（惰性转换语义）
 *     计划中∧failed / stale                   → 插 1 行：沿用原态 / pending
 *     计划中∧not_sent                         → 不插行（选人时才建）
 *   字段复制：notified_at/notify_message_key/notify_error/read_at 逐列带过来；notify_token 不带；
 *     notify_started_at 仅"计划中∧sending→stale"这一类带。added_by/added_by_name 取 created_by/
 *     created_by_name（近似值，不是真实审计，见下方 approximateAttribution 标注）。
 *
 * 第三步 迁移台账：写 `_migration_log_release_executors`（本脚本新建，独立于 sys_schema_migrations——
 *   后者是"迁移是否跑过"的单键标记表，容不下本次需要的分类计数明细；本表是一次性人工迁移脚本的审计
 *   台账）。**建表与写行都只发生在 --apply 真正跑通的那一次迁移事务内**（BEGIN IMMEDIATE ... COMMIT
 *   同一事务），dry-run 不建表、不写行——阻断清单/统计全部只打印到 stdout，7b 真实快照演练时靠 shell
 *   重定向留档，不依赖库内记录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const APPLY = process.argv.includes('--apply');
const dbIdx = process.argv.indexOf('--db');
const DB_FILE = dbIdx > -1 && process.argv[dbIdx + 1]
  ? path.resolve(process.argv[dbIdx + 1])
  : path.resolve(__dirname, '..', 'task_pool.db');

const TRIM_CHARSET = `' ' || char(9) || char(10) || char(13)`; // 空格+Tab+LF+CR，双参 trim 用

function openDb(readonly) {
  return new sqlite3.Database(DB_FILE, readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE);
}
const runAsync = (db, sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const allAsync = (db, sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const getAsync = (db, sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// SQL 字符串字面量内单引号需双写转义（' → ''），SQLite 标准语法——具名函数，供 vacuumInto 兜底路径调用。
function escapeSqliteStringLiteral(s) {
  return String(s).replace(/'/g, "''");
}
// ⭐ 298-L2（codex 审）：VACUUM INTO 目标路径优先走绑定参数——scratchpad 已实测本项目 sqlite3 驱动版本
//   支持 `VACUUM INTO ?`（含路径本身带单引号的场景也验证通过，见 C1 修复批报告），比手工转义更安全、
//   零转义心智负担。绑定参数这条路径若因驱动差异报"不认识 ?"类语法错误（未观测到，留兜底），退回
//   手工单引号转义路径；其余原因的失败（磁盘满/权限不足等真实 I/O 错误）直接向上抛出，不静默改走
//   兜底掩盖真实故障。
async function vacuumInto(db, targetPath) {
  try {
    await runAsync(db, `VACUUM INTO ?`, [targetPath]);
  } catch (e) {
    const looksUnsupportedBinding = /near\s+"\?"|syntax error/i.test((e && e.message) || '');
    if (!looksUnsupportedBinding) throw e;
    await runAsync(db, `VACUUM INTO '${escapeSqliteStringLiteral(targetPath)}'`);
  }
}

// ── 预检查询（第一步，只读）──────────────────────────────────────────────────
async function runPredicates(db) {
  const q = (sql) => allAsync(db, sql);

  const P1 = await q(`
    SELECT id, release_no, released_at FROM sys_releases
    WHERE status='已发布' AND release_assignee_id IS NOT NULL
      AND (released_at IS NULL OR datetime(released_at) IS NULL)`);

  const P1b = await q(`
    SELECT id, release_no, release_assignee_notify_status AS ns FROM sys_releases
    WHERE status='已发布' AND release_assignee_id IS NOT NULL
      AND COALESCE(release_assignee_notify_status,'not_sent') != 'sent'`);

  const P2 = await q(`
    SELECT id, release_no, release_assignee_name AS nm FROM sys_releases
    WHERE release_assignee_id IS NOT NULL
      AND (release_assignee_name IS NULL OR length(trim(release_assignee_name, ${TRIM_CHARSET})) = 0)`);

  const P3 = await q(`
    SELECT id, release_no, release_assignee_id AS aid FROM sys_releases
    WHERE release_assignee_id IS NOT NULL
      AND NOT (CAST(release_assignee_id AS INTEGER) = release_assignee_id AND release_assignee_id > 0)`);

  // ⭐ LOW-4（Opus 预筛）：补 COALESCE 防 NULL 漏选。created_by 前面没有 P2/P3 那种「IS NOT NULL」
  //   前置守卫，若 created_by 恰好为 NULL 且 created_by_name 非空合法，第一个 OR 分支
  //   `NOT (CAST(NULL...)=NULL AND NULL>0)` 求值为 NOT(NULL)=NULL（SQL 三值逻辑，不是 FALSE 也不是 TRUE），
  //   第二个 OR 分支也不命中 → 整行漏检，该行会一路混到 INSERT 时才撞 added_by NOT NULL/CHECK(>0) 崩事务。
  //   COALESCE 把 NULL 显式收敛成哨兵值 0（必然 > 0 判假），让 NOT(...) 恒定求值为 TRUE，堵死这条缝。
  const P4 = await q(`
    SELECT id, release_no, created_by, created_by_name FROM sys_releases
    WHERE NOT (CAST(COALESCE(created_by,0) AS INTEGER) = COALESCE(created_by,0) AND COALESCE(created_by,0) > 0)
       OR created_by_name IS NULL OR length(trim(created_by_name, ${TRIM_CHARSET})) = 0`);

  const P5 = await q(`
    SELECT id, release_no, release_assignee_notified_at AS na FROM sys_releases
    WHERE release_assignee_notify_status='sent'
      AND (release_assignee_notified_at IS NULL OR datetime(release_assignee_notified_at) IS NULL)`);

  // 298-L1：本判据（双参 trim 后非空）比新表 DDL CHECK（仅 IS NOT NULL）严格——刻意如此，迁移只做一次，
  //   是质量门不是"与 DDL 逐字对齐"的判据，见文件头 P6 条目详述，严格口径保留不放宽。
  const P6 = await q(`
    SELECT id, release_no, release_assignee_notify_error AS err FROM sys_releases
    WHERE release_assignee_notify_status='failed'
      AND (release_assignee_notify_error IS NULL OR length(trim(release_assignee_notify_error, ${TRIM_CHARSET})) = 0)`);

  const P7 = await q(`
    SELECT id, release_no, status, release_assignee_notify_status AS ns FROM sys_releases
    WHERE release_assignee_notify_status IN ('sent','sending','failed','stale')
      AND release_assignee_id IS NULL`);

  const P8 = await q(`
    SELECT id, release_no FROM sys_releases WHERE release_assignee_notify_status='sending'`);

  return { P1, P1b, P2, P3, P4, P5, P6, P7, P8 };
}

function printBlockList(label, rows, fmt) {
  console.log(`  🔴 ${label}：${rows.length} 条`);
  for (const r of rows) console.log(`      #${r.id} ${r.release_no}　${fmt(r)}`);
}

// ⭐ LOW-1（Opus 预筛）：blockers 元数据表驱动阻断判定，不再是 7 条各自独立的 if——
//   以后加 P10 只需在这个数组里加一条，不会出现"数组声明了但判定逻辑没跟着走"的失效可能。
const BLOCKERS = [
  { key: 'P1', label: 'P1（已发布∧assignee非空∧released_at 缺失/非法）', fmt: r => `released_at=${JSON.stringify(r.released_at)}` },
  { key: 'P1b', label: 'P1b（已发布∧assignee非空∧旧ns≠sent，不允许伪造 sent）', fmt: r => `ns=${r.ns}` },
  { key: 'P2', label: 'P2（assignee非空∧姓名 trim 后为空）', fmt: r => `name=${JSON.stringify(r.nm)}` },
  { key: 'P3', label: 'P3（release_assignee_id 非严格正整数）', fmt: r => `id值=${JSON.stringify(r.aid)}` },
  { key: 'P4', label: 'P4（created_by 非严格正整数 或 created_by_name 为空）', fmt: r => `created_by=${JSON.stringify(r.created_by)} name=${JSON.stringify(r.created_by_name)}` },
  { key: 'P5', label: 'P5（ns=sent∧notified_at 缺失/非法）', fmt: r => `notified_at=${JSON.stringify(r.na)}` },
  { key: 'P6', label: 'P6（ns=failed∧notify_error 为空）', fmt: r => `notify_error=${JSON.stringify(r.err)}` },
];

// ── 迁移映射（第二步）──────────────────────────────────────────────────────
// 返回该行的迁移动作：null=不插行；否则返回待插入字段对象
function planRowAction(r) {
  // ⭐ 298-M1（codex 审）：入口统一把 NULL 归一为 not_sent 口径。该列 DDL 声明 NOT NULL DEFAULT 'not_sent'
  //   （index.js:480/1217/1501），且已实测——直连 SQL 插 NULL 会被 SQLITE_CONSTRAINT 拒（scratchpad 验证，
  //   见 C1 修复批报告）——本条在**当前 schema 下确认不可达**。保留这条归一化是纯防御性收口：不这样做的话，
  //   若该列未来因某种非常规写入路径出现 NULL（如指向旧库跳过了 NOT NULL 迁移、或未来 schema 变更），下面
  //   末尾的 skip_unknown_ns 兜底分支会把它误判成"域外值需人工核查"，而它的正确归属其实与显式 'not_sent'
  //   完全一样（不插行）。数据结果不受影响（not_sent 本就不插行），修的是分类准确性——skip_unknown_ns
  //   之后只留给真正超出 5 态值域的脏值。
  const ns = r.release_assignee_notify_status || 'not_sent';
  const hasAssignee = r.release_assignee_id != null;

  if (r.status === '已发布') {
    if (!hasAssignee) return { action: 'skip_no_history', reason: '已发布∧assignee为空，历史无执行人事实，不编造' };
    if (ns !== 'sent') return { action: 'skip_blocked_p1b', reason: 'P1b 已阻断（不会走到这里，防御分支）' };
    return {
      action: 'insert',
      notify_status: 'sent', notify_started_at: null,
      exec_status: 'done', executed_at: r.released_at,
    };
  }

  // 计划中（ns 已在入口归一化，此处不会再是 null）
  if (!hasAssignee) {
    if (ns === 'not_sent') return { action: 'skip_not_sent', reason: '计划中∧not_sent，选人时才建' };
    return { action: 'skip_dirty_p7', reason: `脏数据（P7）：ns=${ns} 但 assignee 为空` };
  }
  if (ns === 'not_sent') return { action: 'skip_not_sent', reason: '计划中∧not_sent，选人时才建（assignee 非空亦不插，不猜测意图）' };
  if (ns === 'sent') return { action: 'insert', notify_status: 'sent', notify_started_at: null, exec_status: 'pending', executed_at: null };
  if (ns === 'sending') return { action: 'insert', notify_status: 'stale', notify_started_at: r.release_assignee_notify_started_at, exec_status: 'pending', executed_at: null, fromSending: true };
  if (ns === 'failed') return { action: 'insert', notify_status: 'failed', notify_started_at: null, exec_status: 'pending', executed_at: null };
  if (ns === 'stale') return { action: 'insert', notify_status: 'stale', notify_started_at: null, exec_status: 'pending', executed_at: null };
  return { action: 'skip_unknown_ns', reason: `未知 notify_status=${ns}，人工核查` };
}

// P9（298-M2：补真实库覆盖）：合并"真实库既有在册子表行数"（只读查询，覆盖幂等闸跳过的历史单人批次）
//   + "本次迁移计划新增行数"，按方案口径"计划中∧迁移后在册执行人=1人"分组判定。dry-run 也能报出——
//   不再局限于"仅本次要插入的行"，覆盖"该 release 已有子表行（早迁过/已手工加过执行人）、幂等闸跳过、
//   但真实库里本来就只有 1 名在册执行人"这类此前只看 toInsert 计划会漏报的存量批次。
//   ⚠️ 正确性前提（C1-fix-2 追记）：本函数"existingActiveCounts + toInsert 两者互斥不重叠"的假设，
//   依赖幂等闸按**全部行（含软删）**跳过——见本文件幂等闸逻辑 `existingReleaseIds.has(r.id)` 判据。
//   若幂等闸未来改成只看"在册行"（即忽略软删行、只要在册数=0 就允许再次迁移），会出现同一 release 既有
//   existingActiveCounts 里的旧行计数、又有 toInsert 里的新插入计数，两者对同一 release_id 相加会**双计数**，
//   把"实际 1 人"误判成"2 人"从而让本该出现在 P9 这份仅供知悉清单里的批次被漏收（P9 已随决策 7 三修
//   降级为信息性提示，漏收不再是"需处理项被藏起来"，但仍是清单本身不准确，该修）。改动幂等闸口径前
//   必须回头核这条前提是否还成立。
function computeP9Merged(existingActiveCounts, allReleases, toInsert) {
  const planningReleaseNo = new Map(
    allReleases.filter(r => r.status === '计划中').map(r => [r.id, r.release_no])
  );
  const combined = new Map(); // release_id -> 合并后计数（既有在册行数 + 本次计划插入数）
  for (const row of existingActiveCounts) {
    if (!planningReleaseNo.has(row.release_id)) continue; // 只关心「计划中」批次，已发布的既有行不入 P9 范畴
    combined.set(row.release_id, (combined.get(row.release_id) || 0) + row.cnt);
  }
  for (const { r } of toInsert) {
    if (r.status !== '计划中') continue;
    combined.set(r.id, (combined.get(r.id) || 0) + 1);
  }
  return [...combined.entries()]
    .filter(([, cnt]) => cnt === 1)
    .map(([id]) => ({ id, release_no: planningReleaseNo.get(id) }));
}

async function main() {
  console.log('=== sys_release_executors 存量迁移（上线执行人多选与多人双确认，方案 §4.6）===');
  console.log(`库文件：${DB_FILE}`);
  console.log(`模式：${APPLY ? '⚠️  APPLY（真正写库）' : 'dry-run（只预检+统计，不改动）'}\n`);

  if (!fs.existsSync(DB_FILE)) {
    console.error(`✗ 库文件不存在：${DB_FILE}`);
    process.exit(1);
  }

  const probe = openDb(true);
  let pre, allReleases, existingReleaseIds, existingActiveCounts;
  try {
    // ⭐ HIGH-1（Opus 预筛）：显式探测目标表是否存在，不存在直接硬中止并给出可执行提示——
    //   不再用 .catch(() => []) 把"表不存在"和"查询真的失败了"混为一谈静默吞掉。
    const tableRow = await getAsync(probe,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='sys_release_executors'`);
    if (!tableRow) {
      throw new Error('目标表不存在：请先部署 C0 建表（重启服务触发 initSchema）后再跑本脚本');
    }

    pre = await runPredicates(probe);
    allReleases = await allAsync(probe, `
      SELECT id, release_no, status, release_assignee_id, release_assignee_name,
             release_assignee_notify_status, release_assignee_notify_started_at,
             release_assignee_notified_at, release_assignee_notify_message_key,
             release_assignee_notify_error, release_assignee_read_at,
             released_at, created_by, created_by_name
      FROM sys_releases ORDER BY id`);
    // 表已确认存在（上方探测），这里查询失败就是真失败，一律 rethrow，不吞。
    const existingRows = await allAsync(probe, `SELECT DISTINCT release_id FROM sys_release_executors`);
    existingReleaseIds = new Set(existingRows.map(r => r.release_id));
    // ⭐ 298-M2（codex 审）：只读查询，写事务开始前算好"真实库现有在册子表行数"（按 release 分组），供
    //   下方 computeP9Merged 与本次迁移计划合并判定——dry-run/apply 共用同一次查询结果，不重复查两次。
    existingActiveCounts = await allAsync(probe,
      `SELECT release_id, COUNT(*) AS cnt FROM sys_release_executors WHERE removed_at IS NULL GROUP BY release_id`);
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  } finally {
    probe.close();
  }

  // ── 打印预检结果 ──
  console.log('── 第一步：只读预检 ──');
  const blockedReleaseIds = new Set();
  for (const b of BLOCKERS) {
    const rows = pre[b.key];
    if (rows.length) {
      printBlockList(b.label, rows, b.fmt);
      rows.forEach(r => blockedReleaseIds.add(r.id));
    }
  }
  const blockedTotal = blockedReleaseIds.size;

  if (pre.P7.length) {
    const p7Planning = pre.P7.filter(r => r.status === '计划中');
    const p7Released = pre.P7.filter(r => r.status !== '计划中');
    console.log(`  🟡 P7（脏数据：ns 活跃但 assignee 为空，全状态口径）：${pre.P7.length} 条`
      + `（计划中 ${p7Planning.length} 条→迁移时口径归 dirty_p7；已发布 ${p7Released.length} 条→迁移时口径归 no_history，二者理由不同不强行合并成同一数字，详见下方迁移映射的口径拆分）`);
    for (const r of pre.P7) console.log(`      #${r.id} ${r.release_no}　status=${r.status} ns=${r.ns}`);
  }
  if (pre.P8.length) {
    console.log(`  🟡 P8（notify_status=sending，迁移时将转为 stale）：${pre.P8.length} 条`);
    for (const r of pre.P8) console.log(`      #${r.id} ${r.release_no}`);
  }

  console.log(`\n预检汇总：sys_releases 总行数=${allReleases.length}　🔴 阻断批次数=${blockedTotal}　🟡 P7脏数据(全状态)=${pre.P7.length}　🟡 P8 sending=${pre.P8.length}`);

  if (blockedTotal > 0) {
    console.error(`\n✗ 存在 ${blockedTotal} 个批次命中 🔴 阻断项，整体中止迁移（dry-run/apply 均零写入——不建台账表、不写台账行，阻断清单已打印于上方 stdout）。`);
    console.error('  请人工修复上方列出的批次后重新预检；本脚本绝不静默造时间/造姓名补齐。');
    process.exit(1);
  }

  // ── 第二步：迁移映射（先算好，dry-run 与 apply 共用同一份计划）──
  console.log('\n── 第二步：迁移映射（幂等：release_id 在 sys_release_executors 已有任意行则整条跳过）──');
  const toInsert = [];
  const skipCounts = { idempotent: 0, not_sent: 0, dirty_p7: 0, no_history: 0, unknown: 0 };
  const unknownRows = []; // LOW-2：未知态也留清单，不只留计数
  for (const r of allReleases) {
    if (existingReleaseIds.has(r.id)) { skipCounts.idempotent++; continue; }
    const plan = planRowAction(r);
    if (plan.action === 'insert') { toInsert.push({ r, plan }); continue; }
    if (plan.action === 'skip_not_sent') { skipCounts.not_sent++; continue; }
    if (plan.action === 'skip_dirty_p7') { skipCounts.dirty_p7++; continue; }
    if (plan.action === 'skip_no_history') { skipCounts.no_history++; continue; }
    skipCounts.unknown++;
    unknownRows.push(r);
  }
  console.log(`  将插入：${toInsert.length} 行`);
  console.log(`  跳过——幂等(已有子表行)：${skipCounts.idempotent}　not_sent(选人时才建)：${skipCounts.not_sent}　脏数据dirty_p7(计划中子集)：${skipCounts.dirty_p7}　已发布无执行人no_history：${skipCounts.no_history}　未知态：${skipCounts.unknown}`);
  if (toInsert.length) {
    console.log('  明细：');
    for (const { r, plan } of toInsert) {
      console.log(`    #${r.id} ${r.release_no}　${r.status}　${r.release_assignee_notify_status}→${plan.notify_status}/${plan.exec_status}　执行人=${r.release_assignee_name}(${r.release_assignee_id})`);
    }
  }
  if (unknownRows.length) {
    console.log('  ⚠️ 未知态清单（人工核查）：');
    for (const r of unknownRows) console.log(`    #${r.id} ${r.release_no}　status=${r.status} ns=${r.release_assignee_notify_status}`);
  }

  // P9：合并真实库既有在册行数（写事务前的只读查询，298-M2）+ 本次迁移计划，dry-run 与 apply 均输出。
  const p9Plan = computeP9Merged(existingActiveCounts, allReleases, toInsert);
  if (p9Plan.length) {
    console.log(`\nℹ️ P9（预检期合并预判：既有在册行+本次计划）：${p9Plan.length} 个「计划中」批次迁移后仅 1 名在册执行人——单人批次·决策 7 三修后 ≥1 阈值下可自行发布·仅供知悉：`);
    for (const r of p9Plan) console.log(`    #${r.id} ${r.release_no}`);
  } else {
    console.log('\n✓ P9（预检期合并预判：既有在册行+本次计划）：无「计划中∧迁移后仅 1 名在册执行人」的批次。');
  }

  if (!APPLY) {
    console.log('\ndry-run 结束，未写入任何数据（不建台账表、不写台账行）。确认无误后加 --apply 执行（会先自动快照备份）。');
    return;
  }

  // ── 备份（VACUUM INTO，照 migrate-commit-component-swap.js 范式，298-L2 加固）──
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${DB_FILE}.backup_relexec_${stamp}`;
  const bdb = openDb(true);
  try {
    await vacuumInto(bdb, backup);
    console.log(`\n✓ 快照备份：${backup}`);
  } catch (e) {
    console.error('✗ 备份失败，已中止（不在无备份的情况下改数据）：' + e.message);
    process.exit(1);
  } finally {
    bdb.close();
  }

  // ── 第三步执行：单事务内逐行 INSERT + 建台账表 + 写台账行（全部同一事务）──
  const db = openDb(false);
  let done = 0;
  try {
    await runAsync(db, 'BEGIN IMMEDIATE');
    for (const { r, plan } of toInsert) {
      const st = await runAsync(db, `
        INSERT INTO sys_release_executors
          (release_id, user_id, user_name, notify_status, notify_started_at, notified_at,
           notify_message_key, notify_error, read_at, exec_status, executed_at,
           added_by, added_by_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          r.id, r.release_assignee_id, r.release_assignee_name,
          plan.notify_status, plan.notify_started_at, r.release_assignee_notified_at,
          r.release_assignee_notify_message_key, r.release_assignee_notify_error, r.release_assignee_read_at,
          plan.exec_status, plan.executed_at,
          r.created_by, r.created_by_name, // approximateAttribution：added_by 取建单人近似归属，非真实审计
        ]);
      if (st.changes !== 1) throw new Error(`#${r.id} 插入异常（期望 1 行，实际 ${st.changes}）`);
      done++;
    }

    // 事务内后验：新插入行数与计划数一致
    if (done !== toInsert.length) throw new Error(`插入行数不符：计划 ${toInsert.length}，实际 ${done}`);

    await writeLedgerInTxn(db, { mode: 'apply', pre, blockedTotal: 0, inserted: done, skipped: skipCounts, total: allReleases.length });
    await runAsync(db, 'COMMIT');
    console.log(`\n✓ 已迁移 ${done} 行，事务提交（台账表已建/已写：_migration_log_release_executors）。`);
  } catch (e) {
    try { await runAsync(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    console.error(`\n✗ 失败已回滚（成功 ${done} 条也一并撤销，含台账写入）：${e.message}`);
    console.error(`  数据未变。备份仍在：${backup}`);
    db.close();
    process.exit(1);
  }

  // ── 复核二道（P9 权威版：298-M2 后与预检期的合并判定结论重叠——预检期已覆盖新插入行 + 幂等跳过的
  //   历史单人批次，本道是提交后基于真实库状态的再确认，双保险而非填补缺口）──
  try {
    const p9 = await allAsync(db, `
      SELECT r.id, r.release_no, COUNT(e.id) AS active_cnt
      FROM sys_releases r JOIN sys_release_executors e ON e.release_id = r.id AND e.removed_at IS NULL
      WHERE r.status='计划中'
      GROUP BY r.id HAVING COUNT(e.id) = 1`);
    if (p9.length) {
      console.log(`\nℹ️ P9 二道复核（基于真实库状态，权威）：${p9.length} 个「计划中」批次仅 1 名在册执行人——单人批次·决策 7 三修后 ≥1 阈值下可自行发布·仅供知悉：`);
      for (const r of p9) console.log(`    #${r.id} ${r.release_no}`);
    } else {
      console.log('\n✓ P9 二道复核（基于真实库状态，权威）：无「计划中∧仅 1 名在册执行人」的批次。');
    }
    const total = await getAsync(db, `SELECT COUNT(*) AS c FROM sys_release_executors`);
    console.log(`✓ 复核：sys_release_executors 当前总行数=${total.c}（本次新增 ${done}，之前已有 ${total.c - done}）。`);
  } catch (e) {
    console.error('⚠️ 复核查询失败（数据已提交）：' + e.message);
  } finally {
    db.close();
  }
}

async function ensureLedgerTable(db) {
  await runAsync(db, `CREATE TABLE IF NOT EXISTS _migration_log_release_executors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    total_releases INTEGER NOT NULL,
    inserted_count INTEGER NOT NULL,
    blocked_count INTEGER NOT NULL,
    detail_json TEXT NOT NULL
  )`);
}
// ⭐ MED-1（Opus 预筛）：台账建表+写行只在这里被调用一次——唯一调用点在 apply 的真实迁移事务内部
//   （见上方 main() 的 BEGIN IMMEDIATE...COMMIT 段）。dry-run 与预检阻断路径都不再调用它，全程零写入。
async function writeLedgerInTxn(db, { mode, pre, blockedTotal, inserted, skipped, total }) {
  await ensureLedgerTable(db);
  const detail = {
    predicates: {
      P1: pre.P1.length, P1b: pre.P1b.length, P2: pre.P2.length, P3: pre.P3.length,
      P4: pre.P4.length, P5: pre.P5.length, P6: pre.P6.length, P7: pre.P7.length, P8: pre.P8.length,
    },
    skipped,
  };
  await runAsync(db, `
    INSERT INTO _migration_log_release_executors (run_at, mode, total_releases, inserted_count, blocked_count, detail_json)
    VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?)`,
    [mode, total, inserted, blockedTotal, JSON.stringify(detail)]);
}

// require.main 守卫：`node scripts/migrate-release-executors.js` 直跑时 require.main===module 为真，
//   main() 照常自动执行，CLI 行为逐字不变。被 require（如临时验证脚本对 planRowAction 之类内部函数的
//   单元级校验）时不自动触发 main()，避免测试脚本一 require 就意外跑起完整迁移流程。
//   298-M1 fixture 用得到本条：release_assignee_notify_status 是 NOT NULL 列（已实测直插 NULL 会被
//   SQLITE_CONSTRAINT 拒），构造不出"NULL 落库"的真实 DB 场景，只能这样直接调用函数验证该分支逻辑。
if (require.main === module) {
  main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
}
// ⭐ 299-L3（codex 审）：导出面收窄到纯函数——planRowAction/computeP9Merged/escapeSqliteStringLiteral/
//   BLOCKERS 均不接触 DB/文件系统，输入输出可控，适合被外部脚本 require 做单元级校验（298-M1 fixture
//   即此用法）。runPredicates（依赖真实 db 连接跑 SQL）与 vacuumInto（依赖真实文件系统路径触达真实库
//   VACUUM INTO）**不导出**——两者只在本文件 main() 的 CLI 上下文里有意义，外部单元测试若要覆盖它们的
//   行为，应该走"起一个真实/scratchpad db 副本 + CLI 跑一遍"的集成测试路径（本项目既有测试范式，见
//   本次 C1 系列历次报告的三场景验证），而不是绕开 CLI 直接单测这两个函数——直接单测反而会诱使写出
//   "假装有个 db 连接"的 mock，偏离真实行为、埋下假绿隐患。现有单元用例（298-M1 fixture）只用到
//   planRowAction，未依赖这两者，移出导出面不破坏既有测试。
module.exports = { planRowAction, computeP9Merged, escapeSqliteStringLiteral, BLOCKERS };
