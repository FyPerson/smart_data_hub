// _seed-liaison-observe-20260806.js — S12b 长任务停点交付物：6 张观察测试单（临时脚本·未跟踪工具脚本）
//
// 用法：node scripts/_seed-liaison-observe-20260806.js
//
// 幂等：脚本开头按 title LIKE '测试观察%' 找旧种子单 → 三表清理（sys_issue_timeline/
//   sys_issue_dev_assignees/sys_issues，另附带清 sys_issue_dev_commits/sys_issue_dev_events 防孤儿行
//   累积，本次场景均不产生 commit 行，纯防御） → 走真实 API 重建。
//
// ⚠️ 本地库钉钉凭证已被置换为占位值（观察期防真发兜底）——脚本不碰 system_configs 表，只在尾部
//   SELECT 一次 sys_notify_dry_run 键是否存在（不解密核值）。
//
// 6 张单场景（详见任务 spec）：
//   O1 受理弹窗观察（feature·待受理·建单即停）
//   O2 通知演练（feature·待对接测试·周期1·走完整链路自动落）
//   O3 打回链路（feature·待对接测试·周期1·同 O2 链，留给用户手动 liaison_test_return）
//   O4 降级观察（feature·开发中·SQL 模拟对接人快照已失效，留给用户手动 submit 观察自愈/⑥路径）
//   O5 对照组（improvement·待受理·建单即停）——⚠️[2026-08-06 批1改造B 收口] 原设计意图=对照
//     "improvement 受理弹窗无 risk_level 控件"；改造B 后 improvement 与 feature 对齐必填风险等级，
//     该对照前提已不成立（点开 O5 的受理弹窗现会看到与 feature 相同的风险等级下拉，默认选中"三级"）。
//     保留该单不变（仍便于观察 improvement 类型建单即停后的基本形态），仅更正本注释与下方建单描述的
//     过时表述——真正"无 risk_level 控件"的对照组现在唯一是 bug 类型（未单独造观察单，T6 测试套件
//     已覆盖该断言）。
//   O6 完成态（feature·待验证·同 O2 链 + liaison_test_pass）
'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// [批1改造收口·2026-08-06] 支持 SEED_PORT 覆盖——默认仍 3000；当 3000 上跑着的 server 进程加载的是
//   改造前的旧后端代码（Node require() 不热更新路由模块，静态页面文件改了即生效，但 routes/*.js 这类
//   后端逻辑改动必须重启进程才生效）时，可指向一个临时端口的新实例来重跑种子，不去碰用户正在观察、
//   明确要求不可重启/杀掉的 3000 进程。
const PORT = Number(process.env.SEED_PORT) || 3000;
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('❌ 未读到 JWT_SECRET（.env）'); process.exit(1); }
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const db = new sqlite3.Database(DB_PATH);
db.configure('busyTimeout', 5000);   // 与真实 server 进程共用同一 db 文件时，写锁竞争走重试而非立即报错
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tok = (id, name, role) => jwt.sign({ id, username: 'u' + id, display_name: name, role }, SECRET, { expiresIn: '2h' });
const ADMIN = tok(1, '管理员', 'admin');
const DEV_ID = 8;
const DEV_NAME = '示例开发A';
const DEV = tok(DEV_ID, DEV_NAME, 'user');
const LIAISON_ID = 13;   // 示例对接人，唯一受理人白名单成员（SYS_INTAKE_LIAISON_IDS）
const LIAISON_NAME = '示例对接人';

const TITLE_PREFIX = '测试观察';
const ok = (m) => console.log('  ✓ ' + m);

function call(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api' + p, method,
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        let j = null;
        try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.slice(0, 300) }; }
        resolve({ status: r.statusCode, body: j });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function must(r, expect, what) {
  if (r.status !== expect) throw new Error(`${what} 期望 ${expect} 实得 ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
function futureEstimate(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── server 探测 / 自起（已有 server 就复用不 kill；自己 spawn 的跑完精确按 PID kill，不碰其他 node 进程）──
function probeVersion() {
  return new Promise((resolve) => {
    const r = http.get(`http://127.0.0.1:${PORT}/api/version`, { timeout: 2000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(res.statusCode === 200));
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}
async function ensureServerRunning() {
  if (await probeVersion()) {
    console.log(`  探测到 127.0.0.1:${PORT} 已有 server 在跑，复用（不自行 spawn，跑完不 kill）`);
    return { proc: null, spawnedByScript: false };
  }
  console.log(`  127.0.0.1:${PORT} 无响应，自行 spawn server...`);
  const proc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) } });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (await probeVersion()) { ready = true; break; }
    await sleep(300);
  }
  if (!ready) {
    proc.kill('SIGKILL');
    throw new Error(`server 60 次探测(18s)内未就绪，最近日志：\n${log.slice(-800)}`);
  }
  await sleep(800);   // sys-iteration 等模块 schema readiness 收尾缓冲
  return { proc, spawnedByScript: true };
}

// ── 幂等清理：按 title 前缀找旧种子单，三表清理（+ 防御性附带两张 dev 子表）──
async function preClean() {
  const rows = await all(`SELECT id, title FROM sys_issues WHERE title LIKE ?`, [TITLE_PREFIX + '%']);
  if (!rows.length) { console.log('  无旧种子单需清理'); return; }
  console.log('清理旧种子单（删前清单）：');
  rows.forEach((r) => console.log(`   #${r.id} ${r.title}`));
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  await run(`DELETE FROM sys_issue_dev_commits WHERE issue_id IN (${ph})`, ids);
  await run(`DELETE FROM sys_issue_dev_events WHERE issue_id IN (${ph})`, ids);
  await run(`DELETE FROM sys_issue_dev_assignees WHERE issue_id IN (${ph})`, ids);
  await run(`DELETE FROM sys_issue_timeline WHERE issue_id IN (${ph})`, ids);
  await run(`DELETE FROM sys_issues WHERE id IN (${ph})`, ids);
  console.log(`  已清理 ${rows.length} 张旧种子单`);
}

async function createIssue(type, titleSuffix, description) {
  const body = await must(await call('POST', '/sys-issues', ADMIN, {
    intake_contract_version: 2, type, title: TITLE_PREFIX + titleSuffix,
    system_name: 'BMS', source: '内部', description, intake_liaison_id: LIAISON_ID,
  }), 201, `建单(${titleSuffix})`);
  return body.id;
}

// 走完整链路到「待对接测试」的共用序列（O2/O3/O6 共用）：受理(risk)→补OA号→指派→预计→提交(no_code双勾)
async function driveToLiaisonTest(id, riskLevel, oaNumber, label) {
  await must(await call('POST', `/sys-issues/${id}/intake-accept`, ADMIN, { risk_level: riskLevel }), 200, `${label} 受理`);
  await must(await call('POST', `/sys-issues/${id}/set-oa-number`, ADMIN, { oa_number: oaNumber }), 200, `${label} 补OA号`);
  await must(await call('POST', `/sys-issues/${id}/assign`, ADMIN, { assigned_to: DEV_ID }), 200, `${label} 指派`);
  await must(await call('POST', `/sys-issues/${id}/estimate`, DEV, { dev_estimated_at: futureEstimate(20) }), 200, `${label} 预计`);
  const sub = await must(await call('POST', `/sys-issues/${id}/submit`, DEV, {
    mode: 'no_code', no_code_reason: '观察单据，无代码提交', self_tested: true, test_env_deployed: true,
  }), 200, `${label} 提交`);
  if (sub.main_status !== '待对接测试') {
    throw new Error(`${label} 提交后应落待对接测试，实得 ${sub.main_status}（${JSON.stringify(sub)}）`);
  }
  return sub;
}

async function assertIssue(id, expect, label) {
  const row = await get(`SELECT * FROM sys_issues WHERE id = ?`, [id]);
  if (!row) throw new Error(`${label} #${id} 查无此单`);
  const devRows = await all(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
  const printed = [];
  const chk = (name, actual, exp) => {
    printed.push(`${name}=${JSON.stringify(actual)}`);
    if (actual !== exp) {
      throw new Error(`${label} #${id} 断言失败：${name} 期望 ${JSON.stringify(exp)} 实得 ${JSON.stringify(actual)}`);
    }
  };
  if ('status' in expect) chk('status', row.status, expect.status);
  if ('risk_level' in expect) chk('risk_level', row.risk_level, expect.risk_level);
  if ('liaison_test_cycle_no' in expect) chk('liaison_test_cycle_no', row.liaison_test_cycle_no, expect.liaison_test_cycle_no);
  if ('liaison_test_notify_status' in expect) chk('liaison_test_notify_status', row.liaison_test_notify_status, expect.liaison_test_notify_status);
  if ('liaison_test_recipient_id' in expect) chk('liaison_test_recipient_id', row.liaison_test_recipient_id, expect.liaison_test_recipient_id);
  if ('liaison_test_recipient_name' in expect) chk('liaison_test_recipient_name', row.liaison_test_recipient_name, expect.liaison_test_recipient_name);
  if ('dev_count' in expect) chk('dev_count', devRows.length, expect.dev_count);
  if ('dev_status_all' in expect) {
    const allMatch = devRows.length > 0 && devRows.every((r) => r.dev_status === expect.dev_status_all);
    chk('dev_status_all(' + expect.dev_status_all + ')', allMatch, true);
  }
  ok(`${label} #${id} 断言全过：${printed.join(' / ')}`);
}

async function main() {
  console.log('S12b 观察测试单种子脚本');
  console.log('  库:', DB_PATH);

  await preClean();
  const { proc, spawnedByScript } = await ensureServerRunning();

  const ids = {};
  try {
    // ── O1：feature，建单即停（待受理）──────────────────────────────
    ids.O1 = await createIssue('feature', 'O1-受理弹窗', 'S12b 观察单据：受理弹窗 risk_level 必选 + D15 行常驻，建单即停不再推进。');
    ok(`O1 #${ids.O1} 建单即停（待受理）`);

    // ── O2：feature，走完整链路自动落「待对接测试」·周期1 ──────────────
    ids.O2 = await createIssue('feature', 'O2-通知演练', 'S12b 观察单据：走完整链路进入待对接测试，观察通知演练列组（notify not_sent）。');
    await driveToLiaisonTest(ids.O2, '二级', '2026080601', 'O2');
    ok(`O2 #${ids.O2} 走通链路落「待对接测试」·周期1`);

    // ── O3：同 O2 链，独立单，留给用户手动打回观察 ──────────────────────
    ids.O3 = await createIssue('feature', 'O3-打回链路', 'S12b 观察单据：同 O2 链路，留给用户手动操作 liaison_test_return 观察打回链路（D18 不计数 + notify-developer failed 留痕）。');
    await driveToLiaisonTest(ids.O3, '二级', '2026080602', 'O3');
    ok(`O3 #${ids.O3} 走通链路落「待对接测试」·周期1（留给用户手动打回）`);

    // ── O4：受理+指派+预计，不提交，停在开发中，SQL 模拟对接人快照失效 ────
    ids.O4 = await createIssue('feature', 'O4-降级观察', 'S12b 观察单据：受理指派预计后不提交，停在开发中，SQL 模拟对接人快照已失效，留给用户提交后观察 D20 claim 自愈或⑥降级路径。');
    await must(await call('POST', `/sys-issues/${ids.O4}/intake-accept`, ADMIN, { risk_level: '一级' }), 200, 'O4 受理');
    await must(await call('POST', `/sys-issues/${ids.O4}/set-oa-number`, ADMIN, { oa_number: '2026080603' }), 200, 'O4 补OA号');
    await must(await call('POST', `/sys-issues/${ids.O4}/assign`, ADMIN, { assigned_to: DEV_ID }), 200, 'O4 指派');
    await must(await call('POST', `/sys-issues/${ids.O4}/estimate`, DEV, { dev_estimated_at: futureEstimate(20) }), 200, 'O4 预计');
    // ⚠️ 只动 O4 这一张单的快照列（liaison_test_recipient_id/_name），不碰其余任何行、不碰 status/cycle_no。
    const o4upd = await run(
      `UPDATE sys_issues SET liaison_test_recipient_id = 999999, liaison_test_recipient_name = '(失效占位·测试观察)' WHERE id = ?`,
      [ids.O4]
    );
    if (o4upd.changes !== 1) throw new Error(`O4 快照列 SQL 更新应影响 1 行，实得 ${o4upd.changes}`);
    ok(`O4 #${ids.O4} 停在开发中 + 快照列已置失效（liaison_test_recipient_id=999999）`);

    // ── O5：improvement，建单即停（对照组，无 risk_level 控件）──────────
    ids.O5 = await createIssue('improvement', 'O5-对照组', 'S12b 观察单据：improvement 对照组，建单即停。⚠️2026-08-06 批1改造B后，improvement 受理弹窗已同 feature 一样带风险等级必选控件（默认三级），原"无控件对照"设计前提已变——现可用于观察 improvement 侧的风险等级默认值体验；无测试段直落（待对接测试段仍 feature 独有）。');
    ok(`O5 #${ids.O5} 建单即停（待受理·improvement 对照组）`);

    // ── O6：同 O2 链 + liaison_test_pass → 待验证 ───────────────────────
    ids.O6 = await createIssue('feature', 'O6-完成态', 'S12b 观察单据：同 O2 链路 + liaison_test_pass，观察详情六时间点 + 实际完成列 + 风险等级 kv。');
    await driveToLiaisonTest(ids.O6, '二级', '2026080604', 'O6');
    // ⭐ [批2 D22-④ 收口] pass 现须凭证二选一，本单据用 test_note 路径（源码修正——本次批2不重跑本
    //   脚本，观察单 #2121-2126 按用户指示全程不动，此处只保证脚本源码未来重跑时仍正确）。
    const o6pass = await must(await call('POST', `/sys-issues/${ids.O6}/liaison-test-pass`, ADMIN, { test_note: '观察单据种子脚本：模拟测试通过' }), 200, 'O6 对接测试通过');
    if (o6pass.status !== '待验证') throw new Error(`O6 pass 后应落待验证，实得 ${o6pass.status}（${JSON.stringify(o6pass)}）`);
    ok(`O6 #${ids.O6} 走通链路 + liaison_test_pass 落「待验证」`);

    // ══════════════════════════════════════════════════════════════════
    // 尾部断言：逐单 SELECT 精确核对目标态关键列（全过才 exit 0）
    // ══════════════════════════════════════════════════════════════════
    console.log('\n── 尾部断言 ──');
    await assertIssue(ids.O1, {
      status: '待受理', risk_level: null, liaison_test_cycle_no: 0,
      liaison_test_notify_status: 'not_sent', dev_count: 0,
    }, 'O1');
    await assertIssue(ids.O2, {
      status: '待对接测试', risk_level: '二级', liaison_test_cycle_no: 1,
      liaison_test_notify_status: 'not_sent', liaison_test_recipient_id: LIAISON_ID,
      liaison_test_recipient_name: LIAISON_NAME, dev_count: 1,
    }, 'O2');
    await assertIssue(ids.O3, {
      status: '待对接测试', risk_level: '二级', liaison_test_cycle_no: 1,
      liaison_test_notify_status: 'not_sent', liaison_test_recipient_id: LIAISON_ID,
      liaison_test_recipient_name: LIAISON_NAME, dev_count: 1,
    }, 'O3');
    await assertIssue(ids.O4, {
      status: '开发中', risk_level: '一级', liaison_test_cycle_no: 0,
      liaison_test_notify_status: 'not_sent', liaison_test_recipient_id: 999999,
      liaison_test_recipient_name: '(失效占位·测试观察)', dev_count: 1, dev_status_all: 'pending',
    }, 'O4');
    await assertIssue(ids.O5, {
      status: '待受理', risk_level: null, liaison_test_cycle_no: 0,
      liaison_test_notify_status: 'not_sent', dev_count: 0,
    }, 'O5');
    await assertIssue(ids.O6, {
      status: '待验证', risk_level: '二级', liaison_test_cycle_no: 1,
      liaison_test_notify_status: 'not_sent', liaison_test_recipient_id: LIAISON_ID,
      liaison_test_recipient_name: LIAISON_NAME, dev_count: 1,
    }, 'O6');

    // system_configs 键存在性检查（不解密核值——本地钉钉凭证已置换占位值，脚本不写这张表）
    const cfg = await get(`SELECT config_key, updated_at FROM system_configs WHERE config_key = 'sys_notify_dry_run'`);
    console.log(`\n  system_configs.sys_notify_dry_run 键${cfg ? `存在（updated_at=${cfg.updated_at}）` : '不存在'}（脚本不解密核值、不写该表）`);

    console.log('\n══════════ 6 张观察单据一览 ══════════');
    for (const k of ['O1', 'O2', 'O3', 'O4', 'O5', 'O6']) console.log(`  ${k}=#${ids[k]}`);
    console.log('\n✅ 全部断言通过');
  } finally {
    if (spawnedByScript && proc) {
      proc.kill('SIGKILL');
      console.log(`\n已停止本次 spawn 的 server（PID ${proc.pid}）`);
    }
    db.close();
  }
}

main().catch((e) => {
  console.error('\n❌ 失败:', e && (e.stack || e.message));
  process.exitCode = 1;
});
