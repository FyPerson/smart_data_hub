'use strict';
// Claude 复核（2026-09-29）补测：方案 B 多图上传的失败提示与批次余量登记（M1/M2）、
// 移除照片日志的浏览器查看入口（L1）、丢弃计数拆分（L4）。只用隔离夹具，不连生产库。
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { createFixture } = require('./it-ledger-browser-fixture');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5kAAAAASUVORK5CYII=', 'base64');
const LIMIT_MESSAGE = '每个附件位置最多10张图片，请先移除图片再添加';

async function main() {
  const f = await createFixture({ cleanup: true });
  let browser, pass = 0;
  const check = (label, ok, detail) => { assert.ok(ok, label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); pass++; console.log('[OK] ' + label); };
  const api = async (method, url, body, status = 200, user = 2) => { const r = await f.api(method, url, body, user); assert.equal(r.status, status, method + ' ' + url + ' ' + JSON.stringify(r.body)); return r.body; };
  const uploadApi = async (sheetId, rackId, user = 2) => {
    const data = new FormData(); data.append('slot', 'rack_front'); data.append('target_id', String(rackId)); data.append('file', new Blob([PNG], { type: 'image/png' }), '预置.png');
    const r = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + user }, body: data });
    return { status: r.status, body: await r.json() };
  };
  const files = n => Array.from({ length: n }, (_, i) => ({ name: '批次-' + i + '.png', mimeType: 'image/png', buffer: PNG }));
  const completeItems = sheet => sheet.items.map(it => ({ id: it.id, result: it.value_kind === 'number' ? null : 'ok', number_value: it.value_kind === 'number' ? (it.item_key === 'temperature' ? 23 : 48) : null, note: null }));
  let roomSeq = 0;
  async function newRoom() {
    const room = '批次机房' + (++roomSeq);
    const rack = await api('POST', '/racks', { room, name: 'B' + roomSeq, u_total: 24 }, 201, 1);
    await api('POST', '', { category: 'server', name: '批次服务器' + roomSeq, u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 } }, 201, 1);
    return { room, rack };
  }
  async function submittedSheet(photoCount) {
    const { room, rack } = await newRoom();
    let s = await api('POST', '/inspections/sheets', { room_name: room }, 201);
    for (let i = 0; i < photoCount; i++) assert.equal((await uploadApi(s.id, rack.id)).status, 201);
    s = await api('GET', '/inspections/sheets/' + s.id);
    s = await api('PUT', '/inspections/sheets/' + s.id, { expected_version: s.version, items: completeItems(s) });
    s = await api('POST', '/inspections/sheets/' + s.id + '/submit', { expected_version: s.version });
    return { sheet: s, rack };
  }
  async function openPage(user = 2) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // 只在首次载入时写 token：场景 D 在页面内换号，reload/goto 不能把它改回去。
    await context.addInitScript(u => { if (!sessionStorage.getItem('batchInit')) { localStorage.setItem('token', 'fixture-' + u); sessionStorage.setItem('batchInit', '1'); } }, user);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/IT_Ledger.html#inspections');
    return { context, page, errors };
  }
  const slotOf = (page, rackId) => page.locator('.itl-sheet-photo-slot[data-photo-position="rack_front:' + rackId + '"]');
  const messageOf = (page, rackId) => page.locator('[data-photo-message="rack_front:' + rackId + '"]').textContent();
  // codex 49-R L1：等待拦截点到达必须有界，回归时判红而不是挂起。
  const within = (promise, ms, label) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' 超时 ' + ms + 'ms')), ms); })]).finally(() => clearTimeout(timer)); };
  const settledKey = (sheetId, rackId) => sheetId + ':rack_front:' + rackId;
  const settledCount = (page, key) => page.evaluate(k => window.ITLedger.__inspPhotoUploadSettledByPosition.get(k) || 0, key);
  const waitSettled = (page, key, before) => page.waitForFunction(([k, n]) => (window.ITLedger.__inspPhotoUploadSettledByPosition.get(k) || 0) > n, [key, before], { timeout: 15000 });
  async function openDraftRack(page, sheetId) {
    await page.locator('[data-insp-continue="' + sheetId + '"]').click();
    await page.locator('#itlSheetRoute [data-workflow-go=rack]').click();
  }
  async function openEditRack(page, sheetId) {
    await page.locator('[data-insp-edit="' + sheetId + '"]').click();
    await page.locator('#itlSheetRoute [data-workflow-go=rack]').click();
  }
  // 第 n 次（从 1 计）对上传接口的 POST 交给 handler，其余照常放行。
  async function interceptPost(page, sheetId, n, handler) {
    let seen = 0;
    await page.route(url => new URL(url).pathname === '/api/it-assets/inspections/sheets/' + sheetId + '/photos', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      seen++;
      if (seen === n) return handler(route);
      return route.continue();
    });
    return () => seen;
  }

  try {
    browser = await chromium.launch({ headless: true });

    // ===== A（M2）：单张被服务端明确拒绝 → 「照片上传失败」，不说「未能确认」 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const { context, page, errors } = await openPage();
      await openDraftRack(page, draft.id);
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles([{ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') }]);
      await waitSettled(page, key, before);
      const text = await messageOf(page, rack.id);
      check('A 单张被服务端拒绝提示「照片上传失败」并给出具体原因', text.startsWith('照片上传失败：') && !text.includes('未能确认') && text !== '照片上传失败：操作失败', text);
      check('A 服务端无照片', (await api('GET', '/inspections/sheets/' + draft.id)).photos.length === 0);
      check('A 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== B（M2）：批次第 2 张网络中断 → 该张「未能确认」，其余张数如实写出 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const { context, page, errors } = await openPage();
      await openDraftRack(page, draft.id);
      const posts = await interceptPost(page, draft.id, 2, route => route.abort('failed'));
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      const text = await messageOf(page, rack.id);
      check('B 网络中断提示全等', text === '已添加 1 / 3 张；第 2 张上传结果未能确认，请重新打开核对：网络异常；其余 1 张未上传', text);
      check('B 第 3 张没有发出', posts() === 2, posts());
      check('B 服务端只有第 1 张', (await api('GET', '/inspections/sheets/' + draft.id)).photos.length === 1);
      check('B 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== C（M2）：批次中途他人补满 10 张 → 第 2 张真实 409，提示「上传失败」而非「未能确认」 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      for (let i = 0; i < 7; i++) assert.equal((await uploadApi(draft.id, rack.id)).status, 201);
      const { context, page, errors } = await openPage();
      await openDraftRack(page, draft.id);
      await interceptPost(page, draft.id, 1, async route => {
        const response = await route.fetch();
        for (let i = 0; i < 2; i++) assert.equal((await uploadApi(draft.id, rack.id, 1)).status, 201);
        await route.fulfill({ response });
      });
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      const text = await messageOf(page, rack.id);
      check('C 容量冲突提示全等', text === '已添加 1 / 3 张；第 2 张上传失败：' + LIMIT_MESSAGE + '；其余 1 张未上传', text);
      check('C 服务端恰好 10 张', (await api('GET', '/inspections/sheets/' + draft.id)).photos.length === 10);
      check('C 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== D（M1）：已提交单编辑，批次第 1 张后换号 → 余下 2 张登记进本人未保存条目 =====
    {
      const { sheet, rack } = await submittedSheet(1);
      const { context, page, errors } = await openPage();
      await openEditRack(page, sheet.id);
      const posts = await interceptPost(page, sheet.id, 1, async route => {
        const response = await route.fetch();
        await page.evaluate(() => localStorage.setItem('token', 'fixture-1'));
        await route.fulfill({ response });
      });
      const key = settledKey(sheet.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      check('D 换号后不再发出后续上传', posts() === 1, posts());
      check('D 服务端本人待生效恰好 1 张', (await api('GET', '/inspections/sheets/' + sheet.id)).my_pending_photos.length === 1);
      await page.evaluate(() => { localStorage.setItem('token', 'fixture-2'); location.hash = 'racks'; });
      await page.locator('.itl-rack-workspace').waitFor({ timeout: 8000 });
      await page.evaluate(() => { location.hash = 'inspections'; });
      const banner = await page.locator('#itlUnsavedList [data-unsaved-sheet="' + sheet.id + '"]').innerText({ timeout: 8000 });
      // 换号发生在响应阶段：共享层抛 401，客户端拿不到结果——第 1 张计「未能确认」（服务端实际已收下，见上一条），余下 2 张确定未发出。
      check('D 未保存条目写明未确认与未传张数', banner.includes('照片B' + roomSeq + '：已上传 0 / 3 张，第 1 张结果未能确认，其余 2 张未上传（文件内容未保留）（原因：登录状态已变化，结果未能确认）'), banner);
      check('D 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== E（M1）：草稿批次第 1 张后失权（重取 403）→ 失权全文提示带上余下张数 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const { context, page, errors } = await openPage();
      await openDraftRack(page, draft.id);
      let photoPosts = 0, forbidden = false;
      await page.route(url => new URL(url).pathname.startsWith('/api/it-assets/inspections/sheets/' + draft.id), async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path.endsWith('/photos') && request.method() === 'POST') { photoPosts++; return route.continue(); }
        if (path === '/api/it-assets/inspections/sheets/' + draft.id && request.method() === 'GET' && photoPosts === 1 && !forbidden) {
          forbidden = true;
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'LEDGER_FORBIDDEN', message: '访问权限已变化' }) });
        }
        return route.continue();
      });
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      await page.waitForFunction(() => (document.querySelector('#itlNotice')?.textContent || '').includes('其余 2 张未上传'), null, { timeout: 8000 });
      const notice = await page.locator('#itlNotice').textContent();
      check('E 失权提示写明已传与未传张数', notice.includes('已上传 1 / 3 张，其余 2 张未上传（文件内容未保留）') && notice.includes('编辑权限已变化'), notice);
      check('E 失权后不再发出后续上传', photoPosts === 1, photoPosts);
      check('E 服务端只有第 1 张', (await api('GET', '/inspections/sheets/' + draft.id)).photos.length === 1);
      check('E 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== F（L1）：提交后移除照片，详情日志「查看原照片」能真实打开被移除的照片 =====
    {
      const { sheet } = await submittedSheet(2);
      const removedId = sheet.photos[0].id;
      await api('DELETE', '/inspections/sheets/' + sheet.id + '/photos/' + removedId);
      const saved = await api('PUT', '/inspections/sheets/' + sheet.id, { expected_version: sheet.version, items: [] });
      check('F 保存后日志有移除条目且照片已退出有效集合', saved.log.some(l => l.diff?.some(d => d.kind === 'photo_removed' && d.photo_id === removedId)) && !saved.photos.some(p => p.id === removedId));
      const { context, page, errors } = await openPage(3);
      await page.locator('[data-insp-view="' + sheet.id + '"]').click();
      const button = page.locator('[data-log-photo-view="' + removedId + '"]');
      await button.waitFor({ state: 'attached' });
      check('F 日志行文字为移除照片', (await page.locator('.itl-sheet-log').innerText()).includes('移除照片 #' + removedId));
      await button.evaluate(el => { const d = el.closest('details'); if (d) d.open = true; });
      // codex 49 L-2：所有照片字节相同，只看图片加载成功证明不了打开的是哪张——断言内容请求指向 removedId。
      const contentRequest = page.waitForRequest(r => new URL(r.url()).pathname === '/api/it-assets/inspections/sheets/' + sheet.id + '/photos/' + removedId + '/content', { timeout: 8000 });
      await button.click();
      await contentRequest;
      await page.locator('.itl-evidence-viewer img').waitFor();
      await page.waitForFunction(() => { const img = document.querySelector('.itl-evidence-viewer img'); return img && img.complete && img.naturalWidth > 0; }, null, { timeout: 8000 });
      check('F 只读用户可从日志打开被移除的原照片', true);
      check('F 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== G（L4）：丢弃计数拆分——discarded / discarded_pending 只计照片，移除暂存另计 =====
    {
      const { sheet, rack } = await submittedSheet(2);
      await api('DELETE', '/inspections/sheets/' + sheet.id + '/photos/' + sheet.photos[0].id);
      assert.equal((await uploadApi(sheet.id, rack.id)).status, 201);
      const discard = await api('DELETE', '/inspections/sheets/' + sheet.id + '/pending-photos');
      check('G 放弃修改：照片 1 张、移除暂存 1 条分开计', discard.discarded === 1 && discard.discarded_removals === 1, discard);
      await api('DELETE', '/inspections/sheets/' + sheet.id + '/photos/' + sheet.photos[0].id);
      assert.equal((await uploadApi(sheet.id, rack.id)).status, 201);
      const current = await api('GET', '/inspections/sheets/' + sheet.id);
      const archived = await api('POST', '/inspections/sheets/archive', { items: [{ id: sheet.id, expected_version: current.version }] }, 200, 1);
      check('G 归档：discarded_pending 只计照片，discarded_removals 另计', archived.discarded_pending === 1 && archived.discarded_removals === 1, archived);

      const other = await submittedSheet(2);
      await api('DELETE', '/inspections/sheets/' + other.sheet.id + '/photos/' + other.sheet.photos[0].id);
      const fresh = await api('GET', '/inspections/sheets/' + other.sheet.id);
      const deleted = await api('DELETE', '/inspections/sheets/' + other.sheet.id, { expected_version: fresh.version, reason: '批次测试' }, 200, 1);
      check('G 逻辑删除：无待生效照片时 discarded_pending=0，移除暂存另计 1', deleted.discarded_pending === 0 && deleted.discarded_removals === 1, deleted);
    }

    // ===== I（49 M-1）：批次前 2 张成功、第 3 张在途时离开表单、随后网络失败 → 草稿与已提交单都登记「第 3 张结果未能确认」 =====
    for (const mode of ['draft', 'submitted']) {
      let sheetId, rackId;
      if (mode === 'draft') { const { room, rack } = await newRoom(); sheetId = (await api('POST', '/inspections/sheets', { room_name: room }, 201)).id; rackId = rack.id; }
      else { const made = await submittedSheet(1); sheetId = made.sheet.id; rackId = made.rack.id; }
      const { context, page, errors } = await openPage();
      if (mode === 'draft') await openDraftRack(page, sheetId); else await openEditRack(page, sheetId);
      let release, entered;
      const reached = new Promise(r => { entered = r; });
      const held = new Promise(r => { release = r; });
      await interceptPost(page, sheetId, 3, async route => { entered(); await held; await route.abort('failed'); });
      const key = settledKey(sheetId, rackId), before = await settledCount(page, key);
      try {
        await slotOf(page, rackId).locator('input[type=file]').setInputFiles(files(3));
        await within(reached, 8000, 'I ' + mode + ' 第 3 张上传到达拦截点');
        await page.evaluate(() => { location.hash = 'racks'; });
        await page.locator('.itl-rack-workspace').waitFor({ timeout: 8000 });
      } finally { release(); }
      await waitSettled(page, key, before);
      await page.evaluate(() => { location.hash = 'inspections'; });
      const banner = await page.locator('#itlUnsavedList [data-unsaved-sheet="' + sheetId + '"]').innerText({ timeout: 8000 });
      check('I ' + mode + ' 末张结果未知且表单已离开仍登记批次进度', banner.includes('：已上传 2 / 3 张，第 3 张结果未能确认（原因：网络异常）'), banner);
      const server = await api('GET', '/inspections/sheets/' + sheetId);
      check('I ' + mode + ' 服务端恰好收下前 2 张', (mode === 'draft' ? server.photos.length : server.my_pending_photos.length) === 2, server.photos.length + '/' + server.my_pending_photos.length);
      check('I ' + mode + ' 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== J（49 M-2）：单张请求已被服务端收下、响应丢失 → 提示「结果未能确认」，不说「上传失败」 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const { context, page, errors } = await openPage();
      await openDraftRack(page, draft.id);
      await interceptPost(page, draft.id, 1, async route => { await route.fetch(); await route.abort('failed'); });
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(1));
      await waitSettled(page, key, before);
      check('J 服务端实际已收下这张', (await api('GET', '/inspections/sheets/' + draft.id)).photos.length === 1);
      const text = await messageOf(page, rack.id);
      check('J 单张响应丢失提示全等', text === '照片上传结果未能确认，请重新打开核对：网络异常', text);
      check('J 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== J2（49 M-1 单张同口径）：已提交单单张在途时离开表单、服务端已收下但响应丢失 → 仍登记「结果未能确认」 =====
    {
      const { sheet, rack } = await submittedSheet(1);
      const { context, page, errors } = await openPage();
      await openEditRack(page, sheet.id);
      let release, entered;
      const reached = new Promise(r => { entered = r; });
      const held = new Promise(r => { release = r; });
      await interceptPost(page, sheet.id, 1, async route => { entered(); await held; await route.fetch(); await route.abort('failed'); });
      const key = settledKey(sheet.id, rack.id), before = await settledCount(page, key);
      try {
        await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(1));
        await within(reached, 8000, 'J2 单张上传到达拦截点');
        await page.evaluate(() => { location.hash = 'racks'; });
        await page.locator('.itl-rack-workspace').waitFor({ timeout: 8000 });
      } finally { release(); }
      await waitSettled(page, key, before);
      check('J2 服务端实际已收下为本人待生效照片', (await api('GET', '/inspections/sheets/' + sheet.id)).my_pending_photos.length === 1);
      await page.evaluate(() => { location.hash = 'inspections'; });
      const banner = await page.locator('#itlUnsavedList [data-unsaved-sheet="' + sheet.id + '"]').innerText({ timeout: 8000 });
      check('J2 已提交单单张结果未知仍登记', banner.includes('照片上传结果未能确认：') && banner.includes('（请重新打开核对）（原因：网络异常）'), banner);
      check('J2 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== K（49 M-3）：上传确认后、重取详情的响应阶段换号 → 余下 2 张按「确定未发出」登记，原因不带「结果未能确认」 =====
    {
      const { sheet, rack } = await submittedSheet(1);
      const { context, page, errors } = await openPage();
      await openEditRack(page, sheet.id);
      let photoPosts = 0, switched = false;
      await page.route(url => new URL(url).pathname.startsWith('/api/it-assets/inspections/sheets/' + sheet.id), async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path.endsWith('/photos') && request.method() === 'POST') { photoPosts++; return route.continue(); }
        if (path === '/api/it-assets/inspections/sheets/' + sheet.id && request.method() === 'GET' && photoPosts === 1 && !switched) {
          switched = true;
          const response = await route.fetch();
          await page.evaluate(() => localStorage.setItem('token', 'fixture-1'));
          return route.fulfill({ response });
        }
        return route.continue();
      });
      const key = settledKey(sheet.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      check('K 只发出 1 次上传', photoPosts === 1, photoPosts);
      await page.evaluate(() => { localStorage.setItem('token', 'fixture-2'); location.hash = 'racks'; });
      await page.locator('.itl-rack-workspace').waitFor({ timeout: 8000 });
      await page.evaluate(() => { location.hash = 'inspections'; });
      const banner = await page.locator('#itlUnsavedList [data-unsaved-sheet="' + sheet.id + '"]').innerText({ timeout: 8000 });
      check('K 登记已传 1 张、其余 2 张确定未上传，原因不含未能确认', banner.includes('：已上传 1 / 3 张，其余 2 张未上传（文件内容未保留）（原因：登录状态已变化）'), banner);
      check('K 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== L（49 L-1）：上传前表单冲刷失败 → 「本批 3 张照片未上传：表单修改未保存」 =====
    {
      const { room, rack } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const aircon = draft.items.find(it => it.item_key === 'aircon');
      const { context, page, errors } = await openPage();
      await page.route(url => new URL(url).pathname === '/api/it-assets/inspections/sheets/' + draft.id, route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '测试注入失败' }) }) : route.continue());
      let photoPosts = 0;
      page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/photos')) photoPosts++; });
      await page.locator('[data-insp-continue="' + draft.id + '"]').click();
      await page.locator('#itlSheetExpandAll').click();
      await page.locator('[data-seg-ok="' + aircon.id + '"]').click();
      const key = settledKey(draft.id, rack.id), before = await settledCount(page, key);
      await slotOf(page, rack.id).locator('input[type=file]').setInputFiles(files(3));
      await waitSettled(page, key, before);
      const text = await messageOf(page, rack.id);
      check('L 冲刷失败提示全等', text === '本批 3 张照片未上传：表单修改未保存', text);
      check('L 没有发出任何上传', photoPosts === 0, photoPosts);
      check('L 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== M（49 M-3）：共享层 L.api 三种 401 的 code 契约——服务端真 401 / 响应头阶段换号 / 响应体读取阶段换号 =====
    // 手法同既有 Y4：临时替换 window.authFetch（一次性），不触发真实登出跳转。
    {
      const { context, page, errors } = await openPage();
      await page.locator('#itlTabs').waitFor({ timeout: 8000 });
      const codes = await page.evaluate(async () => {
        const original = window.authFetch, out = {};
        const run = async (name, stub) => {
          window.authFetch = async (...args) => { window.authFetch = original; return stub(...args); };
          try { await window.ITLedger.api('/inspections/sheets/stats'); out[name] = 'no-throw'; }
          catch (e) { out[name] = e.status + ':' + (e.code || ''); }
          localStorage.setItem('token', 'fixture-2');
        };
        await run('authRejected', async () => null);
        await run('headerStage', async (url, options) => { const r = await original(url, options); localStorage.setItem('token', 'fixture-1'); return r; });
        await run('bodyStage', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { localStorage.setItem('token', 'fixture-1'); return {}; } }));
        return out;
      });
      check('M 服务端真 401（authFetch 登出返回 null）标 AUTH_REJECTED', codes.authRejected === '401:AUTH_REJECTED', codes);
      check('M 响应头阶段换号标 IDENTITY_CHANGED_IN_FLIGHT', codes.headerStage === '401:IDENTITY_CHANGED_IN_FLIGHT', codes);
      check('M 响应体读取阶段换号标 IDENTITY_CHANGED_IN_FLIGHT', codes.bodyStage === '401:IDENTITY_CHANGED_IN_FLIGHT', codes);
      check('M 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    // ===== H（L2）：焦点停在登记目录按钮上时，自动保存结束后的进度刷新不能把焦点丢到 body =====
    {
      const { room } = await newRoom();
      const draft = await api('POST', '/inspections/sheets', { room_name: room }, 201);
      const temperature = draft.items.find(it => it.item_key === 'temperature');
      const { context, page, errors } = await openPage();
      await page.locator('[data-insp-continue="' + draft.id + '"]').click();
      await page.locator('[data-num-id="' + temperature.id + '"]').waitFor();
      const navButton = page.locator('#itlSheetRoute [data-workflow-go=device]');
      await navButton.focus();
      const before = await page.evaluate(() => window.ITLedger.__inspFormFlushSettled);
      // 不移动焦点地改一个读数，触发自动保存 → updateActionBar → updateWorkflowNav。
      await page.evaluate(id => { const el = document.querySelector('[data-num-id="' + id + '"]'); el.value = '24'; el.dispatchEvent(new Event('input', { bubbles: true })); }, temperature.id);
      await page.waitForFunction(n => window.ITLedger.__inspFormFlushSettled > n, before, { timeout: 8000 });
      check('H 自动保存确已落库', (await api('GET', '/inspections/sheets/' + draft.id)).items.find(it => it.id === temperature.id).number_value === 24);
      check('H 进度刷新后焦点仍在同一个目录按钮上', await navButton.evaluate(el => el === document.activeElement));
      check('H 目录进度文字已随保存更新', (await page.locator('#itlSheetRoute [data-workflow-go=room] small').textContent()).startsWith('1 / '));
      check('H 无浏览器异常', errors.length === 0, errors);
      await context.close();
    }

    console.log('PHOTO_BATCH_FEEDBACK PASS=' + pass + ' FAIL=0');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
