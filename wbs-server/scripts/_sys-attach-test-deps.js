// 共享：sys verify 脚本的「附件 deps」stub（C3b 起 REQUIRED_DEPS 含 UPLOAD_DIR/normalizeAttachmentExt/
//   safeDeleteFileSync/ALLOWED_FILE_DIRS 四项；非附件脚本用 stub 注入即可过工厂期 deps 校验，附件脚本也复用此真实实现）。
//   用法：注入对象里加一行 `...require('./_sys-attach-test-deps'),`
//   ⚠️ 贴齐真实 server.js 语义（A9 verify-LOW：避免 stub 偏离致假绿）——真实实现见 server.js:525(safeDeleteFileSync)/12271(normalizeAttachmentExt)。
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// 真实临时上传根（verify-sys-attachments 真跑落盘用；其余脚本不写文件，仅占位过校验）
const UPLOAD_DIR = path.join(os.tmpdir(), 'sys-verify-uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* best-effort */ }
const ALLOWED_FILE_DIRS = [UPLOAD_DIR];

// 对齐 server.js normalizeAttachmentExt：控制字符 → 空串（拒绝）；trim；path.extname 取末尾扩展名小写。
function normalizeAttachmentExt(name) {
  let s = String(name || '');
  if (/[\x00-\x1F\x7F]/.test(s)) return '';   // eslint-disable-line no-control-regex  控制字符直接拒
  s = s.trim();
  return path.extname(s).toLowerCase().trim();
}

// 对齐 server.js safeDeleteFileSync 白名单语义：① baseDir 须 ∈ ALLOWED_FILE_DIRS ② rel resolve 后须严格在 baseDir 子树内（abs!==base 且 startsWith base+sep）才删。
function safeDeleteFileSync(rel, baseDir) {
  try {
    if (!ALLOWED_FILE_DIRS.includes(baseDir)) return;   // server.js:527 白名单守卫
    const base = path.resolve(baseDir);
    const abs = path.resolve(baseDir, rel);
    if (abs !== base && abs.startsWith(base + path.sep)) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
  } catch (_) { /* best-effort */ }
}

// C5 通知 deps stub（REQUIRED_DEPS 自 C5 起含 sendIssueDingtalkRaw/sendIssueDingtalkToRequester/getSafePlatformBaseUrl 三项）。
//   默认成功，使非通知脚本过工厂期 deps 校验且通知派发不报错；verify-sys-notify.js 自行覆盖这三项做可控 mock。
async function sendIssueDingtalkRaw(_targetUser, _title, _md) { return { ok: true, message_key: 'stub-dev' }; }
async function sendIssueDingtalkToRequester(_phone, _title, _md) { return { ok: true, message_key: 'stub-req' }; }
async function getSafePlatformBaseUrl() { return ''; }

// bug 流 Commit ③ 建群 deps stub（REQUIRED_DEPS 自 ③ 起含 readSystemConfig/COLLAB_CHAT_ADMIN_ID/callDingtalkWithTokenRetry/maskPhone 四项）。
//   非建群脚本用 stub 过工厂期 deps 校验；verify-sys-create-chat.js 自建完整 deps（不复用本文件），不受影响。
//   ⚠️ 这四项仅在 create-chat / reassign 换人同步群成员路径被真实调用——非 ③ 脚本的用例（无讨论群）会在 readSystemConfig 前早返回，不触达。
async function readSystemConfig(_key) { return ''; }                           // 空配置：非 ③ 脚本不触达；若触达 → NO_DINGTALK_CONFIG 安全失败
const COLLAB_CHAT_ADMIN_ID = 3;                                                // 示例用户A user.id（对齐 server.js:13315）
async function callDingtalkWithTokenRetry(_ak, _as, _token, _fn) { return {}; } // stub：不发真钉钉（非 ③ 脚本不触达）
function maskPhone(p) { return p; }                                            // 日志脱敏 stub（identity）

module.exports = { UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync, ALLOWED_FILE_DIRS,
  sendIssueDingtalkRaw, sendIssueDingtalkToRequester, getSafePlatformBaseUrl,
  readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry, maskPhone };
