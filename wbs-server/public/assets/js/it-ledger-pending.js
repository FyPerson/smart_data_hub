/* #200 C2: the default screen's "待处理" block (plan v1.5 section 5).
 * Four kinds of entry in a fixed order: damaged assets, inspection warnings, unsubmitted inspection drafts, rooms not inspected this period.
 * Two sources: A = assets + health (the page's own refresh, state.assetsReady), B = the inspection overview (this module requests it).
 * A not ready or its last refresh failed -> no block (never computed from stale cache). B failing only drops the two inspection kinds
 * and adds a retry row. The block is painted into #itlPending, which renderAll() creates; B arriving, retrying and expanding repaint
 * only that element, never the table. Buttons carry data-pending-* only (no data-detail / data-action: other checks click those by id).
 */
(function () {
  'use strict';
  const L = window.ITLedger, { $, esc } = L;
  const MAX_ROWS = 6;
  // overview = the last successful B response; failed = the last B attempt failed (overview is then null).
  // requested = a B request was issued since the last clear; stale = a refresh ran on another tab, so B must be re-read before the next paint on #all.
  // overviewLevel = the ledger level (L.state.level) the held B result (or failure) was fetched under. The overview's draft visibility and the admin level both come
  // from the platform role, so after a same-token level change a B fetched under the old level is not shown (treated as "first load": inspection kinds take no row,
  // no retry row) until the next B arrives (fix 3, codex 63 M1). handled counts every settled B request, including discarded ones: a test seam (like __inspLoadSettled).
  let overview = null, failed = false, loading = false, requested = false, stale = false, expanded = false, overviewSeq = 0, overviewLevel = null, handled = 0;
  const bCurrent = () => overviewLevel === L.state.level;

  // ---- dates ----
  const monthDay = (month, day) => month + ' 月 ' + day + ' 日';
  // Draft start: browser-local month/day, the same conversion the inspection view's time() applies to created_at.
  function draftDay(s) {
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? monthDay(d.getMonth() + 1, d.getDate()) : '';
  }
  // Calendar day in Asia/Shanghai as YYYY-MM-DD ('' when unparsable): the same conversion as inspectionDate() in it-ledger-inspection-sheets.js.
  // Used for the last inspection day and as the sort key of the observation date (observed_at is a UTC ISO string, so its first 10 characters are the
  // UTC date, not the local calendar day the inspection view shows).
  function shanghaiYmd(s) {
    if (!s || !Number.isFinite(Date.parse(s))) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(s));
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return v.year + '-' + v.month + '-' + v.day;
  }
  function shanghaiDay(s) {
    const ymd = shanghaiYmd(s);
    return ymd ? monthDay(Number(ymd.slice(5, 7)), Number(ymd.slice(8, 10))) : '';
  }

  // ---- ordering (plan 5.2) ----
  const empty = v => v === null || v === undefined || v === '';
  // Ascending with empty values last: the list's own rule (UnifyHelpers.compareRow, string type, zh-Hans-CN collator).
  function cmpEmptyLast(a, b, compare) {
    const ea = empty(a), eb = empty(b);
    if (ea && eb) return 0;
    if (ea) return 1;
    if (eb) return -1;
    return compare(a, b);
  }
  const cmpAssetNo = (a, b) => cmpEmptyLast(a, b, (x, y) => String(x).localeCompare(String(y), 'zh-Hans-CN'));
  const cmpPlain = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---- entries ----
  function healthEntries(kind) {
    const word = kind === 'damaged' ? '损坏' : '巡检告警';
    const rows = [];
    for (const asset of L.state.assets) {
      const h = L.state.health?.[asset.id];
      if (h && h.kind === kind) rows.push({ asset, day: shanghaiYmd(h.observed_at), reason: h.reason || h.evidence || '' });
    }
    rows.sort((a, b) => cmpEmptyLast(a.day, b.day, cmpPlain) || cmpAssetNo(a.asset.asset_no, b.asset.asset_no) || a.asset.id - b.asset.id);
    return rows.map(r => {
      // Detail line: observation day + judgement state (+ "no new conclusion" note). The reason is already in the title; the raw observed_at string stays in the rack view's hover text only.
      const hi = L.healthInfo(r.asset), observed = shanghaiDay(L.state.health?.[r.asset.id]?.observed_at);
      return {
        kind, assetId: r.asset.id,
        title: L.assetLabel(r.asset) + ' ' + word + (r.reason ? '：' + r.reason : ''),
        sub: [observed ? observed + '观测' : '', hi.judged, hi.historyNote].filter(Boolean).join(' · ')
      };
    });
  }
  function draftEntries(rooms) {
    const rows = rooms.filter(r => r.draft);
    rows.sort((a, b) => cmpEmptyLast(a.draft.created_at, b.draft.created_at, cmpPlain) || a.room.localeCompare(b.room) || a.draft.id - b.draft.id);
    return rows.map(r => {
      const day = draftDay(r.draft.created_at);
      return {
        kind: 'draft', room: r.room, draftId: r.draft.id, visibility: r.draft.visibility,
        title: r.room + ' 巡检草稿未提交' + (day ? '（' + day + '开始）' : ''),
        sub: (r.draft.created_by_name || '—') + ' · 已填 ' + r.draft.filled + '/' + r.draft.total + ' 项'
      };
    });
  }
  function dueEntries(rooms, cycle) {
    const word = L.periodWord(cycle);
    // Only rooms that still have a registered rack: the inspection form can only be started for those (a room that survives only in old sheets is not actionable).
    const withRacks = new Set(L.state.racks.map(r => r.room).filter(Boolean));
    return rooms.filter(r => !r.draft && !r.period_done && withRacks.has(r.room)).sort((a, b) => a.room.localeCompare(b.room)).map(r => ({
      kind: 'due', room: r.room,
      title: r.room + ' ' + word + '未巡检',
      sub: r.last_submitted_at ? '上次 ' + shanghaiDay(r.last_submitted_at) + ' · 距上次 ' + r.days_since_last + ' 天' : '尚无巡检记录'
    }));
  }
  function entries() {
    const ov = overview && bCurrent() ? overview : null;
    const rooms = ov ? ov.rooms : [];
    return [...healthEntries('damaged'), ...healthEntries('warning'), ...draftEntries(rooms), ...(ov ? dueEntries(rooms, ov.period.cycle) : [])];
  }

  // ---- actions (plan 5.3): buttons are entry points only, writes are still checked by the server ----
  function actionOf(e) {
    const write = L.canWrite();
    if (e.kind === 'damaged' || e.kind === 'warning') return { label: write ? '查看告警' : '查看', action: 'detail', id: e.assetId };
    if (e.kind === 'draft') {
      if (write && e.visibility === 'full') return { label: '继续填写', action: 'sheet', id: e.draftId };
      return e.visibility === 'full' ? { label: '查看', action: 'sheet', id: e.draftId } : { label: '查看', action: 'inspections' };
    }
    return write ? { label: '发起巡检', action: 'new', room: e.room } : { label: '查看', action: 'inspections' };
  }
  function rowHtml(e) {
    const a = actionOf(e);
    const attrs = ' data-pending-action="' + a.action + '"' + (a.id !== undefined ? ' data-pending-id="' + a.id + '"' : '') + (a.room !== undefined ? ' data-pending-room="' + esc(a.room) + '"' : '');
    return '<li class="itl-pending-item itl-pending-' + e.kind + '" data-pending-kind="' + e.kind + '"><div class="itl-pending-text"><div class="itl-pending-main" title="' + esc(e.title) + '">' + esc(e.title) + '</div><div class="itl-pending-sub" title="' + esc(e.sub) + '">' + esc(e.sub) + '</div></div><button type="button" class="itl-link itl-pending-action"' + attrs + '>' + esc(a.label) + '</button></li>';
  }

  // ---- source B ----
  function fetchOverview() {
    // gen = the page's refresh generation when this request went out (plan v1.5 5.4: B is bound to refreshSequence like A). A refresh that started after
    // the request went out makes the answer stale: it is dropped (stale = true, nothing written or painted), because that refresh always ends one of three ways:
    // success (onRefresh asks for B again), failure (assetsReady = false, block hidden) or an access reset (onAccessLost clears everything). An overview
    // already accepted before the new round started stays on screen meanwhile (anchor section 9 #12).
    const seq = ++overviewSeq, token = getToken(), level = L.state.level, gen = L.refreshSeq();
    requested = true; stale = false; loading = true;
    // After the first B that lands following a scroll restore, re-apply that restore (the block may have pushed the table down; see it-ledger.js restoredAll).
    L.api('/inspections/sheets/overview').then(value => {
      handled++;
      if (seq !== overviewSeq) return;
      loading = false;
      if (token !== getToken()) return;
      if (gen !== L.refreshSeq()) { stale = true; return; }
      overviewLevel = level;
      if (value && Array.isArray(value.rooms) && value.period) { overview = value; failed = false; } else { overview = null; failed = true; }
      paint(); L.reapplyRestoredScroll?.();
    }, () => {
      handled++;
      if (seq !== overviewSeq) return;
      loading = false;
      if (token !== getToken()) return;
      if (gen !== L.refreshSeq()) { stale = true; return; }
      overviewLevel = level;
      overview = null; failed = true; paint(); L.reapplyRestoredScroll?.();
    });
  }

  // ---- painting ----
  function hide(root) { root.hidden = true; root.replaceChildren(); root._pendingHtml = ''; }
  function paint() {
    const root = $('#itlPending');
    if (!root || L.state.tab !== 'all') return;
    if (!L.state.assetsReady) { hide(root); return; }
    // The page showed #all from cache (no refresh ran, so onRefresh did not request B): ask for it now. A refresh in flight requests it itself.
    if (!loading && (!requested || stale) && $('#itlContent').getAttribute('aria-busy') !== 'true') fetchOverview();
    const all = entries(), showRetry = failed && bCurrent();
    if (!all.length && !showRetry) { hide(root); return; }
    const shown = expanded ? all : all.slice(0, MAX_ROWS);
    const more = all.length > MAX_ROWS
      ? '<li class="itl-pending-item itl-pending-more"><button type="button" class="itl-link" data-pending-action="' + (expanded ? 'less' : 'more') + '">' + (expanded ? '收起' : '还有 ' + (all.length - MAX_ROWS) + ' 件') + '</button></li>' : '';
    const retry = showRetry ? '<li class="itl-pending-item itl-pending-retry"><span>巡检数据没取到 · </span><button type="button" class="itl-link" data-pending-action="retry">重试</button></li>' : '';
    const html = '<h2 class="itl-pending-title">待处理（' + all.length + '）</h2><ul class="itl-pending-list">' + shown.map(rowHtml).join('') + more + retry + '</ul>';
    if (root._pendingHtml === html && !root.hidden) return;
    // Keep keyboard focus across a repaint (B landing, expand): remember the focused action, put focus back on the same one if it is still there (fix 3, codex 63 L1).
    const active = document.activeElement, focused = active && root.contains(active) && active.dataset && active.dataset.pendingAction ? { ...active.dataset } : null;
    root.innerHTML = html; root._pendingHtml = html; root.hidden = false;
    if (focused) {
      const again = [...root.querySelectorAll('[data-pending-action]')].find(b => b.dataset.pendingAction === focused.pendingAction && b.dataset.pendingId === focused.pendingId && b.dataset.pendingRoom === focused.pendingRoom);
      if (again) again.focus({ preventScroll: true });
    }
  }

  document.addEventListener('click', e => {
    const button = e.target.closest('[data-pending-action]');
    if (!button || !button.closest('#itlPending')) return;
    const action = button.dataset.pendingAction, id = Number(button.dataset.pendingId);
    if (action === 'more' || action === 'less') {
      expanded = action === 'more'; paint();
      $('#itlPending [data-pending-action="' + (expanded ? 'less' : 'more') + '"]')?.focus({ preventScroll: true });
    } else if (action === 'retry') { if (!loading) fetchOverview(); }   // a request is already in flight: ignore the click (codex 65 L6)
    else if (action === 'detail') L.detail(id);
    // "继续填写" waits for the refresh the tab switch may start (like "发起巡检"), otherwise that refresh can re-render the view and drop the sheet fetch (codex 65 M2).
    else if (action === 'sheet') L.openInspectionSheetWhenIdle(id);
    // "查看" (a draft the summary shows, a read-only user's unfinished room) lands on the inspection overview, not on whatever sub-view was left behind (codex 65 L5).
    else if (action === 'inspections') L.openInspectionList();
    else if (action === 'new') L.openNewInspection(button.dataset.pendingRoom);
  });

  L.registerView('pending-hooks', {
    // Every successful A: on #all read B now; elsewhere only mark it stale so the next paint on #all re-reads it.
    // A B still in flight when the user left #all must not block the re-read on return (loading would stay true): invalidate it, keep the old data (M3).
    onRefresh() { if (L.state.tab === 'all') fetchOverview(); else { stale = true; overviewSeq++; loading = false; } },
    onAccessLost() { overviewSeq++; overview = null; failed = false; loading = false; requested = false; stale = false; expanded = false; overviewLevel = null; }
  });
  L.pending = { paint, entries, get handled() { return handled; } };
})();
