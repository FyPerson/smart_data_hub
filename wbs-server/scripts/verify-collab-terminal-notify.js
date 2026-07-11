/**
 * verify-collab-terminal-notify.js
 *
 * 数据协作·终态通知记录展示（通知归档态统一 C1，2026-07-12）逻辑漂移哨兵
 *
 * 用法：node scripts/verify-collab-terminal-notify.js   （自包含，无需启动 server）
 *
 * 本脚本是纯前端改动的"读源码断言"哨兵（非运行时行为验证——运行时行为由
 * test-collab-terminal-notify-playwright.js 的浏览器实测覆盖）。断言范围：
 *   1. collabTerminalKind 终态分类 helper 存在且优先级正确（archived 优先于 voided）
 *   2. 5 类通知函数各自的终态/hygiene 关键改动仍在（防有人误删/误改）
 *   3. 活跃分支关键串仍在（防误删——铁律①"活跃态行为一字不改"的兜底哨兵）
 *   4. §6 sweep 的 2 处最小修复（renderInsufficientEvidenceSection / renderAdminDirectActionsSection）仍在
 *   5. Data_Collab.html 内联 <script> 语法有效（new Function 编译不执行，等价 node -c）
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

// 取单个具名函数体（从 `function name(...) {` 到与之匹配的右括号），用于分函数断言，避免跨函数误判
function extractFunctionBody(source, fnName) {
    const startRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
    const m = startRe.exec(source);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1; // 指向开头的 '{'
    const start = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null; // 未闭合（理论不会）
}

console.log('— §0/§2：collabTerminalKind helper —');
check('collabTerminalKind 函数存在', () => {
    assert.ok(src.includes('function collabTerminalKind(d)'), '缺 collabTerminalKind 定义');
});
check('collabTerminalKind：archived 优先于 voided（status===ARCHIVED 先判）', () => {
    const body = extractFunctionBody(src, 'collabTerminalKind');
    assert.ok(body, '未提取到函数体');
    const iArchived = body.indexOf("d.status === 'ARCHIVED'");
    const iVoided = body.indexOf('d.archived_at');
    assert.ok(iArchived >= 0 && iVoided >= 0, '缺 archived/voided 判据');
    assert.ok(iArchived < iVoided, 'archived 判据应先于 voided 判据');
});

console.log('— §5.A：contact/dev hygiene（活跃分支不变 + 新增 hygiene）—');
check('renderContactNotifySubsection 存在 + hasSafeId hygiene + message_key 查询前提', () => {
    const body = extractFunctionBody(src, 'renderContactNotifySubsection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes('hasSafeId'), '缺 safeId 校验');
    assert.ok(body.includes('d.contact_notify_message_key'), '缺 message_key 查询前提门');
    // §7 sweep：canTrigger 必须含 !isTerminal（voided-at-PENDING_ASSIGN 单收口通知/重新通知按钮，防未来回退）
    assert.ok(/const canTrigger = isPendingAssign && isAdminUser && !isTerminal;/.test(body),
        'contact canTrigger 未含 !isTerminal 门');
    // 活跃分支关键串防误删
    assert.ok(body.includes("status === 'PENDING_ASSIGN'"), '活跃分支 isPendingAssign 判据丢失');
    assert.ok(body.includes('triggerNotify('), '活跃分支 triggerNotify 调用丢失');
});
check('renderDeveloperNotifySubsection 存在 + hasSafeId hygiene + message_key 查询前提 + §7 !isTerminal', () => {
    const body = extractFunctionBody(src, 'renderDeveloperNotifySubsection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes('hasSafeId'), '缺 safeId 校验');
    assert.ok(body.includes('d.notify_message_key'), '缺 message_key 查询前提门');
    // §7 sweep：canTrigger 必须含 !isTerminal（voided-at-PENDING 单收口通知/重新通知按钮）
    assert.ok(/const canTrigger = isPending && \(isAdminUser \|\| isContactPersonView\) && !isTerminal;/.test(body),
        'developer canTrigger 未含 !isTerminal 门');
    assert.ok(body.includes("status === 'PENDING'"), '活跃分支 isPending 判据丢失');
    assert.ok(body.includes('triggerNotify('), '活跃分支 triggerNotify 调用丢失');
});

console.log('— §5.B：业务方·完成通知（DONE 活跃分支保留 + 终态分支新增）—');
check('renderRequesterDoneNotifySection：DONE 分支 + 终态分支 + 降级矩阵字段全在', () => {
    const body = extractFunctionBody(src, 'renderRequesterDoneNotifySection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes("d.status === 'DONE'"), 'DONE 活跃分支判据丢失');
    assert.ok(body.includes('notifyRequesterDone('), '活跃分支发送/重发按钮丢失（notifyRequesterDone）');
    assert.ok(body.includes("collabTerminalKind(d) !== 'active'"), '终态分支判据丢失');
    assert.ok(body.includes('done_notified_at') && body.includes('done_read_at') && body.includes('done_notify_message_key'),
        '终态记录降级矩阵字段（done_notified_at/done_read_at/done_notify_message_key）不全');
    // 终态分支不应含发送/重发按钮
    const terminalPart = body.slice(body.indexOf("collabTerminalKind(d) !== 'active'"));
    assert.ok(!terminalPart.includes('notifyRequesterDone('), '终态分支不应含 notifyRequesterDone 发送按钮');
});

console.log('— §5.C：导出人通知（转发圈判据 + 终态记录，禁用 canForwardToExporter 判可见性）—');
check('renderExporterNotifySubsection：inFwdCircle 判据 + 未误用 canForwardToExporter 做终态可见性', () => {
    const body = extractFunctionBody(src, 'renderExporterNotifySubsection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes('inFwdCircle'), '缺解耦 status 的 forward 圈判据 inFwdCircle');
    assert.ok(body.includes('forwarded_to_exporter_at'), '缺转交事实源字段 forwarded_to_exporter_at');
    assert.ok(body.includes("collabTerminalKind(d) !== 'active'"), '终态分支判据丢失');
    // 终态分支应在 inFwdCircle 判定之前不依赖 canForwardToExporter（该 helper 内含 status==='PENDING' 门，终态必返 false）
    const terminalPart = body.slice(0, body.indexOf('PENDING_ASSIGN 不显示'));
    assert.ok(!terminalPart.includes('canForwardToExporter('), '终态分支误用了 canForwardToExporter 判可见性（会把记录藏掉）');
    // 活跃分支关键串防误删
    assert.ok(body.includes('openForwardToExporterDialog('), '活跃分支转发按钮丢失');
    assert.ok(body.includes('openExportUploadDialog(') && body.includes('openReturnToDevDialog('), 'EXPORTING 活跃分支提交/退回按钮丢失');
});

console.log('— §5.D：需求方·预计完成（PENDING 活跃分支保留 + 终态分支新增）—');
check('renderExpectedEstimateSection：PENDING 分支 + 终态分支 + 8 态降级矩阵齐全', () => {
    const body = extractFunctionBody(src, 'renderExpectedEstimateSection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes("d.status === 'PENDING'"), 'PENDING 活跃分支判据丢失');
    assert.ok(body.includes('openEstimateModal(') && body.includes('notifyExpected('), '活跃分支回填/通知按钮丢失');
    assert.ok(body.includes("collabTerminalKind(d) !== 'active'"), '终态分支判据丢失');
    assert.ok(body.includes('if (!d.dev_estimated_at) return'), '终态适用性判据（无预计值不渲染）丢失');
    for (const st of ["st === 'sent'", "st === 'failed'", "st === 'no_phone'", "st === 'not_sent'"]) {
        assert.ok(body.includes(st), `终态降级矩阵缺状态分支 ${st}`);
    }
    // 终态分支不应含开发回填/建单人通知的写按钮
    const terminalPart = body.slice(body.indexOf("collabTerminalKind(d) !== 'active'"));
    assert.ok(!terminalPart.includes('openEstimateModal(') && !terminalPart.includes('notifyExpected('),
        '终态分支不应含回填/通知写按钮');
});

console.log('— §6 sweep：两处最小修复仍在 —');
check('renderInsufficientEvidenceSection：isTerminal 收口删除按钮', () => {
    const body = extractFunctionBody(src, 'renderInsufficientEvidenceSection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes('isTerminal'), '缺 isTerminal 判据');
    assert.ok(/isAdminUser && !isTerminal/.test(body), '删除按钮未同时收口 isAdminUser && !isTerminal');
});
check('renderAdminDirectActionsSection：isTerminal 收口 3 个写按钮', () => {
    const body = extractFunctionBody(src, 'renderAdminDirectActionsSection');
    assert.ok(body, '函数缺失');
    assert.ok(body.includes('isTerminal'), '缺 isTerminal 判据');
    assert.ok(/status === 'EXPORTING' && !isTerminal/.test(body), 'actionButtons 未同时收口 status===EXPORTING && !isTerminal');
    // exporterLine（只读记录）+ 改派历史折叠不应被这次改动动到（保留区块+记录，只隐藏写按钮）
    assert.ok(body.includes('exporterLine') && body.includes('reassignHistoryDetails'), '只读记录/改派历史区块不应被移除');
});

console.log('— §7 sweep 补：renderValidationSection 逐按钮 !isTerminal —');
check('renderValidationSection：4 类写按钮均含 !isTerminal 门 + val-box 记录保留', () => {
    const body = extractFunctionBody(src, 'renderValidationSection');
    assert.ok(body, '函数缺失');
    assert.ok(/const isTerminal = collabTerminalKind\(d\) !== 'active';/.test(body), '缺 isTerminal 定义');
    // 4 类写按钮的入口 dialog（终态下应被 isTerminal ? '' : `...` 包裹）——断言按钮字符串仍在源码里（记录+按钮结构未删）
    for (const dlg of ['openAssignDialog(${d.id})', 'openSubmitDeliveryDialog(', 'openAssignDialog(${d.id}, true)', 'openRetryDialog(', 'openBypassDialog(']) {
        assert.ok(body.includes(dlg), `写按钮入口丢失: ${dlg}`);
    }
    // 三个 val-actions 块必须被 `isTerminal ? '' :` 三元包裹（防有人退回成无条件渲染）
    const guardedActionsBlocks = (body.match(/\$\{isTerminal \? '' : `<div class="val-actions"/g) || []).length;
    assert.strictEqual(guardedActionsBlocks, 3, `val-actions 三元收口应 3 处（指派/上传/改派），实测 ${guardedActionsBlocks}`);
    // failed 分支两个按钮各绑 !isTerminal
    assert.ok(/isDeveloper && !isTerminal/.test(body), 'failed 重新上传按钮未含 isDeveloper && !isTerminal');
    assert.ok(/isAdminUser && !isTerminal/.test(body), 'failed 旁路放行按钮未含 isAdminUser && !isTerminal');
    // 只读记录框（bypass/passed/admin_closed/running）不应被误加 isTerminal 门
    assert.ok(body.includes('val-passed-bg') && body.includes('val-bypassed-bg') && body.includes('val-failed-bg'),
        '只读记录 val-box 不应被移除');
});

console.log('— codex MED-1/2 收口：delivery 终态门 + developerBlock 装配放行终态 EXPORTING —');
check('renderDeliverySection：canModifyDelivery 含 collabTerminalKind(d) === \'active\'（voided-at-DONE 隐藏删/重传）', () => {
    const body = extractFunctionBody(src, 'renderDeliverySection');
    assert.ok(body, '函数缺失');
    assert.ok(/const canModifyDelivery = isCurrentDeveloper && d\.status === 'DONE' && collabTerminalKind\(d\) === 'active';/.test(body),
        'canModifyDelivery 未含终态门 collabTerminalKind(d) === active');
    // 交付文件列表（下载链接）不受影响：delivery-link 仍无条件渲染
    assert.ok(body.includes('delivery-link'), '交付文件下载链接不应被移除');
});
check('developerBlock 装配条件放行"终态 EXPORTING"（防终态 EXPORTING 开发通知记录漏掉）', () => {
    // 装配层在 renderDetail 内联，跨函数——直接对全文断言组合子句
    assert.ok(/collabTerminalKind\(d\) !== 'active' && status === 'EXPORTING'/.test(src),
        'developerBlock 装配未含"终态 EXPORTING"放行子句');
    // 仍保留原白名单（PENDING/SUBMITTED/DONE/ARCHIVED）——防有人改写把活跃 EXPORTING 也无条件放进来
    assert.ok(/status === 'PENDING' \|\| status === 'SUBMITTED' \|\| status === 'DONE' \|\| status === 'ARCHIVED'/.test(src),
        'developerBlock 原白名单丢失');
});

console.log('— 装配点：5 个通知子区调用仍在（防止函数写了但没接线）—');
check('renderDetail 装配点仍调用全部 5 个 render*Notify* / render*Estimate*', () => {
    for (const fn of [
        'renderContactNotifySubsection(d, status, isAdminUser)',
        'renderExporterNotifySubsection(d, status, isAdminUser, myUid)',
        'renderRequesterDoneNotifySection(d, isAdminUser, myUid)',
        'renderExpectedEstimateSection(d, isAdminUser, myUid)',
    ]) {
        assert.ok(src.includes(fn), `装配点缺调用: ${fn}`);
    }
});

console.log('— Data_Collab.html 内联 <script> 语法有效性（等价 node -c）—');
check('内联 <script> 可被 new Function 编译（无语法错误）', () => {
    const matches = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(matches.length >= 1, '未找到内联 <script> 块');
    for (const m of matches) {
        new Function(m[1]); // 仅编译不执行；语法错误会在此抛出
    }
});

console.log(`\n=== verify-collab-terminal-notify: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
    for (const f of failures) console.log(`   ✗ ${f.name}: ${f.err}`);
    process.exit(1);
}
