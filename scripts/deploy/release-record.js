#!/usr/bin/env node
/**
 * 发布记录（#106 S8a / 方案 W10）：部署脚本在本机逐步写的一份 JSON 记录，回滚时据此知道「回滚目标 = 部署前实际运行的提交」「备份在哪」「走到了哪一步」。
 *
 * 位置：默认 <控制根>/releases/<id>.json；控制根 = <主工作区根>/docs/local/多线并行/_state（与线路登记表同根，不进 git）。
 *   控制根复用 scripts/lines/state.js 的 resolveControlRoot（经 git rev-parse --git-common-dir，在 linked worktree 里运行也落到主工作区）；
 *   只在没传 --dir / dir 时才加载 state.js（它会加载 sqlite3），自检传临时目录，不碰真实控制根。
 * 导出函数 + 命令行两用。调用方：S8c 部署脚本（scripts/deploy-ssh.ps1），每个阶段调一次 stage。
 *
 * 命令行：
 *   init  --id <yyyyMMdd_HHmmss> --prev-commit <sha40> --new-commit <sha40> --new-version <x.y.z> [--prev-running-version <x.y.z|null>] [--prev-running-commit <sha40|null>] [--dir <目录>]
 *         独占创建 <id>.json（已存在即失败）；成功打印文件绝对路径。
 *   stage --id <id> --stage <名> [--note <文字>] [--backup <路径>] [--attachments <路径>] [--result ok|failed] [--dir <目录>]
 *         读 → 改 → 同目录临时文件 + fsync + rename 原子替换；成功打印文件绝对路径。
 *   show  --id <id> [--dir <目录>]      打印 json
 *   latest [--dir <目录>]               打印 id 最大的那条的 json
 *   失败输出一行 `RELEASE_RECORD_FAIL <code> <说明>`（stdout），退出码 1；用法错误（未知命令 / 参数）退出码 2。
 *
 * 规则：
 *   - 阶段名白名单见 STAGES；不校验阶段先后顺序（部署有 backup_failed → restarted_old 等分叉，顺序由部署脚本负责）。
 *   - prevCommit / newCommit / rollbackTarget / prevRunning（以及 schema / id / createdAt / newVersion）创建后不可改：命令行没有对应参数，函数层传入即拒绝（RR_IMMUTABLE）。
 *   - init 时 prevRunning.commit 非 null 且 ≠ prevCommit → 拒绝（RR_PREV_MISMATCH）：回滚目标恒为「部署前实际运行的提交」，
 *     两者不一致说明运行中的代码与仓库不同，必须人工核对。
 *   - backup / attachments 只写一次：已为非 null 时再写不同值 → RR_IMMUTABLE；写相同值视为幂等通过。每次传入的 backup / attachments 同时记在当次 history 条目里。
 *   - result 与阶段一致：result=ok 只能与 stage=done 同用；result=failed 只能与 backup_failed / restarted_old / restart_unverified / ready_failed / failed 同用；
 *     其余组合 → RR_BAD_RESULT。
 *   - 读取（show / latest / stage 的读）时校验整条记录：必需字段与类型、rollbackTarget === prevCommit、prevRunning.commit 非 null 时等于 prevCommit、
 *     result 为 null 或与当前阶段相容、history 每项结构合法且末项 stage === stage；任一不符 RR_CORRUPT（读与写都拒绝，原文件不动）。
 *   - result 一旦非 null，记录定稿，之后任何写入都拒绝（RR_FINALIZED）。
 *   - 单写者假设：部署脚本顺序调用，不做跨进程加锁。
 *   - init 用「同目录临时文件 + fsync + linkSync」发布：既独占（目标已存在 linkSync 即失败）又不会让读者看到写了一半的文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STAGES = Object.freeze(['prepared', 'uploaded', 'stopped', 'backed_up', 'backup_failed', 'restarted_old', 'restart_unverified', 'code_updated', 'started', 'ready', 'ready_failed', 'pulled', 'done', 'failed']);
const RESULTS = Object.freeze(['ok', 'failed']);
const RESULT_STAGES = Object.freeze({ ok: Object.freeze(['done']), failed: Object.freeze(['backup_failed', 'restarted_old', 'restart_unverified', 'ready_failed', 'failed']) });
const IMMUTABLE_KEYS = Object.freeze(['schema', 'id', 'createdAt', 'prevCommit', 'prevRunning', 'newCommit', 'newVersion', 'rollbackTarget']);
const STAGE_OPT_KEYS = Object.freeze(['dir', 'id', 'stage', 'note', 'backup', 'attachments', 'result', 'now']);
const INIT_OPT_KEYS = Object.freeze(['dir', 'id', 'prevCommit', 'newCommit', 'newVersion', 'prevRunningVersion', 'prevRunningCommit', 'now']);

const ID_RE = /^\d{8}_\d{6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const RECORD_FILE_RE = /^(\d{8}_\d{6})\.json$/;

class RecordError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function defaultDir() {
  // 延迟加载：只有没传目录时才需要控制根
  const { resolveControlRoot } = require(path.join(__dirname, '..', 'lines', 'state.js'));
  return path.join(resolveControlRoot({ cwd: __dirname }), 'releases');
}

function resolveDir(dir) {
  if (dir === undefined || dir === null) return defaultDir();
  if (typeof dir !== 'string' || dir === '') throw new RecordError('RR_BAD_ARGS', 'dir 必须是非空字符串');
  return path.resolve(dir);
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new RecordError('RR_BAD_ID', `id 必须是 yyyyMMdd_HHmmss 格式：${String(id)}`);
  return id;
}

function checkSha(name, v) {
  if (typeof v !== 'string' || !SHA_RE.test(v)) throw new RecordError('RR_BAD_SHA', `${name} 必须是 40 位小写十六进制：${String(v)}`);
  return v;
}

function checkVersion(name, v) {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) throw new RecordError('RR_BAD_VERSION', `${name} 必须是 x.y.z 形式：${String(v)}`);
  return v;
}

/** 可空的 sha / 版本：undefined、null、字符串 'null' 都当作 null */
function optionalNull(v) {
  return v === undefined || v === null || v === 'null' ? null : v;
}

function rejectUnknownKeys(opts, allowed) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new RecordError('RR_BAD_ARGS', '参数必须是对象');
  for (const k of Object.keys(opts)) {
    if (allowed.includes(k)) continue;
    if (IMMUTABLE_KEYS.includes(k)) throw new RecordError('RR_IMMUTABLE', `${k} 创建后不可改`);
    throw new RecordError('RR_BAD_ARGS', `不认识的参数：${k}`);
  }
}

function recordPath(dir, id) {
  return path.join(dir, `${id}.json`);
}

function nowIso(now) {
  return now === undefined ? new Date().toISOString() : now;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function tmpNameFor(dir, id) {
  return path.join(dir, `.${id}.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
}

/** 写完整内容到同目录临时文件并 fsync，返回临时文件路径；失败时自己删临时文件 */
function writeTempFile(dir, id, record) {
  const tmp = tmpNameFor(dir, id);
  const buf = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off, null);
      if (!(Number.isInteger(n) && n > 0)) throw new Error(`writeSync 没有进展（返回 ${String(n)}）`);
      off += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return tmp;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw new RecordError('RR_WRITE_FAILED', `写临时文件失败：${e && e.message}`);
  }
}

function initRecord(opts) {
  rejectUnknownKeys(opts, INIT_OPT_KEYS);
  const id = checkId(opts.id);
  const prevCommit = checkSha('prevCommit', opts.prevCommit);
  const newCommit = checkSha('newCommit', opts.newCommit);
  const newVersion = checkVersion('newVersion', opts.newVersion);
  const prevRunningVersion = optionalNull(opts.prevRunningVersion);
  const prevRunningCommit = optionalNull(opts.prevRunningCommit);
  if (prevRunningVersion !== null) checkVersion('prevRunningVersion', prevRunningVersion);
  if (prevRunningCommit !== null) checkSha('prevRunningCommit', prevRunningCommit);
  if (prevRunningCommit !== null && prevRunningCommit !== prevCommit) {
    throw new RecordError('RR_PREV_MISMATCH', `prevRunning.commit（${prevRunningCommit}）与 prevCommit（${prevCommit}）不一致：运行中的代码与仓库不同，请人工核对后再部署`);
  }
  const dir = resolveDir(opts.dir);
  const at = nowIso(opts.now);
  const record = {
    schema: 1,
    id,
    createdAt: at,
    prevCommit,
    prevRunning: { version: prevRunningVersion, commit: prevRunningCommit },
    newCommit,
    newVersion,
    rollbackTarget: prevCommit,
    backup: null,
    attachments: null,
    stage: 'prepared',
    history: [{ stage: 'prepared', at, note: null }],
    result: null,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new RecordError('RR_WRITE_FAILED', `建目录失败 ${dir}：${e && e.message}`);
  }
  const file = recordPath(dir, id);
  const tmp = writeTempFile(dir, id, record);
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new RecordError('RR_EXISTS', `发布记录已存在（不覆盖）：${file}`);
      throw new RecordError('RR_WRITE_FAILED', `发布记录失败 ${file}：${e && e.message}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件已无用，删不掉不影响记录 */ }
  }
  return { file, record };
}

function parseRecord(file, id) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new RecordError('RR_NOT_FOUND', `发布记录不存在：${file}`);
    throw new RecordError('RR_CORRUPT', `读发布记录失败 ${file}：${e && e.message}`);
  }
  let rec;
  try { rec = JSON.parse(text); } catch (e) { throw new RecordError('RR_CORRUPT', `发布记录不是合法 JSON ${file}：${e && e.message}`); }
  const problem = recordProblem(rec, id);
  if (problem !== null) throw new RecordError('RR_CORRUPT', `发布记录结构不对 ${file}：${problem}`);
  return rec;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTimeString = (v) => typeof v === 'string' && v !== '' && !Number.isNaN(Date.parse(v));
const isNullOrNonEmptyString = (v) => v === null || (typeof v === 'string' && v !== '');

/**
 * 读取时的完整校验：返回第一个问题的描述，没有问题返回 null。
 * 必需字段与类型；rollbackTarget === prevCommit；prevRunning.commit 非 null 时等于 prevCommit；
 * result 为 null 或与当前阶段相容（RESULT_STAGES）；history 非空、每项结构 {stage,at,note,…} 合法，且末项 stage === stage。
 */
function recordProblem(rec, id) {
  if (!isPlainObject(rec)) return '顶层不是对象';
  if (rec.schema !== 1) return 'schema 不是 1';
  if (rec.id !== id) return 'id 与文件名不符';
  if (!isTimeString(rec.createdAt)) return 'createdAt 缺失或不是时间字符串';
  if (typeof rec.prevCommit !== 'string' || !SHA_RE.test(rec.prevCommit)) return 'prevCommit 缺失或不是 40 位小写十六进制';
  if (typeof rec.newCommit !== 'string' || !SHA_RE.test(rec.newCommit)) return 'newCommit 缺失或不是 40 位小写十六进制';
  if (typeof rec.newVersion !== 'string' || !VERSION_RE.test(rec.newVersion)) return 'newVersion 缺失或不是 x.y.z';
  if (rec.rollbackTarget !== rec.prevCommit) return 'rollbackTarget 与 prevCommit 不一致';
  if (!isPlainObject(rec.prevRunning)) return 'prevRunning 缺失或不是对象';
  const pv = rec.prevRunning.version;
  const pc = rec.prevRunning.commit;
  if (!(pv === null || (typeof pv === 'string' && VERSION_RE.test(pv)))) return 'prevRunning.version 缺失或不是 null / x.y.z';
  if (!(pc === null || (typeof pc === 'string' && SHA_RE.test(pc)))) return 'prevRunning.commit 缺失或不是 null / 40 位小写十六进制';
  if (pc !== null && pc !== rec.prevCommit) return 'prevRunning.commit 与 prevCommit 不一致';
  if (!isNullOrNonEmptyString(rec.backup)) return 'backup 缺失或不是 null / 非空字符串';
  if (!isNullOrNonEmptyString(rec.attachments)) return 'attachments 缺失或不是 null / 非空字符串';
  if (typeof rec.stage !== 'string' || !STAGES.includes(rec.stage)) return 'stage 不在白名单';
  if (!(rec.result === null || RESULTS.includes(rec.result))) return 'result 不是 null / ok / failed';
  if (rec.result !== null && !RESULT_STAGES[rec.result].includes(rec.stage)) return `result=${rec.result} 与当前阶段 ${rec.stage} 矛盾`;
  if (!Array.isArray(rec.history) || rec.history.length === 0) return 'history 缺失或为空';
  for (let i = 0; i < rec.history.length; i += 1) {
    const h = rec.history[i];
    if (!isPlainObject(h)) return `history[${i}] 不是对象`;
    if (typeof h.stage !== 'string' || !STAGES.includes(h.stage)) return `history[${i}].stage 不在白名单`;
    if (!isTimeString(h.at)) return `history[${i}].at 缺失或不是时间字符串`;
    if (!isNullOrNonEmptyString(h.note)) return `history[${i}].note 缺失或不是 null / 非空字符串`;
    for (const k of ['backup', 'attachments']) {
      if (Object.prototype.hasOwnProperty.call(h, k) && !(typeof h[k] === 'string' && h[k] !== '')) return `history[${i}].${k} 不是非空字符串`;
    }
  }
  if (rec.history[rec.history.length - 1].stage !== rec.stage) return 'history 末项 stage 与 stage 不一致';
  return null;
}

function readRecord({ dir, id } = {}) {
  checkId(id);
  const d = resolveDir(dir);
  const file = recordPath(d, id);
  return { file, record: parseRecord(file, id) };
}

function latestRecord({ dir } = {}) {
  const d = resolveDir(dir);
  let names;
  try { names = fs.readdirSync(d); } catch (e) {
    if (e && e.code === 'ENOENT') throw new RecordError('RR_NOT_FOUND', `发布记录目录不存在：${d}`);
    throw new RecordError('RR_CORRUPT', `读发布记录目录失败 ${d}：${e && e.message}`);
  }
  const ids = names.map((n) => RECORD_FILE_RE.exec(n)).filter(Boolean).map((m) => m[1]).sort();
  if (ids.length === 0) throw new RecordError('RR_NOT_FOUND', `发布记录目录里没有记录：${d}`);
  return readRecord({ dir: d, id: ids[ids.length - 1] });
}

function replaceFile(tmp, file) {
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      lastErr = e;
      if (!(e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY'))) break;
      sleepSync(50 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  throw new RecordError('RR_WRITE_FAILED', `替换发布记录失败 ${file}：${lastErr && lastErr.message}`);
}

function advanceStage(opts) {
  rejectUnknownKeys(opts, STAGE_OPT_KEYS);
  const id = checkId(opts.id);
  if (typeof opts.stage !== 'string' || !STAGES.includes(opts.stage)) throw new RecordError('RR_BAD_STAGE', `未知阶段：${String(opts.stage)}（允许：${STAGES.join(' / ')}）`);
  for (const k of ['note', 'backup', 'attachments']) {
    if (opts[k] !== undefined && opts[k] !== null && (typeof opts[k] !== 'string' || opts[k] === '')) throw new RecordError('RR_BAD_ARGS', `${k} 必须是非空字符串`);
  }
  if (opts.result !== undefined && opts.result !== null) {
    if (!RESULTS.includes(opts.result)) throw new RecordError('RR_BAD_ARGS', `result 只能是 ${RESULTS.join(' / ')}：${String(opts.result)}`);
    if (!RESULT_STAGES[opts.result].includes(opts.stage)) {
      throw new RecordError('RR_BAD_RESULT', `result=${opts.result} 只能与阶段 ${RESULT_STAGES[opts.result].join(' / ')} 同用，不能与 ${opts.stage}`);
    }
  }
  const dir = resolveDir(opts.dir);
  const file = recordPath(dir, id);
  const rec = parseRecord(file, id);
  if (rec.result !== null) throw new RecordError('RR_FINALIZED', `发布记录已定稿（result=${rec.result}），不再接受写入：${file}`);
  for (const k of ['backup', 'attachments']) {
    if (opts[k] !== undefined && opts[k] !== null && rec[k] !== null && rec[k] !== opts[k]) {
      throw new RecordError('RR_IMMUTABLE', `${k} 已写入（${rec[k]}），只写一次，不能改成 ${opts[k]}`);
    }
  }
  const at = nowIso(opts.now);
  rec.stage = opts.stage;
  const entry = { stage: opts.stage, at, note: opts.note === undefined ? null : opts.note };
  for (const k of ['backup', 'attachments']) {
    if (opts[k] !== undefined && opts[k] !== null) { entry[k] = opts[k]; rec[k] = opts[k]; }
  }
  rec.history.push(entry);
  if (opts.result !== undefined && opts.result !== null) rec.result = opts.result;
  const tmp = writeTempFile(dir, id, rec);
  replaceFile(tmp, file);
  return { file, record: rec };
}

// ---------------------------------------------------------------- 命令行

const CLI_FLAGS = {
  init: ['--id', '--prev-commit', '--new-commit', '--new-version', '--prev-running-version', '--prev-running-commit', '--dir'],
  stage: ['--id', '--stage', '--note', '--backup', '--attachments', '--result', '--dir'],
  show: ['--id', '--dir'],
  latest: ['--dir'],
};

class UsageError extends Error {}

function parseCli(argv) {
  const cmd = argv[0];
  if (!Object.prototype.hasOwnProperty.call(CLI_FLAGS, cmd)) throw new UsageError(`未知命令：${String(cmd)}（init / stage / show / latest）`);
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!CLI_FLAGS[cmd].includes(flag)) throw new UsageError(`${cmd} 不认识的参数：${flag}`);
    if (Object.prototype.hasOwnProperty.call(values, flag)) throw new UsageError(`参数重复：${flag}`);
    const v = argv[i + 1];
    if (typeof v !== 'string' || v === '' || v.startsWith('--')) throw new UsageError(`参数缺少取值：${flag}`);
    values[flag] = v;
  }
  const need = { init: ['--id', '--prev-commit', '--new-commit', '--new-version'], stage: ['--id', '--stage'], show: ['--id'], latest: [] }[cmd];
  for (const f of need) if (!Object.prototype.hasOwnProperty.call(values, f)) throw new UsageError(`${cmd} 缺少参数：${f}`);
  return { cmd, values };
}

function runCli(argv) {
  const { cmd, values } = parseCli(argv);
  const dir = values['--dir'];
  if (cmd === 'init') {
    const r = initRecord({
      dir,
      id: values['--id'],
      prevCommit: values['--prev-commit'],
      newCommit: values['--new-commit'],
      newVersion: values['--new-version'],
      prevRunningVersion: values['--prev-running-version'],
      prevRunningCommit: values['--prev-running-commit'],
    });
    return r.file;
  }
  if (cmd === 'stage') {
    const r = advanceStage({
      dir,
      id: values['--id'],
      stage: values['--stage'],
      note: values['--note'],
      backup: values['--backup'],
      attachments: values['--attachments'],
      result: values['--result'],
    });
    return r.file;
  }
  const r = cmd === 'show' ? readRecord({ dir, id: values['--id'] }) : latestRecord({ dir });
  return JSON.stringify(r.record, null, 2);
}

function main() {
  try {
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (e) {
    const usage = e instanceof UsageError;
    const code = usage ? 'RR_USAGE' : (e && e.code) || 'RR_UNEXPECTED';
    const msg = String(e && e.message).replace(/\s*[\r\n]+\s*/g, ' ');
    process.stdout.write(`RELEASE_RECORD_FAIL ${code} ${msg}\n`);
    process.exitCode = usage ? 2 : 1;
  }
}

module.exports = { STAGES, IMMUTABLE_KEYS, RecordError, initRecord, advanceStage, readRecord, latestRecord, defaultDir };

if (require.main === module) main();
