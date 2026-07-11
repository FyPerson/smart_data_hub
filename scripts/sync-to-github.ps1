# Sync to GitHub Script — incremental snapshot to public mirror
# Called by: /deploy skill (step 10b) after production deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/sync-to-github.ps1 -CommitMessage "..."
#
# Flow:
#   0.  前置检查
#   1.  robocopy 源项目 → 镜像（同字节文件自动跳过）
#   2.  清除镜像中的非公开内容（mcp-*, docs/local, etc）
#   2.5 脱敏完整性预检（读 users 表，任一真名/手机号未配脱敏规则即 fail-fast）★兜底报警
#   3.  跑批量敏感词替换（真名/手机号从 $nameMap/$phoneMap 单一来源生成）
#   4.  残留敏感词扫描（fail-fast；扫描模式从同一来源自动派生，与替换表零漂移）
#   5.  git status 检查变更范围，> 10 文件停下来询问
#   6.  git add + commit + push
#
# 镜像位置：e:/tmp/smart-data-hub-public/
# 镜像须先经过 /deploy skill 第一次同步建立（已于 2026-05-14 完成）
#
# ★ 信息治理（2026-06-17 系统梳理重构 + codex 复审加固）：脱敏「单一真相源」=
#   $nameMap（真名）/ $phoneMap（手机号）/ $entityMap（实体名）。替换（步骤3）、
#   残留扫描（步骤4）、完整性预检（步骤2.5）三处全部从这三张表派生，彻底消除
#   「补替换漏补扫描」的双表漂移，以及「新增员工漏脱敏」的逐个补反复。
#   · 文件后缀也单一来源 $textExts（替换与扫描共用），防后缀表漂移。
#   · 预检默认 fail-fast：读不到 users 表即中止；确需跳过传 -SkipNameAudit。
#   · 预检优先读最新「生产数据库备份」（比本地库更接近生产真相），缺则回落本地。
#   · -DryRun 跑全部脱敏 + 预检 + 扫描但不 commit/push，用于安全验证。

param(
    [Parameter(Mandatory=$true)]
    [string]$CommitMessage,

    [string]$SourcePath = "e:\数据开发与治理规范手册",
    [string]$MirrorPath = "e:\tmp\smart-data-hub-public",

    # 跳过弹问（CI 用 / 自动化用）
    [switch]$NoConfirm,

    # 强制全量同步（即使无变化也提交）
    [switch]$ForceCommit,

    # 演练模式：跑 robocopy + 清理 + 预检 + 替换 + 残留扫描，但不 git add/commit/push
    [switch]$DryRun,

    # 显式跳过脱敏完整性预检（默认 fail-fast）。仅在确认 users 库不可读且人工已核对时用。
    [switch]$SkipNameAudit
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # 捕获 node 等原生命令 stdout 的解码编码
$OutputEncoding = [System.Text.Encoding]::UTF8             # 发给原生命令的编码（codex M-3 加固）

function Write-Phase($title) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
}

# ════════════════════════════════════════════════════════════════════════════
#  脱敏「单一真相源」（2026-06-17 系统梳理重构 + codex 复审加固）
#  $nameMap（真名）/ $phoneMap（手机号）/ $entityMap（实体名）是脱敏的唯一来源——
#    · 步骤 3 替换：遍历这三表生成替换规则
#    · 步骤 4 残留扫描：遍历这三表生成扫描模式（与替换零漂移，补一条即自动护栏）
#    · 步骤 2.5 完整性预检：读 users 表，任一真名/手机号不在表内即 fail-fast
#  ⚠️ 新增/移除员工只改 $nameMap + $phoneMap 这两处。改完用 -DryRun 验证。
#  ⚠️ 占位符语义仅为可读性（客服/开发/发布者等对齐角色），不影响脱敏正确性。
# ════════════════════════════════════════════════════════════════════════════
#  真名清单按【生产备份 users 表】全量（2026-06-17 codex 复审：本地库滞后缺 6 人，改读生产备份）。
$nameMap = [ordered]@{
    '示例用户A'   = '示例用户A'        # id=3  user（项目负责人）
    '示例用户B'   = '示例用户B'        # id=18 admin
    '示例发布者'   = '示例发布者'       # id=7  publisher（对接人白名单）
    '示例对接人' = '示例对接人'       # id=13 user（对接人白名单）
    '示例只读领导A' = '示例只读领导A'    # id=11 viewer（只读领导）
    '示例只读领导B' = '示例只读领导B'    # id=6  viewer（只读领导）
    '示例客服A' = '示例客服A'        # id=2  admin（客服性质运营）
    '示例客服B'   = '示例客服B'        # id=4  admin（客服性质运营）
    '示例客服C' = '示例客服C'        # id=5  admin（客服性质运营）
    '示例开发A' = '示例开发A'        # id=8  user（开发/数据导出人）
    '示例开发B'   = '示例开发B'        # id=9  user
    '示例开发C'   = '示例开发C'        # id=10 user
    '示例开发D'   = '示例开发D'        # id=12 user
    '示例开发E' = '示例开发E'        # id=14 user
    '示例开发F' = '示例开发F'        # id=15 user
    '示例开发G' = '示例开发G'        # id=16 user
    '示例开发H' = '示例开发H'        # id=17 user
    '示例管理员A' = '示例管理员A'      # id=19 admin
    '示例开发I' = '示例开发I'        # 新增 2026-06-22（仅占位脱敏；角色未核实，按新增多为开发暂标，可后续校正）
}

# 集团关联方 / 实体名（非 users 表，无完整性预检，手工维护）
$entityMap = [ordered]@{
    '示例集团关联方A' = '示例集团关联方A'
    '示例关联方B'     = '示例关联方B'
    '示例关联方C'     = '示例关联方C'
    '示例关联方D' = '示例关联方D'
    '示例海外子公司' = '示例海外子公司'
}

# 真实手机号（users 表 username/phone 列的 11 位手机）→ 假号（199 段，避开 138 段测试号防碰撞）。
# codex 复审 M-4：示例发布者/示例开发A登录名手机号曾真实泄漏到公开镜像（PII），同 $nameMap 机制根治。
# ⚠️ 新增/移除手机号只改这一处（key 必须是真实手机号；value 是同长度假号，对齐 list-real-names 预检）。
#  手机号清单按【生产备份 users 表】全量 16 个（codex 复审 M-1/M-4）。
$phoneMap = [ordered]@{
    '19900000001' = '19900000001'   # id=3  示例用户A phone
    '19900000002' = '19900000002'   # id=12 示例开发D username
    '19900000003' = '19900000003'   # id=7  示例发布者 username（publisher 登录名）
    '19900000004' = '19900000004'   # id=2  示例客服A phone
    '19900000005' = '19900000005'   # id=8  示例开发A username（exporter 登录名）
    '19900000006' = '19900000006'   # id=18 示例用户B phone
    '19900000007' = '19900000007'   # id=9  示例开发B username
    '19900000008' = '19900000008'   # id=10 示例开发C username
    '19900000009' = '19900000009'   # id=4  示例客服B phone
    '19900000010' = '19900000010'   # id=5  示例客服C phone
    '19900000011' = '19900000011'   # id=13 示例对接人 username
    '19900000012' = '19900000012'   # id=14 示例开发E username
    '19900000013' = '19900000013'   # id=15 示例开发F username
    '19900000014' = '19900000014'   # id=16 示例开发G username
    '19900000015' = '19900000015'   # id=17 示例开发H username
    '19900000016' = '19900000016'   # id=19 示例管理员A phone
}

# 受脱敏覆盖的文本文件后缀「单一来源」（替换步骤3 与扫描步骤4 共用，防后缀表漂移 — codex H-2）。
# 取镜像实际会同步的文本类型 + 常见文本后缀（防未来新增类型漏网）。二进制/媒体不在内。
$textExts = @("*.js","*.html","*.md","*.ps1","*.json","*.py","*.css","*.txt","*.csv","*.yml","*.yaml","*.sql","*.svg","*.ts","*.tsx","*.vue")

# ── 启动自检（codex M-2）：脱敏表自身的健壮性，发现问题即 fail-fast，挡在替换之前 ──
$allRealTokens = @($nameMap.Keys) + @($entityMap.Keys) + @($phoneMap.Keys)
$selfCheckErrors = @()
# (a) 真名/实体名两两包含 → 短串可能误替换长串的一部分。虽已长度降序替换（见步骤3）缓解，
#     但互含本身是脱敏表的隐患，列入 $selfCheckErrors → 末尾统一 fail-fast（非仅告警，需人工调整映射）。
$cjkTokens = @($nameMap.Keys) + @($entityMap.Keys)
foreach ($a in $cjkTokens) {
    foreach ($b in $cjkTokens) {
        if ($a -ne $b -and $b.Contains($a)) {
            $selfCheckErrors += "真名/实体名互相包含：'$a' 是 '$b' 的子串（替换顺序敏感，已按长度降序缓解，请人工确认占位符无歧义）"
        }
    }
}
# (b) 占位符里不得含任何真名/手机号（否则替换后占位符自身被二次扫描命中或再次泄漏）
$allPlaceholders = @($nameMap.Values) + @($entityMap.Values) + @($phoneMap.Values)
foreach ($ph in $allPlaceholders) {
    foreach ($tok in $allRealTokens) {
        if ("$ph".Contains($tok)) { $selfCheckErrors += "占位符 '$ph' 含真实敏感词 '$tok'（会导致替换后仍残留）" }
    }
}
# (c) 占位符重复（不同真名映射到同一占位符）→ 仅告警，不阻断（公开脱敏可接受，但通常是笔误）
if ($selfCheckErrors.Count -gt 0) {
    Write-Phase "[自检] 脱敏表健壮性检查"
    foreach ($e in $selfCheckErrors) { Write-Host "  [SELF-CHECK] $e" -ForegroundColor Red }
    Write-Host "  [ERROR] 脱敏表自检未通过，请修正 `$nameMap/`$entityMap/`$phoneMap 后重跑" -ForegroundColor Red
    exit 1
}

# 前置检查：镜像目录存在 + 是 git repo + 有 origin remote
Write-Phase "[0/6] 前置检查"
if (-not (Test-Path $MirrorPath)) {
    Write-Host "  [ERROR] 镜像目录不存在: $MirrorPath" -ForegroundColor Red
    Write-Host "  请先执行首次同步建立镜像（参考 2026-05-14 流程）" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path "$MirrorPath\.git")) {
    Write-Host "  [ERROR] 镜像目录不是 git repo: $MirrorPath" -ForegroundColor Red
    exit 1
}
$remotes = & git -C $MirrorPath remote 2>$null
if ($remotes -notcontains "origin") {
    Write-Host "  [ERROR] 镜像未配置 origin remote" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] 镜像 git repo 就绪 (origin = $(git -C $MirrorPath remote get-url origin))" -ForegroundColor Green

# === 步骤 1: robocopy 全量同步（同字节跳过） ===
Write-Phase "[1/6] robocopy 源 → 镜像"
$excludeDirs = @(
    "node_modules", ".git",
    "mcp-hrd", "mcp-labor", "mcp-warehouse", "pbixray-mcp-server",
    "outputs", "ppt-comparison", "tmp",
    "uploads", "archive", ".claude",
    "docs\local", "docs\archive", "docs\review",
    "work_todo", "访谈文档", "sql",
    # 2026-05-22 紧急加入（v1.70.1 部署事故根因修复）：
    # 生产数据库备份/（v1.69.x+ deploy-ssh.ps1 步骤 5 拉的 task_pool.db 副本）
    # 生产协作附件备份/（v1.70.1+ deploy-ssh.ps1 步骤 6 拉的 collab 附件含客户名/SQL/截图）
    # 这两个目录在源 repo 根下不能进公开镜像，否则泄漏业务真实客户名 + 数据导出 SQL
    "生产数据库备份", "生产协作附件备份",
    # 2026-07-11 安全加入（v1.111.1 部署事故根因修复）：
    # unify-baseline/（前端统一视觉基线 PNG 截图，.gitignore 忽略·git 未跟踪·本地专用）——
    #   截图用本地生产库数据渲染，页面上真实姓名/手机号可见；PNG 是二进制，步骤 3 文本脱敏
    #   无法覆盖 → 一旦进公开镜像即原样泄漏 PII。⚠️ 通则：任何"渲染了真实数据的图片/二进制"
    #   都绕过文本脱敏，必须在 robocopy 层排除（不能靠步骤 3/4）。
    "unify-baseline"
)
$excludeFiles = @(
    "task_pool.db", "task_pool.db-journal",
    "task_pool_local_backup.db",
    "task_pool.db.before_*", "task_pool.db.backup_*",
    ".env", ".env.local", ".env.production",
    "*.pbix", "*.log", "*.xlsx",
    "d3_manual_verify_seed.js", "d3_manual_verify_submit.js",
    "CLAUDE.md", ".mcp.json", "reference.docx",
    "gen_notice.py",
    # 镜像专属文件 — 源目录没有,但镜像必须保留,robocopy /MIR 不能删
    "LICENSE", ".env.example", ".gitignore", "README.md"
)
# robocopy 选项说明：
#   /E  : 复制所有子目录(含空目录),不用 /MIR(/MIR=/E+/PURGE,/PURGE 会删源没有的文件,会误删镜像专属文件)
#   /XO : Older—仅复制源更新的文件(同字节跳过,且不会用源的旧版本覆盖镜像的新版本——保护已改写的 README.md)
$copyResult = robocopy $SourcePath $MirrorPath /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP /XO 2>&1
# 退出码 0-7 都是成功（8+ 是错误）
if ($LASTEXITCODE -ge 8) {
    Write-Host "  [ERROR] robocopy 失败 (exit $LASTEXITCODE)" -ForegroundColor Red
    Write-Host $copyResult -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] robocopy 完成 (exit $LASTEXITCODE)" -ForegroundColor Green

# === 步骤 2: 删除镜像中可能因 robocopy /MIR 错入或后建的文件 ===
Write-Phase "[2/6] 清除非公开内容（防御性）"
# 重新移除 templates 子目录（含 docx 模板)
if (Test-Path "$MirrorPath\scripts\templates") {
    Remove-Item "$MirrorPath\scripts\templates" -Recurse -Force
    Write-Host "  [OK] removed scripts/templates/" -ForegroundColor Green
}
# 移除 gen_notice.py（依赖 templates）
if (Test-Path "$MirrorPath\scripts\gen_notice.py") {
    Remove-Item "$MirrorPath\scripts\gen_notice.py" -Force
    Write-Host "  [OK] removed scripts/gen_notice.py" -ForegroundColor Green
}
# 移除根 package.json（PPT 工具依赖，跟平台无关）
if (Test-Path "$MirrorPath\package.json") {
    Remove-Item "$MirrorPath\package.json" -Force
    Write-Host "  [OK] removed root package.json" -ForegroundColor Green
}
if (Test-Path "$MirrorPath\package-lock.json") {
    Remove-Item "$MirrorPath\package-lock.json" -Force
}
# 移除 docs/decision/design/req/solution/tech（含业务上下文）+ docs/guide/关于平台.md + docs/standard/项目架构说明.md
$docsToRemove = @(
    "$MirrorPath\docs\decision", "$MirrorPath\docs\design",
    "$MirrorPath\docs\req", "$MirrorPath\docs\solution", "$MirrorPath\docs\tech",
    "$MirrorPath\docs\guide\关于平台.md", "$MirrorPath\docs\standard\项目架构说明.md"
)
foreach ($p in $docsToRemove) {
    if (Test-Path $p) {
        Remove-Item $p -Recurse -Force
        Write-Host "  [OK] removed $($p.Replace($MirrorPath + '\', ''))" -ForegroundColor Green
    }
}

# 2026-07-08 安全清除：mcp-bms 本地数仓 MCP 服务目录（.gitignore 忽略·git 未跟踪·含内网数仓 IP 等基础设施信息）——
#   robocopy /MIR 按文件系统镜像不认 .gitignore 会连带复制进公开镜像，本就不该进公开仓库，兜底删除。
if (Test-Path "$MirrorPath\mcp-bms") {
    Remove-Item "$MirrorPath\mcp-bms" -Recurse -Force
    Write-Host "  [SECURITY] removed mcp-bms/（.gitignore 本地数仓 MCP 目录·防内网 IP 泄漏）" -ForegroundColor Red
}

# 2026-07-11 安全兜底：unify-baseline 视觉基线截图（与 $excludeDirs 双重防御）——
#   robocopy 层已排除，这里兜底删（防未来某处漏配），截图含渲染真实姓名/手机号，PNG 绕过文本脱敏。
Get-ChildItem -Path $MirrorPath -Recurse -Directory -Filter "unify-baseline" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force
    Write-Host "  [SECURITY] removed $($_.FullName.Replace($MirrorPath + '\', ''))（视觉基线 PNG·防渲染真实数据泄漏）" -ForegroundColor Red
}

# 2026-05-22 兜底清除：生产备份目录（与 $excludeDirs 双重防御）
# 即使 robocopy /XD 漏了，这里也会兜底删，防 v1.70.1 类事故复发
$prodBackupsToRemove = @(
    "$MirrorPath\生产数据库备份",
    "$MirrorPath\生产协作附件备份"
)
foreach ($p in $prodBackupsToRemove) {
    if (Test-Path $p) {
        Remove-Item $p -Recurse -Force
        Write-Host "  [SECURITY] removed $($p.Replace($MirrorPath + '\', ''))（兜底防生产敏感数据泄漏）" -ForegroundColor Red
    }
}

# === 步骤 2.5: 脱敏完整性预检（系统梳理兜底报警） ===
# 读 users 表全量真名 + 真实手机号，任一未在 $nameMap/$phoneMap 配置脱敏规则 → fail-fast。
# 根治「新员工入职 → 真名/手机号硬编码进代码 → 漏脱敏泄漏」反复（2026-06-17）。
# codex 复审：① 默认 fail-fast（读不到就中止，-SkipNameAudit 才跳过）② 优先读最新生产备份库
#            （比本地库更接近生产真相，本地库可能跳号缺人）③ JSON 解析防中文捕获乱码。
Write-Phase "[2.5/6] 脱敏完整性预检（对照 users 表 真名+手机号）"

# 失败处理：默认 fail-fast；-SkipNameAudit 时降级为 WARN 跳过（替换/扫描仍照常护已知项）。
# 返回值语义（RC-L3）：返回 $true = 已按 -SkipNameAudit 跳过预检（调用方据此 $auditSkipped=true 继续）；
#   非跳过分支不返回（直接 exit 1 终止进程），故调用处只会收到 $true 或根本不返回。
function Invoke-AuditFailure($msg) {
    if ($SkipNameAudit) {
        Write-Host "  [WARN] $msg —— 因 -SkipNameAudit 跳过预检（仅本次，替换/扫描仍生效）" -ForegroundColor Yellow
        return $true   # 调用方据此 continue
    }
    Write-Host "  [ERROR] $msg —— 完整性预检无法执行，同步已中止。" -ForegroundColor Red
    Write-Host "  确认 users 库不可读且已人工核对脱敏表后，可加 -SkipNameAudit 显式跳过。" -ForegroundColor Yellow
    exit 1
}

$auditHelper = Join-Path $SourcePath "wbs-server\scripts\list-real-names.js"
# 审计库：优先最新「生产数据库备份/task_pool.db.backup_*」，回落本地 wbs-server\task_pool.db
$dbForAudit = $null
$prodBackupDir = Join-Path $SourcePath "生产数据库备份"
if (Test-Path $prodBackupDir) {
    # 按文件名排序（task_pool.db.backup_YYYYMMDD_HHMMSS 词典序 = 时间序，比 LastWriteTime 稳，RC-L2）
    $latestBak = Get-ChildItem -Path $prodBackupDir -Filter "task_pool.db.backup_*" -File -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending | Select-Object -First 1
    if ($latestBak) { $dbForAudit = $latestBak.FullName }
}
$auditSource = "生产备份"
if (-not $dbForAudit) {
    $dbForAudit = Join-Path $SourcePath "wbs-server\task_pool.db"
    $auditSource = "本地库"
}

$auditSkipped = $false
if (-not (Test-Path $auditHelper)) {
    $auditSkipped = Invoke-AuditFailure "未找到预检助手 ($auditHelper)"
} elseif (-not (Test-Path $dbForAudit)) {
    $auditSkipped = Invoke-AuditFailure "未找到 users 审计库 ($dbForAudit)"
}
if (-not $auditSkipped) {
    Write-Host "  审计库来源：$auditSource（$dbForAudit）" -ForegroundColor Gray
    $auditRaw = (& node $auditHelper $dbForAudit 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $auditRaw) {
        $auditSkipped = Invoke-AuditFailure "读取 users 表失败（node 退出码 $LASTEXITCODE）"
    } else {
        $audit = $null
        try { $audit = $auditRaw | ConvertFrom-Json } catch { $audit = $null }
        if (-not $audit) {
            $auditSkipped = Invoke-AuditFailure "users 表预检输出非合法 JSON"
        } else {
            $dbNames  = @($audit.names  | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
            $dbPhones = @($audit.phones | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
            $uncoveredNames  = @($dbNames  | Where-Object { -not $nameMap.Contains($_) })
            $uncoveredPhones = @($dbPhones | Where-Object { -not $phoneMap.Contains($_) })
            if ($uncoveredNames.Count -gt 0 -or $uncoveredPhones.Count -gt 0) {
                Write-Host "  [LEAK-RISK] 以下 users 表敏感项未配置脱敏规则（会原样泄漏到公开镜像）：" -ForegroundColor Red
                foreach ($u in $uncoveredNames)  { Write-Host "    - 真名:   $u  → 请补 `$nameMap" -ForegroundColor Red }
                foreach ($u in $uncoveredPhones) { Write-Host "    - 手机号: $u  → 请补 `$phoneMap" -ForegroundColor Red }
                Write-Host "  补一处 = 替换 / 扫描 / 预检三处同时生效。补全后重跑。" -ForegroundColor Yellow
                exit 1
            }
            Write-Host "  [OK] users 表 $($dbNames.Count) 真名 + $($dbPhones.Count) 手机号全部已配置脱敏规则" -ForegroundColor Green
        }
    }
}

# === 步骤 3: 批量敏感词替换 ===
Write-Phase "[3/6] 批量敏感词替换"
# 文件清单收集一次，替换（步骤3）与残留扫描（步骤4）共用同一份 $files（codex H-2/L-2 单一来源）
$files = Get-ChildItem -Path $MirrorPath -Recurse -File -Include $textExts | Where-Object {
    $_.FullName -notlike "*node_modules*" -and $_.FullName -notlike "*\.git\*"
}
Write-Host "  扫描文件后缀（单一来源 `$textExts）: $($textExts -join ' ')" -ForegroundColor Gray

$replacements = @(
    @{ From = '172\.16\.0\.138'; To = '192.168.1.100' },
    @{ From = '172\.16\.0\.196'; To = '192.168.1.196' },
    @{ From = '172\.16\.0\.198'; To = '192.168.1.198' },
    @{ From = '172\.16\.0\.192'; To = '192.168.1.192' },
    @{ From = '172\.16\.0\.12'; To = '192.168.1.12' },
    @{ From = "'change_me_on_first_login'"; To = "'change_me_on_first_login'" },
    @{ From = 'change_me_on_first_login'; To = 'change_me_on_first_login' },
    @{ From = "'change_me_on_first_login'"; To = "'change_me_on_first_login'" },
    @{ From = 'change_me_on_first_login'; To = 'change_me_on_first_login' },
    @{ From = 'change_me_with_random_32bytes'; To = 'change_me_with_random_32bytes' },
    @{ From = 'change_me_with_random_32bytes_!!'; To = 'change_me_with_random_32bytes_!!' },
    @{ From = 'business_db\.dbo\.crm_bid'; To = 'business_db.dbo.bid_table' },
    @{ From = 'business_db\.dbo\.bms_xxx'; To = 'business_db.dbo.demo_table' },
    @{ From = 'business_db'; To = 'business_db' },
    @{ From = 'legacy_db'; To = 'legacy_db' },
    @{ From = 'legacy_db'; To = 'legacy_db' },
    @{ From = 'legacy_system'; To = 'legacy_system' },
    @{ From = 'readonly_user'; To = 'readonly_user' },
    @{ From = 'demo_user_a'; To = 'demo_user_a' },
    @{ From = 'demo_user_b'; To = 'demo_user_b' }
)
# 真名 + 实体名 + 手机号替换规则从单一真相源 $nameMap/$entityMap/$phoneMap 生成（[regex]::Escape 防元字符）。
# 真名/实体名按 key 长度降序生成（codex M-2）：长串先替换，避免短名误吃长名的一部分。
$cjkMapPairs = @()
foreach ($k in $nameMap.Keys)   { $cjkMapPairs += @{ K = $k; V = $nameMap[$k] } }
foreach ($k in $entityMap.Keys) { $cjkMapPairs += @{ K = $k; V = $entityMap[$k] } }
foreach ($pair in ($cjkMapPairs | Sort-Object { $_.K.Length } -Descending)) {
    $replacements += @{ From = [regex]::Escape($pair.K); To = $pair.V }
}
# 手机号定长 11 位；加数字边界 (?<!\d)...(?!\d)（codex 复审 RC-M1）：只匹配独立手机号，
# 不误替换更长数字串里的子串（替换与扫描步骤4 用同一边界语义，避免误报阻断）。
foreach ($k in $phoneMap.Keys) {
    $replacements += @{ From = "(?<!\d)" + [regex]::Escape($k) + "(?!\d)"; To = $phoneMap[$k] }
}

$changedFiles = 0
foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $original = $content
    foreach ($rule in $replacements) {
        $content = $content -replace $rule.From, $rule.To
    }
    if ($content -ne $original) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        if ($hasBom) {
            $utf8 = New-Object System.Text.UTF8Encoding $true
        } else {
            $utf8 = New-Object System.Text.UTF8Encoding $false
        }
        [System.IO.File]::WriteAllText($file.FullName, $content, $utf8)
        $changedFiles++
    }
}
Write-Host "  [OK] 替换完成: $changedFiles 个文件" -ForegroundColor Green

# === 步骤 4: 残留敏感词扫描（fail-fast） ===
Write-Phase "[4/6] 残留敏感词扫描"
# 复用步骤 3 收集的 $files（同一文件后缀来源 $textExts，codex H-2/L-2 收集一次）
# 宽兜底模式（比替换更宽，catch 未列出的变体；手工维护）
#   ⚠️ 不放手机号宽匹配 1[3-9]\d{9}：会误伤测试假号（如 13800000013）。真实手机号靠 $phoneMap 派生精确匹配。
$broadPatterns = @(
    "172\.16\.[0-9]+\.[0-9]+",
    "change_me_on_first_login", "change_me_on_first_login",
    "change_me_with_random_32bytes",
    "change_me_with_random_32bytes_!!",
    "business_db", "legacy_db", "legacy_system", "readonly_user",
    "ztwb[0-9]+"
)
# 真名 + 实体名 + 手机号扫描模式从 $nameMap/$entityMap/$phoneMap 自动派生 —— 与替换表零漂移：
#   往任一表补一条，替换和扫描同时获得护栏，不可能再「补替换漏补扫描」。
# 手机号扫描与替换同用数字边界（RC-M1）：标准独立手机号已被替换则不再命中；
#   仅作为更长数字串子串出现的不视为真名手机号，不误报阻断同步。
$sensitivePatterns = $broadPatterns `
    + ($nameMap.Keys   | ForEach-Object { [regex]::Escape($_) }) `
    + ($entityMap.Keys | ForEach-Object { [regex]::Escape($_) }) `
    + ($phoneMap.Keys  | ForEach-Object { "(?<!\d)" + [regex]::Escape($_) + "(?!\d)" })
$leaked = $false
foreach ($pat in $sensitivePatterns) {
    # Select-String 读取 $files（FileInfo）的磁盘内容（已替换后）；跨平台稳定
    $hits = $files | Select-String -Pattern $pat -SimpleMatch:$false 2>$null | Select-Object -First 3
    if ($hits) {
        $leaked = $true
        Write-Host "  [LEAK] pattern '$pat':" -ForegroundColor Red
        foreach ($h in $hits) {
            Write-Host "    $($h.Path):$($h.LineNumber) $($h.Line.Trim().Substring(0, [Math]::Min(80, $h.Line.Trim().Length)))" -ForegroundColor Red
        }
    }
}
if ($leaked) {
    Write-Host "  [ERROR] 检测到残留敏感词，同步已中止" -ForegroundColor Red
    Write-Host "  请检查上面的输出,补充 `$nameMap/`$phoneMap/`$entityMap 规则后重跑" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] 零残留" -ForegroundColor Green

# === DryRun: 演练到此为止，不 git add/commit/push ===
if ($DryRun) {
    Write-Phase "[DryRun] 演练模式：跳过 git add/commit/push"
    Push-Location $MirrorPath
    try {
        $pending = (& git status --porcelain) -split "`n" | Where-Object { $_ -match '\S' }
        Write-Host "  本次将变更 $($pending.Count) 个文件（未推送）：" -ForegroundColor Cyan
        foreach ($l in ($pending | Select-Object -First 40)) { Write-Host "    $l" -ForegroundColor Gray }
        if ($pending.Count -gt 40) { Write-Host "    ... 还有 $($pending.Count - 40) 个" -ForegroundColor Gray }
    } finally {
        Pop-Location
    }
    Write-Host "  [DryRun] 完成：预检 + 替换 + 残留扫描全过，未提交" -ForegroundColor Green
    exit 0
}

# === 步骤 5: git status 检查变更 + > 10 文件弹问 ===
Write-Phase "[5/6] 变更范围检查"
Push-Location $MirrorPath
& git add . 2>&1 | Out-Null
$statusLines = (& git status --porcelain) -split "`n" | Where-Object { $_ -match '\S' }
$changeCount = $statusLines.Count
Write-Host "  本次同步变更文件数: $changeCount" -ForegroundColor Cyan

if ($changeCount -eq 0) {
    if (-not $ForceCommit) {
        Write-Host "  [SKIP] 无变更，跳过提交" -ForegroundColor Yellow
        Pop-Location
        exit 0
    }
    Write-Host "  [WARN] 无变更但 -ForceCommit 已传，将创建空 commit" -ForegroundColor Yellow
}

if ($changeCount -gt 10 -and -not $NoConfirm) {
    Write-Host ""
    Write-Host "  ⚠️ 变更超 10 文件，请确认是否符合预期：" -ForegroundColor Yellow
    foreach ($line in ($statusLines | Select-Object -First 20)) {
        Write-Host "    $line" -ForegroundColor Gray
    }
    if ($statusLines.Count -gt 20) {
        Write-Host "    ... 还有 $($statusLines.Count - 20) 个文件" -ForegroundColor Gray
    }
    Write-Host ""
    $confirm = Read-Host "  继续 commit + push?(y/N)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') {
        Write-Host "  [ABORT] 用户取消" -ForegroundColor Yellow
        # 撤销 git add (但保留工作区改动,因为这些改动可能来自源项目真实变更)
        # 下次跑 sync 时 robocopy 会重新同步,git add 会重新加入
        & git reset HEAD -- . 2>&1 | Out-Null
        Write-Host "  [OK] 已撤销 git add,工作区文件保留" -ForegroundColor Yellow
        Pop-Location
        exit 0
    }
}

# === 步骤 6: commit + push ===
Write-Phase "[6/6] commit + push"
if ($ForceCommit -and $changeCount -eq 0) {
    & git commit --allow-empty -m $CommitMessage 2>&1 | Select-Object -Last 3
} else {
    & git commit -m $CommitMessage 2>&1 | Select-Object -Last 3
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] commit 失败" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "  [OK] commit 成功" -ForegroundColor Green

& git push origin main 2>&1 | Select-Object -Last 5 | ForEach-Object {
    Write-Host "    $_" -ForegroundColor Gray
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] push 失败" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Sync to GitHub Complete!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  https://github.com/FyPerson/smart_data_hub" -ForegroundColor Cyan
Write-Host ""
