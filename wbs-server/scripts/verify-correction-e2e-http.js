// verify-correction-e2e-http.js — M-2（codex 末次审）端点级 http 冒烟
//   spawn 真实 server.js + JWT 注入 admin token + 请求 correction 关键端点，证明抽 routes 后
//   端点运行期依赖没漏接（漏注入会 500）。覆盖读（列表/详情/已读查询）+ 写（建单→作废清理）。
//   不重测业务逻辑，只验"工厂注入 + 端点依赖在真实 HTTP 路径下完整"。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

function req(method, p, body, tokenOverride) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 3000, method, path: p,
      headers: { Authorization: 'Bearer ' + (tokenOverride || token), 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await req('GET', '/api/version');
    if (v.status === 200) return true;
    await sleep(250);
  }
  throw new Error('服务未在 ' + timeoutMs + 'ms 内就绪');
}

const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..') });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label + ' — ' + detail); fail++; } };

(async () => {
  console.log('=== M-2 端点级 http 冒烟（真实 server.js + JWT 注入）===\n');
  await waitServer();
  await sleep(800);   // 等 correction readiness（initSchema 在 db 回调）

  // [读] 列表 —— 端点注册 + auth + db 依赖
  const list = await req('GET', '/api/corrections');
  check(list.status === 200, '[读] GET /api/corrections 列表 200（非 500=db/auth 依赖没漏）', `status=${list.status} ${(list.body || '').slice(0, 120)}`);

  let firstId = null;
  try { const j = JSON.parse(list.body || '{}'); const arr = j.data || j.corrections || j.list || j.items || (Array.isArray(j) ? j : []); firstId = arr[0] && arr[0].id; } catch (_) {}

  // [读] 详情 + 已读查询（通知字段映射依赖）—— 用现有单
  if (firstId) {
    const detail = await req('GET', '/api/corrections/' + firstId);
    check(detail.status === 200, `[读] GET 详情 #${firstId} 200`, `status=${detail.status}`);
    const rs = await req('GET', '/api/corrections/' + firstId + '/notify-read-status');
    check(rs.status !== 500, `[读] GET notify-read-status 非 500（CORRECTION_READ_FIELD_MAP 依赖没漏）`, `status=${rs.status} ${(rs.body || '').slice(0, 100)}`);
    // 注：对接人(白名单13)查 dev read-status 非 403（K2-M1 写读同源）放 verify-correction-relay-e2e（那里 seed id=13；e2e-http 不 seed 用户）
  } else {
    console.log('  （库中无现有 correction 单，跳过详情/已读查询读测）');
  }

  // [写] 建单 → 作废清理（correctionStorage/校验/transition/history 依赖）
  const create = await req('POST', '/api/corrections', {
    source_system: 'BMS', location_info: 'E2E 端点冒烟测试单（M-2，测后作废）', requester_name: 'E2E 测试',
    correction_type: 'single', correction_count: 1, reason: 'E2E 端点冒烟测试原因背景',
  });
  check(create.status !== 500, '[写] POST 建单 非 500（建单端点依赖没漏）', `status=${create.status} ${(create.body || '').slice(0, 150)}`);
  let newId = null;
  try { const j = JSON.parse(create.body || '{}'); newId = j.id || (j.data && j.data.id); } catch (_) {}
  if (newId) {
    check(create.status === 200 || create.status === 201, `[写] 建单成功 #${newId}`, `status=${create.status}`);
    // [写] 细优② notify-creator：PENDING_ASSIGN 不可发 → 409（验证端点挂载 + correctionActor/isCorrectionRelayWhitelisted/sendable 依赖完整，非 500）
    const nc = await req('POST', '/api/corrections/' + newId + '/notify-creator', {});
    check(nc.status !== 500, `[写] POST notify-creator #${newId} 非 500（细优② 端点依赖没漏）`, `status=${nc.status} ${(nc.body || '').slice(0, 120)}`);
    check(nc.status === 409, `[写] notify-creator PENDING_ASSIGN → 409 状态闸门（仅 FIXED/REFIXED 可发）`, `status=${nc.status}`);
    const voidRes = await req('POST', '/api/corrections/' + newId + '/void', { void_reason: 'E2E 冒烟测试清理' });
    check(voidRes.status !== 500, `[写] POST void 作废清理 #${newId} 非 500（流转端点依赖没漏）`, `status=${voidRes.status} ${(voidRes.body || '').slice(0, 100)}`);
  }

  const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(log);
  check(!crashed, '服务日志无 ReferenceError/TypeError（注入完整）', crashed ? log.slice(-300) : '');

  console.log(`\n${fail === 0 ? '✅' : '✗'} M-2 端点冒烟：${pass} 通过 / ${fail} 失败`);
  server.kill('SIGKILL');
  await sleep(300);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ e2e 异常：', e.message); server.kill('SIGKILL'); process.exit(1); });
