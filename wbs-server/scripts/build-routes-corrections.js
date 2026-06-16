// build-routes-corrections.js — J1 组装工具
// 从 server.js 程序化切割 correction 三区，组装成 routes/corrections.js（行为零变更）。
//   · 区1 readiness（195-245）→ factory 作用域顶部
//   · 区2a 建表 serialize 块（1991-2161）→ initSchema() body
//   · 区2b runCorrectionMigration 函数（2164-2261）→ factory 作用域函数
//   · 区3 主体+18端点（18289-19802）→ router；18 端点 app.xxx('/api/corrections...') 改 router.xxx('/...')
//   · 16 注入符号 destructure deps；导出 { initSchema, router, _internals }
// 手抄 1900 行必错 → 程序化切割保证"删的==增的"（除端点路径 18 处机械改写）。
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = src.split('\n');
const slice = (a, b) => lines.slice(a - 1, b).join('\n');   // 1-based inclusive

const region1 = slice(190, 245);     // 含 190-194 模块级前导注释 + readiness state + 中间件 + 列常量 + 白名单（与 J2 删除边界对称）
const region2a = slice(1991, 2161);  // 建表 serialize 块（含 migration 触发 callback）
const region2b = slice(2164, 2261);  // runCorrectionMigration 函数
let region3 = slice(18289, 19802);   // 常量 + helper + 18 端点

// ── codex M-3：切割边界哨兵——server.js 行号漂移时立即失败（防静默生成错文件）
const sentinel = (lineNo, re, label) => {
  if (!re.test(lines[lineNo - 1] || '')) {
    throw new Error(`边界哨兵失败 @L${lineNo}（${label}）：实际="${(lines[lineNo - 1] || '').trim().slice(0, 70)}"`);
  }
};
sentinel(190, /数据修正模块 schema readiness/, '区1 前导注释起点');
sentinel(2161, /^\s*\}\);\s*$/, '区2a serialize 闭合 });');
sentinel(2162, /^\}\s*$/, 'L2162 initTable 闭合（留 server.js 不搬）');
sentinel(2170, /^async function runCorrectionMigration\(/, '区2b migration 函数头');
sentinel(18289, /^\/\/ ={20,}\s*$/, '区3 起始等号分隔线');
sentinel(18290, /数据修正模块 API/, '区3 起始标题（correction 区特征）');
sentinel(19802, /^\s*\}\);\s*$/, '区3 create-chat 端点闭合 });');

// ── 端点路径改写：app.xxx('/api/corrections[/suffix]') → router.xxx('/[suffix]')
//    端点均单引号（grep 实测），quote class 只需 ['"]。
let endpointCount = 0;
region3 = region3.replace(
  /\bapp\.(get|post|put|delete)\((['"])\/api\/corrections((?:\/[^'"]*)?)\2/g,
  (m, method, q, suffix) => { endpointCount++; return `router.${method}(${q}${suffix || '/'}${q}`; }
);

// ── self-require 候选：去注释后真有代码引用才 require（避免引入未用 import）
//   M-3（codex 末次审）：本检测对字符串/行尾注释不够精确，但 collabVersioning/collabSubmitHelpers 已在
//   J1 L-2 grep 核实区内真代码引用（L19008/L19235）；build 为一次性切割工具（J2 后 server.js correction
//   已删、不再重新生成），故不加额外静态断言。若未来复用本工具，须重核 self-require 清单。
const decomment = (txt) => txt.split('\n')
  .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const code = decomment([region1, region2a, region2b, region3].join('\n'));
const used = (sym) => new RegExp('\\b' + sym + '\\b').test(code);

const requires = [`const express = require('express');`];
if (used('multer')) requires.push(`const multer = require('multer');`);
if (used('path')) requires.push(`const path = require('path');`);
if (used('fs')) requires.push(`const fs = require('fs');`);
if (used('dingtalkNotify')) requires.push(`const dingtalkNotify = require('../utils/dingtalk-notify');`);
if (used('collabVersioning')) requires.push(`const collabVersioning = require('../utils/collab-attachment-versioning');`);
if (used('collabSubmitHelpers')) requires.push(`const collabSubmitHelpers = require('../utils/collab-submit-helpers');`);

// ── 16 注入符号（编码前 4 轮扫描精确确认）
const injected = ['logger', 'db', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken',
  'requireAdmin', 'requirePublisherOrAdmin', 'sendIssueDingtalkRaw', 'UPLOAD_DIR', 'readSystemConfig',
  'COLLAB_CHAT_ADMIN_ID', 'callDingtalkWithTokenRetry', 'normalizeAttachmentExt', 'safeDeleteFileSync', 'maskPhone'];
// codex M-2：requiredDeps 字面量从 injected 自动派生（生成期写入工厂校验，不另立手维护清单，避免漂移）
const requiredDepsLiteral = injected.map(s => `'${s}'`).join(', ');

// ── _internals 导出（供 verify require 真实逻辑，根治 RC-L2）
const internals = ['CORRECTION_STATUSES', 'CORRECTION_STATUS_TRANSITIONS', 'CORRECTION_TYPES', 'CORRECTION_SOURCE_SYSTEMS',
  'CORRECTION_NOTIFY_SENDABLE', 'CORRECTION_READ_FIELD_MAP', 'CORRECTION_ALLOWED_EXTS', 'CORRECTION_CHAT_EXCLUDE_IDS',
  'CORRECTION_CHAT_ALLOWED_STATUSES', 'CORRECTION_REQUESTS_KEY_COLS', 'CORRECTION_ATTACHMENTS_KEY_COLS', 'CORRECTION_HISTORY_KEY_COLS',
  'normalizeCorrectionDatetime', 'correctionDefaultDeadline', 'parsePositiveCorrectionId', 'correctionTransition', 'correctionActor',
  'isCorrectionChatExcludedId', 'requireCorrectionSchemaReady', 'CORRECTION_SCHEMA_STATE'];

const header = [
  '// routes/corrections.js — 数据修正模块（从 server.js 抽离，巨型文件拆分首试点）',
  '// 生成：scripts/build-routes-corrections.js 程序化切割 server.js 三区（行为零变更）',
  '//   区1 readiness(原195-245) / 区2 DDL+migration(1991-2261) / 区3 主体+18端点(18289-19802)',
  '//   16 共享符号经 deps 局部注入；18 端点 app.xxx(\'/api/corrections...\') 改 router.xxx(\'/...\')',
  '//   导出 { initSchema, router, _internals }——_internals 供 verify require 真实逻辑（根治 RC-L2 复刻漂移）',
  '//   ⚠️ 区1/2/3 代码为程序化切割保持 0 缩进，实际位于下方 module.exports factory 作用域内（非文件顶层变量）。',
  "'use strict';",
].join('\n');

const out = `${header}
${requires.join('\n')}

module.exports = (deps) => {
  // codex M-2：工厂期 deps 校验——漏注入即启动期失败（而非深层端点运行期才 xxx is not a function）。
  const REQUIRED_DEPS = [${requiredDepsLiteral}];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/corrections 缺注入依赖: ' + __k);
  }
  const {
    ${injected.join(', ')}
  } = deps;

// ============================================================
// 区1：schema readiness state + 中间件 + 列定义常量 + source 白名单（原 server.js 195-245）
// ============================================================
${region1}

// ============================================================
// 区2：DDL + migration（原 server.js 1991-2261）。建表 serialize 块包进 initSchema()，
//   server.js 启动 initTable() 内调用 correctionModule.initSchema()（时序不变）。
// ============================================================
function initSchema() {
${region2a}
}
${region2b}

// ============================================================
// 区3：常量 + helper + 18 端点（原 server.js 18289-19802）
// ============================================================
const router = express.Router();
${region3}

  return {
    initSchema,
    router,
    _internals: { ${internals.join(', ')} },
  };
};
`;

// codex M-1：端点数不符 / 残留 app.xxx 立即失败，绝不写半正确文件
if (endpointCount !== 18) {
  throw new Error(`端点改写数 ${endpointCount} ≠ 18，疑 server.js 端点变动/漏改，已阻断生成`);
}
if (/\bapp\.(get|post|put|delete)\(\s*['"]\/api\/corrections/.test(out)) {
  throw new Error("生成结果仍含 app.xxx('/api/corrections...')，端点改写不完整，已阻断生成");
}

const routesDir = path.join(__dirname, '..', 'routes');
if (!fs.existsSync(routesDir)) fs.mkdirSync(routesDir, { recursive: true });
fs.writeFileSync(path.join(routesDir, 'corrections.js'), out, 'utf8');

console.log('✅ routes/corrections.js 已生成');
console.log('   端点改写：' + endpointCount + ' 处（预期 18）' + (endpointCount === 18 ? ' ✓' : ' ✗ 不符！'));
console.log('   requires：' + requires.length + ' 个 → ' + requires.map(r => r.match(/require\('([^']+)'\)/)[1]).join(', '));
console.log('   注入：' + injected.length + ' 个 | internals：' + internals.length + ' 个');
console.log('   总行数：' + out.split('\n').length);
