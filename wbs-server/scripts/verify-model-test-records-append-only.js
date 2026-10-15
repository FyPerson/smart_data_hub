// verify-model-test-records-append-only.js — 静态守卫：model_test_records 只追加、失效单向（#77 C1 对抗审 23-R4 R3）
//
// 固化的事实：线上代码对 model_test_records 的写语句只有两类——
//   ① INSERT（新增验收记录，含 config_rev 列由 verify-model-write-classification 另守）；
//   ② 恰为 `UPDATE model_test_records SET invalidated = 1 WHERE … (invalidated = 0 OR invalidated IS NULL)`（失效单向：0/NULL → 1）。
// 没有 DELETE、没有其他 UPDATE（不改 overall_result / detail_json / test_time / config_rev，也不把 invalidated 改回 0 / NULL），外键不级联。
// /api/confirm 归档条件写里「失效记录条数不变」「无更新记录」两个条件的正确性依赖这一点：记录只追加、失效单向，
// 所以「判定时的 (max id, 失效条数, config_rev)」不变 ⇒ 参与判定的记录集合与各条状态不变。
//
// 扫描面：git 可见集合（已跟踪 + 未跟踪未忽略）里 wbs-server/server.js、wbs-server/routes/**、wbs-server/utils/** 的 .js 文件
//   （排除 wbs-server/scripts/ 下的脚本含迁移脚本——它们是一次性工具 / 测试夹具，不在线上请求路径上）。git 取不到 → 判红，不回退磁盘全扫。
// 判定：用 acorn 解析，对每个字符串字面量 / 模板字面量（求值后的值，`${}` 以占位符代替）按 `;` 切成语句，规范化（去注释 / 引号 / 空白折叠 / 小写）后：
//   · 目标表是 model_test_records 的 INSERT（不是 INSERT OR REPLACE、不带 ON CONFLICT）→ 允许；
//   · 目标表是 model_test_records 的 UPDATE：只有 `SET invalidated = 1 WHERE … (invalidated = 0 OR invalidated IS NULL)` 一种形态允许；
//   · DELETE FROM / REPLACE INTO / INSERT OR REPLACE / 其他 UPDATE（含改 invalidated 为 0 / NULL、带别名、多列 SET）→ 判红；
//   · 语句以 WITH 开头且同时含 model_test_records 与写动词（update / delete / replace）→ 保守判红（SCAN_HOLE）。
// 不证明：只认字符串 / 模板字面量里的静态 SQL；跨字面量 + 拼接、动态表名看不到（本仓 SQL 均为静态）。
// 用法：node scripts/verify-model-test-records-append-only.js [--self-test]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const SCAN = [/^wbs-server\/server\.js$/, /^wbs-server\/routes\/.+\.js$/, /^wbs-server\/utils\/.+\.js$/];
// 迁移脚本排除只作用于 wbs-server/scripts/ 下；routes/、utils/ 下即使文件名含 migrat 也要扫描
const EXCLUDE = [/\/scripts\//, /^wbs-server\/scripts\/.*migrat/i];

function normalize(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/["`\[\]']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 对一条规范化语句分类：返回 null（不涉及写 model_test_records）或 { ok, why } */
function classifyStatement(stmt) {
  if (!stmt.includes('model_test_records')) return null;
  const T = 'model_test_records';
  if (new RegExp('^insert\\s+or\\s+\\w+\\s+into\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\b').test(stmt)) return { ok: false, why: 'INSERT OR <冲突策略>（REPLACE 会删除旧行）' };
  if (/^create\s+(?:temp\s+|temporary\s+)?trigger\b/.test(stmt)) return { ok: false, why: 'CREATE TRIGGER 涉及 model_test_records（触发器可绕过只追加）' };
  if (/^drop\s+table\b/.test(stmt)) return { ok: false, why: 'DROP TABLE 涉及 model_test_records' };
  // 启动迁移里有两条 `ALTER TABLE model_test_records ADD COLUMN`（invalidated / config_rev，server.js 约 :1404 / :1406）：只加列不改旧行、不删列，放行；
  //   其余 ALTER（RENAME TO / RENAME COLUMN / DROP COLUMN / 其他）一律判红
  if (/^alter\s+table\b/.test(stmt)) {
    return new RegExp('^alter\\s+table\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\s+add\\s+(?:column\\s+)?\\w+\\b').test(stmt)
      ? { ok: true, why: 'ALTER ADD COLUMN（只加列）' }
      : { ok: false, why: 'ALTER TABLE 涉及 model_test_records（非 ADD COLUMN）' };
  }
  const ins = new RegExp('^insert\\s+into\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\b\\s*(.*)$').exec(stmt);
  if (ins) {
    if (/\bon conflict\b/.test(stmt)) return { ok: false, why: 'INSERT … ON CONFLICT（upsert 会改旧行）' };
    const cl = /^\(([^)]*)\)/.exec(ins[1]);
    if (!cl) return { ok: false, why: 'INSERT 无列清单（无法确认未显式指定 id）' };
    if (cl[1].split(',').some(c => ['rowid', '_rowid_', 'oid'].includes(c.trim()))) return { ok: false, why: 'INSERT 列清单含 rowid / _rowid_ / oid（rowid 别名即 id，可显式指定）' };
    if (cl[1].split(',').some(c => c.trim() === 'id')) return { ok: false, why: 'INSERT 列清单含 id 列（显式 id 可插入空洞 id，绕过「id > 最大值」条件）' };
    return { ok: true, why: 'INSERT' };
  }
  if (new RegExp('^replace\\s+into\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\b').test(stmt)) return { ok: false, why: 'REPLACE INTO（删除旧行）' };
  if (new RegExp('^delete\\s+from\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\b').test(stmt)) return { ok: false, why: 'DELETE FROM' };
  if (new RegExp('^update\\s+(?:or\\s+\\w+\\s+)?(?:\\w+\\s*\\.\\s*)?' + T + '\\b').test(stmt)) {
    const okForm = new RegExp('^update\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\s+set\\s+invalidated\\s*=\\s*1\\s+where\\s+.*\\(\\s*invalidated\\s*=\\s*0\\s+or\\s+invalidated\\s+is\\s+null\\s*\\)').test(stmt);
    return okForm ? { ok: true, why: 'UPDATE invalidated 0/NULL → 1（失效单向）' } : { ok: false, why: '非「SET invalidated = 1 WHERE … (invalidated = 0 OR invalidated IS NULL)」形态的 UPDATE' };
  }
  if (/^with\b/.test(stmt) && new RegExp('\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+(?:\\w+\\s*\\.\\s*)?' + T + '\\b').test(stmt)) return { ok: false, why: 'WITH 前缀的 INSERT INTO model_test_records（绕过 INSERT 形态检查，保守判红）' };
  if (/^with\b/.test(stmt) && /\b(update|delete|replace)\b/.test(stmt)) return { ok: false, why: 'WITH 前缀语句同时含写动词（SCAN_HOLE，保守判红）' };
  return null;   // SELECT / 以其他表为目标的写语句里引用了该表（子查询）：不是对它的写
}

function literalsOf(src, file) {
  let ast;
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(src, { ...opts, sourceType: 'script' }); } catch (e1) {
    try { ast = acorn.parse(src, { ...opts, sourceType: 'module' }); } catch (e2) { throw new Error(`${file} 无法被 acorn 解析：${e2.message}`); }
  }
  const out = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Literal' && typeof n.value === 'string') out.push({ text: n.value, pos: n.start });
    else if (n.type === 'TemplateLiteral') out.push({ text: n.quasis.map(q => q.value.cooked == null ? q.value.raw : q.value.cooked).join('${}'), pos: n.start });
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);
  return out;
}

/** 扫描一份源码，返回 { writes: [{pos, kind, why}], violations: [{file, line, why, stmt}] } */
function scanSource(src, file) {
  const writes = [], violations = [];
  for (const lit of literalsOf(src, file)) {
    if (!lit.text.toLowerCase().includes('model_test_records')) continue;
    for (const raw of lit.text.split(';')) {
      const stmt = normalize(raw);
      if (!stmt) continue;
      const c = classifyStatement(stmt);
      if (!c) continue;
      const line = src.slice(0, lit.pos).split('\n').length;
      writes.push({ file, line, ok: c.ok, why: c.why });
      if (!c.ok) violations.push({ file, line, why: c.why, stmt: stmt.slice(0, 160) });
    }
  }
  return { writes, violations };
}

function visibleFiles() {
  const r = spawnSync('git', ['-C', REPO, 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', 'wbs-server'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`git ls-files 失败：${r.error ? r.error.message : r.stderr}`);
  return r.stdout.split('\0').filter(Boolean).filter(rel => SCAN.some(re => re.test(rel)) && !EXCLUDE.some(re => re.test(rel)));
}

function main() {
  const files = visibleFiles();
  const problems = [];
  if (!files.includes('wbs-server/server.js')) problems.push('扫描面不含 wbs-server/server.js（git 可见集合异常）');
  const all = [];
  for (const rel of files) {
    let res;
    try { res = scanSource(fs.readFileSync(path.join(REPO, rel), 'utf8'), rel); } catch (e) { problems.push(e.message); continue; }
    all.push(...res.writes);
    for (const v of res.violations) problems.push(`${v.file}:${v.line} ${v.why}：${v.stmt}`);
  }
  const ins = all.filter(w => w.why === 'INSERT').length, upd = all.filter(w => w.ok && w.why.startsWith('UPDATE')).length;
  if (ins === 0) problems.push('扫描面里一条 INSERT INTO model_test_records 都没找到（扫描器失效或语句被改写）');
  if (upd === 0) problems.push('扫描面里没有找到失效 UPDATE（invalidated = 1）——与线上事实不符，扫描器失效或语句被改写');
  console.log(`verify-model-test-records-append-only 扫描 ${files.length} 个文件，model_test_records 写语句 ${all.length} 条（INSERT ${ins}、失效 UPDATE ${upd}）`);
  if (problems.length) { for (const p of problems) console.log('RED ' + p); console.log(`verify-model-test-records-append-only FAIL=${problems.length}`); process.exit(1); }
  console.log('verify-model-test-records-append-only PASS');
}

function selfTest() {
  let bad = 0;
  const expect = (name, src, wantRed) => {
    const v = scanSource(src, 'synthetic.js').violations;
    const ok = wantRed ? v.length > 0 : v.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test ${name}：${wantRed ? '须判红' : '须不红'}，实际 ${v.length ? '红 ×' + v.length : '不红'}`);
    if (!ok) bad++;
  };
  const OK_INS = "db.run(`INSERT INTO model_test_records (model_id, config_rev) VALUES (?, ?)`, []);";
  const OK_UPD = 'db.run("UPDATE model_test_records SET invalidated = 1 WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL)", [1]);';
  expect('对照组（INSERT + 失效 UPDATE）', OK_INS + '\n' + OK_UPD, false);
  expect('对照组（只读 SELECT 与以其他表为目标的写）', 'db.get("SELECT * FROM model_test_records WHERE id = 1"); db.run("UPDATE data_models SET status = 1 WHERE id IN (SELECT model_id FROM model_test_records)");', false);
  expect('注入 DELETE', OK_UPD + '\ndb.run("DELETE FROM model_test_records WHERE model_id = ?", [1]);', true);
  expect('注入改 overall_result', OK_UPD + '\ndb.run("UPDATE model_test_records SET overall_result = \'pass\' WHERE id = ?", [1]);', true);
  expect('注入 invalidated = 0', OK_UPD + '\ndb.run("UPDATE model_test_records SET invalidated = 0 WHERE model_id = ?", [1]);', true);
  expect('注入 INVALIDATED = NULL（大小写 / 引号）', 'db.run(`update "model_test_records" set "invalidated" = NULL where model_id = ?`, [1]);', true);
  expect('注入 INSERT OR REPLACE', 'db.run("INSERT OR REPLACE INTO model_test_records (id, model_id) VALUES (1, 2)", []);', true);
  expect('注入 REPLACE INTO', 'db.run("REPLACE INTO model_test_records (id, model_id) VALUES (1, 2)", []);', true);
  expect('注入失效 UPDATE 缺 WHERE 单向条件', 'db.run("UPDATE model_test_records SET invalidated = 1 WHERE model_id = ?", [1]);', true);
  expect('注入失效 UPDATE 多列 SET', 'db.run("UPDATE model_test_records SET invalidated = 1, overall_result = \'fail\' WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL)", [1]);', true);
  expect('注入 WITH 前缀写', 'db.run("WITH x AS (SELECT 1) DELETE FROM model_test_records", []);', true);
  expect('注入大写 DELETE FROM MODEL_TEST_RECORDS', 'db.run("DELETE FROM MODEL_TEST_RECORDS WHERE model_id = ?", [1]);', true);
  expect('注入混合大小写 UPDATE Model_Test_Records SET overall_result', 'db.run("UPDATE Model_Test_Records SET overall_result = \'pass\' WHERE id = ?", [1]);', true);
  expect('注入 CREATE TRIGGER', 'db.run("CREATE TRIGGER trg AFTER INSERT ON model_test_records BEGIN SELECT 1; END", []);', true);
  expect('注入 DROP TABLE', 'db.run("DROP TABLE IF EXISTS model_test_records", []);', true);
  expect('注入 ALTER TABLE RENAME / DROP COLUMN', 'db.run("ALTER TABLE model_test_records RENAME TO x", []); db.run("ALTER TABLE model_test_records DROP COLUMN invalidated", []);', true);
  expect('对照组（启动迁移 ALTER TABLE ADD COLUMN 放行）', 'db.run("ALTER TABLE model_test_records ADD COLUMN config_rev INTEGER", []);', false);
  expect('注入 INSERT 列清单含 id', 'db.run("INSERT INTO model_test_records (id, model_id) VALUES (?, ?)", []);', true);
  expect('注入 WITH 前缀 INSERT（大小写混写）', 'db.run("With x AS (SELECT 1 AS m) INSERT INTO Model_Test_Records (model_id) SELECT m FROM x", []);', true);
  expect('注入 INSERT 列清单含 rowid（负 rowid 写法）', 'db.run("INSERT INTO model_test_records (ROWID, model_id) VALUES (-5, ?)", []);', true);
  expect('注入 INSERT 列清单含 _rowid_ / oid', 'db.run("INSERT INTO model_test_records (model_id, _rowid_) VALUES (?, 3)", []); db.run("INSERT INTO model_test_records (OID, model_id) VALUES (3, ?)", []);', true);
  expect('注入 INSERT 无列清单', 'db.run("INSERT INTO model_test_records VALUES (?, ?)", []);', true);
  expect('对照组（INSERT 列名含 id 子串但不是 id 列）', 'db.run("INSERT INTO model_test_records (model_id, test_user_id) VALUES (?, ?)", []);', false);
  const sp = (rel) => SCAN.some(re => re.test(rel)) && !EXCLUDE.some(re => re.test(rel));
  const expectPath = (name, rel, wantScan) => {
    const ok = sp(rel) === wantScan;
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test ${name}：${rel} 须${wantScan ? '扫描' : '排除'}`);
    if (!ok) bad++;
  };
  expectPath('routes 下含 migrat 的文件仍扫描', 'wbs-server/routes/migrate-helper.js', true);
  expectPath('utils 下含 migrat 的文件仍扫描', 'wbs-server/utils/migration.js', true);
  expectPath('scripts 下迁移脚本排除', 'wbs-server/scripts/migrate-x.js', false);
  console.log(`verify-model-test-records-append-only --self-test ${bad === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest(); else main();
