/**
 * 汇总就绪接口的纯函数（#106 S3a · W3「汇总就绪接口」，W10 复用）
 *
 * 为什么单独成文件：各模块的就绪状态对象同形 { ready, error }（error 多数是给人看的中文长句，含表名 / 计数 / 异常原文），
 * 对外只能给「稳定的错误码」，不能把原文带出去。把「状态对象 → { ready, code }」的折算与整体结论放在一处，
 * server.js 的 /api/health/ready 与各 routes 模块的 getReadiness() 共用，verify-test-instance 直接 require 这份真实逻辑做判红断言。
 *
 * 规则（派单 S3a 1a）：
 *   - ready = 状态 ready === true 且没有 error（与各模块的 503 中间件同口径：先判 error，再判 ready）；
 *   - code：就绪 → null；有 error → 取 error 对象上符合 CODE_RE 的 code，否则 INIT_FAILED（error 是字符串时恒为 INIT_FAILED，原文不出）；
 *     无 error 且未就绪 → NOT_READY；
 *   - 整体 ok = 全部模块 ready（模块集合为空不算就绪）。
 * 只读，不触发任何初始化，不碰库。
 */
'use strict';

/** 允许对外的错误码形态：大写字母开头，大写字母 / 数字 / 下划线，最长 64 */
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CODE_INIT_FAILED = 'INIT_FAILED';
const CODE_NOT_READY = 'NOT_READY';

const hasError = (e) => e !== null && e !== undefined && e !== false && e !== '';

/** 错误值 → 对外错误码：只认对象上形态合法的 code，其余（含字符串原文）一律 INIT_FAILED */
function codeOfError(err) {
    if (err && typeof err === 'object' && typeof err.code === 'string' && CODE_RE.test(err.code)) return err.code;
    return CODE_INIT_FAILED;
}

/** 状态对象 { ready, error } → { ready, code } */
function summarizeState(state) {
    if (!state || typeof state !== 'object') return { ready: false, code: CODE_NOT_READY };
    if (hasError(state.error)) return { ready: false, code: codeOfError(state.error) };
    if (state.ready === true) return { ready: true, code: null };
    return { ready: false, code: CODE_NOT_READY };
}

/** 规整一个模块条目：{ ready: boolean, code: string|null }；形态不合法的 code 一律换成 INIT_FAILED，ready 为 true 时 code 恒为 null */
function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return { ready: false, code: CODE_INIT_FAILED };
    if (entry.ready === true) return { ready: true, code: null };
    const code = typeof entry.code === 'string' && CODE_RE.test(entry.code) ? entry.code : CODE_INIT_FAILED;   // 形态不合法（含缺失）一律 INIT_FAILED：与派单一致，原文 / 小写 / 超长串都不外露
    return { ready: false, code };
}

/**
 * 汇总。sources = { <模块名>: () => { ready, code } }（只读访问函数）。
 * 访问函数抛异常 → 该模块记为未就绪 INIT_FAILED（异常原文不出）。
 * 返回 { status, body }：全部就绪 200，否则 503，body 同形。
 */
function buildReport({ instance, mode, sources }) {
    const modules = {};
    for (const name of Object.keys(sources || {})) {
        let entry;
        try { entry = normalizeEntry(sources[name]()); } catch (_) { entry = { ready: false, code: CODE_INIT_FAILED }; }
        modules[name] = entry;
    }
    const names = Object.keys(modules);
    const ok = names.length > 0 && names.every((n) => modules[n].ready === true);
    return { status: ok ? 200 : 503, body: { ok, instance: instance === undefined ? null : instance, mode, modules } };
}

module.exports = { CODE_RE, CODE_INIT_FAILED, CODE_NOT_READY, codeOfError, summarizeState, normalizeEntry, buildReport };
