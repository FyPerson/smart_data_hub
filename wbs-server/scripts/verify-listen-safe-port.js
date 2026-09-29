// verify-listen-safe-port.js — scripts/lib/listen-safe-port.js 自检（PROJECT_STATUS #95）
// 覆盖：取值区间 / EADDRINUSE 重试（app 与 http.Server 两种 target）/ EACCES 重试 / 其他错误不重试 /
//   重试上限 / 返回即 listening / 监听器不泄漏 / 区间外注入被拒 / Fetch 禁用端口名单全在取值域之外
//   （静态断言 + undici 活体对照：禁用端口报 bad port，助手给的端口能真实取回响应）。
'use strict';
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { listenOnSafePort, SAFE_PORT_MIN, SAFE_PORT_MAX, MAX_ATTEMPTS } = require('./lib/listen-safe-port');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL ${label}${detail === undefined ? '' : ' :: ' + detail}`);
}
const closeServer = (server) => new Promise((resolve) => { if (!server || !server.listening) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); });
const LISTENING_BASELINE = http.createServer().listenerCount('listening'); // http.Server 自带 1 个 listening 监听器
const noResidue = (server) => server.listenerCount('error') === 0 && server.listenerCount('listening') === LISTENING_BASELINE;
const inRange = (port) => Number.isInteger(port) && port >= SAFE_PORT_MIN && port <= SAFE_PORT_MAX;
function errorAfterTick(server, code) {
  process.nextTick(() => server.emit('error', Object.assign(new Error(`simulated ${code}`), { code })));
}

// Fetch 标准 bad ports 全表（https://fetch.spec.whatwg.org/#bad-port）
const FETCH_BAD_PORTS = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
// 本机 Windows 管理排除段（netsh int ipv4 show excludedportrange tcp）与动态端口段
const EXCLUDED_RANGE = [50000, 50059];
const DYNAMIC_RANGE = [1024, 15000];

async function main() {
  const app = express();
  app.get('/ping', (req, res) => res.json({ ok: true }));

  // ── 1. 静态：取值域与禁用名单 / 排除段 / 动态段互不相交 ──
  check('SAFE 区间 = 20000–49999', SAFE_PORT_MIN === 20000 && SAFE_PORT_MAX === 49999);
  check('Fetch 禁用端口全部 < SAFE_PORT_MIN', FETCH_BAD_PORTS.every((p) => p < SAFE_PORT_MIN), FETCH_BAD_PORTS.filter((p) => p >= SAFE_PORT_MIN).join(','));
  check('本机禁用端口实例（6666/10080）< SAFE_PORT_MIN', 6666 < SAFE_PORT_MIN && 10080 < SAFE_PORT_MIN);
  check('管理排除段 50000–50059 在区间之上', EXCLUDED_RANGE[0] > SAFE_PORT_MAX);
  check('动态端口段 1024–15000 在区间之下', DYNAMIC_RANGE[1] < SAFE_PORT_MIN);
  check('重试上限 = 10', MAX_ATTEMPTS === 10);

  // ── 2. 区间：取 200 次全部落在区间内，返回即 listening ──
  let allInRange = true, allListening = true, allLoopback = true;
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const server = await listenOnSafePort(app);
    const addr = server.address();
    if (!inRange(addr.port)) allInRange = false;
    if (!server.listening) allListening = false;
    if (addr.address !== '127.0.0.1') allLoopback = false;
    seen.add(addr.port);
    await closeServer(server);
  }
  check('200 次取端口全部落在 20000–49999', allInRange);
  check('200 次返回时均已 listening', allListening);
  check('默认 host 绑 127.0.0.1', allLoopback);
  check('端口随机（200 次至少 150 个不同值）', seen.size >= 150, seen.size);

  // ── 3. host=null：不带 host（原 listen(port) 语义），localhost 可连 ──
  {
    const server = await listenOnSafePort(app, null);
    const port = server.address().port;
    check('host=null 端口在区间内', inRange(port), port);
    const r = await fetch(`http://localhost:${port}/ping`, { headers: { Connection: 'close' } });
    check('host=null 经 localhost 取回响应', r.status === 200 && (await r.json()).ok === true);
    await closeServer(server);
  }

  // ── 4. 活体对照：助手端口 fetch 成功；Fetch 禁用端口 undici 在建连前报 bad port ──
  {
    const server = await listenOnSafePort(app);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/ping`, { headers: { Connection: 'close' } });
    check('助手端口 fetch 成功', r.status === 200);
    await closeServer(server);
    let cause = '';
    try { await fetch('http://127.0.0.1:6666/ping'); } catch (e) { cause = String(e && e.cause && e.cause.message); }
    check('对照：6666 端口 undici 报 bad port（证明名单机制真实存在）', /bad port/i.test(cause), cause);
  }

  // ── 5. EADDRINUSE 重试：app target（每次新建 server）──
  {
    const holder = await listenOnSafePort(app);
    const busy = holder.address().port;
    const picks = [];
    const server = await listenOnSafePort(app, '127.0.0.1', { pickPort: (n) => { const p = n === 1 ? busy : 20000 + Math.floor(Math.random() * 29999); picks.push(p); return p; } });
    check('EADDRINUSE（app）：首次撞上被占端口', picks[0] === busy);
    check('EADDRINUSE（app）：换端口后成功', picks.length >= 2 && server.listening && server.address().port !== busy && inRange(server.address().port), JSON.stringify(picks));
    check('EADDRINUSE（app）：返回的 server 不是占用者', server !== holder && holder.listening);
    await closeServer(server);
    await closeServer(holder);
  }

  // ── 6. EADDRINUSE 重试：http.Server target（同一对象复用重绑）+ 监听器不泄漏 ──
  {
    const holder = await listenOnSafePort(app);
    const busy = holder.address().port;
    const target = http.createServer(app);
    const baseErr = target.listenerCount('error'), baseListen = target.listenerCount('listening');
    const picks = [];
    const server = await listenOnSafePort(target, '127.0.0.1', { pickPort: (n) => { const p = n === 1 ? busy : 20000 + Math.floor(Math.random() * 29999); picks.push(p); return p; } });
    check('EADDRINUSE（http.Server）：复用同一对象', server === target);
    check('EADDRINUSE（http.Server）：换端口后 listening', picks[0] === busy && picks.length >= 2 && server.listening && inRange(server.address().port), JSON.stringify(picks));
    check('EADDRINUSE（http.Server）：error/listening 监听器无残留', target.listenerCount('error') === baseErr && target.listenerCount('listening') === baseListen,
      `${target.listenerCount('error')}/${target.listenerCount('listening')}`);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/ping`, { headers: { Connection: 'close' } });
    check('EADDRINUSE（http.Server）：重绑后请求正常', r.status === 200);
    await closeServer(server);
    await closeServer(holder);
  }

  // ── 7. EACCES 重试（模拟 Windows 管理排除段：首次 listen 报 EACCES）──
  {
    const target = http.createServer(app);
    const realListen = target.listen.bind(target);
    let calls = 0;
    target.listen = function (...args) { calls++; if (calls === 1) { errorAfterTick(target, 'EACCES'); return target; } return realListen(...args); };
    const server = await listenOnSafePort(target);
    check('EACCES：重试后成功', calls === 2 && server.listening && inRange(server.address().port), calls);
    check('EACCES：监听器无残留', noResidue(target));
    await closeServer(server);
  }
  // EACCES 同步抛出形态也按可重试处理
  {
    const target = http.createServer(app);
    const realListen = target.listen.bind(target);
    let calls = 0;
    target.listen = function (...args) { calls++; if (calls === 1) throw Object.assign(new Error('sync EACCES'), { code: 'EACCES' }); return realListen(...args); };
    const server = await listenOnSafePort(target);
    check('EACCES（同步抛出）：重试后成功且监听器无残留', calls === 2 && server.listening && noResidue(target), calls);
    await closeServer(server);
  }

  // ── 8. 其他错误不重试，原样抛出 ──
  for (const code of ['EINVAL', 'EPERM', 'EADDRNOTAVAIL']) {
    const target = http.createServer(app);
    let calls = 0;
    const original = Object.assign(new Error(`simulated ${code}`), { code });
    target.listen = function () { calls++; process.nextTick(() => target.emit('error', original)); return target; };
    let caught;
    try { await listenOnSafePort(target); } catch (e) { caught = e; }
    check(`${code}：只尝试 1 次`, calls === 1, calls);
    check(`${code}：原样抛出同一错误对象`, caught === original);
    check(`${code}：监听器无残留`, noResidue(target));
  }
  {
    // 无 code 的错误同样不重试
    const target = http.createServer(app);
    let calls = 0;
    target.listen = function () { calls++; process.nextTick(() => target.emit('error', new Error('no code'))); return target; };
    let caught;
    try { await listenOnSafePort(target); } catch (e) { caught = e; }
    check('无 code 错误：不重试直接抛', calls === 1 && caught && caught.message === 'no code');
  }

  // ── 9. 重试上限：一直 EADDRINUSE → 恰好 10 次后抛最后一次的错误 ──
  {
    const target = http.createServer(app);
    let calls = 0, last;
    target.listen = function () { calls++; last = Object.assign(new Error('busy ' + calls), { code: calls % 2 ? 'EADDRINUSE' : 'EACCES' }); const e = last; process.nextTick(() => target.emit('error', e)); return target; };
    let caught;
    try { await listenOnSafePort(target); } catch (e) { caught = e; }
    check('重试上限：恰好尝试 10 次', calls === MAX_ATTEMPTS, calls);
    check('重试上限：抛出最后一次错误', caught === last && caught.code === 'EACCES');
    check('重试上限：监听器无残留', noResidue(target));
  }

  // ── 9b. 真实占用（非模拟 error）：复用的 http.Server 连撞两次 EADDRINUSE 后换端口重绑成功（codex 08/08b M）──
  {
    const pick = [];
    for (let p = SAFE_PORT_MIN + 7000; pick.length < 2 && p <= SAFE_PORT_MAX; p++) {
      const probe = net.createServer();
      const ok = await new Promise((resolve) => { probe.once('error', () => resolve(false)); probe.listen(p, '127.0.0.1', () => resolve(true)); });
      if (ok) { await new Promise((r) => probe.close(r)); pick.push(p); }
    }
    const blocker = net.createServer();
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(pick[0], '127.0.0.1', resolve); });
    const target = http.createServer((req, res) => res.end('real-rebind'));
    const seq = [pick[0], pick[0], pick[1]];
    let got, caught;
    try { got = await listenOnSafePort(target, '127.0.0.1', { pickPort: (attempt) => seq[attempt - 1] }); } catch (e) { caught = e; }
    check('真实占用：复用对象连撞两次后重绑成功且返回同一对象', !caught && got === target && target.listening && target.address().port === pick[1], caught && caught.message);
    let body = '';
    if (!caught) { try { body = await (await fetch(`http://127.0.0.1:${pick[1]}/`)).text(); } catch (e) { body = 'ERR ' + e.message; } }
    check('真实占用：重绑后的端口可取回响应', body === 'real-rebind', body);
    check('真实占用：监听器无残留', noResidue(target));
    await closeServer(target);
    await new Promise((r) => blocker.close(r));
  }

  // ── 10. 注入区间外端口被拒；非法 target 被拒 ──
  for (const bad of [0, 6666, 10080, 19999, 50000, 50059, 60000, 20000.5]) {
    let caught;
    try { await listenOnSafePort(app, '127.0.0.1', { pickPort: () => bad }); } catch (e) { caught = e; }
    check(`区间外注入 ${bad} 被拒（RangeError）`, caught instanceof RangeError, caught && caught.message);
  }
  {
    let caught;
    try { await listenOnSafePort({}); } catch (e) { caught = e; }
    check('非法 target 被拒（TypeError）', caught instanceof TypeError);
  }

  console.log(`verify-listen-safe-port PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1; // 不用 process.exit：Windows 上有句柄关闭中时会触发 libuv 断言
}

main().catch((e) => {
  console.log('FATAL', e && (e.stack || e)); console.log(`verify-listen-safe-port PASS=${pass} FAIL=${fail + 1}`); process.exitCode = 1;
  // 出错路径上已打开的服务句柄不会被关闭，进程会挂住 ⇒ FAMILY 挂死而不是判红。unref 定时器不延长进程寿命，
  // 只在 3 秒后仍未自然退出时兜底（正常路径不经过这里，不受 Windows 句柄关闭断言影响）。
  setTimeout(() => process.exit(1), 3000).unref();
});
