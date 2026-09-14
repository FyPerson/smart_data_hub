/**
 * 数据协作·「数据模板」多文件**展示**回归（#68）
 *
 * 用法：node scripts/test-collab-template-display-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * ── 为什么单独立这个套件 ────────────────────────────────────────────────
 * #68 把数据模板 `example_xlsx` 从单文件放开到「单据 active 总数 ≤ 5」，写端（`<input multiple>`
 * + 后端循环入库 + `attachment_seq` 递增 + 追加语义无 supersede）就此变成多文件。
 * 详情页原本是 `.filter(...)[0]` —— **只渲染首个**，注释还写着「admin 创建时前端仅允许单文件上传」。
 * 若只放开写端不改读端，等于把 v1.174.0 刚在 data_scope 上修好的「写端存 N 个、读端只显示 1 个」
 * 原样复刻到模板上（生产 #53 就是那个形态：库里 2 条 active，开发人员只看得到 1 条）。
 *
 * 既有 `test-collab-multifile-m3-playwright.js` 自述「纯客户端」，全部停在**选择/预览层**
 * （input.files 去重、超量截断、扩展名过滤），没有一条走到"落库 → 详情页"；
 * `test-collab-template-e2e.js` 则停在**接口层**（响应体行数），也不看页面渲染。
 * 两层都绿仍可能漏渲染 —— 典型的「层内全绿 ≠ 功能可用」。
 * 本套件补的正是那一段：**写端存了 N 个，读端就必须显示 N 个**。
 *
 * 血缘：结构照抄同批的 `test-collab-data-scope-display-playwright.js`（v1.174.0 为 data_scope
 *   建的同款套件），断言对象换成 `example_xlsx` + 详情页「数据模板」kv 格。
 *
 * 覆盖：
 *   T1 两个 example_xlsx → 两个文件名都出现 + 「共 2 个文件」计数 + 逐项 href 对应
 *   T2 排序：**夹具刻意让接口逆序返回**（大 id 的 created_at 更晚 → ORDER BY created_at DESC 先返回），
 *      页面仍须按 id 升序展示 —— 这样删掉前端 sort 本条就会红（否则是偶然通过·codex 审 M-2）
 *   T3 混合夹具：合法 active + 非法路径 active + 非 active + 其他类型（data_scope）+ status 为 NULL 的历史行
 *      → 只展示应展示的，非法项出警告且**不带链接**，计数只数展示项（codex 审 M-3）
 *   T4 文件名含单引号/双引号/尖括号 → 属性边界不被突破、不产生额外元素（codex 审 M-1）
 *   T5 单个 example_xlsx → 正常显示且**不出现**计数提示（避免给绝大多数单据添噪声）
 *   T6 零个 example_xlsx → 显示占位「—」
 *   + 每个页面都注册 console error 监听（codex 审 L-1）
 *
 * 夹具真实性：单据走 `createPendingFixture()` 真实建单 API；附件按既有 e2e 范式直接 INSERT，
 *   形态（同单多条 active example_xlsx、attachment_seq 递增、无 supersede）与 #68 放开后的
 *   真实写端逐项一致。
 * ⚠️ 覆盖边界（如实声明·codex 120-A M-3 要求收敛）：本套件断言的对象是 **DOM**——文本内容与
 *   链接节点，因此它证明的是「每条应展示的记录都生成了对应 DOM 元素且属性正确」。它**不证明**：
 *   ① 下载真的可用（直插附件记录不创建实体文件，实体缺失/路径非法不在射程内）；
 *   ② 用户肉眼一定看得全（元素若被祖先容器裁剪，读 textContent 仍会通过）。
 *   关于②已单独用样式面核实：`.detail-kv` 是 `display:grid` + `grid-template-columns:110px 1fr`，
 *   行高随内容自增，`.detail-kv-value` 无 height/overflow 限制且 `word-break:break-all`，
 *   多个块级子项会自然撑开而非被裁；同一结构自 v1.174.0 起已承载 data_scope 多文件并在生产验证。
 *   故本轮不另加布局用例——但这个结论来自**样式审查**，不来自本套件的断言，两者不可混为一谈。
 *   ③ 也**不覆盖**上传侧的总数上限（那在 `test-collab-template-e2e.js` T5）。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

let pass = 0, fail = 0;
const cleanupFailures = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; }
    return cond;
}

function dbRun(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); });
    });
}

/**
 * @param opts.fileName  指定落库 file_name（用于构造非法路径）
 * @param opts.status    'active' / 'superseded' / null（历史缺省态）
 * @param opts.type      attachment_type，默认 example_xlsx
 * @param opts.createdAt 指定 created_at —— T2 靠它让接口逆序返回
 */
async function insertAttachment(collabId, originalName, seq, opts = {}) {
    const type = opts.type || 'example_xlsx';
    const fileName = opts.fileName !== undefined
        ? opts.fileName
        : `collab/test/tpl-display-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.xlsx`;
    const status = opts.status === undefined ? 'active' : opts.status;
    const createdAt = opts.createdAt || null;
    const r = await dbRun(
        `INSERT INTO collab_attachments
           (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name,
            status, submission_version, attachment_seq${createdAt ? ', created_at' : ''})
         VALUES (?, ?, ?, ?, 1, '管理员', ?, 0, ?${createdAt ? ', ?' : ''})`,
        createdAt
            ? [collabId, type, fileName, originalName, status, seq, createdAt]
            : [collabId, type, fileName, originalName, status, seq]
    );
    return r.lastID;
}

// 读「数据模板」那一格（kv 结构：label 的下一个 sibling 是 value）
async function readTemplateCell(page) {
    return await page.evaluate(() => {
        const labels = [...document.querySelectorAll('.detail-kv-label')];
        const lab = labels.find(l => (l.textContent || '').trim() === '数据模板');
        if (!lab) return null;
        const val = lab.nextElementSibling;
        if (!val) return null;
        return {
            text: (val.textContent || '').trim(),
            html: val.innerHTML,
            links: [...val.querySelectorAll('a')].map(a => ({
                text: (a.textContent || '').trim(),
                href: a.getAttribute('href') || '',
                download: a.getAttribute('download') || '',
            })),
            warnCount: val.querySelectorAll('span[title*="附件路径非法"]').length,
        };
    });
}

// codex 审 L-1：每个页面都挂监听，不再只挂第一个却声称"全程 0 error"
async function newPageWithErrs(browser) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page._errs = errs;
    return page;
}

async function openDetail(page, token, id) {
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Data_Collab.html?id=${id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);   // 深链自动开详情
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const created = [];
    try {
        const adminToken = await fx.signAs(fx.ADMIN_ID);

        // ═══════════════════════════════════════════════════════════════
        // T1 + T2：两个 example_xlsx → 都显示 + 计数 + 逐项 href 对应 + 排序有判别力
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1/T2：两个数据模板 → 都显示 + 计数 + 排序（接口逆序前提） ──');
            const fxA = await fx.createPendingFixture();
            created.push(fxA.id);
            const stamp = Date.now();
            const nameA1 = `TPL一-需确认员工身份信息-${stamp}.xlsx`;
            const nameA2 = `TPL二-需确认员工身份信息-${stamp}.xlsx`;
            // ⭐ codex 审 M-2：刻意让**大 id 的 created_at 更晚** ⇒ detail 端点 `ORDER BY created_at DESC`
            //   会把大 id 排在前面（逆序返回）。这样"页面按 id 升序展示"只能由前端 sort 达成，
            //   删掉 sort 本条立刻红；若两条 created_at 相同，接口顺序碰巧就是 id 升序，断言会偶然通过。
            // 固定且互不相同的 file_name（codex 二轮 M）：下面要断言"每个链接的 href 指向**自己那条**附件"，
            //   只断言"两个 href 不同"挡不住两者被**互换**的情形（互换后 href 依然互不相同，全绿）。
            const fileA1 = `collab/test/tpl-A1-${stamp}.xlsx`;
            const fileA2 = `collab/test/tpl-A2-${stamp}.xlsx`;
            const id1 = await insertAttachment(fxA.id, nameA1, 1, { createdAt: '2026-09-11 13:55:53', fileName: fileA1 });
            const id2 = await insertAttachment(fxA.id, nameA2, 2, { createdAt: '2026-09-11 13:55:59', fileName: fileA2 });
            must(id2 > id1, `夹具前提：第二个附件 id 更大（${id1} < ${id2}）`);

            const page = await newPageWithErrs(browser);
            await openDetail(page, adminToken, fxA.id);

            // 先证明"接口确实逆序返回"这个前提成立，否则 T2 的判别力无从谈起
            const apiOrder = await page.evaluate(async (cid) => {
                const r = await fetch(`/api/collab/requests/${cid}`, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
                });
                const j = await r.json();
                return (j.attachments || []).filter(a => a.attachment_type === 'example_xlsx').map(a => a.id);
            }, fxA.id);
            must(JSON.stringify(apiOrder) === JSON.stringify([id2, id1]),
                `⭐ T2 前提：detail 接口按 created_at DESC **逆序**返回（实得 ${JSON.stringify(apiOrder)}，期望 [${id2},${id1}]）——此前提成立，下面的升序断言才有判别力`);

            const cell = await readTemplateCell(page);
            must(!!cell, `能定位到「数据模板」kv 格`);
            if (cell) {
                must(cell.text.includes(nameA1), `第 1 个文件名出现（${nameA1}）`);
                must(cell.text.includes(nameA2), `⭐ 第 2 个文件名也出现（${nameA2}）——这正是生产 #53 漏掉的那个`);
                must(/共\s*2\s*个文件/.test(cell.text), `多文件时显示计数「共 2 个文件」`);
                const p1 = cell.text.indexOf(nameA1), p2 = cell.text.indexOf(nameA2);
                must(p1 >= 0 && p2 >= 0 && p1 < p2, `⭐ 页面按 id 升序展示（接口逆序 → 前端 sort 生效），实得位置 ${p1} < ${p2}`);
                // codex 建议：不只数链接个数，逐项断言"名称与 href 对应"（防两个链接指向同一附件）
                must(cell.links.length === 2, `渲染出 2 个下载链接（实得 ${cell.links.length}）`);
                if (cell.links.length === 2) {
                    must(cell.links[0].text.includes(nameA1) && cell.links[1].text.includes(nameA2),
                        `两个链接按序分别对应两个文件名`);
                    // ⭐ codex 二轮 M：断言**每个链接指向自己那条附件**，而不只是"两个 href 不同"——
                    //   后者在两个 href 被互换时依然成立（全绿），等于没守住对应关系。
                    const h0 = decodeURIComponent(cell.links[0].href);
                    const h1 = decodeURIComponent(cell.links[1].href);
                    must(h0.includes(fileA1) && !h0.includes(fileA2),
                        `第 1 个链接 href 指向**第 1 条附件**的 file_name（含 ${fileA1.split('/').pop()}、不含另一条）`);
                    must(h1.includes(fileA2) && !h1.includes(fileA1),
                        `第 2 个链接 href 指向**第 2 条附件**的 file_name（含 ${fileA2.split('/').pop()}、不含另一条）`);
                }
            }
            must(page._errs.length === 0, `T1/T2 无 JS 报错（${page._errs.length} 个${page._errs.length ? ': ' + page._errs.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3（codex 审 M-3）：混合夹具 —— 过滤条件与非法路径分支的判别力
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T3：混合夹具（非法路径 / 非 active / 其他类型 / status=NULL 历史行） ──');
            const fxD = await fx.createPendingFixture();
            created.push(fxD.id);
            const s = Date.now();
            const okName = `TPL合法-${s}.xlsx`;
            const nullStatusName = `TPL历史缺省态-${s}.xlsx`;
            const badPathName = `TPL非法路径-${s}.xlsx`;
            const supersededName = `TPL已废止-${s}.xlsx`;
            const otherTypeName = `不该出现的模板-${s}.xlsx`;
            await insertAttachment(fxD.id, okName, 1);
            // status 为 NULL = 历史行，渲染条件 `(status==='active' || !status)` 应视为有效
            await insertAttachment(fxD.id, nullStatusName, 2, { status: null });
            // 非法路径：buildAttachmentDownloadUrl 应判 !ok → 出警告且**不生成链接**
            await insertAttachment(fxD.id, badPathName, 3, { fileName: '../../etc/passwd' });
            // 非 active：不应出现
            await insertAttachment(fxD.id, supersededName, 4, { status: 'superseded' });
            // 其他类型：不应出现在本格
            await insertAttachment(fxD.id, otherTypeName, 1, { type: 'data_scope' });

            const page = await newPageWithErrs(browser);
            await openDetail(page, adminToken, fxD.id);
            const cell = await readTemplateCell(page);
            must(!!cell, `能定位到 kv 格`);
            if (cell) {
                must(cell.text.includes(okName), `合法 active 文件出现`);
                must(cell.text.includes(nullStatusName), `status=NULL 的历史行**也**出现（渲染条件含 !status）`);
                must(cell.text.includes(badPathName), `非法路径文件仍出现（以警告形式，不是静默吞掉）`);
                must(!cell.text.includes(supersededName), `superseded 文件**不**出现`);
                must(!cell.text.includes(otherTypeName), `其他 attachment_type **不**出现在本格`);
                must(cell.warnCount === 1, `非法路径项渲染为 ⚠️ 警告（实得 ${cell.warnCount} 个）`);
                // 关键：非法项不能变成可点链接
                const badLinked = cell.links.some(l => l.text.includes(badPathName));
                must(!badLinked, `非法路径项**不带下载链接**（实得链接数 ${cell.links.length}，其中含非法项=${badLinked}）`);
                must(cell.links.length === 2, `仅两个合法项生成链接（实得 ${cell.links.length}）`);
                must(/共\s*3\s*个文件/.test(cell.text), `计数为 3（= 通过过滤的展示项数，含非法路径项；实得文本片段："${(cell.text.match(/共\s*\d+\s*个文件/) || ['(无)'])[0]}"）`);
            }
            must(page._errs.length === 0, `T3 无 JS 报错（${page._errs.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4（codex 审 M-1）：文件名含引号/尖括号 → 属性边界不被突破
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T4：文件名含单引号/双引号/尖括号 → 转义安全 ──');
            const fxE = await fx.createPendingFixture();
            created.push(fxE.id);
            // download 属性用单引号包裹 + escapeHtml；escapeHtml 与 escapeHtmlAttr 当前实现逐字相同
            //   （均转义 & < > " '），故安全。本用例把这一点钉成可判红的断言：两函数将来若分叉、
            //   或有人把属性改成未转义拼接，这里立刻红。
            const trickyName = `TPL'单引号"双引号<script>-${Date.now()}.xlsx`;
            await insertAttachment(fxE.id, trickyName, 1);

            const page = await newPageWithErrs(browser);
            await openDetail(page, adminToken, fxE.id);
            const cell = await readTemplateCell(page);
            must(!!cell, `能定位到 kv 格`);
            if (cell) {
                must(cell.links.length === 1, `仍恰好 1 个链接（属性未被突破产生额外元素，实得 ${cell.links.length}）`);
                // download 属性值应还原为原始文件名（浏览器解析后的属性值是解码后的原文）
                must(cell.links.length === 1 && cell.links[0].download === trickyName,
                    `download 属性值完整且等于原文件名（实得 "${cell.links.length ? cell.links[0].download : ''}"）`);
                must(!/<script/i.test(cell.html) || cell.html.includes('&lt;script'),
                    `文件名里的 <script> 被转义、未形成真实标签`);
                const scriptEls = await page.evaluate(() => {
                    const labels = [...document.querySelectorAll('.detail-kv-label')];
                    const lab = labels.find(l => (l.textContent || '').trim() === '数据模板');
                    return lab && lab.nextElementSibling ? lab.nextElementSibling.querySelectorAll('script').length : -1;
                });
                must(scriptEls === 0, `kv 格内**零个** <script> 元素（实得 ${scriptEls}）`);
            }
            must(page._errs.length === 0, `T4 无 JS 报错（${page._errs.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T5：单个 → 显示且不加计数噪声
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T5：单个数据模板 → 显示且无计数噪声 ──');
            const fxB = await fx.createPendingFixture();
            created.push(fxB.id);
            const nameB = `TPL单文件-${Date.now()}.xlsx`;
            await insertAttachment(fxB.id, nameB, 1);

            const page = await newPageWithErrs(browser);
            await openDetail(page, adminToken, fxB.id);
            const cell = await readTemplateCell(page);
            must(!!cell && cell.text.includes(nameB), `单文件正常显示`);
            must(!!cell && !/共\s*\d+\s*个文件/.test(cell.text), `单文件时**不显示**计数提示`);
            must(page._errs.length === 0, `T5 无 JS 报错（${page._errs.length} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T6：零个 → 占位「—」
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T6：无数据模板文件 → 占位「—」 ──');
            const fxC = await fx.createPendingFixture();
            created.push(fxC.id);
            const page = await newPageWithErrs(browser);
            await openDetail(page, adminToken, fxC.id);
            const cell = await readTemplateCell(page);
            must(!!cell && cell.text.includes('—'), `空态显示占位「—」`);
            must(!!cell && !/共\s*\d+\s*个文件/.test(cell.text), `空态不显示计数提示`);
            must(page._errs.length === 0, `T6 无 JS 报错（${page._errs.length} 个）`);
            await page.close();
        }

    } finally {
        // codex 审 L-1：browser.close() 抛错不得阻断夹具清理 ⇒ 独立 try
        try { await browser.close(); }
        catch (e) { console.log(`  ❗ 浏览器关闭异常（不影响下方清理）：${e && e.message}`); }
        for (const id of created) {
            try { await fx.cleanup(id); console.log(`  🧹 夹具已清理（collab #${id}）`); }
            catch (e) {
                console.log(`  ❗ 夹具 #${id} 清理失败，可能残留：${e && e.message}`);
                cleanupFailures.push(`#${id}: ${e && e.message}`);
            }
        }
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    // codex 审 L-1：清理失败不能被"全部通过"掩盖。退出码分层——功能失败 1（优先），
    //   功能全绿但夹具未清 2，供只读退出码的调用方区分。
    if (fail > 0) {
        console.log('  ❌ 数据模板多文件展示回归存在失败项');
        if (cleanupFailures.length) console.log(`  ❗ 另有 ${cleanupFailures.length} 个夹具清理失败`);
        process.exit(1);
    }
    if (cleanupFailures.length) {
        console.log(`  ❗❗ 功能断言全通过，但 ${cleanupFailures.length} 个夹具清理失败——退出码 2（勿当作完全成功）：\n     - ${cleanupFailures.join('\n     - ')}`);
        process.exit(2);
    }
    console.log('  🎉 数据模板多文件展示回归全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
