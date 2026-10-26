/**
 * #106 S2c 验证入口：独立监督进程（line start / stop / list / overlap / check-deps / recover 的自检套件）
 *
 * 薄入口：监督逻辑（受控挂起夹具自检、超时杀进程树、终止阶段独立截止、非 Windows 拒绝、进程登记文件的创建 / 验证 / 按「PID + 精确创建时间」回收）在同目录的共享模块
 * lines-test-supervisor.js，与 S2b 的 verify-lines-new-remove.js 共用同一份（修复批 2，U3 裁定）。本入口传套件路径并启用登记回收与 detached 服务夹具自检。
 *
 * 登记回收：登记文件由监督进程指定（环境变量 S2C_TEST_REGISTRY），套件登记的进程与替身服务自己（启动时用 CIM 取自己的精确创建时间再登记）都往里追加，
 *   所以套件挂起时中间启动器早已退出的 detached 服务也在册；套件结束后只按「PID + 精确创建时间」回收（见共享模块头注释）。
 *
 * 运行：node E:/tmp/wt-s2c/wbs-server/scripts/verify-lines-run.js [--lines-dir=<被测 scripts/lines 目录的绝对路径>] [--only=1,2] [--timeout-ms=<毫秒>] [--skip-selftest]
 * 其余参数原样传给套件，含 --zero-crosstalk（H1-B：在真实槽位端口 3100 / 3200 上起占位监听做零串扰回归；缺省不碰这两个端口，见套件头注释）。退出码：0 = 自检与套件都通过；1 = 其他（含自检失败、登记通道失效、登记回收失败）；2 = 超时（已杀进程树）；3 = 终止阶段回收失败或登记回收总截止耗尽（--reap-deadline-ms，默认 30000）。
 */
'use strict';

const path = require('path');
const { main } = require('./lines-test-supervisor.js');

main({ entryFile: __filename, suiteFile: path.join(__dirname, 'verify-lines-run-suite.js'), reap: true, detachedSelfTest: true });
