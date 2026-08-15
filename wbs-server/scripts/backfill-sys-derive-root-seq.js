// scripts/backfill-sys-derive-root-seq.js —— 派生单子编号「#根_序」存量回填独立脚本
//   （方案 20260813_v1.8 §15.2/§15.5·S12-a）
//
// 做什么：与 routes/sys-iteration/index.js runSysMigration 的 [1d] 步骤**同一份判定逻辑**
//   （require utils/sys-derive-numbering.js，同规则禁双实现，不复刻）——对 sys_issues 全表分类：
//     ① 待首次回填候选（origin_issue_id 非空 ∧ derive_root_id/derive_seq 双空 ∧ 血缘链完整可求根）
//     ② 已回填稳态（root/seq 双非空）——只复核根链一致 + seq 正整数
//     ③ 各类熔断违例（半填/自引用/环/断链/根不存在/超深/错根/seq 非正）
//   dry-run（默认）只读输出分类报告；--apply 才真写（首次回填赋号 + 根单 derive_seq_alloc 初始化/续写 +
//   不变量探针 + 建部分唯一索引，与迁移链 [1d] 逐字同源）。
//
// 用途：上线前对生产真实样本 dry-run 核实（[[feedback_real_sample_before_deploy]]）——生产实际会在启动
//   迁移链里自动跑这套逻辑（§10-1b 已并入），本脚本供**提前**核实用，不是生产必经步骤。
//
// 用法：
//   node scripts/backfill-sys-derive-root-seq.js                 # dry-run（默认·只报告不写）
//   node scripts/backfill-sys-derive-root-seq.js --apply         # 真写（自动先做一致性备份）
//   node scripts/backfill-sys-derive-root-seq.js --db <path> [--apply]
//
// 安全设计（同 backfill-sys-deadlock-reopen-round.js 既有范式）：
//   · 默认 dry-run —— 不加 --apply 一个字节都不写
//   · --apply 前用 **VACUUM INTO** 生成一致性快照备份（CLAUDE.md deploy gotcha 9 同款理由：裸复制不保证
//     并发一致性，VACUUM INTO 由 SQLite 自身在读事务内完成）
//   · 目标备份文件用毫秒时间戳；VACUUM INTO 要求目标不存在，天然 fail-closed 不覆盖
//   · --apply 写入路径与迁移链 [1d] 完全一致：分类熔断即整体中止不写任何东西；首次回填在单一事务内
//     完成（BEGIN IMMEDIATE），任一步失败整体回滚；写后跑不变量探针 + 建部分唯一索引前脏数据探针
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const sysDeriveNumbering = require('../utils/sys-derive-numbering');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
function usageExit(msg) {
  console.error(`❌ ${msg}\n用法：node scripts/backfill-sys-derive-root-seq.js [--db <path>] [--apply]`);
  process.exit(1);
}
if (dbIdx >= 0 && (!args[dbIdx + 1] || args[dbIdx + 1].startsWith('--'))) usageExit('--db 缺少路径参数（或误把开关当成了路径）');
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : path.join(__dirname, '..', 'task_pool.db');

if (!fs.existsSync(DB_PATH)) { console.error(`db 不存在：${DB_PATH}`); process.exit(1); }

const db = new sqlite3.Database(DB_PATH);
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// 唯一权威标准 WHERE 子句文本——CREATE 语句模板与下方 checkDeriveIndexState 的判定基准共用同一常量，
// 从源头杜绝"脚本里两处各写一份 WHERE 文本"而漂移（[预筛 403] 落字）。与 routes/sys-iteration/index.js
// 迁移链 [1d] 的 DDL 逐字对拍过（大小写/措辞完全一致，仅缩进空白不同——规范化后无差异），两处 WHERE
// 文本本就同源；若未来其中一处改了写法，应改本脚本这个常量去对齐迁移链，而不是反过来动迁移链。
const DERIVE_INDEX_WHERE_CLAUSE = 'derive_root_id IS NOT NULL AND derive_seq IS NOT NULL';
const DERIVE_INDEX_CREATE_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_issues_derive_root_seq\n` +
  `   ON sys_issues(derive_root_id, derive_seq)\n` +
  `   WHERE ${DERIVE_INDEX_WHERE_CLAUSE}`;
function normalizeSqlFragment(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── 部分唯一索引四态核验（[预筛 400-H1]，[预筛 401 修正] 判定依据改结构化元数据，
//   [预筛 402] 升级四态覆盖"同名且 UNIQUE 但结构不符目标定义"，
//   [预筛 403 终态] WHERE 项弃语义判断改规范化全等）─────────────────────────────────────────────
//   抽成 helper，供 dry-run 展示 / --apply 建索引前置闸 / --apply 建索引后二次核验共用（本文件零候选
//   分支与"有候选待写"主分支各有一份索引创建逻辑，共四处调用同一份判定口径，防各写一份漂移）。
//   四态：
//     'missing'    —— 索引不存在
//     'ok'         —— 索引存在、UNIQUE、且结构完全匹配目标定义（健康态，见下方三项核对）
//     'non_unique' —— 索引同名存在但不是 UNIQUE
//     'mismatched' —— 索引同名存在且 UNIQUE，但**结构不符**目标定义（列组错/错序、非部分索引、WHERE
//        非标准形……）——`CREATE UNIQUE INDEX IF NOT EXISTS` 对同名索引（不论其内部结构对不对）一律
//        静默 no-op，只看"存在 + UNIQUE"两件事就报健康会漏掉这一整类：目标要求的部分唯一约束实际上
//        没有生效，一个真实重复的 (derive_root_id,derive_seq) 组合完全可能插得进去。
//   'ok' 判定的三项结构核对（unique===1 之后才继续核，此后无更深自由度——终态）：
//     ① PRAGMA index_info 的 key 列精确有序 = [derive_root_id, derive_seq]（恰两列、顺序敏感）
//     ② PRAGMA index_list 该行 partial===1（确认是部分索引，非全表唯一索引）
//     ③ WHERE 子句**规范化全等**于 DERIVE_INDEX_WHERE_CLAUSE 标准形（大小写统一 + 连续空白折一格 +
//        首尾 trim 后逐字相等，**不去括号**、不做任何语义化简）——不逐字相等即判 mismatched。
//   三项全过 ⇒ 'ok'；任一不过 ⇒ 'mismatched'（连同具体哪几项没过一起返回，供错误文案精确指出问题）。
//   ⚠️ [401 教训一句带过] 判定依据必须是 PRAGMA 结构化元数据（index_list/index_info），不能是
//     sqlite_master.sql 文本正则——文本正则会被表达式/WHERE 里凑巧出现的字符串字面量骗过。
//   ⚠️ [403 教训] ③ 项最初写成"文本含两个 IS NOT NULL 子串"，这是在**猜语义**——子串检查挡不住
//     `WHERE derive_root_id IS NOT NULL AND derive_seq IS NOT NULL AND 0`（两子串都在，但恒真变
//     恒假、索引实际永远为空）这类反例，语义等价的改写（如 `NOT (derive_root_id IS NULL)`、多余括号、
//     条件换序）同样能绕过子串检查而实际改变了索引的筛选范围。本判定的立场是**只认标准形，不猜语义**：
//     WHERE 子句与标准形逐字不等，一律 fail-closed 判 mismatched——哪怕新写法在语义上被人工验证等价，
//     也不认（"等价"的判断本身容易出错，且下一个人未必会重新验证）；出人工指引让人确认后手动改成标准
//     写法或经代码评审调整常量，是这里唯一被认可的"正确行为"，而不是让程序去猜"这写法算不算数"。
async function checkDeriveIndexState() {
  const rows = await all(`PRAGMA index_list('sys_issues')`);
  // unique/partial 列在不同 sqlite3 驱动/版本下可能回报数字 1/0 或字符串 '1'/'0'，Number() 统一归一后比较。
  const row = (rows || []).find((r) => r.name === 'idx_sys_issues_derive_root_seq');
  if (!row) return { state: 'missing' };
  if (Number(row.unique) !== 1) return { state: 'non_unique' };

  const problems = [];
  const infoRows = await all(`PRAGMA index_info('idx_sys_issues_derive_root_seq')`);
  const cols = (infoRows || []).slice().sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
  if (!(cols.length === 2 && cols[0] === 'derive_root_id' && cols[1] === 'derive_seq')) {
    problems.push(`列组不符（期望恰两列且顺序为 derive_root_id,derive_seq，实得 [${cols.join(',')}]）`);
  }
  if (Number(row.partial) !== 1) {
    problems.push('非部分索引（缺少 WHERE 限定条件）');
  } else {
    const sqlRow = await get(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`);
    const sqlText = (sqlRow && sqlRow.sql) || '';
    // 提取首个 WHERE 关键字之后到串尾的原文——SQLite 的 CREATE INDEX 语法里 WHERE 只能出现在末尾
    // （分区索引谓词），故"首个 WHERE 到串尾"即完整、唯一的 WHERE 子句，不存在截断风险。
    const whereMatch = /\bWHERE\b([\s\S]*)$/i.exec(sqlText);
    const actualWhere = whereMatch ? whereMatch[1] : '';
    if (normalizeSqlFragment(actualWhere) !== normalizeSqlFragment(DERIVE_INDEX_WHERE_CLAUSE)) {
      problems.push(`WHERE 非标准形（期望「${DERIVE_INDEX_WHERE_CLAUSE}」，实际「${actualWhere.trim()}」——语义等价的改写也一律拒收，只认标准形不猜语义）`);
    }
  }

  return problems.length > 0 ? { state: 'mismatched', problems } : { state: 'ok' };
}
// 'non_unique'/'mismatched' 两个不健康态的统一人工修复指引——两态共用尾段（DROP INDEX + 不自动 DROP
// 的理由），前段按具体状态区分说明，dry-run 与 --apply 各处判到不健康态时调用同一份文案生成函数。
// ⚠️ --apply 不自动 DROP：那是破坏性动作（丢弃既有索引定义，若其间已有并发写入依赖过它的顺序特性等
//   隐性假设，自动 DROP 有把问题静默复杂化的风险），留给人工核实后手动执行，与本模块"异常不自动猜测
//   修复"的一贯熔断哲学一致（同 classifySysDeriveNumbering 各类违例"出清单不自动修"同一立场）。
function describeIndexProblem(check) {
  const tail = 'CREATE UNIQUE INDEX IF NOT EXISTS 对同名索引会静默 no-op，不会自动纠正其定义。需人工核实' +
    '后执行 DROP INDEX idx_sys_issues_derive_root_seq 再重跑本脚本（本脚本不会自动 DROP：那是破坏性动作，' +
    '留给人工核实过再做）。';
  if (check.state === 'non_unique') {
    return `❌ 部分唯一索引 idx_sys_issues_derive_root_seq 已存在但不是 UNIQUE（结构异常）——${tail}`;
  }
  if (check.state === 'mismatched') {
    return `❌ 部分唯一索引 idx_sys_issues_derive_root_seq 同名且 UNIQUE，但结构不符目标定义（${check.problems.join('；')}）——${tail}`;
  }
  return '';
}
function isIndexUnhealthy(check) {
  return check.state === 'non_unique' || check.state === 'mismatched';
}

(async () => {
  console.log(`db      : ${DB_PATH}`);
  console.log(`模式    : ${APPLY ? '⚠️  APPLY（真写）' : 'dry-run（只报告）'}`);
  console.log('');
  await run('PRAGMA busy_timeout = 10000');

  // 前置：三列 + 部分唯一索引是否存在（旧库未先跑过 alterAddMissingCols 时给可读提示，不裸抛 SQLITE_ERROR）
  const cols = (await all(`PRAGMA table_info(sys_issues)`)).map((c) => c.name);
  const missingCols = ['derive_root_id', 'derive_seq', 'derive_seq_alloc'].filter((c) => !cols.includes(c));
  if (missingCols.length > 0) {
    console.error(`❌ sys_issues 缺列：${missingCols.join(',')}——请先启动一次服务（迁移链 [1a] 会自动补列）或手动跑 alterAddMissingCols 等效 ALTER，再重跑本脚本。`);
    db.close(); process.exit(1);
  }

  // ── 1. 只读分类扫描 ─────────────────────────────────────────────────────────
  const classified = await sysDeriveNumbering.classifySysDeriveNumbering(all, get);
  console.log(`全表 sys_issues 行数：${classified.rows.length}`);
  console.log(`待首次回填候选：${classified.toBackfill.length} 单`);
  console.log(`已回填稳态：${classified.alreadyFilled.length} 单`);
  if (classified.hasViolations) {
    console.log('\n❌ 检测到熔断违例（不自动猜测修复，需人工核实）：');
    console.log('   ' + sysDeriveNumbering.formatViolationSummary(classified.violations));
    console.log('\n（未做任何写入。人工核实清单里的单据后重跑本脚本。）');
    db.close(); process.exit(1);
  }
  console.log('\n✅ 分类扫描无违例。');

  if (classified.toBackfill.length === 0) {
    console.log('无待回填候选，无需处理。');
    // 仍跑一次不变量探针 + 重复组探针作为健康检查（不涉及数据写入，dry-run/apply 均可跑）。
    // [预筛 H1①] 此前这里探针违例只 console.log ⚠️ 后仍 db.close()+return（exit 0），与"有候选待写"
    // 分支（探针失败会 process.exit(1)）不是同一诚实标准：部署门禁按退出码判"脚本跑过就是健康"，会把
    // 带真实数据问题的库误判成功。零候选与非零候选必须承受同一标准——发现问题就不能装作什么都没有。
    const allocViolations = await sysDeriveNumbering.findAllocInvariantViolations(all);
    const dupGroups = await sysDeriveNumbering.findDuplicateSeqGroups(all);
    if (allocViolations.length > 0 || dupGroups.length > 0) {
      if (allocViolations.length > 0) {
        console.error(`❌ alloc 不变量违例：${allocViolations.map((v) => `#${v.id}(${v.reason})`).join('；')}`);
      }
      if (dupGroups.length > 0) {
        console.error(`❌ 重复 (root,seq) 组：${dupGroups.length} 组（${dupGroups.map((g) => `root=${g.derive_root_id} seq=${g.derive_seq} ids=${g.ids.map((i) => `#${i}`).join(',')}`).join('; ')}）`);
      }
      console.error('   数据存在结构性问题，需人工核实（零候选分支与"有候选待写"分支同一诚实标准，不会因"本次无字节可写"而放行）。');
      db.close(); process.exit(1);
    }
    console.log('✅ alloc 不变量 + 重复组探针均通过。');

    // [预筛 H1②③ + 400-H1 + 402 终态] 索引四态核验——此前零候选分支既不检查也不建索引，与脚本头部
    // 注释"--apply 才真写……不变量探针 + 建部分唯一索引，与迁移链 [1d] 逐字同源"的声明脱节：若某库因
    // 历史原因（迁移链本身尚未跑过一次、或索引被手工 DROP/错误重建）缺这个索引或索引结构不对，本脚本
    // 在零候选场景下会悄悄放过，永远不提醒也不补建。dry-run 与 --apply 均按 non_unique/mismatched 两个
    // 不健康态 fail-closed。
    const idxCheck = await checkDeriveIndexState();
    if (isIndexUnhealthy(idxCheck)) {
      console.error(describeIndexProblem(idxCheck));
      db.close(); process.exit(1);
    }
    if (!APPLY) {
      console.log(idxCheck.state === 'ok'
        ? '✅ 部分唯一索引 idx_sys_issues_derive_root_seq 已就位。'
        : '⚠️ 部分唯一索引 idx_sys_issues_derive_root_seq 缺失——加 --apply 将补建。');
      db.close(); return;
    }
    // --apply（含零候选）：探针全过，补建索引——与迁移链 [1d] 同一条 DDL、同幂等语义（CREATE UNIQUE
    // INDEX IF NOT EXISTS，已存在则 no-op）。零候选场景没有任何数据行被改动，只有这一条 DDL，不需要
    // 走 VACUUM INTO 备份（备份是为保护"可能被写坏的数据"，这里没有数据变更面）。
    await run(DERIVE_INDEX_CREATE_SQL);
    // [400-H1③] 建后二次核验——同一 helper，不只信"CREATE 语句没报错"就打印成功（CREATE UNIQUE INDEX
    // IF NOT EXISTS 对同名索引静默 no-op 时不会抛错，若不重新查一次真实状态，这里会对着一个没有变成
    // 目标定义的旧索引打印"已补建"）。必须落在 'ok' 才算数——non_unique/mismatched 均视为失败。
    const idxCheckAfter = await checkDeriveIndexState();
    if (idxCheckAfter.state !== 'ok') {
      const detail = idxCheckAfter.problems ? `（${idxCheckAfter.problems.join('；')}）` : '';
      console.error(`❌ 建索引后二次核验失败：CREATE 执行后实测状态=${idxCheckAfter.state}${detail}（期望 ok）——索引未能就位为目标定义，需人工核实（本次零候选，未写入任何数据行，只是索引没建成）。`);
      db.close(); process.exit(1);
    }
    console.log(idxCheck.state === 'ok' ? '✅ 部分唯一索引已就位（原已存在）。' : '✅ 部分唯一索引已补建（建后二次核验确认结构完全匹配）。');
    db.close(); return;
  }

  // 分族预览（族 = root）
  const byRoot = new Map();
  for (const item of classified.toBackfill) {
    if (!byRoot.has(item.root)) byRoot.set(item.root, []);
    byRoot.get(item.root).push(item);
  }
  console.log(`\n待回填涉及 ${byRoot.size} 个族：`);
  for (const [root, items] of byRoot) {
    console.log(`  #${root} 族：${items.length} 单待赋号（${items.map((i) => `#${i.id}`).join(',')}）`);
  }

  const existingAllocRows = await all(`SELECT id, derive_seq_alloc FROM sys_issues WHERE derive_seq_alloc IS NOT NULL`);
  const existingAllocByRoot = new Map(existingAllocRows.map((r) => [Number(r.id), r.derive_seq_alloc]));
  const { assignments, allocByRoot } = sysDeriveNumbering.planFirstBackfillAssignments(
    classified.toBackfill, classified.alreadyFilled, existingAllocByRoot);

  console.log('\n拟赋号方案（dry-run 预览 / apply 将写入的值）：');
  for (const a of assignments) console.log(`  #${a.id} → derive_root_id=${a.root}, derive_seq=${a.seq}`);
  for (const [root, alloc] of allocByRoot) console.log(`  根单 #${root} → derive_seq_alloc=${alloc}`);

  if (!APPLY) {
    // [400-H1 + 402 终态] 同一 helper——本分支（有候选待写）的 dry-run 此前从不检查索引状态，与零候选
    // 分支不对称；"既有库历史上存在同名但非 UNIQUE/结构不符的索引"这个结构异常与"是否恰好有待回填候选"
    // 无关，两分支都可能撞上，理应同一标准 fail-closed。
    const idxCheckDry = await checkDeriveIndexState();
    if (isIndexUnhealthy(idxCheckDry)) {
      console.error(describeIndexProblem(idxCheckDry));
      db.close(); process.exit(1);
    }
    console.log(idxCheckDry.state === 'ok' ? '✅ 部分唯一索引已就位。' : '⚠️ 部分唯一索引缺失——--apply 完成回填后将一并补建。');
    console.log('\n（dry-run 结束，未写入任何数据。确认无误后加 --apply 执行。）');
    db.close(); return;
  }

  // ── 2. 一致性备份（VACUUM INTO）────────────────────────────────────────────
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
  const bak = `${DB_PATH}.bak-${stamp}`;
  if (fs.existsSync(bak)) { console.error(`❌ 备份文件已存在，中止：${bak}`); db.close(); process.exit(1); }
  try {
    await run(`VACUUM INTO ?`, [bak]);
  } catch (e) {
    let residue = '';
    if (fs.existsSync(bak)) {
      try { fs.unlinkSync(bak); residue = '（已清理残缺的目标文件）'; }
      catch (_) { residue = `（⚠️ 残缺目标文件清理失败，请手动删除后重试：${bak}）`; }
    }
    console.error(`\n❌ 备份失败，未做任何数据修改：${e.message}${residue}`);
    db.close(); process.exit(1);
  }
  console.log(`\n已备份（VACUUM INTO 一致性快照）：${bak}（${fs.statSync(bak).size} 字节）`);

  // ── 3. 单一事务内首次回填写入（与迁移链 [1d] 逐字同源）───────────────────────
  try {
    await run('BEGIN IMMEDIATE');
    await sysDeriveNumbering.applyFirstBackfillAssignments(run, assignments, allocByRoot);
    await run('COMMIT');
    console.log(`\n✅ 首次回填完成：${assignments.length} 单赋号（${allocByRoot.size} 族）。`);
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) { /* best-effort */ }
    console.error(`\n❌ 写入失败已回滚：${e.message}`);
    console.error(`   数据未改变；备份在 ${bak}`);
    db.close(); process.exit(1);
  }

  // ── 4. 写后不变量探针 + 建部分唯一索引 ────────────────────────────────────
  const allocViolations = await sysDeriveNumbering.findAllocInvariantViolations(all);
  if (allocViolations.length > 0) {
    console.error(`\n❌ 写后 alloc 不变量探针失败：${allocViolations.map((v) => `#${v.id}(${v.reason})`).join('；')}`);
    console.error(`   数据已写入（未回滚——探针失败发生在提交之后）；请人工核实，备份在 ${bak}`);
    db.close(); process.exit(1);
  }
  const dupGroups = await sysDeriveNumbering.findDuplicateSeqGroups(all);
  if (dupGroups.length > 0) {
    console.error(`\n❌ 建索引前脏数据探针发现重复组：${dupGroups.length} 组（${dupGroups.map((g) => `root=${g.derive_root_id} seq=${g.derive_seq} ids=${g.ids.map((i) => `#${i}`).join(',')}`).join('; ')}）——请人工核实，备份在 ${bak}`);
    db.close(); process.exit(1);
  }
  // [400-H1② + 402 终态] 建索引前置闸——同一 helper：数据回填已在上面提交（此步失败不回滚数据，同
  // alloc/dup 两条既有探针失败时的既定说法一致，只是索引没建成，非数据出问题）。
  const idxCheckMain = await checkDeriveIndexState();
  if (isIndexUnhealthy(idxCheckMain)) {
    console.error(describeIndexProblem(idxCheckMain));
    console.error(`   数据已写入（回填本身已提交，不受索引态影响）；备份在 ${bak}。`);
    db.close(); process.exit(1);
  }
  await run(DERIVE_INDEX_CREATE_SQL);
  // [400-H1③] 建后二次核验——同一 helper，理由同零候选分支：CREATE UNIQUE INDEX IF NOT EXISTS 对同名
  // 索引静默 no-op 不报错，不重新查真实状态就打印成功会把"没建成"误报成"已就位"。必须落在 'ok'。
  const idxCheckMainAfter = await checkDeriveIndexState();
  if (idxCheckMainAfter.state !== 'ok') {
    const detail = idxCheckMainAfter.problems ? `（${idxCheckMainAfter.problems.join('；')}）` : '';
    console.error(`❌ 建索引后二次核验失败：CREATE 执行后实测状态=${idxCheckMainAfter.state}${detail}（期望 ok）——数据已写入（备份在 ${bak}），但索引未能就位为目标定义，需人工核实。`);
    db.close(); process.exit(1);
  }
  console.log('✅ 不变量探针通过 + 部分唯一索引已就位（建后二次核验确认结构完全匹配）。');
  db.close();
})().catch((e) => { console.error('异常：', e.message); db.close(); process.exit(1); });
