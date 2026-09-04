# Sync to GitHub Script — incremental snapshot to public mirror
# Called by: /deploy skill (step 10b) after production deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/sync-to-github.ps1 -CommitMessage "..."
#
# Flow:
#   0.  前置检查
#   1.  robocopy 源项目 → 镜像（同字节文件自动跳过）
#   2.  清除镜像中的非公开内容（具名黑名单块——第二道防线，含诊断信息）
#       + fail-closed 兜底扫（2026-08-28 #20 整改·唯一权威判定，跑在本步骤末尾）：
#       镜像内任一文件，唯一放行依据 = 「主仓 git 已跟踪该相对路径」∨「命中 $mirrorOnlyWhitelist」，
#       不满足即删除。天然覆盖二进制/整目录，不依赖任何一方的 .gitignore。
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
#
# ★ Fail-closed 兜底（2026-08-28，步骤 2 末尾）：$mirrorOnlyWhitelist 是唯一的镜像专属例外名单，
#   见函数 Invoke-FailClosedSweep 上方注释。测试入口：-FailClosedSweepOnly（配 -SourcePath/
#   -MirrorPath 指向临时目录、不需要 -CommitMessage，JSON 输出到 stdout）——
#   由 wbs-server/scripts/verify-sync-fail-closed.js 独立调用，真实 /deploy 流程不会传这两个开关。
#   · 判据显式绑定 main 分支树（`git ls-tree -r --name-only main`），不绑定当前 checkout 分支
#     ——本仓当前工作分支常年是 feature/legacy-archive 类长期分支，若判据跟当前分支走，会把
#     main 已跟踪、但当前分支未合并/已改名的真源文件误判"未跟踪"进而误删（已实测复现 12 个
#     真源文件误删）。core.quotepath=false 同样对 ls-tree 生效，保持 CJK 文件名不转义。
#   · 待删数 > 20（首跑预计 90+）默认 fail-fast、一个都不删，打印完整清单，需 -SweepForce 放行。
#   · 单个文件删除失败（异常或 Test-Path 复核发现残留）不再静默吞掉，整体 exit 1。
#   · 枚举跳过 ReparsePoint 目录（junction/符号链接）不跟进，防止经由链接逃出镜像根目录误删
#     外部真实文件。
#   · 2026-08-29 三收口批（S-20 尾巴微批，codex 76 号 M1/L1 处置）：main 至少含一个跟踪文件是
#     Get-SourceTrackedFileSet 的显式前置条件（本机实测 470 个，见函数内注释）；NUL 分隔路径
#     解析逻辑抽成独立函数 ConvertFrom-NulSeparatedGitOutput，新增 -FailClosedParseNulTestFile
#     测试出口供验证脚本脱离 git/真实文件系统限制注入换行/引号/反斜杠等特殊字符做真实解析回归。

param(
    # 2026-08-28 #20 整改：不再用 [Parameter(Mandatory=$true)] 属性——该属性在缺参数时会
    # 触发 PowerShell 交互式提示（阻塞无人值守/脚本化调用，含本文件自身的 -FailClosedSweepOnly
    # 测试入口）。改为下方"手动校验"区显式 fail-fast，语义等价且不会阻塞。
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
    [switch]$SkipNameAudit,

    # ── 以下两个开关仅供 wbs-server/scripts/verify-sync-fail-closed.js 独立调用测试，
    #    真实同步流程（/deploy）永远不会传它们 ──
    # 只跑 fail-closed 清除逻辑（Invoke-FailClosedSweep）并把结果以 JSON 打到 stdout 后立即
    # exit，不进入 git add/commit/push 主流程，也不要求 -CommitMessage。
    [switch]$FailClosedSweepOnly,
    # 配合 -FailClosedSweepOnly：让 Invoke-FailClosedSweep 的放行判定恒为真（相当于把
    # fail-closed 判定"注释掉"，退化回"什么都不清"的旧行为）。仅用于验证脚本的双向自证——
    # 证明"主测试里的删除断言，若真的没有 fail-closed 判定就会判红"。
    [switch]$FailClosedDisableForTest,
    # 配合 -FailClosedSweepOnly：让 Invoke-FailClosedSweep 对指定相对路径"假装跳过真实删除"，
    # 用于验证脚本测试"删后 Test-Path 复核发现残留即判失败"这条 fail-closed 路径——真实文件
    # 锁定在 Windows 下难以稳定复现（Remove-Item -Force 通常能穿透只读属性；持句柄测试对
    # 进程时序敏感、不稳定），故用测试桩覆盖该分支，语义等价。真实同步流程绝不传它。
    [string]$FailClosedSimulateResidualFor,

    # L1（codex 76 新增）：仅供 wbs-server/scripts/verify-sync-fail-closed.js 独立调用测试
    # ConvertFrom-NulSeparatedGitOutput 本身，脱离 git 调用与真实文件系统限制。传入一个文件路径，
    # 文件内容是模拟的 ls-tree -z 原始字节（NUL 分隔的路径记录，某些记录可能含真实换行/引号/
    # 反斜杠字符——这些字符真实文件系统上无法构造，见函数注释）。脚本读取该文件、还原成待测
    # 函数的输入形态，把解析结果 JSON 打到 stdout 后立即退出，不进入任何其余流程。真实同步流程
    # 绝不传它。
    [string]$FailClosedParseNulTestFile,

    # 2026-08-29 收口批新增：sweep 待删数超安全阀阈值（20）时默认 fail-fast、一个都不删，
    # 见 Invoke-FailClosedSweep 内"安全阀"注释。带此开关才放行执行删除——真实首跑（预计
    # 删 90+，历史六例漏网黑名单模式的累积残留）将由用户在场核对完整清单后显式传入。
    [switch]$SweepForce
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
    '示例开发J'   = '示例开发J'        # id=21 user，新增 2026-07-13
    '示例开发K' = '示例开发K'        # id=22 user，新增 2026-07-13
    '示例开发L' = '示例开发L'        # id=23 user，新增 2026-07-13
    '示例开发M' = '示例开发M'        # id=24 user，新增 2026-08-08（预检拦获后补）
    '示例用户C' = '示例用户C'        # id=25 user，新增（2026-08-26 v1.159.0 同步时预检 fail-fast 拦获后补）
    '示例管理员B' = '示例管理员B'      # id=26 admin，新增（2026-08-28 v1.164.0 同步时预检 fail-fast 拦获后补）
    '示例开发N'   = '示例开发N'        # id=27 user，新增（2026-09-04 v1.166.1 同步时预检 fail-fast 拦获后补）
    '示例开发O' = '示例开发O'        # id=28 user，新增（2026-09-04 v1.166.1 同步时预检 fail-fast 拦获后补）
    '示例管理员C' = '示例管理员C'      # id=29 admin，新增（2026-09-04 v1.166.1 同步时预检 fail-fast 拦获后补）
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
#  手机号清单按【生产备份 users 表】全量 19 个（codex 复审 M-1/M-4；2026-07-14 新增 id=21/22/23 补至 19）。
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
    '19900000017' = '19900000017'   # id=21 示例开发J username/phone
    '19900000018' = '19900000018'   # id=22 示例开发K username/phone
    '19900000019' = '19900000019'   # id=23 示例开发L username/phone
    '19900000020' = '19900000020'   # id=24 示例开发M username（新增 2026-08-08·⚠️ 原注释写「username/phone」有误：其 phone 是下一行那个不同号码，这个笔误正是下一行漏配的成因）
    '19900000021' = '19900000021'   # id=24 示例开发M phone（2026-08-19 v1.156.4 同步时预检 fail-fast 拦获后补·与上行 username 是两个不同号码）
    '19900000022' = '19900000022'   # id=25 示例用户C username 与 phone **同号**（已查库确认两列相等，故只需一条；2026-08-26 v1.159.0 同步时预检 fail-fast 拦获后补）
    '19900000023' = '19900000023'   # id=26 示例管理员B phone（其登录名非手机号、且已有专属残留扫描 pattern 兜底，无需另配·已查库确认；2026-08-28 v1.164.0 同步时预检 fail-fast 拦获后补·⚠️ 勿在任何注释写该登录名字面量——步骤 4 残留扫描会拦）
    '19900000024' = '19900000024'   # id=13 示例对接人 phone 列（本地库测试号·生产库 users 无此号〔备份 task_pool.db.backup_20260902_131321 只读查证〕；2026-09-02 v1.165.0 同步预检 fail-fast 拦获后补——预检审计的是 -SourcePath 所在库，本次源=发布 worktree 的本地库副本）
    '19900000025' = '19900000025'   # id=27 示例开发N username 与 phone **同号**（已查库确认两列相等，故只需一条；2026-09-04 v1.166.1 同步预检 fail-fast 拦获后补）
    '19900000026' = '19900000026'   # id=28 示例开发O username 与 phone **同号**（已查库确认两列相等，故只需一条；同上批）
    '19900000027' = '19900000027'   # id=29 示例管理员C phone（其登录名非手机号，形态同 id=26 那条，无需另配·已查库确认；同上批·⚠️ 勿在任何注释写该登录名字面量——步骤 4 残留扫描会拦）
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

# ════════════════════════════════════════════════════════════════════════════
#  Fail-closed 镜像内容过滤（2026-08-28 未了项 #20 整改）
#  ── 根因：步骤 2 曾是"黑名单逐文件/逐目录补条目"，6 例同根因漏网（_seed/_set-sys-notify
#     两脚本、_demo-notify-unify-manifest.json、__screenshots__/ 21 张 PNG 整目录、
#     test-screenshots/ 6 张 PNG 已推送后紧急摘除、three-r185+demo 文件）——黑名单必然再漏。
#  ── 新判定：镜像内任一文件，唯一放行依据 = 「主仓 git 已跟踪该相对路径」∨「命中下方白名单」。
#     不满足即删除。天然覆盖二进制（PNG/pyc 等）与整目录（判据是路径存在性，不做内容嗅探），
#     且不依赖 .gitignore（镜像仓有独立忽略规则，主仓 .gitignore 对镜像无效——本判据也不认它，
#     只认主仓 git 跟踪状态，避免同一类"gitignore 认知偏差"重演）。
#  ── 原有的具名黑名单块（templates/gen_notice.py/package.json/docs 若干目录/mcp-bms/
#     临时脚本前缀/unify-baseline/生产备份/docs 本地三目录）予以保留，作为"第二道防线"——
#     它们跑在前面，给已知风险类别一个更具体的提示信息；但最终是否留在镜像里，只看本区块
#     末尾跑的 fail-closed 扫描结果，不看黑名单是否"记得"删过。
# ════════════════════════════════════════════════════════════════════════════

# 镜像专属文件——源仓库没有、但镜像必须保留的极少数例外。新增前必须能说清
# "为什么这个文件应该公开、但又不该被主仓 git 跟踪"，并在注释里留证据来源。
$mirrorOnlyWhitelist = @(
    # 镜像仓自身的开源门面文件（LICENSE/.env.example 主仓从未有过；README.md/.gitignore
    # 主仓虽也跟踪同名路径但内容是镜像专属版本——那两个靠"路径在主仓已跟踪"天然放行，
    # 不需要进这张白名单，见步骤 1 注释 "镜像专属文件"）
    "LICENSE",
    ".env.example",
    # 2026-08-19 用户裁定保留（PROJECT_STATUS.md 未了项 #20 记录："Export_DateFilter_Demo.html
    # 用户裁保留=低风险残余仍未跟踪会随镜像"）——主仓已删除该 demo 文件，但公开镜像侧显式决定
    # 留着（低风险、非同类的 three-r185/Sys_Iteration_*_Demo.html 已随主仓删除自然清除）。
    "wbs-server/public/Export_DateFilter_Demo.html"
)

# 读取【main 分支】已跟踪文件清单（相对路径、正斜杠，UTF-8 正确解码——core.quotepath=false 防中文
# 文件名被 git 转成八进制转义串，[Console]::OutputEncoding 已在文件顶部设为 UTF8）。
#
# ⚠️ 2026-08-29 收口批修复：显式读 main 分支树（`git ls-tree -r --name-only main`），不再用
#    `git ls-files`（后者读的是【当前 checkout 分支】的索引/工作树）。真实事故根因：本仓当前
#    工作分支常年是 feature/legacy-archive 之类的长期分支，若判据绑定当前 checkout 分支，会把
#    main 已跟踪、但当前分支尚未合并/已改名的真源文件误判为"未跟踪"从而从公开镜像误删——
#    已实测复现 12 个 main 已跟踪真源文件被误删。改用 ls-tree 读 main 分支树后，无论当前
#    checkout 哪个分支，判据恒定绑定 main，与"公开镜像应体现 main 的公开内容"这一意图对齐。
#    -c core.quotepath=false 对 ls-tree 同样生效（保持既有 CJK 文件名不转义行为）。
# L1（codex 76 新增）：把「ls-tree -z 输出 → NUL 分隔路径列表」的解析逻辑抽成独立函数，使其可以
# 脱离 git 调用与真实文件系统限制被单测——NTFS 禁止文件名含换行/引号等字符（0x00-0x1F 及
# `< > : " / \ | ? *`），而这些恰好是没有 `-z` 时 git 会做 C 风格转义/引号包裹的触发字符集合，
# 本机因此无法用真实文件端到端构造回归 fixture（见下方 Get-SourceTrackedFileSet 注释）。抽出
# 后，验证脚本可以直接构造模拟的 ls-tree -z 原始字节（含换行/引号/反斜杠的路径）喂给这个函数，
# 不经过 git、不落真实文件，断言路径被完整还原——真正覆盖"解析器行为"而非仅"源码字面量"。
# 行为与原内联代码零差异（纯抽取，未改动任何一行判断逻辑）。
#   -RawOut：镜像 `& git ... -z` 的原生命令捕获结果——可能是单个 System.String（多数情况），
#     也可能因为字节流中含真实换行符被 PowerShell 拆成字符串数组（每个数组元素对应一"行"）；
#     两种输入形态都要能正确处理，故先 `-join "`n"` 复原成单一字符串，再按 NUL 切分。
function ConvertFrom-NulSeparatedGitOutput {
    param($RawOut)
    $tracked = @()
    if ($RawOut) {
        $joined = ($RawOut -join "`n")
        $tracked = $joined -split "`0" | Where-Object { $_ -ne '' }
    }
    return ,$tracked
}

function Get-SourceTrackedFileSet {
    param([Parameter(Mandatory=$true)][string]$SrcPath)

    # 2026-08-29 二收口批（codex 74 H2）：判据的输入清单本身必须先证明"可信"，安全阀（待删数阈值）
    # 只是附加保护，不能替代这道校验——main 分支不存在/ls-tree 失败若不拦，得到的可能是空清单，
    # 待删数恰好 ≤20 时安全阀不会触发，真源文件被当"未跟踪"直接误删（codex 74 H2 原话）。
    #
    # H2①：先用 rev-parse --verify 显式确认 main 分支树存在。⚠️ `^{tree}` 里的花括号在 PowerShell
    # 里必须加引号——不加引号时 `{tree}` 会被 PowerShell 分词器当脚本块起始符处理，参数传给 git 的
    # 内容就不是字面的 `refs/heads/main^{tree}`（本机实测复现：不加引号时，即使 main 真实存在，
    # rev-parse 依然报 "fatal: Needed a single revision"）。
    $verifyErrTmp = [System.IO.Path]::GetTempFileName()
    try {
        & git -C $SrcPath rev-parse --verify "refs/heads/main^{tree}" 2> $verifyErrTmp | Out-Null
        $verifyExit = $LASTEXITCODE
        $verifyErrText = (Get-Content -LiteralPath $verifyErrTmp -Raw -ErrorAction SilentlyContinue)
    } finally {
        Remove-Item -LiteralPath $verifyErrTmp -Force -ErrorAction SilentlyContinue
    }
    if ($verifyExit -ne 0) {
        Write-Host "  [ERROR] main 分支引用不存在或不可验证（$SrcPath），fail-closed 拒绝以不可信清单继续：" -ForegroundColor Red
        if ($verifyErrText) { Write-Host "    $verifyErrText" -ForegroundColor Red }
        exit 1
    }

    # H2②：ls-tree 本体。刻意不用 `2>&1`——PS 5.1 下原生命令的 stderr 经 `2>&1` 合并进管道会被
    # 逐行包成 NativeCommandError（污染输出、且即便 exe 退出码 0 也会让 `$?`=false，难以和真实失败
    # 区分）。改用 PowerShell 自带的 `2> file` 重定向，把 stderr 单独落一个临时文件，仅用
    # `$LASTEXITCODE` 判定成败，stderr 文件内容只作诊断展示（本机实测已验证此写法能正确捕获
    # git 失败时的错误文本，且不影响 stdout 正常解析）。
    # L1（codex 74 L1）：`-z` 让路径以 NUL 分隔输出，而非按行分隔——避免路径中出现换行/引号/反斜杠
    # 等字符时被 C 风格转义或按行误拆导致已跟踪文件被误判为未跟踪。`-z` 模式下 git 本就不做
    # quote 转义（不依赖 core.quotepath），CJK 文件名同样原样输出（本机实测已验证）。
    $lsTreeErrTmp = [System.IO.Path]::GetTempFileName()
    try {
        $rawOut = & git -C $SrcPath -c core.quotepath=false ls-tree -r -z --name-only main 2> $lsTreeErrTmp
        $lsTreeExit = $LASTEXITCODE
        $lsTreeErrText = (Get-Content -LiteralPath $lsTreeErrTmp -Raw -ErrorAction SilentlyContinue)
    } finally {
        Remove-Item -LiteralPath $lsTreeErrTmp -Force -ErrorAction SilentlyContinue
    }
    if ($lsTreeExit -ne 0) {
        Write-Host "  [ERROR] git ls-tree 读取 main 分支树失败（$SrcPath，exit=$lsTreeExit），fail-closed 拒绝以不可信清单继续：" -ForegroundColor Red
        if ($lsTreeErrText) { Write-Host "    $lsTreeErrText" -ForegroundColor Red }
        exit 1
    }

    # `& git ... 2> file` 捕获的 stdout 在只有一行/一个 NUL 分隔大字符串时是单个 System.String
    # （本机实测已验证：多文件场景下 `-z` 输出仍是单个字符串，不像无 `-z` 时会被 PowerShell 按
    # 换行自动拆成字符串数组）；解析逻辑已抽成 ConvertFrom-NulSeparatedGitOutput（L1，见上方
    # 函数注释），行为不变——本处只是调用，不再内联重复实现。
    $tracked = ConvertFrom-NulSeparatedGitOutput -RawOut $rawOut

    # H2③：main 分支存在、ls-tree 也成功退出，但清单 0 条——主仓不可能 0 个跟踪文件，这本身就是
    # "读取环节出了问题但没体现在退出码上"的信号（例如误传空仓库路径），同样 fail-closed 中止。
    # M1（codex 76 裁定）：本仓 main 恒非空（本机实测 2026-08-28：`git ls-tree -r --name-only main`
    # 共 470 个跟踪文件），「main 至少含一个文件」是本函数的同步前置条件——空清单不是"合法的极小
    # 仓库"，而视为读取环节异常（误传路径/仓库损坏等），这是有意策略而非误判边界，不改行为。
    if (@($tracked).Count -eq 0) {
        Write-Host "  [ERROR] main 分支跟踪文件清单为空（$SrcPath）——主仓不可能 0 个跟踪文件，视为读取异常，fail-closed 中止" -ForegroundColor Red
        exit 1
    }

    # 2026-08-29 收口批修复：大小写不敏感比对（Windows 文件系统本身大小写不敏感）——避免
    # "仅大小写改名"的历史文件被误判为未跟踪而误删；代价=纯大小写变体的镜像文件会被误放行，
    # 这类文件本就极罕见且低危，两害相权取宽松一侧。
    $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($p in $tracked) {
        if ($p) { [void]$set.Add($p) }
    }
    # 2026-08-29 收口批修复：`return $set` 在 PowerShell 管线语义下会把 HashSet 当集合展开——
    # 0 个元素时输出 $null（调用方 .Contains() 对 $null 调用方法会报错）；恰好 1 个元素时输出
    # 会被降级为裸字符串，调用方 `$trackedSet.Contains($rel)` 就变成 String.Contains()
    # （子串匹配，而非精确匹配）——会把"路径只是恰好包含该唯一跟踪文件名作为子串"的镜像文件
    # 误判为已跟踪从而误放行。用逗号运算符包一层数组，让管线只展开外层数组（长度1），
    # 内层 HashSet 对象原样透传给调用方。
    return ,$set
}

# 手写栈式递归遍历 $RootPath，跳过 .git 与任何 ReparsePoint 目录（junction/符号链接）——不进
# 入其内部，天然阻断"通过 junction 逃出镜像根目录、误删外部真实文件/目录"的风险
# （PowerShell 5.1 的 `Get-ChildItem -Recurse` 默认会跟进 reparse point 目录深入枚举其内部内容，
#  这是已知隐患；单纯对结果做 Where-Object 过滤只能挡住 junction 条目本身，挡不住已经递归进
#  它内部、返回的文件/子目录——必须手写栈式遍历，在下钻前就判断并跳过，才是真正的"不跟进"。
#  2026-08-29 收口批修复）。返回值同时给 Invoke-FailClosedSweep（要 Files）与
#  Remove-EmptyMirrorDirectories（要 Dirs）复用，避免重复扫盘。
function Get-MirrorTreeSkippingReparsePoints {
    param([Parameter(Mandatory=$true)][string]$RootPath)
    $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
    $dirs  = New-Object 'System.Collections.Generic.List[System.IO.DirectoryInfo]'
    $errors = New-Object 'System.Collections.Generic.List[string]'

    $rootItem = Get-Item -LiteralPath $RootPath -Force
    # H3①（codex 74）：镜像根路径自身若是 reparse point（junction/符号链接），直接拒绝扫描——
    # 路径配置错误（如 -MirrorPath 传错指向一个链接）时，继续扫描可能会枚举/删除链接目标（镜像根
    # 之外）的真实内容。不返回任何 Files/Dirs（Errors 非空即代表"这次结果不可信"，调用方不应把
    # 空结果当作"确实没有文件"）。
    if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $errors.Add("镜像根路径本身是 reparse point（junction/符号链接），拒绝扫描：$RootPath")
        return [PSCustomObject]@{ Files = $files; Dirs = $dirs; Errors = $errors }
    }

    $stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
    $stack.Push($rootItem)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        # H1（codex 74）：枚举错误不再用 -ErrorAction SilentlyContinue 单纯吞掉——那样访问被拒绝/
        # 路径异常时整个子树会被静默漏过、照常判定"扫描成功"继续同步，形成 fail-open 绕过。改用
        # -ErrorVariable 收集本次 Get-ChildItem 产生的非终止错误（仍不中断整体遍历，好让报告能一次
        # 列全所有出问题的目录，而不是遇到第一个就停）；错误清单非空由调用方统一判定 fail-closed。
        $enumErr = $null
        $children = Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue -ErrorVariable enumErr
        if ($enumErr) {
            foreach ($e in $enumErr) {
                $errors.Add("目录枚举失败：$($dir.FullName) —— $($e.Exception.Message)")
            }
        }
        foreach ($c in $children) {
            if ($c.FullName -match '\\\.git(\\|$)') { continue }
            if ($c.PSIsContainer) {
                if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    # H3②（codex 74）：子目录 reparse point 不再静默跳过——不跟进枚举（仍然防止经由
                    # 链接逃出镜像根目录），但记入异常清单；清单非空会让调用方整体判定失败、阻止同步
                    # （保守取向：不自动删除链接本身，只是不允许它悄悄留在一次"判定为成功"的同步里）。
                    $errors.Add("子目录是 reparse point（junction/符号链接），未跟进枚举，已记入异常并阻止同步：$($c.FullName)")
                    continue
                }
                $dirs.Add($c)
                $stack.Push($c)
            } else {
                $files.Add($c)
            }
        }
    }
    return [PSCustomObject]@{ Files = $files; Dirs = $dirs; Errors = $errors }
}

# 自底向上删除镜像内的空目录（清理 fail-closed 删完文件后留下的空壳，纯 hygiene，
# 不影响下次 robocopy——/E 会按需重建）。跳过 .git 与 ReparsePoint 目录（同上）。
function Remove-EmptyMirrorDirectories {
    param([Parameter(Mandatory=$true)][string]$MirPath)
    $root = (Resolve-Path $MirPath).Path.TrimEnd('\')
    $tree = Get-MirrorTreeSkippingReparsePoints -RootPath $root
    if ($tree.Errors.Count -gt 0) {
        # H1/H3：这一遍扫描（用于清理空目录壳）本身也可能撞见枚举失败/reparse point 异常——
        # 纯 hygiene 步骤不能建立在不可信的枚举结果之上，原样把异常透传给调用方
        # （Invoke-FailClosedSweep）统一判定 fail-closed，不在这里单独吞掉或半途剪目录。
        return [PSCustomObject]@{ Removed = @(); Errors = $tree.Errors }
    }
    $dirs = $tree.Dirs | Sort-Object { $_.FullName.Length } -Descending
    $removed = @()
    foreach ($d in $dirs) {
        if ((Get-ChildItem -Path $d.FullName -Force | Measure-Object).Count -eq 0) {
            Remove-Item -LiteralPath $d.FullName -Force
            $removed += $d.FullName.Substring($root.Length + 1) -replace '\\', '/'
        }
    }
    return [PSCustomObject]@{ Removed = $removed; Errors = @() }
}

# 核心扫描：镜像内每个文件，只要「主仓 main 分支已跟踪该相对路径」∨「命中白名单」就保留，否则删除。
# -DisableJudgment：仅供测试用，放行判定恒为真（模拟"没有 fail-closed 判定"的旧行为），
#   用于验证脚本的双向自证，真实同步流程绝不传它。
# -SweepForce：待删数超 $BlastRadiusThreshold 时的放行开关，见下方"安全阀"注释。
# -SimulateResidualFor：仅供验证脚本测试用，见下方"fail-closed 删除"注释。
function Invoke-FailClosedSweep {
    param(
        [Parameter(Mandatory=$true)][string]$SrcPath,
        [Parameter(Mandatory=$true)][string]$MirPath,
        [string[]]$Whitelist = @(),
        [switch]$DisableJudgment,
        [switch]$SweepForce,
        [int]$BlastRadiusThreshold = 20,
        [string]$SimulateResidualFor
    )
    $trackedSet = Get-SourceTrackedFileSet -SrcPath $SrcPath
    # 2026-08-29 收口批修复：白名单集合同样改大小写不敏感（理由同 Get-SourceTrackedFileSet 注释）。
    $whitelistSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($w in $Whitelist) { [void]$whitelistSet.Add($w) }

    $mirrorRoot = (Resolve-Path $MirPath).Path.TrimEnd('\')
    # 2026-08-29 收口批修复：改用手写栈式遍历，跳过 ReparsePoint 目录（junction/符号链接）
    # 不跟进——见 Get-MirrorTreeSkippingReparsePoints 注释。
    $mirrorTree = Get-MirrorTreeSkippingReparsePoints -RootPath $mirrorRoot

    # H1/H3（codex 74 二收口批）：镜像根扫描本身若撞见枚举错误或 reparse point 异常，直接判失败——
    # 在此之前不做任何 toRemove/删除判定（结果不可信的枚举清单不能作为删除依据）。整体语义与
    # 安全阀/删除失败一致：调用方发现 EnumerationErrors 非空即打印明细 + exit 1，禁止后续
    # git add/commit/push。
    if ($mirrorTree.Errors.Count -gt 0) {
        return [PSCustomObject]@{
            Removed             = @()
            Kept                = @()
            PrunedDirs          = @()
            FailedDeletions     = @()
            BlastRadiusExceeded = $false
            WouldRemove         = @()
            EnumerationErrors   = @($mirrorTree.Errors)
        }
    }
    $allFiles = $mirrorTree.Files

    $kept = @()
    $toRemove = @()
    foreach ($f in $allFiles) {
        $rel = $f.FullName.Substring($mirrorRoot.Length + 1) -replace '\\', '/'
        $allowed = $DisableJudgment -or $trackedSet.Contains($rel) -or $whitelistSet.Contains($rel)
        if ($allowed) {
            $kept += $rel
        } else {
            $toRemove += [PSCustomObject]@{ Rel = $rel; FullName = $f.FullName }
        }
    }

    # ── 安全阀（2026-08-29 收口批新增）：待删数超阈值 fail-fast，一个都不删 ──
    # 真实首跑预计删 90+（历史六例漏网黑名单模式的累积残留），交给用户在场核对完整清单后
    # 显式带 -SweepForce 复跑；日常增量同步待删数通常是个位数，超阈值本身就是"该停下来看
    # 一眼"的信号（例如判据写错、SrcPath/MirrorPath 传错导致大面积误判）。
    if ($toRemove.Count -gt $BlastRadiusThreshold -and -not $SweepForce) {
        return [PSCustomObject]@{
            Removed             = @()
            Kept                = $kept
            PrunedDirs          = @()
            FailedDeletions     = @()
            BlastRadiusExceeded = $true
            WouldRemove         = @($toRemove | ForEach-Object { $_.Rel })
            EnumerationErrors   = @()
        }
    }

    # ── fail-closed 删除（2026-08-29 收口批新增）：删除失败不再静默吞掉——
    # try/catch 捕获异常 + 删后 Test-Path 复核残留，任一失败都计入 FailedDeletions，调用方据此
    # 整体 exit 1（语义：删不掉 = 不许推，公开镜像宁可同步中止，也不能带着"该删未删"的敏感
    # 文件继续走 git add/commit/push）。
    $removed = @()
    $failedDeletions = @()
    foreach ($item in $toRemove) {
        $rel = $item.Rel
        $deleteOk = $true
        $failReason = $null
        if ($SimulateResidualFor -and $rel -eq $SimulateResidualFor) {
            # 测试桩（仅验证脚本使用）：跳过真实 Remove-Item，模拟"删除声称成功但磁盘未生效"，
            # 用于验证下方 Test-Path 复核路径——真实文件锁定在 Windows 下难以稳定复现
            # （Remove-Item -Force 通常能穿透只读属性；持句柄测试对进程时序敏感、不稳定）。
        } else {
            try {
                Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
            } catch {
                $deleteOk = $false
                $failReason = $_.Exception.Message
            }
        }
        if ($deleteOk -and (Test-Path -LiteralPath $item.FullName)) {
            $deleteOk = $false
            $failReason = "Test-Path 复核发现文件仍残留（删除声称成功但磁盘未生效）"
        }
        if ($deleteOk) {
            $removed += $rel
        } else {
            $failedDeletions += [PSCustomObject]@{ Path = $rel; Reason = $failReason }
        }
    }
    # H1/H3：清空目录壳这一遍扫描（Remove-EmptyMirrorDirectories 内部）也可能撞见新的枚举错误/
    # reparse point 异常——即便本次删除已经落盘，仍把异常并入 EnumerationErrors 统一交给调用方
    # fail-closed（阻止后续 git add/commit/push；已发生的本地删除无法也不需要撤销）。
    $pruneResult = Remove-EmptyMirrorDirectories -MirPath $mirrorRoot
    return [PSCustomObject]@{
        Removed             = $removed
        Kept                = $kept
        PrunedDirs          = $pruneResult.Removed
        FailedDeletions     = $failedDeletions
        BlastRadiusExceeded = $false
        WouldRemove         = @()
        EnumerationErrors   = @($pruneResult.Errors)
    }
}

# ── 测试专用出口：L1（codex 76 新增）——只跑 NUL 分隔路径解析函数，JSON 输出，立即退出。
#    模拟"原生命令捕获遇到字节流中真实换行符，会被拆成多个字符串数组元素"的场景（真实
#    `& git ... -z` 调用同理，见 ConvertFrom-NulSeparatedGitOutput / Get-SourceTrackedFileSet
#    注释）——按 `n` 把还原后的原始字符串切成数组，再喂给待测函数，走与生产完全相同的
#    join(`n`)→split(NUL) 路径，而不是直接把整段字符串传进去（那样会绕过"多行数组重新拼接"
#    这条最需要验证的分支）。──
if ($FailClosedParseNulTestFile) {
    $rawBytes = [System.IO.File]::ReadAllBytes($FailClosedParseNulTestFile)
    $rawString = [System.Text.Encoding]::UTF8.GetString($rawBytes)
    $simulatedRawOut = $rawString -split "`n"
    $parsedResult = ConvertFrom-NulSeparatedGitOutput -RawOut $simulatedRawOut
    ConvertTo-Json -InputObject $parsedResult -Depth 3 -Compress
    exit 0
}

# ── 测试专用出口：只跑 sweep，JSON 输出，立即退出（不碰 git add/commit/push） ──
if ($FailClosedSweepOnly) {
    $result = Invoke-FailClosedSweep -SrcPath $SourcePath -MirPath $MirrorPath `
        -Whitelist $mirrorOnlyWhitelist -DisableJudgment:$FailClosedDisableForTest `
        -SweepForce:$SweepForce -SimulateResidualFor $FailClosedSimulateResidualFor
    $result | ConvertTo-Json -Depth 5 -Compress
    # 2026-08-29 收口批新增：安全阀触发或存在删除失败时，测试出口也要以非 0 退出——
    # 让验证脚本能靠 spawnSync 的退出码判定，而不只是解析 JSON 字段。
    # 二收口批新增（H1/H3）：枚举错误/reparse point 异常同样计入非 0 退出。
    if ($result.BlastRadiusExceeded -or (@($result.FailedDeletions).Count -gt 0) -or (@($result.EnumerationErrors).Count -gt 0)) {
        exit 1
    }
    exit 0
}

# ── 真实同步流程的 -CommitMessage 手动校验（替代原 Mandatory=$true，见 param 块注释） ──
if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    Write-Host "  [ERROR] -CommitMessage 是必填参数" -ForegroundColor Red
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
    "unify-baseline",
    # 2026-08-10 加入（v1.144.0 同步事故第五例·同上通则）：Playwright 套件失败/证据截图目录——
    #   test-screenshots/（commit-cols 横滚证据等）与 __screenshots__/（v1.143 第四例已实锤 21 张）
    #   均为「渲染了本地库数据的二进制」，robocopy 层排除；本例 6 张已推送后即时摘除（faed96b），
    #   历史提交残留并入速览区 #14/#20 待拍。fail-closed 整体改造仍是 #20 正解，本条只是止血补丁。
    "test-screenshots", "__screenshots__",
    # 2026-08-12 加入（同族又一例）：临时脚本**产出的截图目录**此前无任何模式覆盖——排除规则只盯着
    #   `_demo-*.js` 脚本本身，没人管它们写出来的目录（_demo-badges-shots/ 即本次漏网者，21 张观察单
    #   渲染自本地库）。robocopy /XD 收目录名（非路径），此处按名精确列；.gitignore 侧同批改为
    #   `_demo-*/` 目录通配双保险。⚠️ 通则重申：脚本被排除 ≠ 它的产物被排除，两者要分别登记。
    "_demo-badges-shots"
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

# 2026-08-04 清除：本地临时演示/修复脚本（_demo-* / _restore-*）——与 mcp-bms 同根因：
#   robocopy /MIR 按文件系统镜像、不认主仓 .gitignore 与 git 未跟踪状态，本地临时产物会被连带推进公开仓。
#   v1.137.0 部署时实际发生：3 个自我标注"临时脚本·用完即删"的演示数据脚本被推上 GitHub。
#   ⚠️ 刻意**不用 `_*` 通配**——`_sys-attach-test-deps.js` 同样以下划线开头，但它是 verify 脚本
#   require 的真实依赖（删了公开仓的验证脚本直接跑不起来）。只精确匹配这几类前缀。
#   2026-08-09 补 `_seed-*.js`（主仓无已跟踪 _seed 脚本，通配安全）+ `_set-sys-notify-dry-run.js`
#   （必须精确名——`_set-*` 通配会误删已跟踪的 `_set-sys-single-commit-group.js`）：
#   两者 2026-08-06 出现后因黑名单没补条目漏进公开仓（2026-08-09 已从公开仓 HEAD 删除）。
#   黑名单模式必然再漏——此块 2026-08-28 起降级为"第二道防线/诊断信息"，真正兜底见本步骤
#   末尾的 fail-closed 扫描（Invoke-FailClosedSweep，PROJECT_STATUS 未了项 #20 已整改）。
$tmpScriptPatterns = @("_demo-*.js", "_restore-*.js", "_seed-*.js", "_set-sys-notify-dry-run.js")
foreach ($pat in $tmpScriptPatterns) {
    Get-ChildItem "$MirrorPath\wbs-server\scripts" -Filter $pat -File -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Host "  [OK] removed wbs-server/scripts/$($_.Name)（本地临时脚本·不入公开仓）" -ForegroundColor Green
    }
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

# 2026-08-10 兜底清除：docs 本地三目录（与 $excludeDirs 双重防御·同步漏网第六例止血）
# robocopy /XD 的相对多级路径排除不可靠——docs\local 在 $excludeDirs 里却仍被复制进镜像。
# 镜像仓自身 .gitignore（docs/local|review|archive）挡住了 push（历史上从未泄漏），但步骤 4
# 残留敏感词扫描扫的是工作树，会被其中的内网 IP 绊住 fail-fast 中止整个同步
# （2026-08-10 v1.147.0 部署被 docs/local/信息化资产 demo 内网 IP 中止实证）。
$localDocsToRemove = @(
    "$MirrorPath\docs\local",
    "$MirrorPath\docs\review",
    "$MirrorPath\docs\archive"
)
foreach ($p in $localDocsToRemove) {
    if (Test-Path $p) {
        Remove-Item $p -Recurse -Force
        Write-Host "  [SECURITY] removed $($p.Replace($MirrorPath + '\', ''))（本地文档目录·robocopy /XD 兜底）" -ForegroundColor Red
    }
}

# ── Fail-closed 兜底扫（2026-08-28 #20 整改）——唯一权威判定，跑在所有具名黑名单块之后 ──
# 无论上面的具名块删没删干净，最终能留在镜像里的文件，必须满足「主仓 main 分支已跟踪 ∨ 白名单」。
Write-Host ""
Write-Host "  [Fail-Closed] 扫描镜像内文件，唯一放行依据 = 主仓 main 分支已跟踪 ∨ `$mirrorOnlyWhitelist ..." -ForegroundColor Cyan
$sweepResult = Invoke-FailClosedSweep -SrcPath $SourcePath -MirPath $MirrorPath -Whitelist $mirrorOnlyWhitelist -SweepForce:$SweepForce

# 安全阀触发（2026-08-29 收口批新增）：打印完整清单，一个都不删，中止同步。
if ($sweepResult.BlastRadiusExceeded) {
    Write-Host ""
    Write-Host "  [Fail-Closed] ABORT：待删 $($sweepResult.WouldRemove.Count) 个文件，超过安全阀阈值（20），一个都未删：" -ForegroundColor Red
    foreach ($r in $sweepResult.WouldRemove) {
        Write-Host "    - $r" -ForegroundColor Red
    }
    Write-Host "  确认以上清单符合预期后，带 -SweepForce 复跑本脚本以放行删除。" -ForegroundColor Yellow
    exit 1
}

# 枚举错误/reparse point 异常 fail-closed（2026-08-29 二收口批新增，codex 74 H1/H3）：
# 目录访问被拒绝、枚举异常、镜像根本身是 reparse point、子目录命中 reparse point 均在此列——
# 任一发生，本次扫描结果不可信，禁止后续 git add/commit/push（此时 Removed/Kept 恒为空数组，
# 不能被下方"零残留 OK"分支误读为"确实没有需要清理的文件"）。
if (@($sweepResult.EnumerationErrors).Count -gt 0) {
    Write-Host ""
    Write-Host "  [Fail-Closed] ERROR：扫描过程出现 $($sweepResult.EnumerationErrors.Count) 处枚举错误/reparse point 异常，" -ForegroundColor Red
    Write-Host "  结果不可信，同步已中止（fail-closed：看不清 = 不许推）：" -ForegroundColor Red
    foreach ($e in $sweepResult.EnumerationErrors) {
        Write-Host "    - $e" -ForegroundColor Red
    }
    exit 1
}

if ($sweepResult.Removed.Count -gt 0) {
    Write-Host "  [Fail-Closed] 清除 $($sweepResult.Removed.Count) 个主仓未跟踪文件（未命中白名单）：" -ForegroundColor Red
    foreach ($r in ($sweepResult.Removed | Select-Object -First 40)) {
        Write-Host "    - $r" -ForegroundColor Red
    }
    if ($sweepResult.Removed.Count -gt 40) {
        Write-Host "    ... 还有 $($sweepResult.Removed.Count - 40) 个" -ForegroundColor Red
    }
} else {
    Write-Host "  [Fail-Closed] OK：镜像内文件全部为「主仓已跟踪 ∨ 白名单」，零主仓未跟踪残留" -ForegroundColor Green
}
if ($sweepResult.PrunedDirs.Count -gt 0) {
    Write-Host "  [Fail-Closed] 清理 $($sweepResult.PrunedDirs.Count) 个删空后的目录壳" -ForegroundColor Gray
}

# 删除失败 fail-closed（2026-08-29 收口批新增）：删不掉 = 不许推，中止同步。
if (@($sweepResult.FailedDeletions).Count -gt 0) {
    Write-Host ""
    Write-Host "  [Fail-Closed] ERROR：$($sweepResult.FailedDeletions.Count) 个文件删除失败（fail-closed：删不掉 = 不许推）：" -ForegroundColor Red
    foreach ($fd in $sweepResult.FailedDeletions) {
        Write-Host "    - $($fd.Path): $($fd.Reason)" -ForegroundColor Red
    }
    exit 1
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
#   ⚠️ 不放手机号宽匹配 1[3-9]\d{9}：会误伤测试假号（如 19900000024）。真实手机号靠 $phoneMap 派生精确匹配。
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
