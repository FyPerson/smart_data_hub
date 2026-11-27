'use strict';
// 信息化资产主题计算样式检查（#200 C1a，方案 v1.4 第八节 / 7.1 C1a 行 / 启动门 L2）。真实浏览器、1440 宽、夹具自建临时库与安全端口（不碰 3000）。
// 期望值是下面手写的字面量表（取自方案 3.2 / 3.3 的色值换算成 rgb），不从被测页面读出再比对自身。唯一的例外（fix3，fix2 预筛 LOW-3；fix4 按实情改写）：证据查看器里次按钮的静止态 / 悬停态期望值读自真实工作台的 .u-btn-secondary：
// 静止态（`workbench`）取机柜页第一个 `.itl-workbench .u-btn-secondary`，与「次按钮：白底、控件边线、主文字色」那条字面量断言用的是同一选择器、但不是同一个页面，所以那条字面量并不直接钉住它；
// 悬停态（`realSecondaryHover`）在全部资产页读，三项（背景 / 字色 / 上边框色）都由「次按钮悬停（三项）」那条字面量断言钉住。
//   页面底、内容区白纸（底 / 圆角 / 边 / 无阴影）、侧栏（透明、无右边线、选中项底与字色）、主按钮（底、悬停）、次按钮（底、边、悬停）、
//   表头（无底色、字色、字重、下边线）、表格行悬停、输入框边与焦点环、四组覆盖后的状态徽章（active / staging / archived / done 各取真实渲染的徽章）、
//   沿用全站值的 sem-failed / sem-hold 未被覆盖、平台顶栏与 body / :root 上的变量未被污染、机柜设备块、挂 body 的浮层（机柜 / 硬件 / 证据查看器 / 弹窗 / 提示条）拿到覆盖值。
//   C1b（#200 C1b-1，方案 3.5 / 3.6；fix1 扩面）：1440 宽下「已扫视图」内的实际计算字号只许五档（五档外逐条登记在 FONT_EXCEPTIONS，清单外出现 / 清单条目过期都判红）；已扫视图 = SCANNED_VIEWS 手写清单（22 个：
//   库房 / 终端 / 全部资产 / 详情抽屉 / 登记弹窗 / 软件与订阅 / 机柜总览 / 机柜正视图 / 硬件浮层 / AP 平面图 / 盘点列表与详情 / 对账列表与有条目的报告 / 巡检列表与已提交单详情 / 填写页六段），
//   不是「模块内全部视图」，清单之外的视图不在断言范围内；模块容器内每个元素及其 ::before / ::after 的 backgroundImage / maskImage 不含 gradient（同一批视图各扫一遍）；
//   字号基线（it-ledger-theme.css 的零特异性 :where 规则）在六个容器里对无类名的 small / button 生效、容器外（body 直下、平台顶栏）不生效；
//   U 线是 42 条 1px 细线元素（层级用「U 线临时可命中 + 逐像素取点」证明）、空柜 / 121U 柜各有用例、AP 点阵是 ::before 的 SVG 遮罩；AP 点位圆点 box-shadow 为 none；
//   卡片没有 .itl-card-icon；详情抽屉头没有 .itl-eyebrow；1U 正视图设备 scrollHeight ≤ clientHeight；42U 柜 T01 总览里的设备块 title 带 IP 且名称与正视图同源、块高钉住（手写清单全等）、名称元素计算字号恰为 12px 且行高为 px 值不小于字号。
// 残余：总览设备块名称与 IP 行的可见高度（裁切）不再做几何测量，42U 柜也一样；已删除的是 60U、90U 高机柜夹具（生产为 42U）与总览设备块名称 / IP 行的裁切测量断言（121U 夹具与 U 线属性断言保留）。42U 柜 T01 设备块的 title 与块高（U 数 × 14px）、名称的计算字号与行高、名称文本仍检查。
const assert = require('assert/strict'), fs = require('fs');
const { chromium } = require('playwright');
const xlsx = require('xlsx');
const { createFixture } = require('./it-ledger-browser-fixture');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5kAAAAASUVORK5CYII=', 'base64');

const RGB = {
  pageBg: 'rgb(238, 242, 245)', white: 'rgb(255, 255, 255)', border: 'rgb(232, 234, 236)', controlBorder: 'rgb(205, 206, 209)',
  textPrimary: 'rgb(19, 20, 22)', textSecondary: 'rgb(93, 95, 96)', elevated: 'rgb(244, 246, 248)',
  navActive: 'rgb(225, 231, 236)', primary: 'rgb(29, 31, 32)', primaryHover: 'rgb(0, 0, 0)', accent: 'rgb(27, 108, 128)',
  deviceBg: 'rgb(228, 239, 242)', deviceBorder: 'rgb(195, 219, 226)', transparent: 'rgba(0, 0, 0, 0)'
};
// 方案 3.3 表（bg fg bd bds dot）换算
const BADGE = {
  'sem-active':   { bg: 'rgb(235, 237, 238)', fg: 'rgb(53, 55, 54)', bd: 'rgb(235, 237, 238)', bds: 'solid',  dot: 'rgb(138, 141, 144)', deco: 'none' },
  'sem-done':    { bg: 'rgb(235, 237, 238)', fg: 'rgb(53, 55, 54)', bd: 'rgb(235, 237, 238)', bds: 'solid',  dot: 'rgb(138, 141, 144)', deco: 'none' },
  'sem-staging': { bg: 'rgb(255, 255, 255)', fg: 'rgb(53, 55, 54)', bd: 'rgb(205, 206, 209)', bds: 'solid',  dot: 'rgb(154, 157, 160)', deco: 'none' },
  'sem-archived':{ bg: 'rgb(244, 246, 248)', fg: 'rgb(93, 95, 96)', bd: 'rgb(205, 206, 209)', bds: 'dashed', dot: 'rgb(154, 157, 160)', deco: 'none' }
};
// 全站值（components.css 的 :root 定义换算，模块内不覆盖）
const GLOBAL_BADGE = {
  'sem-failed': { bg: 'rgb(254, 242, 242)', fg: 'rgb(185, 28, 28)', bd: 'rgb(252, 165, 165)', bds: 'solid', dot: 'rgb(220, 38, 38)', deco: 'none' },
  'sem-hold':   { bg: 'rgb(254, 252, 232)', fg: 'rgb(133, 77, 14)', bd: 'rgb(254, 240, 138)', bds: 'solid', dot: 'rgb(234, 179, 8)', deco: 'none' }
};
const GLOBAL_DONE = { bg: 'rgb(240, 253, 244)', fg: 'rgb(21, 128, 61)' };
// ---- C1b（#200 C1b-1，方案 v1.4 3.5 / 3.6）：1440 宽下「已扫视图」（SCANNED_VIEWS，见下）内的实际计算字号只许五档；五档之外的逐条登记（手写，清单一变即判红交人核对）----
// 判据：模块容器内每个「有自己文字」的可见元素（以及可见的 input / select / textarea）的计算字号。清单之外出现新字号、或清单里的条目没再出现（过期），都判红。
// 四条都来自共享层 components.css（本次不许改）。模块自有元素原先落在浏览器默认值上的（按钮 13.3333px、small = smaller）由 it-ledger-theme.css 的零特异性基线接住（fix1），不再登记。
const FONT_TIERS = ['12px', '13px', '14px', '16px', '24px'];
const FONT_EXCEPTIONS = [
  { sel: '.u-status-badge', size: '11px', source: 'components.css:197 .u-status-badge', reason: '共享层状态徽章，共享层不许改' },
  { sel: '.u-type-tag', size: '11px', source: 'components.css:133 .u-type-tag', reason: '共享层类型标签（软件与订阅表），共享层不许改' },
  { sel: '.u-hint', size: '11px', source: 'components.css:50 .u-hint', reason: '共享层提示句（巡检页），共享层不许改' },
  { sel: '.u-modal-footer button', size: '15px', source: 'components.css:365 .u-modal-footer button', reason: '共享层弹窗底部按钮，共享层不许改' }
];
// 已扫视图清单（手写，fix1）：字号扫描与渐变扫描各把这些视图按这个顺序扫一遍；清单是「已扫」的全部，不等于「模块内全部视图」。
// 没扫的视图：机柜 / 硬件弹窗里除上面步骤之外的操作面板状态、各类报错 / 空状态提示。真实照片查看器（巡检单照片，inspection-sheets.js 创建，在用）字号也未在本脚本里扫：
// 它的内容只有一个次按钮与一张图，颜色（主题变量与次按钮）由 verify-it-ledger-photo-collections.js 在真实打开的查看器上覆盖；设备巡检附件那一处创建（evidence.js）是死组件，由面板静态检查看住。
const SCANNED_VIEWS = ['库房', '终端', '全部资产', '详情抽屉', '登记弹窗', '软件与订阅', '机柜总览', '机柜正视图', '硬件浮层', 'AP 平面图', '盘点列表', '盘点详情', '对账列表', '对账报告（有条目）', '巡检列表', '已提交巡检单详情',
  '填写页·基本信息', '填写页·机房环境', '填写页·机柜检查', '填写页·服务器与存储', '填写页·总体备注', '填写页·核对提交'];

// ---- 终值轮询（修复批 4 M-3）：只有「读到期望值并连续保持满 holdMs」才返回；超时直接抛错，错误信息含最后读数与已保持时长 ----
// 共享层 .u-btn-primary 带 opacity 过渡，坏实现在过渡起点会短暂等于期望值，随后落到 0.9。now / sleep 可注入，供下面不起浏览器的自检用假时钟驱动。
async function stableHold(read, expected, opts = {}) {
  const holdMs = opts.holdMs === undefined ? 450 : opts.holdMs, timeoutMs = opts.timeoutMs === undefined ? 4000 : opts.timeoutMs, stepMs = opts.stepMs === undefined ? 50 : opts.stepMs;
  const now = opts.now || Date.now, sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const want = JSON.stringify(expected), t0 = now(); let since = null, v;
  for (;;) {
    v = await read();
    const t = now();
    if (JSON.stringify(v) === want) { if (since === null) since = t; if (t - since >= holdMs) return v; } else since = null;
    if (t - t0 > timeoutMs) throw new Error('stableHold: not stable within ' + timeoutMs + 'ms; last reading ' + JSON.stringify(v) + ' (expected ' + want + '), held ' + (since === null ? 0 : t - since) + 'ms of the required ' + holdMs + 'ms');
    await sleep(stepMs);
  }
}
// 不起浏览器的自检：假时钟 + 假读数函数。①一直等于期望 → 成功；②临近超时才等于期望、保持不足 450ms → 失败；③从不等于 → 失败；④中途掉出期望值会重新计时（先短暂等于、掉出、后来才稳定 → 成功且发生在重新计时之后）
async function selfCheckStableHold() {
  const run = async series => { // series(t) → 假时刻 t（毫秒）的读数
    let t = 0;
    try { const v = await stableHold(async () => series(t), 'X', { now: () => t, sleep: async ms => { t += ms; } }); return { ok: true, at: t, value: v }; }
    catch (e) { return { ok: false, at: t, message: e.message }; }
  };
  const results = {};
  results['1 always equal'] = await run(() => 'X');
  assert.deepEqual(results['1 always equal'], { ok: true, at: 450, value: 'X' }, 'always equal: succeeds exactly when the hold is full');
  results['2 equal only near the timeout'] = await run(t => (t >= 3800 ? 'X' : 'Y'));
  assert.equal(results['2 equal only near the timeout'].ok, false, 'equal only near the timeout (held < 450ms): must fail');
  assert.ok(/last reading "X".*held 250ms of the required 450ms/.test(results['2 equal only near the timeout'].message), results['2 equal only near the timeout'].message);
  results['3 never equal'] = await run(() => 'Y');
  assert.equal(results['3 never equal'].ok, false, 'never equal: must fail');
  assert.ok(/last reading "Y".*held 0ms of the required 450ms/.test(results['3 never equal'].message), results['3 never equal'].message);
  results['4 flicker then stable'] = await run(t => ((t < 300 || t >= 1000) ? 'X' : 'Y'));
  assert.deepEqual(results['4 flicker then stable'], { ok: true, at: 1450, value: 'X' }, 'a dip resets the hold timer: success only after 450ms of the second run');
  for (const [k, r] of Object.entries(results)) console.log('[SELF] stableHold ' + k + ' => ' + JSON.stringify(r));
  console.log('[OK] stableHold self-check (no browser): 4/4');
}

async function main() {
  await selfCheckStableHold();
  if (process.argv.includes('--self-check-only')) return;
  const f = await createFixture({ cleanup: true });
  let browser, pass = 0;
  const check = (label, ok, detail) => { assert.ok(ok, label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail))); pass++; console.log('[OK] ' + label); };
  const same = (label, actual, expected) => { assert.deepEqual(actual, expected, label); pass++; console.log('[OK] ' + label + ' = ' + JSON.stringify(actual)); };
  const api = async (method, url, body, status = 200, user = 1) => { const r = await f.api(method, url, body, user); assert.equal(r.status, status, method + ' ' + url + ' ' + JSON.stringify(r.body)); return r.body; };
  try {
    // ---- 造数：每种要断言的状态各一件 ----
    // 窄屏吸顶侧栏检查要先滚动 700px，列表得足够长（否则 scrollTo 被夹回 0，检查空转）；填充件最先建（id 最小），默认按 id 倒序排在后面，不挤掉下面要断言的行。
    for (let k = 1; k <= 30; k++) await api('POST', '', { category: 'laptop', name: '填充笔记本' + k, placement: { kind: 'depot' } }, 201);
    const rack = await api('POST', '/racks', { room: '示例机房', name: 'T01', u_total: 42 }, 201);
    const host = await api('POST', '', { category: 'server', name: '主题检查服务器', u_height: 2, slot_count: 4, attrs: { ip: '192.0.2.1', purpose: '业务应用', os: 'Windows Server' }, placement: { kind: 'rack', rack_id: rack.id, u_start: 3 } }, 201);
    // C1b：1U 设备（正视图 28px 行高放得下 12px 名称与 IP 的断言对象）+ 一层楼一间房一台 AP（AP 平面图点阵与点位断言对象）
    await api('POST', '', { category: 'server', name: '主题检查1U', u_height: 1, attrs: { ip: '192.0.2.9' }, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 } }, 201);
    await api('PUT', '/floors/F1', { name: 'F1', rooms: [{ id: 'bottom', name: '机房一', w: 12, h: 8 }] });
    const apAsset = await api('POST', '', { category: 'ap', name: '主题检查AP', attrs: { mgmt_ip: '192.0.2.31' }, placement: { kind: 'depot' } }, 201);
    await api('POST', '/' + apAsset.id + '/actions/ap_place', { expected_version: apAsset.version, floor_id: 'F1', room_id: 'bottom', pos: { x: 0.4, y: 0.4 } });
    await api('POST', '', { category: 'laptop', name: '库房笔记本', placement: { kind: 'depot' } }, 201);
    await api('POST', '', { category: 'desktop', name: '在用终端', placement: { kind: 'custodian', custodian_name: '测试人员', location_text: '办公区' } }, 201);
    // mark_status 只允许库房系状态（in_depot / faulty / to_retire）：故障、待报废、已报废三件都从库房笔记本推进
    const faulty = await api('POST', '', { category: 'laptop', name: '故障笔记本', placement: { kind: 'depot' } }, 201);
    await api('POST', '/' + faulty.id + '/actions/mark_status', { expected_version: faulty.version, status: 'faulty' });
    const hold = await api('POST', '', { category: 'laptop', name: '待报废笔记本', placement: { kind: 'depot' } }, 201);
    await api('POST', '/' + hold.id + '/actions/mark_status', { expected_version: hold.version, status: 'to_retire' });
    const retired = await api('POST', '', { category: 'laptop', name: '已报废笔记本', placement: { kind: 'depot' } }, 201);
    await api('POST', '/' + retired.id + '/actions/mark_status', { expected_version: retired.version, status: 'to_retire' });
    const retiredNow = (await api('GET', '/' + retired.id)).asset;
    await api('POST', '/' + retired.id + '/actions/retire', { expected_version: retiredNow.version });
    await api('POST', '', { category: 'subscription', name: '远期订阅', expires_at: '2030-01-01' }, 201);
    // fix2 LOW-3：名称带「【采集告警】」前缀的设备（放在 T01 里，正视图可见）：总览 title 与正视图 title 的名称部分都要是去前缀后的名称。
    await api('POST', '', { category: 'server', name: '【采集告警】主题检查告警二U', u_height: 2, attrs: { ip: '192.0.2.10' }, placement: { kind: 'rack', rack_id: rack.id, u_start: 6 } }, 201);
    // C1b fix1：L-4 的机柜夹具（空柜；121U 柜不生成 U 线）。名称排在 T01 之后，不改变 T01 作为第一个机柜的前提（下面按 id 取柜，不按顺序）。
    const rackEmpty = await api('POST', '/racks', { room: '示例机房', name: 'T02空柜', u_total: 42 }, 201);
    const rack121 = await api('POST', '/racks', { room: '示例机房', name: 'T121', u_total: 121 }, 201);
    // C1b fix1（H-1 补扫视图）：已提交巡检单（详情页）、盘点批次（详情）、有条目的对账批次（报告）。提交单据要求每个有设备的机柜都有正面照片。
    const uploadPhoto = async (sheetId, rackId) => {
      const data = new FormData(); data.append('slot', 'rack_front'); data.append('target_id', String(rackId)); data.append('file', new Blob([PNG], { type: 'image/png' }), '现场.png');
      const r = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-2' }, body: data });
      assert.equal(r.status, 201, 'photo upload ' + r.status);
    };
    let submittedSheet = await api('POST', '/inspections/sheets', { room_name: '示例机房' }, 201, 2);
    submittedSheet = await api('PUT', '/inspections/sheets/' + submittedSheet.id, { expected_version: submittedSheet.version, items: submittedSheet.items.map(it => ({ id: it.id, result: it.value_kind === 'number' ? null : 'ok', number_value: it.value_kind === 'number' ? (it.item_key === 'temperature' ? 23 : 48) : null, note: null })) }, 200, 2);
    for (const r of [rack, rackEmpty, rack121]) await uploadPhoto(submittedSheet.id, r.id); // 同机房的每个机柜（含空柜）都要有正面照片
    submittedSheet = await api('POST', '/inspections/sheets/' + submittedSheet.id + '/submit', { expected_version: submittedSheet.version }, 200, 2);
    assert.equal(submittedSheet.status, 'submitted');
    const stock = await api('POST', '/stocktakes', { title: '主题检查盘点', scope: { categories: ['server'] } }, 201);
    await api('POST', '', { category: 'other', name: '对账检查设备', asset_no: 'THEME-100', placement: { kind: 'depot' } }, 201);
    const reconcileFile = new FormData();
    { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['编号', '资产名称', '部门', '设备名称', '品牌', '型号', '购置日期', '购置金额', '数量', '责任人', '备注'], ['THEME-100', '对账检查设备'], ['THEME-NOPE', '册面独有设备']]), '固定资产'); reconcileFile.append('file', new Blob([xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'theme.xlsx'); }
    const reconcileRes = await fetch(f.base + '/api/it-assets/reconciles', { method: 'POST', headers: { Authorization: 'Bearer fixture-1' }, body: reconcileFile });
    const reconcile = await reconcileRes.json(); assert.equal(reconcileRes.status, 201, JSON.stringify(reconcile));
    // 填写页(page2)的草稿放在最后建：同一机房已有提交单不影响再建草稿
    const sheet = await api('POST', '/inspections/sheets', { room_name: '示例机房' }, 201, 2);

    browser = await chromium.launch({ headless: true });
    // 修复批 1 的红→绿证明用：ITL_THEME_CSS_BEFORE=<css 文件> 时，浏览器侧用该文件顶替线上的 it-ledger-theme.css（只拦截浏览器请求，不动工作区文件）；正常运行不设。
    // fix2 扩展：同一机制再加 ITL_BASE_CSS_BEFORE（顶替 it-ledger.css）与 ITL_RACKS_JS_BEFORE（顶替 it-ledger-racks.js），供新判据的「改前会红」证据用；同样一律不判绿。
    const OVERRIDES = [['ITL_THEME_CSS_BEFORE', /it-ledger-theme\.css/, 'text/css'], ['ITL_BASE_CSS_BEFORE', /\/it-ledger\.css/, 'text/css'], ['ITL_RACKS_JS_BEFORE', /it-ledger-racks\.js/, 'application/javascript']]
      .filter(([env]) => process.env[env]).map(([env, re, type]) => [env, re, type, fs.readFileSync(process.env[env], 'utf8')]);
    const overrideCss = OVERRIDES.length ? OVERRIDES.map(o => o[0]).join(',') : null;
    const applyOverride = async ctx => { for (const [, re, type, body] of OVERRIDES) await ctx.route(re, route => route.fulfill({ status: 200, contentType: type, body })); };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await applyOverride(context);
    await context.addInitScript(() => localStorage.setItem('token', 'fixture-1'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ready = async () => page.waitForFunction(() => { const c = document.querySelector('#itlContent'); return c && !c.hasAttribute('aria-busy') && !c.textContent.includes('正在读取') && !c.textContent.includes('正在加载'); });
    const style = (selector, props) => page.locator(selector).first().evaluate((el, ps) => { const cs = getComputedStyle(el), out = {}; for (const p of ps) out[p] = cs[p]; return out; }, props);
    const badge = (cls, scope) => page.locator((scope || '') + ' .u-status-badge.' + cls).first().evaluate(el => { const cs = getComputedStyle(el), dot = getComputedStyle(el, '::before'); return { bg: cs.backgroundColor, fg: cs.color, bd: cs.borderTopColor, bds: cs.borderTopStyle, dot: dot.backgroundColor, deco: cs.textDecorationLine }; });

    // ---- 全部资产：外框、侧栏、按钮、表头、输入框 ----
    await page.goto(f.base + '/IT_Ledger.html#all');
    await page.locator('[data-tab="all"][aria-current=page]').waitFor(); await ready(); await page.locator('#itlTable tbody tr').first().waitFor();
    same('1440 宽无页面横向滚动', await page.evaluate(() => document.documentElement.scrollWidth), 1440);
    same('页面底色 body = --itl-page-bg #eef2f5', (await style('body', ['backgroundColor'])).backgroundColor, RGB.pageBg);
    same('内容区白纸：底 / 圆角 / 1px 边 / 无阴影 / 右下内缩 8px', await style('.itl-page', ['backgroundColor', 'borderTopLeftRadius', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'boxShadow', 'marginRight', 'marginBottom']),
      { backgroundColor: RGB.white, borderTopLeftRadius: '16px', borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: RGB.border, boxShadow: 'none', marginRight: '8px', marginBottom: '8px' });
    same('侧栏无底色、无右边线', await style('.itl-sidebar', ['backgroundColor', 'borderRightWidth']), { backgroundColor: RGB.transparent, borderRightWidth: '0px' });
    same('侧栏选中项：#e1e7ec 底、字色 = 主文字色', await style('[data-tab][aria-current=page]', ['backgroundColor', 'color']), { backgroundColor: RGB.navActive, color: RGB.textPrimary });
    same('模块名字色 = 主文字色', (await style('.itl-module-name', ['color'])).color, RGB.textPrimary);

    same('主按钮 #itlRegister：#1d1f20 底、白字', await style('#itlRegister', ['backgroundColor', 'color']), { backgroundColor: RGB.primary, color: RGB.white });
    // 终值轮询（不依赖过渡时长）：读到期望值后还要连续保持 450ms 才算数；超时直接抛错（修复批 4 M-3），不再返回最后读数让调用处比较。见文件顶部 stableHold。
    const holds = async (label, read, expected) => { await stableHold(read, expected, { sleep: ms => page.waitForTimeout(ms) }); pass++; console.log('[OK] ' + label + ' = ' + JSON.stringify(expected)); };
    await page.locator('#itlRegister').hover();
    await holds('主按钮悬停：#000 底且不透明（共享层 .u-btn-primary:hover 的 opacity:.9 被主题盖掉；终值轮询，保持满 450ms）', () => style('#itlRegister', ['backgroundColor', 'opacity']), { backgroundColor: RGB.primaryHover, opacity: '1' });
    await page.mouse.move(5, 5);
    // 禁用的主按钮悬停不得变回全黑 / 全不透明（修复批 2 M-1）：探针挂在 .itl-workbench 内（真实页面上没有稳定存在的禁用主按钮，用探针，结论与真实按钮同一选择器路径）
    await page.evaluate(() => { const b = document.createElement('button'); b.type = 'button'; b.id = 'themeProbeDisabledPrimary'; b.className = 'u-btn u-btn-primary'; b.disabled = true; b.textContent = '禁用探针'; document.querySelector('.itl-page').prepend(b); });
    await page.locator('#themeProbeDisabledPrimary').hover({ force: true });
    await holds('禁用主按钮悬停：保持 opacity .55 与非悬停底色 #1d1f20（不被悬停规则的黑底 / opacity:1 盖掉；终值轮询，保持满 450ms）', () => style('#themeProbeDisabledPrimary', ['backgroundColor', 'opacity']), { backgroundColor: RGB.primary, opacity: '0.55' });
    await page.mouse.move(5, 5);
    await page.evaluate(() => document.getElementById('themeProbeDisabledPrimary').remove());
    const secondary =page.locator('.itl-workbench .u-btn-secondary:visible').first();
    await secondary.waitFor();
    same('次按钮：白底、控件边线、主文字色', await secondary.evaluate(el => { const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, borderTopColor: cs.borderTopColor, color: cs.color }; }),
      { backgroundColor: RGB.white, borderTopColor: RGB.controlBorder, color: RGB.textPrimary });
    await secondary.hover();
    // .u-btn-secondary / .u-corr-table tr 带 background 过渡（0.2s / 0.15s）：轮询到过渡结束再取终值，超时则按最后一次读数判红
    const settled = async (loc, prop, expected) => { let v; for (let k = 0; k < 40; k++) { v = await loc.evaluate((el, p) => getComputedStyle(el)[p], prop); if (v === expected) break; await page.waitForTimeout(50); } return v; };
    same('次按钮悬停：--color-bg-elevated 底', await settled(secondary, 'backgroundColor', RGB.elevated), RGB.elevated);
    // fix2 LOW-5：记下真实工作台次按钮悬停态的三项计算值（上一行已等过渡结束），证据查看器里的次按钮悬停态后面拿它比（那时机柜 / 硬件浮层盖在工作台上，工作台里的按钮悬停不到）。
    const realSecondaryHover = await secondary.evaluate(el => { const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, color: cs.color, borderTopColor: cs.borderTopColor }; });
    // fix4（fix3 预筛 LOW-4）：悬停态三项都用字面量钉住（上一条只钉了背景）；证据查看器里次按钮的悬停期望值（realSecondaryHover）因此不再是「读什么比什么」。
    same('次按钮悬停（三项）：--color-bg-elevated 底、主文字色、控件边线（realSecondaryHover，证据查看器悬停对照的期望值）', realSecondaryHover, { backgroundColor: RGB.elevated, color: RGB.textPrimary, borderTopColor: RGB.controlBorder });
    await page.mouse.move(5, 5);

    same('表头：无底色、12px、常规字重、次要字色、下边 1px #e8eaec', await style('#itlTable thead th', ['backgroundColor', 'color', 'fontSize', 'fontWeight', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']),
      { backgroundColor: RGB.transparent, color: RGB.textSecondary, fontSize: '12px', fontWeight: '400', borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: RGB.border });
    await page.locator('#itlTable tbody tr').first().hover();
    same('表格行悬停：--color-bg-elevated 底', await settled(page.locator('#itlTable tbody tr').first(), 'backgroundColor', RGB.elevated), RGB.elevated);
    await page.mouse.move(5, 5);

    const input = page.locator('.itl-page .itl-toolbar input:visible, .itl-page input[type=search]:visible, .itl-page input[type=text]:visible').first();
    await input.waitFor();
    same('输入框：白底、控件边线', await input.evaluate(el => { const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, borderTopColor: cs.borderTopColor }; }), { backgroundColor: RGB.white, borderTopColor: RGB.controlBorder });
    await input.focus();
    same('输入框焦点环：2px 实线、数据色 #1b6c80', await input.evaluate(el => { const cs = getComputedStyle(el); return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor }; }), { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: RGB.accent });

    // ---- 状态徽章：四组覆盖 + 沿用全站值 ----
    same('在用 sem-active 徽章（表格内真实渲染）', await badge('sem-active', '#itlTable'), BADGE['sem-active']);
    same('库房 sem-staging 徽章', await badge('sem-staging', '#itlTable'), BADGE['sem-staging']);
    same('已报废 sem-archived 徽章（虚线边保留）', await badge('sem-archived', '#itlTable'), BADGE['sem-archived']);
    same('故障 sem-failed 沿用全站值', await badge('sem-failed', '#itlTable'), GLOBAL_BADGE['sem-failed']);
    same('待报废 sem-hold 沿用全站值', await badge('sem-hold', '#itlTable'), GLOBAL_BADGE['sem-hold']);
    await page.goto(f.base + '/IT_Ledger.html#software');
    await page.locator('[data-tab="software"][aria-current=page]').waitFor(); await ready();
    same('软件正常 sem-done 徽章', await badge('sem-done', '.itl-page'), BADGE['sem-done']);

    // ---- 弹窗：登记表单输入框 ----
    await page.goto(f.base + '/IT_Ledger.html#all'); await page.locator('#itlRegister').waitFor(); await ready();
    await page.locator('#itlRegister').click(); await page.locator('#itlModal.open').waitFor();
    same('登记弹窗主操作 #itlSubmit：#1d1f20 底', (await style('#itlSubmit', ['backgroundColor'])).backgroundColor, RGB.primary);
    same('登记弹窗输入框：白底、控件边线', await page.locator('#itlModalBody input:visible, #itlModalBody select:visible').first().evaluate(el => { const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, borderTopColor: cs.borderTopColor }; }), { backgroundColor: RGB.white, borderTopColor: RGB.controlBorder });
    const modalProbe = await page.locator('.itl-modal').evaluate(el => { const s = document.createElement('span'); s.className = 'u-status-badge sem-done'; el.appendChild(s); const r = { bg: getComputedStyle(s).backgroundColor, accent: getComputedStyle(el).getPropertyValue('--color-accent').trim() }; s.remove(); return r; });
    same('弹窗容器 .itl-modal 取到覆盖值', modalProbe, { bg: BADGE['sem-done'].bg, accent: '#1b6c80' });
    await page.locator('#itlModalCancel').click();

    // ---- 平台顶栏与 body / :root 未被污染 ----
    const platform = await page.evaluate(() => {
      const nav = document.querySelector('.navbar'), item = document.querySelector('.navbar .nav-item');
      const var_ = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
      const probe = document.createElement('span'); probe.className = 'u-status-badge sem-done'; document.body.appendChild(probe);
      const probeStyle = { bg: getComputedStyle(probe).backgroundColor, fg: getComputedStyle(probe).color }; probe.remove();
      return {
        navBg: getComputedStyle(nav).backgroundColor, navItemColor: getComputedStyle(item).color,
        bodyVars: { semDoneBg: var_(document.body, '--sem-done-bg'), semActiveDot: var_(document.body, '--sem-active-dot'), colorBorder: var_(document.body, '--color-border'), colorAccent: var_(document.body, '--color-accent'), textPrimary: var_(document.body, '--color-text-primary') },
        rootVars: { semDoneBg: var_(document.documentElement, '--sem-done-bg'), colorAccent: var_(document.documentElement, '--color-accent') },
        navVars: { semDoneBg: var_(nav, '--sem-done-bg'), colorAccent: var_(nav, '--color-accent') },
        workbenchVars: { semDoneBg: var_(document.querySelector('.itl-workbench'), '--sem-done-bg'), colorAccent: var_(document.querySelector('.itl-workbench'), '--color-accent') },
        bodyLevelBadge: probeStyle
      };
    });
    same('平台顶栏背景、导航项字色与改前一致（共享层值）', { navBg: platform.navBg, navItemColor: platform.navItemColor }, { navBg: 'rgba(255, 255, 255, 0.98)', navItemColor: 'rgb(87, 83, 78)' });
    same('body 上的变量仍是全站值（覆盖没有提到 body）', platform.bodyVars, { semDoneBg: '#f0fdf4', semActiveDot: '#3b82f6', colorBorder: '#e7e5e4', colorAccent: '#d97706', textPrimary: '#1c1917' });
    same(':root 上的变量仍是全站值', platform.rootVars, { semDoneBg: '#f0fdf4', colorAccent: '#d97706' });
    same('平台顶栏上的变量是全站值', platform.navVars, { semDoneBg: '#f0fdf4', colorAccent: '#d97706' });
    same('模块容器 .itl-workbench 上的变量是覆盖值', platform.workbenchVars, { semDoneBg: '#ebedee', colorAccent: '#1b6c80' });
    same('挂在 body 层（模块容器外）的 sem-done 徽章仍是全站绿', platform.bodyLevelBadge, GLOBAL_DONE);
    // ---- 字号基线在运行时生效（fix1 H-1）：容器里一个没有任何类名的 small / button 落在基线上（12px / 13px），容器外同样的元素不被改动 ----
    // 探针外包一层 font-size:20px 的 div，让浏览器默认的 `small = smaller`（20 / 1.2 ≈ 16.67px）与基线值 12px 明显分开；按钮的浏览器默认是 13.3333px。断言后探针移除。
    const baselineProbe = (pg, hostSelector) => pg.evaluate(sel => {
      const host = sel === 'body' ? document.body : document.querySelector(sel);
      const w = document.createElement('div'); w.style.fontSize = '20px'; w.innerHTML = '<small>探针</small><button type="button">探针</button>';
      host.appendChild(w);
      const r = { small: getComputedStyle(w.querySelector('small')).fontSize, button: getComputedStyle(w.querySelector('button')).fontSize };
      w.remove(); return r;
    }, hostSelector);
    const baselineInside = async (label, selector) => same('字号基线（模块容器内）' + label + '：无类名 small = 12px、button = 13px', await baselineProbe(page, selector), { small: '12px', button: '13px' });
    await baselineInside('.itl-workbench（.itl-page 内）', '.itl-page'); await baselineInside('.itl-modal', '.itl-modal'); await baselineInside('.itl-toast', '#itlToast');
    for (const [label, selector] of [['body 直下', 'body'], ['平台顶栏 .navbar', '.navbar']]) {
      const out = await baselineProbe(page, selector);
      check('字号基线作用域收住（' + label + '，容器外）：无类名 small 仍是浏览器默认 smaller（≈16.67px），button 仍是 13.3333px，没有被基线改动', Math.abs(parseFloat(out.small) - 20 / 1.2) < 0.05 && Math.abs(parseFloat(out.button) - 13.3333) < 0.01, out);
    }

    // ---- 机柜设备块 + 挂 body 的浮层 ----
    await page.goto(f.base + '/IT_Ledger.html#racks'); await page.locator('.itl-rack-device').first().waitFor(); await ready();
    same('机柜设备块：#e4eff2 底、#c3dbe2 边、主文字色', await style('.itl-rack-device', ['backgroundColor', 'borderTopColor', 'color']), { backgroundColor: RGB.deviceBg, borderTopColor: RGB.deviceBorder, color: RGB.textPrimary });
    const overlayProbe = selector => page.locator(selector).evaluate(el => {
      const s = document.createElement('span'); s.className = 'u-status-badge sem-done'; el.appendChild(s);
      const r = { parentIsBody: el.parentElement === document.body, bg: getComputedStyle(s).backgroundColor, doneBg: getComputedStyle(el).getPropertyValue('--sem-done-bg').trim(), accent: getComputedStyle(el).getPropertyValue('--color-accent').trim() };
      s.remove(); return r;
    });
    await page.locator('.itl-rack-title').first().click(); await page.locator('.itl-rack-overlay').waitFor();
    same('机柜浮层（racks.js 挂 body）取到覆盖值', await overlayProbe('.itl-rack-overlay'), { parentIsBody: true, bg: BADGE['sem-done'].bg, doneBg: '#ebedee', accent: '#1b6c80' });
    await baselineInside('.itl-rack-overlay', '.itl-rack-overlay');
    same('机柜正视图设备块同样是 #e4eff2', (await style('.itl-face-device', ['backgroundColor'])).backgroundColor, RGB.deviceBg);
    await page.locator('[data-select-rack-asset="' + host.id + '"]').click();
    await page.locator('[data-rack-command="disks"]').click(); await page.locator('.itl-hardware-overlay').waitFor();
    same('硬件浮层（disks.js 挂 body）取到覆盖值', await overlayProbe('.itl-hardware-overlay'), { parentIsBody: true, bg: BADGE['sem-done'].bg, doneBg: '#ebedee', accent: '#1b6c80' });
    await baselineInside('.itl-hardware-overlay', '.itl-hardware-overlay');
    // 证据查看器有两处创建（evidence.js:23、inspection-sheets.js:597），都用类名 itl-evidence-viewer；这里按同一类名挂 body，源码层面的类名核对在静态检查里。
    await page.evaluate(() => { const el = document.createElement('div'); el.className = 'itl-evidence-viewer'; el.id = 'themeProbeViewer'; document.body.append(el); });
    same('证据查看器（itl-evidence-viewer，两处创建共用类名）取到覆盖值', await overlayProbe('#themeProbeViewer'), { parentIsBody: true, bg: BADGE['sem-done'].bg, doneBg: '#ebedee', accent: '#1b6c80' });
    await baselineInside('.itl-evidence-viewer', '#themeProbeViewer');
    // fix1 追加（C1b-2 预筛 D-2）：证据查看器里的次按钮（真实照片查看器的「关闭图片」）要吃到主题次按钮规则，而不是 components.css 里写死的平台色。
    // 期望值现取：同页 .itl-workbench 里真实的 .u-btn-secondary；对照：直接挂 body（所有模块容器之外）的同类按钮至少有一项不同，证明取到的是模块值。探针断言后移除。
    // fix2 LOW-5：悬停态同样要比（主题 :40 的 `.u-btn-secondary:hover` 规则）。探针在断言期间留在 DOM 里，悬停靠真实鼠标（Playwright hover），悬停期望 = 上面记下的真实工作台次按钮悬停值；断言后探针移除。
    const pickSecondary = id => page.locator('#' + id).evaluate(el => { const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, color: cs.color, borderTopColor: cs.borderTopColor }; });
    await page.evaluate(() => {
      for (const [host, id] of [[document.getElementById('themeProbeViewer'), 'themeProbeSecViewer'], [document.body, 'themeProbeSecBody']]) { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'u-btn-secondary'; b.textContent = '探针'; host.appendChild(b); }
    });
    const secondaryButtons = { viewer: await pickSecondary('themeProbeSecViewer'), body: await pickSecondary('themeProbeSecBody'), workbench: await page.evaluate(() => { const real = document.querySelector('.itl-workbench .u-btn-secondary'); if (!real) return null; const cs = getComputedStyle(real); return { backgroundColor: cs.backgroundColor, color: cs.color, borderTopColor: cs.borderTopColor }; }) };
    same('证据查看器里的 .u-btn-secondary：背景 / 字色 / 上边框色 = 同页 .itl-workbench 里真实次按钮的计算值', secondaryButtons.viewer, secondaryButtons.workbench);
    check('证据查看器里的次按钮取到模块值：与直接挂 body 的 .u-btn-secondary 至少一项不同', ['backgroundColor', 'color', 'borderTopColor'].some(k => secondaryButtons.viewer[k] !== secondaryButtons.body[k]), secondaryButtons);
    await page.locator('#themeProbeSecViewer').hover();
    let viewerHover = null; // 悬停过渡（0.2s）结束前读数会在中间色上：轮询到等于期望或超时，超时按最后读数判红
    for (let k = 0; k < 40; k++) { viewerHover = await pickSecondary('themeProbeSecViewer'); if (JSON.stringify(viewerHover) === JSON.stringify(realSecondaryHover)) break; await page.waitForTimeout(50); }
    same('证据查看器里的 .u-btn-secondary 悬停态：背景 / 字色 / 上边框色 = 同页 .itl-workbench 里真实次按钮悬停后的计算值', viewerHover, realSecondaryHover);
    check('证据查看器里的次按钮悬停确实生效：悬停态背景与静止态背景不同', viewerHover.backgroundColor !== secondaryButtons.viewer.backgroundColor, { rest: secondaryButtons.viewer, hover: viewerHover });
    await page.mouse.move(5, 5);
    await page.evaluate(() => { document.getElementById('themeProbeSecViewer').remove(); document.getElementById('themeProbeSecBody').remove(); });
    same('提示条容器 .itl-toast 取到覆盖值', await overlayProbe('#itlToast'), { parentIsBody: true, bg: BADGE['sem-done'].bg, doneBg: '#ebedee', accent: '#1b6c80' });

    // ---- 白纸几何（L8）：内容列 = 侧栏右缘到视口右缘；左空白 = 白纸左缘 - 侧栏右缘，右空白 = 视口(clientWidth) - 白纸右缘 ----
    const geometry = () => page.evaluate(() => {
      const paper = document.querySelector('.itl-page').getBoundingClientRect(), side = document.querySelector('.itl-sidebar').getBoundingClientRect();
      return { paperWidth: Math.round(paper.width), left: Math.round(paper.left - side.right), right: Math.round(document.documentElement.clientWidth - paper.right) };
    });
    await page.goto(f.base + '/IT_Ledger.html#all'); await page.reload(); // 仅哈希变化不会重载：reload 清掉上面注入的探针浮层与打开的机柜浮层
    await page.locator('#itlTable tbody tr').first().waitFor(); await ready();
    const g1440 = await geometry();
    check('1440 宽白纸右侧空白 8px（±1），左侧与侧栏相接', Math.abs(g1440.right - 8) <= 1 && Math.abs(g1440.left) <= 1, g1440);
    await page.setViewportSize({ width: 2560, height: 1000 }); await ready();
    const g2560 = await geometry();
    check('2560 宽白纸宽 1800 且左右空白近似相等（差 ≤ 8px）', Math.abs(g2560.paperWidth - 1800) <= 1 && Math.abs(g2560.left - g2560.right) <= 8 && g2560.left > 100, g2560);
    console.log('GEOMETRY ' + JSON.stringify({ g1440, g2560 }));
    // ---- 窄屏吸顶侧栏（H1）：滚动后侧栏底色 = 页面底，且侧栏页签条中心点命中的是侧栏自己（没被正文叠压） ----
    for (const vp of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(vp);
      await page.goto(f.base + '/IT_Ledger.html#all'); await page.locator('#itlTable tbody tr').first().waitFor(); await ready();
      // 平台顶栏在窄屏会折行，吸顶侧栏的 top 由页面脚本按顶栏实际高度回填（--itl-nav-height）；等它回填完再滚动，避免把「回填竞态」当成被测现象
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('.itl-sidebar')).top) - document.querySelector('.navbar').getBoundingClientRect().height) <= 1);
      await page.evaluate(() => window.scrollTo(0, 700));
      const r = await page.evaluate(() => {
        const sb = document.querySelector('.itl-sidebar'), rect = document.querySelector('#itlTabs').getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { scrollY: Math.round(window.scrollY), tabsTop: Math.round(rect.top), bg: getComputedStyle(sb).backgroundColor, inside: !!hit && sb.contains(hit), hit: hit ? hit.tagName + '.' + hit.className : null };
      });
      console.log('NARROW ' + vp.width + 'x' + vp.height + ' ' + JSON.stringify(r));
      check(vp.width + '×' + vp.height + ' 滚动 700 后确实发生了滚动', r.scrollY >= 100, r);
      same(vp.width + '×' + vp.height + ' 滚动后侧栏计算底色 = 页面底', r.bg, RGB.pageBg);
      check(vp.width + '×' + vp.height + ' 滚动后侧栏页签条中心点命中的是侧栏自身', r.inside, r);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // ---- C1b：字号五档、无渐变、模板痕迹（方案 v1.4 3.5 / 3.6）。1440 宽；每个视图整页重载后再测，等待信号都绑在被断言的元素上 ----
    const fresh = async (hash, waitSel) => { await page.goto(f.base + '/IT_Ledger.html#' + hash); await page.reload(); if (waitSel) await page.locator(waitSel).first().waitFor(); await ready(); };
    const fontUnlisted = [], fontHit = new Set(), fontSizes = {}, fontViews = [], gradientViews = [];
    // opts.pg = 要扫的页面（默认主页面）；opts.count = 防空转门槛只数落在该选择器内的元素（默认只数 #itlContent；浮层视图传浮层自己的选择器，侧栏等常驻元素不计入，L-3）；opts.min = 门槛（默认 20）。
    const fontScan = async (view, opts = {}) => {
      const r = await (opts.pg || page).evaluate(({ tiers, exceptions, count }) => {
        const roots = document.querySelectorAll('.itl-workbench,.itl-modal,.itl-rack-overlay,.itl-hardware-overlay,.itl-evidence-viewer,.itl-toast');
        const seen = new Set(), sizes = {}, unlisted = [], hit = []; let n = 0;
        for (const root of roots) for (const el of [root, ...root.querySelectorAll('*')]) {
          if (seen.has(el)) continue; seen.add(el);
          if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
          const own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
          if (!own && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || !el.getClientRects().length) continue;
          if (el.closest(count)) n++;
          sizes[cs.fontSize] = (sizes[cs.fontSize] || 0) + 1;
          if (tiers.includes(cs.fontSize)) continue;
          const i = exceptions.findIndex(e => e.size === cs.fontSize && el.matches(e.sel));
          if (i >= 0) hit.push(i); else unlisted.push(cs.fontSize + ' ' + el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' "' + el.textContent.trim().slice(0, 12) + '"');
        }
        return { n, sizes, unlisted, hit: [...new Set(hit)] };
      }, { tiers: FONT_TIERS, exceptions: FONT_EXCEPTIONS, count: opts.count || '#itlContent' });
      for (const i of r.hit) fontHit.add(i);
      for (const u of r.unlisted) fontUnlisted.push(view + ': ' + u);
      for (const [k, v] of Object.entries(r.sizes)) fontSizes[k] = (fontSizes[k] || 0) + v;
      fontViews.push(view);
      check('字号扫描 ' + view + '：在 ' + (opts.count || '#itlContent') + ' 内扫到 ' + r.n + ' 个有文字的可见元素，≥ ' + (opts.min || 20) + '（防空转）', r.n >= (opts.min || 20), r.n);
    };
    // 渐变扫描：模块容器内每个元素及其 ::before / ::after 的 backgroundImage / maskImage / webkitMaskImage / borderImageSource / listStyleImage 都不含 gradient
    const gradientScan = async (view, opts = {}) => {
      const r = await (opts.pg || page).evaluate(() => {
        const roots = document.querySelectorAll('.itl-workbench,.itl-modal,.itl-rack-overlay,.itl-hardware-overlay,.itl-evidence-viewer,.itl-toast');
        const seen = new Set(), bad = []; let n = 0;
        for (const root of roots) for (const el of [root, ...root.querySelectorAll('*')]) {
          if (seen.has(el)) continue; seen.add(el); n++;
          for (const pseudo of [null, '::before', '::after']) { const cs = getComputedStyle(el, pseudo); for (const p of ['backgroundImage', 'maskImage', 'webkitMaskImage', 'borderImageSource', 'listStyleImage']) if (/gradient/i.test(cs[p] || '')) bad.push((el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : el.tagName) + (pseudo || '') + ' ' + p); }
        }
        return { n, bad: bad.slice(0, 10) };
      });
      gradientViews.push(view);
      same('渐变扫描 ' + view + '：模块内 ' + r.n + ' 个元素及其伪元素的 backgroundImage / maskImage 不含 gradient', r.bad, []);
    };
    const drawerSettled = () => page.waitForFunction(() => { const d = document.querySelector('.itl-drawer.open'); return d && d.getBoundingClientRect().right <= window.innerWidth + 1 && document.querySelector('#itlDrawerTitle').textContent !== '资产详情' && document.querySelector('.itl-drawer .u-detail-section'); });
    // 库房 / 终端：卡片没有左上角图标方块
    await fresh('depot', '.itl-asset-card');
    same('库房卡片里没有 .itl-card-icon（卡片 ≥ 1 张）', await page.evaluate(() => ({ cards: document.querySelectorAll('.itl-asset-card').length > 0, icons: document.querySelectorAll('.itl-card-icon').length, kind: document.querySelector('.itl-card-kind')?.firstChild?.textContent.trim() })), { cards: true, icons: 0, kind: '笔记本' });
    await fontScan('库房'); await gradientScan('库房');
    await fresh('terminals', '.itl-asset-card');
    same('终端卡片里没有 .itl-card-icon（卡片 ≥ 1 张）', await page.evaluate(() => ({ cards: document.querySelectorAll('.itl-asset-card').length > 0, icons: document.querySelectorAll('.itl-card-icon').length })), { cards: true, icons: 0 });
    await fontScan('终端'); await gradientScan('终端');
    // 全部资产 + 详情抽屉头 + 登记弹窗
    await fresh('all', '#itlTable tbody tr');
    await fontScan('全部资产'); await gradientScan('全部资产');
    await page.locator('#itlTable [data-detail]').first().click(); await drawerSettled();
    same('详情抽屉头里没有 .itl-eyebrow（「资产档案」小标签已去掉），标题与 meta 仍在', await page.evaluate(() => ({ eyebrow: document.querySelectorAll('.itl-drawer .u-drawer-header .itl-eyebrow').length, text: document.querySelector('.itl-drawer .u-drawer-header').textContent.includes('资产档案'), h2: !!document.querySelector('.itl-drawer .u-drawer-header h2'), meta: !!document.querySelector('.itl-drawer #itlDrawerMeta') })), { eyebrow: 0, text: false, h2: true, meta: true });
    await fontScan('详情抽屉', { count: '.itl-drawer.open' }); await gradientScan('详情抽屉');
    await page.locator('#itlDrawerClose').click(); await page.locator('.itl-drawer:not(.open)').waitFor({ state: 'attached' });
    await page.locator('#itlRegister').click(); await page.locator('#itlModal.open').waitFor();
    await fontScan('登记弹窗', { count: '#itlModal.open' }); await gradientScan('登记弹窗');
    await page.locator('#itlModalCancel').click(); await page.locator('#itlModal.open').waitFor({ state: 'detached' });
    await fresh('software', '#itlSoftwareTable'); await fontScan('软件与订阅'); await gradientScan('软件与订阅');
    // 机柜总览：U 线是逐 U 细线元素（不是渐变），位置 = 第 k 个 U 的顶部 1px（总览设备块内容的裁切不在这里测，见头注释残余）
    await fresh('racks', '.itl-rack-device');
    const overview = await page.evaluate(rackId => { const fr = document.querySelector('[data-overview-rack="' + rackId + '"] .itl-rack-frame'), lines = [...fr.querySelectorAll('.itl-rack-u-line')], first = lines[0], last = lines[lines.length - 1]; const fcs = getComputedStyle(fr); if (!first) return { count: 0, frameImage: [fcs.backgroundImage, fcs.maskImage] }; const cs = getComputedStyle(first), fb = getComputedStyle(fr, '::before'), fa = getComputedStyle(fr, '::after'); return { count: lines.length, bottoms: [getComputedStyle(first).bottom, getComputedStyle(last).bottom], height: cs.height, pe: cs.pointerEvents, color: cs.backgroundColor.replace(/,\s*0\.\d+\)$/, ',α)'), lineImage: [cs.backgroundImage, cs.maskImage], frameImage: [fcs.backgroundImage, fcs.maskImage, fb.backgroundImage, fb.maskImage, fa.backgroundImage, fa.maskImage], frameBefore: fb.content, step: fr.closest('.itl-rack-summary').style.getPropertyValue('--itl-overview-step') }; }, rack.id);
    same('机柜总览 U 线：42U 柜 42 条 1px 细线元素，第 1 / 第 42 条的 bottom = 第 k 个 U 的顶部 1px（14px 步长），不挡点击，颜色 = --itl-rack-line，自身与伪元素没有渐变 / 遮罩图', overview, { count: 42, bottoms: ['13px', '587px'], height: '1px', pe: 'none', color: 'rgba(205, 206, 209,α)', lineImage: ['none', 'none'], frameImage: ['none', 'none', 'none', 'none', 'none', 'none'], frameBefore: 'none', step: '14px' });
    // fix1 L-4：U 线自身 pointer-events:none，elementFromPoint 会直接穿过它，证明不了层级。所以断言期间临时把 U 线改成可命中（注入样式，断言后移除），
    // 再沿设备块 / 空柜文字的竖线每 1px 取一点：命中的必须落在设备块 / 文字元素之内（target.contains(hit)），U 线、外框按钮本身、其他任何元素都算失败（fix2 LOW-1：原判据把命中外框也算没压到，空柜文字被压到负层时仍绿）；并要求确有 U 线穿过这块区域（否则取点没有判别力）。
    const layering = await page.evaluate(({ rackId, emptyId }) => {
      const st = document.createElement('style'); st.textContent = '.itl-rack-u-line{pointer-events:auto !important}'; document.head.appendChild(st);
      const sx = window.scrollX, sy = window.scrollY;
      try {
        const probe = (frame, target) => {
          target.scrollIntoView({ block: 'center' }); // elementFromPoint 在视口外返回 null：先滚进视口（空柜在第一屏之外时也要能取到点）；null 也算失败，不会静默放过
          const r = target.getBoundingClientRect(); let samples = 0, lineHits = 0;
          for (let y = r.top + 0.5; y < r.bottom; y += 1) { samples++; const hit = document.elementFromPoint(r.left + r.width / 2, y); if (!hit || hit.classList.contains('itl-rack-u-line') || !target.contains(hit)) lineHits++; } // fix2 LOW-1：命中点必须落在目标元素内（命中外框本身也算失败）
          const crossing = [...frame.querySelectorAll('.itl-rack-u-line')].filter(l => { const lr = l.getBoundingClientRect(); return lr.bottom > r.top && lr.top < r.bottom; }).length;
          return { enoughSamples: samples >= 10, linesCross: crossing >= 1, nonDeviceHits: lineHits };
        };
        const frame = document.querySelector('[data-overview-rack="' + rackId + '"] .itl-rack-frame'), dev = frame.querySelector('.itl-rack-device');
        const emptyFrame = document.querySelector('[data-overview-rack="' + emptyId + '"] .itl-rack-frame'), emptyText = emptyFrame.querySelector('.itl-rack-empty');
        const line = frame.querySelector('.itl-rack-u-line');
        return { device: probe(frame, dev), emptyText: probe(emptyFrame, emptyText), emptyTextIs: emptyText.textContent.trim(), emptyLineCount: emptyFrame.querySelectorAll('.itl-rack-u-line').length, lineZ: getComputedStyle(line).zIndex, frameIsolated: getComputedStyle(line.parentElement).isolation };
      } finally { st.remove(); window.scrollTo(sx, sy); }
    }, { rackId: rack.id, emptyId: rackEmpty.id });
    same('机柜总览层级（U 线临时改为可命中后沿设备块 / 空柜文字每 1px 取点）：设备块与「暂无设备」文字之上没有 U 线，且确有 U 线穿过这两块区域；U 线 z-index -1、机柜外框 isolate', layering,
      { device: { enoughSamples: true, linesCross: true, nonDeviceHits: 0 }, emptyText: { enoughSamples: true, linesCross: true, nonDeviceHits: 0 }, emptyTextIs: '暂无设备', emptyLineCount: 42, lineZ: '-1', frameIsolated: 'isolate' });
    same('机柜总览 121U 柜：不生成 U 线（.itl-rack-u-line 为 0），带 data-large-rack，外框仍在', await page.evaluate(id => { const art = document.querySelector('[data-overview-rack="' + id + '"]'); return { lines: art.querySelectorAll('.itl-rack-u-line').length, large: art.dataset.largeRack, frame: !!art.querySelector('.itl-rack-frame') }; }, rack121.id), { lines: 0, large: 'true', frame: true });
    // 总览设备块 title：只取 42U 柜 T01 里的设备，手写字符串清单全等（名称 · IP · U 位，与正视图写法一致；名称带【采集告警】前缀的设备 title 里是去前缀后的名称）。
    // 原先对 60U / 90U 高机柜里名称 / IP 行可见高度的几何断言已删（C1c，方案 v1.5 4-B；残余见文件头注释）。
    const overviewTitles = await page.evaluate(rackId => [...document.querySelectorAll('[data-overview-rack="' + rackId + '"] .itl-rack-device')].map(dev => dev.title + ' @' + Math.round(dev.getBoundingClientRect().height)), rack.id);
    same('机柜总览 T01（42U）设备块 title 带 IP（名称 · IP · U 位，与正视图写法一致）并钉住块高（@ 后是设备块像素高 = U 数 × 14px：1U 14、2U 28）清单（手写）；名称带【采集告警】前缀的设备 title 里是去前缀后的名称', [...overviewTitles].sort(),
      ['主题检查1U · 192.0.2.9 · U1–1 @14', '主题检查告警二U · 192.0.2.10 · U6–7 @28', '主题检查服务器 · 192.0.2.1 · U3–4 @28'].sort());
    // 只比计算样式取值（不量可见高度 / 内容盒）：T01 每个总览设备块的名称元素，计算字号恰为 12px，行高是 px 值且不小于字号。
    const nameStyles = await page.evaluate(rackId => [...document.querySelectorAll('[data-overview-rack="' + rackId + '"] .itl-rack-device')].map(dev => { const name = dev.querySelector(':scope > strong'), cs = name && getComputedStyle(name); return { text: name ? name.textContent : null, fs: cs ? cs.fontSize : null, lh: cs ? cs.lineHeight : null }; }), rack.id);
    check('机柜总览 T01（42U）每个设备块的名称元素：计算字号恰为 12px，行高是 px 值且不小于字号（设备块 3 个）', nameStyles.length === 3 && nameStyles.every(d => d.fs === '12px' && /^\d+(\.\d+)?px$/.test(d.lh) && parseFloat(d.lh) >= parseFloat(d.fs)), nameStyles);
    // 名称元素不能是空的：<strong> 的文本排序后与三条设备名称（手写清单）全等
    same('机柜总览 T01（42U）三个设备块的名称元素文本（<strong>，排序后）与手写的设备名称清单全等', nameStyles.map(d => d.text).sort(), ['主题检查1U', '主题检查告警二U', '主题检查服务器'].sort());
    await fontScan('机柜总览'); await gradientScan('机柜总览');
    // 机柜正视图（浮层）：1U 设备 12px 放得下
    await page.locator('[data-overview-rack="' + rack.id + '"] .itl-rack-title').click(); await page.locator('.itl-rack-overlay:not([hidden])').waitFor(); await page.locator('.itl-face-device.itl-one-u').first().waitFor();
    await page.locator('[data-select-rack-asset="' + host.id + '"]').click(); await page.locator('#itlRackPanel [data-rack-command="disks"]').waitFor();
    const face = await page.evaluate(() => { const devs = [...document.querySelectorAll('.itl-face-device')]; return { oneU: devs.filter(d => d.classList.contains('itl-one-u')).length, all: devs.length, overflow: devs.filter(d => d.scrollHeight > d.clientHeight).map(d => d.querySelector('strong').textContent), oneUTitle: devs.find(d => d.classList.contains('itl-one-u')).title, oneUFont: getComputedStyle(devs.find(d => d.classList.contains('itl-one-u')).querySelector('strong')).fontSize, titleNames: devs.map(d => d.title.split(' · ')[0]).sort(), geometry: [getComputedStyle(document.querySelector('.itl-u-row')).height, getComputedStyle(document.querySelector('.itl-u-cell')).height] }; });
    same('机柜正视图：1U 与其余设备块 scrollHeight ≤ clientHeight（不溢出），1U 名称 12px，行高 28 / 格 27px 不变，1U 按钮 title 带全文', { ...face, titleNames: undefined }, { oneU: 1, all: 3, overflow: [], oneUTitle: '主题检查1U · 192.0.2.9 · U1–1', oneUFont: '12px', titleNames: undefined, geometry: ['28px', '27px'] });
    // fix2 LOW-3：总览 title 与正视图 title 的名称部分同源（都是 deviceName：去掉【采集告警】前缀）。正视图 T01 里的每个设备，其名称部分都能在总览 title 的名称部分里找到，且没有任何一个总览 title 带前缀。
    same('机柜正视图 title 的名称部分（T01 的三台设备，含名称带【采集告警】前缀的那台，已去前缀）', face.titleNames, ['主题检查1U', '主题检查告警二U', '主题检查服务器']);
    const overviewTitleNames = overviewTitles.map(t => t.split(' · ')[0]);
    check('总览 title 与正视图 title 的名称部分同源：正视图每个名称都在总览 title 里出现，且总览 title 没有一个带【采集告警】前缀', face.titleNames.every(n => overviewTitleNames.includes(n)) && overviewTitleNames.every(n => !n.startsWith('【采集告警】')), { front: face.titleNames, overview: overviewTitleNames });
    await fontScan('机柜正视图', { count: '.itl-rack-overlay', min: 20 }); await gradientScan('机柜正视图');
    await page.locator('[data-rack-command="disks"]').click(); await page.locator('.itl-hardware-overlay .itl-disk-slot small').first().waitFor();
    await fontScan('硬件浮层', { count: '.itl-hardware-overlay', min: 10 }); await gradientScan('硬件浮层');
    // AP 平面图：点阵是遮罩伪元素（不是渐变），点位圆点没有 box-shadow（外圈改成伪元素描边）
    await fresh('aps', '.itl-ap-point');
    const ap = await page.evaluate(() => { const content = document.querySelector('.itl-ap-room-content'), i = document.querySelector('.itl-ap-point i'), cc = getComputedStyle(content), cb = getComputedStyle(content, '::before'), ca = getComputedStyle(content, '::after'), ic = getComputedStyle(i), ib = getComputedStyle(i, '::before'); return { contentImage: [cc.backgroundImage, cc.maskImage, ca.backgroundImage, ca.maskImage, cb.backgroundImage], dots: { mask: /^url\("data:image\/svg\+xml,/.test(cb.maskImage) && !/gradient/i.test(cb.maskImage), size: cb.maskSize, color: cb.backgroundColor, pe: cb.pointerEvents, position: cb.position }, dotShadow: ic.boxShadow, ring: [ib.borderTopWidth, ib.borderTopStyle, ib.borderTopColor, ib.borderRadius, ib.pointerEvents, ib.position] }; });
    same('AP 平面图：房间内容区自身与 ::after 无渐变 / 遮罩图；点阵 = ::before 的 SVG 遮罩（20px 格、--color-border 色、不挡点击）；点位圆点 box-shadow 为 none，外圈 = ::before 的 1px --color-accent-hover 描边', ap,
      { contentImage: ['none', 'none', 'none', 'none', 'none'], dots: { mask: true, size: '20px 20px', color: RGB.border, pe: 'none', position: 'absolute' }, dotShadow: 'none', ring: ['1px', 'solid', 'rgb(21, 90, 107)', '50%', 'none', 'absolute'] });
    await fontScan('AP 平面图', { min: 10 }); await gradientScan('AP 平面图');
    // 预筛点名的四个 small（原先没有字号声明、落在浏览器默认值 smaller）：由零特异性基线接住，计算值必须是 12px；各自在出现它的视图里量
    const smallIs12 = async (label, pg, sel) => { const r = await pg.evaluate(s => { const els = [...document.querySelectorAll(s)].filter(e => e.getClientRects().length); return { n: els.length, sizes: [...new Set(els.map(e => getComputedStyle(e).fontSize))] }; }, sel); check('预筛点名的 small（' + label + ' ' + sel + '）有 ≥ 1 个可见实例且计算字号全是 12px', r.n >= 1 && r.sizes.length === 1 && r.sizes[0] === '12px', r); };
    await fresh('stocktakes', '#itlInventoryContent h2:has-text("自检盘点批次")'); await fontScan('盘点列表', { min: 10 }); await gradientScan('盘点列表');
    await page.locator('[data-stock-open="' + stock.id + '"]').click(); await page.locator('#itlInventoryContent [data-stock-item]').first().waitFor();
    await fontScan('盘点详情'); await gradientScan('盘点详情');
    await fresh('reconciles', '#itlInventoryContent h2:has-text("财务对账批次")'); await fontScan('对账列表', { min: 10 }); await gradientScan('对账列表');
    await page.locator('[data-rec-open="' + reconcile.id + '"]').click(); await page.locator('[data-report-lane]').first().waitFor();
    await fontScan('对账报告（有条目）'); await gradientScan('对账报告（有条目）'); await smallIs12('对账报告', page, '.itl-report-bulk small');
    await fresh('inspections', '#itlInspRows'); await fontScan('巡检列表'); await gradientScan('巡检列表');
    // 「按用途归邻档」例外（fix1 待裁，主会话定）：巡检视图隐藏模块页头，这个 h2 就是页面标题；方案第六节第 2 条原文「字号按 3.5 归到 24px」，默认表的 20→16 不适用。h2 → h1 的标签改动仍归 C4。
    same('巡检视图页面标题 .itl-insp-heading h2 = 24px（按用途归 24px，不按默认表归 16px）', await style('.itl-insp-heading h2', ['fontSize']), { fontSize: '24px' });
    await page.locator('[data-insp-view="' + submittedSheet.id + '"]').click(); await page.locator('#itlSheetMetrics').waitFor();
    await fontScan('已提交巡检单详情'); await gradientScan('已提交巡检单详情'); await smallIs12('巡检单详情', page, '.itl-sheet-metrics small');
    await fresh('all', '#itlTable tbody tr');
    // ---- 填写页固定底栏（L4）：右缘与白纸右缘相等 ----
    const context2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await applyOverride(context2);
    await context2.addInitScript(() => localStorage.setItem('token', 'fixture-2'));
    const page2 = await context2.newPage(); page2.on('pageerror', e => errors.push(e.message));
    await page2.goto(f.base + '/IT_Ledger.html#inspections'); await page2.locator('[data-insp-continue="' + sheet.id + '"]').click();
    await page2.locator('#itlFormFooter').waitFor();
    const footer = await page2.evaluate(() => ({ footerRight: Math.round(document.querySelector('#itlFormFooter').getBoundingClientRect().right), paperRight: Math.round(document.querySelector('.itl-page').getBoundingClientRect().right), position: getComputedStyle(document.querySelector('#itlFormFooter')).position }));
    check('填写页(1440)固定底栏右缘 = 白纸右缘（±1）', footer.position === 'fixed' && Math.abs(footer.footerRight - footer.paperRight) <= 1, footer);
    // fix1 H-1：填写页六个流程段各点开扫一遍（机柜段有矩阵里的 small，设备段有手工填写区的 summary small）
    for (const [key, title] of [['basic', '基本信息'], ['room', '机房环境'], ['rack', '机柜检查'], ['device', '服务器与存储'], ['remark', '总体备注'], ['review', '核对提交']]) {
      await page2.locator('#itlSheetRoute [data-workflow-go="' + key + '"]').click(); await page2.locator('#itlSheetRoute [data-workflow-go="' + key + '"][aria-current="step"]').waitFor();
      await fontScan('填写页·' + title, { pg: page2 }); await gradientScan('填写页·' + title, { pg: page2 });
      if (key === 'rack') await smallIs12('填写页机柜矩阵', page2, '.itl-sheet-matrix td small');
      if (key === 'device') await smallIs12('填写页手工填写区', page2, '.itl-sheet-manual summary small');
    }
    console.log('FONT_SIZES_SEEN ' + JSON.stringify(fontSizes));
    console.log('FONT_SCANNED_VIEWS ' + JSON.stringify(fontViews));
    console.log('GRADIENT_SCANNED_VIEWS ' + JSON.stringify(gradientViews));
    same('1440 宽已扫视图内的实际计算字号：五档（12 / 13 / 14 / 16 / 24px）之外没有清单外的字号（已扫视图清单见头注释，不是「模块内全部」）', fontUnlisted, []);
    same('字号例外清单（4 条）里的每一条在已扫视图里都出现过（无过期条目）', FONT_EXCEPTIONS.map((e, i) => i).filter(i => !fontHit.has(i)).map(i => FONT_EXCEPTIONS[i].sel + ' ' + FONT_EXCEPTIONS[i].size), []);
    same('字号例外清单与已扫视图里实际出现的五档外字号一致：共 2 种字号（11 / 15px，均来自 components.css）', [...new Set(Object.keys(fontSizes).filter(s => !FONT_TIERS.includes(s)))].sort(), ['11px', '15px']);
    same('已扫视图清单（字号扫描）与手写清单全等', fontViews, SCANNED_VIEWS);
    same('已扫视图清单（渐变扫描）与手写清单全等', gradientViews, SCANNED_VIEWS);
    // 超宽屏（修复批 2 M-2）：fixed 底栏的 left / right 百分比相对视口宽，要随白纸的居中外边距一起推；2560 宽下底栏左缘 = 白纸左缘、右缘 = 白纸右缘（各 ±1）
    await page2.setViewportSize({ width: 2560, height: 1000 });
    const wide = await page2.evaluate(() => { const fr = document.querySelector('#itlFormFooter').getBoundingClientRect(), pr = document.querySelector('.itl-page').getBoundingClientRect(); return { footerLeft: Math.round(fr.left), paperLeft: Math.round(pr.left), footerRight: Math.round(fr.right), paperRight: Math.round(pr.right) }; });
    check('填写页(2560)固定底栏左缘 = 白纸左缘、右缘 = 白纸右缘（各 ±1）', Math.abs(wide.footerLeft - wide.paperLeft) <= 1 && Math.abs(wide.footerRight - wide.paperRight) <= 1, wide);
    await context2.close();

    same('页面无脚本异常', errors, []);
    // 顶替了线上主题文件时，测的不是要上线的文件：一律不判绿（只供红→绿证明用）
    if (overrideCss !== null) throw new Error(overrideCss + ' is set: the shipped files were not (all) tested, refusing to report PASS');
    console.log('THEME_COMPUTED PASS=' + pass + ' FAIL=0');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
