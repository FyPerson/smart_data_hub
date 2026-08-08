// 验证脚本：系统迭代 上线体统一重构 C1 — 排班表 CRUD 三端点 + 资格闸（方案 v3.4 §6.2/§6.3a/§6.14 + 附录 A）
//   用法：node scripts/verify-sys-duty-roster.js
//
// 真实 HTTP 层验证（对齐 verify-sys-role-perm-c1.js 范式：真实 express app + http.Server + JWT 多角色夹具，
//   非直调内部函数——排班表写权/资格闸/权限视图都是端点层裁决，走 HTTP 才是真实覆盖）。
//
// 覆盖组（C1 任务书六组清单）：
//   [1] 写权矩阵：对接人(13) POST/DELETE → 200/201；admin(1)/dev非白名单(5)/publisher非白名单(7)/viewer(8) → 403 确切码
//   [2] 资格闸：排入 admin/viewer/disabled/不存在 user_id → 400 DUTY_USER_NOT_ELIGIBLE；user_name 服务端派生（不采纳 body 值）
//   [3] 调班原子性：同日二排 → 旧行三字段全非空 + 新行 active + 全表该日 active 行恰 1
//   [4] DELETE：软删三字段全写；重复 DELETE→404；软删后同日可再 POST（唯一活跃索引复活面）
//   [5] GET：admin/对接人全量；普通用户仅本人行；缺 from/to→400；非法格式→400；367 天→400；恰 366 天→200（2026-07-30 自 93 天放宽·全年视图）
//   [6] 断言纪律：全程精确状态码 + 精确 error code，不用 status>=400 弱判据
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-duty-roster-secret';
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

// ── 多角色 JWT 夹具（对齐 verify-sys-role-perm-c1.js：测试 id 与生产 users.id 无对应关系，
//   授权判定只看 JWT role + SYS_INTAKE_LIAISON_IDS=[13] 常量）──────────────────────────────
const adminTok    = jwt.sign({ id: 1,  username: 'admin',      display_name: '管理员',   role: 'admin'     }, SECRET);
const devTok      = jwt.sign({ id: 5,  username: 'dev',        display_name: '开发甲',   role: 'user'      }, SECRET);   // 有资格·非白名单
const dev2Tok     = jwt.sign({ id: 6,  username: 'dev2',       display_name: '开发乙',   role: 'user'      }, SECRET);   // 有资格·非白名单
const publisherTok= jwt.sign({ id: 7,  username: 'shenjun',    display_name: '示例发布者',     role: 'publisher' }, SECRET);   // 技术负责人但非受理人白名单
const viewerTok   = jwt.sign({ id: 8,  username: 'viewer',     display_name: '查看者丙', role: 'viewer'    }, SECRET);
const liaisonTok  = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人',   role: 'user'      }, SECRET);   // 受理人白名单（SYS_INTAKE_LIAISON_IDS=[13]）

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function main() {
  mod.initSchema();
  await waitReady();
  // users 表为本模块外部依赖（server.js 建表），测试库手工建最小夹具：
  //   1 admin(active) / 5,6 dev(active,user,有资格) / 7 示例发布者(active,publisher,非白名单) /
  //   8 viewer(active,viewer,无资格) / 9 disabled(status=disabled,无资格) / 13 示例对接人(active,user,受理人白名单)。
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active')`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (5,'dev','开发甲','user','active'),
    (6,'dev2','开发乙','user','active'),
    (7,'shenjun','示例发布者','publisher','active'),
    (8,'viewer','查看者丙','viewer','active'),
    (9,'disabled','离职丁','user','disabled'),
    (13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / dev5,6 / 示例发布者7 / viewer8 / disabled9 / 示例对接人13）');

  // ═══ [1] 写权矩阵：POST ═══
  {
    const ROLES = [
      { who: 'admin(1)',          tok: adminTok,     allow: false, code: 'INTAKE_LIAISON_ONLY' },
      // ⭐ [C10-fix M1·收回权限放宽] requireLiaisonOnly 收回**窄集合[13]**（isSysIntakeLiaison）——release/roster 级
      //   授权不随候选池扩大：dev(5,role=user)/示例发布者(7,publisher) 虽在 candidate 口径内，但非[13]，此处仍 403（守边界）。
      { who: 'dev(5,role=user·非[13])', tok: devTok, allow: false, code: 'INTAKE_LIAISON_ONLY' },
      { who: '示例发布者(7,publisher·非[13])', tok: publisherTok, allow: false, code: 'INTAKE_LIAISON_ONLY' },
      // viewer 角色不在候选池内，403（既有真负例）。
      { who: 'viewer(8)',         tok: viewerTok,    allow: false, code: 'INTAKE_LIAISON_ONLY' },
      { who: '示例对接人(13,受理人·窄集合)', tok: liaisonTok,    allow: true },
    ];
    for (const [i, role] of ROLES.entries()) {
      const d = `2030-01-${String(i + 1).padStart(2, '0')}`;
      const r = await call('POST', '/api/sys-duty-roster', role.tok, { duty_date: d, user_id: 5 });
      if (role.allow) {
        assert.strictEqual(r.status, 201, `[写权/POST] ${role.who} 期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.user_id, 5, `[写权/POST] ${role.who} 应真落 user_id=5`);
      } else {
        assert.strictEqual(r.status, 403, `[写权/POST] ${role.who} 期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, role.code, `[写权/POST] ${role.who} 期望确切码 ${role.code}, got ${JSON.stringify(r.body)}`);
        const row = await get('SELECT id FROM sys_release_duty_roster WHERE duty_date = ?', [d]);
        assert.strictEqual(row, undefined, `[写权/POST] ${role.who} 403 后不应产生排班行（负例落库副作用核对）`);
      }
    }
    ok('[C10-fix M1][1] 写权矩阵 POST：收回窄集合[13] 后仅示例对接人(13) 201 放行；admin(1)/dev(5,user)/示例发布者(7,publisher)/viewer(8) 均 403 INTAKE_LIAISON_ONLY 且无落库副作用（release/roster 级授权不随候选池扩大·守边界——dev/示例发布者 虽属 candidate 口径但非[13]）');
  }

  // ═══ [1] 写权矩阵：DELETE（同矩阵，针对同一行）═══
  {
    const mk = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: '2030-01-20', user_id: 5 });
    assert.strictEqual(mk.status, 201, `夹具建行失败: ${JSON.stringify(mk.body)}`);
    const rowId = mk.body.id;
    // ⭐ [C10-fix M1·收回权限放宽] 收回窄集合[13] 后 dev(5)/示例发布者(7) 重新成为负例——真负例=admin(天然排除)/
    //   viewer(角色不在候选池)/dev(5,user·非[13])/示例发布者(7,publisher·非[13])，仅示例对接人(13) 可删（release/roster 级守边界）。
    const DENY_ROLES = [
      { who: 'admin(1)', tok: adminTok },
      { who: 'viewer(8)', tok: viewerTok },
      { who: 'dev(5,role=user·非[13])', tok: devTok },
      { who: '示例发布者(7,publisher·非[13])', tok: publisherTok },
    ];
    for (const role of DENY_ROLES) {
      const r = await call('DELETE', `/api/sys-duty-roster/${rowId}`, role.tok);
      assert.strictEqual(r.status, 403, `[写权/DELETE] ${role.who} 期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INTAKE_LIAISON_ONLY', `[写权/DELETE] ${role.who} 期望确切码`);
    }
    const stillActive = await get('SELECT removed_at FROM sys_release_duty_roster WHERE id = ?', [rowId]);
    assert.strictEqual(stillActive.removed_at, null, '[写权/DELETE] admin/viewer/dev/示例发布者 403 后该行应仍活跃（未被误删）');
    const delOk = await call('DELETE', `/api/sys-duty-roster/${rowId}`, liaisonTok);
    assert.strictEqual(delOk.status, 200, `[写权/DELETE] 示例对接人 期望 200, got ${delOk.status} ${JSON.stringify(delOk.body)}`);
    assert.strictEqual(delOk.body.removed, true, '[写权/DELETE] 示例对接人 应真删除（removed:true）');
    ok('[C10-fix M1][1] 写权矩阵 DELETE：收回窄集合[13] 后真负例扩回——admin/viewer/dev(5,user)/示例发布者(7,publisher) 均 403 且行未被误删，仅示例对接人(13,窄集合) 200 真删除（release/roster 级授权不随候选池扩大）');
  }

  // ═══ [2] 资格闸：排入无资格 user_id → 400 DUTY_USER_NOT_ELIGIBLE ═══
  //   ⭐ codex 198 审建议用例②：资格查询已挪进 sysBeginImmediate 事务内（MED-1 采纳，写入时强 R-2），
  //   本组是该改动后的回归——HTTP 契约应逐字不变（仍是 400 + 确切码 + 无落库副作用），仅内部实现从
  //   "事务外读 + 事务内写"改为"同一事务内读+判定+写"，四条负例应全部照旧通过。
  {
    const CASES = [
      { who: 'admin(1)', userId: 1 },
      { who: 'viewer(8)', userId: 8 },
      { who: 'disabled(9)', userId: 9 },
      { who: '不存在(9999)', userId: 9999 },
    ];
    for (const [i, c] of CASES.entries()) {
      const d = `2030-03-${String(i + 1).padStart(2, '0')}`;
      const r = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d, user_id: c.userId });
      assert.strictEqual(r.status, 400, `[资格闸] ${c.who} 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'DUTY_USER_NOT_ELIGIBLE', `[资格闸] ${c.who} 期望确切码`);
      const row = await get('SELECT id FROM sys_release_duty_roster WHERE duty_date = ?', [d]);
      assert.strictEqual(row, undefined, `[资格闸] ${c.who} 400 后不应产生排班行`);
    }
    ok('[2] 资格闸（事务内化回归，codex 198 MED-1）：admin/viewer/disabled/不存在 user_id 全被 400 DUTY_USER_NOT_ELIGIBLE 拒，均无落库副作用，HTTP 契约逐字不变');
  }
  // user_name 服务端派生（不采纳 body 值），即便 body 显式传伪造 user_name 也被覆盖
  {
    const r = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: '2030-03-10', user_id: 6, note: '正常调班', user_name: '伪造名字' });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.user_name, '开发乙', `user_name 应服务端派生自 users.display_name（=开发乙），实得 ${r.body.user_name}（不应是 body 传的"伪造名字"）`);
    const row = await get('SELECT user_name FROM sys_release_duty_roster WHERE id = ?', [r.body.id]);
    assert.strictEqual(row.user_name, '开发乙', 'DB 落库的 user_name 同样应是服务端派生值');
    ok('[2] user_name 服务端派生：返回体与落库值均 = users.display_name（开发乙），body 传的伪造值被忽略');
  }

  // ═══ [3] 调班原子性：同日二排 ═══
  {
    const d3 = '2030-04-01';
    const first = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d3, user_id: 5 });
    assert.strictEqual(first.status, 201, `第一次排班期望 201, got ${JSON.stringify(first.body)}`);
    const firstId = first.body.id;
    const second = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d3, user_id: 6 });
    assert.strictEqual(second.status, 201, `调班期望 201, got ${JSON.stringify(second.body)}`);
    assert.strictEqual(second.body.replaced, '开发甲', `响应 replaced 应为被调走的旧值班人姓名（开发甲），实得 ${second.body.replaced}`);
    const oldRow = await get('SELECT removed_at, removed_by, removed_by_name FROM sys_release_duty_roster WHERE id = ?', [firstId]);
    assert.ok(oldRow.removed_at, '[调班] 旧行 removed_at 应非空');
    assert.ok(oldRow.removed_by && oldRow.removed_by > 0, '[调班] 旧行 removed_by 应非空且为正数');
    assert.ok(oldRow.removed_by_name && oldRow.removed_by_name.trim().length > 0, '[调班] 旧行 removed_by_name 应非空');
    const newRow = await get('SELECT removed_at, user_id FROM sys_release_duty_roster WHERE id = ?', [second.body.id]);
    assert.strictEqual(newRow.removed_at, null, '[调班] 新行应活跃（removed_at=NULL）');
    assert.strictEqual(newRow.user_id, 6, '[调班] 新行 user_id 应为 6');
    const activeCount = await get('SELECT COUNT(*) c FROM sys_release_duty_roster WHERE duty_date = ? AND removed_at IS NULL', [d3]);
    assert.strictEqual(activeCount.c, 1, `[调班] 该日活跃行应恰 1 条，实得 ${activeCount.c}`);
    ok('[3] 调班原子性：同日二排——旧行三字段（removed_at/removed_by/removed_by_name）全非空 + 新行活跃 + 全表该日活跃行恰 1 + 响应 replaced 正确');
  }

  // ═══ [3b] ⭐ codex 198 审建议用例①：同日连续三次 POST → 该日活跃行恰 1 且是最后一人 ═══
  //   （前两行均应已软删且三字段全写——不仅二连测原子性，三连才能证明"软删链"每一环都正确，非仅首尾两次巧合对）。
  {
    const d3b = '2030-06-01';
    const p1 = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d3b, user_id: 5 });
    assert.strictEqual(p1.status, 201, `连续排班①期望 201, got ${JSON.stringify(p1.body)}`);
    const p2 = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d3b, user_id: 6 });
    assert.strictEqual(p2.status, 201, `连续排班②期望 201, got ${JSON.stringify(p2.body)}`);
    assert.strictEqual(p2.body.replaced, '开发甲', `②的 replaced 应为①的值班人（开发甲），实得 ${p2.body.replaced}`);
    const p3 = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d3b, user_id: 5 });   // 换回 dev5
    assert.strictEqual(p3.status, 201, `连续排班③期望 201, got ${JSON.stringify(p3.body)}`);
    assert.strictEqual(p3.body.replaced, '开发乙', `③的 replaced 应为②的值班人（开发乙），实得 ${p3.body.replaced}`);

    for (const [label, id] of [['①', p1.body.id], ['②', p2.body.id]]) {
      const row = await get('SELECT removed_at, removed_by, removed_by_name FROM sys_release_duty_roster WHERE id = ?', [id]);
      assert.ok(row.removed_at, `连续排班${label}行 removed_at 应非空（已被后续调班软删）`);
      assert.ok(row.removed_by && row.removed_by > 0, `连续排班${label}行 removed_by 应非空且为正数`);
      assert.ok(row.removed_by_name && row.removed_by_name.trim().length > 0, `连续排班${label}行 removed_by_name 应非空`);
    }
    const activeRows = await all('SELECT id, user_id FROM sys_release_duty_roster WHERE duty_date = ? AND removed_at IS NULL', [d3b]);
    assert.strictEqual(activeRows.length, 1, `该日活跃行应恰 1 条，实得 ${activeRows.length}`);
    assert.strictEqual(activeRows[0].id, p3.body.id, '活跃行应正是最后一次 POST（③）产生的行');
    assert.strictEqual(activeRows[0].user_id, 5, '活跃行 user_id 应是最后一人（dev5）');
    ok('[3b] 同日连续三次 POST：①②行均已软删且三字段全写（软删链每环核实，非仅首尾对） + 该日活跃行恰 1 条 + 活跃行=最后一人（dev5）+ 各次 replaced 正确');
  }

  // ═══ [4] DELETE：软删三字段 + 重复 404 + 复活面 ═══
  {
    const d4 = '2030-04-10';
    const mk = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d4, user_id: 5 });
    assert.strictEqual(mk.status, 201, `夹具建行失败: ${JSON.stringify(mk.body)}`);
    const id4 = mk.body.id;
    const del1 = await call('DELETE', `/api/sys-duty-roster/${id4}`, liaisonTok);
    assert.strictEqual(del1.status, 200, `首次 DELETE 期望 200, got ${JSON.stringify(del1.body)}`);
    const row4 = await get('SELECT removed_at, removed_by, removed_by_name FROM sys_release_duty_roster WHERE id = ?', [id4]);
    assert.ok(row4.removed_at && row4.removed_by && row4.removed_by_name, '[DELETE] 软删三字段应全写');
    const del2 = await call('DELETE', `/api/sys-duty-roster/${id4}`, liaisonTok);
    assert.strictEqual(del2.status, 404, `重复 DELETE 期望 404, got ${del2.status} ${JSON.stringify(del2.body)}`);
    assert.strictEqual(del2.body.code, 'DUTY_ROSTER_NOT_FOUND', '重复 DELETE 应带确切码 DUTY_ROSTER_NOT_FOUND');
    const notFound = await call('DELETE', '/api/sys-duty-roster/999999', liaisonTok);
    assert.strictEqual(notFound.status, 404, `不存在 ID 期望 404, got ${notFound.status}`);
    assert.strictEqual(notFound.body.code, 'DUTY_ROSTER_NOT_FOUND', '不存在 ID 应带确切码');
    const badId = await call('DELETE', '/api/sys-duty-roster/abc', liaisonTok);
    assert.strictEqual(badId.status, 400, `非法 ID 格式期望 400, got ${badId.status}`);
    assert.strictEqual(badId.body.code, 'INVALID_DUTY_ROSTER_ID', '非法 ID 格式应带确切码');
    // 复活面：软删后同日可再 POST（唯一活跃索引只约束 removed_at IS NULL 的在册行）
    const revive = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: d4, user_id: 6 });
    assert.strictEqual(revive.status, 201, `软删后同日再 POST 期望 201, got ${JSON.stringify(revive.body)}`);
    assert.strictEqual(revive.body.replaced, null, '软删行已非活跃，本次应走"无现有活跃行→直接插"分支，replaced 应为 null');
    ok('[4] DELETE：软删三字段全写 + 重复 DELETE→404 + 不存在 ID→404 + 非法 ID 格式→400 + 软删后同日可再 POST（复活面，replaced=null）');
  }

  // ═══ [5] GET：权限视图 + 区间校验 ═══
  {
    const g1 = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: '2030-05-01', user_id: 5 });
    const g2 = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: '2030-05-02', user_id: 6 });
    assert.strictEqual(g1.status, 201); assert.strictEqual(g2.status, 201);

    const adminView = await call('GET', '/api/sys-duty-roster?from=2030-05-01&to=2030-05-02', adminTok);
    assert.strictEqual(adminView.status, 200, `admin 全量视图期望 200, got ${JSON.stringify(adminView.body)}`);
    assert.strictEqual(adminView.body.items.length, 2, 'admin 应看到全部 2 条（全量视图）');

    const liaisonView = await call('GET', '/api/sys-duty-roster?from=2030-05-01&to=2030-05-02', liaisonTok);
    assert.strictEqual(liaisonView.status, 200);
    assert.strictEqual(liaisonView.body.items.length, 2, '对接人应看到全部 2 条（全量视图）');

    const devView = await call('GET', '/api/sys-duty-roster?from=2030-05-01&to=2030-05-02', devTok);
    assert.strictEqual(devView.status, 200);
    assert.strictEqual(devView.body.items.length, 1, 'dev(5) 应只看到本人 1 条');
    assert.strictEqual(devView.body.items[0].user_id, 5, 'dev(5) 视图内应为本人行');

    const dev2View = await call('GET', '/api/sys-duty-roster?from=2030-05-01&to=2030-05-02', dev2Tok);
    assert.strictEqual(dev2View.status, 200);
    assert.strictEqual(dev2View.body.items.length, 1, 'dev2(6) 应只看到本人 1 条');
    assert.strictEqual(dev2View.body.items[0].user_id, 6, 'dev2(6) 视图内应为本人行');

    const viewerView = await call('GET', '/api/sys-duty-roster?from=2030-05-01&to=2030-05-02', viewerTok);
    assert.strictEqual(viewerView.status, 200);
    assert.strictEqual(viewerView.body.items.length, 0, 'viewer(8) 从未被排班，视图应为空（非 admin/对接人一律仅本人分支）');

    ok('[5a] GET 权限视图：admin/对接人全量(2条)；dev(5)/dev2(6) 各仅本人(1条)；无排班的 viewer(8) 空视图');
  }
  {
    const missing1 = await call('GET', '/api/sys-duty-roster?from=2030-05-01', adminTok);
    assert.strictEqual(missing1.status, 400, `缺 to 期望 400, got ${missing1.status}`);
    assert.strictEqual(missing1.body.code, 'DUTY_RANGE_REQUIRED');
    const missing2 = await call('GET', '/api/sys-duty-roster', adminTok);
    assert.strictEqual(missing2.status, 400, `缺 from/to 期望 400, got ${missing2.status}`);
    assert.strictEqual(missing2.body.code, 'DUTY_RANGE_REQUIRED');
    const badFmt = await call('GET', '/api/sys-duty-roster?from=2030-13-01&to=2030-05-01', adminTok);
    assert.strictEqual(badFmt.status, 400, `非法月份期望 400, got ${badFmt.status}`);
    assert.strictEqual(badFmt.body.code, 'INVALID_DUTY_DATE');
    const badOrder = await call('GET', '/api/sys-duty-roster?from=2030-05-02&to=2030-05-01', adminTok);
    assert.strictEqual(badOrder.status, 400, `to<from 期望 400, got ${badOrder.status}`);
    assert.strictEqual(badOrder.body.code, 'DUTY_RANGE_INVALID');
    ok('[5b] GET 参数校验：缺 from/to→400 DUTY_RANGE_REQUIRED；非法格式→400 INVALID_DUTY_DATE；to<from→400 DUTY_RANGE_INVALID');
  }
  {
    // [2026-07-30 用户提出·全年视图] 上限 93 天 → 366 天（整年含闰年，配合按月轮值+区间合并展示）。
    // 动态计算 366/367 天边界（避免手数跨月天数出错）：diffDays=365 → 366 天（含首尾）→ 应放行；diffDays=366 → 367 天 → 应拒。
    const fromMs = Date.UTC(2030, 0, 1);
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
    const to366 = fmt(fromMs + 365 * 86400000);
    const to367 = fmt(fromMs + 366 * 86400000);
    const okRange = await call('GET', `/api/sys-duty-roster?from=2030-01-01&to=${to366}`, adminTok);
    assert.strictEqual(okRange.status, 200, `恰 366 天区间期望 200, got ${okRange.status} ${JSON.stringify(okRange.body)}`);
    const tooLong = await call('GET', `/api/sys-duty-roster?from=2030-01-01&to=${to367}`, adminTok);
    assert.strictEqual(tooLong.status, 400, `367 天区间期望 400, got ${tooLong.status}`);
    assert.strictEqual(tooLong.body.code, 'DUTY_RANGE_TOO_LONG', '367 天区间应带确切码 DUTY_RANGE_TOO_LONG');
    ok(`[5c] GET 区间上限：恰 366 天（2030-01-01~${to366}）200 放行；367 天（~${to367}）400 DUTY_RANGE_TOO_LONG 拒（2026-07-30 自 93 天放宽·动态计算边界，非手数）`);

    // [5c+·codex 212 审 MED-1] 366 天窗口**有数据**断言（此前只测空区间状态码）：from 端点/中点/to 端点各
    //   1 行（不同用户）+ 1 行软删——admin 拿全量 3 行且含 from/to 两端（BETWEEN 包含性）、软删被滤；
    //   普通用户（user 5）同一窗口只拿本人行（权限过滤分支在长窗口下同样成立）。
    //   ⚠️ 夹具窗口用 2033 年**独立远窗口**——首版用 2030 基准，softDate 恰与本套件早前分组的活跃夹具行
    //   （2030-04-01）同日撞车致断言误红（不是过滤失效，是窗口不隔离；教训=大窗口断言必须独占日期段）。
    const f33 = Date.UTC(2033, 0, 1);
    const from33 = fmt(f33), mid33 = fmt(f33 + 180 * 86400000), to33 = fmt(f33 + 365 * 86400000), soft33 = fmt(f33 + 90 * 86400000);
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES
      (?, 5, '开发甲', 1, '管理员'), (?, 6, '开发乙', 1, '管理员'), (?, 5, '开发甲', 1, '管理员')`, [from33, mid33, to33]);
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
      VALUES (?, 6, '开发乙', 1, '管理员', datetime('now'), 1, '管理员')`, [soft33]);
    const full = await call('GET', `/api/sys-duty-roster?from=${from33}&to=${to33}`, adminTok);
    assert.strictEqual(full.status, 200, `[5c+] admin 有数据 366 窗口 200, got ${full.status}`);
    const fDates = (full.body.items || []).map(i => i.duty_date);
    assert.ok(fDates.includes(from33) && fDates.includes(to33) && fDates.includes(mid33),
      `[5c+] admin 全量含 from/中点/to 三行（BETWEEN 双端包含），实得 ${JSON.stringify(fDates)}`);
    assert.ok(!fDates.includes(soft33), '[5c+] 软删行被过滤（removed_at IS NULL）');
    assert.strictEqual((full.body.items || []).length, 3, `[5c+] admin 恰 3 行（独立窗口无杂行），实得 ${(full.body.items || []).length}`);
    const mine = await call('GET', `/api/sys-duty-roster?from=${from33}&to=${to33}`, devTok);
    assert.strictEqual(mine.status, 200, `[5c+] 普通用户长窗口 200, got ${mine.status}`);
    assert.strictEqual((mine.body.items || []).length, 2, `[5c+] 普通用户(5)只拿本人 2 行，实得 ${(mine.body.items || []).length}`);
    assert.ok((mine.body.items || []).every(i => Number(i.user_id) === 5), '[5c+] 普通用户行全部属于本人');
    await run(`DELETE FROM sys_release_duty_roster WHERE duty_date IN (?, ?, ?, ?)`, [from33, mid33, to33, soft33]);
    ok('[5c+] 366 天窗口有数据断言：admin 全量 3 行含 BETWEEN 双端+软删滤除；普通用户同窗口仅本人行——权限过滤分支在长窗口下成立（codex 212 MED-1·独立 2033 窗口防夹具撞车）');
  }

  // ═══ [6] 区间批量设置（POST /sys-duty-roster-batch，C2b 第2批·用户 2026-07-29 实测后提出）═══
  //   同一事务内逐日复用单日"软删旧行+插新行"语义——用 2031-* 日期段，与上方各组的 2030-* 夹具零重叠。
  {
    // [6a] 正例：区间 3 天，中间一天预先有排班（被调班覆盖）——验证全落 + 旧行被软删（三字段全写）+ replaced 逐日正确。
    const preSeed = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: '2031-02-02', user_id: 6 });
    assert.strictEqual(preSeed.status, 201, `预置排班期望 201, got ${JSON.stringify(preSeed.body)}`);
    const batch1 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok,
      { date_from: '2031-02-01', date_to: '2031-02-03', user_id: 5, note: 'batch-test' });
    assert.strictEqual(batch1.status, 201, `[6a] 批量正例期望 201, got ${batch1.status} ${JSON.stringify(batch1.body)}`);
    assert.strictEqual(batch1.body.count, 3, `[6a] count 应为 3，实得 ${batch1.body.count}`);
    assert.strictEqual(batch1.body.user_name, '开发甲', '[6a] user_name 应服务端派生（开发甲）');
    assert.strictEqual(batch1.body.items.length, 3, '[6a] items 应含 3 条');
    const midItem = batch1.body.items.find(it => it.duty_date === '2031-02-02');
    assert.strictEqual(midItem.replaced, '开发乙', `[6a] 2031-02-02 应报告 replaced=开发乙（原预置人），实得 ${midItem && midItem.replaced}`);
    const edgeItems = batch1.body.items.filter(it => it.duty_date !== '2031-02-02');
    assert.ok(edgeItems.every(it => it.replaced === null), '[6a] 无预置排班的两天 replaced 应为 null');
    const activeRows1 = await all(`SELECT duty_date, user_id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-02-01' AND '2031-02-03' AND removed_at IS NULL`);
    assert.strictEqual(activeRows1.length, 3, `[6a] 该区间活跃行应恰 3 条，实得 ${activeRows1.length}`);
    assert.ok(activeRows1.every(r => r.user_id === 5), '[6a] 三天活跃行 user_id 应全为 5（开发甲）');
    const oldMidRow = await get('SELECT removed_at, removed_by, removed_by_name FROM sys_release_duty_roster WHERE id = ?', [preSeed.body.id]);
    assert.ok(oldMidRow.removed_at && oldMidRow.removed_by > 0 && oldMidRow.removed_by_name, '[6a] 被覆盖的预置行三字段应全写（软删，非硬删）');
    ok('[6a] 批量正例：区间 3 天全落 user_id=5 + 中间一天预置排班被软删覆盖（三字段全写）+ replaced 逐日正确（中间=开发乙，两端=null）');

    // [6b] 负例·from>to：400 DUTY_RANGE_INVALID，零写入
    const badOrder6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-03-10', date_to: '2031-03-05', user_id: 5 });
    assert.strictEqual(badOrder6.status, 400, `[6b] from>to 期望 400, got ${badOrder6.status} ${JSON.stringify(badOrder6.body)}`);
    assert.strictEqual(badOrder6.body.code, 'DUTY_RANGE_INVALID', '[6b] from>to 应带确切码 DUTY_RANGE_INVALID');
    const zeroRows6b = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-03-05' AND '2031-03-10' AND removed_at IS NULL`);
    assert.strictEqual(zeroRows6b.length, 0, '[6b] from>to 400 后该区间应零写入');
    ok('[6b] 负例 from>to → 400 DUTY_RANGE_INVALID，零写入');

    // [6c] 负例·区间过长（动态算 62/63 天边界，同 GET 93/94 天写法，避免手数出错）：
    //   先测失败区间（63 天）零写入，再测恰好 62 天区间放行 + 精确落 62 行——两段用不同锚点日期，互不干扰断言。
    const failFromMs = Date.UTC(2031, 3, 1);   // 2031-04-01
    const fmt6 = (ms) => new Date(ms).toISOString().slice(0, 10);
    const to63 = fmt6(failFromMs + 62 * 86400000);   // 63 天（diffDays=62）→ 应拒
    const tooLong6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-04-01', date_to: to63, user_id: 5 });
    assert.strictEqual(tooLong6.status, 400, `[6c] 63 天区间期望 400, got ${tooLong6.status} ${JSON.stringify(tooLong6.body)}`);
    assert.strictEqual(tooLong6.body.code, 'DUTY_BATCH_RANGE_TOO_LONG', '[6c] 63 天区间应带确切码 DUTY_BATCH_RANGE_TOO_LONG');
    const zeroRows6c = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-04-01' AND ?`, [to63]);
    assert.strictEqual(zeroRows6c.length, 0, '[6c] 63 天区间 400 后应零写入');

    const passFromMs = Date.UTC(2031, 5, 1);   // 2031-06-01（独立锚点，避免与上面失败区间断言互相污染）
    const to62 = fmt6(passFromMs + 61 * 86400000);   // 恰 62 天（diffDays=61）→ 应放行
    const okRange6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-06-01', date_to: to62, user_id: 5 });
    assert.strictEqual(okRange6.status, 201, `[6c] 恰 62 天区间期望 201, got ${okRange6.status} ${JSON.stringify(okRange6.body)}`);
    assert.strictEqual(okRange6.body.count, 62, `[6c] 恰 62 天区间 count 应为 62，实得 ${okRange6.body.count}`);
    const activeRows62 = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-06-01' AND ? AND removed_at IS NULL`, [to62]);
    assert.strictEqual(activeRows62.length, 62, `[6c] 恰 62 天区间活跃行应恰 62 条，实得 ${activeRows62.length}`);
    ok(`[6c] 区间上限：63 天（2031-04-01~${to63}）400 DUTY_BATCH_RANGE_TOO_LONG 零写入；恰 62 天（2031-06-01~${to62}）201 放行且精确落 62 行（动态计算边界，非手数）`);

    // [6d] 负例·非对接人资格闸：admin/viewer/dev(5,user)/示例发布者(7,publisher) 均 403 INTAKE_LIAISON_ONLY，零写入
    //   ⭐ [C10-fix M1·收回权限放宽] 收回窄集合[13] 后 dev(5)/示例发布者(7) 重新成为负例——release/roster 级授权不随
    //     候选池扩大，仅示例对接人(13) 可写（batch 与单日端点同判据·守边界）。
    //   ⚠️ 日期段用 2031-12（远离 [6c] 恰 62 天正例区间 2031-06-01~2031-08-01，避免与其活跃行重叠导致零写入断言假失败）。
    const DENY6 = [
      { who: 'admin(1)', tok: adminTok },
      { who: 'viewer(8)', tok: viewerTok },
      { who: 'dev(5,role=user·非[13])', tok: devTok },
      { who: '示例发布者(7,publisher·非[13])', tok: publisherTok },
    ];
    for (const role of DENY6) {
      const r = await call('POST', '/api/sys-duty-roster-batch', role.tok, { date_from: '2031-12-01', date_to: '2031-12-03', user_id: 5 });
      assert.strictEqual(r.status, 403, `[6d] ${role.who} 期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INTAKE_LIAISON_ONLY', `[6d] ${role.who} 期望确切码 INTAKE_LIAISON_ONLY`);
    }
    const zeroRows6d = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-12-01' AND '2031-12-03' AND removed_at IS NULL`);
    assert.strictEqual(zeroRows6d.length, 0, '[6d] admin/viewer/dev/示例发布者 403 后该区间应零写入（admin 亦被拒，与单日端点同判据）');
    ok('[C10-fix M1][6d] 写权矩阵（同单日端点判据·收回窄集合[13]）：真负例扩回——admin/viewer/dev(5,user)/示例发布者(7,publisher) 均 403 INTAKE_LIAISON_ONLY 且零写入（release/roster 级不随候选池扩大）');

    // ⭐ [C10-fix M1] 正例：仅示例对接人(13,窄集合) 可批量写排班——用独立日期段验证 201 + count 精确落库。
    const liaisonBatch = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-12-11', date_to: '2031-12-12', user_id: 5 });
    assert.strictEqual(liaisonBatch.status, 201, `[C10-fix M1][6d+] 示例对接人(13) 期望 201, got ${liaisonBatch.status} ${JSON.stringify(liaisonBatch.body)}`);
    assert.strictEqual(liaisonBatch.body.count, 2, `[C10-fix M1][6d+] 示例对接人(13) 批量 count 应为 2，实得 ${liaisonBatch.body.count}`);
    ok('[C10-fix M1][6d+] 写权矩阵正例：仅示例对接人(13,窄集合) 可 201 批量写排班（release/roster 级授权保持窄集合·候选扩大不延伸）');

    // [6e] 负例·区间边界本身含非法日期（date_from/date_to 任一非真实日历日）→ 400 INVALID_DUTY_DATE，零写入
    //   （区间内部逐日日期由服务端 Date.UTC 步进生成，不会出现"边界合法但内部某天非法"，故本组只测边界本身）。
    const badFrom6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-09-31', date_to: '2031-10-05', user_id: 5 });   // 9月无31日
    assert.strictEqual(badFrom6.status, 400, `[6e] date_from 非法期望 400, got ${badFrom6.status} ${JSON.stringify(badFrom6.body)}`);
    assert.strictEqual(badFrom6.body.code, 'INVALID_DUTY_DATE', '[6e] date_from 非法应带确切码 INVALID_DUTY_DATE');
    const badTo6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-10-01', date_to: '2031-02-30', user_id: 5 });   // 2月无30日
    assert.strictEqual(badTo6.status, 400, `[6e] date_to 非法期望 400, got ${badTo6.status} ${JSON.stringify(badTo6.body)}`);
    assert.strictEqual(badTo6.body.code, 'INVALID_DUTY_DATE', '[6e] date_to 非法应带确切码 INVALID_DUTY_DATE');
    const zeroRows6e = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-09-25' AND '2031-10-05' AND removed_at IS NULL`);
    assert.strictEqual(zeroRows6e.length, 0, '[6e] 边界非法日期 400 后应零写入');
    ok('[6e] 负例区间边界含非法日期：date_from=2031-09-31（9月无31日）/ date_to=2031-02-30 均 400 INVALID_DUTY_DATE，零写入');

    // [6f] 负例·资格闸（区间级）：user_id 无资格（admin=1）→ 400 DUTY_USER_NOT_ELIGIBLE，整段零写入
    //   （资格闸在事务内、循环开始前一次性判定——失败时连第一天都不会写，证明"判定先于任何一天的写入"）。
    const notEligible6 = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, { date_from: '2031-11-01', date_to: '2031-11-03', user_id: 1 });
    assert.strictEqual(notEligible6.status, 400, `[6f] user_id=admin 期望 400, got ${notEligible6.status} ${JSON.stringify(notEligible6.body)}`);
    assert.strictEqual(notEligible6.body.code, 'DUTY_USER_NOT_ELIGIBLE', '[6f] 应带确切码 DUTY_USER_NOT_ELIGIBLE');
    const zeroRows6f = await all(`SELECT id FROM sys_release_duty_roster WHERE duty_date BETWEEN '2031-11-01' AND '2031-11-03' AND removed_at IS NULL`);
    assert.strictEqual(zeroRows6f.length, 0, '[6f] 资格闸拒绝后整段零写入（含区间第一天）');
    ok('[6f] 负例资格闸：user_id=admin(1) → 400 DUTY_USER_NOT_ELIGIBLE，区间内（含第一天）零写入——资格判定先于循环内任何写入');

    // [6g] 对抗审"假绿猎手"视角裁定必修 A：循环中途某天 softDeleteDutyRoster 返回 false（并发 changes≠1）
    //   → 断言 409 DUTY_ROSTER_CONFLICT + 前几天已执行的 INSERT 全部回滚（零残留）+ 被"并发抢先修改"的那天
    //   旧行本身未被半途软删（removed_at 仍 NULL，因为 UPDATE 本身就没生效）。
    //   ⚠️ 构造手段说明：本项目 PM2 单进程 + sysTxnMutex 模块级互斥 + BEGIN IMMEDIATE 独占写锁——同一批量
    //   请求的整个 for 循环运行在同一个事务、同一条连接上，期间不可能有第二个真实并发请求插队修改同一行
    //   （第二个请求会被 mutex 挡在事务外，或被 SQLite 挡 SQLITE_BUSY，都不会"悄悄改成功"）。用两个真实
    //   HTTP 请求制造"循环中途另一路径把同一行软删"这个时序在本架构下不可复现，故改用**触发器模拟目标行
    //   被并发修改**：对该行 id 建一条 `BEFORE UPDATE ... WHEN OLD.id=? RAISE(IGNORE)`，使批量循环内对这
    //   一行的 UPDATE 语句本身被静默跳过（changes=0）——效果上与"这行被另一个并发写者抢先改动"完全等价
    //   （softDeleteDutyRoster 只关心 `changes===1`，不关心落空的原因是并发还是触发器），且不依赖真实跨进程
    //   竞态（本架构下也无法构造），是本单进程模型下能达到的最直接确定性注入。测完立即 DROP TRIGGER，不
    //   污染后续任何用例。
    const range6g = ['2031-08-15', '2031-08-16', '2031-08-17', '2031-08-18', '2031-08-19'];   // 独立日期段，与 [6a]-[6f] 及 [6c] 62 天正例（2031-06-01~2031-08-01）零重叠
    const poisonDate6g = '2031-08-17';   // 区间第 3 天（中途，非首尾）——精确复现"前 N 天已写、第 N+1 天失败"
    const preSeed6g = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: poisonDate6g, user_id: 6 });
    assert.strictEqual(preSeed6g.status, 201, `[6g] 预置排班期望 201, got ${JSON.stringify(preSeed6g.body)}`);
    const poisonId6g = preSeed6g.body.id;
    assert.ok(Number.isInteger(poisonId6g) && poisonId6g > 0, `[6g] 预置排班返回的 id 必须是正整数（防下方字符串拼接注入），实得 ${JSON.stringify(poisonId6g)}`);
    // ⚠️ SQLite 的 CREATE TRIGGER 语句体不支持 `?` 绑定参数（触发器文本在 fire 时才编译，无绑定上下文）——
    //   此处直接拼字符串，仅因 poisonId6g 已用上一行断言强制收窄为正整数，非用户输入，无注入面。
    await run(
      `CREATE TRIGGER trg_6g_poison BEFORE UPDATE ON sys_release_duty_roster
       WHEN OLD.id = ${poisonId6g} BEGIN SELECT RAISE(IGNORE); END`
    );
    try {
      const batch6g = await call('POST', '/api/sys-duty-roster-batch', liaisonTok,
        { date_from: range6g[0], date_to: range6g[4], user_id: 5, note: '6g-mid-loop-fail' });
      assert.strictEqual(batch6g.status, 409, `[6g] 中途失败期望 409, got ${batch6g.status} ${JSON.stringify(batch6g.body)}`);
      assert.strictEqual(batch6g.body.code, 'DUTY_ROSTER_CONFLICT', '[6g] 应带确切码 DUTY_ROSTER_CONFLICT');
      assert.ok(batch6g.body.error && batch6g.body.error.includes(poisonDate6g), `[6g] 错误信息应点名冲突日期 ${poisonDate6g}，实得 ${batch6g.body.error}`);

      // 前 2 天（08-15/08-16，循环中已真实执行 INSERT）必须零残留——证明"已写的前几天"随失败整体回滚，
      //   非仅"后面几天不再处理"这种更弱的部分成功语义。
      const rolledBackDays = await all(
        `SELECT duty_date FROM sys_release_duty_roster WHERE duty_date IN ('2031-08-15','2031-08-16') AND removed_at IS NULL`
      );
      assert.strictEqual(rolledBackDays.length, 0, `[6g] 前 2 天（已在循环内 INSERT）应随失败整体回滚，零残留，实得 ${JSON.stringify(rolledBackDays)}`);

      // 后 2 天（08-18/08-19，循环还没跑到）天然零写入——一并核对，防"只回滚前段、后段被误跑"的一半假绿。
      const neverReachedDays = await all(
        `SELECT duty_date FROM sys_release_duty_roster WHERE duty_date IN ('2031-08-18','2031-08-19') AND removed_at IS NULL`
      );
      assert.strictEqual(neverReachedDays.length, 0, `[6g] 后 2 天（循环未执行到）应零写入，实得 ${JSON.stringify(neverReachedDays)}`);

      // 被"并发"命中的那天：旧行必须原样保留在册（removed_at 仍 NULL）——因为 softDeleteDutyRoster 的
      //   UPDATE 被触发器拦下 changes=0，事务侧根本没有对这行做出任何真实修改，不存在"半途软删"。
      const poisonRowAfter = await get('SELECT removed_at, user_id FROM sys_release_duty_roster WHERE id = ?', [poisonId6g]);
      assert.strictEqual(poisonRowAfter.removed_at, null, '[6g] 被命中并发的那天旧行 removed_at 仍应为 NULL（未被半途软删）');
      assert.strictEqual(poisonRowAfter.user_id, 6, '[6g] 被命中并发的那天旧行 user_id 仍为原值 6（开发乙，未被覆盖）');

      ok(`[6g] 循环中途失败（第 3 天 ${poisonDate6g} 遭遇"并发"软删失败）：409 DUTY_ROSTER_CONFLICT，已执行的前 2 天全部回滚（零残留），未执行的后 2 天天然零写入，被命中当天旧行原样保留（未半途软删）——批量端点"全成或全不成"原子性声称首次落到真实的循环中途失败路径`);
    } finally {
      await run(`DROP TRIGGER IF EXISTS trg_6g_poison`);
    }
  }

  console.log(`\n✅ verify-sys-duty-roster 全部通过（${passed} 组·上线体统一重构 C1 排班表 CRUD + 资格闸 + C2b 区间批量设置）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
