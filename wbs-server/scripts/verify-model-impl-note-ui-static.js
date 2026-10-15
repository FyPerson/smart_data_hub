// verify-model-impl-note-ui-static.js — #77 C2a 修复（codex 24 MED）：「实现说明」前端绑定的最小静态契约。
//
// 后端 HTTP 用例不覆盖前端绑定：删掉任一绑定行，整套仍可能全绿（实现说明悄悄不回填 / 不清空 / 不提交）。本脚本只断言四件事（都按「所在函数」切片，不在全文里找同名文字）：
//   ① 弹窗里存在输入框 id="regImplNote"；
//   ② openEditModal 函数体内有对 regImplNote 的回填赋值（`...getElementById('regImplNote').value = model.impl_note ...`）；
//   ③ 新建分支（与 regDesignNotes 清空同处的那个函数）里有 regImplNote 的清空赋值（`...value = ''`），避免上一次编辑的值串到新建；
//   ④ confirmRegister 载荷（含 design_notes 键的那个函数）里有 `impl_note: ...getElementById('regImplNote').value.trim() || null`。
// 不证明：回填的值来自正确的字段（只证明接线存在）、样式 / 布局、浏览器里的实际交互（那由浏览器实测负责）。
//
// #77 C3b：配置台迁出后绑定分居两页，按文件配置期望（keys = 该文件必须满足的判据编号），两个文件各跑一遍，--self-test 变异也各跑一份：
//   目录页 Model_Center.html（编辑信息）：①②④；  配置台 Model_Workbench.html（注册新模型）：①③④。
//
// 用法：node scripts/verify-model-impl-note-ui-static.js [--file <页面副本> [--keys 1,2,4]]   基线（必须全绿）；--file 供变异副本判红（缺省 keys 按文件名取）
//       node scripts/verify-model-impl-note-ui-static.js --self-test                       内存变异自证：每个文件分别删掉 / 注释掉其适用的绑定行 / 输入框，必须各自判红
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TARGETS = [
  { file: path.join(__dirname, '..', 'public', 'Model_Center.html'), keys: ['1', '2', '4'] },
  { file: path.join(__dirname, '..', 'public', 'Model_Workbench.html'), keys: ['1', '3', '4'] },
];
const keysFor = (file) => { const t = TARGETS.find(x => path.basename(x.file) === path.basename(file)); return t ? t.keys : ['1', '2', '3', '4']; };

/** 按「8 空格缩进的 function 声明行」把全文切成函数块：[{ name, start, end（不含）, text }] */
function functionBlocks(lines) {
  const heads = [];
  lines.forEach((ln, i) => { const m = /^ {8}(?:async )?function\s+(\w+)\s*\(/.exec(ln); if (m) heads.push({ name: m[1], start: i }); });
  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].start : lines.length;
    return { name: h.name, start: h.start, end, text: lines.slice(h.start, end).join('\n') };
  });
}

/**
 * 匹配前先剥注释（防「注释掉绑定行仍绿」的假绿）。保持行数不变（注释内的换行保留），函数块行号 / 缩进判定不受影响。
 * 剥法（不做完整词法分析，故意保守地避开字符串里的 `//`，如 URL）：
 *   ① HTML 注释 `<!-- … -->`（可跨行）；② 块注释 `/* … *\/`（可跨行）；
 *   ③ 行注释只认两种位置：行首（仅空白之后）的 `//…`，以及 `;` `{` `}` 之后（允许空白）的 `//…`——URL 里的 `://` 前面是 `:` 或字母，不会命中。
 */
function stripComments(html) {
  const blank = (m) => m.replace(/[^\r\n]/g, '');
  let s = html.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
  s = s.split('\n').map(l => l.replace(/^(\s*)\/\/.*$/, '$1').replace(/([;{}])\s*\/\/.*$/, '$1')).join('\n');
  return s;
}

/** 返回 { checks: [{ name, ok, detail }] }；纯函数（自证复用）。keys 决定适用哪几条判据 */
function analyze(rawHtml, keys = ['1', '2', '3', '4']) {
  const html = stripComments(rawHtml);
  const lines = html.split(/\r?\n/);
  const blocks = functionBlocks(lines);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const want = new Set(keys);

  add('前提：切出了函数块（至少 50 个）', blocks.length >= 50, `blocks=${blocks.length}`);
  if (want.has('1')) add('① 存在输入框 id="regImplNote"', /id="regImplNote"/.test(html), '未找到 id="regImplNote"');

  if (want.has('2')) {
    const edit = blocks.find(b => b.name === 'openEditModal');
    add('前提：找到 openEditModal 函数', !!edit, 'openEditModal 不存在');
    add('② openEditModal 内回填：getElementById(\'regImplNote\').value = model.impl_note',
      !!edit && /getElementById\('regImplNote'\)\.value\s*=\s*model\.impl_note\b/.test(edit.text), edit ? '函数内没有回填赋值' : 'n/a');
  }

  if (want.has('3')) {
    // ③ 新建分支：含 regDesignNotes 清空赋值（`.value = ''`）的函数
    const clearDesign = blocks.filter(b => /getElementById\('regDesignNotes'\)\.value\s*=\s*''/.test(b.text));
    add('前提：恰有一个函数清空 regDesignNotes（新建分支）', clearDesign.length === 1, `命中 ${clearDesign.length} 个：${clearDesign.map(b => b.name).join(',')}`);
    add('③ 新建分支（清空 regDesignNotes 的同一函数）内清空：getElementById(\'regImplNote\').value = \'\'',
      clearDesign.length === 1 && /getElementById\('regImplNote'\)\.value\s*=\s*''/.test(clearDesign[0].text), clearDesign.length === 1 ? `函数 ${clearDesign[0].name} 内没有清空赋值` : 'n/a');
  }

  if (want.has('4')) {
    // ④ confirmRegister 载荷：含 `design_notes: document.getElementById('regDesignNotes')` 的函数
    const payloadFns = blocks.filter(b => /design_notes:\s*document\.getElementById\('regDesignNotes'\)/.test(b.text));
    add('前提：恰有一个函数构造含 design_notes 的提交载荷（confirmRegister）', payloadFns.length === 1 && payloadFns[0].name === 'confirmRegister', `命中：${payloadFns.map(b => b.name).join(',')}`);
    add('④ confirmRegister 载荷含 impl_note: getElementById(\'regImplNote\').value.trim() || null',
      payloadFns.length === 1 && /impl_note:\s*document\.getElementById\('regImplNote'\)\.value\.trim\(\)\s*\|\|\s*null/.test(payloadFns[0].text), payloadFns.length === 1 ? '载荷里没有 impl_note 绑定' : 'n/a');
  }
  return { checks };
}

function report(checks, prefix = '') {
  const failed = checks.filter(c => !c.ok);
  for (const f of failed) console.log(`FAIL ${prefix}${f.name}\n  ${f.detail}`);
  return failed;
}

/** 内存变异：删掉匹配行（正则必须恰好命中 1 行，否则变异本身无效 = 自证失败） */
function dropLine(html, re) {
  const lines = html.split('\n');
  const idx = lines.map((l, i) => (re.test(l) ? i : -1)).filter(i => i >= 0);
  if (idx.length !== 1) return { error: `变异匹配 ${idx.length} 行（须恰好 1 行）：${re}` };
  lines.splice(idx[0], 1);
  return { html: lines.join('\n') };
}

/** 内存变异：把匹配行注释掉（kind = 'line'：行首加 `//`；'block'：包成块注释） */
function commentOutLine(html, re, kind) {
  const lines = html.split('\n');
  const idx = lines.map((l, i) => (re.test(l) ? i : -1)).filter(i => i >= 0);
  if (idx.length !== 1) return { error: `变异匹配 ${idx.length} 行（须恰好 1 行）：${re}` };
  const l = lines[idx[0]];
  const ind = /^\s*/.exec(l)[0];
  lines[idx[0]] = kind === 'block' ? `${ind}/* ${l.trim()} */` : `${ind}// ${l.trim()}`;
  return { html: lines.join('\n') };
}

/** 内存变异：把 textarea（两行）整个包进 HTML 注释 */
function htmlCommentTextarea(html) {
  const m = /<textarea id="regImplNote"[\s\S]*?<\/textarea>/.exec(html);
  if (!m) return { error: '找不到 regImplNote textarea' };
  return { html: html.replace(m[0], `<!-- ${m[0]} -->`) };
}

/** 返回判别力不足 / 构造失败的条数；cases 里第 4 项是该变异适用的判据编号，不适用于本文件的跳过 */
function selfTest(html, keys) {
  const commentCases = [
    ['行注释掉 openEditModal 的回填行（`// …`）', () => commentOutLine(html, /getElementById\('regImplNote'\)\.value\s*=\s*model\.impl_note/, 'line'), '② openEditModal 内回填', '2'],
    ['行注释掉 confirmRegister 载荷里的 impl_note 行', () => commentOutLine(html, /impl_note:\s*document\.getElementById\('regImplNote'\)/, 'line'), '④ confirmRegister 载荷', '4'],
    ['块注释掉新建分支的清空行（`/* … */`）', () => commentOutLine(html, /getElementById\('regImplNote'\)\.value\s*=\s*'';/, 'block'), '③ 新建分支', '3'],
    ['把 regImplNote textarea 放进 HTML 注释', () => htmlCommentTextarea(html), '① 存在输入框', '1'],
  ].filter(c => keys.includes(c[3]));
  const cases = [
    ['删掉输入框 id="regImplNote"（textarea 行）', /<textarea id="regImplNote"/, '① 存在输入框', '1'],
    ['删掉 openEditModal 的回填行', /getElementById\('regImplNote'\)\.value\s*=\s*model\.impl_note/, '② openEditModal 内回填', '2'],
    ['删掉新建分支的清空行', /getElementById\('regImplNote'\)\.value\s*=\s*'';/, '③ 新建分支', '3'],
    ['删掉 confirmRegister 载荷里的 impl_note 行', /impl_note:\s*document\.getElementById\('regImplNote'\)/, '④ confirmRegister 载荷', '4'],
  ].filter(c => keys.includes(c[3]));
  let bad = 0;
  const judge = (label, m, expectName) => {
    if (m.error) { console.log(`FAIL 自证「${label}」：${m.error}`); bad++; return; }
    const r = analyze(m.html, keys);
    const hit = r.checks.find(c => !c.ok && c.name.startsWith(expectName));
    if (!hit) { console.log(`FAIL 自证「${label}」：没有判红预期的检查「${expectName}」；实际红：${r.checks.filter(c => !c.ok).map(c => c.name).join(' | ') || '无'}`); bad++; }
    else console.log(`PASS 自证「${label}」→ 判红：${hit.name}`);
  };
  for (const [label, re, expectName] of cases) judge(label, dropLine(html, re), expectName);
  for (const [label, mk, expectName] of commentCases) judge(label, mk(), expectName);
  return bad;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--file');
  const ki = argv.indexOf('--keys');
  const targets = fi >= 0 && argv[fi + 1]
    ? [{ file: path.resolve(argv[fi + 1]), keys: ki >= 0 ? argv[ki + 1].split(',') : keysFor(argv[fi + 1]) }]
    : TARGETS;
  let allOk = true, pass = 0, fail = 0;
  for (const t of targets) {
    const html = fs.readFileSync(t.file, 'utf8');
    const name = path.basename(t.file);
    const base = analyze(html, t.keys);
    const failed = report(base.checks, `[${name}] `);
    pass += base.checks.length - failed.length; fail += failed.length;
    if (argv.includes('--self-test')) {
      console.log(`[self-test] ${name}（判据 ${t.keys.join('')}）`);
      const bad = selfTest(html, t.keys);
      console.log(`${name} baseline_red=${failed.length} selftest_bad=${bad}`);
      if (failed.length || bad) allOk = false;
    } else if (failed.length) allOk = false;
  }
  if (argv.includes('--self-test')) console.log(`verify-model-impl-note-ui-static --self-test ${allOk ? 'OK' : 'FAILED'}`);
  else console.log(`verify-model-impl-note-ui-static PASS=${pass} FAIL=${fail}`);
  process.exitCode = allOk ? 0 : 1;
}

module.exports = { analyze, TARGETS };
