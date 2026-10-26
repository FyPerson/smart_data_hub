/**
 * 外部调用闸（#106 多线并行改造 · S1b · W1「外部调用闸」）
 *
 * 隔离实例（运行模式 isolated，external === 'stub'）不得对外发出任何真实请求：
 *   - 钉钉：utils/dingtalk-notify.js 的 fetchWithTimeout 先问 dingtalkFetchOverride()；非 null 就用它代替真实 fetch（替身见 dingtalk-stub.js）。
 *   - 外部库：server.js 的 4 个创建点（getMssqlPool / getMysqlPool / test-new 的两个内联连接）在建连前调 assertExternalDbAllowed()，
 *     隔离模式抛 code = 'EXTERNAL_DISABLED'。
 * 判定一律「只有明确判定为正常模式（external === 'real'）才放行」：运行模式判定被拒绝（refuse）、字段缺失、值不认识，都按禁用处理（fail-closed）。
 * 正常模式：dingtalkFetchOverride() 返回 null、assertExternalDbAllowed() 无副作用地返回，调用方走原路径。
 */
'use strict';

const instanceMode = require('./instance-mode');
const { createDingtalkStub } = require('./dingtalk-stub');

let configProvider = null;   // 仅验证脚本注入；生产恒为 null（取进程级单例）
function currentConfig() {
    return configProvider ? configProvider() : instanceMode.getInstanceConfig();
}
/** 仅供验证脚本注入运行模式配置（生产代码不得调用）。传 null 还原。 */
function _setConfigProviderForTest(fn) {
    configProvider = typeof fn === 'function' ? fn : null;
    stubs.clear();
}

function externalDisabledError(what) {
    const e = new Error(`EXTERNAL_DISABLED: 隔离实例不允许${what}`);
    e.code = 'EXTERNAL_DISABLED';
    return e;
}

/** 只有「已成功判定且 external === 'real'」才算真实外发放行。 */
function isExternalReal(cfg) {
    return !!cfg && cfg.refuse !== true && cfg.external === 'real';
}

/** 外部库创建点调用：正常模式直接返回；隔离模式（及判定异常）抛 EXTERNAL_DISABLED。 */
function assertExternalDbAllowed(kind, cfg) {
    const c = cfg === undefined ? currentConfig() : cfg;
    if (isExternalReal(c)) return;
    throw externalDisabledError(`连接外部数据库（${kind}）`);
}

const stubs = new Map();   // dataRoot -> stubFetch（同一数据根共用一个替身实例；虚拟标识是随机值，不是序号）
async function blockedFetch() {
    throw externalDisabledError('调用钉钉（运行模式判定未通过，按禁用处理）');
}

/**
 * fetchWithTimeout 调用：返回 null 表示走真实 fetch（正常模式）；返回函数表示用它代替 fetch（隔离模式的替身，或判定异常时的拒绝器）。
 */
function dingtalkFetchOverride(cfg) {
    const c = cfg === undefined ? currentConfig() : cfg;
    if (isExternalReal(c)) return null;
    if (!c || c.refuse === true || c.external !== 'stub' || typeof c.dataRoot !== 'string' || c.dataRoot === '') return blockedFetch;
    let s = stubs.get(c.dataRoot);
    if (!s) { s = createDingtalkStub({ dataRoot: c.dataRoot }); stubs.set(c.dataRoot, s); }
    return s;
}

module.exports = { externalDisabledError, isExternalReal, assertExternalDbAllowed, dingtalkFetchOverride, _setConfigProviderForTest };
