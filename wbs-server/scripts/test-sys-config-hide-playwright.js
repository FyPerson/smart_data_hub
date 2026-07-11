'use strict';
/**
 * 系统迭代 建单弹窗 config-hide Playwright 验证（§211 收尾）
 *   needs_feasibility 勾选框仅 feature/improvement 显示；bug/config 隐藏 + 隐藏时清勾（防 stale 勾选提交致 400 FEASIBILITY_NOT_APPLICABLE）。
 *   用法：先起本地 server（localhost:3000），再 node scripts/test-sys-config-hide-playwright.js
 *   纯前端显隐验证，不建单、不触发任何后端写/钉钉副作用。
 */
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const WBS = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(WBS, '.env') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(WBS, 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1;

function signAs(userId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId], (err, row) => {
      db.close();
      if (err) return reject(err);
      if (!row) return reject(new Error(`user id=${userId} not found`));
      resolve(jwt.sign({ id: row.id, username: row.username, display_name: row.display_name, role: row.role }, JWT_SECRET, { expiresIn: '1h' }));
    });
  });
}

let assertCount = 0, failCount = 0;
function expect(cond, msg) { assertCount++; if (!cond) { failCount++; console.log(`  ❌ #${assertCount}: ${msg}`); } else console.log(`  ✓ ${msg}`); }

(async () => {
  console.log('=== 系统迭代 建单弹窗 config-hide 验证 ===\n');
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  try {
    const token = await signAs(ADMIN_ID);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') { consoleErrors.push(m.text()); } });
    page.on('pageerror', e => { consoleErrors.push(e.message); });

    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    expect(page.url().includes('Sys_Iteration.html'), 'admin 打开系统迭代页（未被鉴权重定向）');

    await page.click('button:has-text("新建迭代单")');
    await page.waitForSelector('#f_type', { state: 'visible', timeout: 3000 });
    expect(true, '建单弹窗已打开（#f_type 可见）');

    const opts = await page.evaluate(() => Array.from(document.getElementById('f_type').options).map(o => o.value));
    console.log(`  可选 type: [${opts.join(', ')}]\n`);

    async function stateForType(t) {
      return await page.evaluate((ty) => {
        const sel = document.getElementById('f_type');
        sel.value = ty; sel.dispatchEvent(new Event('change'));
        const chk = document.getElementById('f_needs_feasibility');
        const wrap = chk ? chk.closest('.u-form-group') : null;
        return { present: !!chk, display: wrap ? getComputedStyle(wrap).display : 'MISSING', checked: chk ? chk.checked : null };
      }, t);
    }

    for (const t of opts) {
      const st = await stateForType(t);
      expect(st.present, `type=${t}: 勾选框存在于 DOM`);
      const shouldShow = ['feature', 'improvement'].includes(t);
      if (shouldShow) expect(st.display !== 'none', `type=${t}（变更类）: 勾选框显示 (display=${st.display})`);
      else expect(st.display === 'none', `type=${t}（非变更类）: 勾选框隐藏 (display=${st.display})`);
    }

    // stale-clear：勾选 feature 后切非变更类 → 隐藏 + 清勾（防 stale 勾选提交致 400）
    const nonVariant = opts.find(t => !['feature', 'improvement'].includes(t));
    if (nonVariant) {
      await page.evaluate(() => { const s = document.getElementById('f_type'); s.value = 'feature'; s.dispatchEvent(new Event('change')); document.getElementById('f_needs_feasibility').checked = true; });
      const before = await page.evaluate(() => document.getElementById('f_needs_feasibility').checked);
      expect(before === true, 'stale-clear 前置：feature 下勾选 needs_feasibility 成功');
      const after = await stateForType(nonVariant);
      expect(after.display === 'none', `stale-clear：切到 ${nonVariant} → 勾选框隐藏`);
      expect(after.checked === false, `stale-clear：切换后 needs_feasibility 已清勾（防 400 FEASIBILITY_NOT_APPLICABLE）`);
    } else {
      console.log('  (无非变更类 type 可选，跳过 stale-clear)');
    }

    expect(consoleErrors.length === 0, `0 console error${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
    await ctx.close();
  } catch (e) {
    console.error('测试异常:', e && e.stack || e); failCount++;
  } finally {
    await browser.close();
  }
  console.log(`\n===== ${assertCount - failCount}/${assertCount} 通过, ${failCount} 失败 =====`);
  process.exit(failCount ? 1 : 0);
})();
