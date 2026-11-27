'use strict';
// #200 C2: the default screen's "待处理" block (plan v1.5 section 5.5), real ledger router on the fixture, headless chromium.
// Threat model: an honest implementation slip turns a named assertion red (stale cache shown, wrong order, retry row counted in k, late response not
// dropped, expanded state kept across accounts, read-only user shown a write button, health wording drifting). Not a defence against a hostile page.
// Every expectation is a hand-written literal; nothing is produced by calling product functions (the only product read is ITLedger.pending.paint() after
// the "state injection" block mutates ITLedger.state.health, to reach wording branches the server cannot produce, see block I).
// Seed (all via the fixture API / SQL): 4 damaged disks, 7 warnings (hosts with a judgement, rack servers with alerts / history), 3 drafts, 3 unfinished rooms.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createFixture, users: fixtureUsers } = require('./it-ledger-browser-fixture');
const createCollect = require('../routes/it-ledger/inspection-collect');
let pass = 0;
function equal(name, actual, expected) { assert.deepEqual(actual, expected, name); pass++; console.log('[OK] ' + name); }
function check(name, value, detail) { assert.ok(value, name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail))); pass++; console.log('[OK] ' + name); }

const OV = '**/api/it-assets/inspections/sheets/overview';
const fail500 = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'LEDGER_INTERNAL', message: '模拟失败' }) });
const LONG = '超长设备名称'.repeat(12);

async function main() {
  delete process.env.IT_INSPECTION_CYCLE; // overview cycle comes from the environment; pin "unset" = week
  const f = await createFixture({ cleanup: true }), f2 = await createFixture({ cleanup: true });
  let browser; const contexts = [];
  const errors = [];
  try {
    // ---------- helpers ----------
    const mk = fx => {
      const api = async (method, url, body, uid = 1, status = 200) => { const r = await fx.api(method, url, body, uid); assert.equal(r.status, status, method + ' ' + url + ' ' + JSON.stringify(r.body)); return r.body; };
      const create = b => api('POST', '', b, 1, 201);
      const rack = (name, room) => api('POST', '/racks', { name, room, u_total: 20 }, 1, 201);
      const draft = (room, uid = 2) => api('POST', '/inspections/sheets', { room_name: room }, uid, 201);
      const photo = async (s, slot, target, uid) => { const fd = new FormData(); fd.append('slot', slot); fd.append('target_id', String(target)); fd.append('file', new Blob([Buffer.from([255, 216, 255, 224, 0, 0, 255, 217])], { type: 'image/jpeg' }), 'front.jpg'); assert.equal((await fetch(fx.base + '/api/it-assets/inspections/sheets/' + s.id + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd })).status, 201); };
      async function submit(room, uid = 2) {
        const s = await draft(room, uid);
        const filled = await api('PUT', '/inspections/sheets/' + s.id, { expected_version: s.version, items: s.items.map(it => ({ id: it.id, result: it.value_kind === 'check' ? 'ok' : null, number_value: it.value_kind === 'number' ? (it.item_key === 'temperature' ? 22 : 45) : null, note: null })) }, uid);
        await photo(s, 'rack_front', s.scope.racks[0].id, uid);
        return api('POST', '/inspections/sheets/' + s.id + '/submit', { expected_version: filled.version }, uid);
      }
      return { api, create, rack, draft, submit };
    };
    const A = mk(f), B = mk(f2);
    const snap = (ip, sn, disks, alerts) => ({ schema_version: 1, source_host: ip, server: { serial_number: sn }, volumes: [], physical_disks: disks, virtual_disks: [], enclosures: [], alerts: alerts.map(message => ({ kind: 'server', message })), component_errors: [], cleanup_warnings: [], collection_status: 'success' });
    async function inspect(host, ip, snapshot, at, note) {
      const r = await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)', [host.id, host.name, ip, at, at, snapshot.collection_status, JSON.stringify(snapshot), 1]);
      if (note) await f.run("UPDATE it_device_inspections SET judgement='attention',judgement_note=?,reviewed_by=1,reviewed_at=? WHERE id=?", [note, at, r.lastID]);
      return r.lastID;
    }
    async function host(name, { sn, ip, asset_no, rack, u, slots = 0 }) {
      const body = { category: 'server', name, sn, u_height: 2, slot_count: slots, attrs: { ip }, placement: rack ? { kind: 'rack', rack_id: rack.id, u_start: u } : { kind: 'depot' } };
      if (asset_no) body.asset_no = asset_no;
      return A.create(body);
    }
    async function disk(h, name, sn, slot, asset_no) {
      const version = (await A.api('GET', '/' + h.id)).asset.version;
      const body = { category: 'disk', name, sn, attrs: { capacity: '4 TB', interface: 'SAS' }, placement: { kind: 'host', parent_asset_id: h.id, slot_no: slot }, peer_versions: { [h.id]: version } };
      if (asset_no) body.asset_no = asset_no;
      return A.create(body);
    }
    const failedDisk = sn => ({ serial_number: sn, state: 'Failed', status: 'Critical', failure_predicted: false });

    // ---------- seed ----------
    await createCollect({}).ensure({ run: f.run });
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    for (const room of ['R-Host', 'R-Due1', 'R-Due2', 'R-Done', 'R-Dra', 'R-Drb', 'R-Drc']) await A.rack(room + '-柜', room);
    const hostRack = (await A.api('GET', '/racks')).items.find(r => r.room === 'R-Host');
    // damaged disks: three hosts (created in this order, so ids ascend HD < HB < HA); each host row carries one judgement that every failed disk on it shares
    const hd = await host('HD主机', { sn: 'SRV-HD', ip: '10.2.0.4', slots: 1 });
    await disk(hd, '盘D1', 'DSK-D1', 1, 'ZC-009');
    await inspect(hd, '10.2.0.4', snap('10.2.0.4', 'SRV-HD', [failedDisk('DSK-D1')], []), '2026-10-08T04:00:00.000Z', '备件盘D1磨损');
    const hb = await host('HB主机', { sn: 'SRV-HB', ip: '10.2.0.2', slots: 2 });
    await disk(hb, '盘B1', 'DSK-B1', 1, 'ZC-001'); await disk(hb, '盘B2', 'DSK-B2', 2);
    await inspect(hb, '10.2.0.2', snap('10.2.0.2', 'SRV-HB', [failedDisk('DSK-B1'), failedDisk('DSK-B2')], []), '2026-10-10T04:00:00.000Z', '备盘故障');
    const ha = await host('HA主机', { sn: 'SRV-HA', ip: '10.2.0.1', slots: 1 });
    await disk(ha, '盘A1', 'DSK-A1', 1, 'ZC-002');
    await inspect(ha, '10.2.0.1', snap('10.2.0.1', 'SRV-HA', [failedDisk('DSK-A1')], []), '2026-10-09T20:00:00.000Z', '原盘故障待更换'); // UTC 10-09 20:00 = Asia/Shanghai 10-10 04:00: same local day as HB (fix 1, ruling 2)
    // warnings: W1 evidence only (not confirmed) / W2 judged with a reason / W3 history (a later failed attempt) in the rack, W4 long name without asset number
    const w1 = await host('W1服务器', { sn: 'SRV-W1', ip: '10.2.0.11', asset_no: 'ZC-050', rack: hostRack, u: 1 });
    await inspect(w1, '10.2.0.11', snap('10.2.0.11', 'SRV-W1', [], ['风扇告警W1']), '2026-10-09T04:00:00.000Z');
    const w2 = await host('W2服务器', { sn: 'SRV-W2', ip: '10.2.0.12', asset_no: 'ZC-040', rack: hostRack, u: 3 });
    await inspect(w2, '10.2.0.12', snap('10.2.0.12', 'SRV-W2', [], ['电源告警W2']), '2026-10-09T04:00:00.000Z', '已核实电源模块异常');
    const w3 = await host('W3服务器', { sn: 'SRV-W3', ip: '10.2.0.13', asset_no: 'ZC-060', rack: hostRack, u: 5 });
    await inspect(w3, '10.2.0.13', snap('10.2.0.13', 'SRV-W3', [], ['W3旧告警']), '2026-10-07T04:00:00.000Z');
    await inspect(w3, '10.2.0.13', { ...snap('10.2.0.13', 'SRV-W3', [], []), server: null, collection_status: 'failed', component_errors: ['连接超时'] }, '2026-10-11T04:00:00.000Z');
    const w4 = await host('W4' + LONG, { sn: 'SRV-W4', ip: '10.2.0.14' });
    await inspect(w4, '10.2.0.14', snap('10.2.0.14', 'SRV-W4', [], ['W4告警']), '2026-10-09T04:00:00.000Z');
    // drafts: Drb is created before Dra (id order must lose to room-name order); Drc belongs to user 5 (summary for user 2); same created_at for Dra / Drb
    const drb = await A.draft('R-Drb'), dra = await A.draft('R-Dra'), drc = await A.draft('R-Drc', 5);
    await f.run('UPDATE it_inspection_sheets SET created_at=? WHERE id IN (?,?)', ['2026-11-03T04:00:00.000Z', drb.id, dra.id]);
    await f.run('UPDATE it_inspection_sheets SET created_at=? WHERE id=?', ['2026-11-01T04:00:00.000Z', drc.id]);
    // R-Done: inspected this period (no entry); R-Due2: inspected 60 days ago (entry with "上次")
    await A.submit('R-Done');
    const due2 = await A.submit('R-Due2');
    const [yy, mm, dd] = (await f.all("SELECT date('now','localtime') AS day"))[0].day.split('-').map(Number);
    const old = new Date(Date.UTC(yy, mm - 1, dd) - 60 * 86400000 + 4 * 3600000);
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?', [old.toISOString(), due2.id]);
    const overviewApi = await A.api('GET', '/inspections/sheets/overview');
    const roomApi = name => overviewApi.rooms.find(r => r.room === name);
    const draftFilled = name => roomApi(name).draft.filled + '/' + roomApi(name).draft.total;

    const HD_INFO = '2026-10-08T04:00:00.000Z · 运维已判断 · 备件盘D1磨损', HB_INFO = '2026-10-10T04:00:00.000Z · 运维已判断 · 备盘故障', HA_INFO = '2026-10-09T20:00:00.000Z · 运维已判断 · 原盘故障待更换';
    const W1_INFO = '2026-10-09T04:00:00.000Z · 待运维判断 · 风扇告警W1', W2_INFO = '2026-10-09T04:00:00.000Z · 运维已判断 · 已核实电源模块异常';
    const W3_INFO = '2026-10-07T04:00:00.000Z · 待运维判断 · 本次采集未形成新结论 · W3旧告警', W4_INFO = '2026-10-09T04:00:00.000Z · 待运维判断 · W4告警';
    // Segment 7 (alert-row display fix): the pending block's detail line for damaged / warning rows is now "<observation day>观测 · judgement (· no-new-conclusion note)"
    // (no reason, no raw time string). The *_INFO literals above stay as the rack view's hover text (unchanged, see B3 / W3); the *_D literals are the pending detail lines.
    // 盘A1 / HA主机 were observed 2026-10-09T20:00Z = 10 月 10 日 in Asia/Shanghai.
    const HD_D = '10 月 8 日观测 · 运维已判断', HB_D = '10 月 10 日观测 · 运维已判断', HA_D = '10 月 10 日观测 · 运维已判断';
    const W1_D = '10 月 9 日观测 · 待运维判断', W2_D = '10 月 9 日观测 · 运维已判断';
    const W3_D = '10 月 7 日观测 · 待运维判断 · 本次采集未形成新结论', W4_D = '10 月 9 日观测 · 待运维判断';
    const EXPECTED = [
      ['盘D1 损坏：备件盘D1磨损', HD_D], ['盘B1 损坏：备盘故障', HB_D], ['盘A1 损坏：原盘故障待更换', HA_D], ['盘B2 损坏：备盘故障', HB_D],
      ['W3服务器 巡检告警：W3旧告警', W3_D], ['HD主机 巡检告警：备件盘D1磨损', HD_D],
      ['W2服务器 巡检告警：已核实电源模块异常', W2_D], ['W1服务器 巡检告警：风扇告警W1', W1_D], ['W4' + LONG + ' 巡检告警：W4告警', W4_D],
      ['HB主机 巡检告警：备盘故障', HB_D], ['HA主机 巡检告警：原盘故障待更换', HA_D],
      ['R-Drc 巡检草稿未提交（11 月 1 日开始）', '测试维护员二 · 已填 ' + draftFilled('R-Drc') + ' 项'],
      ['R-Dra 巡检草稿未提交（11 月 3 日开始）', '测试维护员 · 已填 ' + draftFilled('R-Dra') + ' 项'],
      ['R-Drb 巡检草稿未提交（11 月 3 日开始）', '测试维护员 · 已填 ' + draftFilled('R-Drb') + ' 项'],
      ['R-Due1 本周未巡检', '尚无巡检记录'],
      ['R-Due2 本周未巡检', '上次 ' + (old.getUTCMonth() + 1) + ' 月 ' + old.getUTCDate() + ' 日 · 距上次 ' + roomApi('R-Due2').days_since_last + ' 天'],
      ['R-Host 本周未巡检', '尚无巡检记录']
    ];
    check('种子：条目总数 17（4 损坏 + 7 告警 + 3 草稿 + 3 未巡检）', EXPECTED.length === 17);

    browser = await chromium.launch({ headless: true });
    const open = async (uid, fx = f, { viewport = { width: 1440, height: 1000 } } = {}) => {
      const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
      await context.addInitScript(u => localStorage.setItem('token', 'fixture-' + u), uid);
      contexts.push(context);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      return page;
    };
    const base = fx => fx.base + '/IT_Ledger.html';
    const title = p => p.locator('#itlPending .itl-pending-title').innerText();
    const waitTitle = (p, text) => p.waitForFunction(t => document.querySelector('#itlPending .itl-pending-title')?.textContent === t, text);
    const mains = p => p.locator('#itlPending .itl-pending-main').allTextContents();
    const subs = p => p.locator('#itlPending .itl-pending-sub').allTextContents();
    const visible = p => p.locator('#itlPending').isVisible();
    // idempotent: the expanded state lives in the module, so a page may already be expanded / collapsed
    const expand = async p => { if (await p.locator('#itlPending [data-pending-action="more"]').count()) await p.locator('#itlPending [data-pending-action="more"]').click(); await p.locator('#itlPending [data-pending-action="less"]').waitFor(); };
    const collapse = async p => { if (await p.locator('#itlPending [data-pending-action="less"]').count()) await p.locator('#itlPending [data-pending-action="less"]').click(); await p.locator('#itlPending [data-pending-action="more"]').waitFor(); };
    const labels = p => p.evaluate(() => { const out = { damaged: [], warning: [], draft: [], due: [] }; for (const li of document.querySelectorAll('#itlPending .itl-pending-item[data-pending-kind]')) out[li.dataset.pendingKind].push(li.querySelector('.itl-pending-action').textContent); return out; });
    const rowOf = (p, text) => p.locator('#itlPending .itl-pending-item[data-pending-kind]').filter({ hasText: text });
    const refreshDone = p => p.evaluate(() => ITLedger.refresh());

    // ===== A. 默认屏位置、排序与上限（admin） =====
    const ap = await open(1);
    await ap.goto(base(f) + '#all'); await waitTitle(ap, '待处理（17）');
    equal('A1 块在内容区最前、紧接范围切换之前', await ap.evaluate(() => { const c = document.querySelector('#itlContent'), p = document.querySelector('#itlPending'); return { first: c.firstElementChild === p, next: p.nextElementSibling.className }; }), { first: true, next: 'itl-list-scopes' });
    // fix 1 ruling 2: 盘A1 / HA主机 were observed 2026-10-09T20:00Z = 2026-10-10 04:00 in Asia/Shanghai, the same local day as 盘B1 / 盘B2 / HB主机 (10-10 04:00Z).
    // Grouped by local day the tie falls to asset number (B1 ZC-001, A1 ZC-002, B2 none) and to id (HB before HA); grouped by the UTC date prefix 盘A1 / HA主机 would jump ahead.
    equal('A1b 观测日期按本地（Asia/Shanghai）日历日分组，不是 UTC 前 10 位：UTC 前一天、本地同一天的 盘A1 排在 盘B1 之后、盘B2 之前', (await mains(ap)).slice(0, 4), ['盘D1 损坏：备件盘D1磨损', '盘B1 损坏：备盘故障', '盘A1 损坏：原盘故障待更换', '盘B2 损坏：备盘故障']);
    equal('A2 前 6 条顺序全等（损坏按观测日期 → 资产编号，缺编号排后）', await mains(ap), EXPECTED.slice(0, 6).map(e => e[0]));
    equal('A3 「还有 N 件」', await ap.locator('#itlPending .itl-pending-more').innerText(), '还有 11 件');
    const before = await ap.evaluate(() => ({ hash: location.hash, tab: document.querySelector('[data-tab][aria-current]').dataset.tab, url: location.href }));
    await expand(ap);
    equal('A4 展开后全部 17 条顺序全等', await mains(ap), EXPECTED.map(e => e[0]));
    equal('A5 展开不改 URL / 页签', await ap.evaluate(() => ({ hash: location.hash, tab: document.querySelector('[data-tab][aria-current]').dataset.tab, url: location.href })), before);
    equal('A6 展开后按钮变「收起」，标题 k 不变', { more: await ap.locator('#itlPending .itl-pending-more').innerText(), k: await title(ap) }, { more: '收起', k: '待处理（17）' });
    await ap.locator('#itlSearch').fill('不存在的搜索词');
    equal('A7 表格搜索后条目不变', await mains(ap), EXPECTED.map(e => e[0]));
    await ap.locator('[data-list-scope="parts"]').click();
    equal('A8 范围切换后条目不变、展开状态保留', { m: await mains(ap), k: await title(ap) }, { m: EXPECTED.map(e => e[0]), k: '待处理（17）' });
    await ap.locator('[data-list-scope="all"]').click(); await ap.locator('#itlResetFilters').click();
    await ap.locator('#itlPending [data-pending-action="less"]').click();
    equal('A9 收起后回到 6 条', (await mains(ap)).length, 6);
    equal('A10 块里没有 data-detail / data-action / input / 共享按钮与卡片类', await ap.evaluate(() => { const p = document.querySelector('#itlPending'); return p.querySelectorAll('[data-detail],[data-action],input,.u-btn-secondary,.u-btn-primary,.itl-card,.u-corr-table-wrap').length; }), 0);

    // ===== B. 健康说明逐字（机柜图 title 与待处理第二行，均对照手写字面量） =====
    await expand(ap);
    equal('B1 待处理前 11 条（损坏 + 告警）第二行逐字全等（段 7 起：观测日 · 判断状态，不含原因与原始时间串）', (await subs(ap)).slice(0, 11), EXPECTED.slice(0, 11).map(e => e[1]));
    equal('B2 草稿与未巡检第二行全等', (await subs(ap)).slice(11), EXPECTED.slice(11).map(e => e[1]));
    await ap.locator('[data-tab="racks"]').click(); await ap.locator('.itl-rack-title').first().waitFor();
    await ap.locator('[data-overview-rack="' + hostRack.id + '"] .itl-rack-title').click(); await ap.locator('#itlRackFace .itl-face-device').first().waitFor();
    const marks = await ap.evaluate(() => Object.fromEntries([...document.querySelectorAll('#itlRackFace .itl-face-device')].map(d => [d.querySelector('strong').textContent, d.querySelector('.itl-rack-health')?.outerHTML || null])));
    const span = (info, text) => '<span class="itl-rack-health itl-rack-health-warning" title="' + info + '">' + text + '</span>';
    equal('B3 机柜图 healthMark 输出逐字节：证据-未判断 / 已判断带说明 / 历史结果（含「· 上次结果」）', marks,
      { 'W1服务器': span(W1_INFO, '● 告警'), 'W2服务器': span(W2_INFO, '● 告警'), 'W3服务器': span(W3_INFO, '● 告警 · 上次结果') });
    await ap.locator('[data-rack-command="close"]').click(); await ap.locator('[data-tab="all"]').click(); await ap.locator('#itlPending .itl-pending-title').waitFor();
    equal('B4 回到默认屏后块仍在（展开状态保留），告警第二行仍是同一条观测日 · 判断状态（段 7 起不再与机柜图 title 同串）', (await subs(ap)).slice(6, 9), [W2_D, W1_D, W4_D]);

    // ===== C. 周期取词 =====
    const mp = await open(1);
    await mp.route(OV, async route => { const response = await route.fetch(), json = await response.json(); json.period.cycle = 'month'; await route.fulfill({ response, json }); });
    await mp.goto(base(f) + '#all'); await waitTitle(mp, '待处理（17）'); await expand(mp);
    equal('C1 period.cycle=month 时「本月未巡检」（默认 week 的「本周未巡检」见 A4）', (await mains(mp)).slice(14), ['R-Due1 本月未巡检', 'R-Due2 本月未巡检', 'R-Host 本月未巡检']);

    // ===== D. 权限：三种角色的按钮文字，点击行为 =====
    await expand(ap);
    equal('D1 管理员：损坏 / 告警「查看告警」，草稿一律「继续填写」（管理员对草稿可见度为 full），未巡检「发起巡检」', await labels(ap),
      { damaged: Array(4).fill('查看告警'), warning: Array(7).fill('查看告警'), draft: Array(3).fill('继续填写'), due: Array(3).fill('发起巡检') });
    const wp = await open(2);
    await wp.goto(base(f) + '#all'); await waitTitle(wp, '待处理（17）'); await expand(wp);
    equal('D2 可写用户：本人草稿「继续填写」、他人草稿（summary）「查看」，未巡检「发起巡检」', await labels(wp),
      { damaged: Array(4).fill('查看告警'), warning: Array(7).fill('查看告警'), draft: ['查看', '继续填写', '继续填写'], due: Array(3).fill('发起巡检') });
    const rp = await open(3);
    await rp.goto(base(f) + '#all'); await waitTitle(rp, '待处理（17）'); await expand(rp);
    equal('D3 只读用户：全部「查看」', await labels(rp), { damaged: Array(4).fill('查看'), warning: Array(7).fill('查看'), draft: Array(3).fill('查看'), due: Array(3).fill('查看') });
    // clicks
    await wp.locator('#itlPending .itl-pending-item[data-pending-kind="damaged"] button').first().click();
    await wp.waitForFunction(() => document.querySelector('#itlDrawerTitle').textContent === '盘D1');
    check('D4 「查看告警」打开该资产抽屉（标题为 盘D1）', await wp.locator('#itlDrawer.open').count() === 1);
    await wp.locator('#itlDrawerClose').click(); await wp.locator('#itlDrawer').waitFor({ state: 'hidden' });
    await rowOf(wp, 'R-Drc ').locator('button').click(); await wp.locator('[data-tab="inspections"][aria-current="page"]').waitFor();
    equal('D5 他人草稿「查看」：进巡检视图、不报错', { hash: await wp.evaluate(() => location.hash), notice: await wp.locator('#itlNotice').isHidden() }, { hash: '#inspections', notice: true });
    await wp.goto(base(f) + '#all'); await waitTitle(wp, '待处理（17）'); await expand(wp);
    await rowOf(wp, 'R-Dra ').locator('button').click(); await wp.locator('.itl-sheet-title h2').waitFor();
    equal('D6 「继续填写」进入该草稿的填写页', { hash: await wp.evaluate(() => location.hash), form: (await wp.locator('.itl-sheet-title h2').innerText()).includes('R-Dra') }, { hash: '#inspections', form: true });
    await wp.goto(base(f) + '#all'); await waitTitle(wp, '待处理（17）'); await expand(wp);
    await rowOf(wp, 'R-Due1 ').locator('button').click(); await wp.locator('#itlModal.open').waitFor();
    equal('D7 「发起巡检」打开新增巡检弹窗、机房下拉选中该机房', { title: await wp.locator('#itlModalTitle').innerText(), room: await wp.locator('#itlModalBody select[name="room_name"]').inputValue(), hash: await wp.evaluate(() => location.hash) }, { title: '新增巡检', room: 'R-Due1', hash: '#inspections' });
    await wp.locator('#itlModalCancel').click();
    await rowOf(rp, 'R-Due1 ').locator('button').click(); await rp.locator('[data-tab="inspections"][aria-current="page"]').waitFor();
    equal('D8 只读「查看」（未巡检）进巡检视图', await rp.evaluate(() => location.hash), '#inspections');
    await rp.goto(base(f) + '#all'); await waitTitle(rp, '待处理（17）');
    await rp.locator('#itlPending .itl-pending-item[data-pending-kind="damaged"] button').first().click();
    await rp.waitForFunction(() => document.querySelector('#itlDrawerTitle').textContent === '盘D1');
    equal('D9 只读「查看」（损坏）打开同一抽屉', await rp.locator('#itlDrawerTitle').innerText(), '盘D1');

    // ===== E. 窄屏 =====
    for (const width of [768, 390]) {
      await ap.setViewportSize({ width, height: 900 });
      await collapse(ap);
      check('E 窄屏 ' + width + ' 收起态无页面横向溢出', await ap.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await expand(ap);
      check('E 窄屏 ' + width + ' 展开 17 条后无页面横向溢出（含超长名称）', await ap.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && (await mains(ap)).length === 17);
    }
    await ap.setViewportSize({ width: 1440, height: 1000 });

    // ===== F. 来源 A / B =====
    // F1: A fails -> block gone (table keeps the cache); recovers when A is back
    await ap.route('**/api/it-assets/racks', fail500);
    await refreshDone(ap);
    equal('F1 A 失败：块不显示、无条目，表格仍按旧缓存渲染', { visible: await visible(ap), items: await ap.locator('#itlPending .itl-pending-item').count(), rows: (await ap.locator('#itlTable tbody tr[data-detail-row]').count()) > 0 }, { visible: false, items: 0, rows: true });
    await ap.unroute('**/api/it-assets/racks'); await refreshDone(ap); await waitTitle(ap, '待处理（17）');
    check('F2 A 恢复后块回来', await visible(ap));
    // F3: B fails -> A entries stay, retry row, k excludes it; retry after the route is gone brings the inspection entries
    const bp = await open(1);
    await bp.route(OV, fail500);
    await bp.goto(base(f) + '#all'); await bp.locator('#itlPending .itl-pending-retry').waitFor();
    equal('F3 B 失败：A 的条目照常、k 不含重试行', { k: await title(bp), retry: await bp.locator('#itlPending .itl-pending-retry').textContent(), first: (await mains(bp)).slice(0, 2) }, { k: '待处理（11）', retry: '巡检数据没取到 · 重试', first: EXPECTED.slice(0, 2).map(e => e[0]) });
    await expand(bp);
    equal('F4 B 失败时无草稿 / 未巡检条目', await bp.locator('#itlPending [data-pending-kind="draft"],#itlPending [data-pending-kind="due"]').count(), 0);
    await bp.unroute(OV); await bp.locator('#itlPending [data-pending-action="retry"]').click(); await waitTitle(bp, '待处理（17）');
    equal('F5 重试成功：巡检条目出现、重试行消失', { retry: await bp.locator('#itlPending .itl-pending-retry').count(), draftsDue: await bp.locator('#itlPending [data-pending-kind="draft"],#itlPending [data-pending-kind="due"]').count() }, { retry: 0, draftsDue: 6 });
    // F6: first load with B held -> A entries first, no inspection rows
    const hp = await open(1);
    let release; const held = new Promise(r => { release = r; });
    await hp.route(OV, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
    await hp.goto(base(f) + '#all'); await hp.locator('#itlPending [data-pending-kind="damaged"]').first().waitFor();
    equal('F6 首次加载 B 挂起：A 条目先出现、巡检条目不占行', { k: await title(hp), inspection: await hp.locator('#itlPending [data-pending-kind="draft"],#itlPending [data-pending-kind="due"],#itlPending .itl-pending-retry').count() }, { k: '待处理（11）', inspection: 0 });
    release(); await waitTitle(hp, '待处理（17）');
    equal('F7 B 回来后补上巡检条目', await title(hp), '待处理（17）');
    // F8: both ready and empty -> no block; B failed with nothing from A -> retry-only block "待处理（0）"
    await B.rack('Z-Done-柜', 'Z-Done'); await B.submit('Z-Done');
    const ep = await open(1, f2);
    const ovDone = ep.waitForResponse(r => r.url().endsWith('/inspections/sheets/overview'));
    await ep.goto(base(f2) + '#all'); await ovDone; await ep.locator('#itlTable').waitFor(); await ep.waitForTimeout(200);
    equal('F8 A、B 都就绪且无条目：块不显示', { visible: await visible(ep), hidden: await ep.locator('#itlPending').getAttribute('hidden') !== null }, { visible: false, hidden: true });
    const ep2 = await open(1, f2);
    await ep2.route(OV, fail500);
    await ep2.goto(base(f2) + '#all'); await ep2.locator('#itlPending .itl-pending-retry').waitFor();
    equal('F9 A 无条目、B 失败：只显示重试行，标题「待处理（0）」', { k: await title(ep2), items: await ep2.locator('#itlPending .itl-pending-item[data-pending-kind]').count(), retry: await ep2.locator('#itlPending .itl-pending-retry').count() }, { k: '待处理（0）', items: 0, retry: 1 });
    await ep2.unroute(OV); await ep2.locator('#itlPending [data-pending-action="retry"]').click(); await ep2.waitForFunction(() => document.querySelector('#itlPending').hidden);
    equal('F10 重试成功且无条目：块消失', await visible(ep2), false);

    // ===== G. 清理：换账号、同令牌级别变化 =====
    await expand(ap);
    const cleared = await ap.evaluate(() => { localStorage.setItem('token', 'fixture-3'); window.dispatchEvent(new StorageEvent('storage', { key: 'token' })); return { pending: !!document.querySelector('#itlPending'), entries: ITLedger.pending.entries().length }; });
    equal('G1 换账号瞬间：旧块已移除、无残留条目', cleared, { pending: false, entries: 0 });
    await waitTitle(ap, '待处理（17）');
    equal('G2 换账号后从空状态重新加载：展开状态已清、只显示前 6 条、按钮按新账号（只读）', { rows: (await mains(ap)).length, more: await ap.locator('#itlPending .itl-pending-more').innerText(), buttons: [...new Set(await ap.locator('#itlPending .itl-pending-action').allTextContents())] }, { rows: 6, more: '还有 11 件', buttons: ['查看'] });
    await f.run("UPDATE it_asset_acl SET level='read' WHERE user_id=2");
    try {
      await refreshDone(wp); await wp.locator('[data-tab="all"]').click(); await waitTitle(wp, '待处理（17）'); await expand(wp);
      equal('G3 同令牌降为只读后刷新：「继续填写」「发起巡检」变「查看」', await labels(wp), { damaged: Array(4).fill('查看'), warning: Array(7).fill('查看'), draft: Array(3).fill('查看'), due: Array(3).fill('查看') });
    } finally { await f.run("UPDATE it_asset_acl SET level='write' WHERE user_id=2"); }

    // ===== H. 离开默认屏后刷新 -> 回来重新读取 B；过期响应丢弃；发起巡检全流程 =====
    await A.rack('R-Stale-柜', 'R-Stale'); await A.rack('R-Race-柜', 'R-Race'); await A.rack('R-Make-柜', 'R-Make'); await A.rack('R-Dup-柜', 'R-Dup');
    const sp = await open(1); const ovRequests = [];
    sp.on('request', r => { if (r.url().endsWith('/inspections/sheets/overview')) ovRequests.push(r.url()); });
    await sp.goto(base(f) + '#all'); await waitTitle(sp, '待处理（21）'); await expand(sp);
    equal('H1 新增 4 个未巡检机房后共 21 条，R-Stale 为「本周未巡检」', { k: await title(sp), due: (await mains(sp)).includes('R-Stale 本周未巡检') }, { k: '待处理（21）', due: true });
    await sp.locator('[data-tab="racks"]').click(); await sp.locator('.itl-rack-title').first().waitFor();
    await sp.evaluate(() => ITLedger.refresh());
    await A.draft('R-Stale');
    const requestsBefore = ovRequests.length;
    await sp.locator('[data-tab="all"]').click(); await waitTitle(sp, '待处理（21）');
    await sp.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent.startsWith('R-Stale 巡检草稿未提交')));
    equal('H2 在别的页签刷新过、回默认屏时重读 B（仅一次）：R-Stale 由「未巡检」变「草稿」', { requests: ovRequests.length - requestsBefore, due: (await mains(sp)).includes('R-Stale 本周未巡检') }, { requests: 1, due: false });
    // H3: two B requests in flight, the older one answered last -> it must be dropped
    const rp2 = await open(1);
    // fix 3 (codex 63 M5): the first interception reads the upstream body itself and proves R-Race has no draft in it before the test writes the draft;
    // the module's own settled counter (L.pending.handled) says when the released old response has been processed (no fixed sleep).
    let releaseOld, firstFetched; const heldOld = new Promise(r => { releaseOld = r; }), firstDone = new Promise(r => { firstFetched = r; }); let n = 0, firstHasDraft = null;
    await rp2.route(OV, async route => {
      n++;
      if (n === 1) { const response = await route.fetch(), json = await response.json(); firstHasDraft = !!json.rooms.find(r => r.room === 'R-Race').draft; firstFetched(); await heldOld; await route.fulfill({ response, json }); }
      else await route.continue();
    });
    await rp2.goto(base(f) + '#all'); await rp2.locator('#itlPending [data-pending-kind="damaged"]').first().waitFor();
    await expand(rp2);
    await firstDone;
    equal('H3a 前提：被扣住的第一份 B 响应里 R-Race 还没有草稿（写入草稿发生在它取到之后）', firstHasDraft, false);
    await A.draft('R-Race');
    await refreshDone(rp2);
    await rp2.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent.startsWith('R-Race 巡检草稿未提交')));
    equal('H3 第二次 B 先落地：R-Race 显示为草稿（此时第一次 B 仍挂起）', { draft: (await mains(rp2)).some(t => t.startsWith('R-Race 巡检草稿未提交')), requests: n }, { draft: true, requests: 2 });
    const handledBefore = await rp2.evaluate(() => ITLedger.pending.handled);
    releaseOld(); await rp2.waitForFunction(h => ITLedger.pending.handled > h, handledBefore);
    equal('H4 过期（先发后到）的 B 响应被丢弃：R-Race 仍是草稿、没有被改回「未巡检」', { stale: (await mains(rp2)).includes('R-Race 本周未巡检'), draft: (await mains(rp2)).some(t => t.startsWith('R-Race 巡检草稿未提交')) }, { stale: false, draft: true });
    // H5: "发起巡检" -> modal with the room preselected -> create -> that sheet's form (same as the inspection view's own button)
    const mp2 = await open(2);
    await mp2.goto(base(f) + '#all'); await waitTitle(mp2, '待处理（21）'); await expand(mp2);
    await rowOf(mp2, 'R-Make ').locator('button').click(); await mp2.locator('#itlModal.open').waitFor();
    equal('H5 弹窗预选 R-Make', await mp2.locator('#itlModalBody select[name="room_name"]').inputValue(), 'R-Make');
    await mp2.locator('#itlSubmit').click(); await mp2.locator('.itl-sheet-title h2').waitFor();
    equal('H6 创建成功后进入该单填写页（与巡检视图里手点「＋ 新增巡检」一致）', { form: (await mp2.locator('.itl-sheet-title h2').innerText()).includes('R-Make'), hash: await mp2.evaluate(() => location.hash) }, { form: true, hash: '#inspections' });
    // H7: refresh in flight when the button is pressed (page idle for > 10 s) and the room already has a draft by then -> the existing-draft dialog (409 branch)
    const dp = await open(2);
    await dp.goto(base(f) + '#all'); await waitTitle(dp, '待处理（21）'); await expand(dp);
    await A.draft('R-Dup', 2);
    await dp.waitForTimeout(10500);
    await rowOf(dp, 'R-Dup ').locator('button').click(); await dp.locator('#itlModal.open').waitFor();
    equal('H7 已有草稿：弹窗预选 R-Dup', await dp.locator('#itlModalBody select[name="room_name"]').inputValue(), 'R-Dup');
    await dp.locator('#itlSubmit').click(); await dp.waitForFunction(() => document.querySelector('#itlModalTitle').textContent === '该机房已有草稿');
    equal('H8 409 已有草稿分支：与巡检视图里手点「＋ 新增巡检」同一个「该机房已有草稿」弹窗，仍在巡检页签', { title: await dp.locator('#itlModalTitle').innerText(), hash: await dp.evaluate(() => location.hash) }, { title: '该机房已有草稿', hash: '#inspections' });

    // ===== I. 状态注入：缺观测日期排后、说明为空的措辞（服务端造不出，直接改页面状态再重绘） =====
    const ip = await open(1);
    await ip.goto(base(f) + '#all'); await waitTitle(ip, '待处理（21）'); await expand(ip);   // expanded: the alert row W1服务器 (9th) must be on screen for I1c
    const injected = await ip.evaluate(() => {
      const L = ITLedger, byName = n => L.state.assets.find(a => a.name === n).id;
      L.state.health[byName('盘A1')].observed_at = '';
      L.state.health[byName('盘D1')].reason = ''; L.state.health[byName('盘D1')].evidence = '';
      L.state.health[byName('W1服务器')].observed_at = 'not-a-date';   // non-empty but unparsable (an alert row, so the damaged-row order above is not affected)
      L.pending.paint();
      const infoOf = n => L.healthInfo(L.state.assets.find(a => a.name === n)).info;
      const rowSub = (kind, prefix) => [...document.querySelectorAll('#itlPending .itl-pending-item[data-pending-kind="' + kind + '"]')].filter(li => li.querySelector('.itl-pending-main').textContent.startsWith(prefix)).map(li => li.querySelector('.itl-pending-sub').textContent);
      return {
        damaged: [...document.querySelectorAll('#itlPending .itl-pending-item[data-pending-kind="damaged"]')].map(li => [li.querySelector('.itl-pending-main').textContent, li.querySelector('.itl-pending-sub').textContent]),
        infoA1: infoOf('盘A1'), infoD1: infoOf('盘D1'), warnW1: rowSub('warning', 'W1服务器 ')
      };
    });
    equal('I1 缺观测日期排该类最后；说明为空时「<资产名> 损坏」，第二行只剩观测日与判断状态（缺观测日期的行只剩判断状态）', injected.damaged,
      [['盘D1 损坏', HD_D], ['盘B1 损坏：备盘故障', HB_D], ['盘B2 损坏：备盘故障', HB_D], ['盘A1 损坏：原盘故障待更换', '运维已判断']]);
    // The two empty-value branches of healthInfo().info (the rack hover text; the detail line used to pin them before segment 7): no leading separator when observed_at is empty, no trailing one when the reason is empty.
    equal('I1b 机柜图悬停提示 info 的两个空值分支：观测时间为空 → 开头没有分隔符；原因与证据都为空 → 结尾没有分隔符', { infoA1: injected.infoA1, infoD1: injected.infoD1 },
      { infoA1: '运维已判断 · 原盘故障待更换', infoD1: '2026-10-08T04:00:00.000Z · 运维已判断' });
    equal('I1c 观测时间非空但解析不了（not-a-date）：告警行第二行只剩判断状态，不含该字符串', { sub: injected.warnW1, leaked: injected.warnW1.some(s => s.includes('not-a-date')) }, { sub: ['待运维判断'], leaked: false });

    // ===== K. 本期未巡检只列有机柜的机房（修复批 1 裁定 1） =====
    // R-Gone: inspected long ago, then its rack's room was renamed to R-Gone2 -> the overview still lists R-Gone (it survives only in old sheets) as "not inspected",
    // but nothing can be started there any more.
    await A.rack('R-Gone-柜', 'R-Gone'); const gone = await A.submit('R-Gone');
    await f.run('UPDATE it_inspection_sheets SET submitted_at=? WHERE id=?', [old.toISOString(), gone.id]);
    await f.run("UPDATE it_racks SET room='R-Gone2' WHERE room='R-Gone'");
    const goneOverview = (await A.api('GET', '/inspections/sheets/overview')).rooms;
    equal('K0 前提：概览里 R-Gone 仅存于旧巡检单（未巡检、无草稿），R-Gone2 有机柜', { gone: goneOverview.filter(r => r.room === 'R-Gone').map(r => [r.period_done, r.draft]), gone2: goneOverview.some(r => r.room === 'R-Gone2') }, { gone: [[false, null]], gone2: true });
    const gp = await open(1);
    await gp.goto(base(f) + '#all'); await gp.locator('#itlPending .itl-pending-title').waitFor(); await expand(gp);
    await gp.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent === 'R-Gone2 本周未巡检'));
    equal('K1 没有机柜的机房不出「本周未巡检」，有机柜的 R-Gone2 照常出', { gone: (await mains(gp)).includes('R-Gone 本周未巡检'), gone2: (await mains(gp)).includes('R-Gone2 本周未巡检') }, { gone: false, gone2: true });

    // ===== L. 点「发起巡检」后等待期间的保护（修复批 1 M-1 / M-2） =====
    for (const r of ['R-P1', 'R-P2', 'R-P3', 'R-P4', 'R-Q1', 'R-Q2', 'R-Q3', 'R-Q4']) await A.rack(r + '-柜', r);
    const lp1 = await open(2), lp2 = await open(2), lp3 = await open(2), lp4 = await open(2), lp5 = await open(2), lp6 = await open(2), lp7 = await open(2);
    for (const p of [lp1, lp2, lp3, lp4, lp5, lp6, lp7]) { await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await expand(p); }
    // P1 setup: leave the inspection view while it is in a form (the view's mode stays "form"), come back to #all, then idle > 10 s so the tab switch starts a refresh
    await rowOf(lp1, 'R-Dra ').locator('button').click(); await lp1.locator('.itl-sheet-title h2').waitFor();
    await lp1.evaluate(() => { location.hash = 'all'; });
    await lp1.locator('#itlPending .itl-pending-title').waitFor(); await expand(lp1);
    await lp1.waitForTimeout(10600);
    await lp1.route('**/api/it-assets/inspections/sheets', async route => { if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    await rowOf(lp1, 'R-P1 ').locator('button').click(); await lp1.locator('#itlModal.open').waitFor();
    equal('L1 从表单页回默认屏、空闲后点「发起巡检」：弹窗预选 R-P1', await lp1.locator('#itlModalBody select[name="room_name"]').inputValue(), 'R-P1');
    await lp1.locator('#itlSubmit').click();
    await lp1.waitForFunction(() => document.querySelector('.itl-sheet-title h2') || !document.querySelector('#itlToast').hidden, null, { timeout: 8000 });
    equal('L2 创建后进入新单填写页、没有「已创建巡检单」toast（刷新渲染排在弹窗快照之前）', { form: (await lp1.locator('.itl-sheet-title h2').count()) === 1 && (await lp1.locator('.itl-sheet-title h2').innerText()).includes('R-P1'), toastHidden: await lp1.locator('#itlToast').isHidden() }, { form: true, toastHidden: true });
    // P2: switch the account while the refresh is in flight (storage path, to another writer)
    const slowMe = p => p.route('**/api/it-assets/me', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    const settled = p => p.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy') && ITLedger.state.level);
    await slowMe(lp2); await slowMe(lp3); await slowMe(lp4); await slowMe(lp5); await slowMe(lp6); await slowMe(lp7);
    // premise of L3 / L4 / L5: right after the click the refresh is in flight and no dialog is open yet (otherwise these checks would pass vacuously)
    const inFlight = p => p.evaluate(() => ({ busy: document.querySelector('#itlContent').getAttribute('aria-busy'), modals: document.querySelectorAll('#itlModal.open').length }));
    await rowOf(lp2, 'R-P2 ').locator('button').click();
    equal('L3a 前提：点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp2), { busy: 'true', modals: 0 });
    await lp2.evaluate(() => { localStorage.setItem('token', 'fixture-5'); window.dispatchEvent(new StorageEvent('storage', { key: 'token' })); });
    await settled(lp2); await lp2.waitForTimeout(600);
    equal('L3 刷新等待期间换账号：最终不弹「新增巡检」', await lp2.locator('#itlModal.open').count(), 0);
    // P3: leave this view and come back while the refresh is in flight
    await rowOf(lp3, 'R-P3 ').locator('button').click();
    equal('L4a 前提：点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp3), { busy: 'true', modals: 0 });
    await lp3.locator('[data-tab="racks"]').click(); await lp3.locator('[data-tab="inspections"]').click();
    await settled(lp3); await lp3.waitForTimeout(600);
    equal('L4 刷新等待期间切走又切回巡检页签：最终不弹「新增巡检」', await lp3.locator('#itlModal.open').count(), 0);
    // L-1: a room that is not in the dialog's list (called directly: the block itself never offers such a room) -> notice, no dialog, stays on #all
    await lp4.evaluate(() => ITLedger.openNewInspection('不存在的机房'));
    equal('L5 机房不在可选列表：提示文字、无弹窗、仍在默认屏', { notice: await lp4.locator('#itlNotice').innerText(), noticeShown: await lp4.locator('#itlNotice').isVisible(), modals: await lp4.locator('#itlModal.open').count(), hash: await lp4.evaluate(() => location.hash) }, { notice: '该机房当前没有登记机柜，无法发起巡检。', noticeShown: true, modals: 0, hash: '#all' });
    // LOW-2: the click starts a refresh; while it is in flight R-P4's rack is renamed, so after the wait the room is gone from the list -> same notice, no dialog
    await rowOf(lp4, 'R-P4 ').locator('button').click();
    equal('L6a 前提：点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp4), { busy: 'true', modals: 0 });
    await f.run("UPDATE it_racks SET room='R-P4-moved' WHERE room='R-P4'");
    await settled(lp4); await lp4.waitForTimeout(600);
    equal('L6 等待期间该机房机柜被改名：等待后复查，出提示、无弹窗', { notice: await lp4.locator('#itlNotice').innerText(), modals: await lp4.locator('#itlModal.open').count() }, { notice: '该机房当前没有登记机柜，无法发起巡检。', modals: 0 });
    // fix 3 LOW-B. L7: two calls while the first is still waiting (the block is already gone after the first click, so the second is the same function called directly)
    await rowOf(lp5, 'R-Q1 ').locator('button').click();
    equal('L7a 前提：第一次点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp5), { busy: 'true', modals: 0 });
    await lp5.evaluate(() => { ITLedger.openNewInspection('R-Q2'); });
    await settled(lp5); await lp5.waitForTimeout(600);
    equal('L7 等待期间连发两次「发起巡检」（R-Q1、R-Q2）：只弹一个新增弹窗，预选的是第二次的 R-Q2', { modals: await lp5.locator('#itlModal.open').count(), title: await lp5.locator('#itlModalTitle').innerText(), room: await lp5.locator('#itlModalBody select[name="room_name"]').inputValue() }, { modals: 1, title: '新增巡检', room: 'R-Q2' });
    // L8: another dialog is opened during the wait -> it stays, the wait does not replace it with "新增巡检"
    await rowOf(lp6, 'R-Q3 ').locator('button').click();
    equal('L8a 前提：点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp6), { busy: 'true', modals: 0 });
    await lp6.evaluate(() => { ITLedger.openModal('占位弹窗', '<p>占位</p>', async () => {}, '确定'); });
    await settled(lp6); await lp6.waitForTimeout(600);
    equal('L8 等待期间已有别的弹窗：等待结束后仍只有这一个，内容不是「新增巡检」', { modals: await lp6.locator('#itlModal.open').count(), title: await lp6.locator('#itlModalTitle').innerText() }, { modals: 1, title: '占位弹窗' });
    // fix 3 (codex 63 M4): an access reset with the SAME token while waiting (storage event path) must also cancel the pending dialog, although the account can write again afterwards
    await rowOf(lp7, 'R-Q4 ').locator('button').click();
    equal('L9a 前提：点击后刷新在途（aria-busy）、弹窗尚未打开', await inFlight(lp7), { busy: 'true', modals: 0 });
    await lp7.evaluate(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'token' })); });
    await settled(lp7); await lp7.waitForTimeout(600);
    equal('L9 等待期间同令牌触发权限重置、恢复可写后：不弹「新增巡检」', { modals: await lp7.locator('#itlModal.open').count(), level: await lp7.evaluate(() => ITLedger.state.level) }, { modals: 0, level: 'write' });

    // ===== M. 恢复滚动位置后块才落地（修复批 1 H-1），在 f2（A 无条目、B 有一个未巡检机房）上做 =====
    for (let i = 0; i < 40; i++) await B.create({ category: 'laptop', name: '批量资产' + String(i).padStart(2, '0'), placement: { kind: 'depot' } });
    await B.rack('Z-Due-柜', 'Z-Due');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const probe = p => p.evaluate(() => { const el = document.elementFromPoint(700, 200), tr = el && el.closest('tr[data-detail-row]'); return { y: Math.round(scrollY), row: tr ? tr.dataset.detailRow : null }; });
    const scrolledPage = async delay => {
      const p = await open(1, f2, { viewport: { width: 1440, height: 900 } });
      await p.goto(base(f2) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor();
      await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await p.evaluate(() => window.scrollTo(0, 350)); await p.waitForFunction(() => scrollY > 100); await sleep(300);
      const before = await probe(p);
      await p.route(OV, async route => { await sleep(delay); await route.continue(); });
      await p.reload(); await p.locator('#itlTable').waitFor(); await p.waitForFunction(() => scrollY > 100);
      return { p, before };
    };
    const settle = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    {
      const { p, before } = await scrolledPage(1200);
      check('M0 前提：刷新后 B 还没回来（块未显示）时已恢复滚动', await p.locator('#itlPending').isHidden());
      await p.locator('#itlPending').waitFor({ state: 'visible' }); await settle(p);
      equal('M1 B 落地、块插到表格上方后，视口顶部的行与滚动位置和刷新前相同', { row: (await probe(p)).row, dy: Math.abs((await probe(p)).y - before.y) < 5 }, { row: before.row, dy: true });
      await p.close();
    }
    {
      const { p, before } = await scrolledPage(1500);
      await p.mouse.move(700, 300); await p.mouse.wheel(0, 500);
      await p.waitForFunction(y => scrollY > y + 300, before.y);
      const afterUser = await probe(p);
      await p.locator('#itlPending').waitFor({ state: 'visible' }); await settle(p);
      const finalState = await probe(p);
      check('M2 恢复后、B 落地前用户滚动过：B 落地后不把用户拉回恢复的位置', Math.abs(finalState.y - before.y) > 300 && finalState.y >= afterUser.y - 5, { before, afterUser, finalState });
      await p.close();
    }

    // ===== M3. 修复批 3：恢复后、B 落地前按一次键盘（keydown 作废），B 落地后不把用户拉回恢复位置 =====
    {
      const { p, before } = await scrolledPage(1500);
      await p.keyboard.press('End');
      await p.waitForFunction(y => scrollY > y + 300, before.y);
      const afterKey = await probe(p);
      await p.locator('#itlPending').waitFor({ state: 'visible' }); await settle(p);
      const finalState = await probe(p);
      check('M3 恢复后、B 落地前按过键盘：B 落地后不把用户拉回恢复的位置', Math.abs(finalState.y - before.y) > 300 && finalState.y >= afterKey.y - 5, { before, afterKey, finalState });
      await p.close();
    }

    // ===== O. 修复批 2 LOW-4(b)：切页签回默认屏、刷新占位期间迟到的 B 不改写恢复位置 =====
    // Since segment 6 F1 the late B is dropped by the refresh-generation check (the gen check in it-ledger-pending.js) before it reaches reapplyRestoredScroll. O1 stays green
    // even when that check and reapplyRestoredScroll's "refresh in flight" branch are both removed (MQ3 in the segment 6 evidence), so this block no longer locks either of them.
    {
      const p = await open(1, f2, { viewport: { width: 1440, height: 900 } });
      await p.goto(base(f2) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await settle(p);
      await p.evaluate(() => window.scrollTo(0, 800)); await p.waitForFunction(() => scrollY > 700); await sleep(300);
      const y0 = await p.evaluate(() => Math.round(scrollY));
      let n = 0, meDelay = 0;
      await p.route(OV, async route => { if (++n === 1) await sleep(3000); await route.continue(); });
      await p.route('**/api/it-assets/me', async route => { if (meDelay) await sleep(meDelay); await route.continue(); });
      await p.evaluate(() => ITLedger.refresh());            // A refresh; its B (the first overview request after the route is set) is held 3 s
      await settle(p); await sleep(200);
      await p.locator('[data-tab="racks"]').click(); await sleep(400);
      await p.evaluate(() => { ITLedger.state.healthDirty = true; });   // stands in for an inspection-sheet write elsewhere (api() sets it): the next tab switch to #all must refresh
      meDelay = 5000;
      const lateB = p.waitForResponse(r => r.url().endsWith('/inspections/sheets/overview'));
      await p.locator('[data-tab="all"]').click();
      const atSwitch = await p.evaluate(() => document.querySelector('#itlContent').getAttribute('aria-busy'));
      await lateB; await sleep(300);
      const during = await p.evaluate(() => ({ busy: document.querySelector('#itlContent').getAttribute('aria-busy'), ctxY: Math.round(ITLedger.state.scrollContexts.all.y) }));
      equal('O0 前提：切回默认屏后刷新占位在途（aria-busy），迟到的 B 恰好落在占位期间', { atSwitch, during: during.busy }, { atSwitch: 'true', during: 'true' });
      await p.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy'), null, { timeout: 20000 });
      await p.locator('#itlPending .itl-pending-title').waitFor(); await settle(p); await sleep(500); await settle(p);
      const yFinal = await p.evaluate(() => Math.round(scrollY));
      check('O1 迟到的 B 没有改写默认屏的保存位置，刷新完成后恢复位置仍是原来的 y（±5）', Math.abs(during.ctxY - y0) <= 5 && Math.abs(yFinal - y0) <= 5, { y0, during, yFinal });
      await p.close();
    }

    // ===== P. 修复批 3 LOW-A：第一次刷新挂上 y=800，其 B 被扣住；程序化滚到 300（不触发输入事件，restoredAll 仍挂着）；
    // 第二次刷新在途期间第一次的 B 落地，不得把页面拉回 800 =====
    // Written for the "refresh in flight" branch of reapplyRestoredScroll. Since segment 6 F1 two independent layers keep the late B from pulling the page back: the refresh-generation
    // drop (the gen check in it-ledger-pending.js) and that reapply branch. P0 goes red only when BOTH are removed (MQ3 in the segment 6 evidence); removing either one alone
    // leaves this block green, so P0 / P1 lock neither layer alone: the generation drop is locked by S0 and U8, the reapply branch has no dedicated assertion (MQ2 survives the whole suite).
    {
      const p = await open(1, f2, { viewport: { width: 1440, height: 900 } });
      await p.goto(base(f2) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await settle(p);
      await p.evaluate(() => window.scrollTo(0, 800)); await p.waitForFunction(() => scrollY > 700); await sleep(300);
      let n = 0, meDelay = 0;
      await p.route(OV, async route => { if (++n === 1) await sleep(3000); await route.continue(); });
      await p.route('**/api/it-assets/me', async route => { if (meDelay) await sleep(meDelay); await route.continue(); });
      await p.evaluate(() => ITLedger.refresh()); await settle(p); await sleep(200);     // R1: its render arms {y: 800}; its B is held 3 s
      await p.evaluate(() => window.scrollTo(0, 300)); await sleep(300);                 // programmatic: no input event, restoredAll stays armed
      meDelay = 5000;
      const lateB = p.waitForResponse(r => r.url().endsWith('/inspections/sheets/overview'));
      const r2 = p.evaluate(() => ITLedger.refresh()).catch(() => {});                    // R2: in flight ~5 s; R1's held B lands meanwhile (catch: a failed assertion below closes the page first)
      await lateB; await sleep(500);
      const during = await p.evaluate(() => ({ busy: document.querySelector('#itlContent').getAttribute('aria-busy'), y: Math.round(scrollY), ctxY: Math.round(ITLedger.state.scrollContexts.all.y) }));
      equal('P0 第一次的 B 落在第二次刷新在途期间，落地后（第二次刷新完成前）scrollY 与保存位置仍约 300', { busy: during.busy, y: Math.abs(during.y - 300) <= 5, ctxY: Math.abs(during.ctxY - 300) <= 5 }, { busy: 'true', y: true, ctxY: true });
      await r2;
      await p.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy'), null, { timeout: 20000 });
      await settle(p); await sleep(500); await settle(p);
      const yFinal = await p.evaluate(() => Math.round(scrollY));
      check('P1 第二次刷新完成后，最终位置与 300 相差 ≤5', Math.abs(yFinal - 300) <= 5, { yFinal });
      await p.close();
    }

    // ===== N. 修复批 2 MED-1：B 落地前打开抽屉，B 落地、关抽屉后被点的那一行仍在原视口位置 =====
    {
      const { p } = await scrolledPage(2500);
      await settle(p);
      const pointProbe = () => p.evaluate(() => { const el = document.elementFromPoint(300, 400), tr = el && el.closest('tr[data-detail-row]'); return { y: Math.round(scrollY), row: tr ? tr.dataset.detailRow : null, top: tr ? Math.round(tr.getBoundingClientRect().top) : null }; });
      const pre = await pointProbe();
      check('N0 前提：刷新恢复到中部、B 未回（块未显示）、视口点上有一行', pre.row !== null && pre.y > 100 && await p.locator('#itlPending').isHidden(), pre);
      await p.mouse.click(300, 400);
      await p.locator('.itl-detail-group').first().waitFor();
      await p.locator('#itlPending').waitFor({ state: 'visible' }); await settle(p); await sleep(200);
      await p.locator('#itlDrawerClose').click(); await settle(p); await sleep(300);
      const post = await p.evaluate(id => { const tr = document.querySelector('tr[data-detail-row="' + id + '"]'); return { top: Math.round(tr.getBoundingClientRect().top), y: Math.round(scrollY), ctxY: Math.round(ITLedger.state.scrollContexts.all.y) }; }, pre.row);
      check('N1 抽屉开着时 B 落地、关抽屉后：被点的行仍在点击时的视口位置（≤2px），保存的滚动位置与当前一致', Math.abs(post.top - pre.top) <= 2 && Math.abs(post.ctxY - post.y) <= 2, { pre, post });
      await p.close();
    }

    // ===== Q. 修复批 3 M3：离开默认屏前 B 在途，别的页签完成一次成功刷新，回默认屏（从缓存渲染）立即重发 B；旧 B 不覆盖新结果 =====
    await A.rack('R-S1-柜', 'R-S1');
    {
      const p = await open(1);
      let releaseOld, firstFetched; const heldOld = new Promise(r => { releaseOld = r; }), firstDone = new Promise(r => { firstFetched = r; }); let n = 0;
      await p.route(OV, async route => { n++; if (n === 1) { const response = await route.fetch(); firstFetched(); await heldOld; await route.fulfill({ response }); } else await route.continue(); });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await firstDone; await expand(p);
      await p.locator('[data-tab="racks"]').click(); await p.locator('.itl-rack-title').first().waitFor();
      await p.evaluate(() => ITLedger.refresh());                 // a successful refresh on another tab while B#1 is still held
      await A.draft('R-S1');
      await p.locator('[data-tab="all"]').click(); await p.locator('#itlPending .itl-pending-title').waitFor();
      await p.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent.startsWith('R-S1 巡检草稿未提交')), null, { timeout: 5000 }).catch(() => {});
      equal('Q1 回默认屏时立即发出新的 B（第二次请求），并显示 R-S1 已有草稿', { requests: n, draft: (await mains(p)).some(t => t.startsWith('R-S1 巡检草稿未提交')) }, { requests: 2, draft: true });
      const handledBefore = await p.evaluate(() => ITLedger.pending.handled);
      releaseOld(); await p.waitForFunction(h => ITLedger.pending.handled > h, handledBefore);
      equal('Q2 放行旧 B 后：不覆盖新结果（R-S1 仍是草稿、没有变回「未巡检」）', { due: (await mains(p)).includes('R-S1 本周未巡检'), draft: (await mains(p)).some(t => t.startsWith('R-S1 巡检草稿未提交')) }, { due: false, draft: true });
      await p.close();
    }

    // ===== S. 同页签两轮刷新交叠：第一轮的 B 在第二轮在途期间落地 → 被丢弃（块仍隐藏、滚动位置不变）；第二轮与它自己的 B 完成后块才出现，scrollY 与保存位置都不被块的插入改写（比 y，不比行） =====
    // Rewritten for #200 segment 6 fix batch 1 F1 (codex 65 M1; plan v1.5 5.4: B is bound to refreshSequence, a stale answer is dropped). This block was the C2 fix batch 3 / 4
    // M2 case, written when a late B WAS accepted: the block then appeared under the table while round 2 was in flight. That premise is gone: the late B is now dropped,
    // so the block can only appear after round 2 has finished and its own B (requested by round 2's onRefresh) has landed.
    // The saved position was recorded on a block-less layout, so once the block appears the row at the top of the viewport moves down by one block height: that is the
    // existing behaviour of reapplyRestoredScroll (it re-applies the restored ABSOLUTE y; registered residual), hence S1 compares y, not the row.
    // On this fixture the browser does no scroll anchoring when the block is inserted, and "remove the reapply call from the success callback" is turned red by block M (M1),
    // not by S1. S1's discriminating power comes from a mutation of the second round's restore TARGET (the restored y shifted by 150 px, MR500 in the segment 6 evidence).
    {
      // The page-load B is held from the start, so the table is on screen WITHOUT a block; round 2 starts while it is held. (Holding only a later B, after the block is
      // already painted, changes nothing on screen.)
      const p = await open(1, f2, { viewport: { width: 1440, height: 900 } });
      let n = 0, holdMe = false, releaseB1, releaseMe; const heldB1 = new Promise(r => { releaseB1 = r; }), heldMe = new Promise(r => { releaseMe = r; });
      await p.route(OV, async route => { if (++n === 1) { const response = await route.fetch(); await heldB1; await route.fulfill({ response }); } else await route.continue(); });
      await p.route('**/api/it-assets/me', async route => { if (holdMe) await heldMe; await route.continue(); });
      const view = () => p.evaluate(() => { const el = document.elementFromPoint(700, 200), tr = el && el.closest('tr[data-detail-row]'); return { y: Math.round(scrollY), ctxY: Math.round(ITLedger.state.scrollContexts.all?.y ?? -1), row: tr ? tr.dataset.detailRow : null, blockShown: !document.querySelector('#itlPending').hidden, busy: document.querySelector('#itlContent').getAttribute('aria-busy') }; });
      await p.goto(base(f2) + '#all'); await p.locator('#itlTable').waitFor();
      await p.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy') && ITLedger.state.level); await settle(p);
      await p.evaluate(() => window.scrollTo(0, 500)); await p.waitForFunction(() => scrollY > 400); await sleep(400);   // programmatic: no input event
      const before = await view();
      holdMe = true;
      const handled0 = await p.evaluate(() => ITLedger.pending.handled);
      const round2 = p.evaluate(() => ITLedger.refresh()).catch(() => {});   // round 2: in flight until /me is released
      await sleep(200);
      releaseB1(); await p.waitForFunction(h => ITLedger.pending.handled > h, handled0); await settle(p); await sleep(300);   // the held B lands during round 2: handled counts it, the module drops it
      const atLanding = await view();
      equal('S0 第一轮的 B 在第二轮在途期间落地：已落定但被丢弃——块仍隐藏、第二轮仍在途、scrollY 与保存位置都没变', { hiddenBefore: !before.blockShown, handled: (await p.evaluate(() => ITLedger.pending.handled)) > handled0, shown: atLanding.blockShown, busy: atLanding.busy, ySame: atLanding.y === before.y, ctxSame: atLanding.ctxY === before.ctxY }, { hiddenBefore: true, handled: true, shown: false, busy: 'true', ySame: true, ctxSame: true });
      releaseMe(); await round2;
      await p.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy'));
      await p.waitForFunction(() => !document.querySelector('#itlPending').hidden);   // round 2's own B has landed and drawn the block
      await settle(p); await sleep(500); await settle(p);
      const final = await view();
      equal('S1 第二轮与它自己的 B 完成、块已显示后：第二轮还原到的位置等于第二轮之前的位置，块出现后也没有被改写（比 y，不比行）', { blockShown: final.blockShown, y: final.y === before.y, ctxY: final.ctxY === before.ctxY, had: before.row !== null }, { blockShown: true, y: true, ctxY: true, had: true });
      await p.close();
    }

    // ===== T. 修复批 3 L1：B 落地重绘块后，键盘焦点仍在同一资产的按钮上 =====
    {
      const p = await open(1);
      let release; const held = new Promise(r => { release = r; });
      await p.route(OV, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending [data-pending-kind="damaged"]').first().waitFor();
      // fix 4 (LOW-2): focus the SECOND detail button, so a restore that matches by action only (landing on the first one) is caught
      const button = p.locator('#itlPending [data-pending-kind="damaged"] button').nth(1);
      await button.focus(); const id = await button.getAttribute('data-pending-id'); const titleBefore = await title(p);
      check('T0 前提：被聚焦的不是第一个「查看告警」按钮', id !== await p.locator('#itlPending [data-pending-kind="damaged"] button').first().getAttribute('data-pending-id'));
      release(); await p.waitForFunction(t => document.querySelector('#itlPending .itl-pending-title').textContent !== t, titleBefore);
      equal('T1 B 落地重绘后键盘焦点仍在同一资产（第二个）的「查看告警」上，不是同类动作的第一个', await p.evaluate(() => ({ inBlock: !!document.activeElement.closest('#itlPending'), action: document.activeElement.dataset.pendingAction, id: document.activeElement.dataset.pendingId })), { inBlock: true, action: 'detail', id });
      await p.close();
    }

    // ===== R. 修复批 3 M1：同令牌管理员降为非管理员（夹具改该账号的平台 role + 给 ACL write），新 B 到达前不显示旧级别下取的草稿动作 =====
    {
      const p = await open(1);
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await expand(p);
      await p.locator('#itlPending [data-pending-kind="draft"]').first().waitFor();   // B has landed (the title alone appears with the health entries)
      const draftLabels = () => p.evaluate(() => [...new Set([...document.querySelectorAll('#itlPending [data-pending-kind="draft"] .itl-pending-action')].map(b => b.textContent))]);
      equal('R0 前提：管理员对他人草稿看到「继续填写」', await draftLabels(), ['继续填写']);
      let hold = false, release; const held = new Promise(r => { release = r; });
      await p.route(OV, async route => { if (hold) await held; await route.continue(); });
      hold = true;
      try {
        fixtureUsers[1].role = 'user'; await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (1,'write',1)");
        await refreshDone(p);   // A under the new level; the new B is held
        equal('R1 降级后、新 B 到达前：旧管理员 B 的草稿 / 未巡检条目已撤下，没有重试行', await p.evaluate(() => ({ level: ITLedger.state.level, inspection: document.querySelectorAll('#itlPending [data-pending-kind="draft"],#itlPending [data-pending-kind="due"]').length, retry: document.querySelectorAll('#itlPending .itl-pending-retry').length, health: document.querySelectorAll('#itlPending [data-pending-kind="damaged"],#itlPending [data-pending-kind="warning"]').length > 0 })), { level: 'write', inspection: 0, retry: 0, health: true });
        release(); await p.waitForFunction(() => document.querySelectorAll('#itlPending [data-pending-kind="draft"]').length > 0);
        equal('R2 新 B 到达后：他人草稿只显示「查看」', await draftLabels(), ['查看']);
      } finally { fixtureUsers[1].role = 'admin'; await f.run('DELETE FROM it_asset_acl WHERE user_id=1'); }
      await p.close();
    }

    // fix 4 (LOW-1 a): the admin-era B is still in flight when the level changes. Between "state.level changed" (refresh sets it before its A requests) and
    // "the new B is issued" (after A) the old B lands: it must be judged by the level it was REQUESTED under, not by the level at landing.
    {
      const p = await open(1);
      let n = 0, holdRacks = false, release1, release2, releaseRacks; const held1 = new Promise(r => { release1 = r; }), held2 = new Promise(r => { release2 = r; }), heldRacks = new Promise(r => { releaseRacks = r; });
      await p.route(OV, async route => { n++; if (n === 1) { const response = await route.fetch(); await held1; await route.fulfill({ response }); } else if (n === 2) { await held2; await route.continue(); } else await route.continue(); });
      await p.route('**/api/it-assets/racks', async route => { if (holdRacks) await heldRacks; await route.continue(); });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending [data-pending-kind="damaged"]').first().waitFor();
      await expand(p);   // the collapsed block shows only the first 6 rows, which would hide a draft row from the counts below
      const counts = () => p.evaluate(() => ({ level: ITLedger.state.level, inspection: document.querySelectorAll('#itlPending [data-pending-kind="draft"],#itlPending [data-pending-kind="due"]').length, retry: document.querySelectorAll('#itlPending .itl-pending-retry').length }));
      try {
        fixtureUsers[1].role = 'user'; await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (1,'write',1)");
        holdRacks = true;
        const refreshing = p.evaluate(() => ITLedger.refresh()).catch(() => {});   // state.level changes first, then its A requests (racks held)
        await p.waitForFunction(() => ITLedger.state.level === 'write');
        const h0 = await p.evaluate(() => ITLedger.pending.handled);
        release1(); await p.waitForFunction(h => ITLedger.pending.handled > h, h0);   // the admin-era B lands now: level already new, new B not issued yet
        equal('R3 B 在途时级别变化：旧级别下取的 B 落地后不显示草稿 / 未巡检条目，也没有重试行', await counts(), { level: 'write', inspection: 0, retry: 0 });
        releaseRacks(); await refreshing;
        for (let i = 0; i < 100 && n < 2; i++) await sleep(50);   // the new B's request reaches the route handler a moment after refresh() returns
        equal('R3b A 完成、新 B 已发出（被扣住）时仍无巡检条目', { n, ...(await counts()) }, { n: 2, level: 'write', inspection: 0, retry: 0 });
        release2(); await expand(p); await p.waitForFunction(() => document.querySelectorAll('#itlPending [data-pending-kind="draft"]').length > 0);
        equal('R3c 新 B 放行后：他人草稿只显示「查看」', await p.evaluate(() => [...new Set([...document.querySelectorAll('#itlPending [data-pending-kind="draft"] .itl-pending-action')].map(b => b.textContent))]), ['查看']);
      } finally { fixtureUsers[1].role = 'admin'; await f.run('DELETE FROM it_asset_acl WHERE user_id=1'); }
      await p.close();
    }

    // fix 4 (LOW-1 b): the admin-era B FAILED (retry row on screen); after the level change the retry row of that old failure must not stay
    {
      const p = await open(1);
      let n = 0, release2; const held2 = new Promise(r => { release2 = r; });
      await p.route(OV, async route => { n++; if (n === 1) await fail500(route); else if (n === 2) { await held2; await route.continue(); } else await route.continue(); });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-retry').waitFor();
      try {
        fixtureUsers[1].role = 'user'; await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (1,'write',1)");
        await refreshDone(p);   // A under the new level; the new B is held
        equal('R4 旧级别下 B 失败（有重试行）→ 降级并刷新、新 B 未到：重试行已撤下', await p.evaluate(() => ({ level: ITLedger.state.level, retry: document.querySelectorAll('#itlPending .itl-pending-retry').length, health: document.querySelectorAll('#itlPending [data-pending-kind="damaged"]').length > 0 })), { level: 'write', retry: 0, health: true });
        release2();
      } finally { fixtureUsers[1].role = 'admin'; await f.run('DELETE FROM it_asset_acl WHERE user_id=1'); }
      await p.close();
    }

    // ===== U. 末次合并审修复批 1（codex 65 号）：F1 概览绑定刷新代次 / F2「继续填写」等切页刷新跑完 / F3「查看」落到概览 / F4 重试在途不重复发 =====
    const gate = () => { let release; const wait = new Promise(r => { release = r; }); return { wait, release }; };
    // A bounded "wait until a held request has arrived": wait() rejects with a named message after `seconds` (the timer starts when wait() is called), or at once when the
    // route handler calls bad(error) (fetching or parsing the upstream response threw). Without it a regression that stops the request from being sent would hang the script.
    const signal = (label, seconds = 15) => {
      let ok, bad; const promise = new Promise((resolve, reject) => { ok = resolve; bad = reject; }); promise.catch(() => {});
      return { ok, bad, wait: () => { const timer = setTimeout(() => bad(new Error(label + ' 未在 ' + seconds + ' 秒内到达')), seconds * 1000); return promise.finally(() => clearTimeout(timer)); } };
    };
    // Records, synchronously at fetch-call time, every GET of one sheet (/inspections/sheets/<id>) together with #itlContent's aria-busy at that instant.
    const recordSheetGets = p => p.addInitScript(() => {
      window.__sheetGets = []; const orig = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : input.url, method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          if (method === 'GET' && /\/inspections\/sheets\/\d+$/.test(url)) window.__sheetGets.push({ id: Number(url.split('/').pop()), busy: document.querySelector('#itlContent')?.getAttribute('aria-busy') ?? null });
        } catch (_) { /* recording only */ }
        return orig.apply(this, arguments);
      };
    });
    const holdMeOn = async p => { const g = gate(); let on = false; await p.route('**/api/it-assets/me', async route => { if (on) await g.wait; await route.continue(); }); return { on: () => { on = true; }, release: g.release }; };
    const sheetGets = p => p.evaluate(() => window.__sheetGets);
    const formRootId = p => p.evaluate(() => { const el = document.querySelector('[data-sheet-id]'); return el ? Number(el.dataset.sheetId) : null; });
    const gotGet = p => p.waitForFunction(() => window.__sheetGets.length >= 1, null, { timeout: 8000 });
    // F2: four pages (user 2: own drafts R-Dra / R-Drb show "继续填写"), all idle > 10 s so the tab switch to the inspection view starts a refresh (held at /me).
    const mkF2 = async () => {
      const p = await open(2); await recordSheetGets(p); const hold = await holdMeOn(p);
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await expand(p); await rowOf(p, 'R-Dra ').first().waitFor();
      return { p, hold };
    };
    const u1 = await mkF2(), u2 = await mkF2(), u3 = await mkF2(), u4 = await mkF2();
    await u4.p.waitForTimeout(10800);
    // premise only: the refresh is in flight. Whether the sheet GET was already sent is asserted by the main checks below (via aria-busy at call time), not here.
    const inFlightGets = p => p.evaluate(() => ({ busy: document.querySelector('#itlContent').getAttribute('aria-busy') }));
    // main: the sheet GET goes out only after the refresh has finished (aria-busy gone at call time), then the target draft's form opens
    u1.hold.on(); await rowOf(u1.p, 'R-Dra ').locator('button').click();
    equal('U1a 前提：点「继续填写」后切页刷新在途（aria-busy）', await inFlightGets(u1.p), { busy: 'true' });
    u1.hold.release(); await gotGet(u1.p); await settled(u1.p);
    equal('U1 「继续填写」：取单请求是刷新结束之后才发出的（发出时 #itlContent 无 aria-busy），只发一次、取的是目标草稿', await sheetGets(u1.p), [{ id: dra.id, busy: null }]);
    await u1.p.locator('[data-sheet-id]').waitFor({ timeout: 5000 }).catch(() => {});
    equal('U2 刷新结束后打开的是目标草稿 R-Dra 的填写页（按表单根上的单号核对，不按「有个表单」）', await formRootId(u1.p), dra.id);
    check('U2b 填写页标题含 R-Dra', (await u1.p.locator('.itl-sheet-title h2').innerText()).includes('R-Dra'));
    // leave the inspection tab while waiting -> nothing opens, no sheet GET
    u2.hold.on(); await rowOf(u2.p, 'R-Dra ').locator('button').click();
    equal('U3a 前提：点击后刷新在途（aria-busy）', await inFlightGets(u2.p), { busy: 'true' });
    await u2.p.locator('[data-tab="racks"]').click();
    u2.hold.release(); await settled(u2.p); await sleep(600);
    equal('U3 等待期间离开巡检页签：不打开填写页、不发取单请求', { gets: await sheetGets(u2.p), form: await formRootId(u2.p), tab: await u2.p.evaluate(() => ITLedger.state.tab) }, { gets: [], form: null, tab: 'racks' });
    // leave and come back while waiting -> the leave counter changed: nothing opens either
    u3.hold.on(); await rowOf(u3.p, 'R-Dra ').locator('button').click();
    equal('U4a 前提：点击后刷新在途（aria-busy）', await inFlightGets(u3.p), { busy: 'true' });
    await u3.p.locator('[data-tab="racks"]').click(); await u3.p.locator('[data-tab="inspections"]').click();
    u3.hold.release(); await settled(u3.p); await sleep(600);
    equal('U4 等待期间切走又切回巡检页签：不打开填写页、不发取单请求', { gets: await sheetGets(u3.p), form: await formRootId(u3.p), tab: await u3.p.evaluate(() => ITLedger.state.tab) }, { gets: [], form: null, tab: 'inspections' });
    // another "继续填写" while waiting -> only the later one opens (the block is gone after the first click, so the second is the same entry called directly)
    u4.hold.on(); await rowOf(u4.p, 'R-Dra ').locator('button').click();
    equal('U5a 前提：第一次点击后刷新在途（aria-busy）', await inFlightGets(u4.p), { busy: 'true' });
    await u4.p.evaluate(id => { ITLedger.openInspectionSheetWhenIdle(id); }, drb.id);
    u4.hold.release(); await gotGet(u4.p); await settled(u4.p); await u4.p.locator('[data-sheet-id]').waitFor({ timeout: 5000 }).catch(() => {}); await sleep(600);
    equal('U5 等待期间又点了另一条「继续填写」（R-Drb）：只发出后点的那张的取单请求，打开的也只有它', { gets: (await sheetGets(u4.p)).map(g => g.id), form: await formRootId(u4.p) }, { gets: [drb.id], form: drb.id });

    // F3: a draft the summary shows ("查看", action inspections) lands on the inspection overview, not on the sheet that was being looked at before
    {
      const p = await open(2);
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor();
      await p.evaluate(id => ITLedger.openInspectionSheet(id), due2.id);
      await p.locator('[data-sheet-id="' + due2.id + '"]').waitFor();
      await p.locator('[data-tab="all"]').click(); await p.locator('#itlPending .itl-pending-title').waitFor(); await expand(p);
      equal('U6a 前提：被点的是他人草稿 R-Drc 的「查看」（动作 inspections），巡检页签上次停在 due2 单的详情', { action: await rowOf(p, 'R-Drc ').locator('button').getAttribute('data-pending-action'), label: await rowOf(p, 'R-Drc ').locator('button').innerText() }, { action: 'inspections', label: '查看' });
      await rowOf(p, 'R-Drc ').locator('button').click();
      await p.locator('#itlInspOverview, [data-sheet-id]').first().waitFor(); await settled(p); await sleep(300);
      equal('U6 「查看」落到巡检概览（列表 + 机房概览），不恢复上次那张单的详情', await p.evaluate(() => ({ tab: ITLedger.state.tab, overview: !!document.querySelector('#itlInspOverview'), detail: document.querySelectorAll('[data-sheet-id]').length })), { tab: 'inspections', overview: true, detail: 0 });
      await p.close();
    }

    // F4: "重试" while the retry request is still in flight does not send a second one
    {
      const p = await open(1);
      let n = 0; const g = gate();
      await p.route(OV, async route => { n++; if (n === 1) await fail500(route); else { await g.wait; await route.continue(); } });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-retry').waitFor(); await expand(p);
      await p.evaluate(() => { const retry = () => document.querySelector('#itlPending [data-pending-action="retry"]'); retry().click(); retry().click(); });   // two clicks in the same tick, the request stays held
      g.release();
      await p.waitForFunction(() => !document.querySelector('#itlPending .itl-pending-retry') && document.querySelectorAll('#itlPending [data-pending-kind="draft"]').length > 0);
      equal('U7 请求在途时连点两次「重试」：只发出 1 次概览请求（连同首次失败共 2 次）；放行后条目出现、重试行消失', { total: n, retryRow: await p.locator('#itlPending .itl-pending-retry').count(), drafts: (await p.locator('#itlPending [data-pending-kind="draft"]').count()) > 0 }, { total: 2, retryRow: 0, drafts: true });
      await p.close();
    }

    // F1: B#1 in flight, a newer asset refresh starts (its asset requests held), B#1 lands -> dropped; the newer round's B#2 is shown after it finishes
    await A.rack('R-F1-柜', 'R-F1');
    {
      const p = await open(1);
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-title').waitFor(); await expand(p);
      await p.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent === 'R-F1 本周未巡检'));
      await A.draft('R-F1', 2);   // after the page-load B: only B#1 (requested below) knows about this draft
      const b1 = gate(), racks = gate(), b1Fetched = signal('U8 前提：第一轮概览请求（B#1）'); let n = 0, holdRacks = false;
      await p.route(OV, async route => {
        n++;
        if (n === 1) {
          try { const response = await route.fetch(), json = await response.json(); b1Fetched.ok(); await b1.wait; await route.fulfill({ response, json }); }
          catch (e) { b1Fetched.bad(new Error('U8 前提：第一轮概览请求取响应或解析失败：' + e.message)); await route.abort().catch(() => {}); }
        } else await route.continue();
      });
      await p.route('**/api/it-assets/racks', async route => { if (holdRacks) await racks.wait; await route.continue(); });
      await p.evaluate(() => ITLedger.refresh());   // round 1 succeeds, its onRefresh requests B#1 (held after its body was read)
      await b1Fetched.wait();
      holdRacks = true;
      const round2 = p.evaluate(() => ITLedger.refresh()).catch(() => {});   // round 2 starts (refresh generation moves on) and stays in flight: racks held
      await p.waitForFunction(() => document.querySelector('#itlContent').getAttribute('aria-busy') === 'true');
      const h0 = await p.evaluate(() => ITLedger.pending.handled);
      b1.release(); await p.waitForFunction(h => ITLedger.pending.handled > h, h0);
      equal('U8 B#1 在更新一轮资产刷新在途期间落地：被丢弃，块里没有 B#1 才有的「R-F1 巡检草稿未提交」，之前已接受的结果（R-F1 本周未巡检）继续显示', { draft: (await mains(p)).some(t => t.startsWith('R-F1 巡检草稿未提交')), due: (await mains(p)).includes('R-F1 本周未巡检'), busy: await p.evaluate(() => document.querySelector('#itlContent').getAttribute('aria-busy')) }, { draft: false, due: true, busy: 'true' });
      racks.release(); await round2;
      await p.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent.startsWith('R-F1 巡检草稿未提交')), null, { timeout: 8000 });
      equal('U9 放行第二轮后：第二轮的 B#2 显示「R-F1 巡检草稿未提交」，R-F1 不再是「未巡检」（被丢弃的 B#1 没有让块卡住）', { draft: (await mains(p)).some(t => t.startsWith('R-F1 巡检草稿未提交')), due: (await mains(p)).includes('R-F1 本周未巡检'), requests: n }, { draft: true, due: false, requests: 2 });
      await p.close();
    }

    // ===== V. 末次合并审修复批 2 G1：同一刷新代次里有两个概览请求时，后到的旧请求按序号丢弃（概览回调的 seq !== overviewSeq） =====
    // Since F1 a late B is usually dropped by the refresh-generation check first (U8). This block builds the case that check cannot catch: the older request R is sent while
    // round 2 is in flight (so its generation is the CURRENT one), the newer request N is sent by that same round's onRefresh (same generation, larger sequence number), N
    // lands first, R lands last. Only the sequence-number check tells them apart.
    await A.rack('R-V1-柜', 'R-V1');
    {
      const p = await open(1);
      let n = 0, rHasDraft = null, holdMe = false; const releaseR = gate(), meGate = gate(), rFetched = signal('V 前提：重试发出的概览请求（R）');
      await p.route(OV, async route => {
        n++;
        if (n === 1) await fail500(route);
        else if (n === 2) {
          try { const response = await route.fetch(), json = await response.json(); rHasDraft = !!json.rooms.find(r => r.room === 'R-V1')?.draft; rFetched.ok(); await releaseR.wait; await route.fulfill({ response, json }); }
          catch (e) { rFetched.bad(new Error('V 前提：重试发出的概览请求（R）取响应或解析失败：' + e.message)); await route.abort().catch(() => {}); }
        } else await route.continue();
      });
      await p.route('**/api/it-assets/me', async route => { if (holdMe) await meGate.wait; await route.continue(); });
      await p.goto(base(f) + '#all'); await p.locator('#itlPending .itl-pending-retry').waitFor(); await expand(p);   // B#1 (n = 1) failed: retry row, no request in flight
      holdMe = true;
      const round2 = p.evaluate(() => ITLedger.refresh()).catch(() => {});   // round 2 starts (generation moves on) and stays in flight: /me held
      await p.waitForFunction(() => document.querySelector('#itlContent').getAttribute('aria-busy') === 'true');
      await p.locator('#itlPending [data-pending-action="retry"]').click();   // R: sent with the current generation, held after its body was read
      await rFetched.wait();
      equal('V0 前提：R 已发出且被扣住时第二轮仍在途（aria-busy）、R 的内容里 R-V1 还没有草稿', { busy: await p.evaluate(() => document.querySelector('#itlContent').getAttribute('aria-busy')), requests: n, rHasDraft }, { busy: 'true', requests: 2, rHasDraft: false });
      await A.draft('R-V1', 2);   // only N (sent after this) knows about the draft
      meGate.release(); await round2;
      await p.waitForFunction(() => [...document.querySelectorAll('#itlPending .itl-pending-main')].some(e => e.textContent.startsWith('R-V1 巡检草稿未提交')), null, { timeout: 15000 });
      equal('V1 前提：第二轮完成、N 先落地：块显示 R-V1 的草稿（N 是第二个概览请求，R 仍被扣住）', { draft: (await mains(p)).some(t => t.startsWith('R-V1 巡检草稿未提交')), due: (await mains(p)).includes('R-V1 本周未巡检'), requests: n }, { draft: true, due: false, requests: 3 });
      const h0 = await p.evaluate(() => ITLedger.pending.handled);
      releaseR.release(); await p.waitForFunction(h => ITLedger.pending.handled > h, h0);
      equal('V2 放行旧请求 R：已落定但按序号丢弃，块里仍是 N 的内容（R-V1 仍是草稿，没有被改回「未巡检」）', { draft: (await mains(p)).some(t => t.startsWith('R-V1 巡检草稿未提交')), due: (await mains(p)).includes('R-V1 本周未巡检') }, { draft: true, due: false });
      await p.close();
    }

    // ===== W. 告警 / 损坏行显示修正（#200 段 7，用户人工观察后定）=====
    // Real collected data made the block's damaged / warning rows three lines tall, repeated the reason in the detail line and led it with the raw observed_at string.
    // W1 expectations are computed from the SEEDED inspection rows (their completed_at and judgement), the Asia/Shanghai day by UTC+8 arithmetic here, not by the product's shanghaiDay.
    // W2 no reason and no raw time string in the block. W3 the rack hover text (healthInfo().info) is still the old spelling (the rack-side twin is B3). W4 a long reason stays on one line.
    {
      const wp1 = await open(1);
      await wp1.goto(base(f) + '#all'); await wp1.locator('#itlPending .itl-pending-item[data-pending-kind="warning"]').first().waitFor(); await expand(wp1);
      const insp = await f.all('SELECT id,asset_name,completed_at,collection_status,judgement FROM it_device_inspections ORDER BY id');
      const dayOfIso = iso => { const d = new Date(Date.parse(iso) + 8 * 3600000); return (d.getUTCMonth() + 1) + ' 月 ' + d.getUTCDate() + ' 日观测'; };
      const detailOfHost = host => {
        const rs = insp.filter(r => r.asset_name === host), ok = rs.filter(r => r.collection_status !== 'failed'), src = ok[ok.length - 1];
        return [dayOfIso(src.completed_at), src.judgement ? '运维已判断' : '待运维判断', rs.some(r => r.id > src.id) ? '本次采集未形成新结论' : ''].filter(Boolean).join(' · ');
      };
      const hostOfDisk = { '盘D1': 'HD主机', '盘B1': 'HB主机', '盘B2': 'HB主机', '盘A1': 'HA主机' };
      const wMains = (await mains(wp1)).slice(0, 11), wSubs = (await subs(wp1)).slice(0, 11);
      const nameOf = m => m.slice(0, Math.min(...[' 损坏', ' 巡检告警'].map(w => m.indexOf(w)).filter(i => i >= 0)));
      equal('W1 前提：前 11 行是 4 条损坏 + 7 条告警', wMains.map(m => m.includes(' 巡检告警') ? 'warning' : 'damaged'), [...Array(4).fill('damaged'), ...Array(7).fill('warning')]);
      equal('W1 告警 / 损坏行第二行全等于「<观测日>观测 · 判断状态（· 本次采集未形成新结论）」，预期串由夹具的采集记录独立算出', wSubs, wMains.map(m => detailOfHost(hostOfDisk[nameOf(m)] || nameOf(m))));
      const reasons = wMains.map(m => m.slice(m.indexOf('：') + 1));
      check('W2 前提：11 行都带原因文字', wMains.every(m => m.includes('：')) && reasons.every(r => r.length > 0));
      check('W2 第二行不含该行的原因文字', wSubs.every((s, i) => !s.includes(reasons[i])), { wSubs, reasons });
      equal('W2 整个待处理块（含属性）里没有形如 YYYY-MM-DDT 的原始时间串', /\d{4}-\d{2}-\d{2}T/.test(await wp1.locator('#itlPending').evaluate(el => el.innerHTML)), false);
      const infoNames = ['盘D1', '盘B1', '盘A1', '盘B2', 'W1服务器', 'W2服务器', 'W3服务器', 'W4' + LONG, 'HD主机', 'HB主机', 'HA主机'];
      equal('W3 机柜图悬停提示 healthInfo(...).info 仍是改前的拼法（原始观测时间 · 判断状态 · 〔本次采集未形成新结论 ·〕原因），逐字等于手写字面量（机柜图一侧的孪生断言是 B3）',
        await wp1.evaluate(names => names.map(n => ITLedger.healthInfo(ITLedger.state.assets.find(a => a.name === n)).info), infoNames),
        [HD_INFO, HB_INFO, HA_INFO, HB_INFO, W1_INFO, W2_INFO, W3_INFO, W4_INFO, HD_INFO, HB_INFO, HA_INFO]);
      // W4: a very long reason (state injection, the same technique as block I: the server cannot produce one this long) keeps the title on one line at both widths
      const LONG_REASON = '极长的损坏原因说明，'.repeat(30);
      // A damaged row (盘B2) and an alert row (W2服务器, on screen because wp1 is expanded) both get the long reason; each is compared with a short row of its own kind.
      await wp1.evaluate(r => { const L = ITLedger; for (const n of ['盘B2', 'W2服务器']) L.state.health[L.state.assets.find(x => x.name === n).id].reason = r; L.pending.paint(); }, LONG_REASON);
      const measure = (kind, longPrefix, shortPrefix) => wp1.evaluate(([k, lp, sp]) => {
        const mainOf = t => [...document.querySelectorAll('#itlPending .itl-pending-item[data-pending-kind="' + k + '"]')].find(li => li.querySelector('.itl-pending-main').textContent.startsWith(t)).querySelector('.itl-pending-main');
        const long = mainOf(lp), short = mainOf(sp), block = document.querySelector('#itlPending'), h = e => Math.round(e.getBoundingClientRect().height * 100) / 100;
        return { longH: h(long), shortH: h(short), clipped: long.scrollWidth > long.clientWidth, title: long.getAttribute('title'), pageOverflow: document.documentElement.scrollWidth > innerWidth, blockOverflow: block.scrollWidth > block.clientWidth };
      }, [kind, longPrefix, shortPrefix]);
      for (const width of [1440, 390]) {
        await wp1.setViewportSize({ width, height: 1000 }); await wp1.waitForTimeout(300);
        const m = await measure('damaged', '盘B2', '盘D1');
        // "one line" = less than 1.5 x a short row of the same kind (a wrapped long reason is 4 lines, ~4 x), tolerant of a font fallback on another machine
        check('W4 ' + width + ' 宽：超长原因的损坏行标题只占一行（高度小于短标题行的 1.5 倍）且被截断（scrollWidth > clientWidth）', m.longH > 0 && m.longH < m.shortH * 1.5 && m.clipped, m);
        check('W4 ' + width + ' 宽：损坏行 title 属性含完整原因；页面与待处理块都不横向溢出', m.title.includes(LONG_REASON) && m.title.startsWith('盘B2 损坏：') && !m.pageOverflow && !m.blockOverflow, m);
        const w = await measure('warning', 'W2服务器 ', 'W1服务器 ');
        check('W4w ' + width + ' 宽：超长原因的告警行标题只占一行（高度小于短告警行的 1.5 倍）且被截断（scrollWidth > clientWidth）', w.longH > 0 && w.longH < w.shortH * 1.5 && w.clipped, w);
        check('W4w ' + width + ' 宽：告警行 title 属性含完整原因；页面与待处理块都不横向溢出', w.title.includes(LONG_REASON) && w.title.startsWith('W2服务器 巡检告警：') && !w.pageOverflow && !w.blockOverflow, w);
      }
      // The single-line rule is only for the two health kinds: a draft row and a not-inspected row keep normal wrapping (computed white-space is not nowrap), the health rows do have nowrap.
      equal('W4x 单行省略只作用于损坏 / 告警行：草稿行、未巡检行的标题 white-space 不是 nowrap，损坏 / 告警行是 nowrap', await wp1.evaluate(() => Object.fromEntries(['damaged', 'warning', 'draft', 'due'].map(k => [k, [...new Set([...document.querySelectorAll('#itlPending .itl-pending-item[data-pending-kind="' + k + '"] .itl-pending-main')].map(e => getComputedStyle(e).whiteSpace))]]))),
        { damaged: ['nowrap'], warning: ['nowrap'], draft: ['normal'], due: ['normal'] });
    }

    equal('Z 无浏览器异常', errors, []);
    console.log('PENDING_BROWSER PASS=' + pass + ' FAIL=0');
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    if (browser) await browser.close();
    await f.close(); await f2.close();
  }
}
main().catch(e => { console.error(e.stack); console.log('PENDING_BROWSER PASS=' + pass + ' FAIL=1'); process.exitCode = 1; });
