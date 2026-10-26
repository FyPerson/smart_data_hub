/**
 * 库内实例身份核对脚本（#106 S1a）：只读打开库，向 stdout 输出一行 JSON { ok, code, message }；
 * ok 时退出码 0，否则 1。由 utils/instance-db.js 的 checkInstanceIdentitySync 在 server.js 启动期同步调用。
 *
 * 用法：node utils/instance-db-check.js --db <库文件绝对路径> --instance <运行身份> [--parent <父检出身份>]
 */
'use strict';

const { checkInstanceIdentity } = require('./instance-db');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db' || a === '--instance' || a === '--parent') { out[a.slice(2)] = argv[++i]; }
    }
    return out;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    let result;
    try {
        result = await checkInstanceIdentity(args.db, { expectedInstance: args.instance, expectedParent: args.parent });
    } catch (e) {
        result = { ok: false, code: 'CHECK_ERROR', message: String(e && e.message) };
    }
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
})();
