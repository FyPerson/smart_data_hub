/**
 * 钉钉替身（#106 多线并行改造 · S1b · W1「外部调用闸」）
 *
 * 隔离实例（external === 'stub'）里，utils/dingtalk-notify.js 的 fetchWithTimeout 不再调用真实 fetch，而是交给本文件：
 *   - 按请求 URL 的「主机 + 路径」分派到各接口的替身，返回与真实 fetch 同形的 Response 对象（.ok / .status / .json() / .text() 都在）；
 *   - 响应体是调用方（dingtalk-notify.js 的 9 个接口函数与其上层业务）实际消费的原始结构，让解析走「成功」分支：
 *       gettoken            -> { errcode:0, access_token, expires_in }
 *       user/get_by_mobile  -> { errcode:0, userid }
 *       oToMessages/batchSend    -> { errcode:0, invalidStaffIdList:[], flowControlledStaffIdList:[], filteredStaffIdList:[], processQueryKey }
 *       oToMessages/readStatus   -> { errcode:0, sendStatus:'SUCCESS', messageReadInfoList:[] }（getReadStatus 解析出空的已读列表）
 *       chat/create         -> { errcode:0, chatid, openConversationId }
 *       chat/update         -> { errcode:0, errorUserIds:[] }
 *       media/upload        -> { errcode:0, media_id }
 *       groupMessages/send  -> { processQueryKey }（调用方只检查有没有 code 字段）
 *   - 未识别的主机 / 路径与 handler 异常：先记录（outcome = unrecognized / stub_error），再抛 Error（code = EXTERNAL_STUB_UNRECOGNIZED / EXTERNAL_STUB_ERROR，消息含接口键），
 *     不返回任何 HTTP 响应、不放行真实请求。理由：真实 fetch 网络失败就是 reject，所有包装函数与调用方本来就必须处理这条路径；
 *     返回 200 + 非零 errcode 的做法会被只判真值或只判 HTTP 状态的包装函数（如 sendGroupMessage）当成成功；
 *   - 每次调用追加一行到 <数据根>/external-calls.jsonl：{ at, api, method, outcome, params }。
 *     params 是摘要：query 与 body 的键值，appkey / appsecret / access_token / robotCode 等一律 '***'，手机号只留前三后四，
 *     消息正文（msgParam）只记长度，长字符串截断。写日志失败只打一行警告，不影响业务。
 *
 * 虚拟值都带 sdh-stub- 前缀，便于一眼认出「这是替身返回的」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = 'external-calls.jsonl';
const STUB_ACCESS_TOKEN = 'sdh-stub-access-token';

const SENSITIVE_KEY = /^(appkey|appsecret|app_key|app_secret|access_token|x-acs-dingtalk-access-token|token|secret|password|authorization|robotcode|robot_code)$/i;
const PHONE_KEY = /^(mobile|phone)$/i;

function maskPhone(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^1\d{10}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(7)}`;
    return s.length > 4 ? `***${s.slice(-4)}` : '***';
}

function summarizeValue(key, value, depth) {
    if (SENSITIVE_KEY.test(key)) return '***';
    if (PHONE_KEY.test(key)) return maskPhone(value);
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        if (key === 'msgParam') return `<string len ${value.length}>`;
        return value.length > 60 ? `${value.slice(0, 40)}…(len ${value.length})` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') {
        if (depth >= 2) return '{…}';
        const out = {};
        for (const k of Object.keys(value).slice(0, 20)) out[k] = summarizeValue(k, value[k], depth + 1);
        return out;
    }
    return String(typeof value);
}

function summarizeObject(obj) {
    const out = {};
    for (const k of Object.keys(obj || {}).slice(0, 30)) out[k] = summarizeValue(k, obj[k], 0);
    return out;
}

/** 请求体摘要：JSON 字符串 -> 对象摘要；FormData -> 逐项（文件只记名字与大小）；其他 -> 类型说明。 */
function parseBody(body) {
    if (body === undefined || body === null) return { raw: null, json: null, form: null };
    if (typeof body === 'string') {
        let json = null;
        try { const j = JSON.parse(body); if (j && typeof j === 'object') json = j; } catch (_) { /* 非 JSON 正文 */ }
        return { raw: body, json, form: null };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const form = {};
        for (const [k, v] of body.entries()) {
            form[k] = (v && typeof v === 'object' && 'size' in v) ? { file: String(v.name || ''), size: v.size } : String(v);
        }
        return { raw: null, json: null, form };
    }
    return { raw: null, json: null, form: { _type: Object.prototype.toString.call(body) } };
}

function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json;charset=utf-8' } });
}

function createDingtalkStub({ dataRoot, now } = {}) {
    if (!dataRoot || typeof dataRoot !== 'string') throw new Error('createDingtalkStub：缺少 dataRoot');
    const logPath = path.join(dataRoot, LOG_FILE);
    const clock = now || (() => new Date());
    // 会被业务层持久化的虚拟标识（chatid / openConversationId / media_id / processQueryKey）必须跨重启、跨实例唯一：
    //   用随机串而不是进程内计数器（计数器重启归零，会和库里上次运行留下的同名标识撞上）。userid 按手机号哈希，同一手机号稳定是有意的。
    const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    // 主机 + 路径 -> 响应体生成器。主机用小写；路径不含查询串。
    const HANDLERS = {
        'oapi.dingtalk.com/gettoken': () => ({ errcode: 0, errmsg: 'ok', access_token: STUB_ACCESS_TOKEN, expires_in: 7200 }),
        'oapi.dingtalk.com/user/get_by_mobile': (ctx) => ({
            errcode: 0, errmsg: 'ok',
            userid: `sdh-stub-user-${crypto.createHash('sha1').update(String(ctx.query.mobile || '')).digest('hex').slice(0, 8)}`,
        }),
        'api.dingtalk.com/v1.0/robot/oToMessages/batchSend': () => ({
            errcode: 0, flowControlledStaffIdList: [], invalidStaffIdList: [], filteredStaffIdList: [],
            processQueryKey: `sdh-stub-pqk-${rid()}`,
        }),
        'api.dingtalk.com/v1.0/robot/oToMessages/readStatus': () => ({ errcode: 0, sendStatus: 'SUCCESS', messageReadInfoList: [] }),
        'oapi.dingtalk.com/chat/create': () => {
            const id = rid();   // 同一次创建的 chatid 与 openConversationId 共用一个随机串，便于对照
            return { errcode: 0, errmsg: 'ok', chatid: `sdh-stub-chat-${id}`, openConversationId: `sdh-stub-ocid-${id}`, conversationTag: 2 };
        },
        'oapi.dingtalk.com/chat/update': () => ({ errcode: 0, errmsg: 'ok', errorUserIds: [] }),
        'oapi.dingtalk.com/media/upload': () => ({ errcode: 0, errmsg: 'ok', type: 'file', media_id: `sdh-stub-media-${rid()}`, created_at: clock().getTime() }),
        'api.dingtalk.com/v1.0/robot/groupMessages/send': () => ({ processQueryKey: `sdh-stub-gmsg-${rid()}` }),
    };

    let dirReady = false;
    async function appendLog(record) {
        try {
            if (!dirReady) { fs.mkdirSync(path.dirname(logPath), { recursive: true }); dirReady = true; }
            await fs.promises.appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (e) {
            console.warn(`[dingtalk-stub] 写 ${LOG_FILE} 失败（不影响业务）：${e && e.message}`);
        }
    }

    async function stubFetch(url, options) {
        const opts = options || {};
        const method = String(opts.method || 'GET').toUpperCase();
        let u = null;
        try { u = new URL(String(url)); } catch (_) { /* 无法解析的 URL */ }
        const query = {};
        if (u) for (const [k, v] of u.searchParams.entries()) query[k] = v;
        const body = parseBody(opts.body);
        const key = u ? `${u.hostname.toLowerCase()}${u.pathname}` : null;
        const handler = key ? HANDLERS[key] : undefined;

        let responseBody;
        let outcome;
        let failure = null;   // 未识别接口 / handler 异常：先记录再抛错（见文件头注释）
        const keyText = key || `<unparseable url len ${String(url).length}>`;
        if (handler) {
            try {
                responseBody = handler({ query, body: body.json, form: body.form, method });
                outcome = 'stubbed';
            } catch (e) {
                outcome = 'stub_error';
                failure = Object.assign(new Error(`sdh-stub: handler error at ${keyText}: ${e && e.message}`), { code: 'EXTERNAL_STUB_ERROR' });
            }
        } else {
            outcome = 'unrecognized';
            failure = Object.assign(new Error(`sdh-stub: unrecognized external call ${keyText}`), { code: 'EXTERNAL_STUB_UNRECOGNIZED' });
        }

        const params = { query: summarizeObject(query) };
        if (body.json) params.body = summarizeObject(body.json);
        else if (body.form) params.form = summarizeObject(body.form);
        else if (typeof body.raw === 'string') params.body = `<non-json string len ${body.raw.length}>`;
        // 不可解析的网址不落任何原文（可能夹带密钥），只记长度
        await appendLog({ at: clock().toISOString(), api: u ? u.pathname : `<unparseable url len ${String(url).length}>`, host: u ? u.hostname : null, method, outcome, params });
        if (failure) throw failure;
        return jsonResponse(responseBody, 200);
    }
    stubFetch.logPath = logPath;
    stubFetch.supportedApis = Object.keys(HANDLERS);
    return stubFetch;
}

module.exports = { LOG_FILE, STUB_ACCESS_TOKEN, createDingtalkStub, maskPhone, summarizeObject };
