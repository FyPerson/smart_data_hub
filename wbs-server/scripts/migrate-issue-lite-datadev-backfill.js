/**
 * migrate-issue-lite-datadev-backfill.js — 数据开发台账存量 datadev 占位号回填（一次性）
 * 照数据修正 migrate-correction-datafix-backfill-v2 范式（DRY/REAL 双模）。
 *
 * 背景：作废与查询优化轮起，建单空 OA 自动补 'datadev-{id}'；此前存量单 oa_number 为 NULL，
 *   需一次性回填保持列表/搜索口径一致（占位号不变式=号恒等于自己 id）。
 *
 * 用法：
 *   DRY_RUN（默认，仅列出）：node scripts/migrate-issue-lite-datadev-backfill.js
 *   REAL_RUN（实际更新）：    MODE=real node scripts/migrate-issue-lite-datadev-backfill.js
 *   目标库默认 wbs-server/task_pool.db；生产跑法=部署时在生产目录执行（或 DB=<路径> 指定）。
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3');

const IS_REAL = process.env.MODE === 'real';
const DB_FILE = process.env.DB || path.join(__dirname, '..', 'task_pool.db');
console.log(`\n=== 数据开发台账 datadev 占位号回填 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) · ${DB_FILE} ===`);

const db = new sqlite3.Database(DB_FILE);
db.all(`SELECT id, title, oa_number FROM issue_lite WHERE oa_number IS NULL ORDER BY id`, (err, rows) => {
    if (err) { console.error('查询失败：' + err.message); process.exit(1); }
    if (!rows.length) { console.log('无待回填行（oa_number 均已有值），退出。'); db.close(); return; }
    console.log(`待回填 ${rows.length} 行：`);
    rows.forEach(r => console.log(`  #${r.id} 「${String(r.title).slice(0, 30)}」 → datadev-${r.id}`));
    if (!IS_REAL) {
        console.log(`\n如确认无误，跑：MODE=real node scripts/migrate-issue-lite-datadev-backfill.js`);
        db.close(); return;
    }
    db.run(`UPDATE issue_lite SET oa_number = 'datadev-' || id WHERE oa_number IS NULL`, function (e) {
        if (e) { console.error('回填失败：' + e.message); process.exit(1); }
        const updated = this.changes;
        // codex 19 uxM-3/uxM-2：尾检不变式——NULL 清零 + datadev 号恒等于自身 id；任一不满足以非零码退出
        db.all(`SELECT
                    SUM(CASE WHEN oa_number IS NULL THEN 1 ELSE 0 END) AS null_cnt,
                    SUM(CASE WHEN oa_number LIKE 'datadev-%' AND oa_number != 'datadev-' || id THEN 1 ELSE 0 END) AS mismatch_cnt
                FROM issue_lite`, (e2, chk) => {
            if (e2) { console.error('尾检失败：' + e2.message); process.exit(1); }
            const nullCnt = (chk[0] && chk[0].null_cnt) || 0, misCnt = (chk[0] && chk[0].mismatch_cnt) || 0;
            const ok = nullCnt === 0 && misCnt === 0;
            console.log(`\n${ok ? '✅' : '❌'} 已回填 ${updated} 行（预期 ${rows.length}）· 尾检：NULL=${nullCnt} / datadev-id 不匹配=${misCnt}`);
            db.close();
            if (!ok || updated !== rows.length) process.exit(1);
        });
    });
});
