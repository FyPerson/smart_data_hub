/**
 * v1.74.3 verify：纯只读领导账号不可被设为协作单数据导出人(exporter)
 *
 * 项目无单测框架 → 独立验证脚本（Node assert）。验证 3 件事：
 *   1. 前后端 READONLY_LEADER_IDS 常量字面量一致（同源，防只改一处）
 *   2. 拦截判定纯函数 isReadonlyLeader 对真实用户分类正确：
 *        领导（示例只读领导A id=11 / 示例只读领导B id=6）→ 拦截 true
 *        客服 viewer（示例客服A/示例客服B/示例客服C）→ 放行 false（仍可被直派）
 *        普通 user → 放行 false
 *   3. 三个写入口（create/forward/reassign）共用同一判定 → 模拟各入口对领导/客服的处理一致
 *
 * 即用即删（F1 探针模式）。纯 SELECT 零写操作。
 * 用法：node scripts/verify-readonly-leader-exporter-block.js [--real-db <业务库路径>]
 *   （[S4e-4] 第 2 项真实用户分类默认跳过，带 --real-db 时以只读方式打开指定库）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');

// [S4e-4] Part 2（真实用户分类）连真实库——改为 `--real-db <路径>`（或 `--real-db=<路径>`）显式开关：
//   · 不带开关 = 跳过 Part 2，打印 SKIP 说明，不计通过、不计失败；
//   · 带开关 = 路径必须是存在的文件（不存在即判失败），一律 OPEN_READONLY 打开（原为默认读写+创建）。
//   顶层不再打开任何库；库连接只在 Part 2 内按需建立。
let db = null;
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
// 开关解析（六个脚本写法一致）：值缺失 / 为空 / 以 - 开头 → 按缺少路径参数处理；以 --real 开头但不是 --real-db / --real-db=… 的参数 → unknown，判失败。
function parseRealDbSwitch() {
  const argv = process.argv.slice(2);
  let sw = { given: false, value: '', unknown: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--real-db' || a.startsWith('--real-db=')) {
      const v = a === '--real-db' ? argv[i + 1] : a.slice('--real-db='.length);
      sw = { given: true, value: (typeof v !== 'string' || v === '' || v.startsWith('-')) ? '' : v, unknown: sw.unknown };
    } else if (a.startsWith('--real')) {
      sw = { given: true, value: sw.value, unknown: sw.unknown || a };
    }
  }
  return sw;
}

// 拦截判定纯函数（复刻 server.js 三个入口共用的 READONLY_LEADER_IDS.includes(Number(id)) 逻辑）
const READONLY_LEADER_IDS = [6, 11];
function isReadonlyLeader(userId) {
  return READONLY_LEADER_IDS.includes(Number(userId));
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); fail++; }
}

(async () => {
  console.log('===== v1.74.3 纯只读领导 exporter 拦截 verify =====\n');

  // --- 1. 前后端常量同源 ---
  console.log('[1] 前后端 READONLY_LEADER_IDS 字面量一致');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'Data_Collab.html'), 'utf8');
  const grab = (src) => {
    const m = src.match(/READONLY_LEADER_IDS\s*=\s*\[([^\]]*)\]/);
    return m ? m[1].split(',').map(s => s.trim()).filter(Boolean).sort() : null;
  };
  const backIds = grab(serverSrc), frontIds = grab(htmlSrc);
  check('后端常量存在', () => assert(backIds, 'server.js 未找到 READONLY_LEADER_IDS'));
  check('前端常量存在', () => assert(frontIds, 'Data_Collab.html 未找到 READONLY_LEADER_IDS'));
  check('前后端字面量一致', () => assert.deepStrictEqual(backIds, frontIds, `后端[${backIds}] ≠ 前端[${frontIds}]`));
  check('与脚本常量一致', () => assert.deepStrictEqual(backIds, READONLY_LEADER_IDS.map(String).sort()));
  // codex 60 L-1：抽 isReadonlyLeaderId helper 后，三入口改为调 helper（单一真相点）
  check('后端 helper isReadonlyLeaderId 定义存在', () => assert(/function isReadonlyLeaderId\s*\(/.test(serverSrc), '未找到 helper 定义'));
  const callCount = (serverSrc.match(/isReadonlyLeaderId\s*\(/g) || []).length;
  // 1 次定义 + 3 个写入口调用 = 至少 4 次出现
  check('后端 3 入口均调 helper（含定义 ≥4 次出现）', () => assert(callCount >= 4, `仅 ${callCount} 处 isReadonlyLeaderId`));

  // --- 2. 真实用户分类 ---
  console.log('\n[2] 真实用户分类（连本地业务库，需 --real-db <路径> 显式开启）');
  const sw = parseRealDbSwitch();
  let part2Skipped = false;
  if (!sw.given) {
    part2Skipped = true;
    console.log('  [SKIP] Part 2 真实库只读探针默认跳过，需 `--real-db <路径>` 显式开启（不计通过、不计失败；请勿据此断言真实库已验收）');
  } else {
    const realDbPath = path.resolve(process.cwd(), sw.value);
    if (sw.unknown !== null || sw.value === '' || !fs.existsSync(realDbPath) || !fs.statSync(realDbPath).isFile()) {
      check('Part 2 --real-db 指定的路径存在且是文件', () => assert.fail(sw.unknown !== null ? `无法识别的开关 ${sw.unknown}（只接受 --real-db <路径> 或 --real-db=<路径>）` : sw.value === '' ? '缺少路径参数（用法：--real-db <业务库路径>）' : `路径不存在或不是文件：${realDbPath}（显式开启时不静默跳过）`));
    } else {
      db = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const leaders = await all(`SELECT id, display_name FROM users WHERE id IN (6, 11)`);
      const cs = await all(`SELECT id, display_name FROM users WHERE role='viewer' AND id NOT IN (6,11)`);
      const normals = await all(`SELECT id, display_name FROM users WHERE role='user' LIMIT 3`);

      leaders.forEach(u => check(`领导 ${u.display_name}(id=${u.id}) → 拦截`, () => assert.strictEqual(isReadonlyLeader(u.id), true)));
      cs.forEach(u => check(`客服viewer ${u.display_name}(id=${u.id}) → 放行`, () => assert.strictEqual(isReadonlyLeader(u.id), false)));
      normals.forEach(u => check(`普通user ${u.display_name}(id=${u.id}) → 放行`, () => assert.strictEqual(isReadonlyLeader(u.id), false)));
    }
  }

  // --- 3. 三入口判定一致性 + 边界 ---
  console.log('\n[3] 边界与一致性');
  check('字符串 id "11" 也被拦截（Number 归一）', () => assert.strictEqual(isReadonlyLeader('11'), true));
  check('字符串 id "6" 也被拦截', () => assert.strictEqual(isReadonlyLeader('6'), true));
  check('id=0 / null 不误拦', () => { assert.strictEqual(isReadonlyLeader(0), false); assert.strictEqual(isReadonlyLeader(null), false); });
  check('admin(id=3 示例用户A) 不在领导名单（admin 本就有权，名单只管纯只读领导）', () => assert.strictEqual(isReadonlyLeader(3), false));

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  if (part2Skipped) console.log('  ⚠️ 注意：[2] 真实用户分类本次未执行（默认跳过，需 `--real-db <路径>` 显式开启），以上 PASS 不含这半条覆盖。');
  if (db) db.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); if (db) db.close(); process.exit(1); });
