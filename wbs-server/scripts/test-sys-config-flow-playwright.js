/**
 * 系统迭代·config（配置变更）第 4 类型激活——前端 Playwright 冒烟（S1c）
 *
 * 方案：docs/local/系统迭代/config流激活_方案_20260907_v1.0.md（§3/§4/§6）
 * 派单 spec：E:/tmp/lt0907-s1c-spec.md
 * 后端契约：S1a `59325ccf`（状态机/端点/execModes）+ S1b `25eececc`（sys_issues 受控重建，config 可带 release_id）
 *
 * 骨架抄 test-sys-accept-evidence-playwright.js（JWT 注入登录 + login.html 中继跳转 + 直查库断言范式）。
 * 前端改动是静态文件即时生效，不需重启本地 server（本文件只读/只走真实 HTTP+DB，不重启/不 kill 任何进程）。
 *
 * 覆盖（对齐 spec §2/§3）：
 *   T1  admin：建单弹层类型下拉含「配置变更」+ 对接人必填校验 + UI 建单成功
 *   T2  admin：受理弹层 config 显示风险等级选择并必填（发现于本批的阻断性缺口修复，见 Sys_Iteration.html
 *       siModalIntakeAccept riskApplicable 处注释——原 isChange 判据漏 config，会导致整条受理链路 400）
 *   T3  admin：指派弹层执行方式三选 + 乙方名称联动（vendor 必填/非 vendor 隐藏清空）
 *   T4  详情 kv 显示执行方式 + 乙方名称
 *   T5  普通开发账号：处理中 estimate/submit 按钮可见；提交弹层只见「无代码交付」单选（无「提交 commit」
 *       选项）；配置说明 <10 码点被前端拦、≥10 码点提交成功 → 直查库 dev_status='no_code'
 *   T6  admin 验收弹层：config 显示 online_mode 单选且**默认 release 已勾选**（DOM 级断言，非仅端到端结果——
 *       这是活体变异①的判别锚点）；release 提交 → 直查库 status='待上线'；另建一单选 direct → 提交 →
 *       直查库 status='已上线'∧online_source='no_commit_acceptance'（零 commit 免上线直翻）
 *   T7  对照组：bug 单风险等级不适用负例（列表 "-" 占位 + title）；improvement 单验收弹层无 online_mode 单选
 *   T8  类型卡 4 张 + 筛选下拉含「配置变更」
 *   T9  「已生效」不再出现在任何分组/别名——源码静态 grep（排除注释与"点卡筛选已生效"等无关短语）+ 渲染
 *       DOM 扫描（类型卡/状态筛选下拉/列表/详情/时间线全程不出现该三字）
 *   T10 「待我处理」谓词含 config 各态——开发账号在 config「处理中」态可见（siIsMyPending 直调）、受理人在
 *       「待受理」可见、admin 在「待验证」可见（S1c spec 10b 项：type-agnostic 状态门验证，非新增代码）
 *   T11（补丁 AC·AC1）hotfixBtn 应急上线按钮含 config——待上线可见、处理中不可见、improvement 对照
 *   T12（补丁 AC·AC2）通知面板顶层分派含 config——走「变更流」布局（标题/底部文案），bug 对照仍走「独立」布局
 *   T13（补丁 AD·AD5，补丁 AE·AE10 加固请求体捕获）改派 exec_mode/vendor_name 四种变化组合：
 *       ①只改成员值不变（请求体断言不含 exec_mode/vendor_name 两键） ②只改名称 mode 不变（请求体断言
 *       exec_mode='vendor'∧vendor_name=新名称 + 时间线新旧名称展示） ③vendor→self 清空名称（时间线
 *       "乙方执行→本人执行"+名称清空展示） ④vendor 单清空名称前端拦截（toast+弹层不关+库值不变+改派
 *       请求数为零）
 *   T3v（补丁 AE·AE8）首次指派 UI 走 vendor 成功路径——断请求体/库值 exec_mode='vendor'∧vendor_name=
 *       输入名称；另一夹具 vendor 填名后切「指派执行」——断请求不带 vendor_name 键、落库 NULL
 *   T5b/T5c（补丁 AE·AE9）预计完成入口可见 + 提交码点边界（9 个补充平面字符拒/10 个接受/501 拒）+
 *       两个确认框分别漏勾（提示 + 提交请求数为零）
 *   T12b（补丁 AE·AE7）通知区通道操作权限——绑定受理人(LIAISON_ID)在待验证/处理中两态可见建单人/
 *       业务方/开发三通道操作按钮，在册开发(DEV_ID·非绑定受理人非 admin)看不到；并断言 config 通知区
 *       结构性不出现 relay/对接测试/上线执行三类专属行
 *   T14（补丁 AD·AD1）OA 补填号入口——config 可见 + 文案不含必填措辞（后端豁免必填但允许可填窗口，
 *       前端此前 SI_OA_ALLOWED_STATUSES 漏 config 键，入口永不渲染）；improvement 对照仍必填
 *   AE2（补丁 AE·AE2·511-B H2）故意让指派失败（缺 exec_mode）——验证建单+受理成功的夹具已在建单阶段
 *       立即登记进 createdIds（不依赖后续指派是否成功），且清理后主表+五张子表专项核验零残留
 *
 *   八轮变异（MUT1-5 沿自 S1c/AC/AD 各批，MUT6-8 为补丁 AE·§4 三个 codex 511-B 预测"删这行仍全绿"的
 *   候选，已固化为永久性活体变异测试）：
 *   MUT1（S1c，补丁 AE 加固正向对照+写入移进 try+健康检查）撤去 accept 单选默认 checked → T6 的
 *       "默认 release 已勾选"DOM 断言应判红
 *   MUT2（S1c，补丁 AE 同上加固）撤销 siIsDevAction 的 config → T5 的"处理中态 submit 按钮可见"断言
 *       应判红（健康检查排除本变异自身触发的 [siIsDevAction] 防御性 console.error 日志，非放宽标准）
 *   MUT3（补丁 AC·AC1，补丁 AE 加固）撤去 hotfixBtn 条件的 config → T11 的"待上线可见"断言应判红
 *   MUT4（补丁 AD·AD1，补丁 AE 加固）撤去 SI_OA_ALLOWED_STATUSES 的 config 键 → T14 第一条断言应判红
 *   MUT5（补丁 AD·AD5，补丁 AE·AE5 重做判红归因）撤去改派 vendorChanged 判据 → T13②④应判红：
 *       ②要求行存在∧名称仍为正向对照后的基线值（不再只断"不等于新值"，防查不到行也误判成功杀死变异）；
 *       ④改为捕获实际改派请求与后端响应（请求确实发出∧后端 409 VALIDATION"开发集合与执行方式均无
 *       变更，无需改派"），不再只靠 toast 缺席某句前端专属文案这种间接信号
 *   MUT6（补丁 AE·§4 候选①）撤去首次指派 siModalAssign 的 body.vendor_name = vn（:7116）→ T3v 的
 *       vendor 成功路径应判红（请求体缺 vendor_name 键∧后端 400 VENDOR_NAME_REQUIRED——该码文案与前端
 *       自身校验文案逐字相同，故判红须看请求体/状态码，不能看 toast）
 *   MUT7（补丁 AE·§4 候选②）撤去 siNotifyStatusesFor 的 config 分支（:1459）→ T12b 绑定受理人在
 *       「处理中」态应看不到开发通知按钮
 *   MUT8（补丁 AE·§4 候选③）撤去 siRenderTimeline 的 online_mode 展示分支（:4550）→ T6r 时间线不再
 *       显示"上线方式：加入上线单，按排期生效"
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const HTML_PATH = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;      // 平台管理员（username='admin'，siIsPlatformAdmin 白名单唯一成员）
const LIAISON_ID = 13;   // 示例对接人（SI_INTAKE_LIAISON_IDS[13]）
const DEV_ID = 8;        // 示例开发A（本地真实 active 非 viewer 账号，同既有多个 sys Playwright 脚本复用账号）
const SECOND_DEV_ID = 9; // 示例开发B（补丁 AD·AD5 用：T13①"只改成员"用例需要一个可加入的第二在册开发）
// [补丁 AF·AF1·512-H1] Date.now() 不是跨进程唯一标识（同毫秒并发会撞）——改时间戳+随机后缀，
// 跨进程碰撞概率降到可忽略（8 位 36 进制时间戳 + 8 位十六进制随机数，仅用于测试夹具所有权识别，
// 非密码学场景，crypto.randomBytes 只是借用其随机源，不追求密码学强度）。
const RUN_TAG = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
// [补丁 AF·AF1] 唯一标识统一落在 description 字段（所有建单路径——API 直调 4 处 + T1 UI 路径——都把
// 本标记写进 description；title 是否携带 RUN_TAG 不作为恢复登记的依据，只以 description 为准，
// 消除"API 建单标题带标识、T1 描述带标识"两个字段各写各的不一致）。
const RUN_TAG_MARKER = `[RT:${RUN_TAG}]`;
const TITLE_PREFIX = `[lt0907-s1c]`;   // 可识别标题前缀（spec 要求，便于观察数据清理）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
const failDetails = [];
function must(cond, msg) {
    if (cond) { console.log('  \u2705 ' + msg); pass++; }
    else { console.log('  \u274c ' + msg); fail++; failDetails.push(msg); }
    return cond;
}
// [补丁 AF·AF7-d·512 收紧建议] 角色/账号前置校验专用——失败时不能只记红继续跑，那样会在错误的账号
// 角色配置下（如 LIAISON_ID 意外变成 admin）产出一份看似全绿、实则前提就不成立的报告。命中失败立即
// 抛异常中止整个套件（此时尚在 main() 的 try 之外，异常会被文件末尾的顶层 catch 捕获并 exit(1)）。
function mustFatal(cond, msg) {
    if (!must(cond, msg)) {
        throw new Error(`[AF7-d fail-fast] \u524d\u7f6e\u6821\u9a8c\u5931\u8d25\uff0c\u7acb\u5373\u4e2d\u6b62\u5957\u4ef6\uff1a${msg}`);
    }
    return cond;
}
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(os.tmpdir(), 'sys-playwright-shots', `scf-fail-${name}.png`);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`     \ud83d\udcf8 \u5931\u8d25\u622a\u56fe: ${p}`); }
        catch (_) { /* \u622a\u56fe\u5931\u8d25\u4e0d\u5f71\u54cd\u4e3b\u6d41\u7a0b */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    // [补丁 AD·AD4·预筛 M2] 每条错误同时记录 text 与 url（url 取自 ConsoleMessage.location().url——
    // 实测确认 Chromium 对"Failed to load resource"这类网络级错误会把失败资源的 URL 放进
    // location().url，见诊断脚本 E:/tmp/lt0907-s1c-diag-console-loc 实测：TEXT 不含 URL 片段，但
    // LOCATION.url 精确等于该次请求的完整地址）——只有同时具备 URL 与状态码才能精确放行，不能只按
    // 状态码模糊匹配（那样会把 accept 的 ONLINE_MODE_REQUIRED、assign 的 EXEC_MODE_REQUIRED、submit
    // 的 CONFIG_NO_COMMITS 这些正是本批要证明"前端不会发错"的失败信号一并吞掉）。
    const consoleErrors = [];
    page.on('console', m => {
        if (m.type() === 'error') {
            const loc = m.location();
            consoleErrors.push({ text: m.text(), url: (loc && loc.url) || '' });
        }
    });
    page.on('pageerror', e => consoleErrors.push({ text: 'pageerror: ' + e.message, url: '' }));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成（同 test-sys-accept-
// evidence-playwright.js futureEstStr 既有范式，远期字面量迟早到期，勿回退此写法）。
function futureEstStr() {
    const d = new Date(Date.now() + 30 * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// [补丁 AD·AD4] 403 放行理由：Sys_Iteration.html:1005 明文登记的既有平台行为——页面初始化无条件调用
// GET /sys-issues/intake-liaisons（admin-only），非 admin 账号（本文件 T5/T10 用开发/受理人账号打开
// 详情页）必 403，siLoadIntakeLiaisons 对此静默容错（不清空/不报错，功能不受影响）。诊断脚本
// E:/tmp/lt0907-s1c-diag-403.js 已实测复现，与 config 改动无关（该行为在改动前已存在），故本文件
// 统一放行，不是本批新增噪音。**只放行这一个端点的 403**——按 URL 片段 + 状态码双重精确匹配，不再
// 用裸状态码正则模糊吞掉被测端点自身的 400/403/404/409（那些正是"前端不会发错"的证据信号）。
function filterExpectedConsoleErrors(errors) {
    return (errors || []).filter(e => !(/403/.test(e.text) && /\/sys-issues\/intake-liaisons(?:$|[?#])/.test(e.url)));
}

// [S1d·513 附带建议·AF7-c 加固] 判断 JSON.parse 结果是否为可安全参与 `in` 运算的非数组对象——
// 512 批的"ParseOk"判据只要求 `!== null`，若 postData 恰好是合法 JSON 原始值（数字/字符串/布尔），
// `parseOk` 会被判 true，随后 `'k' in value` 对基本类型抛 TypeError（`in` 运算左侧要求对象），把
// "请求体解析异常"误变成脚本自身未捕获异常崩溃整个套件，而不是该条断言按预期判红。数组虽不会让
// `in` 抛异常，但它不是本文件请求体的合法形状（JSON.stringify 的请求体恒为对象字面量），一并排除。
function isPlainObjectJson(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// [补丁 AF·AF2·512-H2 根治] 变异机制彻底改用 Playwright page.route——在**内存**里拦截该 page 对象
// 自身对 Sys_Iteration.html 的请求，对响应体做字符串替换后返回，完全不碰磁盘、不写共享文件。
// 路由作用域仅限注册它的这一个 page 对象（Playwright 路由表按 page 隔离），该 page 关闭后路由随之
// 失效，无需 unroute；不会影响同批运行中的其它 page，也不存在"进程被强杀时文件留在变异态"或
// "运行期间他人编辑被覆盖"这类共享文件才有的风险——AE4/AE5 那一整套"写盘前记快照+finally 恢复+
// 外层 catch 兜底覆盖"的机制随本函数引入而**整体删除**（不是加固，是换根本方案）。
// 用法：navigate 前先 `await routeMutatedIterationPage(page, marker, replacement)` 拿到 state，
// `.goto()`/`.reload()` 完成后读 `state.anchorFound` 判断锚点是否命中——未命中说明源码字面量已漂移，
// 路由会原样放行未修改的响应（不会静默把"锚点没找到"误当成"变异生效"）。
// [补丁 AF·AF4·512-M2] 命中次数必须**恰为 1**——多处命中时不弹层原样放行、`state.anchorAmbiguous=true`，
// 防止锚点字面量在未来漂移出现第二处巧合匹配时，`split/join` 把不相关的第二处也一并改写（那种情况
// 下"变异生效"的判红会失去唯一归因，可能是改了别处而非目标函数）。
// [S1d·513-M2 补丁] 从源文本里取出一个具名函数的完整函数体子串（花括号配平），供
// routeMutatedIterationPage 的 functionName 参数把锚点匹配限定在该函数体内——不再是"全文件恰一次"
// 就采信，而是"目标函数体内恰一次"才采信。找不到该函数声明或右花括号未配平（文件损坏/函数未闭合）
// 时返回 null，调用方按"函数体都定位不到"处理（原样放行，不生效变异）。
function extractFunctionBody(src, functionName) {
    const startMatch = src.match(new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`));
    if (!startMatch) return null;
    const bodyOpenIdx = startMatch.index + startMatch[0].length - 1;   // 指向那个开花括号
    let depth = 0;
    for (let i = bodyOpenIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return { start: startMatch.index, end: i + 1 };
        }
    }
    return null;   // 未找到匹配右括号
}
// [S1d·513-M2 根治] 新增可选 opts.functionName——变异锚点归因从"全文件恰一次出现"收紧为"目标函数体
// 内恰一次出现"。此前通用字面量（如 `if (type === 'config') {`）即便全文件命中一次也不能证明这一次
// 就落在目标函数（如 siNotifyStatusesFor）体内——字面量可能因未来重构漂移到别的函数，或原目标函数
// 被删后又巧合出现在别处同一行——全文件计数对这两种情形都无区分力。指定 functionName 后：先用括号
// 配平从 `function <functionName>(` 定位到该函数体的匹配右括号，marker 的出现次数统计与替换均限定
// 在这段子串内进行，函数体外的巧合命中不计入 occurrences、不参与替换；找不到该函数体时视同锚点未
// 命中（原样放行，state.functionScopeFound=false 供调用方精确报告"函数体都定位不到"这一失败模式）。
async function routeMutatedIterationPage(page, marker, replacement, opts = {}) {
    const { functionName } = opts;
    const state = { anchorFound: false, occurrences: 0, anchorAmbiguous: false, functionScopeFound: !functionName };
    await page.route('**/Sys_Iteration.html*', async route => {
        const response = await route.fetch();
        const original = await response.text();
        let searchSpace = original, scopeStart = 0, scopeEnd = original.length;
        if (functionName) {
            const fnRange = extractFunctionBody(original, functionName);
            if (!fnRange) {
                state.functionScopeFound = false;
                await route.fulfill({ response });   // 目标函数体都定位不到——原样放行，不生效变异
                return;
            }
            state.functionScopeFound = true;
            scopeStart = fnRange.start; scopeEnd = fnRange.end;
            searchSpace = original.slice(scopeStart, scopeEnd);
        }
        const occurrences = searchSpace.split(marker).length - 1;
        state.occurrences = occurrences;
        if (occurrences === 0) {
            await route.fulfill({ response });   // 锚点未命中——原样放行，不生效变异，不静默掩盖
            return;
        }
        if (occurrences > 1) {
            state.anchorAmbiguous = true;
            await route.fulfill({ response });   // 命中多处——同样原样放行，不做无归因保证的批量替换
            return;
        }
        state.anchorFound = true;
        const mutatedScope = searchSpace.split(marker).join(replacement);   // 此刻已确认恰一处，split/join 等价单次替换
        const mutated = functionName ? (original.slice(0, scopeStart) + mutatedScope + original.slice(scopeEnd)) : mutatedScope;
        await route.fulfill({ response, body: mutated });
    });
    return state;
}

// [S1d·513-M3 根治] clickAndCaptureNewToast 请求监听生命周期与 toast 检测方式重做——512 批
// （AF7-b）留了两个缺口：①"toast 数量一增加就摘牌"会让请求监听窗口比原来的固定 500ms 更短，
// "先弹提示、随后延迟发请求"这类回归仍会得出"零请求"的结论；②按**容器子节点总数**判断新 toast，
// 旧 toast 消失与新 toast 出现同时发生时总数可能不变，会漏认本次新增。改为两个独立职责的 helper：
//   watchIssueRequests(page, issueId, actionSegment)：请求监听生命周期完全交给调用场景——返回
//     { count, stop() }，调用方在**全部检查（toast/弹层/库值，覆盖已知异步提交延迟）都做完之后**
//     才调用 stop() 读最终计数；且匹配路径精确绑定 issueId（不再用裸 `\d+` 通配符接受任意单据的
//     同名请求，呼应"捕获本单"这句代码注释的字面含义）。
//   waitForNewToast(page, maxWaitMs)：改用**节点身份**判据——点击前把 #toast-container 现有子节点
//     全部打标记（data-pw-seen），点击后轮询查找一个"没有该标记"的新节点，不按总数差；旧 toast 消失
//     不影响新 toast 的识别。
function watchIssueRequests(page, issueId, actionSegment) {
    let count = 0;
    const pattern = new RegExp(`/api/sys-issues/${issueId}/${actionSegment}$`);
    const onReq = req => { if (req.method() === 'POST' && pattern.test(new URL(req.url()).pathname)) count++; };
    page.on('request', onReq);
    let stopped = false;
    return {
        get count() { return count; },
        stop() { if (!stopped) { stopped = true; page.off('request', onReq); } },
    };
}
// [S1d 实测踩坑修复] 标记步骤必须在点击**之前**执行——若把标记放进 waitForNewToast 内部并在点击
// 之后才调用，点击引发的 toast 可能在标记执行前就已经出现，标记会把它也一并计入"已存在"，导致
// 轮询永远找不到"未标记的新节点"（首次实现在此处栽过：4 条断言全部 toastAppeared=false，见
// E:/tmp/lt0907-s1d-pw-run1.log）。拆成 markExistingToasts（点击前调用）+ waitForNewToast（点击后
// 纯轮询，不再自带标记步骤）两步。
async function markExistingToasts(page) {
    // [S1d·补丁AI·AI5 根治·codex 514-M2] 原实现吞掉 page.evaluate 的异常——标记失败时（如页面已导航/
    // 已关闭）会静默当作"标记成功、当前无已存在 toast"处理，后续 waitForNewToast 可能把一条早已存在
    // 的旧提示误判成"新出现"。改为不吞，标记失败即向上抛出，让调用场景判失败（同既有"不确定就不能
    // 静默放行"取向），不能让"标记这一步是否真的生效"这件事本身变成不可观测的黑箱。
    await page.evaluate(() => {
        document.querySelectorAll('#toast-container > *').forEach(el => { el.dataset.pwSeen = '1'; });
    });
}
async function waitForNewToast(page, maxWaitMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const text = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('#toast-container > *')).find(n => !n.dataset.pwSeen);
            return el ? el.innerText : null;
        }).catch(() => null);
        if (text !== null) return { toastAppeared: true, toastText: text };
        await page.waitForTimeout(100);
    }
    return { toastAppeared: false, toastText: '' };
}
// [S1d·补丁AI·AI5 根治·codex 514-M2] 原 clickAndCaptureNewToast 仍在 toast 检测完成后固定多等
// postToastBufferMs=600ms 便自行 stop() 监听、把 reqCount 一并返回——调用方随后才检查弹层与库值，
// 这些检查全部发生在监听已经停止之后，提示出现超过 600ms 才发出的请求依旧漏检（只是把"toast 一
// 出现就摘牌"的窗口从"更短"挪成"600ms"，本质仍是固定常量窗口，不是"场景决定何时该停"）。
// 修法：彻底拆分职责——本函数只做"点击 + 检测新 toast"，不再代持请求监听生命周期；watch 对象改由
// 调用场景自己持有（watchIssueRequests），在场景真正完成**全部**已知检查（toast/弹层/库值）之后
// 才读 watch.count 并 stop()。[补丁AJ·AJ3/AJ4 订正措辞·codex 515-M3/M4] 观察窗口本身仍是一个
// 明确声明的**有限常量窗口**（600ms，见各调用点），不是"自适应到真正完成"——此前"不是任何固定
// 常量"这句表述过强，如实改为"窗口从『toast 检测后就停』挪到『toast+弹层+库值检查全部完成后再停』，
// 覆盖面更宽，但仍是有界观察期限，不是无界等待"。
async function clickAndAwaitNewToast(page, clickSelector, maxWaitMs = 3000) {
    await markExistingToasts(page);
    await page.click(clickSelector);
    return waitForNewToast(page, maxWaitMs);
}

// ── API 夹具（快速构造前置状态，UI 断言另在浏览器里真实操作）──────────────────────────────
let seq = 0;
// [补丁 AE·AE2] createdIds 提到模块作用域——各建单夹具函数在"建单响应校验成功后、任何后续动作之前"
//   立即登记，不再等待整条链（受理/指派/提交等）全部成功才登记，防止链路中途失败时该 id 未登记、
//   清理与残留核验都漏掉它却仍谎报"登记范围内零残留"（511-B H2）。main() 内不再重复声明。
const createdIds = [];
// [补丁 AF·AF3·512-M1] 统一登记入口——去重，防"建单函数已登记、调用点又 push 一次"导致
// createdIds.length 与实际创建条数不一致（512 指出"报告里的 65 条无法据此成立"）。全文件所有
// registerCreatedId(...) 调用点均已改走本函数（本批批量替换，非遗漏个例）。
function registerCreatedId(id) {
    if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id);
}
// [S1h·补丁 AQ·codex 524-M2 根治] 本套件此前只登记 issue，不登记**批次**。T15 首版把
//   `POST /sys-releases` 放在 try 之外、清理放在 finally 里，于是三条路径会留下孤儿批次：
//   ①服务端已建但响应丢失/JSON 解析失败/结构校验失败 → 压根进不了 try，finally 不执行；
//   ②finally 里 DELETE 自身网络异常 → 无恢复路径；③try 抛错时 finally 之后的 must 不执行，
//   「失败路径都由清理断言兜住」这句话不成立。
//   修法与 issue 侧同款：**取得 id 立即登记，确认删除后才注销**，收尾统一兜底清理并断言。
const createdReleaseIds = [];
function registerCreatedReleaseId(id) {
    if (Number.isInteger(id) && id > 0 && !createdReleaseIds.includes(id)) createdReleaseIds.push(id);
}
function unregisterCreatedReleaseId(id) {
    const i = createdReleaseIds.indexOf(id);
    if (i >= 0) createdReleaseIds.splice(i, 1);
}
// [补丁 AR·codex 525-M2 根治] 上一版的异常恢复是「创建后查一次、恰一条才登记」——三个漏洞：
//   ①响应丢失时**查询可能早于服务端提交**而命中零条 ②命中多条或查询自身失败时没有任何待恢复线索
//   进入全局清理 ③随后 `createdReleaseIds` 为空，收尾照样报「无孤儿」。
//   改为**创建前先登记待恢复标记**（tag 恒先落登记表，再发请求）：拿到 id 后把 tag 解析掉；
//   拿不到 id 时 tag 留在表里，由收尾做**有界重查**（间隔重试，覆盖"查早了"这一时序）。
//   未解析的 tag 与未删除的 id **都必须让收尾判红**，不允许静默。
const pendingReleaseTags = [];
function registerPendingReleaseTag(tag) {
    if (tag && !pendingReleaseTags.includes(tag)) pendingReleaseTags.push(tag);
}
function resolvePendingReleaseTag(tag) {
    const i = pendingReleaseTags.indexOf(tag);
    if (i >= 0) pendingReleaseTags.splice(i, 1);
}
// [S1d·513-M1 根治] 建单响应异常恢复——四条 API 建单路径（apiCreateConfig/mkBugVerify/
// mkImprovementVerify/T14 improvement 对照）此前统一在"响应 JSON 解析 + 状态码/id 结构校验成功"
// 之后才 registerCreatedId：一旦后端已建单但响应丢失/JSON 损坏/id 字段变化（网络抖动/中间层截断
// 等），该次调用会直接抛异常且**遗漏该夹具的所有权登记**——finally 清理只查 createdIds，会打印
// 「零残留」而实际库里多出一条未登记的行。且此前所有夹具共享同一 RUN_TAG_MARKER，即便想按标记
// 恢复也无法唯一定位是"这一次"建的哪一条。
// 修法：每次建单调用 nextFixtureMarker() 生成一个**独立**于 RUN_TAG_MARKER 的夹具标记，随
// description 一并落库（RUN_TAG_MARKER 仍保留在同一字段里，供收尾按运行标记做整体扫描，见
// finally 块新增的"未登记残留"扫描）；响应正常（201 ∧ JSON 解析成功 ∧ id 为正整数）时按响应 id
// 登记；响应异常时改按这枚独立标记查询主表——**恰一条且类型匹配**才登记，否则不静默吞掉，明确
// 抛出"未确认夹具"异常（不登记任何不确定所有权的行，与 T1 的 AF1 硬门同一保守取向）。
let fixtureSeq = 0;
function nextFixtureMarker() {
    fixtureSeq++;
    return `[FX${RUN_TAG}-${fixtureSeq}]`;
}
// [S1d·补丁AI·AI4→补丁AJ·AJ2 根治·codex 515-M2] "客户端连接先断、服务端稍后才提交"这条时序覆盖，
// codex 515 指出 AI4 版本有两处口径问题：① 只在"轮询彻底耗尽"之后才 push 进登记集合——正常响应后
// dbGet 抛异常、恢复阶段 dbAll 抛异常、多条命中歧义这三种情况完全不登记，报告称"发送前登记"名不
// 副实；② "5×200ms"实为 4 次 sleep=800ms（不含首末两次查询自身耗时），不是声称的 1000ms。
// 修法：轮询期限改用**截止时间**定义（`Date.now()+windowMs`），措辞按实际时长表述；登记时机挪到
// `createIssueWithRecovery` 的**第一行**（发送请求之前），只有核验并登记成功才移除，查询异常/歧义/
// 超时全部**保留** pending 状态（不静默移除也不静默跳过）。
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const POLL_WINDOW_MS = 1000;
const POLL_INTERVAL_MS = 100;
// 返回一个判别式结果对象而非裸 id/null/undefined——四种结局（命中/歧义/查询异常/超时）互不相同，
// 调用方需要分别处理，裸返回值的三态编码（AI4 版本）已经无法再塞进第四种"查询异常"而不引入歧义。
async function pollForFixtureOwnership(fixtureMarker, type, windowMs = POLL_WINDOW_MS, intervalMs = POLL_INTERVAL_MS) {
    const deadline = Date.now() + windowMs;
    let lastQueryErr = null;
    while (Date.now() < deadline) {
        try {
            const rows = await dbAll(`SELECT id, type FROM sys_issues WHERE description LIKE ?`, [`%${fixtureMarker}%`]);
            lastQueryErr = null;
            if (rows.length === 1 && rows[0].type === type) return { outcome: 'found', id: rows[0].id };
            if (rows.length > 1) return { outcome: 'ambiguous', rows };
        } catch (e) {
            lastQueryErr = e;   // 查询本身异常——不等同"未找到"，继续在截止时间内重试，最后一次异常留痕上报
        }
        if (Date.now() < deadline) await sleep(intervalMs);
    }
    return lastQueryErr ? { outcome: 'query_error', error: lastQueryErr } : { outcome: 'timeout' };
}
// [S1d·补丁AJ·AJ2] 待确认夹具登记表——Map<fixtureMarker, {type, errLabel, registeredAt, lastError}>。
// 发送请求前登记；核验成功（claimedOk 或轮询恰命中一条）才移除。收尾（finally 块）对仍在此集合里的
// 每一项做最终查询，**显式计入失败**（不是只打印），且不输出"零残留"这种更强的整体保证，只报告
// 扫描时点的实际查询结果——见 finally 块 AJ2 段。
const pendingFixtures = new Map();
async function createIssueWithRecovery(adminTok, type, bodyFields, fixtureMarker, errLabel) {
    // [S1d·补丁AJ·AJ2] 发送前登记——本函数的第一行动作，早于任何网络 I/O。
    pendingFixtures.set(fixtureMarker, { type, errLabel, registeredAt: Date.now(), lastError: null });
    // [S1d·AH2 根治·Opus 预筛 H2] 原实现 `await fetch(...)` 裸调用（无 try）——codex 513-M1 点名的
    // 「后端已建单但响应丢失」（连接重置/socket hang up/代理截断）会让本行直接 reject，函数在第一行
    // 就抛出，下方按独立标记恢复的分支根本进不去（fixtureMarker 查询一次都不会跑）。这是本文件报告
    // 曾声称"513-M1 全部处置完成"里唯一没覆盖到的失败形态。改为 fetch 本身也纳入恢复判定：网络层
    // 拒绝（reject）与"响应到手但状态码/JSON/id 不对"统一走同一条独立标记恢复分支，不再区别对待。
    let r = null, netErr = null;
    try {
        r = await fetch(`${BASE_URL}/api/sys-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(bodyFields) });
    } catch (e) {
        netErr = e;   // fetch 直接 reject（网络层拒绝）——r 保持 null，下方统一走恢复分支
    }
    let respBody = null, parseOk = false;
    if (r) { try { respBody = await r.json(); parseOk = true; } catch (_) { /* 解析失败——parseOk 保持 false，走下方恢复分支 */ } }
    let claimReject = null;   // 仅用于恢复分支的诊断日志，不影响判据本身
    if (r && r.status === 201 && parseOk && Number.isInteger(respBody && respBody.id) && respBody.id > 0) {
        // [S1d·补丁AI·AI1 根治·codex 514-H1] 正常响应分支此前直接信任 body.id——若后端实际建了新
        // 夹具 A，但返回的 201 响应体携带的是某张既有业务单 B 的合法正整数 id（响应体错配/网关截断
        // 等极端情形），旧实现会直接登记 B：后续业务推进与 finally 清理都会作用于 B，而按运行标记
        // 全表扫描只能发现"A 未登记"，拦不住"B 被误删"。改为：正常响应也必须查库核对该 id 对应行是否
        // 同时满足「独立标记 fixtureMarker ∧ 运行标记 RUN_TAG_MARKER ∧ 预期 type」三者全中，全中才
        // 登记；任一不中，视同响应异常，**只允许**落入下方与"响应到手但状态码/JSON/id 不对"完全相同
        // 的独立标记恢复分支（不额外分叉出第二套恢复逻辑），避免误登记/误删既有单。
        let claimedRow = null, claimQueryErr = null;
        try {
            claimedRow = await dbGet(`SELECT id, type, description FROM sys_issues WHERE id=?`, [respBody.id]);
        } catch (e) {
            claimQueryErr = e;
        }
        if (claimQueryErr) {
            // [S1d·补丁AJ·AJ2] 核对查询本身异常——不能视为"核对失败=按恢复分支处理"（那会把数据库
            // 层面的真实故障悄悄消化掉），也不能视为"核对通过"，保留 pending，明确抛出查询异常本身。
            const pending = pendingFixtures.get(fixtureMarker);
            if (pending) pending.lastError = `claim 查询异常：${claimQueryErr.message}`;
            throw new Error(`[夹具-${errLabel}][AJ2 claim查询异常] 核对响应 id=${respBody.id} 时数据库查询抛出异常，无法判定所有权，已保留在 pendingFixtures：${claimQueryErr.message}`);
        }
        const claimedOk = !!claimedRow
            && claimedRow.type === type
            && typeof claimedRow.description === 'string'
            && claimedRow.description.includes(fixtureMarker)
            && claimedRow.description.includes(RUN_TAG_MARKER);
        if (claimedOk) {
            registerCreatedId(respBody.id);
            pendingFixtures.delete(fixtureMarker);   // 核验通过——移出待确认集合
            return respBody.id;
        }
        claimReject = claimedRow;
        console.warn(`[AI1 正常响应核对失败] ${errLabel} 响应 id=${respBody.id} 未通过三要素核对（独立标记∧运行标记∧类型全中才登记），疑似响应体携带了其它单据的 id，不登记该 id，改按独立标记 ${fixtureMarker} 恢复所有权。行核对结果=${JSON.stringify(claimedRow)}`);
        // 不 return——落入下方与"响应异常"完全相同的独立标记恢复分支
    }
    const statusLabel = r ? r.status : `NETWORK_ERROR(${netErr && netErr.message})`;
    const anomalyLabel = claimReject ? `响应到手且状态码/JSON均正常但 id 核对未过三要素（疑似响应体携带了其它单据的 id）` : `建单响应异常`;
    console.warn(`[513-M1/AI1 恢复] ${errLabel} ${anomalyLabel}（status=${statusLabel}, parseOk=${parseOk}, body=${JSON.stringify(respBody)}），尝试按独立标记 ${fixtureMarker} 恢复所有权（有界轮询，截止时间定义，约 ${POLL_WINDOW_MS}ms）`);
    const pollResult = await pollForFixtureOwnership(fixtureMarker, type);
    if (pollResult.outcome === 'found') {
        registerCreatedId(pollResult.id);
        pendingFixtures.delete(fixtureMarker);
        console.warn(`[513-M1 响应异常恢复] ${errLabel} 按独立标记恢复成功：id=${pollResult.id}（已登记）`);
        return pollResult.id;
    }
    if (pollResult.outcome === 'ambiguous') {
        const pending = pendingFixtures.get(fixtureMarker);
        if (pending) pending.lastError = `独立标记命中多条：${JSON.stringify(pollResult.rows)}`;
        throw new Error(`[夹具-${errLabel}] 响应异常且独立标记查询命中多条（所有权歧义，不登记任何行，已保留在 pendingFixtures）：status=${statusLabel}, parseOk=${parseOk}, marker=${fixtureMarker}, 候选=${JSON.stringify(pollResult.rows)}`);
    }
    if (pollResult.outcome === 'query_error') {
        const pending = pendingFixtures.get(fixtureMarker);
        if (pending) pending.lastError = `轮询查询异常：${pollResult.error.message}`;
        throw new Error(`[夹具-${errLabel}][AJ2 轮询查询异常] 独立标记恢复阶段数据库查询在整个截止时间窗口内持续异常，无法判定所有权，已保留在 pendingFixtures（最后一次异常：${pollResult.error.message}）：marker=${fixtureMarker}`);
    }
    // pollResult.outcome === 'timeout'：截止时间已到仍未查到匹配行——明确报告"所有权未确认"，不是
    // "确认不存在"（服务端仍可能在窗口之后才真正提交）。已保留在 pendingFixtures 供收尾统一核对。
    throw new Error(`[夹具-${errLabel}][AJ2 所有权未确认] 独立标记 ${fixtureMarker} 在有界轮询窗口（截止时间定义，约 ${POLL_WINDOW_MS}ms）内未查到匹配行——这不代表最终不会提交成功，只是本次调用在该窗口内无法确认所有权，故不登记任何行；已保留在 pendingFixtures 供收尾统一核对：status=${statusLabel}, parseOk=${parseOk}, marker=${fixtureMarker}`);
}
async function apiCreateConfig(adminTok, suffix) {
    seq++;
    const fixtureMarker = nextFixtureMarker();
    return createIssueWithRecovery(adminTok, 'config', {
        intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-${suffix}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部',
        // [补丁 AF·AF1，S1d·513-M1] description 统一携带 RUN_TAG_MARKER（供收尾整体扫描）+ 本次
        // 独立 fixtureMarker（供响应异常时精确恢复）——与 T1 UI 路径同一存放字段。
        description: `config 流前端 Playwright 冒烟夹具 ${RUN_TAG_MARKER}${fixtureMarker}`,
        intake_liaison_id: LIAISON_ID,
        // [补丁 AE·AE7] 补 requester_phone——业务方通知通道按钮须「有手机号」才渲染（无号只显"无手机号，
        // 无法通知"提示，非按钮），T12b 的权限断言需要该按钮真实存在才有判别力。
        requester_phone: '13800000001',
    }, fixtureMarker, '建单');
}
async function apiIntakeAccept(adminTok, id, riskLevel) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ risk_level: riskLevel }) });
    if (r.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiAssignConfig(adminTok, id, execMode, vendorName) {
    const body = { assigned_to: DEV_ID, exec_mode: execMode };
    if (vendorName) body.vendor_name = vendorName;
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSubmitNoCode(devTok, id, reason) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true }),
    });
    const body = await r.json();
    if (r.status !== 200) throw new Error(`[夹具-提交] 应 200，实得 ${r.status} ${JSON.stringify(body)}`);
    return body;
}
// config 单：待受理 态
async function mkConfigPending(adminTok, suffix) {
    return apiCreateConfig(adminTok, suffix);
}
// config 单：待处理 态（已受理，风险等级已判）
async function mkConfigToPending2(adminTok, suffix, riskLevel) {
    const id = await apiCreateConfig(adminTok, suffix);
    await apiIntakeAccept(adminTok, id, riskLevel || '二级');
    return id;
}
// config 单：处理中 态（已指派，exec_mode 可指定）
async function mkConfigProcessing(adminTok, suffix, execMode, vendorName) {
    const id = await mkConfigToPending2(adminTok, suffix, '二级');
    await apiAssignConfig(adminTok, id, execMode || 'assigned', vendorName);
    return id;
}
// config 单：待验证 态（已提交 no_code）
async function mkConfigVerify(adminTok, devTok, suffix) {
    const id = await mkConfigProcessing(adminTok, suffix, 'self');
    const body = await apiSubmitNoCode(devTok, id, 'API 夹具：配置内容与验证结果说明，长度已过 10 码点');
    if (body.main_status !== '待验证') throw new Error(`[夹具-提交] main_status 应为「待验证」，实得 ${body.main_status}`);
    return id;
}
// [补丁 AC·AC1] config 单：待上线 态（验收通过走 release 分支，不挂批次）——供 hotfixBtn 可见性用例复用。
async function mkConfigPreRelease(adminTok, devTok, suffix) {
    const id = await mkConfigVerify(adminTok, devTok, suffix);
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ online_mode: 'release' }) });
    const body = await r.json();
    if (r.status !== 200 || body.status !== '待上线') throw new Error(`[夹具-验收 release] 应 200∧status=待上线，实得 ${r.status} ${JSON.stringify(body)}`);
    return id;
}
// [S1h·T15 对照组] improvement 单：待上线 态——供「加单候选」用例做既有可发布类型的对照，
//   证明放开 config 不是把整个 type 过滤删坏成「谁都进不来」。improvement 的 accept 不带
//   online_mode（那是 config 专属契约，非 config 携带该字段后端 400 ONLINE_MODE_NOT_APPLICABLE）。
async function mkImprovementPreRelease(adminTok, devTok, suffix) {
    const id = await mkImprovementVerify(adminTok, devTok, suffix);
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({}) });
    const body = await r.json();
    if (r.status !== 200 || body.status !== '待上线') throw new Error(`[夹具-improvement 验收] 应 200∧status=待上线，实得 ${r.status} ${JSON.stringify(body)}`);
    return id;
}
async function mkBugVerify(adminTok, devTok, suffix) {
    seq++;
    // [S1d·513-M1] 建单步骤改走 createIssueWithRecovery——响应异常时按独立标记恢复，不再直接抛异常
    // 遗漏登记。
    const fixtureMarker = nextFixtureMarker();
    const id = await createIssueWithRecovery(adminTok, 'bug', {
        intake_contract_version: 2, type: 'bug', title: `${TITLE_PREFIX}-${suffix}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部', description: `bug 对照组夹具 ${RUN_TAG_MARKER}${fixtureMarker}`, intake_liaison_id: LIAISON_ID,
    }, fixtureMarker, 'bug建单');
    await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
    await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: DEV_ID }) });
    const submitR = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', self_tested: true, test_env_deployed: true, bug_cause_note: 'PW 对照组：bug 产生原因', commits: [{ component: 'backend', commit_ref: `pw-cfg-bug-${id}` }] }),
    });
    const submitBody = await submitR.json();
    if (submitBody.main_status !== '待验证') throw new Error(`[夹具-bug 提交] main_status 应为「待验证」，实得 ${submitBody.main_status}`);
    return id;
}
async function mkImprovementVerify(adminTok, devTok, suffix) {
    seq++;
    // [S1d·513-M1] 同 mkBugVerify——建单步骤改走 createIssueWithRecovery。
    const fixtureMarker = nextFixtureMarker();
    const id = await createIssueWithRecovery(adminTok, 'improvement', {
        intake_contract_version: 2, type: 'improvement', title: `${TITLE_PREFIX}-${suffix}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部', description: `improvement 对照组夹具 ${RUN_TAG_MARKER}${fixtureMarker}`, intake_liaison_id: LIAISON_ID,
    }, fixtureMarker, 'improvement建单');
    await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ risk_level: '二级' }) });
    // R4 守卫（变更流专属）：指派开发前须先补 OA 立项号，否则 assign 409（同 test-sys-accept-evidence-
    // playwright.js mkImprovementToVerify 既有范式）。
    const oaR = await fetch(`${BASE_URL}/api/sys-issues/${id}/set-oa-number`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ oa_number: String(20260907200 + seq) }) });
    if (oaR.status !== 200) throw new Error(`[夹具-improvement OA号] 应 200，实得 ${oaR.status} ${JSON.stringify(await oaR.json().catch(() => null))}`);
    const assignR = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: DEV_ID }) });
    if (assignR.status !== 200) throw new Error(`[夹具-improvement 指派] 应 200，实得 ${assignR.status} ${JSON.stringify(await assignR.json().catch(() => null))}`);
    // C7 工期闸（siEffortGateBlocked 前端镜像同款）：feature/improvement 的 submit 前须回填工期（人日），
    // 否则 EFFORT_REQUIRED 400（config/bug 无此维度，不受影响）。
    const estR = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr(), estimated_effort_days: 1 }) });
    if (estR.status !== 200) throw new Error(`[夹具-improvement 估时] 应 200，实得 ${estR.status} ${JSON.stringify(await estR.json().catch(() => null))}`);
    const submitR = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: `pw-cfg-imp-${id}` }], self_tested: true, test_env_deployed: true }),
    });
    const submitBody = await submitR.json();
    if (submitBody.main_status !== '待验证') throw new Error(`[夹具-improvement 提交] main_status 应为「待验证」，实得 ${submitBody.main_status}（响应体=${JSON.stringify(submitBody)}）`);
    return id;
}

function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时（${timeoutMs}ms）——server 未就绪或响应异常`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js 再跑本文件`)); });
    });
}
async function ensureAppReadinessEndpoint() {
    const r = await fetch(`${BASE_URL}/api/sys-issues/_readiness`).catch((e) => {
        throw new Error(`应用 readiness 探测请求失败（${e.message}）——端口监听者可能不是目标 server.js`);
    });
    if (r.status !== 401) {
        throw new Error(`应用 readiness 探测异常：期望 401，实得 ${r.status}——监听该端口的可能不是目标 server.js（孤儿进程/端口被其它服务占用）`);
    }
}

// ── 静态源码扫描：「已生效」不应出现在任何功能性字面量里（排除注释/无关短语）──────────────
function staticCheckNoEffectedAlias() {
    const src = fs.readFileSync(HTML_PATH, 'utf8');
    // SI_STATUS_CLASS：不应含 '已生效' 键
    const statusClassMatch = src.match(/const SI_STATUS_CLASS = \{([\s\S]*?)\n    \};/);
    must(!!statusClassMatch, '[静态] 能提取 SI_STATUS_CLASS 字面量（锚点漂移时先红）');
    if (statusClassMatch) must(!statusClassMatch[1].includes("'已生效'"), '[静态] SI_STATUS_CLASS 不含 \'已生效\' 键');
    // SI_STATUS_GROUPS.pending_archive：不应含 '已生效'
    const groupsMatch = src.match(/pending_archive:\s*\[([^\]]*)\]/);
    must(!!groupsMatch, '[静态] 能提取 SI_STATUS_GROUPS.pending_archive 字面量（锚点漂移时先红）');
    if (groupsMatch) must(!groupsMatch[1].includes('已生效'), '[静态] SI_STATUS_GROUPS.pending_archive 不含 \'已生效\'');
    // SI_TL_LABEL：不应含 effected: 词条
    must(!/effected:\s*'已生效'/.test(src), '[静态] SI_TL_LABEL 不含 effected: \'已生效\' 词条');
    must(!/\beffected:\s*'si-tl-green'/.test(src), '[静态] SI_TL_CLS 不含 effected: \'si-tl-green\' 词条');
}

async function main() {
    await ensureServerListening();
    console.log('  \u2705 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  \u2705 应用 readiness 端点探测通过（确认监听者是目标 server.js）');
    console.log('\n══════ 系统迭代 · config 流激活 · 前端 Playwright 冒烟（S1c）══════');

    console.log('\n── [静态] 「已生效」预留态不再出现在功能性字面量 ──');
    staticCheckNoEffectedAlias();

    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const liaisonTok = await signAs(LIAISON_ID);

    // ── [补丁 AE·AE11] 启动前置断言——角色/账号有效性/对接人绑定关系不是"跑起来才发现测错账号" ──
    console.log('\n── [前置] 账号角色/有效性/对接人候选核验 ──');
    const devUserRow = await dbGet('SELECT id, role, status FROM users WHERE id=?', [DEV_ID]);
    mustFatal(!!devUserRow && devUserRow.role !== 'admin' && devUserRow.status === 'active', `前置校验：DEV_ID=${DEV_ID} 账号存在 ∧ role≠admin ∧ status=active（实得=${JSON.stringify(devUserRow)}）`);
    const secondDevUserRow = await dbGet('SELECT id, role, status FROM users WHERE id=?', [SECOND_DEV_ID]);
    mustFatal(!!secondDevUserRow && secondDevUserRow.role !== 'admin' && secondDevUserRow.status === 'active', `前置校验：SECOND_DEV_ID=${SECOND_DEV_ID} 账号存在 ∧ role≠admin ∧ status=active（实得=${JSON.stringify(secondDevUserRow)}）`);
    const liaisonUserRow = await dbGet('SELECT id, role, status FROM users WHERE id=?', [LIAISON_ID]);
    // [补丁 AF·AF5·512-M3] role≠admin 是关键前置——T12b 用 LIAISON_ID 的"绑定受理人"身份证明正向权限
    // 来自 canOperate 里的 isSiBoundLiaison 分支，而非 isAdminUser 分支；若 LIAISON_ID 本身恰好也是
    // admin，正向按钮可见会被 admin 权限兜底满足，观测到的"绑定受理人能操作"这条结论就不成立。
    mustFatal(!!liaisonUserRow && liaisonUserRow.status === 'active' && liaisonUserRow.role !== 'admin', `前置校验：LIAISON_ID=${LIAISON_ID} 账号存在 ∧ status=active ∧ role≠admin（实得=${JSON.stringify(liaisonUserRow)}）`);
    const intakeLiaisonsResp = await fetch(`${BASE_URL}/api/sys-issues/intake-liaisons`, { headers: jsonHeaders(adminTok) });
    const intakeLiaisonsBody = await intakeLiaisonsResp.json().catch(() => null);
    const intakeLiaisonIds = (intakeLiaisonsBody && Array.isArray(intakeLiaisonsBody.items)) ? intakeLiaisonsBody.items.map(x => Number(x.id)) : [];
    mustFatal(intakeLiaisonsResp.status === 200 && intakeLiaisonIds.includes(LIAISON_ID), `前置校验：LIAISON_ID=${LIAISON_ID} 确在后端对接人候选名单内（实得候选=${JSON.stringify(intakeLiaisonIds)}）`);

    // [补丁 AF·AF2·512-H2 根治] AE4 曾在此捕获 HTML_ORIGINAL_SRC 供收尾逐字节比对——本批变异机制
    // 整体改用 page.route 内存拦截（见 routeMutatedIterationPage 定义处），MUT1-8 全程不再写磁盘，
    // 这份快照+比对+外层 catch 强制覆盖的整套逻辑随之**整体删除**（不是加固，是换根本方案）。
    // AF2 自验改为外部核对：运行前后对 `git diff --stat -- wbs-server/public/Sys_Iteration.html`
    // 两次输出应完全一致（该文件此后全程只被 staticCheckNoEffectedAlias 只读扫描一次，从不写入）。

    // [补丁 AE·AE2] 声明于 try 之外——供 finally 块内对"故意指派失败"夹具做专项残留核验。
    let idAe2 = null;
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：admin 建单弹层——类型下拉含「配置变更」+ 对接人必选 + UI 建单成功
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T1：建单弹层「配置变更」+ 对接人必选 ──');
        // [补丁 AE·AE1·511-B H1，补丁 AF·AF1·512-H1 根治] AD2 的 `id > baseMaxId` 水位守卫只排除历史
        // 行，**并发新建或 UI 建单失败时仍可能捞到别人的单**。AE1 曾改为"响应 id + RUN_TAG 双证"，但
        // 512 指出核验仍是**软断言**——shotOnFail 不抛异常，后面 `if (latestConfig) push` 照样无条件
        // 登记，双证形同虚设。本批改为**真正的硬门**：
        //   ① 点「确认」之前注册 waitForResponse 拦截 POST /api/sys-issues，校验 201 并取响应体 id，
        //      同时核对**请求体**里的 description 已含本轮标识（不只核响应，AF1 新增）；
        //   ② 恢复查询改 dbAll，显式分支处理"零条／恰一条／多条"（AF1 新增，多条=歧义，不登记）；
        //   ③ **硬性门控**：只有"类型=config ∧ description 含本轮精确标识 ∧ 恰命中一条"全部成立，
        //      才允许 registerCreatedId；不满足时**明确不登记、也不在此处做任何删除**——宁可留一条
        //      测试脏数据，也不能删掉一个所有权不确定的行（防误删并发/历史数据）。
        const page1 = await loginPage(browser, adminTok);
        await page1.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page1.waitForLoadState('networkidle');
        await page1.waitForTimeout(700);
        await page1.click('button:has-text("+ 新建迭代单")');
        await page1.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page1.waitForTimeout(200);
        const typeOptTexts = await page1.locator('#siMBody select#f_type option').allTextContents().catch(async () => {
            // fSelectMap 生成的 select id 未必是 f_type，退化用第一个 select
            return page1.locator('#siMBody select').first().locator('option').allTextContents();
        });
        await shotOnFail(page1, typeOptTexts.some(t => t.includes('配置变更')), 't1-type-option', `建单类型下拉含「配置变更」（实得选项=${JSON.stringify(typeOptTexts)}）`);
        // 选中 config 类型
        const typeSelect = page1.locator('#siMBody select').first();
        await typeSelect.selectOption('config');
        await page1.waitForTimeout(100);
        // 描述必填 + 对接人必填——留空对接人，其余填齐，提交应被前端拦（toast + 弹窗不关）
        // [补丁 AE·AE1] 描述里嵌入本轮唯一标识——标题由描述首行自动截取生成（无独立标题输入框，见
        //   siOpenCreate 弹层字段·:8409），故 RUN_TAG 只能靠 description 传递，回读时按它核对所有权。
        await page1.fill('#siMBody textarea', `Playwright T1 探针：config 建单流程测试 ${RUN_TAG_MARKER}`);
        await page1.click('#siMConfirm');
        await page1.waitForTimeout(400);
        const toastAfterNoLiaison = await page1.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page1, /对接人必填/.test(toastAfterNoLiaison || ''), 't1-liaison-required-toast', `未选对接人提交应报"对接人必填"（实得="${toastAfterNoLiaison}"）`);
        const modalStillOpenT1 = await page1.locator('#siModalOverlay.open').count();
        await shotOnFail(page1, modalStillOpenT1 === 1, 't1-modal-stays-open', '对接人未填时弹窗仍打开（未提交成功）');
        // 补选对接人后提交成功
        const liaisonSelect = page1.locator('#siMBody select').filter({ hasText: /示例对接人|请选择对接人|对接人/ }).first();
        // 更稳妥：直接找 name/id 含 liaison 的 select（siIntakeLiaisonFieldHtml 具体结构未知，退化按 select 全集逐个尝试选中示例对接人）
        const allSelects = page1.locator('#siMBody select');
        const selCount = await allSelects.count();
        let liaisonSet = false;
        for (let i = 0; i < selCount; i++) {
            const sel = allSelects.nth(i);
            const opts = await sel.locator('option').allTextContents();
            if (opts.some(o => o.includes('示例对接人'))) {
                await sel.selectOption({ label: opts.find(o => o.includes('示例对接人')) });
                liaisonSet = true;
                break;
            }
        }
        await shotOnFail(page1, liaisonSet, 't1-liaison-select-found', '能在建单弹层定位到含「示例对接人」选项的对接人下拉');
        // [补丁 AE·AE1] 点「确认」之前注册响应拦截——响应体 id 是唯一权威所有权证据，不依赖水位。
        const t1CreateRespPromise = page1.waitForResponse(
            r => /\/api\/sys-issues$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
            { timeout: 8000 }
        ).catch(() => null);
        await page1.click('#siMConfirm');
        const t1CreateResp = await t1CreateRespPromise;
        await page1.waitForTimeout(800);
        const modalClosedT1 = await page1.locator('#siModalOverlay.open').count();
        await shotOnFail(page1, modalClosedT1 === 0, 't1-modal-closed', '补选对接人后建单提交成功，弹窗关闭');
        let t1CreatedId = null;
        let t1RequestDescMatches = false;
        if (t1CreateResp) {
            const t1CreateStatus = t1CreateResp.status();
            await shotOnFail(page1, t1CreateStatus === 201, 't1-create-response-status', `建单 POST /api/sys-issues 响应 status=201（实得 ${t1CreateStatus}）`);
            if (t1CreateStatus === 201) {
                const t1CreateRespBody = await t1CreateResp.json().catch(() => null);
                t1CreatedId = (t1CreateRespBody && Number.isInteger(t1CreateRespBody.id) && t1CreateRespBody.id > 0) ? t1CreateRespBody.id : null;
                await shotOnFail(page1, !!t1CreatedId, 't1-create-response-id', `建单响应体含正整数 id（实得=${JSON.stringify(t1CreateRespBody)}）`);
                // [补丁 AF·AF1] 响应匹配时同时核对**请求体**里的本轮描述标识——不只核响应，防"响应恰好
                // 命中一个 id 但其实是另一次并发请求的响应"这类极端场景（本项目单浏览器单页顺序执行
                // 理论上不会发生，仍作为纵深防御）。
                let t1ReqBody = null;
                try { t1ReqBody = JSON.parse(t1CreateResp.request().postData() || '{}'); } catch (_) { /* 解析失败按不匹配处理，下方 !! 判红 */ }
                t1RequestDescMatches = !!t1ReqBody && typeof t1ReqBody.description === 'string' && t1ReqBody.description.includes(RUN_TAG_MARKER);
                await shotOnFail(page1, t1RequestDescMatches, 't1-request-desc-match', `建单请求体 description 含本轮唯一标识 ${RUN_TAG_MARKER}（实得=${JSON.stringify(t1ReqBody)}）`);
            }
        } else {
            must(false, 'T1 建单 POST 响应未捕获到（waitForResponse 超时）——转入 RUN_TAG 兜底核对，不使用 MAX(id) 水位');
        }
        // [补丁 AF·AF1·512-H1] 硬门第一步——响应 id ∧ 请求体描述均确认时按 id 精确查；否则**唯一允许
        // 的兜底**＝按本轮标识匹配 description（不再用 MAX(id) 水位）。dbAll 显式取全部命中行，不用
        // dbGet 隐式吞掉"零条/多条"的区别。
        let t1Candidates = [];
        if (t1CreatedId && t1RequestDescMatches) {
            t1Candidates = await dbAll(`SELECT id, type, status, intake_liaison_id, description FROM sys_issues WHERE id=?`, [t1CreatedId]);
        } else {
            t1Candidates = await dbAll(`SELECT id, type, status, intake_liaison_id, description FROM sys_issues WHERE type='config' AND description LIKE ?`, [`%${RUN_TAG_MARKER}%`]);
        }
        const t1MatchCount = t1Candidates.length;
        await shotOnFail(page1, t1MatchCount === 1, 't1-ownership-exact-one', `所有权核验命中恰一条记录（实得 ${t1MatchCount} 条${t1MatchCount === 0 ? '——零条，建单可能未落库或标识不匹配' : (t1MatchCount > 1 ? '——多条，存在歧义' : '')}）`);
        const latestConfig = t1MatchCount === 1 ? t1Candidates[0] : null;
        // [硬门] 类型正确 ∧ 描述含本轮精确标识 ∧ 恰命中一条——三者皆真才允许登记；任一不满足则**禁止
        // 登记，且本处不做任何删除**（不确定所有权时留脏数据比误删更安全）。
        const t1OwnershipConfirmed = !!latestConfig && latestConfig.type === 'config' && String(latestConfig.description || '').includes(RUN_TAG_MARKER);
        await shotOnFail(page1, t1OwnershipConfirmed, 't1-run-tag-match', `落库记录类型=config ∧ description 含本轮唯一标识 ${RUN_TAG_MARKER}（实得=${JSON.stringify(latestConfig)}）`);
        if (t1OwnershipConfirmed) {
            await shotOnFail(page1, latestConfig.status === '待受理' && Number(latestConfig.intake_liaison_id) === LIAISON_ID, 't1-db-created', `库内新建 config 单 status=待受理 ∧ intake_liaison_id=${LIAISON_ID}（实得=${JSON.stringify(latestConfig)}）`);
            registerCreatedId(latestConfig.id);   // 硬门全部通过后才登记——不通过绝不登记
        } else {
            must(false, '[AF1 硬门] 所有权核验未通过——不登记（不删除任何行，即便留下测试脏数据）；需人工核实 T1 建单流程是否有回归');
        }
        const t1Errors = filterExpectedConsoleErrors(page1._consoleErrors);
        await shotOnFail(page1, t1Errors.length === 0, 't1-console-clean', `T1 全程无非预期 console error（实得 ${t1Errors.length} 个）${t1Errors.length ? '：' + JSON.stringify(t1Errors) : ''}`);
        await page1.close();

        // ═══════════════════════════════════════════════════════════════
        // T2：admin 受理弹层——config 显示风险等级选择并必填
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T2：受理弹层风险等级显示并必填（config） ──');
        const id2 = await mkConfigPending(adminTok, 't2');
        registerCreatedId(id2);
        const page2 = await loginPage(browser, adminTok);
        await page2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id2}`);
        await page2.waitForLoadState('networkidle');
        await page2.waitForTimeout(600);
        await page2.click('#siDActions button:has-text("受理通过")');
        await page2.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page2.waitForTimeout(200);
        const riskSelectCount = await page2.locator('#f_risk_level').count();
        await shotOnFail(page2, riskSelectCount === 1, 't2-risk-select-present', 'config 受理弹层出现 #f_risk_level 风险等级选择框');
        // 切成"请选择"（空值）后提交，应被前端拦
        if (riskSelectCount === 1) await page2.selectOption('#f_risk_level', '');
        await page2.click('#siMConfirm');
        await page2.waitForTimeout(400);
        const toastNoRisk = await page2.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page2, /请选择风险等级/.test(toastNoRisk || ''), 't2-risk-required-toast', `风险等级留空提交应报"请选择风险等级"（实得="${toastNoRisk}"）`);
        const modalStillOpenT2 = await page2.locator('#siModalOverlay.open').count();
        await shotOnFail(page2, modalStillOpenT2 === 1, 't2-modal-stays-open', '风险等级未选时弹窗仍打开');
        // 选风险等级后提交成功
        await page2.selectOption('#f_risk_level', '一级');
        await page2.click('#siMConfirm');
        await page2.waitForTimeout(800);
        const modalClosedT2 = await page2.locator('#siModalOverlay.open').count();
        await shotOnFail(page2, modalClosedT2 === 0, 't2-modal-closed', '选定风险等级后受理提交成功，弹窗关闭');
        const row2 = await dbGet('SELECT status, risk_level FROM sys_issues WHERE id=?', [id2]);
        await shotOnFail(page2, !!row2 && row2.status === '待处理' && row2.risk_level === '一级', 't2-db-accepted', `库内 status=待处理 ∧ risk_level=一级（实得=${JSON.stringify(row2)}）`);
        const t2Errors = filterExpectedConsoleErrors(page2._consoleErrors);
        await shotOnFail(page2, t2Errors.length === 0, 't2-console-clean', `T2 全程无非预期 console error（实得 ${t2Errors.length} 个）${t2Errors.length ? '：' + JSON.stringify(t2Errors) : ''}`);
        await page2.close();

        // ═══════════════════════════════════════════════════════════════
        // T3：admin 指派弹层——执行方式三选 + 乙方名称联动
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3：指派弹层执行方式三选 + 乙方名称联动 ──');
        const id3 = await mkConfigToPending2(adminTok, 't3', '二级');
        registerCreatedId(id3);
        const page3 = await loginPage(browser, adminTok);
        await page3.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
        await page3.waitForLoadState('networkidle');
        await page3.waitForTimeout(600);
        await page3.click('#siDActions button:has-text("指派")');
        await page3.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page3.waitForTimeout(200);
        const execRadioCount = await page3.locator('input[name="si-assign-exec-mode"]').count();
        await shotOnFail(page3, execRadioCount === 3, 't3-exec-mode-three-options', `指派弹层执行方式恰 3 个单选项（实得 ${execRadioCount}）`);
        const execLabelsText = await page3.locator('input[name="si-assign-exec-mode"] + span, label.si-radio-opt:has(input[name="si-assign-exec-mode"])').allTextContents().catch(() => []);
        const execRowText = await page3.locator('#siMBody').innerText().catch(() => '');
        await shotOnFail(page3, /本人执行/.test(execRowText) && /指派执行/.test(execRowText) && /乙方执行/.test(execRowText), 't3-exec-mode-labels', `执行方式三选项文案含"本人执行/指派执行/乙方执行"（实得片段="${execRowText.slice(0, 200)}"）`);
        // 乙方名称框默认隐藏
        const vendorBoxDisplay1 = await page3.locator('#si-assign-vendor-name-box').evaluate(el => getComputedStyle(el).display).catch(() => 'none');
        await shotOnFail(page3, vendorBoxDisplay1 === 'none', 't3-vendor-box-hidden-default', `乙方名称框默认隐藏（实得 display=${vendorBoxDisplay1}）`);
        // 勾选开发成员（至少 1 个，否则后续提交会被"请至少勾选 1 名开发"拦下）
        const devChk = page3.locator('.si-collab-chk').first();
        await devChk.check();
        // 未选执行方式直接提交 → 前端拦
        await page3.click('#siMConfirm');
        await page3.waitForTimeout(400);
        const toastNoExecMode = await page3.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page3, /请选择执行方式/.test(toastNoExecMode || ''), 't3-exec-mode-required-toast', `未选执行方式提交应报"请选择执行方式"（实得="${toastNoExecMode}"）`);
        // 选 vendor → 乙方名称框出现
        await page3.locator('input[name="si-assign-exec-mode"][value="vendor"]').check();
        await page3.waitForTimeout(150);
        const vendorBoxDisplay2 = await page3.locator('#si-assign-vendor-name-box').evaluate(el => getComputedStyle(el).display).catch(() => 'none');
        await shotOnFail(page3, vendorBoxDisplay2 !== 'none', 't3-vendor-box-shown', `选中「乙方执行」后乙方名称框应可见（实得 display=${vendorBoxDisplay2}）`);
        // vendor 未填名称提交 → 前端拦
        await page3.click('#siMConfirm');
        await page3.waitForTimeout(400);
        const toastNoVendorName = await page3.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page3, /请填写乙方名称/.test(toastNoVendorName || ''), 't3-vendor-name-required-toast', `vendor 模式未填名称提交应报"请填写乙方名称"（实得="${toastNoVendorName}"）`);
        // 切回非 vendor → 名称框隐藏（清空联动，不强制断言输入框值被清——只断言 UI 已收起）
        await page3.locator('input[name="si-assign-exec-mode"][value="assigned"]').check();
        await page3.waitForTimeout(150);
        const vendorBoxDisplay3 = await page3.locator('#si-assign-vendor-name-box').evaluate(el => getComputedStyle(el).display).catch(() => 'none');
        await shotOnFail(page3, vendorBoxDisplay3 === 'none', 't3-vendor-box-hidden-after-switch', `切回「指派执行」后乙方名称框应重新隐藏（实得 display=${vendorBoxDisplay3}）`);
        // 提交成功
        await page3.click('#siMConfirm');
        await page3.waitForTimeout(800);
        const modalClosedT3 = await page3.locator('#siModalOverlay.open').count();
        await shotOnFail(page3, modalClosedT3 === 0, 't3-modal-closed', '选定执行方式=指派执行后提交成功，弹窗关闭');
        const row3 = await dbGet('SELECT status, exec_mode, vendor_name FROM sys_issues WHERE id=?', [id3]);
        await shotOnFail(page3, !!row3 && row3.status === '处理中' && row3.exec_mode === 'assigned' && row3.vendor_name === null, 't3-db-assigned', `库内 status=处理中 ∧ exec_mode=assigned ∧ vendor_name=NULL（实得=${JSON.stringify(row3)}）`);
        const t3Errors = filterExpectedConsoleErrors(page3._consoleErrors);
        await shotOnFail(page3, t3Errors.length === 0, 't3-console-clean', `T3 全程无非预期 console error（实得 ${t3Errors.length} 个）${t3Errors.length ? '：' + JSON.stringify(t3Errors) : ''}`);
        await page3.close();

        // ═══════════════════════════════════════════════════════════════
        // T3v（补丁 AE·AE8·511-B M5）：首次指派 UI 走 vendor 成功路径——断请求体与库值
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3v：首次指派 UI 选择「乙方执行」成功路径 ──');
        const id3vUi = await mkConfigToPending2(adminTok, 't3vui', '二级');
        registerCreatedId(id3vUi);
        const page3v = await loginPage(browser, adminTok);
        await page3v.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3vUi}`);
        await page3v.waitForLoadState('networkidle');
        await page3v.waitForTimeout(600);
        await page3v.click('#siDActions button:has-text("指派")');
        await page3v.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page3v.waitForTimeout(200);
        await page3v.locator('.si-collab-chk').first().check();
        await page3v.locator('input[name="si-assign-exec-mode"][value="vendor"]').check();
        await page3v.waitForTimeout(150);
        await page3v.fill('#si-assign-vendor-name', 'AE8乙方公司');
        const assignRespPromise3v = page3v.waitForResponse(r => /\/api\/sys-issues\/\d+\/assign$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        await page3v.click('#siMConfirm');
        const assignResp3v = await assignRespPromise3v;
        let assignReqBody3v = {};
        try { assignReqBody3v = JSON.parse(assignResp3v.request().postData() || '{}'); } catch (_) { /* 解析失败按空对象处理，下方断言会判红 */ }
        await shotOnFail(page3v, assignResp3v.status() === 200, 't3v-assign-response-status', `首次指派 vendor 请求响应 200（实得 ${assignResp3v.status()}）`);
        await shotOnFail(page3v, assignReqBody3v.exec_mode === 'vendor' && assignReqBody3v.vendor_name === 'AE8乙方公司', 't3v-assign-request-body', `首次指派请求体 exec_mode='vendor' ∧ vendor_name='AE8乙方公司'（实得=${JSON.stringify(assignReqBody3v)}）`);
        await page3v.waitForTimeout(600);
        const row3vUi = await dbGet('SELECT status, exec_mode, vendor_name FROM sys_issues WHERE id=?', [id3vUi]);
        await shotOnFail(page3v, !!row3vUi && row3vUi.status === '处理中' && row3vUi.exec_mode === 'vendor' && row3vUi.vendor_name === 'AE8乙方公司', 't3v-db-vendor', `库内 status=处理中 ∧ exec_mode=vendor ∧ vendor_name=AE8乙方公司（实得=${JSON.stringify(row3vUi)}）`);
        const t3vErrors = filterExpectedConsoleErrors(page3v._consoleErrors);
        await shotOnFail(page3v, t3vErrors.length === 0, 't3v-console-clean', `T3v 全程无非预期 console error（实得 ${t3vErrors.length} 个）`);
        await page3v.close();

        // 另一夹具：vendor 填名后切回「指派执行」——断请求不带 vendor_name 键、落库 NULL
        const id3vSwitch = await mkConfigToPending2(adminTok, 't3vswitch', '二级');
        registerCreatedId(id3vSwitch);
        const page3vs = await loginPage(browser, adminTok);
        await page3vs.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3vSwitch}`);
        await page3vs.waitForLoadState('networkidle');
        await page3vs.waitForTimeout(600);
        await page3vs.click('#siDActions button:has-text("指派")');
        await page3vs.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page3vs.waitForTimeout(200);
        await page3vs.locator('.si-collab-chk').first().check();
        await page3vs.locator('input[name="si-assign-exec-mode"][value="vendor"]').check();
        await page3vs.waitForTimeout(150);
        await page3vs.fill('#si-assign-vendor-name', '残留名称不该提交');
        await page3vs.locator('input[name="si-assign-exec-mode"][value="assigned"]').check();
        await page3vs.waitForTimeout(150);
        const assignRespPromise3vs = page3vs.waitForResponse(r => /\/api\/sys-issues\/\d+\/assign$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        await page3vs.click('#siMConfirm');
        const assignResp3vs = await assignRespPromise3vs;
        // [补丁 AF·AF7-c·512 收紧建议] 解析失败不能回退空对象——`!('vendor_name' in {})` 恒真，会让
        // "缺键"断言在请求体根本没解析出来时也判成"通过"，这是假阳性。显式跟踪解析是否成功，断言里
        // 要求解析成功 ∧ 确实缺键，两者缺一都不算过。
        let assignReqBody3vs = null, assignReqBody3vsParseOk = false;
        // [S1d·513 附带建议] parseOk 改用 isPlainObjectJson——不再只判 `!== null`，避免合法 JSON 原始值
        // （数字/字符串/布尔）让下方 `in` 运算抛异常。
        try { assignReqBody3vs = JSON.parse(assignResp3vs.request().postData() || 'null'); assignReqBody3vsParseOk = isPlainObjectJson(assignReqBody3vs); } catch (_) { /* 解析失败留 null，下方按 parseOk=false 判红 */ }
        await shotOnFail(page3vs, assignReqBody3vsParseOk && !('vendor_name' in assignReqBody3vs), 't3v-switch-no-vendor-name-key', `切回「指派执行」后请求体解析成功 ∧ 不含 vendor_name 键（解析成功=${assignReqBody3vsParseOk}，实得=${JSON.stringify(assignReqBody3vs)}）`);
        await page3vs.waitForTimeout(600);
        const row3vSwitch = await dbGet('SELECT exec_mode, vendor_name FROM sys_issues WHERE id=?', [id3vSwitch]);
        await shotOnFail(page3vs, !!row3vSwitch && row3vSwitch.exec_mode === 'assigned' && row3vSwitch.vendor_name === null, 't3v-switch-db-null', `库内 exec_mode=assigned ∧ vendor_name IS NULL（实得=${JSON.stringify(row3vSwitch)}）`);
        const t3vsErrors = filterExpectedConsoleErrors(page3vs._consoleErrors);
        await shotOnFail(page3vs, t3vsErrors.length === 0, 't3v-switch-console-clean', `T3v 切换分支全程无非预期 console error（实得 ${t3vsErrors.length} 个）`);
        await page3vs.close();

        // 单独构造一张 vendor 终态单（供 T4 详情 kv 验证乙方名称展示）
        const id3v = await mkConfigProcessing(adminTok, 't3v', 'vendor', '某乙方公司');
        registerCreatedId(id3v);

        // ═══════════════════════════════════════════════════════════════
        // T4：详情 kv 显示执行方式 + 乙方名称
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T4：详情 kv 显示执行方式/乙方名称 ──');
        const page4 = await loginPage(browser, adminTok);
        await page4.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
        await page4.waitForLoadState('networkidle');
        await page4.waitForTimeout(700);
        const kvText3 = await page4.locator('.u-kv-grid').first().innerText().catch(() => '');
        await shotOnFail(page4, /执行方式/.test(kvText3) && /指派执行/.test(kvText3), 't4-kv-exec-mode-assigned', `详情 kv 显示「执行方式：指派执行」（实得片段含="${/执行方式[\s\S]{0,20}/.exec(kvText3)}"）`);
        // [补丁 AD·AD6·预筛 M4] 详情 kv 风险等级断言——此前零覆盖，把 :3802 一带的 `|| iss.type ===
        // 'config'` 删掉套件仍全绿；id3 建单时 risk_level 已判定为「二级」（mkConfigToPending2 默认值）。
        await shotOnFail(page4, /风险等级/.test(kvText3), 't4-kv-risk-level-label', 'config 单详情 kv 显示「风险等级」行');
        await page4.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3v}`);
        await page4.waitForLoadState('networkidle');
        await page4.waitForTimeout(700);
        const kvText3v = await page4.locator('.u-kv-grid').first().innerText().catch(() => '');
        await shotOnFail(page4, /执行方式/.test(kvText3v) && /乙方执行/.test(kvText3v), 't4-kv-exec-mode-vendor', 'vendor 单详情 kv 显示「执行方式：乙方执行」');
        await shotOnFail(page4, /乙方名称/.test(kvText3v) && /某乙方公司/.test(kvText3v), 't4-kv-vendor-name', 'vendor 单详情 kv 显示「乙方名称：某乙方公司」');
        const t4Errors = filterExpectedConsoleErrors(page4._consoleErrors);
        await shotOnFail(page4, t4Errors.length === 0, 't4-console-clean', `T4 全程无非预期 console error（实得 ${t4Errors.length} 个）`);
        await page4.close();

        // ═══════════════════════════════════════════════════════════════
        // T5：普通开发账号——处理中 estimate/submit 按钮可见；提交弹层只见 no_code
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5：开发账号处理中态 submit 按钮 + 提交弹层只见 no_code ──');
        const id5 = await mkConfigProcessing(adminTok, 't5', 'self');
        registerCreatedId(id5);
        const page5 = await loginPage(browser, devTok);
        await page5.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5}`);
        await page5.waitForLoadState('networkidle');
        await page5.waitForTimeout(700);
        const submitBtnCount = await page5.locator('#siDActions button:has-text("标记我的开发完成")').count();
        await shotOnFail(page5, submitBtnCount === 1, 't5-submit-btn-visible', '开发账号在 config「处理中」态看到「标记我的开发完成」按钮');
        await page5.click('#siDActions button:has-text("标记我的开发完成")');
        await page5.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5.waitForTimeout(200);
        const commitsRadioCount = await page5.locator('input[name="si-submit-mode"][value="commits"]').count();
        await shotOnFail(page5, commitsRadioCount === 0, 't5-no-commits-radio', 'config 提交弹层不出现「提交 commit」单选项');
        const noCodeRadioChecked = await page5.locator('input[name="si-submit-mode"][value="no_code"]').isChecked().catch(() => false);
        await shotOnFail(page5, noCodeRadioChecked, 't5-no-code-checked', '「无代码交付」单选默认已勾选');
        const noCodeLabelText = await page5.locator('#siSubmitNoCodeBox label').first().innerText().catch(() => '');
        await shotOnFail(page5, /配置说明/.test(noCodeLabelText), 't5-label-config-desc', `无代码交付原因字段标签改为「配置说明」（实得="${noCodeLabelText}"）`);
        const selfTestedLabel = await page5.locator('label[for="siSubmitSelfTested"]').innerText().catch(() => '');
        const testEnvLabel = await page5.locator('label[for="siSubmitTestEnvDeployed"]').innerText().catch(() => '');
        await shotOnFail(page5, /已在测试环境验证/.test(selfTestedLabel), 't5-checkbox1-label', `双勾第一项文案为「已在测试环境验证」（实得="${selfTestedLabel}"）`);
        await shotOnFail(page5, /已确认生产操作范围/.test(testEnvLabel), 't5-checkbox2-label', `双勾第二项文案为「已确认生产操作范围」（实得="${testEnvLabel}"）`);
        // 勾双确认
        await page5.check('#siSubmitSelfTested');
        await page5.check('#siSubmitTestEnvDeployed');
        // 配置说明 <10 码点 → 前端拦
        await page5.fill('#siSubmitNoCodeReason', '太短的说明');
        await page5.click('#siMConfirm');
        await page5.waitForTimeout(400);
        const toastShortReason = await page5.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page5, /配置说明必填|10~500/.test(toastShortReason || ''), 't5-short-reason-toast', `配置说明 <10 码点提交应被前端拦（实得="${toastShortReason}"）`);
        const modalStillOpenT5 = await page5.locator('#siModalOverlay.open').count();
        await shotOnFail(page5, modalStillOpenT5 === 1, 't5-modal-stays-open', '配置说明过短时弹窗仍打开');
        // ≥10 码点 → 提交成功
        const validReason = '配置内容：新增字典项；验证结果：测试环境已核对通过';
        await page5.fill('#siSubmitNoCodeReason', validReason);
        await page5.click('#siMConfirm');
        await page5.waitForTimeout(800);
        const modalClosedT5 = await page5.locator('#siModalOverlay.open').count();
        await shotOnFail(page5, modalClosedT5 === 0, 't5-modal-closed', '配置说明合法后提交成功，弹窗关闭');
        const devAssigneeRow = await dbGet(`SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=?`, [id5, DEV_ID]);
        await shotOnFail(page5, !!devAssigneeRow && devAssigneeRow.dev_status === 'no_code' && devAssigneeRow.no_code_reason === validReason, 't5-db-no-code', `库内 dev_status=no_code ∧ no_code_reason 逐字匹配（实得=${JSON.stringify(devAssigneeRow)}）`);
        const row5 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id5]);
        await shotOnFail(page5, !!row5 && row5.status === '待验证', 't5-db-status-verify', `库内主状态 status=待验证（唯一开发成员已完成，实得=${row5 && row5.status}）`);
        const t5Errors = filterExpectedConsoleErrors(page5._consoleErrors);
        await shotOnFail(page5, t5Errors.length === 0, 't5-console-clean', `T5 全程无非预期 console error（实得 ${t5Errors.length} 个）${t5Errors.length ? '：' + JSON.stringify(t5Errors) : ''}`);
        await page5.close();

        // ═══════════════════════════════════════════════════════════════
        // T5b（补丁 AE·AE9）：预计完成入口可见 + 码点边界（9 补充平面字符拒/10 接受）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5b：预计完成入口可见 + 提交码点边界（9 emoji 拒/10 emoji 接受） ──');
        const id5b = await mkConfigProcessing(adminTok, 't5b', 'self');
        registerCreatedId(id5b);
        const page5b = await loginPage(browser, devTok);
        await page5b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5b}`);
        await page5b.waitForLoadState('networkidle');
        await page5b.waitForTimeout(700);
        // [AE9] 头部声称覆盖 estimate 按钮，实际此前只查过 submit——补显式断言（label 视 dev_estimated_at
        // 是否已回填在"回填预计完成"/"修改预计完成"间切换，config 单经 intake-accept 已自动生成 ETA，
        // 故用子串匹配覆盖两种文案，见 status-families.js estimate.config=['处理中']）。
        const estimateBtnCount5b = await page5b.locator('#siDActions button:has-text("预计完成")').count();
        await shotOnFail(page5b, estimateBtnCount5b >= 1, 't5b-estimate-entry-visible', `config「处理中」态开发账号可见"预计完成"相关入口（实得按钮数=${estimateBtnCount5b}）`);
        await page5b.click('#siDActions button:has-text("标记我的开发完成")');
        await page5b.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5b.waitForTimeout(200);
        await page5b.check('#siSubmitSelfTested');
        await page5b.check('#siSubmitTestEnvDeployed');
        // 9 个补充平面字符（emoji）——码点=9，UTF-16 长度=18；验证校验按 [...s].length 码点计数而非
        // .length UTF-16 长度（否则 9 个代理对字符会被误判 length=18≥10 而放行）。
        const nineEmoji = '🌟'.repeat(9);
        await page5b.fill('#siSubmitNoCodeReason', nineEmoji);
        await page5b.click('#siMConfirm');
        await page5b.waitForTimeout(400);
        const toast9 = await page5b.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page5b, /配置说明必填|10~500/.test(toast9 || ''), 't5b-9-emoji-rejected', `9 个补充平面字符（码点=9）应被拒（实得 toast="${toast9}"）`);
        const modalOpen9 = await page5b.locator('#siModalOverlay.open').count();
        await shotOnFail(page5b, modalOpen9 === 1, 't5b-9-emoji-modal-stays-open', '9 个补充平面字符提交后弹窗仍打开');
        // 10 个补充平面字符——码点=10，边界值应被接受。
        const tenEmoji = '🌟'.repeat(10);
        await page5b.fill('#siSubmitNoCodeReason', tenEmoji);
        await page5b.click('#siMConfirm');
        await page5b.waitForTimeout(800);
        const modalClosed10 = await page5b.locator('#siModalOverlay.open').count();
        await shotOnFail(page5b, modalClosed10 === 0, 't5b-10-emoji-accepted', '10 个补充平面字符（码点=10）应被接受，弹窗关闭');
        const devRow5b = await dbGet(`SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=?`, [id5b, DEV_ID]);
        await shotOnFail(page5b, !!devRow5b && devRow5b.dev_status === 'no_code' && devRow5b.no_code_reason === tenEmoji, 't5b-10-emoji-db', `10 个 emoji 提交成功落库 no_code_reason 逐字匹配（实得=${JSON.stringify(devRow5b)}）`);
        const t5bErrors = filterExpectedConsoleErrors(page5b._consoleErrors);
        await shotOnFail(page5b, t5bErrors.length === 0, 't5b-console-clean', `T5b 全程无非预期 console error（实得 ${t5bErrors.length} 个）`);
        await page5b.close();

        // ═══════════════════════════════════════════════════════════════
        // T5c（补丁 AE·AE9）：501 码点拒绝 + 两个确认框分别漏勾——提示 + 提交请求数为零
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5c：501 码点拒绝 + 双勾漏选（提示+请求数为零，补丁 AF·AF7-b 独立弹层+toast 隔离） ──');
        const id5c = await mkConfigProcessing(adminTok, 't5c', 'self');
        registerCreatedId(id5c);
        const page5c = await loginPage(browser, devTok);
        await page5c.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5c}`);
        await page5c.waitForLoadState('networkidle');
        await page5c.waitForTimeout(700);
        // 501 码点——超上限应被拒
        await page5c.click('#siDActions button:has-text("标记我的开发完成")');
        await page5c.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5c.waitForTimeout(200);
        await page5c.check('#siSubmitSelfTested');
        await page5c.check('#siSubmitTestEnvDeployed');
        const reason501 = 'A'.repeat(501);
        await page5c.fill('#siSubmitNoCodeReason', reason501);
        const confirmEnabled501 = await page5c.locator('#siMConfirm').isEnabled();
        must(confirmEnabled501, '[T5c] 501 码点场景：确认按钮可操作（未被禁用）');
        // [S1d·513-M3] 不检查请求数（本场景只断言提示与弹层，未引用 reqCount），无需 watch。
        const { toastText: toast501, toastAppeared: toastAppeared501 } = await clickAndAwaitNewToast(page5c, '#siMConfirm');
        await shotOnFail(page5c, toastAppeared501 && /配置说明必填|10~500/.test(toast501 || ''), 't5c-501-rejected', `501 码点说明应被拒（toast 已出现=${toastAppeared501}，实得 toast="${toast501}"）`);
        const modalOpen501 = await page5c.locator('#siModalOverlay.open').count();
        await shotOnFail(page5c, modalOpen501 === 1, 't5c-501-modal-stays-open', '501 码点提交后弹窗仍打开');
        // [补丁 AF·AF7-b] 每个漏勾场景用独立弹层——关闭当前弹层，重新点开，避免上一场景残留的输入/勾选
        // 状态跨场景污染。
        await page5c.click('#siModalOverlay .si-close');
        await page5c.waitForSelector('#siModalOverlay.open', { state: 'detached', timeout: 5000 }).catch(() => {});
        await page5c.waitForTimeout(200);

        // 漏勾①「已在测试环境验证」——独立弹层，断提示 + 断言 submit 请求数为零（前端应在发起请求前拦截）
        await page5c.click('#siDActions button:has-text("标记我的开发完成")');
        await page5c.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5c.waitForTimeout(200);
        const validReasonForCheckboxTest = '配置说明合法长度用于测试双勾漏选拦截逻辑是否生效';
        await page5c.fill('#siSubmitNoCodeReason', validReasonForCheckboxTest);
        await page5c.uncheck('#siSubmitSelfTested');
        await page5c.check('#siSubmitTestEnvDeployed');
        const confirmEnabledCk1 = await page5c.locator('#siMConfirm').isEnabled();
        must(confirmEnabledCk1, '[T5c] 漏勾①场景：确认按钮可操作（未被禁用）');
        // [S1d·补丁AI·AI5，补丁AJ·AJ3，补丁AK·AK6 措辞订正·codex 516 recommendations（AJ3 措辞）]
        // watch 由场景自己持有——toast 检查完成后不立即 stop，额外再等一段有限缓冲（600ms，明确
        // 声明为有界观察窗口，覆盖"提示已弹出、请求随后才延迟发出"这类回归）之后才读计数。
        // ⚠️ 如实声明证据边界：T13④ 的零请求判据已经被 AJ3 组的变异注入证伪能力覆盖（reqCount 从
        // 0 变为 1 的真实实证）；本场景（T5c 漏勾①）**沿用同款请求生命周期采集手法，但未单独做过
        // 同样的变异注入验证**——不能推论"T13④ 已经证明了本场景自身的判据"，两者是各自独立的判据，
        // 只是实现手法相同。600ms 是已声明的有限观察窗口，不是"已证明覆盖所有已知异步任务"的结论。
        const watch5cCk1 = watchIssueRequests(page5c, id5c, 'submit');
        let submitReqCount1, toastCk1, toastAppeared1;
        try {
            ({ toastAppeared: toastAppeared1, toastText: toastCk1 } = await clickAndAwaitNewToast(page5c, '#siMConfirm'));
            await page5c.waitForTimeout(600);
        } finally {
            submitReqCount1 = watch5cCk1.count;
            watch5cCk1.stop();
        }
        await shotOnFail(page5c, toastAppeared1 && (toastCk1 || '').includes('已在测试环境验证'), 't5c-checkbox1-missing-toast', `漏勾"已在测试环境验证"应提示对应文案（toast 已出现=${toastAppeared1}，实得="${toastCk1}"）`);
        await shotOnFail(page5c, submitReqCount1 === 0, 't5c-checkbox1-missing-zero-requests', `漏勾第一个确认框时未发出 submit 请求（实得请求数=${submitReqCount1}）`);
        await page5c.click('#siModalOverlay .si-close');
        await page5c.waitForSelector('#siModalOverlay.open', { state: 'detached', timeout: 5000 }).catch(() => {});
        await page5c.waitForTimeout(200);

        // 漏勾②「已确认生产操作范围」——同上，独立弹层
        await page5c.click('#siDActions button:has-text("标记我的开发完成")');
        await page5c.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5c.waitForTimeout(200);
        await page5c.fill('#siSubmitNoCodeReason', validReasonForCheckboxTest);
        await page5c.check('#siSubmitSelfTested');
        await page5c.uncheck('#siSubmitTestEnvDeployed');
        const confirmEnabledCk2 = await page5c.locator('#siMConfirm').isEnabled();
        must(confirmEnabledCk2, '[T5c] 漏勾②场景：确认按钮可操作（未被禁用）');
        const watch5cCk2 = watchIssueRequests(page5c, id5c, 'submit');
        let submitReqCount2, toastCk2, toastAppeared2;
        try {
            ({ toastAppeared: toastAppeared2, toastText: toastCk2 } = await clickAndAwaitNewToast(page5c, '#siMConfirm'));
            await page5c.waitForTimeout(600);
        } finally {
            submitReqCount2 = watch5cCk2.count;
            watch5cCk2.stop();
        }
        await shotOnFail(page5c, toastAppeared2 && (toastCk2 || '').includes('已确认生产操作范围'), 't5c-checkbox2-missing-toast', `漏勾"已确认生产操作范围"应提示对应文案（toast 已出现=${toastAppeared2}，实得="${toastCk2}"）`);
        await shotOnFail(page5c, submitReqCount2 === 0, 't5c-checkbox2-missing-zero-requests', `漏勾第二个确认框时未发出 submit 请求（实得请求数=${submitReqCount2}）`);
        const t5cErrors = filterExpectedConsoleErrors(page5c._consoleErrors);
        await shotOnFail(page5c, t5cErrors.length === 0, 't5c-console-clean', `T5c 全程无非预期 console error（实得 ${t5cErrors.length} 个）`);
        await page5c.close();

        // ═══════════════════════════════════════════════════════════════
        // T6：admin 验收弹层——online_mode 单选默认 release；release/direct 两分支
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T6：验收弹层 online_mode 单选（默认 release + direct 分支） ──');
        const id6r = await mkConfigVerify(adminTok, devTok, 't6r');
        registerCreatedId(id6r);
        const page6 = await loginPage(browser, adminTok);
        await page6.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6r}`);
        await page6.waitForLoadState('networkidle');
        await page6.waitForTimeout(700);
        await page6.click('#siDActions button:has-text("验收通过")');
        await page6.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page6.waitForTimeout(200);
        const onlineModeRadioCount = await page6.locator('input[name="si-accept-online-mode"]').count();
        await shotOnFail(page6, onlineModeRadioCount === 2, 't6-online-mode-two-options', `验收弹层 online_mode 恰 2 个单选项（实得 ${onlineModeRadioCount}）`);
        // ⭐ MUT1 判别锚点：DOM 级断言"默认 release 已勾选"（不是端到端结果推断——后者会被 JS 兜底掩盖变异）
        const releaseChecked = await page6.locator('input[name="si-accept-online-mode"][value="release"]').isChecked().catch(() => false);
        await shotOnFail(page6, releaseChecked, 't6-release-default-checked', 'online_mode 默认勾选「加入上线单，按排期生效（release）」（MUT1 判别锚点：DOM 级 isChecked，非端到端推断）');
        const directChecked = await page6.locator('input[name="si-accept-online-mode"][value="direct"]').isChecked().catch(() => false);
        await shotOnFail(page6, !directChecked, 't6-direct-not-default', 'direct 选项默认未勾选');
        // 填验收说明——绕开既有软约束二次确认（accept 弹层"未填说明且未选附件"首击只警示不提交，见
        // siModalAccept softConfirmed 逻辑，T2/T7 系列已在 accept-evidence 套件专测过，本组焦点是
        // online_mode，不重复测软约束）。
        await page6.fill('#f_note', 'T6 探针：config release 分支验收说明');
        await page6.click('#siMConfirm');
        await page6.waitForTimeout(800);
        const modalClosedT6r = await page6.locator('#siModalOverlay.open').count();
        await shotOnFail(page6, modalClosedT6r === 0, 't6r-modal-closed', 'release 分支提交成功，弹窗关闭');
        const row6r = await dbGet('SELECT status, online_source FROM sys_issues WHERE id=?', [id6r]);
        await shotOnFail(page6, !!row6r && row6r.status === '待上线' && row6r.online_source === null, 't6r-db-status', `库内 status=待上线 ∧ online_source=NULL（实得=${JSON.stringify(row6r)}）`);
        // [补丁 AE·AE6·511-B M4，补丁 AF·AF7-a·512 收紧建议] 钉住 AD3 时间线渲染成果——不再按"整个
        // 时间线文本"和"含 online_mode 的最新记录"这种松散口径，改精确定位**本次验收事件**（按 T6
        // 探针的原始验收说明文字唯一锚定这一条时间线记录/DB 行），避免把"时间线里某处出现过这句话"
        // 和"这就是本次这条验收事件"混为一谈。
        await page6.reload();
        await page6.waitForLoadState('networkidle');
        await page6.waitForTimeout(500);
        const t6rTargetEvent = page6.locator('.si-tl-item', { hasText: 'T6 探针：config release 分支验收说明' });
        const t6rTargetCount = await t6rTargetEvent.count();
        await shotOnFail(page6, t6rTargetCount === 1, 't6r-timeline-event-found', `本次验收事件（含 T6 探针原始说明）恰一条存在（实得 ${t6rTargetCount} 条）`);
        const t6rTargetText = t6rTargetCount === 1 ? await t6rTargetEvent.innerText().catch(() => '') : '';
        await shotOnFail(page6, t6rTargetCount === 1 && /上线方式：加入上线单，按排期生效/.test(t6rTargetText), 't6r-timeline-online-mode', `release 分支本次验收事件显示"上线方式：加入上线单，按排期生效"（实得片段="${t6rTargetText}"）`);
        const tlRow6r = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND summary LIKE '%T6 探针：config release 分支验收说明%' ORDER BY id DESC LIMIT 1`, [id6r]);
        let tlPayload6r = null;
        try { tlPayload6r = tlRow6r && JSON.parse(tlRow6r.payload_json); } catch (_) { /* 解析失败留 null，下方按 !! 判红 */ }
        await shotOnFail(page6, !!tlPayload6r && tlPayload6r.online_mode === 'release', 't6r-timeline-payload-online-mode', `release 分支本次验收事件 payload_json.online_mode='release'（实得=${JSON.stringify(tlPayload6r)}）`);
        const t6rErrors = filterExpectedConsoleErrors(page6._consoleErrors);
        await shotOnFail(page6, t6rErrors.length === 0, 't6r-console-clean', `T6r 全程无非预期 console error（实得 ${t6rErrors.length} 个）`);
        await page6.close();

        // direct 分支
        const id6d = await mkConfigVerify(adminTok, devTok, 't6d');
        registerCreatedId(id6d);
        const page6b = await loginPage(browser, adminTok);
        await page6b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6d}`);
        await page6b.waitForLoadState('networkidle');
        await page6b.waitForTimeout(700);
        await page6b.click('#siDActions button:has-text("验收通过")');
        await page6b.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page6b.waitForTimeout(200);
        await page6b.locator('input[name="si-accept-online-mode"][value="direct"]').check();
        await page6b.waitForTimeout(150);
        const hintDisplayAfterDirect = await page6b.locator('#siAcceptOnlineModeHint').evaluate(el => getComputedStyle(el).display).catch(() => 'none');
        await shotOnFail(page6b, hintDisplayAfterDirect !== 'none', 't6d-hint-visible', `选中 direct 后预告 hint 应可见（实得 display=${hintDisplayAfterDirect}）`);
        await page6b.fill('#f_note', 'T6 探针：config direct 分支验收说明');
        await page6b.click('#siMConfirm');
        await page6b.waitForTimeout(800);
        const modalClosedT6d = await page6b.locator('#siModalOverlay.open').count();
        await shotOnFail(page6b, modalClosedT6d === 0, 't6d-modal-closed', 'direct 分支提交成功，弹窗关闭');
        const row6d = await dbGet('SELECT status, online_source, released_at FROM sys_issues WHERE id=?', [id6d]);
        await shotOnFail(page6b, !!row6d && row6d.status === '已上线' && row6d.online_source === 'no_commit_acceptance' && !!row6d.released_at, 't6d-db-status', `库内 status=已上线 ∧ online_source=no_commit_acceptance ∧ released_at 非空（实得=${JSON.stringify(row6d)}）`);
        // [补丁 AE·AE6，补丁 AF·AF7-a] 同 release 分支——精确定位本次验收事件后再核对时间线文本 +
        // payload_json，不靠"整个时间线/最新记录"这种松散口径。⚠️ 与 release 分支不同：direct（C9 零
        // commit 免上线直翻）分支的 summary 由后端固定文案 SYS_NO_COMMIT_ONLINE_SUMMARY
        // ='无提交免上线（验收通过自动结单）'覆盖（index.js:6031），我们填的 f_note 只进
        // payload_json.note、不进 summary/DOM 正文——故用这句固定审计文案作唯一锚点，不能沿用 release
        // 分支"按自己填的验收说明定位"的写法（那样在 direct 分支下会零匹配）。
        await page6b.reload();
        await page6b.waitForLoadState('networkidle');
        await page6b.waitForTimeout(500);
        const t6dTargetEvent = page6b.locator('.si-tl-item', { hasText: '无提交免上线（验收通过自动结单）' });
        const t6dTargetCount = await t6dTargetEvent.count();
        await shotOnFail(page6b, t6dTargetCount === 1, 't6d-timeline-event-found', `本次验收事件（含固定审计文案）恰一条存在（实得 ${t6dTargetCount} 条）`);
        const t6dTargetText = t6dTargetCount === 1 ? await t6dTargetEvent.innerText().catch(() => '') : '';
        await shotOnFail(page6b, t6dTargetCount === 1 && /上线方式：已在生产生效，直接完成/.test(t6dTargetText), 't6d-timeline-online-mode', `direct 分支本次验收事件显示"上线方式：已在生产生效，直接完成"（实得片段="${t6dTargetText}"）`);
        const tlRow6d = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND summary LIKE '%无提交免上线（验收通过自动结单）%' ORDER BY id DESC LIMIT 1`, [id6d]);
        let tlPayload6d = null;
        try { tlPayload6d = tlRow6d && JSON.parse(tlRow6d.payload_json); } catch (_) { /* 解析失败留 null */ }
        await shotOnFail(page6b, !!tlPayload6d && tlPayload6d.online_mode === 'direct', 't6d-timeline-payload-online-mode', `direct 分支本次验收事件 payload_json.online_mode='direct'（实得=${JSON.stringify(tlPayload6d)}）`);
        const t6dErrors = filterExpectedConsoleErrors(page6b._consoleErrors);
        await shotOnFail(page6b, t6dErrors.length === 0, 't6d-console-clean', `T6d 全程无非预期 console error（实得 ${t6dErrors.length} 个）`);
        await page6b.close();

        // ═══════════════════════════════════════════════════════════════
        // T7：对照组——bug 风险不适用负例 + improvement 验收弹层无 online_mode
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T7：对照组（bug 风险不适用 / config 风险适用正向对照 / improvement 无 online_mode） ──');
        const idBug = await mkBugVerify(adminTok, devTok, 't7bug');
        registerCreatedId(idBug);
        const idImp = await mkImprovementVerify(adminTok, devTok, 't7imp');
        registerCreatedId(idImp);
        // [补丁 AD·AD6·预筛 M4] 正向对照夹具——config 单风险等级='二级'（mkConfigProcessing 链路默认值），
        // 用于证明"列表行不含 .si-risk-na 且风险段显示已判定等级"这条正向断言，与 bug 负例成对（此前
        // 只测了 bug 侧"有 -"，把 riskApplicable 和详情 kv 的 `|| i.type==='config'` 整块删掉套件仍全绿）。
        const idConfigRisk = await mkConfigProcessing(adminTok, 't7cfgrisk', 'self');
        registerCreatedId(idConfigRisk);
        const page7 = await loginPage(browser, adminTok);
        await page7.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page7.waitForLoadState('networkidle');
        await page7.waitForTimeout(700);
        // [补丁 AD·AD10·预筛 L3] bug 行定位精确锚定本次夹具标题（此前用 .si-risk-na 全局 .first() +
        // 软条件搜索框，选择器一旦漂移会断言到列表里任意一条历史 bug 行——判别力仍在但"测的是哪一行"
        // 不确定）。改直接用本次 run 的标题前缀在 <tr> 层级定位。
        // [补丁 AE·AE11·511-B] 标题锚点补 RUN_TAG，要求"恰一条"——TITLE_PREFIX 是跨运行共享的常量，
        // 不带 RUN_TAG 理论上仍可能命中并发/串跑另一套用例的同名后缀行。
        const bugRow = page7.locator(`tr:has-text("${TITLE_PREFIX}-t7bug-${RUN_TAG}-")`);
        const bugRowCount = await bugRow.count();
        await shotOnFail(page7, bugRowCount === 1, 't7-bug-row-found', `能按本次夹具标题（含 RUN_TAG）定位到恰一条 bug 行（tr:has-text("${TITLE_PREFIX}-t7bug-${RUN_TAG}-")，实得 ${bugRowCount} 条）`);
        const bugRiskCell = bugRow.locator('.si-risk-na').first();
        const bugRiskCellCount = await bugRiskCell.count();
        await shotOnFail(page7, bugRiskCellCount >= 1, 't7-bug-risk-na-cell', 'bug 单列表行风险段渲染 si-risk-na 占位（"-"）');
        if (bugRiskCellCount >= 1) {
            const naTitle = await bugRiskCell.first().getAttribute('title');
            await shotOnFail(page7, !!naTitle && /bug 单不适用/.test(naTitle), 't7-bug-risk-na-title', `si-risk-na 悬浮说明含"bug 单不适用"（实得="${naTitle}"）`);
        }
        // [补丁 AD·AD6] 正向对照：config 行不含 .si-risk-na，风险段显示已判定等级「二级」
        // [补丁 AE·AE11] 同上——标题锚点补 RUN_TAG，要求恰一条。
        const configRiskRow = page7.locator(`tr:has-text("${TITLE_PREFIX}-t7cfgrisk-${RUN_TAG}-")`);
        const configRiskRowCount = await configRiskRow.count();
        await shotOnFail(page7, configRiskRowCount === 1, 't7-config-row-found', `能按本次夹具标题（含 RUN_TAG）定位到恰一条 config 行（tr:has-text("${TITLE_PREFIX}-t7cfgrisk-${RUN_TAG}-")，实得 ${configRiskRowCount} 条）`);
        const configRiskNaCount = await configRiskRow.locator('.si-risk-na').count();
        await shotOnFail(page7, configRiskNaCount === 0, 't7-config-risk-not-na', `config 单列表行不应渲染 si-risk-na 占位（实得 ${configRiskNaCount} 个）`);
        const configRowText = await configRiskRow.innerText().catch(() => '');
        await shotOnFail(page7, /二级/.test(configRowText), 't7-config-risk-level-shown', `config 单列表行风险段显示已判定等级"二级"（实得片段="${configRowText.slice(0, 100)}"）`);
        // improvement 验收弹层无 online_mode
        await page7.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idImp}`);
        await page7.waitForLoadState('networkidle');
        await page7.waitForTimeout(700);
        await page7.click('#siDActions button:has-text("验收通过")');
        await page7.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page7.waitForTimeout(200);
        const impOnlineModeCount = await page7.locator('input[name="si-accept-online-mode"]').count();
        await shotOnFail(page7, impOnlineModeCount === 0, 't7-improvement-no-online-mode', `improvement 验收弹层不出现 online_mode 单选（实得 ${impOnlineModeCount} 个）`);
        // 不点确定/不提交——本组只测弹层字段存在性，直接关页即可，不需要真正走完 accept 流程。
        const t7Errors = filterExpectedConsoleErrors(page7._consoleErrors);
        await shotOnFail(page7, t7Errors.length === 0, 't7-console-clean', `T7 全程无非预期 console error（实得 ${t7Errors.length} 个）`);
        await page7.close();

        // ═══════════════════════════════════════════════════════════════
        // T8：类型卡 4 张 + 筛选下拉含「配置变更」
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T8：类型卡 4 张 + 筛选下拉含「配置变更」 ──');
        const page8 = await loginPage(browser, adminTok);
        await page8.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page8.waitForLoadState('networkidle');
        await page8.waitForTimeout(700);
        const typeCardCount = await page8.locator('#siTypeCardsRow .u-stat-card').count();
        await shotOnFail(page8, typeCardCount === 4, 't8-type-card-count', `类型卡恰 4 张（实得 ${typeCardCount}）`);
        const typeCardText = await page8.locator('#siTypeCardsRow').innerText().catch(() => '');
        await shotOnFail(page8, /配置变更/.test(typeCardText), 't8-type-card-config-label', `类型卡文案含「配置变更」（实得片段="${typeCardText.slice(0, 200)}"）`);
        const filterOptTexts = await page8.locator('#siFType option').allTextContents();
        await shotOnFail(page8, filterOptTexts.some(t => t.includes('配置变更')), 't8-filter-dropdown-config', `类型筛选下拉含「配置变更」（实得选项=${JSON.stringify(filterOptTexts)}）`);
        const t8Errors = filterExpectedConsoleErrors(page8._consoleErrors);
        await shotOnFail(page8, t8Errors.length === 0, 't8-console-clean', `T8 全程无非预期 console error（实得 ${t8Errors.length} 个）`);
        await page8.close();

        // ═══════════════════════════════════════════════════════════════
        // T9：DOM 全程扫描——「已生效」不应出现在任何渲染面
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T9：DOM 扫描「已生效」不出现 ──');
        const page9 = await loginPage(browser, adminTok);
        await page9.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6d}`);   // 已上线单——最贴近历史"已生效预留"会出现的态
        await page9.waitForLoadState('networkidle');
        await page9.waitForTimeout(700);
        const bodyText9 = await page9.locator('body').innerText().catch(() => '');
        await shotOnFail(page9, !bodyText9.includes('已生效'), 't9-dom-no-effected', '已上线 config 单详情页整页文本不含"已生效"');
        const t9Errors = filterExpectedConsoleErrors(page9._consoleErrors);
        await shotOnFail(page9, t9Errors.length === 0, 't9-console-clean', `T9 全程无非预期 console error（实得 ${t9Errors.length} 个）`);
        await page9.close();

        // ═══════════════════════════════════════════════════════════════
        // T10：「待我处理」谓词含 config 各态——开发/受理人/admin 三身份
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T10：「待我处理」谓词含 config 各态（开发/受理人/admin） ──');
        const idPendingLiaison = await mkConfigPending(adminTok, 't10liaison');   // 待受理，绑定 liaison 13
        registerCreatedId(idPendingLiaison);
        const idProcessingDev = await mkConfigProcessing(adminTok, 't10dev', 'assigned');   // 处理中，指派给 DEV_ID
        registerCreatedId(idProcessingDev);
        const idVerifyAdmin = await mkConfigVerify(adminTok, devTok, 't10admin');   // 待验证
        registerCreatedId(idVerifyAdmin);

        const pageDev = await loginPage(browser, devTok);
        await pageDev.goto(`${BASE_URL}/Sys_Iteration.html`);
        await pageDev.waitForLoadState('networkidle');
        await pageDev.waitForTimeout(700);
        const devPendingCheck = await pageDev.evaluate((issueId) => {
            const item = (siList || []).find(x => Number(x.id) === Number(issueId));
            if (!item) return { found: false };
            return { found: true, isMyPending: !!siIsMyPending(item), status: item.status, my_dev_pending: item.my_dev_pending };
        }, idProcessingDev);
        await shotOnFail(pageDev, devPendingCheck.found && devPendingCheck.isMyPending, 't10-dev-my-pending', `开发账号：config「处理中」态单命中 siIsMyPending（实得=${JSON.stringify(devPendingCheck)}）`);
        // [补丁 AE·AE11·511-B] 此前只查过 admin 页的 console error，开发/受理人页的错误被丢弃——分别关闭前逐一检查。
        const t10DevErrors = filterExpectedConsoleErrors(pageDev._consoleErrors);
        await shotOnFail(pageDev, t10DevErrors.length === 0, 't10-dev-console-clean', `T10 开发账号页全程无非预期 console error（实得 ${t10DevErrors.length} 个）${t10DevErrors.length ? '：' + JSON.stringify(t10DevErrors) : ''}`);
        await pageDev.close();

        const pageLiaison = await loginPage(browser, liaisonTok);
        await pageLiaison.goto(`${BASE_URL}/Sys_Iteration.html`);
        await pageLiaison.waitForLoadState('networkidle');
        await pageLiaison.waitForTimeout(700);
        const liaisonPendingCheck = await pageLiaison.evaluate((issueId) => {
            const item = (siList || []).find(x => Number(x.id) === Number(issueId));
            if (!item) return { found: false };
            return { found: true, isMyPending: !!siIsMyPending(item), status: item.status, is_my_intake_liaison: item.is_my_intake_liaison };
        }, idPendingLiaison);
        await shotOnFail(pageLiaison, liaisonPendingCheck.found && liaisonPendingCheck.isMyPending, 't10-liaison-my-pending', `受理人账号：config「待受理」态单命中 siIsMyPending（实得=${JSON.stringify(liaisonPendingCheck)}）`);
        const t10LiaisonErrors = filterExpectedConsoleErrors(pageLiaison._consoleErrors);
        await shotOnFail(pageLiaison, t10LiaisonErrors.length === 0, 't10-liaison-console-clean', `T10 受理人页全程无非预期 console error（实得 ${t10LiaisonErrors.length} 个）${t10LiaisonErrors.length ? '：' + JSON.stringify(t10LiaisonErrors) : ''}`);
        await pageLiaison.close();

        const pageAdmin = await loginPage(browser, adminTok);
        await pageAdmin.goto(`${BASE_URL}/Sys_Iteration.html`);
        await pageAdmin.waitForLoadState('networkidle');
        await pageAdmin.waitForTimeout(700);
        const adminPendingCheck = await pageAdmin.evaluate((issueId) => {
            const item = (siList || []).find(x => Number(x.id) === Number(issueId));
            if (!item) return { found: false };
            return { found: true, isMyPending: !!siIsMyPending(item), status: item.status };
        }, idVerifyAdmin);
        await shotOnFail(pageAdmin, adminPendingCheck.found && adminPendingCheck.isMyPending, 't10-admin-my-pending', `admin 账号：config「待验证」态单命中 siIsMyPending（实得=${JSON.stringify(adminPendingCheck)}）`);
        const t10Errors = filterExpectedConsoleErrors(pageAdmin._consoleErrors);
        await shotOnFail(pageAdmin, t10Errors.length === 0, 't10-admin-console-clean', `T10 admin 页全程无非预期 console error（实得 ${t10Errors.length} 个）`);
        await pageAdmin.close();

        // ═══════════════════════════════════════════════════════════════
        // T11（补丁 AC·AC1）：hotfixBtn 应急上线按钮含 config——待上线可见、处理中不可见、improvement 对照
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T11：应急上线按钮 config 待上线可见 / 处理中不可见（AC1） ──');
        const id11PreRelease = await mkConfigPreRelease(adminTok, devTok, 't11pre');
        registerCreatedId(id11PreRelease);
        const id11Processing = await mkConfigProcessing(adminTok, 't11proc', 'self');
        registerCreatedId(id11Processing);
        const page11 = await loginPage(browser, adminTok);
        await page11.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id11PreRelease}`);
        await page11.waitForLoadState('networkidle');
        await page11.waitForTimeout(700);
        const hotfixBtnCountPre = await page11.locator('#siDActions button:has-text("应急上线")').count();
        await shotOnFail(page11, hotfixBtnCountPre === 1, 't11-config-prerelease-visible', `config「待上线」态 admin 可见「应急上线」按钮（实得按钮数=${hotfixBtnCountPre}）`);
        await page11.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id11Processing}`);
        await page11.waitForLoadState('networkidle');
        await page11.waitForTimeout(700);
        const hotfixBtnCountProc = await page11.locator('#siDActions button:has-text("应急上线")').count();
        await shotOnFail(page11, hotfixBtnCountProc === 0, 't11-config-processing-hidden', `config「处理中」态不应出现「应急上线」按钮（实得按钮数=${hotfixBtnCountProc}）`);
        const t11Errors = filterExpectedConsoleErrors(page11._consoleErrors);
        await shotOnFail(page11, t11Errors.length === 0, 't11-console-clean', `T11 全程无非预期 console error（实得 ${t11Errors.length} 个）`);
        await page11.close();

        // improvement 对照组——既有行为不应受本批影响
        const id11ImpBase = await mkImprovementVerify(adminTok, devTok, 't11imp');
        registerCreatedId(id11ImpBase);
        const acceptImpR = await fetch(`${BASE_URL}/api/sys-issues/${id11ImpBase}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
        const acceptImpBody = await acceptImpR.json();
        if (acceptImpR.status !== 200 || acceptImpBody.status !== '待上线') throw new Error(`[夹具-improvement 验收] 应 200∧status=待上线，实得 ${acceptImpR.status} ${JSON.stringify(acceptImpBody)}`);
        const page11b = await loginPage(browser, adminTok);
        await page11b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id11ImpBase}`);
        await page11b.waitForLoadState('networkidle');
        await page11b.waitForTimeout(700);
        const hotfixBtnCountImp = await page11b.locator('#siDActions button:has-text("应急上线")').count();
        await shotOnFail(page11b, hotfixBtnCountImp === 1, 't11-improvement-control-visible', `对照组：improvement「待上线」态 admin 仍可见「应急上线」按钮（本批未改动其行为，实得按钮数=${hotfixBtnCountImp}）`);
        const t11bErrors = filterExpectedConsoleErrors(page11b._consoleErrors);
        await shotOnFail(page11b, t11bErrors.length === 0, 't11b-console-clean', `T11 improvement 对照组全程无非预期 console error（实得 ${t11bErrors.length} 个）`);
        await page11b.close();

        // ═══════════════════════════════════════════════════════════════
        // T12（补丁 AC·AC2）：通知面板顶层分派——config 走「变更流」布局，bug 对照仍走「bug」布局
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T12：通知面板顶层分派 config 走变更流布局（AC2） ──');
        const id12Config = await mkConfigVerify(adminTok, devTok, 't12cfg');
        registerCreatedId(id12Config);
        const page12 = await loginPage(browser, adminTok);
        await page12.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12Config}`);
        await page12.waitForLoadState('networkidle');
        await page12.waitForTimeout(700);
        const notifyHeaderConfig = await page12.locator('.u-detail-section h3:has-text("钉钉通知")').first().innerText().catch(() => '');
        await shotOnFail(page12, notifyHeaderConfig === '钉钉通知（手动触发）', `t12-config-change-layout-header`, `config 单通知面板标题为「钉钉通知（手动触发）」（变更流布局，非 bug 的「独立·手动触发」，实得="${notifyHeaderConfig}"）`);
        // [修正] .u-nt-muted 是每行通知状态文本共用的类（如"未发送钉钉通知"），.first() 会命中某一行
        // 而非面板底部说明——改在整个通知区块容器内做全文包含判断，不依赖具体第几个同类节点。
        const notifySectionConfig = await page12.locator('.u-detail-section:has(h3:has-text("钉钉通知"))').first().innerText().catch(() => '');
        // [补丁 AD·AD9·预筛 L1] 断言同步文案改动——「变更流通知均」→「本单通知均」（config 并入本布局后
        // 用"变更流"三字描述会对 config 单失实，见 Sys_Iteration.html :5439 一带注释）。
        await shotOnFail(page12, /本单通知均/.test(notifySectionConfig), 't12-config-change-layout-footer', `config 单通知面板整块含"本单通知均"说明（实得片段="${notifySectionConfig.slice(-80)}"）`);
        // [补丁 AE·AE7·511-B] 结构性缺席——relay/对接测试/上线执行三类专属行均不应出现在 config 通知区
        // （relay/release-executor 渲染函数在 feature/improvement/config 分支模板里压根未被调用；对接测试
        // 渲染函数虽被调用，但自身 `iss.type !== 'feature'` early return 短路，落地为空串）。
        await shotOnFail(page12, !/对接人\s/.test(notifySectionConfig), 't12-config-no-relay-row', 'config 单通知区不出现「对接人 X」（relay 专属）行');
        await shotOnFail(page12, !/对接测试\s/.test(notifySectionConfig), 't12-config-no-liaison-test-row', 'config 单通知区不出现「对接测试」行');
        await shotOnFail(page12, !/上线开发\s/.test(notifySectionConfig), 't12-config-no-release-executor-row', 'config 单通知区不出现「上线开发」（上线执行专属）行');
        const t12Errors = filterExpectedConsoleErrors(page12._consoleErrors);
        await shotOnFail(page12, t12Errors.length === 0, 't12-console-clean', `T12 全程无非预期 console error（实得 ${t12Errors.length} 个）`);
        await page12.close();

        // [补丁 AE·AE7] 通道操作权限——待验证态：绑定受理人(LIAISON_ID)应见建单人/业务方/开发三通道
        // 操作按钮，在册开发(DEV_ID·非绑定受理人非 admin)应看不到（config 分支 canOperate = admin∨绑定
        // 对接人，与开发通道的自指隐藏正交——这里刻意用"受理人查看开发行/开发查看建单人行"两种非本人
        // 组合，排除自指守卫的干扰，纯测 canOperate 本身）。
        console.log('\n── T12b：通知区通道操作权限——绑定受理人 vs 在册开发（AE7，补丁 AF·AF5 加固存在性） ──');
        const page12Liaison = await loginPage(browser, liaisonTok);
        await page12Liaison.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12Config}`);
        await page12Liaison.waitForLoadState('networkidle');
        await page12Liaison.waitForTimeout(700);
        // [补丁 AF·AF5·512-M3] 先断本单详情确实加载 + 通知区确实渲染，再断具体通道行/按钮——避免"整个
        // 通知区没渲染出来"这类更严重的失败被两条按钮数断言误判成"正向权限验证通过"（0>=1 恒假会先红，
        // 但存在性检查能明确指出根因是"区块没渲染"而非"按钮被隐藏"）。
        const liaisonDetailInfo = await page12Liaison.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, type: siDetail.issue.type } : null);
        must(!!liaisonDetailInfo && Number(liaisonDetailInfo.id) === id12Config && liaisonDetailInfo.type === 'config', `[T12b] 受理人视角：详情确实加载了目标单据（预期 id=${id12Config}∧type=config，实得=${JSON.stringify(liaisonDetailInfo)}）`);
        const notifySectionLiaisonCount = await page12Liaison.locator('.u-detail-section:has(h3:has-text("钉钉通知"))').count();
        must(notifySectionLiaisonCount === 1, `[T12b] 受理人视角：通知区容器确实渲染（实得 ${notifySectionLiaisonCount} 个）`);
        const creatorRowLiaison = page12Liaison.locator('.u-notify-row', { hasText: '建单人' });
        const creatorRowLiaisonCount = await creatorRowLiaison.count();
        must(creatorRowLiaisonCount === 1, `[T12b] 受理人视角：建单人通知行本身存在（实得 ${creatorRowLiaisonCount} 行）`);
        const creatorBtnCountLiaison = creatorRowLiaisonCount === 1 ? await creatorRowLiaison.locator('button').count() : -1;
        await shotOnFail(page12Liaison, creatorRowLiaisonCount === 1 && creatorBtnCountLiaison >= 1, 't12-liaison-creator-btn-visible', `绑定受理人在「待验证」态可见建单人通道操作按钮（行存在=${creatorRowLiaisonCount === 1}，实得按钮数=${creatorBtnCountLiaison}）`);
        const requesterRowLiaison = page12Liaison.locator('.u-notify-row', { hasText: '业务方' });
        const requesterRowLiaisonCount = await requesterRowLiaison.count();
        must(requesterRowLiaisonCount === 1, `[T12b] 受理人视角：业务方通知行本身存在（实得 ${requesterRowLiaisonCount} 行）`);
        const requesterBtnCountLiaison = requesterRowLiaisonCount === 1 ? await requesterRowLiaison.locator('button').count() : -1;
        await shotOnFail(page12Liaison, requesterRowLiaisonCount === 1 && requesterBtnCountLiaison >= 1, 't12-liaison-requester-btn-visible', `绑定受理人在「待验证」态可见业务方通道操作按钮（行存在=${requesterRowLiaisonCount === 1}，实得按钮数=${requesterBtnCountLiaison}）`);
        const devRowLiaisonView = page12Liaison.locator('.u-notify-row', { hasText: '开发 ' });
        const devRowLiaisonViewCount = await devRowLiaisonView.count();
        must(devRowLiaisonViewCount === 1, `[T12b] 受理人视角：开发通知行本身存在（实得 ${devRowLiaisonViewCount} 行）`);
        const devBtnCountLiaisonView = devRowLiaisonViewCount === 1 ? await devRowLiaisonView.locator('button').count() : -1;
        await shotOnFail(page12Liaison, devRowLiaisonViewCount === 1 && devBtnCountLiaisonView >= 1, 't12-liaison-dev-btn-visible', `绑定受理人在「待验证」态可见开发通知操作按钮（受理人非该开发本人，行存在=${devRowLiaisonViewCount === 1}，实得按钮数=${devBtnCountLiaisonView}）`);
        const t12LiaisonErrors = filterExpectedConsoleErrors(page12Liaison._consoleErrors);
        await shotOnFail(page12Liaison, t12LiaisonErrors.length === 0, 't12-liaison-console-clean', `T12b 受理人视角全程无非预期 console error（实得 ${t12LiaisonErrors.length} 个）`);
        await page12Liaison.close();

        const page12Dev = await loginPage(browser, devTok);
        await page12Dev.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12Config}`);
        await page12Dev.waitForLoadState('networkidle');
        await page12Dev.waitForTimeout(700);
        // [补丁 AF·AF5·512-M3] 开发视角同样先断详情/通知区/通道行**存在**，再断按钮缺席——511-B 原问题
        // 点名"若整个通知区对开发不再渲染，两条按钮数为零的断言仍会通过"，本批把"行存在"独立断言出来，
        // 不再让"行不存在"和"行存在但按钮正确隐藏"这两种情况共用同一个 0 计数结论。
        const devDetailInfo = await page12Dev.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, type: siDetail.issue.type } : null);
        must(!!devDetailInfo && Number(devDetailInfo.id) === id12Config && devDetailInfo.type === 'config', `[T12b] 开发视角：详情确实加载了目标单据（预期 id=${id12Config}∧type=config，实得=${JSON.stringify(devDetailInfo)}）`);
        const notifySectionDevCount = await page12Dev.locator('.u-detail-section:has(h3:has-text("钉钉通知"))').count();
        must(notifySectionDevCount === 1, `[T12b] 开发视角：通知区容器确实渲染（实得 ${notifySectionDevCount} 个——为 0 说明整区不渲染，不是"按钮被隐藏"这种更弱的情况）`);
        const creatorRowDev = page12Dev.locator('.u-notify-row', { hasText: '建单人' });
        const creatorRowDevCount = await creatorRowDev.count();
        must(creatorRowDevCount === 1, `[T12b] 开发视角：建单人通知行本身存在（实得 ${creatorRowDevCount} 行）`);
        const creatorBtnCountDev = creatorRowDevCount === 1 ? await creatorRowDev.locator('button').count() : -1;
        await shotOnFail(page12Dev, creatorRowDevCount === 1 && creatorBtnCountDev === 0, 't12-dev-creator-btn-hidden', `在册开发（非绑定受理人∧非 admin）在「待验证」态看不到建单人通道操作按钮（行存在=${creatorRowDevCount === 1}，实得按钮数=${creatorBtnCountDev}）`);
        const requesterRowDev = page12Dev.locator('.u-notify-row', { hasText: '业务方' });
        const requesterRowDevCount = await requesterRowDev.count();
        must(requesterRowDevCount === 1, `[T12b] 开发视角：业务方通知行本身存在（实得 ${requesterRowDevCount} 行）`);
        const requesterBtnCountDev = requesterRowDevCount === 1 ? await requesterRowDev.locator('button').count() : -1;
        await shotOnFail(page12Dev, requesterRowDevCount === 1 && requesterBtnCountDev === 0, 't12-dev-requester-btn-hidden', `在册开发看不到业务方通道操作按钮（行存在=${requesterRowDevCount === 1}，实得按钮数=${requesterBtnCountDev}）`);
        const t12DevErrors = filterExpectedConsoleErrors(page12Dev._consoleErrors);
        await shotOnFail(page12Dev, t12DevErrors.length === 0, 't12-dev-console-clean', `T12b 开发视角全程无非预期 console error（实得 ${t12DevErrors.length} 个）`);
        await page12Dev.close();

        // [补丁 AE·AE7] 处理中态——开发通知按钮可见性（sendable=['处理中','待验证']，与上面待验证态互补）
        const id12ConfigProcessing = await mkConfigProcessing(adminTok, 't12cfgproc', 'self');
        registerCreatedId(id12ConfigProcessing);
        const page12Proc = await loginPage(browser, liaisonTok);
        await page12Proc.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12ConfigProcessing}`);
        await page12Proc.waitForLoadState('networkidle');
        await page12Proc.waitForTimeout(700);
        const devRowProc = page12Proc.locator('.u-notify-row', { hasText: '开发 ' });
        const devBtnCountProc = await devRowProc.locator('button').count();
        await shotOnFail(page12Proc, devBtnCountProc >= 1, 't12-liaison-dev-btn-visible-processing', `绑定受理人在「处理中」态可见开发通知操作按钮（实得按钮数=${devBtnCountProc}）`);
        const t12ProcErrors = filterExpectedConsoleErrors(page12Proc._consoleErrors);
        await shotOnFail(page12Proc, t12ProcErrors.length === 0, 't12-liaison-processing-console-clean', `T12b 处理中态受理人视角全程无非预期 console error（实得 ${t12ProcErrors.length} 个）`);
        await page12Proc.close();

        // bug 对照组——仍应走「独立·手动触发」布局（未被本批连带改动）
        const id12Bug = await mkBugVerify(adminTok, devTok, 't12bug');
        registerCreatedId(id12Bug);
        const page12b = await loginPage(browser, adminTok);
        await page12b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12Bug}`);
        await page12b.waitForLoadState('networkidle');
        await page12b.waitForTimeout(700);
        const notifyHeaderBug = await page12b.locator('.u-detail-section h3:has-text("钉钉通知")').first().innerText().catch(() => '');
        await shotOnFail(page12b, notifyHeaderBug === '钉钉通知（独立·手动触发）', 't12-bug-control-layout-header', `对照组：bug 单通知面板标题仍为「钉钉通知（独立·手动触发）」（实得="${notifyHeaderBug}"）`);
        const t12bErrors = filterExpectedConsoleErrors(page12b._consoleErrors);
        await shotOnFail(page12b, t12bErrors.length === 0, 't12b-console-clean', `T12 bug 对照组全程无非预期 console error（实得 ${t12bErrors.length} 个）`);
        await page12b.close();

        // ═══════════════════════════════════════════════════════════════
        // T13（补丁 AD·AD5）：改派 exec_mode/vendor_name 全链路四条用例——此前零覆盖
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T13：改派 exec_mode/vendor_name 四种变化组合 ──');
        // ①vendor 单只改成员 → exec_mode/vendor_name 逐字不变
        const id13a = await mkConfigProcessing(adminTok, 't13a', 'vendor', '原乙方公司');
        registerCreatedId(id13a);
        const page13a = await loginPage(browser, adminTok);
        await page13a.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13a}`);
        await page13a.waitForLoadState('networkidle');
        await page13a.waitForTimeout(700);
        await page13a.click('#siDActions button:has-text("改派")');
        await page13a.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page13a.waitForTimeout(200);
        await page13a.locator(`.si-member-chk[value="${SECOND_DEV_ID}"]`).check();
        await page13a.fill('#f_reason', '补丁 AD T13① 探针：只加一名成员，不动执行方式');
        // [补丁 AE·AE10·511-B M7] 捕获请求体——直查库只能证明"最终值不变"，"始终发送原值"也能通过该
        // 断言；须直接断请求体不含 exec_mode/vendor_name 两键，才能证明前端真的没有携带这两个字段。
        const reassignRespPromise13a = page13a.waitForResponse(r => /\/api\/sys-issues\/\d+\/reassign$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        await page13a.click('#siMConfirm');
        const reassignResp13a = await reassignRespPromise13a;
        // [补丁 AF·AF7-c·512 收紧建议] 同 T3v 切换分支——解析失败不能回退空对象（`!('k' in {})` 恒真会
        // 让"缺键"断言在解析失败时也假通过），显式跟踪解析是否成功并纳入判据。
        let reassignBody13a = null, reassignBody13aParseOk = false;
        // [S1d·513 附带建议] 同 T3v 切换分支——parseOk 改用 isPlainObjectJson。
        try { reassignBody13a = JSON.parse(reassignResp13a.request().postData() || 'null'); reassignBody13aParseOk = isPlainObjectJson(reassignBody13a); } catch (_) { /* 解析失败留 null，下方按 parseOk=false 判红 */ }
        await shotOnFail(page13a, reassignBody13aParseOk && !('exec_mode' in reassignBody13a) && !('vendor_name' in reassignBody13a), 't13a-request-no-exec-keys', `①只改成员时请求体解析成功 ∧ 不含 exec_mode/vendor_name 两键（解析成功=${reassignBody13aParseOk}，实得=${JSON.stringify(reassignBody13a)}）`);
        await page13a.waitForTimeout(800);
        const modalClosed13a = await page13a.locator('#siModalOverlay.open').count();
        await shotOnFail(page13a, modalClosed13a === 0, 't13a-modal-closed', '①只改成员提交成功，弹窗关闭');
        const row13a = await dbGet('SELECT exec_mode, vendor_name FROM sys_issues WHERE id=?', [id13a]);
        await shotOnFail(page13a, !!row13a && row13a.exec_mode === 'vendor' && row13a.vendor_name === '原乙方公司', 't13a-db-unchanged', `①只改成员时 exec_mode/vendor_name 逐字不变（实得=${JSON.stringify(row13a)}）`);
        const memberRows13a = await dbAll('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id13a]);
        const memberIds13a = memberRows13a.map(r => Number(r.user_id)).sort();
        await shotOnFail(page13a, JSON.stringify(memberIds13a) === JSON.stringify([DEV_ID, SECOND_DEV_ID].sort()), 't13a-db-members', `①成员集合含两人（实得=${JSON.stringify(memberIds13a)}）`);
        const t13aErrors = filterExpectedConsoleErrors(page13a._consoleErrors);
        await shotOnFail(page13a, t13aErrors.length === 0, 't13a-console-clean', `T13① 全程无非预期 console error（实得 ${t13aErrors.length} 个）`);
        await page13a.close();

        // ②只改名称 → 库里名称变、mode 不变
        const id13b = await mkConfigProcessing(adminTok, 't13b', 'vendor', '原乙方公司');
        registerCreatedId(id13b);
        const page13b = await loginPage(browser, adminTok);
        await page13b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13b}`);
        await page13b.waitForLoadState('networkidle');
        await page13b.waitForTimeout(700);
        await page13b.click('#siDActions button:has-text("改派")');
        await page13b.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page13b.waitForTimeout(200);
        await page13b.fill('#si-reassign-vendor-name', '新乙方公司');
        await page13b.fill('#f_reason', '补丁 AD T13② 探针：只改乙方名称');
        // [补丁 AE·AE10] 捕获请求体——断发送 vendor + 新名称，且成员集合不变（仅 DEV_ID 一人）。
        const reassignRespPromise13b = page13b.waitForResponse(r => /\/api\/sys-issues\/\d+\/reassign$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
        await page13b.click('#siMConfirm');
        const reassignResp13b = await reassignRespPromise13b;
        let reassignBody13b = {};
        try { reassignBody13b = JSON.parse(reassignResp13b.request().postData() || '{}'); } catch (_) { /* 解析失败按空对象处理 */ }
        await shotOnFail(page13b, reassignBody13b.exec_mode === 'vendor' && reassignBody13b.vendor_name === '新乙方公司', 't13b-request-vendor-name', `②请求体 exec_mode='vendor' ∧ vendor_name='新乙方公司'（实得=${JSON.stringify(reassignBody13b)}）`);
        await shotOnFail(page13b, Array.isArray(reassignBody13b.member_ids) && JSON.stringify(reassignBody13b.member_ids.map(Number).sort()) === JSON.stringify([DEV_ID].sort()), 't13b-request-members-unchanged', `②请求体 member_ids 仅含原成员 DEV_ID（实得=${JSON.stringify(reassignBody13b.member_ids)}）`);
        await page13b.waitForTimeout(800);
        const modalClosed13b = await page13b.locator('#siModalOverlay.open').count();
        await shotOnFail(page13b, modalClosed13b === 0, 't13b-modal-closed', '②只改名称提交成功，弹窗关闭');
        const row13b = await dbGet('SELECT exec_mode, vendor_name FROM sys_issues WHERE id=?', [id13b]);
        await shotOnFail(page13b, !!row13b && row13b.exec_mode === 'vendor' && row13b.vendor_name === '新乙方公司', 't13b-db-name-changed', `②exec_mode 不变=vendor ∧ vendor_name 变为「新乙方公司」（实得=${JSON.stringify(row13b)}）`);
        // [补丁 AE·AE6] 时间线断言——旧/新乙方名称。
        await page13b.reload();
        await page13b.waitForLoadState('networkidle');
        await page13b.waitForTimeout(500);
        const timeline13b = await page13b.locator('.si-timeline').innerText().catch(() => '');
        await shotOnFail(page13b, /乙方名称：原乙方公司\s*→\s*新乙方公司/.test(timeline13b), 't13b-timeline-vendor-name-change', `②时间线显示乙方名称变更"原乙方公司 → 新乙方公司"（实得片段=${timeline13b.slice(-200)}）`);
        const t13bErrors = filterExpectedConsoleErrors(page13b._consoleErrors);
        await shotOnFail(page13b, t13bErrors.length === 0, 't13b-console-clean', `T13② 全程无非预期 console error（实得 ${t13bErrors.length} 个）`);
        await page13b.close();

        // ③vendor→self → vendor_name IS NULL
        const id13c = await mkConfigProcessing(adminTok, 't13c', 'vendor', '原乙方公司');
        registerCreatedId(id13c);
        const page13c = await loginPage(browser, adminTok);
        await page13c.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13c}`);
        await page13c.waitForLoadState('networkidle');
        await page13c.waitForTimeout(700);
        await page13c.click('#siDActions button:has-text("改派")');
        await page13c.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page13c.waitForTimeout(200);
        await page13c.locator('input[name="si-reassign-exec-mode"][value="self"]').check();
        await page13c.fill('#f_reason', '补丁 AD T13③ 探针：vendor 切回 self');
        await page13c.click('#siMConfirm');
        await page13c.waitForTimeout(800);
        const modalClosed13c = await page13c.locator('#siModalOverlay.open').count();
        await shotOnFail(page13c, modalClosed13c === 0, 't13c-modal-closed', '③vendor→self 提交成功，弹窗关闭');
        const row13c = await dbGet('SELECT exec_mode, vendor_name FROM sys_issues WHERE id=?', [id13c]);
        await shotOnFail(page13c, !!row13c && row13c.exec_mode === 'self' && row13c.vendor_name === null, 't13c-db-vendor-cleared', `③exec_mode=self ∧ vendor_name IS NULL（实得=${JSON.stringify(row13c)}）`);
        // [补丁 AE·AE6] 时间线断言——「乙方执行 → 本人执行」+ 名称清空展示（钉住 AD3 成果）。
        await page13c.reload();
        await page13c.waitForLoadState('networkidle');
        await page13c.waitForTimeout(500);
        const timeline13c = await page13c.locator('.si-timeline').innerText().catch(() => '');
        await shotOnFail(page13c, /执行方式：乙方执行\s*→\s*本人执行/.test(timeline13c), 't13c-timeline-exec-mode', `③时间线显示"执行方式：乙方执行 → 本人执行"（实得片段=${timeline13c.slice(-200)}）`);
        await shotOnFail(page13c, /乙方名称：原乙方公司\s*→\s*（无）/.test(timeline13c), 't13c-timeline-vendor-cleared', `③时间线显示乙方名称清空"原乙方公司 → （无）"（实得片段=${timeline13c.slice(-200)}）`);
        const t13cErrors = filterExpectedConsoleErrors(page13c._consoleErrors);
        await shotOnFail(page13c, t13cErrors.length === 0, 't13c-console-clean', `T13③ 全程无非预期 console error（实得 ${t13cErrors.length} 个）`);
        await page13c.close();

        // ④vendor 单清空名称提交 → 前端拦截（toast + 弹层不关 + 库值不变）
        // [S1d·补丁AJ·AJ3 根治·codex 515-M3] 场景逻辑抽成可复用函数——T13④正常路径与下方 AJ3 变异
        // 路径共用同一段"点击→有限观察期限（600ms，已知异步任务的等待窗口）结束后才读弹层/库值/
        // 计数"逻辑与同一条 reqCount===0 判据。原实现库值/弹层读取发生在收尾等待**之前**（"库值读取
        // 早于等待结束"），本次订正为等待先完成、读取一律排在等待之后。变异路径注入一个"仍在观察
        // 窗口内才发出"的裸 fetch，要求**这段共用逻辑本身**判红——不是另起一套独立场景断言"窗口
        // 够宽"（AI5 是那种），而是证明"如果这类场景真的存在『延迟发出多余请求』的回归，它会被这段
        // 判据本身抓到"。
        async function runVendorReassignZeroRequestScenario(page, issueId, opts = {}) {
            const { injectDelayedRequestMs = null } = opts;
            const watch = watchIssueRequests(page, issueId, 'reassign');
            let reqCount, toastAppeared, toastText, modalStillOpen, row;
            try {
                if (injectDelayedRequestMs != null) {
                    await page.evaluate((args) => {
                        setTimeout(() => {
                            fetch(`/api/sys-issues/${args.issueId}/reassign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => { /* 注入探针不关心响应 */ });
                        }, args.delayMs);
                    }, { issueId, delayMs: injectDelayedRequestMs });
                }
                ({ toastAppeared, toastText } = await clickAndAwaitNewToast(page, '#siMConfirm'));
                // 有限观察期限（600ms，明确声明为有界窗口，非自适应到"真正完成"）——已知异步任务
                // （提示/可能迟发的请求）的等待窗口结束后，才读弹层/库值/计数，顺序不再颠倒。
                await page.waitForTimeout(600);
                modalStillOpen = await page.locator('#siModalOverlay.open').count();
                row = await dbGet('SELECT exec_mode, vendor_name FROM sys_issues WHERE id=?', [issueId]);
            } finally {
                reqCount = watch.count;
                watch.stop();
            }
            return { reqCount, toastAppeared, toastText, modalStillOpen, row };
        }
        const id13d = await mkConfigProcessing(adminTok, 't13d', 'vendor', '原乙方公司');
        registerCreatedId(id13d);
        const page13d = await loginPage(browser, adminTok);
        await page13d.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13d}`);
        await page13d.waitForLoadState('networkidle');
        await page13d.waitForTimeout(700);
        await page13d.click('#siDActions button:has-text("改派")');
        await page13d.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page13d.waitForTimeout(200);
        await page13d.fill('#si-reassign-vendor-name', '');
        await page13d.fill('#f_reason', '补丁 AD T13④ 探针：清空乙方名称');
        // [补丁 AE·AE10，补丁 AF·AF7-b，S1d·513-M3，补丁 AI·AI5，补丁 AJ·AJ3 根治] 断言改派请求数为
        // 零——证明前端校验确实在发起请求之前拦下，不是"发了请求、后端拒绝、toast 恰好文案相同"这种
        // 更弱的等价现象。请求匹配精确绑定 id13d（不再用裸 \d+ 通配符）；场景逻辑走上方共用函数。
        const result13d = await runVendorReassignZeroRequestScenario(page13d, id13d);
        await shotOnFail(page13d, result13d.reqCount === 0, 't13d-request-count-zero', `④清空乙方名称提交时改派请求数为零（实得=${result13d.reqCount}）`);
        await shotOnFail(page13d, result13d.toastAppeared && /请填写乙方名称/.test(result13d.toastText || ''), 't13d-toast', `④清空乙方名称提交应报"请填写乙方名称"（toast 已出现=${result13d.toastAppeared}，实得="${result13d.toastText}"）`);
        await shotOnFail(page13d, result13d.modalStillOpen === 1, 't13d-modal-stays-open', '④清空名称提交后弹窗仍打开（未提交成功）');
        await shotOnFail(page13d, !!result13d.row && result13d.row.exec_mode === 'vendor' && result13d.row.vendor_name === '原乙方公司', 't13d-db-unchanged', `④库值不变（实得=${JSON.stringify(result13d.row)}）`);
        const t13dErrors = filterExpectedConsoleErrors(page13d._consoleErrors);
        await shotOnFail(page13d, t13dErrors.length === 0, 't13d-console-clean', `T13④ 全程无非预期 console error（实得 ${t13dErrors.length} 个）`);
        await page13d.close();

        // ═══════════════════════════════════════════════════════════════
        // AJ3（补丁 AJ·codex 515-M3）：把「延迟请求」变异注入 T13④ 复用的真实场景执行路径——要求
        // **原场景判据本身**判红，而不是另起一套独立断言证明"窗口够宽"（AI5 组是那种，二者互补：
        // AI5 证"watch 本身能等到"，AJ3 证"这段场景判据真的会被这类回归抓到"）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AJ3：把「延迟请求」变异注入 T13④ 复用的真实场景执行路径——要求原场景判据判红 ──');
        {
            const id3jVendor = await mkConfigProcessing(adminTok, 'aj3', 'vendor', '待清空乙方公司AJ3');
            registerCreatedId(id3jVendor);
            const page3j = await loginPage(browser, adminTok);
            await page3j.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3jVendor}`);
            await page3j.waitForLoadState('networkidle');
            await page3j.waitForTimeout(700);
            await page3j.click('#siDActions button:has-text("改派")');
            await page3j.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page3j.waitForTimeout(200);
            await page3j.fill('#si-reassign-vendor-name', '');
            await page3j.fill('#f_reason', 'AJ3 变异探针：验证零请求判据能捕获注入的延迟请求');

            // 注入一个 400ms 后才发出的、匹配本单 reassign 端点的裸 fetch——落在 runVendorReassign
            // ZeroRequestScenario 的 600ms 观察窗口之内。走的是**与 T13④ 完全同一份函数**，不是独立
            // 复刻的简化版。
            const resultAj3 = await runVendorReassignZeroRequestScenario(page3j, id3jVendor, { injectDelayedRequestMs: 400 });
            // [实现坏成什么样这条会红] 若真实场景（T13④）里前端真的存在"延迟发出多余 reassign 请求"
            // 这类回归，reqCount 判据会命中大于零——这正是本条要证明的：T13④ 复用的这段判据对"延迟
            // 请求"类回归有真实判别力，不是仅"更长窗口能等到"这一独立、与场景本身判据脱节的结论。
            must(resultAj3.reqCount > 0, `AJ3：注入「400ms 后发出一个额外 reassign 请求」（落在场景的 600ms 观察窗口内）后，原场景复用的零请求判据应能捕获（实得 reqCount=${resultAj3.reqCount}）——证明 T13④ 复用的这段判据对"延迟请求"类回归有真实判别力`);
            await page3j.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // AI5（补丁 AI·codex 514-M2，补丁AJ·AJ3/AJ4 订正措辞）：注入「晚于旧 600ms 固定窗口才发出
        // 的请求」——验证 watch 生命周期已真正交给场景（不再是"toast 一出现就停"这一更短窗口）。
        // 观察窗口本身仍是明确声明的**有限常量**（600ms），不是自适应的"直到真正完成"——本组只证明
        // "watch 对象能不能等到延迟请求"这一狭义命题；"场景自身的判据是否真会被这类回归判红"由 AJ3
        // 组用同一份场景函数证明，二者互补，不重复。构造反证输入：点击前于页面上下文注入一个 900ms
        // 后才发出的、匹配本单 reassign 端点的裸 fetch（不依赖真实前端代码路径是否真的会这样晚发——
        // 这是主动构造用来验证"watch 本身能不能等到"，与验证前端校验逻辑正确性的 T13④ 是两回事）。
        // 不关心该注入请求最终服务端如何响应（大概率因缺少合法鉴权而 401，watch 只关心"请求确实被
        // 浏览器发出"这一网络层事件，与响应结果无关）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AI5：注入「晚于旧 600ms 固定窗口才发出的请求」——验证 watch 生命周期已交给场景 ──');
        {
            const id5eVendor = await mkConfigProcessing(adminTok, 'ai5', 'vendor', '待清空乙方公司AI5');
            registerCreatedId(id5eVendor);
            const page5e = await loginPage(browser, adminTok);
            await page5e.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5eVendor}`);
            await page5e.waitForLoadState('networkidle');
            await page5e.waitForTimeout(700);
            await page5e.click('#siDActions button:has-text("改派")');
            await page5e.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page5e.waitForTimeout(200);
            await page5e.fill('#si-reassign-vendor-name', '');
            await page5e.fill('#f_reason', 'AI5 探针：验证 watch 生命周期覆盖延迟请求');

            const watch5e = watchIssueRequests(page5e, id5eVendor, 'reassign');
            let ai5ReqCount, toastAppearedAi5;
            try {
                await page5e.evaluate((issueId) => {
                    setTimeout(() => {
                        fetch(`/api/sys-issues/${issueId}/reassign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => { /* 注入探针不关心响应，只关心请求确实被发出 */ });
                    }, 900);
                }, id5eVendor);
                ({ toastAppeared: toastAppearedAi5 } = await clickAndAwaitNewToast(page5e, '#siMConfirm'));
                // 注入延迟为 900ms（晚于旧实现"toast 后固定等 600ms 便 stop()"的窗口）——额外再等
                // 一段确保 900ms 已经过去，才读取 watch 计数并停止监听。
                await page5e.waitForTimeout(1000);
            } finally {
                ai5ReqCount = watch5e.count;
                watch5e.stop();
            }
            must(toastAppearedAi5, 'AI5：清空乙方名称仍应先触发前端校验提示（与 T13④ 同一前置条件，确认本用例场景搭建正确）');
            // [实现坏成什么样这条会红] 若把 watch 生命周期又改回"clickAndCaptureNewToast 内部 toast
            // 出现后固定等 600ms 便 stop()"，900ms 才发出的这次注入请求会发生在 stop() 之后，不会被
            // 计入，ai5ReqCount 将为 0，本条判红。
            must(ai5ReqCount === 1, `AI5：晚于旧 600ms 固定窗口（900ms）才发出的请求仍被 watch 捕获（实得计数=${ai5ReqCount}）——证明监听生命周期已真正交给场景（不再是"toast 一出现就停"），watch 本身能等到；场景自身判据是否真会被此类回归判红见 AJ3 组`);
            await page5e.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // AE2（补丁 AE·AE2·511-B H2）：故意让指派失败——验证多阶段夹具失败路径不漏登记、不漏清理
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AE2：故意指派失败（缺 exec_mode）——验证失败路径已登记且可清理 ──');
        // 建单+受理成功（apiCreateConfig 内部已立即登记进 createdIds，不依赖后续指派是否成功）。
        idAe2 = await mkConfigToPending2(adminTok, 'ae2failassign', '二级');
        must(createdIds.includes(idAe2), `AE2：建单+受理成功的 config 单 #${idAe2} 已登记进 createdIds（登记发生在建单阶段，不依赖后续指派是否成功——511-B H2 修复点）`);
        // 故意漏传 exec_mode（config 必填，后端 EXEC_MODE_REQUIRED 400）——模拟"多阶段夹具链路中途失败"。
        const ae2AssignFailR = await fetch(`${BASE_URL}/api/sys-issues/${idAe2}/assign`, {
            method: 'POST', headers: jsonHeaders(adminTok),
            body: JSON.stringify({ assigned_to: DEV_ID }),   // 缺 exec_mode
        });
        const ae2AssignFailBody = await ae2AssignFailR.json().catch(() => null);
        must(ae2AssignFailR.status !== 200, `AE2：缺 exec_mode 的指派请求应失败（非 200，实得 ${ae2AssignFailR.status} ${JSON.stringify(ae2AssignFailBody)}）`);
        must(ae2AssignFailBody && ae2AssignFailBody.code === 'EXEC_MODE_REQUIRED', `AE2：失败原因码为 EXEC_MODE_REQUIRED（实得=${JSON.stringify(ae2AssignFailBody)}）`);
        // 指派失败后单据仍应停留在「待处理」态、exec_mode 未落库——先确认确有夹具残留证据存在（非假阳性空跑）。
        const ae2RowBeforeCleanup = await dbGet('SELECT id, status, exec_mode FROM sys_issues WHERE id=?', [idAe2]);
        must(!!ae2RowBeforeCleanup && ae2RowBeforeCleanup.status === '待处理' && ae2RowBeforeCleanup.exec_mode === null, `AE2：指派失败后单据仍停留在「待处理」∧ exec_mode 未落库（实得=${JSON.stringify(ae2RowBeforeCleanup)}）——证明确有夹具存在，非空跑一遍`);

        // ═══════════════════════════════════════════════════════════════
        // AH2（补丁 AH·Opus 预筛 H2）：注入「响应丢失」（fetch 直接 reject）——验证
        // createIssueWithRecovery 的独立标记恢复分支真的会被触发，不再是"实现了但从未跑过"的死代码。
        // codex 513-M1 原文点名的失败形态是"后端已建单但响应丢失"（连接重置/socket hang up/代理
        // 截断）——本用例借真实请求的副作用让后端真的建单成功，但不把响应交回调用方（模拟响应丢失），
        // 断言 createIssueWithRecovery 能在 fetch 本身 reject 的情况下仍走到独立标记恢复分支。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AH2：注入建单响应丢失（fetch reject）——验证独立标记恢复分支被执行且正确登记 ──');
        {
            const originalFetch = global.fetch;
            let ah2Injected = false;
            let ah2RealCreateSeen = false;
            global.fetch = async (url, opts) => {
                const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
                if (!ah2Injected && urlStr === `${BASE_URL}/api/sys-issues` && opts && opts.method === 'POST') {
                    ah2Injected = true;
                    // 借真实请求的副作用（后端确实建单成功）——但不把响应交回调用方，模拟"响应丢失/
                    // 连接重置"：后端已处理完成，客户端却拿不到响应，第一行 await fetch 应直接 reject。
                    try { await originalFetch(url, opts); ah2RealCreateSeen = true; } catch (_) { /* 真实请求本身失败也无妨，仍按下方抛错模拟网络层拒绝 */ }
                    throw new Error('AH2 注入：模拟网络层拒绝（socket hang up，响应丢失）');
                }
                return originalFetch(url, opts);
            };
            let ah2Id = null, ah2Err = null;
            try {
                const ah2Marker = nextFixtureMarker();
                seq++;
                ah2Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-ah2-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AH2 响应丢失注入测试 ${RUN_TAG_MARKER}${ah2Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, ah2Marker, 'AH2注入测试');
            } catch (e) {
                ah2Err = e;
            } finally {
                global.fetch = originalFetch;
            }
            must(ah2RealCreateSeen, 'AH2：注入的 fetch 拦截确实先让真实请求发出并被后端处理（非跳过真实网络层——模拟的是"响应丢失"而非"请求从未发出"）');
            // [实现坏成什么样这条会红] 若把 AH2 修复的 try/catch 回退成裸 `await fetch(...)`，
            // createIssueWithRecovery 会在第一行直接向上抛出本用例注入的网络错误，下面这条判红。
            must(!ah2Err, `AH2：注入响应丢失后 createIssueWithRecovery 不应向上抛异常，应走独立标记恢复分支返回 id（实得抛出=${ah2Err && ah2Err.message}）`);
            must(Number.isInteger(ah2Id) && ah2Id > 0, `AH2：恢复分支返回有效正整数 id（实得=${ah2Id}）`);
            if (Number.isInteger(ah2Id)) {
                const ah2Row = await dbGet(`SELECT id, type, status FROM sys_issues WHERE id=?`, [ah2Id]);
                must(!!ah2Row && ah2Row.type === 'config', `AH2：恢复分支登记的 id 确实对应一条真实 config 记录（实得=${JSON.stringify(ah2Row)}）`);
                must(createdIds.includes(ah2Id), `AH2：该 id 已登记进 createdIds（供收尾清理，实得=${createdIds.includes(ah2Id)}）`);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // AI1（补丁 AI·codex 514-H1）：注入「201 返回既有单 B 的合法 id」——验证正常响应分支也会核对
        // 独立标记∧运行标记∧类型三要素，不因状态码/JSON/id 结构都合法就直接信任 body.id。
        // 证伪构造：先建一张真实存在、与本次注入无关的独立单据 B（正常路径登记）；再拦截真实建单请求——
        // 让真实请求照常发出（后端真实建出新夹具 A），但返回给调用方的是"状态码 201 + body.id 换成 B
        // 的 id"这一伪造响应体（模拟响应体被错配成另一张单）。断言：createIssueWithRecovery 不应信任
        // 该 id，应识别核对失败并改走独立标记恢复分支正确定位到 A；B 全字段前后逐一对拍应完全不变
        // （未被误登记/误改/误删）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AI1：注入「201 返回既有单 B 的 id」——验证正常响应分支三要素核对不误取 B ──');
        {
            const idB = await mkConfigPending(adminTok, 'ai1-b');
            registerCreatedId(idB);
            const bBefore = await dbGet('SELECT * FROM sys_issues WHERE id=?', [idB]);
            must(!!bBefore, `AI1 前置：既有单 B 真实存在（id=${idB}）`);

            const originalFetch = global.fetch;
            let ai1RealCreateIdSeen = null;
            const ai1Marker = nextFixtureMarker();
            global.fetch = async (url, opts) => {
                const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
                const bodyStr = (opts && typeof opts.body === 'string') ? opts.body : '';
                if (urlStr === `${BASE_URL}/api/sys-issues` && opts && opts.method === 'POST' && bodyStr.includes(ai1Marker)) {
                    // 借真实请求的副作用——后端确实建出新夹具 A；但向调用方返回伪造响应体（id 换成 B）。
                    const realResp = await originalFetch(url, opts);
                    const realBody = await realResp.json().catch(() => null);
                    if (realBody && Number.isInteger(realBody.id)) ai1RealCreateIdSeen = realBody.id;
                    return new Response(JSON.stringify({ id: idB, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
                }
                return originalFetch(url, opts);
            };
            let ai1Id = null, ai1Err = null;
            seq++;
            try {
                ai1Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-ai1-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AI1注入测试：201响应体id错配为既有单B ${RUN_TAG_MARKER}${ai1Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, ai1Marker, 'AI1注入测试');
            } catch (e) {
                ai1Err = e;
            } finally {
                global.fetch = originalFetch;
            }
            must(Number.isInteger(ai1RealCreateIdSeen) && ai1RealCreateIdSeen > 0 && ai1RealCreateIdSeen !== idB, `AI1：注入前确实先让真实请求发出并建成一张全新夹具 A（实得真实建单 id=${ai1RealCreateIdSeen}，B=${idB}）`);
            // [实现坏成什么样这条会红] 若把 AI1 修复的三要素核对删掉、回退成"状态码/JSON/id 结构合法即登记"，
            // 本条会直接登记 idB=B（因为伪造响应体状态码 201 且 id 为合法正整数），ai1Id===idB 会成立、
            // 下面"ai1Id !== idB"这条判红——真实新建的 A 反而会因未被登记而在收尾扫描留下未登记残留。
            must(!ai1Err, `AI1：注入「201 返回既有单 B 的 id」后 createIssueWithRecovery 不应向上抛异常，应识别三要素核对失败并改走独立标记恢复分支（实得抛出=${ai1Err && ai1Err.message}）`);
            must(Number.isInteger(ai1Id) && ai1Id > 0 && ai1Id !== idB, `AI1：恢复分支返回的 id 应为真实新建的 A，且≠误配的既有单 B（实得=${ai1Id}，B=${idB}）`);
            must(ai1Id === ai1RealCreateIdSeen, `AI1：恢复分支登记的 id 与真实新建的 A 一致（实得=${ai1Id}，真实创建=${ai1RealCreateIdSeen}）`);
            must(createdIds.includes(ai1Id) && createdIds.filter(x => x === ai1Id).length === 1, `AI1：A 已恰好登记一次进 createdIds（供收尾清理，实得出现次数=${createdIds.filter(x => x === ai1Id).length}）`);

            const bAfter = await dbGet('SELECT * FROM sys_issues WHERE id=?', [idB]);
            must(JSON.stringify(bBefore) === JSON.stringify(bAfter), `AI1：既有单 B 全字段前后逐一对拍完全一致，未被本次注入误改（before=${JSON.stringify(bBefore)}, after=${JSON.stringify(bAfter)}）`);
            must(createdIds.filter(x => x === idB).length === 1, `AI1：既有单 B 未被重复/误登记进 createdIds（应恰好登记一次，来自其自身正常建单，实得出现次数=${createdIds.filter(x => x === idB).length}）`);
        }

        // ═══════════════════════════════════════════════════════════════
        // AI4（补丁 AI·codex 514-M1）：注入「先向调用方拒绝、后完成真实建单」时序——验证有界轮询
        // （5×200ms=1000ms）能等到延迟提交并正确恢复所有权，且全程只发出一次建单请求（不自动重发）。
        // 证伪构造：拦截真实建单请求——立即向调用方抛出网络层拒绝（模拟客户端判定连接失败），但真实
        // 请求延迟 300ms 后才异步发出（早于 1000ms 轮询窗口，验证轮询确实会等，而非只在第一次查询
        // 就放弃）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AI4：注入「先拒绝、后延迟提交」时序——验证有界轮询恢复 + 不自动重发 ──');
        {
            const originalFetch = global.fetch;
            const ai4Marker = nextFixtureMarker();
            let ai4CallCount = 0;
            let ai4RealCreateResolved = false;
            global.fetch = async (url, opts) => {
                const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
                const bodyStr = (opts && typeof opts.body === 'string') ? opts.body : '';
                if (urlStr === `${BASE_URL}/api/sys-issues` && opts && opts.method === 'POST' && bodyStr.includes(ai4Marker)) {
                    ai4CallCount++;
                    // 真实请求异步延迟 300ms 后才发出——模拟"客户端已判定连接失败，服务端稍后才真正
                    // 收到并提交"；不阻塞对调用方的拒绝，调用方应立即收到失败。
                    setTimeout(() => {
                        originalFetch(url, opts).then(() => { ai4RealCreateResolved = true; }).catch(() => { /* 真实请求本身失败也无妨，本用例只关心恢复分支的行为 */ });
                    }, 300);
                    throw new Error('AI4 注入：模拟客户端先于服务端提交判定为失败（响应丢失/连接重置），真实请求延迟 300ms 后才发出');
                }
                return originalFetch(url, opts);
            };
            let ai4Id = null, ai4Err = null;
            seq++;
            try {
                ai4Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-ai4-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AI4注入测试：延迟提交时序 ${RUN_TAG_MARKER}${ai4Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, ai4Marker, 'AI4注入测试');
            } catch (e) {
                ai4Err = e;
            } finally {
                global.fetch = originalFetch;
            }
            must(ai4CallCount === 1, `AI4：本次建单调用全程仅触发一次向 /api/sys-issues 的 POST 请求（禁止自动重发，实得调用次数=${ai4CallCount}）`);
            // [实现坏成什么样这条会红] 若把 AI4 的有界轮询回退成"只查一次立即返回"，本条会因 300ms
            // 延迟提交尚未完成而查不到、直接抛"未确认"异常，ai4Err 非空，下面这条判红。
            must(!ai4Err, `AI4：有界轮询（5×200ms=1000ms）应等到 300ms 后的延迟提交完成并正确恢复所有权，不应向上抛异常（实得抛出=${ai4Err && ai4Err.message}）`);
            must(Number.isInteger(ai4Id) && ai4Id > 0, `AI4：延迟提交完成后恢复分支返回有效正整数 id（实得=${ai4Id}）`);
            if (Number.isInteger(ai4Id)) {
                must(ai4RealCreateResolved, 'AI4：真实建单请求确实在延迟后完成（非跳过真实网络层）');
                const ai4Row = await dbGet(`SELECT id, type FROM sys_issues WHERE id=?`, [ai4Id]);
                must(!!ai4Row && ai4Row.type === 'config', `AI4：恢复分支登记的 id 确实对应一条真实 config 记录（实得=${JSON.stringify(ai4Row)}）`);
                must(createdIds.includes(ai4Id), 'AI4：该 id 已登记进 createdIds（供收尾清理）');
            }
            must(!pendingFixtures.has(ai4Marker), 'AI4：本用例的延迟提交在轮询窗口内被等到并成功核验，不应仍留在 pendingFixtures（那是尚未确认所有权的情形，本用例不构成该情形）');
        }

        // ═══════════════════════════════════════════════════════════════
        // AJ2-1（补丁 AJ·codex 515-M2）：注入「claim 查询本身异常」——验证 pendingFixtures 保留 +
        // 明确抛出查询异常，不静默吞、不误判核对通过/核对失败。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AJ2-1：注入「claim 查询本身异常」——验证 pendingFixtures 保留 + 明确抛出 ──');
        {
            const aj21Marker = nextFixtureMarker();
            const originalDbGetMethod = db.get.bind(db);
            let injectedOnce = false;
            let capturedRealId = null;
            // db 是 const 声明的连接对象，但其方法属性可临时替换（同 AH2/AI1 monkey-patch global.fetch
            // 同一手法，只是这次要拦的是数据库查询而非网络请求）；只拦第一次匹配到 claim 查询语句的调用，
            // 拿到真实响应 id（params[0]）后立即向回调抛异常模拟"查询本身异常"，其余调用一律走原实现。
            db.get = function (sql, params, cb) {
                if (!injectedOnce && typeof sql === 'string' && sql.includes('SELECT id, type, description FROM sys_issues WHERE id=?')) {
                    injectedOnce = true;
                    capturedRealId = Array.isArray(params) ? params[0] : null;
                    return cb(new Error('AJ2-1 注入：模拟 claim 查询本身抛出数据库异常'));
                }
                return originalDbGetMethod(sql, params, cb);
            };
            let aj21Id = null, aj21Err = null;
            seq++;
            try {
                aj21Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-aj21-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AJ2-1注入测试：claim查询异常 ${RUN_TAG_MARKER}${aj21Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, aj21Marker, 'AJ2-1注入测试');
            } catch (e) {
                aj21Err = e;
            } finally {
                db.get = originalDbGetMethod;
            }
            // [实现坏成什么样这条会红] 若把 claim 查询异常的 try/catch 删掉，异常会从 dbGet 直接冒泡，
            // 但不会打上 [AJ2 claim查询异常] 标签、也不会写 pendingFixtures.lastError——下面两条判红。
            must(!!aj21Err && /AJ2 claim查询异常/.test(aj21Err.message), `AJ2-1：claim 查询异常时应明确抛出且带 AJ2 标签（不静默吞），实得抛出=${aj21Err && aj21Err.message}`);
            must(pendingFixtures.has(aj21Marker), 'AJ2-1：claim 查询异常时该夹具标记应仍留在 pendingFixtures（不移除、不静默确认）');
            const aj21Pending = pendingFixtures.get(aj21Marker);
            must(!!aj21Pending && /claim 查询异常/.test(aj21Pending.lastError || ''), `AJ2-1：pendingFixtures 条目的 lastError 应记录 claim 查询异常（实得=${aj21Pending && aj21Pending.lastError}）`);
            // 人工核实收尾：真实请求已经成功建单（capturedRealId 就是被注入异常打断前 claim 查询的
            // 目标 id），查库确认该行真实存在且携带本次独立标记，手动登记+移出 pendingFixtures——
            // 避免残留到套件末尾触发 AJ2 的整体失败判定（本用例只验证"异常时的行为"，不代表这张单
            // 应该被当成真实残留处理）。
            must(Number.isInteger(capturedRealId) && capturedRealId > 0, `AJ2-1：确实捕获到了一个真实的响应 id（实得=${capturedRealId}）`);
            const aj21RealRow = await dbGet(`SELECT id, type, description FROM sys_issues WHERE id=?`, [capturedRealId]);
            must(!!aj21RealRow && aj21RealRow.type === 'config' && typeof aj21RealRow.description === 'string' && aj21RealRow.description.includes(aj21Marker), `AJ2-1：人工核实——真实建单确已成功且携带本次独立标记（实得=${JSON.stringify(aj21RealRow)}）`);
            registerCreatedId(capturedRealId);
            pendingFixtures.delete(aj21Marker);
        }

        // ═══════════════════════════════════════════════════════════════
        // AJ2-2（补丁 AJ·codex 515-M2）：注入「超过轮询期限才提交」——真正触发 timeout 结局（区别于
        // AI4 的 300ms 用例，那个在窗口内被轮询等到，从未真正走到 timeout 分支）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AJ2-2：注入「超过轮询期限才提交」——验证真正触发 timeout 结局 ──');
        {
            const originalFetch = global.fetch;
            const aj22Marker = nextFixtureMarker();
            let aj22RealCreateResolved = false, aj22RealId = null;
            global.fetch = async (url, opts) => {
                const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
                const bodyStr = (opts && typeof opts.body === 'string') ? opts.body : '';
                if (urlStr === `${BASE_URL}/api/sys-issues` && opts && opts.method === 'POST' && bodyStr.includes(aj22Marker)) {
                    // 延迟 1300ms——晚于 POLL_WINDOW_MS=1000ms，真正触发 timeout（AI4 用例的 300ms
                    // 延迟在窗口内被轮询等到，从未真正走到本用例要证的这条分支）。
                    setTimeout(() => {
                        originalFetch(url, opts).then(async (r) => {
                            aj22RealCreateResolved = true;
                            try { const b = await r.json(); aj22RealId = b && b.id; } catch (_) { /* 不影响本用例主判据 */ }
                        }).catch(() => { /* 真实请求本身失败也无妨，本用例只关心 timeout 分支的行为 */ });
                    }, 1300);
                    throw new Error('AJ2-2 注入：模拟客户端先于服务端提交判定为失败，真实请求延迟 1300ms 后才发出（超过轮询期限）');
                }
                return originalFetch(url, opts);
            };
            let aj22Id = null, aj22Err = null;
            seq++;
            try {
                aj22Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-aj22-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AJ2-2注入测试：超过轮询期限才提交 ${RUN_TAG_MARKER}${aj22Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, aj22Marker, 'AJ2-2注入测试');
            } catch (e) {
                aj22Err = e;
            } finally {
                global.fetch = originalFetch;
            }
            // [实现坏成什么样这条会红] 若轮询期限仍按"次数×固定间隔"计算且四舍五入算错，真实耗时可能
            // 短于 1300ms 就已耗尽，本条判红的窗口对不齐；用截止时间定义后，本条稳定在略高于 1000ms
            // 判定 timeout，可靠区分于 AI4 的 300ms 命中窗口内。
            must(!!aj22Err && /AJ2 所有权未确认/.test(aj22Err.message), `AJ2-2：超过轮询期限应真正触发 timeout 结局并抛出（实得抛出=${aj22Err && aj22Err.message}）`);
            must(aj22Id === null, 'AJ2-2：超时时不应返回任何 id');
            must(pendingFixtures.has(aj22Marker), 'AJ2-2：超时后该夹具标记应仍留在 pendingFixtures');
            // 等待延迟的真实请求真正落地（1300ms 已过去，再加缓冲确保 HTTP 响应处理完成）。
            await new Promise((r) => setTimeout(r, 500));
            must(aj22RealCreateResolved, 'AJ2-2：真实建单请求最终确实完成（证明"超时"不等于"没建成"，只是本次调用窗口内无法确认所有权）');
            must(Number.isInteger(aj22RealId) && aj22RealId > 0, `AJ2-2：真实建单最终返回了有效 id（实得=${aj22RealId}）`);
            registerCreatedId(aj22RealId);
            pendingFixtures.delete(aj22Marker);
        }

        // ═══════════════════════════════════════════════════════════════
        // AJ2-3（补丁 AJ·codex 515-M2）：注入「标记截断」——真实响应 201 且 id 合法，但落库的
        // description 里 fixtureMarker 被截断（保留 RUN_TAG_MARKER 完整），claim 核对与轮询都因此
        // 失效。验证：即便所有基于 marker 的核对手段全部失效，pendingFixtures（发送前登记）仍如实
        // 记录"发生过一次未被确认的建单尝试"——这正是"发送前登记"设计相对"轮询耗尽后才登记"的核心
        // 价值：后者在本场景下会完全不知道曾经尝试过这次建单。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── AJ2-3：注入「标记截断」——验证 pendingFixtures 是唯一存活的证据来源 ──');
        {
            const originalFetch = global.fetch;
            const aj23Marker = nextFixtureMarker();
            const truncatedMarker = aj23Marker.slice(0, Math.floor(aj23Marker.length / 2));
            let aj23RealId = null;
            global.fetch = async (url, opts) => {
                const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
                const bodyStr = (opts && typeof opts.body === 'string') ? opts.body : '';
                if (urlStr === `${BASE_URL}/api/sys-issues` && opts && opts.method === 'POST' && bodyStr.includes(aj23Marker)) {
                    const bodyObj = JSON.parse(opts.body);
                    bodyObj.description = bodyObj.description.replace(aj23Marker, truncatedMarker);
                    const realResp = await originalFetch(url, { ...opts, body: JSON.stringify(bodyObj) });
                    const realBody = await realResp.json().catch(() => null);
                    if (realBody && Number.isInteger(realBody.id)) aj23RealId = realBody.id;
                    // 把真实响应（未篡改）原样交还给调用方——调用方看到的是"正常 201 响应"，但库里
                    // 实际存的 description 已经被截断，这正是本用例要模拟的错位。
                    return new Response(JSON.stringify(realBody), { status: realResp.status, headers: { 'Content-Type': 'application/json' } });
                }
                return originalFetch(url, opts);
            };
            let aj23Id = null, aj23Err = null;
            seq++;
            try {
                aj23Id = await createIssueWithRecovery(adminTok, 'config', {
                    intake_contract_version: 2, type: 'config', title: `${TITLE_PREFIX}-aj23-${RUN_TAG}-${seq}`,
                    system_name: 'BMS', source: '内部',
                    description: `AJ2-3注入测试：标记截断 ${RUN_TAG_MARKER}${aj23Marker}`,
                    intake_liaison_id: LIAISON_ID,
                }, aj23Marker, 'AJ2-3注入测试');
            } catch (e) {
                aj23Err = e;
            } finally {
                global.fetch = originalFetch;
            }
            // [实现坏成什么样这条会红] 若"发送前登记"退化回"轮询耗尽后才登记"（AI4 版本的行为），
            // 本用例里 claim 核对与轮询全部失效，pendingFixtures 会永远不知道曾经发生过这次尝试——
            // 下面 pendingFixtures.has() 这条判据在旧版本上会判红（因为集合里根本没有这一条）。
            must(!!aj23Err, `AJ2-3：标记截断导致 claim 核对与轮询均无法匹配，应抛出异常（不误判成功），实得抛出=${aj23Err && aj23Err.message}`);
            must(aj23Id === null, 'AJ2-3：标记截断场景下不应返回任何 id（不确定所有权不登记）');
            must(pendingFixtures.has(aj23Marker), 'AJ2-3：标记截断后该夹具标记应仍留在 pendingFixtures——这是"发送前登记"设计的核心价值：即便所有基于 marker 的核对手段全部失效，登记表本身仍如实记录"发生过一次未被确认的建单尝试"');
            must(Number.isInteger(aj23RealId) && aj23RealId > 0, `AJ2-3：测试 harness 通过拦截真实响应捕获到了真实创建的 id（实得=${aj23RealId}）——证明行确实建成功了，只是产品代码自身的核对机制因标记截断而失效`);
            const aj23RealRow = await dbGet(`SELECT id, type, description FROM sys_issues WHERE id=?`, [aj23RealId]);
            must(!!aj23RealRow && typeof aj23RealRow.description === 'string' && !aj23RealRow.description.includes(aj23Marker) && aj23RealRow.description.includes(RUN_TAG_MARKER), `AJ2-3：人工核实——真实落库的 description 确实不含完整 fixtureMarker（已截断）但仍含 RUN_TAG_MARKER（实得=${JSON.stringify(aj23RealRow)}）`);
            registerCreatedId(aj23RealId);
            pendingFixtures.delete(aj23Marker);
        }

        // ═══════════════════════════════════════════════════════════════
        // T14（补丁 AD·AD1）：OA 补填号入口——config 可见 + 文案不含必填措辞；improvement/bug 对照
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T14：OA 补填号入口 config 可见（AD1） ──');
        const id14 = await mkConfigProcessing(adminTok, 't14', 'self');
        registerCreatedId(id14);
        const page14 = await loginPage(browser, adminTok);
        await page14.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id14}`);
        await page14.waitForLoadState('networkidle');
        await page14.waitForTimeout(700);
        const oaBtnCount14 = await page14.locator('#siDActions button:has-text("补填 OA 号")').count();
        await shotOnFail(page14, oaBtnCount14 === 1, 't14-oa-btn-visible', `config「处理中」态 admin 可见「补填 OA 号」入口（实得按钮数=${oaBtnCount14}）`);
        await page14.click('#siDActions button:has-text("补填 OA 号")');
        await page14.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page14.waitForTimeout(200);
        const oaModalText14 = await page14.locator('#siMBody').innerText().catch(() => '');
        await shotOnFail(page14, !/必填/.test(oaModalText14) && !/否则.*指派.*拒绝/.test(oaModalText14), 't14-no-required-wording', `config OA 弹层文案不含"必填/否则指派会被拒绝"类措辞（实得片段="${oaModalText14.slice(0, 120)}"）`);
        const oaRequiredMark14 = await page14.locator('#siMBody label:has-text("OA 流程号") .u-req').count();
        await shotOnFail(page14, oaRequiredMark14 === 0, 't14-no-required-asterisk', 'config OA 号输入框不应带必填星号');
        await page14.fill('#f_oa_number', '20260908001');
        await page14.click('#siMConfirm');
        await page14.waitForTimeout(800);
        const modalClosed14 = await page14.locator('#siModalOverlay.open').count();
        await shotOnFail(page14, modalClosed14 === 0, 't14-modal-closed', '填号提交成功，弹窗关闭');
        const row14 = await dbGet('SELECT oa_number FROM sys_issues WHERE id=?', [id14]);
        await shotOnFail(page14, !!row14 && row14.oa_number === '20260908001', 't14-db-oa-number', `直查库 oa_number 已落库（实得=${JSON.stringify(row14)}）`);
        const t14Errors = filterExpectedConsoleErrors(page14._consoleErrors);
        await shotOnFail(page14, t14Errors.length === 0, 't14-console-clean', `T14 全程无非预期 console error（实得 ${t14Errors.length} 个）`);
        await page14.close();

        // improvement 对照——仍显示必填文案（只需推进到「待指派」，OA 入口已可见，无需走完整验证链路）
        // [S1d·513-M1] 建单步骤改走 createIssueWithRecovery（与其余三处 API 建单同款响应异常恢复）。
        seq++;
        const fixtureMarkerT14Imp = nextFixtureMarker();
        const id14Imp = await createIssueWithRecovery(adminTok, 'improvement', {
            intake_contract_version: 2, type: 'improvement', title: `${TITLE_PREFIX}-t14imp-${RUN_TAG}-${seq}`,
            system_name: 'BMS', source: '内部', description: `T14 improvement 对照组夹具 ${RUN_TAG_MARKER}${fixtureMarkerT14Imp}`, intake_liaison_id: LIAISON_ID,
        }, fixtureMarkerT14Imp, 'T14 improvement建单');
        const intakeAcceptR14 = await fetch(`${BASE_URL}/api/sys-issues/${id14Imp}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ risk_level: '二级' }) });
        if (intakeAcceptR14.status !== 200) throw new Error(`[夹具-T14 improvement受理] 应 200，实得 ${intakeAcceptR14.status} ${JSON.stringify(await intakeAcceptR14.json().catch(() => null))}`);
        const page14b = await loginPage(browser, adminTok);
        await page14b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id14Imp}`);
        await page14b.waitForLoadState('networkidle');
        await page14b.waitForTimeout(700);
        const oaBtnCount14b = await page14b.locator('#siDActions button:has-text("补填 OA 号")').count();
        await shotOnFail(page14b, oaBtnCount14b === 1, 't14-improvement-oa-btn-visible', `对照组：improvement「待指派」态仍可见「补填 OA 号」入口（实得按钮数=${oaBtnCount14b}）`);
        await page14b.click('#siDActions button:has-text("补填 OA 号")');
        await page14b.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page14b.waitForTimeout(200);
        const oaModalText14b = await page14b.locator('#siMBody').innerText().catch(() => '');
        await shotOnFail(page14b, /必填/.test(oaModalText14b), 't14-improvement-required-wording', `对照组：improvement OA 弹层文案仍含"必填"（实得片段="${oaModalText14b.slice(0, 120)}"）`);
        const t14bErrors = filterExpectedConsoleErrors(page14b._consoleErrors);
        await shotOnFail(page14b, t14bErrors.length === 0, 't14b-console-clean', `T14 improvement 对照组全程无非预期 console error（实得 ${t14bErrors.length} 个）`);
        await page14b.close();

        // ═══════════════════════════════════════════════════════════════
        // T15：上线单「加单」候选列表能看到 config 待上线单
        //   [S1h·2026-09-08 用户实测抓出的缺口·失源过滤第三例]
        //   背景：S1a 把 config 并入后端 RELEASABLE_TYPES、add-issues 的 type 闸随之放行，但前端
        //   siModalAddToBatch 的候选过滤里还硬编码着 `i.type !== 'config'`（在 config 不可发布的
        //   年代那是正确的同源过滤），没跟着改 ⇒ **后端能加、前端候选里根本看不到**。
        //   ⚠️ 这个洞躲过了全部 19 轮审查与 248 项 Playwright：后端 verify 全绿（直接调 API 挂批次）、
        //   §7 验证矩阵的「上线单」层测的也是 execute/混批/撤单，**没有一格覆盖「用户在界面上能不能
        //   选到它」**。本组就是补这张末端网——[[feedback_layer_green_not_feature_ready]] 的实例。
        //   断言对象：加单弹层的候选行 DOM（不是 API 响应，不是库值）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T15：上线单「加单」候选含 config 待上线单（S1h·失源过滤第三例） ──');
        const id15 = await mkConfigPreRelease(adminTok, devTok, 't15');
        registerCreatedId(id15);
        // improvement 对照组——证明修复没有把过滤「改坏成全放开也全丢」，既有可发布类型仍在候选里
        const id15Imp = await mkImprovementPreRelease(adminTok, devTok, 't15imp');
        registerCreatedId(id15Imp);
        // [补丁 AQ·codex 524-M2] 建批次改「先登记后校验」：响应丢失/解析失败/结构不符时，批次可能
        //   已在服务端建出——先按唯一 version_tag 回库恢复定位再登记，绝不让它脱离清理面。
        const relTag15 = `t15-${RUN_TAG}`;
        let relId15 = null;
        // ⭐ [补丁 AR·codex 525-M2] tag **先于请求**登记——即便请求本身抛异常/进程在此刻被打断，
        //   收尾也拿得到线索去有界重查；拿到 id 后才解析掉它。
        registerPendingReleaseTag(relTag15);
        try {
            const relR15 = await fetch(`${BASE_URL}/api/sys-releases`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ version_tag: relTag15 }) });
            const relBody15 = await relR15.json().catch(() => null);
            if (relR15.status === 201 && relBody15 && Number.isInteger(relBody15.id) && relBody15.id > 0) {
                relId15 = relBody15.id;
                registerCreatedReleaseId(relId15);
                resolvePendingReleaseTag(relTag15);   // 已拿到确切 id，tag 不再需要
            } else {
                throw new Error(`建批次响应异常：${relR15.status} ${JSON.stringify(relBody15)}`);
            }
        } catch (eRel15) {
            // 不在此处做一次性恢复查询（可能查早于服务端提交）——把 tag 留在登记表，交给收尾有界重查
            throw new Error(`[T15 夹具-建批次] ${eRel15.message}｜tag "${relTag15}" 已留在待恢复登记表，由收尾步骤④有界重查并清理`);
        }

        const page15 = await loginPage(browser, adminTok);
        try {
            // ⭐ [补丁 AQ·codex 524-M1 根治] 首版用 page.evaluate 直接驱动 siModalAddToBatch——只证明
            //   「函数能渲染候选」，**发现不了**「加单」按钮被隐藏／onclick 绑定失效／传错批次 id／
            //   勾选后提交链路损坏。而本次缺陷的类别恰恰就是**界面可达性**，用白盒驱动去测它等于没测。
            //   改为**真实界面闭环**：深链开批次详情 → 真点「+ 加单」→ 真勾选 → 真提交 → 断言库值。
            await page15.goto(`${BASE_URL}/Sys_Iteration.html?release=${relId15}`);
            await page15.waitForLoadState('networkidle');
            await page15.waitForTimeout(900);
            const addBtn15 = page15.locator('#siBatchOverlay button:has-text("+ 加单")');
            const addBtnCount15 = await addBtn15.count();
            await shotOnFail(page15, addBtnCount15 === 1, 't15-add-button-visible',
                `⭐ 批次详情里「+ 加单」按钮真实可见（实得按钮数=${addBtnCount15}）——白盒驱动测不出按钮被隐藏，故本条走真实 DOM`);
            if (addBtnCount15 === 1) await addBtn15.click();
            await page15.waitForSelector('#siModalOverlay.open', { timeout: 8000 });
            await page15.waitForTimeout(300);
            const cfgChk15 = page15.locator(`#siMBody input.si-add-chk[value="${id15}"]`);
            const cfgChkCount15 = await cfgChk15.count();
            const impChkCount15 = await page15.locator(`#siMBody input.si-add-chk[value="${id15Imp}"]`).count();
            await shotOnFail(page15, cfgChkCount15 === 1, 't15-config-candidate-present',
                `⭐ config 待上线单 #${id15} 出现在加单候选里（实得复选框数=${cfgChkCount15}；修复前此处恒为 0——前端 filter 排除了 config，用户在界面上根本选不到）`);
            await shotOnFail(page15, impChkCount15 === 1, 't15-improvement-candidate-present',
                `对照组：improvement 待上线单 #${id15Imp} 同样在候选里（实得复选框数=${impChkCount15}）——证明放开 config 没有把既有类型一并滤掉`);
            if (cfgChkCount15 === 1) {
                // [补丁 AQ·codex 524 问项3] 类型标签断言收紧——原先扫整个 #siMBody，可能被**别的候选行**
                //   的标签满足；改为从目标复选框定位到它所属的那一行，只断该行内的类型标签。
                const cfgRowText15 = await cfgChk15.locator('xpath=ancestor::label[1]').innerText().catch(() => '');
                await shotOnFail(page15, /配置变更/.test(cfgRowText15), 't15-config-type-tag',
                    `#${id15} **所在候选行内**渲染出「配置变更」类型标签（实得该行文本="${cfgRowText15.slice(0, 120)}"）`);
                // ⭐ 真实提交闭环——本次缺陷是界面可达性，必须点到底、并回库验证
                await cfgChk15.check();
                await page15.click('#siMConfirm');
                await page15.waitForTimeout(1500);
                const modalClosed15 = await page15.locator('#siModalOverlay.open').count();
                await shotOnFail(page15, modalClosed15 === 0, 't15-submit-modal-closed',
                    `⭐ 勾选 config 单后点「确定」提交成功、弹层关闭（实得仍打开数=${modalClosed15}）——覆盖「勾选→提交」链路`);
                const rowAfter15 = await dbGet('SELECT release_id, status FROM sys_issues WHERE id=?', [id15]);
                await shotOnFail(page15, !!rowAfter15 && rowAfter15.release_id === relId15, 't15-db-release-id',
                    `⭐ 直查库：#${id15} 的 release_id 已落为目标批次 #${relId15}（实得=${JSON.stringify(rowAfter15)}）——端到端真加进去了，不是只看界面`);
                // [补丁 AR·codex 525-M1 根治] 原断言只检查「上线单成员」**标题**——空成员区、或提交后
                //   面板未刷新，都能通过；库里 release_id 对了也**不证明用户在批次详情看得到那张单**。
                //   改为按**该单据自己的详情链接**精确定位成员行（模板见 Sys_Iteration.html:9379
                //   `<a class="si-att-name" onclick="siCloseBatch();siOpenDrawer(<issueId>)">`），并断可见。
                const memberRow15 = page15.locator(`#siBatchOverlay a.si-att-name[onclick*="siOpenDrawer(${id15})"]`);
                await memberRow15.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { /* 由下方断言判红 */ });
                const memberRowVisible15 = await memberRow15.isVisible().catch(() => false);
                const memberRowText15 = memberRowVisible15 ? await memberRow15.innerText().catch(() => '') : '';
                await shotOnFail(page15, memberRowVisible15, 't15-member-row-visible',
                    `⭐ 批次详情成员区出现 **#${id15} 自己那一行**且可见（按详情链接 siOpenDrawer(${id15}) 精确定位；实得可见=${memberRowVisible15}，行文本="${memberRowText15.slice(0, 80)}"）——只断「上线单成员」标题会被空成员区/未刷新面板蒙混`);
            }
            const t15Errors = filterExpectedConsoleErrors(page15._consoleErrors);
            await shotOnFail(page15, t15Errors.length === 0, 't15-console-clean', `T15 全程无非预期 console error（实得 ${t15Errors.length} 个）`);
        } finally {
            // [补丁 AQ·codex 524 问项3] 页面单独 finally 关闭——异常时不再挂到浏览器整体退出
            await page15.close().catch(() => { /* 关闭失败不掩盖原始错误 */ });
        }

        console.log(`\n合计（变异前）${pass} PASS / ${fail} FAIL`);

        // ═══════════════════════════════════════════════════════════════
        // MUT1：撤去 accept 单选默认 checked → T6 的"默认 release 已勾选"DOM 断言应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT1：撤去 accept online_mode 单选默认 checked → 默认勾选断言应判红 ──');
        const idMut1 = await mkConfigVerify(adminTok, devTok, 'mut1');
        registerCreatedId(idMut1);
        // [补丁 AE·AE5·511-B M2] 正向对照——同一夹具变异前先验证默认行为正确（证明该组在正常态下绿，
        // 不是"从未测过就直接注入"）。不提交，关页即可，避免推进单据状态影响下面的变异测。
        const pageMut1Ctrl = await loginPage(browser, adminTok);
        await pageMut1Ctrl.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idMut1}`);
        await pageMut1Ctrl.waitForLoadState('networkidle');
        await pageMut1Ctrl.waitForTimeout(700);
        await pageMut1Ctrl.click('#siDActions button:has-text("验收通过")');
        await pageMut1Ctrl.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await pageMut1Ctrl.waitForTimeout(200);
        const releaseCheckedCtrl1 = await pageMut1Ctrl.locator('input[name="si-accept-online-mode"][value="release"]').isChecked().catch(() => false);
        must(releaseCheckedCtrl1, '[MUT1 正向对照] 变异前：同一夹具 online_mode 默认勾选 release（证明该组正常态下绿）');
        await pageMut1Ctrl.close();

        const mut1Marker = '<label class="si-radio-opt"><input type="radio" name="si-accept-online-mode" value="release" checked onchange="siAcceptOnlineModeChanged()">';
        // ⚠️ 排雷记录：本标记必须是**合法 HTML 属性**，不能用 `/* ... */` JS 注释语法——这里是 HTML 属性
        // 列表上下文（不在 <script> 内），HTML 解析器不认识 C 风格注释，会把 `/* MUTATION-TEST-TEMP-
        // REMOVE: checked */` 逐词切成三个野属性 `*=""` `mutation-test-temp-remove:=""` `checked=""`——
        // 注释文本里恰好含"checked"这个词，被解析成一个真实的布尔属性，等于把刚删掉的 checked 原样
        // 加了回来（首次实现踩过、诊断脚本 E:/tmp/lt0907-s1c-pw-run8-diag.log 抓到 outerHTML 实证）。
        // 改用合法的 data-* 自定义属性承载同一个可扫描标记字符串。
        const mut1Replacement = '<label class="si-radio-opt"><input type="radio" name="si-accept-online-mode" value="release" data-mutation-test-temp-remove="checked" onchange="siAcceptOnlineModeChanged()">';
        // [补丁 AF·AF2·512-H2] 改用 page.route 内存拦截——不再读写磁盘文件，无 try/finally 恢复责任。
        const pageMut1 = await loginPage(browser, adminTok);
        const mut1State = await routeMutatedIterationPage(pageMut1, mut1Marker, mut1Replacement);
        await pageMut1.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idMut1}`);
        await pageMut1.waitForLoadState('networkidle');
        await pageMut1.waitForTimeout(700);
        if (!mut1State.anchorFound) {
            must(false, `MUT1 锚点未命中恰一处（accept online_mode release 单选字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut1State.occurrences}）`);
        } else {
            await pageMut1.click('#siDActions button:has-text("验收通过")');
            await pageMut1.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await pageMut1.waitForTimeout(200);
            // [补丁 AF·AF4·512-M2 ①] 先确认 release 单选恰一个再读 isChecked——此前控件被连带删除时
            // `.isChecked().catch(() => false)` 会把"控件缺失"也吞成"未勾选"，两种坏法混为一谈。
            const mut1ReleaseCount = await pageMut1.locator('input[name="si-accept-online-mode"][value="release"]').count();
            must(mut1ReleaseCount === 1, `[MUT1] release 单选控件恰一个（实得 ${mut1ReleaseCount}——为 0 说明控件被连带删除而非"未勾选"，需另行核实是否为预期变异范围）`);
            let releaseCheckedMut1 = false;
            if (mut1ReleaseCount === 1) {
                releaseCheckedMut1 = await pageMut1.locator('input[name="si-accept-online-mode"][value="release"]').isChecked();
            }
            const mut1JudgedRed = mut1ReleaseCount === 1 && releaseCheckedMut1 === false;
            console.log(`  ${mut1JudgedRed ? '✅' : '❌'} [MUT1] 撤去 checked 后「默认勾选 release」断言应判红（控件恰一个=${mut1ReleaseCount === 1}，实得 isChecked=${releaseCheckedMut1}，${mut1JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut1JudgedRed) { fail++; failDetails.push('[MUT1] 变异后未观察到判红——需人工核实'); }
            // [补丁 AE·AE5] 健康检查——排除"页面没渲染出来"这类旁因：弹层仍正常打开、非目标控件
            // （direct 选项/说明输入框）仍存在、无页面错误。
            const mut1ModalOpen = await pageMut1.locator('#siModalOverlay.open').count();
            const mut1DirectOptCount = await pageMut1.locator('input[name="si-accept-online-mode"][value="direct"]').count();
            const mut1NoteCount = await pageMut1.locator('#f_note').count();
            const mut1Healthy = mut1ModalOpen === 1 && mut1DirectOptCount === 1 && mut1NoteCount === 1;
            must(mut1Healthy, `[MUT1 健康检查] 变异后弹层仍正常打开∧direct 选项∧说明输入框均存在（实得 modalOpen=${mut1ModalOpen}/directCount=${mut1DirectOptCount}/noteCount=${mut1NoteCount}）`);
            const mut1PageErrors = filterExpectedConsoleErrors(pageMut1._consoleErrors);
            must(mut1PageErrors.length === 0, `[MUT1 健康检查] 变异后无非预期 console error（实得 ${mut1PageErrors.length} 个）`);
        }
        await pageMut1.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT2：撤销 siIsDevAction 的 config → 开发账号按钮不可见用例应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT2：撤销 siIsDevAction 的 config 白名单 → submit 按钮应不可见 ──');
        // [补丁 AE·AE5] 正向对照——同一夹具 idProcessingDev 变异前先确认 submit 按钮可见（该组正常态下绿）。
        const pageMut2Ctrl = await loginPage(browser, devTok);
        await pageMut2Ctrl.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idProcessingDev}`);
        await pageMut2Ctrl.waitForLoadState('networkidle');
        await pageMut2Ctrl.waitForTimeout(700);
        const submitBtnCountCtrl2 = await pageMut2Ctrl.locator('#siDActions button:has-text("标记我的开发完成")').count();
        must(submitBtnCountCtrl2 === 1, `[MUT2 正向对照] 变异前：同一夹具 submit 按钮可见（实得按钮数=${submitBtnCountCtrl2}，证明该组正常态下绿）`);
        await pageMut2Ctrl.close();

        const mutMarker = "type !== 'bug' && type !== 'config') {";
        const mutReplacement = "type !== 'bug' /* MUTATION-TEST-TEMP-REMOVE: config */) {";
        // [补丁 AF·AF2] 改用 page.route 内存拦截。
        const pageMut2 = await loginPage(browser, devTok);
        const mut2State = await routeMutatedIterationPage(pageMut2, mutMarker, mutReplacement);
        await pageMut2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idProcessingDev}`);
        await pageMut2.waitForLoadState('networkidle');
        await pageMut2.waitForTimeout(700);
        if (!mut2State.anchorFound) {
            must(false, `MUT2 锚点未命中恰一处（siIsDevAction 类型白名单字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut2State.occurrences}）`);
        } else {
            const submitBtnCountMut = await pageMut2.locator('#siDActions button:has-text("标记我的开发完成")').count();
            const mutJudgedRed = submitBtnCountMut === 0;
            console.log(`  ${mutJudgedRed ? '\u2705' : '\u274c'} [MUT2] 撤销 config 白名单后 submit 按钮不可见（实得按钮数=${submitBtnCountMut}，${mutJudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mutJudgedRed) { fail++; failDetails.push('[MUT2] 变异后未观察到判红——需人工核实'); }
            // [补丁 AF·AF4·512-M2 ②] 不再只查"#siDActions 容器存在"这种与本变异无关的泛泛容器——改直接
            // 读页面内部状态 siDetail.issue，核对详情确实加载了正确的 id/status/type（目标控件消失不等于
            // 页面白屏，但也不能只看容器还在就当作"渲染正常"，须核对具体加载的是哪个单据）。
            const mut2DetailInfo = await pageMut2.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, status: siDetail.issue.status, type: siDetail.issue.type } : null);
            must(!!mut2DetailInfo && Number(mut2DetailInfo.id) === idProcessingDev && mut2DetailInfo.status === '处理中' && mut2DetailInfo.type === 'config', `[MUT2 健康检查] 详情确实加载了目标单据（预期 id=${idProcessingDev}∧status=处理中∧type=config，实得=${JSON.stringify(mut2DetailInfo)}）`);
            // [实测发现] 本变异把 config 从"合法类型"白名单里精确凿掉一个 && 分支，恰好触发
            // siIsDevAction 自身的 fail-closed 兜底分支（:1303-1306）主动 console.error('[siIsDevAction]
            // type 缺失或非法：config ...')——这是该行代码本身对"非法 type"的既有防御性日志，每次
            // siRenderActions 遍历 flows 逐动作调用都会打一条，是本变异的**预期、无害的副作用**，不是
            // 页面渲染损坏的证据，故从健康检查里精确排除这一条已知信号（[补丁 AF·AF4 ⑦] 按完整消息
            // 前缀 + 本单 type=config 上下文收窄，不会像原正则那样吞掉其他非法类型的日志）。
            const mut2PageErrors = filterExpectedConsoleErrors(pageMut2._consoleErrors)
                .filter(e => !/^\[siIsDevAction\] type 缺失或非法：\s*config\s+action=/.test(e.text));
            must(mut2PageErrors.length === 0, `[MUT2 健康检查] 变异后无非预期 console error（实得 ${mut2PageErrors.length} 个，已排除本变异自身触发的 config 专属 [siIsDevAction] 防御性日志）${mut2PageErrors.length ? '：' + JSON.stringify(mut2PageErrors) : ''}`);
        }
        await pageMut2.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT3（补丁 AC·AC1）：撤去 hotfixBtn 条件里的 config → T11 的「待上线可见」用例应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT3：撤去 hotfixBtn 条件的 config → 应急上线按钮应不可见 ──');
        const mut3Marker = "(iss.type === 'bug' || iss.type === 'feature' || iss.type === 'improvement' || iss.type === 'config')) {";
        const mut3Replacement = "(iss.type === 'bug' || iss.type === 'feature' || iss.type === 'improvement' /* MUTATION-TEST-TEMP-REMOVE-config */)) {";
        // [补丁 AE·AE5] 正向对照已由 T11（同一夹具 id11PreRelease，见上方 t11-config-prerelease-visible）
        // 变异前钉住，此处不重复开页。[补丁 AF·AF2] 改用 page.route 内存拦截。
        const pageMut3 = await loginPage(browser, adminTok);
        const mut3State = await routeMutatedIterationPage(pageMut3, mut3Marker, mut3Replacement);
        await pageMut3.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id11PreRelease}`);
        await pageMut3.waitForLoadState('networkidle');
        await pageMut3.waitForTimeout(700);
        if (!mut3State.anchorFound) {
            must(false, `MUT3 锚点未命中恰一处（hotfixBtn 类型条件字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut3State.occurrences}）`);
        } else {
            const hotfixBtnCountMut3 = await pageMut3.locator('#siDActions button:has-text("应急上线")').count();
            const mut3JudgedRed = hotfixBtnCountMut3 === 0;
            console.log(`  ${mut3JudgedRed ? '✅' : '❌'} [MUT3] 撤去 hotfixBtn 的 config 条件后「应急上线」按钮应不可见（实得按钮数=${hotfixBtnCountMut3}，${mut3JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut3JudgedRed) { fail++; failDetails.push('[MUT3] 变异后未观察到判红——需人工核实'); }
            // [补丁 AF·AF4·512-M2 ②] 断目标：详情确实加载了目标单据（id/status/type），不是泛泛的容器存在。
            const mut3DetailInfo = await pageMut3.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, status: siDetail.issue.status, type: siDetail.issue.type } : null);
            must(!!mut3DetailInfo && Number(mut3DetailInfo.id) === id11PreRelease && mut3DetailInfo.status === '待上线' && mut3DetailInfo.type === 'config', `[MUT3 健康检查] 详情确实加载了目标单据（预期 id=${id11PreRelease}∧status=待上线∧type=config，实得=${JSON.stringify(mut3DetailInfo)}）`);
            const mut3PageErrors = filterExpectedConsoleErrors(pageMut3._consoleErrors);
            must(mut3PageErrors.length === 0, `[MUT3 健康检查] 变异后无非预期 console error（实得 ${mut3PageErrors.length} 个）`);
        }
        await pageMut3.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT4（补丁 AD·AD1）：撤去 SI_OA_ALLOWED_STATUSES 的 config 键 → T14 第一条应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT4：撤去 SI_OA_ALLOWED_STATUSES 的 config 键 → 「补填 OA 号」入口应不可见 ──');
        const mut4Marker = "config: ['待处理', '处理中', '待验证', '待上线', '已上线', '已暂缓'],";
        const mut4Replacement = "/* MUTATION-TEST-TEMP-REMOVE-config: ['待处理','处理中','待验证','待上线','已上线','已暂缓'], */";
        // [补丁 AF·AF4·512-M2 ②] T14 的正向操作已经把 id14 的 oa_number 改过（提交过一次「补填 OA 号」），
        // 变异前先重新开一个新页面确认「当前」夹具入口仍可见（siOaFillable 只按 type+status 判定，不
        // 看 oa_number 是否已有值，理论上不受影响，但按 512 要求在变异注入前就地重新确认，不复用早前
        // T14 阶段的旧断言结果）。
        const pageMut4Ctrl = await loginPage(browser, adminTok);
        await pageMut4Ctrl.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id14}`);
        await pageMut4Ctrl.waitForLoadState('networkidle');
        await pageMut4Ctrl.waitForTimeout(700);
        // [实测发现] T14 早前已提交过一次 OA 号，按钮文案已从「补填」变为「修改」（siOaFillable 渲染点：
        // `${iss.oa_number ? '修改' : '补填'} OA 号`，:5747）——用「OA 号」子串匹配两种文案，不锁死某一态。
        const oaBtnCountCtrl4 = await pageMut4Ctrl.locator('#siDActions button:has-text("OA 号")').count();
        must(oaBtnCountCtrl4 === 1, `[MUT4 正向对照] 变异前：id14 当前仍可见「补填/修改 OA 号」入口（实得按钮数=${oaBtnCountCtrl4}，证明该组正常态下绿——T14 早前的 OA 号提交只改了按钮文案，未影响入口可见性）`);
        await pageMut4Ctrl.close();

        // [补丁 AF·AF2] 改用 page.route 内存拦截。
        const pageMut4 = await loginPage(browser, adminTok);
        const mut4State = await routeMutatedIterationPage(pageMut4, mut4Marker, mut4Replacement);
        await pageMut4.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id14}`);
        await pageMut4.waitForLoadState('networkidle');
        await pageMut4.waitForTimeout(700);
        if (!mut4State.anchorFound) {
            must(false, `MUT4 锚点未命中恰一处（SI_OA_ALLOWED_STATUSES.config 字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut4State.occurrences}）`);
        } else {
            const oaBtnCountMut4 = await pageMut4.locator('#siDActions button:has-text("OA 号")').count();
            const mut4JudgedRed = oaBtnCountMut4 === 0;
            console.log(`  ${mut4JudgedRed ? '✅' : '❌'} [MUT4] 撤去 config 键后「补填 OA 号」入口应不可见（实得按钮数=${oaBtnCountMut4}，${mut4JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut4JudgedRed) { fail++; failDetails.push('[MUT4] 变异后未观察到判红——需人工核实'); }
            const mut4DetailInfo = await pageMut4.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, status: siDetail.issue.status, type: siDetail.issue.type } : null);
            must(!!mut4DetailInfo && Number(mut4DetailInfo.id) === id14 && mut4DetailInfo.type === 'config', `[MUT4 健康检查] 详情确实加载了目标单据（预期 id=${id14}∧type=config，实得=${JSON.stringify(mut4DetailInfo)}）`);
            const mut4PageErrors = filterExpectedConsoleErrors(pageMut4._consoleErrors);
            must(mut4PageErrors.length === 0, `[MUT4 健康检查] 变异后无非预期 console error（实得 ${mut4PageErrors.length} 个）`);
        }
        await pageMut4.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT5（补丁 AD·AD5）：撤去改派 vendorChanged 判据 → T13②④ 用例应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT5：撤去改派 vendorChanged 判据 → T13②④ 用例应判红 ──');
        const id13bMut = await mkConfigProcessing(adminTok, 't13bmut', 'vendor', '原乙方公司');
        registerCreatedId(id13bMut);
        const id13dMut = await mkConfigProcessing(adminTok, 't13dmut', 'vendor', '原乙方公司');
        registerCreatedId(id13dMut);

        // [补丁 AE·AE5·511-B M2] 正向对照——两个夹具此前从未在未变异态下走过 UI，先各验证一次正常行为。
        const pageMut5bCtrl = await loginPage(browser, adminTok);
        await pageMut5bCtrl.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13bMut}`);
        await pageMut5bCtrl.waitForLoadState('networkidle');
        await pageMut5bCtrl.waitForTimeout(700);
        await pageMut5bCtrl.click('#siDActions button:has-text("改派")');
        await pageMut5bCtrl.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await pageMut5bCtrl.waitForTimeout(200);
        await pageMut5bCtrl.fill('#si-reassign-vendor-name', '正向对照名称');
        await pageMut5bCtrl.fill('#f_reason', 'MUT5 正向对照②：变异前只改名称应生效');
        await pageMut5bCtrl.click('#siMConfirm');
        await pageMut5bCtrl.waitForTimeout(800);
        const row5bCtrl = await dbGet('SELECT vendor_name FROM sys_issues WHERE id=?', [id13bMut]);
        must(!!row5bCtrl && row5bCtrl.vendor_name === '正向对照名称', `[MUT5② 正向对照] 变异前：只改名称提交后库里名称确实变为「正向对照名称」（实得=${JSON.stringify(row5bCtrl)}，证明该组正常态下绿）`);
        await pageMut5bCtrl.close();
        const mut5bBaselineName = (row5bCtrl && row5bCtrl.vendor_name) || '正向对照名称';   // 后续变异判红对拍的基线值

        const pageMut5dCtrl = await loginPage(browser, adminTok);
        await pageMut5dCtrl.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13dMut}`);
        await pageMut5dCtrl.waitForLoadState('networkidle');
        await pageMut5dCtrl.waitForTimeout(700);
        await pageMut5dCtrl.click('#siDActions button:has-text("改派")');
        await pageMut5dCtrl.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await pageMut5dCtrl.waitForTimeout(200);
        await pageMut5dCtrl.fill('#si-reassign-vendor-name', '');
        await pageMut5dCtrl.fill('#f_reason', 'MUT5 正向对照④：变异前清空名称应被前端拦截');
        let reassignReqCountCtrl5d = 0;
        const onReassignReqCtrl5d = req => { if (/\/api\/sys-issues\/\d+\/reassign$/.test(new URL(req.url()).pathname) && req.method() === 'POST') reassignReqCountCtrl5d++; };
        pageMut5dCtrl.on('request', onReassignReqCtrl5d);
        await pageMut5dCtrl.click('#siMConfirm');
        await pageMut5dCtrl.waitForTimeout(500);
        pageMut5dCtrl.off('request', onReassignReqCtrl5d);
        const toastCtrl5d = await pageMut5dCtrl.locator('#toast-container').textContent().catch(() => '');
        must(/请填写乙方名称/.test(toastCtrl5d || '') && reassignReqCountCtrl5d === 0, `[MUT5④ 正向对照] 变异前：清空名称提交被前端拦截（请求数=0 ∧ toast="${toastCtrl5d}"，证明该组正常态下绿）`);
        await pageMut5dCtrl.close();

        const mut5Marker = "const vendorChanged = curMode === 'vendor' && curVendorName !== initialVendorName.trim();";
        const mut5Replacement = "const vendorChanged = false; /* MUTATION-TEST-TEMP-REMOVE-vendorChanged */";
        // [补丁 AF·AF2] 改用 page.route 内存拦截——②④各自独立开页、独立注册路由。
        const pageMut5b = await loginPage(browser, adminTok);
        const mut5bState = await routeMutatedIterationPage(pageMut5b, mut5Marker, mut5Replacement);
        await pageMut5b.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13bMut}`);
        await pageMut5b.waitForLoadState('networkidle');
        await pageMut5b.waitForTimeout(700);
        const pageMut5d = await loginPage(browser, adminTok);
        const mut5dState = await routeMutatedIterationPage(pageMut5d, mut5Marker, mut5Replacement);
        await pageMut5d.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id13dMut}`);
        await pageMut5d.waitForLoadState('networkidle');
        await pageMut5d.waitForTimeout(700);
        if (!mut5bState.anchorFound || !mut5dState.anchorFound) {
            must(false, `MUT5 锚点未命中恰一处（vendorChanged 判据字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；②命中次数=${mut5bState.occurrences}，④命中次数=${mut5dState.occurrences}）`);
        } else {
            // ②只改名称场景：mutation 后 modeChanged/vendorChanged 均为 false，整段判定块被跳过，body
            // 不再携带 exec_mode/vendor_name，请求仍会发到后端，后端 no-op 三元判据在"成员未变+两键
            // 均缺失"这一组合上独立以 409 拒绝（index.js:7788-7794，与④同一拒绝码）。
            // [补丁 AF·AF4·512-M2 ③] 判红改为**捕获本单实际请求 + 断言缺失字段 + 断言预期拒绝响应**，
            // 不再只看 DB 值不变——那本身可能由请求失败/处理器异常等无关原因造成，不能证明是
            // vendorChanged 判据被跳过导致的。
            await pageMut5b.click('#siDActions button:has-text("改派")');
            await pageMut5b.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await pageMut5b.waitForTimeout(200);
            await pageMut5b.fill('#si-reassign-vendor-name', '变异测试新名称');
            await pageMut5b.fill('#f_reason', 'MUT5 探针②：撤去 vendorChanged 后只改名称');
            // [S1d·513-M2] 响应匹配精确绑定 id13bMut——此前裸 `\d+` 通配符会接受任意单据的 reassign
            // 响应，与代码注释"捕获本单实际请求"的表述不符（本文件各 page 顺序执行，实际不会真的
            // 捕获到别的单据，但精确绑定后代码行为与注释所述一致，不留纵深防御空隙）。
            const reassignRespPromiseMut5b = pageMut5b.waitForResponse(
                r => new RegExp(`/api/sys-issues/${id13bMut}/reassign$`).test(new URL(r.url()).pathname) && r.request().method() === 'POST',
                { timeout: 5000 }
            ).catch(() => null);
            await pageMut5b.click('#siMConfirm');
            const reassignRespMut5b = await reassignRespPromiseMut5b;
            await pageMut5b.waitForTimeout(500);
            let mut5bReqBody = null, mut5bReqParseOk = false;
            // [S1d·513 附带建议] parseOk 改用 isPlainObjectJson。
            if (reassignRespMut5b) { try { mut5bReqBody = JSON.parse(reassignRespMut5b.request().postData() || 'null'); mut5bReqParseOk = isPlainObjectJson(mut5bReqBody); } catch (_) { /* 解析失败留 null，下方按 !! 判红 */ } }
            let mut5bRespBody = null;
            if (reassignRespMut5b) { try { mut5bRespBody = await reassignRespMut5b.json(); } catch (_) { /* 解析失败留 null */ } }
            const mut5bRequestSent = !!reassignRespMut5b;
            const mut5bReqMissingKeys = mut5bReqParseOk && !('exec_mode' in mut5bReqBody) && !('vendor_name' in mut5bReqBody);
            const mut5bBackendRejected = !!reassignRespMut5b && reassignRespMut5b.status() === 409 && !!mut5bRespBody && mut5bRespBody.error === '开发集合与执行方式均无变更，无需改派';
            const mut5bJudgedRed = mut5bRequestSent && mut5bReqMissingKeys && mut5bBackendRejected;
            console.log(`  ${mut5bJudgedRed ? '✅' : '❌'} [MUT5②] 撤去 vendorChanged 后"只改名称"用例应判红（请求已发出=${mut5bRequestSent}，请求体缺 exec_mode/vendor_name=${mut5bReqMissingKeys}，后端 409 拒绝=${mut5bBackendRejected}，实得请求体=${JSON.stringify(mut5bReqBody)}，实得响应=${JSON.stringify(mut5bRespBody)}，${mut5bJudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut5bJudgedRed) { fail++; failDetails.push('[MUT5②] 变异后未观察到判红——需人工核实'); }
            // 库值兜底核对——与请求/响应证据一致，行存在 ∧ 名称仍为正向对照后的基线值（不单独作为判红依据）。
            const row5bAfter = await dbGet('SELECT vendor_name FROM sys_issues WHERE id=?', [id13bMut]);
            must(!!row5bAfter && row5bAfter.vendor_name === mut5bBaselineName, `[MUT5②] 库值兜底核对：行存在 ∧ 名称仍为基线值「${mut5bBaselineName}」（实得=${JSON.stringify(row5bAfter)}）`);
            // [S1d·513-M2] 健康检查——MUT5②此前未检查页面错误（512 指出的缺口），补齐同 MUT1-4/6-8 同款
            // 检查：变异只应改变 vendorChanged 判据，不应引出非预期 console error。
            // [实测踩坑修复] 本变异让前端校验被绕过、请求真的发到后端并被 409 拒绝——Chromium 对
            // fetch/XHR 收到非 2xx 响应会自动打一条 "Failed to load resource" console error（浏览器
            // 内建行为，非 JS 显式 console.error()，与页面是否正确处理错误无关）。这是本变异**预期、
            // 无害的副作用**（正是判红证据本身——mut5bBackendRejected 已经断言了同一个 409），故精确
            // 排除"本单 reassign 端点 409"这一条，不放宽到吞掉其它无关错误（同 MUT2 排除自身
            // [siIsDevAction] 防御日志的收窄范式）。
            const mut5bPageErrors = filterExpectedConsoleErrors(pageMut5b._consoleErrors)
                .filter(e => !(/409/.test(e.text) && new RegExp(`/api/sys-issues/${id13bMut}/reassign`).test(e.url)));
            must(mut5bPageErrors.length === 0, `[MUT5② 健康检查] 变异后无非预期 console error（实得 ${mut5bPageErrors.length} 个，已排除本变异自身触发的本单 reassign 409 网络日志）${mut5bPageErrors.length ? '：' + JSON.stringify(mut5bPageErrors) : ''}`);

            // ④清空名称场景：同②，mutation 后前端整段判定块被跳过，请求直接发到后端，后端 no-op 判据
            // 独立以 409 拒绝（同一拒绝码）。
            await pageMut5d.click('#siDActions button:has-text("改派")');
            await pageMut5d.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await pageMut5d.waitForTimeout(200);
            await pageMut5d.fill('#si-reassign-vendor-name', '');
            await pageMut5d.fill('#f_reason', 'MUT5 探针④：撤去 vendorChanged 后清空名称');
            // [S1d·513-M2] 响应匹配精确绑定 id13dMut，同 MUT5②。
            const reassignRespPromiseMut5d = pageMut5d.waitForResponse(
                r => new RegExp(`/api/sys-issues/${id13dMut}/reassign$`).test(new URL(r.url()).pathname) && r.request().method() === 'POST',
                { timeout: 5000 }
            ).catch(() => null);
            await pageMut5d.click('#siMConfirm');
            const reassignRespMut5d = await reassignRespPromiseMut5d;
            await pageMut5d.waitForTimeout(500);
            const toastMut5d = await pageMut5d.locator('#toast-container').textContent().catch(() => '');
            let mut5dReqBody = null, mut5dReqParseOk = false;
            // [S1d·513 附带建议] parseOk 改用 isPlainObjectJson。
            if (reassignRespMut5d) { try { mut5dReqBody = JSON.parse(reassignRespMut5d.request().postData() || 'null'); mut5dReqParseOk = isPlainObjectJson(mut5dReqBody); } catch (_) { /* 解析失败留 null */ } }
            let mut5dRespBody = null;
            if (reassignRespMut5d) { try { mut5dRespBody = await reassignRespMut5d.json(); } catch (_) { /* 解析失败留 null，下方按 !! 判红 */ } }
            const mut5dRequestSent = !!reassignRespMut5d;
            const mut5dReqMissingKeys = mut5dReqParseOk && !('exec_mode' in mut5dReqBody) && !('vendor_name' in mut5dReqBody);
            const mut5dBackendRejected = !!reassignRespMut5d && reassignRespMut5d.status() === 409 && !!mut5dRespBody && mut5dRespBody.error === '开发集合与执行方式均无变更，无需改派';
            const mut5dJudgedRed = mut5dRequestSent && mut5dReqMissingKeys && mut5dBackendRejected;
            console.log(`  ${mut5dJudgedRed ? '✅' : '❌'} [MUT5④] 撤去 vendorChanged 后"清空名称应拦截"用例应判红（请求已发出=${mut5dRequestSent}，请求体缺 exec_mode/vendor_name=${mut5dReqMissingKeys}，后端 409 拒绝=${mut5dBackendRejected}，实得请求体=${JSON.stringify(mut5dReqBody)}，实得响应=${JSON.stringify(mut5dRespBody)}，toast="${toastMut5d}"，${mut5dJudgedRed ? '判红符合预期（请求绕过前端校验直达后端，后端独立拒绝）' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut5dJudgedRed) { fail++; failDetails.push('[MUT5④] 变异后未观察到判红——需人工核实'); }
            // [S1d·513-M2] 健康检查——MUT5④同样此前未检查页面错误；同②排除本单 reassign 409 的
            // 浏览器内建网络日志（判红证据本身，非页面渲染损坏）。
            const mut5dPageErrors = filterExpectedConsoleErrors(pageMut5d._consoleErrors)
                .filter(e => !(/409/.test(e.text) && new RegExp(`/api/sys-issues/${id13dMut}/reassign`).test(e.url)));
            must(mut5dPageErrors.length === 0, `[MUT5④ 健康检查] 变异后无非预期 console error（实得 ${mut5dPageErrors.length} 个，已排除本变异自身触发的本单 reassign 409 网络日志）${mut5dPageErrors.length ? '：' + JSON.stringify(mut5dPageErrors) : ''}`);
        }
        await pageMut5b.close();
        await pageMut5d.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT6（补丁 AE·§4 候选①）：撤去首次指派 body.vendor_name = vn → T3v 成功路径应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT6：撤去首次指派 body.vendor_name = vn → T3v vendor 成功路径应判红 ──');
        // [补丁 AE·AE5] 正向对照已由上方 T3v（id3vUi，见 t3v-assign-request-body/t3v-db-vendor）钉住
        // 同一段代码在未变异态下的行为——此处不重复开页，改用新夹具复现变异后行为。
        const idMut6 = await mkConfigToPending2(adminTok, 'mut6', '二级');
        registerCreatedId(idMut6);
        const mut6Marker = 'body.vendor_name = vn;';
        const mut6Replacement = '/* MUTATION-TEST-TEMP-REMOVE-body-vendor-name-assign: body.vendor_name = vn; */';
        // [补丁 AF·AF2] 改用 page.route 内存拦截。
        const pageMut6 = await loginPage(browser, adminTok);
        const mut6State = await routeMutatedIterationPage(pageMut6, mut6Marker, mut6Replacement);
        await pageMut6.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idMut6}`);
        await pageMut6.waitForLoadState('networkidle');
        await pageMut6.waitForTimeout(700);
        if (!mut6State.anchorFound) {
            must(false, `MUT6 锚点未命中恰一处（siModalAssign 的 body.vendor_name = vn 字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut6State.occurrences}）`);
        } else {
            await pageMut6.click('#siDActions button:has-text("指派")');
            await pageMut6.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await pageMut6.waitForTimeout(200);
            await pageMut6.locator('.si-collab-chk').first().check();
            await pageMut6.locator('input[name="si-assign-exec-mode"][value="vendor"]').check();
            await pageMut6.waitForTimeout(150);
            await pageMut6.fill('#si-assign-vendor-name', 'MUT6乙方公司');
            // [511-B M2，补丁 AF·AF4·512-M2 ④] 判红需捕获实际请求体与响应——后端 VENDOR_NAME_REQUIRED
            // 的文案与前端自身校验文案逐字相同，toast 无判别力；且不能只要求"非 200"（那样任何原因
            // 的失败都会误判成功杀死变异），须精确核对 400 + code==='VENDOR_NAME_REQUIRED'，并核对
            // 请求体其余字段（assigned_to/exec_mode）齐全合法，证明这是一个"本该成功、只差 vendor_name
            // 一个键"的合法请求，不是被别的原因搞坏的畸形请求。
            // [S1d·513-M2] 响应匹配精确绑定 idMut6，同 MUT5②④。
            const assignRespPromiseMut6 = pageMut6.waitForResponse(
                r => new RegExp(`/api/sys-issues/${idMut6}/assign$`).test(new URL(r.url()).pathname) && r.request().method() === 'POST',
                { timeout: 5000 }
            ).catch(() => null);
            await pageMut6.click('#siMConfirm');
            const assignRespMut6 = await assignRespPromiseMut6;
            await pageMut6.waitForTimeout(500);
            let mut6ReqBody = null, mut6ReqParseOk = false;
            // [S1d·513 附带建议] parseOk 改用 isPlainObjectJson。
            if (assignRespMut6) { try { mut6ReqBody = JSON.parse(assignRespMut6.request().postData() || 'null'); mut6ReqParseOk = isPlainObjectJson(mut6ReqBody); } catch (_) { /* 解析失败留 null，下方按 !! 判红 */ } }
            let mut6RespBody = null;
            if (assignRespMut6) { try { mut6RespBody = await assignRespMut6.json(); } catch (_) { /* 解析失败留 null */ } }
            const mut6ReqOtherFieldsIntact = mut6ReqParseOk && Number.isInteger(mut6ReqBody.assigned_to) && mut6ReqBody.assigned_to > 0 && mut6ReqBody.exec_mode === 'vendor';
            const mut6RequestMissingKey = mut6ReqParseOk && !('vendor_name' in mut6ReqBody);
            const mut6BackendRejected = !!assignRespMut6 && assignRespMut6.status() === 400 && !!mut6RespBody && mut6RespBody.code === 'VENDOR_NAME_REQUIRED';
            const mut6JudgedRed = mut6ReqOtherFieldsIntact && mut6RequestMissingKey && mut6BackendRejected;
            console.log(`  ${mut6JudgedRed ? '✅' : '❌'} [MUT6] 撤去 body.vendor_name = vn 后首次指派 vendor 成功路径应判红（请求其余字段齐全=${mut6ReqOtherFieldsIntact}，缺 vendor_name 键=${mut6RequestMissingKey}，后端 400/VENDOR_NAME_REQUIRED=${mut6BackendRejected}，实得请求体=${JSON.stringify(mut6ReqBody)}，实得响应=${JSON.stringify(mut6RespBody)}，${mut6JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut6JudgedRed) { fail++; failDetails.push('[MUT6] 变异后未观察到判红——需人工核实'); }
            const mut6DetailInfo = await pageMut6.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, type: siDetail.issue.type } : null);
            must(!!mut6DetailInfo && Number(mut6DetailInfo.id) === idMut6 && mut6DetailInfo.type === 'config', `[MUT6 健康检查] 详情确实加载了目标单据（预期 id=${idMut6}∧type=config，实得=${JSON.stringify(mut6DetailInfo)}）`);
            // [S1d·513-M2] MUT6 此前也未检查页面错误——补齐同 MUT1-4/7/8 同款检查；同 MUT5②④排除
            // 本单 assign 400 的浏览器内建网络日志（判红证据本身，非页面渲染损坏）。
            const mut6PageErrors = filterExpectedConsoleErrors(pageMut6._consoleErrors)
                .filter(e => !(/400/.test(e.text) && new RegExp(`/api/sys-issues/${idMut6}/assign`).test(e.url)));
            must(mut6PageErrors.length === 0, `[MUT6 健康检查] 变异后无非预期 console error（实得 ${mut6PageErrors.length} 个，已排除本变异自身触发的本单 assign 400 网络日志）${mut6PageErrors.length ? '：' + JSON.stringify(mut6PageErrors) : ''}`);
        }
        await pageMut6.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT7（补丁 AE·§4 候选②）：撤去 siNotifyStatusesFor 的 config 分支 → T12b 开发通知按钮应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT7：撤去 siNotifyStatusesFor 的 config 分支 → 开发通知按钮应不可见 ──');
        const mut7Marker = "if (type === 'config') {";
        const mut7Replacement = "if (/* MUTATION-TEST-TEMP-REMOVE-config-notify-branch */ false && type === 'config') {";
        // [补丁 AF·AF2] 改用 page.route 内存拦截；[S1d·513-M2 根治] 新增 functionName 参数限定锚点
        // 归因范围——`if (type === 'config') {` 本身是通用字面量，全文件唯一性不能证明命中的就是
        // siNotifyStatusesFor 函数体内那一处（可能因未来重构漂移到别的函数）。改为先用括号配平定位
        // siNotifyStatusesFor 的函数体子串，marker 的出现次数统计与替换均限定在这段子串内。
        const pageMut7 = await loginPage(browser, liaisonTok);
        const mut7State = await routeMutatedIterationPage(pageMut7, mut7Marker, mut7Replacement, { functionName: 'siNotifyStatusesFor' });
        await pageMut7.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12ConfigProcessing}`);
        await pageMut7.waitForLoadState('networkidle');
        await pageMut7.waitForTimeout(700);
        if (!mut7State.functionScopeFound) {
            must(false, `MUT7 定位不到 siNotifyStatusesFor 函数体（函数已被删除/改名/重构，需人工核实后更新 functionName 或锚点）`);
        } else if (!mut7State.anchorFound) {
            must(false, `MUT7 锚点未命中 siNotifyStatusesFor 函数体内恰一处（config 分支字面量已在函数体内漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut7State.occurrences}）`);
        } else {
            // [补丁 AF·AF4·512-M2 ⑤] 先确认「开发」通知行本身存在且身份正确（含示例开发A——DEV_ID 的
            // display_name），再断按钮缺席——此前只查按钮数，若整个通知区/该行渲染失败，locator 对
            // 零匹配父元素取 .locator('button').count() 同样返回 0，会把"行都没了"误判成"行在但按钮
            // 正确隐藏"这一更弱的结论。
            const devRowMut7 = pageMut7.locator('.u-notify-row', { hasText: '开发 ' });
            const devRowCountMut7 = await devRowMut7.count();
            must(devRowCountMut7 === 1, `[MUT7] 「开发」通知行本身存在（实得 ${devRowCountMut7} 行——为 0 说明整行连带消失，不是"按钮被隐藏"）`);
            let devRowTextMut7 = '';
            if (devRowCountMut7 === 1) devRowTextMut7 = await devRowMut7.innerText().catch(() => '');
            must(devRowCountMut7 === 1 && devRowTextMut7.includes('示例开发A'), `[MUT7] 「开发」通知行身份正确——含 DEV_ID 姓名「示例开发A」（实得="${devRowTextMut7}"）`);
            const devBtnCountMut7 = devRowCountMut7 === 1 ? await devRowMut7.locator('button').count() : -1;
            const mut7JudgedRed = devRowCountMut7 === 1 && devBtnCountMut7 === 0;
            console.log(`  ${mut7JudgedRed ? '✅' : '❌'} [MUT7] 撤去 config 分支后绑定受理人在「处理中」态看不到开发通知按钮（行存在=${devRowCountMut7 === 1}，实得按钮数=${devBtnCountMut7}，${mut7JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut7JudgedRed) { fail++; failDetails.push('[MUT7] 变异后未观察到判红——需人工核实'); }
            // 健康检查——通知区标题/其余行仍正常渲染，非"页面整体没渲染出来"。
            const mut7HeaderText = await pageMut7.locator('.u-detail-section h3:has-text("钉钉通知")').first().innerText().catch(() => '');
            must(mut7HeaderText === '钉钉通知（手动触发）', `[MUT7 健康检查] 通知区标题仍正常渲染（实得="${mut7HeaderText}"）`);
            // [S1d·513-M2] 补详情 id/status/type 检查——同 MUT2-4/6 同款范式，证明"看不到开发通知按钮"
            // 不是因为详情压根加载错了单据/状态，而是变异真正命中了 siNotifyStatusesFor 的目标分支。
            const mut7DetailInfo = await pageMut7.evaluate(() => (siDetail && siDetail.issue) ? { id: siDetail.issue.id, status: siDetail.issue.status, type: siDetail.issue.type } : null);
            must(!!mut7DetailInfo && Number(mut7DetailInfo.id) === id12ConfigProcessing && mut7DetailInfo.status === '处理中' && mut7DetailInfo.type === 'config', `[MUT7 健康检查] 详情确实加载了目标单据（预期 id=${id12ConfigProcessing}∧status=处理中∧type=config，实得=${JSON.stringify(mut7DetailInfo)}）`);
            const mut7PageErrors = filterExpectedConsoleErrors(pageMut7._consoleErrors);
            must(mut7PageErrors.length === 0, `[MUT7 健康检查] 变异后无非预期 console error（实得 ${mut7PageErrors.length} 个）`);
        }
        await pageMut7.close();

        // ═══════════════════════════════════════════════════════════════
        // MUT8（补丁 AE·§4 候选③）：撤去 accept 时间线 online_mode 展示分支 → T6r 时间线断言应判红
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── MUT8：撤去时间线 online_mode 展示分支 → T6r 上线方式展示应不可见 ──');
        // 复用 id6r（release 分支，前面已落库 payload_json.online_mode='release'）——本轮只改渲染代码，
        // 不改数据，重新导航详情页即可复测。
        // 复用 id6r（release 分支，前面已落库 payload_json.online_mode='release'）——本轮只改渲染代码，
        // 不改数据，重新导航详情页即可复测。
        const mut8Marker = 'parsedPayload && parsedPayload.online_mode != null) {';
        const mut8Replacement = '/* MUTATION-TEST-TEMP-REMOVE-online-mode */ false && parsedPayload && parsedPayload.online_mode != null) {';
        // [补丁 AF·AF2] 改用 page.route 内存拦截。
        const pageMut8 = await loginPage(browser, adminTok);
        const mut8State = await routeMutatedIterationPage(pageMut8, mut8Marker, mut8Replacement);
        await pageMut8.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6r}`);
        await pageMut8.waitForLoadState('networkidle');
        await pageMut8.waitForTimeout(700);
        if (!mut8State.anchorFound) {
            must(false, `MUT8 锚点未命中恰一处（siRenderTimeline 的 online_mode 展示分支字面量已漂移或出现多处巧合匹配，需人工核实后更新锚点；实得命中次数=${mut8State.occurrences}）`);
        } else {
            // [补丁 AF·AF4·512-M2 ⑥] 不再只查"整个时间线文本不含上线方式字样"（其它事件文本非空也能
            // 蒙混过关）——精确定位**本次验收事件**（按 T6 探针的原始验收说明文字定位，唯一锚定这一条
            // 时间线记录），断言该事件本身仍存在 ∧ 原说明文字仍在 ∧ 上线方式后缀确实从这条记录里消失
            // （而不是从别的地方消失）。
            const mut8TargetEvent = pageMut8.locator('.si-tl-item', { hasText: 'T6 探针：config release 分支验收说明' });
            const mut8TargetCount = await mut8TargetEvent.count();
            must(mut8TargetCount === 1, `[MUT8] 本次验收事件（含 T6 探针原始说明）恰一条存在（实得 ${mut8TargetCount} 条）`);
            let mut8TargetText = '';
            if (mut8TargetCount === 1) mut8TargetText = await mut8TargetEvent.innerText().catch(() => '');
            must(mut8TargetCount === 1 && mut8TargetText.includes('T6 探针：config release 分支验收说明'), `[MUT8] 本次验收事件原说明文字仍在（实得片段="${mut8TargetText}"）`);
            const mut8JudgedRed = mut8TargetCount === 1 && !mut8TargetText.includes('上线方式：加入上线单，按排期生效');
            console.log(`  ${mut8JudgedRed ? '✅' : '❌'} [MUT8] 撤去 online_mode 展示分支后本次验收事件不再显示"上线方式：..."（事件存在=${mut8TargetCount === 1}，实得事件文本="${mut8TargetText}"，${mut8JudgedRed ? '判红符合预期' : '未判红——变异未生效或测试判别力不足'}）`);
            if (!mut8JudgedRed) { fail++; failDetails.push('[MUT8] 变异后未观察到判红——需人工核实'); }
            // 健康检查——时间线容器本身仍渲染出内容（非整块空白/报错），排除"页面没渲染出来"类旁因。
            const timelineMut8 = await pageMut8.locator('.si-timeline').innerText().catch(() => '');
            const mut8TimelineNonEmpty = timelineMut8.trim().length > 0 && !/暂无演进记录/.test(timelineMut8);
            must(mut8TimelineNonEmpty, '[MUT8 健康检查] 时间线容器仍正常渲染出内容（非空白/非"暂无演进记录"）');
            const mut8PageErrors = filterExpectedConsoleErrors(pageMut8._consoleErrors);
            must(mut8PageErrors.length === 0, `[MUT8 健康检查] 变异后无非预期 console error（实得 ${mut8PageErrors.length} 个）`);
        }
        await pageMut8.close();

        // ═══════════════════════════════════════════════════════════════
        // AK1 用例①（补丁 AK·codex 516-M1）：隔离用例——真实保留一个夹具的 pending 状态直到套件
        // "真实" finally 收尾（不像 AJ2-1/2/3 那样在测试内部手动核实后就移出 pendingFixtures），
        // 验证进程退出码。由于这会让本轮跑必然 fail>0（进程以非零码退出），默认不启用——只有显式
        // 设置环境变量 AK1_ISOLATION_TEST=1 时才会注入，避免污染日常回归跑的"0 FAIL"基线。不创建
        // 任何真实数据库行（只在 pendingFixtures 里登记一条从未解决的条目），不会在库里留下任何
        // 残留证据——套件末尾对该 marker 的最终查询天然查不到任何行（如实报告"未查到"）。
        // ═══════════════════════════════════════════════════════════════
        if (process.env.AK1_ISOLATION_TEST === '1') {
            console.log('\n── AK1 用例①（隔离用例）：故意保留一个夹具的 pending 状态直到真实 finally 收尾 ──');
            const ak1IsoMarker = nextFixtureMarker();
            pendingFixtures.set(ak1IsoMarker, {
                type: 'config', errLabel: 'AK1用例①：故意不解决',
                registeredAt: Date.now(),
                lastError: 'AK1 隔离用例故意保留，验证 finally 是否正确报告 + fail++ + 进程非零退出（现有三个 AJ2 用例都提前恢复查询并移出 pending，未覆盖这条路径）',
            });
            console.log(`   已登记 marker=${ak1IsoMarker} 进 pendingFixtures，故意不解决，留到真实 finally 收尾处理`);
        }

        // ═══════════════════════════════════════════════════════════════
        // AK1 用例②（补丁 AK·codex 516-M1）：收尾首个扫描（步骤②运行标记全表扫描）失败时，验证
        // 步骤③（已登记夹具清理）仍会执行——monkey-patch db.all，只拦截 finally 步骤②里那一次匹配
        // RUN_TAG_MARKER 的查询，令其抛出异常。默认不启用（AK1_SCAN_FAIL_TEST=1 才注入）。
        // ═══════════════════════════════════════════════════════════════
        if (process.env.AK1_SCAN_FAIL_TEST === '1') {
            console.log('\n── AK1 用例②（扫描失败用例）：注入步骤②查询异常——验证步骤③仍会执行 ──');
            const originalDbAllMethod = db.all.bind(db);
            let ak1ScanFailInjected = false;
            db.all = function (sql, params, cb) {
                if (!ak1ScanFailInjected && typeof sql === 'string' && sql.includes('WHERE description LIKE ?')
                    && Array.isArray(params) && typeof params[0] === 'string' && params[0].includes(RUN_TAG_MARKER)) {
                    ak1ScanFailInjected = true;
                    return cb(new Error('AK1_SCAN_FAIL_TEST 注入：模拟步骤②运行标记全表扫描查询异常'));
                }
                return originalDbAllMethod(sql, params, cb);
            };
            console.log('   已 monkey-patch db.all，将令 finally 步骤②的第一次 RUN_TAG_MARKER 查询抛出异常');
        }

        // ═══════════════════════════════════════════════════════════════
        // AT 用例（补丁 AT·codex 526-M）：步骤④-b 的**回库核实查询失败**时，不得把批次误报成"已删除"。
        //   注入两件：①让 DELETE 批次的 HTTP 调用恒失败 ②让核实用的 `SELECT id FROM sys_releases`
        //   查询恒抛异常。修复前 `dbGet(...).catch(() => null)` 会把查询异常当成"记录不存在"→ 注销
        //   登记 → 最终断言绿 = **真残留却报清理成功**。修复后查询失败属"什么都不能推定"，保留登记
        //   → 最终断言判红。默认不启用（AT_CLEANUP_VERIFY_FAIL_TEST=1 才注入）。
        // ═══════════════════════════════════════════════════════════════
        if (process.env.AT_CLEANUP_VERIFY_FAIL_TEST === '1') {
            console.log('\n── AT 用例（清理核实失败用例）：注入 DELETE 失败 + 回库核实查询异常 ──');
            const originalDbGetMethod = db.get.bind(db);
            db.get = function (sql, params, cb) {
                if (typeof sql === 'string' && /FROM\s+sys_releases\s+WHERE\s+id\s*=/.test(sql)) {
                    return cb(new Error('AT_CLEANUP_VERIFY_FAIL_TEST 注入：模拟步骤④-b 回库核实查询异常'));
                }
                return originalDbGetMethod(sql, params, cb);
            };
            const originalFetchAT = global.fetch;
            global.fetch = function (url, opts) {
                if (typeof url === 'string' && /\/api\/sys-releases\/\d+$/.test(url) && opts && opts.method === 'DELETE') {
                    return Promise.reject(new Error('AT_CLEANUP_VERIFY_FAIL_TEST 注入：模拟撤批 DELETE 调用失败'));
                }
                return originalFetchAT(url, opts);
            };
            console.log('   已注入：撤批 DELETE 恒失败 + sys_releases 回库核实查询恒抛异常');
            console.log('   期望：步骤④断言**判红**（批次 id 保留在登记表），而非误报"清理干净"');
        }

        // ═══════════════════════════════════════════════════════════════
        // AL1 用例（补丁 AL·codex 517-M1）：收尾首个扫描（步骤②运行标记全表扫描）**不抛异常、而是
        // 成功返回空数组**——这是 AK1_SCAN_FAIL_TEST（异常路径）覆盖不到的形态，专门验证 scanBeforeOk
        // 改为两次 must 合取后确实生效：① 正向对照那条 must 因命中 0 条而判红；② 步骤③已登记夹具
        // 清理仍会执行（独立 try 块，不受 scanBeforeOk 影响）；③ 步骤③不再打印"清理真正生效"这句
        // 成功语气结论，走只报告事实的 else 分支；④ 进程真退出码为 1（因①已 fail++）。默认不启用
        // （AL1_SCAN_EMPTY_TEST=1 才注入，严格等于字符串 '1'，沿用 AK1 判定同款机制，未设置时零影响，
        // 不污染日常回归跑的"0 FAIL"基线）。
        // ═══════════════════════════════════════════════════════════════
        if (process.env.AL1_SCAN_EMPTY_TEST === '1') {
            console.log('\n── AL1 用例（扫描空返回用例）：注入步骤②查询成功返回空数组（不抛异常）——验证 scanBeforeOk 合取生效 ──');
            const originalDbAllMethodAl1 = db.all.bind(db);
            let al1ScanEmptyInjected = false;
            db.all = function (sql, params, cb) {
                if (!al1ScanEmptyInjected && typeof sql === 'string' && sql.includes('WHERE description LIKE ?')
                    && Array.isArray(params) && typeof params[0] === 'string' && params[0].includes(RUN_TAG_MARKER)) {
                    al1ScanEmptyInjected = true;
                    return cb(null, []);
                }
                return originalDbAllMethodAl1(sql, params, cb);
            };
            console.log('   已 monkey-patch db.all，将令 finally 步骤②的第一次 RUN_TAG_MARKER 查询成功返回空数组（不抛异常，不同于 AK1_SCAN_FAIL_TEST 的抛异常形态）');
        }

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
        // [补丁 AF·AF2·512-H2 根治] AE4 曾在此处对磁盘文件做异常路径兜底恢复——512 指出这套"外层
        // catch 无条件把运行期间他人的编辑覆盖成启动快照"本身就是风险点。变异机制已改用 page.route
        // 内存拦截（本文件全程不再 fs.writeFileSync 共享文件），异常路径不存在"文件被改坏"这个场景，
        // 故本兜底**整体删除**，不是收紧成"更谨慎的覆盖"。
    } finally {
        try { await browser.close(); } catch (e) { fail++; console.warn('浏览器关闭失败:', e && e.message || e); }

        // [S1d·补丁AK·AK1 根治·codex 516-M1·真问题] 原实现把"运行标记全表扫描（清理前）"的 dbAll
        // 查询放在"pendingFixtures 失败判定"与"已登记夹具清理"之前且无局部异常保护——数据库查询
        // 一旦故障（连接抖动/锁竞争/其它临时故障），会从 finally 顶层直接抛出，导致"待确认项报告"
        // 与"全部已登记夹具的清理"两步都被跳过，留下真实残留却没有任何报告（比"没清理干净"更糟：
        // 连"没清理干净"这件事本身都没人知道）。拆成三个互不阻断的独立步骤，任何一步的异常都不
        // 影响其它两步执行，最后统一汇总失败计数。

        // ── 步骤①：pendingFixtures 收尾报告（独立 try/catch，不依赖步骤②的查询结果）──
        try {
            // [S1d·补丁AI·AI4→补丁AJ·AJ2 根治·codex 515-M2] 收尾统一核对——对本轮所有仍留在
            // pendingFixtures 里（从未成功核验、也从未被判定为歧义/查询异常并妥善处理）的夹具标记
            // 做最终查询。① pendingFixtures 非空本身就是信号（存在从未被确认所有权的夹具），无论
            // 最终查询结果如何都显式 fail++，不因"最终查到了"或"最终也没查到"而免责；② 查询结果
            // 只报告"扫描时点看到了什么"，不包装成"确认从未创建过"这类更强的结论（标记本身可能被
            // 截断等更深层问题，此刻的"未查到"不能排除这种可能性）。
            if (pendingFixtures.size > 0) {
                fail++;
                console.error(`\n⚠️ [AJ2 收尾失败] ${pendingFixtures.size} 条夹具标记在套件结束时仍留在 pendingFixtures——这本身即计入失败，不因最终查询结果而免责：`);
                for (const [marker, info] of pendingFixtures) {
                    let finalRows = null, finalErr = null;
                    try {
                        finalRows = await dbAll(`SELECT id, type, status, description FROM sys_issues WHERE description LIKE ?`, [`%${marker}%`]);
                    } catch (e) {
                        finalErr = e;
                    }
                    if (finalErr) {
                        console.error(`   ❓ ${info.errLabel}（marker=${marker}）套件末尾的最终查询本身仍然异常——无法判定，如实报告"无法判定"：${finalErr.message}`);
                    } else if (finalRows.length === 1) {
                        console.error(`   ⚠️ ${info.errLabel}（marker=${marker}）套件末尾查到恰一条匹配行：id=${finalRows[0].id}, type=${finalRows[0].type}, status=${finalRows[0].status}——这条行从未被 registerCreatedId 登记，是真实残留，需人工核实/清理`);
                    } else if (finalRows.length > 1) {
                        console.error(`   ⚠️ ${info.errLabel}（marker=${marker}）套件末尾查到 ${finalRows.length} 条匹配行（歧义）：${JSON.stringify(finalRows.map((r) => r.id))}`);
                    } else {
                        console.error(`   ℹ️ ${info.errLabel}（marker=${marker}）套件末尾查询未找到任何匹配行——如实报告"扫描时点未见"，不等同"确认从未创建过"（不排除标记本身被截断等更深层问题；lastError=${info.lastError || '无'}）`);
                    }
                }
            }
        } catch (e) {
            fail++;
            console.error(`⚠️ [AK1 步骤①异常] pendingFixtures 收尾报告自身异常，不阻断步骤②③：${e.message}`);
        }

        // ── 步骤②：运行标记全表扫描（清理前，独立 try/catch，异常计入失败但不阻断步骤③）──
        // [S1d·AH1 根治·Opus 预筛 H1] 原实现放在清理循环之后，此时 createdIds 对应的库行已被删光，
        // runTagRows 在健康路径下恒为空集：「健康运行」与「标记格式漂移/存放列挪动/LIKE 写错导致
        // 扫描本身失效」在输出上完全不可区分。改为前移到清理循环之前 + 加正向对照：
        //   ① 正向：先断 runTagRowsBefore.length > 0——证明这条查询此刻真的能命中本轮夹具，不是
        //      查询本身已经失效才恒为 0；
        //   ② 反向：过滤出不在 createdIds 登记范围内的行，即「未登记残留」，判失败（不自动删除，
        //      留证据供人工核实，同 AF1「不确定所有权不删」取向）；
        //   ③ 清理循环执行后，用同一份查询再核一次——此时才要求命中 0 条，这个 0 才是「清理真的
        //      生效」的证据，而非「查询已失效」（已由 ① 的正向对照排除这种混淆）。
        let runTagRowsBefore = null;
        let scanBeforeOk = false;
        try {
            runTagRowsBefore = await dbAll(`SELECT id, type, status, description FROM sys_issues WHERE description LIKE ?`, [`%${RUN_TAG_MARKER}%`]);
            const scanBeforePositiveOk = must(runTagRowsBefore.length > 0, `[513-M1 正向对照] 运行标记查询确实能命中本轮夹具（实得 ${runTagRowsBefore.length} 条；为 0 说明标记格式/存放列已漂移，本扫描已失效，不能继续信任下面的"零残留"结论）`);
            const unregisteredRunTagRowsBefore = runTagRowsBefore.filter(r => !createdIds.includes(r.id));
            const scanBeforeUnregisteredOk = must(unregisteredRunTagRowsBefore.length === 0, `[513-M1 反向·清理前] 运行标记扫描无未登记残留（实得=${JSON.stringify(unregisteredRunTagRowsBefore)}——命中但不在 createdIds 登记范围内，说明有夹具漏登记）`);
            // [S1d·补丁AL·AL1 根治·codex 517-M1] 此前无条件把 scanBeforeOk 赋 true——must() 只做
            // fail++ 计数并 return cond，不抛出，即便上面两次 must 双双判红（例如查询本身成功返回
            // 空数组，这正是 AK1_SCAN_FAIL_TEST 覆盖不到、AL1_SCAN_EMPTY_TEST 新覆盖的形态），只要
            // dbAll 没抛异常，无条件赋值就会让步骤③在前提并未成立时仍打印"清理真正生效"。改为两次
            // must 返回值的合取：只有正向对照命中 >0 且清理前无未登记残留同时成立，这份扫描才真的
            // 建立了"清理前有效、清理后可信"的判定基础。
            scanBeforeOk = scanBeforePositiveOk && scanBeforeUnregisteredOk;
        } catch (e) {
            fail++;
            console.error(`⚠️ [AK1 步骤②异常] 运行标记全表扫描（清理前）查询本身异常，不阻断步骤③已登记夹具清理：${e.message}`);
        }

        // ── 步骤③：已登记夹具清理（独立 try/catch，无论①②是否失败都执行）──
        try {
            // 夹具清理——五子表 + 主表逐条 DELETE（本项目 SQLite 未开 FK 级联，需显式清各表；[S1d·
            // AH7 订正] 此前注释误写"六子表"，本项目 config 流实际子表清单恒为下方 5 张，措辞已
            // 订正，不追加表——`sys_issue_release_commit_snapshots`/`sys_fast_release_executors`
            // 是本地 dev 库 seed 脚本 `--reset` 场景才可能产生数据的场景，本 Playwright 套件的
            // config 夹具从不真实走 release execute 落已上线批次这条路径，两张表对本文件恒为 0
            // 行，非本文件清理面缺口）。
            const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_issue_attachments', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
            let cleanupErrorCount = 0;
            for (const id of createdIds) {
                try {
                    for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                    await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
                } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
            }
            const idList = createdIds.length ? createdIds : [-1];
            const placeholders = idList.map(() => '?').join(',');
            let totalResidual = 0;
            const residualDetail = {};
            for (const t of [...CHILD_TABLES, 'sys_issues']) {
                const col = t === 'sys_issues' ? 'id' : 'issue_id';
                const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
                const c = r ? r.c : 0;
                residualDetail[t] = c;
                totalResidual += c;
            }
            console.log(`  🧹 夹具清理完成（共创建 ${createdIds.length} 条，清理异常 ${cleanupErrorCount} 次，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
            if (cleanupErrorCount > 0 || totalResidual > 0) {
                fail++;
                console.warn(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
            }
            // [补丁 AE·AE2] 专项残留核验——AE2 故意指派失败的夹具 id 单独核对主表 + 五张子表均无
            //   残留（不仅靠聚合口径推断：聚合为 0 必然蕴含它也为 0，但这里显式点名核验，直接对应
            //   511-B H2 的验收要求"断言主表与五张子表均无该 id 残留"，且若未来聚合逻辑改动出现
            //   遗漏能独立报红）。
            if (idAe2 != null) {
                let ae2Residual = 0;
                const ae2Detail = {};
                for (const t of [...CHILD_TABLES, 'sys_issues']) {
                    const col = t === 'sys_issues' ? 'id' : 'issue_id';
                    const rr = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col}=?`, [idAe2]);
                    const c = rr ? rr.c : 0;
                    ae2Detail[t] = c;
                    ae2Residual += c;
                }
                must(ae2Residual === 0, `AE2 专项核验：故意指派失败的 config 单 #${idAe2} 在主表+五张子表均无残留（实得=${JSON.stringify(ae2Detail)}）`);
            } else {
                must(false, 'AE2 专项核验：idAe2 未赋值（AE2 测试段可能未执行到，需人工核实）');
            }
            // [S1d·AH1 根治→补丁AK·AK6 措辞订正·codex 516 recommendations（AJ2 输出）] 清理循环
            // 执行完毕后，用同一份 RUN_TAG_MARKER 查询复核——此刻才应命中 0 条。原文案在命中 0 条
            // 时无条件打印带成功语气的"清理真正生效"，但这句结论依赖两个前提：① 步骤②必须成功
            // 建立过"查询确实有效"这一对照（scanBeforeOk）；② pendingFixtures 必须已经清空（否则
            // 即便这份 RUN_TAG_MARKER 扫描查到 0 条，仍有已知的"未确认所有权"夹具没算进这份扫描
            // 里，不能笼统宣称"清理真正生效"）。两个前提任一不成立，只报告"此刻扫描到的行数"这一
            // 事实，不重复步骤②未能建立、或被 pendingFixtures 非空削弱的"整体成功"结论。
            const runTagRowsAfter = await dbAll(`SELECT id, type, status, description FROM sys_issues WHERE description LIKE ?`, [`%${RUN_TAG_MARKER}%`]);
            if (runTagRowsAfter.length > 0) {
                fail++;
                console.error(`⚠️ [513-M1] 清理后运行标记全表扫描仍命中 ${runTagRowsAfter.length} 条（应为 0）：${JSON.stringify(runTagRowsAfter)}——清理循环未能覆盖到这些行，需人工核实并手动清理`);
            } else if (scanBeforeOk && pendingFixtures.size === 0) {
                console.log(`  ✅ [513-M1] 清理后运行标记全表扫描：0 条命中（清理前正向对照已命中 ${runTagRowsBefore.length} 条，证明本查询有效——此刻的 0 是"清理真正生效"而非"查询恒为 0"）`);
            } else {
                console.log(`  ℹ️ [513-M1] 清理后运行标记全表扫描：0 条命中——本条只报告"此刻扫描到 0 条"这一事实，${!scanBeforeOk ? '步骤②未能建立查询有效性前提，' : ''}${pendingFixtures.size > 0 ? 'pendingFixtures 仍非空，' : ''}不宣称"清理真正生效"这一更强的整体成功结论`);
            }
        } catch (e) {
            fail++;
            console.error(`⚠️ [AK1 步骤③异常] 已登记夹具清理自身异常：${e.message}`);
        }

        // ── 步骤④：已登记**批次**清理（独立 try/catch·[S1h·补丁 AQ·codex 524-M2]）──
        //   本套件此前只清 issue 不清批次。T15 起会建批次，故补这一步：与步骤③同款「互不阻断 +
        //   统一汇总失败」形态。清理走真实 DELETE 端点（`reason` 必填·index.js:16885），删成功才
        //   注销登记；删不掉的**留在登记里并逐个报出**，最后一条断言按「登记表是否清空」判红——
        //   即便用例本身抛错、即便 DELETE 网络异常，孤儿批次也一定会在这里被报告，不静默。
        try {
            // ④-a 待恢复标记的**有界重查**（[补丁 AR·codex 525-M2]）——覆盖「响应丢失且查询早于服务端
            //   提交」这一时序：按 tag 重查最多 5 次、间隔 400ms；查到就转成确切 id 纳入下面的删除面。
            //   命中多条 → **不丢线索**：逐条纳入删除面（宁可多删本轮自己建的，也不留孤儿）。
            for (const tag of [...pendingReleaseTags]) {
                let found = [];
                for (let attempt = 0; attempt < 5; attempt++) {
                    try {
                        found = await dbAll('SELECT id FROM sys_releases WHERE version_tag = ?', [tag]);
                        if (found.length > 0) break;
                    } catch (eq) {
                        console.warn(`⚠️ [AR 步骤④-a] tag "${tag}" 第 ${attempt + 1} 次重查异常：${eq.message}`);
                    }
                    await new Promise((r) => setTimeout(r, 400));
                }
                if (found.length > 0) {
                    for (const row of found) registerCreatedReleaseId(row.id);
                    resolvePendingReleaseTag(tag);
                    console.log(`  ℹ️ [AR 步骤④-a] 待恢复 tag "${tag}" 重查命中 ${found.length} 条 → 已纳入删除面：${JSON.stringify(found.map((r) => r.id))}`);
                } else {
                    console.warn(`⚠️ [AR 步骤④-a] 待恢复 tag "${tag}" 重查 5 次均 0 条——**可能服务端确实未建出**，也可能是查询面不对；tag 保留在登记表并由下方断言判红`);
                }
            }
            // ④-b 删除已登记批次：DELETE 后**回库核实**（不只信响应码），失败/异常按有界重试
            for (const relId of [...createdReleaseIds]) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    let httpNote = '';
                    try {
                        const delR = await fetch(`${BASE_URL}/api/sys-releases/${relId}`, {
                            method: 'DELETE', headers: jsonHeaders(adminTok),
                            body: JSON.stringify({ reason: `Playwright 用例临时批次，收尾清理（${RUN_TAG}）` }),
                        });
                        httpNote = `HTTP ${delR.status}`;
                        if (delR.status !== 200) httpNote += `｜${JSON.stringify(await delR.json().catch(() => null))}`;
                    } catch (eDel) {
                        httpNote = `调用异常：${eDel.message}`;   // 网络异常也继续走下面的回库核实
                    }
                    // ⭐ 结果以**库为准**：DELETE 响应可能丢失但服务端已删，也可能返 200 但实际没删。
                    // ⚠️⚠️ [补丁 AT·codex 526-M 根治] 上一版写成 `dbGet(...).catch(() => null)` —— 把
                    //   **查询失败**和**记录不存在**混成同一个 null，于是 `!still` 为真就注销登记：
                    //   **DELETE 失败 ∧ 查询也失败时，真残留的批次会被报告成「清理成功」**。这正是
                    //   「分类表把『判不出来』默认丢给最危险分支」的同一形态（本轮刚在方案 §5 补过 D 兜底）。
                    //   改为三态显式区分：true=仍存在 / false=确认已删 / null=**查询本身失败，什么都不能推定**。
                    //   只有 false 才允许注销；true 与 null 一律保留登记继续重试，耗尽后由最终断言判红。
                    let stillExists = null;
                    try {
                        const still = await dbGet('SELECT id FROM sys_releases WHERE id=?', [relId]);
                        stillExists = !!still;
                    } catch (eQuery) {
                        stillExists = null;
                        httpNote += `｜回库核实查询异常：${eQuery.message}`;
                    }
                    if (stillExists === false) { unregisterCreatedReleaseId(relId); break; }
                    console.warn(`⚠️ [AT 步骤④-b] 批次 #${relId} 第 ${attempt + 1}/3 次未能确认删除（${stillExists === true ? '回库仍存在' : '**查询失败·不作任何推定**'}｜${httpNote}）——保留登记`);
                    await new Promise((r) => setTimeout(r, 400));
                }
            }
            must(createdReleaseIds.length === 0 && pendingReleaseTags.length === 0,
                `[AR 步骤④] 临时批次全部清理干净：已登记 id 残留=${JSON.stringify(createdReleaseIds)}、未解析待恢复 tag=${JSON.stringify(pendingReleaseTags)}（断言对象=两张登记表剩余项 + 逐个回库核实结果，非 DELETE 响应码）`);
        } catch (e) {
            fail++;
            console.error(`⚠️ [AR 步骤④异常] 批次清理自身异常：${e.message}（id 剩余=${JSON.stringify(createdReleaseIds)}｜tag 剩余=${JSON.stringify(pendingReleaseTags)}）`);
        }

        // [补丁 AF·AF2·512-H2 根治] AE4 曾在此与 HTML_ORIGINAL_SRC 逐字节比对——变异机制已改用
        // page.route 内存拦截，本文件全程不再 fs.writeFileSync 共享文件，快照比对连同"发现不一致
        // 就强制覆盖"的兜底一并整体删除。保留一条纯只读残留标记扫描作为最后防线（理论上不可能命
        // 中，命中即说明有代码路径意外写了盘，需要立即人工核实——但本身不做任何写入/覆盖动作）。
        const finalSrc = fs.readFileSync(HTML_PATH, 'utf8');
        if (finalSrc.includes('MUTATION-TEST-TEMP-REMOVE')) {
            fail++;
            console.error('⚠️ 源文件残留变异标记（MUTATION-TEST-TEMP-REMOVE）——本批变异已改用 page.route 内存拦截，理论上不会写盘，出现此信号需立即人工核实！');
        } else {
            console.log('  ✅ 源文件确认不含任何变异标记残留（本批变异全程未写磁盘，见 AF2）');
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (failDetails.length) console.log('失败明细：\n  - ' + failDetails.join('\n  - '));
        if (fail > 0) process.exit(1);
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
