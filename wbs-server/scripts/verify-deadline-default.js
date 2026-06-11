/**
 * verify-deadline-default.js（v1.78.0）
 *
 * 验证「数据协作单创建时 deadline 智能默认」逻辑：
 *   - 创建时刻 < 15:00  → 当天 17:00
 *   - 创建时刻 >= 15:00 → 次日 12:00（15:00 整点归次日；不顺延周末）
 *
 * 此函数复刻 public/Data_Collab.html 的前端默认值逻辑（resetCreateForm 内）。
 * 前端为 datetime-local 控件，用本地时间拼接字符串，不能用 toISOString()（会转 UTC 偏 8 小时）。
 *
 * 跑法：node scripts/verify-deadline-default.js
 */

'use strict';

// —— 被测逻辑：与前端保持一字不差的同源复刻 ——
function computeDeadlineDefault(now) {
    const d = new Date(now);
    if (d.getHours() < 15) {
        d.setHours(17, 0, 0, 0);            // 当天 17:00
    } else {
        d.setDate(d.getDate() + 1);
        d.setHours(12, 0, 0, 0);            // 次日 12:00
    }
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 月份从 0 开始：5 = 六月
const cases = [
    ['09:30 上午',                  new Date(2026, 5, 11,  9, 30), '2026-06-11T17:00'],
    ['14:59 临界前(仍当天17:00)',   new Date(2026, 5, 11, 14, 59), '2026-06-11T17:00'],
    ['15:00 整点(归次日12:00)',     new Date(2026, 5, 11, 15,  0), '2026-06-12T12:00'],
    ['15:01 临界后',                new Date(2026, 5, 11, 15,  1), '2026-06-12T12:00'],
    ['23:30 深夜',                  new Date(2026, 5, 11, 23, 30), '2026-06-12T12:00'],
    ['月末 6/30 16:00 跨月',        new Date(2026, 5, 30, 16,  0), '2026-07-01T12:00'],
    ['周五 6/12 16:00 不顺延周末',  new Date(2026, 5, 12, 16,  0), '2026-06-13T12:00'],
    ['00:00 凌晨(当天17:00)',       new Date(2026, 5, 11,  0,  0), '2026-06-11T17:00'],
];

let pass = 0, fail = 0;
for (const [label, now, expected] of cases) {
    const got = computeDeadlineDefault(now);
    const ok = got === expected;
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(30), '=> ' + got,
        ok ? '' : ('  期望 ' + expected));
}
console.log('---');
console.log('结果:', pass + '/' + (pass + fail), fail === 0 ? '全绿' : '有失败');
if (fail > 0) process.exit(1);
