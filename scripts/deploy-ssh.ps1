# Deploy Script - SSH deployment to production
# Called by: /deploy skill (step 8)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/deploy-ssh.ps1
#
# 4 步：(1) push → (2) pull → (3) 备份 task_pool.db（v2.0 数据协作模块强制，失败中止）→ (4) PM2 restart
# 备份策略：每次部署都备份；同目录 task_pool.db.backup_yyyyMMdd_HHmmss；不自动清理（季度初手动跑）

param(
    [string]$ServerIP = "192.168.1.100",
    [string]$ServerUser = "Administrator"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  SSH Deploy to $ServerIP" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 1. Push to production remote
Write-Host "[1/4] Push to production..." -ForegroundColor Yellow
$pushResult = git push production main 2>&1
if ($LASTEXITCODE -ne 0) {
    if ($pushResult -match "Everything up-to-date") {
        Write-Host "  [OK] Already up-to-date" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] Push failed:" -ForegroundColor Red
        Write-Host "  $pushResult" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  [OK] Pushed" -ForegroundColor Green
}
Write-Host ""

# 2. Reset on server (force overwrite to avoid CRLF/merge issues)
Write-Host "[2/4] Pull on server..." -ForegroundColor Yellow
try {
    # 远程 cmd 用 && 短路串联（任一步失败则停）
    # ⚠️ PowerShell 5.1 解析双引号字符串时会把 && 当作 statement separator 报错,
    # 改用单引号字符串(无变量插值,&& 保留为字面值)规避(2026-05-14 发现)
    $remoteCmd2 = 'cd /d E:\Task_Pool && git fetch production && git reset --hard production/main'
    $pullResult = ssh "$ServerUser@$ServerIP" $remoteCmd2 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Code updated" -ForegroundColor Green
        $pullResult -split "`n" | Select-Object -Last 5 | ForEach-Object {
            Write-Host "  $_" -ForegroundColor Gray
        }
    } else {
        throw "git reset failed: $pullResult"
    }
} catch {
    Write-Host "  [ERROR] SSH failed: $_" -ForegroundColor Red
    Write-Host "  Check: ssh $ServerUser@$ServerIP" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# 3. Backup task_pool.db on server (强制，失败则中止部署，避免 PM2 重启后无回滚点)
# 用 EncodedCommand 规避三层 shell（本地 PowerShell → SSH → 远端 PowerShell）的嵌套引号
# 转义问题——之前用单引号字符串拼接，远端 PowerShell 把 `''` 还原后大括号 `{}` 被 parser
# 误当 hashtable 起始而剥掉，导致 `if (-not ...) { ... }` 解析失败（2026-05-15 踩坑）
Write-Host "[3/4] Backup task_pool.db on server..." -ForegroundColor Yellow
try {
    $backupScript = @'
$ts = Get-Date -Format yyyyMMdd_HHmmss
$src = 'E:\Task_Pool\wbs-server\task_pool.db'
$dst = 'E:\Task_Pool\wbs-server\task_pool.db.backup_' + $ts
if (-not (Test-Path $src)) { Write-Error ('Source DB not found: ' + $src); exit 1 }
Copy-Item $src $dst -ErrorAction Stop
Write-Output ('BACKUP_OK::' + $dst)
'@
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($backupScript)
    $encoded = [Convert]::ToBase64String($bytes)
    $backupResult = ssh "$ServerUser@$ServerIP" "powershell -NoProfile -EncodedCommand $encoded" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "backup command failed (exit $LASTEXITCODE): $backupResult"
    }
    $okLine = $backupResult | Where-Object { $_ -match '^BACKUP_OK::' } | Select-Object -First 1
    if (-not $okLine) {
        throw "backup result missing BACKUP_OK marker: $backupResult"
    }
    $backupPath = ($okLine -replace '^BACKUP_OK::', '').Trim()
    Write-Host "  [OK] Backup created: $backupPath" -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Backup failed (deploy aborted, PM2 not restarted): $_" -ForegroundColor Red
    Write-Host "  Code已更新但服务未重启，原服务仍在运行旧代码。修复备份后重跑 deploy。" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# 4. Restart PM2
Write-Host "[4/4] Restart service..." -ForegroundColor Yellow
try {
    # 同 [2/4]：单引号规避 PowerShell 5.1 双引号内 && 解析 bug
    $remoteCmd4 = 'cd /d E:\Task_Pool\wbs-server && pm2 restart task-pool'
    $restartResult = ssh "$ServerUser@$ServerIP" $remoteCmd4 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] PM2 restarted" -ForegroundColor Green
    } else {
        throw "pm2 restart failed: $restartResult"
    }
} catch {
    Write-Host "  [ERROR] Restart failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Deploy Complete!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
$url = 'http://' + $ServerIP + ':3000'
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ""
