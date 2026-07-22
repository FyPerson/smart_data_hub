/**
 * migrate-issue-lite-prod-reset.js — 数据开发台账生产测试数据清空 + ID 序列归 1（一次性·用户拍板 2026-07-22）
 *
 * 背景：issue_lite 生产上线后仅有测试性质登记单；作废与查询优化上线时一并清空，
 *   并重置 AUTOINCREMENT 序列让正式启用后的新单 ID 从 1 开始（datadev-{id} 占位号不变式随之干净起步）。
 *
 * 安全设计（codex 19 uxH-1/2/4 + uxM-1 加固）：
 *   - DRY_RUN 默认：仅列出将删除的每一行 + 数据库绝对路径 + 清单摘要令牌，供人工核对全部为测试数据
 *   - REAL 三重门：须同时 MODE=real + CONFIRM=DELETE_ALL_ISSUE_LITE + DIGEST=<DRY 令牌>（绑定人工核对清单）
 *   - 停服前置：本地 3000 端口有监听即拒绝执行（REAL 必须在 pm2 stop 窗口内跑）
 *   - DB 三步（删附件行/删单/清序列）包 BEGIN IMMEDIATE 事务，事务内重读最终清单，异常回滚
 *   - 物理文件在 DB 提交**之后**删（提交失败不动文件）；白名单用 path.relative 判界（拒 ../ 与
 *     兄弟目录前缀绕过如 issue-lite-backup）；删失败输出完整清单并以非零码退出（数据库已清、文件残留）
 *
 * 用法（生产 wbs-server 目录·pm2 stop 后执行）：
 *   DRY：  node scripts/migrate-issue-lite-prod-reset.js          → 输出清单 + 摘要令牌
 *   REAL： MODE=real CONFIRM=DELETE_ALL_ISSUE_LITE DIGEST=<令牌> node scripts/migrate-issue-lite-prod-reset.js
 *   （三重门：MODE + CONFIRM + DIGEST 令牌绑定人工核对清单；可 DB=<路径> 指定库）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const sqlite3 = require('sqlite3');

const IS_REAL = process.env.MODE === 'real';
const CONFIRMED = process.env.CONFIRM === 'DELETE_ALL_ISSUE_LITE';
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.resolve(process.env.DB || path.join(ROOT, 'task_pool.db'));
const ALLOWED_BASE = path.resolve(ROOT, 'uploads', 'issue-lite');
console.log(`\n=== 数据开发台账 生产清空+ID 归 1 (${IS_REAL ? 'REAL_RUN' : 'DRY_RUN'}) ===`);
console.log(`目标数据库（绝对路径·请人工核对）：${DB_FILE}`);

// 复审 uxH-1 + 终审 M：失败关闭——netstat 异常、或任一 TCP 候选行不可解析时**抛错拒绝 REAL**
//   （不能把「无法确认」当「未监听」；不静默跳过结构异常行）
function portListeningStrict(port) {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' }); // 异常直接抛给调用方
    if (!/^\s*(TCP|Proto|活动连接|Active Connections)/im.test(out)) throw new Error('netstat 输出无法解析（无 TCP/表头行）');
    let found = false;
    for (const line of out.split(/\r?\n/)) {
        if (!/^\s*TCP\b/i.test(line)) continue; // 非 TCP 行（表头/UDP/空行）跳过
        const cols = line.trim().split(/\s+/);
        // 终确认轮 H：TCP 数据行必须五列（协议/本地/外部/状态/PID）且逐列可解析——任一异常抛错拒绝 REAL
        if (cols.length < 5) throw new Error('TCP 行列数不足：' + line.trim());
        const mLocal = cols[1].match(/:(\d+)$/);
        if (!mLocal) throw new Error('无法解析本地地址列：' + line.trim());
        if (!/:(\d+|\*)$/.test(cols[2])) throw new Error('无法解析外部地址列：' + line.trim());
        if (!/^[A-Z_0-9]+$/i.test(cols[3])) throw new Error('无法解析状态列：' + line.trim());
        if (!/^\d+$/.test(cols[4])) throw new Error('无法解析 PID 列：' + line.trim());
        if (Number(mLocal[1]) === port && cols[3].toUpperCase() === 'LISTENING') found = true;
    }
    return found;
}
// 终审 H-2：DRY→REAL 确认链绑定——对规范化清单算稳定摘要；DRY 打印令牌，REAL 须携带
//   DIGEST=<令牌> 且在事务快照内重算严格一致，否则回滚（保证删除的就是人工核对过的那批数据）
function listDigest(rows, atts) {
    const norm = JSON.stringify({
        rows: rows.map(r => [r.id, r.title, r.status, r.created_by_name, r.voided_at, r.oa_number]),
        atts: atts.map(a => [a.id, a.issue_lite_id, a.file_name, a.original_name]),
    });
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex'); // 终确认轮 M：全长 SHA-256（摘要一致=清单一致的强保证）
}
// uxH-1 + 复审 uxM-2：真实路径判界——realpath 解析后再 relative 校验，防符号链接/junction 把删除
//   引到白名单外（词法 ../ 与兄弟目录前缀绕过亦覆盖）
function realInAllowedDir(fullPath) {
    const baseReal = fs.realpathSync(ALLOWED_BASE);
    const fileReal = fs.realpathSync(fullPath); // 文件为链接时解析到真实目标——目标在白名单外即拒
    const rel = path.relative(baseReal, fileReal);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const db = new sqlite3.Database(DB_FILE);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
    const rows = await all(`SELECT id, title, status, created_by_name, voided_at, oa_number FROM issue_lite ORDER BY id`);
    const atts = await all(`SELECT id, issue_lite_id, file_name, original_name FROM issue_lite_attachments ORDER BY id`);
    console.log(`\n将删除登记单 ${rows.length} 行：`);
    rows.forEach(r => console.log(`  #${r.id} [${r.voided_at ? '已作废' : r.status}] 「${String(r.title).slice(0, 30)}」 by ${r.created_by_name} (OA:${r.oa_number || '-'})`));
    console.log(`将删除附件 ${atts.length} 行（含物理文件）：`);
    atts.forEach(a => console.log(`  att#${a.id} (单#${a.issue_lite_id}) ${a.original_name} → ${a.file_name}`));

    const digest = listDigest(rows, atts);
    if (!IS_REAL) {
        console.log(`\n【DRY】未做任何修改。清单摘要令牌：${digest}`);
        console.log(`人工确认以上全部为测试数据后，在 pm2 stop 窗口内携带令牌执行：`);
        console.log(`  MODE=real CONFIRM=DELETE_ALL_ISSUE_LITE DIGEST=${digest} node scripts/migrate-issue-lite-prod-reset.js`);
        db.close(); return;
    }
    // uxH-4 + 终审 H-2：REAL 三重门（MODE + CONFIRM + DIGEST）——DIGEST 令牌绑定人工核对过的那批数据
    if (!CONFIRMED) {
        console.error('❌ REAL 三重门缺第 2 项：需设置 CONFIRM=DELETE_ALL_ISSUE_LITE，拒绝执行。');
        db.close(); process.exit(1); return;
    }
    if (!process.env.DIGEST) {
        console.error('❌ REAL 三重门缺第 3 项：需携带 DIGEST=<DRY 输出的清单摘要令牌>，拒绝执行。');
        db.close(); process.exit(1); return;
    }
    // uxH-2 + 复审 uxH-1：停服前置（失败关闭）——探测异常=拒绝，服务在写时全清会删到未经人工核对的新单
    try {
        if (portListeningStrict(3000)) {
            console.error('❌ 本地 3000 端口有服务在监听（应用未停）。请先 pm2 stop 再执行，拒绝继续。');
            db.close(); process.exit(1); return;
        }
    } catch (e) {
        console.error('❌ 端口探测失败（无法确认应用已停）：' + e.message + '——人工确认 pm2 stop 后重试，拒绝继续。');
        db.close(); process.exit(1); return;
    }

    // ── DB 三步包事务（uxH-2 + 终审 H-1/H-2）：事务快照内按 DRY 同字段重读完整清单，重算摘要并与
    //    DIGEST 令牌**全字段**严格比对——任何漂移（新增/删除/同 ID 字段变化）即 ROLLBACK 要求重新 DRY ──
    let finalAtts = [];
    try {
        await run('BEGIN IMMEDIATE');
        const finalRows = await all(`SELECT id, title, status, created_by_name, voided_at, oa_number FROM issue_lite ORDER BY id`);
        finalAtts = await all(`SELECT id, issue_lite_id, file_name, original_name FROM issue_lite_attachments ORDER BY id`);
        const txDigest = listDigest(finalRows, finalAtts);
        if (txDigest !== process.env.DIGEST) {
            await run('ROLLBACK');
            console.error(`❌ 事务内清单摘要(${txDigest})与 DIGEST 令牌(${process.env.DIGEST})不一致——数据在人工核对后发生过变化，已回滚。`);
            console.error('   请重新 DRY 核对最新清单并携带新令牌执行。以下为事务内清单（仅诊断用·正式确认须重新 DRY）：');
            console.error(`   登记单 ${finalRows.length} 行：`);
            finalRows.forEach(r => console.error(`   #${r.id} [${r.voided_at ? '已作废' : r.status}] 「${String(r.title).slice(0, 30)}」 (OA:${r.oa_number || '-'})`));
            console.error(`   附件 ${finalAtts.length} 行：`);
            finalAtts.forEach(a => console.error(`   att#${a.id} (单#${a.issue_lite_id}) ${a.original_name} → ${a.file_name}`));
            db.close(); process.exit(1); return;
        }
        console.log(`\n事务内清单摘要与 DIGEST 令牌一致（${txDigest}）：单 ${finalRows.length} 行 / 附件 ${finalAtts.length} 行`);
        const dAtt = await run(`DELETE FROM issue_lite_attachments`);
        const dRow = await run(`DELETE FROM issue_lite`);
        await run(`DELETE FROM sqlite_sequence WHERE name IN ('issue_lite','issue_lite_attachments')`);
        await run('COMMIT');
        console.log(`✅ 数据库已清：删单 ${dRow.changes} 行 / 删附件行 ${dAtt.changes} / 序列已清零（新单 ID 从 1 开始）`);
    } catch (e) {
        try { await run('ROLLBACK'); } catch (_) {}
        console.error('❌ 数据库清理失败，已回滚，未删任何物理文件：' + e.message);
        db.close(); process.exit(1); return;
    }

    // ── 物理文件在 DB 提交之后删（uxM-1：失败输出完整清单 + 非零退出码）──
    const failed = [];
    let fileOk = 0;
    for (const a of finalAtts) {
        const full = path.resolve(path.join(ROOT, 'uploads'), a.file_name);
        try {
            if (!fs.existsSync(full)) continue; // 无文件无需删
            if (!realInAllowedDir(full)) { failed.push(`att#${a.id} 真实路径越界不删：${a.file_name}`); continue; }
            fs.unlinkSync(full); fileOk++;
        } catch (e) { failed.push(`att#${a.id} 删失败：${e.message}`); }
    }
    if (failed.length) {
        console.error(`\n⚠️ 数据库已清，但 ${failed.length} 个物理文件清理未完成（残留于 uploads/issue-lite/，需人工处理）：`);
        failed.forEach(f => console.error('  - ' + f));
        db.close(); process.exit(1); return;
    }
    console.log(`✅ 物理文件已清 ${fileOk} 个。全部完成。`);
    db.close();
})().catch(e => { console.error('❌ 失败：' + e.message); process.exit(1); });
