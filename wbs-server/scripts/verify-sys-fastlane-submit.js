// scripts/verify-sys-fastlane-submit.js — 系统迭代·先行上线两步化 S2「挂牌 + 拆直上」submit 端点验收
//   + S3「执行确认 + 共享翻牌内核」POST /sys-issues/:id/fast-release-exec-confirm 端点验收
//   SSOT = docs/local/系统迭代/先行上线两步化_方案_20260813_v1.8.md §4-1（挂牌）/ §4-2（拆直上·整体替代）
//   / §4-3（执行确认端点）/ §4-4b（共享翻牌内核）
//   用法：node scripts/verify-sys-fastlane-submit.js
//
// [S2 语义翻转声明] 本文件此前（组 B·SB2 阶段）覆盖的是 submit `direct_release=true` 分支——开发勾选后
//   单事务条件更新直接翻牌到「已上线」。方案 §4-2「整体替代」拍板：该单步直上分支已随两步化拆除，
//   submit 不再有任何路径把主状态直接推到「已上线」；取而代之的是 §4-1「挂牌」——花名册全完成、主状态
//   真正翻到「待验证」且该单存在活跃先行上线授权时，同事务写一行 `sys_fast_release_executors`（当日
//   有值班时）+ 一条 timeline `fast_release_staged`。旧文件名保留（全家 glob `verify-sys-*.js` 收编不变），
//   内容整体重写，不是增量修补。
//
// [S2-1·e 项·codex 382 订正=定论] 站内通知——平台"站内通知"的实体是派生可见性范式（badge / timeline
//   行 / 角标即通知，同族先例见 index.js :10937 受阻单 blocked timeline + 站内可见、:14763 创建者侧
//   角标走独立未读逻辑，全仓无独立通知表），不是需要另建投递基建的队列/表。S2-1 未新造投递基建，故本
//   文件**不含**任何通知投递断言（无可测对象）；挂牌事件的可见性由 sys_fast_release_executors 行 +
//   timeline 行即构成完整闭环（S6 起再叠列表徽章投影，是同一事实的呈现，不是另一套机制），主动推送
//   （钉钉 dispatchSysNotify）总闸 isAutoNotifyEnabled() 恒 false（方案 §11 明确不做），见 index.js
//   S2-1 段注释与本次交付报告。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [0] schema 三列已就绪（前置自检，未受 S2 影响，原样保留）
//   [1] 兼容负例：direct_release=true 的 legacy payload 提交（即便当前有活跃授权）⇒ 行为与不带该键的
//       普通 submit 完全一致——待验证（非已上线）+ 挂牌正常按 isActiveFastReleaseAuth 独立生效（挂牌不
//       看这个字段）+ 全库零 fast_release_direct_online 行 + 响应不带 online_source 键 + 无任何
//       FAST_RELEASE_SUBMIT_* 错误码（该错误码族已随分支删除，不存在能触发的路径）
//   [2] 挂牌正例·当日无值班：活跃授权 + 花名册全完成 + 当日无排班 ⇒ 待验证 + sys_fast_release_executors
//       0 行（0/0 语义）+ timeline fast_release_staged 一行照写（挂牌事件本身发生了）
//   [3] 挂牌正例·当日有值班：活跃授权 + 花名册全完成 + 当日有排班 ⇒ 待验证 + sys_fast_release_executors
//       恰 1 行 pending（user_id/user_name=值班人，added_by/added_by_name=submit 操作者）+ timeline
//       fast_release_staged 一行（summary 含值班人姓名）
//   [4] 无授权 ⇒ 零挂牌（对照组）：正常 submit 全完成态推进待验证，但 sys_fast_release_executors 与
//       fast_release_staged timeline 行均为 0——挂牌只在"活跃授权"这一条件成立时触发
//   [5] 挂牌只发生在状态真翻转路径：多开发场景——非最后提交者提交（roster 未全完成，gateResult.changed
//       =false）⇒ 零挂牌（即便授权活跃、即便当日有值班）；最后提交者提交（roster 转全完成，
//       gateResult.changed=true）⇒ 挂牌正常触发。同一 issue 前后两次 submit 对照，非两个独立夹具。
//   [6] last_completed_at 正常路径（拆直上后原 OR 析取分支已删，本组验证基础判据本身仍正确）：挂牌单
//       进入待验证后，列表/详情两端点 last_completed_at 均正确取到 runWGate 镜像行的 created_at，
//       两处子查询同源一致（同 codex 263 M-1 契约）
//   [7] 不变量①②③⑦探针（[Y5] 范式，未受 S2 影响，原样保留）：JS 纯函数用例表 + 候选行 SQL 粗筛 →
//       I.fastlaneAcceptanceInvariantViolations 逐行精判 + 真实本地库（task_pool.db）同一判据违例计数=0
//   [8] online_source 消费面：列表/详情端点 online_source_kind==='authorized_fastlane' + deriveOnlineSourceKind
//       直调四分支穷举 + 前端字典覆盖（静态源码扫描）——夹具改用 SQL 造态直接构造"已上线+authorized_fastlane"
//       状态（原经 submit direct_release=true 真实链路已不可达，deriveOnlineSourceKind 本身与写入路径
//       无关，只看现值字段，造态验证完全等价）
//   [9]（S3 改名重写）assertMainStatusTransition FAST_RELEASE_CONFIRM routeKind 单元覆盖——原
//       FAST_RELEASE_DIRECT（S2 后曾是死代码）已原地改名+边形状重写（before：DEV 态→待验证；action：
//       'submit'→'fast_release_exec_confirm'），且随 S3 落地共享翻牌内核而**恢复为真实生产调用路径**。
//   [10] reopen 清补验收字段组：真实链路——挂牌单进入待验证后无法直接测"直上→close"链路（挂牌不产出
//       已上线态），改为 SQL 造态构造"已上线+authorized_fastlane+pending"状态后走 close 被拦→补验收→
//       close 放行→reopen→三列全清空的真实端点链（与原 [9] 同一份不变量，仅起点从"真实直上"改"造态"）
//   [11] 授权须晚于最近一次 reopen（isActiveFastReleaseAuth 第六条件，纵深防御）：**语义随拆直上重新
//       定义**——原语义"submit 前置闸拒绝(409)"已随该闸删除；新语义="挂牌闸静默跳过"（submit 本身仍
//       200 进入待验证，只是 isActiveFastReleaseAuth 判 false 导致不挂牌）。成对：(a) SQL 造态构造悬垂
//       授权跨轮 → submit 200 但零挂牌 (b) 对照组 reopen 后重新授权 → submit 200 且挂牌正常触发
//   [12] isActiveFastReleaseAuth 唯一判据 fail-closed（未受 S2 影响，原样保留）：缺列入参抛错 + 静态核对
//       submit 端点唯一调用点 SELECT 六列齐全
// [S3·§4-3/§4-4b 新增以下各组]
//   [13] 单人末位确认正例：翻牌全套写点逐字段断言（status/released_at/online_source/
//       post_release_acceptance/consumed_at/gate_deferred_at 清/dev_estimated_at_on_release 快照）+
//       执行人行 done+executed_at + timeline 恰 1 条 fast_release_exec_online（无重复 exec_confirm note）
//   [14] 多人非末位：SQL 造态铺第二人（加执行人端点 S4 才有），单人确认 done+timeline exec_confirm note，
//       不翻牌、第二人不受影响
//   [15] 负例族（a-e）：非在册 403／已 done 重复确认 409／[S5 改写] 授权终结（return/revoke/accept）三组
//       均先断言集合已清空（零未软删行+roster_cleared 留痕），再确认 403 FAST_RELEASE_EXEC_NOT_ROSTERED
//       （本人已不在册——旧行为"在册判权仍过但主表联判失败落 409"随 S5 清集合已不成立，见 S5 交付报告
//       "预埋纪律二"）——五种成因各自独立断言
//   [16] 空集合恒不可翻（方案 §5-⑧）：0 行执行人集合直调内核证明 flipped=false 且零副作用
//   [17] 代次干扰：软删旧代次 pending 行不计入聚合判定（唯一活跃执行人确认正常翻牌）
//   [18] 弹回×done 闸门成对：无 done 弹回照常放行 / 有 done 弹回 409 FASTLANE_DEPLOY_IN_PROGRESS
//   [19] d 条款原子性成对：集成层（脏 online_source→执行人不留半完成 done）+ 内核层（全 done 但翻牌
//       WHERE 不满足→FAST_RELEASE_FLIP_CONFLICT）
//   [20] §3.3 副作用：翻牌后 pending + isPostReleaseAcceptOverdue 以 released_at 现值为锚点（成对边界）
//   [21] 静态断言：翻牌 UPDATE 语句全仓唯一存在于共享内核（S4 禁双实现）
// [S4·§4-4a/4b 新增以下各组：执行人集合调整（admin 加人/移人）POST|DELETE /sys-issues/:id/fast-release-executors[/:userId]]
//   [26] 加人正例：目标资格合格 ⇒ INSERT pending 行 + timeline fast_release_roster_added；user_name 来源
//       断言——body 混入伪造 user_name 字段应被端点忽略，落库值恒取服务端实时查询 users.display_name
//   [27] 重复加人：同一 user_id 二次加人撞 partial UNIQUE ⇒ 409 FASTLANE_ROSTER_ALREADY_ADDED（捕获后
//       语义化，不透出原始 SQLite 报错）
//   [28] 首 done 后加人 FROZEN 成对（372-H1'）：无 done 行时加人正常 200 / 已有 done 行时加人 409
//       FASTLANE_ROSTER_FROZEN
//   [29] 非挂牌态加人 409 成对：单未到「待验证」（仍处理中）时加人 409 FASTLANE_ROSTER_NOT_STAGED /
//       单已到「待验证」但从未授权（无活跃六列）时加人同码 409
//   [30] 无资格用户加人拒三态：已停用 400 FASTLANE_ROSTER_TARGET_NOT_ELIGIBLE／viewer 角色同码 400／
//       目标用户不存在 400 VALIDATION
//   [31] 移人 pending 正例：软删三列齐（removed_at/removed_by/removed_by_name）+ timeline
//       fast_release_roster_removed 含原 exec_status
//   [32] 移 done 行 409：已确认执行的执行人结构性移不掉（方案 §5-⑨），409 FASTLANE_ROSTER_REMOVE_INVALID
//   [33] 移人后剩余全 done 同事务翻牌正例（372-H1' 核心）：真实端点链路（非直调内核）——两人集合一人
//       已 done，admin 移除另一 pending 人后剩余恰为该 done 人 ⇒ 同事务翻牌，响应 flipped=true + 翻牌
//       写点全套 + timeline exec_online 行 trigger=roster_remove
//   [34] 移人后剩余为空不翻（回 0/0）：唯一 pending 执行人被移除后集合归零，flipped=false 主状态不变；
//       此后加人应正常放行（无 done 行残留，未被误判 FROZEN）
//   [35] 非挂牌态移人 409：同 [29] 同源判据、同码 FASTLANE_ROSTER_NOT_STAGED
//   [36] 移不存在的人：目标 user_id 从未在册 ⇒ 409 FASTLANE_ROSTER_REMOVE_INVALID（同码统一，不单独 404）
//   [37] confirm×remove 竞争串行化：并发对同一执行人行发起确认与移除，sysBeginImmediate 全库写 mutex
//       下天然串行——恰一方成功、另一方落确定性失败码，终态无双写/无半完成态（同 [22] 故障注入
//       组"整体回滚不留半完成态"精神的并发版）
// [Opus 385 号预筛 S4=BLOCK 收口批·2026-08-14 新增以下三组]
//   [38] 软删后重加同 user_id 反向一对（MED-4）：移人→重加同一人 ⇒ 200，全表 3 行（值班人 active + 该人
//       旧软删行 + 该人新 active 行），该 user_id 在册（未软删）行恰 1——partial UNIQUE 若被误改为全表
//       UNIQUE（丢了 WHERE removed_at IS NULL），本次重加会撞旧软删行崩 409/500，本组钉死"移错人加回来"
//       这条真实运维动作受保护
//   [39] user_name 归一化级联三态（MED-3）：目标 display_name 纯 Tab+username 正常 ⇒ 200 落库=username
//       回退值（非 500+裸 SQLite 报错）／目标 display_name+username 均纯 Tab ⇒ 200 落库=user#id 兜底
//       字面量／操作者（admin）display_name 纯 Tab ⇒ 加人 added_by_name 与移人 removed_by_name 均正确
//       落 username 回退值（归一化在"操作者"一侧同样生效，不止目标用户一侧）
//   [40] 两新端点 403 权限负例（MED-5，仿 verify-sys-fastrelease-auth [4] 组）：devTok（非 admin）加人
//       403+零插入／devTok 移人 403+目标行零改动
// [codex 387 回卷 MED 收口·2026-08-14 新增以下两组·POST 参与的并发回归]
//   [41] 加人×确认并发（终态枚举法，非固定 Promise 数组顺序断言）：单人 pending 集合下 admin 加第二人
//       与本人 confirm 并发发出。允许终态恰两种——add_first（加人先提交：两 200，集合 2 人 1done1pending，
//       不翻牌）／confirm_first（确认先提交：confirm 翻牌，加人 409 FASTLANE_ROSTER_NOT_STAGED）；按
//       响应内容动态分类（非按发起顺序假定赢家），拒绝任何第三种杂交态，两次不同发起顺序确保两方向均
//       真实观测到
//   [42] 双加人同 user_id 并发：两个 admin（不同身份）并发加同一目标 ⇒ 恰一方 200/另一方 409
//       FASTLANE_ROSTER_ALREADY_ADDED，与发起顺序无关（同构动作互斥，非业务分支分叉）；在册恰 1 行、
//       roster_added timeline 恰 1 条
// [codex 388 号 merge-ready·S5 开工·方案 §4-5/§4-6/§4-7·2026-08-14 新增以下八组]
//   [43] revoke 无 done 正例（核心价值）：撤销后集合零未软删行+roster_cleared（成因"撤销授权"）；
//       重走全序列（撤销→打回→重新授权→重新 submit→重新挂牌）新一代集合行 INSERT 不撞 partial
//       UNIQUE——不清集合就会撞崩 500，本条钉死"清了就不会"
//   [44] revoke 有 done 409 成对：授权/集合零改动，整体回滚（与 [43] 互为成对）
//   [45] accept 验收闸成对：45a 无 done 正常终结（待上线）+ 清集合；45b 有 done 409（授权/集合零改动）
//       + 续走 confirm 完成翻牌（验收被闸不阻塞执行流程）+ 翻牌后 accept 自然不可达（可选断言）
//   [46] return 验收打回闸成对：46a 无 done 正常终结（处理中）+ 清集合；46b 有 done 409
//   [47] void 含 done 终极出口正例：done 行也被软删（方案 §5-⑨ 唯一例外，历史 exec_status 原样保留）
//   [48] issue_reject 路径：结构性零行照常（挂牌前，roster 从未产生，changes=0 不写虚假 timeline）
//   [49] 不变量 ⑪ 探针：授权非活跃单不得存在未软删集合行——真实本地库（task_pool.db，同 [7c] 范式）
//       终态零违例 + IN-MEMORY 库 SQL 造态孤儿行反证判红（仅判该 issue）+ 清理恢复零违例（双向证明闭环）。
//       ⚠️ 编码期实测修复：首版扫 IN-MEMORY 累计库断言零违例，被 [19a] 等组的 SQL 造态对照组遗留状态
//       误判违例——改按真实本地库范式，详见组内注释
//   [50] 不变量 ⑫ 探针：不存在持久的"非空∧全done∧待验证∧活跃授权"态——真实本地库终态零违例（同上范式，
//       与 [49] 同批同因改写）+ IN-MEMORY 库 SQL 造态绕过内核反证判红（仅判该 issue）+ 内核补翻牌恢复零违例
// [Opus S5=BLOCK 预筛 H1 修法 A 收口·2026-08-14 新增以下四组·真实生产级 H1：S5 三闸与「已消费→reopen→
//   重授权」路径组合成五路全闸不可恢复态，三变体真实端点实测抓出]
//   [51] 变体A·同人值班跨轮：消费→pass→close→reopen→重新授权（同事务软删首轮 done 行+roster_cleared
//       成因"重新授权"，留痕断言：removed_at 非空但 exec_status/exec_online 镜像行仍可查）→重新
//       submit **不再 500**（H1 修复前会因同一 user_id 撞 partial UNIQUE），新一代恰 1 行 pending
//   [52] 变体B·换值班人跨轮（3 子组，公共 fixture 建造函数）：同样消费→pass→close→reopen→换值班人→
//       重新授权（H1 同样清首轮残留）→重新 submit，随后 52a accept / 52b return / 52c revoke **均不再
//       409**（H1 修复前会被 gen1 残留 done 行误闸——跨代污染，H1 切断代际边界）
//   [53] 变体C·无值班跨轮：同样消费→pass→close→reopen→当日值班行整体软删（无人接班）→重新授权（无新
//       值班人接手也应清——不能只在"有人接手"时才清，那会漏掉预筛描述的"唯一出口=void"死锁本身）→
//       0/0 照挂+加人解冻（不再被残留 done 行误伤 FASTLANE_ROSTER_FROZEN）
//   [54]（L1）C9 直翻+非空集合 cause='上线翻牌' 正例：授权→mode:'no_code' submit 挂牌（1 行 pending）→
//       accept 零 commit 直翻已上线⇒同事务清集合，roster_cleared 成因精确为"上线翻牌"（非"验收通过"）
// [codex 389 号 conditional 二批·2026-08-14 新增以下两组]
//   [55]（M1）revoke 闸序修正回归：已消费（末位确认翻牌，done 行按 §5b 第 7 行保留）单调 revoke——
//       修法前 done 闸抢在活跃判定前跑会误报 409 FASTLANE_DEPLOY_IN_PROGRESS（文案与实际状态相反）；
//       修法后应走既有撤销冲突响应（409 FAST_RELEASE_REVOKE_NOT_ALLOWED+"已被消费"精确文案），授权
//       六列/集合行零副作用
//   [56]（L1）重新授权原子性故障注入（仿 [22] 触发器范式）：BEFORE UPDATE 触发器精确拦截"本 issue 集合
//       行未软删→已软删"这一迁移（RAISE(ABORT) 真抛错，非 IGNORE 静默跳过）→ 重新授权应整体 500 回滚
//       （授权六列/fast_release_authorize timeline/执行人行 removed_at/roster_cleared timeline 四面全零
//       改动）→ DROP 触发器后重新授权恢复正常（功能恢复对照）
// [S6·方案 v1.8 §4-8·2026-08-14 新增以下一组（内部 a-h 子块）]
//   [57] 详情 DTO 与列表投影——值班执行人集合 + 徽章派生输入 + x/N 计数：
//     57a 详情正例·挂牌进行中混合态（1 done+1 pending）：fast_release_executors 数组齐/字段全/按 id
//         升序 + fast_release_exec_progress={done_count:1,total_count:2}；同批列表侧 x/N="1/2"
//     57b+57f 代次干扰：软删旧代次行不计入详情数组/计数（详情={done_count:0,total_count:1}）与列表
//         投影（total_count=1,done_count=0）——两处消费点写读同源交叉验证
//     57c 非挂牌单行为：从未授权的处理中 bug 单 + feature 单，详情/列表均 fast_release_executors=[]、
//         progress={done_count:0,total_count:0}、列表 fast_release_active_auth=0/total=0/done=0
//     57d+57h consumed 单留痕块：末位确认翻牌后，详情 fast_release_executors **保留**全部 2 行 done
//         （部署留痕，方案 §5b 第 7 行）+ progress={done_count:2,total_count:2}；列表侧
//         fast_release_active_auth 归零（授权已消费）+ status 已非「待验证」两个独立信号共同关闭
//         徽章，x/N 仍显示 2/2（消费态部署留痕同样反映在列表投影）
//     57g 空集合 0/0：当日无值班挂牌单——两计数皆 0，fast_release_active_auth 仍为 1（授权本身活跃，
//         只是当日无人配置执行人——两者是独立信号，不能用"计数为 0"反推"授权不活跃"）
// [Opus 预筛 S6-HIGH-1/MED-2·2026-08-14 新增以下一组]
//   [58] 值班执行人可见性成对用例：58a 在册时列表可见+详情 200+三列/DTO 附块值正确（值班人视角与
//       admin 视角一致，HIGH-1 修复点=列表 WHERE 补 fastReleaseExecVisibilitySql 析取 + 详情补
//       isFastReleaseExecutor 放行分支）；58b 移出集合（软删退出当前代次）后列表不可见+详情恢复
//       403（口径="只认当前代次未软删行"，与撤销/终结/重授权失去可见性同一语义）
// [值班筛选与类型卡·S1·2026-08-15 新增以下一组·SSOT=docs/local/系统迭代/
//   任务_值班筛选与类型卡_长任务锚点_20260815.md §3 技术自决]
//   [59] fast_release_my_pending 列表投影成对用例（当前用户在当前代次执行人集合中且未确认=1，
//       不掺 fast_release_active_auth 门控）：59a 正例（本人在集合且 pending=1）；59b 反例②（不在
//       集合的用户 admin=0）；59c 反例①（本人所在行 exec_status 已翻为 done=0，集合行按方案 §5b
//       第 7 行保留不软删，可见性不受影响）；59d 反例③（被移出当前代次的非活跃成员=0，用已是
//       assigned_to 的用户加人再移人，移除后仍经 assigned_to 通道可见，隔离出"在集合但已软删"这条
//       单独失效维度，不与 [58b] 那种"移出后连可见性都一并失去"的形态混淆——59-前置3 移人前补中间
//       断言核实 devTok 移除前确实在活跃集合恰 1 行，堵"加人静默 no-op 则本反例恒成立"这条假绿路径）；
//       59e 字段存在性（无任何 fastlane 数据的普通单，字段仍下发为 number 0，非 undefined 缺省）
// [S-fix 修复批·2026-08-15 追加以下三处，随 [59] 组同批]
//   59-绑定顺序：带 query 参数（type=bug）的两条列表调用（值班人身份 my_pending=1／admin 身份=0），
//       把"my_pending 子查询占位符与 addEq 参数不错位"钉进本套件自身断言，不再靠外套件偶然兜底。
//   59f 不掺闸对照：SQL 造态构造"fast_release_consumed_at 非空但集合行仍 pending、主状态仍待验证"这一
//       真实端点原子事务下不可达的组合，核心断言 fast_release_active_auth=0 ∧ fast_release_my_pending=1
//       同时成立——钉死"原始信号不掺 active_auth 这道授权闸"的契约，未来若子查询被人补一句 AND
//       active_auth，本条立即判红。
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-fastlane-submit-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
// [S3] 值班员甲（id 20，[3] 组既有 setDutyToday 落库对象）本人 token——确认端点契约 a 要求"本人在册"，
// 需要以该用户身份发请求才能命中在册判权，此前本文件全程只有 admin/dev5/dev2 三个身份的 token。
const dutyTok = jwt.sign({ id: 20, username: 'zhiban', display_name: '值班员甲', role: 'user' }, SECRET);
// [Opus 385 预筛 MED-3] tab-admin token——JWT payload 里 display_name 直接是纯 Tab 字符，验证
// added_by_name/removed_by_name 的归一化兜底（sysFastReleaseSafeName）在"操作者"一侧同样生效
// （不止目标用户一侧）；username 给正常回退值，非二级也 Tab（三级全 Tab 场景见 [39b]，不与本 token 重复）。
const tabAdminTok = jwt.sign({ id: 25, username: 'tab_admin_fallback', display_name: '\t', role: 'admin' }, SECRET);
// [Opus S5 预筛 H1 变体B] 示例对接人（id 13，既有受理人夹具对象·[26]-[42] 各组已用作加人目标/受理人）
// 本人 token——变体B"换值班人跨轮"需要以新值班人身份发起确认（若某子测试需要），复用既有 seed 用户，
// 不新增 users 行。
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, headers: {
        'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ verify-sys-fastlane-submit 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const isChangeType = type === 'feature' || type === 'improvement';
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `FS-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-fastlane-submit 夹具', intake_liaison_id: 13,
    ...(isChangeType ? { needs_feasibility: 0 } : {}),
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// 单开发 bug·处理中态夹具（真实端点链路：建单→受理→指派 dev5）。
async function bugAtChulizhong() {
  const id = await mkIssue('bug');
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `[夹具-受理] 应 200，实得 ${acc.status} ${JSON.stringify(acc.body)}`);
  const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(asg.status, 200, `[夹具-指派] 应 200，实得 ${asg.status} ${JSON.stringify(asg.body)}`);
  return id;
}
// 双开发 bug·处理中态夹具（dev5 + dev6 均在册·pending）。
async function bugAtChulizhongTwoDevs() {
  const id = await mkIssue('bug');
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `[夹具-双开发-受理] 应 200，实得 ${acc.status}`);
  const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(asg.status, 200, `[夹具-双开发-指派] 应 200，实得 ${asg.status}`);
  const add = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
  assert.strictEqual(add.status, 200, `[夹具-双开发-加人] 应 200，实得 ${add.status} ${JSON.stringify(add.body)}`);
  return id;
}
// 给某单填未来预计完成时间（ESTIMATE_REQUIRED 前置）。extraBody 供非 bug 类型补 estimated_effort_days（C7 工期硬闸）。
async function estimateFuture(id, tok = devTok, extraBody = {}) {
  const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
  const r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: futureEst, ...extraBody });
  assert.strictEqual(r.status, 200, `[estimate] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
async function authorize(id, tok = adminTok, note) {
  const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, tok, note ? { note } : {});
  assert.strictEqual(r.status, 200, `[授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
// 提交 body 构造器：commits 模式（默认）或 no_code 模式。directRelease 仅用于 [1] 组构造 legacy payload
// （生产/真实前端已不再发送该键，见 Sys_Iteration.html S2-2 拆除记录），其余组一律不传。
function submitBody({ mode = 'commits', directRelease, extra = {} } = {}) {
  const base = {
    self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因',
    ...(directRelease !== undefined ? { direct_release: directRelease } : {}),
  };
  if (mode === 'no_code') return { ...base, mode: 'no_code', no_code_reason: 'verify 夹具：无提交交付', ...extra };
  return { ...base, mode: 'commits', commits: [{ component: 'backend', commit_ref: `svn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }], ...extra };
}
// [S2-1] 当日值班夹具——与 index.js 挂牌逻辑的查询式 `date('now','localtime')` 同源表达，不依赖手数
// 真实日期字符串（跨时区/跨日运行天然安全）。partial UNIQUE(duty_date) WHERE removed_at IS NULL 保证
// 同日至多一人在册，调用方须自行保证同一测试进程内不重复对"今天"插两次未软删的行。
async function setDutyToday(userId, userName) {
  await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name)
             VALUES (date('now','localtime'), ?, ?, 1, '管理员')`, [userId, userName]);
}
// [Opus S5 预筛 H1 变体B] 换值班人——软删当日现有活跃行（若有）+ 插入新一条。与 setDutyToday 不同：
// 后者要求调用前当日确无活跃行（否则撞 partial UNIQUE），本函数允许"已有人在班，换成另一人"这个更
// 常见的真实运维场景（同 S1 集合表"代次"语义：软删退出本代，非物理删除）。⚠️ 交接摘要五坑之④——
// 调用方用完须自行换回默认值班人（user 20），本文件全局默认基线依赖它（[3] 组起大量既有用例假设
// 当日值班=user20），组末必须复位，不复位会向后污染。
async function switchDutyTo(userId, userName) {
  await run(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员'
             WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
  await setDutyToday(userId, userName);
}

const issueRow = (id) => get(
  `SELECT id, type, status, released_at, online_source, post_release_acceptance, post_accepted_at,
          post_derive_issue_id, fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at,
          release_id, first_submitted_at, gate_deferred_at, dev_estimated_at, dev_estimated_at_on_release
     FROM sys_issues WHERE id=?`, [id]);
// [codex 390 号三批 L1 补全] 与 index.js:3805 FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL/:3753
// FAST_RELEASE_ACTIVE_AUTH_INPUT_COLS 同源的六列快照——issueRow 本身缺 reopened_at 一列，不足以
// 支撑"授权六列逐列比对"这类断言，故单独提供一个恰六列的快照 helper。
const fastAuthSixCols = (id) => get(
  `SELECT fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at,
          released_at, online_source, reopened_at
     FROM sys_issues WHERE id=?`, [id]);
// [S3] 确认端点调用 helper。
const confirm = (id, tok) => call('POST', `/api/sys-issues/${id}/fast-release-exec-confirm`, tok, {});
// [S4] 集合调整端点调用 helper——加人 body 恒只传 user_id（extraBody 供 [26] 组混入伪造 user_name 断言
// "传假名参数被忽略"用）；移人路径用 user_id 寻址（同该端点头部注释——非该表自增 id）。
const addExecutor = (id, userId, tok = adminTok, extraBody = {}) =>
  call('POST', `/api/sys-issues/${id}/fast-release-executors`, tok, { user_id: userId, ...extraBody });
const removeExecutor = (id, userId, tok = adminTok) =>
  call('DELETE', `/api/sys-issues/${id}/fast-release-executors/${userId}`, tok, {});
const devAssigneeRow = (issueId, userId) => get(
  `SELECT id, dev_status, resolved_at FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, userId]);
const timelineCount = (id) => get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]).then(r => Number(r.c));
// [Opus 385 预筛 MED-2 收口] SELECT 补 id 列——供 [33] 组做 roster_removed.id < exec_online.id 的相对
// 顺序断言（timeline 自增 id 即显示顺序，MED-2 修的正是"两条行因果倒置"这个具体症状，新增 id 列非
// deepStrictEqual 断言对象，不影响既有调用点的字段访问方式）。
const timelineRowsByCode = (id, actionCode) => all(
  `SELECT id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name
     FROM sys_issue_timeline WHERE issue_id=? AND action_code=? ORDER BY id`, [id, actionCode]);
const commitCount = (issueId) => get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [issueId]).then(r => Number(r.c));
// [S2-1] 挂牌集合查询——全部行（不过滤 removed_at，本文件不测撤销/加人端点，S4-S6 范围）。
const fastExecRows = (issueId) => all(
  `SELECT id, issue_id, user_id, user_name, exec_status, added_by, added_by_name, removed_at
     FROM sys_fast_release_executors WHERE issue_id=? ORDER BY id`, [issueId]);
// 全库残留计数——用于 [1]/[4] 等"零残留"断言不局限于单个 issue_id（防"挂牌逻辑串到别的单去了"这类更隐蔽的错误）。
const globalFastExecCount = () => get('SELECT COUNT(*) c FROM sys_fast_release_executors').then(r => Number(r.c));
const globalDirectOnlineTimelineCount = () => get(
  `SELECT COUNT(*) c FROM sys_issue_timeline WHERE action_code='fast_release_direct_online'`).then(r => Number(r.c));

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user'),(20,'zhiban','值班员甲','user')`);
  // [S4] 集合调整端点（admin 加人/移人）专属固定夹具用户——与 [5b] 组"临时降级又复位"的 user 20 手法
  // 不同：本两名用户**永久**处于不合格态（21=viewer 角色恒不合格，22=停用账号恒不合格），全程只作
  // 加人负例的目标，不参与任何正例路径、不被任何组临时改写，故无需组末复位（规避交接摘要五坑之④
  // "共享夹具组内改动必须组末复位"——本法直接不共享、不改写，从根上不落入该坑）。
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (21,'viewer_only','查看者乙','viewer','active'),(22,'disabled_dev','停用丙','user','inactive')`);
  // [Opus 385 预筛 MED-3 verify 专属夹具] display_name 纯 Tab 值——**参数化绑定**写入（非拼进裸 SQL 文本
  // 字面量），规避交接摘要五坑之①③"JS 模板字符串内 \t 转义序列会截断字符串/注释"这类风险面（Tab 字符
  // 走 sqlite3 绑定参数，不经 JS 模板字符串裸拼进 SQL 文本，完全绕开该风险面，非"小心拼写"式规避）。
  // user23=display_name 纯 Tab + username 正常（验证一级 fallback 落到二级 username）；
  // user24=display_name/username 均纯 Tab（验证两级均空，fallback 落到 user#id 字面量兜底）；
  // user25=role='admin'（配 tabAdminTok），display_name 纯 Tab + username 正常（验证归一化在"操作者"
  // 一侧同样生效，不止目标用户一侧——对应 sysFastReleaseSafeName(actor.name, ...) 消费点）。
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (?, ?, ?, 'user', 'active')`, [23, 'tab_fallback_user', '\t']);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (?, ?, ?, 'user', 'active')`, [24, '\t', '\t']);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (?, ?, ?, 'admin', 'active')`, [25, 'tab_admin_fallback', '\t']);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5 / dev2#6 / 受理人13 / 值班员甲#20 / [S4] 永久查看者21 / 永久停用22 / [MED-3] tab-display_name 用户23/24 + tab-admin25）');

  // ══════════════════════════ [0] schema 三列已就绪（前置自检，未受 S2 影响） ══════════════════════════
  {
    const cols = (await all(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
    for (const c of ['post_release_acceptance', 'post_accepted_at', 'post_derive_issue_id']) {
      assert.ok(cols.includes(c), `[0] sys_issues 应含列 ${c}（alterAddMissingCols [1a-15] 未生效？）`);
    }
    const feCols = (await all(`PRAGMA table_info(sys_fast_release_executors)`)).map(c => c.name);
    assert.ok(feCols.length >= 12, `[0] sys_fast_release_executors 应已建表（S1 数据层地基），实得列数 ${feCols.length}`);
    ok('[0] sys_issues 三列（post_release_acceptance/post_accepted_at/post_derive_issue_id）+ sys_fast_release_executors 表 均已就绪');
  }

  // ══════════════════════════ [1] 兼容负例：direct_release=true legacy payload ⇒ 行为与普通 submit 完全一致 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '兼容负例-1');   // 故意保持授权活跃，证明"即便有效授权仍在，这个字段也不再触发直上"
    const beforeGlobalFe = await globalFastExecCount();
    const beforeGlobalDirect = await globalDirectOnlineTimelineCount();
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits', directRelease: true }));
    // 若拆直上分支不干净（旧前置闸/旧 UPDATE 残留任一处未删），本条会以 409 FAST_RELEASE_SUBMIT_DIRECT_DENIED
    // 或 200+status='已上线' 中的一种形式红——两种坏法本条断言都能抓到。
    assert.strictEqual(r.status, 200, `[1] 带 direct_release=true 的 submit 应正常 200（字段已彻底停止消费），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', `[1] main_status 应为「待验证」（非「已上线」——若仍是已上线说明直上分支未拆干净），实得 ${r.body.main_status}`);
    assert.strictEqual(r.body.online_source, undefined, `[1] 响应不应携带 online_source 键（该键随拆直上分支删除），实得 ${JSON.stringify(r.body.online_source)}`);
    const after = await issueRow(id);
    assert.strictEqual(after.status, '待验证', '[1] status 应为「待验证」');
    assert.strictEqual(after.online_source, null, '[1] online_source 应仍为空');
    assert.strictEqual(after.released_at, null, '[1] released_at 应仍为空（未曾走已上线）');
    assert.strictEqual(after.fast_release_consumed_at, null, '[1] fast_release_consumed_at 应仍为空（授权未被消费——当前代码库无任何写这一列的路径，见交付报告）');
    // 挂牌逻辑独立于 direct_release 字段生效（授权活跃 + 花名册全完成 → 应正常挂牌，证明该字段真的
    // "毫无影响"，而不是恰好绕过了一条本该报错的路径）。
    // [codex 382 预筛 M3 收口] 本组是全文件第一个跑 submit 的组，早于任何 setDutyToday 调用（同 [2] 组
    // 头部注释同款前提："当日确无排班"是本文件用例编排顺序保证的自然初始状态，非碰运气）——故挂牌集合
    // 行数不是"视值班而定的不确定值"，是可精确推导的 0：结果**必为** 0/0 语义。此前用 `<= 1` 宽松上界
    // 只能防"多插行"这一种坏法，测不出"该挂 0 行的场景被错误判成有值班从而插了 1 行"这另一种坏法——
    // 改精确断言 =0，两种坏法都能抓到。同时补 timeline 行数断言：授权活跃 + 花名册全完成 ⇒ 挂牌事件
    // 本身必然发生（与是否有值班无关，同 [2]/[3] 组已验证的独立性），若挂牌闸门被 direct_release=true
    // 意外短路（例如误判该字段仍需拦截），本条 timeline 断言会先于 feAfter 断言暴露。
    const feAfter = await fastExecRows(id);
    assert.strictEqual(feAfter.length, 0, `[1] 挂牌集合行数应恰为 0（本组跑在任何 setDutyToday 之前，当日确无排班，0/0 语义精确成立，非"≤1 视值班而定"的宽松上界），实得 ${feAfter.length}`);
    const tl1 = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(tl1.length, 1, `[1] timeline 应恰 1 条 fast_release_staged（授权活跃 + 花名册全完成 ⇒ 挂牌事件必发生，direct_release=true 不应短路本闸门），实得 ${tl1.length}`);
    assert.strictEqual(await globalDirectOnlineTimelineCount(), beforeGlobalDirect, '[1] 全库 fast_release_direct_online 行数应无新增（应恒为 0，该 action_code 已无任何写入点）');
    assert.strictEqual(await globalFastExecCount() - beforeGlobalFe, feAfter.length, '[1] 挂牌集合新增行数应等于本单挂牌行数（未串到别的单）');
    ok('[1] 兼容负例：direct_release=true 的 legacy payload（即便当前授权活跃）⇒ 行为与普通 submit 完全一致——待验证 + 零翻牌 + 全库零 fast_release_direct_online 行 + 响应不带 online_source + 挂牌逻辑独立生效不受该字段影响（挂牌集合精确 0 行 + fast_release_staged timeline 精确 1 条）');
  }

  // ══════════════════════════ [2] 挂牌正例·当日无值班（0/0 语义） ══════════════════════════
  //   ⚠️ 必须在任何 setDutyToday 调用之前跑——本组依赖"当日真的无排班"这一自然初始状态。
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '挂牌-无值班');
    const dutyCheck = await get(`SELECT COUNT(*) c FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    assert.strictEqual(dutyCheck.c, 0, '[2-前置] 当日应确无排班（后续组才会插入，顺序前置条件）');
    const beforeTl = await timelineCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[2] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', `[2] main_status 应为「待验证」，实得 ${r.body.main_status}`);
    // 若"当日无值班 ⇒ 不 INSERT"这条分支写反（变成"无值班也插一行"），本条会红。
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 0, `[2] sys_fast_release_executors 应恰 0 行（当日无值班，0/0 语义），实得 ${feRows.length}`);
    // 若"挂牌事件本身仍要写 timeline"这条要求被漏实现（把 timeline 写点也塞进"有值班才写"的分支里），
    // 本条会红——挂牌 timeline 行与是否有值班是两件独立的事。
    const tl = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(tl.length, 1, `[2] timeline 应恰 1 条 fast_release_staged（挂牌事件本身发生了，与是否有值班无关），实得 ${tl.length}`);
    assert.strictEqual(tl[0].event_type, 'note', '[2] timeline event_type 应为 note');
    assert.ok(tl[0].summary.includes('当日无值班'), `[2] summary 应含"当日无值班"措辞，实得="${tl[0].summary}"`);
    assert.ok((await timelineCount(id)) > beforeTl, '[2] timeline 应有新增（至少含挂牌行 + runWGate 镜像行）');
    ok('[2] 挂牌正例·当日无值班：待验证 + sys_fast_release_executors 0 行 + timeline fast_release_staged 一行照写（0/0 语义，挂牌事件与执行人集合是否非空是两件独立的事）');
  }

  // ══════════════════════════ [3] 挂牌正例·当日有值班 ══════════════════════════
  {
    await setDutyToday(20, '值班员甲');
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '挂牌-有值班');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[3] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', `[3] main_status 应为「待验证」，实得 ${r.body.main_status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[3] sys_fast_release_executors 应恰 1 行，实得 ${feRows.length}`);
    assert.strictEqual(feRows[0].user_id, 20, '[3] 执行人 user_id 应为当日值班人（20）');
    assert.strictEqual(feRows[0].user_name, '值班员甲', '[3] 执行人 user_name 应为当日值班人姓名');
    assert.strictEqual(feRows[0].exec_status, 'pending', '[3] exec_status 应为 pending（默认值，未标记完成）');
    // added_by 必须是 submit 操作者（dev5），不是 admin/值班人本人——若实现误用 actor 之外的身份（例如
    // 误填 admin.id 或值班人自己的 id），本条会红。
    assert.strictEqual(feRows[0].added_by, 5, '[3] added_by 应为本次 submit 操作者 dev5 的 id');
    assert.strictEqual(feRows[0].added_by_name, '开发王', '[3] added_by_name 应为本次 submit 操作者姓名');
    assert.strictEqual(feRows[0].removed_at, null, '[3] 新挂牌行应未软删');
    const tl = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(tl.length, 1, `[3] timeline 应恰 1 条 fast_release_staged，实得 ${tl.length}`);
    assert.ok(tl[0].summary.includes('值班员甲'), `[3] summary 应含值班人姓名"值班员甲"，实得="${tl[0].summary}"`);
    assert.strictEqual(tl[0].operator_id, 5, '[3] timeline operator_id 应为 submit 操作者');
    ok('[3] 挂牌正例·当日有值班：待验证 + sys_fast_release_executors 恰 1 行 pending（user=值班人/added_by=submit 操作者）+ timeline fast_release_staged 一行（summary 含值班人姓名）');
  }

  // ══════════════════════════ [4] 无授权 ⇒ 零挂牌（对照组） ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    // 刻意不调用 authorize()——花名册全完成时应正常推进待验证，但不应挂牌（无论当日是否有值班，
    // [3] 已把值班配好，此组恰好验证"有值班也不代表会挂牌，挂牌的必要条件是活跃授权"）。
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[4] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', `[4] main_status 应为「待验证」，实得 ${r.body.main_status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 0, `[4] 无授权时 sys_fast_release_executors 应恰 0 行（即便当日有值班），实得 ${feRows.length}`);
    const tl = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(tl.length, 0, `[4] timeline 不应有 fast_release_staged 行，实得 ${tl.length}`);
    ok('[4] 无授权 ⇒ 零挂牌（对照组）：正常推进待验证，但 sys_fast_release_executors 与 fast_release_staged timeline 行均为 0——挂牌的必要条件是活跃授权，非"当日有值班"');
  }

  // ══════════════════════════ [5] 挂牌只发生在状态真翻转路径（多开发场景） ══════════════════════════
  {
    const id = await bugAtChulizhongTwoDevs();
    await estimateFuture(id);
    await authorize(id, adminTok, '挂牌-多开发非末位');
    // dev5 先提交（非最后一人，dev6 仍 pending）——roster 未全完成，runWGate 应 changed=false。
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r1.status, 200, `[5-前置a] dev5 提交应 200，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.main_status, '处理中', `[5-前置a] dev6 仍 pending，主状态应维持「处理中」，实得 ${r1.body.main_status}`);
    // 即便授权活跃、当日有值班（[3] 已配好），非末位提交也不应挂牌——若实现误把挂牌判据写成"只看
    // isActiveFastReleaseAuth 不看 gateResult.changed"，本条会红。
    assert.strictEqual((await fastExecRows(id)).length, 0, '[5-a] dev5（非末位）提交后不应挂牌：sys_fast_release_executors 应仍 0 行');
    assert.strictEqual((await timelineRowsByCode(id, 'fast_release_staged')).length, 0, '[5-a] dev5（非末位）提交后不应有 fast_release_staged timeline 行');

    // dev6 作为最后一位提交者提交——同一请求内自身 CAS 完成花名册，runWGate 应 changed=true, to='待验证'。
    const r2 = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r2.status, 200, `[5-b] dev6（末位）提交应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.main_status, '待验证', `[5-b] 花名册全完成，主状态应推进「待验证」，实得 ${r2.body.main_status}`);
    // 若实现把挂牌判据的触发时机挪错（例如挂在 dev5 那次提交上而非真正翻转状态的这次），本条会红。
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[5-b] dev6（末位）提交后应挂牌：sys_fast_release_executors 应恰 1 行，实得 ${feRows.length}`);
    assert.strictEqual(feRows[0].added_by, 6, '[5-b] added_by 应为触发真正翻转的那次提交操作者 dev6（非 dev5）');
    const tl = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(tl.length, 1, `[5-b] 应恰 1 条 fast_release_staged timeline 行，实得 ${tl.length}`);
    assert.strictEqual(tl[0].operator_id, 6, '[5-b] timeline operator_id 应为 dev6（真正触发翻转的提交者）');
    ok('[5] 挂牌只发生在状态真翻转路径：多开发场景下，非末位提交（gateResult.changed=false）零挂牌，末位提交（gateResult.changed=true）挂牌正常触发，且挂牌行 added_by/timeline operator_id 均归属真正触发翻转的那次提交操作者');
  }

  // ══════════════════════════ [5b]（codex 382 预筛 M1）挂牌资格复核：值班人已停用/降权 ⇒ 0/0 + 文案区分 ══════════════════════════
  //   复用 [3]/[5] 已配好的当日值班人（user 20·值班员甲）——此刻起停用/降权其账号，验证挂牌闸门是否
  //   正确拒绝把死账号写成 pending 执行人（不复核会导致 S3 后该集合永远无法全员 done，同 M2 注释①
  //   引用的 v1.151.1 同族前科：打回/重开会跳过停用成员）。⚠️ 本组末尾必须把 user 20 复位回合格态
  //   （status=active, role=user）——实测确认 [11a] 组仍依赖当日值班人保持合格（其"该轮提交时授权
  //   仍活跃，应已合法挂牌 1 行"这条基线断言若不复位会被本组制造的降权/停用状态误伤，首次实现漏了
  //   复位步骤时已实测踩中此红灯，见交付报告红灯记录）。
  {
    // [5b-1] 值班人已停用（status→inactive）——排班行留存但账号事后停用，真实生产场景。
    await run(`UPDATE users SET status='inactive' WHERE id=20`);
    const id1 = await bugAtChulizhong();
    await estimateFuture(id1);
    await authorize(id1, adminTok, '挂牌-值班人已停用');
    const r1 = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r1.status, 200, `[5b-1] submit 应 200，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.main_status, '待验证', `[5b-1] main_status 应为「待验证」，实得 ${r1.body.main_status}`);
    // 若资格复核漏加/写反，停用账号会被当合格值班人插入 pending 执行行——本条会红。
    const fe1 = await fastExecRows(id1);
    assert.strictEqual(fe1.length, 0, `[5b-1] 值班人已停用 ⇒ 挂牌集合应恰 0 行（不应把停用账号写成 pending 执行人），实得 ${fe1.length}`);
    const tl1 = await timelineRowsByCode(id1, 'fast_release_staged');
    assert.strictEqual(tl1.length, 1, `[5b-1] timeline 应恰 1 条 fast_release_staged（挂牌事件本身仍发生，只是不落执行人行），实得 ${tl1.length}`);
    // 文案须区分"当日值班已无执行资格" vs "当日无值班"两种成因——若实现把两种 0/0 场景合并成同一句
    // 文案，运维排查时无法分清是排班空缺还是账号状态变化，本条对照断言会抓到这种合并。
    assert.ok(tl1[0].summary.includes('当日值班已无执行资格'), `[5b-1] summary 应含"当日值班已无执行资格"措辞，实得="${tl1[0].summary}"`);
    assert.ok(!tl1[0].summary.includes('当日无值班'), `[5b-1-对照] summary 不应落入"当日无值班"分支文案（证明走的是资格不足分支而非排班缺失分支），实得="${tl1[0].summary}"`);

    // [5b-2] 值班人资格恢复 status，改从 role 维度降权（role='viewer'）——hasReleaseEligibility 的两个
    //   disqualify 维度（status≠active / role∈{viewer,admin}）须各自独立能测出，不能只覆盖其中一个。
    await run(`UPDATE users SET status='active', role='viewer' WHERE id=20`);
    const id2 = await bugAtChulizhong();
    await estimateFuture(id2);
    await authorize(id2, adminTok, '挂牌-值班人已降权');
    const r2 = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r2.status, 200, `[5b-2] submit 应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    const fe2 = await fastExecRows(id2);
    assert.strictEqual(fe2.length, 0, `[5b-2] 值班人已降为 viewer ⇒ 挂牌集合应恰 0 行，实得 ${fe2.length}`);
    const tl2 = await timelineRowsByCode(id2, 'fast_release_staged');
    assert.strictEqual(tl2.length, 1, `[5b-2] timeline 应恰 1 条 fast_release_staged，实得 ${tl2.length}`);
    assert.ok(tl2[0].summary.includes('当日值班已无执行资格'), `[5b-2] summary 应含"当日值班已无执行资格"措辞，实得="${tl2[0].summary}"`);

    // 复位：user 20 恢复原始合格状态（status=active, role=user）——[11a] 组的基线断言依赖当日值班人
    // 仍合格，不复位会被本组的降权/停用状态误伤（见本组头部注释，首次实现已实测踩中过这条红灯）。
    await run(`UPDATE users SET status='active', role='user' WHERE id=20`);

    ok('[5b] 挂牌资格复核（codex 382 预筛 M1）：值班人已停用（status=inactive）/已降权（role=viewer）两个 disqualify 维度均正确走 0/0 分支（不写死账号进 pending 执行人）+ timeline summary 用"当日值班已无执行资格"与"当日无值班"两种成因分文案（组末已复位 user 20，不影响后续组）');
  }

  // ══════════════════════════ [5c]（codex 383-M2）挂牌闸显式 type 钳制：非 bug 单伪造活跃授权六列 ⇒ 零挂牌 ══════════════════════════
  //   isActiveFastReleaseAuth 六列本身对全部 type 都存在且无 DB 层 CHECK 绑定 type='bug'——授权端点
  //   正常业务路径下只会给 bug 单写 fast_release_auth_at（"仅 bug 类型可先行上线授权"），但脏数据/人工
  //   SQL 修复/未来写点漂移可能让一张 improvement/feature 单带着"看似活跃"的六列值进入待验证。挂牌闸门
  //   现已显式加 row.type==='bug' 钳制（index.js :8309），本组用 SQL 造态直接给一张 improvement 单伪造
  //   六列，绕过 authorize() 端点自身的 type 闸（该端点本就只服务 bug，不是本组要测的对象），验证挂牌
  //   闸门这道独立防线本身是否生效。
  //   ⚠️ 类型选用 improvement 而非 coordinator 原话的 "feature"：improvement 走 runWGate 的二元判定
  //   （同 bug 逐字同款逻辑，:3427 一带），单开发单花名册全完成后 gateResult.to **确定性**落在
  //   SF.SYS_VERIFY_STATUSES.improvement[0]='待验证'；feature 走决策树分支，默认路径落 LIAISON_TEST
  //   而非 VERIFY（需触发 liaison_test_skip_liaison/_excused 等额外降级条件才会落 VERIFY），会让"是否
  //   进入 VERIFY"这第一层判据本身就先行为假，测不到 `row.type==='bug'` 这一新增钳制到底有没有生效——
  //   本组要精确测的是"即便前两个条件都为真（真进 VERIFY + 六列看似活跃），第三个条件 type==='bug' 单独
  //   把它挡下来"，improvement 是能达成这个精确前提的最简类型，测试意图不变，只是选了更强的验证路径。
  {
    const idImp = await mkIssue('improvement');
    // improvement/feature 受理须带 risk_level（本文件其余夹具全用 bug，未触发过这条闸；同款取值参照
    // verify-sys-effort-c7.js 既有夹具"二级"）。
    const accImp = await call('POST', `/api/sys-issues/${idImp}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(accImp.status, 200, `[5c-夹具-受理] 应 200，实得 ${accImp.status} ${JSON.stringify(accImp.body)}`);
    // improvement/feature 指派前须先补 OA 流程号（同 verify-sys-effort-c7.js 既有夹具手法）。
    const oaImp = await call('POST', `/api/sys-issues/${idImp}/set-oa-number`, adminTok, { oa_number: '2260814001' });
    assert.strictEqual(oaImp.status, 200, `[5c-夹具-补OA] 应 200，实得 ${oaImp.status} ${JSON.stringify(oaImp.body)}`);
    const asgImp = await call('POST', `/api/sys-issues/${idImp}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asgImp.status, 200, `[5c-夹具-指派] 应 200，实得 ${asgImp.status} ${JSON.stringify(asgImp.body)}`);
    await estimateFuture(idImp, devTok, { estimated_effort_days: 3 });
    // SQL 造态伪造"看似活跃"的授权六列——不经过 authorize() 端点（该端点本身的 type 闸不是本组测试对象，
    // 本组要单独证明挂牌闸门自己也不信任 type，即便六列被绕过端点闸门直接落库依然拦得住）。
    await run(
      `UPDATE sys_issues SET fast_release_auth_at = datetime('now','localtime'), fast_release_auth_by = 1,
         fast_release_auth_by_name = '管理员', fast_release_auth_note = '[5c] 注入-非bug型伪造活跃授权',
         fast_release_revoked_at = NULL, fast_release_consumed_at = NULL, released_at = NULL, online_source = NULL
       WHERE id = ?`,
      [idImp]
    );
    const injected = await get(
      `SELECT fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at, released_at, online_source, reopened_at
         FROM sys_issues WHERE id = ?`, [idImp]);
    assert.ok(I.isActiveFastReleaseAuth(injected),
      '[5c-前置] 造态后 isActiveFastReleaseAuth(row) 应判 true（六列确已伪造成"看似活跃"，本组前提成立，否则下方断言测不到 type 钳制）');
    // improvement 单不适用 bug_cause_note 字段（submitBody 默认带该键——本文件其余夹具全走 bug 类型，
    // 首次沿用默认 submitBody() 时在此撞了 400 BUG_CAUSE_NOT_APPLICABLE，已实测并修正）；显式传
    // undefined 令 JSON.stringify 序列化时整键消失，而非传空串（空串仍是"传了值"会被同一闸拒）。
    const rImp = await call('POST', `/api/sys-issues/${idImp}/submit`, devTok, submitBody({ mode: 'commits', extra: { bug_cause_note: undefined } }));
    assert.strictEqual(rImp.status, 200, `[5c] submit 应正常 200，实得 ${rImp.status} ${JSON.stringify(rImp.body)}`);
    assert.strictEqual(rImp.body.main_status, '待验证', `[5c] main_status 应正常推进「待验证」（type 钳制不应阻断正常 submit 流程本身，只应阻断挂牌副作用），实得 ${rImp.body.main_status}`);
    const feImp = await fastExecRows(idImp);
    assert.strictEqual(feImp.length, 0, `[5c] sys_fast_release_executors 应恰 0 行（type≠'bug'，挂牌闸门应拦下，即便六列看似活跃），实得 ${feImp.length}`);
    const tlImp = await timelineRowsByCode(idImp, 'fast_release_staged');
    assert.strictEqual(tlImp.length, 0, `[5c] timeline 不应有 fast_release_staged 行（同上，type 钳制生效则挂牌事件本身不应发生），实得 ${tlImp.length}`);
    ok('[5c] 挂牌闸显式 type 钳制（codex 383-M2）：improvement 单即便被 SQL 造态伪造出"看似活跃"的授权六列，正常 submit 仍推进待验证但零挂牌（零执行人行 + 零 fast_release_staged timeline 行），证明挂牌闸门不完全信任六列判据"结构上只对 bug 单成立"这条隐含前提，type 钳制这道独立防线本身生效');
  }

  // ══════════════════════════ [6] last_completed_at 正常路径（拆直上后基础判据仍正确） ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, 'last_completed_at 正常路径');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[6-前置] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[6-前置] 应进入待验证');
    // runWGate 镜像行：event_type='status_change', to_status='待验证', action_code IS NULL（bug 类型走
    // 二元逻辑，mirrorActionCode 恒 null）——用它的 created_at 作为 last_completed_at 的期望值。
    const mirrorRow = await get(
      `SELECT created_at FROM sys_issue_timeline WHERE issue_id=? AND event_type='status_change' AND to_status='待验证' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(mirrorRow && mirrorRow.created_at, '[6-前置] 应已落一条 status_change→待验证 的 timeline 行（runWGate 镜像行）');

    const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail.status, 200, `[6-详情] 应 200，实得 ${detail.status}`);
    // 若拆直上时误删了整个 OR 子句而非只删旧码那半支（例如连 to_status='待验证' 主分支也被误伤），
    // 本条会红——last_completed_at 会变成 NULL 或取到错误的行。
    assert.strictEqual(detail.body.issue.last_completed_at, mirrorRow.created_at, `[6-详情] last_completed_at 应等于 runWGate 镜像行 created_at，实得 ${detail.body.issue.last_completed_at} vs ${mirrorRow.created_at}`);

    const listR = await call('GET', '/api/sys-issues?page_size=500', adminTok);
    assert.strictEqual(listR.status, 200, `[6-列表] 应 200，实得 ${listR.status}`);
    const row = (listR.body.items || []).find(x => x.id === id);
    assert.ok(row, `[6-列表] 应含该单据 id=${id}`);
    assert.strictEqual(row.last_completed_at, mirrorRow.created_at, `[6-列表] last_completed_at 应等于 runWGate 镜像行 created_at，实得 ${row.last_completed_at} vs ${mirrorRow.created_at}`);
    assert.strictEqual(row.last_completed_at, detail.body.issue.last_completed_at, '[6-列表/详情同源] 两处子查询取值应完全一致（codex 263 M-1 契约）');
    ok('[6] last_completed_at 正常路径：挂牌单进入待验证后，列表/详情两端点均正确取到 runWGate 镜像行的 created_at，两处子查询同源一致（拆直上删除旧码析取分支后，基础"进待验证"判据本身未受损）');
  }

  // ══════════════════════════ [7] 不变量①②③⑦探针（[Y5] 范式，未受 S2 影响） ══════════════════════════
  {
    assert.strictEqual(typeof I.fastlaneAcceptanceInvariantViolations, 'function', '[7-前置] fastlaneAcceptanceInvariantViolations 应已导出');

    const V_PENDING = { online_source: 'authorized_fastlane', post_release_acceptance: 'pending', post_accepted_at: null, post_derive_issue_id: null, released_at: '2026-08-13 10:00:00', release_id: null, fast_release_consumed_at: '2026-08-13 10:00:00', status: '已上线' };
    const V_PASSED = { ...V_PENDING, post_release_acceptance: 'passed', post_accepted_at: '2026-08-14 09:00:00' };
    const V_FAILED_DERIVED = { ...V_PENDING, post_release_acceptance: 'failed_derived', post_derive_issue_id: 999 };
    for (const [tag, row] of [['pending', V_PENDING], ['passed', V_PASSED], ['failed_derived', V_FAILED_DERIVED]]) {
      assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(row), [], `[7a-正例-${tag}] 应无违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(row))}`);
    }
    const V_NON_FASTLANE = { online_source: null, post_release_acceptance: null, post_accepted_at: null, post_derive_issue_id: null, released_at: null, release_id: null, fast_release_consumed_at: null, status: '处理中' };
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(V_NON_FASTLANE), [], '[7a-正例-非fastlane] 全空行应无违例');
    ok('[7a-正例] fastlaneAcceptanceInvariantViolations 4 正例（pending/passed/failed_derived/非fastlane全空）全放行');

    const badCases = [
      ['①-fastlane但acceptance空', { ...V_PENDING, post_release_acceptance: null }],
      ['①-acceptance非空但非fastlane', { ...V_PENDING, online_source: null }],
      ['②-值域外字符串', { ...V_PENDING, post_release_acceptance: 'bogus_value' }],
      ['②-pending但accepted_at非空', { ...V_PENDING, post_accepted_at: '2026-08-14 09:00:00' }],
      ['②-pending但derive_id非空', { ...V_PENDING, post_derive_issue_id: 999 }],
      ['②-passed但accepted_at为空', { ...V_PASSED, post_accepted_at: null }],
      ['②-failed_derived但derive_id为空', { ...V_FAILED_DERIVED, post_derive_issue_id: null }],
      ['③-fastlane但released_at为空', { ...V_PENDING, released_at: null }],
      ['③-fastlane但release_id非空', { ...V_PENDING, release_id: 42 }],
      ['③-fastlane但status非已上线', { ...V_PENDING, status: '处理中' }],
      ['⑦-fastlane但consumed_at为空', { ...V_PENDING, fast_release_consumed_at: null }],
    ];
    for (const [tag, row] of badCases) {
      const v = I.fastlaneAcceptanceInvariantViolations(row);
      assert.ok(v.length > 0, `[7a-反例-${tag}] 应判红，实得 ${JSON.stringify(v)}`);
    }
    ok(`[7a-反例] fastlaneAcceptanceInvariantViolations ${badCases.length} 反例（①双向+②值域与四绑定+③三条+⑦一条）全判红`);

    const FL_CANDIDATE_SQL = `SELECT id, online_source, post_release_acceptance, post_accepted_at, post_derive_issue_id,
              released_at, release_id, fast_release_consumed_at, status
         FROM sys_issues
        WHERE online_source IS NOT NULL OR post_release_acceptance IS NOT NULL
           OR post_accepted_at IS NOT NULL OR post_derive_issue_id IS NOT NULL`;
    const fastlaneViolationCount = async (allFn) => {
      const rows = await allFn(FL_CANDIDATE_SQL);
      let total = 0;
      for (const row of rows) total += I.fastlaneAcceptanceInvariantViolations(row).length;
      return total;
    };

    const inj1 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source = 'authorized_fastlane', status = '已上线' WHERE id = ?`, [inj1]);
    let cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[7b-①] ★对照组：online_source=authorized_fastlane 但 acceptance 空应判红，实得 ${cnt}`);
    ok(`[7b-①] ★对照组：①注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source = NULL WHERE id = ?`, [inj1]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-①] 清理注入行后应恢复 0');

    const inj2 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', post_accepted_at='2026-08-14 09:00:00', released_at='2026-08-13 10:00:00', fast_release_consumed_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj2]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[7b-②] ★对照组：pending 但 accepted_at 非空应判红，实得 ${cnt}`);
    ok(`[7b-②] ★对照组：②注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, post_accepted_at=NULL, released_at=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj2]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-②] 清理注入行后应恢复 0');

    const inj3 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', release_id=42, fast_release_consumed_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj3]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[7b-③] ★对照组：fastlane 但 release_id 非空应判红，实得 ${cnt}`);
    ok(`[7b-③] ★对照组：③注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL, release_id=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj3]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-③] 清理注入行后应恢复 0');

    const inj3b = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', fast_release_consumed_at='2026-08-13 10:00:00', status='处理中' WHERE id = ?`, [inj3b]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[7b-③b] ★对照组：fastlane 但 status='处理中'（非已上线）应判红，实得 ${cnt}`);
    ok(`[7b-③b] ★对照组：③状态绑定注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj3b]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-③b] 清理注入行后应恢复 0');

    const inj4 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj4]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[7b-⑦] ★对照组：fastlane 但 consumed_at 为空应判红，实得 ${cnt}`);
    ok(`[7b-⑦] ★对照组：⑦注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL WHERE id = ?`, [inj4]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-⑦] 清理注入行后应恢复 0');

    const inj5 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='' WHERE id = ?`, [inj5]);
    const rowInj5 = await get(`SELECT online_source, post_release_acceptance, post_accepted_at, post_derive_issue_id, released_at, release_id, fast_release_consumed_at, status FROM sys_issues WHERE id=?`, [inj5]);
    const v5 = I.fastlaneAcceptanceInvariantViolations(rowInj5);
    assert.ok(v5.length > 0 && v5.some(m => m.includes('post_release_acceptance 为空')), `[7b-空串] 空串应判红且落①分支，实得 ${JSON.stringify(v5)}`);
    ok(`[7b-空串] ★对照组：post_release_acceptance='' 视同空（①分支判红），实得 ${JSON.stringify(v5)}`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL WHERE id = ?`, [inj5]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[7b-空串] 清理注入行后应恢复 0');

    const realDbPath = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath)) {
      const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realCols = await new Promise((resolve, reject) => realDb.all(`PRAGMA table_info(sys_issues)`, (e, r) => e ? reject(e) : resolve(r)));
      const realColNames = realCols.map(c => c.name);
      const needCols = ['online_source', 'post_release_acceptance', 'post_accepted_at', 'post_derive_issue_id', 'released_at', 'release_id', 'fast_release_consumed_at', 'status'];
      if (needCols.every(c => realColNames.includes(c))) {
        const rows = await realAll(FL_CANDIDATE_SQL);
        let total = 0;
        for (const row of rows) total += I.fastlaneAcceptanceInvariantViolations(row).length;
        assert.strictEqual(total, 0, `[7c] 真实本地库补验收字段组违例计数应为 0，实得 ${total}（候选行 ${rows.length} 条）`);
        ok(`[7c] ⭐⭐ 真实本地库（task_pool.db）先行上线补验收字段组探针：${needCols.length} 列全在 + 候选行 ${rows.length} 条，违例计数=0`);
      } else {
        ok('[7c] 真实本地库缺补验收三列——环境相关跳过，非探针本身问题');
      }
      realDb.close();
    } else {
      ok('[7c] 真实本地库 task_pool.db 不存在——环境相关跳过（CI/新环境无本地库属正常）');
    }
  }

  // ══════════════════════════ [8] online_source 消费面（夹具改 SQL 造态） ══════════════════════════
  {
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: 10, online_source: null }), 'release_publish', '[8a] release_id 非空应判 release_publish');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'no_commit_acceptance' }), 'no_commit_acceptance', '[8a] no_commit_acceptance 应判 no_commit_acceptance');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'authorized_fastlane' }), 'authorized_fastlane', '[8a] authorized_fastlane 应判 authorized_fastlane');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: null }), 'unknown_legacy', '[8a] 三者皆无应判 unknown_legacy');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'some_future_kind' }), 'unknown_legacy', '[8a] 未识别的非空值不应被误判为已知分支');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '处理中', release_id: null, online_source: 'authorized_fastlane' }), null, '[8a] status 非「已上线」时恒返回 null');
    ok('[8a] deriveOnlineSourceKind 直调：四分支穷举 + 非已上线态恒 null + 未识别值严格判 unknown_legacy（该函数只读现值字段，写入路径变化不影响其正确性）');

    // [8b] SQL 造态构造"已上线+authorized_fastlane"状态——原经 submit direct_release=true 真实链路已随
    //   S2-2 拆除不可达，deriveOnlineSourceKind/列表/详情三处消费面只关心现值字段，造态验证完全等价，
    //   非弱化断言。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '消费面-详情（造态）');
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'),
      online_source='authorized_fastlane', post_release_acceptance='pending',
      fast_release_consumed_at=datetime('now','localtime') WHERE id=?`, [id]);
    const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail.status, 200, `[8b] 详情应 200，实得 ${detail.status}`);
    assert.strictEqual(detail.body.issue.online_source_kind, 'authorized_fastlane', `[8b] 详情端点 issue.online_source_kind 应为 authorized_fastlane，实得 ${detail.body.issue.online_source_kind}`);
    assert.strictEqual(detail.body.issue.status, '已上线', '[8b] 详情端点 issue.status 应为「已上线」');
    ok('[8b] 详情端点消费面（SQL 造态）：online_source_kind 正确投影为 authorized_fastlane');

    const listR = await call('GET', '/api/sys-issues?page_size=500', adminTok);
    assert.strictEqual(listR.status, 200, `[8c] 列表应 200，实得 ${listR.status}`);
    const row = (listR.body.items || []).find(x => x.id === id);
    assert.ok(row, `[8c] 列表应含该单据 id=${id}`);
    assert.strictEqual(row.online_source_kind, 'authorized_fastlane', `[8c] 列表端点该行 online_source_kind 应为 authorized_fastlane，实得 ${row.online_source_kind}`);
    ok('[8c] 列表端点消费面（同一 SQL 造态单）：online_source_kind 正确投影为 authorized_fastlane（与详情端点同一判据，读点不分裂）');

    // [8d] 前端字典覆盖——静态源码扫描。SI_TL_LABEL 的检查对象改为 fast_release_staged（旧码
    //   fast_release_direct_online 词条已随写入点删除，见 Sys_Iteration.html S2-2 拆除记录）。
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    assert.ok(/SI_ONLINE_SOURCE_LABEL\s*=\s*\{[^}]*authorized_fastlane\s*:\s*'先行上线'/.test(htmlSrc),
      '[8d] Sys_Iteration.html 的 SI_ONLINE_SOURCE_LABEL 应含 authorized_fastlane: \'先行上线\' 词条（该值域字面量未受拆直上影响，S3+ 仍会复用）');
    assert.ok(!/fast_release_direct_online/.test(htmlSrc),
      '[8d] Sys_Iteration.html 不应再出现 fast_release_direct_online 任何形态引用（零存量死词条已随 S2-2 清除）');
    assert.ok(/SI_TL_LABEL\s*=\s*\{[\s\S]*?fast_release_staged\s*:\s*'先行上线挂牌'/.test(htmlSrc),
      '[8d] Sys_Iteration.html 的 SI_TL_LABEL 应含 fast_release_staged: \'先行上线挂牌\' 新词条');
    const hotfixLines = htmlSrc.split('\n').filter(l => /应急建单|应急一键|hotfix-publish/.test(l));
    const overlapLines = hotfixLines.filter(l => /先行上线|直上|挂牌/.test(l));
    assert.strictEqual(overlapLines.length, 0, `[8d] hotfix 相关文案行不应与"先行上线/直上/挂牌"措辞出现在同一行，实得重叠 ${overlapLines.length} 行：${JSON.stringify(overlapLines)}`);
    ok('[8d] 前端字典静态覆盖：SI_ONLINE_SOURCE_LABEL 仍含 authorized_fastlane 词条 + 全文零残留 fast_release_direct_online + SI_TL_LABEL 新增 fast_release_staged 词条 + 与 hotfix 文案 grep 全文无重叠行');

    const effSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'efficiency-stats.js'), 'utf8');
    assert.ok(!/[=!]==?\s*['"]authorized_fastlane['"]/.test(effSrc), '[8e] efficiency-stats.js 不应出现按 authorized_fastlane 分支判据的代码（有意合并统计，不按来源分流）');
    ok('[8e] efficiency-stats.js 豁免确认：不消费 online_source（按 released_at 统一合并统计）');
  }

  // ══════════════════════════ [9]（S3 改名重写）assertMainStatusTransition FAST_RELEASE_CONFIRM routeKind 单元覆盖 ══════════════════════════
  //   [S3·§4-4b] 原 FAST_RELEASE_DIRECT routeKind（S2 拆直上后曾是"保留但无生产调用方"的死代码）已原地
  //   改名为 FAST_RELEASE_CONFIRM，边形状同步重写（before：DEV 态 → 待验证；action：'submit' →
  //   'fast_release_exec_confirm'），且**不再是死代码**——共享翻牌内核 attemptFastReleaseFlipInTxn 是
  //   真实生产调用方（见 index.js 该函数定义处）。本组用例逐条对齐新边形状。
  {
    const guardPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'status-transition-guard.js');
    const { assertMainStatusTransition, MainStatusGuardError } = require(guardPath);

    const ok1 = assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_CONFIRM', action: 'fast_release_exec_confirm', actionKind: null, issueType: 'bug',
      before: '待验证', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    });
    assert.deepStrictEqual(ok1, { ok: true, afterFamily: 'RELEASE' }, '[9a] 合法边（待验证→已上线，roster 满足）应放行，afterFamily=RELEASE');
    ok('[9a] FAST_RELEASE_CONFIRM 合法边（待验证→已上线，roster 在册1/全完成）放行，afterFamily=RELEASE');

    assert.throws(() => assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_CONFIRM', action: 'accept', actionKind: null, issueType: 'bug',
      before: '待验证', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    }), MainStatusGuardError, '[9b] action≠fast_release_exec_confirm 应抛 MainStatusGuardError');
    ok('[9b] FAST_RELEASE_CONFIRM action≠\'fast_release_exec_confirm\' 拒绝（fail-closed，本入口只服务一条边）');

    assert.throws(() => assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_CONFIRM', action: 'fast_release_exec_confirm', actionKind: null, issueType: 'bug',
      before: '处理中', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    }), MainStatusGuardError, '[9c] before=处理中 应拒（旧边"DEV 态→已上线"已随改名废弃，不再放行）');
    ok('[9c] FAST_RELEASE_CONFIRM 边非法（before=处理中而非待验证——旧边已废弃）拒绝');

    let rosterErr = null;
    try {
      assertMainStatusTransition({
        routeKind: 'FAST_RELEASE_CONFIRM', action: 'fast_release_exec_confirm', actionKind: null, issueType: 'bug',
        before: '待验证', after: '已上线', rosterActiveCount: 2, rosterAllComplete: false,
      });
    } catch (e) { rosterErr = e; }
    assert.ok(rosterErr instanceof MainStatusGuardError, '[9d] roster 未全完成应抛 MainStatusGuardError');
    assert.strictEqual(rosterErr.httpStatus, 400, `[9d] roster 门失败应为 400 语义，实得 ${rosterErr.httpStatus}`);
    ok('[9d] FAST_RELEASE_CONFIRM 进 RELEASE 族 roster 门：rosterAllComplete=false 拒（400）');
  }

  // ══════════════════════════ [10] reopen 清补验收字段组：真实链路（起点改 SQL 造态） ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '10-reopen清字段组');
    // 造态直接构造"已上线+authorized_fastlane+pending"——原起点（submit direct_release=true）已不可达，
    // 本组测的是 close 被拦/补验收/reopen 清字段这条**下游**不变量链，起点造态不影响该链路本身的正确性。
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'),
      online_source='authorized_fastlane', post_release_acceptance='pending',
      fast_release_consumed_at=datetime('now','localtime') WHERE id=?`, [id]);
    const afterDirect = await issueRow(id);
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(afterDirect), [], '[10-前置] 造态落库后应无违例');

    const closeBlocked = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeBlocked.status, 409, `[10-close-被拦] pending 态 close 应 409，实得 ${closeBlocked.status} ${JSON.stringify(closeBlocked.body)}`);
    assert.strictEqual(closeBlocked.body.code, 'POST_ACCEPTANCE_PENDING', `[10-close-被拦] 确切码，实得 ${closeBlocked.body.code}`);
    const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(praR.status, 200, `[10-补验收] pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);

    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[10-close] 补验收通过后 close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '验证重开清补验收字段组' });
    assert.strictEqual(reopenR.status, 200, `[10-reopen] 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);

    const afterReopen = await issueRow(id);
    assert.strictEqual(afterReopen.status, '处理中', '[10-reopen 后] status 应回到「处理中」');
    assert.strictEqual(afterReopen.online_source, null, '[10-reopen 后] online_source 应已清空');
    assert.strictEqual(afterReopen.post_release_acceptance, null, '[10-reopen 后] post_release_acceptance 应已清空');
    assert.strictEqual(afterReopen.post_accepted_at, null, '[10-reopen 后] post_accepted_at 应已清空');
    assert.strictEqual(afterReopen.post_derive_issue_id, null, '[10-reopen 后] post_derive_issue_id 应已清空');
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(afterReopen), [], `[10-reopen 后] fastlaneAcceptanceInvariantViolations 应零违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(afterReopen))}`);
    ok('[10] reopen 清补验收字段组（起点改 SQL 造态，下游链路走真实端点）：造态落库（online_source=authorized_fastlane/post_release_acceptance=pending）→ close 被拦 409 → 补验收 pass → close 放行 → reopen → 四列全清空 + 零违例');
  }

  // ══════════════════════════ [11] 授权须晚于最近一次 reopen（isActiveFastReleaseAuth 第六条件·语义随拆直上重定义） ══════════════════════════
  //   ⚠️ 语义变化：原 verify（组B·SB2 阶段）测的是"submit 前置闸拒绝(409)"——该闸随拆直上分支删除，
  //   现在测的是"挂牌闸静默跳过"：submit 本身仍 200 正常进入待验证，只是 isActiveFastReleaseAuth 判
  //   false 导致不挂牌，与普通"无授权"场景（[4] 组）外部表现相同，但成因不同（这里是"曾有授权但已因
  //   跨轮而失活"，[4] 是"从未授权"）。
  {
    // [11a] SQL 造态构造"reopen 之后仍挂着一份 auth_at 早于 reopened_at 的授权"（正常状态机已不会产出）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '11-纵深防御：授权早于reopen（造态）');
    // ⚠️ 这次 no_code 提交本身（单开发单，roster 一次性全完成）授权此刻仍活跃 ⇒ 会合法挂牌一行——
    //   这是本轮次的**正常挂牌**，不是本组要测的"跨轮悬垂"场景（那要等 reopen 之后才成立）。故先记下
    //   这次提交后的挂牌行数作为基线，下方 [11a] 的"零挂牌"断言改为"相对本轮次基线无新增"，不能写成
    //   绝对 0（写绝对 0 会被这次合法挂牌行误伤，把"测试自身基线算错"错报成"生产代码有 bug"）。
    const noCodeR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'no_code' }));
    assert.strictEqual(noCodeR.status, 200, `[11a-前置提交] 应 200，实得 ${noCodeR.status} ${JSON.stringify(noCodeR.body)}`);
    const feCountAfterFirstSubmit = (await fastExecRows(id)).length;
    assert.strictEqual(feCountAfterFirstSubmit, 1, '[11a-前置提交] 该轮提交时授权仍活跃，应已合法挂牌 1 行（本组基线，非本组要测的对象）');
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[11a-前置验收] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.online_source, 'no_commit_acceptance', '[11a-前置验收] 应走免上线直翻（与 fastlane 直上是两条不同的既有路径，此处只是借用它到达已上线态以触发 B1 终结事件）');
    const rowAfterAcceptTermination = await issueRow(id);
    assert.strictEqual(rowAfterAcceptTermination.fast_release_auth_at, null, '[11a-前置] accept 直翻已上线已同事务终结活跃授权（B1 既有行为，未受 S2 影响）');
    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[11a-前置关闭] 应 200，实得 ${closeR.status}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '负例验证（B1 后六列已空，reopen 无事可清）' });
    assert.strictEqual(reopenR.status, 200, `[11a-前置重开] 应 200，实得 ${reopenR.status}`);
    await run(
      `UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
              fast_release_auth_at = datetime(reopened_at, '-1 hour')
         WHERE id = ?`, [id]);
    const rowAfterInject = await issueRow(id);
    assert.ok(rowAfterInject.fast_release_auth_at, '[11a-造态] SQL 注入的 fast_release_auth_at 应已落库');
    await estimateFuture(id);
    const daBefore = await devAssigneeRow(id, 5);
    assert.strictEqual(daBefore.dev_status, 'pending', '[11a-前置] reopen 后新一轮 dev_assignee 实例应是全新 pending');
    const dirR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    // 若挂牌判据误把"跨轮悬垂授权"当活跃（即 isActiveFastReleaseAuth 第六条件失效），本条会以"新一轮
    // 又多挂了一行"的形式红（feCountAfterFirstSubmit+1）；若整条 submit 反而被误拦成非 200，同样会红。
    assert.strictEqual(dirR.status, 200, `[11a] 造态授权早于 reopen：submit 本身应正常 200（不再是 409——旧闸已删），实得 ${dirR.status} ${JSON.stringify(dirR.body)}`);
    assert.strictEqual(dirR.body.main_status, '待验证', `[11a] main_status 应为「待验证」，实得 ${dirR.body.main_status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, feCountAfterFirstSubmit, `[11a] 跨轮悬垂授权不应新增挂牌：sys_fast_release_executors 行数应与本轮次前基线一致（${feCountAfterFirstSubmit}），实得 ${feRows.length}`);
    assert.strictEqual((await timelineRowsByCode(id, 'fast_release_staged')).length, 1, '[11a] fast_release_staged timeline 行应恰 1 条（仅来自第一次合法提交那一条，本次新一轮提交不应再新增一条）');
    ok('[11a·语义重定义] 纵深防御负例：授权早于最近一次 reopen（造态构造）→ submit 200 正常进入待验证，但相对本轮次前基线零新增挂牌（isActiveFastReleaseAuth 第六条件在挂牌闸继续生效，不再是独立的 409 前置闸；基线本身来自 reopen 前那次合法挂牌，非本组测试对象）');

    // [11b] 对照组：reopen 之后重新授权（auth_at 晚于 reopened_at）→ submit 正常且挂牌触发。
    // ⚠️ 独立新夹具，不复用 [11a] 的 id——[11a] 最后那次 submit 已把该单推进到「待验证」（挂牌只是
    //   "跳过"不是"拒绝"，submit 本身照常成功翻状态），而 fast-release-authorize 端点的窗口仅
    //   ('待处理','处理中') 两态，「待验证」态调用会 409，无法在同一个单上接着测"reopen 后重新授权"。
    const id11b = await bugAtChulizhong();
    await estimateFuture(id11b);
    await authorize(id11b, adminTok, '11b 对照-首轮授权');
    const noCodeR11b = await call('POST', `/api/sys-issues/${id11b}/submit`, devTok, submitBody({ mode: 'no_code' }));
    assert.strictEqual(noCodeR11b.status, 200, `[11b-前置提交] 应 200，实得 ${noCodeR11b.status}`);
    // 首轮提交时授权仍活跃 ⇒ 合法挂牌 1 行（当日值班人 20，同 [3] 组配好的排班）——留作跨轮供轮基线。
    const feAfterRound1 = await fastExecRows(id11b);
    assert.strictEqual(feAfterRound1.length, 1, '[11b-前置提交] 首轮应已合法挂牌 1 行');
    assert.strictEqual(feAfterRound1[0].removed_at, null, '[11b-前置提交] 首轮挂牌行此刻应仍在册（未软删）');
    const acceptR11b = await call('POST', `/api/sys-issues/${id11b}/accept`, adminTok, {});
    assert.strictEqual(acceptR11b.status, 200, `[11b-前置验收] 应 200，实得 ${acceptR11b.status}`);
    await call('POST', `/api/sys-issues/${id11b}/close`, adminTok, {});
    const reopenR11b = await call('POST', `/api/sys-issues/${id11b}/reopen`, adminTok, { reason: '11b 对照：reopen 后重新授权' });
    assert.strictEqual(reopenR11b.status, 200, `[11b-前置重开] 应 200，实得 ${reopenR11b.status}`);
    const rowAfterReopen11b = await issueRow(id11b);
    assert.strictEqual(rowAfterReopen11b.fast_release_auth_at, null, '[11b-前置] reopen 后授权六列应已因 B1 终结而清空（新一轮尚未授权）');
    await estimateFuture(id11b);
    // 重新授权——此刻 auth_at 落在"现在"，必然晚于 reopened_at，isActiveFastReleaseAuth 应判 true。
    const authAfterReopen = await authorize(id11b, adminTok, '11 对照：reopen 后重新授权');
    assert.strictEqual(authAfterReopen.reauthorized, false, '[11b-前置] reopen 后六列已空，本次应是首次授权（非"重新授权"覆盖语义）');
    const dirR2 = await call('POST', `/api/sys-issues/${id11b}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(dirR2.status, 200, `[11b] reopen 后重新授权应能正常触发挂牌，实得 ${dirR2.status} ${JSON.stringify(dirR2.body)}`);
    assert.strictEqual(dirR2.body.main_status, '待验证', '[11b] main_status 应为「待验证」');
    // ⭐ [组B·S2-1 实测修复的正面覆盖] 跨轮再挂牌：第二轮同一 (issue_id, user_id=20) 组合若不先软删
    // 首轮遗留在册行会直接撞 partial UNIQUE 索引崩 500（本条断言实测抓到过这个真实 500，见交付报告）。
    // 全部行（含软删）应恰 2 条——首轮 1 条已被软删 + 本轮新插 1 条；在册（未软删）应恰 1 条——
    // 只有本轮这一条，首轮那条必须已被软删退出在册范围，代次不重叠。
    const feRowsAll = await fastExecRows(id11b);
    assert.strictEqual(feRowsAll.length, 2, `[11b] 全部行（含软删）应恰 2 条（首轮 1 条软删 + 本轮 1 条新插），实得 ${feRowsAll.length}`);
    const feActive = feRowsAll.filter(r => r.removed_at === null);
    assert.strictEqual(feActive.length, 1, `[11b] 在册（未软删）应恰 1 条，实得 ${feActive.length}`);
    assert.strictEqual(feActive[0].id, feRowsAll[1].id, '[11b] 在册那条应是本轮（后插入的）那一行，非首轮遗留');
    const feRemoved = feRowsAll.filter(r => r.removed_at !== null);
    assert.strictEqual(feRemoved.length, 1, `[11b] 已软删应恰 1 条（首轮遗留），实得 ${feRemoved.length}`);
    assert.strictEqual(feRemoved[0].id, feAfterRound1[0].id, '[11b] 被软删的应正是首轮那一行（同一 id）');
    ok('[11b] 对照组：reopen 之后重新授权（auth_at 晚于 reopened_at）→ submit 200 + 挂牌正常触发；且跨轮再挂牌前系统正确软删了首轮遗留在册行（全部 2 条=首轮软删 1+本轮新插 1，在册恰 1 条=本轮那条），未撞 UNIQUE 崩 500——证明纵深防御只挡"跨轮悬垂"，不误伤"reopen 后已补授权"这条合法路径，且跨轮代次交接干净');
  }

  // ══════════════════════════ [12] isActiveFastReleaseAuth 唯一判据 fail-closed（未受 S2 影响） ══════════════════════════
  {
    const rowMissingReopenedAt = {
      fast_release_auth_at: '2026-08-13 10:00:00', fast_release_revoked_at: null,
      fast_release_consumed_at: null, released_at: null, online_source: null,
    };
    assert.ok(!('reopened_at' in rowMissingReopenedAt), '[12a-前置] 夹具行确实不含 reopened_at 键');
    let thrown12a = null;
    try { I.isActiveFastReleaseAuth(rowMissingReopenedAt); } catch (e) { thrown12a = e; }
    assert.ok(thrown12a, '[12a] 缺 reopened_at 应抛错，未抛=静默绕过 fail-closed');
    assert.strictEqual(thrown12a.httpStatus, 500, `[12a] 应为 500，实得 ${thrown12a.httpStatus}`);
    assert.strictEqual(thrown12a.code, 'FAST_RELEASE_PREDICATE_INPUT_INVARIANT', `[12a] 确切码，实得 ${thrown12a.code}`);
    assert.strictEqual(thrown12a.message, '活跃授权判定缺少 reopened_at 投影（调用方 SELECT 必须含该列）', `[12a] 精确错误文案，实得="${thrown12a.message}"`);
    ok('[12a] isActiveFastReleaseAuth 缺 reopened_at 键：抛 500 FAST_RELEASE_PREDICATE_INPUT_INVARIANT + 精确文案，不静默判过');

    const rowAllPresent = { ...rowMissingReopenedAt, reopened_at: null };
    assert.strictEqual(I.isActiveFastReleaseAuth(rowAllPresent), true, '[12b] 六列全投影（reopened_at 显式 null）应正常判定为活跃授权=true，不误报缺列');
    ok('[12b] ★对照组：六列全投影不触发 fail-closed，正常判定通过');

    const FULL_ROW = { fast_release_auth_at: '2026-08-13 10:00:00', fast_release_revoked_at: null,
      fast_release_consumed_at: null, released_at: null, online_source: null, reopened_at: null };
    for (const col of Object.keys(FULL_ROW)) {
      const partial = { ...FULL_ROW };
      delete partial[col];
      let thrownC = null;
      try { I.isActiveFastReleaseAuth(partial); } catch (e) { thrownC = e; }
      assert.ok(thrownC, `[12c-${col}] 缺 ${col} 应抛错`);
      assert.strictEqual(thrownC.code, 'FAST_RELEASE_PREDICATE_INPUT_INVARIANT', `[12c-${col}] 确切码，实得 ${thrownC.code}`);
      assert.ok(thrownC.message.includes(col), `[12c-${col}] 错误文案应点名缺失的列名 ${col}，实得="${thrownC.message}"`);
    }
    ok(`[12c] isActiveFastReleaseAuth 六列逐列穷举缺列测试：${Object.keys(FULL_ROW).length} 列各自缺席均抛错且文案精确点名对应列`);

    // [12d] 静态核对生产唯一调用点（submit 端点初始 SELECT）六列齐全——SELECT 文本本身未随 S2 改动
    // （只是消费方从"直上前置闸"换成"挂牌触发闸"，见 index.js S2-1 段注释），正则应仍能命中。
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const selectMatch = indexSrc.match(/fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at, released_at, online_source,\s*\n\s*reopened_at/);
    assert.ok(selectMatch, '[12d] submit 端点初始 SELECT 应六列齐全（静态源码核对）');
    ok('[12d] 静态核对：submit 端点唯一调用点的初始 SELECT 六列齐全');
  }

  // ══════════════════════════ [13]（S3·§4-3/§4-4b）单人末位确认正例：翻牌全套写点逐字段断言 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    const etaBeforeConfirm = (await issueRow(id)).dev_estimated_at;
    assert.ok(etaBeforeConfirm, '[13-前置] ETA 已写');
    await authorize(id, adminTok, '13-单人末位确认');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(subR.status, 200, `[13-前置] submit 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual(subR.body.main_status, '待验证', '[13-前置] submit 后应待验证');
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[13-前置] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows.length}`);
    assert.strictEqual(feRows[0].user_id, 20, '[13-前置] 唯一执行人应为当日值班人（user20）');
    assert.strictEqual(feRows[0].exec_status, 'pending', '[13-前置] 确认前应仍 pending');
    // [codex 384 预筛 HIGH-1 收口] 记下"进待验证"这一刻的 W-GATE 镜像行 created_at——翻牌后要断言
    // last_completed_at 仍钉在这个值上，不随后续翻牌事件改变（方案 §14 F4 明文口径）。
    const enterVerifyMirrorRow = await get(
      `SELECT id, created_at FROM sys_issue_timeline WHERE issue_id=? AND event_type='status_change' AND to_status='待验证' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(enterVerifyMirrorRow && enterVerifyMirrorRow.created_at, '[13-前置] 应已落一条 status_change→待验证 的 timeline 行（runWGate 镜像行）');
    // 回拨该镜像行时间戳 5 秒——SQLite `datetime('now','localtime')` 只精确到秒，本组紧接着就会调用
    // confirm 触发翻牌 UPDATE（同样用 datetime('now','localtime') 写 released_at），两次写入若落在
    // 同一秒会产生完全相同的字符串，届时"last_completed_at ≠ released_at"这条断言会退化成偶发时序
    // 竞态而非确定性验证（首版实测已踩到：同秒内完成，released_at 与该镜像行 created_at 逐字相同，
    // 断言误红——不是"两者真的相等"，是"取值巧合撞了同一秒"）。回拨制造确定性差异，不依赖真实时钟流逝。
    await run(`UPDATE sys_issue_timeline SET created_at = datetime(created_at, '-5 seconds') WHERE id = ?`, [enterVerifyMirrorRow.id]);
    const enterVerifyMirror = await get(`SELECT created_at FROM sys_issue_timeline WHERE id = ?`, [enterVerifyMirrorRow.id]);

    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[13] confirm 应 200，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.exec_status, 'done', `[13] 响应 exec_status 应为 done，实得 ${rc.body.exec_status}`);
    assert.strictEqual(rc.body.flipped, true, `[13] 唯一执行人=末位，确认应触发翻牌（flipped=true），实得 ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.main_status, '已上线', `[13] 响应 main_status 应为已上线，实得 ${rc.body.main_status}`);

    // 翻牌全套写点逐字段断言（方案 §4-3c 模板七列 SET 子句，逐一验证非"只看 status 一列就判过"）。
    const row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[13] status 应为「已上线」');
    assert.ok(row.released_at, '[13] released_at 已写（非空）');
    assert.strictEqual(row.online_source, 'authorized_fastlane', '[13] online_source 应为 authorized_fastlane');
    assert.strictEqual(row.post_release_acceptance, 'pending', '[13] post_release_acceptance 应为 pending（§3.3 副作用）');
    assert.ok(row.fast_release_consumed_at, '[13] fast_release_consumed_at 已写（授权已消费）');
    assert.strictEqual(row.gate_deferred_at, null, '[13] gate_deferred_at 应已清（进已上线即清，既有惯例）');
    assert.strictEqual(row.dev_estimated_at_on_release, etaBeforeConfirm, '[13] ⭐ release 快照写点②：dev_estimated_at_on_release 应等于翻牌那一刻的 dev_estimated_at（组 C·SC1）');

    const feAfter = await fastExecRows(id);
    assert.strictEqual(feAfter.length, 1, '[13] 执行人集合仍恰 1 行（无新增/无软删）');
    assert.strictEqual(feAfter[0].exec_status, 'done', '[13] 执行人行 exec_status 应为 done');
    // fastExecRows 本身不选 executed_at 列（既有列清单不含），单独查一次核对该列确已写入。
    const execExecutedAt = await get('SELECT executed_at FROM sys_fast_release_executors WHERE id=?', [feAfter[0].id]);
    assert.ok(execExecutedAt.executed_at, '[13] executed_at 应非空（done 条件更新已写时间戳）');

    // timeline：末位路径应有 fast_release_exec_online 镜像行，且**不应**额外写 fast_release_exec_confirm
    // note（同一次点击不能对应两条留痕，见端点头部注释"两条 note 会对同一次点击重复留痕"）。
    const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
    assert.strictEqual(onlineTl.length, 1, `[13] timeline 应恰 1 条 fast_release_exec_online，实得 ${onlineTl.length}`);
    assert.strictEqual(onlineTl[0].event_type, 'status_change', '[13] fast_release_exec_online 行 event_type 应为 status_change');
    assert.strictEqual(onlineTl[0].from_status, '待验证', '[13] from_status 应为待验证');
    assert.strictEqual(onlineTl[0].to_status, '已上线', '[13] to_status 应为已上线');
    assert.ok(onlineTl[0].summary.includes('confirm'), `[13] summary 应含 trigger=confirm 标注，实得="${onlineTl[0].summary}"`);
    const confirmNoteTl = await timelineRowsByCode(id, 'fast_release_exec_confirm');
    assert.strictEqual(confirmNoteTl.length, 0, `[13] 末位路径不应额外写 fast_release_exec_confirm note，实得 ${confirmNoteTl.length} 条`);

    // [codex 384 预筛 HIGH-1 收口·口径钉死] 末位翻牌后 list/detail 两端点的 last_completed_at 仍应
    // 等于"进待验证"那一刻的镜像行 created_at，**不应**随翻牌事件（fast_release_exec_online 那条更晚
    // 的 status_change 行）改变，也不应等于 released_at（两者是完全不同的两件事：last_completed_at=
    // 开发侧完成时刻，released_at=部署上线时刻，方案 §14 F4 明文口径）。"实现坏成什么样这条会红"：
    // 若未来又有人往 list/detail 的 last_completed_at 子查询里加回 fast_release_exec_online 那条析取
    // 分支（S3 曾经加过，已被本轮预筛 HIGH-1 撤销），MAX() 会改取翻牌行、本条断言立即判红。
    const detail13 = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail13.status, 200, `[13-口径] 详情应 200，实得 ${detail13.status}`);
    assert.strictEqual(detail13.body.issue.last_completed_at, enterVerifyMirror.created_at,
      `[13-口径] 详情 last_completed_at 应仍=进待验证时刻，实得 ${detail13.body.issue.last_completed_at} vs 期望 ${enterVerifyMirror.created_at}`);
    assert.notStrictEqual(detail13.body.issue.last_completed_at, row.released_at,
      `[13-口径] 详情 last_completed_at 不应等于 released_at（两者是不同的两件事，released_at=${row.released_at}）`);
    const list13 = await call('GET', '/api/sys-issues?page_size=500', adminTok);
    assert.strictEqual(list13.status, 200, `[13-口径] 列表应 200，实得 ${list13.status}`);
    const listRow13 = (list13.body.items || []).find(x => x.id === id);
    assert.ok(listRow13, `[13-口径] 列表应含该单据 id=${id}`);
    assert.strictEqual(listRow13.last_completed_at, enterVerifyMirror.created_at,
      `[13-口径] 列表 last_completed_at 应仍=进待验证时刻，实得 ${listRow13.last_completed_at} vs 期望 ${enterVerifyMirror.created_at}`);
    assert.strictEqual(listRow13.last_completed_at, detail13.body.issue.last_completed_at,
      '[13-口径·列表/详情同源] 两处子查询取值应完全一致（codex 263 M-1 契约）');
    ok('[13] 单人末位确认正例：翻牌全套写点逐字段断言全部通过（status/released_at/online_source/post_release_acceptance/consumed_at/gate_deferred_at清/dev_estimated_at_on_release 快照）+ 执行人行 done+executed_at + timeline 恰 1 条 exec_online 镜像行（无重复 exec_confirm note）+ [codex 384 HIGH-1] 末位翻牌后 last_completed_at 仍钉在"进待验证"时刻、≠released_at（list/detail 同源）');
  }

  // ══════════════════════════ [13b]（codex 384 预筛 MED-1）内核补清 release_id：脏值挂牌单末位确认后应清空 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '13b-release_id脏值');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[13b-前置] submit 应 200，实得 ${r.status}`);
    // 造一个脏 release_id——理论上不该出现（fastlane 单不挂批次），但结构上无 CHECK 约束禁止，模拟
    // 历史遗留悬垂值（同 C9 姊妹边 :4836 一带注释"写读分裂堵口"论证的同款风险面）。
    await run(`UPDATE sys_issues SET release_id = 999999 WHERE id = ?`, [id]);
    const beforeRow = await issueRow(id);
    assert.strictEqual(beforeRow.release_id, 999999, '[13b-前置] release_id 脏值应已落库（造态生效）');

    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[13b] confirm 应 200，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.flipped, true, '[13b] 唯一执行人确认应触发翻牌');

    const row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[13b] 应已翻牌');
    assert.strictEqual(row.release_id, null, `[13b] ⭐ 翻牌后 release_id 应被内核清为 NULL（codex 384-MED-1），实得 ${row.release_id}`);

    // deriveOnlineSourceKind 判fastlane 非批次——若 release_id 未清，读侧①分支会先认"批次发布"，
    // 把这条 fastlane 翻牌单误分类。
    const kind = I.deriveOnlineSourceKind(row);
    assert.strictEqual(kind, 'authorized_fastlane', `[13b] deriveOnlineSourceKind 应判 authorized_fastlane（非批次），实得 ${kind}`);
    // 不变量③（fastlaneAcceptanceInvariantViolations）交叉核对：release_id 清空后不应再报"release_id 非空"违例。
    const violations = I.fastlaneAcceptanceInvariantViolations(row);
    assert.ok(!violations.some(v => v.includes('release_id')), `[13b] 不变量③不应再报 release_id 违例，实得 ${JSON.stringify(violations)}`);
    ok('[13b] 内核补清 release_id（codex 384-MED-1）：脏值挂牌单末位确认后 release_id 被清为 NULL，deriveOnlineSourceKind 正确判 authorized_fastlane（非批次），不变量③零违例');
  }

  // ══════════════════════════ [14]（S3）多人非末位：SQL 造态铺第二人，done+confirm 码，不翻牌 ══════════════════════════
  {
    const id = await bugAtChulizhongTwoDevs();
    await estimateFuture(id);
    await authorize(id, adminTok, '14-多人非末位');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[14-前置a] dev5 提交应 200，实得 ${r.status}`);
    assert.strictEqual(r.body.main_status, '处理中', '[14-前置a] dev6 仍 pending，主状态维持处理中');
    r = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[14-前置b] dev6（末位提交花名册）应 200，实得 ${r.status}`);
    assert.strictEqual(r.body.main_status, '待验证', '[14-前置b] 花名册全完成后应待验证');
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[14-前置] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows.length}`);

    // [S4 未接线] 加执行人端点非本阶段范围——SQL 造态直接铺第二名执行人（user6），模拟"S4 落地后该单
    // 曾被追加过第二名执行人"这个终态，本组只测"多人集合下单人确认不满足全员判定"这条闸门本身。
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 6, '开发李', 1, '管理员')`, [id]);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[14-前置] 造态后应恰 2 行执行人（值班人+造态第二人）');

    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[14] confirm 应 200，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.exec_status, 'done', '[14] 响应 exec_status 应为 done（本人那份已确认）');
    assert.strictEqual(rc.body.flipped, false, `[14] 集合未全 done（第二人仍 pending），不应触发翻牌，实得 ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.main_status, '待验证', `[14] 主状态应仍为待验证，实得 ${rc.body.main_status}`);

    const row = await issueRow(id);
    assert.strictEqual(row.status, '待验证', '[14] 主状态应仍待验证（未翻牌）');
    assert.strictEqual(row.released_at, null, '[14] released_at 应仍为空（未翻牌）');

    const feAfter = await fastExecRows(id);
    const dutyRow = feAfter.find(r2 => r2.user_id === 20);
    const secondRow = feAfter.find(r2 => r2.user_id === 6);
    assert.strictEqual(dutyRow.exec_status, 'done', '[14] 值班人那份应已 done');
    assert.strictEqual(secondRow.exec_status, 'pending', '[14] 造态第二人那份应仍 pending（未受影响）');

    // 非末位路径应写 fast_release_exec_confirm note，且不应有 fast_release_exec_online 镜像行。
    const confirmTl = await timelineRowsByCode(id, 'fast_release_exec_confirm');
    assert.strictEqual(confirmTl.length, 1, `[14] timeline 应恰 1 条 fast_release_exec_confirm，实得 ${confirmTl.length}`);
    assert.strictEqual(confirmTl[0].event_type, 'note', '[14] fast_release_exec_confirm 行 event_type 应为 note');
    assert.ok(confirmTl[0].summary.includes('值班员甲'), `[14] summary 应含确认人姓名，实得="${confirmTl[0].summary}"`);
    const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
    assert.strictEqual(onlineTl.length, 0, `[14] 非末位路径不应有 fast_release_exec_online 镜像行，实得 ${onlineTl.length} 条`);
    ok('[14] 多人非末位：造态第二人后单人确认——done+timeline fast_release_exec_confirm note 恰 1 条，主状态/released_at/第二人 pending 均不受影响（集合未全 done 不翻牌）');
  }

  // ══════════════════════════ [15]（S3）负例族 ══════════════════════════
  {
    // [15a] 非在册确认：全新单（无任何挂牌），拿一个与该单无关的 token 去确认 → 403 不在册。
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '15a-非在册');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[15a-前置] submit 应 200，实得 ${r.status}`);
      // dev2（user6）从未进过该单执行人集合（挂牌只落值班人 user20）——非在册。
      const rc = await confirm(id, dev2Tok);
      assert.strictEqual(rc.status, 403, `[15a] 非在册应 403，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(rc.body.code, 'FAST_RELEASE_EXEC_NOT_ROSTERED', `[15a] 确切码，实得 ${rc.body.code}`);
      ok('[15a] 非在册确认：403 FAST_RELEASE_EXEC_NOT_ROSTERED');
    }

    // [15b] 已 done 重复确认：唯一执行人确认一次（末位翻牌）后再确认一次 → 409（在册判权仍过，done 条件更新失败）。
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '15b-重复确认');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[15b-前置] submit 应 200，实得 ${r.status}`);
      const first = await confirm(id, dutyTok);
      assert.strictEqual(first.status, 200, `[15b-前置] 首次确认应 200，实得 ${first.status}`);
      assert.strictEqual(first.body.flipped, true, '[15b-前置] 首次确认应即末位翻牌');
      const second = await confirm(id, dutyTok);
      assert.strictEqual(second.status, 409, `[15b] 重复确认应 409，实得 ${second.status} ${JSON.stringify(second.body)}`);
      assert.strictEqual(second.body.code, 'FAST_RELEASE_EXEC_CONFIRM_INVALID', `[15b] 确切码，实得 ${second.body.code}`);
      ok('[15b] 已 done 重复确认：409 FAST_RELEASE_EXEC_CONFIRM_INVALID（在册判权仍过，done 条件更新的 exec_status=pending 条件已不满足）');
    }

    // [15c]（S5 改写·预埋纪律二）授权终结后确认：验收打回（B1 事件"验收打回"清空授权六列 + S5 §4-7
    //   同事务清集合）后再确认 → 403（本人已不在册——集合已被清空，非旧行为"在册判权仍过但主表联判
    //   失败落 409"）。⚠️ 本条断言在 S5 落地前必翻红（旧断言期望 409 CONFIRM_INVALID），如实记录：
    //   这正是本次要验证的新行为，非漏改（S5 交付报告"预埋纪律二"逐条记录）。
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '15c-授权终结');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[15c-前置] submit 应 200，实得 ${r.status}`);
      const feRows = await fastExecRows(id);
      assert.strictEqual(feRows.length, 1, '[15c-前置] 应恰 1 行执行人 pending');
      const returnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '15c-验收打回终结授权' });
      assert.strictEqual(returnR.status, 200, `[15c-前置] return 应 200，实得 ${returnR.status} ${JSON.stringify(returnR.body)}`);
      const midRow = await issueRow(id);
      assert.strictEqual(midRow.status, '处理中', '[15c-前置] return 后应回处理中');
      assert.strictEqual(midRow.fast_release_revoked_at, null, '[15c-前置] return 走的是"终结"（清空六列）非"撤销"（写 revoked_at），revoked_at 应仍为空');
      assert.strictEqual(midRow.fast_release_auth_at, null, '[15c-前置] fast_release_auth_at 应已被终结清空（B1 事件"验收打回"）');

      const clearedRows = await fastExecRows(id);
      assert.strictEqual(clearedRows.filter(x => !x.removed_at).length, 0, '[15c] return 后集合应零未软删行（S5 五事件终结延伸·§4-7）');
      assert.strictEqual(clearedRows.length, 1, '[15c] 全表仍应恰 1 行（软删非物理删除）');
      assert.ok(clearedRows[0].removed_at, '[15c] 该行 removed_at 应已写');
      const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
      assert.strictEqual(clearedTl.length, 1, `[15c] 应恰 1 条 fast_release_roster_cleared，实得 ${clearedTl.length}`);
      assert.ok(clearedTl[0].summary.includes('验收打回'), `[15c] summary 应含成因"验收打回"，实得="${clearedTl[0].summary}"`);

      const rc = await confirm(id, dutyTok);
      assert.strictEqual(rc.status, 403, `[15c] 集合已清空后确认应 403，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(rc.body.code, 'FAST_RELEASE_EXEC_NOT_ROSTERED', `[15c] 确切码，实得 ${rc.body.code}`);
      ok('[15c]（S5 改写）授权终结后确认：验收打回（B1 事件+S5 同事务清集合）后集合零未软删行+roster_cleared 留痕（成因"验收打回"），再确认 403 FAST_RELEASE_EXEC_NOT_ROSTERED（本人已不在册，非旧行为）');
    }

    // [15d]（S5 改写·预埋纪律二）revoke 后确认：显式撤销授权（S5 §4-5 同事务清集合，不改变 status，
    //   单据仍待验证）后再确认 → 403（同 15c 同理由，本人已不在册）。
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '15d-revoke后确认');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[15d-前置] submit 应 200，实得 ${r.status}`);
      const revokeR = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '15d-撤销' });
      assert.strictEqual(revokeR.status, 200, `[15d-前置] revoke 应 200，实得 ${revokeR.status} ${JSON.stringify(revokeR.body)}`);
      const midRow = await issueRow(id);
      assert.strictEqual(midRow.status, '待验证', '[15d-前置] revoke 不改变 status（单据仍待验证，与 15c 的 return 形成对照）');
      assert.ok(midRow.fast_release_revoked_at, '[15d-前置] revoked_at 应已写（撤销，非终结清空）');

      const clearedRows = await fastExecRows(id);
      assert.strictEqual(clearedRows.filter(x => !x.removed_at).length, 0, '[15d] revoke 后集合应零未软删行（S5 §4-5）');
      assert.strictEqual(clearedRows.length, 1, '[15d] 全表仍应恰 1 行（软删非物理删除）');
      const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
      assert.strictEqual(clearedTl.length, 1, `[15d] 应恰 1 条 fast_release_roster_cleared，实得 ${clearedTl.length}`);
      assert.ok(clearedTl[0].summary.includes('撤销授权'), `[15d] summary 应含成因"撤销授权"，实得="${clearedTl[0].summary}"`);

      const rc = await confirm(id, dutyTok);
      assert.strictEqual(rc.status, 403, `[15d] 集合已清空后确认应 403，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(rc.body.code, 'FAST_RELEASE_EXEC_NOT_ROSTERED', `[15d] 确切码，实得 ${rc.body.code}`);
      ok('[15d]（S5 改写）revoke 后确认：撤销（S5 同事务清集合）后集合零未软删行+roster_cleared 留痕（成因"撤销授权"），再确认 403 FAST_RELEASE_EXEC_NOT_ROSTERED（与 15c 走不同字段但殊途同归，均落"本人已不在册"）');
    }

    // [15e]（S5 改写·预埋纪律二）单已流转（先 accept）后确认：验收通过（accept，待验证→待上线，S5 §4-7
    //   同事务清集合）后再确认 → 403（同 15c/15d 同理由）。
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '15e-先accept后确认');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[15e-前置] submit 应 200，实得 ${r.status}`);
      const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(acceptR.status, 200, `[15e-前置] accept 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
      assert.strictEqual(acceptR.body.status, '待上线', `[15e-前置] 有 commit 的 bug 单 accept 应落待上线（非 C9 直翻），实得 ${acceptR.body.status}`);
      const midRow = await issueRow(id);
      assert.strictEqual(midRow.fast_release_auth_at, null, '[15e-前置] accept 同样触发 B1 事件"上线翻牌/验收通过"清空授权六列');

      const clearedRows = await fastExecRows(id);
      assert.strictEqual(clearedRows.filter(x => !x.removed_at).length, 0, '[15e] accept 后集合应零未软删行（S5 §4-7）');
      assert.strictEqual(clearedRows.length, 1, '[15e] 全表仍应恰 1 行（软删非物理删除）');
      const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
      assert.strictEqual(clearedTl.length, 1, `[15e] 应恰 1 条 fast_release_roster_cleared，实得 ${clearedTl.length}`);
      assert.ok(clearedTl[0].summary.includes('验收通过'), `[15e] summary 应含成因"验收通过"（非 C9 直翻分支，落待上线），实得="${clearedTl[0].summary}"`);

      const rc = await confirm(id, dutyTok);
      assert.strictEqual(rc.status, 403, `[15e] 集合已清空后确认应 403，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(rc.body.code, 'FAST_RELEASE_EXEC_NOT_ROSTERED', `[15e] 确切码，实得 ${rc.body.code}`);
      ok('[15e]（S5 改写）单已流转（先 accept 到待上线）后确认：accept（S5 同事务清集合，成因"验收通过"）后集合零未软删行+roster_cleared 留痕，再确认 403 FAST_RELEASE_EXEC_NOT_ROSTERED（本人已不在册，非旧行为"status 拦下"）');
    }
  }

  // ══════════════════════════ [16]（S3·方案 §5-⑧）空集合恒不可翻：直接调内核证明 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '16-空集合');
    // 造态直接推进到待验证但**不经过 submit 挂牌逻辑**（不产出任何执行人行）——比"当日无值班"更精确的
    // "空集合"前提本身（后者仍会写 0 行执行人+1 条 timeline，此处连 timeline 都不需要，只测内核对空
    // 集合的处理）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE issue_id=? AND user_id=5`, [id]);
    await run(`UPDATE sys_issues SET status='待验证' WHERE id=?`, [id]);
    const execCountBefore = (await fastExecRows(id)).length;
    assert.strictEqual(execCountBefore, 0, '[16-前置] 该单执行人集合应恰 0 行（空集合前提，造态刻意不经挂牌逻辑）');

    // 直接调内核——内核假定调用方已持事务锁，本组自行开/收事务（同全部 verify 直调 _internals 范式，
    // 不经过 sysBeginImmediate/sysCommit——那两个函数未导出，且本组本就是单线程顺序执行，无并发风险）。
    await run('BEGIN IMMEDIATE');
    const flipResult = await I.attemptFastReleaseFlipInTxn(id, { id: 1, name: '管理员' }, 'confirm');
    await run('COMMIT');
    assert.deepStrictEqual(flipResult, { flipped: false }, `[16] 空集合应恒不可翻，实得 ${JSON.stringify(flipResult)}`);
    const afterRow = await issueRow(id);
    assert.strictEqual(afterRow.status, '待验证', '[16] 主状态不应被改动（内核空集合分支应在任何 UPDATE 之前就 return，不触碰共享状态机）');
    assert.strictEqual(afterRow.released_at, null, '[16] released_at 应仍为空');
    const tlCount = await timelineCount(id);
    const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
    assert.strictEqual(onlineTl.length, 0, '[16] 不应产生 fast_release_exec_online 行');
    ok(`[16] 空集合恒不可翻（方案 §5-⑧）：0 行执行人集合直接调内核，返回 flipped=false，主状态/released_at 零改动，零 timeline 新增（timeline 总行数=${tlCount}，造直接调内核的单元用例——0 行时无人能在册，HTTP confirm 端点本身测不到这条，必须绕过端点直调内核）`);
  }

  // ══════════════════════════ [17]（S3）代次干扰：软删旧代次行不计入聚合判定 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '17-代次干扰');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[17-前置] submit 应 200，实得 ${r.status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[17-前置] 挂牌应恰 1 行，实得 ${feRows.length}`);
    // 造一条"旧代次"的软删残留行——同一 issue、另一人（user6）、pending 且已软删（模拟历史上一轮曾挂牌
    // 但从未确认、被跨轮清场软删掉的执行人）。若聚合判定漏过滤 removed_at，这条永远 pending 的旧行会
    // 让"全员 done"恒不成立，本组唯一活跃执行人确认后本该翻牌却测不出（假阴性）。
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, added_by, added_by_name, removed_at, removed_by, removed_by_name)
               VALUES (?, 6, '开发李', 'pending', 1, '管理员', datetime('now','localtime'), 1, '管理员')`, [id]);
    const totalRows = (await get('SELECT COUNT(*) c FROM sys_fast_release_executors WHERE issue_id=?', [id])).c;
    assert.strictEqual(totalRows, 2, '[17-前置] 全表应 2 行（1 活跃+1 软删旧代次），造态生效');

    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[17] confirm 应 200，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.flipped, true, `[17] 唯一在册活跃执行人确认后应翻牌（软删旧代次的 pending 行不应参与聚合判定），实得 ${JSON.stringify(rc.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[17] 应已翻牌');
    ok('[17] 代次干扰：软删旧代次 pending 行不计入聚合判定——唯一在册活跃执行人确认后正常翻牌');
  }

  // ══════════════════════════ [18]（S3·§5b）弹回×done 闸门成对：无 done 弹回照常 / 有 done 弹回 409 ══════════════════════════
  {
    // [18a] 无 done：挂牌单唯一执行人仍 pending（未确认）时加开发成员 → 应正常弹回处理中（不受本闸约束）。
    let id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '18a-无done弹回');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[18a-前置] submit 应 200，实得 ${r.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[18a-前置] 应恰 1 行 pending 执行人');
    assert.strictEqual(feRows[0].exec_status, 'pending', '[18a-前置] 执行人应仍 pending（未确认）');
    let addR = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(addR.status, 200, `[18a] 无 done 行时加开发成员应正常 200（不受弹回×done 闸约束），实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    assert.strictEqual(addR.body.main_status, '处理中', `[18a] 加成员触发弹回，主状态应回处理中，实得 ${addR.body.main_status}`);
    ok('[18a] 无 done 行弹回照常：挂牌单唯一执行人仍 pending（S2 已兜的常态）时加开发成员正常弹回处理中，不受本闸约束');

    // [18b] 有 done：两名执行人集合中一人已确认（避免唯一执行人一确认就自动翻牌，走不到"有 done 但未
    //   全 done"这个中间态）——SQL 造态铺第二人（加执行人端点是 S4 才有，本组只造态不测该端点），
    //   再触发同款弹回动作 → 应被本闸拦下。
    id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '18b-有done弹回');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[18b-前置] submit 应 200，实得 ${r.status}`);
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 6, '开发李', 1, '管理员')`, [id]);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[18b-前置] 应恰 2 行（值班人+造态第二人）');
    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[18b-前置] 值班人确认应 200，实得 ${rc.status}`);
    assert.strictEqual(rc.body.flipped, false, `[18b-前置] 两人中一人确认不应触发翻牌，实得 ${JSON.stringify(rc.body)}`);
    addR = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [13] });
    assert.strictEqual(addR.status, 409, `[18b] 有 done 行时加开发成员应被弹回×done 闸拦下（409），实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    assert.strictEqual(addR.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[18b] 确切码，实得 ${addR.body.code}`);
    const afterRow = await issueRow(id);
    assert.strictEqual(afterRow.status, '待验证', '[18b] 主状态不应被改动（不触碰共享状态机）');
    const rosterAfter = await all(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL`, [id]);
    assert.ok(!rosterAfter.some(x => Number(x.user_id) === 13), '[18b] 花名册差量应整体回滚（新成员未被加入）');
    ok('[18b] 有 done 行弹回 409：两人执行人集合中一人已确认（done）时加开发成员被弹回×done 闸拦下（FASTLANE_DEPLOY_IN_PROGRESS），主状态与花名册差量均整体回滚');
  }

  // ══════════════════════════ [19]（S3·契约 d）原子性：翻牌 WHERE 不满足 ⇒ 整体回滚不留半完成 done ══════════════════════════
  {
    // [19a] 集成层：confirm 之前先把 online_source 置脏（模拟"翻牌条件在确认这一刻已不满足"这一类场景的
    //   外部表现）——done 条件更新的主表联判会先一步失败（六列谓词含 online_source IS NULL），confirm
    //   整体 409，本人执行人行**不应**被误标 done（原子性：宁可整体不动，不留半完成态）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '19a-脏online_source');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[19a-前置] submit 应 200，实得 ${r.status}`);
    await run(`UPDATE sys_issues SET online_source = 'some_dirty_value' WHERE id = ?`, [id]);
    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 409, `[19a] 脏 online_source 应致确认整体 409，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    const execAfter = await fastExecRows(id);
    assert.strictEqual(execAfter[0].exec_status, 'pending', '[19a] 执行人行 exec_status 应仍为 pending（未被误标 done——原子性，不留半完成态）');
    const rowAfter = await issueRow(id);
    assert.strictEqual(rowAfter.status, '待验证', '[19a] 主状态不应被改动');
    const tlAfter = await timelineRowsByCode(id, 'fast_release_exec_confirm');
    assert.strictEqual(tlAfter.length, 0, '[19a] 不应有 fast_release_exec_confirm timeline 行（整体回滚，含 timeline 在内）');
    ok('[19a] d 条款原子性（集成层）：confirm 前脏写 online_source ⇒ 整体 409，执行人行不留半完成 done、timeline 零新增、主状态不变');

    // [19b] 内核层：直接构造"执行人集合已全 done（内核判定应翻牌）但 sys_issues 行本身已不满足翻牌
    //   WHERE"这一精确组合——这是契约 d 原文"内核判定应翻牌但翻牌 UPDATE changes≠1"的直接对应场景，
    //   比 19a（在到达内核之前就被 done 条件更新挡下）更贴近内核自身的边界。造态：唯一执行人已是
    //   done（绕过端点直接造终态），同时 sys_issues 的 online_source 也已被污染——内核自己重新聚合
    //   时会判定"全 done"应翻牌，随即尝试翻牌 UPDATE，该 UPDATE 应因 online_source 不为 NULL 而
    //   changes=0，内核应抛 FAST_RELEASE_FLIP_CONFLICT，不留任何副作用。
    const id2 = await bugAtChulizhong();
    await estimateFuture(id2);
    await authorize(id2, adminTok, '19b-内核层原子性');
    const r2 = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r2.status, 200, `[19b-前置] submit 应 200，实得 ${r2.status}`);
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id=?`, [id2]);
    await run(`UPDATE sys_issues SET online_source = 'some_dirty_value' WHERE id = ?`, [id2]);
    const execRows2Before = await fastExecRows(id2);
    assert.strictEqual(execRows2Before[0].exec_status, 'done', '[19b-前置] 造态后执行人应已 done（绕过端点直接造终态）');

    await run('BEGIN IMMEDIATE');
    let thrown19b = null;
    try { await I.attemptFastReleaseFlipInTxn(id2, { id: 1, name: '管理员' }, 'confirm'); }
    catch (e) { thrown19b = e; }
    await run('ROLLBACK');   // 内核自身 UPDATE 未提交生效，这里的 ROLLBACK 只是收掉本组自开的事务外壳
    assert.ok(thrown19b, '[19b] 内核应抛错（changes≠1），不静默返回 flipped:false 掩盖这是"应翻牌但翻牌失败"而非"本就不该翻"');
    assert.strictEqual(thrown19b.httpStatus, 409, `[19b] 应为 409，实得 ${thrown19b.httpStatus}`);
    assert.strictEqual(thrown19b.code, 'FAST_RELEASE_FLIP_CONFLICT', `[19b] 确切码，实得 ${thrown19b.code}`);
    const rowAfter2 = await issueRow(id2);
    assert.strictEqual(rowAfter2.status, '待验证', '[19b] 主状态不应被改动（ROLLBACK 后核对，内核自身的 UPDATE 从未真正提交）');
    ok('[19b] d 条款原子性（内核层）：执行人集合已全 done 但 sys_issues 翻牌 WHERE 不满足 ⇒ 内核抛 FAST_RELEASE_FLIP_CONFLICT（409），不静默判"不该翻"，调用方据此整体回滚（本组直调内核验证该抛错行为本身，端点层的回滚效果已由 19a 集成验证）');
  }

  // ══════════════════════════ [20]（S3·§3.3）翻牌后 pending + 48h 时钟从 released_at 起 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '20-§3.3副作用');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[20-前置] submit 应 200，实得 ${r.status}`);
    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[20] confirm 应 200，实得 ${rc.status}`);
    assert.strictEqual(rc.body.flipped, true, '[20] 唯一执行人确认应触发翻牌');
    const row = await issueRow(id);
    assert.strictEqual(row.post_release_acceptance, 'pending', '[20] 翻牌后 post_release_acceptance 应为 pending（§3.3 副作用）');
    assert.ok(row.released_at, '[20] released_at 已写（48h 时钟锚点）');
    assert.strictEqual(I.isPostReleaseAcceptOverdue(row), false, '[20a] 刚翻牌不应判超时');
    // [codex 384 预筛 LOW-3 收口] 原实现用 `new Date(Date.now()-49h).toISOString()` 产出 UTC 格式串
    //   （末尾 Z 被 slice(0,19) 切掉后只剩裸数字），但 isPostReleaseAcceptOverdue 内部
    //   `Date.parse(x.replace(' ','T'))` 对无时区后缀的字符串按**本地时区**解析——两端时区语义不一致：
    //   Asia/Shanghai（UTC+8）下这串"UTC 时刻的数字"被当成"本地时刻"重新解读，实际构造出的是 49+8=57h
    //   前（而非 49h 前），本条断言恰好因 57h 仍 >48h 而侥幸通过，掩盖了真实误差；UTC-9 以西的时区会
    //   反向偏移，可能把 gap 拉到 <48h 直接判非超时，断言翻红。改用 SQL 侧 `datetime('now','localtime',
    //   '-49 hours')` 构造——生成的字符串与 released_at 列本身的写法（`datetime('now','localtime')`）
    //   同源同函数、同一时区语义，不存在 JS Date 与 SQLite 两套时区解释规则打架的问题。
    const overdueReleasedAt = (await get(`SELECT datetime('now','localtime','-49 hours') AS t`)).t;
    const overdueRow = { ...row, released_at: overdueReleasedAt };
    assert.strictEqual(I.isPostReleaseAcceptOverdue(overdueRow), true, `[20b] 构造 49h 前的 released_at（SQL 侧本地时区构造="${overdueReleasedAt}"，避免 JS toISOString() UTC 串被当本地时间重新解析的时区坑）应判超时——证明判据确实以 released_at 现值为锚点，非某个独立缓存的旧时刻`);
    ok('[20] §3.3 副作用：翻牌 UPDATE 同事务写 post_release_acceptance=pending + released_at 全新时间戳，48h 超时判据（isPostReleaseAcceptOverdue 纯函数）天然以此为锚点，无需内核额外做"重置"动作');
  }

  // ══════════════════════════ [21]（S3·§4-4b·codex 384 预筛 MED-2 重写）语义判据：翻牌 UPDATE 全仓唯一存在于共享内核 ══════════════════════════
  {
    // [codex 384 预筛 MED-2 收口] 原判据是"三处关键子句按左到右顺序、间距 ≤200 字符"的字面量指纹——
    //   预筛探针实测四类变体全部漏网（列序调换/间距超限/占位符换字面量/漏列均测不出"多了一份实现"）。
    //   改判据本身：**不再要求任何特定列的字面拼法**，只判"UPDATE sys_issues 语句体内是否同时具备两个
    //   语义要件——① SET 子句含 `status = '已上线'`（翻牌动作本身）② 语句体（含紧随其后的绑定参数，
    //   因为占位符形态下 `authorized_fastlane` 只会出现在参数数组里，不在 SQL 文本里）含
    //   `authorized_fastlane` 语义（字面量 `'authorized_fastlane'` 或常量名 `ONLINE_SOURCE_AUTHORIZED_
    //   FASTLANE`，大小写不敏感、子串匹配即命中——常量名本身就以 AUTHORIZED_FASTLANE 结尾，天然覆盖）。
    //   两个要件不依赖彼此的相对顺序/间距/是否用占位符，逐条击穿预筛四类漏网变体的具体成因。
    const indexSrc21 = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    // 抽取候选块：从每处 `UPDATE sys_issues 开始，一路到该模板字符串收尾的反引号，再往后**额外带
    //   300 字符尾窗**——覆盖紧随 SQL 文本之后的绑定参数数组（真实内核代码就是这个形态：`online_source
    //   = ?` 占位符 + 之后 `[ONLINE_SOURCE_AUTHORIZED_FASTLANE, issueId]` 参数数组，语义要件②只在
    //   尾窗里出现，不在 SQL 文本本身）。300 字符对本仓库的调用惯例（SQL 语句 + 短参数数组）留有余量。
    function extractFastlaneOnlineUpdateBlocks(src) {
      const out = [];
      const re = /`UPDATE sys_issues[\s\S]*?`/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const start = m.index;
        const end = Math.min(src.length, m.index + m[0].length + 300);
        out.push(src.slice(start, end));
      }
      return out;
    }
    function countFastlaneOnlineUpdateSites(src) {
      const blocks = extractFastlaneOnlineUpdateBlocks(src);
      return blocks.filter(b => /status\s*=\s*'已上线'/.test(b) && /authorized_fastlane/i.test(b)).length;
    }

    // [codex 384 预筛 MED-2] 内置合成对照组——先证新判据真能抓到预筛探针实测过的四类漏网变体（拼进
    //   真实源码副本，断言计为第 2 处），再断言真实源码本身恰 1 处。四类样本均用双引号包裹外层 JS
    //   字符串（内含反引号/单引号均为普通字符，不触发本仓库"模板字符串禁内嵌反引号"那条真实坑）。
    const sampleLiteralInsteadOfPlaceholder =
      "\n  const _dupA = `UPDATE sys_issues SET status = '已上线', online_source = 'authorized_fastlane' WHERE id = ?`;\n";
    const sampleColumnReordered =
      "\n  const _dupB = `UPDATE sys_issues SET online_source = ?, released_at = datetime('now'), status = '已上线' WHERE id = ?`;\n  const _pB = [ONLINE_SOURCE_AUTHORIZED_FASTLANE, id];\n";
    const sampleMissingSnapshotCol =
      "\n  const _dupC = `UPDATE sys_issues SET status = '已上线', online_source = ?, post_release_acceptance = 'pending' WHERE id = ?`;\n  const _pC = [ONLINE_SOURCE_AUTHORIZED_FASTLANE, id];\n";
    const sampleInsertedColumnWithComment =
      "\n  const _dupD = `UPDATE sys_issues SET status = '已上线',\n  // " + 'x'.repeat(260) + "\n    online_source = ?\n  WHERE id = ?`;\n  const _pD = [ONLINE_SOURCE_AUTHORIZED_FASTLANE, id];\n";
    const adversarialSamples = [
      ['字面量替占位符', sampleLiteralInsteadOfPlaceholder],
      ['列序调换', sampleColumnReordered],
      ['漏快照列', sampleMissingSnapshotCol],
      ['插列加长注释', sampleInsertedColumnWithComment],
    ];
    for (const [label, sample] of adversarialSamples) {
      const countWithDup = countFastlaneOnlineUpdateSites(indexSrc21 + sample);
      assert.strictEqual(countWithDup, 2,
        `[21-合成对照组·${label}] 拼入该变体后应判定为第 2 处翻牌 UPDATE（证明新判据能抓到这类漏网形态），实得 ${countWithDup} 处`);
    }
    ok(`[21-合成对照组] ${adversarialSamples.length} 个变体样本（${adversarialSamples.map(s => s[0]).join('/')}）均被新判据正确计为第 2 处——证明加固真生效，非纸面声称（预筛探针实测这四类曾全部漏网旧判据）`);

    const realCount = countFastlaneOnlineUpdateSites(indexSrc21);
    assert.strictEqual(realCount, 1, `[21] 真实源码翻牌 UPDATE 语义判据应全仓唯一（S4 接同一个共享内核函数，禁双实现），实得 ${realCount} 处`);
    ok('[21] 语义判据：翻牌 UPDATE（SET 含 status=已上线 ∧ 语句体含 authorized_fastlane 语义，不依赖列序/间距/占位符形态）全仓唯一存在于共享内核函数 attemptFastReleaseFlipInTxn 内');
  }

  // ══════════════════════════ [22]（codex 385 预筛 M1）契约 d 端点级故障注入：done 已写→翻牌失败→端点整体回滚 ══════════════════════════
  //   [19a]/[19b] 均未覆盖"done 已经真的写进去了，翻牌那一步才失败"这条时序缺口——19a 是"done 前置
  //   条件本身就不满足"（在到达内核之前就被 done 条件更新自己的 EXISTS 子查询挡下）；19b 是直调内核
  //   单元测试（跳过了端点层 HTTP 往返与真实事务边界，且造态直接把执行人集合摆成全 done，不经过端点
  //   自己的 done 条件更新那一步）。本组用真实 SQLite 触发器逼出这条精确路径：安装一个只拦截"待验证→
  //   已上线"这一条转移的 BEFORE UPDATE 触发器（RAISE(IGNORE)——让该行被跳过、changes=0，但不抛 SQL
  //   异常），走**真实确认端点**（非直调内核），验证端点外层事务能否把"已经生效的 done 更新"一并回滚。
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '22-端点级故障注入');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[22-前置] submit 应 200，实得 ${r.status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[22-前置] 应恰 1 行 pending 执行人');

    await run(`CREATE TRIGGER _t22_block_flip BEFORE UPDATE ON sys_issues
               WHEN OLD.status = '待验证' AND NEW.status = '已上线'
               BEGIN SELECT RAISE(IGNORE); END`);
    try {
      const rc = await confirm(id, dutyTok);
      assert.strictEqual(rc.status, 409, `[22] 触发器拦截翻牌后 confirm 应 409，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(rc.body.code, 'FAST_RELEASE_FLIP_CONFLICT', `[22] 确切码，实得 ${rc.body.code}`);

      const feAfter = await fastExecRows(id);
      assert.strictEqual(feAfter[0].exec_status, 'pending', '[22] 执行人行 exec_status 应仍为 pending（done 被端点外层事务回滚，非从未生效——它在同一事务内曾短暂生效过）');
      const execExecutedAt = await get('SELECT executed_at FROM sys_fast_release_executors WHERE id=?', [feAfter[0].id]);
      assert.strictEqual(execExecutedAt.executed_at, null, '[22] executed_at 应仍为 NULL（随事务整体回滚一并撤销）');

      const row = await issueRow(id);
      assert.strictEqual(row.status, '待验证', '[22] 主表未翻牌');
      assert.strictEqual(row.released_at, null, '[22] released_at 应仍为空');

      const confirmTl = await timelineRowsByCode(id, 'fast_release_exec_confirm');
      assert.strictEqual(confirmTl.length, 0, `[22] fast_release_exec_confirm timeline 应零新增（整体回滚），实得 ${confirmTl.length}`);
      const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
      assert.strictEqual(onlineTl.length, 0, `[22] fast_release_exec_online timeline 应零新增，实得 ${onlineTl.length}`);
    } finally {
      await run(`DROP TRIGGER _t22_block_flip`);
    }

    // 触发器移除后功能恢复对照：同一张单再次确认应能正常翻牌（证明红灯是触发器造成的、不是端点本身
    // 被这次实验搞坏了）。
    const rcAfter = await confirm(id, dutyTok);
    assert.strictEqual(rcAfter.status, 200, `[22-对照] 移除触发器后 confirm 应恢复 200，实得 ${rcAfter.status} ${JSON.stringify(rcAfter.body)}`);
    assert.strictEqual(rcAfter.body.flipped, true, '[22-对照] 应正常翻牌');
    ok('[22] 契约 d 端点级故障注入（codex 385-M1）：done 已写→SQLite 触发器拦截翻牌 UPDATE（changes=0）→端点整体回滚（执行人行仍 pending+executed_at NULL、主表未翻牌、exec_confirm/exec_online 两类 timeline 零新增）；移除触发器后同一张单确认能正常翻牌（功能恢复对照）');
  }

  // ══════════════════════════ [23]（codex 385 预筛 M2·①）弹回×done 闸门·supersede-excuse 入口真实端点实测 ══════════════════════════
  //   [18b] 只实测了 add 入口；本组走**真实** POST /dev-assignees/:id/supersede-excuse（非造态模拟该
  //   端点行为），证明同一闸门（runWGate 弹回分支内单点闸）确实覆盖这第二个真实触发端点。"无 done 正常
  //   弹回"对照复用 [18a] 的结论（闸门是 runWGate 内单点实现，与哪个端点调用它无关——[18a] 已证"无 done
  //   时该弹回分支放行"这件事对**任意**触发端点成立，不为 supersede-excuse/reassign 各自重复造一遍）。
  {
    const id = await bugAtChulizhongTwoDevs();   // dev5 + dev6，处理中态，均 pending
    // 处理中态先开脱 dev6（excuse 族矩阵仅含 DEV，必须在进入待验证前完成）。
    const dev6Row = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6 AND removed_at IS NULL`, [id]);
    assert.ok(dev6Row, '[23-前置] dev6 应在册');
    const excuseR = await call('POST', `/api/sys-issues/${id}/dev-assignees/${dev6Row.id}/excuse`, adminTok, { reason: '23-测试开脱' });
    assert.strictEqual(excuseR.status, 200, `[23-前置] excuse 应 200，实得 ${excuseR.status} ${JSON.stringify(excuseR.body)}`);

    await estimateFuture(id);
    await authorize(id, adminTok, '23-supersede入口');
    // dev5（唯一剩余 pending 成员）提交——花名册全完成（dev6 已 excused 不计入 pendingCount）→ 进待验证 → 挂牌。
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(subR.status, 200, `[23-前置] submit 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual(subR.body.main_status, '待验证', '[23-前置] 应进入待验证');
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[23-前置] 挂牌应恰 1 行（值班人）');

    // 造态铺第二名执行人（同 [18b]/[14] 范式），confirm 一人使集合出现"有 done 但未全 done"。
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 13, '示例对接人', 1, '管理员')`, [id]);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[23-前置] 造态后应恰 2 行执行人');
    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[23-前置] 值班人确认应 200，实得 ${rc.status}`);
    assert.strictEqual(rc.body.flipped, false, '[23-前置] 两人中一人确认不应触发翻牌');

    const dev6RowNow = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6 AND dev_status='excused' AND removed_at IS NULL`, [id]);
    assert.ok(dev6RowNow, '[23-前置] dev6 应仍处于 excused 在册态');
    const rosterBefore = await all(`SELECT id, user_id, dev_status, removed_at, superseded_by FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id`, [id]);

    const supersedeR = await call('POST', `/api/sys-issues/${id}/dev-assignees/${dev6RowNow.id}/supersede-excuse`, adminTok, { reason: '23-开脱恢复触发弹回' });
    assert.strictEqual(supersedeR.status, 409, `[23] 有 done 行时 supersede-excuse 应被弹回×done 闸拦下（409），实得 ${supersedeR.status} ${JSON.stringify(supersedeR.body)}`);
    assert.strictEqual(supersedeR.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[23] 确切码，实得 ${supersedeR.body.code}`);

    const afterRow = await issueRow(id);
    assert.strictEqual(afterRow.status, '待验证', '[23] 主状态不应被改动');
    const rosterAfter = await all(`SELECT id, user_id, dev_status, removed_at, superseded_by FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id`, [id]);
    assert.deepStrictEqual(rosterAfter, rosterBefore, '[23] 花名册应零变化（开脱恢复的插新行 + 旧行 superseded_by 回写均应整体回滚，成员仍停留在开脱态）');
    ok('[23] 弹回×done 闸门·supersede-excuse 入口真实端点实测（codex 385-M2①）：两人执行人集合一人已确认（done）时开脱恢复被拦下（409 FASTLANE_DEPLOY_IN_PROGRESS），花名册差量整体回滚（成员仍 excused），与 [18b] add 入口互证同一闸门覆盖多入口（无 done 正常弹回对照见 [18a]，闸门实现在 runWGate 单点、与触发端点无关，不重复造）');
  }

  // ══════════════════════════ [24]（codex 385 预筛 M2·②）弹回×done 闸门·reassign 入口真实端点实测 ══════════════════════════
  //   同 [23]，走**真实** POST /reassign（非造态模拟）。"无 done 正常弹回"对照同样复用 [18a] 结论。
  {
    const id = await bugAtChulizhong();   // 单开发 dev5
    await estimateFuture(id);
    await authorize(id, adminTok, '24-reassign入口');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(subR.status, 200, `[24-前置] submit 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[24-前置] 挂牌应恰 1 行（值班人）');

    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 13, '示例对接人', 1, '管理员')`, [id]);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[24-前置] 造态后应恰 2 行执行人');
    const rc = await confirm(id, dutyTok);
    assert.strictEqual(rc.status, 200, `[24-前置] 值班人确认应 200，实得 ${rc.status}`);
    assert.strictEqual(rc.body.flipped, false, '[24-前置] 两人中一人确认不应触发翻牌');

    const rosterBefore = await all(`SELECT id, user_id, dev_status, removed_at FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id`, [id]);
    // reassign：member_ids 传"最终期望在册名单"（既有 dev5 + 新增 dev6），toAdd=[6] 会新插一行 pending，
    // 触发弹回。
    const reassignR = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5, 6], reason: '24-改派触发弹回' });
    assert.strictEqual(reassignR.status, 409, `[24] 有 done 行时 reassign 应被弹回×done 闸拦下（409），实得 ${reassignR.status} ${JSON.stringify(reassignR.body)}`);
    assert.strictEqual(reassignR.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[24] 确切码，实得 ${reassignR.body.code}`);

    const afterRow = await issueRow(id);
    assert.strictEqual(afterRow.status, '待验证', '[24] 主状态不应被改动');
    const rosterAfter = await all(`SELECT id, user_id, dev_status, removed_at FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id`, [id]);
    assert.deepStrictEqual(rosterAfter, rosterBefore, '[24] 花名册差量应整体回滚（dev6 未被加入，dev5 仍原样在册）');
    ok('[24] 弹回×done 闸门·reassign 入口真实端点实测（codex 385-M2②）：两人执行人集合一人已确认（done）时改派（含新增 pending 成员）被拦下（409 FASTLANE_DEPLOY_IN_PROGRESS），花名册差量整体回滚，与 [18b]/[23] 互证同一闸门覆盖第三个入口（无 done 正常弹回对照见 [18a]）');
  }

  // ══════════════════════════ [25]（codex 385 预筛 L1）trigger 白名单：非法值抛错 + 两个合法值 timeline summary 各自正确 ══════════════════════════
  {
    // [25a] 非法 trigger 直调内核应抛错——即便业务前提（执行人集合已全 done）已满足也不放行，证明
    //   白名单校验抢在聚合判定/翻牌 UPDATE 之前，不是"走到某个分支才顺便检查"。
    const id25a = await bugAtChulizhong();
    await estimateFuture(id25a);
    await authorize(id25a, adminTok, '25a-非法trigger');
    const r25a = await call('POST', `/api/sys-issues/${id25a}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r25a.status, 200, `[25a-前置] submit 应 200，实得 ${r25a.status}`);
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id=?`, [id25a]);
    await run('BEGIN IMMEDIATE');
    let thrown25a = null;
    try { await I.attemptFastReleaseFlipInTxn(id25a, { id: 1, name: '管理员' }, 'some_bogus_trigger'); }
    catch (e) { thrown25a = e; }
    await run('ROLLBACK');
    assert.ok(thrown25a, '[25a] 非法 trigger 应抛错');
    assert.ok(/未知 trigger/.test(thrown25a.message), `[25a] 错误文案应点名"未知 trigger"，实得="${thrown25a.message}"`);
    const rowAfter25a = await issueRow(id25a);
    assert.strictEqual(rowAfter25a.status, '待验证', '[25a] 非法 trigger 应在任何 UPDATE 之前就抛错，主状态零改动');
    ok('[25a] trigger 白名单：非法值直调内核抛错（"未知 trigger"），且抢在聚合判定/翻牌 UPDATE 之前拦下——即便业务前提（全员 done）已满足也不放行，主状态零改动');

    // [25b] 'confirm' 合法值——真实端点末位路径（机制已由 [13] 验证过，这里只聚焦 summary 文案）。
    const id25b = await bugAtChulizhong();
    await estimateFuture(id25b);
    await authorize(id25b, adminTok, '25b-confirm文案');
    const r25b = await call('POST', `/api/sys-issues/${id25b}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r25b.status, 200, `[25b-前置] submit 应 200，实得 ${r25b.status}`);
    const rc25b = await confirm(id25b, dutyTok);
    assert.strictEqual(rc25b.status, 200, `[25b] confirm 应 200，实得 ${rc25b.status}`);
    assert.strictEqual(rc25b.body.flipped, true, '[25b] 应末位翻牌');
    const onlineTl25b = await timelineRowsByCode(id25b, 'fast_release_exec_online');
    assert.strictEqual(onlineTl25b.length, 1, '[25b] 应恰 1 条 fast_release_exec_online 行');
    assert.ok(onlineTl25b[0].summary.includes('trigger=confirm'), `[25b] summary 应含 "trigger=confirm"，实得="${onlineTl25b[0].summary}"`);
    assert.ok(onlineTl25b[0].summary.includes('执行人确认'), `[25b] summary 应含中文说明"执行人确认"，实得="${onlineTl25b[0].summary}"`);
    ok('[25b] trigger 合法值①「confirm」：timeline summary 正确含 "trigger=confirm" + 中文说明"执行人确认"');

    // [25c] 'roster_remove' 合法值——单元路径直调内核证明该分支文案本身正确（S4 落地后见 [33] 组的
    // 真实端点路径同款覆盖，本组保留作内核纯函数级单测，两者不重复：本组测"文案分支对不对"，
    // [33] 测"真实 DELETE 端点是否正确接线到该 trigger 值"）。
    const id25c = await bugAtChulizhong();
    await estimateFuture(id25c);
    await authorize(id25c, adminTok, '25c-roster_remove文案');
    const r25c = await call('POST', `/api/sys-issues/${id25c}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r25c.status, 200, `[25c-前置] submit 应 200，实得 ${r25c.status}`);
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id=?`, [id25c]);
    await run('BEGIN IMMEDIATE');
    const flipResult25c = await I.attemptFastReleaseFlipInTxn(id25c, { id: 1, name: '管理员' }, 'roster_remove');
    await run('COMMIT');
    assert.strictEqual(flipResult25c.flipped, true, '[25c] 全 done 集合应正常翻牌（roster_remove trigger 同样走全套翻牌逻辑，只是 summary 文案分支不同）');
    const onlineTl25c = await timelineRowsByCode(id25c, 'fast_release_exec_online');
    assert.strictEqual(onlineTl25c.length, 1, '[25c] 应恰 1 条 fast_release_exec_online 行');
    assert.ok(onlineTl25c[0].summary.includes('trigger=roster_remove'), `[25c] summary 应含 "trigger=roster_remove"，实得="${onlineTl25c[0].summary}"`);
    assert.ok(onlineTl25c[0].summary.includes('移除执行人后自动全员达成'), `[25c] summary 应含中文说明"移除执行人后自动全员达成"，实得="${onlineTl25c[0].summary}"`);
    ok('[25c] trigger 合法值②「roster_remove」（直调内核单元路径验证 summary 文案分支本身；真实 DELETE 端点接线覆盖见 [33]）：timeline summary 正确含 "trigger=roster_remove" + 中文说明"移除执行人后自动全员达成"');
  }

  // ══════════════════════════ [26]（S4·§4-4a）加人正例 + user_name 来源断言 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '26-加人正例');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[26-前置] submit 应 200，实得 ${r.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[26-前置] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows.length}`);

    // 加人 body 混入伪造 user_name——端点须完全忽略（本端点自身实现只读 body.user_id，不读 user_name
    // 字段），落库值恒取服务端实时查询 users.display_name。
    const addR = await addExecutor(id, 6, adminTok, { user_name: '伪造姓名·不应落库' });
    assert.strictEqual(addR.status, 200, `[26] 加人应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    assert.strictEqual(addR.body.user_id, 6, '[26] 响应 user_id 应为目标用户');
    assert.strictEqual(addR.body.user_name, '开发李', `[26] 响应 user_name 应取服务端 users.display_name（非请求体伪造值），实得 "${addR.body.user_name}"`);
    assert.strictEqual(addR.body.exec_status, 'pending', '[26] 新增执行人应为 pending');

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, `[26] 执行人集合应恰 2 行（值班人+新加），实得 ${feRows.length}`);
    const newRow = feRows.find(r2 => r2.user_id === 6);
    assert.ok(newRow, '[26] 应能找到新加执行人行');
    assert.strictEqual(newRow.user_name, '开发李', `[26] ⭐ user_name 来源断言：落库值应为 users.display_name「开发李」，非请求体伪造的"伪造姓名·不应落库"，实得="${newRow.user_name}"`);
    assert.strictEqual(newRow.exec_status, 'pending', '[26] 新行 exec_status 应为 pending');
    assert.strictEqual(newRow.added_by, 1, '[26] added_by 应为本次操作者 admin(1)');
    assert.strictEqual(newRow.added_by_name, '管理员', '[26] added_by_name 应为操作者姓名');
    assert.strictEqual(newRow.removed_at, null, '[26] 新行应未软删');

    const tl = await timelineRowsByCode(id, 'fast_release_roster_added');
    assert.strictEqual(tl.length, 1, `[26] timeline 应恰 1 条 fast_release_roster_added，实得 ${tl.length}`);
    assert.strictEqual(tl[0].event_type, 'note', '[26] event_type 应为 note');
    assert.ok(tl[0].summary.includes('管理员'), `[26] summary 应含操作者姓名"管理员"，实得="${tl[0].summary}"`);
    assert.ok(tl[0].summary.includes('开发李'), `[26] summary 应含目标姓名"开发李"（服务端权威值），实得="${tl[0].summary}"`);
    assert.strictEqual(tl[0].operator_id, 1, '[26] timeline operator_id 应为 admin');
    ok('[26] 加人正例：目标资格合格 ⇒ INSERT pending 行（user_id/user_name=服务端权威值·added_by=操作者）+ timeline fast_release_roster_added 恰 1 条；⭐ user_name 来源断言：请求体混入伪造 user_name 被端点完全忽略，落库值/响应值均为 users.display_name');
  }

  // ══════════════════════════ [27]（S4·§4-4a）重复加人：撞 partial UNIQUE ⇒ 409 语义化 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '27-重复加人');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[27-前置] submit 应 200，实得 ${r.status}`);
    // 值班人（user20）已在挂牌逻辑落库，再对同一 user_id 发起加人应撞 UNIQUE。
    const dupR = await addExecutor(id, 20, adminTok);
    assert.strictEqual(dupR.status, 409, `[27] 重复加人应 409，实得 ${dupR.status} ${JSON.stringify(dupR.body)}`);
    assert.strictEqual(dupR.body.code, 'FASTLANE_ROSTER_ALREADY_ADDED', `[27] 确切码，实得 ${dupR.body.code}`);
    assert.ok(!/SQLITE|UNIQUE constraint failed/i.test(dupR.body.error || ''), `[27] 错误文案应语义化，不透出原始 SQLite 报错，实得="${dupR.body.error}"`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[27] 重复加人失败后集合应仍恰 1 行（未产生残留/重复行），实得 ${feRows.length}`);
    ok('[27] 重复加人：同一 user_id 二次加人撞 partial UNIQUE ⇒ 409 FASTLANE_ROSTER_ALREADY_ADDED（语义化捕获，未透出原始 SQLite 报错），集合行数不变（未产生残留）');
  }

  // ══════════════════════════ [28]（S4·§4-4a·372-H1'）首 done 后加人 FROZEN 成对 ══════════════════════════
  {
    // [28a] 无 done：唯一执行人仍 pending 时加人 → 正常 200。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '28a-无done加人');
    const rA = await call('POST', `/api/sys-issues/${idA}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rA.status, 200, `[28a-前置] submit 应 200，实得 ${rA.status}`);
    const addA = await addExecutor(idA, 6, adminTok);
    assert.strictEqual(addA.status, 200, `[28a] 无 done 行时加人应正常 200，实得 ${addA.status} ${JSON.stringify(addA.body)}`);
    ok('[28a] 无 done 行加人照常：集合全为 pending 时加人不受本闸约束，正常 200');

    // [28b] 有 done：两人集合一人已确认（避免唯一执行人一确认就自动翻牌，走不到"有 done 但未全 done"
    //   这个中间态）——用真实加人端点铺第二人（非造态），第二人确认 done 后再加第三人应被拦下。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    await authorize(idB, adminTok, '28b-有done加人');
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[28b-前置] submit 应 200，实得 ${rB.status}`);
    const addB1 = await addExecutor(idB, 6, adminTok);
    assert.strictEqual(addB1.status, 200, `[28b-前置] 加第二人应 200，实得 ${addB1.status}`);
    let feB = await fastExecRows(idB);
    assert.strictEqual(feB.length, 2, '[28b-前置] 应恰 2 行执行人');
    const rcB = await confirm(idB, dutyTok);
    assert.strictEqual(rcB.status, 200, `[28b-前置] 值班人确认应 200，实得 ${rcB.status}`);
    assert.strictEqual(rcB.body.flipped, false, '[28b-前置] 两人中一人确认不应触发翻牌');
    const addB2 = await addExecutor(idB, 13, adminTok);
    assert.strictEqual(addB2.status, 409, `[28b] 有 done 行时加人应 409 FASTLANE_ROSTER_FROZEN，实得 ${addB2.status} ${JSON.stringify(addB2.body)}`);
    assert.strictEqual(addB2.body.code, 'FASTLANE_ROSTER_FROZEN', `[28b] 确切码，实得 ${addB2.body.code}`);
    feB = await fastExecRows(idB);
    assert.strictEqual(feB.length, 2, `[28b] 拒绝后集合应仍恰 2 行（未插入第三人），实得 ${feB.length}`);
    ok('[28b] 有 done 行加人 409：两人集合一人已确认（done）时加第三人被冻结闸拦下（FASTLANE_ROSTER_FROZEN），集合行数不变（未插入）');
  }

  // ══════════════════════════ [29]（S4·§4-4a/373-H）非挂牌态加人 409 成对 ══════════════════════════
  {
    // [29a] 单未到「待验证」（仍处理中，已授权但未 submit）。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '29a-未待验证');
    const rowA = await issueRow(idA);
    assert.strictEqual(rowA.status, '处理中', '[29a-前置] 应仍处理中（未 submit）');
    const addA = await addExecutor(idA, 6, adminTok);
    assert.strictEqual(addA.status, 409, `[29a] 未到待验证时加人应 409，实得 ${addA.status} ${JSON.stringify(addA.body)}`);
    assert.strictEqual(addA.body.code, 'FASTLANE_ROSTER_NOT_STAGED', `[29a] 确切码，实得 ${addA.body.code}`);
    ok('[29a] 非挂牌态加人（单未到待验证）：409 FASTLANE_ROSTER_NOT_STAGED');

    // [29b] 单已到「待验证」但从未授权（无活跃六列）——普通 submit 全完成态正常推进，不经 authorize()。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[29b-前置] submit 应 200，实得 ${rB.status}`);
    const rowB = await issueRow(idB);
    assert.strictEqual(rowB.status, '待验证', '[29b-前置] 应已到待验证');
    assert.strictEqual(rowB.fast_release_auth_at, null, '[29b-前置] 应从未授权（fast_release_auth_at 为空）');
    const addB = await addExecutor(idB, 6, adminTok);
    assert.strictEqual(addB.status, 409, `[29b] 无活跃授权时加人应 409，实得 ${addB.status} ${JSON.stringify(addB.body)}`);
    assert.strictEqual(addB.body.code, 'FASTLANE_ROSTER_NOT_STAGED', `[29b] 确切码，实得 ${addB.body.code}`);
    ok('[29b] 非挂牌态加人（已待验证但从未授权）：409 FASTLANE_ROSTER_NOT_STAGED（与 [29a] 同码，主表挂牌态谓词统一判定）');
  }

  // ══════════════════════════ [30]（S4·§4-4a）无资格用户加人拒三态 ══════════════════════════
  {
    const mk = async (tag) => {
      const idx = await bugAtChulizhong();
      await estimateFuture(idx);
      await authorize(idx, adminTok, tag);
      const rr = await call('POST', `/api/sys-issues/${idx}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(rr.status, 200, `[${tag}-前置] submit 应 200，实得 ${rr.status}`);
      return idx;
    };

    // [30a] 目标已停用（永久停用夹具 user22）。
    const idA = await mk('30a-已停用');
    const addA = await addExecutor(idA, 22, adminTok);
    assert.strictEqual(addA.status, 400, `[30a] 加已停用用户应 400，实得 ${addA.status} ${JSON.stringify(addA.body)}`);
    assert.strictEqual(addA.body.code, 'FASTLANE_ROSTER_TARGET_NOT_ELIGIBLE', `[30a] 确切码，实得 ${addA.body.code}`);
    assert.strictEqual((await fastExecRows(idA)).length, 1, '[30a] 拒绝后集合应仍恰 1 行（未插入不合格用户）');
    ok('[30a] 无资格用户加人拒·已停用：400 FASTLANE_ROSTER_TARGET_NOT_ELIGIBLE，未插入');

    // [30b] 目标为 viewer 角色（永久 viewer 夹具 user21）。
    const idB = await mk('30b-viewer');
    const addB = await addExecutor(idB, 21, adminTok);
    assert.strictEqual(addB.status, 400, `[30b] 加 viewer 用户应 400，实得 ${addB.status} ${JSON.stringify(addB.body)}`);
    assert.strictEqual(addB.body.code, 'FASTLANE_ROSTER_TARGET_NOT_ELIGIBLE', `[30b] 确切码，实得 ${addB.body.code}`);
    assert.strictEqual((await fastExecRows(idB)).length, 1, '[30b] 拒绝后集合应仍恰 1 行');
    ok('[30b] 无资格用户加人拒·viewer 角色：400 FASTLANE_ROSTER_TARGET_NOT_ELIGIBLE，未插入');

    // [30c] 目标用户不存在。
    const idC = await mk('30c-不存在');
    const addC = await addExecutor(idC, 999999, adminTok);
    assert.strictEqual(addC.status, 400, `[30c] 加不存在用户应 400，实得 ${addC.status} ${JSON.stringify(addC.body)}`);
    assert.strictEqual(addC.body.code, 'VALIDATION', `[30c] 确切码，实得 ${addC.body.code}`);
    assert.strictEqual((await fastExecRows(idC)).length, 1, '[30c] 拒绝后集合应仍恰 1 行');
    ok('[30c] 无资格用户加人拒·目标不存在：400 VALIDATION，未插入');
  }

  // ══════════════════════════ [31]（S4·§4-4b）移人 pending 正例 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '31-移人正例');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[31-前置] submit 应 200，实得 ${r.status}`);
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[31-前置] 加人应 200，实得 ${addR.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[31-前置] 应恰 2 行执行人');

    const rmR = await removeExecutor(id, 6, adminTok);
    assert.strictEqual(rmR.status, 200, `[31] 移除 pending 执行人应 200，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.flipped, false, '[31] 剩余仍含值班人 pending，不应翻牌');
    assert.strictEqual(rmR.body.user_name, '开发李', '[31] 响应应含被移除者姓名');

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[31] 全表仍应 2 行（软删非物理删除）');
    const removedRow = feRows.find(r2 => r2.user_id === 6);
    assert.ok(removedRow.removed_at, '[31] removed_at 应已写');
    const removedFull = await get('SELECT removed_by, removed_by_name FROM sys_fast_release_executors WHERE id = ?', [removedRow.id]);
    assert.strictEqual(removedFull.removed_by, 1, '[31] removed_by 应为操作者 admin(1)');
    assert.strictEqual(removedFull.removed_by_name, '管理员', '[31] removed_by_name 应为操作者姓名');
    const remainRow = feRows.find(r2 => r2.user_id === 20);
    assert.strictEqual(remainRow.removed_at, null, '[31] 值班人行不受影响，仍未软删');

    const tl = await timelineRowsByCode(id, 'fast_release_roster_removed');
    assert.strictEqual(tl.length, 1, `[31] timeline 应恰 1 条 fast_release_roster_removed，实得 ${tl.length}`);
    // [Opus 385 预筛 LOW-3 收口] 原 `summary.includes('pending')` 是恒真断言——本组的 UPDATE WHERE 已钉死
    // exec_status='pending' 才能进入成功分支（done 行结构性移不掉，见 [32]），故 targetBefore.exec_status
    // 在这条成功路径上结构上恒为 'pending'，测不出"值域覆盖"（不可能观察到 pending 之外的值）。收窄断言
    // 的真实价值为"格式回归"——钉死 summary 整体拼接格式（姓名+状态两个动态片段的位置与措辞）不因未来
    // 重构悄悄漂移，故改为逐字匹配完整字符串（非仅 substring 存在性判断）。
    assert.strictEqual(
      tl[0].summary,
      '先行上线移除执行人：管理员 将 开发李 移出执行人集合（移除前状态：pending）',
      `[31] summary 应逐字匹配完整格式串（格式回归断言，非值域覆盖——见上方注释），实得="${tl[0].summary}"`
    );
    ok('[31] 移人 pending 正例：软删三列齐（removed_at/removed_by/removed_by_name）+ timeline fast_release_roster_removed summary 逐字匹配完整格式串（格式回归，Opus 385 LOW-3 收口——原 includes(\'pending\') 断言在本成功路径上结构恒真，已收窄价值定位为格式而非值域）+ 值班人行不受影响，未翻牌');
  }

  // ══════════════════════════ [32]（S4·§4-4b·§5-⑨）移 done 行 409：已确认执行的执行人结构性移不掉 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '32-移done行');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[32-前置] submit 应 200，实得 ${r.status}`);
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[32-前置] 加人应 200，实得 ${addR.status}`);
    const rcR = await confirm(id, dutyTok);
    assert.strictEqual(rcR.status, 200, `[32-前置] 值班人确认应 200，实得 ${rcR.status}`);
    assert.strictEqual(rcR.body.flipped, false, '[32-前置] 两人中一人确认不应翻牌');

    const rmR = await removeExecutor(id, 20, adminTok);   // 尝试移除已 done 的值班人
    assert.strictEqual(rmR.status, 409, `[32] 移除已 done 执行人应 409，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.code, 'FASTLANE_ROSTER_REMOVE_INVALID', `[32] 确切码，实得 ${rmR.body.code}`);
    const feRows = await fastExecRows(id);
    const dutyRow = feRows.find(r2 => r2.user_id === 20);
    assert.strictEqual(dutyRow.removed_at, null, '[32] 已 done 的值班人行应仍未软删（结构性移不掉）');
    assert.strictEqual(dutyRow.exec_status, 'done', '[32] 值班人行 exec_status 应仍为 done');
    ok('[32] 移 done 行 409：已确认执行的执行人结构性移不掉（方案 §5-⑨），409 FASTLANE_ROSTER_REMOVE_INVALID，目标行零改动');
  }

  // ══════════════════════════ [33]（S4·§4-4b·372-H1' 核心）移人后剩余全 done 同事务翻牌正例（真实端点） ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '33-移人后翻牌');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[33-前置] submit 应 200，实得 ${r.status}`);
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[33-前置] 加人应 200，实得 ${addR.status}`);
    // 值班人（user20）确认 done；第二人（user6）仍 pending。
    const rcR = await confirm(id, dutyTok);
    assert.strictEqual(rcR.status, 200, `[33-前置] 值班人确认应 200，实得 ${rcR.status}`);
    assert.strictEqual(rcR.body.flipped, false, '[33-前置] 两人中一人确认不应翻牌');
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[33-前置] 应恰 2 行（值班人 done + 第二人 pending）');

    // admin 移除仍 pending 的第二人（user6）——剩余唯一活跃行=值班人（已 done），全 done ⇒ 应同事务翻牌。
    const rmR = await removeExecutor(id, 6, adminTok);
    assert.strictEqual(rmR.status, 200, `[33] 移除应 200，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.flipped, true, `[33] 剩余全 done ⇒ 应触发同事务翻牌，实得 ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.main_status, '已上线', `[33] 响应 main_status 应为已上线，实得 ${rmR.body.main_status}`);

    const row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[33] status 应为已上线');
    assert.ok(row.released_at, '[33] released_at 已写');
    assert.strictEqual(row.online_source, 'authorized_fastlane', '[33] online_source 应为 authorized_fastlane');
    assert.strictEqual(row.post_release_acceptance, 'pending', '[33] post_release_acceptance 应为 pending（§3.3 副作用）');
    assert.ok(row.fast_release_consumed_at, '[33] fast_release_consumed_at 已写');

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[33] 全表仍应 2 行（第二人软删，值班人保留 done）');
    const removedRow = feRows.find(r2 => r2.user_id === 6);
    assert.ok(removedRow.removed_at, '[33] 第二人行应已软删');
    const dutyRow = feRows.find(r2 => r2.user_id === 20);
    assert.strictEqual(dutyRow.exec_status, 'done', '[33] 值班人行仍应 done（未被本次移除动作触碰）');
    assert.strictEqual(dutyRow.removed_at, null, '[33] 值班人行不应被软删（done 行不受移人动作影响）');

    // timeline：应有 roster_removed 一条 + exec_online 一条（trigger=roster_remove）。
    const rmTl = await timelineRowsByCode(id, 'fast_release_roster_removed');
    assert.strictEqual(rmTl.length, 1, `[33] 应恰 1 条 fast_release_roster_removed，实得 ${rmTl.length}`);
    const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
    assert.strictEqual(onlineTl.length, 1, `[33] 应恰 1 条 fast_release_exec_online，实得 ${onlineTl.length}`);
    assert.ok(onlineTl[0].summary.includes('trigger=roster_remove'), `[33] summary 应含 "trigger=roster_remove"，实得="${onlineTl[0].summary}"`);
    assert.ok(onlineTl[0].summary.includes('移除执行人后自动全员达成'), `[33] summary 应含中文说明，实得="${onlineTl[0].summary}"`);
    // [Opus 385 预筛 MED-2 收口] 因果顺序断言——roster_removed（"移除执行人"这个动作本身）必须比
    // exec_online（内核判定"剩余全 done"后写的翻牌镜像行，summary 自称"移除执行人后自动全员达成"）
    // 先落库（id 更小）。若实现把 timeline INSERT 顺序改回"先调内核再写 roster_removed"（MED-2 修复前
    // 的旧写法），详情页按 id 升序渲染会出现"结果行排在原因行前面"的因果倒置，本条会红。
    assert.ok(rmTl[0].id < onlineTl[0].id, `[33] ⭐ roster_removed.id 应小于 exec_online.id（移除记录须先于翻牌镜像行落库，防因果倒置），实得 roster_removed.id=${rmTl[0].id} exec_online.id=${onlineTl[0].id}`);
    ok('[33] 移人后剩余全 done 同事务翻牌正例（372-H1 核心·真实端点链路）：admin 移除唯一 pending 执行人后剩余恰为已 done 值班人 ⇒ 同事务翻牌全套写点 + timeline exec_online trigger=roster_remove + roster_removed.id < exec_online.id（因果顺序正确，Opus 385 MED-2 收口）（与 [25c] 内核单元测试互证：[25c] 测文案分支本身、本组测真实 DELETE 端点是否正确接线该 trigger 值）');
  }

  // ══════════════════════════ [34]（S4·§4-4b）移人后剩余为空不翻（回 0/0）+ 此后加人解冻 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '34-移空后解冻');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[34-前置] submit 应 200，实得 ${r.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[34-前置] 应恰 1 行（值班人 pending，未确认）');

    const rmR = await removeExecutor(id, 20, adminTok);
    assert.strictEqual(rmR.status, 200, `[34] 移除唯一 pending 执行人应 200，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.flipped, false, '[34] 剩余为空，不应翻牌（空集合恒不可翻，方案 §5-⑧）');
    assert.strictEqual(rmR.body.main_status, '待验证', '[34] 主状态应仍待验证');

    const row = await issueRow(id);
    assert.strictEqual(row.status, '待验证', '[34] status 应仍待验证');
    assert.strictEqual(row.released_at, null, '[34] released_at 应仍为空');
    const activeRows = (await fastExecRows(id)).filter(x => !x.removed_at);
    assert.strictEqual(activeRows.length, 0, `[34] 移除后活跃执行人集合应恰 0 行（回到 0/0），实得 ${activeRows.length}`);

    // 此后加人——集合已归零，无残留 done 行，理应不受冻结闸误伤（正常放行）。
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[34] 归零后加人应正常 200（未被误判 FASTLANE_ROSTER_FROZEN），实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    const afterActive = (await fastExecRows(id)).filter(x => !x.removed_at);
    assert.strictEqual(afterActive.length, 1, `[34] 加人后活跃集合应恰 1 行，实得 ${afterActive.length}`);
    ok('[34] 移人后剩余为空不翻（回 0/0，方案 §5-⑧空集合恒不可翻）：主状态/released_at 零改动；此后加人正常放行（无残留 done 行，未被误判冻结）');
  }

  // ══════════════════════════ [35]（S4·§4-4b·373-H）非挂牌态移人 409：同源判据、同码 ══════════════════════════
  {
    // 单未到「待验证」（仍处理中）。SQL 造态直接插一行执行人（模拟"异常残留行"场景——正常流程下处理中
    // 态不可能有执行人行，本组要证明的正是"即便有异常残留，非挂牌态移人依然被主表联判拦下"，373-H
    // 原文"异常残留行不被非挂牌单摸到"）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '35-非挂牌态移人');
    const rowMid = await issueRow(id);
    assert.strictEqual(rowMid.status, '处理中', '[35-前置] 应仍处理中（未 submit）');
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 6, '开发李', 1, '管理员')`, [id]);
    const rmR = await removeExecutor(id, 6, adminTok);
    assert.strictEqual(rmR.status, 409, `[35] 非挂牌态移人应 409，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.code, 'FASTLANE_ROSTER_NOT_STAGED', `[35] 确切码，实得 ${rmR.body.code}`);
    const rows = await fastExecRows(id);
    assert.strictEqual(rows[0].removed_at, null, '[35] 异常残留行应零改动（未被非挂牌单摸到）');
    ok('[35] 非挂牌态移人：409 FASTLANE_ROSTER_NOT_STAGED（同 [29] 同源判据、同码），异常残留行零改动（373-H"不被非挂牌单摸到"）');
  }

  // ══════════════════════════ [36]（S4·§4-4b）移不存在的人：目标 user_id 从未在册 ⇒ 409 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '36-移不存在的人');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[36-前置] submit 应 200，实得 ${r.status}`);
    const rmR = await removeExecutor(id, 6, adminTok);   // user6 从未被加入本单执行人集合
    assert.strictEqual(rmR.status, 409, `[36] 移不存在的人应 409，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.code, 'FASTLANE_ROSTER_REMOVE_INVALID', `[36] 确切码，实得 ${rmR.body.code}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[36] 集合应仍恰 1 行（值班人不受影响）');
    ok('[36] 移不存在的人：目标 user_id 从未在册 ⇒ 409 FASTLANE_ROSTER_REMOVE_INVALID（与 [32] 同码统一，不单独 404——同 FAST_RELEASE_EXEC_CONFIRM_INVALID 多成因合并一码既有精神）');
  }

  // ══════════════════════════ [37]（S4）confirm×remove 竞争串行化成对：sysBeginImmediate 全库写 mutex 下天然串行 ══════════════════════════
  //   ⚠️ 编码期实测证伪过一版"Promise.all 后按 status===200 运行时判断谁赢"的写法——对同一批 [confirmR,
  //   removeR] 顺序发起 5 次连跑，confirm 5/5 恰好都赢（本环境 http.request 的建连/分发顺序与 Promise.all
  //   数组顺序强相关，不是真随机）；若不显式交换数组顺序，remove 赢的分支永远是"结构上正确但从未被真实
  //   跑过"的死断言（同 [[feedback_probe_test_bidirectional_proof]] 反向一对精神——只写一个方向的强断言，
  //   另一方向可能悄悄失守而无人知晓）。改为**成对**：37a 数组顺序 [confirm,remove]、37b 反过来
  //   [remove,confirm]，各自独立单据 + 确定性断言（非运行时 if/else 猜哪边赢）——已实测两版分别精确对应
  //   confirm 赢 / remove 赢，非猜测。
  {
    // [37a] 数组顺序 [confirm, remove]——本环境实测确定性地由 confirm 赢得串行顺序。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '37a-confirm先');
    const rA = await call('POST', `/api/sys-issues/${idA}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rA.status, 200, `[37a-前置] submit 应 200，实得 ${rA.status}`);
    assert.strictEqual((await fastExecRows(idA)).length, 1, '[37a-前置] 应恰 1 行（唯一执行人=值班人 user20，pending）');

    // 并发发起：sysBeginImmediate 全库写 mutex（:2745-2793 一带单全局锁，"成功 COMMIT 或任一 ROLLBACK
    // 才释放"）下两个事务天然串行化，不可能出现交错写；HTTP 层两个请求确实并发到达，谁先拿到锁谁就
    // 完整跑完全部逻辑（含自身的 COMMIT/ROLLBACK）才轮到下一个开始。
    const [confirmA, removeA] = await Promise.all([confirm(idA, dutyTok), removeExecutor(idA, 20, adminTok)]);
    assert.strictEqual(confirmA.status, 200, `[37a] confirm 应赢得串行顺序并 200，实得 ${confirmA.status} ${JSON.stringify(confirmA.body)}`);
    assert.strictEqual(confirmA.body.flipped, true, '[37a] 唯一执行人确认应末位翻牌');
    assert.strictEqual(removeA.status, 409, `[37a] remove 落空于 confirm 已提交之后应 409，实得 ${removeA.status} ${JSON.stringify(removeA.body)}`);
    assert.strictEqual(removeA.body.code, 'FASTLANE_ROSTER_NOT_STAGED', `[37a] 确切码（confirm 已翻牌，单已不在待验证），实得 ${removeA.body.code}`);
    const rowA = await issueRow(idA);
    assert.strictEqual(rowA.status, '已上线', '[37a] 主表应已翻牌');
    const feA = await fastExecRows(idA);
    assert.strictEqual(feA[0].exec_status, 'done', '[37a] 执行人行应 done');
    assert.strictEqual(feA[0].removed_at, null, '[37a] 执行人行不应被软删（remove 一侧整体失败，零副作用）');
    ok('[37a] confirm×remove 竞争串行化·confirm 先：数组顺序 [confirm,remove] 下 confirm 200(flipped=true)+remove 409(FASTLANE_ROSTER_NOT_STAGED)，主表已翻牌+执行人行 done 且未软删（remove 一侧零副作用，非猜测——本环境实测确定性复现）');

    // [37b] 数组顺序 [remove, confirm]——本环境实测确定性地由 remove 赢得串行顺序（与 37a 互为反向一对，
    //   证明"remove 赢"这条分支的断言不是死代码：真实跑到过、真实正确）。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    await authorize(idB, adminTok, '37b-remove先');
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[37b-前置] submit 应 200，实得 ${rB.status}`);
    assert.strictEqual((await fastExecRows(idB)).length, 1, '[37b-前置] 应恰 1 行（唯一执行人=值班人 user20，pending）');

    const [removeB, confirmB] = await Promise.all([removeExecutor(idB, 20, adminTok), confirm(idB, dutyTok)]);
    assert.strictEqual(removeB.status, 200, `[37b] remove 应赢得串行顺序并 200，实得 ${removeB.status} ${JSON.stringify(removeB.body)}`);
    assert.strictEqual(removeB.body.flipped, false, '[37b] 移除唯一 pending 执行人后集合归零，不应翻牌（空集合恒不可翻）');
    assert.strictEqual(confirmB.status, 403, `[37b] confirm 落空于 remove 已提交之后应 403，实得 ${confirmB.status} ${JSON.stringify(confirmB.body)}`);
    assert.strictEqual(confirmB.body.code, 'FAST_RELEASE_EXEC_NOT_ROSTERED', `[37b] 确切码（本人行已被 remove 软删，不在册），实得 ${confirmB.body.code}`);
    const rowB = await issueRow(idB);
    assert.strictEqual(rowB.status, '待验证', '[37b] 主表应仍待验证（未翻牌）');
    const feB = await fastExecRows(idB);
    assert.ok(feB[0].removed_at, '[37b] 执行人行应已软删');
    assert.strictEqual(feB[0].exec_status, 'pending', '[37b] 执行人行 exec_status 应仍 pending（confirm 一侧整体失败，未被误标 done）');
    ok('[37b] confirm×remove 竞争串行化·remove 先：数组顺序 [remove,confirm] 下 remove 200(flipped=false)+confirm 403(FAST_RELEASE_EXEC_NOT_ROSTERED)，主表未翻牌+执行人行已软删且仍 pending（confirm 一侧零副作用，与 37a 互为反向一对——两个方向均真实跑到过）');
  }

  // ══════════════════════════ [38]（Opus 385 预筛 MED-4）软删后重加同 user_id 反向一对 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '38-软删重加');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[38-前置] submit 应 200，实得 ${r.status}`);
    const addFirst = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addFirst.status, 200, `[38-前置] 加第二人应 200，实得 ${addFirst.status}`);
    let allRows = await fastExecRows(id);
    assert.strictEqual(allRows.length, 2, '[38-前置] 应恰 2 行（值班人+第二人，均 active）');

    // 移错人（把第二人移出）。
    const rmR = await removeExecutor(id, 6, adminTok);
    assert.strictEqual(rmR.status, 200, `[38] 移除第二人应 200，实得 ${rmR.status}`);
    allRows = await fastExecRows(id);
    assert.strictEqual(allRows.length, 2, '[38-移除后] 全表仍恰 2 行（软删非物理删除）');
    const activeAfterRemove = allRows.filter(x => !x.removed_at);
    assert.strictEqual(activeAfterRemove.length, 1, '[38-移除后] 活跃行应恰 1（仅值班人）');

    // 真实运维动作：发现移错了，把同一个人加回来——partial UNIQUE 索引只约束"未软删"的 (issue_id,user_id)，
    // 若被误改成全表 UNIQUE（丢了 WHERE removed_at IS NULL），本次 INSERT 会撞旧软删行崩 UNIQUE，本条会红。
    const addAgain = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addAgain.status, 200, `[38] 重加同一 user_id 应 200（partial UNIQUE 不拦软删行），实得 ${addAgain.status} ${JSON.stringify(addAgain.body)}`);

    allRows = await fastExecRows(id);
    assert.strictEqual(allRows.length, 3, `[38] 全表应恰 3 行（值班人 active + 第二人旧软删行 + 第二人新 active 行），实得 ${allRows.length}`);
    const user6Rows = allRows.filter(x => x.user_id === 6);
    assert.strictEqual(user6Rows.length, 2, '[38] user_id=6 应恰 2 行（1 旧软删 + 1 新 active）');
    const user6Active = user6Rows.filter(x => !x.removed_at);
    assert.strictEqual(user6Active.length, 1, '[38] user_id=6 在册（未软删）行应恰 1（重加成功且未产生双活跃行）');
    const user6Removed = user6Rows.filter(x => x.removed_at);
    assert.strictEqual(user6Removed.length, 1, '[38] user_id=6 应恰 1 行旧软删记录保留（审计痕迹不丢）');
    const overallActive = allRows.filter(x => !x.removed_at);
    assert.strictEqual(overallActive.length, 2, '[38] 全局活跃集合应恰 2 行（值班人+重加的第二人）');
    ok('[38]（Opus 385 预筛 MED-4）软删后重加同 user_id 反向一对：移人→重加同一 user_id 正常 200，全表 3 行（值班人 active + 第二人旧软删 + 第二人新 active），user_id=6 在册恰 1 行（partial UNIQUE 索引若被误改为全表 UNIQUE，本次重加会崩 409/500，本条钉死"移错人加回来"这条真实运维动作受保护）');
  }

  // ══════════════════════════ [39]（Opus 385 预筛 MED-3）user_name 归一化级联三态 ══════════════════════════
  {
    // [39a] 目标 display_name 纯 Tab + username 正常 ⇒ 200 落库=username 回退值（非 500+裸 SQLite 报错）。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '39a-目标tab一级');
    const rA = await call('POST', `/api/sys-issues/${idA}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rA.status, 200, `[39a-前置] submit 应 200，实得 ${rA.status}`);
    const addA = await addExecutor(idA, 23, adminTok);
    assert.strictEqual(addA.status, 200, `[39a] display_name 纯 Tab 的目标加人应 200（非 500），实得 ${addA.status} ${JSON.stringify(addA.body)}`);
    assert.strictEqual(addA.body.user_name, 'tab_fallback_user', `[39a] 响应 user_name 应回退到 username，实得="${addA.body.user_name}"`);
    const rowA = (await fastExecRows(idA)).find(x => x.user_id === 23);
    assert.strictEqual(rowA.user_name, 'tab_fallback_user', `[39a] 落库 user_name 应回退到 username「tab_fallback_user」（非纯 Tab 值），实得="${rowA.user_name}"`);
    ok('[39a] 归一化级联一级 fallback：目标 display_name 纯 Tab、username 正常 ⇒ 加人 200，落库/响应 user_name 均回退到 username（非 500+裸 SQLite CHECK 报错泄漏）');

    // [39b] 目标 display_name/username 均纯 Tab ⇒ 200 落库=user#id 兜底字面量。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    await authorize(idB, adminTok, '39b-目标tab两级');
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[39b-前置] submit 应 200，实得 ${rB.status}`);
    const addB = await addExecutor(idB, 24, adminTok);
    assert.strictEqual(addB.status, 200, `[39b] 两级均纯 Tab 的目标加人应 200，实得 ${addB.status} ${JSON.stringify(addB.body)}`);
    assert.strictEqual(addB.body.user_name, 'user#24', `[39b] 响应 user_name 应回退到 user#24 兜底字面量，实得="${addB.body.user_name}"`);
    const rowB = (await fastExecRows(idB)).find(x => x.user_id === 24);
    assert.strictEqual(rowB.user_name, 'user#24', `[39b] 落库 user_name 应为 user#24 兜底字面量，实得="${rowB.user_name}"`);
    ok('[39b] 归一化级联两级均空 fallback：目标 display_name/username 均纯 Tab ⇒ 加人 200，落库/响应 user_name 均回退到 user#24 兜底字面量');

    // [39c] 操作者（admin）display_name 纯 Tab——加人 added_by_name / 移人 removed_by_name 均应正确归一化
    //   （归一化不止服务目标用户一侧，操作者一侧同样生效，两处写名点各验一次）。
    const idC = await bugAtChulizhong();
    await estimateFuture(idC);
    await authorize(idC, adminTok, '39c-操作者tab');
    const rC = await call('POST', `/api/sys-issues/${idC}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rC.status, 200, `[39c-前置] submit 应 200，实得 ${rC.status}`);
    const addC = await addExecutor(idC, 6, tabAdminTok);
    assert.strictEqual(addC.status, 200, `[39c] display_name 纯 Tab 的 admin 加人应 200，实得 ${addC.status} ${JSON.stringify(addC.body)}`);
    const rowC1 = (await fastExecRows(idC)).find(x => x.user_id === 6);
    const addedByC = await get('SELECT added_by_name FROM sys_fast_release_executors WHERE id = ?', [rowC1.id]);
    assert.strictEqual(addedByC.added_by_name, 'tab_admin_fallback', `[39c-加人] added_by_name 应回退到 username「tab_admin_fallback」，实得="${addedByC.added_by_name}"`);
    const rmC = await removeExecutor(idC, 6, tabAdminTok);
    assert.strictEqual(rmC.status, 200, `[39c] display_name 纯 Tab 的 admin 移人应 200，实得 ${rmC.status} ${JSON.stringify(rmC.body)}`);
    const removedByC = await get('SELECT removed_by_name FROM sys_fast_release_executors WHERE id = ?', [rowC1.id]);
    assert.strictEqual(removedByC.removed_by_name, 'tab_admin_fallback', `[39c-移人] removed_by_name 应回退到 username「tab_admin_fallback」，实得="${removedByC.removed_by_name}"`);
    ok('[39c] 操作者一侧归一化：display_name 纯 Tab 的 admin（tabAdminTok）加人 added_by_name / 移人 removed_by_name 均正确回退到 username「tab_admin_fallback」（非 500，四处写名点里"操作者"一侧同样生效）');
  }

  // ══════════════════════════ [40]（Opus 385 预筛 MED-5）两新端点 403 权限负例 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '40-权限负例');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[40-前置] submit 应 200，实得 ${r.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[40-前置] 应恰 1 行（值班人）');

    // 加人：非 admin（devTok）应 403，零插入。
    const addR = await addExecutor(id, 6, devTok);
    assert.strictEqual(addR.status, 403, `[40-加人] 非 admin 应 403，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[40-加人] 403 后集合应仍恰 1 行（零插入），实得 ${feRows.length}`);

    // 移人：非 admin（devTok）应 403，目标行零改动。
    const beforeRemove = await fastExecRows(id);
    const removeR = await removeExecutor(id, 20, devTok);
    assert.strictEqual(removeR.status, 403, `[40-移人] 非 admin 应 403，实得 ${removeR.status} ${JSON.stringify(removeR.body)}`);
    const afterRemove = await fastExecRows(id);
    assert.deepStrictEqual(afterRemove, beforeRemove, '[40-移人] 403 被中间件拦下，目标行应与之前逐字段一致（零改动）');
    ok('[40]（Opus 385 预筛 MED-5）两新端点 403 权限负例：devTok（非 admin）加人 403+零插入 / 移人 403+目标行零改动（与 requireAdmin 中间件同 verify-sys-fastrelease-auth [4] 组范式）');
  }

  // ══════════════════════════ [41]（codex 387 回卷 MED）加人×确认并发：终态枚举法 ══════════════════════════
  //   ⚠️ codex 387 号明确要求：本组用"允许终态集合"断言，不用 [37a]/[37b] 那种"固定 Promise 数组顺序 +
  //   硬编码期望赢家"写法——那种写法把"本环境 http.request 建连顺序恰好=数组顺序"这条环境特性焊进了
  //   断言本身；本组改为"无论谁先赢，按响应内容动态判定落在哪个终态 → 校验该终态自身的完整不变量 +
  //   拒绝任何第三种杂交态"，更贴近生产真实并发（顺序不可控）。仍参考 [37] 先例交换发起顺序跑两遍，
  //   目的不是断言"某个方向必赢"，而是确保两个方向各自都真被观测到过至少一次（否则另一方向的分支
  //   永远是死代码，同 [37] 首版踩过的坑）。
  {
    // 终态分类器——只认响应内容，不认调用方传入的发起顺序标记。
    function classifyRosterAddConfirmRace(addR, confirmR) {
      if (addR.status === 200 && confirmR.status === 200 && confirmR.body.flipped === false) return 'add_first';
      if (confirmR.status === 200 && confirmR.body.flipped === true
        && addR.status === 409 && addR.body && addR.body.code === 'FASTLANE_ROSTER_NOT_STAGED') return 'confirm_first';
      return 'unknown';
    }
    const observedCases = new Set();
    async function runRosterAddConfirmRace(tag, dispatchAddFirst) {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, `${tag}-加人x确认并发`);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[${tag}-前置] submit 应 200，实得 ${r.status}`);
      assert.strictEqual((await fastExecRows(id)).length, 1, `[${tag}-前置] 应恰 1 行（值班人 pending）`);

      let addR, confirmR;
      if (dispatchAddFirst) {
        [addR, confirmR] = await Promise.all([addExecutor(id, 6, adminTok), confirm(id, dutyTok)]);
      } else {
        [confirmR, addR] = await Promise.all([confirm(id, dutyTok), addExecutor(id, 6, adminTok)]);
      }

      const kase = classifyRosterAddConfirmRace(addR, confirmR);
      assert.notStrictEqual(kase, 'unknown',
        `[${tag}] 终态应落入允许集合 {add_first, confirm_first}，实得未知组合 add=${addR.status}(${JSON.stringify(addR.body)}) confirm=${confirmR.status}(${JSON.stringify(confirmR.body)})——杂交态（如不翻牌却 409、或翻牌却加入仍成功）视为红`);
      observedCases.add(kase);

      const row = await issueRow(id);
      const feRows = await fastExecRows(id);
      if (kase === 'add_first') {
        // 加人先提交：两请求 200，集合变 2 人；confirm 只标记值班人 done，二人未全 done 不翻牌。
        assert.strictEqual(row.status, '待验证', `[${tag}-add_first] 主状态应仍待验证，实得 ${row.status}`);
        assert.strictEqual(feRows.length, 2, `[${tag}-add_first] 集合应恰 2 行，实得 ${feRows.length}`);
        const dutyRow = feRows.find(x => x.user_id === 20);
        const newRow = feRows.find(x => x.user_id === 6);
        assert.ok(dutyRow && newRow, `[${tag}-add_first] 应能找到值班人与新加人两行`);
        assert.strictEqual(dutyRow.exec_status, 'done', `[${tag}-add_first] 值班人应 done`);
        assert.strictEqual(newRow.exec_status, 'pending', `[${tag}-add_first] 新加人应 pending`);
        const tl = await timelineRowsByCode(id, 'fast_release_roster_added');
        assert.strictEqual(tl.length, 1, `[${tag}-add_first] 应恰 1 条 roster_added timeline，实得 ${tl.length}`);
        const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
        assert.strictEqual(onlineTl.length, 0, `[${tag}-add_first] 不应有 exec_online（未翻牌），实得 ${onlineTl.length}`);
      } else {
        // 确认先提交：唯一执行人全 done ⇒ 末位翻牌，单已不在待验证态，加人被挂牌态谓词拦下。
        assert.strictEqual(row.status, '已上线', `[${tag}-confirm_first] 主状态应已上线，实得 ${row.status}`);
        assert.strictEqual(feRows.length, 1, `[${tag}-confirm_first] 集合应仍恰 1 行（加人被拒未插入），实得 ${feRows.length}`);
        assert.strictEqual(feRows[0].user_id, 20, `[${tag}-confirm_first] 唯一行应为值班人`);
        assert.strictEqual(feRows[0].exec_status, 'done', `[${tag}-confirm_first] 值班人应 done`);
        const tl = await timelineRowsByCode(id, 'fast_release_roster_added');
        assert.strictEqual(tl.length, 0, `[${tag}-confirm_first] 不应有 roster_added timeline（加人未成功），实得 ${tl.length}`);
        const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
        assert.strictEqual(onlineTl.length, 1, `[${tag}-confirm_first] 应恰 1 条 exec_online，实得 ${onlineTl.length}`);
      }
      return kase;
    }

    const k1 = await runRosterAddConfirmRace('41a', true);
    const k2 = await runRosterAddConfirmRace('41b', false);
    assert.strictEqual(observedCases.size, 2,
      `[41] 两次不同发起顺序应合计覆盖两种允许终态（非同一种终态出现两次——否则另一方向从未被真实观测到），实得观测集合=${JSON.stringify([...observedCases])}（41a=${k1}，41b=${k2}）`);
    ok(`[41]（codex 387 回卷 MED）加人×确认并发：终态枚举法——两次不同发起顺序分别命中 add_first（加人先提交=两 200+集合2人1done1pending+不翻牌）与 confirm_first（确认先提交=confirm翻牌+加人409 FASTLANE_ROSTER_NOT_STAGED），零杂交态，timeline 行数与各自终态自洽，两方向均真实跑到（41a=${k1}，41b=${k2}）`);
  }

  // ══════════════════════════ [42]（codex 387 回卷 MED）双加人同 user_id 并发：partial UNIQUE 冲突竞态 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '42-双加人同人');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[42-前置] submit 应 200，实得 ${r.status}`);
    assert.strictEqual((await fastExecRows(id)).length, 1, '[42-前置] 应恰 1 行（值班人 pending）');

    // 两个不同 admin（adminTok / tabAdminTok）并发对同一 issue 加同一目标 user_id（user6）——
    // sysBeginImmediate 全库写 mutex 下天然串行化，先提交者的 INSERT 成功；后提交者的 INSERT 撞
    // partial UNIQUE(issue_id,user_id) WHERE removed_at IS NULL（先提交者刚落的活跃行），落 409 语义化
    // 捕获。与 [41] 不同：本组两侧动作同构（均为"加人"，无状态转移复杂度），不需要按发起顺序分两种
    // 终态——恰一方 200/另一方 409 是唯一合法结果，与谁先谁后无关（不像 [41] 那样"谁先"决定走哪条
    // 业务分支）。
    const [r1, r2] = await Promise.all([addExecutor(id, 6, adminTok), addExecutor(id, 6, tabAdminTok)]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], `[42] 应恰一方 200、另一方 409（互斥语义），实得 r1=${r1.status}(${JSON.stringify(r1.body)}) r2=${r2.status}(${JSON.stringify(r2.body)})`);
    const loser = r1.status === 409 ? r1 : r2;
    const winner = r1.status === 200 ? r1 : r2;
    assert.strictEqual(loser.body.code, 'FASTLANE_ROSTER_ALREADY_ADDED', `[42] 落败方确切码，实得 ${loser.body.code}`);
    assert.strictEqual(winner.body.user_id, 6, '[42] 胜出方响应 user_id 应为目标用户');

    const feRows = await fastExecRows(id);
    const user6Rows = feRows.filter(x => x.user_id === 6);
    assert.strictEqual(user6Rows.length, 1, `[42] user_id=6 全表应恰 1 行（未产生双活跃行/未产生残留），实得 ${user6Rows.length}`);
    assert.strictEqual(user6Rows[0].removed_at, null, '[42] 该行应未软删（在册）');
    assert.strictEqual(feRows.length, 2, `[42] 全局集合应恰 2 行（值班人+胜出的第二人），实得 ${feRows.length}`);

    const tl = await timelineRowsByCode(id, 'fast_release_roster_added');
    assert.strictEqual(tl.length, 1, `[42] roster_added timeline 应恰 1 条（败方整体回滚，不留半条记录），实得 ${tl.length}`);
    ok('[42]（codex 387 回卷 MED）双加人同 user_id 并发：两个不同 admin 并发加同一目标 ⇒ 恰一方 200/另一方 409 FASTLANE_ROSTER_ALREADY_ADDED，该 user_id 在册恰 1 行（无双活跃行/无残留），roster_added timeline 恰 1 条（互斥语义，与发起顺序无关，partial UNIQUE 索引竞态防线生效）');
  }

  // ══════════════════════════ [43]（S5·§4-5）revoke 无 done 正例：全清+cleared 码+重授权重挂牌不撞 UNIQUE（核心价值） ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '43-revoke核心价值');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[43-前置] submit 应 200，实得 ${r.status}`);
    assert.strictEqual((await fastExecRows(id)).length, 1, '[43-前置] 应恰 1 行（值班人 pending）');

    const revokeR = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '43-核心价值撤销' });
    assert.strictEqual(revokeR.status, 200, `[43] revoke 应 200，实得 ${revokeR.status} ${JSON.stringify(revokeR.body)}`);

    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 0, '[43] 撤销后集合应零未软删行');
    assert.strictEqual(feRows.length, 1, '[43] 全表仍应恰 1 行（软删非物理删除）');
    const tl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(tl.length, 1, `[43] 应恰 1 条 fast_release_roster_cleared，实得 ${tl.length}`);
    assert.ok(tl[0].summary.includes('撤销授权'), `[43] summary 应含成因"撤销授权"，实得="${tl[0].summary}"`);

    // ⭐ 核心价值断言：撤销 → 打回退回处理中 → 重新授权 → 重新 submit → 重新挂牌——新一代集合行 INSERT
    //   不应撞 partial UNIQUE（若撤销没清集合，本次重挂牌会因旧代次那行仍未软删而直接 500 崩溃）。
    const returnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '43-退回处理中重走' });
    assert.strictEqual(returnR.status, 200, `[43-重走] return 应 200，实得 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    assert.strictEqual(returnR.body.status, '处理中', `[43-重走] 应回处理中，实得 ${returnR.body.status}`);
    const reAuthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '43-重新授权' });
    assert.strictEqual(reAuthR.status, 200, `[43-重走] 重新授权应 200，实得 ${reAuthR.status} ${JSON.stringify(reAuthR.body)}`);
    assert.strictEqual(reAuthR.body.reauthorized, true, '[43-重走] 应识别为重新授权（非首次）');
    // return 已清空 dev_estimated_at（case 'return' setFrags 既有行为，与本组测试目标无关的必要前置）——
    // 重新走一遍 estimate 才能再次 submit（真实链路里开发打回后本就需要重新回填预计完成时间）。
    await estimateFuture(id);
    const reSubmitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(reSubmitR.status, 200, `[43-重走] 重新 submit 应 200（不应因旧代次未软删行撞 UNIQUE 而 500），实得 ${reSubmitR.status} ${JSON.stringify(reSubmitR.body)}`);
    assert.strictEqual(reSubmitR.body.main_status, '待验证', `[43-重走] 应重新进入待验证，实得 ${reSubmitR.body.main_status}`);

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, `[43-重走] 全表应恰 2 行（首轮软删 1 + 新一代 1），实得 ${feRows.length}`);
    const activeRows = feRows.filter(x => !x.removed_at);
    assert.strictEqual(activeRows.length, 1, `[43-重走] 活跃行应恰 1（新一代），实得 ${activeRows.length}`);
    assert.strictEqual(activeRows[0].user_id, 20, '[43-重走] 新一代活跃行应为值班人（同一人也不撞——partial UNIQUE 只挡未软删的重复）');
    ok('[43]（S5·§4-5 核心价值）revoke 无 done 正例：撤销后集合零未软删行+roster_cleared（成因"撤销授权"）；重走全序列（撤销→打回→重新授权→重新 submit→重新挂牌）新一代集合行 INSERT 不撞 partial UNIQUE（核心价值断言：不清集合就会撞崩 500，本条钉死"清了就不会"）');
  }

  // ══════════════════════════ [44]（S5·§4-5）revoke 有 done 409 成对 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '44-revoke有done');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[44-前置] submit 应 200，实得 ${r.status}`);
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[44-前置] 加第二人应 200，实得 ${addR.status}`);
    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[44-前置] 值班人确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, false, '[44-前置] 两人一人确认不应翻牌');

    const revokeR = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '44-有done撤销' });
    assert.strictEqual(revokeR.status, 409, `[44] 有 done 行时撤销应 409，实得 ${revokeR.status} ${JSON.stringify(revokeR.body)}`);
    assert.strictEqual(revokeR.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[44] 确切码，实得 ${revokeR.body.code}`);

    const rowAfterDeny = await issueRow(id);
    assert.strictEqual(rowAfterDeny.fast_release_revoked_at, null, '[44] 撤销被闸整体回滚，revoked_at 应仍为空');
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 2, '[44] 集合应仍恰 2 行活跃（撤销被闸未清集合）');
    ok('[44] revoke 有 done：409 FASTLANE_DEPLOY_IN_PROGRESS（授权/集合零改动，整体回滚，与 [43] 无 done 正例互为成对）');
  }

  // ══════════════════════════ [45]（S5·§4-6）accept 验收闸成对：无 done 正常终结+清集合 / 有 done 409 ══════════════════════════
  {
    // [45a] 无 done：正常验收通过（待验证→待上线，regular path），同事务终结授权 + 清集合。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '45a-accept无done');
    const rA = await call('POST', `/api/sys-issues/${idA}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rA.status, 200, `[45a-前置] submit 应 200，实得 ${rA.status}`);
    assert.strictEqual((await fastExecRows(idA)).length, 1, '[45a-前置] 应恰 1 行（值班人 pending）');
    const acceptA = await call('POST', `/api/sys-issues/${idA}/accept`, adminTok, {});
    assert.strictEqual(acceptA.status, 200, `[45a] accept 应 200，实得 ${acceptA.status} ${JSON.stringify(acceptA.body)}`);
    assert.strictEqual(acceptA.body.status, '待上线', `[45a] 应落待上线（非 C9 直翻），实得 ${acceptA.body.status}`);
    const feA = await fastExecRows(idA);
    assert.strictEqual(feA.filter(x => !x.removed_at).length, 0, '[45a] 集合应零未软删行');
    const tlA = await timelineRowsByCode(idA, 'fast_release_roster_cleared');
    assert.strictEqual(tlA.length, 1, `[45a] 应恰 1 条 fast_release_roster_cleared，实得 ${tlA.length}`);
    assert.ok(tlA[0].summary.includes('验收通过'), `[45a] summary 应含成因"验收通过"，实得="${tlA[0].summary}"`);
    ok('[45a] accept 无 done：正常验收通过（待上线）+ 同事务清集合（零未软删行 + roster_cleared 成因"验收通过"）');

    // [45b] 有 done：两人集合一人已确认（避免唯一执行人一确认就自动翻牌），accept 应被 §4-6 闸拦下
    //   409；其余 pending 者仍可续走 confirm 完成翻牌（验收被闸不等于执行流程被卡死，两条路互不阻塞）。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    await authorize(idB, adminTok, '45b-accept有done');
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[45b-前置] submit 应 200，实得 ${rB.status}`);
    const addB = await addExecutor(idB, 6, adminTok);
    assert.strictEqual(addB.status, 200, `[45b-前置] 加第二人应 200，实得 ${addB.status}`);
    const confirmB1 = await confirm(idB, dutyTok);
    assert.strictEqual(confirmB1.status, 200, `[45b-前置] 值班人确认应 200，实得 ${confirmB1.status}`);
    assert.strictEqual(confirmB1.body.flipped, false, '[45b-前置] 两人一人确认不应翻牌');

    const acceptB = await call('POST', `/api/sys-issues/${idB}/accept`, adminTok, {});
    assert.strictEqual(acceptB.status, 409, `[45b] 有 done 行时 accept 应 409，实得 ${acceptB.status} ${JSON.stringify(acceptB.body)}`);
    assert.strictEqual(acceptB.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[45b] 确切码，实得 ${acceptB.body.code}`);
    const rowBAfterDeny = await issueRow(idB);
    assert.strictEqual(rowBAfterDeny.status, '待验证', '[45b] 主状态应仍待验证（accept 被闸整体回滚）');
    assert.ok(rowBAfterDeny.fast_release_auth_at, '[45b] 授权六列不应被终结（accept 被闸整体回滚，不触碰授权字段）');
    const feBAfterDeny = await fastExecRows(idB);
    assert.strictEqual(feBAfterDeny.filter(x => !x.removed_at).length, 2, '[45b] 集合应仍恰 2 行活跃（accept 被闸未清集合）');

    // 续走：第二人（user6）确认，集合全 done ⇒ 同事务翻牌（验证 accept 被闸不影响执行流程正常收尾）。
    const confirmB2 = await confirm(idB, dev2Tok);
    assert.strictEqual(confirmB2.status, 200, `[45b-续走] 第二人确认应 200，实得 ${confirmB2.status} ${JSON.stringify(confirmB2.body)}`);
    assert.strictEqual(confirmB2.body.flipped, true, '[45b-续走] 全员 done 应触发翻牌');
    const rowBAfterFlip = await issueRow(idB);
    assert.strictEqual(rowBAfterFlip.status, '已上线', '[45b-续走] 应已翻牌为已上线');

    // 翻牌后 accept 自然不可达断言（可选，task 明示）：此刻 status 已非「待验证」，不是 fastlane 闸门本身
    // 在拦，只为证明"续走后旧闸门语义自然让位"。
    const acceptB2 = await call('POST', `/api/sys-issues/${idB}/accept`, adminTok, {});
    assert.notStrictEqual(acceptB2.status, 200, `[45b-续走后] 已翻牌单再 accept 不应成功，实得 ${acceptB2.status} ${JSON.stringify(acceptB2.body)}`);
    ok('[45b] accept 有 done：409 FASTLANE_DEPLOY_IN_PROGRESS（授权/集合零改动，整体回滚）；其余 pending 者续走 confirm 正常完成翻牌（验收被闸不阻塞执行流程），翻牌后单已非待验证，accept 自然不可达（可选断言）');
  }

  // ══════════════════════════ [46]（S5·§4-6）return 验收打回闸成对：无 done 正常终结+清集合 / 有 done 409 ══════════════════════════
  {
    // [46a] 无 done：正常打回（待验证→处理中），同事务终结授权 + 清集合。
    const idA = await bugAtChulizhong();
    await estimateFuture(idA);
    await authorize(idA, adminTok, '46a-return无done');
    const rA = await call('POST', `/api/sys-issues/${idA}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rA.status, 200, `[46a-前置] submit 应 200，实得 ${rA.status}`);
    const returnA = await call('POST', `/api/sys-issues/${idA}/return`, adminTok, { reason: '46a-无done打回' });
    assert.strictEqual(returnA.status, 200, `[46a] return 应 200，实得 ${returnA.status} ${JSON.stringify(returnA.body)}`);
    assert.strictEqual(returnA.body.status, '处理中', `[46a] 应回处理中，实得 ${returnA.body.status}`);
    const feA = await fastExecRows(idA);
    assert.strictEqual(feA.filter(x => !x.removed_at).length, 0, '[46a] 集合应零未软删行');
    const tlA = await timelineRowsByCode(idA, 'fast_release_roster_cleared');
    assert.strictEqual(tlA.length, 1, `[46a] 应恰 1 条 fast_release_roster_cleared，实得 ${tlA.length}`);
    assert.ok(tlA[0].summary.includes('验收打回'), `[46a] summary 应含成因"验收打回"，实得="${tlA[0].summary}"`);
    ok('[46a] return 无 done：正常打回处理中 + 同事务清集合（零未软删行 + roster_cleared 成因"验收打回"）');

    // [46b] 有 done：两人集合一人已确认，return 应被 §4-6 闸拦下 409。
    const idB = await bugAtChulizhong();
    await estimateFuture(idB);
    await authorize(idB, adminTok, '46b-return有done');
    const rB = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(rB.status, 200, `[46b-前置] submit 应 200，实得 ${rB.status}`);
    const addB = await addExecutor(idB, 6, adminTok);
    assert.strictEqual(addB.status, 200, `[46b-前置] 加第二人应 200，实得 ${addB.status}`);
    const confirmB1 = await confirm(idB, dutyTok);
    assert.strictEqual(confirmB1.status, 200, `[46b-前置] 值班人确认应 200，实得 ${confirmB1.status}`);
    assert.strictEqual(confirmB1.body.flipped, false, '[46b-前置] 两人一人确认不应翻牌');

    const returnB = await call('POST', `/api/sys-issues/${idB}/return`, adminTok, { reason: '46b-有done打回' });
    assert.strictEqual(returnB.status, 409, `[46b] 有 done 行时 return 应 409，实得 ${returnB.status} ${JSON.stringify(returnB.body)}`);
    assert.strictEqual(returnB.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[46b] 确切码，实得 ${returnB.body.code}`);
    const rowBAfterDeny = await issueRow(idB);
    assert.strictEqual(rowBAfterDeny.status, '待验证', '[46b] 主状态应仍待验证（return 被闸整体回滚）');
    assert.ok(rowBAfterDeny.fast_release_auth_at, '[46b] 授权六列不应被终结（return 被闸整体回滚）');
    const feBAfterDeny = await fastExecRows(idB);
    assert.strictEqual(feBAfterDeny.filter(x => !x.removed_at).length, 2, '[46b] 集合应仍恰 2 行活跃（return 被闸未清集合）');
    ok('[46b] return 有 done：409 FASTLANE_DEPLOY_IN_PROGRESS（授权/集合零改动，整体回滚）');
  }

  // ══════════════════════════ [47]（S5·§4-6/§4-7）void 含 done 终极出口正例：done 行也被软删 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '47-void含done');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[47-前置] submit 应 200，实得 ${r.status}`);
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[47-前置] 加第二人应 200，实得 ${addR.status}`);
    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[47-前置] 值班人确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, false, '[47-前置] 两人一人确认不应翻牌');
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 2, '[47-前置] 应恰 2 行（值班人 done + 第二人 pending）');
    const dutyRowBefore = feRows.find(x => x.user_id === 20);
    assert.strictEqual(dutyRowBefore.exec_status, 'done', '[47-前置] 值班人应 done（void 唯一能清到的对象）');

    const voidR = await call('POST', `/api/sys-issues/${id}/void`, adminTok, { reason: '47-作废含done集合' });
    assert.strictEqual(voidR.status, 200, `[47] void 应 200，实得 ${voidR.status} ${JSON.stringify(voidR.body)}`);
    assert.strictEqual(voidR.body.status, '已作废', `[47] 应落已作废，实得 ${voidR.body.status}`);

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 0, '[47] ⭐ 集合应零未软删行——含 done 行也被清（方案 §5-⑨ 唯一例外）');
    const dutyRowAfter = feRows.find(x => x.user_id === 20);
    assert.ok(dutyRowAfter.removed_at, '[47] ⭐ 值班人（done）行也应已软删——void 是唯一能清到 done 行的路径');
    assert.strictEqual(dutyRowAfter.exec_status, 'done', '[47] 软删不改写 exec_status 本身，历史事实原样保留（已确认过的事实不因软删而抹去）');
    const secondRowAfter = feRows.find(x => x.user_id === 6);
    assert.ok(secondRowAfter.removed_at, '[47] 第二人（pending）行也应已软删');

    const tl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(tl.length, 1, `[47] 应恰 1 条 fast_release_roster_cleared，实得 ${tl.length}`);
    assert.ok(tl[0].summary.includes('作废'), `[47] summary 应含成因"作废"，实得="${tl[0].summary}"`);
    ok('[47]（S5·§4-6/§4-7）void 含 done 终极出口正例：void 不闸（无需先无 done），同事务终结授权+清集合含 done 行（方案 §5-⑨ 唯一例外，历史事实 exec_status 原样保留不被抹去）+ timeline roster_cleared 成因"作废"');
  }

  // ══════════════════════════ [48]（S5·§4-6）issue_reject 路径：结构性零行照常（挂牌前，roster 从未产生） ══════════════════════════
  {
    const id = await mkIssue('bug');
    const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(acc.status, 200, `[48-前置] 受理应 200，实得 ${acc.status}`);
    const midRow = await issueRow(id);
    assert.strictEqual(midRow.status, '待处理', '[48-前置] 受理后应处于待处理（未指派，issue_reject 的 from 集含此态）');
    // 授权（bug 授权窗口=待处理/处理中，含本态）——但刻意不走 submit，roster 结构上仍不可能产生
    // （挂牌只在 submit 事务内、花名册全完成时触发）。
    await authorize(id, adminTok, '48-reject零行');
    const rejectR = await call('POST', `/api/sys-issues/${id}/issue-reject`, adminTok, { reason: '48-拒绝' });
    assert.strictEqual(rejectR.status, 200, `[48] issue_reject 应 200，实得 ${rejectR.status} ${JSON.stringify(rejectR.body)}`);
    assert.strictEqual(rejectR.body.status, '已拒绝', `[48] 应落已拒绝，实得 ${rejectR.body.status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 0, '[48] 集合应恰 0 行（挂牌前结构性无行可清）');
    const tl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(tl.length, 0, `[48] 不应有 fast_release_roster_cleared 行（clearFastReleaseRosterOnTermination 的 changes=0 no-op，不写虚假留痕），实得 ${tl.length}`);
    ok('[48] issue_reject 路径：挂牌态「待验证」结构性不可达（roster 从未产生），reject 后集合仍恰 0 行、零虚假 roster_cleared 留痕（changes=0 不写 timeline 契约生效）');
  }

  // ══════════════════════════ [49]（S5·不变量 ⑪）全库扫描探针：授权非活跃单不得存在未软删集合行 ══════════════════════════
  //   ⚠️ [编码期实测修复] 首版 [49a] 扫描 IN-MEMORY 测试库累计状态断言"零违例"——红灯：命中十余条，逐条
  //   排查后发现是 [19a] 等组"SQL 造态直接污染 online_source 模拟脏数据"这类**测试自身构造的对照组
  //   遗留状态**（非真实代码路径产物），这些issue 的 roster 行"未软删但授权非活跃"是那些组刻意造出来验证
  //   其它断言的副产物，从未被本探针的调用范围覆盖过。真正代表"终态零违例"的判据应比照既有 [7c] 组
  //   范式——扫描**真实本地库 task_pool.db**（未被本文件测试造态污染），而非本文件自身高强度对照组
  //   测试后积累的脏 IN-MEMORY 库。改为该范式后，[49b]/[49c] 的反证/清理断言相应收窄为"仅判该 issue"
  //   （不再依赖全库计数为 0 这个假设，本身就更精确、不受其余组影响）。
  {
    // [S8-S10 合并收口批 F2/F3 收口] ⚠️ 本查询是 INNER JOIN（`JOIN` 默认语义）——sys_issues 已被删除的
    //   issue，其 sys_fast_release_executors 孤儿行会被本查询天然排除在 `rows` 候选之外（JOIN 匹配不到
    //   即整行消失，不会出现在 fe.id/issue_id 结果集里）。这不会造成"假红"（不会误判合规行为违例），
    //   但也**不覆盖**这类孤儿行——它们既不会被本探针判违例，也不会被本探针确认为合规，是本查询结构性
    //   的盲区（非探针实现缺陷）。若怀疑本地库存在这类孤儿（issue 已删但子表未清），需另用不带 JOIN 的
    //   LEFT JOIN + `i.id IS NULL` 判据单独扫描（本批一次性清扫用的正是这个判据，见交付报告"孤儿清扫"）。
    const scanSql = `SELECT fe.id AS exec_id, fe.issue_id AS issue_id, fe.user_id AS user_id,
                             i.fast_release_auth_at, i.fast_release_revoked_at, i.fast_release_consumed_at,
                             i.released_at, i.online_source, i.reopened_at
                        FROM sys_fast_release_executors fe
                        JOIN sys_issues i ON i.id = fe.issue_id
                       WHERE fe.removed_at IS NULL`;

    // [49a] 真实本地库（task_pool.db）终态零违例——同 [7c] 组既有范式：只读连接 + 表/列存在性判断 +
    //   环境相关跳过（无本地库/无该表均视为环境问题，非探针本身问题）。
    const realDbPath = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath)) {
      const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realTables = await realAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_fast_release_executors'`);
      if (realTables.length > 0) {
        const rows = await realAll(scanSql);
        const violations = I.fastReleaseRosterResidualAtInactiveAuthViolations(rows);
        assert.deepStrictEqual(violations, [], `[49a] 真实本地库扫描应零违例（候选 ${rows.length} 行），实得 ${JSON.stringify(violations)}`);
        ok(`[49a] ⭐⭐ 真实本地库（task_pool.db）不变量 ⑪ 探针：候选 ${rows.length} 行，违例计数=0`);
      } else {
        ok('[49a] 真实本地库缺 sys_fast_release_executors 表（S1 迁移未跑到本地库）——环境相关跳过，非探针本身问题');
      }
      realDb.close();
    } else {
      ok('[49a] 真实本地库 task_pool.db 不存在——环境相关跳过（CI/新环境无本地库属正常）');
    }

    // [49b]（★对照组·反证）SQL 造态直接绕过应用层清集合逻辑，构造"授权已撤销但集合行仍未软删"的
    //   孤儿行——探针应判红，证明断言真的在拦（[[feedback_probe_test_bidirectional_proof]]）。断言
    //   仅判该 issue 命中（非全库计数），不依赖 IN-MEMORY 库其余状态。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '49b-孤儿行造态');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[49b-前置] submit 应 200，实得 ${r.status}`);
    assert.strictEqual((await fastExecRows(id)).length, 1, '[49b-前置] 应恰 1 行（值班人 pending）');
    await run(`UPDATE sys_issues SET fast_release_revoked_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const rowsAfterInject = await all(`${scanSql} AND fe.issue_id = ?`, [id]);
    const violationsAfterInject = I.fastReleaseRosterResidualAtInactiveAuthViolations(rowsAfterInject);
    assert.strictEqual(violationsAfterInject.length, 1, `[49b] 探针应恰命中注入的孤儿行（issue ${id}），实得 ${JSON.stringify(violationsAfterInject)}`);
    ok(`[49b] ★对照组：SQL 造态绕过清集合逻辑注入孤儿行（授权已撤销但集合行未软删）→ 探针正确判红（命中 issue ${id}）`);

    // [49c] 清理注入后该 issue 恢复零违例。
    await run(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE issue_id = ? AND removed_at IS NULL`, [id]);
    const rowsAfterCleanup = await all(`${scanSql} AND fe.issue_id = ?`, [id]);
    const violationsAfterCleanup = I.fastReleaseRosterResidualAtInactiveAuthViolations(rowsAfterCleanup);
    assert.deepStrictEqual(violationsAfterCleanup, [], `[49c] 清理注入行后该 issue 应零违例，实得 ${JSON.stringify(violationsAfterCleanup)}`);
    ok('[49c] 清理注入行后探针恢复零违例（清理本身未污染其余组前提）');
  }

  // ══════════════════════════ [50]（S5·不变量 ⑫）全库扫描探针：不存在持久的"非空∧全done∧待验证∧活跃授权"态 ══════════════════════════
  //   [49] 组已实测踩过"扫 IN-MEMORY 测试库累计状态"这条路的坑（对照组遗留状态误判），本组同批直接改按
  //   [7c]/[49a] 既有范式扫真实本地库，不重复踩同一坑；★对照组/清理断言同样收窄为"仅判该 issue"。
  {
    const aggSql = `SELECT i.id, i.type, i.status,
                            i.fast_release_auth_at, i.fast_release_revoked_at, i.fast_release_consumed_at,
                            i.released_at, i.online_source, i.reopened_at,
                            COUNT(fe.id) AS active_count,
                            COALESCE(SUM(CASE WHEN fe.exec_status='done' THEN 1 ELSE 0 END), 0) AS done_count
                       FROM sys_issues i
                       LEFT JOIN sys_fast_release_executors fe ON fe.issue_id = i.id AND fe.removed_at IS NULL
                      GROUP BY i.id`;

    // [50a] 真实本地库（task_pool.db）终态零违例——同 [7c]/[49a] 既有范式。
    const realDbPath50 = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath50)) {
      const realDb50 = new sqlite3.Database(realDbPath50, sqlite3.OPEN_READONLY);
      const realAll50 = (sql) => new Promise((resolve, reject) => realDb50.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realTables50 = await realAll50(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_fast_release_executors'`);
      if (realTables50.length > 0) {
        const rows = await realAll50(aggSql);
        const violations = I.fastReleaseNonFlippedFullDoneViolations(rows);
        assert.deepStrictEqual(violations, [], `[50a] 真实本地库扫描应零违例（候选 ${rows.length} 单），实得 ${JSON.stringify(violations)}`);
        ok(`[50a] ⭐⭐ 真实本地库（task_pool.db）不变量 ⑫ 探针：候选 ${rows.length} 单，违例计数=0`);
      } else {
        ok('[50a] 真实本地库缺 sys_fast_release_executors 表——环境相关跳过，非探针本身问题');
      }
      realDb50.close();
    } else {
      ok('[50a] 真实本地库 task_pool.db 不存在——环境相关跳过（CI/新环境无本地库属正常）');
    }

    // [50b]（★对照组·反证）SQL 造态绕过共享内核直接把唯一执行人标 done（不经 confirm 端点，模拟"内核
    //   被绕过"场景）——探针应判红。断言仅判该 issue 命中（非全库计数）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '50b-绕过内核造态');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[50b-前置] submit 应 200，实得 ${r.status}`);
    assert.strictEqual((await fastExecRows(id)).length, 1, '[50b-前置] 应恰 1 行（值班人 pending）');
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id = ?`, [id]);
    const rowsAfterInject = await all(`${aggSql.replace('GROUP BY i.id', 'WHERE i.id = ? GROUP BY i.id')}`, [id]);
    const violationsAfterInject = I.fastReleaseNonFlippedFullDoneViolations(rowsAfterInject);
    assert.strictEqual(violationsAfterInject.length, 1, `[50b] 探针应恰命中注入的违例（issue ${id}：全 done 但仍待验证），实得 ${JSON.stringify(violationsAfterInject)}`);
    ok(`[50b] ★对照组：SQL 造态绕过共享翻牌内核直接标 done（不经 confirm 端点）→ 探针正确判红（命中 issue ${id}）`);

    // [50c] 清理：走真实内核补翻牌（而非直接 UPDATE 抹掉造态），验证"清理即翻牌"后恢复零违例——顺带
    //   证明内核对这条被污染的行仍能正确判定并翻牌（造态只污染了 exec_status，未污染六列活跃授权，
    //   内核重新聚合后应能翻）。
    await run('BEGIN IMMEDIATE');
    const flipResult = await I.attemptFastReleaseFlipInTxn(id, { id: 1, name: '管理员' }, 'confirm');
    await run('COMMIT');
    assert.strictEqual(flipResult.flipped, true, '[50c] 内核补翻牌应成功（造态未破坏翻牌 WHERE 的前置条件）');
    const rowsAfterCleanup = await all(`${aggSql.replace('GROUP BY i.id', 'WHERE i.id = ? GROUP BY i.id')}`, [id]);
    const violationsAfterCleanup = I.fastReleaseNonFlippedFullDoneViolations(rowsAfterCleanup);
    assert.deepStrictEqual(violationsAfterCleanup, [], `[50c] 补翻牌后该 issue 应零违例，实得 ${JSON.stringify(violationsAfterCleanup)}`);
    ok('[50c] 清理（内核补翻牌）后探针恢复零违例——违例态本身是可通过"让内核正确执行"消解的瞬时态，非结构性死锁');
  }

  // ══════════════════════════ [51]（Opus S5 预筛 H1 变体A）重新授权清集合·同人值班跨轮 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '51-变体A同人值班跨轮');
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r1.status, 200, `[51-前置] gen1 submit 应 200，实得 ${r1.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[51-前置] 应恰 1 行（值班人 user20 pending）');

    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[51-前置] gen1 确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, true, '[51-前置] 唯一执行人确认应末位翻牌（consumed_at 写入）');

    const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(praR.status, 200, `[51-前置] 补验收 pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);
    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[51-前置] close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '51-重开重走' });
    assert.strictEqual(reopenR.status, 200, `[51-前置] reopen 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);
    assert.strictEqual(reopenR.body.status, '处理中', `[51-前置] reopen 后应处理中，实得 ${reopenR.body.status}`);

    // 首轮消费态 done 行此刻仍未软删（H1 修复前的残留态——五事件终结判据/S2 挂牌清场均管不到它）。
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 1, '[51-前置] H1 修复前该行应仍未软删（重现预筛描述的残留态）');
    assert.strictEqual(feRows[0].exec_status, 'done', '[51-前置] 首轮行应仍 done（消费态部署留痕）');

    // ⭐ 重新授权——同人值班（全文件默认"今日值班"=user20，本组未切换）。H1 修复前：授权成功但不清
    //   集合，随后重新 submit 挂牌 INSERT 同一 (issue_id,user_id=20) 会撞 partial UNIQUE 500。
    const reAuthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '51-重新授权同人' });
    assert.strictEqual(reAuthR.status, 200, `[51] 重新授权应 200，实得 ${reAuthR.status} ${JSON.stringify(reAuthR.body)}`);
    assert.strictEqual(reAuthR.body.reauthorized, true, '[51] 应识别为重新授权');

    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 0, '[51] 重新授权后应零未软删行（H1 同事务软删首轮 done 行）');
    const oldRow = feRows.find(x => x.user_id === 20);
    assert.ok(oldRow.removed_at, '[51] ⭐ 留痕断言：首轮 done 行应已软删（removed_at 非空）');
    assert.strictEqual(oldRow.exec_status, 'done', '[51] ⭐ 留痕断言：软删不改写 exec_status，历史事实（done）原样可查');

    const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(clearedTl.length, 1, `[51] 应恰 1 条 fast_release_roster_cleared，实得 ${clearedTl.length}`);
    assert.ok(clearedTl[0].summary.includes('重新授权'), `[51] summary 应含成因"重新授权"，实得="${clearedTl[0].summary}"`);
    const onlineTl = await timelineRowsByCode(id, 'fast_release_exec_online');
    assert.strictEqual(onlineTl.length, 1, '[51] exec_online 镜像行应仍可查（部署留痕不因软删丢失，历史 timeline 不受影响）');

    await estimateFuture(id);   // reopen 已清 dev_estimated_at，重新提交前须重新回填
    const reSubmitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(reSubmitR.status, 200, `[51] ⭐ 重新 submit 应 200（H1 修复前会因同一 user_id 撞 partial UNIQUE 500），实得 ${reSubmitR.status} ${JSON.stringify(reSubmitR.body)}`);
    assert.strictEqual(reSubmitR.body.main_status, '待验证', `[51] 应重新进入待验证，实得 ${reSubmitR.body.main_status}`);

    feRows = await fastExecRows(id);
    const newGenRows = feRows.filter(x => !x.removed_at);
    assert.strictEqual(newGenRows.length, 1, `[51] 新一代应恰 1 行（同人值班 user20），实得 ${newGenRows.length}`);
    assert.strictEqual(newGenRows[0].user_id, 20, '[51] 新一代活跃行应为值班人（同一人）');
    assert.strictEqual(newGenRows[0].exec_status, 'pending', '[51] 新一代行应 pending（未确认）');
    assert.strictEqual(feRows.length, 2, `[51] 全表应恰 2 行（首轮软删 1 + 新一代 1），实得 ${feRows.length}`);
    ok('[51]（Opus S5 预筛 H1）变体A·同人值班跨轮：消费→pass→close→reopen→重新授权（同事务软删首轮 done 行+roster_cleared 成因"重新授权"，留痕断言：removed_at 非空但 exec_status/exec_online 镜像行仍可查）→重新 submit 不再撞 UNIQUE 500，新一代恰 1 行 pending（同人值班）');
  }

  // ══════════════════════════ [52]（Opus S5 预筛 H1 变体B）重新授权清集合·换值班人跨轮（3 子组） ══════════════════════════
  {
    async function buildCrossGenDifferentDutyFixture(tag) {
      // 自成一体、幂等——每次调用都先把"今日值班"钉回 user20 再开始 gen1（不依赖调用方之间的先后
      // 顺序或是否已复位；同一 [52] 组内 52a→52b→52c 连续三次调用，若不在这里显式复位，第二次起
      // gen1 会因"今日值班"仍是上一次调用切换后的 user13 而找错人，dutyTok（user20）确认会 403——
      // 首版实现在此踩过红：52a 通过、52b 的 gen1 confirm 403，见交付报告红灯记录）。
      await switchDutyTo(20, '值班员甲');
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, `${tag}-gen1`);
      const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r1.status, 200, `[${tag}-前置] gen1 submit 应 200，实得 ${r1.status}`);
      const confirmR = await confirm(id, dutyTok);
      assert.strictEqual(confirmR.status, 200, `[${tag}-前置] gen1 确认应 200，实得 ${confirmR.status}`);
      assert.strictEqual(confirmR.body.flipped, true, `[${tag}-前置] gen1 应末位翻牌`);
      const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
      assert.strictEqual(praR.status, 200, `[${tag}-前置] 补验收 pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);
      const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
      assert.strictEqual(closeR.status, 200, `[${tag}-前置] close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
      const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: `${tag}-reopen重走` });
      assert.strictEqual(reopenR.status, 200, `[${tag}-前置] reopen 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);

      // 换值班人（gen2 用不同人 user13，非 gen1 的 user20）——测的正是"跨代污染"这条线：gen1 残留 done
      // 行若不清，会让 gen2（一个本身干净、从未产生 done 行的全新代次）被 accept/return/revoke 三闸
      // 误伤 409（H1 修复前预筛实测三者皆是）。
      await switchDutyTo(13, '示例对接人');
      const reAuthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: `${tag}-重新授权换人` });
      assert.strictEqual(reAuthR.status, 200, `[${tag}-前置] 重新授权应 200，实得 ${reAuthR.status} ${JSON.stringify(reAuthR.body)}`);
      const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
      assert.strictEqual(clearedTl.length, 1, `[${tag}-前置] 应恰 1 条 roster_cleared（换人变体同样触发 H1 清集合），实得 ${clearedTl.length}`);

      await estimateFuture(id);
      const reSubmitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(reSubmitR.status, 200, `[${tag}-前置] gen2 submit 应 200，实得 ${reSubmitR.status} ${JSON.stringify(reSubmitR.body)}`);
      const feRows = await fastExecRows(id);
      const gen2Active = feRows.filter(x => !x.removed_at);
      assert.strictEqual(gen2Active.length, 1, `[${tag}-前置] gen2 应恰 1 行活跃`);
      assert.strictEqual(gen2Active[0].user_id, 13, `[${tag}-前置] gen2 活跃行应为新值班人 user13`);
      return id;
    }

    const idAccept = await buildCrossGenDifferentDutyFixture('52a');
    const acceptR = await call('POST', `/api/sys-issues/${idAccept}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[52a] ⭐ accept 应 200（H1 修复前会被 gen1 残留 done 行误伤 409），实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    ok('[52a]（H1 变体B①）换值班人跨轮：gen2 accept 不再被 gen1 残留 done 行误闸 409（H1 清集合切断跨代污染）');

    const idReturn = await buildCrossGenDifferentDutyFixture('52b');
    const returnR = await call('POST', `/api/sys-issues/${idReturn}/return`, adminTok, { reason: '52b-验收打回' });
    assert.strictEqual(returnR.status, 200, `[52b] ⭐ return 应 200，实得 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    ok('[52b]（H1 变体B②）换值班人跨轮：gen2 return 不再被 gen1 残留 done 行误闸 409');

    const idRevoke = await buildCrossGenDifferentDutyFixture('52c');
    const revokeR = await call('POST', `/api/sys-issues/${idRevoke}/fast-release-revoke`, adminTok, { reason: '52c-撤销' });
    assert.strictEqual(revokeR.status, 200, `[52c] ⭐ revoke 应 200，实得 ${revokeR.status} ${JSON.stringify(revokeR.body)}`);
    ok('[52c]（H1 变体B③）换值班人跨轮：gen2 revoke 不再被 gen1 残留 done 行误闸 409');

    // 复位：把"今日值班"改回 user20（组末复位，交接摘要五坑之④——[3] 组起大量后续用例假设默认值班人=user20）。
    await switchDutyTo(20, '值班员甲');
  }

  // ══════════════════════════ [53]（Opus S5 预筛 H1 变体C）重新授权清集合·无值班跨轮 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '53-变体C无值班跨轮');
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r1.status, 200, `[53-前置] gen1 submit 应 200，实得 ${r1.status}`);
    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[53-前置] gen1 确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, true, '[53-前置] gen1 应末位翻牌（consumed）');
    const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(praR.status, 200, `[53-前置] 补验收 pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);
    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[53-前置] close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '53-reopen重走' });
    assert.strictEqual(reopenR.status, 200, `[53-前置] reopen 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);

    // 无值班——今日值班行整条软删，不插新的（模拟"排班空缺"场景，即预筛描述的"无值班时唯一出口=void"
    // 组合前提）。
    await run(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员'
               WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    const dutyCheck = await get(`SELECT COUNT(*) c FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    assert.strictEqual(dutyCheck.c, 0, '[53-前置] 当日应确无值班（造态生效）');

    const reAuthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '53-重新授权无值班' });
    assert.strictEqual(reAuthR.status, 200, `[53] 重新授权应 200，实得 ${reAuthR.status} ${JSON.stringify(reAuthR.body)}`);
    // ⭐ 无值班也应清集合——H1 修复是"重授权即软删上一代全部行"，与是否有新值班人无关（不能只在"有
    //   新人接手"时才清，那会漏掉更危险的分支：没有新人接手时，旧 done 行若不清，会成为 admin 完全
    //   无法处理的永久孤儿——不能加人（集合非空判 FROZEN）、不能移人（done 行移不掉）、不能
    //   accept/return/revoke（均命中 done 闸），唯一出口只剩 void，这正是预筛实测的死锁本身）。
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 0, '[53] 重新授权后应零未软删行（无值班也应清）');
    const oldRow = feRows.find(x => x.user_id === 20);
    assert.ok(oldRow.removed_at, '[53] ⭐ 留痕断言：首轮 done 行应已软删');
    const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(clearedTl.length, 1, `[53] 应恰 1 条 roster_cleared，实得 ${clearedTl.length}`);
    assert.ok(clearedTl[0].summary.includes('重新授权'), `[53] summary 应含成因"重新授权"，实得="${clearedTl[0].summary}"`);

    await estimateFuture(id);
    const reSubmitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(reSubmitR.status, 200, `[53] gen2 submit 应 200，实得 ${reSubmitR.status} ${JSON.stringify(reSubmitR.body)}`);
    assert.strictEqual(reSubmitR.body.main_status, '待验证', `[53] 应进入待验证，实得 ${reSubmitR.body.main_status}`);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 0, '[53] ⭐ gen2 应 0/0（当日无值班照挂，非因残留而假装非空）');
    // ⚠️ 恰 2 条（非 1 条）——gen1 首次 submit 自己也写过一条 fast_release_staged（值班员甲，见前置
    // 断言），gen2 重新 submit 又写一条（当日无值班）：本单经历了两代挂牌事件，各自都留痕，非"挂牌
    // 事件全局只发生一次"（首版实现在此踩过红，见交付报告红灯记录）。
    const stagedTl = await timelineRowsByCode(id, 'fast_release_staged');
    assert.strictEqual(stagedTl.length, 2, `[53] 应恰 2 条 fast_release_staged（gen1+gen2 各一次挂牌事件），实得 ${stagedTl.length}`);
    assert.ok(stagedTl[0].summary.includes('值班员甲'), `[53] 第 1 条（gen1）summary 应含值班人姓名"值班员甲"，实得="${stagedTl[0].summary}"`);
    assert.ok(stagedTl[1].summary.includes('当日无值班'), `[53] 第 2 条（gen2）summary 应含"当日无值班"，实得="${stagedTl[1].summary}"`);

    // ⭐ 加人解冻：0/0 态下 admin 加人应正常放行（无残留 done 行误伤 FROZEN 闸）。
    const addR = await addExecutor(id, 6, adminTok);
    assert.strictEqual(addR.status, 200, `[53] ⭐ 加人应 200（H1 修复前会被 gen1 残留 done 行误伤 FASTLANE_ROSTER_FROZEN），实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    feRows = await fastExecRows(id);
    assert.strictEqual(feRows.filter(x => !x.removed_at).length, 1, '[53] 加人后应恰 1 行活跃');

    // 恢复值班（组末复位，五坑清单④）。
    await setDutyToday(20, '值班员甲');
    ok('[53]（H1 变体C）无值班跨轮：重新授权后集合被清（无新值班人接手也清——留痕断言：首轮 done 行 removed_at 非空）+0/0 照挂+加人解冻（不再被残留 done 行误伤 FASTLANE_ROSTER_FROZEN），预筛描述的"无值班唯一出口=void"死锁已解');
  }

  // ══════════════════════════ [54]（Opus S5 预筛 L1）C9 直翻+非空集合 cause='上线翻牌' 正例 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '54-C9直翻非空集合');
    const noCodeR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'no_code' }));
    assert.strictEqual(noCodeR.status, 200, `[54-前置] no_code submit 应 200，实得 ${noCodeR.status} ${JSON.stringify(noCodeR.body)}`);
    assert.strictEqual(noCodeR.body.main_status, '待验证', `[54-前置] 应进入待验证，实得 ${noCodeR.body.main_status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, `[54-前置] 挂牌应恰 1 行（值班人 pending），实得 ${feRows.length}`);

    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[54] accept 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '已上线', `[54] 零 commit 应 C9 直翻已上线，实得 ${acceptR.body.status}`);

    const feAfter = await fastExecRows(id);
    assert.strictEqual(feAfter.filter(x => !x.removed_at).length, 0, '[54] C9 直翻后集合应零未软删行（非空集合被清）');
    const clearedTl = await timelineRowsByCode(id, 'fast_release_roster_cleared');
    assert.strictEqual(clearedTl.length, 1, `[54] 应恰 1 条 fast_release_roster_cleared，实得 ${clearedTl.length}`);
    assert.ok(clearedTl[0].summary.includes('上线翻牌'), `[54] ⭐ summary 应含成因"上线翻牌"（C9 直翻分支，非"验收通过"），实得="${clearedTl[0].summary}"`);
    ok("[54]（Opus S5 预筛 L1）C9 直翻+非空集合正例：授权→mode='no_code' submit 挂牌（1 行 pending）→accept 零 commit 直翻已上线⇒同事务清集合，roster_cleared 成因精确为'上线翻牌'（非'验收通过'分支）");
  }

  // ══════════════════════════ [55]（codex 389 号二批 M1）revoke 闸序修正：已消费保留 done 行后调 revoke ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '55-revoke闸序');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[55-前置] submit 应 200，实得 ${r.status}`);
    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[55-前置] 确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, true, '[55-前置] 唯一执行人确认应末位翻牌（consumed_at 写入）');
    const midRow = await issueRow(id);
    assert.ok(midRow.fast_release_consumed_at, '[55-前置] fast_release_consumed_at 应已写（消费态）');
    const feBefore = await fastExecRows(id);
    assert.strictEqual(feBefore.filter(x => !x.removed_at).length, 1, '[55-前置] 应恰 1 行未软删 done（消费态部署留痕，§5b 第 7 行保留）');

    // ⭐ 已消费单调 revoke——修法前：done 闸抢在活跃判定之前跑，会误报 409 FASTLANE_DEPLOY_IN_PROGRESS
    //   （且文案"可让剩余执行人完成确认…"与实际状态相反——根本没有"进行中"的部署，也没有剩余执行人）。
    //   修法后：应走既有撤销冲突响应（因授权已非活跃，done 闸整体跳过，UPDATE 的 consumed_at IS NULL
    //   条件天然不满足，changes=0 → deriveFastReleaseRevokeDenyReason 精确判"已被消费"）。
    const revokeR = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '55-已消费后撤销' });
    assert.strictEqual(revokeR.status, 409, `[55] revoke 应 409，实得 ${revokeR.status} ${JSON.stringify(revokeR.body)}`);
    assert.strictEqual(revokeR.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[55] ⭐ 确切码应为既有撤销冲突码（非 FASTLANE_DEPLOY_IN_PROGRESS），实得 ${revokeR.body.code}`);
    assert.ok(revokeR.body.error.includes('已被消费'), `[55] ⭐ 错误文案应精确指向"已被消费"（非"暂不可撤销…等待翻牌"这类文不对题指引），实得="${revokeR.body.error}"`);

    // 零副作用：授权六列/集合行均不应被本次失败的 revoke 触碰。
    const afterRow = await issueRow(id);
    assert.strictEqual(afterRow.fast_release_revoked_at, null, '[55] revoked_at 应仍为空（revoke 未生效）');
    assert.ok(afterRow.fast_release_consumed_at, '[55] consumed_at 应原样保留');
    const feAfter = await fastExecRows(id);
    assert.deepStrictEqual(feAfter, feBefore, '[55] 集合行应零改动（未被误清）');
    ok('[55]（codex 389 号二批 M1）revoke 闸序修正：已消费单（末位确认翻牌·done 行按 §5b 第 7 行保留）调 revoke 应走既有撤销冲突响应（409 FAST_RELEASE_REVOKE_NOT_ALLOWED+"已被消费"精确文案），非误报 FASTLANE_DEPLOY_IN_PROGRESS；授权六列/集合行零副作用');
  }

  // ══════════════════════════ [56]（codex 389 号二批 L1）重新授权原子性故障注入（仿 [22] 触发器范式） ══════════════════════════
  //   ⚠️ 前置链路须能让"授权重回可发起态（待处理/处理中）"同时"上一代集合行仍未软删"——submit 后
  //   status 已是「待验证」，authorize 端点 WHERE 只认待处理/处理中，直接再调 authorize 会先被那道闸
  //   拦 409（首版实现踩过此红，见交付报告红灯记录）。须走完整"消费→close→reopen"链路：consumed_at
  //   写入不清 auth_at/不清集合（§5b 第 7 行"保留"），reopen 把 status 送回处理中但同样不碰
  //   fast_release_*/集合行——此刻才是"能重新授权 ∧ 集合仍挂着上一代 done 行"这个精确前提，与 [51]
  //   变体A 同一条链路（这里只是把终点从"真实清集合"换成"触发器拦截清集合"）。
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '56-原子性故障注入gen1');
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r1.status, 200, `[56-前置] gen1 submit 应 200，实得 ${r1.status}`);
    const confirmR = await confirm(id, dutyTok);
    assert.strictEqual(confirmR.status, 200, `[56-前置] gen1 确认应 200，实得 ${confirmR.status}`);
    assert.strictEqual(confirmR.body.flipped, true, '[56-前置] gen1 应末位翻牌（consumed_at 写入）');
    const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(praR.status, 200, `[56-前置] 补验收 pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);
    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[56-前置] close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '56-重开供故障注入' });
    assert.strictEqual(reopenR.status, 200, `[56-前置] reopen 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);
    assert.strictEqual(reopenR.body.status, '处理中', `[56-前置] reopen 后应处理中，实得 ${reopenR.body.status}`);

    const feBefore = await fastExecRows(id);
    assert.strictEqual(feBefore.filter(x => !x.removed_at).length, 1, '[56-前置] 首轮 done 行应仍未软删（消费态部署留痕，待重新授权来清）');
    const rowBefore = await issueRow(id);
    // [codex 390 号三批 L1 补全] 六列快照——此前只断言了 fast_release_auth_at 一列，"授权六列应零改动"
    // 的闭合声明与实际断言范围不符，补齐以 FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL 为准的完整六列。
    const sixColsBefore = await fastAuthSixCols(id);
    const authTlBefore = (await timelineRowsByCode(id, 'fast_release_authorize')).length;
    const clearedTlBefore = (await timelineRowsByCode(id, 'fast_release_roster_cleared')).length;

    // 临时触发器——只拦截"本 issue 的集合行从未软删转为已软删"这一精确迁移，不影响其余任何写入（同
    //   [22] 范式：BEFORE UPDATE + WHEN 精确限定；RAISE(ABORT) 会真正抛错传导到调用方，非 IGNORE 那种
    //   "静默跳过、changes=0"——本组要的正是"抛错→整体回滚"：clearFastReleaseRosterOnTermination 自身
    //   不对"清了几行"做 changes 断言（只用 changes>0 判断要不要写 timeline），若用 IGNORE，函数只会把
    //   changes=0 当"没什么好清的"悄悄放过，端点会正常 200 提交、测不出原子性——已实测核实（见下方
    //   RAISE 形态选型）。
    await run(`CREATE TRIGGER _t56_block_clear
               BEFORE UPDATE ON sys_fast_release_executors
               WHEN NEW.issue_id = ${id} AND OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
               BEGIN SELECT RAISE(ABORT, 'L1 故障注入：阻断清集合 UPDATE'); END`);
    try {
      const reAuthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '56-触发器拦截' });
      assert.strictEqual(reAuthR.status, 500, `[56] 触发器拦截后重新授权应 500，实得 ${reAuthR.status} ${JSON.stringify(reAuthR.body)}`);

      // 四面全回滚——授权六列未写入、fast_release_authorize timeline 零新增、执行人行 removed_at
      // 未变、cleared timeline 零新增（修法 A 的"授权 UPDATE + 清集合"必须是同一个原子单元，不允许
      // "授权改了、清集合失败但已提交"的半完成态）。
      const rowAfter = await issueRow(id);
      assert.strictEqual(rowAfter.fast_release_auth_at, rowBefore.fast_release_auth_at, '[56] ⭐ fast_release_auth_at 应零改动（未被重授权覆盖，整体回滚）');
      // [codex 390 号三批 L1 补全] 六列逐列比对（此前只断言了其中一列）——与 FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL
      // /isActiveFastReleaseAuth 判据的六列一一对应，deepStrictEqual 一次性钉死整组零改动。
      const sixColsAfter = await fastAuthSixCols(id);
      assert.deepStrictEqual(sixColsAfter, sixColsBefore, '[56] ⭐⭐ 授权六列（fast_release_auth_at/revoked_at/consumed_at/released_at/online_source/reopened_at）应逐列零改动，整体回滚');
      assert.strictEqual((await timelineRowsByCode(id, 'fast_release_authorize')).length, authTlBefore, '[56] ⭐ fast_release_authorize timeline 应零新增');
      const feAfter = await fastExecRows(id);
      assert.strictEqual(feAfter.length, 1, '[56] 执行人行应仍恰 1 行');
      assert.strictEqual(feAfter[0].removed_at, null, '[56] ⭐ 执行人行 removed_at 应未变（仍未软删，触发器拦截生效）');
      assert.strictEqual((await timelineRowsByCode(id, 'fast_release_roster_cleared')).length, clearedTlBefore, '[56] ⭐ fast_release_roster_cleared timeline 应零新增');
    } finally {
      await run(`DROP TRIGGER _t56_block_clear`);
    }

    // 移除触发器后重新授权应恢复正常——功能恢复对照（红灯是触发器造成的，非端点本身被搞坏）。
    const reAuthR2 = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '56-恢复对照' });
    assert.strictEqual(reAuthR2.status, 200, `[56-对照] 移除触发器后重新授权应恢复 200，实得 ${reAuthR2.status} ${JSON.stringify(reAuthR2.body)}`);
    const feAfterRecover = await fastExecRows(id);
    assert.strictEqual(feAfterRecover.filter(x => !x.removed_at).length, 0, '[56-对照] 恢复后清集合应正常生效（零未软删行）');
    ok('[56]（codex 389 号二批 L1）重新授权原子性故障注入：触发器阻断清集合 UPDATE→整体 500 回滚（授权六列/fast_release_authorize timeline/执行人行 removed_at/roster_cleared timeline 四面全零改动）；移除触发器后重新授权恢复正常（功能恢复对照，红灯确系触发器所致）');
  }

  // ══════════════════════════ [57a]（S6·§4-8）详情 DTO 正例·挂牌进行中混合态 + 列表 x/N="1/2" ══════════════════════════
  let id57;
  {
    id57 = await bugAtChulizhongTwoDevs();
    await estimateFuture(id57);
    await authorize(id57, adminTok, '57a-详情正例');
    let r = await call('POST', `/api/sys-issues/${id57}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[57a-前置a] dev5 提交应 200，实得 ${r.status}`);
    r = await call('POST', `/api/sys-issues/${id57}/submit`, dev2Tok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[57a-前置b] dev6（末位提交花名册）应 200，实得 ${r.status}`);
    assert.strictEqual(r.body.main_status, '待验证', '[57a-前置] 花名册全完成后应待验证');
    let feRows = await fastExecRows(id57);
    assert.strictEqual(feRows.length, 1, `[57a-前置] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows.length}`);

    // 补第二名执行人——走真实 S4 加人端点（非 SQL 造态，本组测的是 S6 读侧，写侧走真实链路更贴近
    // 生产）。目标用户取示例对接人（user13，"既有受理人夹具对象·[26]-[42] 各组已用作加人目标"，见本文件
    // 交接摘要，复用已验证过合资格的账号，规避另挑一个未知资格状态账号的风险）。
    const addR = await addExecutor(id57, 13, adminTok);
    assert.strictEqual(addR.status, 200, `[57a-前置] 加执行人应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);

    const rc = await confirm(id57, dutyTok);
    assert.strictEqual(rc.status, 200, `[57a-前置] 值班人确认应 200，实得 ${rc.status}`);
    assert.strictEqual(rc.body.flipped, false, '[57a-前置] 集合尚有 1 人 pending（示例对接人未确认），不应翻牌');

    const detail = await call('GET', `/api/sys-issues/${id57}`, adminTok);
    assert.strictEqual(detail.status, 200, `[57a] 详情应 200，实得 ${detail.status}`);
    const execs = detail.body.fast_release_executors;
    assert.ok(Array.isArray(execs), '[57a] fast_release_executors 应为数组');
    assert.strictEqual(execs.length, 2, `[57a] 应恰 2 行（值班人+加人），实得 ${execs.length}`);
    // [Opus 预筛 S6-MED-3 收口] 执行人行 DTO keys 精确断言——若详情端点 SELECT 被改成 `SELECT *`
    // （连带带出 issue_id/added_by/added_by_name/removed_at 等内部审计列）或漏投影某一列，本条会先于
    // 下方逐字段值断言判红（逐字段断言只查"读到的值对不对"，查不出"多读/少读了整列"这类形状变化）。
    assert.deepStrictEqual(Object.keys(execs[0]).sort(), ['exec_status', 'executed_at', 'id', 'user_id', 'user_name'].sort(),
      `[57a] 执行人行 DTO 应恰含五键（id/user_id/user_name/exec_status/executed_at），实得 ${JSON.stringify(Object.keys(execs[0]))}`);
    assert.ok(execs[0].id < execs[1].id, '[57a] 应按行 id 升序排列');
    assert.strictEqual(execs[0].user_id, 20, '[57a] 第一行应为值班人（user20，先挂牌）');
    assert.strictEqual(execs[0].exec_status, 'done', '[57a] 值班人已确认应为 done');
    assert.ok(execs[0].executed_at, '[57a] 值班人 executed_at 应非空');
    assert.strictEqual(execs[1].user_id, 13, '[57a] 第二行应为后加入的示例对接人（user13）');
    assert.strictEqual(execs[1].exec_status, 'pending', '[57a] 示例对接人未确认应为 pending');
    assert.strictEqual(execs[1].executed_at, null, '[57a] 示例对接人 executed_at 应为空');
    assert.deepStrictEqual(detail.body.fast_release_exec_progress, { done_count: 1, total_count: 2 },
      `[57a] 进度计数应为 {done_count:1,total_count:2}，实得 ${JSON.stringify(detail.body.fast_release_exec_progress)}`);

    // 同一状态下列表投影 x/N="1/2"——与详情读点写读同源交叉验证（[[feedback_write_read_same_semantic]]）。
    const list57a = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list57a.status, 200, `[57a-list] 列表应 200，实得 ${list57a.status}`);
    const lr57a = (list57a.body.items || []).find(x => x.id === id57);
    assert.ok(lr57a, `[57a-list] 列表应含该单据 id=${id57}`);
    assert.strictEqual(Number(lr57a.fast_release_active_auth), 1, `[57a-list] 授权应仍活跃，fast_release_active_auth 应为 1，实得 ${lr57a.fast_release_active_auth}`);
    assert.strictEqual(lr57a.status, '待验证', '[57a-list] status 应为「待验证」（徽章条件 type=bug∧status=待验证∧active_auth 三者此刻均真）');
    assert.strictEqual(lr57a.fast_release_exec_total_count, 2, `[57a-list] 列表 x/N total 应为 2，实得 ${lr57a.fast_release_exec_total_count}`);
    assert.strictEqual(lr57a.fast_release_exec_done_count, 1, `[57a-list] 列表 x/N done 应为 1，实得 ${lr57a.fast_release_exec_done_count}`);
    ok('[57a] 详情 DTO 正例·挂牌进行中混合态：fast_release_executors 数组齐字段全按 id 升序（值班人 done+示例对接人 pending）+ fast_release_exec_progress={done_count:1,total_count:2}；列表投影同状态下 x/N="1/2"（total=2,done=1）+ fast_release_active_auth=1');
  }

  // ══════════════════════════ [57b+57f]（S6·§4-10）代次干扰：软删旧代次行不计入详情数组/计数与列表 x/N ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '57b-代次干扰');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r.status, 200, `[57b-前置] submit 应 200，实得 ${r.status}`);
    let feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[57b-前置] 挂牌应恰 1 行（值班人）');
    const genOneId = feRows[0].id;

    // 模拟旧代次：软删首轮挂牌行（读侧过滤专项测试，不重复走 S5 真实终结/重授权链路——那部分已由
    // [43]-[56] 等 S5 组覆盖）。
    await run(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE id = ?`, [genOneId]);
    // 插入新一代同一人的行（模拟"打回重挂牌"产生的新实例）——同 user_id 但新 id，partial UNIQUE 不会
    // 撞（旧行已软删，代次语义见 index.js :3836 一带注释）。
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 20, '值班员甲', 1, '管理员')`, [id]);
    const feAfter = await fastExecRows(id);
    assert.strictEqual(feAfter.length, 2, '[57b-前置] 物理表应恰 2 行（1 软删旧代 + 1 新代），造态生效');

    const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail.status, 200, `[57b] 详情应 200，实得 ${detail.status}`);
    assert.strictEqual(detail.body.fast_release_executors.length, 1,
      `[57b] 详情应只见当前代次 1 行（软删旧代不计入），实得 ${detail.body.fast_release_executors.length}`);
    assert.strictEqual(detail.body.fast_release_executors[0].user_id, 20, '[57b] 应为新代次行（同人不同实例）');
    assert.deepStrictEqual(detail.body.fast_release_exec_progress, { done_count: 0, total_count: 1 },
      `[57b] 进度计数不应把软删旧代次计入分母，实得 ${JSON.stringify(detail.body.fast_release_exec_progress)}`);

    const list = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list.status, 200, `[57f] 列表应 200，实得 ${list.status}`);
    const lr = (list.body.items || []).find(x => x.id === id);
    assert.ok(lr, `[57f] 列表应含该单据 id=${id}`);
    assert.strictEqual(lr.fast_release_exec_total_count, 1,
      `[57f] 列表 x/N 分母不应把软删旧代次计入（同 57b 详情读点写读同源），实得 ${lr.fast_release_exec_total_count}`);
    assert.strictEqual(lr.fast_release_exec_done_count, 0, `[57f] 列表 done 计数应为 0，实得 ${lr.fast_release_exec_done_count}`);
    ok('[57b+57f] 代次干扰：软删旧代次行不计入详情数组/计数（{done_count:0,total_count:1}）与列表 x/N 投影（total_count=1,done_count=0）——详情/列表两处消费点写读同源，均正确过滤软删行');
  }

  // ══════════════════════════ [57c]（S6·§4-8）非挂牌单行为：从未授权的处理中 bug 单 + feature 单 ══════════════════════════
  {
    const idBugNoAuth = await bugAtChulizhong();   // 处理中，从未 authorize
    const detailBug = await call('GET', `/api/sys-issues/${idBugNoAuth}`, adminTok);
    assert.strictEqual(detailBug.status, 200, `[57c-bug] 详情应 200，实得 ${detailBug.status}`);
    assert.deepStrictEqual(detailBug.body.fast_release_executors, [], '[57c-bug] 从未挂牌的 bug 单应 fast_release_executors=[]');
    assert.deepStrictEqual(detailBug.body.fast_release_exec_progress, { done_count: 0, total_count: 0 }, '[57c-bug] 进度计数应为 {done_count:0,total_count:0}');

    const idFeature = await mkIssue('feature');
    const detailFeature = await call('GET', `/api/sys-issues/${idFeature}`, adminTok);
    assert.strictEqual(detailFeature.status, 200, `[57c-feature] 详情应 200，实得 ${detailFeature.status}`);
    assert.deepStrictEqual(detailFeature.body.fast_release_executors, [], '[57c-feature] 非 bug 类型单应 fast_release_executors=[]（type!=="bug" 门控跳过查询）');
    assert.deepStrictEqual(detailFeature.body.fast_release_exec_progress, { done_count: 0, total_count: 0 }, '[57c-feature] 进度计数应为 {done_count:0,total_count:0}');

    // 非 fastlane 单列表字段行为——两单列表投影三列均应恰为"零/假"（非 undefined/null，SQL 只出数不
    // 做状态门控，任何 type/status 组合都应拿到确定的数值）。
    const list = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list.status, 200, `[57c-list] 列表应 200，实得 ${list.status}`);
    for (const [label, xid] of [['bug', idBugNoAuth], ['feature', idFeature]]) {
      const lr = (list.body.items || []).find(x => x.id === xid);
      assert.ok(lr, `[57c-list] 列表应含 ${label} 单据 id=${xid}`);
      // [Opus 预筛 S6-LOW-1 收口] 严格类型 + 值双断言（不裸 Number() 转换后比对）——Number(null)===0
      // 会把"字段缺失/漏投影导致读到 null"误判成"合法的 0"从而假绿，本条先钉 typeof==='number' 排除
      // null/undefined 两种脏态，再比对具体值，两种坏法都能抓到。
      assert.strictEqual(typeof lr.fast_release_active_auth, 'number', `[57c-list-${label}] fast_release_active_auth 应为 number 类型（非 null/undefined），实得 ${typeof lr.fast_release_active_auth}`);
      assert.strictEqual(lr.fast_release_active_auth, 0, `[57c-list-${label}] fast_release_active_auth 应为 0，实得 ${lr.fast_release_active_auth}`);
      assert.strictEqual(lr.fast_release_exec_total_count, 0, `[57c-list-${label}] total_count 应为 0，实得 ${lr.fast_release_exec_total_count}`);
      assert.strictEqual(lr.fast_release_exec_done_count, 0, `[57c-list-${label}] done_count 应为 0，实得 ${lr.fast_release_exec_done_count}`);
    }
    ok('[57c] 非挂牌单行为：从未授权的处理中 bug 单与 feature 单，详情均 fast_release_executors=[]、progress={done_count:0,total_count:0}（type!=="bug" 门控 + 从未挂牌两条路径均验证）；列表侧两单三列均确定性归零（非 undefined）');
  }

  // ══════════════════════════ [57d+57h]（S6·§4-8）consumed 单留痕块 + 翻牌后 fast_release_active_auth 归零 ══════════════════════════
  //   复用 [57a] 混合态单（id57，此刻 1 done+1 pending），续走至末位确认——验证"同一份查询天然身兼实时
  //   执行区数据源与已上线单部署留痕只读展示两种用途"这条 S6 编码期设计取舍（详见交付报告）。
  {
    const rc2 = await confirm(id57, liaisonTok);   // 示例对接人（user13）确认——此刻应为末位，触发翻牌
    assert.strictEqual(rc2.status, 200, `[57d-前置] 示例对接人确认应 200，实得 ${rc2.status} ${JSON.stringify(rc2.body)}`);
    assert.strictEqual(rc2.body.flipped, true, '[57d-前置] 示例对接人是末位，确认应触发翻牌');

    const row = await issueRow(id57);
    assert.strictEqual(row.status, '已上线', '[57d-前置] 应已翻牌为已上线');
    assert.strictEqual(row.online_source, 'authorized_fastlane', '[57d-前置] online_source 应为 authorized_fastlane');
    assert.ok(row.fast_release_consumed_at, '[57d-前置] fast_release_consumed_at 应已写入（授权已消费）');

    const detail = await call('GET', `/api/sys-issues/${id57}`, adminTok);
    assert.strictEqual(detail.status, 200, `[57d] 详情应 200，实得 ${detail.status}`);
    const execs = detail.body.fast_release_executors;
    assert.strictEqual(execs.length, 2, `[57d] 消费后集合行应仍恰 2 行（部署留痕保留，方案 §5b 第 7 行），实得 ${execs.length}`);
    assert.ok(execs.every(e => e.exec_status === 'done'), `[57d] 全部行应为 done（末位确认已补齐），实得 ${JSON.stringify(execs)}`);
    assert.ok(execs.every(e => e.executed_at), '[57d] 全部行 executed_at 应非空');
    assert.deepStrictEqual(detail.body.fast_release_exec_progress, { done_count: 2, total_count: 2 },
      `[57d] 进度计数应为 {done_count:2,total_count:2}（部署留痕），实得 ${JSON.stringify(detail.body.fast_release_exec_progress)}`);

    // [57h] 列表侧：fast_release_active_auth 应归零（授权已消费，isActiveFastReleaseAuth 六列判据转
    //   false）——与 status 已非「待验证」共同构成"两个独立信号都关闭徽章"，不依赖只有一个信号生效；
    //   x/N 计数仍正确显示 2/2（consumed 单展示部署留痕用，见 S6 详情附块条件性取舍论证）。
    const list = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list.status, 200, `[57h] 列表应 200，实得 ${list.status}`);
    const lr = (list.body.items || []).find(x => x.id === id57);
    assert.ok(lr, `[57h] 列表应含该单据 id=${id57}`);
    // [Opus 预筛 S6-LOW-1 收口] 同 [57c-list] 同源——typeof 排除 null/undefined 假绿后再比值。
    assert.strictEqual(typeof lr.fast_release_active_auth, 'number', `[57h] fast_release_active_auth 应为 number 类型（非 null/undefined），实得 ${typeof lr.fast_release_active_auth}`);
    assert.strictEqual(lr.fast_release_active_auth, 0, `[57h] 消费后 fast_release_active_auth 应归零，实得 ${lr.fast_release_active_auth}`);
    assert.strictEqual(lr.status, '已上线', '[57h] status 应已非「待验证」（另一独立信号同样关闭徽章）');
    assert.strictEqual(lr.fast_release_exec_total_count, 2, `[57h] 列表 x/N total 应为 2（消费态部署留痕同样反映在列表投影），实得 ${lr.fast_release_exec_total_count}`);
    assert.strictEqual(lr.fast_release_exec_done_count, 2, `[57h] 列表 x/N done 应为 2，实得 ${lr.fast_release_exec_done_count}`);
    ok('[57d+57h] consumed 单留痕块：详情 fast_release_executors 保留全部 2 行 done（部署留痕，方案 §5b 第 7 行）+ progress={done_count:2,total_count:2}；列表侧 fast_release_active_auth 归零（授权已消费）与 status 已非「待验证」两个独立信号共同关闭徽章，同时 x/N 计数仍正确显示 2/2（供已上线单展示部署留痕用）');
  }

  // ══════════════════════════ [57g]（S6·方案 §4-1）空集合 0/0：当日无值班挂牌单 ══════════════════════════
  {
    // 临时清空当日值班（交接摘要五坑之④：共享夹具组内改动必须组末复位）。
    await run(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员'
               WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    // [codex 392 号 conditional L1 收口] 造态与全部断言纳入 try，复位挪进 finally 无条件执行——原写法
    //   把 setDutyToday 复位放在组末最后一行，组内任一断言先抛错就永远执行不到，会把"当日无值班"这个
    //   被本组人为清空的全局状态**永久污染**到本文件之后的其余组（sys_release_duty_roster 是整个测试
    //   进程共享的一张表，非本组私有夹具，多个既有组的既有断言默认"当日值班=user20"这一前提）。
    //   ⚠️ 不用 `finally { await setDutyToday(...) }` 直接裸跑——finally 块内抛出的异常会**替换/掩盖**
    //   try 块里已经在传播的原始异常（JS 语言标准行为），若复位本身失败会让"真正测试失败在哪"这条
    //   最关键的信息丢失。改用显式变量捕获原始错误、finally 内单独 try/catch 复位、复位失败时把清理
    //   错误**追加**到原始错误 message（不替换），最后统一按"有错误则 throw"的方式收尾。
    let originalErr = null;
    try {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '57g-空集合0/0');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
      assert.strictEqual(r.status, 200, `[57g-前置] submit 应 200，实得 ${r.status}`);
      assert.strictEqual(r.body.main_status, '待验证', '[57g-前置] 应正常进入待验证');
      const feRows = await fastExecRows(id);
      assert.strictEqual(feRows.length, 0, '[57g-前置] 当日无值班，挂牌集合应恰 0 行');

      const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
      assert.strictEqual(detail.status, 200, `[57g] 详情应 200，实得 ${detail.status}`);
      assert.deepStrictEqual(detail.body.fast_release_executors, [], '[57g] 0/0 场景详情数组应为空数组（非 null，同 bugCauseRecords 空值口径）');
      assert.deepStrictEqual(detail.body.fast_release_exec_progress, { done_count: 0, total_count: 0 }, '[57g] 进度计数应为 {done_count:0,total_count:0}');

      const list = await call('GET', '/api/sys-issues', adminTok);
      assert.strictEqual(list.status, 200, `[57g-list] 列表应 200，实得 ${list.status}`);
      const lr = (list.body.items || []).find(x => x.id === id);
      assert.ok(lr, `[57g] 列表应含该单据 id=${id}`);
      assert.strictEqual(Number(lr.fast_release_active_auth), 1,
        `[57g] 授权本身仍活跃（只是当日无人配置执行人）——fast_release_active_auth 应为 1，实得 ${lr.fast_release_active_auth}`);
      assert.strictEqual(lr.status, '待验证', '[57g] status 应为「待验证」');
      assert.strictEqual(lr.fast_release_exec_total_count, 0, `[57g] 列表 x/N total 应为 0，实得 ${lr.fast_release_exec_total_count}`);
      assert.strictEqual(lr.fast_release_exec_done_count, 0, `[57g] 列表 x/N done 应为 0，实得 ${lr.fast_release_exec_done_count}`);
    } catch (e) {
      originalErr = e;
    } finally {
      // 复位当日值班（本组是全文件末组，复位主要为纪律一致性与未来扩展安全，非当前有下游组依赖）——
      //   无条件执行：断言成功/失败都要跑，防全局共享表被本组污染到后续组或后续测试运行。
      try {
        await setDutyToday(20, '值班员甲');
      } catch (cleanupErr) {
        const cleanupMsg = `[57g] 清理阶段（复位当日值班）失败: ${cleanupErr && cleanupErr.message}`;
        if (originalErr) {
          // 保留原始断言错误为主因，追加清理错误信息（不替换/不掩盖——这是本条修复要解决的核心问题）。
          originalErr.message += `\n${cleanupMsg}`;
        } else {
          // 断言全部通过但清理本身失败——这本身就是需要暴露的问题（全局值班表被永久污染，会误伤
          // 后续任何依赖"当日值班=user20"这一前提的组），不能因为"业务断言都绿了"就静默吞掉。
          originalErr = new Error(`[57g] 断言全部通过，但${cleanupMsg}`);
        }
      }
    }
    if (originalErr) throw originalErr;
    ok('[57g] 空集合 0/0：当日无值班挂牌单——详情 fast_release_executors=[]/progress={done_count:0,total_count:0}；列表 fast_release_active_auth=1（授权仍活跃，与"是否配置了执行人"是两个独立信号）+ x/N=0/0（方案 §4-1「0/0 待配置执行人」语义）');
  }

  // ══════════════════════════ [58]（Opus 预筛 S6-HIGH-1+MED-2·2026-08-14）值班执行人可见性成对用例 ══════════════════════════
  //   HIGH-1：值班执行人（非 admin/非对接人/非 bug 对接人白名单/非在册开发/非技术负责人）挂牌单
  //   列表 0 条+详情 403——「API 能确认 UI 进不去」双断。修法照 C4a 批次执行人先例补列表 WHERE 析取 +
  //   详情放行分支，均只认当前代次未软删行（sysFastReleaseExecActiveWhere 统一谓词）。
  //   MED-2：一并验证非 admin 读者（值班执行人）视角读到的三列/DTO 附块与 admin 视角完全一致（同一份
  //   SELECT，读权放开不改变数据本身）。
  {
    const id = await bugAtChulizhong();   // 受理人=admin，指派开发=devTok(user5)——值班人 user20 与本单
    // 结构上无任何其余关联（非 assigned_to/非 intake_liaison(=13)/非 SYS_BUG_LIAISON_USER_IDS([7,13])/
    // 非 SYS_TECH_LEAD_IDS([7])/非在册开发），是隔离测试新析取项 fastReleaseExecVisibilitySql 的干净夹具。
    await estimateFuture(id);
    await authorize(id, adminTok, '58-值班执行人可见性');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(subR.status, 200, `[58-前置] submit 应 200，实得 ${subR.status}`);
    const feRows = await fastExecRows(id);
    assert.strictEqual(feRows.length, 1, '[58-前置] 挂牌应恰 1 行（当日值班=user20）');
    assert.strictEqual(feRows[0].user_id, 20, '[58-前置] 挂牌行应为值班人 user20');

    // [58a] 在册时：值班人（dutyTok）列表可见 + 详情 200（HIGH-1 修复前：列表 0 条 + 详情 403，
    //   本组断言方向即针对修复后的正确态，用于回归；预筛原文红灯已由本次修复验证过，不重复演示红态）。
    const listBefore = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(listBefore.status, 200, `[58a] 值班人列表请求应 200，实得 ${listBefore.status}`);
    const hitBefore = (listBefore.body.items || []).find(x => x.id === id);
    assert.ok(hitBefore, `[58a] 值班执行人列表应可见该单 id=${id}（HIGH-1 核心修复点：新增 fastReleaseExecVisibilitySql 析取项）`);

    const detailBefore = await call('GET', `/api/sys-issues/${id}`, dutyTok);
    assert.strictEqual(detailBefore.status, 200, `[58a] 值班执行人详情应 200（HIGH-1 核心修复点：新增 isFastReleaseExecutor 放行分支），实得 ${detailBefore.status} ${JSON.stringify(detailBefore.body)}`);

    // [58a·MED-2] DTO 附块可读且值正确——值班人视角三列/详情附块的字面值断言。
    assert.strictEqual(typeof hitBefore.fast_release_active_auth, 'number', '[58a-list] fast_release_active_auth 应为 number');
    assert.strictEqual(hitBefore.fast_release_active_auth, 1, '[58a-list] 值班执行人视角 fast_release_active_auth 应为 1');
    assert.strictEqual(hitBefore.fast_release_exec_total_count, 1, '[58a-list] 值班执行人视角 total_count 应为 1');
    assert.strictEqual(hitBefore.fast_release_exec_done_count, 0, '[58a-list] 值班执行人视角 done_count 应为 0（尚未确认）');
    assert.strictEqual(detailBefore.body.issue.fast_release_active_auth, 1, '[58a-detail] 值班执行人视角详情 issue.fast_release_active_auth 应为 1（MED-1 判官归一新字段）');
    const execsBefore = detailBefore.body.fast_release_executors;
    assert.ok(Array.isArray(execsBefore) && execsBefore.length === 1, `[58a-detail] 值班执行人视角 fast_release_executors 应恰 1 行，实得 ${JSON.stringify(execsBefore)}`);
    assert.strictEqual(execsBefore[0].user_id, 20, '[58a-detail] 值班执行人视角应能读到自己那一行');
    assert.deepStrictEqual(detailBefore.body.fast_release_exec_progress, { done_count: 0, total_count: 1 }, '[58a-detail] 值班执行人视角进度计数应为 {done_count:0,total_count:1}');

    // [58a·codex 392 号 conditional M2 收口] 上面只验证了字面值，未真正验证"与 admin 视角一致"这句
    //   断言原文承诺过的内容——补发同状态下的 adminTok 列表+详情请求，对 fastlane 派生字段做
    //   deepStrictEqual 交叉核对；字面值断言与本组跨视角断言互补（前者钉死具体数值，后者钉死两个
    //   身份读到同一份数据，不因读权放开而值走样）。
    //   显式排除（读者相关派生字段，不参与本次对拍，理由逐项注明——混进同一次 deepStrictEqual 只会
    //   制造假红，因为它们本就该因读者不同而不同）：
    //     · release_brief——canSeeReleaseBrief=isAdmin∨isIntakeLiaisonUser∨isReleaseExecutor，值班
    //       执行人三者皆非，结构上应读 null；admin 读非 null 或 null 视 release_id 是否非空而定（本
    //       夹具 release_id 为空，此刻两视角碰巧同为 null，但这是数据巧合非契约，不纳入断言）；
    //     · attachments/specAttachments/hasSpecAttachment——canSeeAttachmentList 门槛是
    //       admin∨协调人∨dev-roster，值班执行人不在其中，结构上应读 []，与 admin 视角天然不对称；
    //     · can_bug_hold——按 actor 身份实时计算（canBugHold(actor,row)），是"这个人能不能操作"的
    //       授权位，天然因人而异，非"这条数据是什么"的事实字段。
    const listByAdmin = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(listByAdmin.status, 200, `[58a-cross] admin 列表请求应 200，实得 ${listByAdmin.status}`);
    const hitByAdmin = (listByAdmin.body.items || []).find(x => x.id === id);
    assert.ok(hitByAdmin, `[58a-cross] admin 列表应可见该单 id=${id}`);
    assert.deepStrictEqual(
      { active_auth: hitByAdmin.fast_release_active_auth, total: hitByAdmin.fast_release_exec_total_count, done: hitByAdmin.fast_release_exec_done_count },
      { active_auth: hitBefore.fast_release_active_auth, total: hitBefore.fast_release_exec_total_count, done: hitBefore.fast_release_exec_done_count },
      '[58a-cross] 列表三列：admin 视角应与值班执行人视角逐字段相等（同一份数据，不因读者身份而异）'
    );

    const detailByAdmin = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detailByAdmin.status, 200, `[58a-cross] admin 详情请求应 200，实得 ${detailByAdmin.status}`);
    assert.deepStrictEqual(detailByAdmin.body.issue.fast_release_active_auth, detailBefore.body.issue.fast_release_active_auth,
      '[58a-cross] 详情 issue.fast_release_active_auth：admin 视角应与值班执行人视角相等');
    assert.deepStrictEqual(detailByAdmin.body.fast_release_executors, execsBefore,
      `[58a-cross] 详情 fast_release_executors 五键数组：admin 视角应与值班执行人视角逐字段（id/user_id/user_name/exec_status/executed_at）完全相等，实得 admin=${JSON.stringify(detailByAdmin.body.fast_release_executors)} vs 值班=${JSON.stringify(execsBefore)}`);
    assert.deepStrictEqual(detailByAdmin.body.fast_release_exec_progress, detailBefore.body.fast_release_exec_progress,
      '[58a-cross] 详情 fast_release_exec_progress：admin 视角应与值班执行人视角相等');

    // [58b] 移出集合（admin 移人，pending 行可移）后应恢复"不可见"——软删=退出当前代次，与写侧
    //   sysFastReleaseExecActiveWhere 统一谓词同口径（方案口径"撤销/终结/重授权软删后失去可见性=语义
    //   合理"的最小可复现形态：用移人而非撤销授权同样触发软删，验证的是同一条"只认当前代次未软删行"
    //   的读侧过滤，不依赖撤销流程本身）。
    const rmR = await call('DELETE', `/api/sys-issues/${id}/fast-release-executors/20`, adminTok);
    assert.strictEqual(rmR.status, 200, `[58b-前置] 移人应 200，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    const feAfterRemove = await fastExecRows(id);
    assert.strictEqual(feAfterRemove.filter(r => !r.removed_at).length, 0, '[58b-前置] 移人后当前代次应恰 0 行未软删');

    const listAfter = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(listAfter.status, 200, `[58b] 值班人列表请求应 200，实得 ${listAfter.status}`);
    const hitAfter = (listAfter.body.items || []).find(x => x.id === id);
    assert.ok(!hitAfter, `[58b] 移出集合（软删）后值班人不应再从列表看到该单——只认当前代次未软删行的口径生效`);

    const detailAfter = await call('GET', `/api/sys-issues/${id}`, dutyTok);
    assert.strictEqual(detailAfter.status, 403, `[58b] 移出集合后值班人详情应恢复 403，实得 ${detailAfter.status} ${JSON.stringify(detailAfter.body)}`);
    assert.strictEqual(detailAfter.body.code, 'NOT_AUTHORIZED_TO_VIEW', `[58b] 403 错误码应为 NOT_AUTHORIZED_TO_VIEW，实得 ${detailAfter.body.code}`);

    ok('[58]（Opus 预筛 S6-HIGH-1+MED-2）值班执行人可见性成对用例：在册时列表可见+详情200+三列/DTO附块值正确（值班人与admin视角一致）；移出集合（软删退出当前代次）后列表不可见+详情恢复403（口径="只认当前代次未软删行"，与撤销/终结/重授权失去可见性同一语义）');
  }

  // ══════════════════════════ [59]（值班筛选与类型卡·S1）fast_release_my_pending 列表投影成对用例 ══════════════════════════
  //   SSOT = docs/local/系统迭代/任务_值班筛选与类型卡_长任务锚点_20260815.md §3 技术自决——当前登录
  //   用户在本单当前代次执行人集合中且尚未确认（exec_status<>'done'）时为 1，否则 0；**不掺**
  //   fast_release_active_auth（前端消费「待我确认」入口时才 AND，本列只回答"我在不在集合里且没
  //   确认"这一件事，与既有 total/done 两列同族，不做 type/status 门控）。
  {
    // [59-前置1][59a][59b] 正例 + 反例②——当日值班（user20）挂牌单，唯一执行人尚未确认。
    const id1 = await bugAtChulizhong();
    await estimateFuture(id1);
    await authorize(id1, adminTok, '59-值班待我确认');
    const sub1 = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(sub1.status, 200, `[59-前置1] submit 应 200，实得 ${sub1.status} ${JSON.stringify(sub1.body)}`);
    const feRows1 = await fastExecRows(id1);
    assert.strictEqual(feRows1.length, 1, `[59-前置1] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows1.length}`);
    assert.strictEqual(feRows1[0].user_id, 20, '[59-前置1] 唯一执行人应为当日值班人（user20）');
    assert.strictEqual(feRows1[0].exec_status, 'pending', '[59-前置1] 确认前应仍 pending');

    // [59a] 正例：值班人（dutyTok）在当前代次执行人集合中且未确认 ⇒ 1。
    const list59a = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(list59a.status, 200, `[59a] 值班人列表请求应 200，实得 ${list59a.status}`);
    const hit59a = (list59a.body.items || []).find(x => x.id === id1);
    assert.ok(hit59a, `[59a] 值班人列表应可见该单 id=${id1}`);
    assert.strictEqual(typeof hit59a.fast_release_my_pending, 'number', '[59a] fast_release_my_pending 应为 number 类型');
    assert.strictEqual(hit59a.fast_release_my_pending, 1, `[59a] 正例：本人在当前代次执行人集合且未确认，应为 1，实得 ${hit59a.fast_release_my_pending}`);

    // [59b] 反例②：不在集合的用户（admin，uid=1）请求同一单 ⇒ 0（admin 从未加入过该单执行人集合，
    //   全局可见性与本列的"我是否在集合里"是两件事——admin 看得到单不代表本列该为 1）。
    const list59b = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list59b.status, 200, `[59b] admin 列表请求应 200，实得 ${list59b.status}`);
    const hit59b = (list59b.body.items || []).find(x => x.id === id1);
    assert.ok(hit59b, `[59b] admin 列表应可见该单 id=${id1}`);
    assert.strictEqual(hit59b.fast_release_my_pending, 0, `[59b] 反例②：admin（uid=1）不在该单执行人集合中，应为 0，实得 ${hit59b.fast_release_my_pending}`);

    // [59-绑定顺序] S-fix 2c：把「SELECT 占位符×addEq 参数不错位」钉进本套件自己的断言，不再靠外套件
    //   （如 verify-sys-fastrelease-auth.js）偶然兜底。my_pending 子查询的 uid 走 selectParams 段、
    //   执行点按 [...selectParams, ...params] 段序拼接（S-fix3 结构化·见 index.js 声明处注释），带 query 参数（type=bug，addEq 追加在
    //   params 数组末尾）时若两者顺序被谁不小心挪动，uid 会被错绑成 type 值（或反之），下面两条断言会
    //   立刻失真（值班人本应 1 的位置读到别的东西/admin 本应 0 的位置读到别的东西）。
    const list59q1 = await call('GET', '/api/sys-issues?type=bug', dutyTok);
    assert.strictEqual(list59q1.status, 200, `[59-绑定顺序] 值班人带 type=bug 查询应 200，实得 ${list59q1.status}`);
    const hit59q1 = (list59q1.body.items || []).find(x => x.id === id1);
    assert.ok(hit59q1, `[59-绑定顺序] 值班人带 type=bug 查询应仍可见该单 id=${id1}`);
    assert.strictEqual(hit59q1.fast_release_my_pending, 1, `[59-绑定顺序] 值班人带 query 请求 my_pending 应为 1（参数绑定未错位），实得 ${hit59q1.fast_release_my_pending}`);
    const list59q2 = await call('GET', '/api/sys-issues?type=bug', adminTok);
    assert.strictEqual(list59q2.status, 200, `[59-绑定顺序] admin 带 type=bug 查询应 200，实得 ${list59q2.status}`);
    const hit59q2 = (list59q2.body.items || []).find(x => x.id === id1);
    assert.ok(hit59q2, `[59-绑定顺序] admin 带 type=bug 查询应仍可见该单 id=${id1}`);
    assert.strictEqual(hit59q2.fast_release_my_pending, 0, `[59-绑定顺序] admin 带 query 请求 my_pending 应为 0（参数绑定未错位），实得 ${hit59q2.fast_release_my_pending}`);

    // [59-前置2][59c] 反例①：唯一执行人确认后 exec_status 变 done（本单同时触发末位翻牌，集合行按
    //   方案 §5b 第 7 行保留不软删——sysFastReleaseExecActiveWhere 只判 issue_id/removed_at，值班人
    //   对该单的可见性 fastReleaseExecVisibilitySql 翻牌后依然成立，故可继续用同一用户 dutyTok 复核
    //   done 分支，不需要换人）。
    const rc59 = await confirm(id1, dutyTok);
    assert.strictEqual(rc59.status, 200, `[59-前置2] confirm 应 200，实得 ${rc59.status} ${JSON.stringify(rc59.body)}`);
    assert.strictEqual(rc59.body.flipped, true, '[59-前置2] 唯一执行人=末位，确认应触发翻牌');
    const list59c = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(list59c.status, 200, `[59c] 值班人列表请求应 200，实得 ${list59c.status}`);
    const hit59c = (list59c.body.items || []).find(x => x.id === id1);
    assert.ok(hit59c, `[59c] 值班人对已翻牌单仍应可见（集合行未软删，部署留痕）id=${id1}`);
    assert.strictEqual(hit59c.fast_release_my_pending, 0, `[59c] 反例①：exec_status 已为 done，应为 0，实得 ${hit59c.fast_release_my_pending}`);

    // [59-前置3][59d] 反例③：非活跃成员（被移出当前代次，removed_at 非空）——用已是 assigned_to 的
    //   devTok 加为第二执行人再移除；移除后 devTok 仍经 assigned_to 通道可见该单（不像 dutyTok 那样
    //   依赖 fastReleaseExecVisibilitySql，会随软删一并失去可见性，见 [58b]），从而能在同一单上单独
    //   复核"在集合但已软删"这一条失效维度，不与 [58b] 那种"移出后连可见性都一并失去"的形态混淆。
    const id2 = await bugAtChulizhong();
    await estimateFuture(id2);
    await authorize(id2, adminTok, '59-非活跃成员');
    const sub2 = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(sub2.status, 200, `[59-前置3] submit 应 200，实得 ${sub2.status} ${JSON.stringify(sub2.body)}`);
    const addR = await addExecutor(id2, 5, adminTok);
    assert.strictEqual(addR.status, 200, `[59-前置3] 加人（devTok）应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    // [59-前置3·S-fix 2b] 移人前中间断言：确认 devTok(user5) 此刻确实在活跃集合恰 1 行——堵"addExecutor
    //   端点静默 no-op（如加人 200 但实际未 INSERT）时 [59d] 断言仍会恒成立"这条假绿路径（若 devTok 从未
    //   真正进过集合，后面移除它也不会改变任何东西，[59d] 的"移出后应为 0"本就一直是 0，无法证明本列
    //   真的响应了"移出"这个动作）。
    const feRowsBeforeRemove = await fastExecRows(id2);
    const activeUser5Rows = feRowsBeforeRemove.filter((r) => r.user_id === 5 && !r.removed_at);
    assert.strictEqual(activeUser5Rows.length, 1, `[59-前置3] 移人前应确认 devTok(user5) 在活跃集合恰 1 行，实得 ${activeUser5Rows.length}`);
    const rmR = await removeExecutor(id2, 5, adminTok);
    assert.strictEqual(rmR.status, 200, `[59-前置3] 移人（devTok）应 200，实得 ${rmR.status} ${JSON.stringify(rmR.body)}`);
    assert.strictEqual(rmR.body.flipped, false, '[59-前置3] 剩余仍含值班人 pending，不应翻牌');
    const list59d = await call('GET', '/api/sys-issues', devTok);
    assert.strictEqual(list59d.status, 200, `[59d] devTok 列表请求应 200，实得 ${list59d.status}`);
    const hit59d = (list59d.body.items || []).find(x => x.id === id2);
    assert.ok(hit59d, `[59d] devTok 仍应经 assigned_to 通道可见该单 id=${id2}`);
    assert.strictEqual(hit59d.fast_release_my_pending, 0, `[59d] 反例③：devTok 已被移出当前代次（removed_at 非空），应为 0，实得 ${hit59d.fast_release_my_pending}`);

    // [59e] 字段存在性：无任何 fastlane 数据的普通单，字段仍下发且为 0（非 undefined 缺省）——同族列
    //   has_release_remove/last_held_at 既有"SQL 只出数不做门控"范式的同款存在性核验。
    const id3 = await bugAtChulizhong();
    const list59e = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(list59e.status, 200, `[59e] admin 列表请求应 200，实得 ${list59e.status}`);
    const hit59e = (list59e.body.items || []).find(x => x.id === id3);
    assert.ok(hit59e, `[59e] admin 列表应可见该单 id=${id3}`);
    assert.strictEqual(typeof hit59e.fast_release_my_pending, 'number', `[59e] 无 fastlane 数据的普通单字段仍应下发为 number（非 undefined），实得 ${typeof hit59e.fast_release_my_pending}`);
    assert.strictEqual(hit59e.fast_release_my_pending, 0, `[59e] 无 fastlane 数据的普通单应为 0，实得 ${hit59e.fast_release_my_pending}`);

    // [59f] S-fix 2a·不掺闸对照：SQL 造态构造"消费态叠加集合仍未软删"这一真实端点不可达的组合——真实
    //   末位确认翻牌是单事务原子完成（consumed_at 落值 + 集合行转 done + 主状态推到已上线三件事同一
    //   事务内一起发生，见 attemptFastReleaseFlipInTxn 契约注释），永远不会出现"consumed_at 已落值但
    //   集合行仍 pending、主状态仍待验证"这种半吊子态；本组直接绕过端点用 SQL 精确造出这个组合，专门
    //   用来钉死"fast_release_my_pending 原始信号不掺 fast_release_active_auth 这道授权闸"的契约——
    //   若未来有人在子查询里补一句 AND fast_release_active_auth（或等价的六列判据）想让两列看起来更
    //   "一致"，active_auth 归零的同时 my_pending 会被连带压到 0，本条断言立即由 1 变 0 判红。
    const id4 = await bugAtChulizhong();
    await estimateFuture(id4);
    await authorize(id4, adminTok, '59f-不掺闸对照');
    const sub4 = await call('POST', `/api/sys-issues/${id4}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(sub4.status, 200, `[59f-前置] submit 应 200，实得 ${sub4.status} ${JSON.stringify(sub4.body)}`);
    const feRows4 = await fastExecRows(id4);
    assert.strictEqual(feRows4.length, 1, `[59f-前置] 挂牌应恰 1 行（当日值班=user20），实得 ${feRows4.length}`);
    assert.strictEqual(feRows4[0].exec_status, 'pending', '[59f-前置] SQL 造态前应仍 pending（真实链路不可达组合的起点须是真实可达态）');
    await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime') WHERE id = ?`, [id4]);
    const list59f = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(list59f.status, 200, `[59f] 值班人列表请求应 200，实得 ${list59f.status}`);
    const hit59f = (list59f.body.items || []).find((x) => x.id === id4);
    assert.ok(hit59f, `[59f] 值班人对该单仍应可见（fastReleaseExecVisibilitySql 只判 issue_id/removed_at，与 consumed_at 无关）id=${id4}`);
    assert.strictEqual(hit59f.fast_release_active_auth, 0, `[59f-前置] fast_release_consumed_at 非空应使授权闸（FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL 六列判据之一）归零，实得 ${hit59f.fast_release_active_auth}（造态前提不成立，下面核心断言的对比基准就不存在）`);
    assert.strictEqual(hit59f.fast_release_my_pending, 1, `[59f] 不掺闸对照核心断言：授权闸已归零（fast_release_active_auth=0）不应连带压低 my_pending——本人仍在当前代次集合且未确认，原始信号应仍为 1，实得 ${hit59f.fast_release_my_pending}（若为 0，说明子查询被人补了 AND active_auth 之类的闸，"原始信号不掺闸、消费端才 AND"的契约在后端就被破坏了）`);
    // [S-fix2·预筛三轮 LOW-2] 造态清理恢复（同 [S5] 不变量探针「SQL 造态反证+清理恢复」范式）：
    //   consumed 非空∧集合仍 pending 是声明为不可达的非法组合，原样留库会误伤未来在本组之后追加的
    //   终态不变量扫描——断言完毕即复原。
    await run(`UPDATE sys_issues SET fast_release_consumed_at = NULL WHERE id = ?`, [id4]);

    ok('[59]（值班筛选与类型卡·S1）fast_release_my_pending 列表投影：正例(本人在集合未确认=1)+反例①(exec_status=done→0)+反例②(不在集合的用户admin→0)+反例③(被移出当前代次的非活跃成员→0，assigned_to通道保持可见，[59-前置3]补移除前活跃集合恰1行中间断言堵addExecutor静默no-op假绿)+字段存在性(无fastlane数据的普通单仍下发0非undefined)+绑定顺序(带type=bug查询双身份对照钉进本套件自身)+不掺闸对照(SQL造态consumed_at非空使active_auth归零但my_pending仍1)');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ verify-sys-fastlane-submit 全绿`);
  console.log('  覆盖：schema 就绪 + 兼容负例(direct_release=true 零效果) + 挂牌正例(无值班0/0·有值班1行) + 无授权零挂牌对照组 + 挂牌只发生在状态真翻转路径(多开发) + 挂牌资格复核(停用/降权) + 挂牌闸type钳制 + last_completed_at正常路径 + 不变量①②③⑦探针 + online_source消费面(造态) + FAST_RELEASE_CONFIRM routeKind单元覆盖(S3改名·真实调用方) + reopen清补验收字段组(造态起点) + 授权早于reopen纵深防御(挂牌闸重定义) + isActiveFastReleaseAuth唯一判据fail-closed + [S3] 确认端点单人末位/多人非末位/负例族/空集合/代次干扰/弹回×done闸门/原子性/§3.3副作用/翻牌UPDATE全仓唯一 + [S4] 加人正例+user_name来源断言/重复加人409/首done后FROZEN成对/非挂牌态加人409成对/无资格三态/移人pending正例/移done行409/移人后同事务翻牌正例(真实端点,含因果顺序断言)/移空后不翻+解冻/非挂牌态移人409/移不存在的人409/confirm×remove竞争串行化成对 + [Opus385预筛收口] 软删后重加同user_id反向一对/user_name归一化级联三态(目标一级/目标两级/操作者)/两新端点403权限负例 + [codex387回卷] 加人x确认并发终态枚举法(add_first/confirm_first两方向均真实观测)/双加人同user_id并发(partial UNIQUE竞态互斥) + [S5] revoke成对(无done核心价值·重挂牌不撞UNIQUE/有done409)/accept成对(无done清集合/有done409+续走翻牌)/return成对(无done清集合/有done409)/void含done终极出口/reject零行照常/不变量⑪⑫双向探针(终态零违例+SQL造态反证判红+清理恢复) + [Opus S5=BLOCK 预筛 H1/L1] 重新授权清集合三变体(同人值班跨轮不再500/换值班人跨轮accept·return·revoke均不再409/无值班跨轮0-0照挂+加人解冻)/C9直翻非空集合cause=上线翻牌正例 + [codex389二批] revoke闸序修正(已消费单不再误报DEPLOY_IN_PROGRESS)/重新授权原子性故障注入(触发器阻断清集合UPDATE四面全回滚+恢复对照) + [S6] 详情DTO(挂牌混合态数组+进度/代次干扰过滤/非挂牌单空数组/consumed单留痕保留)+列表投影(x/N计数·代次干扰不计分母·空集合0/0·消费后active_auth归零·非fastlane单三列确定性归零) + [Opus预筛S6-HIGH-1/MED-2] 值班执行人可见性成对(在册列表可见+详情200+三列/DTO附块值正确/移出集合后列表不可见+详情恢复403) + [值班筛选与类型卡S1] fast_release_my_pending列表投影(正例本人在集合未确认=1/反例①exec_status=done→0/反例②不在集合的用户admin→0/反例③被移出当前代次的非活跃成员→0/字段存在性无fastlane数据普通单仍下发0非undefined) + [S-fix] 绑定顺序双身份带query对照钉进本套件自身/不掺闸对照(SQL造态consumed_at非空使active_auth归零但my_pending仍1)/59d移除前活跃集合中间断言堵addExecutor静默no-op假绿');
  server.close();
}

main().catch((e) => { fail(e && e.stack ? e.stack : String(e)); });
