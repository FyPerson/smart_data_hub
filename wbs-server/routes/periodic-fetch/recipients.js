// routes/periodic-fetch/recipients.js — 周期取数推送模块 ④ 收件人核对 helper（集成点2 新增，验收后改造）
//   业务 SSOT = docs/local/周期取数推送/周期取数推送模块_方案_20260703_v1.0.md §6.2（H-4 硬约束，防发错人）
//   任务书 SSOT = docs/local/周期取数推送/周期取数推送_Sonnet任务书_20260705_v1.0.md 附录 A.4
//
// ⚠️ 改造说明（验收踩坑，2026-07-06）：v1.105.0 首版曾调用钉钉 topapi/v2/user/get（详情接口）反查姓名/
//   在职状态，验收发现应用未开通 `qyapi_get_member` 权限（老 user/get 与新 topapi/v2/user/get 两个详情接口
//   都报 errcode 60011）。用户拍板：不申请该权限，改用数据协作模块（server.js resolveRequesterDingUserId +
//   sendFileToUser 同款、已在生产验证）的成熟模式——**姓名由 admin 录入，不向钉钉查**；钉钉侧只用
//   getUserIdByMobile（phone→userid，已授权 scope）做"是否能送达"的核对。彻底删掉 getUserDetail/topapi 依赖。
//   utils/dingtalk-notify.js 是被 corrections / 数据协作 / 系统迭代共用的存量 util，红线要求"绝不改存量
//   util"。本文件只 require dingtalkNotify 现成导出的函数（getUserIdByMobile / classifyError），只读复用，
//   零修改。
'use strict';

// 手机号标准化：去空格。本模块范围内均为国内 11 位手机号，不做国际区号处理。
function normalizePhone(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').trim();
}

/**
 * 手机号 → 钉钉 userid 解析（方案 §6.2 核心链路，改造后不再反查姓名/在职状态——姓名由 admin 录入）。
 * deps 注入外部依赖（getUserIdByMobile/classifyError 必传），verify 脚本可 mock 覆盖各分支，不实连真实钉钉。
 *
 * reason 枚举：INVALID_PHONE_FORMAT / NOT_FOUND / MULTIPLE_MATCHES / 其余透传 classifyError.reason
 *   （token_expired/network/server_5xx 等服务类异常）。
 *
 * @returns {Promise<{ok:boolean, phone:string, userid?:string, dingUserIdLast4?:string, reason?:string}>}
 */
async function resolvePushRecipient(token, rawPhone, deps) {
  const getUserIdByMobile = deps.getUserIdByMobile;
  const classifyError = deps.classifyError;

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
  // 误传给后续发送——未识别的话行为仍安全（多值串会被钉钉发送接口拒绝），只是分类文案不精确。
  if (useridStr.includes(',')) {
    return { ok: false, phone, reason: 'MULTIPLE_MATCHES' };
  }

  return {
    ok: true,
    phone,
    userid: useridStr,
    dingUserIdLast4: useridStr.length >= 4 ? useridStr.slice(-4) : useridStr,
  };
}

module.exports = {
  normalizePhone,
  resolvePushRecipient,
};
