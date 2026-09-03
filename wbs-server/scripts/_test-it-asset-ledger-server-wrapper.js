/**
 * B7b IT_Asset_Ledger.html Playwright 冒烟专用 server 包装器（不改 server.js 源码）。
 *
 * 背景：server.js:26 `const DB_FILE = path.join(__dirname, 'task_pool.db')` 硬编码相对自身路径，
 * 不支持任何 env var 覆盖；本套件要求"自起独立进程但绝不碰真实 task_pool.db"（当前 3000 端口共享
 * 进程是陈旧代码，不许重启，且不能让烟雾测试的写操作污染生产库）。
 *
 * 做法：patch `sqlite3.Database` 把服务端唯一一处建库调用（server.js:842 `new sqlite3.Database
 * (DB_FILE, cb)`，已 grep 核实全项目仅此一处）重定向到临时 db 副本，其余 __dirname/相对 require/
 * uploads 路径全部保持 server.js 原有解析方式不变（本文件只 require server.js，不复制/移动它）。
 * `sqlite3.verbose()`（server.js:4）只装饰 Database.prototype、不重新赋值 `.Database` 属性，且
 * `.Database` 是普通可写属性（非 getter-only，见 node_modules/sqlite3/lib/sqlite3.js:59 `const
 * Database = sqlite3.Database`），patch 在 require(server.js) 之前生效，不会被其自身的 verbose()
 * 调用覆盖回原始类。
 *
 * 用法：spawn('node', [本文件路径], { cwd: ROOT, env: { ...process.env, PORT, IA_TEST_DB_PATH } })
 * ——cwd 必须传 ROOT：server.js 内 `require('dotenv').config()`（无 path 参数，按 process.cwd()
 * 解析）找不到 .env 时，JWT_SECRET 会静默落到 server.js 里的不安全兜底默认值，导致测试脚本自己
 * 签发的 token 与服务端校验用的密钥对不上。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const ROOT = path.join(__dirname, '..');
const REAL_DB_ABS = path.resolve(ROOT, 'task_pool.db');
const TEMP_DB = process.env.IA_TEST_DB_PATH;
if (!TEMP_DB) {
    console.error('[it-asset-ledger-wrapper] 缺少 IA_TEST_DB_PATH 环境变量，拒绝启动（防误连真实 db）');
    process.exit(1);
}

// H1 fail-closed 校验：下方 PatchedDatabase 的重定向逻辑只在 filename===REAL_DB_ABS 时才改写为
// TEMP_DB；若 IA_TEST_DB_PATH 本身被误设为真库路径，重定向条件恒不成立，会直接放行连接真库。
// 三层拦截，任一命中即视为校验失败，fail-closed 拒绝启动：
// ① 字面路径比较——覆盖直接把真库绝对/相对路径误传作 IA_TEST_DB_PATH 的场景；
// ② realpath 层比较——覆盖用 junction/symlink 把 TEMP_DB 间接指向真库文件的绕过手法；
//    realpath 抛异常（如上级目录不存在）同样按 fail-closed 处理，绝不放行；
// ③ dev+ino 层比较——覆盖 NTFS 硬链接（mklink /H）绕过：硬链接是同一物理文件的另一个平级目录项，
//    realpath 无法识别它（会原样返回硬链接自身路径，不指向"原始"文件），只有设备号+inode 同时
//    相同才能判定两个路径其实是同一份物理文件；同时拒绝非普通文件（设备/管道/目录等），stat
//    抛异常同样按 fail-closed 处理。
const RESOLVED_TEMP = path.resolve(TEMP_DB);
if (RESOLVED_TEMP === REAL_DB_ABS) {
    console.error(`[it-asset-ledger-wrapper] IA_TEST_DB_PATH（${RESOLVED_TEMP}）与真实 task_pool.db 字面同路径，拒绝启动（防误连真实 db）`);
    process.exit(1);
}
try {
    if (fs.existsSync(RESOLVED_TEMP) && fs.realpathSync(RESOLVED_TEMP) === fs.realpathSync(REAL_DB_ABS)) {
        console.error(`[it-asset-ledger-wrapper] IA_TEST_DB_PATH（${RESOLVED_TEMP}）realpath 后与真实 task_pool.db 指向同一文件（junction/symlink 绕过），拒绝启动（防误连真实 db）`);
        process.exit(1);
    }
} catch (e) {
    console.error(`[it-asset-ledger-wrapper] realpath 校验异常，fail-closed 视为校验失败，拒绝启动：${e.message}`);
    process.exit(1);
}
try {
    if (fs.existsSync(RESOLVED_TEMP)) {
        const st = fs.statSync(RESOLVED_TEMP);
        const stReal = fs.statSync(REAL_DB_ABS);
        if (!st.isFile() || (st.dev === stReal.dev && st.ino === stReal.ino)) {
            console.error(`[it-asset-ledger-wrapper] IA_TEST_DB_PATH（${RESOLVED_TEMP}）与真实 task_pool.db 设备号+inode 相同（NTFS 硬链接指向同一物理文件）或本身不是普通文件，拒绝启动（防误连真实 db）`);
            process.exit(1);
        }
    }
} catch (e) {
    console.error(`[it-asset-ledger-wrapper] dev+ino 校验异常，fail-closed 视为校验失败，拒绝启动：${e.message}`);
    process.exit(1);
}

const OrigDatabase = sqlite3.Database;
function PatchedDatabase(filename, ...rest) {
    const redirected = (typeof filename === 'string' && path.resolve(filename) === REAL_DB_ABS) ? RESOLVED_TEMP : filename;
    return new OrigDatabase(redirected, ...rest);
}
PatchedDatabase.prototype = OrigDatabase.prototype;
sqlite3.Database = PatchedDatabase;

require(path.join(ROOT, 'server.js'));
