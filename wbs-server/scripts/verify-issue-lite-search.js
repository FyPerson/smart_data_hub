/**
 * Commit D verify e2e · 数据开发台账 搜索区后端 + 部门白名单
 * 作废与查询优化 v0.1 §5.3/§7
 *
 * 覆盖：
 *   建单部门白名单（非法/自由文本/系统自动 → 400；白名单值 → 200）
 *   列表组合筛选（status × requester_dept × search 交并正确）
 *   search 四字段命中（title/description/requester_name/oa_number）+ LIKE 特殊字符 %_\ 转义不通配
 *   参数校验（非法部门 400 / 关键词 >100 字 400 / 数组蒙混 400 / include_voided 与 search 组合仍隐藏已作废）
 * 用法：node scripts/verify-issue-lite-search.js
 * [#106 S4b1] 不再自 spawn 服务、不再写死端口 3399、不再按端口杀进程、不再等日志轮询、不再读写真实库：经 scripts/lib/test-env.js 自起临时隔离实例
 *   （来源 = 本检出本地库快照，钉钉走替身、周期任务关闭），也可由 TEST_* 变量组指向已起好的隔离实例；跑完收掉实例并清理测试单。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

let BASE = null;       // ready() 之后赋值
let DB_FILE = null;    // ready() 之后赋值（实例库）
const TITLE_PREFIX = '[SRCHVERIFY]';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
    if (cond) { pass++; results.push(`  ✅ ${name}`); }
    else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}
async function api(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}
function cleanupTestRows() {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (oe) => {
            if (oe) return resolve(`打开实例库失败：${oe.message}`);   // 返回错误描述（null = 成功）；调用方计失败，不吞
            db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], (de) => { db.close(() => resolve(de ? `DELETE 失败：${de.message}` : null)); });
        });
    });
}
// 服务就绪 = 两次真实请求：health/ready 里 issue_lite 模块 ready + 未带 token 访问列表 401（服务确实在应答 issue_lite 路由）
async function issueLiteServiceReady() {
    try {
        const hr = await fetch(`${BASE}/api/health/ready`);
        const hb = await hr.json().catch(() => null);
        const m = hb && hb.modules && hb.modules.issue_lite;
        if (!m || m.ready !== true) return false;
        return (await fetch(`${BASE}/api/issue-lite`)).status === 401;
    } catch (_) { return false; }
}
const mk = (title, extra) => Object.assign({ title: TITLE_PREFIX + title, requester_name: '张三', requester_dept: '市场营销部', requester_phone: '13800001111' }, extra || {});
// 结果集断言辅助：ids 恰好含/不含
const has = (list, id) => (list || []).some(x => x.id === id);

(async () => {
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）；test-env 已等到全部模块（含 issue_lite）就绪
    try {
        BASE = fx.BASE;
        DB_FILE = fx.DB_PATH;
        const ce0 = await cleanupTestRows();
        if (ce0) check('清理历史测试单', false, ce0);
        const ready = await issueLiteServiceReady();
        check('health/ready issue_lite 就绪 + 未带 token 列表 401', ready);
        if (!ready) throw new Error('服务未就绪');

        const adminTok = await fx.signAs(fx.ADMIN_ID);
        const fengTok = await fx.signAs(fx.CONTACT_ID);

        // ===== 建单部门白名单（§7）=====
        let r = await api('POST', '/api/issue-lite', fengTok, mk('自由文本部门', { requester_dept: '随手打的部门' }));
        check('建单自由文本部门 → 400 REQUESTER_DEPT_INVALID', r.status === 400 && r.body.code === 'REQUESTER_DEPT_INVALID', JSON.stringify(r.body));
        r = await api('POST', '/api/issue-lite', fengTok, mk('系统自动部门', { requester_dept: '系统自动' }));
        check('建单「系统自动」（collab 专用·不在 issue_lite 白名单）→ 400', r.status === 400 && r.body.code === 'REQUESTER_DEPT_INVALID');
        r = await api('POST', '/api/issue-lite', fengTok, mk('白名单部门', { requester_dept: '财务管理部' }));
        check('建单白名单部门（财务管理部）→ 200', r.status === 200 && r.body.issue.requester_dept === '财务管理部');

        // ===== 造样本单（覆盖四搜索字段 + 状态 + 部门交叉·夹具逐步断言 200——codex 16 D-L-3）=====
        const mkIssue = async (label, extra) => {
            const rr = await api('POST', '/api/issue-lite', fengTok, mk(label, extra));
            check(`[夹具] 建单 ${label} → 200`, rr.status === 200 && rr.body && rr.body.issue, JSON.stringify(rr.body));
            return (rr.body && rr.body.issue) ? rr.body.issue : { id: -1 };
        };
        const A = await mkIssue('营收看板需求', { requester_dept: '市场营销部', description: '按月份拆分', oa_number: '36421001' });
        const B = await mkIssue('人力报表', { requester_dept: '人事行政部', requester_name: '李四丰', description: '含 100%_覆盖率 字样' });
        // B2：与 B 仅差通配位一字符（codex 16 D-M-2：若 _ 未转义，LIKE 会误命中本行 → 负例）
        const B2 = await mkIssue('人力报表变体', { requester_dept: '人事行政部', description: '含 100%X覆盖率变体 字样' });
        // BS：反斜杠字面样本（单反斜杠 + 尾随反斜杠场景）
        const BS = await mkIssue('路径样本', { requester_dept: '市场营销部', description: '落在 D:\\temp\\ 目录' });
        const C = await mkIssue('归档样本', { requester_dept: '人事行政部' });
        let rr = await api('PUT', `/api/issue-lite/${B.id}/status`, fengTok, { status: '处理中' });
        check('[夹具] B 进处理中 → 200', rr.status === 200);
        rr = await api('PUT', `/api/issue-lite/${C.id}/status`, adminTok, { status: '已归档' });
        check('[夹具] C 归档 → 200', rr.status === 200);
        const V = await mkIssue('作废样本营收', { requester_dept: '市场营销部' });
        rr = await api('POST', `/api/issue-lite/${V.id}/void`, fengTok, { reason: '搜索场景作废样本' });
        check('[夹具] V 作废 → 200', rr.status === 200);

        // ===== 组合筛选 =====
        let list = (await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent('人事行政部'), fengTok)).body;
        check('部门筛选：人事行政部 含 B/C 不含 A', has(list, B.id) && has(list, C.id) && !has(list, A.id));
        list = (await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent('人事行政部') + '&status=' + encodeURIComponent('处理中'), fengTok)).body;
        check('部门×状态：人事行政部+处理中 恰含 B', has(list, B.id) && !has(list, C.id) && !has(list, A.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('营收'), fengTok)).body;
        check('search 命中 title（营收→A·已作废 V 默认隐藏）', has(list, A.id) && !has(list, V.id) && !has(list, B.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('按月份拆分'), fengTok)).body;
        check('search 命中 description', has(list, A.id) && !has(list, B.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('李四丰'), fengTok)).body;
        check('search 命中 requester_name', has(list, B.id) && !has(list, A.id));
        list = (await api('GET', '/api/issue-lite?search=36421001', fengTok)).body;
        check('search 命中 oa_number', has(list, A.id) && !has(list, B.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('datadev-' + B.id), fengTok)).body;
        check('search 命中 datadev 占位号（留空 OA 自动补·可检索）', has(list, B.id) && !has(list, A.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('营收') + '&status=' + encodeURIComponent('待处理') + '&requester_dept=' + encodeURIComponent('市场营销部'), fengTok)).body;
        check('三条件组合（营收+待处理+市场营销部）恰含 A', has(list, A.id) && list.every(x => x.status === '待处理' && x.requester_dept === '市场营销部'));
        // admin 含已作废 + search：V 可见
        list = (await api('GET', '/api/issue-lite?include_voided=1&search=' + encodeURIComponent('营收'), adminTok)).body;
        check('admin 含已作废 + search：A/V 均命中', has(list, A.id) && has(list, V.id));

        // ===== LIKE 转义：%/_/\ 按字面匹配不通配（codex 16 D-M-2 负例）=====
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('100%_覆盖率'), fengTok)).body;
        check('search「100%_覆盖率」恰命中 B（字面）且不命中 B2（_ 未通配到 X·转义证毕）', has(list, B.id) && !has(list, B2.id) && !has(list, A.id), JSON.stringify((list || []).map(x => x.id)));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('100%X覆盖率'), fengTok)).body;
        check('search「100%X覆盖率」恰命中 B2 不因 % 通配误命中 B', has(list, B2.id) && !has(list, B.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('D:\\temp'), fengTok)).body;
        check('search 单反斜杠字面「D:\\temp」命中 BS', has(list, BS.id) && !has(list, A.id));
        list = (await api('GET', '/api/issue-lite?search=' + encodeURIComponent('temp\\'), fengTok)).body;
        check('search 尾随反斜杠「temp\\」命中 BS（转义器不吞尾杠）', has(list, BS.id));

        // ===== 前后端部门清单契约（codex 16 D-M-1：防「可选但提交被拒」漂移·不重构双点维护）=====
        const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'js', 'app.js'), 'utf8');
        const dm = appJs.match(/window\.PLATFORM_REQUESTER_DEPTS\s*=\s*\[([\s\S]*?)\]/);
        const frontDepts = dm ? Array.from(dm[1].matchAll(/'([^']+)'/g)).map(x => x[1]) : [];
        // codex 17 E-L-1：锚定 26 项基线——清单增删须显式过本测试（防正则只提取到部分仍假通过）
        check(`契约：前端清单恰 26 项基线且不含「系统自动」且无重复（实际 ${frontDepts.length} 项）`,
            frontDepts.length === 26 && !frontDepts.includes('系统自动') && new Set(frontDepts).size === frontDepts.length,
            frontDepts.join(','));
        const rejectedDepts = [];
        for (const d of frontDepts) {
            const cr = await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent(d), fengTok);
            if (cr.status !== 200) rejectedDepts.push(`${d}:${cr.status}`);
        }
        check('契约（单向兼容·前端⊆后端）：前端全部部门后端白名单均接受', rejectedDepts.length === 0, rejectedDepts.join(','));

        // ===== 参数校验 =====
        r = await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent('不存在的部'), fengTok);
        check('非法部门筛选 → 400 INVALID_DEPT_FILTER', r.status === 400 && r.body.code === 'INVALID_DEPT_FILTER');
        r = await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent('系统自动'), fengTok);
        check('部门筛选「系统自动」→ 400（同白名单口径）', r.status === 400 && r.body.code === 'INVALID_DEPT_FILTER');
        r = await api('GET', '/api/issue-lite?search=' + encodeURIComponent('x'.repeat(101)), fengTok);
        check('关键词 >100 字 → 400 SEARCH_TOO_LONG', r.status === 400 && r.body.code === 'SEARCH_TOO_LONG');
        r = await api('GET', '/api/issue-lite?search=' + encodeURIComponent('x'.repeat(100)), fengTok);
        check('关键词恰 100 字（UTF-16 码元口径·与前端 maxlength 一致）→ 200', r.status === 200 && Array.isArray(r.body));
        r = await api('GET', '/api/issue-lite?search=' + encodeURIComponent('   '), fengTok);
        check('纯空白关键词 = 无筛选 → 200 且样本 A 可见', r.status === 200 && has(r.body, A.id));
        r = await api('GET', '/api/issue-lite?search=a&search=b', fengTok);
        check('search 数组蒙混 → 400', r.status === 400 && r.body.code === 'INVALID_SEARCH');
        r = await api('GET', '/api/issue-lite?search[x]=y', fengTok);
        check('search 嵌套对象蒙混 → 400', r.status === 400 && r.body.code === 'INVALID_SEARCH');
        r = await api('GET', '/api/issue-lite?requester_dept=' + encodeURIComponent('市场营销部') + '&requester_dept=' + encodeURIComponent('人事行政部'), fengTok);
        check('requester_dept 数组蒙混 → 400', r.status === 400 && r.body.code === 'INVALID_DEPT_FILTER');
    } catch (e) {
        fail++;
        results.push(`  ❌ 异常中断：${e.message}`);
    } finally {
        if (DB_FILE) { const ce = await cleanupTestRows(); if (ce) check('清理测试单', false, ce); }
        try { await fx.teardown(); } catch (e) { fail++; results.push(`  ❌ teardown（收掉自起实例）失败：${e.message}`); }
    }

    console.log('─────── Commit D 搜索+部门白名单 verify ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? `✅ PASS（${pass}/${pass + fail}）` : `❌ FAIL（${fail} 项失败 / 共 ${pass + fail}）`}`);
    fx.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + 10 秒 unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('Commit D verify 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
