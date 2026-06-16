// probe-correction-symbols.js
// 编码前真相重验（correction 抽 routes/ 方案 v0.1）：
//   精确分类 correction 三区引用的每个符号——靠"定义位置"判定：
//     · 定义在区内 → 私有 helper/常量（随端点搬走，不注入）
//     · 定义在区外 + require(...) → routes 自己 require（path/fs/mssql/multer）
//     · 定义在区外 + 非 require → ★ 真注入（deps）
//     · app → 改写为 router（不注入）
//   暴露：方案私有清单漏列的 helper + 方案注入清单漏列的依赖。
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = src.split('\n');

const regions = [
  { name: '区1', start: 195, end: 245 },
  { name: '区2', start: 1991, end: 2261 },   // codex H-2：与 build 搬运边界统一（含 runCorrectionMigration 完整体到 2261）
  { name: '区3', start: 18289, end: 19802 },
];
const correctionText = regions.map(r => lines.slice(r.start - 1, r.end).join('\n')).join('\n');

// 顶层定义：符号 → { line, isRequire }
const defMap = new Map();
const defRe = /^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/;
lines.forEach((ln, i) => {
  const m = ln.match(defRe);
  if (m && !defMap.has(m[1])) defMap.set(m[1], { line: i + 1, isRequire: /=\s*require\(/.test(ln) });
});

const regionOf = (lineNo) => {
  for (const r of regions) if (lineNo >= r.start && lineNo <= r.end) return r.name;
  return null;
};

// 方案 v0.1 私有清单（31）——用于检测漏列
const planPrivate = new Set([
  'CORRECTION_SCHEMA_STATE','CORRECTION_REQUIRED_TABLES','CORRECTION_REQUESTS_KEY_COLS',
  'CORRECTION_ATTACHMENTS_KEY_COLS','CORRECTION_HISTORY_KEY_COLS','CORRECTION_ATTACHMENTS_NOTNULL_COLS',
  'CORRECTION_HISTORY_NOTNULL_COLS','requireCorrectionSchemaReady','CORRECTION_SOURCE_SYSTEMS',
  'CORRECTION_STATUSES','CORRECTION_STATUS_TRANSITIONS','CORRECTION_TYPES','CORRECTION_UPLOAD_BASE',
  'CORRECTION_PENDING_BASE','CORRECTION_ALLOWED_EXTS','CORRECTION_NOTIFY_SENDABLE','CORRECTION_READ_FIELD_MAP',
  'CORRECTION_CHAT_EXCLUDE_IDS','CORRECTION_CHAT_ALLOWED_STATUSES',
  'normalizeCorrectionDatetime','correctionDefaultDeadline','parsePositiveCorrectionId','correctionTransition',
  'correctionStorage','correctionUpload','correctionIdGuard','correctionUploadMw','correctionPersistAttachments',
  'correctionRollbackPersisted','correctionCleanupPending','correctionActor',
]);
const planInject = new Set(['logger','dingtalkNotify','dbRunAsync','dbGetAsync','dbAllAsync','authenticateToken',
  'requireAdmin','requirePublisherOrAdmin','sendIssueDingtalkRaw','escapeMarkdown','UPLOAD_DIR','readSystemConfig',
  'normalizeAttachmentExt','callDingtalkWithTokenRetry','collabVersioning','db']);

const rows = [];
for (const [sym, def] of defMap) {
  const re = new RegExp('\\b' + sym.replace(/\$/g, '\\$') + '\\b', 'g');
  const count = (correctionText.match(re) || []).length;
  if (count === 0) continue;
  const reg = regionOf(def.line);
  let cls;
  if (sym === 'app') cls = '改写→router';
  else if (reg) cls = '私有@' + reg;
  else if (def.isRequire) cls = 'self-require';
  else cls = '★注入';
  rows.push({ sym, count, defLine: def.line, cls });
}
rows.sort((a, b) => b.count - a.count);

console.log('符号'.padEnd(36) + '次数  定义行   分类');
console.log('─'.repeat(64));
for (const r of rows) {
  console.log(r.sym.padEnd(36) + String(r.count).padStart(4) + String(r.defLine).padStart(8) + '   ' + r.cls);
}

const inject = rows.filter(r => r.cls === '★注入').map(r => r.sym);
const selfReq = rows.filter(r => r.cls === 'self-require').map(r => r.sym);
const priv = rows.filter(r => r.cls.startsWith('私有'));

console.log('\n=== ★ 注入清单（deps，共 ' + inject.length + '）===');
console.log(inject.join(', '));
console.log('\n=== self-require（routes 自己 require，共 ' + selfReq.length + '）===');
console.log(selfReq.join(', '));

console.log('\n=== 私有 helper 漏列检查（定义在区内但方案私有清单没列）===');
const privMissing = priv.filter(r => !planPrivate.has(r.sym)).map(r => r.sym + '@' + r.defLine);
console.log(privMissing.length ? privMissing.join(', ') : '无');

console.log('\n=== 注入清单漏列检查（实际注入但方案 16 deps 没列）===');
const injMissing = inject.filter(s => !planInject.has(s));
console.log(injMissing.length ? injMissing.join(', ') : '无');
