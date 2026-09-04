/**
 * sync-to-github.ps1 步骤 2 fail-closed 兜底扫描——独立验证脚本（2026-08-28 未了项 #20 整改
 * + 2026-08-29 收口批：main 分支判据/删除失败 fail-closed/爆炸半径安全阀/ReparsePoint 跳过/
 * 白名单大小写不敏感/单元素 HashSet 边界/嵌套白名单路径 七项加固
 * + 2026-08-29 二收口批：codex 74 号合并审 3H/3M/1L 全采纳——枚举错误禁静默/main 清单输入
 * 校验/reparse point 显式策略/verify main-only 场景/集合级终态不变量/真实删除异常路径/
 * ls-tree -z NUL 分隔
 * + 2026-08-29 三收口批（S-20 尾巴微批，codex 76 号 2M/2L 轻处置）：main 恒非空前置条件注释
 * （M1，注释级）/skipped 从"通过"里结构性分离（M2a）/集合不变量大小写归一对齐生产（M2b）/
 * 可注入输入的 -z 解析单测 + Part K 如实标注非端到端（L1）/ACL·junction 辅助函数前提注释（L2））
 *
 * 背景（真实事故，不是假想）：步骤 2 曾是"黑名单逐文件/逐目录补条目"，累计六例同根因漏网——
 *   `_seed`/`_set-sys-notify` 两临时脚本、`_demo-notify-unify-manifest.json` 漏过 `.js` 逐文件
 *   模式、`__screenshots__/` 21 张 PNG 整目录、`test-screenshots/` 6 张 PNG 已推送公开仓后紧急
 *   摘除、three-r185+两 Sys_Iteration demo 文件——黑名单必然再漏。改造为 fail-closed：镜像内
 *   任一文件，唯一放行依据 = 「主仓 main 分支已跟踪该相对路径」∨「命中 $mirrorOnlyWhitelist」。
 *
 * 2026-08-29 收口批背景：Opus 预筛对 #20 首版实现抓出 3 拦截 + 4 提示——
 *   ① 判据曾绑定「当前 checkout 分支」而非 main（真实事故：feature 分支跑会把 12 个 main 已
 *      跟踪真源文件误删出公开仓）→ 改显式读 main 分支树
 *   ② 删除失败曾静默 fail-open（Remove-Item 无 -ErrorAction/无复核）→ 加 try/catch + Test-Path
 *      复核 + 失败即整体 exit 1
 *   ③ 无爆炸半径安全阀（真实首跑预计删 90+，一次跑错会大面积误删）→ 待删 > 20 且未带
 *      -SweepForce 时 fail-fast、一个都不删
 *   ④ `return $set` 在 PowerShell 管线语义下会被展开（0 元素→$null，1 元素→降级裸字符串，
 *      `.Contains()` 变子串匹配）→ 改 `return ,$set`
 *   ⑤ 路径比对未做大小写不敏感 → HashSet 改 OrdinalIgnoreCase 比较器
 *   ⑥ 白名单里的嵌套路径（`wbs-server/public/Export_DateFilter_Demo.html`）未有 fixture 验证
 *      分隔符归一 → 补 fixture
 *   ⑦ Get-ChildItem 枚举会跟进 junction/符号链接目录，有经由链接逃出镜像根目录误删外部真实
 *      文件的风险 → 改手写栈式遍历跳过 ReparsePoint 目录
 *
 * 2026-08-29 二收口批背景：外审（codex code-review，confidence high）在上述预筛之上再抓出
 * 第二层 fail-open——
 *   H1 目录枚举 `-ErrorAction SilentlyContinue` 静默吞错 → 改 -ErrorVariable 收集错误清单，
 *      非空即调用方整体判失败（阻止后续 git add/commit/push）
 *   H2 `git ls-tree` 的退出码/stderr/main 引用存在性均未校验 → 先 `rev-parse --verify` 确认
 *      main 存在，ls-tree 本体也校验 $LASTEXITCODE + stderr，且 main 存在但 0 条跟踪文件同样
 *      视为异常（安全阀是附加保护，不能替代输入清单本身有效这道更基础的校验）
 *   H3 reparse point 只跳过不拒绝（镜像可残留指向外部的目录链接，镜像根自身也未查 reparse）
 *      → 根路径是 reparse point 直接判失败；子目录 reparse point 记入异常清单阻止同步
 *      （保守取向：不自动删除链接本身）
 *   M1 verify Part C 未覆盖"文件仅存在于 main、feature 已删除"这一原始误删场景 → 补 main-only
 *      文件用例（Part L）
 *   M2 无集合级终态不变量，漏放未预设文件测不出 → 各正常路径末尾断言镜像实际文件集
 *      ⊆ main 树 ∪ 白名单 + 统一断言 exitCode=0/FailedDeletions 空
 *   M3 Remove-Item 真实异常 catch 路径未测（Part E 桩只测了复核残留路径） → ACL Deny 触发真实
 *      IO 异常（本机实测：Node fs.openSync 持句柄不阻挡 Windows Remove-Item -Force，改用
 *      ACL Deny 作为次优法，稳定复现）
 *   L1 ls-tree 未用 -z，换行/引号类合法路径会被转义拆行误判 → 改 -z NUL 分隔解析
 *
 * 本脚本做什么：在系统临时目录里构造若干组"假主仓 + 假镜像"（真实 git repo，真实文件），
 *   通过 `powershell -File sync-to-github.ps1 -FailClosedSweepOnly` 调用**真实的**
 *   `Invoke-FailClosedSweep` 函数（不是重新实现一份逻辑来测）：
 *     [Part A]  正常态：漏网删、跟踪+白名单留（含二进制/整目录/CJK/嵌套白名单路径/随机未预设
 *               文件）；末尾补 M2 终态不变量断言
 *     [Part B]  双向自证：-FailClosedDisableForTest 退化判定，证明 A 的删除断言不是摆设
 *     [Part C]  main 分支判据：main+feature 双分支，当前 checkout 在 feature，判据仍须绑 main；
 *               末尾补 M2 终态不变量断言
 *     [Part D]  爆炸半径安全阀：21 个待删文件，无 -SweepForce 一个不删+非0退出；带上全删；
 *               D2（带 -SweepForce）末尾补 M2 终态不变量断言
 *     [Part E]  删除失败 fail-closed：桩模拟一个文件"删除声称成功但残留"，须整体判失败
 *     [Part F]  单元素跟踪清单边界：防 `return $set` 降级为字符串子串匹配误放行；
 *               末尾补 M2 终态不变量断言
 *     [Part G]  ReparsePoint 不跟进 + H3②子目录 reparse point 记异常、整体判失败阻止同步
 *     [Part H]  H3①镜像根路径自身是 reparse point——直接拒绝扫描、整体判失败
 *     [Part I]  H1 目录枚举错误（ACL 拒绝访问子目录）不再静默吞掉，整体判失败
 *     [Part J]  H2 main 分支判据输入有效性：main 缺失 / 清单为空均须 fail-closed
 *     [Part K]  L1 ls-tree -z NUL 分隔：①源码存在性核对（非端到端，Windows 文件名限制导致
 *               无法用真实文件构造转义回归 fixture）②可注入输入的真实解析单测（codex 76 新增：
 *               解析逻辑抽成 ConvertFrom-NulSeparatedGitOutput，构造含换行/引号/反斜杠/CJK 的
 *               模拟 ls-tree -z 原始字节直接喂给它，脱离 git/真实文件系统断言路径完整还原）
 *     [Part L]  M1 main-only 文件：main 独有、feature 已删除，checkout 停在 feature 仍须保留
 *               （Part C 的逆命题）；含 M2 终态不变量断言
 *     [Part M]  M3 删除失败 fail-closed 的真实异常路径（ACL Deny 触发 Remove-Item 真实抛异常，
 *               区别于 Part E 的 Test-Path 复核残留桩）
 *
 * 全程只碰系统临时目录里的一次性 fixture，绝不触碰真实公开镜像（e:/tmp/smart-data-hub-public/），
 * 绝不 git push，绝不跑完整 sync 流程（只调用 -FailClosedSweepOnly 这一个测试专用出口）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-to-github.ps1');

let pass = 0, fail = 0, skip = 0;
// M2a（codex 76）：把每条 SKIP 的原文存下来，供末尾醒目汇总——单靠散落在中间输出里的
// `[SKIP]` 行容易被淹没在几十行 `[OK]` 里，看起来跟"全部通过"没有区别。
const skipMessages = [];
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const skipped = (m) => { skip++; skipMessages.push(m); console.log(`  [SKIP] ${m}`); };

// ── 安全护栏：临时根目录必须真的在系统 temp 下，且路径里不含真实镜像/主仓的关键词，
//    防止脚本写错路径时误碰真实目录（本脚本唯一允许写入删除的地方）──
function assertSafeTempRoot(p) {
    const resolvedTmp = fs.realpathSync(os.tmpdir());
    const resolvedP = path.resolve(p);
    if (!resolvedP.toLowerCase().startsWith(resolvedTmp.toLowerCase())) {
        throw new Error(`安全护栏拦截：临时目录 ${resolvedP} 不在系统 temp（${resolvedTmp}）下，拒绝继续`);
    }
    if (/smart-data-hub-public|数据开发与治理规范手册/i.test(resolvedP)) {
        throw new Error(`安全护栏拦截：临时目录路径疑似指向真实仓库/镜像：${resolvedP}`);
    }
}

function run(cmd, args, opts) {
    const r = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
    return r;
}

function writeFileEnsureDir(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (Buffer.isBuffer(content)) {
        fs.writeFileSync(filePath, content);
    } else {
        fs.writeFileSync(filePath, content, 'utf8');
    }
}

// 真实 PNG 文件头（8 字节魔数）+ 一段随机字节，确保这是"真二进制"而非可被当文本处理的东西。
function fakePngBuffer() {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const junk = Buffer.alloc(256);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) % 256;
    return Buffer.concat([magic, junk]);
}

const GIT_AUTHOR_ARGS = ['-c', 'user.name=verify-bot', '-c', 'user.email=verify-bot@local'];

// 建一个只有 main 分支、一次提交的假主仓（Part A/B/D/E/G 共用）。
// 显式建 main 分支——不依赖 init.defaultBranch 全局配置（环境可能默认 master）：
// sync-to-github.ps1 自 2026-08-29 起判据硬编码读 main 分支树，fixture 必须真的有一个叫 main
// 的分支，否则 `git ls-tree -r --name-only main` 会因分支不存在而报错。
function gitInitMain(dir) {
    run('git', ['init', '-q'], { cwd: dir });
    run('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
}
function gitCommitAll(dir, msg) {
    run('git', [...GIT_AUTHOR_ARGS, 'add', '-A'], { cwd: dir });
    run('git', [...GIT_AUTHOR_ARGS, 'commit', '-q', '-m', msg], { cwd: dir });
}

// ── 主仓"已跟踪文件"清单（内容随便写，路径设计覆盖：根/嵌套/CJK 三类）──
const TRACKED_FILES = {
    'README.md': '# fake source repo\n',
    'app.js': 'module.exports = () => 1;\n',
    'docs/guide.md': '# guide\n',
    '文档/说明.md': '# 中文路径说明\n',
};

// ── 镜像专属白名单（需与 sync-to-github.ps1 里 $mirrorOnlyWhitelist 的相对路径写法一致）──
const WHITELIST_REL = 'LICENSE';
// Part A 追加：与生产 $mirrorOnlyWhitelist 完全同名的嵌套路径条目（多段目录 + 正斜杠），
// 验证白名单侧的分隔符归一（镜像文件系统路径含反斜杠，转正斜杠后须与该字面量精确相等）。
const WHITELIST_NESTED_REL = 'wbs-server/public/Export_DateFilter_Demo.html';

// ── 漏网 fixture：覆盖"文本/二进制/嵌套目录/CJK 文件名"四个维度 ──
const LEAK_FIXTURES = {
    'leak.js': "console.log('leftover local script, should never be public');\n",
    'config/leak.json': JSON.stringify({ secret: 'should-not-leak' }),
    'assets/leak.png': fakePngBuffer(),               // 二进制覆盖
    '__screenshots__/a.png': fakePngBuffer(),          // 整目录覆盖（含二进制）
    '__screenshots__/b.png': fakePngBuffer(),
    '__screenshots__/sub/c.png': fakePngBuffer(),      // 嵌套子目录
    '长任务摘要/摘要.html': '<html>内部长任务摘要，不应公开</html>',   // CJK 文件名的漏网文件
};

function buildSourceRepo(srcDir) {
    fs.mkdirSync(srcDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(srcDir, rel), content);
    }
    gitInitMain(srcDir);
    gitCommitAll(srcDir, 'init');
}

function buildMirrorFixture(mirrorDir) {
    fs.mkdirSync(mirrorDir, { recursive: true });
    // 模拟 robocopy 已把主仓跟踪文件同步过来
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(mirrorDir, rel), content);
    }
    // 白名单文件（镜像专属，主仓没有）——根路径 + 嵌套多段路径两种都覆盖
    writeFileEnsureDir(path.join(mirrorDir, WHITELIST_REL), 'MIT License (fake, for test)\n');
    writeFileEnsureDir(path.join(mirrorDir, WHITELIST_NESTED_REL), '<html>demo</html>\n');
    // 漏网文件
    for (const [rel, content] of Object.entries(LEAK_FIXTURES)) {
        writeFileEnsureDir(path.join(mirrorDir, rel), content);
    }
}

function invokeSweep(srcDir, mirrorDir, opts) {
    opts = opts || {};
    const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SYNC_SCRIPT,
        '-FailClosedSweepOnly',
        '-SourcePath', srcDir,
        '-MirrorPath', mirrorDir,
    ];
    if (opts.disableForTest) args.push('-FailClosedDisableForTest');
    if (opts.sweepForce) args.push('-SweepForce');
    if (opts.simulateResidualFor) args.push('-FailClosedSimulateResidualFor', opts.simulateResidualFor);
    const r = spawnSync('powershell.exe', args, { encoding: 'utf8' });
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const jsonLine = lines[lines.length - 1];
    let parsed = null;
    try {
        parsed = JSON.parse(jsonLine);
    } catch (e) {
        throw new Error(`sweep 输出非合法 JSON（exit ${r.status}）：\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    }
    return { exitCode: r.status, result: parsed, stdout: r.stdout, stderr: r.stderr };
}

function toArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function exists(base, rel) {
    return fs.existsSync(path.join(base, rel));
}

// ── 2026-08-29 二收口批新增辅助（codex 74 M1/M2/M3 全采纳）──

// 递归列出镜像内实际存在的文件（相对路径，正斜杠），跳过 .git 与 reparse point（junction/
// 符号链接）目录——它们不属于"镜像应受控内容"的判定对象，本就是 H3 的独立处理对象。
function listMirrorFilesRecursive(root) {
    const out = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const e of entries) {
            if (e.name === '.git') continue;
            const full = path.join(dir, e.name);
            let st;
            try {
                st = fs.lstatSync(full);
            } catch (e2) {
                continue;
            }
            if (st.isSymbolicLink()) continue; // Windows junction 在 Node 侧按符号链接呈现
            if (st.isDirectory()) {
                walk(full);
            } else if (st.isFile()) {
                out.push(path.relative(root, full).split(path.sep).join('/'));
            }
        }
    }
    walk(root);
    return out;
}

// M2：集合级终态不变量——sweep 结束后，镜像实际残留文件集合必须是「主仓 main 已跟踪 ∪ 白名单」
// 的子集。逐项断言（Part A 的 LEAK_FIXTURES 枚举等）只能证明"预设的那几个文件处理对了"，无法
// 证明"没有漏放某个没被预设进来的文件"——这条不变量补的正是这个盲区（codex 74 M2 原话）。
function assertSubsetInvariant(mirrorDir, allowedRelArray, label) {
    // M2b（codex 76）：改为大小写不敏感归一比对（统一 toLowerCase 后再入集合/查询），与生产
    // Get-SourceTrackedFileSet / 白名单集合使用的 [System.StringComparer]::OrdinalIgnoreCase
    // 语义对齐——Windows 文件系统本身大小写不敏感，这条不变量若按大小写敏感比对，会把"仅大小写
    // 不同、生产侧其实判定为已放行"的合法文件误判成"不在允许集合内的残留"而产生假红。
    const allowed = new Set(allowedRelArray.map((r) => r.toLowerCase()));
    const actual = listMirrorFilesRecursive(mirrorDir);
    const extra = actual.filter((r) => !allowed.has(r.toLowerCase()));
    if (extra.length === 0) {
        ok(`[集合不变量] ${label}：镜像实际文件集（${actual.length} 个）⊆ 主仓已跟踪∪白名单`);
    } else {
        bad(`[集合不变量] ${label}：镜像内发现不在允许集合内的残留文件：${JSON.stringify(extra)}`);
    }
}

// M2：各正常（成功）路径统一断言 exitCode=0 且 FailedDeletions 为空——正常路径不该悄悄带着
// 失败态收尾。
function assertNormalTermination(exitCode, result, label) {
    if (exitCode === 0) {
        ok(`[终态] ${label}：exitCode=0`);
    } else {
        bad(`[终态] ${label}：exitCode 非 0（${exitCode}）`);
    }
    const fd = toArray(result.FailedDeletions);
    if (fd.length === 0) {
        ok(`[终态] ${label}：FailedDeletions 为空`);
    } else {
        bad(`[终态] ${label}：FailedDeletions 非空：${JSON.stringify(fd)}`);
    }
}

// H2 专用调用：main 分支缺失 / 清单为空场景下，Get-SourceTrackedFileSet 现在会直接 exit 1，
// 不会走到"打印 JSON 再退出"那一步——不能用 invokeSweep（它假定 stdout 最后一行是合法 JSON）。
// 这里只关心退出码与文本诊断信息，不解析 JSON。
function invokeSweepExpectHardFailure(srcDir, mirrorDir) {
    const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SYNC_SCRIPT,
        '-FailClosedSweepOnly',
        '-SourcePath', srcDir,
        '-MirrorPath', mirrorDir,
    ];
    const r = spawnSync('powershell.exe', args, { encoding: 'utf8' });
    return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// L2（codex 76）前提注释：以下三个辅助函数（tryCreateJunction / applyDenyAcl / removeDenyAcl）
// 都用字符串插值拼 PowerShell -Command，理论上若路径含引号/反引号等特殊字符会有注入风险。
// 但三者的入参路径全部由本脚本自建——固定字面量（'linked-decoy'/'mirror-root-junction-link'
// 等）拼在 `tmpRoot`（`fs.mkdtempSync` 生成，系统 temp 下的随机十六进制目录名）之下，不接受任何
// 外部/用户可控输入，不含引号、反引号、分号等特殊字符，此处按现状用字符串插值是安全的。
// 若未来改成接受外部可控路径，必须改为参数绑定（避免 -Command 字符串拼接，改走
// System.Diagnostics.Process 的 ArgumentList 或等价的显式参数传递）而非继续插值。
// H3 专用：创建 junction，创建失败时按任务允许的 escape hatch 由调用方跳过（不计入失败数）。
function tryCreateJunction(linkPath, targetPath) {
    const mk = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `New-Item -ItemType Junction -Path "${linkPath}" -Target "${targetPath}" | Out-Null`,
    ], { encoding: 'utf8' });
    return { created: mk.status === 0 && fs.existsSync(linkPath), stderr: (mk.stderr || '').trim(), status: mk.status };
}

// H1/M3 专用：对一个文件/目录施加 Deny ACL（PowerShell 侧），返回是否成功应用。
function applyDenyAcl(targetPath, rights) {
    const cmd = [
        '-NoProfile', '-NonInteractive', '-Command',
        `$acl = Get-Acl -LiteralPath "${targetPath}"; ` +
        `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
        `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, "${rights}", "Deny"); ` +
        `$acl.AddAccessRule($rule); ` +
        `Set-Acl -LiteralPath "${targetPath}" -AclObject $acl`,
    ];
    const r = spawnSync('powershell.exe', cmd, { encoding: 'utf8' });
    return { applied: r.status === 0, stderr: (r.stderr || '').trim(), status: r.status };
}

// 撤销 applyDenyAcl 施加的同一条规则（清理用，失败只 WARN 不计入判定——但会导致 finally 里
// tmpRoot 整体清理告警，人工可见）。
function removeDenyAcl(targetPath, rights) {
    const cmd = [
        '-NoProfile', '-NonInteractive', '-Command',
        `$acl = Get-Acl -LiteralPath "${targetPath}"; ` +
        `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
        `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, "${rights}", "Deny"); ` +
        `$acl.RemoveAccessRule($rule) | Out-Null; ` +
        `Set-Acl -LiteralPath "${targetPath}" -AclObject $acl`,
    ];
    return spawnSync('powershell.exe', cmd, { encoding: 'utf8' });
}

console.log('sync-to-github.ps1 fail-closed 兜底扫描 — 独立验证\n');

const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'verify-sync-fail-closed-'));
assertSafeTempRoot(tmpRoot);
console.log(`  临时根目录：${tmpRoot}`);

let cleanupOk = true;
try {
    const srcDir = path.join(tmpRoot, 'src');
    const mirrorEnabledDir = path.join(tmpRoot, 'mirror-enabled');
    const mirrorDisabledDir = path.join(tmpRoot, 'mirror-disabled');
    assertSafeTempRoot(srcDir);
    assertSafeTempRoot(mirrorEnabledDir);
    assertSafeTempRoot(mirrorDisabledDir);

    buildSourceRepo(srcDir);
    buildMirrorFixture(mirrorEnabledDir);
    buildMirrorFixture(mirrorDisabledDir);

    // M2（codex 74）：额外混入一个"不在 LEAK_FIXTURES 清单里"的随机命名未跟踪文件——下方 Part A
    // 末尾的集合级不变量断言必须靠"镜像实际文件集 ⊆ 已跟踪∪白名单"这条通用规则抓到它，而不是
    // 靠某条专门为它写的具名断言，这样才证明实现是通用规则、不是恰好把预设 fixture 都列全了。
    const RANDOM_UNTRACKED_FILE = `random-untracked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileEnsureDir(path.join(mirrorEnabledDir, RANDOM_UNTRACKED_FILE), 'nobody predicted this file would be here\n');

    // ════════════════════════════════════════════════════════════════
    // Part A：fail-closed 判定正常启用（真实同步流程会走的路径）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part A] fail-closed 判定启用——应删漏网、留跟踪+白名单（含嵌套白名单路径）');
    const { exitCode: exitA, result: resultA } = invokeSweep(srcDir, mirrorEnabledDir, {});
    const removedA = toArray(resultA.Removed);
    const keptA = toArray(resultA.Kept);

    // ① 主仓已跟踪文件必须保留（含嵌套路径 + CJK 路径）
    for (const rel of Object.keys(TRACKED_FILES)) {
        if (exists(mirrorEnabledDir, rel) && keptA.includes(rel)) {
            ok(`主仓已跟踪文件保留：${rel}`);
        } else {
            bad(`主仓已跟踪文件被误删或未出现在 Kept：${rel}`);
        }
    }

    // ② 白名单文件必须保留（根路径 + 嵌套多段路径，验证分隔符归一）
    if (exists(mirrorEnabledDir, WHITELIST_REL) && keptA.includes(WHITELIST_REL)) {
        ok(`白名单文件保留：${WHITELIST_REL}`);
    } else {
        bad(`白名单文件被误删或未出现在 Kept：${WHITELIST_REL}`);
    }
    if (exists(mirrorEnabledDir, WHITELIST_NESTED_REL) && keptA.includes(WHITELIST_NESTED_REL)) {
        ok(`白名单嵌套路径保留（分隔符归一生效）：${WHITELIST_NESTED_REL}`);
    } else {
        bad(`白名单嵌套路径被误删或未出现在 Kept：${WHITELIST_NESTED_REL}`);
    }

    // ③ 漏网文件必须全部删除（文本 / 二进制 / 嵌套目录 / CJK 文件名）
    for (const rel of Object.keys(LEAK_FIXTURES)) {
        if (!exists(mirrorEnabledDir, rel) && removedA.includes(rel)) {
            ok(`漏网文件已删除：${rel}`);
        } else {
            bad(`漏网文件未被删除（fail-closed 判定失效）：${rel}`);
        }
    }

    // ③b 整目录覆盖：__screenshots__ 目录本身也应被 prune 掉（不留空壳）
    if (!fs.existsSync(path.join(mirrorEnabledDir, '__screenshots__'))) {
        ok('整目录 __screenshots__/ 已连同空壳一并清除');
    } else {
        bad('__screenshots__/ 目录壳仍残留（文件删了但目录没 prune，不算硬伤但记录）');
    }

    // ③c Removed 计数应恰好等于 LEAK_FIXTURES 项数 + 1（含额外混入的随机未预设文件）
    const expectedRemovedA = Object.keys(LEAK_FIXTURES).length + 1;
    if (removedA.length === expectedRemovedA && removedA.includes(RANDOM_UNTRACKED_FILE)) {
        ok(`Removed 计数精确匹配漏网 fixture 数 + 随机未预设文件：${removedA.length}`);
    } else {
        bad(`Removed 计数不匹配：期望 ${expectedRemovedA}（含随机文件 ${RANDOM_UNTRACKED_FILE}），实得 ${removedA.length}（${JSON.stringify(removedA)}）`);
    }

    // M2（codex 74）：Part A 是正常成功路径——统一断言 exitCode=0 + FailedDeletions 为空 +
    // 集合级终态不变量（镜像实际残留文件集 ⊆ main 已跟踪 ∪ 白名单，随机未预设文件靠这条通用
    // 规则被抓到，不靠专门的具名断言）。
    assertNormalTermination(exitA, resultA, 'Part A');
    assertSubsetInvariant(
        mirrorEnabledDir,
        [...Object.keys(TRACKED_FILES), WHITELIST_REL, WHITELIST_NESTED_REL],
        'Part A（含随机未预设未跟踪文件）'
    );

    // ════════════════════════════════════════════════════════════════
    // Part B：双向自证——用 -FailClosedDisableForTest 让判定恒为真，
    //   证明 Part A 的"必须删除"断言不是摆设：禁用判定后，同一条断言会判红。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part B] 双向自证——禁用 fail-closed 判定（模拟"注释掉"），验证断言真的会翻红');
    const { result: resultB } = invokeSweep(srcDir, mirrorDisabledDir, { disableForTest: true });
    const removedB = toArray(resultB.Removed);

    // 禁用判定下，sweep 本身不应删除任何东西
    if (removedB.length === 0) {
        ok('禁用态下 Removed 计数为 0（判定确实被绕过，不是误操作留了后门）');
    } else {
        bad(`禁用态下仍有文件被删（Removed=${JSON.stringify(removedB)}），DisableForTest 未生效，控制组不可信`);
    }

    // 挑一个二进制漏网 fixture，用 Part A 里"必须删除"的同一条断言逻辑再判一次——
    // 这次期望它是 RED（文件依然存在），并把这个红显式打印出来，证明测试的敏感性。
    const controlSample = 'assets/leak.png';
    const wouldPassRemovalAssertion = !exists(mirrorDisabledDir, controlSample) && removedB.includes(controlSample);
    if (wouldPassRemovalAssertion === false) {
        ok(`[SELF-CERT] 对照组按 Part A 同一断言复判：'${controlSample}' 正确判红（仍存在于磁盘，未被删除）—— ` +
            `证明 Part A 里对应断言的"通过"确实是 fail-closed 判定生效所致，而非巧合`);
    } else {
        bad(`[SELF-CERT] 对照组异常：禁用判定后 '${controlSample}' 竟然还是被删除/判定为已删除，双向自证失败`);
    }

    // 反向确认：白名单/主仓已跟踪文件在禁用态下也理应存在（这条不是自证重点，只是完整性兜底）
    if (exists(mirrorDisabledDir, WHITELIST_REL) && exists(mirrorDisabledDir, 'app.js')) {
        ok('禁用态下白名单/主仓已跟踪文件仍存在（对照组基本完整性）');
    } else {
        bad('禁用态下白名单/主仓已跟踪文件反而缺失，fixture 构造有问题');
    }

    // ════════════════════════════════════════════════════════════════
    // Part C：main 分支判据——当前 checkout 在 feature，判据仍须绑 main
    //   （2026-08-29 收口批拦截项①：真实事故是 feature 分支跑会把 main 已跟踪真源文件误删；
    //    这里用"feature 多跟踪一个文件"的方向验证判据确实取 main：feature 独有文件在镜像中
    //    应被删除——证明判据不是跟着"当前 checkout 分支"走的。）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part C] main 分支判据——当前 checkout 在 feature，sweep 判据仍须绑定 main 分支树');
    const srcBranchesDir = path.join(tmpRoot, 'src-branches');
    const mirrorCrossBranchDir = path.join(tmpRoot, 'mirror-cross-branch');
    assertSafeTempRoot(srcBranchesDir);
    assertSafeTempRoot(mirrorCrossBranchDir);

    const FEATURE_ONLY_FILE = 'feature-only-file.js';
    fs.mkdirSync(srcBranchesDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(srcBranchesDir, rel), content);
    }
    gitInitMain(srcBranchesDir);
    gitCommitAll(srcBranchesDir, 'main init');
    run('git', ['checkout', '-q', '-b', 'feature'], { cwd: srcBranchesDir });
    writeFileEnsureDir(path.join(srcBranchesDir, FEATURE_ONLY_FILE), 'feature-only, not tracked on main\n');
    gitCommitAll(srcBranchesDir, 'feature adds extra file');
    // 有意不切回 main——保持当前 checkout 在 feature，复现真实场景（本仓当前工作分支常年
    // 是长期 feature 分支）；`git branch --show-current` 应显示 feature，非 main。
    const currentBranch = run('git', ['branch', '--show-current'], { cwd: srcBranchesDir }).trim();
    if (currentBranch !== 'feature') {
        bad(`fixture 构造异常：当前 checkout 分支应为 feature，实际为 '${currentBranch}'`);
    }

    fs.mkdirSync(mirrorCrossBranchDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(mirrorCrossBranchDir, rel), content);
    }
    // 模拟镜像里混入了 feature 独有文件（例如历史上曾在 feature 分支跑过同步）
    writeFileEnsureDir(path.join(mirrorCrossBranchDir, FEATURE_ONLY_FILE), 'feature-only, not tracked on main\n');

    const { exitCode: exitC, result: resultC } = invokeSweep(srcBranchesDir, mirrorCrossBranchDir, {});
    const removedC = toArray(resultC.Removed);
    const keptC = toArray(resultC.Kept);

    for (const rel of Object.keys(TRACKED_FILES)) {
        if (exists(mirrorCrossBranchDir, rel) && keptC.includes(rel)) {
            ok(`[main 判据] main 分支已跟踪文件保留：${rel}`);
        } else {
            bad(`[main 判据] main 分支已跟踪文件被误删：${rel}`);
        }
    }
    if (!exists(mirrorCrossBranchDir, FEATURE_ONLY_FILE) && removedC.includes(FEATURE_ONLY_FILE)) {
        ok(`[main 判据] feature 独有文件已被删除（判据确实绑定 main，不是当前 checkout 分支 feature）：${FEATURE_ONLY_FILE}`);
    } else {
        bad(`[main 判据] feature 独有文件未被删除——判据疑似仍跟着当前 checkout 分支走：${FEATURE_ONLY_FILE}`);
    }
    assertNormalTermination(exitC, resultC, 'Part C');
    assertSubsetInvariant(mirrorCrossBranchDir, Object.keys(TRACKED_FILES), 'Part C');

    // ════════════════════════════════════════════════════════════════
    // Part D：爆炸半径安全阀——21 个待删文件（超阈值 20）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part D] 爆炸半径安全阀——21 个待删文件，无 -SweepForce 应一个不删+非0退出；带上应全删');
    const BLAST_COUNT = 21;
    const blastLeakRels = [];
    for (let i = 0; i < BLAST_COUNT; i++) {
        blastLeakRels.push(`blast/leak-${String(i).padStart(2, '0')}.js`);
    }

    function buildBlastMirror(mirrorDir) {
        fs.mkdirSync(mirrorDir, { recursive: true });
        for (const [rel, content] of Object.entries(TRACKED_FILES)) {
            writeFileEnsureDir(path.join(mirrorDir, rel), content);
        }
        for (const rel of blastLeakRels) {
            writeFileEnsureDir(path.join(mirrorDir, rel), `// leak\n`);
        }
    }

    const mirrorBlastNoForceDir = path.join(tmpRoot, 'mirror-blast-noforce');
    const mirrorBlastForceDir = path.join(tmpRoot, 'mirror-blast-force');
    assertSafeTempRoot(mirrorBlastNoForceDir);
    assertSafeTempRoot(mirrorBlastForceDir);
    buildBlastMirror(mirrorBlastNoForceDir);
    buildBlastMirror(mirrorBlastForceDir);

    // D1：无 -SweepForce → 非 0 退出 + 一个都不删
    const dNoForce = invokeSweep(srcDir, mirrorBlastNoForceDir, {});
    const allBlastStillExist = blastLeakRels.every((rel) => exists(mirrorBlastNoForceDir, rel));
    if (dNoForce.exitCode !== 0) {
        ok(`[安全阀] 无 -SweepForce 时脚本以非 0 退出（exit=${dNoForce.exitCode}）`);
    } else {
        bad(`[安全阀] 无 -SweepForce 时脚本仍以 0 退出，安全阀未生效`);
    }
    if (dNoForce.result.BlastRadiusExceeded === true) {
        ok('[安全阀] BlastRadiusExceeded=true');
    } else {
        bad(`[安全阀] BlastRadiusExceeded 字段非 true：${JSON.stringify(dNoForce.result.BlastRadiusExceeded)}`);
    }
    if (toArray(dNoForce.result.Removed).length === 0 && allBlastStillExist) {
        ok('[安全阀] 无 -SweepForce 时一个待删文件都没删（磁盘复核 21 个全部还在）');
    } else {
        bad(`[安全阀] 无 -SweepForce 时仍有文件被删——Removed=${JSON.stringify(dNoForce.result.Removed)}，` +
            `磁盘残留检查=${allBlastStillExist}`);
    }
    const wouldRemoveD = toArray(dNoForce.result.WouldRemove);
    if (wouldRemoveD.length === BLAST_COUNT && blastLeakRels.every((r) => wouldRemoveD.includes(r))) {
        ok(`[安全阀] WouldRemove 完整列出全部 ${BLAST_COUNT} 个待删路径（供用户核对清单）`);
    } else {
        bad(`[安全阀] WouldRemove 清单不完整：期望 ${BLAST_COUNT} 项，实得 ${JSON.stringify(wouldRemoveD)}`);
    }

    // D2：带 -SweepForce → 全删 + 退出码 0
    const dForce = invokeSweep(srcDir, mirrorBlastForceDir, { sweepForce: true });
    const noneBlastExist = blastLeakRels.every((rel) => !exists(mirrorBlastForceDir, rel));
    if (dForce.exitCode === 0) {
        ok(`[安全阀] 带 -SweepForce 时脚本以 0 退出`);
    } else {
        bad(`[安全阀] 带 -SweepForce 时脚本仍非 0 退出（exit=${dForce.exitCode}）`);
    }
    if (dForce.result.BlastRadiusExceeded === false && toArray(dForce.result.Removed).length === BLAST_COUNT && noneBlastExist) {
        ok(`[安全阀] 带 -SweepForce 时 ${BLAST_COUNT} 个待删文件全部删除（磁盘复核清零）`);
    } else {
        bad(`[安全阀] 带 -SweepForce 未能全删：BlastRadiusExceeded=${dForce.result.BlastRadiusExceeded}，` +
            `Removed=${JSON.stringify(dForce.result.Removed)}，磁盘清零=${noneBlastExist}`);
    }
    // 主仓已跟踪文件在两种情形下都不该受影响
    if (Object.keys(TRACKED_FILES).every((rel) => exists(mirrorBlastNoForceDir, rel) && exists(mirrorBlastForceDir, rel))) {
        ok('[安全阀] 两种情形下主仓已跟踪文件均未受影响');
    } else {
        bad('[安全阀] 主仓已跟踪文件在爆炸半径测试中意外受影响');
    }
    // M2：D2（带 -SweepForce）是正常成功收尾路径——补统一终态断言 + 集合级不变量。
    // D1（无 -SweepForce）是设计上的中止路径，不适用"正常路径"不变量，不在此列。
    assertNormalTermination(dForce.exitCode, dForce.result, 'Part D2 (SweepForce)');
    assertSubsetInvariant(mirrorBlastForceDir, Object.keys(TRACKED_FILES), 'Part D2 (SweepForce)');

    // ════════════════════════════════════════════════════════════════
    // Part E：删除失败 fail-closed——桩模拟一个文件"删除声称成功但残留"
    //   （真实文件锁定在 Windows 下难以稳定复现：Remove-Item -Force 通常能穿透只读属性；
    //    持句柄测试对进程时序敏感、不稳定——按任务允许的escape hatch，改用脚本自带的
    //    -FailClosedSimulateResidualFor 测试桩覆盖"Test-Path 复核发现残留"这条路径。）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part E] 删除失败 fail-closed——模拟一个文件删除后仍残留，整体应判失败');
    const mirrorResidualDir = path.join(tmpRoot, 'mirror-residual');
    assertSafeTempRoot(mirrorResidualDir);
    buildMirrorFixture(mirrorResidualDir);
    const residualTarget = 'leak.js'; // LEAK_FIXTURES 中的一个普通文本漏网文件

    const eResult = invokeSweep(srcDir, mirrorResidualDir, { simulateResidualFor: residualTarget });
    if (eResult.exitCode !== 0) {
        ok(`[删除失败] 模拟残留后脚本以非 0 退出（exit=${eResult.exitCode}）`);
    } else {
        bad('[删除失败] 模拟残留后脚本仍以 0 退出，fail-closed 未生效');
    }
    const failedDeletionsE = toArray(eResult.result.FailedDeletions);
    const failedRelsE = failedDeletionsE.map((f) => f.Path);
    if (failedRelsE.includes(residualTarget)) {
        ok(`[删除失败] FailedDeletions 正确记录残留文件：${residualTarget}（原因：${failedDeletionsE.find((f) => f.Path === residualTarget).Reason}）`);
    } else {
        bad(`[删除失败] FailedDeletions 未记录残留文件，实得 ${JSON.stringify(failedDeletionsE)}`);
    }
    if (exists(mirrorResidualDir, residualTarget)) {
        ok('[删除失败] 残留文件确实还在磁盘上（桩生效：跳过了真实删除）');
    } else {
        bad('[删除失败] 残留文件已不在磁盘——测试桩没有正确跳过删除，Part E 前提不成立');
    }
    // 其余正常漏网文件不受这一个残留影响，仍应被正常删除
    const otherLeaks = Object.keys(LEAK_FIXTURES).filter((r) => r !== residualTarget);
    const otherLeaksRemoved = otherLeaks.every((r) => !exists(mirrorResidualDir, r));
    if (otherLeaksRemoved) {
        ok('[删除失败] 其余漏网文件不受一个残留项拖累，仍被正常删除');
    } else {
        bad('[删除失败] 其余漏网文件未被正常删除，残留处理逻辑影响了无关文件');
    }

    // ════════════════════════════════════════════════════════════════
    // Part F：单元素跟踪清单边界——防 `return $set` 降级为字符串子串匹配
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part F] 单元素跟踪清单边界——防 HashSet 返回值被降级为裸字符串导致子串误放行');
    const srcSingleDir = path.join(tmpRoot, 'src-single');
    const mirrorSingleDir = path.join(tmpRoot, 'mirror-single');
    assertSafeTempRoot(srcSingleDir);
    assertSafeTempRoot(mirrorSingleDir);

    const SINGLE_TRACKED_FILE = 'only-tracked-file.js';
    const SINGLE_TRACKED_CONTENT = 'module.exports = 1;\n';
    // 子串探针：真实跟踪文件名的子串，但本身并未被主仓跟踪——若 `return $set` 未修复，
    // PowerShell 会把单元素 HashSet 输出降级为裸字符串 "only-tracked-file.js"，调用方
    // `.Contains($rel)` 就变成 String.Contains()：而 "only-tracked-file.js".Contains("tracked-file.js")
    // 为 true，会把这个未跟踪的探针文件误判为"已跟踪"从而误放行（不删）。
    const SINGLE_SUBSTRING_LEAK = 'tracked-file.js';

    fs.mkdirSync(srcSingleDir, { recursive: true });
    writeFileEnsureDir(path.join(srcSingleDir, SINGLE_TRACKED_FILE), SINGLE_TRACKED_CONTENT);
    gitInitMain(srcSingleDir);
    gitCommitAll(srcSingleDir, 'single tracked file');

    fs.mkdirSync(mirrorSingleDir, { recursive: true });
    writeFileEnsureDir(path.join(mirrorSingleDir, SINGLE_TRACKED_FILE), SINGLE_TRACKED_CONTENT);
    writeFileEnsureDir(path.join(mirrorSingleDir, SINGLE_SUBSTRING_LEAK), 'should be deleted, not a tracked path\n');

    const { exitCode: exitF, result: resultF } = invokeSweep(srcSingleDir, mirrorSingleDir, {});
    const removedF = toArray(resultF.Removed);
    const keptF = toArray(resultF.Kept);
    if (exists(mirrorSingleDir, SINGLE_TRACKED_FILE) && keptF.includes(SINGLE_TRACKED_FILE)) {
        ok(`[单元素边界] 唯一跟踪文件保留：${SINGLE_TRACKED_FILE}`);
    } else {
        bad(`[单元素边界] 唯一跟踪文件被误删：${SINGLE_TRACKED_FILE}`);
    }
    if (!exists(mirrorSingleDir, SINGLE_SUBSTRING_LEAK) && removedF.includes(SINGLE_SUBSTRING_LEAK)) {
        ok(`[单元素边界] 子串探针文件已被正确删除（HashSet 精确匹配生效，未降级为子串匹配）：${SINGLE_SUBSTRING_LEAK}`);
    } else {
        bad(`[单元素边界] 子串探针文件未被删除——疑似 return $set 降级为裸字符串子串匹配复发：${SINGLE_SUBSTRING_LEAK}`);
    }
    assertNormalTermination(exitF, resultF, 'Part F');
    assertSubsetInvariant(mirrorSingleDir, [SINGLE_TRACKED_FILE], 'Part F');

    // ════════════════════════════════════════════════════════════════
    // Part G：ReparsePoint 不跟进 + H3②（codex 74 二收口批）子目录 reparse point 不再静默
    //   跳过——记入异常清单，非空即整体判失败、阻止同步（不自动删除链接本身，保守取向）。
    //   （PS 5.1 New-Item -ItemType Junction 建目录联接通常不需要管理员权限；若当前环境创建
    //    失败，按任务允许的 escape hatch 报告说明并跳过，不计入失败数。）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part G] ReparsePoint 不跟进 + H3②子目录 reparse 记异常阻止同步');
    const externalDecoyDir = path.join(tmpRoot, 'external-decoy');
    const mirrorJunctionDir = path.join(tmpRoot, 'mirror-junction');
    assertSafeTempRoot(externalDecoyDir);
    assertSafeTempRoot(mirrorJunctionDir);

    fs.mkdirSync(externalDecoyDir, { recursive: true });
    const outsideSecretFile = path.join(externalDecoyDir, 'outside-secret.txt');
    fs.writeFileSync(outsideSecretFile, '这是镜像目录树之外的真实文件，绝不能被 sweep 删除\n', 'utf8');

    fs.mkdirSync(mirrorJunctionDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(mirrorJunctionDir, rel), content);
    }
    const junctionLinkPath = path.join(mirrorJunctionDir, 'linked-decoy');
    const junctionG = tryCreateJunction(junctionLinkPath, externalDecoyDir);

    if (!junctionG.created) {
        skipped(`[ReparsePoint] junction 创建失败（exit=${junctionG.status}），环境不支持，按预案跳过本 Part，不计入失败数。stderr: ${junctionG.stderr}`);
    } else {
        const { exitCode: exitG, result: resultG } = invokeSweep(srcDir, mirrorJunctionDir, {});
        const enumErrorsG = toArray(resultG.EnumerationErrors);

        // H3②核心断言：子目录 reparse point 存在时，整个 sweep 必须判失败——不能悄悄跳过继续。
        if (exitG !== 0) {
            ok(`[H3②子目录reparse] 子目录是 reparse point 时脚本以非 0 退出（exit=${exitG}）`);
        } else {
            bad('[H3②子目录reparse] 子目录是 reparse point 时脚本仍以 0 退出，H3②未生效');
        }
        if (enumErrorsG.some((e) => String(e).includes('linked-decoy'))) {
            ok('[H3②子目录reparse] EnumerationErrors 记录了该 reparse point 子目录（未跟进枚举但已记异常）');
        } else {
            bad(`[H3②子目录reparse] EnumerationErrors 未记录 reparse 子目录：${JSON.stringify(enumErrorsG)}`);
        }
        if (toArray(resultG.Removed).length === 0 && toArray(resultG.Kept).length === 0) {
            ok('[H3②子目录reparse] 判失败后未对任何文件做删除/保留判定（不信任不完整的枚举结果）');
        } else {
            bad(`[H3②子目录reparse] 判失败后仍产出了 Removed/Kept：Removed=${JSON.stringify(resultG.Removed)}, Kept=${JSON.stringify(resultG.Kept)}`);
        }
        // 核心断言：junction 目标外部的真实文件必须原封不动
        if (fs.existsSync(outsideSecretFile)) {
            ok('[ReparsePoint] junction 目标外部文件未被删除（未跟进枚举，未触及镜像根目录之外）');
        } else {
            bad('[ReparsePoint] junction 目标外部文件被删除——sweep 经由 junction 逃出了镜像根目录，严重回归！');
        }
        // 主仓已跟踪文件物理未被触碰（早退路径压根没有进入删除判定）
        if (Object.keys(TRACKED_FILES).every((rel) => exists(mirrorJunctionDir, rel))) {
            ok('[ReparsePoint] 主仓已跟踪文件物理未被触碰（判失败后未执行任何删除）');
        } else {
            bad('[ReparsePoint] 主仓已跟踪文件在 junction 测试中意外缺失');
        }
    }

    // ════════════════════════════════════════════════════════════════
    // Part H：H3①（codex 74）镜像根路径自身是 reparse point——直接拒绝扫描、整体判失败。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part H] H3①镜像根路径自身是 reparse point——直接判失败，拒绝扫描');
    const mirrorRootJunctionTarget = path.join(tmpRoot, 'mirror-root-junction-target');
    const mirrorRootJunctionLink = path.join(tmpRoot, 'mirror-root-junction-link');
    assertSafeTempRoot(mirrorRootJunctionTarget);
    assertSafeTempRoot(mirrorRootJunctionLink);
    fs.mkdirSync(mirrorRootJunctionTarget, { recursive: true });
    writeFileEnsureDir(path.join(mirrorRootJunctionTarget, 'leak.js'), 'leftover\n');
    const junctionH = tryCreateJunction(mirrorRootJunctionLink, mirrorRootJunctionTarget);

    if (!junctionH.created) {
        skipped(`[H3①根reparse] junction 创建失败（exit=${junctionH.status}），环境不支持，按预案跳过本 Part，不计入失败数。stderr: ${junctionH.stderr}`);
    } else {
        const { exitCode: exitH, result: resultH } = invokeSweep(srcDir, mirrorRootJunctionLink, {});
        if (exitH !== 0) {
            ok(`[H3①根reparse] 镜像根本身是 reparse point 时脚本以非 0 退出（exit=${exitH}）`);
        } else {
            bad('[H3①根reparse] 镜像根本身是 reparse point 时脚本仍以 0 退出');
        }
        const enumErrorsH = toArray(resultH.EnumerationErrors);
        if (enumErrorsH.some((e) => /reparse point/.test(String(e)))) {
            ok('[H3①根reparse] EnumerationErrors 记录了"镜像根路径本身是 reparse point"');
        } else {
            bad(`[H3①根reparse] EnumerationErrors 未记录根路径异常：${JSON.stringify(enumErrorsH)}`);
        }
        if (toArray(resultH.Removed).length === 0 && toArray(resultH.Kept).length === 0) {
            ok('[H3①根reparse] Removed/Kept 均为空（拒绝扫描后未对任何内容做判定）');
        } else {
            bad(`[H3①根reparse] Removed/Kept 不为空：Removed=${JSON.stringify(resultH.Removed)}, Kept=${JSON.stringify(resultH.Kept)}`);
        }
        if (exists(mirrorRootJunctionTarget, 'leak.js')) {
            ok('[H3①根reparse] junction 目标目录内容未被触碰');
        } else {
            bad('[H3①根reparse] junction 目标目录内容被误删——sweep 未拒绝就扫描了链接目标！');
        }
    }

    // ════════════════════════════════════════════════════════════════
    // Part I：H1（codex 74）目录枚举错误不再静默吞掉——ACL 拒绝访问的子目录须记异常、
    //   整体判失败阻止同步（此前用 -ErrorAction SilentlyContinue 会让整个子树悄悄漏过）。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part I] H1 目录枚举错误不再静默吞掉——ACL 拒绝访问的子目录须记异常、阻止同步');
    const mirrorEnumErrDir = path.join(tmpRoot, 'mirror-enum-err');
    assertSafeTempRoot(mirrorEnumErrDir);
    fs.mkdirSync(mirrorEnumErrDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(mirrorEnumErrDir, rel), content);
    }
    const deniedSubdir = path.join(mirrorEnumErrDir, 'denied-subdir');
    fs.mkdirSync(deniedSubdir, { recursive: true });
    fs.writeFileSync(path.join(deniedSubdir, 'inner.txt'), 'secret\n', 'utf8');

    const denyListingI = applyDenyAcl(deniedSubdir, 'ListDirectory,ReadData');
    if (!denyListingI.applied) {
        skipped(`[H1] ACL 拒绝目录列举应用失败（exit=${denyListingI.status}），环境不支持，按预案跳过本 Part，不计入失败数。stderr: ${denyListingI.stderr}`);
    } else {
        try {
            const { exitCode: exitI, result: resultI } = invokeSweep(srcDir, mirrorEnumErrDir, {});
            if (exitI !== 0) {
                ok(`[H1] 目录枚举失败时脚本以非 0 退出（exit=${exitI}）`);
            } else {
                bad('[H1] 目录枚举失败时脚本仍以 0 退出，H1 未生效');
            }
            const enumErrorsI = toArray(resultI.EnumerationErrors);
            if (enumErrorsI.some((e) => String(e).includes('denied-subdir'))) {
                ok('[H1] EnumerationErrors 记录了被拒绝访问的子目录');
            } else {
                bad(`[H1] EnumerationErrors 未记录被拒绝访问的子目录：${JSON.stringify(enumErrorsI)}`);
            }
            if (toArray(resultI.Removed).length === 0 && toArray(resultI.Kept).length === 0) {
                ok('[H1] 判失败后未做任何删除/保留判定（不信任不完整的枚举结果）');
            } else {
                bad(`[H1] 判失败后仍产出了 Removed/Kept：Removed=${JSON.stringify(resultI.Removed)}, Kept=${JSON.stringify(resultI.Kept)}`);
            }
            const trackedUntouchedI = Object.keys(TRACKED_FILES).every((rel) => exists(mirrorEnumErrDir, rel));
            if (trackedUntouchedI) {
                ok('[H1] 主仓已跟踪文件物理未被触碰');
            } else {
                bad('[H1] 主仓已跟踪文件在枚举失败测试中意外缺失');
            }
        } finally {
            // 先撤销 Deny ACL，否则 finally 块整体清理 tmpRoot 时会因该目录不可列举/不可删除而失败。
            const cleanup = removeDenyAcl(deniedSubdir, 'ListDirectory,ReadData');
            if (cleanup.status !== 0) {
                console.log(`  [WARN] Part I 清理 ACL Deny 规则失败（不影响判定，可能导致临时目录清理告警）：${(cleanup.stderr || '').trim()}`);
            }
        }
    }

    // ════════════════════════════════════════════════════════════════
    // Part J：H2（codex 74）main 分支判据的输入有效性——main 缺失 / 清单为空
    //   均须 fail-closed（安全阀是附加保护，不能替代输入清单本身有效这道更基础的校验）。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part J] H2 main 分支判据的输入有效性——main 缺失 / 清单为空均须 fail-closed');

    // J1：main 分支根本不存在（默认分支故意叫别的名字）
    const srcNoMainDir = path.join(tmpRoot, 'src-no-main');
    const mirrorNoMainDir = path.join(tmpRoot, 'mirror-no-main');
    assertSafeTempRoot(srcNoMainDir);
    assertSafeTempRoot(mirrorNoMainDir);
    fs.mkdirSync(srcNoMainDir, { recursive: true });
    writeFileEnsureDir(path.join(srcNoMainDir, 'a.txt'), 'x\n');
    run('git', ['init', '-q'], { cwd: srcNoMainDir });
    run('git', ['checkout', '-q', '-b', 'trunk'], { cwd: srcNoMainDir }); // 故意不叫 main
    gitCommitAll(srcNoMainDir, 'no main branch here');
    const branchJ1 = run('git', ['branch', '--show-current'], { cwd: srcNoMainDir }).trim();
    if (branchJ1 !== 'trunk') {
        bad(`[H2 main缺失] fixture 构造异常：当前分支应为 trunk，实际为 '${branchJ1}'`);
    }

    fs.mkdirSync(mirrorNoMainDir, { recursive: true });
    writeFileEnsureDir(path.join(mirrorNoMainDir, 'a.txt'), 'x\n');

    const hardFailNoMain = invokeSweepExpectHardFailure(srcNoMainDir, mirrorNoMainDir);
    if (hardFailNoMain.exitCode !== 0) {
        ok(`[H2 main缺失] main 分支不存在时脚本以非 0 退出（exit=${hardFailNoMain.exitCode}）`);
    } else {
        bad('[H2 main缺失] main 分支不存在时脚本仍以 0 退出，H2①未生效');
    }
    if (/main/.test(hardFailNoMain.stdout) || /main/.test(hardFailNoMain.stderr)) {
        ok('[H2 main缺失] 错误输出提及 main 分支缺失（人工可读诊断信息存在）');
    } else {
        bad(`[H2 main缺失] 错误输出未见 main 相关提示：stdout=${hardFailNoMain.stdout} stderr=${hardFailNoMain.stderr}`);
    }
    if (exists(mirrorNoMainDir, 'a.txt')) {
        ok('[H2 main缺失] 镜像文件未被触碰（输入校验阶段就已中止，未进入删除逻辑）');
    } else {
        bad('[H2 main缺失] 镜像文件意外消失');
    }

    // J2：main 分支存在，但清单为 0 条跟踪文件（空 commit）——同样视为异常。
    const srcEmptyMainDir = path.join(tmpRoot, 'src-empty-main');
    const mirrorEmptyMainDir = path.join(tmpRoot, 'mirror-empty-main');
    assertSafeTempRoot(srcEmptyMainDir);
    assertSafeTempRoot(mirrorEmptyMainDir);
    fs.mkdirSync(srcEmptyMainDir, { recursive: true });
    gitInitMain(srcEmptyMainDir);
    run('git', [...GIT_AUTHOR_ARGS, 'commit', '-q', '--allow-empty', '-m', 'empty init'], { cwd: srcEmptyMainDir });

    fs.mkdirSync(mirrorEmptyMainDir, { recursive: true });
    writeFileEnsureDir(path.join(mirrorEmptyMainDir, 'leak.js'), 'leftover\n');

    const hardFailEmptyMain = invokeSweepExpectHardFailure(srcEmptyMainDir, mirrorEmptyMainDir);
    if (hardFailEmptyMain.exitCode !== 0) {
        ok(`[H2 空清单] main 存在但 0 条跟踪文件时脚本以非 0 退出（exit=${hardFailEmptyMain.exitCode}）`);
    } else {
        bad('[H2 空清单] main 存在但 0 条跟踪文件时脚本仍以 0 退出，H2③未生效');
    }
    if (exists(mirrorEmptyMainDir, 'leak.js')) {
        ok('[H2 空清单] 镜像文件未被触碰（0 条清单本身即视为异常，未进入删除逻辑）');
    } else {
        bad('[H2 空清单] 镜像文件被误删——0 条清单被当成"合法的空跟踪集"，会把镜像所有文件当未跟踪全删！');
    }

    // ════════════════════════════════════════════════════════════════
    // Part K：L1（codex 74/76）ls-tree 使用 -z NUL 分隔而非按行分隔。
    //   ①源码存在性核对（非端到端）——Windows/NTFS 禁止文件名含 `< > : " / \ | ? *` 及控制字符
    //   （0x00-0x1F），这些恰好正是 git 在无 -z 时会做 C 风格转义/引号包裹的触发字符集合，本机
    //   无法用真实文件系统构造一个"没有 -z 就会被错误按行拆开"的文件名做端到端回归——这条只能
    //   证明"`-z` 参数字面存在、修复未被回退"，不能证明解析行为本身正确，如实标注为"非端到端"。
    //   ②可注入输入的真实解析单测（codex 76 新增）——解析逻辑已抽成独立函数
    //   ConvertFrom-NulSeparatedGitOutput（见 sync-to-github.ps1），可以脱离 git 调用与真实文件
    //   系统限制：直接构造模拟的 ls-tree -z 原始字节（含换行/引号/反斜杠/CJK 的路径记录）写入
    //   临时文件，喂给 -FailClosedParseNulTestFile 测试出口，断言路径被完整还原——这才是本 Part
    //   里唯一真正覆盖"解析器行为"（而非仅"源码字面量"）的用例。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part K] L1 ls-tree -z NUL 分隔 —— ①源码存在性核对（非端到端）②可注入输入的真实解析单测');
    const syncScriptSrc = fs.readFileSync(SYNC_SCRIPT, 'utf8');
    if (/ls-tree\s+-r\s+-z\s+--name-only\s+main/.test(syncScriptSrc)) {
        ok('[L1①源码核对-非端到端] sync-to-github.ps1 的 ls-tree 调用已加 `-z`（NUL 分隔，非按行分隔）——仅证明参数存在，不证明解析行为正确');
    } else {
        bad('[L1①源码核对-非端到端] 未在源码中找到带 `-z` 的 ls-tree 调用——L1 修复疑似未落地或被改写');
    }

    // L1②：构造模拟 ls-tree -z 原始字节（NUL 分隔记录，含"换行/引号/反斜杠/CJK"注入字符），
    // 直接喂给抽出的解析函数 ConvertFrom-NulSeparatedGitOutput（不经过 git、不落真实文件），
    // 断言路径被完整还原。
    const injectFixtureRecords = [
        'README.md',
        'docs/embedded\nnewline.md',            // 换行注入：若无 join(`n`)→split(NUL) 往返会被拆行
        'path with "quotes".txt',                // 引号注入：-z 模式不做 C 风格转义，引号应原样保留
        'path\\with\\backslash.txt',             // 反斜杠注入：不应被当分隔符或被吞掉
        '文档/说明（含反斜杠 \\ 与引号 "）.md',   // CJK + 反斜杠 + 引号复合场景
    ];
    const injectFixtureFile = path.join(tmpRoot, 'nul-parse-fixture.bin');
    writeFileEnsureDir(injectFixtureFile, Buffer.from(injectFixtureRecords.join('\0') + '\0', 'utf8'));
    const parseTestR = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SYNC_SCRIPT,
        '-FailClosedParseNulTestFile', injectFixtureFile,
    ], { encoding: 'utf8' });
    let parsedInjectResult = null;
    try {
        const ptLines = parseTestR.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        parsedInjectResult = JSON.parse(ptLines[ptLines.length - 1]);
    } catch (e) {
        bad(`[L1②可注入解析单测] 解析出口输出非合法 JSON（exit ${parseTestR.status}）：STDOUT=${parseTestR.stdout} STDERR=${parseTestR.stderr}`);
    }
    if (parsedInjectResult !== null) {
        const parsedArr = toArray(parsedInjectResult);
        if (JSON.stringify(parsedArr) === JSON.stringify(injectFixtureRecords)) {
            ok(`[L1②可注入解析单测] ${injectFixtureRecords.length} 条注入路径（含换行/引号/反斜杠/CJK）全部被完整还原，顺序与内容精确匹配`);
        } else {
            bad(`[L1②可注入解析单测] 路径还原不完整或顺序/内容有误：期望 ${JSON.stringify(injectFixtureRecords)}，实得 ${JSON.stringify(parsedArr)}`);
        }
    }
    if (parseTestR.status === 0) {
        ok('[L1②可注入解析单测] 解析测试出口以 0 退出');
    } else {
        bad(`[L1②可注入解析单测] 解析测试出口以非 0 退出（exit=${parseTestR.status}）`);
    }

    // ════════════════════════════════════════════════════════════════
    // Part L：M1（codex 74）main-only 文件——main 独有、feature 已删除该文件，
    //   checkout 停在 feature 时，判据仍须取 main 的直接证据、保留该文件。
    //   （Part C 只验证了"feature 独有文件应删除"这一个方向，未覆盖其逆命题。）
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part L] M1 main-only 文件——main 独有、feature 已删除，checkout 停在 feature 仍须保留');
    const srcMainOnlyDir = path.join(tmpRoot, 'src-main-only');
    const mirrorMainOnlyDir = path.join(tmpRoot, 'mirror-main-only');
    assertSafeTempRoot(srcMainOnlyDir);
    assertSafeTempRoot(mirrorMainOnlyDir);

    const MAIN_ONLY_FILE = 'main-only-file.js';
    fs.mkdirSync(srcMainOnlyDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(srcMainOnlyDir, rel), content);
    }
    writeFileEnsureDir(path.join(srcMainOnlyDir, MAIN_ONLY_FILE), 'only ever existed on main\n');
    gitInitMain(srcMainOnlyDir);
    gitCommitAll(srcMainOnlyDir, 'main has the file');
    run('git', ['checkout', '-q', '-b', 'feature'], { cwd: srcMainOnlyDir });
    run('git', [...GIT_AUTHOR_ARGS, 'rm', '-q', MAIN_ONLY_FILE], { cwd: srcMainOnlyDir });
    gitCommitAll(srcMainOnlyDir, 'feature deletes the main-only file');
    const currentBranchL = run('git', ['branch', '--show-current'], { cwd: srcMainOnlyDir }).trim();
    if (currentBranchL !== 'feature') {
        bad(`[M1] fixture 构造异常：当前 checkout 分支应为 feature，实际为 '${currentBranchL}'`);
    }
    if (fs.existsSync(path.join(srcMainOnlyDir, MAIN_ONLY_FILE))) {
        bad('[M1] fixture 构造异常：feature 分支工作树里不应再有该文件');
    }

    fs.mkdirSync(mirrorMainOnlyDir, { recursive: true });
    for (const [rel, content] of Object.entries(TRACKED_FILES)) {
        writeFileEnsureDir(path.join(mirrorMainOnlyDir, rel), content);
    }
    // 模拟镜像里还留着此前在 main 分支跑同步时复制进来的旧副本——当前 feature 工作树已经没有它了，
    // 但 main 分支的 git 历史里仍然跟踪着它，判据必须取这个"main 的直接证据"。
    writeFileEnsureDir(path.join(mirrorMainOnlyDir, MAIN_ONLY_FILE), 'only ever existed on main\n');

    const { exitCode: exitL, result: resultL } = invokeSweep(srcMainOnlyDir, mirrorMainOnlyDir, {});
    const keptL = toArray(resultL.Kept);
    if (exists(mirrorMainOnlyDir, MAIN_ONLY_FILE) && keptL.includes(MAIN_ONLY_FILE)) {
        ok(`[M1] main-only 文件被正确保留（判据取 main 的直接证据，不受当前 checkout=feature 已删除影响）：${MAIN_ONLY_FILE}`);
    } else {
        bad(`[M1] main-only 文件被误删——判据疑似退化为"当前 checkout 分支/工作树是否存在该文件"：${MAIN_ONLY_FILE}`);
    }
    for (const rel of Object.keys(TRACKED_FILES)) {
        if (exists(mirrorMainOnlyDir, rel) && keptL.includes(rel)) {
            ok(`[M1] 普通 main 跟踪文件同样保留：${rel}`);
        } else {
            bad(`[M1] 普通 main 跟踪文件被误删：${rel}`);
        }
    }
    assertNormalTermination(exitL, resultL, 'Part L (M1 main-only)');
    assertSubsetInvariant(mirrorMainOnlyDir, [...Object.keys(TRACKED_FILES), MAIN_ONLY_FILE], 'Part L (M1 main-only)');

    // ════════════════════════════════════════════════════════════════
    // Part M：M3（codex 74）删除失败 fail-closed 的真实异常路径——Part E 的桩只覆盖了
    //   "Test-Path 复核发现残留"分支，未覆盖 `Remove-Item -ErrorAction Stop` 真正抛异常进
    //   catch 的分支。本机实测：Node fs.openSync 持句柄不阻挡 Windows Remove-Item -Force
    //   （见任务实测记录），改用 ACL Deny（Delete,Write,WriteData）触发真实 IO 异常——本机
    //   实测已验证 Remove-Item 在此条件下抛 System.ArgumentException("Access to the path is
    //   denied.")，稳定复现。
    // ════════════════════════════════════════════════════════════════
    console.log('\n[Part M] M3 删除失败 fail-closed——真实 Remove-Item 异常路径（ACL Deny，非复核残留桩）');
    const mirrorAclDenyDir = path.join(tmpRoot, 'mirror-acl-deny');
    assertSafeTempRoot(mirrorAclDenyDir);
    buildMirrorFixture(mirrorAclDenyDir);
    const aclDenyTarget = 'leak.js';
    const aclDenyTargetPath = path.join(mirrorAclDenyDir, aclDenyTarget);

    const denyDeleteM = applyDenyAcl(aclDenyTargetPath, 'Delete,Write,WriteData');
    if (!denyDeleteM.applied) {
        skipped(`[M3] ACL Deny 应用失败（exit=${denyDeleteM.status}），环境不支持，按预案跳过本 Part，不计入失败数。stderr: ${denyDeleteM.stderr}`);
    } else {
        try {
            const { exitCode: exitM, result: resultM } = invokeSweep(srcDir, mirrorAclDenyDir, {});
            if (exitM !== 0) {
                ok(`[M3] ACL 拒绝删除后脚本以非 0 退出（exit=${exitM}）`);
            } else {
                bad('[M3] ACL 拒绝删除后脚本仍以 0 退出，fail-closed 未生效');
            }
            const failedDeletionsM = toArray(resultM.FailedDeletions);
            const failedEntryM = failedDeletionsM.find((f) => f.Path === aclDenyTarget);
            if (failedEntryM) {
                // 真实异常路径的 Reason 应来自 Remove-Item 抛出的异常消息，不是 Part E 桩的固定文案——
                // 用措辞差异证明本用例走的是 catch 分支而不是 Test-Path 复核分支。
                const looksLikeResidualStubWording = /Test-Path 复核发现文件仍残留/.test(failedEntryM.Reason || '');
                if (!looksLikeResidualStubWording) {
                    ok(`[M3] FailedDeletions 正确记录 ACL 拒绝异常（走 Remove-Item catch 分支，非 Part E 复核残留桩）：${failedEntryM.Reason}`);
                } else {
                    bad(`[M3] FailedDeletions 的 Reason 命中了 Part E 桩的固定文案，疑似没有走到真实 Remove-Item 异常分支：${failedEntryM.Reason}`);
                }
            } else {
                bad(`[M3] FailedDeletions 未记录 ACL 拒绝的文件，实得 ${JSON.stringify(failedDeletionsM)}`);
            }
            if (exists(mirrorAclDenyDir, aclDenyTarget)) {
                ok('[M3] ACL 拒绝的文件确实还在磁盘上（真实删除失败，不是桩伪造的）');
            } else {
                bad('[M3] ACL 拒绝的文件已不在磁盘——真实删除异常前提不成立');
            }
            const otherLeaksM = Object.keys(LEAK_FIXTURES).filter((r) => r !== aclDenyTarget);
            const otherLeaksRemovedM = otherLeaksM.every((r) => !exists(mirrorAclDenyDir, r));
            if (otherLeaksRemovedM) {
                ok('[M3] 其余漏网文件不受这一个真实删除异常拖累，仍被正常删除');
            } else {
                bad('[M3] 其余漏网文件未被正常删除，真实异常处理逻辑影响了无关文件');
            }
        } finally {
            // 先撤销 Deny ACL，否则 finally 块整体清理 tmpRoot 时会因该文件不可删除而失败。
            const cleanup = removeDenyAcl(aclDenyTargetPath, 'Delete,Write,WriteData');
            if (cleanup.status !== 0) {
                console.log(`  [WARN] Part M 清理 ACL Deny 规则失败（不影响判定，可能导致临时目录清理告警）：${(cleanup.stderr || '').trim()}`);
            }
        }
    }
} catch (e) {
    bad(`执行过程抛出异常：${e && e.message ? e.message : e}`);
} finally {
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        console.log(`\n  已清理临时目录：${tmpRoot}`);
    } catch (e) {
        cleanupOk = false;
        console.log(`\n  [WARN] 临时目录清理失败（不影响判定，需人工清理）：${tmpRoot} — ${e.message}`);
    }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ===`);
if (!cleanupOk) console.log('（临时目录清理失败，已单独 WARN，不计入失败数）');
// M2a（codex 76）：skipped ≠ passed——某用例因环境能力缺失（junction 建不出/ACL 不可用等）被
// 跳过时，代表它对应的判定面本次运行"未被验证"，绝不能悄悄并进"通过"里让人误读为全绿。
// 非零 skip 计数：① 末尾醒目汇总打印每条跳过原因 ② exit 码同样非 0（不再只看 fail）——
// 把"未执行"从"通过"里结构性分离出来。本机实测 0 skipped，这里是结构性保障，非本次触发。
if (skip > 0) {
    console.log('\n' + '!'.repeat(72));
    console.log(`  [SKIP 汇总] ${skip} 个用例因环境能力缺失被跳过（未执行 ≠ 已通过），以下判定面`);
    console.log('  本次运行未被验证：');
    skipMessages.forEach((m, i) => console.log(`    ${i + 1}. ${m}`));
    console.log('  请检查本机环境（junction 创建权限 / ACL 修改权限等）后重跑，确认能收敛到 0 skipped。');
    console.log('!'.repeat(72));
}
process.exit(fail === 0 && skip === 0 ? 0 : 1);
