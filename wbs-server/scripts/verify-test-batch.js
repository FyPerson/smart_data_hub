/**
 * #106 S3c 验证入口：批跑核心（scripts/lib/test-batch.js）+ 通用批跑入口（scripts/run-test-batch.js）+ run-verify-family.js 的接入 + 共享回收模块（scripts/lib/test-reap.js）
 *
 * 薄入口：监督逻辑（自检夹具、超时杀进程树、终止阶段独立截止、登记回收、非 Windows 拒绝）在同目录的共享模块 lines-test-supervisor.js，与 S2b / S2c / S3a / S3b 的入口共用同一份。本入口只传套件路径。
 *
 * 登记回收（reap: true）与 detached 夹具自检（detachedSelfTest: true）已启用（S3c 修复批 1 · 14T H2）：套件里有 detached 进程（H 节的挂起夹具、P 节的继承管道孙进程），
 *   桩成员与孙进程在做任何别的事之前先用共享回收模块的 registerSelfFromEnv 登记自己——写套件自己的登记文件，同时镜像到监督进程的登记文件（环境变量 S2C_TEST_REGISTRY，协议：{ pid, start }）。
 *   套件被强杀 / 超时 / 成员先退出之后，监督进程按「PID + 精确创建时间」回收这些进程；套件自己另有同一份登记的最外层回收与删除闸门。
 *   套件的 T 节用独立监督进程 + 替身套件证明两种强杀情形（孙进程启动后强杀套件、成员先退出后强杀套件）下按身份回收。
 *
 * 运行：node wbs-server/scripts/verify-test-batch.js [--only=A,B,C,D,E,F,G,H,I,J,K,L,N,P,Q,R,S,T,U] [--timeout-ms=<毫秒>] [--skip-selftest]
 *   节名：A 纯函数与成员校验；B 无需服务不起实例；C 共享实例与资源并集；D 独占成员；E 环境剔除；F 共享实例起不来；G 成员弄死实例；H 超时；I 停止失败；J FAMILY 输出格式；K 缺失资源；L 通用入口；
 *        N 修复批 1 批跑核心行为；P 管道与计时器；Q 存活检查核身份；R 共享回收模块；S 守卫覆盖；T 监督层回收；U 静态接线
 *   其余参数原样传给套件（--batch= / --family= / --cli= / --reap= / --preload= / --entry= / --summary-file= / --hang-timeout-ms= / --force-unsafe 是变异自证用的接缝）。
 * 退出码：0 = 自检与套件都通过；1 = 其他；2 = 超时（已杀进程树）；3 = 终止阶段回收失败。
 */
'use strict';

const path = require('path');
const { main } = require('./lines-test-supervisor.js');

main({ entryFile: __filename, suiteFile: path.join(__dirname, 'verify-test-batch-suite.js'), reap: true, detachedSelfTest: true });
