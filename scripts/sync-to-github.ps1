# Sync to GitHub Script — incremental snapshot to public mirror
# Called by: /deploy skill (step 10b) after production deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/sync-to-github.ps1 -CommitMessage "..."
#
# Flow:
#   1. robocopy 源项目 → 镜像（同字节文件自动跳过）
#   2. 清除镜像中的非公开内容（mcp-*, docs/local, etc）
#   3. 跑批量敏感词替换
#   4. 残留敏感词扫描（fail-fast）
#   5. git status 检查变更范围，> 10 文件停下来询问
#   6. git add + commit + push
#
# 镜像位置：e:/tmp/smart-data-hub-public/
# 镜像须先经过 /deploy skill 第一次同步建立（已于 2026-05-14 完成）

param(
    [Parameter(Mandatory=$true)]
    [string]$CommitMessage,

    [string]$SourcePath = "e:\数据开发与治理规范手册",
    [string]$MirrorPath = "e:\tmp\smart-data-hub-public",

    # 跳过弹问（CI 用 / 自动化用）
    [switch]$NoConfirm,

    # 强制全量同步（即使无变化也提交）
    [switch]$ForceCommit
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Phase($title) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
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
    "work_todo", "访谈文档", "sql"
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

# === 步骤 3: 批量敏感词替换 ===
Write-Phase "[3/6] 批量敏感词替换"
$exts = @("*.js","*.html","*.md","*.ps1","*.json")
$files = Get-ChildItem -Path $MirrorPath -Recurse -File -Include $exts | Where-Object {
    $_.FullName -notlike "*node_modules*" -and $_.FullName -notlike "*\.git\*"
}

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
    @{ From = 'readonly_user'; To = 'readonly_user' },
    @{ From = 'demo_user_a'; To = 'demo_user_a' },
    @{ From = 'demo_user_b'; To = 'demo_user_b' },
    @{ From = '示例用户A'; To = '示例用户A' },
    @{ From = '示例用户B'; To = '示例用户B' },
    @{ From = '示例发布者'; To = '示例发布者' },
    @{ From = '示例集团关联方A'; To = '示例集团关联方A' },
    @{ From = '示例关联方B'; To = '示例关联方B' },
    @{ From = '示例关联方C'; To = '示例关联方C' },
    @{ From = '示例关联方D'; To = '示例关联方D' },
    @{ From = '示例海外子公司'; To = '示例海外子公司' }
)

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
# 用 git grep（已在镜像目录跑，且只查跟踪的文件 + 工作区改动）
Push-Location $MirrorPath
$sensitivePatterns = @(
    "172\.16\.[0-9]+\.[0-9]+",
    "change_me_on_first_login", "change_me_on_first_login",
    "change_me_with_random_32bytes",
    "change_me_with_random_32bytes_!!",
    "business_db", "readonly_user",
    "示例用户A", "示例用户B", "示例发布者", "示例集团关联方A", "示例关联方B", "示例关联方C", "示例关联方D", "示例海外子公司",
    "ztwb[0-9]+"
)
$leaked = $false
foreach ($pat in $sensitivePatterns) {
    # 用 PowerShell Select-String 替代 grep,跨平台稳定
    $hits = Get-ChildItem -Recurse -File -Include "*.js","*.html","*.md","*.ps1","*.json" |
            Where-Object { $_.FullName -notlike "*\.git\*" -and $_.FullName -notlike "*node_modules*" } |
            Select-String -Pattern $pat -SimpleMatch:$false 2>$null |
            Select-Object -First 3
    if ($hits) {
        $leaked = $true
        Write-Host "  [LEAK] pattern '$pat':" -ForegroundColor Red
        foreach ($h in $hits) {
            Write-Host "    $($h.Path):$($h.LineNumber) $($h.Line.Trim().Substring(0, [Math]::Min(80, $h.Line.Trim().Length)))" -ForegroundColor Red
        }
    }
}
Pop-Location
if ($leaked) {
    Write-Host "  [ERROR] 检测到残留敏感词，同步已中止" -ForegroundColor Red
    Write-Host "  请检查上面的输出,补充替换规则后重跑" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] 零残留" -ForegroundColor Green

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
