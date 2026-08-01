// 验证脚本：系统迭代 建单优化批 C1 后端 — 对接人下拉 + intake 通知通道 + title/description 请求矩阵
//   （方案 docs/local/系统迭代/系统迭代_建单优化批_方案_20260731_v1.2.md §3/§4/§6b/§7）
//   用法：node scripts/verify-sys-intake-liaison.js
//
// 行为面清单制（对齐 verify-sys-executor-remove.js 范式）：
//   [①] 迁移语义组：6 列存在 + PRAGMA table_info 断言 intake_notify_status notnull=1/dflt_value='not_sent'
//        + 部署硬闸门四项（非法值计数=0 / 非 NULL intake_liaison_id 不在受理人集合计数=0 /
//        sent 态必有 message_key / read_at 非空时必为 sent 态）
//   [②] 主入口缺省 intake_liaison_id → 400 / 非受理人 id → 400 / 合法 id → 201 落库
//   [③] title/description 请求矩阵四行 + 派生算法四组边界（多空行开头/emoji code point 边界/超长
//        单行截断/有 title 沿用）
//   [④] 衍生入口自动填：=1 自动填成功；0 人/2 人（临时改常量+mock 用户 active 态）→ 409
//   [⑤] NULL 单收件人降级：=1 发送成功（含回写 intake_liaison_id + 回写后二次 notify 走常规路径 +
//        read-status 不因曾为 NULL 空转）；0 人 409 INTAKE_LIAISON_CONFIG_ERROR；多人 409 INTAKE_LIAISON_MISSING
//   [⑥] 通知三态流转 + 重发（含 failed 后重发）无条件清 intake_read_at
//   [⑦] read-status 他通道不混淆（intake vs creator 各自 read_at 独立）+ 陈旧缓存不回写（重发后不再 cached）
//   [⑧] 仅「待受理」态可发：非待受理 409 STATUS_NOT_NOTIFIABLE；未知 type（直造脏数据）400 MANUAL_NOTIFY_TYPE_NA；
//        非 admin → 403（路由级 requireAdmin）
//   [⑨] 回受理门（reactivate + resubmit-intake）：intake 通知 5 列归零 + intake_liaison_id 保留原值
//   [⑩] codex 461a1e0 HIGH 收口新负例：常规路径 intake_liaison_id 命中已停用受理人 → 409 INTAKE_LIAISON_INACTIVE
//
// 断言纪律：钉确切 HTTP 码（400 vs 409 分清）；清理类断言先设哨兵值再比对（非 NULL==NULL 假绿）；
//   负例断言无副作用（落库/timeline 均不变）。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-liaison-secret';
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

// 钉钉发送 stub：默认成功（每次生成唯一 message_key，便于区分"新旧 key"）；置 dingtalkFailNext 造一次失败。
let dingtalkFailNext = false;
async function mockSendIssueDingtalkRaw() {
  if (dingtalkFailNext) { dingtalkFailNext = false; return { ok: false, message_key: null, reason: 'network' }; }
  return { ok: true, message_key: 'stub-key-' + Math.random().toString(36).slice(2, 8) };
}
async function mockBaseUrl() { return ''; }

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
  getSafePlatformBaseUrl: mockBaseUrl,
});
const I = mod._internals;
function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

// ⚠️ 测试 id 与生产 users.id 无对应关系（同 verify-sys-role-perm-c1.js 踩坑记录）：只看 JWT role +
//   SYS_INTAKE_LIAISON_IDS=[13] 白名单本身。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);   // [⑨] issue_reject 前置须有当前轮评估意见

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function createBody(overrides = {}) {
  return {
    intake_contract_version: 2, type: 'feature', system_name: 'BMS', source: '内部',
    intake_liaison_id: 13, description: '默认描述内容用于建单',
    ...overrides,
  };
}
const issueRow = (id) => get('SELECT * FROM sys_issues WHERE id=?', [id]);

// 直连 SQL 造"存量单"（intake_liaison_id 恒 NULL，模拟本方案上线前建的单，主建单端点无法再产出此形态）。
async function mkLegacyIssue(status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, description, system_name, source, created_by, created_by_name)
     VALUES (?, ?, ?, ?, 'BMS', '内部', 1, '管理员')`,
    [extra.type || 'feature', status, extra.title || `存量单-${status}`, extra.description || '存量描述']
  );
  return r.lastID;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (13,'wangtaotao','示例对接人','user','active'),
    (5,'dev','开发王','user','active'),
    (14,'liaison2','受理人乙','user','active'),
    (7,'shenjun','示例发布者','publisher','active')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 示例对接人13 / dev5 / 受理人乙14[非受理人常量，测多人场景时临时入组] / 技术负责人示例发布者7[⑨reactivate前置评估意见]）');

  // ═══ [①] 迁移语义组：6 列存在 + notnull/dflt_value 断言（部署硬闸门四项在文件末尾全表扫描，聚合最真实）═══
  {
    const cols = await all(`PRAGMA table_info(sys_issues)`);
    const names = cols.map(c => c.name);
    for (const c of ['intake_liaison_id', 'intake_notify_status', 'intake_notify_message_key', 'intake_notify_error', 'intake_read_at', 'intake_notify_sent_by']) {
      assert.ok(names.includes(c), `[①] 列存在：${c}`);
    }
    const statusCol = cols.find(c => c.name === 'intake_notify_status');
    assert.strictEqual(statusCol.notnull, 1, '[①] intake_notify_status notnull=1');
    assert.ok(String(statusCol.dflt_value || '').includes('not_sent'), `[①] intake_notify_status dflt_value 含 not_sent，实际=${statusCol.dflt_value}`);
    ok('[①] 迁移语义：6 列齐全 + intake_notify_status notnull=1 且 dflt_value 含 \'not_sent\'（CREATE TABLE 路径）');
  }

  // ═══ [②] 主入口校验：缺省 intake_liaison_id → 400 / 非受理人 id → 400 / 合法 → 201 落库 ═══
  {
    const rMissing = await call('POST', '/api/sys-issues', adminTok, createBody({ intake_liaison_id: undefined }));
    assert.strictEqual(rMissing.status, 400, `[②] 缺省 intake_liaison_id 期望 400, got ${rMissing.status} ${JSON.stringify(rMissing.body)}`);
    assert.strictEqual(rMissing.body.code, 'INTAKE_LIAISON_REQUIRED', '[②] 确切码 INTAKE_LIAISON_REQUIRED');

    const rInvalid = await call('POST', '/api/sys-issues', adminTok, createBody({ intake_liaison_id: 5 }));
    assert.strictEqual(rInvalid.status, 400, `[②] 非受理人 id=5 期望 400, got ${rInvalid.status} ${JSON.stringify(rInvalid.body)}`);
    assert.strictEqual(rInvalid.body.code, 'INVALID_INTAKE_LIAISON', '[②] 确切码 INVALID_INTAKE_LIAISON');

    const rGhost = await call('POST', '/api/sys-issues', adminTok, createBody({ intake_liaison_id: 999999 }));
    assert.strictEqual(rGhost.status, 400, '[②] 不存在的 id 同样 400');
    assert.strictEqual(rGhost.body.code, 'INVALID_INTAKE_LIAISON', '[②] 不存在 id 确切码同 INVALID_INTAKE_LIAISON（同源 helper 结果集判定，不单独查存在性）');

    const rOk = await call('POST', '/api/sys-issues', adminTok, createBody());
    assert.strictEqual(rOk.status, 201, `[②] 合法 intake_liaison_id=13 期望 201, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    const row = await issueRow(rOk.body.id);
    assert.strictEqual(row.intake_liaison_id, 13, '[②] 落库 intake_liaison_id=13');
    ok('[②] 主入口：缺省 400 INTAKE_LIAISON_REQUIRED / 非受理人(含不存在id) 400 INVALID_INTAKE_LIAISON / 合法 201 落库');
  }

  // ═══ [③] title/description 请求矩阵四行 + 派生算法四组边界 ═══
  {
    // 行1：无 title + 有 description → 派生
    const r1 = await call('POST', '/api/sys-issues', adminTok, createBody({ description: '这是没有标题的需求描述，首行会被截取', title: undefined }));
    assert.strictEqual(r1.status, 201, `[③行1] 期望 201, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const row1 = await issueRow(r1.body.id);
    assert.strictEqual(row1.title, '这是没有标题的需求描述，首行会被截取', '[③行1] title 自动派生=描述首行（未超40字符原样）');

    // 行2：有 title + 有 description → 沿用传入 title
    const r2 = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '固定标题不被覆盖', description: '这段描述不应影响标题' }));
    assert.strictEqual(r2.status, 201, `[③行2] 期望 201, got ${r2.status}`);
    const row2 = await issueRow(r2.body.id);
    assert.strictEqual(row2.title, '固定标题不被覆盖', '[③行2] title 沿用传入值，不被 description 覆盖');

    // 行3：有 title + 无 description → 400 DESCRIPTION_REQUIRED
    const r3 = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '只有标题没描述', description: undefined }));
    assert.strictEqual(r3.status, 400, `[③行3] 期望 400, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'DESCRIPTION_REQUIRED', '[③行3] 确切码 DESCRIPTION_REQUIRED');

    // 行4：无 title + 无 description → 400 DESCRIPTION_REQUIRED（同码，descriptin 先于 title 判）
    const r4 = await call('POST', '/api/sys-issues', adminTok, createBody({ title: undefined, description: undefined }));
    assert.strictEqual(r4.status, 400, `[③行4] 期望 400, got ${r4.status}`);
    assert.strictEqual(r4.body.code, 'DESCRIPTION_REQUIRED', '[③行4] 确切码 DESCRIPTION_REQUIRED');

    // description 仅空白（trim 后为空）同样落 400（不是"传了非空字符串"就算数）
    const r5 = await call('POST', '/api/sys-issues', adminTok, createBody({ title: undefined, description: '   \n\n   ' }));
    assert.strictEqual(r5.status, 400, '[③行4变体] 纯空白 description 同样 400');
    assert.strictEqual(r5.body.code, 'DESCRIPTION_REQUIRED', '[③行4变体] 确切码 DESCRIPTION_REQUIRED');

    ok('[③] 请求矩阵四行：无title+有desc→派生 / 有title+有desc→沿用 / 有title+无desc→400 / 无title+无desc→400（+ 纯空白 desc 同判 400）');

    // 派生算法边界（直调导出函数，纯逻辑单测，不经 HTTP/DB）
    const derive = I.deriveSysTitleFromDescription;

    // 边界①：多空行开头——顶层 trim 已吞掉纯空白的前导行，首个真实内容行被正确取出
    const b1 = derive('\n\n   \n真实第一行内容\n第二行不影响');
    assert.strictEqual(b1, '真实第一行内容', '[③边界①] 多空行开头：派生结果=第一个非空行（前导空行被 trim 吞掉）');

    // 边界②：中英混排 + emoji 的 40 code point 边界——emoji 按 code point 计 1 不计 2（防 UTF-16 代理对拆半）
    const exactly40 = 'A'.repeat(39) + '\u{1F600}';                 // 39 个 A + 1 个 emoji = 40 code point，恰好不截断
    assert.strictEqual(Array.from(exactly40).length, 40, '[③边界②] 前置：测试串确为 40 code point');
    const d2a = derive(exactly40);
    assert.strictEqual(d2a, exactly40, '[③边界②-a] 恰好 40 code point：不截断、不追加省略号');
    const at41 = exactly40 + 'Z';                                    // 41 code point，触发截断
    const d2b = derive(at41);
    assert.strictEqual(d2b, exactly40 + '…', '[③边界②-b] 41 code point：截前 40（含完整 emoji）+ 追加省略号，emoji 未被拆半');

    // 边界③：超长单行（纯中文）截断 + 追加省略号
    const longLine = '中'.repeat(60);
    const d3 = derive(longLine);
    assert.strictEqual(d3, '中'.repeat(40) + '…', '[③边界③] 超长单行（60 中文字符）截前 40 + 追加省略号');

    // 边界④：有 title 沿用——由行2 HTTP 用例已覆盖（派生函数本身不参与"有 title"分支，属端点层判断非派生算法职责）
    ok('[③边界] 派生算法四组：多空行开头 / emoji 40 code point 边界(恰好40不截断+41截断不拆半) / 超长单行截断+省略号 / 有title沿用(行2已证)');
  }

  // ═══ [④] 衍生入口自动填：=1 自动填成功；0 人/2 人 → 409 INTAKE_LIAISON_AUTO_FILL_FAILED ═══
  {
    const originR = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '派生源单' }));
    const originId = originR.body.id;

    // =1（默认态，仅 13 一人 active）：自动填 13
    const rDerive = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, { type: 'feature', title: '派生新单-自动填', system_name: 'BMS', source: '内部' });
    assert.strictEqual(rDerive.status, 201, `[④=1] 期望 201, got ${rDerive.status} ${JSON.stringify(rDerive.body)}`);
    const derivedRow = await issueRow(rDerive.body.id);
    assert.strictEqual(derivedRow.intake_liaison_id, 13, '[④=1] 派生单自动填 intake_liaison_id=13（唯一 active 受理人）');

    // 0 人：临时禁用 13
    await run(`UPDATE users SET status='disabled' WHERE id=13`);
    const r0 = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, { type: 'feature', title: '派生新单-0人', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r0.status, 409, `[④0人] 期望 409, got ${r0.status} ${JSON.stringify(r0.body)}`);
    assert.strictEqual(r0.body.code, 'INTAKE_LIAISON_AUTO_FILL_FAILED', '[④0人] 确切码 INTAKE_LIAISON_AUTO_FILL_FAILED');
    const countBefore0 = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE title='派生新单-0人'`)).c;
    assert.strictEqual(countBefore0, 0, '[④0人] 零副作用：未建出任何行');
    await run(`UPDATE users SET status='active' WHERE id=13`);   // 复原

    // 2 人：临时把 14 也纳入 SYS_INTAKE_LIAISON_IDS（用户 14 已在 users 表且 active）
    I.SYS_INTAKE_LIAISON_IDS.push(14);
    try {
      const r2 = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, { type: 'feature', title: '派生新单-2人', system_name: 'BMS', source: '内部' });
      assert.strictEqual(r2.status, 409, `[④2人] 期望 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.code, 'INTAKE_LIAISON_AUTO_FILL_FAILED', '[④2人] 确切码同 INTAKE_LIAISON_AUTO_FILL_FAILED（0人/2人共用同一码，文案由 handler 统一给）');
      const countBefore2 = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE title='派生新单-2人'`)).c;
      assert.strictEqual(countBefore2, 0, '[④2人] 零副作用：未建出任何行');
    } finally {
      I.SYS_INTAKE_LIAISON_IDS.pop();   // 复原（务必 finally，防上面断言失败导致常量污染后续分组）
    }
    assert.deepStrictEqual(I.SYS_INTAKE_LIAISON_IDS, [13], '[④] 复原后 SYS_INTAKE_LIAISON_IDS 恢复为 [13]，不污染后续分组');

    ok('[④] 衍生入口自动填：=1 自动填 13 成功 / 0 人(临时禁用) 409 / 2 人(临时改常量) 409，均确切码 INTAKE_LIAISON_AUTO_FILL_FAILED 且零副作用');
  }

  // ═══ [⑤] NULL 单收件人降级（notify-intake 端点）：=1 发送成功 / 0 人 409 / 多人 409 ═══
  {
    // =1：默认态发送成功
    const id1 = await mkLegacyIssue('待受理', { title: '存量单-降级发送成功' });
    const legacyRow1 = await issueRow(id1);
    assert.strictEqual(legacyRow1.intake_liaison_id, null, '[⑤=1] 前置：存量单 intake_liaison_id 恒 NULL（哨兵先证为 NULL）');
    const rSend1 = await call('POST', `/api/sys-issues/${id1}/notify-intake`, adminTok, {});
    assert.strictEqual(rSend1.status, 200, `[⑤=1] 期望 200, got ${rSend1.status} ${JSON.stringify(rSend1.body)}`);
    assert.strictEqual(rSend1.body.intake_notify_status, 'sent', '[⑤=1] 降级发送给唯一 active 受理人(13) 成功');

    // ── codex 461a1e0 MED 收口·① 回写验证：降级解析成功后 intake_liaison_id 已回写为 target ──
    const rowAfterDegrade = await issueRow(id1);
    assert.strictEqual(rowAfterDegrade.intake_liaison_id, 13, '[⑤=1回写] 降级发送后 intake_liaison_id 已回写为 13（通知即指派，不依赖发送是否成功）');

    // ── ①续：回写后再次 notify-intake 走「常规路径」（intake_liaison_id 已非空）——同样应发送成功 ──
    const rSend1Again = await call('POST', `/api/sys-issues/${id1}/notify-intake`, adminTok, {});
    assert.strictEqual(rSend1Again.status, 200, `[⑤常规续] 回写后二次 notify 期望 200, got ${rSend1Again.status} ${JSON.stringify(rSend1Again.body)}`);
    assert.strictEqual(rSend1Again.body.intake_notify_status, 'sent', '[⑤常规续] 常规路径（intake_liaison_id=13 已非空）二次发送成功');
    const rowAfterAgain = await issueRow(id1);
    assert.strictEqual(rowAfterAgain.intake_liaison_id, 13, '[⑤常规续·④回写守卫结构性验证] 常规路径不触碰 intake_liaison_id（值仍为 13，守卫 WHERE intake_liaison_id IS NULL 使二次调用天然不进回写分支）');

    // ── codex 461a1e0 MED 收口·② read-status：降级发送过（现已回写非 NULL）的单，intake 分支正常查询 ──
    //   （不因"曾经 NULL"空转——回写后 recipient uid 解析直接读 issue.intake_liaison_id，同常规单路径）。
    const rReadAfterDegrade = await call('GET', `/api/sys-issues/${id1}/notify-read-status?type=intake`, adminTok);
    // ⚠️ 环境耦合断言（codex 复审 LOW 已裁定接受）：以「本地无钉钉配置 → NO_DINGTALK_CONFIG(500)」作为
    //   "已走到真实查询路径"的间接证据——若将来本地环境配了钉钉凭证，本断言需改为断言正常已读结构。
    assert.strictEqual(rReadAfterDegrade.status, 500, `[⑤read-status] 回写后 intake 分支应正常走到 NO_DINGTALK_CONFIG(500)（非 recipient_unresolved 空转）, got ${rReadAfterDegrade.status} ${JSON.stringify(rReadAfterDegrade.body)}`);
    assert.strictEqual(rReadAfterDegrade.body.code, 'NO_DINGTALK_CONFIG', '[⑤read-status] 确认走的是真实查询路径（recipient uid 已能从回写后的 intake_liaison_id 正常解析），而非因曾为 NULL 走 recipient_unresolved');

    // 0 人：临时禁用 13
    const id0 = await mkLegacyIssue('待受理', { title: '存量单-0人配置异常' });
    await run(`UPDATE users SET status='disabled' WHERE id=13`);
    const rSend0 = await call('POST', `/api/sys-issues/${id0}/notify-intake`, adminTok, {});
    assert.strictEqual(rSend0.status, 409, `[⑤0人] 期望 409, got ${rSend0.status} ${JSON.stringify(rSend0.body)}`);
    assert.strictEqual(rSend0.body.code, 'INTAKE_LIAISON_CONFIG_ERROR', '[⑤0人] 确切码 INTAKE_LIAISON_CONFIG_ERROR');
    const rowAfter0 = await issueRow(id0);
    assert.strictEqual(rowAfter0.intake_notify_status, 'not_sent', '[⑤0人] 零副作用：intake_notify_status 仍 not_sent');
    await run(`UPDATE users SET status='active' WHERE id=13`);

    // 多人：临时把 14 纳入常量
    const idMulti = await mkLegacyIssue('待受理', { title: '存量单-多人需补录' });
    I.SYS_INTAKE_LIAISON_IDS.push(14);
    try {
      const rSendMulti = await call('POST', `/api/sys-issues/${idMulti}/notify-intake`, adminTok, {});
      assert.strictEqual(rSendMulti.status, 409, `[⑤多人] 期望 409, got ${rSendMulti.status} ${JSON.stringify(rSendMulti.body)}`);
      assert.strictEqual(rSendMulti.body.code, 'INTAKE_LIAISON_MISSING', '[⑤多人] 确切码 INTAKE_LIAISON_MISSING（不同于0人的 INTAKE_LIAISON_CONFIG_ERROR）');
      const rowAfterMulti = await issueRow(idMulti);
      assert.strictEqual(rowAfterMulti.intake_notify_status, 'not_sent', '[⑤多人] 零副作用：intake_notify_status 仍 not_sent');
    } finally {
      I.SYS_INTAKE_LIAISON_IDS.pop();
    }
    assert.deepStrictEqual(I.SYS_INTAKE_LIAISON_IDS, [13], '[⑤] 复原后 SYS_INTAKE_LIAISON_IDS=[13]');

    ok('[⑤] NULL 单收件人降级：=1 发送成功(200 sent) / 0 人 409 INTAKE_LIAISON_CONFIG_ERROR / 多人 409 INTAKE_LIAISON_MISSING，两个 409 分文案且零副作用');
  }

  // ═══ [⑩] codex 221a HIGH 收口：inactive 对接人死局修复——与 NULL 分支同一降级路径 ═══
  //   （原 409 INTAKE_LIAISON_INACTIVE 死局已消除：inactive 现与 NULL 同语义走降级——恰 1 个 active
  //   替代者 → 200 降级发送 + 回写覆盖旧 id；0 人/多人两分支仍 409，码复用 NULL 分支既有的
  //   CONFIG_ERROR/MISSING，不产出 INACTIVE 码）
  {
    // ①：常规单 intake_liaison_id=13（建单时 13 active）→ 事后 13 停用 + 临时把 14 纳入受理人常量
    //   （此时 14 是唯一 active 受理人）→ 应降级发给 14 + 回写 intake_liaison_id: 13→14（覆盖旧值，
    //   非仅补 NULL——这正是 221a 与旧 NULL-only 降级逻辑的关键差异）。
    const rCreate1 = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '常规路径受理人停用-降级到唯一替代者' }));
    assert.strictEqual(rCreate1.status, 201, `[⑩①] 前置建单期望 201, got ${rCreate1.status} ${JSON.stringify(rCreate1.body)}`);
    const id1 = rCreate1.body.id;
    assert.strictEqual((await issueRow(id1)).intake_liaison_id, 13, '[⑩①] 前置：intake_liaison_id=13（常规路径落库）');
    await run(`UPDATE users SET status='disabled' WHERE id=13`);
    I.SYS_INTAKE_LIAISON_IDS.push(14);
    try {
      const r1 = await call('POST', `/api/sys-issues/${id1}/notify-intake`, adminTok, {});
      assert.strictEqual(r1.status, 200, `[⑩①] inactive+恰1替代者 期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
      assert.strictEqual(r1.body.intake_notify_status, 'sent', '[⑩①] 降级发送给唯一 active 替代者(14) 成功');
      const rowAfter1 = await issueRow(id1);
      assert.strictEqual(rowAfter1.intake_liaison_id, 14, '[⑩①] 回写覆盖旧 id：13(已失效) → 14（通知即指派，非仅补 NULL）');
    } finally {
      I.SYS_INTAKE_LIAISON_IDS.pop();
      await run(`UPDATE users SET status='active' WHERE id=13`);
      // 清理本条夹具：14 只是"临时入组测试用"，本行落库后仍指向 14——SYS_INTAKE_LIAISON_IDS 复原为
      // [13] 后，文末"部署硬闸门"会全表扫描"intake_liaison_id 是否都在当前受理人集合内"，14 已不在
      // 集合内会被误判为越界数据（假阳性，非真实生产风险——若 14 真被永久列为受理人则不会有此问题）。
      // 不清理会让本条夹具残留污染后面的全表扫描断言，故用完即删。
      await run(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [id1]);
      await run(`DELETE FROM sys_issues WHERE id=?`, [id1]);
    }

    // ②a：intake_liaison_id 失效 + 0 个 active 受理人 → 409 INTAKE_LIAISON_CONFIG_ERROR
    //   （原 INTAKE_LIAISON_INACTIVE 码已废除，与 NULL 单 0 人分支同码，验证走的是统一降级路径）。
    const rCreate2a = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '常规路径受理人停用-0人配置异常' }));
    assert.strictEqual(rCreate2a.status, 201, `[⑩②a] 前置建单期望 201, got ${rCreate2a.status}`);
    const id2a = rCreate2a.body.id;
    await run(`UPDATE users SET status='disabled' WHERE id=13`);
    const r2a = await call('POST', `/api/sys-issues/${id2a}/notify-intake`, adminTok, {});
    assert.strictEqual(r2a.status, 409, `[⑩②a] inactive+0人 期望 409, got ${r2a.status} ${JSON.stringify(r2a.body)}`);
    assert.strictEqual(r2a.body.code, 'INTAKE_LIAISON_CONFIG_ERROR', '[⑩②a] 确切码 INTAKE_LIAISON_CONFIG_ERROR（与 NULL 单 0 人分支同码）');
    const rowAfter2a = await issueRow(id2a);
    assert.strictEqual(rowAfter2a.intake_liaison_id, 13, '[⑩②a] 零副作用：intake_liaison_id 未被清空/篡改（旧值原样保留）');
    assert.strictEqual(rowAfter2a.intake_notify_status, 'not_sent', '[⑩②a] 零副作用：intake_notify_status 仍 not_sent（未误发）');
    await run(`UPDATE users SET status='active' WHERE id=13`);

    // ②b：intake_liaison_id 失效 + 多个 active 受理人（均非原值13）→ 409 INTAKE_LIAISON_MISSING。
    const rCreate2b = await call('POST', '/api/sys-issues', adminTok, createBody({ title: '常规路径受理人停用-多人需补录' }));
    assert.strictEqual(rCreate2b.status, 201, `[⑩②b] 前置建单期望 201, got ${rCreate2b.status}`);
    const id2b = rCreate2b.body.id;
    await run(`UPDATE users SET status='disabled' WHERE id=13`);
    I.SYS_INTAKE_LIAISON_IDS.push(14, 7);
    try {
      const r2b = await call('POST', `/api/sys-issues/${id2b}/notify-intake`, adminTok, {});
      assert.strictEqual(r2b.status, 409, `[⑩②b] inactive+多人 期望 409, got ${r2b.status} ${JSON.stringify(r2b.body)}`);
      assert.strictEqual(r2b.body.code, 'INTAKE_LIAISON_MISSING', '[⑩②b] 确切码 INTAKE_LIAISON_MISSING（与 NULL 单多人分支同码）');
      const rowAfter2b = await issueRow(id2b);
      assert.strictEqual(rowAfter2b.intake_liaison_id, 13, '[⑩②b] 零副作用：intake_liaison_id 未被篡改');
    } finally {
      I.SYS_INTAKE_LIAISON_IDS.pop(); I.SYS_INTAKE_LIAISON_IDS.pop();
      await run(`UPDATE users SET status='active' WHERE id=13`);
    }
    assert.deepStrictEqual(I.SYS_INTAKE_LIAISON_IDS, [13], '[⑩] 复原后 SYS_INTAKE_LIAISON_IDS=[13]');

    ok('[⑩] codex 221a：inactive 对接人死局修复——恰1替代者 active → 200 降级发送+回写覆盖旧id(13→14) / 0人 → 409 CONFIG_ERROR / 多人 → 409 MISSING（原 INTAKE_LIAISON_INACTIVE 码已废除，②两分支零副作用，已恢复现场）');
  }

  // ═══ [⑥] 通知三态流转 + 重发（含 failed 后重发）无条件清 intake_read_at ═══
  let sixId, sixKeyFirst;
  {
    sixId = await mkLegacyIssue('待受理', { title: '通知三态流转单' });
    // not_sent → sent（首发成功）
    const before = await issueRow(sixId);
    assert.strictEqual(before.intake_notify_status, 'not_sent', '[⑥] 前置：not_sent');
    const r1 = await call('POST', `/api/sys-issues/${sixId}/notify-intake`, adminTok, {});
    assert.strictEqual(r1.status, 200, '[⑥] 首发 200');
    const after1 = await issueRow(sixId);
    assert.strictEqual(after1.intake_notify_status, 'sent', '[⑥] 首发后 sent');
    assert.ok(after1.intake_notify_message_key, '[⑥] 首发后 message_key 非空');
    assert.strictEqual(after1.intake_read_at, null, '[⑥] 首发后 read_at 仍 NULL（未读）');
    sixKeyFirst = after1.intake_notify_message_key;

    // 哨兵：手工模拟"已读"（不经真实钉钉，直接置非 NULL 时间戳，验证后续重发会清空这个哨兵值）
    const SENTINEL_READ_AT = '2026-08-01 09:00:00';
    await run(`UPDATE sys_issues SET intake_read_at = ? WHERE id = ?`, [SENTINEL_READ_AT, sixId]);
    const beforeResend = await issueRow(sixId);
    assert.strictEqual(beforeResend.intake_read_at, SENTINEL_READ_AT, '[⑥] 前置哨兵：read_at 已设为非 NULL（模拟已读）');

    // 重发（失败）：sent → failed，且无条件清 read_at（即便发送失败也清）
    dingtalkFailNext = true;
    const r2 = await call('POST', `/api/sys-issues/${sixId}/notify-intake`, adminTok, {});
    assert.strictEqual(r2.status, 200, '[⑥] 重发(failed) 端点本身仍 200（业务失败落 failed 状态，非 HTTP 层错误）');
    assert.strictEqual(r2.body.intake_notify_status, 'failed', '[⑥] 重发失败 → intake_notify_status=failed');
    const afterFail = await issueRow(sixId);
    assert.strictEqual(afterFail.intake_notify_status, 'failed', '[⑥] 落库 failed');
    assert.ok(afterFail.intake_notify_error, '[⑥] failed 态 intake_notify_error 非空');
    assert.strictEqual(afterFail.intake_read_at, null, '[⑥] failed 重发无条件清空 read_at（哨兵值已被清，非"本来就是NULL"的假绿）');

    // 再次重发（成功）：failed → sent，message_key 换新
    const r3 = await call('POST', `/api/sys-issues/${sixId}/notify-intake`, adminTok, {});
    assert.strictEqual(r3.status, 200, '[⑥] 二次重发(成功) 200');
    const after3 = await issueRow(sixId);
    assert.strictEqual(after3.intake_notify_status, 'sent', '[⑥] 二次重发后 sent');
    assert.notStrictEqual(after3.intake_notify_message_key, sixKeyFirst, '[⑥] message_key 已换新（非沿用首发的旧 key）');
    assert.strictEqual(after3.intake_notify_error, null, '[⑥] sent 态 intake_notify_error 清空');
    assert.strictEqual(after3.intake_read_at, null, '[⑥] sent 态 read_at 仍 NULL（未读）');

    ok('[⑥] 通知三态流转：not_sent→sent(首发)→failed(重发失败)→sent(再重发成功)；每次发送(含failed)无条件清 intake_read_at（哨兵值验证非假绿）');
  }

  // ═══ [⑦] read-status 他通道不混淆 + 陈旧缓存不回写（重发后不再 cached）═══
  {
    const id = await mkLegacyIssue('待受理', { title: 'read-status通道隔离单' });
    // 同时发 intake 与 creator（creator 通道需 issue 状态在 SYS_NOTIFY_CREATOR_STATUSES 内，故先推进状态）
    await call('POST', `/api/sys-issues/${id}/notify-intake`, adminTok, {});
    // 把状态推到 creator 可发窗口（待受理→intake-accept→待指派→...太长，直接走原生 SQL 短路到「待验证」测 read-status 隔离，
    //   不依赖真实状态机推进——本组只测 read-status 的列路由正确性，不测状态机）。
    await run(`UPDATE sys_issues SET status='待验证' WHERE id=?`, [id]);
    // ⚠️ 用 liaisonTok(13) 非 adminTok(1)：mkLegacyIssue 固定 created_by=1，若以 admin(1) 身份调用
    //   notify-creator 会命中 self-guard（SELF_NOTIFY_SKIPPED）不真发送，creator_notify_status 停留 not_sent。
    await call('POST', `/api/sys-issues/${id}/notify-creator`, liaisonTok, {});
    const afterBoth = await issueRow(id);
    assert.strictEqual(afterBoth.intake_notify_status, 'sent', '[⑦] 前置：intake 已 sent');
    assert.strictEqual(afterBoth.creator_notify_status, 'sent', '[⑦] 前置：creator 已 sent');

    // 手工把 creator_read_at 设为已读（哨兵），intake_read_at 保持 NULL——验证两者互不干扰
    const CREATOR_SENTINEL = '2026-08-02 08:00:00';
    await run(`UPDATE sys_issues SET creator_read_at = ? WHERE id = ?`, [CREATOR_SENTINEL, id]);

    const rIntake = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=intake`, adminTok);
    assert.strictEqual(rIntake.status, 500, `[⑦] type=intake 期望走到 NO_DINGTALK_CONFIG(500)（未 cached，说明未误读 creator_read_at）, got ${rIntake.status} ${JSON.stringify(rIntake.body)}`);
    assert.strictEqual(rIntake.body.code, 'NO_DINGTALK_CONFIG', '[⑦] type=intake 未被 creator 的已读哨兵污染，走到真实查询路径（而非误返回 cached:true）');

    const rCreator = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=creator`, adminTok);
    assert.strictEqual(rCreator.status, 200, `[⑦] type=creator 期望 200 cached, got ${rCreator.status} ${JSON.stringify(rCreator.body)}`);
    assert.strictEqual(rCreator.body.read, true, '[⑦] type=creator 正确读到自己的已读哨兵');
    assert.strictEqual(rCreator.body.read_at, CREATOR_SENTINEL, '[⑦] type=creator read_at 精确等于 creator 自己的哨兵值（未被 intake 列污染）');
    ok('[⑦-他通道不混淆] type=intake 与 type=creator 各自独立读 intake_read_at/creator_read_at，互不误读（creator 已读哨兵不会让 intake 查询误报 cached）');

    // 陈旧缓存不回写：**独立造一个仍处「待受理」的单**（上面 id 已被推到「待验证」，intake 通道仅
    //   「待受理」可发，若复用 id 则本段的重发调用会被状态闸 409 挡下、read_at 根本没被清，制造假绿）。
    //   给 intake 设一个已读哨兵 → cached:true；随后重发 → 哨兵被清 → 再查不再 cached。
    const id2 = await mkLegacyIssue('待受理', { title: 'read-status陈旧缓存单' });
    await call('POST', `/api/sys-issues/${id2}/notify-intake`, adminTok, {});
    const INTAKE_SENTINEL = '2026-08-02 09:00:00';
    await run(`UPDATE sys_issues SET intake_read_at = ? WHERE id = ?`, [INTAKE_SENTINEL, id2]);
    const rCachedBefore = await call('GET', `/api/sys-issues/${id2}/notify-read-status?type=intake`, adminTok);
    assert.strictEqual(rCachedBefore.status, 200, '[⑦陈旧] 设哨兵后 intake 应 cached 200');
    assert.strictEqual(rCachedBefore.body.cached, true, '[⑦陈旧] cached=true（读到哨兵）');
    assert.strictEqual(rCachedBefore.body.read_at, INTAKE_SENTINEL, '[⑦陈旧] read_at=哨兵值');

    const rResend = await call('POST', `/api/sys-issues/${id2}/notify-intake`, adminTok, {});   // 重发 → 清 read_at + 换新 message_key
    assert.strictEqual(rResend.status, 200, `[⑦陈旧] 前置：重发本身须成功(仍「待受理」态), got ${rResend.status} ${JSON.stringify(rResend.body)}`);
    const rAfterResend = await call('GET', `/api/sys-issues/${id2}/notify-read-status?type=intake`, adminTok);
    assert.strictEqual(rAfterResend.status, 500, '[⑦陈旧] 重发后旧哨兵已被清，不再 cached，走到 NO_DINGTALK_CONFIG(500)');
    assert.strictEqual(rAfterResend.body.code, 'NO_DINGTALK_CONFIG', '[⑦陈旧] 确认未误用重发前的陈旧 read_at 短路返回');
    ok('[⑦-陈旧缓存不回写] 重发后旧 read_at 哨兵被清空，查已读不再误用陈旧缓存直接返回，而是走到真实查询路径');
  }

  // ═══ [⑧] 仅「待受理」态可发；未知业务 type 400；非 admin 403 ═══
  {
    // 非待受理态 → 409 STATUS_NOT_NOTIFIABLE
    const id = await mkLegacyIssue('待受理', { title: '状态闸门单' });
    const rAccept = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(rAccept.status, 200, `[⑧] 前置受理通过期望 200, got ${rAccept.status} ${JSON.stringify(rAccept.body)}`);
    const afterAccept = await issueRow(id);
    assert.notStrictEqual(afterAccept.status, '待受理', '[⑧] 前置：受理后已离开「待受理」');

    const rStatus = await call('POST', `/api/sys-issues/${id}/notify-intake`, adminTok, {});
    assert.strictEqual(rStatus.status, 409, `[⑧] 非待受理态期望 409, got ${rStatus.status} ${JSON.stringify(rStatus.body)}`);
    assert.strictEqual(rStatus.body.code, 'STATUS_NOT_NOTIFIABLE', '[⑧] 确切码 STATUS_NOT_NOTIFIABLE（400/409 分清，非状态闸门用 409）');
    const rowAfterStatus = await issueRow(id);
    assert.strictEqual(rowAfterStatus.intake_notify_status, 'not_sent', '[⑧] 零副作用：intake_notify_status 未变');

    // 未知业务 type（直造脏数据，绕过建单入口的 TYPE_NOT_SUPPORTED 闸）→ 400 MANUAL_NOTIFY_TYPE_NA
    const rConfig = await run(
      `INSERT INTO sys_issues (type, status, title, description, system_name, source, created_by, created_by_name)
       VALUES ('config', '待受理', '脏type单', '脏type描述', 'BMS', '内部', 1, '管理员')`
    );
    const rType = await call('POST', `/api/sys-issues/${rConfig.lastID}/notify-intake`, adminTok, {});
    assert.strictEqual(rType.status, 400, `[⑧] 未知业务 type 期望 400, got ${rType.status} ${JSON.stringify(rType.body)}`);
    assert.strictEqual(rType.body.code, 'MANUAL_NOTIFY_TYPE_NA', '[⑧] 确切码 MANUAL_NOTIFY_TYPE_NA（与状态闸门 409 分清，type 门限用 400）');

    // 非 admin（含受理人本人）→ 403（路由级 requireAdmin 唯一放行，受理人无该权限——通知对象是受理人本人）
    const idForAuth = await mkLegacyIssue('待受理', { title: '权限单' });
    const rNonAdminLiaison = await call('POST', `/api/sys-issues/${idForAuth}/notify-intake`, liaisonTok, {});
    assert.strictEqual(rNonAdminLiaison.status, 403, `[⑧] 受理人本人调用期望 403, got ${rNonAdminLiaison.status}`);
    const rNonAdminDev = await call('POST', `/api/sys-issues/${idForAuth}/notify-intake`, devTok, {});
    assert.strictEqual(rNonAdminDev.status, 403, `[⑧] 普通用户调用期望 403, got ${rNonAdminDev.status}`);
    const rowAfterAuth = await issueRow(idForAuth);
    assert.strictEqual(rowAfterAuth.intake_notify_status, 'not_sent', '[⑧] 非 admin 调用零副作用');

    ok('[⑧] 状态闸门：非待受理 409 STATUS_NOT_NOTIFIABLE / 未知 type 400 MANUAL_NOTIFY_TYPE_NA（400 vs 409 分清）/ 受理人本人∨普通用户 403（路由级 requireAdmin 唯一放行），均零副作用');
  }

  // ═══ [⑨] 回受理门（reactivate / resubmit-intake）：intake 通知 5 列归零 + intake_liaison_id 保留 ═══
  //   （主会话 2026-07-31 补裁：方案 v1.2 §4 遗漏——tech_lead_*/relay_* 回受理门整组归零的既有范式未
  //   覆盖 intake 通知列，会让回流单的「通知对接人受理」按钮停在上一轮 sent 态无法重发。intake-gate-sql.js
  //   的 SYS_BACK_TO_INTAKE_GATE_SQL 现已并入 SYS_CLEAR_INTAKE_NOTIFY_FIELDS_SQL 五列，reactivate 与
  //   resubmit-intake 共用同一常量，两条路径各测一次。哨兵值法：先设 sent+key+error+read_at+sent_by
  //   为可辨识的哨兵值，再触发回流，逐列比对而非依赖"场景恰好产生的值"（同 verify-sys-intake-gate.js
  //   [ATOM] 组既有纪律，防 NULL===NULL 假绿）。intake_liaison_id 需保留原值（非清零）单独断言。
  const INTAKE_SENTINEL_SET = {
    intake_notify_status: 'failed',
    intake_notify_message_key: 'SENTINEL-msgkey-intake',
    intake_notify_error: 'SENTINEL-error-intake',
    intake_read_at: '2020-01-01 00:00:09',
    intake_notify_sent_by: 900009,
  };
  async function setIntakeSentinels(id) {
    await run(
      `UPDATE sys_issues SET intake_notify_status=?, intake_notify_message_key=?, intake_notify_error=?, intake_read_at=?, intake_notify_sent_by=? WHERE id=?`,
      [INTAKE_SENTINEL_SET.intake_notify_status, INTAKE_SENTINEL_SET.intake_notify_message_key,
       INTAKE_SENTINEL_SET.intake_notify_error, INTAKE_SENTINEL_SET.intake_read_at,
       INTAKE_SENTINEL_SET.intake_notify_sent_by, id]
    );
  }
  function assertIntakeNotifyReset(row, label) {
    assert.strictEqual(row.intake_notify_status, 'not_sent', `${label} intake_notify_status 归零为 not_sent（非哨兵值 'failed'）`);
    assert.strictEqual(row.intake_notify_message_key, null, `${label} intake_notify_message_key 归零为 NULL（非哨兵值）`);
    assert.strictEqual(row.intake_notify_error, null, `${label} intake_notify_error 归零为 NULL（非哨兵值）`);
    assert.strictEqual(row.intake_read_at, null, `${label} intake_read_at 归零为 NULL（非哨兵值）`);
    assert.strictEqual(row.intake_notify_sent_by, null, `${label} intake_notify_sent_by 归零为 NULL（非哨兵值）`);
  }
  {
    // ── reactivate：待受理 →（请求技术咨询+示例发布者回评估意见，issue-reject 前置守卫要求）→ issue-reject
    //   → 已拒绝 →（设哨兵）→ reactivate → 待受理 ──（对齐 verify-sys-tech-lead-comment.js [RA] 组既有链路）
    const idReactivate = await mkLegacyIssue('待受理', { title: '回受理门归零-reactivate' });
    await run(`UPDATE sys_issues SET intake_liaison_id = 13 WHERE id = ?`, [idReactivate]);
    const rConsult = await call('POST', `/api/sys-issues/${idReactivate}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(rConsult.status, 200, `[⑨reactivate] 前置 request-tech-consult 期望 200, got ${rConsult.status} ${JSON.stringify(rConsult.body)}`);
    const rComment = await call('POST', `/api/sys-issues/${idReactivate}/tech-lead-comment`, techTok, { comment: '评估意见：可行', expected_request_event_id: rConsult.body.request_event_id });
    assert.strictEqual(rComment.status, 200, `[⑨reactivate] 前置 tech-lead-comment 期望 200, got ${rComment.status} ${JSON.stringify(rComment.body)}`);
    // ⚠️ issue-reject 授权=仅受理人（admin 无拒绝权，2026-07 角色权限重构裁定·NOT_AUTHORIZED_FOR_TRANSITION 若误用 adminTok）；
    //   前置守卫要求当前轮已有评估意见（上一步已满足，否则 409 REJECT_REQUIRES_TECH_COMMENT）。
    const rReject = await call('POST', `/api/sys-issues/${idReactivate}/issue-reject`, liaisonTok, { reason: '暂不处理' });
    assert.strictEqual(rReject.status, 200, `[⑨reactivate] 前置 issue-reject 期望 200, got ${rReject.status} ${JSON.stringify(rReject.body)}`);
    await setIntakeSentinels(idReactivate);
    const beforeReactivate = await issueRow(idReactivate);
    assert.strictEqual(beforeReactivate.intake_notify_status, 'failed', '[⑨reactivate] 前置哨兵：intake_notify_status=failed 已设置');
    assert.strictEqual(beforeReactivate.intake_liaison_id, 13, '[⑨reactivate] 前置：intake_liaison_id=13');

    const rReactivate = await call('POST', `/api/sys-issues/${idReactivate}/reactivate`, adminTok, { reason: '重新激活' });
    assert.strictEqual(rReactivate.status, 200, `[⑨reactivate] 期望 200, got ${rReactivate.status} ${JSON.stringify(rReactivate.body)}`);
    const afterReactivate = await issueRow(idReactivate);
    assert.strictEqual(afterReactivate.status, '待受理', '[⑨reactivate] 落态回「待受理」');
    assertIntakeNotifyReset(afterReactivate, '[⑨reactivate]');
    assert.strictEqual(afterReactivate.intake_liaison_id, 13, '[⑨reactivate] intake_liaison_id 保留原值 13（不随回受理门清零，与 tech_lead_id/relay_notified_user_id 定性不同）');

    // ── resubmit-intake：待受理 →（发 intake 通知落 sent）→ intake-return → 待修改 →（设哨兵）→ resubmit-intake → 待受理 ──
    const idResubmit = await mkLegacyIssue('待受理', { title: '回受理门归零-resubmit' });
    await run(`UPDATE sys_issues SET intake_liaison_id = 13 WHERE id = ?`, [idResubmit]);
    const rIntakeReturn = await call('POST', `/api/sys-issues/${idResubmit}/intake-return`, liaisonTok, { reason: '需补充材料' });
    assert.strictEqual(rIntakeReturn.status, 200, `[⑨resubmit] 前置 intake-return 期望 200, got ${rIntakeReturn.status} ${JSON.stringify(rIntakeReturn.body)}`);
    const afterReturn = await issueRow(idResubmit);
    assert.strictEqual(afterReturn.status, '待修改', '[⑨resubmit] 前置：intake-return 后落「待修改」');
    await setIntakeSentinels(idResubmit);
    const beforeResubmit = await issueRow(idResubmit);
    assert.strictEqual(beforeResubmit.intake_notify_status, 'failed', '[⑨resubmit] 前置哨兵：intake_notify_status=failed 已设置');
    assert.strictEqual(beforeResubmit.intake_liaison_id, 13, '[⑨resubmit] 前置：intake_liaison_id=13');

    const rResubmit = await call('POST', `/api/sys-issues/${idResubmit}/resubmit-intake`, adminTok, {});
    assert.strictEqual(rResubmit.status, 200, `[⑨resubmit] 期望 200, got ${rResubmit.status} ${JSON.stringify(rResubmit.body)}`);
    const afterResubmit = await issueRow(idResubmit);
    assert.strictEqual(afterResubmit.status, '待受理', '[⑨resubmit] 落态回「待受理」');
    assertIntakeNotifyReset(afterResubmit, '[⑨resubmit]');
    assert.strictEqual(afterResubmit.intake_liaison_id, 13, '[⑨resubmit] intake_liaison_id 保留原值 13');

    ok('[⑨] 回受理门（reactivate + resubmit-intake 两条路径，共用 SYS_BACK_TO_INTAKE_GATE_SQL）：intake 通知 5 列（status/message_key/error/read_at/sent_by）均归零（哨兵值验证非假绿）；intake_liaison_id 保留原值不清零');
  }

  // ═══ 部署硬闸门（方案 §7）：全表扫描四项（聚合此刻全部已建数据，含前面各分组产生的行）═══
  {
    const badStatus = await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_notify_status NOT IN ('not_sent','sent','failed')`);
    assert.strictEqual(badStatus.c, 0, '[部署闸门] intake_notify_status 非法值计数=0');

    const badLiaison = await get(`
      SELECT COUNT(*) c FROM sys_issues
       WHERE intake_liaison_id IS NOT NULL
         AND intake_liaison_id NOT IN (SELECT id FROM users WHERE id IN (${I.SYS_INTAKE_LIAISON_IDS.map(() => '?').join(',')}))`,
      I.SYS_INTAKE_LIAISON_IDS
    );
    assert.strictEqual(badLiaison.c, 0, '[部署闸门] 非 NULL intake_liaison_id 不在受理人集合计数=0（不叠加 active 条件——离职受理人历史单仍合法引用）');

    const sentNoKey = await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_notify_status='sent' AND (intake_notify_message_key IS NULL OR intake_notify_message_key='')`);
    assert.strictEqual(sentNoKey.c, 0, '[部署闸门] sent 态必有 message_key（计数=0 违反项）');

    const readWithoutSent = await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_read_at IS NOT NULL AND intake_notify_status != 'sent'`);
    assert.strictEqual(readWithoutSent.c, 0, '[部署闸门] read_at 非空时必为 sent 态（计数=0 违反项）');

    ok('[部署硬闸门] 全表扫描四项：非法值=0 / 越界受理人=0 / sent缺key=0 / read_at非空非sent=0（方案 §7 部署阻断条件）');
  }

  console.log(`\n✅ verify-sys-intake-liaison 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
