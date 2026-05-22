/**
 * v1.70.2 一次性数据修复：sql_validated_at ISO UTC → 北京时间
 *
 * 背景：
 *   collab-attachment-versioning.js 历史写法 sql_validated_at = validatedAt.toISOString()
 *   导致字段存 ISO 8601 UTC（2026-05-22T07:45:00.000Z），前端 fmtDate 截前 16 字符
 *   显示 "2026-05-22 07:45" 比真实北京时间晚 8 小时。
 *
 *   v1.70.2 已修主代码 sql_validated_at = datetime('now','localtime')，与项目其他时间字段一致。
 *   本脚本修历史数据。
 *
 * 识别规则：sql_validated_at 含 'T' 和 'Z' → ISO 格式 → 需修复
 *          含空格分隔（YYYY-MM-DD HH:MM:SS）→ 本地时间格式 → 已是正确格式，跳过
 *
 * codex 27 审 #4：识别规则覆盖性说明
 *   - 历史数据**唯一来源**是 `validatedAt.toISOString()`（JS Date 标准 UTC 格式 YYYY-MM-DDTHH:MM:SS.sssZ）
 *   - grep 项目代码确认无其他写入路径（无 +00:00 / +HH:MM offset 格式）
 *   - 为防意外历史脏数据，匹配前先 trim() 去尾部空格
 *
 * 用法：
 *   DRY_RUN（默认，仅列出）：node scripts/fix-sql-validated-at-timezone.js
 *   REAL_RUN（实际更新）：    MODE=real node scripts/fix-sql-validated-at-timezone.js
 *
 * 部署执行：
 *   1. /deploy v1.70.2 上线
 *   2. SSH 到生产 Administrator@192.168.1.100
 *   3. cd E:/Task_Pool/wbs-server
 *   4. 跑 DRY_RUN 看影响行数
 *   5. 确认后跑 MODE=real
 *   6. 验证前端详情页显示正确（OA-364265 sql_validated_at 应显示北京时间 15:45 而非 07:45）
 *
 * 幂等：跑多次安全（只改 ISO 格式行，已修过的行格式不再含 'T...Z' 跳过）
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();
const IS_REAL = MODE === 'real';

console.log(`\n=== sql_validated_at 时区修复脚本 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) ===`);
console.log(`DB: ${DB_PATH}\n`);

const db = new sqlite3.Database(DB_PATH, IS_REAL ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('打开 DB 失败:', err.message);
        process.exit(1);
    }
});

// 拉所有非空 sql_validated_at
db.all(
    `SELECT id, oa_request_no, sql_validated_at FROM collab_requests WHERE sql_validated_at IS NOT NULL ORDER BY id`,
    (err, rows) => {
        if (err) {
            console.error('查询失败:', err.message);
            db.close();
            process.exit(1);
        }

        // codex 27 审 #4：先 trim 防尾部空格 / 制表符等隐式脏数据
        const isIsoUtc = (s) => {
            if (typeof s !== 'string') return false;
            const trimmed = s.trim();
            return /T/.test(trimmed) && /Z$/.test(trimmed);
        };
        const isoRows = rows.filter(r => isIsoUtc(r.sql_validated_at));
        const localRows = rows.filter(r => !isIsoUtc(r.sql_validated_at));

        console.log(`总计 sql_validated_at 非空行: ${rows.length}`);
        console.log(`  - 已是本地时间格式（跳过）: ${localRows.length}`);
        console.log(`  - ISO UTC 格式（需修）: ${isoRows.length}\n`);

        if (isoRows.length === 0) {
            console.log('✅ 无需修复，所有时间字段已是本地格式');
            db.close();
            return;
        }

        console.log('待修复行预览（前 20 条）:');
        console.log('id | oa_request_no | 当前 (ISO UTC) | 修复后 (北京时间 +8h)');
        console.log('---'.repeat(30));

        const toBeijing = (isoUtc) => {
            // ISO UTC 加 8 小时转北京时间，格式化为 YYYY-MM-DD HH:MM:SS
            // codex 27 审 #4：trim 防尾部空格/制表符等隐式脏数据让 Date.parse 失败
            const utcDate = new Date(String(isoUtc).trim());
            if (isNaN(utcDate.getTime())) return null;
            const beijing = new Date(utcDate.getTime() + 8 * 3600 * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
        };

        const changes = [];
        for (const r of isoRows.slice(0, 20)) {
            const newVal = toBeijing(r.sql_validated_at);
            console.log(`${r.id} | ${r.oa_request_no || '-'} | ${r.sql_validated_at} | ${newVal}`);
            changes.push({ id: r.id, oldVal: r.sql_validated_at, newVal });
        }
        if (isoRows.length > 20) {
            console.log(`... (省略 ${isoRows.length - 20} 行)`);
            for (const r of isoRows.slice(20)) {
                changes.push({ id: r.id, oldVal: r.sql_validated_at, newVal: toBeijing(r.sql_validated_at) });
            }
        }

        if (!IS_REAL) {
            console.log(`\n⚠️ DRY_RUN 模式，未实际更新。`);
            console.log(`如确认无误，跑：MODE=real node scripts/fix-sql-validated-at-timezone.js`);
            db.close();
            return;
        }

        // REAL_RUN: 事务批量更新
        console.log(`\n开始 REAL_RUN 更新 ${changes.length} 行...`);
        db.serialize(() => {
            db.run('BEGIN IMMEDIATE TRANSACTION');
            let okCount = 0;
            let failCount = 0;
            const stmt = db.prepare('UPDATE collab_requests SET sql_validated_at = ? WHERE id = ? AND sql_validated_at = ?');
            for (const c of changes) {
                stmt.run([c.newVal, c.id, c.oldVal], (e) => {
                    if (e) {
                        console.error(`  ❌ id=${c.id} UPDATE 失败: ${e.message}`);
                        failCount++;
                    } else {
                        okCount++;
                    }
                });
            }
            stmt.finalize((e) => {
                if (e) {
                    console.error('finalize 失败:', e.message);
                    db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                    return;
                }
                // codex 27 审 #3：部分失败时 ROLLBACK + 非零退出
                // 一次性数据修复脚本不应留半状态；如有失败必须由人工排查后重跑
                if (failCount > 0) {
                    console.error(`\n❌ REAL_RUN 部分失败: 成功 ${okCount} / 失败 ${failCount} / 总计 ${changes.length}`);
                    console.error('为防生产数据混合修复半状态，整体 ROLLBACK；请排查失败原因后重跑');
                    db.run('ROLLBACK', (rb) => {
                        if (rb) console.error('ROLLBACK 失败:', rb.message);
                        db.close();
                        process.exit(2);  // 退出码 2 = 部分失败已回滚
                    });
                    return;
                }
                db.run('COMMIT', (e2) => {
                    if (e2) {
                        console.error('COMMIT 失败:', e2.message);
                        db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                        return;
                    }
                    console.log(`\n✅ REAL_RUN 完成: 成功 ${okCount} / 失败 ${failCount} / 总计 ${changes.length}`);
                    db.close();
                });
            });
        });
    }
);
