// scripts/lib/listen-safe-port.js — 测试夹具 / 本地维护脚本的回环服务统一监听入口（PROJECT_STATUS #95）
//
// 为什么不用 listen(0)：本机 TCP 动态端口段是 1024–15000，listen(0) 分到的端口可能落进 Fetch 标准
//   禁用名单（1719、1720、1723、2049、3659、4045、4190、5060、5061、6000、6566、6665–6669、6679、
//   6697、10080 等）。Node 内置 fetch（undici）在建连前就报 `fetch failed / cause: bad port`，
//   Chromium 同样拦截（ERR_UNSAFE_PORT），整套 FAMILY 因此偶发判红。
// 取值域：20000–49999（用户 2026-09-27 拍板）——整段高于禁用名单最大端口 10080、在本机动态端口段
//   1024–15000 之外、在本机管理排除段 50000–50059 之下。
// 重试：只重试「绑定」，且只认 EADDRINUSE（端口被占）与 EACCES（Windows 管理排除段 / 保留端口）；
//   其他错误原样抛出。绝不重试 HTTP 请求。
'use strict';
const http = require('node:http');
const { randomInt } = require('node:crypto');

const SAFE_PORT_MIN = 20000;
const SAFE_PORT_MAX = 49999;
const MAX_ATTEMPTS = 10;
const RETRYABLE_CODES = new Set(['EADDRINUSE', 'EACCES']);

function defaultPickPort() {
  return randomInt(SAFE_PORT_MIN, SAFE_PORT_MAX + 1); // randomInt 上界不含，+1 让 49999 可取
}

function bindOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      if (host === null) server.listen(port);
      else server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

/**
 * 在 SAFE_PORT_MIN–SAFE_PORT_MAX 内随机取端口监听，返回已处于 listening 的 server。
 * @param target express app（每次尝试新建 http.createServer(app)）或 net/http Server（原对象复用）
 * @param host   默认 '127.0.0.1'；传 null 表示不带 host（与原 listen(port) 同语义：绑未指定地址，
 *               localhost 解析到 ::1 也能连上）——机械替换时原调用不带 host 的点位用它保持原语义。
 * @param options 仅测试用：{ pickPort }，可注入端口选择函数；取到区间外的端口直接抛错。
 */
async function listenOnSafePort(target, host = '127.0.0.1', options = {}) {
  const pickPort = options.pickPort || defaultPickPort;
  const reuse = !!target && typeof target.listen === 'function' && typeof target.address === 'function';
  if (!reuse && typeof target !== 'function') throw new TypeError('listenOnSafePort: target 必须是 express app 或 http.Server');
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = pickPort(attempt);
    if (!Number.isInteger(port) || port < SAFE_PORT_MIN || port > SAFE_PORT_MAX) {
      throw new RangeError(`listenOnSafePort: 端口 ${port} 不在 ${SAFE_PORT_MIN}–${SAFE_PORT_MAX} 内`);
    }
    const server = reuse ? target : http.createServer(target);
    try {
      await bindOnce(server, port, host);
      return server;
    } catch (error) {
      if (!error || !RETRYABLE_CODES.has(error.code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { listenOnSafePort, SAFE_PORT_MIN, SAFE_PORT_MAX, MAX_ATTEMPTS };
