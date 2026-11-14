/**
 * #113 C2a 项目管理（系统建设记录）权限核心与项目端点：真实 HTTP + 真实 token 的接口验证（经 test-env 起真实临时隔离实例）
 *
 * 范围：rules.js 的身份解析与判定函数、项目状态 × 动作查表、项目五个端点（建项 / 列表 / 详情 / 改基本信息 / 状态转移 / 更换 PM 与接管）、
 *   事件、actions 与执行一致、检查顺序。期望值一律手写，不取自被测代码。
 *
 * 用法：node scripts/verify-sysbuild-api.js               自起临时隔离实例（本检出本地库快照，钉钉走替身，周期任务关闭）跑全部用例，也可由 TEST_* 变量组指向已起好的隔离实例
 *       node scripts/verify-sysbuild-api.js --self-test   变异自检（默认「过滤模式」，P-S0 2026-11-01）：把 routes/sysbuild/ 的被测文件逐一注入变异，每个变异在进程内夹具里
 *                                                         只重跑 expect 前缀命中的用例，必须判红且每个前缀至少命中一条被打红的用例；另做子集基线（未变异副本跑同一子集，必须全绿）
 *                                                         与空跑对照（无语义改动的变异必须被判「未判红」，单独一行，不计入变异总数）；变异没登记 expect 直接判自检失败
 *       node scripts/verify-sysbuild-api.js --self-test --full
 *                                                         旧行为：每条变异跑全部用例（408 条约 3.3 小时，C9 前跑一次，平时不跑；550 条时过滤模式实测 411–423 秒，
 *                                                         `--full --mutations 408-549` 的 142 条 3136 秒）
 *       node scripts/verify-sysbuild-api.js --self-test --mutations 0,5,400-407
 *                                                         只跑 MUTATIONS 下标（含端点）挑中的变异，供新增批次只跑新增变异；可与过滤 / --full 组合；
 *                                                         汇总行写「挑选 K / 共 N」，逐条输出行带 `#<下标>`；子集基线只针对被挑中的变异
 *       node scripts/verify-sysbuild-api.js --self-test --full --mutation-ids <JSON 文件>
 *                                                         按变异 id 名单挑选（文件内容是 id 字符串数组；每个 id 须存在且只出现一次，名单内不重复，与 --mutations 互斥，可与 --full 组合）；
 *                                                         下标方式（--mutations）只作快速定位用
 *       参数白名单：自检只收 --self-test、--full、--mutations <值>、--mutation-ids <文件>（不接受 --mutations=…）；主跑不收任何参数（含 --full / --mutations / --self-test=1），出现即报参数错误、退出码非 0。
 *       阶段边界约定（P30）：除过滤自检外，再跑 --self-test --full --mutation-ids <本阶段新增与改动的变异 id 名单>（见 lib/sysbuild-api-suite.js 头注释）。
 *
 * 结构说明：用例与夹具在 scripts/lib/sysbuild-api-suite.js（测试隔离守卫要求本文件入口函数的第一条有副作用语句就是 `await ready()`，
 *   不能按命令行参数在它之前分流；变异自检的子进程直接跑那个库文件的 --inproc 入口，不起实例）。
 *   --self-test 也先起实例再分流：多约 10 秒启动开销，换来入口结构满足守卫；自检本身不使用实例。
 *   汇总行格式 `N/M 通过`，有跳过（实例模式下进程内专属的用例）时为 `N/M 通过（跳过 K）`，跳过不算通过也不算失败（自检为 `变异自检：X/K 判红（挑选 K / 共 N；模式）`）。
 */
'use strict';
const fx = require('./_test-fixture');
const suite = require('./lib/sysbuild-api-suite');

(async () => {
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    let failed = 1;
    try {
        failed = process.argv.includes('--self-test') ? await suite.runSelfTest(process.argv.slice(2)) : await suite.runInstanceSuite(fx, process.argv.slice(2));
    } catch (e) {
        console.log(`sysbuild api 执行异常: ${e && e.stack}`);
        failed = 3;
    } finally {
        try { await fx.teardown(); } catch (e) { console.log(`teardown（收掉自起实例）失败: ${e.message}`); }
    }
    fx.finish(failed === 0 ? 0 : 1);   // teardown 之后设退出码 + 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('sysbuild api 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
