const API_URL = '/api';

/**
 * 统一日期格式化工具（支持 UTC 和本地时间自动转换）
 * @param {string|Date} dateInput - 日期字符串或 Date 对象
 * @param {string} style - 格式样式: 'full' | 'short' | 'dateOnly' | 'timeOnly'
 * @returns {string} 格式化后的日期字符串
 */
function formatDateTimeUnified(dateInput, style = 'full') {
    if (!dateInput) return '-';

    let d;
    if (dateInput instanceof Date) {
        d = dateInput;
    } else {
        // 服务器数据库存储的是本地时间（北京时间），直接解析显示
        let dateStr = String(dateInput);
        // 将 SQLite 格式转换为 ISO 格式（不添加 Z，保持本地时间）
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
            dateStr = dateStr.replace(' ', 'T');
        }
        d = new Date(dateStr);
    }

    if (isNaN(d.getTime())) return '无效时间';

    const options = {
        full: {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        },
        short: {
            month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        },
        dateOnly: { year: 'numeric', month: '2-digit', day: '2-digit' },
        timeOnly: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    };

    return d.toLocaleString('zh-CN', options[style] || options.full);
}

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
    // 使用固定浮动提示，无论滚动到哪里都能看到
    let toast = document.getElementById('adminToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'adminToast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            border-radius: 8px;
            color: white;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            transition: opacity 0.3s, transform 0.3s;
            opacity: 0;
            transform: translateX(100px);
        `;
        document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.style.background = isSuccess ? '#16a34a' : '#dc2626';
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100px)';
    }, 3000);

    // 同时更新原有的 message 元素（保持兼容）
    const msg = document.getElementById('message');
    if (msg) {
        msg.textContent = text;
        msg.className = 'message ' + (isSuccess ? 'success' : 'error');
        setTimeout(() => { msg.className = 'message'; }, 3000);
    }
}

async function loadUsers() {
    try {
        const res = await fetch(`${API_URL}/users`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error('加载失败');
        const users = await res.json();
        renderUsers(users);
    } catch (e) {
        document.getElementById('userList').innerHTML =
            '<tr><td colspan="9" style="text-align:center;color:#e53e3e;">加载失败</td></tr>';
    }
}

// 缓存最近一次 GET /api/users 的结果，用于编辑时按 id 查 remark/display_name 等（避免 inline onclick 字符串拼接 remark 时引号被吃）
let _adminUsersCache = [];

function escapeHtmlAdmin(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 角色徽章 class + label 映射（4 个角色：admin/publisher/user/viewer）
const ROLE_BADGE = {
    admin: { cls: 'badge-admin', label: '管理员' },
    publisher: { cls: 'badge-publisher', label: '发布者' },
    user: { cls: 'badge-user', label: '数据开发' },
    viewer: { cls: 'badge-viewer', label: '查看者' }
};

// 操作按钮里的小图标（不依赖外部图标库，单独 inline SVG）
const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const ICON_BAN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function renderUsers(users) {
    _adminUsersCache = users || [];
    const tbody = document.getElementById('userList');
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#a0aec0;">暂无用户</td></tr>';
        return;
    }

    tbody.innerHTML = users.map(user => {
        const phoneCell = user.phone
            ? `<span class="phone-value">${escapeHtmlAdmin(user.phone)}</span>${user.dingtalk_user_id ? '<span class="phone-dot" title="已缓存钉钉 userId"></span>' : ''}`
            : '<span class="empty-value">—</span>';
        const remarkCell = user.remark
            ? `<span class="cell-muted">${escapeHtmlAdmin(user.remark)}</span>`
            : '<span class="empty-value">—</span>';
        const roleInfo = ROLE_BADGE[user.role] || { cls: 'badge-user', label: user.role || '—' };
        const isActive = user.status === 'active';
        const statusBadge = `<span class="badge ${isActive ? 'badge-active' : 'badge-disabled'}">${isActive ? '启用' : '禁用'}</span>`;
        const toggleBtn = isActive
            ? `<button class="btn btn-danger" onclick="disableUser(${user.id})" title="禁用此用户">${ICON_BAN}禁用</button>`
            : `<button class="btn btn-success" onclick="enableUserById(${user.id})" title="启用此用户">${ICON_CHECK}启用</button>`;
        return `
                <tr>
                    <td class="cell-muted">${user.id}</td>
                    <td class="cell-username" title="${escapeHtmlAdmin(user.username)}">${escapeHtmlAdmin(user.username)}</td>
                    <td class="cell-muted">${escapeHtmlAdmin(user.display_name) || '<span class="empty-value">—</span>'}</td>
                    <td><span class="badge ${roleInfo.cls}">${roleInfo.label}</span></td>
                    <td>${phoneCell}</td>
                    <td>${remarkCell}</td>
                    <td>${statusBadge}</td>
                    <td><span class="cell-date">${formatDateTimeUnified(user.created_at)}</span></td>
                    <td class="action-btns">
                        <button class="btn btn-primary" onclick="openEditModalById(${user.id})" title="编辑此用户">${ICON_EDIT}编辑</button>
                        ${toggleBtn}
                    </td>
                </tr>
            `;
    }).join('');
}

async function createUser() {
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const display_name = document.getElementById('newDisplayName').value.trim();
    const role = document.getElementById('newRole').value;
    const phone = document.getElementById('newPhone').value.trim();
    const remarkEl = document.getElementById('newRemark');
    const remark = remarkEl ? remarkEl.value.trim() : '';

    if (!username || !password) {
        return showMessage('请填写用户名和密码', false);
    }

    try {
        const res = await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ username, password, display_name: display_name || username, role, phone, remark })
        });

        const data = await res.json();
        if (res.ok) {
            showMessage('用户创建成功', true);
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('newDisplayName').value = '';
            document.getElementById('newRole').value = 'user';
            document.getElementById('newPhone').value = '';
            if (remarkEl) remarkEl.value = '';
            loadUsers();
        } else {
            showMessage(data.error || '创建失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 通过 id 从缓存里取用户填编辑框（替代旧的 openEditModal 字符串拼接方式，避免 remark 含引号被吃）
function openEditModalById(id) {
    const u = _adminUsersCache.find(x => Number(x.id) === Number(id));
    if (!u) return showMessage('未找到用户', false);
    document.getElementById('editUserId').value = u.id;
    document.getElementById('editDisplayName').value = u.display_name || '';
    document.getElementById('editRole').value = u.role;
    document.getElementById('editStatus').value = u.status;
    document.getElementById('editPhone').value = u.phone || '';
    const remarkEl = document.getElementById('editRemark');
    if (remarkEl) remarkEl.value = u.remark || '';
    document.getElementById('editPassword').value = '';
    document.getElementById('editModal').style.display = 'flex';
}

// 启用按钮：旧 enableUser 接收 display_name/role 已废弃，用 enableUserById 走缓存
function enableUserById(id) {
    const u = _adminUsersCache.find(x => Number(x.id) === Number(id));
    if (!u) return showMessage('未找到用户', false);
    if (typeof enableUser === 'function') {
        enableUser(u.id, u.display_name || '', u.role);
    } else {
        showMessage('启用函数缺失', false);
    }
}

// 旧 API 兼容（保留以防其他地方还在调）
function openEditModal(id, displayName, role, status, phone) {
    document.getElementById('editUserId').value = id;
    document.getElementById('editDisplayName').value = displayName;
    document.getElementById('editRole').value = role;
    document.getElementById('editStatus').value = status;
    document.getElementById('editPhone').value = phone || '';
    const remarkEl = document.getElementById('editRemark');
    if (remarkEl) remarkEl.value = '';
    document.getElementById('editPassword').value = '';
    document.getElementById('editModal').style.display = 'flex';
}

function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
}

async function saveUser() {
    const id = document.getElementById('editUserId').value;
    const display_name = document.getElementById('editDisplayName').value.trim();
    const role = document.getElementById('editRole').value;
    const status = document.getElementById('editStatus').value;
    const phone = document.getElementById('editPhone').value.trim();
    const remarkEl = document.getElementById('editRemark');
    const remark = remarkEl ? remarkEl.value.trim() : '';
    const password = document.getElementById('editPassword').value;

    // 编辑场景下 phone/remark 总是带上(空串=用户主动清除);后端把空串当 null/'' 处理
    const body = { display_name, role, status, phone, remark };
    if (password) body.password = password;

    try {
        const res = await fetch(`${API_URL}/users/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify(body)
        });

        const data = await res.json();
        if (res.ok) {
            showMessage('用户更新成功', true);
            closeEditModal();
            loadUsers();
        } else {
            showMessage(data.error || '更新失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function disableUser(id) {
    if (!confirm('确定要禁用此用户吗?')) return;

    try {
        const res = await fetch(`${API_URL}/users/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('用户已禁用', true);
            loadUsers();
        } else {
            const data = await res.json();
            showMessage(data.error || '操作失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function enableUser(id, currentDisplayName, currentRole) {
    try {
        const res = await fetch(`${API_URL}/users/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ status: 'active', display_name: currentDisplayName, role: currentRole })
        });

        if (res.ok) {
            showMessage('用户已启用', true);
            loadUsers();
        } else {
            showMessage('操作失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// ==================== 数据库连接管理 ====================

async function loadDbConnections() {
    try {
        const res = await fetch(`${API_URL}/db-connections`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error('加载失败');
        const connections = await res.json();
        renderDbConnections(connections);
    } catch (e) {
        document.getElementById('dbConnectionList').innerHTML =
            '<tr><td colspan="8" style="text-align:center;color:#e53e3e;">加载失败</td></tr>';
    }
}

function renderDbConnections(connections) {
    const tbody = document.getElementById('dbConnectionList');
    if (connections.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#a0aec0;">暂无连接配置</td></tr>';
        return;
    }

    tbody.innerHTML = connections.map(conn => {
        const connType = conn.connection_type || 'warehouse';
        const typeLabel = connType === 'source'
            ? `<span style="background:#f59e0b; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em;">源系统${conn.source_system_code ? ' (' + conn.source_system_code + ')' : ''}</span>`
            : '<span style="background:#3b82f6; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em;">数仓</span>';
        return `
            <tr>
                <td>${conn.id}</td>
                <td>${typeLabel}</td>
                <td>${conn.name}</td>
                <td>${conn.host}:${conn.port}</td>
                <td>${conn.database}</td>
                <td>${conn.default_schema}</td>
                <td>${conn.is_default ? '<span style="color:#16a34a; font-weight:bold;">✓ 默认</span>' : '-'}</td>
                <td class="action-btns">
                    <button class="btn btn-success" onclick="testDbConnection(${conn.id})">测试</button>
                    ${connType === 'warehouse' && !conn.is_default ? `<button class="btn" style="background:#f59e0b; color:white;" onclick="setDefaultConnection(${conn.id})">设为默认</button>` : ''}
                    <button class="btn btn-danger" onclick="deleteDbConnection(${conn.id})">删除</button>
                </td>
            </tr>
        `;
    }).join('');
}

// 切换源系统代码输入框显示
function toggleSourceSystemCode() {
    const connType = document.getElementById('dbConnType').value;
    const sourceGroup = document.getElementById('sourceSystemCodeGroup');
    // v1.66.3：空串恢复 .form-group 默认 display:flex（不能硬写 block，否则 label 间距与同行其他字段错位）
    sourceGroup.style.display = connType === 'source' ? '' : 'none';
}

// v1.69.1：切换数据库方言时联动端口默认值（仅当当前端口为已知方言默认值时才覆盖）
function onDialectChange() {
    const dialect = document.getElementById('dbConnDialect').value;
    const portInput = document.getElementById('dbConnPort');
    const currentPort = parseInt(portInput.value);
    // 只有当端口是另一方言默认值时才自动切换，避免覆盖用户已自定义的端口
    if (dialect === 'mysql' && currentPort === 1433) {
        portInput.value = 3306;
    } else if (dialect === 'sqlserver' && currentPort === 3306) {
        portInput.value = 1433;
    }
}

async function testNewDbConnection() {
    const type = document.getElementById('dbConnDialect').value;
    const host = document.getElementById('dbConnHost').value.trim();
    const port = parseInt(document.getElementById('dbConnPort').value) || (type === 'mysql' ? 3306 : 1433);
    const database = document.getElementById('dbConnDatabase').value.trim();
    const username = document.getElementById('dbConnUsername').value.trim();
    const password = document.getElementById('dbConnPassword').value;

    if (!host || !database || !username || !password) {
        return showMessage('请填写服务器、数据库、用户名和密码', false);
    }

    showMessage('正在测试连接...', true);

    try {
        const res = await fetch(`${API_URL}/db-connections/test-new`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ type, host, port, database, username, password })
        });

        const data = await res.json();
        if (data.success) {
            showMessage('连接测试成功!', true);
        } else {
            showMessage('连接失败: ' + (data.error || '未知错误'), false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function createDbConnection() {
    const connection_type = document.getElementById('dbConnType').value;
    const type = document.getElementById('dbConnDialect').value;  // v1.69.1：sqlserver / mysql
    const source_system_code = document.getElementById('dbConnSourceSystemCode')?.value.trim() || '';
    const name = document.getElementById('dbConnName').value.trim();
    const host = document.getElementById('dbConnHost').value.trim();
    const port = parseInt(document.getElementById('dbConnPort').value) || (type === 'mysql' ? 3306 : 1433);
    const database = document.getElementById('dbConnDatabase').value.trim();
    const default_schema = document.getElementById('dbConnSchema').value.trim() || 'dbo';
    const username = document.getElementById('dbConnUsername').value.trim();
    const password = document.getElementById('dbConnPassword').value;
    const is_default = document.getElementById('dbConnIsDefault').checked;

    if (!name || !host || !database || !username || !password) {
        return showMessage('请填写所有必填项', false);
    }

    // 源系统连接必须填写源系统代码
    if (connection_type === 'source' && !source_system_code) {
        return showMessage('源系统连接必须填写源系统代码', false);
    }

    try {
        const res = await fetch(`${API_URL}/db-connections`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                name, type, host, port, database, default_schema,
                username, password, is_default, connection_type, source_system_code
            })
        });

        const data = await res.json();
        if (res.ok) {
            showMessage('数据库连接创建成功', true);
            // 清空表单
            document.getElementById('dbConnType').value = 'warehouse';
            document.getElementById('dbConnDialect').value = 'sqlserver';
            document.getElementById('dbConnSourceSystemCode').value = '';
            document.getElementById('sourceSystemCodeGroup').style.display = 'none';
            document.getElementById('dbConnName').value = '';
            document.getElementById('dbConnHost').value = '';
            document.getElementById('dbConnPort').value = '1433';
            document.getElementById('dbConnDatabase').value = '';
            document.getElementById('dbConnSchema').value = 'dbo';
            document.getElementById('dbConnUsername').value = '';
            document.getElementById('dbConnPassword').value = '';
            document.getElementById('dbConnIsDefault').checked = false;
            loadDbConnections();
        } else {
            showMessage(data.error || '创建失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function testDbConnection(id) {
    showMessage('正在测试连接...', true);

    try {
        const res = await fetch(`${API_URL}/db-connections/${id}/test`, {
            method: 'POST',
            headers: getAuthHeaders()
        });

        const data = await res.json();
        if (data.success) {
            showMessage('连接测试成功!', true);
        } else {
            showMessage('连接失败: ' + (data.error || '未知错误'), false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function setDefaultConnection(id) {
    try {
        // 先获取连接信息
        const listRes = await fetch(`${API_URL}/db-connections`, {
            headers: getAuthHeaders()
        });
        const connections = await listRes.json();
        const conn = connections.find(c => c.id === id);
        if (!conn) return showMessage('连接不存在', false);

        const res = await fetch(`${API_URL}/db-connections/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                name: conn.name,
                type: conn.type,
                host: conn.host,
                port: conn.port,
                database: conn.database,
                default_schema: conn.default_schema,
                username: conn.username,
                is_default: true
            })
        });

        if (res.ok) {
            showMessage('已设为默认连接', true);
            loadDbConnections();
        } else {
            const data = await res.json();
            showMessage(data.error || '操作失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function deleteDbConnection(id) {
    if (!confirm('确定要删除此数据库连接吗?')) return;

    try {
        const res = await fetch(`${API_URL}/db-connections/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('连接已删除', true);
            loadDbConnections();
        } else {
            const data = await res.json();
            showMessage(data.error || '删除失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// ==================== 验收配置管理 ====================

async function loadValidationConfig() {
    try {
        const res = await fetch(`${API_URL}/validation/config`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error('加载失败');
        const config = await res.json();

        document.getElementById('configNullRateThreshold').value = config.null_rate_threshold || '5';
        document.getElementById('configMinRowCount').value = config.min_row_count || '0';
        document.getElementById('configAuditFields').value = config.audit_fields || 'dw_load_ts,dw_src_sys,dw_batch_id';
    } catch (e) {
        console.error('加载验收配置失败:', e);
    }
}

async function saveValidationConfig() {
    const null_rate_threshold = document.getElementById('configNullRateThreshold').value;
    const min_row_count = document.getElementById('configMinRowCount').value;
    const audit_fields = document.getElementById('configAuditFields').value.trim();

    try {
        const res = await fetch(`${API_URL}/validation/config`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                null_rate_threshold,
                min_row_count,
                audit_fields
            })
        });

        if (res.ok) {
            showMessage('验收配置已保存', true);
        } else {
            const data = await res.json();
            showMessage(data.error || '保存失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 页面加载
document.addEventListener('DOMContentLoaded', async () => {
    const auth = await checkAuth();
    if (auth) {
        loadUsers();
        loadDbConnections();
        loadValidationConfig();
        loadAllComments();
        loadPendingCommentsCount();
        loadDingtalkConfig();
    }
});

// ==================== 钉钉配置（数据协作模块 v2.0）====================

async function loadDingtalkConfig() {
    try {
        const res = await fetch(`${API_URL}/admin/dingtalk-config`, { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        // 后端密码字段返回 '***' 表示已配置;前端把 *** 写入 input 作占位提示
        document.getElementById('dingtalkAppKey').value = data.app_key || '';
        document.getElementById('dingtalkAppSecret').value = data.app_secret || '';
        document.getElementById('dingtalkRobotCode').value = data.robot_code || '';
        document.getElementById('dingtalkPlatformBaseUrl').value = data.platform_base_url || '';

        const statusEl = document.getElementById('dingtalkConfigStatus');
        if (data.configured) {
            statusEl.textContent = '已配置';
            statusEl.style.background = '#dcfce7';
            statusEl.style.color = '#16a34a';
        } else {
            statusEl.textContent = '未配置';
            statusEl.style.background = '#f1f5f9';
            statusEl.style.color = '#64748b';
        }
    } catch (e) {
        // 静默失败,不阻塞页面其他功能
    }
}

async function saveDingtalkConfig() {
    const payload = {
        app_key: document.getElementById('dingtalkAppKey').value.trim(),
        app_secret: document.getElementById('dingtalkAppSecret').value.trim(),
        robot_code: document.getElementById('dingtalkRobotCode').value.trim(),
        platform_base_url: document.getElementById('dingtalkPlatformBaseUrl').value.trim()
    };
    try {
        const res = await fetch(`${API_URL}/admin/dingtalk-config`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            showMessage(`钉钉配置已保存(${data.updated} 个字段更新)`, true);
            loadDingtalkConfig();
        } else {
            showMessage(data.error || '保存失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

async function testDingtalkConfig() {
    const resultEl = document.getElementById('dingtalkTestResult');
    resultEl.style.display = 'block';
    resultEl.style.background = '#f1f5f9';
    resultEl.style.color = '#475569';
    resultEl.textContent = '正在测试连接...';

    try {
        const res = await fetch(`${API_URL}/admin/dingtalk-config/test`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (data.ok) {
            resultEl.style.background = '#dcfce7';
            resultEl.style.color = '#15803d';
            resultEl.textContent = '✅ ' + (data.message || '测试通过');
        } else {
            resultEl.style.background = '#fee2e2';
            resultEl.style.color = '#b91c1c';
            const detail = [data.error, data.errcode && `errcode=${data.errcode}`, data.errmsg].filter(Boolean).join(' · ');
            resultEl.textContent = '❌ ' + detail;
        }
    } catch (e) {
        resultEl.style.background = '#fee2e2';
        resultEl.style.color = '#b91c1c';
        resultEl.textContent = '❌ 网络错误,请检查后端服务是否运行';
    }
}

// ==================== 评论管理功能 ====================

// 加载待审核评论数量（用于徽章显示）
async function loadPendingCommentsCount() {
    try {
        const res = await fetch(`${API_URL}/comments/pending-count`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            const badge = document.getElementById('pendingCommentsBadge');
            if (data.count > 0) {
                badge.textContent = data.count;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    } catch (e) {
        console.error('获取待审核评论数量失败:', e);
    }
}

// 加载评论列表
async function loadAllComments() {
    const status = document.getElementById('commentStatusFilter').value;
    const tbody = document.getElementById('commentsList');

    try {
        const res = await fetch(`${API_URL}/comments/all?status=${status}`, {
            headers: getAuthHeaders()
        });

        if (!res.ok) {
            throw new Error('获取评论失败');
        }

        const comments = await res.json();

        if (comments.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#a0aec0;">暂无${getStatusLabel(status)}评论</td></tr>`;
            return;
        }

        tbody.innerHTML = comments.map(c => renderCommentRow(c)).join('');

    } catch (e) {
        console.error('加载评论失败:', e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#ef4444;">加载失败</td></tr>';
    }
}

// 获取状态标签
function getStatusLabel(status) {
    const labels = {
        'pending': '待审核',
        'approved': '已通过',
        'rejected': '已拒绝',
        'all': ''
    };
    return labels[status] || '';
}

// 获取分类标签
function getCategoryLabel(category) {
    const labels = {
        'general': '其他',
        'feature': '功能建议',
        'bug': '问题反馈',
        'experience': '使用体验'
    };
    return labels[category] || '其他';
}

// 获取分类样式
function getCategoryStyle(category) {
    const styles = {
        'general': 'background:#e2e8f0; color:#64748b;',
        'feature': 'background:#dbeafe; color:#2563eb;',
        'bug': 'background:#fee2e2; color:#dc2626;',
        'experience': 'background:#d1fae5; color:#059669;'
    };
    return styles[category] || styles.general;
}

// 获取状态样式
function getStatusStyle(status) {
    const styles = {
        'pending': 'background:#fef3c7; color:#d97706;',
        'approved': 'background:#d1fae5; color:#059669;',
        'rejected': 'background:#fee2e2; color:#dc2626;'
    };
    return styles[status] || '';
}

// 渲染评论行
function renderCommentRow(comment) {
    const categoryLabel = getCategoryLabel(comment.category);
    const categoryStyle = getCategoryStyle(comment.category);
    const statusLabel = getStatusLabel(comment.status);
    const statusStyle = getStatusStyle(comment.status);
    const timeStr = formatDateTimeUnified(comment.created_at, 'short');

    // 截断内容显示
    const contentPreview = comment.content.length > 50
        ? comment.content.substring(0, 50) + '...'
        : comment.content;

    // 操作按钮（根据状态显示不同按钮）
    let actions = '';
    if (comment.status === 'pending') {
        actions = `
            <button class="btn" style="background:#22c55e; color:white; padding:4px 8px; font-size:0.75rem;" onclick="approveComment(${comment.id})">通过</button>
            <button class="btn" style="background:#ef4444; color:white; padding:4px 8px; font-size:0.75rem;" onclick="rejectComment(${comment.id})">拒绝</button>
        `;
    } else if (comment.status === 'approved') {
        actions = `
            <button class="btn" style="background:#3b82f6; color:white; padding:4px 8px; font-size:0.75rem;" onclick="openReplyModal(${comment.id}, '${escapeHtmlAttr(comment.content)}')">回复</button>
        `;
    }
    actions += `<button class="btn" style="background:#fee2e2; color:#dc2626; padding:4px 8px; font-size:0.75rem;" onclick="deleteComment(${comment.id})">删除</button>`;

    // 显示管理员回复
    let replyInfo = '';
    if (comment.admin_reply) {
        replyInfo = `<div style="font-size:0.75rem; color:#3b82f6; margin-top:4px;">已回复: ${comment.admin_reply.substring(0, 20)}${comment.admin_reply.length > 20 ? '...' : ''}</div>`;
    }

    return `
        <tr>
            <td>${comment.id}</td>
            <td>${escapeHtml(comment.user_name || '匿名')}</td>
            <td><span style="${categoryStyle} padding:2px 6px; border-radius:4px; font-size:0.75rem;">${categoryLabel}</span></td>
            <td style="max-width:300px;">
                <div title="${escapeHtmlAttr(comment.content)}">${escapeHtml(contentPreview)}</div>
                ${replyInfo}
            </td>
            <td><span style="${statusStyle} padding:2px 6px; border-radius:4px; font-size:0.75rem;">${statusLabel}</span></td>
            <td style="font-size:0.85rem; color:#64748b;">${timeStr}</td>
            <td style="white-space:nowrap;">
                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    ${actions}
                </div>
            </td>
        </tr>
    `;
}

// HTML 转义
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// HTML 属性转义
function escapeHtmlAttr(str) {
    if (!str) return '';
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, ' ');
}

// 审核通过评论
async function approveComment(id) {
    if (!confirm('确定通过此评论？')) return;

    try {
        const res = await fetch(`${API_URL}/comments/${id}/approve`, {
            method: 'PUT',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('评论已通过', true);
            loadAllComments();
            loadPendingCommentsCount();
        } else {
            const data = await res.json();
            showMessage(data.error || '操作失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 拒绝评论
async function rejectComment(id) {
    if (!confirm('确定拒绝此评论？')) return;

    try {
        const res = await fetch(`${API_URL}/comments/${id}/reject`, {
            method: 'PUT',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('评论已拒绝', true);
            loadAllComments();
            loadPendingCommentsCount();
        } else {
            const data = await res.json();
            showMessage(data.error || '操作失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 删除评论
async function deleteComment(id) {
    if (!confirm('确定删除此评论？此操作不可恢复。')) return;

    try {
        const res = await fetch(`${API_URL}/comments/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (res.ok) {
            showMessage('评论已删除', true);
            loadAllComments();
            loadPendingCommentsCount();
        } else {
            const data = await res.json();
            showMessage(data.error || '删除失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}

// 打开回复模态框
function openReplyModal(id, content) {
    document.getElementById('replyCommentId').value = id;
    document.getElementById('replyOriginalContent').textContent = content;
    document.getElementById('replyContent').value = '';
    document.getElementById('replyModal').style.display = 'flex';
}

// 关闭回复模态框
function closeReplyModal() {
    document.getElementById('replyModal').style.display = 'none';
}

// 提交回复
async function submitReply() {
    const id = document.getElementById('replyCommentId').value;
    const reply = document.getElementById('replyContent').value.trim();

    if (!reply) {
        showMessage('请输入回复内容', false);
        return;
    }

    try {
        const res = await fetch(`${API_URL}/comments/${id}/reply`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ reply })
        });

        if (res.ok) {
            showMessage('回复成功', true);
            closeReplyModal();
            loadAllComments();
        } else {
            const data = await res.json();
            showMessage(data.error || '回复失败', false);
        }
    } catch (e) {
        showMessage('网络错误', false);
    }
}
