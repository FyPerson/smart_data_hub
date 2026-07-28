// 验证脚本：系统迭代 角色权限重构 C4·F9 — 物删审计查询入口（172 号对抗审）
//   用法：node scripts/verify-sys-delete-audit-query.js
//
// 背景：C2a 建了 sys_issue_delete_audit（删前整行+子表快照+reason），对抗审 172 号指出它**零查询面**——
//   写进去后没有任何入口能看，等于没有。用户拍板 C4 必做，口径三条：仅 admin 可查；展示层手机号脱敏
//   （中间四位星号）；库内快照原文不动（脱敏只发生在响应序列化，不改 DB）。
//
// ⚠️ codex C4 审 Round-1 收口后覆盖面（本文件即按收口清单扩充）：
//   [P]/[P2] 权限：非 admin（受理人13/dev5）对列表+详情两个端点均 403；未登录 401；
//       非 admin 查一个**不存在**的 auditId 仍 403（不因记录不存在分叉出 404——但「中间件顺序正确性」
//       是 Round-2 收口后改口的**代码走查结论**，非本用例可辨，详见 [P] 组内联注释）
//   [L] admin 列表 200 且含刚删除的单（摘要字段齐全·不含大 JSON）
//   [M] 逐字段脱敏断言：一条审计夹具让 issue_title/operator_name/reason + 六份可测快照
//       （issue_json 的 requester_phone/description·timeline_json·attachments_json·dev_assignees_json·
//       dev_commits_json·dev_events_json）各埋**不同**手机号，逐字段断言响应无明文、库内各列原文完好。
//       release_snapshots_json 恒为空数组不参与本组（守卫②"已挂批次拒删"使已发布单删不掉，正常路径下
//       这份快照永远是 []，无内容可测——见 DELETE 端点注释）。
//   [MN] 数字型 phone 键：直插一条审计行，issue_json 内 requester_phone 是 JSON **数字**而非字符串，
//       断言响应中已脱敏为字符串形态且详情 JSON 仍可 parse
//   [F] issue_id 过滤正确 + 非法值 400 确切码
//   [PG] 分页规模化验证：直插 ≥201 条审计行 → limit=999999 恰返 MAX_LIMIT(200) 条，且与期望 DESC
//       全序列**逐条** deepStrictEqual（非仅范围有序）；游标翻页两页 concat 同样与期望序列逐条一致；
//       翻到底后 next_before_id 为空；limit 非法值（非数字/负数/0）落回默认值；before_id 加严校验
//       （整串十进制正则 + Number.isSafeInteger）拒绝科学计数法/前后空白/正号前缀/前导零/超 safe-integer。
//
// ⚠️ codex C4 审 Round-2 收口新增点（本轮，见文中 "Round-2" 标记）：
//   ① 前端 siBackToDeleteAuditList()（详情→返回列表也令牌 +1，堵旧详情响应晚到覆盖列表的窗口）——
//      纯前端改动，本脚本测不到，见 public/Sys_Iteration.html 内联注释。
//   ② [P] 组表述收窄：不再声称本用例证明中间件顺序，只声称"不因记录不存在分叉 404"。
//   ③ [PG] 组升全序列比对（deepStrictEqual 而非 min/max + 无交集）。
//   ④ before_id 解析加严（regex + Number.isSafeInteger），[PG] 组补加严专项用例。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-delete-audit-query-secret';
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

// ⭐ codex C4 审 Round-1 收口（LOW）：展开顺序改"spread 在前 + 显式覆盖在后"——即便本文件当前不需要
//   覆盖 _sys-attach-test-deps 里的任何键，这个顺序本身才是"显式传参永远生效"的防御性写法（若哪天有人在
//   本文件加一行 sendIssueDingtalkRaw 覆盖，放在 spread 之前会被 spread 悄悄盖掉，放之后才真正生效）。
const mod = require('../routes/sys-iteration')({
  ...require('./_sys-attach-test-deps'),
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人（非 admin）
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) };
    if (tok !== null) headers.Authorization = 'Bearer ' + tok;   // tok===null → 不带 Authorization 头（测未登录）
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passedReadiness = 0;
let passedBiz = 0;
const okReady = (m) => { passedReadiness++; console.log('  ✓ ' + m); };
const ok = (m) => { passedBiz++; console.log('  ✓ ' + m); };

const create = (extra = {}) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: 2, type: 'bug', title: '删除审计测试单', system_name: 'BMS', source: '内部', ...extra });
// bug 直落待受理（不走预沟通段），删除守卫①②（派生/批次）在新建单上天然不触发，最省事的夹具选型。
const del = (id, reason, tok = adminTok) => call('DELETE', `/api/sys-issues/${id}`, tok, { reason });

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });
  okReady('readiness ready + HTTP harness（admin1 / 受理人13 / dev5）');

  // ═══ [P] 权限：非 admin 403（列表 + 详情两个端点）+ 未登录 401 ═══
  {
    const c = await create();
    const id = c.body.id;
    const dr = await del(id, '权限组测试删除');
    assert.strictEqual(dr.status, 200, `删除应 200, got ${dr.status} ${JSON.stringify(dr.body)}`);
    const auditRow = await get('SELECT id FROM sys_issue_delete_audit WHERE issue_id=?', [id]);
    assert.ok(auditRow, '前置：审计行已生成');

    for (const [who, tok] of [['受理人(13)', liaisonTok], ['dev(5)', devTok]]) {
      const rList = await call('GET', '/api/sys-issue-delete-audit', tok);
      assert.strictEqual(rList.status, 403, `${who} 查列表应 403, got ${rList.status} ${JSON.stringify(rList.body)}`);
      const rDetail = await call('GET', `/api/sys-issue-delete-audit/${auditRow.id}`, tok);
      assert.strictEqual(rDetail.status, 403, `${who} 查详情应 403, got ${rDetail.status} ${JSON.stringify(rDetail.body)}`);
    }
    // 未登录（不带 Authorization 头）→ 401
    const rNoAuthList = await call('GET', '/api/sys-issue-delete-audit', null);
    assert.strictEqual(rNoAuthList.status, 401, `未登录查列表应 401, got ${rNoAuthList.status} ${JSON.stringify(rNoAuthList.body)}`);
    const rNoAuthDetail = await call('GET', `/api/sys-issue-delete-audit/${auditRow.id}`, null);
    assert.strictEqual(rNoAuthDetail.status, 401, `未登录查详情应 401, got ${rNoAuthDetail.status} ${JSON.stringify(rNoAuthDetail.body)}`);

    // ⭐ codex C4 审 Round-2 收口（LOW·测试表述收窄）：本用例只断言"非 admin 查一个不存在的 auditId
    //   仍 403（不因记录不存在分叉出 404）"——这是本用例能验证的全部内容。「requireAdmin 排在
    //   requireSysSchemaReady 之前」这条中间件顺序的正确性，是**代码走查结论**，不是**本测试结论**：
    //   本脚本 waitReady() 已确保 schema 必然就绪，此时无论两个中间件谁先谁后，非 admin 的最终结果
    //   都同样是 403——顺序对不对，这条用例分辨不出来（要真正分辨，需要在 schema 未就绪的窗口内发起
    //   请求，本文件的 harness 目前没有构造这个窗口）。中间件顺序本身已在 index.js 源码确认正确
    //   （authenticateToken→requireAdmin→requireSysSchemaReady，见该路由定义处），不因此改动实现。
    const rMissing = await call('GET', '/api/sys-issue-delete-audit/999999999', liaisonTok);
    assert.strictEqual(rMissing.status, 403, `非 admin 查不存在的 auditId 仍应 403（不因记录不存在分叉出 404）, got ${rMissing.status} ${JSON.stringify(rMissing.body)}`);

    ok('[P] 权限：受理人(13)/dev(5) 对列表与详情均 403·未登录 401·非 admin 查不存在的 auditId 仍 403（不因记录不存在分叉 404；中间件顺序正确性另见源码走查，非本用例可辨）');
  }

  // ═══ [L] admin 列表 200 且含刚删除的单（摘要字段齐全·不含大 JSON） ═══
  {
    const c = await create({ title: '列表可见性测试单' });
    const id = c.body.id;
    await del(id, '列表组测试删除原因');
    const r = await call('GET', '/api/sys-issue-delete-audit?limit=100', adminTok);
    assert.strictEqual(r.status, 200, `admin 列表应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.items), 'items 应为数组');
    const item = r.body.items.find(it => Number(it.issue_id) === id);
    assert.ok(item, '列表应包含刚删除的单');
    assert.strictEqual(item.issue_title, '列表可见性测试单', '标题字段正确（无手机号，未触发脱敏，原样返回）');
    assert.strictEqual(item.reason, '列表组测试删除原因', '原因字段正确（无手机号，未触发脱敏，原样返回）');
    // 摘要字段齐全 + 不含大 JSON（列表不应把详情才有的快照字段带出来）
    const expectedKeys = ['id', 'issue_id', 'issue_type', 'issue_status', 'issue_title', 'operator_id', 'operator_name', 'reason', 'deleted_at'];
    assert.deepStrictEqual(Object.keys(item).sort(), expectedKeys.sort(), '列表行字段应恰为摘要字段集合（不含 issue_json 等大字段）');
    ok('[L] admin 列表 200 + 含刚删除的单 + 摘要字段齐全且不含大 JSON 快照字段');
  }

  // ═══ [M] 逐字段脱敏断言：title/operator_name/reason + 六份快照各埋不同手机号 ═══
  {
    const P_TITLE = '13800000001';
    const P_OPERATOR = '13800000002';
    const P_REASON = '13800000003';
    const P_REQ_PHONE = '13800000004';
    const P_DESCRIPTION = '13800000005';
    const P_TIMELINE = '13800000006';
    const P_ATTACHMENT = '13800000007';
    const P_DEV_ASSIGNEE = '13800000008';
    const P_DEV_COMMIT = '13800000009';
    const P_DEV_EVENT = '13800000010';
    // 专用 admin token：display_name 里带手机号，才能测 operator_name 脱敏（不用全局 adminTok，
    //   避免污染其他组对 operator_name 的假设）。
    const maskingAdminTok = jwt.sign({ id: 1, username: 'admin', display_name: `管理员${P_OPERATOR}`, role: 'admin' }, SECRET);

    const c = await create({
      title: `脱敏测试单${P_TITLE}`,
      requester_phone: P_REQ_PHONE,
      description: `联系电话 ${P_DESCRIPTION}，请随时联系`,
    });
    const id = c.body.id;
    // 受理退改（生成一条含手机号的 timeline 行；bug 流待受理→待修改，DELETE 不限状态，留在待修改即可删）
    const ret = await call('POST', `/api/sys-issues/${id}/intake-return`, adminTok, { reason: `材料不全，联系 ${P_TIMELINE}` });
    assert.strictEqual(ret.status, 200, `intake-return 应 200, got ${ret.status} ${JSON.stringify(ret.body)}`);
    // 原子 SQL 直插四张子表各一行（同 verify-sys-delete-audit.js 的 makeRichIssue 范式），各埋一个手机号
    await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name)
               VALUES (?,?,?,?,?,?)`, [id, 'spec', 'probe.txt', `联系人资料_${P_ATTACHMENT}.txt`, 1, '管理员']);
    const da = await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, notify_status)
                          VALUES (?,?,?,1,'not_sent')`, [id, 5, `开发王_${P_DEV_ASSIGNEE}`]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
               VALUES (?,?,?,?,?,datetime('now','localtime'))`, [id, da.lastID, 5, 'backend', `联系电话${P_DEV_COMMIT}的commit`]);
    await run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
               VALUES (?,?,?,?,?,datetime('now','localtime'))`, [id, da.lastID, 'add', 13, `事件备注含号码${P_DEV_EVENT}`]);

    const dr = await del(id, `脱敏组测试删除${P_REASON}`, maskingAdminTok);
    assert.strictEqual(dr.status, 200, `删除应 200, got ${dr.status} ${JSON.stringify(dr.body)}`);
    const auditRow = await get('SELECT id FROM sys_issue_delete_audit WHERE issue_id=?', [id]);
    assert.ok(auditRow, '前置：审计行已生成');

    const detail = await call('GET', `/api/sys-issue-delete-audit/${auditRow.id}`, adminTok);
    assert.strictEqual(detail.status, 200, `查详情应 200, got ${detail.status}`);
    const d = detail.body;

    // 逐字段断言：响应中不含任一原文手机号 + 呈脱敏形态；库内该列原文完好。
    const FIELD_CASES = [
      { label: 'issue_title', respField: 'issue_title', phone: P_TITLE },
      { label: 'operator_name', respField: 'operator_name', phone: P_OPERATOR },
      { label: 'reason', respField: 'reason', phone: P_REASON },
      { label: 'issue_json(requester_phone)', respField: 'issue_json', phone: P_REQ_PHONE },
      { label: 'issue_json(description)', respField: 'issue_json', phone: P_DESCRIPTION },
      { label: 'timeline_json', respField: 'timeline_json', phone: P_TIMELINE },
      { label: 'attachments_json', respField: 'attachments_json', phone: P_ATTACHMENT },
      { label: 'dev_assignees_json', respField: 'dev_assignees_json', phone: P_DEV_ASSIGNEE },
      { label: 'dev_commits_json', respField: 'dev_commits_json', phone: P_DEV_COMMIT },
      { label: 'dev_events_json', respField: 'dev_events_json', phone: P_DEV_EVENT },
    ];
    for (const { label, respField, phone } of FIELD_CASES) {
      const val = String(d[respField] == null ? '' : d[respField]);
      assert.ok(!val.includes(phone), `响应 ${label} 不应含原文手机号 ${phone}，实际内容：${val.slice(0, 200)}`);
      const maskedForm = phone.slice(0, 3) + '****' + phone.slice(7);
      assert.ok(val.includes(maskedForm), `响应 ${label} 应含脱敏形态 ${maskedForm}`);
    }
    // release_snapshots_json 恒为空数组（守卫②"已挂批次拒删"使正常路径下已发布单删不掉，本组不测它）。
    assert.strictEqual(d.release_snapshots_json, '[]', 'release_snapshots_json 正常路径下恒为空数组');

    // 库内原文完好：直接查表，绕过响应序列化，全部十列应保留原文手机号。
    const rawRow = await get(`SELECT issue_title, operator_name, reason, issue_json, timeline_json,
        attachments_json, dev_assignees_json, dev_commits_json, dev_events_json
      FROM sys_issue_delete_audit WHERE id=?`, [auditRow.id]);
    const RAW_FIELD_MAP = {
      issue_title: P_TITLE, operator_name: P_OPERATOR, reason: P_REASON,
      issue_json: [P_REQ_PHONE, P_DESCRIPTION], timeline_json: P_TIMELINE, attachments_json: P_ATTACHMENT,
      dev_assignees_json: P_DEV_ASSIGNEE, dev_commits_json: P_DEV_COMMIT, dev_events_json: P_DEV_EVENT,
    };
    for (const [col, phones] of Object.entries(RAW_FIELD_MAP)) {
      const val = String(rawRow[col] == null ? '' : rawRow[col]);
      for (const phone of [].concat(phones)) {
        assert.ok(val.includes(phone), `库内 ${col} 应保留原文手机号 ${phone}（脱敏只在响应层，不落库），实际：${val.slice(0, 200)}`);
      }
    }
    // ⭐ 角色权限重构 C4·184 号预审（PM-3·脱敏多格式升级）：分隔符格式用例——①键名含 phone 的带分隔符
    //   整值（走 keyIsPhone 归一判定路径，标准形态输出）+ ②自由文本里带空格分隔符的手机号（走默认正则
    //   路径，保留分隔符）各一例；外加防误伤负例：20 位纯数字 OA 号（自由文本字段，不带 phone 键名）
    //   不应被误判成手机号掩掉（边界断言 (?<!\d)/(?!\d) 生效证明）。
    {
      const rawIssueJsonSep = JSON.stringify({
        id: 8880002,
        title: '分隔符格式测试单',
        requester_phone: '138-1234-5678',                    // ① keyIsPhone 路径：整值判定 → 标准形态（不保留分隔符）
        description: '联系电话 138 1234 5678，请随时联系',    // ② 自由文本路径：掩中间四位并保留空格分隔符
        related_correction_no: '12345678901234567890',       // 防误伤：20 位纯数字 OA 号，不带 phone 键名，不应被掩
      });
      const insSep = await run(
        `INSERT INTO sys_issue_delete_audit (issue_id, issue_type, issue_status, issue_title, issue_created_by, issue_created_at,
           attachment_count, timeline_count, dev_assignee_count, dev_commit_count, dev_event_count, release_snapshot_count,
           issue_json, timeline_json, attachments_json, dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
           operator_id, operator_name, reason, deleted_at)
         VALUES (?,?,?,?,?,?, 0,0,0,0,0,0, ?, '[]','[]','[]','[]','[]','[]', ?,?,?, datetime('now','localtime'))`,
        [8880002, 'bug', '已作废', '分隔符格式测试单', 1, '2020-01-01 00:00:00', rawIssueJsonSep, 1, '管理员', '分隔符格式测试删除']
      );
      const rSep = await call('GET', `/api/sys-issue-delete-audit/${insSep.lastID}`, adminTok);
      assert.strictEqual(rSep.status, 200, `分隔符格式用例查详情应 200, got ${rSep.status} ${JSON.stringify(rSep.body)}`);
      assert.ok(!rSep.body.issue_json.includes('138-1234-5678'), 'requester_phone 带 - 分隔符原文不应出现在响应中');
      assert.ok(/"requester_phone":"138\*\*\*\*5678"/.test(rSep.body.issue_json), 'requester_phone（键名含 phone，带 - 分隔符）应脱敏为标准形态 138****5678（①keyIsPhone 路径）');
      assert.ok(!rSep.body.issue_json.includes('138 1234 5678'), 'description 里带空格分隔符的手机号原文不应出现在响应中');
      assert.ok(/138 \*\*\*\* 5678/.test(rSep.body.issue_json), 'description 里带空格分隔符的手机号应掩中间四位并保留空格分隔符 138 **** 5678（②自由文本路径）');
      assert.ok(rSep.body.issue_json.includes('12345678901234567890'), '20 位纯数字 OA 号应原样保留，不应被误判成手机号掩码（防误伤边界断言）');
      let parsedSep = null, parseErrSep = null;
      try { parsedSep = JSON.parse(rSep.body.issue_json); } catch (e) { parseErrSep = e; }
      assert.ok(!parseErrSep, `分隔符格式用例脱敏后 issue_json 仍应可 parse，实际报错：${parseErrSep && parseErrSep.message}`);
      assert.strictEqual(parsedSep.requester_phone, '138****5678', '解析后 requester_phone 应为标准脱敏形态');
      assert.strictEqual(parsedSep.related_correction_no, '12345678901234567890', '解析后 20 位 OA 号应原样保留（防误伤）');
    }

    ok('[M] 逐字段脱敏：title/operator_name/reason + issue_json(双号)/timeline/attachments/dev_assignees/dev_commits/dev_events 共 10 处手机号，响应层全脱敏、库内原文全完好 + 分隔符格式（-键值整值标准化/空格自由文本保留分隔符）+ 20 位 OA 号防误伤负例');
  }

  // ═══ [MN] 数字型 phone 键：issue_json 内某手机号字段是 JSON 数字（非字符串） ═══
  //   真实业务列（requester_phone 等）声明为 TEXT 列，SQLite TEXT 亲和性会在写入时自动把数值转成文本，
  //   无法用普通 INSERT 在真实业务表里造出"数字型手机号"这种边缘态。故直接原子 SQL 构造一条审计行，
  //   issue_json 手写成含裸数字 requester_phone 的 JSON 文本，直接测 maskJsonSnapshotText 的数字分支
  //   （结构化脱敏：键名含 phone 的数字值先转字符串再按手机号规则脱敏）。
  {
    const NUM_PHONE = 13912345678;   // JSON 数字字面量（非字符串），11 位
    const rawIssueJson = JSON.stringify({ id: 8880001, title: '数字手机号测试单', requester_phone: NUM_PHONE, other_count: 42 });
    const ins = await run(
      `INSERT INTO sys_issue_delete_audit (issue_id, issue_type, issue_status, issue_title, issue_created_by, issue_created_at,
         attachment_count, timeline_count, dev_assignee_count, dev_commit_count, dev_event_count, release_snapshot_count,
         issue_json, timeline_json, attachments_json, dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
         operator_id, operator_name, reason, deleted_at)
       VALUES (?,?,?,?,?,?, 0,0,0,0,0,0, ?, '[]','[]','[]','[]','[]','[]', ?,?,?, datetime('now','localtime'))`,
      [8880001, 'bug', '已作废', '数字手机号测试单', 1, '2020-01-01 00:00:00', rawIssueJson, 1, '管理员', '数字键测试删除']
    );
    const auditId = ins.lastID;
    const r = await call('GET', `/api/sys-issue-delete-audit/${auditId}`, adminTok);
    assert.strictEqual(r.status, 200, `查详情应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(!r.body.issue_json.includes(String(NUM_PHONE)), '数字型手机号不应以原文数字形态出现在响应中');
    assert.ok(/139\*\*\*\*5678/.test(r.body.issue_json), '数字型手机号应转成脱敏字符串形态 139****5678');
    // 其余非 phone 键名的数字（other_count）应原样保留为数字，不应被误脱敏
    assert.ok(/"other_count":42/.test(r.body.issue_json), '非 phone 键名的数字字段应原样保留（不误伤）');
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(r.body.issue_json); } catch (e) { parseErr = e; }
    assert.ok(!parseErr, `脱敏后的 issue_json 仍应是合法可 parse 的 JSON，实际报错：${parseErr && parseErr.message}`);
    assert.strictEqual(typeof parsed.requester_phone, 'string', '脱敏后 requester_phone 应变为字符串类型（原是 JSON 数字）');
    ok('[MN] 数字型 phone 键：issue_json 里的裸数字 requester_phone 正确脱敏为字符串 139****5678 + 非 phone 键数字不误伤 + 详情 JSON 仍可 parse');
  }

  // ═══ [OA] 纯数字标识字段豁免（C5 末次合并审 186 号 MED）═══
  //   缺口：`oa_number` 值域是 `/^\d{1,20}$/`，若某个 OA 流程号**恰为 11 位且以 13-19 开头**，自由文本
  //   手机号正则的首尾边界断言全部满足（整个值就是那 11 位），会被掩成 138****5678，导致 admin 查删除
  //   审计时看不到真实 OA 号。⚠️ [M] 组原有的防误伤负例只用了 **20 位** OA 号——20 位确实不命中，
  //   **11 位会**，负例选窄了，这正是该缺口能活到末次审的原因。
  //   本组用**同一个号码串、三个不同键名**精确证明豁免按键名生效且不过宽：
  //     · oa_number（在豁免集合里）      → 原样保留
  //     · requester_phone（键名含 phone）→ 掩码（豁免没有误伤真实手机号字段）
  //     · description（自由文本）        → 掩码（豁免没有波及自由文本扫描）
  {
    const AMBIGUOUS = '13812345678';   // 既是合法 11 位手机号形态，也是合法 oa_number（/^\d{1,20}$/）
    // ⭐⭐ 186 号末轮 LOW（用例重做·**原设计缺乏区分力**）：豁免由三个条件与成立
    //   （snapshotCol==='issue_json' ∧ depth===1 ∧ 键名命中），用例必须**逐个条件正交击中**，
    //   否则测的是"反正会被掩"而非"因为哪一条被掩"。原设计两处失效：
    //     · `oa_number_list` 键名根本不匹配 → 就算换回旧的按键名递归豁免它照样被掩，测不出"数组元素不豁免"
    //     · `timeline_json[0].oa_number` 深度是 2 → 就算漏掉 snapshotCol 限制，单靠 depth 也会通过，测不出列名限制
    //   重做后每条只破坏一个条件：
    const AMBIGUOUS_NUM = 13912345678;   // 数字型（JSON number），验证数字分支同样受边界约束
    const rawIssueJsonOa = JSON.stringify({
      id: 8880003,
      title: 'OA号防误掩测试单',
      oa_number: AMBIGUOUS,                    // ✅ 三条件全中 → 豁免（唯一受写入端格式闸门保护的位置）
      requester_phone: AMBIGUOUS,              // ❌ 破坏键名条件（且含 phone）→ 掩
      description: `报销单号 ${AMBIGUOUS} 已提交`,   // ❌ 破坏键名条件（自由文本）→ 掩
      oa_number_arr: [AMBIGUOUS],              // ❌ 破坏键名条件的对照项（保留，用于与下面 depth 项对比）
      nested: { oa_number: AMBIGUOUS },        // ❌ **只破坏 depth 条件**（列名对、键名对、depth=2）→ 掩
      nested_num: { oa_number: AMBIGUOUS_NUM },// ❌ 同上但值为**数字型** → 掩（末轮 MED：数字分支补齐后才成立）
    });
    // ❌ **只破坏 snapshotCol 条件**：另一份快照的**根对象直接属性**（键名对、depth===1、仅列名不同）→ 掩
    //   ⚠️ 真实 timeline_json 是数组，这里刻意构造成根对象，正是为了让 depth===1 成立、从而隔离出列名条件
    //   单独检验——用数组的话 depth 会是 2，两个条件同时不满足，又变回没有区分力的用例。
    const rawTimelineJsonOa = JSON.stringify({ oa_number: AMBIGUOUS, summary: '刻意构造为根对象以隔离列名条件' });
    const insOa = await run(
      `INSERT INTO sys_issue_delete_audit (issue_id, issue_type, issue_status, issue_title, issue_created_by, issue_created_at,
         attachment_count, timeline_count, dev_assignee_count, dev_commit_count, dev_event_count, release_snapshot_count,
         issue_json, timeline_json, attachments_json, dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
         operator_id, operator_name, reason, deleted_at)
       VALUES (?,?,?,?,?,?, 0,0,0,0,0,0, ?, ?,'[]','[]','[]','[]','[]', ?,?,?, datetime('now','localtime'))`,
      [8880003, 'feature', '已作废', 'OA号防误掩测试单', 1, '2020-01-01 00:00:00', rawIssueJsonOa, rawTimelineJsonOa, 1, '管理员', 'OA号防误掩测试删除']
    );
    const rOa = await call('GET', `/api/sys-issue-delete-audit/${insOa.lastID}`, adminTok);
    assert.strictEqual(rOa.status, 200, `OA 号用例查详情应 200, got ${rOa.status} ${JSON.stringify(rOa.body)}`);
    let parsedOa = null, parseErrOa = null;
    try { parsedOa = JSON.parse(rOa.body.issue_json); } catch (e) { parseErrOa = e; }
    assert.ok(!parseErrOa, `OA 号用例脱敏后 issue_json 仍应可 parse，实际报错：${parseErrOa && parseErrOa.message}`);
    assert.strictEqual(parsedOa.oa_number, AMBIGUOUS, `oa_number 应原样保留（纯数字标识字段豁免），实际：${parsedOa.oa_number}`);
    assert.strictEqual(parsedOa.requester_phone, '138****5678', '同一号码在 requester_phone 键下仍应被掩（豁免不得误伤真实手机号字段）');
    assert.ok(!parsedOa.description.includes(AMBIGUOUS), '自由文本 description 里的同一号码不应原文出现（豁免不得波及自由文本扫描）');
    assert.ok(parsedOa.description.includes('138****5678'), 'description 应呈脱敏形态');
    // ⭐ 186 号复审 MED + 末轮 LOW：三个豁免条件**逐个正交检验**（每条只破坏一个条件）。
    assert.strictEqual(parsedOa.oa_number_arr[0], '138****5678', '键名不匹配（oa_number_arr）→ 掩（键名条件对照项）');
    assert.strictEqual(parsedOa.nested.oa_number, '138****5678', '**只破坏 depth 条件**：列名对、键名对、depth=2 → 仍掩（证明 depth===1 限制真实生效）');
    assert.strictEqual(parsedOa.nested_num.oa_number, '139****5678', '**数字型**嵌套同名键 → 掩（末轮 MED：数字分支补齐前此处会明文泄露）');
    const parsedTimelineOa = JSON.parse(rOa.body.timeline_json);
    assert.strictEqual(parsedTimelineOa.oa_number, '138****5678', '**只破坏 snapshotCol 条件**：键名对、depth===1、仅列名不同 → 仍掩（证明列名限制真实生效，非靠 depth 兜住）');
    // 库内原文完好（脱敏只在响应层）
    const rawOaRow = await get('SELECT issue_json FROM sys_issue_delete_audit WHERE id=?', [insOa.lastID]);
    assert.ok(String(rawOaRow.issue_json).includes(`"requester_phone":"${AMBIGUOUS}"`), '库内 requester_phone 应保留原文（脱敏不落库）');
    ok('[OA] 纯数字标识字段豁免（三条件正交检验）：issue_json 顶层 oa_number 原样保留；**只破坏 depth**（嵌套同名键·含数字型）/**只破坏 snapshotCol**（另一快照根对象同名键·depth===1）/破坏键名（phone键·自由文本·异名数组）均仍掩码 + 库内原文完好');
  }

  // ═══ [F] issue_id 过滤正确 + 非法值 400 确切码 ═══
  {
    const c1 = await create({ title: '过滤单A' });
    const c2 = await create({ title: '过滤单B' });
    await del(c1.body.id, '过滤组删除A');
    await del(c2.body.id, '过滤组删除B');
    const r = await call('GET', `/api/sys-issue-delete-audit?issue_id=${c1.body.id}`, adminTok);
    assert.strictEqual(r.status, 200, `按 issue_id 过滤应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.items.length >= 1, '过滤结果应至少一条');
    assert.ok(r.body.items.every(it => Number(it.issue_id) === c1.body.id), '过滤结果应全部属于目标 issue_id（不应混入单B）');
    assert.ok(!r.body.items.some(it => Number(it.issue_id) === c2.body.id), '过滤结果不应包含单B');
    const rBad = await call('GET', '/api/sys-issue-delete-audit?issue_id=abc', adminTok);
    assert.strictEqual(rBad.status, 400, `非法 issue_id 应 400, got ${rBad.status} ${JSON.stringify(rBad.body)}`);
    assert.strictEqual(rBad.body.code, 'INVALID_ISSUE_ID_FILTER', '应为 INVALID_ISSUE_ID_FILTER');
    ok('[F] issue_id 过滤正确：只返回目标单据的审计行 + 非法 issue_id 400 INVALID_ISSUE_ID_FILTER（确切码）');
  }

  // ═══ [PG] 分页规模化验证：≥201 条 + limit 收敛 + 游标翻页正确 + 到底 next_before_id 空 + limit 非法回默认 ═══
  {
    // 直插 201 条哑元审计行（不走真实删除流程，纯粹为了造够分页压测的数据量，速度更快）。
    //   ⭐ codex C4 审 Round-2 收口（LOW·全序列比对）：逐条记录 INSERT 返回的 lastID，拼出「本组期望的
    //   完整 DESC 序列」——之前只断言"范围有序 + 页间无交集"（min(page1) > max(page2)），那只能排除
    //   "整段区间颠倒/重叠"，排除不了"页内顺序被打乱但恰好还在正确区间"这种更隐蔽的错误。
    //   升级为翻页收集结果与期望序列前 N 项 deepStrictEqual，才是真正的逐条"不重不漏"。
    const dummyIssueIdBase = 700000;
    const insertedIds = [];
    for (let i = 0; i < 201; i++) {
      const insRes = await run(
        `INSERT INTO sys_issue_delete_audit (issue_id, issue_type, issue_status, issue_title, issue_created_by, issue_created_at,
           attachment_count, timeline_count, dev_assignee_count, dev_commit_count, dev_event_count, release_snapshot_count,
           issue_json, timeline_json, attachments_json, dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
           operator_id, operator_name, reason, deleted_at)
         VALUES (?,?,?,?,?,?, 0,0,0,0,0,0, '{}','[]','[]','[]','[]','[]','[]', ?,?,?, datetime('now','localtime'))`,
        [dummyIssueIdBase + i, 'bug', '已作废', `分页压测单${i}`, 1, '2020-01-01 00:00:00', 1, '管理员', `分页压测删除${i}`]
      );
      insertedIds.push(insRes.lastID);
    }
    // 期望的 DESC 全序列：AUTOINCREMENT 单调递增，本组 201 行必然是全表当前 id 最大的一段（早前 [P]/[L]/[M]/
    // [MN]/[F] 组已插入的审计行 id 更小，排在 DESC 序列更靠后），故按插入顺序反转即为本组这 201 行的 DESC 序列。
    const expectedDescIds = insertedIds.slice().reverse();

    // ① limit=999999 恰返 MAX_LIMIT(200) 条（不因库内条数够多就破例多返）
    const rHuge = await call('GET', '/api/sys-issue-delete-audit?limit=999999', adminTok);
    assert.strictEqual(rHuge.status, 200, `超大 limit 应仍 200（收敛而非拒绝）, got ${rHuge.status}`);
    assert.strictEqual(rHuge.body.limit, 200, `响应回显的 limit 应收敛到上限 200，实际 ${rHuge.body.limit}`);
    assert.strictEqual(rHuge.body.items.length, 200, `实际返回条数应恰为 200，实际 ${rHuge.body.items.length}`);
    assert.deepStrictEqual(rHuge.body.items.map(it => it.id), expectedDescIds.slice(0, 200),
      'limit=999999 收敛后的 200 条应恰为本组最新 200 行、且顺序与 DESC 期望序列逐条一致');

    // ② 游标翻页：第一页 100 条 + next_before_id；第二页用它翻页，与期望序列逐条比对（不止"有序+无交集"）
    const page1 = await call('GET', '/api/sys-issue-delete-audit?limit=100', adminTok);
    assert.strictEqual(page1.body.items.length, 100, `第一页应恰 100 条，实际 ${page1.body.items.length}`);
    assert.ok(page1.body.next_before_id, '第一页应有 next_before_id（库内条数远超 100）');
    const page2 = await call('GET', `/api/sys-issue-delete-audit?limit=100&before_id=${page1.body.next_before_id}`, adminTok);
    assert.strictEqual(page2.body.items.length, 100, `第二页应恰 100 条，实际 ${page2.body.items.length}`);
    const ids1 = page1.body.items.map(it => it.id);
    const ids2 = page2.body.items.map(it => it.id);
    // 全序列比对（升级项）：两页 concat 后应与期望序列的前 200 项逐条相等——既堵"区间颠倒/重叠"，
    // 也堵"页内顺序被打乱但恰好落在正确区间"这种 min/max 比较查不出的错误。
    assert.deepStrictEqual(ids1.concat(ids2), expectedDescIds.slice(0, 200),
      '翻页两页 concat 后应与期望 DESC 序列前 200 项逐条一致（真正的不重不漏，非仅范围有序）');

    // ③ 持续翻页到底：next_before_id 最终应为空
    let beforeId = null, guard = 0, lastPage;
    do {
      const path = '/api/sys-issue-delete-audit?limit=200' + (beforeId ? `&before_id=${beforeId}` : '');
      lastPage = await call('GET', path, adminTok);
      beforeId = lastPage.body.next_before_id;
      guard++;
    } while (beforeId && guard < 30);
    assert.ok(!lastPage.body.next_before_id, '翻到最后一页 next_before_id 应为空（到底）');
    assert.ok(lastPage.body.items.length < 200, `最后一页条数应小于 limit（否则不该判定为到底），实际 ${lastPage.body.items.length}`);

    // ④ limit 非法值（非数字/负数/0）落回默认值 50（宽松兜底，只读查询的刻意选择，非 400）
    for (const badLimit of ['abc', '-5', '0', '5.5', '']) {
      const rBadLimit = await call('GET', `/api/sys-issue-delete-audit?limit=${encodeURIComponent(badLimit)}`, adminTok);
      assert.strictEqual(rBadLimit.status, 200, `非法 limit="${badLimit}" 应仍 200（落回默认值）, got ${rBadLimit.status}`);
      assert.strictEqual(rBadLimit.body.limit, 50, `非法 limit="${badLimit}" 应落回默认值 50，实际 ${rBadLimit.body.limit}`);
    }
    // before_id 非法值（非正整数）应 400（游标语义歧义会导致翻页错位，值得显式拒绝，与 limit 的宽松兜底不同）
    const rBadBefore = await call('GET', '/api/sys-issue-delete-audit?before_id=abc', adminTok);
    assert.strictEqual(rBadBefore.status, 400, `非法 before_id 应 400, got ${rBadBefore.status} ${JSON.stringify(rBadBefore.body)}`);
    assert.strictEqual(rBadBefore.body.code, 'INVALID_BEFORE_ID', '应为 INVALID_BEFORE_ID');
    // ⭐ codex C4 审 Round-2 收口（LOW）：before_id 加严校验专项——这几个值用宽松的 Number()/parsePositiveId
    //   会被误判合法（Number('1e3')===1000、Number(' 123 ')===123、Number('+5')===5 均是合法正整数），
    //   但都不是"整串十进制正整数"字面量，加严后的正则 + Number.isSafeInteger 校验应统一拒绝为 400。
    for (const badBeforeId of ['1e3', ' 123', '123 ', '+5', '01', '99999999999999999999999999']) {
      const rBad2 = await call('GET', `/api/sys-issue-delete-audit?before_id=${encodeURIComponent(badBeforeId)}`, adminTok);
      assert.strictEqual(rBad2.status, 400, `加严校验：before_id="${badBeforeId}" 应 400, got ${rBad2.status} ${JSON.stringify(rBad2.body)}`);
      assert.strictEqual(rBad2.body.code, 'INVALID_BEFORE_ID', `加严校验：before_id="${badBeforeId}" 应为 INVALID_BEFORE_ID`);
    }
    // 合法的普通十进制正整数游标仍应正常放行（防加严改动误伤正常输入）
    const rOkBefore = await call('GET', `/api/sys-issue-delete-audit?before_id=${expectedDescIds[0]}`, adminTok);
    assert.strictEqual(rOkBefore.status, 200, `合法 before_id 应仍 200（加严未误伤正常输入）, got ${rOkBefore.status} ${JSON.stringify(rOkBefore.body)}`);

    ok('[PG] 分页规模化：limit=999999 恰返 200 条（收敛）+ 与期望 DESC 序列逐条一致·游标翻页两页 concat 与期望序列逐条一致（真正不重不漏）·到底 next_before_id 空·limit 非法值落回默认 50·before_id 非法值 400 INVALID_BEFORE_ID（含加严专项：科学计数法/前后空白/正号前缀/前导零/超 safe-integer 均拒）');
  }

  console.log(`\n✅ verify-sys-delete-audit-query 全部通过（readiness 组 ${passedReadiness} + 业务断言组 ${passedBiz}，合计 ${passedReadiness + passedBiz} 组·C4·F9 物删审计查询入口：权限/列表/脱敏/数字键/过滤/分页规模化）`);
  server.close(); db.close();
}

main().catch(e => { console.error('\n❌ verify-sys-delete-audit-query 失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } db.close(); process.exit(1); });
