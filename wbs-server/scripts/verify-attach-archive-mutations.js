/**
 * 附件压缩包支持方案 C5b：§5 V13 变异自证八轮。
 *
 * 每轮：备份文件原文 → 精确字符串替换（assert 替换前原串恰出现 1 次）→ 跑目标套件断言 exit≠0 且失败文案
 * 含目标关键字 → finally 恢复原文 → 复跑同一目标套件断言 exit=0。
 *
 * 活体轮（⑤⑥⑦⑧）：本地 3000 server 由主会话管理（pid 由协调者持有），本脚本绝不碰它。变异态验证改为
 * 自行 spawn 一个临时 server 到 3100（PORT 环境变量），等 /login.html 200 后跑目标套件（改用 TEST_BASE_URL
 * 环境变量指向 3100）；恢复态验证复用已经在跑的 3000（其代码本就是"未变异"的正确版本，恢复本轮的文件
 * 变异后，3000 上跑的代码与文件系统内容一致，跑同一目标套件应回到 exit=0）——git diff --stat 才是"文件级
 * 恢复"的权威证据，3000 复跑只是"恢复后代码功能确实正常"的旁证，不重复起两次临时 server 省时间。
 *
 * `_test-fixture.js` 的 BASE 硬编码 'http://localhost:3000'，为让活体轮的目标套件能指向 3100，本脚本对它
 * 做一次**向后兼容**的最小改动（`process.env.TEST_BASE_URL || 'http://localhost:3000'`）——不设该环境变量时
 * 行为与改前逐字节相同，对同一时间可能运行的其它脚本零影响；本文件运行结束会把它连同其余变异一起恢复。
 *
 * 用法：node scripts/verify-attach-archive-mutations.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = 'E:/tmp/archive-plan';
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function readFile(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function writeFile(rel, content) { fs.writeFileSync(path.join(ROOT, rel), content, 'utf8'); }

// 精确字符串替换：替换前 oldStr 必须在文件内恰好出现 1 次，否则抛错（防止误伤同名字符串的其它位置）。
// ⚠️ 本仓库文件多为 CRLF 换行（Windows）；oldStr/newStr 里凡跨行的一律按 LF（'\n'）书写，这里按目标
// 文件实际换行符统一归一化后再比对/替换，避免 CRLF/LF 不一致导致「精确匹配」误判为 0 次命中。
function mutate(rel, oldStr, newStr) {
    const content = readFile(rel);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normOld = oldStr.replace(/\n/g, eol);
    const normNew = newStr.replace(/\n/g, eol);
    const count = content.split(normOld).length - 1;
    if (count !== 1) {
        throw new Error(`[mutate] ${rel} 内 oldStr 出现 ${count} 次（应恰为 1 次），拒绝变异。oldStr=${JSON.stringify(oldStr.slice(0, 80))}`);
    }
    writeFile(rel, content.replace(normOld, normNew));
}

function gitDiffStat() {
    const r = spawnSync('git', ['diff', '--stat'], { cwd: ROOT, encoding: 'utf8' });
    return (r.stdout || '').trim();
}
function gitStatusShort() {
    const r = spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' });
    return (r.stdout || '').trim();
}

function runNodeScript(rel, envExtra) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...(envExtra || {}) },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── 活体临时 server（3100）helper ──────────────────────────────────────────
function waitHttp200(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const http = require('http');
            const req = http.get(url, (res) => {
                res.resume();
                if (res.statusCode === 200) return resolve(true);
                retry();
            });
            req.on('error', retry);
            req.setTimeout(2000, () => { req.destroy(); retry(); });
        };
        const retry = () => {
            if (Date.now() > deadline) return reject(new Error(`等待 ${url} 200 超时（${timeoutMs}ms）`));
            setTimeout(tick, 500);
        };
        tick();
    });
}
async function startTempServer(port) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    try {
        await waitHttp200(`http://localhost:${port}/login.html`, 30000);
    } catch (e) {
        try { child.kill('SIGKILL'); } catch (_) {}
        throw new Error(`临时 server（port=${port}）启动失败：${e.message}\n--- 输出 ---\n${out.slice(-3000)}`);
    }
    return { child, getOut: () => out };
}
function stopTempServer(handle) {
    return new Promise((resolve) => {
        if (!handle || !handle.child || handle.child.killed) return resolve();
        const child = handle.child;
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
    });
}

const results = [];
function record(round, mutationLabel, suite, mutatedExit, redAt, restoredExit) {
    results.push({ round, mutationLabel, suite, mutatedExit, redAt, restoredExit });
}

async function main() {
    console.log('══════ 附件压缩包支持 C5b：V13 变异自证八轮 ══════\n');
    console.log('起始 git diff --stat：', gitDiffStat() || '(无)');

    // ═══════════════════════════════════════════════════════════════
    // 轮 ①-④：纯离线/in-process 套件，直接跑，无需任何 server
    // ═══════════════════════════════════════════════════════════════

    // ① routes/sys-iteration/index.js：把 if (!check.ok) 改 if (false)（二次卡形同虚设）
    {
        const rel = 'routes/sys-iteration/index.js';
        const before = readFile(rel);
        let mutatedRun, restoredRun;
        try {
            mutate(rel, 'if (!check.ok) {', 'if (false) {');
            mutatedRun = runNodeScript('scripts/verify-sys-attach-archive.js');
        } finally {
            writeFile(rel, before);
        }
        restoredRun = runNodeScript('scripts/verify-sys-attach-archive.js');
        const redHit = mutatedRun.status !== 0 && /V3\]|21MB|ATTACHMENT_RULE_VIOLATION/i.test(mutatedRun.out) && /应 400/.test(mutatedRun.out);
        console.log(`\n[①] mutated exit=${mutatedRun.status} restored exit=${restoredRun.status}`);
        record('①', 'sys 二次卡 if(!check.ok)→if(false)', 'verify-sys-attach-archive.js', mutatedRun.status, redHit ? 'V3 21MB pdf 应 400（实得 2xx）' : '(未命中预期关键字，见日志)', restoredRun.status);
        fs.writeFileSync(path.join(LOG_DIR, 'c5b-round1.log'), `=== mutated ===\n${mutatedRun.out}\n=== restored ===\n${restoredRun.out}`);
    }

    // ② utils/attachment-archive.js + 三页前端字面量 一起改成 100MB（模拟一起误改）
    {
        const relTruth = 'utils/attachment-archive.js';
        const relSi = 'public/Sys_Iteration.html';
        const relCorr = 'public/Data_Correction.html';
        const relCollab = 'public/Data_Collab.html';
        const beforeTruth = readFile(relTruth);
        const beforeSi = readFile(relSi);
        const beforeCorr = readFile(relCorr);
        const beforeCollab = readFile(relCollab);
        let mutatedRun, restoredRun;
        try {
            mutate(relTruth, 'const ARCHIVE_MAX_SIZE = 52428800;', 'const ARCHIVE_MAX_SIZE = 104857600;');
            mutate(relSi, 'const SI_ARCHIVE_MAX_SIZE = 52428800;', 'const SI_ARCHIVE_MAX_SIZE = 104857600;');
            mutate(relCorr, 'const CORR_ARCHIVE_MAX_SIZE = 52428800;', 'const CORR_ARCHIVE_MAX_SIZE = 104857600;');
            mutate(relCollab, 'const COLLAB_ARCHIVE_MAX_SIZE = 52428800;', 'const COLLAB_ARCHIVE_MAX_SIZE = 104857600;');
            mutatedRun = runNodeScript('scripts/verify-sys-attach-archive-static.js');
        } finally {
            writeFile(relTruth, beforeTruth);
            writeFile(relSi, beforeSi);
            writeFile(relCorr, beforeCorr);
            writeFile(relCollab, beforeCollab);
        }
        restoredRun = runNodeScript('scripts/verify-sys-attach-archive-static.js');
        const redHit = mutatedRun.status !== 0 && /业务规格独立断言|ARCHIVE_MAX_SIZE 业务规格须恒为 50MB/.test(mutatedRun.out);
        console.log(`\n[②] mutated exit=${mutatedRun.status} restored exit=${restoredRun.status}`);
        record('②', 'attachment-archive.js + 三页前端字面量 一起改 100MB', 'verify-sys-attach-archive-static.js', mutatedRun.status, redHit ? '⑥ 业务规格独立断言（ARCHIVE_MAX_SIZE 应恒为 50MB）' : '(未命中预期关键字，见日志)', restoredRun.status);
        fs.writeFileSync(path.join(LOG_DIR, 'c5b-round2.log'), `=== mutated ===\n${mutatedRun.out}\n=== restored ===\n${restoredRun.out}`);
    }

    // ③ utils/collab-submit-helpers.js 分类器：result_extra 误落 result_script（二元桶）
    {
        const rel = 'utils/collab-submit-helpers.js';
        const before = readFile(rel);
        let mutatedRun, restoredRun;
        try {
            mutate(rel, "else if (RESULT_EXTRA_EXTS.has(ext)) attachmentType = 'result_extra';", "else if (RESULT_EXTRA_EXTS.has(ext)) attachmentType = 'result_script';");
            mutatedRun = runNodeScript('scripts/verify-collab-multifile-grouping.js');
        } finally {
            writeFile(rel, before);
        }
        restoredRun = runNodeScript('scripts/verify-collab-multifile-grouping.js');
        const redHit = mutatedRun.status !== 0 && /T14/.test(mutatedRun.out);
        console.log(`\n[③] mutated exit=${mutatedRun.status} restored exit=${restoredRun.status}`);
        record('③', 'collab-submit-helpers.js result_extra→误落 result_script（二元桶）', 'verify-collab-multifile-grouping.js', mutatedRun.status, redHit ? 'T14 三类映射（result_extra 恰含该压缩文件 / result_script 不含）' : '(未命中预期关键字，见日志)', restoredRun.status);
        fs.writeFileSync(path.join(LOG_DIR, 'c5b-round3.log'), `=== mutated ===\n${mutatedRun.out}\n=== restored ===\n${restoredRun.out}`);
    }

    // ④ routes/corrections.js done 路径：physicalPath = isArchive ? null : rawPath → 恒 rawPath
    {
        const rel = 'routes/corrections.js';
        const before = readFile(rel);
        let mutatedRun, restoredRun;
        try {
            mutate(rel, 'physicalPath = isArchive ? null : rawPath;', 'physicalPath = rawPath;');
            mutatedRun = runNodeScript('scripts/verify-correction-attach-archive.js');
        } finally {
            writeFile(rel, before);
        }
        restoredRun = runNodeScript('scripts/verify-correction-attach-archive.js');
        const redHit = mutatedRun.status !== 0 && /V6a-done/.test(mutatedRun.out) && /uploadMedia/.test(mutatedRun.out);
        console.log(`\n[④] mutated exit=${mutatedRun.status} restored exit=${restoredRun.status}`);
        record('④', 'corrections.js done 路径 physicalPath 恒 rawPath（压缩包也当真文件发）', 'verify-correction-attach-archive.js', mutatedRun.status, redHit ? 'V6a-done uploadMedia 调用次数应 0（实得 1）' : '(未命中预期关键字，见日志)', restoredRun.status);
        fs.writeFileSync(path.join(LOG_DIR, 'c5b-round4.log'), `=== mutated ===\n${mutatedRun.out}\n=== restored ===\n${restoredRun.out}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // 活体轮 ⑤-⑧：需要载入变异后的 server.js，spawn 临时 server 到 3100
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── 进入活体轮：spawn 临时 server 到 3100（绝不碰 3000）──');

    // 对 _test-fixture.js 的 BASE 做一次性、向后兼容的 env 化改造（本阶段结束后原样恢复）
    const fxRel = 'scripts/_test-fixture.js';
    const fxBefore = readFile(fxRel);
    mutate(fxRel, "const BASE = 'http://localhost:3000';", "const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';");

    try {
        // 活体轮前置：先确认「未变异」状态下，目标套件对 3100 也能跑通（排除环境问题误判为变异有效）
        {
            const probeHandle = await startTempServer(3100);
            try {
                const probe = runNodeScript('scripts/verify-collab-attach-archive.js', { TEST_BASE_URL: 'http://localhost:3100' });
                console.log(`\n[活体前置探针] 未变异状态下 verify-collab-attach-archive.js 对 3100 → exit=${probe.status}`);
                fs.writeFileSync(path.join(LOG_DIR, 'c5b-live-baseline.log'), probe.out);
                if (probe.status !== 0) {
                    console.log('  ⚠️ 前置探针未绿——活体轮的「红」可能是环境问题而非变异生效，后续活体轮结果需人工复核。');
                }
            } finally {
                await stopTempServer(probeHandle);
            }
        }

        // ⑤ server.js issueUpload fileFilter：删掉压缩包显式拦截
        {
            const rel = 'server.js';
            const before = readFile(rel);
            const oldBlock = `        // 附件压缩包支持方案 D9：联合白名单判定之后追加压缩包显式拦截（问题跟踪录入不放开压缩包）。
        if (isArchiveExt(ext)) {
            return cb(new Error('问题跟踪录入不支持压缩包，仅允许 ' + ISSUE_EFFECTIVE_EXTS.join('/')));
        }
`;
            const newBlock = `        // [C5b 变异⑤] 显式拦截已删——压缩包会被 issueUpload 放行\n`;
            let mutatedRun;
            try {
                mutate(rel, oldBlock, newBlock);
                const handle = await startTempServer(3100);
                try {
                    mutatedRun = runNodeScript('scripts/verify-collab-attach-archive.js', { TEST_BASE_URL: 'http://localhost:3100' });
                } finally {
                    await stopTempServer(handle);
                }
            } finally {
                writeFile(rel, before);
            }
            const restoredRun = runNodeScript('scripts/verify-collab-attach-archive.js');   // 走已恢复代码的 3000（默认 BASE，不传 TEST_BASE_URL）
            const redHit = mutatedRun.status !== 0 && /V11/.test(mutatedRun.out) && /a\.zip/.test(mutatedRun.out);
            console.log(`\n[⑤] mutated(3100) exit=${mutatedRun.status} restored(3000) exit=${restoredRun.status}`);
            record('⑤', 'server.js issueUpload fileFilter 删压缩包拦截', 'verify-collab-attach-archive.js', mutatedRun.status, redHit ? 'V11 a.zip 应 400（实得 2xx 或消息不含拦截）' : '(未命中预期关键字，见日志)', restoredRun.status);
            fs.writeFileSync(path.join(LOG_DIR, 'c5b-round5.log'), `=== mutated(3100) ===\n${mutatedRun.out}\n=== restored(3000) ===\n${restoredRun.out}`);
        }

        // ⑥ server.js 代提 rename 循环：typeOrdinal: item.typeOrdinal → typeOrdinal: undefined
        {
            const rel = 'server.js';
            const before = readFile(rel);
            let mutatedRun;
            try {
                mutate(rel, 'typeOrdinal: item.typeOrdinal,', 'typeOrdinal: undefined,');
                const handle = await startTempServer(3100);
                try {
                    mutatedRun = runNodeScript('scripts/verify-collab-delivery-extra.js', { TEST_BASE_URL: 'http://localhost:3100' });
                } finally {
                    await stopTempServer(handle);
                }
            } finally {
                writeFile(rel, before);
            }
            const restoredRun = runNodeScript('scripts/verify-collab-delivery-extra.js');
            const redHit = mutatedRun.status !== 0 && /V9b|_re_0/.test(mutatedRun.out);
            console.log(`\n[⑥] mutated(3100) exit=${mutatedRun.status} restored(3000) exit=${restoredRun.status}`);
            record('⑥', 'server.js 代提 typeOrdinal 恒 undefined（多 extra 同名撞覆盖）', 'verify-collab-delivery-extra.js', mutatedRun.status, redHit ? '文件名 _re_01/_re_02 应互异（同名覆盖后无法区分/内容错乱）' : '(未命中预期关键字，见日志)', restoredRun.status);
            fs.writeFileSync(path.join(LOG_DIR, 'c5b-round6.log'), `=== mutated(3100) ===\n${mutatedRun.out}\n=== restored(3000) ===\n${restoredRun.out}`);
        }

        // ⑦ server.js doneAtSource 判据：adminHasFormalDelivery → hasAdminUpload
        {
            const rel = 'server.js';
            const before = readFile(rel);
            let mutatedRun;
            try {
                mutate(rel, 'doneAtSource = adminHasFormalDelivery ?', 'doneAtSource = hasAdminUpload ?');
                const handle = await startTempServer(3100);
                try {
                    mutatedRun = runNodeScript('scripts/verify-collab-delivery-extra.js', { TEST_BASE_URL: 'http://localhost:3100' });
                } finally {
                    await stopTempServer(handle);
                }
            } finally {
                writeFile(rel, before);
            }
            const restoredRun = runNodeScript('scripts/verify-collab-delivery-extra.js');
            const redHit = mutatedRun.status !== 0 && /V9c①|dev_last_active_attachment/.test(mutatedRun.out);
            console.log(`\n[⑦] mutated(3100) exit=${mutatedRun.status} restored(3000) exit=${restoredRun.status}`);
            record('⑦', 'server.js doneAtSource 判据退回 hasAdminUpload', 'verify-collab-delivery-extra.js', mutatedRun.status, redHit ? 'V9c① source 应 dev_last_active_attachment（实得 admin_supplemental_attachment）' : '(未命中预期关键字，见日志)', restoredRun.status);
            fs.writeFileSync(path.join(LOG_DIR, 'c5b-round7.log'), `=== mutated(3100) ===\n${mutatedRun.out}\n=== restored(3000) ===\n${restoredRun.out}`);
        }

        // ⑧ server.js 代提入库：改回 C4c 修复前形态（逐文件循环内 supersede，同批多 extra 只剩最后一个 active）
        {
            const rel = 'server.js';
            const before = readFile(rel);
            const oldBlock = `                for (const t of new Set(movedAdminFiles.map(f => f.attachment_type))) {
                    await dbRunAsync(
                        \`UPDATE collab_attachments
                            SET status='superseded', superseded_at=datetime('now','localtime')
                          WHERE collab_request_id=?
                            AND attachment_type=?
                            AND status='active'\`,
                        [id, t]
                    );
                }
                for (const mf of movedAdminFiles) {
                    // INSERT 新 admin active 行（v1.72.0 写入 attachment_seq）
                    // file_name 路径计算与 versioning §3.6 完全一致：relative(dirname(collabRoot), final_path) replace \\ → /
                    const relPath = path.relative(path.dirname(COLLAB_UPLOAD_BASE), mf.final_path).replace(/\\\\/g, '/');
                    await dbRunAsync(
                        \`INSERT INTO collab_attachments
                            (collab_request_id, attachment_type, file_name, original_name,
                             uploaded_by, uploaded_by_name, submission_version, status, superseded_at,
                             attachment_seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)\`,
                        [id, mf.attachment_type, relPath, mf.original_name,
                         userId, userName, newSubmissionVersion, mf.attachment_seq]
                    );
                }`;
            const newBlock = `                for (const mf of movedAdminFiles) {
                    // [C5b 变异⑧] 复原 C4c 修复前形态：supersede 挪回逐文件循环内（同批多 extra 只剩最后一个 active）
                    await dbRunAsync(
                        \`UPDATE collab_attachments
                            SET status='superseded', superseded_at=datetime('now','localtime')
                          WHERE collab_request_id=?
                            AND attachment_type=?
                            AND status='active'\`,
                        [id, mf.attachment_type]
                    );
                    const relPath = path.relative(path.dirname(COLLAB_UPLOAD_BASE), mf.final_path).replace(/\\\\/g, '/');
                    await dbRunAsync(
                        \`INSERT INTO collab_attachments
                            (collab_request_id, attachment_type, file_name, original_name,
                             uploaded_by, uploaded_by_name, submission_version, status, superseded_at,
                             attachment_seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)\`,
                        [id, mf.attachment_type, relPath, mf.original_name,
                         userId, userName, newSubmissionVersion, mf.attachment_seq]
                    );
                }`;
            let mutatedRun;
            try {
                mutate(rel, oldBlock, newBlock);
                const handle = await startTempServer(3100);
                try {
                    mutatedRun = runNodeScript('scripts/verify-collab-delivery-extra.js', { TEST_BASE_URL: 'http://localhost:3100' });
                } finally {
                    await stopTempServer(handle);
                }
            } finally {
                writeFile(rel, before);
            }
            const restoredRun = runNodeScript('scripts/verify-collab-delivery-extra.js');
            const redHit = mutatedRun.status !== 0 && /V9b|superseded/i.test(mutatedRun.out);
            console.log(`\n[⑧] mutated(3100) exit=${mutatedRun.status} restored(3000) exit=${restoredRun.status}`);
            record('⑧', 'server.js 代提 supersede 挪回逐文件循环内（C4c 修复前形态）', 'verify-collab-delivery-extra.js', mutatedRun.status, redHit ? 'V9b 三条 extra 应全 active（实得只剩最后一条）' : '(未命中预期关键字，见日志)', restoredRun.status);
            fs.writeFileSync(path.join(LOG_DIR, 'c5b-round8.log'), `=== mutated(3100) ===\n${mutatedRun.out}\n=== restored(3000) ===\n${restoredRun.out}`);
        }
    } finally {
        writeFile(fxRel, fxBefore);
    }

    // ── 收尾：表格 + 工作区自证 ──────────────────────────────────────
    console.log('\n\n══════ 结果表 ══════');
    console.log('轮次 | 变异 | 目标套件 | 变异态 exit | 红在哪条 | 恢复态 exit');
    for (const r of results) {
        console.log(`${r.round} | ${r.mutationLabel} | ${r.suite} | ${r.mutatedExit} | ${r.redAt} | ${r.restoredExit}`);
    }

    const finalDiff = gitDiffStat();
    const finalStatus = gitStatusShort();
    console.log('\n终态 git diff --stat：', finalDiff || '(无，工作区干净)');
    console.log('终态 git status --short：\n' + finalStatus);

    if (finalDiff) {
        console.error('\n❌ 工作区未干净（有变异残留未恢复），driver 判失败。');
        process.exit(1);
    }
    console.log('\n✅ 工作区干净（git diff --stat 为空），全部变异已恢复。');
}

main().catch((e) => {
    console.error('\n💥 驱动脚本异常:', e && e.stack || e);
    console.error('终态 git diff --stat：', gitDiffStat());
    process.exit(1);
});
