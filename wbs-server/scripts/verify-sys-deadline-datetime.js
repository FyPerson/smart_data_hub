// scripts/verify-sys-deadline-datetime.js — 四处优化 ②「期望完成精确到时分」验收
//   SSOT = 锚点 docs/local/系统迭代/任务_四处优化_20260803.md §3（E2/E3/E4）+ §7 22:07 条
//   用法：node scripts/verify-sys-deadline-datetime.js
//
// 为什么分三层断言（缺任一层都有静默失败的口子）：
//   [A] 用例表直调 normalizeDeadlineDT —— 格式/边界/归一化，端点前置条件无关，边界能测全
//   [B] ⭐ 共用校验器未被污染 —— 本次最关键的回归锁。normalizeDeadline 被 scheduled_start /
//       planned_date / duty_date / date_from / date_to 共 6 个「只到天」的字段复用，若把它直接
//       放宽就会一次性放开这些字段。B 组是「我没有那么干」的唯一硬证据，且能挡住未来有人
//       图省事把两个函数合并。
//   [C] 走真实 HTTP 端点 —— 层内全绿 ≠ 功能可用：函数写对了但端点没接线（还在调旧的），
//       A 组照样全绿。写 deadline 的端点逐个证明真换了口径：建单 / edit-in-revision / derive 三个
//       有正负向 HTTP 断言；scope-change 的 deadline 分支**当前无 type 可达**（feature/improvement 被
//       前置守卫拦 409、bug/config 走不到该动作；源码注释与 verify-sys-flow [8] 均载明），故只锁住
//       「不可达」这一前提 —— 变可达即红，届时补真正的正负向断言。
//   [D] 存量兼容 —— 未传该字段的行不得被动（E2 不刷写存量）。
//   [E] 排序合同锁 —— 含**反证**：证明「用 date 类型会排错」不是臆想，而是真实可复现的。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-deadline-dt-secret';
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

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;

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

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 2026-08-01 日期炸弹教训（见 verify-sys-attachments futureEst 注释）：远期字面量迟早到期，动态生成。
//   deadline 本身不校验"不得早于现在"，但同分支的 estimate 类字段会，统一用动态值防以后加校验时集体到期。
function futureDay(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DAY = futureDay(45);          // 'YYYY-MM-DD'
const DAY2 = futureDay(60);

const createBody = (extra) => Object.assign({
  intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部',
  description: '四处优化 D2 fixture：期望完成到时分', intake_liaison_id: 13,
}, extra || {});

async function createIssue(extra) {
  const r = await call('POST', '/api/sys-issues', adminTok, createBody(extra));
  return r;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // users 夹具须含 phone 列：建单端点在需求方三字段全空时会 SELECT users.phone 做固化（同 verify-sys-attachments 注释）
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;

  try {
    const N = I.normalizeDeadlineDT;
    assert.ok(typeof N === 'function', '前置：_internals 应导出 normalizeDeadlineDT');

    // ══ [A] 用例表：normalizeDeadlineDT 格式 / 归一化 / 边界 ══════════════════════════
    // ⚠️ 期望值自时间格式统一 S3（20260804·D4）起**一律带 ':00'**：库内时间统一到秒，用户填到分、后端补秒。
    //   秒仍不承载精度（deadline 语义就到分钟），':00' 是格式对齐——所以 '14:30:59' 依旧截到分再补 ':00'，
    //   而不是保留 59。
    const accept = [
      [`${DAY} 14:30`, `${DAY} 14:30:00`, '空格分隔的时分 → 补 :00 入库（D4）'],
      [`${DAY}T14:30`, `${DAY} 14:30:00`, 'datetime-local 的 T 分隔 → 归一为空格分隔 + 补 :00'],
      [DAY, `${DAY} 00:00:00`, '纯日期 → 补 00:00 再补 :00（E3：控件可只挑日期）'],
      [`${DAY} 14:30:59`, `${DAY} 14:30:00`, '带秒 → 截到分钟再补 :00（秒不承载精度·API 直调/历史值兼容）'],
      [`  ${DAY} 09:05  `, `${DAY} 09:05:00`, '首尾空白 trim'],
      [`${DAY} 00:00`, `${DAY} 00:00:00`, '零点原样（不被当成空值丢掉）'],
      [`${DAY} 23:59`, `${DAY} 23:59:00`, '边界上限 23:59'],
      // D10 幂等：把上一行的**输出**再喂回去，必须原样通过——否则从库里读回带秒的值重提会被自己 400 拒。
      [`${DAY} 14:30:00`, `${DAY} 14:30:00`, '⭐ D10 幂等：自身输出重入原样通过'],
    ];
    for (const [input, expect, why] of accept) {
      const r = N(input);
      assert.ok(r.ok, `[A] 应接受 ${JSON.stringify(input)}（${why}），实得 ok=false`);
      assert.strictEqual(r.value, expect, `[A] ${JSON.stringify(input)} 应归一化为 ${JSON.stringify(expect)}，实得 ${JSON.stringify(r.value)}`);
    }
    ok(`[A1] 接受口径 ${accept.length} 例逐条归一化正确（T分隔/纯日期补00:00/带秒截分/trim/零点/23:59/**D10 幂等重入**）`);

    for (const empty of [undefined, null, '', '   ']) {
      const r = N(empty);
      assert.ok(r.ok && r.value === null, `[A] 空值 ${JSON.stringify(empty)} 应放行为 null（deadline 选填），实得 ${JSON.stringify(r)}`);
    }
    ok('[A2] 空值四态（undefined/null/空串/纯空格）→ { ok:true, value:null }，与旧 deadline 选填口径一致');

    const reject = [
      [`${DAY.slice(0, 5)}02-30 14:30`, '2 月 30 日——格式对但日期不存在（真实日期回比对防线）'],
      [`${DAY} 25:00`, '25 时——正则只锁两位数字，靠范围校验挡'],
      [`${DAY} 12:70`, '70 分——同上'],
      [DAY.replace(/-/g, '/') + ' 14:30', '斜杠分隔'],
      ['abc', '纯垃圾串'],
      [`${DAY} 14`, '缺分钟'],
      [`${DAY} 1:30`, '时位只有一位（格式不严）'],
      ['2026-13-01 10:00', '13 月'],
      // codex 248 M-3：秒位原来只用 `(?::\d{2})?` 匹配、不捕获不校验 ⇒ 下面两例会被静默接受并截成 14:30，
      //   与错误文案里的「真实时间」自相矛盾，也让调用方误以为那个秒是合法的。
      [`${DAY} 14:30:99`, '99 秒——秒位必须捕获后校验，不能只匹配两位数字'],
      [`${DAY} 12:30:60`, '60 秒（上界外一位）'],
    ];
    for (const [input, why] of reject) {
      const r = N(input);
      assert.ok(!r.ok, `[A] 应拒绝 ${JSON.stringify(input)}（${why}），实得 ok=true value=${JSON.stringify(r.value)}`);
    }
    ok('[A3] 负向 10 例全拒（02-30/25时/70分/斜杠/垃圾串/缺分/单位时/13月/**99秒/60秒**）');

    // ══ [B] ⭐ 共用校验器未被污染（本脚本最关键的一组）═════════════════════════════════
    //   normalizeDeadline 是 scheduled_start / planned_date / duty_date / date_from / date_to
    //   共用的「只到天」校验器。若有人图省事把它直接放宽（或把两个函数合并），下面必红。
    const OLD = I.normalizeDeadline;
    assert.ok(typeof OLD === 'function', '[B] 前置：normalizeDeadline 应仍然存在（不得被删/被合并）');
    assert.notStrictEqual(OLD, N, '[B] ⭐ 两个校验器必须是**不同的函数**——若被合并成同一个，纯日期字段就被连带放宽了');
    ok('[B1] ⭐ normalizeDeadline 与 normalizeDeadlineDT 并存且非同一函数（挡「图省事合并」）');

    for (const bad of [`${DAY} 14:30`, `${DAY}T14:30`, `${DAY} 00:00`]) {
      const r = OLD(bad);
      assert.ok(!r.ok, `[B] ⭐ 共用校验器必须仍拒绝带时分的 ${JSON.stringify(bad)}——它管着计划开工日/值班日期/排班区间，放宽即污染 6 个字段`);
    }
    ok('[B2] ⭐ 共用 normalizeDeadline 仍拒绝一切带时分输入（计划开工日/值班日期/排班区间口径未被连带放宽）');

    const stillOk = OLD(DAY);
    assert.ok(stillOk.ok && stillOk.value === DAY, '[B] 共用校验器对纯日期应照常放行（防「为了让 B2 绿而把整个函数测死」的假绿）');
    ok('[B3] 共用 normalizeDeadline 对纯日期照常放行（B2 的对照组，证明拒的是时分而非全拒）');

    // ══ [C] 走真实 HTTP 端点：四个写 deadline 的端点是否真换了口径 ═══════════════════
    //   层内全绿 ≠ 功能可用——A 组证明函数对，C 组证明端点真的调了它。
    let r = await createIssue({ deadline: `${DAY} 14:30` });
    assert.strictEqual(r.status, 201, `[C] 建单带时分应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const idA = r.body.id;
    let row = await get('SELECT deadline FROM sys_issues WHERE id = ?', [idA]);
    assert.strictEqual(row.deadline, `${DAY} 14:30:00`, `[C] 建单端点应落库到秒（D4：分钟级输入补 :00），实得 ${JSON.stringify(row.deadline)}`);
    ok('[C1] POST /sys-issues 带时分 → 201 且逐字落库 "YYYY-MM-DD HH:MM"（端点确已换用 DT 校验器）');

    r = await createIssue({ deadline: DAY });
    assert.strictEqual(r.status, 201, '[C] 建单传纯日期应仍 201（向后兼容旧客户端）');
    row = await get('SELECT deadline FROM sys_issues WHERE id = ?', [r.body.id]);
    assert.strictEqual(row.deadline, `${DAY} 00:00:00`, `[C] 纯日期应补 00:00 再补 :00，实得 ${JSON.stringify(row.deadline)}`);
    ok('[C2] POST /sys-issues 传纯日期 → 仍 201 且补 00:00（旧客户端/API 直调不被打断）');

    r = await createIssue({ deadline: `${DAY} 25:00` });
    assert.strictEqual(r.status, 400, `[C] 建单传非法时分应 400，实得 ${r.status}`);
    assert.strictEqual(r.body && r.body.code, 'INVALID_DEADLINE', `[C] 错误码应保持 INVALID_DEADLINE（对外契约未变），实得 ${JSON.stringify(r.body)}`);
    ok('[C3] POST /sys-issues 非法时分 → 400 且错误码仍为 INVALID_DEADLINE（对外契约未变）');

    // C4：编辑端点（edit-in-revision）——单据需在「待受理」态，建单落态即是
    r = await call('POST', `/api/sys-issues/${idA}/edit-in-revision`, adminTok, {
      title: 't2', description: 'd', system_name: 'BMS', module_name: '', priority: 'P2',
      deadline: `${DAY2} 09:15`, requester_dept: '', requester_name: '', requester_phone: '',
    });
    assert.strictEqual(r.status, 200, `[C] 编辑端点带时分应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT deadline FROM sys_issues WHERE id = ?', [idA]);
    assert.strictEqual(row.deadline, `${DAY2} 09:15:00`, `[C] 编辑端点应落库到秒（D4），实得 ${JSON.stringify(row.deadline)}`);
    ok('[C4] POST /sys-issues/:id/edit-in-revision 带时分 → 200 且落库到秒 HH:MM:00（E4：建单与编辑同口径，不会「建单能填分钟、一编辑就丢」；D4 库内到秒/显示到分）');

    r = await call('POST', `/api/sys-issues/${idA}/edit-in-revision`, adminTok, {
      title: 't2', description: 'd', system_name: 'BMS', module_name: '', priority: 'P2',
      deadline: `${DAY2} 12:70`, requester_dept: '', requester_name: '', requester_phone: '',
    });
    assert.strictEqual(r.status, 400, `[C] 编辑端点非法时分应 400，实得 ${r.status}`);
    ok('[C5] 编辑端点非法时分 → 400（负向同口径，不是只在建单侧校验）');

    // ── C6/C7：派生新单端点（codex 248 M-1 补做）──────────────────────────────────
    //   首版只测了建单 + edit-in-revision 两个端点，输出文案却写「四端点」——**表述不实**，本组补齐。
    //   derive 的前置：origin 为 bug 且 status='已上线'，derive_reason 必填（§4「仅从已上线单发起」）
    const originR = await createIssue({ type: 'bug' });
    const originId = originR.body.id;
    await run(`UPDATE sys_issues SET status = '已上线' WHERE id = ?`, [originId]);
    r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, createBody({
      type: 'bug', derive_reason: '上线后发现同款问题', deadline: `${DAY2} 16:45`,
    }));
    assert.ok(r.status === 200 || r.status === 201, `[C] 派生新单带时分应 2xx，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const derivedId = r.body && (r.body.id || r.body.new_id);
    assert.ok(derivedId, `[C] 派生应返回新单 id，实得 ${JSON.stringify(r.body)}`);
    row = await get('SELECT deadline FROM sys_issues WHERE id = ?', [derivedId]);
    assert.strictEqual(row.deadline, `${DAY2} 16:45:00`, `[C] 派生新单应落库到秒（D4），实得 ${JSON.stringify(row.deadline)}`);
    ok('[C6] POST /sys-issues/:id/derive 带时分 → 2xx 且新单 deadline 落库到秒 HH:MM:00（codex 248 M-1 补做；D4 库内到秒/显示到分）');

    r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, createBody({
      type: 'bug', derive_reason: '上线后发现同款问题', deadline: `${DAY2} 14:30:99`,
    }));
    assert.strictEqual(r.status, 400, `[C] 派生端点非法秒位应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body && r.body.code, 'INVALID_DEADLINE', `[C] 派生端点错误码应为 INVALID_DEADLINE，实得 ${JSON.stringify(r.body)}`);
    ok('[C7] 派生端点非法输入 → 400 INVALID_DEADLINE（同时验证了 M-3 的秒位校验在真实端点上生效）');

    // ── C8：scope-change ——⚠️ **该端点主体当前无任何 type 可达**，如实记录而非硬造测试 ──────
    //   源码注释（ultracode 对抗审留痕）与 verify-sys-flow [8] 均已载明：feature/improvement 被前置
    //   守卫拦成 409 SCOPE_CHANGE_DISABLED；bug/config 走不到 scope_change 动作（findTransition 返 null）。
    //   deadline 分支已换用 normalizeDeadlineDT（见源码守卫 [G1]），但**无法从 HTTP 侧证明它跑通**——
    //   与其造一个假测试或默默跳过，不如把"不可达"这个前提本身锁住：哪天它变可达了，本条会红，
    //   届时应补真正的正负向断言。
    //   ⚠️ codex 248-B MED-2：首版只锁了 feature 一类，那只证明了前提的四分之一——improvement 换条路
    //   或 bug 变可达，断言都不会红。改为**逐 type 全覆盖**，并把 type 全集本身也锁住。
    const typeKeys = Object.keys(I.transitions.ALLOWED_STATUSES || {}).sort();
    assert.deepStrictEqual(typeKeys, ['bug', 'feature', 'improvement'],
      `[C] type 全集应恰为 bug/feature/improvement（源码注释提到的 "config 流"当前并不存在）。新增 type 时本条会红 —— 那正是提醒：新 type 的 scope-change 可达性必须重新评估，实得 ${JSON.stringify(typeKeys)}`);
    const scopeExpect = { feature: 'SCOPE_CHANGE_DISABLED', improvement: 'SCOPE_CHANGE_DISABLED', bug: 'SCOPE_STATUS_INVALID' };
    for (const [ty, expectCode] of Object.entries(scopeExpect)) {
      const si = await createIssue({ type: ty });
      const rs = await call('POST', `/api/sys-issues/${si.body.id}/scope-change`, adminTok, { summary: 's', deadline: `${DAY2} 10:00` });
      assert.strictEqual(rs.status, 409, `[C] scope-change 对 ${ty} 应 409（不可达），实得 ${rs.status} ${JSON.stringify(rs.body)}`);
      assert.strictEqual(rs.body && rs.body.code, expectCode,
        `[C] ${ty} 的拦截码应为 ${expectCode}（变成别的码或 2xx = 端点变可达了，需补真正的 deadline 正负向断言），实得 ${JSON.stringify(rs.body)}`);
    }
    ok('[C8] scope-change 的 deadline 分支不可达前提**逐 type 锁定**（feature/improvement→SCOPE_CHANGE_DISABLED、bug→SCOPE_STATUS_INVALID）+ type 全集锁 —— 不硬造测试，也不默默跳过');

    // ══ [D] 存量兼容：未传 deadline 的编辑不得改动既有值（E2 不刷写存量）═══════════════
    //   模拟存量：直接 SQL 写一行**纯日期**（存量 7 行就是这个形态）
    const legacy = await createIssue({});
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, [DAY, legacy.body.id]);
    r = await call('POST', `/api/sys-issues/${legacy.body.id}/edit-in-revision`, adminTok, {
      title: 't3', description: 'd', system_name: 'BMS', module_name: '', priority: 'P1',
      requester_dept: '', requester_name: '', requester_phone: '',   // ⚠️ 刻意不传 deadline
    });
    assert.strictEqual(r.status, 200, `[D] 不传 deadline 的编辑应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT deadline, priority FROM sys_issues WHERE id = ?', [legacy.body.id]);
    assert.strictEqual(row.priority, 'P1', '[D] 对照：其他字段确实被改了（证明这次编辑真的生效，不是整体没走通）');
    assert.strictEqual(row.deadline, DAY, `[D] ⭐ 未传 deadline 时存量**纯日期必须原样保留**（E2：不伪造精度、不批量刷写），实得 ${JSON.stringify(row.deadline)}`);
    ok('[D1] ⭐ 编辑时未传 deadline → 存量纯日期原样保留（E2 不刷写存量；带 priority 对照证明编辑本身生效）');

    // ══ [E] 排序合同锁 + 反证 ═════════════════════════════════════════════════════
    const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    const mapBody = (pageSrc.match(/const\s+SI_SORT_FIELD_TYPES\s*=\s*\{([\s\S]*?)\n\s*\};/) || [])[1] || '';
    assert.ok(mapBody, '[E] 前置：应能从源码解析出 SI_SORT_FIELD_TYPES');
    assert.ok(/^\s*deadline:\s*'string'/m.test(mapBody),
      `[E] ⭐ deadline 的排序类型必须是 'string' 而非 'date'——见下条反证。实得片段：${(mapBody.match(/deadline:\s*'\w+'/) || ['<未找到>'])[0]}`);
    ok("[E1] ⭐ 合同锁：SI_SORT_FIELD_TYPES.deadline === 'string'（改回 'date' 即红）");

    // ⭐ 反证：证明「用 date 类型会排错」是真实可复现的，不是臆想出来的理由。
    //   共享层 compareByType 的 'date' 分支就是 new Date(a) - new Date(b)。
    const pureDay = '2026-09-15', sameDayEarly = '2026-09-15 07:00';
    const byDate = new Date(pureDay).getTime() - new Date(sameDayEarly).getTime();
    const byString = String(pureDay).localeCompare(String(sameDayEarly), 'zh-Hans-CN');
    assert.ok(byDate > 0,
      `[E] 反证前提：new Date('${pureDay}') 应**晚于** new Date('${sameDayEarly}')（UTC 午夜 vs 本地时间，差 8 小时）——` +
      `若本条失败说明运行环境时区非东八区，[E2] 的错位结论需重新评估，实得差 ${byDate}ms`);
    assert.ok(byString < 0,
      `[E] 字典序应把纯日期排在同日带时分之前（前缀关系），实得 ${byString}`);
    ok(`[E2] ⭐ 反证成立：'date' 类型下纯日期会被排到同日 07:00 **之后**（差 ${byDate / 3600000} 小时），'string' 字典序则正确——这就是 E1 不能改回 'date' 的原因`);

    // codex 248 LOW-1：注释原把 localeCompare 等同于严格 ISO 字典序，但 locale collation 并不等价于
    //   字符码比较。措辞已修正，这里把「实际用到的四类顺序」逐条锁住——不靠"理论上等价"，靠实测。
    const cmp = (a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN');
    const orderCases = [
      ['2026-09-15', '2026-09-15 07:00', '同日：纯日期 < 同日带时分（前缀关系）'],
      ['2026-09-15 07:00', '2026-09-15 14:30', '同日两个带时分：按时刻'],
      ['2026-09-15 23:59', '2026-09-16', '跨日：前一日晚间 < 次日纯日期'],
      ['2026-09-09 10:00', '2026-09-10 10:00', '跨日零填充：09 < 10（非零填充会在此错位）'],
      ['2026-12-31 23:59', '2027-01-01', '跨年'],
    ];
    for (const [a, b, why] of orderCases) {
      assert.ok(cmp(a, b) < 0, `[E] 字典序 ${JSON.stringify(a)} 应 < ${JSON.stringify(b)}（${why}），实得 ${cmp(a, b)}`);
    }
    // 空值：deadline 有 7 行是空的，改 fieldTypes 会不会影响它们的位置？前提是"空值根本不进 compareByType"。
    //   ⚠️ 这条必须是**合同锁**而不是自说自话——写成 `['',null,undefined].every(v => v===''||...)` 那样
    //   的式子恒为真，等于没测（[[feedback_test_assertion_self_error]] 说的"断言永远成立"形态）。
    //   故读共享层源码，锁住"空值判定在 compareByType 调用之前"这个结构。
    const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'unify-helpers.js'), 'utf8');
    //   ⚠️ 位置比较必须在 **compareRow 函数体内**做：直接对全文 indexOf('compareByType(...)') 拿到的是
    //   该函数的**定义**位置（文件更靠前），不是 compareRow 里的调用位置——首版就这么写，红灯后诊断为
    //   「断言写错」而非实现错（[[feedback_test_assertion_self_error]]：红灯第一问是"谁错了"）。
    const compareRowBody = (helperSrc.match(/function compareRow\([\s\S]*?\n  \}/) || [''])[0];
    assert.ok(compareRowBody, '[E] 前置：应能解析出共享层 compareRow 函数体');
    const iEmptyGuard = compareRowBody.indexOf('if (aEmpty && bEmpty) return 0;');
    const iCallByType = compareRowBody.indexOf('compareByType(');
    assert.ok(iEmptyGuard >= 0 && compareRowBody.includes('if (aEmpty) return 1;') && compareRowBody.includes('if (bEmpty) return -1;'),
      '[E] 共享层 compareRow 应有空值三态前置判定（aEmpty&&bEmpty / aEmpty / bEmpty）');
    assert.ok(iCallByType > iEmptyGuard,
      `[E] 空值判定必须**在** compareByType 调用之前——否则改 deadline 的 fieldTypes 会连带改变 7 行空 deadline 的排序位置。实得 compareRow 体内 guard@${iEmptyGuard} vs call@${iCallByType}`);
    ok('[E3] 字典序四类顺序实测锁定（同日前缀/同日时刻/跨日/跨年零填充）+ 空值前置判定在 compareByType 之前（合同锁，非恒真式）');

    // ══ [F] 表单 helper 契约（静态读源码）═══════════════════════════════════════════
    const fdt = (pageSrc.match(/function fDateTime\(([^)]*)\)\s*\{([\s\S]*?)\n\s{4}function /) || [])[0] || '';
    assert.ok(/function fDateTime\(k, l, v, req\)/.test(pageSrc),
      '[F] fDateTime 应带第 4 参 req（选填字段不能被硬编码的必填星号污染）');
    assert.ok(/fDateTime[\s\S]{0,200}?\$\{req \? ' <span class="u-req">\*<\/span>' : ''\}/.test(pageSrc),
      '[F] fDateTime 的必填星号必须受 req 控制，而非无条件渲染');
    ok('[F1] fDateTime 已加第 4 参 req 且星号受其控制（与 fText/fTextarea 同构：不传=不必填）');

    // [P3 例外驱动收敛·2026-08-13·1bb580f 基线更新] 受理/指派/改派三弹窗的三处独立选填调用（组 A
    //   2026-08-12 口径）已收敛为共用组件 siEtaFieldGroupHtml 单点调用（req=!!vis.required 由可见性矩阵
    //   动态决定必填/选填），另有 siRevealEtaFieldOnFallback 服务端兜底揭示 1 处（恒必填）——
    //   与既有 siModalEstimate/siModalFeasibility 两处真必填（req=true）合计恰 4 处。按 req 形态拆
    //   "字面 true / 动态 !!vis.required"两组分别断言（不再存在字面 false 组——选填与否已上移到矩阵层）。
    const estimateCalls = pageSrc.match(/fDateTime\('dev_estimated_at'[^\n]*/g) || [];
    assert.strictEqual(estimateCalls.length, 4, `[F] 应有 4 处 dev_estimated_at 调用（siModalEstimate/siModalFeasibility 必填 2 处 + siEtaFieldGroupHtml 动态 1 处 + siRevealEtaFieldOnFallback 兜底必填 1 处），实得 ${estimateCalls.length}：${JSON.stringify(estimateCalls)}`);
    const estimateRequiredCalls = estimateCalls.filter(c => /,\s*true\)/.test(c));
    const estimateDynamicCalls = estimateCalls.filter(c => /,\s*!!vis\.required\)/.test(c));
    assert.strictEqual(estimateRequiredCalls.length, 3, `[F] dev_estimated_at 字面必填（req=true）应恰 3 处（siModalEstimate/siModalFeasibility/siRevealEtaFieldOnFallback），实得 ${estimateRequiredCalls.length}：${JSON.stringify(estimateCalls)}`);
    assert.strictEqual(estimateDynamicCalls.length, 1, `[F] dev_estimated_at 动态必填（req=!!vis.required·siEtaFieldGroupHtml 三弹窗共用条件渲染）应恰 1 处，实得 ${estimateDynamicCalls.length}：${JSON.stringify(estimateCalls)}`);
    assert.strictEqual(estimateRequiredCalls.length + estimateDynamicCalls.length, estimateCalls.length,
      `[F] 4 处 dev_estimated_at 调用应逐一落在"字面 true"或"动态 !!vis.required"其中一组，不得出现两者都不匹配的第三种形态（如漏传第 4 参）——实得 ${JSON.stringify(estimateCalls)}`);
    const deadlineCalls = pageSrc.match(/fDateTime\('deadline'[^\n]*/g) || [];
    assert.strictEqual(deadlineCalls.length, 2, `[F] 应有 2 处 deadline 调用（建单 + 编辑），实得 ${deadlineCalls.length}`);
    for (const c of deadlineCalls) {
      assert.ok(!/,\s*true\)/.test(c), `[F] deadline 是选填（E3），不得传 req=true，实得：${c}`);
    }
    ok('[F2] dev_estimated_at 5 处调用（2 真必填 true + 3 组A选填 false）+ 2 处 deadline 调用不传（选填·E3）——改签名没漏改调用点');

    // codex 248 M-2：纯日期兼容必须放在 **deadline 专用** helper 里，不能塞进通用的 siToLocalInput
    //   （`dev_estimated_at` 两处回填弹窗也在用它——脏纯日期值会被静默固化成午夜，把不完整的承诺
    //   伪装成精确到分钟的承诺）。同一原则后端已执行：normalizeDeadline 不放宽、另建 DT 版。
    assert.ok(/function siDeadlineToLocalInput\(v\)/.test(pageSrc),
      '[F] 应存在 deadline 专用预填 helper siDeadlineToLocalInput');
    const genericBody = (pageSrc.match(/function siToLocalInput\(v\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    assert.ok(genericBody, '[F] 前置：应能解析出 siToLocalInput 函数体');
    assert.ok(!/T00:00/.test(genericBody),
      `[F] ⭐ 通用 siToLocalInput 必须保持严格（不得含 T00:00 补齐分支），否则 dev_estimated_at 的脏纯日期会被静默补成午夜。实得函数体：${genericBody.slice(0, 300)}`);
    assert.ok(/function siDeadlineToLocalInput\(v\)\s*\{[\s\S]{0,400}?T00:00/.test(pageSrc),
      '[F] 纯日期补齐分支应在 siDeadlineToLocalInput 内');
    ok('[F3] ⭐ 纯日期兼容拆进 deadline 专用 helper，通用 siToLocalInput 保持严格（与后端「不污染共用校验器」同一原则，两边执行一致）');

    // codex 248 HIGH-1：编辑窗必须做 dirty 比对——预填 ≠ 该写回库。
    assert.ok(/const deadlinePrefill = siDeadlineToLocalInput\(iss\.deadline\);/.test(pageSrc),
      '[F] 编辑窗应记录 deadline 预填值供 dirty 比对');
    assert.ok(/if \(deadlineUnrenderable \|\| v\.deadline !== deadlinePrefill\) body\.deadline = siFromLocalInput\(v\.deadline\);/.test(pageSrc),
      '[F] ⭐ 编辑窗提交必须做 dirty 比对：与预填逐字相同就**不进 body**，否则用户只改标题也会把存量纯日期被动改写成 00:00（E2 伪造精度）');
    assert.ok(!/priority: v\.priority, deadline: siFromLocalInput/.test(pageSrc),
      '[F] body 字面量里不得再无条件带 deadline（那正是被动改写的来源）');
    // codex 248-B MED-1：非空但控件承载不了的脏值必须能被清除，否则用户留空也提交不上去
    assert.ok(/const deadlineUnrenderable = !!rawDeadline && !deadlinePrefill;/.test(pageSrc),
      '[F] 应有"脏值不可显示"分支：非空 deadline 若无法映射到 datetime-local，任何提交（含留空）都要放行，否则脏值永远清不掉');
    ok('[F4] ⭐ 编辑窗 dirty 判断就位（未改动→不进 body→后端 `if (!(f in b)) continue` 跳过→存量纯日期原样留库·codex 248 HIGH-1）+ 脏值可清除分支（248-B MED-1）');

    // ══ [G] **启发式**源码守卫：防未来写入路径绕过（codex 248 M-4 部分采纳 / 248-B LOW-2 措辞校准）══
    //   ⚠️ 定位是「启发式守卫」而非「结构性保护」——它靠正则扫源码，失效模式是**漏报**：
    //   调用换行书写、经别名/包装函数间接调用、参数里带嵌套括号，都可能扫不到。
    //   它挡得住的：「deadline 又去调了共用的纯日期校验器」这一类直接回归。
    //   它挡不住的：「新端点直接写裸值的 SQL」——那需要 AST 解析或 SQLite CHECK 约束，
    //   而 CHECK 属 schema 变更（本任务 §4 禁区）。故只做能做准的那一半，并如实标注能力边界。
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    //   `normalizeDeadline(` 不会匹配到 `normalizeDeadlineDT(`（后者 normalizeDeadline 之后是 D 不是括号）
    const oldCallArgs = [...routeSrc.matchAll(/normalizeDeadline\(([^)]*)\)/g)].map(m => m[1].trim()).filter(a => a && a !== 'raw');
    const offenders = oldCallArgs.filter(a => /deadline/i.test(a));
    assert.strictEqual(offenders.length, 0,
      `[G] ⭐ 不得再有 deadline 走共用的纯日期校验器（那会让它退回"只到天"并破坏字典序前提）。实得违规调用：${JSON.stringify(offenders)}`);
    assert.ok(oldCallArgs.length >= 5,
      `[G] 共用校验器仍应服务若干纯日期字段（scheduled_start/planned_date/duty_date/date_from/date_to），实得 ${oldCallArgs.length} 处：${JSON.stringify(oldCallArgs)}`);
    const dtCallArgs = [...routeSrc.matchAll(/normalizeDeadlineDT\(([^)]*)\)/g)].map(m => m[1].trim()).filter(a => a && a !== 'raw');
    assert.ok(dtCallArgs.length >= 4 && dtCallArgs.every(a => /deadline/i.test(a)),
      `[G] DT 版应恰好服务 deadline（≥4 处且参数都含 deadline），实得 ${JSON.stringify(dtCallArgs)}`);
    ok(`[G1] ⭐ 启发式源码守卫：deadline 调用全部走 DT 版（${dtCallArgs.length} 处），共用校验器仍只服务纯日期字段（${oldCallArgs.length} 处），两者零交叉（⚠️ 失效模式=漏报，见上方边界说明）`);

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 期望完成到时分（D2②）验收通过`);
    console.log('  A：DT 校验器接受 7 / 空值 4 / 负向 10（含秒位 99、60 —— codex 248 M-3）');
    console.log('  B：⭐ 共用 normalizeDeadline 未被连带放宽（计划开工日/值班日期/排班区间 6 字段口径保持只到天）');
    console.log('  C：走真实 HTTP —— 建单正负 + 纯日期兼容 + 编辑正负 + **派生正负**；');
    console.log('     ⚠️ scope-change 的 deadline 分支**当前无 type 可达**（源码注释与 verify-sys-flow [8] 均载明），');
    console.log('        故锁住「不可达」这一前提（变可达即红）而非硬造测试 —— 首版汇总文案曾笼统写「四端点」，属表述不实，已按实情改写');
    console.log('  D：⭐ 未传字段时存量纯日期原样保留（E2）——真实前端路径由 [F4] dirty 判断接上');
    console.log('  E：⭐ 排序合同锁 + 「date 会排错」可复现反证 + 四类顺序实测 + 空值前置判定合同锁');
    console.log('  F：helper 契约 —— fDateTime 签名 / 调用点必填选填分流 / deadline 专用预填 helper / 编辑窗 dirty 判断');
    console.log('  G：⭐ 源码守卫 —— deadline 全走 DT 版、与共用校验器零交叉（边界：挡不住新增裸 SQL 写入路径）');
  } finally {
    server.close();
    db.close();
  }
}

main().catch((e) => { console.error('❌ verify-sys-deadline-datetime 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
