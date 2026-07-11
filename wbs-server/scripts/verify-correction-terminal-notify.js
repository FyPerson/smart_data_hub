/**
 * verify-correction-terminal-notify.js
 *
 * 数据修正模块「终态通知记录展示」不变量固化（通知归档态统一 C2·2026-07-12）
 *
 * 用法：node scripts/verify-correction-terminal-notify.js（自包含，无需 server）
 *
 * 背景：C1 改的是数据协作（Data_Collab.html）。数据修正模块（Data_Correction.html）经直读复核
 *   本就合规——buildNotifyRow 的发送/重发按钮靠 canSendNow=sendable.includes(curStatus) 在终态
 *   （ARCHIVED/REJECTED/VOIDED 不在任何 sendable 集）自动隐藏，查已读仅须 canSend（任何态可查·只读动作保留），
 *   通知行本身无条件渲染（终态显"已通知/未通知"记录）。故本模块零代码改动。
 *
 * 本哨兵 = 漂移哨兵：grep Data_Correction.html 断言上述"终态通知不变量"的关键逻辑仍在，
 *   防未来有人把 canSendNow 门去掉/把 readBtn 也 gate 上 canSendNow/把终态塞进某 sendable 集
 *   → 导致终态又冒出发送按钮 或 查已读消失。与 verify-collab-terminal-notify.js（协作侧）+
 *   verify-issue-terminal-notify.js（需求侧）三模块同源，共同锁"终态=只读记录+隐藏写动作"规则。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'Data_Correction.html');
const src = fs.readFileSync(FILE, 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}`); }
}
function has(re) { return re.test(src); }

console.log('— 数据修正·buildNotifyRow 终态通知不变量 —');

check('buildNotifyRow 函数存在', has(/function\s+buildNotifyRow\s*\(\s*t\s*,\s*curStatus\s*\)/));

// 发送/重发按钮：须 canSend（有发送权）+ canSendNow（当前可发态）——终态 curStatus 不在 sendable → 自动隐藏
check('sendBtn 门 = t.canSend && canSendNow（终态自动不可发）',
    has(/const\s+sendBtn\s*=.*t\.canSend\s*&&\s*canSendNow/));
check('canSendNow = t.sendable.includes(curStatus)（终态不在 sendable 集则 false）',
    has(/const\s+canSendNow\s*=\s*t\.sendable\.includes\(curStatus\)/));

// 查已读按钮：仅须 t.canSend（任何态可查·终态只读动作保留），绝不能被 canSendNow 门掉
check('readBtn 门 = t.canSend（不含 canSendNow·终态保留查已读）',
    has(/const\s+readBtn\s*=\s*t\.canSend\s*\?/));
check('readBtn 未被 canSendNow 门掉（终态只读查询不消失）',
    !has(/readBtn\s*=\s*\(?\s*t\.canSend\s*&&\s*canSendNow/));

// 终态三态（ARCHIVED/REJECTED/VOIDED）不得出现在任何 sendable 集里（否则终态会冒出发送按钮）
const sendableLines = src.split('\n').filter(l => /sendable\s*:/.test(l));
check('存在 sendable 声明（notify 类型表）', sendableLines.length >= 3);
const terminalInSendable = sendableLines.some(l => /'(ARCHIVED|REJECTED|VOIDED)'/.test(l));
check('终态 ARCHIVED/REJECTED/VOIDED 不在任何 sendable 集（终态不可发）', !terminalInSendable);

// 通知行无条件渲染（终态仍显记录：已通知/已读/失败/未发送）
check('buildNotifyRow 末尾无条件 return u-notify-row（终态显记录）',
    has(/return\s*`<div class="u-notify-row"><span class="u-nr-label">\$\{esc\(t\.label\)\}<\/span>/));

// 强化（codex 末次审 LOW）：提取 buildNotifyRow 函数体，断言体内【无终态状态字面量】。
//   buildNotifyRow 的终态处理走 canSendNow=false（sendable 集不含终态），不是显式 status 判断——
//   函数体内本不应出现任何终态状态字面量。若有人加 `if(['ARCHIVED'..].includes(curStatus)) return ''`
//   之类的终态早退短路（会让终态通知记录整块消失），必然引入 'ARCHIVED'/'REJECTED'/'VOIDED' 字面量 → 本断言失败。
//   这把"全文件存在性检查"收紧为"函数体控制流不被终态短路"，堵住哨兵假绿。
const bnrStart = src.indexOf('function buildNotifyRow(');
const afterBnr = bnrStart >= 0 ? src.slice(bnrStart + 20) : '';
const nextFnRel = afterBnr.search(/\n {8}(?:async )?function /);   // 下一个 8 空格缩进函数（含 async function notifySend）
const bnrBody = (bnrStart >= 0 && nextFnRel >= 0) ? src.slice(bnrStart, bnrStart + 20 + nextFnRel) : '';
check('提取到 buildNotifyRow 函数体', bnrBody.length > 100 && bnrBody.length < 8000);
check('buildNotifyRow 体内无终态状态字面量（防终态早退短路致记录消失·堵哨兵假绿）',
    bnrBody.length > 0 && !/'ARCHIVED'|'REJECTED'|'VOIDED'/.test(bnrBody));

console.log('');
console.log(`=== verify-correction-terminal-notify: ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
