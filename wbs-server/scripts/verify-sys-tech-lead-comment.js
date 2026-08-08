// 验证脚本：系统迭代 角色权限重构 C3+C4 — 技术负责人评估留言 + 换轮合法化（方案 v2.1·C2.5 撤销后改写）
//   用法：node scripts/verify-sys-tech-lead-comment.js
//
// ⭐⭐ 背景（v2.1 改写）：C2.5「预沟通段/待商议」已被彻底撤销——三类型建单统一直落「待受理」。
//   tech-lead-comment / cancel-consult 两个端点的开放态谓词随之改为**全类型统一「待受理」**
//   （不再硬编码「待商议」、也不再是"只服务变更流"的裁量）：
//   ① POST /sys-issues/:id/tech-lead-comment（技术负责人提交一条不可变的最终评估意见）
//   ② POST /sys-issues/:id/cancel-consult（admin/受理人取消尚未回复的咨询）
//   两者现与 request-tech-consult/resend-tech-consult/resend-notify 共用同一开放态谓词「待受理」
//   （全类型），[B] 组把这条新谓词钉成断言。
//
// ⭐⭐ 角色权限重构 C4（用户裁定 PH-1）：世界模型改变——"意见唯一性"从**整单唯一**
//   改为**绑定咨询轮次**。`tech_lead_notify_request_event_id` 标识"当前轮"，轮内唯一（同一轮不可重复提交），
//   但已有意见后 admin/受理人**可以**直接 request 开新轮（旧意见留在 timeline 作历史，不删不改）。
//   原"终局守卫"（本单已有意见即永不可再发起）已整体撤销——那个设计制造了一个死角：新负责人留言撞
//   唯一性约束、取消咨询被"已留言不可取消"挡住，单据永久卡死无法再往下走。[TC] 组由此整体重写为
//   "换轮组"（原"咨询已终局收口"组，含 codex Round-A/Round-C 的历史裁定内容已随撤销一并删除）。
//   ⭐⭐ PH-2 v2.1 改写：原 PH-2 锚定"离开「待商议」"（pre_discuss_pass / issue_reject-from-待商议）的
//   自动清逻辑，随预沟通段撤销一并撤销该锚点，**改锚定到具体离场边**（与建单落态本身脱钩）：
//   intake_return / void（全类型）+ issue_reject（仅 bug，feature/improvement 因前置守卫要求"当前轮
//   已有意见"而使"未回复+reject"这一组合天然不可达）——若挂着一轮"已发起但技术负责人尚未回复"的咨询，
//   原子清空 + 留痕一条 cancel_consult timeline 行；**已回复**的轮次是历史，不清不留痕。见 [PH2] 组。
//
// 覆盖：
//   [P] 权限：非示例发布者(dev) 403 NOT_TECH_LEAD / admin(两个) 403 NOT_TECH_LEAD（不放行 admin）/
//       示例发布者但未被本单咨询 403 NOT_ASSIGNED_TECH_LEAD / 示例发布者本人放行 200
//   [B] 谓词边界：待受理放行（全类型统一，v2.1）·离开该态(如待指派) 409 STATE_CHANGED
//   [U] 一条唯一：重复提交 409 ALREADY_SUBMITTED（确切码）+ 库内仅一条 tech_lead_comment timeline 行
//   [I] 输入面：非字符串/空串/纯空白 400 对应确切码·2001 位 400 TOO_LONG·2000 位边界 200 收·内容按 trim 落库
//   [CX] cancel-consult：已留言 409 ALREADY_COMMENTED + tech_lead_id 未被清·从未发起 409 NO_ACTIVE_CONSULT·
//       未留言时取消成功 + tech_lead_* 九列整组归零·权限 admin/受理人 200，dev/示例发布者自己 403
//   [N] 通知留痕：sent_by 非空 + notify_sent timeline 行存在（action_code='notify_sent'）·通知失败不回滚已提交的意见
//   [M] request/resend-tech-consult 类型分流回归（v2.1：开放态全类型统一「待受理」，无谓词分流）：
//       feature/improvement/bug 均在建单落态（待受理）上可直接发起+重发
//   [RS] tech-lead-comment/resend-notify（补丁·"失败可重试补发入口"）：有意见时补发 200 + timeline
//       新增一条 notify_sent 行·无意见时 409 确切码·无关用户 403 确切码·技术负责人本人/admin/受理人均放行·
//       离开待受理后 409 确切码·⭐ C4 新增：换轮后新轮无意见时补发 409 NO_TECH_LEAD_COMMENT_TO_NOTIFY
//       （不因旧轮意见误判"有意见可补发"）+ 新轮回复后恢复 200
//
// ⭐ 角色权限重构 C4 收口（v2.1 随之改写状态字面量）：
//   [TC] 换轮组（原"咨询已终局收口"组整体重写）：已有意见后 request 新轮 200（换轮合法化，新 event_id≠旧）·
//       新轮无意见时 resend-tech-consult 200·新轮再留言 200 且库内两条 comment 行共存（旧轮不删不改）·
//       新轮内重复提交仍 409 ALREADY_SUBMITTED（轮内唯一不受换轮合法化影响）·新轮已有意见后 resend 改
//       409 ALREADY_COMMENTED（轮内判定，非整单判定）·原子直插意见同样受轮内唯一性拦截（不依赖评论行
//       产生路径）
//   [MN2] S5 通知手动化（方案 v2.1 §6·用户拍板 D4）：request-tech-consult 首发/换轮恒 not_sent + 零发送
//       调用 + 响应不含 superseded + 库内投递字段整组 NULL；resend-tech-consult 才真正触发发送(sent+
//       计数+1)；已留言后 resend 409 ALREADY_COMMENTED 见 [TC]⑥（未受影响）
//   [GN] sysTechConsultGateStatus 改显式映射（v2.1）：'feature'/'improvement'/'bug' 均→待受理·未登记 type→null；
//       调用端（request-tech-consult）对 null 返回 409 REQUEST_TECH_CONSULT_TYPE_INVALID
//   [CR] cancel-consult 换轮诊断分支单元验证：正常场景（无换轮）200；⭐ 换轮诊断分支**无法用两个真实 HTTP
//       请求触达**——前置 SELECT 已挪进 sysBeginImmediate 之内，配合 sysTxnMutex 序列化，两个真实请求之间
//       不存在"读到旧快照、又被别的请求改写"的窗口（这正是本轮修复要保证的性质，见 cancel-consult 端点注释）。
//       故本组不模拟"真实并发换轮"（那不可复现），改用双点故障注入直接验证诊断分支自身的判断逻辑是否正确
//       （① 强制 guarded UPDATE 返回 changes=0 ② 让诊断阶段的 fresh 读取返回一个不同的 event_id），
//       详见组内注释与文件中段的注入实现说明。
//   [RA] reactivate 全链（C4 新增·v2.1 改写落态）：request→comment→issue_reject（PH-2：当前轮已回复→
//       不清不留痕）→ reactivate（回「待受理」+ 清 tech_lead_* 九列）→ 回待受理后 request 新轮 200 →
//       comment 200——原 PH-1 死角场景（旧世界模型下这单会永久卡死）直接变成正向用例。
//   [PH2] PH-2 新增（v2.1 改锚定边）：①未回复+intake_return 200+九列全清+cancel_consult 行含"自动取消"
//       ②未回复+issue_reject(仅 bug·feature/improvement 因前置守卫不可达) 同断言 ③已回复+intake_return
//       字段保留不清不留痕 ④event_id 为 NULL 退化态 comment 提交 409 确切码（不因 NULL 比较放空唯一性）
//       + helper no-op 不误清
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-tech-lead-comment-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

// 钉钉发送 stub：默认成功；置 dingtalkFailNext 造一次 failed（同 verify-sys-notify-sent-by 既有范式）。
// ⭐⭐ 186 号复审 LOW（采纳·撞项目铁律「断言写对了但声称写错了」）：加**发送调用计数**。
//   原 [RN] 组只比对 notify_sent 行数来声称"零通知副作用"，但代码里明确存在"外部发送成功、留痕失败"
//   这条路径（notifyStatus='unknown'），那种情形下行数同样不变——行数不变**证明不了没发送**。
//   计数器直接观测外部调用本身，才配得上"未发送"这个声称。
let dingtalkFailNext = false;
let dingtalkSendCount = 0;
async function mockSendIssueDingtalkRaw() {
  dingtalkSendCount++;
  if (dingtalkFailNext) { dingtalkFailNext = false; return { ok: false, message_key: null, reason: 'network' }; }
  return { ok: true, message_key: 'stub-key-' + Math.random().toString(36).slice(2, 8) };
}
async function mockBaseUrl() { return ''; }

// ⭐ 换轮围栏故障注入（[CR] 组专用）：
//   实测发现"先真实篡改 DB 再调用 cancel"这条路走不通——cancel-consult 的前置 SELECT 现已挪进
//   sysBeginImmediate 之内，若在同一条共享连接上于该 SELECT 与 UPDATE 之间插入一条裸 run() 篡改，
//   这条篡改会成为**同一未提交事务的一部分**；guarded UPDATE 一旦按篡改后的值判定 changes=0，
//   handler 会调 sysRollback()，而 ROLLBACK 会把"篡改"和"guarded UPDATE 的失败尝试"一并撤销——
//   诊断阶段重新 SELECT 时看到的又是篡改前的原值，故换轮分支永远命中不了（曾用真实 DB 写验证，
//   见 _debug_round.js 探测记录：guarded UPDATE 确实因篡改值而 changes=0，但诊断 SELECT 读回的
//   fresh.event_id 与捕获值相等，因为篡改已被同一次 ROLLBACK 撤销）。这恰好说明：本轮修复（前置
//   SELECT 移入事务 + mutex 序列化）已经让"读到旧快照、又被真实并发请求改写"这类窗口在两个真实
//   HTTP 请求之间彻底不可复现——换句话说，[CR] 组要测的换轮分支本身就是"代码存在但真实流量摸不到"
//   的防御性收尾（同 §7.1 已接受的架构风险同类）。
//   故改用双点故障注入，专测"诊断分支自身的判断逻辑"（而非试图从真实并发中把 changes=0 造出来）：
//   ① 命中 cancel-consult 的 guarded UPDATE 时强制返回 changes=0（模拟"这次 UPDATE 没有匹配上任何行"，
//      不管真实原因是什么）；② 命中诊断阶段的 fresh 查询时，把返回的 tech_lead_notify_request_event_id
//      篡改成另一个值（模拟"重新读到的行，其 event_id 与本次捕获的不同"）。两点合起来精确复现
//      "guarded UPDATE 因换轮而 0 命中、诊断阶段应识别出换轮"这条分支的输入条件，而不依赖能否用
//      真实写入在这两条语句之间的极窄窗口里插入一次外部改动。
let injectRoundChangeTargetId = null;
let injectRoundChangeFired = { update: false, select: false };
const CANCEL_CONSULT_GUARDED_UPDATE_MARKER = 'tech_lead_notify_request_event_id IS ? AND status=?';
const CANCEL_CONSULT_FRESH_SELECT_SQL = 'SELECT tech_lead_id, tech_lead_notify_request_event_id, status FROM sys_issues WHERE id = ?';
const runFI = (sql, params = []) => {
  if (injectRoundChangeTargetId != null && sql.includes(CANCEL_CONSULT_GUARDED_UPDATE_MARKER) && params.includes(injectRoundChangeTargetId)) {
    injectRoundChangeFired.update = true;
    return Promise.resolve({ changes: 0 });
  }
  return run(sql, params);
};
// ⭐⭐ 186 号 MED（resend-notify 发送前二次确认）专用注入：
//   与 [CR] 组同一处境——二次确认要挡的是"读取校验后、外部发送前被换轮"这条窗口，而两次 dbGet 之间
//   没有任何可供外部 HTTP 请求插入的时机（单线程 + 共享连接），真实并发摸不到。故同样改为故障注入，
//   专测"二次确认分支自身的判断逻辑"：命中新增的 fresh 查询时把 ev 篡改成另一个值，模拟"重读发现
//   轮次已变"。⚠️ 用例必须断言注入**真的命中过**（injectResendRoundFired），否则 SQL 串一改就变成
//   永远走正常路径的假绿——这是 [CR] 组已经踩明白的坑。
let injectResendRoundTargetId = null;
let injectResendRoundFired = false;
const RESEND_NOTIFY_FRESH_SELECT_SQL = 'SELECT status, tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?';
const getFI = async (sql, params = []) => {
  const result = await get(sql, params);
  if (injectResendRoundTargetId != null && sql === RESEND_NOTIFY_FRESH_SELECT_SQL && params[0] === injectResendRoundTargetId && result) {
    injectResendRoundFired = true;
    injectResendRoundTargetId = null;   // 一次性·避免污染后续用例
    return { ...result, ev: Number(result.ev || 0) + 999999 };
  }
  if (injectRoundChangeTargetId != null && sql === CANCEL_CONSULT_FRESH_SELECT_SQL && params[0] === injectRoundChangeTargetId && result) {
    injectRoundChangeFired.select = true;
    injectRoundChangeTargetId = null;   // 双点均已触发·本次注入到此结束
    return { ...result, tech_lead_notify_request_event_id: Number(result.tech_lead_notify_request_event_id) + 999999 };
  }
  return result;
};

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: runFI, dbGetAsync: getFI, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
  getSafePlatformBaseUrl: mockBaseUrl,
});
const I = mod._internals;
const T = require('../routes/sys-iteration/transitions');

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

// ⚠️ 测试 id 与生产 users.id 无对应关系（授权只看 JWT role 与白名单常量）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '管理员乙', role: 'admin' }, SECRET);   // 生产 6 admin 最小建模：admin 也不该放行
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const create = (type, extra = {}) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: 2, type, title: `${type}-C3评估`, system_name: 'BMS', source: '内部',
    description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });
const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const consult = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/request-tech-consult`, tok, { tech_lead_id: 7 });
// ⭐⭐ C5 末次合并审 HIGH（186 号·轮次围栏）：tech-lead-comment 新增必填 expected_request_event_id。
//   helper 默认**自动取库里的当前轮**——既有用例语义全部是"正常流程下本轮提交"，自动取值让它们保持
//   原语义不变（不是为了让断言凑绿，而是这些用例本来测的就不是轮次围栏这件事）。
//   第 4 参显式传值 = 专门测围栏的新用例（传旧轮 id / 错误值 / null）。
//   ⚠️ 取不到轮次（单不存在 / 无活动轮）时如实传 null → 后端 400 REQUIRED，不伪造哨兵值掩盖。
const currentRound = async (id) => {
  const r = await get('SELECT tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id]);
  return r ? r.ev : null;
};
const comment = async (id, tok, text, expectedEventId) => call('POST', `/api/sys-issues/${id}/tech-lead-comment`, tok,
  { comment: text, expected_request_event_id: expectedEventId !== undefined ? expectedEventId : await currentRound(id) });
const cancel = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/cancel-consult`, tok, {});
const resendNotify = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/tech-lead-comment/resend-notify`, tok, {});
const TECH_LEAD_COLS = ['tech_lead_id', 'tech_lead_name', 'tech_lead_notify_request_event_id', 'tech_lead_notify_status',
  'tech_lead_notified_at', 'tech_lead_notify_message_key', 'tech_lead_read_at', 'tech_lead_notify_error', 'tech_lead_notify_sent_by'];
const assertTechLeadCleared = (row) => {
  assert.strictEqual(row.tech_lead_notify_status, 'not_sent', 'tech_lead_notify_status=not_sent（整组归零）');
  for (const c of TECH_LEAD_COLS.filter(x => x !== 'tech_lead_notify_status')) {
    assert.strictEqual(row[c], null, `${c} = NULL（整组归零）`);
  }
};

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(2,'admin2','管理员乙','admin','13800000002'),
    (5,'dev','开发王','user','13800000005'),(7,'shenjun','示例发布者','publisher','13800000007'),
    (13,'wangtaotao','示例对接人','user','13800000013')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });
  ok('readiness ready + HTTP harness（admin1/admin2 / 受理人13 / 技术负责人7 / dev5）');

  // ═══ [G] sysTechConsultGateStatus 单一来源：单元直测分流值（v2.1：全类型归一「待受理」）═══
  {
    assert.strictEqual(I.sysTechConsultGateStatus('feature'), '待受理', 'feature 分流 = 待受理（v2.1：C2.5 撤销）');
    assert.strictEqual(I.sysTechConsultGateStatus('improvement'), '待受理', 'improvement 分流 = 待受理（v2.1：C2.5 撤销）');
    assert.strictEqual(I.sysTechConsultGateStatus('bug'), '待受理', 'bug 分流 = 待受理（不变）');
    ok('[G] sysTechConsultGateStatus 单一来源：v2.1 起全类型统一→待受理（无分流）');
  }

  // ═══ [M] request/resend-tech-consult 类型分流回归：v2.1 起开放态全类型统一「待受理」，无谓词分流 ═══
  {
    // feature：建单落待受理 → 可直接发起咨询 → 可重发
    const cf = await create('feature');
    const idf = cf.body.id;
    assert.strictEqual(await statusOf(idf), '待受理', 'feature 建单落待受理（v2.1：C2.5 撤销）');
    const rqf = await consult(idf);
    assert.strictEqual(rqf.status, 200, `feature 待受理态 request-tech-consult 200, got ${rqf.status} ${JSON.stringify(rqf.body)}`);
    const rsf = await call('POST', `/api/sys-issues/${idf}/resend-tech-consult`, liaisonTok, { expected_request_event_id: rqf.body.request_event_id });
    assert.strictEqual(rsf.status, 200, `feature 待受理态 resend-tech-consult 200, got ${rsf.status} ${JSON.stringify(rsf.body)}`);
    // bug：建单同样落待受理 → 可直接发起咨询（既有能力）→ 可重发
    const cb = await create('bug');
    const idb = cb.body.id;
    assert.strictEqual(await statusOf(idb), '待受理', 'bug 建单落待受理（不变）');
    const rqb = await consult(idb);
    assert.strictEqual(rqb.status, 200, `bug 待受理态 request-tech-consult 200（既有能力保留）, got ${rqb.status} ${JSON.stringify(rqb.body)}`);
    const rsb = await call('POST', `/api/sys-issues/${idb}/resend-tech-consult`, liaisonTok, { expected_request_event_id: rqb.body.request_event_id });
    assert.strictEqual(rsb.status, 200, `bug 待受理态 resend-tech-consult 200（既有能力保留）, got ${rsb.status} ${JSON.stringify(rsb.body)}`);
    ok('[M] request/resend-tech-consult 类型分流回归：feature/bug 均在待受理放行（v2.1：谓词统一·零回归）');
  }

  // ═══ [P] tech-lead-comment 权限：非示例发布者 403 / admin 也 403（不放行）/ 未被本单咨询 403 / 示例发布者本人 200 ═══
  {
    const c = await create('feature');
    const id = c.body.id;
    await consult(id);   // tech_lead_id=7，仍在待受理
    const r1 = await comment(id, devTok, '开发的意见');
    assert.strictEqual(r1.status, 403, `dev 提交应 403, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'NOT_TECH_LEAD', 'dev 应为 NOT_TECH_LEAD');
    const r2 = await comment(id, adminTok, 'admin 的意见');
    assert.strictEqual(r2.status, 403, `admin 提交应 403（不放行 admin）, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'NOT_TECH_LEAD', 'admin 应为 NOT_TECH_LEAD（与 dev 同码，判定不看 role）');
    const r3 = await comment(id, admin2Tok, '第二个 admin 的意见');
    assert.strictEqual(r3.status, 403, `admin2 提交应同样 403, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'NOT_TECH_LEAD', 'admin2 应为 NOT_TECH_LEAD');
    // 未被本单咨询（新建一单，示例发布者未获指派）
    // ⭐ 186 号 HIGH（轮次围栏）·诊断=实现变了非断言错：本单从未 consult，库里无活动轮，helper 自动取值
    //   会传 null → 撞上**参数校验 400**，走不到本组真正要测的**本人门 403**。显式传一个合法正整数
    //   隔离参数维度（与既有范式一致：resend-tech-consult 的参数 400 同样排在权限判定之前）——
    //   期望值仍是 403 NOT_ASSIGNED_TECH_LEAD，断言本身不动。
    const c2 = await create('feature');
    const r4 = await comment(c2.body.id, techTok, '示例发布者尝试对未咨询单提交', 999999);
    assert.strictEqual(r4.status, 403, `未被咨询单示例发布者提交应 403, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.code, 'NOT_ASSIGNED_TECH_LEAD', '未被咨询应为 NOT_ASSIGNED_TECH_LEAD');
    // 示例发布者本人（已被咨询单）放行
    const r5 = await comment(id, techTok, '这是我的最终评估意见：技术上可行，建议排期。');
    assert.strictEqual(r5.status, 200, `示例发布者本人提交应 200, got ${r5.status} ${JSON.stringify(r5.body)}`);
    ok('[P] 权限：dev/admin/admin2 均 403 NOT_TECH_LEAD（不放行 admin）·未被本单咨询 403 NOT_ASSIGNED_TECH_LEAD·示例发布者本人 200');
  }

  // ═══ [B] 谓词边界（v2.1 全面改写）：待受理放行（feature/bug 均验·已在 [P]/[M] 验过 feature）
  //   ·离开该态(待指派) 409 STATE_CHANGED（feature/bug 各验一次·不再有 type 分流）═══
  //   ⭐ v2.1：原 PH-2 锚定"离开「待商议」"，随预沟通段撤销已改锚定到 intake_return/void（[PH2] 组），
  //   与 tech-lead-comment 的谓词检查（本组）互不相关——离开「待受理」走的是别的边（如 intake_accept），
  //   本组用原子 SQL 直接改 status 隔离，只测"状态谓词"这一件事，不牵动 PH-2 的自动清逻辑。
  {
    // ① feature：离开待受理 → 409（正例已在 [P]/[M] 验过：consult 后仍在待受理，示例发布者可提交 200）
    const c = await create('feature');
    const id = c.body.id;
    await consult(id);
    await run(`UPDATE sys_issues SET status='待指派' WHERE id=?`, [id]);
    assert.strictEqual(await statusOf(id), '待指派', '前置：单据已离开待受理进入待指派');
    const r = await comment(id, techTok, '离开待受理后再提交');
    assert.strictEqual(r.status, 409, `待指派态提交应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'TECH_LEAD_COMMENT_STATE_CHANGED', '应为 TECH_LEAD_COMMENT_STATE_CHANGED');
    const tlCount = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id])).c;
    assert.strictEqual(tlCount, 0, '被拒后零 tech_lead_comment 行（零副作用）');
    // ② bug：v2.1 起谓词全类型统一「待受理」——bug 单在待受理态同样可提交（正例，回归 [M] 已隐含验证的
    //   uniform 行为，这里独立补一次正向断言防漏检）；离开待受理同样 409（负例，与 feature 对称）。
    const cb = await create('bug');
    const idb = cb.body.id;
    await consult(idb);
    assert.strictEqual(await statusOf(idb), '待受理', 'bug 单发起咨询后仍在待受理（v2.1：与 feature 同一开放态）');
    const rbOk = await comment(idb, techTok, 'bug 单示例发布者提交评估意见');
    assert.strictEqual(rbOk.status, 200, `bug 待受理态提交应 200（v2.1：谓词统一·bug 不再被排除）, got ${rbOk.status} ${JSON.stringify(rbOk.body)}`);
    const cb2 = await create('bug');
    const idb2 = cb2.body.id;
    await consult(idb2);
    await run(`UPDATE sys_issues SET status='待处理' WHERE id=?`, [idb2]);   // bug 的受理后落态（非「待指派」，那是变更流专属）
    const rb = await comment(idb2, techTok, 'bug 单离开待受理后再提交');
    assert.strictEqual(rb.status, 409, `bug 单离开待受理提交应 409, got ${rb.status} ${JSON.stringify(rb.body)}`);
    assert.strictEqual(rb.body.code, 'TECH_LEAD_COMMENT_STATE_CHANGED', 'bug 应为 TECH_LEAD_COMMENT_STATE_CHANGED');
    ok('[B] 谓词边界（v2.1）：待受理放行 feature/bug 均验·离开该态(待指派) 409 STATE_CHANGED feature/bug 均验（谓词已全类型统一，无 type 分流）');
  }

  // ═══ [U] 一条唯一：重复提交 409 ALREADY_SUBMITTED + 库内仅一条 ═══
  {
    const c = await create('feature');
    const id = c.body.id;
    await consult(id);
    const r1 = await comment(id, techTok, '第一次提交的最终意见');
    assert.strictEqual(r1.status, 200, `首次提交 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await comment(id, techTok, '尝试第二次提交');
    assert.strictEqual(r2.status, 409, `重复提交应 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'TECH_LEAD_COMMENT_ALREADY_SUBMITTED', '应为 TECH_LEAD_COMMENT_ALREADY_SUBMITTED（确切码，非弱判据）');
    const rows = await all(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id]);
    assert.strictEqual(rows.length, 1, '库内仅一条 tech_lead_comment 行（重复提交未写入第二条）');
    assert.strictEqual(rows[0].summary, '第一次提交的最终意见', '内容为首次提交的原文（未被第二次覆盖）');
    ok('[U] 一条唯一：重复提交 409 ALREADY_SUBMITTED（确切码）+ 库内仅一条 + 内容未被覆盖');
  }

  // ═══ [I] 输入面：非字符串/空串/纯空白/超长 400 各确切码·2000 位边界 200·内容按 trim 落库 ═══
  {
    const BAD = [
      [123, 'TECH_LEAD_COMMENT_INVALID', 'number 类型'],
      [true, 'TECH_LEAD_COMMENT_INVALID', 'boolean'],
      [null, 'TECH_LEAD_COMMENT_INVALID', 'null'],
      [undefined, 'TECH_LEAD_COMMENT_INVALID', '缺失'],
      ['', 'TECH_LEAD_COMMENT_REQUIRED', '空串'],
      ['   ', 'TECH_LEAD_COMMENT_REQUIRED', '纯空白'],
      ['\n\t  \n', 'TECH_LEAD_COMMENT_REQUIRED', '纯空白（含换行制表符）'],
      ['a'.repeat(2001), 'TECH_LEAD_COMMENT_TOO_LONG', '2001 位超长'],
    ];
    for (const [val, code, label] of BAD) {
      const c = await create('feature');
      const id = c.body.id;
      await consult(id);
      const r = await comment(id, techTok, val);
      assert.strictEqual(r.status, 400, `「${label}」应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, code, `「${label}」应为 ${code}，实际 ${r.body.code}`);
      const tlCount = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id])).c;
      assert.strictEqual(tlCount, 0, `「${label}」被拒后零 tech_lead_comment 行`);
    }
    // 边界：恰 2000 位收（含前后空白 trim 掉不计入 2000）
    const c2 = await create('feature');
    const id2 = c2.body.id;
    await consult(id2);
    const exact2000 = 'x'.repeat(2000);
    const rOk = await comment(id2, techTok, exact2000);
    assert.strictEqual(rOk.status, 200, `恰 2000 位应 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    const saved = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id2]);
    assert.strictEqual(saved.summary.length, 2000, '库内内容恰 2000 位');
    // trim：前后空白不计入内容也不计入长度校验
    const c3 = await create('feature');
    const id3 = c3.body.id;
    await consult(id3);
    const rTrim = await comment(id3, techTok, '  两侧带空白的意见内容  ');
    assert.strictEqual(rTrim.status, 200, `前后空白应 trim 后放行, got ${rTrim.status} ${JSON.stringify(rTrim.body)}`);
    const savedTrim = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id3]);
    assert.strictEqual(savedTrim.summary, '两侧带空白的意见内容', '落库内容为 trim 后的原文（前后空白已去除）');
    ok('[I] 输入面：非字符串/空串/纯空白/超长 400 各确切码 + 零副作用·2000 位边界 200 收·内容按 trim 落库');
  }

  // ═══ [CX] cancel-consult：已留言不可取消 + 未清·从未发起 409·未留言时可取消 + 九列整组归零·权限 ═══
  {
    // 已留言 → 取消应 409 且 tech_lead_id 不被清
    const c1 = await create('feature');
    const id1 = c1.body.id;
    await consult(id1);
    await comment(id1, techTok, '已提交的意见');
    const rc1 = await cancel(id1);
    assert.strictEqual(rc1.status, 409, `已留言单取消应 409, got ${rc1.status} ${JSON.stringify(rc1.body)}`);
    assert.strictEqual(rc1.body.code, 'CANCEL_CONSULT_ALREADY_COMMENTED', '应为 CANCEL_CONSULT_ALREADY_COMMENTED');
    const after1 = await get('SELECT tech_lead_id FROM sys_issues WHERE id=?', [id1]);
    assert.strictEqual(Number(after1.tech_lead_id), 7, '被拒后 tech_lead_id 未被清（仍为 7）');

    // 从未发起 → 取消应 409 NO_ACTIVE_CONSULT
    const c2 = await create('feature');
    const rc2 = await cancel(c2.body.id);
    assert.strictEqual(rc2.status, 409, `从未发起单取消应 409, got ${rc2.status} ${JSON.stringify(rc2.body)}`);
    assert.strictEqual(rc2.body.code, 'CANCEL_CONSULT_NO_ACTIVE_CONSULT', '应为 CANCEL_CONSULT_NO_ACTIVE_CONSULT');

    // 未留言 → 取消成功 + tech_lead_* 九列整组归零
    const c3 = await create('feature');
    const id3 = c3.body.id;
    await consult(id3);
    const before3 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id3]);
    assert.strictEqual(Number(before3.tech_lead_id), 7, '前置：tech_lead_id=7 已写入');
    const rc3 = await cancel(id3);
    assert.strictEqual(rc3.status, 200, `未留言单取消应 200, got ${rc3.status} ${JSON.stringify(rc3.body)}`);
    const after3 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id3]);
    assertTechLeadCleared(after3);
    const cancelTl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id3]);
    assert.ok(cancelTl, 'cancel_consult 落 timeline 审计行');
    // 取消后可重新发起（验证九列真清零、不留半成品拦住下一轮）
    const rq2 = await consult(id3);
    assert.strictEqual(rq2.status, 200, `取消后应可重新发起, got ${rq2.status} ${JSON.stringify(rq2.body)}`);

    // 权限：dev / 示例发布者自己 403（仅 admin/受理人）
    const c4 = await create('feature');
    const id4 = c4.body.id;
    await consult(id4);
    const rDev = await cancel(id4, devTok);
    assert.strictEqual(rDev.status, 403, `dev 取消应 403, got ${rDev.status} ${JSON.stringify(rDev.body)}`);
    const rTech = await cancel(id4, techTok);
    assert.strictEqual(rTech.status, 403, `示例发布者本人取消应 403（取消权=admin∨受理人）, got ${rTech.status} ${JSON.stringify(rTech.body)}`);
    const rAdmin = await cancel(id4, adminTok);
    assert.strictEqual(rAdmin.status, 200, `admin 取消应 200, got ${rAdmin.status} ${JSON.stringify(rAdmin.body)}`);

    // ⭐ 角色权限重构 C4·184 号预审 MED（合并复审收尾·回归用例）：event_id 为 NULL 的退化态（tech_lead_id
    //   有值但 event_id 为 NULL——理论上不该出现，request-tech-consult 恒同时写这两列）→ cancel 应 409
    //   CANCEL_CONSULT_NO_ACTIVE_CONSULT（短路在 guarded UPDATE 之前），且 tech_lead_id 不被清空。
    //   若无此短路：WHERE 的 `event_id IS ?`（NULL→IS NULL）命中该行，NOT EXISTS 子查询的 `id > NULL`
    //   在 SQL 三值逻辑下对任何 timeline 行都不成立而"查无匹配"恒真，两者叠加会让 UPDATE 把这个脏态
    //   当成"可以合法取消的活动轮"清掉——这正是本次要堵的窗口。
    const c5 = await create('feature');
    const id5 = c5.body.id;
    await run(`UPDATE sys_issues SET tech_lead_id=7, tech_lead_name='示例发布者', tech_lead_notify_request_event_id=NULL WHERE id=?`, [id5]);
    const rc5 = await cancel(id5);
    assert.strictEqual(rc5.status, 409, `event_id 为 NULL 的退化态取消应 409, got ${rc5.status} ${JSON.stringify(rc5.body)}`);
    assert.strictEqual(rc5.body.code, 'CANCEL_CONSULT_NO_ACTIVE_CONSULT', '退化态应为 CANCEL_CONSULT_NO_ACTIVE_CONSULT（短路在 guarded UPDATE 之前，不误清一个不存在的轮）');
    const after5 = await get('SELECT tech_lead_id FROM sys_issues WHERE id=?', [id5]);
    assert.strictEqual(Number(after5.tech_lead_id), 7, '退化态被拒后 tech_lead_id 未被清（短路生效，零副作用）');

    ok('[CX] cancel-consult：已留言 409 ALREADY_COMMENTED+未清·从未发起 409 NO_ACTIVE_CONSULT·未留言 200+九列整组归零+可重新发起·权限 admin/受理人 200，dev/示例发布者自己 403·event_id 为 NULL 退化态 409 NO_ACTIVE_CONSULT（短路生效不误清）');
  }

  // ═══ [N] 通知留痕：sent_by 非空 + notify_sent timeline 行存在·通知失败不回滚已提交意见 ═══
  {
    // 正常发送成功
    const c1 = await create('feature');
    const id1 = c1.body.id;
    await consult(id1);
    const r1 = await comment(id1, techTok, '通知正常场景的意见');
    assert.strictEqual(r1.status, 200, `提交应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.notify_status, 'sent', '正常场景 notify_status=sent');
    const nTl1 = await get(`SELECT operator_id, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent' ORDER BY id DESC LIMIT 1`, [id1]);
    assert.ok(nTl1, 'notify_sent timeline 行存在（F8 教训：本通道零持久状态列，timeline 是唯一记录）');
    assert.strictEqual(Number(nTl1.operator_id), 7, 'sent_by（operator_id）= 提交意见的技术负责人 id（7），非空');
    assert.ok(/受理人/.test(nTl1.summary) && /成功/.test(nTl1.summary), 'summary 记录通道=受理人 + 结果=成功');

    // 通知失败：意见仍成功落库，不因通知失败回滚（至少一次投递语义）
    const c2 = await create('feature');
    const id2 = c2.body.id;
    await consult(id2);
    dingtalkFailNext = true;
    const r2 = await comment(id2, techTok, '通知失败场景的意见');
    assert.strictEqual(r2.status, 200, `通知失败不影响意见提交本身仍 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.notify_status, 'failed', '通知失败场景 notify_status=failed');
    const savedComment = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id2]);
    assert.ok(savedComment && savedComment.summary === '通知失败场景的意见', '意见本身已落库，未因通知失败回滚');
    const nTl2 = await get(`SELECT operator_id, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent' ORDER BY id DESC LIMIT 1`, [id2]);
    assert.ok(nTl2, '通知失败场景同样落 notify_sent timeline 行（失败也要留痕，非只记成功）');
    assert.strictEqual(Number(nTl2.operator_id), 7, '通知失败场景 sent_by 仍非空');
    assert.ok(/失败/.test(nTl2.summary), 'summary 记录失败结果');
    ok('[N] 通知留痕：sent_by 非空 + notify_sent timeline 行存在（成功/失败均记）·通知失败不回滚已提交的评估意见');
  }

  // ═══ [RS] tech-lead-comment/resend-notify：失败可重试补发入口（方案 §4-C3 补丁） ═══
  {
    // ① 有意见时补发 → 200 + timeline 新增一条 notify_sent 行（数量 +1）
    const c1 = await create('feature');
    const id1 = c1.body.id;
    await consult(id1);
    await comment(id1, techTok, '已提交的最终意见');
    const before1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'`, [id1])).c;
    const r1 = await resendNotify(id1, liaisonTok);
    assert.strictEqual(r1.status, 200, `有意见时补发应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.notify_status, 'sent', '补发正常场景 notify_status=sent');
    const after1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'`, [id1])).c;
    assert.strictEqual(after1, before1 + 1, '补发应新增一条 notify_sent timeline 行（至少一次语义，不覆盖旧行）');
    const latestTl1 = await get(`SELECT operator_id FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent' ORDER BY id DESC LIMIT 1`, [id1]);
    assert.strictEqual(Number(latestTl1.operator_id), 13, '补发 sent_by=受理人(13)（本次操作者，非首发时的示例发布者7）');

    // ② 无意见时补发 → 409 确切码
    const c2 = await create('feature');
    const id2 = c2.body.id;
    await consult(id2);   // 已被咨询但示例发布者尚未回复
    const r2 = await resendNotify(id2, liaisonTok);
    assert.strictEqual(r2.status, 409, `无意见时补发应 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'NO_TECH_LEAD_COMMENT_TO_NOTIFY', '应为 NO_TECH_LEAD_COMMENT_TO_NOTIFY');

    // ③ 无关用户(dev5) 403 确切码
    const c3 = await create('feature');
    const id3 = c3.body.id;
    await consult(id3);
    await comment(id3, techTok, '意见');
    const r3 = await resendNotify(id3, devTok);
    assert.strictEqual(r3.status, 403, `无关用户补发应 403, got ${r3.status} ${JSON.stringify(r3.body)}`);
    // ⭐ [C10-fix2 MED-3·统一拒绝码] 非 self 非绑定统一 NOT_BOUND_LIAISON（原 NOT_AUTHORIZED_FOR_TECH_LEAD_COMMENT_RESEND 已废）
    assert.strictEqual(r3.body.code, 'NOT_BOUND_LIAISON', '非 self 非绑定应统一为 NOT_BOUND_LIAISON（MED-3 消除本端点独有拒绝语义）');

    // ④ 技术负责人本人 / admin / 受理人 均 200（三方 OR）
    //   ⭐ [C10-fix2 MED-3·selfTechLead 例外正式登记] r4a=技术负责人本人 resend 自己的评估通知 → 200 = §10.2
    //     「通知重发绑单精判」的唯一显式例外（自服务合理·与"谁是本单对接人"权限轴正交）；与上方 ③ 的
    //     "非 self 非绑定 → 403 NOT_BOUND_LIAISON" 合起来钉死 MED-3 两侧。
    const c4 = await create('feature');
    const id4 = c4.body.id;
    await consult(id4);
    await comment(id4, techTok, '意见');
    const r4a = await resendNotify(id4, techTok);
    assert.strictEqual(r4a.status, 200, `技术负责人本人补发应 200（selfTechLead 例外）, got ${r4a.status} ${JSON.stringify(r4a.body)}`);
    const r4b = await resendNotify(id4, adminTok);
    assert.strictEqual(r4b.status, 200, `admin 补发应 200, got ${r4b.status} ${JSON.stringify(r4b.body)}`);
    const r4c = await resendNotify(id4, liaisonTok);
    assert.strictEqual(r4c.status, 200, `受理人补发应 200, got ${r4c.status} ${JSON.stringify(r4c.body)}`);

    // ⑤ 离开待受理（原子 SQL 改状态到待指派）后 → 409 确切码（v2.1：开放态本身已改「待受理」，
    //   须换一个"非开放态"目标，不能再用「待受理」——那现在恰是开放态本身）
    const c5 = await create('feature');
    const id5 = c5.body.id;
    await consult(id5);
    await comment(id5, techTok, '意见');
    await run(`UPDATE sys_issues SET status='待指派' WHERE id=?`, [id5]);
    const r5 = await resendNotify(id5, liaisonTok);
    assert.strictEqual(r5.status, 409, `离开待受理后补发应 409, got ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.code, 'TECH_LEAD_COMMENT_NOTIFY_RESEND_LATE', '应为 TECH_LEAD_COMMENT_NOTIFY_RESEND_LATE');

    // ⑥ 角色权限重构 C4·184 号预审 HIGH（PH-1 第二半·C3 新增）：换轮后（新轮尚无意见）resend-notify
    //   应 409 NO_TECH_LEAD_COMMENT_TO_NOTIFY——堵住"旧轮的意见被当成现役意见补发"，否则受理人会收到
    //   一条指向已作废轮次的过期通知。新轮回复后再补发应恢复 200。
    const c6 = await create('feature');
    const id6 = c6.body.id;
    await consult(id6);
    await comment(id6, techTok, '旧轮的意见');
    const rq6b = await consult(id6, liaisonTok);   // 换轮：新轮尚无意见
    const r6a = await resendNotify(id6, liaisonTok);
    assert.strictEqual(r6a.status, 409, `换轮后新轮无意见时补发应 409, got ${r6a.status} ${JSON.stringify(r6a.body)}`);
    assert.strictEqual(r6a.body.code, 'NO_TECH_LEAD_COMMENT_TO_NOTIFY', '换轮后新轮无意见应为 NO_TECH_LEAD_COMMENT_TO_NOTIFY（不因旧轮曾有意见而误判"有意见可补发"）');
    void rq6b;
    await comment(id6, techTok, '新轮的意见');
    const r6b = await resendNotify(id6, liaisonTok);
    assert.strictEqual(r6b.status, 200, `新轮回复后补发应恢复 200, got ${r6b.status} ${JSON.stringify(r6b.body)}`);

    ok('[RS] resend-notify：有意见 200+timeline+1(sent_by=本次操作者)·无意见 409 NO_TECH_LEAD_COMMENT_TO_NOTIFY·无关用户 403 NOT_BOUND_LIAISON·本人/admin/受理人 200·离开待受理 409 RESEND_LATE·换轮后新轮无意见 409 NO_TECH_LEAD_COMMENT_TO_NOTIFY（不因旧轮意见误判）+新轮回复后恢复 200');
  }

  // ═══ [RV] ⭐⭐ C10-fix2 MED-2：绑定对接人「发通知」有效性统一校验——停用/角色移出候选后不发（两路径各一条）═══
  //   两条通知路径（tech-lead-comment 首发 :6924 一带 / resend-notify :7126 一带）共用
  //   resolveValidBoundLiaisonForNotify——绑定对接人停用或被移出候选 allowlist 后视为"无有效收件人"（同
  //   liaison-test「停用即无有效收件人」口径），不发 + warn。用桩计数器直接观测 sendIssueDingtalkRaw 零调用
  //   （行数不变证明不了没发·186 号 LOW 教训），并断言 notify_status=failed。
  {
    // ① 绑定对接人(13)被**停用** → tech-lead-comment 首发路径降级不发（覆盖首发 call site）
    const c1 = await create('feature');
    const id1 = c1.body.id;
    await consult(id1);
    await run(`UPDATE users SET status='inactive' WHERE id=13`);
    const before1 = dingtalkSendCount;
    let r1;
    try {
      r1 = await comment(id1, techTok, '绑定对接人已停用场景的意见');
    } finally {
      await run(`UPDATE users SET status='active' WHERE id=13`);   // 立即恢复防污染后续用例
    }
    assert.strictEqual(r1.status, 200, `[RV①] 意见提交本身仍 200（通知降级不回滚意见）, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.notify_status, 'failed', '[RV①] 绑定对接人停用 → notify_status=failed（有效性校验拦在发送前·降级不发）');
    assert.strictEqual(dingtalkSendCount, before1, '[RV①] ⭐ 绑定对接人停用 → sendIssueDingtalkRaw 零调用（不发给已停用的历史绑定人·直接观测调用本身）');
    ok('[RV①] C10-fix2 MED-2（tech-lead-comment 首发路径）：绑定对接人(13)停用 → 意见照常落库(200) 但「评估已回」通知降级不发（sendIssueDingtalkRaw 零调用·notify_status=failed）');
  }
  {
    // ② 绑定对接人(13)角色被**移出候选 allowlist**（user→viewer） → resend-notify 路径降级不发（覆盖补发 call site）
    const c2 = await create('feature');
    const id2 = c2.body.id;
    await consult(id2);
    await comment(id2, techTok, '意见');   // 先正常提交一条意见（此刻 13 仍 user·首发正常发送）
    await run(`UPDATE users SET role='viewer' WHERE id=13`);
    const before2 = dingtalkSendCount;
    let r2;
    try {
      r2 = await resendNotify(id2, adminTok);   // admin 触发补发（授权不依赖绑定人有效性）
    } finally {
      await run(`UPDATE users SET role='user' WHERE id=13`);   // 恢复
    }
    assert.strictEqual(r2.status, 200, `[RV②] 补发端点本身仍 200（best-effort）, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.notify_status, 'failed', '[RV②] 绑定对接人角色移出候选 → notify_status=failed（降级不发）');
    assert.strictEqual(dingtalkSendCount, before2, '[RV②] ⭐ 角色移出候选 allowlist → sendIssueDingtalkRaw 零调用（同一 helper·resend-notify 路径同口径）');
    ok('[RV②] C10-fix2 MED-2（resend-notify 补发路径）：绑定对接人(13)角色移出候选 allowlist(user→viewer) → 补发降级不发（sendIssueDingtalkRaw 零调用·notify_status=failed·两路径共用 resolveValidBoundLiaisonForNotify）');
  }

  // ═══ [TC] 换轮组（角色权限重构 C4·184 号预审 HIGH·PH-1 用户裁定，原"咨询已终局收口"组整体重写）═══
  //   世界模型改变：意见唯一性从"整单只能有一条"改为**绑定咨询轮次**——`tech_lead_notify_request_event_id`
  //   标识当前轮，已有意见后 admin/受理人**可以**直接 request 开新轮（旧 409 TECH_CONSULT_ALREADY_COMMENTED
  //   断言已删除），旧意见留在 timeline 作历史（不删不改）；新轮可再提交一条新意见（同一示例发布者 id7 开新轮
  //   也算数——"轮"由 event_id 标识，不看是不是换了个人）。轮内唯一性不受影响（C2：新轮内仍不可重复提交）。
  {
    // ① 第一轮：request → comment，库内第一条 tech_lead_comment 行
    const c1 = await create('feature');
    const id1 = c1.body.id;
    const rq1 = await consult(id1);
    const r1c = await comment(id1, techTok, '第一轮的最终意见');
    assert.strictEqual(r1c.status, 200, `第一轮提交应 200, got ${r1c.status} ${JSON.stringify(r1c.body)}`);

    // ② 已有意见后再次 request → 应 200（换轮合法化，非旧版本的 409 终局拒绝）+ 新轮 event_id 不同于旧轮
    const rq2 = await consult(id1, liaisonTok);
    assert.strictEqual(rq2.status, 200, `已有意见后再次 request 应 200（换轮合法化）, got ${rq2.status} ${JSON.stringify(rq2.body)}`);
    assert.notStrictEqual(Number(rq2.body.request_event_id), Number(rq1.body.request_event_id),
      '新轮 request_event_id 应不同于旧轮（真的开了新一轮，非复用旧值）');

    // ③ 新一轮尚无意见 → resend-tech-consult（重发"请评估"通知）应 200（PH-1：旧轮的意见不拦新轮）
    const rsBeforeComment = await call('POST', `/api/sys-issues/${id1}/resend-tech-consult`, liaisonTok,
      { expected_request_event_id: rq2.body.request_event_id });
    assert.strictEqual(rsBeforeComment.status, 200, `新轮无意见时 resend-tech-consult 应 200, got ${rsBeforeComment.status} ${JSON.stringify(rsBeforeComment.body)}`);

    // ④ 新轮（同人示例发布者7）可再留言 200；库内两条 comment 行共存（旧轮的不删不改）
    const r2c = await comment(id1, techTok, '第二轮（换轮后）的最终意见');
    assert.strictEqual(r2c.status, 200, `新轮再次留言应 200, got ${r2c.status} ${JSON.stringify(r2c.body)}`);
    const commentRows = await all(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' ORDER BY id`, [id1]);
    assert.strictEqual(commentRows.length, 2, '库内应有两条 tech_lead_comment 行（旧轮 + 新轮共存）');
    assert.strictEqual(commentRows[0].summary, '第一轮的最终意见', '第一条仍是旧轮原文（未被覆盖/删除）');
    assert.strictEqual(commentRows[1].summary, '第二轮（换轮后）的最终意见', '第二条是新轮原文');

    // ⑤ C2：新轮内重复提交仍应 409 ALREADY_SUBMITTED（换轮合法化不等于放弃"同轮唯一"）
    const r2dup = await comment(id1, techTok, '尝试在新轮内第二次提交');
    assert.strictEqual(r2dup.status, 409, `新轮内重复提交应仍 409, got ${r2dup.status} ${JSON.stringify(r2dup.body)}`);
    assert.strictEqual(r2dup.body.code, 'TECH_LEAD_COMMENT_ALREADY_SUBMITTED', '新轮内重复提交应仍为 TECH_LEAD_COMMENT_ALREADY_SUBMITTED（轮内唯一不受换轮合法化影响）');

    // ⑥ 新轮现在也有意见了 → resend-tech-consult（重发"请评估"通知）应改为 409 TECH_CONSULT_ALREADY_COMMENTED
    //   （round-scoped ALREADY_COMMENTED 确实按"当前轮"而非"整单历史"判定——当前轮一旦有意见同样拦）
    const rsAfterComment = await call('POST', `/api/sys-issues/${id1}/resend-tech-consult`, liaisonTok,
      { expected_request_event_id: rq2.body.request_event_id });
    assert.strictEqual(rsAfterComment.status, 409, `新轮已有意见后 resend-tech-consult 应 409, got ${rsAfterComment.status} ${JSON.stringify(rsAfterComment.body)}`);
    assert.strictEqual(rsAfterComment.body.code, 'TECH_CONSULT_ALREADY_COMMENTED', '应为 TECH_CONSULT_ALREADY_COMMENTED（轮内判定，非整单判定）');

    // ⑦ 绕过端点、原子 SQL 直插一条"当前轮"意见行，同样应被轮内唯一性识别（不依赖评论行必然由端点产生）
    const c2 = await create('feature');
    const id2 = c2.body.id;
    const rq2b = await consult(id2);
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
               VALUES (?, 'note', '原子 SQL 直插的意见（绕过端点）', 'tech_lead_comment', 7, '示例发布者')`, [id2]);
    const r2b = await comment(id2, techTok, '尝试在已被直插意见的当前轮提交');
    assert.strictEqual(r2b.status, 409, `当前轮已被直插一条意见后再提交应 409, got ${r2b.status} ${JSON.stringify(r2b.body)}`);
    assert.strictEqual(r2b.body.code, 'TECH_LEAD_COMMENT_ALREADY_SUBMITTED', '应为 TECH_LEAD_COMMENT_ALREADY_SUBMITTED（轮内唯一性不依赖评论行的产生路径）');
    void rq2b;

    ok('[TC] 换轮组：已有意见后 request 新轮 200（换轮合法化，新 event_id≠旧）·新轮无意见时 resend 200·新轮可再留言 200 且库内两条 comment 行共存（旧轮不删不改）·新轮内重复提交仍 409 ALREADY_SUBMITTED（轮内唯一不受影响）·新轮已有意见后 resend 改 409 ALREADY_COMMENTED（轮内判定）·原子直插意见同样受轮内唯一性拦截');
  }

  // ═══ [MN2] S5 通知手动化（方案 v2.1 §6·用户拍板 D4）：request-tech-consult 首发/换轮不再自动发钉钉 ═══
  //   ⚠️ 本批后端改动：index.js 删首发段（request-tech-consult 不再调用 sendIssueDingtalkRaw）+
  //   transitions.js 删相关 sideEffects 声明。verify 侧复用本文件已有的 dingtalkSendCount 桩计数器
  //   直接观测外部发送调用本身（同 [RN] 组纪律：不用 timeline 行数间接推断"是否发送"）。
  {
    // ① 首发：request 后 not_sent + 零发送调用 + 响应不含 superseded + 库内投递字段整组 NULL
    const c1 = await create('feature');
    const id1 = c1.body.id;
    const before1 = dingtalkSendCount;
    const rq1 = await consult(id1);
    assert.strictEqual(rq1.status, 200, `[MN2] 首发 request 应 200, got ${rq1.status} ${JSON.stringify(rq1.body)}`);
    assert.strictEqual(rq1.body.tech_lead_notify_status, 'not_sent', '[MN2] 首发响应 tech_lead_notify_status=not_sent（不再自动发）');
    assert.strictEqual(rq1.body.superseded, undefined, '[MN2] 响应不再含 superseded 字段（随首发回写一并退场）');
    assert.strictEqual(dingtalkSendCount, before1, '[MN2] 首发零外部发送调用（直接观测·非行数推断）');
    const row1 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id1]);
    assert.strictEqual(row1.tech_lead_notify_status, 'not_sent', '[MN2] 库内 notify_status=not_sent');
    for (const col of ['tech_lead_notified_at', 'tech_lead_notify_message_key', 'tech_lead_notify_error', 'tech_lead_notify_sent_by']) {
      assert.strictEqual(row1[col], null, `[MN2] 首发不写 ${col}（整组保持重置态）`);
    }

    // ② resend-tech-consult 才真正触发发送 → sent + 计数 +1
    const before2 = dingtalkSendCount;
    const rs1 = await call('POST', `/api/sys-issues/${id1}/resend-tech-consult`, liaisonTok, { expected_request_event_id: rq1.body.request_event_id });
    assert.strictEqual(rs1.status, 200, `[MN2] resend 应 200, got ${rs1.status} ${JSON.stringify(rs1.body)}`);
    assert.strictEqual(rs1.body.tech_lead_notify_status, 'sent', '[MN2] resend 后 notify_status=sent（stub ok）');
    assert.strictEqual(dingtalkSendCount, before2 + 1, '[MN2] resend 触发恰一次外部发送调用');
    const row2 = await get('SELECT tech_lead_notify_status FROM sys_issues WHERE id=?', [id1]);
    assert.strictEqual(row2.tech_lead_notify_status, 'sent', '[MN2] 库内 notify_status=sent（resend 之后）');

    // ③ 换轮后回落 not_sent + 零增量（新一轮同样不自动发）
    const before3 = dingtalkSendCount;
    const rq2 = await consult(id1, liaisonTok);
    assert.strictEqual(rq2.status, 200, `[MN2] 换轮 request 应 200, got ${rq2.status} ${JSON.stringify(rq2.body)}`);
    assert.notStrictEqual(Number(rq2.body.request_event_id), Number(rq1.body.request_event_id), '[MN2] 换轮 event_id 与首轮不同');
    assert.strictEqual(rq2.body.tech_lead_notify_status, 'not_sent', '[MN2] 换轮响应回落 not_sent（新一轮同样不自动发）');
    const row3 = await get('SELECT tech_lead_notify_status FROM sys_issues WHERE id=?', [id1]);
    assert.strictEqual(row3.tech_lead_notify_status, 'not_sent', '[MN2] 库内换轮后回落 not_sent');
    assert.strictEqual(dingtalkSendCount, before3, '[MN2] 换轮零外部发送调用');

    // ④ 已留言后 resend 应 409 ALREADY_COMMENTED——既有断言已在 [TC]⑥（rsAfterComment）覆盖且未受本次
    //   改动影响（该分支判的是"当前轮是否已有意见"，与"是否自动发送"正交），此处不重复断言，仅点出覆盖关系。

    ok('[MN2] S5 通知手动化：首发 not_sent+零发送调用+响应不含 superseded+库内投递字段整组 NULL ·resend 才真发送(sent+计数+1) ·换轮后回落 not_sent+零增量（已留言 409 ALREADY_COMMENTED 见 [TC]⑥，未受影响）');
  }

  // ═══ [GN] sysTechConsultGateStatus 显式映射（fail-closed）：单元直测 + 端点 409 REQUEST_TECH_CONSULT_TYPE_INVALID ═══
  {
    assert.strictEqual(I.sysTechConsultGateStatus('feature'), '待受理', "feature → 待受理（v2.1：C2.5 撤销）");
    assert.strictEqual(I.sysTechConsultGateStatus('improvement'), '待受理', "improvement → 待受理（v2.1：C2.5 撤销）");
    assert.strictEqual(I.sysTechConsultGateStatus('bug'), '待受理', "bug → 待受理");
    assert.strictEqual(I.sysTechConsultGateStatus('hotfix'), null, "未登记 type 'hotfix' → null（fail-closed，非静默回退待受理）");
    assert.strictEqual(I.sysTechConsultGateStatus('config'), null, "未登记 type 'config' → null");
    assert.strictEqual(I.sysTechConsultGateStatus(''), null, "空串 → null");
    assert.strictEqual(I.sysTechConsultGateStatus(undefined), null, "undefined → null");

    // 端点层：把已建单的单据 type 原子 SQL 改成"合法入库但未登记"的值（config——sys_issues.type 的 DB CHECK
    //   只认 bug/feature/improvement/config 四值，'hotfix' 会被 CHECK 直接拒绝写不进去，故用 config：它能通过
    //   DB CHECK，但从未在 sysTechConsultGateStatus 里登记——precisely 是本组要测的
    //   "未登记 type"），request-tech-consult 应 409 REQUEST_TECH_CONSULT_TYPE_INVALID（而非误判成"状态不对"——
    //   分流函数返 null 时 `row.status !== null` 恒真，若不显式判断会产出一条误导性的"仅「null」态可发起..."错误信息）
    const c = await create('feature');
    const id = c.body.id;
    await run(`UPDATE sys_issues SET type='config' WHERE id=?`, [id]);
    const r = await consult(id, liaisonTok);
    assert.strictEqual(r.status, 409, `非法 type 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'REQUEST_TECH_CONSULT_TYPE_INVALID', '应为 REQUEST_TECH_CONSULT_TYPE_INVALID');
    assert.ok(!/null/.test(r.body.error), `错误信息不应出现误导性的"null"字样，实际：${r.body.error}`);

    // ⭐ 角色权限重构 C4·184 号预审（PM-4·漂移哨兵，不做权威源大重构；合并复审 MED 收尾补全三型）：
    //   sysTechConsultGateStatus 是 request/resend-tech-consult 用来判定"开放态"的独立映射函数，但
    //   transitions.js 里 request_tech_consult 这条 transition 自己的 `from` 数组才是 findTransition
    //   实际拿来做前置态校验的真正依据——两处各自表达同一件事（"什么态可以发起技术负责人沟通"），结构上
    //   完全可能各改各的、悄悄漂移（例如将来只改了 transitions.js 的 from 却忘了改
    //   sysTechConsultGateStatus，或反过来）。本条不做权威源合并的大重构，只加哨兵断言：对 feature/
    //   improvement/bug **三型**逐一核对 ①from 恰为单元素数组（length===1——若未来某 type 的开放态
    //   变成多个状态，"取 from[0]" 这个简化比对本身就不再成立，必须显式炸出来，不能悄悄只比对第一个
    //   元素就宣称一致）②from[0] 与 sysTechConsultGateStatus(type) 逐字相等，红灯即两份表达已经漂移。
    //   `T.TRANSITIONS[type]` 是既有导出面（transitions.js module.exports 已含 TRANSITIONS），无需为此新增导出。
    for (const type of ['feature', 'improvement', 'bug']) {
      const rtc = (T.TRANSITIONS[type] || []).find(t => t.action === 'request_tech_consult');
      assert.ok(rtc, `前置：${type} 的 TRANSITIONS 应有 request_tech_consult 条目`);
      assert.ok(Array.isArray(rtc.from), `${type} 的 request_tech_consult.from 应为数组，实际 ${JSON.stringify(rtc.from)}`);
      assert.strictEqual(rtc.from.length, 1, `漂移哨兵①：${type} 的 request_tech_consult.from 应恰为单元素数组，实际长度 ${rtc.from.length}（${JSON.stringify(rtc.from)}）——多元素时"取 from[0]"这个简化比对不再成立`);
      assert.strictEqual(I.sysTechConsultGateStatus(type), rtc.from[0],
        `漂移哨兵②：sysTechConsultGateStatus('${type}')=${I.sysTechConsultGateStatus(type)} 应等于 transitions.js request_tech_consult 条目 from[0]=${rtc.from[0]}`);
    }

    ok('[GN] sysTechConsultGateStatus 显式映射（v2.1）：feature/improvement/bug 三型均→待受理·未登记 type(含空串/undefined)→null（fail-closed）+ 端点对 null 显式 409 REQUEST_TECH_CONSULT_TYPE_INVALID（非误判状态不对）+ 漂移哨兵：feature/improvement/bug 三型逐一核对 from 恰单元素数组 + from[0] 与 transitions.js request_tech_consult 条目逐字一致');
  }

  // ═══ [CR] cancel-consult 换轮诊断分支单元验证（codex Round-A 审 MED·Round-C 审 LOW 改名+收窄措辞）═══
  //   ⚠️ 本组不模拟"真实换轮场景"——那不可复现（见文件头 [CR] 说明 + 文件中段注入实现注释）。
  //   本组验证的是：changes=0 且 fresh 读到的 event_id 与捕获值不同时，诊断分支能正确识别为"换轮"
  //   而非笼统的"状态已变"——这是对诊断分支自身判断逻辑的单元级验证，输入条件由故障注入构造。
  {
    // 正常场景：无换轮，cancel 应 200（复用既有 [CX] 组已验证的路径，这里独立起一组更聚焦地佐证"移读入事务"
    //   这个改动本身零回归——绝大多数正常调用根本不会撞上换轮分支）
    const cNormal = await create('feature');
    const idNormal = cNormal.body.id;
    await consult(idNormal);
    const rNormal = await cancel(idNormal);
    assert.strictEqual(rNormal.status, 200, `无换轮正常 cancel 应 200, got ${rNormal.status} ${JSON.stringify(rNormal.body)}`);

    // 换轮诊断分支的输入条件（双点故障注入·见文件头注释）：guarded UPDATE 强制 changes=0（模拟"没匹配上
    //   任何行"）+ 诊断阶段 fresh 查询的 event_id 被篡改成另一个值（模拟"重读到的行 event_id 与本次捕获的
    //   不同"）→ 诊断应识别为"换轮"而非笼统的"状态已变"。
    const cRound = await create('feature');
    const idRound = cRound.body.id;
    await consult(idRound);
    injectRoundChangeTargetId = idRound; injectRoundChangeFired = { update: false, select: false };
    const rRound = await cancel(idRound);
    assert.ok(injectRoundChangeFired.update && injectRoundChangeFired.select, `确认故障注入两点均真实命中（防匹配字符串写错导致测试静默失效），实际 ${JSON.stringify(injectRoundChangeFired)}`);
    assert.strictEqual(rRound.status, 409, `注入场景应 409, got ${rRound.status} ${JSON.stringify(rRound.body)}`);
    assert.strictEqual(rRound.body.code, 'CANCEL_CONSULT_CONSULT_ROUND_CHANGED', '应为 CANCEL_CONSULT_CONSULT_ROUND_CHANGED（而非笼统的 STATE_CHANGED）');
    // 注入场景下 tech_lead_id 不应被清空（诊断为换轮的同时必须零副作用，同"确切诊断+零副作用"纪律；
    //   注入的 guarded UPDATE 本就强制未执行，这里断言的是"响应码对应的业务语义确实是零副作用"）
    const afterRound = await get('SELECT tech_lead_id FROM sys_issues WHERE id=?', [idRound]);
    assert.strictEqual(Number(afterRound.tech_lead_id), 7, '注入场景被拒后 tech_lead_id 未被清空（零副作用）');

    ok('[CR] cancel-consult 换轮诊断分支单元验证：无换轮正常 cancel 200（零回归）·换轮场景不可用真实并发触达（前置 SELECT 已移入事务+mutex 序列化）·双点故障注入验证诊断分支自身判断逻辑：409 CANCEL_CONSULT_CONSULT_ROUND_CHANGED（非笼统 STATE_CHANGED）+ 零副作用');
  }

  // ═══ [RA] reactivate 全链（角色权限重构 C4，v2.1 全面改写）：request→comment→issue_reject（v2.1：
  //   变更流拒绝改由**受理人**操作·前置守卫=当前轮已有 tech_lead_comment；PH-2：当前轮已回复→不清不留痕）
  //   → reactivate（回「待受理」+ 清 tech_lead_* 九列）→ 回待受理后 request 新轮 200 → comment 200——
  //   原 PH-1 死角场景（旧世界模型下这单会永久卡死：新负责人留言撞唯一性约束、取消咨询被"已留言不可
  //   取消"挡住）直接变成本组的正向用例 ═══
  {
    const c = await create('feature');
    const id = c.body.id;
    const rq1 = await consult(id);
    await comment(id, techTok, '第一轮：拒绝前的意见');
    // ⭐ v2.1 §3：变更流 issue_reject 改由**受理人**（liaisonTok，非 admin）操作，前置守卫要求当前轮已有
    //   tech_lead_comment（上一步已满足）。PH-2：已回复的轮次是历史 → 不清不留痕（同 [PH2] 组③的
    //   intake_return 分支互为镜像，两条边都要各自核对）。
    const rReject = await call('POST', `/api/sys-issues/${id}/issue-reject`, liaisonTok, { reason: '需求不合理，先拒绝' });
    assert.strictEqual(rReject.status, 200, `issue_reject 应 200, got ${rReject.status} ${JSON.stringify(rReject.body)}`);
    assert.strictEqual(await statusOf(id), '已拒绝', '前置：单据已被拒绝');
    const afterReject = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
    assert.strictEqual(Number(afterReject.tech_lead_id), 7, 'PH-2：已回复的轮次是历史，issue_reject 后 tech_lead_id 应保留（不清）');
    assert.strictEqual(Number(afterReject.tech_lead_notify_request_event_id), Number(rq1.body.request_event_id), 'event_id 应保留原值（不清）');
    const cancelAfterRejectCount = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id])).c;
    assert.strictEqual(cancelAfterRejectCount, 0, 'PH-2：已回复的轮次不应生成自动取消的 cancel_consult 留痕');

    // reactivate：已拒绝 → 待受理——v2.1：C2.5 撤销后 feature/improvement 的建单/derive/reactivate
    //   落态统一走 T.resolveSysInitialStatusForCreate，该函数对全类型恒返「待受理」。reactivate 复用既有
    //   SYS_BACK_TO_INTAKE_GATE_SQL（清 tech_lead_*/relay_* 九+八列）+ oa_number=NULL——这批清空是
    //   reactivate 自身固有的"回受理门=新一轮"语义（C0 既有机制），与本次新加的 PH-2 helper 是两件不同的事，
    //   互不依赖。
    const rReactivate = await call('POST', `/api/sys-issues/${id}/reactivate`, adminTok, { reason: '重新激活，走一遍完整流程' });
    assert.strictEqual(rReactivate.status, 200, `reactivate 应 200, got ${rReactivate.status} ${JSON.stringify(rReactivate.body)}`);
    assert.strictEqual(await statusOf(id), '待受理', 'reactivate 落态=待受理（v2.1：C2.5 撤销）');
    const afterReactivate = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
    assertTechLeadCleared(afterReactivate);

    // 回待受理后 request 新轮 → 200；新一轮再回复 → 200
    const rq2 = await consult(id, liaisonTok);
    assert.strictEqual(rq2.status, 200, `reactivate 回待受理后 request 新轮应 200, got ${rq2.status} ${JSON.stringify(rq2.body)}`);
    const r2c = await comment(id, techTok, 'reactivate 后新一轮的意见');
    assert.strictEqual(r2c.status, 200, `新一轮回复应 200, got ${r2c.status} ${JSON.stringify(r2c.body)}`);

    ok('[RA] reactivate 全链（v2.1）：request→comment→issue_reject（受理人操作·PH-2：当前轮已回复→不清不留痕）→reactivate（回「待受理」+ 清 tech_lead_* 九列，既有 SYS_BACK_TO_INTAKE_GATE_SQL 机制）→ 回待受理后 request 新轮 200 → comment 200（原 PH-1 死角场景已变正向用例）');
  }

  // ═══ [PH2] 离开「待受理」时原子清"未回复"的技术咨询 + 留痕（角色权限重构 C4·v2.1 改锚定边）═══
  //   ⭐ v2.1：预沟通段/「待商议」撤销后，PH-2 不再锚定"离开待商议"，改锚定到具体离场边：
  //   intake_return / void（全类型，本组用 intake_return 代表）+ issue_reject（仅 bug——feature/improvement
  //   的 issue_reject 现要求"当前轮已有意见"才可达，"未回复+reject"组合对变更流已结构性不可达，见 [RA] 组
  //   反面验证；本组②改用 bug 覆盖这条边）。
  {
    // ① 未回复咨询 + intake_return → 200 且 tech_lead_* 九列全空 + timeline 多一条 cancel_consult 行（summary 含"自动取消"）
    const c1 = await create('feature');
    const id1 = c1.body.id;
    await consult(id1);   // 尚未回复
    const beforeCount1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id1])).c;
    const rRet1 = await call('POST', `/api/sys-issues/${id1}/intake-return`, liaisonTok, { reason: '材料不全' });
    assert.strictEqual(rRet1.status, 200, `intake-return 应 200, got ${rRet1.status} ${JSON.stringify(rRet1.body)}`);
    const afterClear1 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id1]);
    assertTechLeadCleared(afterClear1);
    const cancelRow1 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult' ORDER BY id DESC LIMIT 1`, [id1]);
    assert.ok(cancelRow1, 'PH-2：未回复咨询 + intake-return 应新增一条 cancel_consult timeline 行');
    assert.ok(/自动取消/.test(cancelRow1.summary), `summary 应含"自动取消"，实际：${cancelRow1.summary}`);
    const afterCount1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id1])).c;
    assert.strictEqual(afterCount1, beforeCount1 + 1, 'cancel_consult 行数 +1（新增一条，非覆盖）');

    // ② 未回复咨询 + issue_reject（仅 bug 可达此边·admin 操作）→ 同断言（两条边各自独立核对，
    //   不能只测一条边就当另一条也对）。feature/improvement 的"未回复+reject"组合已结构性不可达
    //   （见 [RA] 组：reject 前置要求当前轮已有意见），不在本组重复验证不可达性。
    const c2 = await create('bug');
    const id2 = c2.body.id;
    await consult(id2);
    const rReject2 = await call('POST', `/api/sys-issues/${id2}/issue-reject`, adminTok, { reason: '不是缺陷' });
    assert.strictEqual(rReject2.status, 200, `bug issue_reject 应 200, got ${rReject2.status} ${JSON.stringify(rReject2.body)}`);
    const afterClear2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id2]);
    assertTechLeadCleared(afterClear2);
    const cancelRow2 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult' ORDER BY id DESC LIMIT 1`, [id2]);
    assert.ok(cancelRow2, 'PH-2：未回复咨询 + bug issue_reject 应新增一条 cancel_consult timeline 行');
    assert.ok(/自动取消/.test(cancelRow2.summary), `summary 应含"自动取消"，实际：${cancelRow2.summary}`);

    // ③ 已回复咨询 + intake_return → 字段保留（不清不留痕）——issue_reject 边已在 [RA] 组核对过，
    //   这里独立补 intake_return 边。
    const c3 = await create('feature');
    const id3 = c3.body.id;
    const rq3 = await consult(id3);
    await comment(id3, techTok, '已回复的意见');
    const beforeCancelCount3 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id3])).c;
    const rRet3 = await call('POST', `/api/sys-issues/${id3}/intake-return`, liaisonTok, { reason: '材料不全' });
    assert.strictEqual(rRet3.status, 200, `已回复咨询的 intake-return 应仍 200, got ${rRet3.status} ${JSON.stringify(rRet3.body)}`);
    const afterKeep3 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id3]);
    assert.strictEqual(Number(afterKeep3.tech_lead_id), 7, 'PH-2：已回复的轮次是历史，intake-return 不应清 tech_lead_id');
    assert.strictEqual(Number(afterKeep3.tech_lead_notify_request_event_id), Number(rq3.body.request_event_id), 'event_id 应保留原值');
    const afterCancelCount3 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [id3])).c;
    assert.strictEqual(afterCancelCount3, beforeCancelCount3, 'PH-2：已回复轮次不应新增 cancel_consult 留痕（不清不留痕）');

    // ④ event_id 为 NULL 的退化态（原子 SQL 造 tech_lead_id 有值但 event_id NULL）→ comment 提交被拒（确切码·
    //   不因 NULL 比较放空唯一性）；同时验证 PH-2 helper 对这个退化态的处理：no-op（NULL 防御短路，
    //   脏数据不被静默"修好"，行为可预测且不新增副作用）。
    const c4 = await create('feature');
    const id4 = c4.body.id;
    await run(`UPDATE sys_issues SET tech_lead_id=7, tech_lead_name='示例发布者', tech_lead_notify_request_event_id=NULL WHERE id=?`, [id4]);
    // ⭐ 186 号 HIGH（轮次围栏）·**用例升级非降级**：加了必填 expected_request_event_id 后，退化态有了
    //   两道闸，必须分别验证——只测第一道会让本组**失去**对 SQL 层 NULL 防御的覆盖（原用例走 helper
    //   默认路径，现在会撞在参数校验上就返回，根本走不到 INSERT 谓词）。
    //   ④-a 第一道闸：库里无活动轮 → helper 自动取值得 null → 400 REQUIRED。
    const r4a = await comment(id4, techTok, '尝试在退化态提交（不带轮次）');
    assert.strictEqual(r4a.status, 400, `退化态不带轮次应 400, got ${r4a.status} ${JSON.stringify(r4a.body)}`);
    assert.strictEqual(r4a.body.code, 'EXPECTED_REQUEST_EVENT_ID_REQUIRED', '第一道闸应为 EXPECTED_REQUEST_EVENT_ID_REQUIRED');
    //   ④-b 第二道闸（**本组真正的不变量**）：显式传一个正整数绕过参数校验，直击 INSERT 谓词——
    //   库里 event_id 是 NULL，`IS NOT NULL AND = ?` 不满足 → changes=0；诊断分支 Number(null||0)=0
    //   ≠ 传入值 → 409 ROUND_CHANGED。证明 NULL 退化态不会因三值逻辑被放空而误判成功。
    const r4 = await comment(id4, techTok, '尝试在退化态提交', 999999);
    assert.strictEqual(r4.status, 409, `event_id 为 NULL 的退化态提交应被拒, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.code, 'TECH_LEAD_COMMENT_ROUND_CHANGED', '应为确切码 TECH_LEAD_COMMENT_ROUND_CHANGED（NULL 退化态被轮次比对挡住，不因 NULL 比较放空唯一性而误判成功）');
    const commentCount4 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id4])).c;
    assert.strictEqual(commentCount4, 0, '退化态提交被拒后零 tech_lead_comment 行（零副作用）');
    const rRet4 = await call('POST', `/api/sys-issues/${id4}/intake-return`, liaisonTok, { reason: '材料不全' });
    assert.strictEqual(rRet4.status, 200, `退化态下 intake-return 仍应 200（不受 tech_lead_* 退化数据影响主流程）, got ${rRet4.status} ${JSON.stringify(rRet4.body)}`);
    const afterDegenerate4 = await get('SELECT tech_lead_id, tech_lead_notify_request_event_id FROM sys_issues WHERE id=?', [id4]);
    assert.strictEqual(Number(afterDegenerate4.tech_lead_id), 7, 'PH-2 NULL 防御：event_id 为 NULL 时 helper no-op，tech_lead_id 保留不被清');

    ok('[PH2] 离开「待受理」时原子清未回复咨询+留痕（v2.1 改锚定边）：①未回复+intake-return 200+九列全清+cancel_consult 行含"自动取消" ②未回复+bug issue_reject 同断言(变更流已结构性不可达) ③已回复+intake-return 字段保留不清不留痕 ④event_id 为 NULL 退化态 comment 提交 409 确切码（不因 NULL 比较放空唯一性）+ helper no-op 不误清');
  }

  // ═══ [RG] 提交侧轮次围栏（C5 末次合并审 186 号 HIGH·PH-1 收口自身留下的死角）═══
  //   真实场景：示例发布者打开评估弹窗（轮A）→ admin 重新发起咨询（轮B）→ 示例发布者提交。围栏之前，这条意见
  //   会被写成轮B的唯一意见（归属错轮 + 轮B被占用）。本组用"显式传旧轮 id"精确复现该时序——
  //   这不是造场景，前端传的就是打开弹窗那一刻的轮次值（见 siModalTechLeadComment 的 roundEventId）。
  {
    const c = await create('feature');
    const id = c.body.id;
    const rqA = await consult(id);
    const roundA = rqA.body.request_event_id;
    // 换轮（PH-1 已把换轮合法化：无论当前轮有无意见都可重新发起）
    const rqB = await consult(id);
    const roundB = rqB.body.request_event_id;
    assert.notStrictEqual(Number(roundA), Number(roundB), '换轮后 request_event_id 应变化（前置条件）');
    // ① 旧轮弹窗提交 → 409 ROUND_CHANGED（不是 ALREADY_SUBMITTED——轮B此刻并无意见，报"已提交过"会误导）
    const rOld = await comment(id, techTok, '基于旧弹窗（轮A）写的意见', roundA);
    assert.strictEqual(rOld.status, 409, `旧轮提交应 409, got ${rOld.status} ${JSON.stringify(rOld.body)}`);
    assert.strictEqual(rOld.body.code, 'TECH_LEAD_COMMENT_ROUND_CHANGED', '应为确切码 TECH_LEAD_COMMENT_ROUND_CHANGED（区别于 ALREADY_SUBMITTED/STATE_CHANGED）');
    // ② 零副作用：被拒后库内不得留下任何 comment 行（否则轮B就被这条错轮意见占用了）
    const cntAfterOld = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id])).c;
    assert.strictEqual(cntAfterOld, 0, '旧轮提交被拒后零 tech_lead_comment 行（围栏必须拦在写入之前）');
    // ③ 围栏只挡旧轮、不误伤当前轮：带轮B提交 200
    const rNew = await comment(id, techTok, '基于当前轮（轮B）的意见', roundB);
    assert.strictEqual(rNew.status, 200, `当前轮提交应 200, got ${rNew.status} ${JSON.stringify(rNew.body)}`);
    // ④ 缺参数 → 400（第一道闸·与 [PH2]④-a 同码，这里覆盖"有活动轮但不传"这个前端旧版本场景）
    const rMissing = await call('POST', `/api/sys-issues/${id}/tech-lead-comment`, techTok, { comment: '不带轮次' });
    assert.strictEqual(rMissing.status, 400, `不带轮次应 400, got ${rMissing.status} ${JSON.stringify(rMissing.body)}`);
    assert.strictEqual(rMissing.body.code, 'EXPECTED_REQUEST_EVENT_ID_REQUIRED', '应为 EXPECTED_REQUEST_EVENT_ID_REQUIRED');
    ok('[RG] 提交侧轮次围栏：换轮后旧弹窗提交 409 ROUND_CHANGED（确切码·非 ALREADY_SUBMITTED）+ 零 comment 行副作用 · 当前轮提交 200 不误伤 · 缺参数 400 REQUIRED');
  }

  // ═══ [RN] resend-notify 发送前二次确认（C5 末次合并审 186 号 MED·故障注入）═══
  //   ⚠️ 本组不模拟真实并发——二次确认要挡的窗口在两条 dbGet 之间，真实 HTTP 流量摸不到（同 [CR] 组处境，
  //   理由见文件中段注入实现注释）。本组专测**二次确认分支自身的判断逻辑**：注入让重读返回一个不同的
  //   ev，验证端点据此 409 且**不发通知**。
  {
    const c = await create('feature');
    const id = c.body.id;
    await consult(id);
    await comment(id, techTok, '当前轮的意见');
    const beforeNotify = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'`, [id])).c;
    injectResendRoundTargetId = id; injectResendRoundFired = false;
    // ⭐ 186 号复审 LOW（采纳）：直接观测**外部发送调用次数**。timeline 行数不变证明不了"没发送"
    //   ——"发送成功但留痕失败"路径下行数同样不变。计数器归零断言才真正证明这条修复达到了目的。
    const sendCountBefore = dingtalkSendCount;
    const rInj = await resendNotify(id);
    assert.ok(injectResendRoundFired, '注入点必须真的命中过（否则 SQL 串一改本组就成永远走正常路径的假绿）');
    assert.strictEqual(rInj.status, 409, `二次确认发现换轮应 409, got ${rInj.status} ${JSON.stringify(rInj.body)}`);
    assert.strictEqual(rInj.body.code, 'TECH_LEAD_COMMENT_NOTIFY_ROUND_CHANGED', '应为确切码 TECH_LEAD_COMMENT_NOTIFY_ROUND_CHANGED');
    assert.strictEqual(dingtalkSendCount, sendCountBefore, '二次确认拦截后**外部发送调用次数必须为零增量**（直接观测调用本身，非间接推断）');
    const afterNotify = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'`, [id])).c;
    assert.strictEqual(afterNotify, beforeNotify, '同时零 notify_sent 增量（留痕面佐证，但不作为"未发送"的主证据）');
    // 撤注入后恢复正常（证明拦截来自注入条件，不是端点整体坏了）
    const rOk = await resendNotify(id);
    assert.strictEqual(rOk.status, 200, `撤注入后补发应恢复 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    ok('[RN] resend-notify 发送前二次确认：注入"重读轮次已变"→409 NOTIFY_ROUND_CHANGED + **外部发送调用零增量**（直接观测·非行数间接推断）+ 零 notify_sent 增量（注入命中已断言）· 撤注入恢复 200');
  }

  // ═══ [V] 技术负责人**读权**（2026-07-28 手工验收发现的写读不同源）═══
  //   ⚠️ 本组存在的理由本身就是教训：C3 的全部用例都在**写端**（谁能提交评估意见），
  //   没有一条问过"示例发布者能不能在平台上**找到并打开**这张单"。结果 C3 的评估能力对变更流单据
  //   完全不可用（列表看不到 + 详情 403 + 钉钉深链也 403），三轮 codex 审 + 47 个 verify 全部漏过，
  //   由人工登录一次就撞见。读端用例从此与写端用例同等对待。
  {
    const c = await create('feature');
    const id = c.body.id;
    const other = await create('feature');          // 从未咨询示例发布者的对照单
    const otherId = other.body.id;
    const listOf = async (tok) => {
      const r = await call('GET', '/api/sys-issues?limit=200', tok);
      assert.strictEqual(r.status, 200, `列表应 200, got ${r.status}`);
      return ((r.body && r.body.items) || []).map(i => Number(i.id));
    };
    // ① 未咨询前：示例发布者列表看不到、详情 403（证明放行来自咨询关系，不是把权限放宽给了 publisher 角色）
    assert.ok(!(await listOf(techTok)).includes(id), '未咨询前示例发布者不应看到该单');
    assert.strictEqual((await call('GET', `/api/sys-issues/${id}`, techTok)).status, 403, '未咨询前详情应 403');
    // ② 发起咨询后：列表可见 + 详情 200（**当前被咨询**这一段）
    await consult(id);
    assert.ok((await listOf(techTok)).includes(id), '被咨询后示例发布者列表应可见该单');
    assert.strictEqual((await call('GET', `/api/sys-issues/${id}`, techTok)).status, 200, '被咨询后详情应 200');
    // ③ 对照单始终不可见（精确性：只放行与他有咨询关系的单，不是"所有 feature 单"）
    assert.ok(!(await listOf(techTok)).includes(otherId), '从未咨询他的单应始终不可见');
    assert.strictEqual((await call('GET', `/api/sys-issues/${otherId}`, techTok)).status, 403, '从未咨询他的单详情应 403');
    // ④ **历史参与段**（用户 2026-07-28 拍板选 A）：回过意见 → reject → reactivate 清 tech_lead_* 九列，
    //    tech_lead_id 已为 NULL，但 timeline 里他提交的 tech_lead_comment 行还在 → 仍可见。
    await comment(id, techTok, '本轮评估意见：可行。');
    //   ⚠️ 用 raw SQL 直接清九列造这个态，不走某条具体的业务边——本条要验证的不变量是
    //   「tech_lead_id 已为 NULL 时，历史回过意见的人仍可见」，与"究竟哪条边会清"是两件事
    //   （同 [B]/[RS]⑤ 组用 raw SQL 隔离测试目标的既有手法）。实测 reactivate 并不清该列，
    //   若把本条挂在某条业务边上，边的行为一变本组就会失去证明力。
    await run(`UPDATE sys_issues SET ${TECH_LEAD_COLS.filter(c => c !== 'tech_lead_notify_status').map(c => `${c}=NULL`).join(', ')}, tech_lead_notify_status='not_sent' WHERE id=?`, [id]);
    const cleared = await get('SELECT tech_lead_id FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(cleared.tech_lead_id, null, '前置：tech_lead_id 已清空（否则本条测的不是历史参与）');
    //   ⭐ codex 审 MED（断言加强）：先排除**其他授权来源**，否则"仍可见"可能是别的判据在兜底，
    //   本条就证明不了历史参与这一格真的生效。
    const noAlt = await get('SELECT assigned_to, release_assignee_id FROM sys_issues WHERE id=?', [id]);
    assert.notStrictEqual(Number(noAlt.assigned_to), 7, '前置：示例发布者不是 assigned_to（排除替代读权）');
    assert.notStrictEqual(Number(noAlt.release_assignee_id), 7, '前置：示例发布者不是 release_assignee_id（排除替代读权）');
    const noRoster = await get('SELECT 1 x FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=7', [id]);
    assert.ok(!noRoster, '前置：示例发布者不在 roster（排除替代读权）');
    const histRow = await get(`SELECT operator_id FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'`, [id]);
    assert.strictEqual(Number(histRow && histRow.operator_id), 7, '前置：历史 tech_lead_comment 行确实存在且 operator_id=7（本条唯一应生效的判据）');
    assert.ok((await listOf(techTok)).includes(id), '历史回过意见的单，即使 tech_lead_id 已清，示例发布者仍应可见（选项 A）');
    assert.strictEqual((await call('GET', `/api/sys-issues/${id}`, techTok)).status, 200, '历史参与详情应仍 200');
    // ⑤ 越权面未放宽：无关开发（id=5）对这两张单始终列表不可见 + 详情 403
    const devList = await listOf(devTok);
    assert.ok(!devList.includes(id) && !devList.includes(otherId), '无关开发不应因本次放行而看到这些单');
    assert.strictEqual((await call('GET', `/api/sys-issues/${id}`, devTok)).status, 403, '无关开发详情应仍 403');
    // ⑦ ⭐ 附件面裁剪（本次读权放开**自身引入的暴露面**）：技术负责人能开详情后，若不裁剪就能读到
    //    附件列表（文件名等元数据），而方案 §3 明写他「不看附件」。判据与下载端点同源。
    {
      const ca = await create('feature');
      const idA = ca.body.id;
      await consult(idA);
      await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status)
                 VALUES (?, 'spec', 'x.txt', ?, 1, '管理员', 'active')`, [idA, '需求规格_内部资料.docx']);
      const asAdmin = await call('GET', `/api/sys-issues/${idA}`, adminTok);
      assert.strictEqual(asAdmin.status, 200, 'admin 开详情应 200');
      assert.strictEqual((asAdmin.body.attachments || []).length, 1, '前置：admin 能看到该附件（证明附件确实存在，裁剪断言才有意义）');
      const asTech = await call('GET', `/api/sys-issues/${idA}`, techTok);
      assert.strictEqual(asTech.status, 200, '技术负责人开详情应 200（读权已放开）');
      assert.strictEqual((asTech.body.attachments || []).length, 0, '技术负责人**不应**看到附件列表（方案 §3：不看附件）');
      assert.strictEqual((asTech.body.specAttachments || []).length, 0, 'specAttachments 同样裁剪');
      assert.strictEqual(asTech.body.hasSpecAttachment, false, 'hasSpecAttachment 须随裁剪归 false（否则仍泄露"有无规格附件"）');
      assert.ok(Array.isArray(asTech.body.timeline) && asTech.body.timeline.length > 0, '裁剪只针对附件面——timeline 等主体仍应正常返回');
    }

    // ⑥ ⭐ codex 审 MED（**分支覆盖缺口**）：示例发布者 id=7 同时在 SYS_BUG_LIAISON=[7,13] 里，上面 ①-⑤ 走的
    //    全是**bug 对接人分支**（4 占位符那条）；**普通分支**（5 占位符）一条正向用例都没有。而判据刻意
    //    不挂白名单，正是为了"前任技术负责人退出白名单后仍够得到自己写的记录"——那个场景恰好走普通分支。
    //    故用 id=5（开发王·不在任何白名单）验证普通分支的两段读权。
    //    ⚠️ 用 raw SQL 造夹具：id=5 不在 SYS_TECH_LEAD_IDS，走不了 request/comment 端点（必 403），
    //    而本组要测的是**读端判据**不是写端，用 raw SQL 直接造出判据成立的状态是正确的隔离手法。
    {
      const c5 = await create('feature');
      const id5 = c5.body.id;
      assert.ok(!(await listOf(devTok)).includes(id5), '前置：开发王对该单本无任何读权');
      // ⑥-a 普通分支·当前被咨询段
      await run('UPDATE sys_issues SET tech_lead_id=5, tech_lead_name=? WHERE id=?', ['开发王', id5]);
      assert.ok((await listOf(devTok)).includes(id5), '普通分支·当前被咨询：列表应可见');
      assert.strictEqual((await call('GET', `/api/sys-issues/${id5}`, devTok)).status, 200, '普通分支·当前被咨询：详情应 200');
      // ⑥-b 普通分支·历史参与段（清 tech_lead_id，只留一条他的 tech_lead_comment 流水）
      await run('UPDATE sys_issues SET tech_lead_id=NULL, tech_lead_name=NULL WHERE id=?', [id5]);
      assert.ok(!(await listOf(devTok)).includes(id5), '中间态：两段判据都不成立时应不可见（证明下一步的可见来自历史参与而非兜底）');
      await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
                 VALUES (?, 'note', ?, 'tech_lead_comment', 5, ?)`, [id5, '前任技术负责人留下的评估意见', '开发王']);
      assert.ok((await listOf(devTok)).includes(id5), '普通分支·历史参与：列表应可见');
      assert.strictEqual((await call('GET', `/api/sys-issues/${id5}`, devTok)).status, 200, '普通分支·历史参与：详情应 200');
      // ⑥-c 精确性：同一分支下，无关的第三人（id=2 admin2 以非 admin token 模拟）不因此可见
      const strangerTok = jwt.sign({ id: 99, username: 'stranger', display_name: '路人', role: 'user' }, SECRET);
      assert.ok(!(await listOf(strangerTok)).includes(id5), '普通分支：无关第三人仍不可见');
      assert.strictEqual((await call('GET', `/api/sys-issues/${id5}`, strangerTok)).status, 403, '普通分支：无关第三人详情应 403');
    }
    ok('[V] 技术负责人读权（写读同源）：未咨询前不可见/403 · 被咨询后列表可见+详情200 · 从未咨询的单始终不可见（精确放行）· **历史回过意见即使 tech_lead_id 已清仍可见**（选项A·已排除 assigned_to/release_assignee/roster 替代读权）· 无关开发越权面未放宽 · ⭐**普通分支（非 bug 对接人白名单用户）两段读权正向覆盖 + 无关第三人仍拒**');
  }

  console.log(`\n✅ verify-sys-tech-lead-comment 全部通过（${passed} 组·C3+C4 技术负责人评估留言：权限/谓词边界/一条唯一/输入面/取消咨询/通知留痕/类型分流回归/补发通知/换轮组/类型分流fail-closed/换轮围栏/reactivate全链/PH-2自动清理留痕/提交侧轮次围栏/补发二次确认/C10-fix2 绑定对接人有效性校验[RV]）`);
  server.close(); db.close();
}

main().catch(e => { console.error('\n❌ verify-sys-tech-lead-comment 失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } db.close(); process.exit(1); });
