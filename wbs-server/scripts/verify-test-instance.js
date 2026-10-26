/**
 * #106 S3a 验证入口：临时实例启动器（scripts/lib/test-instance.js）+ 汇总就绪接口（GET /api/health/ready）
 *
 * 薄入口：监督逻辑（自检夹具、超时杀进程树、终止阶段独立截止、非 Windows 拒绝）在同目录的共享模块 lines-test-supervisor.js，与 S2b 的 verify-lines-new-remove.js、
 * S2c 的 verify-lines-run.js 共用同一份。本入口只传套件路径。
 *
 * 取舍（不启用登记回收 reap / detached 夹具自检）：本套件不起 detached 进程——服务子进程由启动器用 spawn（非 detached）拉起，Windows 作业对象保证套件进程被监督进程
 *   杀掉（超时 / 异常）时服务一并结束；「父进程被强杀后服务消失」由套件 K 节用真实强杀单独证明。所以不需要「套件挂起时中间启动器已退出的 detached 服务」那条登记回收通道。
 *   监督进程的其余自检（A 正常终止 / B 终止命令失败 / C D 独立监督进程 / P 非 Windows / F 夹具清理只认精确身份）照常运行。
 *
 * 运行：node E:/tmp/wt-s3a/wbs-server/scripts/verify-test-instance.js [--only=A,B,X,E,F,W,K,U,G] [--timeout-ms=<毫秒>] [--skip-selftest]
 *   节名：A 正常启动 / 就绪接口 / 实例库 / 资源 / 停止；B 环境剔除；X 初始化失败的模块（含 core 前序失败）；E .env 白名单（合成检出里的合成 .env）；F 失败路径 / 选项 / 启动期竞态重试 / WAL 来源；W 遗留清理；K 父进程强杀；U 纯函数与静态接线；G 守卫自检
 *   其余参数原样传给套件（--launcher= / --server-js= / --health-util= / --summary-file= 是变异自证用的接缝）。
 * 退出码：0 = 自检与套件都通过；1 = 其他；2 = 超时（已杀进程树）；3 = 终止阶段回收失败。
 */
'use strict';

const path = require('path');
const { main } = require('./lines-test-supervisor.js');

main({ entryFile: __filename, suiteFile: path.join(__dirname, 'verify-test-instance-suite.js'), reap: false, detachedSelfTest: false });
