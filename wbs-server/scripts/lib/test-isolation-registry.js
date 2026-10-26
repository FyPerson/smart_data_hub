/**
 * #106 S4a：测试脚本隔离登记表（纯数据模块，不做 I/O）。由全目录静态守卫 verify-test-isolation-static.js 读取。
 *
 * 一个脚本文件落入且只落入一类：MIGRATED（已迁移到 test-env，受分析器全部规则保护）/ EXEMPT（部署维护 / 演示 / 探针类，不是测试，不扫内容）/
 * INFRA（测试基础设施本身或隔离机制自己的测试，不扫内容）/ 未迁移基线（lib/test-isolation-baseline.json，只减不增）/ 其余（未登记，必须 Tier-1 零命中）。
 * 另有两个附加属性（不改变上面的分类，登记在下方）：SOURCE_READERS（只读 server.js 源码、不起进程）与 SELF_ISOLATED（自带隔离机制的套件：自己在临时目录里起被测服务，不走 test-env；
 * 可与 MIGRATED 并存，不能与 EXEMPT / INFRA / SOURCE_READERS / 基线并存）。
 *
 * EXEMPT 与 INFRA 两段由 S4-0 迁移配方（docs/local/多线并行/多线并行改造_S4-0迁移配方_20261019.json，HEAD 268d729c）的 status 逐文件生成：
 *   EXEMPT = status 'exempt-cand' 的 50 个 + 2 个追加（create_amount_metrics.js、sys-multidev-c0-reset.js）- 4 个 Tier-1 零命中的（修复批 2：豁免必须有必要，
 *   _probe-fastlane-exec-missing-col.js / _probe-fastlane-gate-disabled.js / fix-sys-intake-gate-violation.js / probe-process-type.js 移出，落到「其他」类）= 48，S4e-4 再追加 2 个（probe-assign-mode-history.js、probe-result-attachment-owner-consistency.js，由同名 verify-* 脚本改名而来）= 50；S5 把 5 个一次性脚本（apply / build-routes-corrections、3 个 probe-correction-*）移入 scripts/_archive/，删除对应条目 = 45；INFRA = status 'infra' 的 19 个，S7 追加 verify-lines-merge.js（line merge 自检，临时仓库内运行）= 20。
 *   按前缀套的理由已逐个核过，当时有 5 个不属实的单独改写（probe-correction-* 三个是只读源码探针——S5 已归档，条目不复存在；probe-getuserid-by-mobile 是钉钉接口探针、probe-notify-read-diagnosis 默认纯库内 SELECT）。
 * 守卫对 EXEMPT 另做：名字检查（不得以 verify- / test- / smoke- 开头、不得是 FAMILY 成员、理由非空）、Tier-1 零命中判过期（STALE），对 INFRA 做名字白名单（只允许这 20 个，新增须改守卫常量）。
 * S4b–S4e 迁移批次往 MIGRATED 追加（值为对象，以后可加字段；本批不加）。
 */
'use strict';

/**
 * 已迁移：S3b 的 8 个代表脚本（前 8 个）+ S4b1 的 12 个（e4fc425a）+ S4b2a 的 5 个（fa1dfc14）+ S4b2b 的 2 个（G2 / G3）+ S4c-1 的 27 个 + S4c-2 的 4 个（c2288509）+ S4d-1 的 17 个（43e461be）+ S4d-2 的 15 个（92e4350f）+ S4d-3 的 11 个（a88c1c2f）+ S4d-4 的 12 个（9e5df4f8）+ S4d-5 的 10 个，共 123 个；S6b 追加 verify-html-fingerprint-e2e.js 1 个，共 124 个。
 * 未登记：verify-issue-lite-void-migration.js / verify-periodic-push.js（没有 ready，按各自现有分类处理）；verify-issue-notify-v1740.js（纯函数、无 I/O）/ test-collab-resume.js（直接调启动器、不经 test-env）落「其他」类，须 Tier-1 零命中。
 */
const MIGRATED = Object.freeze({
    'test-codex-perm-e2e.js': Object.freeze({}),
    'test-requester-done-creator-visibility-playwright.js': Object.freeze({}),
    'test-sys-config-hide-playwright.js': Object.freeze({}),
    'verify-collab-attach-archive.js': Object.freeze({}),
    'verify-correction-creator-e2e.js': Object.freeze({}),
    'verify-dingtalk-file-helper.js': Object.freeze({}),
    'verify-issue-lite-archive-keeps-completion.js': Object.freeze({}),
    'verify-issue-lite-d4.js': Object.freeze({}),
    // S4b1（12）
    'smoke-legacy-archive-ui.js': Object.freeze({}),
    'test-issue-lite-c4-playwright.js': Object.freeze({}),
    'test-issue-lite-d5-playwright.js': Object.freeze({}),
    'test-sys-config-flow-playwright.js': Object.freeze({}),
    'verify-h0-metadata-e2e.js': Object.freeze({}),
    'verify-issue-lite-c1.js': Object.freeze({}),
    'verify-issue-lite-c2.js': Object.freeze({}),
    'verify-issue-lite-completed.js': Object.freeze({}),
    'verify-issue-lite-d3.js': Object.freeze({}),
    'verify-issue-lite-search.js': Object.freeze({}),
    'verify-issue-lite-void.js': Object.freeze({}),
    'verify-quick-log.js': Object.freeze({}),
    // S4b2a（5）
    'test-model-catalog-baseline-playwright.js': Object.freeze({}),
    'test-model-catalog-playwright.js': Object.freeze({}),
    'test-model-workbench-baseline-playwright.js': Object.freeze({}),
    'test-model-workbench-playwright.js': Object.freeze({}),
    'test-sys-attachment-trace-playwright.js': Object.freeze({}),
    // S4b2b（2）
    'test-collab-external-source-playwright.js': Object.freeze({}),
    'verify-collab-external-source.js': Object.freeze({}),
    // S4c-1（27）：协作 18 个（A1 10 + A2 8）+ 需求跟踪 / 数据修正等 9 个（B）。verify-issue-notify-v1740.js 是纯函数、无 I/O，不登记（落「其他」类）
    'test-collab-archive-final-e2e.js': Object.freeze({}),
    'test-collab-attachment-owner-lock-e2e.js': Object.freeze({}),
    'test-collab-create-chat-e2e.js': Object.freeze({}),
    'test-collab-bypass-e2e.js': Object.freeze({}),
    'test-collab-friction-e2e.js': Object.freeze({}),
    'test-collab-multi-level-link-e2e.js': Object.freeze({}),
    'test-collab-template-e2e.js': Object.freeze({}),
    'test-collab-two-level-e2e.js': Object.freeze({}),
    'verify-collab-multifile-datascope.js': Object.freeze({}),
    'test-collab-admin-fix-e2e.js': Object.freeze({}),
    'test-admin-direct-e2e.js': Object.freeze({}),
    'test-collab-return-to-dev-e2e.js': Object.freeze({}),
    'test-collab-three-level-forward-e2e.js': Object.freeze({}),
    'test-collab-submit-export-e2e.js': Object.freeze({}),
    'test-collab-viewer-exporter-e2e.js': Object.freeze({}),
    'test-notify-requester-done-e2e.js': Object.freeze({}),
    'verify-collab-admin-close-exporting.js': Object.freeze({}),
    'verify-collab-direct-close-no-file.js': Object.freeze({}),
    'test-issue-c3-smoke.js': Object.freeze({}),
    'test-issue-c4-smoke.js': Object.freeze({}),
    'test-issue-c4a-smoke.js': Object.freeze({}),
    'test-issue-c5-smoke.js': Object.freeze({}),
    'test-issue-v1750-c4-chat-e2e.js': Object.freeze({}),
    'verify-issue-creator-edit.js': Object.freeze({}),
    'verify-issue-lite-creator-edit.js': Object.freeze({}),
    'verify-correction-creator-edit.js': Object.freeze({}),
    'test-sys-cross-phase-smoke.js': Object.freeze({}),
    // S4c-2（4）：test-collab-resume.js 直接调启动器、不经 test-env，不登记（落「其他」类，须 Tier-1 零命中）
    'verify-correction-e2e-http.js': Object.freeze({}),
    'verify-correction-relay-e2e.js': Object.freeze({}),
    'verify-legacy-archive-api.js': Object.freeze({}),
    'verify-uploads-guard.js': Object.freeze({}),
    // S4d-1（17）：Playwright 的 D-A 11 个（粘贴 / 附件选择 / 上传预览 / 模型中心 / 通知已读 / 统一样式）+ D-B 6 个（协作单显示与终态通知、issue-lite 粘贴与附件，直连实例库）
    'test-collab-data-scope-display-playwright.js': Object.freeze({}),
    'test-collab-direct-close-c-playwright.js': Object.freeze({}),
    'test-collab-paste-playwright.js': Object.freeze({}),
    'test-collab-template-display-playwright.js': Object.freeze({}),
    'test-collab-terminal-notify-playwright.js': Object.freeze({}),
    'test-corr-paste-playwright.js': Object.freeze({}),
    'test-corr-upload-preview-playwright.js': Object.freeze({}),
    'test-issue-lite-create-attach-playwright.js': Object.freeze({}),
    'test-issue-lite-paste-playwright.js': Object.freeze({}),
    'test-issue-tracker-paste-playwright.js': Object.freeze({}),
    'test-model-c3-drawer-playwright.js': Object.freeze({}),
    'test-model-c4-views-playwright.js': Object.freeze({}),
    'test-model-c7-row-click-playwright.js': Object.freeze({}),
    'test-model-c8-dim-scd-playwright.js': Object.freeze({}),
    'test-notify-read-unify-playwright.js': Object.freeze({}),
    'test-tracker-attach-picker-playwright.js': Object.freeze({}),
    'test-unify12-sticky-playwright.js': Object.freeze({}),
    // S4d-2（15）：分组 D-C 12 个（其中已红 3 个：att-inline / issue-p2-attachment / issue-c2b-change-notify，只做环境层并登记既有红）+ D-D 3 个（admin-direct / collab-multifile-m3 / viewer-exporter）。c6d 同时在 SOURCE_READERS（并存，先例 = S4b2a 的 catalog-baseline）
    'test-admin-direct-playwright.js': Object.freeze({}),
    'test-att-inline-playwright.js': Object.freeze({}),
    'test-collab-multifile-m3-playwright.js': Object.freeze({}),
    'test-issue-c2b-change-notify-playwright.js': Object.freeze({}),
    'test-issue-c4-create-chat-playwright.js': Object.freeze({}),
    'test-issue-c6a-playwright.js': Object.freeze({}),
    'test-issue-c6b-playwright.js': Object.freeze({}),
    'test-issue-c6c-playwright.js': Object.freeze({}),
    'test-issue-c6d-notify-playwright.js': Object.freeze({}),
    'test-issue-commit-groups-playwright.js': Object.freeze({}),
    'test-issue-h1-status-perm-playwright.js': Object.freeze({}),
    'test-issue-p2-attachment-playwright.js': Object.freeze({}),
    'test-issue-p4-worknote-playwright.js': Object.freeze({}),
    'test-notify-read-hide-query-playwright.js': Object.freeze({}),
    'test-viewer-exporter-playwright.js': Object.freeze({}),
    // S4d-3（11）：D-E 类——系统迭代工期 / 快速通道徽章 / 应急上线 / 预上线标志 / 超期理由 / 派生编号 / 逐人完成、周期取数、模型中心排序、通知统一验收、统计效率 e2e
    'test-sys-effort-days-playwright.js': Object.freeze({}),
    'test-sys-fastlane-auth-badge-playwright.js': Object.freeze({}),
    'test-periodic-fetch-playwright.js': Object.freeze({}),
    'test-sys-release-c7-playwright.js': Object.freeze({}),
    'test-sys-prerelease-flags-playwright.js': Object.freeze({}),
    'test-model-center-sort-playwright.js': Object.freeze({}),
    'test-notify-unify-acceptance-playwright.js': Object.freeze({}),
    'test-statistics-efficiency-e2e.js': Object.freeze({}),
    'test-sys-eta-overrun-reason-playwright.js': Object.freeze({}),
    'test-sys-derive-numbering-playwright.js': Object.freeze({}),
    'test-sys-perdev-done-playwright.js': Object.freeze({}),
    // S4d-4（12）：D-F 类——系统迭代粘贴 / 估时生成 / 缺陷暂缓 / 对接人测试 / 上线管理 / 验收凭证 / 提交撤回 / 上线后验收失败备注 / 待我处理 / 快速通道，快捷日志，附件归档前端
    'test-sys-paste-playwright.js': Object.freeze({}),
    'test-quick-log-playwright.js': Object.freeze({}),
    'test-sys-eta-generation-playwright.js': Object.freeze({}),
    'test-sys-bug-hold-frontend-playwright.js': Object.freeze({}),
    'test-sys-liaison-test-frontend-playwright.js': Object.freeze({}),
    'test-sys-release-mgmt-playwright.js': Object.freeze({}),
    'test-attach-archive-frontend-playwright.js': Object.freeze({}),
    'test-sys-accept-evidence-playwright.js': Object.freeze({}),
    'test-sys-submit-withdraw-playwright.js': Object.freeze({}),
    'test-sys-post-release-accept-fail-note-playwright.js': Object.freeze({}),
    'test-sys-my-pending-playwright.js': Object.freeze({}),
    'test-sys-fastlane-playwright.js': Object.freeze({}),
    // S4d-5（10）：D-G 类——上线面板 C2b2 / 受理对接人 / 上线逾期 / 提交修订 / 上线改期 / 详情体验 / commit 列、徽章计算（含周期任务夹具编排器）、统一视觉基线（不进批跑）
    'test-sys-release-panel-c2b2-playwright.js': Object.freeze({}),
    'test-sys-intake-liaison-playwright.js': Object.freeze({}),
    'test-sys-release-overdue-playwright.js': Object.freeze({}),
    'test-sys-submit-amend-playwright.js': Object.freeze({}),
    'test-sys-release-date-change-playwright.js': Object.freeze({}),
    'test-sys-detail-ux-playwright.js': Object.freeze({}),
    'test-sys-commit-cols-playwright.js': Object.freeze({}),
    'test-badge-computed-playwright.js': Object.freeze({}),
    'run-badge-computed-with-pf-fixture.js': Object.freeze({}),
    'test-unify-visual-playwright.js': Object.freeze({}),
    // S6b（1）：页面缓存串注入的实例级检查（只读，经 test-env 起隔离实例；同时是 FAMILY 的需服务成员，不进验收批跑，见 lib/test-acceptance-batch.json 的 excluded）
    'verify-html-fingerprint-e2e.js': Object.freeze({}),
});

/** 已迁移脚本里「豁免必须调用 ready()」的（显式列出，附理由；理由本身由分析器核对：这类脚本不得有任何网络 / 库 / 进程 I/O）。原在 verify-test-env-suite.js，S4a 搬来 */
const EXEMPT_NO_READY = Object.freeze({
    'verify-dingtalk-file-helper.js': '进程内替换 global.fetch 测 helper 的请求构造与响应解析，不联网、不开库、不起服务',
});

/** 豁免：部署维护 / 演示 / 探针类，不是测试（不扫内容）。值 = 登记理由（必填，非空白） */
const EXEMPT = Object.freeze({
    '_seed-collab-external-source.js': '本地一次性造数 / 配置 / 查询工具',
    '_set-sys-single-commit-group.js': '本地一次性造数 / 配置 / 查询工具',
    'backfill-notify-read-time-format.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'backfill-sys-datetime-seconds.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'backfill-sys-deadlock-reopen-round.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'backfill-sys-derive-root-seq.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'backfill-sys-dev-assignee-round.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'create_amount_metrics.js': '运维脚本，直连生产 192.168.1.100:3000，不是测试',
    'demo-seed-release-unify.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'fix-misclassified-superseded.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'fix-sql-validated-at-timezone.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'import-it-discovery-preview.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'import-legacy-archive.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'list-real-names.js': '本地一次性造数 / 配置 / 查询工具',
    'make-dc-ui-fixtures.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'migrate-commit-component-swap.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-correction-datafix-backfill-v2.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-correction-datafix-backfill.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-issue-lite-datadev-backfill.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-issue-lite-prod-reset.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-model-config-rev.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-model-table-comment.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-release-executors.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'migrate-sys-issues-drop-config-release-check.js': '对真实库或源码的一次性维护 / 迁移脚本，故意作用于真实环境',
    'probe-assign-mode-history.js': '只读排查探针，作用于真实本地库 / 生产库：部署后 scp 到生产跑 assign_mode 合法性与索引巡检，查询全是 SELECT，但用默认（读写 + 库文件不存在即新建）模式打开库，库不存在时会新建空文件，不进测试体系（S4e-4 由同名 verify- 脚本改名而来，EXEMPT 禁止 verify- 前缀）',
    'probe-contact-response.js': '只读排查探针，作用于真实本地库',
    'probe-dingtalk-chat-add-user.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-chat-create.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-ding-send.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-disband.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-todo-create.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-todo-permission.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dingtalk-unionid.js': '钉钉接口探针，故意用真实凭证调真实钉钉',
    'probe-dispatch-batch-pattern.js': '只读排查探针，作用于真实本地库',
    'probe-getuserid-by-mobile.js': '钉钉接口探针，故意用真实凭证调真实钉钉（读本地库取凭证，反查 userid）',
    'probe-my-pending-platform-admin.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'probe-notify-read-diagnosis.js': '只读诊断探针：默认纯库内 SELECT；--live 追加钉钉 readStatus 外呼（只读 API，不发消息不写库），作用于真实本地库',
    'probe-release-schedule-badge.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'probe-result-attachment-owner-consistency.js': '只读排查探针，作用于真实本地库 / 生产库：每月初跑一次的监控脚本（OPEN_READONLY，未解释项时退出码 1），也可 scp 到生产跑，不进测试体系（S4e-4 由同名 verify- 脚本改名而来，EXEMPT 禁止 verify- 前缀）',
    'probe-result-data-active-uniqueness.js': '只读排查探针，作用于真实本地库',
    'probe-s1-paste-thumb.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'probe-sys-deadline-normalize.js': '只读排查探针，作用于真实本地库',
    'seed-issue-lite-demo.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'snapshot-model-gate-contract.js': '用于演示或观察环境，不是测试；用夹具的已 fail-closed（FX_NOT_READY），需要时另行重做',
    'sys-multidev-c0-reset.js': '多开发者演示环境重置工具，故意改本地库',
});

/** 测试基础设施本身，或隔离机制自己的测试（不扫内容）。值 = 登记理由（必填，非空白） */
const INFRA = Object.freeze({
    '_test-fixture.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    '_test-it-asset-ledger-server-wrapper.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'run-test-batch.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'run-verify-family.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-instance-config-keys.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-instance-external.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-instance-mode.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-instance-startup.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-merge.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-new-remove-suite.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-new-remove.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-run-suite.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-run.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-lines-state.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-batch-suite.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-batch.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-env-suite.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-env.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-instance-suite.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
    'verify-test-instance.js': '测试基础设施本身，或隔离机制自己的测试，内容里故意出现真实库路径 / 3000 / .env 用于负向用例',
});

/**
 * 只读 server.js 源码做静态断言、不启动服务的脚本（附加属性：可与 MIGRATED / 基线 / 其他并存，不能与 EXEMPT / INFRA 并存）。值 = 登记理由（必填，非空白）。
 * 效果：这类文件里**sink 外**的 server.js 字符串字面量不算 T3 / R3；sink（spawn / spawnSync / fork / exec / execSync / execFile / execFileSync 的实参）与 require / require.resolve / import() 实参里的起主服务字符串照旧判 T3 / R3。
 * 硬门（修复批 2）：登记了的文件必须至少有一处 sink 外的 server.js 字面量，否则判过期（STALE）；且不得 require('child_process') / import('child_process')（含 node: 前缀与解构）、不得有任何 sink 调用（成员调用 X.exec(…) 只在文件 require 了 child_process 时才算，正则的 re.exec(…) 不算），出现即判红 SPAWN。
 * 约定（修复批 3）：登记文件读 server.js 源码时用 path.join 拼路径；require.resolve 与 require / import() 一样算 sink 内（不豁免）。命令串（`node ./server.js …`）在 sink 实参里一律判 T3，登记也不豁免。
 * 初始名单由 S4a 的工具从扫描集合生成，生成条件就是上面这几条（有 sink 外字面量、没有 sink 内字面量、不 require child_process、没有 sink 调用）。
 */
const SOURCE_READERS = Object.freeze({
    'test-collab-bypass-e2e.js': '只读 server.js 源码做静态断言，不启动服务',
    'test-issue-c6d-notify-playwright.js': '只读 server.js 源码做静态断言，不启动服务',
    'test-issue-v1750-c4-chat-e2e.js': '只读 server.js 源码做静态断言，不启动服务',
    'test-model-catalog-baseline-playwright.js': 'checkBackendSearchFields 两处用 path.join(ROOT, \'server.js\') 读源码做「后端搜索字段」核对；不自起 server.js（隔离实例经 test-env 启动）；文件没有 require child_process',
    'verify-badge-alias.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-collab-attach-archive-static.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-collab-dingtalk-sendok.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-collab-expected-notify.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-collab-validation-status-coverage.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-correction-attach-archive-static.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-db-connections-writers.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-export-columns.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-html-asset-fingerprint.js': '读 server.js 里 public 静态挂载那一段的原文并在 vm 里执行（setHeaders 取原文而非照抄），再静态核对注入中间件挂载在它之前且只挂一次；被测中间件是进程内 express + 系统临时目录里的临时 publicDir，不启动 server.js，文件没有 require child_process；vm 执行 server.js 片段的先例 = verify-it-reconcile-r4-cases.js',
    'verify-html-fingerprint-browser.js': '读 server.js 里 public 静态挂载那一段的原文并在 vm 里执行（setHeaders 取原文而非照抄）；被测中间件是进程内 express（回环端口）+ 系统临时目录里的临时 publicDir / 仓库 public 的逐文件复制，浏览器由 Playwright 库内部启动 Chromium，不启动 server.js、不碰库；本文件不 require child_process；先例 = verify-html-asset-fingerprint.js（vm 读 static 段）与 test-model-catalog-baseline-playwright.js（Playwright 脚本已在 SOURCE_READERS）',
    'verify-issue-creator-edit.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-issue-lite-creator-edit.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-it-reconcile-r4-cases.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-model-restore-api.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-notify-read-endpoints.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-readonly-leader-exporter-block.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-record-quality-for-developer-submit.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-server-js-growth.js': '只 readFileSync 一次 server.js 原文（path.join 拼路径）做正则计数，核对端点数 / 建表数 / 绕过写法的计数等于写死的基线（#106 S13 / W6 止增长守卫）；不 require child_process、无 sink 调用、不起服务、不开库；--file 变异副本由调用方给路径，自证全部在内存里对原文做变异',
    'verify-sys-expiry-sweep-lifecycle.js': '只读 server.js 源码做静态断言，不启动服务',
    'verify-sys-liaison-test.js': '只读 server.js 源码做静态断言，不启动服务',
});

/**
 * 自带隔离机制的套件（S4b2b，锚点 §9b U7 = A）：不走 test-env，自己把源码复制到临时根、用空库建 schema、经副本里的 wrapper 起被测服务，或只对临时 sqlite 文件跑种子脚本。
 * 附加属性：可与 MIGRATED 并存（G2 既用 test-env 起隔离实例、又自带种子脚本黑盒用例）；不能与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线并存（红码 SELF_ISOLATED|CONFLICT）。值 = 登记理由（必填，非空白）。
 * 守卫对登记文件的硬规则（确定性规则，不做智能放行；全文见 verify-test-isolation-static.js 头注释）：
 *   · 只登记 SELF_ISOLATED 的文件按「其余」口径：Tier-1（T1–T5）全部零命中，T4 也必须为零（用了 test-env 就该登记 MIGRATED）；MIGRATED + SELF_ISOLATED 按 MIGRATED 口径（分析器 R1–R7 + Tier-1 补充命中）；
 *   · 起进程只许三种形态：起 node 且第一个脚本参数是 __filename（自调用）/ path.join(<非 __dirname>, 'scripts', '_test-it-asset-ledger-server-wrapper.js')（恰 3 个实参）/ path.join(__dirname, '_seed-*.js')（恰 2 个实参，文件名须在扫描集合里）；taskkill / powershell / git 放行；
 *     exec / execSync / fork 与其余形态一律红（SELF_ISOLATED|SPAWN_FORM）；child_process 只许 const { spawn, spawnSync, execFile, execFileSync } = require(…)（const + 语法简写）一种绑定，绑定出的名字只许作被调用，child_process 字符串字面量只许出现在这个声明里，不许用 worker_threads / cluster（SELF_ISOLATED|BINDING）；
 *   · 残余：wrapper 只保证库被重定向（IA_TEST_DB_PATH 必填 + 三层比对），不管 .env、uploads、外呼；F2 的第一个实参若解析到检出目录（如 ROOT），起的是检出目录的代码，守卫看不到——与非 SI 文件现状相同；
 *   · T3 只豁免「sink 外、require 类实参外、普通字符串字面量且值恰为 'server.js'」一种（读副本源码 / 变异规格用）；
 *   · 必须至少有一处被豁免的字面量、且 require 了 child_process，否则判过期（SELF_ISOLATED|STALE）。
 */
const SELF_ISOLATED = Object.freeze({
    'verify-collab-external-source.js': '隔离实例由 test-env 起；另在 os.tmpdir() 的独立 sqlite 文件上直接 spawn 种子脚本做黑盒用例（只经 path.join(__dirname, \'_seed-…\') 起 node，库路径与 --allow-db-override 成对，运行时断言挡住落到种子脚本默认库的组合）；读检出目录里的 server.js 源码做静态哨兵',
    'verify-model-config-rev-http.js': '把源码复制到临时根、空库由被测代码自建 schema、经副本里的 wrapper 起服务；服务进程带 net-guard 预加载拦非回环网络；也是 impl-objects / list-extras / relations 三个套件的共享助手',
    'verify-model-impl-objects.js': '借 verify-model-config-rev-http.js 的助手在临时根起源码副本服务（空库）；种子脚本只指向临时库（TARGET_DB 与 --allow-db-override 成对）；变异用例自调用本文件',
    'verify-model-impl-verify.js': '借 verify-model-config-rev-http.js 的助手把源码复制到临时根，被测实现对象模块在本进程内以工厂构造、挂在回环端口的 express 上；库是临时目录里的夹具 sqlite 文件（实现对象两表与唯一索引从副本 server.js 的建表 SQL 抠出，其余三张辅助表在测试里手写最小结构），读生产定义的 SQL Server 查询层全用桩；变异用例自调用本文件',
    'verify-model-list-extras.js': '借 verify-model-config-rev-http.js 的助手在临时根起源码副本服务（空库）；变异用例自调用本文件',
    'verify-model-relations.js': '借 verify-model-config-rev-http.js 的助手在临时根起源码副本服务（空库）；变异用例自调用本文件',
});

/**
 * 预留：合法地「提到」业务库路径字面量、但不以 sqlite 打开它的脚本（只读算业务库指纹证明「没被碰」、比对维护脚本默认路径常量、作为「禁止指向它」的防呆目标）。值 = 登记理由。
 * **修复批 2 起守卫硬门：本名单必须为空，非空即判红 DB_PATH_ASSERTERS|NOT_EMPTY。** 豁免的判据设计（含「打开」的判定）等第一批真实登记文件出现时与它们一起设计、送审，这里不预先放行。
 */
const DB_PATH_ASSERTERS = Object.freeze({
});

module.exports = { MIGRATED, EXEMPT_NO_READY, EXEMPT, INFRA, SOURCE_READERS, SELF_ISOLATED, DB_PATH_ASSERTERS };
