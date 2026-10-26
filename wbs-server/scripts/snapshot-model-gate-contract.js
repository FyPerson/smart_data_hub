// snapshot-model-gate-contract.js — 门禁响应契约快照（一次性对拍工具，不进 FAMILY；#77 C1c，方案 v0.9 §4.1.2「调用方替换」）
//
// 做什么：对「4 处门禁 + 3 处展示接口（+ 列表接口作额外观察）」，用同一份夹具库的两个副本分别起
//   「改前」（基线 01bac7ff，C1 之前）与「改后」（当前工作树）两个隔离实例，按一组覆盖各 state 的夹具发同样的请求，
//   比对 HTTP 状态码、响应 JSON 的键集合、错误文案、权限拒绝行为，把每一处差异规范化成一行，与**标准答案（golden）逐行全等比对**；
//   通过与否只看「缺失 / 多出」是否为空，不再用分类规则决定（旧「已知差异分类器」连续 5 轮被新构造的回归绕过，且只解释观察到的差异、
//   不要求预期变化出现，改动完全未生效也报 0 未归类——codex 22H，主会话裁定改路线）。
//
// 隔离方式与 verify-model-config-rev-http.js 相同（复用它导出的助手）：源码复制到临时目录自起（uploads/archive 落临时目录）、
//   库是临时目录里由被测代码自建的空库（不读本机 task_pool.db；无钉钉凭证 / 周期任务候选；出网由 net-guard 拦截）、端口走 listen-safe-port、按 pid 停止。
//   基线工作树由本工具在临时目录内 `git worktree add --detach <临时目录>/base-wt 01bac7ff`，结束时 `git worktree remove --force`；
//   依赖走 NODE_PATH，不需要在工作树里建 node_modules junction。也可用 --baseline-dir=<已有基线工作树的 wbs-server 目录> 复用。
//
// 用法：node scripts/snapshot-model-gate-contract.js [--golden=<golden 路径>] [--tmp=<临时根>] [--baseline-dir=<基线 wbs-server>] [--json=<输出 json 路径>]
//       node scripts/snapshot-model-gate-contract.js --write-golden <路径>   生成标准答案（须人审后提交；默认位置 scripts/fixtures/model-gate-contract/golden-diff.json）
//       node scripts/snapshot-model-gate-contract.js --self-test             自证（对照组 + R1 / R2 / R4 / R6 / R8 / R9）
//
// 行集合：每行 { fixture, endpoint, role, kind, path, before, after }，kind = status / key+ / key- / value（请求两侧的差异项）/ invariant / consistency / required-missing。
//   同一请求上的每一处差异都是独立一行，不做任何吸收；按 夹具顺序 / endpoint / role / kind / path 稳定排序。golden 里每行另附 note（原分类名，
//   只作人审注释，不参与比对；由 FLIPS / SCENARIOS.known 与几条通用规则映射，FLIPS 与 known 在这里只为生成 note 和必需字段断言服务）。
// 非确定性字段处理：行里只有「改前 / 改后响应的差异项」——token / pid / 端口 / 库路径 / 服务端时间戳从不进入（只有两侧取值不同的字段才成行，
//   两侧同值的 taskId / taskTitle / 夹具表名等不会成行）；夹具时间是写死的常量（C_TASK / T_LATE / L1 / L2）；归一化只对明确列出的字段路径做（NAME_FIELDS：taskTitle / table_name / tableName），
//   把夹具函数生成的带时间戳名字（mc_*_<base36>_<序号>）换成 <name:原长度>（保留长度标签，不同的值不会坍缩成同一行）。已实测：连续两次 --write-golden 生成的文件逐字节相同。
// 校验（默认）：实际行集合必须与 golden 逐行全等（多重集比较）；输出 缺失（golden 有、实际无——例如预期翻转没出现）/ 多出（实际有、golden 无——例如意外回归）/ 全等计数。
//   缺失或多出任一非空 → process.exitCode = 1；另有结构性断言：请求总数 === TOTAL_REQUESTS（246）、两侧实例都起来、net-guard 加载标记都在，任一失败也非 0。
// 必需字段断言（codex H4）：validation-status 单个与 batch 必含 state / gatePass；列表正常模型行必含 acceptance.state / at / rows；dev-status 的 deliverables.validation
//   必含 state / gatePass / ready；声明了拒绝文案的场景里门禁拒绝响应必含 reason / error。缺键本身产出一行 required-missing（也进 golden 比对；正常情况下不应出现在 golden 里）。
//   类型约束（kind = required-type）：state ∈ {pass, warn, fail, partial, stale, none, companion} 的字符串、gatePass / ready 为布尔、acceptance.at 为字符串或 null、
//   acceptance.rows 为数字或 null、顶层 reason / error 为非空字符串。
// golden 保护（codex 22R-H）：--write-golden 目标已存在 → 拒绝，除非显式 --force-overwrite-golden（打印醒目警告并先给出与旧 golden 的差异）；生成前存在任何
//   required-missing / required-type / invariant / consistency 行或结构性失败 → 拒绝写出；golden 头部写 schemaVersion、基线提交、生成时 git HEAD 与工作树是否干净；
//   校验模式加载时核 schemaVersion 与基线提交一致，不一致判红。golden 另含完整请求清单（fixture / endpoint / role / method / 账号 / 路径 / 查询 / 请求体非凭证字段，
//   token 不入），校验时请求多重集须与 golden 全等，且每个 fixture × endpoint × role 恰好一次。
// generatedFrom 的核对范围（codex 22-R3）：head 必须是当前 HEAD 的祖先（git merge-base --is-ancestor，命令失败或非祖先判红）；worktreeClean / dirtyFilesUnderWbsServer
//   只做类型校验——生成时工作树状态无法事后复核，仅作记录。expectedCombos 与请求构造两套规则靠一致性自检兜住：实际请求的 fixture×endpoint×role 全集 === expectedCombos，不等判红（--self-test 有少一条 / 多一条自证）。
// 已登记、本轮不改（codex 22-R3 登记项）：① 完整响应结构 schema 只做到「现有类型约束 + 必需字段」；② requestFingerprint 对嵌套 body / query 的动态数字不做递归按路径白名单归一化（现有夹具无嵌套动态字段）。
// 不变量（gatePass 自洽、门禁 gatePass = canSelfArchive、confirm 200↔真 403↔假、dev-status ready = gatePass）与跨接口一致性（以 validation-status 单个接口为唯一参照）
//   照旧逐行产出（kind = invariant / consistency）。
// --self-test：对照组（不改）须与 golden 全等；R1 / R2 / R4 / R6 / R8 注入后须出现缺失或多出且落在预期位置；R9「改后服务完全回退为基线实现」须因大量缺失判失败。
// 清理复查：worktree 清理之后复查 `git worktree list` 不含临时路径，失败输出 [cleanup-check] 诊断并置退出码 1。
// 出网拦截证明：每个起来的实例（含建库实例）的服务日志里必须有 `[net-guard] loaded pid=<所起进程 pid>`，缺失即失败。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const H = require('./verify-model-config-rev-http.js');

const BASELINE_COMMIT = '01bac7ff';
const C_TASK = '2026-03-10 12:00:00';
const T_EARLY = '2026-03-10 11:59:59';
const T_SAME = C_TASK;
const T_LATE = '2026-03-10 12:00:01';
const L1 = '2026-03-10 12:00:10';
const L2 = '2026-03-10 12:00:20';

// 逐字期望文案（手写，不从被测代码导入——导入就成了测自己）
const TX = {
  EARLIER: '当前版本的验收记录早于任务创建时间，请重新验收',
  SAME: '验收时间与任务创建时间在同一秒，请重新验收',
  STALE: '模型配置在最近一次验收之后已变更，请重新验收',
  NOLAYER: '该分层暂无验收判定规则',
  DEV_STALE: '配置已变更，需重新验收',
  DEV_NONE: '未执行验收',
};
const sameTx = (t) => ({ cs: t, at: t, cf: t });

// ───────────────────────────── 夹具清单 ─────────────────────────────
// known: [{ cls, flips: 'allow→deny' | 'deny→allow' }]（决策翻转）或 [{ cls, on: ['text'|'legacy'|'phases'] }]（决策不变时的文案 / 旧字段差异）
const SCENARIOS = [
  // ── ODS（任务类别 ODS_SYNC）
  { key: 'O1', title: 'ODS 当前版本 pass、晚于任务', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass' }] },
  { key: 'O2', title: 'ODS 当前版本 warn', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'warn' }] },
  { key: 'O3', title: 'ODS 当前版本 fail', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'fail' }] },
  { key: 'O4', title: 'ODS 无验收记录', layer: 'ODS', category: 'ODS_SYNC', records: [] },
  { key: 'O5', title: 'ODS pass 但配置已变更（记录 rev 1 < 模型 rev 2）', layer: 'ODS', category: 'ODS_SYNC', modelRev: 2, records: [{ result: 'pass', rev: 1 }] },
  { key: 'O6', title: 'ODS pass 记录 config_rev 为 NULL（迁移前遗留）', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass', rev: null }] },
  { key: 'O7', title: 'ODS pass 但验收早于任务创建 1 秒', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass', time: T_EARLY }] },
  { key: 'O8', title: 'ODS pass 与任务创建同一秒', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass', time: T_SAME }] },
  { key: 'O9', title: 'ODS 最新一条是 semantic pass，前一条 fail', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'fail', time: L1 }, { phase: 'semantic', result: 'pass', time: L2 }], known: [{ cls: 'semantic 排除', on: ['legacy'] }] },
  { key: 'O10', title: 'ODS pass 记录 invalidated 为 NULL', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass', invalidated: null }] },
  { key: 'O11', title: 'ODS 仅有 invalidated=1 的 pass', layer: 'ODS', category: 'ODS_SYNC', records: [{ result: 'pass', invalidated: 1 }] },
  { key: 'O12', title: '大写 layer=ODS 的模型挂 DWD_DEV 任务（quick-submit layerToCat 键全小写的落点），记录按 ODS 形态 pass', layer: 'ODS', category: 'DWD_DEV', records: [{ result: 'pass' }] },
  { key: 'O13', title: 'layer=ADS 的模型挂 DWD_DEV 任务，structure+data 均 pass', layer: 'ADS', category: 'DWD_DEV', records: [{ phase: 'structure', result: 'pass' }, { phase: 'data', result: 'pass' }], known: [{ cls: '非 ODS/DIM/DWD 分层返回 never', on: ['legacy', 'phases'] }] },
  { key: 'O14', title: 'ODS 配置已变更（rev 2）：旧版本先 pass（L1）后 fail（L2）——改前最新一条是 fail 拒绝，改后判 stale 并回显原因（决策同为拒绝）', layer: 'ODS', category: 'ODS_SYNC', modelRev: 2, records: [{ result: 'pass', rev: 1, time: L1 }, { result: 'fail', rev: 1, time: L2 }], known: [{ cls: 'MED-1 回显 reason', on: ['text'], expectText: { cs: TX.STALE, at: TX.STALE, cf: TX.STALE, dev: TX.DEV_STALE } }] },
  // ── DIM / DWD（任务类别 DIM_DEV / DWD_DEV）
  { key: 'D1', title: 'DIM structure + data 均 pass', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'structure', result: 'pass' }, { phase: 'data', result: 'pass' }], ownerConfirm: true },
  { key: 'D2', title: 'DWD 一条 phase=all pass', layer: 'DWD', category: 'DWD_DEV', records: [{ phase: 'all', result: 'pass' }], known: [{ cls: 'L2 phases', on: ['phases'] }] },
  { key: 'D3', title: 'DIM 仅 structure pass（缺 data）', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'structure', result: 'pass' }] },
  { key: 'D4', title: 'DIM 无验收记录', layer: 'DIM', category: 'DIM_DEV', records: [] },
  { key: 'D5', title: 'DIM 先 all pass、后 all fail', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'all', result: 'pass', time: L1 }, { phase: 'all', result: 'fail', time: L2 }], known: [{ cls: 'L2 phases', on: ['phases'] }] },
  { key: 'D6', title: 'DWD 先 all pass、后 structure fail', layer: 'DWD', category: 'DWD_DEV', records: [{ phase: 'all', result: 'pass', time: L1 }, { phase: 'structure', result: 'fail', time: L2 }], known: [{ cls: 'L2 phases', on: ['phases'] }] },
  { key: 'D7', title: 'DIM structure+data 均 pass 但配置已变更（rev 1 < 2）', layer: 'DIM', category: 'DIM_DEV', modelRev: 2, records: [{ phase: 'structure', result: 'pass', rev: 1 }, { phase: 'data', result: 'pass', rev: 1 }], known: [{ cls: 'G1（批量接口 phases 只取当前版本）', on: ['phases'] }] },
  { key: 'D8', title: 'DIM 只有 semantic pass', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'semantic', result: 'pass' }], known: [{ cls: 'semantic 排除', on: ['legacy'] }] },
  { key: 'D9', title: 'DIM structure pass + data warn', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'structure', result: 'pass' }, { phase: 'data', result: 'warn' }], known: [{ cls: '同秒取 id 大者（本夹具两条记录同一秒）', on: ['legacy', 'text'], expectText: { dev: `通过(有警告) (${T_LATE})` } }] },
  { key: 'D10', title: 'DIM structure+data pass 但早于任务创建 1 秒', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'structure', result: 'pass', time: T_EARLY }, { phase: 'data', result: 'pass', time: T_EARLY }] },
  { key: 'D11', title: 'DIM structure+data pass 与任务创建同一秒', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'structure', result: 'pass', time: T_SAME }, { phase: 'data', result: 'pass', time: T_SAME }] },
  { key: 'D12', title: '小写 layer=dwd、DWD_DEV、structure+data pass', layer: 'dwd', category: 'DWD_DEV', records: [{ phase: 'structure', result: 'pass' }, { phase: 'data', result: 'pass' }] },
  { key: 'D13', title: 'DWD structure 先 pass 后 fail、data pass', layer: 'DWD', category: 'DWD_DEV', records: [{ phase: 'structure', result: 'pass', time: L1 }, { phase: 'structure', result: 'fail', time: L2 }, { phase: 'data', result: 'pass', time: L1 }] },
  { key: 'D14', title: 'DIM 仅一条 all fail', layer: 'DIM', category: 'DIM_DEV', records: [{ phase: 'all', result: 'fail' }], known: [{ cls: 'L2 phases', on: ['phases'] }] },
  { key: 'D15', title: 'DIM 配置已变更（rev 2）：旧版本 structure+data pass（L1）后 structure fail（L2）——改前 structure 最新为 fail 拒绝，改后判 stale 并回显原因（决策同为拒绝）', layer: 'DIM', category: 'DIM_DEV', modelRev: 2, records: [{ phase: 'structure', result: 'pass', rev: 1, time: L1 }, { phase: 'data', result: 'pass', rev: 1, time: L1 }, { phase: 'structure', result: 'fail', rev: 1, time: L2 }], known: [{ cls: 'MED-1 回显 reason', on: ['text'], expectText: { cs: TX.STALE, at: TX.STALE, cf: TX.STALE, dev: TX.DEV_STALE } }, { cls: 'G1（批量接口 phases 只取当前版本）', on: ['phases'] }] },
  // ── 仅展示接口（无任务）
  { key: 'V1', title: '展示：layer=ADS 有验收记录', layer: 'ADS', category: null, records: [{ result: 'pass' }], known: [{ cls: '非 ODS/DIM/DWD 分层返回 never', on: ['legacy'] }] },
  { key: 'V2', title: '展示：DIM 模型只有无 phase 的 pass 记录', layer: 'DIM', category: null, records: [{ result: 'pass' }], known: [{ cls: '分层与记录形态不匹配被排除', on: ['legacy'] }] },
  { key: 'V3', title: '展示：模型行被物理删除（999001），记录仍在', ghostModel: 999001, layer: 'ODS', category: null, records: [{ result: 'pass' }], known: [{ cls: '模型行被物理删除返回 never', on: ['legacy'] }] },
  { key: 'V4', title: '展示：ODS 同秒两条记录（先 pass、后 fail，id 大者 fail）', layer: 'ODS', category: null, records: [{ result: 'pass', time: L1 }, { result: 'fail', time: L1 }], known: [{ cls: '同秒取 id 大者', on: ['legacy'] }] },
  { key: 'V5', title: '展示：DWD 伴生表（companion_of 非空）有 structure+data pass', layer: 'DWD', category: null, companion: true, records: [{ phase: 'structure', result: 'pass' }, { phase: 'data', result: 'pass' }], known: [{ cls: 'L2 phases', on: ['phases'] }] },
];


const ODS_FAIL_CS = '关联模型最近一次自测未通过';
// 决策翻转声明（按夹具）：cls 归类；dir 方向；endpoints 适用接口（cs=can-self-archive / at=archivable-task / cf=confirm / dev=dev-status，缺省全部）；
// expectText[接口] = 改后侧拒绝文案逐字（gate 的 reason / confirm 的 error / dev-status 的 detail）；expectOldText = 改前侧文案逐字（deny→allow 时）。
// confirm 的状态码固定 200↔403，gate 接口固定 HTTP 200，任何其他状态码都不归类。只有全等才吸收，同请求的其余差异逐项走普通分类。
const FLIPS = {
  // C1 对抗审 K3 起：管理员 / 发布者读 can-self-archive / archivable-task 时，关联 ODS 模型的任务与 confirm 的管理员旁路一致（不过验收门禁）——
  //   ODS 夹具的 cs / at 管理员请求不再随验收状态翻转（回到与基线一致的放行）；仍翻转的是 confirm（owner 角色）与 dev-status。下面 ODS 夹具的 endpoints 随之收窄。
  O3: [{ cls: 'K3 管理员 ODS 展示放行（与 confirm 旁路一致）', dir: 'deny→allow', endpoints: ['cs', 'at'] }],
  O4: [{ cls: 'K3 管理员 ODS 展示放行（与 confirm 旁路一致）', dir: 'deny→allow', endpoints: ['cs', 'at'] }],
  O11: [{ cls: 'K3 管理员 ODS 展示放行（与 confirm 旁路一致）', dir: 'deny→allow', endpoints: ['cs', 'at'] }],
  O14: [{ cls: 'K3 管理员 ODS 展示放行（与 confirm 旁路一致）', dir: 'deny→allow', endpoints: ['cs', 'at'] }],
  O5: [{ cls: 'G1', dir: 'allow→deny', endpoints: ['cf', 'dev'], expectText: { ...sameTx(TX.STALE), dev: TX.DEV_STALE } }],
  O6: [{ cls: 'G1（config_rev IS NULL 视为非当前版本）', dir: 'allow→deny', endpoints: ['cf', 'dev'], expectText: { ...sameTx(TX.STALE), dev: TX.DEV_STALE } }],
  D7: [{ cls: 'G1', dir: 'allow→deny', expectText: { ...sameTx(TX.STALE), dev: TX.DEV_STALE } }],
  O7: [{ cls: '早于任务', dir: 'allow→deny', endpoints: ['cf'], expectText: sameTx(TX.EARLIER) }],
  D10: [{ cls: '早于任务', dir: 'allow→deny', endpoints: ['cs', 'at', 'cf'], expectText: sameTx(TX.EARLIER) }],
  O8: [{ cls: '同秒', dir: 'allow→deny', endpoints: ['cf'], expectText: sameTx(TX.SAME) }],
  D11: [{ cls: '同秒', dir: 'allow→deny', endpoints: ['cs', 'at', 'cf'], expectText: sameTx(TX.SAME) }],
  O9: [{ cls: 'semantic 排除', dir: 'allow→deny', endpoints: ['cf', 'dev'], expectText: { cs: ODS_FAIL_CS, at: '最近一次自测未通过', cf: '关联模型最近一次自测未通过，请修复问题后重新自测', dev: `未通过 (${L1})` } }],
  O12: [{ cls: '分支键', dir: 'deny→allow', endpoints: ['cs', 'at', 'cf'], expectOldText: { cs: 'DWD 结构验收尚未通过', at: 'DWD 结构验收尚未通过', cf: 'DWD 结构验收尚未通过，请先执行结构验收' } }],
  // C1 对抗审 G4 起：其余 layer（ADS 等）的任务管理员不再执行验收门禁，cs / at / cf 三接口与基线一致、不再翻转；只剩 dev-status 的 ready 翻转
  O13: [{ cls: '分支键', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: TX.DEV_NONE } }],
  D3: [{ cls: '追加 partial 态（dev-status ready 由 true 变 false）', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: `仅完成部分阶段验收 (${T_LATE})` } }],
  D5: [{ cls: 'G2', dir: 'allow→deny', endpoints: ['cs', 'at', 'cf'], expectText: { cs: 'DIM 结构验收尚未通过', at: 'DIM 结构验收尚未通过', cf: 'DIM 结构验收尚未通过，请先执行结构验收' } }],
  D6: [{ cls: 'G2', dir: 'allow→deny', endpoints: ['cs', 'at', 'cf'], expectText: { cs: 'DWD 结构验收尚未通过', at: 'DWD 结构验收尚未通过', cf: 'DWD 结构验收尚未通过，请先执行结构验收' } }],
  D8: [{ cls: 'semantic 排除', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: TX.DEV_NONE } }],
  V1: [{ cls: '分支键（其他分层一律 none）', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: TX.DEV_NONE } }],
  V2: [{ cls: '分层与记录形态不匹配被排除', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: TX.DEV_NONE } }],
  V4: [{ cls: '同秒取 id 大者', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: `未通过 (${L1})` } }],
  V5: [{ cls: '追加 companion 态（dev-status ready 由 true 变 false）', dir: 'allow→deny', endpoints: ['dev'], expectText: { dev: '伴生表不独立验收' } }],
};

// ───────────────────────────── 夹具造数 ─────────────────────────────
async function seedFixtures(db, fx, users) {
  const manifest = [];
  const revOf = (s) => s.modelRev || 1;
  async function makeModel(s, suffix) {
    const modelId = await fx.model({ layer: s.layer, table_name: `snap_${s.key.toLowerCase()}_${suffix}`, status: 'REVIEWING', tech_owner: 'snap_tech', config_rev: revOf(s), companion_of: null });
    if (s.companion) {
      const parent = await fx.model({ layer: 'DWD', table_name: `snap_${s.key.toLowerCase()}_${suffix}_parent`, status: 'REVIEWING' });
      await db.run('UPDATE data_models SET companion_of = ?, config_mode = ? WHERE id = ?', [parent, 'companion', modelId]);
    }
    for (const r of s.records) {
      const rev = r.rev === undefined ? revOf(s) : r.rev;
      const rid = await fx.record(modelId, { phase: r.phase || null, result: r.result, time: r.time || T_LATE, rev, invalidated: r.invalidated === undefined ? 0 : r.invalidated });
      void rid;
    }
    return modelId;
  }
  for (const s of SCENARIOS) {
    const entry = { key: s.key, title: s.title, known: s.known || [], category: s.category, hasTask: !!s.category, confirms: [] };
    entry.readModel = await makeModel(s, 'r');
    if (s.ghostModel) {
      // 物理删除：模型行删掉，记录保留并改挂到幽灵 id
      await db.run('UPDATE model_test_records SET model_id = ? WHERE model_id = ?', [s.ghostModel, entry.readModel]);
      await db.run('DELETE FROM data_models WHERE id = ?', [entry.readModel]);
      entry.ghostModel = s.ghostModel;
      entry.readModel = s.ghostModel;
    }
    if (s.category) {
      entry.readTask = await fx.task({ status: 'DONE', category: s.category, linked_model_id: entry.readModel, owner: users.owner.display_name, owner_id: users.owner.id, created_at: C_TASK, done_at: C_TASK });
      const roles = s.category === 'ODS_SYNC' ? ['owner', 'admin'] : (s.ownerConfirm ? ['admin', 'owner'] : ['admin']);
      if (s.category === 'DWD_DEV' && s.layer === 'ODS') roles.push('owner');
      for (const as of roles) {
        const mid = await makeModel(s, `c_${as}`);
        const tid = await fx.task({ status: 'DONE', category: s.category, linked_model_id: mid, owner: users.owner.display_name, owner_id: users.owner.id, created_at: C_TASK, done_at: C_TASK });
        entry.confirms.push({ as, modelId: mid, taskId: tid });
      }
    }
    manifest.push(entry);
  }
  // 权限行为夹具：任务属于 owner；other / viewer 去访问
  const pModel = await fx.model({ layer: 'ODS', table_name: 'snap_perm_model', status: 'REVIEWING', tech_owner: 'snap_tech' });
  await fx.record(pModel, { phase: null, result: 'pass', time: T_LATE });
  const pTask = await fx.task({ status: 'DONE', category: 'ODS_SYNC', linked_model_id: pModel, owner: users.owner.display_name, owner_id: users.owner.id, created_at: C_TASK, done_at: C_TASK });
  return { manifest, perm: { modelId: pModel, taskId: pTask } };
}

// ───────────────────────────── 请求清单 ─────────────────────────────
function buildRequests(seed, users) {
  const reqs = [];
  const tok = (who) => users[who] ? users[who].token : undefined;
  for (const e of seed.manifest) {
    if (e.hasTask) {
      reqs.push({ key: e.key, label: 'can-self-archive[admin]', kind: 'gate-json', method: 'GET', url: `/api/tasks/${e.readTask}/can-self-archive`, token: tok('admin') });
      reqs.push({ key: e.key, label: 'archivable-task[admin]', kind: 'gate-json', method: 'GET', url: `/api/models/${e.readModel}/archivable-task`, token: tok('admin') });
    }
    reqs.push({ key: e.key, label: 'validation-status', kind: 'display', method: 'GET', url: `/api/models/${e.readModel}/validation-status`, token: tok('admin') });
    reqs.push({ key: e.key, label: 'dev-status', kind: 'dev-status', method: 'GET', url: `/api/models/${e.readModel}/dev-status`, token: tok('admin') });
  }
  // 批量接口：一次请求全部，按 id 拆回各夹具
  const ids = seed.manifest.map(e => e.readModel);
  reqs.push({ key: '*', label: 'validation-status/batch', kind: 'batch', method: 'GET', url: `/api/models/validation-status/batch?ids=${ids.join(',')}`, token: tok('admin'), ids });
  reqs.push({ key: '*', label: 'GET /api/models（列表，额外观察）', kind: 'list', method: 'GET', url: '/api/models?keyword=snap_', token: tok('admin') });
  // 权限行为
  const p = seed.perm;
  reqs.push({ key: 'P', label: 'can-self-archive[无 token]', kind: 'gate-json', method: 'GET', url: `/api/tasks/${p.taskId}/can-self-archive` });
  reqs.push({ key: 'P', label: 'can-self-archive[非 owner 的 user]', kind: 'gate-json', method: 'GET', url: `/api/tasks/${p.taskId}/can-self-archive`, token: tok('other') });
  reqs.push({ key: 'P', label: 'archivable-task[非 owner 的 user]', kind: 'gate-json', method: 'GET', url: `/api/models/${p.modelId}/archivable-task`, token: tok('other') });
  reqs.push({ key: 'P', label: 'archivable-task[viewer 读]', kind: 'gate-json', method: 'GET', url: `/api/models/${p.modelId}/archivable-task`, token: tok('viewer') });
  reqs.push({ key: 'P', label: 'confirm[viewer]', kind: 'confirm', method: 'POST', url: '/api/confirm', token: tok('viewer'), body: { id: p.taskId } });
  reqs.push({ key: 'P', label: 'confirm[非 owner 的 user]', kind: 'confirm', method: 'POST', url: '/api/confirm', token: tok('other'), body: { id: p.taskId } });
  reqs.push({ key: 'P', label: 'confirm[无 token]', kind: 'confirm', method: 'POST', url: '/api/confirm', body: { id: p.taskId } });
  reqs.push({ key: 'P', label: 'confirm[缺 id]', kind: 'confirm', method: 'POST', url: '/api/confirm', token: tok('admin'), body: {} });
  reqs.push({ key: 'P', label: 'confirm[任务不存在]', kind: 'confirm', method: 'POST', url: '/api/confirm', token: tok('admin'), body: { id: 99999999 } });
  // confirm 放最后（会把任务归档、改模型状态）
  for (const e of seed.manifest) for (const c of e.confirms) {
    reqs.push({ key: e.key, label: `confirm[${c.as}]`, kind: 'confirm', method: 'POST', url: '/api/confirm', token: tok(c.as), body: { id: c.taskId } });
  }
  return reqs;
}

// ───────────────────────────── 比对 ─────────────────────────────
function flatten(v, prefix, out) {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) { v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out)); if (v.length === 0) out.set(prefix, '[]'); }
    else { const ks = Object.keys(v); if (ks.length === 0) out.set(prefix, '{}'); for (const k of ks) flatten(v[k], prefix ? `${prefix}.${k}` : k, out); }
  } else out.set(prefix, JSON.stringify(v));
  return out;
}
function normalize(res) { return { status: res.status, flat: res.json !== null ? flatten(res.json, '', new Map()) : new Map([['<text>', JSON.stringify(res.text.slice(0, 200))]]) }; }

function decisionOf(kind, n) {
  if (kind === 'gate-json') { const v = n.flat.get('canSelfArchive'); return v === 'true' ? 'allow' : v === 'false' ? 'deny' : 'n/a'; }
  // confirm：200 = allow、403 = deny，其他状态码（500 / 401 / 400…）一律 n/a——不当成「拒绝」去吸收，直接进未归类
  if (kind === 'confirm') return n.status === 200 ? 'allow' : n.status === 403 ? 'deny' : 'n/a';
  if (kind === 'dev-status') { const v = n.flat.get('deliverables.validation.ready'); return v === 'true' ? 'allow' : v === 'false' || v === 'null' ? 'deny' : 'n/a'; }
  return 'n/a';
}
function endpointOf(label) {
  if (/^can-self-archive/.test(label)) return 'cs';
  if (/^archivable-task/.test(label)) return 'at';
  if (/^confirm/.test(label)) return 'cf';
  if (/^dev-status/.test(label)) return 'dev';
  return null;
}

const J = (v) => JSON.stringify(v);

function diffOne(before, after) {
  const items = [];
  if (before.status !== after.status) items.push({ type: 'status', path: 'HTTP status', before: String(before.status), after: String(after.status) });
  for (const k of after.flat.keys()) if (!before.flat.has(k)) items.push({ type: 'key+', path: k, before: '（无）', after: after.flat.get(k) });
  for (const k of before.flat.keys()) if (!after.flat.has(k)) items.push({ type: 'key-', path: k, before: before.flat.get(k), after: '（无）' });
  for (const [k, v] of before.flat) if (after.flat.has(k) && after.flat.get(k) !== v) items.push({ type: 'value', path: k, before: v, after: after.flat.get(k) });
  return items;
}

// 自洽不变量（新增键要核值，不只核出现）：只看改后侧响应，任一违反即单列一条未归类，不进任何已知差异类。
//   ① 任何带 gatePass 的对象：gatePass 必须是布尔，且 === (同级 state 是 pass 或 warn)；带 state 不带 gatePass 也算违反（同级须成对）；
//   ② 门禁接口（cs / at）：gatePass 若存在，必须 === canSelfArchive；
//   ③ confirm：200 ⇒ gatePass 若存在须为 true，403 ⇒ 若存在须为 false；
//   ④ dev-status：deliverables.validation.ready 必须 === deliverables.validation.gatePass（两者都须存在）。
// 期望值手写（gatePass 恒等于 state ∈ {pass, warn}），不从被测代码导入。
function invariantViolations(ep, statusCode, flat) {
  const out = [];
  const OK_STATES = new Set([J('pass'), J('warn')]);
  for (const k of flat.keys()) {
    const isGp = k === 'gatePass' || k.endsWith('.gatePass');
    // 只核顶层 state 必须带 gatePass；嵌套的 state（列表接口 acceptance = { state, at, rows }、dev-status 的 validation.state）不强制成对——
    //   列表的 acceptance 摘要按设计不带 gatePass；嵌套 state 若与 gatePass 同级出现，上面 isGp 分支已按值核
    const isSt = k === 'state';
    if (isGp) {
      const prefix = k.slice(0, k.length - 'gatePass'.length);
      const gp = flat.get(k);
      if (gp !== 'true' && gp !== 'false') { out.push({ name: `${k} 必须是布尔`, expect: 'true | false', actual: gp }); continue; }
      if (flat.has(`${prefix}state`)) {
        const st = flat.get(`${prefix}state`);
        const want = OK_STATES.has(st) ? 'true' : 'false';
        if (gp !== want) out.push({ name: `${k} === (${prefix}state ∈ {pass, warn})`, expect: `${k}=${want}（state=${st}）`, actual: `${k}=${gp}` });
      }
    } else if (isSt) {
      const prefix = k.slice(0, k.length - 'state'.length);
      if (!flat.has(`${prefix}gatePass`)) out.push({ name: `${k} 与 gatePass 须成对出现`, expect: `${prefix}gatePass 存在`, actual: '（无）' });
    }
  }
  if ((ep === 'cs' || ep === 'at') && flat.has('gatePass') && flat.has('canSelfArchive') && flat.get('gatePass') !== flat.get('canSelfArchive')) {
    out.push({ name: '门禁接口 gatePass === canSelfArchive', expect: `gatePass=${flat.get('canSelfArchive')}`, actual: `gatePass=${flat.get('gatePass')}` });
  }
  if (ep === 'cf' && flat.has('gatePass')) {
    if (statusCode === 200 && flat.get('gatePass') !== 'true') out.push({ name: 'confirm 200 ⇒ gatePass 为真', expect: 'gatePass=true', actual: `gatePass=${flat.get('gatePass')}` });
    if (statusCode === 403 && flat.get('gatePass') !== 'false') out.push({ name: 'confirm 403 ⇒ gatePass 为假', expect: 'gatePass=false', actual: `gatePass=${flat.get('gatePass')}` });
  }
  if (ep === 'dev') {
    const rd = flat.get('deliverables.validation.ready'), gp = flat.get('deliverables.validation.gatePass');
    // 模型行被物理删除（V3）时响应里没有 deliverables.validation，两者都缺席 = 无可核对对象；只要有一个出现，两者都须在且相等
    if ((rd !== undefined || gp !== undefined) && (rd === undefined || gp === undefined || rd !== gp)) out.push({ name: 'dev-status deliverables.validation.ready === gatePass', expect: `ready=${rd}（须与 gatePass 相同且两者都存在）`, actual: `gatePass=${gp === undefined ? '（无）' : gp}` });
  }
  return out;
}
const invariantRows = (fixture, label, vs) => vs.map(v => ({ fixture, label, kind: 'invariant', path: v.name, before: v.expect, after: v.actual }));

// 跨接口一致性（按值核，一条约束覆盖全部「新增键」）：每个夹具模型，把改后侧 validation-status 单个接口的结果当作该模型判定的唯一参照——
//   列表行 acceptance.state === state、acceptance.at === state_at（无 state_at 视为 null）；
//   validation-status/batch 的 state / gatePass 与单个接口全等；
//   dev-status 的 deliverables.validation.state === state 且 gatePass 相同；
//   门禁接口（can-self-archive / archivable-task，带 state 时）的 state / gatePass 与单个接口全等——
//   门禁带任务时间条件的夹具（FLIPS 里声明为「早于任务 / 同秒」的那几个）除外：它们的门禁判定含任务创建时间，本就与不带任务的展示接口不同，由 FLIPS 逐字声明管。
// 违反即单列一条未归类（类别名写清是哪两个接口不一致）。
const GATE_TIME_CLASSES = new Set(['早于任务', '同秒']);
function consistencyViolations(afterFlats, manifest) {
  const out = [];
  const T = (f, k) => (f.has(k) ? f.get(k) : undefined);
  for (const e of manifest) {
    const ref = afterFlats.get(`${e.key}|validation-status`);
    if (!ref) continue;
    const rState = T(ref, 'state'), rGate = T(ref, 'gatePass'), rAt = T(ref, 'state_at') === undefined ? 'null' : T(ref, 'state_at');
    const push = (pair, what, expect, actual) => out.push({ fixture: e.key, label: pair.label, kind: 'consistency', path: `${pair.name}：${what}`, before: `${expect}`, after: `${actual}` });
    const list = afterFlats.get(`${e.key}|GET /api/models（列表，额外观察）`);
    if (list && list.has('acceptance.state')) {
      const P = { label: 'GET /api/models（列表，额外观察）', name: '列表 acceptance 与 validation-status 单个接口不一致' };
      if (list.get('acceptance.state') !== rState) push(P, 'acceptance.state', rState, list.get('acceptance.state'));
      const at = list.has('acceptance.at') ? list.get('acceptance.at') : 'null';
      if (at !== rAt) push(P, 'acceptance.at', rAt, at);
    }
    const batch = afterFlats.get(`${e.key}|validation-status/batch`);
    if (batch) {
      const P = { label: 'validation-status/batch', name: 'validation-status/batch 与 validation-status 单个接口不一致' };
      for (const [k, want] of [['state', rState], ['gatePass', rGate]]) if (T(batch, k) !== want) push(P, k, want, T(batch, k));
    }
    const dev = afterFlats.get(`${e.key}|dev-status`);
    if (dev && (dev.has('deliverables.validation.state') || dev.has('deliverables.validation.gatePass'))) {
      const P = { label: 'dev-status', name: 'dev-status 与 validation-status 单个接口不一致' };
      if (T(dev, 'deliverables.validation.state') !== rState) push(P, 'deliverables.validation.state', rState, T(dev, 'deliverables.validation.state'));
      if (T(dev, 'deliverables.validation.gatePass') !== rGate) push(P, 'deliverables.validation.gatePass', rGate, T(dev, 'deliverables.validation.gatePass'));
    }
    const timed = (FLIPS[e.key] || []).some(d => GATE_TIME_CLASSES.has(d.cls));
    if (!timed) {
      for (const [lab, nm] of [['can-self-archive[admin]', 'can-self-archive'], ['archivable-task[admin]', 'archivable-task']]) {
        const g = afterFlats.get(`${e.key}|${lab}`);
        if (!g || !(g.has('state') || g.has('gatePass'))) continue;
        const P = { label: lab, name: `${nm} 与 validation-status 单个接口不一致` };
        for (const [k, want] of [['state', rState], ['gatePass', rGate]]) if (T(g, k) !== want) push(P, k, want, T(g, k));
      }
    }
  }
  return out;
}

// ───────────────────────────── 自证用回归（在临时副本里注入，不改仓库源码）─────────────────────────────
// 每个回归注入后，实际行集合与 golden 必须出现「缺失或多出」（verdict 失败、校验模式会非 0 退出），且差异落在预期的位置（expect）。
// R1：早于任务的拒绝文案丢失（acceptance.js 的 reason 置空）——只在翻转夹具 O7 / D10 上可见
// R2：confirm 非 admin ODS 早于任务：状态码 403 → 500 且错误文案换成「权限不足」——权限拒绝行为变化
const REGRESSIONS = {
  'r1-early-text': {
    file: 'routes/model-center/acceptance.js',
    from: '        else reason = EARLIER_THAN_TASK_REASON;',
    to: "        else reason = '';",
    expect: (d) => diffTouches(d, r => (r.fixture === 'O7' || r.fixture === 'D10') && /reason|error/.test(r.path)),
    expectDesc: '缺失或多出里出现 O7 / D10 的 reason / error 行',
  },
  'r2-confirm-status': {
    file: 'server.js',
    from: "                    return res.status(403).json({\n                        error: odsGateFailText(ev, '关联模型尚未进行自测，请先完成ODS自动验收', '关联模型最近一次自测未通过，请修复问题后重新自测'),",
    to: "                    return res.status(ev.reason && ev.reason.indexOf('早于任务') >= 0 ? 500 : 403).json({\n                        error: ev.reason && ev.reason.indexOf('早于任务') >= 0 ? '权限不足，您不是该任务的持有者' : odsGateFailText(ev, '关联模型尚未进行自测，请先完成ODS自动验收', '关联模型最近一次自测未通过，请修复问题后重新自测'),",
    expect: (d) => diffTouches(d, r => r.fixture === 'O7' && r.endpoint === 'confirm' && r.role === 'owner' && r.kind === 'status'),
    expectDesc: '缺失或多出里出现 O7 confirm[owner] 的 HTTP status 行（403 → 500）',
  },
  // R4：can-self-archive 的 ODS 拒绝分支返回 state:'pass'、gatePass:true（canSelfArchive 仍为 false）——键集合与改前相比只是「追加 state / gatePass」，
  //   旧版「只核出现」会把它归进「追加 state 与 gatePass」；新版按值核自洽不变量（gatePass === canSelfArchive）必须把它判成未归类
  //   （K3 起管理员对 ODS 不过门禁、快照里 can-self-archive 只有管理员请求——ODS 拒绝分支已不可达，改注入在 DIM / DWD 拒绝分支，同样产出 gatePass 自洽性违例）
  'r4-gatepass-lie': {
    file: 'server.js',
    from: "return res.json({ canSelfArchive: false, reason: dimDwdGateFailText(dec.gate, dec.layer).text, state: dec.gate.state, gatePass: false });",
    to: "return res.json({ canSelfArchive: false, reason: dimDwdGateFailText(dec.gate, dec.layer).text, state: 'pass', gatePass: true });",
    expect: (d) => diffTouches(d, r => r.endpoint === 'can-self-archive' && (r.kind === 'invariant' || /gatePass/.test(r.path))),
    expectDesc: '缺失或多出里出现 can-self-archive 的 gatePass 行或 invariant 行',
  },
  // R6：列表接口每行 acceptance.state 恒为 'pass'——键集合与改前相同（只是「追加 acceptance」），旧版只核出现会吸收；
  //   跨接口一致性（列表 acceptance.state 必须等于 validation-status 单个接口的 state）必须把它判成未归类
  'r6-list-state-const': {
    file: 'server.js',
    from: 'r.acceptance = { state: ev.state, at: ev.at, rows: ev.rows };',
    to: "r.acceptance = { state: 'pass', at: ev.at, rows: ev.rows };",
    expect: (d) => diffTouches(d, r => r.endpoint === 'list' && /acceptance\.state/.test(r.path)),
    expectDesc: '缺失或多出里出现列表接口 acceptance.state 的行',
  },
  // R8：dev-status 的 deliverables.validation.state 在 gatePass 为假时恒 'fail'——与 gatePass 自洽（不违反不变量），但值错；
  //   只有跨接口一致性（与 validation-status 单个接口的 state 比）能抓到
  'r8-dev-state-fail': {
    file: 'server.js',
    from: '            state: accEv.state,\n            gatePass: accEv.gatePass',
    to: "            state: accEv.gatePass ? accEv.state : 'fail',\n            gatePass: accEv.gatePass",
    expect: (d) => diffTouches(d, r => r.endpoint === 'dev-status' && /validation\.state/.test(r.path)),
    expectDesc: '缺失或多出里出现 dev-status 的 deliverables.validation.state 行',
  },
  // R9（codex 22H H1 反例）：改后服务完全回退为基线实现——所有响应都与改前相同，旧「只分类观察到的差异」会报 0 未归类假绿；
  //   标准答案制下 golden 里全部预期变化都缺失 ⇒ 必须大量「缺失」。不改源码，改后实例直接用基线代码起。
  'r9-after-is-baseline': {
    useBaselineAsAfter: true,
    expect: (d, golden) => d.missing.length >= Math.floor(golden.length * 0.9),
    expectDesc: '缺失行数 ≥ golden 行数的 90%（预期变化几乎全部缺失；多出的 required-missing 行另计）',
  },
};
// 差异里（缺失或多出）是否有满足谓词的行
const diffTouches = (d, pred) => d.missing.some(pred) || d.extra.some(pred);

// ───────────────────────────── 主流程 ─────────────────────────────
function copyFile(a, b) { fs.copyFileSync(a, b); }

// 准备阶段（只做一次）：基线工作树 + 空库自建 + 一次性写夹具
async function prepare(argOf) {
  const runDir = H.makeRunDir('snap');
  let baselineRoot = argOf('--baseline-dir=');
  if (!baselineRoot) {
    const wt = path.join(runDir, 'base-wt');
    if (!wt.startsWith(H.TMP_BASE + path.sep)) throw new Error('基线工作树必须建在临时根内');
    const repoRoot = path.resolve(H.ROOT, '..');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', wt, BASELINE_COMMIT], { stdio: 'pipe' });
    H.registerCleanup(() => {
      try { execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }); } catch (_) { /* 下面 prune + 复查 */ }
      try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'ignore' }); } catch (_) { /* 下面复查 */ }
      // 复查：worktree 列表不得再含临时路径，目录也不得还在（runDir 的 removeTree 在其后运行并另行复查）
      let listed = '';
      try { listed = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }); } catch (e) { H.noteCleanupFailure(`git worktree list 失败：${e.message}`); return; }
      const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
      if (norm(listed).includes(norm(wt))) H.noteCleanupFailure(`git worktree list 仍含临时路径：${wt}`);
    });
    baselineRoot = path.join(wt, 'wbs-server');
  }
  const rev = execFileSync('git', ['-C', path.resolve(H.ROOT, '..'), 'log', '-1', '--format=%h', '--', 'wbs-server/server.js'], { encoding: 'utf8' }).trim();
  console.log(`基线代码：${baselineRoot}（${BASELINE_COMMIT}）；改后代码：当前工作树 ${H.ROOT}（server.js 最近提交 ${rev}，含未提交改动）`);

  // 夹具库：不读本机 task_pool.db。临时目录建空库 → 用改后代码启动一次自建全部表 → 停服务 → 一次性写夹具 → 复制成 before / after 两份；
  //   两个实例运行期间本工具不连库（无读无写），所有请求都走 HTTP。
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const seedDb = path.join(runDir, 'seed.db');
  const seedCode = H.copyCode(H.ROOT, path.join(runDir, 'svc-seed'), 'seed');
  const fresh = await H.createFreshDb(H.makeService({ copyRoot: seedCode.copyRoot, dbPath: seedDb, tag: 'seed', gate }));
  const db = await H.openWriter(seedDb, gate);
  await db.get('PRAGMA journal_mode = WAL');
  const fx = H.makeFixtures(db);
  const users = { admin: await fx.user('snap_admin', 'admin'), owner: await fx.user('snap_owner', 'user'), other: await fx.user('snap_other', 'user'), viewer: await fx.user('snap_viewer', 'viewer') };
  const seed = await seedFixtures(db, fx, users);
  await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.close();
  return { runDir, baselineRoot, seedDb, seed, users, report: fresh.report };
}


// ───────────────────────────── 行集合（标准答案制）─────────────────────────────
// 每个差异 = 一行 { fixture, endpoint, role, kind, path, before, after }，同一请求上的每一处差异都是独立一行，不做任何吸收。
const TOTAL_REQUESTS = 246;   // 比对单元总数（批量 / 列表按夹具拆开计，含权限行为 / confirm），写死：夹具或请求清单变了必须同步改，不符即失败
const TOTAL_HTTP_REQUESTS = 180;   // 实际发出的 HTTP 请求条数（批量 / 列表各一条，按夹具拆开后才是上面的 246 个比对单元）；请求清单条数必须等于它
const GOLDEN_DEFAULT = path.join(__dirname, 'fixtures', 'model-gate-contract', 'golden-diff.json');

function splitLabel(label) {
  const m = /^(can-self-archive|archivable-task|confirm)\[(.+)\]$/.exec(label);
  if (m) return { endpoint: m[1], role: m[2] };
  if (/^GET \/api\/models（列表/.test(label)) return { endpoint: 'list', role: '' };
  return { endpoint: label, role: '' };
}
// 非确定性字段处理：行里只有「改前 / 改后响应的差异项」，token / pid / 端口 / 库路径 / 时间戳型服务端字段从不进入（只有两侧不同的字段才成行，
// 且两侧同值的 taskTitle / 夹具表名等不会成行）；夹具里的时间是写死的常量（C_TASK / T_LATE / L1 / L2）。
// 归一化只对明确列出的字段做（NAME_FIELDS：taskTitle / table_name / tableName，路径最后一段命中才处理），把夹具函数生成的带时间戳名字
// （mc_*_<base36>_<序号>）换成 <name:原长度>——保留长度标签，不让不同的值坍缩成同一行；其余字段的值一律原样进比较键。
const NAME_FIELDS = new Set(['taskTitle', 'table_name', 'tableName']);
function scrubField(p, v) {
  const s = String(v);
  const last = String(p).split('.').pop().replace(/\[\d+\]$/, '');
  return NAME_FIELDS.has(last) ? s.replace(/mc_[a-z]+_[0-9a-z]{6,}_\d+/g, (m) => `<name:${m.length}>`) : s;
}
const mkRow = (fixture, label, kind, p, before, after) => ({ fixture, ...splitLabel(label), kind, path: p, before: scrubField(p, before), after: scrubField(p, after) });
const rowKey = (r) => JSON.stringify([r.fixture, r.endpoint, r.role, r.kind, r.path, r.before, r.after]);
const FIXTURE_ORDER = new Map([...SCENARIOS.map((s, i) => [s.key, i]), ['P', SCENARIOS.length], ['*', SCENARIOS.length + 1]]);
function sortRows(rows) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.slice().sort((x, y) => (FIXTURE_ORDER.get(x.fixture) - FIXTURE_ORDER.get(y.fixture)) || cmp(x.endpoint, y.endpoint) || cmp(x.role, y.role) || cmp(x.kind, y.kind) || cmp(x.path, y.path) || cmp(x.before, y.before) || cmp(x.after, y.after));
}

// note：只作人审注释，不参与任何判定（原分类名的最小映射）
const EP_CODE = { 'can-self-archive': 'cs', 'archivable-task': 'at', confirm: 'cf', 'dev-status': 'dev' };
function noteOf(r) {
  if (['invariant', 'consistency', 'required-missing'].includes(r.kind)) return r.kind;
  const last = r.path.split('.').pop();
  if (r.kind === 'key+' && /^acceptance(\.|$)/.test(r.path)) return '追加 acceptance（列表）';
  if (r.kind === 'key+' && ['state', 'gatePass', 'state_at', 'state_test_user'].includes(last) && !/phases/.test(r.path)) return '追加 state 与 gatePass';
  if (r.kind === 'key+' && /(^|\.)phases\.[^.]+\.test_user$/.test(r.path)) return 'L2 phases';
  if (r.kind === 'key+' && r.path === 'deliverables.validation.ready') return 'ready 恒为布尔值';
  const ep = EP_CODE[r.endpoint];
  const decl = (FLIPS[r.fixture] || []).find(d => ep && (!d.endpoints || d.endpoints.includes(ep)));
  if (decl) return decl.cls;
  const s = SCENARIOS.find(x => x.key === r.fixture);
  if (s && s.known && s.known.length) return s.known[0].cls;
  return '（无注释）';
}

// 必需字段断言（codex H4）：缺键本身产出一行 required-missing（也进 golden 比对；正常情况下不应出现在 golden 里）
function requiredRows(fixture, label, flat, status, entry, decisionAfter) {
  const out = [];
  const miss = (p) => out.push(mkRow(fixture, label, 'required-missing', p, '（必需字段）', '（缺失）'));
  const has = (k) => flat.has(k);
  const ghost = !!(entry && entry.ghostModel);
  const { endpoint } = splitLabel(label);
  if (label === 'validation-status' || label === 'validation-status/batch') {
    for (const k of ['state', 'gatePass']) if (!has(k)) miss(k);
  } else if (endpoint === 'list') {
    if (has('<缺该项>')) { if (!ghost) miss('list row'); }
    else {
      for (const k of ['acceptance.state', 'acceptance.at']) if (!has(k)) miss(k);
      if (!has('acceptance.rows') && ![...flat.keys()].some(k => k.startsWith('acceptance.rows['))) miss('acceptance.rows');
    }
  } else if (label === 'dev-status') {
    if (!ghost) for (const k of ['deliverables.validation.state', 'deliverables.validation.gatePass', 'deliverables.validation.ready']) if (!has(k)) miss(k);
  }
  // 门禁拒绝响应：声明了拒绝文案的场景必含 reason / error
  const ep = EP_CODE[endpoint];
  if ((ep === 'cs' || ep === 'at' || ep === 'cf') && decisionAfter === 'deny') {
    const decls = (FLIPS[fixture] || []).filter(d => d.dir === 'allow→deny' && d.expectText && d.expectText[ep] !== undefined && (!d.endpoints || d.endpoints.includes(ep)));
    if (decls.length && !has(ep === 'cf' ? 'error' : 'reason')) miss(ep === 'cf' ? 'error' : 'reason');
  }
  return out;
}

// 类型约束（codex 22R-H）：对改后响应里出现的关键字段直接断言类型 / 取值域，违反产出 kind = required-type 的行（不允许进 golden）：
//   state ∈ {pass, warn, fail, partial, stale, none, companion} 的字符串（顶层 state、deliverables.validation.state、acceptance.state）；
//   gatePass 与 deliverables.validation.ready 为布尔；acceptance.at 为字符串或 null；acceptance.rows 为数字或 null；顶层 reason / error 为非空字符串。
const STATE_VALUES = new Set(['pass', 'warn', 'fail', 'partial', 'stale', 'none', 'companion'].map(s => JSON.stringify(s)));
function typeRows(fixture, label, flat) {
  const out = [];
  const bad = (p, expect) => out.push(mkRow(fixture, label, 'required-type', p, expect, flat.get(p)));
  for (const k of flat.keys()) {
    if (k === 'state' || k === 'deliverables.validation.state' || k === 'acceptance.state') { if (!STATE_VALUES.has(flat.get(k))) bad(k, 'state ∈ {pass, warn, fail, partial, stale, none, companion} 的字符串'); }
    else if (k === 'gatePass' || k === 'deliverables.validation.gatePass' || k === 'deliverables.validation.ready') { if (flat.get(k) !== 'true' && flat.get(k) !== 'false') bad(k, '布尔'); }
    else if (k === 'acceptance.at') { const v = flat.get(k); if (v !== 'null' && !/^"/.test(v)) bad(k, '字符串或 null'); }
    else if (k === 'acceptance.rows') { const v = flat.get(k); if (v !== 'null' && !/^-?\d+(\.\d+)?$/.test(v)) bad(k, '数字或 null'); }
    else if (k === 'reason' || k === 'error') { const v = flat.get(k); if (!/^".+"$/.test(v)) bad(k, '非空字符串'); }
  }
  if (flat.has('acceptance.at') && !flat.has('acceptance.rows') && [...flat.keys()].some(k => k.startsWith('acceptance.rows['))) bad('acceptance.rows', '数字或 null（实际是数组 / 对象）');
  return out;
}

// 请求身份：每个请求的稳定指纹（fixture、endpoint、role、method、使用的账号、URL 路径与查询、请求体非凭证字段；token 不入）。
//   路径里的数字 id 归一成 :id、ids 查询只留个数、请求体里的数字值归一成 <id>（夹具库的自增 id 虽然每次相同，但不让 golden 绑死具体数字）。
function requestFingerprint(r, users) {
  const as = r.token ? (Object.keys(users).find(k => users[k].token === r.token) || '未知账号') : '无 token';
  const u = new URL(r.url, 'http://x');
  const query = [...u.searchParams].map(([k, v]) => (k === 'ids' ? `ids=<${v.split(',').length} 个 id>` : `${k}=${v}`)).sort().join('&');
  const body = r.body ? JSON.stringify(Object.keys(r.body).sort().map(k => [k, typeof r.body[k] === 'number' ? '<id>' : r.body[k]])) : '';
  return { fixture: r.key, ...splitLabel(r.label), method: r.method, as, path: u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id'), query, body };
}
const reqKey = (q) => JSON.stringify([q.fixture, q.endpoint, q.role, q.method, q.as, q.path, q.query, q.body]);
function sortRequests(reqs) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return reqs.slice().sort((x, y) => (FIXTURE_ORDER.get(x.fixture) - FIXTURE_ORDER.get(y.fixture)) || cmp(reqKey(x), reqKey(y)));
}

// 单次对拍：seed 库复制成 before / after 两份，起两个实例（改后实例可注入回归 / 直接用基线代码），发同一组请求，返回规范化的行集合
async function runOnce(setup, tag, regressionId) {
  const { runDir, baselineRoot, seedDb, seed, users } = setup;
  const reg = regressionId ? REGRESSIONS[regressionId] : null;
  const beforeDb = path.join(runDir, `before-${tag}.db`), afterDb = path.join(runDir, `after-${tag}.db`);
  copyFile(seedDb, beforeDb); copyFile(seedDb, afterDb);
  const beforeCode = H.copyCode(baselineRoot, path.join(runDir, `svc-before-${tag}`), 'before');
  const afterCode = H.copyCode(reg && reg.useBaselineAsAfter ? baselineRoot : H.ROOT, path.join(runDir, `svc-after-${tag}`), 'after');
  if (reg && reg.file) H.replaceExactlyOnce(path.join(afterCode.copyRoot, reg.file), reg.from, reg.to, `回归 ${regressionId}`);
  const before = await H.startInstance({ copyRoot: beforeCode.copyRoot, dbPath: beforeDb, tag: `before-${tag}` });
  const after = await H.startInstance({ copyRoot: afterCode.copyRoot, dbPath: afterDb, tag: `after-${tag}` });
  // P1：改后实例先等时区一致性自检出结论再发门禁请求（基线代码当「改后」的回归 r9 没有这行日志，豁免）
  if (!(reg && reg.useBaselineAsAfter)) await H.waitTzConclusion(after, `snapshot after-${tag}`);
  // 出网拦截须由服务日志证明：两个实例的日志里都要有带本进程 pid 的 net-guard 加载标记（startInstance 已断言，这里再独立核一遍并打印）
  for (const [nm, inst] of [['改前', before], ['改后', after]]) {
    const ok = H.guardMarkerPresent(fs.readFileSync(inst.logPath, 'utf8'), inst.pid);
    console.log(`[${tag}] ${nm}实例服务日志 net-guard 标记（pid=${inst.pid}）：${ok ? '有' : '缺失'}`);
    if (!ok) throw new Error(`${nm}实例服务日志缺少 net-guard 加载标记，出网拦截未加载`);
  }
  console.log(`[${tag}] 实例：改前 ${before.baseUrl}（pid ${before.pid}）/ 改后 ${after.baseUrl}（pid ${after.pid}）；均非 3000${regressionId ? '；改后实例：' + (reg.useBaselineAsAfter ? '直接用基线代码（回归 ' + regressionId + '）' : '已注入回归 ' + regressionId) : ''}`);

  const rows = [];
  const perSeen = { total: 0, identical: 0 };
  const afterFlats = new Map();   // `${夹具}|${接口 label}` → 改后侧响应（打平），供跨接口一致性核对
  const executed = [];             // 实际发出的请求的稳定指纹（请求身份），与 golden 的请求清单多重集比对
  try {
    const apiB = H.makeApi(before.baseUrl), apiA = H.makeApi(after.baseUrl);
    const reqs = buildRequests(seed, users);
    const scenarioByKey = new Map(SCENARIOS.map(s => [s.key, s]));
    const entryByKey = new Map(seed.manifest.map(e => [e.key, e]));
    for (const r of reqs) {
      const rb = await apiB(r.method, r.url, { token: r.token, body: r.body });
      const ra = await apiA(r.method, r.url, { token: r.token, body: r.body });
      executed.push(requestFingerprint(r, users));
      if (r.kind === 'batch' || r.kind === 'list') {
        // 拆回各夹具逐条比对
        for (const e of seed.manifest) {
          const pick = (res) => {
            if (!res.json) return { status: res.status, flat: new Map([['<text>', '非 JSON']]) };
            const node = r.kind === 'batch' ? res.json[String(e.readModel)] : (Array.isArray(res.json) ? res.json.find(x => x.table_name && x.table_name.startsWith(`snap_${e.key.toLowerCase()}_r`)) : null);
            if (node === undefined || node === null) return { status: res.status, flat: new Map([['<缺该项>', 'true']]) };
            return { status: res.status, flat: flatten(node, '', new Map()) };
          };
          const pa = pick(ra);
          afterFlats.set(`${e.key}|${r.label}`, pa.flat);
          rows.push(...invariantRows(e.key, r.label, invariantViolations(null, pa.status, pa.flat)));
          rows.push(...typeRows(e.key, r.label, pa.flat));
          rows.push(...requiredRows(e.key, r.label, pa.flat, pa.status, e, 'n/a'));
          const items = diffOne(pick(rb), pa);
          perSeen.total++;
          if (items.length === 0) { perSeen.identical++; continue; }
          for (const it of items) rows.push(mkRow(e.key, r.label, it.type, it.path, it.before, it.after));
        }
        continue;
      }
      const nb = normalize(rb), na = normalize(ra);
      if (scenarioByKey.has(r.key)) afterFlats.set(`${r.key}|${r.label}`, na.flat);
      rows.push(...invariantRows(r.key, r.label, invariantViolations(endpointOf(r.label), na.status, na.flat)));
      rows.push(...typeRows(r.key, r.label, na.flat));
      if (scenarioByKey.has(r.key)) rows.push(...requiredRows(r.key, r.label, na.flat, na.status, entryByKey.get(r.key), decisionOf(r.kind, na)));
      const items = diffOne(nb, na);
      perSeen.total++;
      if (items.length === 0) { perSeen.identical++; continue; }
      for (const it of items) rows.push(mkRow(r.key, r.label, it.type, it.path, it.before, it.after));
    }
    for (const c of consistencyViolations(afterFlats, seed.manifest)) rows.push(mkRow(c.fixture, c.label, c.kind, c.path, c.before, c.after));
  } finally {
    await before.stop(); await after.stop();
  }
  return { rows: sortRows(rows), perSeen, requests: sortRequests(executed) };
}

// ───────────────────────────── golden 读写与比对 ─────────────────────────────
// golden 头部元数据：schemaVersion（格式版本，加载时必须一致）、基线提交（加载时必须与 BASELINE_COMMIT 一致）、生成时被测代码的 git HEAD 与工作树是否干净
const GOLDEN_SCHEMA_VERSION = 2;
function gitInfo() {
  const repoRoot = path.resolve(H.ROOT, '..');
  const git = (args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  const dirty = git(['status', '--porcelain', '--', 'wbs-server']).split('\n').filter(Boolean);
  return { head: git(['rev-parse', 'HEAD']), worktreeClean: dirty.length === 0, dirtyFiles: dirty.length };
}
// 写出标准答案：调用方（main）已确认目标不存在或带了 --force-overwrite-golden，且 rows 里没有 required-missing / required-type / invariant / consistency 行
function writeGolden(file, res) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const g = gitInfo();
  const lines = res.rows.map(r => '    ' + JSON.stringify({ ...r, note: noteOf(r) }));
  const reqLines = res.requests.map(q => '    ' + JSON.stringify(q));
  const head = '{\n' +
    `  "description": "C1c 门禁响应契约快照的标准答案：基线 ${BASELINE_COMMIT} vs 改后，全部差异的逐行集合 + 完整请求清单。note 只作人审注释、不参与比对；行比对键 = fixture/endpoint/role/kind/path/before/after；请求比对键 = fixture/endpoint/role/method/as/path/query/body（token 不入）。不得由被测实现自我重生成：--write-golden 目标已存在须显式 --force-overwrite-golden 且覆盖前人工审 diff。",\n` +
    `  "schemaVersion": ${GOLDEN_SCHEMA_VERSION},\n  "baseline": "${BASELINE_COMMIT}",\n  "generatedFrom": ${JSON.stringify({ head: g.head, worktreeClean: g.worktreeClean, dirtyFilesUnderWbsServer: g.dirtyFiles })},\n  "requestTotal": ${res.perSeen.total},\n` +
    `  "requests": [\n${reqLines.join(',\n')}\n  ],\n  "rows": [\n`;
  fs.writeFileSync(file, head + lines.join(',\n') + '\n  ]\n}\n');
}
// ───────── golden 严格校验（codex 22-R2）：允许值集合与期望组合全集都是工具内声明的，不从 golden 自己推 ─────────
const ALLOWED_ENDPOINTS = new Set(['can-self-archive', 'archivable-task', 'confirm', 'validation-status', 'dev-status', 'validation-status/batch', 'list']);
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const ALLOWED_AS = new Set(['admin', 'owner', 'other', 'viewer', '无 token']);
const ALLOWED_ROLES = new Set(['', 'admin', 'owner', '无 token', '非 owner 的 user', 'viewer 读', 'viewer', '缺 id', '任务不存在']);
const ALLOWED_FIXTURES = new Set([...SCENARIOS.map(s => s.key), 'P', '*']);
const REQ_FIELDS = ['fixture', 'endpoint', 'role', 'method', 'as', 'path', 'query', 'body'];
// 期望的 fixture × endpoint × role 组合全集（与 buildRequests / seedFixtures 的角色规则一一对应，手写声明）
function expectedCombos() {
  const out = new Set();
  const add = (f, e, r) => out.add(JSON.stringify([f, e, r]));
  for (const s of SCENARIOS) {
    add(s.key, 'validation-status', ''); add(s.key, 'dev-status', '');
    if (s.category) {
      add(s.key, 'can-self-archive', 'admin'); add(s.key, 'archivable-task', 'admin');
      const roles = s.category === 'ODS_SYNC' ? ['owner', 'admin'] : (s.ownerConfirm ? ['admin', 'owner'] : ['admin']);
      if (s.category === 'DWD_DEV' && s.layer === 'ODS') roles.push('owner');
      for (const r of roles) add(s.key, 'confirm', r);
    }
  }
  add('*', 'validation-status/batch', ''); add('*', 'list', '');
  add('P', 'can-self-archive', '无 token'); add('P', 'can-self-archive', '非 owner 的 user'); add('P', 'archivable-task', '非 owner 的 user'); add('P', 'archivable-task', 'viewer 读');
  for (const r of ['viewer', '非 owner 的 user', '无 token', '缺 id', '任务不存在']) add('P', 'confirm', r);
  return out;
}
function validateGoldenRequests(reqs) {
  const seen = new Set();
  reqs.forEach((q, i) => {
    const where = `golden.requests[${i}]`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error(`${where} 不是对象`);
    const keys = Object.keys(q).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...REQ_FIELDS].sort())) throw new Error(`${where} 字段集合不是 ${REQ_FIELDS.join('/')}：${keys.join('/')}`);
    for (const k of REQ_FIELDS) if (typeof q[k] !== 'string') throw new Error(`${where}.${k} 不是字符串`);
    if (!ALLOWED_FIXTURES.has(q.fixture)) throw new Error(`${where}.fixture 不在允许集合：${q.fixture}`);
    if (!ALLOWED_ENDPOINTS.has(q.endpoint)) throw new Error(`${where}.endpoint 不在允许集合：${q.endpoint}`);
    if (!ALLOWED_ROLES.has(q.role)) throw new Error(`${where}.role 不在允许集合：${q.role}`);
    if (!ALLOWED_METHODS.has(q.method)) throw new Error(`${where}.method 不在允许集合：${q.method}`);
    if (!ALLOWED_AS.has(q.as)) throw new Error(`${where}.as 不在允许集合：${q.as}`);
    if (!q.path.startsWith('/api/')) throw new Error(`${where}.path 不是 /api/ 路径：${q.path}`);
    const c = JSON.stringify([q.fixture, q.endpoint, q.role]);
    if (seen.has(c)) throw new Error(`${where} 的 fixture×endpoint×role 组合重复：${c}`);
    seen.add(c);
  });
  const exp = expectedCombos();
  const miss = [...exp].filter(c => !seen.has(c)), extra = [...seen].filter(c => !exp.has(c));
  if (miss.length || extra.length) throw new Error(`golden.requests 的 fixture×endpoint×role 组合全集与工具声明不相等：缺少 ${miss.length}（${miss.slice(0, 3).join('、')}）、多出 ${extra.length}（${extra.slice(0, 3).join('、')}）`);
}
// generatedFrom.head 来源真实性（codex 22-R3 M）：必须是当前 HEAD 的祖先提交（git merge-base --is-ancestor <head> HEAD：退出码 0 = 是、1 = 否；
//   其余退出码 / 无法执行 git / 提交对象不存在 → 一律判红，不当作「通过」）。worktreeClean / dirtyFilesUnderWbsServer 只做类型校验：
//   生成时的工作树状态无法事后复核，仅作记录。
//   能力边界：只证明 head 来自本仓历史（任何祖先提交都会通过），不证明它是最近一次生成。
function assertGeneratedFromIsAncestor(head) {
  const repoRoot = path.resolve(H.ROOT, '..');
  const r = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', head, 'HEAD'], { encoding: 'utf8' });
  if (r.error) throw new Error(`golden.generatedFrom.head 祖先核对无法执行 git：${r.error.message}（判红）`);
  if (r.status === 0) return;
  if (r.status === 1) throw new Error(`golden.generatedFrom.head=${head} 不是当前 HEAD 的祖先提交（判红）`);
  throw new Error(`golden.generatedFrom.head=${head} 祖先核对失败（git 退出码 ${r.status}）：${String(r.stderr || '').trim().slice(0, 200)}（判红）`);
}
function loadGolden(file) {
  if (!fs.existsSync(file)) throw new Error(`golden 文件不存在：${file}（先用 --write-golden 生成并经人审提交）`);
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (g.schemaVersion !== GOLDEN_SCHEMA_VERSION) throw new Error(`golden.schemaVersion=${g.schemaVersion} 与工具的 ${GOLDEN_SCHEMA_VERSION} 不一致（判红）`);
  if (g.baseline !== BASELINE_COMMIT) throw new Error(`golden.baseline=${g.baseline} 与工具的基线提交 ${BASELINE_COMMIT} 不一致（判红）`);
  if (!Array.isArray(g.rows)) throw new Error('golden 文件缺 rows 数组');
  if (!Array.isArray(g.requests)) throw new Error('golden 文件缺 requests 数组（请求清单）');
  if (g.requestTotal !== TOTAL_REQUESTS) throw new Error(`golden.requestTotal=${g.requestTotal} 与常量 TOTAL_REQUESTS=${TOTAL_REQUESTS} 不一致`);
  const gf = g.generatedFrom;
  if (!gf || typeof gf !== 'object') throw new Error('golden.generatedFrom 缺失或不是对象（判红）');
  if (typeof gf.head !== 'string' || !/^[0-9a-f]{40}$/.test(gf.head)) throw new Error(`golden.generatedFrom.head 不是 40 位十六进制：${gf.head}（判红）`);
  if (typeof gf.worktreeClean !== 'boolean') throw new Error('golden.generatedFrom.worktreeClean 不是布尔（判红）');
  if (!Number.isInteger(gf.dirtyFilesUnderWbsServer) || gf.dirtyFilesUnderWbsServer < 0) throw new Error('golden.generatedFrom.dirtyFilesUnderWbsServer 不是非负整数（判红）');
  assertGeneratedFromIsAncestor(gf.head);
  if (g.requests.length !== TOTAL_HTTP_REQUESTS) throw new Error(`golden.requests 条数 ${g.requests.length} 与 TOTAL_HTTP_REQUESTS=${TOTAL_HTTP_REQUESTS} 不一致`);
  validateGoldenRequests(g.requests);
  return g;
}
// 多重集比较：缺失 = golden 有而实际没有（预期翻转没出现），多出 = 实际有而 golden 没有（意外回归），same = 全等计数
function diffAgainstGolden(actualRows, goldenRows) {
  const count = new Map();
  for (const r of goldenRows) count.set(rowKey(r), (count.get(rowKey(r)) || 0) + 1);
  const extra = [];
  let same = 0;
  for (const r of actualRows) {
    const k = rowKey(r);
    if (count.get(k) > 0) { count.set(k, count.get(k) - 1); same++; } else extra.push(r);
  }
  const used = new Map();
  for (const r of actualRows) used.set(rowKey(r), (used.get(rowKey(r)) || 0) + 1);
  const missing = [];
  const seenG = new Map();
  for (const r of goldenRows) {
    const k = rowKey(r);
    seenG.set(k, (seenG.get(k) || 0) + 1);
    if (seenG.get(k) > (used.get(k) || 0)) missing.push(r);
  }
  return { missing, extra, same };
}
const brief = (r) => `[${r.fixture}] ${r.endpoint}${r.role ? '[' + r.role + ']' : ''} ${r.kind} ${r.path}：${r.before} → ${r.after}`;
// 失败判据：缺失或多出任一非空 / 请求总数不符
function structuralFailures(res) {
  const f = [];
  if (res.perSeen.total !== TOTAL_REQUESTS) f.push(`请求总数 ${res.perSeen.total} !== ${TOTAL_REQUESTS}`);
  if (res.requests.length !== TOTAL_HTTP_REQUESTS) f.push(`实际发出的 HTTP 请求 ${res.requests.length} 条 !== ${TOTAL_HTTP_REQUESTS}`);
  // 每个 fixture × endpoint × role 组合恰好一次（请求清单里同一组合出现多次 = 请求被复制顶替）
  const cnt = new Map();
  for (const q of res.requests) { const k = JSON.stringify([q.fixture, q.endpoint, q.role]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  const dup = [...cnt].filter(([, v]) => v !== 1).map(([k, v]) => `${k}×${v}`);
  if (dup.length) f.push(`fixture×endpoint×role 组合不是恰好一次：${dup.slice(0, 5).join('、')}${dup.length > 5 ? '…' : ''}`);
  { const exp = expectedCombos(); const act = new Set(res.requests.map(q => JSON.stringify([q.fixture, q.endpoint, q.role]))); const miss = [...exp].filter(c => !act.has(c)), extra = [...act].filter(c => !exp.has(c)); if (miss.length || extra.length) f.push(`实际请求的 fixture×endpoint×role 组合与工具声明的期望全集不相等：缺少 ${miss.length}、多出 ${extra.length}`); }
  if (res.reqDiff && (res.reqDiff.missing.length || res.reqDiff.extra.length)) f.push(`请求清单与 golden 不一致：缺少 ${res.reqDiff.missing.length}、多出 ${res.reqDiff.extra.length}（首条 ${JSON.stringify((res.reqDiff.missing[0] || res.reqDiff.extra[0]))}）`);
  return f;
}
const verdictFails = (d, res) => d.missing.length > 0 || d.extra.length > 0 || structuralFailures(res).length > 0;
// 请求清单多重集比较
function diffRequests(actual, golden) {
  const count = new Map();
  for (const q of golden) count.set(reqKey(q), (count.get(reqKey(q)) || 0) + 1);
  const extra = [];
  for (const q of actual) { const k = reqKey(q); if (count.get(k) > 0) count.set(k, count.get(k) - 1); else extra.push(q); }
  const missing = [];
  for (const q of golden) { const k = reqKey(q); if (count.get(k) > 0) { count.set(k, count.get(k) - 1); missing.push(q); } }
  return { missing, extra };
}

function printReport(res, d, goldenRows, report) {
  const rows = res.rows;
  console.log(`\n## 概况：请求总数 ${res.perSeen.total}（应为 ${TOTAL_REQUESTS}），两侧完全一致 ${res.perSeen.identical}，差异行 ${rows.length}；与 golden（${goldenRows.length} 行）比对：全等 ${d.same}，缺失 ${d.missing.length}，多出 ${d.extra.length}`);
  const byNote = new Map();
  for (const r of rows) byNote.set(noteOf(r), (byNote.get(noteOf(r)) || 0) + 1);
  console.log('\n## 差异行按 note 分布（note 只作注释）');
  for (const [k, v] of [...byNote].sort()) console.log(`- ${k}: ${v}`);
  const reqMissing = rows.filter(r => r.kind === 'required-missing');
  console.log(`\n## required-missing 行 ${reqMissing.length} 条${reqMissing.length ? '（实现缺键，须主会话裁定）' : ''}`);
  for (const r of reqMissing) console.log(`- ${brief(r)}`);
  console.log(`\n## 缺失 ${d.missing.length} 行（golden 有、实际无）`);
  for (const r of d.missing.slice(0, 60)) console.log(`- ${brief(r)}`);
  if (d.missing.length > 60) console.log(`- …其余 ${d.missing.length - 60} 行省略`);
  console.log(`\n## 多出 ${d.extra.length} 行（实际有、golden 无）`);
  for (const r of d.extra.slice(0, 60)) console.log(`- ${brief(r)}`);
  if (d.extra.length > 60) console.log(`- …其余 ${d.extra.length - 60} 行省略`);
  console.log(`\n## 库与外发\n${report.map(x => '- ' + x).join('\n')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (p) => { const a = argv.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };
  // [#106 S4b2] 删除原 process.env 秘钥校验：共享助手 verify-model-config-rev-http.js 不再加载 .env，改用每次运行随机的 H.JWT_SECRET_RUN / H.DB_KEY_RUN
  const wgIdx = argv.findIndex(x => x === '--write-golden' || x.startsWith('--write-golden='));
  const writeGoldenPath = wgIdx < 0 ? null : (argv[wgIdx].includes('=') ? argv[wgIdx].split('=').slice(1).join('=') : argv[wgIdx + 1]);
  if (wgIdx >= 0 && !writeGoldenPath) throw new Error('--write-golden 需要路径');
  const goldenPath = argOf('--golden=') || GOLDEN_DEFAULT;
  // golden 不可由被测实现自我重生成：目标已存在 → 拒绝，除非显式 --force-overwrite-golden（并打印醒目警告：覆盖前须人工审核 diff）
  const forceOverwrite = argv.includes('--force-overwrite-golden');
  if (writeGoldenPath) {
    const target = path.resolve(writeGoldenPath);
    if (fs.existsSync(target) && !forceOverwrite) throw new Error(`拒绝覆盖已存在的 golden：${target}。标准答案不得由当前实现自我重生成；确需重生成须显式加 --force-overwrite-golden，并在覆盖前人工审核新旧 diff。`);
    if (fs.existsSync(target)) console.log('!!!!!!!! 警告：--force-overwrite-golden 将覆盖已存在的标准答案 ' + target + '；覆盖前须人工审核 diff（下面会先打印与旧 golden 的差异计数）。 !!!!!!!!');
  }
  const setup = await prepare(argOf);
  if (writeGoldenPath) {
    const res = await runOnce(setup, 'golden', null);
    const target = path.resolve(writeGoldenPath);
    const sf = structuralFailures(res);
    // 生成前不得存在任何 required-missing / required-type / invariant / consistency 行（实现缺字段 / 自相矛盾时不许被固化成标准答案）
    const forbidden = res.rows.filter(r => ['required-missing', 'required-type', 'invariant', 'consistency'].includes(r.kind));
    if (forbidden.length || sf.length) {
      console.log(`FAIL 拒绝写出 golden：required-missing / required-type / invariant / consistency 行 ${forbidden.length} 条；结构性失败 ${sf.length} 项`);
      for (const r of forbidden.slice(0, 40)) console.log('- ' + brief(r));
      for (const s of sf) console.log('- ' + s);
      process.exitCode = 1;
      return;
    }
    if (fs.existsSync(target)) {
      try {
        const old = JSON.parse(fs.readFileSync(target, 'utf8'));
        const od = diffAgainstGolden(res.rows, old.rows || []);
        console.log(`与旧 golden 的差异：全等 ${od.same}，旧有而新无 ${od.missing.length}，新有而旧无 ${od.extra.length}`);
        for (const r of od.missing.slice(0, 40)) console.log('  旧有新无：' + brief(r));
        for (const r of od.extra.slice(0, 40)) console.log('  新有旧无：' + brief(r));
      } catch (e) { console.log('旧 golden 无法解析，无法给出差异：' + e.message); }
    }
    writeGolden(target, res);
    console.log(`golden 已写出：${path.resolve(writeGoldenPath)}（${res.rows.length} 行；请求清单 ${res.requests.length} 条；请求总数 ${res.perSeen.total}；required-missing ${res.rows.filter(r => r.kind === 'required-missing').length} 行）。须经人审后提交。`);
    if (sf.length) { console.log('FAIL ' + sf.join('；')); process.exitCode = 1; }
    return;
  }
  const golden = loadGolden(goldenPath);
  const goldenRows = golden.rows;
  const withReqDiff = (res) => { res.reqDiff = diffRequests(res.requests, golden.requests); return res; };
  if (argv.includes('--self-test')) {
    // 自证：对照组（不改）须与 golden 全等；每个回归注入后须出现「缺失或多出」（校验会非 0 退出）且落在预期位置，否则工具的比对过宽
    let bad = 0;
    const ctl = withReqDiff(await runOnce(setup, 'control', null));
    const dc = diffAgainstGolden(ctl.rows, goldenRows);
    const okCtl = !verdictFails(dc, ctl);
    if (!okCtl) bad++;
    console.log(`SELF-TEST 对照组（不改）：全等 ${dc.same}，缺失 ${dc.missing.length}，多出 ${dc.extra.length} ${okCtl ? 'PASS' : 'FAIL'}${okCtl ? '' : '；首条：' + brief((dc.missing[0] || dc.extra[0] || { fixture: '-', endpoint: structuralFailures(ctl).join(';'), role: '', kind: '', path: '', before: '', after: '' }))}`);
    for (const id of Object.keys(REGRESSIONS)) {
      const res = withReqDiff(await runOnce(setup, id, id));
      const d = diffAgainstGolden(res.rows, goldenRows);
      const fails = verdictFails(d, res);
      const located = REGRESSIONS[id].expect(d, goldenRows);
      const ok = fails && located;
      if (!ok) bad++;
      const first = d.missing[0] || d.extra[0];
      console.log(`SELF-TEST 回归 ${id}：全等 ${d.same}，缺失 ${d.missing.length}，多出 ${d.extra.length}，校验退出码 ${fails ? 1 : 0}（${REGRESSIONS[id].expectDesc}）${ok ? 'PASS' : 'FAIL'}${first ? '；首条' + (d.missing[0] ? '缺失' : '多出') + '：' + brief(first) : ''}`);
    }
    // 离线自证（不起服务）：① generatedFrom.head 祖先核对——当前 HEAD 自身须通过，不存在的提交（40 个 0）须判红
    //   ② expectedCombos 与请求构造的一致性自检（structuralFailures 里的「期望全集」比对）——对照组的实际请求须与期望全集相等；少一条 / 多一条须判红
    {
      let headOk = false, fakeRed = false, msg = '';
      try { assertGeneratedFromIsAncestor(gitInfo().head); headOk = true; } catch (e) { msg = e.message; }
      try { assertGeneratedFromIsAncestor('0'.repeat(40)); } catch (e) { fakeRed = true; msg = msg || e.message; }
      const okA = headOk && fakeRed;
      if (!okA) bad++;
      console.log(`SELF-TEST generatedFrom 祖先核对：当前 HEAD ${headOk ? '通过' : '被拒'}、伪造提交 ${fakeRed ? '判红' : '未判红'} ${okA ? 'PASS' : 'FAIL'}${okA ? '' : '；' + msg}`);
      const hasMsg = (r) => structuralFailures(r).some(x => x.includes('期望全集不相等'));
      const base = ctl.requests;
      const dropped = { ...ctl, requests: base.slice(1) };
      const added = { ...ctl, requests: [...base, { ...base[0], role: '__多出的角色__' }] };
      const okB = !hasMsg(ctl) && hasMsg(dropped) && hasMsg(added);
      if (!okB) bad++;
      console.log(`SELF-TEST expectedCombos 一致性自检：对照组 ${hasMsg(ctl) ? '误报' : '无报'}、少一条 ${hasMsg(dropped) ? '判红' : '未判红'}、多一条 ${hasMsg(added) ? '判红' : '未判红'} ${okB ? 'PASS' : 'FAIL'}`);
    }
    console.log(`snapshot-model-gate-contract --self-test ${bad === 0 ? 'PASS' : 'FAIL'}（对照组 + ${Object.keys(REGRESSIONS).length} 个回归 + 2 项离线自证）`);
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }
  const res = withReqDiff(await runOnce(setup, 'main', null));
  const d = diffAgainstGolden(res.rows, goldenRows);
  printReport(res, d, goldenRows, setup.report);
  const jsonOut = argOf('--json=');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows: res.rows, missing: d.missing, extra: d.extra, same: d.same, perSeen: res.perSeen }, null, 2));
  const sf = structuralFailures(res);
  const fail = verdictFails(d, res);
  console.log(`\nsnapshot-model-gate-contract ${fail ? 'FAIL' : 'PASS'}：全等 ${d.same}，缺失 ${d.missing.length}，多出 ${d.extra.length}${sf.length ? '；结构性失败：' + sf.join('；') : ''}`);
  process.exitCode = fail ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => { console.log(`FAIL ${e && e.stack || e}`); process.exitCode = 1; }).finally(() => {
    H.runCleanupsSync();
    if (H.cleanupFailures.length) { console.log(`FAIL 清理复查：${H.cleanupFailures.length} 项未通过\n  ${H.cleanupFailures.join('\n  ')}`); process.exitCode = 1; }
  });
}
