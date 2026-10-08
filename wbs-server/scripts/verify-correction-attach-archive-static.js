// verify-correction-attach-archive-static.js — 附件压缩包支持方案 D1/D10 静态守卫（文本检查 + ③d 用 vm 跑从源码抽出的函数，不起 server）
//   断言：
//   ① public/Data_Correction.html 的 CORR_ARCHIVE_EXTS 字面量与 utils/attachment-archive.js 真相源
//      ARCHIVE_EXTS 同值（去点、忽略大小写与顺序比较，因前端字面量不带点）
//   ② CORR_ARCHIVE_MAX_SIZE 字面量与真相源 ARCHIVE_MAX_SIZE 同值
//   ③ 七处 accept 属性（建单 OA 截图 / 待修复数据 / 完成×2 / 重修×2 / 补充附件）均含 .zip/.rar/.7z
//   ③b 扩展名/大小闸 corrFileGateReject 的分流判据（含按附件类型分流：只有 error_proof 另收 Word .docx），
//      补充附件弹窗（corrAttachCollectFiles，类型取 #attachType）与 6 个裸 input 入口（corrPickerCollect，类型取
//      CORR_PICKER_TARGETS）都在接收文件前带类型调用它并按结果跳过；6 个入口的类型登记与提交类型一致
//      （2026-10-08 #344 前置拦截 → 同日改为待修复数据支持 docx）
//   ③c 前端 CORR_ATTACH_EXTS / CORR_ERR_PROOF_EXTRA_EXTS 分别与后端 routes/corrections.js CORRECTION_BASE_EXTS /
//      CORRECTION_ERROR_PROOF_EXTRA_EXTS 同值（防前端漏拦后端拒收的格式、选了照常出卡片、提交才失败）；Word 只在
//      额外清单里且只收 .docx
//   ③d 行为对拍：页面真实的 corrFileGateReject 与 busboy 真实的 basename + corrections.js 真实的
//      validateCorrectionAttachmentRule（内含 server.js 真实的 normalizeAttachmentExt），三类附件 × 一组边角文件名
//      逐个比放行结论；另按手写期望值核 Word 用例与大小闸边界（需要 node_modules 里的 busboy，缺失即报错）
//   ③e 贴图注册回调把 corrPickerCollect 的实际接收数原样返回给 u-paste.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE, ARCHIVE_SIZE_BY_EXT } = require('../utils/attachment-archive');

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
  const SHAPE_NOTE = '（形态断言：等价改写请同步更新本守卫）';
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
  assert.ok(/const\s+isArchive\s*=\s*CORR_ARCHIVE_EXTS\.includes\(ext\)/.test(gateFnStripped), `corrFileGateReject 去注释后应含 isArchive 分流判据（accept 与 collect 真闸同源），${SHAPE_NOTE}实际函数体（去注释）：\n${gateFnStripped}`);
  // 2026-10-08 待修复数据收 docx：白名单判据按类型分流——只有 attachType === 'error_proof' 时另收 CORR_ERR_PROOF_EXTRA_EXTS
  assert.ok(/const\s+takesWord\s*=\s*attachType\s*===\s*'error_proof'\s*;/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「const takesWord = attachType === 'error_proof';」，${SHAPE_NOTE}实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/if\s*\(\s*!isArchive\s*&&\s*!CORR_ATTACH_EXTS\.includes\(ext\)\s*&&\s*!\(\s*takesWord\s*&&\s*CORR_ERR_PROOF_EXTRA_EXTS\.includes\(ext\)\s*\)\s*\)/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「if (!isArchive && !CORR_ATTACH_EXTS.includes(ext) && !(takesWord && CORR_ERR_PROOF_EXTRA_EXTS.includes(ext)))」扩展名白名单判据，${SHAPE_NOTE}实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/const\s+sizeLimit\s*=\s*isArchive\s*\?\s*CORR_ARCHIVE_MAX_SIZE\s*:\s*CORR_ATTACH_MAX_SIZE\s*;/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「const sizeLimit = isArchive ? CORR_ARCHIVE_MAX_SIZE : CORR_ATTACH_MAX_SIZE;」（防大小分流被恒定为 CORR_ATTACH_MAX_SIZE 仍绿），${SHAPE_NOTE}实际函数体（去注释）：\n${gateFnStripped}`);
  assert.ok(/f\.size\s*>\s*sizeLimit/.test(gateFnStripped),
    `corrFileGateReject 去注释后应含「f.size > sizeLimit」（真的拿 sizeLimit 做大小比较，防判据算出来但没被使用），${SHAPE_NOTE}实际函数体（去注释）：\n${gateFnStripped}`);
  // 两个调用方：类型来源 + 闸调用 + 「有拒收原因就 toast 并 continue」须出现在接收语句（push）之前。
  const callers = [
    { name: 'corrAttachCollectFiles', typeVar: 'attachType', typeRe: /const\s+attachType\s*=\s*\(\s*document\.getElementById\(\s*'attachType'\s*\)\s*\|\|\s*\{\s*\}\s*\)\.value\s*;/, pushRe: /corrAttachFiles\.push\(\s*f\s*\)/ },
    { name: 'corrPickerCollect', typeVar: 'type', typeRe: /const\s+type\s*=\s*\(\s*CORR_PICKER_TARGETS\[\s*key\s*\]\s*\|\|\s*\{\s*\}\s*\)\.type\s*;/, pushRe: /arr\.push\(\s*f\s*\)/ },
  ];
  for (const c of callers) {
    const body = fnBodyStripped(c.name);
    assert.ok(c.typeRe.test(body), `${c.name} 去注释后应含类型来源 ${c.typeRe}，${SHAPE_NOTE}实际函数体（去注释）：\n${body}`);
    const callRe = new RegExp(`const\\s+reject\\s*=\\s*corrFileGateReject\\(\\s*f\\s*,\\s*${c.typeVar}\\s*\\)\\s*;\\s*if\\s*\\(\\s*reject\\s*\\)\\s*\\{\\s*showToast\\(\\s*reject\\s*,\\s*'error'\\s*\\)\\s*;\\s*continue\\s*;\\s*\\}`);
    const callM = callRe.exec(body);
    assert.ok(callM, `${c.name} 去注释后应含「const reject = corrFileGateReject(f, ${c.typeVar}); if (reject) { showToast(reject, 'error'); continue; }」，${SHAPE_NOTE}实际函数体（去注释）：\n${body}`);
    const pushM = c.pushRe.exec(body);
    assert.ok(pushM, `${c.name} 去注释后应含接收语句 ${c.pushRe}，${SHAPE_NOTE}实际函数体（去注释）：\n${body}`);
    assert.ok(callM.index < pushM.index, `${c.name} 内闸调用须在接收语句之前（先判后收），实际闸在 ${callM.index}、接收在 ${pushM.index}`);
  }
  // 6 个裸 input 入口的类型登记须与各自提交时的 attachment_type 一致（期望值手写：建单 OA 截图走建单 oa_proof_files、
  //   待修复数据建单后两步上传 attachment_type=error_proof、完成 / 重修走 /complete、/resubmit 的 fix_proof）
  const expectPickerType = { createOaProofPicked: 'oa_proof', createErrProofPicked: 'error_proof', completeFilesPicked: 'fix_proof', completeBatchFilesPicked: 'fix_proof', resubmitFilesPicked: 'fix_proof', resubmitBatchFilesPicked: 'fix_proof' };
  const targetsM = html.match(/const\s+CORR_PICKER_TARGETS\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(targetsM, 'CORR_PICKER_TARGETS 声明必须存在');
  const targetKeys = (targetsM[1].match(/^\s*(\w+)\s*:\s*\{/gm) || []).map(s => s.trim().split(/\s*:/)[0]);
  assert.deepStrictEqual(targetKeys.slice().sort(), Object.keys(expectPickerType).sort(), `CORR_PICKER_TARGETS 的入口集合应为 ${JSON.stringify(Object.keys(expectPickerType))}，实得 ${JSON.stringify(targetKeys)}`);
  for (const [key, type] of Object.entries(expectPickerType)) {
    const m = targetsM[1].match(new RegExp(`\\b${key}\\s*:\\s*\\{[^}]*\\btype\\s*:\\s*'([a-z_]+)'`));
    assert.ok(m && m[1] === type, `CORR_PICKER_TARGETS.${key}.type 应为 '${type}'，实得 ${m ? `'${m[1]}'` : '缺失'}`);
  }
  ok('corrFileGateReject 内 isArchive 分流 + 按类型分流的白名单判据（只有 error_proof 另收 Word）+ sizeLimit 三元表达式与 f.size>sizeLimit 比较均在去注释函数体内命中；corrAttachCollectFiles（类型取 #attachType）/ corrPickerCollect（类型取 CORR_PICKER_TARGETS）都在接收前带类型调用闸并按拒收原因跳过；6 个入口类型登记与提交类型一致');

  // ③c 前端扩展名白名单与后端同值（2026-10-08 #344）：后端带点，前端不带点；去点、转小写、按集合比较（顺序无关）。
  //   文本解析而非 require——corrections.js 是带依赖注入的路由工厂。两组：共用 BASE；待修复数据另收的 EXTRA。
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'corrections.js'), 'utf8');
  const toExtSet = (lit) => lit.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(s => s.replace(/^\./, '').toLowerCase());
  const litOf = (src, name, where) => { const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`)); assert.ok(m, `${name} 声明必须存在于 ${where}`); return toExtSet(m[1]); };
  const sameSet = (fe, be, feName, beName) => {
    assert.strictEqual(new Set(fe).size, fe.length, `${feName} 不应有重复项：${JSON.stringify(fe)}`);
    for (const e of be) assert.ok(fe.includes(e), `${feName} 缺少后端 ${beName} 的 ${e}（前端会误拦后端放行的格式）：前端=${JSON.stringify(fe)} 后端=${JSON.stringify(be)}`);
    for (const e of fe) assert.ok(be.includes(e), `${feName} 多出后端 ${beName} 之外的 ${e}（前端放行、后端拒收，选了出卡片、提交才失败）：前端=${JSON.stringify(fe)} 后端=${JSON.stringify(be)}`);
  };
  const feAttach = litOf(html, 'CORR_ATTACH_EXTS', 'Data_Correction.html');
  const beBase = litOf(routeSrc, 'CORRECTION_BASE_EXTS', 'routes/corrections.js');
  const feErrExtra = litOf(html, 'CORR_ERR_PROOF_EXTRA_EXTS', 'Data_Correction.html');
  const beErrExtra = litOf(routeSrc, 'CORRECTION_ERROR_PROOF_EXTRA_EXTS', 'routes/corrections.js');
  sameSet(feAttach, beBase, 'CORR_ATTACH_EXTS', 'CORRECTION_BASE_EXTS');
  sameSet(feErrExtra, beErrExtra, 'CORR_ERR_PROOF_EXTRA_EXTS', 'CORRECTION_ERROR_PROOF_EXTRA_EXTS');
  // 用户口径（2026-10-08）：Word 只在待修复数据收、且只收 .docx——共用清单不得含 doc/docx，额外清单含 docx 不含 doc
  assert.ok(!feAttach.includes('docx') && !feAttach.includes('doc'), `CORR_ATTACH_EXTS（三类共用）不得含 doc/docx：${JSON.stringify(feAttach)}`);
  assert.ok(feErrExtra.includes('docx') && !feErrExtra.includes('doc'), `CORR_ERR_PROOF_EXTRA_EXTS 应含 docx、不含 doc：${JSON.stringify(feErrExtra)}`);
  ok(`CORR_ATTACH_EXTS 与后端 CORRECTION_BASE_EXTS 同值（${JSON.stringify(feAttach)}，不含 doc/docx）；CORR_ERR_PROOF_EXTRA_EXTS 与后端 CORRECTION_ERROR_PROOF_EXTRA_EXTS 同值（${JSON.stringify(feErrExtra)}）`);

  // ③d 行为对拍（2026-10-08）：两边函数都从真实源码抽出来跑，不在守卫里另写一份算法。
  //   后端放行 ⇔ corrections.js 真实的 validateCorrectionAttachmentRule(type, busboy basename(name), size).ok（逐类型二次卡，
  //   四挂点都走它；multer 第一道用三类并集，恒宽于任一类型，不改变结论）；前端放行 ⇔ corrFileGateReject({ name, size }, type) === null。
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const normStart = serverSrc.indexOf('function normalizeAttachmentExt(');
  assert.ok(normStart !== -1, 'server.js 必须声明 function normalizeAttachmentExt(');
  const normEnd = serverSrc.indexOf('\n}', normStart);
  assert.ok(normEnd !== -1, 'normalizeAttachmentExt 函数体须以行首 } 结束');
  const beNorm = vm.runInNewContext(`(${serverSrc.slice(normStart, normEnd + 2)})`, { path, String });
  // codex 94 L-1：后端看到的不是浏览器原始文件名——multer 底层 busboy（preservePath 默认关）先截到最后一个 / 或 \ 之后。
  //   同样从真实源码抽 basename 来跑；corrections.js 若改设 preservePath，本建模前提失效，须同步改前端闸与本段。
  //   codex 95T L-1：只看去注释后的代码，且只拦非 false 的配置（注释里提到它、或显式写 preservePath: false 都不算）
  const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/preservePath\s*:(?!\s*false\b)/.test(routeCode), 'routes/corrections.js 不得把 preservePath 设为非 false（③d 按 busboy 默认截路径建模）');
  const busboyUtils = path.join(path.dirname(require.resolve('busboy', { paths: [path.join(__dirname, '..')] })), 'utils.js');
  const bbSrc = fs.readFileSync(busboyUtils, 'utf8');
  const bbStart = bbSrc.indexOf('function basename(');
  assert.ok(bbStart !== -1, `${busboyUtils} 须声明 function basename(`);
  const bbEnd = bbSrc.indexOf('\n}', bbStart);
  const bbBasename = vm.runInNewContext(`(${bbSrc.slice(bbStart, bbEnd + 2)})`, {});
  // 后端逐类型校验：切 corrections.js 从 CORRECTION_BASE_EXTS 声明到 validateCorrectionAttachmentRule 函数结束，原样在 vm 里跑
  const rulesStart = routeSrc.indexOf('const CORRECTION_BASE_EXTS');
  const valStart = routeSrc.indexOf('function validateCorrectionAttachmentRule(');
  const valEnd = valStart === -1 ? -1 : routeSrc.indexOf('\n}', valStart);
  assert.ok(rulesStart !== -1 && valStart > rulesStart && valEnd !== -1, 'routes/corrections.js 须先声明 CORRECTION_BASE_EXTS、后声明 function validateCorrectionAttachmentRule(（以行首 } 结束）');
  const beValidate = vm.runInNewContext(`${routeSrc.slice(rulesStart, valEnd + 2)}\nvalidateCorrectionAttachmentRule`,
    { ARCHIVE_EXTS, ARCHIVE_SIZE_BY_EXT, normalizeAttachmentExt: beNorm, Object, Array, Set, String, Math });
  const gateStart = html.indexOf('function corrFileGateReject(');
  const gateEndRel = html.slice(gateStart).indexOf('\n        }');
  assert.ok(gateStart !== -1 && gateEndRel !== -1, 'corrFileGateReject 函数须存在且以 8 空格缩进的 } 结束');
  const gateSrc = html.slice(gateStart, gateStart + gateEndRel + '\n        }'.length);
  const constSrc = ['CORR_ATTACH_MAX_SIZE', 'CORR_ATTACH_EXTS', 'CORR_ERR_PROOF_EXTRA_EXTS', 'CORR_ARCHIVE_EXTS', 'CORR_ARCHIVE_MAX_SIZE'].map((n) => {
    const m = html.match(new RegExp(`const\\s+${n}\\s*=\\s*[^;]+;`));
    assert.ok(m, `Data_Correction.html 须声明 const ${n}`);
    return m[0];
  }).join('\n');
  const feGate = vm.runInNewContext(`${constSrc}\n(${gateSrc})`, { String, Math });
  const TYPES = ['oa_proof', 'error_proof', 'fix_proof'];
  // 语料：常见合法 / 常见非法 / Word 新旧两种 / 大小写与首尾空白 / 点的位置边角 / 点后空白 / 控制字符 / 双扩展名 / 中文名
  const corpus = ['a.pdf', 'A.PDF', 'a.PDF ', ' a.png', '截图.png', 'x.jpeg', 'x.webp', 'x.bmp', 'x.gif', 'x.xls', 'x.xlsx', 'x.zip', 'x.RAR', 'x.7z',
    '需求说明.docx', 'x.DOCX', ' 需求.docx ', '旧版.DOC', 'a.doc', 'x.docm', 'x.dotx', 'x.txt', 'x.csv', 'x.heic', 'x.svg', 'x.tar.gz', 'a.pdf.docx', 'a.docx.pdf', '.docx', 'a. docx',
    '.png', '..png', '...png', 'a..png', 'a.', 'a.b.', 'pdf', '', 'a. pdf', 'a .pdf', 'a.p df', 'a.pdf ', '　a.png',
    'a\tb.png', 'a.png\u0007', '\u0000.png', 'a\u007f.png', 'a.png\u0085', 'a\tb.docx',
    // 含路径分隔符（codex 94 L-1）：末段以点开头 / 末段正常 / 末段为空 / 末段为「.」「..」/ 末段带空白
    '前缀\\.png', 'dir/.png', 'a\\b.png', 'a/b.pdf', 'x\\y.docx', 'dir/.docx', 'a.b\\c', 'a.png\\', 'a/', 'a/.', 'a\\..', 'a\\ b.png', 'a/b.png '];
  const mismatch = [];
  const acceptCount = {};
  for (const type of TYPES) {
    acceptCount[type] = 0;
    for (const name of corpus) {
      const be = beValidate(type, bbBasename(name), 1).ok === true;
      const fe = feGate({ name, size: 1 }, type) === null;
      if (fe) acceptCount[type]++;
      if (be !== fe) mismatch.push(`[${type}] ${JSON.stringify(name)}：后端${be ? '放行' : '拒收'}、前端${fe ? '放行' : '拒收'}`);
    }
  }
  assert.strictEqual(mismatch.length, 0, `前后端放行结论不一致 ${mismatch.length} 处：\n  ${mismatch.join('\n  ')}`);
  // 判别力锚点：防两边同时退化成「全拒」或「全放」仍一致而绿；待修复数据比另两类恰多放行语料里的 .docx 用例
  for (const type of TYPES) assert.ok(acceptCount[type] >= 14 && acceptCount[type] < corpus.length, `[${type}] 语料放行数应 ≥14 且 <${corpus.length}（实得 ${acceptCount[type]}）`);
  assert.ok(acceptCount.oa_proof === acceptCount.fix_proof && acceptCount.error_proof > acceptCount.oa_proof, `待修复数据应比 OA 截图 / 结果证明多放行（实得 ${JSON.stringify(acceptCount)}）`);
  // Word 用例逐个钉住（期望值手写）：待修复数据收 .docx（含大写、首尾空白、带路径），其余两类不收；.doc 三类都不收
  for (const name of ['需求说明.docx', 'x.DOCX', ' 需求.docx ', 'x\\y.docx']) {
    assert.strictEqual(feGate({ name, size: 1 }, 'error_proof'), null, `待修复数据应收 ${JSON.stringify(name)}`);
    for (const type of ['oa_proof', 'fix_proof']) {
      const msg = feGate({ name, size: 1 }, type);
      assert.ok(typeof msg === 'string' && /Word/.test(msg) && /PDF/.test(msg), `[${type}] ${JSON.stringify(name)} 应得 Word 专用拒收文案（含 Word、PDF），实得 ${JSON.stringify(msg)}`);
    }
  }
  // 类型缺失 / 未知时按「不收 Word」处理（fail-closed）
  for (const type of [undefined, '', 'ERROR_PROOF', 'unknown']) assert.ok(typeof feGate({ name: '需求说明.docx', size: 1 }, type) === 'string', `类型为 ${JSON.stringify(type)} 时不得收 docx`);
  // 文案只冻语义，不冻字面量：.doc 在待修复数据提示另存为 .docx 或 PDF；在其余两类提示另存为 PDF；均点名文件
  const docMsgErr = feGate({ name: '旧版.DOC', size: 1 }, 'error_proof');
  assert.ok(typeof docMsgErr === 'string' && docMsgErr.includes('旧版.DOC') && /\.docx/.test(docMsgErr) && /PDF/.test(docMsgErr), `待修复数据的 .doc 拒收文案应点名文件并提示 .docx / PDF，实得 ${JSON.stringify(docMsgErr)}`);
  const docMsgFix = feGate({ name: '旧版.DOC', size: 1 }, 'fix_proof');
  assert.ok(typeof docMsgFix === 'string' && docMsgFix.includes('旧版.DOC') && /Word/.test(docMsgFix) && /PDF/.test(docMsgFix), `结果证明的 .doc 拒收文案应点名文件并提示 PDF，实得 ${JSON.stringify(docMsgFix)}`);
  // 大小闸行为（codex 94 L-2）。期望值手写：非压缩包 20MB（后端 defaultSize）、压缩包 ARCHIVE_MAX_SIZE；恰等于上限放行、多 1 字节拒收；
  //   docx 只在待修复数据参与（20MB）。同时与后端逐类型校验对拍。
  const MB20 = 20 * 1024 * 1024;
  const sizeCases = [
    ['a.png', MB20, true], ['a.png', MB20 + 1, false], ['a.pdf', MB20 + 1, false],
    ['a.zip', MB20 + 1, true], ['a.7z', ARCHIVE_MAX_SIZE, true], ['a.rar', ARCHIVE_MAX_SIZE + 1, false],
    ['a.docx', MB20, true], ['a.docx', MB20 + 1, false],
  ];
  let sizeChecks = 0;
  for (const type of TYPES) {
    for (const [name, size, passWhenAllowed] of sizeCases) {
      const pass = passWhenAllowed && (!/\.docx$/.test(name) || type === 'error_proof');
      const r = feGate({ name, size }, type);
      assert.ok(pass ? r === null : (typeof r === 'string' && r.includes(name)), `[${type}] 大小闸：${name} ${size} 字节应${pass ? '放行' : '拒收（文案含文件名）'}，实得 ${JSON.stringify(r)}`);
      assert.strictEqual(beValidate(type, name, size).ok === true, pass, `[${type}] 后端逐类型校验对 ${name} ${size} 字节应${pass ? '放行' : '拒收'}`);
      sizeChecks++;
    }
  }
  ok(`corrFileGateReject 与 busboy basename + corrections.js validateCorrectionAttachmentRule 在 3 类 × ${corpus.length} 个文件名上放行结论逐个一致（放行 ${JSON.stringify(acceptCount)}）；Word 用例与 .doc 文案、类型缺失不收 Word 均按期望；大小闸 ${sizeChecks} 个边界用例前后端都按期望放行/拒收`);

  // ③e 贴图透传（codex 94 L-2）：注册回调须把 corrPickerCollect 的实际接收数原样返回给 u-paste.js（返回 undefined 时
  //   共享层按尝试张数报「已粘贴 N 张」，拒收后会谎报成功）。行为面由一次性浏览器验证覆盖，这里卡源码结构。
  const regStart = html.indexOf('UPaste.register({');
  assert.ok(regStart !== -1, 'Data_Correction.html 须有 UPaste.register({');
  const regEndRel = html.slice(regStart).indexOf('\n            });');
  assert.ok(regEndRel !== -1, 'UPaste.register 调用须以 12 空格缩进的 }); 结束');
  const regStripped = html.slice(regStart, regStart + regEndRel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/const\s+accepted\s*=\s*corrPickerCollect\(\s*key\s*,\s*files\s*\)\s*;\s*corrPickerRender\(\s*key\s*\)\s*;\s*return\s+accepted\s*;/.test(regStripped),
    `UPaste.register 的 collect 去注释后应含「const accepted = corrPickerCollect(key, files); corrPickerRender(key); return accepted;」${SHAPE_NOTE}，实际（去注释）：\n${regStripped}`);
  ok('贴图注册回调把 corrPickerCollect 的实际接收数原样返回给 u-paste.js');

  // ③f 运行时桩（codex 95T L-1 / K-2）：把一次性浏览器验证里的核心行为搬进本守卫——vm 里原样跑页面真实的常量、闸函数、
  //   两个收集函数、入口登记表与贴图注册函数，showToast / document / UPaste / 渲染函数用替身，断言「收了谁、拒了谁、返回几」。
  {
    const pick = (re, what) => { const m = html.match(re); assert.ok(m, `Data_Correction.html 须含 ${what}`); return m[0]; };
    const fnSrc = (name) => {
      const st = html.indexOf(`function ${name}(`);
      const endRel = st === -1 ? -1 : html.slice(st).indexOf('\n        }');
      assert.ok(st !== -1 && endRel !== -1, `${name} 函数须存在且以 8 空格缩进的 } 结束`);
      return html.slice(st, st + endRel + '\n        }'.length);
    };
    const src = [
      ...['CORR_ATTACH_MAX', 'CORR_ATTACH_MAX_SIZE', 'CORR_ATTACH_EXTS', 'CORR_ERR_PROOF_EXTRA_EXTS', 'CORR_ARCHIVE_EXTS', 'CORR_ARCHIVE_MAX_SIZE', 'DC_UPASTE_KIT_EXPECTED']
        .map(n => pick(new RegExp(`const\\s+${n}\\s*=\\s*[^;]+;`), `const ${n}`)),
      pick(/let\s+corrAttachFiles\s*=\s*\[\]\s*;/, 'let corrAttachFiles = [];'),
      pick(/const\s+CORR_PICKER_FILES\s*=\s*\{[\s\S]*?\n\s*\};/, 'const CORR_PICKER_FILES = { … };'),
      pick(/const\s+CORR_PICKER_TARGETS\s*=\s*\{[\s\S]*?\n\s*\};/, 'const CORR_PICKER_TARGETS = { … };'),
      fnSrc('corrFileGateReject'), fnSrc('corrAttachCollectFiles'), fnSrc('corrPickerCollect'), fnSrc('corrInitUPaste'),
    ].join('\n');
    const toasts = [];
    const renders = [];
    let attachTypeValue = '';
    let registered = null;
    const sandbox = {
      showToast: (m, t) => toasts.push(`${t}|${m}`),
      document: { getElementById: (id) => (id === 'attachType' ? { value: attachTypeValue } : null) },
      corrPickerRender: (k) => renders.push(k), renderCorrAttachPreview: () => renders.push('corrAttachPreview'), corrPasteScopeResolver: () => null,
      UPaste: { checkVersion: () => {}, register: (reg) => { registered = reg; } },
      console: { error: () => {} }, String, Math, Array, Object,
    };
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const run = (code) => vm.runInContext(code, ctx);
    const files = (...names) => names.map(n => ({ name: n, size: 1 }));
    const names = (expr) => JSON.parse(run(`JSON.stringify((${expr}).map(f => f.name))`));
    const expectType = { createOaProofPicked: 'oa_proof', createErrProofPicked: 'error_proof', completeFilesPicked: 'fix_proof', completeBatchFilesPicked: 'fix_proof', resubmitFilesPicked: 'fix_proof', resubmitBatchFilesPicked: 'fix_proof' };
    // 6 个入口：各喂 docx + png（期望值手写：只有待修复数据收 docx）
    for (const [key, type] of Object.entries(expectType)) {
      toasts.length = 0;
      run(`CORR_PICKER_FILES[${JSON.stringify(key)}] = []`);
      sandbox.__in = files('需求.docx', 'p.png');
      const got = run(`corrPickerCollect(${JSON.stringify(key)}, __in)`);
      const arr = names(`CORR_PICKER_FILES[${JSON.stringify(key)}]`);
      const wantArr = type === 'error_proof' ? ['需求.docx', 'p.png'] : ['p.png'];
      assert.deepStrictEqual(arr, wantArr, `[③f] ${key}（${type}）收文件应为 ${JSON.stringify(wantArr)}，实得 ${JSON.stringify(arr)}`);
      assert.strictEqual(got, wantArr.length, `[③f] ${key} corrPickerCollect 返回值应为实际接收数 ${wantArr.length}，实得 ${got}`);
      assert.strictEqual(toasts.length, type === 'error_proof' ? 0 : 1, `[③f] ${key} 拒收提示条数应为 ${type === 'error_proof' ? 0 : 1}，实得 ${JSON.stringify(toasts)}`);
    }
    assert.strictEqual(run('corrPickerCollect("__no_such_key__", [{ name: "a.png", size: 1 }])'), 0, '[③f] 未登记的入口 corrPickerCollect 应返回 0');
    // 数组里已有旧文件时，返回值是「本次新收」而不是数组总长（追加语义）
    run('CORR_PICKER_FILES.completeFilesPicked = [{ name: "old.png", size: 1 }]');
    sandbox.__in = files('需求.docx', 'p.png');
    assert.strictEqual(run('corrPickerCollect("completeFilesPicked", __in)'), 1, '[③f] 已有 1 个旧文件时再收 docx + png，返回值应为本次新收的 1（不是数组总长 2）');
    assert.deepStrictEqual(names('CORR_PICKER_FILES.completeFilesPicked'), ['old.png', 'p.png'], '[③f] 追加语义：旧文件保留、只追加本次收下的 png');
    // 补传弹窗：按 #attachType 分流（error_proof 收 docx；fix_proof 与空值不收）
    for (const [t, want] of [['error_proof', ['需求.docx', 'p.png']], ['fix_proof', ['p.png']], ['', ['p.png']]]) {
      attachTypeValue = t;
      toasts.length = 0;
      run('corrAttachFiles = []');
      sandbox.__in = files('需求.docx', 'p.png');
      const got = run('corrAttachCollectFiles(__in)');
      const arr = names('corrAttachFiles');
      assert.deepStrictEqual(arr, want, `[③f] 补传弹窗 #attachType=${JSON.stringify(t)} 收文件应为 ${JSON.stringify(want)}，实得 ${JSON.stringify(arr)}`);
      assert.strictEqual(got, want.length, `[③f] 补传弹窗 #attachType=${JSON.stringify(t)} 返回值应为 ${want.length}，实得 ${got}`);
    }
    attachTypeValue = 'error_proof';
    run('corrAttachFiles = [{ name: "old.png", size: 1, lastModified: 1 }]');
    sandbox.__in = files('需求.docx');
    assert.strictEqual(run('corrAttachCollectFiles(__in)'), 1, '[③f] 补传弹窗已有 1 个旧文件时再收 1 个 docx，返回值应为本次新收的 1（不是数组总长 2）');
    // 贴图注册回调：返回值 = 实际接收数（全拒时 0），并触发对应渲染
    run('corrInitUPaste._done = false; corrInitUPaste()');
    assert.ok(registered && typeof registered.collect === 'function', '[③f] corrInitUPaste 应调用 UPaste.register 并给出 collect');
    const pasteCases = [
      ['createErrProofPicked', '', files('需求.docx'), 1], ['completeFilesPicked', '', files('需求.docx'), 0], ['completeFilesPicked', '', files('a.png', 'b.txt'), 1],
      ['corrAttachPreview', 'error_proof', files('需求.docx'), 1], ['corrAttachPreview', 'fix_proof', files('需求.docx'), 0],
    ];
    for (const [key, t, list, want] of pasteCases) {
      attachTypeValue = t;
      renders.length = 0;
      run('corrAttachFiles = []');
      if (key !== 'corrAttachPreview') run(`CORR_PICKER_FILES[${JSON.stringify(key)}] = []`);
      const got = registered.collect(key, list);
      assert.strictEqual(got, want, `[③f] 贴图回调 collect(${key}${t ? `，#attachType=${t}` : ''}, ${JSON.stringify(list.map(f => f.name))}) 应返回实际接收数 ${want}，实得 ${JSON.stringify(got)}`);
      assert.deepStrictEqual(renders, [key], `[③f] 贴图回调 collect(${key}) 应触发且只触发 ${key} 的渲染，实得 ${JSON.stringify(renders)}`);
    }
    ok(`运行时桩：6 个入口各喂 docx + png 按类型收拒且返回实际接收数、未登记入口返回 0；补传弹窗按 #attachType 三种取值分流；贴图回调 ${pasteCases.length} 例返回实际接收数并只渲染目标区`);
  }

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
