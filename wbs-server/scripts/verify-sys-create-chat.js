// 验证脚本：系统迭代 bug 流 Commit ③ — 真钉钉建群 create-chat（校验顺序 + 成员规划 + 旁路守卫）
// 方案：docs/local/系统迭代/bug流_方案_20260702_v1.2.md（§5；复刻 correction Commit E 范式，bug 流增量）
// 用法：node scripts/verify-sys-create-chat.js
//
// ⚠️ 移植双份局限（同 correction verify / RC-L2）：复刻而非 require server.js（顶层 app.listen 占端口）。
//   create-chat handler 与 express req/res + 钉钉 SDK 强耦合、无法直接跑；本脚本复刻其**纯决策核**——
//   ① 成员入口 addSysChatMember（不排 id=1，require 真实防漂移）
//   ② 校验顺序 checkSysChatGate（可见性→拉群权限→type=bug→幂等→描述→状态门槛；顺序逐字对齐 endpoint）
//   ③ 成员规划 planSysMembers（固定底座 示例用户A+建单人+开发+发起人，无额外/无排除；ding 去重 + missing_required）
//   ④ 报障人反查降级四态 planSysRequester（no_phone/not_found/lookup_failed/命中或dup→included）
//   ⑤ 群名码点截断 ⑥ 旁路 UPDATE 6 群字段双 WHERE 守卫（真实 sqlite：并发抢先/流转出可拉态 → changes=0）。
//   钉钉号反查（async）在 endpoint 内 best-effort，本脚本以"ding 已解析（字符串或 ''）"建模其结果，专注决策矩阵。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');
const os = require('os');

// ===== require 真实 _internals（SYS_CHAT_ALLOWED_STATUSES / addSysChatMember，非复刻，防漂移）=====
const _db0 = new sqlite3.Database(':memory:');
const _noop = () => {}; const _mw = (q, s, n) => (n ? n() : undefined); const _an = async () => ({});
const _r0 = (s, p = []) => new Promise((res, rej) => _db0.run(s, p, function (e) { e ? rej(e) : res(this); }));
const _g0 = (s, p = []) => new Promise((res, rej) => _db0.get(s, p, (e, r) => e ? rej(e) : res(r)));
const _a0 = (s, p = []) => new Promise((res, rej) => _db0.all(s, p, (e, r) => e ? rej(e) : res(r)));
const _mod = require('../routes/sys-iteration')({
  logger: { info: _noop, warn: _noop, error: _noop, debug: _noop },
  db: _db0, dbRunAsync: _r0, dbGetAsync: _g0, dbAllAsync: _a0,
  authenticateToken: _mw, requireAdmin: _mw,
  UPLOAD_DIR: path.join(os.tmpdir(), 'sys-chat-verify'),
  normalizeAttachmentExt: x => x, safeDeleteFileSync: _noop, ALLOWED_FILE_DIRS: [],
  sendIssueDingtalkRaw: _an, sendIssueDingtalkToRequester: _an, getSafePlatformBaseUrl: () => 'http://x',
  readSystemConfig: _an, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: _an, maskPhone: x => x,
});
const I = _mod._internals;
const COLLAB_CHAT_ADMIN_ID = 3;                                  // 示例用户A（deps 常量）
const SYS_CHAT_ALLOWED_STATUSES = I.SYS_CHAT_ALLOWED_STATUSES;   // ⭐ require 真实（['处理中','待验证','待上线']）
const addSysChatMember = I.addSysChatMember;                     // ⭐ require 真实（不排 id=1）

// 校验顺序复刻（顺序逐字对齐 endpoint：可见性→拉群权限→type=bug→幂等→描述→状态门槛）。返回 {http,code}；null=放行到建群。
function checkSysChatGate(c, actor, chatDesc) {
    const isAdmin = actor.role === 'admin';
    const isCreator = Number(c.created_by) === actor.id && actor.id > 0;
    const isAssignee = Number(c.assigned_to) === actor.id && actor.id > 0;
    if (!isAdmin && !isCreator && !isAssignee) return { http: 403, code: 'NOT_AUTHORIZED_TO_VIEW' };
    if (!isAdmin && !isAssignee) return { http: 403, code: 'NOT_ALLOWED_TO_CREATE_CHAT' };
    if (c.type !== 'bug') return { http: 409, code: 'CHAT_ONLY_FOR_BUG' };
    if (c.dingtalk_open_conversation_id) return { http: 200, code: 'IDEMPOTENT', idempotent: true };
    const desc = (typeof chatDesc === 'string') ? chatDesc.trim() : '';
    if (!desc) return { http: 400, code: 'CHAT_DESC_REQUIRED' };
    if (desc.length > 500) return { http: 400, code: 'CHAT_DESC_TOO_LONG' };
    if (!SYS_CHAT_ALLOWED_STATUSES.includes(c.status)) return { http: 409, code: 'CHAT_NOT_ALLOWED_IN_STATUS' };
    return null;
}

// 成员规划复刻（钉钉号已解析：userMap.get(id) = {ding:'..'|''}；无额外成员、无排除名单——bug 流比 correction 简单）
function planSysMembers({ createdBy, assignedTo, triggerId, requester, userMap }) {
    const baseIdSet = new Set();
    addSysChatMember(baseIdSet, COLLAB_CHAT_ADMIN_ID);
    addSysChatMember(baseIdSet, createdBy);
    addSysChatMember(baseIdSet, assignedTo);
    addSysChatMember(baseIdSet, triggerId);
    const memberDingList = [], seenDing = new Set(), missingRequired = [];
    for (const bid of baseIdSet) {
        const u = userMap.get(bid);
        if (!u) { missingRequired.push(bid); continue; }
        const ding = u.ding || '';
        if (!ding) { missingRequired.push(bid); continue; }
        if (!seenDing.has(ding)) { seenDing.add(ding); memberDingList.push({ userId: bid, ding }); }
    }
    let requesterIncluded = false;
    if (requester && requester.ding) {
        if (!seenDing.has(requester.ding)) { seenDing.add(requester.ding); memberDingList.push({ userId: 0, ding: requester.ding }); requesterIncluded = true; }
        else requesterIncluded = true;   // dup：报障人钉钉号已在成员 → 已在群
    }
    return { memberDingList, missingRequired, requesterIncluded, seenDing };
}

// 报障人反查降级四态复刻（endpoint 内 async 反查的纯决策核）：
//   phone 空/格式非法→no_phone；反查抛错→lookup_failed；反查空→not_found；命中且未在群→included；命中但已在群(dup)→included=true+none。
function planSysRequester({ phone, resolvedDing, lookupThrew = false, seenDing = new Set() }) {
    const p = String(phone || '').trim();
    if (!p || !/^1\d{10}$/.test(p)) return { included: false, reason: 'no_phone' };
    if (lookupThrew) return { included: false, reason: 'lookup_failed' };
    const rDing = resolvedDing != null ? String(resolvedDing).trim() : '';
    if (!rDing) return { included: false, reason: 'not_found' };
    if (seenDing.has(rDing)) return { included: true, reason: 'none' };   // dup：已在群
    return { included: true, reason: 'none' };                            // 新增加入
}

function buildSysChatName(title, id) {
    const rawName = `[系统迭代]${String(title || ('#' + id)).trim()}-讨论`;
    const cp = Array.from(rawName);
    return cp.length > 20 ? cp.slice(0, 20).join('') : rawName;
}

// 复刻 syncSysChatAddDev 决策核（[codex29 M-1]；改 index.js handler 时须同步本函数）：reassign 换人后「加新开发进群」的分支矩阵。
//   顺序逐字对齐真实函数：chatRow → devUser → config → token → 钉钉号解析(直取/手机反查) → addUserToChat 结果。
//   契约：全 best-effort、每个分支都返回 {synced, reason?}、**绝不抛**（真函数用 try/catch 兜；[14] 直测真函数的绝不抛）。
//   ⚠️「移旧」无分支——本函数只加不移（钉钉无移除成员 API，用户 2026-07-03 拍板 Option A）。
function decideSyncAddDev({ chatRow, devUser, hasConfig = true, hasToken = true, dingResolve = {}, addResult }) {
    if (!chatRow || !chatRow.dingtalk_open_conversation_id || !chatRow.dingtalk_chat_id) return { synced: false, reason: 'no_chat' };
    if (!devUser) return { synced: false, reason: 'dev_not_found' };
    if (!hasConfig) return { synced: false, reason: 'no_config' };
    if (!hasToken) return { synced: false, reason: 'token_failed' };
    let ding = (devUser.dingtalk_user_id != null) ? String(devUser.dingtalk_user_id).trim() : '';
    if (!ding) {
        if (dingResolve.phoneInvalid) return { synced: false, reason: 'no_dingtalk' };   // 无号 + 手机缺失/非法
        if (dingResolve.lookupThrew) return { synced: false, reason: 'lookup_failed' };   // 反查抛错
        ding = dingResolve.ding != null ? String(dingResolve.ding).trim() : '';
        if (!ding) return { synced: false, reason: 'not_found' };                         // 反查空
    }
    const errcode = addResult && addResult.errcode;
    const ok = (addResult && (addResult.kind === 'soft_success' || addResult.kind === 'success')) || errcode === 0;
    return { synced: !!ok, errcode };   // add 路径对齐真函数：返 {synced, errcode}（无 reason；ok=false 即 add 未成功）
}

// ===== sqlite（旁路 UPDATE 6 群字段双 WHERE 守卫）=====
const db = new sqlite3.Database(':memory:');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
async function bypassUpdate(id) {
    return run(
        `UPDATE sys_issues
            SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ?,
                dingtalk_chat_created_at = datetime('now','localtime'), dingtalk_chat_created_by = ?,
                dingtalk_chat_name = ?, dingtalk_chat_desc = ?
          WHERE id = ? AND dingtalk_open_conversation_id IS NULL
            AND status IN (${SYS_CHAT_ALLOWED_STATUSES.map(() => '?').join(',')})`,
        ['cid_' + id, 'oc_' + id, 99, '[系统迭代]x-讨论', '议题x', id, ...SYS_CHAT_ALLOWED_STATUSES]);
}

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

async function main() {
    // [0] SYS_CHAT_ALLOWED_STATUSES 契约（require 真实，防漂移锚点）
    assert.deepStrictEqual([...SYS_CHAT_ALLOWED_STATUSES].sort(), ['处理中', '待上线', '待验证'].sort(), '可拉群态 = 处理中/待验证/待上线（指派后非终态）');
    assert.ok(!SYS_CHAT_ALLOWED_STATUSES.includes('待处理') && !SYS_CHAT_ALLOWED_STATUSES.includes('已上线') && !SYS_CHAT_ALLOWED_STATUSES.includes('已作废'), '排 待处理[未指派]/已上线·已作废[终态]');
    ok('SYS_CHAT_ALLOWED_STATUSES 契约：处理中/待验证/待上线（require 真实，非复刻）');

    // [1] addSysChatMember 不排 id=1，但排 ≤0/NaN；'5'→5（require 真实）
    const s1 = new Set(); addSysChatMember(s1, 1); addSysChatMember(s1, 0); addSysChatMember(s1, -3); addSysChatMember(s1, NaN); addSysChatMember(s1, '5');
    assert.ok(s1.has(1), 'sys 成员入口保留 id=1（真实 admin，对齐 correction M-2）');
    assert.ok(!s1.has(0) && !s1.has(-3), '排除 ≤0 占位 id');
    assert.ok(s1.has(5), '字符串数字 "5" 归一化加入');
    ok('成员入口：addSysChatMember 保留 id=1 / 排 ≤0·NaN / "5"→5');

    // [2] 校验顺序：可见性 → 拉群权限 → type=bug → 幂等 → 描述 → 状态门槛
    const base = { type: 'bug', created_by: 1, assigned_to: 5, status: '处理中', dingtalk_open_conversation_id: null };
    assert.strictEqual(checkSysChatGate(base, { id: 99, role: 'user' }, '议题').code, 'NOT_AUTHORIZED_TO_VIEW', '非相关 user → 可见性 403');
    assert.strictEqual(checkSysChatGate({ ...base, created_by: 8 }, { id: 8, role: 'user' }, '议题').code, 'NOT_ALLOWED_TO_CREATE_CHAT', '建单人(非admin非assignee) 可见但无拉群权 → 403');
    assert.strictEqual(checkSysChatGate({ ...base, type: 'feature' }, { id: 1, role: 'admin' }, '议题').code, 'CHAT_ONLY_FOR_BUG', 'feature 类型 → CHAT_ONLY_FOR_BUG（bug 专属）');
    assert.strictEqual(checkSysChatGate(base, { id: 5, role: 'user' }, '议题'), null, '被指派开发本人 + bug + 处理中 + 有描述 → 放行');
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, '议题'), null, 'admin → 放行');
    ok('校验顺序：非相关→VIEW403 / creator→拉群403 / feature→CHAT_ONLY_FOR_BUG / assignee·admin(有描述)→放行');

    // [3] 描述必填门槛（幂等之后、状态之前）：空/纯空白 → CHAT_DESC_REQUIRED；>500 → TOO_LONG
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, '').code, 'CHAT_DESC_REQUIRED', '空描述 → CHAT_DESC_REQUIRED');
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, '   ').code, 'CHAT_DESC_REQUIRED', '纯空白 trim 后为空 → CHAT_DESC_REQUIRED');
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, undefined).code, 'CHAT_DESC_REQUIRED', '未传 chat_desc → CHAT_DESC_REQUIRED');
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, 'x'.repeat(501)).code, 'CHAT_DESC_TOO_LONG', '描述 >500 → CHAT_DESC_TOO_LONG');
    assert.strictEqual(checkSysChatGate(base, { id: 1, role: 'admin' }, 'x'.repeat(500)), null, '描述 =500 边界内 → 放行');
    ok('描述门槛：空/纯空白/未传 → REQUIRED / >500 → TOO_LONG / =500 放行');

    // [4] 状态门槛（有描述后）：待处理[未指派]/已上线[终态] 拒
    assert.strictEqual(checkSysChatGate({ ...base, status: '待处理' }, { id: 1, role: 'admin' }, '议题').code, 'CHAT_NOT_ALLOWED_IN_STATUS', '待处理(未指派) → 门槛拒');
    assert.strictEqual(checkSysChatGate({ ...base, status: '已上线' }, { id: 1, role: 'admin' }, '议题').code, 'CHAT_NOT_ALLOWED_IN_STATUS', '已上线(终态) → 门槛拒');
    assert.strictEqual(checkSysChatGate({ ...base, status: '待验证' }, { id: 1, role: 'admin' }, '议题'), null, '待验证 → 放行');
    ok('状态门槛：待处理/已上线 拒 / 待验证 放行');

    // [5] 幂等 + 防泄露顺序：已建群优先返回、但仍在鉴权/type 之后；空描述也能拿幂等（幂等先于描述，本次修正）
    const built = { type: 'bug', created_by: 1, assigned_to: 5, status: '待上线', dingtalk_open_conversation_id: 'oc_x' };
    assert.strictEqual(checkSysChatGate(built, { id: 99, role: 'user' }, '议题').code, 'NOT_AUTHORIZED_TO_VIEW', '无关 user 即使已建群也先 VIEW403（不泄露 oc_id）');
    assert.strictEqual(checkSysChatGate(built, { id: 5, role: 'user' }, '').code, 'IDEMPOTENT', 'assignee 对已建群单 + 空描述 → 仍幂等返回（幂等先于描述，已建群不需再填议题）');
    assert.strictEqual(checkSysChatGate({ ...built, type: 'feature' }, { id: 1, role: 'admin' }, '议题').code, 'CHAT_ONLY_FOR_BUG', '已建群但 type=feature → type 守卫先于幂等（防御，理论不可达）');
    ok('幂等/防泄露：无关user→VIEW403 / 已建群+空描述→幂等（先于描述）/ type 守卫先于幂等');

    // [6] 成员规划：底座 示例用户A3+建单人+开发+发起人 全入 + ding 去重 + missing_required
    const um1 = new Map([[3, { ding: 'd3' }], [1, { ding: 'd1' }], [5, { ding: 'd5' }]]);
    const p1 = planSysMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: { ding: 'dR' }, userMap: um1 });
    const ids1 = p1.memberDingList.map(m => m.userId);
    assert.ok(ids1.includes(3) && ids1.includes(1) && ids1.includes(5), '底座含 示例用户A3 + 建单人1 + 开发5');
    assert.ok(ids1.includes(0), '报障人以 userId=0 加入');
    assert.strictEqual(p1.missingRequired.length, 0, '无缺钉钉号');
    ok('成员规划：示例用户A+建单人+开发入群 / 报障人 userId=0 加入 / 无缺号');

    // [7] ding 去重（报障人撞开发同号）+ 底座缺号 → missing_required（不阻断，示例用户A仍在）
    const p1b = planSysMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: { ding: 'd5' }, userMap: um1 });
    assert.strictEqual(p1b.memberDingList.filter(m => m.ding === 'd5').length, 1, '报障人 ding 撞开发 → 只出现一次');
    assert.strictEqual(p1b.requesterIncluded, true, '撞号也算 requesterIncluded（已在群）');
    const um2 = new Map([[3, { ding: 'd3' }], [1, { ding: 'd1' }], [5, { ding: '' }]]);
    const p2 = planSysMembers({ createdBy: 1, assignedTo: 5, triggerId: 1, requester: null, userMap: um2 });
    assert.ok(p2.missingRequired.includes(5), '开发5 缺钉钉号 → missing_required');
    assert.ok(!p2.memberDingList.some(m => m.userId === 5), '缺号成员不入群');
    assert.ok(p2.memberDingList.some(m => m.userId === 3), '示例用户A仍入群（部分缺号不阻断）');
    ok('去重 + 缺号：报障人撞号去重 / 开发缺号 → missing_required 不阻断（示例用户A在）');

    // [8] 报障人反查降级四态
    assert.deepStrictEqual(planSysRequester({ phone: '' }), { included: false, reason: 'no_phone' }, '未填手机 → no_phone');
    assert.deepStrictEqual(planSysRequester({ phone: '139' }), { included: false, reason: 'no_phone' }, '格式非法 → no_phone');
    assert.deepStrictEqual(planSysRequester({ phone: '13900000000', lookupThrew: true }), { included: false, reason: 'lookup_failed' }, '反查抛错 → lookup_failed');
    assert.deepStrictEqual(planSysRequester({ phone: '13900000000', resolvedDing: '' }), { included: false, reason: 'not_found' }, '反查空 → not_found');
    assert.deepStrictEqual(planSysRequester({ phone: '13900000000', resolvedDing: 'dR' }), { included: true, reason: 'none' }, '命中未在群 → included/none');
    assert.deepStrictEqual(planSysRequester({ phone: '13900000000', resolvedDing: 'd5', seenDing: new Set(['d5']) }), { included: true, reason: 'none' }, 'dup 已在群 → included/none');
    ok('报障人降级四态：no_phone / not_found / lookup_failed / 命中或dup→included+none');

    // [9] 群名码点截断 ≤20
    assert.strictEqual(buildSysChatName('登录超时', 1), '[系统迭代]登录超时-讨论', '短名不截断');
    const longName = buildSysChatName('用户中心登录接口偶发超时报障需要尽快排查处理谢谢', 1);
    assert.ok(Array.from(longName).length <= 20, `长名按码点截断 ≤20（实际 ${Array.from(longName).length}）`);
    ok('群名：[系统迭代]…-讨论 短名保留 / 长名按码点截断 ≤20');

    // [10~12] 旁路 UPDATE 6 群字段双 WHERE 守卫（真实 sqlite）
    await run(`CREATE TABLE sys_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, type TEXT,
        dingtalk_chat_id TEXT, dingtalk_open_conversation_id TEXT, dingtalk_chat_created_at DATETIME,
        dingtalk_chat_created_by INTEGER, dingtalk_chat_name TEXT, dingtalk_chat_desc TEXT)`);
    // [10] 正常落库 → changes=1 + 6 字段就位 + 不动 status
    const n1 = (await run(`INSERT INTO sys_issues (status, type) VALUES ('处理中', 'bug')`)).lastID;
    assert.strictEqual((await bypassUpdate(n1)).changes, 1, '处理中·未建群 → changes=1');
    const row1 = await get('SELECT dingtalk_open_conversation_id, dingtalk_chat_desc, status FROM sys_issues WHERE id=?', [n1]);
    assert.strictEqual(row1.dingtalk_open_conversation_id, 'oc_' + n1, 'open_conversation_id 落库');
    assert.strictEqual(row1.dingtalk_chat_desc, '议题x', '第6字段 dingtalk_chat_desc 落库（留痕）');
    assert.strictEqual(row1.status, '处理中', '旁路不动 status');
    ok('旁路守卫[正常]：合法态落 6 群字段 changes=1 + desc 留痕 + 不动 status');

    // [11] 流转出可拉态（已作废/已上线）→ changes=0（sys 用 status 兜作废，无 voided_at 列）
    const n2 = (await run(`INSERT INTO sys_issues (status, type) VALUES ('已作废', 'bug')`)).lastID;
    assert.strictEqual((await bypassUpdate(n2)).changes, 0, '已作废 → 守卫拦 changes=0（STATE_CHANGED）');
    const n3 = (await run(`INSERT INTO sys_issues (status, type) VALUES ('已上线', 'bug')`)).lastID;
    assert.strictEqual((await bypassUpdate(n3)).changes, 0, '已上线(终态) → 守卫拦 changes=0');
    ok('旁路守卫[状态变化]：已作废/已上线 → changes=0（STATE_CHANGED 兜底）');

    // [12] 并发抢先：已有 open_conversation_id → changes=0 + 旧群信息不被覆盖（退化幂等）
    const n4 = (await run(`INSERT INTO sys_issues (status, type, dingtalk_open_conversation_id, dingtalk_chat_id) VALUES ('处理中', 'bug', 'oc_pre', 'cid_pre')`)).lastID;
    assert.strictEqual((await bypassUpdate(n4)).changes, 0, '已建群（open_conversation_id 非空）→ 守卫拦 changes=0');
    const row4 = await get('SELECT dingtalk_chat_id FROM sys_issues WHERE id=?', [n4]);
    assert.strictEqual(row4.dingtalk_chat_id, 'cid_pre', '并发场景旧群信息不被覆盖（退化幂等读旧值）');
    ok('旁路守卫[并发]：已建群 → changes=0 + 旧群信息保留');

    // [13] syncSysChatAddDev 决策核分支矩阵（[codex29 M-1] 复刻，改一端同步）
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: null, devUser: { id: 5 } }), { synced: false, reason: 'no_chat' }, '无群 → no_chat');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: { dingtalk_open_conversation_id: null, dingtalk_chat_id: null }, devUser: { id: 5 } }), { synced: false, reason: 'no_chat' }, 'oc/chatid 空 → no_chat');
    const chatOk = { dingtalk_open_conversation_id: 'oc', dingtalk_chat_id: 'cid' };
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: null }), { synced: false, reason: 'dev_not_found' }, '新开发账号丢失 → dev_not_found');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5 }, hasConfig: false }), { synced: false, reason: 'no_config' }, '无钉钉凭证 → no_config（不触达钉钉）');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5 }, hasToken: false }), { synced: false, reason: 'token_failed' }, '取 token 失败 → token_failed');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: null }, dingResolve: { phoneInvalid: true } }), { synced: false, reason: 'no_dingtalk' }, '无号 + 手机非法 → no_dingtalk');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: null }, dingResolve: { lookupThrew: true } }), { synced: false, reason: 'lookup_failed' }, '手机反查抛错 → lookup_failed');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: null }, dingResolve: { ding: '' } }), { synced: false, reason: 'not_found' }, '反查空 → not_found');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: 'd5' }, addResult: { errcode: 0 } }), { synced: true, errcode: 0 }, '直取号 + addUserToChat errcode=0 → synced:true');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: null }, dingResolve: { ding: 'dLook' }, addResult: { kind: 'soft_success', errcode: 0 } }), { synced: true, errcode: 0 }, '反查得号 + soft_success → synced:true');
    assert.deepStrictEqual(decideSyncAddDev({ chatRow: chatOk, devUser: { id: 5, dingtalk_user_id: 'd5' }, addResult: { errcode: 400002, kind: 'hard_fail' } }), { synced: false, errcode: 400002 }, 'add 硬失败 → synced:false（不抛，仅记）');
    ok('syncSysChatAddDev 决策核：no_chat/dev_not_found/no_config/token_failed/no_dingtalk/lookup_failed/not_found/add_ok/soft_ok/add_fail 全分支（只加不移）');

    // [14] REAL syncSysChatAddDev「绝不抛」直测（[codex29 M-1]）：_db0 无 sys_issues 表 → 首个 SELECT 抛 → 真函数内部 catch 吞掉返 exception，绝不冒泡影响改派主流程
    const realSync = await I.syncSysChatAddDev(1, 5);
    assert.deepStrictEqual(realSync, { synced: false, reason: 'exception' }, 'REAL syncSysChatAddDev：DB 异常被内部 catch 吞、返 exception，绝不抛（改派主流程不受影响）');
    ok('REAL syncSysChatAddDev 绝不抛：DB 异常 → 内部 catch → {synced:false,reason:exception}（best-effort 契约真函数直测）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ bug 流 Commit ③ 拉群验证通过（SYS_CHAT_ALLOWED_STATUSES 契约 / 成员入口不排id=1 / 校验顺序 可见性→拉群权→type=bug→幂等→描述→状态 / 描述门槛 / 幂等先于描述+防泄露 / 成员规划底座·报障人·去重·缺号 / 报障人降级四态 / 群名码点截断 / 旁路 UPDATE 6 群字段双 WHERE 守卫 正常·状态变化·并发）`);
    db.close(); _db0.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); try { db.close(); } catch (_) {} process.exit(1); });
