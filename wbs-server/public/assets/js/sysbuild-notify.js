/* PM 通知处理与附件记录；附件更新不自动重开确认任务。 */
(function () {
    'use strict';
    const A = window.SysBuildUI;
    const purposes = { confirm_request: '发起确认', confirm_reissue: '改发确认', decision_objected: '异议 / 不认可告知 PM', invitation: '加入 / 任职邀请', delegation_accept: '请本人接受授权', schedule_notice: '改期知会' };
    const statuses = { pending: '待发送', sent: '已发送', failed: '发送失败' };
    function intentLink(detail, row) {
        if (row.ref_type === 'confirm_revision') return A.link('核对对应修订', { rev: row.ref_id });
        if (row.ref_type === 'invitation') return A.link('核对邀请', { invitation: row.ref_id });
        if (row.ref_type === 'delegation') return A.link('核对授权', { delegation: row.ref_id });
        if (row.ref_type === 'notice') return A.link('核对知会', { notice: row.ref_id });
        return A.link('打开项目', { project: detail.project.id });
    }
    async function notificationsTab(detail, params, c) {
        const status = params.get('send_status') || '';
        const data = await A.request('/projects/' + detail.project.id + '/send-intents' + (status ? '?status=' + encodeURIComponent(status) : ''), null, c);
        const host = A.el('div');
        const controls = A.row();
        if (data.actions.resend === true) controls.appendChild(A.command('补发失败及超时待发通知', async (cc) => {
            const result = await A.request('/projects/' + detail.project.id + '/send-intents/resend', { method: 'POST', body: {} }, cc);
            const rendering = A.render();
            const next = A.context();
            await rendering;
            A.assertCurrent(next);
            A.notice('本次补发完成，请核对通知列表。成功：' + (result.counts.sent || 0) + '；失败：' + (result.counts.failed || 0) + '；跳过：' + (result.counts.skipped || 0));
        }, 'primary', c));
        host.appendChild(A.panel('通知发送与线下通知', [A.facts([['补发可处理的失败 / 超时', data.failed_count + ' 条'], ['需要线下通知', data.needs_offline_count + ' 条']]), A.hint('发送失败不改变业务决定。补发会重核当前收件资格；无账号负责人须线下通知，补发不能清除该类事项。')], controls));
        host.appendChild(A.panel('筛选发送意图', [A.row(A.link('全部', { project: detail.project.id, tab: 'notifications' }), ...Object.entries(statuses).map(([key, title]) => A.link(title, { project: detail.project.id, tab: 'notifications', send_status: key })))]));
        host.appendChild(A.panel('发送意图与结果', [A.table(['用途', '收件人', '结果', '次数 / 最近时间', '最近原因', '关联记录'], data.items.map((row) => [purposes[row.purpose] || '业务通知', row.recipient_name, statuses[row.status] || row.status, row.attempts + ' 次 · ' + row.updated_at, row.last_error || '—', intentLink(detail, row)]))]));
        host.appendChild(A.panel('需线下通知 · 无平台账号', [A.table(['用途', '原因', '最近记录时间', '操作'], data.offline_items.map((row) => [purposes[row.purpose] || '业务通知', row.last_error, row.updated_at, A.link('核对知会与原改期', { notice: row.notice_id })]))]));
        return host;
    }
    async function manageAttachment(id, c, onUpdated) {
        const lease = A.reserveDialog(c);
        const result = await A.request('/attachments/' + A.id(id), null, lease);
        A.assertCurrent(lease);
        const att = result.attachment;
        if (onUpdated) onUpdated(att);
        const form = A.dialog('附件记录 #' + att.attachment_id, [], async () => {}, '关闭记录', lease);
        const name = att.masked ? '已遮蔽的附件' : att.name || '附件';
        form.prepend(A.panel(name, [A.facts([['上传人', att.uploaded_by_name || att.uploaded_by], ['上传时间', att.staged_at], ['大小', Math.ceil(att.size / 1024) + ' KB'], ['已冻结', att.frozen ? '是' : '否'], ['作为原始凭据', att.evidence_bound ? '是' : '否'], ['当前状态', att.deleted ? '已软删除' : att.masked ? '已遮蔽' : '可复核']]),
            att.masked ? A.facts([['遮蔽原因', att.mask_reason], ['操作人', att.masked_by_name || att.masked_by], ['遮蔽时间', att.masked_at]]) : null,
            att.deleted ? A.facts([['删除人', att.deleted_by_name || att.deleted_by], ['删除时间', att.deleted_at]]) : null,
            A.disclosure('SHA-256 文件校验值', A.el('code', 'sbui-mono', att.sha256)),
        ]));
        const ops = A.row();
        if (att.actions.download === true) ops.appendChild(A.command(att.masked ? '按受控文件名下载' : '下载原文件', () => A.openAttachment(att, lease, true), '', lease));
        if (att.actions.preview === true) ops.appendChild(A.command(att.masked ? '受控图片预览' : '图片预览', () => A.openAttachment(att, lease, false), '', lease));
        async function refreshCard(cc, message) {
            const fresh = await A.request('/attachments/' + att.attachment_id, null, cc);
            A.assertCurrent(c);
            if (onUpdated) onUpdated(fresh.attachment);
            A.notice(message);
        }
        if (att.actions.mask === true) ops.appendChild(A.button('受控遮蔽', () => {
            A.assertCurrent(lease);
            const next = A.dialog('遮蔽附件 #' + att.attachment_id, [{ name: 'reason', label: '遮蔽原因', type: 'textarea', required: true, max: 500, full: true }], async (v, cc) => {
                await A.request('/attachments/' + att.attachment_id + '/mask', { method: 'POST', body: { reason: v.reason } }, cc);
                await refreshCard(cc, '已受控遮蔽该附件。冻结清单与原确认记录保持可复核。');
            }, '确认受控遮蔽');
            next.prepend(A.hint('普通成员将只看到遮蔽原因、操作人、时间与校验值；原文件由管理员按受控文件名复核。'));
        }, 'danger'));
        if (att.actions.delete === true) ops.appendChild(A.button('软删除附件', () => {
            A.assertCurrent(lease);
            A.dialog('软删除附件 #' + att.attachment_id, [{ name: 'checked', label: '确认只标记软删除，磁盘原文件仍保留', type: 'checkbox', required: true, full: true }], async (v, cc) => {
                if (!v.checked) throw new Error('请明确勾选后再提交');
                await A.request('/attachments/' + att.attachment_id + '/delete', { method: 'POST', body: {} }, cc);
                await refreshCard(cc, '已标记软删除。该记录与删除人继续留存。');
            }, '确认软删除');
        }, 'danger'));
        form.appendChild(ops);
    }
    A.manageAttachment = manageAttachment;
    A.registerTab('notifications', '通知处理', notificationsTab, (detail) => detail.actions.view_send_intents === true);
}());
