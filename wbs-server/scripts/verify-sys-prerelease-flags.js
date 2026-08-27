/**
 * 系统迭代·待上线两 flag 的判定不变量守卫（2026-08-12 新增·codex 350 号 MED 收口）
 *
 * 守的是什么：「已移出 / 未排期」的判定依赖一条**跨文件的隐性不变量**——
 *   「列表 SELECT 的轮次锚点只认 accept，而 accept 是唯一能开启新一轮『待上线』的动作」。
 *   这个不变量当前成立（下方断言①逐条证明），但它写在 transitions.js 里、被 index.js 的一段 SQL 依赖，
 *   中间没有任何东西守着：将来谁加一条新的 `to: '待上线'` 边而忘了写 actionCode，或者把 accept 的
 *   actionCode 改名，锚点就会静默失效——已被移出的单会退化显示成「未排期」（349 号抓到的正是这个形态，
 *   对照组实测能复现）。守卫存在的意义就是把"靠人记得"换成"改错了当场红"。
 *
 * ⚠️ 本守卫是**纯静态**的：只证明代码文本层面的契约还在，不证明运行时行为——
 *   运行时那一半由 scripts/test-sys-prerelease-flags-playwright.js 的 T1-T7 真实 DOM 断言负责，
 *   两者缺一不可（本项目三次栽在"静态全绿但渲染端没生效"上）。
 */
const fs = require('fs');
const path = require('path');
const { findOuterBoundary } = require('./lib/sql-select-boundary');

const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
const TRANS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'transitions.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => (cond ? ok(m) : bad(m));

// 剥注释先行（guard gotchas：注释里的样例代码会让文本扫描假命中/假放行）
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}
// SQL 在 JS 模板串里用 `--` 注释，另剥一道
function stripSqlComments(s) {
    return s.replace(/^[ \t]*--.*$/gm, '');
}

console.log('=== 待上线两 flag · 判定不变量守卫 ===\n');
console.log('--- ① 锚点不变量：能进「待上线」的边有且只有 accept ---');

// transitions.js 里每个 `to: '待上线'` 的边，其 actionCode 必须是 'accept'。
// 取法：找到每处 `to: '待上线'`，在它之后最近的 `actionCode:` 上取值（同一 transition 对象内，
//   条目之间由 `},` 分隔，故限制在下一个 `\n  },` 之前）。
{
    const transNoComment = stripComments(TRANS);
    const hits = [...transNoComment.matchAll(/to:\s*'待上线'/g)];
    must(hits.length >= 3, `transitions.js 中 to:'待上线' 的边实抓 ${hits.length} 条（少于 3 条=正则失配或流程被删，须人工确认）`);

    const offenders = [];
    for (const h of hits) {
        const rest = transNoComment.slice(h.index);
        const end = rest.search(/\n\s{2}\},/);
        const block = end < 0 ? rest.slice(0, 1200) : rest.slice(0, end);
        const m = block.match(/actionCode:\s*(null|'([^']*)')/);
        const val = m ? (m[1] === 'null' ? null : m[2]) : '(未声明)';
        if (val !== 'accept') offenders.push(val === null ? 'null' : String(val));
    }
    must(offenders.length === 0,
        `每条 to:'待上线' 的边其 actionCode 均为 'accept'${offenders.length ? `——实得非法值：${offenders.join(', ')}。列表 SELECT 的轮次锚点只认 accept，新增此类边必须同步锚点谓词，否则已移出的单会退化显示「未排期」` : `（${hits.length} 条）`}`);

    // 反向：resume 不得被误写成 accept（它同样会写 status_change→待上线，正是 349 号缺陷的来源）
    const resumeActionCodes = [...transNoComment.matchAll(/action:\s*'resume'[\s\S]{0,900}?actionCode:\s*'([^']+)'/g)].map((m) => m[1]);
    must(resumeActionCodes.length >= 3, `resume 边实抓 ${resumeActionCodes.length} 条（三个流各一条）`);
    must(resumeActionCodes.every((v) => v === 'resume'),
        `每条 resume 边的 actionCode 均为 'resume' 而非 'accept'（实得：${resumeActionCodes.join(', ')}）——写成 accept 会让暂缓恢复冲掉本轮移出记录`);
}

console.log('\n--- ①b 锚点不变量的另一半：直接写 timeline 的路径不得伪造锚点行 ---');
// 为什么需要这一条（codex 351 号 MED）：锚点谓词放行 `action_code IS NULL`（留给早于 action_code
//   落库的历史行）。这个放行安全的**前提**是"现代写点不会产生 event_type='status_change' +
//   to_status='待上线' 且 action_code 为空的行"——该前提当初是人工逐点核验的（index.js 全部 30 处
//   INSERT INTO sys_issue_timeline，不带 action_code 列且带 to_status 的 4 处，event_type 分别是
//   created/assign/assign/release，均非 status_change）。人工核验会过期，绕过 transitions.js 直接
//   插一条这种行的新代码不会有任何东西拦它。本断言把那次核验固化成机器判据。
//   ⚠️ 覆盖边界（如实写明）：只扫 routes/sys-iteration/index.js 的直接写点 + transitions.js 的表驱动
//   写点（①段），不扫 scripts/ 下的夹具脚本（它们自造自删、不进生产库）。
{
    const src = stripComments(ROUTES);
    // 两种写法都要覆盖：`(cols) VALUES (...)` 与 `(cols) SELECT ... [WHERE ...]`（本文件确有一处后者）。
    //   只写 VALUES 版会静默漏掉 INSERT...SELECT——那种"扫描面自己有洞"的守卫比没有守卫更危险，
    //   因为它照样打印一片 [OK]。下方的总数对拍就是防这个的：漏一处就红，逼人回来修正则。
    const STMT_RE = /INSERT INTO sys_issue_timeline\s*(?:\r?\n\s*)?\(([^)]*)\)\s*(?:\r?\n\s*)?(?:VALUES\s*\(([^)]*)\)|SELECT\s+([\s\S]*?)(?:\s+WHERE\s|\s+FROM\s|`))/g;
    const stmts = [...src.matchAll(STMT_RE)];
    const allOccurrences = (src.match(/INSERT INTO sys_issue_timeline/g) || []).length;
    must(stmts.length >= 20, `index.js 直接 timeline 写点实抓 ${stmts.length} 处（过少=正则失配，扫描面须非空）`);
    must(stmts.length === allOccurrences,
        `扫描面完整：文件里 ${allOccurrences} 处 INSERT INTO sys_issue_timeline 全部被解析到（实解析 ${stmts.length} 处）——差额=有写法没被正则覆盖，那些写点不受本守卫保护`);

    const offenders = [];
    for (const m of stmts) {
        const cols = m[1].split(',').map((c) => c.trim());
        const vals = (m[2] !== undefined ? m[2] : (m[3] || '')).split(',').map((v) => v.trim());
        if (cols.includes('action_code')) continue;        // 显式写了 action_code，由该写点自己负责
        if (!cols.includes('to_status')) continue;         // 压根不写 to_status，不可能成为锚点行
        const evIdx = cols.indexOf('event_type');
        const ev = evIdx >= 0 ? vals[evIdx] : '(缺列)';
        // 判据：这类写点的 event_type 必须是**字面量且不是 'status_change'**。
        //   写成 `?`（运行时才知道）同样判红——那意味着它可能在运行时变成 status_change，
        //   而列里又没有 action_code 兜底，正是本断言要挡的形态。
        if (!/^'[^']*'$/.test(ev) || ev === `'status_change'`) {
            offenders.push(`event_type=${ev}（列：${cols.join('/')}）`);
        }
    }
    must(offenders.length === 0,
        `不写 action_code 的 timeline 写点其 event_type 均为非 status_change 的字面量${offenders.length ? `——实得可疑写点 ${offenders.length} 处：${offenders.join('；')}。这类行会被列表 SELECT 的轮次锚点当成"进入待上线"，把已移出的单错标成「未排期」；请显式写 action_code='accept' 或改走 transitions 引擎` : `（扫 ${stmts.length} 处）`}`);

    // 对照组：构造一条"不写 action_code 却写 status_change→待上线"的语料，判据必须报出来
    {
        const fake = `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'status_change', ?, '待上线', ?, ?, ?)`;
        const fm = [...fake.matchAll(/INSERT INTO sys_issue_timeline\s*(?:\r?\n\s*)?\(([^)]*)\)\s*(?:\r?\n\s*)?VALUES\s*\(([^)]*)\)/g)];
        let caught = 0;
        for (const m of fm) {
            const cols = m[1].split(',').map((c) => c.trim());
            const vals = m[2].split(',').map((v) => v.trim());
            if (cols.includes('action_code') || !cols.includes('to_status')) continue;
            const ev = vals[cols.indexOf('event_type')];
            if (!/^'[^']*'$/.test(ev) || ev === `'status_change'`) caught++;
        }
        must(caught === 1, '★对照组①b：伪造一条 status_change→待上线 且不写 action_code 的写点 → 判据必须抓到（证明它不是恒真）');
    }
}

console.log('\n--- ② 列表 SELECT：锚点谓词齐备且四列同源 ---');
{
    const sqlStart = ROUTES.indexOf('`SELECT id, type, status, priority, risk_level, title, system_name');
    must(sqlStart > 0, '列表 SELECT 可定位');
    // [S13-b·B1 实测撞见同款修法] 裸 `ROUTES.indexOf('FROM sys_issues', sqlStart)` 会被列表 SELECT 内部
    //   自身含相关子查询骗到——B1 新增 post_derive_root_id/post_derive_seq 两条标量子查询形如
    //   `(SELECT d.derive_root_id FROM sys_issues d WHERE d.id = ...)`，其中 "FROM sys_issues" 字面量
    //   比外层真正的 FROM 更早出现，naive indexOf 会在子查询内部截断，把外层真正 FROM 之前的大段列（含
    //   本守卫要扫的四个派生列）全部漏进 sqlBlock 之外——与 verify-sys-list-badge-fields.js /
    //   verify-sys-completion-overrun.js 已修的同款问题同一根因（guard gotchas 家族：字符串扫描器被
    //   合法 SQL 结构骗过）。改用括号深度感知扫描：跳过子查询内部文本，只认深度=0 时出现的第一个
    //   "FROM sys_issues" 才是外层列表的真正终点。⚠️ 扫描与切片全程在**已剥注释的字符串自身**内进行、
    //   不回映射原始 ROUTES 偏移——stripSqlComments 是"删除匹配子串"而非"等长空白替换"，剥注释后长度
    //   会变短，若把在剥注释文本里找到的下标当成原始 ROUTES 里的偏移量去二次切片会systematically算错
    //   （首次实现犯过这个错，此处直接改正）。
    // [S13 收口 MED-2] 深度感知扫描本身抽到 scripts/lib/sql-select-boundary.js 单点实现（与
    //   verify-sys-list-badge-fields.js 共用同一份，不再两文件各自逐字维护）——顺带补 fail-closed：
    //   窗口内括号计数一旦变负立即判红，不信任"变负之后又凑巧归零"的假 top-level 命中（否则扫描可能
    //   悄悄跳到别的语句块同名 FROM 上，选出混了别处内容的超集列集合却不报错，见该模块头注）。
    const sqlStrippedFull = stripSqlComments(ROUTES.slice(sqlStart, sqlStart + 60000));
    const sqlBoundaryResult = findOuterBoundary(sqlStrippedFull, 'FROM sys_issues');
    must(!sqlBoundaryResult.wentNegative, '边界扫描括号深度全程非负（fail-closed：一旦变负说明括号计数已不自洽，不信任后续任何"恰好归零"的命中，防止静默选中混了别处内容的超集范围）');
    const sqlOuterFromIdxInStripped = sqlBoundaryResult.index;
    must(sqlOuterFromIdxInStripped > 0, '外层 FROM sys_issues 边界可定位（深度感知扫描，不被子查询内的同字面量截断）');
    const sqlBlock = sqlOuterFromIdxInStripped > 0 ? sqlStrippedFull.slice(0, sqlOuterFromIdxInStripped) : '';
    // 边界正确性断言（MED-2 新增，457-H2 收口后指纹改版）：命中点紧随其后应能看到本条列表 SELECT 自己
    //   的收尾特征，证明这次真落在这条列表查询自己的外层 FROM，不是巧合命中了别处同名字面量。
    //   ⚠️ [「待我处理」全角色卡·方案 §6 断言 5·457-H2 冻结] 查询构建抽成 buildSysIssuesListSelect/
    //   buildSysIssuesListQuery 两个纯函数后，`FROM sys_issues` 已不再与 `${where...}` 动态 WHERE 拼接
    //   同处一个模板字符串——FROM 留在 buildSysIssuesListSelect 收尾（selectSql 的一部分），WHERE/
    //   ORDER BY 挪到 buildSysIssuesListQuery 里单独拼接。指纹改为 buildSysIssuesListSelect 收尾处的
    //   `return { selectSql, selectParams }`（与 verify-sys-list-badge-fields.js 同批同款修法）。
    const sqlAfterBoundary = sqlOuterFromIdxInStripped > 0 ? sqlStrippedFull.slice(sqlOuterFromIdxInStripped, sqlOuterFromIdxInStripped + 120) : '';
    must(sqlAfterBoundary.includes('return { selectSql, selectParams }'), `外层边界后文应含本条 SELECT 自己的收尾特征 "return { selectSql, selectParams }"（证明命中点确是 buildSysIssuesListSelect 收尾处的 FROM，非误中别处），命中点后 120 字符原文：${JSON.stringify(sqlAfterBoundary)}`);

    const anchorRe = /AND tla\.event_type = 'status_change' AND tla\.to_status = '待上线'\s*AND \(tla\.action_code = 'accept' OR tla\.action_code IS NULL\)/g;
    const anchorCount = (sqlBlock.match(anchorRe) || []).length;
    must(anchorCount === 4,
        `轮次锚点谓词在列表 SELECT 中出现 ${anchorCount} 次（须恰为 4 = 判定列 has_release_remove 1 次 + 悬停三要素各 1 次）——判定与展示必须同源，少一处就会出现"显示了但内容取自另一条记录"`);

    // 四个消费方逐个点名（只数总次数的话，四个都写在同一列上也会绿）
    for (const col of ['has_release_remove', 'last_release_remove_summary', 'last_release_remove_by', 'last_release_remove_at']) {
        const idx = sqlBlock.indexOf(`AS ${col}`);
        const seg = idx > 0 ? sqlBlock.slice(Math.max(0, idx - 900), idx) : '';
        must(idx > 0 && /AND \(tla\.action_code = 'accept' OR tla\.action_code IS NULL\)/.test(seg),
            `派生列 ${col} 自身带轮次锚点谓词`);
    }

    must(/AND tlr\.action_code = 'release_remove'/.test(sqlBlock), "四列均以 action_code='release_remove' 为事件依据");
}

console.log('\n--- ③ 前端：三态判定 + 状态门控 ---');
{
    const start = HTML.indexOf('function siPrereleaseFlagHtml(');
    must(start > 0, 'siPrereleaseFlagHtml 可定位');
    let i = HTML.indexOf('{', start), depth = 0, end = -1;
    for (; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = stripComments(HTML.slice(start, end + 1));

    must(/i\.status\s*!==\s*'待上线'/.test(body),
        '状态门控在（开发中/待处理的单 release_id 同样为空，不门控会被误标「未排期」）');
    must(/i\.release_id\s*!=\s*null/.test(body), 'release_id 非空即返回（D4：加回批次两 flag 自动消失）');
    must(/isRemoved/.test(body) && /isNotRemoved/.test(body),
        '显式三态判定在（不是 `!== 1` 一刀切——契约断裂时不得默默落到「未排期」）');
    must(/console\.error/.test(body), '契约断裂时有 console.error 留痕（静默降级=把自家 bug 显示成业务结论）');
    must(/si-flag removed/.test(body) && /si-flag unsched/.test(body), '两个 flag 的 class 都在本函数内产出（单一出口）');
    must(/esc\(/.test(body), 'title 走 esc() 转义（内容含用户填写的移出原因自由文本）');

    // 互斥：两个 flag 各自 return，不可能同时输出
    const returns = body.match(/return\s+`<span class="si-flag/g) || [];
    must(returns.length === 2, `两 flag 各自独立 return（实得 ${returns.length} 处）——互斥由控制流保证，不是靠调用方自觉`);
}

console.log('\n--- ④ 对照组：证明上面的判据不是恒真 ---');
{
    // ①的对照组：把 accept 的 actionCode 换成别的值，断言必须报出来
    const fakeTrans = `
  { action: 'accept', from: ['待验证'], to: '待上线', timelineEvent: 'status_change', actionCode: 'resume',
  },`;
    const hit = [...stripComments(fakeTrans).matchAll(/to:\s*'待上线'/g)];
    let fakeOffenders = 0;
    for (const h of hit) {
        const rest = stripComments(fakeTrans).slice(h.index);
        const end = rest.search(/\n\s{2}\},/);
        const block = end < 0 ? rest : rest.slice(0, end);
        const m = block.match(/actionCode:\s*(null|'([^']*)')/);
        const val = m ? (m[1] === 'null' ? null : m[2]) : '(未声明)';
        if (val !== 'accept') fakeOffenders++;
    }
    must(fakeOffenders === 1, '★对照组①：把 to:待上线 的边写成 actionCode:resume → 判据必须报违规（证明它不是恒真）');

    // ②的对照组：少一处锚点谓词就该红
    const fakeSql = `x AS has_release_remove, AND tla.event_type = 'status_change' AND tla.to_status = '待上线' AND (tla.action_code = 'accept' OR tla.action_code IS NULL)`;
    const c = (fakeSql.match(/AND \(tla\.action_code = 'accept' OR tla\.action_code IS NULL\)/g) || []).length;
    must(c !== 4, '★对照组②：只有 1 处锚点谓词的语料不满足"恰为 4 次"（证明计数判据真在数，不是恒真）');

    // ③的对照组：`!== 1` 一刀切写法必须判红
    const fakeBody = `function f(i){ if (Number(i.has_release_remove) !== 1) return '未排期'; }`;
    must(!/isRemoved/.test(fakeBody), '★对照组③：旧的 `!== 1` 一刀切写法不含三态标识 → 判据会红');
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
