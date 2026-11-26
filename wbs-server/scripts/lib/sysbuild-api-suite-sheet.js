// 验证脚本库：项目管理（系统建设记录）模块 C4c R-S1——需求确认单导出（#113 段 6 C4c）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261102_v1.3.md §2.2 不变量 9、§4.2、§5.2「导出需求确认单」行、§5.3、§7「导出」行、§8.3「确认页」
//   派单：docs/local/系统建设记录/送审准备/C4c_R-S1_确认单导出_派单_20261105.md（契约 2.1–2.5；R-D2：草稿 409，R-D3：页面内容与顺序）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects；无账号成员走 POST /members（person_name）；包、版本、提交、平台确认、代录、历史补录、历史导入、撤回、改发全部走生产端点。
//   只有这几类直接写库：① 需求部门参与方、现任任职 / 生效授权；② 附件行（暂存）与附件的原名 / 遮蔽（构造被遮蔽、带特殊字符原名的附件）；
//   ③ 把任务修订的创建时间回拨到固定日期（代录外部日期的下限取修订创建日）；④ 改项目名（构造带特殊字符的项目名）。
// 时间：进程内夹具的「今天」由统一todayProvider固定注入，外部确认日期用固定的 2026-10-25；导出时间是服务器当前时刻，用例只断格式，不断值。
'use strict';
const assert = require('assert');

const FLOOR_AT = '2026-10-20 09:00:00';
const OK_DATE = '2026-10-25';
const CHECKBOX = '我已阅读以上全部内容，确认无误';
const P = 'C4c 确认单：';
const T_PARAM = `${P}参数与可见性`;
const T_DRAFT = `${P}草稿 409`;
const T_HEAD = `${P}响应头与页面安全`;
const T_READ = `${P}纯读`;
const T_PENDING = `${P}待确认版本`;
const T_MIXED = `${P}生产路径生效 混合方式`;
const T_SUPER = `${P}已被替代`;
const T_MASK = `${P}遮蔽`;
const T_ESC = `${P}转义`;
const T_TAG = `${P}模板助手调用形态`;
const T_CARD = `${P}钉钉卡片确认`;
const T_MAP = `${P}映射兜底`;
const T_ACTIONS = `${P}actions 同源`;

// 要注入的特殊串及其转义形式（手写）
const X_SCRIPT = '<script>x</script>';
const X_ATTR = '" onmouseover="x';
const X_IMG = "'><img src=x>";
const E_SCRIPT = '&lt;script&gt;x&lt;/script&gt;';
const E_ATTR = '&quot; onmouseover=&quot;x';
const E_IMG = '&#39;&gt;&lt;img src=x&gt;';

// ── 页面解析（只为断言，不是被测代码）────────────────────────────────────────────────────────────
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function attrsOf(s) {
  const o = {};
  const re = /data-([a-z-]+)="([^"]*)"/g;
  let m = re.exec(s);
  while (m !== null) { o[m[1]] = m[2]; m = re.exec(s); }
  return o;
}
function sectionOf(h, id) {
  const m = h.match(new RegExp(`<section id="${id}">[\\s\\S]*?</section>`));
  assert.ok(m, `页面缺少节 ${id}`);
  return m[0];
}
// 带某 data-* 属性的 <tr> 行：[{ attrs, inner, text }]
function rowsBy(h, attr) {
  const out = [];
  const re = new RegExp(`<tr\\b([^>]*\\b${attr}="[^"]*"[^>]*)>([\\s\\S]*?)</tr>`, 'g');
  let m = re.exec(h);
  while (m !== null) { out.push({ attrs: attrsOf(m[1]), inner: m[2], text: strip(m[2]) }); m = re.exec(h); }
  return out;
}
// 带某 data-* 属性的 <li>（附件行 / 历史补录行）
function liBy(h, attr) {
  const out = [];
  const re = new RegExp(`<li\\b([^>]*\\b${attr}="[^"]*"[^>]*)>([\\s\\S]*?)</li>`, 'g');
  let m = re.exec(h);
  while (m !== null) { out.push({ attrs: attrsOf(m[1]), inner: m[2], text: strip(m[2]) }); m = re.exec(h); }
  return out;
}
// 带某 data-* 属性的 <div>（内部没有嵌套 div）
function divBy(h, attr) {
  const out = [];
  const re = new RegExp(`<div\\b([^>]*\\b${attr}="[^"]*"[^>]*)>([\\s\\S]*?)</div>`, 'g');
  let m = re.exec(h);
  while (m !== null) { out.push({ attrs: attrsOf(m[1]), inner: m[2], text: strip(m[2]) }); m = re.exec(h); }
  return out;
}
const headingsOf =(h) => (h.match(/<h2>[^<]*<\/h2>/g) || []).map((x) => x.slice(4, -5));
const headerTag = (h) => {
  const m = h.match(/<header id="sheet-header"[^>]*>/);
  assert.ok(m, '页面缺少页头');
  return attrsOf(m[0]);
};

function defineSheetCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, addMember, addParty, addAppointment, addDelegation, getMods, confirm: H } = T;
  const stageAtt = (pid, uid, ch) => H.stageAtt(pid, uid, /^[0-9a-f]$/.test(ch) ? ch : (ch.charCodeAt(0) % 16).toString(16));
  const { newProject, mkPackage, mkPreparedVersion: mkVersion, tasksOf, openAndDecide, confirmAll, planAllNodes, seedEffectiveInitiation, seedParty, seedHistoricalLeaderTask, PLAN_START, PLAN_END } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const sheetUrl = (vid) => `/sysbuild/package-versions/${vid}/confirmation-sheet`;
  const sheet = (uid, vid) => get(uid, sheetUrl(vid));
  const sheetOk = async (uid, vid) => {
    const r = await sheet(uid, vid);
    assert.strictEqual(r.status, 200, `导出应成功，实际 ${r.status} ${String(r.text).slice(0, 200)}`);
    return r.text;
  };
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const nameOf = async (uid) => (await sqlGet('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [uid])).n;

  // 夹具（#212 C7）：包版本自己的附件直接写库绑定（owner_type = package_version；没有条目这一路，提交时进冻结清单，写法同 confirm 套件的 mkSubmitted）
  const bindToVersion = (att, vid) => sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [att, vid, U.pm]);
  const pairedAttachment = async (vid) => (await sqlGet(
    `SELECT b.attachment_id FROM sysbuild_package_versions v
       JOIN json_each(v.snapshot_json, '$.material_version_ids') j
       JOIN sysbuild_attachment_bindings b ON b.owner_id = j.value AND b.owner_type = 'material_version'
      WHERE v.id = ?`, [vid])).attachment_id;

  // 同时覆盖旧任职任务与现行授权任务的确认单保留行为。
  async function mkPendingScene() {
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid);
    const mProp = await addMember(pid, U.m1); // 一般成员（原为条目提出人；用例「参数与可见性」要求一般成员 m1 在本项目里）
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    await seedHistoricalLeaderTask(pid, pk, pv, A);
    await planAllNodes(pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    return { pid, A, mProp, pk, pv, tasks: await tasksOf(pv) };
  }
  let pendingMemo = null;
  const pendingScene = () => { if (pendingMemo === null) pendingMemo = mkPendingScene(); return pendingMemo; };

  // 生产路径生效的总体规划包：负责人 own、代表人 del 都在平台确认；包版本自己绑定三个附件（原名各不相同，SHA-256 起头字符 a / b / 9，便于断言）。
  //   #212 C7：需求条目没有了，原来的条目块与提出人任务随之删除；附件直接写库绑到包版本（卡写「材料版本」，实作取 M10 同口径：材料版本会多出材料块、可用性拒绝与生效时的材料冻结核对）。
  async function mkMixedScene() {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mOwn = await addMember(pid, U.own, { party });
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addMember(pid, U.del, { party });
    await addDelegation(party, mDel, apt, 'active');
    await seedEffectiveInitiation(pid);
    const attA = await stageAtt(pid, U.pm, 'a');
    const attB = await stageAtt(pid, U.pm, 'b');
    const attC = await stageAtt(pid, U.pm, '9');
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '附件一.txt' WHERE id = ?", [attA]);
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '附件二.txt' WHERE id = ?", [attB]);
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '附件三.txt' WHERE id = ?", [attC]);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    for (const att of [attA, attB, attC]) await bindToVersion(att, pv);
    await planAllNodes(pid);
    await seedHistoricalLeaderTask(pid, pk, pv, { party, mOwn, apt });
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    assert.deepStrictEqual(tasks.map((t) => t.user_id), [U.own, U.del]);
    const d1 = await openAndDecide(U.own, tasks[0].task_id, 'confirm');
    assert.strictEqual(d1.status, 200, d1.text);
    const d2 = await openAndDecide(U.del, tasks[1].task_id, 'confirm');
    assert.strictEqual(d2.status, 200, d2.text);
    assert.strictEqual(d2.body.effective, true);
    return { pid, party, pk, pv, tasks, attA, attB, attC };
  }
  let mixedMemo = null;
  const mixedScene = () => { if (mixedMemo === null) mixedMemo = mkMixedScene(); return mixedMemo; };

  // ── 1 参数与可见性 ───────────────────────────────────────────────────────────────────────────
  test(`${T_PARAM}——非法编号 400；不存在 / 非成员 404（错误体是 JSON）；只读账号（非成员）、一般成员、PM、admin、必需确认人都 200`, async () => {
    const s = await pendingScene();
    for (const bad of ['abc', '0', '-1', '1.5', '01', '1e3']) {
      const r = await get(U.pm, `/sysbuild/package-versions/${bad}/confirmation-sheet`);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', `编号 ${bad}`);
      assert.strictEqual(r.body.field, 'vid', `编号 ${bad} 的 field`);
    }
    const nf = await sheet(U.pm, 99999999);
    expectErr(nf, 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    assert.ok(String(nf.headers.get('content-type')).includes('application/json'), '错误体是 JSON，不出 HTML 错误页');
    const out = await sheet(U.out, s.pv);
    expectErr(out, 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.deepStrictEqual(out.body, nf.body, '非成员与不存在同一错误体，不暴露版本存在');
    assert.strictEqual((await sheet(null, s.pv)).status, 401, '未登录');
    assert.ok(!(await sqlGet('SELECT 1 AS x FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [s.pid, U.ro])), '前置：只读账号不是本项目成员');
    for (const [uid, label] of [[U.ro, '只读账号（非成员）'], [U.m1, '一般成员'], [U.pm, 'PM'], [U.admin, 'admin'], [U.own, '必需确认人']]) {
      const r = await sheet(uid, s.pv);
      assert.strictEqual(r.status, 200, `${label} 应 200，实际 ${r.status} ${String(r.text).slice(0, 120)}`);
      assert.ok(r.text.includes('需求确认单'), `${label}：返回的是确认单页面`);
    }
  });

  // ── 2 草稿 409 ───────────────────────────────────────────────────────────────────────────────
  test(`${T_DRAFT}——草稿版本 409 SYSBUILD_STATE（R-D2，对 PM 与 admin 一样）；非成员仍是 404（可见性先于状态）；提交后可导出`, async () => {
    const pid = await newProject();
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    for (const [uid, label] of [[U.pm, 'PM'], [U.admin, 'admin']]) {
      const r = await sheet(uid, pv);
      expectErr(r, 409, 'SYSBUILD_STATE', `${label} 导出草稿`);
      assert.ok(String(r.headers.get('content-type')).includes('application/json'), '409 的错误体是 JSON');
      assert.ok(!r.text.includes('<html'), '409 不返回 HTML 页面');
    }
    expectErr(await sheet(U.out, pv), 404, 'SYSBUILD_NOT_FOUND', '非成员导出草稿');
    // 同项目再建一个待确认版本（对照：非草稿 200）
    await seedParty(pid, '甲部', U.own, U.del);
    // L2 fixture：只在正向提交对照前补声明，前面的草稿 / 非成员拒绝原样保留。
    await H.declareInitiationBasis(pv);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const exported = await sheet(U.pm, pv);
    assert.strictEqual(exported.status, 200, '提交后可导出');
    // #212 C2f（codex 102 L2）：无引用材料的立项包（没有「引用材料版本全文」节、没有节点计划节）：五节 + 附录，序号连续
    //   #212 C7：「引用条目」小节随需求条目流程删除，必需确认人前移为第四节（M-SHEET 授权的序号前移）
    assert.deepStrictEqual(headingsOf(exported.text), ['一、包内容快照', '二、立项依据', '三、冻结附件清单（本包版本）', '四、必需确认人', '附录：修订历史'], '无引用材料的立项包小节序号连续');
  });

  // ── 3 响应头与页面安全 ───────────────────────────────────────────────────────────────────────
  test(`${T_HEAD}——六个头逐个断言值；页面无 script / 内联事件 / 外部资源，只有一个内联 style（含 @media print 与 A4）`, async () => {
    const s = await pendingScene();
    const r = await sheet(U.pm, s.pv);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'text/html; charset=utf-8', 'Content-Type');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'Cache-Control');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy');
    assert.strictEqual(r.headers.get('content-disposition'), 'inline', 'Content-Disposition');
    assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Content-Security-Policy');
    const body = r.text;
    assert.ok(!/<script/i.test(body), '无 <script');
    assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(body), '无内联事件属性');
    assert.ok(!/(href|src)\s*=/i.test(body) && !/<(link|img|iframe|object|embed|form|base)\b/i.test(body), '无外部资源引用 / 表单 / base');
    assert.ok(!/https?:\/\//i.test(body), '无外部地址');
    assert.strictEqual((body.match(/<style\b/gi) || []).length, 1, '恰好一个内联 style');
    assert.ok(body.includes('@media print') && body.includes('size: A4'), '含 @media print 与 A4');
    assert.ok(/page-break-inside:\s*avoid/.test(body) && /\.no-print\s*\{\s*display:\s*none/.test(body), '打印：行不跨页断开、隐藏无关元素');
    assert.ok(body.startsWith('<!doctype html>'), '文档类型声明');
  });

  // ── 4 纯读 ───────────────────────────────────────────────────────────────────────────────────
  test(`${T_READ}——导出前后 sysbuild_views / sysbuild_events / sysbuild_confirmations 等行数不变（含必需确认人本人导出当前待确认修订，不写浏览记录）`, async () => {
    const s = await pendingScene();
    const snap = () => sqlGet(
      `SELECT (SELECT COUNT(*) FROM sysbuild_views) AS views, (SELECT COUNT(*) FROM sysbuild_events) AS events, (SELECT COUNT(*) FROM sysbuild_confirmations) AS confirmations,
              (SELECT COUNT(*) FROM sysbuild_confirm_task_revisions) AS revisions, (SELECT COUNT(*) FROM sysbuild_frozen_attachments) AS frozen,
              (SELECT COUNT(*) FROM sysbuild_attachment_bindings) AS bindings, (SELECT COALESCE(MAX(id), 0) FROM sysbuild_events) AS max_event`
    );
    const before = await snap();
    for (const uid of [U.own, U.del, U.pm, U.admin, U.ro]) assert.strictEqual((await sheet(uid, s.pv)).status, 200);
    assert.deepStrictEqual(await snap(), before, '导出是纯读：任何表的行数都不变');
    assert.strictEqual((await sqlGet("SELECT COUNT(*) AS n FROM sysbuild_views WHERE user_id = ? AND object_version_id = ?", [U.own, s.pv])).n, 0, '必需确认人导出没有产生浏览记录');
  });

  // ── 5 待确认版本 ─────────────────────────────────────────────────────────────────────────────
  test(`${T_PENDING}——页头状态 pending 与徽标「待确认 · 未生效」、导出人 / 导出时间；每个任务一行 data-method=none；节次顺序；节点计划`, async () => {
    const s = await pendingScene();
    const body = await sheetOk(U.pm, s.pv);
    const hd = headerTag(body);
    assert.strictEqual(hd['version-status'], 'pending');
    const head = strip(sectionOfHeader(body));
    assert.ok(head.includes('需求确认单'), '标题');
    assert.ok(head.includes('待确认 · 未生效'), `徽标文字，实际 ${head}`);
    assert.ok(head.includes('总体规划包') && head.includes('v1'), '包类型与版本号');
    const proj = await sqlGet('SELECT system_name FROM sysbuild_projects WHERE id = ?', [s.pid]);
    assert.ok(head.includes(proj.system_name), '项目名称');
    assert.ok(head.includes(await nameOf(U.pm)), '导出人姓名');
    assert.ok(/导出时间\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?!:)/.test(head), `导出时间到分钟，实际 ${head}`);
    // 单批项目的总体规划包：形态 = 单批合并
    assert.ok(head.includes('单批合并'), '形态：单批合并');
    // 节次顺序（#212 C2 删历史补录节、C7 删引用条目节后共四节加附录：快照、节点计划、冻结附件、必需确认人）
    const ids = ['sec-snapshot', 'sec-plans', 'sec-frozen', 'sec-materials', 'sec-confirmers', 'sec-appendix'].map((id) => body.indexOf(`<section id="${id}">`));
    assert.ok(ids.every((x, i) => x > 0 && (i === 0 || x > ids[i - 1])), `节次顺序，实际 ${ids}`);
    assert.ok(!body.includes('<section id="sec-items">'), '没有「引用条目」节');
    assert.ok(body.indexOf('本单按提交时冻结的快照生成；附件以 SHA-256 核对；确认方式以平台记录为准') > ids[5], '页脚固定说明在最后');
    assert.deepStrictEqual(headingsOf(body), ['一、包内容快照', '二、节点计划快照', '三、冻结附件清单（本包版本）', '四、引用材料版本全文', '五、必需确认人', '附录：修订历史'], '总体规划包的小节序号连续');
    assert.ok(body.indexOf('<meta charset="utf-8">') > 0 && body.indexOf('<meta charset="utf-8">') < body.indexOf('<title>'), 'meta charset 在 title 之前');
    assert.ok(/<head>\s*<meta charset="utf-8">/.test(body), 'meta charset 是 head 的第一个元素');
    assert.ok(strip(sectionOf(body, 'sec-snapshot')).includes('本次需要确认的内容及依据'), '确认单展示保存的确认正文');
    assert.ok(strip(sectionOf(body, 'sec-materials')).includes('需求文档'), '配对材料在独立材料段展示');
    // 节点计划：自研项目 5 个节点，计划起止为 planAllNodes 统一写入的固定日期。
    const plans = strip(sectionOf(body, 'sec-plans'));
    const nodeCount = await countOf("SELECT COUNT(*) AS n FROM sysbuild_nodes WHERE project_id = ? AND status <> 'cancelled'", [s.pid]);
    assert.strictEqual(nodeCount, 5);
    assert.strictEqual((plans.match(new RegExp(PLAN_START, 'g')) || []).length, 2, '自研两个节点的计划开始');
    assert.strictEqual((plans.match(new RegExp(PLAN_END, 'g')) || []).length, 2, '自研两个节点的计划结束');
    assert.ok(plans.includes('验收和正式上线'));
    // 确认人：每个任务一行，method / decision 均为 none
    const rows = rowsBy(sectionOf(body, 'sec-confirmers'), 'data-task-id');
    assert.deepStrictEqual(rows.map((r) => [r.attrs['task-id'], r.attrs['revision-id'], r.attrs.method, r.attrs.decision]), s.tasks.map((t) => [String(t.task_id), String(t.rev_id), 'none', 'none']));
    assert.ok(rows[0].text.includes(await nameOf(U.own)) && rows[0].text.includes('负责人') && rows[0].text.includes('待确认') && rows[0].text.includes('尚无确认记录'), `负责人行：${rows[0].text}`);
    assert.ok(rows[1].text.includes(await nameOf(U.del)) && rows[1].text.includes('代表人'), `代表人行：${rows[1].text}`);
    assert.ok(rows.every((r) => r.text.includes('甲部') && r.text.includes('内容包确认')), '参与方与用途');
    assert.ok(!rows.some((r) => r.text.includes('只能代录') || r.text.includes('无平台账号')));
    // #212 C7：页面里没有条目块（原此处核条目的提出人状态、无书面证据声明与承诺批次，随需求条目流程删除）
    assert.ok(!body.includes('data-item-version-id') && !body.includes('data-proposer-status') && !body.includes('承诺批次'), '页面没有任何条目块的痕迹');
  });
  function sectionOfHeader(h) {
    const m = h.match(/<header id="sheet-header"[\s\S]*?<\/header>/);
    assert.ok(m, '页面缺少页头');
    return m[0];
  }

  // ── 6 生产路径生效 + 混合方式 ────────────────────────────────────────────────────────────────
  test(`${T_MIXED}——两个平台确认行各自显示平台方式，冻结附件和散列可核对`, async () => {
    const s = await mixedScene();
    const body = await sheetOk(U.admin, s.pv);
    const hd = headerTag(body);
    assert.strictEqual(hd['version-status'], 'effective');
    const eff = (await sqlGet('SELECT effective_at FROM sysbuild_package_versions WHERE id = ?', [s.pv])).effective_at;
    const head = strip(sectionOfHeader(body));
    assert.ok(head.includes('已生效') && head.includes(`生效时间 ${eff.slice(0, 16)}`), `已生效徽标与生效时间，实际 ${head}`);
    const rows = rowsBy(sectionOf(body, 'sec-confirmers'), 'data-task-id');
    assert.deepStrictEqual(rows.map((r) => [r.attrs['task-id'], r.attrs.method, r.attrs.decision]), [[String(s.tasks[0].task_id), 'platform', 'confirm'], [String(s.tasks[1].task_id), 'platform', 'confirm']]);
    const plat = rows[0].text;
    assert.ok(plat.includes('方式： 平台确认') && !plat.includes('方式： 代录'), `平台确认行的方式文字：${plat}`);
    assert.ok(rows[0].inner.includes('<td>负责人</td>') && !rows[0].inner.includes('<td>代表人</td>'), '平台确认行的身份单元格是负责人');
    assert.ok(plat.includes(`勾选声明：${CHECKBOX}`) && plat.includes(`操作人：${await nameOf(U.own)}`) && plat.includes('已确认'), `平台确认行：${plat}`);
    assert.ok(!plat.includes('外部确认日期'), '平台确认没有外部确认信息');
    const plat2 = rows[1].text;
    assert.ok(plat2.includes('方式： 平台确认') && rows[1].inner.includes('<td>代表人</td>') && !rows[1].inner.includes('<td>负责人</td>'), `第二行：平台确认，身份单元格精确是代表人：${plat2}`);
    assert.ok(plat2.includes(`操作人：${await nameOf(U.del)}`), `第二行操作人：${plat2}`);
    // 冻结附件：包版本绑定的三个附件随包冻结，按附件编号升序
    const frozen = liBy(sectionOf(body, 'sec-frozen'), 'data-attachment-id');
    assert.deepStrictEqual(frozen.map((a) => [a.attrs['attachment-id'], a.attrs.masked]), [[String(s.attA), '0'], [String(s.attB), '0'], [String(s.attC), '0'], [String(await pairedAttachment(s.pv)), '0']]);
    assert.ok(frozen[0].text.includes('附件一.txt') && frozen[0].text.includes('3 字节') && frozen[0].text.includes(`SHA-256 ${'a'.repeat(64)}`), frozen[0].text);
    assert.ok(frozen[1].text.includes('附件二.txt') && frozen[1].text.includes(`SHA-256 ${'b'.repeat(64)}`), frozen[1].text);
    assert.ok(frozen[2].text.includes('附件三.txt') && frozen[2].text.includes(`SHA-256 ${'9'.repeat(64)}`), frozen[2].text);
    // 节点计划与快照：生效版本仍显示提交时的计划
    // C5 N-SHEET（承接被删的 changes 套件 T_W_PLANS :1053，导出对象唯一为本场景的 s.pv：自己有提交事件、首版总体规划已生效）：按节点名定位「立项与授权」行，
    //   计划开始 / 结束 = planAllNodes 统一写入的固定日期，先按节点名核所在行，再核全部计划的条数。
    const planRow = (sectionOf(body, 'sec-plans').match(/<tr><td>结项<\/td>(?:<td>[^<]*<\/td>)*<\/tr>/) || [])[0];
    assert.ok(planRow, '生效确认单中有结项职责节点');
    const planCells = (planRow.match(/<td>[^<]*<\/td>/g) || []).map((x) => x.slice(4, -5));
    assert.deepStrictEqual([planCells[0], planCells[4], planCells[5]], ['结项', PLAN_START, PLAN_END], '「结项」行的计划开始 / 计划结束');
    assert.strictEqual((strip(sectionOf(body, 'sec-plans')).match(new RegExp(PLAN_START, 'g')) || []).length, 2);
    // 附录：每个任务一个修订（都只有 1 条）
    const app = rowsBy(sectionOf(body, 'sec-appendix'), 'data-appendix-revision-id');
    assert.deepStrictEqual(app.map((r) => r.attrs['appendix-revision-id']), s.tasks.map((t) => String(t.rev_id)));
    assert.ok(app[0].text.includes('平台确认') && app[1].text.includes('平台确认'), '附录的确认记录摘要带方式');
  });

  // ── 8 已被替代 ───────────────────────────────────────────────────────────────────────────────
  test(`${T_SUPER}——撤回的版本（未生效）与被新版本替代的已生效版本徽标各自正确；改发过的任务附录列出被替代的旧修订及原因，正文取最新修订`, async () => {
    // (a) 撤回：待确认 → 撤回 → superseded，没有生效时间
    const a = await mkPendingScene();
    const wd = await post(U.pm, `/sysbuild/package-versions/${a.pv}/withdraw`, { reason: '撤回测试原因' });
    assert.strictEqual(wd.status, 200, wd.text);
    const ba = await sheetOk(U.pm, a.pv);
    assert.strictEqual(headerTag(ba)['version-status'], 'superseded');
    const ha = strip(sectionOfHeader(ba));
    assert.ok(ha.includes('已被替代 · 未生效（撤回或被新版本替代）'), `撤回版本的徽标，实际 ${ha}`);
    assert.ok(!ha.includes('曾于'), '未生效的版本不写「曾于 … 生效」');
    const rowsA = rowsBy(sectionOf(ba, 'sec-confirmers'), 'data-task-id');
    assert.ok(rowsA.length === 2 && rowsA.every((r) => r.text.includes('已失效') && r.text.includes('撤回测试原因')), `撤回后任务修订已失效并带原因：${rowsA.map((r) => r.text).join(' | ')}`);
    // (b) 已生效后被新版本替代：立项包 v1 生效 → v2 生效，v1 变 superseded 且保留生效时间
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    const ini = await H.produceEffectiveInitiation(pid);
    const effAt = (await sqlGet('SELECT effective_at FROM sysbuild_package_versions WHERE id = ?', [ini.pv])).effective_at;
    const pv2 = await mkVersion(ini.pk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv2}/submit`)).status, 200);
    await confirmAll(pv2);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [ini.pv])).status, 'superseded');
    const bb = await sheetOk(U.pm, ini.pv);
    assert.strictEqual(headerTag(bb)['version-status'], 'superseded');
    const hb = strip(sectionOfHeader(bb));
    assert.ok(hb.includes(`已被替代 · 曾于 ${effAt.slice(0, 16)} 生效`), `被替代的已生效版本，实际 ${hb}`);
    assert.ok(!hb.includes('未生效'), '曾生效的版本不写未生效');
    // (c) 改发：负责人更换后改发新负责人
    const c = await mkPendingScene();
    const t = c.tasks[0];
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-20 10:00:00', end_reason = '负责人更换' WHERE id = ?", [c.A.apt]);
    const mCand = await addMember(c.pid, U.cand, { party: c.A.party });
    await addAppointment(c.A.party, mCand, 'active');
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${t.task_id}/reissue`, { reason: '负责人更换，改发新负责人' });
    assert.strictEqual(rr.status, 200, rr.text);
    const newRev = rr.body.revision.id;
    assert.notStrictEqual(newRev, t.rev_id);
    const bc = await sheetOk(U.pm, c.pv);
    const main = rowsBy(sectionOf(bc, 'sec-confirmers'), 'data-task-id');
    const mainRow = main.find((r) => r.attrs['task-id'] === String(t.task_id));
    assert.ok(mainRow, '正文有该任务的行');
    assert.strictEqual(mainRow.attrs['revision-id'], String(newRev), '正文取最新修订');
    assert.ok(mainRow.text.includes(await nameOf(U.cand)) && !mainRow.text.includes(await nameOf(U.own)), `正文是新负责人：${mainRow.text}`);
    assert.ok(!sectionOf(bc, 'sec-confirmers').includes(`data-revision-id="${t.rev_id}"`), '旧修订不在正文');
    const appRows = rowsBy(sectionOf(bc, 'sec-appendix'), 'data-appendix-task-id').filter((r) => r.attrs['appendix-task-id'] === String(t.task_id));
    assert.deepStrictEqual(appRows.map((r) => [r.attrs['appendix-revision-id'], r.attrs['rev-no']]), [[String(t.rev_id), '1'], [String(newRev), '2']], '附录按修订号升序列出全部修订');
    assert.ok(appRows[0].text.includes('已替代') && appRows[0].text.includes('负责人更换，改发新负责人') && appRows[0].text.includes(await nameOf(U.own)), `被替代的旧修订及其原因：${appRows[0].text}`);
    assert.ok(appRows[1].text.includes('待确认') && appRows[1].text.includes(await nameOf(U.cand)), appRows[1].text);
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(appRows[0].text), '附录带创建时间');
  });

  // ── 9 遮蔽 ───────────────────────────────────────────────────────────────────────────────────
  test(`${T_MASK}——冻结附件被遮蔽后 data-masked=1 并显示遮蔽原因，页面任何位置不含原文件名（admin 一样）；未遮蔽的附件照常显示原名`, async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid);
    const a1 = await stageAtt(pid, U.pm, 'a');
    const a2 = await stageAtt(pid, U.pm, 'b');
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '需遮蔽原文件.txt' WHERE id = ?", [a1]);
    await sqlRun("UPDATE sysbuild_attachments SET original_name = '保留可见.txt' WHERE id = ?", [a2]);
    const pv = await mkVersion(await mkPackage(pid, 'overall'));
    await bindToVersion(a1, pv);
    await bindToVersion(a2, pv);
    await planAllNodes(pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    // 对照：遮蔽前两个附件都显示原名
    const before = await sheetOk(U.pm, pv);
    assert.ok(before.includes('需遮蔽原文件.txt') && before.includes('保留可见.txt'), '遮蔽前显示原名（对照）');
    const paired = await pairedAttachment(pv);
    assert.deepStrictEqual(liBy(sectionOf(before, 'sec-frozen'), 'data-attachment-id').map((a) => [a.attrs['attachment-id'], a.attrs.masked]), [[String(a1), '0'], [String(a2), '0'], [String(paired), '0']]);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = ?, mask_reason = '含敏感信息，经 PM 受控遮蔽' WHERE id = ?", [U.pm, a1]);
    for (const [uid, label] of [[U.pm, 'PM'], [U.admin, 'admin']]) {
      const body = await sheetOk(uid, pv);
      assert.ok(!body.includes('需遮蔽原文件'), `${label}：页面任何位置不含被遮蔽附件的原名`);
      const fr = liBy(sectionOf(body, 'sec-frozen'), 'data-attachment-id');
      assert.deepStrictEqual(fr.map((a) => [a.attrs['attachment-id'], a.attrs.masked]), [[String(a1), '1'], [String(a2), '0'], [String(paired), '0']], `${label}：冻结清单的遮蔽标记`);
      assert.ok(fr[0].text.includes('已遮蔽') && fr[0].text.includes('遮蔽原因：含敏感信息，经 PM 受控遮蔽') && fr[0].text.includes(`SHA-256 ${'a'.repeat(64)}`) && fr[0].text.includes('3 字节'), `${label}：${fr[0].text}`);
      assert.ok(fr[1].text.includes('保留可见.txt') && fr[1].text.includes(`SHA-256 ${'b'.repeat(64)}`), `${label}：未遮蔽的附件照常显示：${fr[1].text}`);
    }
  });

  // ── 9b C5 N-SHEET ─────────────────────────────────────────────────────────────────────────────
  //   承接被删的 changes 套件 T_SHEET（待确认总体规划版本导出）与 T_W_FREEZE 的保留部分（冻结清单照冻结值展示，不读附件现值）。
  test(`C5 N-SHEET：待确认的总体规划版本导出 200、页头 data-version-status = pending 且含「总体规划包」；附件现值在提交之后被改，冻结附件清单（sec-frozen）仍按冻结的 SHA-256 展示`, async () => {
    const pid = await newProject();
    await seedParty(pid, '甲部', U.own, U.del);
    await seedEffectiveInitiation(pid);
    const a1 = await stageAtt(pid, U.pm, 'f');
    const pv = await mkVersion(await mkPackage(pid, 'overall'));
    await bindToVersion(a1, pv);
    await planAllNodes(pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    const before = await sheetOk(U.pm, pv);
    assert.strictEqual(headerTag(before)['version-status'], 'pending', '页头 data-version-status = pending');
    assert.ok(strip(sectionOfHeader(before)).includes('总体规划包'), '页头含「总体规划包」');
    const frozenBefore = liBy(sectionOf(before, 'sec-frozen'), 'data-attachment-id');
    const expectedIds = [String(a1), String(await pairedAttachment(pv))];
    assert.deepStrictEqual(frozenBefore.map((a) => a.attrs['attachment-id']), expectedIds, '冻结清单包含包附件和配对材料附件');
    assert.ok(frozenBefore[0].text.includes(`SHA-256 ${'f'.repeat(64)}`), `前置：冻结时的 SHA-256，实际 ${frozenBefore[0].text}`);
    // 附件现值在提交之后被改（模拟现值与冻结时不同）：确认单仍按冻结值展示
    await sqlRun('UPDATE sysbuild_attachments SET sha256 = ? WHERE id = ?', ['a'.repeat(64), a1]);
    const after = await sheetOk(U.pm, pv);
    const frozenAfter = liBy(sectionOf(after, 'sec-frozen'), 'data-attachment-id');
    assert.deepStrictEqual(frozenAfter.map((a) => a.attrs['attachment-id']), expectedIds);
    assert.ok(frozenAfter[0].text.includes(`SHA-256 ${'f'.repeat(64)}`) && !frozenAfter[0].text.includes('a'.repeat(64)), `现值被改后仍按冻结 SHA-256 展示，实际 ${frozenAfter[0].text}`);
    assert.ok(!sectionOf(after, 'sec-frozen').includes('a'.repeat(64)), '冻结清单任何位置都不出现附件现值');
  });

  // ── 10 转义 ──────────────────────────────────────────────────────────────────────────────────
  test(`${T_ESC}——项目名 / 参与方名 / 成员名 / 原因 / 附件原名 / 遮蔽原因 / 快照键与值里的 HTML 与引号串全部被转义；转义助手五个字符直测`, async () => {
    const pid = await newProject();
    await sqlRun('UPDATE sysbuild_projects SET system_name = ? WHERE id = ?', [`${X_SCRIPT}项目`, pid]);
    const party = await addParty(pid, X_ATTR, 'demand');
    const mOwn = await addMember(pid, U.own, { party });
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addMember(pid, U.del, { party });
    await addDelegation(party, mDel, apt, 'active');
    await seedEffectiveInitiation(pid);
    const att1 = await stageAtt(pid, U.pm, 'a');
    const att2 = await stageAtt(pid, U.pm, 'b');
    await sqlRun('UPDATE sysbuild_attachments SET original_name = ? WHERE id = ?', [`${X_IMG}.txt`, att1]);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    await bindToVersion(att1, pv);
    await bindToVersion(att2, pv);
    await planAllNodes(pid);
    const patch = await api(U.pm, 'PATCH', `/sysbuild/package-versions/${pv}`, { snapshot_json: { 范围: X_SCRIPT, [X_ATTR]: '值', 嵌套: { a: X_IMG } } });
    assert.strictEqual(patch.status, 200, patch.text);
    await H.prepareBasisVersion(pv);
    await seedHistoricalLeaderTask(pid, pk, pv, { party, mOwn, apt });
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    // 已遮蔽的暂存附件不能再绑定，所以提交后再遮蔽 att2
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = ?, mask_reason = ? WHERE id = ?", [U.pm, X_SCRIPT, att2]);
    const tasks = await tasksOf(pv);
    const pr = await openAndDecide(U.own, tasks[0].task_id, 'object', { reason: X_SCRIPT });
    assert.strictEqual(pr.status, 200, pr.text);
    // 测试库中临时修改平台账号显示名，导出完成后恢复。
    const users = await sqlAll('SELECT id, display_name FROM users WHERE id IN (?, ?)', [U.own, U.del]);
    let body;
    try {
      await sqlRun('UPDATE users SET display_name = ? WHERE id = ?', [X_IMG, U.own]);
      await sqlRun('UPDATE users SET display_name = ? WHERE id = ?', [X_SCRIPT, U.del]);
      body = await sheetOk(U.pm, pv);
    } finally {
      for (const user of users) await sqlRun('UPDATE users SET display_name = ? WHERE id = ?', [user.display_name, user.id]);
    }
    for (const raw of [X_SCRIPT, X_ATTR, X_IMG]) assert.ok(!body.includes(raw), `页面不含原文串 ${raw}`);
    assert.ok(!/<script/i.test(body) && !/<img/i.test(body), '没有被注入的标签');
    assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(body), '没有被注入的内联事件属性');
    for (const [esc, label] of [[E_SCRIPT, '<script>'], [E_ATTR, '带引号的属性串'], [E_IMG, "'><img>"]]) assert.ok(body.includes(esc), `页面含转义形式（${label}）`);
    const text = (s) => sectionOf(body, s);
    assert.ok(strip(sectionOfHeader(body)).includes(`${E_SCRIPT}项目`), '项目名转义');
    assert.ok(text('sec-snapshot').includes(`<th>范围</th><td class="pre-wrap">${E_SCRIPT}</td>`), '快照字符串值转义');
    assert.ok(text('sec-snapshot').includes(`<th>${E_ATTR}</th>`), '快照键转义');
    assert.ok(text('sec-snapshot').includes(`&quot;a&quot;: &quot;${E_IMG}&quot;`), '快照嵌套值：JSON 文本再转义');
    const fr = text('sec-frozen');
    assert.ok(fr.includes(`${E_IMG}.txt`) && fr.includes(`遮蔽原因：${E_SCRIPT}`), '附件原名与遮蔽原因转义');
    const row = rowsBy(text('sec-confirmers'), 'data-task-id')[0];
    assert.ok(row.inner.includes(`原因：${E_SCRIPT}`), '确认记录的原因转义');
    assert.ok(row.inner.includes(`>${E_IMG}`) || row.inner.includes(E_IMG), '成员名转义');
    assert.ok(row.inner.includes(E_ATTR), '参与方名转义');
    // 转义助手直测（五个字符 + 空值 + 非字符串 + 片段嵌套 + 不信任的对象）
    const { esc, html, toText } = getMods().sheet._internals;
    assert.strictEqual(esc('&'), '&amp;');
    assert.strictEqual(esc('<'), '&lt;');
    assert.strictEqual(esc('>'), '&gt;');
    assert.strictEqual(esc('"'), '&quot;');
    assert.strictEqual(esc("'"), '&#39;');
    assert.strictEqual(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    assert.strictEqual(esc('a&amp;b'), 'a&amp;amp;b', '已转义的串再转义（不做「已转义则跳过」的智能判断）');
    assert.deepStrictEqual([esc(null), esc(undefined), esc(0), esc(12), esc(false)], ['', '', '0', '12', 'false']);
    assert.strictEqual(toText(html`<a title="${'"x'}">${'<b>'}</a>`), '<a title="&quot;x">&lt;b&gt;</a>');
    assert.strictEqual(toText(html`<p>${html`<b>${'<'}</b>`}</p>`), '<p><b>&lt;</b></p>', '助手自己产出的片段原样拼接，其中的插值仍转义');
    assert.strictEqual(toText(html`<ul>${['<', html`<i>${'&'}</i>`]}</ul>`), '<ul>&lt;<i>&amp;</i></ul>', '数组逐项处理');
    assert.strictEqual(toText(html`${'<b>'}`), '&lt;b&gt;', '长得像 HTML 的字符串不被信任');
    assert.strictEqual(toText(html`${{ x: 1 }}`), '[object Object]', '普通对象按字符串转义，不被当作片段');
    assert.strictEqual(toText(html`${{ toString: () => '<i>' }}`), '&lt;i&gt;', '自带 toString 的对象也转义');
  });

  // ── 11d html 助手只能作模板标签调用 ──────────────────────────────────────────────────────────
  test(`${T_TAG}——html 不能被当普通函数调用：普通数组 / 字符串 / 未冻结 / 段数与插值数不符都抛 500；作为模板标签正常工作`, async () => {
    const { html, toText } = getMods().sheet._internals;
    const is500 = (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL';
    assert.throws(() => html(['<x>']), is500, '普通数组');
    assert.throws(() => html('<x>'), is500, '字符串');
    assert.throws(() => html(Object.freeze(['<x>'])), is500, '冻结但没有 raw');
    assert.throws(() => html(undefined), is500, 'undefined');
    assert.throws(() => html(null), is500, 'null');
    const forged = ['<a>', '</a>'];
    forged.raw = ['<a>', '</a>'];
    Object.freeze(forged);
    assert.throws(() => html(forged), is500, '段数与插值数不符（2 段 0 个插值）');
    assert.throws(() => html(forged, 'x', 'y'), is500, '段数与插值数不符（2 段 2 个插值）');
    // raw 未冻结的伪造数组：strings 冻结、段数也对，只差 raw 冻结这一条（html`` 字面量产生的 raw 一定是冻结的）
    const forged2 = ['<a>', '</a>'];
    forged2.raw = ['<a>', '</a>'];
    Object.freeze(forged2);
    assert.throws(() => html(forged2, 'x'), is500, 'raw 未冻结的伪造模板数组');
    assert.strictEqual(toText(html`<a>${'<'}</a>`), '<a>&lt;</a>', '模板标签调用正常');
    assert.strictEqual(toText(html`<p></p>`), '<p></p>', '无插值的模板标签调用正常');
    // 片段不可伪造（M2）：片段是冻结空对象，没有任何自有属性（含 Symbol 键）；手工对象、带同名属性的对象、JSON 解析出来的对象都只是被转义的普通值
    const frag = html`<b>${'x'}</b>`;
    assert.deepStrictEqual([Object.getOwnPropertySymbols(frag), Object.getOwnPropertyNames(frag), Object.isFrozen(frag)], [[], [], true], '片段不带 Symbol 键与任何可读属性');
    // 片段拿不到类这个把手：原型为 null、constructor 读不到；冻结后改原型 / 加属性都失败
    assert.strictEqual(Object.getPrototypeOf(frag), null, '片段原型为 null');
    assert.strictEqual(frag.constructor, undefined, '片段上读不到 constructor');
    assert.throws(() => Object.setPrototypeOf(frag, {}), TypeError, '冻结片段不能改原型');
    assert.throws(() => { frag.x = 1; }, TypeError, '冻结片段不能加属性');
    assert.throws(() => Object.defineProperty(frag, 'x', { value: 1 }), TypeError, '冻结片段不能 defineProperty');
    // 用片段原型造出来的「假片段」（null 原型的普通对象）不是片段：toText 抛 500，插值时 String() 抛 TypeError（不会被当成片段原样输出）
    const fake = Object.create(Object.getPrototypeOf(frag));
    assert.throws(() => toText(fake), is500, '假片段 toText 抛 500');
    assert.throws(() => html`${fake}`, TypeError, '假片段当插值：不被当成片段（String 转换失败），不会原样输出');
    // 改写 _internals 上能拿到的导出（esc / toText / html / maps 里的映射）：页面是模块内部引用渲染的，转义与映射不受影响（只在进程内夹具验证：实例模式里页面由服务进程渲染）
    if (T.getFixedToday && T.getFixedToday()) {
      const I = getMods().sheet._internals;
      const saved = { esc: I.esc, toText: I.toText, html: I.html, revisionStatus: I.maps.revisionStatus, method: I.maps.method };
      const sc = await mkPendingScene();
      await sqlRun('UPDATE sysbuild_projects SET system_name = ? WHERE id = ?', [`${X_SCRIPT}${X_ATTR}`, sc.pid]);
      try {
        I.esc = (v) => String(v);
        I.toText = () => '';
        I.html = () => '';
        I.maps.revisionStatus = () => 'HACKED';
        I.maps.method = () => 'HACKED';
        const r = await sheet(U.pm, sc.pv);
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(!r.text.includes(X_SCRIPT) && !r.text.includes(X_ATTR), '改写导出的 esc / html / toText 之后，项目名里的注入串仍被转义');
        assert.ok(r.text.includes(`${E_SCRIPT}${E_ATTR}`), '转义形式仍在');
        assert.ok(!r.text.includes('HACKED') && r.text.includes('待确认'), '改写导出的映射函数不影响页面');
      } finally {
        I.esc = saved.esc; I.toText = saved.toText; I.html = saved.html; I.maps.revisionStatus = saved.revisionStatus; I.maps.method = saved.method;
      }
    }
    assert.strictEqual(toText(html`${{}}`), '[object Object]', '手工 {} 不是片段');
    assert.strictEqual(toText(html`${Object.freeze({})}`), '[object Object]', '手工冻结的 {} 也不是片段');
    for (const key of ['safe', 'html', 'text', '__safe', 'safeHtml']) {
      assert.strictEqual(toText(html`${{ [key]: '<b>' }}`), '[object Object]', `带同名属性 ${key} 的对象不是片段`);
    }
    assert.strictEqual(toText(html`${{ [Symbol.for('safeHtml')]: '<b>' }}`), '[object Object]', '带全局 Symbol 键的对象不是片段');
    assert.strictEqual(toText(html`${JSON.parse('{"safe":"<b>"}')}`), '[object Object]', 'JSON 解析出来的对象不是片段');
    assert.strictEqual(toText(html`${[{ safe: '<i>' }, frag]}`), '[object Object]<b>x</b>', '数组里：普通对象转义、片段原样');
    // toText 只接受片段：其余一律 500
    for (const bad of [{}, '<b>', null, undefined, 5, [frag], { safe: '<b>' }, Object.freeze({})]) {
      assert.throws(() => toText(bad), is500, `toText(${typeof bad}) 应抛 500`);
    }
  });

  // ── 11f 钉钉卡片确认（受控写库）─────────────────────────────────────────────────────────────
  test(`${T_CARD}（受控写库：覆盖存量合法值，生产暂无 card 写入口（C10））——card 确认记录：data-method=card、方式「钉钉卡片」、有操作人与时间，不含平台勾选声明与代录字段`, async () => {
    const s = await mkPendingScene();
    const t = s.tasks[0];
    // 合法 card 记录（schema CHECK：task_revision_id 非空、actor_user_id / card_instance_id / dingtalk_user_id 非空；card 没有 view_id / checkbox_text / 代录字段）
    await sqlRun(
      "INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, card_instance_id, dingtalk_user_id) VALUES (?, 'package_version', ?, ?, 'card', 'confirm', 9001, 'dt-user-own')",
      [t.rev_id, s.pv, U.own]
    );
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'confirmed' WHERE id = ?", [t.rev_id]);
    const body = await sheetOk(U.pm, s.pv);
    const rows = rowsBy(sectionOf(body, 'sec-confirmers'), 'data-task-id');
    assert.deepStrictEqual(rows.map((r) => [r.attrs['task-id'], r.attrs.method, r.attrs.decision]), [[String(t.task_id), 'card', 'confirm'], [String(s.tasks[1].task_id), 'none', 'none']]);
    const card = rows[0].text;
    assert.ok(card.includes('方式： 钉钉卡片') && card.includes('决策：确认') && card.includes('已确认'), `card 行的方式文字：${card}`);
    assert.ok(card.includes(`操作人：${await nameOf(U.own)}`), `card 行有操作人：${card}`);
    assert.ok(/时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(card), `card 行有时间：${card}`);
    for (const bad of ['方式： 平台确认', '方式： 代录', '勾选声明', CHECKBOX, '外部确认日期', '实际确认人', '身份依据', '录入人', '凭据附件']) {
      assert.ok(!card.includes(bad), `card 行不含「${bad}」：${card}`);
    }
    const app = rowsBy(sectionOf(body, 'sec-appendix'), 'data-appendix-revision-id');
    assert.ok(app[0].text.includes('钉钉卡片 · 确认'), `附录摘要带方式：${app[0].text}`);
  });

  // ── 12 映射兜底 ──────────────────────────────────────────────────────────────────────────────
  test(`${T_MAP}——各代码 → 中文映射：手写全表逐项核对；表外值（含 null / undefined / 数字）一律抛 500 SYSBUILD_INTERNAL；版本状态徽标与时间格式同样 fail-closed`, async () => {
    const { maps, badgeText, fmtTime } = getMods().sheet._internals;
    const full = {
      packageType: [['initiation', '立项包'], ['overall', '总体规划包'], ['batch_accept', '批次验收包'], ['closing', '结项包']],
      form: [['overall', '总体'], ['overall_batch_req', '单批合并']],
      revisionStatus: [['pending', '待确认'], ['confirmed', '已确认'], ['objected', '有异议'], ['rejected', '不认可'], ['invalid', '已失效'], ['superseded', '已替代']],
      method: [['platform', '平台确认'], ['card', '钉钉卡片']],
      decision: [['confirm', '确认'], ['object', '有异议'], ['reject', '不认可']],
      purpose: [['package_confirm', '内容包确认']],
      layer: [['project', '项目层'], ['batch', '批次层']],
    };
    for (const [name, pairs] of Object.entries(full)) {
      for (const [code, zh] of pairs) assert.strictEqual(maps[name](code), zh, `${name}(${code})`);
      for (const bad of ['bogus', '', 'PROXY', ' proxy', 'toString', '__proto__', null, undefined, 1, {}]) {
        assert.throws(() => maps[name](bad), (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL', `${name}(${String(bad)}) 应抛 500`);
      }
    }
    // 全部确认方式 / 修订状态枚举都有映射（与 schema 的枚举全等，手写）
    assert.deepStrictEqual(['platform', 'card'].map(maps.method), ['平台确认', '钉钉卡片']);
    // 身份：依据任职 → 负责人；依据授权 → 代表人；都没有 → 「—」并说明；两者都有 → 500
    assert.strictEqual(maps.identity({ basis_appointment_id: 5, basis_delegation_id: null }), '负责人');
    assert.strictEqual(maps.identity({ basis_appointment_id: null, basis_delegation_id: 7 }), '代表人');
    assert.ok(maps.identity({ basis_appointment_id: null, basis_delegation_id: null }).startsWith('—'));
    assert.throws(() => maps.identity({ basis_appointment_id: 5, basis_delegation_id: 7 }), (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL');
    // 版本状态徽标
    assert.strictEqual(badgeText({ status: 'pending', effective_at: null }), '待确认 · 未生效');
    assert.strictEqual(badgeText({ status: 'effective', effective_at: '2026-11-02 10:30:45' }), '已生效 · 生效时间 2026-11-02 10:30');
    assert.strictEqual(badgeText({ status: 'superseded', effective_at: '2026-11-02 10:30:45' }), '已被替代 · 曾于 2026-11-02 10:30 生效');
    assert.strictEqual(badgeText({ status: 'superseded', effective_at: null }), '已被替代 · 未生效（撤回或被新版本替代）');
    for (const bad of ['draft', 'bogus', null, undefined]) {
      assert.throws(() => badgeText({ status: bad, effective_at: null }), (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL', `徽标(${String(bad)}) 应抛 500`);
    }
    // 时间：到分钟；只有日期原样；空 → 空串；其余格式 500
    assert.strictEqual(fmtTime('2026-10-25 09:08:07'), '2026-10-25 09:08');
    assert.strictEqual(fmtTime('2026-10-25 09:08'), '2026-10-25 09:08');
    assert.strictEqual(fmtTime('2026-10-25'), '2026-10-25');
    assert.deepStrictEqual([fmtTime(null), fmtTime(undefined), fmtTime('')], ['', '', '']);
    for (const bad of ['2026/10/25', '2026-10-25T09:08:07', 'abc', 20261025, '2026-10-25 9:08']) {
      assert.throws(() => fmtTime(bad), (e) => e && e.status === 500 && e.code === 'SYSBUILD_INTERNAL', `时间(${String(bad)}) 应抛 500`);
    }
  });

  // ── 13 actions 同源 ──────────────────────────────────────────────────────────────────────────
  test(`${T_ACTIONS}——版本详情 actions.export_sheet 与导出端点同一判定：草稿假、待确认 / 已生效 / 已被替代真；每个状态下标志为真 ⇔ 导出 200；只读账号可见即真`, async () => {
    const m = await mixedScene();
    const p = await pendingScene();
    const dpid = await newProject();
    const draft = await mkVersion(await mkPackage(dpid, 'initiation'));
    const wd = await mkPendingScene();
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${wd.pv}/withdraw`, { reason: '撤回测试原因' })).status, 200);
    const cases = [[draft, 'draft', false], [p.pv, 'pending', true], [m.pv, 'effective', true], [wd.pv, 'superseded', true]];
    for (const [vid, status, expected] of cases) {
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [vid])).status, status, '前置：版本状态');
      for (const uid of [U.pm, U.admin]) {
        const d = await get(uid, `/sysbuild/package-versions/${vid}`);
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(d.body.actions.export_sheet, expected, `${status} 的 export_sheet`);
        assert.strictEqual((await sheet(uid, vid)).status === 200, expected, `${status}：标志与导出结果一致`);
      }
    }
    // 只读账号（非成员）：可见即真（待确认版本）
    const ro = await get(U.ro, `/sysbuild/package-versions/${p.pv}`);
    assert.strictEqual(ro.status, 200, ro.text);
    assert.strictEqual(ro.body.actions.export_sheet, true);
    // 标志是读动作，不随项目状态变化：已暂停 / 已终止项目的待确认版本仍可导出（只读不写）
    const q = await mkPendingScene();
    const st = await post(U.admin, `/sysbuild/projects/${q.pid}/status`, { to: 'paused', reason: '确认单用例' });
    assert.strictEqual(st.status, 200, st.text);
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${q.pv}`)).body.actions.export_sheet, true);
    assert.strictEqual((await sheet(U.pm, q.pv)).status, 200, '已暂停项目可导出');
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次。
const sm = (id, expect, file, from, to) => ({ id: `C4c 确认单：${id}`, expect, edits: [{ file, from, to }] });
const CSP_LINE = "    res.setHeader('Content-Security-Policy', \"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\");\n";
const NOSNIFF_LINE = "    res.setHeader('X-Content-Type-Options', 'nosniff');\n";
const SHEET_MUTATIONS = [
  sm('去掉草稿 409（端点不再拦草稿）', [T_DRAFT], 'confirmation-sheet.js', 'if (!rules.canExportConfirmationSheet(access, ver)) {', 'if (false) {'),
  sm('可导出集合多收草稿（rules 白名单）', [T_DRAFT, T_ACTIONS], 'rules.js', "Object.freeze(['pending', 'effective', 'superseded'])", "Object.freeze(['draft', 'pending', 'effective', 'superseded'])"),
  sm('去掉项目可见性判定（assertVisible）', [T_PARAM], 'confirmation-sheet.js', 'rules.assertVisible(access);', ''),
  sm('转义助手不转义双引号', [T_ESC], 'confirmation-sheet.js', "'\"': '&quot;',", "'\"': '\"',"),
  sm('转义助手不转义单引号', [T_ESC], 'confirmation-sheet.js', "\"'\": '&#39;',", "\"'\": \"'\","),
  sm('正文取第一条修订而不是当前修订', [T_SUPER], 'confirmation-sheet.js', 'const cur = await core.latestRevision(q, t.id);',
    "const cur = (await q.all('SELECT id, task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, status_reason, created_by, created_at, updated_at FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no LIMIT 1', [t.id]))[0];"),
  {
    id: 'C4c 确认单：遮蔽时输出原名（渲染分支与附件视图两层都拆掉）',
    expect: [T_MASK],
    edits: [
      { file: 'confirmation-sheet.js', from: 'if (a.masked) {\n    return html', to: 'if (false) {\n    return html' }, // 附件视图补遮蔽原因的函数里也有 if (a.masked) {，锚点带上后一行才唯一
      { file: 'confirm-core.js', from: 'name: a ? attachmentDisplayName(a) : null,', to: 'name: a ? a.original_name : null,' },
    ],
  },
  sm('去掉 Content-Security-Policy 头', [T_HEAD], 'confirmation-sheet.js', CSP_LINE, ''),
  sm('去掉 X-Content-Type-Options: nosniff 头', [T_HEAD], 'confirmation-sheet.js', NOSNIFF_LINE, ''),
  sm('端点里写一条浏览记录（不再纯读）', [T_READ], 'confirmation-sheet.js', 'const model = await db.withRead((q) => loadModel(q, vid, req.user, now));',
    "const model = await db.withRead(async (q) => {\n      const mm = await loadModel(q, vid, req.user, now);\n      await q.run(\"INSERT INTO sysbuild_views (user_id, object_type, object_version_id, source, frozen_attachment_set) VALUES (?, 'package_version', ?, 'page', '[]')\", [Number(req.user.id), vid]);\n      return mm;\n    });"),
  sm('versionActions.export_sheet 不再调用同源判定（恒真）', [T_ACTIONS], 'packages.js', 'export_sheet: rules.canExportConfirmationSheet(access, ver),', 'export_sheet: true,'),
  sm('映射兜底改为原样返回', [T_MAP], 'confirmation-sheet.js', "if (typeof key !== 'string' || !hasKey(table, key)) throw internalError(`${what}未登记`);", "if (typeof key !== 'string' || !hasKey(table, key)) return key;"),
  sm('SHA-256 只显示前 16 位', [T_MIXED, T_MASK], 'confirmation-sheet.js', 'out.push(Object.assign({}, a, { mask_reason: reason }));', 'out.push(Object.assign({}, a, { mask_reason: reason, sha256: String(a.sha256).slice(0, 16) }));'),
  sm('被撤回的版本徽标写成「曾于 生效」', [T_SUPER], 'confirmation-sheet.js', 'return ver.effective_at ? `已被替代', 'return true ? `已被替代'),
  sm('附录只列最新一条修订', [T_SUPER], 'confirmation-sheet.js', 'WHERE task_id = ? ORDER BY rev_no`,', 'WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1`,'),
  // ── 预筛修订批（A–C）新增 ──
  // C3f（codex 120 H）：M895 重新登记，挂 T_MIXED 的旧代录行可见方式名断言；锚点是当前明细渲染语句
  sm('html 助手不再校验调用形态', [T_TAG], 'confirmation-sheet.js', "if (!(Array.isArray(strings) && Array.isArray(strings.raw) && Object.isFrozen(strings) && Object.isFrozen(strings.raw) && strings.length === vals.length + 1)) throw internalError('html 只能作为模板标签调用');", ''),
  // ── codex 23 / 预筛复看修订批新增 ──
  { // M2：isSafe 改回「带某键的对象也算片段」
    id: 'C4c 确认单：isSafe 把带同名属性的普通对象也当片段',
    expect: [T_TAG],
    edits: [
      { file: 'confirmation-sheet.js', from: 'const isSafe = (v) => fragIs(v);', to: "const isSafe = (v) => fragIs(v) || (v !== null && typeof v === 'object' && hasKey(v, 'safe'));" },
      { file: 'confirmation-sheet.js', from: 'if (isSafe(v)) return fragText(v);', to: 'if (isSafe(v)) return fragIs(v) ? fragText(v) : v.safe;' },
    ],
  },
  sm('片段不再把原型设为 null（constructor 可达）', [T_TAG], 'confirmation-sheet.js', '    Object.setPrototypeOf(this, null);\n', ''),
  sm('html 助手不再校验 raw 已冻结', [T_TAG], 'confirmation-sheet.js', 'Object.isFrozen(strings) && Object.isFrozen(strings.raw) && strings.length', 'Object.isFrozen(strings) && strings.length'),
  sm('card 确认显示平台勾选声明', [T_CARD], 'confirmation-sheet.js', "if (c.method === 'platform') lines.push(", "if (c.method === 'platform' || c.method === 'card') lines.push("),
  sm('card 确认漏掉操作人', [T_CARD], 'confirmation-sheet.js', "if (c.method === 'platform' || c.method === 'card') {", "if (c.method === 'platform') {"),
  sm('非总体规划包跳过节点计划节时序号跳号', ['L3 留痕：立项依据确认单——选入立项节点材料冻结版与声明同时展示'], 'confirmation-sheet.js', "section('sec-plans', '节点计划快照', renderPlans(m.plans)) : ''}", "section('sec-plans', '节点计划快照', renderPlans(m.plans)) : (no++, '')}"),
];

module.exports = { defineSheetCases, SHEET_MUTATIONS };
