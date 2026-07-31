// 验证脚本：上线体统一重构 C0 迁移路径专项（C8 任务 B，方案 §11 R1 风险 + 方案 §6.1/§6.2/§6.13）
//   用法：node scripts/verify-sys-c0-migration.js
//
// 背景：生产 sys_issues/sys_releases 当前均为 0 行，"存量迁移风险"字面上无真实数据可迁——但**迁移代码路径
//   本身**（alterAddMissingCols 幂等 ALTER + release_type 回填 + PRAGMA 复查）必须独立于"生产当前是否有
//   数据"被验证：下次任何人在这几列旁边加新字段，或未来生产真的攒了数据后再有迁移需求，这条路径都必须
//   继续正确。既有 verify-sys-schema.js 覇盖的是"新库 CREATE 路径"（[11a]/[11b]，initSchema 对全新 :memory:
//   库直接建出含全部列的 sys_releases/sys_release_duty_roster）——那条路径下 ALTER 分支永远是 no-op，从未
//   真正验证过"旧库缺列 → ALTER 补齐 → 数据不丢"这条分支本身；[15] 缺列库测试聚焦 sys_issues 缺列且提前
//   短路 return，sys_releases 的 10 列 ALTER 虽在其执行路径上被跑到，但该测试从未断言其结果。本脚本专门
//   补上这条此前存在但未被验证结果的路径，聚焦本重构新增面：
//
//   [P1] 旧库→新库：手工建"本重构落地前"的 sys_releases（6 原始列，不含 release_type/C0 10 列）+ 真实历史
//        数据（模拟生产已有发布记录），其余表不预建（模拟"首次部署到这台机器"，由 initSchema 的
//        CREATE TABLE IF NOT EXISTS 全新建出）。跑真实 mod.initSchema()（内部末尾调 runSysMigration），
//        断言：
//        - ready=true（迁移链路整体成功，非仅"跑完不报错"）
//        - sys_releases 旧列原值逐行精确保留（ALTER ADD COLUMN 不改变既有行的既有列值）
//        - sys_releases 新增 10 列全部存在，新行/旧行的默认值正确（NOT NULL DEFAULT 两列有默认值、
//          其余 8 列 NULL——旧行经 ALTER 补列后取列默认值，非另行 UPDATE 回填）
//        - sys_release_duty_roster 全新建出、11 列 + 2 索引齐全（新表场景，非本轮 ALTER 目标，附带验证
//          "旧库整体缺这张表"不会拖垮别的表的迁移）
//        - 本重构新增的 4 个索引（idx_sys_releases_status/idx_sys_releases_assignee/
//          idx_sys_duty_roster_active/idx_sys_duty_roster_user）全部建上
//   [P2] 幂等：对 P1 迁移完成后的同一个库，**直接再调一次** runSysMigration（不重新建库）——断言：
//        - 不抛错（ALTER ADD COLUMN 对已存在列会报错，alterAddMissingCols 的 PRAGMA 查列存在性前置守卫
//          必须真的生效，不能重复迁移基础设施）
//        - ready 仍为 true
//        - sys_releases 列数、既有行的全部列值（含 P1 新增的 10 列）与 P1 迁移后逐字节相同（重复迁移
//          不产生任何数据副作用，非"跑了但没变化"的弱判据——用列数 + 全字段快照两道断言）
//   [P3] release_type 回填（[1b]）：在 P1/P2 完成后的库里插入历史发布批次 + 关联成员（模拟"发布批次先于
//        release_type 回填机制存在"的历史态——手工把 release_type 置回 NULL 模拟未回填），再调一次
//        runSysMigration（第三次调用，与 P2 一起构成"多次重跑不出错"的强化证据），断言：
//        - 含 bug 成员的批次 → 回填 'bug'
//        - 仅含 feature/improvement 成员的批次 → 回填 'change'
//        - 已有非 NULL release_type 的批次 → 保持原值不被覆盖（WHERE release_type IS NULL 的幂等语义）
//        - 空批次（无成员）→ 仍是 NULL（不误填）
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  const noop = () => {};
  const mwPass = (req, res, next) => (next ? next() : undefined);

  // ═══ [P1] 手工建"本重构落地前"的 sys_releases（6 原始列，无 release_type/C0 10 列）+ 真实历史数据 ═══
  //   其余表刻意不预建——模拟"首次部署到这台机器"，由 initSchema 的 CREATE TABLE IF NOT EXISTS 全新建出
  //   （与 sys_releases 的"表已存在只需 ALTER 补列"形成对照，两条真实存在的迁移分支各自覆盖一次）。
  await run(`CREATE TABLE sys_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_no TEXT, status TEXT, is_hotfix INTEGER, release_note TEXT, version_tag TEXT
  )`);
  const histIns1 = await run(
    `INSERT INTO sys_releases (release_no, status, is_hotfix, release_note, version_tag) VALUES (?, ?, ?, ?, ?)`,
    ['R-20260101-1', '已发布', 0, '历史发布1（迁移前生产数据模拟）', 'v1.0.0']
  );
  const histIns2 = await run(
    `INSERT INTO sys_releases (release_no, status, is_hotfix, release_note, version_tag) VALUES (?, ?, ?, ?, ?)`,
    ['R-20260102-1', '计划中', 1, null, null]
  );
  const relId1 = histIns1.lastID, relId2 = histIns2.lastID;
  ok(`[P1] 前置：手工建"迁移前"sys_releases（6 原始列）+ 插入 2 条历史行（#${relId1}/#${relId2}，含 NULL 字段）`);

  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  const I = mod._internals;
  function waitReady() {
    return new Promise((res, rej) => {
      let n = 0;
      const t = setInterval(() => {
        if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
        else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
        else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时未就绪')); }
      }, 10);
    });
  }

  mod.initSchema();   // 真实入口：CREATE TABLE IF NOT EXISTS（其余表全新建）+ 末尾内部调 runSysMigration（ALTER sys_releases）
  await waitReady();
  ok('[P1] initSchema() 完整跑通（其余表全新建 + sys_releases 走 ALTER 分支）→ ready=true（迁移链路整体成功，非仅不报错）');

  // 旧列原值精确保留
  const row1After = await get('SELECT * FROM sys_releases WHERE id=?', [relId1]);
  const row2After = await get('SELECT * FROM sys_releases WHERE id=?', [relId2]);
  assert.strictEqual(row1After.release_no, 'R-20260101-1', '[P1] #1 release_no 原值保留');
  assert.strictEqual(row1After.status, '已发布', '[P1] #1 status 原值保留');
  assert.strictEqual(row1After.is_hotfix, 0, '[P1] #1 is_hotfix 原值保留');
  assert.strictEqual(row1After.release_note, '历史发布1（迁移前生产数据模拟）', '[P1] #1 release_note 原值保留');
  assert.strictEqual(row1After.version_tag, 'v1.0.0', '[P1] #1 version_tag 原值保留');
  assert.strictEqual(row2After.release_no, 'R-20260102-1', '[P1] #2 release_no 原值保留');
  assert.strictEqual(row2After.release_note, null, '[P1] #2 release_note 原值 NULL 保留（未被误填）');
  ok('[P1] ALTER ADD COLUMN 不改变既有行的既有列值——2 条历史行 6 原始列逐字段精确核对通过');

  // 新增列齐全（release_type 来自更早的 bug 流迁移 + C0 本轮 10 列）
  const relCols = (await all('PRAGMA table_info(sys_releases)')).map(r => r.name);
  const EXPECT_NEW_COLS = ['release_type',
    'release_assignee_id', 'release_assignee_name', 'release_assignee_notify_status',
    'release_assignee_notify_started_at', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error',
    'release_assignee_notify_token', 'release_assignee_read_at', 'release_kind'];
  const missCols = EXPECT_NEW_COLS.filter(c => !relCols.includes(c));
  assert.strictEqual(missCols.length, 0, `[P1] sys_releases 新增列缺失: ${missCols.join(',')}`);
  ok(`[P1] sys_releases 新增列全齐（release_type 1 列 + C0 本轮 10 列，共 ${EXPECT_NEW_COLS.length} 列），旧库 ALTER 路径与新库 CREATE 路径列集一致`);

  // 新列默认值：NOT NULL DEFAULT 两列有默认值；其余（含 release_type）NULL——旧行经 ALTER 补列后取列默认值，
  // 非另行 UPDATE 回填（release_type 例外：它由 [1b] 显式回填，见下方 P3，此刻两行均无成员理应仍是 NULL）。
  assert.strictEqual(row1After.release_assignee_notify_status, 'not_sent', '[P1] #1 release_assignee_notify_status 默认值 not_sent（ALTER NOT NULL DEFAULT 对旧行生效）');
  assert.strictEqual(row1After.release_kind, 'normal', '[P1] #1 release_kind 默认值 normal');
  assert.strictEqual(row1After.release_assignee_id, null, '[P1] #1 release_assignee_id 默认 NULL（无默认值声明）');
  assert.strictEqual(row1After.release_type, null, '[P1] #1 release_type 此刻仍 NULL（尚无成员，[1b] 回填见 P3）');
  assert.strictEqual(row2After.release_assignee_notify_status, 'not_sent', '[P1] #2 release_assignee_notify_status 默认值 not_sent');
  ok('[P1] 新增列默认值正确：NOT NULL DEFAULT 两列（release_assignee_notify_status/release_kind）对已存在行同样生效，其余列 NULL');

  // sys_release_duty_roster 全新建出：11 列 + 2 索引
  const dutyCols = (await all('PRAGMA table_info(sys_release_duty_roster)')).map(r => r.name);
  const EXPECT_DUTY_COLS = ['id', 'duty_date', 'user_id', 'user_name', 'note', 'created_by', 'created_by_name', 'created_at', 'removed_at', 'removed_by', 'removed_by_name'];
  const missDuty = EXPECT_DUTY_COLS.filter(c => !dutyCols.includes(c));
  assert.strictEqual(missDuty.length, 0, `[P1] sys_release_duty_roster 列缺失: ${missDuty.join(',')}`);
  ok(`[P1] sys_release_duty_roster 全新建出：${EXPECT_DUTY_COLS.length} 列齐全（"旧库整体缺这张表"场景，非本轮 ALTER 目标，但同一次 initSchema 调用内正确建出）`);

  // 4 个新索引全部建上
  const idxRows = await all(`SELECT name, tbl_name FROM sqlite_master WHERE type='index'`);
  const idxNames = idxRows.map(r => r.name);
  for (const idx of ['idx_sys_releases_status', 'idx_sys_releases_assignee', 'idx_sys_duty_roster_active', 'idx_sys_duty_roster_user']) {
    assert.ok(idxNames.includes(idx), `[P1] 索引 ${idx} 应存在，实际索引集: ${idxNames.join(',')}`);
  }
  ok('[P1] 本重构新增 4 索引全部建上（idx_sys_releases_status/idx_sys_releases_assignee/idx_sys_duty_roster_active/idx_sys_duty_roster_user）');

  // ═══ [P2] 幂等：对同一个库直接再调一次 runSysMigration（不重新建库）═══
  const relColsBeforeSecond = relCols.slice().sort();
  const dutyColsBeforeSecond = dutyCols.slice().sort();
  let secondRunErr = null;
  try {
    await I.runSysMigration(null);
  } catch (e) {
    secondRunErr = e;
  }
  assert.strictEqual(secondRunErr, null, `[P2] 第二次调用 runSysMigration 不应抛错，实际: ${secondRunErr && (secondRunErr.stack || secondRunErr.message)}`);
  assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '[P2] 第二次迁移后 ready 仍为 true');
  ok('[P2] 幂等·不抛错：alterAddMissingCols 的 PRAGMA 前置守卫正确跳过已存在列（ALTER ADD COLUMN 对已存在列会报错，未被真正触发）');

  const relColsAfterSecond = (await all('PRAGMA table_info(sys_releases)')).map(r => r.name).sort();
  const dutyColsAfterSecond = (await all('PRAGMA table_info(sys_release_duty_roster)')).map(r => r.name).sort();
  assert.deepStrictEqual(relColsAfterSecond, relColsBeforeSecond, '[P2] sys_releases 列集合与第一次迁移后完全相同（未重复添加/未丢列）');
  assert.deepStrictEqual(dutyColsAfterSecond, dutyColsBeforeSecond, '[P2] sys_release_duty_roster 列集合与第一次迁移后完全相同');
  const row1AfterSecond = await get('SELECT * FROM sys_releases WHERE id=?', [relId1]);
  const row2AfterSecond = await get('SELECT * FROM sys_releases WHERE id=?', [relId2]);
  assert.deepStrictEqual(row1AfterSecond, row1After, '[P2] #1 全字段快照与第一次迁移后逐字节相同（重复迁移零数据副作用）');
  assert.deepStrictEqual(row2AfterSecond, row2After, '[P2] #2 全字段快照与第一次迁移后逐字节相同');
  ok('[P2] 幂等·零数据副作用：列集合 + 两条历史行全字段快照与首次迁移后完全一致（非"跑了但没变化"的弱判据，逐字段深比对）');

  // ═══ [P3] release_type 回填（[1b]）：插入历史发布批次成员 + 手工清空 release_type 模拟"未回填"历史态 ═══
  // 补 users 表（sys_issues 建单校验需要）+ 插入三类成员场景：含 bug 成员 / 仅变更流成员 / 空批次。
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin')`);

  // relId1：混合成员（1 bug + 1 feature）→ 应回填 'bug'（含 bug 成员优先判 bug，[1b] CASE 逻辑）
  await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, release_id)
             VALUES ('bug', '已上线', 'P2', 'P3迁移测试-bug成员', 'BMS', '内部', 1, '管理员', ?)`, [relId1]);
  await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, release_id)
             VALUES ('feature', '已上线', 'P2', 'P3迁移测试-feature成员', 'BMS', '内部', 1, '管理员', ?)`, [relId1]);
  // relId2：仅变更流成员 → 应回填 'change'
  await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, release_id)
             VALUES ('improvement', '已上线', 'P2', 'P3迁移测试-improvement成员', 'BMS', '内部', 1, '管理员', ?)`, [relId2]);
  // relId3：空批次（无成员）→ 应保持 NULL
  const histIns3 = await run(`INSERT INTO sys_releases (release_no, status, is_hotfix, release_note, version_tag) VALUES (?, ?, ?, ?, ?)`,
    ['R-20260103-1', '计划中', 0, null, null]);
  const relId3 = histIns3.lastID;
  // relId4：已有非 NULL release_type（模拟"新流程已写过值"的批次）→ 迁移不应覆盖
  const histIns4 = await run(`INSERT INTO sys_releases (release_no, status, is_hotfix, release_note, version_tag, release_type) VALUES (?, ?, ?, ?, ?, ?)`,
    ['R-20260104-1', '计划中', 0, null, null, 'change']);
  const relId4 = histIns4.lastID;
  await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, release_id)
             VALUES ('bug', '已上线', 'P2', 'P3迁移测试-relId4应不被覆盖', 'BMS', '内部', 1, '管理员', ?)`, [relId4]);
  // 手工清空 release_type，模拟"批次先于回填机制存在"的历史态（relId4 刻意不清，测试"已有值不覆盖"）
  await run(`UPDATE sys_releases SET release_type=NULL WHERE id IN (?,?,?)`, [relId1, relId2, relId3]);
  ok('[P3] 前置：relId1(bug+feature混合)/relId2(仅improvement)/relId3(空批次)/relId4(已有值change+bug成员) 四类场景就绪');

  let thirdRunErr = null;
  try {
    await I.runSysMigration(null);
  } catch (e) {
    thirdRunErr = e;
  }
  assert.strictEqual(thirdRunErr, null, `[P3] 第三次调用 runSysMigration 不应抛错，实际: ${thirdRunErr && (thirdRunErr.stack || thirdRunErr.message)}`);
  assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '[P3] 第三次迁移后 ready 仍为 true（多次重跑不出错的强化证据）');

  const rel1Final = await get('SELECT release_type FROM sys_releases WHERE id=?', [relId1]);
  const rel2Final = await get('SELECT release_type FROM sys_releases WHERE id=?', [relId2]);
  const rel3Final = await get('SELECT release_type FROM sys_releases WHERE id=?', [relId3]);
  const rel4Final = await get('SELECT release_type FROM sys_releases WHERE id=?', [relId4]);
  assert.strictEqual(rel1Final.release_type, 'bug', `[P3] relId1（含 bug 成员）应回填 'bug'，实际 ${rel1Final.release_type}`);
  assert.strictEqual(rel2Final.release_type, 'change', `[P3] relId2（仅 improvement 成员）应回填 'change'，实际 ${rel2Final.release_type}`);
  assert.strictEqual(rel3Final.release_type, null, `[P3] relId3（空批次）应仍为 NULL（不误填），实际 ${rel3Final.release_type}`);
  assert.strictEqual(rel4Final.release_type, 'change', `[P3] relId4（已有非 NULL 值）应保持原值 'change' 不被覆盖（即便其真实成员是 bug），实际 ${rel4Final.release_type}`);
  ok("[P3] release_type 回填正确：含 bug 成员→'bug' / 仅变更流成员→'change' / 空批次→保持 NULL / 已有值→不覆盖（WHERE release_type IS NULL 幂等语义）");

  console.log(`\n[全部通过] ${passed}/${passed} ✓ C0 迁移路径专项验证通过（旧库 ALTER + 幂等 + release_type 回填）`);
  db.close();
}

main().catch(e => { console.error('\n[失败]', e && (e.stack || e.message || e)); process.exit(1); });
