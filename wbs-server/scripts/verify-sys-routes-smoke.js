// 验证脚本：系统迭代模块挂载/路由 smoke（C1，方案 §7.1 + §1.3 fall-through 安全）
//   用法：node scripts/verify-sys-routes-smoke.js
//
// 验证目标（不碰生产 task_pool.db，用 :memory: db + 临时端口 in-process）：
//   1. require routes/sys-iteration 模块成功 + 返回 { initSchema, router, _internals }
//   2. initSchema 真实建表 → readiness ready=true
//   3. app.use('/api', router) 挂载后：
//      a. GET /api/sys-issues/_readiness 返 200 + { ready:true }（带 token mw 放行）
//      b. ⭐ fall-through：在 router 之后注册的既有路由 /api/existing-probe 不被本 router 提前拦截（07-M2）
//      c. 未匹配的 sys-* 子路径不存在端点 → 404（不误吞）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

const noop = () => {};
const mwPass = (req, res, next) => next();
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
});

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (mod._internals.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (mod._internals.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(mod._internals.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

// 极简 http 请求 helper
function req(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, (r) => {
      let body = '';
      r.on('data', (c) => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
}

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
  // [1] 模块导出形态
  assert.ok(typeof mod.initSchema === 'function', 'initSchema 应为函数');
  assert.ok(mod.router && typeof mod.router === 'function', 'router 应为 express Router');
  assert.ok(mod._internals && mod._internals.SYS_SCHEMA_STATE, '_internals 应导出 SYS_SCHEMA_STATE');
  ok('模块导出形态正确：{ initSchema, router, _internals }');

  // [2] 真实建表 + readiness
  mod.initSchema();
  await waitReady();
  ok('initSchema 真实建表 → readiness ready=true');

  // [3] 起最小 app：挂 router 到 /api，之后注册既有路由探针（验 fall-through）
  const app = express();
  app.use('/api', mod.router);
  // ⭐ 在 sysIter router 之后注册一个"既有路由"探针，模拟 server.js 既有 /api/* 路由。
  //   若 router 用裸 router.use(mw) 或注册了 '/'/通配，会提前吞掉本请求 → 此断言失败。
  app.get('/api/existing-probe', (req, res) => res.json({ probe: 'ok' }));

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  try {
    // 3a. readiness 端点
    const r1 = await req(port, '/api/sys-issues/_readiness');
    assert.strictEqual(r1.status, 200, `readiness 端点应 200，实际 ${r1.status}`);
    const j1 = JSON.parse(r1.body);
    assert.strictEqual(j1.ready, true, 'readiness 应 ready=true');
    ok('GET /api/sys-issues/_readiness → 200 + { ready:true }');

    // 3b. ⭐ fall-through：既有路由不被本 router 拦截
    const r2 = await req(port, '/api/existing-probe');
    assert.strictEqual(r2.status, 200, `既有路由探针应 200（fall-through），实际 ${r2.status}`);
    assert.strictEqual(JSON.parse(r2.body).probe, 'ok', '既有路由响应应原样返回');
    ok('fall-through：/api/existing-probe 不被 sysIter router 拦截（07-M2，router 未注册裸 / 或通配）');

    // 3c. 未注册的 sys-* 资源路径 → 404（不误吞）。
    //   ⚠️ C2 后 /sys-issues/:id 已注册，故不能再用 /sys-issues/xxx 测 404（会被 :id 捕获）；
    //   改用无任何端点匹配的 sys- 前缀路径（/api/sys-nonexistent-resource）。
    const r3 = await req(port, '/api/sys-nonexistent-resource');
    assert.strictEqual(r3.status, 404, `不存在的 sys-* 资源应 404，实际 ${r3.status}`);
    ok('未注册 sys-* 资源路径 → 404（/api/sys-nonexistent-resource 不被任何端点匹配）');

    // 3c-2. C2 新增：/sys-issues/:id 非法 id（非数字）→ 400（id 守卫，在读 req.user 前拦截）
    const r3b = await req(port, '/api/sys-issues/nonexistent-xyz');
    assert.strictEqual(r3b.status, 400, `:id 非法应 400（id 守卫），实际 ${r3b.status}`);
    assert.strictEqual(JSON.parse(r3b.body).code, 'INVALID_SYS_ISSUE_ID', ':id 非法应返 INVALID_SYS_ISSUE_ID');
    ok('C2 /sys-issues/:id 非法 id（nonexistent-xyz）→ 400 INVALID_SYS_ISSUE_ID（id 守卫前置，未触 req.user）');

    // 3d. 完全无关路径 → 404（router 不拦截）
    const r4 = await req(port, '/api/totally-unrelated');
    assert.strictEqual(r4.status, 404, `无关路径应 404，实际 ${r4.status}`);
    ok('无关 /api/* 路径 → 404（router fall-through 后 express 默认 404）');
  } finally {
    server.close();
    db.close();
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代路由 smoke 验证通过（模块导出 + 真实建表 readiness + 挂载 fall-through 安全 + 端点就绪）`);
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
