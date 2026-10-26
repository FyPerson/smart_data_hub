/**
 * #106 S3b 验证入口：测试入口助手（scripts/lib/test-env.js）+ 共享夹具（scripts/_test-fixture.js 基于 test-env）+ 已改造脚本的静态守卫
 *
 * 薄入口：监督逻辑（自检夹具、超时杀进程树、终止阶段独立截止、非 Windows 拒绝）在同目录的共享模块 lines-test-supervisor.js，与 verify-test-instance.js 等共用同一份。
 * 本入口只传套件路径。
 *
 * 登记回收（reap: true）已启用（S3b 修复批 2b）：套件的辅助进程会起服务，辅助进程被套件局部超时杀掉后，服务成了父进程已死的孤儿——监督进程的进程树终止够不到它。
 *   共享回收模块（lib/test-reap.js）把套件登记的每个进程（辅助进程、辅助进程里启动器交出的服务）同步镜像到监督进程的登记文件（环境变量 S2C_TEST_REGISTRY），
 *   套件被强杀 / 超时之后监督进程按「PID + 精确创建时间」回收；套件正常退出后仍有登记进程存活则判失败。节 T 用独立监督进程 + 替身套件证明这条路径。
 * detached 夹具自检（detachedSelfTest）不启用：那项自检要求套件支持 --detach-fixture（中间启动器退出、detached 服务存活），本套件没有 detached 进程；孤儿情形由节 T 的真实场景覆盖。
 *
 * 运行：node scripts/verify-test-env.js [--only=A,B,C,D,E,F,G,H,R,S,T] [--timeout-ms=<毫秒>] [--skip-selftest]
 *   节名：A 变量组形态 · 三项核对通过 / B 变量组输入校验 / C TEST_DB_PATH 指向业务库 / D 服务身份与库身份 / E live 形态与永不回落 3000 / F 全部缺省自起实例 / G 夹具 / H 静态守卫 / R 回收与删除闸门接线 / S 最外层收尾的异常边界与闸门接线（子套件进程 + 接缝） / T 监督层回收
 *   其余参数原样传给套件（--test-env= / --fixture= / --summary-file= / --reap= / --preload= / --ti= / --entry= / --force-unsafe / --seam= 是变异自证用的接缝）。
 * 退出码：0 = 自检与套件都通过；1 = 其他；2 = 超时（已杀进程树）；3 = 终止阶段回收失败。
 */
'use strict';

const path = require('path');
const { main } = require('./lines-test-supervisor.js');

main({ entryFile: __filename, suiteFile: path.join(__dirname, 'verify-test-env-suite.js'), reap: true, detachedSelfTest: false });
