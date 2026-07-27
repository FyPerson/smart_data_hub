#!/usr/bin/env node
// 运维工具：修复「C0 受理门被破坏」——C0 已生效（或无法证明是旧库）而库里仍存在 intake_required != 1 的单据。
//
// 背景：C0（角色权限重构）把受理门焊死为全类型必经，intake_required 恒 1，并在 sys_issues 上建了拒绝型触发器。
//   启动收口 [F]（index.js runSysMigration）若发现此类非法行，会**保留数据不自动洗**、重建触发器、
//   并把 readiness 置 false（sys-* 写入口 503）。原因：自动把 ir 改成 1 会**把"绕过受理门"洗成表面合法**，
//   还抹掉判断该单真实流程历史的唯一信号。本脚本提供事务化、可审计、可重复的人工裁决通道。
//
// 用法：
//   node scripts/fix-sys-intake-gate-violation.js --db <path>                                   # dry-run（默认·只列清单）
//   node scripts/fix-sys-intake-gate-violation.js --db <path> --as-misfill --ids 12,15 --operator 示例用户A
//   node scripts/fix-sys-intake-gate-violation.js --db <path> --as-bypass  --ids 12    --operator 示例用户A
//
// 两种裁决：
//   --as-misfill  判定为"字段误写"：单据实际走过受理流程，只是 intake_required 被写错。
//                 动作：仅 intake_required=1，**不动 status、不清任何轮次字段**（那些是有效数据）。
//   --as-bypass   判定为"绕过受理门"：单据未经受理就进了后续流程 → 退回「待受理」重走。
//                 动作：status='待受理' + 复用主代码的 SYS_BACK_TO_INTAKE_GATE_SQL（intake_required=1
//                 + tech_lead_* 九列 + relay_* 七列整组归零）。**清单从 routes/sys-iteration/intake-gate-sql.js 取**，
//                 不在本脚本另写——曾因脚本自写清单只改两列，把单修成"表面合法、跨轮次状态仍脏"的半清状态。
//
// 安全约束：
//   · 默认 dry-run；写模式必须同时给 裁决模式 + --ids + --operator。
//   · --ids 严格校验：必须是纯正整数、不重复、且全部属于实际违规集合（含任何非违规 id 直接拒绝）。
//   · --as-bypass 只接受**前段状态**（待受理/待修改/待指派/待处理）；后期态（已进开发/上线/终态）拒绝自动处理，
//     因为它们已关联 roster/commit/release，简单退回会留下悬挂数据，必须逐单人工方案。
//   · type=config 拒绝（config 无受理流 transitions）。
//   · 写模式要求 C0 迁移标记已落；标记未落说明该库尚未进入 C0 语义，用本脚本属误用。
//   · 全程单事务（BEGIN IMMEDIATE），逐单条件更新 + changes!==1 即整体回滚。
//   · 每单写一条 sys_issue_timeline（event_type='note'）审计事件，记录裁决类型、原 status、操作人。
//   · 修完请重启服务：启动收口 [F] 会重新校验，通过后 readiness 才恢复。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const {
  SYS_BACK_TO_INTAKE_GATE_SQL,
  C0_INTAKE_GATE_MIGRATION_KEY,
  INTAKE_VIOLATION_WHERE,
} = require('../routes/sys-iteration/intake-gate-sql');
const T = require('../routes/sys-iteration/transitions');

// ⚠️ type 与 status 必须按**组合**校验，不能各用一个白名单（codex 八轮审 MED-1）：
//   两个独立白名单放行的是笛卡尔积，会让 bug/待指派、feature/待处理 这类**本就不合状态机**的组合
//   也被"自动修复"，等于把状态损坏一并掩盖。这里直接复用 transitions.js 的权威定义。
const SUPPORTED_TYPES = new Set(['bug', 'feature', 'improvement']);   // config 无受理流 transitions
// bypass 可安全自动回退的原状态 = 该 type 的**前段态**（尚未关联 roster/commit/release）：
//   受理门两态（全类型共有）+ 该 type 的无受理落点（feature/improvement=待指派·bug=待处理）。
const bypassSafeStatuses = (type) => new Set(['待受理', '待修改', T.INITIAL_STATUS_WITHOUT_INTAKE_BY_TYPE[type]].filter(Boolean));
// misfill 至少要求 status 属于该 type 的合法状态集（拒绝未知/跨 type 的脏状态一并被掩盖）
const isKnownStatus = (type, status) => Array.isArray(T.ALLOWED_STATUSES[type]) && T.ALLOWED_STATUSES[type].includes(status);

function fail(msg, code = 2) { console.error(`\n❌ ${msg}`); process.exit(code); }

// 严格参数解析（codex 七轮审 MED-3）：拒绝畸形 id、重复 id、双模式、未知参数、缺值参数。
function parseArgs(argv) {
  const out = { db: null, mode: null, ids: null, operator: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const needVal = (name) => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`参数 ${name} 缺少值`);
      return v;
    };
    switch (a) {
      case '--db': out.db = needVal('--db'); break;
      case '--operator': out.operator = needVal('--operator'); break;
      case '--ids': {
        const raw = needVal('--ids').split(',').map(s => s.trim()).filter(Boolean);
        const ids = [];
        for (const tok of raw) {
          if (!/^[1-9][0-9]*$/.test(tok)) fail(`--ids 含非法 token「${tok}」（必须是纯正整数）`);
          const n = Number(tok);
          // ⚠️ 正则只保证十进制正整数，挡不住超出 JS 安全整数范围的值（精度丢失后会指向别的行）——
          //   直接操作生产库的工具不能有这种静默偏移（codex 九轮审 LOW）。
          if (!Number.isSafeInteger(n)) fail(`--ids 含超出安全整数范围的 id「${tok}」`);
          if (ids.includes(n)) fail(`--ids 含重复 id：${n}`);
          ids.push(n);
        }
        if (!ids.length) fail('--ids 为空');
        out.ids = ids;
        break;
      }
      case '--as-misfill':
      case '--as-bypass': {
        const m = a === '--as-bypass' ? 'bypass' : 'misfill';
        if (out.mode && out.mode !== m) fail('不能同时指定 --as-misfill 与 --as-bypass（两种裁决语义互斥）');
        out.mode = m;
        break;
      }
      default: fail(`未知参数「${a}」`);
    }
  }
  if (!out.db) fail('缺少 --db <sqlite路径>');
  return out;
}

const args = parseArgs(process.argv);
// ⚠️ 打开模式必须显式（codex 九轮审 MED-2）：sqlite3 默认带 OPEN_CREATE，--db 路径拼错时会**凭空造一个空库**，
//   然后才因缺表报错——既与"dry-run 只读、未做任何修改"的运维预期冲突，也会把路径错误伪装成数据问题。
//   dry-run → 只读；写模式 → 读写但**不允许创建**。打开前先确认目标是已存在的普通文件。
const dbAbs = path.resolve(args.db);
if (!fs.existsSync(dbAbs) || !fs.statSync(dbAbs).isFile()) {
  console.error(`\n❌ 数据库文件不存在或不是普通文件：${dbAbs}`);
  process.exit(2);
}
const openMode = args.mode ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY;
const db = new sqlite3.Database(dbAbs, openMode, (e) => {
  if (e) { console.error(`\n❌ 打开数据库失败（${args.mode ? '读写' : '只读'}模式）：${dbAbs}\n   ${e.message}`); process.exit(2); }
});
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, rows) => e ? rej(e) : res(rows || [])));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, row) => e ? rej(e) : res(row)));

async function main() {
  const markerTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_schema_migrations'`);
  const marker = markerTable
    ? await get(`SELECT migration_key, applied_at FROM sys_schema_migrations WHERE migration_key=?`, [C0_INTAKE_GATE_MIGRATION_KEY])
    : null;
  const violations = await all(
    `SELECT id, type, status, intake_required, title, created_at FROM sys_issues WHERE ${INTAKE_VIOLATION_WHERE} ORDER BY id`);

  console.log(`\n库：${path.resolve(args.db)}`);
  console.log(`C0 迁移标记：${marker ? `已落（${marker.applied_at}）` : (markerTable ? '未落' : '标记表 sys_schema_migrations 不存在')}`);
  console.log(`违规单据（${INTAKE_VIOLATION_WHERE}）：${violations.length} 条`);
  if (!violations.length) {
    console.log('✅ 无违规数据。若服务仍 503，请看启动日志 [系统迭代] 段确认触发器是否就位。');
    return;
  }
  for (const v of violations) {
    const flags = [];
    if (!SUPPORTED_TYPES.has(v.type)) flags.push('type不支持受理流');
    else {
      if (!isKnownStatus(v.type, v.status)) flags.push(`status「${v.status}」不属于 ${v.type} 的合法状态集`);
      else if (!bypassSafeStatuses(v.type).has(v.status)) flags.push('后期态·bypass不可自动回退');
    }
    console.log(`  #${v.id}  type=${v.type}  status=${v.status}  ir=${v.intake_required}  created=${v.created_at}  ${v.title}${flags.length ? '   ⚠️ ' + flags.join('·') : ''}`);
  }

  if (!args.mode) {
    console.log('\n【dry-run】未指定裁决模式，未做任何修改。');
    console.log('  逐单查 timeline 判断该单是否真的走过受理：');
    console.log('    SELECT event_type, action_code, from_status, to_status, summary, created_at FROM sys_issue_timeline WHERE issue_id=? ORDER BY id;');
    console.log('  · 走过受理、只是字段写错 → --as-misfill --ids <..> --operator <你的名字>');
    console.log('  · 未经受理就进了后续流程 → --as-bypass  --ids <..> --operator <你的名字>');
    console.log('    （bypass 会把 status 退回「待受理」并清空 tech_lead_*/relay_* 轮次字段）');
    console.log('  两类混杂时分两次执行；带 ⚠️ 的单不支持自动处理，需逐单人工方案。');
    return;
  }

  // ── 写模式前置校验 ──────────────────────────────────────────────
  if (!args.operator || !args.operator.trim()) fail('写模式必须提供 --operator <裁决人>（审计要记录"谁做的裁决"）');
  if (!args.ids) fail('写模式必须提供 --ids（防误伤：不允许一次性处理全部）');
  if (!marker) {
    fail('C0 迁移标记未落（或标记表缺失）：该库尚未进入 C0 语义，用本脚本属误用。' +
         '请先让服务正常启动跑完迁移，再按启动日志的指引处理。');
  }

  const actualIds = violations.map(v => v.id);
  const unknown = args.ids.filter(id => !actualIds.includes(id));
  if (unknown.length) fail(`--ids 含非违规单：${unknown.join(',')} → 拒绝执行（防误伤）`);

  const targets = violations.filter(v => args.ids.includes(v.id));
  const badType = targets.filter(t => !SUPPORTED_TYPES.has(t.type));
  if (badType.length) fail(`以下单的 type 不支持受理流（config 无 transitions），拒绝自动处理：${badType.map(t => `#${t.id}(${t.type})`).join(' ')}`);
  // type×status **组合**校验（八轮审 MED-1）：先拒绝该 type 下根本不合法的状态，避免把状态损坏一并掩盖
  const badStatus = targets.filter(t => !isKnownStatus(t.type, t.status));
  if (badStatus.length) {
    fail(`以下单的 status 不属于其 type 的合法状态集，说明状态本身已损坏（不只是 intake_required 写错），拒绝自动处理：` +
         `${badStatus.map(t => `#${t.id}(${t.type}/${t.status})`).join(' ')}\n` +
         `  请先查明状态为何非法并单独修复，再回来处理受理门标志位。`);
  }
  if (args.mode === 'bypass') {
    const late = targets.filter(t => !bypassSafeStatuses(t.type).has(t.status));
    if (late.length) {
      fail(`以下单处于后期状态，退回「待受理」会留下悬挂的 roster/commit/release 关联，拒绝自动处理：` +
           `${late.map(t => `#${t.id}(${t.type}/${t.status})`).join(' ')}\n` +
           `  正确做法是逐单人工方案（先解除指派/移出批次，再决定是否退回受理）。\n` +
           `  ⚠️ **不要**为了让服务尽快恢复而改判成 --as-misfill：misfill 的语义是"该单确实走过受理、只是字段写错"，\n` +
           `     必须先有证据（查 timeline 是否存在 intake_accept 事件）。若确系绕过受理，改判 misfill 等于把绕过\n` +
           `     包装成误写、并永久抹掉判别信号——那比继续 503 更糟。`);
    }
  }

  console.log(`\n即将按「${args.mode === 'bypass' ? '绕过受理·退回待受理并清轮次字段' : '字段误写·仅修标志位'}」处理 ${targets.length} 单（操作人：${args.operator}）…`);

  await run('BEGIN IMMEDIATE');
  try {
    for (const t of targets) {
      // 条件更新：带上原 status 与违规条件，防并发/状态已变时误改
      const sets = args.mode === 'bypass'
        ? [`status = '待受理'`, ...SYS_BACK_TO_INTAKE_GATE_SQL]          // ⭐ 复用主代码清单（单一真相源）
        : ['intake_required = 1'];
      const upd = await run(
        `UPDATE sys_issues SET ${sets.join(', ')}, updated_at = datetime('now','localtime')
          WHERE id = ? AND status = ? AND (${INTAKE_VIOLATION_WHERE})`, [t.id, t.status]);
      if (!upd || upd.changes !== 1) throw new Error(`#${t.id} 条件更新 changes=${upd && upd.changes}（并发或状态已变）→ 整体回滚`);

      // ⚠️ 审计强度（八轮审 MED-3）：--operator 是自由文本，只能证明"有人填了个名字"。
      //   故一并记录执行环境（OS 账号@主机）——它不依赖调用者填写，是可交叉核对的客观信号。
      //   timeline.operator_id 保持 NULL：本脚本在应用之外运行，没有可信的平台用户身份可绑。
      const execCtx = `${os.userInfo().username}@${os.hostname()}`;
      const summary = args.mode === 'bypass'
        ? `【受理门修复】判定为绕过受理：状态由「${t.status}」退回「待受理」，intake_required ${t.intake_required}→1，并清空技术负责人/对接人通知的上一轮字段。裁决人：${args.operator}（执行环境 ${execCtx}）`
        : `【受理门修复】判定为字段误写：状态保持「${t.status}」不变，intake_required ${t.intake_required}→1。裁决人：${args.operator}（执行环境 ${execCtx}）`;
      await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
         VALUES (?, 'note', ?, ?, ?, NULL, ?)`,
        [t.id, t.status, args.mode === 'bypass' ? '待受理' : t.status, summary, args.operator]);
      console.log(`  ✓ #${t.id} 已处理`);
    }
    const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${INTAKE_VIOLATION_WHERE}`);
    await run('COMMIT');
    console.log(`\n✅ 完成。剩余违规单：${left.c} 条。`);
    console.log(left.c === 0
      ? '  请重启服务：启动收口会重新校验，通过后 readiness 恢复、写入口放行。'
      : '  仍有违规单未处理，服务会继续 503，请对剩余单据继续裁决。');
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) { /* best-effort */ }
    fail(`处理失败，已整体回滚：${e && e.message}`, 1);
  }
}

main().then(() => db.close()).catch((e) => {
  console.error('❌ 异常：', e && e.stack || e);
  try { db.close(); } catch (_) { /* ignore */ }
  process.exit(1);
});
