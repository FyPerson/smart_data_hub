// scripts/backfill-sys-dev-assignee-round.js — D 组件①：sys_issue_dev_assignees.round_no 存量回填
//   （2026-08-12·二轮预筛 MED-1/MED-2 收口重做①②两级算法·codex 355 三轮插入批 M1 修同秒边界）
//
// 背景：round_no 是 D 组件①新增列（ALTER 追加，见 routes/sys-iteration/index.js runSysMigration），
//   服务端全部 7 个 INSERT INTO sys_issue_dev_assignees 写点已同步写入（路径 A 写侧物化）。但 ALTER 前
//   已存在的存量行该列天然为 NULL——本脚本对这些存量行做一次性历史回填，不影响任何在线写路径。
//
// 算法（三级）：
//   ① 活跃行（removed_at IS NULL）——**不是**单一精确公式，三级判定：
//      (a) issue 当前 return_count+reopen_count=0 → 该单从未打回/重开过，活跃行必然是"从未被
//          remove+re-add 机制惊动过"的首轮实例，round_no=1，精确无歧义。
//      (b) 计数>0 → 用该 dev_assignee_id 在 sys_issue_dev_events 中**最早**的 add/re-add 事件做
//          "创建锚"，按锚事件类型分两条子路径（codex 355 三轮插入批 M1 修同秒边界，见下方踩坑说明）：
//          (b-i) 锚事件本身就是**干净的自动 re-add**（有 superseded_dev_assignee_id 链且 trigger 非
//                backfill_deadlock）→ 它就是②链式匹配"新实例"分支的同一个事件，直接复用 chain-exact
//                同款 ordinalOf（用 `<=` 比较，天然不受同秒边界影响）；
//          (b-ii) 锚事件是普通 add（原始成员）/ 手工 re-add（无 superseded 链）/ 被污染的 backfill_deadlock
//                re-add → 维持严格早于（`<`）锚点的计数公式，但若锚事件与某次 return/reopen timeline
//                事件**同秒**，秒级精度分不清谁先谁后，不再 confident 出一个值，改判 AMBIGUOUS 并给出
//                两个候选（早于/晚于该次打回两种可能对应的轮次）。
//      ⚠️ 已知踩坑二（codex 355 三轮插入批 M1）：v2 首版对 (b) 全程用严格 `<`，未考虑"自动 re-add 与其
//      触发的 return/reopen timeline 事件同一事务写入、created_at 常同秒"这个高频场景——若锚事件恰是
//      这类 re-add 且与触发它的那次打回同秒，严格 `<` 会把那次打回排除在计数外，少算一轮（新实例被
//      误判成"上一轮"）。v3 拆出 (b-i)：锚若本身是干净 re-add，直接复用②的 ordinal 逻辑（本就用 `<=`，
//      不受同秒影响）；(b-ii) 保留给"锚不享有同事务强绑定关系"的其余情形，且专门检测同秒边界改判
//      AMBIGUOUS，不再对这类边界场景假装精确。
//      (c) 计数>0 且该 dev_assignee_id 在 sys_issue_dev_events 里查不到任何 add/re-add 事件（如迁移
//          回填路径 :1862 一带生成的历史主开发行——那条 INSERT 不配套写事件；或 supersede-excuse
//          产生的新行——该端点写的事件 action='supersede-excuse' 且 dev_assignee_id 挂在**旧行**上，
//          新行没有专属的 add/re-add 事件）→ 无法定位创建锚，判 AMBIGUOUS，仍给出"按 issue 当前计数"
//          的建议值供参考，但明确标注不保证准确，需人工核对该行实际创建于哪一轮。
//   ⚠️ 已知踩坑（v1→v2 修复说明，2026-08-12 二轮预筛 MED-1）：v1 版本对**全部**活跃行一律用"issue
//   当前 return_count+reopen_count+1"，这是把"打回/重开必然同步 remove+re-add"这条 v1.151.1 之后
//   才成立的写侧不变量，反向套到了 v1.151.1 之前创建、从未被该机制触碰过的存量活跃行上——这类行
//   完全可能在 count=0 时创建，此后原地跨越若干轮 return/reopen（当时机制尚不存在，不会被自动
//   remove+re-add）存活至今，用当前计数会系统性高估其轮次。v2 拆三级正是为了不再对活跃行做这个
//   错误的写侧语义外推。
//
//   ② 历史行（removed_at 非空）——优先走**引用链精确匹配**：
//      sys_issue_dev_events 里 action='re-add' 且 payload_json.superseded_dev_assignee_id 非空的事件。
//      ⚠️ 如实描述（v1→v2 修复说明，2026-08-12 二轮预筛 MED-2）：v1 版注释声称这个 payload 形状是
//      v1.151.1 自动重开一轮机制的"唯一写入形状"、"100% 来自"该机制——这个表述不准确。该形状目前
//      有**两个写者**：
//        · 主写者 = v1.151.1 打回自动重开一轮（routes/sys-iteration/index.js :3918 一带 `if (action
//          === 'return' || action === 'reopen')` 块），created_at 与触发它的 return/reopen timeline
//          事件同一事务写入，可反查出精确的具体某一次打回/重开——本算法②的核心依赖，对这类事件成立。
//        · 第二写者 = scripts/backfill-sys-deadlock-reopen-round.js（存量死锁修复脚本，:236-243，
//          payload.trigger='backfill_deadlock'，生产 #23 已实跑过），它的 created_at 是**人工跑脚本
//          补写的时刻**，不是真实打回/重开发生的时刻——若仍按"同事务写入、created_at 极接近"的假设
//          去反查"具体是第几次打回"，会把判定安在错误的 timeline 事件上（补写可能发生在真实触发事件
//          很久之后，中间甚至可能已经又打回过一轮）。
//      故本算法对 `payload.trigger === 'backfill_deadlock'` 的 re-add 事件**不作为②的精确链证据**，
//      统一退化到③的时间对齐推算（仍在输出里显式标注"该行在 backfill_deadlock 记录里出现过"，供人工
//      用真实业务背景核对，而不是假装算法能精确算出轮次）。
//        · 新实例（事件的 dev_assignee_id）→ round_no = 该 timeline 事件在本单 return/reopen 事件序列
//          中的序号（1-indexed）+ 1
//        · 旧实例（payload.superseded_dev_assignee_id 指向的行）→ round_no = 该序号本身（不 +1）
//   ③ 无法通过①②精确解出——时间对齐推算：round_no = 该单 return/reopen timeline 事件中 created_at
//      严格早于锚点（历史行=removed_at；①(b) 活跃行=最早 add/re-add 事件 created_at）的条数+1，标记
//      AMBIGUOUS 供人工复核。
//
// ⚠️ 已知踩坑三（codex 357 二轮预筛 HIGH-1/HIGH-2，2026-08-12）：
//   HIGH-1（同秒区间化）——(b-i)/②两处置信 ordinal 路径（active-anchor-chain :244 一带、chain-exact
//   asOld/asNew :308/:319 一带）都依赖 ordinalOf 的 `<=` 秒级比较：若被匹配到的那条 timeline 事件所在
//   秒还有其它 N-1 条 return/reopen 事件（同一 issue 同秒发生 >1 次打回/重开——高并发/批量补录场景并
//   非不可能），秒级精度分不清锚事件/re-add 事件到底对应这 N 条里的哪一条，`<=` 恒定匹配到该秒里排序
//   最后的那一条，往高处偏——继续假装 confident 会系统性高估轮次。修法：三处得出 ord 后统一调用
//   sameSecondClusterBounds(ord) 求出 ord 所在同秒集群的边界 [firstPos, lastPos]（lastPos 恒等于 ord
//   本身），N=lastPos-firstPos+1；N>1 时降级 AMBIGUOUS（method 加 `-tie` 后缀：active-anchor-chain-tie
//   / chain-exact-tie），给出候选区间 [candidateMin, candidateMax]（区间宽度=N，对应"锚/re-add 事件在
//   该秒集群里所有可能相对位置"分别映射到的轮次范围）；N=1 时维持 confident，行为与改动前一致。
//   HIGH-2（APPLY 默认只写 confident 行 + 显式歧义人工核准通道）——plan 每行统一带 candidateMin/
//   candidateMax（confident 行两者恒等于 roundNo，ambiguous 行是真实候选区间或单点猜测值）；--apply
//   默认只写 ambiguous=false 的行，ambiguous 行打印「人工处理清单」（不写库）；新增 --apply-ambiguous
//   "id=round,id=round" 参数，供人工核实候选区间内的真实值后显式指定写入——id 必须在本次 plan 内、
//   必须 ambiguous=true（confident 行不许走这条通道）、round 必须落在该行 [candidateMin,candidateMax]
//   闭区间内且为正整数，任一 id=round 对不满足即**整体拒绝执行**（fail-closed：这次 --apply 运行的
//   confident 行也不写，宁可整体重跑，也不接受"部分校验失败仍写了一半"这种含糊状态）。
//
// ⚠️ 已知踩坑四（codex 358 复审 3M/1L，2026-08-12）：
//   M1（同秒判定按秒归一化）——sameSecondClusterBounds/sameSecondTimelineEvents 此前用 created_at
//   字符串完全相等（===）识别"同秒"；两表当前写入路径均是 datetime('now','localtime') 秒级 19 字符
//   格式，通常不会踩到，但若未来出现精度漂移（手工造数据/迁移脚本/不同调用路径带了小数秒），同一秒但
//   精度不同的两行字符串不相等，会漏判本该判定的同秒歧义，误判为"无歧义"继续走 confident。修法：新增
//   normSec()，比较前统一截断到前 19 位再比较——对现状（本就 19 字符）是纯 no-op，仅在精度漂移场景下
//   生效；ordinalOf 的 `<=` 排序比较、kExclusive/k 的 `<` 计数比较一并归一化（否则同一处判定里一部分
//   走归一化等值、另一部分走原始字符串比较，两套口径不一致会重新制造出双计数/漏计数的缝隙）。
//   M3（--apply-ambiguous 事务内重建校验，防并发漂移）——此前 plan 只在 BEGIN IMMEDIATE 之前构建一次，
//   --apply-ambiguous 的语义校验、以及 confident 行的写入值，都用的是这份"锁外"旧 plan；若在 plan
//   构建完成到拿到写锁之间发生并发写入（新 return/reopen 事件、新 round_no IS NULL 行等），旧 plan 里
//   人工核实过的候选区间可能已经过期，继续按旧 plan 写入就是拿着过期证据往库里落数据。修法：拿到写锁
//   （BEGIN IMMEDIATE）之后重新调用 buildPlan() 得到事务内的权威 plan，用 diffPlans() 与锁外旧 plan
//   逐行比对（method/roundNo/candidateMin/candidateMax/ambiguous 任一字段漂移，或 id 集合本身变化），
//   任何漂移一律整体 ROLLBACK 拒绝（提示重新 dry-run）；--apply-ambiguous 的语义校验也在事务内重建的
//   plan 上独立重跑一遍（防御性双重校验，即便理论上 diffPlans 已保证一致）；写入循环同样改用事务内
//   重建的 plan，不再使用锁外旧 plan 的任何数值。
//   L1（--apply-ambiguous 参数解析收紧）——重复出现该参数、值中出现空项（连续逗号/首尾多余逗号）、
//   命令行里出现未识别的多余参数，此前均被静默吞掉或只取第一个匹配，现改为一律显式报错退出。
//
// 用法：
//   node scripts/backfill-sys-dev-assignee-round.js                # dry-run（默认，只打印不写）
//   node scripts/backfill-sys-dev-assignee-round.js --apply        # 真写（单事务，失败整体回滚）
//   node scripts/backfill-sys-dev-assignee-round.js --db <path> [--apply]
//   node scripts/backfill-sys-dev-assignee-round.js --db <path> --apply --apply-ambiguous "id=round,id=round"
//   [测试专用] BACKFILL_TEST_DELAY_BEFORE_TXN_MS=<ms> 环境变量——在 BEGIN IMMEDIATE 前人为暂停，供
//   自动化测试构造"事务外 plan 构建后、拿到写锁前发生并发写入"的确定性时序（见 M3 说明），生产环境
//   从不设置该变量，对正常运行零影响。
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);

// [codex 358 L1] 参数解析收紧——逐位置显式识别已知参数（--apply 无值 / --db 单值 / --apply-ambiguous
//   单值），凡未被任何已知参数（或其值）认领的位置一律报错退出，不静默忽略；--apply-ambiguous / --db
//   重复出现也显式拒绝（不悄悄取第一个或最后一个）。
const consumed = new Array(args.length).fill(false);
let applyCount = 0, dbCount = 0, applyAmbiguousCount = 0;
let dbRawValue, applyAmbiguousRawValue;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--apply') {
    applyCount++;
    consumed[i] = true;
  } else if (a === '--db') {
    dbCount++;
    consumed[i] = true;
    const next = args[i + 1];
    // 仅在下一个 token 存在且不像另一个 flag 时才吞作值——避免 `--db --apply` 这种漏填值的写法
    // 把下一个真实 flag 错误吞掉；缺值场景留给下方统一报错，报错文案与改动前一致。
    if (next !== undefined && !next.startsWith('--')) { dbRawValue = next; consumed[i + 1] = true; i++; }
  } else if (a === '--apply-ambiguous') {
    applyAmbiguousCount++;
    consumed[i] = true;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { applyAmbiguousRawValue = next; consumed[i + 1] = true; i++; }
  }
}
const unknownArgs = args.filter((a, i) => !consumed[i]);
if (unknownArgs.length > 0) {
  console.error(`❌ 无法识别的参数：${unknownArgs.map(a => JSON.stringify(a)).join(', ')}` +
    `（已知参数仅 --apply / --db <path> / --apply-ambiguous <值>，多余的位置参数不静默忽略，请检查命令行）`);
  process.exit(1);
}
if (dbCount > 1) {
  console.error(`❌ --db 出现了 ${dbCount} 次，只允许出现一次`);
  process.exit(1);
}
if (applyAmbiguousCount > 1) {
  console.error(`❌ --apply-ambiguous 出现了 ${applyAmbiguousCount} 次，只允许出现一次` +
    `（重复不静默取第一个/最后一个，请把所有 id=round 合并进同一个参数值）`);
  process.exit(1);
}

const APPLY = applyCount > 0;
if (dbCount > 0 && dbRawValue === undefined) {
  console.error('❌ --db 缺少路径参数（或误把开关当成了路径）');
  process.exit(1);
}
const DB_PATH = dbCount > 0 ? dbRawValue : path.join(__dirname, '..', 'task_pool.db');
if (!fs.existsSync(DB_PATH)) { console.error(`db 不存在：${DB_PATH}`); process.exit(1); }

// [codex 357 HIGH-2③][codex 358 L1 收紧] --apply-ambiguous "id=round,id=round"——仅对指定 id 显式
//   写入人工核实过的取值，必须与 --apply 同时使用（AMBIGUOUS 行不参与 dry-run，也不允许脱离真实写入
//   单独"生效"）。这里先做语法级解析（格式/正整数/id 不重复/不含空项）；与 plan 相关的语义校验（id
//   是否在 plan 内、是否 ambiguous、取值是否落在候选区间）留到 plan 建好之后（见下方"--apply-ambiguous
//   语义校验"节，fail-closed；[codex 358 M3] 该语义校验事务内还会针对重建后的 plan 再做一遍）。
let applyAmbiguousPairs = null;   // [{ id, round }]，仅语法通过后非 null
if (applyAmbiguousCount > 0) {
  if (!APPLY) {
    console.error('❌ --apply-ambiguous 必须与 --apply 同时使用（AMBIGUOUS 行不参与 dry-run）');
    process.exit(1);
  }
  if (applyAmbiguousRawValue === undefined) {
    console.error('❌ --apply-ambiguous 缺少参数（格式：--apply-ambiguous "id=round,id=round"，或误把开关当成了参数）');
    process.exit(1);
  }
  applyAmbiguousPairs = [];
  const seenIds = new Set();
  const syntaxErrors = [];
  // [codex 358 L1] 不再 `.filter(Boolean)` 静默丢弃空项——连续逗号（"1=1,,2=2"）/首尾多余逗号
  //   （"1=1,"）产生的空字符串显式报错，而不是悄悄被吞掉当作"用户只写了这么多对"。
  for (const pair of applyAmbiguousRawValue.split(',').map(s => s.trim())) {
    if (pair === '') { syntaxErrors.push('参数中存在空项（连续逗号或首尾多余的逗号），请去掉多余的逗号'); continue; }
    const m = /^(\d+)=(\d+)$/.exec(pair);
    if (!m) { syntaxErrors.push(`无法解析 "${pair}"（期望 id=round，均为正整数，逗号分隔）`); continue; }
    const id = Number(m[1]), round = Number(m[2]);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(round) || round <= 0) {
      syntaxErrors.push(`"${pair}" 中 id/round 必须均为正整数`); continue;
    }
    if (seenIds.has(id)) { syntaxErrors.push(`id=${id} 在参数中重复出现`); continue; }
    seenIds.add(id);
    applyAmbiguousPairs.push({ id, round });
  }
  if (syntaxErrors.length > 0 || applyAmbiguousPairs.length === 0) {
    console.error('❌ --apply-ambiguous 参数格式非法，整体拒绝执行（fail-closed，不写入任何数据）：');
    for (const e of syntaxErrors) console.error(`   · ${e}`);
    if (applyAmbiguousPairs.length === 0 && syntaxErrors.length === 0) console.error('   · 未解析出任何有效 id=round 对');
    process.exit(1);
  }
}

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// [codex 358 M1] 秒级归一化——两表当前写入路径均为 datetime('now','localtime') 秒级格式（19 字符
//   'YYYY-MM-DD HH:MM:SS'，无小数秒），本函数是防御性收紧：若未来出现精度漂移，字符串完全相等的同秒
//   判定会漏判"同一秒但精度不同"的情形（如 '10:00:00' 与 '10:00:00.123' 实为同一秒，=== 判定为不等）。
//   所有涉及"是否同秒"或排序的 created_at 比较统一先截断到前 19 位再比较——对当前已是 19 字符的正常
//   数据是纯 no-op（slice(0,19) 等于原值），不改变任何既有行为；只在精度漂移场景下生效。
function normSec(ts) {
  return (ts === null || ts === undefined) ? ts : String(ts).slice(0, 19);
}

// [D 组件①·SD2 三轮插入批 M2b] round_no 合法性数据探针——非 NULL 的 round_no 必须是正整数，
//   查 `typeof(round_no)!='integer' OR round_no<1` 而不是只查 `<1`：SQLite 动态类型系统下，一列声明
//   为 INTEGER 仍可能因绑参数时传了字符串/浮点等而存成 TEXT/REAL affinity 失败的值（尤其本表历史上
//   有过手工改库先例），`round_no<1` 这种数值比较对非数字字符串会做隐式转换、未必如预期判定，
//   `typeof()` 是更硬的第一道闸。
async function scanIllegalRoundNo() {
  return all(`SELECT id, issue_id, round_no, typeof(round_no) AS round_no_type
                FROM sys_issue_dev_assignees
               WHERE round_no IS NOT NULL AND (typeof(round_no) != 'integer' OR round_no < 1)
               ORDER BY id ASC`);
}

// [codex 358 M3] 比较两次 buildPlan() 结果，返回人类可读的漂移描述列表（空数组=完全一致）——只比较
//   决策相关字段（method/roundNo/candidateMin/candidateMax/ambiguous），不比较 note 文案（note 是
//   纯展示性文本，给定相同输入必然确定性生成，比较它只会徒增噪音，无助于判断数据是否真的变了）。
function diffPlans(oldPlan, newPlan) {
  const oldById = new Map(oldPlan.map(p => [p.id, p]));
  const newById = new Map(newPlan.map(p => [p.id, p]));
  const drifts = [];
  for (const [id, op] of oldById) {
    const np = newById.get(id);
    if (!np) { drifts.push(`da_id=${id} 在事务内重建后消失（原 plan 有、现在没有——可能已被并发处理/删除）`); continue; }
    if (op.roundNo !== np.roundNo || op.candidateMin !== np.candidateMin || op.candidateMax !== np.candidateMax
      || op.ambiguous !== np.ambiguous || op.method !== np.method) {
      drifts.push(`da_id=${id} 漂移：method ${op.method}→${np.method} / roundNo ${op.roundNo}→${np.roundNo} / ` +
        `候选区间 [${op.candidateMin},${op.candidateMax}]→[${np.candidateMin},${np.candidateMax}] / ambiguous ${op.ambiguous}→${np.ambiguous}`);
    }
  }
  for (const [id] of newById) {
    if (!oldById.has(id)) drifts.push(`da_id=${id} 是事务内重建后新出现的行（原 plan 没有——可能是并发新增的 round_no IS NULL 行）`);
  }
  return drifts;
}

// [codex 358 M3] 构建"待回填计划"——纯读取当前 DB 状态，不做任何写入。抽成独立函数是为了能在
//   BEGIN IMMEDIATE 前后各调用一次：锁外一次用于人工审阅 dry-run 输出 / --apply-ambiguous 首轮校验，
//   锁内一次是实际写入依据的权威快照（避免使用锁外可能已过期的候选区间/roundNo，见头部注释"已知踩坑
//   四"M3）。quiet=true 时抑制逐 issue 的诊断性 console.log/warn（悬垂 issue_id / 非法 payload_json），
//   避免事务内重建时把锁外已打印过的相同信息再刷一遍造成困惑；quiet=false 时行为与改动前完全一致。
async function buildPlan(quiet) {
  const issueIds = (await all(
    `SELECT DISTINCT issue_id FROM sys_issue_dev_assignees WHERE round_no IS NULL ORDER BY issue_id`
  )).map(r => r.issue_id);

  const plan = [];   // [{ id, issueId, roundNo, candidateMin, candidateMax, method, ambiguous, note }]
  let danglingIssueCount = 0;   // [SD1 二轮预筛 LOW-4] 悬垂 issue_id 计数，供 stillNull 复验时解释成因

  for (const issueId of issueIds) {
    const iss = await get(`SELECT id, return_count, reopen_count FROM sys_issues WHERE id = ?`, [issueId]);
    if (!iss) { if (!quiet) console.log(`#${issueId} ⏭️  单据不存在（悬垂 issue_id，跳过）`); danglingIssueCount++; continue; }
    const returnCnt = Number(iss.return_count) || 0;
    const reopenCnt = Number(iss.reopen_count) || 0;
    const currentRound = returnCnt + reopenCnt + 1;
    const countIsZero = returnCnt === 0 && reopenCnt === 0;

    const nullRows = await all(
      `SELECT id, user_id, user_name, removed_at FROM sys_issue_dev_assignees
        WHERE issue_id = ? AND round_no IS NULL ORDER BY id ASC`, [issueId]);

    // return/reopen timeline 事件序列（按 created_at, id 升序——序号即"第几次打回/重开"）
    //   [D-fix2 MED-1] created_at IS NOT NULL 显式过滤——若某条 timeline 行 created_at 为 NULL（脏数据/
    //   手工改库），SQLite ORDER BY ASC 会把它排最前，混进序列里参与 ordinalOf 的 `<=` 比较必然失真
    //   （NULL 到 JS 层已是 null，`null <= 任意日期字符串` 恒 false，等于这条 NULL 事件永远排不进任何
    //   "早于/不晚于"判定——静默把它当成不存在，导致序号计数少算一轮）。改为显式排除 + 计数，被排除
    //   的事件数非 0 时下方对本单全部回填行强制降级 AMBIGUOUS（见下方 excludedNullCreatedAtCount 消费点）。
    const timelineEventsAll = await all(
      `SELECT id, created_at FROM sys_issue_timeline
        WHERE issue_id = ? AND event_type IN ('return','reopen') ORDER BY created_at ASC, id ASC`, [issueId]);
    const timelineEvents = timelineEventsAll.filter(e => e.created_at !== null && e.created_at !== undefined);
    const excludedNullCreatedAtCount = timelineEventsAll.length - timelineEvents.length;

    // 引用链候选：action='re-add' 且 payload_json.superseded_dev_assignee_id 非空的事件——含 trigger
    //   字段用于区分主写者（v1.151.1 引擎）与第二写者（backfill_deadlock，见头部注释②）。
    const reAddEvents = await all(
      `SELECT dev_assignee_id AS new_id, created_at,
              json_extract(payload_json, '$.superseded_dev_assignee_id') AS old_id,
              json_extract(payload_json, '$.trigger') AS trigger
         FROM sys_issue_dev_events
        WHERE issue_id = ? AND action = 're-add'
          AND json_extract(payload_json, '$.superseded_dev_assignee_id') IS NOT NULL`, [issueId]);
    const isPolluted = (e) => e && e.trigger === 'backfill_deadlock';
    const cleanEvents = reAddEvents.filter(e => !isPolluted(e));
    const pollutedEvents = reAddEvents.filter(isPolluted);
    const oldIdToEvent = new Map(cleanEvents.map(e => [Number(e.old_id), e]));
    const newIdToEvent = new Map(cleanEvents.map(e => [Number(e.new_id), e]));
    const pollutedOldIdSet = new Set(pollutedEvents.map(e => Number(e.old_id)));
    const pollutedNewIdSet = new Set(pollutedEvents.map(e => Number(e.new_id)));

    // ①(b)/(c) 活跃行创建锚：该 issue 内每个 dev_assignee_id 最早的 add/re-add 事件——**取全字段**
    //   （非仅时间戳，[D 组件①·SD2 三轮插入批 M1] 需要按事件类型分流，见下方判定逻辑）。
    // [D-fix2 LOW-8] json_extract 直接对 payload_json 取值——若某行 payload_json 是非法 JSON（本表已有
    //   手工改库先例，见头部注释②对 backfill_deadlock 写点的说明，不能假设全表 payload_json 都合法），
    //   json_extract 会抛裸错并中断整个脚本（含它之前已经处理成功的其它 issue）。改用
    //   `CASE WHEN json_valid(payload_json) THEN json_extract(...) END`——json_valid(NULL) 与
    //   json_valid('malformed') 均不满足 THEN 条件，隐式 ELSE 返回 NULL，与"该行没有 superseded 链"
    //   同一处理路径（原本 add 事件 payload_json 为 NULL 时也是这个效果，非法 JSON 现在归并到同一兜底，
    //   不再抛错中断）。额外统计 json_valid=0 的行数并告警，不静默吞掉这个数据质量信号。
    const createEventRows = await all(
      `SELECT dev_assignee_id, action, created_at,
              CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.superseded_dev_assignee_id') END AS superseded_id,
              CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.trigger') END AS trigger,
              CASE WHEN payload_json IS NOT NULL AND json_valid(payload_json) = 0 THEN 1 ELSE 0 END AS payload_invalid
         FROM sys_issue_dev_events
        WHERE issue_id = ? AND action IN ('add','re-add')
        ORDER BY created_at ASC, id ASC`, [issueId]);
    const invalidPayloadCount = createEventRows.filter(e => e.payload_invalid === 1).length;
    if (invalidPayloadCount > 0 && !quiet) {
      console.warn(`⚠️ issue #${issueId} 的 sys_issue_dev_events 中有 ${invalidPayloadCount} 行 add/re-add 事件 ` +
        `payload_json 不是合法 JSON（json_valid=0，疑似手工改库遗留）——已按 NULL（无 superseded 链）兜底处理，` +
        `不再抛错中断脚本，但可能影响 (b-i)/(b-ii) 分支判定，需人工核查这些行的 payload_json 原始内容`);
    }
    const createAnchorByDaId = new Map();
    for (const e of createEventRows) {
      const daId = Number(e.dev_assignee_id);
      if (!createAnchorByDaId.has(daId)) createAnchorByDaId.set(daId, e);   // ORDER BY 已按时间升序，首次见到即最早
    }

    // 找某个 re-add 事件对应的 timeline 序号（1-indexed）：取 created_at <= 事件.created_at 的最后一个
    //   timeline 事件（同一事务内写入，created_at 极接近，取"不晚于"的最新一条即为触发本次 re-add 的事件）。
    //   [codex 358 M1] 比较前统一 normSec() 归一——见头部注释"已知踩坑四"M1。
    function ordinalOf(eventCreatedAt) {
      const normEvent = normSec(eventCreatedAt);
      let ord = 0;
      for (let i = 0; i < timelineEvents.length; i++) {
        if (normSec(timelineEvents[i].created_at) <= normEvent) ord = i + 1; else break;
      }
      return ord;   // 0 = 未匹配到任何 timeline 事件（不应发生，防御性返回）
    }

    // [codex 357 HIGH-1][codex 358 M1 归一化] 给定 ordinalOf 算出的 1-indexed 位置 ord（调用方已守卫
    //   ord>=1），求出 timelineEvents[ord-1].created_at（归一化后）所在"同秒集群"的边界（均 1-indexed，
    //   闭区间）——集群定义为归一化后 created_at 与该事件完全相同的连续区间（timelineEvents 已按
    //   created_at ASC, id ASC 排序，归一化后同秒的行仍必然相邻）。lastPos 恒等于 ord 本身（ordinalOf
    //   的 `<=` 扫描必然停在该同秒集群的最后一条）；n=1 时 firstPos===lastPos===ord，调用方据此判定
    //   "无同秒歧义，维持 confident"。
    function sameSecondClusterBounds(ord) {
      const idx = ord - 1;
      const target = normSec(timelineEvents[idx].created_at);
      let lo = idx, hi = idx;
      while (lo > 0 && normSec(timelineEvents[lo - 1].created_at) === target) lo--;
      while (hi < timelineEvents.length - 1 && normSec(timelineEvents[hi + 1].created_at) === target) hi++;
      return { firstPos: lo + 1, lastPos: hi + 1, n: hi - lo + 1 };
    }

    const planStartIdx = plan.length;   // [D-fix2 MED-1] 本单本轮新增的 plan 条目起点，供末尾统一降级 AMBIGUOUS
    for (const row of nullRows) {
      if (row.removed_at === null) {
        // ① 活跃行——三级判定
        if (countIsZero) {
          // (a) 精确：该单从未打回/重开，活跃行必是首轮
          plan.push({ id: row.id, issueId, roundNo: 1, candidateMin: 1, candidateMax: 1,
            method: 'active-round1-exact', ambiguous: false,
            note: `活跃行，issue return_count=reopen_count=0（从未打回/重开过），round_no=1 精确` });
          continue;
        }
        const anchorEvent = createAnchorByDaId.get(Number(row.id));
        if (anchorEvent) {
          // [D 组件①·SD2 三轮插入批 M1] 按锚事件类型分流——同秒边界修复：
          const anchorIsCleanReAdd = anchorEvent.action === 're-add'
            && anchorEvent.superseded_id !== null && anchorEvent.superseded_id !== undefined
            && anchorEvent.trigger !== 'backfill_deadlock';
          if (anchorIsCleanReAdd) {
            // (b-i) 锚事件本身就是干净的自动 re-add——它就是②链式匹配里"新实例"的同一个事件，直接
            //   复用 chain-exact 同款 ordinal 逻辑（ordinalOf 用 `<=` 比较，天然不受同秒边界影响，
            //   不必再走下面 (b-ii) 的"严格早于"+同秒 AMBIGUOUS 判定）。
            const ord = ordinalOf(anchorEvent.created_at);
            // [D-fix2 MED-1] 补 `if (ord > 0)` 守卫——对齐同文件下方 ②历史行 asOld/asNew 两处既有同款
            //   守卫（chain-exact 分支）：ord=0 是 ordinalOf 的防御性返回值（未匹配到任何 timeline 事件，
            //   "不应发生"），此前 (b-i) 无条件相信 ord+1，会把这种异常场景静默算成 round_no=1。
            if (ord > 0) {
              // [codex 357 HIGH-1] 同秒区间化——见头部注释"已知踩坑三"：ord 由 `<=` 比较得出，若命中
              //   的那条 timeline 事件所在秒还有其它 N-1 条 return/reopen 事件，秒级精度无法判定锚
              //   事件真实对应哪一条，`ord+1` 会往高处偏——降级 AMBIGUOUS 并给出候选区间。
              const { firstPos, lastPos, n } = sameSecondClusterBounds(ord);
              if (n > 1) {
                const candidateMin = firstPos + 1, candidateMax = lastPos + 1;   // lastPos===ord，故 candidateMax===ord+1
                plan.push({ id: row.id, issueId, roundNo: candidateMin, candidateMin, candidateMax,
                  method: 'active-anchor-chain-tie', ambiguous: true,
                  note: `活跃行，创建锚是干净的自动 re-add 事件（created_at="${anchorEvent.created_at}"）——但该秒内` +
                    `另有 ${n - 1} 次 return/reopen timeline 事件同秒（共 ${n} 条），秒级精度无法判定锚事件真实` +
                    `对应哪一次触发，候选轮次区间第 ${candidateMin} 轮 ~ 第 ${candidateMax} 轮，暂给出最小候选 ` +
                    `${candidateMin}，需人工用更细粒度证据（如同表 rowid 写入顺序/应用日志）核对` });
                continue;
              }
              plan.push({ id: row.id, issueId, roundNo: ord + 1, candidateMin: ord + 1, candidateMax: ord + 1,
                method: 'active-anchor-chain', ambiguous: false,
                note: `活跃行，创建锚是干净的自动 re-add 事件（第 ${ord} 次打回/重开触发，created_at=` +
                  `"${anchorEvent.created_at}"）——复用 chain-exact 同款 ordinal 逻辑（<= 比较，防同秒边界），归第 ${ord + 1} 轮` });
              continue;
            }
            plan.push({ id: row.id, issueId, roundNo: 1, candidateMin: 1, candidateMax: 1,
              method: 'active-anchor-chain-unresolved', ambiguous: true,
              note: `活跃行，创建锚是干净的自动 re-add 事件（created_at="${anchorEvent.created_at}"），但` +
                `ordinalOf 未匹配到任何 return/reopen timeline 事件（ord=0，防御性场景，不应发生）——不 confident` +
                `给出精确轮次，给出建议值 round_no=1 仅供参考，需人工核对该单 timeline 记录完整性` });
            continue;
          }
          // (b-ii) 锚事件是普通 add / 手工 re-add（无 superseded 链）/ 被污染的 backfill_deadlock re-add——
          //   这类锚不享有"同事务写入"的强绑定关系，维持严格早于（<）计数；但若锚事件恰好与某次
          //   return/reopen timeline 事件同秒，秒级精度分不清谁先谁后（该 add 到底发生在那次打回之前
          //   还是之后），此时严格早于会把该次打回**排除**在计数外，可能少算一轮（本次 M1 要修的
          //   缺口）——不再confident 给单一值，改判 AMBIGUOUS 并给出候选区间：
          //   [D-fix2 LOW-3·LOW-6 订正] 与上方 (b-i) 的区别务必分清，但**"改值的仅 (b-i)"这句原表述不准
          //   确**——如实更正：(b-i) 在 ord=0 时把 method 换成 active-anchor-chain-unresolved、ambiguous
          //   从 false 改 true，但**写入的 roundNo 数值本身没变**（ord=0 时 `ord+1`=1，兜底猜测值也是
          //   `1`，同一个数字，只是"精确算出的 1"降级为"猜的 1"）——MED-1 这个修复动的是**元数据**（这个
          //   1 到底可不可信），不是数值。真正意义上的"改值"（写进 plan.roundNo 的数字本身不同于修复前）
          //   本次两个分支都没发生；(b-ii) 依旧是**只降信心**——下方无论落哪个候选，仍是与非同秒场景同一
          //   套公式算出的 candidateLow，只把 ambiguous 从 false 改 true、补充候选区间供人工核对。两者的
          //   真实区别是："(b-i) 在 ord=0 这个防御性罕见分支里额外产出一条新 method 名+ambiguous 标记"，
          //   "(b-ii) 对已有的每一次正常调用路径都补了候选区间信息"——都是**信息增量**，不是数值改动。
          //   [codex 358 M1] 同秒判定改用 normSec 归一后比较（见头部注释"已知踩坑四"M1）。
          const sameSecondTimelineEvents = timelineEvents.filter(e => normSec(e.created_at) === normSec(anchorEvent.created_at));
          if (sameSecondTimelineEvents.length > 0) {
            // [D-fix2 LOW-2·codex 357 HIGH-2① 结构升级] 候选区间按同秒事件数 N 动态生成 N+1 个候选
            //   （不再恒称"两个候选"）——锚事件相对 N 个同秒 return/reopen 事件的真实先后顺序有 N+1
            //   种可能排位（锚在全部之前/夹在任意相邻两个之间/锚在全部之后），只报最小最大两端会让
            //   N>1 时中间候选悄悄消失。此前该区间只活在 note 文案里（plan 行仍是单值 roundNo）——
            //   HIGH-2① 起改为 plan 行显式带 candidateMin/candidateMax 两个字段（与本文件其余全部
            //   分支同一结构：confident 行两者恒等于 roundNo），供 APPLY 阶段的 --apply-ambiguous 做
            //   区间校验，不再只是给人看的文字。
            //   [codex 358 M1] kExclusive 同步改用 normSec 归一比较——与上面 sameSecondTimelineEvents
            //   同一套归一口径，避免"谁算同秒/谁算严格早于"两套判据互不一致，重新制造出边界缝隙。
            const kExclusive = timelineEvents.filter(e => normSec(e.created_at) < normSec(anchorEvent.created_at)).length;
            const n = sameSecondTimelineEvents.length;
            const candidateLow = kExclusive + 1;
            const candidateHigh = kExclusive + n + 1;   // 等价于严格 `<=` 计数 + 1（kInclusive + 1）
            plan.push({ id: row.id, issueId, roundNo: candidateLow, candidateMin: candidateLow, candidateMax: candidateHigh,
              method: 'active-anchor-tie', ambiguous: true,
              note: `活跃行，创建锚（action=${anchorEvent.action}，created_at="${anchorEvent.created_at}"）与` +
                `${n} 次 return/reopen timeline 事件同秒——秒级精度下无法判定该锚事件与这 ${n} 次同秒打回/` +
                `重开的先后顺序，共 ${n + 1} 个候选轮次：第 ${candidateLow} 轮 ~ 第 ${candidateHigh} 轮` +
                `（锚早于全部同秒事件=第${candidateLow}轮，锚晚于全部=第${candidateHigh}轮，介于中间时可能落` +
                `在区间内任一值），暂给出最小候选 ${candidateLow}，需人工用更细粒度证据（如同表 rowid` +
                `写入顺序/应用日志）核对` });
            continue;
          }
          // (b) 用创建锚 + 与③同款的时间对齐公式（无同秒歧义）——[codex 358 M1] 同样归一比较。
          const k = timelineEvents.filter(e => normSec(e.created_at) < normSec(anchorEvent.created_at)).length;
          plan.push({ id: row.id, issueId, roundNo: k + 1, candidateMin: k + 1, candidateMax: k + 1,
            method: 'active-anchor-heuristic', ambiguous: false,
            note: `活跃行，issue 计数>0（不可再用当前计数直接+1——v1.151.1 前存量行可能原地跨轮存活，` +
              `见头部注释踩坑说明）——按该行最早 add/re-add 事件（action=${anchorEvent.action}）created_at=` +
              `"${anchorEvent.created_at}" 做创建锚，严格早于锚点的打回/重开事件 ${k} 次，按"+1"归第 ${k + 1} 轮` });
          continue;
        }
        // (c) 无锚，AMBIGUOUS，给出按当前计数的建议值仅供参考
        plan.push({ id: row.id, issueId, roundNo: currentRound, candidateMin: currentRound, candidateMax: currentRound,
          method: 'active-no-anchor', ambiguous: true,
          note: `活跃行，issue 计数>0 且该 dev_assignee_id 在 sys_issue_dev_events 里查不到任何 add/re-add ` +
            `事件（无法定位创建锚——可能是迁移回填路径生成的历史主开发行，或 supersede-excuse 产生的新行）` +
            `——按"issue 当前计数+1"给出建议值 round_no=${currentRound} 仅供参考，不保证准确，需人工核对该行` +
            `实际创建于哪一轮` });
        continue;
      }
      // ② 历史行——先试引用链（仅信 clean 主写者事件；backfill_deadlock 第二写者的事件不作精确链证据）
      const asOld = oldIdToEvent.get(Number(row.id));
      if (asOld) {
        const ord = ordinalOf(asOld.created_at);
        if (ord > 0) {
          // [codex 357 HIGH-1][codex 358 M1] 同秒区间化（asOld 侧：roundNo=ord，不带 +1）——见头部注释。
          const { firstPos, lastPos, n } = sameSecondClusterBounds(ord);
          if (n > 1) {
            const candidateMin = firstPos, candidateMax = lastPos;   // lastPos===ord
            plan.push({ id: row.id, issueId, roundNo: candidateMin, candidateMin, candidateMax,
              method: 'chain-exact-tie', ambiguous: true,
              note: `被自动 re-add 事件（新实例 id=${asOld.new_id}）取代，取代事件 created_at="${asOld.created_at}"` +
                `与本单另外 ${n - 1} 次 return/reopen timeline 事件同秒（共 ${n} 条），秒级精度无法判定具体是` +
                `第几次打回/重开触发，候选轮次区间第 ${candidateMin} 轮 ~ 第 ${candidateMax} 轮，暂给出最小候选 ` +
                `${candidateMin}，需人工核对` });
            continue;
          }
          plan.push({ id: row.id, issueId, roundNo: ord, candidateMin: ord, candidateMax: ord,
            method: 'chain-exact', ambiguous: false,
            note: `被第 ${ord} 次打回/重开的自动 re-add 事件（新实例 id=${asOld.new_id}）取代，旧实例归第 ${ord} 轮` });
          continue;
        }
      }
      // 本行自身若是某次（可信）自动 re-add 的"新实例"，也可用引用链定轮（正常应已被①活跃分支或另一条
      //   链覆盖，这里兜底：新实例后续又被再打回一次而软删的情形）
      const asNew = newIdToEvent.get(Number(row.id));
      if (asNew) {
        const ord = ordinalOf(asNew.created_at);
        if (ord > 0) {
          // [codex 357 HIGH-1][codex 358 M1] 同秒区间化（asNew 侧：roundNo=ord+1）——见头部注释。
          const { firstPos, lastPos, n } = sameSecondClusterBounds(ord);
          if (n > 1) {
            const candidateMin = firstPos + 1, candidateMax = lastPos + 1;
            plan.push({ id: row.id, issueId, roundNo: candidateMin, candidateMin, candidateMax,
              method: 'chain-exact-tie', ambiguous: true,
              note: `由自动 re-add 产生（新实例本身），产生事件 created_at="${asNew.created_at}" 与本单另外 ` +
                `${n - 1} 次 return/reopen timeline 事件同秒（共 ${n} 条），秒级精度无法判定具体是第几次打回/` +
                `重开触发，候选轮次区间第 ${candidateMin} 轮 ~ 第 ${candidateMax} 轮，暂给出最小候选 ${candidateMin}，需人工核对` });
            continue;
          }
          plan.push({ id: row.id, issueId, roundNo: ord + 1, candidateMin: ord + 1, candidateMax: ord + 1,
            method: 'chain-exact', ambiguous: false,
            note: `由第 ${ord} 次打回/重开自动 re-add 产生（新实例本身），归第 ${ord + 1} 轮` });
          continue;
        }
      }
      // ③ 无（可信）引用链证据——时间对齐推算，标 AMBIGUOUS（[codex 358 M1] 同样归一比较）
      const k = timelineEvents.filter(e => normSec(e.created_at) < normSec(row.removed_at)).length;
      const isPollutedRow = pollutedOldIdSet.has(Number(row.id)) || pollutedNewIdSet.has(Number(row.id));
      const noChainReason = isPollutedRow
        ? '（该行在 backfill_deadlock 存量死锁修复脚本的 re-add 记录里出现过，但其 created_at 是补写时刻、非真实打回时刻，不作精确链证据，退化为时间对齐推算——见头部注释②）'
        : '（很可能是手工 DELETE 移除）';
      plan.push({ id: row.id, issueId, roundNo: k + 1, candidateMin: k + 1, candidateMax: k + 1,
        method: 'time-heuristic', ambiguous: true,
        note: `无可信自动 re-add 引用链${noChainReason}——removed_at="${row.removed_at}" 早于第 ${k + 1} 次` +
          `打回/重开事件（该单共 ${timelineEvents.length} 次打回/重开），按"之前发生过 ${k} 次+1"归第 ${k + 1} 轮，需人工复核` });
    }

    // [D-fix2 MED-1] 本单 return/reopen timeline 中若有 created_at 为 NULL 的事件被上方排除，则本单
    //   全部序号计数（ordinalOf/timelineEvents.filter 的 k）都建立在一份不完整的序列上——NULL 事件在
    //   SQLite ORDER BY ASC 中排最前，被排除后等同"从未发生过"，会让所有基于该序列的判定静默少算一轮。
    //   不信任"哪些行受影响"的局部判断，直接把本单本轮新增的全部回填行强制降级 AMBIGUOUS。
    if (excludedNullCreatedAtCount > 0) {
      for (const p of plan.slice(planStartIdx)) {
        p.ambiguous = true;
        p.note += `｜⚠️ [D-fix2 MED-1] 本单 return/reopen timeline 中有 ${excludedNullCreatedAtCount} 条事件` +
          ` created_at 为 NULL（已从计数/ordinalOf 序列中排除）——序号计数基于不完整序列，本单全部回填行` +
          `强制降级 AMBIGUOUS，需人工核对该单 timeline 数据完整性后再定夺`;
      }
    }
  }

  return { issueIds, plan, danglingIssueCount };
}

(async () => {
  console.log(`db      : ${DB_PATH}`);
  console.log(`模式    : ${APPLY ? '⚠️  APPLY（真写）' : 'dry-run（只报告）'}`);
  console.log('');
  await run('PRAGMA busy_timeout = 10000');

  // ── 0. 前置检查：round_no 列必须已存在（[SD1 二轮预筛 LOW-5] 友好报错，不要让人对着裸 SQLite
  //   报错猜半天）——该列由服务启动时 runSysMigration 的 alterAddMissingCols 幂等 ALTER 补上，
  //   本脚本从不建列，纯粹的"服务至少成功启动过一次"前置条件检查。
  const daCols = await all(`PRAGMA table_info(sys_issue_dev_assignees)`);
  if (!daCols.some(c => c.name === 'round_no')) {
    console.error('❌ sys_issue_dev_assignees 表缺少 round_no 列——请先启动一次服务（node server.js）完成 ALTER 迁移，再重跑本脚本。');
    db.close(); process.exit(1);
  }

  // [D 组件①·SD2 三轮插入批 M2b] 运行前扫一遍非法 round_no——这批脏值不是本脚本写的（本脚本只处理
  //   IS NULL 的行，从不覆盖已有非 NULL 值），若存在说明别处（写点漏了 M2a 断言的旧代码 / 手工改库）
  //   已经产生了脏数据。**不中止**（这些行本就不在本脚本的处理范围内，阻断"回填 NULL 行"这个正当
  //   操作不合理），但必须显著报出来供人工核查——脏值持续存在只会误导后续依赖 round_no 展示的用户。
  const illegalBefore = await scanIllegalRoundNo();
  if (illegalBefore.length > 0) {
    console.warn(`⚠️ 运行前发现 ${illegalBefore.length} 行 round_no 已是非法值（非本脚本写入，可能是写点遗留脏数据或手工改库）：`);
    for (const r of illegalBefore.slice(0, 20)) {
      console.warn(`   da_id=${r.id} (issue #${r.issue_id}) round_no=${JSON.stringify(r.round_no)} (typeof=${r.round_no_type})`);
    }
    if (illegalBefore.length > 20) console.warn(`   ……其余 ${illegalBefore.length - 20} 行省略`);
    console.warn('   （本脚本不处理非 NULL 行，不会覆盖/修复这些脏值，仅报告；需人工另行核查处理）');
  } else {
    console.log('✅ 运行前 round_no 合法性探针：全表非 NULL 的 round_no 均为合法正整数（0 行非法）');
  }

  // ── 1. 构建 plan（锁外首版，供人工审阅 / --apply-ambiguous 首轮语义校验）──────────────
  const { issueIds, plan, danglingIssueCount } = await buildPlan(false);
  console.log(`round_no 为 NULL 的行分布在 ${issueIds.length} 张单据上`);
  if (issueIds.length === 0) { console.log('无需处理。'); db.close(); return; }

  // ── 2. 汇总打印 ──────────────────────────────────────────────────────────
  const byMethod = { 'active-round1-exact': 0, 'active-anchor-chain': 0, 'active-anchor-chain-tie': 0, 'active-anchor-chain-unresolved': 0, 'active-anchor-heuristic': 0, 'active-anchor-tie': 0, 'active-no-anchor': 0, 'chain-exact': 0, 'chain-exact-tie': 0, 'time-heuristic': 0 };
  let ambiguousCount = 0;
  for (const p of plan) { byMethod[p.method] = (byMethod[p.method] || 0) + 1; if (p.ambiguous) ambiguousCount++; }
  console.log(`\n共 ${plan.length} 行待回填：`);
  console.log(`  · active-round1-exact（活跃行·从未打回重开·round=1 精确）    : ${byMethod['active-round1-exact']}`);
  console.log(`  · active-anchor-chain（活跃行·锚是干净re-add·复用ordinal）   : ${byMethod['active-anchor-chain']}`);
  console.log(`  · active-anchor-chain-tie（同上但锚与打回同秒，AMBIGUOUS）   : ${byMethod['active-anchor-chain-tie']}`);
  console.log(`  · active-anchor-chain-unresolved（同上但 ord=0，AMBIGUOUS） : ${byMethod['active-anchor-chain-unresolved']}`);
  console.log(`  · active-anchor-heuristic（活跃行·创建锚时间对齐）           : ${byMethod['active-anchor-heuristic']}`);
  console.log(`  · active-anchor-tie（活跃行·锚与打回同秒，AMBIGUOUS）        : ${byMethod['active-anchor-tie']}`);
  console.log(`  · active-no-anchor（活跃行·无创建锚，AMBIGUOUS）             : ${byMethod['active-no-anchor']}`);
  console.log(`  · chain-exact（历史行·引用链精确匹配）                       : ${byMethod['chain-exact']}`);
  console.log(`  · chain-exact-tie（同上但取代事件与打回同秒，AMBIGUOUS）     : ${byMethod['chain-exact-tie']}`);
  console.log(`  · time-heuristic（历史行·时间对齐推算，AMBIGUOUS）           : ${byMethod['time-heuristic']}`);
  console.log(`  ⚠️ AMBIGUOUS 合计：${ambiguousCount} 行（供人工复核，见下方逐行标注）`);

  console.log('\n逐行明细：');
  for (const p of plan) {
    const tag = p.ambiguous ? '⚠️ AMBIGUOUS' : '✅';
    console.log(`  ${tag} da_id=${p.id} (issue #${p.issueId}) → round_no=${p.roundNo} [候选 ${p.candidateMin}~${p.candidateMax}] [${p.method}] ${p.note}`);
  }

  // ── 人工处理清单（AMBIGUOUS 行）─────────────────────────────────────────
  //   [codex 357 HIGH-2②] 无论 dry-run 还是 apply 都打印：dry-run 时供人工在执行 --apply 前预判范围；
  //   apply 时因为默认不写 AMBIGUOUS 行，这里就是"这次没写、需要另外处理"的行动清单。
  const ambiguousRows = plan.filter(p => p.ambiguous);
  if (ambiguousRows.length > 0) {
    console.log(`\n⚠️ 人工处理清单（${ambiguousRows.length} 行 AMBIGUOUS，--apply 默认不写，需人工核实取值）：`);
    for (const p of ambiguousRows) {
      console.log(`  · da_id=${p.id} (issue #${p.issueId}) [${p.method}] 候选区间 [${p.candidateMin}, ${p.candidateMax}]`);
      console.log(`    ${p.note}`);
    }
    console.log(`\n  人工确认取值后，二选一执行（⚠️ 均需先人工核实每个 id 的真实取值，禁止不加确认直接批量执行）：`);
    console.log(`  方式一（推荐，走本脚本校验 + M2b 写后探针）：`);
    console.log(`    node scripts/backfill-sys-dev-assignee-round.js --db <path> --apply --apply-ambiguous "` +
      ambiguousRows.map(p => `${p.id}=<在[${p.candidateMin},${p.candidateMax}]中人工选定的值>`).join(',') + `"`);
    console.log(`  方式二（人工手写 SQL，⚠️ 勿盲跑，务必先核实每个 id 真实取值再逐条替换 <ROUND_NO> 单独执行）：`);
    for (const p of ambiguousRows) {
      console.log(`    -- da_id=${p.id} 候选区间 [${p.candidateMin}, ${p.candidateMax}]`);
      console.log(`    -- UPDATE sys_issue_dev_assignees SET round_no = <ROUND_NO> WHERE id = ${p.id} AND round_no IS NULL;`);
    }
  }

  if (!APPLY) {
    console.log('\n（dry-run 结束，未写入任何数据。确认无误后加 --apply 执行。）');
    db.close(); return;
  }

  // ── 2.5 --apply-ambiguous 语义校验（锁外首轮，fail-closed：任一 id 不满足即整体拒绝）──────────
  //   [codex 357 HIGH-2③] 语法级校验已在参数解析阶段做过（见文件头部）；这里做与 plan 相关的语义
  //   校验：id 必须在本次 plan 内、必须 ambiguous=true（confident 行不许走这条通道，它已经默认会写）、
  //   round 必须落在该行 [candidateMin,candidateMax] 闭区间内。任一 id=round 对不满足，整批拒绝——
  //   不尝试"只应用校验通过的那些、跳过失败的"，宁可让人改好参数重跑一次，也不接受含糊的部分应用。
  //   [codex 358 M3] 这轮校验只是**快速失败**用（省得为明显写错的参数白等测试钩子/白拿写锁）——
  //   真正决定"写不写、写什么值"的权威校验在下方事务内对重建后的 plan 再做一遍。
  if (applyAmbiguousPairs) {
    const planById = new Map(plan.map(p => [p.id, p]));
    const semErrors = [];
    for (const { id, round } of applyAmbiguousPairs) {
      const p = planById.get(id);
      if (!p) { semErrors.push(`da_id=${id} 不在本次回填计划（plan）内`); continue; }
      if (!p.ambiguous) { semErrors.push(`da_id=${id} 在 plan 中 ambiguous=false（confident 行已默认写入，不允许也无需走 --apply-ambiguous）`); continue; }
      if (round < p.candidateMin || round > p.candidateMax) {
        semErrors.push(`da_id=${id} 指定值 round=${round} 不在候选区间 [${p.candidateMin}, ${p.candidateMax}] 内（method=${p.method}）`); continue;
      }
    }
    if (semErrors.length > 0) {
      console.error(`\n❌ --apply-ambiguous 校验失败，整体拒绝执行（fail-closed，不写入任何数据，含本次全部 confident 行）：`);
      for (const e of semErrors) console.error(`   · ${e}`);
      db.close(); process.exit(1);
    }
    console.log(`\n✅ --apply-ambiguous 锁外首轮校验通过：${applyAmbiguousPairs.length} 个 id 的显式取值均落在候选区间内` +
      `（事务内拿到写锁后还会用重建的 plan 再校验一遍，见下方）`);
  }

  // ── 3. 真写（单事务，失败整体回滚——round_no 是展示层列，不改任何业务状态，无需逐单独立事务/备份）──
  try {
    // [codex 358 M3 测试专用钩子] 仅供本文件的自动化验证使用，见头部注释与用法说明——设置环境变量
    //   BACKFILL_TEST_DELAY_BEFORE_TXN_MS 时在拿到写锁前人为暂停，给测试脚本一个确定性窗口在另一个
    //   连接里制造并发写入；生产环境从不设置该变量，对正常运行零影响（Number('')===0，不暂停）。
    const testDelayMs = Number(process.env.BACKFILL_TEST_DELAY_BEFORE_TXN_MS || 0);
    if (testDelayMs > 0) {
      console.log(`\n⏸️  [测试钩子] BACKFILL_TEST_DELAY_BEFORE_TXN_MS=${testDelayMs}ms，BEGIN IMMEDIATE 前暂停……`);
      await new Promise(resolve => setTimeout(resolve, testDelayMs));
    }

    await run('BEGIN IMMEDIATE');
    // [D-fix2 LOW-4] 事务内重新取一次"非法 round_no"快照——:117 那次早期扫描发生在 BEGIN IMMEDIATE
    //   之前，若脚本构造 plan 耗时较长、或库处于在线状态，两次扫描之间可能已有其他写入，拿它去跟
    //   "运行后"比对并不是同一原子操作的真实前后态。这里在拿到写锁之后（其余写者已被 BEGIN IMMEDIATE
    //   挡在外面）再取一次权威 before 快照专供下方 M2b 比对；:117 那次早期扫描只保留"提前告知用户"
    //   的展示用途（dry-run 模式下也要能看到，故不能删），不再参与本次比对逻辑。
    const illegalBeforeTxn = await scanIllegalRoundNo();
    const illegalBeforeTxnIds = new Set(illegalBeforeTxn.map(r => r.id));

    // [codex 358 M3] 事务内重建 plan（拿到写锁后的权威快照）并与锁外旧 plan 比对漂移——见头部注释
    //   "已知踩坑四"M3。任何漂移（id 集合变化 / method / roundNo / candidateMin / candidateMax /
    //   ambiguous 任一字段不同）一律整体拒绝，不继续沿用旧 plan 的任何数值——写入循环下方改用 planTxn。
    console.log('\n🔒 事务内重建 plan 校验中（拿到写锁后与锁外旧 plan 比对，确保未发生并发漂移）……');
    const { plan: planTxn, danglingIssueCount: danglingIssueCountTxn } = await buildPlan(true);
    const drifts = diffPlans(plan, planTxn);
    if (drifts.length > 0) {
      throw new Error(`[M3] 事务内重建 plan 与 dry-run 时的旧 plan 不一致，数据已在两次构建之间发生变化，` +
        `请重新 dry-run 核对后再执行（fail-closed，不写入任何数据）：\n` + drifts.map(d => '   · ' + d).join('\n'));
    }
    console.log('✅ 事务内重建 plan 与锁外旧 plan 完全一致，未发生并发漂移，继续写入。');

    // [codex 358 M3] --apply-ambiguous 对事务内重建的 planTxn 再独立校验一遍（防御性双重校验：即便
    //   上面 diffPlans 理论上已保证 planTxn 与旧 plan 逐行相同，这里不复用锁外校验结果，独立重跑）。
    let applyAmbiguousMapTxn = null;
    if (applyAmbiguousPairs) {
      const planByIdTxn = new Map(planTxn.map(p => [p.id, p]));
      const semErrorsTxn = [];
      const mTxn = new Map();
      for (const { id, round } of applyAmbiguousPairs) {
        const p = planByIdTxn.get(id);
        if (!p) { semErrorsTxn.push(`da_id=${id} 不在事务内重建的 plan 内`); continue; }
        if (!p.ambiguous) { semErrorsTxn.push(`da_id=${id} 在事务内重建的 plan 中 ambiguous=false（confident 行不允许走 --apply-ambiguous）`); continue; }
        if (round < p.candidateMin || round > p.candidateMax) {
          semErrorsTxn.push(`da_id=${id} 指定值 round=${round} 不在事务内重建的候选区间 [${p.candidateMin}, ${p.candidateMax}] 内`); continue;
        }
        mTxn.set(id, round);
      }
      if (semErrorsTxn.length > 0) {
        throw new Error(`[M3] --apply-ambiguous 事务内重建校验失败，整体拒绝执行（fail-closed，不写入任何数据）：\n` +
          semErrorsTxn.map(e => '   · ' + e).join('\n'));
      }
      applyAmbiguousMapTxn = mTxn;
    }

    // [codex 357 HIGH-2②][codex 358 M3 改用事务内重建的 planTxn] APPLY 默认只写 confident 行
    //   （ambiguous=false）；ambiguous 行只有在 --apply-ambiguous 显式指定且通过两轮语义校验时才写
    //   指定值，否则跳过（不写库，留 NULL）。三类计数分开统计，供末尾汇总与 stillNull 成因排查用。
    let confidentApplied = 0, ambiguousSkipped = 0, ambiguousAppliedExplicit = 0;
    for (const p of planTxn) {
      let valueToWrite;
      if (!p.ambiguous) {
        valueToWrite = p.roundNo;
      } else if (applyAmbiguousMapTxn && applyAmbiguousMapTxn.has(p.id)) {
        valueToWrite = applyAmbiguousMapTxn.get(p.id);
      } else {
        ambiguousSkipped++;
        continue;
      }
      const upd = await run(
        `UPDATE sys_issue_dev_assignees SET round_no = ? WHERE id = ? AND round_no IS NULL`,
        [valueToWrite, p.id]);
      if (!upd || upd.changes !== 1) {
        throw new Error(`da_id=${p.id} 回填失败：期望 changes=1，实得 ${upd && upd.changes}（可能已被其他进程并发回填）`);
      }
      if (p.ambiguous) ambiguousAppliedExplicit++; else confidentApplied++;
    }
    const applied = confidentApplied + ambiguousAppliedExplicit;

    // [D 组件①·SD2 三轮插入批 M2b] 写后合法性探针（COMMIT 之前，可回滚）——本次 plan 里每个 roundNo
    //   在构造阶段就已是 k+1/ord+1/1 这类"非负计数+1"的算式产物，结构上不该产出非法值；这里仍显式
    //   查一遍数据库真实落地的值，不信任"算法看起来对"就等于"写进去的一定对"（绑参/类型转换层仍可能
    //   出岔子）。只判定**本次 planTxn 涉及的行**——全表扫描会把运行前就存在、本脚本从不触碰的历史
    //   脏值也算进来，那不是这次写入引入的问题，不该连坐回滚这次正当的回填。
    const illegalAfter = await scanIllegalRoundNo();
    const planIds = new Set(planTxn.map(p => p.id));
    const illegalFromThisRun = illegalAfter.filter(r => planIds.has(r.id));
    if (illegalFromThisRun.length > 0) {
      throw new Error(`M2b 数据探针：本次回填写入后产生了 ${illegalFromThisRun.length} 行非法 round_no` +
        `（不应发生，说明算法或写入环节有 bug，整体回滚）：${JSON.stringify(illegalFromThisRun)}`);
    }
    // [D-fix2 LOW-4] 改用 id 集合差集判定"新增非法值"，不再靠长度比较——若同一事务窗口内一行新变
    //   非法、另一行原有非法巧合被外部并发清掉，两个变化的计数会相互抵消，`length` 比较看不出"确实
    //   发生过变化"这件事；集合差集直接看"illegalAfter 里出现了哪些 illegalBeforeTxnIds 没有的 id"，
    //   才是准确的"新增"判定，且比对双方（illegalBeforeTxn/illegalAfter）均在本次写锁窗口内取得，
    //   不再是两个时间点相距很远的快照。
    const newlyIllegal = illegalAfter.filter(r => !illegalBeforeTxnIds.has(r.id));
    if (newlyIllegal.length > 0) {
      console.warn(`⚠️ 事务窗口内新增了 ${newlyIllegal.length} 行非法 round_no（均不在本次 plan 内，已逐行核对排除）：` +
        `${JSON.stringify(newlyIllegal.map(r => r.id))}，可能是本次运行期间的并发写入，请另行核查`);
    }

    // 复验：全库不应再有 round_no IS NULL 的行属于本次已处理的 issue 集合之外的意外新增
    const stillNull = (await get(`SELECT COUNT(*) AS c FROM sys_issue_dev_assignees WHERE round_no IS NULL`)).c;
    await run('COMMIT');
    // [SD1 二轮预筛 LOW-4] stillNull>0 的成因，分开说明（不笼统丢一句"请重跑排查"）：
    //   ① 回填期间有新增写入（真实并发场景，服务在线时常见——但若确实发生，上面 M3 的漂移比对本应先
    //      拦下并整体回滚，走到这里说明是 COMMIT 之后才发生的新写入，不在本次事务窗口内）；
    //   ② 本次扫描到的 issueIds 里有"悬垂 issue_id"——这类行所属的 sys_issues 主表行已不存在（FK 未
    //      启用，可能是历史脏数据/手工删除残留），本脚本判定"单据不存在"直接跳过，不进 plan、不参与
    //      回填，其 round_no 会**永远**停留在 NULL，不是本轮"漏算"，而是设计上就不处理这类无主行；
    //   ③ 本次跳过的歧义行——未走 --apply-ambiguous 显式指定，同样会停留 NULL 直到人工核实后补写。
    const stillNullNote = stillNull > 0
      ? `（应为 0 才是"回填期间无新增写入、无悬垂 issue_id 且无跳过的歧义行"的理想态；非 0 时依次排查三个` +
        `成因：① 本次报过悬垂 issue_id（本轮 ${danglingIssueCountTxn} 张，那些行天然不参与回填、永远停留 NULL，` +
        `不是缺陷）；② 本次跳过的歧义行（${ambiguousSkipped} 行，未走 --apply-ambiguous 显式指定，见上方` +
        `人工处理清单，同样会停留 NULL 直到人工核实后补写）；③ 排除以上两因素后剩余差额，才需要按"COMMIT` +
        `之后又有新写入"复核）`
      : '';
    console.log(`\n✅ 已回填 ${applied} 行（confident 写入 ${confidentApplied} 行 + 歧义显式写入 ${ambiguousAppliedExplicit} 行）。` +
      `歧义跳过 ${ambiguousSkipped} 行（未写入，见上方人工处理清单）。全库 round_no 仍为 NULL 的行数：${stillNull}${stillNullNote}`);
    console.log(`   写后合法性探针：本次 planTxn 中实际写入的 ${applied} 行 round_no 均合法（0 行非法，见上方 M2b 判定）。`);
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error(`\n❌ 失败已整体回滚：${e.message}`);
    db.close(); process.exit(1);
  }
  db.close();
})().catch(e => { console.error('异常：', e.message); db.close(); process.exit(1); });
