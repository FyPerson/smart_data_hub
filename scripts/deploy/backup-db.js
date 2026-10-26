#!/usr/bin/env node
/**
 * 部署用一次性数据库备份脚本（#106 S8a / 方案 W10）。
 *
 * 用途：在生产机「已停服」之后，把活库用 VACUUM INTO 做成一份自洽的备份，并在发布前校验它；校验过了才以最终文件名出现。
 * 调用方：S8c 的部署脚本（scripts/deploy-ssh.ps1）——上传到生产临时目录，经 ssh 在生产上执行，读 stdout 的协议行判结果。
 *   调用方只认协议行的字面前缀 `BACKUP_OK `，不看退出码（退出码只作辅助；本脚本在开头就把 exitCode 置 1，只有成功路径置 0，
 *   所以事件循环意外排空也不会以 0 退出而没有协议行）。不要把 stderr 合并进 stdout（2>&1）。
 * 前提：服务已停（本脚本不管停服，也不假设活库没有写入者；只读打开源库，不写源库、不改 journal 模式、不设 PRAGMA）。
 * 独立可上传：只 require 内置模块；sqlite3 由 --sqlite3 <sqlite3 模块目录> 给出，以绝对路径加载。不得 require 仓库内任何文件。
 *
 * 命令行：node backup-db.js --sqlite3 <dir> --db <源库> --out <备份文件> [--core-tables task_pool,users]
 *   未知参数、缺参数、重复参数、位置参数 → BK_ARGS（退出码 2）。
 *
 * 步骤：
 *   1 校验：--db 存在且是文件；--out 与 <out>.partial 都不存在；--out 所在目录存在。只有 ENOENT / ENOTDIR 算「不存在」；
 *     其他文件系统错误（权限、IO 等）无法确认状态，报 BK_FS_ERROR（stage validate，message 带原错误码，退出码 1），不冒充「不存在」。
 *   2 只读打开源库：先读表个数（sqlite_master 中 type='table'），再 VACUUM INTO ?（参数绑定）写到 <out>.partial，关库。
 *   3 只读打开 <out>.partial：PRAGMA integrity_check 必须恰好一行 ok；每张核心表存在且 COUNT(*) > 0；表个数等于源库。关库。
 *   4 发布：fs.linkSync(partial, out)（目标已存在即失败，不覆盖）后 fs.unlinkSync(partial)。不用 renameSync（Windows 上会覆盖已存在目标）。
 *
 * 输出协议：stdout 以唯一一条协议行结尾，协议行后恰好一个 \n：`BACKUP_OK <json>` 或 `BACKUP_FAIL <json>`（stdout 里不会有第二条协议行）。
 *   OK 的 json：out、bytes（发布后取不到文件大小时为 null，仍报 OK）、tables、core（各核心表行数）、integrity:"ok"。
 *   FAIL 的 json：code、stage、message、out、partial:{path,exists}（.partial 是否残留及路径）、
 *     sourceJournal:{journal,wal}（源库旁 -journal / -wal 文件是否存在；热日志时 VACUUM INTO 会报 SQLITE_READONLY，
 *     那不是权限问题，是源库有未回滚的日志，只读连接无法回滚；参数错误在解析参数之前失败时为 null）。
 *     partial.exists、sourceJournal.journal / .wal 是三态：true / false / "unknown"。只有 ENOENT / ENOTDIR 才是 false；
 *     探测本身出错（权限、IO）时为 "unknown"，并附 probeError（partial.probeError = 错误码；sourceJournal.probeError = {journal?,wal?} 的错误码）。
 *     调用方不得把 "unknown" 当 false 处理（那表示「无法确认」，要人工核对）。
 *   退出码：OK = 0；FAIL = 1；参数错误 = 2（也打 BACKUP_FAIL）。
 * 错误码（固定集合）：BK_ARGS、BK_SQLITE_LOAD、BK_SOURCE_MISSING、BK_OUT_EXISTS、BK_FS_ERROR、BK_VACUUM_FAILED、BK_INTEGRITY_FAILED、
 *   BK_CORE_TABLE_MISSING、BK_CORE_TABLE_EMPTY、BK_TABLE_COUNT_MISMATCH、BK_PUBLISH_FAILED。
 *
 * 作为模块被 require 时（自检用）只导出纯函数，不执行 main：statState / triState / validate / checkCoreTables / buildFailInfo，
 *   其中涉及文件系统的函数都接受注入的 fs 对象（默认真实 fs），自检用假 fs 验证三态与 BK_FS_ERROR；生产路径传的就是真实 fs。
 *
 * 失败时不清理：.partial 原样保留并在 json 里报出（在场工具失败只报告、不自动修复）。只有成功路径会动 .partial（link + unlink）。
 *   .partial 不会被本脚本发布；但它的文件名仍可能被 glob（例如 task_pool.db.backup_*）匹配到，所以使用方必须按发布记录里的精确路径取备份，
 *   不得用 glob 挑「最新」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWN_FLAGS = ['--sqlite3', '--db', '--out', '--core-tables'];
const DEFAULT_CORE_TABLES = ['task_pool', 'users'];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_TABLE_NAMES = ['__proto__', 'constructor', 'prototype'];   // 不接受做核心表名（计数映射的键）
const NOT_FOUND_CODES = ['ENOENT', 'ENOTDIR'];

class BackupError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.code = code;
    this.stage = stage;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.includes(flag)) throw new BackupError('BK_ARGS', 'args', `未知参数或位置参数：${flag}`);
    if (Object.prototype.hasOwnProperty.call(values, flag)) throw new BackupError('BK_ARGS', 'args', `参数重复：${flag}`);
    const v = argv[i + 1];
    if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw new BackupError('BK_ARGS', 'args', `参数缺少取值：${flag}`);
    values[flag] = v;
  }
  for (const f of ['--sqlite3', '--db', '--out']) {
    if (!Object.prototype.hasOwnProperty.call(values, f)) throw new BackupError('BK_ARGS', 'args', `缺少参数：${f}`);
  }
  let core = DEFAULT_CORE_TABLES.slice();
  if (Object.prototype.hasOwnProperty.call(values, '--core-tables')) {
    core = values['--core-tables'].split(',').map((s) => s.trim());
    if (core.length === 0 || core.some((n) => !IDENT_RE.test(n))) throw new BackupError('BK_ARGS', 'args', '--core-tables 必须是逗号分隔的表名（字母数字下划线，不得为空）');
    if (new Set(core).size !== core.length) throw new BackupError('BK_ARGS', 'args', '--core-tables 有重复表名');
    const bad = core.find((n) => FORBIDDEN_TABLE_NAMES.includes(n));
    if (bad !== undefined) throw new BackupError('BK_ARGS', 'args', `--core-tables 不接受表名 ${bad}`);
  }
  return {
    sqlite3Dir: path.resolve(values['--sqlite3']),
    db: path.resolve(values['--db']),
    out: path.resolve(values['--out']),
    coreTables: core,
  };
}

/**
 * 取元数据，三种结果：{ stat }（存在）、{ missing: true }（确认不存在：只有 ENOENT / ENOTDIR）、{ error: <错误码> }（无法确认）。
 * follow = true 用 statSync（跟随链接），false 用 lstatSync（链接本身算存在）。fsImpl 默认真实 fs，自检注入假 fs。
 */
function statState(p, follow, fsImpl) {
  const f = fsImpl || fs;
  try {
    return { stat: follow ? f.statSync(p) : f.lstatSync(p) };
  } catch (e) {
    if (e && NOT_FOUND_CODES.includes(e.code)) return { missing: true };
    return { error: (e && e.code) || 'UNKNOWN' };
  }
}

/** 三态存在性（失败协议里用）：{ value: true | false | "unknown", probeError? } */
function triState(p, fsImpl) {
  const s = statState(p, false, fsImpl);
  if (s.stat) return { value: true };
  if (s.missing) return { value: false };
  return { value: 'unknown', probeError: s.error };
}

/** 步骤 1 校验（纯文件系统检查，fsImpl 可注入）。无法确认的文件系统错误报 BK_FS_ERROR，不当作「不存在」 */
function validate(args, fsImpl) {
  const partial = `${args.out}.partial`;
  const fsError = (what, p, code) => new BackupError('BK_FS_ERROR', 'validate', `无法确认${what}的状态（${code}），不当作「不存在」处理：${p}`);
  const src = statState(args.db, true, fsImpl);
  if (src.error) throw fsError('源库', args.db, src.error);
  if (src.missing || !src.stat.isFile()) throw new BackupError('BK_SOURCE_MISSING', 'validate', `源库不存在或不是普通文件：${args.db}`);
  const outS = statState(args.out, false, fsImpl);
  if (outS.error) throw fsError('目标备份文件', args.out, outS.error);
  if (outS.stat) throw new BackupError('BK_OUT_EXISTS', 'validate', `目标备份文件已存在（不覆盖）：${args.out}`);
  const partS = statState(partial, false, fsImpl);
  if (partS.error) throw fsError('.partial 文件', partial, partS.error);
  if (partS.stat) throw new BackupError('BK_OUT_EXISTS', 'validate', `残留的 .partial 已存在（不覆盖、不清理，请人工确认）：${partial}`);
  const dir = statState(path.dirname(args.out), true, fsImpl);
  if (dir.error) throw fsError('--out 所在目录', path.dirname(args.out), dir.error);
  if (dir.missing || !dir.stat.isDirectory()) throw new BackupError('BK_ARGS', 'validate', `--out 所在目录不存在：${path.dirname(args.out)}`);
}

// sqlite3 回调风格 → Promise。只用到 open / all / get / run / close。
const openDb = (sqlite3, file, mode) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
});
const allRows = (db, sql, params) => new Promise((resolve, reject) => {
  db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows)));
});
const runSql = (db, sql, params) => new Promise((resolve, reject) => {
  db.run(sql, params || [], (err) => (err ? reject(err) : resolve()));
});
const closeDb = (db) => new Promise((resolve, reject) => {
  db.close((err) => (err ? reject(err) : resolve()));
});

/** 打开 → 干活 → 关库；干活失败时仍尽力关库，关库错误不盖住原错误 */
async function withDb(sqlite3, file, fn) {
  const db = await openDb(sqlite3, file, sqlite3.OPEN_READONLY);
  let result;
  try {
    result = await fn(db);
  } catch (e) {
    try { await closeDb(db); } catch (_) { /* 保留原错误 */ }
    throw e;
  }
  await closeDb(db);
  return result;
}

async function countTables(db) {
  const rows = await allRows(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
  return rows[0].n;
}

function errText(e) {
  return `${e && e.code ? `${e.code}：` : ''}${e && e.message ? e.message : String(e)}`;
}

/**
 * 核心表检查（在已打开的备份库上）：每张表存在且 COUNT(*) > 0。返回 { counts, tables }。
 * counts 是无原型对象，且先把计数放进局部变量判非空、再写入映射——表名即使是 __proto__ 之类也不会走继承的 setter 绕过空表检查
 * （参数解析另外拒绝了这几个名字，这里是第二道）。
 */
async function checkCoreTables(db, coreTables) {
  const counts = Object.create(null);
  for (const t of coreTables) {
    const hit = await allRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [t]);
    if (hit.length === 0) throw new BackupError('BK_CORE_TABLE_MISSING', 'core_tables', `备份里缺核心表：${t}`);
    const c = await allRows(db, `SELECT count(*) AS n FROM "${t}"`);
    const n = c[0].n;
    if (!(n > 0)) throw new BackupError('BK_CORE_TABLE_EMPTY', 'core_tables', `备份里的核心表为空：${t}`);
    counts[t] = n;
  }
  return { counts, tables: await countTables(db) };
}

async function backup(args) {
  const partial = `${args.out}.partial`;

  // 1 校验
  validate(args, fs);

  let sqlite3;
  const sqliteModuleDir = args.sqlite3Dir;
  try {
    sqlite3 = require(sqliteModuleDir);
  } catch (e) {
    throw new BackupError('BK_SQLITE_LOAD', 'load_sqlite3', `加载 sqlite3 模块失败（${sqliteModuleDir}）：${errText(e)}`);
  }
  if (!(sqlite3 && typeof sqlite3.Database === 'function' && Number.isInteger(sqlite3.OPEN_READONLY))) {
    throw new BackupError('BK_SQLITE_LOAD', 'load_sqlite3', `${sqliteModuleDir} 能加载但不是 sqlite3 模块（缺 Database 或 OPEN_READONLY）`);
  }

  // 2 只读打开源库：表个数，再 VACUUM INTO
  let sourceTables;
  try {
    sourceTables = await withDb(sqlite3, args.db, async (db) => {
      const n = await countTables(db);
      await runSql(db, 'VACUUM INTO ?', [partial]);
      return n;
    });
  } catch (e) {
    throw new BackupError('BK_VACUUM_FAILED', 'vacuum_into', `源库读取或 VACUUM INTO 失败：${errText(e)}`);
  }

  // 3 只读打开 .partial 校验：integrity_check，再核心表与表个数
  let core;
  let partialTables;
  let integrityRows;
  try {
    integrityRows = await withDb(sqlite3, partial, (db) => allRows(db, 'PRAGMA integrity_check'));
  } catch (e) {
    throw new BackupError('BK_INTEGRITY_FAILED', 'integrity_check', `备份文件无法完成完整性检查：${errText(e)}`);
  }
  if (!(integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok')) {
    const shown = integrityRows.slice(0, 5).map((r) => r.integrity_check).join(' | ');
    throw new BackupError('BK_INTEGRITY_FAILED', 'integrity_check', `integrity_check 未返回恰好一行 ok（共 ${integrityRows.length} 行，前几行：${shown}）`);
  }

  try {
    const res = await withDb(sqlite3, partial, (db) => checkCoreTables(db, args.coreTables));
    core = res.counts;
    partialTables = res.tables;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('BK_INTEGRITY_FAILED', 'core_tables', `核心表检查出错：${errText(e)}`);
  }
  if (partialTables !== sourceTables) {
    throw new BackupError('BK_TABLE_COUNT_MISMATCH', 'table_count', `表个数不一致：源库 ${sourceTables}，备份 ${partialTables}`);
  }

  // 4 发布：硬链接（目标已存在即失败）后删 .partial
  try {
    fs.linkSync(partial, args.out);
  } catch (e) {
    throw new BackupError('BK_PUBLISH_FAILED', 'publish_link', `发布（link）失败：${errText(e)}`);
  }
  try {
    fs.unlinkSync(partial);
  } catch (e) {
    throw new BackupError('BK_PUBLISH_FAILED', 'publish_unlink', `备份已发布到 ${args.out}，但删除 .partial 失败：${errText(e)}`);
  }
  // 备份已经发布：取文件大小失败不能把成功改报成失败
  let bytes = null;
  try { bytes = fs.statSync(args.out).size; } catch (_) { bytes = null; }
  return { out: args.out, bytes, tables: partialTables, core, integrity: 'ok' };
}

function emit(line) {
  process.stdout.write(`${line}\n`);
}

/** 失败协议的 json（存在性探测三态；fsImpl 可注入，自检用） */
function buildFailInfo(err, args, fsImpl) {
  const out = args ? args.out : null;
  const partialPath = out ? `${out}.partial` : null;
  const partial = { path: partialPath, exists: false };
  if (partialPath) {
    const t = triState(partialPath, fsImpl);
    partial.exists = t.value;
    if (t.probeError !== undefined) partial.probeError = t.probeError;
  }
  let sourceJournal = null;
  if (args) {
    const j = triState(`${args.db}-journal`, fsImpl);
    const w = triState(`${args.db}-wal`, fsImpl);
    sourceJournal = { journal: j.value, wal: w.value };
    const pe = {};
    if (j.probeError !== undefined) pe.journal = j.probeError;
    if (w.probeError !== undefined) pe.wal = w.probeError;
    if (Object.keys(pe).length > 0) sourceJournal.probeError = pe;
  }
  return { code: err.code, stage: err.stage, message: err.message, out, partial, sourceJournal };
}

async function main() {
  process.exitCode = 1;   // 失败是默认：只有成功路径把它改成 0（事件循环意外排空也不会以 0 退出）
  let args = null;
  try {
    args = parseArgs(process.argv.slice(2));
    const ok = await backup(args);
    emit(`BACKUP_OK ${JSON.stringify(ok)}`);
    process.exitCode = 0;
  } catch (e) {
    const err = e instanceof BackupError ? e : new BackupError('BK_VACUUM_FAILED', 'unexpected', `未预期的错误：${errText(e)}`);
    const info = buildFailInfo(err, args, fs);
    emit(`BACKUP_FAIL ${JSON.stringify(info)}`);
    process.exitCode = err.code === 'BK_ARGS' ? 2 : 1;
  }
}

if (require.main === module) main();
module.exports = { statState, triState, validate, checkCoreTables, buildFailInfo, BackupError };
