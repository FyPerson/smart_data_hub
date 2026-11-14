/* 项目管理共用界面层。所有用户数据经 textContent / DOM 属性写入。 */
(function () {
    'use strict';
    const routes = new Map();
    const tabs = new Map();
    const controllers = new Set();
    const urls = new Set();
    const disposers = new Set();
    const state = { session: 0, view: 0, dialog: 0, dialogLease: null, token: null, userId: null, user: null, route: null, detail: null, plan: null };
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    };
    function append(parent, children) {
        for (const child of children.flat(Infinity)) {
            if (child === null || child === undefined || child === false) continue;
            parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return parent;
    }
    const row = (...children) => append(el('div', 'sbui-row'), children);
    const text = (value) => el('span', '', value == null || value === '' ? '—' : value);
    const hint = (value) => value === undefined || value === null || value === '' ? null : el('p', 'sbui-hint', value);
    function button(label, fn, cls) {
        const shared = cls === 'primary' ? 'u-btn-primary' : cls === 'danger' ? 'u-btn-danger' : 'u-btn-secondary';
        const n = el('button', 'sbui-btn ' + shared + (cls ? ' ' + cls : ''), label);
        n.type = 'button';
        if (fn) n.addEventListener('click', (event) => {
            try {
                const result = fn(event);
                if (result && typeof result.then === 'function') result.catch((err) => fail(err));
            } catch (err) { fail(err); }
        });
        return n;
    }
    function link(label, params, cls) {
        const shared = cls === 'primary' ? 'u-btn-primary' : 'u-btn-secondary';
        const n = el('a', 'sbui-btn ' + shared + (cls ? ' ' + cls : ''), label);
        n.href = '#' + new URLSearchParams(params).toString();
        return n;
    }
    function panel(title, children, actions) {
        const n = el('section', 'sbui-panel');
        if (title) n.appendChild(append(el('header', 'sbui-panel-head'), [el('h2', '', title), actions || null]));
        if (children) n.appendChild(append(el('div', 'sbui-panel-body'), Array.isArray(children) ? children : [children]));
        return n;
    }
    function table(headers, rows) {
        const t = el('table', 'sbui-table u-corr-table');
        t.appendChild(append(el('thead'), [append(el('tr'), headers.map((h) => el('th', '', h)))]));
        const body = el('tbody');
        for (const cells of rows) body.appendChild(append(el('tr'), cells.map((v) => append(el('td'), [v]))));
        if (rows.length === 0) {
            const cell = el('td', 'sbui-state', '暂无记录');
            cell.colSpan = headers.length;
            body.appendChild(append(el('tr'), [cell]));
        }
        t.appendChild(body);
        return append(el('div', 'sbui-table-wrap'), [t]);
    }
    function facts(values) {
        const n = el('div', 'sbui-facts');
        for (const [label, value] of values) n.appendChild(append(el('div', 'sbui-fact'), [el('span', 'sbui-label', label), value instanceof Node ? value : text(value)]));
        return n;
    }
    function disclosure(title, content) {
        const n = el('details');
        return append(n, [el('summary', '', title), append(el('div', 'sbui-stack'), Array.isArray(content) ? content : [content])]);
    }
    class StaleView extends Error { constructor() { super('页面或登录身份已变化，请刷新后查看当前结果'); this.stale = true; } }
    function context() { return { session: state.session, view: state.view, token: state.token, userId: state.userId }; }
    function valid(c) {
        return !!c && c.session === state.session && c.view === state.view && c.userId === state.userId && c.token === state.token && localStorage.getItem('token') === c.token && (c.dialog === undefined || c.dialog === state.dialog);
    }
    function disposeInvalid() {
        for (const entry of Array.from(disposers)) if (!valid(entry.context)) {
            try { entry.run(); } catch (err) { console.error('项目管理界面资源清理失败：' + err.message); }
        }
    }
    function onDispose(c, fn) {
        assertCurrent(c);
        const entry = { context: c, run: () => { if (disposers.delete(entry)) fn(); } };
        disposers.add(entry);
        return entry.run;
    }
    function releaseUrl(url) {
        if (urls.delete(url)) URL.revokeObjectURL(url);
    }
    function assertCurrent(c) {
        if (c && c.session === state.session && c.token === state.token && localStorage.getItem('token') !== c.token) {
            clearSession();
            $('sbuiView').appendChild(panel('登录身份已变化', [hint('已清除当前页面内容，请重新加载。'), button('重新加载', () => location.reload())]));
        }
        if (!valid(c)) throw new StaleView();
    }
    function clearView() {
        state.view += 1;
        state.dialog += 1;
        state.dialogLease = null;
        disposeInvalid();
        for (const c of controllers) c.abort();
        controllers.clear();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
        state.detail = null;
        state.plan = null;
        const dlg = $('sbuiDialog');
        if (dlg && dlg.open) dlg.close();
        if ($('sbuiDialogContent')) $('sbuiDialogContent').replaceChildren();
        if ($('sbuiNotice')) $('sbuiNotice').replaceChildren();
        if ($('sbuiView')) $('sbuiView').replaceChildren();
    }
    function clearSession() {
        state.session += 1;
        clearView();
        state.token = null;
        state.userId = null;
        state.user = null;
        if ($('sbuiNav')) $('sbuiNav').replaceChildren();
    }
    function notice(message, error) {
        $('sbuiNotice').replaceChildren(message ? el('div', 'sbui-notice' + (error ? ' error' : ''), message) : document.createTextNode(''));
    }
    function errorText(err) {
        const b = err && err.body;
        const first = b && (b.message || b.error) || err && err.message || '操作失败，请稍后重试';
        const blocks = b && Array.isArray(b.blockers) ? b.blockers : [];
        return String(first) + (blocks.length ? '\n' + blocks.map((x) => typeof x === 'string' ? x : x.message || x.label || JSON.stringify(x)).join('\n') : '');
    }
    async function request(path, options, ctx) {
        const c = ctx || context();
        assertCurrent(c);
        const o = options || {};
        const controller = new AbortController();
        controllers.add(controller);
        const headers = { Authorization: 'Bearer ' + c.token };
        const init = { method: o.method || 'GET', signal: controller.signal, headers };
        if (o.body !== undefined) {
            if (o.body instanceof FormData) init.body = o.body;
            else { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
        }
        try {
            const res = await fetch((o.platform ? '/api' : '/api/sysbuild') + path, init);
            assertCurrent(c);
            if (res.status === 401) {
                clearSession();
                logout();
                throw new StaleView();
            }
            let body;
            if (o.format === 'blob') body = await res.blob();
            else if (o.format === 'text') body = await res.text();
            else {
                try { body = await res.json(); } catch (_) { body = null; }
            }
            assertCurrent(c);
            if (!res.ok) {
                const err = new Error(body && (body.message || body.error) || '请求失败（' + res.status + '）');
                err.status = res.status; err.body = body;
                throw err;
            }
            return body;
        } finally { controllers.delete(controller); }
    }
    function fail(err, ctx, target) {
        if (err && (err.stale || err.name === 'AbortError') || ctx && !valid(ctx)) return;
        const msg = errorText(err);
        if (target) target.textContent = msg;
        else notice(msg, true);
        if (err && (err.status === 403 || err.status === 404) && state.route && state.route.get('project')) {
            clearView();
            $('sbuiView').appendChild(panel('当前操作不可用', [hint(msg), link('返回项目列表', {})]));
        }
    }
    function field(def) {
        if (def.type === 'checklist') {
            const control = el('fieldset', 'sbui-check-options' + (def.full ? ' sbui-full' : ''));
            control.name = def.name;
            control.appendChild(el('legend', 'sbui-label', def.label + (def.required ? '（必填）' : '')));
            const inputs = [];
            for (const [value, title] of def.options || []) {
                const input = el('input'); input.type = 'checkbox'; input.name = def.name + '[]'; input.value = String(value);
                input.checked = Array.isArray(def.value) && def.value.map(String).includes(String(value));
                control.appendChild(append(el('label'), [input, el('span', '', title)])); inputs.push(input);
            }
            if (!inputs.length) control.appendChild(hint('暂无可选项'));
            if (def.hint) control.appendChild(hint(def.hint));
            return { label: control, control, def, readValue: () => inputs.filter((input) => input.checked).map((input) => input.value) };
        }
        const label = el('label', def.full ? 'sbui-full' : '');
        const control = el(def.options ? 'select' : def.type === 'textarea' ? 'textarea' : 'input');
        if (!def.options && def.type !== 'textarea') control.type = def.type || 'text';
        control.name = def.name;
        control.required = def.required === true;
        if (def.max !== undefined) control.maxLength = def.max;
        if (def.min !== undefined) control.min = def.min;
        if (def.multiple) control.multiple = true;
        if (def.accept) control.accept = def.accept;
        if (def.options) for (const [v, labelText] of def.options) {
            const opt = el('option', '', labelText); opt.value = String(v); control.appendChild(opt);
        }
        if (def.value !== undefined && def.type !== 'file') control.value = def.value == null ? '' : String(def.value);
        if (def.type === 'checkbox') control.checked = def.value === true;
        if (def.placeholder) control.placeholder = def.placeholder;
        append(label, [el('span', 'sbui-label', def.label + (def.required ? '（必填）' : '')), control, def.hint ? hint(def.hint) : null]);
        return { label, control, def };
    }
    function form(defs, submit, label, ctx, tone) {
        const c = ctx || context();
        const f = el('form');
        const grid = el('div', 'sbui-form-grid');
        const fields = defs.map(field);
        fields.forEach((x) => { grid.appendChild(x.label); if (window.SysBuildUI.mountEvidenceField) window.SysBuildUI.mountEvidenceField(x, c); });
        if (window.SysBuildUI.bindEvidenceFields) window.SysBuildUI.bindEvidenceFields(fields);
        const error = el('p', 'sbui-error'); error.setAttribute('role', 'alert');
        const save = button(label || '保存', null, tone === undefined ? 'primary' : tone); save.type = 'submit';
        append(f, [grid, error, append(el('div', 'sbui-form-actions'), [save])]);
        let busy = false;
        f.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (busy || !f.reportValidity()) return;
            try { assertCurrent(c); } catch (err) { fail(err, c, error); return; }
            const values = Object.fromEntries(fields.map(({ control, def, readValue }) => [def.name, readValue ? readValue() : def.type === 'file' ? Array.from(control.files || []) : def.type === 'checkbox' ? control.checked : control.value]));
            const missing = fields.find(({ def }) => def.required === true && Array.isArray(values[def.name]) && values[def.name].length === 0);
            if (missing) { fail(new Error('请选择' + missing.def.label), c, error); return; }
            error.textContent = '';
            const disabledStates = fields.map(({ control }) => control.disabled);
            busy = true; save.disabled = true;
            save.textContent = '正在提交…';
            f.dataset.submitting = 'true';
            const closeButton = f.closest('dialog') && f.closest('dialog').querySelector('[data-sbui-close]');
            if (closeButton) closeButton.disabled = true;
            fields.forEach(({ control }) => { control.disabled = true; });
            try { await submit(values, c); }
            catch (err) { fail(err, c, error); }
            finally {
                busy = false;
                f.dataset.submitting = 'false';
                if (valid(c) && f.isConnected) { save.disabled = false; save.textContent = label || '保存'; if (closeButton) closeButton.disabled = false; fields.forEach(({ control }, index) => { control.disabled = disabledStates[index]; }); }
            }
        });
        return f;
    }
    function reserveDialog(parent) {
        assertCurrent(parent || context());
        state.dialog += 1;
        disposeInvalid();
        return Object.assign(context(), { dialog: state.dialog });
    }
    function closeDialog() {
        const dlg = $('sbuiDialog');
        if (dlg.querySelector('form[data-submitting="true"]')) return;
        state.dialog += 1;
        state.dialogLease = null;
        disposeInvalid();
        if (dlg.open) dlg.close();
    }
    function dialog(title, defs, submit, label, lease) {
        const c = lease || reserveDialog();
        assertCurrent(c);
        const dlg = $('sbuiDialog');
        state.dialogLease = c;
        const titleNode = el('h2', '', title); titleNode.id = 'sbuiDialogTitle';
        const close = button('关闭', closeDialog);
        close.dataset.sbuiClose = 'true';
        const f = form(defs, async (values) => {
            await submit(values, c);
            if (valid(c) && dlg.open) {
                state.dialog += 1;
                state.dialogLease = null;
                disposeInvalid();
                dlg.close();
            }
        }, label, c);
        $('sbuiDialogContent').replaceChildren(append(el('header', 'sbui-panel-head'), [titleNode, close]), append(el('div', 'sbui-panel-body'), [f]));
        if (!dlg.open) dlg.showModal();
        return f;
    }
    async function stageFiles(projectId, files, c) {
        const ids = [];
        for (const file of files) {
            assertCurrent(c);
            const data = new FormData(); data.append('file', file);
            const result = await request('/projects/' + projectId + '/attachments/stage', { method: 'POST', body: data }, c);
            ids.push(result.attachment.id);
        }
        return ids;
    }
    async function perform(btn, path, body, method) {
        if (btn.disabled) return;
        const c = context();
        btn.disabled = true;
        try { await request(path, { method: method || 'POST', body }, c); await render(); }
        catch (err) { fail(err, c); }
        finally { if (valid(c) && btn.isConnected) btn.disabled = false; }
    }
    function command(label, work, cls, ctx) {
        const c = ctx || context();
        const b = button(label, async () => {
            if (b.disabled) return;
            b.disabled = true;
            try { assertCurrent(c); await work(c); }
            catch (err) { fail(err, c); }
            finally { if (valid(c) && b.isConnected) b.disabled = false; }
        }, cls);
        return b;
    }
    function navigate(params) {
        const next = new URLSearchParams(params).toString();
        if (location.hash.slice(1) === next) render().catch((err) => fail(err));
        else location.hash = next;
    }
    function setView(node, ctx) {
        assertCurrent(ctx);
        $('sbuiView').replaceChildren(node);
        $('sbuiView').setAttribute('aria-busy', 'false');
    }
    async function render() {
        clearView();
        const c = context();
        const params = new URLSearchParams(location.hash.slice(1));
        state.route = params;
        $('sbuiView').setAttribute('aria-busy', 'true');
        $('sbuiView').appendChild(el('p', 'sbui-state', '正在加载…'));
        const key = params.has('invitation') ? 'invitation' : params.has('delegation') ? 'delegation' : params.has('rev') ? 'revision' : params.has('notice') ? 'notice' : params.has('task') ? 'task' : params.has('new') ? 'new' : params.has('help') ? 'help' : params.has('todo') ? 'todo' : params.has('project') ? 'project' : 'list';
        const moduleTab = key === 'help' ? 'help' : ['todo', 'task', 'revision', 'notice', 'invitation', 'delegation'].includes(key) ? 'todo' : 'list';
        for (const anchor of $('sbuiNav').querySelectorAll('a')) {
            const route = new URLSearchParams(anchor.hash.slice(1));
            const tab = route.has('help') ? 'help' : route.has('todo') ? 'todo' : 'list';
            if (tab === moduleTab) anchor.setAttribute('aria-current', 'page'); else anchor.removeAttribute('aria-current');
        }
        const handler = routes.get(key);
        try {
            if (!handler) throw new Error('该页面尚未就绪');
            const node = await handler(params, c);
            if (node) setView(node, c);
        } catch (err) {
            if (valid(c)) { $('sbuiView').replaceChildren(); $('sbuiView').setAttribute('aria-busy', 'false'); fail(err, c); }
        }
    }
    async function init() {
        const ok = await checkAuth();
        if (!ok) return;
        state.token = localStorage.getItem('token');
        state.user = currentUser;
        state.userId = Number(currentUser.id);
        // C6 通知链接用 query。首次接入后统一成 hash 并移除 query，之后返回列表不会重新打开旧通知。
        if (!location.hash && location.search) history.replaceState(null, '', location.pathname + '#' + location.search.slice(1));
        $('sbuiNav').replaceChildren(link('项目列表', {}), link('我的待办', { todo: '1' }), link('帮助', { help: '1' }));
        await render();
    }
    window.addEventListener('hashchange', () => { render().catch((err) => fail(err)); });
    window.addEventListener('storage', (e) => {
        if (e.key !== 'token' && e.key !== 'user' && e.key !== null) return;
        clearSession();
        $('sbuiView').appendChild(panel('登录身份已变化', [hint('已清除当前页面内容，请重新加载。'), button('重新加载', () => location.reload())]));
    });
    window.addEventListener('pagehide', clearSession);
    window.addEventListener('pageshow', (e) => { if (e.persisted) init().catch((err) => fail(err)); });
    $('sbuiDialog').addEventListener('cancel', (event) => {
        if ($('sbuiDialog').querySelector('form[data-submitting="true"]')) { event.preventDefault(); return; }
        state.dialog += 1;
        state.dialogLease = null;
        disposeInvalid();
    });
    $('sbuiDialog').addEventListener('close', () => {
        if ($('sbuiDialog').open) return;
        if (state.dialogLease && state.dialogLease.dialog === state.dialog) state.dialog += 1;
        state.dialogLease = null;
        disposeInvalid();
        $('sbuiDialogContent').replaceChildren();
    });
    window.SysBuildUI = { state, $, el, append, row, text, hint, button, link, panel, table, facts, disclosure, context, valid, assertCurrent, request, fail, errorText, notice, form, dialog, reserveDialog, closeDialog, stageFiles, perform, command, navigate, render, onDispose, releaseUrl,
        registerRoute: (key, fn) => routes.set(key, fn), registerTab: (key, label, fn, visible) => tabs.set(key, { label, render: fn, visible }), tabs,
        objectUrl: (blob) => { const u = URL.createObjectURL(blob); urls.add(u); return u; },
        id: (raw) => { if (!/^[1-9][0-9]*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) throw new Error('编号不合法'); return Number(raw); },
    };
    document.addEventListener('DOMContentLoaded', () => init().catch((err) => fail(err)));
}());
