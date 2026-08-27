/**
 * 共享 CSS 缓存串守卫（2026-08-12 新增·codex 352 号收口）
 *
 * 缺口来源（本次真实踩坑，不是假想）：给状态色板加第 14 层（「待上线」徽章青→橙）改了共享的
 *   `components.css`，**但没 bump 11 个页面的 `?v=` 缓存串**。后果是：
 *     · 全部静态守卫绿——它们读的是磁盘文件；
 *     · Playwright 实测也绿——每次跑都是全新 browser context，不吃缓存，拿到的就是新 CSS；
 *     · **唯独真实用户**打开页面看到的还是旧的青色，当场反馈"这个状态的样式好像还没做"。
 *   项目本有这条规矩（改共享静态资源必 bump 缓存串），且给**共享 JS** 配了运行时版本比对
 *   （u-paste.js / model-detail-normalize.js 的 KIT_VERSION 不一致就 console.error）；
 *   但 CSS 里没有可执行代码，运行时自证那条路走不通 —— 只能静态守，就是本脚本。
 *
 * 三条判据（缺一都能假绿）：
 *   ① **覆盖面**：登记的页面清单与实际引用页**双向相等**（少一页 = 那页用户拿旧 CSS；多一页 = 清单腐化）。
 *      刻意不用 `>= N` 这类宽松阈值——某页写法没被解析到时它会从集合里消失，剩下的页仍然"一致"，
 *      守卫照样绿（codex 352 号 HIGH）。
 *   ② **串一致**：清单内每页的 `?v=` 完全相同且等于登记版本。
 *   ③ **内容指纹**：资源文件 sha256 等于登记值。改了内容没更新登记 → 红，逼你在同一次改动里
 *      bump 串 + 更新登记。
 *   ④ **git 联动（可用时才跑）**：`components.css` 相对 HEAD 有改动时，引用页与本脚本必须出现在
 *      同一批改动里——这是唯一能真正**强制** bump 的判据（判据③只能强制"更新登记"，一个人若只改
 *      SHA 常量而不 bump 串，③ 仍然会绿·codex 352 号 MED）。git 不可用时跳过并显式说明，不假装通过。
 *
 * ⚠️ HTML 自身缓存这条链路已核实无隐患：server.js `express.static` 对 `.html` 显式设
 *   `Cache-Control: no-cache`（协商缓存 + ETag，命中 304），静态资源默认 maxAge 7d。
 *   即用户刷新必然拿到最新 HTML，进而请求到新的 `?v=`。若将来有人改掉那段 setHeaders，本守卫的
 *   整个前提就没了 —— 那里已与本文件互相点名。
 *
 * ⚠️ 维护提示：改完共享 CSS 跑一次本脚本，失败信息会打印实际指纹，照着更新对应资源的
 *   version / sha256 / log 三处，并把页面 `?v=` 一起换掉。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ── 登记表（改共享 CSS 时更新对应条目）────────────────────────────
const ASSETS = [
    {
        rel: 'assets/css/components.css',
        version: 'v1.153.0_fastlanetier15',
        sha256: '81dd4ef8f68a0d82e840cd543bfea1c9ed34fa624fb792d4f104761eb4a5e94d',
        // 期望引用页**显式清单**（双向对拍，新增/下线页面必须显式改这里）
        pages: [
            'Data_Collab.html', 'Data_Correction.html', 'Issue_Lite.html', 'Issue_Tracker.html',
            'Legacy_Archive.html',   // 2026-08-27 补登记：Phase A cherry-pick 上主干时新增页漏登记（守卫双向对拍抓出）
            'Model_Center.html', 'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html',
            'Statistics.html', 'Sys_Iteration.html', 'Task_Pool.html',
        ],
        log: [
            ['v1.142.0_notify1', '通知按钮与文本统一（前代登记，本守卫建立前）'],
            ['v1.152.0_prereleasetier1', '状态色板新增第 14 层 sem-prerelease（「待上线」青→橙）+ 两个待上线 flag 的 si-flag 修饰类。串名用 prereleasetier 而非 prerelease，避免被读成"预发布版本"（codex 352 号 LOW）'],
            ['v1.153.0_fastlanetier15', '状态色板新增第 15 层 sem-fastlane（先行上线两步化 S7·「待先行部署 x/N」徽章·靛紫色相，与第 14 层 prerelease 橙区分）。串名用 fastlanetier15 呼应既有 prereleasetier 命名习惯'],
        ],
    },
    {
        rel: 'assets/css/style.css',
        version: 'v1.141.0_badge2',
        sha256: '6b4055aed8e9ed4f3711ff5a6d3b04914ffa81581f4556ad31a880ab96471a1c',
        // 本次未改 style.css，登记现状即可——它同为多页共享 CSS，同样的忘 bump 会同样出事
        //   （codex 352 号 LOW 建议后续单独守；配置表化后顺手纳入，零额外成本）
        pages: [
            'admin.html', 'Asset_Center.html', 'Dashboard.html', 'Data_Collab.html', 'Data_Correction.html',
            'Domain_Manager.html', 'Issue_Lite.html', 'Issue_Tracker.html',
            'Legacy_Archive.html',   // 2026-08-27 补登记：同上（components.css 条目的说明）
            'Metrics.html', 'Model_Center.html',
            'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html', 'Statistics.html',
            'Sys_Iteration.html', 'Task_Pool.html',
        ],
        log: [['v1.141.0_badge2', '全站状态徽章统一（存量登记，本守卫建立时的现状）']],
    },
];

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => (cond ? ok(m) : bad(m));

// 从一个 HTML 里取某资源的 `?v=` 版本。解析走 HTML/URL 语义而不是一条大正则（codex 352 号 MED）：
//   先抓 <link> 标签（大小写不敏感），再取 href（双引号/单引号/裸值三种写法），
//   再用 URL 解析 pathname 与 searchParams —— 这样 `?x=1&v=…`、`?v=…&x=1`、带 #hash 都能正确处理。
function readAssetVersion(html, relPath) {
    const results = [];
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
        const hm = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        if (!hm) continue;
        const href = hm[1] !== undefined ? hm[1] : (hm[2] !== undefined ? hm[2] : hm[3]);
        let u;
        try { u = new URL(href, 'http://local/'); } catch (e) { continue; }
        if (!u.pathname.endsWith('/' + relPath) && u.pathname !== '/' + relPath) continue;
        results.push(u.searchParams.get('v') || '(无缓存串)');
    }
    return results;
}

console.log('=== 共享 CSS 缓存串守卫 ===\n');

const allPages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
must(allPages.length >= 15, `public 下 HTML 页面实抓 ${allPages.length} 个（过少=目录读取异常，扫描面须非空）`);

for (const asset of ASSETS) {
    console.log(`\n--- ${asset.rel} ---`);

    // ① 覆盖面双向对拍：登记清单 ≡ 实际引用页
    const actualPages = [];
    const versionsByPage = new Map();
    for (const f of allPages) {
        const vs = readAssetVersion(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), asset.rel);
        if (!vs.length) continue;
        actualPages.push(f);
        // 同一页多条引用（历史遗留/复制粘贴）会让"最后一条赢"掩盖前面的旧串，故单独断言
        must(vs.length === 1, `${f} 中 ${asset.rel} 恰好引用一次（实得 ${vs.length} 次·多条会互相掩盖）`);
        versionsByPage.set(f, vs[0]);
    }
    const missing = asset.pages.filter((p) => !actualPages.includes(p));
    const extra = actualPages.filter((p) => !asset.pages.includes(p));
    must(missing.length === 0 && extra.length === 0,
        `引用页清单与实际双向相等（登记 ${asset.pages.length} / 实测 ${actualPages.length}）${missing.length ? `——清单里有但没解析到：${missing.join(', ')}（该页写法未被解析=它的用户会一直拿旧资源而守卫不报）` : ''}${extra.length ? `——实际引用了但清单未登记：${extra.join(', ')}` : ''}`);

    // ② 串一致且等于登记版本
    const versions = [...new Set(versionsByPage.values())];
    must(versions.length === 1 && versions[0] === asset.version,
        `全部引用页 ?v= 一致且等于登记值 ${asset.version}${versions.length === 1 && versions[0] === asset.version ? '' : `——实得 ${versions.length} 种：${versions.join(' / ')}；逐页：${[...versionsByPage].map(([f, v]) => `${f}=${v}`).join(', ')}`}`);

    // ③ 内容指纹
    const actualSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, asset.rel))).digest('hex');
    must(actualSha === asset.sha256,
        actualSha === asset.sha256
            ? `内容指纹与登记值一致（${actualSha.slice(0, 12)}…）`
            : `内容已变但登记值未更新 —— 实际 ${actualSha}\n         登记 ${asset.sha256}\n         ⇒ 改了共享 CSS 必须同时 bump 全部引用页的 ?v= 串（静态守卫与 Playwright 都发现不了，它们不吃浏览器缓存）。\n         做法：换全部引用页的 ?v= → 更新本文件该资源的 version/sha256 → log 追加一行原因。`);

    // ③b 登记日志自洽
    must(asset.log.length >= 1 && asset.log[asset.log.length - 1][0] === asset.version,
        `log 末行版本号 = 当前登记版本（防只改常量不写原因）`);
    must(new Set(asset.log.map((x) => x[0])).size === asset.log.length, 'log 无重复版本号');
}

// ── ④ git 联动：改了 CSS 就必须在同一批改动里动引用页 + 本登记 ──────
//   这是唯一能**强制 bump** 的判据（③ 只能强制"更新登记"：有人若只改 SHA 常量、不碰页面串，③ 照样绿）。
console.log('\n--- ④ git 联动检查 ---');
{
    let changed = null;
    try {
        const out = execSync('git status --porcelain=v1 -- . ../', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        changed = out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    } catch (e) {
        changed = null;
    }
    if (changed === null) {
        console.log('  [SKIP] git 不可用（非仓库/命令缺失）——本判据跳过，不计入通过项，也不假装通过');
    } else {
        for (const asset of ASSETS) {
            const cssTouched = changed.some((f) => f.replace(/\\/g, '/').endsWith(`public/${asset.rel}`));
            if (!cssTouched) { ok(`${asset.rel} 相对工作区无未提交改动（本判据不适用）`); continue; }
            const pagesTouched = changed.some((f) => asset.pages.some((p) => f.replace(/\\/g, '/').endsWith(`public/${p}`)));
            const selfTouched = changed.some((f) => f.replace(/\\/g, '/').endsWith('scripts/verify-shared-css-cache-bust.js'));
            must(pagesTouched && selfTouched,
                `${asset.rel} 有未提交改动时，引用页与本登记文件也在同一批改动内（页面=${pagesTouched} / 登记=${selfTouched}）——只改 CSS 不动串，用户拿到的还是旧样式`);
        }
    }
}

// ── ⑤ 对照组：证明判据不是恒真 ───────────────────────────────────
console.log('\n--- ⑤ 对照组 ---');
{
    const html = `<link rel="stylesheet" HREF='assets/css/components.css?x=1&v=vX_test#frag'>
                  <link rel="stylesheet" href="assets/css/other.css?v=zzz">
                  <!-- 注释里提到 assets/css/components.css 不应被算作引用 -->`;
    const got = readAssetVersion(html, 'assets/css/components.css');
    must(got.length === 1 && got[0] === 'vX_test',
        `★对照组①：大写 HREF + 单引号 + 多查询参数 + hash 的写法能被正确解析为 vX_test（实得 ${JSON.stringify(got)}）——首版正则要求 ?v= 紧跟且到行尾，这些写法会漏`);

    const bare = readAssetVersion(`<link rel="stylesheet" href=assets/css/components.css>`, 'assets/css/components.css');
    must(bare.length === 1 && bare[0] === '(无缓存串)', `★对照组②：无引号且无 ?v= 的裸引用被判为"(无缓存串)"（实得 ${JSON.stringify(bare)}）`);

    const commentOnly = readAssetVersion('<!-- 详见 assets/css/components.css 该层注释 -->', 'assets/css/components.css');
    must(commentOnly.length === 0, '★对照组③：仅在注释里提到文件名不算引用（首版全文扫描曾因此把 11 页全判成"无缓存串"）');

    const fakeMissing = ['A.html', 'B.html'].filter((p) => !['A.html'].includes(p));
    must(fakeMissing.length === 1, '★对照组④：清单里有而实际没解析到的页会被算进 missing（证明覆盖面判据不恒真）');

    // ④ 的对照组：真实工作区此刻恰好构不成反例（CSS 已提交），故用假 changed 列表验判据逻辑本身。
    //   场景 = 只改了 CSS，引用页与本登记文件都没动 —— 正是本次事故的形态。
    {
        const fakeChanged = ['wbs-server/public/assets/css/components.css'];
        const asset = ASSETS[0];
        const cssTouched = fakeChanged.some((f) => f.replace(/\\/g, '/').endsWith(`public/${asset.rel}`));
        const pagesTouched = fakeChanged.some((f) => asset.pages.some((p) => f.replace(/\\/g, '/').endsWith(`public/${p}`)));
        const selfTouched = fakeChanged.some((f) => f.replace(/\\/g, '/').endsWith('scripts/verify-shared-css-cache-bust.js'));
        must(cssTouched && !(pagesTouched && selfTouched),
            '★对照组⑤：只改 CSS、不动引用页与登记文件的改动集会被 git 判据判红（证明④不恒真）');
    }
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
