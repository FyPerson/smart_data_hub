'use strict';
// 生产路径为待切换配置；安装与 pm2 save 仍须按用户在场的切换流程执行。
module.exports = { apps: [{
    name: 'sysbuild-pm-temp', script: 'server.cjs', interpreter: 'C:/Program Files/nodejs/node.exe', cwd: 'E:/sysbuild-pm-temp',
    instances: 1, exec_mode: 'fork', autorestart: true, max_restarts: 10, min_uptime: '10s',
    env: { NODE_ENV: 'production', PORT: '3002', HOST: '0.0.0.0', SYSBUILD_DATA_DIR: 'E:/sysbuild-pm-data', SYSBUILD_PUBLIC_ORIGIN: 'http://172.16.0.138:3002', SYSBUILD_READ_ONLY: '1' },
    out_file: 'E:/sysbuild-pm-temp/logs/out.log', error_file: 'E:/sysbuild-pm-temp/logs/error.log', time: true,
}] };
