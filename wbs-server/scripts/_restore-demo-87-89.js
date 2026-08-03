/**
 * _restore-demo-87-89.js — 恢复被 _demo-seed-commit-cols.js 误删的三张演示单（临时脚本·用完即删）
 *
 * 背景：造演示数据的脚本写成"先清后造"，清理条件 title LIKE '[演示]%'，
 *       首次运行时误删了本地开发库里已存在的 #87/#88/#89（2026-07-20 造的上线体演示单）。
 * 数据源：本地备份 task_pool.db.backup_before_c25_test_20260728_120901（2026-07-28 12:09）
 * 影响范围：仅 id 87/88/89 三行 + 其关联 timeline；这三个 id 在当前库中为空，不覆盖任何现存数据。
 *
 * 用法：node scripts/_restore-demo-87-89.js
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const CUR = path.join(__dirname, '..', 'task_pool.db');
const BAK = path.join(__dirname, '..', 'task_pool.db.backup_before_c25_test_20260728_120901');
const IDS = [87, 88, 89];

const src = new sqlite3.Database(BAK, sqlite3.OPEN_READONLY);
const dst = new sqlite3.Database(CUR);
const all = (db, q, p = []) => new Promise((r, j) => db.all(q, p, (e, x) => e ? j(e) : r(x)));
const get = (db, q, p = []) => new Promise((r, j) => db.get(q, p, (e, x) => e ? j(e) : r(x)));
const run = (db, q, p = []) => new Promise((r, j) => db.run(q, p, function (e) { e ? j(e) : r(this); }));

(async () => {
  try {
    // 前置守卫：确认目标 id 在当前库确实为空，绝不覆盖现存数据
    const exists = await all(dst, `SELECT id FROM sys_issues WHERE id IN (${IDS.join(',')})`);
    if (exists.length) {
      console.error('[中止] 目标 id 在当前库已存在，拒绝覆盖：', exists.map(r => '#' + r.id).join(' '));
      process.exitCode = 1;
      return;
    }

    const rows = await all(src, `SELECT * FROM sys_issues WHERE id IN (${IDS.join(',')}) ORDER BY id`);
    if (rows.length !== IDS.length) {
      console.error(`[中止] 备份中只找到 ${rows.length} 行，与预期 ${IDS.length} 行不符`);
      process.exitCode = 1;
      return;
    }

    // ⚠️ 唯一的数据改动：intake_required 归一为 1。
    //   这三张单造于 2026-07-20，早于 v1.127.0（2026-07-27）的 C0「焊死受理门」——当时该列可为 0。
    //   现在 DB 层有拒绝型触发器（全类型 intake_required 恒 1），照原值插入会被拒。
    //   对演示用途无影响，但**必须如实记录：恢复后的数据在这一列上与删除前不同**。
    for (const row of rows) {
      const orig = row.intake_required;
      if (orig !== 1) {
        console.log(`  · #${row.id} intake_required ${JSON.stringify(orig)} → 1（C0 受理门触发器要求，见脚本注释）`);
        row.intake_required = 1;
      }
      const cols = Object.keys(row);
      await run(dst,
        `INSERT INTO sys_issues (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map(c => row[c]));
    }
    console.log('已恢复 sys_issues：', rows.map(r => '#' + r.id).join(' '));

    const tls = await all(src, `SELECT * FROM sys_issue_timeline WHERE issue_id IN (${IDS.join(',')})`);
    for (const t of tls) {
      const cols = Object.keys(t);
      await run(dst,
        `INSERT INTO sys_issue_timeline (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map(c => t[c]));
    }
    console.log('已恢复 timeline：', tls.length, '条');

    const chk = await all(dst, `SELECT id,title,status,created_at FROM sys_issues WHERE id IN (${IDS.join(',')}) ORDER BY id`);
    console.log('核验：');
    chk.forEach(x => console.log(`  ✓ #${x.id} ${x.title} | ${x.status} | ${x.created_at}`));
    const tlc = await get(dst, `SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id IN (${IDS.join(',')})`);
    console.log(`  ✓ timeline ${tlc.c} 条`);
  } catch (e) {
    console.error('[失败]', e && e.message);
    process.exitCode = 1;
  } finally {
    src.close(); dst.close();
  }
})();
