/**
 * _sys-head-menu-helper.js
 *
 * 系统迭代页头部「⚙️ 管理」下拉菜单共用 Playwright 测试 helper（2026-08-02 用户裁定二：筛选栏右侧
 * 五个入口——上线单管理/值班排班/上线日志/删除审计/流程说明——从平铺按钮收进下拉菜单，不再是筛选栏
 * 平铺按钮；「+ 新建迭代单」仍是独立主按钮，不受影响，不需要经这个 helper）。
 *
 * 供所有需要点击这五个入口、或断言其可见性的 Playwright 套件共用（如
 * test-sys-release-c7-playwright.js），避免每个文件各自复制粘贴"开菜单"逻辑。前缀 `_` 表示这是内部
 * 共用模块，非独立可执行的测试入口。
 * [LOW-4 同步修正·2026-08-07] test-sys-release-panel-c2b2-playwright.js 已随 C6 收口整体重写，改为
 * 统一走 `?release=`/`?issue=` 深链直达目标页（不再走「⚙️ 管理」下拉菜单导航），不再引入/消费本
 * helper——上一句原列举的两个消费方已减至一个，如实同步。
 *
 * 用法：
 *   const { openSysHeadMenu, clickSysHeadMenuItem, sysHeadMenuItemLocator } = require('./_sys-head-menu-helper');
 *   await clickSysHeadMenuItem(page, '上线单管理');                                  // 开菜单+点击，一步到位
 *   await openSysHeadMenu(page);                                                     // 只开菜单，供后续多次断言
 *   const cnt = await sysHeadMenuItemLocator(page, '值班排班').count();               // 菜单项可见性断言（须先开菜单）
 */
'use strict';

const TRIGGER_SELECTOR = '.u-head-menu-trigger';
const MENU_SELECTOR = '.u-head-menu-list';

// 打开「⚙️ 管理」下拉（若已经开着则幂等跳过，若触发按钮当前角色下未渲染——即五个入口全不可见——
// 则安静跳过，调用方后续对 sysHeadMenuItemLocator 的 count() 断言会正确得到 0）。
async function openSysHeadMenu(page) {
    const menu = page.locator(MENU_SELECTOR);
    if (await menu.isVisible().catch(() => false)) return;   // 已开着，幂等
    const trigger = page.locator(TRIGGER_SELECTOR);
    if ((await trigger.count()) === 0) return;   // 该角色下拉本体未渲染（五个入口全不可见），无菜单可开
    await trigger.click();
    await menu.waitFor({ state: 'visible', timeout: 5000 });
}

// 点击下拉里的某个菜单项——自动先开菜单；菜单项自身点击后会由页面 JS 自动收起下拉，调用方不需要
// 额外收尾。⚠️ 文本为 has-text **子串匹配**（codex 232 L 采纳更正原「精确匹配」误述）：当前五项
// 文案无包含关系故安全；未来新增含包含关系文案（如「上线日志」vs「上线日志归档」）须改精确定位。
// 正例路径诊断力（codex 232 L 采纳）：trigger 未渲染时抛明确错误而非静默后让 click 超时——
// 正例点击的失败应指向「当前角色/状态下下拉本体未渲染」；负例断言请用 sysHeadMenuItemLocator。
async function clickSysHeadMenuItem(page, text) {
    const trigger = page.locator(TRIGGER_SELECTOR);
    if ((await trigger.count()) === 0) {
        throw new Error(`clickSysHeadMenuItem("${text}")：「⚙️ 管理」触发按钮未渲染——当前角色/状态下五个入口全不可见，正例点击无从谈起（负例断言请改用 sysHeadMenuItemLocator）`);
    }
    await openSysHeadMenu(page);
    await page.locator(`${MENU_SELECTOR} button:has-text("${text}")`).click();
}

// 菜单项可见性断言用 locator——调用方须自行先 await openSysHeadMenu(page) 再用它做 count()/isVisible()
// 判断（正例：开菜单后 count()>0；反例：即便菜单没能打开——因下拉本体压根没渲染——底下这个 locator
// 在真实 DOM 里也确实不存在，count() 仍如实是 0，负例断言不依赖菜单是否成功打开）。
function sysHeadMenuItemLocator(page, text) {
    return page.locator(`${MENU_SELECTOR} button:has-text("${text}")`);
}

module.exports = { openSysHeadMenu, clickSysHeadMenuItem, sysHeadMenuItemLocator, TRIGGER_SELECTOR, MENU_SELECTOR };
