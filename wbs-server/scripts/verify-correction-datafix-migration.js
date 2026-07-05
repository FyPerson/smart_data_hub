// verify-correction-datafix-migration.js — A2 存量回填脚本（migrate-correction-datafix-backfill.js）验证
//   不能用 in-memory db + require（该脚本按约定 fs 路径直连生产库副本，非依赖注入范式），
//   改用"临时替换 task_pool.db + 子进程真跑脚本 + 断言 stdout/exit code/DB 结果 + finally 还原"。
//   ⚠️ 会短暂替换 wbs-server/task_pool.db（本地开发库副本，非生产库）；跑完必还原（try/finally），
//   不影响其余 verify 脚本使用的固定路径。
// 覆盖：
//   ① 候选集合出现目标外 id（如 #5）→ 中止（exit 2），不做任何更新
//   ② 候选集合恰为目标子集 {22,37}（含真实号/VOIDED 干扰行）→ DRY_RUN 不改数据、REAL_RUN 精确回填
//   ③ REAL_RUN 后再次执行（候选集合已变空）→ 视为"无需处理"成功退出（幂等），非误判为"中止"
// 用法：node scripts/verify-correction-datafix-migration.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');

const REAL_DB = path.join(__dirname, '..', 'task_pool.db');
const BACKUP_DB = path.join(__dirname, '..', 'task_pool.db.verify-datafix-migration.bak');
const SCRIPT = path.join(__dirname, 'migrate-correction-datafix-backfill.js');

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

function buildFixtureDb(dbPath, rows) {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => { if (err) return reject(err); });
        db.serialize(() => {
            db.run(`CREATE TABLE correction_requests (
                id INTEGER PRIMARY KEY,
                status TEXT, oa_number TEXT, source_system TEXT, location_info TEXT, created_at DATETIME
            )`);
            const stmt = db.prepare(`INSERT INTO correction_requests (id, status, oa_number, source_system, location_info, created_at) VALUES (?,?,?,?,?,?)`);
            for (const r of rows) stmt.run([r.id, r.status, r.oa_number, r.source_system || 'BMS', r.location_info || 'x', r.created_at || '2026-06-01 10:00:00']);
            stmt.finalize((e) => { if (e) return reject(e); db.close((ce) => ce ? reject(ce) : resolve()); });
        });
    });
}

function runMigration(mode) {
    try {
        const out = execFileSync('node', [SCRIPT], {
            env: { ...process.env, MODE: mode },
            encoding: 'utf8',
        });
        return { code: 0, out };
    } catch (e) {
        // execFileSync 非 0 退出码会 throw，取 e.status + e.stdout
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function readRow(dbPath, id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (e) => { if (e) return reject(e); });
        db.get('SELECT * FROM correction_requests WHERE id=?', [id], (e, row) => {
            db.close();
            if (e) return reject(e);
            resolve(row);
        });
    });
}

(async () => {
    console.log('=== A2 存量 datafix 回填脚本验证 ===\n');
    // 备份当前 task_pool.db（本地开发库副本）
    const hadOriginal = fs.existsSync(REAL_DB);
    if (hadOriginal) fs.copyFileSync(REAL_DB, BACKUP_DB);

    try {
        // ① 候选集合出现目标外 id（#5，不在 {22,37}）→ 中止，exit 2
        await buildFixtureDb(REAL_DB, [
            { id: 5, status: 'PENDING_ASSIGN', oa_number: null },
        ]);
        const r1 = runMigration('dry');
        ok(r1.code === 2, `①候选集合含未审计 id(#5) → DRY_RUN exit code=2（实际 ${r1.code}）`);
        ok(/中止/.test(r1.out) && /5/.test(r1.out), '①输出含"中止"提示 + 提及未审计 id 5');
        const r1real = runMigration('real');
        ok(r1real.code === 2, '①MODE=real 同样中止（不会因为传 real 就放行未审计 id）');
        const row5 = await readRow(REAL_DB, 5);
        ok(row5.oa_number === null, '①中止后 #5 的 oa_number 仍为 NULL（未被误改）');

        // ② 候选集合恰为目标子集 {22,37}（含真实号 #99 / VOIDED #100 干扰行验证排除正确）
        await buildFixtureDb(REAL_DB, [
            { id: 22, status: 'PENDING_ASSIGN', oa_number: null },
            { id: 37, status: 'IN_PROGRESS', oa_number: '' },
            { id: 99, status: 'PENDING_ASSIGN', oa_number: '123456' },      // 真实号，不应被处理
            { id: 100, status: 'VOIDED', oa_number: null },                  // 已作废，不应被处理
        ]);
        const r2dry = runMigration('dry');
        ok(r2dry.code === 0, `②DRY_RUN 候选恰为子集 → exit 0（实际 ${r2dry.code}）`);
        ok(/22, 37/.test(r2dry.out.replace(/\s/g, '') ) || /\[22, 37\]/.test(r2dry.out), '②DRY_RUN 输出识别候选集合 [22, 37]');
        const row22Before = await readRow(REAL_DB, 22);
        ok(row22Before.oa_number === null, '②DRY_RUN 未实际写库（#22 仍为 NULL，OPEN_READONLY 兜底）');

        const r2real = runMigration('real');
        ok(r2real.code === 0, `②REAL_RUN 成功 → exit 0（实际 ${r2real.code}）`);
        const row22 = await readRow(REAL_DB, 22);
        const row37 = await readRow(REAL_DB, 37);
        const row99 = await readRow(REAL_DB, 99);
        const row100 = await readRow(REAL_DB, 100);
        ok(row22.oa_number === 'datafix-22', '②#22 回填为 datafix-22');
        ok(row37.oa_number === 'datafix-37', '②#37 回填为 datafix-37');
        ok(row99.oa_number === '123456', '②#99（真实号）未被触碰');
        ok(row100.oa_number === null, '②#100（VOIDED）未被触碰（状态过滤生效）');

        // ③ 再次执行 REAL_RUN（候选集合已变空）→ 视为"无需处理"成功退出，非误判中止（幂等）
        const r3 = runMigration('real');
        ok(r3.code === 0, `③二次执行候选集合已空 → exit 0 幂等成功（实际 ${r3.code}）`);
        ok(/无需处理/.test(r3.out), '③输出提示"无需处理"（区分于①的中止提示）');

        console.log(`\n=== A2 存量回填脚本验证通过：${pass} 断言 ===`);
    } finally {
        // 还原本地开发库副本
        if (hadOriginal) {
            fs.copyFileSync(BACKUP_DB, REAL_DB);
            fs.unlinkSync(BACKUP_DB);
            console.log('（已还原 task_pool.db 本地开发库副本）');
        } else if (fs.existsSync(REAL_DB)) {
            fs.unlinkSync(REAL_DB);
        }
    }
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); process.exitCode = 1; });
