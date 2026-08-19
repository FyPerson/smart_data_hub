// verify-correction-suspend-resume-e2e.js — 数据修正暂缓/恢复 全生命周期 e2e（暂缓与列表导出方案 v1.1 §2.6，编码任务 S3）
//   范式对齐 verify-correction-suspend.js（router-mount + in-memory db + http.request HTTP harness，走真实端点
//   非复刻）+ verify-sys-chat-picker.js 的「模块 mock dingtalk-notify」写法（require 缓存导出后直接覆写函数属性，
//   corrections.js 内 `const dingtalkNotify = require('../utils/dingtalk-notify')` 拿到的是同一缓存对象，
//   覆写在 require corrections.js 前后均生效——遵循既有脚本"必须在 require 路由模块之前"的保守顺序）。
//   钉钉真发无法 e2e——本脚本全程 mock，绝不真发。
// 覆盖：
//   [Full] 真实端点全生命周期：建单(PENDING_ASSIGN)→指派(ASSIGNED_PENDING_ESTIMATE)→暂缓(SUSPENDED，触发群消息①)→
//          恢复(ASSIGNED_PENDING_ESTIMATE，触发群消息②)→重报预计(IN_PROGRESS)→标完成(FIXED)→归档(ARCHIVED)，
//          逐步断言状态与关键字段（dev_estimated_at 清空、suspended_at 保留等）
//   [Msg1] 暂缓/恢复各触发一次 dingtalkNotify.sendGroupMessage 调用，mock 捕获参数含单号 #id
//   [Msg2] 无 dingtalk_open_conversation_id 的单不发（零调用断言）——create-chat 端点 hasChat 判定同一字段
//          （:3024 一带注释已明确区分 dingtalk_chat_id〔摩擦判定〕vs open_conversation_id〔真正用于发送的会话 id〕）
//   [Msg3] sendGroupMessage 抛错时流转仍成功（best-effort 不阻断）：mock 临时切换为抛错版本，暂缓/恢复请求仍 200
//          且 DB 真实落库状态与响应一致（不只信 HTTP 响应）
// 用法：node scripts/verify-correction-suspend-resume-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── 模块 mock dingtalk-notify（在 require routes/corrections 之前，同 verify-sys-chat-picker.js 范式）──
//   预筛 C2b+C3 M1：escapeMarkdown 是纯函数（不触网，见 utils/dingtalk-notify.js:458-464），不 mock——
//   走真实实现，让下方公式/长文本断言测的是真实转义/截断产物，而非"回声"式假象（mock 成恒等函数会让
//   markdown 特殊字符断言恒真，测不出真实转义是否发生）。
const dtn = require('../utils/dingtalk-notify');
const sendGroupMessageCalls = [];
let forceSendThrow = false;
let forceTokenThrow = false;   // 预筛 C2b+C3 L1：token 获取阶段抛错场景（复用 forceSendThrow 范式）
let getAccessTokenCallCount = 0;   // 预筛 C2b+C3 M2：token 调用计数——证明无群场景早退发生在"查群"之后、"取凭证/token"之前
// 预筛 C3c M4：sendGroupMessage 真实失败不抛异常、把失败对象放返回值里（见 utils/dingtalk-notify.js:227-228
//   注释"同 sendMarkdownToUser 一样不抛 errcode 错，放返回里"）——本变量供构造该真实形态（非抛错分支）。
let forceSendFailShape = null;
dtn.getAccessToken = async () => {
  getAccessTokenCallCount++;
  if (forceTokenThrow) throw new Error('mock dingtalk getAccessToken 网络异常');
  return 'mock-token';
};
dtn.sendGroupMessage = async (token, robotCode, openConvId, msgKey, msgParam) => {
  sendGroupMessageCalls.push({ token, robotCode, openConvId, msgKey, msgParam });
  if (forceSendThrow) throw new Error('mock dingtalk sendGroupMessage 网络异常');
  if (forceSendFailShape) return forceSendFailShape;
  return { code: 0 };
};

// 预筛 C2b+C3 M1②：卡片内理由/说明截断阈值从 corrections.js 磁盘源码动态提取（非手写复刻魔数）——
//   源码改了阈值，本文件断言自动跟随，不需要人记得同步改这里；提不到直接判定失败（fail-loud，不静默
//   退化为猜测值继续跑）。
const CORR_ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'corrections.js'), 'utf8');
const THRESHOLD_RE = /reasonRaw\.length > (\d+) \? reasonRaw\.slice\(0, \1\) \+ '…' : reasonRaw/;
const thresholdMatch = CORR_ROUTES_SRC.match(THRESHOLD_RE);
assert(thresholdMatch, 'corrections.js 暂缓卡片理由截断阈值可定位（正则需随实现同步维护，找不到=提取失败，判定失败而非猜测继续）');
const CARD_BRIEF_THRESHOLD = parseInt(thresholdMatch[1], 10);
// 恢复说明（NIT1 新增行）沿用同一截断阈值——单独提取 + 对拍，防两处未来各自漂移却无人发现。
const NOTE_THRESHOLD_RE = /noteRaw\.length > (\d+) \? noteRaw\.slice\(0, \1\) \+ '…' : noteRaw/;
const noteThresholdMatch = CORR_ROUTES_SRC.match(NOTE_THRESHOLD_RE);
assert(noteThresholdMatch, 'corrections.js 恢复说明卡片截断阈值可定位（NIT1 新增行）');
assert.strictEqual(parseInt(noteThresholdMatch[1], 10), CARD_BRIEF_THRESHOLD, '恢复说明与暂缓理由的卡片截断阈值一致（同 120 规则，两处未来若各自改动会在此判红）');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-suspend-resume-e2e-' + process.pid);
fs.mkdirSync(TMP_UPLOAD, { recursive: true });

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};
const an = async () => ({});

let forceConfigMissing = false;   // 预筛 C2b+C3 L2：临时让钉钉配置读取返回空值（未填写场景）
// 预筛 C3c M3/M4：logger.warn 改捕获（范式对齐 verify-sys-release-executors.js:57-58/82 的 warnLogs 数组写法），
//   供断言异常场景确实落了警告日志（而非静默吞掉）。用时机点先 warnLogs.length=0 清空再触发场景，防跨用例残留误报。
const warnLogs = [];
const deps = {
  logger: { info: noop, warn: (...args) => { warnLogs.push(args.join(' ')); }, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: (req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ error: 'no test user' });
    try { req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return next(); } catch (e) { return res.status(401).json({ error: 'bad test user' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' }),
  requirePublisherOrAdmin: (req, res, next) => (req.user && ['admin', 'publisher'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'pub/admin only' }),
  sendIssueDingtalkRaw: an,
  UPLOAD_DIR: TMP_UPLOAD,
  // 钉钉配置齐全（真值即可，getAccessToken 已 mock 不消费具体值）；写成闭包读 forceConfigMissing 而非
  // 固定 async () => 'cfg'——corrections.js 工厂在 require 时就把此函数引用解构进闭包（const { readSystemConfig } = deps），
  // 之后再改 deps.readSystemConfig 属性不会影响已捕获的引用，必须让同一个函数体内部可切换才能测配置缺失分支（同 forceSendThrow/forceTokenThrow 范式）。
  readSystemConfig: async () => (forceConfigMissing ? null : 'cfg'),
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: an,
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),
  safeDeleteFileSync: (rel) => { try { fs.unlinkSync(path.join(TMP_UPLOAD, rel)); } catch (_) {} },
  maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const DEV_A = { id: 5, username: 'devA', display_name: '开发甲', role: 'user' };

function reqJson(method, p, body, user) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, method, path: p,
      headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}

let PORT, srv;
async function waitReady(timeoutMs = 3000) {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) {
    if (I.CORRECTION_SCHEMA_STATE.error) throw new Error('schema error: ' + I.CORRECTION_SCHEMA_STATE.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('readiness timeout');
    await new Promise(r => setTimeout(r, 30));
  }
}

// 建单（真OA留空=自发现模式，业务方静默=建单人自己，无需 oa_proof_files）
async function createCorrection(user) {
  const r = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: 'E2E 暂缓恢复全流程测试单', correction_type: 'single',
    correction_count: 1, reason: 'E2E 暂缓恢复全流程测试原因背景',
  }, user);
  assert(r.status === 200 || r.status === 201, `建单应成功，实得 status=${r.status} body=${JSON.stringify(r.body)}`);
  assert(Number.isInteger(r.body.id) && r.body.id > 0, '建单响应含合法 id');
  return r.body.id;
}

(async () => {
  console.log('=== 数据修正暂缓/恢复全生命周期 e2e（暂缓与列表导出方案 v1.1 §2.6）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role) VALUES (1,'admin','管理员','admin'),(5,'devA','开发甲','user')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ══════════════════ [Full] 真实端点全生命周期（含群消息①②）══════════════════
  console.log('— [Full] 建单→指派→暂缓→恢复→重报预计→标完成→归档（有钉钉群单）—');
  const id1 = await createCorrection(ADMIN);
  const detail0 = await dbGetAsync('SELECT status FROM correction_requests WHERE id=?', [id1]);
  ok(detail0.status === 'PENDING_ASSIGN', `[Full] 建单 #${id1} 初始态 PENDING_ASSIGN`);

  const rAssign = await reqJson('POST', `/api/corrections/${id1}/assign`, { assigned_to: 5 }, ADMIN);
  ok(rAssign.status === 200 && rAssign.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[Full] #${id1} 指派成功 → ASSIGNED_PENDING_ESTIMATE`);

  // 模拟"单据已有钉钉群"：直接落库 dingtalk_chat_id + dingtalk_open_conversation_id（不走真实 create-chat 流程——
  //   本脚本只测暂缓/恢复触发的群消息，不重测建群本身，建群流程已有 verify-sys-chat-picker.js 同类先例）
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id1, 'ocid_' + id1, id1]);

  const callCountBeforeSuspend = sendGroupMessageCalls.length;
  const tokenCallsBeforeSuspend = getAccessTokenCallCount;
  const rSuspend = await reqJson('POST', `/api/corrections/${id1}/suspend`, { reason: '业务源单据尚未闭环，暂停等待客户确认双方口径' }, DEV_A);
  ok(rSuspend.status === 200 && rSuspend.body.status === 'SUSPENDED', `[Full] #${id1} 暂缓成功 → SUSPENDED`);
  ok(sendGroupMessageCalls.length === callCountBeforeSuspend + 1, `[Msg1] #${id1} 暂缓触发恰 1 次 sendGroupMessage 调用`);
  ok(getAccessTokenCallCount === tokenCallsBeforeSuspend + 1, `[Msg4] #${id1} 有群场景暂缓触发恰 1 次 getAccessToken 调用（实得增量 ${getAccessTokenCallCount - tokenCallsBeforeSuspend}）`);
  const suspendCall = sendGroupMessageCalls[sendGroupMessageCalls.length - 1];
  ok(suspendCall.openConvId === 'ocid_' + id1, `[Msg1] #${id1} 暂缓群消息发到正确会话 openConvId`);
  ok(String(suspendCall.msgParam.title || '').includes(`#${id1}`) || String(suspendCall.msgParam.text || '').includes(`#${id1}`),
    `[Msg1] #${id1} 暂缓群消息内容含单号 #${id1}`);
  ok(String(suspendCall.msgParam.text || '').includes('已暂缓') && String(suspendCall.msgParam.text || '').includes('业务源单据尚未闭环'),
    `[Msg1] #${id1} 暂缓群消息含"已暂缓"字样与理由摘要`);

  const callCountBeforeResume = sendGroupMessageCalls.length;
  const tokenCallsBeforeResume = getAccessTokenCallCount;
  const rResume = await reqJson('POST', `/api/corrections/${id1}/resume`, {}, DEV_A);
  ok(rResume.status === 200 && rResume.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[Full] #${id1} 恢复成功 → ASSIGNED_PENDING_ESTIMATE`);
  ok(sendGroupMessageCalls.length === callCountBeforeResume + 1, `[Msg1] #${id1} 恢复触发恰 1 次 sendGroupMessage 调用`);
  ok(getAccessTokenCallCount === tokenCallsBeforeResume + 1, `[Msg4] #${id1} 有群场景恢复触发恰 1 次 getAccessToken 调用（实得增量 ${getAccessTokenCallCount - tokenCallsBeforeResume}）`);
  const resumeCall = sendGroupMessageCalls[sendGroupMessageCalls.length - 1];
  ok(String(resumeCall.msgParam.title || '').includes(`#${id1}`) || String(resumeCall.msgParam.text || '').includes(`#${id1}`),
    `[Msg1] #${id1} 恢复群消息内容含单号 #${id1}`);
  ok(String(resumeCall.msgParam.text || '').includes('已恢复') && String(resumeCall.msgParam.text || '').includes('重新回复预计完成时间'),
    `[Msg1] #${id1} 恢复群消息含"已恢复"字样与"重新回复预计完成时间"提示`);
  ok(!String(resumeCall.msgParam.text || '').includes('恢复说明'), `[NIT1] #${id1} 恢复不带 note → 卡片不含「恢复说明」行（死参消除后仍保持"无 note 不加行"）`);
  const rowAfterResume = await dbGetAsync('SELECT dev_estimated_at, suspended_at FROM correction_requests WHERE id=?', [id1]);
  ok(rowAfterResume.dev_estimated_at === null, `[Full] #${id1} 恢复后 dev_estimated_at 清空`);
  ok(rowAfterResume.suspended_at !== null, `[Full] #${id1} 恢复后 suspended_at 保留（曾暂缓留痕）`);

  const rEstimate = await reqJson('POST', `/api/corrections/${id1}/reply-estimate`, { dev_estimated_at: '2026-09-01 10:00:00' }, DEV_A);
  ok(rEstimate.status === 200 && rEstimate.body.status === 'IN_PROGRESS', `[Full] #${id1} 重报预计成功 → IN_PROGRESS`);

  const rComplete = await reqJson('POST', `/api/corrections/${id1}/complete`, { batch_completion_note: '已完成修正，字段值已核对更新' }, DEV_A);
  ok(rComplete.status === 200 && rComplete.body.status === 'FIXED', `[Full] #${id1} 标完成成功 → FIXED`);

  const callCountBeforeArchive = sendGroupMessageCalls.length;
  const rArchive = await reqJson('POST', `/api/corrections/${id1}/archive`, { friction_reason: 'E2E 归档摩擦原因（本单已建群，须填）' }, ADMIN);
  ok(rArchive.status === 200 && rArchive.body.status === 'ARCHIVED', `[Full] #${id1} 归档成功 → ARCHIVED（全流程走通）`);
  ok(sendGroupMessageCalls.length === callCountBeforeArchive, `[Msg1] #${id1} 归档不触发群消息（暂缓/恢复之外的转移零调用）`);

  // ══════════════════ [Msg2] 无钉钉群的单不发（零调用断言）══════════════════
  console.log('— [Msg2] 无钉钉群单：暂缓/恢复均零调用 —');
  const id2 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id2}/assign`, { assigned_to: 5 }, ADMIN);
  const row2Before = await dbGetAsync('SELECT dingtalk_open_conversation_id FROM correction_requests WHERE id=?', [id2]);
  ok(row2Before.dingtalk_open_conversation_id === null, `[Msg2] #${id2} 前置：dingtalk_open_conversation_id 为空（未建群）`);
  const callCountBefore2 = sendGroupMessageCalls.length;
  const tokenCallsBefore2 = getAccessTokenCallCount;
  const rSuspend2 = await reqJson('POST', `/api/corrections/${id2}/suspend`, { reason: '无群单暂缓测试' }, DEV_A);
  ok(rSuspend2.status === 200 && rSuspend2.body.status === 'SUSPENDED', `[Msg2] #${id2} 暂缓成功（无群不影响流转）`);
  const rResume2 = await reqJson('POST', `/api/corrections/${id2}/resume`, {}, DEV_A);
  ok(rResume2.status === 200 && rResume2.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[Msg2] #${id2} 恢复成功（无群不影响流转）`);
  ok(sendGroupMessageCalls.length === callCountBefore2, `[Msg2] #${id2} 暂缓+恢复全程零次 sendGroupMessage 调用（无 dingtalk_open_conversation_id 不发）`);
  ok(getAccessTokenCallCount === tokenCallsBefore2, `[Msg4] #${id2} 无群场景暂缓+恢复全程零次 getAccessToken 调用（证明早退发生在"查群"之后、取凭证/token 之前，增量 ${getAccessTokenCallCount - tokenCallsBefore2}）`);

  // ══════════════════ [Msg3] sendGroupMessage 抛错时流转仍成功（best-effort 不阻断）══════════════════
  console.log('— [Msg3] 群消息发送异常不阻断暂缓/恢复流转 —');
  const id3 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id3}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id3, 'ocid_' + id3, id3]);
  forceSendThrow = true;
  const callCountBefore3 = sendGroupMessageCalls.length;
  const rSuspend3 = await reqJson('POST', `/api/corrections/${id3}/suspend`, { reason: '群消息异常场景暂缓测试' }, DEV_A);
  ok(rSuspend3.status === 200 && rSuspend3.body.status === 'SUSPENDED', `[Msg3] #${id3} sendGroupMessage 抛错，暂缓 HTTP 响应仍 200/SUSPENDED`);
  const row3AfterSuspend = await dbGetAsync('SELECT status FROM correction_requests WHERE id=?', [id3]);
  ok(row3AfterSuspend.status === 'SUSPENDED', `[Msg3] #${id3} DB 真实落库状态确为 SUSPENDED（不只信 HTTP 响应，防假绿）`);
  ok(sendGroupMessageCalls.length === callCountBefore3 + 1, `[Msg3] #${id3} 暂缓仍尝试调用了 sendGroupMessage（抛错前已计入 mock 调用记录）`);

  const rResume3 = await reqJson('POST', `/api/corrections/${id3}/resume`, {}, DEV_A);
  ok(rResume3.status === 200 && rResume3.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[Msg3] #${id3} sendGroupMessage 抛错，恢复 HTTP 响应仍 200/ASSIGNED_PENDING_ESTIMATE`);
  const row3AfterResume = await dbGetAsync('SELECT status, dev_estimated_at FROM correction_requests WHERE id=?', [id3]);
  ok(row3AfterResume.status === 'ASSIGNED_PENDING_ESTIMATE' && row3AfterResume.dev_estimated_at === null,
    `[Msg3] #${id3} DB 真实落库状态确为 ASSIGNED_PENDING_ESTIMATE 且 dev_estimated_at 清空（不只信 HTTP 响应）`);
  forceSendThrow = false;

  // ══════════════════ [Msg5] 暂缓理由含 markdown 特殊字符 → 卡片含真实转义形态 ══════════════════
  console.log('— [Msg5] 暂缓理由 markdown 特殊字符 → 真实 escapeMarkdown 转义（M1，非 mock 回声）—');
  const id4 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id4}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id4, 'ocid_' + id4, id4]);
  const mdSample = '## [x](http://y) *b*';
  const mdExpected = dtn.escapeMarkdown(mdSample);   // 以真实实现的输出为准取证（M1 要求），非手写猜测转义结果
  ok(mdExpected !== mdSample, '[Msg5] 前置：真实 escapeMarkdown 对样例确有转义（否则本组断言测不出真假 mock 的差异，即 M1 要修的坑）');
  const callCountBefore4 = sendGroupMessageCalls.length;
  const rSuspend4 = await reqJson('POST', `/api/corrections/${id4}/suspend`, { reason: mdSample }, DEV_A);
  ok(rSuspend4.status === 200 && rSuspend4.body.status === 'SUSPENDED', `[Msg5] #${id4} 暂缓成功 → SUSPENDED`);
  ok(sendGroupMessageCalls.length === callCountBefore4 + 1, `[Msg5] #${id4} 暂缓触发恰 1 次 sendGroupMessage 调用`);
  const mdCall = sendGroupMessageCalls[sendGroupMessageCalls.length - 1];
  ok(String(mdCall.msgParam.text || '').includes(mdExpected), `[Msg5] #${id4} 卡片 text 含真实转义后的理由形态（期望片段 ${JSON.stringify(mdExpected)}）`);

  // ══════════════════ [Msg5b] 暂缓理由超长（130+ 字）→ 卡片按截断阈值裁剪 + 省略号 ══════════════════
  console.log('— [Msg5b] 暂缓理由超长 → 卡片截断（阈值取自 corrections.js 磁盘现值，见文件头动态提取）—');
  const id5 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id5}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id5, 'ocid_' + id5, id5]);
  const longReason = '业务方反馈'.repeat(25) + '（共130字以上超长理由，用于验证卡片截断阈值）';   // 149 字，留足余量非踩线样例
  ok(longReason.length > CARD_BRIEF_THRESHOLD + 10, `[Msg5b] 前置：样例长度 ${longReason.length} 确实超过阈值 ${CARD_BRIEF_THRESHOLD}（留足余量，非踩线样例）`);
  const expectedBrief = dtn.escapeMarkdown(longReason.slice(0, CARD_BRIEF_THRESHOLD) + '…');
  const rSuspend5 = await reqJson('POST', `/api/corrections/${id5}/suspend`, { reason: longReason }, DEV_A);
  ok(rSuspend5.status === 200 && rSuspend5.body.status === 'SUSPENDED', `[Msg5b] #${id5} 暂缓成功 → SUSPENDED`);
  const longCall = sendGroupMessageCalls[sendGroupMessageCalls.length - 1];
  ok(String(longCall.msgParam.text || '').includes('…'), `[Msg5b] #${id5} 卡片 text 含省略号（超长截断标记）`);
  ok(String(longCall.msgParam.text || '').includes(expectedBrief), `[Msg5b] #${id5} 卡片 text 含"前 ${CARD_BRIEF_THRESHOLD} 字符+…"截断片段（期望 ${JSON.stringify(expectedBrief)}）`);
  ok(!String(longCall.msgParam.text || '').includes(longReason), `[Msg5b] #${id5} 卡片 text 不含完整未截断理由（证明真被裁剪，非巧合子串命中）`);

  // ══════════════════ [Msg6] getAccessToken 抛错时流转仍成功（best-effort 不阻断，L1）══════════════════
  console.log('— [Msg6] token 获取异常不阻断暂缓/恢复流转 —');
  const id6 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id6}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id6, 'ocid_' + id6, id6]);
  forceTokenThrow = true;
  const tokenCallsBefore6a = getAccessTokenCallCount;
  warnLogs.length = 0;
  const rSuspend6 = await reqJson('POST', `/api/corrections/${id6}/suspend`, { reason: 'token 异常场景暂缓测试' }, DEV_A);
  ok(rSuspend6.status === 200 && rSuspend6.body.status === 'SUSPENDED', `[Msg6] #${id6} getAccessToken 抛错，暂缓 HTTP 响应仍 200/SUSPENDED`);
  const row6AfterSuspend = await dbGetAsync('SELECT status FROM correction_requests WHERE id=?', [id6]);
  ok(row6AfterSuspend.status === 'SUSPENDED', `[Msg6] #${id6} DB 真实落库状态确为 SUSPENDED（不只信 HTTP 响应，防假绿）`);
  ok(getAccessTokenCallCount === tokenCallsBefore6a + 1, `[Msg6][M3] #${id6} 暂缓场景 getAccessToken 调用增量恰 1（证明真走到了 token 调用点，非早退，实得增量 ${getAccessTokenCallCount - tokenCallsBefore6a}）`);
  ok(warnLogs.some(w => w.includes('mock dingtalk getAccessToken 网络异常')), `[Msg6][M3] #${id6} 暂缓场景 logger.warn 记录含 token 异常关键字（实得 warnLogs=${JSON.stringify(warnLogs)}）`);

  const tokenCallsBefore6b = getAccessTokenCallCount;
  warnLogs.length = 0;
  const rResume6 = await reqJson('POST', `/api/corrections/${id6}/resume`, {}, DEV_A);
  ok(rResume6.status === 200 && rResume6.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[Msg6] #${id6} getAccessToken 抛错，恢复 HTTP 响应仍 200/ASSIGNED_PENDING_ESTIMATE`);
  const row6AfterResume = await dbGetAsync('SELECT status, dev_estimated_at FROM correction_requests WHERE id=?', [id6]);
  ok(row6AfterResume.status === 'ASSIGNED_PENDING_ESTIMATE' && row6AfterResume.dev_estimated_at === null,
    `[Msg6] #${id6} DB 真实落库状态确为 ASSIGNED_PENDING_ESTIMATE 且 dev_estimated_at 清空（不只信 HTTP 响应）`);
  ok(getAccessTokenCallCount === tokenCallsBefore6b + 1, `[Msg6][M3] #${id6} 恢复场景 getAccessToken 调用增量恰 1（实得增量 ${getAccessTokenCallCount - tokenCallsBefore6b}）`);
  ok(warnLogs.some(w => w.includes('mock dingtalk getAccessToken 网络异常')), `[Msg6][M3] #${id6} 恢复场景 logger.warn 记录含 token 异常关键字（实得 warnLogs=${JSON.stringify(warnLogs)}）`);
  forceTokenThrow = false;

  // ══════════════════ [Msg7] readSystemConfig 返回空 → 200 + sendGroupMessage/getAccessToken 零调用（L2）══════════════════
  console.log('— [Msg7] 钉钉配置缺失（readSystemConfig 返回 null）—');
  const id7 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id7}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id7, 'ocid_' + id7, id7]);
  forceConfigMissing = true;
  const callCountBefore7 = sendGroupMessageCalls.length;
  const tokenCallsBefore7 = getAccessTokenCallCount;
  const rSuspend7 = await reqJson('POST', `/api/corrections/${id7}/suspend`, { reason: '配置缺失场景暂缓测试' }, DEV_A);
  ok(rSuspend7.status === 200 && rSuspend7.body.status === 'SUSPENDED', `[Msg7] #${id7} 配置缺失，暂缓 HTTP 响应仍 200/SUSPENDED`);
  ok(sendGroupMessageCalls.length === callCountBefore7, `[Msg7] #${id7} 配置缺失场景暂缓零次 sendGroupMessage 调用`);
  ok(getAccessTokenCallCount === tokenCallsBefore7, `[Msg7] #${id7} 配置缺失场景暂缓零次 getAccessToken 调用（配置检查先于取 token）`);
  forceConfigMissing = false;

  // ══════════════════ [NIT1] 恢复带 note → 卡片含「恢复说明」行 ══════════════════
  console.log('— [NIT1] 恢复带 note → 卡片含「恢复说明」行（配套 corrections.js reasonOrNote 死参消除）—');
  const id8 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id8}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id8, 'ocid_' + id8, id8]);
  await reqJson('POST', `/api/corrections/${id8}/suspend`, { reason: '恢复说明配套测试暂缓' }, DEV_A);
  const noteSample = '客户已确认口径，可以继续推进';
  const noteExpected = dtn.escapeMarkdown(noteSample);
  const rResume8 = await reqJson('POST', `/api/corrections/${id8}/resume`, { note: noteSample }, DEV_A);
  ok(rResume8.status === 200 && rResume8.body.status === 'ASSIGNED_PENDING_ESTIMATE', `[NIT1] #${id8} 带 note 恢复成功`);
  const resume8Call = sendGroupMessageCalls[sendGroupMessageCalls.length - 1];
  ok(String(resume8Call.msgParam.text || '').includes('恢复说明'), `[NIT1] #${id8} 带 note 恢复 → 卡片含「恢复说明」行`);
  ok(String(resume8Call.msgParam.text || '').includes(noteExpected), `[NIT1] #${id8} 卡片含转义后的 note 内容（期望 ${JSON.stringify(noteExpected)}）`);

  // ══════════════════ [Msg8] sendGroupMessage 返回真实失败对象形态（M4，非抛错分支）══════════════════
  //   取证结论（M4）：GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'——v1.0
  //   新式 OpenAPI 端点，失败形态是字符串 { code, message }（同文件内 BATCH_SEND_URL 同为 v1.0 前缀、
  //   同款注释"不抛 errcode 错，放返回里"）；对照同文件 CHAT_CREATE_URL/MEDIA_UPLOAD_URL 用 oapi.dingtalk.com
  //   老式端点才是数字 { errcode, errmsg }（createChatGroup 的 JSDoc 明写"失败时 { errcode, errmsg }"，
  //   且专供老式端点的 classifyError() 形态 B 只认数字 errcode，从未处理过字符串 code——两条错误处理通道
  //   刻意分工不重叠）。既有 `cardResp && cardResp.code` 判定命中的正是 v1.0 端点真实失败字段名，四处
  //   call site（corrections.js/collab/sys-iteration ×2）写法一致，非误用——**结论：不改生产码**，本组
  //   只补 e2e 用真实形态验证该判定确实生效（而非只测抛错这一种失败路径）。
  console.log('— [Msg8] sendGroupMessage 返回真实失败对象形态（v1.0 OpenAPI {code,message}，M4）—');
  const id9 = await createCorrection(ADMIN);
  await reqJson('POST', `/api/corrections/${id9}/assign`, { assigned_to: 5 }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET dingtalk_chat_id=?, dingtalk_open_conversation_id=? WHERE id=?`, ['chat_' + id9, 'ocid_' + id9, id9]);
  forceSendFailShape = { code: 'InvalidParameter.OpenConversationId', message: 'the openConversationId is invalid' };
  warnLogs.length = 0;
  const rSuspend9 = await reqJson('POST', `/api/corrections/${id9}/suspend`, { reason: '真实失败对象形态测试' }, DEV_A);
  ok(rSuspend9.status === 200 && rSuspend9.body.status === 'SUSPENDED', `[Msg8] #${id9} sendGroupMessage 返回失败对象（非抛错），暂缓 HTTP 响应仍 200/SUSPENDED`);
  const row9AfterSuspend = await dbGetAsync('SELECT status FROM correction_requests WHERE id=?', [id9]);
  ok(row9AfterSuspend.status === 'SUSPENDED', `[Msg8] #${id9} DB 真实落库状态确为 SUSPENDED（不只信 HTTP 响应）`);
  ok(warnLogs.some(w => w.includes(forceSendFailShape.code)), `[Msg8] #${id9} logger.warn 记录含真实失败对象的 code 字段值 "${forceSendFailShape.code}"（证明既有 cardResp.code 判定确实覆盖了这一真实形态，实得 warnLogs=${JSON.stringify(warnLogs)}）`);
  forceSendFailShape = null;

  // 预筛 C2b+C3 NIT3：期望总数硬钉——`${pass}/${pass}` 是自指真理（哪怕中途某代码路径提前 return
  //   漏跑了后半段断言，pass 仍等于它自己，永远显示"全部通过"）。这里钉一个在本文件当前形态下跑一遍
  //   实测得到的字面量总数，任何一条断言少跑/漏跑都会让 pass 与之不等，判定失败而非静默"看起来全绿"。
  //   本文件后续新增/删减断言时，必须同步改这个数字（不改会立刻在此处报错，逼着维护者正视断言总量变化）。
  const EXPECTED_ASSERTION_COUNT = 56;
  assert.strictEqual(pass, EXPECTED_ASSERTION_COUNT,
    `期望总断言数 ${EXPECTED_ASSERTION_COUNT}，实得 ${pass}——不等于说明中途有代码路径提前 return 漏跑了断言（防"${pass}/${pass} 自指真理"假绿）`);

  console.log(`\n[全部通过] ${pass}/${pass} ✓ 数据修正暂缓/恢复全生命周期 e2e 验证通过（暂缓与列表导出方案 v1.1 §2.6：全流程+群消息触发+无群零调用+异常不阻断）`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('\n✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} try { db.close(); } catch (_) {} try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
