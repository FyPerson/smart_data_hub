// 验证脚本：系统迭代 上线体统一重构 C2a 核心场景（方案 v3.4 §6.4/§6.4a/§6.8/§6.10/§6.11/§6.13 + 编码前置调查 §7b）
//   用法：node scripts/verify-sys-release-batch.js
//
// 真实 HTTP 层验证（对齐 verify-sys-role-perm-c1.js / verify-sys-duty-roster.js 范式：真实 express app +
//   http.Server + JWT 多角色夹具）；issue 夹具走直连 SQL 种子（对齐 verify-sys-multidev-snapshots.js 范式，
//   快速构造「待上线」态，不为每条夹具跑完整建单→受理→指派→估时→提交→验收长链）。
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// [C4b 退场收编清单]（Opus 预筛 305 号，H1 根治：批次级单执行人通知机制——preemptReleaseNotifySend/
//   sendReleaseNotifyAndWriteback 两函数 + POST /sys-releases/:id/notify-executor + GET
//   /sys-releases/:id/executor-read-status 两路由——已整体删除，唯一活跃通道收敛为行级机制。原①-⑭组
//   逐组分诊，收编（等价看守已在行级机制/其他文件覆盖，删除原组）或改写（有独特价值、无行级等价，
//   保留但换新夹具）：
//   ①状态转移五态 → 删除。首发/重发/failed 重试/stale/sending-在途五态已被行级
//     verify-sys-release-executors.js [6a]-[6d]/[6i] 等价覆盖（更细：还含 done 拒发/非在册 404/批次态闸/
//     成员非空闸/五条件 CAS 负例等原组没有的维度）。"查排班锁人"子测试**无行级等价**——不是遗漏，是
//     架构变了：新模型下通知时不再自动查排班定人，执行人由 admin 经 PUT executors 显式指定，排班只是
//     候选端点 GET executor-candidates 的默认建议值（见 verify-sys-release-executors.js [1] 组），检查
//     时机从"通知时"整体前移到"选人时"，旧场景结构性不存在。
//   ①stale惰性转换 → 删除，收编 [6i-1]/[6i-2]/[6i-3]（行级单元断言+端到端佐证+批量版单元断言）。
//   ②无排班/无资格/原执行人失效四态 → 删除。NO_PLANNED_DATE/NO_DUTY_ROSTER/DUTY_USER_NOT_ELIGIBLE
//     三态是"通知时查排班"这件事本身的负例，随①一并结构性消失；RELEASE_ASSIGNEE_INVALID（原执行人失效）
//     的资格检查语义收编进 PUT executors 闸③资格闸（verify-sys-release-executors.js [2-③负]）+ 候选端点
//     eligible/disabled_reason（[1b] 组）——检查时机同样从"通知时"前移到"选人时"。
//   ③cancel-schedule → **改写**保留（本文件，见下方）：admin 403/reason 缺 400 两条权限输入校验无行级
//     等价（cancel-schedule 端点本身未删除，只是夹具不能再用 notify-executor 构造前置态），改用
//     PUT executors + markSent 构造；深度覆盖（partial 准入不看聚合态/done 确认闸/discard 留痕/新代次
//     不回带）已迁至独立文件 verify-sys-release-c4a.js [1a]-[1e]，本组不重复，收窄为权限守卫 + 基础成功
//     路径。
//   ④原语差量(加单/移单/改期通知重置+同值改期幂等) → 删除。加单/改期触发子表软删全员已被
//     verify-sys-release-c4a.js [3a]/[3b]/[3c] 等价覆盖（含同值改期不变哨兵）；移单（remove-issues 非
//     keepExecutor 分支）触发同一 applyReleaseChange 重置块，已被 verify-sys-executor-remove.js [B] 组
//     （"剩余=0→executor_kept=false→全重置"）等价覆盖——三个调用方共享同一段重置代码，两处独立覆盖已
//     足够证明该代码路径正确，不需要在本文件第三次镜像验证。⚠️ C4b 预筛 MED-1 订正措辞：本组原④组
//     "全仓唯一看守"不止子表软删这一件事，还包含 timeline 侧的看守——c4a.js [3a]/[3b] 已补
//     release_add/release_date_change 各自 +1（[3a] 另证"已丢弃 N 条完成确认"附记非 schedule_cancelled
//     分支独有）、[3c] 补全仓（不分 action_code）timeline 零新增哨兵，与"等价覆盖"的措辞对齐为真——
//     不再是"只覆盖子表副作用、timeline 那半没人看"的半只眼睛状态。
//   ⑤快照 v2 → **不改**。全程未调用 notify-executor（用 setExecutors/markSent/execute 行级机制），不受
//     本轮退场影响，原样保留。
//   ⑥execute 权限矩阵 → **不改**。同⑤，全程行级机制，未受影响；且与 verify-sys-release-executors.js
//     [8] 组（8a-8q 共 18 个子例）高度重叠，保留是因为本组从"批次级视角"复核同一组不变量，双重覆盖
//     不算浪费（两个文件独立成立，互为回归网）。
//   ⑦8 列只读残留验证 → **改写**保留（本文件，见下方）：夹具从 notify-executor 换成 PUT executors + 行级
//     通知端点；验证范围**扩大**——C4a 时 sys_releases 批次级 10 列仍是权威列，本组只验证 sys_issues 8 列
//     镜像冻结；C4b 批次级列本身也随退场变成死列，本组范围扩大为**两个列族**全程冻结的回归网（防未来
//     误改再往这两组死列写入）。
//   ⑧并发抢占仅一方成功 → 删除，收编 [6l]（"真实并发双发同一行"，行级版更贴近生产：现实中并发的是
//     "两个 admin 同时点某一行的发通知按钮"，不是"两个请求同时抢占整个批次"这种旧架构才有的语义）。
//   ⑨抢占 CAS token/assignee 比对 + ⑨-静态源码断言 → 删除。⑨-静态读的
//     `preemptReleaseNotifySend`/`sendReleaseNotifyAndWriteback` 源码文本已随函数删除而失去定位锚点，
//     继续跑会因 `indexOf` 找不到函数名而必然失败——这不是"断言过时"，是断言的**对象已从物理上消失**。
//     收编 [6g-1]/[6g-2]/[6g-3]（五条件 CAS 负例·token 不匹配/软删行/代次隔离，行级版本用真实构造的并发
//     窗口验证，比手写等价 SQL + 静态源码 grep 更贴近生产事实）。
//   ⑩两种锁顺序串行化不变量 → **不改**。同⑤⑥，全程行级机制（复用组⑥/PUT executors），未受影响。
//   ⑪崩溃恢复链(sending 悬挂超时) → 删除，收编 [6i-1]/[6i-2]/[6i-3] + verify-sys-release-c4a.js
//     [2c]/[2c-反例]（详情端点入口的批量刷新场景，覆盖"超窗转/未超窗不转"两分支，视角互补）。
//   ⑫cancel-schedule 插缝防护回归(codex 199 HIGH-1) → 删除。**前提已不成立**——旧断言验证的是"cancel-
//     schedule 换新批次级 token 后，持旧 token 的迟到写入 changes=0"，但 cancel-schedule 的六列重置 CAS
//     已随 H1 根治整体删除（不再碰批次级 token 列，见 index.js cancel-schedule 路由头部注释），旧断言的
//     UPDATE 目标列不再被任何路径读写，测的是死列。收编 [6g-2]（软删行 CAS 负例——cancel-schedule 软删
//     子表行后，迟到的行级通知回写因 `removed_at IS NULL` 条件失配而拒绝，同 HIGH-1"堵住迟到写入"的
//     精神在行级架构下的等价体现）+ verify-sys-release-c4a.js [1a]（子表软删全员的直接验证）。
//   ⑬C8 跨阶段冒烟 → **改写**保留（本文件，见下方）：核心价值在归档重开+C9 回头路锁定这段跨子系统
//     集成链路，与通知机制具体实现无关，值得保留；夹具从"真实 CAS notify-executor 查排班"换成"真实
//     PUT executors + 行级通知 + execute 两人确认"，集成链路本身（C0 排班表→执行人选定→C4 快照读源→
//     C6 归档重开→C9 回头路锁定→重新开发→新批次→再走一遍）逐字保留。
//   ⑭通知三件套(resend+查已读) → 删除。resend 语义/token 换新/已读固化四分支/并发双 resend 已被行级
//     verify-sys-release-executors.js [6]组（尤其 [6b]"重发"[6c]"failed 重试"）+ [7]组（[7a]-[7f]行级
//     已读四分支+dry-run 短路+非 admin 403）等价覆盖，且行级版本粒度更细（按行独立，不是批次级笼统重发）。
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// 保留/改写组覆盖（本文件最终留存范围）：
//   ③ cancel-schedule：admin 403 / reason 缺 400 / 对接人 200 基础成功路径（子表全体软删+timeline）
//   ⑤ 快照 v2：execute 发布后 snapshot_json 解析=schema_version 2+四字段+commits 数组
//   ⑥ execute：本人+sent→200 翻牌；非本人 403；admin 403（未在册）；notify≠sent 409；资格实时（禁用后 403）
//   ⑦ 两列族只读残留验证：sys_issues 8 列镜像 + sys_releases 批次级 10 列全程冻结，仅子表真变化
//   ⑩ 两种锁顺序的串行化不变量（禁用先提交→execute 403；execute 先提交→事后禁用不回滚）
//   ⑬ 跨阶段冒烟：C0(真实排班表候选)→执行人选定(PUT executors)→行级通知→execute→C4(snapshot 读源)→
//     C6(归档重开)→C9(回头路锁定)→重新开发→新批次→再走一遍，验证深度 CAS 覆盖与归档重开组合不出缝
//
// 断言纪律：全程精确状态码 + 精确 error code，不用 status>=400 弱判据；正例断言真实落库副作用，非仅状态码。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// [307 号 M4·codex 对抗审] 上方"[C4b 退场收编清单]"棱文散文版保留不动（叙事+理由，供人读）；本表是它的
// 机器可读镜像——四字段（旧组号/旧不变量一句/新看守文件/新断言名清单），供下方 [0-收编映射校验] 组遍历
// 自证："收编清单声称的新断言名，真的还活在目标文件文本里"。防将来目标文件重构/改名/删断言导致收编清单
// 失联却没人发现（散文是叙事，不会因为目标断言消失而报错；这张表会）。newFile 用 __dirname 相对路径，
// 'self' 特指本文件自身（③⑤⑥⑦⑩⑬六组未删，改写/不改后仍留在本文件里，标签就是各自 ok() 文案里的原始
// 编号前缀）。
const C4B_RETIREMENT_MAP = [
  { oldGroup: '①状态转移五态', oldInvariant: '首发/重发/failed 重试/stale/sending-在途五态状态机', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6a]', '[6b]', '[6c]', '[6d]'] },   // 308 号③核出：'[6i]' 原是组标题非真实断言标签，stale 态实由下一行 [6i-1]/[6i-2]/[6i-3] 承担，已移除避免自证虚假通过
  { oldGroup: '①stale惰性转换', oldInvariant: '超窗 sending 行惰性转 stale', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6i-1]', '[6i-2]', '[6i-3]'] },
  { oldGroup: '②无排班/无资格/原执行人失效四态', oldInvariant: 'NO_PLANNED_DATE/NO_DUTY_ROSTER/DUTY_USER_NOT_ELIGIBLE/RELEASE_ASSIGNEE_INVALID', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[2-③负]', '[1b]'] },
  { oldGroup: '③cancel-schedule', oldInvariant: 'admin 403/reason 缺 400/对接人 200 基础成功路径', disposition: 'rewritten-self', newFile: 'self', newLabels: ['③'] },
  { oldGroup: '④原语差量(加单/移单/改期通知重置+同值改期幂等)', oldInvariant: '差量非空触发子表软删全员，差量为空 isEmpty 短路不删', disposition: 'deleted', newFile: 'verify-sys-release-c4a.js', newLabels: ['[3a]', '[3b]', '[3c]'] },
  { oldGroup: '④原语差量·移单分支', oldInvariant: '同④，移单（remove-issues 非 keepExecutor）触发同一重置块', disposition: 'deleted', newFile: 'verify-sys-executor-remove.js', newLabels: ['[B]'] },
  { oldGroup: '⑤快照 v2', oldInvariant: 'execute 发布后 snapshot_json 结构完整性', disposition: 'kept-self', newFile: 'self', newLabels: ['⑤'] },
  { oldGroup: '⑥execute 权限矩阵', oldInvariant: 'notify≠sent/非本人/admin未在册/资格实时复核 各分支状态码', disposition: 'kept-self', newFile: 'self', newLabels: ['⑥'] },
  { oldGroup: '⑦8 列只读残留验证', oldInvariant: 'sys_issues 8 列镜像冻结', disposition: 'rewritten-self', newFile: 'self', newLabels: ['⑦'] },
  { oldGroup: '⑧并发抢占仅一方成功', oldInvariant: '两请求同时抢占同一批次通知权，仅一方成功', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6l]'] },
  { oldGroup: '⑨抢占 CAS token/assignee 比对 + ⑨-静态源码断言', oldInvariant: '五条件 CAS 负例（token 不匹配/软删行/代次隔离）+ 源码文本静态断言', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6g-1]', '[6g-2]', '[6g-3]'] },
  { oldGroup: '⑩两种锁顺序串行化不变量', oldInvariant: '禁用先提交→execute 403；execute 先提交→事后禁用不回滚', disposition: 'kept-self', newFile: 'self', newLabels: ['⑩'] },
  { oldGroup: '⑪崩溃恢复链(sending 悬挂超时)', oldInvariant: '悬挂 sending 行的批量兜底刷新', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6i-1]', '[6i-2]', '[6i-3]'] },
  { oldGroup: '⑪崩溃恢复链·详情入口视角', oldInvariant: '同⑪，详情端点入口的批量刷新场景', disposition: 'deleted', newFile: 'verify-sys-release-c4a.js', newLabels: ['[2c]', '[2c-反例]'] },
  { oldGroup: '⑫cancel-schedule 插缝防护回归(codex 199 HIGH-1)', oldInvariant: '换新批次级 token 后，持旧 token 的迟到写入 changes=0', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6g-2]'] },
  { oldGroup: '⑫cancel-schedule 插缝防护回归·软删全员视角', oldInvariant: '同⑫，子表软删全员的直接验证', disposition: 'deleted', newFile: 'verify-sys-release-c4a.js', newLabels: ['[1a]'] },
  { oldGroup: '⑬C8 跨阶段冒烟', oldInvariant: 'C0→执行人选定→通知→execute→C4→C6→C9→重开发→新批次 全链路', disposition: 'rewritten-self', newFile: 'self', newLabels: ['⑬'] },
  { oldGroup: '⑭通知三件套(resend+查已读)', oldInvariant: 'resend 语义/token 换新/已读固化四分支/并发双 resend', disposition: 'deleted', newFile: 'verify-sys-release-executors.js', newLabels: ['[6b]', '[6c]', '[7a]', '[7b]', '[7c]', '[7d]', '[7e]', '[7f]'] },
];

const SECRET = 'verify-sys-release-batch-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

// ── 多角色 JWT 夹具（对齐 verify-sys-duty-roster.js：测试 id 与生产 users.id 无对应关系）──────────
const adminTok    = jwt.sign({ id: 1,  username: 'admin',      display_name: '管理员',   role: 'admin' }, SECRET);
const liaisonTok  = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人',   role: 'user'  }, SECRET);   // 受理人白名单（对接人）
const dev5Tok     = jwt.sign({ id: 5,  username: 'dev5',       display_name: '开发甲',   role: 'user'  }, SECRET);   // 有资格
const dev6Tok     = jwt.sign({ id: 6,  username: 'dev6',       display_name: '开发乙',   role: 'user'  }, SECRET);   // 有资格
const dev9Tok     = jwt.sign({ id: 9,  username: 'dev9',       display_name: '开发丙',   role: 'user'  }, SECRET);   // 将被禁用，测试实时资格

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 直连 SQL 夹具（对齐 verify-sys-multidev-snapshots.js 范式）──────────
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员')`,
    [type, status, extra.title || `${type}-${status}-单`]
  );
  return r.lastID;
}
// RELEASE 中心守卫（assertMainStatusTransition）要求在册成员数≥1 且全员完成态（无 pending）才允许进「已上线」——
//   凡是本脚本会走到 execute/_publishReleaseCoreInTxn 的 issue 都必须先补一条完成态 dev_assignee 行。
async function mkCompleteRoster(issueId, userId = 5, userName = '开发甲') {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
    [issueId, userId, userName]
  );
}
async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, {
    title: extra.title || 'C2a批次', planned_date: extra.plannedDate || undefined,
  });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const relId = r.body.id;
  if (extra.withMember) {
    const iid = await mkIssue('feature', '待上线', { title: `${extra.title || 'C2a批次'}-占位成员` });
    await addIssuesTo(relId, [iid]);
  }
  return relId;
}
async function addIssuesTo(relId, issueIds) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: issueIds });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const relRow = (id) => get(
  `SELECT id, status, planned_date, release_assignee_id, release_assignee_name,
          release_assignee_notify_status AS ns, release_assignee_notify_started_at AS started,
          release_assignee_notified_at AS notified, release_assignee_notify_message_key AS mkey,
          release_assignee_notify_error AS err, release_assignee_notify_token AS tok, release_assignee_read_at AS readAt
     FROM sys_releases WHERE id=?`, [id]
);
const issueRow = (id) => get(
  `SELECT id, status, release_id, release_assignee_id, release_assignee_name,
          release_assignee_notify_status AS ns, release_assignee_notified_at AS notified,
          release_assignee_notify_message_key AS mkey, release_assignee_notify_error AS err,
          release_assignee_read_at AS readAt, release_assignee_notify_sent_by AS sentBy
     FROM sys_issues WHERE id=?`, [id]
);
async function seedRoster(dutyDate, userId, userName) {
  await run(
    `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, ?, ?, 1, '管理员')`,
    [dutyDate, userId, userName]
  );
}
let dutyDateSeq = 1;
function nextDutyDate() { return `2031-01-${String(dutyDateSeq++).padStart(2, '0')}`; }

// C3（方案 §4.3 全文）：execute() 语义整体切换为"确认我这一份"+ R-GATE（行级子表多人确认），不再是
//   批次级单列单人。本文件多处驱动 execute()（⑤⑥⑦⑩⑬）——三个组合 helper：
//   setExecutors(relId, userIds)：PUT executors 真实设定在册执行人集合，返回 {userId: rowId} 映射，
//     供调用方精确控制"谁的行 id 是什么"（execute() 现在必须显式传 executor_row_id）。
//   markSent(relId, userIds)：把指定用户的在册行置 notify_status='sent'（CHECK 要求 notified_at 同步
//     非空）——跳过真实通知外呼，本文件聚焦 execute()/中心守卫本身，通知链路已有
//     verify-sys-release-executors.js 专项覆盖，不在此重复。
//   execRow(relId, userId)：查询指定用户当前在册行，供调用方按需单独构造特定分诊场景。
async function setExecutors(relId, userIds) {
  const r = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: userIds });
  assert.strictEqual(r.status, 200, `setExecutors PUT 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const rows = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  const map = {};
  for (const row of rows) map[row.user_id] = row.id;
  return map;
}
async function markSent(relId, userIds) {
  const ph = userIds.map(() => '?').join(',');
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id IN (${ph}) AND removed_at IS NULL`, [relId, ...userIds]);
}
async function execRow(relId, userId) {
  return get(`SELECT id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND user_id=? AND removed_at IS NULL`, [relId, userId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13800000001'),
    (13,'wangtaotao','示例对接人','user','active','13800000013'),
    (5,'dev5','开发甲','user','active','13800000005'),
    (6,'dev6','开发乙','user','active','13800000006'),
    (9,'dev9','开发丙','user','active','13800000009')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 示例对接人13 / dev5,6,9）');

  // ═══ [0-收编映射校验]（307 号 M4·codex 对抗审）遍历 C4B_RETIREMENT_MAP，逐条验证"新断言名真的还活在
  // 目标文件文本里"——防止未来目标文件重构/改名/删断言导致收编清单静默失联却没人发现（散文版收编清单是
  // 叙事，不会因为断言消失而报错；这条校验会）═══
  {
    const scriptsDir = __dirname;
    const fileCache = {};
    // 308 号③（非阻塞加固）：读 self 时挖掉 C4B_RETIREMENT_MAP 数组本身的定义区间——原版本读整份自身
    // 文件文本，而数组字面量里逐条都写着 `newLabels: ['③']` 这类标签字符串，`.includes(label)` 会在
    // "数据表自己提到自己"这层直接命中，形成自指循环：哪怕对应的 `ok('③ ...')` 断言真被删了，本条校验
    // 仍会因为在数组定义那几行"找到"了 '③' 这个子串而误判通过。挖掉该区间后，命中只能来自数组之外的
    // 真实断言代码。
    function stripMapDefinition(text) {
      const startIdx = text.indexOf('const C4B_RETIREMENT_MAP = [');
      if (startIdx === -1) return text;   // 找不到锚点时保守不挖（不掩盖潜在问题，交由后续断言暴露）
      const endMarker = '\n];';
      const endIdx = text.indexOf(endMarker, startIdx);
      if (endIdx === -1) return text;
      return text.slice(0, startIdx) + text.slice(endIdx + endMarker.length);
    }
    function readTarget(relFile) {
      if (relFile === 'self') {
        const full = fs.readFileSync(__filename, 'utf8');
        return stripMapDefinition(full);
      }
      if (!fileCache[relFile]) fileCache[relFile] = fs.readFileSync(path.join(scriptsDir, relFile), 'utf8');
      return fileCache[relFile];
    }
    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // 308 号③（非阻塞加固）：判据从"整篇文本 .includes(label)"收紧为"存在一行同时含 assert.xxx(/ok( 调用
    // 起手式与该标签文本"——原判据对"标签只出现在一句无关注释里"（比如某处顺口提了一句"同 [6a] 组"，但
    // [6a] 真实的 ok()/assert() 已经被删）分辨不出来，会把"提到过"误判成"真的还在测"。逐行判据不要求
    // assert/ok 与标签在同一次函数调用的同一个参数里，只要同一行出现即可——足够收紧且不需要真解析 AST。
    function labelNearAssertOrOk(text, label) {
      const labelRe = new RegExp(escapeRegex(label));
      const gateRe = /\bassert\.\w+\(|\bok\(/;
      // L14（codex 预筛，同 308 号①同款范式）：跳过注释行——原判据只看"这一行同时含 assert./ok( 与标签"，
      // 若某行只是**注释里**顺嘴提了句"参见 assert.strictEqual 处理 [6a] 的逻辑"，会被误判成真断言命中。
      // trim 后以 `//` 开头的整行视为注释直接跳过，只认真代码行。
      return text.split('\n').some(line => !line.trim().startsWith('//') && gateRe.test(line) && labelRe.test(line));
    }
    let checkedCount = 0;
    for (const entry of C4B_RETIREMENT_MAP) {
      const text = readTarget(entry.newFile);
      for (const label of entry.newLabels) {
        assert.ok(
          labelNearAssertOrOk(text, label),
          `[0-收编映射校验] 旧组「${entry.oldGroup}」（${entry.disposition}）声称收编到 ${entry.newFile === 'self' ? '本文件' : entry.newFile} 的断言名 "${label}" 未在目标文件"assert(/ok(调用同行"找到——收编清单已失联，须核实是目标断言被删/改名，还是本表登记错误`
        );
        checkedCount++;
      }
    }
    const selfCount = C4B_RETIREMENT_MAP.filter(e => e.newFile === 'self').length;
    const crossCount = C4B_RETIREMENT_MAP.length - selfCount;
    ok(`[0-收编映射校验] C4B_RETIREMENT_MAP 全部 ${C4B_RETIREMENT_MAP.length} 条旧组映射、共 ${checkedCount} 个新断言名，逐个确认仍存在于各自声称目标文件的 assert(/ok( 调用同行文本中（本文件自身 ${selfCount} 条 self 映射已排除数组定义区自指干扰 + executors.js/c4a.js/executor-remove.js 共 ${crossCount} 条跨文件映射）`);
  }

  // ═══ ③ cancel-schedule：admin 403 / reason 缺 400 / 对接人 200 基础成功路径 ═══
  //   C4b 夹具改法：notify-executor 路由已删除，改用 PUT executors + markSent 构造"已通知"前置态。
  {
    const relId = await mkRelease({ title: '③cancel-schedule' });
    const issueId = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issueId]);
    await setExecutors(relId, [5, 6]);
    await markSent(relId, [5, 6]);

    // admin 403
    const rAdmin = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, adminTok, { reason: '测试' });
    assert.strictEqual(rAdmin.status, 403, `③admin 期望 403, got ${rAdmin.status}`);
    assert.strictEqual(rAdmin.body.code, 'INTAKE_LIAISON_ONLY', '③admin 确切码');

    // reason 缺 → 400
    const rNoReason = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, {});
    assert.strictEqual(rNoReason.status, 400, `③reason 缺期望 400, got ${rNoReason.status}`);
    assert.strictEqual(rNoReason.body.code, 'CANCEL_REASON_REQUIRED', '③reason 缺确切码');

    // 对接人 200，基础成功路径：子表全体软删 + timeline 含撤销原因
    const rOk = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: '甲方临时调整计划' });
    assert.strictEqual(rOk.status, 200, `③对接人期望 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    const activeAfter = await all(`SELECT 1 FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
    assert.strictEqual(activeAfter.length, 0, '③撤销后子表在册 0 行（全体软删——深度覆盖见 verify-sys-release-c4a.js [1a]-[1e]）');
    const tl = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' AND action_code='release_schedule_cancel' ORDER BY id DESC LIMIT 1`,
      [issueId]
    );
    assert.ok(tl, '③timeline 已写 release_schedule_cancel 行');
    assert.ok(tl.summary.includes('甲方临时调整计划'), '③timeline summary 含撤销原因');

    ok('③ cancel-schedule：admin 403 INTAKE_LIAISON_ONLY；reason 缺 400 CANCEL_REASON_REQUIRED；对接人 200 基础成功路径（子表全体软删+timeline含原因）——深度覆盖（partial准入不看聚合态/done确认闸/discard留痕/新代次不回带）见 verify-sys-release-c4a.js [1a]-[1e]，不在此重复（C4b 夹具已从 notify-executor 换成 PUT executors）');
  }

  // ═══ ⑤ 快照 v2（execute 发布后）═══
  let executeSnapIssueId = null, executeSnapRelId = null;
  {
    const relId = await mkRelease({ title: 'execute快照批次' });
    const issueId = await mkIssue('feature', '待上线', { title: 'C2a-execute快照单' });
    await mkCompleteRoster(issueId);   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId, [issueId]);
    // C3：行级子表多人确认（301-M3 过渡夹具兑现）——PUT executors [5,6] + 置 sent + 6 先确认 + 5 最后
    // 确认触发 R-GATE 真正发布。
    const rowsMap5 = await setExecutors(relId, [5, 6]);
    await markSent(relId, [5, 6]);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 6 号真成功且未提前触发发布。
    const r5Pre6 = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { executor_row_id: rowsMap5[6] });
    assert.strictEqual(r5Pre6.status, 200, `⑤-pre 6号预确认期望 200, got ${r5Pre6.status} ${JSON.stringify(r5Pre6.body)}`);
    assert.strictEqual(r5Pre6.body.released, false, '⑤-pre 6号预确认不该提前触发发布');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: 'C2a execute 发布', executor_row_id: rowsMap5[5] });
    assert.strictEqual(rExec.status, 200, `⑤execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(rExec.body.status, '已上线', '⑤execute 后状态=已上线');
    assert.strictEqual(rExec.body.released, true, '⑤execute 最后一人确认触发真正发布（released=true 布尔，C3 新契约）');

    const snap = await get('SELECT snapshot_json FROM sys_issue_release_commit_snapshots WHERE release_id=? AND issue_id=?', [relId, issueId]);
    assert.ok(snap, '⑤快照行已产生');
    const parsed = JSON.parse(snap.snapshot_json);
    assert.strictEqual(parsed.schema_version, 2, '⑤snapshot v2 schema_version=2');
    assert.strictEqual(parsed.type, 'feature', '⑤v2 type 正确');
    assert.strictEqual(parsed.title_snapshot, 'C2a-execute快照单', '⑤v2 title_snapshot=发布时标题');
    assert.strictEqual(parsed.status_at_publish, '已上线', '⑤v2 status_at_publish=已上线');
    assert.ok(Array.isArray(parsed.commits), '⑤v2 commits 为数组');

    const tlPublished = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' AND action_code='release_published'`,
      [issueId]
    );
    assert.ok(tlPublished, '⑤release_published timeline 行已写');
    const publishedPayload = JSON.parse(tlPublished.summary);
    assert.strictEqual(publishedPayload.schema_version, 2, '⑤release_published 载荷 schema_version=2');
    assert.strictEqual(publishedPayload.issue_id, issueId, '⑤release_published 载荷含 issue_id');

    executeSnapIssueId = issueId; executeSnapRelId = relId;
    ok('⑤ 快照 v2：execute 发布后 snapshot_json 解析出 schema_version=2 + type/title_snapshot/status_at_publish 四字段 + commits 数组；release_published timeline 载荷同构');
  }

  // ═══ ⑥ execute 权限矩阵 + 实时资格（C3：行级子表多人确认改写，断言过时→改写，测试分诊详见完成报告）═══
  //   ⚠️ 语义变化说明：新模型下"非本人"不再是 EXECUTOR_GUARD_FAILED——CAS 的 user_id=actor.id 条件本就
  //   把"别人的行"排除在查询之外，冒用他人 executor_row_id 落进"行不存在"分诊（403 EXECUTOR_NOT_ACTIVE，
  //   §4.3 幂等三分诊①）。"本人+sent→200"在多人批次里也不是一次确认就翻牌——R-GATE 要求在册全员 done
  //   （[决策 7 三修同步更正] 系统性下限现只需≥1 人，单人批次一次确认即翻牌；本组特意选 2 人在册，是
  //   为了观测"还差 1 人不翻牌→最后一人才翻牌"这条中间态本身，非闸门强制要求 2 人），须先有另一人确认
  //   铺垫。
  //   [303-M1 订正] admin 的两种旧场景**不再收敛成同一结论**——303-M1 把资格闸挪到了 preRow-done 路由
  //   之后（preRow 回查排最前）：admin 冒用别人的 executor_row_id（"未在册"场景）与 dev5 冒用他人 row_id
  //   同一条路径，preRow 查无匹配行 → 403 EXECUTOR_NOT_ACTIVE，压根不会跑到 hasReleaseEligibility；只有
  //   admin 自己的行**真实存在**于子表时（下方"人工构造成已在册的 admin"场景，SQL 直接把某行 user_id
  //   改成 admin 的 id），preRow 才能命中该行（exec_status=pending）并往下走到资格闸，此时才会落
  //   403 EXECUTOR_NOT_ELIGIBLE。
  {
    const relId = await mkRelease();
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 6, '开发乙');   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId, [issueId]);
    const rowsMap6 = await setExecutors(relId, [6, 9]);   // 两名合格执行人，均未标记 sent

    // notify != sent → 409（行级：6 的行 notify_status 仍 not_sent）
    const rNotSent = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'x', executor_row_id: rowsMap6[6] });
    assert.strictEqual(rNotSent.status, 409, `⑥notify≠sent 期望 409, got ${rNotSent.status}`);
    assert.strictEqual(rNotSent.body.code, 'NOTIFY_NOT_SENT', '⑥确切码 NOTIFY_NOT_SENT');

    await markSent(relId, [6, 9]);   // → 两行均 sent

    // 非本人（冒用他人 row_id）→ 403 EXECUTOR_NOT_ACTIVE（新模型：CAS 的 user_id=actor.id 条件天然把
    //   "这行不是你的"排除在查询之外，落进"行不存在"分诊，而非旧模型的单列比对失败）。
    const rOther = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: rowsMap6[6] });
    assert.strictEqual(rOther.status, 403, `⑥非本人期望 403, got ${rOther.status}`);
    assert.strictEqual(rOther.body.code, 'EXECUTOR_NOT_ACTIVE', '⑥非本人（冒用 6 的 row_id）确切码 EXECUTOR_NOT_ACTIVE（新模型：行查找按 user_id=actor.id 过滤，不匹配即视同"你不是这行的主人"）');

    // [303-M1 断言过时→改写] admin（未在册）→ 403 EXECUTOR_NOT_ACTIVE（不再是 EXECUTOR_NOT_ELIGIBLE）。
    //   303-M1（Opus 对抗审）把资格闸挪到了 preRow-done 路由之后——preRow 回查现在排在最前面：
    //   executor_row_id=rowsMap6[6] 是"6 的行"，query 条件里的 user_id=actor.id=1（admin）对不上这一行
    //   真实的 user_id=6，preRow 直接查无此行，落"行不存在"分诊（403 EXECUTOR_NOT_ACTIVE），压根走不到
    //   资格闸——与上面 ⑥非本人（dev5 冒用 6 的 row_id）是同一条判定路径，admin 在这里和 dev5 一样只是
    //   "又一个不是这行主人的人"，不再享有"资格闸先判"的特殊待遇。
    const rAdmin = await call('POST', `/api/sys-releases/${relId}/execute`, adminTok, { release_note: 'x', executor_row_id: rowsMap6[6] });
    assert.strictEqual(rAdmin.status, 403, `⑥admin 期望 403, got ${rAdmin.status}`);
    assert.strictEqual(rAdmin.body.code, 'EXECUTOR_NOT_ACTIVE', '⑥admin（未在册，冒用 6 的 row_id）确切码 EXECUTOR_NOT_ACTIVE（303-M1 后 preRow 回查排最前，落"行不存在"分诊，不再触达资格闸）');

    // 本人+sent → 200（R-GATE 需全员 done——本组选 2 人在册以观测"9 先确认铺垫，6 最后确认真翻牌"这条
    //   中间态；决策 7 三修后系统性下限已是≥1，非本组选 2 人的理由，见上方 ⑥ 组段头说明）。
    const rPre9 = await call('POST', `/api/sys-releases/${relId}/execute`, dev9Tok, { executor_row_id: rowsMap6[9] });
    assert.strictEqual(rPre9.status, 200, `⑥9 先确认期望 200, got ${rPre9.status} ${JSON.stringify(rPre9.body)}`);
    assert.strictEqual(rPre9.body.released, false, '⑥9 先确认，还差 6 一人，released=false');
    const rOk = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'C2a execute 正常', executor_row_id: rowsMap6[6] });
    assert.strictEqual(rOk.status, 200, `⑥本人+sent(最后一人) 期望 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    assert.strictEqual(rOk.body.released, true, '⑥6 最后确认，released=true 真翻牌');
    const issueAfter = await issueRow(issueId);
    assert.strictEqual(issueAfter.status, '已上线', '⑥执行后主状态=已上线');

    // 实时资格：造禁用后 execute → 403（另建一单验证，禁用发生在 sent 之后、execute 之前）。
    const relId2 = await mkRelease();
    const issueId2 = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId2, 9, '开发丙');   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId2, [issueId2]);
    const rowsMap2 = await setExecutors(relId2, [9, 5]);
    await markSent(relId2, [9, 5]);
    await run(`UPDATE users SET status='disabled' WHERE id=9`);
    const rDisabled = await call('POST', `/api/sys-releases/${relId2}/execute`, dev9Tok, { release_note: 'x', executor_row_id: rowsMap2[9] });
    assert.strictEqual(rDisabled.status, 403, `⑥实时资格（禁用后）期望 403, got ${rDisabled.status}`);
    assert.strictEqual(rDisabled.body.code, 'EXECUTOR_NOT_ELIGIBLE', '⑥实时资格确切码 EXECUTOR_NOT_ELIGIBLE');
    await run(`UPDATE users SET status='active' WHERE id=9`);

    // codex 199 审 MED-2②（新模型下的等价覆盖）：PUT executors 自身的资格闸③会在"把 admin 加进执行人
    //   集合"这一步就 400 拒绝——admin 正常路径下永远进不了子表。本用例用直接 SQL 构造"万一它进去了"
    //   的防御性场景（模拟脏数据/未来某绕过 PUT 的旁路），验证 execute() 自己的资格闸独立生效，不依赖
    //   "PUT 已经挡过一次"这个前提。
    const relAdminAssignee = await mkRelease();
    const issueAdminAssignee = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueAdminAssignee, 5, '开发甲');
    await addIssuesTo(relAdminAssignee, [issueAdminAssignee]);
    const rowsMapAdmin = await setExecutors(relAdminAssignee, [5, 6]);   // 先用两个合法人建批（决策 7
    // 三修后单人亦可，本组用 2 人只是留一个"5 号"位保持批次整体形态自然，非人数闸强制要求）
    await markSent(relAdminAssignee, [5, 6]);
    // 直接 SQL 把 6 号行的 user_id 改成 admin(1)——模拟脏数据，正常路径 PUT 挡不掉，此处强行构造。
    await run(`UPDATE sys_release_executors SET user_id=1, user_name='管理员' WHERE release_id=? AND user_id=6`, [relAdminAssignee]);
    const rAdminAsAssignee = await call('POST', `/api/sys-releases/${relAdminAssignee}/execute`, adminTok, { release_note: 'x', executor_row_id: rowsMapAdmin[6] });
    assert.strictEqual(rAdminAsAssignee.status, 403, `⑥admin 被构造成在册仍执行期望 403, got ${rAdminAsAssignee.status} ${JSON.stringify(rAdminAsAssignee.body)}`);
    assert.strictEqual(rAdminAsAssignee.body.code, 'EXECUTOR_NOT_ELIGIBLE', '⑥admin 即使被脏数据构造成在册（本人+sent）仍被资格闸拒——确切码 EXECUTOR_NOT_ELIGIBLE（execute() 自身独立生效，不依赖 PUT 已挡过一次）');

    ok('⑥ execute 权限矩阵（C3 行级改写，303-M1 判序重排后订正）：notify≠sent→409 NOTIFY_NOT_SENT；非本人(冒用他人 row_id)→403 EXECUTOR_NOT_ACTIVE；admin(未在册，同属"冒用他人 row_id"一类)→403 EXECUTOR_NOT_ACTIVE；本人+sent 且 R-GATE 满足(另一人先确认)→200 真翻牌；账号被禁用（sent 之后现禁用）→403 EXECUTOR_NOT_ELIGIBLE；admin 被脏数据构造成真实在册（自己那行存在）→403 EXECUTOR_NOT_ELIGIBLE（preRow 命中后才轮到资格闸，execute() 自身独立生效）');
  }

  // ═══ ⑦ [C4b 扩大范围] 两列族只读残留验证——sys_issues 8 列镜像 + sys_releases 批次级 10 列全程冻结 ═══
  //   C4a 时（本组原始设计时期）sys_releases 批次级 10 列仍是权威列（真实写入路径），本组只验证
  //   sys_issues 镜像列不受影响。C4b（H1 根治）批次级通知机制整体退场后，sys_releases 这 10 列同样
  //   再无任何写路径（唯一权威源已切到 sys_release_executors 子表）——范围相应扩大：两个列族在一条完整
  //   生命周期（加单→PUT executors→行级通知→cancel-schedule→改期→移单→execute）里全程冻结，只有子表
  //   真正发生变化。防未来误改把写路径又接回这两组死列。
  {
    function assertMirrorFrozenAtInitial(row, label) {
      assert.strictEqual(row.release_assignee_id, null, `${label} sys_issues 镜像列 release_assignee_id 应仍为初始 NULL`);
      assert.strictEqual(row.release_assignee_name, null, `${label} sys_issues 镜像列 release_assignee_name 应仍为初始 NULL`);
      assert.strictEqual(row.ns, 'not_sent', `${label} sys_issues 镜像列 notify_status 应仍为 schema 默认初始值 'not_sent'`);
      assert.strictEqual(row.notified, null, `${label} sys_issues 镜像列 notified_at 应仍为初始 NULL`);
      assert.strictEqual(row.mkey, null, `${label} sys_issues 镜像列 notify_message_key 应仍为初始 NULL`);
      assert.strictEqual(row.err, null, `${label} sys_issues 镜像列 notify_error 应仍为初始 NULL`);
      assert.strictEqual(row.readAt, null, `${label} sys_issues 镜像列 read_at 应仍为初始 NULL`);
      assert.strictEqual(row.sentBy, null, `${label} sys_issues 镜像列 notify_sent_by 应仍为初始 NULL`);
    }
    function assertBatchLevelFrozenAtInitial(row, label) {
      // C4b 预筛 MED-2：relRow() 早就 SELECT 了全部 9 列（含 token/read_at 这两个本轮 H1 退场才刚砍掉写
      //   路径的列），但本函数此前只断言其中 3 列（id/name/ns）——其余 6 列有写路径但没看守，等于验证
      //   范围名不副实。补全到 9 列全断言，逐列对应各自的 DDL/迁移默认初值。
      assert.strictEqual(row.release_assignee_id, null, `${label} sys_releases 批次级列 release_assignee_id 应仍为初始 NULL（C4b 起无任何写路径）`);
      assert.strictEqual(row.release_assignee_name, null, `${label} sys_releases 批次级列 release_assignee_name 应仍为初始 NULL`);
      assert.strictEqual(row.ns, 'not_sent', `${label} sys_releases 批次级列 notify_status 应仍为 schema 默认初始值 'not_sent'`);
      assert.strictEqual(row.started, null, `${label} sys_releases 批次级列 notify_started_at 应仍为初始 NULL`);
      assert.strictEqual(row.notified, null, `${label} sys_releases 批次级列 notified_at 应仍为初始 NULL`);
      assert.strictEqual(row.mkey, null, `${label} sys_releases 批次级列 notify_message_key 应仍为初始 NULL`);
      assert.strictEqual(row.err, null, `${label} sys_releases 批次级列 notify_error 应仍为初始 NULL`);
      assert.strictEqual(row.tok, null, `${label} sys_releases 批次级列 notify_token 应仍为初始 NULL（C4b 起唯一写它的 cancel-schedule 六列重置 CAS 已整体删除）`);
      assert.strictEqual(row.readAt, null, `${label} sys_releases 批次级列 read_at 应仍为初始 NULL（C4b 起唯一写它的旧 executor-read-status 路由已整体删除）`);
    }

    const relId = await mkRelease({ title: '⑦旧列冻结' });
    const issue1 = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issue1]);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦加单后 issue1');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦加单后批次');

    // 行级通知（新权威路径）：真实走 PUT executors + 行级通知端点，子表真变化，两个旧列族岿然不动。
    await setExecutors(relId, [5, 6]);
    const rNotify = await call('POST', `/api/sys-releases/${relId}/executors/5/notify`, adminTok, {});
    assert.strictEqual(rNotify.status, 200, `⑦行级通知期望 200, got ${rNotify.status} ${JSON.stringify(rNotify.body)}`);
    const execRowAfterNotify = await execRow(relId, 5);
    assert.strictEqual(execRowAfterNotify.notify_status, 'sent', '⑦子表真变化：5 号行 notify_status=sent（新权威路径确实在写）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦行级通知成功后 issue1');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦行级通知成功后批次');

    // 加单第二个成员——差量非空触发子表软删全员（方案 §4.4 改造 6），两个旧列族仍不受影响。
    const issue2 = await mkIssue('feature', '待上线');
    const rAdd = await addIssuesTo(relId, [issue2]);
    assert.strictEqual(rAdd.status, 200, `⑦加单期望 200, got ${rAdd.status}`);
    const activeAfterAdd = await all(`SELECT 1 FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
    assert.strictEqual(activeAfterAdd.length, 0, '⑦加单触发子表软删全员（真变化发生在子表，非旧列）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦加单后 issue1（原成员）');
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦加单后 issue2（新成员）');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦加单后批次');

    // 撤销上线安排：重新 PUT executors + 通知到 sent，再撤销。
    await setExecutors(relId, [5, 6]);
    await markSent(relId, [5, 6]);
    const rCancel = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: '⑦-旧列冻结回归' });
    assert.strictEqual(rCancel.status, 200, `⑦cancel-schedule 期望 200, got ${rCancel.status} ${JSON.stringify(rCancel.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦cancel-schedule 后 issue1');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦cancel-schedule 后批次');

    // 改计划上线日期（真改期，非同值）。
    const dNew = nextDutyDate();
    const rDate = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: dNew });
    assert.strictEqual(rDate.status, 200, `⑦改期期望 200, got ${rDate.status} ${JSON.stringify(rDate.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦改期后 issue1');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦改期后批次');

    // 移单——issue2 被移出批次，issue1 仍在册；两者旧列族均应岿然不动。
    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue2] });
    assert.strictEqual(rRemove.status, 200, `⑦移单期望 200, got ${rRemove.status} ${JSON.stringify(rRemove.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦移单后 issue2（被移除成员）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦移单后 issue1（仍在册成员）');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦移单后批次');

    // execute 真发布——issue1 全程在批次内未被移出，补完整 dev roster + 行级子表两人确认。
    await mkCompleteRoster(issue1, 5, '开发甲');
    await setExecutors(relId, [5, 6]);
    await markSent(relId, [5, 6]);
    const r7Pre6 = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { executor_row_id: (await execRow(relId, 6)).id });
    assert.strictEqual(r7Pre6.status, 200, `⑦-pre 6号预确认期望 200, got ${r7Pre6.status} ${JSON.stringify(r7Pre6.body)}`);
    assert.strictEqual(r7Pre6.body.released, false, '⑦-pre 6号预确认不该提前触发发布');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: '⑦-旧列冻结回归·真发布', executor_row_id: (await execRow(relId, 5)).id });
    assert.strictEqual(rExec.status, 200, `⑦execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    const issue1Row = await get('SELECT status FROM sys_issues WHERE id=?', [issue1]);
    assert.strictEqual(issue1Row.status, '已上线', '⑦execute 后 issue1 真实翻已上线（权威链路本身不受影响）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦execute 真发布后 issue1（已上线态，sys_issues 镜像列仍应岿然不动）');
    assertBatchLevelFrozenAtInitial(await relRow(relId), '⑦execute 真发布后批次（sys_releases 批次级列仍应岿然不动）');

    ok('⑦ [C4b 扩大范围] 两列族只读残留验证：真实走完 加单→PUT executors→行级通知→加单(子表重置)→cancel-schedule→改期→移单→execute 全链路，sys_issues 8 个旧镜像列与 sys_releases 批次级 10 列全程冻结在 schema 初始值；同期 sys_release_executors 子表全部真实变化（通知→sent/加单→软删全员/execute→已上线），证明"权威源已完全迁移到子表，两组旧列族均已彻底不可写"');
  }

  // ═══ ⑩ C2b：两种锁顺序的串行化不变量（§6.3a v3.4 修正②）══════════════════════════════
  {
    // ①禁用先提交 → execute 必 403：已由组⑥「实时资格：造禁用后 execute → 403」用例覆盖
    //   （relId2/issueId2/dev9，禁用发生在 sent 之后、execute 调用之前，execute 读到的是禁用后的真实态）。
    ok('⑩-① 禁用先提交→execute 必 403：复用组⑥「实时资格」用例（relId2/dev9 禁用后 execute→403 EXECUTOR_NOT_ELIGIBLE），不重复造夹具');

    // ②execute 先完成（提交成功）→ 随后禁用 = 合法结果（不倒查回滚）。C3：行级子表两人确认，5 先确认
    //   铺垫，6 最后确认真翻牌（301-M3 过渡夹具兑现）。
    const relId = await mkRelease();
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 6, '开发乙');
    await addIssuesTo(relId, [issueId]);
    const rowsMap10 = await setExecutors(relId, [6, 5]);
    await markSent(relId, [6, 5]);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 5 号真成功且未提前触发发布。
    const r10Pre5 = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { executor_row_id: rowsMap10[5] });
    assert.strictEqual(r10Pre5.status, 200, `⑩-②-pre 5号预确认期望 200, got ${r10Pre5.status} ${JSON.stringify(r10Pre5.body)}`);
    assert.strictEqual(r10Pre5.body.released, false, '⑩-②-pre 5号预确认不该提前触发发布');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'C2b 锁序②', executor_row_id: rowsMap10[6] });
    assert.strictEqual(rExec.status, 200, `⑩-②execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    // execute 提交成功之后才禁用——此时禁用不应、也不能倒查回滚已提交的发布。
    await run(`UPDATE users SET status='disabled' WHERE id=6`);
    const relRowAfter = await relRow(relId);
    const issueRowAfter = await issueRow(issueId);
    assert.strictEqual(relRowAfter.status, '已发布', '⑩-②execute 已提交，批次仍是「已发布」，不因事后禁用而回滚');
    assert.strictEqual(issueRowAfter.status, '已上线', '⑩-②execute 已提交，成员仍是「已上线」，不因事后禁用而回滚');
    await run(`UPDATE users SET status='active' WHERE id=6`);   // 复原防污染
    ok('⑩-② execute 先完成（200 提交成功）→ 随后禁用执行人 = 合法结果，批次/成员状态不回滚（证明"绝不允许：禁用已先提交但发布仍成功"的反面——"发布已先提交，之后才禁用"——是合法结果，二者不对称）');
  }

  // ═══ ⑬ C8 跨阶段冒烟：C0 排班表(候选默认值)→执行人选定→行级通知→execute→C4 读源→C6 归档重开→
  //   C9 回头路锁定→再走一遍 ═══
  //   动机（C8 任务 C）：本文件③⑤⑥⑦⑩组已把执行人确认+发布测得很深，但全部止步于"发布成功"；本组
  //   补上完整的归档重开+回头路锁定集成链路（核心价值与通知机制具体实现无关，C4b 夹具改法仅替换
  //   "执行人怎么定"这一步，集成链路本身逐字保留）。
  {
    const d13 = nextDutyDate();
    await seedRoster(d13, 5, '开发甲');   // 排班表仍保留（候选端点默认值来源之一，非本组核心断言对象）
    const cycIssue = await mkIssue('feature', '待上线', { title: 'C8跨阶段冒烟-归档重开' });
    await mkCompleteRoster(cycIssue, 5, '开发甲');
    // close/reopen 走 ADMIN_TRANSITION/sysIssueTransition [4] RC-M5 不变量，检的是 legacy 单值列
    // sys_issues.assigned_to（非 sys_issue_dev_assignees 多开发表）——mkIssue/mkCompleteRoster 均不写它，
    // 首次实测在本文件也踩了一次同款坑（同 test-sys-release-c7-playwright.js 的既有踩坑记录）。
    await run(`UPDATE sys_issues SET assigned_to=?, assigned_to_name=?, assigned_at=datetime('now') WHERE id=?`, [5, '开发甲', cycIssue]);
    const cycRel1 = await mkRelease({ plannedDate: d13 });
    await addIssuesTo(cycRel1, [cycIssue]);

    // 执行人选定（PUT executors，新权威路径）+ 行级通知 + 两人确认真发布。
    const rowsMap13a = await setExecutors(cycRel1, [5, 6]);
    await markSent(cycRel1, [5, 6]);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 6 号真成功且未提前触发发布。
    const r13aPre6 = await call('POST', `/api/sys-releases/${cycRel1}/execute`, dev6Tok, { executor_row_id: rowsMap13a[6] });
    assert.strictEqual(r13aPre6.status, 200, `⑬首轮-pre 6号预确认期望 200, got ${r13aPre6.status} ${JSON.stringify(r13aPre6.body)}`);
    assert.strictEqual(r13aPre6.body.released, false, '⑬首轮-pre 6号预确认不该提前触发发布');
    const rExec1 = await call('POST', `/api/sys-releases/${cycRel1}/execute`, dev5Tok, { release_note: 'C8跨阶段首发', version_tag: 'v-c8-1', executor_row_id: rowsMap13a[5] });
    assert.strictEqual(rExec1.status, 200, `⑬execute 首次应 200, got ${rExec1.status} ${JSON.stringify(rExec1.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '已上线', '⑬execute 后单已翻已上线');

    // C4：getReleaseMembers 首发后基线为 snapshot。
    const gm1 = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    assert.strictEqual(gm1.source, 'snapshot', '⑬首发后 getReleaseMembers 走 snapshot 源（C4 读源）');

    // C6：归档 → 重开（真实 HTTP，非 sysIssueTransition 直调）。
    const rClose = await call('POST', `/api/sys-issues/${cycIssue}/close`, adminTok, {});
    assert.strictEqual(rClose.status, 200, `⑬close 应 200, got ${rClose.status} ${JSON.stringify(rClose.body)}`);
    const rReopen = await call('POST', `/api/sys-issues/${cycIssue}/reopen`, adminTok, { reason: 'C8跨阶段冒烟-验证归档重开与真实执行人链路组合' });
    assert.strictEqual(rReopen.status, 200, `⑬reopen 应 200, got ${rReopen.status} ${JSON.stringify(rReopen.body)}`);
    assert.strictEqual(rReopen.body.status, '开发中', '⑬reopen 目标态=开发中');
    const afterReopen = await issueRow(cycIssue);
    assert.strictEqual(afterReopen.release_id, null, '⑬reopen 清 release_id');

    // 红线：旧批次（真实执行人链路发布出来的）在归档重开后仍稳定 snapshot、release 本身未被拖回计划中。
    const rel1AfterReopen = await relRow(cycRel1);
    assert.strictEqual(rel1AfterReopen.status, '已发布', '⑬[红线] 归档重开后旧批次仍「已发布」（真实执行人链路发布路径同样不被拖回计划中）');
    const gm1AfterReopen = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    assert.strictEqual(gm1AfterReopen.source, 'snapshot', '⑬[红线] 归档重开后旧批次仍 snapshot 源（真实执行人链路发布路径的快照同样不受影响）');

    // [C9·codex 207 审 HIGH-2 轻量采纳] 不变量锁定：尝试把 reopen 释放出来的 issue 加回**同一个**
    //   （仍「已发布」）旧批次——必须被 add-issues 的 RELEASE_NOT_PLANNING 拦下，release 状态/issue.release_id/
    //   快照表行数三处均不受污染。与下方"加入新批次 cycRel2"分支是两个独立场景：那条验证"正常改道"，
    //   这条验证"回头路走不通"（_publishReleaseCoreInTxn 头部注释所声明不变量的具体验证载体）。
    const rAddBack = await call('POST', `/api/sys-releases/${cycRel1}/add-issues`, adminTok, { issue_ids: [cycIssue] });
    assert.strictEqual(rAddBack.status, 409, `⑬-C9锁定 加回旧批次应 409, got ${rAddBack.status} ${JSON.stringify(rAddBack.body)}`);
    assert.strictEqual(rAddBack.body.code, 'RELEASE_NOT_PLANNING', '⑬-C9锁定 code=RELEASE_NOT_PLANNING');
    const rel1AfterAddBack = await relRow(cycRel1);
    assert.strictEqual(rel1AfterAddBack.status, '已发布', '⑬-C9锁定 加回尝试后旧批次状态仍「已发布」（未被污染）');
    const issueAfterAddBack = await issueRow(cycIssue);
    assert.strictEqual(issueAfterAddBack.release_id, null, '⑬-C9锁定 加回被拒后 issue.release_id 仍为 null（未被误挂回旧批次）');
    const snapCountRow = await get(
      `SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id = ? AND issue_id = ?`,
      [cycRel1, cycIssue]
    );
    assert.strictEqual(snapCountRow.c, 1, '⑬-C9锁定 快照表 (release_id,issue_id) 仍恰 1 行（未产生重复/未被覆盖）');
    ok('⑬-C9锁定 已发布批次成员 close→reopen 后加回同一旧批次 → 409 RELEASE_NOT_PLANNING + 批次状态/issue.release_id/快照行数三处均未被污染（HIGH-2 轻量采纳）');

    // 重新开发到待上线（估时→提交→验收，dev_assignee 沿用首轮完成态实例，reopen 不清 dev_status——同
    // verify-sys-multidev-members.js S10g 既有结论，本组直接复用而非重复证明）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending' WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [cycIssue]);
    const rEst = await call('POST', `/api/sys-issues/${cycIssue}/estimate`, dev5Tok, { dev_estimated_at: '2031-02-01 10:00', estimated_effort_days: 1 });
    assert.strictEqual(rEst.status, 200, `⑬estimate 应 200, got ${rEst.status} ${JSON.stringify(rEst.body)}`);
    const rSubmit = await call('POST', `/api/sys-issues/${cycIssue}/submit`, dev5Tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-27' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(rSubmit.status, 200, `⑬submit 应 200, got ${rSubmit.status} ${JSON.stringify(rSubmit.body)}`);
    const rAccept = await call('POST', `/api/sys-issues/${cycIssue}/accept`, adminTok, {});
    assert.strictEqual(rAccept.status, 200, `⑬accept 应 200, got ${rAccept.status} ${JSON.stringify(rAccept.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '待上线', '⑬重新走完流程回到待上线');

    // 加入新批次 → 再走一遍执行人选定+行级通知+execute。
    const cycRel2 = await mkRelease({ plannedDate: d13 });
    await addIssuesTo(cycRel2, [cycIssue]);
    const rowsMap13b = await setExecutors(cycRel2, [5, 6]);
    await markSent(cycRel2, [5, 6]);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 6 号真成功且未提前触发发布。
    const r13bPre6 = await call('POST', `/api/sys-releases/${cycRel2}/execute`, dev6Tok, { executor_row_id: rowsMap13b[6] });
    assert.strictEqual(r13bPre6.status, 200, `⑬二轮-pre 6号预确认期望 200, got ${r13bPre6.status} ${JSON.stringify(r13bPre6.body)}`);
    assert.strictEqual(r13bPre6.body.released, false, '⑬二轮-pre 6号预确认不该提前触发发布');
    const rExec2 = await call('POST', `/api/sys-releases/${cycRel2}/execute`, dev5Tok, { release_note: 'C8跨阶段二发', version_tag: 'v-c8-2', executor_row_id: rowsMap13b[5] });
    assert.strictEqual(rExec2.status, 200, `⑬第二轮 execute 应 200, got ${rExec2.status} ${JSON.stringify(rExec2.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '已上线', '⑬二次发布后单再次翻已上线');
    assert.strictEqual((await issueRow(cycIssue)).release_id, cycRel2, '⑬release_id 指向新批次（非旧批次）');

    // 两轮发布互不干扰：新旧批次各自快照独立存在。
    const gm1Final = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    const gm2Final = await I.getReleaseMembers({ id: cycRel2, status: '已发布' });
    assert.strictEqual(gm1Final.source, 'snapshot', '⑬旧批次三次读取后仍 snapshot（第三次读取仍稳定）');
    assert.strictEqual(gm2Final.source, 'snapshot', '⑬新批次也是 snapshot 源');

    ok('⑬ C8 跨阶段冒烟：C0(排班表候选默认值)→执行人选定(PUT executors)→行级通知→execute→C4(snapshot 读源)→C6(归档+重开)→C9(回头路锁定)→重新开发→新批次→再走一遍，全链路两轮均通过，红线（release 不回计划中/快照不因归档重开降级）在真实执行人链路发布路径下同样成立——集成链路核心价值（归档重开+回头路锁定）与通知机制具体实现无关，C4b 只是替换了"执行人怎么定"这一步');
  }

  console.log(`\n✅ verify-sys-release-batch 全部通过（${passed} 组·C4b 收编后留存：cancel-schedule基础路径+快照v2+execute权限矩阵+两列族冻结+锁顺序不变量+C8跨阶段冒烟）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
