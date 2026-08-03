/**
 * _demo-seed-commit-cols.js — 「commit 编码两列」演示数据（临时脚本·看完即删）
 *
 * 用法：
 *   造数据：node scripts/_demo-seed-commit-cols.js
 *   清数据：node scripts/_demo-seed-commit-cols.js --clean
 *
 * 所有演示单标题统一前缀「[演示]」、批次号前缀「R-DEMO-」，清理按此前缀精确删除，
 * 不会碰任何真实数据。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// ⚠️ 前缀必须足够独特（2026-08-03 踩坑）：初版用 '[演示]'，而本地开发库里**本来就有**
//   2026-07-20 造的 [演示]xxx 单（#87/88/89），"先清后造"把它们一并删了（已从 7/28 备份恢复）。
//   教训：**给"批量删除"用的匹配前缀，必须先 SELECT 看清命中什么再删**，且前缀要带任务标识、
//   不能用「演示/测试/demo」这类任何人都可能用的通用词。
const TITLE_PREFIX = '[演示·commit列]';
const RELEASE_PREFIX = 'R-DEMOCC-';
// 初版用通用前缀造出来的遗留单，按 id 精确清理（不靠模糊匹配，避免二次误伤）
const LEGACY_IDS = [561, 562, 563, 564, 565, 566];

async function clean() {
  const issues = await all(
    `SELECT id, title FROM sys_issues WHERE title LIKE ? OR id IN (${LEGACY_IDS.join(',')})`,
    [TITLE_PREFIX + '%']);
  const rels = await all(`SELECT id FROM sys_releases WHERE release_no LIKE ?`, [RELEASE_PREFIX + '%']);
  // 删之前先亮清单——这一步就是初版缺的那一步
  if (issues.length) {
    console.log('将删除以下单据（删前清单）：');
    issues.forEach(r => console.log(`   #${r.id} ${r.title}`));
  }
  for (const r of issues) {
    await run('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [r.id]);
    await run('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [r.id]);
    await run('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [r.id]);
    await run('DELETE FROM sys_issues WHERE id = ?', [r.id]);
  }
  for (const r of rels) {
    await run('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id = ?', [r.id]);
    await run('DELETE FROM sys_releases WHERE id = ?', [r.id]);
  }
  console.log(`🧹 已清理：${issues.length} 张演示单 / ${rels.length} 个演示批次`);
  const leftI = await get(`SELECT COUNT(*) c FROM sys_issues WHERE title LIKE ?`, [TITLE_PREFIX + '%']);
  const leftR = await get(`SELECT COUNT(*) c FROM sys_releases WHERE release_no LIKE ?`, [RELEASE_PREFIX + '%']);
  console.log(`   残留核对：单据 ${leftI.c} / 批次 ${leftR.c}（均应为 0）`);
}

async function seed() {
  const admin = await get(`SELECT id, display_name FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1`);
  if (!admin) throw new Error('库中无 active admin');

  const mkIssue = async (title, status, type = 'bug', extra = {}) => {
    const r = await run(
      `INSERT INTO sys_issues (type, status, title, system_name, module_name, source, priority,
                               created_by, created_by_name, intake_required, deadline, dev_estimated_at, scheduled_start)
       VALUES (?, ?, ?, ?, ?, '内部', ?, ?, ?, 1, ?, ?, ?)`,
      [type, status, TITLE_PREFIX + title, extra.sys || 'BMS', extra.mod || '订单模块',
       extra.pri || 'P2', admin.id, admin.display_name,
       extra.deadline || null, extra.est || null, extra.start || null]
    );
    return r.lastID;
  };
  const mkMember = async (issueId, userId, userName) => {
    const r = await run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
       VALUES (?, ?, ?, 0, 'pending')`, [issueId, userId, userName]);
    return r.lastID;
  };
  const seedCommit = (issueId, daId, userId, component, ref) =>
    run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`, [issueId, daId, userId, component, ref]);

  const out = [];

  // ① 最常见：前端 1 + 后端 1
  const i1 = await mkIssue('订单列表分页错位', '处理中', 'bug',
    { deadline: '2026-08-10', est: '2026-08-08 18:00', mod: '订单模块' });
  const m1 = await mkMember(i1, 5, '示例开发A');
  await seedCommit(i1, m1, 5, 'frontend', 'a3f9c21');
  await seedCommit(i1, m1, 5, 'backend', '7b2e004');
  out.push([i1, '前端1+后端1（最常见形态）']);

  // ② 恰好 2 条：全量显示、分号隔开
  const i2 = await mkIssue('导出模板字段缺失', '处理中', 'bug',
    { deadline: '2026-08-12', est: '2026-08-09 12:00', mod: '报表模块' });
  const m2 = await mkMember(i2, 6, '示例开发B');
  await seedCommit(i2, m2, 6, 'frontend', 'c81d5fa');
  await seedCommit(i2, m2, 6, 'frontend', '4e2b117');
  await seedCommit(i2, m2, 6, 'backend', 'd09f7a3');
  out.push([i2, '前端恰好2条 → 全量显示分号隔开']);

  // ③ 超过 2 条：收起为「首条 + 等N条」，悬停看全部
  const i3 = await mkIssue('客户主数据同步异常', '待上线', 'improvement',
    { deadline: '2026-08-15', est: '2026-08-11 17:30', start: '2026-08-05', pri: 'P1', mod: '主数据' });
  const m3 = await mkMember(i3, 7, '示例开发C');
  for (const ref of ['fe-1a2b3c4', 'fe-5d6e7f8', 'fe-9a0b1c2', 'fe-3d4e5f6', 'fe-7a8b9c0']) {
    await seedCommit(i3, m3, 7, 'frontend', ref);
  }
  for (const ref of ['be-11aa22', 'be-33bb44', 'be-55cc66']) {
    await seedCommit(i3, m3, 7, 'backend', ref);
  }
  out.push([i3, '前端5条+后端3条 → 收起为「等N条」，悬停看全部']);

  // ④ 待上线但没填 → 「未填」（提醒执行人）
  const i4 = await mkIssue('权限菜单调整', '待上线', 'improvement',
    { deadline: '2026-08-14', est: '2026-08-10 10:00', start: '2026-08-06', mod: '权限' });
  await mkMember(i4, 8, '示例开发D');
  out.push([i4, '待上线+无commit → 显示「未填」']);

  // ⑤ 非待上线且没填 → 「—」
  const i5 = await mkIssue('登录页文案优化', '处理中', 'improvement',
    { deadline: '2026-08-20', mod: '登录' });
  await mkMember(i5, 9, '示例开发E');
  out.push([i5, '处理中+无commit → 显示「—」（与「未填」对照）']);

  // ⑥ 超长 ref：CSS 截断 + 悬停看完整
  const i6 = await mkIssue('结算单据编号规则变更', '待上线', 'feature',
    { deadline: '2026-08-18', est: '2026-08-13 15:00', start: '2026-08-07', pri: 'P1', mod: '结算' });
  const m6 = await mkMember(i6, 10, '示例开发F');
  await seedCommit(i6, m6, 10, 'frontend', 'feature/settlement-no-rule-refactor-20260813-9f8e7d6c5b4a');
  await seedCommit(i6, m6, 10, 'backend', 'release/settle-v2-hotfix-3c2b1a0');
  out.push([i6, '超长ref → 省略号截断，悬停看完整']);

  // ⑦ 上线批次（计划中）：把 ③④⑥ 放进去，用来看批次详情 + 一键复制
  const rel = await run(
    `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, planned_date, created_by, created_by_name)
     VALUES (?, ?, '计划中', 0, ?, ?, ?, ?)`,
    [RELEASE_PREFIX + '20260805', '[演示] 8月第一批上线', '演示用批次，看完请清理', '2026-08-05', admin.id, admin.display_name]
  );
  for (const iid of [i3, i4, i6]) {
    await run(`UPDATE sys_issues SET release_id = ? WHERE id = ?`, [rel.lastID, iid]);
  }

  console.log('\n✅ 演示数据已生成\n');
  console.log('【工单列表页】看「前端号 / 后端号 / 期望完成」三列 + 末列「计划开工」：');
  for (const [id, note] of out) console.log(`   #${id}  ${note}`);
  console.log(`\n【上线批次详情】批次 ${RELEASE_PREFIX}20260805（含 #${i3} #${i4} #${i6}）`);
  console.log('   → 系统迭代页 →「⚙️ 管理」→ 上线单管理 → 点该批次');
  console.log('   → 每行看两个 commit 区块 + 右侧 📋 复制按钮（复制的是完整清单，含被「等N条」收起的部分）');
  console.log('\n清理：node scripts/_demo-seed-commit-cols.js --clean');
}

(async () => {
  try {
    if (process.argv.includes('--clean')) await clean();
    else { await clean(); await seed(); }   // 先清后造，可反复执行不重复堆积
  } catch (e) {
    console.error('[失败]', e && e.message);
    process.exitCode = 1;
  } finally { db.close(); }
})();
