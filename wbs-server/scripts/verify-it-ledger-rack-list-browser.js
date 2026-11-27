'use strict';
// #200 C3: the rack overview card (diagram left, device list right), list-row click / focus return, the three move-mode states, D1 (drawer hides
// U count / slot count where they do not apply) and D2 (depot card name without marker prefix). Real ledger router on the fixture, headless chromium.
// Threat model: an honest implementation slip turns a named assertion red (list order, a prefix left in the name, a row click that enters placement mode,
// focus not returned or returned to a stale row, two states drawn in the same colour, a hidden field coming back, a depot name keeping its marker).
// Every expectation is a hand-written literal; the only value read from another product render path is the health mark of the front view, because the list
// must show "the same mark" (equal outerHTML), and its presence is also pinned by the literal "● " text.
// Baseline numbers: the diagram frame is 462 x 588 px, as before this change: the old single-rack card was 560px border-box, minus 2 x 1px border and
// 2 x 20px padding = 518px inner, minus the overview's own 1px border and 14 + 40px padding = 462px.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { createFixture } = require('./it-ledger-browser-fixture');
const createCollect = require('../routes/it-ledger/inspection-collect');
let pass = 0;
function equal(name, actual, expected) { assert.deepEqual(actual, expected, name); pass++; console.log('[OK] ' + name); }
function check(name, value, detail) { assert.ok(value, name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail))); pass++; console.log('[OK] ' + name); }

async function main() {
  const f = await createFixture({ cleanup: true });
  let browser; const contexts = []; const errors = [];
  try {
    const api = async (method, url, body, uid = 1, status = 200) => { const r = await f.api(method, url, body, uid); assert.equal(r.status, status, method + ' ' + url + ' ' + JSON.stringify(r.body)); return r.body; };
    const create = b => api('POST', '', b, 1, 201);
    const snap = (ip, sn, alerts) => ({ schema_version: 1, source_host: ip, server: { serial_number: sn }, volumes: [], physical_disks: [], virtual_disks: [], enclosures: [], alerts: alerts.map(message => ({ kind: 'server', message })), component_errors: [], cleanup_warnings: [], collection_status: 'success' });
    await createCollect({}).ensure({ run: f.run });

    // ---------- seed ----------
    const r1 = await api('POST', '/racks', { name: 'C3机柜', room: 'R-C3', u_total: 42 }, 1, 201);
    const r2 = await api('POST', '/racks', { name: 'C3空柜', room: 'R-C3', u_total: 20 }, 1, 201);
    // A: marker prefix + model + IP + 4 slots with 2 disks; B: 2U with IP + a health alert; C: 4U, no IP, no slots, model == name; D: 1U, model, IP, 2 slots no disks
    const A = await create({ category: 'server', name: '【采集告警】甲主机', model: 'M-Alpha', u_height: 2, slot_count: 4, attrs: { ip: '10.3.0.1' }, placement: { kind: 'rack', rack_id: r1.id, u_start: 10 } });
    const B = await create({ category: 'server', name: 'SrvB', sn: 'SRV-B', u_height: 2, attrs: { ip: '10.3.0.2' }, placement: { kind: 'rack', rack_id: r1.id, u_start: 20 } });
    const C = await create({ category: 'server', name: 'SrvC', model: 'SrvC', u_height: 4, placement: { kind: 'rack', rack_id: r1.id, u_start: 30 } });
    const D = await create({ category: 'server', name: 'SrvD', model: 'M-D', u_height: 1, slot_count: 2, attrs: { ip: '10.3.0.4' }, placement: { kind: 'rack', rack_id: r1.id, u_start: 5 } });
    for (const slot of [1, 2]) {
      const version = (await api('GET', '/' + A.id)).asset.version;
      await create({ category: 'disk', name: '盘' + slot, sn: 'C3-DSK-' + slot, attrs: { capacity: '4 TB', interface: 'SAS' }, placement: { kind: 'host', parent_asset_id: A.id, slot_no: slot }, peer_versions: { [A.id]: version } });
    }
    // third rack (42U, so the page is tall enough to scroll to it): one device with a long IP text and 2 slots, for the column-overflow check and the scroll-position check
    const r3 = await api('POST', '/racks', { name: 'C3长IP柜', room: 'R-C3', u_total: 42 }, 1, 201);
    const LONG_IP = '10.10.10.10（iDRAC）/10.10.10.11';
    const L1 = await create({ category: 'server', name: 'SrvL', u_height: 2, slot_count: 2, attrs: { ip: LONG_IP }, placement: { kind: 'rack', rack_id: r3.id, u_start: 5 } });
    await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES (?,?,?,?,?,?,?,?)', [B.id, 'SrvB', '10.3.0.2', '2026-10-09T04:00:00.000Z', '2026-10-09T04:00:00.000Z', 'success', JSON.stringify(snap('10.3.0.2', 'SRV-B', ['风扇告警B'])), 1]);
    // depot (D2), terminal (other view keeps its raw name), a server for the "上架" check
    const spare = await create({ category: 'server', name: 'E备机', u_height: 2, placement: { kind: 'depot' } });
    const depotA = await create({ category: 'server', name: '【采集告警】库房机', model: 'M-Depot', u_height: 1, placement: { kind: 'depot' } });
    const depotB = await create({ category: 'server', name: '【采集告警】', model: 'M-X', u_height: 1, placement: { kind: 'depot' } });
    const depotC = await create({ category: 'server', name: '【暂定】', u_height: 1, placement: { kind: 'depot' } });
    const laptop = await create({ category: 'laptop', name: '【采集告警】终端本', placement: { kind: 'custodian', custodian_name: '张三' } });

    browser = await chromium.launch({ headless: true });
    const open = async (uid, viewport = { width: 1440, height: 900 }) => {
      const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
      await context.addInitScript(u => localStorage.setItem('token', 'fixture-' + u), uid);
      contexts.push(context);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(f.base + '/IT_Ledger.html#racks'); await page.locator('.itl-rack-summary').first().waitFor();
      return page;
    };
    const card = id => '[data-overview-rack="' + id + '"]';
    const row = id => '[data-rack-list-asset="' + id + '"]';
    const openFront = async (p, id) => { await p.locator(row(id)).click(); await p.locator('#itlRackOverlay').waitFor({ state: 'visible' }); await p.locator('.itl-face-device.itl-selected').waitFor(); };
    const closeFront = async p => { await p.locator('[data-rack-command="close"]').click(); await p.locator('#itlRackOverlay').waitFor({ state: 'hidden' }); await p.waitForTimeout(150); };
    const activeRow = p => p.evaluate(() => document.activeElement?.closest?.('[data-rack-list-asset]')?.dataset.rackListAsset ?? null);

    // ===== A. list content =====
    const ap = await open(1);
    const cells = await ap.locator(card(r1.id) + ' .itl-rack-list-row').evaluateAll(rows => rows.map(r => ({
      id: r.dataset.rackListAsset, tag: r.tagName, type: r.getAttribute('type'),
      u: r.querySelector('.itl-rack-list-u').textContent, title: r.querySelector('.itl-rack-list-title').textContent,
      model: r.querySelector('.itl-rack-list-model')?.textContent ?? null, ip: r.querySelector('.itl-rack-list-ip').textContent,
      disk: r.querySelector('.itl-rack-list-disk').textContent, state: r.querySelector('.itl-rack-list-state').textContent,
      mark: r.querySelector('.itl-rack-list-state .itl-rack-health')?.outerHTML ?? null
    })));
    equal('A1 行数 = 该柜设备数 4，行顺序 = 顶端 U 降序（C 顶端 33、B 21、A 11、D 5）', cells.map(c => c.id), [C.id, B.id, A.id, D.id].map(String));
    equal('A2 行是 button[type=button]', cells.map(c => [c.tag, c.type]), [['BUTTON', 'button'], ['BUTTON', 'button'], ['BUTTON', 'button'], ['BUTTON', 'button']]);
    equal('A3 U 位格：多 U 写 U起–止，1U 只写 U起', cells.map(c => c.u), ['U30–33', 'U20–21', 'U10–11', 'U5']);
    equal('A4 名称格：去【采集告警】前缀；型号第二行只在有型号且与名称不同时出现（C 型号同名不显示）', cells.map(c => [c.title, c.model]), [['SrvC', null], ['SrvB', null], ['甲主机', 'M-Alpha'], ['SrvD', 'M-D']]);
    equal('A5 IP 格：无 IP 写「—」', cells.map(c => c.ip), ['—', '10.3.0.2', '10.3.0.1', '10.3.0.4']);
    equal('A6 盘位格：已用/总数；无盘位写「—」（A 装 2 盘 / 4 位，D 0 / 2）', cells.map(c => c.disk), ['—', '—', '2/4', '0/2']);
    await openFront(ap, B.id);
    const frontMark = await ap.locator('#itlRackFace [data-select-rack-asset="' + B.id + '"] .itl-rack-health').evaluate(el => el.outerHTML);
    await closeFront(ap);
    check('A7a 正视图里 B 的健康标记存在且以「● 」开头', frontMark.includes('>● '), frontMark);
    equal('A7 状态格：B 行的健康标记 outerHTML 与正视图同一设备的标记全等（且文字以「● 」开头）；其余设备写「—」', { mark: cells[1].mark, startsWithDot: cells[1].state.startsWith('● '), others: [cells[0], cells[2], cells[3]].map(c => [c.state, c.mark]) }, { mark: frontMark, startsWithDot: true, others: [['—', null], ['—', null], ['—', null]] });
    equal('A8 表头 5 列', await ap.locator(card(r1.id) + ' .itl-rack-list-head span').allTextContents(), ['U 位', '名称与型号', 'IP', '盘位', '状态']);
    equal('A9 清单行集合 = 示意图上画出的设备块集合（同一柜：4 行 / 4 块，title 里的名称一一对应）', await ap.evaluate(id => { const c = document.querySelector('[data-overview-rack="' + id + '"]'); return { rows: c.querySelectorAll('.itl-rack-list-row').length, blocks: c.querySelectorAll('.itl-rack-device').length, names: [...c.querySelectorAll('.itl-rack-device')].map(d => d.title.split(' · ')[0]).sort() }; }, r1.id), { rows: 4, blocks: 4, names: ['SrvB', 'SrvC', 'SrvD', '甲主机'] });
    equal('A10 U 位 / IP / 盘位单元格 font-variant-numeric 含 tabular-nums', await ap.locator(card(r1.id) + ' .itl-rack-list-row').first().evaluate(r => ['.itl-rack-list-u', '.itl-rack-list-ip', '.itl-rack-list-disk'].map(s => getComputedStyle(r.querySelector(s)).fontVariantNumeric.includes('tabular-nums'))), [true, true, true]);
    equal('A11 行内字号 13px，型号小字 12px，表头 12px（五档内）', await ap.evaluate(id => { const c = document.querySelector('[data-overview-rack="' + id + '"]'); const fs = s => getComputedStyle(c.querySelector(s)).fontSize; return [fs('.itl-rack-list-title'), fs('.itl-rack-list-model'), fs('.itl-rack-list-head span')]; }, r1.id), ['13px', '12px', '12px']);
    equal('A12 空机柜：只有一行「暂无设备」，没有表头、没有行', await ap.evaluate(id => { const l = document.querySelector('[data-overview-rack="' + id + '"] .itl-rack-list'); return { text: l.textContent.trim(), head: l.querySelectorAll('.itl-rack-list-head').length, rows: l.querySelectorAll('.itl-rack-list-row').length, p: l.querySelectorAll('p.itl-muted').length }; }, r2.id), { text: '暂无设备', head: 0, rows: 0, p: 1 });
    equal('A13 清单里没有被禁用的类名 / 属性', await ap.evaluate(() => ({ panel: document.querySelectorAll('.itl-rack-list .itl-overview-panel, .itl-rack-list .itl-card, .itl-rack-list [class*="itl-overview-"], .itl-rack-list [data-detail], .itl-rack-list [data-action], .itl-rack-list [data-open-rack]').length })), { panel: 0 });

    // ===== B. layout =====
    const geo = p => p.evaluate(id => { const c = document.querySelector('[data-overview-rack="' + id + '"]'), arr = document.querySelector('.itl-rack-array'), r = e => e.getBoundingClientRect(); const fr = r(c.querySelector('.itl-rack-frame')), l = r(c.querySelector('.itl-rack-list')), main = r(c.querySelector('.itl-rack-main')), rows = [...c.querySelectorAll('.itl-rack-list-row')]; return { cardW: r(c).width, arrW: r(arr).width, frameW: fr.width, frameH: fr.height, frameRight: fr.right, listLeft: l.left, listTop: l.top, mainBottom: main.bottom, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, rowsFit: rows.every(x => x.scrollWidth <= x.clientWidth + 1), headShown: getComputedStyle(c.querySelector('.itl-rack-list-head')).display !== 'none' }; }, r1.id);
    let g = await geo(ap);
    check('B1 1440 宽：卡片宽 = 阵列宽（一列，用满内容区）', Math.abs(g.cardW - g.arrW) < 2, g);
    check('B2 1440 宽：清单在示意图右侧（清单 left ≥ 示意图 right）', g.listLeft >= g.frameRight, g);
    check('B3 1440 宽：示意图 462 × 588 与改前一致（改前单柜卡片 560 border-box → 内宽 518 → 示意图 462）', Math.abs(g.frameW - 462) < 1 && Math.abs(g.frameH - 588) < 1, g);
    check('B4 1440 宽：表头显示、行内容不超出行、无横向溢出', g.headShown && g.rowsFit && g.scrollW <= g.innerW, g);
    equal('B4b 1440 宽：长 IP 文字（' + LONG_IP + '）在 IP 格内折行，IP 文字的实际右缘不越过盘位格左缘，行不溢出', await ap.evaluate(id => { const r = document.querySelector('[data-rack-list-asset="' + id + '"]'), ip = r.querySelector('.itl-rack-list-ip'), disk = r.querySelector('.itl-rack-list-disk'), rg = document.createRange(), b = disk.getBoundingClientRect(); rg.selectNodeContents(ip); const a = rg.getBoundingClientRect(); /* the text's own extent, not the grid track box (which never overlaps) */ return { noOverlap: a.right <= b.left + 0.5, ipFits: ip.scrollWidth <= ip.clientWidth + 1, rowFits: r.scrollWidth <= r.clientWidth + 1, ipText: ip.textContent, diskText: disk.textContent }; }, L1.id), { noOverlap: true, ipFits: true, rowFits: true, ipText: LONG_IP, diskText: '0/2' });
    for (const [w, head] of [[1363, false], [1364, true]]) {
      await ap.setViewportSize({ width: w, height: 900 }); g = await geo(ap);
      check('B4c ' + w + ' 宽（窄清单断点边界：1363 及以下两行写法，1364 起表格写法）：表头' + (head ? '显示' : '隐藏') + '，行内容不超出行，无横向溢出，清单在示意图右侧', g.headShown === head && g.rowsFit && g.scrollW <= g.innerW && g.listLeft >= g.frameRight, g);
    }
    await ap.setViewportSize({ width: 1180, height: 900 }); g = await geo(ap);
    check('B5 1180 宽（两栏、清单变窄）：无横向溢出，行内容不超出行（窄清单改两行写法）', g.scrollW <= g.innerW && g.rowsFit && !g.headShown && g.listLeft >= g.frameRight, g);
    await ap.setViewportSize({ width: 1024, height: 900 }); g = await geo(ap);
    check('B6 1024 宽：清单落到左栏（示意图、硬盘入口、利用率）下方（清单 top ≥ 左栏 bottom）', g.listTop >= g.mainBottom - 0.5, g);
    check('B7 1024 宽：无横向溢出', g.scrollW <= g.innerW, g);
    await ap.setViewportSize({ width: 390, height: 844 }); g = await geo(ap);
    check('B8 390 宽：无横向溢出，清单行不超出行，清单在示意图下方', g.scrollW <= g.innerW && g.rowsFit && g.listTop >= g.mainBottom - 0.5, g);

    // B9: the long-IP row at the narrow widths (1101: two-column card with the two-line rows; 390: phone), and the card breakpoint itself (1100 = list under the diagram, 1101 = list on the right)
    const longRow = (p, rackId) => p.evaluate(({ id, rid }) => { const r = document.querySelector('[data-rack-list-asset="' + id + '"]'), list = r.closest('.itl-rack-list'), ip = r.querySelector('.itl-rack-list-ip'), disk = r.querySelector('.itl-rack-list-disk'), rg = document.createRange(), c = document.querySelector('[data-overview-rack="' + rid + '"]'); rg.selectNodeContents(ip); const a = rg.getBoundingClientRect(), b = disk.getBoundingClientRect(), rr = r.getBoundingClientRect(), lr = list.getBoundingClientRect(), ov = c.querySelector('.itl-rack-overview').getBoundingClientRect(); return { textRightBeforeDisk: a.right <= b.left + 0.5, rowInsideList: rr.right <= lr.right + 0.5 && r.scrollWidth <= r.clientWidth + 1, pageFits: document.documentElement.scrollWidth <= innerWidth, listBelowDiagram: lr.top >= ov.bottom - 0.5, listRightOfDiagram: lr.left >= ov.right - 0.5, ipText: ip.textContent }; }, { id: L1.id, rid: rackId });
    for (const [w, below] of [[1100, true], [1101, false], [390, true]]) {
      await ap.setViewportSize({ width: w, height: 900 });
      const s = await longRow(ap, r3.id);
      equal('B9 ' + w + ' 宽：长 IP 行的 IP 文字不越过盘位格、行不溢出清单、页面无横向滚动；清单在示意图' + (below ? '下方' : '右侧'), { text: s.textRightBeforeDisk, row: s.rowInsideList, page: s.pageFits, layout: below ? s.listBelowDiagram : s.listRightOfDiagram, ipText: s.ipText }, { text: true, row: true, page: true, layout: true, ipText: LONG_IP });
    }

    // ===== C. click = locate only, all three permission levels =====
    for (const [uid, label] of [[1, '管理员'], [2, '可写'], [3, '只读']]) {
      const p = await open(uid);
      await openFront(p, A.id);
      equal('C' + uid + ' ' + label + '：点清单行 → 正视图打开、该设备带 itl-selected、不在选位（无 can-place / preview / 取消选位）', await p.evaluate(id => ({ selected: document.querySelector('[data-select-rack-asset="' + id + '"]').classList.contains('itl-selected'), canPlace: document.querySelectorAll('.itl-can-place').length, preview: document.querySelectorAll('.itl-preview').length, cancel: document.querySelectorAll('[data-rack-command="cancel"]').length, title: document.querySelector('#itlRackTitle').textContent }), A.id), { selected: true, canPlace: 0, preview: 0, cancel: 0, title: 'C3机柜 · 42U 正视图' });
      await p.close();
    }

    // ===== D. placement entries still work =====
    {
      const p = await open(1);
      await p.locator('[data-tab="depot"]').click();
      const spareCard = p.locator('.itl-card').filter({ has: p.getByRole('button', { name: 'E备机', exact: true }) });
      await spareCard.locator('.itl-menu summary').click(); await spareCard.locator('[data-action="rack_in"]').click();
      await p.locator('#itlRackOverlay').waitFor({ state: 'visible' }); await p.locator('.itl-can-place').first().waitFor();
      check('D1 库房设备「上架」仍进选位（出现 .itl-can-place）', await p.locator('.itl-can-place').count() > 0);
      await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.locator('#itlRackOverlay').waitFor({ state: 'hidden' });
      await p.locator('[data-tab="racks"]').click(); await p.locator(row(A.id)).waitFor();
      await openFront(p, A.id); await p.locator('[data-rack-command="move"]').click(); await p.locator('.itl-can-place').first().waitFor();
      check('D2 正视图「移位 / 迁柜」仍进选位（出现 .itl-can-place）', await p.locator('.itl-can-place').count() > 0);
      await p.close();
    }

    // ===== E. focus return =====
    {
      const p = await open(1);
      await openFront(p, A.id); await closeFront(p);
      equal('E1 从清单行打开 → 关闭：焦点回到同一设备的清单行', await activeRow(p), String(A.id));
      await openFront(p, B.id);
      await p.evaluate(() => { document.querySelectorAll('[data-rack-list-asset]').forEach(r => { r.__old = true; }); });
      await p.evaluate(() => ITLedger.refresh());
      check('E2a 打开期间 ITLedger.refresh() 让总览重绘（旧行已被换掉）', await p.evaluate(id => { const r = document.querySelector('[data-rack-list-asset="' + id + '"]'); return !!r && !r.__old; }, B.id));
      await closeFront(p);
      equal('E2 关闭后焦点落到重绘后新渲染的同 id 行', await p.evaluate(() => { const r = document.activeElement?.closest?.('[data-rack-list-asset]'); return r ? { id: r.dataset.rackListAsset, fresh: !r.__old } : null; }), { id: String(B.id), fresh: true });
      await p.locator(card(r1.id) + ' .itl-rack-frame').click(); await p.locator('#itlRackOverlay').waitFor({ state: 'visible' }); await closeFront(p);
      equal('E3 从示意图打开再关闭：焦点不在任何清单行（行为与改前相同：总览重绘后原按钮已不在，焦点回到页面）', await activeRow(p), null);
      await openFront(p, A.id); await closeFront(p);
      await p.locator(card(r1.id) + ' .itl-rack-frame').click(); await p.locator('#itlRackOverlay').waitFor({ state: 'visible' }); await closeFront(p);
      equal('E4 清单行打开 → 关闭 → 再从示意图打开并关闭：不会跳回上次的清单行（记下的 id 已清）', await activeRow(p), null);
      await p.close();
    }

    // E5: scrolled down on the overview, idle longer than the auto-refresh gap (AUTO_REFRESH_MIN_MS = 10 s, it-ledger.js:27), then a list row: setTab() inside
    // locateRackAsset swaps the overview for a placeholder that collapses the page, so open() used to read scrollY 0 and close() jumped to the top.
    {
      const p = await open(1, { width: 1440, height: 900 });
      await p.locator(row(L1.id)).scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
      const before = await p.evaluate(() => scrollY);
      await p.waitForTimeout(10500);
      // Bind the premise: record whether the auto-refresh placeholder (it-ledger.js:207, <div class="itl-empty">正在读取…</div>) is put into #itlContent after the click.
      await p.evaluate(() => { window.__itlPlaceholderSeen = false; new MutationObserver(records => { for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches('.itl-empty') && n.textContent.trim() === '正在读取…') window.__itlPlaceholderSeen = true; }).observe(document.querySelector('#itlContent'), { childList: true, subtree: true }); });
      await p.locator(row(L1.id)).click(); await p.locator('#itlRackOverlay').waitFor({ state: 'visible' }); await p.locator('.itl-face-device.itl-selected').waitFor();
      const placeholderSeen = await p.evaluate(() => window.__itlPlaceholderSeen);
      check('E5b 前提：点击清单行后自动刷新占位符「正在读取…」出现过（否则 E5 没有测到它要防的场景）', placeholderSeen === true, placeholderSeen);
      // E5c: count scrollIntoView calls (original still runs) while closing; the row is already in the viewport, so close() must not call it.
      await p.evaluate(() => { window.__sivCalls = 0; const orig = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...args) { window.__sivCalls++; return orig.apply(this, args); }; });
      await closeFront(p);
      const sivCalls = await p.evaluate(() => window.__sivCalls);
      const after = await p.evaluate(id => { const r = document.querySelector('[data-rack-list-asset="' + id + '"]').getBoundingClientRect(); return { y: scrollY, rowOnScreen: r.bottom > 0 && r.top < innerHeight }; }, L1.id);
      check('E5c 行原本在视口内：关闭时 scrollIntoView 调用 0 次', sivCalls === 0, sivCalls);
      check('E5a 前提：点击前页面确实滚到了下方（scrollY > 800）', before > 800, before);
      check('E5 滚到最后一个机柜、空闲 10.5 秒后点清单行、关闭：scrollY 与点击前相差 ≤ 1，该行在视口内', Math.abs(after.y - before) <= 1 && after.rowOnScreen, { before, after });
      await p.close();
    }

    // E6: open SrvD from its row in the FIRST rack's card, move it (front view: 移位 / 迁柜 -> switch to the LAST rack -> click a free U; the existing rack_move flow, admin) to the last rack, close:
    // the focused row is now the device's new row in the last card, far below where the page is scrolled back to, so it must be scrolled into view.
    {
      const p = await open(1, { width: 1440, height: 900 });
      const scrollBefore6 = await p.evaluate(() => scrollY);
      await openFront(p, D.id);
      await p.locator('[data-rack-command="move"]').click(); await p.locator('[data-rack-command="cancel"]').waitFor();
      // E6c: same-number U in ANOTHER rack: SrvD's own start U is 5 in the first rack; in the empty second rack U5 is a normal free cell (can place + preview of SrvD's 1U height)
      await p.locator('[data-switch-rack="' + r2.id + '"]').click(); await p.locator('[data-switch-rack="' + r2.id + '"][aria-current="page"]').waitFor();
      await p.locator('[data-u="5"]').hover(); await p.waitForTimeout(150);
      equal('E6c 跨柜同号 U：切到空的第二个机柜，SrvD 原起始 U5 的同号格是可放置、悬停出现预览（SrvD 1U，预览 1 格）', await p.evaluate(() => ({ can: document.querySelector('[data-u="5"]').classList.contains('itl-can-place'), preview: document.querySelectorAll('.itl-preview').length })), { can: true, preview: 1 });
      await p.locator('[data-switch-rack="' + r3.id + '"]').click(); await p.locator('[data-u="20"].itl-can-place').waitFor();
      const moved = p.waitForResponse(res => res.url().endsWith('/actions/rack_move')); await p.locator('[data-u="20"]').click();
      check('E6a 前提：迁柜请求真实 200（SrvD 迁到最后一个机柜 U20）', (await moved).status() === 200);
      await p.locator('#itlRackMessage').filter({ hasText: '位置已保存' }).waitFor();
      await closeFront(p);
      const newRow = await p.evaluate(({ id, before }) => { const r = document.querySelector('[data-rack-list-asset="' + id + '"]'); return { belowRestoredViewport: r.getBoundingClientRect().top + scrollY >= before + innerHeight }; }, { id: D.id, before: scrollBefore6 });
      check('E6b 前提：迁柜后的新行在恢复视口之外（行的文档位置 ≥ 点击前 scrollY + 视口高）', newRow.belowRestoredViewport === true, newRow);
      equal('E6 关闭后焦点是 SrvD 在最后一个机柜卡片里的新清单行，且在视口内', await p.evaluate(id => { const a = document.activeElement, r = a?.closest?.('[data-rack-list-asset]'); if (!r) return null; const b = r.getBoundingClientRect(); return { id: r.dataset.rackListAsset, inCard: r.closest('[data-overview-rack]').dataset.overviewRack, inViewport: b.bottom > 0 && b.top < innerHeight }; }, D.id), { id: String(D.id), inCard: String(r3.id), inViewport: true });
      await p.close();
    }

    // ===== F. three move-mode states are told apart =====
    {
      const p = await open(1, { width: 1440, height: 1000 });
      await openFront(p, A.id);
      const style = (sel, props) => p.locator(sel).first().evaluate((el, ps) => { const cs = getComputedStyle(el); return Object.fromEntries(ps.map(k => [k, cs[k]])); }, props);
      // Screenshots only when ITL_C3_SHOTS names a directory (for the user's sign-off); without it nothing is written.
      const shot = async name => { const dir = process.env.ITL_C3_SHOTS; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); await p.locator('.itl-rack-left').screenshot({ path: path.join(dir, name) }); };
      const selectedOnly = await style('.itl-face-device.itl-selected', ['outlineColor', 'outlineStyle', 'outlineWidth', 'outlineOffset']);
      await shot('state-1-selected.png');
      await p.locator('[data-rack-command="move"]').click(); await p.locator('.itl-can-place').first().waitFor();
      const selected = await style('.itl-face-device.itl-selected', ['outlineColor', 'outlineStyle']);
      const can = await style('.itl-u-cell.itl-can-place', ['backgroundColor', 'borderTopColor', 'borderTopStyle', 'borderTopWidth']);
      const deviceBlock = await style('.itl-face-device', ['borderTopStyle']);
      await shot('state-2-can-place.png');
      await p.locator('[data-u="14"]').hover(); await p.locator('.itl-preview').first().waitFor();
      const prev = await style('.itl-u-cell.itl-preview', ['backgroundColor', 'outlineColor', 'outlineStyle', 'outlineWidth']);
      const canWhilePreview = await style('.itl-u-cell.itl-can-place:not(.itl-preview)', ['backgroundColor', 'borderTopColor']);
      const accent = await p.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--color-accent)'; document.querySelector('#itlRackOverlay').appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
      await shot('state-3-preview.png');
      equal('F1 选中设备：近黑实线描边 2px、偏移 1px（只改描边）', selectedOnly, { outlineColor: 'rgb(29, 31, 32)', outlineStyle: 'solid', outlineWidth: '2px', outlineOffset: '1px' });
      equal('F2 预览落点：实心 accent 底 + 近黑虚线描边', { bg: prev.backgroundColor, oc: prev.outlineColor, os: prev.outlineStyle, ow: prev.outlineWidth }, { bg: 'rgb(27, 108, 128)', oc: 'rgb(29, 31, 32)', os: 'dashed', ow: '2px' });
      equal('F3 可放置：浅青底 + 1px accent 虚线边（与设备块的实线边框区分）', { bg: can.backgroundColor, bc: can.borderTopColor, bs: can.borderTopStyle, bw: can.borderTopWidth }, { bg: 'rgb(228, 239, 242)', bc: 'rgb(27, 108, 128)', bs: 'dashed', bw: '1px' });
      equal('F4 accent 色值（对照）', accent, 'rgb(27, 108, 128)');
      check('F5 三态两两不同：选中描边色 ≠ 预览底色 ≠ 可放置底色（预览底色 ≠ 可放置底色）；可放置格边框样式（dashed）≠ 设备块边框样式', new Set([selected.outlineColor, prev.backgroundColor, can.backgroundColor]).size === 3 && can.borderTopStyle === 'dashed' && deviceBlock.borderTopStyle !== can.borderTopStyle && canWhilePreview.backgroundColor === can.backgroundColor, { selected, prev, can, deviceBlock, accent });
      // F6: the device's own current start U (A: U10) is drawn "cannot place" and place() refuses it, so hovering or focusing it must not show a preview either
      const own = await p.locator('[data-u="10"]').evaluate(el => ({ cannot: el.classList.contains('itl-cannot-place'), can: el.classList.contains('itl-can-place') }));
      await p.locator('[data-u="14"]').hover(); await p.locator('.itl-preview').first().waitFor();
      await p.locator('[data-u="10"]').hover(); await p.waitForTimeout(100);
      const afterHover = await p.locator('.itl-preview').count();
      await p.locator('[data-u="14"]').hover(); await p.locator('.itl-preview').first().waitFor();
      await p.locator('[data-u="10"]').focus(); await p.waitForTimeout(100);
      const afterFocus = await p.locator('.itl-preview').count();
      equal('F6 移位时悬停 / 聚焦设备原起始 U（该格是不可放置）：页面上没有 .itl-preview（悬停可放置格出现预览见 F2）', { own, afterHover, afterFocus }, { own: { cannot: true, can: false }, afterHover: 0, afterFocus: 0 });
      await p.close();
    }

    // ===== G. D1: drawer hides U count / slot count where they do not apply =====
    {
      const p = await open(1);
      const labels = async id => { await p.evaluate(x => ITLedger.detail(x), id); await p.locator('#itlAssetProfile .u-kv-item').first().waitFor(); const l = await p.locator('#itlAssetProfile .u-kv-item > label').allTextContents(); await p.evaluate(() => ITLedger.closeDrawer()); await p.locator('#itlDrawer').waitFor({ state: 'hidden' }); return l; };
      const lap = await labels(laptop.id), srv = await labels(A.id);
      equal('G1 笔记本详情：没有「占用 U 数」「盘位数」', lap.filter(l => ['占用 U 数', '盘位数'].includes(l)), []);
      equal('G2 服务器详情：仍有「占用 U 数」「盘位数」', srv.filter(l => ['占用 U 数', '盘位数'].includes(l)), ['占用 U 数', '盘位数']);
      await p.close();
    }

    // ===== H. D2: depot card names =====
    {
      const p = await open(1);
      await p.locator('[data-tab="depot"]').click(); await p.locator('.itl-lane .itl-card').first().waitFor();
      const names = await p.locator('.itl-lane .itl-card-id > .itl-card-name').evaluateAll(bs => bs.map(b => [b.textContent, b.title, b.dataset.detail]));
      equal('H1 库房卡片名称去前缀标记：「库房机」；名称只剩标记时回退型号「M-X」；无型号再回退「未命名资产」；title 保留原名全文；未带前缀的设备不变', names.map(n => [n[0], n[1]]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [['E备机', 'E备机'],['M-X', '【采集告警】'], ['未命名资产', '【暂定】'], ['库房机', '【采集告警】库房机']].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      const depotCardNameA = names.find(n => n[2] === String(depotA.id))?.[0];
      await p.locator('[data-tab="all"]').click(); await p.locator('#itlTable tbody tr[data-detail-row="' + depotA.id + '"]').waitFor();
      equal('H2 库房卡片名称 === 表格里同一资产的名称主体（表格「资产」列副行，即 nameParts 的 rest 所在元素）的文字', { card: depotCardNameA, table: await p.locator('#itlTable tbody tr[data-detail-row="' + depotA.id + '"] td').nth(2).locator('.itl-cell-sub').innerText() }, { card: '库房机', table: '库房机' });
      await p.locator('[data-tab="terminals"]').click(); await p.locator('#itlContent .itl-card-grid').first().waitFor();
      equal('H3 其他视图（终端与其他）的卡片名称不变：仍是带前缀的原名', await p.locator('#itlContent .itl-card-id > .itl-card-name').allTextContents(), ['【采集告警】终端本']);
      await p.close();
    }

    equal('Z 无浏览器异常', errors, []);
    console.log('RACK_LIST_BROWSER PASS=' + pass + ' FAIL=0');
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(e => { console.error(e.stack); console.log('RACK_LIST_BROWSER PASS=' + pass + ' FAIL=1'); process.exitCode = 1; });
