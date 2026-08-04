// scripts/backfill-sys-datetime-seconds.js — 时间格式统一 S3 存量回填（D6）
//   SSOT = 锚点 docs/local/系统迭代/任务_时间格式统一_20260804.md §3（D4/D6/D7）
//
// 做什么：把 sys_issues.dev_estimated_at 里**分钟级无秒**的存量值补成 'HH:MM:00'，与 S3 之后的
//   写入口径一致。这些值本就是分钟级精确值，补 ':00' 语义无损（D6）。
//
// ⛔ **不碰 deadline**（D6/D7 明令）：deadline 存量是**纯日期** 'YYYY-MM-DD'，给它补 '00:00:00'
//   等于赋予它本没有的精度——正是 v1.136.0 D2 的 dirty 判断要防的伪造。显示层同样不补（D7），
//   两种形态并存是刻意接受的，随新单录入自然稀释。本脚本对 deadline 只做**只读核对**，绝不写。
//
// 用法：
//   node scripts/backfill-sys-datetime-seconds.js                      # dry-run（默认·只报告不写）
//   node scripts/backfill-sys-datetime-seconds.js --apply              # 真写（自动先备份 db 文件）
//   node scripts/backfill-sys-datetime-seconds.js --db <path> [--apply]
//
// 安全设计（这是会改真实数据的脚本，按"最坏情况"写）：
//   · 默认 dry-run —— 不加 --apply 一个字节都不写
//   · --apply 前自动把 db 文件复制成 <db>.bak-<时间戳>
//   · WHERE 条件双保险：length()=16 **且** GLOB 形态匹配（只 length 会把 'abcdefghijklmnop' 也算进来）
//   · 事务包裹；写后逐行校验"新值 == 旧值 + ':00'"，不符即回滚
//   · 写后核对 deadline 的 COUNT/形态分布与写前**逐字相同**——证明确实一行没碰
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1]
  ? path.resolve(args[dbIdx + 1])
  : path.join(__dirname, '..', 'task_pool.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ 找不到数据库文件：${DB_PATH}`);
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// 目标形态：'YYYY-MM-DD HH:MM'（16 字符，无秒）
//   ⚠️ 只判 length(x)=16 不够——任意 16 字符垃圾串都会命中。GLOB 把形态也锁住。
//   GLOB 的 [0-9] 是真正的字符类（LIKE 的 _ 只管长度不管内容），所以这里用 GLOB 而非 LIKE。
// ⚠️ codex 253-B LOW-1：SQLite 是动态类型，`dev_estimated_at` 理论上可能存进数字/BLOB。
//   `length()`/`GLOB`/`substr()` 各自的隐式转换规则并不完全一致（BLOB 尤其），不统一 CAST 的话
//   同一行可能在不同谓词里表现不同 ⇒ 分类互相矛盾。所有谓词一律先 `CAST(... AS TEXT)`。
const EST_TXT = 'CAST(dev_estimated_at AS TEXT)';
const SHAPE_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]';
const WHERE_TARGET = `dev_estimated_at IS NOT NULL
    AND length(${EST_TXT}) = 16
    AND ${EST_TXT} GLOB '${SHAPE_GLOB}'`;

// ⚠️⚠️ codex 253 HIGH-1：**"已是秒级"这一侧也必须锁形态**。
//   首版只判 `length = 19` 就归为"无需处理"，于是 'ABCDEFGHIJKLMNOPQRS'（19 字符垃圾）、
//   '2026-08-01 10:30:45'（秒位非 00，违反 D4 口径）、'2026-99-99 99:99:99' 全被**静默放过**，
//   而且分类穷尽性自检**也发现不了**——它们确实被算进 alreadySec 了，三类之和照样等于总数。
//   ⇒ 这与我刚给"待回填"那一侧加 GLOB 是**同一个模式**：修了一侧没按模式扫另一侧，同款缺陷原地复发。
//   现在两侧口径对称：形态必须匹配，且秒位必须是 '00'。
const SHAPE_GLOB_SEC = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
const WHERE_DONE = `dev_estimated_at IS NOT NULL
    AND length(${EST_TXT}) = 19
    AND ${EST_TXT} GLOB '${SHAPE_GLOB_SEC}'
    AND substr(${EST_TXT}, 18, 2) = '00'`;
// 形态合法但**秒位非 00** 的历史值：单独成类，**本脚本不处理**——截断它会丢掉一个真实存在过的秒，
//   是否保留/截断要人工判断（D4 只说"用户填到分、后端补 :00"，没授权改写已有的非零秒）。
const WHERE_NONZERO_SEC = `dev_estimated_at IS NOT NULL
    AND length(${EST_TXT}) = 19
    AND ${EST_TXT} GLOB '${SHAPE_GLOB_SEC}'
    AND substr(${EST_TXT}, 18, 2) <> '00'`;

// ⚠️ codex 253-B M-1：GLOB 只认"数字形态"，`'2026-99-99 99:99:99'` 照样匹配 ⇒ 它会落进"秒位非 00"类，
//   但它的问题**不是非零秒，是整条 datetime 语义无效**。只标"非零秒"会误导人工处置方向。
//   SQLite 侧做闰年/月份校验很别扭，改在 JS 侧：**日期部分**走 Date 回比对（闰年/月末），
//   **时分秒**只做范围校验、刻意不进 Date（codex 253-C L-1）——把时分秒塞进 `new Date(y,mo,d,h,mi,se)`
//   回比对，在 DST 切换时刻会把合法值判成非法。中国无 DST，但这是给人看的诊断标注，不值得为
//   "名称更好听"引入一类只在别的时区才发作的误判。⇒ 函数名如实叫 DatePartValid，与实现一致。
function isDatePartValidWithTimeRange(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (h > 23 || mi > 59 || se > 59) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

// deadline 形态计数（轻量·dry-run 报告用）
async function deadlineShapeCounts() {
  const rows = await all(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN deadline IS NULL THEN 1 ELSE 0 END) AS nulls,
      SUM(CASE WHEN length(CAST(deadline AS TEXT)) = 10 THEN 1 ELSE 0 END) AS pureDate,
      SUM(CASE WHEN length(CAST(deadline AS TEXT)) = 16 THEN 1 ELSE 0 END) AS minuteLevel,
      SUM(CASE WHEN length(CAST(deadline AS TEXT)) = 19 THEN 1 ELSE 0 END) AS secondLevel
    FROM sys_issues`);
  return rows[0];
}

// deadline 的"没被碰过"指纹：形态计数 + 全列内容的**流式哈希**。
//   ⚠️ codex 253 M-1：首版用 `group_concat` 把全表 deadline 拼成一个字符串当指纹——在大表上会撞
//     SQLITE_MAX_LENGTH / 内存压力，而失败点恰好落在"回填后核对"这一步（最不该失败的地方）。
//   ⚠️ codex 253-B M-2：分页必须用 **keyset + 开局固定上界**，不能用 LIMIT/OFFSET——OFFSET 只保证
//     单次查询内有序，多次查询之间集合可能变（并发写入时漏行/重复行），算出的 hash 不对应任何
//     真实时刻的快照，前后比对的结论就无法解释。
//   ⚠️ 调用时机同样重要：**两次指纹都必须在 `BEGIN IMMEDIATE` 之后**——那时写锁已握住，
//     期间没有其他写入，前后两次才是同一快照下的可比值。
async function deadlineFingerprint() {
  const counts = await deadlineShapeCounts();
  const maxRow = await get(`SELECT COALESCE(MAX(id), 0) AS maxId FROM sys_issues`);
  const maxId = maxRow ? maxRow.maxId : 0;
  const h = crypto.createHash('sha256');
  const BATCH = 500;
  let lastId = 0, seen = 0;
  for (;;) {
    const page = await all(
      `SELECT id, deadline FROM sys_issues WHERE id > ? AND id <= ? ORDER BY id LIMIT ${BATCH}`, [lastId, maxId]);
    if (!page.length) break;
    // ⚠️ codex 253-C M-1：哈希输入必须**无歧义编码**。`${id}=${deadline}\n` 这种拼接，在 deadline
    //   含换行或 '=' 时能构造出不同数据流出相同 hash ⇒ "deadline 未变"的证明被削弱。
    //   而本脚本恰恰是在处理历史脏数据，校验层不能假设字段内容干净。JSON.stringify 自带引号与转义，
    //   且天然区分 null / 空串 / 字符串 "null"。
    for (const r of page) h.update(JSON.stringify([r.id, r.deadline]) + '\n');
    lastId = page[page.length - 1].id;
    seen += page.length;
  }
  return { ...counts, maxId, rowsHashed: seen, hash: h.digest('hex') };
}

async function main() {
  console.log(`\n📂 数据库：${DB_PATH}`);
  console.log(`🔧 模式：${APPLY ? '⚠️  APPLY（会真写）' : 'dry-run（只报告，不写）'}\n`);

  const total = (await get(`SELECT COUNT(*) AS c FROM sys_issues`)).c;
  const withEst = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE dev_estimated_at IS NOT NULL`)).c;
  const targets = await all(`SELECT id, dev_estimated_at FROM sys_issues WHERE ${WHERE_TARGET} ORDER BY id`);
  const alreadySec = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${WHERE_DONE}`)).c;
  const nonZeroSec = await all(`SELECT id, dev_estimated_at FROM sys_issues WHERE ${WHERE_NONZERO_SEC} ORDER BY id LIMIT 20`);
  const nonZeroSecTotal = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${WHERE_NONZERO_SEC}`)).c;
  // ⚠️ "形态异常"的判据必须是**待回填与已秒级的补集**，不能写成 `length NOT IN (16,19)`——
  //   长度 16 但形态不对的脏值（如 'ABCDEFGHIJKLMNOP'，GLOB 挡住了它进回填集）会**两边都不落**，
  //   在报告里静默消失，让人以为所有非空行都归了类。实测植入该值时 20 ≠ 2+16+1，正是这个缺口。
  // "形态不匹配" = 前三类的补集。用 NOT(...) 组合而不是自己列长度条件——列条件迟早与上面的定义漂移，
  //   补集写法保证**任何**没被前三类认领的行都会落到这里，分类天然穷尽。
  const WHERE_WEIRD = `dev_estimated_at IS NOT NULL
    AND NOT (${WHERE_TARGET})
    AND NOT (${WHERE_DONE})
    AND NOT (${WHERE_NONZERO_SEC})`;
  const weird = await all(`SELECT id, dev_estimated_at FROM sys_issues WHERE ${WHERE_WEIRD} ORDER BY id LIMIT 20`);
  const weirdTotal = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${WHERE_WEIRD}`)).c;

  console.log(`sys_issues 总行数：${total}`);
  console.log(`  dev_estimated_at 非空：${withEst}`);
  console.log(`    ├─ 已是秒级且秒位 =00：${alreadySec}  ← 无需处理`);
  console.log(`    ├─ 待回填（16 字符且形态匹配）：${targets.length}`);
  console.log(`    ├─ 秒位非 00 的历史值：${nonZeroSecTotal}${nonZeroSecTotal ? '  ⚠️ 见下（本脚本不处理·需人工定夺）' : ''}`);
  console.log(`    └─ 形态不匹配：${weirdTotal}${weirdTotal ? '  ⚠️ 见下（本脚本不处理）' : ''}`);
  // 分类穷尽性自检：四类之和必须等于非空总数，否则说明有行落在任何类别之外（报告不可信）
  const sum = alreadySec + targets.length + nonZeroSecTotal + weirdTotal;
  if (sum !== withEst) {
    console.error(`\n❌ 分类不自洽：${alreadySec} + ${targets.length} + ${nonZeroSecTotal} + ${weirdTotal} = ${sum} ≠ 非空 ${withEst}`);
    console.error(`   有行未被任何类别覆盖，报告不可信，拒绝继续。`);
    db.close();
    process.exit(1);
  }
  console.log(`    ✓ 分类穷尽自检：${alreadySec} + ${targets.length} + ${nonZeroSecTotal} + ${weirdTotal} = ${withEst}`);
  if (nonZeroSec.length) {
    console.log('\n⚠️  秒位非 00 的形态（**本脚本不处理**·需人工定夺）：');
    console.log('     · semanticValid=是 → 真实的历史非零秒：截断会丢掉一个真实存在过的秒，D4 只说');
    console.log('       "用户填到分、后端补 :00"，没授权改写已有的非零秒。');
    console.log('     · semanticValid=否 → **整条 datetime 语义无效**（如 2026-99-99 99:99:99），');
    console.log('       它的问题不是"非零秒"而是脏数据，处置方向完全不同（codex 253-B M-1）。');
    nonZeroSec.forEach(r => console.log(
      `     #${r.id}  ${JSON.stringify(r.dev_estimated_at)}  semanticValid=${isDatePartValidWithTimeRange(r.dev_estimated_at) ? '是' : '❌否'}`));
    if (nonZeroSecTotal > nonZeroSec.length) console.log(`     …… 另有 ${nonZeroSecTotal - nonZeroSec.length} 行未列出`);
  }
  if (weird.length) {
    console.log('\n⚠️  形态不匹配行（**本脚本不处理**，需人工判断是否脏数据）：');
    weird.forEach(r => console.log(`     #${r.id}  ${JSON.stringify(r.dev_estimated_at)}  (length=${String(r.dev_estimated_at).length})`));
    if (weirdTotal > weird.length) console.log(`     …… 另有 ${weirdTotal - weird.length} 行未列出`);
  }

  if (targets.length) {
    console.log(`\n待回填样本（前 10 条）：`);
    targets.slice(0, 10).forEach(r => console.log(`     #${r.id}  ${r.dev_estimated_at}  →  ${r.dev_estimated_at}:00`));
  }

  // deadline 只读核对（证明本脚本确实不碰它）。dry-run 报告只用轻量形态计数；
  //   真正做前后比对的**指纹**在 APPLY 路径的事务内计算（见下方 codex 253-B M-2 注释）。
  const dlShape = await deadlineShapeCounts();
  console.log(`\n⛔ deadline 只读核对（D6/D7：一行不碰）`);
  console.log(`   非空 ${dlShape.total - dlShape.nulls} 行 = 纯日期 ${dlShape.pureDate} + 分钟级 ${dlShape.minuteLevel} + 秒级 ${dlShape.secondLevel}`);
  console.log(`   ↑ 纯日期那部分**刻意保持原样**——补 '00:00:00' 是给它赋予本没有的精度（D7）`);

  if (!targets.length) {
    console.log('\n✅ 没有需要回填的行，退出。');
    db.close();
    return;
  }

  if (!APPLY) {
    console.log(`\n💡 dry-run 结束。确认无误后加 --apply 执行（会先自动备份 db 文件）。`);
    db.close();
    return;
  }

  // ── APPLY 路径 ─────────────────────────────────────────────────────────────
  // 时间戳精确到秒（原来 slice(0,15) 截到分钟，同一分钟内重跑会**覆盖上一次的备份**——
  //   备份被自己覆盖，正是最不该出问题的地方）
  const bak = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  // ⚠️ codex 253-B M-3：`VACUUM INTO` 要求目标文件**不存在**（存在即报错）。这条硬拦。
  //   ⚠️ 剩余空间**只打印源库大小供人工判断，不做硬校验**（codex 253-C L-3：注释不得声称超出实现——
  //     跨平台取剩余空间要 platform-specific 代码，为此引入分支不划算）。空间不足时 VACUUM INTO 会
  //     失败，而失败发生在**写事务之前**，数据无风险，只是需要操作者看懂报错。
  if (fs.existsSync(bak)) {
    console.error(`❌ 备份目标已存在：${bak}\n   拒绝覆盖（同秒重跑？请稍后再试）。`);
    db.close(); process.exit(1);
  }
  try {
    const srcSize = fs.statSync(DB_PATH).size;
    fs.accessSync(path.dirname(bak), fs.constants.W_OK);
    console.log(`\n🔎 备份前检查：目标目录可写；源库 ${(srcSize / 1048576).toFixed(1)} MB`);
    console.log(`   （备份需约等量空间——本脚本不做剩余空间硬校验，请自行确认磁盘充足）`);
  } catch (e) {
    console.error(`❌ 备份目标目录不可写：${path.dirname(bak)}（${e.message}）`);
    db.close(); process.exit(1);
  }
  // ⚠️ codex 253 M-2：**不能直接 copyFileSync**。生产库由 PM2 进程在线持有，WAL 模式下最新数据在
  //   `-wal` 里，光复制主库文件会得到一个"看起来成功、实际缺数据"的备份——而这个备份正是回滚的唯一依靠。
  //   ⇒ 优先用 `VACUUM INTO`（SQLite 3.27+）：它在数据库层面生成一致快照，自动含 WAL 未合并的内容。
  //   失败才回退文件复制，且**明确告知这份备份在 WAL 在线写入下不保证可恢复**。
  const jm = await get(`PRAGMA journal_mode`);
  const journalMode = (jm && (jm.journal_mode || jm['journal_mode'])) || 'unknown';
  let backupOk = false;
  try {
    await run(`VACUUM INTO ?`, [bak]);
    backupOk = true;
    console.log(`\n💾 已备份（VACUUM INTO 一致快照·journal_mode=${journalMode}）：${bak}`);
  } catch (e) {
    console.warn(`\n⚠️  VACUUM INTO 不可用（${e.message}），回退文件复制`);
    if (String(journalMode).toLowerCase() === 'wal') {
      console.error(`❌ 当前是 WAL 模式且 VACUUM INTO 失败：直接复制主库文件会漏掉 -wal 中未合并的数据，`);
      console.error(`   这份备份不保证可恢复。请停服后重跑，或先手动做一致备份。拒绝继续。`);
      db.close();
      process.exit(1);
    }
    fs.copyFileSync(DB_PATH, bak);
    backupOk = true;
    console.log(`💾 已备份（文件复制·journal_mode=${journalMode}）：${bak}`);
  }
  if (!backupOk) { console.error('❌ 备份未成功，拒绝继续'); db.close(); process.exit(1); }

  await run('BEGIN IMMEDIATE');
  try {
    // ⭐ codex 253-B M-2：**前后两次指纹都在事务内算**。BEGIN IMMEDIATE 已握写锁，期间无其他写入，
    //   两次才是同一快照下的可比值。首版把"回填前指纹"放在事务外，并发写入时算出的 hash 不对应
    //   任何真实时刻，前后比对的结论无法解释（"变了"到底是我改的还是别人改的？）。
    const dlBefore = await deadlineFingerprint();
    const upd = await run(
      `UPDATE sys_issues SET dev_estimated_at = dev_estimated_at || ':00' WHERE ${WHERE_TARGET}`);
    if (upd.changes !== targets.length) {
      throw new Error(`回填行数不符：预期 ${targets.length}，实得 ${upd.changes}`);
    }

    // 逐行校验：新值必须恰好是旧值 + ':00'
    for (const t of targets) {
      const now = await get('SELECT dev_estimated_at FROM sys_issues WHERE id = ?', [t.id]);
      if (!now || now.dev_estimated_at !== `${t.dev_estimated_at}:00`) {
        throw new Error(`#${t.id} 回填结果不符：期望 ${t.dev_estimated_at}:00，实得 ${JSON.stringify(now && now.dev_estimated_at)}`);
      }
    }

    // deadline 指纹必须逐字不变——这是"一行没碰"的硬证据，不是靠"我没写 UPDATE deadline"的自我声明
    const dlAfter = await deadlineFingerprint();
    if (JSON.stringify(dlAfter) !== JSON.stringify(dlBefore)) {
      throw new Error('deadline 指纹发生变化——本脚本绝不应触碰 deadline，立即回滚');
    }

    await run('COMMIT');
    console.log(`\n✅ 回填完成：${upd.changes} 行 dev_estimated_at 补 ':00'`);
    console.log(`   deadline 指纹逐字未变（${dlBefore.pureDate} 行纯日期原样保留）`);
    console.log(`   回退方法：停服后用备份覆盖 —— cp "${bak}" "${DB_PATH}"`);
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    console.error(`\n❌ 回填失败已回滚：${e.message}`);
    console.error(`   备份仍在：${bak}`);
    db.close();
    process.exit(1);
  }
  db.close();
}

main().catch((e) => {
  console.error('\n❌ 脚本异常:', e && (e.stack || e.message || e));
  process.exit(1);
});
