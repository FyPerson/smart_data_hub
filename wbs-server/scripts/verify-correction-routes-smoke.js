// verify-correction-routes-smoke.js — J1 自验 PoC（RC-L2 根治证明）
// 证明：routes/corrections.js 真实导出可被 require + 注入内存 db helper 测试真实逻辑
//   （而非复刻）。这是抽 routes 的核心红利——deps 注入让 verify 测真实代码。
//   覆盖：① 模块实例化（16 注入全到位，无 ReferenceError）② initSchema 建真实三表 + readiness
//        ③ 真实 correctionTransition 闸门/权限/旁路断言。
// 用法：node scripts/verify-correction-routes-smoke.js
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});

// 16 注入符号（db helper 指向内存 db；其余 mock）
const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
  sendIssueDingtalkRaw: asyncNoop,
  UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'correction-smoke-uploads'),
  readSystemConfig: asyncNoop,
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: asyncNoop,
  normalizeAttachmentExt: (x) => x,
  safeDeleteFileSync: noop,
  maskPhone: (x) => x,
};

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

async function waitReady(state, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!state.ready) {
    if (state.error) throw new Error('schema error: ' + state.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('readiness timeout（migration 未在 ' + timeoutMs + 'ms 内就绪）');
    await new Promise(r => setTimeout(r, 30));
  }
}

async function expectReject(fn, code, label) {
  try { await fn(); assert.fail(label + '：应抛错但成功了'); }
  catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    ok(e.code === code || (e.httpStatus && String(e.code) === code), label + `（抛 ${e.code}）`);
  }
}

(async () => {
  console.log('=== J1 自验：routes/corrections.js require + 注入测试 db ===\n');

  // ① 实例化
  const mod = require('../routes/corrections')(deps);
  ok(typeof mod.initSchema === 'function', '① 实例化成功，导出 initSchema');
  ok(mod.router && typeof mod.router.post === 'function', '① 导出 express Router');
  ok(mod._internals && typeof mod._internals.correctionTransition === 'function', '① _internals.correctionTransition 可取');
  const I = mod._internals;

  // ② initSchema 建真实三表 + readiness
  mod.initSchema();
  await waitReady(I.CORRECTION_SCHEMA_STATE);
  ok(I.CORRECTION_SCHEMA_STATE.ready === true, '② initSchema → readiness.ready=true');
  const tbls = await dbAllAsync("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'correction%'");
  const names = tbls.map(t => t.name).sort();
  ok(names.includes('correction_requests') && names.includes('correction_attachments') && names.includes('correction_status_history'),
    '② 真实三表建好：' + names.join(', '));

  // 插一条 users（actor join 可能需要）+ 一条 PENDING_ASSIGN 修正单
  await dbRunAsync(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, real_name TEXT, role TEXT, phone TEXT, status TEXT)`);
  await dbRunAsync(`INSERT INTO users (id, username, real_name, role, status) VALUES (1,'admin','管理员','admin','active'),(5,'dev','开发','user','active')`);
  await dbRunAsync(`INSERT INTO correction_requests (id, source_system, location_info, requester_name, correction_type, status, created_by, created_at)
                    VALUES (1, 'BMS', '测试修正方式', '测试业务方', 'single', 'PENDING_ASSIGN', 1, datetime('now','localtime'))`);

  // ③ 真实 correctionTransition 断言（注入内存 db 跑真实逻辑）
  // T1 非法转移：PENDING_ASSIGN → FIXED（流转表不允许）
  await expectReject(() => I.correctionTransition(1, 'PENDING_ASSIGN', 'FIXED', { id: 1, role: 'admin' }),
    'INVALID_TRANSITION', '③ T1 非法转移 PENDING_ASSIGN→FIXED 被拒');
  // T2 权限拒：user 角色不能指派
  await expectReject(() => I.correctionTransition(1, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 5, role: 'user' }, { assigned_to: 5 }),
    'NOT_AUTHORIZED_FOR_TRANSITION', '③ T2 user 角色指派被拒（权限）');
  // T3 合法旁路：admin 作废 PENDING_ASSIGN → VOIDED
  await I.correctionTransition(1, null, 'VOIDED', { id: 1, role: 'admin' });
  const row = await dbGetAsync('SELECT status FROM correction_requests WHERE id=1');
  ok(row.status === 'VOIDED', '③ T3 admin 作废 → status=VOIDED（合法旁路写库成功）');
  // T4 流转表真实导出对照（不是复刻）
  ok(I.CORRECTION_STATUS_TRANSITIONS.FIXED.includes('REFIXED') && I.CORRECTION_STATUS_TRANSITIONS.ARCHIVED.length === 1,
    '③ T4 真实流转表导出正确（FIXED→REFIXED / ARCHIVED→仅VOIDED）');

  // ④ router stack 断言（codex rec：18 端点精确注册 + 路径/method 正确，验证 app.use 挂载等价）
  const reg = mod.router.stack.filter(l => l.route)
    .map(l => l.route.path + '[' + Object.keys(l.route.methods).filter(m => l.route.methods[m]).join(',') + ']');
  ok(reg.length === 19, '④ router 注册 19 端点（实际 ' + reg.length + '）（细优② +notify-creator）');
  ok(reg.includes('/[post]') && reg.includes('/[get]'), '④ 建单 POST / + 列表 GET / 注册');
  ok(reg.includes('/:id/assign[post]') && reg.includes('/:id/create-chat[post]') && reg.includes('/:id/notify-read-status[get]'),
    '④ 关键端点（assign/create-chat/notify-read-status）路径+method 精确');
  ok(reg.includes('/:id/notify-creator[post]'), '④ 细优② notify-creator 端点注册（POST）');

  console.log('\n✅ J1 自验通过：' + pass + ' 项断言全绿 —— 真实导出可 require + 注入测试 db，RC-L2 根治可行');
  db.close();
})().catch(e => { console.error('\n✗ J1 自验失败：', e.message, '\n', e.stack); process.exit(1); });
