// _set-sys-single-commit-group.js（上线执行人多选与双确认 方案 v1.7 §10.3·C11·HRD 单组版本号）
//
// 一次性本地/生产 db 写入脚本：把 system_configs.sys_single_commit_group_systems 置为「不分前后端·单组
// 版本号」的系统清单（逗号串，例：'HRD' 或 'HRD,某系统'）。加密存，逐字对齐 server.js writeSystemConfig
// 的既有约定（本项目 system_configs 值一律走 encryptPassword 加密，即便像本清单这种非密钥语义的值也不
// 例外——防止 readSystemConfig 读到未加密串时 decryptPassword 抛错→静默 catch 归 null→误判"无命中系统"）。
//
// 用法：node scripts/_set-sys-single-commit-group.js "HRD,电子签,RPA程序,小程序-智荟人力,某新系统" [--allow-drop] [--check-only] [--allow-db-override]
//       ⚠️ replace 语义：写入值必须**显式含代码默认清单的全部成员**（权威源=routes/sys-iteration/
//       transitions.js DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS，2026-09-02 起=HRD/电子签/RPA程序/
//       小程序-智荟人力），漏一个=该系统静默落成双组不报错（codex 435 MED-1 登记的失败方向）。
//       ⚠️ 未知开关（含拼错，如 --checkonly/--allowdrop）、重复开关、位置参数数量≠1 → 一律直接拒绝。
//       ⚠️ SYS_SINGLE_COMMIT_GROUP_DB_PATH 与 --allow-db-override 必须成对出现（只给一半均直接拒绝，
//       空串 env 视为未设置）；无论是否覆盖，写库前恒打印 `TARGET_DB=<解析后的绝对路径>`（--check-only 也打印）。
//       ⚠️ DB_ENCRYPTION_KEY 须为 ≥32 字节的 ASCII 可打印字符（含非 ASCII 字符即使凑够 32 个 UTF-16
//       字符也拒绝——与 server.js 加密派生的字节口径同源）。
//
// ⚠️ [2026-09-02 S2c·codex 493 H1 收口] 本脚本此前默认参数 'HRD'——不带参数直接跑等于把其余成员
//   静默踢出单组，注释警告不构成运行时保护。改为**无参数直接拒绝**（打印用法 + exit 1），并新增两开关：
//   --allow-drop  显式声明"我知道会漏成员、就是要主动移出"，跳过⊇校验（默认不给，缺项直接拒绝）；
//   --check-only  只跑到校验通过为止，打印 CHECK_OK 后 exit 0，**不打开 db、不写库**——部署前置探针
//                 用它确认"即将写入的值"不会漏成员，不必真写一次再回读核实。
//   DB_ENCRYPTION_KEY 同步改为 fail-closed（同 server.js 2026-08-26 约定）：缺失或 <32 字节直接拒绝，
//   **删除硬编码回退 'change_me_with_random_32bytes_!!'**——该常量曾随源码进公开镜像仓、叠加生产 db
//   快照误推导致密钥泄露（见 server.js 同名注释），本脚本原先独立维护一份回退值不受那次修复覆盖。
// ⚠️ [2026-09-02 S2d·codex 493-R H 收口] 上一批的开关解析只白名单式识别已知开关（`.includes('--allow-drop')`
//   风格），对**未登记**的 `--` 开头参数（拼错的 `--checkonly`/`--allowdrop`、误传的第三个开关）不拒绝、
//   静默忽略——落地效果是"打错开关等于没传"，例如 `--checkonly` 会被当成一个普通位置参数或干脆被漏判，
//   实际仍走默认路径。改为**开关白名单 fail-closed**：只认 `--allow-drop`/`--check-only` 两个字面量，任何
//   其它 `--` 开头参数、重复开关、位置参数数量≠1，一律在**触达 DB_ENCRYPTION_KEY 校验之前**直接拒绝——
//   不给"拼错开关→静默走非预期分支"的空子。
// ⚠️ [2026-09-02 S2e·codex 493-R2 M3 采纳] S2d 加的 SYS_SINGLE_COMMIT_GROUP_DB_PATH 测试路径注入本身
//   没有任何门槛——只要环境里残留这个变量（如部署脚本模板遗留、CI 环境变量泄漏到本地 shell），本脚本
//   就会静默写去一个意料之外的 db 文件，本人/审阅者都不会察觉。改为**显式开关门槛**：该 env 只在同时带
//   `--allow-db-override` 时生效；检测到 env 但缺开关 → 直接拒绝，且发生在 DB_ENCRYPTION_KEY 校验之前
//   （同 S2d 的"参数校验先于密钥校验"顺序原则）。另加可观测性兜底：无论走生产默认路径还是被覆盖，写库
//   前恒打印 `TARGET_DB=<绝对路径>`（含 --check-only 分支）——操作者/日志审计不必反查环境变量就能确认
//   这次到底动的是哪个文件。
// ⚠️ [2026-09-02 S2f·codex 496 H/M1 采纳] 末次合并审对全分支复审发现两处：
//   H＝S2e 只拒「有 env 无开关」，没拒「有开关无 env」——运维传了 --allow-db-override 但 env 拼错/未导出/
//   被清空时，dbPath 会静默回落默认 task_pool.db，若又没带 --check-only 就是**真写生产库**，与开关"显式
//   放行覆盖路径"的语义正相反。改为对称：两种"只给一半"的组合全部拒绝，只有"都没给→默认库"/"都给了→
//   覆盖库"两态放行，空串 env 视为未设置，判定同样在 DB_ENCRYPTION_KEY 校验之前。
//   M1＝既有 `ENCRYPTION_KEY.length < 32` 校验的是 UTF-16 字符数不是字节数——含非 ASCII 字符的密钥可能
//   凑够 32 个"字符"却通不过 createCipheriv 的真实字节要求（或与服务端字节边界不一致而产生不兼容密文）。
//   派生逻辑（padEnd(32).slice(0,32) → Buffer）**保持与 server.js 逐字同款不动**——改派生本身才是真事故
//   （生产写入的密文会与服务端解密口径不一致）；只在校验层追加"仅 ASCII 可打印字符 + UTF-8 字节数≥32"
//   这一道防线，通不过就拒绝，不改派生。
//
// ⚠️ **本脚本非必须**：后端 loadSingleCommitGroupSystemSet 在 config 未写/为空时**回落代码默认清单**（见上），
//   即代码默认无需部署日手工写库即生效；两环境截至 2026-09-02 N0 探针均 NOT_FOUND。仅当需要在代码默认之外
//   显式改口径时才跑。config 一旦写入即以 config 为准（replace 语义）。
// ⚠️ 判定源单一：后端 isSingleCommitGroupSystem / loadSingleCommitGroupSystemSet 是唯一权威，前端只按
//   issue DTO（single_commit_group / group_label / allowed_components）渲染，改本 config 后前端自动跟随。

'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const T = require('../routes/sys-iteration/transitions');

function printUsage() {
  console.error('用法: node scripts/_set-sys-single-commit-group.js "<逗号分隔清单>" [--allow-drop] [--check-only] [--allow-db-override]');
  console.error('  例: node scripts/_set-sys-single-commit-group.js "HRD,电子签,RPA程序,小程序-智荟人力"');
  console.error(`  代码默认清单（权威源=transitions.js DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS）= ${T.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS.join(',')}`);
  console.error('  --allow-drop        写入值缺代码默认清单成员时，显式放行（默认缺项直接拒绝）');
  console.error('  --check-only        只做校验，通过则打印 CHECK_OK 并 exit 0，不打开 db、不写库');
  console.error('  --allow-db-override 显式放行 SYS_SINGLE_COMMIT_GROUP_DB_PATH 环境变量覆盖 db 路径（仅供守卫/演练脚本用；');
  console.error('                      设了该 env 却未带本开关 → 直接拒绝，防部署环境残留变量写错库）');
  console.error('  仅认以上三个开关字面量；未知开关（含拼错）/重复开关/位置参数数量≠1 一律直接拒绝。');
  console.error('  写库前（含 --check-only）恒打印一行 TARGET_DB=<解析后的绝对路径>。');
}

// ① 参数白名单 fail-closed：先于一切校验（含 DB_ENCRYPTION_KEY）——不给"拼错开关静默走默认分支"的空子。
const ALLOWED_FLAGS = new Set(['--allow-drop', '--check-only', '--allow-db-override']);
const rawArgs = process.argv.slice(2);
const flagArgs = rawArgs.filter((a) => a.startsWith('--'));
const positional = rawArgs.filter((a) => !a.startsWith('--'));

const unknownFlags = [...new Set(flagArgs.filter((a) => !ALLOWED_FLAGS.has(a)))];
const flagCounts = {};
for (const f of flagArgs) flagCounts[f] = (flagCounts[f] || 0) + 1;
const duplicatedFlags = Object.keys(flagCounts).filter((f) => flagCounts[f] > 1);

if (unknownFlags.length > 0 || duplicatedFlags.length > 0 || positional.length !== 1) {
  const reasons = [];
  if (unknownFlags.length > 0) reasons.push(`未知开关：${unknownFlags.join('、')}`);
  if (duplicatedFlags.length > 0) reasons.push(`重复开关：${duplicatedFlags.join('、')}`);
  if (positional.length !== 1) reasons.push(`位置参数数量应恰为 1，实际 ${positional.length} 个`);
  console.error(`[REJECT] 未知/非法参数：${reasons.join('；')}`);
  printUsage();
  process.exit(1);
}

const desired = positional[0].trim();
if (!desired) {
  console.error('[REJECT] 未知/非法参数：写入清单为空白字符串。');
  printUsage();
  process.exit(1);
}
const allowDrop = flagArgs.includes('--allow-drop');
const checkOnly = flagArgs.includes('--check-only');
const allowDbOverride = flagArgs.includes('--allow-db-override');

// ①b [S2e·codex 493-R2 M3 采纳，S2f·codex 496 H 采纳改对称] db 路径覆盖开关与 env 必须成对出现：
//   - 有 env 无开关 → 静默用测试路径覆盖生产写入（S2e 已堵：防部署环境残留该变量时脚本悄悄写去一个
//     意料之外的 db 文件）；
//   - 有开关无 env（或 env 为空串——视为未设置）→ 开关声明"我要覆盖"却没给覆盖去处，dbPath 会静默回落
//     默认 task_pool.db，若未同时带 --check-only 就是**真写生产库**，与开关"显式放行覆盖路径"的语义
//     相反（S2f 补上，此前只堵了一半）。
//   两种"只给一半"的组合全部拒绝，只有"都没给→默认库"/"都给了→覆盖库"两态放行，均在 DB_ENCRYPTION_KEY
//   校验之前判定。
const dbPathEnvRaw = process.env.SYS_SINGLE_COMMIT_GROUP_DB_PATH;
const dbPathEnvSet = typeof dbPathEnvRaw === 'string' && dbPathEnvRaw !== '';
if (dbPathEnvSet && !allowDbOverride) {
  console.error('[REJECT] 检测到 SYS_SINGLE_COMMIT_GROUP_DB_PATH 但未带 --allow-db-override（防部署环境残留变量写错库）');
  printUsage();
  process.exit(1);
}
if (allowDbOverride && !dbPathEnvSet) {
  console.error('[REJECT] 带了 --allow-db-override 但未设置 SYS_SINGLE_COMMIT_GROUP_DB_PATH（防拼错/未导出时静默写默认库）');
  printUsage();
  process.exit(1);
}

// ② DB_ENCRYPTION_KEY fail-closed（同 server.js 2026-08-26 约定：缺失即拒绝，不设任何默认回退值）。
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
  console.error('[FATAL] 环境变量 DB_ENCRYPTION_KEY 未设置或长度不足 32 字节。');
  console.error('        生成方式: openssl rand -base64 32 | cut -c1-32');
  console.error('        写入 wbs-server/.env 后重启。拒绝以弱加密启动（无默认回退）。');
  process.exit(1);
}
// ②b [S2f·codex 496 M1 采纳] 上面的 .length 是 UTF-16 字符数、不是字节数——含非 ASCII 字符的密钥可能
//   凑够 32 个"字符"却通不过 createCipheriv 的真实字节要求，或与服务端字节边界不一致产生不兼容密文。
//   派生逻辑（下方 padEnd(32).slice(0,32) → Buffer）保持与 server.js 逐字同款不动——改派生本身才是真
//   事故；这里只在校验层追加一道防线：仅接受 ASCII 可打印字符（\x21-\x7E，排除空白/控制符）且 UTF-8
//   字节数 ≥32。
if (!/^[\x21-\x7E]+$/.test(ENCRYPTION_KEY) || Buffer.byteLength(ENCRYPTION_KEY, 'utf8') < 32) {
  console.error('[FATAL] DB_ENCRYPTION_KEY 须为 ≥32 字节的 ASCII 可打印字符（与 server.js 同一派生口径）');
  process.exit(1);
}

// ③ ⊇ 校验：写入值必须覆盖代码默认清单全部成员，除非显式 --allow-drop。
const desiredSet = new Set(desired.split(',').map((s) => s.trim()).filter(Boolean));
const defaultList = T.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS;
const missing = defaultList.filter((sys) => !desiredSet.has(sys));
if (missing.length > 0 && !allowDrop) {
  console.error(`[REJECT] 写入值缺少代码默认清单成员：${missing.join('、')}`);
  console.error(`         代码默认清单（权威源=transitions.js DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS）= ${defaultList.join(',')}`);
  console.error('         replace 语义下漏填=该系统静默落成双组，不报错（codex 435 MED-1 登记的失败方向）。');
  console.error('         如确认要主动移出成员，显式带 --allow-drop 开关重跑。');
  process.exit(1);
}

// ③b [S2e·codex 493-R2 M3 采纳] 解析目标 db 绝对路径 + 可观测性兜底：无论走生产默认路径还是被显式
//   覆盖，写库前恒打印 TARGET_DB（含 --check-only 分支）——操作者/日志审计不必反查环境变量就能确认
//   这次到底动的是哪个文件。①b 已校验过 env 与开关成对（要么都没给要么都给了），此处直接消费
//   dbPathEnvSet/dbPathEnvRaw，不重复读取 process.env。
const dbPath = path.resolve(dbPathEnvSet ? dbPathEnvRaw : path.join(__dirname, '..', 'task_pool.db'));
console.log(`TARGET_DB=${dbPath}`);

// ④ --check-only：全部校验已通过，打印后直接退出，不打开 db、不写库。
if (checkOnly) {
  console.log(`CHECK_OK 将写入=${desired}`);
  process.exit(0);
}

// ── 以下才真正打开 db 写入（校验全部已在此之前完成）───────────────────────────
const sqlite3 = require('sqlite3');

// 逐字复刻 server.js encryptPassword（ENCRYPTION_KEY 已在上方 fail-closed 校验过，本地/生产用同一份约定）。
const IV_LENGTH = 16;
function encryptPassword(password) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// dbPath 已在③b 解析为绝对路径并打印 TARGET_DB（S2d 引入测试专用注入口子、S2e 加显式开关门槛，
//   见上方①b/③b）——此处直接复用，不重复计算，避免"打印的路径"与"真正打开的路径"因两处各自求值
//   而漂移。
const db = new sqlite3.Database(dbPath);

const encrypted = encryptPassword(desired);
db.run(
  `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
   VALUES ('sys_single_commit_group_systems', ?, NULL, '_set-sys-single-commit-group.js', datetime('now','localtime'))
   ON CONFLICT(config_key) DO UPDATE SET
     config_value_encrypted = excluded.config_value_encrypted,
     updated_by = excluded.updated_by,
     updated_by_name = excluded.updated_by_name,
     updated_at = excluded.updated_at`,
  [encrypted],
  function (err) {
    if (err) { console.error('写入失败:', err.message); db.close(); process.exit(1); }
    console.log(`system_configs.sys_single_commit_group_systems 已写入 = '${desired}'（changes=${this.changes}）`);
    db.close();
  }
);
