// probe-correction-external-refs.js
// 搬运安全核实：correction 私有符号（定义在三区内）有没有被"区外代码"引用？
//   若有 → 整段搬走后区外引用会断链（xxx is not defined），必须在切换 commit 同步处理。
//   典型嫌疑：runCorrectionMigration 的触发点可能在 initTable 区外。
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = src.split('\n');

const regions = [
  { name: '区1', start: 195, end: 245 },
  { name: '区2', start: 1991, end: 2261 },   // codex H-2：与 build 搬运边界统一
  { name: '区3', start: 18289, end: 19802 },
];
const regionOf = (ln) => regions.find(r => ln >= r.start && ln <= r.end);

// 区内顶层定义符号（私有，整段搬走）
const privateDefs = [];
lines.forEach((ln, i) => {
  const m = ln.match(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/);
  if (m && regionOf(i + 1)) privateDefs.push({ sym: m[1], def: i + 1 });
});

console.log('区内顶层定义私有符号共 ' + privateDefs.length + ' 个，逐个查区外引用：\n');

let anyDanger = false;
for (const { sym, def } of privateDefs) {
  const re = new RegExp('\\b' + sym.replace(/\$/g, '\\$') + '\\b');
  const extCode = [];
  lines.forEach((ln, i) => {
    const lineNo = i + 1;
    if (lineNo === def) return;            // 跳过定义行自身
    if (regionOf(lineNo)) return;          // 区内引用 OK（跟着搬）
    if (!re.test(ln)) return;
    const t = ln.trim();
    const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    if (!isComment) extCode.push({ ln: lineNo, t: t.slice(0, 100) });
  });
  if (extCode.length) {
    anyDanger = true;
    console.log('⚠️ ' + sym + ' (def@' + def + ') 被区外代码引用 ' + extCode.length + ' 处：');
    extCode.forEach(r => console.log('    L' + r.ln + ': ' + r.t));
  }
}
if (!anyDanger) {
  console.log('✅ 所有私有符号均无区外代码引用 → 三区可安全整段搬走（无断链）。');
} else {
  console.log('\n→ 上述符号的区外引用必须在切换 commit 同步改造（改为走 routes 模块导出 / 或保留触发点）。');
}
