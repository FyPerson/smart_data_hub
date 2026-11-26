'use strict';
// #212 第一步 C1c：变异自检驱动的「机器基线」输出助手（只加输出，不改任何判定）。
//   方案 5.4：基线 = 每条变异在哪个用例、哪条断言信息上失败。各驱动在环境变量 SYSBUILD_MUT_RECORD=1 时多打两种单行 JSON：
//     @@CASE {case, errorClass, message, site, frames, caseSite, runnerSeen}   子进程里每个失败用例一行（紧跟在原有「✗ 用例名」输出之后）
//     @@MUT  {group, id, verdict, failures:[{case,errorClass,message,site,frames,caseSite,runnerSeen,label}], note?}   父进程里每条变异结束时一行
//   不设这个变量时 enabled() 为 false，调用方一律不打印，驱动的输出与行为逐字节不变。本模块不读写文件、不起进程；
//   仅有的加载期副作用也只在开关打开时发生：把 Error.stackTraceLimit 抬到 STACK_LIMIT（默认 10 会把外层帧截掉，caseSite 就取不到）。
//
// 字段口径（与 build-mutation-baseline.js 的解析一致）：
//   verdict   判红 / 未判红 / 异常 / 锚点失败（取驱动自己的结论，不在这里改判；「红但没命中期望」等驱动自判为失败的情形记 未判红，原因写 note）
//   case      失败用例名（守卫类驱动记规则号，如 S2；部署守卫记失败标签原文）
//   errorClass 异常类名（AssertionError / TypeError / …）；守卫类驱动（失败不是异常）记 GuardFail；父进程判不了时为 null
//   message   失败信息首行；守卫类驱动取 `FAIL [Sx] 文件:行 信息` 原文
//   site      栈里第一个落在 wbs-server/scripts/ 或 scripts/sysbuild-predeploy/ 下的帧，转成仓库相对路径 `文件:行`；取不到为 null
//   frames    栈里全部落在上述两个目录下的帧，仓库相对 `文件:行`，由内到外，最多 FRAME_LIMIT（12）个；没有栈（守卫类 / 异常记录）为 []
//   caseSite  用例体里的那一帧（HIGH-3：断言写在共用助手里时 site 只是助手那一行，要靠它区分「业务断言」与「搭数据」）。认定办法：
//             在全部落目录帧里找「运行器帧」（RUNNER_FRAMES 表，由内到外数最外层的一个），caseSite = 紧挨着它里面的那一帧（运行器调用的就是用例体，
//             这一帧是用例体里发起失败调用的那一行）；运行器帧就是最里面的帧（失败由运行器自己抛，如超时）→ null；栈里一个运行器帧都没有（见下「为什么」）
//             → 取最外层的那一帧；没有栈（守卫类 GuardFail / 异常记录）→ null。
//             不用「最外层的、不属于运行器的帧」：迁移 / 存档 / 只读三个驱动的 `test()` 包装器被一个匿名 async 主函数 `await test(...)` 调用，
//             主函数的那一帧（匿名，与用例体同样没有函数名）在运行器外面，按「最外层非运行器」会取到它，所有用例的 caseSite 都成了 `await test(` 那一行。
//   runnerSeen 栈里是否出现了运行器帧（false = caseSite 是按「最外层」兜底取的；守卫类 / 异常记录为 null）
//   label     browser = 断言信息里命中的 expectFailure 原文（命不中为 null，message 仍填首行）；deploy = 实际观察到的失败标签原文；其他组 null
//
// 运行器帧表（逐个驱动读代码认定；帧 = 仓库相对文件 + 函数名；函数名取栈里 `at [async] 函数名 (路径:行:列)` 的函数名，匿名为空串）：
//   api         wbs-server/scripts/lib/sysbuild-api-suite.js        runAll           `const r = await c.fn();`（用例体直接被 await，同步段与 async 段都带 runAll 帧）
//   browser     wbs-server/scripts/lib/sysbuild-browser-suite.js    run / Object.run `await task(page)`（按场景名选出 [名字, 函数, 谁] 再逐个调用；场景函数是 run 里的匿名箭头，没有函数名；
//                 驱动以 `suite.run(...)` 方法形式调用，V8 把函数名写成 `Object.run`——第一次全量记录里 104 条浏览器失败全部 runnerSeen=false 就是只认了 `run`，C1c 修订后两种写法都认）
//   schema      wbs-server/scripts/verify-sysbuild-schema.js        runAll           `await t.fn();`
//   db          wbs-server/scripts/verify-sysbuild-db.js            runAll / withTimeout / Timeout.<anonymous>（Node 24 实测：`setTimeout(() => rej(new Error(..)))` 里的箭头在栈里叫 Timeout.<anonymous>；也兼容 Timeout._onTimeout）
//                 `await withTimeout(c.fn(), 20000, c.name)`。C1c 修订二按已提交基线实测更正：db 65 条失败、attachments 199 条失败，栈里全都有运行器帧（runnerSeen=true；非超时的失败栈里有 runAll 帧，
//                 db 在 :881、attachments 在 :1489，runAll 里 `await withTimeout(c.fn(…))` 那一行；没有「Promise.race 截断异步栈」这回事，修订一的注释这么写过，不对）。caseSite = null 的只有 db 的 4 条：都是 R4-回滚失败再次取锁 里用例体自己写的 `withTimeout(…, 8000, …)`（verify-sysbuild-db.js 约 390 / 402 / 421 / 800 行）超时——
//                 失败由 withTimeout 里的定时器回调抛出，栈只有 Timeout.<anonymous> 一帧（第 61 行）→ 它本身就是运行器帧、里面没有别的帧，caseSite=null。
//                 外层 `withTimeout(c.fn(), 20000, c.name)` 的超时同理。
//   attachments wbs-server/scripts/verify-sysbuild-attachments.js   runAll / withTimeout / Timeout.<anonymous>（同 db；`await withTimeout(c.fn(fx), 90000, c.name)`）
//                 另：c.fresh 用例的 `await makeFixture()` 在 runAll 里、用例体之前，它失败时 caseSite 是 makeFixture 里的帧（夹具失败，不是用例体）——属于 runAll 自己的搭数据，登记在此
//   migration   scripts/sysbuild-predeploy/verify-schema-migration.cjs   test    `try { await body(); ...`（子进程把每个用例的 error.stack 写进 results.json；父进程取回）
//   archive     scripts/sysbuild-predeploy/verify-archive.cjs        test             同上
//   readonly    scripts/sysbuild-predeploy/verify-readonly.cjs       test             同上
//   static / deploy  守卫类：失败不是异常，没有栈 → frames=[]、caseSite=null，不需要运行器帧
// 表里没有的文件（新驱动）不会有 runnerSeen=true，caseSite 落到「最外层」兜底；新驱动要把自己的运行器帧补进这张表（build-mutation-baseline.js --self-test 会校验表里每个文件存在）。

const VERDICT = Object.freeze({ RED: '判红', WEAK: '未判红', ABNORMAL: '异常', ANCHOR: '锚点失败' });
const SITE_RE = /((?:wbs-server\/scripts|scripts\/sysbuild-predeploy)\/[^\s():]+?\.(?:js|cjs|mjs)):(\d+)(?::\d+)?/;
const FRAME_LIMIT = 12;
const STACK_LIMIT = 80;
// src = 运行器函数在该文件源码里的名字（自检核对文件里真有这个函数；fn 是栈里可能出现的写法）；
// defs = 定义形态（自检要求每个都在该文件源码里匹配到：锚定到 `async function runAll(` / `const test = async (` 这样的定义写法，不是只在文件里搜到 run / test 这个词——
//   那个词在任何文件里都搜得到，函数被改名 / 删掉自检也不会红，C1c 修订二 L2）。
const RUNNER_FRAMES = Object.freeze([
  Object.freeze({ group: 'api', file: 'wbs-server/scripts/lib/sysbuild-api-suite.js', src: 'runAll', fn: /^runAll$/, defs: Object.freeze([/^async function runAll\(/m]) }),
  Object.freeze({ group: 'browser', file: 'wbs-server/scripts/lib/sysbuild-browser-suite.js', src: 'run', fn: /^(?:Object\.)?run$/, defs: Object.freeze([/^async function run\(/m]) }),
  Object.freeze({ group: 'schema', file: 'wbs-server/scripts/verify-sysbuild-schema.js', src: 'runAll', fn: /^runAll$/, defs: Object.freeze([/^async function runAll\(/m]) }),
  Object.freeze({ group: 'db', file: 'wbs-server/scripts/verify-sysbuild-db.js', src: 'withTimeout', fn: /^(?:runAll|withTimeout|Timeout\.(?:_onTimeout|<anonymous>))$/, defs: Object.freeze([/^async function runAll\(/m, /^function withTimeout\(/m]) }),
  Object.freeze({ group: 'attachments', file: 'wbs-server/scripts/verify-sysbuild-attachments.js', src: 'withTimeout', fn: /^(?:runAll|withTimeout|Timeout\.(?:_onTimeout|<anonymous>))$/, defs: Object.freeze([/^async function runAll\(/m, /^function withTimeout\(/m]) }),
  Object.freeze({ group: 'migration', file: 'scripts/sysbuild-predeploy/verify-schema-migration.cjs', src: 'test', fn: /^test$/, defs: Object.freeze([/^\s*const test = async \(/m]) }),
  Object.freeze({ group: 'archive', file: 'scripts/sysbuild-predeploy/verify-archive.cjs', src: 'test', fn: /^test$/, defs: Object.freeze([/^\s*const test = async \(/m]) }),
  Object.freeze({ group: 'readonly', file: 'scripts/sysbuild-predeploy/verify-readonly.cjs', src: 'test', fn: /^test$/, defs: Object.freeze([/^\s*const test = async \(/m]) }),
]);

function enabled() { return process.env.SYSBUILD_MUT_RECORD === '1'; }
if (enabled() && !(Error.stackTraceLimit >= STACK_LIMIT)) Error.stackTraceLimit = STACK_LIMIT;

const firstLine = (s) => String(s === undefined || s === null ? '' : s).split(/\r?\n/)[0].trim();

// 栈文本 → 第一个落在测试脚本目录下的帧（只看以 at 开头的帧行，错误信息里写到的路径不算）。
function siteOfStack(stack) {
  for (const raw of String(stack || '').split('\n')) {
    const line = raw.trim();
    if (!/^at\s/.test(line)) continue;
    const m = SITE_RE.exec(line.replace(/\\/g, '/'));
    if (m) return m[1] + ':' + m[2];
  }
  return null;
}

// 一行栈帧 → { file, line, fn, text }；不是帧行或不在测试脚本目录下 → null。fn：`at [async] 函数名 (位置)` 的函数名（去掉 async 前缀；没有括号 / 匿名为空串）。
function parseFrame(raw) {
  const line = raw.trim();
  if (!/^at\s/.test(line)) return null;
  const m = SITE_RE.exec(line.replace(/\\/g, '/'));
  if (!m) return null;
  const body = line.slice(3).trim();
  const p = /^(.*?)\s+\(.*\)$/.exec(body);
  const fn = p ? p[1].replace(/^async\s+/, '').trim() : '';
  return { file: m[1], line: Number(m[2]), fn, text: m[1] + ':' + m[2] };
}
const isRunnerFrame = (f) => RUNNER_FRAMES.some((r) => r.file === f.file && r.fn.test(f.fn));

// 栈文本 → { site, frames, caseSite, runnerSeen }（口径见文件头）。
function callSites(stack) {
  const all = [];
  for (const raw of String(stack || '').split('\n')) {
    const f = parseFrame(raw);
    if (f) all.push(f);
  }
  if (all.length === 0) return { site: null, frames: [], caseSite: null, runnerSeen: false };
  let ri = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) if (isRunnerFrame(all[i])) { ri = i; break; }
  let caseSite;
  if (ri === -1) caseSite = all[all.length - 1].text;
  else caseSite = ri === 0 ? null : all[ri - 1].text;
  return { site: siteOfStack(stack), frames: all.slice(0, FRAME_LIMIT).map((f) => f.text), caseSite, runnerSeen: ri !== -1 };
}

// 栈文本（或 `error.stack` 序列化后的字符串）→ { errorClass, message }：首行形如 `AssertionError [ERR_ASSERTION]: 信息` / `TypeError: 信息` / `Error: 信息`。
function headOfStack(stack) {
  const head = firstLine(stack);
  const m = /^([A-Za-z_$][\w$]*)(?: \[[^\]]+\])?(?::\s?(.*))?$/.exec(head);
  if (!m) return { errorClass: null, message: head };
  return { errorClass: m[1], message: m[2] === undefined ? '' : m[2] };
}

function failureOfError(name, e) {
  const isObj = e !== null && typeof e === 'object';
  const cs = isObj ? callSites(e.stack) : { site: null, frames: [], caseSite: null, runnerSeen: null };
  return {
    case: name,
    errorClass: isObj ? (e.name || (e.constructor && e.constructor.name) || 'Error') : 'NonError',
    message: firstLine(isObj ? e.message : e),
    site: cs.site,
    frames: cs.frames,
    caseSite: cs.caseSite,
    runnerSeen: cs.runnerSeen,
    label: null,
  };
}

// 迁移 / 存档 / 只读三类驱动：子进程把每个用例的 { name, passed, error: 栈文本 } 写进 results.json；父进程从中取失败用例。
function failuresOfSummary(summary) {
  if (!summary || !Array.isArray(summary.results)) return [];
  return summary.results.filter((r) => !r.passed).map((r) => {
    const h = headOfStack(r.error);
    const cs = callSites(r.error);
    return { case: r.name, errorClass: h.errorClass, message: h.message, site: cs.site, frames: cs.frames, caseSite: cs.caseSite, runnerSeen: cs.runnerSeen, label: null };
  });
}

const norm = (f) => ({
  case: f.case === undefined ? null : f.case,
  errorClass: f.errorClass === undefined ? null : f.errorClass,
  message: f.message === undefined || f.message === null ? '' : String(f.message),
  site: f.site === undefined ? null : f.site,
  frames: Array.isArray(f.frames) ? f.frames.map(String) : [],
  caseSite: f.caseSite === undefined ? null : f.caseSite,
  runnerSeen: typeof f.runnerSeen === 'boolean' ? f.runnerSeen : null,
  label: f.label === undefined ? null : f.label,
});

// 子进程里：失败用例的明细行（单行 JSON）。
function caseLine(name, e) { return '@@CASE ' + JSON.stringify(failureOfError(name, e)); }

// 父进程里：从子进程输出里取回 @@CASE 明细（坏行跳过）。
function parseCaseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('@@CASE ')) continue;
    try { out.push(norm(JSON.parse(line.slice(7)))); } catch (_) { /* 坏行不收 */ }
  }
  return out;
}

// 父进程里：每条变异结束时的一行。
function mutLine(group, id, verdict, failures, note) {
  const rec = { group, id, verdict, failures: (failures || []).map(norm) };
  if (note) rec.note = String(note);
  return '@@MUT ' + JSON.stringify(rec);
}

// 解析 @@MUT 行（基线生成脚本用）；返回 { rec } 或 { bad: 原行 }。
function parseMutLine(line) {
  if (!line.startsWith('@@MUT ')) return null;
  try {
    const o = JSON.parse(line.slice(6));
    if (!o || typeof o.group !== 'string' || typeof o.id !== 'string' || typeof o.verdict !== 'string' || !Array.isArray(o.failures)) return { bad: line };
    return { rec: { group: o.group, id: o.id, verdict: o.verdict, failures: o.failures.map(norm), note: o.note || null } };
  } catch (_) { return { bad: line }; }
}

module.exports = { VERDICT, FRAME_LIMIT, STACK_LIMIT, RUNNER_FRAMES, enabled, firstLine, siteOfStack, parseFrame, callSites, headOfStack, failureOfError, failuresOfSummary, caseLine, parseCaseLines, mutLine, parseMutLine };
