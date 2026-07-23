/**
 * verify-collab-delivery-reupload-gap.js
 *
 * 数据协作 #11：DONE 单交付物删光后「重新上传入口消失 + 完成通知死角」修复哨兵（2026-07-23）
 *
 * 用法：node scripts/verify-collab-delivery-reupload-gap.js   （自包含，无需启动 server）
 *
 * 背景（事实链）：
 *   - 后端 /submit 状态白名单本就含 DONE（server.js v1.67.1：「删→重传→重走 smoke」闭环）；
 *   - 但前端 renderDeliverySection 在 deliveryFiles.length===0 时一律 return ''，
 *     「🔄 重新上传交付物」按钮随区块消失 → 开发删光交付物后无法自助重传；
 *   - 完成通知 notify-requester-done 要求唯一 active result_data（无则 409 RESULT_DATA_MISSING），
 *     单据陷入「已完成但发不出完成通知」死角。
 *
 * 断言范围：
 *   A. 行为级（提取 renderDeliverySection 以 mock 依赖真执行）：
 *      B1 DONE+active+本人开发+空交付 → 渲染空态警示 + 重新上传按钮
 *      B2 DONE+active+非开发+空交付   → 有警示、无按钮
 *      B3 非 DONE（从未提交）+空交付   → ''（原行为回归）
 *      B4 DONE+终态(voided)+空交付    → ''（终态无重传语义，对齐 S7/S8 终态收口）
 *      B5 非空交付 → 删除按钮 onclick 传 4 参（attachment_type + dataCnt）
 *      B6 superseded 历史版本仍被过滤（active-only 回归）
 *   B. 静态（读源码断言）：
 *      S1 deleteDeliveryAttachment 签名 4 参 + isLastData 加重警示
 *      S2 dataCnt/scriptCnt 声明唯一（防上移后残留重复 const）
 *      S3 内联 <script> 语法有效（new Function 编译不执行）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++; failures.push({ name, err: e.message });
        console.log(`  ✗ ${name} — ${e.message}`);
    }
}

const htmlPath = path.join(__dirname, '..', 'public', 'Data_Collab.html');
const src = fs.readFileSync(htmlPath, 'utf8');

// 取单个具名函数体（与 verify-collab-terminal-notify.js 同款提取器）
function extractFunctionBody(source, fnName) {
    const startRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
    const m = startRe.exec(source);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
}

// ============ A. 行为级：mock 依赖真执行 renderDeliverySection ============

const rdsBody = extractFunctionBody(src, 'renderDeliverySection');
assert.ok(rdsBody, '未提取到 renderDeliverySection 函数体');

// mock 环境可变句柄
const env = { userId: 5, terminalKind: 'active' };
const render = new Function(
    'getCurrentUserId', 'collabTerminalKind', 'buildAttachmentDownloadUrl',
    'escapeHtmlAttr', 'escapeHtml', 'fmtDate',
    `return function renderDeliverySection(d) ${rdsBody};`
)(
    () => env.userId,
    () => env.terminalKind,
    () => ({ ok: true, url: '/mock-url' }),
    (s) => String(s),
    (s) => String(s),
    (s) => String(s || '')
);

const baseDone = { id: 42, status: 'DONE', developer_id: 5, archived_at: null, attachments: [] };

console.log('— A. 行为级：空态分支 —');
check('B1 DONE+active+本人开发+空交付 → 空态警示 + 重新上传按钮', () => {
    env.userId = 5; env.terminalKind = 'active';
    const html = render({ ...baseDone, attachments: [] });
    assert.ok(html.includes('当前无有效交付物'), '缺空态警示文案（codex 22 L-2 措辞）');
    assert.ok(html.includes('无法给业务方发送完成通知'), '警示未点明完成通知后果');
    assert.ok(html.includes('openSubmitDeliveryDialog(42)'), '缺重新上传按钮（openSubmitDeliveryDialog）');
    assert.ok(html.includes('重新上传交付物'), '缺按钮文案');
    assert.ok(!html.includes('请联系本单开发人员'), '开发本人不应显示"联系开发"指引');
});
check('B2 DONE+active+非开发+空交付 → 有警示+操作指引、无按钮', () => {
    env.userId = 9; env.terminalKind = 'active';
    const html = render({ ...baseDone, attachments: [] });
    assert.ok(html.includes('当前无有效交付物'), '非开发也应看到空态警示（透明）');
    assert.ok(html.includes('请联系本单开发人员重新上传'), '非开发视角缺操作指引（codex 22 L-2）');
    assert.ok(!html.includes('openSubmitDeliveryDialog'), '非本单开发不应见重新上传按钮');
});
check('B3 非 DONE（从未提交）+空交付 → 空串（原行为回归）', () => {
    env.userId = 5; env.terminalKind = 'active';
    const html = render({ ...baseDone, status: 'PENDING', attachments: [] });
    assert.strictEqual(html, '', 'PENDING 空交付应不渲染区块');
});
check('B4 DONE+终态(voided)+空交付 → 空串（终态无重传语义）', () => {
    env.userId = 5; env.terminalKind = 'voided';
    const html = render({ ...baseDone, attachments: [] });
    assert.strictEqual(html, '', '终态单空交付应不渲染区块');
});
check('B4b ARCHIVED+空交付 → 空串（codex 22 R1 组合断言）', () => {
    env.userId = 5; env.terminalKind = 'archived';
    const html = render({ ...baseDone, status: 'ARCHIVED', attachments: [] });
    assert.strictEqual(html, '', 'ARCHIVED 空交付应不渲染区块');
});

console.log('— A. 行为级：非空分支 —');
const twoFiles = [
    { id: 101, attachment_type: 'result_data', status: 'active', file_name: 'a/x.xlsx', original_name: 'x.xlsx', uploaded_by_name: '开发', created_at: '2026-07-23' },
    { id: 102, attachment_type: 'result_script', status: 'active', file_name: 'a/y.sql', original_name: 'y.sql', uploaded_by_name: '开发', created_at: '2026-07-23' },
];
check('B5 非空交付 → 删除按钮 onclick 传 4 参（attachment_type + dataCnt）', () => {
    env.userId = 5; env.terminalKind = 'active';
    const html = render({ ...baseDone, attachments: twoFiles });
    assert.ok(html.includes("deleteDeliveryAttachment(101, 42, 'result_data', 1)"), 'result_data 删除按钮未传 4 参');
    assert.ok(html.includes("deleteDeliveryAttachment(102, 42, 'result_script', 1)"), 'result_script 删除按钮未传 4 参');
    assert.ok(html.includes('openSubmitDeliveryDialog(42)'), '非空分支重新上传按钮仍在（回归）');
});
check('B6 superseded 历史版本仍被过滤（active-only 回归）', () => {
    env.userId = 5; env.terminalKind = 'active';
    const html = render({
        ...baseDone,
        attachments: [{ id: 99, attachment_type: 'result_data', status: 'superseded', file_name: 'a/old.xlsx', original_name: 'old.xlsx' }],
    });
    // 仅 superseded → active 过滤后为空 → 走空态分支（DONE+active → 渲染空态而非旧文件）
    assert.ok(!html.includes('old.xlsx'), 'superseded 附件不应展示');
    assert.ok(html.includes('当前无有效交付物'), 'active 全无时应走空态分支');
});
check('B6b status=null 旧数据兼容（codex 22 R3：NULL 视为 active 展示）', () => {
    env.userId = 5; env.terminalKind = 'active';
    const html = render({
        ...baseDone,
        attachments: [{ id: 88, attachment_type: 'result_data', status: null, file_name: 'a/legacy.xlsx', original_name: 'legacy.xlsx', uploaded_by_name: '开发', created_at: '2026-07-01' }],
    });
    assert.ok(html.includes('legacy.xlsx'), 'status=null 旧附件应视为 active 展示（与后端 IS NULL 兼容同源）');
    assert.ok(!html.includes('当前无有效交付物'), '有 null-status 附件时不应走空态分支');
});

console.log('— A. 行为级：删除警示分级（codex 22 R2）—');
// 提取 deleteDeliveryAttachment 以 mock confirm 真执行（confirm 返回 false 提前退出，不触 authFetch）
const delBody = extractFunctionBody(src, 'deleteDeliveryAttachment');
assert.ok(delBody, '未提取到 deleteDeliveryAttachment 函数体');
function capturedConfirmMsg(attType, cnt) {
    let captured = null;
    const del = new Function(
        'confirm', 'authFetch', 'showToast', 'openDetail',
        `return async function deleteDeliveryAttachment(attId, collabId, attType, activeDataCnt) ${delBody};`
    )((m) => { captured = m; return false; }, () => { throw new Error('confirm=false 不应触达 authFetch'); }, () => {}, () => {});
    del(101, 42, attType, cnt);
    return captured;
}
check('B7 删最后一个 result_data（cnt=1）→ 加重警示', () => {
    const msg = capturedConfirmMsg('result_data', 1);
    assert.ok(msg && msg.includes('无法给业务方发送完成通知'), '最后一个数据文件应触发加重警示');
});
check('B7b 非最后一个 result_data（cnt=2）→ 普通文案', () => {
    const msg = capturedConfirmMsg('result_data', 2);
    assert.ok(msg && msg.includes('确定删除此交付物'), 'cnt=2 应走普通确认文案');
    assert.ok(!msg.includes('无法给业务方发送完成通知'), 'cnt=2 不应加重警示');
});
check('B7c result_script（cnt=1）→ 普通文案', () => {
    const msg = capturedConfirmMsg('result_script', 1);
    assert.ok(msg && msg.includes('确定删除此交付物'), 'script 删除应走普通确认文案');
});
check('B7d 参数缺省（undefined）→ 普通文案（fail-safe 回归）', () => {
    const msg = capturedConfirmMsg(undefined, undefined);
    assert.ok(msg && msg.includes('确定删除此交付物'), '参数缺省应 fail-safe 走普通文案');
});

// ============ B. 静态断言 ============

console.log('— B. 静态：删除警示 + 声明唯一性 + 语法 —');
check('S1 deleteDeliveryAttachment 签名 4 参 + isLastData 加重警示', () => {
    const body = extractFunctionBody(src, 'deleteDeliveryAttachment');
    assert.ok(body, '函数缺失');
    assert.ok(/function\s+deleteDeliveryAttachment\s*\(attId,\s*collabId,\s*attType,\s*activeDataCnt\)/.test(src), '签名非 4 参');
    assert.ok(body.includes("attType === 'result_data'"), '缺 result_data 类型判断');
    assert.ok(body.includes('Number(activeDataCnt) === 1'), '缺最后一个数据文件判断');
    assert.ok(body.includes('无法给业务方发送完成通知'), '加重警示未点明完成通知后果');
    assert.ok(body.includes('确定删除此交付物'), '普通删除确认文案丢失（回归）');
});
check('S2 renderDeliverySection 内 dataCnt/scriptCnt 各声明一次（防上移后残留重复 const）', () => {
    const dataDecls = (rdsBody.match(/const dataCnt =/g) || []).length;
    const scriptDecls = (rdsBody.match(/const scriptCnt =/g) || []).length;
    assert.strictEqual(dataDecls, 1, `dataCnt 声明 ${dataDecls} 次（应 1 次）`);
    assert.strictEqual(scriptDecls, 1, `scriptCnt 声明 ${scriptDecls} 次（应 1 次）`);
});
check('S3 空态分支保留终态门（DONE + collabTerminalKind active 双判）', () => {
    assert.ok(rdsBody.includes("d.status !== 'DONE' || collabTerminalKind(d) !== 'active'"), '空态分支缺终态门');
});
check('S4 内联 <script> 语法有效（new Function 编译不执行）', () => {
    const scripts = [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, '未找到内联 script');
    for (const s of scripts) new Function(s); // 语法错误会 throw
});

console.log(`\n=== verify-collab-delivery-reupload-gap: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
    failures.forEach(f => console.error(`FAIL: ${f.name} — ${f.err}`));
    process.exit(1);
}
