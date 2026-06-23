// verify-collab-unreplied-timeout.js
// 阶段2 盯效率 A1「对接人指派开发超时未回填预计完成时间」判定逻辑验证
//   ① 复刻 Data_Collab.html 的 unrepliedTimeoutLevel 逻辑 + 边界用例（now 参数化便于断言）
//   ② 漂移哨兵：读 Data_Collab.html 断言关键代码片段在，防"复刻测试与前端源脱节"
// 运行：node wbs-server/scripts/verify-collab-unreplied-timeout.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; }
}

// ===== ① 复刻前端逻辑（Date.now() → 参数化 nowMs）=====
function parseCollabLocalTime(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
        const y = +m[1], mo = +m[2], da = +m[3], h = +m[4], mi = +m[5], se = +(m[6] || 0);
        const dt = new Date(y, mo - 1, da, h, mi, se);
        return (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da && dt.getHours() === h && dt.getMinutes() === mi) ? dt : null;
    }
    const d = new Date(s); return isNaN(d.getTime()) ? null : d;
}
function unrepliedTimeoutLevel(r, nowMs) {
    if (!r || r.assign_mode !== 'normal' || r.status !== 'PENDING' || r.dev_estimated_at) return null;
    const assigned = parseCollabLocalTime(r.assigned_at);
    if (!assigned) return null;
    const now = (typeof nowMs === 'number') ? nowMs : Date.now();
    if (assigned.getHours() < 16) {
        const mins = (now - assigned.getTime()) / 60000;
        return mins > 60 ? 'red' : mins > 30 ? 'orange' : null;
    }
    const y = assigned.getFullYear(), mo = assigned.getMonth(), da = assigned.getDate();
    const next10 = new Date(y, mo, da + 1, 10, 0, 0).getTime();
    const next12 = new Date(y, mo, da + 1, 12, 0, 0).getTime();
    return now >= next12 ? 'red' : now >= next10 ? 'orange' : null;
}
const ms = s => parseCollabLocalTime(s).getTime();
const base = { assign_mode: 'normal', status: 'PENDING', dev_estimated_at: null };
const R = (assigned_at, over) => Object.assign({}, base, { assigned_at }, over || {});

console.log('① 判定逻辑边界用例：');
// --- 16 点前指派：相对计时 30/60 分钟 ---
check('16前 20min ≤30 → 不标', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00'), ms('2026-06-23 10:20')), null));
check('16前 恰30min → 不标（>30 严格）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00'), ms('2026-06-23 10:30')), null));
check('16前 31min → 橙', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00'), ms('2026-06-23 10:31')), 'orange'));
check('16前 恰60min → 橙（>60 严格）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00'), ms('2026-06-23 11:00')), 'orange'));
check('16前 61min → 红', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00'), ms('2026-06-23 11:01')), 'red'));
check('边界 15:59 走相对（41min 橙）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 15:59'), ms('2026-06-23 16:40')), 'orange'));
// --- 16 点后指派：次日 10:00/12:00 绝对点 ---
check('边界 16:00整 走次日（次日09:00 <10 不标）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 16:00'), ms('2026-06-24 09:00')), null));
check('16后 次日恰10:00 → 橙', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 17:00'), ms('2026-06-24 10:00')), 'orange'));
check('16后 次日11:30 → 橙', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 17:00'), ms('2026-06-24 11:30')), 'orange'));
check('16后 次日恰12:00 → 红', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 17:00'), ms('2026-06-24 12:00')), 'red'));
check('16后(23:30) 次日13:00 → 红', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 23:30'), ms('2026-06-24 13:00')), 'red'));
check('16后 次日09:59 → 不标', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 18:00'), ms('2026-06-24 09:59')), null));
// --- 跨月边界（da+1 自动进位）---
check('跨月 6/30 18点 → 7/1 10:30 橙', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-30 18:00'), ms('2026-07-01 10:30')), 'orange'));
// --- 范围排除 ---
check('admin 直派 → 排除', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00', { assign_mode: 'admin_direct' }), ms('2026-06-23 12:00')), null));
check('非 PENDING → 排除', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00', { status: 'SUBMITTED' }), ms('2026-06-23 12:00')), null));
check('已回填 dev_estimated_at → 排除', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-06-23 10:00', { dev_estimated_at: '2026-06-25 18:00' }), ms('2026-06-23 12:00')), null));
check('assigned_at 空 → 不标', () => assert.strictEqual(unrepliedTimeoutLevel(R(null), ms('2026-06-23 12:00')), null));
check('非法日期 2026-02-31 → 反查返 null 不标（codex M-2）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2026-02-31 10:00'), ms('2026-06-23 12:00')), null));
check('合法闰年 2024-02-29 → 正常参与（16前远超60 红）', () => assert.strictEqual(unrepliedTimeoutLevel(R('2024-02-29 10:00'), ms('2024-02-29 12:00')), 'red'));

// ===== ② 漂移哨兵：前端源关键片段必须在（防复刻与 Data_Collab.html 脱节）=====
console.log('② 漂移哨兵（读 Data_Collab.html 断言关键逻辑在）：');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'Data_Collab.html'), 'utf8');
const sentinels = [
    ['判定函数定义', 'function unrepliedTimeoutLevel(r, nowMs)'],
    ['解析函数定义', 'function parseCollabLocalTime(s)'],
    ['非法日期反查校验(M-2)', 'dt.getFullYear() === y && dt.getMonth() === mo - 1'],
    ['nowMs 参数化(L-2)', "(typeof nowMs === 'number') ? nowMs : Date.now()"],
    ['筛选+渲染共用 nowTs(L-2)', 'const nowTs = Date.now();'],
    ['范围=normal+PENDING+未回填', "r.assign_mode !== 'normal' || r.status !== 'PENDING' || r.dev_estimated_at"],
    ['16点窗口判定', 'assigned.getHours() < 16'],
    ['相对分钟 30/60', "mins > 60 ? 'red' : mins > 30 ? 'orange' : null"],
    ['次日绝对点 10/12', 'da + 1, 12, 0, 0'],
    ['列表标记挂载', '${timeoutMark}'],
    ['客户端筛选', 'onlyUnrepliedTimeout ? (list || []).filter(r => unrepliedTimeoutLevel(r, nowTs))'],
    ['筛选开关', 'toggleUnrepliedTimeoutFilter'],
    ['B 回填时刻取日志', "d.logs.find(l => l && l.operation_type === 'dev_estimate_reply')"],
    ['B 详情挂载', '+ devEstimateRepliedHtml'],
];
sentinels.forEach(([name, frag]) => check('哨兵: ' + name, () => assert.ok(html.includes(frag), '源文件缺失片段: ' + frag)));

console.log(`\n结果：${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
