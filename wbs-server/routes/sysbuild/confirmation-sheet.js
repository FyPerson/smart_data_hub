// routes/sysbuild/confirmation-sheet.js — 项目管理（系统建设记录）模块：需求确认单导出（C4c R-S1）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261102_v1.3.md §2.2 不变量 9、§4.2、§5.2「导出需求确认单」行、§5.3、§7「导出」行、§8.3「确认页」。
//   派单 = docs/local/系统建设记录/送审准备/C4c_R-S1_确认单导出_派单_20261105.md（契约 2.1–2.5；R-D2：草稿 409，R-D3：页面内容与顺序）。
//
// 工厂 createConfirmationSheetRoutes(ctx) 返回 { router, _internals }。ctx：{ db, logger, readonlyIds, writeRoles, nowProvider? }。
//   router 上的路径以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 端点 GET /sysbuild/package-versions/:vid/confirmation-sheet：打印友好的单页 HTML（含每条确认的方式）。
//   检查顺序（§5.3 读端点）：参数 400 → 版本不存在 / 项目不可见 404 → 草稿 409 SYSBUILD_STATE。不另设动作权限：可见即可导出（rules.canExportConfirmationSheet，
//   packages.js versionActions.export_sheet 调用同一个判定）。**纯读**：只用 db.withRead 与 q.get / q.all，不写任何表（含浏览记录与事件），
//   不调用任何会写库的助手（不经 confirm.js 的 buildTaskResponse 取数——它在 record = true 时写浏览记录）。
// 安全：页面里所有来自库或请求的值都经下面的自动转义模板助手 html`…`（默认转义 & < > " '）；只有助手自己产出的片段可原样拼接，本文件没有「把任意字符串标记为安全」的函数。
//   不用平台任何 escapeHtml（#108：多数不转义引号）。页面无脚本、无内联事件属性、无外部资源；响应头见 sendSheet。
//   可信边界：调用 html`…` 的代码（本模块内）视为可信，模板字面量里的静态文字来自源码；库内数据与请求参数只会以插值进入，进不了静态文字，也构造不出片段
//   （片段是模块私有类 Fragment 的冻结实例，内容在私有字段里，对象本身没有可读属性也没有 Symbol 键；带同名属性的普通对象、JSON 解析出来的对象都不算片段）。
//   手工伪造冻结模板数组去调用 html 属于调用者越界（需要先能在本模块内执行代码），不在这道防线之内；html 只对形态做基本校验（见函数内注释）。
// 附件：遮蔽的附件不显示原名（对 admin 也一样），原名来自 confirm-core.attachmentView（遮蔽时 name = null），本文件另在渲染处再拦一次（两层）。
// 时间口径：库内所有 TS 列都是 datetime('now','localtime')（schema.js 的 TS 常量，服务器本地时间）；历史导入生效时刻写「原日期 00:00:00」（confirm-core.applyPackageEffect）。
//   页面一律显示到分钟（YYYY-MM-DD HH:MM），不换算时区；导出时刻同样取服务器本地时间。DATE 列（外部确认日期、原日期、计划起止）原样显示。
'use strict';
const materialsCore = require('./materials-core');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const core = require('./confirm-core');
const { loadFoldedSet, setList } = require('./packages');

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);

// ── 自动转义的模板助手 ─────────────────────────────────────────────────────────────────────────────
// html`…${值}…`：每个插值默认转义 & < > " '（null / undefined → 空串，其余 String()）；插值是助手自己产出的片段、或片段数组时原样拼接，其余一律转义。
//   模板字面量里的静态文字来自本文件源码，视为可信。片段 = 模块私有类 Fragment 的实例，内容存在私有字段 #text 里（不是属性、不是 Symbol 键，外部读不到也写不进）；
//   `#text in v` 是私有品牌检查，只有 new Fragment 出来的对象为真。为了让片段拿不到「类」这个把手，做了几层收紧（都只是收紧，可信边界以文件头为准）：
//   片段的原型是 null（拿不到 constructor / 原型链）并冻结；Fragment 类与 Fragment.prototype 冻结；判定函数 is / textOf 在模块加载时捕获成常量，
//   之后全部通过常量调用（不再现查 Fragment.is）；构造函数要求第一个参数是模块私有的 MINT，不是就抛 500（纵深防御）。
//   不用 WeakMap：静态守卫 S5 禁止非 q 接收者的 .get(，而 WeakMap 取值要 .get(。
//   能在本模块内执行代码的人（改 Fragment、改 MINT 的作用域）不在这道防线内。
const MINT = Object.freeze({});
class Fragment {
  #text;
  constructor(mint, text) {
    if (mint !== MINT) throw internalError('片段只能由 html 助手构造');
    this.#text = text;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static is(v) { return v !== null && typeof v === 'object' && #text in v; }
  static textOf(v) { return v.#text; }
}
Object.freeze(Fragment);
Object.freeze(Fragment.prototype);
const fragIs = Fragment.is;
const fragText = Fragment.textOf;
const mkSafe = (s) => new Fragment(MINT, s);
const isSafe = (v) => fragIs(v);
const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
function frag(v) {
  if (isSafe(v)) return fragText(v);
  if (Array.isArray(v)) return v.map(frag).join('');
  return esc(v);
}
function html(strings, ...vals) {
  // 只能作为模板标签调用：strings 必须是模板字面量产生的冻结数组（带冻结的 raw），且静态段数 = 插值数 + 1；普通数组 / 字符串直接调用一律拒绝，
  //   免得把运行时拼出来的串当成可信静态文字。这只是基本的形态校验：能手工伪造出同形的冻结数组的代码已经在本模块内执行，不在防线内（见文件头可信边界）。
  if (!(Array.isArray(strings) && Array.isArray(strings.raw) && Object.isFrozen(strings) && Object.isFrozen(strings.raw) && strings.length === vals.length + 1)) throw internalError('html 只能作为模板标签调用');
  let out = strings[0];
  for (let i = 0; i < vals.length; i += 1) out += frag(vals[i]) + strings[i + 1];
  return mkSafe(out);
}
function toText(safe) {
  if (!isSafe(safe)) throw internalError('toText 只接受 html 片段');
  return fragText(safe);
}

// ── 分类表（代码 → 中文）：表外值一律抛 500（fail-closed），不原样输出、不显示空 ────────────────────────────
function lookup(table, key, what) {
  if (typeof key !== 'string' || !hasKey(table, key)) throw internalError(`${what}未登记`);
  return table[key];
}
const PACKAGE_TYPE_ZH = Object.freeze({
  initiation: '立项包', overall: '总体规划包', batch_req: '批次需求包', batch_accept: '批次验收包', change: '范围变更包', closing: '结项包',
});
const FORM_ZH = Object.freeze({ overall: '总体', overall_batch_req: '单批合并' });
const REVISION_STATUS_ZH = Object.freeze({
  pending: '待确认', confirmed: '已确认', objected: '有异议', rejected: '不认可', invalid: '已失效', superseded: '已替代',
});
const METHOD_ZH = Object.freeze({ platform: '平台确认', card: '钉钉卡片', proxy: '代录', history: '历史补录' });
const DECISION_ZH = Object.freeze({ confirm: '确认', object: '有异议', reject: '不认可' });
const PROPOSER_STATUS_ZH = Object.freeze({ pending: '待确认', confirmed: '已确认', proxy_confirmed: '已确认（代录）', denied: '否认' });
const PURPOSE_ZH = Object.freeze({
  package_confirm: '内容包确认', proposer_confirm: '提出人确认', accept_invitation: '接受邀请', delegation_grant: '授权批准', delegation_accept: '授权接受',
  dev_key_confirm: '开发方关键事项确认', conclusion_confirm: '办理结论确认', adjudicate: '裁定', handover_accept: '运维交接接收',
  handover_accept_issue: '交接确认（接受带此问题上线）', handover_no_further: '交接确认（业务确认不再处理）', // C6a
});
const LAYER_ZH = Object.freeze({ project: '项目层', batch: '批次层' });
const mapPackageType = (v) => lookup(PACKAGE_TYPE_ZH, v, '内容包类型');
const mapForm = (v) => lookup(FORM_ZH, v, '包版本形态');
const mapRevisionStatus = (v) => lookup(REVISION_STATUS_ZH, v, '确认修订状态');
const mapMethod = (v) => lookup(METHOD_ZH, v, '确认方式');
const mapDecision = (v) => lookup(DECISION_ZH, v, '确认决策');
const mapProposerStatus = (v) => lookup(PROPOSER_STATUS_ZH, v, '提出人确认状态');
const mapPurpose = (v) => lookup(PURPOSE_ZH, v, '确认任务用途');
const mapLayer = (v) => lookup(LAYER_ZH, v, '节点层级');
// 必需确认人的身份：依据任职 → 负责人；依据授权 → 代表人。两者都没有（本代码中只有提出人任务或库内异常数据会出现）显示「—」并说明；两者都有是矛盾数据，抛 500。
function mapIdentity(rev) {
  const a = rev.basis_appointment_id !== null && rev.basis_appointment_id !== undefined;
  const d = rev.basis_delegation_id !== null && rev.basis_delegation_id !== undefined;
  if (a && d) throw internalError('确认任务修订同时依据任职与授权');
  if (a) return '负责人';
  if (d) return '代表人';
  return '—（该修订未登记任职或授权依据）';
}
// 版本状态徽标：草稿与表外状态都不能导出（抛 500，不显示空徽标）。
function badgeText(ver) {
  if (ver.status === 'pending') return '待确认 · 未生效';
  if (ver.status === 'effective') return `已生效 · 生效时间 ${fmtTime(ver.effective_at)}`;
  if (ver.status === 'superseded') {
    return ver.effective_at ? `已被替代 · 曾于 ${fmtTime(ver.effective_at)} 生效` : '已被替代 · 未生效（撤回或被新版本替代）';
  }
  throw internalError('版本状态不可导出');
}

// ── 时间 ───────────────────────────────────────────────────────────────────────────────────────
// 库内时间文本 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD HH:MM'；只有日期的文本原样；空 → 空串；其余格式抛 500。
function fmtTime(s) {
  if (s === null || s === undefined || s === '') return '';
  const m = typeof s === 'string' ? s.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(?::\d{2})?)?$/) : null;
  if (!m) throw internalError('时间格式不认识');
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}
function fmtNow(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 片段 ───────────────────────────────────────────────────────────────────────────────────────
const EMPTY = html`<span class="muted">（无）</span>`;
// source（可选）= 该行来自哪份冻结清单（package_version / item_version），写成 data-frozen-source；条目块用它区分「主清单」与「条目版本自身冻结清单的多出部分」。
function attLine(a, source) {
  const sizeText = a.size === null || a.size === undefined ? '—' : `${a.size} 字节`;
  const del = a.deleted ? html` · <span class="warn">已删除（删除人 ${a.deleted_by_name || '—'}，${fmtTime(a.deleted_at)}）</span>` : '';
  const src = source ? html` data-frozen-source="${source}"` : '';
  if (a.masked) {
    return html`<li class="att" data-attachment-id="${a.attachment_id}"${src} data-masked="1"><strong>已遮蔽</strong>（遮蔽原因：${a.mask_reason}）· 操作人 ${a.masked_by_name || a.masked_by || '—'} · 遮蔽时间 ${fmtTime(a.masked_at)} · ${sizeText} · SHA-256 <code>${a.sha256}</code>${del}</li>`;
  }
  return html`<li class="att" data-attachment-id="${a.attachment_id}"${src} data-masked="0">${a.name === null || a.name === undefined ? '（附件记录缺失）' : a.name} · ${sizeText} · SHA-256 <code>${a.sha256}</code>${del}</li>`;
}
const attList = (list, source) => (list.length === 0 ? EMPTY : html`<ul class="atts">${list.map((a) => attLine(a, source))}</ul>`);

// 一条确认记录（修订名下的平台 / 代录 / 卡片确认）的明细：方式、决策、时间，随方式带操作人 / 声明 / 外部确认信息 / 凭据附件，异议与不认可带原因。
function confirmationDetail(c) {
  if (!c) return html`<span class="muted">尚无确认记录</span>`;
  const method = mapMethod(c.method);
  const lines = [
    html`<li>方式：<strong>${method}</strong></li>`,
    html`<li>决策：${mapDecision(c.decision)}</li>`,
    html`<li>时间：${fmtTime(c.created_at)}</li>`,
  ];
  if (c.method === 'platform' || c.method === 'card') {
    lines.push(html`<li>操作人：${c.actor_name || '—'}</li>`);
    if (c.method === 'platform') lines.push(html`<li>勾选声明：${c.checkbox_text}</li>`);
  }
  if (c.method === 'proxy') {
    lines.push(
      html`<li>外部确认日期：${c.external_date}</li>`,
      html`<li>实际确认人：${c.actual_confirmer}</li>`,
      html`<li>身份依据：${c.identity_basis}</li>`,
      html`<li>录入人：${c.proxy_by_name || '—'}（录入时间 ${fmtTime(c.created_at)}）</li>`,
      html`<li>凭据附件：${attList(c.attachments)}</li>`
    );
  }
  if (c.decision !== 'confirm') lines.push(html`<li>原因：${c.reason}</li>`);
  return html`<ul class="detail">${lines}</ul>`;
}
// 历史补录的一条记录（内容包版本或条目版本）。
function historyDetail(c) {
  return html`<ul class="detail">
<li><strong class="warn">历史补录</strong> · 决策：${mapDecision(c.decision)}</li>
<li>原日期：${c.external_date}</li>
<li>实际确认人：${c.actual_confirmer}</li>
<li>身份依据：${c.identity_basis}</li>
<li>录入人：${c.proxy_by_name || '—'}（录入时间 ${fmtTime(c.created_at)}）</li>
${c.decision !== 'confirm' ? html`<li>原因：${c.reason}</li>` : ''}
<li>凭据附件：${attList(c.attachments)}</li>
</ul>`;
}

// ── 页面 ───────────────────────────────────────────────────────────────────────────────────────
// 范围变更包（C5 S-S1c）页头附加行：变更标题、变更说明、引用登记（本项目办理类登记，按编号 + 标题列出）
function renderChangeRows(ch) {
  const refs = ch.entries.length === 0 ? EMPTY : ch.entries.map((e) => html`<div class="change-ref" data-entry-id="${e.id}">第 ${e.id} 条 · ${e.title}</div>`);
  return html`<tr><th>变更标题</th><td data-change-id="${ch.id}">${ch.title}</td></tr>
<tr><th>变更说明</th><td class="pre-wrap">${ch.body}</td></tr>
<tr><th>引用登记</th><td>${refs}</td></tr>
${ch.no_written_evidence ? html`<tr><th>无书面证据</th><td><strong class="warn">该变更声明无书面证据</strong> · 原因：${ch.no_evidence_reason}</td></tr>` : ''}`;
}
function renderHeader(m) {
  const imports = m.imports;
  const importBlocks = imports.map((r) => html`<div class="hist-import" data-history-import-id="${r.id}">
<p><strong class="warn">历史导入</strong>：该版本的生效是历史事实导入，不是在平台上逐人确认的结果。</p>
<ul class="detail">
<li>原日期：${r.original_date}</li>
<li>实际确认人：${r.actual_confirmer}</li>
<li>身份依据：${r.identity_basis}</li>
<li>导入人：${r.imported_by_name}</li>
<li>导入时间：${fmtTime(r.imported_at)}</li>
<li>凭据附件：${attList(r.attachments)}</li>
</ul>
</div>`);
  return html`<header id="sheet-header" data-version-status="${m.ver.status}" data-history-import="${imports.length > 0 ? '1' : '0'}">
<h1>需求确认单</h1>
<p class="no-print">打印提示：使用浏览器的打印功能（Ctrl+P）可输出 A4 纸质单或 PDF。</p>
<table class="kv">
<tr><th>项目名称</th><td>${m.projectName}</td></tr>
<tr><th>内容包类型</th><td>${mapPackageType(m.pkg.type)}</td></tr>
${m.ver.form === null ? '' : html`<tr><th>形态</th><td>${mapForm(m.ver.form)}</td></tr>`}
<tr><th>版本号</th><td>v${m.ver.version_no}</td></tr>
${m.change === null ? '' : renderChangeRows(m.change)}
<tr><th>版本状态</th><td><span class="badge">${badgeText(m.ver)}</span></td></tr>
<tr><th>导出人</th><td>${m.exporterName}</td></tr>
<tr><th>导出时间</th><td>${m.exportedAt}</td></tr>
</table>
${importBlocks}
</header>`;
}

function renderSnapshot(snap) {
  const isEmpty = snap === null || snap === undefined || snap === '' || (typeof snap === 'object' && !Array.isArray(snap) && Object.keys(snap).length === 0);
  if (isEmpty) return EMPTY;
  if (typeof snap !== 'object' || Array.isArray(snap)) return html`<pre>${JSON.stringify(snap, null, 2)}</pre>`;
  const rows = Object.keys(snap).filter((k) => k !== 'material_version_ids').map((k) => {
    const v = snap[k];
    return typeof v === 'string'
      ? html`<tr><th>${k}</th><td class="pre-wrap">${v}</td></tr>`
      : html`<tr><th>${k}</th><td><pre>${JSON.stringify(v, null, 2)}</pre></td></tr>`;
  });
  return rows.length ? html`<table class="kv">${rows}</table>` : EMPTY;
}
function renderMaterial(material) {
  return html`<article class="item material" data-material-version-id="${material.id}">
<h3>${material.name} · 材料版本 v${material.version_no}</h3>
<table class="kv"><tr><th>所属节点（当前名称）</th><td>#${material.node_id} · ${material.node_name}</td></tr>
<tr><th>材料原文</th><td class="pre-wrap">${material.body || '（无正文）'}</td></tr>
<tr><th>建立人 / 时间</th><td>${material.created_by_name || '—'} · ${fmtTime(material.created_at)}</td></tr></table>
<div class="sub">本包版本冻结的材料附件</div>${attList(material.attachments, 'package_version')}
</article>`;
}

function renderPlans(plans) {
  if (plans === null) return html`<span class="muted">（无计划快照）</span>`;
  if (plans.length === 0) return EMPTY;
  const rows = plans.map((p) => html`<tr><td>${p.name}</td><td>${p.layer === null || p.layer === undefined ? '—' : mapLayer(p.layer)}</td><td>${p.batch_name || '—'}</td><td>${p.planned_start}</td><td>${p.planned_end}</td></tr>`);
  return html`<table><thead><tr><th>节点名称</th><th>层</th><th>批次</th><th>计划开始</th><th>计划结束</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 提出人确认的明细（都放在独立 div 里，与上面的状态词分行）：没有提出人确认任务 → 「无提出人确认任务」；有任务但当前修订还没有确认记录 →
//   「当前修订：<当前修订状态> · 尚无确认记录」（待确认时即「当前修订：待确认 · 尚无确认记录」）；有确认记录 → 确认记录明细。
function proposerDetail(it) {
  if (it.proposer_rev_status === null) return html`<div class="muted">无提出人确认任务</div>`;
  if (!it.proposer_confirmation) return html`<div class="muted">当前修订：${mapRevisionStatus(it.proposer_rev_status)} · 尚无确认记录</div>`;
  return html`<div class="proposer-confirmation">${confirmationDetail(it.proposer_confirmation)}</div>`;
}
function renderItem(it) {
  const proposerLabel = it.proposer_member_name || it.proposer_name || '—';
  const confirmStatus = mapProposerStatus(it.proposer_status);
  return html`<article class="item" data-item-version-id="${it.item_version_id}" data-proposer-status="${it.proposer_status}">
<h3>${it.code} · 条目版本 v${it.version_no}</h3>
<table class="kv">
<tr><th>承诺批次</th><td>${it.batch_name || '—'}</td></tr>
<tr><th>内容</th><td class="pre-wrap">${it.content}</td></tr>
<tr><th>引用原文</th><td class="pre-wrap">${it.quote_text === null || it.quote_text === undefined || it.quote_text === '' ? EMPTY : it.quote_text}</td></tr>
<tr><th>提出人</th><td>${proposerLabel}${it.party_name ? html`（${it.party_name}）` : ''}</td></tr>
<tr><th>提出人确认</th><td><strong>${confirmStatus}</strong>${it.proposer_status === 'denied' ? html` · 否认原因：${it.deny_reason}` : ''}${proposerDetail(it)}</td></tr>
${it.no_written_evidence ? html`<tr><th>无书面证据</th><td><strong class="warn">该条目声明无书面证据</strong> · 原因：${it.no_evidence_reason}</td></tr>` : ''}
</table>
<div class="sub">冻结附件</div>
${attList(it.attachments, 'package_version')}
${it.extra_frozen.length === 0 ? '' : html`<div class="sub">条目版本冻结清单（提出人确认 / 历史补录时冻结）</div>${attList(it.extra_frozen, 'item_version')}`}
${it.history.length === 0 ? '' : html`<div class="sub">历史补录</div><div class="hist">${it.history.map((h) => html`<div class="hist-rec" data-history-confirmation-id="${h.id}">${historyDetail(h)}</div>`)}</div>`}
</article>`;
}

function renderConfirmerRow(t) {
  const c = t.confirmation;
  const rev = t.current;
  return html`<tr class="confirmer" data-task-id="${t.task_id}" data-revision-id="${rev.id}" data-method="${c ? c.method : 'none'}" data-decision="${c ? c.decision : 'none'}">
<td>${t.party_name || '—'}<div class="muted">${mapPurpose(t.purpose)}</div></td>
<td>${t.member_name}${t.proxy_only ? html`<div class="warn">该确认人无平台账号，只能代录</div>` : ''}</td>
<td>${mapIdentity(rev)}</td>
<td>${mapRevisionStatus(rev.status)}${rev.status_reason ? html`<div class="muted">原因：${rev.status_reason}</div>` : ''}</td>
<td>${confirmationDetail(c)}</td>
</tr>`;
}

function renderAppendixTask(t) {
  const rows = t.revisions.map((r) => html`<tr data-appendix-task-id="${t.task_id}" data-appendix-revision-id="${r.id}" data-rev-no="${r.rev_no}">
<td>${r.rev_no}</td><td>${r.member_name}</td><td>${mapRevisionStatus(r.status)}</td><td>${r.status_reason || '—'}</td>
<td>${r.created_by_name} · ${fmtTime(r.created_at)}</td><td>${fmtTime(r.updated_at)}</td>
<td>${r.confirmation ? html`${mapMethod(r.confirmation.method)} · ${mapDecision(r.confirmation.decision)} · ${fmtTime(r.confirmation.created_at)}` : '—'}</td>
</tr>`);
  return html`<h3>${t.party_name || '—'} · ${mapPurpose(t.purpose)}（任务 #${t.task_id}）</h3>
<table><thead><tr><th>修订号</th><th>必需确认人</th><th>状态</th><th>状态原因</th><th>创建人与时间</th><th>更新时间</th><th>确认记录摘要</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const STYLE_AND_HEAD = html`<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<style>
body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 13px; color: #222; margin: 0; padding: 16px; line-height: 1.55; background: #fff; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #333; }
h3 { font-size: 14px; margin: 12px 0 6px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; }
th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-all; }
th { background: #eee; font-weight: 600; }
table.kv th { width: 1%; white-space: nowrap; }
.badge { display: inline-block; padding: 2px 10px; border: 1px solid #333; font-weight: 700; }
.warn { color: #a40000; font-weight: 700; }
.muted { color: #666; }
.sub { margin-top: 6px; font-weight: 600; }
.item { border: 1px solid #999; padding: 6px 10px; margin: 10px 0; }
.hist-import { border: 1px solid #a40000; padding: 4px 10px; margin: 8px 0; }
.no-print { color: #555; border: 1px dashed #999; padding: 4px 8px; margin: 0 0 10px; }
pre, .pre-wrap { white-space: pre-wrap; word-break: break-all; margin: 0; }
pre { font-family: Consolas, monospace; font-size: 12px; }
code { font-family: Consolas, monospace; font-size: 11px; word-break: break-all; }
ul { margin: 2px 0; padding-left: 18px; }
@page { size: A4; margin: 14mm; }
@media print {
  body { padding: 0; font-size: 11px; }
  .no-print { display: none; }
  tr, li, article, .hist-import { page-break-inside: avoid; break-inside: avoid; }
  h2, h3 { page-break-after: avoid; break-after: avoid; }
  thead { display: table-header-group; }
}
</style>`;

const SECTION_NUMERALS = Object.freeze(['一', '二', '三', '四', '五', '六', '七']);
function renderPage(m) {
  const title = `需求确认单 · ${m.projectName} · ${mapPackageType(m.pkg.type)} v${m.ver.version_no}`;
  const historySection = m.histConfs.length === 0
    ? EMPTY
    : html`<table><thead><tr><th>决策</th><th>原日期</th><th>实际确认人</th><th>身份依据</th><th>录入人与时间</th><th>原因</th><th>凭据附件</th></tr></thead><tbody>${m.histConfs.map((h) => html`<tr data-history-confirmation-id="${h.id}">
<td><strong class="warn">历史补录</strong> · ${mapDecision(h.decision)}</td><td>${h.external_date}</td><td>${h.actual_confirmer}</td><td>${h.identity_basis}</td>
<td>${h.proxy_by_name || '—'} · ${fmtTime(h.created_at)}</td><td>${h.reason || '—'}</td><td>${attList(h.attachments)}</td>
</tr>`)}</tbody></table>`;
  // 小节序号由计数器按实际输出顺序生成（模板里的插值从左到右求值）：非总体规划包没有节点计划节时序号不跳号；附录不编号。
  let no = 0;
  const section = (id, heading, body) => {
    if (no >= SECTION_NUMERALS.length) throw internalError('小节数超出序号表');
    return html`<section id="${id}"><h2>${SECTION_NUMERALS[no++]}、${heading}</h2>${body}</section>`;
  };
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
${STYLE_AND_HEAD}
</head>
<body>
${renderHeader(m)}
${section('sec-snapshot', '包内容快照', renderSnapshot(m.snapshot))}
${m.pkg.type === 'overall' || m.pkg.type === 'change' ? section('sec-plans', '节点计划快照', renderPlans(m.plans)) : ''}
${section('sec-frozen', '冻结附件清单（本包版本）', attList(m.frozen))}
${m.materials.length ? section('sec-materials', '引用材料版本全文', m.materials.map(renderMaterial)) : ''}
${section('sec-items', '引用条目', m.items.length === 0 ? EMPTY : m.items.map(renderItem))}
${section('sec-confirmers', '必需确认人', m.tasks.length === 0 ? EMPTY : html`<table><thead><tr><th>参与方 / 用途</th><th>必需确认人</th><th>身份</th><th>修订状态</th><th>确认方式与记录</th></tr></thead><tbody>${m.tasks.map(renderConfirmerRow)}</tbody></table>`)}
${section('sec-history', '历史补录的确认', historySection)}
<section id="sec-appendix"><h2>附录：修订历史</h2>${m.tasks.length === 0 ? EMPTY : m.tasks.map(renderAppendixTask)}</section>
<footer><p class="muted">本单按提交时冻结的快照生成；附件以 SHA-256 核对；确认方式以平台记录为准。</p></footer>
</body>
</html>`;
}

function createConfirmationSheetRoutes(ctx) {
  for (const k of ['db', 'logger']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/confirmation-sheet 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/confirmation-sheet 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/confirmation-sheet 参数 writeRoles 必须是数组或 Set');
  }
  const { db, logger } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  const nowOf = () => (typeof ctx.nowProvider === 'function' ? ctx.nowProvider() : new Date());

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 需求确认单接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };

  // ── 取数（只读）─────────────────────────────────────────────────────────────────────────
  async function userNameOf(q, uid) {
    if (uid === null || uid === undefined) return '';
    const r = await q.get('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [uid]);
    return r && r.n ? r.n : `user#${uid}`;
  }
  async function memberNameOf(q, mid) {
    if (mid === null || mid === undefined) return '';
    const r = await q.get(
      'SELECT COALESCE(u.display_name, u.username, m.person_name) AS n FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?',
      [mid]
    );
    return r && r.n ? r.n : `成员#${mid}`;
  }
  async function partyNameOf(q, partyId) {
    if (partyId === null || partyId === undefined) return '';
    const r = await q.get('SELECT name FROM sysbuild_parties WHERE id = ?', [partyId]);
    return r ? r.name : `参与方#${partyId}`;
  }
  // 附件视图（confirm-core.attachmentView / evidenceViewOf 的结果）补遮蔽原因：只对已遮蔽的附件再查 mask_reason。
  async function withMaskReason(q, list) {
    const out = [];
    for (const a of list) {
      let reason = null;
      if (a.masked) {
        const r = await q.get('SELECT mask_reason FROM sysbuild_attachments WHERE id = ?', [a.attachment_id]);
        reason = r ? r.mask_reason : null;
      }
      out.push(Object.assign({}, a, { mask_reason: reason }));
    }
    return out;
  }
  // 条目版本的冻结附件分两份：
  //   · 主清单 = 该条目版本名下（绑定 ∪ 引用）∩ 本包版本冻结清单，SHA-256 取包版本冻结时的值——以包版本冻结清单为上限（确认单读的是包版本提交时冻结的快照）。
  //     没有提出人任务的条目（只填姓名、提出人不可作为确认人、历史补录互斥）在补录前没有条目版本自己的冻结清单，其附件只随包版本冻结，所以必须经包版本清单取。
  //   · 条目版本自身冻结清单（提出人确认 / 历史补录时冻结）里、不在主清单的附件，单列（extra）。正常数据里它是主清单的子集，extra 为空；不为空说明两份冻结清单不一致，如实展示。
  //   同一附件在两份清单里 SHA-256 不同 → 500（fail-closed，不挑一份显示）。返回 { main, extra }（都已补遮蔽原因）。
  async function itemFrozenViews(q, itemVersionId, pkgFrozen) {
    const owned = await q.all(
      `SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'item_version' AND owner_id = ?
       UNION SELECT attachment_id FROM sysbuild_attachment_refs WHERE owner_type = 'item_version' AND owner_id = ?`,
      [itemVersionId, itemVersionId]
    );
    const ownedIds = owned.map((r) => r.attachment_id);
    const selfFrozen = await core.frozenSetOf(q, 'item_version', itemVersionId);
    for (const f of selfFrozen) {
      const p = pkgFrozen.find((x) => x.attachment_id === f.attachment_id);
      if (p && p.sha256 !== f.sha256) throw internalError('同一附件在条目版本与包版本两份冻结清单里的 SHA-256 不一致');
    }
    const main = [];
    for (const f of pkgFrozen) {
      if (ownedIds.includes(f.attachment_id) && !main.some((x) => x.attachment_id === f.attachment_id)) main.push(f);
    }
    const extra = selfFrozen.filter((f) => !main.some((x) => x.attachment_id === f.attachment_id));
    return {
      main: await withMaskReason(q, await core.attachmentView(q, main)),
      extra: await withMaskReason(q, await core.attachmentView(q, extra)),
    };
  }
  // 任务修订名下的确认记录（D42：每修订至多一条）：补凭据附件（含遮蔽原因）、操作人与录入人姓名。
  async function confirmationOf(q, revisionId) {
    const c = await q.get(
      `SELECT id, task_revision_id, object_type, object_version_id, actor_user_id, actual_confirmer, identity_basis, method, decision, checkbox_text, reason, external_date, proxy_by, created_at
         FROM sysbuild_confirmations WHERE task_revision_id = ?`,
      [revisionId]
    );
    if (!c) return null;
    await core.attachConfirmationEvidence(q, c);
    c.attachments = await withMaskReason(q, c.attachments);
    c.actor_name = await userNameOf(q, c.actor_user_id);
    c.proxy_by_name = await userNameOf(q, c.proxy_by);
    return c;
  }
  async function withHistoryExtras(q, rows) {
    for (const h of rows) {
      h.attachments = await withMaskReason(q, h.attachments);
      h.proxy_by_name = await userNameOf(q, h.proxy_by);
    }
    return rows;
  }
  function parseSnapshot(text) {
    try { return JSON.parse(text); } catch (_) { throw internalError('包版本快照不是合法 JSON'); }
  }

  // 版本加载：版本不存在 / 项目不可见 → 404（rules.notFound / rules.assertVisible，与 packages.js、confirm.js 的 loadVersionCtx 同一条路径）。
  async function loadVersionCtx(q, vid, user) {
    const ver = await q.get(
      'SELECT id, package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json, created_by, created_at, updated_at FROM sysbuild_package_versions WHERE id = ?',
      [vid]
    );
    if (!ver) throw rules.notFound();
    const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    if (!pkg) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, pkg.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { ver, pkg, access };
  }

  async function loadModel(q, vid, user, now) {
    const { ver, pkg, access } = await loadVersionCtx(q, vid, user);
    if (!rules.canExportConfirmationSheet(access, ver)) {
      throw stateError(ver.status === 'draft' ? '草稿版本没有冻结的快照，不能导出需求确认单，请先提交确认' : '该版本状态不能导出需求确认单');
    }
    const pid = pkg.project_id;
    const project = await q.get('SELECT system_name, phase_name FROM sysbuild_projects WHERE id = ?', [pid]);
    if (!project) throw internalError('项目不存在');
    const m = {
      ver, pkg,
      projectName: project.phase_name ? `${project.system_name}（${project.phase_name}）` : project.system_name,
      exporterName: core.operatorNameOf(user),
      exportedAt: fmtNow(now),
      snapshot: parseSnapshot(ver.snapshot_json),
    };
    // 历史导入（凭它识别「经历史导入生效」）：只取内容包生效这一类。
    m.imports = [];
    for (const r of await core.historyImportsOf(q, pid, 'package_version', vid)) {
      if (r.fact_type !== 'package_effective') continue;
      r.attachments = await withMaskReason(q, r.attachments);
      r.imported_by_name = await userNameOf(q, r.imported_by);
      m.imports.push(r);
    }
    // 节点计划快照（仅总体规划包）：提交事件（或历史导入事件）里记录的清单；没有 → null。
    m.plans = pkg.type === 'overall' || pkg.type === 'change' ? await core.submittedNodePlans(q, vid) : null; // 变更包按提交记录（提交事件的 node_plans）
    // 范围变更包（C5 S-S1c）：变更标题 / 说明 / 引用登记；其余类型为 null
    m.change = null;
    if (pkg.type === 'change') {
      const ch = await q.get('SELECT id, title, body, affects_json, no_written_evidence, no_evidence_reason FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);
      if (!ch) throw internalError('变更包没有对应的变更');
      let aff = {};
      try { aff = JSON.parse(ch.affects_json) || {}; } catch (_) { throw internalError('变更的影响说明不是合法 JSON'); }
      const entries = [];
      for (const eid of Array.isArray(aff.from_entry_ids) ? aff.from_entry_ids : []) {
        const e = await q.get('SELECT id, title FROM sysbuild_entries WHERE id = ? AND project_id = ?', [eid, pid]);
        if (e) entries.push({ id: e.id, title: e.title });
      }
      m.change = { id: ch.id, title: ch.title, body: ch.body, entries, no_written_evidence: ch.no_written_evidence === 1, no_evidence_reason: ch.no_evidence_reason };
    }
    const pkgFrozen = await core.frozenSetOf(q, 'package_version', vid);
    m.frozen = await withMaskReason(q, await core.attachmentView(q, pkgFrozen));
    // 指定材料版本的正文与原冻结清单；以本包冻结集合为上限，不回读材料“最新版”。
    m.materials = await materialsCore.assertMaterialFreezes(q, pid, ver);
    for (const material of m.materials) material.attachments = await core.attachmentView(q, material.frozen);
    // 引用条目（按 item_id 升序）
    m.items = [];
    for (const e of setList(await loadFoldedSet(q, vid))) {
      const row = await q.get(
        `SELECT it.code AS code, iv.version_no AS version_no, iv.content AS content, iv.quote_text AS quote_text, iv.proposer_name AS proposer_name,
                iv.proposer_member_id AS proposer_member_id, iv.proposer_party_id AS proposer_party_id, iv.proposer_status AS proposer_status, iv.deny_reason AS deny_reason,
                iv.no_written_evidence AS no_written_evidence, iv.no_evidence_reason AS no_evidence_reason
           FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?`,
        [e.item_version_id]
      );
      if (!row) throw internalError('包内条目版本不存在');
      const batch = e.committed_batch_id === null ? null : await q.get('SELECT name FROM sysbuild_batches WHERE id = ?', [e.committed_batch_id]);
      // 提出人任务当前修订的确认记录。没有任务 = 没有提出人确认任务（只填姓名、提出人不可作为确认人、历史补录互斥）；一个条目版本至多一个提出人任务，多于一个是库内异常，fail-closed。
      const itemTasks = await q.all("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ? AND purpose = 'proposer_confirm' ORDER BY id", [e.item_version_id]);
      if (itemTasks.length > 1) throw internalError('条目版本有多个提出人确认任务');
      const task = itemTasks.length === 1 ? itemTasks[0] : null;
      const cur = task ? await core.latestRevision(q, task.id) : null;
      if (task && !cur) throw internalError('提出人确认任务没有修订');
      const frozenViews = await itemFrozenViews(q, e.item_version_id, pkgFrozen);
      m.items.push({
        item_version_id: e.item_version_id, code: row.code, version_no: row.version_no, content: row.content, quote_text: row.quote_text,
        batch_name: batch ? batch.name : null,
        proposer_name: row.proposer_name,
        proposer_member_name: row.proposer_member_id === null ? null : await memberNameOf(q, row.proposer_member_id),
        party_name: await partyNameOf(q, row.proposer_party_id),
        proposer_status: row.proposer_status, deny_reason: row.deny_reason,
        no_written_evidence: row.no_written_evidence === 1, no_evidence_reason: row.no_evidence_reason,
        proposer_rev_status: cur ? cur.status : null, // null = 没有提出人确认任务
        proposer_confirmation: cur ? await confirmationOf(q, cur.id) : null,
        attachments: frozenViews.main,
        extra_frozen: frozenViews.extra,
        history: await withHistoryExtras(q, await core.historyConfirmationsOf(q, pid, 'item_version', e.item_version_id)),
      });
    }
    // 必需确认人：本版本的全部确认任务，每个任务一行，取当前修订（latestRevision）
    m.tasks = [];
    const tasks = await q.all("SELECT id, party_id, purpose FROM sysbuild_confirm_tasks WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY id", [vid]);
    for (const t of tasks) {
      const cur = await core.latestRevision(q, t.id);
      if (!cur) throw internalError('确认任务没有修订');
      const revRows = await q.all(
        `SELECT id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, status_reason, created_by, created_at, updated_at
           FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no`,
        [t.id]
      );
      const revisions = [];
      for (const r of revRows) {
        revisions.push(Object.assign({}, r, {
          member_name: await memberNameOf(q, r.required_member_id),
          created_by_name: await userNameOf(q, r.created_by),
          confirmation: await q.get('SELECT method, decision, created_at FROM sysbuild_confirmations WHERE task_revision_id = ?', [r.id]) || null,
        }));
      }
      m.tasks.push({
        task_id: t.id, purpose: t.purpose, party_name: await partyNameOf(q, t.party_id), current: cur,
        member_name: await memberNameOf(q, cur.required_member_id), proxy_only: await core.isProxyOnlyMember(q, cur.required_member_id),
        confirmation: await confirmationOf(q, cur.id), revisions,
      });
    }
    m.histConfs = await withHistoryExtras(q, await core.historyConfirmationsOf(q, pid, 'package_version', vid));
    return m;
  }

  // ── GET /sysbuild/package-versions/:vid/confirmation-sheet ───────────────────────────────────
  function sendSheet(res, body) {
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.send(body);
  }
  router.get('/sysbuild/package-versions/:vid/confirmation-sheet', handle(async (req, res) => {
    const vid = rules.parseId(req.params.vid);
    if (!vid) throw invalid('版本编号不合法', 'vid');
    const now = nowOf();
    // 读锁里只取数；渲染是纯函数（renderPage 不碰库），放在锁外执行。
    const model = await db.withRead((q) => loadModel(q, vid, req.user, now));
    sendSheet(res, toText(renderPage(model)));
  }));

  return { router, _internals: INTERNALS };
}

// 供用例直接测的内部件（派单 2.4：转义助手放进模块 _internals 导出；映射函数同）。
const INTERNALS = {
  html, esc, toText, fmtTime, fmtNow, badgeText,
  maps: {
    packageType: mapPackageType, form: mapForm, revisionStatus: mapRevisionStatus, method: mapMethod, decision: mapDecision,
    proposerStatus: mapProposerStatus, purpose: mapPurpose, layer: mapLayer, identity: mapIdentity,
  },
};

module.exports = { createConfirmationSheetRoutes, _internals: INTERNALS };
