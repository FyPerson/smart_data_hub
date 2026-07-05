// verify-correction-d-block-rename.js — D 块「错误证明」→「待修复数据」正名静态校验
//   方案：docs/local/数据修正/数据修正模块_OA号自动补全_方案_20260629_v1.3.md §2/§3/§6
//   本块是纯前端显示文案改名（无后端/无运行期行为变化），故用静态 grep + JS 语法解析校验，
//   对齐方案 §3 步骤 4 明示的验证法："grep 改后确认无残留错误证明中文文案 +
//   attachment_type='error_proof' 仍完好（底层未被误伤）"。
// 覆盖：
//   ① 用户可见"错误证明"中文文案清零（仅保留 2 处显式标注"D 块...正名"的历史脚注注释，非用户可见）
//   ② 新增"待修复数据"文案 ≥ 20 处（方案估约 20+ 处）
//   ③ 底层标识符/字段名/变量名一律未被误伤（attachment_type='error_proof' / ERROR_PROOF_ON_MASTER_ONLY /
//      effective_error_proof_note / formErrorProofNote / formErrorProofFiles / errProofNoteHtml 等）
//   ④ 内嵌 <script> 语法仍可解析（防止字符串替换破坏引号/模板字面量）
// 用法：node scripts/verify-correction-d-block-rename.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

const htmlPath = path.join(__dirname, '..', 'public', 'Data_Correction.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('=== D 块「错误证明→待修复数据」正名静态校验 ===\n');

// ① 用户可见"错误证明"清零——仅允许出现在标注"D 块"的历史脚注注释里（非用户可见、解释改名本身）
const lines = html.split('\n');
const errProofLines = lines
  .map((line, i) => ({ line, no: i + 1 }))
  .filter(({ line }) => line.includes('错误证明'));
const unexpected = errProofLines.filter(({ line }) => !line.includes('D 块'));
ok(unexpected.length === 0,
  `①用户可见"错误证明"文案清零（残留 ${errProofLines.length} 处，全部是"D 块"历史脚注注释，非用户可见；未预期残留 ${unexpected.length} 处）`);
if (unexpected.length > 0) {
  unexpected.forEach(({ line, no }) => console.log(`    意外残留 L${no}: ${line.trim()}`));
}

// ② 新增"待修复数据"文案 ≥ 20 处
const newTextCount = (html.match(/待修复数据/g) || []).length;
ok(newTextCount >= 20, `②"待修复数据"新文案出现 ${newTextCount} 次（方案估约 20+ 处）`);

// ③ 底层标识符/字段名/变量名未被误伤
const mustKeep = [
  `attachment_type === 'error_proof'`,
  `fd.append('attachment_type', 'error_proof')`,
  `ERROR_PROOF_ON_MASTER_ONLY`,
  `effective_error_proof_note`,
  `error_proof_note`,
  `formErrorProofNote`,
  `formErrorProofFiles`,
  `errProofNoteHtml`,
  `errProofs`,
  `errProofTitle`,
  `errProofSection`,
  `errProofAddHtml`,
  `errProofEmpty`,
  `canAddErrProof`,
  `ERR_PROOF_STATES`,
  `uploadErrorProof`,
];
for (const token of mustKeep) {
  ok(html.includes(token), `③底层标识符完好：${token}`);
}
// fd.append('attachment_type', 'error_proof') 应出现 2 次（建单两步上传 + 详情页补传，均未被误伤）
const appendErrorProofCount = (html.match(/fd\.append\('attachment_type', 'error_proof'\)/g) || []).length;
ok(appendErrorProofCount === 2, `③attachment_type='error_proof' 写入点仍为 2 处（建单两步上传 + 详情页补传补传，实得 ${appendErrorProofCount}）`);

// ④ 内嵌 <script> 语法仍可解析
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
ok(!!scriptMatch, '④成功提取内嵌 <script> 块');
try {
  // eslint-disable-next-line no-new-func
  new Function(scriptMatch[1]);
  ok(true, '④内嵌 <script> 语法可解析（字符串替换未破坏引号/模板字面量）');
} catch (e) {
  ok(false, `④内嵌 <script> 语法解析失败：${e.message}`);
}

console.log(`\n=== D 块正名静态校验通过：${pass} 断言 ===`);
