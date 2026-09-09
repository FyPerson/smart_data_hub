// verify-collab-attach-archive-static.js — 附件压缩包支持方案 D1/D6/D9/D10 静态守卫（纯文本检查，不起 server）
//   动机：数据协作模块仍在单体 server.js 内（非 routes/ 工厂函数），require('../server.js') 会触发整个
//   应用启动（真实外部 DB 连接/钉钉轮询等），本模块无法像 sys-iteration/corrections 那样起 in-process app——
//   本文件只做纯文本/正则的源码断言，覆盖后端规则表与前端常量/accept/渲染分支的静态形状；行为面（真实
//   HTTP 上传/下载）留给 scripts/verify-collab-attach-archive.js（依赖本地 localhost:3000 活体 server）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE } = require('../utils/attachment-archive');

const serverPath = path.join(__dirname, '..', 'server.js');
const serverSrc = fs.readFileSync(serverPath, 'utf8');
const htmlPath = path.join(__dirname, '..', 'public', 'Data_Collab.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const versioningPath = path.join(__dirname, '..', 'utils', 'collab-attachment-versioning.js');
const versioningSrc = fs.readFileSync(versioningPath, 'utf8');
const submitHelpersPath = path.join(__dirname, '..', 'utils', 'collab-submit-helpers.js');
const submitHelpersSrc = fs.readFileSync(submitHelpersPath, 'utf8');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function main() {
  // ── 后端 server.js 静态断言 ──

  // ① COLLAB_ATTACHMENT_RULES：screenshot / data_scope 两条 exts 追加 .concat(ARCHIVE_EXTS)，
  //    sizeByExt 改用 ARCHIVE_SIZE_BY_EXT；example_xlsx/result_data/result_script 三条不变（不含 ARCHIVE_EXTS）。
  const rulesBlockMatch = serverSrc.match(/const COLLAB_ATTACHMENT_RULES = \{[\s\S]*?\n\};/);
  assert.ok(rulesBlockMatch, 'COLLAB_ATTACHMENT_RULES 声明块必须存在于 server.js');
  const rulesBlock = rulesBlockMatch[0];
  const screenshotLine = rulesBlock.split('\n').find(l => /^\s*screenshot:/.test(l));
  const dataScopeLine = rulesBlock.split('\n').find(l => /^\s*data_scope:/.test(l));
  assert.ok(screenshotLine && /\.concat\(ARCHIVE_EXTS\)/.test(screenshotLine) && /ARCHIVE_SIZE_BY_EXT/.test(screenshotLine),
    `screenshot 规则行应含 .concat(ARCHIVE_EXTS) + ARCHIVE_SIZE_BY_EXT，实际：${screenshotLine}`);
  assert.ok(dataScopeLine && /\.concat\(ARCHIVE_EXTS\)/.test(dataScopeLine) && /ARCHIVE_SIZE_BY_EXT/.test(dataScopeLine),
    `data_scope 规则行应含 .concat(ARCHIVE_EXTS) + ARCHIVE_SIZE_BY_EXT，实际：${dataScopeLine}`);
  for (const key of ['example_xlsx', 'result_data', 'result_script']) {
    const line = rulesBlock.split('\n').find(l => new RegExp(`^\\s*${key}:`).test(l));
    assert.ok(line, `${key} 规则行应存在`);
    assert.ok(!/ARCHIVE_EXTS/.test(line), `${key} 规则行不应引入 ARCHIVE_EXTS（本次不动），实际：${line}`);
  }
  ok('COLLAB_ATTACHMENT_RULES：screenshot/data_scope 追加 ARCHIVE_EXTS+ARCHIVE_SIZE_BY_EXT，example_xlsx/result_data/result_script 未动');

  // ② validateCollabAttachmentRule hasOwnProperty 原型键守
  assert.ok(/Object\.prototype\.hasOwnProperty\.call\(COLLAB_ATTACHMENT_RULES,\s*attachmentType\)/.test(serverSrc),
    'validateCollabAttachmentRule 应含 hasOwnProperty.call(COLLAB_ATTACHMENT_RULES, attachmentType) 原型键守');
  ok('validateCollabAttachmentRule 含 hasOwnProperty 原型键守');

  // ③ result_data_screenshot 入口同法排除 isArchiveExt（紧邻既有排除 .pdf 逻辑）
  const shotGateMatch = serverSrc.match(/if \(shotExt === '\.pdf'\) \{[\s\S]*?\n\s*\}[\s\S]{0,400}/);
  assert.ok(shotGateMatch, 'result_data_screenshot 入口的 .pdf 排除分支必须存在（结构锚）');
  assert.ok(/isArchiveExt\(shotExt\)/.test(shotGateMatch[0]), `result_data_screenshot 入口应在 .pdf 排除逻辑附近同法追加 isArchiveExt(shotExt) 排除，实际片段：${shotGateMatch[0].slice(0, 300)}`);
  // L2（Opus 预筛 C3）→ codex 07 M1 收窄：只截取 isArchiveExt(shotExt) 自己的条件块（到下一个 `}` 收尾），在块内断言
  //   cleanupPending() + status(400) + INVALID_SCREENSHOT——原先对整段 shotGateMatch 断言会被既有 .pdf 分支喂绿（删压缩包分支的清理照绿）
  const archiveBlockMatch = serverSrc.match(/if \(isArchiveExt\(shotExt\)\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(archiveBlockMatch, 'result_data_screenshot 入口须有独立的 if (isArchiveExt(shotExt)) { … } 条件块');
  const archiveBlock = archiveBlockMatch[1];
  assert.ok(/cleanupPending\(\)/.test(archiveBlock), `压缩包排除块内须调 cleanupPending()（删掉这里红），实际块：${archiveBlock.slice(0, 200)}`);
  assert.ok(/status\(400\)/.test(archiveBlock) && /code:\s*'INVALID_SCREENSHOT'/.test(archiveBlock), `压缩包排除块内须 400 + code 'INVALID_SCREENSHOT'（换码这里红），实际块：${archiveBlock.slice(0, 200)}`);
  ok('result_data_screenshot 入口同法排除压缩包（isArchiveExt(shotExt)，紧邻既有 .pdf 排除，同清理同码）');

  // ④ issueUpload：ISSUE_EFFECTIVE_EXTS 派生 + fileFilter 内显式压缩包拦截
  assert.ok(/const ISSUE_EFFECTIVE_EXTS = COLLAB_ALLOWED_EXTS_UNION\.filter\(e => !isArchiveExt\(e\)\)/.test(serverSrc),
    'ISSUE_EFFECTIVE_EXTS 应由 COLLAB_ALLOWED_EXTS_UNION.filter(e => !isArchiveExt(e)) 派生，不手写字面量');
  const issueUploadBlockMatch = serverSrc.match(/const issueUpload = multer\(\{[\s\S]*?\n\}\);/);
  assert.ok(issueUploadBlockMatch, 'issueUpload multer 配置块必须存在');
  const issueUploadBlock = issueUploadBlockMatch[0];
  assert.ok(/isArchiveExt\(ext\)/.test(issueUploadBlock), 'issueUpload fileFilter 应含 isArchiveExt(ext) 显式压缩包拦截');
  assert.ok(/ISSUE_EFFECTIVE_EXTS\.join\('\/'\)/.test(issueUploadBlock), 'issueUpload fileFilter 拒绝消息应用 ISSUE_EFFECTIVE_EXTS（不含压缩包）拼「仅允许」列表');
  ok('issueUpload：ISSUE_EFFECTIVE_EXTS 派生存在 + fileFilter 内 isArchiveExt 显式拦截 + 拒绝消息用有效白名单');

  // ── 前端 Data_Collab.html 静态断言 ──

  // ⑤ COLLAB_ARCHIVE_EXTS / COLLAB_ARCHIVE_MAX_SIZE 与真相源同值
  const extsMatch = html.match(/const\s+COLLAB_ARCHIVE_EXTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(extsMatch, 'COLLAB_ARCHIVE_EXTS 声明必须存在于 Data_Collab.html');
  const feExts = extsMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(s => '.' + s.toLowerCase());
  const truthExts = ARCHIVE_EXTS.map(e => e.toLowerCase());
  assert.strictEqual(feExts.length, truthExts.length, `COLLAB_ARCHIVE_EXTS 数量应与真相源一致：前端=${JSON.stringify(feExts)} 真相源=${JSON.stringify(truthExts)}`);
  for (const e of truthExts) assert.ok(feExts.includes(e), `COLLAB_ARCHIVE_EXTS 缺少真相源扩展名 ${e}`);
  const sizeMatch = html.match(/const\s+COLLAB_ARCHIVE_MAX_SIZE\s*=\s*([0-9_]+)/);
  assert.ok(sizeMatch, 'COLLAB_ARCHIVE_MAX_SIZE 声明必须存在于 Data_Collab.html');
  const feSize = Number(sizeMatch[1].replace(/_/g, ''));
  assert.strictEqual(feSize, ARCHIVE_MAX_SIZE, `COLLAB_ARCHIVE_MAX_SIZE（${feSize}）应与真相源 ARCHIVE_MAX_SIZE（${ARCHIVE_MAX_SIZE}）同值`);
  ok(`COLLAB_ARCHIVE_EXTS/COLLAB_ARCHIVE_MAX_SIZE 与真相源同值（${JSON.stringify(feExts)} / ${feSize}）`);

  // ⑥ accept 属性：f_files / f_data_scope 含三扩展名；f_template / f_export_screenshot / f_delivery_script /
  //    f_delivery_data 不含
  const acceptOf = (id) => {
    const m = html.match(new RegExp(`id="${id}"[^>]*accept="([^"]*)"`));
    assert.ok(m, `input#${id} 必须存在且带 accept 属性`);
    return m[1];
  };
  for (const id of ['f_files', 'f_data_scope']) {
    const accept = acceptOf(id);
    for (const ext of ['.zip', '.rar', '.7z']) assert.ok(accept.includes(ext), `input#${id} 的 accept 应含 ${ext}，实际="${accept}"`);
  }
  for (const id of ['f_template', 'f_export_screenshot', 'f_delivery_script', 'f_delivery_data']) {
    const accept = acceptOf(id);
    for (const ext of ['.zip', '.rar', '.7z']) assert.ok(!accept.includes(ext), `input#${id} 的 accept 不应含 ${ext}（本次不放开），实际="${accept}"`);
  }
  ok('accept 属性：f_files/f_data_scope 含 .zip/.rar/.7z；f_template/f_export_screenshot/f_delivery_script/f_delivery_data 不含');

  // ⑦ _renderScreenshotItem 通用分支结构锚（去掉行首//注释后匹配，防止只在注释里提了一句就误判通过）
  const stripLineComments = (s) => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const stripped = stripLineComments(html);
  //   Opus 预筛 C3 M2 变异实证：原「/📦/.test(html)」对既有 UI 文案 :1399/:3481 与注释都命中，删掉两处新增 span 照绿——
  //   改为把 📦 span 绑到各自函数体（去注释后、函数声明起 ≤1500 字内）的结构锚。取函数体窗口：从声明到下一处 `function ` 声明。
  const fnBody = (src, sig) => { const i = src.indexOf(sig); assert.ok(i !== -1, `${sig} 必须存在`); const rest = src.slice(i + sig.length); const j = rest.search(/\n\s*(async\s+)?function\s+\w+\s*\(/); return sig + (j === -1 ? rest : rest.slice(0, j)); };
  const renderShotBody = fnBody(stripped, 'function _renderScreenshotItem(f)');
  assert.ok(/const isImg = \/\\\.\(png\|jpe\?g\|gif\|webp\)\$\/i\.test\(displayName\)/.test(renderShotBody),
    '_renderScreenshotItem 内应有 isImg 判定（非 PDF 且非图片 → 通用 📦 分支）');
  assert.ok(/<span style="font-size:28px;line-height:1;">📦<\/span>/.test(renderShotBody),
    '_renderScreenshotItem 通用分支体内应含 📦 span（删掉该分支这里红；既有 UI 文案与注释里的 📦 不算数）');
  ok('_renderScreenshotItem 通用分支结构锚（函数体内 isImg 判定 + 📦 span）存在');

  // ⑧ renderFilePreview（建单弹窗预览，selectedFiles/f_files）同款 isImg 分支 + 📦 span（26px 版）
  const renderPreviewBody = fnBody(stripped, 'function renderFilePreview()');
  assert.ok(/const isImg = \/\\\.\(png\|jpe\?g\|gif\|webp\)\$\/i\.test\(f\.name\)/.test(renderPreviewBody),
    'renderFilePreview 内应有 isImg 判定（非 PDF 且非图片 → 通用 📦 占位分支，不做 blob 预览）');
  assert.ok(/<span style="font-size:26px;line-height:1;">📦<\/span>/.test(renderPreviewBody),
    'renderFilePreview 通用分支体内应含 📦 span');
  ok('renderFilePreview 通用分支结构锚（函数体内 isImg 判定 + 📦 span）存在');

  // ⑨ collectFilesInto / collectIntoSelectedFiles 大小分流判据存在——对 stripped 取值，与 ⑦⑧ 同口径（Opus 预筛 C3 M3）
  assert.ok(/const isArchive = COLLAB_ARCHIVE_EXTS\.includes\(ext\) && allowedExts\.includes\(ext\)/.test(stripped),
    'collectFilesInto 内应有按 allowedExts 收窄的 isArchive 判据（防误放宽到 template/delivery 等未放开压缩包的入口）');
  assert.ok(/const isArchive = COLLAB_ARCHIVE_EXTS\.includes\(ext\);\s*\n\s*const sizeLimit = isArchive \? COLLAB_ARCHIVE_MAX_SIZE : MAX_FILE_SIZE/.test(stripped),
    'collectIntoSelectedFiles 内应有 isArchive → COLLAB_ARCHIVE_MAX_SIZE 分流判据');
  ok('collectFilesInto / collectIntoSelectedFiles 大小分流判据存在（去注释后匹配）');

  // ⑩ 代提端点旧字段显式拒压缩包（方案 D8 由 C4 前移到 C3b·Opus 预筛 C3 H2）：结构锚 + 错误码
  assert.ok(/for \(const item of adminUploadedFiles\) \{[\s\S]{0,600}?isArchiveExt\(adminExt\)[\s\S]{0,400}?ADMIN_FIELD_ARCHIVE_NOT_ALLOWED/.test(serverSrc),
    'admin-submit-on-behalf 收集 adminUploadedFiles 后应逐文件 isArchiveExt → 400 ADMIN_FIELD_ARCHIVE_NOT_ALLOWED（堵联合白名单扩容旁路）');
  ok('代提旧字段 result_script/result_data 显式拒压缩包结构锚存在');

  // ── C4：result_extra 全链静态断言 ──

  // ⑪ COLLAB_ATTACHMENT_RULES.result_extra 规则存在（exts=ARCHIVE_EXTS，defaultSize=ARCHIVE_MAX_SIZE）
  {
    const rulesBlockMatch2 = serverSrc.match(/const COLLAB_ATTACHMENT_RULES = \{[\s\S]*?\n\};/);
    assert.ok(rulesBlockMatch2, 'COLLAB_ATTACHMENT_RULES 声明块必须存在（C4 复核）');
    const extraLine = rulesBlockMatch2[0].split('\n').find(l => /^\s*result_extra:/.test(l));
    assert.ok(extraLine, 'COLLAB_ATTACHMENT_RULES 应含 result_extra 规则行');
    assert.ok(/exts:\s*ARCHIVE_EXTS/.test(extraLine) && /defaultSize:\s*ARCHIVE_MAX_SIZE/.test(extraLine),
      `result_extra 规则行应为 exts:ARCHIVE_EXTS + defaultSize:ARCHIVE_MAX_SIZE（真相源派生，不手写字面量），实际：${extraLine}`);
  }
  ok('COLLAB_ATTACHMENT_RULES.result_extra 规则存在且从真相源派生');

  // ⑫ utils/collab-attachment-versioning.js：VERSIONED_DELIVERY_ATTACHMENT_TYPES 含 result_extra；
  //    ATTACHMENT_TYPE_TO_ABBR.result_extra='re'；activateNewVersion 内测试钩子 __afterFirstRenameHook 存在。
  {
    const versionedMatch = versioningSrc.match(/const VERSIONED_DELIVERY_ATTACHMENT_TYPES = \[([^\]]*)\];/);
    assert.ok(versionedMatch, 'VERSIONED_DELIVERY_ATTACHMENT_TYPES 声明必须存在');
    assert.ok(/'result_extra'/.test(versionedMatch[1]), `VERSIONED_DELIVERY_ATTACHMENT_TYPES 应含 'result_extra'，实际：[${versionedMatch[1]}]`);
    const abbrMatch = versioningSrc.match(/const ATTACHMENT_TYPE_TO_ABBR = \{[\s\S]*?\n\};/);
    assert.ok(abbrMatch, 'ATTACHMENT_TYPE_TO_ABBR 声明必须存在');
    assert.ok(/result_extra:\s*'re'/.test(abbrMatch[0]), `ATTACHMENT_TYPE_TO_ABBR 应含 result_extra: 're'，实际块：${abbrMatch[0]}`);
    assert.ok(/typeof params\.__afterFirstRenameHook === 'function'/.test(versioningSrc),
      'activateNewVersion 内应有 __afterFirstRenameHook 测试挂点（首个 rename 成功后调用）');
    // §3.1 完整快照校验须放开 result_extra（0..5，非必备）——否则 C4 全链会被 INCOMPLETE_SNAPSHOT 挡死
    assert.ok(/extraCount > 5/.test(versioningSrc) && /t !== 'result_extra'/.test(versioningSrc),
      '§3.1 完整快照校验应放开 result_extra（extraCount>5 才拒，且 otherTypes 过滤应排除 result_extra）');
  }
  ok('collab-attachment-versioning.js：VERSIONED_DELIVERY_ATTACHMENT_TYPES/ATTACHMENT_TYPE_TO_ABBR 含 extra + 测试钩子 + §3.1 放开 extra');

  // ⑬ utils/collab-submit-helpers.js：分类器显式三类映射（RESULT_EXTRA_EXTS 从真相源派生）+ RESULT_EXTRA_TOO_MANY
  {
    assert.ok(/const RESULT_EXTRA_EXTS = new Set\(ARCHIVE_EXTS\)/.test(submitHelpersSrc),
      'RESULT_EXTRA_EXTS 应为 new Set(ARCHIVE_EXTS)（真相源派生，不手写字面量）');
    assert.ok(/RESULT_EXTRA_TOO_MANY/.test(submitHelpersSrc), '分类器应有 RESULT_EXTRA_TOO_MANY 错误码（extra 超 5 个）');
    assert.ok(/function groupUploadedDeliveryFiles\(files, validateRule, normalizeExt\)/.test(submitHelpersSrc),
      'groupUploadedDeliveryFiles 签名应含第三参 normalizeExt（注入归一化函数）');
  }
  ok('collab-submit-helpers.js：显式三类映射 + RESULT_EXTRA_TOO_MANY + normalizeExt 注入参数');

  // ⑭ server.js：submitUpload files:15（两处：multer limits 与 array 调用）+ groupUploadedDeliveryFiles 调用传 normalizeAttachmentExt
  {
    assert.ok(/const submitUpload = multer\(\{[\s\S]{0,300}?files:\s*15/.test(serverSrc), 'submitUpload multer limits.files 应为 15');
    assert.ok(/submitUpload\.array\('files',\s*15\)/.test(serverSrc), "submitUpload.array 调用应为 array('files', 15)");
    assert.ok(/groupUploadedDeliveryFiles\(req\.files, validateCollabAttachmentRule, normalizeAttachmentExt\)/.test(serverSrc),
      '/submit 端点调用 groupUploadedDeliveryFiles 应显式传 normalizeAttachmentExt 作为第三参');
  }
  ok('server.js：submitUpload files:15（两处）+ /submit 调分类器传 normalizeAttachmentExt');

  // ⑮ :18234 EXPORTING 切回流转端点手写 IN 列表已改引常量（不再是字面量 IN ('result_data', 'result_script')）
  {
    assert.ok(/collabVersioning\.VERSIONED_DELIVERY_ATTACHMENT_TYPES\.map\(\(\) => '\?'\)\.join\(','\)/.test(serverSrc),
      'EXPORTING 切回流转端点的历史附件 superseded UPDATE 应引用 collabVersioning.VERSIONED_DELIVERY_ATTACHMENT_TYPES 派生占位符，不手写 IN 列表');
    // 反向锚：旧的手写字面量在「切回流转」注释附近应已不存在（防止只加了新代码没删旧代码，两套并存）
    const fallbackSectionMatch = serverSrc.match(/历史附件标 superseded[\s\S]{0,600}/);
    assert.ok(fallbackSectionMatch, '切回流转「历史附件标 superseded」注释锚点必须存在');
    assert.ok(!/attachment_type IN \('result_data', 'result_script'\)/.test(fallbackSectionMatch[0]),
      '切回流转分支不应残留手写字面量 IN (\'result_data\', \'result_script\')（应已替换为常量占位符拼接）');
  }
  ok(':18234 EXPORTING 切回流转端点已改引 VERSIONED_DELIVERY_ATTACHMENT_TYPES 常量，无残留手写 IN 列表');

  // ⑯ admin 代提端点：collabUpload.fields 含 result_extra(5)；仅对 result_extra 走 validateCollabAttachmentRule
  //    二次卡（ATTACHMENT_RULE_VIOLATION）；批内撞名 Set + ATTACHMENT_NAME_COLLISION；adminHasFormalDelivery
  //    只替换一处判据（doneAtSource 那行），hasAdminUpload 其余用法不变。
  {
    assert.ok(/\{ name: 'result_extra', maxCount: 5 \}/.test(serverSrc), "admin 代提 collabUpload.fields 应含 { name: 'result_extra', maxCount: 5 }");
    assert.ok(/validateCollabAttachmentRule\('result_extra', item\.file\.originalname, item\.file\.size\)/.test(serverSrc),
      '仅 result_extra 应逐文件走 validateCollabAttachmentRule 二次卡');
    assert.ok(/ATTACHMENT_RULE_VIOLATION/.test(serverSrc), "代提 result_extra 校验失败应返回 code: 'ATTACHMENT_RULE_VIOLATION'");
    assert.ok(/const finalPathSeen = new Set\(\)/.test(serverSrc) && /ATTACHMENT_NAME_COLLISION/.test(serverSrc),
      '代提 rename 循环前应有批内 finalPath Set 查重 + 400 ATTACHMENT_NAME_COLLISION');
    assert.ok(/const adminHasFormalDelivery = adminUploadedFiles\.some\(x => x\.attachment_type === 'result_data' \|\| x\.attachment_type === 'result_script'\)/.test(serverSrc),
      'adminHasFormalDelivery 定义应存在（只表达"本次有正式交付物"）');
    // 只应有一处把 adminHasFormalDelivery 赋给 doneAtSource（防止误扩散到其它 5 个 hasAdminUpload 消费点）
    const doneAtSourceHits = (serverSrc.match(/doneAtSource = adminHasFormalDelivery \?/g) || []).length;
    assert.strictEqual(doneAtSourceHits, 1, `adminHasFormalDelivery 应恰好只替换 doneAtSource 那一处判据，实际命中 ${doneAtSourceHits} 处`);
    // Opus 预筛 C4 M3：原「全文 ≥6」被注释喂绿（真实代码 5 处，注释 4 处）且删任一真实用法仍绿——改为剥注释后精确等于 5，
    //   并对 4 个既有消费点各自结构锚（DONE→DONE 门 / expected_status 门 / 目录准备 / attachment_dir 回写）
    const serverNoComments = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"])\/\/[^\n]*$/gm, '$1');
    const hasAdminUploadHits = (serverNoComments.match(/\bhasAdminUpload\b/g) || []).length;
    assert.strictEqual(hasAdminUploadHits, 5, `hasAdminUpload 去注释后应恰 5 处（定义 + DONE→DONE 门 + expected_status 门 + 目录准备 + attachment_dir 回写），实际 ${hasAdminUploadHits}`);
    assert.ok(/const hasAdminUpload = adminUploadedFiles\.length > 0/.test(serverNoComments), 'hasAdminUpload 定义须保持「本次有任何附件」语义');
    assert.ok(/collab\.status === 'DONE' && !hasAdminUpload/.test(serverNoComments), 'DONE→DONE 强制门须仍引 hasAdminUpload');
    assert.ok(/hasAdminUpload && expectedStatus === null/.test(serverNoComments), 'expected_status 必带门须仍引 hasAdminUpload');
    assert.ok(/if \(hasAdminUpload\) \{/.test(serverNoComments), '目录准备分支须仍引 hasAdminUpload');
    assert.ok(/\[hasAdminUpload \? attachmentDirName : null, id\]/.test(serverNoComments), 'attachment_dir 回写须仍引 hasAdminUpload');
    // C4c（Opus 预筛 C4 M1）：通用 /attachments 端点对交付物类型的 409 判据须引常量，不手写二元列表
    assert.ok(/if \(collabVersioning\.VERSIONED_DELIVERY_ATTACHMENT_TYPES\.includes\(attachment_type\)\) \{/.test(serverNoComments), '通用 /attachments 端点交付物 409 判据须引 VERSIONED_DELIVERY_ATTACHMENT_TYPES（含 result_extra），不手写 [result_data, result_script]');
    assert.ok(!/\['result_data', 'result_script'\]\.includes\(attachment_type\)/.test(serverNoComments), '手写 [result_data, result_script].includes 二元列表须已移除');
  }
  ok('admin 代提端点：fields 含 result_extra(5) + 独立二次卡 + 批内撞名保护 + adminHasFormalDelivery 只替换 doneAtSource 一处');

  // ⑰ 前端：f_delivery_extra / f_admin_submit_extra accept 含三扩展名；DELIVERY_UNION_MAX=15；
  //    renderDeliverySection 补充材料区块结构锚；selectedDeliveryExtra 生命周期（打开清空）。
  {
    for (const id of ['f_delivery_extra', 'f_admin_submit_extra']) {
      const accept = acceptOf(id);
      for (const ext of ['.zip', '.rar', '.7z']) assert.ok(accept.includes(ext), `input#${id} 的 accept 应含 ${ext}，实际="${accept}"`);
    }
    assert.ok(/const DELIVERY_UNION_MAX = 15/.test(html), 'DELIVERY_UNION_MAX 应为 15（script+data+extra 联合计数上限）');
    assert.ok(/补充材料（压缩包）/.test(html), 'renderDeliverySection 应含「补充材料（压缩包）」区块标题');
    assert.ok(/attachment_type === 'result_extra'/.test(html), '前端应有按 result_extra 类型过滤附件的逻辑（renderDeliverySection extraFiles）');
    // codex 08 rec：初始化 `let selectedDeliveryExtra = []` 也能喂绿全文正则——限定在 openSubmitDeliveryDialog / openAdminSubmitModal 函数体内（去注释）匹配
    const strippedAll = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fnBodyOf = (sig) => { const i = strippedAll.indexOf(sig); assert.ok(i !== -1, `${sig} 必须存在`); const rest = strippedAll.slice(i + sig.length); const j = rest.search(/\n\s*(async\s+)?function\s+\w+\s*\(/); return j === -1 ? rest : rest.slice(0, j); };
    assert.ok(/selectedDeliveryExtra = \[\];/.test(fnBodyOf('function openSubmitDeliveryDialog(')), 'openSubmitDeliveryDialog 函数体内应重置 selectedDeliveryExtra = []（删掉打开时清空这里红）');
    assert.ok(/selectedAdminSubmitExtra = \[\];/.test(fnBodyOf('function openAdminSubmitDialog(')), 'openAdminSubmitDialog 函数体内应重置 selectedAdminSubmitExtra = []');
  }
  ok('前端：f_delivery_extra/f_admin_submit_extra accept 含三扩展名 + DELIVERY_UNION_MAX=15 + renderDeliverySection 补充材料区块 + selectedDeliveryExtra 打开清空');

  // ⑱ C6（用户裁定 P4）：补充材料区块删除按钮走 canModifyDelivery 门 + DELETE 端点 DONE 分支 isResultType 引常量含 extra
  assert.ok(/deleteDeliveryAttachment\(\$\{f\.id\}, \$\{d\.id\}, 'result_extra', 0\)/.test(html), "renderExtraSectionHtml 应渲染 result_extra 删除按钮（deleteDeliveryAttachment(..., 'result_extra', 0)）");
  assert.ok(/const isResultType = collabVersioning\.VERSIONED_DELIVERY_ATTACHMENT_TYPES\.includes\(att\.attachment_type\)/.test(serverSrc), 'DELETE 端点 DONE 分支 isResultType 应引 VERSIONED_DELIVERY_ATTACHMENT_TYPES（含 result_extra）');
  ok('C6：补充材料删除按钮 + DELETE 端点 isResultType 引常量');


  console.log(`\n✅ verify-collab-attach-archive-static 全部通过（${passed} 项断言）`);
}

try {
  main();
} catch (e) {
  console.error('❌ verify-collab-attach-archive-static 失败:', e && e.stack || e);
  process.exit(1);
}
