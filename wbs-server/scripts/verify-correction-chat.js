// 验证脚本：数据修正模块 Commit E — 升级讨论拉群 create-chat（成员规划 + 校验顺序 + 旁路守卫）
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md（§4.9 / §5.4 / G-2~G-6 / codex 03 M-2·M-3 / 04 M-1·M-5·M-6 / L-2）
// 用法：node scripts/verify-correction-chat.js
//
// ⚠️ 移植双份局限（同 Commit B/C verify / RC-L2）：复刻而非 require server.js（顶层 app.listen 占端口）。
//   create-chat handler 与 express req/res + 钉钉 SDK 强耦合，无法直接跑；本脚本复刻其**纯决策核**——
//   ① 成员入口 addCorrectionChatMember（M-2 不排 id=1）② 排除名单 isCorrectionChatExcludedId
//   ③ 校验顺序 checkChatGate（可见性→拉群权限→幂等→门槛，M-6）④ 成员规划 planMembers（底座/额外/业务方 + warning 结构 M-3）
//   ⑤ 群名码点截断 ⑥ 旁路 UPDATE 双 WHERE 守卫（真实 sqlite，钉钉建群期间被作废/归档/并发抢先 → changes=0）。
//   钉钉号反查（async）在 endpoint 内 best-effort，本脚本以"ding 已解析（字符串或 ''）"建模其结果，专注决策矩阵。
const assert = require('assert');
const sqlite3 = require('sqlite3');

// ===== J3：底层排除名单 / 可拉群状态 require 真实 _internals（非复刻，防漂移）=====
//   ⚠️ 高层成员规划/校验顺序（checkChatGate/planMembers/planRequester，下方）在 corrections.js create-chat handler
//   内联、未抽函数导出，务实收尾保留复刻 + 标注：改 handler 的成员规划/校验顺序/业务方反查时须同步本文件。
const _db0 = new sqlite3.Database(':memory:');
const _noop = () => {}; const _mw = (q, s, n) => (n ? n() : undefined); const _an = async () => ({});
const _r0 = (s, p = []) => new Promise((res, rej) => _db0.run(s, p, function (e) { e ? rej(e) : res(this); }));
const _g0 = (s, p = []) => new Promise((res, rej) => _db0.get(s, p, (e, r) => e ? rej(e) : res(r)));
const _a0 = (s, p = []) => new Promise((res, rej) => _db0.all(s, p, (e, r) => e ? rej(e) : res(r)));
const _mod = require('../routes/corrections')({ logger: { info: _noop, warn: _noop, error: _noop, debug: _noop }, db: _db0, dbRunAsync: _r0, dbGetAsync: _g0, dbAllAsync: _a0, authenticateToken: _mw, requireAdmin: _mw, requirePublisherOrAdmin: _mw, sendIssueDingtalkRaw: _an, UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'corr-chat-verify'), readSystemConfig: _an, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: _an, normalizeAttachmentExt: x => x, safeDeleteFileSync: _noop, maskPhone: x => x });
const I = _mod._internals;
const COLLAB_CHAT_ADMIN_ID = 3;   // 示例用户A（deps 常量）
const CORRECTION_CHAT_EXCLUDE_IDS = I.CORRECTION_CHAT_EXCLUDE_IDS;             // ⭐ require 真实（排除名单：示例只读领导A 11）
const isCorrectionChatExcludedId = I.isCorrectionChatExcludedId;               // ⭐ require 真实
const CORRECTION_CHAT_ALLOWED_STATUSES = I.CORRECTION_CHAT_ALLOWED_STATUSES;   // ⭐ require 真实
// addCorrectionChatMember：corrections.js 有同名模块函数但未导出 _internals，保留复刻（M-2：不排 id=1）
function addCorrectionChatMember(memberSet, rawId) { const uid = Number(rawId); if (Number.isSafeInteger(uid) && uid > 0) memberSet.add(uid); }
// 对照组：collab addRealChatMember（硬排 BUILTIN_ADMIN_USER_ID=1）反衬 M-2 差异
const BUILTIN_ADMIN_USER_ID = 1;
function addRealChatMember(memberSet, rawId) { const uid = Number(rawId); if (Number.isSafeInteger(uid) && uid > 0 && uid !== BUILTIN_ADMIN_USER_ID) memberSet.add(uid); }

// 校验顺序复刻（M-6）：可见性 → 拉群权限 → 幂等 → 状态门槛。返回 {http, code}；null=放行到建群。
function checkChatGate(c, actor) {
    const isAdmin = actor.role === 'admin';
    const isPublisher = actor.role === 'publisher';
    const isCreator = Number(c.created_by) === actor.id && actor.id > 0;
    const isAssignee = Number(c.assigned_to) === actor.id && actor.id > 0;
    if (!isAdmin && !isPublisher && !isCreator && !isAssignee) return { http: 403, code: 'NOT_AUTHORIZED_TO_VIEW' };
    if (!isAdmin && !isAssignee) return { http: 403, code: 'NOT_ALLOWED_TO_CREATE_CHAT' };
    if (c.dingtalk_open_conversation_id) return { http: 200, code: 'IDEMPOTENT', idempotent: true };
    if (!CORRECTION_CHAT_ALLOWED_STATUSES.includes(c.status)) return { http: 409, code: 'CHAT_NOT_ALLOWED_IN_STATUS' };
    return null;
}

// 成员规划复刻（钉钉号已解析：userMap.get(id) = {ding:'..'|'' , status}）
function planMembers({ createdBy, assignedTo, triggerId, requester, extraIds, userMap }) {
    const baseIdSet = new Set();
    addCorrectionChatMember(baseIdSet, COLLAB_CHAT_ADMIN_ID);
    addCorrectionChatMember(baseIdSet, createdBy);
    addCorrectionChatMember(baseIdSet, assignedTo);
    addCorrectionChatMember(baseIdSet, triggerId);
    const baseExcludedIds = [];
    for (const bid of [...baseIdSet]) if (isCorrectionChatExcludedId(bid)) { baseIdSet.delete(bid); baseExcludedIds.push(bid); }
    const extraIdSet = new Set();
    for (const r of (extraIds || [])) { const n = Number(r); if (Number.isSafeInteger(n) && n > 0) extraIdSet.add(n); }
    for (const bid of baseIdSet) extraIdSet.delete(bid);
    for (const bid of baseExcludedIds) extraIdSet.delete(bid);
    for (const eid of [...extraIdSet]) if (isCorrectionChatExcludedId(eid)) extraIdSet.delete(eid);

    const memberDingList = [], seenDing = new Set(), warnings = [], missingRequired = [];
    for (const bid of baseExcludedIds) warnings.push({ code: 'REQUIRED_MEMBER_EXCLUDED', user_id: bid });
    for (const bid of baseIdSet) {
        const u = userMap.get(bid);
        if (!u) { missingRequired.push(bid); continue; }
        const ding = u.ding || '';
        if (!ding) { missingRequired.push(bid); continue; }
        if (!seenDing.has(ding)) { seenDing.add(ding); memberDingList.push({ userId: bid, ding }); }
    }
    const includedExtra = [], skippedExtra = [];
    for (const eid of extraIdSet) {
        const u = userMap.get(eid);
        if (!u) continue;                       // ① 不存在 → 静默剔除
        if (u.status === 'disabled') continue;  // ② 禁用 → 静默剔除
        const ding = u.ding || '';
        if (!ding) { skippedExtra.push(eid); warnings.push({ code: 'EXTRA_MEMBER_SKIPPED_NO_DINGTALK', user_id: eid }); continue; }
        // M-1（codex 16）：included 严格 = 实际新增进群；ding 重复（同一人多账号）不计 included 也不计 skipped
        if (!seenDing.has(ding)) { seenDing.add(ding); memberDingList.push({ userId: eid, ding }); includedExtra.push(eid); }
    }
    if (requester && requester.ding && !seenDing.has(requester.ding)) {
        seenDing.add(requester.ding); memberDingList.push({ userId: 0, ding: requester.ding });
    }
    return { memberDingList, warnings, missingRequired, includedExtra, skippedExtra };
}

function buildChatName(locationInfo, id) {
    const rawName = `[数据修正]${String(locationInfo || ('#' + id)).trim()}-讨论`;
    const cp = Array.from(rawName);
    return cp.length > 20 ? cp.slice(0, 20).join('') : rawName;
}

// M-2（codex 16）业务方反查降级决策复刻（endpoint 内 async 反查的纯决策核）：
//   phone 空/格式非法→no_phone；反查抛错→lookup_failed；反查空→not_found；命中且未在群→加入 included；命中但已在群(dup)→included=true。
//   四态：requester_skip_reason ∈ {none, no_phone, not_found, lookup_failed}；requester_included 反映"是否真在群"。
function planRequester({ phone, resolvedDing, lookupThrew = false, seenDing = new Set() }) {
    const p = String(phone || '').trim();
    if (!p || !/^1\d{10}$/.test(p)) return { included: false, reason: 'no_phone' };
    if (lookupThrew) return { included: false, reason: 'lookup_failed' };
    const rDing = resolvedDing != null ? String(resolvedDing).trim() : '';
    if (!rDing) return { included: false, reason: 'not_found' };
    if (seenDing.has(rDing)) return { included: true, reason: 'none' };   // dup：业务方钉钉号已在成员中 → 已在群
    return { included: true, reason: 'none' };                            // 新增加入
}

// ===== sqlite（旁路 UPDATE 双 WHERE 守卫）=====
const db = new sqlite3.Database(':memory:');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
async function bypassUpdate(id) {
    return run(
        `UPDATE correction_requests
            SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ?,
                dingtalk_chat_created_at = datetime('now','localtime'), dingtalk_chat_created_by = ?, dingtalk_chat_name = ?
          WHERE id = ? AND dingtalk_open_conversation_id IS NULL AND voided_at IS NULL
            AND status IN (${CORRECTION_CHAT_ALLOWED_STATUSES.map(() => '?').join(',')})`,
        ['cid_' + id, 'oc_' + id, 99, '[数据修正]x-讨论', id, ...CORRECTION_CHAT_ALLOWED_STATUSES]);
}

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

async function main() {
    // [1] addCorrectionChatMember 不排 id=1（M-2），但排 ≤0/NaN —— 对照 collab addRealChatMember 排 id=1
    const s1 = new Set(); addCorrectionChatMember(s1, 1); addCorrectionChatMember(s1, 0); addCorrectionChatMember(s1, -3); addCorrectionChatMember(s1, NaN); addCorrectionChatMember(s1, '5');
    assert.ok(s1.has(1), 'correction 成员入口保留 id=1（真实 admin）');
    assert.ok(!s1.has(0) && !s1.has(-3), '排除 ≤0 占位 id');
    assert.ok(s1.has(5), '字符串数字 "5" 归一化加入');
    const s1b = new Set(); addRealChatMember(s1b, 1);
    assert.ok(!s1b.has(1), '对照：collab addRealChatMember 排除 id=1');
    ok('M-2 成员入口：addCorrectionChatMember 保留 id=1 / 排 ≤0·NaN；对照 collab 排 id=1（差异成立）');

    // [2] 排除名单
    assert.ok(isCorrectionChatExcludedId(11) && isCorrectionChatExcludedId('11'), '示例只读领导A 11 命中排除');
    assert.ok(!isCorrectionChatExcludedId(6) && !isCorrectionChatExcludedId(3), '示例只读领导B 6 / 示例用户A 3 不排（口径区别于 READONLY_LEADER_IDS）');
    ok('G-5 排除名单：示例只读领导A 11 排 / 示例只读领导B 6 不排（独立常量，非 READONLY_LEADER_IDS=[6,11]）');

    // [3] 校验顺序 M-6：可见性 → 拉群权限 → 幂等 → 门槛
    const base = { created_by: 1, assigned_to: 5, status: 'IN_PROGRESS', dingtalk_open_conversation_id: null };
    assert.strictEqual(checkChatGate(base, { id: 99, role: 'user' }).code, 'NOT_AUTHORIZED_TO_VIEW', '非相关 user → 可见性 403');
    assert.strictEqual(checkChatGate(base, { id: 7, role: 'publisher' }).code, 'NOT_ALLOWED_TO_CREATE_CHAT', 'publisher 可见但无拉群权 → 403');
    assert.strictEqual(checkChatGate({ ...base, created_by: 8 }, { id: 8, role: 'user' }).code, 'NOT_ALLOWED_TO_CREATE_CHAT', '建单人(非admin非assignee) 可见但无拉群权 → 403');
    assert.strictEqual(checkChatGate(base, { id: 5, role: 'user' }), null, '被指派开发本人 + IN_PROGRESS + 未建群 → 放行');
    assert.strictEqual(checkChatGate(base, { id: 1, role: 'admin' }), null, 'admin → 放行');
    ok('M-6 校验顺序：非相关→VIEW403 / publisher→拉群403 / creator→拉群403 / assignee·admin→放行');

    // [4] M-6 关键：幂等/门槛必在鉴权之后（不泄露历史群）
    const withChat = { created_by: 1, assigned_to: 5, status: 'ARCHIVED', dingtalk_open_conversation_id: 'oc_x' };
    assert.strictEqual(checkChatGate(withChat, { id: 99, role: 'user' }).code, 'NOT_AUTHORIZED_TO_VIEW', '无关 user 即使单已建群也先 403（不泄露 oc_id）');
    assert.strictEqual(checkChatGate(withChat, { id: 5, role: 'user' }).code, 'IDEMPOTENT', 'assignee 对已建群单（收口态）→ 幂等返回不卡门槛');
    assert.strictEqual(checkChatGate({ ...withChat, dingtalk_open_conversation_id: null }, { id: 1, role: 'admin' }).code, 'CHAT_NOT_ALLOWED_IN_STATUS', 'admin 对 ARCHIVED 未建群单 → 门槛拒');
    assert.strictEqual(checkChatGate({ created_by: 1, assigned_to: 0, status: 'PENDING_ASSIGN', dingtalk_open_conversation_id: null }, { id: 1, role: 'admin' }).code, 'CHAT_NOT_ALLOWED_IN_STATUS', 'PENDING_ASSIGN 未指派 → 门槛拒');
    ok('M-6 防泄露：无关 user 对已建群单仍先 VIEW403 / 幂等先于门槛 / ARCHIVED·PENDING_ASSIGN 门槛拒');

    // [5] 成员规划：底座不排 id=1 + 业务方加入 + ding 去重
    const um1 = new Map([[3, { ding: 'd3' }], [1, { ding: 'd1' }], [5, { ding: 'd5' }]]);
    const p1 = planMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: { ding: 'dR' }, extraIds: [], userMap: um1 });
    const ids1 = p1.memberDingList.map(m => m.userId);
    assert.ok(ids1.includes(1) && ids1.includes(3) && ids1.includes(5), '底座含 id=1（M-2）+ 示例用户A3 + 开发5');
    assert.ok(ids1.includes(0), '业务方以 userId=0 加入');
    assert.strictEqual(p1.missingRequired.length, 0, '无缺钉钉号');
    ok('成员规划：底座保留 id=1 / 示例用户A·开发入群 / 业务方 userId=0 加入 / 无缺号');

    // [6] ding 去重：业务方 ding 与已有成员相同 → 不重复加
    const p1b = planMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: { ding: 'd5' }, extraIds: [], userMap: um1 });
    assert.strictEqual(p1b.memberDingList.filter(m => m.ding === 'd5').length, 1, '相同 ding 只出现一次（业务方与开发同号去重）');
    ok('ding 去重：业务方 ding 撞已有成员 → 只保留一份');

    // [7] 示例只读领导A排除：底座命中 → REQUIRED_MEMBER_EXCLUDED warning + 不入群；额外命中 → 直接剔除
    const um2 = new Map([[3, { ding: 'd3' }], [11, { ding: 'd11' }], [5, { ding: 'd5' }]]);
    const p2 = planMembers({ createdBy: 11, assignedTo: 5, triggerId: 3, requester: null, extraIds: [11], userMap: um2 });
    assert.ok(!p2.memberDingList.some(m => m.userId === 11), '示例只读领导A不入群（底座+额外均被排）');
    assert.ok(p2.warnings.some(w => w.code === 'REQUIRED_MEMBER_EXCLUDED' && w.user_id === 11), '底座示例只读领导A → REQUIRED_MEMBER_EXCLUDED warning');
    assert.ok(!p2.includedExtra.includes(11) && !p2.skippedExtra.includes(11), '额外示例只读领导A直接剔除（不计 included/skipped）');
    ok('示例只读领导A排除（M-5）：底座命中→warning+不入群 / 额外命中→静默剔除');

    // [8] 额外成员校验①②③④：不存在/禁用静默剔除 / 无钉钉号跳过+warning / 有号纳入
    const um3 = new Map([[3, { ding: 'd3' }], [1, { ding: 'd1' }], [5, { ding: 'd5' }],
        [8, { ding: 'd8', status: 'active' }], [9, { ding: '', status: 'active' }], [10, { ding: 'd10', status: 'disabled' }]]);
    const p3 = planMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: null, extraIds: [8, 9, 10, 999, 5], userMap: um3 });
    assert.ok(p3.includedExtra.includes(8) && p3.memberDingList.some(m => m.userId === 8), '额外 8（有号·active）纳入');
    assert.ok(p3.skippedExtra.includes(9) && p3.warnings.some(w => w.code === 'EXTRA_MEMBER_SKIPPED_NO_DINGTALK' && w.user_id === 9), '额外 9（无钉钉号）跳过 + warning');
    assert.ok(!p3.includedExtra.includes(10) && !p3.skippedExtra.includes(10), '额外 10（禁用）静默剔除');
    assert.ok(!p3.includedExtra.includes(999) && !p3.skippedExtra.includes(999), '额外 999（不存在）静默剔除');
    assert.ok(!p3.includedExtra.includes(5), '额外 5（已在底座）去重剔除');
    ok('额外成员校验①②③④：有号纳入 / 无号跳过+warning / 禁用·不存在·已在底座 静默剔除');

    // [8b] M-1（codex 16）included 严格化：额外成员 ding 与底座/前一额外重复（同一人多账号）→ 不计 included 也不计 skipped
    const um3b = new Map([[3, { ding: 'dShared' }], [1, { ding: 'd1' }], [5, { ding: 'd5' }],
        [20, { ding: 'dShared', status: 'active' }],   // 额外 20 与底座示例用户A3 同钉钉号（同一人两账号）
        [21, { ding: 'dDupExtra', status: 'active' }], [22, { ding: 'dDupExtra', status: 'active' }]]);   // 额外 21/22 互为同号
    const p3b = planMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: null, extraIds: [20, 21, 22], userMap: um3b });
    assert.ok(!p3b.includedExtra.includes(20), '额外 20 与底座同 ding → 不计 included（本就在群，避免误导前端"已加入"）');
    assert.ok(!p3b.skippedExtra.includes(20), '额外 20 同 ding 也不计 skipped（非无号跳过）');
    assert.ok(p3b.includedExtra.includes(21) && !p3b.includedExtra.includes(22), '两额外同 ding → 仅第一个(21)计 included');
    assert.strictEqual(p3b.memberDingList.filter(m => m.ding === 'dDupExtra').length, 1, '同 ding 在 memberDingList 只出现一次');
    ok('M-1 included 严格化：额外 ding 撞底座/撞前一额外 → 不计 included（included 严格=实际新增进群，不误导前端）');

    // [8c] M-2（codex 16/17）业务方反查降级四态：no_phone / not_found / lookup_failed / 成功或 dup→included=true+none
    assert.deepStrictEqual(planRequester({ phone: '' }), { included: false, reason: 'no_phone' }, '业务方未填手机 → no_phone');
    assert.deepStrictEqual(planRequester({ phone: '139' }), { included: false, reason: 'no_phone' }, '手机格式非法 → no_phone');
    assert.deepStrictEqual(planRequester({ phone: '13900000000', lookupThrew: true }), { included: false, reason: 'lookup_failed' }, '反查抛错 → lookup_failed');
    assert.deepStrictEqual(planRequester({ phone: '13900000000', resolvedDing: '' }), { included: false, reason: 'not_found' }, '反查空 → not_found');
    assert.deepStrictEqual(planRequester({ phone: '13900000000', resolvedDing: 'dR' }), { included: true, reason: 'none' }, '反查命中且未在群 → 加入 included=true/none');
    assert.deepStrictEqual(planRequester({ phone: '13900000000', resolvedDing: 'd5', seenDing: new Set(['d5']) }), { included: true, reason: 'none' }, 'dup：业务方钉钉号已在成员 → included=true/none（已在群非 skipped）');
    ok('M-2 业务方降级四态契约：no_phone / not_found / lookup_failed / 命中或 dup→included=true+none（锁契约防回归塞回 warnings/误标 skipped）');

    // [9] 底座缺钉钉号 → missing_required（strong warning，不阻断）
    const um4 = new Map([[3, { ding: 'd3' }], [1, { ding: 'd1' }], [5, { ding: '' }]]);
    const p4 = planMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: null, extraIds: [], userMap: um4 });
    assert.ok(p4.missingRequired.includes(5), '底座开发 5 缺钉钉号 → missing_required');
    assert.ok(!p4.memberDingList.some(m => m.userId === 5), '缺号底座成员不入群');
    assert.ok(p4.memberDingList.some(m => m.userId === 3), '示例用户A仍入群（部分缺号不阻断）');
    ok('底座缺钉钉号（M-5）：→ missing_required strong warning + 不入群 + 不阻断（示例用户A仍在）');

    // [10] 群名码点截断 ≤20，不截半个字
    assert.strictEqual(buildChatName('合同表#123', 1), '[数据修正]合同表#123-讨论', '短名不截断');
    const longName = buildChatName('客户主数据表里第三行客户名称字段错了需要更正过来谢谢', 1);
    assert.ok(Array.from(longName).length <= 20, `长名按码点截断 ≤20（实际 ${Array.from(longName).length}）`);
    ok('群名：[数据修正]…-讨论 短名保留 / 长名按码点截断 ≤20');

    // [11~13] 旁路 UPDATE 双 WHERE 守卫（真实 sqlite）
    await run(`CREATE TABLE correction_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, voided_at DATETIME,
        dingtalk_chat_id TEXT, dingtalk_open_conversation_id TEXT, dingtalk_chat_created_at DATETIME,
        dingtalk_chat_created_by INTEGER, dingtalk_chat_name TEXT)`);
    // [11] 正常落库 → changes=1
    const n1 = (await run(`INSERT INTO correction_requests (status) VALUES ('IN_PROGRESS')`)).lastID;
    assert.strictEqual((await bypassUpdate(n1)).changes, 1, 'IN_PROGRESS·未建群·未作废 → changes=1');
    const row1 = await get('SELECT dingtalk_open_conversation_id, status FROM correction_requests WHERE id=?', [n1]);
    assert.strictEqual(row1.dingtalk_open_conversation_id, 'oc_' + n1, '群字段落库');
    assert.strictEqual(row1.status, 'IN_PROGRESS', '旁路不动 status（G-6）');
    ok('旁路守卫[正常]：合法态落 5 群字段 changes=1 + 不动 status（G-6）');

    // [12] 建群期间被作废（voided_at 非空 + status=VOIDED）→ changes=0
    const n2 = (await run(`INSERT INTO correction_requests (status, voided_at) VALUES ('VOIDED', datetime('now','localtime'))`)).lastID;
    assert.strictEqual((await bypassUpdate(n2)).changes, 0, '建群期间被作废 → 守卫拦 changes=0（STATE_CHANGED）');
    // [12b] 归档（status=ARCHIVED）→ changes=0
    const n3 = (await run(`INSERT INTO correction_requests (status) VALUES ('ARCHIVED')`)).lastID;
    assert.strictEqual((await bypassUpdate(n3)).changes, 0, '建群期间被归档 → 守卫拦 changes=0');
    ok('旁路守卫[状态变化]：作废(voided_at)/归档(ARCHIVED) → changes=0（STATE_CHANGED 兜底）');

    // [13] 并发抢先：已有 open_conversation_id → changes=0（退化幂等）
    const n4 = (await run(`INSERT INTO correction_requests (status, dingtalk_open_conversation_id, dingtalk_chat_id) VALUES ('IN_PROGRESS', 'oc_pre', 'cid_pre')`)).lastID;
    assert.strictEqual((await bypassUpdate(n4)).changes, 0, '已建群（open_conversation_id 非空）→ 守卫拦 changes=0');
    const row4 = await get('SELECT dingtalk_chat_id FROM correction_requests WHERE id=?', [n4]);
    assert.strictEqual(row4.dingtalk_chat_id, 'cid_pre', '并发场景旧群信息不被覆盖（退化幂等读旧值）');
    ok('旁路守卫[并发]：已建群 → changes=0 + 旧群信息保留（退化幂等返回旧值）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit E 拉群验证通过（M-2 成员入口 / 排除名单 / M-6 校验顺序+防泄露 / 成员规划底座·额外·业务方·去重 / 示例只读领导A排除 / 额外①②③④ / 缺号 missing_required / 群名码点截断 / 旁路 UPDATE 双 WHERE 守卫 正常·状态变化·并发）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
