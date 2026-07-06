// 验证脚本：周期取数推送模块 占位符校验（集成点1 ②，方案 §3.4）
//   用法：node scripts/verify-periodic-placeholder.js
//
// require routes/periodic-fetch/index.js 真实 _internals.validateTemplatePlaceholders /
//   checkNoResidualPlaceholders，禁止复刻逻辑到测试里（RC-L2）。
//
// 断言覆盖：
//   ① 保存时校验：至少 1 个受支持占位符 / 不含未知占位符 / 单引号包裹强制 / 大小写严格区分
//   ② 运行前校验：替换后无残留 {{...}} 放行，残留拒
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

// 集成点2 起 REQUIRED_DEPS 扩了 5 项，本脚本只测占位符校验纯函数，给最简 mock 保证工厂能构造成功。
const mod = require('../routes/periodic-fetch')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  getMssqlPool: async () => ({ request: () => { throw new Error('mock：placeholder verify 不应触发'); } }),
  getMysqlPool: async () => ({ query: async () => { throw new Error('mock：placeholder verify 不应触发'); } }),
  readSystemConfig: async () => null,
  maskPhone: () => '[mock]',
  decryptPassword: (x) => x,
});
const { validateTemplatePlaceholders, checkNoResidualPlaceholders } = mod._internals;

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

function main() {
  // ── [1] 至少含一个受支持占位符 ──
  let r = validateTemplatePlaceholders(`SELECT * FROM t WHERE 1=1`);
  assert.strictEqual(r.ok, false, '无占位符应拒');
  assert.strictEqual(r.code, 'NO_PLACEHOLDER_FOUND');
  ok('无任何占位符 → 拒（NO_PLACEHOLDER_FOUND，方案 §3.4「至少含一个受支持占位符」）');

  r = validateTemplatePlaceholders('');
  assert.strictEqual(r.ok, false, '空模板应拒');
  assert.strictEqual(r.code, 'TEMPLATE_EMPTY');
  ok('空模板 → 拒（TEMPLATE_EMPTY）');

  // ── [2] 合法：单占位符（只用一个边界，方案 §3.4「不强制成对」）──
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START}}'`);
  assert.strictEqual(r.ok, true, '只用 MONTH_START 应合法: ' + JSON.stringify(r));
  assert.deepStrictEqual(r.placeholders, ['MONTH_START']);
  ok('只含 {{MONTH_START}} 一个边界占位符 → 合法（方案 §3.4：不强制成对）');

  // ── [3] 合法：#21 双段 UNION 示例（两处日期条件，方案 §3.3）──
  const script21 = `
    SELECT a FROM t1 WHERE ISNULL(bp.PayTime,cl.PayPeriod) >= '{{MONTH_START}}' AND ISNULL(bp.PayTime,cl.PayPeriod) < '{{MONTH_END}}'
    UNION ALL
    SELECT a FROM t2 WHERE ISNULL(bp.PayTime,cl.PayPeriod) >= '{{MONTH_START}}' AND ISNULL(bp.PayTime,cl.PayPeriod) < '{{MONTH_END}}'
  `;
  r = validateTemplatePlaceholders(script21);
  assert.strictEqual(r.ok, true, '#21 双段 UNION 模板应合法: ' + JSON.stringify(r));
  assert.deepStrictEqual(r.placeholders.sort(), ['MONTH_END', 'MONTH_START']);
  ok('#21 真实模板（双段 UNION ALL，各含 MONTH_START/MONTH_END）→ 合法（方案 §3.3 示例）');

  // ── [4] 未知占位符拒 ──
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START}}' AND x = '{{QUARTER_START}}'`);
  assert.strictEqual(r.ok, false, '未知占位符应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  assert.ok(/QUARTER_START/.test(r.reason), 'reason 应指出未知占位符名');
  ok('含未知占位符 {{QUARTER_START}} → 拒（UNKNOWN_PLACEHOLDER，方案 §3.4「不含未知占位符」）');

  // ── [5] 大小写严格区分（小写变体视为未知，不做静默归一）──
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{month_start}}'`);
  assert.strictEqual(r.ok, false, '小写 month_start 应视为未知占位符拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('小写变体 {{month_start}} → 拒（严格大小写区分，不静默归一大写）');

  // ── [5b] ⭐ M-2（集成审）：畸形占位符变体保存期闭合（旧正则抓不到含连字符/空格的片段，与合法共存时蒙混过关）──
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d < '{{MONTH-END}}'`);
  assert.strictEqual(r.ok, false, '连字符畸形 {{MONTH-END}} 应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 畸形变体 {{MONTH-END}}（连字符）→ 保存期拒 UNKNOWN_PLACEHOLDER（M-2，旧正则会漏）');

  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d < '{{ MONTH_END }}'`);
  assert.strictEqual(r.ok, false, '内嵌空格 {{ MONTH_END }} 应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 畸形变体 {{ MONTH_END }}（内嵌空格）→ 保存期拒 UNKNOWN_PLACEHOLDER（M-2）');

  // 合法 + 畸形共存：仍须报 UNKNOWN（畸形检查先于「至少一个」，防蒙混过关）
  r = validateTemplatePlaceholders(`SELECT a FROM t WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH-END}}'`);
  assert.strictEqual(r.ok, false, '合法+畸形共存应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  assert.ok(/MONTH-END/.test(r.reason), 'reason 应指出畸形片段');
  ok('⭐ 合法 {{MONTH_START}} + 畸形 {{MONTH-END}} 共存 → 保存期拒 UNKNOWN_PLACEHOLDER（M-2，不因含合法占位符而放行）');

  // ── [5c] ⭐ M-2b（集成审复审收口）：结构畸形括号残留检查（宽扫正则只命中"非空且闭合 }}"，漏空体/不闭合/多余括号）──
  //   宽扫 /\{\{[^}]+\}\}/g 抓不到：空体 {{}} / 不闭合 {{MONTH_START / 多余右括号 {{MONTH_START}}}} → 残留花括号检查兜底。
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE x = '{{}}'`);
  assert.strictEqual(r.ok, false, '空体 {{}} 应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 空体 {{}} → 拒 UNKNOWN_PLACEHOLDER（M-2b，残留花括号检查，不落 NO_PLACEHOLDER_FOUND）');

  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START`);
  assert.strictEqual(r.ok, false, '不闭合 {{MONTH_START 应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 不闭合 {{MONTH_START（缺 }}）→ 拒 UNKNOWN_PLACEHOLDER（M-2b，残留 {{ 被识别）');

  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START}}}}'`);
  assert.strictEqual(r.ok, false, '多余右括号 {{MONTH_START}}}} 应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 多余右括号 {{MONTH_START}}}}（消费合法 token 后残留 }}）→ 拒 UNKNOWN_PLACEHOLDER（M-2b）');

  // 合法 + 空体 {{}} 共存：合法 token 消费后残留 {{}} → 仍拒（防含合法占位符即放行）
  r = validateTemplatePlaceholders(`SELECT a FROM t WHERE d >= '{{MONTH_START}}' AND x = '{{}}'`);
  assert.strictEqual(r.ok, false, '合法 + 空体 {{}} 共存应拒');
  assert.strictEqual(r.code, 'UNKNOWN_PLACEHOLDER');
  ok('⭐ 合法 {{MONTH_START}} + 空体 {{}} 共存 → 拒 UNKNOWN_PLACEHOLDER（M-2b，消费合法 token 后残留 {{}}）');

  // 回归：纯合法模板（消费合法 token 后无残留花括号）不得被残留检查误伤
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START}}'`);
  assert.strictEqual(r.ok, true, '纯合法单占位符不得被 M-2b 误伤: ' + JSON.stringify(r));
  r = validateTemplatePlaceholders(`SELECT a FROM t WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'`);
  assert.strictEqual(r.ok, true, '纯合法双占位符不得被 M-2b 误伤: ' + JSON.stringify(r));
  ok('⭐ 回归：纯合法模板（单/双占位符，消费后无残留花括号）→ 仍放行（M-2b 残留检查不误伤）');

  // ── [6] 单引号包裹强制（裸占位符拒，SQL Server 日期字面量需要引号）──
  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= {{MONTH_START}}`);
  assert.strictEqual(r.ok, false, '裸占位符（未加引号）应拒');
  assert.strictEqual(r.code, 'PLACEHOLDER_NOT_QUOTED');
  ok('裸占位符 {{MONTH_START}}（未用单引号包裹）→ 拒（PLACEHOLDER_NOT_QUOTED）');

  r = validateTemplatePlaceholders(`SELECT * FROM t WHERE d >= '{{MONTH_START}}`);   // 前引号有，后引号缺
  assert.strictEqual(r.ok, false, '单侧引号（缺右引号）应拒');
  assert.strictEqual(r.code, 'PLACEHOLDER_NOT_QUOTED');
  ok('单侧引号缺失（仅前引号无后引号）→ 拒（PLACEHOLDER_NOT_QUOTED，两侧都须校验）');

  // ── [7] 运行前校验：替换后无残留放行 ──
  const rendered = script21.replace(/\{\{MONTH_START\}\}/g, '2026-06-01').replace(/\{\{MONTH_END\}\}/g, '2026-07-01');
  r = checkNoResidualPlaceholders(rendered);
  assert.strictEqual(r.ok, true, '完全替换后应无残留放行: ' + JSON.stringify(r));
  ok('运行前校验：占位符全部替换后 → 放行（无残留）');

  // ── [8] 运行前校验：替换后残留拒（模拟只替换了一半，如实现 bug 漏替换 MONTH_END）──
  const partialRendered = script21.replace(/\{\{MONTH_START\}\}/g, '2026-06-01');   // MONTH_END 未替换
  r = checkNoResidualPlaceholders(partialRendered);
  assert.strictEqual(r.ok, false, '残留占位符应拒: ' + JSON.stringify(r));
  assert.strictEqual(r.code, 'PLACEHOLDER_RESIDUAL');
  ok('运行前校验：替换后仍残留 {{MONTH_END}} → 拒（PLACEHOLDER_RESIDUAL，方案 §3.4「运行前校验」）');

  // ── [9] 运行前校验：未知残留占位符文本（非法输入形态）也应被识别为残留 ──
  r = checkNoResidualPlaceholders(`SELECT * WHERE x = '{{ANYTHING}}'`);
  assert.strictEqual(r.ok, false, '任意 {{...}} 残留都应拒（不限定已知占位符名）');
  ok('运行前校验对任意 {{...}} 形态残留（不限于已知占位符名）都拒（兜底彻底）');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 周期取数推送占位符校验验证通过`);
  console.log('  覆盖：保存时（≥1占位符/未知占位符拒/大小写严格/畸形括号拒[连字符·空格·空体·不闭合·多余括号]/单引号包裹强制）+ 运行前（残留拒/完全替换放行/兜底任意 {{...}}）');
}

try {
  main();
} catch (e) {
  console.error('\n[失败]', e.message, e.stack);
  process.exit(1);
}
