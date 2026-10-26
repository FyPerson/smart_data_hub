// 共享：sys verify 脚本的「附件 deps」stub（C3b 起 REQUIRED_DEPS 含 UPLOAD_DIR/normalizeAttachmentExt/
//   safeDeleteFileSync/ALLOWED_FILE_DIRS 四项；非附件脚本用 stub 注入即可过工厂期 deps 校验，附件脚本也复用此真实实现）。
//   用法：注入对象里加一行 `...require('./_sys-attach-test-deps'),`
//   ⚠️ 贴齐真实 server.js 语义（A9 verify-LOW：避免 stub 偏离致假绿）——真实实现见 server.js:525(safeDeleteFileSync)/12271(normalizeAttachmentExt)。
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// 真实临时上传根（verify-sys-attachments 真跑落盘用；其余脚本不写文件，仅占位过校验）。
// 每进程私有：旧写法是 os.tmpdir()/sys-verify-uploads 这个固定的跨进程共享目录，约 100 个 FAMILY 成员经本助手注入使用，
//   verify-sys-delete 还会递归删整棵 sys-iteration 子树——两条线各跑一份 FAMILY 时会互删对方正在用的附件（S10 修复批 2 预筛 MED-1）。
// 规则：每个加载本助手的进程都 fs.mkdtempSync(os.tmpdir()/sys-verify-uploads-*) 建自己的私有目录，不跨进程复用、不写环境变量
//   （codex 46 M：写进 process.env 让后代继承，会在「公共父进程先加载本助手、再并发起多个成员」时让它们重新共用一个目录；
//    现有派生点——跨零点自重跑、_probe-* 探针——都不需要与父进程共用上传目录，所以不提供继承）。
//   本进程退出时清理：退出码为 0 才删；非 0 退出保留现场并打印路径（取证用）；清理本身失败则打印并把退出码置 1（不重试）。
//   进程被强杀时 exit 事件不触发，目录会残留（已知局限）。
const lineCommon = require('../../scripts/lines/line-common.js');
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-verify-uploads-'));
process.on('exit', (code) => {
  if (code !== 0) { console.error(`[_sys-attach-test-deps] 进程以退出码 ${code} 结束，保留上传目录现场：${UPLOAD_DIR}`); return; }
  try {
    lineCommon.deleteTreeNoFollow(fs.realpathSync.native(UPLOAD_DIR), []);
    fs.rmdirSync(UPLOAD_DIR);
  } catch (e) {
    console.error(`[_sys-attach-test-deps] 清理上传目录失败：${UPLOAD_DIR} :: ${(e && e.message) || e}`);
    process.exitCode = 1;
  }
});
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
// 日志脱敏：**贴齐 server.js:13578 真实实现**（本文件头部纪律：stub 偏离真实语义会致假绿/假红）。
//   原为 identity stub，2026-07-27 对抗审 F8 补通知留痕脱敏断言时暴露——它让"手机号已脱敏"这条断言
//   在测试里永远失败（真实实现是脱敏的，stub 不脱）。identity 版还会让"留痕不含裸手机号"这类
//   安全断言在别的脚本里**假绿**（stub 原样返回，恰好也没人断言过）。
function maskPhone(phone) {
  if (phone == null || typeof phone !== 'string') return '[invalid_phone]';
  const trimmed = phone.trim();
  if (!/^1\d{10}$/.test(trimmed)) return '[invalid_phone]';
  return `${trimmed.slice(0, 3)}****${trimmed.slice(7)}`;
}

module.exports = { UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync, ALLOWED_FILE_DIRS,
  sendIssueDingtalkRaw, sendIssueDingtalkToRequester, getSafePlatformBaseUrl,
  readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry, maskPhone };
