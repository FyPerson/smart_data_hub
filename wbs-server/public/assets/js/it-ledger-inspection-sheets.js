/* Inspection ledger: server-owned overview, local list filters, editable sessions and read-only details.
 * Layout follows the approved three-screen design. Authority, autosave queues and sessionApi stay shared.
 * Normal results are expanded; the complete operation log is newest first with actor display names.
 */
(function () {
  'use strict';
  const L = window.ITLedger, { $, esc } = L;
  let sequence = 0, mode = 'list', viewGen = 0, filters = { room: '', status: '', period: '90', search: '' }, checked = new Set(), checkedVersions = new Map(), lastItems = [], knownRooms = new Set(), detailId = null;
  let overviewData = null, overviewError = null;
  // C4d（codex 40-R M 采纳）：viewGen 是"子视图代次"——只在 mode 真的发生变化（list/deleted/detail 互切）
  // 时递增，同一子视图内的多次 load()/render() 不算。confirmBatchArchive/confirmRestore 发起写请求时各自
  // 记一份 {mode, viewGen} 快照，回调里只有两者都仍相同才主动重载；先切到别的子视图、或者切走又切回同一
  // 子视图（离开期间 viewGen 已经变过）都不重载，只留 toast，下次真正进入该子视图时自然读新数据。
  function enterMode(next) { if (mode !== next) viewGen++; if (mode === 'detail' && next !== 'detail') { releasePhotoOwner(detailPhotoOwner); detailPhotoOwner = null; } mode = next; }
  // H2（C4c必修）：测试可观测计数——每次load()/loadDeleted()的await返回、完成"丢弃或渲染"判定后自增；
  // 只读计数，不参与任何业务分支，浏览器用例靠它确认迟到响应确实已被处理完，不再只靠sentinel到达。
  L.__inspLoadSettled = 0;
  L.__inspOverviewSettled = 0;
  // C5a 段3：写队列每次 performFlush 落定（不管是成功、被判定为无脏数据的空跑、409冲突已处理、还是其它
  // 失败）都自增一次——供浏览器用例用 waitForFunction 等"这次冲刷已经跑完"，不依赖 sleep 猜测防抖/网络
  // 时机（同 __inspLoadSettled 的先例）。
  L.__inspFormFlushSettled = 0;
  // Per-item completion signal: a request being sent does not prove its callback settled.
  L.__inspCollectSettledByItem = new Map();
  L.__inspDeleteSettledBySheet = new Map();
  L.__inspSubmitSettledBySheet = new Map();
  L.__inspPhotoUploadSettledByPosition = new Map();
  L.__inspPhotoDeleteSettledByPosition = new Map();
  L.__inspPhotoReadSettledById = new Map();
  L.__inspPhotoViewerSettledById = new Map();
  L.__inspEditSaveSettledBySheet = new Map();
  L.__inspPendingDiscardSettledBySheet = new Map();
  const statusLabels = { draft: '填写中', submitted: '已提交（待归档）', archived: '已归档' };
  const statusClasses = { draft: 'sem-wait', submitted: 'sem-intake', archived: 'sem-archived' };
  const time = s => s ? new Date(s).toLocaleString('zh-CN') : '—';
  const dateOnly = s => { if (!s) return ''; const d = new Date(s); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const badge = status => UnifyHelpers.statusBadgeByMap(status, statusClasses, statusLabels[status] || status);
  // Registered rack rooms plus all loaded sheet rooms, independent of local filters.
  const rooms = () => {
    const set = new Set(L.state.racks.map(r => r.room).filter(Boolean));
    knownRooms.forEach(r => set.add(r));
    if (filters.room) set.add(filters.room);
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  function placeholder() { L.toast('这条记录当前只能查看摘要，无法打开详情'); }

  // ============================================================
  // 台账列表
  // ============================================================
  // M1（C4b预筛必修）：常驻容器 #itlContent 从不被移除，isConnected 恒真，单靠它挡不住"切了页签，
  // 迟到的响应又把台账内容渲染回来"这个race——setTab() 切页签时既不 sequence++（那只在 onAccessLost
  // 里发生，onAccessLost 只在权限丢失/token变化时触发，不在普通切页签时触发）也不移除 #itlContent
  // 本身。改为：每次 render/load 建一个"本次专属"的根元素（marker，不是常驻的 #itlContent），异步
  // 返回后三件套核对——序号未变 + L.state.tab==='inspections' + marker 这个具体节点仍 isConnected
  // （不是"同id的某个节点存在"，是这一个节点引用本身还挂在文档树上）——任一不满足直接丢弃结果（参照
  // it-ledger-records.js 的"专属子容器"写法；退役视图不再作为这里的实现范例）。
  function stillActive(seq, marker) { return seq === sequence && L.state.tab === 'inspections' && marker.isConnected; }
  async function load() {
    if (L.state.tab !== 'inspections') return;
    enterMode('list');
    const seq = ++sequence;
    const container = $('#itlContent');
    const marker = document.createElement('div');
    marker.className = 'itl-empty'; marker.textContent = '正在读取巡检台账…';
    container.replaceChildren(marker);
    overviewData = null; overviewError = null;
    // Start both requests here. Overview latency/failure never blocks the complete list.
    const overviewTask = L.api('/inspections/sheets/overview').then(value => ({ value }), error => ({ error }));
    try {
      const list = await L.api('/inspections/sheets');
      if (!stillActive(seq, marker)) { L.__inspLoadSettled++; return; }
      lastItems = list.items;
      knownRooms = new Set(lastItems.map(r => r.room_name).filter(Boolean));
      const versionDrifted = [];
      checked = new Set([...checked].filter(id => {
        const row = lastItems.find(r => r.id === id);
        if (!row || !row.actions.includes('archive')) { checkedVersions.delete(id); return false; }
        if (checkedVersions.get(id) !== row.version) { versionDrifted.push(id); checkedVersions.delete(id); return false; }
        return true;
      }));
      renderList();
      if (versionDrifted.length) L.notice('部分已勾选单据在此期间发生变化，已取消勾选，请重新核对：' + versionDrifted.map(id => '#' + id).join('、'));
      L.__inspLoadSettled++;
      const overviewRoot = $('#itlInspOverview');
      const result = await overviewTask;
      if (seq !== sequence || L.state.tab !== 'inspections' || mode !== 'list' || !overviewRoot.isConnected) return;
      overviewData = result.value || null; overviewError = result.error || null;
      renderOverview();
    } catch (error) {
      if (stillActive(seq, marker)) container.innerHTML = `<p class="itl-form-error">${esc(error.message)}</p>`;
      L.__inspLoadSettled++;
    } finally { L.__inspOverviewSettled++; }
  }
  function inspectionDate(s) {
    if (!s) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(s));
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return values.year + '-' + values.month + '-' + values.day;
  }
  function baseFilteredItems() {
    const today = L.serverToday();
    const search = filters.search.trim().toLocaleLowerCase();
    return lastItems.filter(row => {
      if (filters.room && row.room_name !== filters.room) return false;
      if (search && ![row.room_name, row.created_by_name || ''].some(value => value.toLocaleLowerCase().includes(search))) return false;
      if (row.visibility === 'summary' || row.status === 'draft' || filters.period === 'all') return true;
      if (!today) return false;
      const day = inspectionDate(row.submitted_at);
      if (filters.period === 'year') return day.slice(0,4) === today.slice(0,4);
      const days = (Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000;
      return days >= 0 && days <= 90;
    });
  }
  function matchesStatus(row, status) {
    if (!status) return true;
    if (status === 'draft') return row.visibility === 'summary' || row.status === 'draft';
    if (status === 'abnormal') return ['submitted', 'archived'].includes(row.status) && row.abnormal > 0;
    return row.status === status;
  }
  function visibleItems() { return baseFilteredItems().filter(row => matchesStatus(row, filters.status)); }
  function progressHtml(filled, total) {
    const percent = total ? Math.min(100, Math.max(0, filled / total * 100)) : 0;
    return `<progress class="itl-insp-progress" max="100" value="${percent}" aria-label="已填 ${esc(filled)} / ${esc(total)} 项"></progress>`;
  }
  function renderOverview() {
    const root = $('#itlInspOverview'), title = $('#itlInspMonth');
    if (!overviewData) {
      title.textContent = overviewError ? '机房概览读取失败' : '正在读取机房概览…';
      root.innerHTML = `<p class="itl-muted">${overviewError ? '机房概览读取失败，请重新进入巡检台账重试。' : '正在读取机房概览…'}</p>`;
      return;
    }
    const data = overviewData;
    title.textContent = data.month.slice(0,4) + ' 年 ' + Number(data.month.slice(5)) + ' 月 · ' + data.rooms.length + ' 个机房，' + data.rooms.filter(r => r.this_month_done).length + ' 个本月已巡检';
    root.innerHTML = data.rooms.map(room => {
      const draft = room.draft;
      const status = draft ? '填写中' : room.this_month_done ? '本月已巡检' : '本月未巡检';
      const semantic = draft ? 'sem-wait' : room.this_month_done ? 'sem-done' : 'sem-hold';
      const filled = draft ? draft.filled : room.last_filled, total = draft ? draft.total : room.last_total;
      const abnormal = draft ? draft.abnormal : room.last_abnormal;
      const sub = draft ? '开始于 ' + time(draft.created_at) + ' · ' + (draft.created_by_name || '—')
        : room.this_month_done ? '上次 ' + time(room.last_submitted_at) + ' · ' + (room.last_submitted_by_name || '—')
        : room.last_submitted_at ? '上次 ' + inspectionDate(room.last_submitted_at).slice(5) + ' · 距上次 ' + room.days_since_last + ' 天' : '尚无巡检记录';
      return `<article class="itl-insp-room${!draft && !room.this_month_done ? ' itl-insp-room-due' : ''}" data-insp-room="${esc(room.room)}"><header><strong>${esc(room.room)}</strong><span class="u-status-badge ${semantic}" data-insp-room-status>${status}</span></header><p>${esc(sub)}</p>${progressHtml(filled || 0, total || 0)}<p>${filled === null ? '—' : esc(filled) + ' / ' + esc(total) + ' 项'}${abnormal === undefined || abnormal === null ? '' : ' · ' + (abnormal ? '异常 ' + esc(abnormal) + ' 项' : '无异常')}</p></article>`;
    }).join('') || '<p class="itl-muted">尚无机房</p>';
  }
  function renderStatusTabs() {
    const rows = baseFilteredItems();
    $('#itlInspStatusTabs').innerHTML = [['','全部'],['draft','填写中'],['submitted','待归档'],['abnormal','有异常'],['archived','已归档']].map(([status,label]) => `<button type="button" role="tab" aria-selected="${filters.status === status}" data-insp-status="${status}">${label} <b>${rows.filter(row => matchesStatus(row,status)).length}</b></button>`).join('');
    $('#itlInspStatusTabs').querySelectorAll('button').forEach(button => button.addEventListener('click', () => { filters.status = button.dataset.inspStatus; applyFilters(); }));
  }
  function applyFilters() {
    checked.clear(); checkedVersions.clear();
    const all = $('#itlInspCheckAll'); if (all) all.checked = false;
    renderStatusTabs(); renderRows();
  }
  function renderList() {
    const isAdmin = L.isAdmin();
    $('#itlContent').innerHTML = `
      <div id="itlUnsavedList"></div><div class="itl-muted" id="itlInspWaitPlaceholder" hidden></div>
      <div class="itl-insp-heading"><h2>巡检台账</h2><span class="itl-muted" id="itlInspMonth"></span><span class="itl-sheet-grow"></span>${L.canWrite() ? '<button type="button" class="u-btn-primary" id="itlInspNew">＋ 新增巡检</button>' : ''}</div>
      <section class="itl-insp-overview" id="itlInspOverview" aria-label="机房概览"></section>
      <div class="itl-toolbar itl-insp-filters"><div id="itlInspStatusTabs" role="tablist" aria-label="按状态筛选"></div>
        <label>机房 <select id="itlInspRoomFilter"><option value="">全部机房</option>${rooms().map(r => `<option value="${esc(r)}"${r === filters.room ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
        <label>时间 <select id="itlInspTimeFilter">${[['90','近三个月'],['year','今年'],['all','全部']].map(([value,label])=>`<option value="${value}"${value === filters.period ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <input type="search" id="itlInspSearch" aria-label="搜索机房或巡检人" placeholder="搜索机房或巡检人" value="${esc(filters.search)}">
        ${isAdmin ? '<button type="button" class="u-btn-secondary" id="itlInspBatchArchive" hidden></button><button type="button" class="itl-link" id="itlInspOpenDeleted">已删除</button>' : ''}
      </div>
      ${L.serverToday() ? '' : '<p class="itl-muted">等待服务器日期，已提交记录暂不参与时间筛选。</p>'}
      <div class="u-corr-table-wrap"><table class="u-corr-table"><thead><tr>${isAdmin ? '<th class="itl-inspection-check"><input type="checkbox" id="itlInspCheckAll" aria-label="全选待归档"></th>' : ''}<th>机房</th><th>巡检时间</th><th>巡检人</th><th>状态</th><th>结果</th><th>进度</th><th>操作</th></tr></thead><tbody id="itlInspRows"></tbody></table></div>
      <p class="u-hint">服务器临时一键采集的记录不在这里，在服务器详情的「设备巡检」页签里查看。</p>`;
    renderUnsavedListBanner(); renderOverview(); renderStatusTabs(); renderRows();
    $('#itlInspRoomFilter').addEventListener('change', e => { filters.room = e.target.value; applyFilters(); });
    $('#itlInspTimeFilter').addEventListener('change', e => { filters.period = e.target.value; applyFilters(); });
    $('#itlInspSearch').addEventListener('input', e => { filters.search = e.target.value; applyFilters(); });
    const checkAll = $('#itlInspCheckAll');
    if (checkAll) checkAll.addEventListener('change', e => {
      visibleItems().filter(r => r.actions.includes('archive')).forEach(r => {
        if (e.target.checked) { checked.add(r.id); checkedVersions.set(r.id, r.version); }
        else { checked.delete(r.id); checkedVersions.delete(r.id); }
      }); renderRows();
    });
  }
  // 权限完全按接口返回的 actions 数组驱动，前端不自行按状态/角色推算（方案 §6）。summary 行只可能是
  // 他人草稿（§4.2），没有 status 字段，用 visibility 分支即可判断，不需要另外猜。
  // 草稿与已提交单的动作都按服务端 actions 显示；已提交编辑、逻辑删除、撤回归档由 C5b 接通。
  function rowActionsHtml(row) {
    if (row.visibility === 'summary') return '<span class="itl-muted">他人草稿</span>';
    const parts = [];
    if (row.status === 'draft') {
      // H4：full 可见度不等于"能编辑"——巡检人的写权限被降级为只读后，仍能以 full 可见度看到自己的
      // 草稿（sheetVisibility 只看归属/管理员身份，不看 ACL 写等级），但 actions 会是空数组。这种情况
      // 给"查看"（走只读详情），不给"继续填写"（那会打开一张实际点不动、点了就 403 的可写表单）。
      if (row.actions.includes('save')) parts.push(`<button type="button" class="itl-link" data-insp-continue="${row.id}">继续填写</button>`);
      else parts.push(viewLink('查看', row.id));
      if (row.actions.includes('delete')) parts.push(`<button type="button" class="itl-link itl-danger" data-insp-delete-draft="${row.id}" data-version="${row.version}">删除</button>`);
      return parts.join('');
    }
    parts.push(viewLink('查看', row.id));
    if (row.status === 'submitted' && row.actions.includes('save')) parts.push(`<button type="button" class="itl-link" data-insp-edit="${row.id}">编辑</button>`);
    if (row.status === 'submitted' && row.actions.includes('delete')) parts.push(`<button type="button" class="itl-link itl-danger" data-insp-delete-submitted="${row.id}">删除</button>`);
    if (row.actions.includes('unarchive')) parts.push(`<button type="button" class="itl-link" data-insp-unarchive="${row.id}">撤回归档</button>`);
    return parts.join('');
  }
  const viewLink = (label, id) => `<button type="button" class="itl-link" data-insp-view="${id}">${esc(label)}</button>`;
  function rowHtml(row) {
    const isAdmin = L.isAdmin();
    const can = isAdmin && row.actions.includes('archive');
    const check = isAdmin ? `<td class="itl-inspection-check"><input type="checkbox" aria-label="选择 ${esc(row.room_name)} 巡检单 ${row.id}" data-insp-check="${row.id}"${can ? '' : ' disabled'}${checked.has(row.id) ? ' checked' : ''}></td>` : '';
    const result = row.visibility === 'summary' ? '<span class="itl-muted">—</span>' : row.abnormal ? `<span class="u-status-badge sem-failed">异常 ${esc(row.abnormal)} 项</span>` : '<span class="itl-muted">无异常</span>';
    const filledCol = progressHtml(row.filled, row.total) + (row.visibility === 'summary' ? `${esc(row.filled)}/${esc(row.total)} 项` : `${esc(row.filled)}/${esc(row.total)} 项 · 照片位 ${esc(row.photos_uploaded)}/${esc(row.photos_expected)}`);
    const editedNote = row.visibility === 'full' && row.edit_count ? `<small class="itl-muted itl-inspection-edited">已修改 ${esc(row.edit_count)} 次</small>` : '';
    // L4（C4b顺手修）：summary 行的状态列写死"填写中"、不读 row.status——依据方案 §4.2，summary
    // 可见度只可能出现在「他人未删除的草稿」这一种情形（本人的单/已提交/已归档/已删除都会拿到 full
    // 或看不到这行），所以不需要读 status 字段（接口 summary 行本就不下发 status）也能推出状态。
    return `<tr data-insp-row="${row.id}">${check}<td>${esc(row.room_name)}</td><td>${esc(time(row.visibility === 'summary' || row.status === 'draft' ? row.created_at : row.submitted_at))}</td><td>${esc(row.created_by_name || '—')}</td><td>${row.visibility === 'summary' ? '<span class="u-status-badge sem-wait">填写中</span>' : badge(row.status)}</td><td>${result}</td><td>${filledCol}${editedNote}</td><td><div class="itl-actions">${rowActionsHtml(row)}</div></td></tr>`;
  }
  function renderRows() {
    $('#itlInspRows').innerHTML = visibleItems().map(rowHtml).join('') || `<tr><td colspan="${L.isAdmin() ? 8 : 7}" class="itl-empty">没有符合条件的巡检记录</td></tr>`;
    document.querySelectorAll('[data-insp-check]').forEach(cb => cb.addEventListener('change', e => {
      const id = Number(cb.dataset.inspCheck);
      if (e.target.checked) {
        checked.add(id);
        const row = lastItems.find(r => r.id === id);
        if (row) checkedVersions.set(id, row.version);
      } else {
        checked.delete(id);
        checkedVersions.delete(id);
      }
      renderBatchButton();
    }));
    renderBatchButton();
  }
  function renderBatchButton() {
    const btn = $('#itlInspBatchArchive');
    if (!btn) return;
    btn.hidden = !checked.size;
    btn.textContent = `批量归档（${checked.size}）`;
  }
  function confirmBatchArchive() {
    if (!checked.size) return;
    const rows = [...checked].map(id => lastItems.find(r => r.id === id)).filter(Boolean);
    if (!rows.length) return;
    L.openModal(rows.length > 1 ? `归档 ${rows.length} 张巡检单` : '归档巡检单', `<p>${rows.map(r => esc(r.room_name) + ' · ' + esc(time(r.created_at))).join('<br>')}</p><p class="itl-muted">归档后只读，巡检人不能再编辑或删除。发现问题可由管理员撤回归档。</p>`, async () => {
      // M（C4d采纳，codex 40-R）：发起写请求这一刻记录子视图与视图代次——回调里只有两者都还没变才主动
      // 重载；用户挂起期间切到别的子视图（或切走又切回、经历了别的子视图变化）都只留 toast，不把用户
      // 拉回发起时的那个子视图（H1 的"先核页签"只挡得住"切到了别的页签"，挡不住"仍在巡检页签但已经
      // 切到已删除视图"这种同页签内的子视图漂移）。
      const requestMode = mode, requestGen = viewGen;
      const stillSameSubview = () => L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen;
      // C5a 段3（spec「弹窗所有权」）：本回调的 closeModal(true) 发生在 await 之后（异步、非用户触发的
      // 那一刻）——用请求发起时记下的令牌核对"当前弹窗仍是我打开的这个"，不是则不关，避免关掉用户在
      // 等待期间新开出的另一个弹窗。
      const myModalToken = L.currentModalToken();
      try {
        await L.api('/inspections/sheets/archive', { method: 'POST', body: JSON.stringify({ items: rows.map(r => ({ id: r.id, expected_version: r.version })) }) });
        checked.clear();
        checkedVersions.clear();
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        L.toast('已归档 ' + rows.length + ' 张');
        // 跳过重载这一支也自增__inspLoadSettled——保持"本次写回调对内容区的决定已落定"只有一个可观测
        // 信号，走load()内部完成或走这里跳过完成，测试都能用同一个计数等到。
        if (stillSameSubview()) await load(); else L.__inspLoadSettled++;
      } catch (error) {
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        // 409 SHEET_STATE：整批不生效，按 detail.problems 逐条提示不合格单（不合格原因：不存在或已
        // 删除 / 不是已提交状态 / 版本不符），并刷新列表（spec-C4.md 补充点4）。
        if (error.status === 409 && error.detail && Array.isArray(error.detail.problems)) {
          // M1（C4c采纳）：409后不保留原勾选——继续提交失效的旧勾选大概率再次409，清空并提示重新核对。
          checked.clear();
          checkedVersions.clear();
          L.notice('归档失败，以下单据不合格：' + error.detail.problems.map(p => `#${p.id} ${p.reason}`).join('；') + '。部分单据已变化，请重新勾选核对。');
        } else {
          L.notice(error.message);
        }
        if (stillSameSubview()) await load(); else L.__inspLoadSettled++;
      }
    }, '确认归档');
  }

  // ============================================================
  // 已删除（管理员）
  // ============================================================
  async function loadDeleted() {
    // H1（C4c必修）：同load()——入口第一件事先核对页签，避免写请求回调在用户已切走页签后同步覆盖
    // #itlContent。
    if (L.state.tab !== 'inspections') return;
    enterMode('deleted');
    const seq = ++sequence;
    const container = $('#itlContent');
    const marker = document.createElement('div');
    marker.className = 'itl-empty';
    marker.textContent = '正在读取已删除的巡检记录…';
    container.replaceChildren(marker);
    try {
      const list = await L.api('/inspections/sheets/deleted');
      if (!stillActive(seq, marker)) { L.__inspLoadSettled++; return; }
      lastItems = list.items;
      renderDeleted();
      L.__inspLoadSettled++;
    } catch (error) {
      if (stillActive(seq, marker)) container.innerHTML = `<p class="itl-form-error">${esc(error.message)}</p>`;
      L.__inspLoadSettled++;
    }
  }
  function renderDeleted() {
    // 已知缺口（见交付报告"拿不准的点"）：listRow() 不返回 deleted_by（更不用说姓名 JOIN），"删除
    // 人"这一列在当前接口数据下拿不到——C4 唯一被授权的 routes/ 改动是列表补 version，不在这里再加
    // 一个字段；只展示删除时间，删除人列留空。
    $('#itlContent').innerHTML = `<div class="itl-toolbar"><button type="button" class="u-btn-secondary" id="itlInspBackToList">返回巡检台账</button><h2>已删除的巡检记录</h2><span class="itl-muted">仅管理员可见。已提交后被删除的记录保留在这里，可以恢复；草稿删除后不保留。</span></div>
      <div class="u-corr-table-wrap"><table class="u-corr-table"><thead><tr><th>巡检时间</th><th>机房</th><th>巡检人</th><th>结果</th><th>删除时间</th><th>删除原因</th><th>操作</th></tr></thead><tbody>${lastItems.map(deletedRowHtml).join('') || '<tr><td colspan="7" class="itl-empty">没有已删除的巡检记录</td></tr>'}</tbody></table></div>`;
    $('#itlInspBackToList').addEventListener('click', load);
  }
  function deletedRowHtml(row) {
    const result = row.abnormal ? `<span class="u-status-badge sem-failed">异常 ${esc(row.abnormal)} 项</span>` : '<span class="itl-muted">无异常</span>';
    const canRestore = row.actions.includes('restore');
    return `<tr><td>${esc(time(row.created_at))}</td><td>${esc(row.room_name)}</td><td>${esc(row.created_by_name || '—')}</td><td>${result}</td><td>${esc(time(row.deleted_at))}</td><td>${esc(row.delete_reason || '—')}</td><td>${canRestore ? `<button type="button" class="itl-link" data-insp-restore="${row.id}" data-version="${row.version}">恢复</button>` : ''}</td></tr>`;
  }
  function confirmRestore(id, version, label) {
    L.openModal('恢复巡检记录', `<p>恢复 ${esc(label)} 的巡检记录，回到「已提交」。</p>`, async () => {
      // M（C4d采纳，codex 40-R）：同confirmBatchArchive——记子视图与代次，回调只在两者未变时主动重载。
      const requestMode = mode, requestGen = viewGen;
      const stillSameSubview = () => L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen;
      // C5a 段3：同 confirmBatchArchive——先记令牌，await 之后 closeModal(true) 前先核对。
      const myModalToken = L.currentModalToken();
      try {
        await L.api('/inspections/sheets/' + id + '/restore', { method: 'POST', body: JSON.stringify({ expected_version: version }) });
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        L.toast('已恢复');
        // 跳过重载同样自增__inspLoadSettled，信号语义统一（见confirmBatchArchive注释）。
        if (stillSameSubview()) await loadDeleted(); else L.__inspLoadSettled++;
      } catch (error) {
        // L8（C4b顺手修）/ M2（C4c采纳）：404（该单已在别处被恢复/处理，SHEET_NOT_FOUND）与 409
        // （SHEET_VERSION_CONFLICT，恢复期间该单 version 已变）都不是表单校验错误——留在弹窗里让用户
        // 对着一条已经不存在/已过期的记录重试没有意义。关闭弹窗、用 notice 提示、重载已删除列表（该行
        // 大概率已不在列表里，或version已刷新可重新发起恢复）。其余错误维持既有约定，交给外层就地提示
        // （框架 submit 处理器的 try/catch 会调 formError，见 it-ledger.js:316）。
        if (error.status === 404 || error.status === 409) {
          if (myModalToken === L.currentModalToken()) L.closeModal(true);
          L.notice(error.message);
          if (stillSameSubview()) await loadDeleted(); else L.__inspLoadSettled++;
          return;
        }
        throw error;
      }
    }, '确认恢复');
  }

  // ============================================================
  // 详情页（只读，C5a）——仅 GET /:id full 可见能打开；新建/草稿填写/写队列/采集/提交/删除/管理员动作
  // 都不在本次范围（文件头注释）。异步渲染的丢弃判据是 `seq===sequence && tab==='inspections' &&
  // mode==='detail' && detailId===id && marker.isConnected` 五项合取。C5a-1c 二次预筛（M-2）核实过：
  // **marker.isConnected 是这五项里唯一必要的判据**——本 app 每个视图进入时都会同步
  // `container.replaceChildren(新marker)`/`innerHTML=` 接管共享的 `#itlContent`，任何"离开了这次详情
  // 渲染"的场景（切页签、切子视图、重开同一张或另一张单）都必然先把旧 marker 换掉，单独去掉其余四项
  // 中的任意一项都不会让既有用例转红（已用变异逐项验证）。marker 之外那四项是纵深防御——当前框架下
  // 它们的失效场景已经被 marker 蕴含，不要求"单独删掉某一项就必须有用例转红"，但仍然保留：防的是
  // "以后新增一个不通过 container.replaceChildren/innerHTML 接管 #itlContent 的视图"这种未来变化。
  // 唯一已知的"marker 单独起效、其余四项都不变"的真实场景（P1，见 T 文件）：详情 GET 挂起期间，用户在
  // 已经过了 10 秒自动刷新节流窗口后重新点击"巡检"页签（哪怕已经在这个页签上）——setTab() 不检查
  // "是否已经在这个页签"，autoRefresh() 只检查节流窗口，命中后 it-ledger.js 会同步执行
  // `$('#itlContent').innerHTML = '<div class="itl-empty">正在读取…</div>'`（这行代码不属于本模块，
  // 不会touch sequence/state.tab/mode/detailId 中的任何一个），只有 marker.isConnected 能识别出"内容区
  // 已经被换掉了"。
  // ============================================================
  async function openDetail(id) {
    if (L.state.tab !== 'inspections') return;
    enterMode('detail');
    detailId = id;
    const seq = ++sequence;
    const container = $('#itlContent');
    const marker = document.createElement('div');
    marker.className = 'itl-empty';
    marker.textContent = '正在读取巡检详情…';
    container.replaceChildren(marker);
    try {
      const detail = await L.api('/inspections/sheets/' + id);
      if (!(seq === sequence && L.state.tab === 'inspections' && mode === 'detail' && detailId === id && marker.isConnected)) { L.__inspLoadSettled++; return; }
      renderDetailView(detail);
      L.__inspLoadSettled++;
    } catch (error) {
      // C5a-1b H1（Opus 预筛必修）：失败时若不重置 mode/detailId，render() 分派会一直走
      // `mode==='detail' && detailId!==null` 这一支，切走再切回巡检页签或任何触发 render() 的动作都会
      // 用同一个 id 重新调用 openDetail()、撞同一个错误——单据一删除整个巡检模块就锁死只能 F5。这里
      // 无论什么错误，只要这仍是当前有效的那次请求（三件套守卫），先把 mode 收回 'list'、detailId 清
      // 空，让后续任何 render() 都落回正常的台账列表分支，不会再对着这张打不开的单重试。
      if (seq === sequence && L.state.tab === 'inspections' && mode === 'detail' && detailId === id && marker.isConnected) {
        // LOW（C5a-1c）：改用 enterMode('list') 而不是直接赋值 mode='list'——直接赋值会让 load() 内部
        // 自己的 enterMode('list') 看到"mode 已经是 list、没有变化"而漏增 viewGen（同下面 renderDetailView
        // 末尾"不在这里预置 mode='list'"那条注释是同一个道理：谁先把 mode 改成目标值，谁就要负责递增
        // viewGen，不能让后调用的 enterMode() 白白错过这次子视图切换）。
        enterMode('list'); detailId = null;
        if (error.status === 404) {
          // 404（单已删除 / 已不可见）：不需要用户再点一次"返回"，直接带着明确提示回列表。
          L.toast('这张巡检单已不存在或你无权查看');
          load();
        } else {
          // 其它错误（网络异常等）：留在原地展示错误信息，给一个真正可用的"返回巡检台账"按钮（不是
          // 占位）——mode 已经收回 'list'，点击只是正常调用 load()，不会再撞同一个失败的 GET。
          container.innerHTML = `<p class="itl-form-error">${esc(mapFailureReason(error))}</p><button type="button" class="u-btn-secondary" id="itlSheetErrorBack">返回巡检台账</button>`;
          $('#itlSheetErrorBack').addEventListener('click', load);
        }
      }
      L.__inspLoadSettled++;
    }
  }
  function normalItemsHtml(detail) {
    const tag = (label, missing) => `<span class="itl-normal-tag ${missing ? 'itl-muted' : 'sem-done'}">${esc(label)}${missing ? ' · 未填' : ''}</span>`;
    const visible = it => it.value_kind === 'number' ? it.number_value === null : it.result !== 'bad';
    const unfilled = it => it.value_kind === 'number' ? it.number_value === null : it.result === null;
    const room = detail.items.filter(it => it.section === 'room' && visible(it)).map(it => tag(it.item_label, unfilled(it)));
    const rack = (detail.scope.racks || []).flatMap(r => {
      const items = detail.items.filter(it => it.section === 'rack' && it.target_id === r.id);
      if (items.length === 4 && items.every(it => it.result === 'ok')) return [tag(r.name + ' 四项正常', false)];
      return items.filter(visible).map(it => tag(r.name + ' · ' + it.item_label, unfilled(it)));
    });
    const device = detail.items.filter(it => it.section === 'device' && visible(it)).map(it => tag(it.target_label, unfilled(it)));
    const okCount = detail.items.filter(it => it.result === 'ok').length;
    return `<div class="itl-sheet-ok"><h4>正常项 · 共 ${esc(okCount)} 项</h4>${[['room','机房',room],['rack','机柜',rack],['device','设备',device]].filter(([, , tags]) => tags.length).map(([key,label,tags])=>`<div class="itl-normal-group" data-normal-section="${key}"><b>${label}</b><div>${tags.join('')}</div></div>`).join('')}</div>`;
  }
  function inspectionLogDiffHtml(diff) {
    if (diff.kind === 'item') {
      const field = { result: '判断', number_value: '读数', note: '说明', manual_observation: '人工观察记录' }[diff.field] || diff.field;
      const value = v => v === null || v === undefined ? '（空）' : diff.field === 'manual_observation' ? describeManual(v) : v === 'ok' ? '正常' : v === 'bad' ? '异常' : String(v);
      return `${esc(diff.label)} · ${esc(field)}：${esc(value(diff.before))} → ${esc(value(diff.after))}`;
    }
    if (diff.kind === 'remark') return `总体备注：${esc(diff.before || '（空）')} → ${esc(diff.after || '（空）')}`;
    if (diff.kind === 'photo') return `${esc(diff.label)} · 照片：${diff.before_photo_id ? `旧照片 #${esc(diff.before_photo_id)} <button type="button" class="itl-link" data-log-photo-view="${diff.before_photo_id}">查看旧照片</button>` : '（无）'} → 新照片 #${esc(diff.after_photo_id)}`;
    if (diff.kind === 'photo_invalidated') return `${esc(diff.label)} · 异常照片因${esc(diff.cause || '改回正常')}失效 <button type="button" class="itl-link" data-log-photo-view="${diff.photo_id}">查看旧照片</button>`;
    if (diff.kind === 'photo_removed') return `${esc(diff.label)} · 移除照片 #${esc(diff.photo_id)} <button type="button" class="itl-link" data-log-photo-view="${diff.photo_id}">查看原照片</button>`;
    return '变更记录';
  }
  function inspectionLogHtml(row) {
    const action = { create: '开始填写', submit: '提交巡检', edit: '保存修改', archive: '归档', unarchive: '撤回归档', delete: '删除', restore: '恢复' }[row.action] || row.action;
    const diff = Array.isArray(row.diff) ? `<ul>${row.diff.map(d => `<li>${inspectionLogDiffHtml(d)}</li>`).join('')}</ul>` : '';
    return `<li data-log-id="${row.id}"><span class="itl-muted"><span data-log-time>${esc(time(row.at))}</span> · <span data-log-actor>${esc(row.actor_name || ('操作人 #' + row.actor_id))}</span> · <span data-log-action>${esc(action)}</span></span>${row.reason ? `<p>${esc(row.reason)}</p>` : ''}${diff}</li>`;
  }
  function renderDetailView(detail) {
    releasePhotoOwner(detailPhotoOwner); detailPhotoOwner = makePhotoOwner(detail.id);
    const abnormal = detail.items.filter(it => it.result === 'bad');
    const temp = detail.items.find(it => it.item_key === 'temperature');
    const hum = detail.items.find(it => it.item_key === 'humidity');
    // LOW（C5a-1b）：编辑/删除文案按 detail.actions 实际包含项拼写，不再硬编码"可编辑、删除"——写权限
    // 矩阵目前对 submitted 单的 save/delete 总是同批授予/收回（§4.1），但前端不应该假设这点恒成立，接口
    // 返回什么动作就拼什么词（方案 §6："按钮显示依据接口返回的『可做的动作』，前端不自行推算权限"，文案
    // 也按同一原则处理）。
    const editParts = [];
    if (detail.actions.includes('save')) editParts.push('编辑');
    if (detail.actions.includes('delete')) editParts.push('删除');
    const operationLog = [...detail.log].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
    // M3（C5a-1b 必修，Opus 预筛）：sheetVisibility() 对已删除单，管理员仍是 full 可见度（要能看见才能
    // 恢复）——旧版 renderDetailView 完全没读 deleted_at/delete_reason 两个字段（loadDetail 通过
    // sheetView() 展开整行，两个字段本就在 detail 里），已删除单会被渲染成一张普通已提交单：stateLine 落
    // 到"只有巡检人...和管理员可编辑"这个分支（因为 sheetActions 对已删除单只给 ['restore']，没有
    // save/delete），完全不提示"已删除"。触达路径与 H1 同族——管理员的台账列表还没刷新，行仍显示
    // "已提交"且"查看"可点，但这张单已经被别处删除；因为管理员 GET 仍是 200（不像非管理员会 404），
    // H1 的错误恢复路径不会触发，需要在成功渲染分支里单独处理。**自决点**：择方案①（推荐项，见派单）
    // ——留在详情页给出明确的"已删除"提示，不强制跳转到已删除列表：管理员也可能是想核对这张已知被删的
    // 单的历史内容，不希望被强制打断。
    // LOW（C5a-1c）：兜底文案改为只依据 detail.actions 实际包含项，不再前端推算"巡检人 X 和管理员可
    // 编辑"这句话——那是在猜后端的权限规则（谁能编辑），猜对了没意义，猜错了就是误导；没有 save/delete
    // 时老实说"已提交 · 只读"就够了，同 archived 分支"只读"两个字的口径一致，不需要说明是谁不能编辑。
    // H4：补 draft 分支——只读详情现在也会展示 draft 状态的单（巡检人写权限被降级为只读后看自己的
    // 草稿），旧版没有这一支，落到兜底"已提交 · 只读"，对一张还没提交的草稿是错误陈述。
    const stateLine = detail.deleted_at
      ? `已删除 · ${esc(time(detail.deleted_at))}`
      : detail.status === 'archived'
        ? `已归档${detail.archived_at ? '（' + esc(time(detail.archived_at)) + '）' : ''} · 只读`
        : detail.status === 'draft'
          ? (editParts.length ? `填写中 · 可${editParts.join('、')}` : '填写中 · 只读')
          : editParts.length ? `已提交 · 归档前可${editParts.join('、')}` : '已提交 · 只读';
    // C5b：归档提示保持单一说明；撤回按钮只按服务端 actions.unarchive 显示。
    // LOW（C5a-1c）：已删除单的"如需恢复，到已删除列表操作"这句提示改按 detail.actions.includes('restore')
    // 出现——不再假设"能看到这张已删除单详情的人=能恢复的人"（当前业务规则下二者恰好总是同一批人，
    // sheetVisibility()/sheetActions() 都在 deleted_at 分支把非管理员挡在门外，但前端不应该替后端断言
    // 这条恒成立，接口给了 restore 才提示，没给就不提示）。
    const notice = detail.deleted_at
      ? `<div class="itl-notice">这张巡检单已删除（删除原因：${esc(detail.delete_reason || '未说明原因')}）。仅管理员可查看，内容不能再修改${detail.actions.includes('restore') ? '；如需恢复，到"已删除"列表操作' : ''}。</div>`
      : detail.status === 'archived'
        ? '<div class="itl-notice">这张巡检单已归档，内容不能再修改。</div>'
        : '';
    // C6-d H2（44R复检）：详情/填写页根节点带上 data-sheet-id——浏览器用例用它核对"点击历史表跳转按钮/
    // 竞态放行之后，真正显示出来的是不是那张单"（不再只看#itlFormBack/#itlSheetBack这类与哪张单无关
    // 的通用元素），T/PU/PX/P6 等竞态用例都靠它做核心断言。LOW-1（C6-e）：openInspectionSheet 自己原本
    // 还拿它当"视图根"内部纵深防御（与快照比较），已删除——data-sheet-id 现在只是测试可观测的标记，
    // 不再被任何内部判据读取，详见 openInspectionSheet 头部注释。
    // C5c：设备采集明细展开——只读详情页版本，见 deviceDetailListForView 头部注释（局部闭包状态，
    // 这个视图从不重绘，不需要挂在跨渲染持久化对象上）。先算好 html/wire，innerHTML 赋值后再 wire。
    const deviceList = deviceDetailListForView(detail);
    $('#itlContent').innerHTML = `
      <div class="itl-sheet-toolbar" data-sheet-id="${detail.id}">
        <button type="button" class="u-btn-secondary" id="itlSheetBack">返回巡检台账</button>
        <div class="itl-sheet-title"><h2>${esc(detail.room_name)} · ${esc(dateOnly(detail.submitted_at || detail.created_at).slice(5))} 巡检 ${detail.deleted_at ? '<span class="u-status-badge sem-failed">已删除</span>' : badge(detail.status)}${abnormal.length ? `<span class="u-status-badge sem-failed">异常 ${esc(abnormal.length)} 项</span>` : '<span class="itl-muted">无异常</span>'}</h2>
        <span class="itl-muted">巡检人 ${esc(detail.created_by_name || '—')} · 提交于 ${esc(time(detail.submitted_at))} · ${stateLine}</span></div>
        <span class="itl-sheet-grow"></span>
        ${detail.status === 'submitted' && !detail.deleted_at && detail.actions.includes('save') ? '<button type="button" class="u-btn-primary" id="itlSheetEdit">编辑</button>' : ''}
        ${detail.status === 'submitted' && !detail.deleted_at && detail.actions.includes('delete') ? '<button type="button" class="itl-link itl-danger" id="itlSheetDelete">删除</button>' : ''}
        ${detail.actions.includes('unarchive') ? '<button type="button" class="u-btn-secondary" id="itlSheetUnarchive">撤回归档</button>' : ''}
      </div>
      <div id="itlUnsavedForm"></div>
      ${notice}
      <div class="itl-sheet-readings itl-sheet-metrics" id="itlSheetMetrics">
        <div><span>检查项</span><strong data-metric-value>${esc(detail.progress.filled)} / ${esc(detail.progress.total)}</strong><small>已填 / 总数</small></div>
        <div><span>异常</span><strong data-metric-value>${esc(detail.progress.abnormal)}</strong><small>异常检查项</small></div>
        <div><span>照片位置</span><strong data-metric-value>${esc(detail.progress.photosUploaded)} / ${esc(detail.progress.photosExpected)}</strong><small>已齐备 / 必需位置</small></div>
        ${[[temp,'机房温度','℃','temperature'],[hum,'机房湿度','%','humidity']].map(([it,label,unit,key])=>{const range=SOFT_RANGE[key];const value=it&&it.number_value;const outside=Number.isFinite(value)&&(value<range[0]||value>range[1]);return `<div><span>${label}</span><strong data-metric-value>${Number.isFinite(value)?esc(value)+' '+unit:'—'}</strong><small>参考 ${range[0]}–${range[1]}${outside?' · 超出参考范围':''}</small></div>`;}).join('')}
      </div>
      <div class="itl-sheet-detail-layout"><div class="itl-sheet-detail-main">
      <section class="itl-sheet-card" id="itlSheetResults"><header><h3>检查结果</h3>${abnormal.length ? `<span class="u-status-badge sem-failed">异常 ${esc(abnormal.length)} 项</span>` : '<span class="itl-sheet-clear">本次无异常项</span>'}</header>
        ${abnormal.length ? `<div class="itl-sheet-bad-list">${abnormal.map(it => `<div><strong>${esc(it.target_label)} · ${esc(it.item_label)}</strong><p>${esc(it.note || '')}</p></div>`).join('')}</div>` : ''}
        ${normalItemsHtml(detail)}</section>
      ${deviceList.html}
      ${manualReadOnlyHtml(detail)}
      <section class="itl-sheet-card"><p class="itl-sheet-remark-view"><b>总体备注</b>${esc(detail.remark || '无')}</p></section>
      </div><aside class="itl-sheet-detail-side">
      <section class="itl-sheet-card"><header><h3>巡检照片 · ${esc((detail.photos || []).length)} 张</h3></header><div class="itl-sheet-photo-grid">${(detail.photos || []).map(p => `<div class="itl-sheet-photo-file" data-photo-id="${p.id}"><img data-photo-thumb-id="${p.id}" data-photo-thumb-status="loading" alt="${esc(p.original_name)}"><span>${esc(p.original_name)}</span><button type="button" class="itl-link" data-detail-photo-view="${p.id}" data-photo-name="${esc(p.original_name)}">放大</button></div>`).join('') || '<p class="itl-muted">没有照片</p>'}</div></section>
      <section class="itl-sheet-card itl-sheet-log"><h3>操作记录 · ${esc(operationLog.length)} 条</h3><ol>${operationLog.map(inspectionLogHtml).join('')}</ol></section>
      </aside></div>`;
    // 不在这里预置 mode='list'——留给 load() 内部的 enterMode() 去对比"离开前的 mode"（这里是 'detail'）
    // 与 'list' 判断代次是否要递增；如果这里先把 mode 改成 'list'，enterMode() 会看到"没变化"而漏增代次。
    $('#itlSheetBack').addEventListener('click', () => { detailId = null; load(); });
    $('#itlSheetEdit')?.addEventListener('click', () => openSubmittedEdit(detail));
    $('#itlSheetDelete')?.addEventListener('click', () => confirmDeleteSubmitted(detail));
    $('#itlSheetUnarchive')?.addEventListener('click', () => confirmUnarchive(detail));
    // 外审 LOW：捕获本次渲染的 owner——onLeave 会把模块变量置 null，迟到回调再读 .disposed 会抛 TypeError。
    const ownerAtRender = detailPhotoOwner;
    const detailActive = () => mode === 'detail' && detailId === detail.id && L.state.tab === 'inspections' && !!ownerAtRender && detailPhotoOwner === ownerAtRender && !ownerAtRender.disposed && ownerAtRender.token === getToken();
    hydratePhotoThumbs(detailPhotoOwner, $('#itlContent'), detailActive);
    $('#itlContent').querySelectorAll('[data-detail-photo-view],[data-log-photo-view]').forEach(btn => btn.addEventListener('click', () => openPhotoViewer(detailPhotoOwner, Number(btn.dataset.detailPhotoView || btn.dataset.logPhotoView), btn.dataset.photoName || '巡检照片', btn, detailActive)));
    deviceList.wire($('#itlContent'));
    // N-L2（C5a-g）：只读详情页也挂常驻条——写权限被降级（如"编辑权限已变化"）之后重开同一张单只能走
    // 只读详情，此前完全看不到之前登记表里的记录，等于内容"找不回来"（无路径可达）。
    renderUnsavedFormBanner(detail.id);
  }

  // ============================================================
  // 新建 / 草稿填写页（C5a 剩余部分）——三段卡片 + 每张单一个串行写队列（"幂等 diff 覆盖层"设计，
  // 见 handoff-agent6.md §3.1）：working 是唯一真相源，永不清空；每次真正发起 PUT 时才现算脏集合，
  // 成功后 detail 换成响应值作新基线；若发送期间又有新编辑落进 working，脏判定相对新基线仍然成立，
  // 天然满足"飞行中修改保留且随下一次 PUT 发出"，不需要任何合并/快照回填逻辑。409 SHEET_VERSION_CONFLICT
  // 保留本地未保存修改（conflictIds 标记）、其余项用重新 GET 的服务器值刷新，不自动重发。
  // ============================================================
  const NUMBER_RANGE = { temperature: [-20, 60], humidity: [0, 100] };
  // C5a-c §3.1第2条：软性参考范围——与NUMBER_RANGE（硬范围，越界拦截用）是两套数字，取自模板文案本身
  // （建单模板 item_label 里的"参考 18–27"/"参考 40–60"，方案 §3）。落在硬范围内、超出这个软范围只提示
  // "超出参考范围"，仍允许保存；不越硬范围就不拦截、不进这条判断。
  const SOFT_RANGE = { temperature: [18, 27], humidity: [40, 60] };
  const NOTE_MAXLEN = 500, REMARK_MAXLEN = 2000; // LOW：与后端常量一致（inspection-sheets.js:106/:64）
  let form = null; // 当前激活的表单会话；一次只允许一个（新建/继续填写会替换掉上一个）
  let detailPhotoOwner = null, photoViewer = null;
  function makePhotoOwner(sheetId) { return { sheetId, token: getToken(), urls: new Map(), loading: new Map(), disposed: false }; }
  function closePhotoViewer() {
    if (!photoViewer) return;
    const { el, focus } = photoViewer;
    el.remove(); photoViewer = null;
    if (focus && focus.isConnected) focus.focus();
  }
  function releasePhotoOwner(owner) {
    if (!owner || owner.disposed) return;
    owner.disposed = true;
    for (const url of owner.urls.values()) URL.revokeObjectURL(url);
    owner.urls.clear(); owner.loading.clear();
    if (photoViewer && photoViewer.owner === owner) closePhotoViewer();
  }
  async function photoUrl(owner, photoId) {
    if (owner.disposed || owner.token !== getToken()) throw new Error('照片视图已关闭');
    if (owner.urls.has(photoId)) return owner.urls.get(photoId);
    if (owner.loading.has(photoId)) return owner.loading.get(photoId);
    const task = (async () => {
      const blob = await L.readInspectionPrivateBlob('/inspections/sheets/' + owner.sheetId + '/photos/' + photoId + '/content');
      if (owner.disposed || owner.token !== getToken()) throw new Error('照片视图已关闭');
      const url = URL.createObjectURL(blob);
      owner.urls.set(photoId, url);
      return url;
    })();
    owner.loading.set(photoId, task);
    try { return await task; }
    finally {
      owner.loading.delete(photoId);
      const key = owner.sheetId + ':' + photoId;
      L.__inspPhotoReadSettledById.set(key, (L.__inspPhotoReadSettledById.get(key) || 0) + 1);
    }
  }
  function hydratePhotoThumbs(owner, root, stillActive) {
    if (!root || owner.disposed) return;
    root.querySelectorAll('[data-photo-thumb-id]').forEach(img => {
      const photoId = Number(img.dataset.photoThumbId);
      photoUrl(owner, photoId).then(url => {
        if (stillActive() && img.isConnected) { img.src = url; img.dataset.photoThumbStatus = 'loaded'; }
      }).catch(() => { if (stillActive() && img.isConnected) img.dataset.photoThumbStatus = 'error'; });
    });
  }
  async function openPhotoViewer(owner, photoId, name, focus, stillActive) {
    try {
      const url = await photoUrl(owner, photoId);
      if (!stillActive() || !focus.isConnected) return;
      closePhotoViewer();
      const el = document.createElement('div'); el.className = 'itl-evidence-viewer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', name);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'u-btn-secondary'; close.textContent = '关闭图片';
      const img = document.createElement('img'); img.src = url; img.alt = name;
      el.append(close, img); document.body.append(el); photoViewer = { el, owner, focus };
      close.onclick = closePhotoViewer; el.onclick = event => { if (event.target === el) closePhotoViewer(); }; close.focus();
    } catch (error) { if (stillActive()) L.notice('照片读取失败：' + mapFailureReason(error)); }
    finally {
      const key = owner.sheetId + ':' + photoId;
      L.__inspPhotoViewerSettledById.set(key, (L.__inspPhotoViewerSettledById.get(key) || 0) + 1);
    }
  }
  // M8：写队列按单据 id 建，不挂在表单会话对象上——这样"表单已关闭/尚未打开"时（如从列表直接删除草稿）
  // 也能排进同一条队列，且"关表单→重开同一张草稿"天然复用还没跑完的旧队列（不建新的空队列覆盖它）。
  const queuesBySheetId = new Map(); // sheetId -> {queue:[], queueRunning:bool}
  function queueFor(sheetId) { let q = queuesBySheetId.get(sheetId); if (!q) { q = { queue: [], queueRunning: false }; queuesBySheetId.set(sheetId, q); } return q; }
  // enqueue 返回一个 Promise（task 的返回值/异常原样转发）——多数调用方不 await（发完即忘：自动保存/
  // 采集/提交都是"排进去就不管"），但删除草稿（M2）需要知道"冲刷有没有成功"才能决定要不要继续删，所以
  // 保留返回值。同一 tick 内连续两次 enqueue（如"先冲刷再执行"）靠 push 顺序天然不被别的任务插队。
  function enqueue(sheetId, task) {
    const q = queueFor(sheetId);
    const p = new Promise((resolve, reject) => { q.queue.push(async () => { try { resolve(await task()); } catch (e) { reject(e); } }); });
    runQueue(sheetId);
    return p;
  }
  async function runQueue(sheetId) {
    const q = queueFor(sheetId);
    if (q.queueRunning) return;
    q.queueRunning = true;
    while (q.queue.length) { const task = q.queue.shift(); await task(); }
    q.queueRunning = false;
    if (!q.queue.length) { queuesBySheetId.delete(sheetId); pruneLiveSessions(); } // 队列空了就清掉（beforeunload 靠 size 判断）；codex 48-R：顺带剔除已结束的会话
  }
  // C5a-f（H1+H2，主会话裁定 G5=A′实现口径内的选择）：未保存原文换一个本视图自己持有的载体，不再只靠
  // 共享层单槽位 #itlNotice 承载（会被后来的提示覆盖，切页签/autoRefresh 时共享层还会把它清空——见
  // notifyLeaveFlushFailure 头部注释）。模块级登记表 sheetId -> {label, parts[], reason, at}：
  // notifyLeaveFlushFailure/notifyExcludedConflicts 在发一次 L.notice 即时提醒之前先写这里；巡检列表
  // 视图顶部（#itlUnsavedList，renderList 渲染）与对应表单顶部（#itlUnsavedForm，renderForm 渲染）
  // 各自从这张表读取、渲染成常驻条，都不经过 #itlNotice，天然不受共享层清空链路影响。只有用户点"知道
  // 了"（clearUnsaved）才删除条目——保存成功/切页签/autoRefresh 都不清（这几个函数各自专门只做自己
  // 那一件事，不把 unsavedByAccountSheet.delete 顺手塞进任何"成功"收尾路径，避免违反"只有用户确认才清除"
  // 这条不变式）。
  const initialToken = getToken();
  function accountIdForToken(token) {
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const id = payload.id ?? payload.sub; // the platform JWT currently uses id; accept sub as well
      if (id != null) return String(id);
    } catch (_e) { /* opaque test/session token */ }
    // /api/auth/me populates currentUser for the initial page. Never use its
    // possibly stale value for a token installed later by a storage event.
    if (token === initialToken && typeof currentUser !== 'undefined' && currentUser && currentUser.id != null) return String(currentUser.id);
    return null;
  }
  const currentAccountId = () => accountIdForToken(getToken());
  const unsavedKey = (accountId, sheetId) => accountId + ':' + sheetId;
  const unsavedByAccountSheet = new Map(); // (account id, sheet id) -> entry
  // codex 48 H-3：仍可能有排队任务的表单会话（含已离开的旧会话）。失权时逐个标 accessLost，不只标当前
  // form——旧会话的离开冲刷、排队提交等同样不能再发请求。已销毁且该单队列已空的会话随时剔除。
  const liveSessions = new Set();
  function pruneLiveSessions() { for (const s of liveSessions) if (s.destroyed && !queuesBySheetId.has(s.id)) liveSessions.delete(s); }
  // 本视图最近一次确认过的 token：onAccessLost 以它判断这次是换号（token 变了）还是失权（token 未变），
  // 不依赖此刻有没有打开的表单。
  let viewToken = initialToken;
  // C6-e（第8条，主会话裁定，C5a-f 抽查发现）：同一张单再次登记时改为合并，不再是 Map.set 直接覆盖。
  // 覆盖会丢数据：用户离开失败丢了 X，重开后只补填/修改了 Y（没碰 X），再次离开又失败——这次的 parts
  // 只包含 Y（X 在这次会话里从未变脏，computeDirty 不会把它算进去），如果直接覆盖旧条目，X 的原文就
  // 随第一次登记一起被冲掉，常驻条只剩 Y，用户永远找不回 X 丢失的内容了。只有用户点"知道了"
  // （clearUnsaved）才会真正清空整条记录。
  // MED-3（C5a-g 追加 A，C6-e 抽查发现）：合并键改结构化——旧版按"显示文本第一个『：』之前的部分"当
  // 键，同名设备（it_assets.name 没有唯一约束）或机柜名本身带"："时，两个不同的检查项会被误判成同一
  // 个键，静默覆盖/塌并成一条，用户会以为某一项根本没记录过。parts 现在存 `{key, text, reason}`：key
  // 是 `'item:' + it.id`（数字 id 天然唯一，不解析任何显示文本）或 `'remark'`；同 key 取新值、不同 key
  // 追加，不再从文本反解析。reason 从"整条 entry 一个"下放到"每个 part 各自记"——LOW-1：同一条登记表
  // 记录里，X 项这次是因为网络异常没保存上、Y 项是之前因为版本冲突没保存上，两者原因不同，合并时不能
  // 用后来的原因覆盖 X 的历史原因；渲染时逐项标注各自的原因（见 unsavedEntryHtml）。
  // W1 M2：登记条目按账号 id 与单号隔离。同账号重新登录仍能看到旧原文；换到其他账号时仅隐藏，
  // 直到原账号点"知道了"才删除。发请求前另用 f.token 精确核对本次表单会话身份。
  function mergeUnsavedParts(oldParts, newParts) {
    const byKey = new Map();
    for (const p of oldParts) byKey.set(p.key, p);
    for (const p of newParts) byKey.set(p.key, p);
    return [...byKey.values()];
  }
  // parts 入参形如 [{key,text}]（不含 reason——registerUnsaved 统一打上这次调用共同的 reason，因为一次
  // 登记调用本就对应"同一次失败"，这批 part 天然共享同一个原因；reason 下放到 part 上是为了正确处理
  // "跨多次登记合并"这件事，不是单次调用内部还要分出不同原因）。
  function registerUnsaved(sheetId, label, parts, reason, accountId) {
    if (accountId === null) return; // unknown identity must never be attributed to another account
    const taggedParts = parts.map(p => ({ key: p.key, text: p.text, reason }));
    const key = unsavedKey(accountId, sheetId), existing = unsavedByAccountSheet.get(key);
    const mergedParts = existing ? mergeUnsavedParts(existing.parts, taggedParts) : taggedParts;
    unsavedByAccountSheet.set(key, { sheetId, accountId, label, parts: mergedParts, at: Date.now(), deleted: false });
    refreshUnsavedBanners();
  }
  function clearUnsaved(sheetId) {
    const accountId = currentAccountId();
    if (accountId === null || !unsavedByAccountSheet.delete(unsavedKey(accountId, sheetId))) return;
    refreshUnsavedBanners();
  }
  // W1 M4：后续 PUT 成功只标记这项的新保存值；旧原文留到用户点"知道了"，不因保存成功自动摘除。
  function reconcileUnsavedAfterSave(f, savedItems, savedRemark) {
    const entry = unsavedByAccountSheet.get(unsavedKey(f.accountId, f.id));
    if (!entry) return;
    const ids = new Set(savedItems.map(it => it.id));
    let changed = false;
    for (const part of entry.parts) {
      let savedAs;
      if (part.key === 'remark' && savedRemark) savedAs = f.remarkWorking || '（空）';
      else if (part.key.startsWith('item:') && ids.has(Number(part.key.slice(5)))) {
        const item = itemById(f, Number(part.key.slice(5)));
        if (item) savedAs = describeWorkingValue(f, item);
      }
      if (savedAs !== undefined && part.savedAs !== savedAs) { part.savedAs = savedAs; changed = true; }
    }
    if (changed) refreshUnsavedBanners();
  }
  // N-L3（C5a-g）：单据已经被删除（confirmDeleteDraftRow 删除成功后调用）——登记表条目不删（用户还没
  // 点"知道了"，删单不等于确认已经看到过/找回过丢失的内容），只标记一下，渲染时改措辞、不再说
  // "重新打开该单补填"（单都没了，这句话字面上不成立）。
  function markUnsavedDeleted(sheetId) {
    const accountId = currentAccountId();
    const entry = accountId === null ? null : unsavedByAccountSheet.get(unsavedKey(accountId, sheetId));
    if (!entry) return;
    entry.deleted = true;
    refreshUnsavedBanners();
  }
  // N-L2/N-L3（C5a-g）：常驻条文案按 entry.deleted / 逐项 reason 分三支——删除优先于权限措辞（两者都
  // 命中时，"单已经不在了"比"你没权限"更贴近用户此刻真正需要知道的事）：
  // ① 已删除：不再说"重新打开该单补填"（单都没了）；
  // ② 条目里的项全部都是"编辑权限已变化"：不说"补填"（没权限的人补填不了，指引一个做不到的动作没有
  //    意义），改成直陈"你已没有编辑权限，以下内容未能保存"，不逐项重复标"（原因：编辑权限已变化）"
  //    （反正整条都是同一个原因，标了也是废话）；
  // ③ 其余（含"同一条混着不同原因"的情况，MED-3 LOW-1）：保留"离开时有修改未能保存……请重新打开该单
  //    补填"整体措辞，但每一项后面单独标它自己的原因，不是整条只说一个原因。
  function unsavedEntryHtml(sheetId, entry, readOnly) {
    const allPermission = entry.parts.length > 0 && entry.parts.every(p => p.reason === '编辑权限已变化');
    const plainItems = entry.parts.map(p => esc(p.text) + (p.savedAs === undefined ? '' : '（已被后续保存为：' + esc(p.savedAs) + '）')).join('；') || '（无法确定具体内容）';
    const itemsWithReason = entry.parts.map(p => esc(p.text) + (p.text.includes('（' + p.reason + '，未保存）') ? '' : '（原因：' + esc(p.reason) + '）') + (p.savedAs === undefined ? '' : '（已被后续保存为：' + esc(p.savedAs) + '）')).join('；') || '（无法确定具体内容）';
    let body;
    if (entry.deleted) body = `巡检单〈${esc(entry.label)}〉（该单已删除）有内容未能保存：${itemsWithReason}`;
    else if (allPermission) body = `巡检单〈${esc(entry.label)}〉：你已没有编辑权限，以下内容未能保存：${plainItems}`;
    else if (readOnly) body = `巡检单〈${esc(entry.label)}〉有修改未能保存：${itemsWithReason}。请返回巡检台账核对。`;
    else body = `巡检单〈${esc(entry.label)}〉离开时有修改未能保存：${itemsWithReason}。请重新打开该单补填。`;
    return `<div class="itl-notice itl-unsaved-entry" data-unsaved-sheet="${sheetId}"><span>${body}</span> <button type="button" class="itl-link" data-unsaved-ack="${sheetId}">知道了</button></div>`;
  }
  // 列表顶部：登记表里属于当前账号 id 的全部条目——未保存内容属于"这张单+
  // 这个账号"，不属于"这次筛选/这次加载结果"，不因筛选条件而增减，用户在任何筛选状态下都能看到、点开
  // "知道了"。不属于当前账号的条目始终不渲染。
  function renderUnsavedListBanner() {
    const el = $('#itlUnsavedList');
    if (!el) return;
    const accountId = currentAccountId();
    el.dataset.accountId = accountId || '';
    el.innerHTML = accountId === null ? '' : [...unsavedByAccountSheet.values()].filter(entry => entry.accountId === accountId).map(entry => unsavedEntryHtml(entry.sheetId, entry)).join('');
  }
  // 表单/只读详情顶部：只显示"当前这张单"自己的条目（若有，且属于当前账号）——同一份数据源，换一个
  // 展示位置。N-L2：只读详情页（renderDetailView）也调用这个函数，不再只有可写表单才看得到。
  function renderUnsavedFormBanner(sheetId) {
    const el = $('#itlUnsavedForm');
    if (!el) return;
    const accountId = currentAccountId();
    const entry = accountId === null ? null : unsavedByAccountSheet.get(unsavedKey(accountId, sheetId));
    el.innerHTML = entry ? unsavedEntryHtml(sheetId, entry, mode === 'detail') : '';
  }
  function refreshUnsavedBanners() {
    renderUnsavedListBanner();
    const sheetId = form && !form.destroyed ? form.id : detailId;
    if (sheetId !== null) renderUnsavedFormBanner(sheetId);
  }
  function availableRoomsForNewSheet() { return [...new Set(L.state.racks.map(r => r.room).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
  const MANUAL_FIELDS = ['observation', 'cpu_percent', 'memory_percent', 'disk_percent', 'disk_label', 'source', 'observed_at'];
  const MANUAL_SOURCES = { management: '设备管理页面', monitor: '系统监控界面', instrument: '现场仪表', other: '其他' };
  function normalizeManual(value) {
    if (!value) return null;
    const m = Object.fromEntries(MANUAL_FIELDS.map(k => [k, value[k] === '' || value[k] === undefined ? null : value[k]]));
    return MANUAL_FIELDS.every(k => m[k] === null) ? null : m;
  }
  const sameManual = (a, b) => JSON.stringify(normalizeManual(a)) === JSON.stringify(normalizeManual(b));
  const workingItem = it => ({ result: it.result, number_value: it.number_value, note: it.note, manual_observation: normalizeManual(it.manual_observation) });
  const sameWorkingItem = (a, b) => a.result === b.result && a.number_value === b.number_value && a.note === b.note && sameManual(a.manual_observation, b.manual_observation);
  function workingFromItems(items) { return new Map(items.map(it => [it.id, workingItem(it)])); }
  function describeManual(value) {
    const m = normalizeManual(value); if (!m) return '（空）';
    return [m.observation, ...[['cpu_percent','CPU'],['memory_percent','内存'],['disk_percent','磁盘使用率']].filter(([k]) => m[k] !== null).map(([k,n]) => n + ' ' + m[k] + '%'), m.disk_label ? '磁盘/卷：' + m.disk_label : null, m.source ? '来源：' + MANUAL_SOURCES[m.source] : null, m.observed_at ? '观察于 ' + time(m.observed_at) : null].filter(Boolean).join('；');
  }
  function manualReadOnlyHtml(detail) {
    const items = detail.items.filter(it => it.section === 'device' && normalizeManual(it.manual_observation));
    return items.length ? `<section class="itl-sheet-card"><header><h3>人工观察记录</h3></header>${items.map(it=>`<div class="itl-sheet-manual-read" data-manual-read="${it.id}"><strong>${esc(it.target_label)}</strong><p>${esc(describeManual(it.manual_observation))}</p></div>`).join('')}</section>` : '';
  }
  // C5a-d（G4=A，spec-C5a-d.md）：deviceIssueItemIds 精确定义核对结论（§必做7）——
  // sheetProgress()/deviceJudgementError() 只列"此刻仍缺说明"的设备项：一旦该行的 note 落库非空，
  // deviceJudgementError 返回 null，下一次响应的 deviceIssueItemIds 就不再包含它。若 notesHtml 只认
  // 当次这个数组，说明框会在用户填完说明并保存成功后自己消失——前端拿不到 alertsCount/
  // cleanupWarningsCount 等独立依据（不改 routes/），改用派单认可的兜底：everDeviceIssueIds 是"这个
  // 表单会话内曾经出现过的全部设备说明要求"累积集合，只增不减，随 f.detail 每次刷新（成功保存/冲突
  // 合并/采集重取）调用 trackDeviceIssueIds() 并入；notesHtml/toggleSeg 认这个累积集合，不认当次瞬时
  // 数组——一旦命中过，本表单会话内说明框保持显示，不会因为"刚保存的说明恰好满足了规则"而消失。
  function trackDeviceIssueIds(f) {
    const ids = (f.detail.progress && f.detail.progress.missing && f.detail.progress.missing.deviceIssueItemIds) || [];
    ids.forEach(id => f.everDeviceIssueIds.add(id));
  }
  function makeForm(id, detail) {
    const f = {
      id, detail, working: workingFromItems(detail.items), remarkWorking: detail.remark ?? null,
      timer: null, collecting: new Set(),
      conflictIds: new Set(), remarkConflict: false, savedAt: null, destroyed: false,
      // H1：left=true 表示"用户已经切走页签，这个表单会话暂时不在屏幕上"——onLeave 置位，renderForm
      // （唯一真正把这个表单画出来的函数）在开头清掉；formVisible() 是所有"要不要动 DOM"判断的唯一入口。
      left: false,
      // H2：lastFlushOk 记录"最近一次 performFlush 是否真的把当前脏数据存进去了"——true 包含"本来就
      // 没有要存的"（trivially ok）；conflict/网络错误/LEDGER_BUSY 等任何失败都置 false。performSubmit
      // 开头核这个值，不满足就不发 POST /submit（H2）。
      lastFlushOk: true,
      // C5a-d（G4=A）：在途锁的四个独立标志，isLocked() 把它们 OR 起来。分开维护（不是单一 boolean）
      // 是因为它们各自的"起止时刻"由不同函数负责（flushing 由 performFlush 自己管；submitting/deleting
      // 由 doSubmit/confirmDeleteDraftRow 在排队前就置位，覆盖住它们各自内部排的那次 performFlush 子
      // 步骤，避免"冲刷步骤自己解锁又立刻被提交/删除步骤重新锁上"这一瞬间的可见解锁态），OR 起来的结果
      // 才是"整张表单现在能不能编辑"的唯一判据。
      flushing: false, submitting: false, deleting: false,
      submittedEdit: detail.status === 'submitted', savingEdit: false, discardingPending: false, photoBusy: false,
      photoOwner: makePhotoOwner(id), photoMessage: '', photoMessages: new Map(), pendingDecision: (detail.my_pending_photos || []).length + (detail.my_removed_photo_ids || []).length > 0, incompleteDetail: null,
      // 外审 M-1（用户 09-26 裁 A）：进入编辑时就已存在的残留待生效照片，按 id 冻结。「继续使用 / 丢弃」
      // 只针对这批，本次会话新传的照片不计数、不被「丢弃」删掉。
      leftoverPendingIds: new Set((detail.my_pending_photos || []).map(p => p.id)),
      leftoverRemovalIds: new Set(detail.my_removed_photo_ids || []),
      // 外审 H-2：失权（token 未变的 403 兜底）结束的会话——排队中的后续任务不再发请求、不再出提示。
      accessLost: false,
      everDeviceIssueIds: new Set(),
      // C5a-e（G5=A′）：这个表单会话是否已经因为离开冲刷失败给用户展示过一次常驻提示——去重用，见
      // notifyLeaveFlushFailure 头部注释（在途冲刷失败 + 离开冲刷再失败不出两条）。
      leaveFailureNotified: false,
      // token 核对待发写请求；accountId 归属未保存原文。同账号重登不丢提醒。
      token: getToken(), accountId: currentAccountId(),
      // C5c（方案v0.6§6"设备采集明细展开"条）：设备段展开/收起——expandedItemIds 记当前展开的检查项
      // id（不是 device_inspection_id，那个会随重新采集变化，item.id 稳定）；deviceExpandTouched 记
      // "用户是否手动切换过这一行"（决定后台请求落地时要不要再按告警覆盖它）；deviceDetailCache 按
      // device_inspection_id 为键缓存 GET /inspections/:id 的响应（该行重新采集后 device_inspection_id
      // 变化，缓存自然失效，不用显式清理）。三者只受展开按钮/后台请求驱动，不受在途锁影响、不进写
      // 队列（方案原文"展开按钮只是本地UI"）。
      expandedItemIds: new Set(), deviceExpandTouched: new Set(), deviceDetailCache: new Map(),
      openSections: new Set(['basic', 'room']), activeSection: 'room',
      manualOpenIds: new Set(detail.items.filter(it => it.manual_observation && MANUAL_FIELDS.slice(1).some(k=>it.manual_observation[k] != null)).map(it=>it.id)),
    };
    trackDeviceIssueIds(f);
    pruneLiveSessions(); liveSessions.add(f);
    return f;
  }
  function sheetLabel(f) { return f.detail.room_name + ' · ' + dateOnly(f.detail.created_at); }
  function itemById(f, itemId) { return f.detail.items.find(it => it.id === itemId); }
  // H1：唯一的"现在能不能把这个表单画到屏幕上"判据——form===f（还是当前会话，没被更新的/更换的表单
  // 顶替）且没有被标记为"已离开"（left）且没有被销毁。旧版只判 form===f，漏了"用户已经切到别的页签，
  // 但 form 变量本身还指着这同一个会话对象"这一种情况（onLeave 只排冲刷，从不清空 form/mode）。
  function formVisible(f) { return form === f && !f.left && !f.destroyed && f.token === getToken(); }
  // C5a-d（G4=A 核心）：在途锁——PUT 冲刷、冲突重取 GET、采集 POST + 其后重取、提交 POST、删除，任一
  // 在飞行中都算"在途"。四个标志 OR 起来；渲染层（segHtml/roomSectionHtml/notesHtml/sectionCardHtml/
  // updateActionBar 的按钮 disabled、remark 输入框）与每个写监听器（toggleSeg/onNumberInput/
  // onNoteInput/allNormal/remark 的 input 监听/doSubmit/doCollect）开头都查这一个函数，双保险（方案
  // 必做1）。有了它，"请求在途 × 用户继续操作"这一整类状态从根上不可达——见下面各函数头部注释里标注
  // 哪些旧分支因此被删除。
  function isLocked(f) { return f.flushing || f.submitting || f.deleting || f.savingEdit || f.discardingPending || f.photoBusy || f.collecting.size > 0; }
  // C5a-d S-H5（43S H5）：清除"本地值已与当前服务器基线一致"的冲突标记——冲突处理后用户可能什么都没
  // 再改就触发了下一轮空冲刷（比如离开页签又回来，或合并 fresh 后局部恰好与本地值一致），残留的
  // conflictIds/remarkConflict 不该永久卡住提交按钮与高亮。调用点：performFlush 的"无脏数据可发"早退
  // 分支、handleConflict 合并完之后。返回是否真的清掉了什么，供调用方决定要不要重渲染。
  function reconcileConflictMarkers(f) {
    let changed = false;
    for (const id of [...f.conflictIds]) {
      const it = itemById(f, id);
      const w = f.working.get(id);
      if (it && w && sameWorkingItem(w, it)) { f.conflictIds.delete(id); changed = true; }
    }
    if (f.remarkConflict && f.remarkWorking === (f.detail.remark ?? null)) { f.remarkConflict = false; changed = true; }
    return changed;
  }
  // 脏判定：working 里的三字段与当前 detail.items（最近一次成功响应）任一不等即为脏——比较对象永远是
  // "现在的" detail，不是排队时的旧值，这样"请求体只含变更项"与"飞行期修改保留"两条约束自动同时满足。
  function computeDirty(f) {
    const items = [];
    for (const it of f.detail.items) {
      const w = f.working.get(it.id);
      if (!w) continue;
      if (!sameWorkingItem(w, it)) items.push({ id: it.id, result: w.result, number_value: w.number_value, note: w.note, ...(!sameManual(w.manual_observation, it.manual_observation) ? { manual_observation: normalizeManual(w.manual_observation) } : {}) });
    }
    return { items, remarkChanged: f.remarkWorking !== (f.detail.remark ?? null) };
  }
  // C5a-d S-H3/S-H4（43S H3/H4）：冲突重取（handleConflict）与采集重取（performCollect）共用的合并
  // 函数——本地此刻脏的检查项/备注保留本地值不被覆盖，其余取服务器 fresh 值。在途锁保证从判断脏集合
  // 到应用 fresh 之间不会再有新的用户编辑插进来，这里算一次即可（旧版为了防"GET 期间的新编辑"要分
  // "发起时"与"应用时"两次计算脏集合，在途锁下那类编辑已经不可能发生，不需要再分两次）。
  function applyFreshMerge(f, fresh) {
    const dirty = computeDirty(f);
    const dirtyIds = new Set(dirty.items.map(it => it.id));
    f.detail = fresh;
    trackDeviceIssueIds(f);
    for (const it of fresh.items) if (!dirtyIds.has(it.id)) f.working.set(it.id, workingItem(it));
    if (!dirty.remarkChanged) f.remarkWorking = fresh.remark ?? null;
    return dirty;
  }
  function mergeAfterPhotoWrite(f, fresh) {
    const before = f.detail, dirty = computeDirty(f);
    applyFreshMerge(f, fresh);
    const oldItems = new Map(before.items.map(it => [it.id, it]));
    const newItems = new Map(fresh.items.map(it => [it.id, it]));
    for (const local of dirty.items) {
      const old = oldItems.get(local.id), next = newItems.get(local.id);
      if (old && next && !sameWorkingItem(old, next)) f.conflictIds.add(local.id);
    }
    if (dirty.remarkChanged && before.remark !== fresh.remark) f.remarkConflict = true;
    reconcileConflictMarkers(f);
    if (f.conflictIds.size || f.remarkConflict) {
      f.lastFlushOk = false;
      if (formVisible(f)) L.notice('这张单已在别处被修改，你的改动仍在，请核对后再保存');
    }
  }
  function scheduleAutosave(f) { if (f.submittedEdit) { updateActionBar(f); return; } clearTimeout(f.timer); f.timer = setTimeout(() => enqueue(f.id, () => performFlush(f)), 1500); }
  // C5a-e（G5=A′必做3）：焦点identity键——只认三种能被这个文件写入working的输入：数字读数框
  // （data-num-id）、检查项说明框（data-note-id）、总体备注框（#itlFormRemark）。不在 #itlContent 里的
  // activeElement（比如工具栏的按钮，或压根没有元素获得焦点）不记录，重绘后也不强行把焦点从别处拉回来。
  function captureFocusKey() {
    const el = document.activeElement;
    if (!el || typeof el.closest !== 'function' || !el.closest('#itlContent')) return null;
    let key = null;
    if (el.dataset && el.dataset.numId) key = { type: 'num', id: el.dataset.numId };
    else if (el.dataset && el.dataset.noteId) key = { type: 'note', id: el.dataset.noteId };
    else if (el.dataset && el.dataset.manualId) key = { type: 'manual', id: el.dataset.manualId, field: el.dataset.manualField };
    // L6（C5c-b，Opus预筛）：展开/收起按钮也算——整表重绘（recollect/冲刷等）发生时，如果用户此刻
    // 焦点正停在这个按钮上，此前不识别会让焦点掉回 body，键盘用户体验上感觉"重绘把焦点抢走了"。
    else if (el.dataset && el.dataset.deviceExpand) key = { type: 'expand', id: el.dataset.deviceExpand };
    else if (el.id === 'itlFormRemark') key = { type: 'remark' };
    else return null;
    key.selStart = (typeof el.selectionStart === 'number') ? el.selectionStart : null;
    key.selEnd = (typeof el.selectionEnd === 'number') ? el.selectionEnd : null;
    return key;
  }
  function restoreFocusKey(key) {
    if (!key) return;
    let el = null;
    if (key.type === 'num') el = document.querySelector('[data-num-id="' + key.id + '"]');
    else if (key.type === 'note') el = document.querySelector('[data-note-id="' + key.id + '"]');
    else if (key.type === 'manual') el = document.querySelector('[data-manual-id="' + key.id + '"][data-manual-field="' + key.field + '"]');
    else if (key.type === 'expand') el = document.querySelector('[data-device-expand="' + key.id + '"]');
    else if (key.type === 'remark') el = $('#itlFormRemark');
    if (!el) return; // 重绘后这个元素不存在了（比如整段被删）——不恢复，不报错
    el.focus();
    if (key.selStart !== null && key.selEnd !== null && typeof el.setSelectionRange === 'function') {
      // number 类型 input 在多数浏览器不支持 setSelectionRange（抛 DOMException），note/remark 是
      // text/textarea 支持；try/catch 兜底，选区恢复失败不影响焦点本身已经恢复。
      try { el.setSelectionRange(key.selStart, key.selEnd); } catch (_e) { /* 该输入类型不支持选区，忽略 */ }
    }
  }
  // C5a-e（G5=A′必做3）：上锁/解锁的就地更新——只切换 readOnly（文本/数字/备注框）与 disabled（开关、
  // 全部正常、采集、提交、删除按钮），不碰 DOM 结构本身，document.activeElement 的节点引用不会变，
  // 焦点与选区天然保留（连 captureFocusKey/restoreFocusKey 都不需要）。!writable（无编辑权限）的控件
  // 恒是 disabled/readonly，不受这里的 locked 状态影响——它们从来就不会被解锁。
  function applyLockState(f) {
    if (!formVisible(f)) return;
    const writable = f.detail.actions.includes('save');
    const locked = isLocked(f);
    if (writable) {
      document.querySelectorAll('#itlContent [data-num-id]').forEach(el => { el.readOnly = locked; });
      document.querySelectorAll('#itlContent [data-note-id]').forEach(el => { el.readOnly = locked; });
      document.querySelectorAll('#itlContent [data-manual-id]').forEach(el => { if (el.tagName === 'SELECT') el.disabled = locked; else el.readOnly = locked; });
      const remarkEl = $('#itlFormRemark');
      if (remarkEl) remarkEl.readOnly = locked;
      document.querySelectorAll('#itlContent [data-seg-ok],#itlContent [data-seg-bad],#itlContent [data-all-normal]').forEach(el => { el.disabled = locked; });
      const delBtn = $('#itlFormDelete');
      if (delBtn) delBtn.disabled = locked;
      document.querySelectorAll('#itlContent [data-photo-upload],#itlContent [data-photo-delete],#itlContent [data-pending-decision]').forEach(el => { el.disabled = locked || el.dataset.photoFull === 'true'; });
    }
    // 采集按钮的可用性本就由 actions.includes('collect') 决定是否渲染（不受 writable 单独控制），锁定
    // 状态与文案（"正在采集…"/常规文案）始终要跟着 f.collecting/isLocked 同步。
    document.querySelectorAll('#itlContent [data-collect-id]').forEach(el => {
      const itemId = Number(el.dataset.collectId);
      el.disabled = locked;
      el.textContent = f.collecting.has(itemId) ? '正在采集…' : '一键采集（选填）';
    });
    updateActionBar(f); // 操作条文字（正在保存…等）与提交按钮 disabled——只替换 #itlFormActionbar 这一个独立节点
  }
  // performFlush 不依据 formVisible(f) 放弃网络请求本身——onLeave/返回列表/删除前的冲刷都要求这次
  // 请求真的发得出去，即使视图已经离开；只有"要不要更新当前可见 DOM"这一步才需要核对 formVisible(f)。
  // 返回 true/false（H2 用它判断"上一轮冲刷是否真的成功"，不满足就不允许提交）。
  // C5a-e（G5=A′必做3，取代 C5a-d"统一整表重渲染"的设计）：上锁/解锁改走 applyLockState 就地更新，不
  // 再整表 renderForm——G5 把"离开冲刷失败保留会话"整个撤掉之后，锁定期间输入框完全可能真的有焦点
  // （用户正在打字触发自动保存），C5a-d 头部注释里"锁定期间输入框本就不可能有焦点"这个前提不再成立。
  // 只有真的需要整段/整表结构变化的场景——冲突合并（conflictCls 类要变、可能新增高亮）、说明集合变化
  // （device 段可能要新出现说明框）——仍然调用 renderForm（现在会保留焦点，见 captureFocusKey）。
  // "发送期间又落进working的新编辑，立即排下一轮冲刷"这条旧分支已删除并说明：在途锁下，performFlush
  // 从置位 f.flushing 到 finally 解锁之间，toggleSeg/onNumberInput/onNoteInput/allNormal/remark 输入
  // 监听器全部在开头 isLocked(f) 挡住（H5 之后渲染层的 readOnly/disabled 也同步挡住），working 不可能
  // 再变化，PUT 响应落地时 computeDirty(f) 只会等于这次刚发出去的那份，不可能"又多出"新脏数据。
  // excludeConflicts（G5=A′必做1，M2）：离开冲刷专用——已经带着冲突标记的项/备注不在这次请求体里
  // 发出去（不用本地值覆盖服务器上已经变化、用户还没来得及核对的值），由 leaveForm 传入。
  async function performFlush(f, opts) {
    const excludeConflicts = !!(opts && opts.excludeConflicts);
    let needsFullRender = false;
    try {
      // C5a-e2（必修2）：这个会话已经给过唯一一条"离开时有修改未能保存"提示——后续排队的冲刷（在途
      // 冲刷失败后紧跟着 leaveForm 自己排的离开冲刷，两者对着同一个已销毁会话、同一张单）不再对它发一次
      // 明知会再次徒劳（版本/内容都没变，必然重复同样的结果）的 PUT，直接放弃。finally 里的
      // __inspFormFlushSettled++ 仍然要跑——调用方（含测试）靠这个计数器同步"这一轮排队的冲刷已经落
      // 定"，跳过网络请求本身不代表跳过这个信号。
      if (f.destroyed && f.leaveFailureNotified) return false;
      // codex 48 H-3：失权结束的会话（含已离开的旧会话）不再发 PUT；未保存原文按失权原因登记并提示一次。
      if (f.accessLost) { if (unsavedPartsFor(f).length) notifyLeaveFlushFailure(f, { status: 403 }); return false; }
      const rawDirty = computeDirty(f);
      // C5a-e2（必修1）：被 excludeConflicts 过滤掉的冲突项/冲突备注不能悄悄消失——在真正过滤之前先把
      // 它们记下来，不管这次冲刷最终走早退（只剩冲突项，没有别的可发）、成功（非冲突项发出去了）还是
      // 失败，都要能报给用户。:808 附近的 conflictIds.clear() 发生在成功分支里，会把"这里原来是冲突项"
      // 这条信息连同标记一起冲掉，所以这里必须在过滤前就单独存好一份，不依赖之后还能从 conflictIds
      // 反查出来。
      const excludedConflictItems = excludeConflicts ? rawDirty.items.filter(it => f.conflictIds.has(it.id)) : [];
      const excludedRemarkConflict = !!(excludeConflicts && f.remarkConflict && rawDirty.remarkChanged);
      const items = excludeConflicts ? rawDirty.items.filter(it => !f.conflictIds.has(it.id)) : rawDirty.items;
      const remarkChanged = (excludeConflicts && f.remarkConflict) ? false : rawDirty.remarkChanged;
      if (!items.length && !remarkChanged) {
        f.lastFlushOk = true;
        // C5a-e2：只剩被排除的冲突项/冲突备注脏——这次冲刷没有非冲突的脏数据可发，不发请求，但排除
        // 掉的内容依然没有被保存，不能因为走了这条早退分支就让它悄悄消失，同样要给常驻提示。
        notifyExcludedConflicts(f, excludedConflictItems, excludedRemarkConflict);
        // S-H5：没有脏数据要发的空冲刷，也顺手检查一次冲突标记是否已经与当前基线一致（比如离开又
        // 回来触发的空冲刷，或者M5：用户把冲突项手动点回服务器值）——不然残留的
        // conflictIds/remarkConflict 会一直卡住提交按钮。这条早退路径本就没有上锁，不需要 applyLockState。
        if (reconcileConflictMarkers(f) && formVisible(f)) renderForm(f);
        return true;
      }
      f.flushing = true;
      if (formVisible(f)) applyLockState(f); // 在途锁：就地 readOnly/disabled + 操作条"正在保存…"，不重绘结构
      const body = { expected_version: f.detail.version };
      if (items.length) body.items = items;
      if (remarkChanged) body.remark = f.remarkWorking;
      try {
        const beforeIssueCount = f.everDeviceIssueIds.size;
        const hadConflictBefore = f.conflictIds.size > 0 || f.remarkConflict;
        const beforeActions = f.detail.actions; // L7（C5a-f）：保存前的动作快照，成功后比较有没有变化
        if (f.token !== getToken()) { rejectChangedIdentity(f, '保存'); return false; }
        const resp = await sessionApi(f, '/inspections/sheets/' + f.id, { method: 'PUT', body: JSON.stringify(body) });
        f.detail = resp; trackDeviceIssueIds(f);
        f.conflictIds.clear(); f.remarkConflict = false; f.savedAt = L.state.serverTime || Date.now(); f.lastFlushOk = true;
        // W1 M4：仅给这次确实保存成功的项标新值；旧原文仍等用户确认。
        reconcileUnsavedAfterSave(f, items, remarkChanged);
        // 说明集合（everDeviceIssueIds）因这次成功保存而新增了成员——device 段可能要新出现一个说明框，
        // 这个变化涉及 DOM 结构（notesHtml 的可见项集合变了），就地更新覆盖不到，需要整表重绘一次。
        if (f.everDeviceIssueIds.size !== beforeIssueCount) needsFullRender = true;
        // 这次成功保存之前就带着冲突高亮（itl-sheet-conflict 类）——高亮是渲染时烘进 HTML 的 CSS 类，
        // 不是 applyLockState 能就地摘掉的属性，清掉 conflictIds 必须配一次整表重绘才能真的让高亮消失。
        if (hadConflictBefore) needsFullRender = true;
        // L7（C5a-f）：保存响应带回的 actions 若与保存前不同（例如写权限被降级/恢复），applyLockState
        // 的就地更新只切换 readOnly/disabled，不会重新决定"要不要渲染删除按钮/全部正常按钮/无编辑权限
        // 提示条"这些结构性差异——整表重绘一次，renderForm 会按新的 writable 自动画出正确的结构（含
        // 失去 save 时那句"你当前没有编辑这张草稿的权限，以下内容只读。"提示条，不需要另写一条）。
        if (resp.actions.length !== beforeActions.length || beforeActions.some(a => !resp.actions.includes(a))) needsFullRender = true;
        // C5a-e2：非冲突项这次真的保存成功了，但被排除的冲突项/冲突备注依然没有——用过滤前记下的清单
        // （此刻 conflictIds 已经被上面清空，不能再从它反查），同样给一条常驻提示。
        notifyExcludedConflicts(f, excludedConflictItems, excludedRemarkConflict);
        return true;
      } catch (error) {
        f.lastFlushOk = false;
        if (error.status === 401 && f.token !== getToken()) {
          notifyLeaveFlushFailure(f, error);
        } else if (f.destroyed) {
          // C5a-e（G5=A′必做1）：会话已经结束（这次冲刷本来就是离开时排的"离开冲刷"，或者是在途冲刷
          // 还没来得及落地用户就已经离开）——不再走 handleConflict（不重取GET、不重发，这张单此刻已经
          // 没有可见表单可以合并结果），改成一条常驻提示，列出没保存上的内容，指引用户重新打开该单。
          notifyLeaveFlushFailure(f, error);
        } else if (error.code === 'SHEET_VERSION_CONFLICT') {
          await handleConflict(f);
          needsFullRender = true; // 冲突合并可能改变多处高亮/说明框，统一整表重绘
        } else if (formVisible(f)) {
          L.notice('巡检单保存失败：' + mapFailureReason(error));
        } else {
          // 理论上不可达——G5 之后 f.left 恒与 f.destroyed 同步（见 leaveForm），"未销毁但不可见"这个
          // 状态已经不存在，保留这条分支只是防御性兜底。L3（C5a-f）：文案同步改走 notifyOutcome、去掉
          // "有修改未保存："前缀，与本文件其余"会话已结束"分支保持一致措辞。N-M3（C5a-g）：短语走
          // mapFailureReason，不再拼 error.message 整句。
          notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉保存失败：' + mapFailureReason(error));
        }
        return false;
      }
    } finally {
      if (f.flushing) {
        f.flushing = false;
        if (formVisible(f)) { if (needsFullRender && !f.photoBusy) renderForm(f); else applyLockState(f); } // 照片整段在途时保持原节点
      }
      L.__inspFormFlushSettled++;
    }
  }
  // C5a-e（G5=A′必做1）：离开冲刷失败时给的常驻提示——列出没保存上的每一项当前内容（用渲染层已经在用
  // 的 item_label/target_label，不显示内部 id），指引用户重新打开该单补填。
  function describeWorkingValue(f, it) {
    const w = f.working.get(it.id) || {};
    let text;
    if (it.value_kind === 'number') text = (w.number_value === null || w.number_value === undefined) ? '（未填）' : String(w.number_value);
    else text = w.result === 'ok' ? '正常' : w.result === 'bad' ? '异常' : '（未填）';
    if (w.note) text += '；说明：' + w.note;
    if (normalizeManual(w.manual_observation)) text += '；人工观察：' + describeManual(w.manual_observation);
    return text;
  }
  // M3（C5a-f）→ N-M3（C5a-g 泛化）：失败原因按 error.code/status 映射成短语——不透传共享层网络错误
  // message（例如 NETWORK 那句"网络异常，未能确认操作结果。请重新打开页面核对后再决定是否重试。"，
  // 其中"请重新打开页面"这类诱导刷新的表述与 L1/L2 之后的入口设计矛盾，预筛 Q5 实测：会话已结束的
  // 采集失败提示原样透出了这句话，与登记表/常驻条"原文在常驻条里、不用刷新页面"的设计自相矛盾）。
  // N-M3：不再只服务"离开失败"一种场景——performFlush/performCollect/performSubmit 所有"会话已结束"
  // 的 notifyOutcome 调用点、以及它们各自可见分支的失败提示，全部经这一个函数取短语，不再各自拼接
  // error.message 整句。SHEET_VERSION_CONFLICT 恒是 409（inspection-sheets.js:versionConflict），按
  // W1 M5：先按业务 code 映射，再按 status 兜底；采集 SHEET_STATE 保留服务端具体原因。
  // Claude 复核 49 M-3：请求发出前被 sessionApi 拦下（确定未发出）、服务端真 401（确定被拒）都不是「结果未能确认」；
  // 只有响应阶段换号（共享层 IDENTITY_CHANGED_IN_FLIGHT，无映射、按 status 401 兜底）才说未能确认。
  const FAILURE_REASON_BY_CODE = { SESSION_IDENTITY_CHANGED: '登录状态已变化', AUTH_REJECTED: '登录已失效', LEDGER_BUSY: '台账正忙', LEDGER_UNAVAILABLE: '台账暂不可用', SHEET_NOT_FOUND: '这张单已不存在', SHEET_VERSION_CONFLICT: '与他人修改冲突', INSPECTION_BUSY: '该设备正在采集', SHEET_COLLECT_CONFLICT: '采集期间设备已变化' };
  function mapFailureReason(error, operation) {
    if (!error) return '操作失败';
    if (error.code === 'SHEET_PHOTO_LIMIT') return error.message || '每个附件位置最多10张图片';
    if (error.code === 'NETWORK') return '网络异常';
    // Claude 复核 M2：照片被服务端内容/格式校验拒绝（400）时给出服务端原因，不笼统写「操作失败」。
    if (operation === 'photo' && error.status === 400 && error.message) return error.message;
    if (error.code === 'SHEET_STATE') return operation === 'collect' ? (error.message || '当前状态不允许该操作') : '当前状态不允许该操作';
    if (error.code && FAILURE_REASON_BY_CODE[error.code]) return FAILURE_REASON_BY_CODE[error.code];
    if (error.status === 401) return '登录状态已变化，结果未能确认';
    if (error.status === 409) return '与他人修改冲突';
    if (error.status === 403) return '编辑权限已变化';
    return '操作失败';
  }
  function unsavedPartsFor(f) {
    const dirty = computeDirty(f);
    const parts = dirty.items.map(dirtyIt => {
      const it = itemById(f, dirtyIt.id) || dirtyIt;
      const label = it.section === 'room' ? it.item_label : (it.target_label + ' · ' + it.item_label);
      const conflictSuffix = f.conflictIds.has(it.id) ? '（与他人修改冲突，未保存）' : '';
      return { key: 'item:' + it.id, text: label + '：' + describeWorkingValue(f, it) + conflictSuffix };
    });
    if (dirty.remarkChanged) parts.push({ key: 'remark', text: '备注：' + (f.remarkWorking || '（空）') + (f.remarkConflict ? '（与他人修改冲突，未保存）' : '') });
    return parts;
  }
  // codex 48-R H1（用户 09-27 全按）：表单会话内的一切请求统一经此——会话已因失权结束或身份已变，就不发请求。
  // 各任务里既有的显式检查负责登记与措辞；这里是结构性兜底，逐 await 手工补检查点已连续三轮漏点。
  // 静态守卫（verify-it-ledger-inspection-photo-browser.js「会话函数不直接调 L.api」）锁定会话函数不绕开它。
  function sessionApi(f, path, options) {
    if (f.accessLost) return Promise.reject(Object.assign(new Error('访问权限已变化'), { status: 403, code: 'SESSION_ACCESS_LOST' }));
    if (f.token !== getToken()) return Promise.reject(Object.assign(new Error('登录状态已变化。'), { status: 401, code: 'SESSION_IDENTITY_CHANGED' }));
    return L.api(path, options);
  }
  function rejectChangedIdentity(f, action, uncertain = false) {
    const parts = unsavedPartsFor(f);
    if (!parts.length) parts.push({ key: 'action:' + action, text: action + '请求未发出' });
    registerUnsaved(f.id, sheetLabel(f), parts, uncertain ? '登录状态已变化，结果未能确认' : '登录状态已变化', f.accountId);
    f.lastFlushOk = false;
    return false;
  }
  function unsavedBannerReachable(f) {
    if (!L.state.level || L.state.tab !== 'inspections' || $('#itlTabs')?.hidden || currentAccountId() !== f.accountId) return false;
    return !!document.querySelector('#itlUnsavedList [data-unsaved-sheet="' + f.id + '"], #itlUnsavedForm [data-unsaved-sheet="' + f.id + '"]');
  }
  function notifyUnsavedResult(f, parts, reason) {
    registerUnsaved(f.id, sheetLabel(f), parts, reason, f.accountId);
    if (f.token !== getToken()) return; // an old account must not notify the current account
    if (unsavedBannerReachable(f)) L.notice('巡检单〈' + sheetLabel(f) + '〉有内容未能保存，详见巡检台账顶部。');
    else L.notice((reason === '编辑权限已变化' ? '访问权限已变化。' : '') + '巡检单〈' + sheetLabel(f) + '〉有内容未能保存：' + parts.map(p => p.text + '（原因：' + reason + '）').join('；'));
  }
  // 外审 H-1/H-2/M-3：失权结束会话时，登记表是原文唯一载体，而页签已隐藏、常驻条不可达，一刷新就丢。
  // 共享层在 clearData（→onAccessLost）之后同步写「访问权限已变化，请重新打开页面」，在途请求的 catch
  // 随后在微任务里补登记（如照片未上传）——所以放到下一个宏任务，按登记表条目给一次性全文提示。
  // 不按「哪条请求失败」分路径：草稿自动保存、已提交单保存、照片、提交/采集链都走这一处。
  function notifyAccessLostOnce(f) {
    if (f.token !== getToken()) return; // 期间又换了号：不向新账号提示旧账号原文
    const entry = unsavedByAccountSheet.get(unsavedKey(f.accountId, f.id));
    if (!entry || !entry.parts.length) return;
    L.notice('访问权限已变化。巡检单〈' + entry.label + '〉有内容未能保存：' + entry.parts.map(p => p.text + '（原因：' + p.reason + '）').join('；'));
  }
  // 同一会话只提示一次（f.leaveFailureNotified 去重）——"在途冲刷失败 + 离开冲刷再失败"是同一次离开
  // 动作引出的两次 performFlush 调用（前者是离开前已经排上的旧任务，后者是 leaveForm 自己新排的"离开
  // 冲刷"），对用户来说是同一件事，不需要看两条几乎相同的提示。
  function notifyLeaveFlushFailure(f, error) {
    if (f.leaveFailureNotified) return;
    f.leaveFailureNotified = true;
    // computeDirty 返回的 items 只是 {id,result,number_value,note} 这份请求体形状，没有 item_label/
    // target_label/section——渲染要用的字段回到 f.detail.items（itemById）里找。
    const parts = unsavedPartsFor(f);
    const reason = mapFailureReason(error);
    // 先登记到会话所属账号；常驻条当下可达才发指向它的短提醒，否则即时提醒保留全文。
    notifyUnsavedResult(f, parts, reason);
  }
  // C5a-e2（必修1）：performFlush 的 excludeConflicts 过滤把带冲突标记的项/备注从这次请求体里挡下来
  // （不用本地值覆盖对方还没被核对过的修改，见 leaveForm 头部注释），但挡下来≠已保存——这条排除掉的
  // 内容本身还是没落库，不管这次冲刷走的是"只剩它们、不发请求"的早退，还是"其余脏项已经发出去且成功"，
  // 都要给一条常驻提示。同一会话只提示一次，复用 f.leaveFailureNotified 去重（不区分是这里触发的还是
  // notifyLeaveFlushFailure 触发的，对用户来说都是"这个会话有东西没保存"，只需要看一条）。
  function notifyExcludedConflicts(f, excludedItems, excludedRemarkConflict) {
    if (f.leaveFailureNotified) return;
    if (!excludedItems.length && !excludedRemarkConflict) return;
    const parts = excludedItems.map(dirtyIt => {
      const it = itemById(f, dirtyIt.id) || dirtyIt;
      const label = it.section === 'room' ? it.item_label : (it.target_label + ' · ' + it.item_label);
      return { key: 'item:' + it.id, text: label + '：' + describeWorkingValue(f, it) };
    });
    if (excludedRemarkConflict) parts.push({ key: 'remark', text: '备注：' + (f.remarkWorking || '（空）') });
    f.leaveFailureNotified = true;
    // H1+H2（C5a-f）：同 notifyLeaveFlushFailure——先写登记表再发即时提醒；这里的 reason 恒是"与他人
    // 修改冲突"（被排除的项本来就是因为冲突才被排除的，不需要再走 mapFailureReason）。N-H1：按 f.token
    // 归属。MED-3：parts 现在是结构化 {key,text}，reason 由 registerUnsaved 统一打在每个 part 上。
    notifyUnsavedResult(f, parts, '与他人修改冲突');
  }
  // 版本冲突（方案 §6，H3 修复，C5a-d 简化）：脏集合与 remark 是否变更只需在应用 fresh 前算一次
  // （S-H3，43S H3）——旧版要分"发起时"与"应用时"两次计算是为了防"GET 挂起期间的新编辑"，在途锁下
  // performFlush 从置位 f.flushing 起就已经锁死输入，这次 GET 飞行期间不可能再有新编辑插进来，两次
  // 计算的结果必然相同，不需要分两次。合并统一走 applyFreshMerge（S-H4 与 performCollect 共用）。
  // clearTimeout(f.timer) 仍保留：在途锁下这一般是个 no-op（触发这次冲刷的计时器早已消费掉，锁定期间
  // 也不可能有新计时器被排上），但作为纵深防御成本很低，不删。
  async function handleConflict(f) {
    clearTimeout(f.timer);
    f.lastFlushOk = false;
    // LOW（G5=A′）：重新GET也失败时，lastFlushOk 会一直卡在 false（没有冲突集合可以靠编辑清掉），
    // 提交按钮因此永久 disabled——简单处理：notice 里补一句引导重新打开该单（重开走全新GET，不会再卡
    // 在这次失败的重取上），不做更复杂的自动重试。
    let regetFailed = false;
    try {
      if (f.accessLost) return; // codex 48 H-2
      if (f.token !== getToken()) { rejectChangedIdentity(f, '冲突重取'); return; }
      const fresh = await sessionApi(f, '/inspections/sheets/' + f.id);
      const dirty = applyFreshMerge(f, fresh);
      dirty.items.forEach(it => f.conflictIds.add(it.id));
      if (dirty.remarkChanged) f.remarkConflict = true;
      reconcileConflictMarkers(f); // S-H5：合并后本地恰好与 fresh 一致的项/备注，立即清掉冲突标记
      // S-H5：合并之后如果已经没有任何冲突标记残留（数据已经完全一致），这次"冲突"其实已经被
      // reconcile 掉了，不该继续用 lastFlushOk=false 卡住提交——语义上等价于"这次没有真正需要保存的
      // 脏数据"，与 performFlush 空冲刷早退路径的 lastFlushOk=true 是同一件事，不然 reconcile 只清了
      // 高亮，H2 的提交前置守卫仍会因为 lastFlushOk 卡住。
      if (!f.conflictIds.size && !f.remarkConflict) f.lastFlushOk = true;
    } catch (_e) { regetFailed = true; /* 保留本地working/remarkWorking原样，下次编辑触发保存仍会用旧version重试 */ }
    // M1（C5a-f，改正旧"理论上不可达"注释）：handleConflict 被调用时会话确实还没被销毁（performFlush/
    // performSubmit 的 catch 都先判 f.destroyed 才决定要不要走到这里），但这次重取 GET 本身是异步的——
    // 飞行期间用户完全可能已经触发 leaveForm 结束了这个会话（leaveForm 不等任何在途请求，同步结束）。
    // 这里 GET 落地后重新判一次 f.destroyed：会话已经结束就不再出任何提示，交给随后排队的"离开冲刷"
    // （它撞见 f.destroyed 会走 notifyLeaveFlushFailure/notifyExcludedConflicts 的统一常驻提示），不
    // 在这里重复给一条——旧版的 else 分支正是因为没做这个判断，才会在"GET 在途时离开"这条真实可达的
    // 路径上（预筛 P3 实测）产出与随后离开冲刷几乎重复的第二条提示。
    if (f.destroyed) return;
    L.notice('这张单已在别处被修改，你的改动仍在，请核对后再保存' + (regetFailed ? '（提交按钮若持续不可点，请返回列表重新打开该单）' : ''));
    // 不在这里 renderForm——调用方 performFlush 的 finally 统一解锁（并按 needsFullRender 决定就地更新
    // 还是整表重绘）；performSubmit 的 finally 也会在自己落定时按 formVisible(f) 重渲染一次。
  }

  // ---- 分段渲染（room / rack / device），items 按后端建单顺序天然已分组分项，不需要额外排序 ----
  // 版本冲突（方案 §6）：conflictIds 里的项要"高亮"——加一个专用修饰类，CSS 见 it-ledger.css
  // .itl-sheet-conflict；handleConflict 成功重新保存后 conflictIds 会被清空，下次渲染自然去掉高亮。
  // C5a-d（G4=A）：dis 现在同时核 writable（有没有编辑权限）与 !isLocked(f)（有没有在途操作）——两者
  // 任一为否都 disabled。全文件里凡是"按 writable 算 dis"的地方都改成这个组合，不再单独判 writable。
  function segHtml(f, it, writable = true) {
    const w = f.working.get(it.id) || { result: null };
    const conflictCls = f.conflictIds.has(it.id) ? ' itl-sheet-conflict' : '';
    const dis = (writable && !isLocked(f)) ? '' : ' disabled';
    return `<span class="itl-sheet-seg${conflictCls}" data-item-id="${it.id}"><button type="button" class="${w.result === 'ok' ? 'on-ok' : ''}" data-seg-ok="${it.id}"${dis}>正常</button><button type="button" class="${w.result === 'bad' ? 'on-bad' : ''}" data-seg-bad="${it.id}"${dis}>异常</button></span>`;
  }
  function sectionProgress(f, key) {
    const items = f.detail.items.filter(it => it.section === key);
    let filled = 0, bad = 0;
    for (const it of items) {
      const w = f.working.get(it.id) || it;
      if (it.value_kind === 'check') { if (w.result === 'ok' || w.result === 'bad') filled++; if (w.result === 'bad') bad++; }
      else if (Number.isFinite(w.number_value)) filled++;
    }
    return { filled, total: items.length, bad };
  }
  function progressLineHtml(p) { return `已填 ${esc(p.filled)} / ${esc(p.total)}${p.bad ? ` · <b>异常 ${esc(p.bad)}</b>` : ''}`; }
  function roomSectionHtml(f, writable = true) {
    const numbers = f.detail.items.filter(it => it.section === 'room' && it.value_kind === 'number');
    const checks = f.detail.items.filter(it => it.section === 'room' && it.value_kind === 'check');
    // C5a-e H5：数字读数框锁定时用 readonly（保留焦点与光标），不再用 disabled——disabled 元素直接
    // 丢焦点，readonly 元素挡键盘编辑但不丢焦点。没有编辑权限（!writable）时恒 disabled，不受锁定
    // 状态影响（applyLockState 就地解锁时也只会碰 writable 为真的这一支，见其头部注释）。
    const numAttrs = !writable ? ' disabled' : (isLocked(f) ? ' readonly' : '');
    const numRows = numbers.map(it => {
      const w = f.working.get(it.id) || {};
      const range = NUMBER_RANGE[it.item_key];
      const soft = SOFT_RANGE[it.item_key];
      const conflictCls = f.conflictIds.has(it.id) ? ' itl-sheet-conflict' : '';
      // C5a-c §3.1第2条：打开/重渲染这一刻就按working里的当前值算一次软提示——不等用户再碰一次输入框
      // 才出现（onNumberInput 只在'input'事件里维护同一个data-num-soft节点的文案，两处判据必须一致）。
      const softWarn = soft && Number.isFinite(w.number_value) && (w.number_value < soft[0] || w.number_value > soft[1]);
      return `<div class="itl-sheet-row${conflictCls}" data-item-id="${it.id}"><span class="itl-sheet-label">${esc(it.item_label)}</span><span class="itl-sheet-num"><input type="number" aria-label="${esc(it.item_label)}" data-num-id="${it.id}" value="${w.number_value === null || w.number_value === undefined ? '' : esc(w.number_value)}"${numAttrs}>${it.item_key === 'temperature' ? '℃' : '%'}${range ? `<small class="itl-muted">范围 ${range[0]}~${range[1]}</small>` : ''}<span class="itl-sheet-num-error" data-num-error="${it.id}"></span><span class="itl-sheet-num-soft itl-muted" data-num-soft="${it.id}">${softWarn ? '超出参考范围' : ''}</span></span></div>`;
    }).join('');
    const checkRows = checks.map(it => `<div class="itl-sheet-room-item"><div class="itl-sheet-row" data-item-id="${it.id}"><span class="itl-sheet-label">${esc(it.item_label)}</span>${segHtml(f, it, writable)}</div>${notesHtml(f, 'room', writable, it.id)}</div>`).join('');
    return numRows + checkRows;
  }
  function rackSectionHtml(f, writable = true) {
    const racks = f.detail.scope.racks || [];
    if (!racks.length) return '<p class="itl-muted">本机房没有机柜。</p>';
    const cols = f.detail.items.filter(it => it.section === 'rack' && it.target_id === racks[0].id);
    const rows = racks.map(r => {
      const cells = cols.map(c => {
        const it = f.detail.items.find(x => x.section === 'rack' && x.target_id === r.id && x.item_key === c.item_key);
        return `<td data-item-id="${it ? it.id : ''}">${it ? segHtml(f, it, writable) : ''}</td>`;
      }).join('');
      return `<tr data-sheet-rack="${r.id}"><td><strong>${esc(r.name)}</strong><small>${esc(r.u_total)}U</small></td>${cells}<td>${rackPhotoHtml(f, r, writable)}</td></tr>`;
    }).join('');
    return `<div class="u-corr-table-wrap"><table class="u-corr-table itl-sheet-matrix"><thead><tr><th>机柜</th>${cols.map(c => `<th>${esc(c.item_label)}</th>`).join('')}<th>机柜正面照</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // ============================================================
  // C5c（方案v0.6 §6「设备采集明细展开」条）：设备段每台已关联采集记录（device_inspection_id 非空）
  // 的设备可展开/收起一块采集明细——整机/物理硬盘/Windows卷空间三块，展示内容取自 C7 删掉的
  // it-ledger-inspections.js（`git show eefca109:.../it-ledger-inspections.js` 第18行 detail()
  // 函数），改成本文件的表格写法；背板/RAID虚拟磁盘不显示（方案原文"不必显示"），内存条逐根健康
  // 采集不到、不显示任何"内存健康"字样（方案原文）。数据来自 GET /inspections/:id（C7 保留的只读
  // 详情接口，可见性由服务端按巡检单判定），按 device_inspection_id 缓存——该行重新采集后
  // device_inspection_id 变化，缓存自然失效，不用显式清理。
  //
  // 焦点与重绘：展开/收起点击、后台请求落地都只直接更新这一台设备自己的展开区 DOM（paintDeviceDetail
  // querySelector 精确定位，不整表 outerHTML 替换），不会打断同一时刻用户正在编辑的其它输入框（方案
  // "也不抢输入焦点"）。真正需要整表重绘时（外部原因：冲刷落定/冲突合并/采集重取/在途锁解锁），
  // deviceSectionHtml 的字符串构造会读 f.expandedItemIds/f.deviceDetailCache 现算展开状态与已有内容，
  // 如实画出来（方案"重绘不丢展开状态"）——不是本模块主动触发重绘，是"如果别的原因触发了重绘，展开
  // 状态不会被冲掉"。
  //
  // 默认展开：方案"快照有告警的设备默认展开"要求在拿到快照之前就知道有没有告警，因此本实现选择对
  // 每台已关联采集记录的设备都在渲染时后台预取一次详情（ensureDeviceDetail 内部按 device_inspection_id
  // 缓存，重复调用不重复发请求）——不是纯粹"点击才请求"，是"渲染即预取，用户点击时大概率已经有缓存"，
  // 这是方案"默认展开"这条要求下无法回避的取舍（已在交付说明⑤记录为拿不准的点）。用户手动点过的行
  // （deviceExpandTouched）后续预取结果不再覆盖其展开状态。
  // Binary units labelled GB/TB, the way Windows shows them; trailing zeros dropped ("100GB", "1.82TB").
  const AMOUNT_UNITS = n => !Number.isFinite(n) ? '未取得' : n >= 1099511627776 ? Number((n / 1099511627776).toFixed(2)) + 'TB' : Number((n / 1073741824).toFixed(2)) + 'GB';
  function deviceDetailTableHtml(head, rows) {
    return `<div class="itl-inspection-table"><table class="u-corr-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">未取得此项信息</td></tr>`}</tbody></table></div>`;
  }
  // M1（C5c-b，Opus预筛+主会话裁定）：方案§6原句"异常标红、与采集器一致"——此前只把物理硬盘state===
  // 'Failed'标红，比采集器（routes/it-ledger/inspection-collector.js:23-25 normalize()的alerts判据）
  // 窄。裁定按(a)(b)一起做，是契约内的实现口径，不改方案：
  // (a) 展开区顶部渲染snapshot.alerts（逐条esc；critical标红，与旧版it-ledger-inspections.js（C7删，
  //     git show eefca109:...it-ledger-inspections.js 第18行 detail()）的写法一致：<p>逐条+critical
  //     才加红class，attention级不额外上色，class为空串时CSS没有选择器命中，天然不着色）与
  //     component_errors（在既有"采集不完整"提示下逐条列出，不单独另起一段）。
  // (b) 物理硬盘"设备状态"列的标红/标橙判据与采集器同构（inspection-collector.js:23-25）：
  //     state不在{Online,Ready}或failure_predicted为真→标红（与采集器"state!=='Online'&&
  //     state!=='Ready'"/"failure_predicted"两条critical alert同构）；在线（Online/Ready）但
  //     status!=='Ok'→标橙（与采集器disk_warning同构，前端不区分采集器内部Critical/attention两档
  //     severity，统一标橙，按主会话裁定的措辞"在线但status≠Ok时标橙"执行）。"预测故障"列独立按
  //     failure_predicted是否为真标红，不受这条改动影响。
  function deviceDetailBodyHtml(s) {
    const incomplete = s.collection_status === 'partial' || s.collection_status === 'failed';
    const errors = s.component_errors || [];
    const incompleteBlock = incomplete ? `<p class="itl-form-error">采集不完整，以下数据可能缺项。${errors.map(e => '<br>' + esc(e)).join('')}</p>` : '';
    const alerts = s.alerts || [];
    const alertsBlock = alerts.length ? `<h4>告警 · ${alerts.length} 条</h4>${alerts.map(a => `<p class="${a.severity === 'critical' ? 'itl-inspection-critical' : ''}">${esc(a.message)}</p>`).join('')}` : '';
    const srv = s.server;
    // L4：cores/threads 虽然来自 collector normalize() 的 Number(...)||0（恒为数字，理论上不可能带
    // XSS payload），但本文件其余取值一律经 esc()，这两个是仅剩的两处例外——补齐，不留"因为它是数字
    // 所以不用转义"这种要读实现细节才能确认安全的隐式假设。
    const serverBlock = srv
      ? `<dl class="itl-kv"><dt>型号 / SN</dt><dd>${esc(srv.model)} / ${esc(srv.serial_number)}</dd><dt>操作系统</dt><dd>${esc(srv.os)}</dd><dt>CPU</dt><dd>${(srv.cpus || []).map(c => `${esc(c.name)}（${esc(c.cores)}核/${esc(c.threads)}线程）`).join('<br>')}</dd><dt>系统识别内存</dt><dd>${AMOUNT_UNITS(srv.memory_bytes)}</dd></dl>`
      : '<p class="itl-muted">未取得整机信息。</p>';
    const disks = s.physical_disks || [];
    const diskRows = disks.map(d => {
      const stateOk = d.state === 'Online' || d.state === 'Ready';
      // C7-d（C5c-b拿不准⑤第3条，主会话改判为与采集器逐档一致，inspection-collector.js:23-25）：
      // status==='Critical' 时采集器自己也判 critical（disk_warning 分支的 severity 三元式），不再
      // 统一并入橙色；其余非 Ok 值（如 'Degraded'）仍按 disk_warning 的 attention 档标橙。
      const stateCls = (!stateOk || d.failure_predicted || d.status === 'Critical') ? 'itl-inspection-critical' : (d.status !== 'Ok' ? 'itl-inspection-warning' : '');
      return `<tr><td>${esc(d.controller_id)} / ${esc(d.source_id)}</td><td>${esc(d.model)}<br>${esc(d.serial_number)}</td><td>${AMOUNT_UNITS(d.capacity_bytes)} / ${esc(d.protocol)}</td><td class="${stateCls}">${esc(d.state)} · ${esc(d.status)}</td><td class="${d.failure_predicted ? 'itl-inspection-critical' : ''}">${d.failure_predicted ? '是' : '否'}</td></tr>`;
    }).join('');
    const vols = s.volumes || [];
    // L5：free_percent 非有限数（缺失/NaN）时显示"—"且不标色——此前 Number(undefined)<10 恰好是
    // false（不误标橙），但 esc(v.free_percent)+'%' 会直接渲染出"undefined%"/"NaN%"。
    // The bar fills with used space (as Windows does); text and the <10% warning stay on the free share.
    const volRows = vols.map(v => {
      const pct = Number.isFinite(v.free_percent) ? v.free_percent : null;
      const low = pct !== null && pct < 10;
      const bar = pct !== null ? `<progress class="itl-insp-progress itl-disk-bar${low ? ' is-low' : ''}" max="100" value="${esc(Math.min(100, Math.max(0, 100 - pct)))}" aria-label="已用 ${esc(Number((100 - pct).toFixed(2)))}%"></progress>` : '';
      return `<tr><td>${esc(v.name)}</td><td>${esc(v.filesystem)}</td><td>${AMOUNT_UNITS(v.size_bytes)}/${AMOUNT_UNITS(v.free_bytes)}</td><td class="${low ? 'itl-inspection-warning' : ''}">${bar}${pct !== null ? '可用 ' + esc(pct) + '%' : '—'}</td></tr>`;
    }).join('');
    return `${incompleteBlock}${alertsBlock}<h4>整机</h4>${serverBlock}<h4>物理硬盘 · ${disks.length} 块</h4>${deviceDetailTableHtml(['控制器 / 源盘ID', '型号 / SN', '容量 / 接口', '设备状态', '预测故障'], diskRows)}<h4>Windows 卷空间</h4>${deviceDetailTableHtml(['卷', '文件系统', '总容量 / 可用', '空间使用'], volRows)}`;
  }
  // 缓存未命中才发请求；status==='loading' 期间重入不重复发。落地时：404 → 固定文案"无权查看或记录不
  // 存在"；其它失败 → mapFailureReason（不写"重新打开页面"，登记表场景才需要那种措辞）；成功且用户
  // 未手动切换过这一行 → 按告警是否非空决定默认展开/收起。落地前核对 formVisible(f)（会话已离开/
  // 销毁则不碰DOM）且这个 item 此刻仍指向发起请求时的同一条 device_inspection_id（重新采集会让它
  // 变化，此时旧请求结果不再对应当前展开的这一行，静默丢弃，不误画到新记录的展开区里）。
  function ensureDeviceDetail(f, it) {
    const recId = it.device_inspection_id;
    if (!recId) return null;
    let entry = f.deviceDetailCache.get(recId);
    if (entry) return entry;
    entry = { status: 'loading' };
    f.deviceDetailCache.set(recId, entry);
    L.api('/inspections/' + recId).then(data => {
      if (f.deviceDetailCache.get(recId) !== entry) { L.__inspLoadSettled++; return; }
      entry.status = 'ok'; entry.data = data;
      const fresh = itemById(f, it.id);
      // L2（C5c-b，Opus预筛）：默认展开的判定挪进这个分支——此前在分支外无条件执行，如果这条GET落地
      // 时这一行已经被重新采集（fresh.device_inspection_id!==recId，这份数据其实是旧记录的），旧写法
      // 仍会用这份过期快照的alerts覆写f.expandedItemIds，即使下面的paintDeviceDetail被跳过；用户下次
      // 因为别的原因触发整表重绘时，这个被过期数据错误覆写的展开状态会被悄悄画出来。
      if (formVisible(f) && fresh && fresh.device_inspection_id === recId) {
        if (!f.deviceExpandTouched.has(it.id)) {
          const alerts = data.snapshot && Array.isArray(data.snapshot.alerts) ? data.snapshot.alerts : [];
          if (alerts.length) f.expandedItemIds.add(it.id); else f.expandedItemIds.delete(it.id);
        }
        paintDeviceDetail(f, fresh);
      }
      // M2（C5c-b，Opus预筛）：与本文件其它异步落地分支同一个可观测信号（同 __inspLoadSettled 的
      // 先例，本节头部注释）——不管上面的 formVisible 分支走没走，这个 .then() 回调本身"已经处理完"
      // 这件事本身是可观测的，供浏览器测试用有界等待代替 sleep 断言"旧会话的迟到回调没有覆盖新会话"。
      L.__inspLoadSettled++;
    }).catch(error => {
      if (f.deviceDetailCache.get(recId) !== entry) { L.__inspLoadSettled++; return; }
      entry.status = 'error';
      // L3（C5c-b，Opus预筛）：记下是不是404——toggleDeviceDetail 点击展开时，404 保留缓存文案（记录
      // 确实查不到/无权限，重试没有意义），非404（网络异常等，可能是暂时性的）删缓存重新请求。
      entry.notFound = !!(error && error.status === 404);
      entry.message = entry.notFound ? '无权查看或记录不存在' : mapFailureReason(error);
      const fresh = itemById(f, it.id);
      if (formVisible(f) && fresh && fresh.device_inspection_id === recId) paintDeviceDetail(f, fresh);
      L.__inspLoadSettled++;
    });
    return entry;
  }
  function deviceDetailSlotBodyHtml(f, it) {
    const entry = ensureDeviceDetail(f, it);
    if (!entry || entry.status === 'loading') return '<p class="itl-muted">正在读取…</p>';
    if (entry.status === 'error') return `<p class="itl-form-error">${esc(entry.message)}</p>`;
    return deviceDetailBodyHtml(entry.data.snapshot);
  }
  // 只更新这一台设备自己的展开区DOM（querySelector 精确定位），不整表重绘——见本节头部注释"焦点与
  // 重绘"。
  function paintDeviceDetail(f, it) {
    const slot = document.querySelector(`[data-device-detail="${it.id}"]`);
    const btn = document.querySelector(`[data-device-expand="${it.id}"]`);
    if (!slot) return;
    const expanded = f.expandedItemIds.has(it.id);
    slot.hidden = !expanded;
    if (btn) btn.textContent = expanded ? '收起' : '展开明细';
    if (expanded) slot.innerHTML = deviceDetailSlotBodyHtml(f, it);
  }
  function toggleDeviceDetail(f, itemId) {
    const it = itemById(f, itemId);
    if (!it) return;
    // 方案原文"展开按钮只是本地UI，不受在途锁影响，不进写队列"——不查 isLocked(f)。
    f.deviceExpandTouched.add(itemId);
    const expanding = !f.expandedItemIds.has(itemId);
    // L3（C5c-b，Opus预筛）：正要展开、且缓存是非404失败态时删缓存——见 ensureDeviceDetail 里
    // entry.notFound 的设置处。删缓存后 paintDeviceDetail→deviceDetailSlotBodyHtml→ensureDeviceDetail
    // 会因为缓存未命中重新发起请求，等价于把"再点一次展开"当成自然的重试动作，不需要专门的重试按钮。
    if (expanding && it.device_inspection_id) {
      const entry = f.deviceDetailCache.get(it.device_inspection_id);
      if (entry && entry.status === 'error' && !entry.notFound) f.deviceDetailCache.delete(it.device_inspection_id);
    }
    if (f.expandedItemIds.has(itemId)) f.expandedItemIds.delete(itemId); else f.expandedItemIds.add(itemId);
    paintDeviceDetail(f, it);
  }
  function deviceExpandHtml(f, it) {
    if (!it.device_inspection_id) return '';
    ensureDeviceDetail(f, it); // 渲染即预取（见本节头部注释"默认展开"），不管当前是否展开都要触发
    const expanded = f.expandedItemIds.has(it.id);
    const bodyHtml = expanded ? deviceDetailSlotBodyHtml(f, it) : '';
    return `<button type="button" class="itl-link" data-device-expand="${it.id}">${expanded ? '收起' : '展开明细'}</button><div class="itl-sheet-device-detail" data-device-detail="${it.id}"${expanded ? '' : ' hidden'}>${bodyHtml}</div>`;
  }
  // C5c：只读详情页（renderDetailView）版本——该视图单次打开期间只有一个调用点（load() 里），自己
  // 从不主动触发重绘（不像 renderForm 有自动保存/冲突合并/在途锁驱动的重绘循环），所以展开状态与
  // 缓存用函数内局部闭包变量就够，不需要挂在任何跨渲染持久化的对象上。
  // L1（C5c-b，Opus预筛，修正上一句"从不重绘"的不准确处）：单次打开内不重绘，不等于这个闭包的异步
  // 回调不会在"离开后又重新打开同一张单"时迟到——旧闭包的 GET /inspections/:id 请求可能在新一轮
  // load() 已经重新渲染出一份结构相同（data-device-detail 值相同，因为是同一张单同一批 item.id）的
  // 新 DOM 之后才落地；此时 paint() 如果仍用 document.querySelector 全局查找，会精确命中新渲染出的
  // 同名节点，把旧闭包（可能已经过期，比如告警数不一样）的状态画上去。改为 wire() 时记录本次渲染
  // 专属的 section 节点（sectionEl），paint() 先判 sectionEl.isConnected——旧渲染那一整块 DOM 在新一
  // 轮 innerHTML 赋值时已被整体替换、不再挂在文档树上，isConnected 会正确变 false，旧回调据此安全
  // 短路；不能拿 #itlContent 这个从不被移除的常驻容器当判据（那样 isConnected 恒真，形同虚设）。
  // data-device-expand/data-device-detail 的值加 "view-" 前缀，与填写页的数字 item.id 区分（避免
  // 同一个 sheet 详情/表单理论上不会同屏出现，但前缀本身零成本，留作防御）。
  function deviceDetailListForView(detail) {
    const expandedIds = new Set(), touched = new Set(), cache = new Map();
    let sectionEl = null;
    function ensure(it) {
      const recId = it.device_inspection_id;
      if (!recId) return null;
      let entry = cache.get(recId);
      if (entry) return entry;
      entry = { status: 'loading' };
      cache.set(recId, entry);
      L.api('/inspections/' + recId).then(data => {
        if (cache.get(recId) !== entry) return;
        entry.status = 'ok'; entry.data = data;
        if (!touched.has(it.id)) {
          const alerts = data.snapshot && Array.isArray(data.snapshot.alerts) ? data.snapshot.alerts : [];
          if (alerts.length) expandedIds.add(it.id); else expandedIds.delete(it.id);
        }
        paint(it);
      }).catch(error => {
        if (cache.get(recId) !== entry) return;
        entry.status = 'error';
        // L3（C5c-b，Opus预筛）：同填写页 ensureDeviceDetail——404 保留缓存文案，非404 点击展开时删
        // 缓存重试，见 wire() 里的点击处理。
        entry.notFound = !!(error && error.status === 404);
        entry.message = entry.notFound ? '无权查看或记录不存在' : mapFailureReason(error);
        paint(it);
      });
      return entry;
    }
    function bodyHtml(it) {
      const entry = ensure(it);
      if (!entry || entry.status === 'loading') return '<p class="itl-muted">正在读取…</p>';
      if (entry.status === 'error') return `<p class="itl-form-error">${esc(entry.message)}</p>`;
      return deviceDetailBodyHtml(entry.data.snapshot);
    }
    function paint(it) {
      if (!sectionEl || !sectionEl.isConnected) return; // L1：本次渲染已被替换掉，迟到的回调不作数
      const slot = sectionEl.querySelector(`[data-device-detail="view-${it.id}"]`);
      const btn = sectionEl.querySelector(`[data-device-expand="view-${it.id}"]`);
      if (!slot) return;
      const expanded = expandedIds.has(it.id);
      slot.hidden = !expanded;
      if (btn) btn.textContent = expanded ? '收起' : '展开明细';
      if (expanded) slot.innerHTML = bodyHtml(it);
    }
    const deviceItems = detail.items.filter(it => it.section === 'device' && it.device_inspection_id);
    function rowHtml(it) {
      ensure(it); // 渲染即预取，决定默认展开（同填写页 deviceExpandHtml 的取舍）
      const expanded = expandedIds.has(it.id);
      return `<div class="itl-sheet-row" data-item-id="${it.id}"><span class="itl-sheet-label">${esc(it.target_label)}</span><button type="button" class="itl-link" data-device-expand="view-${it.id}">${expanded ? '收起' : '展开明细'}</button><div class="itl-sheet-device-detail" data-device-detail="view-${it.id}"${expanded ? '' : ' hidden'}>${expanded ? bodyHtml(it) : ''}</div></div>`;
    }
    const html = deviceItems.length
      ? `<section class="itl-sheet-card" data-device-list-section><header><h3>设备采集明细 · ${esc(deviceItems.length)} 台</h3></header>${deviceItems.map(rowHtml).join('')}</section>`
      : '';
    function wire(root) {
      sectionEl = root.querySelector('[data-device-list-section]'); // L1：本次渲染专属的 section 节点
      root.querySelectorAll('[data-device-expand]').forEach(btn => btn.addEventListener('click', () => {
        const itemId = Number(String(btn.dataset.deviceExpand).replace('view-', ''));
        const it = deviceItems.find(x => x.id === itemId);
        if (!it) return;
        touched.add(itemId);
        const expanding = !expandedIds.has(itemId);
        if (expanding && it.device_inspection_id) {
          const entry = cache.get(it.device_inspection_id);
          if (entry && entry.status === 'error' && !entry.notFound) cache.delete(it.device_inspection_id);
        }
        if (expandedIds.has(itemId)) expandedIds.delete(itemId); else expandedIds.add(itemId);
        paint(it);
      }));
    }
    return { html, wire };
  }
  function deviceSectionHtml(f, writable = true) {
    const items = f.detail.items.filter(it => it.section === 'device');
    if (!items.length) return '<p class="itl-muted">本机房范围内没有在用设备。</p>';
    const devices = f.detail.scope.devices || [], racks = f.detail.scope.racks || [];
    return items.map(it => {
      const dev = devices.find(d => d.id === it.target_id);
      const rack = dev ? racks.find(r => r.id === dev.rack_id) : null;
      const locText = dev ? `${(L.categories && L.categories[dev.category]) || dev.category} · ${rack ? rack.name : '机柜#' + dev.rack_id} U${dev.u_start}–${dev.u_start + dev.u_height - 1} · ${it.item_label}` : it.item_label;
      const collecting = f.collecting.has(it.id);
      // H4：采集按钮按 actions.includes('collect') 决定要不要出现（不再只用一个前端本地的 writable 变量
      // 兜底所有控件——collect 与 save 目前在后端总是同批授予，但显式核对各自的字面 action 更贴近方案
      // "按钮显示依据接口返回的可做的动作"原句，也更抗未来后端把两者拆开的变化）。C5a-d：disabled 现在
      // 还要核 isLocked(f)——在途锁下即使不是这一项自己在采集（比如冲刷或另一次操作占着），采集按钮
      // 也不能点；文案只在"正是这一项"时显示"正在采集…"，锁定但不是这一项时仍显示常规文案（只是灰掉）。
      const collectBtn = f.detail.actions.includes('collect') ? `<button type="button" class="u-btn-secondary itl-btn-sm" data-collect-id="${it.id}"${isLocked(f) ? ' disabled' : ''}>${collecting ? '正在采集…' : '一键采集（选填）'}</button>` : '';
      // The note and abnormal photo sit right under their own device, not collected at the bottom of the section.
      return `<div class="itl-sheet-device-item" data-device-item="${it.id}"><div class="itl-sheet-row" data-item-id="${it.id}"><span class="itl-sheet-label">${esc(it.target_label)}<small>${esc(locText)}</small><small data-collection-state>${it.device_inspection_id ? '已关联采集记录' : '现场观察登记 · 未采集'}</small></span>${segHtml(f, it, writable)}${collectBtn}${deviceExpandHtml(f, it)}</div>${notesHtml(f, 'device', writable, it.id)}${manualEditorHtml(f, it, writable)}</div>`;
    }).join('');
  }
  // M4（方案 §3.1 最后一条）：说明框现在覆盖两类项——①result==='bad'（异常，旧有行为不变）；②
  // result==='ok' 但这个 item id 出现在 f.everDeviceIssueIds 里（本表单会话内曾经出现过的设备说明要求
  // 累积集合，方案必做7——见 trackDeviceIssueIds 头部注释：只认当次瞬时的 deviceIssueItemIds 会让
  // 说明框在填完说明保存成功后自己消失，改用只增不减的累积集合）。只提示不阻断，真正拦截仍是后端
  // 400 SHEET_INCOMPLETE。
  function photoPosition(slot, targetId) { return slot + ':' + targetId; }
  function photosAt(rows, slot, targetId) { return (rows || []).filter(p => p.slot === slot && p.target_id === targetId); }
  function effectivePhotosAt(f, slot, targetId) {
    const removed = new Set(f.detail.my_removed_photo_ids || []);
    return [...photosAt(f.detail.photos,slot,targetId).filter(p=>!f.submittedEdit||!removed.has(p.id)), ...photosAt(f.submittedEdit ? f.detail.my_pending_photos : [],slot,targetId)];
  }
  function photoSlotHtml(f, slot, targetId, label, writable = true) {
    const key = photoPosition(slot, targetId);
    const message = f.photoMessages.get(key) || '';
    const active = photosAt(f.detail.photos, slot, targetId);
    const pending = f.submittedEdit ? photosAt(f.detail.my_pending_photos, slot, targetId) : [];
    const removed = new Set(f.submittedEdit ? f.detail.my_removed_photo_ids || [] : []), count = effectivePhotosAt(f,slot,targetId).length;
    const card = (photo, pendingState) => `<div class="itl-sheet-photo-file${pendingState ? ' is-pending' : ''}${removed.has(photo.id) ? ' is-removed' : ''}" data-photo-id="${photo.id}"><img data-photo-thumb-id="${photo.id}" data-photo-thumb-status="loading" alt="${esc(photo.original_name)}"><span>${esc(photo.original_name)}${removed.has(photo.id) ? ' · 待移除' : pendingState ? ' · 待保存' : ''}</span><button type="button" class="itl-link" data-photo-view="${photo.id}" data-photo-name="${esc(photo.original_name)}">放大</button>${writable ? `<button type="button" class="itl-link ${removed.has(photo.id) ? '' : 'itl-danger'}" data-photo-delete="${photo.id}" data-photo-position="${key}"${removed.has(photo.id) ? ' data-photo-undo="true"' : ''}${isLocked(f) ? ' disabled' : ''}>${removed.has(photo.id) ? '撤销移除' : '删除'}</button>` : ''}</div>`;
    return `<div class="itl-sheet-photo-slot" data-photo-position="${key}"><div class="itl-sheet-photo-heading"><strong>${esc(label)}</strong><span class="itl-muted" data-photo-count>${count} / 10 张</span></div><div class="itl-sheet-photo-attachments">${active.map(p=>card(p,false)).join('')}${pending.map(p=>card(p,true)).join('')}</div>${writable ? `<label class="itl-sheet-photo-picker">${count >= 10 ? '已达10张上限' : count ? '继续添加图片' : '添加图片'}<input type="file" multiple data-photo-upload="${key}" data-photo-full="${count >= 10}" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"${isLocked(f) || count >= 10 ? ' disabled' : ''}></label>` : ''}<span class="${message ? 'itl-form-error' : 'itl-muted'}" data-photo-message="${key}" role="status">${esc(message)}</span></div>`;
  }
  function rackPhotoHtml(f, rack, writable = true) {
    const count = effectivePhotosAt(f, 'rack_front', rack.id).length;
    return `<div data-rack-photo="${rack.id}"><span class="${count ? '' : 'itl-photo-missing'}" data-rack-photo-status>${count ? '已有 ' + count + ' 张 · 至少1张正面照' : '还缺至少 1 张正面照'}</span>${photoSlotHtml(f, 'rack_front', rack.id, rack.name + ' · 正面照', writable)}</div>`;
  }
  function notesHtml(f, sectionKey, writable = true, itemId = null) {
    const items = f.detail.items.filter(it => it.section === sectionKey && it.value_kind === 'check' && (itemId === null || it.id === itemId));
    const relevant = items.filter(it => { const r = (f.working.get(it.id) || {}).result; return r === 'bad' || (r === 'ok' && f.everDeviceIssueIds.has(it.id)); });
    // C5a-e H5：说明框同数字读数框——锁定时 readonly（保留焦点/光标），无编辑权限时恒 disabled。
    const noteAttrs = !writable ? ' disabled' : (isLocked(f) ? ' readonly' : '');
    return relevant.map(it => {
      const w = f.working.get(it.id) || {};
      const label = sectionKey === 'room' ? it.item_label : (it.target_label + ' · ' + it.item_label);
      const noteLabel = w.result === 'ok' ? '采集有告警，判正常需写说明' : '异常说明（必填）';
      // LOW：说明框 maxlength 与后端 note 列 CHECK(length<=500) 一致（inspection-sheets.js:106）。
      return `<div class="itl-sheet-note${w.result === 'ok' ? ' itl-sheet-note-issue' : ''}"><label>${esc(label)} · ${noteLabel}<input type="text" data-note-id="${it.id}" value="${esc(w.note || '')}" placeholder="写清现象" maxlength="${NOTE_MAXLEN}"${noteAttrs}></label>${w.result === 'bad' ? `<div class="itl-sheet-note-photo">${photoSlotHtml(f, 'item', it.id, label + ' · 异常照片', writable)}</div>` : ''}</div>`;
    }).join('');
  }
  function sectionCardHtml(f, key, title, writable = true) {
    const p = sectionProgress(f, key);
    const body = key === 'room' ? roomSectionHtml(f, writable) : key === 'rack' ? rackSectionHtml(f, writable) : deviceSectionHtml(f, writable);
    // C5a-d：按钮始终渲染（只要有写权限），在途锁只让它 disabled——不再像旧版那样锁定期间也看不出
    // "本段其余全部正常"这个控件存在过（方案必做1："同步 disabled"，不是"隐藏"）。
    const allNormalBtn = writable ? `<button type="button" class="u-btn-secondary itl-btn-sm" data-all-normal="${key}"${isLocked(f) ? ' disabled' : ''}>本段其余全部正常</button>` : '';
    const index = ['room', 'rack', 'device'].indexOf(key), next = ['rack', 'device', 'remark'][index];
    const hints = { room: '先记录温湿度，再检查环境设施', rack: '逐柜检查，并留存本次巡检照片', device: '现场观察即可登记，一键采集为可选辅助' };
    return `<details class="itl-sheet-card itl-sheet-seg-card" data-sheet-section="${key}" data-workflow-section="${key}"${f.openSections.has(key) ? ' open' : ''}><summary><span class="itl-sheet-step-number">0${index + 2}</span><h3>${esc(title)}</h3><span class="itl-sheet-progress">${progressLineHtml(p)}</span></summary><div class="itl-sheet-fold"><div class="itl-sheet-section-tools"><span>${hints[key]}</span>${allNormalBtn}</div><div class="itl-sheet-body">${body}</div>${key === 'rack' ? `<div class="itl-sheet-notes">${notesHtml(f, key, writable)}</div>` : ''}<div class="itl-sheet-next"><button type="button" class="u-btn-secondary itl-btn-sm" data-workflow-next="${next}">继续：${next === 'rack' ? '机柜检查' : next === 'device' ? '服务器与存储' : '总体备注'}</button></div></div></details>`;
  }
  function manualEditorHtml(f, it, writable) {
    const m = (f.working.get(it.id) || it).manual_observation || {};
    const attrs = writable ? (isLocked(f) ? ' readonly' : '') : ' readonly disabled';
    const field = (key, label, type = 'text', extra = '') => `<label>${label}<input type="${type}" data-manual-id="${it.id}" data-manual-field="${key}" aria-label="${esc(it.target_label + ' · ' + label)}" value="${esc(key === 'observed_at' && m[key] ? toLocalDateTime(m[key]) : m[key] ?? '')}"${attrs}${extra}></label>`;
    return `<div class="itl-sheet-manual${f.conflictIds.has(it.id) ? ' itl-sheet-conflict' : ''}">${field('observation','观察记录 · 选填','text',' maxlength="500" placeholder="如：面板完整，运行灯正常，无告警"')}<details data-manual-details="${it.id}"${f.manualOpenIds.has(it.id) ? ' open' : ''}><summary>手填运行指标 <small>选填，从管理页面或仪表读取</small></summary><div class="itl-sheet-manual-grid">${field('cpu_percent','CPU 使用率（%）','number',' min="0" max="100" step="0.1"')}${field('memory_percent','内存使用率（%）','number',' min="0" max="100" step="0.1"')}${field('disk_percent','磁盘使用率（%）','number',' min="0" max="100" step="0.1"')}${field('disk_label','磁盘 / 卷名称','text',' maxlength="100" placeholder="如 C: 或 /data"')}<label>读数来源<select data-manual-id="${it.id}" data-manual-field="source" aria-label="${esc(it.target_label)} · 读数来源"${!writable || isLocked(f) ? ' disabled' : ''}><option value="">请选择</option>${Object.entries(MANUAL_SOURCES).map(([v,n])=>`<option value="${v}"${m.source===v?' selected':''}>${n}</option>`).join('')}</select></label>${field('observed_at','观察时间','datetime-local')}</div><p class="itl-muted">填写运行指标时，请一并记录来源和观察时间；人工读数与一键采集结果分别保留。</p></details></div>`;
  }
  function toLocalDateTime(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16) : ''; }
  function onManualInput(f, el) {
    if (isLocked(f) || !f.detail.actions.includes('save')) return;
    const id = Number(el.dataset.manualId), key = el.dataset.manualField, w = f.working.get(id);
    if (!w || !MANUAL_FIELDS.includes(key) || itemById(f,id)?.section !== 'device') return;
    let value = el.value.trim() ? el.value : null;
    if (key.endsWith('_percent') && value !== null) {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 100) { el.value = w.manual_observation?.[key] ?? ''; L.toast('运行指标须在 0–100% 之间'); return; }
    }
    if (key === 'observed_at' && value !== null) { const date = new Date(value); if (!Number.isFinite(date.getTime())) return; value = date.toISOString(); }
    f.working.set(id, { ...w, manual_observation: normalizeManual({ ...w.manual_observation, [key]: value }) });
    scheduleAutosave(f); updateActionBar(f);
  }
  const SECTION_TITLES = f => ({ room: '机房环境', rack: '机柜 · ' + (f.detail.scope.racks || []).length + ' 个', device: '服务器与存储 · ' + (f.detail.scope.devices || []).length + ' 台' });
  const WORKFLOW_SECTIONS = [['basic', '基本信息'], ['room', '机房环境'], ['rack', '机柜检查'], ['device', '服务器与存储'], ['remark', '总体备注'], ['review', '核对提交']];
  function workflowNavHtml(f) {
    return WORKFLOW_SECTIONS.map(([key, title], index) => {
      const p = ['room', 'rack', 'device'].includes(key) ? sectionProgress(f, key) : null;
      return `<button type="button" data-workflow-go="${key}"${f.activeSection === key ? ' aria-current="step"' : ''}><span class="itl-route-number">${String(index + 1).padStart(2, '0')}</span><span>${title}</span><small>${p ? p.filled + ' / ' + p.total + ' 项' : key === 'basic' ? '机房、人员、时间' : key === 'remark' ? '补充现场情况' : '确认本次记录'}</small></button>`;
    }).join('');
  }
  function wireWorkflowSection(f, root) {
    if (!root) return;
    root.addEventListener('toggle', () => {
      if (!formVisible(f) || !root.isConnected) return;
      const key = root.dataset.workflowSection;
      if (root.open) { f.openSections.add(key); f.activeSection = key; } else f.openSections.delete(key);
      updateWorkflowNav(f);
    });
    root.querySelectorAll('[data-workflow-next]').forEach(button => button.addEventListener('click', () => {
      f.openSections.delete(root.dataset.workflowSection); root.open = false;
      openWorkflowSection(f, button.dataset.workflowNext, true);
    }));
  }
  function updateWorkflowNav(f) {
    if (!formVisible(f)) return;
    const nav = $('#itlSheetRoute');
    if (nav) {
      // Claude 复核 L2：自动保存后频繁调用这里；按钮已在就只改进度文字与 aria-current，不重建，
      // 否则键盘焦点停在目录按钮上时会被重建丢到 body。
      const existing = nav.querySelectorAll('[data-workflow-go]');
      if (existing.length === WORKFLOW_SECTIONS.length && nav.dataset.wiredFor === String(f.id)) {
        const template = document.createElement('div'); template.innerHTML = workflowNavHtml(f);
        const fresh = template.querySelectorAll('[data-workflow-go]');
        existing.forEach((button, index) => {
          if (fresh[index].hasAttribute('aria-current')) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
          const small = button.querySelector('small'), next = fresh[index].querySelector('small');
          if (small && next && small.textContent !== next.textContent) small.textContent = next.textContent;
        });
      } else {
        nav.innerHTML = workflowNavHtml(f); nav.dataset.wiredFor = String(f.id);
        nav.querySelectorAll('[data-workflow-go]').forEach(button => button.addEventListener('click', () => openWorkflowSection(f, button.dataset.workflowGo, true)));
      }
    }
    const all = $('#itlSheetExpandAll');
    if (all) all.textContent = WORKFLOW_SECTIONS.every(([key]) => f.openSections.has(key)) ? '收起其他分段' : '全部展开';
  }
  function openWorkflowSection(f, key, moveFocus = false) {
    if (!formVisible(f)) return;
    const root = $(`[data-workflow-section="${key}"]`);
    if (!root) return;
    f.openSections.add(key); f.activeSection = key; root.open = true; updateWorkflowNav(f);
    if (moveFocus) { root.scrollIntoView({ block: 'start', behavior: 'auto' }); root.querySelector('summary')?.focus({ preventScroll: true }); }
  }
  function exposeWorkflowTarget(f, target) {
    const section = target?.closest('[data-workflow-section]');
    if (section) openWorkflowSection(f, section.dataset.workflowSection);
  }
  function arrangeFormFooter(f, status, progress) {
    const footer = $('#itlFormFooter');
    if (!footer) return;
    footer.replaceChildren();
    const info = document.createElement('span'); info.className = 'itl-sheet-footer-info';
    const strong = document.createElement('strong'); strong.textContent = progress.filled + ' / ' + progress.total + ' 项已登记';
    info.append(strong, document.createTextNode(status || '修改后自动保存草稿')); footer.append(info);
    for (const id of f.submittedEdit ? ['itlEditDiscard', 'itlEditSave'] : ['itlFormDelete', 'itlFormSubmit']) {
      const button = $('#' + id); if (button) footer.append(button);
    }
  }
  function renderSection(f, key) {
    if (!formVisible(f)) return;
    const el = $(`[data-sheet-section="${key}"]`);
    if (!el) return;
    el.outerHTML = sectionCardHtml(f, key, SECTION_TITLES(f)[key]);
    wireSectionEvents(f, key);
    updateActionBar(f);
  }
  function wireSectionEvents(f, key) {
    const root = $(`[data-sheet-section="${key}"]`);
    if (!root) return;
    wireWorkflowSection(f, root);
    root.querySelectorAll('[data-all-normal]').forEach(btn => btn.addEventListener('click', () => allNormal(f, btn.dataset.allNormal)));
    root.querySelectorAll('[data-seg-ok]').forEach(btn => btn.addEventListener('click', () => toggleSeg(f, Number(btn.dataset.segOk), 'ok')));
    root.querySelectorAll('[data-seg-bad]').forEach(btn => btn.addEventListener('click', () => toggleSeg(f, Number(btn.dataset.segBad), 'bad')));
    root.querySelectorAll('[data-num-id]').forEach(input => input.addEventListener('input', () => onNumberInput(f, Number(input.dataset.numId))));
    root.querySelectorAll('[data-note-id]').forEach(input => input.addEventListener('input', () => onNoteInput(f, Number(input.dataset.noteId), input.value)));
    root.querySelectorAll('[data-manual-id]').forEach(input => input.addEventListener('input', () => onManualInput(f, input)));
    root.querySelectorAll('[data-manual-details]').forEach(detail => detail.addEventListener('toggle', () => { if (!formVisible(f) || !detail.isConnected) return; const id = Number(detail.dataset.manualDetails); if (detail.open) f.manualOpenIds.add(id); else f.manualOpenIds.delete(id); }));
    root.querySelectorAll('[data-collect-id]').forEach(btn => btn.addEventListener('click', () => doCollect(f, Number(btn.dataset.collectId))));
    root.querySelectorAll('[data-photo-upload]').forEach(input => input.addEventListener('change', () => {
      const files = Array.from(input.files || []), [slot, rawId] = input.dataset.photoUpload.split(':');
      if (files.length) doUploadPhoto(f, slot, Number(rawId), files);
      input.value = '';
    }));
    root.querySelectorAll('[data-photo-delete]').forEach(btn => btn.addEventListener('click', () => {
      const [slot, rawId] = btn.dataset.photoPosition.split(':');
      doDeletePhoto(f, slot, Number(rawId), Number(btn.dataset.photoDelete), btn.dataset.photoUndo === 'true');
    }));
    root.querySelectorAll('[data-photo-view]').forEach(btn => btn.addEventListener('click', () => openPhotoViewer(f.photoOwner, Number(btn.dataset.photoView), btn.dataset.photoName, btn, () => formVisible(f))));
    hydratePhotoThumbs(f.photoOwner, root, () => formVisible(f));
    // C5c：展开/收起按钮——本地UI，不查isLocked，见toggleDeviceDetail头部注释。
    root.querySelectorAll('[data-device-expand]').forEach(btn => btn.addEventListener('click', () => toggleDeviceDetail(f, Number(btn.dataset.deviceExpand))));
  }
  // 二态开关：再点一次已选中的值回到未填 null（方案 §3.1 界面基准）；note 不随切换清空，切回异常时保留
  // 之前写过的说明，避免用户反复切换时丢字。
  function toggleSeg(f, itemId, clicked) {
    // C5a-d（G4=A 必做1，监听器侧双保险）：在途锁下直接拒绝，替换旧的 f.submitting 单点检查——旧版
    // 只挡提交，挡不住冲刷/采集/删除在途时的编辑；"飞行中编辑"作为一整类状态在这里被消灭。
    if (isLocked(f)) return;
    const w = f.working.get(itemId) || { result: null, number_value: null, note: null };
    const next = w.result === clicked ? null : clicked;
    // M4：切到"正常"且这个 item id 不在 f.everDeviceIssueIds 累积集合里时，清空隐藏的旧说明——不让
    // 一条历史遗留文字"恰好满足"以后可能出现的规则（H3 同款陷阱，见 memory
    // feedback_validate_persisted_state_not_intent）。切到"异常"、或切到"正常但仍在这个集合里"（说明
    // 仍然必填），保留旧说明，方便用户反复切换不丢字（既有行为不变）。
    const keepNote = next === 'bad' || (next === 'ok' && f.everDeviceIssueIds.has(itemId));
    f.working.set(itemId, { ...w, result: next, number_value: null, note: keepNote ? (w.note ?? null) : null });
    scheduleAutosave(f);
    const it = itemById(f, itemId);
    if (it) renderSection(f, it.section);
  }
  // 数值范围校验（越界零请求）：越界只更新错误提示，不写入 working、不调用 scheduleAutosave——无效值
  // 永远进不了任何请求体（handoff-agent6.md §3.1）。
  function onNumberInput(f, itemId) {
    if (isLocked(f)) return; // C5a-d（必做1，监听器侧双保险）：在途锁下拒绝，替换旧的 f.submitting 单点检查
    const el = document.querySelector(`[data-num-id="${itemId}"]`);
    const errEl = document.querySelector(`[data-num-error="${itemId}"]`);
    const softEl = document.querySelector(`[data-num-soft="${itemId}"]`);
    const it = itemById(f, itemId);
    if (!el || !it) return;
    const range = NUMBER_RANGE[it.item_key];
    const soft = SOFT_RANGE[it.item_key];
    const raw = el.value;
    if (raw.trim() === '') { f.working.set(itemId, { result: null, number_value: null, note: null }); if (errEl) errEl.textContent = ''; if (softEl) softEl.textContent = ''; scheduleAutosave(f); updateSectionProgressOnly(f, it.section); return; }
    const num = Number(raw);
    if (!Number.isFinite(num) || (range && (num < range[0] || num > range[1]))) {
      if (errEl) errEl.textContent = range ? `超出范围（${range[0]}~${range[1]}）` : '数值无效';
      // C5a-c §3.1第3条：越界（硬拦截）时输入框回显working里当前的有效值——不留"框里显示越界值、
      // working其实没变"的视觉错位（方案原句二选一里的"回显上一个有效值"这一支，理由：另一支"标红+
      // 失焦时才回显"会让用户在失焦前一直看着一个从未真正写入过working的数字，误以为已经生效）。不
      // touch working/note——沿用既有"越界值零请求"设计，这一步只是纯视觉纠正。
      const w = f.working.get(itemId) || {};
      el.value = w.number_value === null || w.number_value === undefined ? '' : String(w.number_value);
      return;
    }
    if (errEl) errEl.textContent = '';
    // C5a-c §3.1第2条：硬范围内、软性参考范围外——只提示"超出参考范围"，仍正常保存（不 return，照常
    // 写入working、照常排冲刷）。
    if (softEl) softEl.textContent = (soft && (num < soft[0] || num > soft[1])) ? '超出参考范围' : '';
    f.working.set(itemId, { result: null, number_value: num, note: null });
    scheduleAutosave(f);
    updateSectionProgressOnly(f, it.section);
  }
  function onNoteInput(f, itemId, value) {
    if (isLocked(f)) return; // C5a-d（必做1，监听器侧双保险）：在途锁下拒绝，替换旧的 f.submitting 单点检查
    const w = f.working.get(itemId) || { result: 'bad', number_value: null, note: null };
    f.working.set(itemId, { ...w, note: value.trim() === '' ? null : value });
    scheduleAutosave(f);
  }
  function updateSectionProgressOnly(f, key) {
    const el = document.querySelector(`[data-sheet-section="${key}"] .itl-sheet-progress`);
    if (el) el.innerHTML = progressLineHtml(sectionProgress(f, key));
    updateActionBar(f);
  }
  function allNormal(f, key) {
    if (isLocked(f)) return; // C5a-d（必做1，监听器侧双保险）：在途锁下拒绝，替换旧的 f.submitting 单点检查
    const items = f.detail.items.filter(it => it.section === key && it.value_kind === 'check');
    for (const it of items) { const w = f.working.get(it.id); if (!w || w.result === null) f.working.set(it.id, { ...w, result: 'ok', number_value: null, note: w ? w.note : null }); }
    scheduleAutosave(f);
    renderSection(f, key);
  }
  function progressSummary(f) {
    let filled = 0, total = 0, bad = 0;
    for (const key of ['room', 'rack', 'device']) { const p = sectionProgress(f, key); filled += p.filled; total += p.total; bad += p.bad; }
    const missingNotes = f.detail.items.filter(it => (f.working.get(it.id) || {}).result === 'bad' && !((f.working.get(it.id) || {}).note || '').trim()).length;
    return { filled, total, bad, missingNotes };
  }
  // M5：「可提交」与提交按钮是否可点，以服务端 progress.complete/progress.missing 为准（f.detail.progress
  // 是最近一次成功响应的服务端权威判定，含照片/设备判断这些前端本地算不出来的条件）；本地字段计数
  // （progressSummary）只用来展示"已填 X/Y"这行小结，不再单独驱动提交按钮的禁用逻辑（H4 事故同源：前端
  // 自己攒一份"够不够格"的判断很容易和后端不一致）。M6：本地有未落盘的修改（含冲突高亮、上一轮冲刷
  // 失败）时，右侧状态一律显示"有修改未保存"，不展示可能已经过期的"草稿已保存 HH:MM"；从未保存过且当前
  // 也不脏时（刚打开一张已有数据的草稿）不displaying"尚未保存"这种误导文案，留空。
  function hasUnsavedWork(f) {
    const dirty = computeDirty(f);
    return dirty.items.length > 0 || dirty.remarkChanged || f.conflictIds.size > 0 || f.remarkConflict || !f.lastFlushOk;
  }
  function missingEntries(f) {
    const missing = f.detail.progress.missing;
    const itemEntry = (kind, id, suffix) => {
      const item = itemById(f, id);
      const label = item ? (item.section === 'room' ? item.item_label : item.target_label + ' · ' + item.item_label) : '检查项 #' + id;
      return { key: kind + ':' + id, kind, id, label: label + suffix };
    };
    return [
      ...missing.unfilledItemIds.map(id => itemEntry('unfilled', id, ' · 未填')),
      ...missing.missingNoteItemIds.map(id => itemEntry('note', id, ' · 缺异常说明')),
      ...missing.missingPhotoPositions.map(position => {
        const rack = (f.detail.scope.racks || []).find(r => r.id === position.target_id);
        const label = position.slot === 'rack_front' ? (rack ? rack.name : '机柜 #' + position.target_id) + ' · 正面照' : itemEntry('photo', position.target_id, ' · 异常照片').label;
        return { key: 'photo:' + position.slot + ':' + position.target_id, kind: 'photo', slot: position.slot, id: position.target_id, label };
      }),
      ...missing.deviceIssueItemIds.map(id => itemEntry('device', id, ' · 设备判断需说明')),
      ...(missing.manualObservationItemIds || []).map(id => itemEntry('manual', id, ' · 手填读数缺来源或时间')),
    ];
  }
  function focusMissingEntry(f, entry) {
    let target;
    if (entry.kind === 'photo') target = document.querySelector('[data-photo-upload="' + entry.slot + ':' + entry.id + '"]');
    else if (entry.kind === 'manual') { f.manualOpenIds.add(entry.id); const panel = document.querySelector('[data-manual-details="' + entry.id + '"]'); if (panel) panel.open = true; target = document.querySelector('[data-manual-id="' + entry.id + '"][data-manual-field="source"]'); }
    else if (entry.kind === 'note' || entry.kind === 'device') target = document.querySelector('[data-note-id="' + entry.id + '"]');
    else target = document.querySelector('[data-num-id="' + entry.id + '"], [data-seg-ok="' + entry.id + '"]');
    // The list is server-owned; local edits can temporarily remove its old target before autosave.
    if (!target) target = document.querySelector('[data-item-id="' + entry.id + '"] button');
    if (target) { exposeWorkflowTarget(f, target); target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
  }
  function updateActionBar(f) {
    if (!formVisible(f)) return;
    const bar = $('#itlFormActionbar');
    if (!bar) return;
    updateWorkflowNav(f);
    const p = progressSummary(f);
    const unsaved = hasUnsavedWork(f);
    const progress = f.detail.progress || { complete: false, missing: {} };
    const missing = progress.missing || {};
    const missingText = describeIncomplete({
      unfilled_item_ids: missing.unfilledItemIds, missing_note_item_ids: missing.missingNoteItemIds,
      missing_photo_positions: missing.missingPhotoPositions, device_issue_item_ids: missing.deviceIssueItemIds,
      manual_observation_item_ids: missing.manualObservationItemIds,
    });
    const photosText = Number.isFinite(progress.photosExpected) ? ` · 照片位 ${esc(progress.photosUploaded || 0)} / ${esc(progress.photosExpected)}` : '';
    if (f.submittedEdit) {
      const pendingCount = (f.detail.my_pending_photos || []).length + (f.detail.my_removed_photo_ids || []).length;
      const status = f.savingEdit ? '正在保存修改…' : f.discardingPending ? '正在放弃修改…' : f.photoBusy ? '正在处理照片…' : unsaved ? '修改待保存' : pendingCount ? pendingCount + ' 项照片变更待保存' : '没有待保存的修改';
      bar.innerHTML = `<span>已填 <b>${esc(p.filled)} / ${esc(p.total)}</b> 项${photosText} · <span class="itl-muted">${esc(status)}</span></span>${progressHtml(p.filled,p.total)}<button type="button" class="u-btn-secondary" id="itlEditDiscard"${isLocked(f) ? ' disabled' : ''}>放弃修改</button><button type="button" class="u-btn-primary" id="itlEditSave"${isLocked(f) || (!unsaved && !pendingCount) ? ' disabled' : ''}>${f.savingEdit ? '保存中…' : '保存修改'}</button>`;
      $('#itlEditDiscard')?.addEventListener('click', () => doDiscardEdit(f));
      $('#itlEditSave')?.addEventListener('click', () => doSaveEdit(f));
      arrangeFormFooter(f, status, p);
      return;
    }
    let blockersText;
    if (unsaved) blockersText = '有修改未保存，保存后才能提交';
    else if (progress.complete) blockersText = '已全部填完，可提交';
    else blockersText = '还缺：' + missingText + '，补齐才能提交';
    // C5a-d（方案必做1"操作条显示『正在保存…』等状态文案"）：四个在途标志各自有自己的文案，按发生
    // 顺序判——submitting/deleting 各自的排队流程内部会先排一次冲刷（f.flushing 短暂为真），但
    // submitting/deleting 优先命中在前面，用户看到的是"正在提交…"/"正在删除…"而不是被冲刷步骤的
    // "正在保存…"一闪盖过去。
    let savedText;
    if (f.submitting) savedText = '正在提交…';
    else if (f.deleting) savedText = '正在删除…';
    else if (f.collecting.size) savedText = '正在采集…';
    else if (f.flushing) savedText = '正在保存…';
    else if (unsaved) savedText = '有修改未保存';
    else if (f.savedAt) savedText = '草稿已保存 ' + new Date(f.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    else savedText = '';
    const canSubmit = progress.complete && !unsaved && !isLocked(f);
    const entries = missingEntries(f);
    bar.innerHTML = `<header><strong>${esc(p.filled)} / ${esc(p.total)} 项已填</strong><span class="itl-muted" id="itlFormSavedAt">${esc(savedText)}</span></header>${progressHtml(p.filled,p.total)}<div class="itl-sheet-totals"><span><b>${esc(p.total-p.filled)}</b>未填</span><span><b class="itl-sheet-bad-count">${esc(p.bad)}</b>异常</span><span><b>${esc(progress.photosUploaded)} / ${esc(progress.photosExpected)}</b>照片位</span></div><span class="itl-muted" id="itlFormBlockers">${esc(blockersText)}</span><div class="itl-sheet-missing"><h3>还缺这些才能提交</h3><div id="itlFormMissing">${entries.map((entry,index)=>`<button type="button" class="itl-link" data-missing-key="${esc(entry.key)}" data-missing-index="${index}">${esc(entry.label)}</button>`).join('') || '<p class="itl-muted">没有缺失项</p>'}</div></div><button type="button" class="u-btn-primary" id="itlFormSubmit"${canSubmit ? '' : ' disabled'}>${f.submitting ? '提交中…' : '提交巡检'}</button><span class="itl-muted">提交后归档前仍可编辑</span>${f.detail.actions.includes('delete') ? `<button type="button" class="itl-link itl-danger" id="itlFormDelete"${isLocked(f) ? ' disabled' : ''}>删除草稿</button>` : ''}`;
    bar.querySelectorAll('[data-missing-index]').forEach(button => button.addEventListener('click', () => focusMissingEntry(f, entries[Number(button.dataset.missingIndex)])));
    $('#itlFormDelete')?.addEventListener('click', () => confirmDeleteDraft(f));
    $('#itlFormSubmit')?.addEventListener('click', () => doSubmit(f));
    arrangeFormFooter(f, savedText, p);
  }
  function renderForm(f) {
    // C5a-e（G5=A′必做1"纵深防御"）：form!==f 已经蕴含 f 不是当前会话；额外判 f.destroyed 是同一条
    // 判据的第二层——按当前的不变式（leaveForm/openForm/closeForm 每次替换 form 都同步把旧会话标记为
    // destroyed）两者应当恒等价，这里显式写出来是防御性的，不依赖"外层一定挡得住"这个假设（同 H1/H4
    // 在别处的一贯做法）。
    if (form !== f || f.destroyed) return;
    // H1：真的要把这个表单画出来了——说明用户已经（重新）在看它，清掉"已离开"标记。放在函数最开头，
    // 这样下面调用的 updateActionBar(f) 等辅助函数走 formVisible(f) 时能看到最新状态。
    f.left = false;
    // C5a-e（G5=A′必做3）：整表重绘会换掉全部 DOM 节点，document.activeElement 会被替换成 body——
    // 重绘前先记下当前焦点元素的"可识别键"（哪个 data-num-id/data-note-id，或者是不是备注框）与光标
    // 选区，重绘完成、事件重新绑好之后再找到新树里对应的那个元素恢复焦点与选区。performFlush 上锁/
    // 解锁的常规路径已经改用 applyLockState 就地更新、不再触发这里；这个恢复只在仍然需要整表重绘的
    // 场景（冲突合并/采集重取/提交结果/说明集合变化）生效，是那些场景下"不再让用户被弹回 body"的
    // 唯一保障。
    const focusKey = captureFocusKey();
    const d = f.detail;
    const remarkConflictCls = f.remarkConflict ? ' itl-sheet-conflict' : '';
    // H4：控件整体按 actions.includes('save') 决定可写——没有 save 动作时（比如巡检人写权限被降级为
    // 只读后，仍以 full 可见度能看到自己的草稿）这里应该是一张只读表单：不渲染删除/备注编辑框禁用、
    // 各段不出现"本段其余全部正常"按钮、二态开关不可点。当前唯一能触达这个分支的路径已经被 H4 的行点击/
    // openDraftById 判据挡在外面（无 save 的草稿走 openDetail 只读详情，不会走到这里）——这里的只读
    // 渲染是同一条判据的纵深防御，不依赖"外层挡得住"这个假设。
    const writable = d.actions.includes('save');
    // C6-d H2：同 renderDetailView，填写页根节点也带 data-sheet-id（测试可观测标记，见该处头部注释）。
    $('#itlContent').innerHTML = `
      <div class="itl-sheet-toolbar" data-sheet-id="${d.id}">
        <button type="button" class="u-btn-secondary" id="itlFormBack">返回巡检台账</button>
        <div class="itl-sheet-title"><h2>${esc(d.room_name)} · ${esc(dateOnly(d.created_at).slice(5))} ${f.submittedEdit ? '编辑已提交的巡检单' : '巡检'} ${badge(d.status)}</h2>
        <span class="itl-muted">巡检人 ${esc(d.created_by_name || '—')} · 开始于 ${esc(time(d.created_at))} · ${f.submittedEdit ? '修改需点击保存修改后生效' : '只填例外，其余可一键「本段其余全部正常」'}</span></div>
        <span class="itl-sheet-grow"></span>
        <button type="button" class="u-btn-secondary itl-btn-sm" id="itlSheetExpandAll">全部展开</button>
      </div>
      <div id="itlUnsavedForm"></div>
      ${f.submittedEdit && f.pendingDecision && leftoverPendingPhotos(f).length ? `<div class="itl-notice" id="itlPendingDecision">有上次未保存的 ${leftoverPendingPhotos(f).length} 项照片变更：<button type="button" class="itl-link" data-pending-decision="keep"${isLocked(f) ? ' disabled' : ''}>继续使用</button> / <button type="button" class="itl-link" data-pending-decision="discard"${isLocked(f) ? ' disabled' : ''}>丢弃</button></div>` : ''}
      ${f.photoMessage ? `<div class="itl-notice" id="itlPhotoMessage" role="status">${esc(f.photoMessage)}</div>` : ''}
      ${writable ? '' : '<div class="itl-notice">你当前没有编辑这张草稿的权限，以下内容只读。</div>'}
      <div class="itl-sheet-form-layout"><aside class="itl-sheet-navigation"><nav class="itl-sheet-route" id="itlSheetRoute" aria-label="巡检登记顺序">${workflowNavHtml(f)}</nav>${writable ? '<div class="itl-sheet-actionbar" id="itlFormActionbar" aria-label="巡检进度"></div>' : ''}</aside><div class="itl-sheet-form-main">
      <details class="itl-sheet-card" data-workflow-section="basic"${f.openSections.has('basic') ? ' open' : ''}><summary><span class="itl-sheet-step-number">01</span><h3>基本信息</h3><span class="itl-sheet-progress">本次登记范围</span></summary><div class="itl-sheet-fold"><div class="itl-sheet-basic"><div><label>巡检机房</label><span>${esc(d.room_name)}</span></div><div><label>巡检人</label><span>${esc(d.created_by_name || '—')}</span></div><div><label>开始时间</label><span>${esc(time(d.created_at))}</span></div></div></div></details>
      ${sectionCardHtml(f, 'room', SECTION_TITLES(f).room, writable)}
      ${sectionCardHtml(f, 'rack', SECTION_TITLES(f).rack, writable)}
      ${sectionCardHtml(f, 'device', SECTION_TITLES(f).device, writable)}
      <details class="itl-sheet-card" data-workflow-section="remark"${f.openSections.has('remark') ? ' open' : ''}><summary><span class="itl-sheet-step-number">05</span><h3>总体备注</h3><span class="itl-sheet-progress">选填</span></summary><div class="itl-sheet-fold"><label class="itl-sheet-remark-edit${remarkConflictCls}"><span class="itl-muted">单项异常请记录在对应检查项旁，这里可补充整体情况。</span><textarea id="itlFormRemark" rows="2" placeholder="本次巡检的其他情况" maxlength="${REMARK_MAXLEN}"${writable ? (isLocked(f) ? ' readonly' : '') : ' readonly disabled'}>${esc(f.remarkWorking || '')}</textarea></label><div class="itl-sheet-next"><button type="button" class="u-btn-secondary itl-btn-sm" data-workflow-next="review">进入核对</button></div></div></details>
      <details class="itl-sheet-card" data-workflow-section="review"${f.openSections.has('review') ? ' open' : ''}><summary><span class="itl-sheet-step-number">06</span><h3>核对提交</h3><span class="itl-sheet-progress">确认本次记录</span></summary><div class="itl-sheet-fold"><p class="itl-sheet-review-copy">核对检查结果、异常说明和本次巡检照片。未进行一键采集不会阻止提交；已关联的采集告警或失败需要按实际情况核对处理。${f.submittedEdit ? '修改完成后，点击底部「保存修改」。' : '缺失项可从左侧清单定位，完整保存后点击底部「提交巡检」。'}</p></div></details>
      </div></div>${writable ? '<div class="itl-sheet-footer" id="itlFormFooter" aria-label="巡检操作"></div>' : ''}`;
    ['basic', 'remark', 'review'].forEach(key => wireWorkflowSection(f, $(`[data-workflow-section="${key}"]`)));
    updateWorkflowNav(f);
    $('#itlSheetExpandAll').addEventListener('click', () => {
      const expanded = WORKFLOW_SECTIONS.every(([key]) => f.openSections.has(key));
      WORKFLOW_SECTIONS.forEach(([key]) => {
        const open = !expanded || key === f.activeSection;
        if (open) f.openSections.add(key); else f.openSections.delete(key);
        const root = $(`[data-workflow-section="${key}"]`); if (root) root.open = open;
      });
      updateWorkflowNav(f);
    });
    if (writable) {
      updateActionBar(f);
      // C5a-d（43S H2，方案必做1"备注监听 :905 当前就漏了"）：旧版这个监听器完全没有守卫——提交/冲刷
      // 在途期间用户改备注，working 会被静默写入，导致"提交发出后又改了备注"这类竞态。现在开头查
      // isLocked(f)（渲染层已经把 readOnly 属性同步加上，这里是监听器侧的双保险——H5 之后 readOnly
      // 本身就会挡掉键盘输入触发的 input 事件，这层判断主要防程序化触发）。
      $('#itlFormRemark').addEventListener('input', e => {
        if (isLocked(f)) return;
        const v = e.target.value; f.remarkWorking = v.trim() === '' ? null : v; scheduleAutosave(f);
      });
      ['room', 'rack', 'device'].forEach(key => wireSectionEvents(f, key));
    } else ['room', 'rack', 'device'].forEach(key => wireWorkflowSection(f, $(`[data-workflow-section="${key}"]`)));
    $('#itlFormBack').addEventListener('click', () => backToListFromForm(f));
    $('#itlPendingDecision [data-pending-decision="keep"]')?.addEventListener('click', () => { if (isLocked(f)) return; f.pendingDecision = false; $('#itlPendingDecision')?.remove(); });
    $('#itlPendingDecision [data-pending-decision="discard"]')?.addEventListener('click', () => doDiscardPending(f, false));
    // LOW（G5=A′，拿不准的点/自决——见交付报告）：预筛建议给删除按钮点击监听补 isLocked 守卫，但
    // confirmDeleteDraftRow 内部对"点击时已有在途操作"的处理方式与 toggleSeg 等编辑类监听器不同——
    // 编辑类监听器拒绝在途期间的操作是因为继续编辑working会产生数据不一致；删除请求本身通过同一条
    // 队列的FIFO正确排在在途操作之后再执行（activeForm.deleting 覆盖等待窗口，冲刷失败会中止删除并
    // 保留修改），"点击时在途"本就是这段逻辑设计要处理的场景，不是需要拒绝的非法状态。加这个守卫会让
    // AF-3(T-M2)"PUT挂起时确认删除，DELETE请求排在冲刷落定之后才发出"这条既有测试彻底不可达（现实中
    // disabled 属性已经挡住了真实点击，这里维持只用 disabled 挡、不加监听器侧isLocked拒绝，保留
    // AF-3 的既有判别力）。
    // The right panel owns the delete listener, including every save-state repaint.
    // C5a-f（H1+H2）：表单顶部显示"上次离开时未保存：…"（若登记表里有这张单的条目）——同一份数据源，
    // 换个展示位置，见 unsavedByAccountSheet 头部注释。
    renderUnsavedFormBanner(f.id);
    // C5a-e（G5=A′必做3）：DOM 树与事件都已经重新绑好，现在恢复重绘前记下的焦点与选区。
    restoreFocusKey(focusKey);
  }
  function highlightIncomplete(detail) {
    const ids = [...new Set([...(detail.unfilled_item_ids || []), ...(detail.missing_note_item_ids || []), ...(detail.device_issue_item_ids || []), ...(detail.manual_observation_item_ids || [])])];
    document.querySelectorAll('.itl-sheet-incomplete').forEach(el => el.classList.remove('itl-sheet-incomplete'));
    let first = null;
    for (const id of detail.manual_observation_item_ids || []) {
      if (form) form.manualOpenIds.add(id);
      const panel = document.querySelector(`[data-manual-details="${id}"]`); if (panel) panel.open = true;
    }
    for (const iid of ids) { const el = document.querySelector(`[data-item-id="${iid}"]`); if (el) { el.classList.add('itl-sheet-incomplete'); if (!first) first = el; } }
    for (const position of detail.missing_photo_positions || []) {
      const key = photoPosition(position.slot, position.target_id);
      const el = document.querySelector('[data-photo-position="' + key + '"]');
      if (el) { el.closest('details')?.setAttribute('open', ''); el.classList.add('itl-sheet-incomplete'); if (!first) first = el; }
    }
    if (first) { if (form) exposeWorkflowTarget(form, first); first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  function describeIncomplete(detail) {
    const parts = [];
    if (detail.unfilled_item_ids && detail.unfilled_item_ids.length) parts.push(detail.unfilled_item_ids.length + ' 项未填');
    if (detail.missing_note_item_ids && detail.missing_note_item_ids.length) parts.push(detail.missing_note_item_ids.length + ' 项缺异常说明');
    if (detail.missing_photo_positions && detail.missing_photo_positions.length) parts.push(detail.missing_photo_positions.length + ' 张照片未传');
    if (detail.manual_observation_item_ids && detail.manual_observation_item_ids.length) parts.push(detail.manual_observation_item_ids.length + ' 台手填读数缺来源或时间');
    if (detail.device_issue_item_ids && detail.device_issue_item_ids.length) parts.push(detail.device_issue_item_ids.length + ' 项设备判断需说明');
    return parts.join('、') || '缺项未知';
  }

  // ---- 提交 / 采集 / 删除草稿：都进同一队列，"先冲刷再执行"靠同一 tick 内连续两次 enqueue 天然保证 ----
  // H2：doSubmit 排两个独立任务（冲刷、提交）——旧版 performSubmit 从不检查冲刷是否真的成功，冲刷失败
  // （网络异常/LEDGER_BUSY/版本冲突都会让 performFlush 返回 false）时提交照样发出去，很可能提交的是
  // "服务器上还没有这次本地编辑"的旧数据。performSubmit 开头核 f.lastFlushOk（上一轮 performFlush 的
  // 结果）&& computeDirty(f) 为空 && 没有冲突残留，任一不满足就中止、不发 POST /submit。
  // C5a-d（G4=A）：doSubmit 在排队前就置位 f.submitting——覆盖住"冲刷子步骤 + 提交子步骤"整段窗口。
  // 冲刷子步骤自己也会短暂置位/清除 f.flushing，但 isLocked(f) 是 OR 起来的，f.submitting 全程为真
  // 保证这个窗口里 isLocked(f) 不会有假的"中间解锁"——不需要额外的引用计数。
  // H1（C5a-f）：会话已结束时的收尾提示统一走这个函数——按结果给一条明确的话，若这张单在
  // unsavedByAccountSheet 登记表里已经有条目（离开时还有别的内容没保存上），末尾追加一句指引，不再用
  // "有修改未保存："这个跟登记表语义重叠、又不准确（这次失败的动作本身不是"有编辑没保存"，是"采集/
  // 提交这个动作本身没做成"）的前缀。
  function notifyOutcome(f, message) {
    if (f.token !== getToken() || f.accessLost) return; // 失权结束的会话：全文提示已由 notifyAccessLostOnce / 离开冲刷给出，不再覆盖
    // N-H1（C5a-g）：后缀只在"登记表里这条条目属于当前账号"时才追加——不然会向账号 B 暗示"账号 A 的
    // 残留原文见巡检台账顶部"，等于告诉 B 去看一份不属于自己的内容（即便渲染层已经按 token 过滤掉了，
    // 这句话本身出现就已经是信息泄露的第一步）。
    const entry = unsavedByAccountSheet.get(unsavedKey(f.accountId, f.id));
    const suffix = (entry && entry.accountId === currentAccountId()) ? '（该单另有未保存内容，见巡检台账顶部）' : '';
    L.notice(message + suffix);
  }
  function doSubmit(f) {
    if (isLocked(f)) return;
    f.submitting = true; if (formVisible(f)) renderForm(f);
    enqueue(f.id, () => performFlush(f));
    enqueue(f.id, () => performSubmit(f));
  }
  async function performSubmit(f) {
    try {
      if (f.accessLost) return; // 外审 H-2：会话已因失权结束，不发请求、不覆盖全文提示
      if (f.token !== getToken()) { rejectChangedIdentity(f, '提交'); return; }
      const dirty = computeDirty(f);
      if (!f.lastFlushOk || dirty.items.length || dirty.remarkChanged || f.conflictIds.size || f.remarkConflict) {
        if (formVisible(f)) L.notice('有未保存的修改，已取消提交');
        else notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉未能提交：仍有未保存的修改，已取消');
        return;
      }
      try {
        if (f.token !== getToken()) { rejectChangedIdentity(f, '提交'); return; }
        const resp = await sessionApi(f, '/inspections/sheets/' + f.id + '/submit', { method: 'POST', body: JSON.stringify({ expected_version: f.detail.version }) });
        clearTimeout(f.timer); // LOW：提交成功后清掉该表单会话的自动保存计时器，不留一个指向已提交单的悬空重发
        if (formVisible(f)) { closeForm(); enterMode('detail'); detailId = resp.id; openDetail(resp.id); L.toast('巡检已提交；归档前仍可编辑'); }
        else L.toast('巡检单已提交');
      } catch (error) {
        if (error.status === 401 && f.token !== getToken()) {
          registerUnsaved(f.id, sheetLabel(f), [{ key: 'action:submit', text: '提交结果未能确认' }], '登录状态已变化，结果未能确认', f.accountId);
          return;
        }
        // M2（C5a-f）：会话已结束时不再走 handleConflict（不重取 GET、不重发——这张单此刻已经没有可见
        // 表单可以合并结果，同 performFlush 的 f.destroyed 分支一个道理）；按结果给一条对应的常驻提示。
        if (f.destroyed) {
          let msg;
          if (error.status === 400 && error.code === 'SHEET_INCOMPLETE') msg = '未能提交：检查项未填写完整（' + describeIncomplete(error.detail || {}) + '）';
          else if (error.status === 409) msg = '未能提交：这张单已在别处被修改，请重新打开核对后再提交';
          else msg = '未能提交：' + mapFailureReason(error);
          notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉' + msg);
          return;
        }
        if (error.status === 400 && error.code === 'SHEET_INCOMPLETE') {
          const detail = error.detail || {};
          highlightIncomplete(detail); L.notice('检查项未填写完整：' + describeIncomplete(detail));
        } else if (error.code === 'SHEET_VERSION_CONFLICT') {
          await handleConflict(f);
          // N-M2（C5a-g）：handleConflict 自己的重取 GET 在途时用户可能已经离开——它内部会因为 f.destroyed
          // 而不发任何提示（那个判断是为 performFlush 的场景设计的：leaveForm 会紧接着排一次离开冲刷来
          // 补一条统一提示）。performSubmit 这条路径没有"离开冲刷"这个后续步骤兜底，若这里不额外判一次，
          // 已销毁会话的提交冲突就会全程零提示，用户会以为提交成功了（预筛 Q2：notices=[]，服务端仍是
          // draft，用户毫无察觉）。
          if (f.destroyed) notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉未能提交：这张单已在别处被修改，请重新打开核对后再提交');
        }
        else L.notice('提交失败：' + mapFailureReason(error));
      }
    } finally {
      // 成功路径已经 closeForm()（f.destroyed=true），formVisible(f) 天然为假，这里不会误渲染。
      f.submitting = false;
      if (formVisible(f)) renderForm(f);
      L.__inspSubmitSettledBySheet.set(f.id, (L.__inspSubmitSettledBySheet.get(f.id) || 0) + 1);
    }
  }
  // M3：collecting 标记与"立即重绘按钮为disabled"都放在 doCollect（点击的同一个事件循环内，同步发生），
  // 不等排到队列里的 performCollect 真正开始执行才标记——旧版把 add() 放在 performCollect 开头，冲刷
  // 任务还没跑完时按钮显示仍是可点的，用户可以在冲刷排队期间再点一次同一个采集按钮，把同一项的采集
  // 请求排进队列两次。C5a-d：判据从"这一项是否已在采集"放宽成 isLocked(f)（在途锁）——旧版的去重只
  // 挡"同一项连点两次"，挡不住"这一项在采集时去点另一项"或"冲刷/提交在途时点采集"，在途锁统一堵死。
  function doCollect(f, itemId) {
    if (isLocked(f)) return;
    f.collecting.add(itemId);
    if (formVisible(f)) renderForm(f); // 锁整张表单；这一项按钮显示"正在采集…"，其余控件同步disabled
    enqueue(f.id, () => performFlush(f));
    enqueue(f.id, () => performCollect(f, itemId));
  }
  async function performCollect(f, itemId) {
    try {
      if (f.accessLost) return; // 外审 H-2：同上，失权后不再带着 403 状态重发采集 POST
      if (f.token !== getToken()) { rejectChangedIdentity(f, '采集'); return; }
      const resp = await sessionApi(f, '/inspections/sheets/' + f.id + '/items/' + itemId + '/collect', { method: 'POST' });
      // M1：采集响应本身不带完整性判定（设备判断规则要另查采集记录），重新 GET 一次拿服务器权威的
      // version/progress/actions——S-H4（43S H4）：检查项与备注统一走 applyFreshMerge（与 handleConflict
      // 共用同一个合并函数，不再自己直接替换 f.detail 又漏掉 remarkWorking 的同步）。
      // C5a-e M1：这次重取不是版本冲突判定（服务端没有拒绝任何请求），不该像 handleConflict 那样把
      // "此刻仍脏"的项一律标冲突——只有服务器这次真的把该项改成了不同于旧基线（重取前的 f.detail）的
      // 值时（别的操作者在采集期间真写了同一项），才是需要用户留意的真实冲突；本地脏但服务器值没变的
      // 项维持原样，下次autosave正常带出去即可，不打扰用户。
      try {
        const oldDetail = f.detail;
        if (f.accessLost) return; // codex 48 H-2：等待采集期间失权
        if (f.token !== getToken()) { rejectChangedIdentity(f, '采集后重取'); return; }
        const fresh = await sessionApi(f, '/inspections/sheets/' + f.id);
        const dirty = applyFreshMerge(f, fresh);
        const oldById = new Map(oldDetail.items.map(it => [it.id, it]));
        const freshById = new Map(fresh.items.map(it => [it.id, it]));
        let realConflict = false;
        for (const it of dirty.items) {
          const before = oldById.get(it.id), after = freshById.get(it.id);
          if (before && after && !sameWorkingItem(before, after)) {
            f.conflictIds.add(it.id); realConflict = true;
          }
        }
        if (dirty.remarkChanged && oldDetail.remark !== fresh.remark) { f.remarkConflict = true; realConflict = true; }
        if (realConflict) f.lastFlushOk = false;
        reconcileConflictMarkers(f); // 合并后本地恰好与新基线一致的项，立即清掉刚标上的冲突
      }
      catch (_e) { /* 重取详情失败：working/detail 保留原样（这一项的 device_inspection_id 落库已经
        成功，只是本地暂时没反映出来），下次保存或重新打开会更新 */ }
      let alertsCount = null;
      try { const snap = resp.inspection && resp.inspection.snapshot; if (snap && Array.isArray(snap.alerts)) alertsCount = snap.alerts.length; } catch (_e) { alertsCount = null; }
      if (formVisible(f)) L.toast(alertsCount === null ? '采集完成' : '采集完成 · 告警 ' + alertsCount + ' 项');
      // LOW（G5=A′）：会话不可见时的提示不再说"有修改未保存"——采集本身已经落库成功，这句话对一次
      // 纯粹的成功采集是误导性的（"未保存"暗示这条采集结果可能丢失，实际不会）。H1（C5a-f）：改走
      // notifyOutcome——若这张单在登记表里恰好还有别的未保存内容（与这次采集无关），末尾补一句指引。
      else notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉' + (alertsCount === null ? '已采集完成' : '已采集完成 · 告警 ' + alertsCount + ' 项'));
    } catch (error) {
      if (error.status === 401 && f.token !== getToken()) {
        registerUnsaved(f.id, sheetLabel(f), [{ key: 'action:collect:' + itemId, text: '采集结果未能确认' }], '登录状态已变化，结果未能确认', f.accountId);
        return;
      }
      // H1（C5a-f）：不再用"有修改未保存："作前缀——按结果直接说"采集失败"，登记表有条目时 notifyOutcome
      // 自己会追加指引后缀。N-M3（C5a-g）：短语走 mapFailureReason，不再拼 error.message 整句（预筛 Q5
      // 实测：网络失败会把共享层"请重新打开页面…"整句透出来）。
      if (formVisible(f)) L.notice('采集失败：' + mapFailureReason(error, 'collect'));
      else notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉采集失败：' + mapFailureReason(error, 'collect'));
    } finally {
      f.collecting.delete(itemId);
      if (formVisible(f)) renderForm(f); // 落定后解锁+重渲染（不管成功/失败）
      L.__inspCollectSettledByItem.set(itemId, (L.__inspCollectSettledByItem.get(itemId) || 0) + 1);
    }
  }
  function photoPositionLabel(f, slot, targetId) {
    if (slot === 'rack_front') return ((f.detail.scope.racks || []).find(r => r.id === targetId) || {}).name || '机柜 #' + targetId;
    const item = itemById(f, targetId);
    return item ? item.target_label + ' · ' + item.item_label : '检查项 #' + targetId;
  }
  function photoDuplicateWarning(duplicateOf) {
    if (!duplicateOf) return '';
    const messages = (duplicateOf.matches || []).map(m => {
      const status = m.sheet_deleted ? '所在单已删除' : m.photo_state === 'superseded' ? '已替换' : '有效';
      return '与巡检单 #' + m.sheet_id + '（' + dateOnly(m.at) + '，' + status + '）的照片完全相同，请确认是本次拍摄';
    });
    if (duplicateOf.restricted_match) messages.push('与一张你无权查看的巡检单中的照片相同');
    return messages.join('；');
  }
  function prunePhotoUrls(f) {
    const ids = new Set([...(f.detail.photos || []), ...(f.detail.my_pending_photos || [])].map(p => p.id));
    for (const [id, url] of f.photoOwner.urls) if (!ids.has(id)) { URL.revokeObjectURL(url); f.photoOwner.urls.delete(id); }
  }
  function photoMessage(f, key, value) {
    f.photoMessages.set(key, value);
    const el = document.querySelector('[data-photo-message="' + key + '"]');
    if (formVisible(f) && el) { el.textContent = value; el.className = value ? 'itl-form-error' : 'itl-muted'; }
  }
  function doUploadPhoto(f, slot, targetId, files) {
    if (!formVisible(f) || !f.detail.actions.includes('save') || isLocked(f)) return;
    const key = photoPosition(slot, targetId), label = photoPositionLabel(f, slot, targetId);
    if (f.conflictIds.size || f.remarkConflict) { photoMessage(f, key, '请先核对冲突项，再上传照片。'); return; }
    if (!Array.isArray(files)) files = [files];
    const capacity = 10 - effectivePhotosAt(f,slot,targetId).length;
    if (files.length > capacity) { photoMessage(f,key,'每个附件位置最多10张，还可添加 ' + Math.max(0,capacity) + ' 张；本批次未添加。'); return; }
    if (files.some(file=> !/\.(?:jpe?g|png|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) || !file.size || file.size > 20 * 1024 * 1024)) {
      photoMessage(f, key, '只收 JPG、PNG、WebP 图片，单张不超过 20 MiB。'); return;
    }
    photoMessage(f, key, ''); f.photoBusy = true; applyLockState(f);
    let uploaded = false, posting = false, uploadedCount = 0;
    const duplicateWarnings = new Set();
    // Claude 复核 M1 / 49 M-1：批次中途结束（换号/失权/失败）时，凡是没有确认成功的图片（未发出，或第
    // uploadedCount+1 张已发出但结果未知）都必须登记，不能静默丢弃；只有全部确认成功才不登记。
    const batchText = (currentUnknown) => {
      const notSent = files.length - uploadedCount - (currentUnknown ? 1 : 0);
      return '照片' + label + '：已上传 ' + uploadedCount + ' / ' + files.length + ' 张' + (currentUnknown ? '，第 ' + (uploadedCount + 1) + ' 张结果未能确认' : '') + (notSent ? '，其余 ' + notSent + ' 张未上传（文件内容未保留）' : '');
    };
    const registerBatchRemainder = (reason, currentUnknown = false) => {
      if (uploadedCount < files.length) registerUnsaved(f.id, sheetLabel(f), [{ key: 'photo:' + key, text: batchText(currentUnknown) }], reason, f.accountId);
    };
    enqueue(f.id, async () => {
      try {
        if (f.accessLost) throw Object.assign(new Error('访问权限已变化'), { status: 403 }); // 外审 H-2：不发请求，登记后由失权提示统一给出
        if (!f.submittedEdit && !(await performFlush(f))) throw Object.assign(new Error('表单修改未保存，照片未上传'), { code: 'LOCAL_FLUSH_FAILED' });
        if (f.accessLost) throw Object.assign(new Error('访问权限已变化'), { status: 403 }); // codex 48 H-2：冲刷等待期间失权
        if (f.token !== getToken()) {
          registerUnsaved(f.id, sheetLabel(f), [{ key: 'photo:' + key, text: (files.length > 1 ? files.length + ' 张' : '') + '照片未上传：' + label + '（文件内容未保留）' }], '登录状态已变化', f.accountId);
          return;
        }
        for (const file of files) {
        if (f.accessLost || f.token !== getToken()) throw Object.assign(new Error('登录状态或权限已变化'), {status: f.accessLost ? 403 : 401});
        const body = new FormData(); body.append('slot', slot); body.append('target_id', String(targetId)); body.append('file', file);
        posting = true;
        const response = await sessionApi(f, '/inspections/sheets/' + f.id + '/photos', { method: 'POST', body });
        uploaded = true;
        uploadedCount++; posting = false;
        if (f.token !== getToken()) { if (!f.submittedEdit) rejectChangedIdentity(f, '照片上传后重取'); registerBatchRemainder('登录状态已变化'); return; }
        if (f.accessLost) { registerBatchRemainder('编辑权限已变化'); return; } // codex 48 H-2：照片已落库，失权后不再重取
        const fresh = await sessionApi(f, '/inspections/sheets/' + f.id);
        mergeAfterPhotoWrite(f, fresh); prunePhotoUrls(f);
        const duplicateWarning = photoDuplicateWarning(response.duplicate_of);
        if (duplicateWarning) duplicateWarnings.add(duplicateWarning);
        f.photoMessage = [...duplicateWarnings].join('；');
        }
        photoMessage(f, key, '');
        if (files.length > 1 && formVisible(f)) L.toast('已添加 ' + uploadedCount + ' 张图片');
      } catch (error) {
        // 外审：失权结束的会话，冲刷失败抛出的 LOCAL_FLUSH_FAILED 也按失权记原因（原先落成「操作失败」）。
        // Claude 复核 M2 / 49 M-2、M-3：只有请求已发出而没拿到可信结果时才算「未能确认」——网络异常，或响应
        // 阶段换号（共享层 IDENTITY_CHANGED_IN_FLIGHT）。服务端明确拒绝（有状态码，含真 401 的 AUTH_REJECTED）、
        // 发送前拦截（sessionApi 的 SESSION_* 码、循环入口检查）都是确定失败。单张与批次同一口径。
        const currentUnknown = posting && (error.code === 'NETWORK' || error.code === 'IDENTITY_CHANGED_IN_FLIGHT');
        // 49 L-1：上传前表单冲刷失败时，真正的原因是「表单修改未保存」，不是泛化的「操作失败」。
        // 换号不是发生在上传请求上（如上传后重取），原因只说登录变化，不附「结果未能确认」。
        const reason = f.accessLost ? '编辑权限已变化'
          : error.code === 'LOCAL_FLUSH_FAILED' ? '表单修改未保存'
          : error.code === 'IDENTITY_CHANGED_IN_FLIGHT' && !currentUnknown ? '登录状态已变化'
          : mapFailureReason(error, 'photo');
        if (f.destroyed || f.token !== getToken()) {
          if (files.length > 1 && uploadedCount < files.length) registerBatchRemainder(reason, currentUnknown);
          else {
            // 单张，或批次已全部确认上传（只是之后的重取失败）。已确认上传的照片在已提交单里是本人待生效照片，
            // 重开可见，不登记；结果未知的一律登记（49 M-1：只有全部确认成功才允许跳过）。
            const text = uploaded ? '照片已上传，结果未能确认：' + label : currentUnknown ? '照片上传结果未能确认：' + label + '（请重新打开核对）' : '照片未上传：' + label + '（文件内容未保留）';
            if (!(f.submittedEdit && uploaded && uploadedCount === files.length)) registerUnsaved(f.id, sheetLabel(f), [{ key: 'photo:' + key, text }], reason, f.accountId);
          }
        } else {
          let text;
          if (!posting && uploadedCount === 0) text = (files.length > 1 ? '本批 ' + files.length + ' 张照片未上传：' : '照片未上传：') + reason;
          else if (files.length === 1) text = uploaded ? '照片已上传，但界面未能更新：' + reason : currentUnknown ? '照片上传结果未能确认，请重新打开核对：' + reason : '照片上传失败：' + reason;
          else {
            const notSent = files.length - uploadedCount - (posting ? 1 : 0);
            text = '已添加 ' + uploadedCount + ' / ' + files.length + ' 张；' + (posting ? '第 ' + (uploadedCount + 1) + ' 张' + (currentUnknown ? '上传结果未能确认，请重新打开核对' : '上传失败') : '界面未能更新') + '：' + reason + (notSent ? '；其余 ' + notSent + ' 张未上传' : '');
          }
          photoMessage(f, key, text);
        }
      } finally {
        f.photoBusy = false;
        if (formVisible(f)) renderForm(f);
        L.__inspPhotoUploadSettledByPosition.set(f.id + ':' + key, (L.__inspPhotoUploadSettledByPosition.get(f.id + ':' + key) || 0) + 1);
      }
    });
  }
  function doDeletePhoto(f, slot, targetId, photoId, undoRemoval = false) {
    if (!formVisible(f) || !f.detail.actions.includes('save') || isLocked(f)) return;
    const key = photoPosition(slot, targetId), label = photoPositionLabel(f, slot, targetId);
    if (f.conflictIds.size || f.remarkConflict) { photoMessage(f, key, '请先核对冲突项，再删除照片。'); return; }
    const allowed = [...(f.detail.photos || []), ...(f.submittedEdit ? f.detail.my_pending_photos || [] : [])];
    if (!allowed.some(p => p.id === photoId && p.slot === slot && p.target_id === targetId)) return;
    f.photoBusy = true; applyLockState(f);
    enqueue(f.id, async () => {
      let removed = false;
      try {
        if (f.accessLost) throw Object.assign(new Error('访问权限已变化'), { status: 403 }); // 外审 H-2
        if (!f.submittedEdit && !(await performFlush(f))) throw Object.assign(new Error('表单修改未保存，照片未删除'), { code: 'LOCAL_FLUSH_FAILED' });
        if (f.accessLost) throw Object.assign(new Error('访问权限已变化'), { status: 403 }); // codex 48 H-2
        // 外审 M-4：已提交单也登记——否则这次删除静默消失，下次选「继续使用」会把想删的照片一起保存。
        if (f.token !== getToken()) { if (f.submittedEdit) registerUnsaved(f.id, sheetLabel(f), [{ key: 'photo-delete:' + photoId, text: '待保存照片未删除：' + label }], '登录状态已变化', f.accountId); else rejectChangedIdentity(f, '照片删除'); return; }
        await sessionApi(f, '/inspections/sheets/' + f.id + '/photos/' + photoId, { method: 'DELETE', ...(undoRemoval ? {body:JSON.stringify({undo_removal:true})} : {}) });
        removed = true;
        if (f.token !== getToken()) { if (!f.submittedEdit) rejectChangedIdentity(f, '照片删除后重取'); return; }
        if (f.accessLost) return; // codex 48 H-2
        const fresh = await sessionApi(f, '/inspections/sheets/' + f.id);
        mergeAfterPhotoWrite(f, fresh); prunePhotoUrls(f); photoMessage(f, key, '');
      } catch (error) {
        if (formVisible(f)) photoMessage(f, key, (removed ? '照片已删除，但界面未能更新：' : '照片删除失败：') + mapFailureReason(error));
        else if (f.accessLost) { if (!removed) registerUnsaved(f.id, sheetLabel(f), [{ key: 'photo-delete:' + photoId, text: (f.submittedEdit ? '待保存照片未删除：' : '照片未删除：') + label }], '编辑权限已变化', f.accountId); }
        else if (f.token === getToken()) notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉照片删除失败：' + label + ' · ' + mapFailureReason(error));
      } finally {
        f.photoBusy = false;
        if (formVisible(f)) renderForm(f);
        L.__inspPhotoDeleteSettledByPosition.set(f.id + ':' + key, (L.__inspPhotoDeleteSettledByPosition.get(f.id + ':' + key) || 0) + 1);
      }
    });
  }
  function registerSubmittedDirty(f, reason) {
    const parts = unsavedPartsFor(f);
    if (parts.length) registerUnsaved(f.id, sheetLabel(f), parts, reason, f.accountId);
  }
  function doSaveEdit(f) {
    if (!f.submittedEdit || !formVisible(f) || isLocked(f)) return;
    f.incompleteDetail = null;
    f.savingEdit = true; applyLockState(f);
    enqueue(f.id, async () => {
      try {
        if (f.accessLost) return; // 外审 H-2：原文已由失权登记与提示接手
        if (f.token !== getToken()) { registerSubmittedDirty(f, '登录状态已变化'); return; }
        const dirty = computeDirty(f), body = { expected_version: f.detail.version };
        if (dirty.items.length) body.items = dirty.items;
        if (dirty.remarkChanged) body.remark = f.remarkWorking;
        const response = await sessionApi(f, '/inspections/sheets/' + f.id, { method: 'PUT', body: JSON.stringify(body) });
        f.detail = response; f.lastFlushOk = true;
        reconcileUnsavedAfterSave(f, dirty.items, dirty.remarkChanged);
        if (!formVisible(f)) return;
        closeForm(); enterMode('detail'); detailId = response.id; renderDetailView(response); L.toast('修改已保存，操作记录已更新');
      } catch (error) {
        if (error.status === 401 && f.token !== getToken()) {
          registerSubmittedDirty(f, '登录状态已变化，结果未能确认');
        } else if (error.code === 'SHEET_VERSION_CONFLICT') {
          if (f.destroyed) return;
          await handleConflict(f);
          if (formVisible(f)) { f.lastFlushOk = false; L.notice('这张单已在别处被修改，你的改动仍在，请核对后再保存'); }
        } else if (formVisible(f)) {
          if (error.status === 400 && error.code === 'SHEET_INCOMPLETE') { f.incompleteDetail = error.detail || error; L.notice('检查项未填写完整：' + describeIncomplete(f.incompleteDetail)); }
          else L.notice('保存修改失败：' + mapFailureReason(error));
        }
      } finally {
        f.savingEdit = false;
        if (formVisible(f)) { renderForm(f); if (f.incompleteDetail) highlightIncomplete(f.incompleteDetail); }
        L.__inspEditSaveSettledBySheet.set(f.id, (L.__inspEditSaveSettledBySheet.get(f.id) || 0) + 1);
      }
    });
  }
  // 外审 M-1（用户 09-26 裁 A）：残留提示里的「丢弃」只逐张删进入编辑时冻结的残留照片（按 id，经单张
  // 删除接口），本次会话新传的照片不受影响；「放弃修改」（leaveAfter）仍整批丢弃本人全部待生效照片。
  function leftoverPendingPhotos(f) { return [...(f.detail.my_pending_photos || []).filter(p => f.leftoverPendingIds.has(p.id)), ...(f.detail.photos || []).filter(p=>f.leftoverRemovalIds.has(p.id)&&(f.detail.my_removed_photo_ids || []).includes(p.id)).map(p=>({...p,removal:true}))]; }
  function doDiscardPending(f, leaveAfter) {
    if (!f.submittedEdit || !formVisible(f) || isLocked(f)) return;
    const leftoverIds = leaveAfter ? null : leftoverPendingPhotos(f).map(p => p.id);
    const leftoverRemovals = new Set(leaveAfter ? [] : leftoverPendingPhotos(f).filter(p=>p.removal).map(p=>p.id));
    f.discardingPending = true; applyLockState(f);
    enqueue(f.id, async () => {
      let discarded = false;
      let inFlightId = null; // codex 48-R M2：已发出、尚未拿到结果的那一次删除（整批路径记 -1）
      const deletedIds = []; // codex 48 M-1：逐张丢弃已确认删除的，中途失败 / 换号时据此如实描述「部分已丢弃」
      // codex 48-R2 M1/M2：换号时的进度登记收拢一处，各 catch 与循环入口都走它。删除已全部完成（discarded）
      // 就没有未保存内容，不登记（下次打开以服务端为准）；否则按 已丢弃 / 结果未能确认 / 余下未丢弃 三段登记到原账号。
      const recordIdentityChange = () => {
        if (discarded) return;
        const uncertain = inFlightId !== null;
        let text;
        if (leaveAfter) text = uncertain ? '放弃修改结果未能确认' : '放弃修改请求未发出';
        else if (!deletedIds.length && !uncertain) text = '丢弃上次未保存照片的请求未发出';
        else text = '丢弃上次未保存照片未完成：已丢弃 ' + deletedIds.length + ' 张' + (uncertain ? '，1 张结果未能确认' : '') + '，余 ' + (leftoverIds.length - deletedIds.length - (uncertain ? 1 : 0)) + ' 张未丢弃';
        registerUnsaved(f.id, sheetLabel(f), [{ key: 'action:discard-pending', text }], uncertain ? '登录状态已变化，结果未能确认' : '登录状态已变化', f.accountId);
      };
      try {
        if (f.accessLost) return; // 外审 H-2
        if (f.token !== getToken()) { recordIdentityChange(); return; }
        if (leaveAfter) { inFlightId = -1; await sessionApi(f, '/inspections/sheets/' + f.id + '/pending-photos', { method: 'DELETE' }); inFlightId = null; }
        else {
          for (const photoId of leftoverIds) {
            if (f.accessLost) return; // codex 48 H-2：上一张删除等待期间失权
            if (f.token !== getToken()) { recordIdentityChange(); return; }
            inFlightId = photoId;
            try { await sessionApi(f, '/inspections/sheets/' + f.id + '/photos/' + photoId, { method: 'DELETE', ...(leftoverRemovals.has(photoId) ? {body:JSON.stringify({undo_removal:true})} : {}) }); }
            catch (error) { if (error.code !== 'SHEET_PHOTO_NOT_FOUND') throw error; } // 已不在（被替换或别处丢弃）即达成目的
            deletedIds.push(photoId); inFlightId = null;
            // codex 48-R M1：已确认删除的立即从本地待生效列表移除——即使之后的校准重取失败，界面也不再显示它。
            f.detail.my_pending_photos = (f.detail.my_pending_photos || []).filter(p => p.id !== photoId); prunePhotoUrls(f);
            f.detail.my_removed_photo_ids = (f.detail.my_removed_photo_ids || []).filter(id=>id!==photoId);
          }
        }
        discarded = true;
        if (f.accessLost || f.token !== getToken()) return; // codex 48-R H1：最后一张删除等待期间失权 / 换号
        const fresh = await sessionApi(f, '/inspections/sheets/' + f.id);
        if (!formVisible(f)) return;
        f.pendingDecision = false;
        if (leaveAfter) { closeForm(); enterMode('detail'); detailId = fresh.id; renderDetailView(fresh); L.toast('已放弃修改'); }
        else { mergeAfterPhotoWrite(f, fresh); prunePhotoUrls(f); }
      } catch (error) {
        if (error.status === 401 && f.token !== getToken()) recordIdentityChange(); // codex 48-R M2：请求等待期间换号
        else if (formVisible(f) && !leaveAfter && !discarded && deletedIds.length) {
          inFlightId = null; // 这一张的结果已知（失败），不再算「未能确认」
          // codex 48 M-1：部分已删——重取一次校准界面（残留计数与缩略图），失败则保持原样，提示里如实写进度。
          try { const fresh = await sessionApi(f, '/inspections/sheets/' + f.id); if (formVisible(f)) { mergeAfterPhotoWrite(f, fresh); prunePhotoUrls(f); } }
          catch (e) { if (e.status === 401 && f.token !== getToken()) recordIdentityChange(); } // codex 48-R2 M1：校准等待中换号也要登记进度；其余失败仅放弃校准
          if (formVisible(f)) L.notice('未能丢弃全部待保存照片（已丢弃 ' + deletedIds.length + ' 张，余 ' + (leftoverIds.length - deletedIds.length) + ' 张）：' + mapFailureReason(error));
        } else if (formVisible(f)) L.notice((discarded ? '待保存照片已丢弃，但界面未能更新：' : '未能丢弃待保存照片：') + mapFailureReason(error));
        else if (f.token === getToken() && !f.accessLost) notifyOutcome(f, '巡检单〈' + sheetLabel(f) + '〉丢弃待保存照片失败：' + mapFailureReason(error));
      } finally {
        f.discardingPending = false;
        if (formVisible(f)) renderForm(f);
        L.__inspPendingDiscardSettledBySheet.set(f.id, (L.__inspPendingDiscardSettledBySheet.get(f.id) || 0) + 1);
      }
    });
  }
  function doDiscardEdit(f) { doDiscardPending(f, true); }
  async function openSubmittedEdit(detail) {
    if (detail.status !== 'submitted' || !detail.actions.includes('save')) return;
    const id = detail.id, seq = ++sequence;
    try {
      await queueIdle(id);
      if (seq !== sequence || mode !== 'detail' || detailId !== id || L.state.tab !== 'inspections') return;
      const fresh = await L.api('/inspections/sheets/' + id);
      if (seq !== sequence || mode !== 'detail' || detailId !== id || L.state.tab !== 'inspections') return;
      if (fresh.status !== 'submitted' || !fresh.actions.includes('save')) { L.notice('这张单当前不能编辑'); return; }
      openForm(fresh);
    } catch (error) { if (seq === sequence && L.state.tab === 'inspections') L.notice('无法编辑巡检单：' + mapFailureReason(error)); }
  }
  async function openSubmittedEditById(id) {
    if (L.state.tab !== 'inspections') return;
    if (form && !form.destroyed) leaveForm(form);
    const seq = ++sequence;
    enterMode('list'); detailId = null;
    const marker = document.createElement('div'); marker.className = 'itl-empty'; marker.textContent = '正在读取巡检单…';
    $('#itlContent').replaceChildren(marker);
    const active = () => seq === sequence && L.state.tab === 'inspections' && marker.isConnected;
    try {
      await queueIdle(id);
      if (!active()) return;
      const fresh = await L.api('/inspections/sheets/' + id);
      if (!active()) return;
      if (fresh.status !== 'submitted' || !fresh.actions.includes('save')) { L.notice('这张单当前不能编辑'); load(); return; }
      openForm(fresh);
    } catch (error) { if (active()) { L.notice('无法编辑巡检单：' + mapFailureReason(error)); load(); } }
    finally { L.__inspLoadSettled++; }
  }
  function confirmUnarchive(row) {
    if (!row.actions.includes('unarchive')) return;
    const token = getToken(), requestMode = mode, requestGen = viewGen;
    L.openModal('撤回归档', `<p>将 ${esc(row.room_name)} · ${esc(dateOnly(row.created_at))} 的巡检单撤回到「已提交」。</p><label>撤回原因（必填）<textarea id="itlUnarchiveReason" name="reason" maxlength="2000" rows="3" required></textarea></label>`, async () => {
      const reason = ($('#itlUnarchiveReason')?.value || '').trim();
      if (!reason) throw new Error('请填写撤回原因');
      const modalToken = L.currentModalToken();
      try {
        const done = await enqueue(row.id, async () => {
          if (token !== getToken()) return false;
          await L.api('/inspections/sheets/' + row.id + '/unarchive', { method: 'POST', body: JSON.stringify({ expected_version: row.version, reason }) });
          return true;
        });
        if (!done) return;
      } catch (error) { if (token !== getToken()) return; throw error; }
      if (modalToken === L.currentModalToken()) L.closeModal(true);
      L.toast('巡检单已撤回归档');
      if (modalToken === L.currentModalToken() && L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen) {
        if (mode === 'detail' && detailId === row.id) openDetail(row.id); else load();
      }
    }, '确认撤回');
  }
  // M2：删除草稿也走该单的写队列——先冲刷（若有打开的表单会话，用它当前的 working/version；若冲刷
  // 失败则中止删除，提示"有未保存的修改，已取消删除"，不把还没真正落盘的修改连同整张单一起扔掉）；
  // 删除任务本身入队执行，真正发请求时才读版本号（有表单会话就用它冲刷后的最新 version；没有则重新
  // GET 一次，比"用点击那一刻捕获的旧行版本号"更准，减少不必要的 409）。C5a-d：①activeForm 存在时用
  // f.deleting 覆盖"冲刷+删除"整段窗口（同 doSubmit 的模式），冲刷失败时解锁并保留本地修改，不销毁
  // 会话；②S-M1（43S M1）：成功之后是否 load() 刷新列表，核对发起弹窗时的 mode/viewGen 快照，等待
  // 期间用户已经切到别的子视图就只提示、不强行把列表画回来。
  function confirmDeleteSubmitted(detail) {
    if (detail.status !== 'submitted' || !detail.actions.includes('delete')) return;
    const id = detail.id, requestToken = getToken(), requestAccountId = currentAccountId(), requestMode = mode, requestGen = viewGen;
    L.openModal('删除已提交巡检单', `<p>删除 ${esc(detail.room_name)} · ${esc(dateOnly(detail.created_at))} 的巡检单？删除后会保留操作记录，管理员可恢复。</p><label>删除原因（必填）<textarea id="itlSheetDeleteReason" name="reason" maxlength="2000" rows="3" required></textarea></label>`, async () => {
      const reason = ($('#itlSheetDeleteReason')?.value || '').trim();
      if (!reason) throw new Error('请填写删除原因');
      const modalToken = L.currentModalToken();
      try {
        const deleted = await enqueue(id, async () => {
          if (requestToken !== getToken()) {
            registerUnsaved(id, detail.room_name + ' · ' + dateOnly(detail.created_at), [{ key: 'action:delete', text: '删除请求未发出' }], '登录状态已变化', requestAccountId);
            return false;
          }
          await L.api('/inspections/sheets/' + id, { method: 'DELETE', body: JSON.stringify({ expected_version: detail.version, reason }) });
          return true;
        });
        if (!deleted) return;
      } catch (error) { if (requestToken !== getToken()) return; throw error; }
      if (modalToken === L.currentModalToken()) L.closeModal(true);
      L.toast('巡检单已删除，操作记录已保留');
      if (L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen) { detailId = null; load(); }
    }, '确认删除');
  }
  function confirmDeleteDraftRow(row) {
    const requestMode = mode, requestGen = viewGen;
    const requestToken = getToken(), requestAccountId = currentAccountId();
    const stillSameSubview = () => L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen;
    L.openModal('删除草稿', `<p>删除 ${esc(row.room_name)} · ${esc(time(row.created_at))} 的草稿？草稿删除后不保留，照片一并删除。</p>`, async () => {
      const myModalToken = L.currentModalToken();
      const activeForm = (form && form.id === row.id && !form.destroyed) ? form : null;
      const reportIdentityChange = (uncertain = false) => {
        if (activeForm) rejectChangedIdentity(activeForm, '删除', uncertain);
        else registerUnsaved(row.id, row.room_name + ' · ' + dateOnly(row.created_at), [{ key: 'action:delete', text: '删除草稿请求未发出' }], uncertain ? '登录状态已变化，结果未能确认' : '登录状态已变化', requestAccountId);
        return false;
      };
      if (activeForm) {
        // 不需要先判 isLocked 再拒绝——deleting 与 flushing/submitting/collecting 是各自独立的标志，
        // OR 起来才是 isLocked(f)；这里直接把 deleting 置位即可与"此刻可能已经在跑的其它在途操作"
        // 一起让 isLocked(f) 继续为真，不会出现中间态的假解锁。真正的执行顺序交给同一条队列的 FIFO
        // 保证——下面 enqueue 的冲刷任务，如果这张单已经有一次冲刷在跑，自然排在它后面才执行。
        activeForm.deleting = true;
        clearTimeout(activeForm.timer);
        if (formVisible(activeForm)) renderForm(activeForm); // 锁表单
        const flushOk = await enqueue(row.id, () => performFlush(activeForm));
        if (!flushOk) {
          activeForm.deleting = false;
          if (formVisible(activeForm)) renderForm(activeForm); // 解锁，本地修改原样保留
          if (myModalToken === L.currentModalToken()) L.closeModal(true);
          if (requestToken === getToken() && !activeForm.accessLost) L.notice('有未保存的修改，已取消删除');
          L.__inspDeleteSettledBySheet.set(row.id, (L.__inspDeleteSettledBySheet.get(row.id) || 0) + 1); // codex 48 M-2：这条提前返回也给完成信号
          return;
        }
      }
      // H4（Opus 预筛必修）：DELETE 本身失败（abort/500/409 等）之前，activeForm.deleting 只在成功路径
      // 才会被清掉——异常会直接冒出这个 async 回调，冒泡给 openModal 框架的 try/catch，但 deleting 标志
      // 永远留在 true，整张表单从此恒被 isLocked(f) 锁死。try/finally 保证不管这次 DELETE 成功还是失败，
      // deleting 都会被清掉并触发一次重渲染；异常本身继续原样冒泡（不在这里吞掉），交给模态框框架处理。
      try {
        const reqApi = activeForm ? (path, options) => sessionApi(activeForm, path, options) : L.api; // codex 48-R H1：有表单会话时经会话包装
        const deleted = await enqueue(row.id, async () => {
          if (requestToken !== getToken()) return reportIdentityChange();
          if (activeForm && activeForm.accessLost) return false; // 外审 H-2
          const version = activeForm ? activeForm.detail.version : (await reqApi('/inspections/sheets/' + row.id)).version;
          if (requestToken !== getToken()) return reportIdentityChange();
          if (activeForm && activeForm.accessLost) return false; // codex 48 H-2
          await reqApi('/inspections/sheets/' + row.id, { method: 'DELETE', body: JSON.stringify({ expected_version: version }) });
          return true;
        });
        if (!deleted) return;
      } catch (error) {
        if (requestToken !== getToken()) { reportIdentityChange(true); return; }
        throw error;
      } finally {
        if (activeForm) { activeForm.deleting = false; if (formVisible(activeForm)) renderForm(activeForm); }
        L.__inspDeleteSettledBySheet.set(row.id, (L.__inspDeleteSettledBySheet.get(row.id) || 0) + 1);
      }
      if (myModalToken === L.currentModalToken()) L.closeModal(true);
      L.toast('草稿已删除');
      if (form && form.id === row.id) closeForm();
      // N-L3（C5a-g）：单删掉了，登记表条目不删（用户可能还没点过"知道了"，删单不等于确认看到过/找回
      // 过丢失的内容）——只标记"该单已删除"，常驻条渲染时改措辞，不再说"重新打开该单补填"（单都没了）。
      markUnsavedDeleted(row.id);
      if (stillSameSubview()) load(); else L.__inspLoadSettled++;
    }, '删除草稿');
  }
  function confirmDeleteDraft(f) { confirmDeleteDraftRow({ id: f.id, version: f.detail.version, room_name: f.detail.room_name, created_at: f.detail.created_at }); }

  // C5a-e H2（G5=A′必做1）：切到/重新打开一个表单前，若已经有一个尚未结束的会话——用 leaveForm 正常
  // 收尾（同真正的"离开"动作一样：有未保存修改就排一次离开冲刷），不再像旧版那样只置 destroyed 静默
  // 丢弃本地编辑（这是 43S H2 只堵住一半的另一半成因：openDraftById 之外的入口——openInspectionSheet/
  // offerExistingDraft/openNewSheetModal/打开其它草稿——都会经过这里）。同一张单（form.id===detail.id）
  // 也走同一条路径：不做"同一张单就特殊复用旧working"的分支，统一由调用方（现在都已经先 queueIdle 过，
  // 见 fetchSheetForOpen）保证传进来的 detail 是这张单队列落定之后的最新值。L1+L2（C5a-f）：四个入口
  // 现在都已经在各自发起 fetchSheetForOpen/POST 之前提前做过这个判定（为了让"同一张单"场景下离开冲刷
  // 排在 queueIdle 之前），这里这句在正常路径下是重复的——按纵深防御原则保留，不依赖"外层一定已经做过"
  // 这个假设（同本文件其它地方的一贯做法）。
  function openForm(detail) {
    if (L.state.tab !== 'inspections') return;
    if (form && !form.destroyed) leaveForm(form);
    enterMode('form');
    detailId = detail.id;
    form = makeForm(detail.id, detail);
    renderForm(form);
  }
  function closeForm() { if (form) { form.destroyed = true; releasePhotoOwner(form.photoOwner); } form = null; detailId = null; }
  // 排一个空任务进某单的写队列并 await 它——FIFO 保证它排在"此刻已经在队列里的全部任务"之后执行，
  // 等它 resolve 就等于等到了"此刻已排队的操作全部落定"（不含之后才排的新任务）。C5a-e：每一个"打开
  // 某张单"的入口都在真正发起 GET 之前调用它（经 fetchSheetForOpen），保证读到的是这张单的写队列
  // （可能是离开时排的"离开冲刷"，也可能是别的还在跑的冲刷/提交/删除）落定之后的服务器值，不会被迟到
  // 的后台写请求用旧值覆盖刚重新打开就看到的内容。
  function queueIdle(sheetId) {
    const q = queuesBySheetId.get(sheetId);
    if (!q || (!q.queue.length && !q.queueRunning)) return Promise.resolve();
    return enqueue(sheetId, () => {});
  }
  // C5a-e（G5=A′用户裁定）：离开（返回列表 / 切页签）时同步结束这个表单会话——不再像 C5a-d 那样"冲刷
  // 成功才销毁、失败则保留会话与本地修改、下次重开时识别并复用"。那一整套机制正是本批要连根拔掉的
  // 对象（43S H1/H2/H3 三个 HIGH 全部源自它）：无论后续排的这次冲刷最终成不成功，用户离开的那一刻这
  // 个会话就已经结束，重开同一张单一律走全新 GET（openDraftById 已不再有复用分支）。有未保存的修改
  // 时仍然要尝试把它存下去——排一次"离开冲刷"进这张单的写队列（fire-and-forget，不 await，不阻塞
  // 导航本身，同旧版设计）；performFlush(f,{excludeConflicts:true}) 的 excludeConflicts 见其头部注释
  // （M2：已经带着冲突标记的项/备注不在这次请求体里发出去，不用本地值覆盖对方还没被核对过的修改）。
  // 冲刷若最终失败，performFlush 的 catch 会看到 f.destroyed 为真，走 notifyLeaveFlushFailure 给一条
  // 常驻提示，不会再有"重开这张单就能找回本地修改"这回事——提示本身就是"找回"的手段。
  function leaveForm(f) {
    f.left = true;
    f.destroyed = true;
    clearTimeout(f.timer);
    releasePhotoOwner(f.photoOwner);
    if (form === f) { form = null; detailId = null; }
    if (f.submittedEdit) {
      const parts = unsavedPartsFor(f);
      if (parts.length) notifyUnsavedResult(f, parts, '已提交单的修改未保存');
      return; // pending 照片留在服务端，下次进入编辑时再决定继续使用或丢弃
    }
    if (hasUnsavedWork(f)) enqueue(f.id, () => performFlush(f, { excludeConflicts: true }));
  }
  function backToListFromForm(f) { leaveForm(f); load(); }
  function onLeave() { filters.period = '90'; filters.search = ''; overviewData = null; overviewError = null; if (form && !form.destroyed) leaveForm(form); releasePhotoOwner(detailPhotoOwner); detailPhotoOwner = null; }
  // C5a-e：每个"打开某张单"的入口在发起 GET 之前统一先 queueIdle(id)——抽成一个共用助手，避免四个
  // 入口各自散着写一遍同样的顺序（openDraftByIdFresh 经这里；openInspectionSheet/offerExistingDraft
  // 直接调用 queueIdle 自己组装，因为它们各自的后续分支不同，不适合套同一个返回值形状，但等待逻辑
  // 完全一致）。
  // N-M1（C5a-g，预筛 MED）：占位不走共享层 #itlNotice——C5a-f 版本走 L.notice('正在等待上次保存完成…')
  // 再 L.notice('') 清空，预筛 Q1/Q4 实测出两个真实坏处：①Q1，占位落定时无条件 L.notice('') 会把中途
  // 已经落地的别的提示（比如同一张单已销毁会话的"未能提交"）一并清空，用户以为提交成功了，服务端其实
  // 仍是 draft；②Q4，等待期间切到别的页签（比如机柜），占位残留在机柜视图的 #itlNotice 上，与当前页
  // 签毫无关系。改法：占位放巡检视图自己持有的容器 #itlInspWaitPlaceholder（renderList 渲染进列表模板，
  // 同 #itlUnsavedList 一个位置），不调用 L.notice 也不调用 L.notice('')——切到别的页签时 #itlContent
  // 被别的视图自己的 render 整体替换掉，占位元素随之消失，不需要专门清理；等待结束时找不到这个元素
  // （已经不在文档里）就什么都不做，不会报错。
  function showInspWaitPlaceholder() {
    const el = $('#itlInspWaitPlaceholder');
    if (el) { el.hidden = false; el.textContent = '正在等待上次保存完成…'; }
  }
  function hideInspWaitPlaceholder() {
    const el = $('#itlInspWaitPlaceholder');
    if (el) el.hidden = true;
  }
  // C5a-e：每个"打开某张单"的入口在发起 GET 之前统一先 queueIdle(id)——抽成一个共用助手，避免四个
  // 入口各自散着写一遍同样的顺序（openDraftByIdFresh 经这里；openInspectionSheet/offerExistingDraft
  // 直接调用 queueIdle 自己组装，因为它们各自的后续分支不同，不适合套同一个返回值形状，但等待逻辑
  // 完全一致）。
  function fetchSheetForOpen(id) {
    const q = queuesBySheetId.get(id);
    const waiting = !!(q && (q.queue.length || q.queueRunning));
    if (waiting) showInspWaitPlaceholder();
    return queueIdle(id).then(() => { if (waiting) hideInspWaitPlaceholder(); return L.api('/inspections/sheets/' + id); });
  }
  async function openDraftByIdFresh(id, seq) {
    // L1+L2（C5a-f）：仍开着的旧会话（不管接下来是走可写表单还是只读详情）先正常收尾——同真正的"离开"
    // 一样，有未保存修改就排一次离开冲刷。这样如果这张单恰好就是当前打开的那个会话，它的离开冲刷会排
    // 在下面 fetchSheetForOpen 内部的 queueIdle 之前，重开时才能等到冲刷落定之后的值（不再只靠 openForm
    // 内部才做这个判定——那时 GET 已经发出，太晚了，见 L1 原句）。也堵住旧会话的计时器在导航去只读详情
    // 之后仍把 renderForm 画回来的可能（L2：这条"无 save 分支"此前完全不调 leaveForm）。
    if (form && !form.destroyed) leaveForm(form);
    try {
      const detail = await fetchSheetForOpen(id);
      if (seq !== sequence || L.state.tab !== 'inspections') { L.__inspLoadSettled++; return; }
      // H4：即使调用方（行点击委托）已经按列表缓存的 actions.includes('save') 过滤过，这里用刚拿到的
      // 服务器最新 actions 再核一次——列表数据和权限可能已经不同步（巡检人在列表刷新之后才被降级为
      // 只读）。没有 save 就不进可写表单，改走只读详情（同一条判据的纵深防御，不依赖"调用方已经挡住"
      // 这个假设——H4 的教训正是"以前完全没有任何一层核过这件事"）。
      if (!detail.actions.includes('save')) { L.__inspLoadSettled++; openDetail(id); return; }
      openForm(detail);
      L.__inspLoadSettled++;
    } catch (error) {
      L.__inspLoadSettled++;
      if (seq === sequence && L.state.tab === 'inspections') L.toast('无法打开该草稿：' + mapFailureReason(error));
    }
  }
  // C5a-e（G5=A′）：不再有"这张单是不是正在保留的那个会话"这一支判断——复用分支随"保留会话"机制一起
  // 删除，一律走全新 GET（内部已经先 queueIdle 等这张单的队列落定，见 openDraftByIdFresh）。
  async function openDraftById(id) {
    if (L.state.tab !== 'inspections') return;
    return openDraftByIdFresh(id, ++sequence);
  }
  function openNewSheetModal() {
    const roomsAvailable = availableRoomsForNewSheet();
    const requestMode = mode, requestGen = viewGen;
    const body = roomsAvailable.length
      ? `<label class="itl-field">选择机房<select name="room_name">${roomsAvailable.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></label>`
      : `<p class="itl-muted">没有已登记机柜的机房，无法新增巡检单。</p>`;
    // S-M1（43S M1）：POST/GET 等待期间用户可能已经离开了这个子视图——发起时先记快照，等待落地后核对，
    // 不匹配只提示结果，不强行把用户拉回来打开表单。
    L.openModal('新增巡检', body, async formEl => {
      if (!roomsAvailable.length) { L.closeModal(true); return; }
      const roomName = formEl.elements.room_name.value;
      const myModalToken = L.currentModalToken();
      const stillSameSubview = () => L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen;
      // L1+L2（C5a-f）：同其余入口——先收尾仍开着的旧会话，不等 openForm 内部稍后才做这个判定（这里虽然
      // 不涉及 queueIdle，新单是全新创建的，不会与任何现有队列同一个 sheetId，但统一在入口最前面处理，
      // 行为与其它三个入口一致，旧会话的离开冲刷从 POST 发起前就开始排队，而不是等到 POST 成功之后）。
      if (form && !form.destroyed) leaveForm(form);
      try {
        const detail = await L.api('/inspections/sheets', { method: 'POST', body: JSON.stringify({ room_name: roomName }) });
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        // C6-d M1（44R复检"未统一失效标记"）：这条成功路径此前只靠 mode/viewGen 快照（stillSameSubview）
        // 守卫，从不推进 sequence——跨页入口 openInspectionSheet 的 GET 若恰好在此刻还悬着，它稍后核对
        // seq!==sequence 时会看不出"其实已经有别的入口改变了当前显示的单据"，可能用迟到的响应把这里刚
        // 创建并打开的新草稿覆盖掉。推进 sequence 是本批要求的"所有改变当前显示单据的入口统一失效标记"
        // 的落地点之一（另一处见 offerExistingDraft）。
        if (stillSameSubview()) { ++sequence; openForm(detail); }
        else L.toast('已创建巡检单〈' + roomName + '〉，可在巡检台账列表打开继续填写');
      } catch (error) {
        if (error.status === 409 && error.code === 'SHEET_DRAFT_EXISTS') { offerExistingDraft(error.detail && error.detail.draft, roomName, requestMode, requestGen); return; }
        throw error;
      }
    }, roomsAvailable.length ? '创建' : '关闭');
  }
  // 已存在草稿（409 SHEET_DRAFT_EXISTS）：始终提供"打开该草稿"，不预判可见性——他人不可见的草稿会在
  // GET 时收到 404，走下面的 catch 分支优雅降级为提示，效果等价于"仅当自己可见时才提供"，不需要额外
  // 猜测调用者是不是巡检人本人（自决点，见交付报告）。S-M1：requestMode/requestGen 由调用方
  // （openNewSheetModal）传入的是"打开新增巡检弹窗那一刻"的快照——这次弹窗本身是那次操作的延续，不重
  // 新采一次（重新采会把"用户在两个弹窗之间已经切走"这个真正要防的窗口漏掉一段）。
  function offerExistingDraft(draft, roomName, requestMode, requestGen) {
    if (!draft) { L.notice(roomName + ' 已有一张草稿，但无法读取详情。'); return; }
    const stillSameSubview = () => L.state.tab === 'inspections' && mode === requestMode && viewGen === requestGen;
    L.openModal('该机房已有草稿', `<p>${esc(roomName)} 已有一张草稿（巡检人 ${esc(draft.created_by_name || '未知')}，开始于 ${esc(time(draft.created_at))}）。</p>`, async () => {
      const myModalToken = L.currentModalToken();
      // L1+L2（C5a-f）：同 openDraftByIdFresh——先收尾仍开着的旧会话，排在下面 fetchSheetForOpen 的
      // queueIdle 之前。
      if (form && !form.destroyed) leaveForm(form);
      try {
        // C5a-e：打开前先等这张单的写队列落定（同 openDraftByIdFresh 的 fetchSheetForOpen）——万一这张
        // 已存在的草稿此刻正带着一个离开冲刷/其它在途写请求，拿到的要是落定之后的最新值。
        const detail = await fetchSheetForOpen(draft.id);
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        // C6-d M1：同 openNewSheetModal——这条成功路径此前不推进 sequence，是"统一失效标记"要补的另一
        // 半（见该函数头部注释）。
        if (stillSameSubview()) { ++sequence; openForm(detail); }
        else L.toast('已打开该草稿：可在巡检台账列表继续填写');
      } catch (error) {
        if (myModalToken === L.currentModalToken()) L.closeModal(true);
        L.notice('无法打开该草稿：' + mapFailureReason(error));
      }
    }, '打开该草稿');
  }
  // beforeunload：队列非空/仍在跑，或已有未落盘的本地修改（含在途中/冲突残留/上一轮未成功）时提示
  // 离开确认（方案 §6.1 末条）。M8：队列现在按单据 id 建（queuesBySheetId），不挂在表单会话对象上——
  // 任何单据（包括当前没有打开表单会话、只是删除草稿排了任务的那些）只要还有未完成的队列，都要拦
  // 这次离开，不能只看"当前表单"这一个。C5a-d：判据从单点的 form.saving 换成 hasUnsavedWork(form) ||
  // isLocked(form)（涵盖在途中/冲突残留/上一轮冲刷未成功这几类都算"有东西可能丢"，不只是"正在保存"
  // 这一种瞬时状态）。
  window.addEventListener('beforeunload', e => {
    let dirty = false;
    if (form && !form.destroyed) { dirty = hasUnsavedWork(form) || isLocked(form); }
    // C5a-f（H1+H2）：登记表非空也要拦——那是"上一次离开就已经没保存上"的内容，用户还没点"知道了"确认
    // 看到过，跟"当前会话/队列还有东西没落盘"是同一类"这次真离开会丢东西"的风险，判据一并列进来。
    // N-H1（C5a-g）：只认属于当前账号的条目——不能替一个已经不是"当前登录用户"的账号的残留内容拦下这次
    // 离开（预筛 Q3：换号后 beforeunloadBlocked 仍是 true，等于新账号莫名其妙被拦住，且这个判断本身就
    // 暗示了"这个浏览器还记得别的账号有未保存内容"这件事）。
    const accountId = currentAccountId();
    const hasCurrentAccountUnsaved = accountId !== null && [...unsavedByAccountSheet.values()].some(entry => entry.accountId === accountId);
    if (dirty || queuesBySheetId.size > 0 || hasCurrentAccountUnsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  // ============================================================
  // 入口 / 事件委托
  // ============================================================
  function render() {
    if (mode === 'deleted') return loadDeleted();
    if (mode === 'detail' && detailId !== null) return openDetail(detailId);
    // C5a-e（G5=A′必做1"纵深防御"）：额外判 !form.destroyed——按当前不变式这应该恒与 form 是否为 null
    // 等价（leaveForm/openForm/closeForm 每次让 form 指向别处都会同步销毁旧会话），显式写出来防的是
    // "以后有调用方绕开这几个函数直接改 form 变量"这种未来变化，成本很低。
    if (mode === 'form') return (form && !form.destroyed) ? renderForm(form) : load();
    return load();
  }
  // C6-b H1（spec-C6-b.md 第12条）：跨页跳转入口——服务器详情「设备巡检」历史里点"见巡检单 #N"
  // 走这里。先关抽屉、切到巡检页签（setTab 本身也会关抽屉，这里显式调一次是遵照派单顺序，不依赖
  // 这个内部实现细节），再单独 GET 一次详情判断该开草稿填写页还是详情——不能只看 actions.includes
  // ('save')：已提交单也有 save 动作，但跨页入口先到详情，再由用户点击"编辑"进入显式保存模式。
  // 失败（网络异常/该单在此刻
  // 之前已被删除等）不在这里自己处理 404/错误 UI，直接调 openDetail(id)——它会自己重新发起 GET 并走
  // 既有的404回列表/其它错误留错误提示两条路径，不重复维护一份。
  // C6-c 44S H1（codex 44 审查修复）：catch 分支此前无条件调用 openDetail(id)——用户若在这次 GET
  // 挂起期间又点开了另一张单（本函数被再次调用，sequence 前进），迟到的失败响应仍会调用
  // openDetail(id)，其内部 enterMode('detail')/detailId=id/container.replaceChildren(marker) 这段
  // 同步前缀不依赖任何守卫，会立刻把用户已经在看的另一张单（表单/详情）整块替换掉。这里补上与 try
  // 分支完全一致的守卫（对齐"错误路径也要判有效性"这个原则，不是照抄 openDetail 整个函数）。
  // C6-d M1（44R复检"失效标记未统一"）：本视图里"会改变当前显示单据"的入口——列表行点击（openDetail/
  // openDraftById）、openDraftByIdFresh、openInspectionSheet（本函数）、offerExistingDraft、
  // openNewSheetModal 成功、返回列表（load）、切子视图（loadDeleted 等）——现在全部会推进同一个
  // sequence（前四个/load/loadDeleted 本就各自会 `++sequence`；offerExistingDraft/openNewSheetModal
  // 成功路径此前只靠 mode/viewGen 快照，本批已经补上，见两处各自的头部注释）。
  // LOW-1（C6-e，依据 C6-d 预筛）：本函数原本还多判一层"视图根"（data-sheet-id 与发起时快照比较），
  // 已删除——预筛发现它没有可达路径下的判别力（块 T 当初以为在测这一层，实际测的是"页签往返触发
  // load() 自己推进 sequence"这件事，两个变异下块 T 都全绿，属误判），且它还会在"自动刷新重画之后"
  // 静默吞掉合法跳转（自动刷新换出的新 [data-sheet-id] 节点会让快照比较误判"根已变"）。
  // C5a-g 追加 C/D：下面 try/catch 两分支各自判 seq!==sequence——这条判据由哪个入口的哪个构造证明，
  // 如实列出（不笼统说"已用变异验证"）：
  //   · try 分支（本函数自己的 seq，:1911 附近）由 verify-it-ledger-sheets-browser.js 块 S2 证明——
  //     A 的 GET 挂起，B 走真实 200 的 openInspectionSheet 二次调用抢先落地，放行 A 后仍是 B。
  //   · catch 分支（本函数自己的 seq，网络失败路径）由块 S 证明——两次都经本函数，第二次的 404 挂起
  //     期间第一次的迟到失败响应不应覆盖。
  //   · openDraftById 自己的 `++sequence`（不经过本函数的入口）由块 T（PU 构造）证明——继续填写 A、
  //     GET 挂起 → 继续填写 B，等 B 出现 → 放行 A 的迟到 200 → 断言仍是 B。
  //   · offerExistingDraft 成功分支自己的 `++sequence` 由 sheet-form-browser 块 PX 证明。
  //   · openNewSheetModal 成功分支自己的 `++sequence` 由块 P6 证明。
  //   · openDetail 自己的 `++sequence`（:1911 附近，本函数 try/catch 都会调它，但它也被别的入口直接
  //     调用，如列表行点提交单）由块 PD 证明——A 走本函数 GET 挂起，B 走列表行直接点开只读详情
  //     （不经过本函数），放行 A 后仍是 B。
  async function openInspectionSheet(id) {
    L.closeDrawer();
    L.setTab('inspections');
    if (L.state.tab !== 'inspections') return;
    // L1+L2（C5a-f）：同 openDraftByIdFresh——先收尾仍开着的旧会话（不管接下来跳到的目标是可写表单还是
    // 只读详情），排在下面 fetchSheetForOpen 的 queueIdle 之前。setTab('inspections') 若本来就已经在
    // inspections 页签是同页签跳过（it-ledger.js setTab 不触发 onLeave），旧会话不会被那条路径带着结
    // 束——这里补上是唯一真正能堵住"表单开着时直接跳到另一张单"这条路径的地方（原 L2 场景：跳到只读
    // 详情/无save分支此前完全不调 leaveForm，旧会话的自动保存计时器可能在别的视图上把 renderForm 画
    // 回来）。
    if (form && !form.destroyed) {
      // N-L1（C5a-g，预筛 LOW，预筛探针 Q6 实测可达）：leaveForm 是同步的，但它不重绘 DOM——同页签场景
      // 下（本来就在 inspections 页签，setTab 是 no-op），旧表单的整棵 DOM（含所有输入控件的事件监听器）
      // 在这里之后、fetchSheetForOpen 真正返回之前，原样留在 #itlContent 里且完全可点：Q6 实测这段等待
      // 期间点一次开关按钮，working 被真实写入且随后真的发出了一次 PUT、落库生效——用户在一个"已经离开"
      // 的会话上继续操作，界面上却没有任何视觉信号提示这一点。只在"确实有一个旧表单被这一句 leaveForm
      // 收尾"时才同步换成加载占位（同 openDetail 的 marker 写法）——没有旧表单（常见的跨页跳转场景，
      // #itlContent 此刻大概率已经是 setTab 切页签重绘出的新内容）就不必要地打断已经有效的画面。
      leaveForm(form);
      const waitMarker = document.createElement('div');
      waitMarker.className = 'itl-empty';
      waitMarker.textContent = '正在读取…';
      $('#itlContent')?.replaceChildren(waitMarker);
    }
    const seq = ++sequence;
    // LOW-1（C6-e，依据 C6-d 预筛）：视图根核对（data-sheet-id 与发起时快照比较）已删除，只留
    // seq/tab 两项判据。删除依据：①所有换单入口现在都推进同一个 sequence，P6/PU/PX 三条真实竞态各自
    // 用变异证明了 sequence 本身的必要性；②视图根这一层在可达路径上没有额外作用，找不到能单独证明它
    // 的构造（预筛：块 T 曾经"看起来"验证这一层，实际是页签往返触发 load() 自己推进 sequence 的假阳
    // 性，B1/B2 两个变异下块 T 都全绿，没有判别力）；③它还会在"自动刷新重画之后"静默吞掉合法跳转
    // （自动刷新换掉的新 [data-sheet-id] 节点会让 stillValid() 误判"根已变"）。44-R M1 原本要求的
    // "核对目标"现在改由统一的 sequence 保证（见 PU/PX 用例）。
    const stillValid = () => seq === sequence && L.state.tab === 'inspections';
    try {
      // C5a-e：跨页入口同样先等这张单的写队列落定（fetchSheetForOpen），拿到的是落定之后的服务器值。
      const detail = await fetchSheetForOpen(id);
      if (!stillValid()) { L.__inspLoadSettled++; return; }
      if (detail.status === 'draft' && detail.actions.includes('save')) openForm(detail);
      else openDetail(id);
      L.__inspLoadSettled++;
    } catch (error) {
      if (!stillValid()) { L.__inspLoadSettled++; return; }
      // 复用 openDetail() 自己的 GET + 既有404/错误恢复路径，不在这里另写一份。
      openDetail(id);
      L.__inspLoadSettled++;
    }
  }
  L.openInspectionSheet = openInspectionSheet;
  L.registerView('inspections', {
    render,
    onLeave,
    onAccessLost() {
      const identityChanged = getToken() !== viewToken; viewToken = getToken();
      sequence++; viewGen++; mode = 'list'; filters = { room: '', status: '', period: '90', search: '' }; overviewData = null; overviewError = null; checked.clear(); checkedVersions.clear(); knownRooms = new Set(); lastItems = []; detailId = null;
      if (form) {
        const lost = form; clearTimeout(lost.timer); releasePhotoOwner(lost.photoOwner); lost.destroyed = true; form = null;
        // 外审 H-1/H-2：换号（token 变了）与失权（token 未变：403 兜底或 /me 无权限）分开记原因。
        // 失权时置 accessLost：同一会话排队的后续任务（提交、采集、删除、照片）不再发请求，
        // 也不再用各自的提示覆盖下面这条全文提示；leaveFailureNotified 让在途冲刷的失败分支不重复提示。
        const parts = unsavedPartsFor(lost);
        if (parts.length) registerUnsaved(lost.id, sheetLabel(lost), parts, identityChanged ? '登录状态已变化' : '编辑权限已变化', lost.accountId);
        if (!identityChanged) {
          lost.accessLost = true; lost.leaveFailureNotified = true;
          setTimeout(() => notifyAccessLostOnce(lost), 0);
        }
      }
      // codex 48 H-3：失权时连同已离开、仍有排队任务的旧会话一起标记（换号不在此列：旧会话任务各自核 token）。
      if (!identityChanged) for (const s of liveSessions) if (s.token === getToken()) s.accessLost = true;
      pruneLiveSessions();
      releasePhotoOwner(detailPhotoOwner); detailPhotoOwner = null; closePhotoViewer();
      // 403 与换号都会结束表单会话。登记条目留在内存里，由渲染、提示后缀和 beforeunload 按账号 id 隔离。
    },
  });
  document.addEventListener('keydown', event => { if (photoViewer && event.key === 'Escape') { event.preventDefault(); closePhotoViewer(); } }, true);
  window.addEventListener('pagehide', () => { if (form) releasePhotoOwner(form.photoOwner); releasePhotoOwner(detailPhotoOwner); closePhotoViewer(); });
  document.addEventListener('click', e => {
    // C5a-f（H1+H2）："知道了"按钮——列表顶部常驻条与表单顶部常驻条共用同一套 data-unsaved-ack 委托，
    // 只有点了这个按钮才从登记表删除对应条目（不是别的任何成功/切换路径）。
    const unsavedAckBtn = e.target.closest('[data-unsaved-ack]');
    if (unsavedAckBtn) { clearUnsaved(Number(unsavedAckBtn.dataset.unsavedAck)); return; }
    if (e.target.closest('#itlInspNew')) { openNewSheetModal(); return; }
    if (e.target.closest('#itlInspOpenDeleted')) { loadDeleted(); return; }
    if (e.target.closest('#itlInspBackToList')) return; // 自身已绑定 addEventListener，这里不重复处理
    if (e.target.closest('#itlInspBatchArchive')) { confirmBatchArchive(); return; }
    const restoreBtn = e.target.closest('[data-insp-restore]');
    if (restoreBtn) {
      const id = Number(restoreBtn.dataset.inspRestore), version = Number(restoreBtn.dataset.version);
      const row = lastItems.find(r => r.id === id);
      confirmRestore(id, version, row ? row.room_name + ' · ' + time(row.created_at) : '#' + id);
      return;
    }
    const continueBtn = e.target.closest('[data-insp-continue]');
    if (continueBtn) { openDraftById(Number(continueBtn.dataset.inspContinue)); return; }
    const deleteDraftBtn = e.target.closest('[data-insp-delete-draft]');
    if (deleteDraftBtn) {
      const id = Number(deleteDraftBtn.dataset.inspDeleteDraft), version = Number(deleteDraftBtn.dataset.version);
      const row = lastItems.find(r => r.id === id);
      confirmDeleteDraftRow({ id, version, room_name: row ? row.room_name : '', created_at: row ? row.created_at : null });
      return;
    }
    const editBtn = e.target.closest('[data-insp-edit]');
    if (editBtn) { openSubmittedEditById(Number(editBtn.dataset.inspEdit)); return; }
    const deleteSubmittedBtn = e.target.closest('[data-insp-delete-submitted]');
    if (deleteSubmittedBtn) {
      const row = lastItems.find(r => r.id === Number(deleteSubmittedBtn.dataset.inspDeleteSubmitted));
      if (row) confirmDeleteSubmitted(row);
      return;
    }
    const unarchiveBtn = e.target.closest('[data-insp-unarchive]');
    if (unarchiveBtn) {
      const row = lastItems.find(r => r.id === Number(unarchiveBtn.dataset.inspUnarchive));
      if (row) confirmUnarchive(row);
      return;
    }
    const viewBtn = e.target.closest('[data-insp-view]');
    if (viewBtn) { openDetail(Number(viewBtn.dataset.inspView)); return; }
    const row = e.target.closest('[data-insp-row]');
    if (row && !e.target.closest('button,a,input,select,textarea,summary')) {
      const id = Number(row.dataset.inspRow), found = lastItems.find(r => r.id === id);
      // C5a 段3 + H4：summary（他人草稿，本就没有详情可看）行点击仍是占位，不发请求；full 可见度且带
      // save 动作的草稿行点行进真实的草稿填写页；full 可见但没有 save（写权限被降级为只读的巡检人看
      // 自己的草稿）与其余（已提交/已归档/已删除）行点行都进真实的只读详情页——不能只按 status==='draft'
      // 判断"该不该给可写表单"，那样会让降级用户点行就打开一张实际点不动、点了就 403 的表单。
      if (found && found.visibility === 'summary') { placeholder(); return; }
      if (found && found.status === 'draft' && found.actions.includes('save')) { openDraftById(id); return; }
      if (found) { openDetail(id); return; }
      placeholder();
    }
  });
})();
