/* 项目管理附件、截图粘贴与确认单；资源随页面和弹窗生命周期清理。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    let sequence = 0;
    function imageDialog(url, name, c, ownUrl) {
        A.assertCurrent(c);
        const dlg = A.el('dialog', 'sbui-lightbox');
        const img = A.el('img'); img.src = url; img.alt = name || '附件图片';
        const close = A.button('关闭图片预览', () => dlg.close());
        const finish = () => {
            if (dlg.open) dlg.close();
            dlg.remove();
            if (ownUrl) A.releaseUrl(url);
        };
        dlg.appendChild(A.row(A.el('strong', '', name || '图片预览'), close));
        dlg.appendChild(img);
        document.body.appendChild(dlg);
        const dispose = A.onDispose(Object.assign({}, c, { dialog: A.state.dialog }), finish);
        dlg.addEventListener('close', dispose, { once: true });
        dlg.showModal();
    }
    function mountEvidenceField(field, c) {
        const { control, label } = field;
        if (control.type !== 'file') return;
        if (!window.UPaste || !window.UPaste.checkVersion('upaste3', '项目管理')) throw new Error('附件粘贴组件未就绪，请刷新后重试');
        const key = 'sbui-evidence-' + (++sequence);
        const list = A.el('div', 'sbui-evidence-list'); list.id = key;
        list.tabIndex = 0;
        list.setAttribute('aria-label', '截图粘贴区：' + field.def.label);
        label.appendChild(list);
        label.appendChild(A.hint('可选文件或 Ctrl+V 粘贴 PNG、JPEG、GIF、WebP 截图。附件随本次提交上传；上传后24小时未完成提交会失效，需重新上传。'));
        let files = [];
        let localUrls = [];
        let disposed = false;
        function activeScope() {
            if (disposed || !A.valid(c) || control.disabled || !control.isConnected) return false;
            const dialog = A.$('sbuiDialog');
            if (dialog.open && !dialog.contains(label)) return false;
            if (document.querySelector('.sbui-lightbox[open]')) return false;
            return true;
        }
        const clearUrls = () => { localUrls.forEach(A.releaseUrl); localUrls = []; };
        function sync() {
            const data = new DataTransfer(); files.forEach((file) => data.items.add(file));
            control.files = data.files;
        }
        function draw() {
            clearUrls(); list.replaceChildren();
            if (!files.length) list.appendChild(A.hint('尚未选择附件'));
            files.forEach((file, index) => {
                const item = A.el('div', 'sbui-evidence-file');
                if (IMAGE_TYPES.has(file.type)) {
                    const url = A.objectUrl(file); localUrls.push(url);
                    const image = A.el('img', 'sbui-thumbnail'); image.src = url; image.alt = '';
                    const preview = A.button('预览 ' + file.name, () => { A.assertCurrent(c); imageDialog(A.objectUrl(file), file.name, c, true); });
                    preview.appendChild(image); item.appendChild(preview);
                }
                item.appendChild(A.text(file.name + ' · ' + Math.ceil(file.size / 1024) + ' KB'));
                item.appendChild(A.button('移除 ' + file.name, () => {
                    A.assertCurrent(c);
                    if (control.disabled || disposed) return;
                    files.splice(index, 1); sync(); draw();
                }));
                list.appendChild(item);
            });
        }
        function collect(incoming, paste) {
            A.assertCurrent(c);
            if (disposed || control.disabled) return 0;
            let accepted = 0;
            for (const file of incoming) {
                if (paste && !IMAGE_TYPES.has(file.type)) { A.notice('该图片格式暂不支持，请使用 PNG、JPEG、GIF 或 WebP。', true); continue; }
                if (files.length >= 20) { A.notice('一次最多选择 20 个附件。', true); break; }
                if (files.some((old) => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified && old.type === file.type)) continue;
                files.push(file); accepted += 1;
            }
            sync(); draw();
            return accepted;
        }
        control.addEventListener('change', () => { try { collect(Array.from(control.files || []), false); } catch (err) { A.fail(err, c); } });
        window.UPaste.resetSeq(key);
        const unregister = window.UPaste.register({
            scopeResolver: () => activeScope() ? label : { querySelectorAll: () => [] },
            selector: '.sbui-evidence-list', keyOf: () => key,
            isImageArea: () => activeScope(),
            clickScopeOf: () => label,
            collect: (givenKey, incoming) => givenKey === key ? collect(incoming, true) : 0,
            namePrefix: '项目截图_',
        });
        A.onDispose(c, () => { disposed = true; unregister(); window.UPaste.resetSeq(key); clearUrls(); files = []; });
        draw();
    }
    async function showAttachment(att, c, download) {
        A.assertCurrent(c);
        const id = A.id(att.attachment_id || att.id);
        const image = IMAGE_TYPES.has(att.mime_type) || att.is_image === 1 || att.is_image === true;
        const blob = await A.request('/attachments/' + id + (image && !download ? '/preview' : '/download'), { format: 'blob' }, c);
        A.assertCurrent(c);
        const url = A.objectUrl(blob);
        if (image && !download) { imageDialog(url, att.name || att.original_name, c, true); return; }
        const a = A.el('a'); a.href = url; a.download = att.name || att.original_name || 'attachment-' + id;
        a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
        A.onDispose(c, () => A.releaseUrl(url));
    }
    function attachmentList(rows, c) {
        const host = A.el('div', 'sbui-evidence-list');
        if (!rows || !rows.length) { host.appendChild(A.hint('无附件')); return host; }
        rows.forEach((att) => {
            const body = A.el('div', 'sbui-evidence-file');
            let currentBody = body;
            const id = A.id(att.attachment_id || att.id);
            if (att.missing === true) {
                body.appendChild(A.el('strong', '', '附件记录缺失 #' + id));
            } else if (att.masked === true || att.masked_at) {
                body.appendChild(A.el('strong', '', '已遮蔽的附件 #' + id));
                body.appendChild(A.facts([['遮蔽原因', att.mask_reason], ['操作人', att.masked_by_name || att.masked_by], ['遮蔽时间', att.masked_at]]));
                if (att.actions && att.actions.download === true) body.appendChild(A.command('按受控文件名下载', () => showAttachment(att, c, true), '', c));
                if (att.actions && att.actions.preview === true) body.appendChild(A.command('受控图片预览', () => showAttachment(att, c, false), '', c));
            } else if (att.deleted === true || att.deleted_at) {
                body.appendChild(A.text((att.name || att.original_name || '附件 #' + id) + ' · 已删除'));
                body.appendChild(A.hint('删除人：' + (att.deleted_by_name || att.deleted_by || '—') + '；时间：' + (att.deleted_at || '—')));
            } else {
                const name = att.name || att.original_name || '附件 #' + id;
                body.appendChild(A.command(name, () => showAttachment(att, c, false), '', c));
                if (IMAGE_TYPES.has(att.mime_type) || att.is_image === 1 || att.is_image === true) body.appendChild(A.command('下载原图', () => showAttachment(att, c, true), '', c));
                body.appendChild(A.hint((att.size == null ? '' : Math.ceil(att.size / 1024) + ' KB · ') + '附件 #' + id));
            }
            if (att.sha256) body.appendChild(A.disclosure('查看文件校验值', A.el('code', 'sbui-mono', att.sha256)));
            if (typeof A.manageAttachment === 'function') body.appendChild(A.command('查看附件记录', () => A.manageAttachment(id, c, (updated) => {
                A.assertCurrent(c);
                const replacement = attachmentList([Object.assign({}, att, updated)], c).firstElementChild;
                if (currentBody.isConnected) { currentBody.replaceWith(replacement); currentBody = replacement; }
            }), '', c));
            host.appendChild(body);
        });
        return host;
    }
    // 唯一 HTML 出口。只接受鉴权获取的服务端确认单；S10 须核此整段形态，不能对任意 srcdoc 放行。
    async function confirmationSheetFrame(vid, c) {
        const sheetHtml = await A.request('/package-versions/' + A.id(vid) + '/confirmation-sheet', { format: 'text' }, c);
        A.assertCurrent(c);
        const frame = A.el('iframe', 'sbui-sheet');
        frame.title = '需求确认单';
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.srcdoc = sheetHtml;
        const print = A.button('打印确认单 / 保存 PDF', () => { A.assertCurrent(c); if (!frame.isConnected || !frame.contentWindow) return; frame.contentWindow.focus(); frame.contentWindow.print(); });
        print.disabled = true;
        frame.addEventListener('load', () => {
            if (!A.valid(c) || !frame.isConnected) return;
            try { frame.style.height = Math.min(30000, Math.max(600, frame.contentDocument.documentElement.scrollHeight + 24)) + 'px'; print.disabled = false; }
            catch (_) { A.notice('确认单未完整载入，请刷新后重试。', true); }
        });
        A.onDispose(c, () => { print.disabled = true; frame.remove(); });
        return A.append(A.el('div', 'sbui-stack'), [A.row(print), frame]);
    }
    A.mountEvidenceField = mountEvidenceField;
    A.bindEvidenceFields = (fields) => {
        const declaration = fields.find(({ def }) => def.name === 'no_written_evidence');
        const reason = fields.find(({ def }) => def.name === 'no_evidence_reason');
        if (!declaration || !reason) return;
        const update = () => { reason.control.disabled = !declaration.control.checked; reason.control.required = declaration.control.checked; };
        declaration.control.addEventListener('change', update); update();
    };
    A.evidencePayload = (v) => ({ no_written_evidence: v.no_written_evidence === true, no_evidence_reason: v.no_written_evidence === true ? v.no_evidence_reason || null : null });
    A.attachmentList = attachmentList;
    A.openAttachment = showAttachment;
    A.confirmationSheetFrame = confirmationSheetFrame;
}());
