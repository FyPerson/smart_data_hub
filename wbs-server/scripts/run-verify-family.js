#!/usr/bin/env node
// 全家 verify sweep 驱动脚本——把「cd wbs-server && for 循环逐套件跑」固化为单条 node 命令。
// 动机（2026-08-14）：复合 shell 命令（cd&&for）无法被权限层静态分析，无人值守段每次亲跑都会
//   触发人工确认弹窗；本脚本让主会话/agent 恒以 `node wbs-server/scripts/run-verify-family.js`
//   单命令跑全量（静态可分析·可白名单），同时保持退出码校验制（任一套件红 ⇒ 本脚本 exit 1，
//   杜绝管道 |tail 吞退出码类事故——见 13354ac 沉淀）。
// 行为契约：
//   - 扫描面 = scripts/verify-sys-*.js 全部 + 静态守卫（见文件内 GUARDS 数组——数量与具体名单
//     以该数组为准，不在本注释里重复罗列/计数，避免像 R5〔12a-L1〕之前那样"三静态守卫"这句话
//     随数组扩容悄悄过期失真）；新增 verify-sys-* 套件零配置自动纳入。
//   - 成功套件静默只计数；失败套件立即打印其完整输出（stdout+stderr）便于定位。
//   - 工作目录由脚本自身位置推导（chdir 到 wbs-server 根），与调用方 cwd 无关。
//   - 汇总行格式固定：`FAMILY PASS=<n> FAIL=<n>` + 每守卫一行 `GUARD <name> OK|RED`，供上层 grep。
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');
process.chdir(serverRoot);

function runOne(rel) {
  const r = spawnSync(process.execPath, [rel], { cwd: serverRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

const familyFiles = fs.readdirSync(path.join(serverRoot, 'scripts'))
  .filter((f) => /^verify-sys-.*\.js$/.test(f))
  .sort()
  .map((f) => path.join('scripts', f));

let pass = 0;
const failed = [];
for (const f of familyFiles) {
  const r = runOne(f);
  if (r.ok) { pass++; continue; }
  failed.push(f);
  console.log(`\n===== RED ${f} (exit=${r.status}) =====`);
  console.log(r.out);
}
console.log(`FAMILY PASS=${pass} FAIL=${failed.length}${failed.length ? ' FAILED: ' + failed.join(' ') : ''}`);

const GUARDS = ['verify-unify-static', 'verify-badge-alias', 'verify-shared-css-cache-bust', 'verify-collab-validation-status-coverage', 'verify-db-connections-writers'];
let guardRed = 0;
for (const g of GUARDS) {
  const r = runOne(path.join('scripts', `${g}.js`));
  if (r.ok) { console.log(`GUARD ${g} OK`); continue; }
  guardRed++;
  console.log(`GUARD ${g} RED (exit=${r.status})`);
  console.log(r.out);
}

process.exit(failed.length === 0 && guardRed === 0 ? 0 : 1);
