const API_URL = '/api';

function getToken() {
    return localStorage.getItem('token');
}

function getAuthHeaders() {
    return {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
    };
}

async function checkAuth() {
    const token = getToken();
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }

    try {
        const res = await fetch(`${API_URL}/auth/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const user = await res.json();
            if (user.role !== 'admin') {
                alert('需要管理员权限');
                window.location.href = '/Task_Pool.html';
                return false;
            }
            return true;
        } else {
            logout();
            return false;
        }
    } catch (e) {
        logout();
        return false;
    }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login.html';
}

function showMessage(text, isSuccess) {
    const msg = document.getElementById('message');
    msg.textContent = text;
    msg.className = 'message ' + (isSuccess ? 'success' : 'error');
    setTimeout(() => { msg.className = 'message'; }, 3000);
}

// ==================== 域管理逻辑 ====================

async function loadDomains() {
    try {
        const res = await fetch(`${API_URL}/domains`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) {
            throw new Error('加载失败');
        }
        const domains = await res.json();
        renderDomains(domains);
    } catch (e) {
        document.getElementById('domainList').innerHTML =
            '<tr><td colspan="6" style="text-align:center;color:#e53e3e;">加载失败</td></tr>';
    }
}

function renderDomains(domains) {
    const tbody = document.getElementById('domainList');
    const countEl = document.getElementById('domainCount');

    // 更新统计 (只统计启用的)
    const activeCount = domains.filter(d => d.status !== 'deprecated').length;
    if (countEl) countEl.textContent = activeCount;

    if (domains.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">
                    <div class="icon">🌐</div>
                    <div>暂无业务域，请添加第一个业务域</div>
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = domains.map(d => {
        const isDeprecated = d.status === 'deprecated';
        const statusBadge = isDeprecated
            ? '<span class="status-badge status-deprecated">已停用</span>'
            : '<span class="status-badge status-active">启用中</span>';
        const rowClass = isDeprecated ? 'domain-row-deprecated' : '';

        return `
        <tr class="${rowClass}">
            <td style="color: #718096; font-weight: 500;">#${d.id}</td>
            <td><span class="domain-code">${escapeHtml(d.code)}</span></td>
            <td class="domain-name">${escapeHtml(d.name)}</td>
            <td class="domain-desc">${escapeHtml(d.description || '-')}</td>
            <td style="text-align: center;">${statusBadge}</td>
            <td style="text-align: center;">
                <div style="display: inline-flex; gap: 6px;">
                    <button class="btn-edit" onclick='openEditModal(${JSON.stringify(d)})'><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:2px;"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>编辑</button>
                    <button class="btn-delete" onclick="deleteDomain(${d.id})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:2px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>删除</button>
                </div>
            </td>
        </tr>
    `}).join('');
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function createDomain() {
    const code = document.getElementById('newDomCode').value.trim();
    const name = document.getElementById('newDomName').value.trim();
    const description = document.getElementById('newDomDesc').value.trim();

    if (!code || !name) {
        return showMessage('代码和名称必填', false);
    }

    try {
        const res = await fetch(`${API_URL}/domains`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ code, name, description })
        });
        const data = await res.json();

        if (res.ok) {
            showMessage('域添加成功', true);
            document.getElementById('newDomCode').value = '';
            document.getElementById('newDomName').value = '';
            document.getElementById('newDomDesc').value = '';
            loadDomains();
        } else {
            showMessage(data.error || '添加失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function deleteDomain(id) {
    if (!confirm('确定要删除该业务域吗？\n\n提示：如果只是不想在新模型中使用，建议选择"编辑"并将状态改为"已停用"。')) return;

    try {
        const res = await fetch(`${API_URL}/domains/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('域已删除', true);
            loadDomains();
        } else {
            showMessage('删除失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// ==================== 编辑模态框逻辑 ====================

function openEditModal(domain) {
    document.getElementById('editDomainId').value = domain.id;
    document.getElementById('editDomCode').value = domain.code;
    document.getElementById('editDomName').value = domain.name;
    document.getElementById('editDomDesc').value = domain.description || '';
    document.getElementById('editDomStatus').value = domain.status || 'active';

    document.getElementById('editModal').style.display = 'flex';
}

function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
}

async function saveDomain() {
    const id = document.getElementById('editDomainId').value;
    const name = document.getElementById('editDomName').value.trim();
    const description = document.getElementById('editDomDesc').value.trim();
    const status = document.getElementById('editDomStatus').value;

    if (!name) {
        return showMessage('域名称不能为空', false);
    }

    try {
        const res = await fetch(`${API_URL}/domains/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name, description, status })
        });
        const data = await res.json();

        if (res.ok) {
            showMessage('域更新成功', true);
            closeEditModal();
            loadDomains();
        } else {
            showMessage(data.error || '更新失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 点击模态框外部关闭
document.addEventListener('click', (e) => {
    const modal = document.getElementById('editModal');
    if (e.target === modal) {
        closeEditModal();
    }
});

// 页面加载
document.addEventListener('DOMContentLoaded', async () => {
    const auth = await checkAuth();
    if (auth) {
        loadDomains();
    }
});
