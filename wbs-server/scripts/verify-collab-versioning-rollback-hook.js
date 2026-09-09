// verify-collab-versioning-rollback-hook.js — 附件压缩包支持方案 C4（V10 回滚场景）
//   直接 require utils/collab-attachment-versioning.js 的 activateNewVersion（纯函数级 in-process 测试，
//   不依赖 HTTP/live server——collab 模块虽整体嵌在单体 server.js 里，但 activateNewVersion 是独立可
//   require 的纯 utils 函数，可以脱离 server.js 直接测试）。
//
//   覆盖 §5 V10 的「回滚」子场景：首个 rename 成功后，测试注入的 __afterFirstRenameHook
//   先断言「首目标文件已物理落盘（existsSync 为真）+ collab_attachments 尚无本版本记录」，
//   再主动 throw 触发 activateNewVersion §3.4 既有回滚路径（把已 rename 的文件挪回 source_path）。
//   验收：抛出的错误透传给调用方 + 新记录零条（未曾 INSERT，因为异常发生在 DB 事务阶段之前）+
//   已搬首文件已撤销（原路径复原、目标路径消失）+ 旧三类附件仍 active（未被触碰，同样因为异常发生在
//   §3.6 supersede UPDATE 之前）。
//
//   ⚠️ 与 scripts/verify-collab-delivery-extra.js（依赖 localhost:3000 活体 server）的关系：V10 的
//   「正常重传→旧 superseded/新 active」部分在那边用真实 HTTP /submit 覆盖；本文件只覆盖"回滚"这一半，
//   因为 __afterFirstRenameHook 是 activateNewVersion() 的 JS 级调用参数，外部 HTTP 请求无法从进程外注入
//   到已经在跑的 server.js 进程里——这是两个脚本职责必须拆开的根本原因，不是重复覆盖。
//
// 用法：node scripts/verify-collab-versioning-rollback-hook.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const collabVersioning = require('../utils/collab-attachment-versioning');

const db = new sqlite3.Database(':memory:');
const runAsync = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
const getAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const allAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function main() {
    // 最小 schema（只含 activateNewVersion 实际读写的列，非完整生产 DDL——本文件是纯函数级测试）
    await runAsync(`CREATE TABLE collab_requests (
        id INTEGER PRIMARY KEY, submission_version INTEGER DEFAULT 0, sql_validation_status TEXT,
        sql_validated_at DATETIME, status TEXT, done_at DATETIME, attachment_dir TEXT
    )`);
    await runAsync(`CREATE TABLE collab_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, collab_request_id INTEGER, attachment_type TEXT,
        file_name TEXT, original_name TEXT, uploaded_by INTEGER, uploaded_by_name TEXT,
        submission_version INTEGER, status TEXT, superseded_at DATETIME, created_at DATETIME DEFAULT (datetime('now'))
    )`);

    const requestId = 1;
    const oldVer = 1;
    await runAsync(`INSERT INTO collab_requests (id, submission_version, status) VALUES (?, ?, 'DONE')`, [requestId, oldVer]);
    // 旧三类 active 附件（模拟 DONE 单已有一版交付物 + 一份补充材料压缩包）
    const oldIds = {};
    for (const t of ['result_data', 'result_script', 'result_extra']) {
        const r = await runAsync(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status, superseded_at)
             VALUES (?,?,?,?,?,?,?,'active',NULL)`,
            [requestId, t, `collab/1_test/old_${t}.dat`, `old_${t}.dat`, 1, '管理员', oldVer]
        );
        oldIds[t] = r.lastID;
    }

    // 落盘环境：collabRoot/_pending/{requestId}/ 放三个待激活的新版本文件
    const collabRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-rollback-hook-'));
    const pendingDir = path.join(collabRoot, '_pending', String(requestId));
    fs.mkdirSync(pendingDir, { recursive: true });
    const srcData = path.join(pendingDir, 'new_data.xlsx');
    const srcScript = path.join(pendingDir, 'new_script.sql');
    const srcExtra = path.join(pendingDir, 'new_extra.zip');
    fs.writeFileSync(srcData, 'xlsx-content');
    fs.writeFileSync(srcScript, 'SELECT 1');
    fs.writeFileSync(srcExtra, 'PK\x03\x04');

    // uploadedFiles 顺序 = 上传序：data 排第一个，故它是"首个 rename"的对象（钩子挂在它身上）
    const uploadedFiles = [
        { attachment_type: 'result_data', source_path: srcData, original_name: 'new_data.xlsx', uploaded_by: 5, uploaded_by_name: '开发五' },
        { attachment_type: 'result_script', source_path: srcScript, original_name: 'new_script.sql', uploaded_by: 5, uploaded_by_name: '开发五' },
        { attachment_type: 'result_extra', source_path: srcExtra, original_name: 'new_extra.zip', uploaded_by: 5, uploaded_by_name: '开发五' },
    ];

    let hookCalled = false;
    let hookAssertionsOk = false;
    let hookSub = null;   // L3：各子断言结果，失败时打印定位
    let capturedFinalPath = null;
    const hook = async ({ finalPath, requestId: hookReqId, newVer, attachmentType }) => {
        hookCalled = true;
        capturedFinalPath = finalPath;
        // 断言①：首目标文件已物理落盘
        const existsOk = fs.existsSync(finalPath);
        // 断言②：collab_attachments 尚无本版本（newVer）记录
        const row = await getAsync('SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=? AND submission_version=?', [hookReqId, newVer]);
        const noRecordYet = row && row.c === 0;
        // Opus 预筛 C4 L3：拆成独立可定位的子断言，红了能看出哪条失效；noRecordYet 是「INSERT 天然在 rename 循环之后」的事务边界回归哨兵，非本用例主判据
        hookSub = { existsOk, noRecordYet, typeOk: attachmentType === 'result_data', reqOk: hookReqId === requestId, verOk: newVer === oldVer + 1 };
        hookAssertionsOk = Object.values(hookSub).every(Boolean);
        // 断言通过后主动抛错，触发 activateNewVersion §3.4 既有回滚路径
        throw new Error('INJECTED_ROLLBACK_FOR_V10_TEST');
    };

    let caughtErr = null;
    try {
        await collabVersioning.activateNewVersion({
            db, dbAsync: { runAsync, getAsync, allAsync },
            requestId, oldVer, collabRoot,
            description: 'V10 回滚测试', attachmentDir: null,
            oaRequestNo: 'OA-ROLLBACK-TEST', collabCreatedAt: '2026-09-09 10:00:00',
            uploadedFiles,
            runSmokeTest: async () => { throw new Error('不应到达 smoke test 阶段（钩子应在此之前已 throw）'); },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            __afterFirstRenameHook: hook,
        });
    } catch (e) {
        caughtErr = e;
    }

    assert.ok(hookCalled, '__afterFirstRenameHook 确实被调用（实现坏成什么样它会红：钩子挂点被删/挪位 → hookCalled 恒 false）');
    assert.ok(hookAssertionsOk, '钩子内部断言（首文件已落盘 + 无本版本 DB 记录 + 正确的 requestId/newVer/attachmentType）全部成立' + ' 子断言=' + JSON.stringify(hookSub));
    assert.ok(caughtErr && caughtErr.message === 'INJECTED_ROLLBACK_FOR_V10_TEST', `钩子抛出的错误应透传给调用方，实际：${caughtErr && caughtErr.message}`);
    ok('__afterFirstRenameHook 挂点存在 + 内部断言成立 + 异常透传（实现坏成什么样它会红：钩子未被调用 / 断言条件不成立 / 异常被吞）');

    // 新记录零条（异常发生在 §3.6 DB 事务之前，从未 INSERT）
    const newVerRows = await allAsync('SELECT * FROM collab_attachments WHERE collab_request_id=? AND submission_version=?', [requestId, oldVer + 1]);
    assert.strictEqual(newVerRows.length, 0, `新版本记录应为零条，实际 ${newVerRows.length} 条`);
    ok('新记录零条（实现坏成什么样它会红：若异常处理误把 DB 事务提前到 rename 循环之前，或钩子异常未被正确捕获，这里会有残留行）');

    // 已搬首文件已撤销：目标路径消失，原 pending 路径复原
    assert.ok(capturedFinalPath && !fs.existsSync(capturedFinalPath), `首文件目标路径应已撤销（不存在），实际 existsSync=${fs.existsSync(capturedFinalPath)}`);
    assert.ok(fs.existsSync(srcData), `首文件应已挪回原 pending 路径 ${srcData}`);
    // 第二、三个文件从未被 rename（钩子在第一个之后立即抛错，循环未继续）
    assert.ok(fs.existsSync(srcScript) && fs.existsSync(srcExtra), '第二/三个文件原路径仍在（从未进入 rename，循环在第一个之后即中断）');
    ok('已搬首文件的物理回滚生效（目标路径消失 + 原路径复原），后续文件从未被搬动');

    // 旧三类仍 active（未被触碰——异常发生在 supersede UPDATE 之前）
    for (const t of ['result_data', 'result_script', 'result_extra']) {
        const row = await getAsync('SELECT status FROM collab_attachments WHERE id=?', [oldIds[t]]);
        assert.strictEqual(row.status, 'active', `旧 ${t}（id=${oldIds[t]}）应仍 active，实际 ${row.status}`);
    }
    ok('旧三类（result_data/result_script/result_extra）附件仍 active，未被误 supersede（实现坏成什么样它会红：若 supersede UPDATE 被误移到 rename 循环之前，这里会变 superseded）');

    fs.rmSync(collabRoot, { recursive: true, force: true });
    console.log(`\n✅ verify-collab-versioning-rollback-hook 全部通过（${passed} 项断言）`);
}

main().catch((e) => {
    console.error('❌ verify-collab-versioning-rollback-hook 失败:', e && e.stack || e);
    process.exit(1);
});
