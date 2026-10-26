#!/usr/bin/env node
// 全家 verify sweep 驱动脚本——把「cd wbs-server && for 循环逐套件跑」固化为单条 node 命令。
// 动机（2026-08-14）：复合 shell 命令（cd&&for）无法被权限层静态分析，无人值守段每次亲跑都会
//   触发人工确认弹窗；本脚本让主会话/agent 恒以 `node wbs-server/scripts/run-verify-family.js`
//   单命令跑全量（静态可分析·可白名单），同时保持退出码校验制（任一套件红 ⇒ 本脚本 exit 1，
//   杜绝管道 |tail 吞退出码类事故——见 13354ac 沉淀）。
// 行为契约：
//   - 扫描面 = scripts/verify-sys-*.js 全部 + 台账矩阵/对账两个专项成员 + #95 两个成员（端口助手自检 verify-listen-safe-port、禁系统分配端口守卫 verify-no-listen-zero，均计入 PASS）+ #77 C1a 三个成员（验收判定 verify-model-acceptance、脚本比较 verify-model-script-compare、模型恢复 verify-model-restore-api，均计入 PASS）+ #77 C1c 三个成员（写入点分类守卫 verify-model-write-classification 基线与 --self-test 各一次、config_rev HTTP 级性质断言 verify-model-config-rev-http，均计入 PASS；后者自起隔离实例，约 1 分钟）+ #106 S1a 两个成员（运行模式判定 / 库内身份 / AES 纯函数 verify-instance-mode、隔离实例启动集成 verify-instance-startup，均计入 PASS；后者自起隔离实例子进程，约 1–2 分钟）+ #106 S1b 一个成员（外部调用闸门 / 隔离库准备 verify-instance-external，进程内）+ #106 S2-0 一个成员（配置读取键全等守卫 verify-instance-config-keys，含内置自测，计入 PASS）+ #106 S2a 一个成员（线路登记表与状态锁 verify-lines-state，临时控制根，计入 PASS）+ #106 S2b 一个成员（建线 / 删线 verify-lines-new-remove，经监督进程跑套件，临时仓库与临时控制根，约 4–5 分钟，计入 PASS）+ #106 S2c 一个成员（启停 / 列表 / 重叠 / 依赖检查 verify-lines-run，经同一共享监督进程，起替身服务，约 5–6 分钟，计入 PASS）+ #106 S3a 一个成员（临时实例启动器 / 汇总就绪接口 verify-test-instance，经同一共享监督进程，起真服务与桩服务，约 2 分钟，计入 PASS）+ #106 S3b 一个成员（测试入口助手 / 共享夹具 / 已改造脚本静态守卫 verify-test-env，经同一共享监督进程，起桩服务，约 1–2 分钟，计入 PASS）+ #106 S3c 一个成员（批跑核心 / 通用入口 verify-test-batch，经同一共享监督进程，起桩服务与桩成员，计入 PASS）+ 静态守卫（见文件内 GUARDS 数组——数量与具体名单
//     以该数组为准，不在本注释里重复罗列/计数，避免像 R5〔12a-L1〕之前那样"三静态守卫"这句话
//     随数组扩容悄悄过期失真）；新增 verify-sys-* 套件零配置自动纳入。
//   - 成功套件静默只计数；失败套件立即打印其完整输出（stdout+stderr）便于定位。
//   - 工作目录由脚本自身位置推导（chdir 到 wbs-server 根），与调用方 cwd 无关。
//   - 汇总行格式固定：`FAMILY PASS=<n> FAIL=<n>` + 每守卫一行 `GUARD <name> OK|RED`，供上层 grep。
//     起过实例时在 FAMILY 行之后另起一行 `TEST_INSTANCES shared=<n> exclusive=<n> restarts=<n> raceRetries=<n> missingResources=<n>`（不改 FAMILY 行格式）。
// 批跑核心（#106 S3c）：所有成员（含守卫）统一经 scripts/lib/test-batch.js 的 runBatch 跑。成员表在 buildFamilyMembers() 一处汇总；
//   成员 = { label, rel, args?, needsService?, resources?, exclusive?, timeoutMs? }，字段含义见 test-batch.js 头注释。
//   **登记「需服务」成员（S4 迁移用）**：成员本身（label / rel / args）照旧留在下面 buildFamilyMembers 的成员表里（自动扫描的 verify-sys-* 成员也一样，不用改它们的登记）；
//     在本文件的 SERVICE_MEMBERS 数组里按**同一个 label** 加一项，只写需服务属性，例如
//       { label: 'verify-model-config-rev-http', needsService: true, resources: ['uploads'] }
//     applyServiceMembers 会按 label 在成员表**原位置**替换这些属性（顺序不变、成员只跑一次）；不是追加：同一个 label 写两份会触发批跑核心的 label 重复拒绝，换名字则会跑两次，所以不要那样迁移。
//     迁移登记只接受 label / needsService / exclusive / resources / timeoutMs；label 在成员表里不存在、写了别的字段（rel / args）、同一个 label 登记两次，都直接报错（整批不执行）。
//     需要独占（会删除 / 改写附件之类，不能与别的成员共享资源状态）的再加 exclusive: true；需要更长或更短的截止加 timeoutMs（默认 20 分钟，只对需服务成员生效）。
//     批跑器会按所有共享成员的资源并集起一个共享实例，把 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET 传给成员，成员不得假设库是干净的（造数用唯一名字）。
//     S3c 结束时 SERVICE_MEMBERS 为空：本批不把任何现有成员登记为需服务。#106 S6b 起登记一项（verify-html-fingerprint-e2e，只读的页面指纹检查）。
//   测试接缝（只给自检用，正常运行不传）：runFamily 的第二个参数 io.runBatch 可以换成被测的批跑核心（自检变异用）。
'use strict';
const fs = require('fs');
const path = require('path');
const { runBatch: defaultRunBatch } = require('./lib/test-batch');

const serverRoot = path.resolve(__dirname, '..');

/** 静态守卫（不起服务）：FAMILY 行之后逐个跑，`GUARD <name> OK|RED` */
const GUARDS = ['verify-unify-static', 'verify-badge-alias', 'verify-shared-css-cache-bust', 'verify-collab-validation-status-coverage', 'verify-db-connections-writers', 'verify-it-ledger-panel-static', 'verify-test-isolation-static'];   // #106 S4a：最后一个 = 全目录测试隔离静态守卫（登记表 + 未迁移基线只减不增；自检套件 verify-test-isolation-static-suite 是下面成员表里的普通成员）

/** 需服务成员的登记位置（见文件头注释「登记『需服务』成员」）。S3c 结束时为空；#106 S6b 起恰一项：verify-html-fingerprint-e2e（只读，共享实例；verify-test-batch-suite 的 U.2 钉的就是这一项） */
const SERVICE_MEMBERS = [
  { label: 'verify-html-fingerprint-e2e', needsService: true },
];

const SERVICE_REG_KEYS = ['label', 'needsService', 'exclusive', 'resources', 'timeoutMs'];

/**
 * 把需服务登记按 label 套到成员表上：在原位置替换需服务属性（顺序不变），不追加；label 不存在 / 字段不合法 / 同一 label 登记两次 → 抛错。返回新数组，不改入参。
 */
function applyServiceMembers(members, registrations) {
  const out = members.slice();
  const seen = new Set();
  registrations.forEach((reg, i) => {
    if (reg === null || typeof reg !== 'object' || Array.isArray(reg)) throw new Error(`SERVICE_MEMBERS #${i} 必须是对象`);
    for (const k of Object.keys(reg)) {
      if (!SERVICE_REG_KEYS.includes(k)) throw new Error(`SERVICE_MEMBERS #${i}（${reg.label}）有不接受的字段 ${JSON.stringify(k)}（迁移登记只接受 ${SERVICE_REG_KEYS.join(' / ')}；成员的 rel / args 留在成员表里）`);
    }
    if (typeof reg.label !== 'string' || reg.label === '') throw new Error(`SERVICE_MEMBERS #${i} 缺少 label`);
    if (seen.has(reg.label)) throw new Error(`SERVICE_MEMBERS 同一个 label 登记了两次：${reg.label}`);
    seen.add(reg.label);
    const at = out.findIndex((m) => m.label === reg.label);
    if (at < 0) throw new Error(`SERVICE_MEMBERS 登记的 label 不在成员表里：${reg.label}（先在 buildFamilyMembers 里加这个成员，或核对 label 拼写）`);
    const props = Object.assign({}, reg);
    delete props.label;
    out[at] = Object.assign({}, out[at], props);
  });
  return out;
}

/**
 * 成员表（顺序即运行顺序）。返回 { members, bannerLabels }：bannerLabels = 失败时先打印 `===== RED <label> (exit=<n>) =====` 横幅的成员（verify-sys-* 自动扫描的那些，与旧行为一致）。
 * serviceMembers 缺省取 SERVICE_MEMBERS（自检传别的登记表来验证迁移写法）。
 */
function buildFamilyMembers(root, serviceMembers) {
  const base = root === undefined ? serverRoot : root;
  const members = [];
  const bannerLabels = new Set();
  const add = (label, rel, args) => members.push({ label, rel, args: args || [] });
  const scripts = (name) => path.join('scripts', `${name}.js`);

  const familyFiles = fs.readdirSync(path.join(base, 'scripts'))
    .filter((f) => /^verify-sys-.*\.js$/.test(f))
    .sort()
    .map((f) => path.join('scripts', f));
  for (const f of familyFiles) { add(f, f); bannerLabels.add(f); }
  // C12: all ledger invariants/actions share one explicitly registered FAMILY member.
  add('verify-it-ledger --matrix', path.join('scripts', 'verify-it-ledger.js'), ['--matrix']);
  add('verify-it-reconcile', path.join('scripts', 'verify-it-reconcile.js'));
  // #95: loopback fixtures must bind through scripts/lib/listen-safe-port.js (helper self-check + static no-listen(0) guard).
  for (const name of ['verify-listen-safe-port', 'verify-no-listen-zero']) add(name, scripts(name));
  // #106 S4-x：test-env 收尾助手 finish(code) 的自检（进程内接缝 + 父进程假服务 / 临时库的真实子进程，不起测试实例、不碰业务库，约 10 秒）。
  add('verify-test-env-finish', scripts('verify-test-env-finish'));
  // #106 S1a：运行模式判定（纯判定单测）+ 隔离实例启动与拒启（自起隔离测试实例，临时库与随机端口，不碰业务库与 3000）。
  // #106 S1b：外部调用闸门 / 隔离库准备（verify-instance-external，进程内，不起服务）；外部调用闸的集成段在 verify-instance-startup 第 5 段。
  // #106 S2-0：代码读取的 system_configs 键集合 = 非钉钉配置白名单 ∪ 钉钉四键（verify-instance-config-keys，acorn 扫描源码；该脚本一次调用内含自测，纯 node 不起服务）。
  for (const name of ['verify-instance-mode', 'verify-instance-external', 'verify-instance-config-keys', 'verify-instance-startup']) add(name, scripts(name));
  // #106 S2a：线路登记表与状态锁（scripts/lines/state.js：sqlite3 BEGIN EXCLUSIVE 状态锁与线级锁、代次、原子替换、并发与强杀自检；
  //   全部在 os.tmpdir() 下的临时控制根里跑，不碰真实控制根，约 20 秒）。
  // #106 S2b：建线 / 删线（scripts/lines/line-new.js、line-remove.js）。入口是监督进程，自带截止与进程树回收（回收失败也保证非零退出），
  //   套件只在 os.tmpdir() 下自建的临时仓库与临时控制根里建线删线，不碰真实仓库与 E:/sdh-lines，约 4–5 分钟。
  // #106 S2c：启停 / 列表 / 重叠 / 依赖检查 / 恢复（scripts/lines/line-run.js、line-proc.js）。与 S2b 共用 lines-test-supervisor.js，
  //   另按登记文件回收 detached 替身服务（只认 PID + 精确创建时间，回收有总截止）；只在临时目录建线、用槽位端口 3100–3300 起替身，约 5–6 分钟。
  // #106 S7：line merge（scripts/lines/line-merge.js + line.js 接线）。单文件自检，不经监督进程；只在 os.tmpdir() 下自建的临时仓库 / 控制根 / 线目录根里运行 line.js merge，
  //   不碰真实仓库、不读 .env、不开业务库、不起服务；约一分钟。
  // #106 S3a：临时实例启动器 scripts/lib/test-instance.js + 汇总就绪接口 GET /api/health/ready（verify-test-instance）。入口同样经共享监督进程（不启用登记回收：
  //   服务由启动器以非 detached 方式拉起，作业对象保证套件被杀时服务一并结束，「父进程被强杀后服务消失」套件内用真实强杀证明）；套件把 TEMP/TMP 指向私有临时根，
  //   只用自建合成来源库，起真服务约 6 次（端口 20000–49999 随机，不碰 3000），实测约 108 秒（含监督进程自检）。
  // #106 S3b：测试入口助手 scripts/lib/test-env.js + 共享夹具 scripts/_test-fixture.js（基于 test-env）+ 已改造脚本的静态守卫（verify-test-env）。入口同样经共享监督进程（不启用登记回收）；
  //   只用自建合成来源库与合成「检出」目录，被测服务是私有根里的桩服务（只应答 /api/version、/api/health/ready 与路径回显），套件进程的 sqlite3 路径守卫保证不打开私有根之外的库；
  //   不读 .env、不碰 3000。S3b 的 9 个代表脚本里，8 个已迁移（受套件 H 节静态守卫保护），第 9 个（verify-model-list-extras.js）只评估未改、不在守卫范围；
  //   这些脚本本身需要本地库快照 + 真 server.js，不在 FAMILY 里跑（它们是迁移样板，S4 批量迁移后另行登记）。
  // #106 S3c：批跑核心 scripts/lib/test-batch.js + 通用入口 scripts/run-test-batch.js + 共享回收模块 scripts/lib/test-reap.js（verify-test-batch）。入口同样经共享监督进程，并启用登记回收与 detached 夹具自检
  //   （桩成员 / 孙进程先登记再做别的事；登记同时写套件自己的登记文件和监督进程的登记文件）；只用自建合成来源库、桩服务与桩成员脚本，套件进程与辅助进程装同一个预加载守卫
  //   （sqlite3 路径守卫 + 私有根外 .env 读取守卫）保证不打开私有根之外的库、不读真实 .env；实例与进程统一登记，最外层按身份回收，删私有根前过闸门。
  // #106 S4a：全目录测试隔离静态守卫的自检（verify-test-isolation-static-suite，纯 node、内存合成文件 + 私有临时目录，约数秒）；守卫本体在 GUARDS。
  for (const name of ['verify-lines-state', 'verify-lines-new-remove', 'verify-lines-run', 'verify-lines-merge', 'verify-test-instance', 'verify-test-env', 'verify-test-batch', 'verify-test-isolation-static-suite']) add(name, scripts(name));
  // #106 S4e-2：验收批跑清单与 MIGRATED 登记的防漂移校验（纯 node，约 1 秒）。
  for (const [label, rel, args] of [
    ['verify-test-acceptance-batch', 'verify-test-acceptance-batch.js', []],
    ['verify-test-acceptance-batch --self-test', 'verify-test-acceptance-batch.js', ['--self-test']],
  ]) add(label, path.join('scripts', rel), args);
  // #106 S6a：HTML 缓存串注入中间件 utils/html-asset-fingerprint.js 的自检（进程内 express + 系统临时目录下含「中文 空格」的临时 publicDir，回环端口经 listenOnSafePort；
  //   static 段取 server.js 原文在 vm 里执行；不起 server.js、不碰库，约数秒）。
  add('verify-html-asset-fingerprint', scripts('verify-html-asset-fingerprint'));
  // #106 S6b：页面缓存串静态守卫（GUARDS 里的 verify-shared-css-cache-bust，无参）的 --self-test（临时目录与内存里的正反例，纯 node，约数秒）；
  //   与隔离实例上的真实页面检查（verify-html-fingerprint-e2e：逐页核对指纹 = 磁盘字节 sha256 前 12 位、强 ETag、304、别名；只读，登记为共享实例的需服务成员，见下面 SERVICE_MEMBERS）。
  add('verify-shared-css-cache-bust --self-test', scripts('verify-shared-css-cache-bust'), ['--self-test']);
  add('verify-html-fingerprint-e2e', scripts('verify-html-fingerprint-e2e'));
  // #106 S13（W6）：server.js 止增长守卫——端点数 / 建表数 / 几种绕过写法的计数必须恰好等于基线（多了判红提示放 routes/<模块>/，少了判红棘轮提示调低基线）；
  //   本体只 readFileSync 一次 server.js 原文做正则计数（不读 git / 不起服务 / 不开库 / 不起进程）；--self-test 在内存里对原文做加一处 / 删一处 / 换行尾 / 空文件变异，约 1 秒。不进 GUARDS（verify-test-batch-suite U.3 钉死 7 个名字）。
  add('verify-server-js-growth', scripts('verify-server-js-growth'));
  add('verify-server-js-growth --self-test', scripts('verify-server-js-growth'), ['--self-test']);
  // #106 S8a（W10）：部署备份脚本 scripts/deploy/backup-db.js（VACUUM INTO + 校验 + link 发布）与发布记录 scripts/deploy/release-record.js 的自检。
  //   全部在 os.tmpdir() 下自建夹具库与目录，子进程跑被测脚本，不碰业务库 / 备份目录 / 真实控制根，不读 .env，不起服务；含 46 个变异自证（临时副本上改被测脚本，四路并发；每个变异登记期望变红的用例名前缀，须命中；个数由自检与 MUTATIONS 条数核对）。
  add('verify-deploy-backup', scripts('verify-deploy-backup'));
  // #106 S8b（W10）：部署就绪检查 scripts/deploy/ready-check.js 的自检。进程内假服务器（listenOnSafePort 取 20000–49999，不起真实实例，不碰业务库 / .env / 生产地址），
  //   子进程跑被测脚本，临时 git 仓库与目录都在 os.tmpdir() 下；含 45 个变异自证（临时副本上改被测脚本，三路并发、子进程总数有上限；每个变异登记期望变红的具体断言名前缀，须命中，运行故障不计检出；含对演练脚本源文件检查的 5 个内存变异）。演练脚本 drill-deploy-failures.js 本身依赖本机的生产备份文件，不进 FAMILY（只有它导出的源文件检查函数在这里用假目录树验证）。
  add('verify-deploy-ready-check', scripts('verify-deploy-ready-check'));
  // #106 S8c（W10）：部署脚本 scripts/deploy-ssh.ps1（新顺序 + -DryRun + 失败处置）的自检。静态断言（BOM / CRLF、ssh / scp 只在两个调用口函数体内、pm2 只操作 task-pool、reset --hard 按提交号、写操作顺序、DryRun 守卫）
  //   + 单元（协议行判定 / 参数引用 / pm2 jlist 经 node 解析，取自被测脚本的纯函数）+ 动态：`powershell.exe -NoProfile -File scripts/deploy-ssh.ps1 -DryRun -RemoteStateFile <临时 json> -SkipPushCheck [-DryRunFailAt …]`，
  //   子进程 PATH 里没有 ssh / scp、TEMP 指向私有临时目录，不连生产、不碰业务库、不读 .env；被测脚本副本放在临时 git 夹具仓库的 scripts/ 下（无远端），进程当前目录是另一个同结构的诱饵仓库（验证仓库根取脚本自身位置）；「不带 -DryRun 的专用参数必须拒绝」用例（唯一不带 -DryRun 的运行）三重隔离：脚本副本不在任何 git 仓库里 + PATH 只留 node 与 System32（无 git / ssh / scp）+ -ServerIP 192.0.2.1，缺一重这一节不跑；隔离门（D0 / R0）先于任何会起部署脚本子进程的段：任一隔离条件不成立就整体中止（动态、单元、变异都不进入，输出 ABORT 隔离不成立，退出码非 0），自检里有「PATH 目录放假 ssh.exe -> 零子进程」的用例，覆盖 --only=poison（动态）、--only=unit、--only=static（变异默认开启）三个入口，单元与变异入口至少过轻量隔离门；所有动态用例都显式 -ServerIP 192.0.2.1；会跑部署脚本的变异，其副本里的远端执行换成本地桩（桩替换必须真的发生，否则不跑）；含 74 个变异自证（临时副本上改被测脚本，三路并发；每个变异登记期望变红的用例名前缀，须命中，动态用例的命中还要求该次运行走过第 0 步、输出含 [2/9]，否则记 RED-BUT-NOT-TARGET；个数由自检的 MUTATIONS 条数核对）。第 5 / 8 步判定抽成纯函数，单元用例按真实退出码造输入。pm2 jlist 的真实形态（>30 KB 单行、中文、反斜杠、有无 [PM2] 前缀行、CRLF，含控制台输入代码页 65001 下 stdin 开头被 .NET 多写 BOM）经「假 ssh（node 脚本）」走完整调用链；动态用例里有一个像 PowerShell 工具那样 -Command 调用的 DryRun（不带 -RemoteStateFile）。单元里改控制台输入代码页的试验在 finally 里还原。
  //   每个动态用例起一次 powershell 与若干 node / git 子进程，整套约数分钟。
  add('verify-deploy-script', scripts('verify-deploy-script'));
  // #77 C1a: 验收判定统一服务 + 脚本比较 + 恢复 API（config_rev 记账）——显式登记为 FAMILY 成员（纯 node，不起服务）。
  // #77 C1b: 迁移脚本（config_rev 保守回填）同样登记在此，夹具库自建自删，纯 node。
  for (const name of ['verify-model-acceptance', 'verify-model-script-compare', 'verify-model-restore-api', 'verify-model-config-rev-migration']) add(name, scripts(name));
  // #77 C1c: data_models 写入点分类守卫（基线 + --self-test 变异自证各跑一次）与 config_rev HTTP 级性质断言（自起隔离实例，含两例变异自证）。
  for (const [label, rel, args] of [
    ['verify-model-write-classification', 'verify-model-write-classification.js', []],
    ['verify-model-write-classification --self-test', 'verify-model-write-classification.js', ['--self-test']],
    // #77 C1 对抗审 R3：model_test_records 只追加、失效单向（confirm 归档条件写的失效计数条件依赖它）——守卫 + 变异自证
    ['verify-model-test-records-append-only', 'verify-model-test-records-append-only.js', []],
    ['verify-model-test-records-append-only --self-test', 'verify-model-test-records-append-only.js', ['--self-test']],
    ['verify-model-config-rev-http', 'verify-model-config-rev-http.js', []],
    // #77 C2a：table_comment 拆分迁移脚本（建议规则 / apply / 幂等 / revert / 真实库拒绝），夹具库自建自删，自起隔离实例
    ['verify-model-table-comment-migration', 'verify-model-table-comment-migration.js', []],
    // #77 C2a 修复：Model_Center.html「实现说明」前端绑定最小静态契约（输入框 / 编辑回填 / 新建清空 / 提交载荷）+ 内存变异自证
    ['verify-model-impl-note-ui-static', 'verify-model-impl-note-ui-static.js', []],
    ['verify-model-impl-note-ui-static --self-test', 'verify-model-impl-note-ui-static.js', ['--self-test']],
    // #77 C2b-1：实现对象两表 + API + 校验 + 权限 + 请求体上限 + 整组替换（自起隔离实例，夹具库自建自删，约 1–2 分钟）
    ['verify-model-impl-objects', 'verify-model-impl-objects.js', []],
    // #77 C2b-2：norm_v1 规范化 + 三端核验（落库三态 / 参数化 / 徽章降级 / 记账 / 调度）+ C2b-1 审查遗留三项；进程内夹具库 + 桩读取器，不连任何 SQL Server
    ['verify-model-impl-verify', 'verify-model-impl-verify.js', []],
    ['verify-model-impl-verify --self-test', 'verify-model-impl-verify.js', ['--self-test']],
    // #77 C2b-3：/relations 关系接口 + 列表 rel 计数 + findDownstreamCandidates 改前改后对拍 + 上游两端一致性对拍（自起隔离实例，约 1 分钟；--self-test 逐个变异起实例，约 12 分钟）
    ['verify-model-relations', 'verify-model-relations.js', []],
    ['verify-model-relations --self-test', 'verify-model-relations.js', ['--self-test']],
    // #77 C4-api：列表追加字段（stages / prevResult / impl_obj_names）+ 同源对拍 + 出错路径 + SQL 条数（自起隔离实例；--self-test 逐个变异起实例）
    ['verify-model-list-extras', 'verify-model-list-extras.js', []],
    ['verify-model-list-extras --self-test', 'verify-model-list-extras.js', ['--self-test']],
    // #77 C3a-0：脚本生成器全文基线（vm 零 DOM 加载页面里的生成器，夹具 × 输出类型全文逐字相等；对拍全绿后接着做判别力自测：对生成器源码做 3 个诚实变异，各自必须判红）。纯 node，不起服务
    ['verify-model-script-gen-golden', 'verify-model-script-gen-golden.js', []],
    // #77 C3a：脚本生成器单一源静态守卫（页面引用共享库 + 页面不再定义库导出名 + 解构名 ⊆ 库导出）+ 三个诚实变异自证
    ['verify-model-script-gen-single-source', 'verify-model-script-gen-single-source.js', []],
    ['verify-model-script-gen-single-source --self-test', 'verify-model-script-gen-single-source.js', ['--self-test']],
    // #77 C3b：目录页 / 配置台两页各留一份的共用函数同源断言（SAME：userCanEditModel / copyToClipboard / loadRegDomainOptions / 行号高亮家族，acorn token 序列逐个相等，忽略空白与注释）+ #77 C4a 的 ⑥ catalog 标签存在 / 位置 / 属性、⑦ catalog 顶层名与内联 / app.js 不撞名 + 变异自证
    ['verify-model-page-shared-functions', 'verify-model-page-shared-functions.js', []],
    ['verify-model-page-shared-functions --self-test', 'verify-model-page-shared-functions.js', ['--self-test']],
    // #77 C4a P22：权限判断 ID 类型混用真值表（两页 userCanEditModel / 目录页 userCanValidateModel）+ 静态接线 + 变异自证
    ['verify-model-permission-id-types', 'verify-model-permission-id-types.js', []],
    ['verify-model-permission-id-types --self-test', 'verify-model-permission-id-types.js', ['--self-test']],
    // #77 C4b-1：目录纯函数核心 model-catalog-core.js（分组 / 命中 / 排序 / 按组分页 / §3.4 事件函数 + 上游名与后端同源 + 两端加载一致 + 搬入件逐字）+ 变异自证（子进程带超时）。纯 node，不起服务
    ['verify-model-catalog-core', 'verify-model-catalog-core.js', []],
    ['verify-model-catalog-core --self-test', 'verify-model-catalog-core.js', ['--self-test']],
    // #77 C4c-0a：目录纯函数核心扩展件（扩展排序键 / 新筛选 / railCounts / listFailed / 显示映射）手写期望 + 12 个变异自证（子进程）。纯 node，不起服务
    ['verify-model-catalog-core-ext', 'verify-model-catalog-core-ext.js', []],
    ['verify-model-catalog-core-ext --self-test', 'verify-model-catalog-core-ext.js', ['--self-test']],
    // #77 C3c：16 页导航 +「模型配置台」项（含配置台自身）的静态守卫：页面集合双向清单 / 紧跟「模型中心」 / 逐字相等 / 高亮归属 + 变异自证（git ls-files 取文件集合）
    ['verify-model-workbench-nav-static', 'verify-model-workbench-nav-static.js', []],
    ['verify-model-workbench-nav-static --self-test', 'verify-model-workbench-nav-static.js', ['--self-test']],
    // #77 末次合并审（codex 46 / 48 / 49 / 50）：内联事件处理器语法守卫（静态 HTML 属性与 JS 字面量里拼出的处理器按所在字面量类型读取；标签模板按语法树 ∪ 词法判定）+ 变异自证。纯 node，不起服务（§9 P50 ⑬：S末 接入 FAMILY）
    ['verify-inline-handler-syntax', 'verify-inline-handler-syntax.js', []],
    ['verify-inline-handler-syntax --self-test', 'verify-inline-handler-syntax.js', ['--self-test']],
  ]) {
    add(label, path.join('scripts', rel), args);
  }
  // 需服务成员（S4 登记，见文件头注释）：按 label 原位置替换需服务属性
  return { members: applyServiceMembers(members, serviceMembers === undefined ? SERVICE_MEMBERS : serviceMembers), bannerLabels };
}

/**
 * 跑一份成员表 + 守卫表，输出契约格式：
 *   失败成员立即打印输出（verify-sys-* 先打印 `===== RED <label> (exit=<n>) =====` 横幅）→ `FAMILY PASS=<n> FAIL=<n>[ FAILED: <label> ...]` → 起过实例时一行 TEST_INSTANCES → 每守卫一行 `GUARD <name> OK|RED (exit=<n>)`（RED 的再打印输出）。
 * 批跑核心自身的失败（实例停止失败等）作为 `test-batch(...)` 条目计入 FAIL。返回退出码（0 = 成员与守卫全绿）。
 * spec = { members, bannerLabels, guards }；io = { print(line), batchOptions, runBatch }（print 默认 console.log；batchOptions 传给 runBatch，自检用它指向合成来源；
 * runBatch 是**只给自检用的批跑核心注入接缝**，默认用本文件 require 的 lib/test-batch.js，自检用它把变异过的核心接进来）。
 */
async function runFamily(spec, io) {
  const print = (io && io.print) || ((line) => console.log(line));
  const batchOptions = (io && io.batchOptions) || {};
  const runBatch = (io && io.runBatch) || defaultRunBatch;
  const bannerLabels = spec.bannerLabels || new Set();
  const noteLines = (r) => { for (const n of r.notes) print(`[批跑] ${r.label}：${n}`); };
  const batch = await runBatch(spec.members, Object.assign({}, batchOptions, {
    onResult: (r) => {
      if (r.ok) return;
      if (bannerLabels.has(r.label)) print(`\n===== RED ${r.label} (exit=${r.status}) =====`);
      noteLines(r);
      print(r.out);
    },
  }));
  const failed = batch.failed.slice();
  for (const e of batch.errors) failed.push(`test-batch(${e.split('：')[0]})`);
  print(`FAMILY PASS=${batch.pass} FAIL=${failed.length}${failed.length ? ' FAILED: ' + failed.join(' ') : ''}`);
  if (batch.instancesLine !== null) print(batch.instancesLine);
  if (batch.errors.length) for (const e of batch.errors) print(`[批跑] ${e}`);

  let guardRed = 0;
  const guardBatch = await runBatch((spec.guards || []).map((g) => ({ label: g, rel: path.join('scripts', `${g}.js`) })), Object.assign({}, batchOptions, {
    onResult: (r) => {
      if (r.ok) { print(`GUARD ${r.label} OK`); return; }
      guardRed++;
      print(`GUARD ${r.label} RED (exit=${r.status})`);
      noteLines(r);
      print(r.out);
    },
  }));
  return failed.length === 0 && guardRed === 0 && guardBatch.errors.length === 0 ? 0 : 1;
}

async function main() {
  process.chdir(serverRoot);
  const { members, bannerLabels } = buildFamilyMembers();
  const code = await runFamily({ members, bannerLabels, guards: GUARDS }, {});
  process.exit(code);
}

if (require.main === module) {
  main().catch((e) => { console.log(`FAMILY 驱动异常：${e && e.stack ? e.stack : e}`); process.exit(1); });
} else {
  module.exports = { buildFamilyMembers, applyServiceMembers, runFamily, GUARDS, SERVICE_MEMBERS };
}
