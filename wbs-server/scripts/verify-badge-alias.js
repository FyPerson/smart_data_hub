// verify-badge-alias.js — 状态徽章统一 S2「六别名页接线」静态断言
//
//   与 verify-unify-static.js 的分工：
//     verify-unify-static.js = **共享层**（components.css / unify-helpers.js 的 u- 前缀模型、
//                              语义色板 token、sem-* 语义类、WCAG 对比度、helper 输出形态）
//     本文件               = **页面层**（六别名页的 s-* / si-s-* / status-* 别名规则是否与
//                              S0 双矩阵的状态 key 全集逐个连通、是否已彻底去掉 direct 色值）
//   拆成两个文件的理由：① 关注点不同（共享层封版 vs 页面层逐页接线），混在一起会让本就 ~700 行的
//   守卫继续膨胀；② 本文件带一张按页组织的大配置表（PAGE_ALIAS_SPECS），独立成文更易逐页核对。
//   ⚠️ **分工扩权登记（通知统一 N1·2026-08-09）**：本文件自 N1 起**兼管一部分共享层断言**——
//     通知文本 7 槽 u-nt-*（components.css）/ u-nr-read-result 上提 / J13 操作栏特异性补丁 /
//     showToast 全站单源（见文件末 runNotifyUnifyN1Assertions）。按上面的分工本该落 verify-unify-static.js，
//     放这里的理由：这批断言与"通知族"强绑（借色登记要与 BORROWED_TIERS 同款口径、u-nt-* 与通知徽章族
//     共用一套语义层），拆开会让通知这条线的判据散在两个文件。**显式登记＝承认这是扩权，不是默默漂移**；
//     若日后共享层断言在本文件继续增厚，应整体回迁 verify-unify-static.js 而不是再加特例。
//   ⚠️ 但项目里没有聚合 runner（package.json 无 test 脚本），独立文件有"没人跑"的风险——
//   故本文件同时导出 runBadgeAliasAssertions(check)，由 verify-unify-static.js require 后并入
//   它的断言流程，保证**跑一条命令就全跑到**；单独 `node verify-badge-alias.js` 亦可独立运行。
//
//   断言清单（逐页）：
//   ⑨  状态 key 全集 → 别名规则**逐个连通**：S0 矩阵实测的每个 key 都存在恰一条别名规则
//       （少一条 = 该状态掉进 base 的 wait fallback 变中性灰，用户看不出是"没接线"还是"真的在等待"）。
//   ⑩  每条别名规则**封闭**：规则体内只允许出现六个 `--sb-*` 声明，各一次，且逐项严格等于
//       `var(--sem-<层>-<键>)`（层名须在 14 层集合内）。多出任何其他属性（border/text-decoration/
//       padding…）即红——别名规则的职责就是"指向哪一层"，一旦夹带具体样式，共享层就不再是单一
//       真相源，且那些属性会绕过 token 直接生效（与 direct 色值双存同一类病）。
//   ⑪  **白名单式**收口（22B·B-H5 方向反转）：页内 <style> 里凡是选择器沾到 `.u-status-badge`
//       或本页别名前缀的规则，必须精确等于某条登记的别名选择器，否则一律红（STYLE_TAIL_WHITELIST
//       可显式登记例外）。上一版是黑名单（只抓 direct 色值 + 尾节点两种形态），漏项即放行——
//       `:hover` / `[attr]` / 组合类 / `#id` 前缀 / `:is()` 包装全都绕得过去，而它们同样能改观感。
//       守卫的默认答案应该是"不许"，不是"没见过就放行"。
//   ⑫  class 片段白名单闭环（终审 M）：非受控三页必须有 frozen map；map 经 **AST** 提取 key/value
//       对（B-H3：按 property 节点配对，并断言 key 无重复——JS 对象重复键取末次，与人读到的首次
//       不一致，是标准分叉通道）；**value 必须精确等于配置表 selector 去根类前缀后的片段**
//       （配置表 ↔ map ↔ CSS 三点闭环）；map keys 须 ⊆ 配置表 keys。
//   ⑨b 反向断言（M-2 + B-H1/H2）：页面**真实状态源**常量经 AST 提取，其成员集须 ⊆ 配置表 keys。
//       ⑨ 只保证"配置表里写的都接线了"，⑨b 才保证"页面新增了状态不会漏接线"。
//       **为什么必须 AST**：上一版在原始文本上正则找常量，注释里写一句 `const STATUS_LABELS={FAKE:'x'}`
//       就能骗过它。acorn 解析出的 AST 只含真实代码结构，注释与字符串内容不成节点。
//       纪律：解析失败 / 常量找不到 / 遇到动态成员（计算属性、模板串、变量引用）——**一律判红
//       fail-closed**，绝不"跳过继续"：守卫的失败模式必须是喊停，不能是沉默放行。
//   ⑬  gate 覆盖（B-H4）：renderGate 形态的**出现次数恰等** renderGateCount（只断"有"挡不住
//       "五处里被改掉四处"）；外加 DOM API 侧负向扫描（classList/className/setAttribute 写徽章
//       class 的旁路完全绕开模板与 gate，针对模板串的正则一概看不见）。
//   ⑭  --sem-* 越界（B-H6②）：迁移页 `style=""` 内联属性里不得定义 --sem-* token
//       （元素级覆盖优先级最高，且守卫扫 CSS 时看不见）。
//       B-H6① 的另一半（components.css 内 :root 之外的定义）在 verify-unify-static.js。
//   ⑮  双源比对（B-H7）：Sys 的 SI_STATUS_CLASS 与 spec.fullMap 期望表**逐对**比对（只比集合的话
//       两条 value 互换照样全绿）；Issue_Tracker / Data_Collab 另与 **server.js 后端状态源**
//       比对（CHECK 枚举 / COLLAB_STATUSES）。后端提取失败 = 红灯 fail-closed。
// ============================================================
// 守卫覆盖声明表（S4-fix5 新增·终局透明化）
// ============================================================
//   这一节回答的是**"跑绿了到底证明了什么"**。守卫最危险的用法是把"它没红"当成"这里没问题"，
//   而两者之间永远隔着一条边界。把边界写在这里，是为了让下一个维护者一眼读到，
//   而不是去逐个函数反推——也为了将来放宽任何一条时，能看见自己在放宽什么。
//
//   【已覆盖 covered】静态溯源守卫能看见、并会判定的"把 class 写进 DOM"的形态：
//     · 模板字符串里的 class 属性（含跨 quasi 的动态片段）
//     · 字符串 `+` 拼接里的 class 属性（与模板摊平成同一份 parts 后统一扫）
//     · innerHTML / outerHTML 赋值、insertAdjacentHTML(pos, html)
//     · className 赋值（含 el['className'] 计算成员形态）、setAttribute('class', …)
//     · classList.add / toggle / replace（**实参可以是变量**）
//     · 无引号属性值（`class=${x}` / `class=foo`）、属性名大小写、HTML 实体解码
//     · 静态还原：字面量 / 模板 / 拼接 / 三元 / 或运算 / 单次赋值变量 /
//       冻结对象的静态成员（`HTML.badgeStart`）/ 全部 return 同一静态串的本地 helper（含带参）
//     · 解构绑定按 ObjectPattern / ArrayPattern 路径投影（投不出即 fail-closed 判红）
//     · 变量的**全部写入右值**（不只初始化器）；取不到右值的写形态（for-of 每轮绑定 / 解构赋值 /
//       自增）计入 unknownWrites 判红
//     · gate 自身的 return 形态（白名单取值 / 登记字面量 / 守门三元；成员链严格两层）
//     · 页面真实 <script src> 清单 ↔ spec.sharedJs 对账；未登记的本地/远程脚本判红
//     · 未能静态还原的片段：只要其**浅层可达的普通字符串字面量**里带徽章类名，就 fail-closed 生成 sink
//
//   【不覆盖 not-covered】以及各自靠哪一层兜底 —— 明示，不假装：
//     · **跨文件函数调用的返回值**（本页调用别的文件里定义的函数）：作用域索引是按单个源建的，
//       解析不到 → 落"参数/未解析"分支判红或计入跟不动节点。兜底＝computed harness 实测
//       （真渲染出来的 class 与色值逐条比对）。
//     · **eval / new Function / 动态 import 引入的代码**：AST 里根本不存在。兜底＝同上 computed 实测；
//       本项目页面代码不使用这三者（若引入，assertNoUnparsedScripts 与本表都要同步重估）。
//     · **服务端下发数据里带 class 字样**：静态分析看不见运行时数据。兜底＝白名单 map + gate
//       （原值没有进 class 的通道）＋ computed harness 的"页面上无未登记修饰类"断言。
//     · **非徽章 class 片段的任意动态来源**（`class="task-card ${x}"` 这类）：只判"不可能产出徽章标记"，
//       不判它自身正确性。兜底＝视觉基线重拍 + 人工验收；威胁模型登记接受（防疏忽非防对抗者）。
//     · **字素簇截断**（ZWJ emoji 被从中间拆开）：A-L1 只保证码点安全。兜底＝人工验收；
//       输入是后端状态枚举，出现 ZWJ emoji 本身已是要 warn 的异常数据。
//     · **border-radius 圆角裁剪**：D4 只做轴对齐矩形包含判定。兜底＝S5b 视觉基线重拍的像素差。
//     · **CDN 远程脚本的内容漂移**（登记的 URL 不变、内容被上游改了）：本守卫只验"URL 已登记"。
//       兜底＝供应链策略（版本号锁定在 URL 里，如 echarts@5.4.3 / marked@11.1.1）＋ computed 实测。
//     · **CSS 侧的视觉正确性**（色值好不好看、对比度够不够）：由 verify-unify-static.js 的
//       token/对比度断言与 computed harness 的逐属性比对负责，不在本文件范围内。
//
//   【不覆盖 not-covered·S4-fix6 补充五条】——24F 列出的新边界，同样明示不假装：
//     · **可变函数绑定被重写**（`let h = …; h = 别的实现`）：直接形态已被 resolveLocalFunction 的
//       "绑定写引用检查"拦下（有额外写入即放弃投影，落未解析片段）；但跨函数/跨条件的复杂重写
//       （在别处某个分支里改掉 h）静态判不了。兜底＝computed harness 实测真渲染结果。
//     · **成员方法 / 函数别名 / 高阶调用充当 helper**（`obj.render()`、`const r = render; r()`、
//       `arr.map(render)`）：resolveLocalFunction 只解析"标识符直接指向本地函数声明/函数变量"这一种。
//       **本项目代码零命中**（2026-08-08 主会话实证）。将来出现时，该调用会落进「未解析片段
//       fail-closed」（其浅层可达字面量带徽章类名即红），再兜一层 computed 实测。
//     · **跨 classic script 的顶层重写**（页内多个 <script> 块或外链脚本互相覆盖同名顶层常量）：
//       本文件把一页的脚本拼成一个源分析，同名重定义会被"常量恰一个源声明/恰一处声明"类断言拦住
//       （map 与 helper 都在此列）；不在断言清单里的其他顶层符号被跨块重写则看不见。
//       兜底＝computed harness 实测。
//     · **CSS transform / zoom 影响下的裁剪几何**：D4 的裁剪判定用的是未变换的布局矩形，
//       祖先带 transform/zoom 时几何对不上。已改为**输出诊断而不判红**（明示不支持，好过算错边界）。
//       兜底＝S5b 视觉基线重拍的像素差。
//     · **overflow-clip-margin**：它会把裁剪边界外扩若干像素，本判定不计入，可能把"其实没被切"
//       误算成越界（偏保守方向）。兜底＝同上视觉基线像素差 + 人工验收。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 15 个语义层（与 components.css :root、verify-unify-static.js 的 SEM_TIERS 三方同源）
//   prerelease = 第 14 层（待上线可见性 20260812 v1.0·D1b）：「待上线」专属橙色相，与 staging
//   （交付/传输语义·数据协作 EXPORTING/TRANSFERRING 共用）分层，不是改 staging。
//   fastlane = 第 15 层（先行上线两步化 S7·方案 20260813 v1.8 §6）：「待先行部署 x/N」专属靛紫色相。
const SEM_TIERS = [
    'wait', 'intake', 'active', 'review', 'special', 'staging', 'prerelease', 'fastlane',
    'done', 'hold', 'rejected', 'failed', 'archived', 'voided', 'legacy',
];
const SEM_TOKEN_SUFFIXES = ['bg', 'fg', 'bd', 'bds', 'dot', 'deco'];

// ⑪b 的例外登记表：file → 允许存在的「尾节点为 .u-status-badge」选择器清单。
//   **有意留空**——S2 把最后一条（DC 的投影覆盖）删掉后，全站零例外。
//   将来确有页面需要覆盖共享层徽章观感，在这里登记并写清理由，让它成为一个**被看见的决定**
//   而不是又一条没人知道的页间差异。
const STYLE_TAIL_WHITELIST = Object.freeze({
    // 'Some_Page.html': ['.unified-page .u-status-badge'],   // 理由：…
});

// ============================================================
// 逐页配置表
//   来源：状态徽章统一_S0双矩阵_20260808_v1.0.md 第一节「真实 DOM 输出矩阵」的③状态 key 全集，
//        映射层依据同文档 + 方案 v1.2 §2.4。**这张表就是"应该长什么样"的真相声明**——
//        页面被改坏时它红，它被改坏时页面对不上也红，两边互为对照。
//   字段：
//     selector(key)  该 key 对应的完整选择器（各页历史前缀形态不同，S2 不做改名以免扩大回归面）
//     tiers          key → 语义层名（六值同层；跨层 deco 组合已随 S2-fix 取消，无此类特例）
//     statusSource   页面真实状态源常量（⑨b 反向断言用）：{ const, kind, minOccurrences }
//                    kind='objectKeys' 取对象键 / 'objectValues' 取对象值 / 'arrayItems' 取数组元素。
//                    用**常量名锚定 + 配对提取**，不写行号（行号随编辑漂移，锚点不会）。
//     renderGate     渲染点必须出现的调用形态（受控页同样要有——受控靠的是 gate，不是运气）
//     renderGateCount     gate 形态的**精确出现次数**（B-H4：只断"有"挡不住"少了一处"）
//     fullMap        完整期望表 { const, entries }，与页面常量 AST entries **逐对**比对（B-H7①）
//     backendSource  后端状态源 { label, mode:'equal'|'subset', extract(serverJsSrc)=>string[] }（B-H7②③）
//     rawConcatForbidden  禁止出现的"原值直拼 class"正则
// ============================================================
// ── S4：任务池 / 工作台共用的期望表 ────────────────────────────────────────
//   两页共用 app.js 的同一个白名单（TASK_STATUS_BADGE），期望表只写一份、两个 spec 同引，
//   免得"改了一页忘了另一页"——这类双份手抄表正是本守卫一直在防的漂移形态。
const TASK_STATUS_EXPECT = Object.freeze({
    OPEN: 'sem-wait',
    CLAIMED: 'sem-active',
    ON_HOLD: 'sem-hold',
    TRANSFERRING: 'sem-staging',
    DONE: 'sem-review',
    ARCHIVED: 'sem-archived',
});
// 文案表：卡片文案 label / 抽屉文案 drawerLabel，取值来自 S0 双矩阵实测的**现网各分支实际文案**。
//   DONE 两处不同（卡片「待确认」/ 抽屉「已提交」）是历史现状，S4 原样保留、逐字钉死。
const TASK_STATUS_LABELS = Object.freeze({
    OPEN: { label: '待认领', drawerLabel: '待认领' },
    CLAIMED: { label: '进行中', drawerLabel: '进行中' },
    ON_HOLD: { label: '存疑', drawerLabel: '存疑' },
    TRANSFERRING: { label: '转发中', drawerLabel: '转发中' },
    DONE: { label: '待确认', drawerLabel: '已提交' },
    ARCHIVED: { label: '已归档', drawerLabel: '已归档' },
});
// 两页共同的旧类禁令。
//   ⚠️ 作用域：只对本 spec 的源（该页 HTML + app.js）生效。`status-badge` 在
//   Asset_Center / Domain_Manager 页内仍是合法输出（它们不在 spec 里，不被扫），
//   style.css 的 `.status-badge` base 也**有意保留**（P1 口径），由 verify-unify-static.js 的
//   "退场不过头"断言单独看住。这里禁的是"这两页 + app.js 里还残留旧徽章类"。
const TASK_LEGACY_BADGE_CLASSES = Object.freeze([
    'badge-open', 'badge-claimed', 'badge-done', 'badge-hold', 'badge-archived', 'status-badge',
]);

// server.js 里 keys===values 形态的状态常量提取器（MODEL_STATUS / TASK_STATUS 同款）。
//   先断言"键与值逐项相等"这条契约，再拿 **value 集**去比——只比 key 的话，把 ONLINE 的值
//   改成 'LIVE' 照样全绿，而后端实际下发的是 'LIVE'。
function keysEqualValuesConstExtract(constName) {
    return (src) => {
        const parsed = parseJs(src);
        if (!parsed.ok) return { error: 'server.js 解析失败：' + parsed.error };
        const nodes = [];
        walkAst(parsed.ast, (n) => {
            if (n.type === 'VariableDeclarator' && n.id && n.id.name === constName) nodes.push(n.init);
        });
        if (nodes.length !== 1) return { error: `${constName} 声明 ${nodes.length} 处（期望 1）` };
        const obj = unwrapFreeze(nodes[0]);
        if (!obj || obj.type !== 'ObjectExpression') return { error: `${constName} 不是对象字面量` };
        const dup = duplicateKeysOf(obj);
        if (dup.length) return { error: '重复 key：' + dup.join(' | ') };
        const pairs = [];
        for (const pr of obj.properties) {
            if (pr.type !== 'Property' || pr.computed) return { error: '含计算属性/展开，无法静态判定' };
            const k = pr.key.type === 'Identifier' ? pr.key.name : String(pr.key.value);
            if (pr.value.type !== 'Literal' || typeof pr.value.value !== 'string') return { error: `键 ${k} 的值不是静态字符串` };
            pairs.push([k, pr.value.value]);
        }
        const mismatched = pairs.filter(([k, v]) => k !== v);
        if (mismatched.length) {
            return {
                error: `${mismatched.length} 项 key≠value：${mismatched.map(([k, v]) => `${k}→'${v}'`).join(' | ')}`
                    + ` —— ${constName} 的契约是 keys===values，破了说明后端实际下发值与常量名脱钩，徽章映射的比对基准失效`,
            };
        }
        return { values: pairs.map(([, v]) => v) };
    };
}

const PAGE_ALIAS_SPECS = [
    {
        file: 'Data_Correction.html',
        selector: (k) => `.u-status-badge.s-${k}`,
        // S0 矩阵：9 态（暂缓与列表导出方案 v1.1 §2.5.1 新增 SUSPENDED→hold，对齐 Sys_Iteration .si-s-hold 同 tier）
        //   + statusClass() 未命中兜底 s-UNKNOWN（有意不写规则，落 base wait fallback）
        tiers: {
            PENDING_ASSIGN: 'wait',
            ASSIGNED_PENDING_ESTIMATE: 'intake',
            IN_PROGRESS: 'active',
            SUSPENDED: 'hold',
            FIXED: 'done',
            REFIXED: 'done',
            ARCHIVED: 'archived',
            REJECTED: 'rejected',
            VOIDED: 'voided',
        },
        // 有意不接线的 key：写在这里是为了"知道它存在且是故意的"，而不是漏了
        intentionallyUnmapped: ['UNKNOWN'],
        // 本页受控靠 statusClass() 这道 gate（用 STATUS_LABELS 键集守门，未命中出 s-UNKNOWN）。
        // 五个渲染点两种形态：UnifyHelpers 调用 ×2（列表 / 抽屉 kv）+ 模板直写 ×3（状态历史 / 组内成员 ×2）。
        statusSource: { const: 'STATUS_LABELS', kind: 'objectKeys' },
        // M5：gate 按 **AST 调用次数**锁定。statusClass 是全部 5 个渲染点的共同守门（2 处经
        //   UnifyHelpers.statusBadge、3 处模板直写），它才是"class 片段必过此关"的真不变量。
        classGate: 'statusClass',
        // 〔B5〕守门谓词显式登记：本页 statusClass 现为
        //   `Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? s : 'UNKNOWN'`（S4-fix3 收紧，
        //   原真值测试会让 'constructor' 等原型链键被原样输出）。准入形态只剩 includes / hasOwnProperty。
        predicateGate: [{ form: 'hasOwnProperty', const: 'STATUS_LABELS' }],
        renderGate: ['statusClass', 'UnifyHelpers.statusBadge'],
        renderGateCount: { statusClass: 5, 'UnifyHelpers.statusBadge': 2 },
        // 负向前瞻：放行 s-${statusClass(...)}，拦住任何**绕过 gate** 的 s-${...}
        rawConcatForbidden: [/u-status-badge s-\$\{(?!statusClass\()/],
    },
    {
        file: 'Statistics.html',
        selector: (k) => `.u-status-badge.s-${k}`,
        tiers: { done: 'done', inflight: 'active', aborted: 'wait' },
        // aborted = "异常终止"的统计归并标签，用于扫瓶颈单，需要被看见：映射 wait 层（中性灰·4.55 达标），
        // 不用 voided（作废记录刻意弱化层·2.43 豁免档·继承弱化会伤本页功能）。S2 提案 1 主会话裁定。
        // ⚠️〔A-M1〕借的是 wait 的**色值**不是它的**语义**：aborted 真实语义 = 聚合负终态（已终止、
        //    不再推进），不是"等待中/未开始"；语义由 label 文字承载（方案 §1「不靠色单独传义」）。
        //    归并口径真相源 utils/efficiency-stats.js 四个 loader：
        //      correction=['REJECTED','VOIDED']／issue=['已拒绝','已暂缓']／
        //      collab=archived_at 非空（行政归档/中止留痕）／sys=['已暂缓','已拒绝','已作废']。
        mapConst: 'ST_STATUS_CLASS',
        statusSource: { const: 'STATUS_GROUP_LABEL', kind: 'objectKeys' },
        // 本页经共享 helper 出徽章，页内没有 class 映射函数——显式登记，不让它变成一次沉默的跳过
        classGate: null,
        classGateNote: '走共享 helper UnifyHelpers.statusBadgeByMap，其输出形态由 verify-unify-static.js 断言⑧ 覆盖',
        renderGate: ['UnifyHelpers.statusBadgeByMap'],
        renderGateCount: { 'UnifyHelpers.statusBadgeByMap': 1 },
        rawConcatForbidden: [/u-status-badge s-\$\{/],
    },
    {
        file: 'Issue_Lite.html',
        selector: (k) => `.u-status-badge.s-${k}`,
        tiers: { '待处理': 'wait', '处理中': 'active', '已完成': 'done', '已归档': 'archived', '已作废': 'voided' },
        // 〔A-M3〕原本列表 / 详情各写一份同名局部 const STATES，靠人肉同步、守卫得靠 minOccurrences 数份数
        // 才能发现有人删了其中一份。已升为顶层唯一 ISSUE_LITE_STATES(frozen)，两处共用，分叉通道消失。
        // 第 5 态「已作废」由 voided_at 派生，不是落库 status，故不在数组内（模板走字面量分支）。
        statusSource: { const: 'ISSUE_LITE_STATES', kind: 'arrayItems' },
        // 〔B5〕守门谓词显式登记：`ISSUE_LITE_STATES.includes(it.status) ? it.status : '待处理'`
        //   —— 数组成员测试，非成员必落默认分支。不再从 renderGate 名自动推导守门形态
        //   （自动推导会把 `任意gate(s) ? s : ''` 也当成"已守门"，而那种写法根本不做成员判定）。
        predicateGate: [{ form: 'includes', const: 'ISSUE_LITE_STATES' }],
        // 本页守门是白名单**数组**成员测试（ISSUE_LITE_STATES.includes），片段=被验过的入参本身，无独立 class 函数
        classGate: null,
        classGateNote: '守门形态为 ISSUE_LITE_STATES.includes(...) 三元，由 class sink 溯源的「守门三元」分支覆盖',
        renderGate: ['ISSUE_LITE_STATES.includes'],
        renderGateCount: { 'ISSUE_LITE_STATES.includes': 2 },
        // 两个模板变量（stDisp / isVoided 三元）都已过守门；要拦的是"把某个 .status 字段
        // 直接塞进 class"这种绕过写法。
        rawConcatForbidden: [/u-status-badge s-\$\{[^}]*\.status\b/],
    },
    {
        file: 'Issue_Tracker.html',
        selector: (k) => `.u-status-badge.s-${k}`,
        tiers: { '待处理': 'wait', '处理中': 'active', '待验证': 'review', '已关闭': 'done', '已暂缓': 'hold', '已拒绝': 'rejected' },
        mapConst: 'IT_STATUS_CLASS',
        // B-H7②：后端 issues 表 status CHECK 枚举 ↔ 本表 keys **全等**。锚定 CHECK 语句而非行号。
        backendSource: {
            label: 'issues.status CHECK 枚举',
            mode: 'equal',
            extract: (src) => {
                const m = src.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/);
                if (!m) return [];
                return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
            },
        },
        // 3 个渲染点：列表 + 详情用 itStatusClass(issue.status)，状态历史用 itStatusClass(h.to_status)。
        //   总次数锁 3；同时保留两条带实参指纹的细分断言，防"三次调用都挪到同一个点"这种等量替换。
        classGate: 'itStatusClass',
        renderGate: ['itStatusClass', 'itStatusClass(issue.status)', 'itStatusClass(h.to_status)'],
        // 〔M5〕本页次级族/类型族的合法 gate（计数在 SECONDARY_FAMILY_SPECS，此处只作溯源准入）
        extraSinkGates: ['itNotifyClass', 'itPriClass'],
        // 〔S5a-fix3 项 4·登记〕`typeClass` **不是白名单 gate，是原值规范化器**：
        //   `'t-' + String(type).replace(/[\/\s]/g, '-')` —— 后端给什么类型就产出什么 class，
        //   未知类型会得到一个没有对应规则的 `t-xxx`（无样式、无注入面，但也不受白名单管）。
        //   本页类型族与 Sys 的类型族（S0 甲5 已改白名单）是**同一类缺口**，只是 S5a 的范围只点了 Sys。
        //   这里如实登记为 normalizer：溯源层接受它（否则整条 sink 变红而无人能修），
        //   但**不给它专属片段集**（输出集本就无界），并把已知七类登记下来防漂移。
        //   收口方式与 Sys 同款（建 frozen map + gate），属**独立事项**，本批未擅自扩范围。
        normalizerGates: [{
            name: 'typeClass',
            why: '原值规范化（t- + 类型名，斜杠/空格转连字符），非白名单；未知类型产出无规则的 class',
            knownClasses: ['t-看板-报表需求', 't-数据治理需求', 't-数据应用需求', 't-平台-bug', 't-数据质量', 't-源系统变更', 't-调度异常'],
        }],
        renderGateCount: { itStatusClass: 3, 'itStatusClass(issue.status)': 2, 'itStatusClass(h.to_status)': 1 },
        rawConcatForbidden: [/u-status-badge s-\$\{/],
    },
    {
        file: 'Sys_Iteration.html',
        selector: (k) => `.si-s-${k}`,
        // S0 矩阵：13 条 CSS / 12 条可达（scheduled 已无产出方，保留供历史徽章兜底 → legacy 层）
        tiers: {
            pending: 'wait', scheduled: 'legacy', intake: 'intake', revision: 'review',
            // [待上线可见性 20260812·D1b] prerelease 由 staging 改指第 14 层同名 prerelease 层
            //   （橙）——CSS 侧 .si-s-prerelease 已同步改引；这条映射不跟着改会当场红。
            dev: 'active', liaisontest: 'special', review: 'review', prerelease: 'prerelease',
            released: 'done', closed: 'archived', hold: 'hold', rejected: 'rejected', void: 'voided',
        },
        // 本页是全站唯一原本就有 key→class 白名单的页：SI_STATUS_CLASS 的 **value 集**就是 class 片段
        // 全集，故 kind='objectValues'（它的 key 是中文状态值，与本表的英文片段 key 不同名）。
        statusSource: { const: 'SI_STATUS_CLASS', kind: 'objectValues' },
        // B-H7①：16 中文状态 → 12 class 片段的**完整期望表**，抄自 S0 双矩阵 §1.1 Sys_Iteration ③b。
        //   与页面 SI_STATUS_CLASS 逐对比对——只比成员集合的话，把 dev/review 两条 value 互换照样全绿，
        //   而页面会给"开发中"渲染成"待验证"的颜色。
        fullMap: {
            const: 'SI_STATUS_CLASS',
            entries: {
                '待受理': 'intake', '待修改': 'revision',
                '待指派': 'pending', '待处理': 'pending',
                '开发中': 'dev', '处理中': 'dev',
                '待对接测试': 'liaisontest',
                '待验证': 'review', '待验收': 'review',
                '待上线': 'prerelease',
                '已上线': 'released', '已生效': 'released',
                '已关闭': 'closed',
                '已暂缓': 'hold',
                '已拒绝': 'rejected',
                '已作废': 'void',
            },
        },
        classGate: 'siStatusClass',
        renderGate: ['siStatusClass'],
        // 〔S5a-fix3 自查〕`siExecSummaryBadgeHtml` 不在本表：它返回**整段 HTML**、不是 class 片段 gate
        //   （fix2 顺手加进来是分类错误）。它内部那条 `class="si-release-badge ${cls}"` 的 cls
        //   来自 SI_EXEC_SUMMARY_CLS，已由下方 extraWhitelistConsts 覆盖，不需要也不该按 gate 登记。
        extraSinkGates: ['siTypeClass', 'siPriClass', 'siDevStatusClass'],
        // si-release-badge 的 class 片段来自两张受控 map + 'plan' 兜底（S0 §4.4 举证受控）：
        //   `SI_EXEC_SUMMARY_CLS`（批次通知汇总·:5480）与 `SI_EXECUTOR_NOTIFY_CLS`（逐执行人·:5500）。
        //   ⚠️ 第二张是 M5 并入 sink 溯源后才暴露出来的——S0 §4.4 只记了第一张，
        //   文本正则时代看不见它。这就是把这些族并进 AST 溯源的价值：漏登记的站点会自己报出来。
        // 〔S5a-fix3 项 2〕结构化登记：值域 + 形状 + freeze 现状三项都要与实际一致才进白名单。
        //   两张 map 都是 si-release-badge 的片段来源；第二张是 M5 并入 AST 溯源后才暴露出来的
        //   （S0 §4.4 只记了第一张，文本正则时代看不见它）。
        extraWhitelistConsts: [
            {
                name: 'SI_EXEC_SUMMARY_CLS', shape: 'stringValues', values: ['done', 'fail', 'plan', 'warn'],
                why: '批次通知汇总六态 → si-release-badge 四片段',
            },
            {
                name: 'SI_EXECUTOR_NOTIFY_CLS', shape: 'stringValues', values: ['done', 'fail', 'plan', 'warn'],
                why: '逐执行人通知五态 → 同上四片段',
            },
        ],
        // [S13-b·B2] 3→4：siDeriveFamilyBlockHtml（矩阵行5 派生链区块，新渲染点）新增一处 siStatusClass
        //   调用（成员状态徽章，同列表行/详情头/批次成员三处既有站点同款用法），非漏登记/非误删旧站点。
        renderGateCount: { siStatusClass: 4 },
        rawConcatForbidden: [/si-s-\$\{(?!siStatusClass\()/],
    },
    {
        file: 'Data_Collab.html',
        selector: (k) => `.status-${k}`,
        tiers: {
            PENDING_ASSIGN: 'wait', PENDING: 'wait', EXPORTING: 'staging', SUBMITTED: 'review',
            DONE: 'done', ARCHIVED: 'archived', CONFIRMED: 'legacy', CLAIMED: 'legacy',
        },
        mapConst: 'COLLAB_STATUS_CLASS',
        // B-H7③：后端 COLLAB_STATUSES 数组 ⊆ 本表 keys。用 subset 而非 equal 是给"前端多留兼容态"
        //   留余地（本表含 2 个旧态 CONFIRMED/CLAIMED）；后端有而前端没接线的，一律红。
        backendSource: {
            label: 'server.js COLLAB_STATUSES',
            mode: 'subset',
            extract: (src) => {
                const m = src.match(/const\s+COLLAB_STATUSES\s*=\s*\[([^\]]*)\]/);
                if (!m) return [];
                return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
            },
        },
        statusSource: { const: 'STATUS_LABELS', kind: 'objectKeys' },
        classGate: 'collabStatusClass',
        renderGate: ['collabStatusClass', 'collabStatusClass(r.status)', 'collabStatusClass(d.status)'],
        // val-badge 族的 class 片段来自 SQL_VALIDATION_LABELS 的 .cls 字段（S0 §4.4 举证受控）
        //   〔S5a-fix3 项 2〕结构化登记：值是对象、class 片段在 cls 字段上。
        extraWhitelistConsts: [
            {
                name: 'SQL_VALIDATION_LABELS', shape: 'objectValues', field: 'cls',
                values: ['val-bypassed', 'val-failed', 'val-passed', 'val-running'],
                why: '验收态四值 → val-badge 四片段',
            },
        ],
        renderGateCount: { collabStatusClass: 2, 'collabStatusClass(r.status)': 1, 'collabStatusClass(d.status)': 1 },
        rawConcatForbidden: [/u-status-badge status-\$\{/],
    },

    // ══ 以下两页走 **sem 模式**（S3 收编）══════════════════════════════════════════
    //   与上方六个「别名页」的根本差别：它们直接输出 `u-status-badge sem-*`，
    //   **页内没有、也不该有任何别名规则**——sem-* 的样式只在共享层 components.css。
    //   故断言形态相应改变：不校"每个 key 有别名规则"，改校
    //     ① frozen map 存在且键集与 expectStatuses 全等
    //     ② map 的 value 必须是 14 层里的 `sem-<层>`
    //     ③ 渲染点走 gate + 次数恰等
    //     ④ 页内不残留旧类输出（pf-badge / b-status）
    //     ⑤ 页内 <style> 里不得出现任何 sem-* 规则（写了就是把共享层的定义又抄了一份）
    {
        file: 'Periodic_Fetch.html',
        mode: 'sem',
        // 期望状态集 = 两张表 CHECK 的并集里**会渲染成徽章**的那些：
        //   periodic_task_runs.status 全 5 值 + periodic_tasks.status 的 'disabled'
        //   （'active' 任务态从不渲染徽章——原 .pf-badge.active 是死 CSS，S3 已删）
        expectStatuses: {
            success: 'sem-done', failed: 'sem-failed', running: 'sem-active',
            queued: 'sem-wait', empty_result: 'sem-review', disabled: 'sem-voided',
        },
        mapConst: 'PF_STATUS_CLASS',
        // ⚠️ S0 双矩阵把本页记为"无 CHECK"，实为**只扫了 server.js**——PF 建表在
        //   routes/periodic-fetch/index.js。两张表都有 CHECK，故这里比对**两条**（MED-4）：
        //   徽章期望集是二者的并集（runs 全 5 值 + tasks 的 disabled），少比一张表就漏一半防线。
        backendSources: [
            {
                label: 'periodic_task_runs.status CHECK 枚举',
                mode: 'subset',
                file: path.join(__dirname, '..', 'routes', 'periodic-fetch', 'index.js'),
                table: 'periodic_task_runs',
                // runs 表写法：`status TEXT NOT NULL CHECK (status IN (...))`
                // tasks 表写法：`status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (...))`
                //   —— DEFAULT 夹层是两者唯一差别，正则用可选组容纳。
                extract: (block) => {
                    const m = block.match(/status\s+TEXT\s+NOT\s+NULL(?:\s+DEFAULT\s+'[^']*')?\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/);
                    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
                },
            },
            {
                label: 'periodic_tasks.status CHECK 枚举',
                // tasks 表的 'active' 从不渲染徽章（只有 disabled 渲染），故不能要求全被覆盖。
                mode: 'subsetExcept',
                except: ['active'],
                file: path.join(__dirname, '..', 'routes', 'periodic-fetch', 'index.js'),
                table: 'periodic_tasks',
                extract: (block) => {
                    const m = block.match(/status\s+TEXT\s+NOT\s+NULL(?:\s+DEFAULT\s+'[^']*')?\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/);
                    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
                },
            },
        ],
        classGate: 'pfStatusClass',
        renderGate: ['pfStatusClass', 'pfStatusClass(last.status)', 'pfStatusClass(run.status)', "pfStatusClass('disabled')"],
        extraSinkGates: ['pfRecipClass'],
        renderGateCount: { pfStatusClass: 3, 'pfStatusClass(last.status)': 1, 'pfStatusClass(run.status)': 1, "pfStatusClass('disabled')": 1 },
        // M6：标识符级匹配。PF 的 pf-badge 是**整族退场**，故整个类名列入。
        forbiddenClasses: ['pf-badge'],
        // 模板串里除了登记的 gate 形态，不许有别的东西被拼进徽章 class
        rawConcatForbidden: [/u-status-badge (?:sem-)?\$\{(?!pfStatusClass\(|PF_STATUS_CLASS\.)/],
        requiresComponentsCss: true,
    },
    {
        file: 'Model_Center.html',
        mode: 'sem',
        // 方案 §2.5 明文五值（原实现只有 ONLINE/非 ONLINE 二值 → 正向行为变更）
        expectStatuses: {
            CREATED: 'sem-wait', DEVELOPING: 'sem-active', REVIEWING: 'sem-review',
            ONLINE: 'sem-done', OFFLINE: 'sem-archived',
        },
        mapConst: 'MDC_STATUS_CLASS',
        statusSource: { const: 'MODEL_STATUS_MAP', kind: 'objectKeys' },
        // MED-3：后端 server.js 的 MODEL_STATUS 常量（5 值，keys===values）↔ 本表键集**全等**。
        //   前端 MODEL_STATUS_MAP 只是文案表，跟后端同步全靠人；拿后端常量再比一道，
        //   后端加状态而前端没跟时能红。
        backendSources: [
            {
                label: 'server.js MODEL_STATUS 常量',
                mode: 'equal',
                // M4：AST 提取键值对，先验 keys===values 契约再用 value 集比对（提取器实现见
                //   keysEqualValuesConstExtract；S4 起 TASK_STATUS 复用同一份，不再各写一遍）。
                astExtract: keysEqualValuesConstExtract('MODEL_STATUS'),
            },
        ],
        // 本页徽章走 DOM API（mdcEl 的 className 字符串拼接），模板串扫描覆盖不到，
        //   故 gate 锁在函数调用形态上。
        classGate: 'mdcStatusClass',
        renderGate: ['mdcStatusClass', 'mdcStatusClass(detail.identity.status)'],
        renderGateCount: { mdcStatusClass: 1, 'mdcStatusClass(detail.identity.status)': 1 },
        // 本页唯一合法的 className 徽章写法（DOM API 扫描放行它，其余同形态一律红）
        domApiAllow: ["className: 'u-status-badge ' + mdcStatusClass(detail.identity.status)"],
        // b-status/b-status-off 是状态徽章的旧二值类，必须零残留；
        //   b-layer*/b-domain **不在此列**——主会话裁定它们是分类标签不是状态，原地保留。
        // M6：**只列状态徽章的旧二值类**。`mdc-badge` 本身是**保留类**（b-layer*/b-domain 仍在用，
        //   主会话裁定只迁状态徽章），列进来会把合法用法判红。
        forbiddenClasses: ['b-status', 'b-status-off'],
        rawConcatForbidden: [/u-status-badge (?:sem-)?\$\{(?!mdcStatusClass\()/],
        requiresComponentsCss: true,
    },

    // ══ 以下两页走 **sem 模式 + 共享 JS 源**（S4 遗留层切换）════════════════════════
    //   与 PF/MC 的差别只有一个：徽章代码不在页内，而在 13 页共享的 assets/js/app.js。
    //   Task_Pool 页面自身**零徽章代码**（S0 实测 grep `badge` = 0 命中），
    //   My_Workspace 只有一处页内抽屉副本，其余同样来自 app.js。
    //   故两 spec 都声明 sharedJs，把 app.js 纳入解析源——否则断言全落在空源上一路假绿。
    {
        file: 'Task_Pool.html',
        mode: 'sem',
        sharedJs: ['assets/js/app.js'],
        expectStatuses: TASK_STATUS_EXPECT,
        mapConst: 'TASK_STATUS_BADGE',
        // 本页 map 的 value 是对象（{cls,label,drawerLabel}），class 片段取 .cls
        mapValueField: 'cls',
        expectLabels: TASK_STATUS_LABELS,
        backendSources: [
            {
                // task_pool 表的 status 列**没有 CHECK**（`status TEXT DEFAULT 'OPEN'`），
                //   真正的枚举真相源是 server.js 的 TASK_STATUS 常量（keys===values，6 值）。
                //   后端加状态而前端没接线 → 这条红。
                label: 'server.js TASK_STATUS 常量',
                mode: 'equal',
                astExtract: keysEqualValuesConstExtract('TASK_STATUS'),
            },
        ],
        // 渲染点：app.js 内 createCard 1 处（1 参）+ 抽屉 1 处（2 参）；class 出口 taskStatusClass 恰 1 次
        //   （只被 taskStatusBadge 调用——"唯一出口"这条不变量就落在这个 1 上）。
        // ⚠️〔B13 维护性风险·先看这段再动手〕这里的次数是**全文件计数**，而 app.js 是 13 页共享文件：
        //   S5 扩到别的徽章族、或任何人在 app.js 里新加一处 taskStatusBadge/taskStatusClass 调用，
        //   这两条恰等断言会立刻红——**红得对，但顺序不能反**。
        //   正确顺序：先改本 spec 的期望次数（把新调用点写进来，顺手想清楚它该不该存在），
        //   再改代码；反过来做的话，一片红灯里很容易顺手把数字改大了事，恰等断言就退化成了计数器。
        //   若将来调用点多到"改一次代码要动一次 spec"变成负担，正确的走法是把徽章渲染从 app.js
        //   拆成独立模块再按模块计数，而不是放宽这条断言。
        classGate: 'taskStatusClass',
        renderGate: ['taskStatusClass', 'taskStatusBadge', 'taskStatusBadge(task.status)', "taskStatusBadge(task.status, 'drawer')"],
        renderGateCount: {
            taskStatusClass: 1,
            taskStatusBadge: 2,
            'taskStatusBadge(task.status)': 1,
            "taskStatusBadge(task.status, 'drawer')": 1,
        },
        forbiddenClasses: TASK_LEGACY_BADGE_CLASSES,
        rawConcatForbidden: [/u-status-badge (?:sem-)?\$\{(?!taskStatusClass\()/],
        requiresComponentsCss: true,
    },
    {
        file: 'My_Workspace.html',
        mode: 'sem',
        sharedJs: ['assets/js/app.js'],
        expectStatuses: TASK_STATUS_EXPECT,
        mapConst: 'TASK_STATUS_BADGE',
        mapValueField: 'cls',
        expectLabels: TASK_STATUS_LABELS,
        backendSources: [
            {
                label: 'server.js TASK_STATUS 常量',
                mode: 'equal',
                astExtract: keysEqualValuesConstExtract('TASK_STATUS'),
            },
        ],
        // 本页比 Task_Pool 多一处**页内抽屉副本**的调用（乙3：只改 app.js 覆盖不到它），
        //   故 taskStatusBadge 总数 3 = app.js 2 + 页内 1，drawer 形态 2 = app.js 1 + 页内 1。
        classGate: 'taskStatusClass',
        renderGate: ['taskStatusClass', 'taskStatusBadge', "taskStatusBadge(task.status, 'drawer')"],
        extraSinkGates: ['mwPriClass'],
        renderGateCount: {
            taskStatusClass: 1,
            taskStatusBadge: 3,
            "taskStatusBadge(task.status, 'drawer')": 2,
        },
        forbiddenClasses: TASK_LEGACY_BADGE_CLASSES,
        rawConcatForbidden: [/u-status-badge (?:sem-)?\$\{(?!taskStatusClass\()/],
        requiresComponentsCss: true,
    },
];

// ============================================================
// helper
// ============================================================
function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// 「class 名标识符边界」正则的**唯一**构造处。
//   〔S4-fix4·B9 真 bug〕此前两处各写了一遍同款正则，其中一处的反斜杠写成了单个：
//   `'(?<![\w-])'` —— JS 字符串会把这个反斜杠吃掉，正则实际拿到的是字符类 `[w-]`
//   （字母 w 或连字符），于是 `xstatus-deprecated` 这种**前缀不同的类名**照样命中，
//   B9 的"仍有真实输出点"可以被一个毫不相干的类名喂绿。
//   同一个正则写两遍就有两次写错的机会 —— 收成一处，两边都调它。
function classTokenRe(cls, flags) {
    return new RegExp('(?<![\\w-])' + escapeRegExp(cls) + '(?![\\w-])', flags);
}

function readPage(pageFile) {
    const p = path.join(PUBLIC_DIR, pageFile);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function readServerJs() {
    const p = path.join(__dirname, '..', 'server.js');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// 取页内所有 <style> 块，剥注释后拼接
function pageStyleText(html) {
    const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    return stripCssComments(blocks.join('\n'));
}

// 从样式文本里取某选择器的规则体（精确选择器头匹配；返回命中的全部规则体，用于判重）
function ruleBodiesFor(styleText, selector) {
    const bodies = [];
    for (const chunk of styleText.split('}')) {
        const braceIdx = chunk.indexOf('{');
        if (braceIdx === -1) continue;
        const group = chunk.slice(0, braceIdx).trim();
        if (!group) continue;
        for (const sel of group.split(',')) {
            if (sel.trim() === selector) bodies.push(chunk.slice(braceIdx + 1));
        }
    }
    return bodies;
}

// 取样式文本里全部规则的选择器头（逗号拆开后逐条）
function allSelectorHeads(styleText) {
    const heads = [];
    for (const chunk of styleText.split('}')) {
        const braceIdx = chunk.indexOf('{');
        if (braceIdx === -1) continue;
        const group = chunk.slice(0, braceIdx).trim();
        if (!group) continue;
        for (const sel of group.split(',')) {
            const t = sel.trim();
            if (t) heads.push(t);
        }
    }
    return heads;
}

// 把规则体拆成声明列表 [{ prop, value }]（只做扁平拆分，够用且不引 CSS parser 依赖）
function declarationsOf(body) {
    return body.split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
            const i = d.indexOf(':');
            return i === -1 ? { prop: d, value: '' } : { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
        });
}

// ============================================================
// AST 提取层（22B·B-H1/H2/H3）
// ============================================================
// 为什么必须 AST：上一版靠"常量名正则 + 括号配对"在**原始文本**上找常量，有三个已知绕过口——
//   ① 注释里写一句 `const STATUS_LABELS = { FAKE: 'x' }` 就能被当成真常量（守卫读到假集合，真集合不查）；
//   ② 字符串字面量里出现同款文本同理；
//   ③ 值是模板串/变量引用/计算属性时，正则会把源码片段当成"状态值"，得出一堆看不懂却"通过"的成员。
// acorn 解析出的 AST 天然只包含真实代码结构，注释与字符串内容不会成为节点，上述三口一次性堵死。
// 纪律：**解析失败、找不到常量、遇到动态成员，一律 fail-closed 判红**，绝不"跳过继续"——
//   守卫的失败模式必须是"喊停"，不能是"沉默放行"。

// 从 HTML 里取内联 <script> 源码（跳过带 src 的外链），拼成一段可解析的 JS。
//   用换行 + 分号隔开，避免相邻块尾尾相连产生语法错误。
//   〔risks④〕只收**经典 JS 脚本**：无 type 属性，或 type 明确是 JS MIME。
//   其余一律跳过——`type="text/template"` / `type="application/json"` 里装的是 HTML 片段或 JSON，
//   丢给 acorn 必然解析失败，而解析失败是 fail-closed 红灯，会把整页断言拖成假警报。
//   `type="module"` 也跳过：本项目页内脚本目前全是无 type 的经典脚本（实测六页均如此），
//   module 有 import/export 与顶层 await，sourceType 得改 'module' 才解析得了——
//   **若将来页内引入 module script，需在此扩展（放开 module + parseJs 的 sourceType 跟着切换）**，
//   否则那段脚本里的状态常量会被静默漏掉（本函数不报错，只是少收一块）。
const CLASSIC_JS_TYPES = new Set(['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

// 〔23B·B-L4〕**已审豁免**的非执行脚本类型：浏览器不把它们当代码跑，里面装的是 HTML 片段 / JSON 数据，
//   丢给 acorn 必然解析失败。它们不进解析源，也**不算盲区**——因为盲区的定义是"本该被执行、
//   守卫却看不见"，而这些根本不执行，里面不可能藏渲染点或状态常量。
//   与 module/未知 type 的区别就在这一句：module **会执行**，未知 type 则是"我不知道它会不会执行"，
//   两者都必须红灯让人来判；本集合里的三种是**显式登记的已审豁免**，不是"顺手放过"。
//   ⚠️ 往本集合加类型 = 扩大守卫盲区，必须先确认该类型在浏览器里确实不执行。
const NON_EXECUTING_SCRIPT_TYPES = new Set([
    'text/template',        // 前端模板片段（HTML 文本）
    'text/x-template',      // 同上（Vue 等常见写法）
    'application/json',     // 数据块（如 <script type="application/json" id="pageData">）
    'application/ld+json',  // 结构化数据
]);

// 计算 HTML 注释区间。
//   〔23B·B-L4〕为什么要单独算而不是简单 `html.replace(/<!--[\s\S]*?-->/g,'')`：
//   JS 模板串里出现 `<!--` 字面量是很正常的事（拼 HTML 注释、写说明文案），全局配对会把注释起点
//   定在**脚本内部**，然后一路吃到后面某个 `-->`，把真代码整段吞掉——本该被解析的脚本静默消失。
//   故先拿到 <script> 块区间，再扫 `<!--`：**落在脚本块内部的一律不当注释起点**。
//   反过来"被整块注释掉的 <script>"仍能识别：它的 `<!--` 在脚本块之前，不在任何脚本内部。
function htmlCommentRanges(html, scriptRanges) {
    const insideScript = (i) => scriptRanges.some(([s, e]) => i > s && i < e);
    const ranges = [];
    let idx = 0;
    while (idx < html.length) {
        const start = html.indexOf('<!--', idx);
        if (start === -1) break;
        if (insideScript(start)) { idx = start + 4; continue; }
        let end = html.indexOf('-->', start + 4);
        if (end === -1) { ranges.push([start, html.length]); break; }
        end += 3;
        ranges.push([start, end]);
        idx = end;
    }
    return ranges;
}

// 归类页内 <script>：返回 { source, skipped, exempted, commentedOut }。
//   skipped      = **判红**的排除项（module / 未知 type）——它们会执行，而守卫读不到。
//   exempted     = 已审豁免的非执行类型（NON_EXECUTING_SCRIPT_TYPES），登记但不判红。
//   commentedOut = 整块躺在 HTML 注释里的 <script>，浏览器根本不加载，不该进解析源。
//   〔L8〕排除本身不"静默"——调用方拿 skipped 出一条显式断言：受管页里出现 module 或未知 type，
//   意味着那段脚本里的状态常量/渲染点**完全不在守卫视野内**，而守卫却一路全绿。
//   这正是"没看见"被当成"没问题"的典型，必须红灯让人来决定（扩解析 or 确认无关）。
function classifyInlineScripts(html) {
    const raw = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const scriptRanges = raw.map((m) => [m.index, m.index + m[0].length]);
    const comments = htmlCommentRanges(html, scriptRanges);
    const isCommentedOut = (i) => comments.some(([s, e]) => i >= s && i < e);

    const blocks = [];
    const skipped = [];
    const exempted = [];
    const commentedOut = [];
    for (const m of raw) {
        if (isCommentedOut(m.index)) { commentedOut.push(m.index); continue; }
        const attrs = m[1] || '';
        // src 检测走**属性名边界**：`\ssrc=` 才算，`data-src=` / `xsrc=` 不误判为外链
        //   （误判成外链 = 那段真页内脚本被当成外链跳过，同样是静默失明）。
        if (/(^|\s)src\s*=/i.test(attrs)) continue;                   // 真外链，不是页内源码
        const typeMatch = attrs.match(/(^|\s)type\s*=\s*(['"])([^'"]*)\2/i);
        if (typeMatch) {
            const t = typeMatch[3].trim().toLowerCase();
            if (NON_EXECUTING_SCRIPT_TYPES.has(t)) { exempted.push(t); continue; }
            if (!CLASSIC_JS_TYPES.has(t)) { skipped.push(t); continue; }
        }
        blocks.push(m[2]);
    }
    return { source: blocks.join('\n;\n'), skipped, exempted, commentedOut };
}

function inlineScriptSource(html) {
    return classifyInlineScripts(html).source;
}

// L8 断言：受管页不得含 module/未知 type 的 <script>（含则守卫对那段代码全盲）
function assertNoUnparsedScripts(check, spec, html) {
    const { skipped, exempted, commentedOut } = classifyInlineScripts(html);
    check(skipped.length === 0, `${spec.file}：页内无 module/未知 type 的 <script>（守卫解析盲区）`,
        skipped.length
            ? `${skipped.length} 段被排除：${[...new Set(skipped)].join(' | ')} —— 这些脚本里的状态常量与渲染点完全不在守卫视野内，`
              + `而守卫会照常全绿。若确需引入 module script，须把 parseJs 的 sourceType 切到 'module' 并把该段纳入解析；`
              + `若确认与徽章无关，也要显式登记进 NON_EXECUTING_SCRIPT_TYPES 或本断言的豁免面，而不是让它悄悄躺在盲区里`
            : '');
    // 已审豁免与注释掉的块**打印登记**（不判红也不沉默）：让"守卫少读了哪几块"是台面上的信息。
    if (exempted.length || commentedOut.length) {
        console.log(`  [INFO] ${spec.file}：已审豁免非执行 <script> ${exempted.length} 段`
            + `${exempted.length ? '（' + [...new Set(exempted)].join(' | ') + '）' : ''}`
            + `；HTML 注释内 <script> ${commentedOut.length} 段（浏览器不加载，不进解析源）`);
    }
}

// 剥掉 JS 注释，保留其余字符的**位置与长度**（注释整体替换为等长空格）。
//   〔C-L1〕为什么要剥：renderGateCount 是"出现次数恰等"的强断言，一旦有人在注释里引用
//   gate 调用形态（很自然的事，比如写"这里原本走 itStatusClass(issue.status)"），计数就多一，
//   断言红成假警报，而代码其实没问题。
//   为什么用 acorn 的 onComment 而不是手写扫描：手写要正确区分 `//` 注释、字符串里的 `//`（URL）、
//   正则字面量里的 `/`、模板串里的一切——全是启发式，边界случ多。acorn 解析时本就精确知道
//   每条注释的 start/end，直接拿来用，零启发式、零误伤。
//   解析失败时原样返回：调用方已有"页内 <script> 可被 acorn 解析"的红灯断言在前，不会静默放过。
function stripJsComments(source) {
    let acorn;
    try { acorn = require('acorn'); } catch (e) { return source; }
    const comments = [];
    try {
        acorn.parse(source, {
            ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true,
            onComment: (block, text, start, end) => comments.push([start, end]),
        });
    } catch (e) {
        return source;
    }
    if (!comments.length) return source;
    // ⚠️ 用切片拼接而非 [...source] 逐字符改写：展开运算符按**码点**切分，acorn 的 start/end 是
    //    **UTF-16 码元**偏移——页内注释里有 emoji（⚠️ 等，代理对占 2 码元），两者不一致会错位。
    //    String.prototype.slice 同样按码元，与 acorn 天然对齐。
    comments.sort((a, b) => a[0] - b[0]);
    let out = '';
    let last = 0;
    for (const [start, end] of comments) {
        if (start < last) continue;                       // 防重叠（正常不会出现）
        out += source.slice(last, start);
        out += source.slice(start, end).replace(/[^\n\r]/g, ' ');   // 等长空白，保留换行
        last = end;
    }
    return out + source.slice(last);
}

// 解析成 AST。失败返回 { ok:false, error }，由调用方判红。
function parseJs(source) {
    try {
        const acorn = require('acorn');
        // ranges:true 是 eslint-scope 的硬要求（它按 node.range 判定绑定的有效区间）——
        //   缺了会在 __isValidResolution 里抛 "Cannot read properties of undefined"。
        const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true, ranges: true });
        // 把源码挂在根节点上：countGateCalls 要按 node.start/end 取实参源码片段做指纹比对，
        //   挂在这里比传模块级变量干净（不同页面并行断言时不会串）。
        Object.defineProperty(ast, '__source', { value: source, enumerable: false });
        return { ok: true, ast };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 手写深度遍历（acorn-walk 不在依赖树，实测 `require('acorn-walk')` 失败；acorn 本体在，8.15.0）。
function walkAst(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => walkAst(c, visit));
        else if (v && typeof v.type === 'string') walkAst(v, visit);
    }
}

// ── M3：frozen 的 **AST 级**验证 ──────────
//   原先靠正则 `const X = Object.freeze(` 证明"冻结了"，有两个洞：
//     ① 注释/字符串里出现同款文本就算数（与 B-H1 同类问题，只是当时漏了这一处）；
//     ② `Object.freeze` 后面跟什么完全不管——`Object.freeze(someVar)` 也过，
//        而那根本不是"字面量白名单"，运行时可以是任意对象。
//   改为断言 init 节点**精确形如** CallExpression(Object.freeze, [ObjectExpression])。
//   返回 { ok, why, objectNode }。
function checkFrozenObjectLiteral(ast, constName) {
    if (!ast) return { ok: false, why: '页面 JS 解析失败' };
    const decls = [];
    walkAst(ast, (n) => {
        if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.id.name === constName) decls.push(n);
    });
    if (decls.length === 0) return { ok: false, why: '未找到该常量声明' };
    if (decls.length > 1) return { ok: false, why: `同名常量出现 ${decls.length} 处——运行时以最后一次为准，守卫读第一处即分叉` };
    const init = decls[0].init;
    if (!init || init.type !== 'CallExpression') return { ok: false, why: `init 是 ${init ? init.type : '空'}，不是 Object.freeze(...) 调用` };
    const callee = init.callee;
    const isFreeze = callee && callee.type === 'MemberExpression' && !callee.computed
        && callee.object && callee.object.type === 'Identifier' && callee.object.name === 'Object'
        && callee.property && callee.property.name === 'freeze';
    if (!isFreeze) return { ok: false, why: '调用的不是 Object.freeze' };
    if (init.arguments.length !== 1 || init.arguments[0].type !== 'ObjectExpression') {
        return { ok: false, why: `Object.freeze 的参数是 ${init.arguments[0] ? init.arguments[0].type : '空'}，不是对象字面量——冻结一个变量不等于白名单是静态的` };
    }
    return { ok: true, why: '', objectNode: init.arguments[0] };
}

// ── AST 结构等价比较（23B·B-M2）──────────
//   位置信息（start/end/loc/range）与 `raw`（字面量的原始写法，含引号种类）不参与比较：
//   `f('a')` 与 `f("a")` 是同一个调用，不该因为引号不同被判成两个不同的调用点。
const AST_POSITION_KEYS = new Set(['start', 'end', 'loc', 'range', 'raw']);
function astEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => astEqual(x, b[i]));
    const ka = Object.keys(a).filter((k) => !AST_POSITION_KEYS.has(k)).sort();
    const kb = Object.keys(b).filter((k) => !AST_POSITION_KEYS.has(k)).sort();
    if (ka.length !== kb.length) return false;
    if (ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => astEqual(a[k], b[k]));
}

// 调用节点的 callee 取"可读名"：`f` / `Obj.f`；其余形态（计算成员、链式表达式）返回 null。
function calleeNameOf(callee) {
    if (!callee) return null;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed
        && callee.object && callee.object.type === 'Identifier'
        && callee.property && callee.property.type === 'Identifier') {
        return `${callee.object.name}.${callee.property.name}`;
    }
    return null;
}

// 把 spec 里登记的 gate 字符串解析成 { name, args }。args=null 表示"只按函数名统计总次数"。
//   解析失败返回 null → 调用方按 -1 处理 = 断言红（fail-closed，不静默当成 0 次或跳过）。
function parseGateSpec(gate) {
    if (/^[\w$.]+$/.test(gate)) return { name: gate, args: null };
    let acorn;
    try { acorn = require('acorn'); } catch (e) { return null; }
    try {
        const node = acorn.parseExpressionAt(gate, 0, { ecmaVersion: 2022 });
        if (!node || node.type !== 'CallExpression') return null;
        const name = calleeNameOf(node.callee);
        if (!name) return null;
        return { name, args: node.arguments };
    } catch (e) {
        return null;
    }
}

// ── M5：按 AST 数 gate 的**调用次数** ──────────
//   gate 在 spec 里写成调用形态字符串（如 `itStatusClass(issue.status)`、`pfStatusClass('disabled')`），
//   这里取函数名 + **实参 AST 结构**去匹配 CallExpression 节点。
//   〔23B·B-M2〕实参比对从"源码片段去掉全部空白后比字符串"改成**逐个参数节点结构比较**：
//     去空白是个语义破坏性的归一化——`f('a b')` 与 `f('ab')` 会被压成同一个指纹，
//     两个语义完全不同的调用点被视为同一个，"次数恰等"因此可能被一次等量替换蒙混过去。
//     结构比较不碰字符串内容，`'a b'` 与 `'ab'` 是两个不同的 Literal，天然分得开。
//   为什么不数文本：剥注释只挡住注释，字符串字面量里的同形文本、以及"gate 名恰是更长标识符的
//   子串"仍会喂错数。调用节点是"这行代码真的调用了它"的唯一可靠证据。
//   〔威胁模型登记接受·M5 部分〕本断言证明的是"gate 被调用了几次"，**不做**"class 属性的值一定
//   源自该 gate 返回值"的完整数据流分析。后者要做别名/常量传播与跨函数追踪，成本远超收益；
//   当前由三条互补防线兜底：rawConcatForbidden（模板串负向）+ assertNoDomApiBypass（DOM API 负向）
//   + 本条（gate 调用次数恰等）。三者同时被绕过才可能漏，属可接受剩余风险。
//   gate 支持两种写法：
//     · 纯函数名（如 `statusClass`、`UnifyHelpers.statusBadgeByMap`）——统计该函数在页内被调用的**总次数**。
//       这是首选：真正的不变量是"每个徽章 class 片段都过了这道 gate"，而不是"某个特定调用点还在"。
//     · 完整调用形态（如 `itStatusClass(issue.status)`）——额外按实参源码指纹过滤，用于区分同名不同参的调用点。
function countGateCalls(ast, gate) {
    if (!ast) return -1;
    const spec = parseGateSpec(gate);
    if (!spec) return -1;          // gate 字符串本身解析不了 = 配置写错，红灯而非静默
    let count = 0;
    walkAst(ast, (n) => {
        if (n.type !== 'CallExpression') return;
        if (calleeNameOf(n.callee) !== spec.name) return;
        if (spec.args === null) { count++; return; }
        // 实参逐节点结构比对：能精确区分 itStatusClass(issue.status) 与 itStatusClass(h.to_status)
        //   这类同名不同参的调用点，且不会把 f('a b') 与 f('ab') 混为一谈。
        if (n.arguments.length !== spec.args.length) return;
        if (n.arguments.every((a, i) => astEqual(a, spec.args[i]))) count++;
    });
    return count;
}

// 多源汇总：把若干个源（页内 <script> + 共享 JS）的 gate 调用次数相加。
//   任一源解析失败（count 为 -1）整体返回 -1 → fail-closed。
function countGateCallsAcross(sources, gate) {
    let total = 0;
    for (const s of sources) {
        const c = countGateCalls(s.ast, gate);
        if (c < 0) return -1;
        total += c;
    }
    return total;
}

// 对象字面量的重复键检查（AST 级）。JS 取末次、人读到首次 = 分叉通道。
function duplicateKeysOf(objectNode) {
    const keys = [];
    for (const p of objectNode.properties || []) {
        if (p.type !== 'Property' || p.computed) continue;
        keys.push(p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
    }
    return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
}

// 剥掉 Object.freeze( … ) 包裹，拿到里面的字面量节点
function unwrapFreeze(node) {
    if (node && node.type === 'CallExpression'
        && node.callee && node.callee.type === 'MemberExpression'
        && node.callee.object && node.callee.object.name === 'Object'
        && node.callee.property && node.callee.property.name === 'freeze'
        && node.arguments.length === 1) {
        return node.arguments[0];
    }
    return node;
}

// 找出所有 `const/let/var <constName> = <init>` 的 init 节点（全部出现，含函数体内的）。
function findConstInitNodes(ast, constName) {
    const found = [];
    walkAst(ast, (n) => {
        if (n.type !== 'VariableDeclarator') return;
        if (!n.id || n.id.type !== 'Identifier' || n.id.name !== constName) return;
        found.push(unwrapFreeze(n.init));
    });
    return found;
}

// 从字面量节点取成员。返回 { members, dynamic }——dynamic 非空即判红（动态成员守卫看不懂，
//   而"看不懂"绝不能当成"没问题"）。
//   kind: 'objectKeys' | 'objectValues' | 'objectEntries' | 'arrayItems'
function membersOfNode(node, kind) {
    const members = [];
    const dynamic = [];
    if (!node) return { members, dynamic: ['(init 为空)'] };

    if (kind === 'arrayItems') {
        if (node.type !== 'ArrayExpression') return { members, dynamic: [`期望数组字面量，实际 ${node.type}`] };
        for (const el of node.elements) {
            if (el && el.type === 'Literal' && typeof el.value === 'string') members.push(el.value);
            else dynamic.push(el ? el.type : 'null');
        }
        return { members, dynamic };
    }

    if (node.type !== 'ObjectExpression') return { members, dynamic: [`期望对象字面量，实际 ${node.type}`] };
    for (const p of node.properties) {
        if (p.type !== 'Property') { dynamic.push(p.type); continue; }   // SpreadElement 等
        if (p.computed) { dynamic.push('计算属性 [expr]'); continue; }
        const k = p.key.type === 'Identifier' ? p.key.name
            : (p.key.type === 'Literal' ? String(p.key.value) : null);
        if (k === null) { dynamic.push(`键类型 ${p.key.type}`); continue; }
        if (kind === 'objectKeys') { members.push(k); continue; }
        // 值必须是静态字符串字面量
        if (p.value.type !== 'Literal' || typeof p.value.value !== 'string') {
            dynamic.push(`键 ${k} 的值是 ${p.value.type}（非静态字符串）`);
            continue;
        }
        members.push(kind === 'objectEntries' ? [k, p.value.value] : p.value.value);
    }
    return { members, dynamic };
}

// 〔S4〕值为**对象字面量**的白名单 map（如 `{ OPEN: { cls:'sem-wait', label:'待认领' } }`），
//   取出 [key, value[field]] 二元组。字段值必须是静态字符串字面量，否则进 dynamic 判红。
//   〔S5a-fix4 深冻结〕requireInnerFreeze=true 时，内层值必须**精确**是 Object.freeze(对象字面量)。
//     外层 freeze 只挡增删键；`MAP.passed.cls = 'x'` 这种改一格它拦不住，而 cls 恰是进 class 的那一格。
function entriesOfObjectValuedMap(objectNode, field, requireInnerFreeze) {
    const members = [];
    const dynamic = [];
    if (!objectNode || objectNode.type !== 'ObjectExpression') {
        return { members, dynamic: [`期望对象字面量，实际 ${objectNode ? objectNode.type : '空'}`] };
    }
    for (const p of objectNode.properties) {
        if (p.type !== 'Property') { dynamic.push(p.type); continue; }
        if (p.computed) { dynamic.push('计算属性 [expr]'); continue; }
        const k = keyNameOf(p.key);
        if (k === null) { dynamic.push(`键类型 ${p.key.type}`); continue; }
        const v = unwrapFreeze(p.value);
        if (requireInnerFreeze && v === p.value) {
            dynamic.push(`键 ${k} 的内层值未 Object.freeze（外层 freeze 只挡增删键，挡不住改一格）`);
            continue;
        }
        if (!v || v.type !== 'ObjectExpression') { dynamic.push(`键 ${k} 的值不是对象字面量（实际 ${p.value.type}）`); continue; }
        // 〔B6〕内层对象同样要"看得全"：
        //   · SpreadElement（`{ ...base, cls: 'x' }`）会从别处带进本函数看不见的字段——展开源可能是变量；
        //   · 计算属性（`{ [k]: … }`）的键静态判不了；
        //   · 重复键取末次，与人读到的首次不一致（与外层同款分叉通道，内层一样要查）；
        //   · 目标字段必须**恰出现一次**——`.find()` 只取首个，写两遍时守卫读第一个、运行时用第二个。
        const inner = v.properties;
        const spread = inner.filter((q) => q.type !== 'Property');
        if (spread.length) { dynamic.push(`键 ${k} 的值对象里含 ${spread.map((q) => q.type).join('/')}（展开会带进静态看不见的字段）`); continue; }
        const computed = inner.filter((q) => q.computed);
        if (computed.length) { dynamic.push(`键 ${k} 的值对象里含 ${computed.length} 个计算属性`); continue; }
        const innerKeys = inner.map((q) => keyNameOf(q.key));
        const dupInner = [...new Set(innerKeys.filter((x, i) => innerKeys.indexOf(x) !== i))];
        if (dupInner.length) { dynamic.push(`键 ${k} 的值对象有重复字段：${dupInner.join(' | ')}`); continue; }
        const fps = inner.filter((q) => keyNameOf(q.key) === field);
        if (fps.length !== 1) { dynamic.push(`键 ${k} 的 .${field} 出现 ${fps.length} 次（应恰 1 次）`); continue; }
        const fp = fps[0];
        if (fp.value.type !== 'Literal' || typeof fp.value.value !== 'string') {
            dynamic.push(`键 ${k} 的 .${field} 不是静态字符串字面量（实际 ${fp.value.type}）`);
            continue;
        }
        members.push([k, fp.value.value]);
    }
    return { members, dynamic };
}

// 〔S4-fix LOW-1〕值为对象的白名单 map：**每个 value 也必须 freeze**。
//   只 freeze 外层挡得住"加/删状态"，挡不住 `MAP.DONE.cls = 'sem-done'` 这种改一格的写法，
//   而那恰恰是白名单最该防的形态（改完之后所有键集/逐对断言依旧全绿，因为它们读的是源码字面量）。
//   判据：每个 property 的 value 必须精确形如 Object.freeze(对象字面量)；判不了（计算属性/展开/
//   非对象字面量）一律红，fail-closed。
function assertObjectValuedMapFrozen(check, spec, objectNode) {
    if (!spec.mapValueField) return;
    if (!objectNode || objectNode.type !== 'ObjectExpression') {
        check(false, `${spec.file}：${spec.mapConst} 的每个 value 均为 Object.freeze(对象字面量)`, 'map 节点不可用，无法判定');
        return;
    }
    const bad = [];
    for (const p of objectNode.properties) {
        if (p.type !== 'Property' || p.computed) { bad.push(`${p.type}${p.computed ? '（计算属性）' : ''}`); continue; }
        const k = keyNameOf(p.key) || '(动态键)';
        const v = p.value;
        const isFreezeCall = v && v.type === 'CallExpression'
            && v.callee && v.callee.type === 'MemberExpression' && !v.callee.computed
            && v.callee.object && v.callee.object.name === 'Object'
            && v.callee.property && v.callee.property.name === 'freeze'
            && v.arguments.length === 1 && v.arguments[0].type === 'ObjectExpression';
        if (!isFreezeCall) bad.push(`${k} 的值是 ${v ? v.type : '空'}，不是 Object.freeze(对象字面量)`);
    }
    check(bad.length === 0, `${spec.file}：${spec.mapConst} 的每个 value 均为 Object.freeze(对象字面量)`,
        bad.length ? `${bad.length} 处未冻结：${bad.join('；')} —— 外层 freeze 只挡加删键，挡不住 \`${spec.mapConst}.X.${spec.mapValueField} = …\` 改一格` : '');
}

// 〔S4·M-1「固定 label」〕白名单 map 里的文案字段逐条钉死。
//   为什么要单独钉：class 走 token、观感由色板保证，但**用户读到的字**只由这张表决定；
//   没有这条，把 label 改成 `task.status` 之类的运行时值，前面所有断言照样全绿。
function assertMapLabelFields(check, spec, objectNode) {
    if (!spec.expectLabels) return;
    if (!objectNode) { check(false, `${spec.file}：${spec.mapConst} 文案字段可提取`, 'map 节点不可用'); return; }
    const diffs = [];
    const fields = [...new Set(Object.values(spec.expectLabels).flatMap((o) => Object.keys(o)))];
    for (const field of fields) {
        const { members, dynamic } = entriesOfObjectValuedMap(objectNode, field);
        if (dynamic.length) { diffs.push(`字段 .${field} 提取失败：${[...new Set(dynamic)].join(' | ')}`); continue; }
        const actual = new Map(members);
        for (const [k, want] of Object.entries(spec.expectLabels)) {
            if (!(field in want)) continue;
            if (!actual.has(k)) diffs.push(`缺 ${k}.${field}`);
            else if (actual.get(k) !== want[field]) diffs.push(`${k}.${field}=\`${actual.get(k)}\`（期望 \`${want[field]}\`）`);
        }
    }
    check(diffs.length === 0, `${spec.file}：${spec.mapConst} 的文案字段与登记表逐条一致（${fields.join(' / ')}）`,
        diffs.length ? `${diffs.length} 处：${diffs.join('；')} —— 文案是用户唯一读得到的信息，改动必须过这张表` : '');
}

// ============================================================
// 断言
// ============================================================

// ── 源列表载入（S4 新增 sharedJs 维度）──────────
//   为什么要这个维度：Task_Pool **页面自身零徽章代码**（S0 矩阵实测 grep `badge` = 0 命中），
//   六个卡片渲染点与抽屉渲染点全在共享的 assets/js/app.js 里。若 spec 仍只扫页面 HTML，
//   这一页的所有断言都会落在一份"什么都没有"的源上——map 找不到、gate 数为 0、旧类当然也"零残留"，
//   一页全绿而实际零覆盖（与 S2 时 Data_Collab 选择器写错被记 SKIP 是同一类失效）。
//   实现方式：spec 增 `sharedJs: ['assets/js/app.js']`（相对 public/），本函数把页内 <script>
//   与共享 JS 一起返回成源列表，下游 AST 类断言逐源或跨源工作。
//   ⚠️ app.js 被 13 个页面共享，它同时进 Task_Pool 与 My_Workspace 两份 spec = 同一份代码被查两遍。
//      这是有意的：两页对它的期望不同（MW 另有页内渲染点），各查各的更贴事实，且改坏时两页一起红。
function loadSpecSources(check, spec, html) {
    const sources = [];
    const pageSrc = inlineScriptSource(html);
    const pageParsed = parseJs(pageSrc);
    check(pageParsed.ok, `${spec.file}：页内 <script> 可被 acorn 解析（AST 提取前置）`,
        pageParsed.ok ? '' : `解析失败：${pageParsed.error}`);
    sources.push({ label: `${spec.file} 页内 <script>`, source: pageSrc, ast: pageParsed.ok ? pageParsed.ast : null });

    for (const rel of spec.sharedJs || []) {
        const p = path.join(PUBLIC_DIR, rel);
        const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        check(txt !== null, `${spec.file}：共享 JS ${rel} 可读`, txt === null ? `未找到 ${p}` : '');
        const parsed = txt === null ? { ok: false, error: '文件不存在' } : parseJs(txt);
        check(parsed.ok, `${spec.file}：共享 JS ${rel} 可被 acorn 解析（AST 提取前置）`,
            parsed.ok ? '' : `解析失败：${parsed.error} —— 解析不了就读不出真实常量与渲染点，本页所有 AST 断言失去意义`);
        sources.push({ label: rel, source: txt || '', ast: parsed.ok ? parsed.ast : null });
    }
    return sources;
}

// ── 〔B8〕页面真实加载的外链脚本清单 ↔ spec.sharedJs 对账 ──────────
//   缺口：sharedJs 是**手写配置**。把 Task_Pool.html 里那行 `<script src="assets/js/app.js">` 删掉，
//   页面上徽章全没了，而守卫照旧去磁盘上读 app.js、照旧全绿——它验的是"文件里写了什么"，
//   从没验过"这页真的加载了它"。这条把两边对上：
//     · spec.sharedJs 的每一项都必须出现在页面真实 <script src> 清单里，且**恰一次**；
//     · 页面里**未登记**的本地可执行脚本一律判红——要么补进 sharedJs 逐行解析，
//       要么写进豁免表并说明为什么它不产出徽章。远程脚本（CDN）单独归类，登记后不判红。
//   注释掉的 <script> 不算（classifyInlineScripts 同款两遍法已证明这类误判真实存在）。
const REMOTE_SRC_RE = /^(https?:)?\/\//i;

// 〔B8·S4-fix3〕豁免表改**「页面 × 脚本」精确键**。
//   原来的全局豁免表把 `assets/js/app.js` 一刀切放过了——可它恰恰是任务徽章的渲染点所在，
//   "在任何页面都不产出徽章"这句话本身就是错的。改成按页登记后，每一页都要各自回答
//   "这个脚本在**这一页**为什么不产出徽章"，答不上来的就得进 sharedJs 被逐行解析。
//   Task_Pool / My_Workspace 没有 app.js 的豁免条目 —— 它们必须走 sharedJs（B8 断言①会盯着）。
const SCRIPT_REGISTRY = Object.freeze({
    'Data_Correction.html': {
        'assets/js/app.js': '本页不调用 createCard / openTaskDetailDrawer（任务徽章的两个渲染点），只用其中的通用工具函数；本页徽章走 UnifyHelpers + 页内 statusClass',
        'assets/js/unify-helpers.js': '共享 helper，其徽章输出形态由 verify-unify-static.js 断言③⑧ 单独覆盖',
        'assets/js/u-paste.js': '贴图粘贴扩展，只处理 paste 事件与附件上传，不写任何 class',
        'assets/vendor/xlsx.mini.min.js': '第三方 SheetJS vendor 库（S5，暂缓与列表导出方案 v1.1 §3.1.2），只提供 Excel 生成 API，不操作 DOM/不写任何 class',
        'assets/js/u-export.js': '列表导出（Excel）+ 创建日期范围筛选共享层（S5，方案 §3.1），只挂导出按钮点击行为与日期胶囊浮层，不写任何徽章相关 class（.u-btn-export/.u-daterange* 均非徽章体系）',
    },
    'Statistics.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章走 UnifyHelpers.statusBadgeByMap',
        'assets/js/unify-helpers.js': '共享 helper，由 verify-unify-static.js 断言③⑧ 覆盖',
    },
    'Issue_Lite.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内模板 + ISSUE_LITE_STATES 守门产出',
        'assets/js/unify-helpers.js': '共享 helper，由 verify-unify-static.js 断言③⑧ 覆盖',
        'assets/js/u-paste.js': '贴图粘贴扩展，不写 class',
    },
    'Issue_Tracker.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内 itStatusClass 产出',
        'assets/js/unify-helpers.js': '共享 helper，由 verify-unify-static.js 断言③⑧ 覆盖',
        'assets/js/u-paste.js': '贴图粘贴扩展，不写 class',
    },
    'Sys_Iteration.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内 siStatusClass 产出',
        'assets/js/unify-helpers.js': '共享 helper，由 verify-unify-static.js 断言③⑧ 覆盖',
        'assets/js/u-paste.js': '贴图粘贴扩展，不写 class',
        'assets/vendor/xlsx.mini.min.js': '第三方 SheetJS vendor 库（S6，暂缓与列表导出方案 v1.1 §3.1.2），只提供 Excel 生成 API，不操作 DOM/不写任何 class',
        'assets/js/u-export.js': '列表导出（Excel）+ 创建日期范围筛选共享层（S6，方案 §3.1），只挂导出按钮点击行为与日期胶囊浮层，不写任何徽章相关 class（.u-btn-export/.u-daterange* 均非徽章体系）',
    },
    'Data_Collab.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内 collabStatusClass 产出',
        'assets/js/unify-helpers.js': '共享 helper，由 verify-unify-static.js 断言③⑧ 覆盖',
        'assets/js/u-paste.js': '贴图粘贴扩展，不写 class',
        'assets/vendor/xlsx.mini.min.js': '第三方 SheetJS vendor 库（S6，暂缓与列表导出方案 v1.1 §3.1.2），只提供 Excel 生成 API，不操作 DOM/不写任何 class',
        'assets/js/u-export.js': '列表导出（Excel）+ 创建日期范围筛选共享层（S6，方案 §3.1），只挂导出按钮点击行为与日期胶囊浮层，不写任何徽章相关 class（.u-btn-export/.u-daterange* 均非徽章体系）',
    },
    'Periodic_Fetch.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内 pfStatusClass 产出',
    },
    'Model_Center.html': {
        'assets/js/app.js': '同上，本页无任务卡/任务抽屉；徽章由页内 mdcStatusClass 经 mdcEl 产出',
        'assets/js/model-detail-normalize.js': '模型详情数据归一化，纯数据变换，不碰 DOM',
    },
    'Task_Pool.html': {},        // app.js 必须走 sharedJs，此处有意留空
    'My_Workspace.html': {},     // 同上
});

// 远程脚本**精确 URL 允许表**（含理由）。未登记的远程源判红——
//   远程脚本的内容不在仓库里，谁也没法证明它不写徽章 class；能给的保证只有"我知道它是什么、为什么在这"。
const REMOTE_SCRIPT_ALLOW = Object.freeze({
    'Statistics.html': {
        'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js': '图表库，渲染在 <canvas> 内，不产出 DOM class',
    },
    'Task_Pool.html': {
        'https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js': 'Markdown 解析库，只做文本→HTML 转换，输出不含徽章类名',
    },
});

// 解析页面真实 <script src>：属性名不区分大小写、支持**无引号**属性值、值先解码 HTML 实体。
//   〔B8·S4-fix3〕原实现只认带引号的 src，`<script src=assets/js/x.js>` 整条漏过去——
//   这与 B-M3 在正文 class 属性上修过的是同一个洞，同款解析纪律要一并用上。
function pageScriptSrcList(html) {
    const raw = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const scriptRanges = raw.map((m) => [m.index, m.index + m[0].length]);
    const comments = htmlCommentRanges(html, scriptRanges);
    const isCommentedOut = (i) => comments.some(([s, e]) => i >= s && i < e);
    const list = [];
    for (const m of raw) {
        if (isCommentedOut(m.index)) continue;
        const attrRegion = m[1] || '';
        const attrRe = new RegExp(HTML_ATTR_RE.source, 'g');
        let a;
        let rawSrc = null;
        while ((a = attrRe.exec(attrRegion)) !== null) {
            if (a[1].toLowerCase() !== 'src') continue;
            rawSrc = decodeHtmlEntities(a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4])).trim();
            break;
        }
        if (!rawSrc) continue;
        const remote = REMOTE_SRC_RE.test(rawSrc);
        const normalized = remote ? rawSrc : rawSrc.split('?')[0].split('#')[0].replace(/^\.\//, '').replace(/^\//, '');
        list.push({ raw: rawSrc, normalized, remote });
    }
    return list;
}

function assertSharedJsMatchesPage(check, spec, html) {
    const scripts = pageScriptSrcList(html);
    const localScripts = scripts.filter((x) => !x.remote);
    const declared = spec.sharedJs || [];
    const pageExempt = SCRIPT_REGISTRY[spec.file] || {};
    const remoteAllow = REMOTE_SCRIPT_ALLOW[spec.file] || {};

    // ① 登记的共享 JS 必须真的被页面加载，且恰一次
    const missing = [];
    const dup = [];
    for (const rel of declared) {
        const hits = localScripts.filter((x) => x.normalized === rel);
        if (hits.length === 0) missing.push(rel);
        else if (hits.length > 1) dup.push(`${rel}（${hits.length} 次）`);
    }
    check(missing.length === 0 && dup.length === 0,
        `${spec.file}：spec.sharedJs 的每一项都被页面真实加载且恰一次（${declared.length} 项）`,
        [
            missing.length ? `页面没有加载：${missing.join(' | ')} —— 守卫仍在磁盘上解析它并全绿，而页面上徽章早就没了` : '',
            dup.length ? `重复加载：${dup.join(' | ')}` : '',
        ].filter(Boolean).join('；'));

    // ② 本地脚本：要么在 sharedJs 逐行解析，要么在**本页**的登记表里写明为什么不产出徽章
    const unregistered = localScripts.filter((x) => !declared.includes(x.normalized)
        && !Object.prototype.hasOwnProperty.call(pageExempt, x.normalized));
    check(unregistered.length === 0, `${spec.file}：页面加载的本地脚本均已按页登记（sharedJs 或本页豁免表）`,
        unregistered.length
            ? `${unregistered.length} 个未登记：${unregistered.map((x) => x.normalized).join(' | ')} —— `
              + '它们可能在写徽章 class 而完全不在守卫视野内。要么加进 spec.sharedJs 逐行解析，要么在 SCRIPT_REGISTRY 的**本页条目**下写明为什么它不产出徽章'
            : '');

    // ③ 远程脚本必须精确登记
    const remotes = scripts.filter((x) => x.remote);
    const badRemotes = remotes.filter((x) => !Object.prototype.hasOwnProperty.call(remoteAllow, x.raw));
    check(badRemotes.length === 0, `${spec.file}：远程脚本均在精确 URL 允许表内（${remotes.length} 个）`,
        badRemotes.length
            ? `${badRemotes.length} 个未登记远程源：${badRemotes.map((x) => x.raw).join(' | ')} —— `
              + '远程脚本内容不在仓库里，无法证明它不写徽章 class；确需引入请在 REMOTE_SCRIPT_ALLOW 下按精确 URL 登记并写明用途'
            : '');
}

// 跨源定位一个常量：必须**恰好一个源**声明它（多处声明 = 运行时按加载顺序覆盖，守卫读哪一个都是赌）
function findConstHost(sources, constName) {
    const hits = sources.filter((s) => s.ast && findConstInitNodes(s.ast, constName).length > 0);
    if (hits.length === 0) return { ok: false, why: `未在任何源里找到 ${constName} 的声明（被改名/删除，或写进了注释/字符串）` };
    if (hits.length > 1) {
        return { ok: false, why: `${constName} 在 ${hits.length} 个源里都有声明（${hits.map((h) => h.label).join(' / ')}）——运行时后加载者胜出，守卫读第一个即分叉` };
    }
    return { ok: true, host: hits[0] };
}

// ── sem 模式页断言（S3：Periodic_Fetch / Model_Center；S4：Task_Pool / My_Workspace）──────────
// 这两页没有页内别名规则，样式全在共享层，故断言重心从"别名连通"移到
//   "map 键值正确 + 渲染点走 gate + 旧类零残留 + 页内不私自复刻 sem 样式"。
function assertSemModePage(check, spec) {
    const html = readPage(spec.file);
    check(html !== null, `${spec.file}：文件存在于 public/`, html === null ? '未找到' : '');
    if (html === null) return;

    const sources = loadSpecSources(check, spec, html);
    assertNoUnparsedScripts(check, spec, html);   // L8
    assertSharedJsMatchesPage(check, spec, html);   // B8：sharedJs 配置 ↔ 页面真实 <script src> 对账

    // ① 必须引 components.css（sem-* 的样式来源；漏引=徽章全裸奔成 base fallback）
    //   LOW-11：解析真实 <link> 标签取 href，不做全文正则——否则**注释掉的 link** 也算数，
    //   而注释掉的 link 浏览器根本不加载，那是最典型的"守卫说有、页面其实没有"。
    if (spec.requiresComponentsCss) {
        const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
        const hrefs = [...htmlNoComments.matchAll(/<link\b[^>]*>/gi)]
            .map((t) => (t[0].match(/\bhref\s*=\s*(['"])([^'"]*)\1/i) || [])[2] || '');
        const linked = hrefs.some((h) => /assets\/css\/components\.css(\?|$)/.test(h));
        check(linked, `${spec.file}：已引入 components.css（真实 <link> 标签·注释掉的不算）`,
            linked ? '' : `未找到有效的 components.css <link>——sem-* 类会全部落空，徽章退化成无样式文本。实测 link href：${hrefs.join(' | ') || '(无)'}`);
    }

    // ② frozen map 存在（M3：AST 级——init 必须精确是 Object.freeze(对象字面量)，且同名常量恰一处）
    //   S4：map 可能落在共享 JS 里（Task_Pool 的 TASK_STATUS_BADGE 在 app.js），故先跨源定位。
    const mapHost = findConstHost(sources, spec.mapConst);
    check(mapHost.ok, `${spec.file}：${spec.mapConst} 在恰一个源里声明（页内 <script> 或共享 JS）`,
        mapHost.ok ? '' : mapHost.why);
    const mapAst = mapHost.ok ? mapHost.host.ast : null;

    const fz = checkFrozenObjectLiteral(mapAst, spec.mapConst);
    check(fz.ok, `${spec.file}：${spec.mapConst} = Object.freeze(对象字面量)，且同名常量恰一处`,
        fz.ok ? '' : fz.why);
    if (fz.ok) {
        const dup = duplicateKeysOf(fz.objectNode);
        check(dup.length === 0, `${spec.file}：${spec.mapConst} 无重复 key`,
            dup.length ? `${dup.length} 个重复：${dup.join(' | ')} —— JS 取末次、人读到首次，是标准分叉通道` : '');
    }

    // ③ map 键值与期望表**逐对**相等（键集全等 + 每个 value 是合法 sem-<层>）
    //   〔S4〕map 的 value 允许两种形状：直接是 class 片段字符串（PF/MC），
    //   或是一个含 `cls` 字段的对象（Task_Pool/MW 的 {cls, label, drawerLabel}）——
    //   由 spec.mapValueField 声明取哪个字段，未声明则按字符串取。
    const node = mapAst ? findConstInitNodes(mapAst, spec.mapConst)[0] : null;
    const res = node
        ? (spec.mapValueField ? entriesOfObjectValuedMap(node, spec.mapValueField) : membersOfNode(node, 'objectEntries'))
        : { members: [], dynamic: ['常量未找到或解析失败'] };
    check(res.dynamic.length === 0 && res.members.length > 0,
        `${spec.file}：${spec.mapConst} 可从 AST 完整提取（全静态字面量）`,
        res.dynamic.length ? `无法提取：${[...new Set(res.dynamic)].join(' | ')}` : '提取到 0 条');

    if (res.dynamic.length === 0 && res.members.length) {
        const actual = new Map(res.members);
        const expected = spec.expectStatuses;
        const diffs = [];
        for (const [k, v] of Object.entries(expected)) {
            if (!actual.has(k)) diffs.push(`缺 '${k}'`);
            else if (actual.get(k) !== v) diffs.push(`'${k}' → \`${actual.get(k)}\`（期望 \`${v}\`）`);
        }
        for (const k of actual.keys()) if (!(k in expected)) diffs.push(`多出 '${k}' → \`${actual.get(k)}\``);
        check(diffs.length === 0, `${spec.file}：${spec.mapConst} 与期望映射逐对一致（${Object.keys(expected).length} 对）`,
            diffs.length ? `${diffs.length} 处：${diffs.join('；')}` : '');

        // value 必须是 14 层之一的 sem-<层>——写错层名会静默落 base fallback
        const badTier = [...actual.entries()].filter(([, v]) => !/^sem-([a-z]+)$/.test(v) || !SEM_TIERS.includes(v.slice(4)));
        check(badTier.length === 0, `${spec.file}：${spec.mapConst} 的 value 均为合法 sem-<14 层之一>`,
            badTier.length ? `${badTier.length} 处非法：${badTier.map(([k, v]) => `${k}=${v}`).join(' | ')}` : '');
    }

    // ③b 文案字段逐条钉死（M-1「固定 label」）+ 逐 value 冻结（S4-fix LOW-1）
    assertMapLabelFields(check, spec, fz.ok ? fz.objectNode : null);
    assertObjectValuedMapFrozen(check, spec, fz.ok ? fz.objectNode : null);

    // ④ 页内 <style> 不得出现任何 sem-*/u-status-badge 规则（共享层是唯一定义处），
    //    也不得定义 --sem-* token；内联 style="" 同禁（对齐别名页 B-H6②）。
    const styleText = pageStyleText(html);
    const semRules = allSelectorHeads(styleText).filter((sel) => /\.sem-[a-z]+/.test(sel) || /\.u-status-badge/.test(sel));
    check(semRules.length === 0, `${spec.file}：页内 <style> 无 sem-*/u-status-badge 规则（样式只在共享层）`,
        semRules.length ? `${semRules.length} 条：${semRules.join(' | ')} —— 页面私自复刻共享层定义，会与共享层分叉` : '');

    const styleSemDefs = [...new Set(styleText.match(/--sem-[\w-]+\s*:/g) || [])];
    check(styleSemDefs.length === 0, `${spec.file}：页内 <style> 不定义 --sem-* token`,
        styleSemDefs.length ? `${styleSemDefs.length} 处：${styleSemDefs.join(' ')} —— 覆盖全站色板且守卫扫共享层时看不见` : '');

    const inlineSemDefs = [...html.matchAll(/style\s*=\s*"([^"]*)"/g)].map((m) => m[1]).filter((v) => /--sem-[\w-]+\s*:/.test(v));
    check(inlineSemDefs.length === 0, `${spec.file}：无 style="" 内联属性定义 --sem-* token`,
        inlineSemDefs.length ? `${inlineSemDefs.length} 处：${inlineSemDefs.slice(0, 3).join(' | ')} —— 元素级覆盖优先级最高且扫 CSS 时看不见` : '');

    // ⑤ 旧类零残留（M6：改**标识符级**匹配，三面扫描；S4：代码面覆盖全部源，含共享 JS）
    //   ⚠️ 作用域说明：forbiddenClasses 的禁令**只作用于本 spec 的源**（该页 HTML + 它声明的共享 JS）。
    //     Task_Pool/My_Workspace 把 `status-badge` 列进禁令，禁的是这两页与 app.js；
    //     Asset_Center / Domain_Manager 页内自有 `.status-badge` 输出仍然合法（它们不在 spec 里，不被扫），
    //     style.css 的 `.status-badge` base 也不在扫描面内（P1 口径：base 保留，由 verify-unify-static.js
    //     的"退场不过头"断言单独看住）。
    const codeText = sources.map((s) => stripJsComments(s.source)).join('\n;\n');
    const bodyText = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    for (const cls of spec.forbiddenClasses || []) {
        const hit = assertLegacyClassAbsent(check, spec, cls, codeText, styleText, bodyText);
        void hit;
    }

    // ⑥ 模板串负向 + DOM API 负向（与别名页同源）+ class sink 溯源（B-M2）
    for (const re of spec.rawConcatForbidden || []) {
        const hit = re.test(codeText);
        check(!hit, `${spec.file}：无「非 gate 表达式拼进徽章 class」残留（/${re.source}/）`,
            hit ? '模板里有绕过登记 gate 的拼接写法' : '');
    }
    assertNoDomApiBypass(check, spec, html, sources.slice(1).map((s) => s.source));
    assertClassSinkProvenance(check, spec, sources);
    assertGateReturnShapes(check, spec, sources);   // MED-2：gate 自己吐什么也要管

    // ⑥ 状态源反向断言（可选）
    if (spec.statusSource) {
        const src = spec.statusSource;
        const srcHost = findConstHost(sources, src.const);
        const nodes = srcHost.ok ? findConstInitNodes(srcHost.host.ast, src.const) : [];
        check(nodes.length > 0, `${spec.file}：状态源常量 ${src.const} 可从 AST 提取`,
            nodes.length ? '' : `${srcHost.why || '常量被改名/删除'}，"新增状态漏接线"防线失效`);
        if (nodes.length) {
            const { members, dynamic } = membersOfNode(nodes[0], src.kind);
            check(dynamic.length === 0, `${spec.file}：${src.const} 全部成员为静态字面量`,
                dynamic.length ? `${[...new Set(dynamic)].join(' | ')}` : '');
            const keys = Object.keys(spec.expectStatuses);
            const outside = members.filter((m) => !keys.includes(m));
            check(outside.length === 0, `${spec.file}：${src.const} 的状态成员全部已在徽章映射内`,
                outside.length ? `${outside.length} 个没接线：${[...new Set(outside)].join(' | ')}` : '');
        }
    }

    // ⑦ 后端源比对（fail-closed·可多条）
    for (const bs of spec.backendSources || []) {
        const srcFile = bs.file || path.join(__dirname, '..', 'server.js');
        const srcTxt = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, 'utf8') : null;
        // MED-4：先按 `CREATE TABLE ... <表名> ( ... )` 切块再匹配——不切块的话正则会命中文件里
        //   **第一个**符合形状的 CHECK，两张表就会比对到同一个对象上（假绿）。
        let scope = srcTxt;
        if (srcTxt !== null && bs.table) {
            const blockRe = new RegExp('CREATE TABLE[^`]*?' + escapeRegExp(bs.table) + '\\s*\\(([\\s\\S]*?)\\)`', 'i');
            const bm = srcTxt.match(blockRe);
            scope = bm ? bm[1] : null;
        }
        // astExtract（M4）返回 { values } 或 { error }；extract 返回字符串数组。
        let got = null;
        let astErr = '';
        if (scope !== null && scope !== undefined) {
            if (bs.astExtract) {
                const r = bs.astExtract(scope);
                if (r && r.error) astErr = r.error; else got = (r && r.values) || [];
            } else {
                got = bs.extract(scope);
            }
        }
        check(got !== null && got.length > 0, `${spec.file}：可提取后端状态源（${bs.label}）`,
            srcTxt === null ? `读不到 ${srcFile}`
                : (astErr ? astErr
                    : (scope === null ? `按表名 ${bs.table} 切块失败——建表写法变了，提取锚点须同步修`
                        : `提取到 ${got ? got.length : 0} 项——提取锚点失效则本页前后端一致性防线失效`)));
        if (got && got.length) {
            const keys = Object.keys(spec.expectStatuses);
            const except = bs.except || [];
            const missing = got.filter((s) => !keys.includes(s) && !except.includes(s));
            check(missing.length === 0,
                `${spec.file}：后端状态集${bs.mode === 'equal' ? '与' : ' ⊆ '}徽章映射（${bs.label}${except.length ? '·豁免 ' + except.join('/') : ''}）`,
                missing.length ? `${missing.length} 个后端状态没接线：${missing.join(' | ')}` : '');
            if (bs.mode === 'equal') {
                const extra = keys.filter((k) => !got.includes(k));
                check(extra.length === 0, `${spec.file}：徽章映射无后端不存在的多余状态（${bs.label}）`,
                    extra.length ? `${extra.length} 个：${extra.join(' | ')}` : '');
            }
        }
    }

    // ⑧ 渲染点 gate + 次数（S4：跨源求和——Task_Pool 的渲染点全在 app.js，MW 页内另有一处）
    for (const gate of spec.renderGate || []) {
        const count = countGateCallsAcross(sources, gate);
        const want = spec.renderGateCount && spec.renderGateCount[gate];
        const perSource = sources.map((s) => `${s.label}=${countGateCalls(s.ast, gate)}`).join('，');
        if (typeof want === 'number') {
            check(count === want, `${spec.file}：gate 调用次数恰为 ${want} —— \`${gate}\``,
                count === want ? '' : `实际 ${count} 次（${perSource}）`);
        } else {
            check(count > 0, `${spec.file}：渲染点走 gate —— \`${gate}\``, count > 0 ? '' : `未找到该调用形态（${perSource}）`);
        }
    }
}

function assertPageAliases(check, spec) {
    const html = readPage(spec.file);
    check(html !== null, `${spec.file}：文件存在于 public/`, html === null ? '未找到' : '');
    if (html === null) return;

    const styleText = pageStyleText(html);
    const keys = Object.keys(spec.tiers);

    // 页面 JS → AST（B-H1/H2）。解析失败 = 红灯 fail-closed，后续依赖 AST 的断言全部跳过
    //   （它们会因 ast 为 null 而各自报红，不会静默变绿）。
    assertSharedJsMatchesPage(check, spec, html);   // B8：别名页同样对账（它们 sharedJs 为空，只查未登记本地脚本）

    const pageSrc = inlineScriptSource(html);
    const parsed = parseJs(pageSrc);
    check(parsed.ok, `${spec.file}：页内 <script> 可被 acorn 解析（AST 提取前置）`,
        parsed.ok ? '' : `解析失败：${parsed.error} —— 解析不了就读不出真实常量，所有基于状态源的断言都会失去意义`);
    const ast = parsed.ok ? parsed.ast : null;
    assertNoUnparsedScripts(check, spec, html);   // L8：别名页同样不许有守卫读不到的 script

    // B-H6② 内联 style 属性里不得定义 --sem-*（那是页面私自覆盖全站色板，且改的是元素级，最难发现）
    const inlineSemDefs = [...html.matchAll(/style\s*=\s*"([^"]*)"/g)]
        .map((m) => m[1])
        .filter((v) => /--sem-[\w-]+\s*:/.test(v));
    check(inlineSemDefs.length === 0, `${spec.file}：无 style="" 内联属性定义 --sem-* token`,
        inlineSemDefs.length ? `${inlineSemDefs.length} 处：${inlineSemDefs.slice(0, 3).join(' | ')} —— 元素级覆盖优先级最高且守卫扫 CSS 时看不见` : '');

    // ⑨ 逐 key 连通（存在且恰一条）
    const missing = [];
    const duped = [];
    for (const k of keys) {
        const bodies = ruleBodiesFor(styleText, spec.selector(k));
        if (bodies.length === 0) missing.push(spec.selector(k));
        else if (bodies.length > 1) duped.push(`${spec.selector(k)}（${bodies.length} 条）`);
    }
    check(missing.length === 0, `${spec.file}：${keys.length} 个状态 key 逐个有别名规则（对照 S0 矩阵 key 全集）`,
        missing.length ? `缺 ${missing.length} 条（这些状态会掉进 base 的 wait fallback 变中性灰，用户分不清"没接线"和"真的在等待"）：${missing.join(' | ')}` : '');
    check(duped.length === 0, `${spec.file}：无同 key 重复别名规则`,
        duped.length ? `${duped.length} 处重复（守卫读第一条、浏览器级联用最后一条 = 分叉假绿）：${duped.join(' | ')}` : '');

    // ⑩ 封闭校验：规则体内**只允许**六个 --sb-* 声明，各一次，逐项等于 var(--sem-<层>-<键>)
    const broken = [];
    for (const k of keys) {
        const bodies = ruleBodiesFor(styleText, spec.selector(k));
        if (bodies.length !== 1) continue;   // 缺/重复已在⑨报
        const body = bodies[0];
        const tier = spec.tiers[k];
        if (!SEM_TIERS.includes(tier)) {
            broken.push(`${spec.selector(k)} 配置的层 \`${tier}\` 不在 14 层集合内（守卫配置本身写错）`);
            continue;
        }
        const decls = declarationsOf(body);
        // ⑩a 封闭性：不许夹带任何非 --sb-* 属性。别名规则的唯一职责是"指向哪一层"，
        //     夹带 border/text-decoration/padding 会绕过 token 直接生效（与 direct 色值双存同类病）。
        const alien = decls.filter((d) => !/^--sb-(bg|fg|bd|bds|dot|deco)$/.test(d.prop));
        if (alien.length) {
            broken.push(`${spec.selector(k)} 夹带 ${alien.length} 条非 --sb-* 声明：${alien.map((d) => d.prop).join('/')}`);
        }
        // ⑩b 六键各一次 + 逐项层名对应
        for (const suf of SEM_TOKEN_SUFFIXES) {
            const hit = decls.filter((d) => d.prop === `--sb-${suf}`);
            if (hit.length === 0) { broken.push(`${spec.selector(k)} 缺 --sb-${suf}`); continue; }
            if (hit.length > 1) { broken.push(`${spec.selector(k)} 的 --sb-${suf} 重复 ${hit.length} 次`); continue; }
            const expected = `var(--sem-${tier}-${suf})`;
            if (hit[0].value !== expected) {
                broken.push(`${spec.selector(k)} 的 --sb-${suf}=\`${hit[0].value}\`（应为 \`${expected}\`）`);
            }
        }
    }
    check(broken.length === 0, `${spec.file}：每条别名封闭（只含六个 --sb-*，各一次，逐项引用登记层 token）`,
        broken.length ? `${broken.length} 处：${broken.slice(0, 6).join('；')}${broken.length > 6 ? ' …' : ''}` : '');

    // ⑨b 反向断言（M-2 + B-H1/H2 AST 化）：页面真实状态源的成员集必须 ⊆ 配置表 keys。
    //   ⑨ 只保证"配置表里写的都接线了"；⑨b 才保证"页面新增状态不会漏接线"——没有它，
    //   后端加个状态、前端 STATUS_LABELS 补一行，徽章就静默变中性灰，而守卫全绿。
    if (spec.statusSource) {
        const src = spec.statusSource;
        const nodes = ast ? findConstInitNodes(ast, src.const) : [];
        const needed = src.minOccurrences || 1;
        check(!!ast && nodes.length >= needed,
            `${spec.file}：状态源常量 ${src.const} 可从 AST 提取（期望 ≥${needed} 处定义）`,
            !ast ? '页面 JS 解析失败（见上一条），无法提取'
                : (nodes.length >= needed ? '' : `实际找到 ${nodes.length} 处——常量被改名/删除/写进了注释或字符串，则"新增状态漏接线"防线失效`));

        if (ast && nodes.length) {
            const outside = [];
            const dynamics = [];
            nodes.forEach((node, idx) => {
                const { members, dynamic } = membersOfNode(node, src.kind);
                const tag = nodes.length > 1 ? `（第 ${idx + 1} 处定义）` : '';
                dynamic.forEach((d) => dynamics.push(d + tag));
                for (const mem of members) {
                    if (!keys.includes(mem) && !(spec.intentionallyUnmapped || []).includes(mem)) {
                        outside.push(mem + tag);
                    }
                }
            });
            // fail-closed：动态成员守卫读不懂，"读不懂"不等于"没问题"
            check(dynamics.length === 0, `${spec.file}：${src.const} 全部成员为静态字面量（守卫可完整读取）`,
                dynamics.length ? `${dynamics.length} 处动态成员，守卫无法判定其取值：${[...new Set(dynamics)].join(' | ')} —— 请改回静态字面量，或在 spec 里明确豁免并写清为什么安全` : '');

            check(outside.length === 0,
                `${spec.file}：${src.const} 的状态成员全部已在别名配置表内（新增状态不会漏接线）`,
                outside.length ? `${outside.length} 个成员没有对应别名：${[...new Set(outside)].join(' | ')} —— 页面新增了状态但没接线，徽章会静默落 wait fallback` : '');
        }
    }

    // B-H7① 双源比对：spec 里登记的完整期望表 ↔ 页面常量 AST entries **逐对**比对。
    //   ⑨b 只比"成员集合"，集合相同但 **value 互换**（如把 dev/review 两条 class 片段对调）照样全绿，
    //   页面却会给"开发中"渲染成"待验证"的颜色。逐对比才拦得住。
    if (spec.fullMap) {
        const nodes = ast ? findConstInitNodes(ast, spec.fullMap.const) : [];
        const node = nodes[0];
        const { members, dynamic } = node ? membersOfNode(node, 'objectEntries') : { members: [], dynamic: ['常量未找到'] };
        check(dynamic.length === 0 && members.length > 0,
            `${spec.file}：${spec.fullMap.const} 可完整提取为 entries（双源比对前置）`,
            dynamic.length ? `无法提取：${[...new Set(dynamic)].join(' | ')}` : '提取到 0 条');
        if (dynamic.length === 0 && members.length) {
            const actual = new Map(members);   // members 已是 [key, value] 二元组数组
            const expected = spec.fullMap.entries;
            const diffs = [];
            for (const [k, v] of Object.entries(expected)) {
                if (!actual.has(k)) diffs.push(`缺 '${k}'`);
                else if (actual.get(k) !== v) diffs.push(`'${k}' → \`${actual.get(k)}\`（期望 \`${v}\`）`);
            }
            for (const k of actual.keys()) if (!(k in expected)) diffs.push(`多出 '${k}' → \`${actual.get(k)}\``);
            check(diffs.length === 0, `${spec.file}：${spec.fullMap.const} 与 S0 矩阵登记的期望表逐对一致（${Object.keys(expected).length} 对）`,
                diffs.length ? `${diffs.length} 处不一致：${diffs.slice(0, 6).join('；')}${diffs.length > 6 ? ' …' : ''} —— 期望表抄自 S0 双矩阵 §1.1，两边必须同步改` : '');
        }
    }

    // B-H7②③ 后端状态源比对（fail-closed：提取不到 = 红，不是跳过）
    if (spec.backendSource) {
        const bs = spec.backendSource;
        const serverJs = readServerJs();
        const got = serverJs === null ? null : bs.extract(serverJs);
        check(got !== null && got.length > 0, `${spec.file}：可从 server.js 提取后端状态源（${bs.label}）`,
            serverJs === null ? '读不到 server.js' : `提取到 ${got ? got.length : 0} 项——后端结构变了则本页"前后端状态集一致"防线失效，必须先修提取锚点`);
        if (got && got.length) {
            const missing = got.filter((s) => !keys.includes(s));
            check(missing.length === 0, `${spec.file}：后端状态集${bs.mode === 'equal' ? '与' : '⊆'} 别名配置表 keys（${bs.label}）`,
                missing.length ? `${missing.length} 个后端状态前端没接线：${missing.join(' | ')}` : '');
            if (bs.mode === 'equal') {
                const extra = keys.filter((k) => !got.includes(k));
                check(extra.length === 0, `${spec.file}：别名配置表无后端不存在的多余状态（${bs.label}）`,
                    extra.length ? `${extra.length} 个：${extra.join(' | ')} —— 前端接了后端根本产不出的状态，多半是抄错或状态已下线` : '');
            }
        }
    }

    // ⑨b 有意不接线的 key 必须**真的没有**规则。
    //   这条不是凑数：DC 的 s-UNKNOWN 是 statusClass() 的兜底出口，设计上就该落 base 的
    //   wait fallback（"这个状态我不认识"天然等同"中性等待"）。哪天有人好心给它补一条别名规则，
    //   兜底语义就被悄悄改写了——让守卫红一次，逼他回来看这段注释再决定。
    if (spec.intentionallyUnmapped) {
        const wrongly = spec.intentionallyUnmapped.filter((k) => ruleBodiesFor(styleText, spec.selector(k)).length > 0);
        check(wrongly.length === 0, `${spec.file}：有意不接线的 key 仍无别名规则（${spec.intentionallyUnmapped.join(' / ')}）`,
            wrongly.length ? `${wrongly.join(' | ')} 被补了规则——它们是兜底出口，接线会改写"未知状态=中性等待"的语义，请先确认是否真要改` : '');
    }

    // ⑪ 白名单式收口（B-H5·方向反转）
    //   旧版是**黑名单**：列举"direct 色值形态"和"尾节点为 .u-status-badge"两种已知坏形态去抓。
    //   黑名单的问题是漏项即放行——`.u-status-badge:hover{}`、`.s-FIXED[data-x]{}`、`#app .status-DONE{}`、
    //   `.s-FIXED.wide{}`、`:is(.si-s-dev){}` 全都绕得过去，而它们同样能改徽章观感。
    //   改为**白名单**：页内 <style> 里凡是选择器沾到 `.u-status-badge` 或本页别名前缀的规则，
    //   必须**精确等于**某条登记的别名选择器，否则一律红（除非在 STYLE_TAIL_WHITELIST 显式登记）。
    //   这样"我没想到的写法"默认是红灯而不是默认放行——守卫的默认答案应该是"不许"。
    const allowedSelectors = new Set(keys.map((k) => spec.selector(k)));
    const wl = STYLE_TAIL_WHITELIST[spec.file] || [];
    const badgeTouchRe = new RegExp('\\.u-status-badge|\\' + spec.selector('').replace(/\.$/, ''), 'i');
    const strayRules = allSelectorHeads(styleText).filter((sel) => {
        if (!/\.u-status-badge/.test(sel) && !badgeTouchRe.test(sel)) return false;
        if (allowedSelectors.has(sel)) return false;
        if (wl.includes(sel)) return false;
        return true;
    });
    check(strayRules.length === 0,
        `${spec.file}：页内所有沾徽章的 CSS 规则均为登记的别名形态（白名单式·非黑名单）`,
        strayRules.length
            ? `${strayRules.length} 条不在白名单：${strayRules.join(' | ')} —— 伪类/属性选择器/组合类/#id 前缀等变体同样能改徽章观感，确需保留请登记进 STYLE_TAIL_WHITELIST 并写明理由`
            : '');

    // ⑫ 白名单 map 三点闭环（配置表 ↔ map ↔ CSS）
    if (spec.mapConst) {
        const fz = checkFrozenObjectLiteral(ast, spec.mapConst);
        check(fz.ok, `${spec.file}：${spec.mapConst} = Object.freeze(对象字面量)，且同名常量恰一处`,
            fz.ok ? '' : `${fz.why} —— 终审 M：后端 CHECK 不替代前端 class 白名单，而"白名单"必须是静态字面量`);

        // AST 取 map 的 key/value 对（B-H3：按 property 节点直接配对，弃 indexOf 关联——
        //   indexOf 在有重复 key 时会关联错行，而重复 key 恰恰是要抓的问题之一）
        const mapNode = ast ? findConstInitNodes(ast, spec.mapConst)[0] : null;
        const entriesRes = mapNode ? membersOfNode(mapNode, 'objectEntries') : { members: [], dynamic: ['常量未找到或页面 JS 解析失败'] };
        check(entriesRes.dynamic.length === 0 && entriesRes.members.length > 0,
            `${spec.file}：${spec.mapConst} 可从 AST 完整提取（全静态字面量）`,
            entriesRes.dynamic.length ? `无法提取：${[...new Set(entriesRes.dynamic)].join(' | ')}` : '提取到 0 条');

        const pairs = entriesRes.members;   // [key, value] 二元组数组（AST 直出，无分隔符编码）
        const mapKeys = pairs.map((p) => p[0]);

        // B-H3 重复 key：运行时取末次、守卫若按首次读就产生分叉；直接判红最省心。
        const dupKeys = [...new Set(mapKeys.filter((k, i) => mapKeys.indexOf(k) !== i))];
        check(dupKeys.length === 0, `${spec.file}：${spec.mapConst} 无重复 key`,
            dupKeys.length ? `${dupKeys.length} 个重复：${dupKeys.join(' | ')} —— JS 对象字面量重复键取**最后一个**，与人读代码时看到的第一个不一致，是标准的分叉通道` : '');

        const missKey = keys.filter((k) => !mapKeys.includes(k));
        check(mapKeys.length > 0 && missKey.length === 0, `${spec.file}：${spec.mapConst} 覆盖全部 ${keys.length} 个状态 key`,
            mapKeys.length === 0 ? 'map 提取失败' : (missKey.length ? `缺 ${missKey.length} 个：${missKey.join(' | ')}（漏一个 = 该状态永远落 fallback）` : ''));

        // map keys ⊆ 配置表 keys（M-2）：map 里多出配置表没有的 key = 会输出一个没人写别名的片段
        const extraKey = mapKeys.filter((k) => !keys.includes(k));
        check(extraKey.length === 0, `${spec.file}：${spec.mapConst} 无配置表之外的多余 key`,
            extraKey.length ? `多 ${extraKey.length} 个：${extraKey.join(' | ')}（会输出没有对应别名规则的 class 片段，静默落 fallback）` : '');

        // value 闭环（M-1）：map[k] 必须精确等于 selector(k) 去掉根类前缀后的片段。
        //   没有这条，把 IT_STATUS_CLASS 里两个 value 互换（'待处理'→'s-处理中'）守卫照样全绿，
        //   而页面会给"待处理"渲染出"处理中"的颜色——三点闭环就是为了让这种错配无处藏。
        const valueMismatch = [];
        for (const [k, v] of pairs) {
            if (!keys.includes(k)) continue;
            const expectedFrag = spec.selector(k).replace(/^\.u-status-badge\./, '').replace(/^\./, '');
            if (v !== expectedFrag) valueMismatch.push(`${spec.mapConst}['${k}']=\`${v}\`（应为 \`${expectedFrag}\`）`);
        }
        check(valueMismatch.length === 0, `${spec.file}：${spec.mapConst} 的 value 与别名选择器精确闭环`,
            valueMismatch.length ? `${valueMismatch.length} 处错配：${valueMismatch.join('；')} —— 配置表/map/CSS 三点必须一致，错配会让状态显示成别的状态的颜色` : '');
    }

    // 渲染点走 gate（受控页也要——受控靠的是 gate 本身，不是"这页历史上比较干净"）
    // B-H4：不只断"有没有"，还断**出现次数恰等**——少一处 = 有渲染点被改成绕过 gate，
    //   而"存在性断言"对此完全无感（只要还剩一处 gate 调用就绿）。
    if (spec.renderGate) {
        // M5：改按 **AST 里的 CallExpression** 计数（不再数文本出现次数）。
        //   剥注释只解决了注释干扰，字符串字面量里出现同形文本、或 gate 名恰是别的标识符子串，
        //   仍会把恰等断言喂错数。数调用节点是"这行代码真的调用了它"的唯一可靠证据。
        for (const gate of spec.renderGate) {
            const count = countGateCalls(ast, gate);
            const want = spec.renderGateCount && spec.renderGateCount[gate];
            if (typeof want === 'number') {
                check(count === want, `${spec.file}：gate 调用次数恰为 ${want} —— \`${gate}\``,
                    count === want ? '' : `实际 ${count} 次：少了说明有渲染点绕过 gate，多了说明新增渲染点未登记（两种都要人来确认）`);
            } else {
                check(count > 0, `${spec.file}：渲染点走 gate —— \`${gate}\``,
                    count > 0 ? '' : '未找到该调用形态，渲染点可能已绕过 gate 直拼原值');
            }
        }
    }
    if (spec.rawConcatForbidden) {
        for (const re of spec.rawConcatForbidden) {
            const hit = re.test(html);
            check(!hit, `${spec.file}：无「后端原值直拼 class」残留（/${re.source}/）`,
                hit ? '仍有渲染点把状态原值直接拼进 class，白名单被架空（终审 M）' : '');
        }
    }

    assertNoDomApiBypass(check, spec, html);
    // B-M2：别名页同样过 class sink 溯源（六页的动态片段都应落到 gate / frozen 白名单 / 守门三元）
    const aliasSources = [{ label: `${spec.file} 页内 <script>`, source: pageSrc, ast }];
    assertClassSinkProvenance(check, spec, aliasSources);
    assertGateReturnShapes(check, spec, aliasSources);   // MED-2
}

// ── HTML 正文 class 属性解析（23B·B-M3）──────────
//   旧写法 `/class\s*=\s*(['"])([\s\S]*?)\1/g` 有四个已知缺陷，全是"漏放行"或"假红"两头出错：
//     ① 无属性名边界 —— `data-class="badge-open"` 会从 `data-` 中间的 `class=` 起匹配，
//        把一个与 class 无关的自定义属性当成 class 判红（**假红**，前一版实测会中）；
//     ② 大小写 —— `CLASS="badge-open"` 用 `class=` 匹配不到（**漏放行**）；
//     ③ 无引号值 —— `<span class=badge-open>` 匹配不到（HTML 允许无引号属性值）（**漏放行**）；
//     ④ 不解码实体 —— `class="badge&#45;open"` 逐 token 比对时与 `badge-open` 不等（**漏放行**）。
//   改为：先按**开始标签**切出属性区，再在属性区内按属性名边界逐个解析属性，
//   属性名不区分大小写地精确等于 `class` 才收，值先解码 HTML 实体再按空白拆 token。
const HTML_START_TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const HTML_ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeHtmlEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        const k = body.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : whole;
    });
}

// 返回 markup 里所有 class 属性拆出来的 token（已解码实体）。
function classTokensInMarkup(markup) {
    const tokens = [];
    for (const tag of markup.matchAll(HTML_START_TAG_RE)) {
        const attrRegion = tag[2] || '';
        const attrRe = new RegExp(HTML_ATTR_RE.source, 'g');
        let a;
        while ((a = attrRe.exec(attrRegion)) !== null) {
            if (a[1].toLowerCase() !== 'class') continue;      // 属性名完整边界 + 不区分大小写
            const rawValue = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
            for (const tok of decodeHtmlEntities(rawValue).split(/\s+/)) {
                if (tok) tokens.push(tok);
            }
        }
    }
    return tokens;
}

// ── M6：旧徽章类零残留（标识符级·三面扫描）──────────
//   原实现用 `/class="pf-badge/` 这类**片段正则**，漏面很大：单引号 class='pf-badge'、
//   模板串里 class="… pf-badge"（不在开头）、classList.add('pf-badge')、className: 'pf-badge' 全绕过。
//   改为按**类名标识符边界** `\bpf-badge\b` 在三个面上找：
//     · 代码面：剥注释后的页内 JS（覆盖模板串与 DOM API 两种写法）
//     · 样式面：剥注释后的 <style> 选择器文本
//     · 正文面：去 script/style/注释后的 HTML，且**解析 class 属性**逐 token 比对
//   注释里提及旧类名（记录"退场了什么"）允许，故三面都先剥注释。
function assertLegacyClassAbsent(check, spec, cls, codeText, styleText, bodyText) {
    const tokenRe = classTokenRe(cls, 'g');
    const inCode = codeText.match(tokenRe) || [];
    const inStyle = stripCssComments(styleText).match(tokenRe) || [];
    // 正文面按 class 属性逐 token 判定（B-M3：属性名边界 + 大小写 + 单/双/无引号 + 实体解码）
    const bodyTokens = classTokensInMarkup(bodyText).filter((tok) => tok === cls);
    const total = inCode.length + inStyle.length + bodyTokens.length;
    check(total === 0, `${spec.file}：旧徽章类 \`${cls}\` 零残留（JS/样式/HTML 正文三面·标识符级）`,
        total ? `JS ${inCode.length} 处、样式 ${inStyle.length} 处、HTML class 属性 ${bodyTokens.length} 处（注释内提及不计）` : '');
    return total === 0;
}

// ============================================================
// class sink 溯源断言（23B·B-M2·codex 收窄版）
// ============================================================
//   要补的缺口：M5 只证明"gate 被调用了 N 次"，**不证明**"进 class 属性的那个片段就是 gate 的返回值"。
//   把 `s-${statusClass(x)}` 改成 `s-${x}` 而在别处补一次 `statusClass(x)` 调用，次数照样恰等、
//   rawConcatForbidden 的负向前瞻也可能因写法不同而绕过——白名单被架空但守卫全绿。
//
//   完整数据流分析（别名传播 + 跨函数追踪）成本远超收益（22C-M1 / 23-M5 已两次登记接受）。
//   codex 23B 给的**收窄版**：只做"局部、可判定"的溯源，判不了就红——
//     进入徽章 class 的每个动态片段，必须能落到下列**有限形态**之一，否则一律红：
//       ① 登记 gate 的调用表达式                       —— `${statusClass(h.to_status)}`
//       ② 局部变量，且其（唯一作用域内的）初始化器递归满足本规则、且该变量在作用域内从不被重新赋值
//                                                     —— Issue_Lite 的 `stDisp` → `st` → 守门三元
//       ③ frozen 白名单 map 的**静态成员取值**，且键在登记状态集内 —— `${PF_STATUS_CLASS.failed}`
//       ④ 字符串字面量（人写死的静态值，不是运行时数据）—— `'u-status-badge ' + gate(...)` 的左操作数
//       ⑤ 由 ①-④ 组合出的三元/字符串拼接/或运算/嵌套模板
//       ⑥ **守门三元**：`WHITELIST.includes(v) ? v : '默认值'`（gate 作判据而非映射，Issue_Lite 范式）
//   识别不了的一律红（函数参数、任意成员取值、计算属性、函数调用非 gate……）——
//   守卫的默认答案是"不许"，不是"没见过就放行"。
//
//   ── S4-fix MED-1：sink 采集改「完整采集」，非徽章 sink 另立判据 ──────────
//   缺口：旧版只采集"静态文本已含 u-status-badge"的 sink，于是这种写法整条不在视野内——
//     `const _c = 'u-status-badge sem-' + String(status).toLowerCase();`  →  `class="${_c}"`
//   模板里一个徽章字样都没有，六形态溯源再严也够不着。现在**全部 class sink 都采集**，按两类判：
//     · 静态文本已带根类（徽章 sink）→ 六形态溯源，原样不变；
//     · 静态文本不带根类（非徽章 sink）→ 判「**徽章标记不可达**」：算出该片段可能产出的
//       字符串骨架集合（字面量/模板/拼接/三元/或运算逐层展开，gate 调用与 frozen map 取值按
//       其**有界返回值集**代入），再加一遍子树内可达字符串字面量；任一处出现
//       `u-status-badge` 或 `sem-` 标记即红；另对整条 class 属性做一次骨架拼接，
//       防"静态文本 + 动态片段各出一半拼出标记"（如 `class="u-status-${'badge'}"`）。
//
//   ⚠️〔判据取舍·实测数据在此，不是拍脑袋〕原始要求是"判不了=红"。实测：本 spec 覆盖的 10 个源里，
//   非徽章 class sink 的动态片段共 **65 处**（非 gate 调用 17 / 标识符 21 / 三元 19 / 成员取值 8），
//   典型如 `class="task-card ${(task.status||'open').toLowerCase()}"`、`class="category-badge ${cat.cls}"`
//   ——它们天生无法静态定值。对这 65 处套六形态溯源会一次产出约 65 条红灯，全部是假红，
//   守卫会立刻变成没人看的噪音源（而噪音化的守卫等于没有守卫）。
//   故非徽章 sink 改用**标记可达性**这条判据：它对本条要防的形态是完备的——徽章类名要进 class，
//   必然经由某个静态可见的字符串字面量或 gate/map 的返回值，两者都在判定范围内；
//   跟不动的节点（任意成员取值、非 gate 调用的返回值）**登记接受**，威胁模型与 22C-M1 / 23-M5 一致：
//   防的是未来疏忽而非对抗者，而疏忽的表现形式恰恰是"把徽章类名写进某个字面量"。
//   报告里会打印"跟不动节点"的个数，让这条边界是台面上的数字而不是沉默的假设。
//   若将来要收紧到真正的"判不了=红"，前置是先给非徽章 class 片段建立同款白名单，属独立事项。
//
//   ⚠️ 边界（显式登记，不假装覆盖）：
//     · 只看**页面/共享 JS 自身**的 sink。unify-helpers.js 的 statusBadge/statusBadgeByMap 内部拼装
//       由 verify-unify-static.js 断言③⑧ 负责，不在本条视野内。
//     · 只追**同源内**的局部变量。跨文件传进来的值落在"函数参数"分支 = 红，符合预期。
//     · 不断言"sink 数量必须 > 0"——Statistics 这类经共享 helper 出徽章的页面本就零 sink，
//       渲染点是否还在由 renderGateCount 的恰等断言负责。

function isFunctionNode(n) {
    return !!n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

function keyNameOf(keyNode) {
    if (!keyNode) return null;
    if (keyNode.type === 'Identifier') return keyNode.name;
    if (keyNode.type === 'Literal') return String(keyNode.value);
    return null;
}

function forEachChildNode(node, fn) {
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') fn(c); });
        else if (v && typeof v.type === 'string') fn(v);
    }
}

// ── 作用域模型（S4-fix2 B10：手写作用域链 → eslint-scope）──────────
//   为什么换：手写版把"作用域"近似成了"函数 / Program 两级 + 子树扫 VariableDeclarator"，
//   对下面这些一律判错——**块级** `let/const`（`if (…) { const c = … }` 与外层同名变量互相看见）、
//   `catch (e)` 绑定、`for (const x of …)` 的每轮绑定、解构声明（`const { a } = o` 根本不是
//   Identifier 形态的 declarator，扫不到）、函数声明提升、同名遮蔽的准确归属。
//   任何一处判错都是**按名字**而不是**按绑定身份**在推理，结论可能张冠李戴——
//   守卫的推理链一旦不可信，它给出的绿色也不可信。
//   eslint-scope 是 ESLint 自己用的实现，按**绑定身份**建索引，上述形态全覆盖。
//   ⚠️ 它要求 AST 带 range（parseJs 已开 ranges:true）；分析失败一律 fail-closed 判红，不静默降级。
function buildScopeIndex(ast) {
    let es;
    try { es = require('eslint-scope'); } catch (e) { return { ok: false, why: 'eslint-scope 不可用：' + e.message }; }
    let sm;
    try {
        // nodejsScope:true —— 把整个源当作**被一层函数包住**来分析。
        //   〔S4-fix5 实测发现·比报上来的问题更深〕纯 script 模式下，eslint-scope 的 GlobalScope
        //   只解析"直接写在全局作用域里"的引用；**从函数内部**引用一个顶层 const / 顶层 function
        //   一律留在 through 里不解析。而页面脚本几乎所有白名单常量与 helper 都是顶层声明、
        //   在渲染函数里被引用 —— 等于此前所有这类标识符都落在"解析不到"分支，
        //   staticStringOf / possibleSkeletons / sinkProvenance 三条链路同时失明。
        //   实测：同一段源 5/7 → 6/7 解析率，剩下的 1 个是真全局 `Object`（本就该不解析）。
        sm = es.analyze(ast, { ecmaVersion: 2022, sourceType: 'script', ignoreEval: true, optimistic: false, nodejsScope: true });
    } catch (e) {
        return { ok: false, why: '作用域分析失败：' + e.message };
    }
    const refByIdentifier = new Map();
    for (const scope of sm.scopes) for (const ref of scope.references) refByIdentifier.set(ref.identifier, ref);
    return { ok: true, sm, refByIdentifier };
}

// 解析一个"被当作值读取"的标识符 → 它的全部取值来源。
//   〔B2〕收集的是该绑定的**全部写引用的右值**，不再只看初始化器——
//   `let c = ''; c = 'u-status-badge sem-done';` 这种写法，只看初始化器会读到一个干干净净的空串，
//   而真正进 DOM 的是第二次赋值的值。写引用里凡是**拿不到右值**的形态
//   （`for (c of arr)` 每轮绑定、解构赋值、`c++`）计入 unknownWrites，由调用方按 fail-closed 判红。
function resolveValueSources(idNode, ctx) {
    const idx = ctx.scopeIndex;
    if (!idx || !idx.ok) return { kind: 'unresolved', why: idx ? idx.why : '无作用域索引' };
    const ref = idx.refByIdentifier.get(idNode);
    if (!ref) return { kind: 'unresolved', why: `\`${idNode.name}\` 不是一次变量读引用（属性名/声明名？）` };
    const v = ref.resolved;
    if (!v) return { kind: 'unresolved', why: `\`${idNode.name}\` 解析不到声明（全局变量或来自别的文件）` };
    if ((v.defs || []).some((d) => d.type === 'Parameter')) {
        return { kind: 'param', why: `\`${idNode.name}\` 是函数参数，取值来源无法静态判定` };
    }
    // 〔B2·S4-fix3〕解构绑定要把**路径投影**做出来，不能拿整个初始化器当这一格的值。
    //   `const { cls } = meta;` 的写引用 writeExpr 是 `meta` —— 直接当成 cls 的值，
    //   既可能假红（meta 里别的字段带徽章字样）也可能假绿（真正的 cls 来自别处）。
    //   这里按 Pattern 路径投影：能精确投出静态节点就用它，投不出来计入 unknownWrites 判红。
    const patternPathOf = (def) => {
        if (!def || !def.node || def.node.type !== 'VariableDeclarator') return null;
        const root = def.node.id;
        if (!root || root.type === 'Identifier') return [];      // 非解构，无需投影
        const path = [];
        const walk = (node, acc) => {
            if (!node) return false;
            if (node === def.name) { path.push(...acc); return true; }
            if (node.type === 'ObjectPattern') {
                for (const p of node.properties) {
                    if (p.type !== 'Property' || p.computed) continue;   // 计算键/RestElement 投不出
                    const key = keyNameOf(p.key);
                    if (key === null) continue;
                    if (walk(p.value, [...acc, { kind: 'prop', key }])) return true;
                }
                return false;
            }
            if (node.type === 'ArrayPattern') {
                for (let i = 0; i < node.elements.length; i++) {
                    if (!node.elements[i] || node.elements[i].type === 'RestElement') continue;
                    if (walk(node.elements[i], [...acc, { kind: 'index', i }])) return true;
                }
                return false;
            }
            if (node.type === 'AssignmentPattern') return walk(node.left, acc);
            return false;
        };
        return walk(root, []) ? path : null;
    };
    const project = (expr, path) => {
        let cur = expr;
        for (const step of path) {
            if (!cur) return null;
            if (step.kind === 'prop') {
                if (cur.type !== 'ObjectExpression') return null;
                const hit = cur.properties.filter((p) => p.type === 'Property' && !p.computed && keyNameOf(p.key) === step.key);
                if (hit.length !== 1) return null;
                cur = hit[0].value;
            } else {
                if (cur.type !== 'ArrayExpression' || !cur.elements[step.i]) return null;
                cur = cur.elements[step.i];
            }
        }
        return cur;
    };

    const writes = [];
    let unknownWrites = 0;
    const defs = v.defs || [];
    const patternDef = defs.find((d) => d.node && d.node.type === 'VariableDeclarator' && d.node.id && d.node.id.type !== 'Identifier');
    const path = patternDef ? patternPathOf(patternDef) : [];
    for (const r of v.references) {
        if (!r.isWrite()) continue;
        if (!r.writeExpr) { unknownWrites++; continue; }
        if (!path || !path.length) {
            if (path === null) { unknownWrites++; continue; }   // 解构路径投不出来（计算键/Rest）
            writes.push(r.writeExpr);
            continue;
        }
        const projected = project(r.writeExpr, path);
        if (projected) writes.push(projected);
        else unknownWrites++;      // 右值不是静态字面量结构，投影不出这一格
    }
    return { kind: 'writes', variable: v, writes, unknownWrites };
}

// 表达式紧邻的静态前缀恰好以状态片段前缀收尾时（如 `… u-status-badge s-` + ${expr}），
//   该表达式产出的就是**片段本身**，此时连字符串字面量分支也必须落在登记状态集内
//   （拼错一个字 = 输出一个没有别名规则的类，静默落 fallback）。
//   ⚠️〔边界登记·S4-fix〕本正则含 `sem-` 分支，但 sem 模式页的模板是 `u-status-badge ${gate(...)}`
//   ——片段前缀在**gate 的返回值里**，不在模板静态文本里，所以 sem 页上这条 `sem-` 分支当前**不可达**。
//   即便将来有人写成 `u-status-badge sem-${x}`，也会先被该页的 rawConcatForbidden 负向前瞻拦下
//   （它只放行 `${gate(` 开头）。此处保留 `sem-` 分支是为形态完整、不是当前生效的防线；
//   真正管住 sem 页字面量层名的是「map value 均为合法 sem-<14 层之一>」那条断言。
//   语义偏差登记：该分支若真被触发，会用**状态键集**去校验一个**层名**字面量（两者不同集合），
//   判据会失真 —— 触发前需先把校验集合换成 SEM_TIERS。当前不可达故不改，改了反而多一处没人验证的分支。
const FRAGMENT_PREFIX_RE = /(?:^|\s)(?:si-s-|s-|status-|sem-)$/;
const BADGE_ROOT_RE = /(?<![\w-])u-status-badge(?![\w-])/;
// 〔S5a-fix2 M5〕**次级族根类并列进 sink 溯源体系**。
//   缺口：口径二各族此前只有 rawConcatForbidden（文本正则）在管。文本正则是"列举已知坏形态"，
//   而 AST class sink 溯源是"不在允许形态内一律红"——两者的不变量强度不是一个量级。
//   把这些根类并进来之后，`class="u-pri ${随便什么}"` 这类新形态旁路也会被溯源层抓住，
//   文本正则退居**快速失败层**（先报一条读得懂的错，不必等溯源报）。
const SECONDARY_ROOT_RE = /(?<![\w-])(?:u-notify-badge|u-type-tag|u-pri|val-badge|si-release-badge|si-dev-status-badge|pf-recip-status)(?![\w-])/;
// sink 判定用的"沾徽章体系"根集合：主状态族 ∪ 次级族。
const BADGE_ANY_ROOT_RE = new RegExp(`${BADGE_ROOT_RE.source}|${SECONDARY_ROOT_RE.source}`);
// 「徽章标记」= 一个 class 片段只要带上它就会沾到徽章样式体系：根类本身，或语义层前缀。
const BADGE_MARKER_RES = [BADGE_ROOT_RE, /(?<![\w-])sem-[a-z]/];
// 骨架里代表"此处内容静态不可知"的占位符（选私用区字符，绝不会与真实 class 片段撞，也不是 NUL）
const UNKNOWN_CHUNK = '￿';

// 把一个"最终是一段 HTML/类名字符串"的表达式**摊平成有序的 parts**（文本片 / 动态片）。
//   〔B1〕模板串与**字符串拼接**在这里被统一：`'<div class="' + cls + '">'` 和
//   `` `<div class="${cls}">` `` 摊平后是同一串 parts，class 属性扫描因此对两种写法一视同仁。
//   旧版只扫 TemplateLiteral，于是"用 + 拼 HTML 再塞进 innerHTML"这条路整条不在视野内。
// 〔S4-fix5·B1-M〕按**词法 binding**把 callee 解析到它真正指向的本地函数。
//   原来是拿函数名去全 AST 搜同名 FunctionDeclaration —— 那是"按名字"而不是"按绑定"在推理：
//   一个同名的局部参数 / 局部变量把外层函数遮蔽掉时，全 AST 搜索照样搜到外层那个，
//   于是投影出一个**运行时根本不会被调用**的函数的返回值，结论张冠李戴。
//   eslint-scope 的 resolved.defs 直接给出"这个引用绑到了哪个声明"，同名遮蔽天然分得开。
function resolveLocalFunction(callee, ctx) {
    if (!callee || callee.type !== 'Identifier') return null;
    if (!ctx || !ctx.scopeIndex || !ctx.scopeIndex.ok) return null;
    const ref = ctx.scopeIndex.refByIdentifier.get(callee);
    if (!ref || !ref.resolved) return null;
    const defs = ref.resolved.defs || [];
    if (defs.length !== 1) return null;                       // 多处定义 = 运行时取哪个是赌
    const d = defs[0];
    // 〔S4-fix6〕**绑定写引用检查**：绑定本身可变的话，"声明处那个函数体"未必是调用时执行的那个。
    //   `let h = () => 'safe'; h = () => '<span class="u-status-badge …';` —— 投影声明处的函数体
    //   会读到一个干干净净的 'safe'，而运行时跑的是第二个。这类"按声明推断行为"的错误
    //   与按名字解析同源：都是拿一个**看起来对**的绑定替代了真正生效的那个。
    //   规则：函数声明不许有任何写引用；函数变量只许有"声明初始化"这一次写入且右值就是该函数体。
    //   不满足就放弃投影 —— 放弃后该调用会落进"未解析片段"，由 fail-closed 与 computed 兜底。
    const writeRefs = (ref.resolved.references || []).filter((r) => r.isWrite());
    if (d.type === 'FunctionName' && d.node && d.node.type === 'FunctionDeclaration') {
        if (writeRefs.length > 0) return null;                // 函数声明后又被赋值覆盖
        return d.node;
    }
    // `const f = function(){}` / `const f = () => {}`
    if (d.type === 'Variable' && d.node && d.node.type === 'VariableDeclarator' && d.node.init
        && (d.node.init.type === 'FunctionExpression' || d.node.init.type === 'ArrowFunctionExpression')) {
        if (writeRefs.length !== 1) return null;              // 除声明初始化外还有别的赋值
        if (writeRefs[0].writeExpr !== d.node.init) return null;
        return d.node.init;
    }
    return null;
}

// 〔B1·S4-fix3〕摊平时**把能静态定值的动态片就地还原成文本**。
//   要堵的缺口：`const prefix = '<span class="u-status-badge ';  el.innerHTML = prefix + x + '">';`
//   —— 不还原 prefix，摊平结果里根本没有 `class=` 这几个字，扫描器扫不出任何 sink，
//   一条真在写徽章 class 的通道就此**完全隐形**（比判错更糟：是压根没看见）。
//
//   ⚠️ 实现选型（第一版走了弯路，记在这里免得后人重蹈）：最初做的是"枚举全部可能序列"，
//   遇到三元就分叉、拼接就叉乘。真实页面里一条大模板动辄十几个插值、其中好几个是三元，
//   组合数瞬间过万，只能截断——而截断意味着"有些可能性没参与判定"，只好判红，
//   于是**七个正常页面全红**。根因是那个设计在解一个它不需要解的问题：
//   我们要的只是"把藏在变量里的静态文本还原出来"，不是"枚举这段模板的所有产物"。
//   改为：**只还原能唯一定值的静态串**，定不了就原样保留为动态片交给下游判据（骨架法/标记可达性
//   本来就会枚举全部写入来源）。零组合爆炸、零截断、检出能力不减。
const STATIC_RESOLVE_DEPTH = 6;
function staticStringOf(expr, ctx, depth, seen) {
    if (!expr || depth > STATIC_RESOLVE_DEPTH) return null;
    switch (expr.type) {
        case 'Literal':
            return typeof expr.value === 'string' ? expr.value : null;
        case 'TemplateLiteral': {
            let acc = '';
            for (let i = 0; i < expr.quasis.length; i++) {
                const q = expr.quasis[i];
                acc += q.value.cooked != null ? q.value.cooked : q.value.raw;
                if (i < expr.expressions.length) {
                    const sub = staticStringOf(expr.expressions[i], ctx, depth + 1, seen);
                    if (sub === null) return null;
                    acc += sub;
                }
            }
            return acc;
        }
        case 'BinaryExpression': {
            if (expr.operator !== '+') return null;
            const l = staticStringOf(expr.left, ctx, depth + 1, seen);
            if (l === null) return null;
            const r = staticStringOf(expr.right, ctx, depth + 1, seen);
            return r === null ? null : l + r;
        }
        case 'Identifier': {
            if (!ctx || !ctx.scopeIndex) return null;
            const b = resolveValueSources(expr, ctx);
            // 只认"唯一一次赋值且该值静态可定"的变量——多次赋值/取不到右值一律不还原，
            //   留给下游按"全部写入来源"去判（那条路本来就枚举得全）。
            if (b.kind !== 'writes' || b.unknownWrites > 0 || b.writes.length !== 1) return null;
            const visited = seen || new Set();
            if (visited.has(b.variable)) return null;     // 赋值环
            visited.add(b.variable);
            const t = staticStringOf(b.writes[0], ctx, depth + 1, visited);
            visited.delete(b.variable);
            return t;
        }
        case 'MemberExpression': {
            // 〔S4-fix4·B1〕静态成员投影：`HTML.badgeStart` —— 把 HTML 片段收进一个（通常 frozen 的）
            //   常量对象再取字段，是很自然的写法；不投影的话 `class=` 又一次藏进了守卫看不见的地方。
            if (expr.computed || !expr.object || expr.object.type !== 'Identifier') return null;
            const key = keyNameOf(expr.property);
            if (key === null || !ctx || !ctx.scopeIndex) return null;
            const holder = resolveValueSources(expr.object, ctx);
            if (holder.kind !== 'writes' || holder.unknownWrites > 0 || holder.writes.length !== 1) return null;
            const obj = unwrapFreeze(holder.writes[0]);
            if (!obj || obj.type !== 'ObjectExpression') return null;
            const hits = obj.properties.filter((p) => p.type === 'Property' && !p.computed && keyNameOf(p.key) === key);
            if (hits.length !== 1) return null;
            return staticStringOf(hits[0].value, ctx, depth + 1, seen);
        }
        case 'CallExpression': {
            // 本地 helper：**全部 return 都解析成同一个静态串**才投影。
            //   不再限制"必须无参"——参数不影响结果时（所有 return 都是同一个常量串）照样可定值；
            //   反过来只要有一条 return 定不了或两条不一致，就整体放弃，不猜。
            const fn = resolveLocalFunction(expr.callee, ctx);
            if (!fn) return null;
            const visited2 = seen || new Set();
            if (visited2.has(fn)) return null;
            visited2.add(fn);
            const rets = returnStatementsOf(fn);
            let only = null;
            let ok = rets.length > 0;
            for (const r of rets) {
                const t = r.argument ? staticStringOf(r.argument, ctx, depth + 1, visited2) : null;
                if (t === null || (only !== null && only !== t)) { ok = false; break; }
                only = t;
            }
            visited2.delete(fn);
            return ok ? only : null;
        }
        default:
            return null;
    }
}

// 把一个"最终是一段 HTML/类名字符串"的表达式摊平成有序 parts（文本片 / 动态片）。
//   传了 ctx（含作用域索引）时，动态片会先试着静态还原成文本片。
function expressionToParts(expr, out, ctx, structural, unresolved) {
    const parts = out || [];
    if (!expr) return parts;
    // structural：本次摊平**真正走过的结构节点**（拼接链与模板本身）。
    //   〔S4-fix4〕消费面只能覆盖这些——原来是把整个子树标为已消费，于是
    //   `tbody.innerHTML = list.map(it => \`…<span class="u-status-badge …">…\`)` 这种写法里，
    //   回调**体内**的模板被连坐标成已消费，第四遍就不再扫它了：真正带徽章 class 的那段
    //   反而因为"外层是个函数调用"而整段进不了视野。动态片的子树留给后续各遍自己处理。
    if (structural) structural.add(expr);
    if (expr.type === 'Literal' && typeof expr.value === 'string') { parts.push({ t: 'text', v: expr.value }); return parts; }
    if (expr.type === 'TemplateLiteral') {
        expr.quasis.forEach((q, i) => {
            parts.push({ t: 'text', v: q.value.cooked != null ? q.value.cooked : q.value.raw });
            if (i < expr.expressions.length) expressionToParts(expr.expressions[i], parts, ctx, structural, unresolved);
        });
        return parts;
    }
    if (expr.type === 'BinaryExpression' && expr.operator === '+') {
        expressionToParts(expr.left, parts, ctx, structural, unresolved);
        expressionToParts(expr.right, parts, ctx, structural, unresolved);
        return parts;
    }
    if (ctx && ctx.scopeIndex) {
        const t = staticStringOf(expr, ctx, 0, null);
        if (t !== null) { parts.push({ t: 'text', v: t }); return parts; }
        // 静态还原不了的片段单独记名：fail-closed 取证要**逐个片段**做，
        //   不能因为"整条表达式里别处还有别的 class 属性"就跳过这一个（B1·S4-fix5）。
        if (unresolved) unresolved.push(expr);
    }
    parts.push({ t: 'expr', node: expr });
    return parts;
}

// 〔S4-fix4·B1 fail-closed 的取证面〕只沿 staticStringOf 认得的那几种节点浅层收集字面量。
//   为什么不能用 reachableStringLiterals（全子树walk）：`innerHTML = list.map(cb)` 的子树里
//   必然含大量 `class=` 文本，用全子树取证会让**每一处 innerHTML 都触发 fail-closed**，
//   一次产出上百条假红。这里要回答的问题很窄：**这个静态还原不出来的片段本身**，
//   是不是藏着 class= 或徽章类名。
//   深度上限 12：实测链路会比直觉长——`innerHTML = helper(x)` 取证要走
//   调用(1)→return(2)→拼接(3)→拼接(4)→成员(5)→标识符(6)→`Object.freeze(...)` 调用(7)→
//   对象字面量(8)→属性值(9)，深度 5 会在够到那个字面量之前就停（实测就是这么漏的）。
//   环由 visited 按绑定/函数身份挡住，深度只是防病态嵌套，给足即可。
const SHALLOW_LIT_DEPTH = 12;
function shallowReachableLiterals(expr, ctx, depth, seen, out) {
    if (!expr || depth > SHALLOW_LIT_DEPTH) return out;
    const visited = seen || new Set();
    switch (expr.type) {
        case 'Literal':
            if (typeof expr.value === 'string') out.push({ text: expr.value, fromTemplate: false });
            return out;
        case 'TemplateLiteral':
            for (const q of expr.quasis) out.push({ text: q.value.cooked != null ? q.value.cooked : q.value.raw, fromTemplate: true });
            for (const e of expr.expressions) shallowReachableLiterals(e, ctx, depth + 1, visited, out);
            return out;
        case 'BinaryExpression':
            if (expr.operator !== '+') return out;
            shallowReachableLiterals(expr.left, ctx, depth + 1, visited, out);
            shallowReachableLiterals(expr.right, ctx, depth + 1, visited, out);
            return out;
        case 'ConditionalExpression':
            shallowReachableLiterals(expr.consequent, ctx, depth + 1, visited, out);
            shallowReachableLiterals(expr.alternate, ctx, depth + 1, visited, out);
            return out;
        case 'LogicalExpression':
            shallowReachableLiterals(expr.left, ctx, depth + 1, visited, out);
            shallowReachableLiterals(expr.right, ctx, depth + 1, visited, out);
            return out;
        case 'ObjectExpression':
            for (const p of expr.properties) if (p.type === 'Property') shallowReachableLiterals(p.value, ctx, depth + 1, visited, out);
            return out;
        case 'Identifier': {
            if (!ctx || !ctx.scopeIndex) return out;
            const b = resolveValueSources(expr, ctx);
            if (b.kind !== 'writes') return out;
            if (visited.has(b.variable)) return out;
            visited.add(b.variable);
            for (const w of b.writes) shallowReachableLiterals(w, ctx, depth + 1, visited, out);
            return out;
        }
        case 'MemberExpression':
            // 取不到具体字段时，把宿主对象里的字面量都收进来（`FROZEN_HTML.badgeStart` 这一类）
            if (!expr.computed && expr.object && expr.object.type === 'Identifier') {
                shallowReachableLiterals(expr.object, ctx, depth + 1, visited, out);
            }
            return out;
        case 'CallExpression': {
            // 〔S4-fix5·B1〕受限追踪调用：实参 + 本地函数的可达 return 表达式。
            //   带参 helper 的返回值定不了值（staticStringOf 会放弃），但"它里面写没写徽章类名"
            //   是能看的——取证面和定值面本就该分开：定不了值不等于看不见线索。
            for (const a of expr.arguments) shallowReachableLiterals(a, ctx, depth + 1, visited, out);
            const fn = resolveLocalFunction(expr.callee, ctx);
            if (!fn || visited.has(fn)) return out;
            visited.add(fn);
            for (const r of returnStatementsOf(fn)) {
                if (r.argument) shallowReachableLiterals(r.argument, ctx, depth + 1, visited, out);
            }
            return out;
        }
        default:
            return out;
    }
}

// 在 parts 序列上扫 class 属性 sink。支持三种属性值写法：
//   双引号 / 单引号 / **无引号**（`class=${x}` 或 `class=` 后紧跟动态片——HTML 允许无引号属性值，
//   旧版正则要求 `class=` 后必须是引号，这类写法整条漏掉）。
function classAttrSinksFromParts(parts) {
    const sinks = [];
    let cur = null;
    const closeCur = () => { if (cur) { sinks.push(cur); cur = null; } };
    for (let pi = 0; pi < parts.length; pi++) {
        const p = parts[pi];
        if (p.t === 'text') {
            let s = p.v;
            for (;;) {
                if (!cur) {
                    const m = s.match(/(?<![\w-])class\s*=\s*(["']?)/i);
                    if (!m) break;
                    cur = { staticText: '', exprs: [], parts: [], quote: m[1] || null };
                    s = s.slice(m.index + m[0].length);
                    if (cur.quote === null) {
                        // 无引号：值到第一个空白 / `>` 为止
                        const stop = s.search(/[\s>]/);
                        if (stop !== -1) {
                            cur.staticText += s.slice(0, stop);
                            cur.parts.push({ t: 'text', v: s.slice(0, stop) });
                            closeCur();
                            s = s.slice(stop);
                            continue;
                        }
                        cur.staticText += s;
                        cur.parts.push({ t: 'text', v: s });
                        break;   // 值延续到下一个 part（多半就是那个动态片）
                    }
                } else if (cur.quote === null) {
                    const stop = s.search(/[\s>]/);
                    const take = stop === -1 ? s : s.slice(0, stop);
                    cur.staticText += take;
                    cur.parts.push({ t: 'text', v: take });
                    if (stop === -1) break;
                    closeCur();
                    s = s.slice(stop);
                } else {
                    const idx = s.indexOf(cur.quote);
                    if (idx === -1) { cur.staticText += s; cur.parts.push({ t: 'text', v: s }); break; }
                    cur.staticText += s.slice(0, idx);
                    cur.parts.push({ t: 'text', v: s.slice(0, idx) });
                    closeCur();
                    s = s.slice(idx + 1);
                }
            }
        } else if (cur) {
            cur.exprs.push({ node: p.node, prefix: cur.staticText });
            cur.parts.push({ t: 'expr', node: p.node });
        }
    }
    closeCur();
    return sinks;
}

// 兼容旧调用点：模板字面量 → parts → class 属性 sink
function classAttrSinksInTemplate(tpl) {
    return classAttrSinksFromParts(expressionToParts(tpl));
}

// 收集本源里**全部** class sink（S4-fix MED-1 起完整采集；S4-fix2 B1 再扩通道）。
//   通道清单（每一条都对应一种真实存在的"把类名写进 DOM"的路子）：
//     · 模板串 / **字符串拼接**里的 class 属性（含无引号写法）
//     · `.innerHTML` / `.outerHTML` 赋值、`insertAdjacentHTML(pos, html)` 里的 HTML 字符串
//     · `.className =` / `el['className'] =`（计算成员形态）
//     · `setAttribute('class', …)`
//     · `classList.add/toggle/replace(…)` —— **实参可以是变量**
//   每个 sink 标注 isBadge（静态文本/表达式源码是否已带根类），两类走不同判据：
//     · isBadge=true  → 六形态溯源（片段必须来自 gate/白名单）
//     · isBadge=false → 徽章标记可达性判定
function collectBadgeClassSinks(ast, src, ctx) {
    const sinks = [];
    const scopeCtx = ctx || {};
    const consumed = new Set();          // 已被更大表达式吃掉的节点，避免同一段代码重复计
    const markConsumed = (node) => { walkAst(node, (n) => consumed.add(n)); };
    const srcOf = (n) => src.slice(n.start, n.end);

    // 一段"会变成 HTML 的字符串表达式" → 摊平 → 扫 class 属性
    const seenKeys = new Set();
    // 〔S4-fix4·B1 fail-closed〕摊平后**一个 class 属性都没扫出来**，但表达式里可达的字面量
    //   却含 `class=` 或徽章标记 —— 说明 `class=` 藏在某个静态还原不了的地方（跨函数返回值、
    //   参数传进来的片段…）。这种"看见了线索却读不出结构"的情况必须生成 sink 交给判据，
    //   而不是像原来那样静默地什么都不产出（零 sink = 一路绿灯，正是最糟的失败形态）。
    //   判据 = **浅层可达字面量里直接写着徽章类名**（`u-status-badge` / `sem-x`）。
    //   ⚠️ 试过、否掉的两个更宽判据（实测数据在此，免得后人再走一遍）：
    //     ① "字面量含 class=" —— 每一段 HTML 都含，一次产出 15 条假红；
    //     ② "字面量含**没闭合的** class 属性" —— 看着精确，其实同样不可用：
    //        模板串的 quasi 天然就是半截的（`` `<span class="category-badge ${x}">` `` 会切成
    //        `<span class="category-badge ` 和 `">` 两段），孤立地看每一段都"没闭合"。
    //        app.js 里这样的 quasi 有 8 处，全是正常模板，全会被误判。
    //   徽章类名不同：它出现在字面量里就是**明确信号**，没有这种结构性歧义。
    const pushFailClosedSink = (frag, desc) => {
        const lits = shallowReachableLiterals(frag, scopeCtx, 0, null, []);
        // 只认**普通字符串字面量**里的徽章类名，不认模板 quasi 里的。
        //   区别在于"扫描器还看不看得见它"：模板串会被第四遍单独扫到（它的 class 属性照常判据齐全），
        //   而写在对象字段/普通字符串常量里的 HTML 片段没有任何一遍会去扫 —— 那才是真盲区。
        //   `FROZEN_HTML.badgeStart = '<span class="u-status-badge '` 正属后者。
        const hinted = lits.some((l) => !l.fromTemplate && hasBadgeMarker(l.text));
        if (!hinted) return;
        const key = `${desc}|FAILCLOSED|${frag.start}-${frag.end}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        sinks.push({
            desc: `${desc}（片段静态还原不出·fail-closed）`,
            isBadge: lits.some((l) => hasBadgeMarker(l.text)),
            staticText: '',
            exprs: [{ node: frag, prefix: '' }],
        });
    };
    const pushHtmlSinks = (expr, desc, isDomRoot) => {
        if (!expr) return;
        // 〔B1〕摊平（能静态定值的动态片就地还原成文本）后扫 class 属性；
        //   同一条 sink 可能被重复扫出，按 (静态文本 + 动态片节点位置) 去重。
        // attrsSeen = 摊平后**扫出来的 class 属性总数**（含纯静态的）。
        //   fail-closed 的触发条件必须用它，不能用"带动态片的 sink 数"——一段 class 全是静态的
        //   模板本来就该产 0 个 sink，那是"没有动态片要查"，不是"读不出 class 结构"。
        //   〔S4-fix4 自查〕第一版用后者，于是每一段纯静态 HTML 模板都被当成"还原失败"，
        //   15 条假红当场撞出来。
        let attrsSeen = 0;
        const structural = new Set();
        const unresolved = [];
        for (const sk of classAttrSinksFromParts(expressionToParts(expr, null, scopeCtx, structural, unresolved))) {
            attrsSeen++;
            if (!sk.exprs.length) continue;
            const key = `${desc}|${sk.staticText}|${sk.exprs.map((e) => e.node.start + '-' + e.node.end).join(',')}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            sinks.push({
                desc, isBadge: BADGE_ANY_ROOT_RE.test(sk.staticText), staticText: sk.staticText,
                parts: sk.parts, exprs: sk.exprs,
            });
        }
        // fail-closed 只对**真实 DOM 写入根**发放（第三/四遍那种"顺手扫的拼接与模板"不发：
        //   它们常与 class 无关，且其中的模板各自还会被单独扫到）。
        // 〔S4-fix5·B1〕改**逐个未还原片段**取证：原来用整条表达式的 attrsSeen 当开关，
        //   于是 `'<div class="x">' + 藏着徽章前缀的片段` 这种混拼——只要别处还有一个正常的
        //   class 属性，整条就被跳过，藏起来的那半截连看都不看。逐片段判就没有这个盲区。
        void attrsSeen;
        if (isDomRoot) for (const frag of unresolved) pushFailClosedSink(frag, desc);
        for (const n of structural) consumed.add(n);   // 只消费走过的结构节点，不连坐动态片子树
    };

    // 一段"整体就是 class 值"的表达式（className / setAttribute / classList 实参）
    const pushClassValueSink = (valueNode, desc) => {
        if (!valueNode) return;
        sinks.push({
            desc,
            isBadge: BADGE_ANY_ROOT_RE.test(srcOf(valueNode)),
            staticText: '',
            exprs: [{ node: valueNode, prefix: '' }],
        });
        markConsumed(valueNode);
    };

    // ── 第一遍：明确的 DOM 写入点（先把它们的子树标为已消费）──────────
    walkAst(ast, (n) => {
        if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'MemberExpression' && n.left.property) {
            const prop = n.left.computed
                ? (n.left.property.type === 'Literal' ? String(n.left.property.value) : null)
                : n.left.property.name;
            if (prop === 'innerHTML' || prop === 'outerHTML') { pushHtmlSinks(n.right, `.${prop} 赋值`, true); return; }
            if (prop === 'className') { pushClassValueSink(n.right, n.left.computed ? "el['className'] 赋值" : '.className 赋值'); return; }
        }
        if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression' && n.callee.property) {
            const fn = n.callee.computed
                ? (n.callee.property.type === 'Literal' ? String(n.callee.property.value) : null)
                : n.callee.property.name;
            if (fn === 'insertAdjacentHTML' && n.arguments.length >= 2) { pushHtmlSinks(n.arguments[1], 'insertAdjacentHTML(…)', true); return; }
            if (fn === 'setAttribute' && n.arguments.length >= 2
                && n.arguments[0].type === 'Literal' && String(n.arguments[0].value).toLowerCase() === 'class') {
                pushClassValueSink(n.arguments[1], "setAttribute('class', …)");
                return;
            }
            if ((fn === 'add' || fn === 'toggle' || fn === 'replace')
                && n.callee.object && n.callee.object.type === 'MemberExpression'
                && n.callee.object.property && n.callee.object.property.name === 'classList') {
                for (const a of n.arguments) {
                    // 静态字面量且明摆着与徽章无关的（'open'/'active'…）不入网，免得把上百处无关调用拖进来
                    if (a.type === 'Literal' && typeof a.value === 'string' && !hasBadgeMarker(a.value)) continue;
                    pushClassValueSink(a, `classList.${fn}(…)`);
                }
            }
        }
    });

    // ── 第二遍：对象字面量属性 className:（mdcEl({ className: … }) 形态）──────────
    walkAst(ast, (n) => {
        if (consumed.has(n)) return;
        if (n.type === 'Property' && !n.computed && keyNameOf(n.key) === 'className') {
            pushClassValueSink(n.value, '对象属性 className:');
        }
    });

    // ── 第三遍：**顶层字符串拼接**（`'<div class="' + c + '">'` 先赋给变量再用）──────────
    //   只取"不是另一个 + 的操作数"的那一层，免得一条拼接链被拆成多段重复计。
    const plusOperands = new Set();
    walkAst(ast, (n) => {
        if (n.type === 'BinaryExpression' && n.operator === '+') {
            if (n.left.type === 'BinaryExpression' && n.left.operator === '+') plusOperands.add(n.left);
            if (n.right.type === 'BinaryExpression' && n.right.operator === '+') plusOperands.add(n.right);
        }
    });
    walkAst(ast, (n) => {
        if (n.type !== 'BinaryExpression' || n.operator !== '+') return;
        if (consumed.has(n) || plusOperands.has(n)) return;
        pushHtmlSinks(n, '字符串拼接');
    });

    // ── 第四遍：其余独立模板串 ──────────
    walkAst(ast, (n) => {
        if (n.type !== 'TemplateLiteral' || consumed.has(n)) return;
        pushHtmlSinks(n, '模板 class 属性');
    });

    return sinks;
}

// ── 非徽章 sink 的判据：徽章标记「可达性」──────────
//   本页登记的片段全集（gate / frozen map 的可能返回值），用于把 gate 调用当成有界取值来判。
function fragmentValuesOf(spec) {
    if (spec.mode === 'sem') return [...new Set(Object.values(spec.expectStatuses || {}))];
    return [...new Set(Object.keys(spec.tiers || {})
        .map((k) => spec.selector(k).replace(/^\.u-status-badge\./, '').replace(/^\./, '')))];
}

// 求表达式**可能产出的字符串骨架集合**（静态可知部分照抄，不可知部分用占位符）。
//   返回 { skeletons, unbounded, truncated }：
//     unbounded = 跟不动的节点数（报告透明度用）；
//     truncated = 组合数撞到上限、集合被截断。〔B3〕**截断必须显式冒泡出去**——
//       被截掉的那部分里可能恰好就有带徽章标记的组合，静默截断等于"没看见"当"没问题"，
//       是最典型的假绿形态。调用方拿到 truncated 一律判红，逼人来看这段表达式为什么这么复杂。
const SKELETON_CAP = 48;
function possibleSkeletons(expr, ctx, depth) {
    const bail = () => ({ skeletons: [UNKNOWN_CHUNK], unbounded: 1, truncated: false });
    if (!expr || depth > 6) return { skeletons: [UNKNOWN_CHUNK], unbounded: 1, truncated: true };
    let cut = false;
    const cross = (a, b) => {
        const out = [];
        for (const x of a) for (const y of b) {
            if (out.length >= SKELETON_CAP) { cut = true; return out; }
            out.push(x + y);
        }
        return out;
    };
    const union = (a, b) => {
        const out = [...a, ...b];
        if (out.length > SKELETON_CAP) { cut = true; return out.slice(0, SKELETON_CAP); }
        return out;
    };
    const done = (skeletons, unbounded, childTruncated) => ({ skeletons, unbounded, truncated: cut || childTruncated });

    switch (expr.type) {
        case 'Literal':
            return typeof expr.value === 'string'
                ? { skeletons: [expr.value], unbounded: 0, truncated: false }
                : { skeletons: [''], unbounded: 0, truncated: false };
        case 'TemplateLiteral': {
            let acc = [expr.quasis[0].value.cooked != null ? expr.quasis[0].value.cooked : expr.quasis[0].value.raw];
            let ub = 0;
            let tr = false;
            for (let i = 0; i < expr.expressions.length; i++) {
                const r = possibleSkeletons(expr.expressions[i], ctx, depth + 1);
                ub += r.unbounded; tr = tr || r.truncated;
                const q = expr.quasis[i + 1];
                acc = cross(cross(acc, r.skeletons), [q.value.cooked != null ? q.value.cooked : q.value.raw]);
            }
            return done(acc, ub, tr);
        }
        case 'BinaryExpression': {
            if (expr.operator !== '+') return bail();
            const l = possibleSkeletons(expr.left, ctx, depth + 1);
            const r = possibleSkeletons(expr.right, ctx, depth + 1);
            return done(cross(l.skeletons, r.skeletons), l.unbounded + r.unbounded, l.truncated || r.truncated);
        }
        case 'ConditionalExpression': {
            const c = possibleSkeletons(expr.consequent, ctx, depth + 1);
            const a = possibleSkeletons(expr.alternate, ctx, depth + 1);
            return done(union(c.skeletons, a.skeletons), c.unbounded + a.unbounded, c.truncated || a.truncated);
        }
        case 'LogicalExpression': {
            const l = possibleSkeletons(expr.left, ctx, depth + 1);
            const r = possibleSkeletons(expr.right, ctx, depth + 1);
            return done(union(l.skeletons, r.skeletons), l.unbounded + r.unbounded, l.truncated || r.truncated);
        }
        case 'Identifier': {
            // 〔B2〕枚举该绑定的**全部写入右值**，不只初始化器
            const b = resolveValueSources(expr, ctx);
            if (b.kind !== 'writes') return bail();
            if (b.unknownWrites > 0) return bail();     // 有取不到右值的写形态 → 不可穷举
            if (!b.writes.length) return bail();        // 声明了但从未赋值
            let out = [];
            let ub = 0;
            let tr = false;
            for (const w of b.writes) {
                const r = possibleSkeletons(w, ctx, depth + 1);
                ub += r.unbounded; tr = tr || r.truncated;
                out = union(out, r.skeletons);
            }
            return done(out.length ? out : [UNKNOWN_CHUNK], ub, tr);
        }
        case 'CallExpression': {
            const name = calleeNameOf(expr.callee);
            // gate 调用是**有界**的：返回值只可能是该 gate 自己登记的片段（外加空串降级）。
            //   ⚠️〔S5a-fix2 自查〕这里原来一律代入**本页状态族**的 fragmentValues。M5 把次级族 gate
            //   并进 gateNames 之后，这个近似当场出错：`mwPriClass()` 被当成可能返回 `sem-wait`，
            //   于是"非徽章 sink 里出现徽章标记"红了一片——**是模型不对，不是页面有问题**。
            //   改为按 gate 名查它自己的片段集（gateFragments），查不到才退回本页状态族。
            if (name && ctx.gateNames.has(name)) {
                const own = (ctx.gateFragments && ctx.gateFragments[name]) || ctx.fragmentValues;
                return { skeletons: [...own, ''], unbounded: 0, truncated: false };
            }
            return bail();
        }
        case 'MemberExpression': {
            if (expr.object.type === 'Identifier' && ctx.mapConst && expr.object.name === ctx.mapConst) {
                return { skeletons: [...ctx.fragmentValues], unbounded: 0, truncated: false };
            }
            return bail();
        }
        default:
            return bail();
    }
}

// 子树里**可达的全部字符串字面量**（含模板 quasi）：骨架法跟不动的地方（非 gate 调用的实参、
//   任意成员表达式的下游）仍可能藏着写死的徽章类名，这一层把它们捞出来。
function reachableStringLiterals(expr, ctx, depth, seen) {
    const out = [];
    if (!expr || depth > 6) return out;
    walkAst(expr, (n) => {
        if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value);
        else if (n.type === 'TemplateElement') out.push(n.value.cooked != null ? n.value.cooked : n.value.raw);
        else if (n.type === 'Identifier') {
            const b = resolveValueSources(n, ctx);
            if (b.kind !== 'writes') return;
            // 按**绑定身份**去重（不是按名字）——同名不同绑定要各自展开，同一绑定只展开一次防环
            if (seen.has(b.variable)) return;
            seen.add(b.variable);
            // 〔B2〕跟全部写入右值，不只初始化器
            for (const w of b.writes) out.push(...reachableStringLiterals(w, ctx, depth + 1, seen));
        }
    });
    return out;
}

function hasBadgeMarker(text) {
    return BADGE_MARKER_RES.some((re) => re.test(text));
}

// 非徽章 sink 判定：证明它**不可能**产出带徽章标记的 class。
function nonBadgeSinkVerdict(sink, ctx) {
    const problems = [];
    let unbounded = 0;
    // ① 逐动态片段：骨架集合 + 可达字面量，任一带徽章标记即红
    for (const e of sink.exprs) {
        const sk = possibleSkeletons(e.node, ctx, 0);
        unbounded += sk.unbounded;
        // 〔B3〕组合被截断 = 有一部分可能取值根本没参与判定，等同"没看见"，不能当"没问题"
        if (sk.truncated) problems.push(`可能取值集合超出上限 ${SKELETON_CAP} 被截断，无法穷举判定（请拆简这段表达式或改走 gate）`);
        const dirty = sk.skeletons.filter(hasBadgeMarker);
        if (dirty.length) problems.push(`可能产出带徽章标记的值：${JSON.stringify(dirty[0])}`);
        const lits = reachableStringLiterals(e.node, ctx, 0, new Set()).filter(hasBadgeMarker);
        if (lits.length) problems.push(`可达字面量里写着徽章类名：${JSON.stringify(lits[0])}`);
    }
    // ② 整条 class 属性的骨架：防"静态文本 + 动态片段拼出标记"（如 `class="u-status-${'badge'}"`）
    if (sink.parts) {
        let acc = [''];
        for (const p of sink.parts) {
            const next = p.t === 'text' ? [p.v] : possibleSkeletons(p.node, ctx, 0).skeletons;
            const merged = [];
            for (const x of acc) for (const y of next) { if (merged.length < SKELETON_CAP) merged.push(x + y); }
            acc = merged;
        }
        const dirty = acc.filter(hasBadgeMarker);
        if (dirty.length) problems.push(`整条 class 属性可拼出徽章标记：${JSON.stringify(dirty[0].slice(0, 60))}`);
    }
    return { problems: [...new Set(problems)], unbounded };
}

// 守门三元：`WHITELIST.includes(v) ? v : '默认值'`——gate 在这里当**判据**用（不产出片段，
//   而是证明 v 已在白名单内）。Issue_Lite 就是这个范式，不认它会造出一条纯粹的假红。
//   〔B5〕守门谓词**只认显式登记的形态**（spec.predicateGate），不再从 renderGate 名自动推导。
//   自动推导的洞：renderGate 里装的是"渲染 gate"，其中任何一个被写进三元的 test 位就当成了守门，
//   于是 `taskStatusBadge(s) ? s : ''` 这种**根本不做成员判定**的写法会被认成"已守门"，
//   而它返回的是一段 HTML、真值恒成立，等于把原值直接放行。
//   登记的形态各自附「为什么这是合格守门」的论证，加形态必须同步论证：
//     · includes     —— `WL.includes(x) ? x : 默认`，数组成员测试，非成员必落默认分支
//     · hasOwnProperty—— `Object.prototype.hasOwnProperty.call(WL, x) ? … : …`，键存在性测试
//   〔S4-fix3·B5〕**memberTruthy 形态已删除，不再是合格守门**：`WL[x] ? x : 默认` 读的是对象取值，
//   会走**原型链**——`'constructor'`/`'toString'`/`'__proto__'` 拿到继承来的函数（真值），
//   于是这些名字被原样放行成 class 片段。此前把它当"偏差方向安全"是**只看了值为假的那一侧**，
//   漏了原型链这一侧；Data_Correction 的 statusClass 已同步改为 hasOwnProperty，运行时缺口一并堵上。
function guardPredicateMatches(testNode, consequent, ctx) {
    for (const g of ctx.predicateGates || []) {
        if (g.form === 'includes') {
            if (testNode.type !== 'CallExpression') continue;
            if (calleeNameOf(testNode.callee) !== `${g.const}.includes`) continue;
            if (testNode.arguments.length !== 1) continue;
            if (!astEqual(consequent, testNode.arguments[0])) continue;
            return true;
        }
        if (g.form === 'hasOwnProperty') {
            if (testNode.type !== 'CallExpression') continue;
            const src = testNode.callee;
            const isHop = src && src.type === 'MemberExpression' && !src.computed
                && src.property && src.property.name === 'call'
                && src.object && src.object.type === 'MemberExpression'
                && src.object.property && src.object.property.name === 'hasOwnProperty';
            if (!isHop) continue;
            if (testNode.arguments.length !== 2) continue;
            if (testNode.arguments[0].type !== 'Identifier' || testNode.arguments[0].name !== g.const) continue;
            if (!astEqual(consequent, testNode.arguments[1])) continue;
            return true;
        }
    }
    return false;
}

function isGuardedConditional(expr, ctx) {
    if (!guardPredicateMatches(expr.test, expr.consequent, ctx)) return false;
    if (expr.alternate.type !== 'Literal' || typeof expr.alternate.value !== 'string') return false;
    if (ctx.literalMustBeKey && !ctx.keys.has(expr.alternate.value)) return false;
    return true;
}

function sinkProvenance(expr, ctx, depth) {
    if (!expr) return { ok: false, why: '空表达式' };
    if (depth > 8) return { ok: false, why: '溯源深度超限（疑似循环引用）' };
    switch (expr.type) {
        case 'Literal':
            if (typeof expr.value !== 'string') return { ok: false, why: `字面量 ${JSON.stringify(expr.value)} 不是字符串` };
            if (ctx.literalMustBeKey && !ctx.keys.has(expr.value)) {
                return { ok: false, why: `字面量 '${expr.value}' 不在登记状态集内（该位置产出的就是 class 片段本身，拼错会静默落 fallback）` };
            }
            return { ok: true };
        case 'TemplateLiteral': {
            for (const e of expr.expressions) {
                const r = sinkProvenance(e, ctx, depth + 1);
                if (!r.ok) return r;
            }
            return { ok: true };
        }
        case 'CallExpression': {
            const name = calleeNameOf(expr.callee);
            if (name && ctx.gateNames.has(name)) return { ok: true };
            return { ok: false, why: `调用 \`${name || '(动态 callee)'}\` 不是本页登记的 gate（登记：${[...ctx.gateNames].join(' / ') || '无'}）` };
        }
        case 'MemberExpression': {
            const whitelist = [ctx.mapConst, ...(ctx.extraWhitelistConsts || [])].filter(Boolean);
            if (!expr.computed && expr.object.type === 'Identifier' && whitelist.includes(expr.object.name)) {
                const prop = keyNameOf(expr.property);
                if (prop && ctx.keys.has(prop)) return { ok: true };
                return { ok: false, why: `${expr.object.name}.${prop || '(动态键)'} 的键不在登记状态集内` };
            }
            // 计算成员（`MAP[x]`）：宿主是登记白名单常量即可 —— 取哪个键由运行时定，
            //   但值域被 map 的字面量框死，与非计算取值同样有界。
            if (expr.computed && expr.object.type === 'Identifier' && whitelist.includes(expr.object.name)) return { ok: true };
            // `v.cls` 形态：object 本身若能被证明来自白名单 map，从它上面静态读一个字段也是有界的
            //   （Data_Collab 的 `const v = SQL_VALIDATION_LABELS[x]; … ${v.cls}` 正是这一形态）。
            if (!expr.computed && expr.object) {
                const sub = sinkProvenance(expr.object, ctx, depth + 1);
                if (sub.ok) return { ok: true };
            }
            return { ok: false, why: `成员取值不是 frozen 白名单 ${whitelist.join('/') || '(本页未登记 map)'} 的静态键取值` };
        }
        case 'Identifier': {
            const b = resolveValueSources(expr, ctx);
            if (b.kind !== 'writes') return { ok: false, why: b.why || `\`${expr.name}\` 无法解析到绑定` };
            if (b.unknownWrites > 0) {
                return { ok: false, why: `\`${expr.name}\` 有 ${b.unknownWrites} 处取不到右值的写入（for-of 每轮绑定 / 解构赋值 / 自增），取值不可穷举` };
            }
            if (!b.writes.length) return { ok: false, why: `\`${expr.name}\` 声明后从未被赋值` };
            // 〔B2〕**每一处**写入的右值都要合规——只验初始化器的话，
            //   `let c = ''; c = 'u-status-badge …';` 会读到一个干净的空串而放行
            for (const w of b.writes) {
                const sub = sinkProvenance(w, ctx, depth + 1);
                if (!sub.ok) return { ok: false, why: `\`${expr.name}\` 的某次赋值不合规 → ${sub.why}` };
            }
            return { ok: true };
        }
        case 'ConditionalExpression': {
            if (isGuardedConditional(expr, ctx)) return { ok: true };
            const c = sinkProvenance(expr.consequent, ctx, depth + 1);
            if (!c.ok) return { ok: false, why: `三元 consequent → ${c.why}` };
            const a = sinkProvenance(expr.alternate, ctx, depth + 1);
            if (!a.ok) return { ok: false, why: `三元 alternate → ${a.why}` };
            return { ok: true };
        }
        case 'LogicalExpression': {
            const l = sinkProvenance(expr.left, ctx, depth + 1);
            if (!l.ok) return { ok: false, why: `\`${expr.operator}\` 左侧 → ${l.why}` };
            const r = sinkProvenance(expr.right, ctx, depth + 1);
            if (!r.ok) return { ok: false, why: `\`${expr.operator}\` 右侧 → ${r.why}` };
            return { ok: true };
        }
        case 'BinaryExpression': {
            if (expr.operator !== '+') return { ok: false, why: `运算符 \`${expr.operator}\` 的结果无法静态判定` };
            const l = sinkProvenance(expr.left, ctx, depth + 1);
            if (!l.ok) return { ok: false, why: `拼接左侧 → ${l.why}` };
            const r = sinkProvenance(expr.right, ctx, depth + 1);
            if (!r.ok) return { ok: false, why: `拼接右侧 → ${r.why}` };
            return { ok: true };
        }
        default:
            return { ok: false, why: `${expr.type} 形态不在允许的溯源形态内` };
    }
}

// ── 〔S5a-fix3 项 2〕extraWhitelistConsts 的结构证明 ──────────
//   缺口：上批把 SQL_VALIDATION_LABELS / SI_EXEC_SUMMARY_CLS 等登记成"白名单常量"后，
//   `MAP[x]` 与 `v.cls` 就被无条件放行了 —— 而"它是个白名单"这句话当时**没有任何断言背书**。
//   把那个常量改成函数返回值、往值里塞个变量、或者多声明一处，放行照旧。
//   本节给每个登记常量做与 mapConst 同级的结构校验，**只有通过的才进白名单**；
//   没通过的常量，其 computed member 会退回"成员取值不是白名单"的红灯。
//   五问：声明恰一处 / 是对象字面量 / 无重复键 / 值域与登记全等 / freeze 现状与登记一致。
const WHITELIST_CONST_SHAPES = Object.freeze({
    stringValues: 'stringValues',   // 值直接是 class 片段字符串
    objectValues: 'objectValues',   // 值是对象，class 片段在某个字段上（如 { text, cls } 的 cls）
});

function assertWhitelistConstStructure(check, spec, sources) {
    const decls = spec.extraWhitelistConsts || [];
    const validated = [];
    for (const d of decls) {
        const host = findConstHost(sources, d.name);
        if (!host.ok) {
            check(false, `${spec.file}：白名单常量 ${d.name} 声明恰一处`, host.why);
            continue;
        }
        // ⚠️ freeze 检测**不能**拿 findConstInitNodes 的返回值去比对：那个函数返回前已经
        //   unwrapFreeze 过了，`raw !== unwrapFreeze(raw)` 恒为 false（写第一版时踩了这个坑，
        //   而它恰是此前驳回 codex B7 时用的同一个事实——自己转头又忘了）。
        //   改用 checkFrozenObjectLiteral：它一次性验「声明恰一处 + init 精确是 Object.freeze(对象字面量)」。
        //   〔S5a-fix4 项 2〕freeze 是**无条件要求**，不再由登记里的 `frozen` 字段开关——
        //   策略本来就是"不 freeze 就不配当白名单"，一个永远只能填 true 的配置项是无效契约，
        //   留着只会让人以为存在"登记成 false 就豁免"的合法用法。字段已删。
        const fz = checkFrozenObjectLiteral(host.host.ast, d.name);
        check(fz.ok, `${spec.file}：白名单常量 ${d.name} = Object.freeze(对象字面量)，且同名常量恰一处`,
            fz.ok ? '' : `${fz.why} —— 白名单的前提是"静态可读 + 运行时也改不动"，两者缺一它就不配叫白名单`);
        if (!fz.ok) continue;
        const obj = fz.objectNode;
        const dup = duplicateKeysOf(obj);
        if (dup.length) {
            check(false, `${spec.file}：白名单常量 ${d.name} 无重复 key`, `重复：${dup.join(' | ')}`);
            continue;
        }
        const shape = d.shape === WHITELIST_CONST_SHAPES.objectValues ? 'objectValues' : 'stringValues';
        const res = shape === 'objectValues'
            ? entriesOfObjectValuedMap(obj, d.field, true)   // 〔S5a-fix4〕内层也必须 freeze
            : membersOfNode(obj, 'objectEntries');
        if (res.dynamic.length) {
            check(false, `${spec.file}：白名单常量 ${d.name} 全部成员静态可知（${shape}${d.field ? '·字段 ' + d.field : ''}）`,
                `含动态成员：${[...new Set(res.dynamic)].join(' | ')}`);
            continue;
        }
        const gotVals = [...new Set(res.members.map((x) => x[1]))].sort();
        const wantVals = (d.values || []).slice().sort();
        const valOk = wantVals.length > 0 && gotVals.join(',') === wantVals.join(',');
        check(valOk, `${spec.file}：白名单常量 ${d.name} 值域与登记一致（${wantVals.length} 个片段）`,
            valOk ? '' : `实际 [${gotVals.join(' ')}]，登记 [${wantVals.join(' ')}]`);
        if (valOk) validated.push(d.name);
    }
    return validated;
}

// ── 〔S5a-fix4 项 1〕白名单常量「后代成员写入」扫描 ──────────
//   freeze 是**运行时**保证，而它在非严格模式下失败是**静默的**（赋值不生效、也不抛错）。
//   于是源码里写一句 `SQL_VALIDATION_LABELS.passed.cls = 'x'` 既不会报错、也不会生效——
//   读代码的人会以为它生效了，而守卫这边"结构证明"照样全绿（字面量确实没变）。
//   这条断言从**源码**一侧堵常见写入意图。〔25D 收窄声称〕覆盖**恰四类**（不是"任何写入"）：
//     · AssignmentExpression 左值链底是登记常量（`MAP.x = …` / `MAP.x.y = …` / `MAP[k] = …`）
//     · delete 表达式的目标链底是登记常量（`delete MAP.x`）
//     · UpdateExpression（`MAP.x++` / `--MAP.x`）
//     · Object.assign 的**第一个参数**链底是登记常量（`Object.assign(MAP, …)` —— 最隐蔽的一种）
//   明确不覆盖的写入形态（已知边界·登记如下）：for-in/of 左值成员、解构赋值成员目标、Object.defineProperty/Reflect.set/
//   setPrototypeOf 等反射式写——这些形态在本仓页面代码零使用；真正的运行时不可变由深 freeze 保证
//   （严格模式抛错/非严格静默不生效），本断言只是"源码意图"级的第一层。
function assertNoWhitelistConstMutation(check, spec, sources, names) {
    if (!names.length) return;
    const hits = [];
    const rootOf = (node) => {
        let cur = node;
        while (cur && cur.type === 'MemberExpression') cur = cur.object;
        return cur && cur.type === 'Identifier' ? cur.name : null;
    };
    for (const s of sources) {
        if (!s.ast) continue;
        walkAst(s.ast, (n) => {
            let target = null;
            let how = '';
            if (n.type === 'AssignmentExpression' && n.left) { target = n.left; how = `${n.operator} 赋值`; }
            else if (n.type === 'UnaryExpression' && n.operator === 'delete') { target = n.argument; how = 'delete'; }
            else if (n.type === 'UpdateExpression') { target = n.argument; how = `${n.operator} 自增/自减`; }
            else if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression'
                && !n.callee.computed && n.callee.object && n.callee.object.name === 'Object'
                && n.callee.property && n.callee.property.name === 'assign'
                && n.arguments.length) { target = n.arguments[0]; how = 'Object.assign 目标'; }
            if (!target) return;
            const root = rootOf(target);
            if (!root || !names.includes(root)) return;
            hits.push(`${s.label} · ${how} · \`${s.source.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 70)}\``);
        });
    }
    check(hits.length === 0, `${spec.file}：白名单常量无后代成员写入（${names.join(' / ')}）`,
        hits.length
            ? `${hits.length} 处写入意图：${hits.slice(0, 3).join('；')}${hits.length > 3 ? ' …' : ''} —— `
              + 'freeze 在非严格模式下**静默失败**：这行既不报错也不生效，读代码的人却会以为它生效了。白名单常量只能在声明处定值'
            : '');
}

function assertClassSinkProvenance(check, spec, sources) {
    const keys = new Set(Object.keys(spec.tiers || spec.expectStatuses || {}));
    // 〔S5a-fix2 M5〕次级族根类并进 sink 溯源后，各页的次级族 gate（itPriClass / typeClass /
    //   siTypeClass / siPriClass / siDevStatusClass / pfRecipClass / mwPriClass …）也是**合法出口**，
    //   须并入本页可接受的 gate 名集合。它们的**调用次数**由 SECONDARY_FAMILY_SPECS 各自的
    //   gateCount 负责，此处只回答"这个调用算不算合法来源"，不重复计数。
    const gateNames = new Set([
        ...(spec.renderGate || []).map((g) => (g.match(/^([\w$.]+)/) || [])[1]).filter(Boolean),
        ...(spec.extraSinkGates || []),
        ...(spec.normalizerGates || []).map((g) => g.name),
    ]);
    const fragmentValues = fragmentValuesOf(spec);
    // 〔S5a-fix2 M5〕gate → 它自己的片段集。状态族 gate 用本页状态片段；
    //   次级族 gate 用该族登记的 class 集（从 SECONDARY_FAMILY_SPECS 按页取）。
    const gateFragments = {};
    for (const g of (spec.renderGate || []).map((x) => (x.match(/^([\w$.]+)/) || [])[1]).filter(Boolean)) {
        gateFragments[g] = fragmentValues;
    }
    for (const fam of SECONDARY_FAMILY_SPECS) {
        if (fam.file !== spec.file || !fam.gate) continue;
        const own = fam.mapValueSet || Object.keys(fam.classes || {});
        if (own.length) gateFragments[fam.gate] = own;
    }
    // 〔S5a-fix3 项 1〕**开局按配置直接对账**：凡在册的 gate 名必须有专属片段集，否则判红。
    //   ⚠️ 这条最初写成「possibleSkeletons 遇到该 gate 时顺带记一笔」——而 M5 把次级族根类并入
    //   BADGE_ANY_ROOT_RE 之后，这些族的 sink 全都成了**徽章 sink**，走的是 sinkProvenance
    //   （只查 gate 名在不在册），根本不会调 possibleSkeletons，那道闸门于是永远触发不到。
    //   改成开局对账后与代码路径无关，谁也绕不过去。
    //   为什么不能"没片段集就回退到本页状态片段集"：那是假绿通道——一个次级族 gate 会被当成
    //   可能返回 sem-*，要么误红、要么在别的组合下误绿。宁可红着要人来登记。
    //   normalizer 型 gate（输出集本就无界）需**显式登记**才豁免，见 spec.normalizerGates。
    const normalizerNames = new Set((spec.normalizerGates || []).map((g) => g.name));
    const gateFragmentGaps = new Set();
    for (const g of gateNames) {
        if (!gateFragments[g] && !normalizerNames.has(g)) gateFragmentGaps.add(g);
    }
    for (const g of (spec.normalizerGates || [])) {
        console.log(`  [INFO] ${spec.file}：${g.name} 登记为**规范化器**（非白名单）—— ${g.why}`);
    }
    const badgeProblems = [];
    const nonBadgeProblems = [];
    let badgeExprCount = 0;
    let nonBadgeSinkCount = 0;
    let unboundedCount = 0;

    // 〔S5a-fix3 项 2〕先做白名单常量结构证明，只有**通过**的名字才进 ctx 白名单
    const validatedWhitelist = assertWhitelistConstStructure(check, spec, sources);
    assertNoWhitelistConstMutation(check, spec, sources, (spec.extraWhitelistConsts || []).map((d) => d.name));

    for (const s of sources) {
        if (!s.ast) { badgeProblems.push(`${s.label}：AST 不可用（解析失败），无法溯源 —— 见上方解析断言`); continue; }
        const scopeIndex = s.scopeIndex || buildScopeIndex(s.ast);
        if (!scopeIndex.ok) { badgeProblems.push(`${s.label}：${scopeIndex.why} —— 作用域索引建不起来，标识符溯源全部失效`); continue; }
        const baseCtx = {
            keys, gateNames, mapConst: spec.mapConst, scopeIndex, fragmentValues,
            predicateGates: spec.predicateGate || [],
            extraWhitelistConsts: validatedWhitelist,
            gateFragments,
            ast: s.ast,      // staticStringOf 投影"本地无参 helper 的唯一静态返回值"时要按名字找函数
        };
        for (const sink of collectBadgeClassSinks(s.ast, s.source, baseCtx)) {
            if (sink.isBadge) {
                for (const e of sink.exprs) {
                    badgeExprCount++;
                    const r = sinkProvenance(e.node, { ...baseCtx, literalMustBeKey: FRAGMENT_PREFIX_RE.test(e.prefix) }, 0);
                    if (!r.ok) {
                        const snippet = s.source.slice(e.node.start, e.node.end).replace(/\s+/g, ' ').slice(0, 70);
                        badgeProblems.push(`${s.label} · ${sink.desc} · \`${snippet}\`：${r.why}`);
                    }
                }
                continue;
            }
            nonBadgeSinkCount++;
            const v = nonBadgeSinkVerdict(sink, baseCtx);
            unboundedCount += v.unbounded;
            for (const p of v.problems) {
                const snippet = s.source.slice(sink.exprs[0].node.start, sink.exprs[0].node.end).replace(/\s+/g, ' ').slice(0, 60);
                nonBadgeProblems.push(`${s.label} · ${sink.desc} · \`${snippet}\`：${p}`);
            }
        }
    }

    check(badgeProblems.length === 0,
        `${spec.file}：徽章 class 的动态片段均可静态溯源到登记 gate/白名单（${badgeExprCount} 处 sink 表达式）`,
        badgeProblems.length ? `${badgeProblems.length} 处溯源失败：${badgeProblems.slice(0, 4).join('；')}${badgeProblems.length > 4 ? ' …' : ''}` : '');

    check(gateFragmentGaps.size === 0, `${spec.file}：每个登记 gate 都有专属片段集（无回退到状态片段集的假绿通道）`,
        gateFragmentGaps.size
            ? `${gateFragmentGaps.size} 个 gate 缺专属片段集：${[...gateFragmentGaps].join(' | ')} —— 请在 SECONDARY_FAMILY_SPECS 给它建族条目（classes 或 mapValueSet），或按 normalizerGates 显式登记为规范化器`
            : '');

    check(nonBadgeProblems.length === 0,
        `${spec.file}：非徽章 class sink 均不可能产出徽章标记（${nonBadgeSinkCount} 处·跟不动节点 ${unboundedCount} 个）`,
        nonBadgeProblems.length
            ? `${nonBadgeProblems.length} 处有徽章标记流入非 gate 通道：${nonBadgeProblems.slice(0, 4).join('；')}${nonBadgeProblems.length > 4 ? ' …' : ''}`
            : '');
}

// ============================================================
// class gate 函数体形态断言（S4-fix MED-2）
// ============================================================
//   缺口：gate 的**调用**被数得死死的（次数恰等 + 实参指纹），但 gate **自己吐什么**没人管。
//   把 `return TASK_STATUS_BADGE[status].cls` 改成 `return 'sem-' + String(status)`，
//   调用次数不变、模板不变、rawConcatForbidden 也看不见（拼接发生在函数体内，不在模板里），
//   而白名单就此彻底失效——原值被直接做成了 class 片段。
//   判据：gate 函数体内**每一条 return** 只允许两种形态（三元/或运算按分支递归）：
//     ① 从登记的白名单常量上取值（`MAP[k]` / `MAP[k].cls` / `MAP.k`，根标识符必须是登记常量）
//     ② 字符串字面量，且值 ∈ 登记集合（状态键 ∪ 有意不接线键 ∪ 片段全集 ∪ 空串降级）
//   外加**守门形态**：`WL[k] ? k : '默认'` / `WL.includes(k) ? k : '默认'`（gate 当判据用，
//   Data_Correction 的 statusClass 就是这一种：返回的是被白名单验过的入参本身）。
//   空串单独说明：PF / MC / IT / DC 的兜底就是 `return ''`（输出无修饰类的裸 base，
//   落 wait fallback），是登记过的降级形态，故在允许集合内。

function findNamedFunctionNodes(ast, name) {
    const found = [];
    walkAst(ast, (n) => {
        if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) found.push(n);
        else if (n.type === 'VariableDeclarator' && n.id && n.id.name === name && n.init
            && (n.init.type === 'FunctionExpression' || n.init.type === 'ArrowFunctionExpression')) found.push(n.init);
    });
    return found;
}

// 取函数体内的 return（不下钻嵌套函数——那是别人的返回值）
function returnStatementsOf(fnNode) {
    const out = [];
    const visit = (n, isRoot) => {
        if (!isRoot && isFunctionNode(n)) return;
        if (n.type === 'ReturnStatement') out.push(n);
        forEachChildNode(n, (c) => visit(c, false));
    };
    visit(fnNode, true);
    // 箭头函数的表达式体（`s => MAP[s]`）没有 ReturnStatement，等价于一条 return
    if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body && fnNode.body.type !== 'BlockStatement') {
        out.push({ type: 'ReturnStatement', argument: fnNode.body, start: fnNode.body.start, end: fnNode.body.end });
    }
    return out;
}

// 成员表达式的根标识符（`A[b].c` → 'A'）
function rootIdentifierOf(node) {
    let cur = node;
    while (cur && cur.type === 'MemberExpression') cur = cur.object;
    return cur && cur.type === 'Identifier' ? cur.name : null;
}

function gateReturnVerdict(arg, ctx, depth) {
    if (!arg) return { ok: false, why: '空 return（gate 必须显式返回一个 class 片段）' };
    if (depth > 5) return { ok: false, why: '嵌套过深，无法静态判定' };
    switch (arg.type) {
        case 'MemberExpression': {
            const root = rootIdentifierOf(arg);
            if (!root || !ctx.whitelistConsts.includes(root)) {
                return { ok: false, why: `成员取值的根 \`${root || '(动态)'}\` 不是登记白名单常量（${ctx.whitelistConsts.join(' / ') || '无'}）` };
            }
            // 〔B4〕值为**对象**的 map：只许取那个约定字段（`MAP[key].cls`）。
            //   `MAP[key]` 整个对象会让 gate 返回 `[object Object]`，`.label` 会把中文文案当 class——
            //   两者都不是 class 片段，却都能骗过"根是白名单常量"这一条。
            if (ctx.mapValueField) {
                // 〔B4·S4-fix3 收紧〕成员链必须**恰好两层**：`mapConst[key].<field>`。
                //   rootIdentifierOf 只看链底，`MAP[a].b.c`、`MAP[a].cls.x` 这类更深的链底也是 mapConst，
                //   照样会被放行，而它们返回的根本不是那个约定字段。可选链（`MAP?.[a]?.cls`）同样拒绝：
                //   它会在未命中时静默返回 undefined，等于把兜底分支绕过去。
                if (arg.optional) return { ok: false, why: '可选链取值（未命中会静默返回 undefined，绕过兜底分支）' };
                const field = arg.computed ? null : (arg.property && arg.property.name);
                if (field !== ctx.mapValueField) {
                    return { ok: false, why: `本页 map 的值是对象，gate 只许返回 \`${ctx.mapConst}[…].${ctx.mapValueField}\`，实际取的是 \`${field || '(计算属性)'}\`（取整个对象会渲染成 [object Object]，取别的字段会把文案当 class）` };
                }
                const host = arg.object;
                if (!host || host.type !== 'MemberExpression' || host.optional) {
                    return { ok: false, why: `\`.${ctx.mapValueField}\` 的宿主不是 ${ctx.mapConst} 的键取值（或用了可选链）` };
                }
                if (!host.object || host.object.type !== 'Identifier' || host.object.name !== ctx.mapConst) {
                    return { ok: false, why: `成员链不是恰两层的 \`${ctx.mapConst}[…].${ctx.mapValueField}\`（实际链底=${rootIdentifierOf(arg) || '(动态)'}，中间还套了别的层）` };
                }
            }
            return { ok: true };
        }
        case 'Literal': {
            if (typeof arg.value !== 'string') return { ok: false, why: `返回了非字符串字面量 ${JSON.stringify(arg.value)}` };
            if (ctx.allowedLiterals.has(arg.value)) return { ok: true };
            return { ok: false, why: `字面量 ${JSON.stringify(arg.value)} 不在登记集合内（状态键 / 有意不接线键 / 片段全集 / 空串降级）` };
        }
        case 'ConditionalExpression': {
            if (isGuardedConditional(arg, ctx)) return { ok: true };
            // 守门三元：谓词形态**只走 guardPredicateMatches 这一处**判定。
            //   ⚠️〔S4-fix3 自查发现〕这里原本内联了一份"白名单成员测试式守门"（`WL[k] ? k : '默认'`）
            //   的判定逻辑 —— 与 predicateGate 那套是同一条规则的**第二份实现**。
            //   于是 B5 把 memberTruthy 从 predicateGate 撤下时，这一份没跟着撤，
            //   真值守门在 gate return 这条路上照旧被放行（双向证明④ 当场撞出来）。
            //   同一条规则只留一处实现，才不会出现"改了一半"。
            if (guardPredicateMatches(arg.test, arg.consequent, ctx)) {
                const alt = gateReturnVerdict(arg.alternate, ctx, depth + 1);
                if (alt.ok) return { ok: true };
                return { ok: false, why: `守门三元的默认分支不合规 → ${alt.why}` };
            }
            const c = gateReturnVerdict(arg.consequent, ctx, depth + 1);
            if (!c.ok) return { ok: false, why: `三元 consequent → ${c.why}` };
            const a = gateReturnVerdict(arg.alternate, ctx, depth + 1);
            if (!a.ok) return { ok: false, why: `三元 alternate → ${a.why}` };
            return { ok: true };
        }
        case 'LogicalExpression': {
            // 〔B4〕只许 `||`（"取不到就用默认"）。`&&` / `??` 的短路语义会让返回值形态失控：
            //   `MAP[k] && '…'` 在未命中时返回 undefined，`a ?? b` 对空串不生效，都不是合格的兜底。
            if (arg.operator !== '||') return { ok: false, why: `只允许 \`||\` 兜底，实际是 \`${arg.operator}\`` };
            const l = gateReturnVerdict(arg.left, ctx, depth + 1);
            if (!l.ok) return { ok: false, why: `\`||\` 左侧 → ${l.why}` };
            const r = gateReturnVerdict(arg.right, ctx, depth + 1);
            if (!r.ok) return { ok: false, why: `\`||\` 右侧 → ${r.why}` };
            return { ok: true };
        }
        default:
            return { ok: false, why: `${arg.type} 形态不在允许的 return 形态内（只许白名单取值 / 登记字面量 / 二者的三元与或运算组合）` };
    }
}

function assertGateReturnShapes(check, spec, sources) {
    if (!spec.classGate) {
        // 显式登记"本页没有页内 class gate"，不让它变成一次沉默的跳过
        check(true, `${spec.file}：本页无页内 class gate（${spec.classGateNote || '走共享 helper / 守门数组'}）`, '');
        return;
    }
    const whitelistConsts = [spec.mapConst, spec.statusSource && spec.statusSource.const, spec.fullMap && spec.fullMap.const]
        .filter(Boolean);
    // 〔B4〕登记字面量集**按模式收窄**：
    //   sem 模式的 gate 返回的就是 class 片段本身（sem-*），**状态键不该出现在返回值里**
    //   （`return 'DONE'` 会渲染出一个没有任何规则的类），故不并入状态键；
    //   别名模式的 gate 返回的是"片段的可变部分"，历史上既有直接返回片段的（IT/DC），
    //   也有返回状态键本身由模板拼前缀的（Data_Correction），故两者都在集合内。
    const allowedLiterals = spec.mode === 'sem'
        ? new Set([...fragmentValuesOf(spec), ''])
        : new Set([
            ...Object.keys(spec.tiers || {}),
            ...(spec.intentionallyUnmapped || []),
            ...fragmentValuesOf(spec),
            '',   // 无修饰类降级（IT/DC 的兜底），登记形态
        ]);
    const gateNames = new Set((spec.renderGate || []).map((g) => (g.match(/^([\w$.]+)/) || [])[1]).filter(Boolean));

    const hits = [];
    for (const s of sources) {
        if (!s.ast) continue;
        for (const fn of findNamedFunctionNodes(s.ast, spec.classGate)) hits.push({ src: s, fn });
    }
    check(hits.length === 1, `${spec.file}：class gate \`${spec.classGate}()\` 定义恰一处`,
        hits.length === 0
            ? '找不到该函数——gate 被改名/删除，则"class 片段必过此关"的断言全部落空'
            : `发现 ${hits.length} 处同名定义，运行时以最后一处为准，守卫读哪一处都是赌`);
    if (hits.length !== 1) return;

    const { src, fn } = hits[0];
    const ctx = {
        whitelistConsts, allowedLiterals, gateNames,
        mapConst: spec.mapConst, mapValueField: spec.mapValueField,
        keys: new Set(Object.keys(spec.tiers || spec.expectStatuses || {})),
        predicateGates: spec.predicateGate || [],
        literalMustBeKey: false,
    };
    const rets = returnStatementsOf(fn);
    check(rets.length > 0, `${spec.file}：\`${spec.classGate}()\` 至少有一条 return`, rets.length ? '' : '函数体无 return，gate 恒返回 undefined');

    const bad = [];
    for (const r of rets) {
        const v = gateReturnVerdict(r.argument, ctx, 0);
        if (!v.ok) {
            const snippet = src.source.slice(r.start, r.end).replace(/\s+/g, ' ').slice(0, 70);
            bad.push(`\`${snippet}\`：${v.why}`);
        }
    }
    check(bad.length === 0,
        `${spec.file}：\`${spec.classGate}()\` 的 ${rets.length} 条 return 均为白名单取值或登记字面量`,
        bad.length ? `${bad.length} 条不合规：${bad.join('；')} —— gate 一旦自己拼字符串，白名单就被架空了` : '');
}

// ── DOM API 侧负向扫描（B-H4②·S3-fix MED-2 提为两模式共用）──────────
//   模板串之外还有几条写 class 的路子，它们不经过任何模板，针对模板串的 rawConcatForbidden 看不见：
//     classList.add/toggle/replace(...) ／ .className = ... ／ setAttribute('class', ...)
//     ／ **对象字面量属性 `className: ...`**（Model_Center 的 mdcEl({className: 'u-status-badge ' + x})
//       就是这一形态——S0 早就点过"字符串拼接赋值原不被覆盖"，S3 之前一直漏网，本次入网）。
//   spec.domApiAllow 列出该页**合法**的 gate 形态，命中它们的行放行。
function assertNoDomApiBypass(check, spec, html, extraTexts) {
    const hits = [];
    const apiRe = /(?:classList\s*\.\s*(?:add|toggle|replace)|\.className\s*=|className\s*:|setAttribute\s*\(\s*['"]class['"])([^;\n]*)/g;
    // 〔N5-fix·pattern-sweep〕**剥注释先行**——与 emoji 守卫、verify-unify-static 的②b/②c 同款纪律。
    //   本条与那两条是同一形态（文本扫描类断言把注释当代码），一次扫干净不留第四次：注释里演示/复盘
    //   一段旧的 classList 写法，不该被判成"真的有人在用这条旁路"。
    for (const text of [html, ...(extraTexts || [])].map((t) => stripJsComments(String(t || '')))) {
        apiRe.lastIndex = 0;
        let m;
        while ((m = apiRe.exec(text)) !== null) {
            const chunk = m[0];
            const touchesBadge = /u-status-badge/.test(chunk)
                || /(^|['"`\s+])(s-|si-s-|status-|sem-)[\w一-龥-]/.test(chunk);
            if (!touchesBadge) continue;
            if ((spec.domApiAllow || []).some((allow) => chunk.includes(allow))) continue;
            hits.push(chunk.replace(/\s+/g, ' ').trim().slice(0, 90));
        }
    }
    check(hits.length === 0, `${spec.file}：无经 DOM API（classList/className/setAttribute/对象属性）写徽章 class 的旁路`,
        hits.length ? `${hits.length} 处：${hits.join(' | ')} —— 这条路子绕开模板与 gate，白名单管不到，请改走登记的 gate 形态` : '');
}

// ============================================================
// 口径二·族级断言（S5a）
// ============================================================
//   主状态徽章族之外还有四类"小徽章"：通知 / 类型标签 / 优先级 / 次级族。它们不挂 .u-status-badge，
//   前面所有断言都管不到，而它们同样会因为"某页偷偷写死一个色值"而与色板分叉。
//   本节按**族**建断言，每族回答三个问题：
//     ① 登记的每个类都有恰一条页内规则吗？
//     ② 规则里的**色值**是 var(--sem-<登记层>-*) 引用，还是又写死了字面量？
//     ③ 旧类名 / 旧的 raw 拼接输出点是不是真的退场了（登记过的兼容别名除外）？
//   ⚠️ **computed harness 有意不扩到这些族**：它们不挂 .u-status-badge，没有 base/色点/形态契约，
//     逐属性比对的价值远低于主族；观感由 S5b 视觉基线重拍 + 人工验收兜底。这是登记的取舍，
//     不是漏做——写在这里，免得下一个人把它读成疏忽。
//   ⚠️ 优先级族（u-pri）的色值住在 components.css（共享层，禁区），页面侧只剩"用哪个 class"，
//     故它在表里 classes 为空、靠 requiredSelectors / retiredClasses / gate 三条覆盖。
//
//   ── 边界登记（S5a-fix LOW-1 / LOW-3）──────────
//   · **@media 块内的规则是盲区**：ruleBodiesFor / allSelectorHeads 按 `}` 切块，
//     `@media (...) { .val-passed { ... } }` 里的规则会被切成畸形片段，既不会被采集也不会判红。
//     本批六页的族级规则全部在顶层（实测），故当前无实际缺口；哪天有人把某族规则塞进 @media，
//     守卫会**沉默地不管它**。兜底＝computed harness（PF/MC 等页）+ S5b 视觉基线重拍。
//     要真正覆盖需引入 CSS AST（postcss），成本与收益不成比例，登记接受。
//   · **三条断言当前恒真、只承载"登记声明"而不承载判定力**，写明免得被误读成防线：
//       ① 优先级族的「0 个登记类各有恰一条页内规则」——classes 为空，循环体不执行；
//       ② 两个 tokenized:false 族的「有意不做色值 token 化」——check(true) 固定通过，
//          它的作用是把"为什么这族不 token 化"的理由打印在报告里；
//       ③ 类型族 backendSource 的 subset 方向——后端 TRANSITIONS 目前是前端类型集的真子集
//          （config 流未落地），只有后端新增第五种类型才可能红。
// 〔S5a-fix LOW-2〕色值字面量：hex / rgb( / rgba( / hsl( / hsla(。
//   判据从"白名单属性名"改成**任何声明值里出现色值字面量即红**——按属性名列白名单挡不住简写：
//   `border: 1px solid #eee`、`background: #fff url(...)`、`box-shadow: 0 0 0 2px rgba(...)`
//   都不在白名单属性里，却都在写死颜色。var(--sem-*) 引用本身不含 # 或 rgb(，天然不误伤。
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
// 〔S5a-fix HIGH-1〕对比度豁免层清单（与 verify-unify-static.js 的 CONTRAST_EXEMPT 同源）。
//   次级族**禁止**引用——理由见下方族级断言里的闸门注释。
const CONTRAST_EXEMPT_TIERS = ['voided', 'legacy'];

// 〔S5a-fix2 M6〕颜色类属性白名单：这些属性的值**必须**精确等于 var(--sem-<层>-<键>)。
//   与 COLOR_LITERAL_RE（黑名单）互补：白名单管"该是 token 的地方必须是 token"，
//   黑名单管"任何地方都不许出现色值字面量"。只有黑名单时，把 `color` 写成
//   `inherit` / `currentColor` / `rgb(var(--x))` 之类既躲开字面量检测、又脱离了色板。
const TOKEN_REQUIRED_PROPS = ['background', 'background-color', 'color', 'border-color', 'border-top-color',
    'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color'];
const SEM_TOKEN_EXACT_RE = /^var\(--sem-([a-z]+)-(bg|fg|bd|bds|dot|deco)\)$/;
// 〔S5a-fix3 项 3〕**可携色简写属性**：它们能夹带颜色，却不在 TOKEN_REQUIRED_PROPS 的精确白名单里，
//   于是 `border: 1px solid currentColor` 这种写法能同时躲过"字面量黑名单"和"精确 token 白名单"两层。
//   而次级族按口径二本来就只该有 background/color 两条声明 —— 出现这些属性本身就说明有人在加观感
//   （描边/阴影/删除线），那是重构不是"色值 token 化"。故整类拒绝：比逐个解析色分量既简单又更贴口径。
const COLOR_CARRYING_SHORTHANDS = ['border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'outline', 'box-shadow', 'text-shadow', 'text-decoration', 'text-decoration-color', 'caret-color',
    'column-rule', 'border-image', 'background-image'];
// 〔S5a-fix4 项 3〕**属性白名单**（第一层）：次级族登记类的规则体里只许出现这几个属性。
//   为什么从"拒绝列表"翻成"允许列表"：拒绝列表要穷举所有能携色的属性，而 CSS 的携色面是开放的
//   （`filter: drop-shadow(red)`、`accent-color`、`-webkit-text-fill-color`、将来还会有新属性）——
//   穷举不完就等于漏项即放行。口径二对这些族的要求本来就是一句话："只换已有的 background/color"，
//   那么允许列表天然只有这两条，白名单化后"我没想到的属性"默认是红而不是默认放行。
//   COLOR_CARRYING_SHORTHANDS 降为**第二层**：它给的报错信息更具体（点名是描边/阴影/删除线），
//   留着能让常见误用一眼看懂原因，而不是只收到一句"不在允许列表内"。
const SECONDARY_ALLOWED_PROPS = ['background', 'background-color', 'color'];
// 〔S5a-fix3 项 3〕通道等价：`background` 与 `background-color` 是同一条通道的两种写法，
//   必需通道校验时任一满足即可（否则一次合法重构就会造出假红）。
const CHANNEL_ALIASES = Object.freeze({ background: ['background', 'background-color'], color: ['color'] });

// ── 〔S5a-fix2 M10〕借色站点登记表 ──────────
//   "借色"= 某个状态用了某一层的**色**但不用它的**语义**（语义由 label 文字承载）。
//   这类站点最怕的是：将来有人为了让某一层"更贴它自己的语义"去调那层的 token，
//   顺手就改坏了几个借色站点——而借色站点的注释散在各页 CSS 里，改 token 的人不会去翻。
//   这张表是**唯一集中处**：调整下列任一层的 token 前，先查这里谁在借它。
//   下方断言把这张表与 spec 的实际映射对账，防止表和代码各自漂移。
const BORROWED_TIERS = Object.freeze([
    { family: '开发成员态 si-dev-status-badge（Sys_Iteration）', cls: 'excused', tier: 'intake', why: '语义=本次免除此人提交，非"待受理"；借色约束＝达标层 ∧ 与同行 pending(wait 灰) 可分' },
    { family: '开发成员态 si-dev-status-badge（Sys_Iteration）', cls: 'no_code', tier: 'hold', why: '语义=本次无代码提交，非"暂缓"；四态里无更贴的层，原色琥珀与 hold 同系' },
    { family: '收件人推送态 pf-recip-status（Periodic_Fetch）', cls: 'pushed_superseded', tier: 'intake', why: '语义=被强制重发替代的技术终态，非"待受理"；借色约束＝达标层 ∧ 与 pushed_skipped(wait 灰) 可分' },
    { family: '验收详情底色 val-*-bg（Data_Collab·平行族）', cls: 'val-admin-closed-bg', tier: 'special', why: '语义=行政闭环（管理员直接关单），非"对接测试"；紫是唯一能与同族绿/红/琥珀/蓝全部拉开的层' },
]);
//   ⚠️ 主状态族的借色站点（Statistics 的 `aborted→wait`）不在本表：那一族有自己的 spec 与注释，
//     且 wait 层的调整会先撞主族的一堆断言。本表只管次级族——它们没有那层保护。

const SECONDARY_FAMILY_SPECS = [
    {
        family: '通知徽章（Issue_Tracker）',
        file: 'Issue_Tracker.html',
        selector: (c) => `.u-notify-badge.${c}`,
        classes: { 'n-sent': 'done', 'n-failed': 'failed', 'n-not_sent': 'wait' },
        // 〔S5a-fix MED-7〕兼容别名机制**整体撤销**：CSS 与产出 class 的 JS 同在一个 HTML 文件、
        //   同一版发布，浏览器拿不到"新 CSS + 旧 JS"的组合——方案审建议 3 的前提在本项目不可达。
        //   旧类连同 spec 的 compatAliases 字段一并删，改为纳入 retiredClasses 硬断言。
        retiredClasses: ['notify-sent', 'notify-failed', 'notify-not_sent'],
        tokenized: true,
        mapConst: 'IT_NOTIFY_CLASS',
        expectedMap: { sent: 'n-sent', failed: 'n-failed', not_sent: 'n-not_sent' },
        gate: 'itNotifyClass',
        gateCount: 1,
        // 〔S5a-fix MED-4〕改**否定前瞻不变量式**：原来只拦"旧前缀"这一种已知坏形态，
        //   换个写法（如 `u-notify-badge ${st}`，无前缀无 gate）就绕过去了。
        //   现在的判据是"凡插值进这个 class 位置的，必须是登记 gate 的调用"——默认不许，而非默认放行。
        rawConcatForbidden: [/u-notify-badge \$\{(?!itNotifyClass\()/],
        // 〔S5a-fix4 项 3〕属性白名单的**唯一**登记额外项：`.u-notify-badge.n-failed { cursor: help }`。
        //   这是既有设计（失败徽章带 title 提示，光标示意"可悬停看原因"），与配色无关、本批不动
        //   （Issue_Tracker.html 不在本批改动白名单内）。登记在此＝显式承认它存在，而不是让
        //   白名单宽到能顺带放行别的东西。
        extraProps: ['cursor'],
    },
    {
        family: '类型标签（Sys_Iteration）',
        file: 'Sys_Iteration.html',
        selector: (c) => `.u-type-tag.${c}`,
        classes: { 't-bug': null, 't-feature': null, 't-improvement': null, 't-config': null },
        // 分类色不是状态色：口径二统一的是**前缀命名**，不是配色。故本族不做 token 化断言，
        //   改为断言"旧的裸类型名不得再有规则"（前缀确实换掉了）。
        tokenized: false,
        tokenizedWhy: '四条是分类色（BUG/新功能/优化/配置变更），塞进 14 层状态语义会让"红=失败"这类既有认知在类型标签上失效',
        retiredClasses: ['bug', 'feature', 'improvement', 'config'],
        mapConst: 'SI_TYPE_CLASS',
        expectedMap: { bug: 't-bug', feature: 't-feature', improvement: 't-improvement', config: 't-config' },
        gate: 'siTypeClass',
        gateCount: 5,
        rawConcatForbidden: [/u-type-tag \$\{(?!siTypeClass\()/],   // MED-4 否定前瞻
        // 〔S5a-fix LOW-4〕后端类型枚举锚定：routes/sys-iteration/transitions.js 的 TRANSITIONS 键集。
        //   mode='subset'（不是 equal）是**实测得来**：该常量目前只有 feature/improvement/bug 三键，
        //   `config` 那行是注释掉的 TODO（"// config: CONFIG_FLOW_TRANSITIONS"）——
        //   即前端已有 config 类型、后端流程尚未落地。故约束方向只能是"后端有的前端必须都接线"，
        //   反向不成立。后端将来补 config 流不会红（前端已有），后端新增第五种类型才会红。
        backendSource: {
            label: 'transitions.js TRANSITIONS 键集',
            mode: 'subset',
            file: path.join(__dirname, '..', 'routes', 'sys-iteration', 'transitions.js'),
            extract: (src) => {
                const m = src.match(/const\s+TRANSITIONS\s*=\s*\{([\s\S]*?)\n\};/);
                if (!m) return [];
                return [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
            },
        },
    },
    {
        // 优先级族：色值住在共享层 components.css 的 .u-pri（本任务禁区），页面侧只剩"用哪个 class"。
        //   故本族不做 token 化断言，改为盯**迁移是否真的完成**：新类在册 + 两套旧类连同
        //   内联取色函数一起退场。〔S5a 自查补入〕最初把本族整个排除在表外，双向证明③
        //   （把旧的 .task-priority 规则加回去）当场不红——排除得太干净，等于这一族没人看。
        family: '优先级 u-pri（My_Workspace）',
        file: 'My_Workspace.html',
        selector: (c) => c,               // 本族直接写完整选择器
        classes: {},
        tokenized: false,
        tokenizedWhy: 'u-pri 的 P0-P3 色值在共享层 components.css，是本任务的禁区；页面侧无色值可 token 化',
        requiredSelectors: ['.stats-detail-item .u-pri', '.task-item .u-pri'],
        retiredClasses: [
            '.stats-detail-item .priority-badge',
            '.task-item .task-priority',
            '.task-item .task-priority.P0',
            '.task-item .task-priority.P1',
            '.task-item .task-priority.P2',
        ],
        // 渲染点与内联取色函数一并退场（内联 style 的优先级最高，是"共享层说了不算"的来源）
        //   末条为 MED-4 否定前瞻：插进 u-pri class 位的必须是 gate 调用，或 H1 引入的**规范值单变量**
        //   `priorityKey`（它的唯一写入就是 `mwPriClass(task.priority)`——这一步由 AST class sink
        //   溯源逐个证明，本正则只是快速失败层，不重复承担溯源职责）。
        rawConcatForbidden: [
            /getPriorityColor\s*\(/, /class="priority-badge/, /class="task-priority/,
            /u-pri \$\{(?!mwPriClass\(|priorityKey\b)/,
        ],
        mapConst: 'MW_PRI_CLASS',
        expectedMap: { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' },
        gate: 'mwPriClass',
        gateCount: 2,
        mapValueSet: ['P0', 'P1', 'P2', 'P3'],   // 本族 map 的 value 集不等于 classes（classes 有意为空）
    },
    {
        family: '验收徽章 val-badge（Data_Collab）',
        file: 'Data_Collab.html',
        selector: (c) => `.${c}`,
        classes: {
            'val-pending': 'wait', 'val-passed': 'done', 'val-failed': 'failed',
            'val-running': 'active', 'val-bypassed': 'review',   // HIGH-1：原 voided，次级族禁用豁免层
        },
        tokenized: true,
        // 〔H4〕`.val-pending` **原本就只有 color、没有背景**（既有设计：待验证态不上底色），
        //   故单独登记它的通道；其余四类走默认 ['background','color']。
        channelsByClass: { 'val-pending': ['color'] },
    },
    {
        family: '上线批次徽标 si-release-badge（Sys_Iteration）',
        file: 'Sys_Iteration.html',
        selector: (c) => `.si-release-badge.${c}`,
        classes: { plan: 'wait', done: 'done', warn: 'review', fail: 'failed' },
        tokenized: true,
    },
    {
        family: '开发成员态 si-dev-status-badge（Sys_Iteration）',
        file: 'Sys_Iteration.html',
        selector: (c) => `.si-dev-status-badge.${c}`,
        classes: { pending: 'wait', code_submitted: 'done', no_code: 'hold', excused: 'intake' },
        tokenized: true,
        // 〔S5a-fix MED-6〕S0 甲8 收口：输出点原为 `${esc(statusKey)}` raw 拼接
        mapConst: 'SI_DEV_STATUS_CLASS',
        expectedMap: { pending: 'pending', code_submitted: 'code_submitted', no_code: 'no_code', excused: 'excused' },
        gate: 'siDevStatusClass',
        gateCount: 1,
        rawConcatForbidden: [/si-dev-status-badge \$\{(?!siDevStatusClass\()/],
    },
    {
        family: '收件人推送态 pf-recip-status（Periodic_Fetch）',
        file: 'Periodic_Fetch.html',
        selector: (c) => `.pf-recip-status.${c}`,
        classes: {
            matched: 'done', blocked: 'rejected', pushed_success: 'done', pushed_failed: 'failed',
            pushed_skipped: 'wait', pushed_pending: 'active', pushed_superseded: 'intake',
        },
        tokenized: true,
        // 〔S5a-fix MED-6〕S0 甲7 收口：输出点原为 `pushed_${esc(meta.key)}` raw 拼接。
        //   map 的 value 是完整 class 片段（pushed_*），与 matched/blocked 两个字面量输出点并存，
        //   故 value 集单独声明。
        mapConst: 'PF_RECIP_CLASS',
        expectedMap: { success: 'pushed_success', failed: 'pushed_failed', skipped: 'pushed_skipped', pending: 'pushed_pending', superseded: 'pushed_superseded' },
        gate: 'pfRecipClass',
        gateCount: 1,
        mapValueSet: ['pushed_success', 'pushed_failed', 'pushed_skipped', 'pushed_pending', 'pushed_superseded'],
        rawConcatForbidden: [/pf-recip-status \$\{(?!pfRecipClass\()/, /pf-recip-status pushed_\$\{/],
    },
    {
        // 〔S5a-fix3 项 1〕IT / Sys 两页的优先级族入册。S5a-fix2 只建了 MW 那一族，
        //   而 M8 给这两页也加了 gate —— 不入册就意味着它们的 gate 没有专属片段集，
        //   会走"回退到本页状态片段集"这条**假绿通道**（25B 点出的正是它）。
        family: '优先级 u-pri（Issue_Tracker）',
        file: 'Issue_Tracker.html',
        selector: (c) => c,
        classes: {},
        tokenized: false,
        tokenizedWhy: 'u-pri 的 P0-P3 色值在共享层 components.css（本任务禁区）；页面侧无色值可 token 化',
        mapConst: 'IT_PRI_CLASS',
        expectedMap: { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' },
        mapValueSet: ['P0', 'P1', 'P2', 'P3'],
        gate: 'itPriClass',
        gateCount: 2,
        rawConcatForbidden: [/u-pri \$\{(?!itPriClass\()/],
    },
    {
        family: '优先级 u-pri（Sys_Iteration）',
        file: 'Sys_Iteration.html',
        selector: (c) => c,
        classes: {},
        tokenized: false,
        tokenizedWhy: '同上，色值在共享层 components.css',
        mapConst: 'SI_PRI_CLASS',
        expectedMap: { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' },
        mapValueSet: ['P0', 'P1', 'P2', 'P3'],
        gate: 'siPriClass',
        gateCount: 3,
        rawConcatForbidden: [/u-pri \$\{(?!siPriClass\()/],
    },
    {
        // 〔S5a-fix MED-5〕`.val-*-bg` 是验收状态的**平行族**（详情大块底色 vs 徽章小胶囊），
        //   与上面的 val-badge 同源同层。只收编徽章那一套会让"同一个状态两处不同色"。
        family: '验收详情底色 val-*-bg（Data_Collab·平行族）',
        file: 'Data_Collab.html',
        selector: (c) => `.${c}`,
        classes: {
            'val-passed-bg': 'done', 'val-failed-bg': 'failed', 'val-bypassed-bg': 'review',
            'val-admin-closed-bg': 'special', 'val-running-bg': 'active',
        },
        tokenized: true,
    },
];

function assertSecondaryFamily(check, spec) {
    const html = readPage(spec.file);
    if (html === null) { check(false, `${spec.family}：页面存在`, `未找到 ${spec.file}`); return; }
    const styleText = pageStyleText(html);
    const entries = Object.entries(spec.classes);

    // ① 每个登记类恰一条规则
    const missing = [];
    const duped = [];
    for (const [cls] of entries) {
        const bodies = ruleBodiesFor(styleText, spec.selector(cls));
        if (bodies.length === 0) missing.push(spec.selector(cls));
        else if (bodies.length > 1) duped.push(`${spec.selector(cls)}（${bodies.length} 条）`);
    }
    check(missing.length === 0 && duped.length === 0, `${spec.family}：${entries.length} 个登记类各有恰一条页内规则`,
        [missing.length ? `缺：${missing.join(' | ')}` : '', duped.length ? `重复：${duped.join(' | ')}` : ''].filter(Boolean).join('；'));

    // ② 色值必须是登记层的 token 引用（tokenized 族）
    if (spec.tokenized) {
        const bad = [];
        for (const [cls, tier] of entries) {
            const bodies = ruleBodiesFor(styleText, spec.selector(cls));
            if (bodies.length !== 1) continue;   // 缺/重复已在①报
            const decls = declarationsOf(bodies[0]);
            const allowedProps = SECONDARY_ALLOWED_PROPS.concat(spec.extraProps || []);
            for (const d of decls) {
                // 〔S5a-fix4 项 3〕**第一层：属性允许列表**（默认红）。
                //   放在拒绝列表之前，因为它管的是"没想到的属性"——拒绝列表只管"想到了的坏属性"。
                if (!allowedProps.includes(d.prop)) {
                    bad.push(`${spec.selector(cls)} 出现允许列表外的属性 ${d.prop}=\`${d.value}\`（次级族规则体只许 ${allowedProps.join(' / ')}；`
                        + '其他属性即便当下不携色，也已超出口径二"只换底色/字色"的范围。确属既有设计的，在族配置 extraProps 里显式登记）');
                    continue;
                }
                // 〔S5a-fix3 项 3〕可携色简写属性整类拒绝（第二层·保留：报错点名更具体）
                if (COLOR_CARRYING_SHORTHANDS.includes(d.prop)) {
                    bad.push(`${spec.selector(cls)} 出现可携色属性 ${d.prop}=\`${d.value}\`（次级族只该有 background/color；描边/阴影/删除线属观感重构，不在口径二内）`);
                    continue;
                }
                // 第二层（黑名单）：任何声明值里出现色值字面量即红
                if (COLOR_LITERAL_RE.test(d.value)) {
                    bad.push(`${spec.selector(cls)} 的 ${d.prop} 里有色值字面量 \`${d.value}\``);
                    continue;
                }
                // 〔M6〕第一层（白名单）：颜色类属性的值必须**精确**是 var(--sem-<层>-<键>)
                if (TOKEN_REQUIRED_PROPS.includes(d.prop)) {
                    const exact = d.value.match(SEM_TOKEN_EXACT_RE);
                    if (!exact) {
                        bad.push(`${spec.selector(cls)} 的 ${d.prop}=\`${d.value}\` 不是精确的 var(--sem-*) 引用（inherit/currentColor/嵌套 var 都躲得过字面量检测，却已脱离色板）`);
                        continue;
                    }
                    if (!SEM_TIERS.includes(exact[1])) { bad.push(`${spec.selector(cls)} 的 ${d.prop} 引用了非法层 \`${exact[1]}\``); continue; }
                    if (exact[1] !== tier) bad.push(`${spec.selector(cls)} 的 ${d.prop} 引用 \`${exact[1]}\` 层（登记为 \`${tier}\`）`);
                    continue;
                }
                // 非颜色类属性里若夹带 --sem-* 引用，层名也要对
                for (const m of d.value.matchAll(/var\(--sem-([a-z]+)-(bg|fg|bd|bds|dot|deco)\)/g)) {
                    if (!SEM_TIERS.includes(m[1])) { bad.push(`${spec.selector(cls)} 的 ${d.prop} 引用了非法层 \`${m[1]}\``); continue; }
                    if (m[1] !== tier) bad.push(`${spec.selector(cls)} 的 ${d.prop} 引用 \`${m[1]}\` 层（登记为 \`${tier}\`）`);
                }
            }
            // 〔S5a-fix2 H4〕**必需通道契约**：登记类必须声明约定的颜色通道。
            //   缺这条时，把 `background: var(--sem-done-bg)` 整行删掉照样全绿——
            //   剩下的 color 引用还在、层名也对，而徽章已经没有底色了。
            //   channels 默认 ['background','color']；哪一类天生只有部分通道，在 spec 里显式登记
            //   （如 `.val-pending` 原本就只有 color、没有背景——那是既有设计，不是漏写）。
            // 〔S5a-fix3 项 3〕`background` / `background-color` 视为同一通道（等价写法任一即可）
            const wantCh = (spec.channelsByClass && spec.channelsByClass[cls]) || spec.channels || ['background', 'color'];
            const missingCh = wantCh.filter((prop) => {
                const accept = CHANNEL_ALIASES[prop] || [prop];
                return !decls.some((d) => accept.includes(d.prop));
            });
            if (missingCh.length) {
                bad.push(`${spec.selector(cls)} 缺必需通道 ${missingCh.join(' / ')}（删掉一条颜色声明不该是静默变化）`);
            }
            // 〔S5a-fix HIGH-1 闸门〕次级族**禁止**引用对比度豁免层。
            //   豁免（voided/legacy 可低于 4.5:1）的成文前提是「line-through + 文案冗余保底」，
            //   而终审 L 规定次级族不继承 deco —— 前提被掏空，豁免就不成立。
            //   这道闸门正是 S5a 缺的那个：当时四处次级族映射到豁免层，全套断言一条都没红，
            //   问题一直到预筛才被看见。判据放在守卫里，下次谁再这么映射都会当场撞墙。
            if (CONTRAST_EXEMPT_TIERS.includes(tier)) {
                bad.push(`${spec.selector(cls)} 登记为豁免层 \`${tier}\` —— 次级族不继承 deco，拿不到豁免赖以成立的冗余通道`);
            }
        }
        check(bad.length === 0, `${spec.family}：色值全部为登记层的 var(--sem-*) 引用（无字面量、无引错层）`,
            bad.length ? `${bad.length} 处：${bad.slice(0, 5).join('；')}${bad.length > 5 ? ' …' : ''} —— 写死色值＝这一族又从色板里跑出去了` : '');
    } else {
        check(true, `${spec.family}：有意不做色值 token 化（${spec.tokenizedWhy}）`, '');
    }

    // ②b 新类在册（迁移目标真的用上了）
    if (spec.requiredSelectors) {
        const gone = spec.requiredSelectors.filter((sel) => ruleBodiesFor(styleText, sel).length === 0);
        check(gone.length === 0, spec.family + `：迁移目标选择器均在册（${spec.requiredSelectors.join(" / ")}）`,
            gone.length ? gone.join(" | ") + " 不见了——迁移目标没落地，或选择器被改名" : "");
    }

    // ③ 旧类退场 / 兼容别名在册
    if (spec.retiredClasses) {
        const still = spec.retiredClasses.filter((c) => ruleBodiesFor(styleText, spec.selector(c)).length > 0);
        check(still.length === 0, `${spec.family}：旧类名已退场（${spec.retiredClasses.join(' / ')}）`,
            still.length ? `${still.length} 条仍在：${still.map((c) => spec.selector(c)).join(' | ')}` : '');
    }

    // ④ 动了 JS 的族：frozen map + gate 次数
    if (spec.mapConst) {
        const parsed = parseJs(inlineScriptSource(html));
        check(parsed.ok, `${spec.family}：页内 <script> 可解析`, parsed.ok ? '' : parsed.error);
        if (parsed.ok) {
            const fz = checkFrozenObjectLiteral(parsed.ast, spec.mapConst);
            check(fz.ok, `${spec.family}：${spec.mapConst} = Object.freeze(对象字面量)，且同名常量恰一处`, fz.ok ? '' : fz.why);
            if (fz.ok) {
                // 〔S5a-fix2 H3〕从"value 集全等"升级为 **expectedMap 逐项 key→value 对全等**。
                //   只比 value 集的话，把 `sent:'n-sent'` 改成 `foo:'n-sent'` 照样全绿：
                //   value 集一个没变，而 sent 这个真实业务值已经查不到映射、会掉进 gate 的兜底。
                //   键错位是"业务值 → class"这条链上最难肉眼发现的一类错。
                const res = membersOfNode(fz.objectNode, 'objectEntries');
                const actual = new Map(res.members);
                const expectedMap = spec.expectedMap || null;
                if (!expectedMap) {
                    check(false, `${spec.family}：${spec.mapConst} 已登记 expectedMap`,
                        'spec 缺 expectedMap —— 动了 JS 的族必须逐项声明 key→value 期望，否则键错位查不出来');
                } else {
                    const diffs = [];
                    if (res.dynamic.length) diffs.push(`含动态成员：${[...new Set(res.dynamic)].join(' | ')}`);
                    for (const [k, v] of Object.entries(expectedMap)) {
                        if (!actual.has(k)) diffs.push(`缺键 '${k}'`);
                        else if (actual.get(k) !== v) diffs.push(`'${k}' → \`${actual.get(k)}\`（期望 \`${v}\`）`);
                    }
                    for (const k of actual.keys()) if (!(k in expectedMap)) diffs.push(`多出键 '${k}' → \`${actual.get(k)}\``);
                    const n = Object.keys(expectedMap).length;
                    if (actual.size !== n) diffs.push(`条目数 ${actual.size} ≠ 期望 ${n}`);
                    check(diffs.length === 0, `${spec.family}：${spec.mapConst} 与 expectedMap 逐项全等（${n} 对）`,
                        diffs.length ? `${diffs.length} 处：${diffs.slice(0, 6).join('；')}${diffs.length > 6 ? ' …' : ''}` : '');
                }
            }
            const count = countGateCalls(parsed.ast, spec.gate);
            check(count === spec.gateCount, `${spec.family}：gate \`${spec.gate}\` 调用次数恰为 ${spec.gateCount}`,
                count === spec.gateCount ? '' : `实际 ${count} 次 —— 少了说明有输出点绕过 gate，多了说明新增输出点未登记`);
        }
    }
    for (const re of spec.rawConcatForbidden || []) {
        const code = stripJsComments(inlineScriptSource(html));
        const hit = re.test(code);
        check(!hit, `${spec.family}：class 位插值必经登记 gate（/${re.source}/）`,
            hit ? '有渲染点把原值/非 gate 表达式直接拼进 class' : '');
    }

    // ⑤ 后端枚举锚定（LOW-4）：后端有的值前端必须都接线
    if (spec.backendSource) {
        const bs = spec.backendSource;
        const srcTxt = fs.existsSync(bs.file) ? fs.readFileSync(bs.file, 'utf8') : null;
        const got = srcTxt === null ? null : bs.extract(srcTxt);
        check(got !== null && got.length > 0, `${spec.family}：可提取后端类型源（${bs.label}）`,
            srcTxt === null ? `读不到 ${bs.file}` : `提取到 ${got ? got.length : 0} 项 —— 提取锚点失效则本族前后端一致性防线失效`);
        if (got && got.length) {
            const front = Object.values(spec.classes).length ? Object.keys(spec.classes) : [];
            // 前端 class 是 `t-<type>`，后端是裸 type：比对前先去前缀
            const frontTypes = front.map((c) => c.replace(/^t-/, ''));
            const missing = got.filter((t) => !frontTypes.includes(t));
            check(missing.length === 0, `${spec.family}：后端类型集 ⊆ 前端已接线类型（${bs.label}）`,
                missing.length ? `${missing.length} 个后端类型前端没接线：${missing.join(' | ')}` : '');
        }
    }
}

// 〔S5a-fix2 M10〕借色登记表 ↔ spec 实际映射对账。
//   登记表的用处是"改 token 前先看谁在借"，那它必须与代码同步——否则它反倒会误导人
//   （"表里没写，那就是没人借"）。这条断言把两边钉在一起：
//     · 表里的每条借色站点，spec 里必须真的是那个层；
//     · spec 里凡是"类名与层名不同源"的次级族站点，也不强制入表（很多是正常映射），
//       但**表里写了的必须对**——防的是表过期，不是强制穷举。
function assertBorrowedTiersRegistry(check) {
    const problems = [];
    for (const b of BORROWED_TIERS) {
        const fam = SECONDARY_FAMILY_SPECS.find((f) => f.family === b.family);
        if (!fam) { problems.push(`登记表里的族「${b.family}」在 SECONDARY_FAMILY_SPECS 里找不到（族名改了？）`); continue; }
        const actual = (fam.classes || {})[b.cls];
        if (actual === undefined) { problems.push(`「${b.family}」的类 \`${b.cls}\` 已不在 spec 的登记类里`); continue; }
        if (actual !== b.tier) problems.push(`「${b.family}」的 \`${b.cls}\` 实际映射 \`${actual}\`，登记表写的是 \`${b.tier}\``);
    }
    check(problems.length === 0, `借色登记表与 spec 实际映射一致（${BORROWED_TIERS.length} 处借色站点）`,
        problems.length ? `${problems.length} 处漂移：${problems.join('；')} —— 登记表过期比没有登记表更糟（它会让人以为"没人借这一层"）` : '');
    // 报告里列出来，让"谁在借哪一层"是台面上的信息
    console.log(`  借色站点：${BORROWED_TIERS.map((b) => `${b.cls}→${b.tier}`).join(' | ')}`);
}

// ══════════ 〔通知统一 N1·2026-08-09〕通知状态文本 7 槽（u-nt-*）+ showToast 单源 ══════════
//   为什么不塞进 SECONDARY_FAMILY_SPECS：那套 spec 描述的是**徽章族**（bg/fg/bd/dot/deco 五面 +
//   mapConst/gate「class 由受控 map 产出」结构）。u-nt-* 是**纯文本槽**——7 条只设 color 的规则，
//   没有 map 也没有 gate。硬套过去会让断言"说的"和"保的"对不上（假绿的常见来源），故单列一节。
const NT_SLOT_SPECS = Object.freeze([
    { cls: 'u-nt-ok',    tier: 'done',   why: '成功/已读文本' },
    { cls: 'u-nt-fail',  tier: 'failed', why: '失败文本' },
    { cls: 'u-nt-warn',  tier: 'review', why: '警示/前置缺失文本' },
    { cls: 'u-nt-wait',  tier: 'wait',   why: '待发送（可发）文本' },
    { cls: 'u-nt-run',   tier: 'active', why: '发送中文本' },
    { cls: 'u-nt-muted', tier: 'voided', why: '弱化（不可发/留痕缺省）文本【借色】' },
    { cls: 'u-nt-idle',  tier: 'legacy', why: '查询中占位文本【借色】' },
]);

//   借色登记（与 BORROWED_TIERS 同款口径，但对象是文本槽不是徽章族，故单表）：
//   **借的是色值，不是豁免资格**——voided 层在徽章族带 line-through 的对比度豁免，那条豁免的成文前提是
//   "line-through + 文案冗余"，属徽章族约束；纯文本槽不在徽章豁免表管辖，也不继承该豁免。
const NT_BORROWED_TIERS = Object.freeze([
    { cls: 'u-nt-muted', tier: 'voided', why: '借 #9ca3af 做普通弱化文本；不继承 voided 的 line-through 豁免语义。该值恰为五页现状已在用的弱化灰＝同值收编非降级' },
    { cls: 'u-nt-idle',  tier: 'legacy', why: '借 #94a3b8 做查询中占位；同上不继承豁免。同为现状在用色值' },
]);

function readComponentsCss() {
    const p = path.join(PUBLIC_DIR, 'assets', 'css', 'components.css');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

//   取"单类独占选择器"的声明块：只认 `.cls {`，不吃 `.a .cls {` / `.cls.b {` 这类组合选择器
//   （前者是共享层定义，后者可能是别处的修饰规则——混在一起数会让"定义唯一"这条断言失真）。
//   〔N1-fix〕**改为复用既有 ruleBodiesFor(:621)**，不再自写正则：初版正则
//   `(?:^|\})\s*\.cls\s*\{([^}]*)\}` 会把规则尾部的 `}` 一并吃掉，于是**相邻同名规则的第二条
//   永远匹配不到**（`.u-nt-ok{…}.u-nt-ok{…}` 只数出 1）——"定义唯一"这条断言恰恰是要抓这种双写，
//   却对最典型的双写形态盲。顺带消掉"同一件事两套实现"（本文件已有 ruleBodiesFor 做同款切分）。
function soleClassRuleBodies(cssText, cls) {
    return ruleBodiesFor(cssText, '.' + cls).map((b) => b.trim());
}

//   〔N1-fix·对照组自证〕CSS 侧检测器也要先证明"能数对"，才有资格给"定义唯一/只设 color"背书。
//   语料刻意含**相邻重复**形态——那正是初版正则漏检的那一种。
function assertCssRuleDetectorSelfTest(check) {
    const adjacent = '.u-nt-ok { color: red; }.u-nt-ok { color: blue; }';
    const spacedDup = '.u-nt-ok { color: red; }\n\n.u-nt-ok { color: blue; }';
    const single = '.u-nt-ok { color: var(--sem-done-fg); }';
    const decoy = '.u-notify-row .u-nt-ok { color: red; }\n.u-nt-ok.is-x { color: red; }\n.u-nt-okay { color: red; }';
    const rAdj = soleClassRuleBodies(adjacent, 'u-nt-ok').length;
    const rSpaced = soleClassRuleBodies(spacedDup, 'u-nt-ok').length;
    const rOne = soleClassRuleBodies(single, 'u-nt-ok').length;
    const rDecoy = soleClassRuleBodies(decoy, 'u-nt-ok').length;
    const ok = rAdj === 2 && rSpaced === 2 && rOne === 1 && rDecoy === 0;
    check(ok, 'CSS 规则检测器·对照组自证（相邻双写→2 / 空行双写→2 / 单条→1 / 后代·复合·近名→0）',
        ok ? '' : `检测器失效：相邻双写=${rAdj}(期望 2) 空行双写=${rSpaced}(期望 2) 单条=${rOne}(期望 1) 诱饵=${rDecoy}(期望 0)`
            + ` —— 数不准时"7 槽定义唯一"和"页内无重定义"两条断言都是空的`);

    // 〔N1-fix2〕属性级检测器的对照组：**改一个属性值就必须能红**，否则"原样上提"这句承诺没人守。
    //   三份坏语料对应三种真实抄错法：左对齐 / 丢 flex-basis / :empty 写成 block。
    const good = '.u-nr-read-result { flex-basis: 100%; text-align: right; }\n.u-nr-read-result:empty { display: none; }';
    const leftAlign = good.replace('text-align: right', 'text-align: left');
    const noBasis = '.u-nr-read-result { text-align: right; }\n.u-nr-read-result:empty { display: none; }';
    const emptyBlock = good.replace('display: none', 'display: block');
    const fGood = readResultRuleFacts(good);
    const fLeft = readResultRuleFacts(leftAlign);
    const fNoBasis = readResultRuleFacts(noBasis);
    const fEmptyBlock = readResultRuleFacts(emptyBlock);
    const okAttr = fGood.hasFlexBasis && fGood.hasTextAlign && fGood.emptyHasDisplayNone
        && fLeft.hasTextAlign === false && fLeft.hasFlexBasis === true
        && fNoBasis.hasFlexBasis === false
        && fEmptyBlock.emptyHasDisplayNone === false;
    check(okAttr, 'u-nr-read-result 属性级检测器·对照组自证（左对齐→红 / 丢 flex-basis→红 / :empty 改 block→红 / 正确语料→绿）',
        okAttr ? '' : `检测器失效：good=${JSON.stringify(fGood)} left.hasTextAlign=${fLeft.hasTextAlign}(期望 false)`
            + ` noBasis.hasFlexBasis=${fNoBasis.hasFlexBasis}(期望 false) emptyBlock.emptyHasDisplayNone=${fEmptyBlock.emptyHasDisplayNone}(期望 false)`
            + ` —— 只数规则条数的旧断言对这三种抄错法全绿（上提时把 right 抄成 left，条数照样是 1）`);
}

//   〔N1-fix2〕声明级判定：把规则体拆成声明逐条比，容忍空格差异，不做子串匹配
//   （子串匹配会让 `text-align: right-ish` / 注释残留这类脏值蒙混过关）。
function hasDecl(body, prop, value) {
    return String(body || '').split(';').map((d) => d.trim().replace(/\s+/g, ' ').toLowerCase())
        .filter(Boolean)
        .includes(`${prop}: ${value}`.toLowerCase());
}

//   〔N1-fix2·codex MED〕u-nr-read-result 的属性级事实（供断言与对照组共用同一套口径）。
function readResultRuleFacts(cssText) {
    const main = soleClassRuleBodies(cssText, 'u-nr-read-result');
    const empty = ruleBodiesFor(cssText, '.u-nr-read-result:empty').map((b) => b.trim());
    return {
        mainCount: main.length,
        mainBody: main[0] || '',
        hasFlexBasis: main.length === 1 && hasDecl(main[0], 'flex-basis', '100%'),
        hasTextAlign: main.length === 1 && hasDecl(main[0], 'text-align', 'right'),
        emptyCount: empty.length,
        emptyBody: empty[0] || '',
        emptyHasDisplayNone: empty.length === 1 && hasDecl(empty[0], 'display', 'none'),
    };
}

//   〔N1-fix·J13〕操作栏通知按钮补丁的**形态**检测（不只是"存在一条规则"）：
//   返回 has030=(0,3,0) 复合类形态在位；has020=遗留的 (0,2,0) 弱形态还在（与 :283 同分、赢不赢全看位置）。
function detectActionBarNbBtnPatch(cssText) {
    return {
        has030: /\.u-action-bar\s+\.u-btn-secondary\.u-nb-btn\s*\{/.test(cssText),
        has020: /\.u-action-bar\s+\.u-nb-btn\s*\{/.test(cssText),
    };
}

//   〔N1-fix·对照组自证〕**源码文本≠运行时生效**：初版补丁 `.u-action-bar .u-nb-btn` 源码里明明白白写着，
//   守卫也能 grep 到，浏览器里却被同特异性、位置更靠后的 `.u-action-bar .u-btn-secondary`(:283) 反杀——
//   "有这条规则"根本不等于"这条规则赢"。所以断言必须锁**特异性形态**而不是"有没有这么一条"。
//   对照组：喂初版 (0,2,0) 语料必须判定为"未打补丁"（能红），喂 (0,3,0) 语料才算在位。
function assertJ13PatchDetectorSelfTest(check) {
    const weak = '.u-action-bar .u-nb-btn { font-size: 11px; padding: 3px 10px; }';
    const strong = '.u-action-bar .u-btn-secondary.u-nb-btn { font-size: 11px; padding: 3px 10px; }';
    const none = '.u-nb-btn { font-size: 11px; }';
    const w = detectActionBarNbBtnPatch(weak);
    const s = detectActionBarNbBtnPatch(strong);
    const n = detectActionBarNbBtnPatch(none);
    const ok = w.has030 === false && w.has020 === true
        && s.has030 === true && s.has020 === false
        && n.has030 === false && n.has020 === false;
    check(ok, 'J13 补丁形态检测器·对照组自证（初版 0,2,0 语料→判未打补丁 / 0,3,0→在位 / 无→无）',
        ok ? '' : `检测器失效：weak=${JSON.stringify(w)} strong=${JSON.stringify(s)} none=${JSON.stringify(n)}`
            + ` —— 只查"有没有这条规则"会把被反杀的死规则judge成绿的（源码文本≠运行时生效）`);
}

//   showToast 定义检测（**AST 级**，不是正则）：
//   必须走 AST 的直接原因——Data_Collab.html 的防回潮注释里逐字写着 `function showToast`，
//   正则版会把**注释**当成第二处定义直接判红（假红）。AST 天然不含注释节点，从根上免疫。
//   覆盖三种定义形态：函数声明 / 变量声明（含箭头与函数表达式）/ 成员赋值（window.showToast = …）。
//   注意只认**赋值**不认调用：`w.showToast(msg,'error')`（u-paste.js 的共享层调用）不是定义。
//   〔N1-fix2·口径显式化〕两条边界写在这里，省得下一个人靠猜：
//     ① **偏严是有意的**：成员赋值不限于 window——`任意对象.showToast = …`（含 `UI.showToast=`、
//        `w.showToast=`）一律计入。理由是防回潮：页面完全可以挂到别的命名空间上再在页内引用，
//        那和当年 Data_Collab 页内版盖掉共享版是同一件事。误伤面（真有第三方对象恰好叫 showToast）
//        目前全站零命中；真出现时应显式登记豁免，而不是把检测面缩窄。
//     ② **已声明的检测边界**：computed 成员里只认字面量 key（`o['showToast']`）；
//        拼接/变量 key（如 `globalThis['show'+'Toast']`、`o[k]`）**不在覆盖范围**——静态分析到此为止，
//        要拦得靠 code review。写明它，是为了让"绿"的含义准确，而不是让人以为这条断言滴水不漏。
function countShowToastDefs(jsSource) {
    const parsed = parseJs(jsSource);
    if (!parsed.ok) return { ok: false, error: parsed.error, count: 0, shapes: [] };
    const shapes = [];
    walkAst(parsed.ast, (n) => {
        if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'showToast') shapes.push('function showToast(…)');
        else if (n.type === 'VariableDeclarator' && n.id && n.id.name === 'showToast') shapes.push('var/let/const showToast = …');
        // 〔N1-fix〕成员赋值两面都要认：点号 `window.showToast = fn`（computed=false，看 property.name）
        //   与方括号 `window['showToast'] = fn`（computed=true，name 是 undefined，须看 Literal 的 value）。
        //   初版只看 property.name → 方括号写法整条漏检，等于给回潮留了个后门。
        else if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'MemberExpression' && n.left.property) {
            const p = n.left.property;
            const hit = n.left.computed
                ? (p.type === 'Literal' && p.value === 'showToast')
                : p.name === 'showToast';
            if (hit) shapes.push(`<obj>${n.left.computed ? "['showToast']" : '.showToast'} = …`);
        }
    });
    return { ok: true, count: shapes.length, shapes };
}

//   〔对照组证明·guard_static_analysis_gotchas「探针必须双向证明」〕
//   只断言"终态是 1"证明不了探针在工作（一个永远返回 1 的函数也能全绿）。这里当场喂三份合成语料：
//     ① 两处真定义 → 必须数出 2（证明能检出回潮）
//     ② 只有调用 + 注释里写着 `function showToast` → 必须数出 0（证明不吃注释/调用，即上面那个假红不会发生）
//     ③ window.showToast 赋值 → 必须数出 1（证明覆盖第三种形态，不是只认 function 关键字）
function assertShowToastDetectorSelfTest(check) {
    // ⚠️ 合成语料本身必须是**合法 JS**：初版把 `function showToast(){}` 与 `const showToast = …` 放同一份，
    //   触发 redeclaration SyntaxError → 解析失败 → 计数 0，对照组当场判红把这个自造 bug 抓了出来。
    //   （这正是对照组存在的意义：它先证明了自己能红，才有资格给"终态唯一"背书。）
    //   同名函数声明重复在 sloppy script 里是**合法**的，正是"页内又写一份"回潮时的真实形态。
    const twoFns = 'function showToast(a){}\nfunction showToast(b){}';
    const varForm = 'const showToast = (b) => {};';
    const zeroDecoy = '// 禁止重新定义 showToast（守卫有"全站 function showToast 定义唯一"断言）\n'
        + '/* function showToast(x){} 这行在块注释里 */\n'
        + 'w.showToast(MSG, "error");\nshowToast("hi");';
    const oneMember = 'window.showToast = function (m) {};';
    // 〔N1-fix〕第四形态：方括号成员赋值（computed member）——初版只认点号，这种写法能整条绕过。
    const oneComputed = "window['showToast'] = function (m) {};";
    const r2 = countShowToastDefs(twoFns);
    const rv = countShowToastDefs(varForm);
    const r0 = countShowToastDefs(zeroDecoy);
    const r1 = countShowToastDefs(oneMember);
    const rc = countShowToastDefs(oneComputed);
    const allParsed = r2.ok && rv.ok && r0.ok && r1.ok && rc.ok;
    const ok = allParsed && r2.count === 2 && rv.count === 1 && r0.count === 0 && r1.count === 1 && rc.count === 1;
    check(ok, 'showToast 单源探针·对照组自证（双声明→2 / 变量式→1 / 注释+调用→0 / 点号成员→1 / 方括号成员→1）',
        ok ? '' : `探针失效：twoFns=${r2.count}(期望 2) varForm=${rv.count}(期望 1) decoy=${r0.count}(期望 0) member=${r1.count}(期望 1) computed=${rc.count}(期望 1)`
            + `${allParsed ? '' : '；有语料解析失败（合成语料必须是合法 JS）'}`
            + ` —— 探针数不对时"全站唯一"那条断言是空的（[[feedback_probe_test_bidirectional_proof]]）`);
}

function assertNotifyTextSlots(check) {
    const rawCss = readComponentsCss();
    if (rawCss === null) { check(false, 'components.css 可读', '文件不存在'); return; }
    const css = stripCssComments(rawCss);

    // ① 7 槽逐条：定义唯一 + 只设 color 一条属性 + 值必须是对应层的 fg token（零字面色值）
    const problems = [];
    for (const s of NT_SLOT_SPECS) {
        const bodies = soleClassRuleBodies(css, s.cls);
        if (bodies.length !== 1) { problems.push(`.${s.cls} 在共享层有 ${bodies.length} 条独占规则（应恰好 1 条）`); continue; }
        const decls = bodies[0].split(';').map((d) => d.trim()).filter(Boolean);
        if (decls.length !== 1) { problems.push(`.${s.cls} 含 ${decls.length} 条声明（文本槽只允许 color 一条，带 bg/border 就成徽章了）：${bodies[0]}`); continue; }
        const want = `color: var(--sem-${s.tier}-fg)`;
        const got = decls[0].replace(/\s+/g, ' ');
        if (got !== want) problems.push(`.${s.cls} 实为 \`${got}\`，应为 \`${want}\`（零新色值＝只借 14 层 token 的 fg 面）`);
    }
    check(problems.length === 0, `通知文本 7 槽 u-nt-* 覆盖声明表一致（共享层定义唯一 + 只设 color + 全 token 化）`,
        problems.length ? `${problems.length} 处：${problems.join('；')}` : '');

    // ② 零字面色值：7 条规则里不得出现 hex/rgb（防"顺手写个近似色"绕过 token）
    const litRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
    const literal = NT_SLOT_SPECS.filter((s) => soleClassRuleBodies(css, s.cls).some((b) => litRe.test(b)));
    check(literal.length === 0, '通知文本 7 槽零字面色值（只允许 var(--sem-*-fg)）',
        literal.length ? `${literal.map((s) => '.' + s.cls).join(' | ')} 内出现 hex/rgb 字面量` : '');

    // ③ 页面侧不得重定义 u-nt-*（共享层是唯一住址；页内覆盖＝又一次"同名双实现"）
    const redefined = [];
    for (const spec of PAGE_ALIAS_SPECS) {
        const html = readPage(spec.file);
        if (!html) continue;
        const styleTxt = pageStyleText(html);
        for (const s of NT_SLOT_SPECS) {
            if (soleClassRuleBodies(styleTxt, s.cls).length > 0) redefined.push(`${spec.file}:.${s.cls}`);
        }
    }
    check(redefined.length === 0, '通知文本 7 槽无页内重定义（样式单一住址＝components.css）',
        redefined.length ? `${redefined.join(' | ')} —— 页内覆盖会让共享层调 token 对这些页失效` : '');

    // ④ 借色登记表 ↔ spec 对账（同 BORROWED_TIERS 的用意：改 token 前先看谁在借）
    const drift = NT_BORROWED_TIERS.filter((b) => {
        const s = NT_SLOT_SPECS.find((x) => x.cls === b.cls);
        return !s || s.tier !== b.tier;
    });
    check(drift.length === 0, `通知文本槽借色登记与实际映射一致（${NT_BORROWED_TIERS.length} 处借色·借色值不借豁免资格）`,
        drift.length ? `${drift.map((d) => d.cls).join(' | ')} 登记层与实际层不符` : '');
    console.log(`  借色站点（文本槽）：${NT_BORROWED_TIERS.map((b) => `${b.cls}→${b.tier}`).join(' | ')}`);

    // ⑤ u-nr-read-result 上提**属性级**校验（N1-fix2·codex MED 采纳）
    //   原断言只数"有一条规则"——上提时把 `text-align: right` 抄成 `left`、或 `flex-basis` 掉了，
    //   规则条数照样是 1，断言照样绿，而结果框会紧贴按钮/左对齐（"原样上提"的承诺无人守）。
    //   现在逐属性对账：主规则两条声明齐全，`:empty` 变体单独存在且确实 display:none。
    const rr = readResultRuleFacts(css);
    check(rr.mainCount === 1 && rr.hasFlexBasis && rr.hasTextAlign,
        'u-nr-read-result 已上提 components.css 且属性完整（flex-basis:100% + text-align:right）',
        (rr.mainCount === 1 && rr.hasFlexBasis && rr.hasTextAlign) ? ''
            : `主规则 ${rr.mainCount} 条 / flex-basis:100%=${rr.hasFlexBasis} / text-align:right=${rr.hasTextAlign}`
              + ` —— 缺 flex-basis 结果框不换行会紧贴按钮，缺/错 text-align 则与通知按钮列不对齐（body 实测：${rr.mainBody || '(无)'}）`);
    check(rr.emptyCount === 1 && rr.emptyHasDisplayNone,
        'u-nr-read-result:empty 变体唯一且为 display:none（空时不占位）',
        (rr.emptyCount === 1 && rr.emptyHasDisplayNone) ? ''
            : `:empty 规则 ${rr.emptyCount} 条 / display:none=${rr.emptyHasDisplayNone}`
              + ` —— 丢了这条，未查已读时空 span 会顶掉一行、把通知时间与按钮挤位（body 实测：${rr.emptyBody || '(无)'}）`);
    const dcHtml = readPage('Data_Correction.html');
    const dcLeft = dcHtml ? soleClassRuleBodies(pageStyleText(dcHtml), 'u-nr-read-result').length : 0;
    check(dcLeft === 0, 'u-nr-read-result 页内定义已随上提删除（无双定义）',
        dcLeft ? `Data_Correction.html 页内仍有 ${dcLeft} 条 —— 双定义会在未来改共享层时产生"改了没生效"` : '');

    // ⑤b 〔通知统一 N3-fix·S6〕**结果框的页内容器侧覆盖声明表**
    //   上面 ⑤ 锁的是"共享层长什么样"，但没人管"谁在页内又把它改了一遍"。u-nr-read-result 的两条属性
    //   （flex-basis:100% / text-align:right）都是**依赖宿主容器**的：宿主得允许换行、宿主得是通知行那种
    //   窄栏，右对齐才成立。宿主形态不同的页面必然要覆盖——不登记的话，下次有人改共享层的对齐方式，
    //   根本不知道有一页在偷偷反着来（"样式单一住址"这条在容器适配面上是管不住的，只能靠登记表）。
    //   规则：**允许**带宿主前缀的容器侧覆盖（选择器不是裸 `.u-nr-read-result`），但必须在这张表里报到；
    //        **禁止**裸类覆盖（那才是抢共享层的住址，由 ⑤ 的 dcLeft 同款口径各页兜住）。
    const NR_CONTAINER_OVERRIDES = [
        {
            file: 'Sys_Iteration.html',
            selector: '.si-att-item.si-exec-row > .u-nr-read-result',
            decl: 'text-align: left',
            why: '批次执行人行宿主是 .si-att-item（nowrap flex·非 u-nr-body），且宽度是整块 siBatchOverlay：'
                + '共享层的 text-align:right 会把结果甩到离按钮很远的右边缘；同组还有 .si-att-item.si-exec-row{flex-wrap:wrap} '
                + '给 flex-basis:100% 补上换行前提。属容器侧适配，不动共享层。〔矩阵 S16「容器需单独设计」〕',
        },
    ];
    const ovProblems = [];
    for (const spec of PAGE_ALIAS_SPECS) {
        const html = readPage(spec.file);
        if (!html) continue;
        const styleTxt = pageStyleText(html);
        // ① 裸类覆盖一律判红（抢共享层住址）
        if (soleClassRuleBodies(styleTxt, 'u-nr-read-result').length > 0 && spec.file !== 'Data_Correction.html') {
            ovProblems.push(`${spec.file}：出现裸 .u-nr-read-result 覆盖（应改成带宿主前缀的容器侧写法并登记）`);
        }
        // ② 带前缀的覆盖必须已登记（按"选择器里出现 u-nr-read-result 且不是裸类"扫）
        for (const chunk of styleTxt.split('}')) {
            const bi = chunk.indexOf('{');
            if (bi === -1) continue;
            for (const sel of chunk.slice(0, bi).split(',')) {
                const s = sel.trim();
                if (!s.includes('u-nr-read-result') || s === '.u-nr-read-result' || s === '.u-nr-read-result:empty') continue;
                if (!NR_CONTAINER_OVERRIDES.some((o) => o.file === spec.file && o.selector === s)) {
                    ovProblems.push(`${spec.file}：容器侧覆盖 \`${s}\` 未登记进 NR_CONTAINER_OVERRIDES`);
                }
            }
        }
    }
    // ③ 反向：登记了却查无此条（登记表烂尾＝下一个人照着一份假清单做判断）
    for (const o of NR_CONTAINER_OVERRIDES) {
        const html = readPage(o.file);
        const bodies = html ? ruleBodiesFor(pageStyleText(html), o.selector) : [];
        if (bodies.length !== 1) { ovProblems.push(`登记项 ${o.file} \`${o.selector}\` 实测 ${bodies.length} 条（应为 1）`); continue; }
        const want = o.decl.split(':').map((x) => x.trim());
        if (!hasDecl(bodies[0], want[0], want[1])) ovProblems.push(`登记项 ${o.file} \`${o.selector}\` 缺声明 ${o.decl}（实测：${bodies[0].trim()}）`);
    }
    check(ovProblems.length === 0,
        `u-nr-read-result 页内容器侧覆盖登记齐全（${NR_CONTAINER_OVERRIDES.length} 处已登记·裸类覆盖零容忍）`,
        ovProblems.length ? ovProblems.join(' | ') : '');
    for (const o of NR_CONTAINER_OVERRIDES) console.log(`  容器侧覆盖登记：${o.file} → ${o.selector} { ${o.decl} }`);

    // ⑥ J13 特异性补丁**形态**在位（N1-fix 升级：不只查"有这条规则"，要查它赢不赢）
    //   初版断言查的是 `.u-action-bar .u-nb-btn`(0,2,0)——那条规则与 :283 的
    //   `.u-action-bar .u-btn-secondary`(0,2,0) 同分，写在它上面就被反杀，源码有、运行时无。
    //   现锁 (0,3,0) 复合类形态，并**反向禁止**弱形态残留（两者同时存在＝又一条死规则）。
    const j13 = detectActionBarNbBtnPatch(css);
    check(j13.has030, 'J13：.u-action-bar .u-btn-secondary.u-nb-btn (0,3,0) 特异性补丁在位（赢在特异性不赢在位置）',
        j13.has030 ? '' : '缺 (0,3,0) 形态补丁 → .u-action-bar .u-btn-secondary(0,2,0) 继续压制 .u-nb-btn(0,1,0)，'
            + 'Issue_Tracker 操作栏三个通知按钮的 u-nb-btn 仍是死类（守卫看得见类名、浏览器看不见效果）');
    check(!j13.has020, 'J13：无 (0,2,0) 弱形态残留（`.u-action-bar .u-nb-btn`）',
        j13.has020 ? '仍存在 `.u-action-bar .u-nb-btn` 规则 —— 它与 :283 同特异性，赢不赢全看谁写在后面，'
            + '属"看起来打了补丁其实随时退化"的死规则，应改写成 (0,3,0) 复合类形态' : '');
}

function assertShowToastSingleSource(check) {
    // 扫描面：**public 下全部 HTML 的内联脚本（现 19 个，非 PAGE_ALIAS_SPECS 的受管页子集）+ 共享 JS 目录**
    //   〔N1-fix 注释纠偏〕原写"13 个受管页"与实现不符：下面是 readdirSync(PUBLIC_DIR) 全量扫，
    //   这对本断言是**有意为之**——showToast 的回潮可能发生在任何一页（含不在别名受管名单里的
    //   admin/login 等），扫描面窄一格就等于给回潮留缝。注释按实现写，不按印象写。
    const defs = [];
    const parseFails = [];
    const jsDir = path.join(PUBLIC_DIR, 'assets', 'js');
    const jsFiles = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')) : [];
    for (const f of jsFiles) {
        const r = countShowToastDefs(fs.readFileSync(path.join(jsDir, f), 'utf8'));
        if (!r.ok) { parseFails.push(`assets/js/${f}: ${r.error}`); continue; }
        r.shapes.forEach((sh) => defs.push(`assets/js/${f} → ${sh}`));
    }
    for (const f of fs.readdirSync(PUBLIC_DIR).filter((x) => x.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
        const src = inlineScriptSource(html);
        if (!src.trim()) continue;
        const r = countShowToastDefs(src);
        if (!r.ok) { parseFails.push(`${f}(内联): ${r.error}`); continue; }
        r.shapes.forEach((sh) => defs.push(`${f} → ${sh}`));
    }
    check(parseFails.length === 0, 'showToast 单源扫描面全部可解析（解析失败=盲区，不能当通过）',
        parseFails.length ? parseFails.join(' | ') : '');
    const onlyApp = defs.length === 1 && defs[0].startsWith('assets/js/app.js');
    check(onlyApp, `全站 showToast 定义唯一（实测 ${defs.length} 处·口径：函数声明/变量声明/任意对象属性赋值）`,
        onlyApp ? '' : `定义点：${defs.join(' | ') || '(零处——共享版被删了？)'} —— 同名双实现会按加载顺序静默覆盖`
            + `（D7 之前 Data_Collab 页内版就是这样盖掉共享版的：单例顶替/2.4s/不可点/info 映琥珀四处行为分叉）。`
            + `本断言口径**偏严**：不限 window，任意对象的 showToast 属性赋值都算定义（防换个命名空间回潮）；`
            + `**检测边界**：computed key 只认字面量，拼接/变量 key（globalThis['show'+'Toast'] 之类）静态分析拦不住，属已声明盲区`);
    console.log(`  showToast 定义点：${defs.join(' | ') || '(无)'}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 〔通知统一 N5-5a〕守卫终扩（六项 + 两条通用口径）
//   真相源＝锚点 §6 N5 守卫/断言清单 + 改动点矩阵 §6.5 函数名单 + 冻结映射表 §1。
//   每一项都配**对照组自证**：光证"现在是绿的"没有意义，必须证"坏成什么样这条会红"。
// ══════════════════════════════════════════════════════════════════════════════

// 五页通知域函数名单（矩阵 §6.5·J24 按函数圈不按类名圈——u-notify-row 在 DCorr:1468 被非通知区复用）
const NOTIFY_DOMAIN_FNS = Object.freeze({
    'Sys_Iteration.html': ['siNotifyStatusText', 'siNotifyRowHtml', 'siRenderDevNotifyRows', 'siRenderRelayNotifyRow',
        'siRenderCreatorNotifyRow', 'siRenderHoldCreatorNotifyRow', 'siRenderResumeNotifyRow', 'siRenderIntakeNotifyRow',
        'siRenderLiaisonTestNotifyRow', 'siRenderReleaseExecutorNotifyRow', 'siRenderRequesterNotifyRow',
        'siRenderTechLeadNotifyRow', 'siRenderNotify', 'siExecutorSectionHtml', 'siQueryReadStatus',
        'siExecutorRowReadStatus', 'siTechLeadNotifyBadgeHtml'],
    'Data_Collab.html': ['renderContactNotifySubsection', 'renderDeveloperNotifySubsection', 'renderExpectedEstimateSection',
        'renderRequesterDoneNotifySection', 'renderAdminDirectActionsSection', 'triggerNotify', 'notifyRequesterDone',
        'notifyExpected', 'checkReadStatus'],
    'Data_Correction.html': ['buildNotifyRow', 'queryReadStatus', 'notifySend', 'notifyReasonText'],
    'Issue_Lite.html': ['buildNotifyRow', 'notifyRead', 'notifySend'],
    'Issue_Tracker.html': ['checkIssueReadStatus', 'notifyAction', 'notifyRequesterDone', 'itNotifyReadSection'],
});

// 页内 <script>（无 src）正文；stripJsComments 用于所有"数代码里的东西"的场景。
function pageScriptText(html) {
    return [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
}
//   ⚠️ 先剥块注释再剥行注释；`//` 判定要求前面不是 `:`（躲开 `https://`）也不在字符串里的粗判——
//   本文件所有 emoji/透传/内联色断言都必须走它，"注释里写了个 ❌ 就判红"是上一轮真实踩过的假阳性。
function stripJsComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
// 取某个具名函数的函数体（按缩进收尾，与各页写法一致：顶层函数的收尾 `}` 缩进 4 或 8 空格）
function grabFnBody(src, fnName) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + fnName + '\\s*\\(', 'g');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index;
    const openIdx = src.indexOf('{', re.lastIndex - 1);
    if (openIdx < 0) return null;
    const indent = (src.slice(0, start).match(/[^\n]*$/) || [''])[0];
    const closer = '\n' + indent + '}';
    const end = src.indexOf(closer, openIdx);
    return end < 0 ? src.slice(start) : src.slice(start, end + closer.length);
}

// 〔N5-5a·通用口径一〕**调用点计数必须排除定义**。
//   固化动因：本轮 agent 在 siNotifyErr / siRefreshQuiet / anomalyNoteRO 上**连踩三次**同一个坑——
//   `src.match(/fn\(/g).length` 把 `function fn(` 也数了进去，而"定义 1 + 调用点 N-1"往往恰好凑成
//   期望值 N ⇒ **断言为错误的理由而绿**（[[feedback_test_assertion_self_error]] 里最难发现的一种）。
//   本文件此后一切"数调用点"一律走本函数，禁止再手写正则计数（下方有守卫盯着）。
function countCallSites(src, fnName) {
    const re = new RegExp('(?:^|[^\\w.$])' + fnName + '\\s*\\(', 'g');
    let cnt = 0, m;
    while ((m = re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, m.index - 40), m.index + (m[0].length - fnName.length - 1));
        if (/\bfunction\s+$/.test(before)) continue;           // function fn(
        if (new RegExp('\\b(const|let|var)\\s+' + fnName + '\\s*=\\s*$').test(before)) continue;  // const fn = (
        cnt++;
    }
    return cnt;
}
function assertCountCallSitesSelfTest(check) {
    const sample = 'function foo(a){}\nconst bar = (x)=>foo(x);\nfoo(1); await foo(2); obj.foo(3); notfoo(4);';
    const got = countCallSites(sample, 'foo');
    check(got === 3, '★通用口径一·检测器对照组：countCallSites 排除定义、排除同名成员/前缀词（语料含 1 定义 + 3 真调用 + obj.foo + notfoo）',
        `实测 ${got}（期望 3：foo(x)/foo(1)/foo(2)；obj.foo 与 notfoo 不算）`);
    const naive = (sample.match(/foo\(/g) || []).length;
    check(naive !== got, '★通用口径一·反向对照：朴素正则计数与本函数结果**必须不同**（相同说明语料没覆盖到定义/成员那两类，断言等于没测）',
        `朴素=${naive} / 守卫=${got}`);
}

// 〔N5-5a·②〕选择器 × 渲染串双向对拍
//   五页把"按钮选择器"和"onclick 渲染串"分写两处，改一处忘另一处＝B1/J23/R3 三条防线一起静默失效
//   （DCorr notifySend 前缀匹配、Collab triggerNotify、SI 九个通知按钮都踩在这条线上）。
//   三页三种写法（**实测，不是照印象写**）：SI 用 `[onclick="fn()"]` 全等；DCorr 用 `[onclick^=` 前缀；
//   Collab 用 `[onclick*=` 包含。后两种都属"非全等"⇒ 必须验右界符。
const SELECTOR_PAIRS = Object.freeze([
    { file: 'Sys_Iteration.html', sel: /\.u-nb-btn\[onclick="(si[A-Za-z]+)\(/g, exact: true },
    { file: 'Data_Correction.html', sel: /\.u-nb-btn\[onclick\^="(notifySend)\(/g, exact: false },
    { file: 'Data_Collab.html', sel: /\[onclick\*="(triggerNotify|notifyRequesterDone|notifyExpected)\(/g, exact: false },
]);
function assertSelectorRenderPairs(check) {
    const problems = [];
    let pairs = 0, prefixSels = 0;
    for (const spec of SELECTOR_PAIRS) {
        const html = readPage(spec.file);
        if (!html) { problems.push(`${spec.file} 缺失`); continue; }
        const js = pageScriptText(html);
        const code = stripJsComments(js);
        const re = new RegExp(spec.sel.source, 'g');
        let m, seen = 0;
        while ((m = re.exec(code)) !== null) {
            seen++; pairs++;
            const fn = m[1];
            // ① 反向：选择器指向的函数，渲染侧必须真有 `onclick="fn(` 的输出串
            if (!code.includes('onclick="' + fn + '(')) problems.push(`${spec.file}：选择器指向 ${fn}，但渲染侧无 onclick="${fn}(" 输出串`);
            // ② 前缀型选择器必须带**右界符**（`,` 或 `)`）——`siNotifyDevSend(1` 是 `…(12)` 的前缀，
            //    无右界符会一次锁两行（DCorr 多业务方 done 行的原始事故形态）
            if (!spec.exact) {
                const tail = code.slice(m.index, m.index + 220);
                const q = tail.indexOf('"]');
                const body = q > 0 ? tail.slice(0, q) : tail;
                if (!/[,)]\s*"\]/.test(tail.slice(0, q + 2)) && !/[,)]$/.test(body)) {
                    problems.push(`${spec.file}：前缀选择器 \`${body.slice(0, 60)}\` 未以 , 或 ) 收尾（会误匹更长的 id/参数）`);
                }
                prefixSels++;
            }
        }
        if (seen === 0) problems.push(`${spec.file}：一个按钮选择器都没抓到（扫描面落空＝守卫失效，不能当通过）`);
    }
    check(problems.length === 0, `②选择器×渲染串双向对拍（${pairs} 对·其中前缀型 ${prefixSels} 个逐个验右界符）`,
        problems.length ? problems.join(' | ') : '');
}
function assertSelectorPairDetectorSelfTest(check) {
    // 对照组：无右界符的前缀选择器必须被判出来
    const badSample = 'const s = `.u-nb-btn[onclick^="notifySend(${id}, \'${r}\'"]`;\nconst h = `<button onclick="notifySend(1)">x</button>`;';
    const hit = /[,)]\s*"\]/.test(badSample);
    check(!hit, '★②检测器对照组：缺右界符的前缀选择器语料**不**满足右界符判据（判据真在工作，不是恒真）');
    const goodSample = 'const s = `.u-nb-btn[onclick^="notifySend(${id}, \'${r}\', ${f},"]`;';
    check(/[,)]\s*"\]/.test(goodSample), '★②检测器对照组：带右界符的语料满足判据');
}

// 〔N5-5a·①〕onclick 实参个数与函数签名对齐
//   B1 事故：DCorr 渲染串是 `notifySend(1, 'dev', false, {fromDrawer:true})`＝4 实参，而签名是
//   `(id, recipient, force, requesterId, opts)` ⇒ opts 落在 requesterId 位、`o.fromDrawer` 恒假
//   ⇒ 五个通道里四个的 A 类删除**静默没生效**。判据分两类：静态实参串直接数；含 `${…}` 可展开成
//   多个实参的（DCorr 的 ridArg）无法静态定长 ⇒ 必须有**归一化行**兜住，登记在册。
const ARITY_SPECS = Object.freeze([
    { file: 'Data_Correction.html', fn: 'notifySend', params: 5,
      normalizer: /if \(requesterId && typeof requesterId === 'object'\) \{ opts = requesterId; requesterId = undefined; \}/,
      why: '渲染侧 ridArg 只在 done 通道非空 ⇒ 实参个数在 4/5 之间浮动，靠函数体首行按类型归一（B1 修法）' },
]);
function assertOnclickArity(check) {
    const problems = [];
    for (const spec of ARITY_SPECS) {
        const html = readPage(spec.file);
        if (!html) { problems.push(`${spec.file} 缺失`); continue; }
        const code = stripJsComments(pageScriptText(html));
        const decl = new RegExp('(?:async\\s+)?function\\s+' + spec.fn + '\\s*\\(([^)]*)\\)').exec(code);
        if (!decl) { problems.push(`${spec.file}：找不到 ${spec.fn} 声明`); continue; }
        const declared = decl[1].split(',').map((s) => s.trim()).filter(Boolean).length;
        if (declared !== spec.params) problems.push(`${spec.file}：${spec.fn} 形参 ${declared} 个，登记表写 ${spec.params} 个（签名变了就得回来改登记）`);
        if (!spec.normalizer.test(code)) problems.push(`${spec.file}：${spec.fn} 的实参归一化行不在了（B1 会复活：opts 落进 requesterId 位、A 类删除静默失效）`);
        // 渲染侧 onclick 串的**最少**实参数：静态逗号计数（模板占位不拆）
        const calls = [...code.matchAll(new RegExp('onclick="' + spec.fn + '\\(([^"]*)\\)"', 'g'))];
        if (calls.length === 0) problems.push(`${spec.file}：抓不到 ${spec.fn} 的 onclick 渲染串（扫描面落空）`);
        for (const c of calls) {
            const argc = c[1].split(',').length;
            if (argc > declared) problems.push(`${spec.file}：onclick 实参 ${argc} 个 > 形参 ${declared} 个（多出来的会被静默丢弃）`);
        }
    }
    check(problems.length === 0, `①onclick 实参个数与签名对齐（${ARITY_SPECS.length} 个浮动实参函数逐个验归一化行 + 渲染串实参上界）`,
        problems.length ? problems.join(' | ') : '');
}

// 〔N5-5a·③〕跨页共享码文案逐字对账（冻结映射表 §1 十六码 × 四页常量）
const SHARED_CODE_TEXT = Object.freeze({
    REQUESTER_PHONE_EMPTY: '业务方未填手机号', REQUESTER_INVALID: '业务方手机号查不到企业钉钉号',
    REQUESTER_LOOKUP_FAILED: '业务方钉钉号查询失败', DINGTALK_NOT_CONFIGURED: '钉钉配置未填写',
    NO_DINGTALK_CONFIG: '钉钉配置未填写', DINGTALK_TOKEN_FAILED: '钉钉鉴权失败',
    NOTIFY_SENT_BUT_DB_UPDATE_FAILED: '已发送但留痕失败（请勿重发）',
    RECIPIENT_CHANGED_DURING_SEND: '发送期间收件人手机号已变更，状态未记录',
    PATH_VIOLATION: '附件路径非法', STATUS_NOT_NOTIFIABLE: '当前状态不可通知',
    INVALID_STATE_FOR_NOTIFY: '当前状态不可通知', NOT_AUTHORIZED_TO_NOTIFY: '无权发送该通知',
    INVALID_RECIPIENT: '收件人参数无效', NOT_NOTIFIED: '尚未成功通知', NO_MESSAGE_KEY: '缺少消息标识',
});
//   `NOTIFY_PARTIAL_FAILURE` 不入本表：§1 对它只写「按 failed_step 取」、从不给基值 ⇒ 任何页出现基值
//   都是自创文案（N4-fix·D-9 已按此把 Collab 那条删掉），下面单列一条反向断言盯着它不要复活。
const REASON_SHARED_TEXT = Object.freeze({
    requester_invalid: '业务方手机号查不到企业钉钉号',   // §7.2·N4-fix 起 Collab 也消费
    lookup_failed: '钉钉号查询失败', token_failed: '钉钉鉴权失败',
    send_failed: '钉钉发送失败', send_exception: '发送异常',
});
const ERR_CONST_NAMES = Object.freeze({
    'Data_Collab.html': ['COLLAB_ERR_TEXT', 'COLLAB_REASON_TEXT'],
    'Data_Correction.html': ['CORRECTION_ERR_TEXT', 'CORRECTION_REASON_TEXT'],
    'Issue_Lite.html': ['IL_ERR_TEXT', 'IL_REASON_TEXT'],
    'Issue_Tracker.html': ['IT_ERR_TEXT', 'IT_REASON_TEXT'],
    'Sys_Iteration.html': ['SI_ERR_TEXT', 'SI_REASON_TEXT'],
});
function grabConstBody(code, name) {
    const i = code.indexOf('const ' + name + ' = Object.freeze({');
    if (i < 0) return null;
    const j = code.indexOf('});', i);
    return j < 0 ? null : code.slice(i, j);
}
function parseMapEntries(body) {
    const out = {};
    if (!body) return out;
    for (const m of body.matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
    return out;
}
function assertSharedCodeTexts(check) {
    const problems = [];
    let checked = 0, pagesSeen = 0;
    for (const [file, names] of Object.entries(ERR_CONST_NAMES)) {
        const html = readPage(file);
        if (!html) { problems.push(`${file} 缺失`); continue; }
        const code = stripJsComments(pageScriptText(html));
        let anyConst = false;
        for (const cn of names) {
            const body = grabConstBody(code, cn);
            if (!body) continue;
            anyConst = true;
            const entries = parseMapEntries(body);
            const table = cn.endsWith('REASON_TEXT') ? REASON_SHARED_TEXT : SHARED_CODE_TEXT;
            for (const [k, want] of Object.entries(table)) {
                if (!(k in entries)) continue;              // 该页不消费这个码＝允许（§1「使用页面」列）
                checked++;
                if (entries[k] !== want) problems.push(`${file}·${cn}.${k}＝「${entries[k]}」≠ 冻结表「${want}」`);
            }
            if (cn.endsWith('ERR_TEXT') && 'NOTIFY_PARTIAL_FAILURE' in entries) {
                problems.push(`${file}·${cn} 出现 NOTIFY_PARTIAL_FAILURE 基值「${entries.NOTIFY_PARTIAL_FAILURE}」——§1 只写「按 failed_step 取」，基值属自创文案（D-9 已删过一次，别复活）`);
            }
        }
        if (anyConst) pagesSeen++; else problems.push(`${file}：一个 *_ERR_TEXT/*_REASON_TEXT 常量都没抓到（扫描面落空）`);
    }
    check(problems.length === 0, `③跨页共享码文案逐字对账（${pagesSeen} 页 × 命中 ${checked} 条·含 requester_invalid 跨页同文案）`,
        problems.length ? problems.join(' | ') : '');
    return checked;
}

// 〔N5-5a·④〕后端原文透传：判红面**收窄为通知域函数名单**（裁定 3③）
//   全站判红会把 60+ 个非通知 CRUD 的 `data.error` 直出一并打红——那些端点的码不在冻结表内，
//   接表反而信息倒退。故只在通知域函数体内禁。
const PASSTHROUGH_PAT = /\b(?:data|d|r\.data)\.(?:detail|errmsg)\b|\berr\.message\b/;
const PASSTHROUGH_EXEMPT = Object.freeze({
    // 白名单唯一出口：Collab notify-error-box 四字段（J8/H2 冻结口径）——它在 triggerNotify 内，
    //   走 collabWhitelistField（转义 + Unicode 截 200 + 裁定⑬ 来源过滤），是**登记在册的例外**。
    'Data_Collab.html::triggerNotify': 'notify-error-box 四字段白名单（§9.4）',
});
function assertNotifyDomainNoPassthrough(check) {
    const problems = [];
    let scanned = 0;
    for (const [file, fns] of Object.entries(NOTIFY_DOMAIN_FNS)) {
        const html = readPage(file);
        if (!html) continue;
        const code = stripJsComments(pageScriptText(html));
        for (const fn of fns) {
            const body = grabFnBody(code, fn);
            if (!body) continue;
            scanned++;
            if (PASSTHROUGH_EXEMPT[`${file}::${fn}`]) continue;
            if (PASSTHROUGH_PAT.test(body)) problems.push(`${file}·${fn} 内出现后端原文透传（detail/errmsg/err.message）`);
        }
    }
    check(problems.length === 0, `④「detail 判红」收窄为通知域（扫 ${scanned} 个函数体·白名单例外 ${Object.keys(PASSTHROUGH_EXEMPT).length} 处登记在册）`,
        problems.length ? problems.join(' | ') : '');
    check(scanned >= 30, `④扫描面非空校验：通知域函数体实抓 ${scanned} 个（抓不到＝守卫空转，不能当通过）`);
}

// 〔N5-5a·⑤〕emoji 收编守卫：**先剥注释**，逐字符串 includes，**禁正则字符类**
//   两条教训都在这：① 注释里的 👀/⏰/❌ 是解释文字不是 UI 文案，扫全文会假阳性（本轮真踩过）；
//   ② 正则字符类 `[👀⏰❌]` 会把 astral 字符拆成代理对，`[👀…]` 之间互相组合出假命中。
const BANNED_EMOJI = Object.freeze(['👀', '⏰', '❌', '📣']);
function assertNotifyEmoji(check) {
    const problems = [];
    let scanned = 0;
    for (const [file, fns] of Object.entries(NOTIFY_DOMAIN_FNS)) {
        const html = readPage(file);
        if (!html) continue;
        const code = stripJsComments(pageScriptText(html));
        for (const fn of fns) {
            const body = grabFnBody(code, fn);
            if (!body) continue;
            scanned++;
            for (const e of BANNED_EMOJI) {
                if (body.includes(e)) problems.push(`${file}·${fn} 内残留 ${e}`);
            }
        }
    }
    check(problems.length === 0, `⑤通知域 emoji 收编（扫 ${scanned} 个函数体 × ${BANNED_EMOJI.length} 个禁用符·剥注释先行·字符串 includes）`,
        problems.length ? problems.join(' | ') : '');
}
function assertEmojiDetectorSelfTest(check) {
    const withComment = "// 这里解释一下 👀 的收编\nconst s = '⏳ 尚未读取';";
    const stripped = stripJsComments(withComment);
    check(!stripped.includes('👀') && stripped.includes('⏳ 尚未读取'),
        '★⑤检测器对照组：剥注释后注释里的 👀 消失、代码里的文案保留（防"注释提了一嘴就判红"的假阳性）');
    const live = "const s = '👀 尚未读取';";
    check(stripJsComments(live).includes('👀'), '★⑤检测器对照组：真代码里的 👀 剥注释后**仍在**（判据没被剥过头）');
    // 禁正则字符类：证明字符类写法会产生假命中
    const classRe = new RegExp('[👀⏰]');
    check(classRe.test('💡'), '★⑤检测器对照组：正则字符类对 astral 字符会**假命中**（此处用一个完全无关的 💡 触发）——故本守卫一律用字符串 includes');
}

// 〔N5-5a·⑥〕J24：通知渲染函数内禁**新增**内联色值
//   基线口径＝当前实测值登记在册，只允许降不允许升（新增一处即红）；显式排除项单列理由。
//   基线**逐函数逐色值登记**，不是一个总数——总数式基线挡不住"换掉一个合法项、塞进一个违规项"
//   （数目不变、守卫照绿）。下表每一格都要说得出"这个色为什么可以留"，说不出的就是该改的。
//   ⚠️ 表里的数字全部**现场实测得来**（初版凭印象写了 Collab=4/IT=0，一跑就红——
//     [[feedback_verify_absolute_claims]]：绝对数字是论据不是描述，落笔前必须回真相源量）。
const INLINE_COLOR_BASELINE = Object.freeze({
    'Sys_Iteration.html': {},
    'Data_Collab.html': {
        renderContactNotifySubsection: { n: 1, why: '区标签「对接人通知」#64748b —— 矩阵 C9 明列不换' },
        renderDeveloperNotifySubsection: { n: 1, why: '区标签「开发通知」#64748b —— C9' },
        renderExpectedEstimateSection: { n: 2, why: '区标签「开发回填」「通知需求方·预计完成」#64748b —— C9' },
        renderRequesterDoneNotifySection: { n: 2, why: '<h4> 区标题 #374151 ×2 —— 区块标题非状态文本' },
        renderAdminDirectActionsSection: { n: 1, why: '改派历史折叠区 #888 —— 非通知状态文本' },
        triggerNotify: { n: 2, why: 'notify-error-box **结构配色** #92400e/#b91c1c —— §6.5 显式排除（错误框自身配色，不是 7 槽状态文本）' },
    },
    'Data_Correction.html': {},
    'Issue_Lite.html': {},
    'Issue_Tracker.html': {
        itNotifyReadSection: { n: 1, why: '区块 label「通知已读状态」#6b7280 —— Q7 登记（区块标签非状态文本）' },
    },
});
function assertJ24NoInlineColor(check) {
    const problems = [];
    let total = 0, registered = 0;
    for (const [file, fns] of Object.entries(NOTIFY_DOMAIN_FNS)) {
        const html = readPage(file);
        if (!html) continue;
        const code = stripJsComments(pageScriptText(html));
        const base = INLINE_COLOR_BASELINE[file] || {};
        registered += Object.values(base).reduce((a, b) => a + b.n, 0);
        for (const fn of fns) {
            const body = grabFnBody(code, fn);
            if (!body) continue;
            const n = (body.match(/color\s*:\s*#[0-9a-fA-F]{3,8}/g) || []).length;
            total += n;
            const want = base[fn] ? base[fn].n : 0;
            if (n > want) problems.push(`${file}·${fn}：内联色 ${n} 处 > 登记 ${want} 处（J24 禁新增；要留就把理由写进基线表）`);
            if (n < want) problems.push(`${file}·${fn}：实测 ${n} < 登记 ${want} —— 少了是好事，但**基线表要同步下调**，否则守卫从此松一格`);
        }
    }
    check(problems.length === 0, `⑥J24 通知渲染函数禁新增内联色（实测 ${total} 处 / 登记豁免 ${registered} 处·逐函数逐条带理由）`,
        problems.length ? problems.join(' | ') : '');
    check(total === registered, `⑥总量对账：实测 ${total} ≡ 登记 ${registered}（逐函数已比对，此条防"基线表漏了某个函数"）`);
}

// 〔N5-5a·通用口径二〕共享槽类「**真生效**」断言（死类家族两例的机制固化）
//   已发生两例："源码有类名、浏览器不认" —— ① IT `.u-action-bar .u-btn-secondary`(0,2,0) 压死
//   `.u-nb-btn`(0,1,0)（J13，已单独打补丁）；② Collab `.notify-status-text`(0,1,0) 与 `.u-nt-*`(0,1,0)
//   **同特异性**，而页内 <style> 写在 components.css link **之后** ⇒ 靠源序页内胜出，11 处槽类集体失效
//   （N4-fix·D-2 才挖出来）。本断言把②那条机制固化：
//   凡与 `u-nt-*` **同挂在一个 class 属性上**的其他类，页内不得有"单类选择器 + 设 color"的规则。
function assertSharedSlotEffective(check) {
    const problems = [];
    let mounts = 0, pagesWithMounts = 0;
    for (const file of Object.keys(NOTIFY_DOMAIN_FNS)) {
        const html = readPage(file);
        if (!html) continue;
        const styleTxt = pageStyleText(html);
        // 前提复核：页内 <style> 确实在 components.css link 之后（同特异性时页内胜出的前提）
        const linkIdx = html.search(/<link[^>]+components\.css/i);
        const styleIdx = html.search(/<style\b/i);
        const pageWinsOnTie = linkIdx >= 0 && styleIdx > linkIdx;
        const co = new Set();
        for (const m of html.matchAll(/class="([^"]*\bu-nt-[a-z]+\b[^"]*)"/g)) {
            mounts++;
            for (const cls of m[1].split(/\s+/)) {
                if (!cls || /^u-nt-/.test(cls) || cls.includes('${')) continue;
                co.add(cls);
            }
        }
        if (co.size) pagesWithMounts++;
        for (const cls of co) {
            const bodies = soleClassRuleBodies(styleTxt, cls);
            for (const b of bodies) {
                if (/(^|;)\s*color\s*:/.test(b)) {
                    problems.push(`${file}：页内单类规则 \`.${cls}\` 设了 color，且与它同挂一个 class 属性的 u-nt-* 同特异性` +
                        `${pageWinsOnTie ? '、页内 <style> 又在 components.css 之后 ⇒ **槽类是死类**' : ''}（规则体：${b.trim().slice(0, 60)}）`);
                }
            }
        }
    }
    check(problems.length === 0, `⑧共享槽类真生效（扫 ${mounts} 个 u-nt-* 挂载点 / ${pagesWithMounts} 页有同属性共挂类·禁同特异性页内 color 覆盖）`,
        problems.length ? problems.join(' | ') : '');
    check(mounts >= 40, `⑧扫描面非空校验：u-nt-* 挂载点实抓 ${mounts} 个`);
}
function assertSharedSlotDetectorSelfTest(check) {
    // 对照组：还原 N4-fix 之前的形态（.notify-status-text 带 color）必须被判红
    const fakeStyle = '.notify-status-text { font-size: 13px; color: #4b5563; margin-right: 12px; }';
    const bodies = soleClassRuleBodies(fakeStyle, 'notify-status-text');
    check(bodies.length === 1 && /(^|;)\s*color\s*:/.test(bodies[0]),
        '★⑧检测器对照组（修前形态）：`.notify-status-text{…color…}` 语料被判据命中 ⇒ 这条守卫真能抓到 D-2 那个死类家族');
    const fixed = '.notify-status-text { font-size: 13px; margin-right: 12px; }';
    const b2 = soleClassRuleBodies(fixed, 'notify-status-text');
    check(b2.length === 1 && !/(^|;)\s*color\s*:/.test(b2[0]), '★⑧检测器对照组（修后形态）：去掉 color 后不再命中（判据不是恒真）');
}

// 通用口径一的**落地校验**：本文件 N5 段自己不许手写朴素计数正则
function assertNoNaiveCallCount(check) {
    const self = fs.readFileSync(__filename, 'utf8');
    const seg = self.slice(self.indexOf('通知统一 N5-5a〕守卫终扩'));
    const naive = [...seg.matchAll(/\.match\(new RegExp\('[a-zA-Z]+\\\(/g)].length
        + [...seg.matchAll(/\.match\(\/[a-zA-Z]{4,}\\\(\/g\)/g)].length;
    check(naive === 0, '★通用口径一·落地：N5 段内零"朴素函数名计数正则"（数调用点一律走 countCallSites）',
        naive ? `发现 ${naive} 处手写计数` : '');
}

function runNotifyUnifyN5Assertions(check) {
    console.log('--- N5-5a：检测器对照组自证（先证判据会红，再谈它绿）---');
    assertCountCallSitesSelfTest(check);
    assertSelectorPairDetectorSelfTest(check);
    assertEmojiDetectorSelfTest(check);
    assertSharedSlotDetectorSelfTest(check);
    console.log('');
    console.log('--- N5-5a：六项守卫 + 两条通用口径 ---');
    assertOnclickArity(check);
    assertSelectorRenderPairs(check);
    assertSharedCodeTexts(check);
    assertNotifyDomainNoPassthrough(check);
    assertNotifyEmoji(check);
    assertJ24NoInlineColor(check);
    assertNoNaiveCallCount(check);
    assertSharedSlotEffective(check);
    console.log('');
}

function runNotifyUnifyN1Assertions(check) {
    console.log('--- 通知统一 N1：检测器对照组自证（CSS 侧 / J13 形态）---');
    assertCssRuleDetectorSelfTest(check);
    assertJ13PatchDetectorSelfTest(check);
    console.log('');
    console.log('--- 通知统一 N1：文本 7 槽 + 结果框上提 + J13 补丁 ---');
    assertNotifyTextSlots(check);
    console.log('');
    console.log('--- 通知统一 N1：showToast 单源（含对照组自证）---');
    assertShowToastDetectorSelfTest(check);
    assertShowToastSingleSource(check);
    console.log('');
}

function runSecondaryFamilyAssertions(check) {
    for (const spec of SECONDARY_FAMILY_SPECS) {
        console.log(`--- ${spec.family} ---`);
        assertSecondaryFamily(check, spec);
        console.log('');
    }
    console.log('--- 借色站点登记表（M10）---');
    assertBorrowedTiersRegistry(check);
    console.log('');
}

function runBadgeAliasAssertions(check) {
    for (const spec of PAGE_ALIAS_SPECS) {
        const isSem = spec.mode === 'sem';
        console.log(`--- ${spec.file}（${isSem ? '状态徽章 sem 模式收编' : '状态徽章别名接线'}）---`);
        if (isSem) assertSemModePage(check, spec);
        else assertPageAliases(check, spec);
        console.log('');
    }
    console.log(String.fromCharCode(10) + '=== 口径二·族级断言（S5a：通知/类型/次级族）===' + String.fromCharCode(10));
    runSecondaryFamilyAssertions(check);
    console.log(String.fromCharCode(10) + '=== 通知统一 N1·共享层断言（u-nt-* 七槽 / 结果框上提 / J13 / showToast 单源）===' + String.fromCharCode(10));
    runNotifyUnifyN1Assertions(check);
    console.log(String.fromCharCode(10) + '=== 通知统一 N5-5a·守卫终扩（六项 + 两条通用口径·全部带对照组）===' + String.fromCharCode(10));
    runNotifyUnifyN5Assertions(check);
}

// 〔B9〕给 verify-unify-static.js 用：判定某个源里有没有"真的输出某个 class"的证据。
//   两条证据面，任一命中即算有输出点：
//     · HTML 正文的 class 属性（走 B-M3 的属性区解析，不会被 <style> 里的选择器满足）
//     · JS 里的 class sink（模板/拼接/innerHTML/className/setAttribute/classList）静态文本含该 token
//   为什么要单列：原实现拿"全文出现过这个词"当输出点证据，而 CSS 定义里必然出现同一个词，
//   于是"页内重定义"这条证据把"仍有输出点"那条也一并喂绿了——两条断言其实只有一条在工作。
//   〔B9·S4-fix3〕证据必须以**真实 DOM 写入**为根，不能拿"文件里有这么一段字符串"当数。
//   独立死字符串（谁都没用的一段 HTML 常量）不是渲染证据；反过来，真实链路常常绕好几道：
//     Asset_Center：`renderStatusBadge()` 返回带 class 的模板 → 被别的模板插值 → 赋给 innerHTML
//     Domain_Manager：`tbody.innerHTML = domains.map(d => { const b = 三元两条字面量; return \`…${b}…\` })`
//   故做法是：从 DOM 写入点出发做**受限可达性**——沿表达式子树走（回调、模板插值天然在子树内），
//   遇到调用本地具名函数就把那个函数体也纳入（深度与环受限），在可达范围内扫 class 属性静态文本。
const OUTPUT_FOLLOW_DEPTH = 4;

function domWriteRootsOf(ast) {
    const roots = [];
    walkAst(ast, (n) => {
        if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'MemberExpression' && n.left.property) {
            const prop = n.left.computed
                ? (n.left.property.type === 'Literal' ? String(n.left.property.value) : null)
                : n.left.property.name;
            if (prop === 'innerHTML' || prop === 'outerHTML' || prop === 'className') roots.push(n.right);
            return;
        }
        if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression' && n.callee.property) {
            const fn = n.callee.computed
                ? (n.callee.property.type === 'Literal' ? String(n.callee.property.value) : null)
                : n.callee.property.name;
            if (fn === 'insertAdjacentHTML' && n.arguments.length >= 2) roots.push(n.arguments[1]);
            else if (fn === 'setAttribute' && n.arguments.length >= 2
                && n.arguments[0].type === 'Literal' && String(n.arguments[0].value).toLowerCase() === 'class') roots.push(n.arguments[1]);
            else if ((fn === 'add' || fn === 'toggle' || fn === 'replace')
                && n.callee.object && n.callee.object.type === 'MemberExpression'
                && n.callee.object.property && n.callee.object.property.name === 'classList') roots.push(...n.arguments);
        }
    });
    return roots;
}

// 从一个写入根出发，收集**可达**的 class 属性静态文本 + 直接的 class 值字面量
function reachableClassTexts(rootExpr, ast, srcIdx, depth, seenFns, out) {
    if (!rootExpr || depth > OUTPUT_FOLLOW_DEPTH) return out;
    // 本子树里的 class 属性（模板 / 拼接 / 纯静态串都算——它们就长在写入链上）
    walkAst(rootExpr, (n) => {
        if (n.type === 'TemplateLiteral' || (n.type === 'BinaryExpression' && n.operator === '+')
            || (n.type === 'Literal' && typeof n.value === 'string')) {
            for (const sk of classAttrSinksFromParts(expressionToParts(n))) out.push(sk.staticText || '');
            if (n.type === 'Literal') out.push(n.value);          // classList.add('x') / className = 'x' 形态
        }
        // 调用本地具名函数 → 只沿**可达 return 表达式**传播（Asset_Center 的 renderStatusBadge 这一跳）
        //   〔S4-fix4·B9〕原来是把整个函数体丢进去遍历——那等于说"这个函数体里出现过的任何字符串，
        //   都算它的返回值"。helper 里躺着一段没人用的死串（早年注掉的模板、备用文案）也会被当成
        //   渲染证据，而它根本流不到调用点。只跟 return 才是"这个调用真的会产出什么"。
        if (n.type === 'CallExpression') {
            const name = n.callee && n.callee.type === 'Identifier' ? n.callee.name : null;
            if (!name || seenFns.has(name)) return;
            const fns = findNamedFunctionNodes(ast, name);
            if (fns.length !== 1) return;
            seenFns.add(name);
            for (const ret of returnStatementsOf(fns[0])) {
                if (ret.argument) reachableClassTexts(ret.argument, ast, srcIdx, depth + 1, seenFns, out);
            }
        }
        // 标识符 → 受限溯源到它的写入来源（domain_manager 的 `const statusBadge = 三元字面量`）
        if (n.type === 'Identifier' && srcIdx && srcIdx.ok) {
            const b = resolveValueSources(n, { scopeIndex: srcIdx });
            if (b.kind !== 'writes' || !b.writes.length) return;
            if (seenFns.has(b.variable)) return;
            seenFns.add(b.variable);
            for (const w of b.writes) reachableClassTexts(w, ast, srcIdx, depth + 1, seenFns, out);
        }
    });
    return out;
}

function hasClassOutputEvidence(source, cls, kind) {
    const tokenRe = classTokenRe(cls);
    const jsHasOutput = (jsSrc) => {
        const parsed = parseJs(jsSrc);
        if (!parsed.ok) return false;
        const srcIdx = buildScopeIndex(parsed.ast);
        for (const root of domWriteRootsOf(parsed.ast)) {
            const texts = reachableClassTexts(root, parsed.ast, srcIdx, 0, new Set(), []);
            if (texts.some((t) => tokenRe.test(t))) return true;
        }
        return false;
    };
    if (kind === 'html') {
        const body = source
            .replace(/<script\b[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');
        if (classTokensInMarkup(body).includes(cls)) return true;   // 静态 HTML 正文里的真实 class 属性
        return jsHasOutput(inlineScriptSource(source));
    }
    return jsHasOutput(source);   // kind === 'js'
}

module.exports = { runBadgeAliasAssertions, PAGE_ALIAS_SPECS, SEM_TIERS, hasClassOutputEvidence };

// 独立运行入口（`node scripts/verify-badge-alias.js`）
if (require.main === module) {
    let pass = 0;
    let fail = 0;
    const failures = [];
    const check = (cond, label, detail) => {
        if (cond) { pass++; console.log(`  [OK] ${label}`); }
        else { fail++; failures.push({ label, detail }); console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
    };
    console.log('=== 状态徽章统一 S2 · 六别名页接线断言（独立运行）===\n');
    runBadgeAliasAssertions(check);
    console.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail > 0) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    }
    process.exit(fail === 0 ? 0 : 1);
}
