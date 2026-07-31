// 演示数据播种：上线体统一重构 v3.4 全功能面
//   用法：node scripts/demo-seed-release-unify.js
//   清理：node scripts/demo-seed-release-unify.js --clean
//
// ⚠️ 真钉钉零发送：所有会外呼的步骤（notify-executor / 手动通知）一律不走 HTTP，
//    改用直接 SQL 钉状态（与 verify 脚本同范式）。execute/close/reopen 不外呼，走真实 API。
'use strict';
const http = require('http');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = 3000;
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('❌ 未读到 JWT_SECRET（.env）'); process.exit(1); }
const DB = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(DB);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

const tok = (id, name, role) => jwt.sign({ id, username: 'u' + id, display_name: name, role }, SECRET, { expiresIn: '2h' });
const ADMIN = tok(1, '管理员', 'admin');          // 甲方 admin
const LIAISON = tok(13, '示例对接人', 'user');        // 对接人（撤销上线安排专属）
const DEV_A = tok(8, '示例开发A', 'user');           // 值班开发 A
const DEV_B = tok(9, '示例开发B', 'user');             // 值班开发 B

function call(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api' + p, method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.slice(0, 200) }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const P = '【演示】';
const ok = (m) => console.log('  ✓ ' + m);
async function must(r, expect, what) {
  if (r.status !== expect) throw new Error(`${what} 期望 ${expect} 实得 ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// 建单 → 受理 → (变更流补OA+排期) → 指派 → 预计 → 提交 → 验收 ⇒ 落「待上线」
async function seedToReady(type, title, devId, devTok) {
  const c = await must(await call('POST', '/sys-issues', ADMIN, {
    intake_contract_version: 2, type, title: P + title, system_name: 'BMS', source: '内部',
  }), 201, `建单(${type})`);
  const id = c.id;
  await call('POST', `/sys-issues/${id}/intake-accept`, ADMIN, {});
  if (type !== 'bug') {
    await call('POST', `/sys-issues/${id}/schedule`, ADMIN, {});
    await call('POST', `/sys-issues/${id}/set-oa-number`, ADMIN, { oa_number: '2026' + String(3000 + id).slice(-6) });
  }
  await call('POST', `/sys-issues/${id}/assign`, ADMIN, { assigned_to: devId });
  await call('POST', `/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-05 10:00' });
  await call('POST', `/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '演示数据（无代码提交）' });
  await must(await call('POST', `/sys-issues/${id}/accept`, ADMIN, {}), 200, `验收 #${id}`);
  return id;
}

// ⚠️ 不走 notify-executor（会真发钉钉）——直接 SQL 钉「已通知」态
async function pinNotified(relId, devId, devName) {
  await run(
    `UPDATE sys_releases SET release_assignee_id=?, release_assignee_name=?,
       release_assignee_notify_status='sent', release_assignee_notified_at=datetime('now','localtime'),
       release_assignee_notify_token=? WHERE id=?`,
    [devId, devName, 'demo_' + relId + '_' + devId, relId]
  );
}
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function clean() {
  console.log('\n🧹 清理演示数据…');
  const iss = await all(`SELECT id FROM sys_issues WHERE title LIKE ?`, [P + '%']);
  const ids = iss.map(r => r.id);
  const rels = await all(`SELECT id FROM sys_releases WHERE title LIKE ? OR release_note LIKE ?`, [P + '%', P + '%']);
  const rids = rels.map(r => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const t of ['sys_issue_timeline', 'sys_issue_dev_assignees', 'sys_issue_dev_commits', 'sys_issue_attachments', 'sys_issue_release_commit_snapshots']) {
      await run(`DELETE FROM ${t} WHERE issue_id IN (${ph})`, ids).catch(() => {});
    }
    await run(`DELETE FROM sys_issues WHERE id IN (${ph})`, ids);
  }
  if (rids.length) {
    const ph = rids.map(() => '?').join(',');
    await run(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id IN (${ph})`, rids).catch(() => {});
    await run(`DELETE FROM sys_releases WHERE id IN (${ph})`, rids);
  }
  await run(`DELETE FROM sys_release_duty_roster WHERE note LIKE ?`, [P + '%']);
  console.log(`  已删除 ${ids.length} 个演示单据 / ${rids.length} 个演示上线单 / 演示排班`);
}

async function main() {
  if (process.argv.includes('--clean')) { await clean(); db.close(); return; }
  console.log('\n🌱 播种演示数据（上线体统一重构 v3.4 全功能面）\n');
  await clean();   // 先清旧演示数据，保证可重复运行

  // ── ① 值班排班：今日 + 未来一周（模拟"区间批量设置"的结果）──────────────
  console.log('① 值班排班表');
  await run(`UPDATE sys_release_duty_roster SET removed_at=datetime('now','localtime'), removed_by=1, removed_by_name='管理员'
             WHERE duty_date BETWEEN ? AND ? AND removed_at IS NULL`, [today(), plusDays(7)]);
  const roster = [[today(), 8, '示例开发A'], [plusDays(1), 8, '示例开发A'], [plusDays(2), 9, '示例开发B'],
                  [plusDays(3), 9, '示例开发B'], [plusDays(4), 9, '示例开发B'], [plusDays(5), 12, '示例开发D'], [plusDays(6), 19, '示例用户B']];
  for (const [d, uid, uname] of roster) {
    await run(`INSERT INTO sys_release_duty_roster (duty_date,user_id,user_name,note,created_by,created_by_name)
               VALUES (?,?,?,?,13,'示例对接人')`, [d, uid, uname, P + '区间批量设置']);
  }
  ok(`7 天排班已建（今日=示例开发A，后续示例开发B/示例开发D/示例用户B）`);

  // ── ② 上线单 A：计划中·未通知 → admin 可点「安排上线」──────────────────
  console.log('\n② 上线单 A（计划中·未通知）');
  const a1 = await seedToReady('feature', '新增合同台账导出功能', 8, DEV_A);
  const a2 = await seedToReady('improvement', '优化模型详情页加载速度', 9, DEV_B);
  const relA = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '8月第1批常规上线', planned_date: today(), release_note: P + '常规迭代批次',
  }), 201, '建上线单A')).id;
  await must(await call('POST', `/sys-releases/${relA}/add-issues`, ADMIN, { issue_ids: [a1, a2] }), 200, 'A 加单');
  ok(`上线单 #${relA}（含 #${a1} feature + #${a2} improvement）→ 未通知，admin 可「安排上线」`);

  // ── ③ 上线单 B：混批（bug+feature）·已通知 → 执行人可「执行上线」──────────
  console.log('\n③ 上线单 B（混批 bug+feature·已通知）');
  const b1 = await seedToReady('bug', '修复导出乱码问题', 8, DEV_A);
  const b2 = await seedToReady('feature', '客户维度新增行业字段', 8, DEV_A);
  const relB = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '8月第2批（混批演示）', planned_date: today(), release_note: P + 'bug 与 feature 同批——全类型统一后允许',
  }), 201, '建上线单B')).id;
  await must(await call('POST', `/sys-releases/${relB}/add-issues`, ADMIN, { issue_ids: [b1, b2] }), 200, 'B 加单');
  await pinNotified(relB, 8, '示例开发A');
  ok(`上线单 #${relB}（含 bug #${b1} + feature #${b2}）→ 已通知示例开发A，他可「执行上线」；示例对接人可「撤销上线安排」`);

  // ── ④ 上线单 C：已发布 → 展示快照读源（source=snapshot）──────────────────
  console.log('\n④ 上线单 C（已发布·快照读源）');
  const c1 = await seedToReady('feature', '周期取数推送配置页', 9, DEV_B);
  const relC = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '7月末已完成批次', planned_date: today(), release_note: P + '已发布，用于查看历史快照',
  }), 201, '建上线单C')).id;
  await must(await call('POST', `/sys-releases/${relC}/add-issues`, ADMIN, { issue_ids: [c1] }), 200, 'C 加单');
  await pinNotified(relC, 9, '示例开发B');
  await must(await call('POST', `/sys-releases/${relC}/execute`, DEV_B, {
    release_note: P + '已完成上线', version_tag: 'v1.130.0-demo',
  }), 200, 'C 执行上线');
  ok(`上线单 #${relC} 已发布（示例开发B执行）→ 成员读源=snapshot（发布时冻结）`);

  // ── ⑤ 归档 + 重开演示 ───────────────────────────────────────────────
  console.log('\n⑤ 归档与重开');
  const d1 = await seedToReady('bug', '报表页分页错位（将演示归档重开）', 8, DEV_A);
  const relD = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '归档重开演示批次', planned_date: today(), release_note: P + '用于演示归档与重开',
  }), 201, '建上线单D')).id;
  await must(await call('POST', `/sys-releases/${relD}/add-issues`, ADMIN, { issue_ids: [d1] }), 200, 'D 加单');
  await pinNotified(relD, 8, '示例开发A');
  await must(await call('POST', `/sys-releases/${relD}/execute`, DEV_A, { release_note: P + '上线完成' }), 200, 'D 执行');
  await must(await call('POST', `/sys-issues/${d1}/close`, ADMIN, { reason: P + '验证通过，归档' }), 200, 'close');
  ok(`#${d1} 已上线 → 已归档（界面显示「已归档」）→ admin 可「重开」（bug 补终态后新能力）`);

  // ── ⑥ 降级历史演示：已发布单 + 快照被破坏 → degraded 显著提示 ─────────────
  console.log('\n⑥ 降级历史（degraded）');
  const e1 = await seedToReady('improvement', '旧批次（快照残缺演示）', 9, DEV_B);
  const relE = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '快照残缺演示批次', planned_date: today(), release_note: P + '人为删快照，演示降级提示',
  }), 201, '建上线单E')).id;
  await must(await call('POST', `/sys-releases/${relE}/add-issues`, ADMIN, { issue_ids: [e1] }), 200, 'E 加单');
  await pinNotified(relE, 9, '示例开发B');
  await must(await call('POST', `/sys-releases/${relE}/execute`, DEV_B, { release_note: P + '已上线' }), 200, 'E 执行');
  await run(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [relE]);   // 人为破坏快照
  ok(`上线单 #${relE} 已发布但快照被删 → 详情页应显示红底「历史记录不完整」横幅`);

  // ── ⑦ 应急上线单（release_kind='emergency'）──────────────────────────
  console.log('\n⑦ 应急上线单');
  const f1 = await seedToReady('bug', '生产报错紧急修复（应急演示）', 8, DEV_A);
  const relF = (await must(await call('POST', '/sys-releases', ADMIN, {
    title: P + '应急上线单', planned_date: today(), release_note: P + '应急口建单（release_kind=emergency）',
  }), 201, '建上线单F')).id;
  await run(`UPDATE sys_releases SET release_kind='emergency', is_hotfix=1 WHERE id=?`, [relF]);
  await must(await call('POST', `/sys-releases/${relF}/add-issues`, ADMIN, { issue_ids: [f1] }), 200, 'F 加单');
  ok(`上线单 #${relF} 标记为应急（emergency）→ 列表应有应急徽章`);

  // ── 汇总 ───────────────────────────────────────────────────────────
  const rels = await all(`SELECT id,release_no,title,status,release_kind,release_assignee_name,
                            release_assignee_notify_status AS ns,
                            (SELECT COUNT(*) FROM sys_issues i WHERE i.release_id=r.id) cnt
                          FROM sys_releases r WHERE title LIKE ? ORDER BY id`, [P + '%']);
  console.log('\n══════════ 演示上线单一览 ══════════');
  for (const r of rels) {
    console.log(`  #${r.id} ${r.release_no}｜${r.status}｜通知=${r.ns}｜执行人=${r.release_assignee_name || '—'}｜成员=${r.cnt}｜${r.release_kind === 'emergency' ? '应急' : '常规'}`);
    console.log(`      ${r.title}`);
  }
  const dr = await all(`SELECT duty_date,user_name FROM sys_release_duty_roster WHERE removed_at IS NULL AND duty_date>=? ORDER BY duty_date`, [today()]);
  console.log('\n══════════ 值班排班 ══════════');
  dr.forEach(d => console.log(`  ${d.duty_date}  ${d.user_name}`));
  console.log('\n✅ 播种完成。清理请跑：node scripts/demo-seed-release-unify.js --clean\n');
  db.close();
}
main().catch(e => { console.error('❌ 播种失败:', e && (e.stack || e.message)); db.close(); process.exit(1); });
