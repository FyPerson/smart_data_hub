/**
 * #106 S8b 演练：用「本地生产备份副本」演练部署的三种失败情况（备份失败 / 启动失败 / 就绪超时），不进 FAMILY、不进验收清单
 * （依赖本机的生产备份文件，耗时长；演练产物只是一张结果表，不是回归测试）。
 *
 * 用法：node wbs-server/scripts/drill-deploy-failures.js --source-db <生产备份文件>
 *   --source-db 没有缺省值。源文件白名单：realpath 的父目录必须是「本检出根/生产数据库备份」（realpath、大小写不敏感），否则拒绝（退出码 2）；
 *   另拒绝与 wbs-server 下任何位置（递归枚举；跳过 node_modules，不跟随目录符号链接 / 联接）的 .db 文件同 dev+ino 的源文件（硬链接）；
 *   枚举过程任一出错也拒绝运行（退出码 2）。检查只做 realpath / stat 元数据，不读文件内容，先于一切读取 / 复制。
 *   本文件可被 require（自检用）：只导出 checkSource / enumerateDbFiles，不执行 main。
 *   不再求「业务库路径」做黑名单：业务库不在备份目录里，白名单比黑名单可靠。
 *
 * 源文件保护：开始前算源文件 sha256 / mtime / 大小，结束后再算一遍，必须不变（两次都打印）。源文件只被复制到 os.tmpdir() 下自建目录，
 *   演练只用副本；备份脚本与测试实例启动器拿到的都是副本路径。
 *
 * 场景：
 *   A 备份成功（对照）：对副本跑 scripts/deploy/backup-db.js（--sqlite3 指向 wbs-server/node_modules/sqlite3）→ BACKUP_OK，核心表行数 > 0；记录耗时（估计生产停服时长里备份这一段）。
 *   B 备份失败：再复制一份并改写中间一半的页 → BACKUP_FAIL，错误码属于 S8a 固定集合，最终文件不存在。
 *   C 启动失败：取一个保留后立即释放的空闲端口，ready-check.js 对它 → READY_FAIL，lastObserved 为连接错误（ECONNREFUSED）。
 *   D 就绪超时：startTestInstance({ sourceDbPath: <副本>, sourceEncryptionKey: null, modules: 'all' }) 起隔离实例，
 *     D1 生产缺省期望（mode normal 等）→ READY_FAIL，不符字段含 mode / external / background / instance；
 *     D2 期望值改为该实例的实际值、--expect-commit 故意给错 → READY_FAIL，不符字段只有 commit；
 *     D3（正向对照）期望全部改为该实例实际值（commit = 本检出 HEAD，version = wbs-server/package.json），--pages-from-commit <HEAD> → READY_OK。
 *     结束 stop()（启动器自己的目录由 stop() 清理）。
 * 输出：结果表（场景 | 期望 | 实际 | 结果），最后一行 `DRILL PASS=<n> FAIL=<m>`；有失败退出码 1。结束删除自建临时目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { listenOnSafePort } = require('./lib/listen-safe-port');
const { startTestInstance } = require('./lib/test-instance');

const WBS_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(WBS_DIR, '..');
const BACKUP_JS = path.join(REPO_DIR, 'scripts', 'deploy', 'backup-db.js');
const READY_JS = path.join(REPO_DIR, 'scripts', 'deploy', 'ready-check.js');
const SQLITE3_DIR = path.join(WBS_DIR, 'node_modules', 'sqlite3');
const BACKUP_DIR_NAME = '生产数据库备份';
const BK_CODES = ['BK_ARGS', 'BK_SQLITE_LOAD', 'BK_SOURCE_MISSING', 'BK_OUT_EXISTS', 'BK_VACUUM_FAILED', 'BK_INTEGRITY_FAILED', 'BK_CORE_TABLE_MISSING', 'BK_CORE_TABLE_EMPTY', 'BK_TABLE_COUNT_MISMATCH', 'BK_PUBLISH_FAILED'];

const rows = [];
let pass = 0;
let fail = 0;
function record(scenario, expected, actual, ok) {
  rows.push({ scenario, expected, actual, ok });
  if (ok) pass += 1; else fail += 1;
}

function cleanEnv() {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)$/i.test(k) || /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete env[k];
  }
  return env;
}

function git(...args) {
  return execFileSync('git', ['-C', REPO_DIR, ...args], { env: cleanEnv(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function run(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    let killed = false;
    const killer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      const lines = stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
      const last = lines.length ? lines[lines.length - 1] : '';
      const m = /^([A-Z_]+) (\{.*\})$/.exec(last);
      let json = null;
      if (m) { try { json = JSON.parse(m[2]); } catch (_) { json = null; } }
      resolve({ status: killed ? 'KILLED' : code, kind: m ? m[1] : null, json, last });
    });
  });
}

// ---------------------------------------------------------------- 源文件保护

/** 路径比较键：realpath（解开符号链接 / 目录联接 / 8.3 短名等）；Windows 下不分大小写 */
function realKey(p) {
  const r = fs.realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

const DB_ENUM_LIMIT = 500000;   // 枚举 wbs-server 时最多看这么多个目录项，超出按「无法完成枚举」拒绝

/**
 * 递归枚举 rootDir 下全部 .db 文件（名字以 .db 结尾，不分大小写）。规则：
 *   - 跳过名为 node_modules 的目录；
 *   - 不跟随目录符号链接 / 目录联接（用 lstat 判断，Windows 的联接也报 isSymbolicLink）——所以不会绕圈；
 *   - 指向文件的符号链接，名字是 .db 的算候选（用 stat 取目标身份）；悬空链接（ENOENT）跳过；
 *   - 任何其他读目录 / lstat / stat 错误都向上抛——调用方据此拒绝运行（无法完成必要的身份检查）。
 * fsImpl 默认真实 fs（自检注入假 fs）。
 */
function enumerateDbFiles(rootDir, fsImpl) {
  const f = fsImpl || fs;
  const found = [];
  const stack = [rootDir];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of f.readdirSync(dir)) {
      seen += 1;
      if (seen > DB_ENUM_LIMIT) throw new Error(`目录项超过 ${DB_ENUM_LIMIT}，无法完成枚举`);
      const full = path.join(dir, name);
      const l = f.lstatSync(full);
      if (l.isSymbolicLink()) {
        let t = null;
        try { t = f.statSync(full); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
        if (t.isFile() && /\.db$/i.test(name)) found.push(full);
        continue;
      }
      if (l.isDirectory()) {
        if (name.toLowerCase() !== 'node_modules') stack.push(full);
        continue;
      }
      if (l.isFile() && /\.db$/i.test(name)) found.push(full);
    }
  }
  return found;
}

/**
 * 源文件白名单（只做 realpath / stat 元数据检查，不读文件内容；先于一切读取与复制）：
 *   1 源文件 realpath 的父目录必须等于「本检出根/生产数据库备份」的 realpath（大小写不敏感）。业务库不在这个目录里，所以白名单比黑名单可靠，
 *     符号链接 / 目录联接 / UNC / 大小写 / `..` / `::$DATA` 之类的写法都在 realpath 这一步被还原后落在目录之外而被拒绝。
 *   2 另拒绝与 wbs-server 目录下任何位置（递归，规则见 enumerateDbFiles）的 .db 文件同 dev+ino 的源文件（备份目录里放了业务库的硬链接）：
 *     只比较身份，不写业务库文件名。枚举过程任一出错，或源文件身份取不到（ino 为 0），一律拒绝运行。
 * opts = { repoDir, wbsDir, fsImpl } 缺省取本检出与真实 fs（自检在 os.tmpdir() 下自建假 wbs-server 树与备份目录，经导出的本函数验证，不碰真实库）。
 * 返回 null = 放行；{ usage } = 源文件不存在（用法错误）；{ refuse } = 拒绝原因。
 */
function checkSource(source, opts) {
  const o = opts || {};
  const repoDir = o.repoDir || REPO_DIR;
  const wbsDir = o.wbsDir || WBS_DIR;
  const f = o.fsImpl || fs;
  let real;
  try { real = f.realpathSync.native(source); } catch (_) { return { usage: `源文件不存在：${source}` }; }
  let allowed;
  try { allowed = realKey(path.join(repoDir, BACKUP_DIR_NAME)); } catch (_) { return { refuse: `本检出下没有 ${BACKUP_DIR_NAME}/ 目录，无法确认源文件是生产备份` }; }
  const parent = process.platform === 'win32' ? path.dirname(real).toLowerCase() : path.dirname(real);
  if (parent !== allowed) return { refuse: `源文件不在本检出的 ${BACKUP_DIR_NAME}/ 目录下（realpath：${real}）` };
  let st;
  try { st = f.statSync(real, { bigint: true }); } catch (_) { return { usage: `无法读取源文件元数据：${real}` }; }
  if (!st.isFile()) return { usage: `源路径不是文件：${real}` };
  if (st.ino === 0n) return { refuse: '取不到源文件的身份（ino 为 0），无法确认它不是业务库的硬链接' };
  let candidates;
  try { candidates = enumerateDbFiles(wbsDir, f); } catch (e) { return { refuse: `无法完成 wbs-server 下 .db 文件的枚举（${(e && e.code) || ''} ${String(e && e.message).slice(0, 120)}），拒绝运行` }; }
  for (const c of candidates) {
    let other;
    try { other = f.statSync(c, { bigint: true }); } catch (e) { return { refuse: `无法读取 ${c} 的身份（${(e && e.code) || ''}），拒绝运行` }; }
    if (other.isFile() && other.ino !== 0n && other.dev === st.dev && other.ino === st.ino) {
      return { refuse: `源文件与 wbs-server 下的 ${path.relative(wbsDir, c)} 是同一个文件（dev+ino 相同，硬链接）` };
    }
  }
  return null;
}

function fingerprint(file) {
  const st = fs.statSync(file);
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs, size: st.size };
}

function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return; }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const n of fs.readdirSync(p)) removeTree(path.join(p, n));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

// ---------------------------------------------------------------- 场景

async function scenarioA(tmp, copyA) {
  const out = path.join(tmp, 'A-out', 'backup.sqlite');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const r = await run(BACKUP_JS, ['--sqlite3', SQLITE3_DIR, '--db', copyA, '--out', out], 600000);
  const ms = Date.now() - t0;
  const core = r.json && r.json.core;
  const coreOk = !!core && Object.values(core).length > 0 && Object.values(core).every((n) => n > 0);
  const ok = r.status === 0 && r.kind === 'BACKUP_OK' && coreOk && fs.existsSync(out) && !fs.existsSync(`${out}.partial`);
  record('A 备份成功（对照）', 'BACKUP_OK、退出码 0、核心表行数 > 0、out 存在、无 .partial',
    `${r.kind || r.last}、退出码 ${r.status}、核心表 ${JSON.stringify(core)}、表 ${r.json && r.json.tables}、${r.json && r.json.bytes} 字节、耗时 ${ms} ms（备份阶段，估计的生产停服时长里的这一段）`, ok);
}

async function scenarioB(tmp, copyB) {
  const size = fs.statSync(copyB).size;
  const PAGE = 4096;
  const from = Math.max(PAGE, Math.floor(size * 0.25 / PAGE) * PAGE);
  const to = Math.floor(size * 0.75 / PAGE) * PAGE;
  if (size < 16 * PAGE || to <= from) { record('B 备份失败', '造出损坏副本', `副本太小（${size} 字节），无法造损坏`, false); return; }
  const fd = fs.openSync(copyB, 'r+');
  try {
    const block = Buffer.alloc(PAGE, 0xff);
    for (let off = from; off < to; off += PAGE) fs.writeSync(fd, block, 0, PAGE, off);
  } finally {
    fs.closeSync(fd);
  }
  const out = path.join(tmp, 'B-out', 'backup.sqlite');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await run(BACKUP_JS, ['--sqlite3', SQLITE3_DIR, '--db', copyB, '--out', out], 600000);
  const code = r.json && r.json.code;
  const ok = r.status === 1 && r.kind === 'BACKUP_FAIL' && BK_CODES.includes(code) && !fs.existsSync(out);
  record('B 备份失败（副本中间一半的页被改写）', 'BACKUP_FAIL、退出码 1、错误码属于固定集合、最终文件不存在',
    `${r.kind || r.last}、退出码 ${r.status}、code=${code}、stage=${r.json && r.json.stage}、out 存在=${fs.existsSync(out)}、.partial 残留=${fs.existsSync(`${out}.partial`)}`, ok);
}

async function scenarioC(commit, version) {
  const s = http.createServer(() => {});
  await listenOnSafePort(s);
  const port = s.address().port;
  await new Promise((resolve) => s.close(() => resolve()));
  const r = await run(READY_JS, ['--base-url', `http://127.0.0.1:${port}`, '--expect-commit', commit, '--expect-version', version, '--pages-from-commit', commit, '--timeout-sec', '10', '--interval-ms', '500'], 120000);
  const lo = r.json && r.json.lastObserved;
  const ok = r.status === 1 && r.kind === 'READY_FAIL' && !!r.json && r.json.code === 'READY_TIMEOUT' && !!lo && lo.stage === 'version' && lo.error === 'ECONNREFUSED';
  record('C 启动失败（端口无人监听）', 'READY_FAIL、退出码 1、READY_TIMEOUT、lastObserved 为 version 阶段的连接错误 ECONNREFUSED',
    `${r.kind || r.last}、退出码 ${r.status}、code=${r.json && r.json.code}、轮数 ${r.json && r.json.rounds}、耗时 ${r.json && r.json.elapsedMs} ms、lastObserved=${JSON.stringify(lo)}`, ok);
}

async function scenarioD(copyD, commit, version) {
  let inst = null;
  try {
    const t0 = Date.now();
    inst = await startTestInstance({ sourceDbPath: copyD, sourceEncryptionKey: null, modules: 'all', readyTimeoutMs: 240000 });
    const v = inst.version || {};
    console.log(`测试实例已就绪（${Date.now() - t0} ms）：${inst.baseUrl}，/api/version = ${JSON.stringify({ version: v.version, mode: v.mode, instance: v.instance, external: v.external, background: v.background, commit: v.commit })}`);
    const common = (c, extra, timeoutSec) => ['--base-url', inst.baseUrl, '--expect-commit', c, '--expect-version', version, '--pages-from-commit', commit, '--timeout-sec', String(timeoutSec || 4), '--interval-ms', '500'].concat(extra || []);
    const actualExpect = ['--expect-mode', String(v.mode), '--expect-external', String(v.external), '--expect-background', String(v.background), '--expect-instance', v.instance === null ? 'null' : String(v.instance)];
    const fieldsOf = (r) => ((r.json && r.json.lastObserved && r.json.lastObserved.mismatches) || []).map((m) => m.field).sort();

    // D1 生产缺省期望
    const r1 = await run(READY_JS, common(commit), 120000);
    const f1 = fieldsOf(r1);
    const want1 = ['background', 'external', 'instance', 'mode'];
    record('D1 就绪超时：生产缺省期望对隔离实例', `READY_FAIL、退出码 1、不符字段含 ${want1.join(' / ')}`,
      `${r1.kind || r1.last}、退出码 ${r1.status}、stage=${r1.json && r1.json.lastObserved && r1.json.lastObserved.stage}、不符字段 ${JSON.stringify(f1)}`,
      r1.status === 1 && r1.kind === 'READY_FAIL' && want1.every((f) => f1.includes(f)));

    // D2 期望值 = 实际值，commit 故意给错
    const wrong = commit.slice(0, -1) + (commit.endsWith('0') ? '1' : '0');
    const r2 = await run(READY_JS, common(wrong, actualExpect), 120000);
    const f2 = fieldsOf(r2);
    record('D2 就绪超时：只有 commit 不符', 'READY_FAIL、退出码 1、不符字段只有 commit',
      `${r2.kind || r2.last}、退出码 ${r2.status}、不符字段 ${JSON.stringify(f2)}`,
      r2.status === 1 && r2.kind === 'READY_FAIL' && f2.length === 1 && f2[0] === 'commit');

    // D3 正向对照
    const r3 = await run(READY_JS, common(commit, actualExpect, 60), 240000);
    record('D3 正向对照：期望全部等于实例实际值', 'READY_OK、退出码 0、页面数 > 0（HTML 指纹注入正常：无页面含 ?v=auto）',
      `${r3.kind || r3.last}、退出码 ${r3.status}、${r3.json ? `轮数 ${r3.json.rounds}、页面 ${r3.json.pages}、耗时 ${r3.json.elapsedMs} ms` : ''}${r3.json && r3.json.lastObserved ? `、lastObserved=${JSON.stringify(r3.json.lastObserved)}` : ''}`,
      r3.status === 0 && r3.kind === 'READY_OK' && !!r3.json && r3.json.pages > 0);
  } catch (e) {
    record('D 起隔离实例', '实例就绪', `失败：${String(e && e.message).slice(0, 300)}`, false);
  } finally {
    if (inst) {
      try { await inst.stop(); } catch (e) { record('D 停实例', 'stop() 成功', `失败：${String(e && e.message).slice(0, 300)}`, false); }
    }
  }
}

// ---------------------------------------------------------------- 主流程

function usage(msg) {
  console.log(`DRILL 用法错误：${msg}`);
  console.log('用法：node wbs-server/scripts/drill-deploy-failures.js --source-db <生产备份文件>');
  process.exitCode = 2;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--source-db' || argv[1] === '' || argv[1].startsWith('--')) return usage('必须且只能给 --source-db <文件>（没有缺省值）');
  const source = path.resolve(argv[1]);
  // 源文件白名单：只做 realpath / stat 元数据检查，不读文件内容
  const verdict = checkSource(source);
  if (verdict !== null && verdict.usage) return usage(verdict.usage);
  if (verdict !== null) {
    console.log(`DRILL 拒绝：${verdict.refuse}：${source}`);
    process.exitCode = 2;
    return;
  }

  const commit = git('rev-parse', 'HEAD').trim();
  const version = JSON.parse(fs.readFileSync(path.join(WBS_DIR, 'package.json'), 'utf8')).version;
  const before = fingerprint(source);
  console.log(`源文件：${source}`);
  console.log(`  前 sha256=${before.sha256} mtime=${before.mtime} 大小=${before.size}`);
  console.log(`检出 HEAD=${commit} version=${version}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-drill-'));
  try {
    const copyA = path.join(tmp, 'copy-A.sqlite');
    const copyB = path.join(tmp, 'copy-B.sqlite');
    const copyD = path.join(tmp, 'copy-D.sqlite');
    for (const c of [copyA, copyB, copyD]) fs.copyFileSync(source, c);
    await scenarioA(tmp, copyA);
    await scenarioB(tmp, copyB);
    await scenarioC(commit, version);
    await scenarioD(copyD, commit, version);
  } catch (e) {
    record('演练自身', '无异常', `异常：${String(e && e.stack).slice(0, 500)}`, false);
  } finally {
    try { removeTree(tmp); } catch (e) { record('清理临时目录', '删净', `失败：${e && e.message}`, false); }
    if (fs.existsSync(tmp)) record('清理临时目录', '删净', `仍存在：${tmp}`, false);
  }

  const after = fingerprint(source);
  console.log(`  后 sha256=${after.sha256} mtime=${after.mtime} 大小=${after.size}`);
  record('源文件不变', 'sha256、mtime、大小前后一致', `sha256 ${after.sha256 === before.sha256 ? '一致' : '不一致'}、mtime ${after.mtimeMs === before.mtimeMs ? '一致' : '不一致'}、大小 ${after.size === before.size ? '一致' : '不一致'}`,
    after.sha256 === before.sha256 && after.mtimeMs === before.mtimeMs && after.size === before.size);

  console.log('\n| 场景 | 期望 | 实际 | 结果 |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.scenario} | ${r.expected} | ${r.actual} | ${r.ok ? '通过' : '失败'} |`);
  console.log(`DRILL PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.log(`DRILL 异常：${e && e.stack}`);
    process.exitCode = 1;
  });
}
module.exports = { checkSource, enumerateDbFiles };
