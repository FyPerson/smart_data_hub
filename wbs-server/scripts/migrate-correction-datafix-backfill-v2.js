/**
 * migrate-correction-datafix-backfill-v2.js — 数据修正 A 块存量 datafix 占位号回填（一次性·第二批）
 *
 * 背景：v1 脚本（migrate-correction-datafix-backfill.js，目标 {22,37}）2026-07-05 生产 DRY 时
 *   子集闸门按设计中止——实际候选集合为 [22, 37, 42, 48, 51]：#42/#48/#51 是 6/29 审计快照之后、
 *   v1.104.0 上线之前新建的同族单（ARCHIVED · BMS 后台修正 · 留空 OA 自发现单）。
 *   按 v1 头注纪律"不修改/复用一次性脚本、新 id 走新脚本"，本文件为第二批独立脚本。
 *
 * 目标集合审计依据（2026-07-05）：
 *   1. 生产 DRY 实测候选 = [22, 37, 42, 48, 51]（v1 中止输出全文见 session/codex 84 归档）
 *   2. #42/#48/#51 经建单人（示例用户A，亦为全部 5 张单的建单人）确认与 22/37 同族，拍板 5 张全回填
 *   3. v1.104.0 上线后新建自发现单已自动补号（建单事务内），本族群已封口——本批即最终存量
 *
 * 用法：
 *   DRY_RUN（默认，仅列出）：node scripts/migrate-correction-datafix-backfill-v2.js
 *   REAL_RUN（实际更新）：    MODE=real node scripts/migrate-correction-datafix-backfill-v2.js
 *
 * 安全前提 / 幂等 / 事务范式：与 v1 完全一致（M-3 子集闸门 + BEGIN IMMEDIATE + UPDATE WHERE
 *   与 SELECT WHERE 完全对齐防 TOCTOU + changes===1 逐行校验 + 部分失败整体 ROLLBACK）。
 *   若本脚本 DRY 再次发现目标集合之外的 id，同样中止——那意味着又有更新的空号单出现，须再走一轮核对。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();
const IS_REAL = MODE === 'real';

// 目标 id 集合（2026-07-05 生产 DRY 实测 + 建单人确认，硬编码，不得动态放宽）
const TARGET_IDS = [22, 37, 42, 48, 51];

console.log(`\n=== 数据修正 A 块存量 datafix 回填脚本 v2 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) ===`);
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
            console.log(`\n如确认无误，跑：MODE=real node scripts/migrate-correction-datafix-backfill-v2.js`);
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
