// scripts/sys-multidev-c0-reset.js — C0 一次性数据重置（Mz-4 固定序）
//   SSOT = 方案 v2.9 §9.2「一次性数据重置（Mz-4 固定序）」+ 开发计划 v2.9 §3.1「两步执行」
//   用法（生产，server 建议先停）：
//     node scripts/sys-multidev-c0-reset.js --issue-ids=1,2,3 --expect-issues=3
//   可选 --db=<path>：覆盖数据库文件路径（**仅供 verify 脚本/测试用**，生产运行不传，默认走真实 task_pool.db；
//     生产运维人为传 --db 指向非生产文件是误用，本脚本不做二次拦截——沿用项目一贯"运维人对生产路径负责"惯例）。
//
// ⚠️ 场景事实（方案 §0）：生产仅 1 条测试数据（可破坏，未推开使用）——本脚本是"推开使用前"的一次性清洗，
//   非常规运维工具，**执行前务必确认 --issue-ids/--expect-issues 与生产真实状态吻合**（脚本做两层断言：
//   ① --expect-issues 与库内 sys_issues 总行数一致；② --issue-ids 去重后必须与库内 sys_issues 实际 id
//   全集完全相等——防"总数凑巧吻合但清单本身打错/漏项"打空重置却写下永久标记，86 号审 H1 收口）。
//
// Mz-4 固定序（方案 §9.2 逐字照办，不可增删步骤/挪动顺序）：
//   备份 db → BEGIN IMMEDIATE → 事务内断言标记不存在 → 范围+行数断言 → 重置+选举 → 事务内跑探针 P1-P15
//   → 插入唯一标记 → COMMIT → 肉眼核对（提交后）。任一失败 → 整体 ROLLBACK（标记随之回滚，可修复后重跑）。
//
// ⚠️ HIGH（95 号复审 2026-07-17 引入·96 号复审扩展）：「重置+选举」步骤按主状态族区分回填——不能对全部
//   issue 一律置 pending。背景：P15（主状态∈SYS_RELEASE ⇒ 在册≥1∧无 pending）/ P14（主状态∈SYS_VERIFY ⇒
//   在册≥1∧无 pending）与「全部覆盖为 pending」若同时存在会死循环——RELEASE 族（待上线/已上线）与 VERIFY 族
//   （待验证）单每次重跑都被覆盖成 pending，探针每次都拒绝，reset 永远无法收敛（不是可接受的 fail-closed，是
//   无法逃逸的循环；96 号复审：VERIFY 族与 95 号已修的 RELEASE 族完全同构，此前只种了 DEV+RELEASE 集成反例
//   没种 VERIFY 才没暴露）。改为：**RELEASE 族与 VERIFY 族**（合称"完成态族"）的 roster 行不置 pending，回填
//   为方案 §3 四态配对不变量里「规格自带」的 no_code 形态（resolved_at 非空 + no_code_reason 非空 trim1..500
//   + commit 行=0）——选 no_code 而非 code_submitted 的理由：sys_issue_dev_commits 是本次 C0 才新建的表，
//   历史单不存在逐人 commit 留痕，无法伪造 commit 行；选 no_code 而非 excused 的理由：excused 语义="被协调人
//   开脱"，与"单已进入发布控制态/待验证、显然已完成开发"的历史事实相悖，no_code 配合迁移专用理由文案更贴近
//   "占位完成态回填、非真实业务判断"的实际语义。RELEASE 族与 VERIFY 族的迁移文案分开措辞（语义不同：前者=
//   "已发布/待发布"，后者="开发已完成、等待验收"），供人工核对时能区分回填依据。**D_PRE/DEV 两族不受影响**，
//   仍置 pending（DEV 族 pending 属在册，满足 P12「在册≥1」；D_PRE 族无探针约束）。零在册（active_count=0，
//   通常因 sys_issues.assigned_to 为 NULL、roster 从未真正形成）的完成态族单无法回填（reset 不能虚构开发者）
//   ——覆盖动作前先 pre-check（RELEASE+VERIFY 一并检查），命中则 fail-fast 列出 issue id（含所属族名），要求
//   人工先补 sys_issues.assigned_to/对应在册行（该修复不会被本次重置覆盖，故可收敛）后再重跑。
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { runProbes } = require('./lib/sys-multidev-probes');
const { isInFamily } = require('../routes/sys-iteration/status-families');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'task_pool.db');   // 生产真实路径（wbs-server/task_pool.db，同 server.js:25 DB_FILE）
const RESET_MARKER_KEY = 'multidev_c0_reset_applied';
// HIGH（95 号复审）：RELEASE 族单迁移回填的 no_code_reason 固定文案（trim 长度需在 1..500 内，方案 §3 P4 配对）——
//   与真实业务 no_code 理由区分，明确标注这是 C0 一次性重置的历史数据迁移占位，不代表该行为真的"无代码提交"。
const RELEASE_MIGRATION_NO_CODE_REASON =
  '系统迭代多开发协作 C0 一次性重置迁移：该单在本次改造前已进入发布控制态（待上线/已上线），历史阶段无逐人 ' +
  'commit 留痕记录（sys_issue_dev_commits 为本次改造新建表，无法回填真实 commit 行），故回填为「no_code」仅作' +
  '完成态占位，不代表真实无代码提交；实际交付事实以历史 timeline/发布记录为准。';
// HIGH（96 号复审）：VERIFY 族（待验证）单迁移回填的 no_code_reason 固定文案——与 RELEASE 族文案分开措辞
//   （语义="待验证单迁移回填：开发已完成、等待验收"，非"已发布/待发布"），供人工核对时区分回填依据。
const VERIFY_MIGRATION_NO_CODE_REASON =
  '系统迭代多开发协作 C0 一次性重置迁移：该单在本次改造前已进入待验证态，历史阶段无逐人 commit 留痕记录' +
  '（sys_issue_dev_commits 为本次改造新建表，无法回填真实 commit 行），故回填为「no_code」仅作完成态占位' +
  '（语义：开发已完成、等待验收，非真实无代码提交）；实际交付事实以历史 timeline 记录为准。';

// ── CLI 参数解析（--issue-ids=1,2,3 / --expect-issues=N / --db=path 可选）──────────
function parseArgs(argv) {
  const out = { issueIds: null, expectIssues: null, dbPath: DEFAULT_DB_PATH };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'issue-ids') {
      out.issueIds = val.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    } else if (key === 'expect-issues') {
      out.expectIssues = Number(val);
    } else if (key === 'db') {
      out.dbPath = val;
    }
  }
  return out;
}

function printUsage() {
  console.log('用法：node scripts/sys-multidev-c0-reset.js --issue-ids=1,2,3 --expect-issues=N [--db=path]');
  console.log('  --issue-ids     必填，限定本次重置的 sys_issues.id 清单（逗号分隔）');
  console.log('  --expect-issues 必填，预期 sys_issues 总行数（与库内实际不符则中止，不做任何写操作）');
  console.log('  --db            可选，覆盖数据库文件路径（仅供测试；生产运行不传，默认 task_pool.db）');
}

// ── db helper（原生 sqlite3.Database 的 Promise 化）──────────
function makeHelpers(db) {
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })),
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))),
    get: (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))),
  };
}

function nowLocalTimestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
}

// M4（86 号审）：毫秒级时间戳——秒级在"同秒内二次执行"（如脚本重试/verify 连续两次调用）时会撞同名，
//   copyFileSync 默认覆盖会让真正的重要恢复点被无声顶掉。
function backupTimestampSuffix() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

// 备份 db 文件到同目录 <base>.backup_<timestamp><ext>，打印路径，返回备份路径。
//   M4（86 号审）：即便毫秒级时间戳仍有极小概率撞名（同毫秒内两次调用）——用 COPYFILE_EXCL 使"目标已存在"
//   显式失败（而非静默覆盖），EEXIST 时补一次短随机后缀重试；仍失败则原样抛出（不第三次重试，避免死循环）。
function backupDbFile(dbPath) {
  const dir = path.dirname(dbPath);
  const ext = path.extname(dbPath);
  const base = path.basename(dbPath, ext);
  const buildPath = (suffix) => path.join(dir, `${base}.backup_${backupTimestampSuffix()}${suffix}${ext}`);
  let backupPath = buildPath('');
  try {
    fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      backupPath = buildPath(`_${Math.random().toString(36).slice(2, 6)}`);
      fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    } else {
      throw e;
    }
  }
  console.log(`[备份] ${dbPath} → ${backupPath}`);
  return backupPath;
}

// 代表选举（方案 §3.6，一次性脚本内联版）——C2 将建服务层 electRepresentative 为权威，本处仅本脚本自用：
//   ① 现任（sys_issues.assigned_to）仍在册（该 issue 下 removed_at IS NULL 的行）→ 保留，仅刷新 is_primary/assigned_to_name；
//   ② 在册 pending 最小 user_id → 当选；
//   ③ 全在册最小 user_id → 当选；
//   ④ 零在册 → assigned_to=NULL/assigned_to_name=NULL，is_primary 全 0（在册本就 0 条，天然满足）。
async function electRepresentativeInline(H, issueId) {
  const issue = await H.get(`SELECT assigned_to FROM sys_issues WHERE id = ?`, [issueId]);
  const activeRows = await H.all(
    `SELECT id, user_id, user_name, dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY user_id ASC`,
    [issueId]
  );

  let winner = null;
  if (issue && issue.assigned_to !== null && issue.assigned_to !== undefined) {
    winner = activeRows.find(r => Number(r.user_id) === Number(issue.assigned_to)) || null;   // ① 现任仍在册
  }
  if (!winner) {
    winner = activeRows.find(r => r.dev_status === 'pending') || null;   // ② 在册 pending 最小 user_id（activeRows 已按 user_id ASC 排序）
  }
  if (!winner && activeRows.length > 0) {
    winner = activeRows[0];   // ③ 全在册最小 user_id
  }

  // M1（86 号审）：两条 UPDATE 不再带 `AND removed_at IS NULL`——覆盖该 issue **全部** assignee 行（在册+软删）。
  //   候选人挑选（winner 计算）仍只看 activeRows（在册），这里只是把 is_primary 清零/置位的**写范围**扩到全表，
  //   防止软删旧 primary 行残留 is_primary=1（双 primary 数据，P6/P9 之外没有探针直接堵这个，故在选举本身堵死）。
  if (winner) {
    await H.run(`UPDATE sys_issue_dev_assignees SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE issue_id = ?`, [winner.id, issueId]);
    await H.run(`UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ? WHERE id = ?`, [winner.user_id, winner.user_name, issueId]);
  } else {
    // ④ 零在册（activeRows 为空）——全表（含软删历史行）is_primary 清零，防历史残留脏 is_primary=1。
    await H.run(`UPDATE sys_issue_dev_assignees SET is_primary = 0 WHERE issue_id = ?`, [issueId]);
    await H.run(`UPDATE sys_issues SET assigned_to = NULL, assigned_to_name = NULL WHERE id = ?`, [issueId]);
  }
}

// runReset：核心逻辑，供 CLI 与 verify 脚本共用。返回 { ok, reason?, failedProbes?, backupPath?, markerAlready? }。
//   不 process.exit——退出码/打印交给调用方（CLI 入口 main() 或 verify 脚本自行断言）。
async function runReset({ dbPath, issueIds: rawIssueIds, expectIssues }) {
  if (!Array.isArray(rawIssueIds) || rawIssueIds.length === 0 || !rawIssueIds.every(n => Number.isInteger(n) && n > 0)) {
    return { ok: false, reason: 'INVALID_ARGS', message: '--issue-ids 非法（须为正整数逗号列表）' };
  }
  if (!Number.isInteger(expectIssues) || expectIssues < 0) {
    return { ok: false, reason: 'INVALID_ARGS', message: '--expect-issues 非法（须为非负整数）' };
  }
  // H1（86 号审）：去重+排序，供下方与库内实际 id 集合做完全相等比较（IN 子句沿用去重后的清单）。
  const issueIds = [...new Set(rawIssueIds)].sort((a, b) => a - b);

  // Mz-4 步骤1：备份 db 文件（无条件先备份——即便后续因"已执行过"回滚，备份动作本身按固定序不提前判断跳过）。
  const backupPath = backupDbFile(dbPath);

  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  const closeDb = () => new Promise((resolve) => db.close(() => resolve()));

  try {
    // 防御性建表（DDL，事务外）：validation_config 由 server.js 启动时创建（本脚本独立连接、不经 server.js
    //   bootstrap），生产 task_pool.db 早已存在该表（server 每次启动都建，IF NOT EXISTS no-op）；此处补一份
    //   同构 CREATE TABLE IF NOT EXISTS（列定义逐字对齐 server.js:1102 config_key TEXT UNIQUE NOT NULL），
    //   使本脚本在"尚未跑过 server.js 的裸库"（如本文件的独立 verify 场景）上也能自洽运行。
    await H.run(`CREATE TABLE IF NOT EXISTS validation_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT NOT NULL,
        description TEXT,
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`);

    await H.run('BEGIN IMMEDIATE');

    // Mz-4 步骤2：事务内断言标记不存在
    const marker = await H.get(`SELECT config_key FROM validation_config WHERE config_key = ?`, [RESET_MARKER_KEY]);
    if (marker) {
      await H.run('ROLLBACK');
      await closeDb();
      return { ok: false, reason: 'ALREADY_APPLIED', message: 'C0 一次性重置已执行过（validation_config 标记存在），本次不再执行', backupPath };
    }

    // Mz-4 步骤3：范围+预期行数断言
    const totalRow = await H.get(`SELECT COUNT(*) c FROM sys_issues`);
    if (totalRow.c !== expectIssues) {
      await H.run('ROLLBACK');
      await closeDb();
      return { ok: false, reason: 'EXPECT_ISSUES_MISMATCH', message: `sys_issues 总行数 ${totalRow.c} 与 --expect-issues=${expectIssues} 不符，已中止`, backupPath };
    }

    // H1（86 号审）：仅校验"总行数吻合"不够——--issue-ids 清单可能包含库内不存在的 id（如打错单号），
    //   此时总数仍可能凑巧吻合（如 --issue-ids=999 --expect-issues=1，库内恰好只有 1 条但 id 是别的），
    //   导致"重置范围其实是空集"却仍写下永久标记。改为：去重后的 --issue-ids 清单必须与库内 sys_issues
    //   实际 id 全集**完全相等**（不是子集/超集，是相等——本脚本设计前提=清单覆盖库内全部数据，§0 场景
    //   事实"生产仅 1 条测试数据"，C0 重置本就该覆盖全部）。
    const actualIdRows = await H.all(`SELECT id, type, status FROM sys_issues ORDER BY id`);
    const actualIds = actualIdRows.map(r => r.id);
    const idsMatch = issueIds.length === actualIds.length && issueIds.every((v, i) => v === actualIds[i]);
    if (!idsMatch) {
      await H.run('ROLLBACK');
      await closeDb();
      return {
        ok: false, reason: 'ISSUE_IDS_MISMATCH',
        message: `--issue-ids（去重排序后 [${issueIds.join(',')}]）与库内 sys_issues 实际 id 全集（[${actualIds.join(',')}]）不完全相等，已中止`,
        backupPath,
      };
    }

    // HIGH（95 号复审引入·96 号复审扩展）：按主状态族分类——RELEASE 族（待上线/已上线）+ VERIFY 族（待验证）
    //   合称"完成态族"，均不能置 pending（会被各自的 P15/P14 永久拒绝、reset 无法收敛，理由同构），需单独回填；
    //   其余族（D_PRE/DEV/非发布终态）沿用原「全部置 pending」逻辑（D_PRE 无探针约束；DEV 族 pending 本身
    //   即在册，满足 P12「在册≥1」，两者与本次改动无冲突）。
    const releaseIssueRows = actualIdRows.filter(r => isInFamily(r.type, r.status, 'RELEASE'));
    const verifyIssueRows = actualIdRows.filter(r => isInFamily(r.type, r.status, 'VERIFY'));
    const releaseIssueIdSet = new Set(releaseIssueRows.map(r => r.id));
    const verifyIssueIdSet = new Set(verifyIssueRows.map(r => r.id));

    // Pre-check（HIGH·95 号引入·96 号扩展覆盖 VERIFY 族）：完成态族单若当前零在册（无 removed_at IS NULL 的
    //   dev_assignees 行，典型成因=sys_issues.assigned_to 为 NULL、roster 从未真正形成），reset 无法凭空回填
    //   出一个开发者——必须在覆盖动作**之前** fail-fast，列出 issue id（含所属族名，便于人工定位），要求人工
    //   先补齐（该修复落在 sys_issues/sys_issue_dev_assignees，不在本脚本的重置字段清单内，不会被下面的
    //   UPDATE 覆盖，故人工修复后重跑可收敛）。RELEASE+VERIFY 一并检查，同一次 fail-fast 报告两族全部违规项
    //   （不分两轮各自 fail-fast——避免"修完 RELEASE 那批重跑又被 VERIFY 那批拦一次"的来回折腾）。
    const completionFamilyGroups = [
      { name: 'RELEASE（待上线/已上线）', rows: releaseIssueRows },
      { name: 'VERIFY（待验证）', rows: verifyIssueRows },
    ];
    const zeroRosterEntries = [];   // [{ id, familyName }, ...]
    for (const group of completionFamilyGroups) {
      if (group.rows.length === 0) continue;
      const ids = group.rows.map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      const activeCountRows = await H.all(
        `SELECT issue_id, COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id IN (${ph}) AND removed_at IS NULL GROUP BY issue_id`,
        ids
      );
      const activeCountByIssue = new Map(activeCountRows.map(r => [r.issue_id, r.c]));
      for (const id of ids) {
        if (!activeCountByIssue.get(id)) zeroRosterEntries.push({ id, familyName: group.name });
      }
    }
    if (zeroRosterEntries.length > 0) {
      await H.run('ROLLBACK');
      await closeDb();
      return {
        ok: false, reason: 'COMPLETION_FAMILY_ZERO_ROSTER',
        message: `以下完成态族（RELEASE=待上线/已上线，VERIFY=待验证）单当前零在册（无 removed_at IS NULL 的 ` +
          `dev_assignees 行），reset 无法虚构开发者回填完成态——需先人工核实并补齐 sys_issues.assigned_to 及 ` +
          `对应在册 dev_assignees 行（该修复不受本次重置覆盖，可收敛）后再重跑：` +
          zeroRosterEntries.map(e => `${e.id}(${e.familyName})`).join(', '),
        zeroRosterIssueIds: zeroRosterEntries.map(e => e.id),
        backupPath,
      };
    }

    // Mz-4 步骤4：分族回填。
    //   ① D_PRE/DEV 两族：原逻辑不变——置 pending / 清 resolved_at/no_code_reason/superseded_by（清单内全部
    //      dev_assignees 行，不区分在册/软删——C0 重置是"推开使用前"的全量清洗，removed_at 本身不在重置字段
    //      清单内，保持不动）。
    //   ② RELEASE 族 / ③ VERIFY 族：各自回填为 no_code（规格自带形态，理由见文件头注释），使用各自专属
    //      迁移文案（RELEASE_MIGRATION_NO_CODE_REASON / VERIFY_MIGRATION_NO_CODE_REASON），同样覆盖全部
    //      dev_assignees 行（在册+软删），resolved_at 统一盖当前时间戳（迁移执行时点，非历史真实完成时点——
    //      生产仅 1 条测试数据的一次性场景，时点精度非本次关注点）。
    const pendingIssueIds = issueIds.filter(id => !releaseIssueIdSet.has(id) && !verifyIssueIdSet.has(id));
    const releaseIssueIds = issueIds.filter(id => releaseIssueIdSet.has(id));
    const verifyIssueIds = issueIds.filter(id => verifyIssueIdSet.has(id));

    if (pendingIssueIds.length > 0) {
      const ph = pendingIssueIds.map(() => '?').join(',');
      await H.run(
        `UPDATE sys_issue_dev_assignees SET dev_status = 'pending', resolved_at = NULL, no_code_reason = NULL, superseded_by = NULL WHERE issue_id IN (${ph})`,
        pendingIssueIds
      );
    }
    if (releaseIssueIds.length > 0) {
      const ph2 = releaseIssueIds.map(() => '?').join(',');
      await H.run(
        `UPDATE sys_issue_dev_assignees SET dev_status = 'no_code', resolved_at = datetime('now','localtime'), no_code_reason = ?, superseded_by = NULL WHERE issue_id IN (${ph2})`,
        [RELEASE_MIGRATION_NO_CODE_REASON, ...releaseIssueIds]
      );
    }
    if (verifyIssueIds.length > 0) {
      const ph3 = verifyIssueIds.map(() => '?').join(',');
      await H.run(
        `UPDATE sys_issue_dev_assignees SET dev_status = 'no_code', resolved_at = datetime('now','localtime'), no_code_reason = ?, superseded_by = NULL WHERE issue_id IN (${ph3})`,
        [VERIFY_MIGRATION_NO_CODE_REASON, ...verifyIssueIds]
      );
    }

    // Mz-4 步骤4（续）：代表选举（一次性脚本内联，逐 issue）
    for (const issueId of issueIds) {
      await electRepresentativeInline(H, issueId);
    }

    // Mz-4 步骤5：事务内跑探针 P1-P15
    const probeResults = await runProbes(db);
    const failed = probeResults.filter(r => !r.pass);
    if (failed.length > 0) {
      await H.run('ROLLBACK');
      await closeDb();
      return { ok: false, reason: 'PROBE_FAILED', message: '探针未全过，整体回滚', failedProbes: failed, backupPath };
    }

    // Mz-4 步骤6：插入唯一标记（config_key UNIQUE，冲突必失败——并发下双重保险，虽然单进程一次性脚本正常不会撞）
    await H.run(
      `INSERT INTO validation_config (config_key, config_value, description) VALUES (?, ?, ?)`,
      [RESET_MARKER_KEY, nowLocalTimestamp(), '系统迭代多开发协作 C0 一次性数据重置标记（方案 v2.9 §9.2，不可重复执行）']
    );

    await H.run('COMMIT');
    await closeDb();
    return { ok: true, backupPath, issueIds, probeResults };
  } catch (e) {
    try { await H.run('ROLLBACK'); } catch (_) { /* best-effort */ }
    await closeDb();
    return { ok: false, reason: 'EXCEPTION', message: e && e.message, backupPath };
  }
}

// ── 肉眼核对清单打印（提交后，非事务内）──────────
async function printManualCheckList(dbPath, issueIds) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  console.log('\n[请肉眼核对] 以下 issue 的开发指派子表当前状态：');
  for (const issueId of issueIds) {
    const rows = await H.all(
      `SELECT id, user_id, user_name, dev_status, is_primary, removed_at, resolved_at, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id`,
      [issueId]
    );
    // HIGH（95 号复审）：详情连带打印 type/status，便于肉眼核对 RELEASE 族单是否正确回填为 no_code（而非 pending）。
    const issue = await H.get(`SELECT type, status, assigned_to, assigned_to_name FROM sys_issues WHERE id = ?`, [issueId]);
    console.log(`  issue_id=${issueId}  type=${issue ? issue.type : '?'} status=${issue ? issue.status : '?'}  assigned_to=${issue ? issue.assigned_to : '?'}(${issue ? issue.assigned_to_name : '?'})`);
    for (const r of rows) {
      console.log(`    da#${r.id} user_id=${r.user_id}(${r.user_name}) dev_status=${r.dev_status} is_primary=${r.is_primary} removed_at=${r.removed_at || 'NULL(在册)'} resolved_at=${r.resolved_at || 'NULL'} no_code_reason=${r.no_code_reason ? '(有，' + r.no_code_reason.length + '字)' : 'NULL'}`);
    }
  }
  await new Promise((resolve) => db.close(() => resolve()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.issueIds || args.expectIssues === null) {
    printUsage();
    process.exit(1);
    return;
  }

  const result = await runReset(args);
  if (!result.ok) {
    console.error(`[失败] ${result.reason}: ${result.message}`);
    if (result.failedProbes) {
      for (const p of result.failedProbes) console.error(`  ✗ ${p.id}: ${p.detail}`);
    }
    if (result.zeroRosterIssueIds) {
      console.error(`  需人工先补齐 sys_issues.assigned_to/在册 dev_assignees 行的 issue_id：${result.zeroRosterIssueIds.join(',')}`);
    }
    if (result.backupPath) console.error(`（备份已生成，未受影响：${result.backupPath}）`);
    process.exit(1);
    return;
  }

  console.log(`[成功] C0 一次性数据重置已完成（issue_ids=${args.issueIds.join(',')}），探针 P1-P15 全过，标记已落库。`);
  await printManualCheckList(args.dbPath, args.issueIds);
}

if (require.main === module) {
  main().catch(e => { console.error('\n[异常]', e.message, e.stack); process.exit(1); });
}

module.exports = { runReset, parseArgs, electRepresentativeInline, DEFAULT_DB_PATH, RESET_MARKER_KEY, RELEASE_MIGRATION_NO_CODE_REASON, VERIFY_MIGRATION_NO_CODE_REASON };
