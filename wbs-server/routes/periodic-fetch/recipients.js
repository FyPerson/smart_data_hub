// routes/periodic-fetch/recipients.js — 周期取数推送模块 ④ 收件人核对 helper（集成点2 新增）
//   业务 SSOT = docs/local/周期取数推送/周期取数推送模块_方案_20260703_v1.0.md §6.2（H-4 硬约束，防发错人）
//   任务书 SSOT = docs/local/周期取数推送/周期取数推送_Sonnet任务书_20260705_v1.0.md 附录 A.4
//
// ⚠️ 边界说明（自审重点，供主会话复核）：
//   utils/dingtalk-notify.js 是被 corrections / 数据协作 / 系统迭代共用的存量 util，红线要求
//   "绝不改存量 util"。本文件是全新文件，只 require dingtalkNotify 现成导出的函数
//   （getUserIdByMobile / classifyError / getAccessToken / uploadMedia / sendFileToUser，均只读复用，
//   零修改）。方案 §6.2 要求核对时"显示姓名/部门/钉钉ID后四位"，但 dingtalk-notify.js 里现成的
//   getUserIdByMobile 只反查 userid（钉钉 user/get_by_mobile 接口本身不返回姓名/部门），要拿到姓名/
//   在职状态需要另一个接口 topapi/v2/user/get——这个能力在存量文件里不存在。为避免碰存量共享 util，
//   新增能力独立写在本文件（新文件，非改动），only require dingtalkNotify 已导出的函数。
//   ⭐ 部门名解析已主动砍掉（范围裁剪，非遗漏）：topapi/v2/user/get 只返回 dept_id_list（部门 ID 数组），
//   要拿"部门名"还需要再调一次 department/get（第二个未经真实验证的钉钉 API + 需要缓存机制）。
//   本次只做"姓名 + 手机号 + 钉钉ID后四位 + 在职状态"核对（够核对"是不是这个人"的核心诉求），部门 ID
//   原样透传供 admin 参考，不解析成部门名——如后续要补全部门名显示，需再加一次 API 攻坚，留给主会话判断
//   是否值得为这个展示细节多引入一个未验证的外部 API 面。
//   ⚠️ 真实钉钉 API 响应字段假设（待主线真样本实测，worktree 无法连真实钉钉网络验证）：
//     topapi/v2/user/get 响应体假设含 result.name / result.active（布尔，是否在职）/
//     result.dept_id_list（数组）——字段名依据钉钉官方文档通用约定，未做真实调用验证。
'use strict';

const USER_GET_URL = 'https://oapi.dingtalk.com/topapi/v2/user/get';
const TIMEOUT_MS = 10 * 1000;

// 与 dingtalk-notify.js 的 fetchWithTimeout 同款 10 行实现（有意不共享——本文件独立成文件的目的
// 正是不碰存量 util，跨文件各自持有一份基础设施小工具在本项目已有先例，见 collab-submit-helpers.js）。
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
 * 查询钉钉用户详情（姓名/在职状态/部门 id 列表）。
 * @param {string} token   access_token
 * @param {string} userid  钉钉 userId
 * @returns {Promise<{name: string|null, activeRaw: (boolean|undefined), deptIds: number[]}>}
 *   activeRaw = 钉钉原始在职字段值（true/false/undefined），三态 fail-closed 判定在 resolvePushRecipient。
 * @throws {Error}  errcode!=0 / 网络异常（调用方走 classifyError 分类）
 */
async function getUserDetail(token, userid) {
  const resp = await fetchWithTimeout(`${USER_GET_URL}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid, language: 'zh_CN' }),
  });
  if (resp.status >= 500) {
    const err = new Error(`topapi/v2/user/get HTTP ${resp.status}`);
    err.httpStatus = resp.status;
    throw err;
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    const err = new Error(`topapi/v2/user/get non-JSON response: ${e.message}`);
    err.httpStatus = resp.status;
    throw err;
  }
  if (data.errcode !== 0) {
    const err = new Error(`topapi/v2/user/get failed: errcode=${data.errcode} errmsg=${data.errmsg}`);
    err.errcode = data.errcode;
    err.errmsg = data.errmsg;
    throw err;
  }
  const result = data.result || {};
  return {
    name: result.name || null,
    // H-2（集成审 fail-closed）：返回**原始** active 值（可能 true/false/undefined），不在此处折叠成
    //   布尔。三态判定放 resolvePushRecipient——敏感数据宁拒不误发：明确 true 才放行，false=离职拒，
    //   缺字段/非布尔=状态未知拒（旧代码 `active !== false` 是 fail-open，缺字段当在职会误发）。
    //   ⚠️ 真实钉钉字段名待主线真样本实测校准：若实际非 `active`（如 `is_active`/嵌套在别处），届时只
    //   调字段名、**保留 fail-closed 方向**（明确在职才 ok）。
    activeRaw: result.active,
    deptIds: Array.isArray(result.dept_id_list) ? result.dept_id_list : [],
  };
}

// 手机号标准化：去空格。本模块范围内均为国内 11 位手机号，不做国际区号处理。
function normalizePhone(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').trim();
}

/**
 * 手机号 → 收件人核对信息（方案 §6.2 核心链路）。
 * deps 注入外部依赖（getUserIdByMobile/classifyError 必传，getUserDetail 可选注入覆盖），
 * verify 脚本可 mock 覆盖各分支，不实连真实钉钉。
 *
 * reason 枚举：INVALID_PHONE_FORMAT / NOT_FOUND / MULTIPLE_MATCHES / INACTIVE_USER /
 *   UNKNOWN_ACTIVE_STATUS（H-2 fail-closed：在职状态字段缺失/非布尔，宁拒不误发）/
 *   DETAIL_NOT_FOUND / DETAIL_LOOKUP_FAILED:<reason> / 其余透传 classifyError.reason
 *   （token_expired/network/server_5xx 等服务类异常）。
 *
 * @returns {Promise<{ok:boolean, phone:string, userid?:string, name?:string, deptIds?:number[], dingUserIdLast4?:string, reason?:string}>}
 */
async function resolvePushRecipient(token, rawPhone, deps) {
  const getUserIdByMobile = deps.getUserIdByMobile;
  const classifyError = deps.classifyError;
  const getUserDetailFn = deps.getUserDetail || getUserDetail;

  const phone = normalizePhone(rawPhone);
  if (!/^1\d{10}$/.test(phone)) {
    return { ok: false, phone, reason: 'INVALID_PHONE_FORMAT' };
  }

  let rawUserid;
  try {
    rawUserid = await getUserIdByMobile(token, phone);
  } catch (err) {
    const cls = classifyError(err);
    return { ok: false, phone, reason: cls.reason === 'user_invalid' ? 'NOT_FOUND' : cls.reason };
  }
  const useridStr = rawUserid != null ? String(rawUserid).trim() : '';
  if (!useridStr) return { ok: false, phone, reason: 'NOT_FOUND' };
  // 钉钉"多组织账号"场景可能返回逗号分隔多个 userid（方案 §6.2"查到多条"分支）。现有
  // getUserIdByMobile 底层实现按单值处理，此处显式识别逗号分隔形态，避免把拼接串当单一 userid
  // 误传给后续查询/发送（未识别的话行为仍安全——多值串查 detail 会 NOT_FOUND，只是分类文案不精确）。
  if (useridStr.includes(',')) {
    return { ok: false, phone, reason: 'MULTIPLE_MATCHES' };
  }

  let detail;
  try {
    detail = await getUserDetailFn(token, useridStr);
  } catch (err) {
    const cls = classifyError(err);
    return { ok: false, phone, userid: useridStr, reason: `DETAIL_LOOKUP_FAILED:${cls.reason}` };
  }
  if (!detail || !detail.name) {
    return { ok: false, phone, userid: useridStr, reason: 'DETAIL_NOT_FOUND' };
  }
  // H-2（fail-closed 三态）：明确在职(true)才放行；明确离职(false)→INACTIVE_USER；状态未知(字段缺失/
  //   非布尔)→UNKNOWN_ACTIVE_STATUS。两者都拒发，但保留区分（INACTIVE=确定离职、UNKNOWN=拿不到状态，
  //   排障语义不同），比"非 true 一律 UNKNOWN"更信息完整，方向同为宁拒不误发。
  if (detail.activeRaw === false) {
    return { ok: false, phone, userid: useridStr, reason: 'INACTIVE_USER' };
  }
  if (detail.activeRaw !== true) {
    return { ok: false, phone, userid: useridStr, reason: 'UNKNOWN_ACTIVE_STATUS' };
  }

  return {
    ok: true,
    phone,
    userid: useridStr,
    name: detail.name,
    deptIds: detail.deptIds || [],
    dingUserIdLast4: useridStr.length >= 4 ? useridStr.slice(-4) : useridStr,
  };
}

module.exports = {
  getUserDetail,
  normalizePhone,
  resolvePushRecipient,
};
