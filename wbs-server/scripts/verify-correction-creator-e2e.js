// verify-correction-creator-e2e.js — 细优② K4 creator 端点四件套 e2e（真实 server + seed FIXED 单）
//   验 notify-creator：① FIXED 单有效 created_by → 落库（本地无钉钉配置多为 failed；有配置+phone 可能 sent）
//                       ② created_by 指向不存在用户 → not_found 落库（R-M4 脏数据兜底）
//                       ③ 详情响应含 creator 5 字段（R-M3 返回面完整）
//   本地无钉钉配置 → 真发 sent / already_sent / read-status creator 留部署后生产实测。
//   seed：直接 INSERT 2 个 FIXED 单（绕过流转，只测 notify-creator 落库分支）；测后按 location_info 清理。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const T_ADMIN = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

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
let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  OK ' + label); pass++; } else { console.log('  FAIL ' + label + ' — ' + (detail || '')); fail++; } };

let server = null, idValid = null, idGhost = null;
async function seed() {
  const r1 = await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, status, correction_type, created_by, created_by_name) VALUES ('BMS','E2Ecreator 有效 created_by','E2E','FIXED','single',1,'admin')`);
  idValid = r1.lastID;
  const r2 = await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, status, correction_type, created_by, created_by_name) VALUES ('BMS','E2Ecreator 脏数据 created_by','E2E','FIXED','single',999999,'幽灵用户')`);
  idGhost = r2.lastID;
}
async function cleanup() {
  for (let i = 0; i < 6; i++) {
    try {
      await run("DELETE FROM correction_status_history WHERE correction_request_id IN (SELECT id FROM correction_requests WHERE location_info LIKE 'E2Ecreator%')");
      await run("DELETE FROM correction_requests WHERE location_info LIKE 'E2Ecreator%'");
      break;
    } catch (_) { await sleep(300); }
  }
}

(async () => {
  console.log('=== 细优② K4 creator 端点四件套 e2e（seed FIXED 单）===\n');
  await seed();
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..') });
  let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
  for (let i = 0; i < 40; i++) { const v = await req(T_ADMIN, 'GET', '/api/version'); if (v.status === 200) break; await sleep(250); }
  await sleep(1000);

  try {
    // T1: 有效 created_by → notify-creator → 端点+权限+闸门通过 + 四件套落库
    const n1 = await req(T_ADMIN, 'POST', '/api/corrections/' + idValid + '/notify-creator', {});
    check(n1.status !== 500 && n1.status !== 403 && n1.status !== 409, `notify-creator FIXED 有效 created_by 非 500/403/409（端点+权限+FIXED 闸门通过）`, `status=${n1.status} ${(n1.body || '').slice(0, 120)}`);
    const row1 = await get('SELECT creator_notify_status, creator_notified_at FROM correction_requests WHERE id=?', [idValid]);
    check(row1 && row1.creator_notify_status && row1.creator_notify_status !== 'not_sent' && !!row1.creator_notified_at,
      `四件套落库：creator_notify_status 已落（${row1 && row1.creator_notify_status}，本地无钉钉配置多为 failed）+ notified_at 写入`, JSON.stringify(row1));

    // T2: created_by 指向不存在用户 → not_found 落库（R-M4）
    const n2 = await req(T_ADMIN, 'POST', '/api/corrections/' + idGhost + '/notify-creator', {});
    const row2 = await get('SELECT creator_notify_status, creator_notify_error FROM correction_requests WHERE id=?', [idGhost]);
    check(row2 && row2.creator_notify_status === 'failed' && /not_found/.test(row2.creator_notify_error || ''),
      `R-M4：created_by 不存在 → creator_notify_status='failed' + error='not_found'（MS-M1 对齐 dev/relay，前端 failed 分支统一展示）`, JSON.stringify(row2) + ' http=' + n2.status);

    // T3: 详情响应含 creator 5 字段（R-M3，SELECT * 返回面）
    const d1 = await req(T_ADMIN, 'GET', '/api/corrections/' + idValid);
    const rq = jparse(d1.body).request || jparse(d1.body) || {};
    const cols5 = ['creator_notify_status', 'creator_notified_at', 'creator_notify_message_key', 'creator_notify_error', 'creator_read_at'];
    const has5 = cols5.every(k => k in rq);
    check(d1.status === 200 && has5, `R-M3：详情响应含 creator 5 字段`, `status=${d1.status} creator字段=${Object.keys(rq).filter(k => k.startsWith('creator')).join(',')}`);

    // T4: read-status creator 端点可达（无 sent 时返 NOT_NOTIFIED/400，非 500/403=映射+权限通过）
    const rs = await req(T_ADMIN, 'GET', '/api/corrections/' + idValid + '/notify-read-status?recipient=creator');
    check(rs.status !== 500 && rs.status !== 403, `read-status?recipient=creator 非 500/403（READ_FIELD_MAP.creator + 权限映射通过）`, `status=${rs.status} ${(rs.body || '').slice(0, 100)}`);

    const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(log);
    check(!crashed, '服务日志无 ReferenceError/TypeError', crashed ? log.slice(-300) : '');
  } finally {
    if (server) server.kill('SIGKILL');
    await sleep(800);
    await cleanup();
    db.close();
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} creator e2e：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('e2e 异常：', e.message); if (server) server.kill('SIGKILL'); await sleep(800); try { await cleanup(); } catch (_) {} db.close(); process.exit(1); });
