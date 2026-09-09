// verify-sys-attach-archive-static.js — 附件压缩包支持方案 D1/D10 静态守卫（纯文本检查，不起 server）
//   断言：
//   ① public/Sys_Iteration.html 的 SI_ARCHIVE_EXTS 字面量与 utils/attachment-archive.js 真相源 ARCHIVE_EXTS 同值
//      （去点、忽略大小写与顺序比较，因前端字面量不带点）
//   ② SI_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值
//   ③ accept 派生（siPickerAllowedExts）对 screenshot 系 key（modal-screenshot/accept-evidence/return-evidence）
//      不含压缩包——即 SI_PICKER_ARCHIVE_KEYS 集合里没有这三个 key，且含 spec/delivery 系五个 key
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE } = require('../utils/attachment-archive');

const htmlPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function main() {
  // ① SI_ARCHIVE_EXTS 字面量对拍
  const extsMatch = html.match(/const\s+SI_ARCHIVE_EXTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(extsMatch, 'SI_ARCHIVE_EXTS 声明必须存在于 Sys_Iteration.html');
  const feExts = extsMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(s => '.' + s.toLowerCase());
  const truthExts = ARCHIVE_EXTS.map(e => e.toLowerCase());
  assert.strictEqual(feExts.length, truthExts.length, `SI_ARCHIVE_EXTS 数量应与真相源一致：前端=${JSON.stringify(feExts)} 真相源=${JSON.stringify(truthExts)}`);
  for (const e of truthExts) assert.ok(feExts.includes(e), `SI_ARCHIVE_EXTS 缺少真相源扩展名 ${e}：前端=${JSON.stringify(feExts)}`);
  for (const e of feExts) assert.ok(truthExts.includes(e), `SI_ARCHIVE_EXTS 多出真相源之外的扩展名 ${e}：前端=${JSON.stringify(feExts)}`);
  ok(`SI_ARCHIVE_EXTS 字面量与真相源 ARCHIVE_EXTS 同值（${JSON.stringify(feExts)}）`);

  // ② SI_ARCHIVE_MAX_SIZE 字面量对拍
  const sizeMatch = html.match(/const\s+SI_ARCHIVE_MAX_SIZE\s*=\s*([0-9_]+)/);
  assert.ok(sizeMatch, 'SI_ARCHIVE_MAX_SIZE 声明必须存在于 Sys_Iteration.html');
  const feSize = Number(sizeMatch[1].replace(/_/g, ''));
  assert.strictEqual(feSize, ARCHIVE_MAX_SIZE, `SI_ARCHIVE_MAX_SIZE（${feSize}）应与真相源 ARCHIVE_MAX_SIZE（${ARCHIVE_MAX_SIZE}）同值`);
  ok(`SI_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值（${feSize}）`);

  // ③ accept 派生对 screenshot 系 key 不含压缩包
  const keysMatch = html.match(/const\s+SI_PICKER_ARCHIVE_KEYS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(keysMatch, 'SI_PICKER_ARCHIVE_KEYS 声明必须存在于 Sys_Iteration.html');
  const archiveKeys = keysMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const screenshotKeys = ['modal-screenshot', 'accept-evidence', 'return-evidence'];
  const archiveOpenKeys = ['create-spec', 'submit-delivery', 'modal-spec', 'modal-delivery', 'resume-spec'];
  for (const k of screenshotKeys) assert.ok(!archiveKeys.includes(k), `SI_PICKER_ARCHIVE_KEYS 不应含 screenshot 系 key「${k}」（验收凭证不放压缩包，方案 §2.1）：实际=${JSON.stringify(archiveKeys)}`);
  for (const k of archiveOpenKeys) assert.ok(archiveKeys.includes(k), `SI_PICKER_ARCHIVE_KEYS 应含 spec/delivery 系 key「${k}」：实际=${JSON.stringify(archiveKeys)}`);
  assert.strictEqual(archiveKeys.length, archiveOpenKeys.length, `SI_PICKER_ARCHIVE_KEYS 不应含枚举之外的多余 key：实际=${JSON.stringify(archiveKeys)}`);
  ok(`accept 派生对 screenshot 系 3 个 key 不含压缩包，spec/delivery 系 5 个 key 均含（SI_PICKER_ARCHIVE_KEYS=${JSON.stringify(archiveKeys)}）`);

  // ③b siPickerAllowedExts 函数本体存在（防重命名后本守卫失效却仍绿）
  assert.ok(/function\s+siPickerAllowedExts\s*\(key\)/.test(html), 'siPickerAllowedExts(key) 函数须存在（accept 与 collect 真闸同源）');
  ok('siPickerAllowedExts(key) 函数存在');

  // ④ 结构锚：siPickerCollect 内大小分流必须仍是「isArchive ? SI_ARCHIVE_MAX_SIZE : SI_SPEC_MAX_SIZE」——
  //   Opus 预筛 M5 变异实测：删掉这条分流（恒用 SI_SPEC_MAX_SIZE）时 ①②③ 全绿，本条把它判红。V12(SI) Playwright 顺延 C5。
  //   codex 05 M1 收紧：只匹配去注释后的 `const sizeLimit = isArchive ? … : …;` 赋值语句本身，注释里出现同款表达式不算数。
  const htmlNoComments = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/const\s+sizeLimit\s*=\s*isArchive\s*\?\s*SI_ARCHIVE_MAX_SIZE\s*:\s*SI_SPEC_MAX_SIZE\s*;/.test(htmlNoComments), 'siPickerCollect 内须有赋值语句 const sizeLimit = isArchive ? SI_ARCHIVE_MAX_SIZE : SI_SPEC_MAX_SIZE;（去注释后匹配）');
  ok('siPickerCollect 大小分流结构锚存在（去注释后匹配赋值语句）');

  // ⑥ 业务规格独立断言（codex 05 M2）：50MB 上限不从被测常量推导，硬写 50*1024*1024——真相源与前端副本一起误改成 100MB 时这里红
  assert.strictEqual(ARCHIVE_MAX_SIZE, 50 * 1024 * 1024, `ARCHIVE_MAX_SIZE 业务规格须恒为 50MB=52428800，实际 ${ARCHIVE_MAX_SIZE}`);
  assert.deepStrictEqual([...ARCHIVE_EXTS].sort(), ['.7z', '.rar', '.zip'], `ARCHIVE_EXTS 业务规格须恒为 zip/rar/7z，实际 ${JSON.stringify(ARCHIVE_EXTS)}`);
  ok('业务规格独立断言：ARCHIVE_MAX_SIZE=52428800、ARCHIVE_EXTS=zip/rar/7z');

  // ⑤ 四处标签文案与放开面同源：spec/delivery 三处专用标签须含「压缩包 zip/rar/7z 单个≤50MB」，通用弹窗按 SI_PICKER_ARCHIVE_KEYS 分流（Opus 预筛 M1）
  const labelHits = (html.match(/压缩包 zip\/rar\/7z 单个≤50MB/g) || []).length;
  assert.ok(labelHits >= 4, `spec/delivery 标签文案应 ≥4 处含「压缩包 zip/rar/7z 单个≤50MB」（3 专用 + 1 通用弹窗分流句），实际 ${labelHits}`);
  assert.ok(/SI_PICKER_ARCHIVE_KEYS\.has\(key\)\s*\?/.test(html), '通用上传弹窗标签须按 SI_PICKER_ARCHIVE_KEYS.has(key) 分流');
  ok(`标签文案 ${labelHits} 处含压缩包句，通用弹窗按 key 分流`);

  console.log(`\n✅ verify-sys-attach-archive-static 全部通过（${passed} 项断言）`);
}

try {
  main();
} catch (e) {
  console.error('❌ verify-sys-attach-archive-static 失败:', e && e.stack || e);
  process.exit(1);
}
