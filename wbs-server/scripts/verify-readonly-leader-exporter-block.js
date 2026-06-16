/**
 * v1.74.3 verify：纯只读领导账号不可被设为协作单数据导出人(exporter)
 *
 * 项目无单测框架 → 独立验证脚本（Node assert）。验证 3 件事：
 *   1. 前后端 READONLY_LEADER_IDS 常量字面量一致（同源，防只改一处）
 *   2. 拦截判定纯函数 isReadonlyLeader 对真实用户分类正确：
 *        领导（示例只读领导A id=11 / 示例只读领导B id=6）→ 拦截 true
 *        客服 viewer（沈倩静/甄妮/方丽倩）→ 放行 false（仍可被直派）
 *        普通 user → 放行 false
 *   3. 三个写入口（create/forward/reassign）共用同一判定 → 模拟各入口对领导/客服的处理一致
 *
 * 即用即删（F1 探针模式）。纯 SELECT 零写操作。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const db = new sqlite3.Database(path.join(ROOT, 'task_pool.db'));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

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
  console.log('\n[2] 真实用户分类（连本地 task_pool.db）');
  const leaders = await all(`SELECT id, display_name FROM users WHERE id IN (6, 11)`);
  const cs = await all(`SELECT id, display_name FROM users WHERE role='viewer' AND id NOT IN (6,11)`);
  const normals = await all(`SELECT id, display_name FROM users WHERE role='user' LIMIT 3`);

  leaders.forEach(u => check(`领导 ${u.display_name}(id=${u.id}) → 拦截`, () => assert.strictEqual(isReadonlyLeader(u.id), true)));
  cs.forEach(u => check(`客服viewer ${u.display_name}(id=${u.id}) → 放行`, () => assert.strictEqual(isReadonlyLeader(u.id), false)));
  normals.forEach(u => check(`普通user ${u.display_name}(id=${u.id}) → 放行`, () => assert.strictEqual(isReadonlyLeader(u.id), false)));

  // --- 3. 三入口判定一致性 + 边界 ---
  console.log('\n[3] 边界与一致性');
  check('字符串 id "11" 也被拦截（Number 归一）', () => assert.strictEqual(isReadonlyLeader('11'), true));
  check('字符串 id "6" 也被拦截', () => assert.strictEqual(isReadonlyLeader('6'), true));
  check('id=0 / null 不误拦', () => { assert.strictEqual(isReadonlyLeader(0), false); assert.strictEqual(isReadonlyLeader(null), false); });
  check('admin(id=3 示例用户A) 不在领导名单（admin 本就有权，名单只管纯只读领导）', () => assert.strictEqual(isReadonlyLeader(3), false));

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  db.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); db.close(); process.exit(1); });
