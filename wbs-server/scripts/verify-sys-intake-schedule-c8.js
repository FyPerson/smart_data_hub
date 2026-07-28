// 验证脚本：系统迭代 受理排期改造 C8 — 前端徽章/筛选/引导 INTAKE 态显隐完整性
//   用法：node scripts/verify-sys-intake-schedule-c8.js
//
// 静态一致性检查（纯展示层·防「新状态漏归组→筛选里消失」/「无徽章样式」/「引导缺失」）：
//   [B] 徽章：META 所有状态都有 SI_STATUS_CLASS 映射 + 对应 .si-s-<class> CSS（待受理=intake/待修改=revision 有专属色）
//   [G] 分组：META 所有状态都归入某个 SI_STATUS_GROUPS 组（否则组筛选点开后该单消失·镜像 siRenderStats 守卫）；待受理/待修改/待指派 ∈ active
//   [H] 引导：待受理/待修改 受理阶段角色引导文案存在（siRenderActions gate）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const noop = () => {};

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
  ...require('./_sys-attach-test-deps'),
});
const T = mod._internals.transitions;

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');

// 从 HTML 抽取 const 对象（含注释·eval 容忍）——非贪婪到第一个顶层 }（这两个 map 无嵌套对象）。
function evalConstObj(name) {
  const m = html.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\n    \\});'));
  assert.ok(m, name + ' 定义可抽取');
  // eslint-disable-next-line no-eval
  return eval('(' + m[1] + ')');
}

function main() {
  const meta = T.buildMeta();
  // META 全类型状态并集（== 后端 ALLOWED_STATUSES）
  const allStatuses = new Set();
  Object.values(meta.statusLabels).forEach(arr => arr.forEach(s => allStatuses.add(s)));

  const SI_STATUS_CLASS = evalConstObj('SI_STATUS_CLASS');
  const SI_STATUS_GROUPS = evalConstObj('SI_STATUS_GROUPS');

  // ═══ [B] 徽章：每状态有 class + CSS ═══
  {
    const missingClass = [...allStatuses].filter(s => !SI_STATUS_CLASS[s]);
    assert.strictEqual(missingClass.length, 0, `以下状态无 SI_STATUS_CLASS 映射（徽章无色·siStatusClass 兜底 pending 但语义丢失）：${missingClass.join(', ')}`);
    // 每个用到的 class 有 .si-s-<class> CSS
    const usedClasses = new Set([...allStatuses].map(s => SI_STATUS_CLASS[s]));
    const missingCss = [...usedClasses].filter(c => !new RegExp('\\.si-s-' + c + '\\s*\\{').test(html));
    assert.strictEqual(missingCss.length, 0, `以下徽章 class 无 CSS 定义：${[...missingCss].join(', ')}`);
    // 受理排期新态专属色（非兜底 pending）
    assert.strictEqual(SI_STATUS_CLASS['待受理'], 'intake', '待受理=intake 专属徽章');
    assert.strictEqual(SI_STATUS_CLASS['待修改'], 'revision', '待修改=revision 专属徽章');
    assert.ok(/\.si-s-intake\s*\{/.test(html) && /\.si-s-revision\s*\{/.test(html), 'intake/revision 徽章 CSS 有专属色');
    ok(`[B] 徽章完整：${allStatuses.size} 个状态全有 SI_STATUS_CLASS 映射 + .si-s-* CSS（待受理=intake/待修改=revision 专属色）`);
  }

  // ═══ [G] 分组：每状态归入某组（防组筛选消失）═══
  {
    const groupedStatuses = new Set();
    Object.values(SI_STATUS_GROUPS).forEach(arr => arr.forEach(s => groupedStatuses.add(s)));
    // 已作废 = 终态·走独立「含已作废」勾选筛选（siVoidedWrap）·不进常规组·siRenderStats 有 warn 兜底——既有设计·排除。
    const GROUP_EXEMPT = new Set(['已作废']);
    const ungrouped = [...allStatuses].filter(s => !groupedStatuses.has(s) && !GROUP_EXEMPT.has(s));
    assert.strictEqual(ungrouped.length, 0, `以下状态未归入任何 SI_STATUS_GROUPS 组（组筛选点开后该单消失·发布门禁核心）：${ungrouped.join(', ')}`);
    // 受理排期新态归 active（受理门+待派均"进行中"前段）
    for (const s of ['待受理', '待修改', '待指派']) {
      assert.ok(SI_STATUS_GROUPS.active.includes(s), `${s} ∈ active 组`);
    }
    ok(`[G] 分组完整：${allStatuses.size} 个状态全归入某组（0 孤儿·组筛选无消失）+ 待受理/待修改/待指派 ∈ active`);
  }

  // ═══ [S] 排序序完整（角色权限重构 C2.5 补·本组此前缺失）═══
  //   ⚠️ 缺口来源：C2.5 加「待商议」时，[B] 徽章与 [G] 分组两组守卫都红灯提示了，**唯独排序表没人看着**——
  //     漏登记不报错，只会让新态按未知兜底值 99 排到「已作废」之后（最早的态排在最末，与本表语义矛盾）。
  //     同类踩法 2026-07-10 已发生过一次（codex API 审 MED-2：已暂缓/已拒绝 漏显式序）。故补成常设守卫。
  //   ⭐ v2.1（C2.5 撤销）：「待商议」随预沟通段整体撤销，原"必须早于待受理"这条专项排序断言随之删除
  //   （allStatuses 现由 T.buildMeta() 动态派生，已不含「待商议」，下方的 missingOrder 完整性检查自动适配）。
  {
    const SI_STATUS_SORT_ORDER = evalConstObj('SI_STATUS_SORT_ORDER');
    const missingOrder = [...allStatuses].filter(s => typeof SI_STATUS_SORT_ORDER[s] !== 'number');
    assert.strictEqual(missingOrder.length, 0,
      `以下状态无 SI_STATUS_SORT_ORDER 显式序（共享排序按未知兜底 99 → 排到「已作废」之后）：${missingOrder.join(', ')}`);
    // 已作废必须是最大值（本表注释自称"已作废排末尾"，这条把注释变成断言）
    const voidOrder = SI_STATUS_SORT_ORDER['已作废'];
    const maxOther = Math.max(...[...allStatuses].filter(s => s !== '已作废').map(s => SI_STATUS_SORT_ORDER[s]));
    assert.ok(voidOrder > maxOther, `「已作废」应排末尾（实际 ${voidOrder}，其余最大 ${maxOther}）`);
    ok(`[S] 排序序完整：${allStatuses.size} 个状态全有显式序（0 落兜底 99）+ 已作废排末尾`);
  }

  // ═══ [H] 受理阶段引导文案（siRenderActions gate）═══
  {
    assert.ok(/iss\.status === '待受理'/.test(html) && /待受理.*受理确认|本单待受理/.test(html), '待受理 受理阶段引导文案存在');
    assert.ok(/iss\.status === '待修改'/.test(html) && /退回修改|重新提交受理/.test(html), '待修改 退改引导文案存在');
    ok('[H] 受理阶段角色引导：待受理（受理人可受理/退改/技术沟通·他人等待受理）+ 待修改（建单人改后重提·他人等待）文案存在');
  }

  // 筛选下拉自动并集（siBuildStatusOptions 从 META.statusLabels 建·待受理/待修改随 ALLOWED_STATUSES 自动出现·无需硬编码）
  assert.ok(/META\.statusLabels/.test(html) && /siBuildStatusOptions/.test(html), '筛选下拉从 META.statusLabels 自动构建（新态自动出现）');
  ok('[F] 状态筛选下拉从 META.statusLabels 自动并集（待受理/待修改随后端 ALLOWED_STATUSES 自动出现·无硬编码漂移）');

  console.log(`\n✅ verify-sys-intake-schedule-c8 全部通过（${passed} 组）`);
  db.close();
}

main();
