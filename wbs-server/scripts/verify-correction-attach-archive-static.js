// verify-correction-attach-archive-static.js — 附件压缩包支持方案 D1/D10 静态守卫（纯文本检查，不起 server）
//   断言：
//   ① public/Data_Correction.html 的 CORR_ARCHIVE_EXTS 字面量与 utils/attachment-archive.js 真相源
//      ARCHIVE_EXTS 同值（去点、忽略大小写与顺序比较，因前端字面量不带点）
//   ② CORR_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值
//   ③ 七处 accept 属性（建单 OA 截图 / 待修复数据 / 完成×2 / 重修×2 / 补充附件）均含 .zip/.rar/.7z
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE } = require('../utils/attachment-archive');

const htmlPath = path.join(__dirname, '..', 'public', 'Data_Correction.html');
const html = fs.readFileSync(htmlPath, 'utf8');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function main() {
  // ① CORR_ARCHIVE_EXTS 字面量对拍
  const extsMatch = html.match(/const\s+CORR_ARCHIVE_EXTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(extsMatch, 'CORR_ARCHIVE_EXTS 声明必须存在于 Data_Correction.html');
  const feExts = extsMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(s => '.' + s.toLowerCase());
  const truthExts = ARCHIVE_EXTS.map(e => e.toLowerCase());
  assert.strictEqual(feExts.length, truthExts.length, `CORR_ARCHIVE_EXTS 数量应与真相源一致：前端=${JSON.stringify(feExts)} 真相源=${JSON.stringify(truthExts)}`);
  for (const e of truthExts) assert.ok(feExts.includes(e), `CORR_ARCHIVE_EXTS 缺少真相源扩展名 ${e}：前端=${JSON.stringify(feExts)}`);
  for (const e of feExts) assert.ok(truthExts.includes(e), `CORR_ARCHIVE_EXTS 多出真相源之外的扩展名 ${e}：前端=${JSON.stringify(feExts)}`);
  ok(`CORR_ARCHIVE_EXTS 字面量与真相源 ARCHIVE_EXTS 同值（${JSON.stringify(feExts)}）`);

  // ② CORR_ARCHIVE_MAX_SIZE 字面量对拍
  const sizeMatch = html.match(/const\s+CORR_ARCHIVE_MAX_SIZE\s*=\s*([0-9_]+)/);
  assert.ok(sizeMatch, 'CORR_ARCHIVE_MAX_SIZE 声明必须存在于 Data_Correction.html');
  const feSize = Number(sizeMatch[1].replace(/_/g, ''));
  assert.strictEqual(feSize, ARCHIVE_MAX_SIZE, `CORR_ARCHIVE_MAX_SIZE（${feSize}）应与真相源 ARCHIVE_MAX_SIZE（${ARCHIVE_MAX_SIZE}）同值`);
  ok(`CORR_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值（${feSize}）`);

  // ③ 七处 accept 属性均含 .zip/.rar/.7z（方案锚点行号，2026-09-09 快照）
  const inputIds = ['formOaProofFiles', 'formErrorProofFiles', 'formCompleteFiles', 'formCompleteBatchFiles', 'formResubmitFiles', 'formResubmitBatchFiles', 'formAttachFiles'];
  for (const id of inputIds) {
    const re = new RegExp(`id="${id}"[^>]*accept="([^"]*)"`);
    const m = html.match(re);
    assert.ok(m, `input#${id} 必须存在且带 accept 属性`);
    const accept = m[1];
    for (const ext of ['.zip', '.rar', '.7z']) {
      assert.ok(accept.includes(ext), `input#${id} 的 accept 应含 ${ext}，实际 accept="${accept}"`);
    }
  }
  ok(`七处附件 input（${inputIds.join(' / ')}）accept 属性均含 .zip/.rar/.7z`);

  // ③b corrAttachCollectFiles 内 CORR_ARCHIVE_EXTS 分流逻辑存在（防重命名后本守卫失效却仍绿）。
  //   codex 06 M1 收口：仅断言 isArchive 声明存在时，把 sizeLimit 改成恒用 CORR_ATTACH_MAX_SIZE（大小分流
  //   名存实亡）仍会全绿——须把判别力打到「sizeLimit 真的按 isArchive 分流」+「真的拿 sizeLimit 做比较」
  //   这两处断言对象，而非仅断言变量声明存在。取函数体（从声明起到下一个顶层 function 声明止）、去掉块
  //   注释与行注释（含行尾注释）后再匹配，防注释里写了正确代码但实现被注释掉的假绿。
  assert.ok(/const\s+isArchive\s*=\s*CORR_ARCHIVE_EXTS\.includes\(ext\)/.test(html), 'corrAttachCollectFiles 内 isArchive 分流判据须存在（accept 与 collect 真闸同源）');
  const collectStart = html.indexOf('function corrAttachCollectFiles');
  assert.ok(collectStart !== -1, 'corrAttachCollectFiles 函数声明必须存在');
  const afterCollectStart = html.slice(collectStart);
  const nextTopFuncRel = afterCollectStart.indexOf('\n        function ', 1);
  const collectFnRaw = nextTopFuncRel === -1 ? afterCollectStart : afterCollectStart.slice(0, nextTopFuncRel);
  // 去块注释 + 行注释（含行尾注释）——先剥 /* */ 块注释，再逐行剥 // 开头到行尾的部分。
  const collectFnStripped = collectFnRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/const\s+sizeLimit\s*=\s*isArchive\s*\?\s*CORR_ARCHIVE_MAX_SIZE\s*:\s*CORR_ATTACH_MAX_SIZE\s*;/.test(collectFnStripped),
    `corrAttachCollectFiles 去注释后应含「const sizeLimit = isArchive ? CORR_ARCHIVE_MAX_SIZE : CORR_ATTACH_MAX_SIZE;」（防大小分流被恒定为 CORR_ATTACH_MAX_SIZE 仍绿），实际函数体（去注释）：\n${collectFnStripped}`);
  assert.ok(/f\.size\s*>\s*sizeLimit/.test(collectFnStripped),
    `corrAttachCollectFiles 去注释后应含「f.size > sizeLimit」（真的拿 sizeLimit 做大小比较，防判据算出来但没被使用），实际函数体（去注释）：\n${collectFnStripped}`);
  ok('corrAttachCollectFiles 内 isArchive 分流判据存在 + sizeLimit 三元表达式与 f.size>sizeLimit 比较均在去注释函数体内命中（大小分流判别力，实现坏成什么样它会红：sizeLimit 恒用 CORR_ATTACH_MAX_SIZE → 第一条断言红；算出 sizeLimit 但不用来比较 → 第二条断言红）');

  // ⑤ 标签/提示文案与放开面同源（Opus 预筛 C2 M2）：建单错误凭证 hint / 完成与重提结果证明 label / 补充附件静态 hint + 动态两句 ≥6 处含压缩包句
  const labelHits = (html.match(/压缩包 zip\/rar\/7z/g) || []).length;
  assert.ok(labelHits >= 6, `修正页含「压缩包 zip/rar/7z」的标签/提示文案应 ≥6 处，实际 ${labelHits}`);
  assert.ok(!/结果证明截图/.test(html), '「结果证明截图」措辞须已改为「结果证明」（入口已放开压缩包）');
  ok(`标签/提示文案 ${labelHits} 处含压缩包句，无「结果证明截图」残留`);

  // ⑥ 前端 MB 文案与真相源对拍（Opus 预筛 C2 L4）：所有「压缩包…≤NMB」的 N 必须 === ARCHIVE_MAX_SIZE/1048576
  const mbTexts = html.match(/压缩包[^<'"]*?≤(\d+)MB/g) || [];
  assert.ok(mbTexts.length >= 6, `压缩包 MB 文案应 ≥6 处，实际 ${mbTexts.length}`);
  for (const t of mbTexts) { const n = Number(t.match(/≤(\d+)MB/)[1]); assert.strictEqual(n, ARCHIVE_MAX_SIZE / 1048576, `文案「${t}」的 MB 数应为 ${ARCHIVE_MAX_SIZE / 1048576}`); }
  // toast 分流：钉钉完成通知的 toast 须按 file_skipped_reason / file_sent 分流，不再按 has_attachment（Opus 预筛 C2 M1）
  assert.ok(/data\.file_skipped_reason\s*===\s*'archive'/.test(html) && /data\.file_sent\s*\?/.test(html), '完成通知 toast 须按 file_skipped_reason / file_sent 分流');
  ok(`压缩包 MB 文案 ${mbTexts.length} 处均为 ${ARCHIVE_MAX_SIZE / 1048576}MB；完成通知 toast 已按 file_sent 分流`);

  console.log(`\n✅ verify-correction-attach-archive-static 全部通过（${passed} 项断言）`);
}

try {
  main();
} catch (e) {
  console.error('❌ verify-correction-attach-archive-static 失败:', e && e.stack || e);
  process.exit(1);
}
