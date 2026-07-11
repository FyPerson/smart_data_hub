/**
 * verify-issue-terminal-notify.js
 *
 * 需求跟踪模块「终态通知记录展示」不变量固化（通知归档态统一 C2·2026-07-12）
 *
 * 用法：node scripts/verify-issue-terminal-notify.js（自包含，无需 server）
 *
 * 背景：C1 改的是数据协作。需求跟踪模块（Issue_Tracker.html）经直读复核，通知记录面本就合规：
 *   - 已读跟踪展示块 gated = isManager && notify_status==='sent'（开发侧）/ requester_notify_status==='sent'
 *     （业务方侧），无 status 条件 → 终态（已拒绝/已关闭）若曾 sent 仍显已读记录（只读·查已读按钮触发后端）。
 *   - canNotifyDeveloper 门 = status ∈ {待处理,处理中,待验证} → 终态自动隐藏"通知开发"。
 *   - canNotifyRequesterDone 门 = status==='已关闭'（可变更完成态·完成通知在此态是正当动作，
 *     类比数据协作 DONE 的 requester_done；'已拒绝' 等不可逆终态自动为 false）。
 *   故本模块通知面零代码改动。
 *
 * ⚠️ 已知 backlog（本哨兵【不】断言、交用户定夺，非本次修复范围）：
 *   - canNotifyReassign 仅 !!pending_reassign_to_id、无 status/终态门 → 终态若残留未结改派，"通知改派"
 *     按钮理论上仍显（窄泄漏·后端为真闸门·pre-existing）。
 *   - 操作栏 指派/编辑/删除 管理按钮对 isManager 不分状态显示（既有 CRUD 管理设计·后端兜底·非通知面）。
 *   这两项属"需求模块操作栏是否收终态写动作"的独立议题，超出"通知归档态可见性统一"通知面范围。
 *
 * 本哨兵 = 漂移哨兵：断言上述"合规通知面"逻辑仍在，防回退。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'Issue_Tracker.html');
const src = fs.readFileSync(FILE, 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}`); }
}
function has(re) { return re.test(src); }

console.log('— 需求跟踪·终态通知不变量 —');

// 已读跟踪展示：isManager 门 + notify_status/requester_notify_status==='sent'（无 status 条件·终态可见）
check("已读展示块含 isManager 门", has(/if\s*\(\s*isManager\s*\)/));
check("开发侧已读展示门 = notify_status === 'sent'（无 status 条件·终态可见）",
    has(/issue\.notify_status\s*===\s*'sent'/));
check("业务方侧已读展示门 = requester_notify_status === 'sent'",
    has(/issue\.requester_notify_status\s*===\s*'sent'/));
check("查已读入口 checkIssueReadStatus 仍在（终态只读查询保留）",
    has(/checkIssueReadStatus\(/));

// 通知开发按钮：终态自动隐藏（status 白名单不含终态）
check('canNotifyDeveloper 存在', has(/function\s+canNotifyDeveloper\s*\(/));
check("canNotifyDeveloper 门含 status ∈ {待处理,处理中,待验证}（终态自动隐藏通知开发）",
    has(/\['待处理',\s*'处理中',\s*'待验证'\]\.includes\(issue\.status\)/));

// 通知业务方完成按钮：仅 '已关闭'（可变更完成态·正当；不可逆终态'已拒绝'自动 false）
check('canNotifyRequesterDone 存在', has(/function\s+canNotifyRequesterDone\s*\(/));
check("canNotifyRequesterDone 门 = status==='已关闭'（可变更完成态·完成通知正当）",
    has(/issue\.status\s*===\s*'已关闭'/));

// 状态机：已拒绝=不可逆终态（无流转）；已关闭=可变更完成态（可转处理中·重开）
check("状态机 '已拒绝': [] （不可逆终态·无流转按钮）", has(/'已拒绝':\s*\[\s*\]/));
check("状态机 '已关闭': ['处理中'] （可变更完成态·可重开）", has(/'已关闭':\s*\['处理中'\]/));

// 强化（codex 末次审 LOW）：提取"已读跟踪展示块"区域，断言其 gating【不含 issue.status 条件】。
//   该块只应 gated on isManager + notify_status/requester_notify_status==='sent'（无 status 条件·终态可见）。
//   若有人加 `&& issue.status !== '已拒绝'` 之类终态门（会让终态已读记录消失），必然引入 issue.status → 本断言失败。
//   区域 = 从"已读跟踪展示"注释到"钉钉拉群讨论"注释之间（读块本体 862-882 内不引用 issue.status）。
const readBlockStart = src.indexOf('已读跟踪展示');
const readBlockEnd = src.indexOf('钉钉拉群讨论', readBlockStart);
const readBlock = (readBlockStart >= 0 && readBlockEnd > readBlockStart) ? src.slice(readBlockStart, readBlockEnd) : '';
check('提取到"已读跟踪展示"块区域', readBlock.length > 100 && readBlock.length < 4000);
check('已读展示块 gating 内无 issue.status 条件（终态仍显已读记录·堵哨兵假绿）',
    readBlock.length > 0 && !/issue\.status/.test(readBlock));

console.log('');
console.log(`=== verify-issue-terminal-notify: ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
