# Deploy Script - SSH deployment to production（#106 S8c / 方案 W10：新顺序 + 失败处置 + -DryRun）
# Called by: /deploy skill
# 仓库根：取脚本自身位置（脚本必须在 <仓库根>\scripts\ 下，并用 git -C 核对它就是 git 顶层），不看进程当前目录或 $PWD。
#   所有本机 git / node 调用都显式带仓库根（git -C <根> 或 -WorkDir <根>）。在 worktree 里运行本脚本，发布的就是该 worktree 所在仓库的 main（各 worktree 共享 main 分支）。
# Usage（不要加 -ExecutionPolicy Bypass，自动模式会拦）：
#   powershell.exe -NoProfile -File scripts/deploy-ssh.ps1                       真实部署（从哪个目录启动都行，发布的是脚本所在检出的 main）
#   powershell.exe -NoProfile -File scripts/deploy-ssh.ps1 -DryRun               演练：只读探测照常执行，所有写操作只打印
#     -RemoteStateFile <json>   只能与 -DryRun 同用：用文件里的假远端现状代替第 2 步的真实只读探测（自检用，不连生产）
#     -SkipPushCheck            只能与 -DryRun 同用：跳过 git ls-remote production（它会访问 SMB 远端仓库）
#     -DryRunFailAt <分支>      只能与 -DryRun 同用：在该步把结果当成失败，打印将走的分支
#                               backup（备份明确失败）/ backup_noline（没收到备份协议行）/ code / start / ready /
#                               ready_commit_null（就绪失败且 hint=COMMIT_NULL）/ restart_loop（就绪后 pm2 restart_time 增长）/
#                               ready_stopped、ready_errored（READY_OK 之后 pm2 里 task-pool 的状态是 stopped / errored，计数未增长）/
#                               ready_init_failed（就绪失败且未就绪模块带 INIT_FAILED，回滚七步之前多一段 SQLITE_BUSY 指引）/
#                               push_landed（推送超时、远端 main 已等于 NewCommit）、push_failed（推送失败、远端 main 不等于 NewCommit）/
#                               stop_listen（pm2 已 stopped 但 3000 仍有 LISTENING）、ready_orphan（READY_OK 之后 pm2 pid 不等于 3000 的监听 pid）
#     -ReadyTimeoutSec <n>      就绪检查总期限，缺省 180 秒
#     -PushTimeoutSec <n>       第 1 步 git push 的超时，缺省 1800 秒，只收 60-7200 的整数，其他值拒绝运行（退出码 2）
#
# 顺序（每步写发布记录阶段，scripts/deploy/release-record.js；-DryRun 时记录写到 $env:TEMP 下的临时目录，不写控制根）：
#   0 本机准备（只读）   NewCommit = main 的提交号；NewVersion = 该提交里 wbs-server/package.json 的 version；Id = yyyyMMdd_HHmmss
#   1 推送               git push production main（超时 -PushTimeoutSec）；推送后 git ls-remote 必须等于 NewCommit，否则中止（生产未动）。
#                        push 超时或失败后只读再跑一次 git ls-remote：已等于 NewCommit 就提示「推送已生效」（可能卡在远端 gc --auto），否则打印原失败提示；两种都中止
#   2 读远端现状（只读） 远端 HEAD / 已跟踪改动必须为空 / pm2 的 task-pool 必须 online / pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid（两栈都算，否则疑似孤儿监听）/ 运行中的版本与提交；
#                        PrevCommit（部署前实际运行的提交）= 远端 HEAD，且必须与运行中的提交一致；写发布记录 init；
#                        再用同一组参数调一次 ready-check.js --check-args（不发请求）；
#                        再核对新提交的 wbs-server/server.js 含就绪接口路由与 /api/version 的 commit 字段（否则部署后必然就绪检查失败）。
#                        本步任何中止：生产未动，退出码 1
#   3 上传备份脚本并预取  远端建 E:\Task_Pool_deploy_tmp，scp backup-db.js 过去，远端 SHA256 必须等于本机（阶段 uploaded）；
#                        再在远端 git fetch production（停服前做：fetch 不动工作区），git cat-file -t <NewCommit> 必须是 commit，否则中止（生产服务未动）
#   4 停服               pm2 stop task-pool，再 pm2 jlist 确认 stopped，且 3000 端口必须零 LISTENING（只读 netstat）       阶段 stopped
#   5 备份               远端 node backup-db-<Id>.js（VACUUM INTO + 校验），只认协议行 BACKUP_OK / BACKUP_FAIL     阶段 backed_up
#   6 换代码             git reset --hard <NewCommit>（按提交号，不用 production/main），读远端 HEAD 必须等于它      阶段 code_updated
#   7 起服务             pm2 start task-pool，读 restart_time 作基准                                         阶段 started
#   8 就绪检查           本机 ready-check.js；READY_OK 后再读一次 restart_time，增长即判失败；pm2 pid 必须等于 3000 的监听 pid      阶段 ready / ready_failed
#   9 拉回本地           拉本次备份（保留 10 份正式名，手动命名的备份永不删）、拉协作附件（保留 5 份）；失败只 warn  阶段 pulled，最后 done
#
# 失败处置（用户 2026-10-24 裁定）：
#   - 唯一的自动动作：第 5 步「明确收到 BACKUP_FAIL」时自动 pm2 start task-pool（代码没动，等于撤销本次自己的 stop），随后只读核对；
#     核对通过 = 阶段 restarted_old，不通过 = restart_unverified，都记 result=failed，退出码 1。核对含「pm2 pid = 3000 的监听 pid」。
#   - 第 5 步没收到协议行（ssh 失败 / 超时 / 输出被截断）= 状态未知：不自动起服务，打印「先本地、后远端」两项前置检查与人工命令。
#   - 第 4 步停服失败或确认不过：不自动做任何事，打印现状与人工核对命令。
#   - 换代码之后（第 6、7、8 步）的任何失败：不自动回滚。先把发布记录阶段写成失败态，再打印回滚步骤（Write-RollbackGuide）：
#     所有回滚路径同一顺序：前置检查（先本地、再远端）→ pm2 stop 并确认 stopped → 确认 3000 零监听（netstat 查询成功且零 LISTENING，有监听者或查询失败就停止人工流程）→
#     git reset --hard 回滚目标并读回 HEAD → 是否恢复数据库（schema 扫描只是人工排查线索，
#     零命中也不下兼容结论）→ pm2 start → 核对；每一步成功并核对之后才做下一步。回滚指引里不再出现 pm2 restart。
#   - 人工核对的判据不把「没有输出」当成功：netstat 先不加过滤打印、判「查询成功（有 TCP 行）」再判「3000 零 LISTENING」；页面检查先要求 HTTP 200 再扫描内容。
#
# 第 5 步（备份结果）与第 8 步（就绪结果）的判定各由一个纯函数完成（Resolve-BackupOutcome / Resolve-ReadyOutcome，返回 OK / FAIL / UNKNOWN）；
# 真实路径与 -DryRun 都只经它们：DryRun 构造假的子进程结果（stdout、退出码、超时、启动错误）喂进去，不直接合成结论。
#
# 所有 ssh / scp 只经 Invoke-RemoteRead（只读）与 Invoke-RemoteWrite（会改生产或落本机文件）两个函数；
# -DryRun 下 Invoke-RemoteWrite 只打印「[DRYRUN] 将执行：<命令>」，不发出。远端命令按 cmd 语法写。
# -DryRun 仍会执行的只读探测：第 1 步 git ls-remote production（除非 -SkipPushCheck）、第 2 步的远端只读命令与本机 curl、本机 ready-check --check-args、
#   server.js 字面量预检（git grep）。注意：生产 pm2 守护进程常驻；远端没有守护进程时，pm2 jlist（DryRun 也执行）会拉起一个。
# 部署只在用户在场、由一个会话执行（方案 W8 规则 1），本脚本不加互斥锁。
#
# 自检隔离（wbs-server/scripts/verify-deploy-script.js）：任何不带 -DryRun 的自检运行必须同时满足三重隔离——
#   ① 被测脚本副本放在不属于任何 git 仓库的临时目录（仓库根取脚本位置，第 0 步 git -C 核对不过即中止）；
#   ② 子进程 PATH 只留 node 所在目录与 System32（没有 git、ssh、scp）；③ -ServerIP 192.0.2.1（TEST-NET，不可达）。
# 远端临时目录里的 backup-db-<Id>.js 部署后不删除（远端删除属清理动作），输出里提示它的位置。
#
# 备份策略：
#   - 生产端：每次部署都备份；同目录 task_pool.db.backup_<Id>；不自动清理（季度初手动跑）
#   - 本地端 db 备份：scp 拉本次新生成的 backup 到 E:\数据开发与治理规范手册\生产数据库备份\（先下载到 <正式名>.partial，核对大小与远端备份一致之后才改名为正式名，改名之后才轮转；失败时 .partial 保留、不改名、不轮转）；保留最近 10 份，旧的自动删（只统计正式名 task_pool.db.backup_YYYYMMDD_HHmmss，手动命名的备份永不删）；失败只 warn 不阻塞
#   - 本地端 collab 附件备份（v1.70.1+）：scp -r 拉整个 uploads/collab/ 到 E:\数据开发与治理规范手册\生产协作附件备份\collab_<Id>\；
#     拉完后删 _pending / _orphaned 两个子目录（临时区 / 隔离区不入备份）；保留最近 5 份按时间倒序，旧的自动删；失败只 warn 不阻塞
#
# ⚠️ KNOWN ISSUES（已知结构性缺口）：
# 1. 不跑 npm install —— 仅做"停服 + 备份 + 换代码 + 起服务"，新增 npm 依赖需手工处理：
#    路径 A（一次性根治）：找网络/运维修生产 npm SSL，使其能直连 registry 或走内网镜像
#    路径 B（每次手工）：本地 npm install 后 scp 主包+所有传递依赖到生产 node_modules/
#    检查传递依赖：cat node_modules/<pkg>/package.json | grep -A 5 dependencies
#    历史案例：v1.64.0 node-sql-parser（89MB）+ big-integer（186KB，传递依赖）
# 2. 文件编码必须 UTF-8 with BOM + CRLF —— 否则 PowerShell 5.1 按 GBK 解码中文，
#    三字节 UTF-8 中文（如句号 U+3002 = E3 80 82）被 GBK 错误吞并下一字符
#    引发"missing terminator"假错误（2026-05-14 踩过）。自检 wbs-server/scripts/verify-deploy-script.js 会核对。

param(
    [string]$ServerIP = "192.168.1.100",
    [string]$ServerUser = "Administrator",
    [switch]$DryRun,
    [string]$DryRunFailAt = '',
    [string]$RemoteStateFile = '',
    [switch]$SkipPushCheck,
    [int]$ReadyTimeoutSec = 180,
    [string]$PushTimeoutSec = '1800'
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- 参数守卫（-DryRun 专用参数）
if (-not $DryRun) {
    $refused = @()
    if ($PSBoundParameters.ContainsKey('DryRunFailAt')) { $refused += '-DryRunFailAt' }
    if ($PSBoundParameters.ContainsKey('RemoteStateFile')) { $refused += '-RemoteStateFile' }
    if ($PSBoundParameters.ContainsKey('SkipPushCheck')) { $refused += '-SkipPushCheck' }
    if ($refused.Count -gt 0) {
        Write-Host "[REFUSED] $($refused -join ' / ') 只能与 -DryRun 同用，拒绝运行（没有做任何事）。" -ForegroundColor Red
        exit 2
    }
}
$validFailAt = @('backup', 'backup_noline', 'code', 'start', 'ready', 'ready_commit_null', 'restart_loop', 'ready_stopped', 'ready_errored', 'ready_init_failed', 'push_landed', 'push_failed', 'stop_listen', 'ready_orphan')
if ($DryRunFailAt -ne '' -and ($validFailAt -notcontains $DryRunFailAt)) {
    Write-Host "[REFUSED] -DryRunFailAt 取值只能是：$($validFailAt -join ' / ')" -ForegroundColor Red
    exit 2
}
if ($RemoteStateFile -ne '' -and -not (Test-Path -LiteralPath $RemoteStateFile)) {
    Write-Host "[REFUSED] -RemoteStateFile 文件不存在：$RemoteStateFile" -ForegroundColor Red
    exit 2
}
if ($ReadyTimeoutSec -lt 1 -or $ReadyTimeoutSec -gt 86400) {
    Write-Host "[REFUSED] -ReadyTimeoutSec 必须在 1-86400 之间" -ForegroundColor Red
    exit 2
}
# -PushTimeoutSec：只收 60-7200 的整数（不收小数、负数、空串、带符号或字母）；非法即拒绝，没有做任何事
if ($PushTimeoutSec -notmatch '^[0-9]{1,5}$' -or [int]$PushTimeoutSec -lt 60 -or [int]$PushTimeoutSec -gt 7200) {
    Write-Host "[REFUSED] -PushTimeoutSec 必须是 60-7200 之间的整数（秒）：'$PushTimeoutSec'" -ForegroundColor Red
    exit 2
}
$script:PushTimeoutSec = [int]$PushTimeoutSec

$script:DryRun = [bool]$DryRun
$script:RemoteStateMode = ($RemoteStateFile -ne '')
$script:Route = New-Object System.Collections.Generic.List[string]
$script:Stage = 'none'
$script:RecordFile = $null
$script:RecordDir = $null
$script:BackupPath = $null
$script:BackupBytes = $null
$script:WorkTmp = $null

# 远端常量（命令按 cmd 语法写）
$RemoteRepo = 'E:\Task_Pool'
$RemoteTmpDir = 'E:\Task_Pool_deploy_tmp'
$RemoteDb = 'E:\Task_Pool\wbs-server\task_pool.db'
$RemoteSqlite3 = 'E:\Task_Pool\wbs-server\node_modules\sqlite3'
$Pm2JlistCmd = 'cd /d E:\Task_Pool\wbs-server && pm2 jlist'
# 3000 端口的监听者（只读）：netstat -ano 全量输出，由 Get-ListeningPids 解析（不在远端用 findstr 先过滤：要靠「有 TCP 行」判断命令是否真的成功）
$NetstatCmd = 'netstat -ano'
$AppPort = 3000
$Pm2StopCmd = 'cd /d E:\Task_Pool\wbs-server && pm2 stop task-pool'
$Pm2StartCmd = 'cd /d E:\Task_Pool\wbs-server && pm2 start task-pool'
$RepoHeadCmd = 'git -C E:\Task_Pool rev-parse HEAD'
$FetchCmd = 'cd /d E:\Task_Pool && git fetch production'
# 新提交必须自带的两处字面量（取自 wbs-server/server.js 的稳定写法）：就绪接口路由（:4691 app.get('/api/health/ready'…)）与 /api/version 返回 commit 字段（:4681 commit: DEPLOY_COMMIT）。
# 没有它们的提交（#106 S1a、S3a 之前的代码）部署后 ready-check 必然失败，所以在停服之前就拦下
$ReadyRouteLiteral = "app.get('/api/health/ready'"
$CommitFieldLiteral = 'commit: DEPLOY_COMMIT'
$BaseUrl = "http://${ServerIP}:3000"
$DeployDir = Join-Path $PSScriptRoot 'deploy'
$BackupJs = Join-Path $DeployDir 'backup-db.js'
$RecordJs = Join-Path $DeployDir 'release-record.js'
$ReadyJs = Join-Path $DeployDir 'ready-check.js'

# ---------------------------------------------------------------- 输出与退出
function Write-Step([string]$No, [string]$Title) {
    Write-Host "[$No] $Title" -ForegroundColor Yellow
}
function Write-Info([string]$Text, [string]$Color = 'Gray') {
    Write-Host "  $Text" -ForegroundColor $Color
}
function Write-DryLine([string]$Text) {
    Write-Host "  [DRYRUN] $Text" -ForegroundColor Magenta
}
function Add-Route([string]$Text) {
    [void]$script:Route.Add($Text)
}
function Exit-Deploy([int]$Code) {
    if ($script:DryRun) {
        Write-Host ""
        Write-Host "[DRYRUN] 分支走向：" -ForegroundColor Magenta
        foreach ($t in $script:Route) { Write-Host "[DRYRUN]   $t" -ForegroundColor Magenta }
        Write-Host "[DRYRUN] 退出码：$Code" -ForegroundColor Magenta
        Write-Host "[DRYRUN] 以上写命令均未发出。照常执行的只读探测：第 1 步 git ls-remote production（除非 -SkipPushCheck）、第 2 步的远端只读命令与本机 curl、本机 ready-check --check-args、server.js 字面量预检（git grep）。" -ForegroundColor Magenta
        if ($null -ne $script:RecordDir) { Write-Host "[DRYRUN] 发布记录目录（保留，便于查看）：$($script:RecordDir)" -ForegroundColor Magenta }
    }
    # 工作临时目录（pm2 解析脚本等）退出前删除；DryRun 的发布记录目录不在此列
    if ($null -ne $script:WorkTmp) { Remove-Item -LiteralPath $script:WorkTmp -Recurse -Force -ErrorAction SilentlyContinue }
    exit $Code
}

# ---------------------------------------------------------------- 本机进程调用（通用，不含 ssh / scp）
function ConvertTo-ArgString([string[]]$ArgList) {
    $parts = foreach ($a in $ArgList) {
        if ($null -eq $a -or $a.Length -eq 0) { '""' }
        elseif ($a -notmatch '[\s"]') { $a }
        else { '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
    }
    return ($parts -join ' ')
}

function New-DryResult {
    return [pscustomobject]@{ DryRun = $true; ExitCode = 0; Stdout = ''; Stderr = ''; TimedOut = $false; StartError = $null }
}

# 起一个本机子进程，只读 stdout / stderr（两路分开，不合并），带超时。返回 { ExitCode, Stdout, Stderr, TimedOut, StartError }
function Invoke-Local {
    param([string]$FileName, [string[]]$ArgList = @(), [int]$TimeoutSec = 60, [string]$WorkDir = '', $StdinText = $null)
    $r = [pscustomobject]@{ DryRun = $false; ExitCode = -1; Stdout = ''; Stderr = ''; TimedOut = $false; StartError = $null }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = ConvertTo-ArgString $ArgList
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = ($null -ne $StdinText)
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkDir -ne '') { $psi.WorkingDirectory = $WorkDir }
    # 终止子进程之后收尾的额外宽限（等进程退出、等输出读完），不计入 TimeoutSec：一次超时的调用最多耗时约 TimeoutSec + 宽限（自检 U10 按这个上限断言）
    $graceMs = 5000
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        $r.StartError = $_.Exception.Message
        return $r
    }
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($null -ne $StdinText) {
        # 文本经 stdin 传给子进程（不落盘）；先起好读输出的任务再写，避免管道写满互相等
        # 注意：.NET Framework 的 Process.StandardInput 是个 StreamWriter，编码取控制台输入代码页；代码页是 65001（UTF-8）时它会在流最前面补写 BOM（EF BB BF），
        # 这里没法关掉，所以接收方（stdin 的读取端）必须容忍开头的 BOM（见 Get-Pm2Task 里 node 脚本的 replace）
        # 写入是异步的，并与等待退出共用同一个总截止时间：子进程不读 stdin 而输入超过管道缓冲区时，同步 Write 会永远阻塞、TimeoutSec 不生效
        try {
            $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes([string]$StdinText)
            $stdinStream = $p.StandardInput.BaseStream
            $writeTask = $stdinStream.WriteAsync($bytes, 0, $bytes.Length)
            # 总截止 = 启动时刻 + TimeoutSec：等写入只等剩余的毫秒数（已到期就是 0，直接走超时处置），不是再等一个完整的 TimeoutSec
            $remainWriteMs = [int][math]::Max(0, ($TimeoutSec * 1000) - $sw.ElapsedMilliseconds)
            if ($writeTask.Wait($remainWriteMs)) {
                $stdinStream.Flush()
            } else {
                $r.TimedOut = $true
                try { $p.Kill() } catch { }
            }
        } catch {
            $r.StartError = "写 stdin 失败：$($_.Exception.Message)"
        }
        try { $p.StandardInput.Close() } catch { }
    }
    if ($r.TimedOut) {
        [void]$p.WaitForExit($graceMs)
    } else {
        $remainMs = [int][math]::Max(1, ($TimeoutSec * 1000) - $sw.ElapsedMilliseconds)
        if (-not $p.WaitForExit($remainMs)) {
            $r.TimedOut = $true
            try { $p.Kill() } catch { }
            [void]$p.WaitForExit($graceMs)
        }
    }
    if ($outTask.Wait($graceMs)) { $r.Stdout = $outTask.Result }
    if ($errTask.Wait($graceMs)) { $r.Stderr = $errTask.Result }
    if (-not $r.TimedOut) { $r.ExitCode = $p.ExitCode }
    $p.Dispose()
    return $r
}

function Test-Ok($Res) {
    return ($null -ne $Res -and $null -eq $Res.StartError -and -not $Res.TimedOut -and $Res.ExitCode -eq 0)
}

function Get-LastLine([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $lines = $Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' }
    if ($null -eq $lines) { return '' }
    return @($lines)[-1]
}

function Get-ResultNote($Res) {
    if ($null -eq $Res) { return '(无结果)' }
    if ($null -ne $Res.StartError) { return "无法启动：$($Res.StartError)" }
    if ($Res.TimedOut) { return '超时' }
    $e = ([string]$Res.Stderr).Trim()
    if ($e.Length -gt 300) { $e = $e.Substring(0, 300) }
    return "退出码 $($Res.ExitCode) $e"
}

function Invoke-Git {
    param([string[]]$ArgList, [int]$TimeoutSec = 60)
    # 仓库根没确定之前绝不起 git（否则会落到进程当前目录，可能是另一个仓库）
    if ([string]::IsNullOrEmpty($script:RepoRoot)) {
        return [pscustomobject]@{ DryRun = $false; ExitCode = -1; Stdout = ''; Stderr = ''; TimedOut = $false; StartError = '仓库根尚未确定' }
    }
    return (Invoke-Local -FileName 'git' -ArgList $ArgList -TimeoutSec $TimeoutSec -WorkDir $script:RepoRoot)
}

# ---------------------------------------------------------------- 统一远端调用口（文件里只有这两个函数体可以出现 ssh / scp）
# 只读命令。-DryRun 下照常执行；-RemoteStateFile 模式下不应有任何远端读取，一旦调用直接拒绝（返回启动错误）。
function Invoke-RemoteRead {
    param([string]$Command = '', [string[]]$TransferArgs = $null, [int]$TimeoutSec = 60, [string]$WorkDir = '')
    if ($script:RemoteStateMode) {
        return [pscustomobject]@{ DryRun = $false; ExitCode = -1; Stdout = ''; Stderr = ''; TimedOut = $false; StartError = 'RemoteStateFile 模式下不允许真实远端读取' }
    }
    if ($null -ne $TransferArgs) {
        $exe = 'scp'
        $argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15') + $TransferArgs
        $shown = 'scp ' + ($TransferArgs -join ' ')
    } else {
        $exe = 'ssh'
        $argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', "${ServerUser}@${ServerIP}", $Command)
        $shown = "ssh ${ServerUser}@${ServerIP} $Command"
    }
    Write-Host "  [REMOTE-READ] $shown" -ForegroundColor DarkGray
    $res = Invoke-Local -FileName $exe -ArgList $argv -TimeoutSec $TimeoutSec -WorkDir $WorkDir
    Write-Host "    exit=$($res.ExitCode) timedOut=$($res.TimedOut) startError=$($res.StartError)" -ForegroundColor DarkGray
    return $res
}

# 会改生产（或把生产文件落到本机）的命令。-DryRun 下只打印，不发出。
function Invoke-RemoteWrite {
    param([string]$Command = '', [string[]]$TransferArgs = $null, [int]$TimeoutSec = 120, [string]$WorkDir = '')
    if ($null -ne $TransferArgs) {
        $exe = 'scp'
        $argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15') + $TransferArgs
        $shown = 'scp ' + ($TransferArgs -join ' ')
    } else {
        $exe = 'ssh'
        $argv = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', "${ServerUser}@${ServerIP}", $Command)
        $shown = "ssh ${ServerUser}@${ServerIP} $Command"
    }
    if ($script:DryRun) {
        Write-DryLine "将执行：$shown"
        return (New-DryResult)
    }
    Write-Host "  [REMOTE-WRITE] $shown" -ForegroundColor DarkGray
    $res = Invoke-Local -FileName $exe -ArgList $argv -TimeoutSec $TimeoutSec -WorkDir $WorkDir
    Write-Host "    exit=$($res.ExitCode) timedOut=$($res.TimedOut) startError=$($res.StartError)" -ForegroundColor DarkGray
    return $res
}

# ---------------------------------------------------------------- 协议行 / pm2 / 版本
# 只在 stdout 最后一个非空行以「<前缀> 」开头、整段以换行结尾、其后 JSON 完整可解析时才算收到协议；否则返回 $null（状态未知）
function Read-Protocol {
    param($Res, [string[]]$Prefixes)
    if ($null -eq $Res -or $null -ne $Res.StartError -or $Res.TimedOut) { return $null }
    $text = [string]$Res.Stdout
    if (-not $text.EndsWith("`n")) { return $null }
    $line = Get-LastLine $text
    foreach ($p in $Prefixes) {
        if ($line.StartsWith($p + ' ')) {
            try {
                $obj = ConvertFrom-Json -InputObject $line.Substring($p.Length + 1)
            } catch {
                return $null
            }
            if ($obj -is [System.Management.Automation.PSCustomObject]) { return [pscustomobject]@{ Kind = $p; Json = $obj } }
            return $null
        }
    }
    return $null
}

# 假的子进程结果（DryRun 用）：与 Invoke-Local 返回同一结构，喂给与真实路径相同的判定函数
function New-FakeProc {
    param([string]$Stdout = '', [int]$ExitCode = 0, [bool]$TimedOut = $false, $StartError = $null)
    return [pscustomobject]@{ DryRun = $false; ExitCode = $ExitCode; Stdout = $Stdout; Stderr = ''; TimedOut = $TimedOut; StartError = $StartError }
}

# 第 5 步判定（纯函数，真实与 DryRun 都只经它）：
#   OK      收到 BACKUP_OK，且 json 有非空的 out
#   FAIL    明确收到 BACKUP_FAIL（整段以换行结尾、最后一个非空行、JSON 完整）——这是唯一允许自动 pm2 start 的结论
#   UNKNOWN 其余一切（ssh 失败 / 超时 / 启动失败 / 输出被截断 / 只有 stderr / BACKUP_OK 缺 out）。只看 stdout 协议行，不凭退出码
function Resolve-BackupOutcome($Res) {
    $p = Read-Protocol -Res $Res -Prefixes @('BACKUP_OK', 'BACKUP_FAIL')
    if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Json = $null } }
    if ($p.Kind -eq 'BACKUP_FAIL') { return [pscustomobject]@{ Outcome = 'FAIL'; Json = $p.Json } }
    if ($p.Json.out -isnot [string] -or $p.Json.out -eq '') { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Json = $null } }
    return [pscustomobject]@{ Outcome = 'OK'; Json = $p.Json }
}

# 第 8 步判定（纯函数，真实与 DryRun 都只经它）：OK / FAIL（带 Hint：json 顶层 hint 为 COMMIT_NULL 时记下）/ UNKNOWN（没收到协议行，包括退出码 0 但没有协议行）
function Resolve-ReadyOutcome($Res) {
    $p = Read-Protocol -Res $Res -Prefixes @('READY_OK', 'READY_FAIL')
    if ($null -eq $p) { return [pscustomobject]@{ Outcome = 'UNKNOWN'; Hint = ''; Why = "没收到就绪协议行：$(Get-ResultNote $Res) 最后一行：$(Get-LastLine ([string]$Res.Stdout))" } }
    if ($p.Kind -eq 'READY_FAIL') {
        $hint = ''
        if ($null -ne $p.Json.PSObject.Properties['hint'] -and [string]$p.Json.hint -eq 'COMMIT_NULL') { $hint = 'COMMIT_NULL' }
        return [pscustomobject]@{ Outcome = 'FAIL'; Hint = $hint; Why = "READY_FAIL $(ConvertTo-Json -InputObject $p.Json -Compress -Depth 6)" }
    }
    return [pscustomobject]@{ Outcome = 'OK'; Hint = ''; Why = '' }
}

# 第 8 步 READY_OK 之后的终检（纯函数，真实与 DryRun 都经它）：唯一的 task-pool 必须 online，restart_time 读得到且比基准没有增长；任一不满足 = 失败
function Test-FinalPm2State($Pt, $BaseRestart) {
    $bad = { param($why, $kind = '') [pscustomobject]@{ Ok = $false; Why = $why; Kind = $kind } }
    if ($null -eq $Pt -or -not $Pt.Ok) { return (& $bad "READY_OK 之后读不到 pm2 状态：$(if ($null -ne $Pt) { $Pt.Error })") }
    if ($Pt.Count -ne 1) { return (& $bad "READY_OK 之后 pm2 里名为 task-pool 的应用数量是 $($Pt.Count)，不是 1") }
    if ([string]$Pt.Status -ne 'online') { return (& $bad "READY_OK 之后 task-pool 的状态是 '$($Pt.Status)'，不是 online：进程在就绪检查之后退出了") }
    if ($null -eq $Pt.RestartTime) { return (& $bad 'READY_OK 之后读不到 restart_time') }
    if ([int]$Pt.RestartTime -gt [int]$BaseRestart) {
        # 只多 1 次：仍判失败，但措辞不说「反复崩溃」，并带 Kind=RESTART_ONCE 让回滚指引先给 SQLITE_BUSY 的只读核对（见 Test-StartupBusyHint）
        if ([int]$Pt.RestartTime -eq [int]$BaseRestart + 1) { return (& $bad "READY_OK 之后 restart_time 从 $BaseRestart 增长到 $($Pt.RestartTime)：新进程重启过 1 次（可能是启动期的瞬时错误，先按下面的指引核对日志）" 'RESTART_ONCE') }
        return (& $bad "READY_OK 之后 restart_time 从 $BaseRestart 增长到 $($Pt.RestartTime)：新进程在反复崩溃重启")
    }
    return [pscustomobject]@{ Ok = $true; Why = ''; Kind = '' }
}

# 回滚指引要不要在回滚七步之前先给「启动期 SQLITE_BUSY」的只读核对（纯函数，只决定多打印一段文字，不触发任何动作）：
#   失败原因里含未就绪模块的 INIT_FAILED / SQLITE_*，或 READY_OK 之后 restart_time 只比基准多 1（Kind=RESTART_ONCE）。
function Test-StartupBusyHint([string]$Reason, [string]$Kind) {
    if ($Kind -eq 'RESTART_ONCE') { return $true }
    return ($Reason -match 'INIT_FAILED|SQLITE_')
}

function Initialize-WorkTmp {
    if ($null -ne $script:WorkTmp) { return }
    $d = Join-Path $env:TEMP ('sdh-deploy-work-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    $script:WorkTmp = $d
}

# pm2 jlist 的输出交给 node 解析（PowerShell 5.1 的 ConvertFrom-Json 遇到仅大小写不同的键会报错，pm2 环境变量里可能有）
function Get-Pm2Task([string]$JlistText) {
    $fail = { param($why) [pscustomobject]@{ Ok = $false; Count = 0; Status = $null; RestartTime = $null; Pid = $null; Error = $why } }
    Initialize-WorkTmp
    $js = Join-Path $script:WorkTmp 'pm2-parse.js'
    if (-not (Test-Path -LiteralPath $js)) {
        $code = @'
// pm2 jlist 原文（含生产进程的环境变量）经 stdin 传进来，不落盘
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
  // 去掉开头的 BOM：.NET 的 Process.StandardInput 用控制台输入代码页的编码，宿主是 UTF-8 代码页（chcp 65001，例如 PowerShell 工具）时会在 stdin 最前面多写 EF BB BF，
  // 真实的 pm2 jlist 又以 [{ 打头（没有前缀行），带着 BOM 就匹配不到行首的 [（NO_JSON_ARRAY）
  let text = Buffer.concat(chunks).toString('utf8');
  while (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 去掉开头的 U+FEFF（BOM）
  const m = /^\[\s*(\{|\])/m.exec(text);
  if (!m) { out({ ok: false, error: 'NO_JSON_ARRAY' }); return; }
  const body = text.slice(m.index).trim();
  let apps = null;
  try { apps = JSON.parse(body); } catch (e) {
    const last = body.lastIndexOf(']');
    try { apps = JSON.parse(body.slice(0, last + 1)); } catch (e2) { out({ ok: false, error: 'BAD_JSON' }); return; }
  }
  if (!Array.isArray(apps)) { out({ ok: false, error: 'NOT_ARRAY' }); return; }
  const hit = apps.filter((a) => a && a.name === 'task-pool');
  const one = hit.length === 1 ? hit[0] : null;
  const env = one && one.pm2_env ? one.pm2_env : {};
  // pid 取 jlist 顶层的 pid（stopped 的应用是 0；不是整数一律当读不到）
  out({ ok: true, count: hit.length, status: one ? env.status : null, restartTime: one && typeof env.restart_time === 'number' ? env.restart_time : null, pid: one && Number.isInteger(one.pid) ? one.pid : null });
});
'@
        [System.IO.File]::WriteAllText($js, $code, (New-Object System.Text.UTF8Encoding($false)))
    }
    $r = Invoke-Local -FileName 'node' -ArgList @($js) -TimeoutSec 30 -WorkDir $script:RepoRoot -StdinText $JlistText
    if (-not (Test-Ok $r)) { return (& $fail (Get-ResultNote $r)) }
    try {
        $o = ConvertFrom-Json -InputObject (Get-LastLine $r.Stdout)
    } catch {
        return (& $fail 'node 输出不是 JSON')
    }
    if ($o.ok -ne $true) { return (& $fail ([string]$o.error)) }
    return [pscustomobject]@{ Ok = $true; Count = [int]$o.count; Status = $o.status; RestartTime = $o.restartTime; Pid = $o.pid; Error = $null }
}

# 读远端 pm2 里 task-pool 的状态。返回 Get-Pm2Task 的结构；ssh 失败时 Ok=$false
function Read-RemotePm2Task([int]$TimeoutSec = 30) {
    $j = Invoke-RemoteRead -Command $Pm2JlistCmd -TimeoutSec $TimeoutSec
    if (-not (Test-Ok $j)) {
        return [pscustomobject]@{ Ok = $false; Count = 0; Status = $null; RestartTime = $null; Pid = $null; Error = (Get-ResultNote $j) }
    }
    return (Get-Pm2Task $j.Stdout)
}

# 3000 端口的 LISTENING 监听者（纯函数，解析 netstat -ano 的全量输出）：
#   只看 TCP 行，本地地址端口必须整数等于 $Port（:30000 不算 3000）、状态必须是 LISTENING（ESTABLISHED / TIME_WAIT / FIN_WAIT_1 / FIN_WAIT_2 / CLOSE_WAIT 等都不算）；0.0.0.0 与 [::] 两栈都算，同一 pid 只记一次。
#   状态列的形态是 [A-Z][A-Z0-9_]*（带数字的 FIN_WAIT_1 / FIN_WAIT_2 要认，服务端先关的长连接会留下它们）；不放宽成 \S+：非 ASCII 的本地化状态必须仍解析失败（fail-closed），否则仍在监听的端口会被判成已释放。
#   fail-closed：输出里没有任何 TCP 行（命令没成功 / 输出不是 netstat 格式），或有端口为 $Port 的 TCP 行解析不了，都返回 Ok=$false（调用方不得当成「没有监听者」）。
function Get-ListeningPids([string]$NetstatText, [int]$Port) {
    $tcpRows = 0
    $pids = New-Object System.Collections.Generic.List[int]
    foreach ($line in ($NetstatText -split "`r?`n")) {
        if ($line -notmatch '^\s*TCP\s') { continue }
        $tcpRows++
        $m = [regex]::Match($line, '^\s*TCP\s+(\S+):([0-9]+)\s+(\S+)\s+([A-Z][A-Z0-9_]*)\s+([0-9]+)\s*$')
        if (-not $m.Success) {
            if ($line -match "[:.]$Port\s") { return [pscustomobject]@{ Ok = $false; Pids = @(); Why = "netstat 里有无法解析的 TCP 行（端口 $Port）：$($line.Trim())" } }
            continue
        }
        if ([int]$m.Groups[2].Value -ne $Port) { continue }
        if ($m.Groups[4].Value -ne 'LISTENING') { continue }
        $pp = [int]$m.Groups[5].Value
        if (-not $pids.Contains($pp)) { $pids.Add($pp) }
    }
    if ($tcpRows -eq 0) { return [pscustomobject]@{ Ok = $false; Pids = @(); Why = 'netstat 输出里没有任何 TCP 行（命令没成功，或输出不是 netstat -ano 的格式）' } }
    return [pscustomobject]@{ Ok = $true; Pids = @($pids | Sort-Object); Why = '' }
}

# 读远端 3000 的监听者（只读，经 Invoke-RemoteRead）。返回 Get-ListeningPids 的结构；ssh 失败时 Ok=$false
function Read-RemoteListeners([int]$TimeoutSec = 30) {
    $n = Invoke-RemoteRead -Command $NetstatCmd -TimeoutSec $TimeoutSec
    if (-not (Test-Ok $n)) { return [pscustomobject]@{ Ok = $false; Pids = @(); Why = "读不到远端 netstat：$(Get-ResultNote $n)" } }
    return (Get-ListeningPids $n.Stdout $AppPort)
}

# 硬门（纯函数，只拒不放）：pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid。
#   读不到 pm2 的 pid（null / 0 / 不是数字）、读不到监听情况、没有监听、多个不同 pid、pid 不等，一律不通过。
function Test-Pm2OwnsPort($PmPid, $Listen) {
    $head = '3000 监听者与 pm2 进程不一致，疑似孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置'
    $p = 0
    if ($null -eq $PmPid -or -not [int]::TryParse([string]$PmPid, [ref]$p) -or $p -le 0) {
        return [pscustomobject]@{ Ok = $false; Why = "无法核对 3000 监听者与 pm2 进程是否一致：读不到 pm2 记录的 pid（'$PmPid'）" }
    }
    if ($null -eq $Listen -or -not $Listen.Ok) {
        return [pscustomobject]@{ Ok = $false; Why = "无法核对 3000 监听者与 pm2 进程是否一致：读不到 3000 的监听情况（$(if ($null -ne $Listen) { $Listen.Why })）" }
    }
    $n = @($Listen.Pids).Count
    if ($n -eq 0) { return [pscustomobject]@{ Ok = $false; Why = "${head}：3000 没有 LISTENING（pm2 记录的 pid $p）" } }
    if ($n -gt 1) { return [pscustomobject]@{ Ok = $false; Why = "${head}：3000 有多个不同 pid 在监听（$(@($Listen.Pids) -join ',')），pm2 记录的 pid $p" } }
    if ([int]@($Listen.Pids)[0] -ne $p) { return [pscustomobject]@{ Ok = $false; Why = "${head}：3000 的监听 pid $(@($Listen.Pids)[0]) 不等于 pm2 记录的 pid $p" } }
    return [pscustomobject]@{ Ok = $true; Why = '' }
}

# 硬门（纯函数，只拒不放）：停服确认 stopped 之后，3000 必须零 LISTENING。读不到监听情况也不通过。
function Test-PortReleased($Listen) {
    if ($null -eq $Listen -or -not $Listen.Ok) { return [pscustomobject]@{ Ok = $false; Why = "读不到 3000 的监听情况，无法确认已释放（$(if ($null -ne $Listen) { $Listen.Why })）" } }
    if (@($Listen.Pids).Count -gt 0) { return [pscustomobject]@{ Ok = $false; Why = "停服之后 3000 仍有 LISTENING，pid $(@($Listen.Pids) -join ',')" } }
    return [pscustomobject]@{ Ok = $true; Why = '' }
}

# DryRun 专用：造一份 netstat -ano 形态的假输出（有若干无关行，3000 的 LISTENING 行按给定 pid 两栈各一行），喂给与真实路径相同的 Get-ListeningPids
function New-FakeNetstat([int[]]$ListenPids = @()) {
    # 无关行里带数字状态的 FIN_WAIT_2 / FIN_WAIT_1（服务端先关的长连接会留下它们）：健康服务的真实输出里常见，解析必须照常通过
    $rows = @('Active Connections', '', '  Proto  Local Address          Foreign Address        State           PID', '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888',
        "  TCP    192.168.1.100:$AppPort      192.168.1.5:50124       FIN_WAIT_2      0", "  TCP    192.168.1.100:$AppPort      192.168.1.5:50125       FIN_WAIT_1      0")
    foreach ($lp in $ListenPids) {
        $rows += "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       $lp"
        $rows += "  TCP    [::]:3000              [::]:0                 LISTENING       $lp"
    }
    return ($rows -join "`r`n") + "`r`n"
}

# 推送失败 / 超时之后的只读核对结论（纯函数）：$LsRes 是本机 git ls-remote production refs/heads/main 的结果（带超时）。
#   远端 main 已等于 NewCommit = 推送其实已生效（git push 可能卡在远端 gc --auto 之类的收尾上）；否则照旧只报原失败原因。两种都不继续往下走。
function Resolve-PushAftermath($PushRes, $LsRes, [string]$NewCommit) {
    $first = ''
    if (Test-Ok $LsRes) { $first = [string]((Get-LastLine ([string]$LsRes.Stdout)) -split '\s+' | Select-Object -First 1) }
    if ($NewCommit -match '^[0-9a-f]{40}$' -and $first -eq $NewCommit) {
        return [pscustomobject]@{ Landed = $true; Message = "git push production main 没有正常结束（$(Get-ResultNote $PushRes)），但只读核对 git ls-remote production refs/heads/main 已等于 NewCommit $NewCommit：推送已生效，可能卡在远端 gc --auto。确认没有在跑的 git 进程后重跑本脚本（推送会是 up-to-date）。" }
    }
    # 只读核对本身也失败（超时 / 启动失败 / 退出码非 0）：推送有没有生效不知道，不能说「没推上去」；重跑本脚本是安全的（推送幂等，第 2 步起照常只读核对）
    if (-not (Test-Ok $LsRes)) {
        return [pscustomobject]@{ Landed = $false; Message = "git push production main 失败：$(Get-ResultNote $PushRes)；只读核对 git ls-remote production refs/heads/main 也失败（$(Get-ResultNote $LsRes)），推送是否生效未知；重跑安全（推送幂等）。" }
    }
    return [pscustomobject]@{ Landed = $false; Message = "git push production main 失败：$(Get-ResultNote $PushRes)" }
}

# 第 1 步 push 超时或失败：只读核对远端引用，打印结论并中止（Stop-Early，生产未动）。DryRun 的 push_landed / push_failed 喂假结果走同一个函数
function Stop-PushNotConfirmed($PushRes, $LsRes) {
    $pa = Resolve-PushAftermath $PushRes $LsRes $script:NewCommit
    if ($pa.Landed) {
        Write-Host "  查有没有在跑的 git 进程（本机 PowerShell 里运行；命令见下一行）：" -ForegroundColor Yellow
        Write-Host "      Get-CimInstance Win32_Process -Filter ""Name='git.exe'"" | Where-Object { `$_.CommandLine -match 'receive-pack|gc|TaskPool' } | Select-Object ProcessId,CommandLine" -ForegroundColor White
        Write-Host "      判据：结果为空才重跑本脚本；还有 git 进程的，等它结束后再查一次。" -ForegroundColor Gray
    }
    Stop-Early $pa.Message
}

function Read-RemoteHead([int]$TimeoutSec = 30) {
    $h = Invoke-RemoteRead -Command $RepoHeadCmd -TimeoutSec $TimeoutSec
    if (-not (Test-Ok $h)) { return $null }
    $v = $h.Stdout.Trim()
    if ($v -notmatch '^[0-9a-f]{40}$') { return $null }
    return $v
}

# 本机取生产 /api/version（本机代理会把 172.16.x 转外部代理，必须 --noproxy）
function Get-RunningVersion {
    $r = Invoke-Local -FileName 'curl.exe' -ArgList @('--noproxy', '*', '-s', '-m', '5', "$BaseUrl/api/version") -TimeoutSec 15
    if (-not (Test-Ok $r)) { return [pscustomobject]@{ Ok = $false; Version = $null; Commit = $null; Error = (Get-ResultNote $r) } }
    try {
        $o = ConvertFrom-Json -InputObject $r.Stdout
    } catch {
        return [pscustomobject]@{ Ok = $false; Version = $null; Commit = $null; Error = '/api/version 不是 JSON' }
    }
    $ver = $null
    $com = $null
    if ($null -ne $o.PSObject.Properties['version']) { $ver = [string]$o.version }
    if ($null -ne $o.PSObject.Properties['commit'] -and $null -ne $o.commit -and [string]$o.commit -ne '') { $com = [string]$o.commit }
    if ([string]::IsNullOrEmpty($ver)) { return [pscustomobject]@{ Ok = $false; Version = $null; Commit = $null; Error = '/api/version 没有 version 字段' } }
    return [pscustomobject]@{ Ok = $true; Version = $ver; Commit = $com; Error = $null }
}

# ---------------------------------------------------------------- 发布记录
function Invoke-Record([string[]]$Sub) {
    $a = @($RecordJs) + $Sub
    if ($script:DryRun) { $a += @('--dir', $script:RecordDir) }
    $r = Invoke-Local -FileName 'node' -ArgList $a -TimeoutSec 30 -WorkDir $script:RepoRoot
    $line = Get-LastLine $r.Stdout
    $ok = (Test-Ok $r) -and ($line -ne '') -and (-not $line.StartsWith('RELEASE_RECORD_FAIL'))
    return [pscustomobject]@{ Ok = $ok; Line = $line }
}

# 写阶段。写入失败只警告、不中止（回滚指引用脚本内存里的值，不依赖记录文件）
function Set-Stage {
    param([string]$Stage, [string]$Backup = '', [string]$Attachments = '', [string]$Result = '', [string]$Note = '')
    $script:Stage = $Stage
    $a = @('stage', '--id', $script:Id, '--stage', $Stage)
    if ($Backup -ne '') { $a += @('--backup', $Backup) }
    if ($Attachments -ne '') { $a += @('--attachments', $Attachments) }
    if ($Result -ne '') { $a += @('--result', $Result) }
    if ($Note -ne '' -and $Note -match '^[A-Za-z0-9_]+$') { $a += @('--note', $Note) }
    $r = Invoke-Record $a
    if ($r.Ok) {
        Write-Info "[记录] 阶段 -> $Stage" 'DarkGray'
    } else {
        Write-Host "  [WARN] 发布记录写入失败（阶段 $Stage）：$($r.Line)。部署继续；回滚指引用内存值。" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------- 失败处置文字
function Format-Tri($v) {
    if ($v -is [bool]) { if ($v) { return '是' } else { return '否' } }
    if ($v -is [string] -and $v -eq 'unknown') { return '无法确认（探测本身出错，需人工核对）' }
    return '未提供'
}

function Get-SchemaChanges {
    $r = Invoke-Git -ArgList @('diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', $script:PrevCommit, $script:NewCommit, '--', 'wbs-server') -TimeoutSec 120
    if (-not (Test-Ok $r)) { return [pscustomobject]@{ Ok = $false; Files = @(); Error = (Get-ResultNote $r) } }
    $file = ''
    $hits = [ordered]@{}
    foreach ($line in ($r.Stdout -split "`r?`n")) {
        if ($line.StartsWith('+++ ')) { $file = $line.Substring(4); continue }
        # 只排除明确的测试文件与说明文档（自检脚本里满是示例 SQL）；wbs-server/scripts/ 下其他脚本（可能是迁移脚本）不排除。
        # 结果只是人工排查线索：零命中也不能证明数据库兼容（UPDATE 数据回填、拼接生成的 DDL 等扫不出来）
        if ($file -match '^b/wbs-server/scripts/(verify|test)-[^/]*$' -or $file -match '\.md$' -or $file -match '^b/docs/') { continue }
        if ($line.StartsWith('+') -and $line -match '(?i)\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|RENAME\s+(TO|COLUMN))\b') {
            if (-not $hits.Contains($file)) { $hits[$file] = $line.Substring(1).Trim() }
        }
    }
    return [pscustomobject]@{ Ok = $true; Files = @($hits.GetEnumerator() | ForEach-Object { "$($_.Key)  <-  $($_.Value)" }); Error = $null }
}

# 本地附件快照：只有正式名 collab_yyyyMMdd_HHmmss 的目录才算（失败残留的 .partial 等不计入保留份数），按名字倒序
function Get-FormalCollabSnapshots([string]$Base) {
    return @(Get-ChildItem -LiteralPath $Base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^collab_\d{8}_\d{6}$' } | Sort-Object Name -Descending)
}

# 本地库备份：只有正式名 task_pool.db.backup_yyyyMMdd_HHmmss 的文件才算（手动命名的、.partial 等不计入保留份数，更不会被轮转删掉），按名字倒序。口径同 Get-FormalCollabSnapshots
function Get-FormalDbBackups([string]$Base) {
    return @(Get-ChildItem -LiteralPath $Base -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^task_pool\.db\.backup_\d{8}_\d{6}$' } | Sort-Object Name -Descending)
}

# 本地库备份轮转要删的文件（只读，纯函数）：正式名里超出保留份数的最旧几份
function Get-DbBackupsToDelete([string]$Base, [int]$Keep = 10) {
    return @(Get-FormalDbBackups $Base | Select-Object -Skip $Keep)
}

# 本地库备份下载之后的大小核对（纯函数，只拒不放）：期望值（远端备份的大小）必须是正整数，本地 .partial 的大小必须等于它；
# 期望值读不到、本地大小读不到、两者不等，一律不通过（调用方不得改名为正式名，更不得轮转）
function Test-BackupSizeMatch($Expected, $Actual) {
    $e = 0L
    $a = 0L
    if ($null -eq $Expected -or -not [long]::TryParse([string]$Expected, [ref]$e) -or $e -le 0) {
        return [pscustomobject]@{ Ok = $false; Why = "读不到远端备份的大小（'$Expected'），无法核对下载是否完整" }
    }
    if ($null -eq $Actual -or -not [long]::TryParse([string]$Actual, [ref]$a)) {
        return [pscustomobject]@{ Ok = $false; Why = "读不到本地 .partial 的大小（'$Actual'），无法核对下载是否完整" }
    }
    if ($a -ne $e) {
        return [pscustomobject]@{ Ok = $false; Why = "本地 .partial 的大小 $a 与远端备份的大小 $e 不一致，下载不完整" }
    }
    return [pscustomobject]@{ Ok = $true; Why = '' }
}

# 前置检查（先本地、后远端）：回滚或人工处理之前必须先做。可复制的命令各占一行，判据 / 说明另起一行
function Write-PreChecks {
    $target = "${ServerUser}@${ServerIP}"
    Write-Host ""
    Write-Host "  前置检查·先本地：确认本次部署在本机的 PowerShell 与它派生的 ssh.exe / scp.exe 都已退出（还在的先终止，再确认）。" -ForegroundColor Cyan
    Write-Host "      查询（本机 PowerShell 里运行；本查询自身已排除）：" -ForegroundColor Gray
    $q = 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match ''^(powershell|pwsh|ssh|scp)\.exe$'' -and $_.CommandLine -match ''deploy-ssh|@@T@@'' } | Select-Object ProcessId,Name,CommandLine'
    Write-Host ("      " + $q.Replace('@@T@@', $target)) -ForegroundColor White
    Write-Host "      判据：结果里不应再有部署进程。还在的用下一行终止（<ProcessId> 换成查到的进程号），终止后重跑上面的查询，确认为空。" -ForegroundColor Gray
    Write-Host "      Stop-Process -Id <ProcessId>" -ForegroundColor White
    Write-Host ""
    Write-Host "  前置检查·再远端：远端没有残留的部署进程，pm2 状态已知，远端 HEAD 稳定。" -ForegroundColor Cyan
    Write-Host "      残留的 git：" -ForegroundColor Gray
    Write-Host "      ssh $target ""tasklist | findstr /i git.exe""" -ForegroundColor White
    Write-Host "      残留的备份进程（正则要求 backup-db- 后面紧跟数字，所以不会匹配到查询命令自身）：" -ForegroundColor Gray
    Write-Host "      ssh $target ""wmic process get name,processid,commandline | findstr /i /r backup-db-[0-9]""" -ForegroundColor White
    Write-Host "      新版 Windows 可能没有 wmic，登录远端 PowerShell 后改用下面这条，看命令行里有没有 backup-db-<数字>：" -ForegroundColor Gray
    Write-Host "      Get-CimInstance Win32_Process -Filter ""Name='node.exe'"" | Select-Object ProcessId,CommandLine" -ForegroundColor White
    Write-Host "      task-pool 状态：" -ForegroundColor Gray
    Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White
    Write-Host "      远端 HEAD（间隔 10 秒读两次，必须一致）：" -ForegroundColor Gray
    Write-Host "      ssh $target ""$RepoHeadCmd""" -ForegroundColor White
    Write-Host "      Start-Sleep 10" -ForegroundColor White
    Write-Host "      ssh $target ""$RepoHeadCmd""" -ForegroundColor White
}

# 3000 端口监听情况的人工只读核对（只打印，不执行；调用方在后面接自己的结论判据）。
# 命令不在远端用 findstr 先过滤：过滤之后「没有输出」既可能是零监听，也可能是 ssh / netstat 本身失败，两者分不开。
# 所以判据分两段：先要求查询成功（输出里有 TCP 行），再数 3000 的 LISTENING 行；「查询成功但零命中」与「查询失败」在文字里明确区分
function Write-ListenerCheck {
    $target = "${ServerUser}@${ServerIP}"
    Write-Host "      ssh $target ""netstat -ano""" -ForegroundColor White
    Write-Host "      判据一（先确认查询成功）：ssh 没有报错，输出里有 TCP 行（本地地址列形如 0.0.0.0:135）。没有 TCP 行、ssh 报错、超时或输出为空，都是「查询失败」，不是「零监听」：停下，重查，不要往下做。" -ForegroundColor Gray
    Write-Host "      判据二（再数监听者，只在判据一通过之后）：TCP 行里本地地址端口恰为 3000 且状态为 LISTENING 的行（0.0.0.0:3000 与 [::]:3000 都算，:30000 之类不算）必须为零；有一行就是还有监听者，行末尾的数字是占用 3000 的 pid（多半是孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置）。" -ForegroundColor Gray
}

# 起服务之后的核对命令（只打印，不执行；路径都加引号，可直接复制；命令各占一行，判据另起一行）
function Write-VerifyAfterStart {
    $target = "${ServerUser}@${ServerIP}"
    if ($null -ne $script:RunCommit) {
        Write-Host "      核对（本机运行，用旧提交 / 旧版本）：" -ForegroundColor Gray
        Write-Host "      node ""$ReadyJs"" --base-url $BaseUrl --expect-commit $($script:PrevCommit) --expect-version $($script:RunVersion) --pages-from-commit $($script:PrevCommit) --repo ""$($script:RepoRoot)""" -ForegroundColor White
        Write-Host "      判据：最后一行是 READY_OK。" -ForegroundColor Gray
    } else {
        Write-Host "      旧版本的 /api/version 没有 commit 字段，改为人工核对：" -ForegroundColor Gray
        Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/version" -ForegroundColor White
        Write-Host "      判据：version 应为 $($script:RunVersion)，再打开主要页面确认能用。" -ForegroundColor Gray
        Write-Host "      旧版本的 version 可能与新版本相同，所以再核远端 HEAD：" -ForegroundColor Gray
        Write-Host "      ssh $target ""$RepoHeadCmd""" -ForegroundColor White
        Write-Host "      判据：必须等于 rollbackTarget $($script:PrevCommit)。" -ForegroundColor Gray
    }
    # 孤儿监听核对（只读）：pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid
    Write-Host "      再核对 pm2 进程就是 3000 端口的监听者（孤儿监听核对）：" -ForegroundColor Gray
    Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White
    Write-Host "      ssh $target ""netstat -ano | findstr LISTENING | findstr :3000""" -ForegroundColor White
    Write-Host "      判据：netstat 里本地地址端口恰为 3000 的 LISTENING 行（0.0.0.0:3000 与 [::]:3000 两行都算，:30000 之类不算）末尾的 pid 只能有一个，且等于 pm2 pid task-pool 的输出；" -ForegroundColor Gray
    Write-Host "      不等、有多个或一个都没有，就是孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置，不要当成回滚完成。" -ForegroundColor Gray
    Write-Host "      判据：上面任一条命令失败（ssh 报错、超时、没有输出）都按未通过处理：没有输出可能只是查询失败，不是「一致」，也不是「没有监听者」。" -ForegroundColor Gray
}

# 换代码之后的失败：不自动回滚，只打印回滚步骤（调用前必须已把发布记录阶段写成失败态）。
# 所有回滚路径的顺序一致：前置检查（先本地、再远端）-> 停服并确认 stopped -> 回退代码并读回 HEAD -> 是否恢复数据库 -> 起服务 -> 核对；
# 每一步成功并核对之后才做下一步，确认不了就停下。可复制的命令（ssh / curl / node / pm2 / git）各占一行，判据与说明另起一行
function Write-RollbackGuide {
    param([string]$Reason = '', [string]$Hint = '', [string]$Kind = '')
    $target = "${ServerUser}@${ServerIP}"
    $dbDir = 'cd /d E:\Task_Pool\wbs-server'
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "  部署失败（换代码之后）：不自动回滚。以下是回滚步骤（逐条复制执行；每一步成功并核对之后才做下一步，确认不了就停下）" -ForegroundColor Red
    Write-Host "=============================================" -ForegroundColor Red
    if ($Reason -ne '') { Write-Host "  失败原因：$Reason" -ForegroundColor Yellow }
    if ($Hint -eq 'COMMIT_NULL') {
        Write-Host "  生产读不到提交号：远端 HEAD = 新提交 $($script:NewCommit) 只说明代码检出成功（核对命令见下一行）；" -ForegroundColor Yellow
        Write-Host "  ssh $target ""$RepoHeadCmd""" -ForegroundColor White
        Write-Host "  请继续核对 pm2 状态、/api/version 的版本与其余就绪失败项，再决定是修复提交号读取，还是按下面的回滚步骤处理。" -ForegroundColor Yellow
        Write-Host "  就绪检查在提交号这一项就停了：模块就绪与页面逐页核对都没有执行，请另外手动核对（命令各占一行，判据在后）。" -ForegroundColor Yellow
        Write-Host "      模块就绪（本机运行）：" -ForegroundColor Gray
        Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/health/ready" -ForegroundColor White
        Write-Host "      判据：ok 为 true，modules 非空且其中每一项的 ready 都是 true。" -ForegroundColor Gray
        Write-Host "      页面（本机运行；把 <page> 换成 wbs-server/public 下的页面文件名，主要页面各查一个）。先要求请求成功且 HTTP 状态为 200（页面内容存到临时文件）：" -ForegroundColor Gray
        Write-Host "      curl.exe --noproxy ""*"" -s -m 5 -o ""`$env:TEMP\sdh-page-check.html"" -w ""%{http_code}"" $BaseUrl/<page>.html" -ForegroundColor White
        Write-Host "      判据：输出恰为 200 才继续看下一条；其他任何输出（000、404、502 等）、没有输出或命令报错，都是「请求失败」，不是「页面没有 ?v=auto」，停下，不要放行。" -ForegroundColor Gray
        Write-Host "      紧接着（中间不要运行别的命令）读 curl 的退出码：" -ForegroundColor Gray
        Write-Host "      `$LASTEXITCODE" -ForegroundColor White
        Write-Host "      判据：必须输出 0。curl 先回 200、正文传输中断或超时时，状态码仍是 200 但退出码非 0，临时文件不完整，同样是「请求失败」，停下，不要放行。" -ForegroundColor Gray
        Write-Host "      再扫描页面内容里的字面 ?v=auto（只在上一条输出 200 之后）：" -ForegroundColor Gray
        Write-Host "      Select-String -SimpleMatch ""?v=auto"" -Path ""`$env:TEMP\sdh-page-check.html""" -ForegroundColor White
        Write-Host "      判据：200 之后这一条没有任何输出（查询成功但零命中）才算通过；有输出说明页面里还留着字面 ?v=auto，不能放行；这一条报错（找不到或读不了临时文件）同样是「请求失败」，不能放行。" -ForegroundColor Gray
    }
    if (Test-StartupBusyHint $Reason $Kind) {
        # 命令取自同一组常量（别名只为让下面的命令行与回滚七步里的命令行文本不重复）
        $busyStop = $Pm2StopCmd
        $busyStart = $Pm2StartCmd
        $busyNs = 'netstat -ano | findstr LISTENING | findstr :3000'
        Write-Host ""
        Write-Host "  先别急着回滚：这个失败形态（未就绪模块带 INIT_FAILED / SQLITE_*，或 restart_time 只比基准多 1）可能只是启动期的 SQLITE_BUSY。" -ForegroundColor Yellow
        Write-Host "  先只读查 pm2 日志里有无 SQLITE_BUSY（命令见下一行，只显示命中行，不会把整份日志打进会话记录）：" -ForegroundColor Yellow
        Write-Host "      ssh $target ""pm2 logs task-pool --nostream --lines 500 --timestamp | findstr SQLITE_BUSY""" -ForegroundColor White
        Write-Host "      判据：有输出 = 日志里有 SQLITE_BUSY；没有任何输出 = 没有，直接走下面的回滚七步。" -ForegroundColor Gray
        Write-Host "      判据：命中行的时间戳必须晚于本次 start（发布记录里 started 阶段的 at，查看命令见回滚 7/7 末尾）；更早的 SQLITE_BUSY 是旧进程留下的，不算，按「没有」处理。" -ForegroundColor Gray
        Write-Host "  若有 SQLITE_BUSY：可人工 stop + start 同一份新代码（不动代码、不动数据库），再重跑 ready-check（命令各占一行，上一条成功并核对之后才做下一条）：" -ForegroundColor Yellow
        Write-Host "      ssh $target ""$busyStop""" -ForegroundColor White
        Write-Host "      判据：用下一行确认名为 task-pool 的只有一项且为 stopped，不是就停下。" -ForegroundColor Gray
        Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White
        Write-Host "      再确认 3000 端口已释放（pm2 已 stopped 不等于端口已释放；命令见下一行）：" -ForegroundColor Gray
        Write-ListenerCheck
        Write-Host "      判据：判据一、判据二都通过（查询成功且 3000 零 LISTENING）才能 start；查询失败或有监听者，停下，不要 start。" -ForegroundColor Gray
        Write-Host "      ssh $target ""$busyStart""" -ForegroundColor White
        Write-Host "      node ""$ReadyJs"" --base-url $BaseUrl --expect-commit $($script:NewCommit) --expect-version $($script:NewVersion) --pages-from-commit $($script:NewCommit) --repo ""$($script:RepoRoot)""" -ForegroundColor White
        Write-Host "      判据：最后一行是 READY_OK 才算恢复；仍失败就再走下面的回滚七步。" -ForegroundColor Gray
        Write-Host "  READY_OK 之后还要再核对三件事，都通过才算恢复（发布记录保持 ready_failed 不会自动改，第 9 步「拉回本地」也没有执行）：" -ForegroundColor Yellow
        Write-Host "      1) pm2 的进程就是 3000 的监听者（两条命令各占一行）：" -ForegroundColor Gray
        Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White
        Write-Host "      ssh $target ""$busyNs""" -ForegroundColor White
        Write-Host "      判据：netstat 里端口恰为 3000 的 LISTENING 行（:30000 之类不算）末尾的 pid 只有一个，且等于 pm2 pid task-pool 的输出。" -ForegroundColor Gray
        Write-Host "      2) 重启计数不再增长（间隔 10 秒读两次 pm2 ls）：" -ForegroundColor Gray
        Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White
        Write-Host "      Start-Sleep 10" -ForegroundColor White
        Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White
        Write-Host "      判据：task-pool 为 online，两次读到的 ↺（重启次数）列相同。" -ForegroundColor Gray
        if ($script:BackupPath) {
            $bkLocalDir = 'E:\数据开发与治理规范手册\生产数据库备份'
            $bkScpSrc = '/' + ($script:BackupPath -replace '\\', '/')
            $bkLeaf = Split-Path $script:BackupPath -Leaf
            Write-Host "      3) 补拉本次备份到本地（第 9 步没有执行；先拉到 .partial，核对大小之后再改名为正式名；命令见下一行，本机运行）：" -ForegroundColor Gray
            Write-Host "      scp ${ServerUser}@${ServerIP}:$bkScpSrc ${bkLocalDir}\$bkLeaf.partial" -ForegroundColor White
            Write-Host "      远端备份大小的只读查询（命令见下一行）：" -ForegroundColor Gray
            Write-Host "      ssh $target ""for %I in ($($script:BackupPath)) do @echo %~zI""" -ForegroundColor White
            Write-Host "      判据：拉取命令退出码 0，且上一条输出的数字等于本地 .partial 的字节数，一致才改名为正式名；不一致就重拉，不要改名。" -ForegroundColor Gray
        } else {
            Write-Host "      3) 本次没有备份路径，不需要补拉备份。" -ForegroundColor Gray
        }
    }
    Write-Host ""
    Write-Host "[回滚 1/7] 前置检查（先本地）" -ForegroundColor Cyan
    Write-Host "[回滚 2/7] 前置检查（再远端）" -ForegroundColor Cyan
    Write-PreChecks
    Write-Host ""
    Write-Host "[回滚 3/7] 停服并确认 stopped（新服务可能还在线，先停再动代码和库）" -ForegroundColor Cyan
    Write-Host "      ssh $target ""$Pm2StopCmd""" -ForegroundColor White
    Write-Host "      确认命令（只看 pid 与状态，不拉 pm2 的完整环境变量）：" -ForegroundColor Gray
    Write-Host "      ssh $target ""pm2 pid task-pool""" -ForegroundColor White
    Write-Host "      ssh $target ""pm2 ls""" -ForegroundColor White
    Write-Host "      判据：pm2 ls 里名为 task-pool 的只有一项，状态列必须是 stopped；pm2 pid task-pool 的输出必须是 0 或没有输出（stopped 的进程没有 pid）。" -ForegroundColor Gray
    Write-Host "      不是 stopped、找不到或不止一项、pid 是非 0 的数字、命令失败：停下，不要做后面的步骤。" -ForegroundColor Yellow
    Write-Host "      再确认 3000 端口已释放：pm2 已 stopped 不等于端口已释放，脱离 pm2 的孤儿进程可能还占着 3000（命令见下一行，只读）：" -ForegroundColor Gray
    Write-ListenerCheck
    Write-Host "      判据：判据一、判据二都通过（查询成功且 3000 零 LISTENING）才能进入回滚 4/7；有监听者或查询失败：停止人工流程，不要做回滚 4/7、5/7、6/7（不换代码、不恢复数据库、不起服务），按 memory feedback_pm2_orphan_listener_recovery 处置孤儿监听。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[回滚 4/7] 回退代码到部署前实际运行的提交 rollbackTarget = $($script:PrevCommit)" -ForegroundColor Cyan
    Write-Host "      ssh $target ""cd /d E:\Task_Pool && git reset --hard $($script:PrevCommit)""" -ForegroundColor White
    Write-Host "      读回远端 HEAD：" -ForegroundColor Gray
    Write-Host "      ssh $target ""$RepoHeadCmd""" -ForegroundColor White
    Write-Host "      判据：必须等于 $($script:PrevCommit)，不等就停下。" -ForegroundColor Gray
    Write-Host ""
    Write-Host "[回滚 5/7] 是否恢复数据库（人工判断；此时服务是停着的）" -ForegroundColor Cyan
    $schema = Get-SchemaChanges
    if (-not $schema.Ok) {
        Write-Host "      无法在本机计算 $($script:PrevCommit) 到 $($script:NewCommit) 的差异（$($schema.Error)）；请人工核对：" -ForegroundColor Yellow
        Write-Host "      git diff $($script:PrevCommit) $($script:NewCommit) -- wbs-server" -ForegroundColor White
    } elseif ($schema.Files.Count -eq 0) {
        Write-Host "      未在新增行里发现常见 DDL 关键字（CREATE TABLE / ALTER TABLE / DROP TABLE / DROP COLUMN / RENAME；wbs-server/scripts/verify-*、test-*、*.md、docs/ 下的文件不计）。" -ForegroundColor Yellow
        Write-Host "      这不能证明数据库兼容：请人工核对本次的迁移（含数据回填 / UPDATE、拼接生成的 DDL、wbs-server/scripts/ 下的迁移脚本）与旧代码对当前库的兼容性，再决定是否恢复备份。" -ForegroundColor Yellow
    } else {
        Write-Host "      在新增行里发现 DDL 关键字（只是人工排查线索，不是结论），涉及文件：" -ForegroundColor Yellow
        foreach ($f in $schema.Files) { Write-Host "        $f" -ForegroundColor Yellow }
        Write-Host "      请人工核对这些迁移与旧代码对当前库的兼容性，再决定是否恢复备份（只加表 / 加列时旧代码有时可继续使用当前库；有删除、改名或数据迁移时通常要恢复）。" -ForegroundColor Yellow
    }
    Write-Host "      决定不恢复数据库：直接做第 6 步。决定恢复：先做下面的恢复命令（恢复之前不要起服务）。" -ForegroundColor Gray
    if ($script:BackupPath) {
        Write-Host "      本次备份：$($script:BackupPath)。恢复命令（逐条；上一步成功并核对之后才执行下一条，任一步失败立即停下）：" -ForegroundColor Gray
        Write-Host "      a) 当前库改名留档：" -ForegroundColor Gray
        Write-Host "      ssh $target ""$dbDir && ren task_pool.db task_pool.db.before_restore_$($script:Id)""" -ForegroundColor White
        Write-Host "      b) 日志文件（存在才改名）：" -ForegroundColor Gray
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-wal ren task_pool.db-wal task_pool.db-wal.before_restore_$($script:Id)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-shm ren task_pool.db-shm task_pool.db-shm.before_restore_$($script:Id)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-journal ren task_pool.db-journal task_pool.db-journal.before_restore_$($script:Id)""" -ForegroundColor White
        Write-Host "      c) 逐个核对改名成功（每条输出 EXISTS 或 MISSING）：" -ForegroundColor Gray
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db (echo EXISTS) else (echo MISSING)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-wal (echo EXISTS) else (echo MISSING)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-shm (echo EXISTS) else (echo MISSING)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db-journal (echo EXISTS) else (echo MISSING)""" -ForegroundColor White
        Write-Host "      ssh $target ""$dbDir && if exist task_pool.db.before_restore_$($script:Id) (echo EXISTS) else (echo MISSING)""" -ForegroundColor White
        Write-Host "      判据：上面前四条（task_pool.db、-wal、-shm、-journal）都必须是 MISSING，最后一条（本次改名留档）必须是 EXISTS；" -ForegroundColor Gray
        Write-Host "      原来存在的日志文件改名后，对应的 *.before_restore_$($script:Id) 也应存在。允许其他备份与历史留档存在，不要用 dir task_pool.db* 去判断。任一条不符就停下。" -ForegroundColor Gray
        Write-Host "      d) 复制备份为 task_pool.db：" -ForegroundColor Gray
        Write-Host "      ssh $target ""copy $($script:BackupPath) E:\Task_Pool\wbs-server\task_pool.db""" -ForegroundColor White
        Write-Host "      e) 核对复制成功：" -ForegroundColor Gray
        Write-Host "      ssh $target ""dir E:\Task_Pool\wbs-server\task_pool.db $($script:BackupPath)""" -ForegroundColor White
        Write-Host "      判据：两个文件都存在，且大小等于备份文件的大小（两行大小一致），不等就停下。" -ForegroundColor Gray
    } else {
        Write-Host "      本次没有备份路径（备份阶段之前就失败了），无法恢复数据库。" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "[回滚 6/7] 起服务（上一步都成功并核对之后）" -ForegroundColor Cyan
    Write-Host "      ssh $target ""$Pm2StartCmd""" -ForegroundColor White
    Write-Host ""
    Write-Host "[回滚 7/7] 核对与发布记录" -ForegroundColor Cyan
    Write-VerifyAfterStart
    Write-Host "      发布记录路径：$($script:RecordFile)    当前阶段：$($script:Stage)" -ForegroundColor White
    $recDirArg = ''
    if ($script:DryRun) { $recDirArg = ' --dir "' + $script:RecordDir + '"' }
    Write-Host "      查看发布记录：" -ForegroundColor Gray
    Write-Host "      node ""$RecordJs"" show --id $($script:Id)$recDirArg" -ForegroundColor White
}

# 第 2 步之后、换代码之前的中止：写失败态，生产未动
function Stop-BeforeStop([string]$Why, [string]$Note = '') {
    Write-Host "  [ERROR] $Why" -ForegroundColor Red
    Write-Host "  生产服务未动（尚未停服、未换代码）。" -ForegroundColor Yellow
    Set-Stage -Stage 'failed' -Result 'failed' -Note $Note
    Add-Route "中止（停服前）：$Why"
    Exit-Deploy 1
}

# 第 2 步中的中止（还没有发布记录）
function Stop-Early([string]$Why) {
    Write-Host "  [ERROR] $Why" -ForegroundColor Red
    Write-Host "  生产未动。" -ForegroundColor Yellow
    Add-Route "中止（第 0-2 步，无发布记录）：$Why"
    Exit-Deploy 1
}

# ================================================================ 开始
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  SSH Deploy to $ServerIP$(if ($script:DryRun) { '   [DRYRUN]' })" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ================================================================ STEP 0 本机准备（只读）
Write-Step '0/9' '本机准备（只读）'
# 仓库根 = 脚本所在检出（脚本在 <根>\scripts\ 下），不看进程当前目录或 $PWD：
# Invoke-Local 起的子进程不设 WorkingDirectory 时取 .NET 进程当前目录，PowerShell 的 Set-Location 不改它，会取到另一个仓库的 main
$RepoRootCandidate = Split-Path -Parent $PSScriptRoot
$top = Invoke-Local -FileName 'git' -ArgList @('-C', $RepoRootCandidate, 'rev-parse', '--show-toplevel')
if (-not (Test-Ok $top) -or $top.Stdout.Trim() -eq '') { Stop-Early "脚本所在目录 $RepoRootCandidate 不是 git 仓库（git -C … rev-parse --show-toplevel 失败：$(Get-ResultNote $top)）。" }
$topNorm = [System.IO.Path]::GetFullPath($top.Stdout.Trim().Replace('/', '\')).TrimEnd('\')
$candNorm = [System.IO.Path]::GetFullPath($RepoRootCandidate).TrimEnd('\')
if ($topNorm -ne $candNorm) { Stop-Early "脚本所在目录 $candNorm 不是 git 仓库的顶层（git 报告顶层是 $topNorm）；脚本必须位于 <仓库根>\scripts\ 下。" }
$script:RepoRoot = $candNorm
Write-Info "仓库根     = $($script:RepoRoot)（取脚本自身位置）"
foreach ($f in @($BackupJs, $RecordJs, $ReadyJs)) {
    if (-not (Test-Path -LiteralPath $f)) { Stop-Early "缺少部署辅助脚本：$f" }
}
$nc = Invoke-Git -ArgList @('rev-parse', '--verify', 'refs/heads/main')
if (-not (Test-Ok $nc) -or $nc.Stdout.Trim() -notmatch '^[0-9a-f]{40}$') { Stop-Early "读不到 main 的提交号（git rev-parse main）：$(Get-ResultNote $nc)" }
$script:NewCommit = $nc.Stdout.Trim()
$pj = Invoke-Git -ArgList @('show', "$($script:NewCommit):wbs-server/package.json")
if (-not (Test-Ok $pj)) { Stop-Early "读不到 $($script:NewCommit) 里的 wbs-server/package.json：$(Get-ResultNote $pj)" }
try {
    $script:NewVersion = [string](ConvertFrom-Json -InputObject $pj.Stdout).version
} catch {
    Stop-Early 'wbs-server/package.json 不是合法 JSON'
}
if ($script:NewVersion -notmatch '^\d+\.\d+\.\d+$') { Stop-Early "package.json 的 version 不是 x.y.z：$($script:NewVersion)" }
$script:Id = Get-Date -Format 'yyyyMMdd_HHmmss'
if ($script:DryRun) {
    $script:RecordDir = Join-Path $env:TEMP ('sdh-deploy-dryrun-' + $script:Id + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
Write-Info "NewCommit  = $($script:NewCommit)"
Write-Info "NewVersion = $($script:NewVersion)"
Write-Info "Id         = $($script:Id)"
if ($script:DryRun) { Write-Info "发布记录目录（临时，不写控制根）= $($script:RecordDir)" 'Magenta' }
Add-Route "0 本机准备：NewCommit=$($script:NewCommit) NewVersion=$($script:NewVersion)"
Write-Host ""

# ================================================================ STEP 1 推送
Write-Step '1/9' 'Push to production'
if ($script:DryRun) {
    Write-DryLine '将执行：git push production main'
    if (-not $SkipPushCheck) {
        $lr = Invoke-Git -ArgList @('ls-remote', 'production', 'refs/heads/main') -TimeoutSec 120
        if (Test-Ok $lr) {
            Write-DryLine "（只读信息）production 的 main 现在是：$((Get-LastLine $lr.Stdout) -split '\s+' | Select-Object -First 1)；推送后应为 $($script:NewCommit)"
        } else {
            Write-DryLine "（只读信息）git ls-remote production 失败：$(Get-ResultNote $lr)"
        }
    } else {
        Write-DryLine '（-SkipPushCheck）跳过 git ls-remote production'
    }
    Write-Info "推送超时上限 $($script:PushTimeoutSec) 秒（-PushTimeoutSec，缺省 1800）"
    if ($DryRunFailAt -eq 'push_landed') {
        # 模拟：git push 超时，但只读核对时远端 main 已等于 NewCommit（推送其实已生效）；喂给与真实路径相同的 Stop-PushNotConfirmed
        Write-DryLine '（-DryRunFailAt push_landed）模拟：git push 超时，远端 main 已等于 NewCommit'
        Stop-PushNotConfirmed (New-FakeProc -TimedOut $true) (New-FakeProc -Stdout ("$($script:NewCommit)`trefs/heads/main`n"))
    }
    if ($DryRunFailAt -eq 'push_failed') {
        Write-DryLine '（-DryRunFailAt push_failed）模拟：git push 失败（退出码 1），远端 main 不等于 NewCommit'
        Stop-PushNotConfirmed (New-FakeProc -ExitCode 1) (New-FakeProc -Stdout ("$('0' * 40)`trefs/heads/main`n"))
    }
    Add-Route '1 推送：只打印 git push production main'
} else {
    Write-Info "推送超时上限 $($script:PushTimeoutSec) 秒（-PushTimeoutSec，缺省 1800）"
    $push = Invoke-Git -ArgList @('push', 'production', 'main') -TimeoutSec $script:PushTimeoutSec
    if (-not (Test-Ok $push)) {
        # push 超时或失败：不能直接当作没推上去（git push 可能卡在远端 gc --auto 上，引用其实已更新）。只读核对一次远端引用，再中止
        $lrFail = Invoke-Git -ArgList @('ls-remote', 'production', 'refs/heads/main') -TimeoutSec 120
        Stop-PushNotConfirmed $push $lrFail
    }
    $lr = Invoke-Git -ArgList @('ls-remote', 'production', 'refs/heads/main') -TimeoutSec 120
    $remoteMain = ''
    if (Test-Ok $lr) { $remoteMain = ((Get-LastLine $lr.Stdout) -split '\s+' | Select-Object -First 1) }
    if ($remoteMain -ne $script:NewCommit) { Stop-Early "推送后 git ls-remote production refs/heads/main = '$remoteMain'，不等于 NewCommit $($script:NewCommit)" }
    Write-Info '[OK] Pushed，远端 main 等于 NewCommit' 'Green'
    Add-Route '1 推送：完成并核对'
}
Write-Host ""

# ================================================================ STEP 2 读远端现状（只读）
Write-Step '2/9' '读远端现状（只读）'
if ($script:RemoteStateMode) {
    Write-Info "使用假远端现状文件：$RemoteStateFile（不连生产）" 'Magenta'
    $st = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $RemoteStateFile).Path, [System.Text.Encoding]::UTF8))
    $RepoHead = [string]$st.repoHead
    $Tracked = [string]$st.trackedChanges
    $Pm2Status = [string]$st.pm2Status
    $Pm2Count = 1
    if ($null -ne $st.PSObject.Properties['pm2Count']) { $Pm2Count = [int]$st.pm2Count }
    $script:RunVersion = [string]$st.runVersion
    $script:RunCommit = $null
    if ($null -ne $st.runCommit -and [string]$st.runCommit -ne '') { $script:RunCommit = [string]$st.runCommit }
    $RepoHeadVersion = $null
    if ($null -ne $st.PSObject.Properties['repoHeadVersion'] -and $null -ne $st.repoHeadVersion) { $RepoHeadVersion = [string]$st.repoHeadVersion }
    $NodeVersion = 'v0.0.0-dryrun'
    if ($null -ne $st.PSObject.Properties['nodeVersion'] -and $null -ne $st.nodeVersion) { $NodeVersion = [string]$st.nodeVersion }
    # 孤儿监听核对的输入：pm2 记录的 pid + netstat -ano 的原文（缺字段 = 读不到，硬门会拒绝）
    $Pm2Pid = $null
    if ($null -ne $st.PSObject.Properties['pm2Pid'] -and $null -ne $st.pm2Pid) { $Pm2Pid = $st.pm2Pid }
    $Listen = [pscustomobject]@{ Ok = $false; Pids = @(); Why = '假远端现状文件没有 netstat 字段' }
    if ($null -ne $st.PSObject.Properties['netstat'] -and $null -ne $st.netstat) { $Listen = Get-ListeningPids ([string]$st.netstat) $AppPort }
} else {
    $h = Read-RemoteHead
    if ($null -eq $h) { Stop-Early '读不到远端 HEAD（git -C E:\Task_Pool rev-parse HEAD 失败或输出不是 40 位提交号）' }
    $RepoHead = $h
    # --no-optional-locks：只读查询不刷新 index、不取 index.lock（否则会干扰生产上的其他 git 操作）
    $sr = Invoke-RemoteRead -Command 'git --no-optional-locks -C E:\Task_Pool status --porcelain --untracked-files=no' -TimeoutSec 60
    if (-not (Test-Ok $sr)) { Stop-Early "读不到远端工作区状态：$(Get-ResultNote $sr)" }
    $Tracked = $sr.Stdout.Trim()
    $pt = Read-RemotePm2Task
    if (-not $pt.Ok) { Stop-Early "读不到 pm2 状态：$($pt.Error)" }
    $Pm2Status = [string]$pt.Status
    $Pm2Count = $pt.Count
    $Pm2Pid = $pt.Pid
    $Listen = Read-RemoteListeners
    $rv = Get-RunningVersion
    if (-not $rv.Ok) { Stop-Early "读不到运行中的版本（本机 curl /api/version）：$($rv.Error)" }
    $script:RunVersion = $rv.Version
    $script:RunCommit = $rv.Commit
    $nv = Invoke-RemoteRead -Command 'node -v' -TimeoutSec 30
    if (-not (Test-Ok $nv)) { Stop-Early "远端 node 不可用（node -v 失败）：$(Get-ResultNote $nv)" }
    $NodeVersion = $nv.Stdout.Trim()
    $RepoHeadVersion = $null
    if ($null -eq $script:RunCommit) {
        $pk = Invoke-RemoteRead -Command "git -C E:\Task_Pool show ${RepoHead}:wbs-server/package.json" -TimeoutSec 60
        if (-not (Test-Ok $pk)) { Stop-Early "读不到远端 HEAD 上的 wbs-server/package.json：$(Get-ResultNote $pk)" }
        try { $RepoHeadVersion = [string](ConvertFrom-Json -InputObject $pk.Stdout).version } catch { Stop-Early '远端 package.json 不是合法 JSON' }
    }
}
Write-Info "RepoHead   = $RepoHead"
Write-Info "RunVersion = $($script:RunVersion)    RunCommit = $(if ($null -eq $script:RunCommit) { '(无，旧版本没有 commit 字段)' } else { $script:RunCommit })"
Write-Info "task-pool  = $Pm2Status (进程数 $Pm2Count)    node = $NodeVersion"
Write-Info "pm2 pid    = $(if ($null -eq $Pm2Pid) { '(读不到)' } else { $Pm2Pid })    3000 的 LISTENING pid = $(if (-not $Listen.Ok) { '(读不到)' } elseif (@($Listen.Pids).Count -eq 0) { '(无)' } else { @($Listen.Pids) -join ',' })"
if ($RepoHead -notmatch '^[0-9a-f]{40}$') { Stop-Early "远端 HEAD 不是 40 位提交号：$RepoHead" }
if ($Tracked -ne '') { Stop-Early "远端 E:\Task_Pool 有已跟踪文件的改动（硬重置会毁掉它们），请先人工处理：$(($Tracked -split "`r?`n")[0])" }
if ($Pm2Count -ne 1) { Stop-Early "pm2 里名为 task-pool 的应用数量是 $Pm2Count，不是 1" }
if ($Pm2Status -ne 'online') { Stop-Early "pm2 里 task-pool 不是 online（当前 $Pm2Status），不在此状态下部署" }
# 硬门（只读，此时尚未停服）：pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid（0.0.0.0 与 [::] 两栈都算），否则疑似孤儿监听
$own2 = Test-Pm2OwnsPort $Pm2Pid $Listen
if (-not $own2.Ok) { Stop-Early $own2.Why }
if ($NodeVersion -notmatch '^v\d+\.\d+') { Stop-Early "远端 node -v 输出异常：$NodeVersion" }
# 部署前实际运行的提交 PrevCommit
if ($null -ne $script:RunCommit) {
    if ($script:RunCommit -ne $RepoHead) { Stop-Early "运行中的提交 $($script:RunCommit) 与远端仓库 HEAD $RepoHead 不一致（运行中的代码与仓库不一致，需人工核对）" }
} else {
    if ([string]::IsNullOrEmpty($RepoHeadVersion) -or $script:RunVersion -ne $RepoHeadVersion) {
        Stop-Early "旧版本没有 commit 字段，且运行版本 $($script:RunVersion) 不等于远端 HEAD 上的版本 '$RepoHeadVersion'（需人工核对）"
    }
}
$script:PrevCommit = $RepoHead
Write-Info "PrevCommit（部署前实际运行的提交）= $($script:PrevCommit)" 'Green'

$initArgs = @('init', '--id', $script:Id, '--prev-commit', $script:PrevCommit, '--new-commit', $script:NewCommit, '--new-version', $script:NewVersion)
if ($script:RunVersion -match '^\d+\.\d+\.\d+$') { $initArgs += @('--prev-running-version', $script:RunVersion) }
if ($null -ne $script:RunCommit) { $initArgs += @('--prev-running-commit', $script:RunCommit) }
$ini = Invoke-Record $initArgs
if (-not $ini.Ok) { Stop-Early "发布记录 init 失败：$($ini.Line)" }
$script:RecordFile = $ini.Line
$script:Stage = 'prepared'
Write-Info "发布记录：$($script:RecordFile)"

# 就绪检查参数预检（不发请求）：参数 / 提交 / 页面清单的问题在动生产之前暴露
$readyArgs = @($ReadyJs, '--base-url', $BaseUrl, '--expect-commit', $script:NewCommit, '--expect-version', $script:NewVersion, '--pages-from-commit', $script:NewCommit, '--timeout-sec', ([string]$ReadyTimeoutSec), '--repo', $script:RepoRoot)
$pre = Invoke-Local -FileName 'node' -ArgList ($readyArgs + @('--check-args')) -TimeoutSec 90 -WorkDir $script:RepoRoot
$preP = Read-Protocol -Res $pre -Prefixes @('READY_ARGS_OK')
if ($null -eq $preP) { Stop-BeforeStop "就绪检查参数预检没过（ready-check.js --check-args）：$(Get-LastLine $pre.Stdout)" 'READY_ARGS' }
Write-Info "[OK] 就绪检查参数预检通过（页面数 $($preP.Json.pages)）" 'Green'

# 新提交必须自带就绪接口路由与 /api/version 的 commit 字段（git grep 退出码：0 找到，1 没找到，其他 = 出错；出错也按没通过处理）
foreach ($lit in @($ReadyRouteLiteral, $CommitFieldLiteral)) {
    $gg = Invoke-Git -ArgList @('grep', '-q', '-F', $lit, $script:NewCommit, '--', 'wbs-server/server.js') -TimeoutSec 60
    if (-not (Test-Ok $gg)) {
        Stop-BeforeStop "新提交不含就绪接口 / commit 字段（$($script:NewCommit) 的 wbs-server/server.js 里找不到 $lit；$(Get-ResultNote $gg)）。本脚本只能部署 #106 S1a、S3a 之后的代码；更早的代码请用旧脚本或人工部署。" 'NO_READY_API'
    }
}
Write-Info '[OK] 新提交的 server.js 含就绪接口路由与 commit 字段' 'Green'
Add-Route "2 读远端现状：通过；PrevCommit=$($script:PrevCommit)；发布记录已 init"
Write-Host ""

# ================================================================ STEP 3 上传备份脚本
Write-Step '3/9' '上传备份脚本到生产临时目录并预取新提交'
$RemoteBackupJs = "$RemoteTmpDir\backup-db-$($script:Id).js"
$localSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupJs).Hash.ToLower()
Write-Info "本机 backup-db.js SHA256 = $localSha"
$mk = Invoke-RemoteWrite -Command "if not exist $RemoteTmpDir mkdir $RemoteTmpDir" -TimeoutSec 60
if (-not $mk.DryRun -and -not (Test-Ok $mk)) { Stop-BeforeStop "远端建临时目录失败：$(Get-ResultNote $mk)" 'UPLOAD_MKDIR' }
$scpRemote = "${ServerUser}@${ServerIP}:/E:/Task_Pool_deploy_tmp/backup-db-$($script:Id).js"
$up = Invoke-RemoteWrite -TransferArgs @('backup-db.js', $scpRemote) -TimeoutSec 120 -WorkDir $DeployDir
if (-not $up.DryRun -and -not (Test-Ok $up)) { Stop-BeforeStop "scp 上传备份脚本失败：$(Get-ResultNote $up)" 'UPLOAD_SCP' }
if ($script:DryRun) {
    Write-DryLine "将核对远端 SHA256（ssh ${ServerUser}@${ServerIP} certutil -hashfile $RemoteBackupJs SHA256）必须等于 $localSha"
} else {
    $hs = Invoke-RemoteRead -Command "certutil -hashfile $RemoteBackupJs SHA256" -TimeoutSec 60
    $remoteSha = ''
    if (Test-Ok $hs) {
        foreach ($l in ($hs.Stdout -split "`r?`n")) {
            $c = ($l -replace '\s', '').ToLower()
            if ($c -match '^[0-9a-f]{64}$') { $remoteSha = $c; break }
        }
    }
    if ($remoteSha -ne $localSha) { Stop-BeforeStop "远端备份脚本 SHA256（'$remoteSha'）不等于本机（$localSha）" 'UPLOAD_HASH' }
    Write-Info '[OK] 远端 SHA256 与本机一致' 'Green'
}
Set-Stage -Stage 'uploaded'
# 预取新提交（停服之前做：fetch 只往 .git 里加对象，不动工作区；把「停服后 fetch 失败、服务一直停着」的窗口缩到只剩 reset）
$fres = Invoke-RemoteWrite -Command $FetchCmd -TimeoutSec 300
if (-not $fres.DryRun -and -not (Test-Ok $fres)) { Stop-BeforeStop "远端 git fetch production 失败：$(Get-ResultNote $fres)" 'FETCH_FAILED' }
if ($script:DryRun) {
    Write-DryLine "将核对远端已有新提交：git -C E:\Task_Pool cat-file -t $($script:NewCommit) 必须输出 commit"
} else {
    $ct = Invoke-RemoteRead -Command "git -C E:\Task_Pool cat-file -t $($script:NewCommit)" -TimeoutSec 30
    if (-not (Test-Ok $ct) -or $ct.Stdout.Trim() -ne 'commit') { Stop-BeforeStop "fetch 之后远端仓库里没有新提交 $($script:NewCommit)（cat-file -t：$($ct.Stdout.Trim()) $(Get-ResultNote $ct)）" 'FETCH_NO_OBJECT' }
    Write-Info '[OK] 远端已有新提交对象' 'Green'
}
Add-Route '3 上传备份脚本并预取新提交：完成（阶段 uploaded）'
Write-Host ""

# ================================================================ STEP 4 停服
Write-Step '4/9' '停服（pm2 stop task-pool）'
$stopRes = Invoke-RemoteWrite -Command $Pm2StopCmd -TimeoutSec 90
$stopOk = $false
$stopWhy = ''
if ($stopRes.DryRun) {
    Write-DryLine '将再读 pm2 jlist，确认 task-pool 为 stopped'
    Write-DryLine '将再读 netstat -ano，确认停服之后 3000 没有任何 LISTENING'
    # DryRun：假的 netstat 输出（stop_listen 时 3000 上还有监听者）经与真实路径相同的 Get-ListeningPids / Test-PortReleased 判定
    $fakeNs4 = New-FakeNetstat @()
    if ($DryRunFailAt -eq 'stop_listen') {
        Write-DryLine '（-DryRunFailAt stop_listen）模拟：pm2 已 stopped，但 3000 上仍有 LISTENING'
        $fakeNs4 = New-FakeNetstat @(9999)
    }
    $portFree4 = Test-PortReleased (Get-ListeningPids $fakeNs4 $AppPort)
    if ($portFree4.Ok) { $stopOk = $true } else { $stopWhy = $portFree4.Why }
} elseif (Test-Ok $stopRes) {
    for ($i = 0; $i -lt 6 -and -not $stopOk; $i++) {
        $pt = Read-RemotePm2Task
        if ($pt.Ok -and $pt.Count -eq 1 -and $pt.Status -eq 'stopped') { $stopOk = $true } else { Start-Sleep -Seconds 5 }
    }
    if ($stopOk) {
        # pm2 已确认 stopped 之后，3000 必须零 LISTENING（刚停的进程释放端口可能慢一点：只读重读最多 3 次，间隔 3 秒）
        $portFree = $null
        for ($j = 0; $j -lt 3; $j++) {
            $portFree = Test-PortReleased (Read-RemoteListeners)
            if ($portFree.Ok) { break }
            if ($j -lt 2) { Start-Sleep -Seconds 3 }
        }
        if (-not $portFree.Ok) { $stopOk = $false; $stopWhy = $portFree.Why }
    }
}
if (-not $stopOk) {
    # 记录里的 note 区分两种失败：pm2 已 stopped 但 3000 没确认释放 = PORT_NOT_RELEASED；其余（stop 命令失败 / pm2 没确认 stopped）= STOP_UNCONFIRMED
    Set-Stage -Stage 'failed' -Result 'failed' -Note $(if ($stopWhy -ne '') { 'PORT_NOT_RELEASED' } else { 'STOP_UNCONFIRMED' })
    Write-Host "  [ERROR] 停服命令失败或确认不过（$(if ($stopWhy -ne '') { $stopWhy } else { Get-ResultNote $stopRes })）。不自动做任何事。" -ForegroundColor Red
    if ($stopWhy -ne '') {
        Write-Host "  pm2 已确认 stopped，但没能确认 3000 已释放：可能是脱离 pm2 的孤儿进程占着端口（按 memory feedback_pm2_orphan_listener_recovery 处置），也可能只是 netstat 没读到。3000 上还有监听者时不要起服务（只读核对命令与判据见下面「再查 3000 端口」一节）。" -ForegroundColor Yellow
    }
    Write-Host "  当前状态：服务可能仍在跑，也可能已停；代码未动；备份未做。本机 ssh 超时退出时，远端的 pm2 stop 可能还在执行，所以先做两项前置检查，再看 pm2 状态：" -ForegroundColor Yellow
    Write-PreChecks
    Write-Host ""
    Write-Host "  确认远端没有还在执行的 pm2 stop（正则写成 Process[I]d、p[m]2、sto[p]，区分大小写，不会匹配 wmic / findstr 自己的命令行）：" -ForegroundColor Gray
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""wmic process get processid,commandline | findstr /r /c:Process[I]d /c:p[m]2.*sto[p]""" -ForegroundColor White
    Write-Host "      判据：输出第一行必须是表头（含 CommandLine 与 ProcessId），说明查询成功；表头之外没有任何行才继续；有行就是还有在途的 pm2 stop，等它结束后再查一次。" -ForegroundColor Gray
    Write-Host "      判据：看不到表头（查询失败、WMI 出错或远端没有 wmic）就停下，登录远端 PowerShell 运行下一行；输出最后一行是 CIM_OK 且其上没有进程行才继续，是 CIM_FAILED 就人工核实：" -ForegroundColor Gray
    $q = 'try { Get-CimInstance Win32_Process -Filter "Name=''node.exe''" -ErrorAction Stop | Where-Object { $_.CommandLine -match ''pm2.*stop'' } | Select-Object ProcessId,CommandLine; ''CIM_OK'' } catch { ''CIM_FAILED'' }'
    Write-Host ("      " + $q) -ForegroundColor White
    Write-Host "  然后间隔 10 秒读两次 pm2 状态，两次一致才按下面的判据处理：" -ForegroundColor Gray
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White
    Write-Host "      Start-Sleep 10" -ForegroundColor White
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White
    Write-Host "  再查 3000 端口有没有监听者（命令见下一行）：" -ForegroundColor Gray
    Write-ListenerCheck
    Write-Host "      判据：名为 task-pool 的只有一项，且为 stopped，并且上一条 netstat 查询成功、3000 零 LISTENING（判据一、判据二都通过）→ 可以起服务（命令见后）。" -ForegroundColor Gray
    Write-Host "      判据：名为 task-pool 的只有一项，且为 online → 服务仍在跑，不要起服务，直接结束本次部署。" -ForegroundColor Gray
    Write-Host "      判据：读不到状态、两次不一致、名为 task-pool 的不止一项、为 errored 等其他状态、3000 上仍有 LISTENING（pm2 已 stopped 也一样，多半是孤儿监听）、或 netstat 查询失败（没有 TCP 行不等于零监听）→ 不要起服务，人工核实。" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  确认无残留、task-pool 为 stopped 且 3000 零 LISTENING 后，如需起服务用下一行：" -ForegroundColor Yellow
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White
    Add-Route '4 停服：失败或确认不过 -> 不自动做任何事（阶段 failed）'
    Exit-Deploy 1
}
Set-Stage -Stage 'stopped'
Add-Route '4 停服：完成（阶段 stopped）'
Write-Host ""

# ================================================================ STEP 5 备份
Write-Step '5/9' '备份 task_pool.db（远端 backup-db 脚本）'
$PlannedBackup = "E:\Task_Pool\wbs-server\task_pool.db.backup_$($script:Id)"
$backupCmd = "node $RemoteBackupJs --sqlite3 $RemoteSqlite3 --db $RemoteDb --out $PlannedBackup"
$bres = Invoke-RemoteWrite -Command $backupCmd -TimeoutSec 900
if ($bres.DryRun) {
    # DryRun：构造假的子进程结果（stdout、退出码、超时、启动错误），经与真实路径相同的 Resolve-BackupOutcome 判定
    if ($DryRunFailAt -eq 'backup_noline') {
        Write-DryLine '（-DryRunFailAt backup_noline）模拟：ssh 失败（退出码 255，stdout 为空）'
        $bres = New-FakeProc -Stdout '' -ExitCode 255
    } elseif ($DryRunFailAt -eq 'backup') {
        Write-DryLine '（-DryRunFailAt backup）模拟：备份脚本打出 BACKUP_FAIL 协议行（退出码 1）'
        $failObj = [ordered]@{ code = 'BK_VACUUM_FAILED'; stage = 'vacuum'; message = '(模拟)'; out = $PlannedBackup; partial = [ordered]@{ path = "$PlannedBackup.partial"; exists = $true }; sourceJournal = [ordered]@{ journal = $false; wal = $false } }
        $bres = New-FakeProc -Stdout ("BACKUP_FAIL " + (ConvertTo-Json -InputObject $failObj -Compress -Depth 5) + "`n") -ExitCode 1
    } else {
        Write-DryLine '（假定备份成功：备份脚本打出 BACKUP_OK 协议行，备份路径取计划路径）'
        $okObj = [ordered]@{ out = $PlannedBackup; bytes = 0 }
        $bres = New-FakeProc -Stdout ("BACKUP_OK " + (ConvertTo-Json -InputObject $okObj -Compress -Depth 5) + "`n") -ExitCode 0
    }
}
$bo = Resolve-BackupOutcome $bres

if ($bo.Outcome -eq 'FAIL') {
    # 明确收到 BACKUP_FAIL：代码没动，自动 pm2 start 原服务（唯一的自动动作），再只读核对
    $bj = $bo.Json
    Write-Host "  [ERROR] 备份失败：$($bj.code)（阶段 $($bj.stage)）$($bj.message)" -ForegroundColor Red
    Write-Host "      .partial：$($bj.partial.path)    是否残留：$(Format-Tri $bj.partial.exists)" -ForegroundColor Yellow
    if ($bj.code -eq 'BK_PUBLISH_FAILED' -and $bj.out -is [string] -and $bj.out -ne '') {
        Write-Host "      注意：发布这一步出错，但备份其实已发布到 $($bj.out)（请人工核对该文件；不要用 glob 挑「最新」）。" -ForegroundColor Yellow
    }
    if ($null -ne $bj.sourceJournal) {
        Write-Host "      源库旁 -journal：$(Format-Tri $bj.sourceJournal.journal)    -wal：$(Format-Tri $bj.sourceJournal.wal)" -ForegroundColor Yellow
        if (($bj.sourceJournal.journal -is [bool] -and $bj.sourceJournal.journal) -or ($bj.sourceJournal.wal -is [bool] -and $bj.sourceJournal.wal)) {
            Write-Host "      有热日志：原服务起来后会自动回滚，确认后可重试部署。" -ForegroundColor Yellow
        }
    }
    Set-Stage -Stage 'backup_failed' -Note $(if ($bj.code -is [string]) { $bj.code } else { '' })
    Write-Info '自动 pm2 start 原服务（代码未动，等于撤销本次自己的 stop）' 'Yellow'
    $oldStartRes = Invoke-RemoteWrite -Command $Pm2StartCmd -TimeoutSec 90
    if ($oldStartRes.DryRun) {
        Write-DryLine '将只读核对（最多 60 秒）：task-pool 为 online；远端 HEAD 仍为 PrevCommit；/api/version 的 version 等于 RunVersion'
        Add-Route "5 备份：BACKUP_FAIL（模拟）-> 阶段 backup_failed -> 自动 pm2 start task-pool -> 只读核对 -> 通过 restarted_old / 不过 restart_unverified（result=failed）"
        Exit-Deploy 1
    }
    # pm2 start 本身没成功 -> 不空转核对，直接 restart_unverified；成功才核对，总截止 60 秒（每次读的超时取剩余时间，上限 15 秒）
    $verified = $false
    if (Test-Ok $oldStartRes) {
        $deadline = (Get-Date).AddSeconds(60)
        do {
            $rem = [int][math]::Max(1, [math]::Min(15, ($deadline - (Get-Date)).TotalSeconds))
            $pt = Read-RemotePm2Task -TimeoutSec $rem
            $hd = Read-RemoteHead -TimeoutSec $rem
            $rv2 = Get-RunningVersion
            # pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid（孤儿监听时 pm2 自己的进程在 EADDRINUSE 崩溃循环，online 也不算起回来）
            $own5 = Test-Pm2OwnsPort $pt.Pid (Read-RemoteListeners -TimeoutSec $rem)
            if ($pt.Ok -and $pt.Count -eq 1 -and $pt.Status -eq 'online' -and $hd -eq $script:PrevCommit -and $rv2.Ok -and $rv2.Version -eq $script:RunVersion -and $own5.Ok) { $verified = $true } else { Start-Sleep -Seconds 5 }
        } while (-not $verified -and (Get-Date) -lt $deadline)
    }
    if ($verified) {
        Set-Stage -Stage 'restarted_old' -Result 'failed'
        Write-Host "  备份失败，已起回原服务（代码未动）。核对通过：task-pool online、远端 HEAD = $($script:PrevCommit)、version = $($script:RunVersion)。" -ForegroundColor Yellow
        Write-Host "  备份脚本错误码：$($bj.code)；.partial 路径：$($bj.partial.path)" -ForegroundColor Yellow
        Add-Route '5 备份：BACKUP_FAIL -> 已起回原服务并核对（restarted_old）'
    } else {
        Set-Stage -Stage 'restart_unverified' -Result 'failed'
        Write-Host "  [ERROR] 已发 pm2 start，但 60 秒内核对没过。不再自动做任何事。现状与人工核对命令：" -ForegroundColor Red
        Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 ls""" -ForegroundColor White
        Write-Host "      判据：名为 task-pool 的只有一项，且为 online。" -ForegroundColor Gray
        Write-Host "      ssh ${ServerUser}@${ServerIP} ""$RepoHeadCmd""" -ForegroundColor White
        Write-Host "      判据：应为 $($script:PrevCommit)。" -ForegroundColor Gray
        Write-Host "      curl.exe --noproxy ""*"" -s -m 5 $BaseUrl/api/version" -ForegroundColor White
        Write-Host "      判据：version 应为 $($script:RunVersion)。" -ForegroundColor Gray
        Write-Host "      ssh ${ServerUser}@${ServerIP} ""pm2 pid task-pool""" -ForegroundColor White
        Write-Host "      ssh ${ServerUser}@${ServerIP} ""netstat -ano | findstr LISTENING | findstr :3000""" -ForegroundColor White
        Write-Host "      判据：netstat 里端口恰为 3000 的 LISTENING 行（0.0.0.0:3000 与 [::]:3000 都算，:30000 之类不算）末尾的 pid 只能有一个，且等于 pm2 pid task-pool 的输出；不等就是孤儿监听，按 memory feedback_pm2_orphan_listener_recovery 处置。" -ForegroundColor Gray
        Write-Host "      备份脚本错误码：$($bj.code)；.partial 路径：$($bj.partial.path)" -ForegroundColor Yellow
        Write-PreChecks
        Add-Route '5 备份：BACKUP_FAIL -> 已发 pm2 start 但核对不过（restart_unverified）'
    }
    Exit-Deploy 1
}

if ($bo.Outcome -eq 'UNKNOWN') {
    # 没收到协议行：状态未知（ssh 失败 / 超时 / 输出被截断），不自动起服务
    Set-Stage -Stage 'failed' -Result 'failed' -Note 'BACKUP_NO_PROTOCOL'
    Write-Host "  [ERROR] 没收到备份协议行（ssh 失败、超时或输出被截断）：备份是否完成、服务是否在跑都未知。不自动起服务。" -ForegroundColor Red
    Write-Host "  代码未动。请先做下面两项前置检查，确认备份进程已不在、再决定是否手工起服务：" -ForegroundColor Yellow
    Write-PreChecks
    Write-Host ""
    Write-Host "  确认无残留后，人工起回原服务（命令见下一行）：" -ForegroundColor Yellow
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""$Pm2StartCmd""" -ForegroundColor White
    Write-Host "  可能残留的备份文件（不要用 glob 挑「最新」）：$PlannedBackup 及其 .partial" -ForegroundColor Gray
    Add-Route '5 备份：没收到协议行（状态未知）-> 不自动起服务（阶段 failed）-> 打印前置检查与人工 pm2 start task-pool 命令'
    Exit-Deploy 1
}

$script:BackupPath = [string]$bo.Json.out
# 备份协议行里的 bytes 是远端备份文件的大小（发布后取不到时为 null）：第 9 步下载之后核对大小时复用；不是正整数就当没有，第 9 步再只读查一次
$bkBytesProp = $bo.Json.PSObject.Properties['bytes']
if ($null -ne $bkBytesProp -and $null -ne $bkBytesProp.Value -and $bkBytesProp.Value -isnot [bool] -and $bkBytesProp.Value -isnot [string]) {
    $bkBytesParsed = 0L
    if ([long]::TryParse([string]$bkBytesProp.Value, [ref]$bkBytesParsed) -and $bkBytesParsed -gt 0) { $script:BackupBytes = $bkBytesParsed }
}
Set-Stage -Stage 'backed_up' -Backup $script:BackupPath
Write-Info "[OK] 备份完成：$($script:BackupPath)" 'Green'
Add-Route '5 备份：BACKUP_OK（阶段 backed_up）'
Write-Host ""

# ================================================================ STEP 6 换代码
Write-Step '6/9' '换代码（按提交号硬重置；fetch 已在第 3 步做完）'
$codeOk = $false
$codeWhy = ''
# 远端 cmd 用 && 短路串联（任一步失败则停）。整串作为单个参数交给 ssh，由远端 cmd.exe 拆分
$resetCmd = "cd /d E:\Task_Pool && git reset --hard $($script:NewCommit)"
$cres = Invoke-RemoteWrite -Command $resetCmd -TimeoutSec 300
if ($cres.DryRun) {
    if ($DryRunFailAt -eq 'code') {
        Write-DryLine '（-DryRunFailAt code）模拟：换代码失败'
        $codeWhy = '(模拟) 换代码失败'
    } else {
        Write-DryLine "将读远端 HEAD，必须等于 NewCommit $($script:NewCommit)"
        $codeOk = $true
    }
} elseif (Test-Ok $cres) {
    # 读回失败重读最多 3 次（间隔 3 秒）再判，免得一次 ssh 抖动就引导回滚
    $nh = $null
    for ($i = 0; $i -lt 3 -and $nh -ne $script:NewCommit; $i++) {
        if ($i -gt 0) { Start-Sleep -Seconds 3 }
        $nh = Read-RemoteHead
    }
    if ($nh -eq $script:NewCommit) { $codeOk = $true } else { $codeWhy = "换代码后远端 HEAD = '$nh'，不等于 NewCommit" }
} else {
    $codeWhy = "git reset 失败：$(Get-ResultNote $cres)"
}
if (-not $codeOk) {
    Set-Stage -Stage 'failed' -Result 'failed' -Note 'CODE_UPDATE_FAILED'
    Add-Route '6 换代码：失败 -> 阶段 failed -> 打印回滚步骤（不自动回滚）'
    Write-RollbackGuide -Reason $codeWhy
    Exit-Deploy 1
}
Set-Stage -Stage 'code_updated'
Add-Route '6 换代码：完成（阶段 code_updated）'
Write-Host ""

# ================================================================ STEP 7 起服务
Write-Step '7/9' '起服务（pm2 start task-pool）'
$startOk = $false
$startWhy = ''
$baseRestart = $null
$sres = Invoke-RemoteWrite -Command $Pm2StartCmd -TimeoutSec 90
if ($sres.DryRun) {
    if ($DryRunFailAt -eq 'start') {
        Write-DryLine '（-DryRunFailAt start）模拟：pm2 start 失败'
        $startWhy = '(模拟) pm2 start 失败'
    } else {
        Write-DryLine '将读 pm2 jlist 里 task-pool 的 restart_time 作基准（防就绪后的重启循环）'
        $startOk = $true
        $baseRestart = 0
    }
} elseif (Test-Ok $sres) {
    # 读 pm2 状态失败重读最多 3 次（间隔 3 秒）再判
    for ($i = 0; $i -lt 3 -and -not $startOk; $i++) {
        if ($i -gt 0) { Start-Sleep -Seconds 3 }
        $pt = Read-RemotePm2Task
        if ($pt.Ok -and $pt.Count -eq 1 -and $null -ne $pt.RestartTime) { $startOk = $true; $baseRestart = [int]$pt.RestartTime } else { $startWhy = "pm2 start 之后读不到 task-pool 的 restart_time 基准：$($pt.Error)" }
    }
} else {
    $startWhy = "pm2 start 失败：$(Get-ResultNote $sres)"
}
if (-not $startOk) {
    Set-Stage -Stage 'failed' -Result 'failed' -Note 'START_FAILED'
    Add-Route '7 起服务：失败 -> 阶段 failed -> 打印回滚步骤（不自动回滚）'
    Write-RollbackGuide -Reason $startWhy
    Exit-Deploy 1
}
Set-Stage -Stage 'started'
Add-Route '7 起服务：完成（阶段 started）'
Write-Host ""

# ================================================================ STEP 8 就绪检查
Write-Step '8/9' "就绪检查（ready-check.js，期限 $ReadyTimeoutSec 秒）"
$readyOk = $false
$readyWhy = ''
$readyHint = ''
$readyKind = ''
if ($script:DryRun) {
    # DryRun：构造假的子进程结果，经与真实路径相同的 Resolve-ReadyOutcome 判定
    Write-DryLine ("将执行（本机）：node " + ($readyArgs -join ' '))
    if ($DryRunFailAt -eq 'ready_init_failed') {
        Write-DryLine '（-DryRunFailAt ready_init_failed）模拟：READY_FAIL，未就绪模块的 code 是 INIT_FAILED（退出码 1）'
        $rres = New-FakeProc -Stdout ("READY_FAIL " + (ConvertTo-Json -InputObject ([ordered]@{ code = 'READY_TIMEOUT'; lastObserved = [ordered]@{ stage = 'ready'; unready = @([ordered]@{ module = 'sys_iteration'; code = 'INIT_FAILED' }) } }) -Compress -Depth 6) + "`n") -ExitCode 1
    } elseif ($DryRunFailAt -eq 'ready') {
        Write-DryLine '（-DryRunFailAt ready）模拟：ready-check 打出 READY_FAIL（退出码 1）'
        $rres = New-FakeProc -Stdout ("READY_FAIL " + (ConvertTo-Json -InputObject ([ordered]@{ code = 'READY_TIMEOUT'; elapsedMs = 0; rounds = 1 }) -Compress) + "`n") -ExitCode 1
    } elseif ($DryRunFailAt -eq 'ready_commit_null') {
        Write-DryLine '（-DryRunFailAt ready_commit_null）模拟：READY_FAIL，顶层 hint=COMMIT_NULL（退出码 1）'
        $rres = New-FakeProc -Stdout ("READY_FAIL " + (ConvertTo-Json -InputObject ([ordered]@{ code = 'READY_TIMEOUT'; hint = 'COMMIT_NULL' }) -Compress) + "`n") -ExitCode 1
    } else {
        if ($DryRunFailAt -eq 'restart_loop') { Write-DryLine '（-DryRunFailAt restart_loop）模拟：READY_OK，但 READY_OK 后 task-pool 的 restart_time 比基准增长' }
        $rres = New-FakeProc -Stdout ("READY_OK " + (ConvertTo-Json -InputObject ([ordered]@{ elapsedMs = 0; rounds = 1 }) -Compress) + "`n") -ExitCode 0
    }
} else {
    $outerTimeout = $ReadyTimeoutSec + 5 + 30
    $rres = Invoke-Local -FileName 'node' -ArgList ($readyArgs) -TimeoutSec $outerTimeout -WorkDir $script:RepoRoot
}
$ro = Resolve-ReadyOutcome $rres
if ($ro.Outcome -ne 'OK') {
    $readyWhy = $ro.Why
    $readyHint = $ro.Hint
} else {
    # READY_OK 之后再读一次 pm2：唯一的 task-pool 必须 online，且 restart_time 没有增长（新进程没有反复崩溃重启）；真实与 DryRun 都经 Test-FinalPm2State
    if ($script:DryRun) {
        Write-DryLine 'READY_OK 之后将再读一次 pm2 jlist，要求唯一的 task-pool 为 online 且 restart_time 未增长，否则判 ready_failed'
        $st2 = 'online'
        $rt2 = $baseRestart
        if ($DryRunFailAt -eq 'restart_loop') { $rt2 = $baseRestart + 1 }
        if ($DryRunFailAt -eq 'ready_stopped') { $st2 = 'stopped' }
        if ($DryRunFailAt -eq 'ready_errored') { $st2 = 'errored' }
        $pt2 = [pscustomobject]@{ Ok = $true; Count = 1; Status = $st2; RestartTime = $rt2; Pid = $Pm2Pid; Error = $null }
    } else {
        $pt2 = Read-RemotePm2Task
    }
    $fin = Test-FinalPm2State $pt2 $baseRestart
    if ($fin.Ok) {
        # 终检再加一道硬门：pm2 记录的 pid 必须等于 3000 端口唯一的 LISTENING pid（DryRun 用假 netstat 经同一个解析函数；ready_orphan 时监听者不是 pm2 的进程）
        if ($script:DryRun) {
            Write-DryLine 'READY_OK 之后将再读 netstat -ano，要求 3000 唯一的 LISTENING pid 等于 pm2 记录的 pid，否则判 ready_failed'
            $fakePid8 = [int]$Pm2Pid
            if ($DryRunFailAt -eq 'ready_orphan') { $fakePid8 = $fakePid8 + 1 }
            $ls8 = Get-ListeningPids (New-FakeNetstat @($fakePid8)) $AppPort
        } else {
            $ls8 = Read-RemoteListeners
        }
        $own8 = Test-Pm2OwnsPort $pt2.Pid $ls8
        if ($own8.Ok) { $readyOk = $true } else { $readyWhy = $own8.Why }
    } else {
        $readyWhy = $fin.Why
        $readyKind = [string]$fin.Kind
    }
}
if (-not $readyOk) {
    Set-Stage -Stage 'ready_failed' -Result 'failed' -Note $(if ($readyHint -ne '') { $readyHint } else { 'READY_FAILED' })
    Write-Host "  [ERROR] 就绪检查没过：$readyWhy" -ForegroundColor Red
    Add-Route "8 就绪检查：失败（$readyHint）-> 阶段 ready_failed -> 打印回滚步骤（不自动回滚）"
    Write-RollbackGuide -Reason $readyWhy -Hint $readyHint -Kind $readyKind
    Exit-Deploy 1
}
Set-Stage -Stage 'ready'
Write-Info '[OK] 就绪检查通过' 'Green'
Add-Route '8 就绪检查：通过（阶段 ready）'
Write-Host ""

# ================================================================ STEP 9 拉回本地（失败只 warn）
Write-Step '9/9' 'Pull production db backup to local（保留最近 10 份）'
$pullAttach = ''
# 库备份先下载到 <正式名>.partial，成功并核对大小（与远端备份一致）之后才改名为正式名，改名之后才轮转；
# 失败时 .partial 原样保留（不改名、不轮转、不自动删），正式名正则（Get-FormalDbBackups）本来就不匹配 .partial，所以残留不会计入保留份数
$localBackupDir = 'E:\数据开发与治理规范手册\生产数据库备份'
$localDst = $null
$localPartial = $null
try {
    # scp 远端 Windows 路径必须用正斜杠：/E:/Task_Pool/wbs-server/task_pool.db.backup_xxx
    # 先于下面可能抛错的 Split-Path / Join-Path 赋值：catch 里的补拉提示要用它
    $scpSrcPath = '/' + ($script:BackupPath -replace '\\', '/')
    $backupFileName = Split-Path $script:BackupPath -Leaf
    $localDst = Join-Path $localBackupDir $backupFileName
    $localPartial = "$localDst.partial"
    if (-not $script:DryRun -and -not (Test-Path -LiteralPath $localBackupDir)) {
        New-Item -ItemType Directory -Path $localBackupDir -Force | Out-Null
        Write-Info "[INFO] Created local backup dir: $localBackupDir"
    }
    if (-not $script:DryRun) {
        if (Test-Path -LiteralPath $localDst) { throw "正式备份文件已存在，不覆盖: $localDst" }
        if (Test-Path -LiteralPath $localPartial) { throw "上次残留的 .partial 已存在，不覆盖也不自动删，请人工处理: $localPartial" }
    }
    $pull1 = Invoke-RemoteWrite -TransferArgs @("${ServerUser}@${ServerIP}:$scpSrcPath", $localPartial) -TimeoutSec 900
    if (-not $pull1.DryRun) {
        if (-not (Test-Ok $pull1)) { throw "scp failed: $(Get-ResultNote $pull1)" }
        if (-not (Test-Path -LiteralPath $localPartial)) { throw "scp 成功但本地 .partial 不存在: $localPartial" }
        # 核对大小：期望值复用第 5 步备份协议行里的 bytes；没有就只读查一次远端文件大小（cmd 的 for 变量修饰符 %~z，与语言环境无关）；任一边读不到都不改名
        $expectBytes = $script:BackupBytes
        if ($null -eq $expectBytes) {
            $szRes = Invoke-RemoteRead -Command "for %I in ($($script:BackupPath)) do @echo %~zI" -TimeoutSec 60
            if ((Test-Ok $szRes) -and ($szRes.Stdout.Trim() -match '^[0-9]+$')) { $expectBytes = [long]$szRes.Stdout.Trim() }
        }
        $sizeOk = Test-BackupSizeMatch $expectBytes (Get-Item -LiteralPath $localPartial).Length
        if (-not $sizeOk.Ok) { throw $sizeOk.Why }
        Move-Item -LiteralPath $localPartial -Destination $localDst -ErrorAction Stop
        $localPartial = $null
        $sizeKB = [math]::Round((Get-Item -LiteralPath $localDst).Length / 1KB, 1)
        Write-Info "[OK] Saved: $localDst ($sizeKB KB)" 'Green'
        # 保留最近 10 份正式名（task_pool.db.backup_YYYYMMDD_HHmmss），按文件名时间戳排序；手动命名的备份（如 …_pre_itasset_import）既不计数也永不删除
        $toDelete = Get-DbBackupsToDelete $localBackupDir 10
        if ($toDelete.Count -gt 0) {
            foreach ($f in $toDelete) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
            Write-Info "[INFO] Cleaned $($toDelete.Count) old backup(s), kept latest 10"
        }
    } else {
        Write-DryLine "拉完并核对大小（与远端备份一致）之后才把 $localPartial 改名为 $localDst，改名之后才轮转；失败时 .partial 保留，不改名、不轮转"
        # DryRun：只读预览轮转清单（拉回本次备份之后本地会有 保留的 9 份 + 本次新备份 = 10 份，所以现有正式名里超出最新 9 份的将被删）；目录不存在时清单为空
        $rotPreview = @(Get-DbBackupsToDelete $localBackupDir 9)
        Write-DryLine "（只读预览）拉回本次备份之后按保留 10 份轮转：现有正式名备份里将删除 $($rotPreview.Count) 个$(if ($rotPreview.Count -gt 0) { '：' + (($rotPreview | ForEach-Object { $_.Name }) -join '、') })；手动命名的备份不计数也不删"
    }
} catch {
    Write-Host "  [WARN] Local backup pull failed (deploy 主流程未受影响): $_" -ForegroundColor Yellow
    if ($null -ne $localPartial -and (Test-Path -LiteralPath $localPartial)) {
        Write-Host "  [HINT] 失败留下的临时文件已保留（没有改名为正式名，也没有轮转；不计入保留份数，不自动删除），请人工查看后再处理，精确路径：$localPartial" -ForegroundColor Yellow
    }
    $hintLeaf = if ($backupFileName) { $backupFileName } else { "task_pool.db.backup_$($script:Id)" }
    Write-Host "  [HINT] 手动补拉（先拉到 .partial，核对大小之后再改名为正式名；命令见下一行，本机运行）：" -ForegroundColor Gray
    Write-Host "      scp ${ServerUser}@${ServerIP}:$scpSrcPath ${localBackupDir}\$hintLeaf.partial" -ForegroundColor White
    Write-Host "  [HINT] 远端备份大小的只读查询（输出的数字必须等于本地 .partial 的字节数，一致才改名；不一致就重拉）：" -ForegroundColor Gray
    Write-Host "      ssh ${ServerUser}@${ServerIP} ""for %I in ($($script:BackupPath)) do @echo %~zI""" -ForegroundColor White
}
Write-Host ""

# 拉 uploads/collab/ 整个目录：先拉到同级临时目录 collab_<Id>.partial，成功并核对之后才改名为正式快照 collab_<Id>；
# 拉完后删 _pending / _orphaned；保留最近 5 份只统计正式名（collab_yyyyMMdd_HHmmss），失败留下的 .partial 保留、提示、不计入、不自动删
# 为什么 scp -r 不直接排除子目录：scp 没有 --exclude（rsync 才有）；_pending/_orphaned 体积小，拉完后本地删更简单
Write-Step '9/9' 'Pull production collab attachments to local（保留最近 5 份）'
$localPartialDir = $null
try {
    $localCollabBaseDir = 'E:\数据开发与治理规范手册\生产协作附件备份'
    $localSnapshotDir = Join-Path $localCollabBaseDir "collab_$($script:Id)"
    $localPartialDir = Join-Path $localCollabBaseDir "collab_$($script:Id).partial"
    $remoteCollabPath = '/E:/Task_Pool/wbs-server/uploads/collab'
    $scpSrc = "${ServerUser}@${ServerIP}:$remoteCollabPath"
    if (-not $script:DryRun) {
        if (-not (Test-Path -LiteralPath $localCollabBaseDir)) {
            New-Item -ItemType Directory -Path $localCollabBaseDir -Force | Out-Null
            Write-Info "[INFO] Created local collab backup dir: $localCollabBaseDir"
        }
        if (Test-Path -LiteralPath $localSnapshotDir) { throw "正式快照目录已存在，不覆盖: $localSnapshotDir" }
        if (Test-Path -LiteralPath $localPartialDir) { throw "上次残留的 .partial 已存在，不覆盖也不自动删，请人工处理: $localPartialDir" }
        New-Item -ItemType Directory -Path $localPartialDir -Force | Out-Null
    }
    $pull2 = Invoke-RemoteWrite -TransferArgs @('-r', $scpSrc, $localPartialDir) -TimeoutSec 1800
    if ($pull2.DryRun) {
        Write-DryLine "拉完并核对之后将把 $localPartialDir 改名为 $localSnapshotDir（只有正式名计入保留份数）"
    } else {
        if (-not (Test-Ok $pull2)) { throw "scp -r failed: $(Get-ResultNote $pull2)" }
        # 拉完路径结构：$localPartialDir\collab\{rid}_xxx\, _pending\, _orphaned\
        $pulledCollabDir = Join-Path $localPartialDir 'collab'
        if (-not (Test-Path -LiteralPath $pulledCollabDir)) { throw "scp 成功但本地 collab 目录不存在: $pulledCollabDir" }
        foreach ($sub in @('_pending', '_orphaned')) {
            $subPath = Join-Path $pulledCollabDir $sub
            if (Test-Path -LiteralPath $subPath) {
                Remove-Item -LiteralPath $subPath -Recurse -Force -ErrorAction SilentlyContinue
                Write-Info "[INFO] Removed temp/orphan subdir: $sub"
            }
        }
        $subdirCount = (Get-ChildItem -Path $pulledCollabDir -Directory -ErrorAction SilentlyContinue).Count
        $totalBytes = (Get-ChildItem -Path $pulledCollabDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        $totalMB = if ($totalBytes) { [math]::Round($totalBytes / 1MB, 1) } else { 0 }
        # 核对通过（scp 成功、collab 目录在、统计得出）才发布为正式快照
        Move-Item -LiteralPath $localPartialDir -Destination $localSnapshotDir -ErrorAction Stop
        $localPartialDir = $null
        Write-Info "[OK] Saved: $localSnapshotDir ($subdirCount collab dirs, $totalMB MB)" 'Green'
        $pullAttach = $localSnapshotDir
        $allSnapshots = Get-FormalCollabSnapshots $localCollabBaseDir
        if ($allSnapshots.Count -gt 5) {
            $toDelete = $allSnapshots | Select-Object -Skip 5
            foreach ($d in $toDelete) { Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
            Write-Info "[INFO] Cleaned $($toDelete.Count) old snapshot(s), kept latest 5"
        }
    }
} catch {
    Write-Host "  [WARN] Local collab attachments pull failed (deploy 主流程未受影响): $_" -ForegroundColor Yellow
    if ($null -ne $localPartialDir -and (Test-Path -LiteralPath $localPartialDir)) {
        Write-Host "  [HINT] 失败留下的临时目录 $localPartialDir 已保留（不计入保留份数，不自动删除），请人工查看后再处理。" -ForegroundColor Yellow
    }
    Write-Host "  [HINT] 手动补拉（命令见下一行）：" -ForegroundColor Gray
    Write-Host "      scp -r ${ServerUser}@${ServerIP}:/E:/Task_Pool/wbs-server/uploads/collab ${localCollabBaseDir}\collab_$($script:Id).partial\" -ForegroundColor White
}
if ($pullAttach -ne '') { Set-Stage -Stage 'pulled' -Attachments $pullAttach } else { Set-Stage -Stage 'pulled' }
Set-Stage -Stage 'done' -Result 'ok'
Add-Route '9 拉回本地：完成或仅 warn（阶段 pulled -> done，result=ok）'

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Deploy Complete!$(if ($script:DryRun) { '   [DRYRUN：什么都没有发出]' })" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
$url = 'http://' + $ServerIP + ':3000'
Write-Host "  $url" -ForegroundColor Cyan
Write-Host "  发布记录：$($script:RecordFile)" -ForegroundColor Gray
Write-Host "  生产备份：$($script:BackupPath)" -ForegroundColor Gray
Write-Host "  远端临时备份脚本（部署后不删除）：$RemoteBackupJs" -ForegroundColor Gray
Write-Host ""
Exit-Deploy 0
