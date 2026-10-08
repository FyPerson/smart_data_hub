// verify-correction-attach-archive-static.js — 附件压缩包支持方案 D1/D10 静态守卫（文本检查 + ③d 用 vm 跑从源码抽出的函数，不起 server）
//   断言：
//   ① public/Data_Correction.html 的 CORR_ARCHIVE_EXTS 字面量与 utils/attachment-archive.js 真相源
//      ARCHIVE_EXTS 同值（去点、忽略大小写与顺序比较，因前端字面量不带点）
//   ② CORR_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值
//   ③ 七处 accept 属性（建单 OA 截图 / 待修复数据 / 完成×2 / 重修×2 / 补充附件）均含 .zip/.rar/.7z
//   ③b 扩展名/大小闸 corrFileGateReject 的分流判据，以及补充附件弹窗（corrAttachCollectFiles）与 6 个裸
//      input 入口（corrPickerCollect）都在接收文件前调用它并按结果跳过（2026-10-08 #344 docx 前置拦截）
//   ③c 前端 CORR_ATTACH_EXTS 与后端 routes/corrections.js CORRECTION_BASE_EXTS 同值（前端放行 ⇔ 后端放行，
//      防前端漏拦后端拒收的格式、选了照常出卡片、提交才失败）
//   ③d 行为对拍：页面真实的 corrFileGateReject 与 busboy 真实的 basename + server.js 真实的 normalizeAttachmentExt +
//      白名单，对一组边角文件名逐个比放行结论（扩展名取法差一点也会让 ③c 同值的白名单在个别文件名上前放后拒）；
//      另按手写期望值核大小闸边界（需要 node_modules 里的 busboy，缺失即报错）
//   ③e 贴图注册回调把 corrPickerCollect 的实际接收数原样返回给 u-paste.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

  // ③b 扩展名/大小闸 corrFileGateReject 内 CORR_ARCHIVE_EXTS 分流逻辑存在（防重命名后本守卫失效却仍绿）。
  //   codex 06 M1 收口：仅断言 isArchive 声明存在时，把 sizeLimit 改成恒用 CORR_ATTACH_MAX_SIZE（大小分流
  //   名存实亡）仍会全绿——须把判别力打到「sizeLimit 真的按 isArchive 分流」+「真的拿 sizeLimit 做比较」
  //   这两处断言对象，而非仅断言变量声明存在。取函数体（从声明起到下一个顶层 function 声明止）、去掉块
  //   注释与行注释（含行尾注释）后再匹配，防注释里写了正确代码但实现被注释掉的假绿。
  //   2026-10-08：两道闸从 corrAttachCollectFiles 抽到 corrFileGateReject（6 个裸 input 入口共用），判据断言
  //   跟着落到闸函数体；另断言两个收集函数都在接收前调用闸并按结果跳过（否则闸写对了但没人调仍全绿）。
  const fnBodyStripped = (name) => {
    const start = html.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} 函数声明必须存在`);
    const after = html.slice(start);
    const nextRel = after.indexOf('\n        function ', 1);
    const raw = nextRel === -1 ? after : after.slice(0, nextRel);
    // 去块注释 + 行注释（含行尾注释）——先剥 /* */ 块注释，再逐行剥 // 开头到行尾的部分。
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };
  const gateFnStripped = fnBodyStripped('corrFileGateReject');
  assert.ok(/const\s+isArchive\s*=\s*CORR_ARCHIVE_EXTS\.includes\(ext\)/.test(gateFnStripped), `corrFileGateReject 去注释后应含 isArchive 分流判据（accept 与 collect 真闸同源），实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/if\s*\(\s*!isArchive\s*&&\s*!CORR_ATTACH_EXTS\.includes\(ext\)\s*\)/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「if (!isArchive && !CORR_ATTACH_EXTS.includes(ext))」扩展名白名单判据，实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/const\s+sizeLimit\s*=\s*isArchive\s*\?\s*CORR_ARCHIVE_MAX_SIZE\s*:\s*CORR_ATTACH_MAX_SIZE\s*;/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「const sizeLimit = isArchive ? CORR_ARCHIVE_MAX_SIZE : CORR_ATTACH_MAX_SIZE;」（防大小分流被恒定为 CORR_ATTACH_MAX_SIZE 仍绿），实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/f\.size\s*>\s*sizeLimit/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「f.size > sizeLimit」（真的拿 sizeLimit 做大小比较，防判据算出来但没被使用），实际函数体（去注释）：\n${gateFnStripped}`);
  // 两个调用方：闸调用 + 「有拒收原因就 toast 并 continue」须出现在接收语句（push）之前。
  const callers = [
    { name: 'corrAttachCollectFiles', pushRe: /corrAttachFiles\.push\(\s*f\s*\)/ },
    { name: 'corrPickerCollect', pushRe: /arr\.push\(\s*f\s*\)/ },
  ];
  for (const c of callers) {
    const body = fnBodyStripped(c.name);
    const callM = /const\s+reject\s*=\s*corrFileGateReject\(\s*f\s*\)\s*;\s*if\s*\(\s*reject\s*\)\s*\{\s*showToast\(\s*reject\s*,\s*'error'\s*\)\s*;\s*continue\s*;\s*\}/.exec(body);
    assert.ok(callM, `${c.name} 去注释后应含「const reject = corrFileGateReject(f); if (reject) { showToast(reject, 'error'); continue; }」，实际函数体（去注释）：\n${body}`);
    const pushM = c.pushRe.exec(body);
    assert.ok(pushM, `${c.name} 去注释后应含接收语句 ${c.pushRe}，实际函数体（去注释）：\n${body}`);
    assert.ok(callM.index < pushM.index, `${c.name} 内闸调用须在接收语句之前（先判后收），实际闸在 ${callM.index}、接收在 ${pushM.index}`);
  }
  ok('corrFileGateReject 内 isArchive 分流 + 白名单判据 + sizeLimit 三元表达式与 f.size>sizeLimit 比较均在去注释函数体内命中；corrAttachCollectFiles / corrPickerCollect 都在接收前调用闸并按拒收原因跳过（实现坏成什么样它会红：sizeLimit 恒用 CORR_ATTACH_MAX_SIZE / 算出 sizeLimit 不比较 / 去掉白名单判据 / 某个收集函数不调闸或先收后判）');

  // ③c 前端扩展名白名单与后端同值（2026-10-08 #344）：后端 CORRECTION_BASE_EXTS 带点，前端 CORR_ATTACH_EXTS 不带点；
  //   去点、转小写、按集合比较（顺序无关）。文本解析而非 require——corrections.js 是带依赖注入的路由工厂。
  const feAttachMatch = html.match(/const\s+CORR_ATTACH_EXTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(feAttachMatch, 'CORR_ATTACH_EXTS 声明必须存在于 Data_Correction.html');
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'corrections.js'), 'utf8');
  const beBaseMatch = routeSrc.match(/const\s+CORRECTION_BASE_EXTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(beBaseMatch, 'CORRECTION_BASE_EXTS 声明必须存在于 routes/corrections.js');
  const toExtSet = (lit) => lit.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(s => s.replace(/^\./, '').toLowerCase());
  const feAttach = toExtSet(feAttachMatch[1]);
  const beBase = toExtSet(beBaseMatch[1]);
  assert.strictEqual(new Set(feAttach).size, feAttach.length, `CORR_ATTACH_EXTS 不应有重复项：${JSON.stringify(feAttach)}`);
  for (const e of beBase) assert.ok(feAttach.includes(e), `CORR_ATTACH_EXTS 缺少后端 CORRECTION_BASE_EXTS 的 ${e}（前端会误拦后端放行的格式）：前端=${JSON.stringify(feAttach)} 后端=${JSON.stringify(beBase)}`);
  for (const e of feAttach) assert.ok(beBase.includes(e), `CORR_ATTACH_EXTS 多出后端 CORRECTION_BASE_EXTS 之外的 ${e}（前端放行、后端拒收，选了出卡片、提交才失败）：前端=${JSON.stringify(feAttach)} 后端=${JSON.stringify(beBase)}`);
  assert.ok(!feAttach.includes('docx') && !feAttach.includes('doc'), `CORR_ATTACH_EXTS 不得含 doc/docx：${JSON.stringify(feAttach)}`);
  ok(`CORR_ATTACH_EXTS 与后端 CORRECTION_BASE_EXTS 同值（${JSON.stringify(feAttach)}），不含 doc/docx`);

  // ③d 行为对拍（2026-10-08）：两边函数都从真实源码抽出来跑，不在守卫里另写一份算法。
  //   后端放行 ⇔ normalizeAttachmentExt(name) ∈ CORRECTION_BASE_EXTS ∪ ARCHIVE_EXTS（三类附件规则同集，见 corrections.js
  //   CORRECTION_ATTACHMENT_RULES）；前端放行 ⇔ corrFileGateReject({ name, size: 1 }) === null（size 固定 1 字节，只比扩展名闸）。
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const normStart = serverSrc.indexOf('function normalizeAttachmentExt(');
  assert.ok(normStart !== -1, 'server.js 必须声明 function normalizeAttachmentExt(');
  const normEnd = serverSrc.indexOf('\n}', normStart);
  assert.ok(normEnd !== -1, 'normalizeAttachmentExt 函数体须以行首 } 结束');
  const beNorm = vm.runInNewContext(`(${serverSrc.slice(normStart, normEnd + 2)})`, { path, String });
  // codex 94 L-1：后端看到的不是浏览器原始文件名——multer 底层 busboy（preservePath 默认关）先截到最后一个 / 或 \ 之后。
  //   同样从真实源码抽 basename 来跑；corrections.js 若改设 preservePath，本建模前提失效，须同步改前端闸与本段。
  assert.ok(!/preservePath/.test(routeSrc), 'routes/corrections.js 不得设置 preservePath（③d 按 busboy 默认截路径建模）');
  const busboyUtils = path.join(path.dirname(require.resolve('busboy', { paths: [path.join(__dirname, '..')] })), 'utils.js');
  const bbSrc = fs.readFileSync(busboyUtils, 'utf8');
  const bbStart = bbSrc.indexOf('function basename(');
  assert.ok(bbStart !== -1, `${busboyUtils} 须声明 function basename(`);
  const bbEnd = bbSrc.indexOf('\n}', bbStart);
  const bbBasename = vm.runInNewContext(`(${bbSrc.slice(bbStart, bbEnd + 2)})`, {});
  const beAllowed = beBase.map(e => '.' + e).concat(ARCHIVE_EXTS.map(e => e.toLowerCase()));
  const gateStart = html.indexOf('function corrFileGateReject(');
  const gateEndRel = html.slice(gateStart).indexOf('\n        }');
  assert.ok(gateStart !== -1 && gateEndRel !== -1, 'corrFileGateReject 函数须存在且以 8 空格缩进的 } 结束');
  const gateSrc = html.slice(gateStart, gateStart + gateEndRel + '\n        }'.length);
  const constSrc = ['CORR_ATTACH_MAX_SIZE', 'CORR_ATTACH_EXTS', 'CORR_ARCHIVE_EXTS', 'CORR_ARCHIVE_MAX_SIZE'].map((n) => {
    const m = html.match(new RegExp(`const\\s+${n}\\s*=\\s*[^;]+;`));
    assert.ok(m, `Data_Correction.html 须声明 const ${n}`);
    return m[0];
  }).join('\n');
  const feGate = vm.runInNewContext(`${constSrc}\n(${gateSrc})`, { String, Math });
  // 语料：常见合法 / 常见非法 / 大小写与首尾空白 / 点的位置边角 / 点后空白 / 控制字符 / 双扩展名 / 中文名
  const corpus = ['a.pdf', 'A.PDF', 'a.PDF ', ' a.png', '截图.png', 'x.jpeg', 'x.webp', 'x.bmp', 'x.gif', 'x.xls', 'x.xlsx', 'x.zip', 'x.RAR', 'x.7z',
    '需求说明.docx', '旧版.DOC', 'x.txt', 'x.csv', 'x.heic', 'x.svg', 'x.tar.gz', 'a.pdf.docx', 'a.docx.pdf',
    '.png', '..png', '...png', 'a..png', 'a.', 'a.b.', 'pdf', '', 'a. pdf', 'a .pdf', 'a.p df', 'a.pdf ', '　a.png',
    'a\tb.png', 'a.png\u0007', '\u0000.png', 'a\u007f.png', 'a.png\u0085',
    // 含路径分隔符（codex 94 L-1）：末段以点开头 / 末段正常 / 末段为空 / 末段为「.」「..」/ 末段带空白
    '前缀\\.png', 'dir/.png', 'a\\b.png', 'a/b.pdf', 'x\\y.docx', 'a.b\\c', 'a.png\\', 'a/', 'a/.', 'a\\..', 'a\\ b.png', 'a/b.png '];
  const mismatch = [];
  let feAcceptCount = 0;
  for (const name of corpus) {
    const be = beAllowed.includes(beNorm(bbBasename(name)));
    const fe = feGate({ name, size: 1 }) === null;
    if (fe) feAcceptCount++;
    if (be !== fe) mismatch.push(`${JSON.stringify(name)}：后端${be ? '放行' : '拒收'}、前端${fe ? '放行' : '拒收'}`);
  }
  assert.strictEqual(mismatch.length, 0, `前后端放行结论不一致 ${mismatch.length} 处：\n  ${mismatch.join('\n  ')}`);
  // 判别力锚点：防两边同时退化成「全拒」或「全放」仍一致而绿
  assert.ok(feAcceptCount >= 14 && feAcceptCount < corpus.length, `语料放行数应 ≥14 且 <${corpus.length}（实得 ${feAcceptCount}）`);
  // 文案只冻语义（Word 专用 + 点名文件 + 指向 PDF），不冻字面量
  const docxMsg = feGate({ name: '需求说明.docx', size: 1 });
  assert.ok(typeof docxMsg === 'string' && /Word/.test(docxMsg) && docxMsg.includes('需求说明.docx') && /PDF/.test(docxMsg), `docx 须得 Word 专用拒收文案（含 Word、文件名、PDF），实得 ${JSON.stringify(docxMsg)}`);
  // 大小闸行为（codex 94 L-2：此前只查表达式存在，超限分支不 return 也绿）。期望值手写：非压缩包 20MB（后端
  //   CORRECTION_ATTACHMENT_RULES defaultSize）、压缩包 ARCHIVE_MAX_SIZE；恰等于上限放行、多 1 字节拒收。
  const MB20 = 20 * 1024 * 1024;
  const sizeCases = [
    ['a.png', MB20, true], ['a.png', MB20 + 1, false], ['a.pdf', MB20 + 1, false],
    ['a.zip', MB20 + 1, true], ['a.7z', ARCHIVE_MAX_SIZE, true], ['a.rar', ARCHIVE_MAX_SIZE + 1, false],
  ];
  for (const [name, size, pass] of sizeCases) {
    const r = feGate({ name, size });
    assert.ok(pass ? r === null : (typeof r === 'string' && r.includes(name)), `大小闸：${name} ${size} 字节应${pass ? '放行' : '拒收（文案含文件名）'}，实得 ${JSON.stringify(r)}`);
  }
  ok(`corrFileGateReject 与 busboy basename + server.js normalizeAttachmentExt + 白名单在 ${corpus.length} 个文件名上放行结论逐个一致（放行 ${feAcceptCount} 个），docx 得 Word 专用文案；大小闸 ${sizeCases.length} 个边界用例按期望放行/拒收`);

  // ③e 贴图透传（codex 94 L-2）：注册回调须把 corrPickerCollect 的实际接收数原样返回给 u-paste.js（返回 undefined 时
  //   共享层按尝试张数报「已粘贴 N 张」，拒收后会谎报成功）。行为面由一次性浏览器验证覆盖，这里卡源码结构。
  const regStart = html.indexOf('UPaste.register({');
  assert.ok(regStart !== -1, 'Data_Correction.html 须有 UPaste.register({');
  const regEndRel = html.slice(regStart).indexOf('\n            });');
  assert.ok(regEndRel !== -1, 'UPaste.register 调用须以 12 空格缩进的 }); 结束');
  const regStripped = html.slice(regStart, regStart + regEndRel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/const\s+accepted\s*=\s*corrPickerCollect\(\s*key\s*,\s*files\s*\)\s*;\s*corrPickerRender\(\s*key\s*\)\s*;\s*return\s+accepted\s*;/.test(regStripped),
    `UPaste.register 的 collect 去注释后应含「const accepted = corrPickerCollect(key, files); corrPickerRender(key); return accepted;」，实际（去注释）：\n${regStripped}`);
  ok('贴图注册回调把 corrPickerCollect 的实际接收数原样返回给 u-paste.js');

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
