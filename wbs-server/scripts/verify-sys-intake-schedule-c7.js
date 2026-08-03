// 验证脚本：系统迭代 受理排期改造 C7 — 前端受理区 meta 动作↔handler 双向完整性 + 白名单三处一致
//   用法：node scripts/verify-sys-intake-schedule-c7.js
//
// 这是**发布门禁核心的静态一致性检查**（方案要求「C7 后补一轮 meta 动作→前端 handler/端点双向完整性验证」·防死按钮/漏端点）：
//   [D] 双向完整性：META.typeFlows 所有可渲染 action（siRenderActions 会出按钮的）都有 siDoAction case（无死按钮）；反向 siDoAction case 无孤儿
//   [W] 白名单三处一致：SI_INTAKE_LIAISON_IDS[13]/SI_TECH_LEAD_IDS[7] 前端字面量 == 后端 _internals（防漂移）
//   [F] C7 新增前端函数/端点齐备：4 弹窗 + 技术负责人通知行 + resend + 受理排期端点路径都在 HTML
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
const I = mod._internals;
const T = I.transitions;

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');

// siDoAction switch 里的 case 列表（含受理排期新增）——从 siDoAction 函数体截取，避免误抓其他 switch。
//   ⚠️ S4（bug暂缓方案 20260803 v0.4）踩坑记录：窗口原为 4000 字符，resume case 的行为说明注释（codex 238
//   risk-1 取舍记录）把函数体真实长度推到 ~4333 字符，超出窗口后 `end` 搜不到真实结尾（indexOf 返 -1），
//   `body` 退化为"整段 4000 字符原样"——'derive' 等位于窗口之外的合法 case 因此被静默漏扫，误报"无
//   siDoAction case（死按钮）"（实际 case 完好，纯粹是扫描器窗口不够长）。教训：固定字符窗口这类"应该
//   够用"的魔数会随函数体注释自然增长而失效，且失败姿态是**静默截断**而非报错，很容易被误判成真实
//   实现缺陷去排查生产代码。修法两层：① 窗口放宽到 20000（当前真实长度的 4倍+ 余量）② 找不到真实结尾
//   时不再静默回退到"整段截断"，改为显式断言失败，把"窗口需要再调大"变成一条指向本行注释的清晰报错，
//   而不是下游一个看似无关的 action 名字的误导性断言。
function extractDoActionCases(src) {
  const start = src.indexOf('function siDoAction(action)');
  assert.ok(start > 0, 'siDoAction 函数存在');
  const WINDOW = 20000;
  const seg = src.slice(start, start + WINDOW);
  const end = seg.indexOf('\n    }');   // 函数结束
  assert.ok(end > 0, `siDoAction 函数体未在 ${WINDOW} 字符窗口内找到结尾——函数体又变长了，请调大本文件 extractDoActionCases 的 WINDOW 常量（勿静默截断，否则窗口外的合法 case 会被误判为死按钮）`);
  const body = seg.slice(0, end);
  const cases = new Set();
  const re = /case\s+'([^']+)':/g; let m;
  while ((m = re.exec(body))) cases.add(m[1]);
  return cases;
}

function main() {
  const meta = T.buildMeta();

  // ═══ [D] 双向完整性（meta 可渲染 action ↔ siDoAction case）═══
  {
    const doActionCases = extractDoActionCases(html);
    // siRenderActions 会为 typeFlows 里的 action 渲染按钮（排除 create + 两个 C-orch 特殊动作·它们走独立区块非 siDoAction）。
    const RENDER_EXCLUDED = new Set(['create', 'assign-release-dev', 'execute-release']);
    // siDoAction 里的非 meta 旁路动作（create-chat 是拉群·非 transition·允许存在）。
    // [C3 第2批收口·对抗审 B 项裁定] 'publish' 白名单已删除——第2批前端已把 siDoAction 的
    //   `case 'publish': return siModalHotfix(iss);` 一并移除（siModalHotfix 改由独立按钮 hotfixBtn 直接
    //   调用，不再经 siDoAction('publish') 分发，见 Sys_Iteration.html siRenderActions/siDoAction 两处注释），
    //   'publish' 已不再是孤儿 case，本白名单条目随之失去存在意义。原批1注释已预告"批2会把新入口接上，届时
    //   应删除本行白名单"——本次补上，同时在下方新增回归钉防未来误回退。
    const NON_META_CASES = new Set(['create-chat']);

    const renderableActions = new Set();
    for (const type of Object.keys(meta.typeFlows)) {
      for (const f of meta.typeFlows[type]) {
        if (RENDER_EXCLUDED.has(f.action)) continue;
        renderableActions.add(f.action);
      }
    }
    // 正向：每个可渲染 action 都有 siDoAction case（否则点击 → default「未知动作」= 死按钮）
    const missingHandler = [...renderableActions].filter(a => !doActionCases.has(a));
    assert.strictEqual(missingHandler.length, 0, `以下可渲染 action 无 siDoAction case（死按钮）：${missingHandler.join(', ')}`);
    // 反向：每个 siDoAction case（除 create-chat）都对应一个 meta action（无孤儿 case）
    const orphanCases = [...doActionCases].filter(a => !renderableActions.has(a) && !NON_META_CASES.has(a));
    assert.strictEqual(orphanCases.length, 0, `以下 siDoAction case 无对应 meta action（孤儿/死代码）：${orphanCases.join(', ')}`);
    // 受理排期新动作确在两侧
    for (const a of ['intake_accept', 'intake_return', 'resubmit_intake', 'edit_in_revision', 'change_intake_mode', 'request_tech_consult', 'set_scheduled_start']) {
      assert.ok(renderableActions.has(a), `meta 含 ${a}`);
      assert.ok(doActionCases.has(a), `siDoAction 含 ${a} case`);
    }
    ok(`[D] 双向完整性：${renderableActions.size} 个可渲染 action 全有 siDoAction handler（0 死按钮）+ 0 孤儿 case（含受理排期 7 新动作）`);

    // [C3 第2批收口·对抗审 B 项裁定] 回归钉：siDoAction 不应再出现 `case 'publish'`——上方 orphanCases
    //   通用检查在"重新加回却不接 meta"时已会失败，但那条错误信息是"孤儿 case"泛指，不点名具体是谁；
    //   这里显式点名断言，防未来误回退时排障要绕一圈才能定位到具体是哪个 action 复活了。
    assert.ok(!doActionCases.has('publish'), 'siDoAction 不应再含 case \'publish\'（旧 hotfix-publish 触发点已改走独立按钮 hotfixBtn 直调 siModalHotfix，不再经 siDoAction 分发；若此断言失败说明该 case 被误回退）');
    ok('[D-回归钉] siDoAction 确认不含 case \'publish\'（C3 第2批退场，防未来误回退）');
  }

  // ═══ [W] 白名单三处一致（前端字面量 == 后端 _internals）═══
  {
    assert.deepStrictEqual(I.SYS_INTAKE_LIAISON_IDS, [13], '后端 SYS_INTAKE_LIAISON_IDS=[13]');
    assert.deepStrictEqual(I.SYS_TECH_LEAD_IDS, [7], '后端 SYS_TECH_LEAD_IDS=[7]');
    assert.ok(/const\s+SI_INTAKE_LIAISON_IDS\s*=\s*\[\s*13\s*\]/.test(html), '前端 SI_INTAKE_LIAISON_IDS=[13]（与后端同源）');
    assert.ok(/const\s+SI_TECH_LEAD_IDS\s*=\s*\[\s*7\s*\]/.test(html), '前端 SI_TECH_LEAD_IDS=[7]（与后端同源）');
    ok('[W] 白名单三处一致：SI_INTAKE_LIAISON_IDS[13]/SI_TECH_LEAD_IDS[7] 前端==后端（防漂移）');
  }

  // ═══ [F] C7 新增前端函数 + 端点路径齐备 ═══
  {
    for (const fn of ['siModalEditInRevision', 'siModalChangeIntakeMode', 'siModalRequestTechConsult', 'siModalSetScheduledStart', 'siRenderTechLeadNotifyRow', 'siResendTechConsult', 'siRemainingDaysHtml']) {
      assert.ok(html.includes('function ' + fn) || html.includes(fn + ' '), `C7 新增函数 ${fn} 已定义`);
    }
    // 受理排期端点路径都在前端调用（对齐后端 router.post）
    for (const ep of ['/intake-accept', '/intake-return', '/resubmit-intake', '/edit-in-revision', '/change-intake-mode', '/request-tech-consult', '/resend-tech-consult', '/set-scheduled-start']) {
      assert.ok(html.includes(ep), `前端含端点路径 ${ep}`);
    }
    // 技术负责人通知行在两个 siRenderNotify 分支都渲染（变更流 + bug）
    const notifyRowCalls = (html.match(/siRenderTechLeadNotifyRow\(iss\)/g) || []).length;
    assert.ok(notifyRowCalls >= 2, `技术负责人通知行在两 siRenderNotify 分支渲染（实际 ${notifyRowCalls} 处·变更流+bug）`);
    ok('[F] C7 前端函数 7 个 + 受理排期端点路径 8 条 + 技术负责人通知行两分支渲染 齐备');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c7 全部通过（${passed} 组）`);
  db.close();
}

// 等 readiness（buildMeta 不依赖 schema·但 mod 构造有异步 initSchema·此处 buildMeta 是纯常量·可直接跑）
main();
