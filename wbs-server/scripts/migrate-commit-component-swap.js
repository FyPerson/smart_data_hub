#!/usr/bin/env node
/**
 * 存量修正：sys_issue_dev_commits 的 component 前后端错位对调
 *
 * 背景
 *   commit 编码两列上线时，页面标签把口径写反了——写成「前端组填 SVN 版本号 / 后端组填 GIT commit」，
 *   而正确口径是「**前端 = GIT commit，后端 = SVN 版本号**」（2026-08-04 用户拍板，见 S4 改动）。
 *   在标签改对之前录入的记录，凡是**按标签填**的，component 就存反了。
 *
 * 本脚本做什么
 *   只改 `component` 字段（frontend ⇄ backend），**`commit_ref` 的值一个字节都不动**。
 *   判定不写死 id，而是按 commit_ref 的**形态**逐条判断——因为从写脚本到实际执行之间，
 *   生产上可能又按旧标签录入了新记录，写死 id 会漏掉它们。
 *
 *   形态判据（与 Sys_Iteration.html 页面内的软提示同源，故意保持一致）：
 *     GIT commit   = /^[0-9a-fA-F]{7,40}$/ 且非纯数字
 *     SVN 版本号   = /^r?\d+$/（纯数字 或 r 前缀数字）
 *     ⚠️ 纯数字也属于 hex，故 GIT 判定必须排除 SVN 特征，否则 7 位以上的合法 SVN 版本号
 *        （如 1234567）会被误判成 GIT——这条与页面软提示踩过的坑同源。
 *
 *   处置矩阵：
 *     frontend + SVN 形态  → 改为 backend    （按旧标签填的，需对调）
 *     backend  + GIT 形态  → 改为 frontend   （同上）
 *     frontend + GIT 形态  → 保持            （已符合新口径）
 *     backend  + SVN 形态  → 保持            （已符合新口径）
 *     任一侧 + 形态不明    → **不动**，单独列出交人工判断（绝不猜）
 *
 * 用法
 *   node scripts/migrate-commit-component-swap.js              # dry-run（默认，只打印不改）
 *   node scripts/migrate-commit-component-swap.js --apply      # 真正执行（先自动快照备份）
 *   node scripts/migrate-commit-component-swap.js --db <path>  # 指定库文件（默认 ./task_pool.db）
 *
 * 执行时机
 *   ⚠️ **必须在 S4 新代码（标签已改对）部署之后再跑**。若先跑迁移后部署，页面会变成
 *   「前端组（SVN 版本号）」标签下放着 GIT hash，比现状更乱。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const APPLY = process.argv.includes('--apply');
const dbIdx = process.argv.indexOf('--db');
const DB_FILE = dbIdx > -1 && process.argv[dbIdx + 1]
    ? path.resolve(process.argv[dbIdx + 1])
    : path.resolve(__dirname, '..', 'task_pool.db');

const RE_GIT = /^[0-9a-fA-F]{7,40}$/;
const RE_SVN = /^r?\d+$/;

/** 返回 'GIT' | 'SVN' | null（形态不明） */
function shapeOf(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (RE_SVN.test(v)) return 'SVN';              // 先判 SVN：纯数字也属 hex，顺序不能反
    if (RE_GIT.test(v)) return 'GIT';
    return null;
}

/** 新口径下该形态应归属哪一侧 */
function sideForShape(shape) {
    if (shape === 'GIT') return 'frontend';
    if (shape === 'SVN') return 'backend';
    return null;
}

function openDb(readonly) {
    return new sqlite3.Database(DB_FILE, readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE);
}
const runAsync = (db, sql, p = []) => new Promise((res, rej) =>
    db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const allAsync = (db, sql, p = []) => new Promise((res, rej) =>
    db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

(async () => {
    console.log('=== sys_issue_dev_commits · component 前后端错位对调 ===');
    console.log(`库文件：${DB_FILE}`);
    console.log(`模式：${APPLY ? '⚠️  APPLY（真正写库）' : 'dry-run（只打印，不改动）'}\n`);

    if (!fs.existsSync(DB_FILE)) {
        console.error(`✗ 库文件不存在：${DB_FILE}`);
        process.exit(1);
    }

    const probe = openDb(true);
    let rows;
    try {
        rows = await allAsync(probe, `
            SELECT c.id, c.issue_id, c.component, c.commit_ref, i.title
            FROM sys_issue_dev_commits c
            LEFT JOIN sys_issues i ON i.id = c.issue_id
            ORDER BY c.issue_id, c.id`);
    } catch (e) {
        console.error('✗ 读取失败：' + e.message);
        process.exit(1);
    } finally {
        probe.close();
    }

    const toSwap = [], keep = [], manual = [];
    for (const r of rows) {
        const shape = shapeOf(r.commit_ref);
        if (!shape) { manual.push(r); continue; }
        const want = sideForShape(shape);
        (want === r.component ? keep : toSwap).push({ ...r, shape, want });
    }

    console.log(`记录总数：${rows.length}`);
    console.log(`  需对调：${toSwap.length}　保持：${keep.length}　形态不明（不动）：${manual.length}\n`);

    if (toSwap.length) {
        console.log('── 需对调（component 改，commit_ref 不动）──');
        for (const r of toSwap) {
            console.log(`  #${r.id} issue#${r.issue_id} 「${String(r.title || '').slice(0, 16)}」`
                + `\n      ${r.commit_ref}  [${r.shape} 形态]  ${r.component} → ${r.want}`);
        }
        console.log('');
    }
    if (manual.length) {
        console.log('── ⚠️ 形态不明，本脚本不动，请人工判断 ──');
        for (const r of manual) {
            console.log(`  #${r.id} issue#${r.issue_id} component=${r.component} commit_ref=${JSON.stringify(r.commit_ref)}`);
        }
        console.log('');
    }

    if (!toSwap.length) {
        console.log('✓ 无需对调，退出。');
        return;
    }
    if (!APPLY) {
        console.log('dry-run 结束。确认无误后加 --apply 执行（会先自动快照备份）。');
        return;
    }

    // ── 备份（VACUUM INTO 出一致性快照，对齐本项目既有迁移脚本范式）──
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = `${DB_FILE}.backup_swap_${stamp}`;
    const bdb = openDb(true);
    try {
        await runAsync(bdb, `VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        console.log(`✓ 快照备份：${backup}`);
    } catch (e) {
        console.error('✗ 备份失败，已中止（不在无备份的情况下改生产数据）：' + e.message);
        process.exit(1);
    } finally {
        bdb.close();
    }

    // ── 执行：事务内逐条 UPDATE，双条件守卫 + changes 检查 ──
    const db = openDb(false);
    let done = 0;
    try {
        await runAsync(db, 'BEGIN IMMEDIATE');
        for (const r of toSwap) {
            // 双条件守卫：id + 期望的当前 component。若这一行在读取之后被别人改过，
            // changes 会是 0 → 立即抛错回滚，绝不"改了个不知道是什么的行"。
            const st = await runAsync(db,
                `UPDATE sys_issue_dev_commits SET component = ?, updated_at = datetime('now','localtime')
                 WHERE id = ? AND component = ?`,
                [r.want, r.id, r.component]);
            if (st.changes !== 1) {
                throw new Error(`#${r.id} 期望改 1 行、实际 ${st.changes} 行`
                    + `（该行的 component 可能已在读取之后被改动）——整批回滚`);
            }
            done++;
        }
        await runAsync(db, 'COMMIT');
        console.log(`\n✓ 已对调 ${done} 条，事务提交。`);
    } catch (e) {
        try { await runAsync(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
        console.error(`\n✗ 失败已回滚（成功 ${done} 条也一并撤销）：${e.message}`);
        console.error(`  数据未变。备份仍在：${backup}`);
        db.close();
        process.exit(1);
    }

    // ── 复核：重新读一遍，确认无残留错位 ──
    try {
        const after = await allAsync(db, 'SELECT id, component, commit_ref FROM sys_issue_dev_commits');
        const bad = after.filter(r => {
            const s = shapeOf(r.commit_ref);
            return s && sideForShape(s) !== r.component;
        });
        console.log(bad.length === 0
            ? '✓ 复核：全部记录的 component 与形态一致，无残留错位。'
            : `⚠️ 复核：仍有 ${bad.length} 条错位（id: ${bad.map(b => b.id).join(',')}）——请人工检查。`);
    } catch (e) {
        console.error('⚠️ 复核查询失败（数据已提交）：' + e.message);
    } finally {
        db.close();
    }
})();
