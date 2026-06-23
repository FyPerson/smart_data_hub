/**
 * verify-collab-dingtalk-sendok.js
 *
 * collab 通知发送「软成功拦截」验证（2026-06-23 hotfix）
 *   修复：sendCollabDingtalkRaw 原仅凭 errcode 判成功，钉钉 batchSend「软成功」
 *   （errcode=0 但用户在 invalid/flowControlled/filtered 列表 或 无 processQueryKey）
 *   被误当真成功 → 静默漏发 + 后续查已读报「缺少消息标识」（#2972 实证）。
 *   修法：对齐项目既有 dingtalkSendOk 范式（notify-expected / issue-notify），补三层列表
 *   拦截 + processQueryKey 非空校验，任一未送达即 ok:false（不写 notified_at）。
 *
 * 用法：node scripts/verify-collab-dingtalk-sendok.js   （自包含，无需启动 server、无需钉钉）
 *
 * 验证策略（⚠️ 同 verify-collab-expected-notify 的移植局限）：
 *   sendCollabDingtalkRaw 内联在 server.js（非可挂载/导出），含钉钉 IO + readSystemConfig +
 *   dbRunAsync 闭包，无法外部注入 mock 直测。故本脚本分两层：
 *     ① 纯逻辑：镜像 hitList（单聊单收件人「列表命中即未送达」判定）语义全覆盖；
 *     ② 漂移哨兵：读 server.js 断言 sendCollabDingtalkRaw 真含四层拦截 + 清缓存 +
 *        拦截块在 return{ok:true} 之前，缓解镜像与真相源脱节（有人删拦截/改顺序会失败）。
 *   端点层行为（!result.ok → 不写 notified_at）由部署前本地实测 #2972 覆盖。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push({ name, err: e.message }); console.log(`  ✗ ${name} — ${e.message}`); }
}

// ============ ① 纯逻辑：hitList 语义（从 server.js sendCollabDingtalkRaw 镜像）============
//   collab 单聊只发 sendTarget 一人，列表命中该 userid 即「未送达」。
const hitList = (arr, target) =>
    Array.isArray(arr) && arr.map(v => String(v).trim()).includes(String(target).trim());

console.log('\n[① hitList 纯逻辑]');
check('列表含目标 userid → 命中', () => assert.strictEqual(hitList(['u1'], 'u1'), true));
check('列表不含目标 → 不命中', () => assert.strictEqual(hitList(['u2'], 'u1'), false));
check('null / undefined / 非数组 → 不命中（不抛错）', () => {
    assert.strictEqual(hitList(null, 'u1'), false);
    assert.strictEqual(hitList(undefined, 'u1'), false);
    assert.strictEqual(hitList('u1', 'u1'), false);   // 字符串非数组
});
check('空数组 → 不命中', () => assert.strictEqual(hitList([], 'u1'), false));
check('元素带前后空白 → trim 归一后命中（防钉钉回显带空白漏判）', () =>
    assert.strictEqual(hitList([' u1 '], 'u1'), true));
check('目标带空白 → trim 后命中', () => assert.strictEqual(hitList(['u1'], ' u1 '), true));
check('多人列表含目标 → 命中', () => assert.strictEqual(hitList(['a', 'u1', 'b'], 'u1'), true));
check('多人列表不含目标 → 不命中（别人失败不连累本人）', () =>
    assert.strictEqual(hitList(['a', 'b'], 'u1'), false));
check('数字 userid 与字符串归一比较', () => assert.strictEqual(hitList([123], '123'), true));

// ============ ② 漂移哨兵：读 server.js 断言 sendCollabDingtalkRaw 拦截子句仍在 ============
console.log('\n[② 漂移哨兵 — server.js sendCollabDingtalkRaw]');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fnStart = src.indexOf('async function sendCollabDingtalkRaw');
assert.notStrictEqual(fnStart, -1, '找不到 sendCollabDingtalkRaw 定义');
// 函数体到「通知 endpoint」注册前（13760 区 app.post .../notify）
const fnEnd = src.indexOf("app.post('/api/collab/requests/:id/notify'", fnStart);
assert.notStrictEqual(fnEnd, -1, '找不到 notify endpoint 边界');
const body = src.slice(fnStart, fnEnd);

check('含 hitList 定义（列表命中判定）', () => assert.ok(/const hitList\s*=/.test(body)));
check('拦截 invalidStaffIdList', () => assert.ok(body.includes('invalidStaffIdList')));
check('拦截 flowControlledStaffIdList', () => assert.ok(body.includes('flowControlledStaffIdList')));
check('拦截 filteredStaffIdList', () => assert.ok(body.includes('filteredStaffIdList')));
check('processQueryKey 非空校验（!sendResult.processQueryKey）', () =>
    assert.ok(body.includes('!sendResult.processQueryKey')));
check('invalid 命中清 dingtalk_user_id 缓存（自愈换号）', () =>
    assert.ok(/dingtalk_user_id\s*=\s*NULL/.test(body)));
check('四种失败 reason 标记齐全（detail 带命中 uid，codex 105 L-3）', () => {
    // detail 现为模板字符串 `send:xxx:${sendTarget}`，按前缀子串匹配（不再带单引号包裹）
    ['send:user_invalid:', 'send:rate_limit:', 'send:filtered:', 'send:no_query_key:']
        .forEach(r => assert.ok(body.includes(r), `缺 ${r}`));
});
check('四层拦截均 return ok:false', () => {
    // 拦截块只出现 ok: false；成功路径才 ok: true
    const okFalseCount = (body.match(/ok:\s*false/g) || []).length;
    assert.ok(okFalseCount >= 5, `ok:false 出现 ${okFalseCount} 次（含 errcode 既有失败分支 + 4 层新拦截，应 ≥5）`);
});
check('⭐ 拦截块在 return{ok:true} 之前（软成功不会漏到成功路径）', () => {
    const okTrue = body.indexOf('ok: true, status: 200');
    assert.ok(okTrue !== -1, '找不到成功 return');
    ['invalidStaffIdList', 'flowControlledStaffIdList', 'filteredStaffIdList', '!sendResult.processQueryKey']
        .forEach(clause => {
            const idx = body.indexOf(clause);
            assert.ok(idx !== -1 && idx < okTrue, `「${clause}」拦截必须在成功 return 之前`);
        });
});

// ============ 汇总 ============
console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} / 失败 ${failed}`);
if (failed) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log(`  ✗ ${f.name}\n     ${f.err}`));
    process.exit(1);
}
console.log('✅ 全部通过：collab 软成功拦截逻辑 + 漂移哨兵 OK');
