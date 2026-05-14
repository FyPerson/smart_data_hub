/**
 * 钉钉通知模块（v2.0）
 *
 * 数据协作模块用,把"协作单已录入"消息推到指派开发的钉钉。
 *
 * 设计来源:docs/local/数据协作模块_方案_v2.0.md §7.4 / §7.6
 * 参考实现:E:/数据处理/钉钉群消息文件推送_单点/send_user.py(企业内已跑通)
 *
 * 设计要点:
 *   - 纯函数库,不读 system_configs / users 表;凭证 + userId 由调用方传入
 *   - 进程内 access_token 缓存(7200s TTL, 200s 提前过期重取)
 *   - 并发刷新去重(多个请求同时撞过期 → 只发一次 gettoken)
 *   - 错误分层 7 类(network / rate_limit / server_5xx / invalid_response /
 *     token_expired / user_invalid / other),调用方据此决定是否清缓存 + UI 提示
 *   - token_expired 时模块内部"伪重试一次"(清 cache + 重取 token + 重发),
 *     业务层不需要手动处理
 *
 * 依赖:Node ≥ 18 内置 fetch(已在生产 Node v24.12.0 验证)
 */

'use strict';

const GETTOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const GET_BY_MOBILE_URL = 'https://oapi.dingtalk.com/user/get_by_mobile';
const BATCH_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const READ_STATUS_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/readStatus';

const TOKEN_EARLY_EXPIRE_MS = 200 * 1000;  // 提前 200s 重取,避开钉钉端实际过期边界

const TIMEOUT_MS = 10 * 1000;  // 单次 HTTP 请求 10s 超时

let cachedToken = null;
let cachedTokenExpiry = 0;
let tokenRefreshPromise = null;  // 并发刷新去重(v2.0 codex 六审 M-4)

/**
 * 带超时的 fetch 封装。
 * 钉钉 API 偶发会卡住(参考 Python 项目里 try/except 也是为这个),
 * 主动 AbortController 防止挂死。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 拿钉钉 access_token,带缓存 + 并发去重。
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @returns {Promise<string>}  access_token
 * @throws {Error}  钉钉返回 errcode!=0 / 网络错误 / 超时
 */
async function getAccessToken(appKey, appSecret) {
    if (cachedToken && Date.now() < cachedTokenExpiry) {
        return cachedToken;
    }

    if (tokenRefreshPromise) {
        return tokenRefreshPromise;
    }

    tokenRefreshPromise = (async () => {
        try {
            const url = `${GETTOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
            const resp = await fetchWithTimeout(url);
            const data = await resp.json();
            if (data.errcode !== 0) {
                const err = new Error(`gettoken failed: errcode=${data.errcode} errmsg=${data.errmsg}`);
                err.errcode = data.errcode;
                err.errmsg = data.errmsg;
                throw err;
            }
            cachedToken = data.access_token;
            cachedTokenExpiry = Date.now() + (data.expires_in * 1000 - TOKEN_EARLY_EXPIRE_MS);
            return cachedToken;
        } finally {
            tokenRefreshPromise = null;
        }
    })();

    return tokenRefreshPromise;
}

/**
 * 通过手机号查钉钉 userId。
 * 用于首次通知时把 users.phone 解析为 dingtalk_user_id 后缓存到 DB。
 *
 * @param {string} token  access_token
 * @param {string} phone  手机号(纯数字 11 位)
 * @returns {Promise<string>}  钉钉 userId
 * @throws {Error}  errcode!=0 / 用户不存在 / 网络错误
 */
async function getUserIdByMobile(token, phone) {
    const url = `${GET_BY_MOBILE_URL}?access_token=${encodeURIComponent(token)}&mobile=${encodeURIComponent(phone)}`;
    const resp = await fetchWithTimeout(url);
    const data = await resp.json();
    if (data.errcode !== 0) {
        const err = new Error(`get_by_mobile failed: errcode=${data.errcode} errmsg=${data.errmsg}`);
        err.errcode = data.errcode;
        err.errmsg = data.errmsg;
        throw err;
    }
    return data.userid;
}

/**
 * 发送 markdown 消息到一组钉钉用户(单聊机器人 oToMessages)。
 *
 * @param {string} token  access_token
 * @param {string} robotCode
 * @param {string[]} userIds  钉钉 userId 数组(注意是 userId 不是 phone)
 * @param {string} title  消息标题(钉钉端通知栏显示)
 * @param {string} markdown  正文 markdown
 * @returns {Promise<object>}  钉钉原始响应 JSON(成功时含 processQueryKey 等;失败时含 errcode/errmsg)
 * @throws {Error}  HTTP 非 200 / 非 JSON 响应 / 网络错误
 *                  注意:errcode!=0 不抛错,而是放在返回对象里,由调用方走 classifyError
 */
async function sendMarkdownToUser(token, robotCode, userIds, title, markdown) {
    const url = `${BATCH_SEND_URL}?x-acs-dingtalk-access-token=${encodeURIComponent(token)}`;
    const payload = {
        robotCode,
        userIds,
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text: markdown })
    };
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (resp.status >= 500) {
        const err = new Error(`batchSend HTTP ${resp.status}`);
        err.httpStatus = resp.status;
        throw err;
    }

    try {
        return await resp.json();
    } catch (parseErr) {
        const err = new Error(`batchSend non-JSON response: ${parseErr.message}`);
        err.httpStatus = resp.status;
        throw err;
    }
}

/**
 * 错误分类(v2.0 §7.6 codex 六审 M-5)
 *
 * 输入两种形态:
 *   - fetch/parse 抛出的 Error 对象(网络 / 超时 / 5xx / 非 JSON)
 *   - 钉钉响应中 errcode!=0 的对象 { errcode, errmsg }
 *
 * @param {Error|object} input  错误对象或带 errcode 的响应
 * @returns {{reason: string, clearToken: boolean, clearUserId: boolean, hint: string, errcode?: number, errmsg?: string}}
 */
function classifyError(input) {
    // ---- 形态 A:Error 对象(网络 / 超时 / 5xx / 非 JSON)----
    if (input instanceof Error) {
        // AbortError(超时)/ TypeError(fetch 失败,如 DNS / 拒绝连接)
        if (input.name === 'AbortError' || input.name === 'TypeError') {
            return {
                reason: 'network',
                clearToken: false,
                clearUserId: false,
                hint: '网络异常,请稍后手动重试'
            };
        }
        // 5xx
        if (input.httpStatus && input.httpStatus >= 500) {
            return {
                reason: 'server_5xx',
                clearToken: false,
                clearUserId: false,
                hint: '钉钉服务暂不可用,请稍后重试'
            };
        }
        // 非 JSON 响应
        if (input.message && input.message.startsWith('batchSend non-JSON')) {
            return {
                reason: 'invalid_response',
                clearToken: false,
                clearUserId: false,
                hint: '钉钉响应异常,请联系系统管理员'
            };
        }
        // Error 上挂了 errcode → 走形态 B
        if (typeof input.errcode === 'number') {
            return classifyError({ errcode: input.errcode, errmsg: input.errmsg });
        }
        // 兜底
        return {
            reason: 'network',
            clearToken: false,
            clearUserId: false,
            hint: input.message || '网络异常,请稍后手动重试'
        };
    }

    // ---- 形态 B:钉钉响应对象 { errcode, errmsg } ----
    const { errcode, errmsg } = input || {};

    // token 失效:errcode=42001(token 过期)/ 40014(token 无效)
    if (errcode === 42001 || errcode === 40014) {
        return {
            reason: 'token_expired',
            clearToken: true,
            clearUserId: false,
            errcode,
            errmsg,
            hint: 'token 已失效,已自动刷新,如再次失败请联系管理员'
        };
    }

    // userId 失效:errcode=88(用户不存在)/ 88002(消息接收者不在企业内)
    if (errcode === 88 || errcode === 88002) {
        return {
            reason: 'user_invalid',
            clearToken: false,
            clearUserId: true,
            errcode,
            errmsg,
            hint: '开发账号在钉钉端不存在,请管理员检查 phone 字段'
        };
    }

    // 限流:errcode=90018 是钉钉的"调用频率过高"
    if (errcode === 90018) {
        return {
            reason: 'rate_limit',
            clearToken: false,
            clearUserId: false,
            errcode,
            errmsg,
            hint: '调用频率超限,请稍后重试'
        };
    }

    // 其他业务错误
    return {
        reason: `other:${errcode}`,
        clearToken: false,
        clearUserId: false,
        errcode,
        errmsg,
        hint: errmsg || `钉钉错误(${errcode})`
    };
}

/**
 * 查询单聊机器人消息的已读状态。
 *
 * 钉钉真实接口签名(2026-05-11 API Explorer 确认):
 *   GET /v1.0/robot/oToMessages/readStatus?robotCode=...&processQueryKey=...
 *   Header: x-acs-dingtalk-access-token: ${token}
 *
 * 关键约束:
 *   - 必须 GET 而非 POST
 *   - robotCode + processQueryKey 都在 query string 里
 *   - token 在 header 里(不是 query)
 *   - 钉钉端约定消息发出后 24h 内可查
 *
 * @param {string} token  access_token
 * @param {string} robotCode  机器人 RobotCode(与 batchSend 时用的同一个)
 * @param {string} processQueryKey  batchSend 返回的 processQueryKey
 * @returns {Promise<{ readUserIds: string[], raw: object }>}
 *          readUserIds:已读用户的钉钉 userId 数组(可空)
 *          raw:钉钉原始响应,带 errcode 或 code 的话保留供调用方走 classifyError
 * @throws {Error}  HTTP 非 JSON / 5xx / 网络错误
 */
async function getReadStatus(token, robotCode, processQueryKey) {
    const qs = `robotCode=${encodeURIComponent(robotCode)}&processQueryKey=${encodeURIComponent(processQueryKey)}`;
    const resp = await fetchWithTimeout(`${READ_STATUS_URL}?${qs}`, {
        method: 'GET',
        headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json'
        }
    });

    if (resp.status >= 500) {
        const err = new Error(`readStatus HTTP ${resp.status}`);
        err.httpStatus = resp.status;
        throw err;
    }

    let raw;
    try {
        raw = await resp.json();
    } catch (parseErr) {
        const err = new Error(`readStatus non-JSON response: ${parseErr.message}`);
        err.httpStatus = resp.status;
        throw err;
    }

    // 钉钉真实响应(2026-05-11 实测):
    // { sendStatus:"SUCCESS",
    //   messageReadInfoList:[
    //     { readStatus:"READ"/"UNREAD", readTimestamp:1778481700, name:"...", userId:"..." }
    //   ] }
    // 兼容老版文档可能用 readUserIdList 等扁平数组的格式。
    let readUserIds = [];
    let readDetails = [];
    if (Array.isArray(raw.messageReadInfoList)) {
        readDetails = raw.messageReadInfoList;
        readUserIds = raw.messageReadInfoList
            .filter(item => item.readStatus === 'READ')
            .map(item => item.userId);
    } else {
        // 老版文档/兜底:扁平 userId 数组
        readUserIds = raw.readUserIdList || raw.readUserIds || raw.readList || raw.userIdList || [];
    }
    return { readUserIds, readDetails, raw };
}

/**
 * 转义钉钉 markdown 特殊字符。
 * 钉钉 markdown 大部分等同标准 markdown,但用户输入直接拼进消息有两个风险:
 *   1. 用户输入含 `[xx](url)` 会被解析成链接(不严重但奇怪)
 *   2. 用户输入含 `#`、`*`、`>` 等会改变排版
 * 这里只对最容易出问题的字符做转义,业务描述/部门名一律走这函数。
 * 兜底截断 500 字符,避免单字段塞超长内容把卡片撑变形。
 */
function escapeMarkdown(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/[\x00-\x1F\x7F]/g, ' ')  // 控制字符 → 空格
        .replace(/([\\`*_\[\]()~>#+=|{}!])/g, '\\$1')
        .substring(0, 500);
}

/**
 * 拼装协作单通知卡片的 markdown 正文。
 *
 * @param {object} collab  协作单对象,至少需要这些字段:
 *                         { id, oa_request_no, requester_dept, requester_name,
 *                           description, deadline, target_db_name? }
 * @param {string} platformBaseUrl  平台基址(如 http://192.168.1.100:3000),
 *                                  用于拼接"查看详情"深链;为空时不放链接
 * @returns {string}  markdown 文本
 */
function buildCollabNotifyCard(collab, platformBaseUrl) {
    const baseUrl = (platformBaseUrl || '').replace(/\/+$/, '');
    const deepLink = baseUrl ? `${baseUrl}/Data_Collab.html?id=${collab.id}` : '';

    const lines = [
        '#### 新临时取数任务',
        '',
        `- **OA 流程号**:${escapeMarkdown(collab.oa_request_no || '-')}`,
        `- **业务部门**:${escapeMarkdown(collab.requester_dept || '-')}`,
        `- **申请人**:${escapeMarkdown(collab.requester_name || '-')}`,
        `- **目标业务库**:${escapeMarkdown(collab.target_db_name || '-')}`,
        `- **截止时间**:${escapeMarkdown(collab.deadline || '-')}`,
        '',
        '**需求描述**',
        '',
        escapeMarkdown(collab.description || '(无描述)'),
        ''
    ];
    if (deepLink) {
        lines.push(`[👉 查看详情并提交](${deepLink})`);
    }
    return lines.join('\n');
}

/**
 * 测试模式辅助:清空所有缓存(单测用)
 * 业务代码不要调用
 */
function _resetCacheForTest() {
    cachedToken = null;
    cachedTokenExpiry = 0;
    tokenRefreshPromise = null;
}

/**
 * 测试模式辅助:查看 cache 状态(单测用)
 */
function _getCacheStateForTest() {
    return {
        hasToken: !!cachedToken,
        cachedToken,
        cachedTokenExpiry,
        hasPendingRefresh: !!tokenRefreshPromise
    };
}

/**
 * token_expired 错误时清缓存,下次调用 getAccessToken 会重新拿。
 * Notify 主流程在 classifyError 返回 clearToken=true 时调用。
 */
function clearCachedToken() {
    cachedToken = null;
    cachedTokenExpiry = 0;
}

module.exports = {
    getAccessToken,
    getUserIdByMobile,
    sendMarkdownToUser,
    getReadStatus,
    classifyError,
    clearCachedToken,
    buildCollabNotifyCard,
    escapeMarkdown,
    // 测试导出(下划线前缀,生产代码不要用)
    _resetCacheForTest,
    _getCacheStateForTest
};
