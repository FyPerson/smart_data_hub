// 验证脚本：周期取数推送模块 ④ 钉钉推送（集成点2，方案 §2④/§6.1/§6.2，任务书附录 A.4）
//   用法：node scripts/verify-periodic-push.js
//
// require routes/periodic-fetch/index.js + routes/periodic-fetch/recipients.js 真实逻辑（禁止复刻）。
// 钉钉 API 走 require.cache mock（对齐本项目既有范式，见 scripts/verify-correction-rework-notify.js:22-32：
//   utils/dingtalk-notify.js 是 index.js 内部 hard-require 的 stateless util，非 deps 注入，故用
//   require.cache[dtPath]={...}劫持同一路径，index.js require 到的即是这份 mock），不连真实钉钉网络。
//
// 断言覆盖：
//   [单元层] recipients.js resolvePushRecipient：手机号格式非法/反查查不到/查到多条(逗号分隔)/详情在职校验
//     失败(inactive)/详情查不到姓名/成功解析(姓名+部门id+钉钉ID后四位)。
//   [端点层] 可推送前置(§6.1)：success可推 / empty_result默认拒需confirm_empty / failed拒 / running拒 /
//     file_status非present拒；收件人核对预览(不落库)；确认发送：批量部分反查失败→skipped继续发其余(§6.2 J)、
//     发送成功/invalidStaffIdList部分失败→failed、钉钉凭证缺失(no_config)整体502不落库、push留痕+收件人快照
//     +push必须绑定run_id；requireAdmin 401。
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const recipients = require('../routes/periodic-fetch/recipients');
const runner = require('../routes/periodic-fetch/runner');

// ── mock 钉钉（require.cache 劫持，对齐 verify-correction-rework-notify.js 既有范式）──
const SENT_CALLS = []; // { userIds, mediaId, fileName }
const UPLOAD_CALLS = [];
let sendFileToUserImpl = async (token, robotCode, userIds, mediaId, fileName) => {
  SENT_CALLS.push({ userIds, mediaId, fileName });
  // uid_invalid_staff 固定模拟"送达但对方是无效员工"（钉钉批量发送里常见的部分失败形态，
  // errcode 整体仍是 0，只是该 userId 出现在 invalidStaffIdList 里）。
  const invalidStaffIdList = userIds.filter((u) => u === 'uid_invalid_staff');
  return { errcode: 0, invalidStaffIdList };
};
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = {
  id: dtPath, filename: dtPath, loaded: true,
  exports: {
    getAccessToken: async (appKey, appSecret) => {
      if (appKey === 'NO_TOKEN_KEY') throw Object.assign(new Error('gettoken failed'), { errcode: 40001 });
      return 'mock-access-token';
    },
    // 手机号 → userid（按号码后 4 位分派固定场景，供 resolvePushRecipient 单元测试 + 端点测试复用）
    getUserIdByMobile: async (token, phone) => {
      if (phone === '13800000001') return 'uid0001';
      if (phone === '13800000002') return 'uid0002'; // detail 会返回 inactive
      if (phone === '13800000003') return 'uid0003'; // detail 查不到姓名
      if (phone === '13800000004') return 'uid_invalid_staff'; // 会被 sendFileToUser 判 invalidStaffIdList
      if (phone === '13800000005') return 'uid0001,uid9999'; // 多组织账号多值
      if (phone === '13800000006') return 'uid0006'; // detail 无 active 字段 → UNKNOWN_ACTIVE_STATUS（H-2）
      if (phone === '13800000007') return 'uid0007'; // 正常在职，用于 H-1 快照比对/去重
      if (phone === '13800000008') return 'uid0001'; // 与 13800000001 映射同一 userid（userid 去重用，M-1）
      const err = new Error('get_by_mobile failed: errcode=60123');
      err.errcode = 60123;
      throw err; // 查不到
    },
    classifyError: (err) => {
      if (err && err.errcode === 60123) return { reason: 'user_invalid' };
      if (err && err.errcode === 40001) return { reason: 'token_expired' };
      return { reason: 'network', hint: (err && err.message) || 'unknown' };
    },
    uploadMedia: async (token, fileName, buffer) => {
      UPLOAD_CALLS.push({ fileName, size: buffer.length });
      return 'media_mock_1';
    },
    sendFileToUser: async (...args) => sendFileToUserImpl(...args),
  },
};
// 独立注入 getUserDetail：resolvePushRecipient 支持 deps.getUserDetail 覆盖（单元层用），端点层用
// recipients.js 默认导出的 getUserDetail（下面再劫持其网络调用不现实——故端点层改走"通过 deps 传入" 不可行，
// 因为 index.js 内部固定调用 recipients.resolvePushRecipient 时不会传自定义 getUserDetail。
// 为让端点测试可控，改为 monkeypatch recipients 模块自身的 getUserDetail 导出（同一 require 缓存对象，
// index.js 内 `recipients.resolvePushRecipient` 内部用 `deps.getUserDetail || getUserDetail`，其中
// getUserDetail 是本文件顶部 const 绑定，patch module.exports.getUserDetail 不会改变内部闭包引用！
// 因此改为直接 monkeypatch fetch 全局，模拟 topapi/v2/user/get 的响应。
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).includes('topapi/v2/user/get')) {
    const body = JSON.parse((options && options.body) || '{}');
    const uid = body.userid;
    const DETAIL_MAP = {
      uid0001: { errcode: 0, result: { name: '张三', active: true, dept_id_list: [100] } },
      uid0002: { errcode: 0, result: { name: '李四', active: false, dept_id_list: [101] } }, // 非在职
      uid0003: { errcode: 0, result: { name: '', active: true, dept_id_list: [] } }, // 查不到姓名
      uid_invalid_staff: { errcode: 0, result: { name: '王五', active: true, dept_id_list: [102] } },
      uid0006: { errcode: 0, result: { name: '赵六', dept_id_list: [103] } }, // 无 active 字段 → UNKNOWN_ACTIVE_STATUS
      uid0007: { errcode: 0, result: { name: '孙七', active: true, dept_id_list: [104] } },
    };
    const resp = DETAIL_MAP[uid] || { errcode: 60011, errmsg: 'user not exist' };
    return { status: 200, json: async () => resp };
  }
  if (originalFetch) return originalFetch(url, options);
  throw new Error('unexpected real fetch call in verify: ' + url);
};

const SECRET = 'verify-periodic-push-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ============================================================
// § 单元层：recipients.js resolvePushRecipient
// ============================================================
async function unitTests() {
  console.log('\n[单元层] recipients.js resolvePushRecipient');
  const dingtalkNotify = require('../utils/dingtalk-notify'); // 拿到的是上面 require.cache 劫持后的 mock exports
  const depsForUnit = { getUserIdByMobile: dingtalkNotify.getUserIdByMobile, classifyError: dingtalkNotify.classifyError };

  let r = await recipients.resolvePushRecipient('tok', '12345', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INVALID_PHONE_FORMAT');
  ok('非法手机号格式（非1开头11位）→ INVALID_PHONE_FORMAT');

  r = await recipients.resolvePushRecipient('tok', '13800009999', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'NOT_FOUND');
  ok('反查查不到（errcode 60123 user_invalid）→ NOT_FOUND');

  r = await recipients.resolvePushRecipient('tok', '13800000005', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'MULTIPLE_MATCHES');
  ok('钉钉多组织账号返回逗号分隔多个 userid → MULTIPLE_MATCHES（方案 §6.2"查到多条"分支）');

  r = await recipients.resolvePushRecipient('tok', '13800000002', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'INACTIVE_USER');
  ok('反查成功但详情 active=false（非在职）→ INACTIVE_USER，不阻断其余（防误发给离职人员）');

  // H-2 fail-closed：detail 无 active 字段 → UNKNOWN_ACTIVE_STATUS 拒发（旧 fail-open 会误当在职发出）
  r = await recipients.resolvePushRecipient('tok', '13800000006', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'UNKNOWN_ACTIVE_STATUS');
  ok('H-2：详情缺 active 字段（状态未知）→ UNKNOWN_ACTIVE_STATUS 拒发（fail-closed，宁拒不误发）');

  // H-2 单元级三态穷举：直接注入 getUserDetail 覆盖 activeRaw 的 true/false/undefined/非布尔
  const mkDetailDeps = (activeRaw) => ({
    getUserIdByMobile: async () => 'uidX',
    classifyError: dingtalkNotify.classifyError,
    getUserDetail: async () => ({ name: '测试人', activeRaw, deptIds: [1] }),
  });
  assert.strictEqual((await recipients.resolvePushRecipient('t', '13800000001', mkDetailDeps(true))).ok, true);
  assert.strictEqual((await recipients.resolvePushRecipient('t', '13800000001', mkDetailDeps(false))).reason, 'INACTIVE_USER');
  assert.strictEqual((await recipients.resolvePushRecipient('t', '13800000001', mkDetailDeps(undefined))).reason, 'UNKNOWN_ACTIVE_STATUS');
  assert.strictEqual((await recipients.resolvePushRecipient('t', '13800000001', mkDetailDeps('yes'))).reason, 'UNKNOWN_ACTIVE_STATUS');
  assert.strictEqual((await recipients.resolvePushRecipient('t', '13800000001', mkDetailDeps(1))).reason, 'UNKNOWN_ACTIVE_STATUS');
  ok('H-2：activeRaw 三态穷举——true 放行 / false→INACTIVE_USER / undefined·非布尔→UNKNOWN_ACTIVE_STATUS（仅 ===true 放行）');

  r = await recipients.resolvePushRecipient('tok', '13800000003', depsForUnit);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'DETAIL_NOT_FOUND');
  ok('详情查到但姓名为空 → DETAIL_NOT_FOUND（无法核对身份，禁发需人工）');

  r = await recipients.resolvePushRecipient('tok', '13800000001', depsForUnit);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, '张三');
  assert.strictEqual(r.userid, 'uid0001');
  assert.strictEqual(r.dingUserIdLast4, '0001');
  assert.deepStrictEqual(r.deptIds, [100]);
  ok('正常反查：手机号 → 姓名+在职+部门ID+钉钉ID后四位（方案 §6.2 核对信息完整）');

  // normalizePhone：去空格（含内嵌空格，如"138 0000 0001"这种人工输入常见分段格式）
  assert.strictEqual(recipients.normalizePhone('138 0000 0001'), '13800000001');
  assert.strictEqual(recipients.normalizePhone(' 13800000001 '), '13800000001');
  ok('normalizePhone：去除内嵌/首尾空格');

  // H-new 单元：evaluatePushIdempotency 纯判定（require 真实 _internals）
  const I2 = mod._internals;
  assert.strictEqual(I2.evaluatePushIdempotency([], false).blocked, false, '无留痕 → 放行');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'skipped' }], false).blocked, false, '仅 skipped → 放行');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending' }], false).code, 'PUSH_IN_PROGRESS', '有 pending → PUSH_IN_PROGRESS');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending' }], true).code, 'PUSH_IN_PROGRESS', '有 pending 即使 force 也拦');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'success' }], false).code, 'ALREADY_PUSHED', '有 success 非 force → ALREADY_PUSHED');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'success' }], true).blocked, false, '有 success + force → 放行');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending' }, { push_status: 'success' }], true).code, 'PUSH_IN_PROGRESS', 'pending 优先于 success 判定（force 下 pending 仍拦）');
  ok('H-new 单元：evaluatePushIdempotency——pending→PUSH_IN_PROGRESS(force也拦) / success非force→ALREADY_PUSHED / success+force→放行 / pending 优先');

  // M（集成点3）单元：evaluatePushIdempotency 区分 NEEDS_RECONCILE（阶段三回写失败打了 WRITE_FAILED 标记
  //   的卡死 pending）vs PUSH_IN_PROGRESS（无标记的真在途 pending）。
  const reconcileRow = { push_status: 'pending', push_error: 'WRITE_FAILED:success' };
  assert.strictEqual(I2.evaluatePushIdempotency([reconcileRow], false).code, 'NEEDS_RECONCILE', '带 WRITE_FAILED 标记的 pending 非 force → NEEDS_RECONCILE（非 PUSH_IN_PROGRESS）');
  assert.strictEqual(I2.evaluatePushIdempotency([reconcileRow], true).blocked, false, '带 WRITE_FAILED 标记的 pending + force=true → 放行重发（镜像 ALREADY_PUSHED 的 force 语义）');
  // 无标记（push_error 为 null，如正常 eligible 首插时）→ 仍是 PUSH_IN_PROGRESS，且 force 也不能穿透
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending', push_error: null }], false).code, 'PUSH_IN_PROGRESS', '无 WRITE_FAILED 标记（push_error=null）→ 仍判 PUSH_IN_PROGRESS');
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending', push_error: null }], true).code, 'PUSH_IN_PROGRESS', '无标记的 pending，force 也不能穿透（防双击/慢响应重发）');
  // push_error 非空但不是 WRITE_FAILED 前缀（如其他历史错误文案）→ 不误判为可对账，仍是真在途拦截
  assert.strictEqual(I2.evaluatePushIdempotency([{ push_status: 'pending', push_error: '某些其他错误文案' }], false).code, 'PUSH_IN_PROGRESS', 'push_error 非 WRITE_FAILED 前缀 → 不误判 NEEDS_RECONCILE，仍 PUSH_IN_PROGRESS');
  // 混合：一条真在途 pending + 一条已标记 pending → 真在途优先拦截，force 也不能穿透（防止用标记行掩盖真在途行）
  const mixedRows = [{ push_status: 'pending', push_error: null }, reconcileRow];
  assert.strictEqual(I2.evaluatePushIdempotency(mixedRows, true).code, 'PUSH_IN_PROGRESS', '混合"真在途pending"+"已标记pending" → 真在途优先，force 也不能穿透');
  ok('M（集成点3）单元：evaluatePushIdempotency——WRITE_FAILED 标记的 pending → NEEDS_RECONCILE(force 可覆盖) / 无标记 pending → 仍 PUSH_IN_PROGRESS(force 不可穿透) / 混合时真在途优先');

  // L-new 单元：compareRecipientSnapshot（userid 硬 gate + name/last4 归一化 drift）
  const cmpMatch = I2.compareRecipientSnapshot({ userid: 'u1', name: '张三', dingUserIdLast4: '0001' }, { userid: 'u1', name: '张三', last4: '0001' });
  assert.deepStrictEqual(cmpMatch, { match: true, drift: false });
  const cmpUidBad = I2.compareRecipientSnapshot({ userid: 'u2', name: '张三', dingUserIdLast4: '0001' }, { userid: 'u1', name: '张三', last4: '0001' });
  assert.strictEqual(cmpUidBad.match, false, 'userid 不一致 → match=false（硬 gate）');
  const cmpWs = I2.compareRecipientSnapshot({ userid: 'u1', name: '张三', dingUserIdLast4: '0001' }, { userid: 'u1', name: '  张三 ', last4: '0001' });
  assert.deepStrictEqual(cmpWs, { match: true, drift: false }, 'name 仅空白差异 → 归一化后无 drift');
  const cmpDrift = I2.compareRecipientSnapshot({ userid: 'u1', name: '张三', dingUserIdLast4: '0001' }, { userid: 'u1', name: '张三旧', last4: '0001' });
  assert.deepStrictEqual(cmpDrift, { match: true, drift: true }, 'name 真不同 → match=true+drift=true（仍发但标 warning）');
  ok('L-new 单元：compareRecipientSnapshot——userid 硬 gate（不一致 match=false）/ name 空白差异归一化吸收 / name 真变动 drift=true 仍 match');
}

// ============================================================
// § 端点层
// ============================================================
const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: (req, res, next) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: '未登录' });
    try { req.user = jwt.verify(tok, SECRET); next(); } catch { return res.status(403).json({ error: '登录过期' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '权限不足' }),
  getMssqlPool: async () => { throw new Error('push verify 不应触发 mssql'); },
  getMysqlPool: async () => { throw new Error('push verify 不应触发 mysql'); },
  readSystemConfig: async (key) => {
    const CONFIG = { dingtalk_app_key: 'AK', dingtalk_app_secret: 'AS', dingtalk_robot_code: 'ROBOT1' };
    return CONFIG[key] != null ? CONFIG[key] : null;
  },
  maskPhone: (p) => (p ? String(p).slice(0, 3) + '****' : p),
  decryptPassword: (x) => x,
};

const mod = require('../routes/periodic-fetch')(deps);
const I = mod._internals;

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.PERIODIC_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.PERIODIC_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);

let server, port;
function call(method, urlPath, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (r) => {
      let b = '';
      r.on('data', (c) => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 直接造 periodic_tasks + periodic_task_runs 行（跳过 CRUD/跑数流程，push 测试只关心 run 的
// status/file_status 组合，用最小可控方式构造夹具，不代表本文件复刻③的逻辑——③已在
// verify-periodic-run.js 全覆盖，这里只是造测试数据）。
async function seedTask() {
  const r = await run(`INSERT INTO periodic_tasks (task_name, description, source_connection_id, script_template, template_version, status, created_by, created_at)
    VALUES ('T-push-fixture', NULL, 1, 'SELECT 1', 1, 'active', 1, datetime('now','localtime'))`);
  return r.lastID;
}
async function seedRun(taskId, { status, fileStatus, withFile }) {
  let resultFilePath = null;
  if (withFile) {
    const buf = runner.buildResultXlsxBuffer(['a'], [{ a: 1 }]);
    resultFilePath = runner.writeResultFile(buf);
  }
  const r = await run(
    `INSERT INTO periodic_task_runs
       (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
        triggered_by, date_range_start, date_range_end, started_at, finished_at, duration_ms, row_count,
        result_file_path, file_status, status)
     VALUES (?, 'SELECT 1', 'T-push-fixture', 'conn(sqlserver)', 1, 1, '2026-06-01', '2026-07-01',
             datetime('now','localtime'), datetime('now','localtime'), 100, ?, ?, ?, ?)`,
    [taskId, status === 'empty_result' ? 0 : 5, resultFilePath, fileStatus, status]
  );
  return r.lastID;
}

async function endpointTests() {
  console.log('\n[端点层] ④ 推送前置判定 + 收件人核对 + 确认发送');
  const taskId = await seedTask();

  // ── [1] 可推送前置：success + file present → 可推 ──
  const runSuccess = await seedRun(taskId, { status: 'success', fileStatus: 'present', withFile: true });
  let r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/preview`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items[0].ok, true);
  ok(`前置：success+file present → 预览通过（run #${runSuccess}）`);

  // ── [2] 可推送前置：empty_result 默认拒 ──
  const runEmpty = await seedRun(taskId, { status: 'empty_result', fileStatus: 'present', withFile: true });
  r = await call('POST', `/api/periodic-tasks/runs/${runEmpty}/push/preview`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'EMPTY_RESULT_CONFIRM_REQUIRED');
  ok('前置：empty_result 未显式确认 → 409 EMPTY_RESULT_CONFIRM_REQUIRED（方案 §6.1 I）');

  r = await call('POST', `/api/periodic-tasks/runs/${runEmpty}/push/preview`, adminTok, { phones: ['13800000001'], confirm_empty: true });
  assert.strictEqual(r.status, 200);
  ok('前置：empty_result + confirm_empty=true → 放行预览');

  // ── [3] 可推送前置：failed 拒绝 ──
  const runFailed = await seedRun(taskId, { status: 'failed', fileStatus: 'missing', withFile: false });
  r = await call('POST', `/api/periodic-tasks/runs/${runFailed}/push/preview`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'RUN_FAILED_NOT_PUSHABLE');
  ok('前置：failed run → 409 RUN_FAILED_NOT_PUSHABLE（不复用旧文件）');

  // ── [4] 可推送前置：running（进行中）拒绝 ──
  const runRunning = await seedRun(taskId, { status: 'running', fileStatus: 'present', withFile: false });
  r = await call('POST', `/api/periodic-tasks/runs/${runRunning}/push/preview`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'RUN_IN_PROGRESS');
  ok('前置：running（尚未完成）→ 409 RUN_IN_PROGRESS');

  // ── [5] 可推送前置：file_status != present（已清理）拒绝 ──
  const runCleaned = await seedRun(taskId, { status: 'success', fileStatus: 'cleaned', withFile: false });
  r = await call('POST', `/api/periodic-tasks/runs/${runCleaned}/push/preview`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'FILE_NOT_PRESENT');
  ok('前置：success 但文件已清理 → 409 FILE_NOT_PRESENT（方案 §4.4）');

  // ── [6] 收件人预览：不落库（push 表应仍为 0 行）──
  const countBefore = await get(`SELECT COUNT(*) AS c FROM periodic_task_pushes`);
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/preview`, adminTok, { phones: ['13800000001', '13800000002', '13800009999'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items.length, 3);
  assert.strictEqual(r.body.items[0].ok, true);
  assert.strictEqual(r.body.items[1].reason, 'INACTIVE_USER');
  assert.strictEqual(r.body.items[2].reason, 'NOT_FOUND');
  const countAfter = await get(`SELECT COUNT(*) AS c FROM periodic_task_pushes`);
  assert.strictEqual(countAfter.c, countBefore.c, '预览端点不应产生任何 push 留痕（纯查询，无副作用）');
  ok('预览：混合成功/在职校验失败/查不到 三态一次返回，且不写 push 表（无副作用）');

  // 快照构造 helper（H-1）：走真实 preview 拿回 {phone,userid,name,last4}——confirm 必须携带这份期望快照。
  async function snap(runId, phone) {
    const pr = await call('POST', `/api/periodic-tasks/runs/${runId}/push/preview`, adminTok, { phones: [phone], confirm_empty: true });
    const item = (pr.body.items || []).find((i) => i.phone === recipients.normalizePhone(phone));
    assert.ok(item && item.ok, `snap(${phone}) 预览应 ok`);
    return { phone: item.phone, userid: item.userid, name: item.name, last4: item.last4 };
  }
  const freshRun = async () => seedRun(taskId, { status: 'success', fileStatus: 'present', withFile: true });

  // ── [7] 确认发送（H-3 两阶段 + H-1 快照比对）：两个合法收件人 → 均 success，留痕从 pending 升 success ──
  const run7 = await freshRun();
  const snap001 = await snap(run7, '13800000001');
  const snap007 = await snap(run7, '13800000007');
  r = await call('POST', `/api/periodic-tasks/runs/${run7}/push/confirm`, adminTok, { recipients: [snap001, snap007] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results.length, 2);
  assert.ok(r.body.results.every((x) => x.status === 'success'), '两个通过核对的收件人应均 success');
  let rows7 = await all(`SELECT * FROM periodic_task_pushes WHERE run_id = ? ORDER BY id`, [run7]);
  assert.strictEqual(rows7.length, 2);
  assert.ok(rows7.every((p) => p.push_status === 'success'), '两阶段：pending 已按回执升为 success（无残留 pending）');
  assert.strictEqual(rows7.find((p) => p.phone_snapshot === '13800000001').recipient_name_snapshot, '张三', '成功行含姓名快照');
  ok('确认发送（H-1+H-3）：携带正确 preview 快照的 2 收件人 → 均 success，留痕 pending→success 两阶段落地');

  // ── [8] H-1 后端强约束：无 recipients 快照 → 400；快照字段不全 → 400 ──
  const run8 = await freshRun();
  r = await call('POST', `/api/periodic-tasks/runs/${run8}/push/confirm`, adminTok, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'RECIPIENTS_REQUIRED');
  r = await call('POST', `/api/periodic-tasks/runs/${run8}/push/confirm`, adminTok, { recipients: [{ phone: '13800000001' }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'INVALID_RECIPIENT_SNAPSHOT');
  const rows8 = await all(`SELECT COUNT(*) AS c FROM periodic_task_pushes WHERE run_id = ?`, [run8]);
  assert.strictEqual(rows8[0].c, 0, '快照缺失被 400 拦下，不应产生任何 push 留痕');
  ok('H-1：confirm 缺 recipients 快照 → 400 RECIPIENTS_REQUIRED；快照字段不全 → 400 INVALID_RECIPIENT_SNAPSHOT（admin 无法跳过 preview 直发）');

  // ── [9] H-1+L-new 快照比对：userid 硬 gate 不一致 → RECIPIENT_MISMATCH 拒发；name/last4 归一化差异 → 仍发+snapshot_warning ──
  const run9 = await freshRun();
  const goodSnap = await snap(run9, '13800000001');
  // userid 篡改（phone7 却带 uid0001，与后端重查的 uid0007 不符）→ 硬 gate 拒发
  const tamperedUid = { ...(await snap(run9, '13800000007')), userid: 'uid0001' };
  r = await call('POST', `/api/periodic-tasks/runs/${run9}/push/confirm`, adminTok, { recipients: [goodSnap, tamperedUid] });
  assert.strictEqual(r.status, 200);
  const byPhone9 = Object.fromEntries(r.body.results.map((x) => [x.phone, x]));
  assert.strictEqual(byPhone9['13800000001'].status, 'success', '快照一致的收件人正常 success');
  assert.strictEqual(byPhone9['13800000007'].status, 'skipped');
  assert.strictEqual(byPhone9['13800000007'].reason, 'RECIPIENT_MISMATCH', 'userid 不一致（硬 gate）→ RECIPIENT_MISMATCH 拒发，不阻断其余');
  ok('H-1/L-new：userid 硬 gate 不一致 → RECIPIENT_MISMATCH 拒发该号、其余照发');

  // L-new-a：userid 一致但 name 仅首尾空白差异 → 归一化后相同 → 仍发、**不误判 MISMATCH 也不标 warning**（吸收空白差异）
  const run9b = await freshRun();
  const wsSnap = { ...(await snap(run9b, '13800000001')), name: '  张三 ' }; // 首尾空白，NFC+trim 后 == '张三'
  r = await call('POST', `/api/periodic-tasks/runs/${run9b}/push/confirm`, adminTok, { recipients: [wsSnap] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results[0].status, 'success', 'name 仅空白差异 → 仍发（不误判 MISMATCH）');
  assert.ok(!r.body.results[0].snapshot_warning, 'name 仅空白差异归一化后相同 → 不标 warning（吸收 trim/NFC 噪声）');
  ok('L-new-a：userid 一致 + name 仅首尾空白 → 仍发、归一化吸收差异不误拒不误标 warning');

  // L-new-b：userid 一致但 name 归一化后仍不同（真变动，如钉钉侧改名）→ 仍发 + snapshot_warning
  const run9c = await freshRun();
  const driftSnap = { ...(await snap(run9c, '13800000001')), name: '张三_旧名' }; // 归一化后 != 后端重查的 '张三'
  r = await call('POST', `/api/periodic-tasks/runs/${run9c}/push/confirm`, adminTok, { recipients: [driftSnap] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results[0].status, 'success', 'name 真变动但 userid 一致 → 仍发（userid 是防错发硬 gate）');
  assert.strictEqual(r.body.results[0].snapshot_warning, 'name_or_last4_drift', 'name 归一化后仍不同 → 标 snapshot_warning 供 admin 知晓');
  ok('L-new-b：userid 一致但 name 真变动（归一化后仍不同）→ 仍发 + snapshot_warning=name_or_last4_drift（不误拒真收件人）');

  // ── [10] H-3②/H-new 幂等（事务内检查）：已成功推送的 run 再 confirm → 409 ALREADY_PUSHED；force=true 放行 ──
  r = await call('POST', `/api/periodic-tasks/runs/${run7}/push/confirm`, adminTok, { recipients: [snap001] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'ALREADY_PUSHED');
  r = await call('POST', `/api/periodic-tasks/runs/${run7}/push/confirm`, adminTok, { recipients: [snap001], force: true });
  assert.strictEqual(r.status, 200);
  ok('H-3②：已推成功的 run 再 confirm → 409 ALREADY_PUSHED（防重发敏感文件）；force=true 显式重发放行');

  // ── [10b] H-new 并发竞态：run 已有 pending（首个 confirm 进行中）→ 第二个 confirm 被拦 PUSH_IN_PROGRESS ──
  //   模拟"首请求已插 pending 未写 success"：手工插一条 pending，再调 confirm → 事务内看到 pending → 拦。
  const runP = await freshRun();
  const snapP = await snap(runP, '13800000001');
  await run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, push_status, pushed_by, pushed_at) VALUES (?, '13800000099', 'pending', 1, datetime('now','localtime'))`, [runP]);
  const pushesBeforeP = (await all(`SELECT COUNT(*) AS c FROM periodic_task_pushes WHERE run_id = ?`, [runP]))[0].c;
  r = await call('POST', `/api/periodic-tasks/runs/${runP}/push/confirm`, adminTok, { recipients: [snapP] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'PUSH_IN_PROGRESS', '已有 pending → PUSH_IN_PROGRESS');
  // force 也不能穿透 pending（防双击）
  r = await call('POST', `/api/periodic-tasks/runs/${runP}/push/confirm`, adminTok, { recipients: [snapP], force: true });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'PUSH_IN_PROGRESS', 'force 也不能穿透 pending（防双击重发）');
  const pushesAfterP = (await all(`SELECT COUNT(*) AS c FROM periodic_task_pushes WHERE run_id = ?`, [runP]))[0].c;
  assert.strictEqual(pushesAfterP, pushesBeforeP, 'PUSH_IN_PROGRESS 时事务 ROLLBACK，不插入任何新 push 行');
  ok('H-new：run 已有 pending → 第二个 confirm 返 409 PUSH_IN_PROGRESS（force 也拦）+ 事务 ROLLBACK 不新增留痕（并发竞态闭合）');

  // ── [10c] M-new 阶段三回写失败：UPDATE pending→success 影响 0 行 → 返回 write_failures+warning，行保持 pending，不误报全成功 ──
  //   用独立模块实例，包 dbRunAsync 让"阶段三 pending UPDATE"返回 changes=0（模拟并发/DB 异常回写失败）。
  const dbRunWriteFail = async (sql, params) => {
    if (/SET push_status=\?, push_error=\? WHERE id=\? AND push_status='pending'/.test(sql)) {
      return { changes: 0, lastID: 0 }; // 模拟回写 0 行影响
    }
    return run(sql, params);
  };
  const modWF = require('../routes/periodic-fetch')({ ...deps, dbRunAsync: dbRunWriteFail });
  modWF.initSchema();
  await new Promise((res, rej) => { let n = 0; const t = setInterval(() => { if (modWF._internals.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); } else if (++n > 500) { clearInterval(t); rej(new Error('WF readiness 超时')); } }, 10); });
  const appWF = express(); appWF.use(express.json()); appWF.use('/api', modWF.router);
  const serverWF = http.createServer(appWF);
  await new Promise((res) => serverWF.listen(0, '127.0.0.1', res));
  const portWF = serverWF.address().port;
  const callWF = (m, p, tok, body) => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const rq = http.request({ host: '127.0.0.1', port: portWF, path: p, method: m, headers }, (rr) => { let b = ''; rr.on('data', (c) => b += c); rr.on('end', () => resolve({ status: rr.statusCode, body: b ? JSON.parse(b) : null })); });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  const runWF = await freshRun();
  const snapWF = await snap(runWF, '13800000001'); // snap 走主 mod（正常回写），仅 confirm 走 modWF
  r = await callWF('POST', `/api/periodic-tasks/runs/${runWF}/push/confirm`, adminTok, { recipients: [snapWF] });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.write_failures) && r.body.write_failures.length === 1, 'M-new：回写失败应带 write_failures');
  assert.strictEqual(r.body.write_failures[0].intended_status, 'success', 'write_failures 记录本应写入的状态');
  assert.ok(r.body.warning && /对账/.test(r.body.warning), 'M-new：顶层 warning 提示人工对账（不静默返回全成功）');
  const wfRow = await get(`SELECT push_status, push_error FROM periodic_task_pushes WHERE run_id = ? ORDER BY id DESC LIMIT 1`, [runWF]);
  assert.strictEqual(wfRow.push_status, 'pending', 'M-new：回写失败的行保持 pending（下次幂等 pending 检查会拦、不重发）');
  assert.ok(typeof wfRow.push_error === 'string' && wfRow.push_error.indexOf('WRITE_FAILED') === 0, 'M（集成点3）：回写失败的行被 best-effort 打上 WRITE_FAILED 标记（push_error 以之为前缀）');
  serverWF.close();
  ok('M-new：阶段三 UPDATE 影响 0 行 → 返回 write_failures+warning、行保持 pending、不误报全成功（钉钉已发但 DB 未落库需对账）');

  // ── [10d] M / M-2（⑤c）端到端：上一步留下的 WRITE_FAILED 卡死 pending → 再 confirm(同 run) 应返
  //   409 NEEDS_RECONCILE（不是 PUSH_IN_PROGRESS）；force=true 覆盖放行重发，且 M-2 supersede：旧 WRITE_FAILED
  //   卡死行**转终态 failed + 追加 SUPERSEDED_BY_FORCE 注记**（留痕在、退出 pending 幂等阻断），新行正常 pending→success。
  r = await call('POST', `/api/periodic-tasks/runs/${runWF}/push/confirm`, adminTok, { recipients: [snapWF] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NEEDS_RECONCILE', 'M：卡死的 WRITE_FAILED pending 再 confirm（非 force）→ 409 NEEDS_RECONCILE');
  const pushCountBeforeForce = (await all(`SELECT COUNT(*) AS c FROM periodic_task_pushes WHERE run_id = ?`, [runWF]))[0].c;
  // 记录旧 WRITE_FAILED 行 id（supersede 前是 pending），供 force 后精确比对该行状态转移
  const staleRowBefore = await get(`SELECT id, push_status FROM periodic_task_pushes WHERE run_id = ? AND push_error LIKE 'WRITE_FAILED%' ORDER BY id DESC LIMIT 1`, [runWF]);
  assert.strictEqual(staleRowBefore.push_status, 'pending', 'M-2 前提：force 前旧 WRITE_FAILED 行确为 pending');
  r = await call('POST', `/api/periodic-tasks/runs/${runWF}/push/confirm`, adminTok, { recipients: [snapWF], force: true });
  assert.strictEqual(r.status, 200, 'M：force=true 覆盖 NEEDS_RECONCILE 放行重发');
  assert.strictEqual(r.body.results[0].status, 'success', 'force 重发本身走正常回写路径（未复用 modWF），应正常 success');
  const pushCountAfterForce = (await all(`SELECT COUNT(*) AS c FROM periodic_task_pushes WHERE run_id = ?`, [runWF]))[0].c;
  assert.strictEqual(pushCountAfterForce, pushCountBeforeForce + 1, 'force 重发新插 1 条留痕，旧 WRITE_FAILED 行转终态但不删除（count 仅 +1=新行）');
  // M-2 核心：旧 WRITE_FAILED 卡死行 force 后转 failed + SUPERSEDED_BY_FORCE 注记（留痕不删、退出 pending 阻断）
  const staleRowAfter = await get(`SELECT push_status, push_error FROM periodic_task_pushes WHERE id = ?`, [staleRowBefore.id]);
  assert.strictEqual(staleRowAfter.push_status, 'failed', 'M-2：force 后旧 WRITE_FAILED 卡死行转终态 failed（退出 pending 幂等阻断）');
  assert.ok(/WRITE_FAILED/.test(staleRowAfter.push_error) && /SUPERSEDED_BY_FORCE/.test(staleRowAfter.push_error), 'M-2：旧行 push_error 保留原 WRITE_FAILED 痕迹 + 追加 |SUPERSEDED_BY_FORCE（历史线索不丢）');
  // M-2 闭合验证：supersede 后该 run 已无 WRITE_FAILED pending → 再非 force confirm 不再被 NEEDS_RECONCILE 拦
  //   （改由已有 success 行判 ALREADY_PUSHED），证明 run 已退出 reconcile 阻断循环。
  r = await call('POST', `/api/periodic-tasks/runs/${runWF}/push/confirm`, adminTok, { recipients: [snapWF] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'ALREADY_PUSHED', 'M-2 闭合：supersede 后再非 force confirm → ALREADY_PUSHED（不再是 NEEDS_RECONCILE，run 退出对账阻断循环）');
  ok('M/M-2（⑤c）端到端：WRITE_FAILED 卡死 pending → NEEDS_RECONCILE；force 放行 + 旧行转 failed+SUPERSEDED_BY_FORCE 退出阻断 + 之后判 ALREADY_PUSHED（reconcile 生命周期闭合）');

  // ── [10e] M-1（⑤c）僵尸 pending push reaper：造超阈值 plain pending（无 WRITE_FAILED 标记）→ 跑
  //   reapStalePendingPushes → 该行补 WRITE_FAILED:stale_reaped 标记且**仍 pending**（PUSH_IN_PROGRESS→可 force 的 NEEDS_RECONCILE）。
  //   同时验三条守卫：① 新鲜 plain pending（未超阈值）不误伤 ② 已带 WRITE_FAILED 标记的行不重复标记 ③ 非 pending 终态行不动。
  const runReap = await freshRun();
  // 超阈值 plain pending（pushed_at 早于阈值窗口）——直接造行，pushed_at 设为 20 分钟前
  const staleIns = await run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at)
    VALUES (?, '13800000091', 'uid_stale', 'pending', NULL, 1, datetime('now','localtime','-20 minutes'))`, [runReap]);
  const staleId = staleIns.lastID;
  // 新鲜 plain pending（just now）——不应被 reaper 动
  const freshIns = await run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at)
    VALUES (?, '13800000092', 'uid_fresh', 'pending', NULL, 1, datetime('now','localtime'))`, [runReap]);
  const freshId = freshIns.lastID;
  // 超阈值但已带 WRITE_FAILED 标记——reaper 守卫应跳过（不重复标记，push_error 保持原值）
  const alreadyIns = await run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at)
    VALUES (?, '13800000093', 'uid_alr', 'pending', 'WRITE_FAILED:success', 1, datetime('now','localtime','-20 minutes'))`, [runReap]);
  const alreadyId = alreadyIns.lastID;
  // 超阈值终态 success 行——非 pending，reaper 不动
  const doneIns = await run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at)
    VALUES (?, '13800000094', 'uid_done', 'success', NULL, 1, datetime('now','localtime','-20 minutes'))`, [runReap]);
  const doneId = doneIns.lastID;

  await I.reapStalePendingPushes();  // require 真实 _internals 逻辑（禁复刻）
  const staleAfter = await get(`SELECT push_status, push_error FROM periodic_task_pushes WHERE id = ?`, [staleId]);
  assert.strictEqual(staleAfter.push_status, 'pending', 'M-1：超阈值僵尸 pending reaper 后**仍 pending**（只补标记不改状态）');
  assert.strictEqual(staleAfter.push_error, 'WRITE_FAILED:stale_reaped', 'M-1：超阈值僵尸 pending 补 WRITE_FAILED:stale_reaped 标记（PUSH_IN_PROGRESS→NEEDS_RECONCILE 可 force）');
  const freshAfter = await get(`SELECT push_status, push_error FROM periodic_task_pushes WHERE id = ?`, [freshId]);
  assert.strictEqual(freshAfter.push_error, null, 'M-1 守卫①：新鲜 plain pending（未超阈值）不被 reaper 误伤');
  const alreadyAfter = await get(`SELECT push_error FROM periodic_task_pushes WHERE id = ?`, [alreadyId]);
  assert.strictEqual(alreadyAfter.push_error, 'WRITE_FAILED:success', 'M-1 守卫②：已带 WRITE_FAILED 标记的行不被重复标记（push_error 保持原值）');
  const doneAfter = await get(`SELECT push_status, push_error FROM periodic_task_pushes WHERE id = ?`, [doneId]);
  assert.strictEqual(doneAfter.push_status, 'success', 'M-1 守卫③：非 pending 终态行不被 reaper 触碰');
  assert.strictEqual(doneAfter.push_error, null, 'M-1 守卫③：终态行 push_error 不被写入');
  // 幂等验证：再跑一次 reaper，已标记的 stale 行不再变（LIKE WRITE_FAILED% 守卫生效）
  await I.reapStalePendingPushes();
  const staleAfter2 = await get(`SELECT push_error FROM periodic_task_pushes WHERE id = ?`, [staleId]);
  assert.strictEqual(staleAfter2.push_error, 'WRITE_FAILED:stale_reaped', 'M-1：reaper 幂等——二次跑不重复覆盖已标记行');
  assert.strictEqual(I.STALE_PENDING_PUSH_MINUTES, 10, 'M-1：STALE_PENDING_PUSH_MINUTES 常量已导出（=10，对齐 STALE_RUNNING_MINUTES）');
  ok('M-1（⑤c）僵尸 pending push reaper：超阈值 plain pending → 补 WRITE_FAILED:stale_reaped 仍 pending（可 force 恢复）+ 三守卫（新鲜不误伤/已标记不重复/终态不动）+ 幂等');

  // ── [11] invalidStaffIdList 命中 → failed（区别于反查 skipped）；两阶段留痕从 pending→failed ──
  const run11 = await freshRun();
  const snap004 = await snap(run11, '13800000004'); // uid_invalid_staff
  r = await call('POST', `/api/periodic-tasks/runs/${run11}/push/confirm`, adminTok, { recipients: [snap004] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results[0].status, 'failed');
  assert.strictEqual(r.body.results[0].reason, 'invalid_staff');
  const rows11 = await all(`SELECT push_status FROM periodic_task_pushes WHERE run_id = ?`, [run11]);
  assert.strictEqual(rows11[0].push_status, 'failed', '两阶段：pending 按回执降为 failed，无残留 pending');
  ok('确认发送：invalidStaffIdList 命中 → failed（pending→failed），区别于反查失败的 skipped');

  // ── [12] H-3① 两阶段稳健性：发送整体抛异常 → eligible 行落 failed（非卡 pending）──
  const run12 = await freshRun();
  const snap001b = await snap(run12, '13800000001');
  const origSend = sendFileToUserImpl;
  sendFileToUserImpl = async () => { throw Object.assign(new Error('模拟发送网络异常'), { name: 'TypeError' }); };
  r = await call('POST', `/api/periodic-tasks/runs/${run12}/push/confirm`, adminTok, { recipients: [snap001b] });
  sendFileToUserImpl = origSend;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results[0].status, 'failed', '发送抛异常 → failed');
  const rows12 = await all(`SELECT push_status FROM periodic_task_pushes WHERE run_id = ?`, [run12]);
  assert.strictEqual(rows12[0].push_status, 'failed', 'H-3①：发送异常时 pending 被回写 failed，不残留 pending（人已落库有留痕）');
  ok('H-3①：发送整体抛异常 → 先落的 pending 行回写 failed，不卡 pending（发送前必留痕）');

  // ── [13] M-1 手机号去重：重复手机号 → 只处理一次，deduped.by_phone 提示 ──
  const run13 = await freshRun();
  const snap001c = await snap(run13, '13800000001');
  r = await call('POST', `/api/periodic-tasks/runs/${run13}/push/confirm`, adminTok, { recipients: [snap001c, { ...snap001c }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results.length, 1, '重复手机号去重后只剩 1 个收件人');
  assert.strictEqual(r.body.deduped.by_phone, 1, 'deduped.by_phone 提示丢弃 1 个重复号');
  ok('M-1：重复手机号 → 归一化去重（只处理/留痕一次），deduped.by_phone 提示');

  // ── [14] M-1 userid 去重：不同手机号映射同一 userid → 只发一次，另一个 skipped DUPLICATE_USERID ──
  const run14 = await freshRun();
  const snap001d = await snap(run14, '13800000001'); // uid0001
  const snap008 = await snap(run14, '13800000008');  // 也映射 uid0001
  r = await call('POST', `/api/periodic-tasks/runs/${run14}/push/confirm`, adminTok, { recipients: [snap001d, snap008] });
  assert.strictEqual(r.status, 200);
  const statuses14 = r.body.results.map((x) => x.status).sort();
  assert.deepStrictEqual(statuses14, ['skipped', 'success'], '同 userid 两号 → 一发一跳');
  assert.strictEqual(r.body.results.find((x) => x.status === 'skipped').reason, 'DUPLICATE_USERID');
  assert.strictEqual(r.body.deduped.by_userid, 1, 'deduped.by_userid 提示');
  ok('M-1：不同手机号映射同一 userid → 发一次、另一 skipped DUPLICATE_USERID（防同人收重复敏感文件）');

  // ── [15] 确认发送：钉钉凭证缺失（no_config）→ 502，且不产生任何 push 留痕 ──
  const badDeps = { ...deps, readSystemConfig: async () => null };
  const modBad = require('../routes/periodic-fetch')(badDeps);
  modBad.initSchema(); // 同一张 db 表已存在，initSchema 幂等（CREATE TABLE IF NOT EXISTS），只让新实例跑一遍 readiness
  await new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (modBad._internals.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness timeout')); }
    }, 10);
  });
  const appBad = express();
  appBad.use(express.json());
  appBad.use('/api', modBad.router);
  const serverBad = http.createServer(appBad);
  await new Promise((res) => serverBad.listen(0, '127.0.0.1', res));
  const portBad = serverBad.address().port;
  const callBad = (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: portBad, path: p, method, headers }, (rr) => {
      let b = ''; rr.on('data', (c) => b += c); rr.on('end', () => resolve({ status: rr.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const run15 = await freshRun();
  const countBeforeBad = await get(`SELECT COUNT(*) AS c FROM periodic_task_pushes`);
  r = await callBad('POST', `/api/periodic-tasks/runs/${run15}/push/confirm`, adminTok, { recipients: [snap001] });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.code, 'DINGTALK_TOKEN_FAILED');
  assert.strictEqual(r.body.reason, 'no_config');
  const countAfterBad = await get(`SELECT COUNT(*) AS c FROM periodic_task_pushes`);
  assert.strictEqual(countAfterBad.c, countBeforeBad.c, '凭证缺失应整体失败，不产生半吊子 push 留痕');
  serverBad.close();
  ok('确认发送：钉钉凭证缺失(no_config) → 502 DINGTALK_TOKEN_FAILED，且不落任何 push 行（token 检查在两阶段留痕之前）');

  // ── [16] push 必须绑定具体 run_id：不存在的 run → 404 ──
  r = await call('POST', `/api/periodic-tasks/runs/999999/push/confirm`, adminTok, { recipients: [snap001] });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'PERIODIC_RUN_NOT_FOUND');
  ok('确认发送：不存在的 run_id → 404（push 强制绑定具体 run，无"默认推最新"语义）');

  // ── [17] 参数校验：preview phones 空/超限；confirm recipients 超限 ──
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/preview`, adminTok, { phones: [] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'PHONES_REQUIRED');
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/preview`, adminTok, { phones: Array(21).fill('13800000001') });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'TOO_MANY_PHONES');
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/confirm`, adminTok, { recipients: Array(21).fill(snap001) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'TOO_MANY_PHONES');
  ok('参数校验：preview phones 空→PHONES_REQUIRED / 超 20→TOO_MANY_PHONES；confirm recipients 超 20→TOO_MANY_PHONES');

  // ── [18] requireAdmin：无 token → 401（preview + confirm）──
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/preview`, null, { phones: ['13800000001'] });
  assert.strictEqual(r.status, 401);
  r = await call('POST', `/api/periodic-tasks/runs/${runSuccess}/push/confirm`, null, { recipients: [snap001] });
  assert.strictEqual(r.status, 401);
  ok('push/preview + push/confirm 无 token → 401');

  // ── [19] 推送记录列表端点 ──
  r = await call('GET', `/api/periodic-tasks/runs/${run7}/pushes`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.items.length >= 2);
  ok('GET .../pushes：推送记录列表可查（供前端展示审计）');

  // 验证 uploadMedia/sendFileToUser 确实被调用过（发送链路真正跑通，非空转）
  assert.ok(UPLOAD_CALLS.length > 0, 'uploadMedia 应被调用');
  assert.ok(SENT_CALLS.length > 0, 'sendFileToUser 应被调用');
  ok(`发送链路证据：uploadMedia 调用 ${UPLOAD_CALLS.length} 次，sendFileToUser 调用 ${SENT_CALLS.length} 次（非空转）`);
}

function cleanupResultsDir() {
  try {
    const dir = runner.PERIODIC_RESULTS_DIR;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* ignore */ }
}

async function main() {
  mod.initSchema();
  await waitReady();

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;

  await unitTests();
  await endpointTests();

  console.log(`\n[全部通过] ${passed} ✓ 周期取数推送 ④钉钉推送 验证通过`);
  console.log('  覆盖：resolvePushRecipient(6分支)+H-2 三态 + H-new evaluatePushIdempotency单元(含⑤c NEEDS_RECONCILE区分) + L-new compareRecipientSnapshot单元 + 可推送前置(5态) + 预览无副作用+M-1去重 + 确认发送(H-1快照必带/L-new userid硬gate+name漂移warning/H-3两阶段/H-3幂等ALREADY_PUSHED+force/H-new并发pending PUSH_IN_PROGRESS+ROLLBACK/M-new回写失败write_failures+warning+保持pending/⑤c M-2 force supersede旧WRITE_FAILED行转failed退出阻断/⑤c M-1 reapStalePendingPushes僵尸pending复位+三守卫+幂等/发送异常不卡pending/M-1双去重/invalid_staff failed/no_config 502/绑定run_id) + 参数校验 + requireAdmin + 记录列表');
  server.close();
  db.close();
  global.fetch = originalFetch;
  cleanupResultsDir();
}

main().catch((e) => {
  console.error('\n[失败]', e.message, e.stack);
  if (server) server.close();
  db.close();
  global.fetch = originalFetch;
  cleanupResultsDir();
  process.exit(1);
});
