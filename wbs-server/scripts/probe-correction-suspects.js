// probe-correction-suspects.js
// 核实存疑符号：上一轮扫描里 count 低 / 跨模块的符号，逐个打印在 correction 三区内的引用行，
//   判断是"真代码引用（要注入）"还是"注释提及（误报，不注入）"。
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

const suspects = [
  'requireIssueV1750SchemaReady', 'safeDeleteFileSync', 'storage', 'initTable',
  'ISSUE_READ_FIELD_MAP', 'maskPhone', 'issueUpload', 'BUILTIN_ADMIN_USER_ID',
  'addRealChatMember', 'upload', 'COLLAB_CHAT_ADMIN_ID', 'READONLY_LEADER_IDS',
  'sql', 'safeDeleteFileSync',
];

for (const sym of suspects) {
  const re = new RegExp('\\b' + sym.replace(/\$/g, '\\$') + '\\b');
  const refs = [];
  for (const rg of regions) {
    for (let i = rg.start - 1; i < rg.end; i++) {
      if (re.test(lines[i])) {
        const t = lines[i].trim();
        const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--');
        refs.push({ ln: i + 1, isComment, text: t.slice(0, 110) });
      }
    }
  }
  const codeRefs = refs.filter(r => !r.isComment);
  console.log('\n### ' + sym + '  —  代码引用 ' + codeRefs.length + ' / 总 ' + refs.length);
  for (const r of refs) {
    console.log('  L' + r.ln + (r.isComment ? ' [注释] ' : ' [代码] ') + r.text);
  }
}
