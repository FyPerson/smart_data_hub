/**
 * verify-notify-admin-switch.js（v1.78.1）
 *
 * 验证「开发/导出人提交后是否通知 admin」总开关的判定逻辑。
 * 复刻 server.js isNotifyAdminOnSubmitEnabled() 的核心判定：
 *   只有 system_configs.collab_notify_admin_on_submit 显式为 'on'（忽略大小写/前后空白）才通知；
 *   配置缺失（null）/ 任何其它值 一律视为"关"（默认不通知）。
 *
 * 这是开关行为的核心契约。集成层（真 server + 真钉钉 + 提交链路）按项目惯例
 * （钉钉真连不进 e2e）走浏览器/生产实测，不在此脚本覆盖。
 *
 * 跑法：node scripts/verify-notify-admin-switch.js
 */

'use strict';

// —— 被测逻辑：与 server.js isNotifyAdminOnSubmitEnabled 的判定一字不差复刻 ——
// （readSystemConfig 返回的 decrypt 后字符串 → 是否启用）
//
// ⚠️ codex 审 low-2：这是「契约样例」验证，非直接调用生产函数 isNotifyAdminOnSubmitEnabled。
// 它锁定的是开关判定规则的契约（只认 'on' + trim + 忽略大小写 + 缺失默认关），不验证真实 IO
// （readSystemConfig 的 db 读取 / 解密 / 异步调用）。**修改 server.js 里 helper 的判定规则时，
// 必须同步本脚本的 decideEnabled，否则本脚本可能全绿却已不反映真实实现。**
function decideEnabled(configValue) {
    return String(configValue || '').trim().toLowerCase() === 'on';
}

const cases = [
    // [configValue, 期望启用?, 说明]
    [null,        false, '配置缺失（null）→ 默认关'],
    [undefined,   false, '配置 undefined → 默认关'],
    ['',          false, '空字符串 → 关'],
    ['   ',       false, '纯空白 → 关'],
    ['on',        true,  "显式 'on' → 开"],
    ['ON',        true,  "'ON' 大写 → 开（忽略大小写）"],
    [' on ',      true,  "' on ' 带空白 → 开（trim）"],
    ['On',        true,  "'On' 混合大小写 → 开"],
    ['off',       false, "'off' → 关"],
    ['true',      false, "'true' 不是 'on' → 关（只认 on）"],
    ['1',         false, "'1' 不是 'on' → 关"],
    ['yes',       false, "'yes' 不是 'on' → 关"],
    ['enabled',   false, "'enabled' 不是 'on' → 关"],
];

let pass = 0, fail = 0;
for (const [val, expected, label] of cases) {
    const got = decideEnabled(val);
    const ok = got === expected;
    if (ok) pass++; else fail++;
    const shown = val === null ? 'null' : val === undefined ? 'undefined' : `'${val}'`;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), shown.padEnd(12), '=> ' + (got ? '通知' : '不通知'),
        '  ' + label, ok ? '' : `（期望 ${expected ? '通知' : '不通知'}）`);
}
console.log('---');
console.log('结果:', pass + '/' + (pass + fail), fail === 0 ? '全绿' : '有失败');
console.log('默认行为：配置缺失即"关"——部署后无需写任何配置，admin 提交通知立即静默。');
if (fail > 0) process.exit(1);
