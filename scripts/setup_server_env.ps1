# =============================================================================
# 任务池系统部署脚本 (Task Pool Deployment Script)
# 适用于: Windows Server 2019 Datacenter
# 服务器IP: 192.168.1.100
# =============================================================================

# 设置编码为UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 配置变量 - 根据需要修改
$PROJECT_PATH = "E:\Task_Pool"          # 项目部署路径
$SERVER_PORT = 3000                      # 服务端口
$SERVICE_NAME = "task-pool"              # PM2服务名称

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  任务池系统部署脚本 (Task Pool)" -ForegroundColor Cyan
Write-Host "  服务器: 192.168.1.100:$SERVER_PORT" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否以管理员身份运行
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[错误] 请以管理员身份运行此脚本!" -ForegroundColor Red
    Write-Host "右键点击PowerShell -> 以管理员身份运行" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}

# =============================================================================
# 步骤1: 检查Node.js是否安装
# =============================================================================
Write-Host "[步骤1/6] 检查Node.js环境..." -ForegroundColor Yellow

try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion) {
        Write-Host "  √ Node.js已安装: $nodeVersion" -ForegroundColor Green
    } else {
        throw "Node.js未安装"
    }
} catch {
    Write-Host "  × Node.js未安装!" -ForegroundColor Red
    Write-Host ""
    Write-Host "请先安装Node.js:" -ForegroundColor Yellow
    Write-Host "  1. 下载: https://nodejs.org/zh-cn/" -ForegroundColor White
    Write-Host "  2. 安装后重新运行此脚本" -ForegroundColor White
    Read-Host "按回车键退出"
    exit 1
}

# =============================================================================
# 步骤2: 检查项目目录
# =============================================================================
Write-Host "[步骤2/6] 检查项目目录..." -ForegroundColor Yellow

$serverJsPath = Join-Path $PROJECT_PATH "wbs-server\server.js"
$packageJsonPath = Join-Path $PROJECT_PATH "wbs-server\package.json"
$htmlPath = Join-Path $PROJECT_PATH "Task_Pool.html"

if (-not (Test-Path $serverJsPath)) {
    Write-Host "  × 未找到 server.js" -ForegroundColor Red
    Write-Host "  请确保项目文件已复制到: $PROJECT_PATH" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}

if (-not (Test-Path $packageJsonPath)) {
    Write-Host "  × 未找到 package.json" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $htmlPath)) {
    Write-Host "  × 未找到 Task_Pool.html" -ForegroundColor Red
    exit 1
}

$docViewerPath = Join-Path $PROJECT_PATH "Doc_Viewer.html"
if (-not (Test-Path $docViewerPath)) {
    Write-Host "  × 未找到 Doc_Viewer.html" -ForegroundColor Red
    exit 1
}

Write-Host "  √ 项目目录检查通过" -ForegroundColor Green

# 确保uploads和archive目录存在
$uploadsPath = Join-Path $PROJECT_PATH "wbs-server\uploads"
$archivePath = Join-Path $PROJECT_PATH "wbs-server\archive"

if (-not (Test-Path $uploadsPath)) {
    New-Item -ItemType Directory -Path $uploadsPath -Force | Out-Null
    Write-Host "  √ 创建uploads目录" -ForegroundColor Green
}

if (-not (Test-Path $archivePath)) {
    New-Item -ItemType Directory -Path $archivePath -Force | Out-Null
    Write-Host "  √ 创建archive目录" -ForegroundColor Green
}

# =============================================================================
# 步骤3: 安装项目依赖
# =============================================================================
Write-Host "[步骤3/6] 安装项目依赖..." -ForegroundColor Yellow

$wbsServerPath = Join-Path $PROJECT_PATH "wbs-server"
Push-Location $wbsServerPath

try {
    npm install 2>&1 | Out-Null
    Write-Host "  √ 项目依赖安装完成" -ForegroundColor Green
} catch {
    Write-Host "  × 依赖安装失败: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

Pop-Location

# =============================================================================
# 步骤4: 安装PM2
# =============================================================================
Write-Host "[步骤4/6] 安装PM2进程管理器..." -ForegroundColor Yellow

try {
    $pm2Version = pm2 -v 2>$null
    if ($pm2Version) {
        Write-Host "  √ PM2已安装: v$pm2Version" -ForegroundColor Green
    } else {
        throw "PM2未安装"
    }
} catch {
    Write-Host "  正在安装PM2..." -ForegroundColor White
    npm install -g pm2 2>&1 | Out-Null
    npm install -g pm2-windows-startup 2>&1 | Out-Null
    Write-Host "  √ PM2安装完成" -ForegroundColor Green
}

# =============================================================================
# 步骤5: 配置防火墙
# =============================================================================
Write-Host "[步骤5/6] 配置防火墙规则..." -ForegroundColor Yellow

$ruleName = "Task Pool Server (Port $SERVER_PORT)"
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($existingRule) {
    Write-Host "  √ 防火墙规则已存在" -ForegroundColor Green
} else {
    try {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $SERVER_PORT -Action Allow | Out-Null
        Write-Host "  √ 防火墙规则已添加 (端口 $SERVER_PORT)" -ForegroundColor Green
    } catch {
        Write-Host "  ! 防火墙规则添加失败,请手动配置" -ForegroundColor Yellow
    }
}

# =============================================================================
# 步骤6: 启动服务
# =============================================================================
Write-Host "[步骤6/6] 启动服务..." -ForegroundColor Yellow

Push-Location $wbsServerPath

# 先停止已有服务(如果存在)
pm2 delete $SERVICE_NAME 2>$null | Out-Null

# 启动新服务
try {
    pm2 start server.js --name $SERVICE_NAME 2>&1 | Out-Null
    pm2 save 2>&1 | Out-Null
    Write-Host "  √ 服务启动成功" -ForegroundColor Green
} catch {
    Write-Host "  × 服务启动失败: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

Pop-Location

# =============================================================================
# 设置开机自启
# =============================================================================
Write-Host ""
Write-Host "正在配置开机自启动..." -ForegroundColor Yellow

try {
    pm2-startup install 2>&1 | Out-Null
    pm2 save 2>&1 | Out-Null
    Write-Host "  √ 开机自启动已配置" -ForegroundColor Green
} catch {
    Write-Host "  ! 开机自启动配置可能需要手动设置" -ForegroundColor Yellow
}

# =============================================================================
# 部署完成
# =============================================================================
Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  ✓ 部署完成!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "访问地址:" -ForegroundColor White
Write-Host "  本地: http://localhost:$SERVER_PORT/Task_Pool.html" -ForegroundColor Cyan
Write-Host "  局域网: http://192.168.1.100:$SERVER_PORT/Task_Pool.html" -ForegroundColor Cyan
Write-Host ""
Write-Host "常用PM2命令:" -ForegroundColor White
Write-Host "  pm2 list              # 查看服务状态" -ForegroundColor Gray
Write-Host "  pm2 logs $SERVICE_NAME     # 查看日志" -ForegroundColor Gray
Write-Host "  pm2 restart $SERVICE_NAME  # 重启服务" -ForegroundColor Gray
Write-Host "  pm2 stop $SERVICE_NAME     # 停止服务" -ForegroundColor Gray
Write-Host ""
Write-Host "数据库位置: $wbsServerPath\task_pool.db" -ForegroundColor Gray
Write-Host ""

# 显示当前服务状态
Write-Host "当前服务状态:" -ForegroundColor White
pm2 list

Read-Host "按回车键退出"
