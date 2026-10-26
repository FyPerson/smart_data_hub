/**
 * #106 S2b 验证入口：独立监督进程（line new / line remove 的自检套件）
 *
 * 薄入口：监督逻辑（受控挂起夹具自检 A/B/C/D、超时杀进程树、终止阶段独立截止、非 Windows 拒绝）在同目录的共享模块 lines-test-supervisor.js，
 * 与 S2c 的 verify-lines-run.js 共用同一份（修复批 2，U3 裁定）。本入口只传套件路径与「不启用登记回收」。
 *
 * 不启用登记回收的取舍：S2b 套件不起任何 detached 长寿进程（建线工作进程是监督进程的普通子进程，超时由进程树回收覆盖），不往登记文件写任何东西；
 *   启用只会多出一个登记通道的失效面（创建 / 读回 / 损坏记录），没有对应的回收收益。S2c 入口启用（它的替身服务由 CLI 以 detached 方式起，中间启动器退出后进程树杀不到）。
 *
 * 运行：node E:/tmp/wt-s2c/wbs-server/scripts/verify-lines-new-remove.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,5] [--timeout-ms=<毫秒>] [--skip-selftest]
 * 其余参数原样传给套件。退出码：0 = 自检与套件都通过；1 = 其他（含自检失败）；2 = 超时（已杀进程树）；3 = 终止阶段回收失败（超时后仍有进程没被收掉）。
 */
'use strict';

const path = require('path');
const { main } = require('./lines-test-supervisor.js');

main({ entryFile: __filename, suiteFile: path.join(__dirname, 'verify-lines-new-remove-suite.js'), reap: false, detachedSelfTest: false });
