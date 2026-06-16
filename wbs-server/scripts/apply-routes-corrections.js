// apply-routes-corrections.js — J2：server.js 切换接入 routes/corrections（删 3 区 + 插接入代码）
//   删除：区1(190-245 含前导注释) / 区2a(1991-2161 建表 serialize) / 区2b(2164-2261 migration)
//   保留：L2162-2163（initTable 闭合 } + 空行）
//   替换：区3(18289-19802 主体+18端点) → 接入代码（实例化 + initSchema + app.use）
//   边界哨兵先验证行号没漂；git 已 commit 干净，出错可 git checkout server.js 恢复。
'use strict';
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const lines = fs.readFileSync(serverPath, 'utf8').split('\n');  // line N (1-based) = lines[N-1]

// ── 边界哨兵：行号漂移立即失败，绝不写错文件
const sentinel = (lineNo, re, label) => {
  if (!re.test(lines[lineNo - 1] || '')) {
    throw new Error(`哨兵失败 @L${lineNo}（${label}）：实际="${(lines[lineNo - 1] || '').trim().slice(0, 75)}"`);
  }
};
sentinel(189, /^\s*$/, 'L189 区1 前空行');
sentinel(190, /数据修正模块 schema readiness/, '区1 前导注释起点');
sentinel(245, /^\];\s*$/, '区1 尾 CORRECTION_SOURCE_SYSTEMS 闭合 ];');
sentinel(246, /^\s*$/, 'L246 区1 后空行');
sentinel(1991, /数据修正模块 v1\.81\.0（Commit A schema）/, '区2a 起始注释');
sentinel(2161, /^\s*\}\);\s*$/, '区2a serialize 闭合 });');
sentinel(2162, /^\}\s*$/, 'L2162 initTable 闭合 }（保留）');
sentinel(2164, /数据修正模块 schema 迁移/, '区2b migration 注释起点');
sentinel(2261, /^\}\s*$/, '区2b runCorrectionMigration 闭合 }');
sentinel(2262, /^\s*$/, 'L2262 区2b 后空行');
sentinel(18289, /^\/\/ ={20,}\s*$/, '区3 起始等号线');
sentinel(18290, /数据修正模块 API/, '区3 标题');
sentinel(19802, /^\s*\}\);\s*$/, '区3 create-chat 闭合 });');

// ── 接入代码（替换区3）：实例化 + initSchema + app.use 一处（codex H-1 单实例化）
const inject = [
  '// ============================================================',
  '// 数据修正模块 API —— 已抽离至 routes/corrections.js（巨型文件拆分首试点，J2 切换）',
  '//   schema readiness + DDL/migration + 18 端点 + helper 全在模块内（16 deps 局部注入）。',
  '//   实例化点选此（原区3 位置）：16 注入依赖此处均已定义（最晚 COLLAB_CHAT_ADMIN_ID）。',
  '//   initSchema() 建 correction 三表（原 initTable 内 serialize 块迁出，模块自管 schema）；',
  '//   readiness 闸门保证建好前 correction 端点 503（首启短暂窗口，与原行为一致）。',
  '// ============================================================',
  "const correctionModule = require('./routes/corrections')({",
  '  logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken,',
  '  requireAdmin, requirePublisherOrAdmin, sendIssueDingtalkRaw, UPLOAD_DIR,',
  '  readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry,',
  '  normalizeAttachmentExt, safeDeleteFileSync, maskPhone,',
  '});',
  '// initSchema() 调用见 db 连接回调（M-1 codex 末次审：保持原建表时序，busy_timeout+initTable 之后）；此处仅实例化+挂载。',
  "app.use('/api/corrections', correctionModule.router);",
].join('\n');

// ── 切片拼接新 server.js（slice 为 0-based，end 不含）
const out = [
  lines.slice(0, 189).join('\n'),       // 行 1-189（区1 前，含 189 空行）
  // 删 行 190-245（区1）
  lines.slice(245, 1990).join('\n'),    // 行 246-1990（区1 后 → 区2 前）
  // 删 行 1991-2161（区2a）
  lines.slice(2161, 2163).join('\n'),   // 行 2162-2163（initTable 闭合 } + 空行，保留）
  // 删 行 2164-2261（区2b）
  lines.slice(2261, 18288).join('\n'),  // 行 2262-18288（区2 后 → 区3 前）
  inject,                               // 替换 行 18289-19802（区3）
  lines.slice(19802).join('\n'),        // 行 19803-end（区3 后）
].join('\n');

fs.writeFileSync(serverPath, out, 'utf8');
const newLen = out.split('\n').length;
console.log('✅ server.js 切换完成');
console.log('   原 ' + lines.length + ' 行 → 新 ' + newLen + ' 行（精确净减 ' + (lines.length - newLen) + '）');
console.log('   删除区间：区1(190-245) + 区2a(1991-2161) + 区2b(2164-2261) + 区3(18289-19802)；保留 L2162-2163；接入替换区3');
