/**
 * _demo-reset-sys-iteration.js — 系统迭代模块：清空测试数据 + 重造演示数据（临时脚本）
 *
 * 用法：
 *   清空 + 重造：node scripts/_demo-reset-sys-iteration.js
 *   只清空：      node scripts/_demo-reset-sys-iteration.js --clean
 *   只看不改：    node scripts/_demo-reset-sys-iteration.js --dry-run
 *
 * ⚠️ 本脚本对 sys_* **业务表做全表清空**（用户 2026-08-04 明确要求），不是按前缀匹配删除。
 *   保留的配置/元数据表（清了功能会坏）：
 *     sys_domains（业务系统列表）／sys_source_systems／system_configs／sys_schema_migrations
 *   同时清理 uploads/sys-iteration/ 下的附件物理文件（保留 _pending 临时目录）。
 *
 * ⚠️ 教训继承（写在 _demo-seed-commit-cols.js 里的 2026-08-03 踩坑）：
 *   "给批量删除用的匹配前缀，必须先 SELECT 看清命中什么再删"。本次是**全表清空**、
 *   范围由用户显式拍板，故不用前缀匹配；但执行前仍打印每张表的行数，删完再打印一次，
 *   让"删了什么"可核对。动手前已备份 task_pool.db.backup_before_demo_reset_*。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'sys-iteration');
const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

const CLEAN_ONLY = process.argv.includes('--clean');
const DRY_RUN = process.argv.includes('--dry-run');

// ── 要清空的业务表（顺序 = 先子后父，避免外键报错）────────────────────────────────
const WIPE_TABLES = [
  'sys_issue_release_commit_snapshots',
  'sys_issue_dev_commits',
  'sys_issue_dev_events',
  'sys_issue_dev_assignees',
  'sys_issue_attachments',
  'sys_issue_timeline',
  'sys_issue_delete_audit',
  'sys_release_duty_roster',
  'sys_issues',
  'sys_releases',
];
// ── 明确保留的配置表（仅用于报告，脚本永不触碰）────────────────────────────────
const KEEP_TABLES = ['sys_domains', 'sys_source_systems', 'system_configs', 'sys_schema_migrations'];

// ── 人员（本地 users 真实姓名，用户 2026-08-04 拍板"内部演示用真名"）──────────────
const ADMIN = { id: 1, name: '管理员' };
const LIAISON = { id: 13, name: '示例对接人' };          // 对接人
const PUBLISHER = { id: 7, name: '示例发布者' };            // 发布/执行人
const DEV = {
  jin: { id: 10, name: '示例开发C' },
  liu: { id: 8, name: '示例开发A' },
  zhang: { id: 9, name: '示例开发B' },
  rao: { id: 12, name: '示例开发D' },
  du: { id: 19, name: '示例用户B' },
};
const REQ = [
  { dept: '市场部', name: '示例客服B', phone: '13800000001' },
  { dept: '财务部', name: '示例客服C', phone: '13800000002' },
  { dept: '工程部', name: '示例只读领导B', phone: '13800000003' },
  { dept: '人力资源部', name: '示例只读领导A', phone: '13800000004' },
  { dept: '综合管理部', name: '示例客服A', phone: '13800000005' },
];

const D = (n) => {           // 相对今天的日期 'YYYY-MM-DD'
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const DT = (n, hm) => `${D(n)} ${hm}`;   // 'YYYY-MM-DD HH:MM'
const TS = (n, hm = '09:30') => `${D(n)} ${hm}:00`;

// ══════════════════════════════════════════════════════════════════════════
// 演示单据设计：20 张，覆盖完整流程 + 刻意安排「四处优化」的展示点
//   ② 期望完成到时分 → deadline 刻意混排：一部分带 HH:MM、一部分纯日期（展示混存排序正确）
//   ③ 复制拆前端/后端 → 批次 A 内四种 commit 形态：前端多条折叠 / 前后端都有 / 仅后端 / 空
//   ④ 弹窗放大        → 批次 A 塞 5 张单，行内元素最满
// ══════════════════════════════════════════════════════════════════════════
const ISSUES = [
  // ── 待受理（3）──────────────────────────────────────────────────
  { k: 'a1', type: 'feature', status: '待受理', title: '合同台账导出增加按签订日期区间筛选', sys: 'BMS', mod: '合同管理',
    pri: 'P2', src: '业务方', req: 0, deadline: DT(12, '17:00'), desc: '目前导出只能全量，月度对账时要手工删行。希望能按签订日期选区间再导出。' },
  { k: 'a2', type: 'improvement', status: '待受理', title: '报表中心首页加载慢，打开要等十几秒', sys: 'OA', mod: '报表中心',
    pri: 'P1', src: '业务方', req: 1, deadline: D(8), desc: '每天早上打开首页都要等很久，影响晨会看数。' },
  { k: 'a3', type: 'bug', status: '待受理', title: '供应商档案页翻到第 3 页后搜索条件被清空', sys: 'BMS', mod: '供应商管理',
    pri: 'P1', src: '业务方', req: 2, deadline: DT(5, '12:00'), desc: '筛选出结果后翻页，回到第 1 页条件就没了，要重新选一遍。' },

  // ── 待修改（1）──────────────────────────────────────────────────
  { k: 'b1', type: 'feature', status: '待修改', title: '希望能自动生成月度供应商对账单', sys: 'BMS', mod: '对账',
    pri: 'P2', src: '业务方', req: 1, deadline: D(20), desc: '需求描述不够具体，已退回补充：对账口径、生成频率、发送对象。' },

  // ── 待指派（2）──────────────────────────────────────────────────
  { k: 'c1', type: 'feature', status: '待指派', title: '客户档案支持 Excel 批量导入', sys: 'BMS', mod: '客户管理',
    pri: 'P2', src: '业务方', req: 0, deadline: DT(18, '18:00'), desc: '新客户批量建档，现在只能一条条录。', oa: '2026080012' },
  { k: 'c2', type: 'improvement', status: '待指派', title: '招投标看板增加"距开标日剩余天数"提示', sys: '智数协同', mod: '招投标看板',
    pri: 'P3', src: '内部', req: 3, deadline: D(25) },

  // ── 开发中 / 处理中（4）· 带 commit ──────────────────────────────
  { k: 'd1', type: 'feature', status: '开发中', title: '发票查验接口对接税务平台', sys: 'BMS', mod: '发票管理',
    pri: 'P1', src: '业务方', req: 1, deadline: DT(10, '17:30'), est: DT(9, '18:00'), oa: '2026080008',
    devs: [DEV.jin], commits: [['frontend', 'a3f9c21'], ['frontend', '7bd0e14']] },
  { k: 'd2', type: 'feature', status: '开发中', title: '合同履约进度可视化改造', sys: 'BMS', mod: '合同管理',
    pri: 'P1', src: '业务方', req: 2, deadline: DT(15, '12:00'), est: DT(14, '17:00'), oa: '2026080009',
    devs: [DEV.liu, DEV.zhang],
    // ⭐ 前端 5 条：列表页会折叠成「首条 + 等5条」，正好演示 ③ 的复制按钮能拿到完整清单
    commits: [['frontend', 'c81a44f'], ['frontend', '2e6b930'], ['frontend', 'd07f158'], ['frontend', '9a3c5e2'], ['frontend', 'b45d7c1'], ['backend', 'f12e8a6']] },
  { k: 'd3', type: 'bug', status: '处理中', title: '合同列表按金额排序结果不对', sys: 'BMS', mod: '合同管理',
    pri: 'P0', src: '生产故障', req: 0, deadline: DT(2, '10:00'), est: DT(1, '16:00'),
    devs: [DEV.jin], commits: [['frontend', '5c2b8d3'], ['backend', 'e934f70']] },
  { k: 'd4', type: 'improvement', status: '开发中', title: '组织架构同步任务改为增量拉取', sys: 'HRD', mod: '组织同步',
    pri: 'P2', src: '内部', req: 3, deadline: D(16), est: DT(15, '12:00'),
    // ⭐ 仅后端：演示 ③ 的"该组为空就不渲染该侧按钮"
    devs: [DEV.rao], commits: [['backend', '8f61ac4'], ['backend', '3d95e08']] },

  // ── 待验证（2）──────────────────────────────────────────────────
  { k: 'e1', type: 'feature', status: '待验证', title: '报表订阅推送（按周/按月发到钉钉）', sys: 'OA', mod: '报表中心',
    pri: 'P2', src: '业务方', req: 4, deadline: DT(6, '17:00'), est: DT(4, '18:00'), oa: '2026080005',
    devs: [DEV.du], commits: [['frontend', '6ba0d29'], ['backend', 'af73c15']] },
  { k: 'e2', type: 'bug', status: '待验证', title: '员工离职后仍出现在项目成员下拉里', sys: 'HRD', mod: '人员管理',
    pri: 'P1', src: '业务方', req: 3, deadline: DT(3, '12:00'), est: DT(2, '17:00'),
    devs: [DEV.rao], commits: [['backend', '04e8b6d']] },

  // ── 待上线（5）→ 批次 A ⭐④ 弹窗放大主展示 ────────────────────────
  { k: 'f1', type: 'feature', status: '待上线', title: '合同台账导出模板增加"含税金额"列', sys: 'BMS', mod: '合同管理',
    pri: 'P2', src: '业务方', req: 0, deadline: DT(4, '17:00'), est: DT(2, '18:00'), oa: '2026080001', rel: 'A',
    devs: [DEV.jin], commits: [['frontend', '1f4a7e9'], ['backend', 'c206b83']] },
  { k: 'f2', type: 'improvement', status: '待上线', title: '首页待办卡片支持折叠收起', sys: '智数协同', mod: '首页',
    pri: 'P3', src: '内部', req: 4, deadline: D(4), est: DT(3, '12:00'), rel: 'A',
    // ⭐ 前端 4 条：批次详情里也会折叠，配合复制按钮演示
    devs: [DEV.liu], commits: [['frontend', 'b7e2f01'], ['frontend', '38c9d54'], ['frontend', 'e15a6b2'], ['frontend', '9d403cf']] },
  { k: 'f3', type: 'bug', status: '待上线', title: '导出 Excel 中文列名偶发乱码', sys: 'OA', mod: '报表中心',
    pri: 'P1', src: '生产故障', req: 1, deadline: DT(4, '10:00'), est: DT(2, '16:30'), rel: 'A',
    devs: [DEV.zhang], commits: [['backend', '7a1c9e5']] },
  { k: 'f4', type: 'feature', status: '待上线', title: '供应商准入台账新建', sys: 'BMS', mod: '供应商管理',
    pri: 'P2', src: '业务方', req: 2, deadline: D(4), est: DT(3, '17:00'), oa: '2026080002', rel: 'A',
    devs: [DEV.du, DEV.rao], commits: [['frontend', '2c5f8a0'], ['backend', 'd83b1e7'], ['backend', '6e07f42']] },
  // ⭐ 刻意留一张**没有 commit** 的待上线单：演示 ③ 的"两组皆空 → 一个按钮都不渲染"
  { k: 'f5', type: 'improvement', status: '待上线', title: '菜单顺序按使用频率重排（无代码变更）', sys: '智数协同', mod: '导航',
    pri: 'P3', src: '内部', req: 4, deadline: D(4), est: DT(3, '15:00'), rel: 'A', devs: [DEV.liu], commits: [] },

  // ── 待上线（1）→ 批次 B（第二个计划中批次）────────────────────────
  { k: 'g1', type: 'feature', status: '待上线', title: '客户档案页增加"最近联系记录"区块', sys: 'BMS', mod: '客户管理',
    pri: 'P2', src: '业务方', req: 0, deadline: DT(11, '17:00'), est: DT(9, '18:00'), rel: 'B',
    devs: [DEV.jin], commits: [['frontend', 'f5820ad'], ['backend', '41c7e96']] },

  // ── 已上线（1）→ 批次 C（已发布·带 commit 快照）──────────────────
  { k: 'h1', type: 'feature', status: '已上线', title: '合同附件支持在线预览 PDF', sys: 'BMS', mod: '合同管理',
    pri: 'P2', src: '业务方', req: 2, deadline: DT(-3, '17:00'), est: DT(-4, '18:00'), oa: '2026070021', rel: 'C',
    devs: [DEV.zhang], commits: [['frontend', 'ab3f019'], ['backend', '5d2c8e4']] },

  // ── 已暂缓（1）──────────────────────────────────────────────────
  { k: 'i1', type: 'bug', status: '已暂缓', title: '移动端签批页偶发白屏（待复现）', sys: 'OA', mod: '移动端',
    pri: 'P2', src: '业务方', req: 3, deadline: D(30), est: DT(20, '17:00'),
    devs: [DEV.du], commits: [], blocked: 1, blockedReason: '线上无法稳定复现，等业务方提供复现步骤与设备信息后再排期' },
];

const RELEASES = [
  { k: 'A', no: `R-${D(4).replace(/-/g, '')}-1`, title: `${D(4)} 常规上线批`, status: '计划中', planned: D(4), assignee: PUBLISHER },
  { k: 'B', no: `R-${D(11).replace(/-/g, '')}-1`, title: `${D(11)} 常规上线批`, status: '计划中', planned: D(11), assignee: null },
  { k: 'C', no: `R-${D(-3).replace(/-/g, '')}-1`, title: `${D(-3)} 常规上线批`, status: '已发布', planned: D(-3), assignee: PUBLISHER, releasedAt: TS(-3, '20:10') },
];

// 值班排班：今天起 4 周工作日轮值
const DUTY_POOL = [PUBLISHER, DEV.jin, DEV.liu, DEV.zhang];

async function tableCounts(tag) {
  console.log(`\n  ── ${tag} ──`);
  for (const t of WIPE_TABLES) {
    const r = await get(`SELECT COUNT(*) c FROM "${t}"`).catch(() => null);
    console.log('   ', String(r ? r.c : '?').padStart(5), t);
  }
}

async function wipe() {
  await tableCounts('清空前');
  if (DRY_RUN) { console.log('\n  [dry-run] 未执行任何删除'); return; }
  await run('BEGIN IMMEDIATE');
  try {
    for (const t of WIPE_TABLES) await run(`DELETE FROM "${t}"`);
    // 重置自增，让新造的单据从 1 开始（演示时单号好看）
    await run(`DELETE FROM sqlite_sequence WHERE name IN (${WIPE_TABLES.map(() => '?').join(',')})`, WIPE_TABLES).catch(() => {});
    await run('COMMIT');
  } catch (e) { await run('ROLLBACK').catch(() => {}); throw e; }

  // 附件物理文件：只删 issue_id 数字目录，保留 _pending 临时目录
  let removed = 0;
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (name === '_pending') continue;
      fs.rmSync(path.join(UPLOAD_DIR, name), { recursive: true, force: true });
      removed++;
    }
  }
  console.log(`\n  附件物理目录已清理 ${removed} 个（保留 _pending）`);
  await tableCounts('清空后');
}

async function seed() {
  const relIds = {};
  for (const r of RELEASES) {
    const res = await run(
      `INSERT INTO sys_releases (release_no, title, status, is_hotfix, planned_date, released_at, created_by, created_by_name,
         release_assignee_id, release_assignee_name, release_assignee_notify_status, created_at)
       VALUES (?,?,?,0,?,?,?,?,?,?,?,?)`,
      [r.no, r.title, r.status, r.planned, r.releasedAt || null, ADMIN.id, ADMIN.name,
       r.assignee ? r.assignee.id : null, r.assignee ? r.assignee.name : null,
       r.assignee ? 'sent' : 'not_sent', TS(-6, '10:00')]
    );
    relIds[r.k] = res.lastID;
  }

  const issueIds = {};
  for (const it of ISSUES) {
    const rq = REQ[it.req];
    const res = await run(
      `INSERT INTO sys_issues
        (type, status, priority, title, description, system_name, module_name, source,
         requester_dept, requester_name, requester_phone, deadline, dev_estimated_at,
         created_by, created_by_name, intake_required, intake_liaison_id, oa_number, oa_exempt,
         needs_feasibility, blocked, blocked_reason, blocked_at, release_id, record_source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,0,?,?,?,?,'native',?,?)`,
      [it.type, it.status, it.pri, it.title, it.desc || null, it.sys, it.mod || null, it.src,
       rq.dept, rq.name, rq.phone, it.deadline || null, it.est || null,
       ADMIN.id, ADMIN.name, LIAISON.id, it.oa || null, it.oa ? 0 : 1,
       it.blocked || 0, it.blockedReason || null, it.blocked ? TS(-1, '15:00') : null,
       it.rel ? relIds[it.rel] : null, TS(-7, '09:20'), TS(-1, '16:40')]
    );
    const iid = res.lastID;
    issueIds[it.k] = iid;

    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, to_status, summary, operator_id, operator_name, created_at)
               VALUES (?, 'created', '待受理', ?, ?, ?, ?)`,
      [iid, `建单（需求方：${rq.dept} ${rq.name}）`, ADMIN.id, ADMIN.name, TS(-7, '09:20')]);

    for (const dv of (it.devs || [])) {
      const da = await run(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, notify_status, notified_at)
         VALUES (?,?,?,?,?, 'sent', ?)`,
        [iid, dv.id, dv.name, it.devs.indexOf(dv) === 0 ? 1 : 0,
         ['待验证', '待上线', '已上线'].includes(it.status) ? 'resolved' : 'pending', TS(-6, '10:30')]
      );
      dv._daId = da.lastID;
    }
    let ci = 0;
    for (const [comp, ref] of (it.commits || [])) {
      const owner = (it.devs || [])[0];
      if (!owner) continue;
      await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
                 VALUES (?,?,?,?,?,?)`,
        [iid, owner._daId, owner.id, comp, ref, TS(-5, `1${ci % 6}:0${ci % 6}`)]);
      ci++;
    }
    // 已发布批次要写 commit 冻结快照 —— 表结构是「每(批次,单据)一行 + snapshot_json 存数组」，
    //   不是逐 commit 一行；payload 结构照 snapshotReleaseCommitsInTxn（index.js:7235）逐字对齐。
    // ⚠️ 这里**刻意不加 .catch 静默吞**：首版加了，快照插失败却报"完成"、结果 0 行还得回头查。
    if (it.rel === 'C') {
      const rows = await all(
        `SELECT id AS commit_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at
           FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id ASC`, [iid]);
      const payload = { schema_version: 2, type: it.type, title_snapshot: it.title, status_at_publish: '已上线', commits: rows };
      await run(`INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at)
                 VALUES (?,?,?,?)`, [relIds.C, iid, JSON.stringify(payload), TS(-3, '20:10')]);
    }
  }

  // 值班排班：今天起 4 周工作日
  let di = 0;
  for (let n = 0; n < 28; n++) {
    const d = new Date(Date.now() + n * 86400000);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const who = DUTY_POOL[di % DUTY_POOL.length];
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, created_at)
               VALUES (?,?,?,?,?,?)`,
      [D(n), who.id, who.name, ADMIN.id, ADMIN.name, TS(-7, '09:00')]);
    di++;
  }

  const cnt = async (t) => (await get(`SELECT COUNT(*) c FROM "${t}"`)).c;
  console.log('\n  ── 造数结果 ──');
  console.log('    迭代单        ', await cnt('sys_issues'));
  console.log('    上线批次      ', await cnt('sys_releases'), '（A/B 计划中·C 已发布）');
  console.log('    开发成员      ', await cnt('sys_issue_dev_assignees'));
  console.log('    commit 编码   ', await cnt('sys_issue_dev_commits'));
  console.log('    发布快照      ', await cnt('sys_issue_release_commit_snapshots'));
  console.log('    时间线        ', await cnt('sys_issue_timeline'));
  console.log('    值班排班      ', await cnt('sys_release_duty_roster'), '（今起 4 周工作日）');
}

(async () => {
  try {
    console.log('系统迭代模块 · 演示数据重置');
    console.log('  库:', DB_PATH);
    console.log('  保留的配置表（永不触碰）:', KEEP_TABLES.join(' / '));
    await wipe();
    if (!CLEAN_ONLY && !DRY_RUN) await seed();
    console.log('\n✅ 完成' + (CLEAN_ONLY ? '（仅清空）' : DRY_RUN ? '（dry-run）' : ''));
  } catch (e) {
    console.error('\n❌ 失败:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
