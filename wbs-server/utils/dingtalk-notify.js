/**
 * 钉钉通知模块（v2.0 / v3 二级转派扩展）
 *
 * 数据协作模块用,按状态把消息推给对接人 / 开发 / admin。
 *
 * 设计来源:docs/local/数据协作模块_方案_v2.0.md §7.4 / §7.6
 *          + docs/local/数据协作模块_二级转派_方案_20260518_v0.1.md §5
 * 参考实现:E:/数据处理/钉钉群消息文件推送_单点/send_user.py(企业内已跑通)
 *
 * 设计要点:
 *   - 纯函数库,不读 system_configs / users 表;凭证 + userId 由调用方传入
 *   - 进程内 access_token 缓存(7200s TTL, 200s 提前过期重取)
 *   - 并发刷新去重(多个请求同时撞过期 → 只发一次 gettoken)
 *   - 错误分层 7 类(network / rate_limit / server_5xx / invalid_response /
 *     token_expired / user_invalid / other),调用方据此决定是否清缓存 + UI 提示
 *   - token_expired 重试由业务发送路径负责(server.js: sendCollabDingtalkRaw),
 *     classifyError 仅给出"建议清缓存重发"信号,本模块不再自己重试
 *   - v3 模板 3 个(buildCollabCreatedCard 通知对接人 / buildCollabAssignedCard
 *     通知开发 / buildCollabSubmittedCard 通知 admin)+ buildCollabNotifyCard
 *     别名指向 Created（兼容 v2.0 调用）
 *
 * 依赖:Node ≥ 18 内置 fetch(已在生产 Node v24.12.0 验证)
 */

'use strict';

const GETTOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const GET_BY_MOBILE_URL = 'https://oapi.dingtalk.com/user/get_by_mobile';
const BATCH_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const READ_STATUS_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/readStatus';
// v1.69.0 拉起钉钉沟通群（数据协作模块）
// 2026-05-20 探针验证：qyapi_chat_manage 权限已开通；钉钉无 disband 服务端 API
const CHAT_CREATE_URL = 'https://oapi.dingtalk.com/chat/create';
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

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
 * 创建钉钉群会话(v1.69.0 数据协作模块·拉起沟通群)。
 *
 * 钉钉接口:POST oapi.dingtalk.com/chat/create
 *   - access_token 在 query string
 *   - errcode!=0 不抛错,放返回对象里(与 sendMarkdownToUser 同模式)
 *   - 需要应用具备 qyapi_chat_manage 权限(2026-05-20 已开通)
 *   - 群上限 1000 人,首批 useridlist 最多 40 人,本函数不做切片(协作单场景实际 3-5 人)
 *
 * 注意:钉钉无解散群服务端 API,群创建后只能群主在客户端手动解散。
 *
 * @param {string} token       access_token
 * @param {string} name        群名(≤20 字符,调用方负责截断)
 * @param {string} owner       群主钉钉 userid(必须在 useridlist 中)
 * @param {string[]} userIds   群成员钉钉 userid 数组(含 owner)
 * @param {object} [options]   可选参数:validationType(入群验证 0/1)/ searchable(0/1)等
 * @returns {Promise<object>}  钉钉原始响应,成功时 { errcode:0, chatid, openConversationId },
 *                              失败时 { errcode, errmsg }
 * @throws {Error}  HTTP 5xx / 非 JSON / 网络错误
 */
async function createChatGroup(token, name, owner, userIds, options = {}) {
    if (!Array.isArray(userIds) || userIds.length < 2) {
        throw new Error('createChatGroup: userIds 至少 2 个(含群主)');
    }
    if (!userIds.includes(owner)) {
        throw new Error('createChatGroup: owner 必须在 userIds 中(钉钉硬约束)');
    }
    const url = `${CHAT_CREATE_URL}?access_token=${encodeURIComponent(token)}`;
    const payload = {
        name,
        owner,
        useridlist: userIds,
        validationType: options.validationType || '0',  // 默认不开入群验证
        searchable: options.searchable || 0,             // 默认不可被搜索
        mentionAllAuthority: options.mentionAllAuthority || 0,
        ...options
    };
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (resp.status >= 500) {
        const err = new Error(`chat/create HTTP ${resp.status}`);
        err.httpStatus = resp.status;
        throw err;
    }

    try {
        return await resp.json();
    } catch (parseErr) {
        const err = new Error(`chat/create non-JSON response: ${parseErr.message}`);
        err.httpStatus = resp.status;
        throw err;
    }
}

/**
 * 发送群消息到指定钉钉群(v1.69.0 拉起群聊后发欢迎卡片用)。
 *
 * 钉钉接口:POST api.dingtalk.com/v1.0/robot/groupMessages/send
 *   - token 在 header(x-acs-dingtalk-access-token)
 *   - 需要 robotCode 和 openConversationId
 *   - 同 sendMarkdownToUser 一样不抛 errcode 错,放返回里
 *
 * @param {string} token              access_token
 * @param {string} robotCode          机器人 RobotCode(与单聊用同一个)
 * @param {string} openConvId         钉钉 openConversationId
 * @param {string} msgKey             消息类型(sampleMarkdown / sampleText 等)
 * @param {object} msgParam           消息体(钉钉端 stringify 后传)
 * @returns {Promise<object>}         钉钉原始响应
 * @throws {Error}                    HTTP 5xx / 非 JSON / 网络错误
 */
async function sendGroupMessage(token, robotCode, openConvId, msgKey, msgParam) {
    const payload = {
        robotCode,
        openConversationId: openConvId,
        msgKey,
        msgParam: typeof msgParam === 'string' ? msgParam : JSON.stringify(msgParam)
    };
    const resp = await fetchWithTimeout(GROUP_SEND_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': token
        },
        body: JSON.stringify(payload)
    });

    if (resp.status >= 500) {
        const err = new Error(`groupMessages/send HTTP ${resp.status}`);
        err.httpStatus = resp.status;
        throw err;
    }

    try {
        return await resp.json();
    } catch (parseErr) {
        const err = new Error(`groupMessages/send non-JSON response: ${parseErr.message}`);
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
        // 非 JSON 响应（v1.69.0 codex L1：泛化匹配,覆盖 chat/create / groupMessages/send / readStatus）
        if (input.message && input.message.includes('non-JSON response')) {
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
    // v3：收件人可能是对接人/开发/admin,文案保持中性(codex 十六审 #9)
    if (errcode === 88 || errcode === 88002) {
        return {
            reason: 'user_invalid',
            clearToken: false,
            clearUserId: true,
            errcode,
            errmsg,
            hint: '目标账号在钉钉端不存在,请管理员检查该用户的手机号是否已加入企业钉钉'
        };
    }

    // 应用未开通权限:errcode=60011(v1.69.0 chat/create 已知错误)
    if (errcode === 60011) {
        return {
            reason: 'no_scope',
            clearToken: false,
            clearUserId: false,
            errcode,
            errmsg,
            hint: '钉钉应用未开通所需权限，请联系管理员在开放平台后台申请：' + (errmsg || '')
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
function _buildDeepLink(collab, platformBaseUrl) {
    const baseUrl = (platformBaseUrl || '').replace(/\/+$/, '');
    return baseUrl ? `${baseUrl}/Data_Collab.html?id=${collab.id}` : '';
}

function _buildCollabHeaderLines(collab) {
    return [
        `- **OA 流程号**:${escapeMarkdown(collab.oa_request_no || '-')}`,
        `- **业务部门**:${escapeMarkdown(collab.requester_dept || '-')}`,
        `- **申请人**:${escapeMarkdown(collab.requester_name || '-')}`,
        `- **目标业务库**:${escapeMarkdown(collab.target_db_name || '-')}`,
        `- **截止时间**:${escapeMarkdown(collab.deadline || '-')}`,
    ];
}

/**
 * 模板 1：协作单创建后，通知对接人（v3 二级转派）
 * 触发：admin 创建协作单 → 状态 PENDING_ASSIGN → 调 notify endpoint
 * 收件人：对接人（contact_person）
 */
function buildCollabCreatedCard(collab, platformBaseUrl) {
    const deepLink = _buildDeepLink(collab, platformBaseUrl);
    const lines = [
        '#### 新临时取数任务 · 待指派开发',
        '',
        ..._buildCollabHeaderLines(collab),
        '',
        '**需求描述**',
        '',
        escapeMarkdown(collab.description || '(无描述)'),
        ''
    ];
    if (deepLink) {
        lines.push(`[👉 查看详情并指派开发](${deepLink})`);
    }
    return lines.join('\n');
}

/**
 * 兼容旧调用名 — v2.0 D2 钉钉模块用的 buildCollabNotifyCard 现指向创建模板
 */
const buildCollabNotifyCard = buildCollabCreatedCard;

/**
 * 模板 2：协作单首次指派后，通知开发（v3 二级转派）
 * 触发：对接人/admin 调 POST /:id/assign，状态 PENDING_ASSIGN → PENDING
 * 收件人：被指派的开发
 * 期望 collab 多带：contact_person_name
 */
function buildCollabAssignedCard(collab, platformBaseUrl) {
    const deepLink = _buildDeepLink(collab, platformBaseUrl);
    const lines = [
        '#### 你被指派了协作单',
        '',
        ..._buildCollabHeaderLines(collab),
        `- **对接人**:${escapeMarkdown(collab.contact_person_name || '-')}`,
        '',
        '**需求描述**',
        '',
        escapeMarkdown(collab.description || '(无描述)'),
        ''
    ];
    if (deepLink) {
        lines.push(`[👉 查看详情并上传交付物](${deepLink})`);
    }
    return lines.join('\n');
}

/**
 * 模板 3：协作单提交后，通知 admin（v3 二级转派）
 * 触发：开发调 POST /:id/submit，状态 PENDING → SUBMITTED
 * 收件人：admin（验收人）
 * 期望 collab 多带：developer_name / contact_person_name
 */
function buildCollabSubmittedCard(collab, platformBaseUrl) {
    const deepLink = _buildDeepLink(collab, platformBaseUrl);
    const lines = [
        '#### 协作单已提交 · 待验收',
        '',
        ..._buildCollabHeaderLines(collab),
        `- **对接人**:${escapeMarkdown(collab.contact_person_name || '-')}`,
        `- **开发**:${escapeMarkdown(collab.developer_name || '-')}`,
        '',
        '系统已自动跑 smoke test 验收，请到平台查看结果',
        ''
    ];
    if (deepLink) {
        lines.push(`[👉 查看验收结果](${deepLink})`);
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

/**
 * v1.71.0 三级转发：钉钉群加人。
 *
 * 钉钉接口:POST oapi.dingtalk.com/chat/update
 *   - access_token 在 query string(与 createChatGroup 同模式)
 *   - errcode=0 软成功(F1 真跑验证:加重复人 errcode=0,加无效 userid 也 errcode=0+errorUserIds 字段)
 *   - errcode!=0 不抛错,放返回对象里,由调用方走 classifyAddUserErrcode
 *
 * @param {string} accessToken  access_token
 * @param {string} chatid       钉钉群 chatid(不是 openConversationId)
 * @param {string[]} useridList 钉钉 userid 数组(单元素或多元素)
 * @returns {Promise<{ok: boolean, errcode: number, errmsg: string, errorUserIds: string[]|null}>}
 * @throws {Error}  HTTP 5xx / 非 JSON / 网络错误
 */
async function addUserToChat(accessToken, chatid, useridList) {
    // codex 34 审 M-2 部分采纳：基础形态校验对齐 createChatGroup line 182-187
    if (!Array.isArray(useridList) || useridList.length === 0) {
        throw new Error('addUserToChat: useridList 必须是非空数组');
    }

    const url = `https://oapi.dingtalk.com/chat/update?access_token=${encodeURIComponent(accessToken)}`;
    const body = { chatid, add_useridlist: useridList };

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (resp.status >= 500) {
        const err = new Error(`chat/update HTTP ${resp.status}`);
        err.httpStatus = resp.status;
        throw err;
    }

    let data;
    try {
        data = await resp.json();
    } catch (parseErr) {
        const err = new Error(`chat/update non-JSON response: ${parseErr.message}`);
        err.httpStatus = resp.status;
        throw err;
    }

    return {
        ok: data.errcode === 0,
        errcode: data.errcode,
        errmsg: data.errmsg || '',
        errorUserIds: data.errorUserIds ? safeParseUserIdList(data.errorUserIds) : null
    };
}

/**
 * v1.71.0 三级转发：兼容钉钉 errorUserIds 字段三种返回形态。
 *
 * F1 真跑实测：钉钉文档说返回数组，但生产环境曾观察到字符串形态(可能是 JSON 数组字符串
 * 或单值字符串)。统一归一化为数组。
 *
 * @param {string[]|string|null|undefined} raw
 * @returns {string[]|null}
 */
function safeParseUserIdList(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [raw];
        } catch {
            return [raw];
        }
    }
    return null;
}

/**
 * v1.71.0 三级转发：F1 实测 errcode 分类（业务层据此决策落库/重试/告警）。
 *
 * kind 含义：
 *   - soft_success：errcode=0 且 errorUserIds 空，正常成功 OR 已在群幂等
 *   - hard_fail：终态失败，业务层记日志 + 告警 admin，不重试
 *   - retry：可重试（refresh token 或 backoff），业务层重试 1 次
 *   - other：未分类，记日志 + 告警
 *
 * errcode 来源标注（codex 34 审 rec 3）：
 *   - F1 真跑实测：0（含 errorUserIds 软失败子集）/ 0（加重复人幂等）/ 49016
 *   - 文档推断（未真跑，注意可信度）：60011 / 60020 / 88 / 40014 / 90002 / 400013 / 90100
 *
 * @param {number} errcode
 * @param {string[]|null} errorUserIds  钉钉返出错的 userid（errcode=0 软失败 + errcode=49016 都有值）
 * @returns {{kind: 'soft_success'|'hard_fail'|'retry'|'other', action: string, detail?: string}}
 */
function classifyAddUserErrcode(errcode, errorUserIds) {
    // codex 34 审 H-1：F1 真跑事实——errcode=0 + errorUserIds 非空 = 部分失败子集
    // 必须先于"errcode=0 → soft_success"判断，否则失败子集会被误标为已入群
    if (errcode === 0 && Array.isArray(errorUserIds) && errorUserIds.length > 0) {
        return {
            kind: 'hard_fail',
            action: 'mark_userid_invalid',
            detail: `钉钉返回 errcode=0 但 errorUserIds 非空（部分失败子集）：${errorUserIds.join(',')}（检查 users.dingtalk_user_id 是否过期/离职）`
        };
    }
    if (errcode === 0) return { kind: 'soft_success', action: 'added_to_chat' };
    if (errcode === 49016) return {
        kind: 'hard_fail',
        action: 'mark_userid_invalid',
        detail: `钉钉员工不存在：${(errorUserIds || []).join(',')}（检查 users.dingtalk_user_id 是否过期/离职）`
    };
    if (errcode === 60011) return { kind: 'hard_fail', action: 'alert_admin_permission_revoked' };
    if (errcode === 60020) return { kind: 'retry', action: 'backoff_retry' };
    // codex 34 审 M-1：对齐同文件 classifyError line 336-345（88 = user_invalid）
    // 此前与 40014 一起归 refresh_token_retry 是抄方案骨架未核对，F1 未真跑过 chat/update 拿到 88
    if (errcode === 88) return { kind: 'hard_fail', action: 'mark_userid_invalid', detail: '钉钉用户不存在（errcode=88，对齐 classifyError 语义）' };
    if (errcode === 40014) return { kind: 'retry', action: 'refresh_token_retry' };
    if (errcode === 90002) return { kind: 'hard_fail', action: 'alert_chat_full' };
    if (errcode === 400013 || errcode === 90100) return { kind: 'hard_fail', action: 'mark_chatid_invalid' };
    return { kind: 'other', action: 'log_and_alert', detail: `未分类 errcode=${errcode}` };
}

module.exports = {
    getAccessToken,
    getUserIdByMobile,
    sendMarkdownToUser,
    getReadStatus,
    classifyError,
    clearCachedToken,
    buildCollabNotifyCard,
    // v3 二级转派 3 模板
    buildCollabCreatedCard,
    buildCollabAssignedCard,
    buildCollabSubmittedCard,
    // v1.69.0 拉起钉钉沟通群
    createChatGroup,
    sendGroupMessage,
    escapeMarkdown,
    // v1.71.0 三级转发：钉钉群加人 + errcode 分类
    addUserToChat,
    safeParseUserIdList,
    classifyAddUserErrcode,
    // 测试导出(下划线前缀,生产代码不要用)
    _resetCacheForTest,
    _getCacheStateForTest
};
