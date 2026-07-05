/**
 * migrate-correction-datafix-backfill.js — 数据修正 A 块存量 datafix 占位号回填（一次性）
 *
 * 背景：方案 docs/local/数据修正/数据修正模块_OA号自动补全_方案_20260629_v1.5.md §3
 *   （不变，见同目录 v1.3 §4 / v1.1 §4 codex 80 全采纳 M-3）。
 *   Commit A1（建单 datafix 自动补号）只对【新建】的修正单生效；存量活跃单（生产审计 2026-06-29，
 *   见 v1.1 §2："活跃单 31 张，29 个 OA 号全是规范数字，2 个异常"）中 oa_number 为空的历史单，
 *   需一次性回填为 datafix-{id} 占位号（前端 formatOaNo 原样显示 datafix-22，不套 OA- 前缀）。
 *
 * 目标集合（生产审计精确值，硬编码，不接受运行期动态扩大）：id 22、37。
 *
 * ⚠️ 安全前提（跑前差异检查，M-3 + codex 82 精神的从严实现）：
 *   脚本执行前先 SELECT 全部"活跃（status<>'VOIDED'）+ oa_number 为空"的修正单 id 集合，
 *   要求该集合必须是 TARGET_IDS 的【子集】（可以是空集——代表已全部回填过，天然幂等）；
 *   一旦发现集合里出现 TARGET_IDS 之外的 id（生产在方案编写到执行之间新建了其他空号单，
 *   或历史单状态发生变化），立即中止、不做任何更新——防止盲目放宽误伤未审计过的行。
 *   中止后需人工核对新出现的 id 是什么单、是否也该走同一套回填，不得直接放宽本脚本的硬编码列表
 *   （若确要处理，须新开一次独立评审 + 新脚本，不修改/复用本一次性脚本）。
 *
 * 用法：
 *   DRY_RUN（默认，仅列出）：node scripts/migrate-correction-datafix-backfill.js
 *   REAL_RUN（实际更新）：    MODE=real node scripts/migrate-correction-datafix-backfill.js
 *
 * 部署执行（生产）：
 *   1. Commit A1（建单 datafix 自动补号）已上线
 *   2. SSH 到生产 Administrator@192.168.1.100，cd E:/Task_Pool/wbs-server
 *   3. 跑 DRY_RUN 确认候选集合 ⊆ {22, 37}
 *   4. 确认后跑 MODE=real
 *   5. 验证：详情页 #22 / #37 的 OA 流程号显示 datafix-22 / datafix-37（前端 formatOaNo 原样展示分支）
 *
 * 幂等：跑多次安全——已回填的行 oa_number 非空，不再出现在候选集合中；候选集合为空时视为
 *   "无需处理"直接成功退出（不是中止条件，中止只针对"出现未审计过的 id"）。
 *
 * 对齐 fix-misclassified-superseded.js 范式：DRY/REAL 双模式 + BEGIN IMMEDIATE 事务 + UPDATE WHERE
 *   与 SELECT WHERE 完全对齐（防 TOCTOU）+ 部分失败整体 ROLLBACK + changes===1 逐行校验。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();
const IS_REAL = MODE === 'real';

// 目标 id 集合（生产审计精确值，2026-06-29；方案 v1.1 §4 M-3——不得动态放宽为"所有空号单"）
const TARGET_IDS = [22, 37];

console.log(`\n=== 数据修正 A 块存量 datafix 回填脚本 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) ===`);
console.log(`DB: ${DB_PATH}`);
console.log(`已审计目标 id 集合（硬编码上限，非动态）：${TARGET_IDS.join(', ')}\n`);

const db = new sqlite3.Database(DB_PATH, IS_REAL ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('打开 DB 失败:', err.message);
        process.exit(1);
    }
});

// M-3 跑前差异检查：查全部"活跃（非VOIDED）+ oa_number 为空"的修正单，须为 TARGET_IDS 的子集（含空集）
db.all(
    `SELECT id, status, source_system, location_info, created_at
       FROM correction_requests
      WHERE status <> 'VOIDED' AND (oa_number IS NULL OR TRIM(oa_number) = '')
      ORDER BY id`,
    (err, candidateRows) => {
        if (err) {
            console.error('候选集合查询失败:', err.message);
            db.close();
            process.exit(1);
        }

        const candidateIds = candidateRows.map(r => r.id);
        const unexpected = candidateIds.filter(id => !TARGET_IDS.includes(id));

        console.log(`当前"活跃 + 空 OA 号"候选集合: [${candidateIds.join(', ')}]（共 ${candidateIds.length} 条）`);
        candidateRows.forEach(r => console.log(`  #${r.id} | ${r.status} | ${r.source_system} | ${(r.location_info || '').slice(0, 40)} | ${r.created_at}`));

        if (unexpected.length > 0) {
            console.error(`\n❌ 中止：候选集合中出现未审计过的 id [${unexpected.join(', ')}]（不在目标集合 [${TARGET_IDS.join(', ')}] 内）。`);
            console.error('生产数据可能已变化（新建了其他空号单 / 状态被改回活跃），禁止盲目放宽本脚本的硬编码 id 列表。');
            console.error('请人工核对这些 id 对应的单据后再决定处置方式（如需回填须新开独立评审 + 新脚本）。');
            db.close();
            process.exit(2);
        }

        if (candidateIds.length === 0) {
            console.log('\n✅ 候选集合为空（目标已全部回填过或本就不存在）——无需处理，视为成功。');
            db.close();
            return;
        }

        console.log(`\n✅ 候选集合 [${candidateIds.join(', ')}] ⊆ 目标集合 [${TARGET_IDS.join(', ')}]，${IS_REAL ? '继续执行 REAL_RUN' : '（DRY_RUN 到此为止，未做任何更新）'}`);

        if (!IS_REAL) {
            console.log(`\n如确认无误，跑：MODE=real node scripts/migrate-correction-datafix-backfill.js`);
            db.close();
            return;
        }

        db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
            if (beginErr) {
                console.error(`BEGIN IMMEDIATE TRANSACTION 失败: ${beginErr.message}`);
                console.error('未进入更新循环，无需 ROLLBACK；请排查锁/IO 问题后重跑');
                db.close();
                process.exit(1);
                return;
            }
            let okCount = 0, failCount = 0;
            // UPDATE WHERE 与 SELECT WHERE 完全对齐（含 id 精确匹配），防 TOCTOU
            const stmt = db.prepare(`
                UPDATE correction_requests
                   SET oa_number = 'datafix-' || id
                 WHERE id = ?
                   AND status <> 'VOIDED'
                   AND (oa_number IS NULL OR TRIM(oa_number) = '')
            `);
            for (const r of candidateRows) {
                stmt.run([r.id], function (e) {
                    if (e) {
                        console.error(`  ❌ #${r.id} UPDATE 失败: ${e.message}`);
                        failCount++;
                    } else if (this.changes !== 1) {
                        console.error(`  ⚠️ #${r.id} changes=${this.changes}（期望 1，可能已被其他流程修改）`);
                        failCount++;
                    } else {
                        okCount++;
                        console.log(`  ✓ #${r.id} → datafix-${r.id}`);
                    }
                });
            }
            stmt.finalize((e) => {
                if (e) {
                    console.error('finalize 失败:', e.message);
                    db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                    return;
                }
                if (failCount > 0) {
                    console.error(`\n❌ REAL_RUN 部分失败: 成功 ${okCount} / 失败 ${failCount} / 总计 ${candidateRows.length}`);
                    console.error('为防生产数据混合修复半状态，整体 ROLLBACK；请排查失败原因后重跑');
                    db.run('ROLLBACK', (rb) => {
                        if (rb) console.error('ROLLBACK 失败:', rb.message);
                        db.close();
                        process.exit(2);
                    });
                    return;
                }
                db.run('COMMIT', (e2) => {
                    if (e2) {
                        console.error('COMMIT 失败:', e2.message);
                        db.run('ROLLBACK', () => { db.close(); process.exit(1); });
                        return;
                    }
                    console.log(`\n✅ REAL_RUN 完成: 成功 ${okCount} / 失败 ${failCount} / 总计 ${candidateRows.length}`);
                    db.close();
                });
            });
        });
    }
);
