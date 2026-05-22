# Deploy Script - SSH deployment to production
# Called by: /deploy skill (step 8)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/deploy-ssh.ps1
#
# 6 步：(1) push → (2) pull → (3) 备份 task_pool.db（v2.0 数据协作模块强制，失败中止）→ (4) PM2 restart → (5) scp 拉生产 db 备份到本地 → (6) scp 拉生产协作附件到本地（v1.70.1+，失败只 warn 不阻塞）
# 备份策略：
#   - 生产端：每次部署都备份；同目录 task_pool.db.backup_yyyyMMdd_HHmmss；不自动清理（季度初手动跑）
#   - 本地端 db 备份（v1.69.x+）：scp 拉本次新生成的 backup 到 E:\数据开发与治理规范手册\生产数据库备份\；保留最近 10 份，旧的自动删；失败只 warn 不阻塞主流程
#   - 本地端 collab 附件备份（v1.70.1+，2026-05-22）：scp -r 拉整个 uploads/collab/ 到 E:\数据开发与治理规范手册\生产协作附件备份\collab_yyyyMMdd_HHmmss\；
#     拉完后删 _pending / _orphaned 两个子目录（临时区 / 隔离区不入备份）；保留最近 5 份按时间倒序，旧的自动删；失败只 warn 不阻塞
#
# ⚠️ KNOWN ISSUES（已知结构性缺口，2026-05-14 / 05-15 踩过）：
# 1. 不跑 npm install —— 仅做"代码 + db 备份 + 重启"，新增 npm 依赖需手工处理：
#    路径 A（一次性根治）：找网络/运维修生产 npm SSL，使其能直连 registry 或走内网镜像
#    路径 B（每次手工）：本地 npm install 后 scp 主包+所有传递依赖到生产 node_modules/
#    检查传递依赖：cat node_modules/<pkg>/package.json | grep -A 5 dependencies
#    历史案例：v1.64.0 node-sql-parser（89MB）+ big-integer（186KB，传递依赖）
# 2. 文件编码必须 UTF-8 with BOM —— 否则 PowerShell 5.1 按 GBK 解码中文，
#    三字节 UTF-8 中文（如句号 U+3002 = E3 80 82）被 GBK 错误吞并下一字符
#    引发"missing terminator"假错误（2026-05-14 踩过，编辑后用 UTF8Encoding($true) 重写）

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
    # 远程 cmd 用 && 短路串联（任一步失败则停）—— 这里的 && 是给远端 cmd.exe 解释的
    # 用单引号字符串：① 阻止本地 PowerShell 5.1 把 && 当 statement separator 解析
    # ② 字符串无变量插值，整串作为 SSH argv 单参数原样传到远端，由 cmd.exe 拆分
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
# 注：与 5/14 "UTF-8 无 BOM → GBK 误解析中文" 踩坑同源但不同症——前者是文件编码层，
# 这里是 shell argv 转义层；EncodedCommand 用 UTF-16LE + base64 同时解决两类问题
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

# 5. Pull production db backup to local (v1.69.x+，失败只 warn 不阻塞)
# 用本次步骤 3 生成的 $backupPath（如 E:\Task_Pool\wbs-server\task_pool.db.backup_20260520_153500）
# scp 拉到本地 E:\数据开发与治理规范手册\生产数据库备份\，保留最近 10 份
Write-Host "[5/6] Pull production db backup to local..." -ForegroundColor Yellow
try {
    $localBackupDir = 'E:\数据开发与治理规范手册\生产数据库备份'
    if (-not (Test-Path $localBackupDir)) {
        New-Item -ItemType Directory -Path $localBackupDir -Force | Out-Null
        Write-Host "  [INFO] Created local backup dir: $localBackupDir" -ForegroundColor Gray
    }

    # 从 $backupPath（如 E:\Task_Pool\wbs-server\task_pool.db.backup_20260520_153500）取文件名
    $backupFileName = Split-Path $backupPath -Leaf
    $localDst = Join-Path $localBackupDir $backupFileName

    # scp 远端 Windows 路径必须用正斜杠：/E:/Task_Pool/wbs-server/task_pool.db.backup_xxx
    $scpSrcPath = '/' + ($backupPath -replace '\\', '/')
    $scpSrc = "${ServerUser}@${ServerIP}:$scpSrcPath"
    $scpResult = scp $scpSrc $localDst 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "scp failed (exit $LASTEXITCODE): $scpResult"
    }
    if (-not (Test-Path $localDst)) {
        throw "scp 成功但本地文件不存在: $localDst"
    }
    $sizeKB = [math]::Round((Get-Item $localDst).Length / 1KB, 1)
    Write-Host "  [OK] Saved: $localDst ($sizeKB KB)" -ForegroundColor Green

    # 保留最近 10 份，按文件名时间戳排序（task_pool.db.backup_YYYYMMDD_HHmmss）
    $allBackups = Get-ChildItem -Path $localBackupDir -Filter 'task_pool.db.backup_*' -File |
        Sort-Object Name -Descending
    if ($allBackups.Count -gt 10) {
        $toDelete = $allBackups | Select-Object -Skip 10
        foreach ($f in $toDelete) {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        }
        Write-Host "  [INFO] Cleaned $($toDelete.Count) old backup(s), kept latest 10" -ForegroundColor Gray
    }
} catch {
    Write-Host "  [WARN] Local backup pull failed (deploy 主流程未受影响): $_" -ForegroundColor Yellow
    Write-Host "  [HINT] 手动补拉: scp ${ServerUser}@${ServerIP}:$scpSrcPath E:\数据开发与治理规范手册\生产数据库备份\" -ForegroundColor Gray
}

Write-Host ""

# 6. Pull production collab attachments to local (v1.70.1+，失败只 warn 不阻塞)
# 拉 uploads/collab/ 整个目录，本地按部署时间快照命名 collab_yyyyMMdd_HHmmss/
# 拉完后删本地快照的 _pending / _orphaned 两个子目录（临时区 / 隔离区不入备份）
# 保留最近 5 份按时间倒序，旧的自动删
#
# 为什么 scp -r 不直接排除子目录：
#   scp 没有 --exclude 选项（rsync 才有）；用 robocopy 需要远端先临时拷贝再 scp
#   两步法繁琐。当前 _pending/_orphaned 体积小（约几十 KB），拉完后本地删更简单
Write-Host "[6/6] Pull production collab attachments to local..." -ForegroundColor Yellow
try {
    $localCollabBaseDir = 'E:\数据开发与治理规范手册\生产协作附件备份'
    if (-not (Test-Path $localCollabBaseDir)) {
        New-Item -ItemType Directory -Path $localCollabBaseDir -Force | Out-Null
        Write-Host "  [INFO] Created local collab backup dir: $localCollabBaseDir" -ForegroundColor Gray
    }

    # 本次快照目录名（与 db 备份时间戳保持同步，便于交叉对照）
    # 复用步骤 3 已生成的 $backupPath 中提取的时间戳（task_pool.db.backup_YYYYMMDD_HHmmss）
    if ($backupPath -match 'backup_(\d{8}_\d{6})') {
        $snapshotTs = $matches[1]
    } else {
        $snapshotTs = Get-Date -Format yyyyMMdd_HHmmss
    }
    $localSnapshotDir = Join-Path $localCollabBaseDir "collab_$snapshotTs"

    # 远端 scp 源：/E:/Task_Pool/wbs-server/uploads/collab/
    $remoteCollabPath = '/E:/Task_Pool/wbs-server/uploads/collab'
    $scpSrc = "${ServerUser}@${ServerIP}:$remoteCollabPath"

    # scp -r 拉整个 collab 目录到本地快照位置（即 localSnapshotDir/collab/）
    # 注：scp -r 把源目录作为子目录拷到目标下，结果是 $localSnapshotDir/collab/...
    # 简化：直接拉到 localSnapshotDir，让 scp 在 base dir 下创建 collab 子目录
    if (-not (Test-Path $localSnapshotDir)) {
        New-Item -ItemType Directory -Path $localSnapshotDir -Force | Out-Null
    }
    $scpResult = scp -r $scpSrc $localSnapshotDir 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "scp -r failed (exit $LASTEXITCODE): $scpResult"
    }

    # 拉完路径结构：$localSnapshotDir\collab\{rid}_xxx\, _pending\, _orphaned\
    $pulledCollabDir = Join-Path $localSnapshotDir 'collab'
    if (-not (Test-Path $pulledCollabDir)) {
        throw "scp 成功但本地 collab 目录不存在: $pulledCollabDir"
    }

    # 删 _pending / _orphaned 两个子目录（临时区 / 隔离区不入备份）
    $excludeSubdirs = @('_pending', '_orphaned')
    foreach ($sub in $excludeSubdirs) {
        $subPath = Join-Path $pulledCollabDir $sub
        if (Test-Path $subPath) {
            Remove-Item $subPath -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  [INFO] Removed temp/orphan subdir: $sub" -ForegroundColor Gray
        }
    }

    # 统计快照体积 + 协作单目录数
    $subdirCount = (Get-ChildItem -Path $pulledCollabDir -Directory -ErrorAction SilentlyContinue).Count
    $totalBytes = (Get-ChildItem -Path $pulledCollabDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $totalMB = if ($totalBytes) { [math]::Round($totalBytes / 1MB, 1) } else { 0 }
    Write-Host "  [OK] Saved: $localSnapshotDir ($subdirCount collab dirs, $totalMB MB)" -ForegroundColor Green

    # 保留最近 5 份快照，按目录名时间戳倒序（collab_YYYYMMDD_HHmmss）
    $allSnapshots = Get-ChildItem -Path $localCollabBaseDir -Directory -Filter 'collab_*' |
        Sort-Object Name -Descending
    if ($allSnapshots.Count -gt 5) {
        $toDelete = $allSnapshots | Select-Object -Skip 5
        foreach ($d in $toDelete) {
            Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host "  [INFO] Cleaned $($toDelete.Count) old snapshot(s), kept latest 5" -ForegroundColor Gray
    }
} catch {
    Write-Host "  [WARN] Local collab attachments pull failed (deploy 主流程未受影响): $_" -ForegroundColor Yellow
    Write-Host "  [HINT] 手动补拉: scp -r ${ServerUser}@${ServerIP}:/E:/Task_Pool/wbs-server/uploads/collab E:\数据开发与治理规范手册\生产协作附件备份\collab_$snapshotTs\" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Deploy Complete!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
$url = 'http://' + $ServerIP + ':3000'
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ""
