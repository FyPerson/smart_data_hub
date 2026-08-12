// scripts/backfill-sys-deadlock-reopen-round.js — 打回死锁单存量修复（2026-08-12 用户拍板）
//
// 做什么：把「开发态但零 pending 成员」的存量单解开——对每个完成态在册成员执行 remove + re-add，
//   与 index.js 引擎里 return/reopen 的自动重开一轮**逐字同源**：
//     ⓪ 账号资格闸：用户不存在 / status≠active / role=viewer → 跳过该成员（数据一行不动）
//     ① 旧实例软删（removed_at=now），dev_status 原样保持 code_submitted/no_code
//     ② 同一 user 插入新的 pending 在册实例
//     ③ 写 action='re-add' 事件（related_dev_assignee_id 必空=P10 双向恒真；旧实例 id 走 payload）
//     ④ 代表选举（内联等价复刻 electRepresentative）——**不可省**，见下方 [codex 344 新 HIGH]
//
// ⛔ **绝不原地把 dev_status 改回 pending**：那会打破 §1 不变量1「完成态不回 pending」(B4b)，
//   而 B4b 是 index.js:5849 分轮留痕的前提（bug_cause_records/noCodeRecords/workNoteRows 均按
//   MAX(id) per dev_assignee_id 取"该实例最近一次提交事件"）。原地重置=放开「同实例重复提交」
//   ⇒ 下一轮提交会静默覆盖上一轮的 bug 产生原因/无代码说明。
//   （限定语：在**不改动现有留痕查询与事件模型**的前提下，remove+re-add 是当前兼容路径；
//     改聚合为按轮次/全事件查询也能支持原地重置，只是那是另一个量级的改造。codex 344 LOW-1）
//
// ⛔ **不碰 excused 成员**：豁免语义不因打回被拉回开发队列（与引擎口径一致）。
// ⛔ **不碰单据主表状态/估时/计数**：只解花名册死锁 + 维护代表字段（代表是花名册的派生物，必须同步）。
//
// 背景：return/reopen 此前只清主表 dev_estimated_at、不动花名册，完成态成员留在册 ⇒ 前端 canSubmit
//   （本人 dev_status==='pending'）恒 false ⇒「标记完成」按钮消失；而 estimate 属 W06 动作不分
//   dev_status ⇒ 开发能填预计完成时间却不能提交（生产 #23 实例）。引擎侧已修，本脚本清存量。
//
// 用法：
//   node scripts/backfill-sys-deadlock-reopen-round.js                 # dry-run（默认·只报告不写）
//   node scripts/backfill-sys-deadlock-reopen-round.js --apply         # 真写（自动先做一致性备份）
//   node scripts/backfill-sys-deadlock-reopen-round.js --db <path> [--apply]
//   node scripts/backfill-sys-deadlock-reopen-round.js --issue 23 [--apply]   # 只处理指定单
//
// 安全设计（会改真实数据，按"最坏情况"写）：
//   · 默认 dry-run —— 不加 --apply 一个字节都不写
//   · --apply 前用 **VACUUM INTO** 生成备份：这是 SQLite 的一致性快照机制，与本仓既有实践一致
//     （CLAUDE.md deploy gotcha 9："服务端用 VACUUM INTO 生成一致性快照再 scp，别裸 copy 活库"）。
//     [codex 344 MED-1 收口] 初版用 fs.readFileSync 热复制并以"非 WAL"为由声称一致——**该理由不成立**：
//     journal_mode=delete 只说明没有 -wal 旁文件，不代表复制期间在线服务不会并发提交，裸复制照样
//     可能拿到中间态。VACUUM INTO 由 SQLite 自己在读事务内完成，不依赖日志模式。
//   · 目标备份文件用毫秒时间戳；VACUUM INTO 要求目标不存在，天然 fail-closed 不覆盖
//   · **每张单一个独立短事务**（[codex 344 新 MED]）：初版把所有单放进一个长 BEGIN IMMEDIATE，
//     本脚本不共享服务进程的 sysTxnMutex，长事务会让在线写请求撞 SQLITE_BUSY，候选越多锁越久
//   · **事务内重新判定候选条件**（[codex 344 新 MED]）：候选名单在事务外扫描，与实际更新之间若有人
//     补 pending / 改派 / 流转状态，就不该再动它 —— 进事务后重判，不成立即跳过并明确报告
//   · busy_timeout 显式设置，减少与在线服务的瞬时冲突
//   · 复验**全部在 COMMIT 之前**（[codex 343 HIGH-3]）：任一不符即 throw → ROLLBACK。放到 COMMIT
//     之后就没得回滚了，那样"任一不符即整体回滚"的声称会变成空话
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const issueIdx = args.indexOf('--issue');
// [codex 345 LOW 收口] CLI 参数显式校验：`--issue abc` 会得到 NaN，而 `if (ONLY_ISSUE)` 对 NaN 为假
//   ⇒ **静默退化成全量扫描**（本意只想动一张单，结果扫全库）。这类"参数写错却照跑"的失败方向最坏，
//   一律 fail-closed：非法即退出并打印用法。
function usageExit(msg) {
  console.error(`❌ ${msg}\n用法：node scripts/backfill-sys-deadlock-reopen-round.js [--db <path>] [--issue <正整数>] [--apply]`);
  process.exit(1);
}
// 值不得以 `--` 开头：`--db --apply` 这类漏写值的形态会把下一个开关当成值（codex 346 risk）。
if (dbIdx >= 0 && (!args[dbIdx + 1] || args[dbIdx + 1].startsWith('--'))) usageExit('--db 缺少路径参数（或误把开关当成了路径）');
if (issueIdx >= 0) {
  const raw = args[issueIdx + 1];
  if (!raw || raw.startsWith('--')) usageExit('--issue 缺少单号参数（或误把开关当成了单号）');
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) usageExit(`--issue 需为正整数，实得 ${JSON.stringify(raw)}`);
}
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : path.join(__dirname, '..', 'task_pool.db');
const ONLY_ISSUE = issueIdx >= 0 ? Number(args[issueIdx + 1]) : null;
// 操作者 id：存量修复由系统发起，用内置 admin(1)——与引擎自动动作的 operator 语义一致（记录"谁触发"）。
const OPERATOR_ID = 1;
const DEV_STATUSES = ['开发中', '处理中'];

if (!fs.existsSync(DB_PATH)) { console.error(`db 不存在：${DB_PATH}`); process.exit(1); }

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// 账号资格：与引擎 :3882 一带、以及本仓既有同款场景 index.js:5168 逐字同源。
const isEligible = (u) => !!u && u.status === 'active' && u.role !== 'viewer';
const ineligibleReason = (u) => !u ? '用户不存在' : (u.status !== 'active' ? `账号状态 ${u.status}` : '角色为 viewer');

// ── 内联代表选举（等价复刻 index.js electRepresentative）─────────────────────────
//   [codex 344 新 HIGH 收口] 初版漏了这一步：引擎路径在成员变动后必调 electRepresentative，而它
//   **维护 is_primary**（`SET is_primary = CASE WHEN id=? THEN 1 ELSE 0 END`）。脚本把旧行软删、
//   新行一律插 is_primary=0 却不选举 ⇒ 该单没有任何 is_primary=1 的在册成员，与生产路径行为不一致。
//   ⚠️ 复刻而非复用：本脚本是独立进程，引擎 helper 挂在依赖注入闭包里拿不到（同 sys-multidev-c0-reset.js
//   的 electRepresentativeInline 先例）。三档判据与 notify 重置口径逐条对齐权威实现，改权威须同步改这里。
//   ⚠️ 逐行比对结论（codex 345 HIGH 要求的等价性举证）：SELECT 列 / prevAssignedTo 判定 / activeRows 的
//   `ORDER BY user_id ASC` / 三档 winner / repChanged / is_primary CASE / assigned_at 仅在原为 NULL 时
//   补写 / 零在册分支，全部逐字一致。
//   ⚠️ 通知重置是 **6 列**（notify_status, notified_at, notify_message_key, notify_error, read_at,
//   notify_sent_by）——权威实现第 ④ 分支的注释写作"notify 五列"，那是 C2b 追加 notify_sent_by 后未同步
//   的过期注释，**以代码为准**（该处 SQL 拼接实为六列）。本函数按六列实现，与权威代码一致而非与其注释一致。
//   ⚠️ 唯一有意差异=**返回值**：权威返回 `{userId,userName}`，本函数返回整行 winner（多带 id/dev_status），
//   因为下方代表字段复验需要按 winner.id 断言 is_primary 落点。不影响写入行为等价性。
async function electRepresentativeInline(issueId) {
  const issue = await get('SELECT assigned_to, assigned_at FROM sys_issues WHERE id = ?', [issueId]);
  const prevAssignedTo = (issue && issue.assigned_to !== null && issue.assigned_to !== undefined) ? Number(issue.assigned_to) : null;
  const activeRows = await all(
    `SELECT id, user_id, user_name, dev_status FROM sys_issue_dev_assignees
      WHERE issue_id = ? AND removed_at IS NULL ORDER BY user_id ASC`, [issueId]);
  let winner = null;
  if (prevAssignedTo !== null) winner = activeRows.find(r => Number(r.user_id) === prevAssignedTo) || null;   // ① 现任仍在册
  if (!winner) winner = activeRows.find(r => r.dev_status === 'pending') || null;                              // ② 在册 pending 最小 user_id
  if (!winner && activeRows.length > 0) winner = activeRows[0];                                                // ③ 全在册最小 user_id

  const newAssignedTo = winner ? Number(winner.user_id) : null;
  const repChanged = prevAssignedTo !== newAssignedTo;
  const notifyResetSql = repChanged
    ? `, notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL, notify_error = NULL, read_at = NULL, notify_sent_by = NULL`
    : '';
  if (winner) {
    await run(`UPDATE sys_issue_dev_assignees SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE issue_id = ?`, [winner.id, issueId]);
    const assignedAtIsNull = !issue || issue.assigned_at === null || issue.assigned_at === undefined;
    if (assignedAtIsNull) {
      await run(`UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?, assigned_at = datetime('now','localtime')${notifyResetSql} WHERE id = ?`,
        [winner.user_id, winner.user_name, issueId]);
    } else {
      await run(`UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?${notifyResetSql} WHERE id = ?`,
        [winner.user_id, winner.user_name, issueId]);
    }
  } else {
    await run(`UPDATE sys_issue_dev_assignees SET is_primary = 0 WHERE issue_id = ?`, [issueId]);
    await run(`UPDATE sys_issues SET assigned_to = NULL, assigned_to_name = NULL, assigned_at = NULL${notifyResetSql} WHERE id = ?`, [issueId]);
  }
  return winner;
}

// 死锁判据（唯一定义处，扫描与事务内重判共用，杜绝两处口径漂移）
async function evaluateIssue(issueId) {
  const iss = await get(
    `SELECT id, type, status, return_count, reopen_count FROM sys_issues WHERE id = ?`, [issueId]);
  if (!iss) return { ok: false, reason: '单据不存在' };
  if (!DEV_STATUSES.includes(iss.status)) return { ok: false, reason: `状态已变为「${iss.status}」（非开发态）`, iss };
  const activeTotal = (await get(
    `SELECT COUNT(*) AS n FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL`, [issueId])).n;
  const pendingCnt = (await get(
    `SELECT COUNT(*) AS n FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL AND dev_status='pending'`, [issueId])).n;
  if (activeTotal === 0) return { ok: false, reason: '无在册成员', iss };
  if (pendingCnt > 0) return { ok: false, reason: `已有 ${pendingCnt} 名 pending 成员（不再死锁）`, iss };
  const members = await all(
    `SELECT id, user_id, user_name, dev_status FROM sys_issue_dev_assignees
      WHERE issue_id=? AND removed_at IS NULL AND dev_status IN ('code_submitted','no_code') ORDER BY id`, [issueId]);
  // [codex 345 LOW 收口] 在册>0、pending=0，却一个 code_submitted/no_code 都没有 ⇒ 花名册里只剩
  //   excused（或未知脏值）。这类单**不是本脚本要修的死锁形态**（没有"完成态成员挡着"这回事），
  //   原写法会把它算进死锁候选、dry-run 报出来、apply 时才回滚跳过——两处口径不一致会误导操作者。
  //   这里直接判为非候选并给出可读原因。
  if (members.length === 0) return { ok: false, reason: '无 code_submitted/no_code 成员（花名册仅剩 excused 或未知状态，非本脚本处理的死锁形态）', iss };
  return { ok: true, iss, members, activeTotal, pendingCnt };
}

(async () => {
  console.log(`db      : ${DB_PATH}`);
  console.log(`模式    : ${APPLY ? '⚠️  APPLY（真写）' : 'dry-run（只报告）'}`);
  if (ONLY_ISSUE) console.log(`限定单  : #${ONLY_ISSUE}`);
  console.log('');
  await run('PRAGMA busy_timeout = 10000');   // 与在线服务并发时不立刻 SQLITE_BUSY

  // ── 1. 扫描候选（只读）────────────────────────────────────────────────────
  const placeholders = DEV_STATUSES.map(() => '?').join(',');
  const params = [...DEV_STATUSES];
  let extra = '';
  if (ONLY_ISSUE) { extra = ' AND id = ?'; params.push(ONLY_ISSUE); }
  const rows = await all(`SELECT id FROM sys_issues WHERE status IN (${placeholders})${extra} ORDER BY id`, params);
  const candidates = [];
  for (const r of rows) {
    const ev = await evaluateIssue(r.id);
    if (ev.ok) candidates.push(ev);
  }
  console.log(`开发态单据 ${rows.length} 张，其中死锁（有在册成员且零 pending）${candidates.length} 张`);
  if (candidates.length === 0) { console.log('无需处理。'); db.close(); return; }

  for (const c of candidates) {
    console.log(`\n#${c.iss.id} ${c.iss.type} ${c.iss.status}（return${c.iss.return_count}/reopen${c.iss.reopen_count}）`);
    for (const m of c.members) {
      const u = await get('SELECT display_name, username, role, status FROM users WHERE id = ?', [m.user_id]);
      console.log(isEligible(u)
        ? `   重开一轮：${m.user_name}(uid=${m.user_id}) 旧实例 id=${m.id} [${m.dev_status}] → 软删归档 + 新 pending 实例`
        : `   ⏭️  跳过：${m.user_name}(uid=${m.user_id}) — ${ineligibleReason(u)}（保持完成态在册，需改派给在岗成员）`);
    }
  }

  if (!APPLY) {
    console.log('\n（dry-run 结束，未写入任何数据。确认无误后加 --apply 执行。）');
    db.close(); return;
  }

  // ── 2. 一致性备份（VACUUM INTO）────────────────────────────────────────────
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
  const bak = `${DB_PATH}.bak-${stamp}`;
  if (fs.existsSync(bak)) { console.error(`❌ 备份文件已存在，中止：${bak}`); db.close(); process.exit(1); }
  // [codex 345 MED 收口] VACUUM INTO 失败（目标目录不可写 / 磁盘满 / 写入中断）可能留下**残缺的**目标
  //   文件；不清理的话，下次运行会因"目标已存在"被拒，且那份残缺文件看起来像一份可用备份，更危险。
  //   失败路径：先尝试删除残余，再退出并给人工指引。此刻尚未开任何写事务，源库一个字节没动。
  try {
    await run(`VACUUM INTO ?`, [bak]);   // SQLite 一致性快照；目标存在即报错=天然 fail-closed
  } catch (e) {
    let residue = '';
    if (fs.existsSync(bak)) {
      try { fs.unlinkSync(bak); residue = '（已清理残缺的目标文件）'; }
      catch (_) { residue = `（⚠️ 残缺目标文件清理失败，请手动删除后重试：${bak}）`; }
    }
    console.error(`\n❌ 备份失败，未做任何数据修改：${e.message}${residue}`);
    console.error('   请检查目标目录可写性与磁盘空间后重试；源库未被本脚本触碰。');
    db.close(); process.exit(1);
  }
  console.log(`\n已备份（VACUUM INTO 一致性快照）：${bak}（${fs.statSync(bak).size} 字节）`);

  // ── 3. 逐单短事务：重判 → 处理 → 选举 → 复验 → COMMIT ──────────────────────
  let doneIssues = 0, doneMembers = 0, skippedMembers = 0, skippedIssues = 0;
  for (const cand of candidates) {
    const issueId = cand.iss.id;
    try {
      await run('BEGIN IMMEDIATE');
      // 事务内重新判定：扫描与执行之间可能有人补 pending / 改派 / 流转状态
      const ev = await evaluateIssue(issueId);
      if (!ev.ok) {
        await run('ROLLBACK');
        console.log(`\n#${issueId} ⏭️  跳过：${ev.reason}（扫描后状态已变，未做任何写入）`);
        skippedIssues++; continue;
      }
      let reopenedHere = 0; const reopened = [];
      for (const m of ev.members) {
        const u = await get('SELECT display_name, username, role, status FROM users WHERE id = ?', [m.user_id]);
        if (!isEligible(u)) { skippedMembers++; continue; }
        const rm = await run(
          `UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime')
            WHERE id = ? AND issue_id = ? AND removed_at IS NULL`, [m.id, issueId]);
        if (rm.changes !== 1) throw new Error(`#${issueId} 旧实例 id=${m.id} 软删 changes=${rm.changes}（期望 1）`);
        const ins = await run(
          `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
           VALUES (?, ?, ?, 0, 'pending')`, [issueId, m.user_id, u.display_name || u.username || m.user_name]);
        await run(
          `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, related_dev_assignee_id, action, reason, operator_id, payload_json, created_at)
           VALUES (?, ?, NULL, 're-add', ?, ?, ?, datetime('now','localtime'))`,
          [issueId, ins.lastID, '存量死锁修复：打回后自动重开一轮（补写）', OPERATOR_ID,
           JSON.stringify({ superseded_dev_assignee_id: m.id, trigger: 'backfill_deadlock' })]);
        reopened.push(m); reopenedHere++;
      }
      if (reopenedHere === 0) {
        await run('ROLLBACK');
        console.log(`\n#${issueId} ⏭️  跳过：全部完成态成员账号不可参与，未做任何写入（需改派给在岗成员）`);
        skippedIssues++; continue;
      }
      // ④ 代表选举（与引擎路径一致）
      const winner = await electRepresentativeInline(issueId);

      // ── COMMIT 前复验（任一不符 → throw → ROLLBACK）──────────────────────
      const p = (await get(
        `SELECT COUNT(*) AS n FROM sys_issue_dev_assignees
          WHERE issue_id=? AND removed_at IS NULL AND dev_status='pending'`, [issueId])).n;
      if (p < 1) throw new Error(`复验失败：#${issueId} 处理后仍无 pending 成员`);
      for (const m of reopened) {
        const old = await get('SELECT dev_status, removed_at FROM sys_issue_dev_assignees WHERE id=?', [m.id]);
        if (old.dev_status !== m.dev_status) throw new Error(`复验失败：#${issueId} 旧实例 ${m.id} dev_status 被改动（${m.dev_status}→${old.dev_status}）——B4b 要求原样封存`);
        if (!old.removed_at) throw new Error(`复验失败：#${issueId} 旧实例 ${m.id} 未被软删`);
        const nw = await get(
          `SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, m.user_id]);
        if (!nw || nw.dev_status !== 'pending') throw new Error(`复验失败：#${issueId} user=${m.user_id} 未获得新的 pending 在册实例`);
      }
      // 代表字段与在册花名册一致性（本脚本新引入的写点，必须自证）
      const primaries = await all(
        `SELECT id, user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL AND is_primary=1`, [issueId]);
      if (primaries.length !== 1) throw new Error(`复验失败：#${issueId} 在册 is_primary=1 应恰 1 行，实得 ${primaries.length}`);
      if (!winner || primaries[0].id !== winner.id) throw new Error(`复验失败：#${issueId} is_primary 未落在选举 winner 上`);
      const issAfter = await get('SELECT assigned_to FROM sys_issues WHERE id=?', [issueId]);
      if (Number(issAfter.assigned_to) !== Number(primaries[0].user_id)) throw new Error(`复验失败：#${issueId} assigned_to(${issAfter.assigned_to}) 与在册 primary(${primaries[0].user_id}) 不一致`);

      await run('COMMIT');
      doneIssues++; doneMembers += reopenedHere;
      console.log(`\n#${issueId} ✅ ${reopenedHere} 名成员重开一轮，代表=${winner.user_name}(uid=${winner.user_id})`);
    } catch (e) {
      try { await run('ROLLBACK'); } catch (_) { /* ignore */ }
      console.error(`\n#${issueId} ❌ 失败已回滚：${e.message}`);
      console.error(`   本单数据未改变；其余单不受影响（逐单独立事务）；备份在 ${bak}`);
      db.close(); process.exit(1);
    }
  }

  console.log(`\n✅ 完成：${doneIssues} 单 / ${doneMembers} 名成员重开一轮` +
    `${skippedMembers > 0 ? `，${skippedMembers} 名成员因账号不可参与被跳过` : ''}` +
    `${skippedIssues > 0 ? `，${skippedIssues} 单整单跳过` : ''}`);
  console.log('   （每单复验已在各自 COMMIT 前完成：新 pending 就位 + 旧实例 dev_status 原样封存 + 代表字段自洽）');
  db.close();
})().catch(e => { console.error('异常：', e.message); db.close(); process.exit(1); });
