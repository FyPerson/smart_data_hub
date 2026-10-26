/**
 * #106 S8a 自检：部署备份脚本 scripts/deploy/backup-db.js 与发布记录 scripts/deploy/release-record.js。
 *
 * 全部在 os.tmpdir() 下自建的临时目录里跑（目录名带随机后缀，含「中文 空格」子目录），夹具库用 wbs-server/node_modules/sqlite3 现造；
 * 不读、不开任何业务库或备份目录下的文件，不读 .env，不起服务。备份脚本以子进程运行（execPath + 参数数组，不拼 shell 串）；
 * 发布记录的每次调用都带 --dir / dir 指向临时目录，绝不写真实控制根。
 *
 * 节：
 *   A  静态断言：backup-db.js 只 require 内置模块与 --sqlite3 变量；不用读写 / 建库打开模式；PRAGMA 只有 integrity_check；
 *      校验只打开 .partial（withDb(sqlite3, partial 恰 2 次、args.db 恰 1 次）；VACUUM INTO 用参数绑定；main 先置 exitCode = 1；发布后取大小不改变成功
 *   B  备份正常路径（中文 空格目录；out 存在、.partial 不存在、行数、备份可打开且 integrity ok、源库字节与目录不变；自定义 --core-tables；目录名含单引号与百分号）
 *   C  备份失败路径（源库不存在 / out 已存在 / .partial 已存在 / --sqlite3 错或是假模块 / 核心表缺失 / 核心表为空 / 源库损坏（非库文件、数据页被毁）/
 *      备份 integrity_check 非 ok（C8a FTS5 虚表只读残余、C8b 索引根页真实损坏）/ C10 源库有孤立页但备份是好的 → OK / C11 源库有热日志 / 参数错误若干）
 *      每个失败用例断言：退出码、stdout 以唯一协议行 + 恰好一个 \n 结尾、错误码、out 状态（不存在，或原字节不变）、.partial 的报告与实际一致、sourceJournal 字段
 *   D  发布竞态：VACUUM 期间有人在 out 位置放了文件 → link 失败（BK_PUBLISH_FAILED），原文件字节不变（不被覆盖）
 *   E  发布记录：init / 重复 init / stage 推进 / 未知阶段 / 不可变字段 / result 定稿后拒绝 / 无残留临时文件 / 坏 sha、id、版本 / latest / show / 命令行协议 /
 *      prevRunning.commit ≠ prevCommit 拒绝 / backup 与 attachments 只写一次 / result 与阶段一致 / 记录损坏 → RR_CORRUPT / stage 只经临时文件 + rename 写
 *   G  进程内：导出的探测函数用注入的假 fs 验证三态（true / false / "unknown"）与 BK_FS_ERROR（只有 ENOENT / ENOTDIR 算不存在）；
 *      checkCoreTables 对夹具库验证 __proto__ 同名表（空表必须失败、非空表计数正确）
 *   F  判别力（变异自证，默认运行）：在临时副本上改被测脚本，变异共 46 个，每个都必须让上面的套件变红，且命中它登记的期望用例名前缀；
 *      列出变异与变红的用例名；变异个数与本头注释、FAMILY 里 S8a 那段注释的数字互相核对
 *
 * 运行：node wbs-server/scripts/verify-deploy-backup.js
 *   内部参数（F 节递归调用自己用）：--deploy-dir=<被测 scripts/deploy 目录的绝对路径>  --no-mutations
 * 输出：失败用例逐行 `FAIL <名字> :: <细节>`；末行 `PASS=<n> FAIL=<m>`；有失败退出码 1。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { builtinModules } = require('module');
const { spawn, spawnSync } = require('child_process');

const sqlite3 = require(path.join(__dirname, '..', 'node_modules', 'sqlite3'));

const argOf = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const DEPLOY_ARG = argOf('--deploy-dir=');
const DEPLOY_DIR = path.resolve(DEPLOY_ARG ? DEPLOY_ARG.slice('--deploy-dir='.length) : path.join(__dirname, '..', '..', 'scripts', 'deploy'));
const RUN_MUTATIONS = !process.argv.includes('--no-mutations');
const ONLY_ARG = argOf('--only=');
const ONLY = ONLY_ARG === undefined ? null : new Set(ONLY_ARG.slice('--only='.length).split(''));   // F 节递归调用自己时只跑与该变异相关的节（静态检查 A 总是跑）；缺省全跑
const runSection = (letter) => ONLY === null || ONLY.has(letter);
const SQLITE3_DIR = path.resolve(__dirname, '..', 'node_modules', 'sqlite3');
const BACKUP_JS = path.join(DEPLOY_DIR, 'backup-db.js');
const RECORD_JS = path.join(DEPLOY_DIR, 'release-record.js');

// ---------------------------------------------------------------- 断言与汇总

let pass = 0;
let fail = 0;
const failedNames = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; return true; }
  fail += 1;
  failedNames.push(name);
  console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${String(detail).replace(/\s*[\r\n]+\s*/g, ' ')}`}`);
  return false;
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------- 临时目录

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-deploy-backup-'));
let seq = 0;
function freshDir(label) {
  seq += 1;
  const d = path.join(TMP_ROOT, `${label}-${seq}`, '中文 目录');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** 逐项 unlink / rmdir（链接只拆不跟随），不用 rmSync */
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

// ---------------------------------------------------------------- 夹具库

const openRw = (file) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (e) => (e ? reject(e) : resolve(db)));
});
const execSql = (db, sql) => new Promise((resolve, reject) => db.exec(sql, (e) => (e ? reject(e) : resolve())));
const allSql = (db, sql) => new Promise((resolve, reject) => db.all(sql, (e, rows) => (e ? reject(e) : resolve(rows))));
const closeDb = (db) => new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));

async function buildDb(file, sql) {
  const db = await openRw(file);
  try { await execSql(db, sql); } finally { await closeDb(db); }
}

const STANDARD_SQL = `
  CREATE TABLE task_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT);
  CREATE INDEX idx_task_status ON task_pool(status);
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE misc (k TEXT PRIMARY KEY, v TEXT);
  INSERT INTO task_pool (title, status) VALUES ('任务一', 'open'), ('任务二', 'done'), ('任务三', 'open');
  INSERT INTO users (name) VALUES ('甲'), ('乙');
  INSERT INTO misc VALUES ('a', '1');
`;
const STANDARD_TABLES = 4;   // task_pool、sqlite_sequence（AUTOINCREMENT 自动建）、users、misc

async function readCounts(file, tables) {
  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(e) : resolve(d)));
  });
  try {
    const out = {};
    for (const t of tables) out[t] = (await allSql(db, `SELECT count(*) AS n FROM "${t}"`))[0].n;
    out.__integrity = (await allSql(db, 'PRAGMA integrity_check')).map((r) => r.integrity_check);
    out.__tables = (await allSql(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"))[0].n;
    return out;
  } finally {
    await closeDb(db);
  }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 只读打开，返回 integrity_check 的全部行 */
async function integrityOf(file) {
  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => (e ? reject(e) : resolve(d)));
  });
  try { return (await allSql(db, 'PRAGMA integrity_check')).map((r) => r.integrity_check); } finally { await closeDb(db); }
}

/** 把索引 ix_title 根页里的 MARK0002 改成 MARX0002（只动那一页的一个字节）；找到并改写返回 true */
async function corruptIndexRoot(file) {
  const db = await openRw(file);
  let root;
  let pageSize;
  try {
    root = (await allSql(db, "SELECT rootpage AS p FROM sqlite_master WHERE name = 'ix_title'"))[0].p;
    pageSize = (await allSql(db, 'PRAGMA page_size'))[0].page_size;
  } finally {
    await closeDb(db);
  }
  const fd = fs.openSync(file, 'r+');
  try {
    const buf = Buffer.alloc(pageSize);
    fs.readSync(fd, buf, 0, pageSize, (root - 1) * pageSize);
    const at = buf.indexOf('MARK0002');
    if (at < 0) return false;
    buf[at + 3] = 'X'.charCodeAt(0);
    fs.writeSync(fd, buf, 0, pageSize, (root - 1) * pageSize);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** 孤立页：文件尾补一个零页，头偏移 28 的页数 +1（change counter 与 version-valid-for 不动，SQLite 仍信任头里的页数） */
function addOrphanPage(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(100);
    fs.readSync(fd, head, 0, 100, 0);
    const raw = head.readUInt16BE(16);
    const pageSize = raw === 1 ? 65536 : raw;
    const pages = head.readUInt32BE(28);
    fs.writeSync(fd, Buffer.alloc(pageSize), 0, pageSize, pages * pageSize);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(pages + 1, 0);
    fs.writeSync(fd, n, 0, 4, 28);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 造热日志：子进程以读写方式打开库，小缓存里开写事务并 UPDATE 全表（脏页溢出，日志先落盘），打印 READY 后被杀——
 * 日志留在库旁、数据库文件已被部分改写。返回 -journal 是否存在且非空。
 */
const HOT_CHILD = [
  'const sqlite3 = require(process.argv[1]);',
  'const db = new sqlite3.Database(process.argv[2], (e) => { if (e) { console.log("ERR " + e.message); process.exit(3); } });',
  'db.serialize(() => {',
  '  db.run("PRAGMA cache_size = 8");',
  '  db.run("BEGIN");',
  '  db.run("UPDATE task_pool SET v = randomblob(1000)", (e) => { console.log(e ? "ERR " + e.message : "READY"); });',
  '});',
  'setInterval(() => {}, 1000);',
].join('\n');

async function makeHotJournal(file) {
  const child = spawn(process.execPath, ['-e', HOT_CHILD, SQLITE3_DIR, file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.resume();
  const closed = new Promise((resolve) => child.on('close', () => resolve()));
  const deadline = Date.now() + 30000;
  while (!/READY|ERR/.test(out) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
  const ready = /READY/.test(out);
  child.kill();
  await closed;
  if (!ready) return false;
  try { return fs.statSync(`${file}-journal`).size > 0; } catch (_) { return false; }
}

// ---------------------------------------------------------------- 运行备份脚本

function parseProtocol(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
  const last = lines.length ? lines[lines.length - 1] : '';
  const m = /^(BACKUP_OK|BACKUP_FAIL) (\{.*\})$/.exec(last);
  let json = null;
  if (m) { try { json = JSON.parse(m[2]); } catch (_) { json = null; } }
  const protocolLines = lines.filter((l) => /^BACKUP_(OK|FAIL) /.test(l)).length;
  // 严格口径：stdout 以协议行结尾，协议行后恰好一个 \n（不是 \n\n，也不是 \r\n）
  const strictEnd = /(?:^|\n)BACKUP_(?:OK|FAIL) \{[^\n]*\}\n$/.test(String(stdout)) && !String(stdout).endsWith('\n\n');
  return { kind: m ? m[1] : null, json, protocolLines, strictEnd, last };
}

/** 每个用例都要过的协议断言：唯一协议行 + 严格的结尾（L2） */
function expectProtocolTail(name, r) {
  eq(`${name}: 协议行只有一条`, r.protocolLines, 1);
  check(`${name}: stdout 以唯一协议行 + 恰好一个 \\n 结尾`, r.strictEnd === true, JSON.stringify(String(r.stdout).slice(-60)));
}

function runBackup(args) {
  const r = spawnSync(process.execPath, [BACKUP_JS, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return Object.assign({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error }, parseProtocol(r.stdout));
}

const stdArgs = (db, out, extra) => ['--sqlite3', SQLITE3_DIR, '--db', db, '--out', out].concat(extra || []);

/** 失败用例的共同断言。outState: 'absent'（out 不存在）| {bytes: Buffer}（out 存在且字节不变） */
function expectFail(name, r, { status, code, outFile, outState, partialExpected }) {
  eq(`${name}: 退出码`, r.status, status);
  check(`${name}: 最后一行是 BACKUP_FAIL 协议`, r.kind === 'BACKUP_FAIL' && r.json !== null, r.last);
  expectProtocolTail(name, r);
  eq(`${name}: 错误码`, r.json && r.json.code, code);
  if (r.json) {
    check(`${name}: json 含 stage 与 message`, typeof r.json.stage === 'string' && r.json.stage !== '' && typeof r.json.message === 'string' && r.json.message !== '', JSON.stringify(r.json));
    check(`${name}: json 含 partial.path / partial.exists`, r.json.partial && typeof r.json.partial === 'object' && typeof r.json.partial.exists === 'boolean', JSON.stringify(r.json.partial));
    check(`${name}: json 含 sourceJournal.journal / wal（布尔）`, r.json.sourceJournal && typeof r.json.sourceJournal.journal === 'boolean' && typeof r.json.sourceJournal.wal === 'boolean', JSON.stringify(r.json.sourceJournal));
  }
  if (outState === 'absent') check(`${name}: out 不存在`, !fs.existsSync(outFile), outFile);
  else if (outState && outState.bytes) check(`${name}: 已有 out 的字节不变`, fs.existsSync(outFile) && Buffer.compare(fs.readFileSync(outFile), outState.bytes) === 0);
  if (outFile && r.json && r.json.partial) {
    const actual = fs.existsSync(`${outFile}.partial`);
    eq(`${name}: partial.exists 与磁盘一致`, r.json.partial.exists, actual);
    if (partialExpected !== undefined) eq(`${name}: .partial 是否残留`, actual, partialExpected);
  }
}

// ---------------------------------------------------------------- A 静态断言

function sectionStatic() {
  const src = fs.readFileSync(BACKUP_JS, 'utf8');
  const reqs = [];
  const re = /require\(\s*([^)]*?)\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) reqs.push(m[1]);
  const bad = reqs.filter((a) => {
    const lit = /^(['"])([^'"]+)\1$/.exec(a);
    if (lit) return !builtinModules.includes(lit[2]);
    return a !== 'sqliteModuleDir';
  });
  eq('A1 require 实参只能是内置模块名或 sqliteModuleDir', bad, []);
  check('A2 确实用变量加载 sqlite3 模块', reqs.includes('sqliteModuleDir'), reqs.join(','));
  const builtinsUsed = reqs.filter((a) => /^['"]/.test(a)).map((a) => a.slice(1, -1)).sort();
  eq('A3 内置模块只有 fs 与 path', builtinsUsed, ['fs', 'path']);
  check('A4 不含 import 语句 / dynamic import', !/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(src));
  check('A5 不用读写 / 建库打开模式', !/OPEN_READWRITE|OPEN_CREATE/.test(src));
  const pragmas = Array.from(src.matchAll(/PRAGMA\s+(\w+)/g)).map((x) => x[1]);
  eq('A6 PRAGMA 只出现 integrity_check', Array.from(new Set(pragmas)), ['integrity_check']);
  check('A7 发布不用 renameSync（Windows 上会覆盖已存在目标）', !/fs\.renameSync\(/.test(src));
  check('A8 用 linkSync 发布', /fs\.linkSync\(/.test(src));
  const count = (needle) => src.split(needle).length - 1;
  eq('A9 校验都打开 .partial（备份），不是源库：withDb(sqlite3, partial 恰 2 次', count('withDb(sqlite3, partial'), 2);
  eq('A10 只有 VACUUM 那一步打开源库：withDb(sqlite3, args.db 恰 1 次', count('withDb(sqlite3, args.db'), 1);
  eq("A11 VACUUM INTO 用参数绑定，字面量 'VACUUM INTO ?' 恰 1 次", count("'VACUUM INTO ?'"), 1);
  check('A12 main 开头先把 exitCode 置 1（成功路径才置 0）', /async function main\(\) \{\s*process\.exitCode = 1;/.test(src) && count('process.exitCode = 0;') === 1);
  check('A13 发布后取文件大小失败不改变成功结果（bytes 可为 null）', /try \{ bytes = fs\.statSync\(args\.out\)\.size; \} catch/.test(src));
  check('A14 require 后校验是 sqlite3 模块（Database 与 OPEN_READONLY）', /typeof sqlite3\.Database === 'function' && Number\.isInteger\(sqlite3\.OPEN_READONLY\)/.test(src));
}

// ---------------------------------------------------------------- B 正常路径

async function sectionNormal() {
  const dir = freshDir('normal');
  const db = path.join(dir, 'src.sqlite');
  await buildDb(db, STANDARD_SQL);
  const beforeHash = sha256(db);
  const beforeList = fs.readdirSync(dir).sort();
  const out = path.join(dir, 'backup 1.sqlite');
  const r = runBackup(stdArgs(db, out));
  eq('B1 退出码', r.status, 0);
  check('B2 最后一行是 BACKUP_OK 协议', r.kind === 'BACKUP_OK' && r.json !== null, r.last);
  eq('B3 协议行只有一条', r.protocolLines, 1);
  check('B4 out 存在且是普通文件', fs.existsSync(out) && fs.statSync(out).isFile());
  check('B5 .partial 不存在', !fs.existsSync(`${out}.partial`));
  const j = r.json || {};
  eq('B6 json.out 是 out 的绝对路径', j.out, out);
  eq('B7 json.bytes = 文件大小', j.bytes, fs.existsSync(out) ? fs.statSync(out).size : -1);
  eq('B8 json.tables = 4', j.tables, STANDARD_TABLES);
  eq('B9 json.core 各核心表行数', j.core, { task_pool: 3, users: 2 });
  eq('B10 json.integrity', j.integrity, 'ok');
  if (fs.existsSync(out)) {
    const c = await readCounts(out, ['task_pool', 'users', 'misc']);
    eq('B11 备份可打开：行数', [c.task_pool, c.users, c.misc], [3, 2, 1]);
    eq('B12 备份 integrity_check 恰好一行 ok', c.__integrity, ['ok']);
    eq('B13 备份表个数与源库一致', c.__tables, STANDARD_TABLES);
  } else {
    check('B11 备份可打开：行数', false, 'out 不存在');
  }
  eq('B14 源库字节不变', sha256(db), beforeHash);
  eq('B15 源库目录里只多了备份文件（无 -journal / -wal / -shm / .partial）', fs.readdirSync(dir).sort(), beforeList.concat(['backup 1.sqlite']).sort());

  // 自定义 --core-tables
  const out2 = path.join(dir, 'backup2.sqlite');
  const r2 = runBackup(stdArgs(db, out2, ['--core-tables', 'misc']));
  eq('B16 自定义 --core-tables：退出码', r2.status, 0);
  eq('B17 自定义 --core-tables：core', r2.json && r2.json.core, { misc: 1 });
  expectProtocolTail('B1x 正常路径', r);
  expectProtocolTail('B16x 自定义核心表', r2);

  // B18 备份目录名含单引号与百分号：VACUUM INTO 必须是参数绑定（字符串拼接会在这里炸）
  const qdir = path.join(dir, "q'uote 100%");
  fs.mkdirSync(qdir);
  const qout = path.join(qdir, "back'up.sqlite");
  const rq = runBackup(stdArgs(db, qout));
  eq("B18 目录名含 ' 与 %：退出码", rq.status, 0);
  check('B18 备份存在且 .partial 不存在', fs.existsSync(qout) && !fs.existsSync(`${qout}.partial`));
  expectProtocolTail('B18 目录名含引号', rq);
}

// ---------------------------------------------------------------- C 失败路径

async function sectionFailures() {
  const dir = freshDir('fail');
  const good = path.join(dir, 'good.sqlite');
  await buildDb(good, STANDARD_SQL);

  // C1 源库不存在
  {
    const out = path.join(dir, 'c1-out.sqlite');
    const r = runBackup(stdArgs(path.join(dir, 'missing.sqlite'), out));
    expectFail('C1 源库不存在', r, { status: 1, code: 'BK_SOURCE_MISSING', outFile: out, outState: 'absent', partialExpected: false });
  }
  // C1b 源库是目录
  {
    const out = path.join(dir, 'c1b-out.sqlite');
    const r = runBackup(stdArgs(dir, out));
    expectFail('C1b 源库路径是目录', r, { status: 1, code: 'BK_SOURCE_MISSING', outFile: out, outState: 'absent', partialExpected: false });
  }
  // C2 out 已存在
  {
    const out = path.join(dir, 'c2-out.sqlite');
    const bytes = Buffer.from('已有的备份，不许被覆盖\n', 'utf8');
    fs.writeFileSync(out, bytes);
    const r = runBackup(stdArgs(good, out));
    expectFail('C2 out 已存在', r, { status: 1, code: 'BK_OUT_EXISTS', outFile: out, outState: { bytes }, partialExpected: false });
  }
  // C3 .partial 已存在
  {
    const out = path.join(dir, 'c3-out.sqlite');
    const pbytes = Buffer.from('上次失败残留\n', 'utf8');
    fs.writeFileSync(`${out}.partial`, pbytes);
    const r = runBackup(stdArgs(good, out));
    expectFail('C3 .partial 已存在', r, { status: 1, code: 'BK_OUT_EXISTS', outFile: out, outState: 'absent', partialExpected: true });
    const kept = fs.existsSync(`${out}.partial`) ? fs.readFileSync(`${out}.partial`) : null;
    check('C3 .partial 字节不变', kept !== null && Buffer.compare(kept, pbytes) === 0);
  }
  // C4 --sqlite3 路径错
  {
    const out = path.join(dir, 'c4-out.sqlite');
    const r = runBackup(['--sqlite3', path.join(dir, 'no-such-sqlite3'), '--db', good, '--out', out]);
    expectFail('C4 --sqlite3 路径错', r, { status: 1, code: 'BK_SQLITE_LOAD', outFile: out, outState: 'absent', partialExpected: false });
  }
  // C4b --sqlite3 指向能加载、但不是 sqlite3 模块的目录（假模块）→ BK_SQLITE_LOAD，而不是在后面报 VACUUM 失败
  for (const [label, text] of [['C4b 假模块：导出空对象', 'module.exports = {};\n'], ['C4c 假模块：有 Database 无 OPEN_READONLY', 'module.exports = { Database: function Database() {} };\n'], ['C4d 假模块：OPEN_READONLY 有、Database 不是函数', 'module.exports = { Database: 1, OPEN_READONLY: 1 };\n']]) {
    const fakeDir = path.join(dir, `fake-sqlite3-${label.slice(0, 3)}`);
    fs.mkdirSync(fakeDir);
    fs.writeFileSync(path.join(fakeDir, 'index.js'), text);
    const out = path.join(dir, `${label.slice(0, 3)}-out.sqlite`);
    const r = runBackup(['--sqlite3', fakeDir, '--db', good, '--out', out]);
    expectFail(label, r, { status: 1, code: 'BK_SQLITE_LOAD', outFile: out, outState: 'absent', partialExpected: false });
  }
  // C5 核心表缺失
  {
    const db = path.join(dir, 'c5-src.sqlite');
    await buildDb(db, 'CREATE TABLE task_pool (id INTEGER PRIMARY KEY); INSERT INTO task_pool VALUES (1);');
    const out = path.join(dir, 'c5-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C5 核心表缺失', r, { status: 1, code: 'BK_CORE_TABLE_MISSING', outFile: out, outState: 'absent', partialExpected: true });
    check('C5 message 点名缺的表', r.json && /users/.test(r.json.message), r.json && r.json.message);
  }
  // C6 核心表为空
  {
    const db = path.join(dir, 'c6-src.sqlite');
    await buildDb(db, 'CREATE TABLE task_pool (id INTEGER PRIMARY KEY); INSERT INTO task_pool VALUES (1); CREATE TABLE users (id INTEGER PRIMARY KEY);');
    const out = path.join(dir, 'c6-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C6 核心表为空', r, { status: 1, code: 'BK_CORE_TABLE_EMPTY', outFile: out, outState: 'absent', partialExpected: true });
    check('C6 message 点名空的表', r.json && /users/.test(r.json.message), r.json && r.json.message);
  }
  // C7 源库损坏 (a)：根本不是库 → 在读源库阶段失败（VACUUM 之前）
  {
    const db = path.join(dir, 'c7a-src.sqlite');
    fs.writeFileSync(db, Buffer.alloc(8192, 0x41));
    const out = path.join(dir, 'c7a-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C7a 源库不是数据库文件', r, { status: 1, code: 'BK_VACUUM_FAILED', outFile: out, outState: 'absent' });
  }
  // C7 源库损坏 (b)：表的数据页被毁（真实损坏，无测试钩子）→ VACUUM INTO 读到坏页失败
  {
    const db = path.join(dir, 'c7b-src.sqlite');
    await buildDb(db, `
      CREATE TABLE task_pool (id INTEGER PRIMARY KEY, title TEXT, status TEXT);
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO users VALUES (1, '甲');
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000)
        INSERT INTO task_pool SELECT x, printf('t%d', x) || hex(zeroblob(50)), 'open' FROM c;
    `);
    const fd = fs.openSync(db, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096 * 7); } finally { fs.closeSync(fd); }
    const out = path.join(dir, 'c7b-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C7b 源库数据页损坏（VACUUM 失败点）', r, { status: 1, code: 'BK_VACUUM_FAILED', outFile: out, outState: 'absent' });
    check('C7b 失败点在 vacuum_into 阶段', r.json && r.json.stage === 'vacuum_into', r.json && r.json.stage);
  }
  // C8a 只读 integrity 残余：库里有 FTS5 虚表——只读连接上 integrity_check 对它报「unable to validate the inverted index … readonly database」
  //   （不是 ok，必须挡住、人工确认）。VACUUM 能成功、备份的 integrity_check 不是 ok；.partial 必须原样留下。
  //   源库的真实损坏也能到达这个失败点，见 C8b（索引根页损坏）；CHECK 约束被违反的行在新连接上 integrity_check 仍报 ok（探测所得），不能用来造这个失败点。
  {
    const db = path.join(dir, 'c8-src.sqlite');
    await buildDb(db, `
      CREATE TABLE task_pool (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO task_pool VALUES (1, 'a');
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1);
      CREATE VIRTUAL TABLE docs USING fts5(body);
      INSERT INTO docs (body) VALUES ('hello world');
    `);
    const out = path.join(dir, 'c8-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C8a 只读 integrity 残余：FTS5 虚表', r, { status: 1, code: 'BK_INTEGRITY_FAILED', outFile: out, outState: 'absent', partialExpected: true });
    check('C8a 失败点在 integrity_check 阶段', r.json && r.json.stage === 'integrity_check', r.json && r.json.stage);
    check('C8a message 带回 integrity_check 的原文', r.json && /FTS5/.test(r.json.message), r.json && r.json.message);
    check('C8a .partial 是一个仍可打开的库（失败时原样保留，不清理）', fs.existsSync(`${out}.partial`) && fs.statSync(`${out}.partial`).size > 0);
    eq('C8a json.partial.path', r.json && r.json.partial && r.json.partial.path, `${out}.partial`);
  }
  // C8b 源库索引根页真实损坏（不是测试钩子）：VACUUM INTO 对索引原样搬运，成功；备份的 integrity_check 报 missing from index → BK_INTEGRITY_FAILED，.partial 保留
  {
    const db = path.join(dir, 'c8b-src.sqlite');
    await buildDb(db, `
      CREATE TABLE task_pool (id INTEGER PRIMARY KEY, title TEXT);
      CREATE INDEX ix_title ON task_pool (title);
      INSERT INTO task_pool VALUES (1, 'MARK0001'), (2, 'MARK0002'), (3, 'MARK0003');
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1);
    `);
    const hit = await corruptIndexRoot(db);
    check('C8b 前置：在索引根页里找到并改写了 MARK0002', hit === true);
    const srcIc = await integrityOf(db);
    check('C8b 前置：源库自己的 integrity_check 不是 ok', !(srcIc.length === 1 && srcIc[0] === 'ok'), JSON.stringify(srcIc));
    const out = path.join(dir, 'c8b-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    expectFail('C8b 索引根页损坏', r, { status: 1, code: 'BK_INTEGRITY_FAILED', outFile: out, outState: 'absent', partialExpected: true });
    check('C8b 失败点在 integrity_check 阶段（VACUUM 本身成功）', r.json && r.json.stage === 'integrity_check', r.json && r.json.stage);
    check('C8b message 带回 missing from index', r.json && /missing from index/.test(r.json.message), r.json && r.json.message);
  }
  // C10 源库有孤立页（头里页数 +1、尾补零页）：源库 integrity_check 不是 ok，但 VACUUM INTO 只复制可达页，备份是好的 → 期望 BACKUP_OK。
  //   证明 integrity_check 查的是备份，不是源库（改查源库就会在这里误报失败）。
  {
    const db = path.join(dir, 'c10-src.sqlite');
    await buildDb(db, STANDARD_SQL);
    addOrphanPage(db);
    const srcIc = await integrityOf(db);
    check('C10 前置：源库 integrity_check 报孤立页（不是 ok）', !(srcIc.length === 1 && srcIc[0] === 'ok') && srcIc.some((x) => /never used/.test(x)), JSON.stringify(srcIc));
    const before = sha256(db);
    const out = path.join(dir, 'c10-out.sqlite');
    const r = runBackup(stdArgs(db, out));
    eq('C10 退出码', r.status, 0);
    check('C10 最后一行是 BACKUP_OK 协议', r.kind === 'BACKUP_OK' && r.json !== null, r.last);
    expectProtocolTail('C10', r);
    eq('C10 json.integrity', r.json && r.json.integrity, 'ok');
    if (fs.existsSync(out)) {
      const c = await readCounts(out, ['task_pool', 'users']);
      eq('C10 备份 integrity_check 恰好一行 ok、行数对', [c.__integrity, c.task_pool, c.users], [['ok'], 3, 2]);
    } else {
      check('C10 备份存在', false, out);
    }
    eq('C10 源库字节不变', sha256(db), before);
  }
  // C11 源库有热日志（写事务进行中进程被杀，日志已落盘）：只读连接无法回滚，VACUUM INTO 失败；源库与日志都不能被改；FAIL json 报出 sourceJournal.journal = true
  {
    const db = path.join(dir, 'c11-src.sqlite');
    await buildDb(db, `
      CREATE TABLE task_pool (id INTEGER PRIMARY KEY, v BLOB);
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1);
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000)
        INSERT INTO task_pool SELECT x, randomblob(1000) FROM c;
    `);
    const made = await makeHotJournal(db);
    check('C11 前置：产生了非空的 -journal', made, `${db}-journal`);
    if (made) {
      const hashDb = sha256(db);
      const hashJ = sha256(`${db}-journal`);
      const out = path.join(dir, 'c11-out.sqlite');
      const r = runBackup(stdArgs(db, out));
      expectFail('C11 源库有热日志', r, { status: 1, code: 'BK_VACUUM_FAILED', outFile: out, outState: 'absent' });
      eq('C11 json.sourceJournal', r.json && r.json.sourceJournal, { journal: true, wal: false });
      check('C11 message 带回 SQLITE_READONLY', r.json && /READONLY/.test(r.json.message), r.json && r.json.message);
      eq('C11 源库字节不变', sha256(db), hashDb);
      eq('C11 日志字节不变（没有被回滚 / 删除）', fs.existsSync(`${db}-journal`) ? sha256(`${db}-journal`) : null, hashJ);
    }
  }
  // C9 参数错误：退出码 2，也打 BACKUP_FAIL
  {
    const out = path.join(dir, 'c9-out.sqlite');
    const cases = [
      ['C9a 未知参数', stdArgs(good, out, ['--bogus', 'x'])],
      ['C9b 缺 --out', ['--sqlite3', SQLITE3_DIR, '--db', good]],
      ['C9c 缺 --db', ['--sqlite3', SQLITE3_DIR, '--out', out]],
      ['C9d 缺 --sqlite3', ['--db', good, '--out', out]],
      ['C9e 位置参数', stdArgs(good, out, ['extra'])],
      ['C9f 参数缺取值', ['--sqlite3', SQLITE3_DIR, '--db', good, '--out']],
      ['C9g 参数重复', stdArgs(good, out, ['--db', good])],
      ['C9h 核心表名非法', stdArgs(good, out, ['--core-tables', 'task_pool;drop'])],
      ['C9i 无参数', []],
      ['C9k 核心表名 __proto__', stdArgs(good, out, ['--core-tables', '__proto__'])],
      ['C9l 核心表名 constructor', stdArgs(good, out, ['--core-tables', 'task_pool,constructor'])],
      ['C9m 核心表名 prototype', stdArgs(good, out, ['--core-tables', 'prototype'])],
    ];
    // out 所在目录不存在：同属参数错误（此时参数已解析，json.out 有值）
    const missingDirOut = path.join(dir, '没有的目录', 'x.sqlite');
    cases.push(['C9j out 所在目录不存在', stdArgs(good, missingDirOut)]);
    for (const [name, a] of cases) {
      const r = runBackup(a);
      eq(`${name}: 退出码`, r.status, 2);
      check(`${name}: 最后一行是 BACKUP_FAIL 协议`, r.kind === 'BACKUP_FAIL' && r.json !== null, r.last);
      expectProtocolTail(name, r);
      eq(`${name}: 错误码`, r.json && r.json.code, 'BK_ARGS');
      const outFile = name.startsWith('C9j') ? missingDirOut : out;
      check(`${name}: out 不存在`, !fs.existsSync(outFile));
      // json.partial：有路径时 exists 必须与磁盘一致；没解析出 out 时 path 为 null、exists 为 false
      const p = r.json && r.json.partial;
      check(`${name}: partial.exists 与磁盘一致`, !!p && typeof p.exists === 'boolean' && (p.path === null ? p.exists === false : p.exists === fs.existsSync(p.path)), JSON.stringify(p));
      check(`${name}: out 与 partial.path 的对应（解析出 out 时 partial.path = out + .partial）`, !!r.json && (r.json.out === null ? p.path === null : p.path === `${r.json.out}.partial`), JSON.stringify(r.json));
    }
  }
}

// ---------------------------------------------------------------- G 进程内（假 fs / 核心表计数）
//   真实文件系统上造不出稳定的权限错误 / IO 错误，所以把探测函数导出，在这里用注入的假 fs 调用它们验证三态与 BK_FS_ERROR；
//   生产路径传的是真实 fs，行为不变。核心表计数则直接对夹具库调用导出的 checkCoreTables。

/** 假 fs：rule(op, p) 返回 { throw: '<code>' } 或 { kind: 'file' | 'dir' } */
function fakeFs(rule) {
  const go = (op) => (p) => {
    const r = rule(op, p);
    if (r.throw) throw Object.assign(new Error(r.throw), { code: r.throw });
    return { isFile: () => r.kind === 'file', isDirectory: () => r.kind === 'dir', isSymbolicLink: () => false };
  };
  return { statSync: go('stat'), lstatSync: go('lstat') };
}

async function sectionInProcess() {
  const B = require(BACKUP_JS);
  check('G0 backup-db.js 作为模块导出了探测函数（require 时不执行 main）', ['statState', 'triState', 'validate', 'checkCoreTables', 'buildFailInfo'].every((k) => typeof B[k] === 'function'), Object.keys(B).join(','));
  const args = { db: '/x/src', out: '/x/out', sqlite3Dir: '/x/s', coreTables: ['task_pool'] };
  const partial = '/x/out.partial';
  const dirOf = '/x';
  // 默认规则：源库是文件，out / partial 不存在，目录存在
  const base = (over) => (op, p) => {
    if (over && Object.prototype.hasOwnProperty.call(over, p)) return over[p];
    if (p === args.db) return { kind: 'file' };
    if (p === dirOf) return { kind: 'dir' };
    return { throw: 'ENOENT' };
  };
  const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e && e.code; } };
  const msgOf = (fn) => { try { fn(); return ''; } catch (e) { return String(e && e.message); } };
  const V = (over) => () => B.validate(args, fakeFs(base(over)));

  // G1 validate：只有 ENOENT / ENOTDIR 算不存在；其他错误 BK_FS_ERROR（stage validate，message 带原错误码）
  eq('G1a 全部正常 → 通过', codeOf(V()), null);
  eq('G1b 源库 ENOENT → BK_SOURCE_MISSING', codeOf(V({ [args.db]: { throw: 'ENOENT' } })), 'BK_SOURCE_MISSING');
  eq('G1c 源库 ENOTDIR → BK_SOURCE_MISSING', codeOf(V({ [args.db]: { throw: 'ENOTDIR' } })), 'BK_SOURCE_MISSING');
  eq('G1d 源库 EACCES → BK_FS_ERROR', codeOf(V({ [args.db]: { throw: 'EACCES' } })), 'BK_FS_ERROR');
  check('G1d message 带原错误码 EACCES', /EACCES/.test(msgOf(V({ [args.db]: { throw: 'EACCES' } }))));
  eq('G1e 源库 EIO → BK_FS_ERROR', codeOf(V({ [args.db]: { throw: 'EIO' } })), 'BK_FS_ERROR');
  eq('G1f 源库是目录 → BK_SOURCE_MISSING', codeOf(V({ [args.db]: { kind: 'dir' } })), 'BK_SOURCE_MISSING');
  eq('G1g out EPERM → BK_FS_ERROR', codeOf(V({ [args.out]: { throw: 'EPERM' } })), 'BK_FS_ERROR');
  eq('G1h out ENOTDIR → 视为不存在，通过', codeOf(V({ [args.out]: { throw: 'ENOTDIR' } })), null);
  eq('G1i out 已存在 → BK_OUT_EXISTS', codeOf(V({ [args.out]: { kind: 'file' } })), 'BK_OUT_EXISTS');
  eq('G1j .partial EACCES → BK_FS_ERROR', codeOf(V({ [partial]: { throw: 'EACCES' } })), 'BK_FS_ERROR');
  eq('G1k .partial 已存在 → BK_OUT_EXISTS', codeOf(V({ [partial]: { kind: 'file' } })), 'BK_OUT_EXISTS');
  eq('G1l 目录 EACCES → BK_FS_ERROR', codeOf(V({ [dirOf]: { throw: 'EACCES' } })), 'BK_FS_ERROR');
  eq('G1m 目录 ENOENT → BK_ARGS', codeOf(V({ [dirOf]: { throw: 'ENOENT' } })), 'BK_ARGS');
  eq('G1n 目录 ENOTDIR → BK_ARGS', codeOf(V({ [dirOf]: { throw: 'ENOTDIR' } })), 'BK_ARGS');
  eq('G1o 目录位置是文件 → BK_ARGS', codeOf(V({ [dirOf]: { kind: 'file' } })), 'BK_ARGS');
  let stageOk = false;
  try { V({ [args.db]: { throw: 'EACCES' } })(); } catch (e) { stageOk = e && e.stage === 'validate'; }
  check('G1p BK_FS_ERROR 的 stage 是 validate', stageOk);
  eq('G1q 真实 fs 默认值：statState 对不存在的路径 → missing', B.statState(path.join(TMP_ROOT, '不存在的路径'), true), { missing: true });

  // G2 buildFailInfo：三态 true / false / "unknown"，探测出错附 probeError
  const info = (over, withArgs) => B.buildFailInfo({ code: 'BK_X', stage: 's', message: 'm' }, withArgs === false ? null : args, fakeFs((op, p) => (over && Object.prototype.hasOwnProperty.call(over, p) ? over[p] : { throw: 'ENOENT' })));
  const none = info({});
  eq('G2a 全部不存在 → false / false / false，没有 probeError', [none.partial.exists, none.sourceJournal.journal, none.sourceJournal.wal, none.partial.probeError, none.sourceJournal.probeError], [false, false, false, undefined, undefined]);
  const present = info({ [partial]: { kind: 'file' }, [`${args.db}-journal`]: { kind: 'file' }, [`${args.db}-wal`]: { kind: 'file' } });
  eq('G2b 全部存在 → true / true / true', [present.partial.exists, present.sourceJournal.journal, present.sourceJournal.wal], [true, true, true]);
  const unk = info({ [partial]: { throw: 'EACCES' }, [`${args.db}-journal`]: { throw: 'EIO' } });
  eq('G2c 探测出错 → "unknown" 并附 probeError', [unk.partial.exists, unk.partial.probeError, unk.sourceJournal.journal, unk.sourceJournal.wal, unk.sourceJournal.probeError], ['unknown', 'EACCES', 'unknown', false, { journal: 'EIO' }]);
  const enotdir = info({ [partial]: { throw: 'ENOTDIR' } });
  eq('G2d ENOTDIR 算不存在 → false', [enotdir.partial.exists, enotdir.partial.probeError], [false, undefined]);
  const wal = info({ [`${args.db}-wal`]: { throw: 'EPERM' } });
  eq('G2e wal 探测出错 → wal "unknown"、journal false、probeError 只含 wal', [wal.sourceJournal.journal, wal.sourceJournal.wal, wal.sourceJournal.probeError], [false, 'unknown', { wal: 'EPERM' }]);
  const noArgs = info({}, false);
  eq('G2f 参数没解析出来 → partial {path:null, exists:false}、sourceJournal null', [noArgs.partial, noArgs.sourceJournal, noArgs.out], [{ path: null, exists: false }, null, null]);
  check('G2g json 序列化后三态原样（字符串 "unknown"）', JSON.parse(JSON.stringify(unk)).partial.exists === 'unknown');

  // G3 / G4 / G5 核心表计数（真实 sqlite 夹具库，直接调导出的 checkCoreTables；表名 __proto__ 绕过了参数解析的拒绝，专测计数映射本身）
  const dir = freshDir('inproc');
  const f1 = path.join(dir, 'proto-nonempty.sqlite');
  await buildDb(f1, 'CREATE TABLE "__proto__" (id INTEGER PRIMARY KEY); INSERT INTO "__proto__" VALUES (1), (2), (3); CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);');
  const db1 = await openRw(f1);
  let r3 = null;
  try { r3 = await B.checkCoreTables(db1, ['__proto__', 'users']); } catch (e) { r3 = { error: e && e.code }; } finally { await closeDb(db1); }
  check('G3 同名非空表：计数映射里有这个名字作为自有属性，值为行数 3', !!r3 && !r3.error && Object.prototype.hasOwnProperty.call(r3.counts, '__proto__') && r3.counts['__proto__'] === 3 && r3.counts.users === 1, JSON.stringify(r3));
  check('G3 JSON 序列化里带着这个计数', !!r3 && !r3.error && JSON.stringify(r3.counts) === '{"__proto__":3,"users":1}', r3 && !r3.error ? JSON.stringify(r3.counts) : JSON.stringify(r3));
  const f2 = path.join(dir, 'proto-empty.sqlite');
  await buildDb(f2, 'CREATE TABLE "__proto__" (id INTEGER PRIMARY KEY);');
  const db2 = await openRw(f2);
  let r4 = null;
  try { r4 = await B.checkCoreTables(db2, ['__proto__']); } catch (e) { r4 = { error: e && e.code }; } finally { await closeDb(db2); }
  eq('G4 同名空表必须失败（BK_CORE_TABLE_EMPTY），不能被原型 setter 绕过', r4 && r4.error, 'BK_CORE_TABLE_EMPTY');
  const f3 = path.join(dir, 'std.sqlite');
  await buildDb(f3, STANDARD_SQL);
  const db3 = await openRw(f3);
  let r5 = null;
  try { r5 = await B.checkCoreTables(db3, ['task_pool', 'users']); } catch (e) { r5 = { error: e && e.code }; } finally { await closeDb(db3); }
  eq('G5 普通表：计数与表个数', r5 && !r5.error ? [r5.counts.task_pool, r5.counts.users, r5.tables] : r5, [3, 2, STANDARD_TABLES]);
}

// ---------------------------------------------------------------- D 发布竞态

async function sectionRace() {
  const dir = freshDir('race');
  const db = path.join(dir, 'big.sqlite');
  await buildDb(db, `
    CREATE TABLE task_pool (id INTEGER PRIMARY KEY, v BLOB);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO users VALUES (1, '甲');
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000)
      INSERT INTO task_pool SELECT x, randomblob(1000) FROM c;
  `);
  const sentinel = Buffer.from('备份期间别人放进来的文件，不许被覆盖\n', 'utf8');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const out = path.join(dir, `race-out-${attempt}.sqlite`);
    const partial = `${out}.partial`;
    const child = spawn(process.execPath, [BACKUP_JS, ...stdArgs(db, out)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    let planted = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (fs.existsSync(partial)) {
        try { fs.writeFileSync(out, sentinel, { flag: 'wx' }); planted = true; } catch (_) { /* 备份已先发布：本轮没赶上 */ }
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    // 子进程的硬超时：卡住就杀，再等 close；等待也有上限（轮询的 60 秒截止只约束轮询，不约束子进程本身）
    const hardKill = setTimeout(() => { try { child.kill(); } catch (_) { /* 已退出 */ } }, 90000);
    let giveUp = null;
    const gaveUp = new Promise((resolve) => { giveUp = setTimeout(() => resolve('NO_CLOSE'), 100000); });
    const code = await Promise.race([closed, gaveUp]);
    clearTimeout(hardKill);
    clearTimeout(giveUp);
    if (code === 'NO_CLOSE') { check('D0 竞态子进程超时（kill 之后仍未 close）', false, `attempt ${attempt}`); return; }
    const p = parseProtocol(stdout);
    if (!planted) {
      // 没赶上窗口：清掉这一轮产物再试（备份成功时 out 是它的产物）
      for (const f of [out, partial]) { try { fs.unlinkSync(f); } catch (_) { /* 不存在 */ } }
      continue;
    }
    check('D1 放入的文件不被覆盖（字节不变）', fs.existsSync(out) && Buffer.compare(fs.readFileSync(out), sentinel) === 0);
    eq('D2 退出码', code, 1);
    check('D3 最后一行是 BACKUP_FAIL 协议', p.kind === 'BACKUP_FAIL' && p.json !== null, p.last);
    check('D3 stdout 以唯一协议行 + 恰好一个 \\n 结尾', p.strictEnd === true && p.protocolLines === 1, JSON.stringify(String(stdout).slice(-60)));
    eq('D4 错误码', p.json && p.json.code, 'BK_PUBLISH_FAILED');
    eq('D5 失败阶段', p.json && p.json.stage, 'publish_link');
    check('D6 .partial 原样留下（失败不清理）', fs.existsSync(partial) && p.json && p.json.partial && p.json.partial.exists === true);
    return;
  }
  check('D0 竞态窗口：5 次都没能在 VACUUM 期间放进文件', false);
}

// ---------------------------------------------------------------- E 发布记录

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1'.repeat(20);
const SHA_C = '0123456789abcdef0123456789abcdef01234567';

function runRecordCli(args) {
  const r = spawnSync(process.execPath, [RECORD_JS, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const lines = String(r.stdout).split('\n').filter((l) => l !== '');
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines };
}

function throwsCode(fn) {
  try { fn(); } catch (e) { return e && e.code; }
  return null;
}

function sectionRecord() {
  const R = require(RECORD_JS);
  const dir = path.join(freshDir('record'), 'releases');
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const bytesOf = (id) => fs.readFileSync(fileOf(id));
  const id1 = '20261024_101500';

  // E1 init 正常
  const init = R.initRecord({ dir, id: id1, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.2.3', prevRunningVersion: '1.2.2', prevRunningCommit: SHA_A, now: '2026-10-24T10:15:00.000Z' });
  eq('E1 init 返回文件路径', init.file, fileOf(id1));
  check('E1 文件存在', fs.existsSync(fileOf(id1)));
  const rec = JSON.parse(bytesOf(id1).toString('utf8'));
  eq('E2 字段全集', rec, {
    schema: 1,
    id: id1,
    createdAt: '2026-10-24T10:15:00.000Z',
    prevCommit: SHA_A,
    prevRunning: { version: '1.2.2', commit: SHA_A },
    newCommit: SHA_B,
    newVersion: '1.2.3',
    rollbackTarget: SHA_A,
    backup: null,
    attachments: null,
    stage: 'prepared',
    history: [{ stage: 'prepared', at: '2026-10-24T10:15:00.000Z', note: null }],
    result: null,
  });
  eq('E3 目录里只有记录文件', fs.readdirSync(dir), [`${id1}.json`]);

  // E4 prevRunning 缺省 → null
  const id0 = '20261024_090000';
  R.initRecord({ dir, id: id0, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.2.3' });
  eq('E4 prevRunning 缺省为 null', JSON.parse(bytesOf(id0).toString('utf8')).prevRunning, { version: null, commit: null });

  // E5 重复 init 拒绝，原文件不变
  const before = bytesOf(id1);
  eq('E5 重复 init → RR_EXISTS', throwsCode(() => R.initRecord({ dir, id: id1, prevCommit: SHA_B, newCommit: SHA_A, newVersion: '9.9.9' })), 'RR_EXISTS');
  check('E5 重复 init 后原文件字节不变', Buffer.compare(bytesOf(id1), before) === 0);

  // E6 stage 推进与 history 追加
  const s1 = R.advanceStage({ dir, id: id1, stage: 'uploaded', note: '已上传', now: '2026-10-24T10:16:00.000Z' });
  eq('E6 stage 返回文件路径', s1.file, fileOf(id1));
  const s2 = R.advanceStage({ dir, id: id1, stage: 'backed_up', backup: 'E:\\bk\\x.sqlite', attachments: 'E:\\att\\x.tar', now: '2026-10-24T10:17:00.000Z' });
  const onDisk = JSON.parse(bytesOf(id1).toString('utf8'));
  eq('E7 磁盘记录 = 返回记录', onDisk, s2.record);
  eq('E8 stage 当前值', onDisk.stage, 'backed_up');
  eq('E9 history 追加且保序', onDisk.history, [
    { stage: 'prepared', at: '2026-10-24T10:15:00.000Z', note: null },
    { stage: 'uploaded', at: '2026-10-24T10:16:00.000Z', note: '已上传' },
    { stage: 'backed_up', at: '2026-10-24T10:17:00.000Z', note: null, backup: 'E:\\bk\\x.sqlite', attachments: 'E:\\att\\x.tar' },
  ]);
  eq('E10 backup / attachments 写入', [onDisk.backup, onDisk.attachments], ['E:\\bk\\x.sqlite', 'E:\\att\\x.tar']);
  eq('E11 不可变字段原样', [onDisk.prevCommit, onDisk.newCommit, onDisk.rollbackTarget, onDisk.prevRunning], [SHA_A, SHA_B, SHA_A, { version: '1.2.2', commit: SHA_A }]);
  eq('E12 result 仍为 null', onDisk.result, null);
  // 后续 stage 不带 backup：保留已写入的值
  R.advanceStage({ dir, id: id1, stage: 'stopped', now: '2026-10-24T10:18:00.000Z' });
  eq('E13 后续 stage 不带 backup 时保留原值', JSON.parse(bytesOf(id1).toString('utf8')).backup, 'E:\\bk\\x.sqlite');

  // E14 全部白名单阶段都能写（在新记录上逐个）
  const idAll = '20261024_110000';
  R.initRecord({ dir, id: idAll, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0' });
  const allStages = ['prepared', 'uploaded', 'stopped', 'backed_up', 'backup_failed', 'restarted_old', 'restart_unverified', 'code_updated', 'started', 'ready', 'ready_failed', 'pulled', 'done', 'failed'];
  eq('E14a 导出的阶段白名单恰是这 14 个', R.STAGES.slice(), allStages);
  const bad = allStages.filter((s) => throwsCode(() => R.advanceStage({ dir, id: idAll, stage: s })) !== null);
  eq('E14b 白名单阶段都能写', bad, []);

  // E15 未知阶段 / 记录不存在 / 坏参数：拒绝且文件不变
  const b1 = bytesOf(id1);
  eq('E15 未知阶段 → RR_BAD_STAGE', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'exploded' })), 'RR_BAD_STAGE');
  eq('E15b 阶段名大小写敏感', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'DONE' })), 'RR_BAD_STAGE');
  eq('E16 记录不存在 → RR_NOT_FOUND', throwsCode(() => R.advanceStage({ dir, id: '20250101_000000', stage: 'done' })), 'RR_NOT_FOUND');
  eq('E17 result 非法值 → RR_BAD_ARGS', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'done', result: 'maybe' })), 'RR_BAD_ARGS');
  eq('E18 不认识的参数 → RR_BAD_ARGS', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'done', colour: 'red' })), 'RR_BAD_ARGS');
  check('E15–18 拒绝后文件字节不变', Buffer.compare(bytesOf(id1), b1) === 0);

  // E19 不可变字段
  for (const k of ['prevCommit', 'newCommit', 'rollbackTarget', 'prevRunning']) {
    const val = k === 'prevRunning' ? { version: '9.9.9', commit: SHA_B } : SHA_C;
    eq(`E19 函数层拒绝改 ${k} → RR_IMMUTABLE`, throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'started', [k]: val })), 'RR_IMMUTABLE');
  }
  check('E19 拒绝后文件字节不变', Buffer.compare(bytesOf(id1), b1) === 0);
  eq('E19b init 之后也不能经 init 换掉不可变字段（重复 init 已拒绝，见 E5）', throwsCode(() => R.initRecord({ dir, id: id1, prevCommit: SHA_C, newCommit: SHA_C, newVersion: '1.0.0' })), 'RR_EXISTS');

  // E20 result 落定后拒绝
  const done = R.advanceStage({ dir, id: id1, stage: 'done', note: '完成', result: 'ok', now: '2026-10-24T10:19:00.000Z' });
  eq('E20 result 落定', done.record.result, 'ok');
  const b2 = bytesOf(id1);
  eq('E21 定稿后再写 stage → RR_FINALIZED', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'failed' })), 'RR_FINALIZED');
  eq('E22 定稿后再写 result → RR_FINALIZED', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'failed', result: 'failed' })), 'RR_FINALIZED');
  eq('E23 定稿后写 backup → RR_FINALIZED', throwsCode(() => R.advanceStage({ dir, id: id1, stage: 'done', backup: 'x' })), 'RR_FINALIZED');
  check('E21–23 定稿后文件字节不变', Buffer.compare(bytesOf(id1), b2) === 0);

  // E50 init：prevRunning.commit 非 null 且 ≠ prevCommit → RR_PREV_MISMATCH（不建文件）；相等（E1）或为 null（E4）放行
  const listP = fs.readdirSync(dir).sort();
  eq('E50 prevRunning.commit ≠ prevCommit → RR_PREV_MISMATCH', throwsCode(() => R.initRecord({ dir, id: '20261024_150000', prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0', prevRunningCommit: SHA_C })), 'RR_PREV_MISMATCH');
  eq('E50 拒绝后没有建出文件', fs.readdirSync(dir).sort(), listP);

  // E51 backup / attachments 只写一次；相同值幂等；每次传入的值记进当次 history
  const idW = '20261024_160000';
  R.initRecord({ dir, id: idW, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0' });
  R.advanceStage({ dir, id: idW, stage: 'backed_up', backup: 'E:\\bk\\1.sqlite', attachments: 'E:\\att\\1.tar', now: '2026-10-24T16:01:00.000Z' });
  const bw = bytesOf(idW);
  eq('E51a 已写的 backup 改成不同值 → RR_IMMUTABLE', throwsCode(() => R.advanceStage({ dir, id: idW, stage: 'started', backup: 'E:\\bk\\2.sqlite' })), 'RR_IMMUTABLE');
  eq('E51b 已写的 attachments 改成不同值 → RR_IMMUTABLE', throwsCode(() => R.advanceStage({ dir, id: idW, stage: 'started', attachments: 'E:\\att\\2.tar' })), 'RR_IMMUTABLE');
  check('E51 拒绝后文件字节不变（history 也没多一条）', Buffer.compare(bytesOf(idW), bw) === 0);
  eq('E51c 写相同值幂等通过', throwsCode(() => R.advanceStage({ dir, id: idW, stage: 'started', backup: 'E:\\bk\\1.sqlite', now: '2026-10-24T16:02:00.000Z' })), null);
  const rw = JSON.parse(bytesOf(idW).toString('utf8'));
  eq('E51d 幂等写入：值不变，当次 history 条目记了 backup（没传的 attachments 不记）', [rw.backup, rw.attachments, rw.history[rw.history.length - 1]], ['E:\\bk\\1.sqlite', 'E:\\att\\1.tar', { stage: 'started', at: '2026-10-24T16:02:00.000Z', note: null, backup: 'E:\\bk\\1.sqlite' }]);
  eq('E51e 首次写入的 history 条目记了 backup 与 attachments', rw.history[1], { stage: 'backed_up', at: '2026-10-24T16:01:00.000Z', note: null, backup: 'E:\\bk\\1.sqlite', attachments: 'E:\\att\\1.tar' });
  const idW2 = '20261024_160100';
  R.initRecord({ dir, id: idW2, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0' });
  R.advanceStage({ dir, id: idW2, stage: 'backed_up', backup: 'E:\\bk\\9.sqlite' });
  eq('E51f backup 已写、attachments 仍为 null 时可以首次写 attachments', throwsCode(() => R.advanceStage({ dir, id: idW2, stage: 'started', attachments: 'E:\\att\\9.tar' })), null);

  // E52 result 与阶段一致
  const matrix = [
    ['ok', 'done', true], ['ok', 'backed_up', false], ['ok', 'failed', false], ['ok', 'ready', false], ['ok', 'ready_failed', false],
    ['failed', 'done', false], ['failed', 'ready', false], ['failed', 'backed_up', false],
    ['failed', 'backup_failed', true], ['failed', 'restarted_old', true], ['failed', 'restart_unverified', true], ['failed', 'ready_failed', true], ['failed', 'failed', true],
  ];
  matrix.forEach(([result, stage, allowed], i) => {
    const mid = `20261024_17${String(i).padStart(4, '0')}`;
    R.initRecord({ dir, id: mid, prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0' });
    const bm = bytesOf(mid);
    const code = throwsCode(() => R.advanceStage({ dir, id: mid, stage, result }));
    if (allowed) {
      eq(`E52 result=${result} + stage=${stage} 放行`, code, null);
      eq(`E52 result=${result} + stage=${stage} 落定`, JSON.parse(bytesOf(mid).toString('utf8')).result, result);
    } else {
      eq(`E52 result=${result} + stage=${stage} → RR_BAD_RESULT`, code, 'RR_BAD_RESULT');
      check(`E52 result=${result} + stage=${stage} 拒绝后文件字节不变`, Buffer.compare(bytesOf(mid), bm) === 0);
    }
  });

  // E53 记录文件损坏 / 结构不对 → RR_CORRUPT（读与写都拒绝，原文件不动）
  {
    const cdirBad = path.join(freshDir('corrupt'), 'releases');
    fs.mkdirSync(cdirBad, { recursive: true });
    const good = JSON.parse(bytesOf(idW2).toString('utf8'));
    const mk = (id, obj) => { fs.writeFileSync(path.join(cdirBad, `${id}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    check('E53 前置：基准记录本身是合法的（读得出来）', throwsCode(() => R.readRecord({ dir, id: idW2 })) === null);
    // 基准记录 good 的各类缺字段 / 类型错 / 字段间矛盾：每一类至少一例，读与写都 RR_CORRUPT 且字节不变
    const mutators = [
      ['坏 JSON', null],
      ['顶层不是对象（数组）', '[]'],
      ['schema ≠ 1', (g) => { g.schema = 2; }],
      ['id 与文件名不符', (g) => { g.id = '20261024_999999'; }],
      ['缺 createdAt', (g) => { delete g.createdAt; }],
      ['createdAt 不是时间', (g) => { g.createdAt = 'not a date'; }],
      ['缺 prevCommit', (g) => { delete g.prevCommit; }],
      ['prevCommit 不是 40 位十六进制', (g) => { g.prevCommit = 'abc'; g.rollbackTarget = 'abc'; }],
      ['缺 newCommit', (g) => { delete g.newCommit; }],
      ['缺 newVersion', (g) => { delete g.newVersion; }],
      ['newVersion 不是 x.y.z', (g) => { g.newVersion = 'latest'; }],
      ['缺 rollbackTarget', (g) => { delete g.rollbackTarget; }],
      ['rollbackTarget ≠ prevCommit', (g) => { g.rollbackTarget = SHA_B; }],
      ['缺 prevRunning', (g) => { delete g.prevRunning; }],
      ['prevRunning 不是对象', (g) => { g.prevRunning = 'x'; }],
      ['prevRunning 缺 version', (g) => { delete g.prevRunning.version; }],
      ['prevRunning.commit 非法', (g) => { g.prevRunning.commit = 'xyz'; }],
      ['prevRunning.commit 与 prevCommit 矛盾', (g) => { g.prevRunning.commit = SHA_B; }],
      ['缺 backup', (g) => { delete g.backup; }],
      ['backup 是数字', (g) => { g.backup = 5; }],
      ['缺 attachments', (g) => { delete g.attachments; }],
      ['attachments 是空串', (g) => { g.attachments = ''; }],
      ['缺 stage', (g) => { delete g.stage; }],
      ['stage 不在白名单', (g) => { g.stage = 'weird'; }],
      ['result 非法', (g) => { g.result = 'maybe'; }],
      ['result=ok 与 stage=started 矛盾', (g) => { g.result = 'ok'; }],
      ['result=failed 与 stage=started 矛盾', (g) => { g.result = 'failed'; }],
      ['缺 history', (g) => { delete g.history; }],
      ['history 为空数组', (g) => { g.history = []; }],
      ['history 不是数组', (g) => { g.history = {}; }],
      ['history[0] 不是对象', (g) => { g.history[0] = 'x'; }],
      ['history[1].stage 不在白名单', (g) => { g.history[1].stage = 'weird'; }],
      ['history[1] 缺 at', (g) => { delete g.history[1].at; }],
      ['history[1].at 不是时间', (g) => { g.history[1].at = 'garbage'; }],
      ['history[1].note 是数字', (g) => { g.history[1].note = 5; }],
      ['history[1].backup 是数字', (g) => { g.history[1].backup = 5; }],
      ['history 末项 stage ≠ stage', (g) => { g.stage = 'ready'; }],
    ];
    const cases = mutators.map(([label, how], i) => {
      const id = `20261024_18${String(i).padStart(4, '0')}`;
      if (how === null) return [label, id, 'not json {'];
      if (typeof how === 'string') return [label, id, how];
      const g = JSON.parse(JSON.stringify(good));
      g.id = id;
      how(g);
      return [label, id, g];
    });
    for (const [label, id, obj] of cases) {
      mk(id, obj);
      const bc = fs.readFileSync(path.join(cdirBad, `${id}.json`));
      eq(`E53 ${label}：readRecord → RR_CORRUPT`, throwsCode(() => R.readRecord({ dir: cdirBad, id })), 'RR_CORRUPT');
      eq(`E53 ${label}：advanceStage → RR_CORRUPT`, throwsCode(() => R.advanceStage({ dir: cdirBad, id, stage: 'started' })), 'RR_CORRUPT');
      check(`E53 ${label}：原文件字节不变`, Buffer.compare(fs.readFileSync(path.join(cdirBad, `${id}.json`)), bc) === 0);
    }
    const cc = runRecordCli(['show', '--id', '20261024_180000', '--dir', cdirBad]);
    check('E53 CLI show 坏记录：退出码 1 + RR_CORRUPT', cc.status === 1 && /^RELEASE_RECORD_FAIL RR_CORRUPT /.test(cc.lines[0] || ''), cc.stdout);
    eq('E53 坏记录目录里没有残留临时文件', fs.readdirSync(cdirBad).filter((n) => !/^\d{8}_\d{6}\.json$/.test(n)), []);
  }

  // E54 静态：stage 路径只经「临时文件 + fsync + rename」写，不直接写目标文件
  {
    const rsrc = fs.readFileSync(RECORD_JS, 'utf8');
    const startAt = rsrc.indexOf('function advanceStage(');
    const endAt = rsrc.indexOf('// ----', startAt);
    const body = startAt >= 0 && endAt > startAt ? rsrc.slice(startAt, endAt) : '';
    check('E54 advanceStage 调用 writeTempFile 与 replaceFile', /writeTempFile\(/.test(body) && /replaceFile\(/.test(body), body.slice(0, 80));
    check('E54 整个文件没有 writeFileSync（只经 writeTempFile 的 openSync wx + fsync）', !/writeFileSync/.test(rsrc));
    check('E54 writeTempFile 里有 fsyncSync，replaceFile 里有 renameSync', /fsyncSync\(/.test(rsrc) && /renameSync\(tmp, file\)/.test(rsrc));
  }

  // E24 坏 sha / 坏 id / 坏版本 → 拒绝且不建文件
  const listBefore = fs.readdirSync(dir).sort();
  const base = { dir, id: '20261024_120000', prevCommit: SHA_A, newCommit: SHA_B, newVersion: '1.0.0' };
  const badInits = [
    ['E24a prevCommit 太短', { prevCommit: 'abc123' }, 'RR_BAD_SHA'],
    ['E24b prevCommit 含大写', { prevCommit: 'A'.repeat(40) }, 'RR_BAD_SHA'],
    ['E24c newCommit 41 位', { newCommit: 'a'.repeat(41) }, 'RR_BAD_SHA'],
    ['E24d newCommit 非十六进制', { newCommit: 'g'.repeat(40) }, 'RR_BAD_SHA'],
    ['E24e prevRunningCommit 坏 sha', { prevRunningCommit: 'xyz' }, 'RR_BAD_SHA'],
    ['E25a id 带横线', { id: '2026-10-24' }, 'RR_BAD_ID'],
    ['E25b id 位数不对', { id: '20261024_12' }, 'RR_BAD_ID'],
    ['E25c id 路径穿越', { id: '../20261024_120000' }, 'RR_BAD_ID'],
    ['E25d id 缺失', { id: undefined }, 'RR_BAD_ID'],
    ['E26a 版本 两段', { newVersion: '1.2' }, 'RR_BAD_VERSION'],
    ['E26b 版本 带 v', { newVersion: 'v1.2.3' }, 'RR_BAD_VERSION'],
    ['E26c 版本 四段', { newVersion: '1.2.3.4' }, 'RR_BAD_VERSION'],
    ['E26d prevRunningVersion 坏', { prevRunningVersion: 'abc' }, 'RR_BAD_VERSION'],
  ];
  for (const [name, patch, code] of badInits) eq(name, throwsCode(() => R.initRecord(Object.assign({}, base, patch))), code);
  eq('E24–26 坏输入没有建出任何文件', fs.readdirSync(dir).sort(), listBefore);
  eq('E27 stage 的 id 坏 → RR_BAD_ID', throwsCode(() => R.advanceStage({ dir, id: '../x', stage: 'done' })), 'RR_BAD_ID');

  // E28 目录里不残留临时文件（成功与失败之后）
  const names = fs.readdirSync(dir).sort();
  eq('E28 目录里只有记录文件（无临时文件 / 点文件）', names.filter((n) => !/^\d{8}_\d{6}\.json$/.test(n)), []);

  // E29 latest / show / read
  eq('E29 latest = id 最大的记录', R.latestRecord({ dir }).record.id, `20261024_17${String(matrix.length - 1).padStart(4, '0')}`);
  eq('E30 readRecord', R.readRecord({ dir, id: id0 }).record.id, id0);
  eq('E31 空目录 latest → RR_NOT_FOUND', throwsCode(() => R.latestRecord({ dir: path.join(freshDir('empty'), 'none') })), 'RR_NOT_FOUND');

  // E32 命令行（都带 --dir）
  const cdir = path.join(freshDir('cli'), 'releases');
  const cid = '20261024_130000';
  const ci = runRecordCli(['init', '--id', cid, '--prev-commit', SHA_A, '--new-commit', SHA_B, '--new-version', '2.0.0', '--prev-running-version', 'null', '--prev-running-commit', 'null', '--dir', cdir]);
  eq('E32 CLI init 退出码', ci.status, 0);
  eq('E33 CLI init 打印文件绝对路径', ci.lines, [path.join(cdir, `${cid}.json`)]);
  eq('E34 CLI init 的 prevRunning（字符串 null → null）', JSON.parse(fs.readFileSync(path.join(cdir, `${cid}.json`), 'utf8')).prevRunning, { version: null, commit: null });
  const dup = runRecordCli(['init', '--id', cid, '--prev-commit', SHA_A, '--new-commit', SHA_B, '--new-version', '2.0.0', '--dir', cdir]);
  eq('E35 CLI 重复 init 退出码', dup.status, 1);
  check('E36 CLI 失败输出一行 RELEASE_RECORD_FAIL <code> <说明>', dup.lines.length === 1 && /^RELEASE_RECORD_FAIL RR_EXISTS \S/.test(dup.lines[0]), dup.stdout);
  const cs = runRecordCli(['stage', '--id', cid, '--stage', 'backed_up', '--note', '备份完成', '--backup', 'E:\\bk\\y.sqlite', '--dir', cdir]);
  eq('E37 CLI stage 退出码', cs.status, 0);
  const shown = runRecordCli(['show', '--id', cid, '--dir', cdir]);
  eq('E38 CLI show 退出码', shown.status, 0);
  let shownJson = null;
  try { shownJson = JSON.parse(shown.stdout); } catch (_) { /* 下面判红 */ }
  check('E39 CLI show 输出可解析且 stage / backup 正确', shownJson && shownJson.stage === 'backed_up' && shownJson.backup === 'E:\\bk\\y.sqlite' && shownJson.history.length === 2, shown.stdout);
  const lat = runRecordCli(['latest', '--dir', cdir]);
  eq('E40 CLI latest 与 show 一致', lat.stdout, shown.stdout);
  const cres = runRecordCli(['stage', '--id', cid, '--stage', 'done', '--result', 'ok', '--dir', cdir]);
  eq('E41 CLI stage --result ok 退出码', cres.status, 0);
  const cfin = runRecordCli(['stage', '--id', cid, '--stage', 'failed', '--dir', cdir]);
  eq('E42 CLI 定稿后再写：退出码', cfin.status, 1);
  check('E42 CLI 定稿后再写：RR_FINALIZED', /^RELEASE_RECORD_FAIL RR_FINALIZED /.test(cfin.lines[0] || ''), cfin.stdout);
  const cbad = runRecordCli(['stage', '--id', cid, '--stage', 'nope', '--dir', cdir]);
  check('E43 CLI 未知阶段：退出码 1 + RR_BAD_STAGE', cbad.status === 1 && /^RELEASE_RECORD_FAIL RR_BAD_STAGE /.test(cbad.lines[0] || ''), cbad.stdout);
  const cimm = runRecordCli(['stage', '--id', cid, '--stage', 'started', '--prev-commit', SHA_C, '--dir', cdir]);
  check('E44 CLI 没有改不可变字段的参数：退出码 2', cimm.status === 2 && /^RELEASE_RECORD_FAIL RR_USAGE /.test(cimm.lines[0] || ''), cimm.stdout);
  const cmis = runRecordCli(['init', '--id', '20261024_141000', '--prev-commit', SHA_A, '--new-commit', SHA_B, '--new-version', '1.0.0', '--prev-running-commit', SHA_C, '--dir', cdir]);
  check('E48 CLI init prevRunning.commit ≠ prevCommit：退出码 1 + RR_PREV_MISMATCH', cmis.status === 1 && /^RELEASE_RECORD_FAIL RR_PREV_MISMATCH /.test(cmis.lines[0] || ''), cmis.stdout);
  const cid2 = '20261024_142000';
  runRecordCli(['init', '--id', cid2, '--prev-commit', SHA_A, '--new-commit', SHA_B, '--new-version', '1.0.0', '--dir', cdir]);
  const cbr = runRecordCli(['stage', '--id', cid2, '--stage', 'backed_up', '--result', 'ok', '--dir', cdir]);
  check('E49 CLI result 与阶段不一致：退出码 1 + RR_BAD_RESULT', cbr.status === 1 && /^RELEASE_RECORD_FAIL RR_BAD_RESULT /.test(cbr.lines[0] || ''), cbr.stdout);
  const cwo = runRecordCli(['stage', '--id', cid2, '--stage', 'backed_up', '--backup', 'E:\\bk\\a.sqlite', '--dir', cdir]);
  const cwo2 = runRecordCli(['stage', '--id', cid2, '--stage', 'started', '--backup', 'E:\\bk\\b.sqlite', '--dir', cdir]);
  check('E49b CLI backup 只写一次：改成不同值 → 退出码 1 + RR_IMMUTABLE', cwo.status === 0 && cwo2.status === 1 && /^RELEASE_RECORD_FAIL RR_IMMUTABLE /.test(cwo2.lines[0] || ''), `${cwo.stdout} ${cwo2.stdout}`);
  const cunk = runRecordCli(['frobnicate', '--dir', cdir]);
  eq('E45 CLI 未知命令：退出码 2', cunk.status, 2);
  const cbsha = runRecordCli(['init', '--id', '20261024_140000', '--prev-commit', 'abc', '--new-commit', SHA_B, '--new-version', '1.0.0', '--dir', cdir]);
  check('E46 CLI 坏 sha：退出码 1 + RR_BAD_SHA', cbsha.status === 1 && /^RELEASE_RECORD_FAIL RR_BAD_SHA /.test(cbsha.lines[0] || ''), cbsha.stdout);
  eq('E47 CLI 目录里只有记录文件', fs.readdirSync(cdir).filter((n) => !/^\d{8}_\d{6}\.json$/.test(n)), []);
}

// ---------------------------------------------------------------- F 判别力

// 每个变异登记：only = 递归调用时只跑哪几节（静态检查 A 每次都跑；'' 表示只跑静态检查）；expect = 期望变红的用例名前缀。
//   判红要求「套件失败」且「至少有一个变红的用例名以期望前缀之一开头」，否则按「变异没有被目标用例抓住」计失败。
//   节：B 正常 / C 失败 / D 竞态 / E 发布记录 / G 进程内（假 fs、核心表计数）
const mut = (name, file, only, expect, edits) => ({ name, file, only, expect, edits });
const MUTATIONS = [
  mut('M1 跳过 integrity 检查', 'backup-db.js', 'C', ['C8'], [["if (!(integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok')) {", 'if (false) {']]),
  mut('M2 跳过核心表非空计数', 'backup-db.js', 'CG', ['C6', 'G4'], [['if (!(n > 0)) throw', 'if (false) throw']]),
  mut('M3 跳过核心表存在检查', 'backup-db.js', 'C', ['C5'], [['if (hit.length === 0) throw', 'if (false) throw']]),
  mut('M4 发布改用 rename（覆盖已存在目标；同时去掉随后的 unlink）', 'backup-db.js', 'D', ['A7', 'D'], [['fs.linkSync(partial, args.out);', 'fs.renameSync(partial, args.out);'], ['fs.unlinkSync(partial);', 'void 0;']]),
  mut('M4b 发布改用 rename，写法绕开静态断言 A7（静态断言 A8「用 linkSync」仍会红；行为上由 D 节竞态用例抓——判红要求命中 D 节）', 'backup-db.js', 'D', ['D'], [['fs.linkSync(partial, args.out);', "fs[['rename', 'Sync'].join('')](partial, args.out);"], ['fs.unlinkSync(partial);', 'void 0;']]),
  mut('M5 失败时删除 .partial', 'backup-db.js', 'CD', ['C3', 'C5', 'C6', 'C8', 'D6'], [['const partialPath = out ? `${out}.partial` : null;', 'const partialPath = out ? `${out}.partial` : null;\n    if (partialPath) { try { fs.unlinkSync(partialPath); } catch (_) { /* ignore */ } }']]),
  mut('M6 不检查 out 是否已存在', 'backup-db.js', 'CG', ['C2', 'G'], [['if (outS.stat) throw', 'if (false) throw']]),
  mut('M7 不检查 .partial 是否已存在', 'backup-db.js', 'CG', ['C3', 'G'], [['if (partS.stat) throw', 'if (false) throw']]),
  mut('M8 接受未知参数', 'backup-db.js', 'C', ['C9a'], [['if (!KNOWN_FLAGS.includes(flag)) throw', 'if (false) throw']]),
  mut('M9 备份脚本 require 仓库内文件', 'backup-db.js', 'B', ['A1', 'A3', 'B1'], [["const path = require('path');", "const path = require('path');\nconst _repoFile = require('./other-file.js');"]]),
  mut('M10 打开模式改为读写（源库与 .partial 都改）', 'backup-db.js', 'C', ['A5', 'C8a'], [['openDb(sqlite3, file, sqlite3.OPEN_READONLY)', 'openDb(sqlite3, file, sqlite3.OPEN_READWRITE)']]),
  mut('M11 不可变字段可改（放行并写入 prevCommit）', 'release-record.js', 'E', ['E19'], [
    ["if (IMMUTABLE_KEYS.includes(k)) throw new RecordError('RR_IMMUTABLE', `${k} 创建后不可改`);", 'if (k === "prevCommit") continue;'],
    ["if (opts.result !== undefined && opts.result !== null) rec.result = opts.result;", "if (opts.result !== undefined && opts.result !== null) rec.result = opts.result;\n  if (opts.prevCommit) rec.prevCommit = opts.prevCommit;"],
  ]),
  mut('M12 result 落定后仍可写', 'release-record.js', 'E', ['E21', 'E22', 'E23', 'E42'], [['if (rec.result !== null) throw new RecordError', 'if (false) throw new RecordError']]),
  mut('M13 init 后不删临时文件（残留）', 'release-record.js', 'E', ['E3', 'E28', 'E47'], [['try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件已无用，删不掉不影响记录 */ }', '']]),
  mut('M14 sha 校验放宽', 'release-record.js', 'E', ['E24', 'E46'], [['const SHA_RE = /^[0-9a-f]{40}$/;', 'const SHA_RE = /^[0-9a-f]+$/;']]),
  mut('M15 重复 init 覆盖旧记录', 'release-record.js', 'E', ['E5', 'E35'], [['fs.linkSync(tmp, file);', 'fs.renameSync(tmp, file);']]),
  mut('M16 阶段白名单不校验', 'release-record.js', 'E', ['E15'], [["if (typeof opts.stage !== 'string' || !STAGES.includes(opts.stage)) throw", 'if (typeof opts.stage !== "string") throw']]),
  // ---- 预筛修复批新增 ----
  mut('X1 integrity_check 改查源库（不查备份）', 'backup-db.js', 'C', ['A9', 'A10', 'C10'], [["integrityRows = await withDb(sqlite3, partial, (db) => allRows(db, 'PRAGMA integrity_check'));", "integrityRows = await withDb(sqlite3, args.db, (db) => allRows(db, 'PRAGMA integrity_check'));"]]),
  mut('X2 核心表检查改查源库（不查备份）——只有静态断言抓得到', 'backup-db.js', '', ['A9', 'A10'], [['const res = await withDb(sqlite3, partial, (db) => checkCoreTables(db, args.coreTables));', 'const res = await withDb(sqlite3, args.db, (db) => checkCoreTables(db, args.coreTables));']]),
  mut('X4 VACUUM INTO 改字符串拼接', 'backup-db.js', 'B', ['A11', 'B18'], [["await runSql(db, 'VACUUM INTO ?', [partial]);", "await runSql(db, `VACUUM INTO '${partial}'`);"]]),
  mut('X5 stage 改直写目标文件（不经临时文件 + rename）', 'release-record.js', 'E', ['E54'], [['const tmp = writeTempFile(dir, id, rec);\n  replaceFile(tmp, file);', 'fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\\n`);']]),
  mut('X6 读记录时不做结构校验', 'release-record.js', 'E', ['E53'], [["if (problem !== null) throw new RecordError('RR_CORRUPT'", "if (false) throw new RecordError('RR_CORRUPT'"]]),
  mut('X7 BACKUP_OK 协议行后多打一个换行', 'backup-db.js', 'B', ['B1x', 'B16x', 'B18', 'C10'], [['emit(`BACKUP_OK ${JSON.stringify(ok)}`);', 'emit(`BACKUP_OK ${JSON.stringify(ok)}\\n`);']]),
  mut('X8 BACKUP_FAIL 协议行后多打一个换行', 'backup-db.js', 'C', ['C'], [['emit(`BACKUP_FAIL ${JSON.stringify(info)}`);', 'emit(`BACKUP_FAIL ${JSON.stringify(info)}\\n`);']]),
  mut('X9 main 开头不再先置 exitCode = 1——只有静态断言抓得到', 'backup-db.js', '', ['A12'], [['process.exitCode = 1;', 'void 0;']]),
  mut('X10 require 后不校验是不是 sqlite3 模块', 'backup-db.js', 'C', ['A14', 'C4'], [["if (!(sqlite3 && typeof sqlite3.Database === 'function' && Number.isInteger(sqlite3.OPEN_READONLY))) {", 'if (false) {']]),
  mut('X11 sourceJournal.journal 恒为 false', 'backup-db.js', 'CG', ['C11', 'G'], [['const j = triState(`${args.db}-journal`, fsImpl);', 'const j = { value: false };']]),
  mut('X12 发布后取文件大小失败会把成功改报失败——只有静态断言抓得到', 'backup-db.js', '', ['A13'], [['try { bytes = fs.statSync(args.out).size; } catch (_) { bytes = null; }', 'bytes = fs.statSync(args.out).size;']]),
  mut('X13 init 不拒绝 prevRunning.commit ≠ prevCommit', 'release-record.js', 'E', ['E50', 'E48'], [['if (prevRunningCommit !== null && prevRunningCommit !== prevCommit) {', 'if (false) {']]),
  mut('X14 backup / attachments 可被覆盖', 'release-record.js', 'E', ['E51', 'E49b'], [['if (opts[k] !== undefined && opts[k] !== null && rec[k] !== null && rec[k] !== opts[k]) {', 'if (false) {']]),
  mut('X15 result 与阶段不校验一致', 'release-record.js', 'E', ['E52', 'E49'], [['if (!RESULT_STAGES[opts.result].includes(opts.stage)) {', 'if (false) {']]),
  mut('X16 history 条目不记 backup / attachments', 'release-record.js', 'E', ['E9', 'E51'], [['{ entry[k] = opts[k]; rec[k] = opts[k]; }', '{ rec[k] = opts[k]; }']]),
  // ---- codex 37 修复批新增 ----
  mut('Z1 核心表计数改回普通对象（先判后写）', 'backup-db.js', 'G', ['G3'], [['const counts = Object.create(null);', 'const counts = {};']]),
  mut('Z2 核心表计数改回普通对象且先写后判（codex 说的绕过原样）', 'backup-db.js', 'G', ['G3', 'G4'], [
    ['const counts = Object.create(null);', 'const counts = {};'],
    ["if (!(n > 0)) throw new BackupError('BK_CORE_TABLE_EMPTY', 'core_tables', `备份里的核心表为空：${t}`);\n    counts[t] = n;", "counts[t] = n;\n    if (counts[t] <= 0) throw new BackupError('BK_CORE_TABLE_EMPTY', 'core_tables', `备份里的核心表为空：${t}`);"],
  ]),
  mut('Z3 参数解析不拒绝 __proto__ 等核心表名', 'backup-db.js', 'C', ['C9'], [['if (bad !== undefined) throw', 'if (false) throw']]),
  mut('Z4 文件系统异常一律当不存在', 'backup-db.js', 'G', ['G1', 'G2'], [['if (e && NOT_FOUND_CODES.includes(e.code)) return { missing: true };', 'if (true) return { missing: true };']]),
  mut('Z5 校验阶段不报 BK_FS_ERROR（源库探测出错时）', 'backup-db.js', 'G', ['G1'], [["if (src.error) throw fsError('源库', args.db, src.error);", 'void 0;']]),
  mut('Z6 失败协议里探测出错也报 false', 'backup-db.js', 'G', ['G2'], [["return { value: 'unknown', probeError: s.error };", 'return { value: false };']]),
  mut('Z7 失败协议不带 partial.probeError', 'backup-db.js', 'G', ['G2'], [['if (t.probeError !== undefined) partial.probeError = t.probeError;', 'void 0;']]),
  mut('Z8 ENOTDIR 不再算「不存在」', 'backup-db.js', 'G', ['G1', 'G2'], [["const NOT_FOUND_CODES = ['ENOENT', 'ENOTDIR'];", "const NOT_FOUND_CODES = ['ENOENT'];"]]),
  mut('Z9 读记录不核对 rollbackTarget === prevCommit', 'release-record.js', 'E', ['E53'], [['if (rec.rollbackTarget !== rec.prevCommit) return', 'if (false) return']]),
  mut('Z10 读记录不核对 result 与阶段相容', 'release-record.js', 'E', ['E53'], [['if (rec.result !== null && !RESULT_STAGES[rec.result].includes(rec.stage)) return', 'if (false) return']]),
  mut('Z11 读记录不核对 prevCommit 必需', 'release-record.js', 'E', ['E53'], [["if (typeof rec.prevCommit !== 'string' || !SHA_RE.test(rec.prevCommit)) return", 'if (false) return']]),
  mut('Z12 读记录不核对 history 末项 stage', 'release-record.js', 'E', ['E53'], [['if (rec.history[rec.history.length - 1].stage !== rec.stage) return', 'if (false) return']]),
  mut('Z13 读记录不核对 prevRunning.commit 与 prevCommit 一致', 'release-record.js', 'E', ['E53'], [['if (pc !== null && pc !== rec.prevCommit) return', 'if (false) return']]),
  mut('Z14 读记录不核对 history 条目的 at', 'release-record.js', 'E', ['E53'], [['if (!isTimeString(h.at)) return', 'if (false) return']]),
];

function copyDeployDir(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const n of fs.readdirSync(DEPLOY_DIR)) {
    const src = path.join(DEPLOY_DIR, n);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, n));
  }
}

/** 一个变异：改临时副本里的被测脚本，递归调用自己（只跑相关节），返回结果；变异点不是恰好出现一次则 applied=false */
async function runMutation(m, idx) {
  const dest = path.join(TMP_ROOT, `mut-${idx}`, 'deploy');
  copyDeployDir(dest);
  const target = path.join(dest, m.file);
  // 被测脚本在线 worktree 里按 core.autocrlf=true 检出为 CRLF，而变异点（X5 / Z2 等）的锚点含 \n：先归一成 LF 再找锚点（只改这份临时副本，不动被测文件）
  let src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of m.edits) {
    const first = src.indexOf(from);
    if (first < 0 || src.indexOf(from, first + 1) >= 0) return { m, applied: false };
    src = src.slice(0, first) + to + src.slice(first + from.length);
  }
  fs.writeFileSync(target, src);
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, `--deploy-dir=${dest}`, '--no-mutations', `--only=${m.only}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    let killedFlag = false;
    let settled = false;
    let giveUp = null;
    const finish = (code) => { if (settled) return; settled = true; clearTimeout(killer); clearTimeout(giveUp); resolve({ code, stdout }); };
    // 超时先 kill；kill 后最多再等 60 秒 close，仍不 close 就按超时收尾（codex 37-R L1）
    const killer = setTimeout(() => {
      killedFlag = true;
      try { child.kill(); } catch (_) { /* 已退出 */ }
      giveUp = setTimeout(() => finish('KILLED'), 60000);
    }, 600000);
    child.on('error', () => finish('SPAWN_ERROR'));
    child.on('close', (code) => finish(killedFlag ? 'KILLED' : code));
  });
  return { m, applied: true, out };
}

async function sectionMutations() {
  console.log('--- F 判别力：变异只在临时副本上做 ---');
  const results = [];
  const queue = MUTATIONS.map((m, i) => [m, i]);
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [m, i] = queue.shift();
      results[i] = await runMutation(m, i);
    }
  });
  await Promise.all(workers);
  for (const res of results) {
    const name = res.m.name;
    if (!check(`F ${name}: 变异点在被测源码里恰好出现一次`, res.applied)) continue;
    const reds = String(res.out.stdout).split('\n').map((l) => /^FAIL (.+?)( :: .*)?\r?$/.exec(l)).filter(Boolean).map((x) => x[1]);
    const summary = /PASS=(\d+) FAIL=(\d+)/.exec(res.out.stdout || '');
    const red = res.out.code !== 0 && summary && Number(summary[2]) > 0;
    const hit = reds.filter((n) => res.m.expect.some((p) => n.startsWith(p)));
    check(`F ${name}: 套件变红`, red, `退出码 ${res.out.code}；${summary ? summary[0] : '无汇总行'}`);
    if (red) check(`F ${name}: 被目标用例抓住（期望前缀 ${res.m.expect.join(' / ')}）`, hit.length > 0, `变红的用例：${reds.slice(0, 6).join(' | ')}`);
    console.log(`MUTATION ${name} => ${!red ? 'STILL GREEN' : (hit.length > 0 ? 'RED' : 'RED-BUT-NOT-TARGET')}（${reds.length} 个用例变红，命中期望前缀 ${hit.length} 个：${reds.slice(0, 10).join(' | ')}${reds.length > 10 ? ' | …' : ''}）`);
  }
  console.log(`MUTATIONS 共 ${MUTATIONS.length} 个`);
}

/** 变异个数与文档一致：本文件头注释、FAMILY 里 S8a 那段注释写的数字都必须等于 MUTATIONS 的实际条数 */
function checkMutationCount() {
  const own = fs.readFileSync(__filename, 'utf8');
  const head = /变异共 (\d+) 个/.exec(own.slice(0, own.indexOf("'use strict'")));
  check('F 头注释里写的变异个数 = MUTATIONS 实际条数', !!head && Number(head[1]) === MUTATIONS.length, `头注释 ${head ? head[1] : '无'}，实际 ${MUTATIONS.length}`);
  let fam = null;
  try { fam = fs.readFileSync(path.join(__dirname, 'run-verify-family.js'), 'utf8'); } catch (_) { fam = null; }
  if (fam !== null) {
    const m = /#106 S8a（W10）[\s\S]*?含 (\d+) 个变异自证/.exec(fam);
    check('F FAMILY 里 S8a 那段注释写的变异个数 = MUTATIONS 实际条数', !!m && Number(m[1]) === MUTATIONS.length, `FAMILY 注释 ${m ? m[1] : '无'}，实际 ${MUTATIONS.length}`);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  try {
    sectionStatic();
    if (runSection('B')) await sectionNormal();
    if (runSection('C')) await sectionFailures();
    if (runSection('G')) await sectionInProcess();
    if (runSection('D')) await sectionRace();
    if (runSection('E')) sectionRecord();
    if (RUN_MUTATIONS) {
      checkMutationCount();
      await sectionMutations();
    }
  } catch (e) {
    check('套件自身未抛出异常', false, e && e.stack);
  } finally {
    try { removeTree(TMP_ROOT); } catch (e) { check('清理临时目录', false, e && e.message); }
    check('临时目录已删除', !fs.existsSync(TMP_ROOT), TMP_ROOT);
  }
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
