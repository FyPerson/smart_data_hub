#!/usr/bin/env node
/**
 * #77 C4a P22：模型权限判断的「ID 类型混用」真值表守卫（纯 node，不起服务）。
 *
 * 背景：目录页行按钮与配置台门禁原先用严格相等比较 ID（created_by_id === currentUser.id / latest_active_task_owner_id === currentUser.id），
 *   数字与字符串混用时（例如某天后端改成返回字符串 ID）会把创建者 / 任务 owner 误拒。P22 把比较统一成 String() 后比较，并把判断收成两个页内同源函数：
 *   userCanEditModel（Model_Center.html 与 Model_Workbench.html 同源，token 序列由 verify-model-page-shared-functions.js ② 守）、
 *   userCanValidateModel（仅 Model_Center.html）。
 *   两份页面级基线（C3a-0 / C4-0）的输入全是数字 ID，到不了 P22 改变的那组输入，所以本守卫是 P22 的唯一证人。
 *
 * 做法：从两页内联脚本按函数名用 acorn 各取一份函数源码，放进 vm 上下文执行（上下文里的 currentUser 由用例设置），跑真值表；
 *   再做静态接线断言（catalog 里 renderModelsPage 恰有一次 userCanEditModel(m) / userCanValidateModel(m)；ID 成员只出现在两个 userCan* 函数体内；
 *   WB 恰一次 userCanEditModel(wbModel)；public/ 下 canEditWorkbenchModel 0 次）。
 *
 * 用法：node scripts/verify-model-permission-id-types.js [--self-test]
 * 威胁模型：只防「诚实改动把 String() 比较改回严格相等 / 去掉保护 / 接线断开」，不防故意绕过观测（动态拼装函数、改 vm 全局）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const PUB = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');

function inlineScripts(html) {
  const out = []; const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) { if (m[0].startsWith('<!--')) continue; if (!/\ssrc\s*=/.test(m[1] || '')) out.push(m[2]); }
  return out;
}
/** 内联脚本顶层的某个函数：{ src, scriptIndex, start, end }；必须恰 1 个 */
function topFns(html, name) {
  const res = [];
  inlineScripts(html).forEach((s, si) => {
    const ast = acorn.parse(s, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
    for (const n of ast.body) if (n.type === 'FunctionDeclaration' && n.id.name === name) res.push({ src: s.slice(n.start, n.end), si, start: n.start, end: n.end });
  });
  return res;
}
function oneFn(html, name, label, probs) {
  const r = topFns(html, name);
  if (r.length !== 1) { probs.push(`W ${label} 里 ${name} 应恰好 1 个顶层声明，实得 ${r.length}`); return null; }
  return r[0].src;
}
/** 在 vm 上下文里跑函数，返回布尔化结果；抛异常返回 'THROW:消息' */
function runFn(fnSrc, name, user, model) {
  const ctx = vm.createContext({ currentUser: user });
  vm.runInContext(fnSrc, ctx);
  try { return !!ctx[name](model); } catch (e) { return 'THROW:' + e.message; }
}

const OTHER = '他人';
const U = (id, extra = {}) => ({ id, role: 'user', display_name: '张三', username: 'zs', ...extra });
/** ID 组合真值表：[编号, currentUser.id, 模型侧 ID, 期望, 说明] */
const ID_CASES = [
  ['E1', 3, 3, true, '等价（数字 / 数字）'],
  ['E2', 3, '3', true, 'P22 正向（用户数字、模型字符串）'],
  ['E3', '3', 3, true, 'P22 反向（用户字符串、模型数字）'],
  ['E4', '3', '3', true, '字符串 / 字符串'],
  ['E5', 3, 4, false, '对照'],
  ['E6', 3, '4', false, '对照'],
  ['E7', '3', 4, false, '对照'],
  ['E8', 3, null, false, '模型侧 null'],
  ['E9', 3, undefined, false, '模型侧 undefined'],
  ['E11', 0, 0, false, '保留 id 真值保护（与现行一致）'],
  ['E12', undefined, undefined, false, 'String(undefined) === String(undefined) 的陷阱'],
  // codex 33 HIGH：字符串精确语义 / 独立空值保护 / '0' 与空串边界（Number() 归一化、只删模型侧 != null 的诚实错误必须判红）
  ['E13', '0', 0, true, "用户 id 为字符串 '0'（真值）、模型 0 → String 相等"],
  ['E14', 0, '0', false, '用户 id 0 走真值保护'],
  ['E15', '0', '', false, "'0' 对空串"],
  ['E16', '', '', false, '空串对空串（用户 id 空串为假值）'],
  ['E17', '03', 3, false, "非规范字符串 '03' 不等于 3（Number() 归一化会误放行）"],
  ['E18', 3, '03', false, "3 与 '03'（同上，反向）"],
  ['E19', 'null', null, false, "字符串 'null' 与 null（模型侧 != null 保护）"],
  ['E20', 'undefined', undefined, false, "字符串 'undefined' 与 undefined（模型侧 != null 保护）"],
];

/** 返回问题列表；pages = { mc, wb, cat } 源码 */
function check(pages, pubScan) {
  const probs = [];
  const editMC = oneFn(pages.mc, 'userCanEditModel', 'Model_Center.html', probs);
  const editWB = oneFn(pages.wb, 'userCanEditModel', 'Model_Workbench.html', probs);
  const valMC = oneFn(pages.mc, 'userCanValidateModel', 'Model_Center.html', probs);
  const fail = (id, page, why) => probs.push(`${id}@${page} ${why}`);
  const expectEq = (id, page, got, want, desc) => { if (got !== want) fail(id, page, `${desc}：期望 ${want}，实得 ${got}`); };
  const editPages = [['MC', editMC], ['WB', editWB]].filter(x => x[1]);
  for (const [page, src] of editPages) {
    for (const [id, uid, mid, want, desc] of ID_CASES) expectEq(id, page, runFn(src, 'userCanEditModel', U(uid), { tech_owner: OTHER, created_by_id: mid }), want, 'userCanEditModel ' + desc);
    expectEq('E10', page, runFn(src, 'userCanEditModel', null, { tech_owner: OTHER, created_by_id: 3 }), false, 'userCanEditModel currentUser=null');
    expectEq('ADM', page, runFn(src, 'userCanEditModel', U(9, { role: 'admin' }), { tech_owner: OTHER, created_by_id: 1 }), true, 'admin 恒 true');
    expectEq('PUB', page, runFn(src, 'userCanEditModel', U(9, { role: 'publisher' }), { tech_owner: OTHER, created_by_id: 1 }), false, 'publisher 对编辑 false');
    expectEq('TECH1', page, runFn(src, 'userCanEditModel', U(9, { display_name: 'Zhang San' }), { tech_owner: '  zhang SAN ', created_by_id: 1 }), true, '技术负责人前后带空格 / 大小写不同仍 true（D-20 口径）');
    expectEq('TECH2', page, runFn(src, 'userCanEditModel', U(9), { tech_owner: 123, created_by_id: 1 }), false, 'tech_owner 为数字时不抛异常');
  }
  if (valMC) {
    for (const [id, uid, mid, want, desc] of ID_CASES) expectEq(id, 'MC-validate', runFn(valMC, 'userCanValidateModel', U(uid), { tech_owner: OTHER, latest_active_task_owner_id: mid }), want, 'userCanValidateModel ' + desc);
    expectEq('E10', 'MC-validate', runFn(valMC, 'userCanValidateModel', null, { tech_owner: OTHER, latest_active_task_owner_id: 3 }), false, 'userCanValidateModel currentUser=null');
    expectEq('ADM', 'MC-validate', runFn(valMC, 'userCanValidateModel', U(9, { role: 'admin' }), { tech_owner: OTHER }), true, 'admin 恒 true');
    expectEq('PUB', 'MC-validate', runFn(valMC, 'userCanValidateModel', U(9, { role: 'publisher' }), { tech_owner: OTHER }), true, 'publisher 对验收 true');
    expectEq('TECH1', 'MC-validate', runFn(valMC, 'userCanValidateModel', U(9, { display_name: 'Zhang San' }), { tech_owner: '  zhang SAN ' }), true, '技术负责人宽匹配仍 true');
    expectEq('TECH2', 'MC-validate', runFn(valMC, 'userCanValidateModel', U(9), { tech_owner: 123 }), false, 'tech_owner 为数字时不抛异常');
  }
  // ---- 静态接线 ----
  const catAst = acorn.parse(pages.cat, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  const rm = catAst.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'renderModelsPage');
  if (!rm) probs.push('S model-catalog.js 里找不到 renderModelsPage');
  else {
    const body = pages.cat.slice(rm.start, rm.end);
    const cnt = (re) => (body.match(re) || []).length;
    if (cnt(/\buserCanEditModel\(m\)/g) !== 1) probs.push(`S renderModelsPage 里应恰有一次 userCanEditModel(m)，实得 ${cnt(/\buserCanEditModel\(m\)/g)}`);
    if (cnt(/\buserCanValidateModel\(m\)/g) !== 1) probs.push(`S renderModelsPage 里应恰有一次 userCanValidateModel(m)，实得 ${cnt(/\buserCanValidateModel\(m\)/g)}`);
  }
  for (const f of ['created_by_id', 'latest_active_task_owner_id']) {
    if (pages.cat.includes(f)) probs.push(`S model-catalog.js 全文不应出现 ${f}（权限判断只能经 userCan* 函数）`);
    // MC 内联：去掉两个 userCan* 函数体后不得再出现
    let rest = '';
    inlineScripts(pages.mc).forEach((s) => {
      let t = s;
      for (const nm of ['userCanEditModel', 'userCanValidateModel']) { const r = topFns('<script>' + t + '</script>', nm); if (r.length === 1) t = t.slice(0, r[0].start) + t.slice(r[0].end); }
      rest += t;
    });
    if (rest.includes(f)) probs.push(`S Model_Center.html 内联里 ${f} 只允许出现在 userCanEditModel / userCanValidateModel 函数体内`);
    let restWB = '';
    inlineScripts(pages.wb).forEach((s) => { let t = s; const r = topFns('<script>' + t + '</script>', 'userCanEditModel'); if (r.length === 1) t = t.slice(0, r[0].start) + t.slice(r[0].end); restWB += t; });
    if (f === 'created_by_id' && restWB.includes(f)) probs.push(`S Model_Workbench.html 内联里 ${f} 只允许出现在 userCanEditModel 函数体内`);
  }
  const wbCalls = (inlineScripts(pages.wb).join('\n').match(/\buserCanEditModel\(wbModel\)/g) || []).length;
  if (wbCalls !== 1) probs.push(`S Model_Workbench.html 应恰有一次 userCanEditModel(wbModel)，实得 ${wbCalls}`);
  const leftovers = pubScan();
  if (leftovers.length) probs.push(`S public/ 下 canEditWorkbenchModel 应为 0 次，实得 ${leftovers.length}（${leftovers.slice(0, 3).join('，')}）`);
  return probs;
}
/** public/ 下 git 可见的文件（已跟踪 + 未跟踪但未被忽略）；git 不可用 / 结果为空 → 抛错（fail-closed，不退回磁盘全量） */
function gitVisibleFiles(cwd = PUB) {
  let out;
  try { out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { throw new Error('git ls-files 失败（权限用例的扫描面取 git 可见集合，git 不可用时 fail-closed）：' + String(e.message).split('\n')[0]); }
  const files = out.split(/\r?\n/).filter(Boolean);
  if (!files.length) throw new Error('git ls-files 在 ' + cwd + ' 下没有返回任何文件（扫描面前提不成立，fail-closed）');
  return files;
}
const NAME_GONE = 'canEditWorkbenchModel';
/** public/ 下含已改名函数旧名的文件；files / read 可注入（self-test 用） */
function scanPublic(files = gitVisibleFiles(), read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8')) {
  if (!files.includes('Model_Center.html') || !files.includes('Model_Workbench.html')) throw new Error('扫描面前提不成立：git 可见集合里缺 Model_Center.html / Model_Workbench.html');
  return files.filter(rel => /\.(html|js|css)$/i.test(rel) && read(rel).includes(NAME_GONE));
}

function selfTest(pages) {
  const files = gitVisibleFiles();
  const cache = new Map();
  const readReal = (rel) => { if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(PUB, rel), 'utf8')); return cache.get(rel); };
  const realScan = () => scanPublic(files, readReal);
  const base = check(pages, realScan);
  if (base.length) { console.log('[self-test] 对照组（未变异）应全绿，实得：\n  ' + base.join('\n  ')); return 1; }
  console.log('[self-test] 对照组（未变异）全绿');
  const STR_WB = 'String(model.created_by_id) === String(currentUser.id)';
  const STR_VAL = 'String(model.latest_active_task_owner_id) === String(currentUser.id)';
  const sub = (src, from, to, fnName) => {
    const i = src.indexOf('function ' + fnName); if (i < 0) throw new Error('变异锚点不存在：' + fnName);
    const j = src.indexOf(from, i); if (j < 0) throw new Error('变异锚点不存在：' + from);
    return src.slice(0, j) + to + src.slice(j + from.length);
  };
  const muts = [
    ['M1 WB 的 userCanEditModel 去掉创建者比较的 String()', (p) => ({ ...p, wb: sub(p.wb, STR_WB, 'model.created_by_id === currentUser.id', 'userCanEditModel') }), ['E2@WB', 'E3@WB']],
    ['M1b MC 的 userCanEditModel 去掉创建者比较的 String()', (p) => ({ ...p, mc: sub(p.mc, STR_WB, 'model.created_by_id === currentUser.id', 'userCanEditModel') }), ['E2@MC', 'E3@MC']],
    ['M2 MC 的 userCanValidateModel 去掉任务 owner 比较的 String()', (p) => ({ ...p, mc: sub(p.mc, STR_VAL, 'model.latest_active_task_owner_id === currentUser.id', 'userCanValidateModel') }), ['E2@MC-validate', 'E3@MC-validate']],
    ['M3 WB 去掉 currentUser.id 真值保护', (p) => ({ ...p, wb: sub(p.wb, 'currentUser && currentUser.id && model.created_by_id', 'currentUser && model.created_by_id', 'userCanEditModel') }), ['E11@WB']],
    ['M3b WB 去掉两处保护（id 真值 + != null）', (p) => ({ ...p, wb: sub(p.wb, 'currentUser && currentUser.id && model.created_by_id != null && String(', 'currentUser && String(', 'userCanEditModel') }), ['E11@WB', 'E12@WB']],
    ['M3c MC 验收函数去掉两处保护', (p) => ({ ...p, mc: sub(p.mc, 'currentUser && currentUser.id && model.latest_active_task_owner_id != null && String(', 'currentUser && String(', 'userCanValidateModel') }), ['E11@MC-validate', 'E12@MC-validate']],
    ['M4 catalog 的 renderModelsPage 改回内联严格相等', (p) => ({ ...p, cat: p.cat.replace('userCanEditModel(m)', '(currentUser && currentUser.id && m.created_by_id === currentUser.id)') }), ['S ']],
    ['M4b catalog 的 renderModelsPage 验收判断改回内联', (p) => ({ ...p, cat: p.cat.replace('userCanValidateModel(m)', '(currentUser && m.latest_active_task_owner_id === currentUser.id)') }), ['S ']],
    ['M5 WB 调用点改回 canEditWorkbenchModel', (p) => ({ ...p, wb: p.wb.replace('!userCanEditModel(wbModel)', '!canEditWorkbenchModel(wbModel)') }), ['S ']],
    ['M6 MC 的 userCanEditModel 去掉 admin 分支', (p) => ({ ...p, mc: sub(p.mc, 'return !!(isAdmin || ', 'return !!(', 'userCanEditModel') }), ['ADM@MC']],
    ['M7 MC 验收函数去掉 publisher', (p) => ({ ...p, mc: sub(p.mc, " || currentUser.role === 'publisher'", '', 'userCanValidateModel') }), ['PUB@MC-validate']],
    ['M8 WB 的 normalizeStr 去掉 String()（tech_owner 为数字时抛异常）', (p) => ({ ...p, wb: sub(p.wb, "s ? String(s).trim()", 's ? s.trim()', 'userCanEditModel') }), ['TECH2@WB']],
    ['N1 WB 把 String(...) === String(...) 换成 Number(...) === Number(...)（codex 33）', (p) => ({ ...p, wb: sub(p.wb, STR_WB, 'Number(model.created_by_id) === Number(currentUser.id)', 'userCanEditModel') }), ['E17@WB', 'E18@WB']],
    ['N1b MC 验收函数同样换成 Number() 比较', (p) => ({ ...p, mc: sub(p.mc, STR_VAL, 'Number(model.latest_active_task_owner_id) === Number(currentUser.id)', 'userCanValidateModel') }), ['E17@MC-validate', 'E18@MC-validate']],
    ['N2 WB 只删模型侧 != null 保护、保留 currentUser.id 保护（codex 33）', (p) => ({ ...p, wb: sub(p.wb, 'model.created_by_id != null && ', '', 'userCanEditModel') }), ['E19@WB', 'E20@WB']],
    ['N2b MC 验收函数只删模型侧 != null 保护', (p) => ({ ...p, mc: sub(p.mc, 'model.latest_active_task_owner_id != null && ', '', 'userCanValidateModel') }), ['E19@MC-validate', 'E20@MC-validate']],
    ['M9 在 git 可见集合的某个页面（Model_Workbench.html）里加一处旧名 canEditWorkbenchModel（真实走 scanPublic）', (p) => p, ['S public/']],
    ['控制：WB 的 userCanEditModel 内部只改空白 / 加注释，仍应全绿', (p) => ({ ...p, wb: sub(p.wb, 'const isAdmin = ', '/* c */\n   const isAdmin = ', 'userCanEditModel') }), null],
  ];
  let bad = 0;
  for (const [label, fn, want] of muts) {
    let probs;
    try { probs = check(fn(pages), label.startsWith('M9') ? () => scanPublic(files, (rel) => readReal(rel) + (rel === 'Model_Workbench.html' ? '\n// ' + NAME_GONE : '')) : realScan); } catch (e) { console.log(`[self-test] FAIL ${label}：构造变异失败（${e.message}）`); bad++; continue; }
    if (want === null) { if (probs.length) { console.log(`[self-test] FAIL ${label}：不应判红，实得 ${probs[0]}`); bad++; } else console.log(`[self-test] OK   ${label}：全绿`); continue; }
    const missing = want.filter(w => !probs.some(p => p.startsWith(w)));
    if (!probs.length) { console.log(`[self-test] FAIL ${label}：变异后仍全绿（判别力不足）`); bad++; }
    else if (missing.length) { console.log(`[self-test] FAIL ${label}：判红但缺少预期例 ${missing.join(',')}（实得 ${probs.slice(0, 3).join(' | ').slice(0, 160)}）`); bad++; }
    else console.log(`[self-test] OK   ${label}：判红（${probs[0].slice(0, 100)}）`);
  }
  // scanPublic 前提 / fail-closed 自证
  { let err = null; try { gitVisibleFiles('E:/__no_such_dir__'); } catch (e) { err = e; }
    if (!err) { console.log('[self-test] FAIL gitVisibleFiles 在不存在的目录下应抛错（fail-closed）'); bad++; } else console.log('[self-test] OK   git 不可用 / 目录不存在 → 抛错（fail-closed）');
    let err2 = null; try { scanPublic(['x.html'], () => ''); } catch (e) { err2 = e; }
    if (!err2) { console.log('[self-test] FAIL 可见集合缺两页时应抛错'); bad++; } else console.log('[self-test] OK   可见集合缺 Model_Center.html / Model_Workbench.html → 抛错（前提不成立）');
    const hits = scanPublic(files, (rel) => (rel === 'Model_Center.html' ? NAME_GONE : ''));
    if (hits.length !== 1 || hits[0] !== 'Model_Center.html') { console.log('[self-test] FAIL scanPublic 没扫到注入的旧名：' + JSON.stringify(hits)); bad++; } else console.log('[self-test] OK   scanPublic 能扫到可见集合内的旧名'); }
  return bad ? 1 : 0;
}

function main() {
  const pages = { mc: read('Model_Center.html'), wb: read('Model_Workbench.html'), cat: read('assets/js/model-catalog.js') };
  if (process.argv.includes('--self-test')) return selfTest(pages);
  const probs = check(pages, () => scanPublic());
  probs.forEach(p => console.log('[FAIL] ' + p));
  console.log(`[permission-id-types] ID 组合 ${ID_CASES.length + 1} 例 × 编辑（两页）+ 验收（目录页）+ 角色 / 口径例；静态接线；问题 ${probs.length}`);
  return probs.length ? 1 : 0;
}
process.exit(main());
