const SERVER_URL = 'http://localhost:3000'; // 如果远程访问需要调整
const API_URL = window.location.protocol === 'file:'
    ? `${SERVER_URL}/api`
    : '/api';

// 共享常量（C4，20260714·方案v1.2项1）：系统迭代+数据修正两模块共用的需求方部门清单。
// 逐字取自数据修正现行常量（Data_Correction.html 改造前 CORRECTION_REQUESTER_DEPTS），不擅自增删。
// 改这里两处引用页都会连带变化，注意回归。
window.PLATFORM_REQUESTER_DEPTS = [
    '市场营销部', '交付运营部', '财务管理部', '人事行政部', '审计风控部', '信息技术部', '安全保卫部', '其他归口部门',
    '董事会', '公司高管', '华北分公司', '华东分公司', '华南分公司', '华西分公司', '华中分公司', '西南分公司', '西北分公司',
    '杭州区域', '浙北区域', '浙南区域', '示例关联方B', '示例关联方C', '示例集团关联方A', '示例关联方D', '示例海外子公司', '其他'
];
let currentTaskId = null;
let currentUser = null;  // 当前登录用户
let selectedModelId = null; // 当前选中的模型ID（发布任务时使用）
let editSelectedModelId = null; // 编辑任务时选中的模型ID
let currentTaskInfo = null; // 当前任务信息（用于提交时校验）

// ==================== 全局工具函数 ====================

// 是否为开发环境（控制日志输出）
const IS_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// 日志工具：仅开发环境输出
const logger = {
    log: (...args) => IS_DEV && console.log('[App]', ...args),
    warn: (...args) => IS_DEV && console.warn('[App]', ...args),
    error: (...args) => console.error('[App]', ...args) // 错误日志始终输出
};

// ==================== Toast 消息组件 ====================

/**
 * 显示 Toast 消息（替代 alert）
 * @param {string} message - 消息内容
 * @param {string} type - 消息类型: 'success' | 'error' | 'warning' | 'info'
 * @param {number} duration - 显示时长（毫秒），默认 3000
 */
function showToast(message, type = 'info', duration = 3000) {
    // 确保容器存在
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:10px;';
        document.body.appendChild(container);
    }

    // 图标和颜色映射 (SVG图标)
    const config = {
        success: { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>', bg: '#10b981', color: '#fff' },
        error: { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>', bg: '#ef4444', color: '#fff' },
        warning: { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', bg: '#f59e0b', color: '#fff' },
        info: { icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>', bg: '#3b82f6', color: '#fff' }
    };
    const { icon, bg, color } = config[type] || config.info;

    // 创建 Toast 元素
    const toast = document.createElement('div');
    toast.style.cssText = `
        display:flex;align-items:center;gap:10px;
        padding:12px 20px;border-radius:8px;
        background:${bg};color:${color};
        box-shadow:0 4px 12px rgba(0,0,0,0.15);
        font-size:0.95em;min-width:200px;max-width:400px;
        animation:toastSlideIn 0.3s ease;
        cursor:pointer;
    `;
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;

    // 点击关闭
    toast.onclick = () => removeToast(toast);
    container.appendChild(toast);

    // 自动移除
    setTimeout(() => removeToast(toast), duration);
}

// 移除 Toast
function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.animation = 'toastSlideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
}

// 添加 Toast 动画样式
(function initToastStyles() {
    if (document.getElementById('toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
        @keyframes toastSlideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes toastSlideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
})();

// ==================== 全局 Loading 组件 ====================

/**
 * 显示全局加载遮罩
 * @param {string} text - 加载提示文字
 */
function showLoading(text = '加载中...') {
    let overlay = document.getElementById('global-loading');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'global-loading';
        overlay.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(255,255,255,0.8);z-index:9999;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
        `;
        overlay.innerHTML = `
            <div style="width:40px;height:40px;border:4px solid #e2e8f0;border-top-color:#d97706;border-radius:50%;animation:spin 1s linear infinite;"></div>
            <div id="loading-text" style="margin-top:15px;color:#4a5568;font-size:0.95em;">${escapeHtml(text)}</div>
        `;
        document.body.appendChild(overlay);

        // 添加旋转动画
        if (!document.getElementById('loading-styles')) {
            const style = document.createElement('style');
            style.id = 'loading-styles';
            style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
    } else {
        overlay.style.display = 'flex';
        const textEl = document.getElementById('loading-text');
        if (textEl) textEl.textContent = text;
    }
}

/**
 * 隐藏全局加载遮罩
 */
function hideLoading() {
    const overlay = document.getElementById('global-loading');
    if (overlay) overlay.style.display = 'none';
}

// ==================== 防抖与节流工具 ====================

/**
 * 防抖函数：延迟执行，期间重复调用会重置计时器
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟时间（毫秒）
 * @returns {Function} 防抖后的函数
 */
function debounce(fn, delay = 300) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * 节流函数：固定时间间隔内只执行一次
 * @param {Function} fn - 要执行的函数
 * @param {number} interval - 间隔时间（毫秒）
 * @returns {Function} 节流后的函数
 */
function throttle(fn, interval = 300) {
    let lastTime = 0;
    return function (...args) {
        const now = Date.now();
        if (now - lastTime >= interval) {
            lastTime = now;
            fn.apply(this, args);
        }
    };
}

// ==================== 按钮防重复提交工具 ====================

/**
 * 设置按钮为加载状态（防止重复提交）
 * @param {HTMLElement|string} btn - 按钮元素或ID
 * @param {string} loadingText - 加载中显示的文字
 * @returns {string} 原始按钮文字（用于恢复）
 */
function setButtonLoading(btn, loadingText = '处理中...') {
    const button = typeof btn === 'string' ? document.getElementById(btn) : btn;
    if (!button) return '';
    const originalText = button.innerHTML;
    button.disabled = true;
    button.dataset.originalText = originalText;
    button.innerHTML = `<span style="display:inline-flex;align-items:center;gap:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${loadingText}</span>`;
    button.style.opacity = '0.7';
    return originalText;
}

/**
 * 恢复按钮状态
 * @param {HTMLElement|string} btn - 按钮元素或ID
 * @param {string} originalText - 原始文字（可选，会自动从 dataset 读取）
 */
function resetButtonLoading(btn, originalText) {
    const button = typeof btn === 'string' ? document.getElementById(btn) : btn;
    if (!button) return;
    button.disabled = false;
    button.innerHTML = originalText || button.dataset.originalText || '提交';
    button.style.opacity = '1';
}

// ==================== 模态框统一管理 ====================

/**
 * 初始化模态框交互（ESC关闭、遮罩点击关闭）
 * 在页面加载后自动调用
 */
function initModalInteractions() {
    // ESC 键关闭所有模态框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(modal => {
                if (modal.style.display === 'flex' || modal.style.display === 'block') {
                    modal.style.display = 'none';
                }
            });
        }
    });

    // 点击遮罩层关闭模态框
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    });
}

// 页面加载后初始化模态框交互
document.addEventListener('DOMContentLoaded', () => {
    // 延迟执行，确保所有模态框都已渲染
    setTimeout(initModalInteractions, 100);
});

// ==================== 兼容性：保留 alert 但推荐使用 showToast ====================
// 可以在全局替换 alert 为 showToast，但为了兼容性暂时保留

// 类别映射常量
const CATEGORY_MAP = {
    'ODS_SYNC': 'ODS同步',
    'DIM_DEV': 'DIM开发',
    'DWD_DEV': 'DWD开发',
    'ADS_RPT': 'ADS报表',
    'DATA_FIX': '数据运维'
};

// 根据任务类型自动建议预估工时
const DEFAULT_HOURS_BY_CATEGORY = {
    'ODS_SYNC': 1,      // ODS同步一般1小时
    'DIM_DEV': 8,       // DIM开发一般1天（SCD2较复杂）
    'DWD_DEV': 4,       // DWD开发一般4小时
    'ADS_RPT': 4,       // ADS报表一般4小时
    'DATA_FIX': 2       // 数据修复一般2小时
};

// ========== 常见问题速查配置（从后端加载，以下为默认备用） ==========
// SVG图标模板
const SVG_ICONS = {
    lightbulb: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    upload: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    rocket: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    fileText: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    save: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    alertTriangle: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    clipboard: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
    tag: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    userPlus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    barChart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    trendingUp: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    package: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    userCheck: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>',
    helpCircle: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    archive: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
};

let TASK_TIPS = {
    'ODS_SYNC': {
        icon: SVG_ICONS.lightbulb,
        title: 'ODS同步常见坑点',
        tips: [
            '检查源表是否有增量字段（update_time/create_time）',
            '确认字段类型映射，特别是日期和数值类型',
            '注意NULL值处理策略',
            '大表考虑分区策略'
        ]
    },
    'DIM_DEV': {
        icon: SVG_ICONS.lightbulb,
        title: 'DIM开发常见坑点',
        tips: [
            '确定SCD类型（SCD1覆盖/SCD2历史追踪）',
            '设计代理键和业务键',
            '版本链完整性：dw_eff_dt/dw_exp_dt/dw_is_current_flg',
            '提交4类脚本：DDL、初始化、增量ETL、审计规则'
        ]
    },
    'DWD_DEV': {
        icon: SVG_ICONS.lightbulb,
        title: 'DWD开发常见坑点',
        tips: [
            '明确主键和唯一性约束',
            '处理脏数据和异常值',
            '关联查询注意数据倾斜',
            '时间字段统一转换为标准格式'
        ]
    },
    'ADS_RPT': {
        icon: SVG_ICONS.lightbulb,
        title: 'ADS报表常见坑点',
        tips: [
            '确认指标口径与业务一致',
            '注意时间范围边界条件',
            '大数据量考虑预聚合',
            '验证汇总数据与明细一致性'
        ]
    },
    'DATA_FIX': {
        icon: SVG_ICONS.lightbulb,
        title: '数据修复常见坑点',
        tips: [
            '修复前务必备份原始数据',
            '确认影响范围和行数',
            '分批执行避免锁表',
            '修复后验证数据完整性'
        ]
    }
};

// 状态映射常量 (使用SVG图标)
const STATUS_MAP = {
    'ONLINE': `${SVG_ICONS.check} 已上线`,
    'CREATED': `${SVG_ICONS.edit} 规划中`,
    'OFFLINE': `${SVG_ICONS.x} 已下线`,
    'REVIEWING': `${SVG_ICONS.search} 待验收`
};

// HTML转义工具函数
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 日期格式化工具函数: YYYY年MM月DD日 HH:mm:ss
function formatDate(dateInput) {
    if (!dateInput) return '未知时间';
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return '无效时间';

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}年${month}月${day}日 ${hours}:${minutes}:${seconds}`;
}

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

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');

    // 默认（以及 full 和 short）都返回完整格式：YYYY-MM-DD HH:mm:ss
    // 如果明确只需要日期或时间，才分别处理
    if (style === 'dateOnly') {
        return `${year}-${month}-${day}`;
    }
    if (style === 'timeOnly') {
        return `${hours}:${minutes}:${seconds}`;
    }

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 格式化工时（秒数）为人性化显示
 * 规则：
 * - < 1分钟: XX秒
 * - < 1小时: XX分XX秒
 * - < 1天: XX小时XX分
 * - >= 1天: X天XX小时XX分
 * @param {number} totalSeconds - 总秒数
 * @returns {string} 格式化后的字符串
 */
function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '-';

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // 两位数格式化（天除外）
    const pad = (n) => String(n).padStart(2, '0');

    if (days > 0) {
        // >= 1天: X天XX小时XX分
        return `${days}天${pad(hours)}小时${pad(minutes)}分`;
    } else if (hours > 0) {
        // < 1天: XX小时XX分
        return `${pad(hours)}小时${pad(minutes)}分`;
    } else if (minutes > 0) {
        // < 1小时: XX分XX秒
        return `${pad(minutes)}分${pad(seconds)}秒`;
    } else {
        // < 1分钟: XX秒
        return `${seconds}秒`;
    }
}

// ==================== 认证相关 ====================

// 获取存储的token
function getToken() {
    return localStorage.getItem('token');
}

// 获取带认证头的请求选项
function getAuthHeaders() {
    const token = getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// 带认证的fetch请求
async function authFetch(url, options = {}) {
    const headers = {
        ...options.headers,
        ...getAuthHeaders()
    };

    const response = await fetch(url, { ...options, headers });

    // 如果返回401,跳转到登录页 (403是权限不足，不应退出)
    if (response.status === 401) {
        logout();
        return null;
    }

    return response;
}

// 检查登录状态
async function checkAuth() {
    const token = getToken();
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }

    try {
        const res = await fetch(`${API_URL}/auth/me`, {
            headers: getAuthHeaders()
        });

        if (res.ok) {
            currentUser = await res.json();
            updateUserUI();
            return true;
        } else {
            logout();
            return false;
        }
    } catch (e) {
        console.error('认证检查失败', e);
        logout();
        return false;
    }
}

// 退出登录
function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login.html';
}

// 更新用户界面显示
function updateUserUI() {
    const profileArea = document.getElementById('userProfileArea');
    if (profileArea && currentUser) {
        const roleText = currentUser.role === 'admin' ? '管理员' :
            (currentUser.role === 'publisher' ? '发布者' :
                (currentUser.role === 'viewer' ? '查看者' : '开发者'));

        const avatarChar = currentUser.display_name ? currentUser.display_name[0].toUpperCase() : 'U';

        // 构造下拉菜单项
        let menuItems = '';
        if (currentUser.role === 'admin') {
            menuItems += `<a href="/admin.html" style="text-decoration:none;">👥 用户管理</a>`;
            // 周期取数推送（仅 admin 独立新模块，2026-07 集成点3）：镜像"用户管理"同款 admin-only
            // 下拉入口——不进普通导航栏（会要求同步改 11 个既有页面的导航栏 HTML，超出该模块新增范围），
            // 复用这个已存在于每一页的 profile 下拉菜单即可让 admin 全站可发现，无需改动任何既有页面。
            menuItems += `<a href="/Periodic_Fetch.html" style="text-decoration:none;">📅 周期取数推送</a>`;
        }
        menuItems += `<a href="#" onclick="openChangePasswordModal()">🔑 修改密码</a>`;
        menuItems += `<a href="#" onclick="logout()" style="color:#e53e3e;">🚪 退出登录</a>`;

        profileArea.innerHTML = `
            <div class="dropdown">
                <div class="user-profile">
                    <div class="avatar-circle">${avatarChar}</div>
                    <div class="profile-info">
                        <span class="profile-name">${currentUser.display_name}</span>
                        <span class="profile-role">${roleText}</span>
                    </div>
                    <span style="font-size:0.8em;color:#a0aec0;">▼</span>
                </div>
                <div class="dropdown-content">
                    ${menuItems}
                </div>
            </div>
        `;
    }

    // 根据角色显示/隐藏发布任务区域
    const publishSection = document.getElementById('publishSection');
    if (publishSection) {
        // 管理员 OR 发布者 可见
        const canPublish = currentUser && (currentUser.role === 'admin' || currentUser.role === 'publisher');
        publishSection.style.display = canPublish ? 'block' : 'none';

        // 动态更新角色标签
        const roleLabel = document.getElementById('publishRoleLabel');
        if (roleLabel && currentUser) {
            const roleName = currentUser.role === 'admin' ? '管理员' : '发布者';
            roleLabel.textContent = `(${roleName})`;
        }

        // 管理员显示提示配置按钮
        const btnTaskTipsConfig = document.getElementById('btnTaskTipsConfig');
        if (btnTaskTipsConfig) {
            btnTaskTipsConfig.style.display = currentUser && currentUser.role === 'admin' ? 'block' : 'none';
        }
    }
}

// 打开修改密码模态框（动态创建，所有页面通用）
function openChangePasswordModal() {
    let modal = document.getElementById('changePasswordModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'changePasswordModal';
        Object.assign(modal.style, {
            display: 'none', position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.5)', zIndex: '10000', justifyContent: 'center', alignItems: 'center'
        });
        modal.innerHTML = `
            <div style="background:#fff; border-radius:12px; padding:0; width:400px; max-width:90vw; box-shadow:0 20px 60px rgba(0,0,0,0.3);">
                <div style="padding:20px 24px 16px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
                    <h3 style="margin:0; font-size:1.1em; color:#2d3748;">🔑 修改密码</h3>
                    <button onclick="document.getElementById('changePasswordModal').style.display='none'"
                        style="background:none; border:none; font-size:1.5em; color:#a0aec0; cursor:pointer; line-height:1;">&times;</button>
                </div>
                <div style="padding:20px 24px;">
                    <label style="display:block; margin-bottom:6px; font-weight:500; color:#4a5568; font-size:0.9em;">旧密码 <span style="color:#e53e3e;">*</span></label>
                    <input type="password" id="cpOldPassword" placeholder="请输入旧密码"
                        style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:0.95em; box-sizing:border-box;">
                    <label style="display:block; margin:16px 0 6px; font-weight:500; color:#4a5568; font-size:0.9em;">新密码 <span style="color:#e53e3e;">*</span></label>
                    <input type="password" id="cpNewPassword" placeholder="请输入新密码"
                        style="width:100%; padding:10px 12px; border:1px solid #e2e8f0; border-radius:8px; font-size:0.95em; box-sizing:border-box;">
                </div>
                <div style="padding:12px 24px 20px; display:flex; justify-content:flex-end; gap:10px;">
                    <button onclick="document.getElementById('changePasswordModal').style.display='none'"
                        style="padding:8px 20px; border:1px solid #e2e8f0; border-radius:8px; background:#fff; color:#4a5568; cursor:pointer;">取消</button>
                    <button onclick="confirmChangePassword()"
                        style="padding:8px 20px; border:none; border-radius:8px; background:linear-gradient(135deg,#d97706,#b45309); color:#fff; cursor:pointer; font-weight:500;">确认修改</button>
                </div>
            </div>`;
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        document.body.appendChild(modal);
    }
    // 清空输入框
    const oldPwd = document.getElementById('cpOldPassword');
    const newPwd = document.getElementById('cpNewPassword');
    if (oldPwd) oldPwd.value = '';
    if (newPwd) newPwd.value = '';
    modal.style.display = 'flex';
}

// 确认修改密码
async function confirmChangePassword() {
    const oldPassword = (document.getElementById('cpOldPassword') || document.getElementById('oldPassword'))?.value;
    const newPassword = (document.getElementById('cpNewPassword') || document.getElementById('newPassword'))?.value;

    if (!oldPassword || !newPassword) {
        return alert('请输入旧密码和新密码');
    }

    try {
        const res = await authFetch(`${API_URL}/auth/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });

        const data = await res.json();
        if (res.ok) {
            alert('修改成功,请使用新密码重新登录');
            logout();
        } else {
            alert(data.error || '修改失败');
        }
    } catch (e) {
        alert('修改失败: ' + e.message);
    }
}

// 判断是否为管理员
function isAdmin() {
    return currentUser && currentUser.role === 'admin';
}

function isPublisher() {
    return currentUser && currentUser.role === 'publisher';
}

// 判断是否为任务所有者
function isOwner(task) {
    return currentUser && task.owner_id === currentUser.id;
}

// 判断是否为查看者(只读)
function isViewer() {
    return currentUser && currentUser.role === 'viewer';
}

// 页面加载时检查认证
document.addEventListener('DOMContentLoaded', async () => {
    console.log('App DOMContentLoaded triggered');

    // 加载任务提示配置（无需登录）
    await loadTaskTips();

    const authenticated = await checkAuth();
    console.log('Authentication status:', authenticated ? 'Success' : 'Failed');

    if (authenticated) {
        console.log('Current User Role:', currentUser ? currentUser.role : 'none');

        // 根据角色调整导航栏
        adjustNavbarForRole();
        // 管理员待办面板
        initAdminTodoPanel();

        loadTasks();
        loadPendingTransfers();  // 加载待处理转发请求
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'publisher')) {
            loadAllModels(); // 加载模型列表用于关联
            // 初始化默认预估工时
            updatePlaceholders();
        }
    }

});

// 从后端加载任务提示配置
async function loadTaskTips() {
    try {
        const res = await fetch(`${API_URL}/task-tips`);
        if (res.ok) {
            const tips = await res.json();
            // 转换为以 category 为 key 的对象
            const tipsMap = {};
            tips.forEach(t => {
                // 将图标标识符映射为SVG（如果是标识符的话）
                const iconSvg = SVG_ICONS[t.icon] || t.icon || SVG_ICONS.lightbulb;
                tipsMap[t.category] = {
                    icon: iconSvg,
                    title: t.title,
                    tips: t.tips
                };
            });
            TASK_TIPS = tipsMap;
            console.log('Task tips loaded from server:', Object.keys(TASK_TIPS));
        }
    } catch (e) {
        console.warn('Failed to load task tips from server, using defaults:', e);
    }
}

// ==================== 导航栏角色适配 ====================

/**
 * 根据用户角色调整导航栏显示
 * - 查看者(viewer)：隐藏"我的工作台"和"任务池"入口
 */
function adjustNavbarForRole() {
    if (!currentUser) return;

    if (currentUser.role === 'viewer') {
        // 隐藏导航栏中的"我的工作台"链接
        document.querySelectorAll('a[href*="My_Workspace"]').forEach(el => {
            // 隐藏导航项
            if (el.classList.contains('nav-item')) {
                el.style.display = 'none';
            }
            // 隐藏下拉菜单中的链接
            if (el.closest('.dropdown-content')) {
                el.style.display = 'none';
            }
        });

        // 隐藏导航栏中的"任务池"链接（查看者不需要看任务池）
        document.querySelectorAll('a[href*="Task_Pool"]').forEach(el => {
            if (el.classList.contains('nav-item')) {
                el.style.display = 'none';
            }
        });

        logger.log('Navbar adjusted for viewer role');
    }
}

// ==================== 标签页切换 ====================
let currentTab = 'open';

function switchTab(tabId) {
    currentTab = tabId;

    // 1. 更新按钮状态
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(`'${tabId}'`)) {
            btn.classList.add('active');
        }
    });

    // 2. 更新内容显示
    document.querySelectorAll('.task-tab-content').forEach(section => {
        section.classList.remove('active');
    });
    const activeSection = document.getElementById(`tab-${tabId}`);
    if (activeSection) {
        activeSection.classList.add('active');
    }
}

// ==================== 待处理转发请求 ====================

// 加载待处理转发请求
async function loadPendingTransfers() {
    try {
        const res = await authFetch(`${API_URL}/transfers/pending`);
        if (!res) return;
        const transfers = await res.json();
        renderPendingTransfers(transfers);
    } catch (e) {
        console.error('加载待处理转发请求失败', e);
    }
}

// 渲染待处理转发请求
function renderPendingTransfers(transfers) {
    const section = document.getElementById('pendingTransfersSection');
    const container = document.getElementById('pendingTransfers');
    const countEl = document.getElementById('pendingTransferCount');

    // 如果页面没有这些元素（如 Model_Center.html），直接返回
    if (!section || !container) {
        return;
    }

    if (transfers.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    if (countEl) countEl.textContent = transfers.length;

    container.innerHTML = transfers.map(t => `
                <div class="transfer-card">
                    <div class="transfer-card-header">
                        <span class="from-user">${SVG_ICONS.user} 来自: ${t.from_user_name}</span>
                        <span style="color:#a0aec0;font-size:0.8em;">${formatDateTimeUnified(t.created_at, 'short')}</span>
                    </div>
                    <div class="transfer-card-title">${t.task_title}</div>
                    <div class="transfer-card-desc">${t.task_desc || '无描述'}</div>
                    <div class="transfer-card-actions">
                        <button class="btn-accept" onclick="acceptTransfer(${t.id})">${SVG_ICONS.check} 接受</button>
                        <button class="btn-reject" onclick="rejectTransfer(${t.id})">${SVG_ICONS.x} 拒绝</button>
                    </div>
                </div>
            `).join('');
}

// 接受转发
async function acceptTransfer(transferId) {
    try {
        const res = await authFetch(`${API_URL}/transfers/${transferId}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (res && res.ok) {
            alert('已接受任务转移');
            loadTasks();
            loadPendingTransfers();
        } else if (res) {
            const data = await res.json();
            alert(data.error || '操作失败');
        }
    } catch (e) {
        alert('操作失败: ' + e.message);
    }
}

// 拒绝转发
async function rejectTransfer(transferId) {
    if (!confirm('确定要拒绝此任务转发吗?')) return;

    try {
        const res = await authFetch(`${API_URL}/transfers/${transferId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (res && res.ok) {
            alert('已拒绝转发');
            loadPendingTransfers();
        } else if (res) {
            const data = await res.json();
            alert(data.error || '操作失败');
        }
    } catch (e) {
        alert('操作失败: ' + e.message);
    }
}

let allTasksCache = [];
let currentFilter = 'ALL';

function filterTasks(category) {
    currentFilter = category;
    document.querySelectorAll('.filter-pill').forEach(el => {
        if (el.dataset.cat === category) el.classList.add('active');
        else el.classList.remove('active');
    });
    renderTaskList();
}

function renderTaskList() {
    let filtered;
    if (currentFilter === 'ALL') {
        filtered = allTasksCache;
    } else {
        filtered = allTasksCache.filter(t => t.category === currentFilter);
    }
    renderTasks(filtered);
}

// 加载任务列表
async function loadTasks() {
    try {
        const res = await authFetch(`${API_URL}/pool`);
        if (!res || !res.ok) {
            console.error('Failed to load tasks');
            return;
        }
        const tasks = await res.json();
        allTasksCache = tasks;
        renderTaskList();
        updateProcessGuide(tasks); // 更新流程指引

        // 检查 URL 参数，定位到指定任务
        handleTaskIdFromUrl(tasks);
    } catch (e) {
        console.error("Failed to load tasks", e);
    }
}

// 处理 URL 中的 taskId 参数，自动切换到对应标签页并滚动到任务
function handleTaskIdFromUrl(tasks) {
    const urlParams = new URLSearchParams(window.location.search);
    const taskId = urlParams.get('taskId');
    if (!taskId) return;

    const task = tasks.find(t => t.id == taskId);
    if (!task) {
        console.warn(`Task ${taskId} not found`);
        return;
    }

    // 根据任务状态切换到对应的标签页
    let tabId = 'open';
    if (task.status === 'OPEN') {
        tabId = 'open';
    } else if (['CLAIMED', 'ON_HOLD', 'TRANSFERRING'].includes(task.status)) {
        tabId = 'claimed';
    } else if (task.status === 'DONE') {
        tabId = 'done';
    } else if (task.status === 'ARCHIVED') {
        tabId = 'archived';
    }

    // 切换标签页
    switchTab(tabId);

    // 等待 DOM 更新后滚动到任务卡片
    setTimeout(() => {
        const taskCard = document.getElementById(`task-card-${taskId}`);
        if (taskCard) {
            taskCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // 添加高亮动画
            taskCard.style.animation = 'highlightTask 2s ease-out';
            taskCard.style.boxShadow = '0 0 20px rgba(102, 126, 234, 0.6)';
            setTimeout(() => {
                taskCard.style.boxShadow = '';
                taskCard.style.animation = '';
            }, 2000);
        }
        // 清除 URL 参数，避免刷新时重复定位
        window.history.replaceState({}, '', window.location.pathname);
    }, 100);
}

// 更新流程指引（根据用户的任务状态）
function updateProcessGuide(tasks) {
    const modelStep = document.getElementById('modelStep');
    const modelStepText = document.getElementById('modelStepText');

    if (!modelStep || !modelStepText) return; // 如果不在Task_Pool页面，跳过

    // 检查当前用户是否有进行中的任务且未关联模型
    const userId = currentUser ? currentUser.id : null;
    if (!userId) return;

    const claimedTasks = tasks.filter(t =>
        t.status === 'CLAIMED' &&
        t.owner_id === userId &&
        !t.linked_model_id &&
        ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(t.category)
    );

    if (claimedTasks.length > 0) {
        // 有未关联模型的任务，显示需要注册
        modelStep.style.cursor = 'pointer';
        modelStep.onclick = () => window.location.href = 'Model_Center.html';
        modelStepText.innerHTML = `<span style="color:#ed8936;">${SVG_ICONS.alertTriangle} 您有任务未关联模型，请先注册</span>`;
        modelStep.querySelector('.step-icon').classList.add('step-active');
    } else {
        // 检查是否有已关联模型的任务
        const hasLinkedModel = tasks.some(t =>
            t.status === 'CLAIMED' &&
            t.owner_id === userId &&
            t.linked_model_id
        );

        if (hasLinkedModel) {
            // 已关联模型，显示可跳过
            modelStep.style.cursor = 'default';
            modelStep.onclick = null;
            modelStepText.innerHTML = `<span style="color:#48bb78;">${SVG_ICONS.check} 模型已关联，可跳过此步骤</span>`;
            modelStep.querySelector('.step-icon').classList.remove('step-active');
        } else {
            // 默认状态
            modelStep.style.cursor = 'pointer';
            modelStep.onclick = () => window.location.href = 'Model_Center.html';
            modelStepText.innerHTML = '<span style="color:#3182ce; text-decoration:underline;">前往模型中心注册表名规范</span>';
            modelStep.querySelector('.step-icon').classList.add('step-active');
        }
    }
}

// 渲染任务列表
function renderTasks(tasks) {
    if (!tasks) {
        console.warn("renderTasks called with null/undefined tasks");
        return;
    }
    console.log(`Rendering ${tasks.length} tasks...`);

    const openContainer = document.getElementById('openTasks');
    const holdContainer = document.getElementById('holdTasks');
    const claimedContainer = document.getElementById('claimedTasks');
    const doneContainer = document.getElementById('doneTasks');
    const archivedContainer = document.getElementById('archivedTasks');

    // 健壮性检查:如果元素不存在(由其他页面共用脚本引起),则跳过相应渲染
    if (openContainer) openContainer.innerHTML = '';
    if (holdContainer) holdContainer.innerHTML = '';
    if (claimedContainer) claimedContainer.innerHTML = '';
    if (doneContainer) doneContainer.innerHTML = '';
    if (archivedContainer) archivedContainer.innerHTML = '';

    let openTasks = [];
    let archivedTasks = [];  // 已归档任务也用表格渲染
    let holdCnt = 0, claimedCnt = 0, doneCnt = 0, archivedCnt = 0;

    tasks.forEach(task => {
        try {
            if (task.status === 'OPEN') {
                openTasks.push(task);
            } else if (task.status === 'ON_HOLD') {
                if (holdContainer) {
                    const card = createCard(task);
                    holdContainer.appendChild(card);
                }
                holdCnt++;
            } else if (task.status === 'ARCHIVED') {
                archivedTasks.push(task);
                archivedCnt++;
            } else {
                const card = createCard(task);
                if (task.status === 'CLAIMED' || task.status === 'TRANSFERRING') {
                    if (claimedContainer) claimedContainer.appendChild(card);
                    claimedCnt++;
                } else if (task.status === 'DONE') {
                    if (doneContainer) doneContainer.appendChild(card);
                    doneCnt++;
                }
            }
        } catch (err) {
            console.error("渲染单个任务卡片失败:", err, task);
        }
    });

    // 渲染待认领表格
    if (openContainer) {
        if (openTasks.length > 0) {
            const table = document.createElement('table');
            table.className = 'task-table';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th style="width:12%">发布时间</th>
                        <th style="width:8%">优先级</th>
                        <th style="width:10%">任务类型</th>
                        <th style="width:35%">任务标题</th>
                        <th style="width:35%; text-align:right;">操作</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;
            const tbody = table.querySelector('tbody');

            openTasks.forEach(task => {
                try {
                    const tr = document.createElement('tr');
                    let dateStr = formatDateTimeUnified(task.created_at);

                    // 安全处理
                    const jsSafeTitle = (task.title || '').replace(/['"\\]/g, ' ').replace(/\n/g, ' ');
                    const attrTitle = escapeHtml(task.title).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
                    const attrDesc = escapeHtml(task.desc || '').replace(/'/g, "&#39;").replace(/"/g, "&quot;");

                    let actionBtns = '';
                    const holdBtn = `<button class="btn-claim" style="background:white; color:#e53e3e; border:1px solid #e53e3e; white-space:nowrap;" onclick="openHoldModal(${task.id}, '${jsSafeTitle}')" title="标记为存疑/有问题">${SVG_ICONS.helpCircle} 存疑</button>`;

                    if (isViewer()) {
                        actionBtns = '<span style="color:#a0aec0;font-size:0.85em;">只读</span>';
                    } else if (isAdmin() || isPublisher()) {
                        actionBtns = `
                            <button class="btn-claim" style="background: linear-gradient(135deg, #d97706, #b45309); white-space:nowrap;" onclick="openEditModal(${task.id}, '${jsSafeTitle}', '${attrDesc}', '${task.category || 'DWD_DEV'}')" title="编辑任务">${SVG_ICONS.edit} 编辑</button>
                            <button class="btn-claim" style="background:#ed8936;color:white; white-space:nowrap;" onclick="openAssignModal(${task.id}, '${jsSafeTitle}')" title="直接分配给指定人员，立即生效">${SVG_ICONS.send} 分配</button>
                            <button class="btn-claim" style="white-space:nowrap;" onclick="openClaimModal(${task.id}, '${jsSafeTitle}')">${SVG_ICONS.userCheck} 认领</button>
                            <button class="btn-claim btn-danger" style="white-space:nowrap;" onclick="deleteTask(${task.id})">${SVG_ICONS.trash} 删除</button>
                        `;
                    } else {
                        actionBtns = `
                            ${holdBtn}
                            <button class="btn-claim" style="white-space:nowrap;" onclick="openClaimModal(${task.id}, '${jsSafeTitle}')">${SVG_ICONS.userCheck} 认领</button>
                        `;
                    }

                    const catLabel = CATEGORY_MAP[task.category] || 'DWD开发';
                    const catCls = `cat-${(task.category || 'DWD_DEV').toLowerCase().split('_')[0]}`;
                    const catBadge = `<span class="category-badge ${catCls}">${catLabel}</span>`;

                    // 优先级显示（表格视图）
                    let tablePriorityDisplay = '-';
                    if (task.priority === 'P0') {
                        tablePriorityDisplay = '<span style="background:#e53e3e;color:white;padding:4px 8px;border-radius:4px;font-size:0.85em;font-weight:bold;">🔴 P0</span>';
                    } else if (task.priority === 'P1') {
                        tablePriorityDisplay = '<span style="background:#dd6b20;color:white;padding:4px 8px;border-radius:4px;font-size:0.85em;font-weight:bold;">🟠 P1</span>';
                    } else if (task.priority === 'P2') {
                        tablePriorityDisplay = '<span style="background:#3182ce;color:white;padding:4px 8px;border-radius:4px;font-size:0.85em;font-weight:bold;">🔵 P2</span>';
                    } else if (task.priority === 'P3') {
                        tablePriorityDisplay = '<span style="background:#a0aec0;color:white;padding:4px 8px;border-radius:4px;font-size:0.85em;font-weight:bold;">⚪ P3</span>';
                    }

                    // 模型信息显示（在标题下方）
                    const modelName = task.linked_model_name || '';
                    const modelComment = task.linked_model_comment || '';
                    const modelHint = modelName
                        ? `<div style="margin-top:4px;">
                            <code style="font-size:0.75em; background:#e2e8f0; padding:2px 6px; border-radius:3px; color:#4a5568;">${escapeHtml(modelName)}</code>
                            ${modelComment ? `<span style="font-size:0.75em; color:#718096; margin-left:6px;">${escapeHtml(modelComment)}</span>` : ''}
                           </div>`
                        : '';

                    // 备注按钮样式（有备注时高亮）
                    const hasDesc = task.desc && task.desc.trim();
                    const remarkBtn = `<button class="btn-claim" style="background:${hasDesc ? '#fef3c7' : 'white'}; color:${hasDesc ? '#92400e' : '#718096'}; border:1px solid ${hasDesc ? '#fbbf24' : '#e2e8f0'}; white-space:nowrap;" onclick="openRemarkModal(${task.id}, '${jsSafeTitle}')" title="${hasDesc ? escapeHtml(task.desc) : '暂无备注'}">💬 备注${hasDesc ? '' : ''}</button>`;

                    tr.innerHTML = `
                        <td style="color:#718096; font-weight:500; white-space:nowrap;">${dateStr}</td>
                        <td style="text-align:center;">${tablePriorityDisplay}</td>
                        <td>${catBadge}</td>
                        <td title="${attrTitle}">
                            <div style="font-weight:700; color:#2d3748; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer;" onclick="openTaskDetailDrawer(${task.id})">${escapeHtml(task.title)}</div>
                            ${modelHint}
                        </td>
                        <td style="text-align:right;">
                             <div class="action-cell-btn-group">
                                ${remarkBtn}
                                ${actionBtns}
                             </div>
                        </td>
                    `;
                    tbody.appendChild(tr);
                } catch (trErr) {
                    console.error("渲染表格行失败:", trErr, task);
                }
            });
            openContainer.appendChild(table);
        } else {
            openContainer.innerHTML = '<div class="empty-state">暂无待认领任务</div>';
        }
    }

    // 渲染已归档表格
    if (archivedContainer) {
        if (archivedTasks.length > 0) {
            // 保存到全局变量供排序、搜索和分页使用
            window._archivedTasksData = archivedTasks;
            window._archivedFilteredData = archivedTasks; // 过滤后的数据
            window._archivedSortState = { field: 'archived_at', asc: false };
            window._archivedPageState = { page: 1, pageSize: 20 };

            // 创建搜索框
            const searchBox = document.createElement('div');
            searchBox.className = 'archived-search-box';
            searchBox.style.cssText = 'margin-bottom:15px;display:flex;align-items:center;';
            searchBox.innerHTML = `
                <input type="text" id="archivedSearchInput" placeholder="搜索任务标题、模型名、负责人..."
                    style="width:300px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;outline:none;"
                    onfocus="this.style.borderColor='#d97706'" onblur="this.style.borderColor='#e2e8f0'">
                <span id="archivedSearchCount" style="margin-left:12px;color:#718096;font-size:0.9em;"></span>
            `;
            archivedContainer.appendChild(searchBox);

            // 绑定搜索事件
            const searchInput = searchBox.querySelector('#archivedSearchInput');
            searchInput.oninput = () => {
                const keyword = searchInput.value.trim().toLowerCase();
                filterArchivedTable(keyword);
            };

            const table = document.createElement('table');
            table.className = 'task-table archived-table';
            table.id = 'archivedTable';
            table.innerHTML = `
                <thead>
                    <tr>
                        <th class="sortable" data-field="archived_at" style="width:125px;cursor:pointer;white-space:nowrap;">归档时间 <span class="sort-icon">▼</span></th>
                        <th class="sortable" data-field="priority" style="width:55px;cursor:pointer;text-align:center;white-space:nowrap;">优先级</th>
                        <th class="sortable" data-field="category" style="width:70px;cursor:pointer;white-space:nowrap;">类型</th>
                        <th class="sortable" data-field="title" style="width:35%;cursor:pointer;white-space:nowrap;">任务 / 数据表</th>
                        <th class="sortable" data-field="owner" style="width:65px;cursor:pointer;white-space:nowrap;">负责人</th>
                        <th class="sortable" data-field="dev_hours" style="width:175px;cursor:pointer;white-space:nowrap;">开发/预估</th>
                        <th style="width:55px;text-align:center;white-space:nowrap;">交付物</th>
                    </tr>
                </thead>
                <tbody id="archivedTableBody"></tbody>
            `;

            // 绑定表头排序事件
            table.querySelectorAll('th.sortable').forEach(th => {
                th.onclick = () => sortArchivedTable(th.dataset.field);
            });

            archivedContainer.appendChild(table);

            // 创建分页控件容器
            const paginationBox = document.createElement('div');
            paginationBox.id = 'archivedPagination';
            paginationBox.className = 'archived-pagination';
            archivedContainer.appendChild(paginationBox);

            // 初始渲染
            updateArchivedTableView();
        } else {
            archivedContainer.innerHTML = '<div class="empty-state">暂无已归档任务</div>';
        }
    }

    // 更新各区域计数器 (独立于 openContainer 判断)
    // 统计中心页面有自己的数据加载逻辑，不需要这里覆盖
    const isStatisticsPage = window.location.pathname.includes('Statistics.html');
    if (!isStatisticsPage) {
        const setInner = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.innerText = text;
        };
        // holdCount 包含 SVG 图标，需要用 innerHTML 渲染
        const holdEl = document.getElementById('holdCount');
        if (holdEl) holdEl.innerHTML = `${SVG_ICONS.alertTriangle} ${holdCnt}`;
        setInner('openCount', `${openTasks.length} 个任务`);
        setInner('claimedCount', `${claimedCnt} 个任务`);
        setInner('pendingCount', `${doneCnt} 个任务`);  // 待验收 = DONE状态
        setInner('doneCount', `${archivedCnt} 个任务`);  // 已完成 = 已归档
        setInner('archivedCount', `${archivedCnt} 个任务`);
    }

    // 异步填充 DONE 卡片的验收状态
    fillDoneCardValidationStatus();
}

// 异步批量查询并填充 DONE 卡片验收状态
async function fillDoneCardValidationStatus() {
    const bars = document.querySelectorAll('.validation-hint-bar[data-model-id]');
    if (bars.length === 0) return;

    // 收集需要查询的 model id（去重）
    const modelIds = [...new Set(Array.from(bars).map(b => b.dataset.modelId))];

    try {
        const res = await authFetch(`${API_URL}/models/validation-status/batch?ids=${modelIds.join(',')}`);
        if (!res || !res.ok) throw new Error('批量查询验收状态失败');
        const statusMap = await res.json();

        bars.forEach(bar => {
            const modelId = bar.dataset.modelId;
            const category = bar.dataset.category;
            const info = statusMap[modelId];

            if (!info || info.status === 'never') {
                bar.innerHTML = '<span style="color:#a0aec0;">暂无验收记录</span>' +
                    ` <a href="Model_Center.html?id=${modelId}&validate=1" style="color:#d97706;text-decoration:none;margin-left:8px;font-weight:500;">去验收 →</a>`;
                return;
            }

            const phases = info.phases || {};
            let phaseHtml = '';
            let allPass = true;

            if (category === 'ODS_SYNC') {
                // ODS: 单条验收状态（无分阶段）
                const passed = info.status === 'pass';
                phaseHtml = passed
                    ? '<span style="color:#48bb78;">✅ 已验收</span>'
                    : '<span>⬜ 未验收</span>';
                allPass = passed;
            } else if (category === 'DIM_DEV') {
                // DIM: 结构 + 数据 + 语义 三阶段
                const sPass = phases.structure && phases.structure.result === 'pass';
                const dPass = phases.data && phases.data.result === 'pass';
                const smPass = phases.semantic && phases.semantic.result === 'pass';
                phaseHtml = `${sPass ? '✅' : '⬜'} 结构  ${dPass ? '✅' : '⬜'} 数据  ${smPass ? '✅' : '⬜'} 语义`;
                allPass = sPass && dPass && smPass;
            } else if (category === 'DWD_DEV') {
                // DWD: 结构 + 数据 两阶段
                const sPass = phases.structure && phases.structure.result === 'pass';
                const dPass = phases.data && phases.data.result === 'pass';
                phaseHtml = `${sPass ? '✅' : '⬜'} 结构  ${dPass ? '✅' : '⬜'} 数据`;
                allPass = sPass && dPass;
            }

            if (allPass && phaseHtml) {
                // 全部通过：绿色背景
                bar.style.background = '#f0fff4';
                bar.style.borderColor = '#c6f6d5';
                bar.innerHTML = `<span style="color:#38a169;font-weight:500;">✅ 验收通过</span> <span style="color:#68d391;margin-left:4px;">(${phaseHtml.replace(/✅/g, '').trim().replace(/\s{2,}/g, ' + ')})</span>`;
            } else {
                // 部分通过或未通过
                bar.innerHTML = `<span style="color:#718096;">验收：</span>${phaseHtml}` +
                    ` <a href="Model_Center.html?id=${modelId}&validate=1" style="color:#d97706;text-decoration:none;margin-left:8px;font-weight:500;">去验收 →</a>`;
            }
        });
    } catch (err) {
        console.error('填充验收状态失败:', err);
        bars.forEach(bar => {
            bar.innerHTML = '<span style="color:#cbd5e0;">验收状态查询失败</span>';
        });
    }
}

// ==================== 已归档表格相关函数 ====================

// 统一更新已归档表格视图（排序+过滤+分页）
function updateArchivedTableView() {
    const tasks = window._archivedTasksData;
    const sortState = window._archivedSortState;
    const pageState = window._archivedPageState;
    if (!tasks) return;

    // 1. 排序
    const sorted = [...tasks].sort((a, b) => {
        let valA, valB;
        switch (sortState.field) {
            case 'archived_at':
                valA = new Date(a.archived_at || a.updated_at || a.done_at || a.created_at).getTime();
                valB = new Date(b.archived_at || b.updated_at || b.done_at || b.created_at).getTime();
                break;
            case 'priority':
                const pOrder = { 'P0': 0, 'P1': 1, 'P2': 2, 'P3': 3 };
                valA = pOrder[a.priority] ?? 9;
                valB = pOrder[b.priority] ?? 9;
                break;
            case 'category':
                valA = a.category || '';
                valB = b.category || '';
                break;
            case 'title':
                valA = (a.title || '').toLowerCase();
                valB = (b.title || '').toLowerCase();
                break;
            case 'owner':
                valA = (a.owner || '').toLowerCase();
                valB = (b.owner || '').toLowerCase();
                break;
            case 'dev_hours':
                valA = a.dev_hours || 0;
                valB = b.dev_hours || 0;
                break;
            default:
                return 0;
        }
        if (valA < valB) return sortState.asc ? -1 : 1;
        if (valA > valB) return sortState.asc ? 1 : -1;
        return 0;
    });

    // 2. 过滤
    const searchInput = document.getElementById('archivedSearchInput');
    const keyword = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const filtered = keyword ? sorted.filter(task => matchArchivedTask(task, keyword)) : sorted;

    // 保存过滤后的数据
    window._archivedFilteredData = filtered;

    // 3. 分页
    const totalCount = filtered.length;
    const totalPages = Math.ceil(totalCount / pageState.pageSize) || 1;

    // 确保当前页有效
    if (pageState.page > totalPages) pageState.page = totalPages;
    if (pageState.page < 1) pageState.page = 1;

    const startIdx = (pageState.page - 1) * pageState.pageSize;
    const endIdx = startIdx + pageState.pageSize;
    const pageData = filtered.slice(startIdx, endIdx);

    // 4. 渲染表格
    renderArchivedTableBody(pageData);

    // 5. 渲染分页控件
    renderArchivedPagination(totalCount, totalPages, pageState.page);

    // 6. 更新搜索计数
    const countEl = document.getElementById('archivedSearchCount');
    if (countEl) {
        countEl.textContent = keyword ? `找到 ${totalCount} 条结果` : '';
    }

    // 7. 更新排序图标
    document.querySelectorAll('#archivedTable th.sortable .sort-icon').forEach(icon => {
        icon.textContent = '';
    });
    const activeHeader = document.querySelector(`#archivedTable th[data-field="${sortState.field}"] .sort-icon`);
    if (activeHeader) {
        activeHeader.textContent = sortState.asc ? '▲' : '▼';
    }
}

// 渲染已归档表格内容
function renderArchivedTableBody(tasks) {
    const tbody = document.getElementById('archivedTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    tasks.forEach(task => {
        try {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = () => openTaskDetailDrawer(task.id);

            // 归档时间
            const archiveTime = formatDateTimeUnified(task.archived_at || task.updated_at || task.done_at || task.created_at, 'short');

            // 优先级
            let priorityDisplay = '-';
            const pStyles = {
                'P0': 'background:#e53e3e;color:white;',
                'P1': 'background:#dd6b20;color:white;',
                'P2': 'background:#3182ce;color:white;',
                'P3': 'background:#a0aec0;color:white;'
            };
            if (pStyles[task.priority]) {
                priorityDisplay = `<span style="${pStyles[task.priority]}padding:2px 6px;border-radius:4px;font-size:0.8em;font-weight:bold;">${task.priority}</span>`;
            }

            // 任务类型
            const catLabel = CATEGORY_MAP[task.category] || 'DWD开发';
            const catCls = `cat-${(task.category || 'DWD_DEV').toLowerCase().split('_')[0]}`;
            const catBadge = `<span class="category-badge ${catCls}" style="font-size:0.8em;">${catLabel}</span>`;

            // 任务/数据表 合并列
            const modelName = task.linked_model_name || '';
            const isModelDeleted = task.linked_model_is_deleted === 1;
            const titleCore = (task.title || '').replace(/^\[.*?\]\s*/, '');
            let taskModelDisplay = `<div style="font-weight:600;color:#2d3748;">${escapeHtml(titleCore)}</div>`;
            if (modelName) {
                const deletedStyle = isModelDeleted ? 'background:#fed7d7;color:#e53e3e;' : 'background:#edf2f7;';
                const deletedTag = isModelDeleted ? ' <span style="color:#e53e3e;font-weight:500;">(已删除)</span>' : '';
                taskModelDisplay += `<div style="font-size:0.85em;color:#718096;margin-top:2px;">
                    <code style="${deletedStyle}padding:1px 4px;border-radius:3px;font-size:0.9em;">${escapeHtml(modelName)}</code>${deletedTag}
                </div>`;
            }

            // 开发工时 vs 预估（dev_hours 是实际开发时间，不含等待/搁置）
            let timeDisplay = '-';
            if (task.dev_hours > 0) {
                const devSeconds = task.dev_hours;
                const estimatedHours = task.estimated_hours || 0;
                const devFormatted = formatDuration(devSeconds);

                if (estimatedHours > 0) {
                    const estimatedSeconds = estimatedHours * 3600;
                    const deviation = ((devSeconds - estimatedSeconds) / estimatedSeconds * 100).toFixed(0);
                    let deviationColor = '#22c55e';
                    let deviationText = `(${deviation}%)`;
                    if (deviation > 0) {
                        deviationColor = '#ef4444';
                        deviationText = `(+${deviation}%)`;
                    }
                    timeDisplay = `${devFormatted} / ${estimatedHours}h <span style="color:${deviationColor};font-size:0.85em;">${deviationText}</span>`;
                } else {
                    timeDisplay = devFormatted;
                }
            }

            // 交付物数量
            let attachmentCount = 0;
            if (task.attachments && task.attachments.length > 0) {
                attachmentCount = task.attachments.length;
            } else if (task.file_path) {
                attachmentCount = 1;
            }
            const attachmentDisplay = attachmentCount > 0
                ? `<span style="color:#4a5568;">${attachmentCount}个</span>`
                : '<span style="color:#a0aec0;">-</span>';

            tr.innerHTML = `
                <td style="color:#718096;font-size:0.9em;white-space:nowrap;">${archiveTime}</td>
                <td style="text-align:center;">${priorityDisplay}</td>
                <td>${catBadge}</td>
                <td style="max-width:350px;">${taskModelDisplay}</td>
                <td style="color:#4a5568;">${escapeHtml(task.owner || '-')}</td>
                <td style="font-size:0.85em;white-space:nowrap;">${timeDisplay}</td>
                <td style="text-align:center;">${attachmentDisplay}</td>
            `;
            tbody.appendChild(tr);
        } catch (trErr) {
            console.error("渲染已归档表格行失败:", trErr, task);
        }
    });
}

// 渲染分页控件
function renderArchivedPagination(totalCount, totalPages, currentPage) {
    const container = document.getElementById('archivedPagination');
    if (!container) return;

    if (totalCount <= 20) {
        container.innerHTML = '';
        return;
    }

    const pageState = window._archivedPageState;
    let html = `<div class="pagination-info">共 ${totalCount} 条，第 ${currentPage}/${totalPages} 页</div>`;
    html += '<div class="pagination-btns">';

    // 上一页
    html += `<button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="goArchivedPage(${currentPage - 1})">上一页</button>`;

    // 页码按钮
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        html += `<button class="page-btn" onclick="goArchivedPage(1)">1</button>`;
        if (startPage > 2) html += `<span class="page-ellipsis">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goArchivedPage(${i})">${i}</button>`;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) html += `<span class="page-ellipsis">...</span>`;
        html += `<button class="page-btn" onclick="goArchivedPage(${totalPages})">${totalPages}</button>`;
    }

    // 下一页
    html += `<button class="page-btn" ${currentPage >= totalPages ? 'disabled' : ''} onclick="goArchivedPage(${currentPage + 1})">下一页</button>`;
    html += '</div>';

    container.innerHTML = html;
}

// 跳转到指定页
function goArchivedPage(page) {
    const pageState = window._archivedPageState;
    if (!pageState) return;
    pageState.page = page;
    updateArchivedTableView();
}

// 已归档表格排序
function sortArchivedTable(field) {
    const state = window._archivedSortState;
    if (!state) return;

    // 切换排序方向
    if (state.field === field) {
        state.asc = !state.asc;
    } else {
        state.field = field;
        state.asc = true;
    }

    // 重置到第一页
    window._archivedPageState.page = 1;

    updateArchivedTableView();
}

// 匹配搜索关键词
function matchArchivedTask(task, keyword) {
    const title = (task.title || '').toLowerCase();
    const modelName = (task.linked_model_name || '').toLowerCase();
    const modelComment = (task.linked_model_comment || '').toLowerCase();
    const owner = (task.owner || '').toLowerCase();
    return title.includes(keyword) || modelName.includes(keyword) || modelComment.includes(keyword) || owner.includes(keyword);
}

// 搜索过滤已归档表格
function filterArchivedTable(keyword) {
    // 搜索时重置到第一页
    window._archivedPageState.page = 1;
    updateArchivedTableView();
}

function createCard(task) {
    const div = document.createElement('div');
    div.className = 'task-card';
    div.id = `task-card-${task.id}`;

    let actionBtn = '';
    let statusBadge = '';
    let dateStr = formatDateTimeUnified(task.created_at);
    // 对 JS 回调使用纯净字符串，移除可能破坏语法的所有符号
    const jsSafeTitle = (task.title || '').replace(/['"\\]/g, ' ').replace(/\n/g, ' ');
    const jsSafeDesc = (task.desc || '').replace(/['"\\]/g, ' ').replace(/\n/g, ' ');

    // OPEN 状态由表格处理,但保留回退逻辑以防万一
    if (task.status === 'OPEN') {
        statusBadge = '<span class="status-badge badge-open">待认领</span>';
        // 管理员和发布者可以分配，普通用户可以认领
        if (isAdmin() || isPublisher()) {
            actionBtn = `
                <div class="task-actions">
                    <button class="btn-claim" style="background:#ed8936;color:white;" onclick="openAssignModal(${task.id}, '${jsSafeTitle}')" title="直接分配给指定人员，立即生效">${SVG_ICONS.send}分配</button>
                    <button class="btn-claim btn-primary-action" onclick="openClaimModal(${task.id}, '${jsSafeTitle}')">${SVG_ICONS.userCheck}认领</button>
                </div>`;
        } else {
            actionBtn = `<button class="btn-claim btn-primary-action" onclick="openClaimModal(${task.id}, '${jsSafeTitle}')">${SVG_ICONS.userCheck}认领</button>`;
        }
    } else if (task.status === 'ON_HOLD') {
        div.classList.add('card-hold');
        statusBadge = '<span class="status-badge badge-hold">存疑</span>';
        let reasonHtml = `
            <div style="flex:1; margin-bottom:12px;">
                <div class="hold-reason" style="margin-bottom:6px;">
                    <strong>${SVG_ICONS.helpCircle} 问题:</strong> ${escapeHtml(task.hold_reason || '未说明原因')}
                </div>
                <div style="font-size:0.85em; color:#718096; display:flex; align-items:center;">
                    <span style="background: #edf2f7; padding: 2px 6px; border-radius: 4px; color: #4a5568;">${SVG_ICONS.user}提出人: ${escapeHtml(task.hold_by || '未知')}</span>
                </div>
            </div>`;
        let resolveBtn = `<button class="btn-resolve" onclick="resolveHold(${task.id})">${SVG_ICONS.check}解决/恢复</button>`;
        actionBtn = `
                    <div style="display:flex; flex-direction:column; height:100%;">
                        ${reasonHtml}
                        <div class="task-actions" style="margin-top:auto;">
                            ${resolveBtn}
                            ${isAdmin() ? `<button class="btn-claim btn-danger" onclick="deleteTask(${task.id})">${SVG_ICONS.trash}删除</button>` : ''}
                        </div>
                    </div>`;

        if (isViewer()) {
            actionBtn = `
                <div style="display:flex; flex-direction:column; height:100%;">
                    ${reasonHtml}
                    <div class="task-actions" style="margin-top:auto; justify-content: flex-end;">
                         <span style="color:#a0aec0;font-size:0.85em;">只读</span>
                    </div>
                </div>`;
        }
    } else if (task.status === 'CLAIMED') {
        statusBadge = '<span class="status-badge badge-claimed">进行中</span>';
        let transferBtn = '';
        if (isOwner(task)) {
            transferBtn = `<button class="btn-claim" style="background:#ed8936;color:white;" onclick="openTransferModal(${task.id}, '${jsSafeTitle}')" title="转发给他人，需对方确认后生效">🔀 转发</button>`;
        } else if (isAdmin() || isPublisher()) {
            transferBtn = `<button class="btn-claim" style="background:#ed8936;color:white;" onclick="openAssignModal(${task.id}, '${jsSafeTitle}')" title="直接分配给指定人员，立即生效">${SVG_ICONS.send}重新分配</button>`;
        }

        // 检查是否需要模型关联提示 - 简化为小标签
        const needsModel = ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(task.category);
        const hasModel = task.linked_model_id;
        let modelTip = '';
        if (needsModel && !hasModel && isOwner(task)) {
            modelTip = `<a href="Model_Center.html" target="_blank" style="display:inline-block; background:#fef3c7; color:#92400e; padding:4px 8px; border-radius:4px; font-size:0.75em; margin-bottom:8px; text-decoration:none;" title="开发类任务建议关联模型，以便自动同步模型状态">${SVG_ICONS.alertTriangle}未关联模型</a>`;
        }

        // 常见问题速查提示 (仅对任务所有者显示)
        let taskTipHtml = '';
        if (isOwner(task) && TASK_TIPS[task.category]) {
            const tipConfig = TASK_TIPS[task.category];
            taskTipHtml = `
                <div class="task-tips collapsed" onclick="toggleTaskTips(this, event)">
                    <div class="tips-header">
                        ${tipConfig.icon} ${tipConfig.title}
                        <span class="expand-icon">▼</span>
                    </div>
                    <ul class="tips-list">
                        ${tipConfig.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}
                    </ul>
                </div>`;
        }

        if (isOwner(task) || isAdmin() || isPublisher()) {
            // 精简版：编辑按钮和开发笔记移至抽屉，卡片上仅保留核心操作

            // 开发笔记入口按钮 (仅任务负责人可见，点击打开抽屉)
            const devNotesBtn = isOwner(task) ? `
                <button class="btn-claim" style="background:${task.dev_notes ? '#fef3c7' : 'white'}; color:${task.dev_notes ? '#92400e' : '#718096'}; border:1px solid ${task.dev_notes ? '#fbbf24' : '#e2e8f0'};" onclick="openTaskDetailDrawer(${task.id})" title="${task.dev_notes ? '有开发笔记，点击查看' : '记录开发笔记'}">${SVG_ICONS.fileText}笔记</button>` : '';

            // "去开发"按钮：关联模型的开发类任务，跳转到模型中心进入开发模式
            const devCategories = ['DIM_DEV', 'DWD_DEV', 'ODS_SYNC'];
            const showGoDevBtn = (isOwner(task) || isAdmin() || isPublisher()) && task.linked_model_id && devCategories.includes(task.category);
            const devBtnColors = { 'DIM_DEV': 'linear-gradient(135deg, #d97706, #b45309)', 'DWD_DEV': 'linear-gradient(135deg, #10b981, #059669)', 'ODS_SYNC': 'linear-gradient(135deg, #3b82f6, #2563eb)' };
            const goDevBtn = showGoDevBtn ? `
                <a href="Model_Center.html?id=${task.linked_model_id}&dev=1" class="btn-claim" style="background:${devBtnColors[task.category] || 'linear-gradient(135deg, #667eea, #764ba2)'}; color:white; border:none; text-decoration:none; display:inline-flex; align-items:center; font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:3px;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>去开发</a>` : '';

            actionBtn = `
                    <div class="task-actions">
                        ${modelTip}
                        ${taskTipHtml}
                        <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            ${goDevBtn}
                            ${devNotesBtn}
                            <button class="btn-claim btn-danger" onclick="unclaimTask(${task.id})">🏃 放弃</button>
                            ${transferBtn}
                            <button class="btn-submit" onclick="openSubmitModal(${task.id}, '${jsSafeTitle}', '${task.category || 'DWD_DEV'}')">${SVG_ICONS.rocket}提交</button>
                        </div>
                    </div>`;
        } else {
            actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">归属: ${escapeHtml(task.owner)}</span>`;
        }

        if (isViewer()) {
            actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">${task.owner} 进行中</span>`;
        }
        dateStr = `<span title="认领时间" style="font-size:0.85em;color:#718096;">认领于: ${formatDateTimeUnified(task.claimed_at)}</span>`;
    } else if (task.status === 'TRANSFERRING') {
        // 转发中状态
        statusBadge = '<span class="status-badge" style="background:linear-gradient(135deg, #ed8936, #dd6b20);color:white;">转发中</span>';
        const receiverName = task.transfer_to_name || '接收者';
        if (isOwner(task)) {
            // 转发者可以撤回
            actionBtn = `
                    <div class="task-actions">
                        <span style="color:#ed8936;font-size:0.8em;">${SVG_ICONS.clock}等待 ${receiverName} 确认</span>
                        <button class="btn-claim" style="background:#e53e3e;color:white;" onclick="cancelMyTransfer(${task.id})">${SVG_ICONS.x}撤回</button>
                    </div>`;
        } else {
            actionBtn = `<span style="color:#ed8936;font-size:0.85em;">${SVG_ICONS.clock}转发给 ${receiverName}</span>`;
        }
        dateStr = `<span title="认领时间" style="font-size:0.85em;color:#718096;">认领于: ${formatDateTimeUnified(task.claimed_at)}</span>`;
    } else if (task.status === 'DONE') {
        statusBadge = '<span class="status-badge badge-done">待确认</span>';
        const isDimDwd = ['DIM_DEV', 'DWD_DEV'].includes(task.category);
        // 权限控制: 管理员/发布者可归档所有层级; ODS owner可自行归档; DIM/DWD owner需等待管理员
        if (isAdmin() || isPublisher()) {
            actionBtn = `
                    <div class="task-actions">
                        <button class="btn-claim" onclick="withdrawTask(${task.id})">${SVG_ICONS.refresh}继续开发</button>
                        <button class="btn-claim btn-primary-action" onclick="confirmTask(${task.id})">${SVG_ICONS.check}归档</button>
                    </div>`;
        } else if (isOwner(task)) {
            if (isDimDwd) {
                // DIM/DWD owner: 显示继续开发 + 等待管理员归档提示
                actionBtn = `
                    <div class="task-actions">
                        <button class="btn-claim" onclick="withdrawTask(${task.id})">${SVG_ICONS.refresh}继续开发</button>
                        <span style="color:#a0aec0;font-size:0.8em;">等待管理员归档</span>
                    </div>`;
            } else {
                // ODS/其他 owner: 显示继续开发按钮
                actionBtn = `
                    <div class="task-actions">
                        <button class="btn-claim" onclick="withdrawTask(${task.id})">${SVG_ICONS.refresh}继续开发</button>
                    </div>`;
            }
        } else {
            actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">等待管理员确认</span>`;
        }

        if (isViewer()) {
            actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">待确认</span>`;
        }
        dateStr = `<span style="font-size:0.85em;color:#718096;">提交于: ${formatDateTimeUnified(task.done_at)}</span>`;
    } else if (task.status === 'ARCHIVED') {
        statusBadge = '<span class="status-badge" style="background:#cbd5e0; color:#4a5568;">已归档</span>';
        // 精简版：操作按钮移至抽屉，卡片仅显示状态文字
        actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">已完成</span>`;

        if (isViewer()) {
            actionBtn = `<span style="color:#a0aec0;font-size:0.85em;">已归档</span>`;
        }
    }

    let fileLink = '';

    // 简化附件显示：卡片上仅显示摘要，详情在抽屉查看
    if (task.attachments && task.attachments.length > 0) {
        const count = task.attachments.length;
        fileLink = `<div class="attachment-summary" style="margin-top:8px;font-size:0.85em;color:#4a5568;cursor:pointer;" onclick="openTaskDetailDrawer(${task.id})" title="点击查看交付物详情">
                    ${SVG_ICONS.fileText} ${count}个交付物
                </div>`;
    }
    // 兼容旧的单附件 - 同样简化为摘要
    else if (task.file_path) {
        fileLink = `<div class="attachment-summary" style="margin-top:8px;font-size:0.85em;color:#4a5568;cursor:pointer;" onclick="openTaskDetailDrawer(${task.id})" title="点击查看交付物详情">
                    ${SVG_ICONS.fileText} 1个交付物
                </div>`;
    }

    // 提交说明已移至详情抽屉，卡片不再显示
    let submissionBlock = '';

    // DONE 状态卡片: 验收状态提示栏（异步填充）
    let validationHintHtml = '';
    if (task.status === 'DONE' && task.linked_model_id && ['ODS_SYNC', 'DIM_DEV', 'DWD_DEV'].includes(task.category)) {
        // 占位容器，由 fillDoneCardValidationStatus() 异步填充
        validationHintHtml = `<div class="validation-hint-bar" data-model-id="${task.linked_model_id}" data-category="${task.category}" style="margin:8px 0;padding:8px 10px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:0.82em;color:#718096;">
            <span style="color:#a0aec0;">验收状态加载中...</span>
        </div>`;
    }

    const catConfig = {
        'ODS_SYNC': { label: 'ODS同步', cls: 'cat-ods' },
        'DIM_DEV': { label: 'DIM开发', cls: 'cat-dim' },
        'DWD_DEV': { label: 'DWD开发', cls: 'cat-dwd' },
        'ADS_RPT': { label: 'ADS报表', cls: 'cat-ads' },
        'DATA_FIX': { label: '数据运维', cls: 'cat-fix' }
    };
    const cat = catConfig[task.category] || catConfig['DWD_DEV'];
    const catBadge = `<span class="category-badge ${cat.cls}">${cat.label}</span>`;

    // 管理员: 添加"编辑类型"按钮 (仅对非归档状态的任务)
    let categoryEditBtn = '';
    if (isAdmin() && task.status === 'OPEN') {
        categoryEditBtn = `<button class="btn-claim btn-secondary" style="background:#4299e1;color:white;font-size:0.75em;padding:4px 10px;margin-left:8px;" onclick="openEditCategoryModal(${task.id}, '${task.category || 'DWD_DEV'}')">${SVG_ICONS.tag}编辑类型</button>`;
    }

    // 优先级样式处理
    let priorityBadge = '';
    if (task.priority === 'P0') {
        priorityBadge = '<span style="background:#e53e3e;color:white;padding:2px 6px;border-radius:4px;font-size:0.75em;margin-right:5px;font-weight:bold;">🔴 P0</span>';
    } else if (task.priority === 'P1') {
        priorityBadge = '<span style="background:#dd6b20;color:white;padding:2px 6px;border-radius:4px;font-size:0.75em;margin-right:5px;font-weight:bold;">🟠 P1</span>';
    } else if (task.priority === 'P2') {
        priorityBadge = '<span style="background:#3182ce;color:white;padding:2px 6px;border-radius:4px;font-size:0.75em;margin-right:5px;font-weight:bold;">🔵 P2</span>';
    } else if (task.priority === 'P3') {
        priorityBadge = '<span style="background:#a0aec0;color:white;padding:2px 6px;border-radius:4px;font-size:0.75em;margin-right:5px;font-weight:bold;">⚪ P3</span>';
    }

    // ========== 工时信息显示 ==========
    let timeInfoHtml = '';
    if (['CLAIMED', 'ON_HOLD', 'TRANSFERRING'].includes(task.status)) {
        // 进行中任务显示已用时间和进度条
        const elapsed = task.elapsed_hours || 0;
        const estimated = task.estimated_hours || 0;

        if (estimated > 0) {
            const percentage = Math.min(100, (elapsed / estimated) * 100);
            let barClass = 'time-bar-normal';
            if (percentage >= 80) barClass = 'time-bar-warning';
            if (percentage >= 100) barClass = 'time-bar-danger';

            const overdueTag = task.is_overdue ? '<span class="overdue-tag">已超时</span>' : '';

            timeInfoHtml = `
                <div class="time-tracker">
                    <div class="time-text">
                        ${SVG_ICONS.clock} ${elapsed.toFixed(1)}h / ${estimated}h ${overdueTag}
                    </div>
                    <div class="time-bar">
                        <div class="time-bar-fill ${barClass}" style="width:${Math.min(percentage, 100)}%"></div>
                    </div>
                </div>`;
        } else if (elapsed > 0) {
            timeInfoHtml = `<div class="time-text" style="margin:8px 0;font-size:0.85em;color:#64748b;">${SVG_ICONS.clock} 已用 ${elapsed.toFixed(1)}h</div>`;
        }
    } else if (['DONE', 'ARCHIVED'].includes(task.status) && task.dev_hours > 0) {
        // 已完成任务显示开发工时vs预估（dev_hours 是实际开发时间，不含等待/搁置）
        const devSeconds = task.dev_hours;
        const estimatedSeconds = (task.estimated_hours || 0) * 3600;
        let deviationText = '';

        if (estimatedSeconds > 0) {
            const deviation = ((devSeconds - estimatedSeconds) / estimatedSeconds * 100).toFixed(0);
            if (deviation > 0) {
                deviationText = `<span style="color:#ef4444;margin-left:4px;">(+${deviation}%)</span>`;
            } else if (deviation < 0) {
                deviationText = `<span style="color:#22c55e;margin-left:4px;">(${deviation}%)</span>`;
            } else {
                deviationText = `<span style="color:#22c55e;margin-left:4px;">(准时)</span>`;
            }
        }

        const estimated = task.estimated_hours || 0;
        timeInfoHtml = `
            <div class="time-summary" style="font-size:0.85em;color:#64748b;margin:8px 0;">
                ${SVG_ICONS.check} 开发 ${formatDuration(devSeconds)} ${estimated > 0 ? `/ 预估 ${estimated}h ${deviationText}` : ''}
            </div>`;
    }

    // 注意: div 已在函数开头声明,此处仅赋值属性
    div.className = `task-card ${(task.status || 'open').toLowerCase()} ${task.priority === 'P0' ? 'card-p0' : ''} ${task.is_overdue ? 'card-overdue' : ''}`;
    div.draggable = true;
    div.dataset.id = task.id;

    // 模型关联显示 - 简化版：仅显示模型名和状态，源系统信息移至抽屉
    let modelLinkage = '';
    if (task.linked_model_name) {
        const isModelDeleted = task.linked_model_is_deleted === 1;
        const mStatus = isModelDeleted ? 'DELETED' : (task.linked_model_status || 'OFFLINE');
        const statusColor = isModelDeleted ? '#e53e3e' : (mStatus === 'ONLINE' ? '#48bb78' : (mStatus === 'REVIEWING' ? '#ed8936' : '#a0aec0'));
        const statusText = isModelDeleted ? '已删除' : (mStatus === 'ONLINE' ? '已上线' : (mStatus === 'REVIEWING' ? '待验收' : '规划中'));
        // 优先显示中文描述，如果没有则显示表名
        const displayName = task.linked_model_comment || task.linked_model_name;

        // 简化：卡片上不显示源系统信息，移至抽屉查看
        modelLinkage = `
            <div style="font-size:0.8em;color:${isModelDeleted ? '#e53e3e' : '#718096'};margin-bottom:6px;display:flex;align-items:center;" title="${task.linked_model_name} (${statusText})">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};margin-right:4px;" title="${statusText}"></span>
                <span>${isModelDeleted ? '🔗 ' : '🔗 '}${escapeHtml(displayName)}${isModelDeleted ? ' (已删除)' : ''}</span>
            </div>`;
    }

    // 转义HTML防止XSS (为了展示,使用更安全的转义)
    const safeTitle = escapeHtml(task.title);
    const safeDesc = escapeHtml(task.description || task.desc || '');
    const createTime = formatDateTimeUnified(task.created_at, 'short');

    // 动态决定显示的时间和标题
    let displayTime = '';
    let timeTitle = '创建时间';
    let timeLabel = '发布于:';

    if (task.status === 'ARCHIVED') {
        // 优先使用归档时间，如果没有则使用完成时间(done_at)，最后兜底创建时间
        displayTime = formatDateTimeUnified(task.archived_at || task.updated_at || task.done_at || task.created_at);
        timeTitle = '归档时间';
        timeLabel = '归档于:';
    } else if (task.status === 'DONE') {
        displayTime = formatDateTimeUnified(task.done_at);
        timeTitle = '提交时间';
        timeLabel = '提交于:';
    } else if (['CLAIMED', 'TRANSFERRING'].includes(task.status)) {
        displayTime = formatDateTimeUnified(task.claimed_at);
        timeTitle = '认领时间';
        timeLabel = '认领于:';
    } else {
        displayTime = createTime; // 保持原有格式
        // 用户需求: "将时间格式调整为年月日时分秒...已提交和已归档...也相应调整"
        // 故全部统一为长格式
        displayTime = formatDateTimeUnified(task.created_at);
        timeLabel = '发布于:';
    }

    div.innerHTML = `
        <div class="card-header">
            <div class="task-title" title="${safeTitle}" onclick="openTaskDetailDrawer(${task.id})" style="cursor:pointer;">
                ${priorityBadge}${safeTitle}
            </div>
            ${statusBadge}
        </div>
        ${modelLinkage}
        <div class="task-meta">
            <span class="category-badge ${cat.cls}">${cat.label}</span>
            <div style="display:flex; flex-direction:column; align-items:flex-end;">
                 <div class="task-time" title="${timeTitle}">
                    📅 ${timeLabel} ${displayTime}
                 </div>
                 ${task.deadline && task.status !== 'ARCHIVED' ? (() => {
            const d = new Date(task.deadline);
            const now = new Date();
            const isOverdue = d < now && task.status !== 'ARCHIVED' && task.status !== 'DONE';
            const dateS = formatDateTimeUnified(d, 'short');
            const style = isOverdue ? 'color:#e53e3e;font-weight:bold;' : 'color:#718096;';
            return `<span style="font-size:0.85em; ${style}" title="截止时间">⌛ ${dateS}</span>`;
        })() : ''}
            </div>
        </div>
        ${safeDesc ? `<div class="task-desc">
            <button class="btn-remark-inline" onclick="openTaskDetailDrawer(${task.id})" title="${safeDesc}">
                💬 备注
            </button>
        </div>` : ''}
        ${timeInfoHtml}
        ${validationHintHtml}
        ${submissionBlock}
        ${fileLink}
        <div class="task-footer">
            ${task.status === 'ON_HOLD' ? '' : `<div class="task-owner">${task.owner ? `<span style="background:linear-gradient(135deg, #d97706, #b45309); width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff;">${SVG_ICONS.user}</span> ${escapeHtml(task.owner)}` : `${SVG_ICONS.user} 未分配`}</div>`}
            <div style="display:flex; align-items:center;">${actionBtn}${categoryEditBtn}</div>
        </div>
    `;

    // P0 优先级任务高亮显示
    if (task.priority === 'P0') {
        div.style.border = '2px solid #fc8181';
        div.style.boxShadow = '0 0 8px rgba(229, 62, 62, 0.2)';
    }

    return div;
}

const PLACEHOLDER_CONFIG = {
    'DWD_DEV': {
        title: '任务标题 (如: 开发 dwd_contract_detail 表)',
        desc: '业务背景、数据来源(ODS)、调度频率、交付要求等'
    },
    'ODS_SYNC': {
        title: '任务标题 (如: 同步 CRM t_bid_info 表)',
        desc: '源系统/表名、同步策略(增量/全量)、调度周期、主键'
    },
    'ADS_RPT': {
        title: '任务标题 (如: 销售月度业绩报表)',
        desc: '报表用途、计算逻辑、维度/指标定义、展示形式'
    },
    'DATA_FIX': {
        title: '任务标题 (如: 修复 dwd_order_info 数据重复)',
        desc: '问题现象、影响范围、修复方案、验证方式'
    }
};

// ==================== 任务-模型联动逻辑 ====================

let allModelsCache = [];

// 加载所有模型用于搜索关联
async function loadAllModels() {
    try {
        const res = await authFetch(`${API_URL}/models`);
        if (res && res.ok) {
            allModelsCache = await res.json();
            // 根据当前选中的任务类型过滤模型列表
            const categorySelect = document.getElementById('newCategory');
            const currentCategory = categorySelect ? categorySelect.value : 'DWD_DEV';
            filterModelsByCategory(currentCategory);
        }
    } catch (e) {
        console.error("加载模型失败", e);
    }
}

// 监听模型输入（保留扩展能力）
function onModelInput(input) {
    // 可在此处做防抖搜索优化（当前一次性加载够用）
}

// 选中模型后自动填充
async function onModelSelect(input) {
    const tableName = input.value;
    const model = allModelsCache.find(m => m.table_name === tableName);

    if (model) {
        // 1. 智能映射任务类型（仅在用户未手动选择时自动设置）
        const catMap = {
            'ODS': 'ODS_SYNC',
            'DWD': 'DWD_DEV',
            'DWS': 'DWD_DEV',
            'ADS': 'ADS_RPT',
            'DIM': 'DWD_DEV'
        };
        const suggestedCategory = catMap[model.layer] || 'DWD_DEV';
        const catSelect = document.getElementById('newCategory');

        // 检查用户是否已经手动选择了任务类型
        // 如果当前选择是默认值（DWD_DEV），则自动更新；否则保持用户选择
        if (catSelect) {
            const currentCategory = catSelect.value;
            // 如果当前是默认值或者是空值，才自动设置
            if (!currentCategory || currentCategory === 'DWD_DEV') {
                catSelect.value = suggestedCategory;
            } else {
                // 如果用户已选择其他类型，检查是否匹配
                // 如果不匹配，给出提示但不强制更改
                const layerToCategory = {
                    'ODS': 'ODS_SYNC',
                    'DWD': 'DWD_DEV',
                    'DWS': 'DWD_DEV',
                    'ADS': 'ADS_RPT',
                    'DIM': 'DWD_DEV'
                };
                const expectedCategory = layerToCategory[model.layer] || 'DWD_DEV';
                if (currentCategory !== expectedCategory) {
                    // 提示用户类型不匹配，但不强制更改
                    console.log(`提示: 模型层 ${model.layer} 通常对应任务类型 ${expectedCategory}，当前选择为 ${currentCategory}`);
                }
            }
        }

        // 使用实际的任务类型（可能是用户选择的，也可能是自动设置的）
        const actualCategory = catSelect ? catSelect.value : suggestedCategory;

        // 2. 检查该模型是否有归档任务，计算迭代版本
        // 归档1次=v1已完成，新任务是v2；归档2次=v2已完成，新任务是v3
        let versionSuffix = '';
        try {
            const res = await authFetch(`${API_URL}/models/${model.id}/archived-tasks-count`);
            if (res && res.ok) {
                const data = await res.json();
                if (data.archivedCount > 0) {
                    // 有归档任务，新任务版本 = 归档次数 + 1
                    versionSuffix = ` (v${data.archivedCount + 1})`;
                }
            }
        } catch (e) {
            console.error('检查归档任务数量失败:', e);
        }

        // 3. 自动填充标题: [类型] 中文名 (版本)
        const typeName = actualCategory === 'ODS_SYNC' ? '同步' :
            actualCategory === 'ADS_RPT' ? '报表' :
                actualCategory === 'DATA_FIX' ? '修复' : '开发';
        const newTitle = `[${typeName}] ${model.table_comment || model.table_name}${versionSuffix}`;
        document.getElementById('newTitle').value = newTitle;

        // 4. 显示模型信息预览卡片
        showModelPreview(model);

        // 5. DIM/DWS层模型任务类型映射说明
        if (model.layer === 'DIM' || model.layer === 'DWS') {
            const layerTip = document.getElementById('dimLayerTip');
            if (layerTip) {
                layerTip.style.display = 'block';
                layerTip.innerHTML = `<span style="color:#3182ce;">${SVG_ICONS.lightbulb}${model.layer}层模型自动映射为"DWD开发"任务类型</span>`;
            }
        } else {
            const layerTip = document.getElementById('dimLayerTip');
            if (layerTip) layerTip.style.display = 'none';
        }

        // 6. 记录其模型ID
        selectedModelId = model.id;
    } else {
        selectedModelId = null;
        hideModelPreview();
    }

    // 更新模型关联提示
    updateModelLinkTip();
}

// 显示模型信息预览卡片
function showModelPreview(model) {
    const preview = document.getElementById('modelInfoPreview');
    if (!preview) return;

    // 更新周期映射
    const cycleMap = {
        'di': '日增量',
        'df': '日全量',
        'da': '日累积'
    };

    // 图标映射 (使用SVG)
    const layerIconMap = {
        'ODS': SVG_ICONS.download,
        'DWD': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
        'DWS': SVG_ICONS.barChart,
        'ADS': SVG_ICONS.trendingUp,
        'DIM': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    };

    // 填充预览数据
    document.getElementById('previewModelIcon').innerHTML = layerIconMap[model.layer] || SVG_ICONS.barChart;
    document.getElementById('previewModelComment').textContent = model.table_comment || model.table_name;
    document.getElementById('previewTableName').textContent = model.table_name;
    document.getElementById('previewUpdateCycle').textContent = cycleMap[model.update_cycle] || model.update_cycle || '-';
    document.getElementById('previewTechOwner').textContent = model.tech_owner || '-';

    // 源系统信息（仅ODS层显示）
    const sourceInfo = document.getElementById('previewSourceInfo');
    if (model.source_system && model.source_table) {
        document.getElementById('previewSourceSystem').textContent = model.source_system;
        document.getElementById('previewSourceTable').textContent = model.source_table;
        sourceInfo.style.display = 'inline';
    } else {
        sourceInfo.style.display = 'none';
    }

    preview.style.display = 'block';
}

// 隐藏模型信息预览卡片
function hideModelPreview() {
    const preview = document.getElementById('modelInfoPreview');
    if (preview) {
        preview.style.display = 'none';
    }
}

// 清除模型选择
function clearModelSelection() {
    const modelInput = document.getElementById('newModelInput');
    if (modelInput) {
        modelInput.value = '';
    }
    // 同时清除标题和备注
    const titleInput = document.getElementById('newTitle');
    if (titleInput) {
        titleInput.value = '';
    }
    const descInput = document.getElementById('newDesc');
    if (descInput) {
        descInput.value = '';
    }
    selectedModelId = null;
    hideModelPreview();
    updateModelLinkTip();
}

// ==================== 流程指引切换 ====================

// 切换工作流程角色视图
function switchWorkflowRole(role) {
    const developerWorkflow = document.getElementById('developerWorkflow');
    const publisherWorkflow = document.getElementById('publisherWorkflow');
    const workflowHintText = document.getElementById('workflowHintText');
    const tabs = document.querySelectorAll('.role-tab');

    // 更新标签状态
    tabs.forEach(tab => {
        if (tab.dataset.role === role) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // 切换流程显示
    if (role === 'developer') {
        if (developerWorkflow) developerWorkflow.style.display = 'flex';
        if (publisherWorkflow) publisherWorkflow.style.display = 'none';
        if (workflowHintText) {
            workflowHintText.innerHTML = `<strong>${SVG_ICONS.lightbulb}开发者提示：</strong>如果任务已关联模型，可跳过"模型注册"步骤，直接进行开发调试。`;
        }
    } else if (role === 'publisher') {
        if (developerWorkflow) developerWorkflow.style.display = 'none';
        if (publisherWorkflow) publisherWorkflow.style.display = 'flex';
        if (workflowHintText) {
            workflowHintText.innerHTML = `<strong>${SVG_ICONS.lightbulb}发布者提示：</strong>建议先在模型中心规划好模型命名，再发布任务时关联，方便开发者快速上手。`;
        }
    }
}

// ==================== 常见问题速查功能 ====================

function toggleTaskTips(element, e) {
    if (e) e.stopPropagation();
    element.classList.toggle('collapsed');
    const icon = element.querySelector('.expand-icon');
    if (icon) {
        icon.textContent = element.classList.contains('collapsed') ? '▶' : '▼';
    }
}

// 任务提示配置数据缓存
let taskTipsConfigCache = [];

// 打开任务提示配置模态框
async function openTaskTipsModal() {
    if (!isAdmin()) {
        alert('只有管理员可以配置提示内容');
        return;
    }

    document.getElementById('taskTipsModal').style.display = 'flex';

    // 加载所有配置（包含禁用的）
    try {
        const res = await authFetch(`${API_URL}/task-tips/all`);
        if (res.ok) {
            taskTipsConfigCache = await res.json();
            renderTaskTipsConfig();
        } else {
            document.getElementById('taskTipsConfigList').innerHTML = '<p style="color:#e53e3e;">加载配置失败</p>';
        }
    } catch (e) {
        console.error('Failed to load task tips config:', e);
        document.getElementById('taskTipsConfigList').innerHTML = '<p style="color:#e53e3e;">加载配置失败: ' + e.message + '</p>';
    }
}

// 渲染任务提示配置列表
function renderTaskTipsConfig() {
    const container = document.getElementById('taskTipsConfigList');
    if (!taskTipsConfigCache || taskTipsConfigCache.length === 0) {
        container.innerHTML = '<p style="color:#718096;">暂无配置数据</p>';
        return;
    }

    const categoryNames = {
        'ODS_SYNC': 'ODS同步',
        'DWD_DEV': 'DWD开发',
        'ADS_RPT': 'ADS报表',
        'DATA_FIX': '数据运维'
    };

    let html = '';
    taskTipsConfigCache.forEach((tip, index) => {
        const categoryLabel = categoryNames[tip.category] || tip.category;
        const tipsText = Array.isArray(tip.tips) ? tip.tips.join('\n') : tip.tips;

        html += `
        <div class="tip-config-item" data-id="${tip.id}" style="margin-bottom:20px; padding:15px; border:1px solid #e2e8f0; border-radius:8px; background:#fafafa;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:1.2em;">${escapeHtml(tip.icon)}</span>
                    <strong style="color:#2d3748;">${categoryLabel}</strong>
                    <span style="color:#718096; font-size:0.85em;">(${tip.category})</span>
                </div>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                    <input type="checkbox" ${tip.enabled ? 'checked' : ''} onchange="taskTipsConfigCache[${index}].enabled = this.checked ? 1 : 0" style="width:16px; height:16px;">
                    <span style="font-size:0.85em; color:#4a5568;">启用</span>
                </label>
            </div>
            <div style="display:flex; gap:10px; margin-bottom:10px;">
                <div style="flex:0 0 60px;">
                    <label style="font-size:0.8em; color:#718096;">图标</label>
                    <input type="text" value="${escapeHtml(tip.icon)}" onchange="taskTipsConfigCache[${index}].icon = this.value"
                        style="width:100%; padding:6px; border:1px solid #e2e8f0; border-radius:4px; font-size:1.2em; text-align:center;">
                </div>
                <div style="flex:1;">
                    <label style="font-size:0.8em; color:#718096;">标题</label>
                    <input type="text" value="${escapeHtml(tip.title)}" onchange="taskTipsConfigCache[${index}].title = this.value"
                        style="width:100%; padding:6px 10px; border:1px solid #e2e8f0; border-radius:4px;">
                </div>
            </div>
            <div>
                <label style="font-size:0.8em; color:#718096;">提示内容（每行一条）</label>
                <textarea rows="4" onchange="taskTipsConfigCache[${index}].tips = this.value.split('\\n').filter(s => s.trim())"
                    style="width:100%; padding:8px 10px; border:1px solid #e2e8f0; border-radius:4px; font-size:0.9em; resize:vertical; box-sizing:border-box;">${escapeHtml(tipsText)}</textarea>
            </div>
        </div>
        `;
    });

    container.innerHTML = html;
}

// 保存所有任务提示配置
async function saveAllTaskTips() {
    if (!isAdmin()) {
        alert('只有管理员可以保存配置');
        return;
    }

    try {
        let successCount = 0;
        let failCount = 0;

        for (const tip of taskTipsConfigCache) {
            const res = await authFetch(`${API_URL}/task-tips/${tip.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    icon: tip.icon,
                    title: tip.title,
                    tips: Array.isArray(tip.tips) ? tip.tips : tip.tips.split('\n').filter(s => s.trim()),
                    enabled: tip.enabled,
                    sort_order: tip.sort_order || 0
                })
            });

            if (res.ok) {
                successCount++;
            } else {
                failCount++;
                console.error('Failed to save tip:', tip.category);
            }
        }

        if (failCount === 0) {
            alert(`保存成功！共更新 ${successCount} 项配置。`);
            // 重新加载前端使用的提示配置
            await loadTaskTips();
            closeModal('taskTipsModal');
        } else {
            alert(`部分保存失败：${successCount} 成功，${failCount} 失败`);
        }
    } catch (e) {
        alert('保存失败: ' + e.message);
        console.error('Save task tips error:', e);
    }
}

// ==================== 开发笔记功能 ====================

function toggleDevNotes(section) {
    const content = section.querySelector('.dev-notes-content');
    const icon = section.querySelector('.notes-expand-icon');
    if (content && icon) {
        content.classList.toggle('collapsed');
        icon.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
    }
}

async function saveDevNotes(taskId) {
    const textarea = document.getElementById(`devNotes_${taskId}`);
    if (!textarea) return;

    const dev_notes = textarea.value.trim();

    try {
        const response = await authFetch(`${API_URL}/tasks/${taskId}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dev_notes })
        });

        if (response.ok) {
            // 静默保存成功，不刷新页面
            textarea.style.borderColor = '#48bb78';
            setTimeout(() => {
                textarea.style.borderColor = '#e2e8f0';
            }, 1000);
        } else {
            const data = await response.json();
            console.error('保存笔记失败:', data.error);
            textarea.style.borderColor = '#e53e3e';
        }
    } catch (error) {
        console.error('保存笔记出错:', error);
        textarea.style.borderColor = '#e53e3e';
    }
}

// 从抽屉保存开发笔记
async function saveDrawerDevNotes() {
    if (!currentDrawerTaskId) return;

    const textarea = document.getElementById('drawerDevNotesInput');
    if (!textarea) return;

    const dev_notes = textarea.value.trim();
    // 按钮在 textarea 的父容器 (#drawerDevNotesEditable) 内
    const saveBtn = document.querySelector('#drawerDevNotesEditable button');

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';

        const response = await authFetch(`${API_URL}/tasks/${currentDrawerTaskId}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dev_notes })
        });

        if (response.ok) {
            saveBtn.innerHTML = `${SVG_ICONS.check} 已保存`;
            textarea.style.borderColor = '#48bb78';

            // 更新本地缓存
            const task = allTasksCache.find(t => t.id === currentDrawerTaskId);
            if (task) task.dev_notes = dev_notes;

            setTimeout(() => {
                saveBtn.innerHTML = `${SVG_ICONS.save} 保存`;
                saveBtn.disabled = false;
                textarea.style.borderColor = '#68d391';
            }, 1500);
        } else {
            const data = await response.json();
            console.error('保存笔记失败:', data.error);
            saveBtn.innerHTML = `${SVG_ICONS.x} 失败`;
            textarea.style.borderColor = '#e53e3e';
            setTimeout(() => {
                saveBtn.innerHTML = `${SVG_ICONS.save} 保存`;
                saveBtn.disabled = false;
            }, 1500);
        }
    } catch (error) {
        console.error('保存笔记出错:', error);
        saveBtn.innerHTML = `${SVG_ICONS.x} 出错`;
        textarea.style.borderColor = '#e53e3e';
        setTimeout(() => {
            saveBtn.innerHTML = `${SVG_ICONS.save} 保存`;
            saveBtn.disabled = false;
        }, 1500);
    }
}

// ==================== 模板功能 ====================

function toggleTemplateMenu(btn, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const menu = document.getElementById('templateMenu');
    const isVisible = menu.style.display === 'block';

    if (isVisible) {
        // 关闭菜单
        menu.style.display = 'none';
        return;
    }

    // 计算按钮位置
    const rect = btn.getBoundingClientRect();
    const menuWidth = 200;
    const menuHeight = 220; // 4个选项的估算高度

    // 计算菜单位置 - 默认显示在按钮下方，右对齐
    let left = rect.right - menuWidth;
    let top = rect.bottom + 6;

    // 边界检测
    if (left < 10) {
        left = 10;
    }
    if (left + menuWidth > window.innerWidth - 10) {
        left = window.innerWidth - menuWidth - 10;
    }
    if (top + menuHeight > window.innerHeight - 10) {
        // 空间不足时显示在按钮上方
        top = rect.top - menuHeight - 6;
    }

    // 设置位置并显示
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.display = 'block';

    // 点击外部区域关闭菜单
    const closeMenu = (e) => {
        if (!menu.contains(e.target) && e.target !== btn) {
            menu.style.display = 'none';
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('scroll', closeMenu, true);
        }
    };

    // 延迟添加监听器，避免立即触发
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
        document.addEventListener('scroll', closeMenu, true); // 滚动时也关闭
    }, 10);
}

function applyTemplate(type, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const descInput = document.getElementById('newDesc');
    let template = "";

    if (type === 'ODS') {
        template = `【源系统】: \n【源表名】: \n【抽取策略】: 增量/全量\n【过滤条件】: 无`;
    } else if (type === 'DWD') {
        template = `【背景】: \n【口径】: \n【依赖】: \n【验收标准】: `;
    } else if (type === 'ADS') {
        template = `【报表用途】: \n【计算逻辑】: \n【展示形式】: `;
    } else if (type === 'FIX') {
        template = `【问题现象】: \n【影响范围】: \n【修复方案】: `;
    }

    // 填充模板内容
    descInput.value = template;
    descInput.focus();

    // 关闭菜单
    const menu = document.getElementById('templateMenu');
    menu.style.display = 'none';
}
// 任务类型对应的模型层映射
const CATEGORY_TO_LAYER_MAP = {
    'ODS_SYNC': ['ODS'],
    'DIM_DEV': ['DIM'],                              // DIM开发只关联DIM层模型
    'DWD_DEV': ['DWD', 'DWS', 'DIM'],
    'ADS_RPT': ['ADS'],
    'DATA_FIX': ['ODS', 'DWD', 'DWS', 'DIM', 'ADS']  // 运维可能涉及所有层
};

// 根据任务类型过滤模型列表
function filterModelsByCategory(category) {
    // 如果没传category，从当前选择获取
    if (!category) {
        category = document.getElementById('newCategory')?.value || 'DWD_DEV';
    }

    const datalist = document.getElementById('modelAllList');
    if (!datalist) return;
    if (!allModelsCache || allModelsCache.length === 0) return;

    const allowedLayers = CATEGORY_TO_LAYER_MAP[category] || [];

    // 过滤模型：仅按层级和伴生表过滤，所有模型默认显示并标注状态
    const filteredModels = allModelsCache.filter(m => {
        // 伴生表从属主表，不可独立关联任务
        if (m.companion_of) return false;

        const modelLayer = (m.layer || '').toUpperCase();
        return allowedLayers.includes(modelLayer);
    });

    // 排序：可用模型（无任务关联）置顶，已占用/已归档模型置后
    const isOccupied = m => m.latest_active_task_status || (m.archived_task_count || 0) > 0;
    filteredModels.sort((a, b) => (isOccupied(a) ? 1 : 0) - (isOccupied(b) ? 1 : 0));

    // 生成下拉选项，● 可用 / ○ 已占用或已归档
    datalist.innerHTML = filteredModels.map(m => {
        let statusMark = '';
        let prefix = isOccupied(m) ? '○' : '●';
        if (m.latest_active_task_status) {
            const status = m.latest_active_task_status;
            const owner = m.latest_active_task_owner || '';
            if (status === 'OPEN') statusMark = ' · 已发布待认领';
            else if (status === 'CLAIMED') statusMark = ` · 开发中(${owner})`;
            else if (status === 'TRANSFERRING') statusMark = ` · 转让中(${owner})`;
            else if (status === 'ON_HOLD') statusMark = ` · 存疑(${owner})`;
            else if (status === 'DONE') statusMark = ' · 待验收';
        } else if ((m.archived_task_count || 0) > 0) {
            statusMark = ` · 已归档v${m.archived_task_count}`;
        }

        return `<option value="${m.table_name}">${prefix} ${m.table_comment || m.table_name} [${m.layer}:${m.table_name}]${statusMark}</option>`;
    }).join('');

    // 清空当前选择的模型（因为筛选条件变了）
    const modelInput = document.getElementById('newModelInput');
    if (modelInput) {
        modelInput.value = '';
    }
    selectedModelId = null;
}

function updatePlaceholders() {
    const categoryEl = document.getElementById('newCategory');
    // 仅在 Task_Pool.html 页面执行（该页面才有 newCategory 元素）
    if (!categoryEl) return;

    const category = categoryEl.value;
    const config = PLACEHOLDER_CONFIG[category] || PLACEHOLDER_CONFIG['DWD_DEV'];

    document.getElementById('newTitle').placeholder = config.title;
    document.getElementById('newDesc').placeholder = config.desc;

    // 自动填充建议预估工时（仅当用户未手动修改时）
    const estHoursInput = document.getElementById('newEstHours');
    if (estHoursInput && estHoursInput.dataset.userModified !== 'true') {
        const suggestedHours = DEFAULT_HOURS_BY_CATEGORY[category] || 4;
        estHoursInput.value = suggestedHours;
    }

    // 同时过滤模型列表
    filterModelsByCategory(category);

    // 更新模型关联提示
    updateModelLinkTip();
}

// 更新模型关联提示（软引导）
function updateModelLinkTip() {
    const tipEl = document.getElementById('modelLinkTip');
    if (!tipEl) return;

    const category = document.getElementById('newCategory')?.value || '';
    const modelInput = document.getElementById('newModelInput')?.value || '';

    // 需要模型的任务类型：DWD_DEV, ODS_SYNC, ADS_RPT
    const needsModel = ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(category);
    const hasModel = modelInput.trim() !== '';

    // 需要模型但未选择时显示提示
    tipEl.style.display = (needsModel && !hasModel) ? 'block' : 'none';
}

// 发布任务 (需要管理员权限)
async function publishTask() {
    const title = document.getElementById('newTitle').value;
    const desc = document.getElementById('newDesc').value;
    const category = document.getElementById('newCategory').value;
    const priority = document.getElementById('newPriority').value || 'P2';
    const linked_model_id = selectedModelId; // 使用选中的模型ID
    const estimated_hours = parseFloat(document.getElementById('newEstHours')?.value) || 0; // 预估工时
    const deadline = document.getElementById('newDeadline')?.value || null; // 截止时间

    if (!title) return alert("请输入任务标题");

    const res = await authFetch(`${API_URL}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, desc: desc || '', category, priority, linked_model_id, estimated_hours, deadline })
    });

    if (res && res.ok) {
        // 清空输入
        document.getElementById('newTitle').value = '';
        document.getElementById('newDesc').value = '';
        document.getElementById('newModelInput').value = '';
        if (document.getElementById('newEstHours')) {
            document.getElementById('newEstHours').value = '';
            document.getElementById('newEstHours').dataset.userModified = 'false'; // 重置标记
        }
        if (document.getElementById('newDeadline')) {
            document.getElementById('newDeadline').value = '';
        }
        selectedModelId = null;
        hideModelPreview(); // 隐藏预览卡片

        // 重新触发类型切换以填充默认预估工时
        updatePlaceholders();

        loadTasks();
        loadAllModels(); // 刷新模型缓存，更新下拉列表中的任务状态
    } else if (res) {
        const data = await res.json();
        alert(data.error || '发布失败');
    }
}

// 认领任务 (直接使用当前登录用户)
async function claimTask(id) {
    const res = await authFetch(`${API_URL}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });

    if (res && res.ok) {
        // 重置类别筛选为"全部"，确保能看到刚认领的任务
        filterTasks('ALL');
        await loadTasks();
        // 认领成功后自动切换到"进行中"标签页
        switchTab('claimed');
    } else if (res) {
        const data = await res.json();
        alert(data.error || '认领失败');
    }
}

// 兼容旧的模态框方式(已废弃,保留向后兼容)
function openClaimModal(id, title) {
    // 直接认领,不再需要输入姓名
    claimTask(id);
}

async function confirmClaim() {
    await claimTask(currentTaskId);
    closeModal('claimModal');
}

// 根据任务类型和关联模型信息自动生成表内容描述
function generateTableDescription(task, category) {
    if (!task) return '';

    const tableName = task.linked_model_name || '';
    const tableComment = task.linked_model_comment || '';
    const sourceSystem = task.linked_model_source_system || '';
    const sourceTable = task.linked_model_source_table || '';

    // 如果没有关联模型，返回空让用户手动填写
    if (!tableName) return '';

    // 显示名称：优先用中文描述，否则用表名
    const displayName = tableComment || tableName;

    let desc = '';

    switch (category) {
        case 'ODS_SYNC':
            // ODS 同步：源表 → 目标表（符合数据流向）
            if (sourceSystem && sourceTable) {
                desc = `${sourceSystem}.${sourceTable}`;
            } else if (sourceTable) {
                desc = `${sourceTable}`;
            }
            if (tableComment && tableComment !== tableName) {
                desc += ` (${tableComment})`;
            }
            if (desc) {
                desc += ` → ${tableName}`;
            } else {
                desc = tableName;
                if (tableComment && tableComment !== tableName) {
                    desc += ` (${tableComment})`;
                }
            }
            break;

        case 'DIM_DEV':
            // 维度表：表名 + 说明
            desc = `${tableName}`;
            if (tableComment && tableComment !== tableName) {
                desc += ` - ${tableComment}`;
            }
            break;

        case 'DWD_DEV':
            // 明细表：表名 + 说明
            desc = `${tableName}`;
            if (tableComment && tableComment !== tableName) {
                desc += ` - ${tableComment}`;
            }
            break;

        case 'ADS_RPT':
            // 报表：表名 + 说明
            desc = `${tableName}`;
            if (tableComment && tableComment !== tableName) {
                desc += ` - ${tableComment}`;
            }
            break;

        default:
            desc = tableName;
            if (tableComment && tableComment !== tableName) {
                desc += ` - ${tableComment}`;
            }
    }

    return desc;
}

function openSubmitModal(id, title, category) {
    currentTaskId = id;

    // 获取任务完整信息（用于校验模型关联）
    const task = allTasksCache.find(t => t.id === id);
    currentTaskInfo = task || { id, title, category };

    document.getElementById('submitTaskTitle').innerText = title;

    // 自动生成数据表内容描述
    const autoDesc = generateTableDescription(task, category);
    document.getElementById('submitInfo').value = autoDesc;

    document.getElementById('attachmentList').innerHTML = '';

    // 脚本来源：由后端根据 config_mode + script_modified 自动判断，无需前端选择

    // === 交付物检测面板 ===
    const devStatusPanel = document.getElementById('devStatusPanel');
    const isModelTask = ['ODS_SYNC', 'DIM_DEV', 'DWD_DEV'].includes(category);
    const linkedModelId = currentTaskInfo.linked_model_id;

    if (isModelTask && linkedModelId) {
        devStatusPanel.style.display = 'block';
        loadDevStatusForSubmit(linkedModelId, category);
    } else {
        devStatusPanel.style.display = 'none';
    }

    // === 附件区：模型开发类任务（DIM/DWD）附件全部可选，默认收起 ===
    const attachWrap = document.getElementById('attachmentListWrap');
    const toggleHint = document.getElementById('attachmentToggleHint');
    const chevron = document.getElementById('attachmentChevron');

    // 根据任务类型预置附件（区分必填和推荐）
    let requiredTypes = [];  // 必填项
    let recommendedTypes = [];  // 推荐项（预置但非必填）
    let defaultCollapsed = false;  // 是否默认收起附件区

    if (category === 'ODS_SYNC') {
        // ODS 同步：附件改为可选，数据质量由验收自动保证
        requiredTypes = [];
        recommendedTypes = ['data_compare'];
        defaultCollapsed = true;
    } else if (category === 'DIM_DEV') {
        // DIM 开发：脚本由平台自动生成，无需手动上传附件
        requiredTypes = [];
        recommendedTypes = [];
        defaultCollapsed = true;
    } else if (category === 'DWD_DEV') {
        // DWD 开发：脚本已在平台编写，附件全部可选
        requiredTypes = [];
        recommendedTypes = ['sql_script', 'validation_report'];
        defaultCollapsed = true;
    } else if (category === 'ADS_RPT') {
        requiredTypes = ['sql_script'];
        recommendedTypes = ['validation_report', 'test_report'];
    } else if (category === 'DATA_FIX') {
        requiredTypes = ['sql_script'];
    } else {
        // 默认
        requiredTypes = ['sql_script'];
        recommendedTypes = ['validation_report'];
    }

    // 设置附件区折叠状态
    if (defaultCollapsed) {
        attachWrap.style.display = 'none';
        toggleHint.textContent = '（可选，点击展开）';
        chevron.style.transform = 'rotate(0deg)';
    } else {
        attachWrap.style.display = 'block';
        toggleHint.textContent = requiredTypes.length > 0 ? '（含必填项）' : '（可选）';
        chevron.style.transform = 'rotate(180deg)';
    }

    // 先添加必填项
    requiredTypes.forEach(type => {
        addAttachmentRow(type, true);
    });
    // 再添加推荐项（预置但可删除）
    recommendedTypes.forEach(type => {
        addAttachmentRow(type, false);
    });

    // 添加一个按钮允许添加其他附件
    const container = document.getElementById('attachmentList');
    const addBtn = document.createElement('div');
    addBtn.innerHTML = `<button type="button" class="btn-claim" style="margin-top:10px;font-size:0.85em;background:#edf2f7;color:#4a5568;" onclick="addAttachmentRow('', false)">+ 添加其它附件</button>`;
    container.appendChild(addBtn);

    document.getElementById('submitModal').style.display = 'flex';
}

// 附件类型配置(与后端保持一致)
// ODS: SQL脚本系统生成，只需数据量对比截图
// DIM: 字段映射可由系统自动生成，改为可选
const ATTACHMENT_TYPES = {
    'data_compare': { name: '数据量对比截图', extensions: '.png,.jpg,.jpeg', required: true, hint: '源表与目标表数据量对比' },
    'field_mapping': { name: '字段映射文档', extensions: '.xlsx,.xls', required: false, hint: '可选，系统可自动生成' },
    'sql_script': { name: 'SQL加工脚本', extensions: '.sql,.txt', required: false, hint: 'ODS/DIM可由系统生成' },
    'validation_report': { name: '数据验证报告', extensions: '.xlsx,.xls,.png,.jpg,.jpeg,.docx,.doc', required: false, hint: '验收通过后可省略' },
    'scd_config': { name: 'SCD配置说明', extensions: '.docx,.doc,.txt,.md', required: false, hint: 'SCD2维度表需提供' },
    'dim_relation': { name: '维度关联说明', extensions: '.docx,.doc,.xlsx,.xls,.txt', required: false, hint: '有层级关系时提供' },
    'sample_data': { name: '示例数据', extensions: '.xlsx,.xls', required: false },
    'test_report': { name: '测试报告', extensions: '.docx,.doc', required: false }
};

let attachmentRowId = 0;

// 添加附件行
function addAttachmentRow(defaultType = '', isRequired = false) {
    attachmentRowId++;
    const id = attachmentRowId;
    const container = document.getElementById('attachmentList');
    const config = ATTACHMENT_TYPES[defaultType || 'sql_script'];

    // 构建提示文本：格式 + hint（如果有）
    let tipText = `支持格式: ${config.extensions.replace(/,/g, ', ')}`;
    if (config.hint) {
        tipText += `\n${config.hint}`;
    }

    const row = document.createElement('div');
    row.className = 'attachment-row';
    row.id = `attachRow_${id}`;
    row.innerHTML = `
        <select class="attach-type" id="attachType_${id}" onchange="updateFileAccept(${id})" ${isRequired ? 'disabled' : ''}>
            ${Object.entries(ATTACHMENT_TYPES).map(([key, val]) =>
        `<option value="${key}" ${key === defaultType ? 'selected' : ''}>${val.name}${val.required ? ' *' : ''}</option>`
    ).join('')}
        </select>
        <div style="position:relative;display:inline-block;margin-right:8px;cursor:help;"
            title="${tipText}">
            <span style="font-size:1.2em;color:#4299e1;" id="attachTip_${id}">&#x24D8;</span>
        </div>
        <input type="file" class="attach-file" id="attachFile_${id}"
            accept="${config.extensions}">
            ${isRequired ? '<span style="color:#e53e3e;font-size:0.8em;">必填</span>' :
            `<button type="button" class="btn-cancel" onclick="removeAttachmentRow(${id})" style="padding:4px 8px;">✕</button>`}
            `;
    container.appendChild(row);
}

// 更新文件accept属性
function updateFileAccept(id) {
    const typeSelect = document.getElementById(`attachType_${id}`);
    const fileInput = document.getElementById(`attachFile_${id}`);
    const tipSpan = document.getElementById(`attachTip_${id}`); // 获取提示图标span

    const config = ATTACHMENT_TYPES[typeSelect.value];
    if (config) {
        fileInput.accept = config.extensions;
        fileInput.value = ''; // 清空已选文件

        // 更新提示（格式 + hint）
        if (tipSpan && tipSpan.parentNode) {
            let tipText = `支持格式: ${config.extensions.replace(/,/g, ', ')}`;
            if (config.hint) {
                tipText += `\n${config.hint}`;
            }
            tipSpan.parentNode.title = tipText;
        }
    }
}

// 移除附件行
function removeAttachmentRow(id) {
    const row = document.getElementById(`attachRow_${id}`);
    if (row) row.remove();
}

// 附件区折叠切换
function toggleAttachmentSection() {
    const wrap = document.getElementById('attachmentListWrap');
    const hint = document.getElementById('attachmentToggleHint');
    const chevron = document.getElementById('attachmentChevron');
    const isHidden = wrap.style.display === 'none';
    wrap.style.display = isHidden ? 'block' : 'none';
    chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    if (isHidden) {
        hint.textContent = '（点击收起）';
    } else {
        const hasRequired = document.querySelectorAll('.attachment-row .attach-type:disabled').length > 0;
        hint.textContent = hasRequired ? '（含必填项）' : '（可选，点击展开）';
    }
}

// 交付物自动检测（提交弹窗用）
async function loadDevStatusForSubmit(modelId, category) {
    const container = document.getElementById('devStatusContent');
    try {
        const res = await fetch(`${API_URL}/models/${modelId}/dev-status`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (!res.ok) throw new Error('接口异常');
        const data = await res.json();
        const d = data.deliverables;

        // 脚本来源由后端 submit2 自动判断，前端无需处理

        // 构建检测项列表
        const items = [];
        const checkIcon = (ok) => ok
            ? '<span style="color:#38a169;font-weight:600;">&#10003;</span>'
            : '<span style="color:#e53e3e;font-weight:600;">&#10007;</span>';
        const optionalIcon = '<span style="color:#d69e2e;font-weight:600;">&#9679;</span>';

        // 字段配置（DIM/DWD）
        if (d.config) {
            items.push({
                icon: checkIcon(d.config.ready),
                label: '字段配置',
                detail: d.config.detail || (d.config.ready ? '已完成' : '未配置')
            });
        }

        // DDL（DIM/DWD 需要，ODS 无需 DDL）
        if (d.ddl && ['DIM_DEV', 'DWD_DEV'].includes(category)) {
            items.push({
                icon: checkIcon(d.ddl.ready),
                label: 'DDL 脚本',
                detail: d.ddl.detail || (d.ddl.ready ? '已生成' : '未生成')
            });
        }

        // ETL（DIM/DWD 需要，ODS 没有 ETL）
        if (d.etl && ['DIM_DEV', 'DWD_DEV'].includes(category)) {
            items.push({
                icon: checkIcon(d.etl.ready),
                label: 'ETL 脚本',
                detail: d.etl.detail || (d.etl.ready ? '已保存' : '未保存')
            });
        }

        // 验收记录（可选）
        items.push({
            icon: d.validation.ready ? checkIcon(true) : optionalIcon,
            label: '验收记录',
            detail: d.validation.ready ? d.validation.detail : '未执行（可选）'
        });

        // 渲染
        const canSubmit = data.canSubmit;
        const borderColor = canSubmit ? '#c6f6d5' : '#fed7d7';
        const bgColor = canSubmit ? '#f0fff4' : '#fff5f5';
        const summaryColor = canSubmit ? '#38a169' : '#e53e3e';
        const summaryText = canSubmit
            ? '交付物就绪，可以提交'
            : '部分交付物缺失（' + (data.missingItems || []).join('、') + '），建议补全后再提交';

        // 配置模式标注（DIM/DWD 显示，ODS 不显示）
        const isDimDwd = ['DIM_DEV', 'DWD_DEV'].includes(category);
        let modeLabelHtml = '';
        let modifiedHint = '';
        if (isDimDwd) {
            const configMode = data.model.config_mode || 'standard';
            const scriptModified = data.model.script_modified;
            let modeLabel;
            if (configMode === 'custom') {
                modeLabel = { text: '自定义脚本模式', desc: '需手工编写并保存 DDL/ETL 脚本', color: '#9f7aea', bg: '#faf5ff', border: '#e9d8fd' };
            } else if (scriptModified) {
                modeLabel = { text: '标准配置模式', desc: '脚本已被手动修改', color: '#d69e2e', bg: '#fffff0', border: '#fefcbf' };
            } else {
                modeLabel = { text: '标准配置模式', desc: '脚本由平台根据字段配置自动生成', color: '#3182ce', bg: '#ebf8ff', border: '#bee3f8' };
            }
            modeLabelHtml = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:${modifiedHint ? '6' : '8'}px;padding:5px 10px;border-radius:6px;background:${modeLabel.bg};border:1px solid ${modeLabel.border};font-size:0.82em;">
                <span style="color:${modeLabel.color};font-weight:600;">${modeLabel.text}</span>
                <span style="color:#718096;">—</span>
                <span style="color:#718096;">${modeLabel.desc}</span>
            </div>`;

            // 脚本修改提示（标准模式 + 已修改时显示详情）
            if (configMode !== 'custom' && scriptModified) {
                const modBy = data.model.script_modified_by ? escapeHtml(data.model.script_modified_by) : '未知';
                const modAt = data.model.script_modified_at || '';
                modifiedHint = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:4px 10px;border-radius:5px;background:#fffff0;border:1px solid #fefcbf;font-size:0.8em;color:#975a16;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d69e2e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    脚本已由 <strong>${modBy}</strong> 手动修改${modAt ? '（' + formatDateTimeUnified(modAt) + '）' : ''}，提交后将标记为"平台生成+手动修改"
                </div>`;
            }
        }

        container.innerHTML = `
            ${modeLabelHtml}
            ${modifiedHint}
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:0.85em;">
                ${items.map(item => `
                    <div style="display:flex;align-items:center;gap:6px;">
                        ${item.icon}
                        <span style="color:#4a5568;">${item.label}</span>
                        <span style="color:#a0aec0;margin-left:auto;font-size:0.9em;">${item.detail}</span>
                    </div>
                `).join('')}
            </div>
            <div style="margin-top:8px;padding:6px 10px;border-radius:6px;background:${bgColor};border:1px solid ${borderColor};font-size:0.82em;color:${summaryColor};font-weight:500;">
                ${summaryText}
            </div>
        `;
    } catch (e) {
        container.innerHTML = `<div style="color:#a0aec0;font-size:0.85em;">交付物检测失败: ${e.message}</div>`;
    }
}

// 多附件提交(新版)
async function confirmSubmit2() {
    const submission = document.getElementById('submitInfo').value;
    const rows = document.querySelectorAll('.attachment-row');

    const formData = new FormData();
    formData.append('id', currentTaskId);
    formData.append('submission', submission);

    const attachmentTypes = [];
    let hasFiles = false;
    let missingRequired = [];

    rows.forEach(row => {
        const typeSelect = row.querySelector('.attach-type');
        const fileInput = row.querySelector('.attach-file');
        const attachType = typeSelect.value;
        const config = ATTACHMENT_TYPES[attachType];
        // 判断是否必填：select 被 disabled 表示是必填项（由 addAttachmentRow 的 isRequired 参数决定）
        const isRowRequired = typeSelect.disabled;

        if (fileInput.files.length > 0) {
            formData.append('files', fileInput.files[0]);
            attachmentTypes.push(attachType);
            hasFiles = true;
        } else if (isRowRequired) {
            // 只有 UI 上标记为必填的才强制要求
            missingRequired.push(config.name);
        }
    });

    // 强制校验：数据表内容描述必填
    if (!submission || !submission.trim()) {
        return alert("请填写数据表内容描述 (必填)");
    }

    if (missingRequired.length > 0) {
        return alert('请上传必填交付物: ' + missingRequired.join(', '));
    }

    // 模型关联校验：开发类任务需要关联模型
    if (currentTaskInfo) {
        const needsModel = ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(currentTaskInfo.category);
        if (needsModel && !currentTaskInfo.linked_model_id) {
            const confirmMsg = `该任务未关联模型，提交后模型状态将无法自动更新。\n\n建议先前往模型中心注册模型并关联到任务。\n\n是否继续提交？`;
            if (!confirm(confirmMsg)) {
                return; // 用户取消提交
            }
        }

        // ODS 任务验收检查：仅在模型已进入待验收/已上线状态时检查
        if (currentTaskInfo.category === 'ODS_SYNC' && currentTaskInfo.linked_model_id) {
            try {
                const modelRes = await fetch(`${API_URL}/models/${currentTaskInfo.linked_model_id}`, {
                    headers: { 'Authorization': `Bearer ${getToken()}` }
                });
                if (modelRes.ok) {
                    const modelData = await modelRes.json();
                    // 首次提交时模型在 DEVELOPING/CREATED，跳过验收检查
                    if (['REVIEWING', 'ONLINE'].includes(modelData.status)) {
                        const statusRes = await fetch(`${API_URL}/models/${currentTaskInfo.linked_model_id}/validation-status`, {
                            headers: { 'Authorization': `Bearer ${getToken()}` }
                        });
                        if (statusRes.ok) {
                            const statusData = await statusRes.json();
                            if (statusData.status !== 'pass') {
                                const confirmMsg = `该模型上次验收未通过，建议先在模型中心重新执行验收。\n\n是否仍要继续提交？`;
                                if (!confirm(confirmMsg)) {
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('验收状态检查失败，继续提交:', e);
            }
        }
    }

    formData.append('attachmentTypes', JSON.stringify(attachmentTypes));

    // 脚本来源：由后端根据 config_mode + script_modified 自动判断

    try {
        const headers = {};
        const token = getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${API_URL}/submit2`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "上传失败");

        closeModal('submitModal');
        loadTasks();
        const attachMsg = attachmentTypes.length > 0 ? `，共上传 ${attachmentTypes.length} 个附件` : '';
        alert('提交成功!' + attachMsg);
    } catch (e) {
        alert("提交失败: " + e.message);
    }
}

// 保留旧版本confirmSubmit以防需要
async function confirmSubmit() { confirmSubmit2(); }

// ==================== 任务转发/分配 ====================

// 加载活跃用户列表
// excludeViewer: 是否排除查看者角色（转发任务时需要排除）
async function loadActiveUsers(selectId, excludeViewer = false) {
    try {
        const res = await authFetch(`${API_URL}/users/active`);
        if (!res) return;
        const users = await res.json();
        const select = document.getElementById(selectId);

        // 过滤用户：排除自己，如果excludeViewer为true则同时排除viewer角色
        const filteredUsers = users.filter(u => {
            if (u.id === currentUser.id) return false;  // 排除自己
            if (excludeViewer && u.role === 'viewer') return false;  // 排除查看者
            return true;
        });

        // 角色显示映射
        const roleLabels = {
            'admin': '管理员',
            'publisher': '发布者',
            'user': '开发者',
            'viewer': '查看者'
        };

        select.innerHTML = '<option value="">-- 请选择 --</option>' +
            filteredUsers.map(u => `<option value="${u.id}">${u.display_name} (${roleLabels[u.role] || u.role})</option>`)
                .join('');
    } catch (e) {
        console.error('加载用户列表失败', e);
    }
}

// 打开转发模态框(普通用户)
function openTransferModal(id, title) {
    currentTaskId = id;
    document.getElementById('transferTaskTitle').innerText = title;
    document.getElementById('transferReason').value = '';
    document.getElementById('transferModal').style.display = 'flex';
    loadActiveUsers('transferTarget', true);  // 排除查看者角色
}

// 确认转发
async function confirmTransfer() {
    const toUserId = document.getElementById('transferTarget').value;
    const reason = document.getElementById('transferReason').value.trim();

    if (!toUserId) return alert('请选择接收人');
    if (!reason) {
        alert('请填写转发原因');
        document.getElementById('transferReason').focus();
        return;
    }

    try {
        const res = await authFetch(`${API_URL}/transfers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: currentTaskId, to_user_id: parseInt(toUserId), reason: reason })
        });

        if (res && res.ok) {
            alert('转发请求已发送！\n\n接收人登录后，待处理的转发请求会显示在页面顶部的"待处理转发"区域。');
            closeModal('transferModal');
            loadTasks();
        } else if (res) {
            const data = await res.json();
            alert(data.error || '转发失败');
        }
    } catch (e) {
        alert('转发失败: ' + e.message);
    }
}

// 打开分配模态框(管理员)
function openAssignModal(id, title) {
    currentTaskId = id;
    document.getElementById('assignTaskTitle').innerText = title;
    document.getElementById('assignModal').style.display = 'flex';
    loadActiveUsers('assignTarget', true);  // 排除查看者角色
}

// 确认分配(管理员强制分配)
async function confirmAssign() {
    const toUserId = document.getElementById('assignTarget').value;
    if (!toUserId) return alert('请选择要分配的用户');

    if (!confirm('确定要将此任务分配给所选用户吗?此操作立即生效。')) return;

    try {
        const res = await authFetch(`${API_URL}/tasks/${currentTaskId}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to_user_id: parseInt(toUserId) })
        });

        if (res && res.ok) {
            const data = await res.json();
            alert(data.message || '分配成功');
            closeModal('assignModal');
            loadTasks();
        } else if (res) {
            const data = await res.json();
            alert(data.error || '分配失败');
        }
    } catch (e) {
        alert('分配失败: ' + e.message);
    }
}

// 撤回转发(根据任务ID查找并取消转发请求)
async function cancelMyTransfer(taskId) {
    if (!confirm('确定要撤回此转发请求吗?')) return;

    try {
        // 先获取我发起的转发请求
        const sentRes = await authFetch(`${API_URL}/transfers/sent`);
        if (!sentRes) return;
        const sentTransfers = await sentRes.json();

        // 找到对应任务的转发请求
        const transfer = sentTransfers.find(t => t.task_id === taskId);
        if (!transfer) {
            alert('未找到转发请求');
            return;
        }

        // 取消转发
        const res = await authFetch(`${API_URL}/transfers/${transfer.id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (res && res.ok) {
            alert('已撤回转发请求');
            loadTasks();
        } else if (res) {
            const data = await res.json();
            alert(data.error || '撤回失败');
        }
    } catch (e) {
        alert('撤回失败: ' + e.message);
    }
}

// 放弃认领任务 - 打开原因输入弹窗
function unclaimTask(id) {
    document.getElementById('unclaimTaskId').value = id;
    document.getElementById('unclaimReason').value = '';
    openModal('unclaimModal');
}

// 确认放弃任务
async function confirmUnclaim() {
    const id = document.getElementById('unclaimTaskId').value;
    const reason = document.getElementById('unclaimReason').value.trim();

    if (!reason) {
        alert('请填写放弃原因');
        document.getElementById('unclaimReason').focus();
        return;
    }

    try {
        await authFetch(`${API_URL}/unclaim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, reason })
        });
        closeModal('unclaimModal');
        loadTasks();
    } catch (e) {
        alert('操作失败: ' + e.message);
    }
}

// 继续开发任务（从待确认状态退回到进行中）
async function withdrawTask(id) {
    if (!confirm("确定要继续开发此任务吗？任务将退回到进行中状态。")) return;

    await authFetch(`${API_URL}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadTasks();
}

// 检查任务是否可以自行归档 (用于ODS任务owner自测通过后的自动归档)
async function checkCanSelfArchive(taskId) {
    try {
        const res = await authFetch(`${API_URL}/tasks/${taskId}/can-self-archive`);
        if (res.ok) {
            return await res.json();
        }
        return { canSelfArchive: false };
    } catch (e) {
        console.error('检查自行归档权限失败:', e);
        return { canSelfArchive: false };
    }
}

// 确认/归档任务 —— 打开验收弹窗
let archiveReviewTaskId = null;
async function confirmTask(id) {
    archiveReviewTaskId = id;
    const task = allTasksCache.find(t => t.id === id);
    const category = task ? task.category : '';

    // 设置弹窗标题
    const titleEl = document.getElementById('archiveTaskTitle');
    if (titleEl) titleEl.innerText = task ? task.title : `任务 #${id}`;

    // 清空验收备注
    const noteEl = document.getElementById('archiveReviewNote');
    if (noteEl) noteEl.value = '';

    // DIM/DWD 任务显示验收勾选项
    const checklistSection = document.getElementById('reviewChecklistSection');
    const checklistItems = document.getElementById('reviewChecklistItems');
    if (checklistSection && checklistItems) {
        if (['DIM_DEV', 'DWD_DEV'].includes(category)) {
            checklistSection.style.display = 'block';
            const items = category === 'DIM_DEV' ? [
                '已确认模型配置正确（主表、关联表、派生字段、SCD 类型）',
                '已预览生成的脚本',
                '已执行脚本并验证无报错',
                '已抽检数据与源表一致（至少 3 条）'
            ] : [
                '已确认 DWD 模型配置正确（源表、字段映射、更新策略）',
                '已预览 DDL 和 ETL 脚本',
                '已执行脚本并验证无报错',
                '已抽检数据准确性'
            ];
            checklistItems.innerHTML = items.map((text, i) =>
                `<label style="display:flex;align-items:flex-start;gap:8px;font-size:0.9em;color:#2d3748;cursor:pointer;margin:0;">
                    <input type="checkbox" class="review-checklist-cb" data-index="${i}" style="margin-top:2px;flex-shrink:0;">
                    <span>${text}</span>
                </label>`
            ).join('');
        } else {
            checklistSection.style.display = 'none';
            checklistItems.innerHTML = '';
        }
    }

    openModal('archiveReviewModal');
}

// 提交归档验收
async function submitArchiveReview() {
    if (!archiveReviewTaskId) return;
    const task = allTasksCache.find(t => t.id === archiveReviewTaskId);
    const category = task ? task.category : '';

    // 验收勾选项校验（DIM/DWD 必须全部勾选）
    let checklistData = null;
    if (['DIM_DEV', 'DWD_DEV'].includes(category)) {
        const cbs = document.querySelectorAll('.review-checklist-cb');
        const items = [];
        let allChecked = true;
        cbs.forEach(cb => {
            const label = cb.parentElement.querySelector('span').textContent;
            items.push({ text: label, checked: cb.checked });
            if (!cb.checked) allChecked = false;
        });
        if (!allChecked) {
            alert('请完成所有验收确认项的勾选');
            return;
        }
        checklistData = JSON.stringify(items);
    }

    const reviewNote = (document.getElementById('archiveReviewNote')?.value || '').trim();

    try {
        const res = await authFetch(`${API_URL}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: archiveReviewTaskId,
                review_note: reviewNote || null,
                review_checklist: checklistData
            })
        });
        if (!res.ok) {
            const err = await res.json();
            alert('归档失败: ' + (err.error || '未知错误'));
            return;
        }
        closeModal('archiveReviewModal');
        loadTasks();
        alert('任务已归档，验收记录已保存');
    } catch (e) {
        alert('归档失败: ' + e.message);
    }
}

// 删除任务
async function deleteTask(id) {
    if (!confirm("危险操作: 确定要永久删除此任务及其附件吗? 此操作不可恢复!")) return;

    await authFetch(`${API_URL}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadTasks();
}

// 退回原因类型映射
const REOPEN_REASON_LABELS = {
    'data_quality': '数据质量问题',
    'schema_change': '字段结构调整',
    'logic_fix': '业务逻辑修正',
    'performance': '性能优化',
    'upstream_change': '上游表变更',
    'rollback': '误操作回退',
    'other': '其他'
};

// 退回任务 - 打开原因选择弹窗
async function reopenTask(id, targetStatus = 'OPEN') {
    const description = targetStatus === 'CLAIMED'
        ? '任务将转回"进行中"状态，保留原认领人，归档文件将被删除。'
        : '任务将转回"任务池"状态，清除认领人信息，归档文件将被删除。';

    document.getElementById('reopenTaskId').value = id;
    document.getElementById('reopenTargetStatus').value = targetStatus;
    document.getElementById('reopenDescription').textContent = description;

    // 清除之前的选择
    const radios = document.querySelectorAll('input[name="reopenReasonType"]');
    radios.forEach(r => {
        r.checked = false;
        r.closest('label').style.borderColor = '#e2e8f0';
    });
    const remarkInput = document.getElementById('reopenRemark');
    if (remarkInput) remarkInput.value = '';

    // 添加选中样式处理
    radios.forEach(radio => {
        radio.onchange = function() {
            radios.forEach(r => r.closest('label').style.borderColor = '#e2e8f0');
            if (this.checked) {
                this.closest('label').style.borderColor = '#f59e0b';
            }
        };
    });

    // 检查下游依赖（仅对 ODS 任务）
    const depsWarning = document.getElementById('reopenDepsWarning');
    if (depsWarning) {
        depsWarning.style.display = 'none';
        depsWarning.innerHTML = '';
    }

    try {
        const depsResp = await authFetch(`${API_URL}/tasks/${id}/downstream-deps`);
        if (depsResp.ok) {
            const depsData = await depsResp.json();
            if (depsData.hasDeps && depsWarning) {
                const archivedWarning = depsData.archivedCount > 0
                    ? `<div style="color:#dc2626; font-weight:600; margin-top:6px;">⚠️ 其中 ${depsData.archivedCount} 个表已有归档任务，退回后可能需要同步更新！</div>`
                    : '';
                depsWarning.innerHTML = `
                    <div style="background:#fef3c7; border:1px solid #f59e0b; border-radius:8px; padding:12px; margin-bottom:12px;">
                        <div style="display:flex; align-items:center; gap:8px; color:#92400e; font-weight:600; margin-bottom:8px;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                            </svg>
                            检测到 ${depsData.totalCount} 个下游依赖表
                        </div>
                        <div style="font-size:0.85em; color:#78350f; max-height:100px; overflow-y:auto;">
                            ${depsData.deps.map(d => `<div style="padding:2px 0;">• ${d.layer}: <code style="background:#fff7ed; padding:1px 4px; border-radius:3px;">${d.table_name}</code> ${d.hasArchivedTask ? '<span style="color:#dc2626; font-size:0.8em;">(已归档)</span>' : ''}</div>`).join('')}
                        </div>
                        ${archivedWarning}
                    </div>
                `;
                depsWarning.style.display = 'block';
            }
        }
    } catch (e) {
        console.warn('Failed to check downstream deps:', e);
    }

    openModal('reopenModal');
}

// 确认退回任务
async function confirmReopen() {
    const id = document.getElementById('reopenTaskId').value;
    const targetStatus = document.getElementById('reopenTargetStatus').value;

    // 获取选中的原因类型
    const selectedReason = document.querySelector('input[name="reopenReasonType"]:checked');
    if (!selectedReason) {
        alert('请选择退回原因');
        return;
    }

    const reasonType = selectedReason.value;
    const reasonLabel = REOPEN_REASON_LABELS[reasonType] || reasonType;
    const remark = document.getElementById('reopenRemark')?.value?.trim() || '';

    // "其他"类型必须填写备注
    if (reasonType === 'other' && !remark) {
        alert('选择"其他"时请在备注中说明具体原因');
        document.getElementById('reopenRemark').focus();
        return;
    }

    // 组合最终原因：类型标签 + 备注
    const reason = remark ? `[${reasonLabel}] ${remark}` : `[${reasonLabel}]`;

    try {
        const response = await authFetch(`${API_URL}/reopen`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, targetStatus, reason, reasonType })
        });

        const result = await response.json();
        if (!response.ok) {
            alert(`操作失败: ${result.error || '未知错误'}`);
            return;
        }

        closeModal('reopenModal');
        loadTasks();
    } catch (error) {
        console.error('Error reopening task:', error);
        alert('操作失败，请稍后重试');
    }
}

// 编辑任务
async function openEditModal(id, title, desc, category) {
    currentTaskId = id;
    document.getElementById('editTitle').value = title;
    document.getElementById('editDesc').value = desc || '';
    document.getElementById('editCategory').value = category || 'DWD_DEV';

    // 加载任务信息以获取模型关联
    const task = allTasksCache.find(t => t.id === id);
    if (task && task.linked_model_id) {
        editSelectedModelId = task.linked_model_id;
        // 加载模型列表并设置当前值
        await loadEditModels();
        const model = allModelsCache.find(m => m.id === task.linked_model_id);
        if (model) {
            document.getElementById('editModelInput').value = model.table_name;
        }
    } else {
        editSelectedModelId = null;
        document.getElementById('editModelInput').value = '';
        await loadEditModels();
    }

    // 更新提示
    updateEditModelLinkTip();

    document.getElementById('editModal').style.display = 'flex';
}

// 加载编辑模态框的模型列表
async function loadEditModels() {
    try {
        const res = await authFetch(`${API_URL}/models`);
        if (res && res.ok) {
            allModelsCache = await res.json();
            const datalist = document.getElementById('editModelList');
            if (datalist) {
                datalist.innerHTML = '';
                const editModels = allModelsCache.filter(m => !m.companion_of);
                // 排序：可用模型置顶，已占用/已归档置后
                const isEditOccupied = m => m.latest_active_task_status || (m.archived_task_count || 0) > 0;
                editModels.sort((a, b) => (isEditOccupied(a) ? 1 : 0) - (isEditOccupied(b) ? 1 : 0));
                editModels.forEach(model => {
                    let statusMark = '';
                    let prefix = isEditOccupied(model) ? '○' : '●';
                    if (model.latest_active_task_status) {
                        const s = model.latest_active_task_status;
                        const o = model.latest_active_task_owner || '';
                        if (s === 'OPEN') statusMark = ' · 已发布待认领';
                        else if (s === 'CLAIMED') statusMark = ` · 开发中(${o})`;
                        else if (s === 'TRANSFERRING') statusMark = ` · 转让中(${o})`;
                        else if (s === 'ON_HOLD') statusMark = ` · 存疑(${o})`;
                        else if (s === 'DONE') statusMark = ' · 待验收';
                    } else if ((model.archived_task_count || 0) > 0) {
                        statusMark = ` · 已归档v${model.archived_task_count}`;
                    }
                    const option = document.createElement('option');
                    option.value = model.table_name;
                    option.textContent = `${prefix} ${model.table_comment || model.table_name} [${model.layer}:${model.table_name}]${statusMark}`;
                    datalist.appendChild(option);
                });
            }
        }
    } catch (e) {
        console.error("加载模型失败", e);
    }
}

// 编辑模态框中的模型输入处理
function onEditModelInput(input) {
    // 可在此处做防抖搜索优化
}

// 编辑模态框中的模型选择处理
function onEditModelSelect(input) {
    const tableName = input.value;
    const model = allModelsCache.find(m => m.table_name === tableName);

    if (model) {
        editSelectedModelId = model.id;
    } else {
        editSelectedModelId = null;
    }

    updateEditModelLinkTip();
}

// 更新编辑模态框的模型关联提示
function updateEditModelLinkTip() {
    const tipEl = document.getElementById('editModelLinkTip');
    if (!tipEl) return;

    const category = document.getElementById('editCategory').value;
    const needsModel = ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(category);
    const hasModel = editSelectedModelId !== null;

    tipEl.style.display = (needsModel && !hasModel) ? 'block' : 'none';
}

async function confirmEdit() {
    const title = document.getElementById('editTitle').value;
    const desc = document.getElementById('editDesc').value;
    const category = document.getElementById('editCategory').value;
    const linked_model_id = editSelectedModelId || null; // 如果没有选择，传null清空关联

    if (!title) return alert("请输入任务标题");

    const res = await authFetch(`${API_URL}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentTaskId, title, desc, category, linked_model_id })
    });

    if (res && res.ok) {
        closeModal('editModal');
        loadTasks();
    } else if (res) {
        const data = await res.json();
        alert(data.error || '更新失败');
    }
}

// 打开模态框
function openModal(id) {
    document.getElementById(id).style.display = 'flex';
}

// 关闭模态框
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
    // 清空输入框
    if (id === 'submitModal') {
        document.getElementById('submitInfo').value = '';
    } else if (id === 'editModal') {
        document.getElementById('editTitle').value = '';
        document.getElementById('editDesc').value = '';
        document.getElementById('editModelInput').value = '';
        editSelectedModelId = null;
    } else if (id === 'importModal') {
        document.getElementById('importFile').value = '';
    }
}

function toggleArchived() {
    const el = document.getElementById('archivedTasks');
    el.style.display = el.style.display === 'none' ? 'grid' : 'none';
}

// ==================== Excel预览功能 ====================

// 预览Excel文件
async function previewExcel(filename, displayName) {
    document.getElementById('excelPreviewTitle').innerHTML = `${SVG_ICONS.barChart} ${displayName}`;
    document.getElementById('excelPreviewBody').innerHTML = '<div style="text-align:center;color:#a0aec0;padding:40px;">加载中...</div>';
    document.getElementById('excelPreviewModal').style.display = 'flex';

    try {
        const res = await fetch(`${API_URL}/preview/excel/${encodeURIComponent(filename)}`);
        const data = await res.json();

        if (data.error) {
            document.getElementById('excelPreviewBody').innerHTML = `<div style="text-align:center;color:#e53e3e;padding:40px;">加载失败: ${data.error}</div>`;
            return;
        }

        // 判断是否为示例数据(行号从0开始)
        const isSample = displayName && displayName.includes('示例数据');
        const startIdx = isSample ? 0 : 1;

        // 生成HTML表格
        let tableHtml = `
            <div style="margin-bottom:15px;">
                <span style="background:#d97706;color:white;padding:4px 12px;border-radius:12px;font-size:0.85em;">
                    ${SVG_ICONS.fileText} 工作表: ${data.sheetName}
                </span>
                <span style="margin-left:15px;color:#718096;font-size:0.9em;">
                    共 ${data.totalRows} 行数据
                </span>
            </div>
            <table class="excel-preview-table">
                <thead>
                    <tr>
                        <th style="width:50px;text-align:center;">#</th>
                        ${data.headers.map(h => `<th>${h || ''}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${data.rows.map((row, index) => `
                                <tr>
                                    <td style="text-align:center;color:#718096;font-weight:bold;">${index + startIdx}</td>
                                    ${data.headers.map((_, i) => `<td>${row[i] !== undefined ? row[i] : ''}</td>`).join('')}
                                </tr>
                            `).join('')}
                </tbody>
            </table>
            `;

        document.getElementById('excelPreviewBody').innerHTML = tableHtml;
    } catch (err) {
        document.getElementById('excelPreviewBody').innerHTML = `<div style="text-align:center;color:#e53e3e;padding:40px;">加载失败: ${err.message}</div>`;
    }
}



// 初始加载
loadTasks();

// ==================== 存疑/阻碍 (Hold) 逻辑 ====================
let currentHoldId = null;

function openHoldModal(id, title) {
    currentHoldId = id;
    document.getElementById('holdTaskTitle').innerText = title;
    document.getElementById('holdReason').value = '';
    document.getElementById('holdModal').style.display = 'flex';
}

async function confirmHold() {
    const reason = document.getElementById('holdReason').value.trim();
    if (!reason) {
        alert('请填写存疑原因');
        return;
    }

    try {
        const res = await authFetch(`${API_URL}/tasks/${currentHoldId}/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });

        if (res.ok) {
            closeModal('holdModal');
            loadTasks();
        } else {
            const data = await res.json();
            alert(data.error || '操作失败');
        }
    } catch (e) {
        console.error('Hold error:', e);
        alert('网络错误');
    }
}

// ==================== 批量导入逻辑 ====================
let importedTasks = [];
let xlsxLoaded = false;
let xlsxLoading = false;

// 延迟加载 xlsx 库
function loadXlsxLibrary() {
    return new Promise((resolve, reject) => {
        if (xlsxLoaded || typeof XLSX !== 'undefined') {
            xlsxLoaded = true;
            resolve();
            return;
        }
        if (xlsxLoading) {
            const checkInterval = setInterval(() => {
                if (xlsxLoaded) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
            return;
        }
        xlsxLoading = true;
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = () => {
            xlsxLoaded = true;
            xlsxLoading = false;
            resolve();
        };
        script.onerror = () => {
            xlsxLoading = false;
            reject(new Error('xlsx 库加载失败'));
        };
        document.head.appendChild(script);
    });
}

async function openImportModal() {
    const btn = event?.target?.closest('button');
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span style="opacity:0.7">加载中...</span>';
    }

    try {
        await loadXlsxLibrary();
        document.getElementById('importFile').value = '';
        document.getElementById('importPreviewArea').style.display = 'none';
        document.getElementById('btnConfirmImport').disabled = true;
        document.getElementById('importModal').style.display = 'flex';
    } catch (err) {
        alert('Excel 处理库加载失败，请刷新页面重试');
        console.error(err);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// 下载模板
async function downloadImportTemplate() {
    try {
        await loadXlsxLibrary();
    } catch (err) {
        alert('Excel 处理库加载失败，请刷新页面重试');
        return;
    }

    // 使用 SheetJS 生成模板
    const headers = ['标题', '类型', '备注(可选)'];
    const data = [
        ['[同步] 合同信息表', 'ODS_SYNC', '数据来源: BMS.t_contract'],
        ['[开发] 合同明细宽表', 'DWD_DEV', ''],
        ['[报表] 销售日报', 'ADS_RPT', '统计每日各区域销售额'],
        ['[运维] 修复用户留存数据', 'DATA_FIX', '']
    ];

    // 创建 workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);

    // 设置列宽
    ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 35 }];

    XLSX.utils.book_append_sheet(wb, ws, "任务导入模板");
    XLSX.writeFile(wb, "任务导入模板.xlsx");
}

async function handleImportFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    // 显示选中的文件名
    const fileNameSpan = document.getElementById('selectedImportFileName');
    if (fileNameSpan) {
        fileNameSpan.textContent = file.name;
    }

    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];

    // 解析 JSON (第一行为 header)
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (jsonData.length < 2) {
        alert("文件内容为空或格式不正确");
        return;
    }

    const headers = jsonData[0];
    // 简单验证表头 (模糊匹配)
    // 预期: 标题, 描述, 类型

    const rows = jsonData.slice(1);
    importedTasks = [];
    let validCount = 0;

    // 映射中文列名到英文 key
    // 假设顺序: 0:title, 1:desc, 2:category
    // 或者根据 header 内容查找索引

    const titleIdx = headers.findIndex(h => h && h.includes('标题'));
    const descIdx = headers.findIndex(h => h && (h.includes('备注') || h.includes('描述')));
    const catIdx = headers.findIndex(h => h && h.includes('类型'));

    // 标题和类型为必填，备注为可选
    if (titleIdx === -1 || catIdx === -1) {
        alert("模板格式错误: 必须包含 '标题' 和 '类型' 列。请下载标准模板。");
        document.getElementById('importFile').value = '';
        return;
    }

    // 预览HTML
    let previewHtml = `<thead><tr><th>状态</th><th>标题</th><th>类型</th><th>备注</th></tr></thead><tbody>`;

    rows.slice(0, 10).forEach((row, index) => { // 仅预览前10行
        const title = row[titleIdx];
        const desc = descIdx !== -1 ? (row[descIdx] || '') : '';  // 备注可选
        let category = row[catIdx];

        // 简单清洗/验证
        let isValid = true;
        let errMsg = [];

        if (!title) { isValid = false; errMsg.push('标题为空'); }
        // 备注为可选，不再校验
        if (!category) { isValid = false; errMsg.push('类型为空'); }

        // 类型映射/标准化
        const catMap = {
            'DWD开发': 'DWD_DEV', 'ODS同步': 'ODS_SYNC', 'ADS报表': 'ADS_RPT', '数据运维': 'DATA_FIX'
        };
        // 如果是英文本身则保留，如果是中文则转换
        if (catMap[category]) category = catMap[category];
        else if (!['DWD_DEV', 'ODS_SYNC', 'ADS_RPT', 'DATA_FIX'].includes(category)) {
            // 允许大小写不敏感
            const upCat = (category || '').toUpperCase();
            if (['DWD_DEV', 'ODS_SYNC', 'ADS_RPT', 'DATA_FIX'].includes(upCat)) {
                category = upCat;
            } else {
                isValid = false;
                errMsg.push('类型无效');
            }
        }

        if (isValid) {
            validCount++;
            importedTasks.push({ title, desc, category });
        }

        const statusHtml = isValid ?
            `<span style="color:#38a169;">✔ 有效</span>` :
            `<span style="color:#e53e3e;">✘ ${errMsg.join(', ')}</span>`;

        previewHtml += `
                <tr style="background:${isValid ? 'white' : '#fff5f5'}">
                    <td>${statusHtml}</td>
                    <td>${title || ''}</td>
                    <td>${category || row[catIdx]}</td>
                    <td>${desc || ''}</td>
                </tr>`;
    });

    previewHtml += `</tbody>`;
    document.getElementById('importPreviewTable').innerHTML = previewHtml;
    document.getElementById('importPreviewArea').style.display = 'block';

    // 更新状态文本
    // 注意: 这里只 parse 了前10行用于显示，但 importedTasks 应该包含所有数据吗？
    // 为了性能，应该处理所有数据供提交

    // 重新全量处理
    importedTasks = [];
    validCount = 0;
    rows.forEach(row => {
        const title = row[titleIdx];
        const desc = row[descIdx];
        let category = row[catIdx];
        let isValid = true;

        if (!title || !desc || !category) isValid = false;

        const catMap = { 'DWD开发': 'DWD_DEV', 'ODS同步': 'ODS_SYNC', 'ADS报表': 'ADS_RPT', '数据运维': 'DATA_FIX' };
        if (catMap[category]) category = catMap[category];
        else {
            const upCat = (category || '').toUpperCase();
            if (['DWD_DEV', 'ODS_SYNC', 'ADS_RPT', 'DATA_FIX'].includes(upCat)) category = upCat;
            else isValid = false;
        }

        if (isValid) {
            importedTasks.push({ title, desc, category });
            validCount++;
        }
    });

    const statusEl = document.getElementById('importStatus');
    if (validCount > 0) {
        statusEl.innerHTML = `共解析 <strong style="color:#2d3748">${rows.length}</strong> 行，有效数据 <strong style="color:#38a169">${validCount}</strong> 条`;
        document.getElementById('btnConfirmImport').disabled = false;
    } else {
        statusEl.innerHTML = `<span style="color:#e53e3e">没有发现有效数据，请检查文件</span>`;
        document.getElementById('btnConfirmImport').disabled = true;
    }
}

async function confirmImport() {
    if (importedTasks.length === 0) return;

    const btn = document.getElementById('btnConfirmImport');
    btn.disabled = true;
    btn.innerText = '导入中...';

    try {
        const res = await authFetch(`${API_URL}/create/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(importedTasks)
        });

        const data = await res.json();
        if (res.ok) {
            alert(data.message);
            closeModal('importModal');
            loadTasks();
            // 重置
            importedTasks = [];
        } else {
            alert('导入失败: ' + (data.error || '未知错误'));
        }
    } catch (e) {
        alert('网络错误');
    } finally {
        btn.disabled = false;
        btn.innerText = '确认导入';
    }
}

async function resolveHold(id) {
    if (!confirm('确定问题已解决吗？任务将恢复为 待认领 (OPEN) 状态。')) return;

    try {
        const res = await authFetch(`${API_URL}/tasks/${id}/resolve`, { method: 'POST' });
        if (res.ok) {
            loadTasks();
        } else {
            alert('操作失败');
        }
    } catch (e) {
        alert('网络错误');
    }
}

// ==================== 编辑任务类型 ====================
let currentEditTaskId = null;

function openEditCategoryModal(taskId, currentCategory) {
    currentEditTaskId = taskId;
    document.getElementById('editTaskId').textContent = taskId;
    document.getElementById('editCategorySelect').value = currentCategory;
    document.getElementById('editCategoryModal').style.display = 'block';
}

async function confirmEditCategory() {
    const newCategory = document.getElementById('editCategorySelect').value;

    if (!newCategory) {
        alert('请选择开发类型');
        return;
    }

    try {
        const res = await authFetch(`${API_URL}/tasks/${currentEditTaskId}/category`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: newCategory })
        });

        if (res.ok) {
            alert('任务类型已更新');
            closeModal('editCategoryModal');
            loadTasks();
        } else {
            const data = await res.json();
            alert(`更新失败: ${data.error || '未知错误'}`);
        }
    } catch (e) {
        alert('网络错误，请稍后重试');
        console.error(e);
    }
}

// ==================== 备注查看/编辑功能 ====================
let currentRemarkTaskId = null;

function openRemarkModal(taskId, taskTitle) {
    currentRemarkTaskId = taskId;
    document.getElementById('remarkTaskId').value = taskId;
    document.getElementById('remarkTaskTitle').textContent = taskTitle;

    // 从缓存中获取任务备注
    const task = allTasksCache.find(t => t.id === taskId);
    document.getElementById('remarkContent').value = task ? (task.desc || '') : '';

    // 根据权限设置编辑状态
    const canEdit = isAdmin() || isPublisher();
    document.getElementById('remarkContent').readOnly = !canEdit;
    document.getElementById('remarkSaveBtn').style.display = canEdit ? 'inline-block' : 'none';

    document.getElementById('remarkModal').style.display = 'flex';
}

async function saveRemark() {
    const taskId = currentRemarkTaskId;
    const desc = document.getElementById('remarkContent').value.trim();

    if (!taskId) return;

    try {
        const res = await authFetch(`${API_URL}/tasks/${taskId}/remark`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ desc })
        });

        if (res.ok) {
            closeModal('remarkModal');
            loadTasks();
        } else {
            const data = await res.json();
            alert(`保存失败: ${data.error || '未知错误'}`);
        }
    } catch (e) {
        alert('网络错误，请稍后重试');
        console.error(e);
    }
}

// ==================== 任务详情抽屉功能 ====================
let currentDrawerTaskId = null;

const DRAWER_STATUS_MAP = {
    'OPEN': { text: '待认领', class: 'badge-open' },
    'CLAIMED': { text: '进行中', class: 'badge-claimed' },
    'ON_HOLD': { text: '存疑', class: 'badge-hold' },
    'DONE': { text: '已提交', class: 'badge-done' },
    'ARCHIVED': { text: '已归档', class: 'badge-archived' },
    'TRANSFERRING': { text: '转发中', class: '' }
};

const DRAWER_CATEGORY_MAP = {
    'ODS_SYNC': { text: 'ODS同步', color: '#3182ce' },
    'DIM_DEV': { text: 'DIM开发', color: '#dd6b20' },  // 橙色，与模型中心DIM层一致
    'DWD_DEV': { text: 'DWD开发', color: '#38a169' },
    'ADS_RPT': { text: 'ADS报表', color: '#805ad5' },
    'DATA_FIX': { text: '数据运维', color: '#718096' }  // 灰色，区分于DIM
};

const DRAWER_PRIORITY_MAP = {
    'P0': { text: 'P0 紧急', color: '#e53e3e' },
    'P1': { text: 'P1 高', color: '#ed8936' },
    'P2': { text: 'P2 中', color: '#3182ce' },
    'P3': { text: 'P3 低', color: '#a0aec0' }
};

function openTaskDetailDrawer(taskId) {
    const task = allTasksCache.find(t => t.id === taskId);
    if (!task) {
        alert('任务不存在');
        return;
    }

    currentDrawerTaskId = taskId;

    // 填充基本信息
    document.getElementById('drawerTaskTitle').textContent = task.title || '任务详情';

    // 状态
    const status = DRAWER_STATUS_MAP[task.status] || { text: task.status, class: '' };
    document.getElementById('drawerStatus').innerHTML = `<span class="status-badge ${status.class}">${status.text}</span>`;

    // 优先级
    const priority = DRAWER_PRIORITY_MAP[task.priority] || { text: task.priority || '-', color: '#a0aec0' };
    document.getElementById('drawerPriority').innerHTML = `<span style="color:${priority.color}; font-weight:600;">${priority.text}</span>`;

    // 类型
    const category = DRAWER_CATEGORY_MAP[task.category] || { text: task.category || '-', color: '#4a5568' };
    document.getElementById('drawerCategory').innerHTML = `<span style="color:${category.color}; font-weight:600;">${category.text}</span>`;

    // 负责人
    document.getElementById('drawerOwner').textContent = task.owner || '未分配';

    // 工时
    document.getElementById('drawerEstHours').textContent = task.estimated_hours ? `${task.estimated_hours}h` : '-';

    // 开发工时（只计算进行中状态的累计时长）
    const devHoursEl = document.getElementById('drawerDevHours');
    if (devHoursEl) {
        const devSeconds = task.dev_hours || 0;
        const estimatedSeconds = (task.estimated_hours || 0) * 3600;
        const isDevOvertime = estimatedSeconds > 0 && devSeconds > estimatedSeconds;
        devHoursEl.innerHTML = devSeconds > 0
            ? `<span style="color:${isDevOvertime ? '#e53e3e' : '#38a169'}; font-weight:600;">${formatDuration(devSeconds)}</span>`
            : '-';
    }

    // 任务周期（从认领到归档的总时长）
    const actualSeconds = task.actual_hours || 0;
    document.getElementById('drawerActualHours').innerHTML = actualSeconds > 0
        ? `<span style="font-weight:600;">${formatDuration(actualSeconds)}</span>`
        : '-';

    // 认领时间
    const claimedAtEl = document.getElementById('drawerClaimedAt');
    if (claimedAtEl) {
        claimedAtEl.textContent = task.claimed_at
            ? formatDateTimeUnified(task.claimed_at)
            : '-';
    }

    // 截止时间（显示完整日期时间）
    document.getElementById('drawerDeadline').textContent = task.deadline
        ? formatDateTimeUnified(task.deadline)
        : '-';

    // 创建时间
    document.getElementById('drawerCreatedAt').textContent = formatDateTimeUnified(task.created_at);

    // 关联模型
    const modelInfo = document.getElementById('drawerModelInfo');
    const modelActionBtn = document.getElementById('drawerModelActionBtn');
    const isModelDeleted = task.linked_model_is_deleted === 1;
    if (task.linked_model_id && task.linked_model_name) {
        // 模型已删除警告
        const deletedWarning = isModelDeleted
            ? `<div style="background:#fed7d7;color:#c53030;padding:6px 10px;border-radius:6px;font-size:0.85em;margin-bottom:8px;display:flex;align-items:center;gap:4px;">
                <span style="font-size:1.1em;">⚠</span> 该模型已被管理员删除
               </div>`
            : '';

        // 来源系统信息 (ODS层模型才有)
        let sourceInfo = '';
        if (task.linked_model_source_system || task.linked_model_source_table) {
            sourceInfo = `
                <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e2e8f0;">
                    <div style="font-size:0.8em; color:#718096; margin-bottom:6px;">数据来源</div>
                    ${task.linked_model_source_system ? `<div style="font-size:0.9em;"><span style="color:#718096;">来源系统:</span> <strong style="color:#2c5282;">${escapeHtml(task.linked_model_source_system)}</strong></div>` : ''}
                    ${task.linked_model_source_table ? `<div style="font-size:0.9em; margin-top:4px;"><span style="color:#718096;">来源表:</span> <code style="background:#edf2f7; padding:2px 6px; border-radius:3px; font-size:0.9em;">${escapeHtml(task.linked_model_source_table)}</code></div>` : ''}
                </div>`;
        }

        // 模型描述
        const modelComment = task.linked_model_comment ? `<div class="model-desc">${escapeHtml(task.linked_model_comment)}</div>` : '';

        modelInfo.innerHTML = `
            ${deletedWarning}
            <div class="model-name" ${isModelDeleted ? 'style="text-decoration:line-through;color:#a0aec0;"' : ''}>${escapeHtml(task.linked_model_name)}</div>
            ${modelComment}
            ${sourceInfo}
            ${isModelDeleted ? '' : `<div class="model-actions">
                <a href="Model_Center.html?search=${encodeURIComponent(task.linked_model_name)}" target="_blank">查看模型详情</a>
            </div>`}`;
        modelActionBtn.style.display = 'none';
    } else {
        modelInfo.innerHTML = `<span style="color:#a0aec0;">未关联模型</span>`;
        // 显示快速注册按钮 (仅任务所有者或管理员/发布者)
        const needsModel = ['DWD_DEV', 'ODS_SYNC', 'ADS_RPT'].includes(task.category);
        const canAddModel = (isOwner(task) || isAdmin() || isPublisher()) && needsModel;
        modelActionBtn.style.display = canAddModel ? 'inline-block' : 'none';
    }

    // 备注
    const remarkDiv = document.getElementById('drawerRemark');
    const remarkEditBtn = document.getElementById('drawerRemarkEditBtn');
    if (task.desc && task.desc.trim()) {
        remarkDiv.textContent = task.desc;
        remarkDiv.style.background = '#fffbeb';
        remarkDiv.style.border = '1px solid #fbbf24';
        remarkDiv.style.color = '#92400e';
    } else {
        remarkDiv.innerHTML = `<span style="color:#a0aec0;">暂无备注</span>`;
        remarkDiv.style.background = '#f7fafc';
        remarkDiv.style.border = '1px solid #e2e8f0';
        remarkDiv.style.color = '#a0aec0';
    }
    remarkEditBtn.style.display = (isAdmin() || isPublisher()) ? 'inline-block' : 'none';

    // 操作记录 (退回/放弃原因) - 从日志表异步加载
    const operationHistorySection = document.getElementById('drawerOperationHistorySection');
    const operationHistoryDiv = document.getElementById('drawerOperationHistory');

    // 异步加载操作日志
    loadTaskOperationLogs(task.id, operationHistorySection, operationHistoryDiv);

    // 开发笔记 (进行中任务显示，所有者可编辑)
    const devNotesSection = document.getElementById('drawerDevNotesSection');
    const devNotesReadonly = document.getElementById('drawerDevNotesReadonly');
    const devNotesEditable = document.getElementById('drawerDevNotesEditable');
    const devNotesInput = document.getElementById('drawerDevNotesInput');

    if (task.status === 'CLAIMED') {
        devNotesSection.style.display = 'block';

        if (isOwner(task)) {
            // 所有者可编辑
            devNotesReadonly.style.display = 'none';
            devNotesEditable.style.display = 'block';
            devNotesInput.value = task.dev_notes || '';
        } else {
            // 非所有者只读
            devNotesEditable.style.display = 'none';
            if (task.dev_notes) {
                devNotesReadonly.style.display = 'block';
                devNotesReadonly.textContent = task.dev_notes;
            } else {
                devNotesReadonly.style.display = 'block';
                devNotesReadonly.innerHTML = '<span style="color:#a0aec0;">暂无笔记</span>';
            }
        }
    } else {
        devNotesSection.style.display = 'none';
    }

    // 提交说明 (已提交/已归档任务显示)
    const submissionSection = document.getElementById('drawerSubmissionSection');
    const submissionDiv = document.getElementById('drawerSubmission');
    if ((task.status === 'DONE' || task.status === 'ARCHIVED') && task.submission) {
        submissionSection.style.display = 'block';
        submissionDiv.textContent = task.submission;
    } else {
        submissionSection.style.display = 'none';
    }

    // 附件/交付物 (已提交/已归档任务显示)
    const attachmentsSection = document.getElementById('drawerAttachmentsSection');
    const attachmentsDiv = document.getElementById('drawerAttachments');
    // 附件统一存储在 uploads 目录（归档时不移动文件）
    const basePath = '/uploads/';

    // attachments 已经是数组，不需要 JSON.parse
    if ((task.status === 'DONE' || task.status === 'ARCHIVED') && task.attachments && task.attachments.length > 0) {
        attachmentsSection.style.display = 'block';

        const typeNames = {
            'field_mapping': '映射文档',
            'sql_script': 'SQL脚本',
            'validation_screenshot': '验证截图',
            'sample_data': '示例数据',
            'test_report': '测试报告'
        };

        attachmentsDiv.innerHTML = task.attachments.map(att => {
            const icon = getFileIcon(att.original_name || att.file_name || '');
            const fileName = att.original_name || att.file_name || '附件';
            const filePath = basePath + (att.file_name || att);
            const typeLabel = typeNames[att.attachment_type] || '附件';
            const isPreviewable = /\.(sql|txt|log|json|md|xml|csv)$/i.test(fileName);
            const previewBtn = isPreviewable
                ? `<button onclick="previewFile('${filePath}', '${escapeHtml(fileName)}')" class="btn-sm btn-primary" style="padding:2px 8px; font-size:0.8em; margin-right:8px;">${SVG_ICONS.eye}预览</button>`
                : '';

            return `<div class="drawer-attachment-item">
                <span>${icon}</span>
                <span style="background:#e2e8f0; padding:2px 6px; border-radius:4px; font-size:0.8em; color:#4a5568;">${typeLabel}</span>
                <div style="flex:1; display:flex; align-items:center; overflow:hidden;">
                    <a href="${filePath}" target="_blank" title="${escapeHtml(fileName)}" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(fileName)}</a>
                </div>
                ${previewBtn}
            </div>`;
        }).join('');
    } else {
        attachmentsSection.style.display = 'none';
    }

    // 验收记录（已归档任务异步加载）
    const reviewSection = document.getElementById('drawerReviewSection');
    const reviewContent = document.getElementById('drawerReviewContent');
    if (reviewSection && reviewContent) {
        if (task.status === 'ARCHIVED') {
            reviewSection.style.display = 'block';
            reviewContent.innerHTML = '<div style="color:#a0aec0; font-size:0.85em;">加载验收记录...</div>';
            loadTaskReviewInfo(task.id, reviewContent);
        } else {
            reviewSection.style.display = 'none';
        }
    }

    // 底部操作按钮
    renderDrawerFooter(task);

    // 显示抽屉
    document.getElementById('taskDetailDrawer').classList.add('open');
    document.body.style.overflow = 'hidden';
}

// 加载并渲染验收记录
async function loadTaskReviewInfo(taskId, container) {
    try {
        const res = await authFetch(`${API_URL}/tasks/${taskId}/review-info`);
        if (!res.ok) {
            container.innerHTML = '<div style="color:#a0aec0; font-size:0.85em;">验收记录加载失败</div>';
            return;
        }
        const data = await res.json();
        if (!data.hasReview) {
            container.innerHTML = '<div style="color:#a0aec0; font-size:0.85em;">无验收记录（旧版归档）</div>';
            return;
        }

        const r = data.review;
        let html = '<div style="display:flex; flex-direction:column; gap:8px;">';

        // 验收人和时间
        html += `<div style="display:flex; gap:16px; font-size:0.9em;">
            <span><strong style="color:#4a5568;">验收人:</strong> ${escapeHtml(r.reviewer_name || '-')}</span>
            <span><strong style="color:#4a5568;">时间:</strong> ${r.review_time ? formatDateTimeUnified(r.review_time) : '-'}</span>
        </div>`;

        // 脚本来源（auto=平台生成 / modified=平台生成后手动修改 / manual=自定义手写）
        if (r.script_source) {
            const sourceMap = {
                auto: { label: '平台自动生成', bg: '#c6f6d5', color: '#276749' },
                modified: { label: '平台生成 + 手动修改', bg: '#fefcbf', color: '#975a16' },
                manual: { label: '自定义手写脚本', bg: '#fed7d7', color: '#9b2c2c' }
            };
            const src = sourceMap[r.script_source] || { label: r.script_source, bg: '#e2e8f0', color: '#4a5568' };
            html += `<div style="font-size:0.9em;"><strong style="color:#4a5568;">脚本来源:</strong> <span style="background:${src.bg}; color:${src.color}; padding:1px 8px; border-radius:4px; font-size:0.88em;">${src.label}</span></div>`;
        }

        // 验收备注
        if (r.review_note) {
            html += `<div style="font-size:0.9em;"><strong style="color:#4a5568;">备注:</strong> ${escapeHtml(r.review_note)}</div>`;
        }

        // 验收勾选项
        if (r.review_checklist && Array.isArray(r.review_checklist)) {
            html += '<div style="font-size:0.85em; margin-top:4px;">';
            r.review_checklist.forEach(item => {
                const icon = item.checked
                    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#38a169" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg>'
                    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
                html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">${icon} <span style="color:#4a5568;">${escapeHtml(item.text)}</span></div>`;
            });
            html += '</div>';
        }

        // 脚本快照提示
        if (data.script_snapshot && data.script_snapshot.scripts) {
            const scriptCount = Object.keys(data.script_snapshot.scripts).length;
            html += `<div style="font-size:0.85em; color:#718096; margin-top:4px; padding:6px 10px; background:#f7fafc; border-radius:6px; border:1px solid #e2e8f0;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#718096" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                已保存 ${scriptCount} 个脚本快照（${data.script_snapshot.collected_at ? new Date(data.script_snapshot.collected_at).toLocaleString('zh-CN') : '-'}）
            </div>`;
        }

        html += '</div>';
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<div style="color:#a0aec0; font-size:0.85em;">验收记录加载失败</div>';
    }
}

function getFileIcon(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (['sql'].includes(ext)) return SVG_ICONS.fileText;
    if (['xlsx', 'xls', 'csv'].includes(ext)) return SVG_ICONS.barChart;
    if (['doc', 'docx'].includes(ext)) return SVG_ICONS.fileText;
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return SVG_ICONS.image;
    if (['pdf'].includes(ext)) return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    if (['zip', 'rar', '7z'].includes(ext)) return SVG_ICONS.package;
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
}

function renderDrawerFooter(task) {
    const footer = document.getElementById('drawerFooter');
    let buttons = [];

    const jsSafeTitle = (task.title || '').replace(/['"\\]/g, ' ').replace(/\n/g, ' ');

    if (task.status === 'OPEN') {
        // 待认领
        buttons.push(`<button class="drawer-btn-primary" onclick="closeTaskDetailDrawer(); openClaimModal(${task.id}, '${jsSafeTitle}')">认领任务</button>`);
        if (isAdmin() || isPublisher()) {
            buttons.push(`<button class="drawer-btn-secondary" onclick="closeTaskDetailDrawer(); openAssignModal(${task.id}, '${jsSafeTitle}')">分配给...</button>`);
        }
    } else if (task.status === 'CLAIMED') {
        // 进行中
        if (isOwner(task)) {
            buttons.push(`<button class="drawer-btn-primary" onclick="closeTaskDetailDrawer(); openSubmitModal(${task.id}, '${jsSafeTitle}', '${task.category || 'DWD_DEV'}')">提交任务</button>`);
            buttons.push(`<button class="drawer-btn-secondary" onclick="closeTaskDetailDrawer(); openTransferModal(${task.id}, '${jsSafeTitle}')">转发</button>`);
            buttons.push(`<button class="drawer-btn-danger" onclick="closeTaskDetailDrawer(); unclaimTask(${task.id})">放弃</button>`);
        }
        if (isAdmin() || isPublisher()) {
            buttons.push(`<button class="drawer-btn-secondary" onclick="closeTaskDetailDrawer(); openEditModal(${task.id}, '${jsSafeTitle}', '', '${task.category || 'DWD_DEV'}')">编辑</button>`);
        }
    } else if (task.status === 'DONE') {
        // 已提交
        if (isAdmin() || isPublisher()) {
            buttons.push(`<button class="drawer-btn-primary" onclick="closeTaskDetailDrawer(); confirmTask(${task.id})">验收通过</button>`);
            buttons.push(`<button class="drawer-btn-danger" onclick="closeTaskDetailDrawer(); reopenTask(${task.id})">打回修改</button>`);
        }
        // owner: ODS可在模型中心自行归档; DIM/DWD需等管理员归档
        if (isOwner(task) && task.linked_model_id) {
            buttons.push(`<button class="drawer-btn-secondary" onclick="window.location.href='Model_Center.html?id=${task.linked_model_id}&validate=1'">去验收</button>`);
        }
    } else if (task.status === 'ARCHIVED') {
        // 已归档 - 增强版：添加重新开放操作
        if (isAdmin() || isPublisher()) {
            // 如果有owner，可以转回进行中；否则只能转回任务池
            if (task.owner) {
                buttons.push(`<button class="drawer-btn-secondary" onclick="closeTaskDetailDrawer(); reopenTask(${task.id}, 'CLAIMED')" title="转回进行中（保留认领人）">${SVG_ICONS.refresh}转进行中</button>`);
            }
            buttons.push(`<button class="drawer-btn-secondary" onclick="closeTaskDetailDrawer(); reopenTask(${task.id}, 'OPEN')" title="转回任务池（清除认领人）">${SVG_ICONS.clipboard}转任务池</button>`);
            buttons.push(`<button class="drawer-btn-danger" onclick="closeTaskDetailDrawer(); deleteTask(${task.id})">删除</button>`);
        }
    } else if (task.status === 'ON_HOLD') {
        // 存疑/阻碍 - 添加解决按钮
        if (!isViewer()) {
            buttons.push(`<button class="drawer-btn-primary" onclick="closeTaskDetailDrawer(); resolveHold(${task.id})">${SVG_ICONS.check}解决/恢复</button>`);
        }
        if (isAdmin()) {
            buttons.push(`<button class="drawer-btn-danger" onclick="closeTaskDetailDrawer(); deleteTask(${task.id})">删除</button>`);
        }
    } else if (task.status === 'TRANSFERRING') {
        // 转发中
        if (isOwner(task)) {
            buttons.push(`<button class="drawer-btn-danger" onclick="closeTaskDetailDrawer(); cancelMyTransfer(${task.id})">${SVG_ICONS.x}撤回转发</button>`);
        }
    }

    footer.innerHTML = buttons.length > 0 ? buttons.join('') : '<span style="color:#a0aec0; font-size:0.9em;">无可用操作</span>';
}

// 异步加载任务操作日志
async function loadTaskOperationLogs(taskId, sectionEl, contentEl) {
    try {
        const response = await authFetch(`${API_URL}/tasks/${taskId}/operation-logs`);
        if (!response.ok) {
            sectionEl.style.display = 'none';
            return;
        }

        const logs = await response.json();

        if (logs && logs.length > 0) {
            sectionEl.style.display = 'block';

            // 操作类型映射
            const operationTypeMap = {
                'PUBLISH': '发布任务',
                'CLAIM': '领取任务',
                'ASSIGN': '分配任务',
                'UNCLAIM': '放弃任务',
                'SUBMIT': '提交任务',
                'ARCHIVE': '验收归档',
                'REOPEN': '退回任务',
                'TRANSFER': '转发任务',
                'TRANSFER_ACCEPT': '接受转发',
                'TRANSFER_REJECT': '拒绝转发',
                'TRANSFER_CANCEL': '取消转发',
                'HOLD': '标记存疑',
                'RESOLVE': '解除存疑'
            };

            contentEl.innerHTML = logs.map(log => {
                // 格式化时间
                const timeStr = log.created_at ? formatDateTimeUnified(log.created_at, 'short') : '-';
                // 操作类型
                const opType = operationTypeMap[log.operation_type] || log.operation_type;
                // 操作人
                const operator = log.operator || '系统';
                // 备注（领取任务、发布任务、验收归档不显示）
                const showReason = !['CLAIM', 'PUBLISH', 'ARCHIVE'].includes(log.operation_type);
                const reason = showReason && log.reason ? log.reason : '';

                return `<div class="operation-timeline-item">
                    <div class="op-line-time">${timeStr}</div>
                    <div class="op-line-content">
                        <span class="op-tag op-tag-${log.operation_type}">${opType}</span>
                        <span class="op-operator">${escapeHtml(operator)}</span>
                        ${reason ? `<span class="op-reason">${escapeHtml(reason)}</span>` : ''}
                    </div>
                </div>`;
            }).join('');
        } else {
            sectionEl.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to load operation logs:', e);
        sectionEl.style.display = 'none';
    }
}

function closeTaskDetailDrawer() {
    document.getElementById('taskDetailDrawer').classList.remove('open');
    document.body.style.overflow = '';
    currentDrawerTaskId = null;
}

function editDrawerRemark() {
    // 先保存任务ID和任务信息，因为 closeTaskDetailDrawer 会清空 currentDrawerTaskId
    const taskId = currentDrawerTaskId;
    if (!taskId) return;

    const task = allTasksCache.find(t => t.id === taskId);
    if (task) {
        closeTaskDetailDrawer();
        openRemarkModal(taskId, task.title || '');
    }
}

// ==================== 快速注册模型功能 ====================
function openQuickModelRegister() {
    if (!currentDrawerTaskId) return;

    const task = allTasksCache.find(t => t.id === currentDrawerTaskId);
    if (!task) return;

    document.getElementById('quickModelTaskId').value = currentDrawerTaskId;

    // 根据任务类型预设分层
    let defaultLayer = 'DWD';
    if (task.category === 'ODS_SYNC') defaultLayer = 'ODS';
    else if (task.category === 'ADS_RPT') defaultLayer = 'ADS';

    document.getElementById('quickModelLayer').value = defaultLayer;
    document.getElementById('quickModelCycle').value = 'di';
    document.getElementById('quickModelName').value = '';
    document.getElementById('quickModelComment').value = '';

    updateQuickModelPreview();

    closeTaskDetailDrawer();
    document.getElementById('quickModelModal').style.display = 'flex';
}

function updateQuickModelPreview() {
    const layer = document.getElementById('quickModelLayer').value.toLowerCase();
    const name = document.getElementById('quickModelName').value.trim() || 'xxx';
    const cycle = document.getElementById('quickModelCycle').value;

    const tableName = `${layer}_${name}_${cycle}`;
    document.getElementById('quickModelPreview').textContent = tableName;
}

async function confirmQuickModelRegister() {
    const taskId = document.getElementById('quickModelTaskId').value;
    const layer = document.getElementById('quickModelLayer').value;
    const name = document.getElementById('quickModelName').value.trim();
    const comment = document.getElementById('quickModelComment').value.trim();
    const cycle = document.getElementById('quickModelCycle').value;

    if (!name) {
        alert('请输入业务对象名');
        return;
    }
    if (!comment) {
        alert('请输入中文描述');
        return;
    }

    const tableName = `${layer.toLowerCase()}_${name}_${cycle}`;

    // 检查表名是否已存在
    try {
        const checkRes = await authFetch(`${API_URL}/models/check?name=${encodeURIComponent(tableName)}`);
        if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.exists) {
                alert(`表名 "${tableName}" 已存在，请修改业务对象名`);
                return;
            }
        }
    } catch (e) {
        console.error('检查表名失败', e);
    }

    // 注册模型
    try {
        const registerRes = await authFetch(`${API_URL}/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                table_name: tableName,
                table_comment: comment,
                layer: layer,
                update_cycle: cycle,
                status: 'DEVELOPING',
                tech_owner: currentUser ? currentUser.display_name : '',
                biz_owner: ''
            })
        });

        if (!registerRes.ok) {
            const errData = await registerRes.json();
            alert(`注册模型失败: ${errData.error || '未知错误'}`);
            return;
        }

        const newModel = await registerRes.json();
        const modelId = newModel.id;

        // 关联到任务
        const task = allTasksCache.find(t => t.id == taskId);
        if (task) {
            const updateRes = await authFetch(`${API_URL}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: taskId,
                    title: task.title,
                    desc: task.desc || '',
                    category: task.category,
                    priority: task.priority,
                    estimated_hours: task.estimated_hours,
                    deadline: task.deadline,
                    linked_model_id: modelId
                })
            });

            if (updateRes.ok) {
                alert(`模型 "${tableName}" 注册成功并已关联到任务！`);
                closeModal('quickModelModal');
                loadTasks();
            } else {
                alert(`模型已注册，但关联任务失败，请手动关联`);
                closeModal('quickModelModal');
                loadTasks();
            }
        }
    } catch (e) {
        alert('网络错误，请稍后重试');
        console.error(e);
    }
}

// ESC 键关闭抽屉
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        const drawer = document.getElementById('taskDetailDrawer');
        if (drawer && drawer.classList.contains('open')) {
            closeTaskDetailDrawer();
        }
    }
});


// ==================== 文件预览功能 ====================
async function previewFile(url, fileName) {
    const modal = document.getElementById('filePreviewModal');
    const titleEl = document.getElementById('previewFileName');
    const contentEl = document.getElementById('previewContent');

    if (!modal || !contentEl) {
        console.error('Preview modal not found');
        return;
    }

    titleEl.textContent = fileName || '文件预览';
    contentEl.textContent = '加载中...';
    modal.style.display = 'flex'; // 使用 flex 布局居中

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const buffer = await res.arrayBuffer();
        let text;

        // 尝试使用 UTF-8 解码
        try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            text = decoder.decode(buffer);
        } catch (e) {
            // 如果 UTF-8 解码失败，尝试 GBK
            console.warn('UTF-8 decode failed, trying GBK...', e);
            const decoder = new TextDecoder('gbk');
            text = decoder.decode(buffer);
        }

        contentEl.textContent = text;
    } catch (e) {
        console.error('Failed to load file:', e);
        contentEl.textContent = `加载失败: ${e.message}`;
    }
}

// ==================== 管理员悬浮待办面板 ====================

const PRIORITY_COLORS = { P0: '#e53e3e', P1: '#dd6b20', P2: '#3182ce', P3: '#a0aec0' };

function initAdminTodoPanel() {
    if (!isAdmin()) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'adminTodoWrapper';
    wrapper.innerHTML = `
        <button class="admin-todo-fab" id="adminTodoFab" onclick="toggleAdminTodoPanel()" title="管理员待办">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span class="admin-todo-badge" id="adminTodoBadge" style="display:none;">0</span>
        </button>
        <div class="admin-todo-panel" id="adminTodoPanel" style="display:none;">
            <div class="admin-todo-header">
                <span>待办事项</span>
                <button class="admin-todo-close" onclick="toggleAdminTodoPanel()">&times;</button>
            </div>
            <div class="admin-todo-input-row">
                <input type="text" id="adminTodoInput" class="admin-todo-input" placeholder="输入待办，如 P0 合同域收尾" onkeydown="if(event.key==='Enter')addAdminTodo()">
                <button class="admin-todo-add-btn" onclick="addAdminTodo()">+</button>
            </div>
            <div class="admin-todo-list" id="adminTodoList"></div>
        </div>
    `;
    document.body.appendChild(wrapper);

    // 恢复面板展开状态
    if (localStorage.getItem('adminTodoPanelOpen') === '1') {
        document.getElementById('adminTodoPanel').style.display = 'flex';
        document.getElementById('adminTodoFab').classList.add('active');
    }
    loadAdminTodos();
}

async function loadAdminTodos() {
    if (!isAdmin()) return;
    try {
        const res = await fetch(`${API_URL}/admin/todos`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
        if (!res.ok) return;
        const todos = await res.json();
        renderAdminTodos(todos);
    } catch (e) {
        console.warn('Failed to load admin todos:', e);
    }
}

function renderAdminTodos(todos) {
    const list = document.getElementById('adminTodoList');
    if (!list) return;

    const active = todos.filter(t => t.status !== 'done');
    const done = todos.filter(t => t.status === 'done');

    // 更新 badge
    const badge = document.getElementById('adminTodoBadge');
    if (badge) {
        badge.textContent = active.length;
        badge.style.display = active.length > 0 ? 'flex' : 'none';
    }

    let html = '';
    if (active.length === 0 && done.length === 0) {
        html = '<div class="admin-todo-empty">暂无待办</div>';
    }

    active.forEach(t => {
        const color = PRIORITY_COLORS[t.priority] || PRIORITY_COLORS.P1;
        html += `<div class="admin-todo-item" data-id="${t.id}">
            <span class="admin-todo-dot" style="background:${color};" title="${t.priority}"></span>
            <span class="admin-todo-title">${escapeHtml(t.title)}</span>
            <span class="admin-todo-actions">
                <button class="admin-todo-btn done" onclick="toggleAdminTodo(${t.id},'done')" title="完成">&#10003;</button>
                <button class="admin-todo-btn del" onclick="deleteAdminTodo(${t.id})" title="删除">&times;</button>
            </span>
        </div>`;
    });

    if (done.length > 0) {
        html += `<div class="admin-todo-done-section">
            <div class="admin-todo-done-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span>已完成 (${done.length})</span>
                <span class="admin-todo-chevron">&#9656;</span>
            </div>
            <div class="admin-todo-done-list">`;
        done.forEach(t => {
            html += `<div class="admin-todo-item done" data-id="${t.id}">
                <span class="admin-todo-dot" style="background:#a0aec0;"></span>
                <span class="admin-todo-title">${escapeHtml(t.title)}</span>
                <span class="admin-todo-actions">
                    <button class="admin-todo-btn undo" onclick="toggleAdminTodo(${t.id},'pending')" title="恢复">&#8634;</button>
                    <button class="admin-todo-btn del" onclick="deleteAdminTodo(${t.id})" title="删除">&times;</button>
                </span>
            </div>`;
        });
        html += '</div></div>';
    }

    list.innerHTML = html;
}

async function addAdminTodo() {
    const input = document.getElementById('adminTodoInput');
    if (!input) return;
    let text = input.value.trim();
    if (!text) return;

    // 解析优先级：P0-P3 开头自动提取
    let priority = 'P1';
    const m = text.match(/^(P[0-3])\s+/i);
    if (m) {
        priority = m[1].toUpperCase();
        text = text.slice(m[0].length);
    }

    try {
        const res = await fetch(`${API_URL}/admin/todos`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: text, priority })
        });
        if (res.ok) {
            input.value = '';
            loadAdminTodos();
        }
    } catch (e) {
        console.warn('Failed to add admin todo:', e);
    }
}

async function toggleAdminTodo(id, newStatus) {
    try {
        await fetch(`${API_URL}/admin/todos/${id}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        loadAdminTodos();
    } catch (e) {
        console.warn('Failed to update admin todo:', e);
    }
}

async function deleteAdminTodo(id) {
    try {
        await fetch(`${API_URL}/admin/todos/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        loadAdminTodos();
    } catch (e) {
        console.warn('Failed to delete admin todo:', e);
    }
}

function toggleAdminTodoPanel() {
    const panel = document.getElementById('adminTodoPanel');
    const fab = document.getElementById('adminTodoFab');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    fab.classList.toggle('active', !isOpen);
    localStorage.setItem('adminTodoPanelOpen', isOpen ? '0' : '1');
    if (!isOpen) {
        // 聚焦到输入框
        setTimeout(() => document.getElementById('adminTodoInput')?.focus(), 100);
    }
}

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

