// verify-correction-relay-e2e.js — 路线 B 对接人白名单化端到端（真实 server + JWT 注入 + seed）
//   验证真实 http 路径（中间件 requireRelayOrPublisherOrAdmin → handler → correctionTransition 串起来）下：
//   建单 path B 白名单+phone 校验 / 列表+详情可见性 handler / user 角色白名单 relay 派单(RC-M3) / 越权 403。
//   seed：本地库无 id=13、id=7 无 phone → 复制 id=7 行造 id=13(user+phone) + 临时给 id=7 补 phone；测后清理恢复。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const tok = (id, role) => jwt.sign({ id, username: 'u' + id, role }, JWT_SECRET, { expiresIn: '1h' });
const T_ADMIN = tok(1, 'admin'), T_R13 = tok(13, 'user'), T_NONWL = tok(9, 'user');   // id=9 本地存在、非白名单、非测试单任何角色

const db = new sqlite3.Database(path.join(__dirname, '..', 'task_pool.db'));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, r) => e ? rej(e) : res(r)));
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));

function req(token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: 3000, method, path: p,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jparse = (b) => { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } };
const listIds = (b) => { const j = jparse(b); const a = j.data || j.corrections || j.list || j.items || (Array.isArray(j) ? j : []); return a.map(x => x.id); };

let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label + ' — ' + (detail || '')); fail++; } };

let server = null, orig7phone = null, seeded13 = false;

async function seed() {
  const u7 = await get('SELECT * FROM users WHERE id = 7');
  if (!u7) throw new Error('本地无 id=7，无法 seed（端到端需要 publisher 基准行）');
  orig7phone = u7.phone;
  await run("UPDATE users SET phone = '13800000007' WHERE id = 7");                    // 临时给示例发布者补 phone（path B 测）
  const existing13 = await get('SELECT id FROM users WHERE id = 13');
  if (!existing13) {
    const row13 = Object.assign({}, u7, { id: 13, username: 'TEST_RELAY_13', display_name: '示例对接人(e2e)', role: 'user', phone: '13800000013' });
    const cols = Object.keys(row13);
    await run(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row13[c]));
    seeded13 = true;
  } else {
    await run("UPDATE users SET role='user', phone='13800000013' WHERE id=13");
  }
}
async function cleanup() {
  // 兜底按 location_info 删所有 E2E 单（不依赖 created id）；SIGKILL 后 db 可能短暂 busy，重试几次。
  for (let i = 0; i < 6; i++) {
    try {
      await run("DELETE FROM correction_status_history WHERE correction_request_id IN (SELECT id FROM correction_requests WHERE location_info LIKE 'E2E%')");
      await run("DELETE FROM correction_requests WHERE location_info LIKE 'E2E%'");
      break;
    } catch (_) { await sleep(300); }
  }
  if (seeded13) { for (let i = 0; i < 6; i++) { try { await run('DELETE FROM users WHERE id=13'); break; } catch (_) { await sleep(300); } } }
  for (let i = 0; i < 6; i++) { try { await run('UPDATE users SET phone=? WHERE id=7', [orig7phone]); break; } catch (_) { await sleep(300); } }
}

(async () => {
  console.log('=== 路线 B 对接人白名单化 端到端（真实 server + JWT 注入）===\n');
  await seed();
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..') });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  // 等服务 + correction readiness
  for (let i = 0; i < 40; i++) { const v = await req(T_ADMIN, 'GET', '/api/version'); if (v.status === 200) break; await sleep(250); }
  await sleep(900);

  const created = [];
  try {
    // 1. 建单 path B：admin 建 relay=13 单 → 白名单+phone 通过
    const c13 = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'BMS', location_info: 'E2E relay13 单', requester_name: 'E2E', correction_type: 'single', reason: 'relay13 对接人测试原因', relay_notified_user_id: 13 });
    const id13 = jparse(c13.body).id; if (id13) created.push(id13);
    check(c13.status === 200 && !!id13, `建单 path B relay=13（白名单+phone 通过）→ 200 #${id13}`, `status=${c13.status} ${(c13.body || '').slice(0, 140)}`);

    // 2. 列表可见性：白名单 relay(13) 列表可见其经手单
    const lst = await req(T_R13, 'GET', '/api/corrections');
    check(lst.status === 200 && listIds(lst.body).includes(id13), `白名单 relay(13,user) 列表可见其经手单 #${id13}（列表 OR handler）`, `status=${lst.status}`);

    // 3. CR-M1 详情可见性：白名单 relay(13) 详情 200（列表↔详情一致）
    const d13 = await req(T_R13, 'GET', '/api/corrections/' + id13);
    check(d13.status === 200, `白名单 relay(13) 详情 #${id13} → 200（CR-M1：列表↔详情可见性一致）`, `status=${d13.status} ${(d13.body || '').slice(0, 120)}`);

    // 4. RC-M3 核心：user 角色白名单 relay 派单成功（中间件→handler→transition 真实路径）
    const asg = await req(T_R13, 'POST', '/api/corrections/' + id13 + '/assign', { assigned_to: 8 });
    check(asg.status === 200 && jparse(asg.body).status === 'ASSIGNED_PENDING_ESTIMATE', `RC-M3：user 角色白名单 relay(13) 派单 → 200 + 状态 ASSIGNED_PENDING_ESTIMATE`, `status=${asg.status} ${(asg.body || '').slice(0, 140)}`);

    // 4b. 细优④A：白名单 relay(13) 能通知开发（notify-developer 放开对接人）→ 非 403/非 500（无钉钉配置 failed 落库，但权限/依赖通过）
    const ndev = await req(T_R13, 'POST', '/api/corrections/' + id13 + '/notify-developer', {});
    check(ndev.status !== 403 && ndev.status !== 500, `细优④A：白名单 relay(13) notify-developer 非 403/500（能指派也能通知开发，补断层）`, `status=${ndev.status} ${(ndev.body || '').slice(0, 120)}`);

    // 4c. 细优 K2-M1 写读同源：白名单 relay(13) 查 dev read-status → 非 403（read-status 与 notify-developer 放开同步）
    const rsDev = await req(T_R13, 'GET', '/api/corrections/' + id13 + '/notify-read-status?recipient=dev');
    check(rsDev.status !== 403, `K2-M1：白名单 relay(13) 查 dev read-status 非 403（与 notify-developer 同权）`, `status=${rsDev.status} ${(rsDev.body || '').slice(0, 120)}`);

    // 5. 越权：非白名单 user(99) 详情该单 → 403
    const d99 = await req(T_NONWL, 'GET', '/api/corrections/' + id13);
    check(d99.status === 403, `非白名单 user(9) 详情 #${id13} → 403（可见性越权防护）`, `status=${d99.status}`);

    // 6. 越权：白名单 relay(13) 看不到/不能派 非本人经手单（relay=7 单）
    const c7 = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'HRD', location_info: 'E2E relay7 单', requester_name: 'E2E', correction_type: 'single', reason: 'relay7 对接人测试原因', relay_notified_user_id: 7 });
    const id7 = jparse(c7.body).id; if (id7) created.push(id7);
    const d13on7 = await req(T_R13, 'GET', '/api/corrections/' + id7);
    check(d13on7.status === 403, `白名单 relay(13) 详情非本人经手单(relay=7) #${id7} → 403`, `status=${d13on7.status}`);
    const a13on7 = await req(T_R13, 'POST', '/api/corrections/' + id7 + '/assign', { assigned_to: 8 });
    check(a13on7.status === 403, `白名单 relay(13) 派非本人经手单(relay=7) → 403（transition 权威闸门）`, `status=${a13on7.status} ${(a13on7.body || '').slice(0, 120)}`);

    // 7. path B 非白名单 → 400
    const cNon = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'BMS', location_info: 'E2E 非白名单', requester_name: 'E2E', correction_type: 'single', reason: '非白名单对接人测试原因', relay_notified_user_id: 1 });
    check(cNon.status === 400 && jparse(cNon.body).code === 'RELAY_USER_NOT_IN_WHITELIST', `建单 path B 非白名单 relay=1 → 400 RELAY_USER_NOT_IN_WHITELIST`, `status=${cNon.status} ${(cNon.body || '').slice(0, 120)}`);

    const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(log);
    check(!crashed, '服务日志无 ReferenceError/TypeError', crashed ? log.slice(-300) : '');
  } finally {
    if (server) server.kill('SIGKILL');
    await sleep(800);   // 等 server 进程退出释放 db 文件锁，再清理
    await cleanup();
    db.close();
  }
  console.log(`\n${fail === 0 ? '✅' : '✗'} 路线 B 端到端：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('✗ e2e 异常：', e.message); if (server) server.kill('SIGKILL'); await sleep(800); try { await cleanup(); } catch (_) {} process.exit(1); });
