/**
 * 统计中心·效率统计 计算 helper（依赖注入 DB，无 express 依赖）
 *
 * 方案：docs/local/统计中心/统计中心效率统计_方案_20260710_v1.0.md
 *   + 用户执行中两次追加口径（凌驾方案 §二四阶段表）：
 *   ① 阶段①="创建→开发响应"（回填预计动作时刻，缺失走 fallback 链）+ byType 类型细分
 *   ② 三段口径统一（响应/开发/收尾，标签沿用「开发响应/处理中/验收归档」）+ 聚合层仅完结单 +
 *      平均值口径——三段平均严格可加=总平均（同批 done 样本 + 每单三段全非空），卡片堆叠条
 *      数学自洽。不变量（verify-statistics-efficiency.js 专项断言）：
 *        · 每张完结单 raw stage1+stage2+stage3 === totalHours（浮点容差 1e-6）
 *        · 每模块（及每 byType 组）Σ stageStats[i].avg ≈ totalStats.avg（round1 后容差 0.21）
 *
 * 三段边界（四模块统一为"边界差值"模型，t0→t1→t2→t3，取"最早进入"）：
 *   t0 创建 = created_at
 *   t1 响应 = 回填预计动作时刻：
 *        correction = 首次进入 IN_PROGRESS（回复预计动作把单推进到修正中）
 *        issue      = 首次进入 处理中（无回填概念，接单即响应信号）
 *        collab     = collab_operation_logs MIN(created_at) WHERE operation_type='dev_estimate_reply'
 *                     （dev_estimated_at 字段只存承诺的未来日期，动作时刻在 op log；该功能
 *                      2026-07-09 才上线，生产仅 1/51 有记录，多数单走 fallback）
 *        sys        = sys_issue_timeline MIN(created_at) WHERE event_type IN ('estimate','feasibility')
 *                     （核实发现：needs_feasibility 单回填走 feasibility 事件不写 estimate，
 *                      单查 estimate 漏 4/10 单，双源后与 dev_estimated_at populated 数精确对上）
 *                     [组A预筛修复批2·MED-3 登记，2026-08-12] 系统迭代"组 A"上线后两条口径变化，均已
 *                     核实但暂不改动本文件公式，登记待统计期重新核定（锚点 P6 已登记）：
 *                     ① /reassign 端点的超时指派留痕行已改 event_type='note'、action_code=
 *                        'assign_overdue_eta'（不再是 'estimate'），本条 WHERE 子句不含 'note'，
 *                        故该行**有意不计入** t1 响应源——它是"改派时补填/更正 ETA"的留痕，语义上不
 *                        代表"开发首次响应"，与 t1 的定义（回填预计动作时刻）不是同一件事，非遗漏。
 *                     ② 组 A 起 intake_accept（受理）会自动生成/强制 dev_estimated_at，第 1 轮闸门
 *                        （submit/set-scheduled-start 等）恒满足，开发因此可能全程不再主动调用
 *                        /estimate 端点——该单本文件的 t1 会读不到 'estimate'/'feasibility' 事件，
 *                        走 fallback 链吸收（响应段并入提交时刻、开发段=0），不代表"响应耗时为 0"这
 *                        件事真的发生了，只是数据源缺失时的既有兜底行为。此二条均为 2026-08-12 之后
 *                        新单据才会命中，存量单据不受影响。
 *   t2 提交 = correction=首次进入 FIXED / issue=首次进入 待验证 / collab=首次 submitted_at /
 *        sys=sys_issue_timeline 首次 event_type='status_change' AND to_status='待验证' 的时刻
 *        （= GATE 时刻：多开发单以「在册全完成」为准，非"首个人提交"；与 issue 模块"首次进入
 *        待验证"同构。first_submitted_at 保留自己的审计语义不变——它是"首次有人提交"的旁证，
 *        不再充当本文件 t2 边界的数据源。2026-07-17 C3 对抗审 M-P3 回填，既有 fallback 链
 *        （fillSkippedBoundaries 右侧兜底）不变：老单无 status_change 记录时一路吸收到 t3）
 *   t3 归档终态 = correction/issue=末条 history 行（终态）时刻 / collab=archived_final_at||done_at /
 *        sys=closed_at||released_at（closed_at 生产 0 populated，已上线即视为交付）
 *
 * fallback 链（用户口径："预计时间没有就用实际完成时间"）：
 *   fillSkippedBoundaries 用右侧最近非空边界填平中间缺口——响应缺失 → 响应段吸收到提交时刻、
 *   开发段=0；提交也缺失 → 一路吸收到归档终态。末尾真缺口（在途单）留给 frontierEnd。
 *
 * 计数分组：done（到达归档终态）→ 进聚合平均 + 月度趋势；inflight（在途）→ 仅计数 + 明细层
 * （D4"看积压在哪段"由明细层承担，聚合层不混样本）；aborted（拒绝/作废/暂缓/撤销）→ D1 排除
 * 主统计，计数保留供前端卡片副行。
 *
 * 三段简化的已知语义变化（相对首版四阶段区间桶模型，用户口径拍板接受）：
 *   correction 返工（FIXED→REFIXED→FIXED）时间折入"验收归档"段（t2=首次 FIXED 后全算收尾）；
 *   issue 重开/暂缓恢复的中间区间同理折入所在边界之后的段——换来可加性由构造保证。
 *
 * 编码前置核实（方案硬约束）遗留有效结论：
 *   - collab archived_at = 撤销/软删除时间戳（≠归档完成），archived_final_at 才是归档锁定；
 *   - correction correction_type 是唯一受控枚举（single/batch），process_type 自由文本 0 populated。
 */
'use strict';

// ============================================================
// 通用数学 helper
// ============================================================

/** 中位数（月度趋势沿用；聚合卡片口径已转平均）。空数组返回 null。 */
function median(nums) {
    const arr = (nums || []).filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((a, b) => a - b);
    if (arr.length === 0) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** 平均数。空数组返回 null。 */
function average(nums) {
    const arr = (nums || []).filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** 四舍五入到 1 位小数（对齐既有 /api/statistics/* 端点 ROUND(...,1) 惯例）。null 直通。 */
function round1(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    return Math.round(n * 10) / 10;
}

/**
 * 两个 SQLite 本地时间字符串（'YYYY-MM-DD HH:MM:SS'）之间的小时差。
 * ⚠️ 返回 raw 浮点不四舍五入——三段可加性不变量要求内部全程 raw，只在序列化出口 round1。
 */
function hoursBetween(startStr, endStr) {
    if (!startStr || !endStr) return null;
    const start = new Date(String(startStr).replace(' ', 'T'));
    const end = new Date(String(endStr).replace(' ', 'T'));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return (end.getTime() - start.getTime()) / 3600000;
}

// ============================================================
// 三段边界模型核心（纯函数）
// ============================================================

// 三段统一标签（四模块同构；用户拍板沿用现有标签，语义 = 响应/开发/收尾）
const THREE_STAGE_LABELS = ['开发响应', '处理中', '验收归档'];

/**
 * fallback 链通用实现："阶段边界事件缺失时，按下一个可得的生命周期事件兜底"。
 * 中间缺口（右侧已有更晚的非空边界）说明该步骤被跳过 → 用右侧最近非空值填平（该段耗时
 * 归零、缺口时间并入左侧已知区间）；末尾缺口（右侧再无值）是"真未到达"，保持 null 交给
 * frontierEnd（在途单累计到 now / 异常终止单累计到终止时刻）。
 */
function fillSkippedBoundaries(boundaries) {
    const filled = boundaries.slice();
    let nextNonNull = null;
    for (let i = filled.length - 1; i >= 1; i--) {
        if (filled[i] != null) {
            nextNonNull = filled[i];
        } else if (nextNonNull != null) {
            filled[i] = nextNonNull;
        }
    }
    return filled;
}

/**
 * 边界单调化护栏：跨源时间戳（op log / timeline / 主表列）极端情形下可能逆序（t1 > t2），
 * 产生负数段破坏可加性——把逆序边界推平到前一边界（该段归零），总时长仍 = 末边界 - 首边界。
 * 同格式字符串（'YYYY-MM-DD HH:MM:SS'）可直接字典序比较。
 */
function normalizeBoundaries(boundaries) {
    const out = boundaries.slice();
    for (let i = 1; i < out.length; i++) {
        if (out[i] != null && out[i - 1] != null && out[i] < out[i - 1]) out[i] = out[i - 1];
    }
    return out;
}

/**
 * 基于边界数组计算相邻段耗时（raw 不 round）。
 * @param {(string|null)[]} boundaries 已 fill+normalize 的边界（boundaries[0] 非空）
 * @param {?string} frontierEnd 在途单传 now / 异常终止单传终止时刻 / done 单传 null
 * @returns {(number|null)[]} 长度 = boundaries.length - 1
 */
function computeBoundaryStages(boundaries, frontierEnd) {
    const n = boundaries.length;
    const hours = [];
    let frontierUsed = false;
    for (let i = 1; i < n; i++) {
        const prev = boundaries[i - 1];
        const cur = boundaries[i];
        if (prev == null) {
            hours.push(null);
            continue;
        }
        if (cur != null) {
            hours.push(hoursBetween(prev, cur));
        } else if (frontierEnd && !frontierUsed) {
            hours.push(hoursBetween(prev, frontierEnd));
            frontierUsed = true; // 前沿段之后（更深段）保持未到达，留空
        } else {
            hours.push(null);
        }
    }
    return hours;
}

/**
 * 单条记录三段计算总入口：fill → normalize → 段差值 → 总时长。
 * done 单（t3 非空 + frontierEnd=null）：三段全非空且 s1+s2+s3 === total（可加性由构造保证）。
 * @returns {{ stageHours:(number|null)[], totalHours:(number|null) }} raw 值（未 round）
 */
function computeThreeStageRecord(t0, t1, t2, t3, frontierEnd) {
    let b = fillSkippedBoundaries([t0, t1, t2, t3]);
    b = normalizeBoundaries(b);
    const stageHours = computeBoundaryStages(b, frontierEnd);
    const totalEnd = b[3] != null ? b[3] : frontierEnd;
    const totalHours = hoursBetween(t0, totalEnd);
    return { stageHours, totalHours };
}

// ============================================================
// 模块元数据 + 状态分组常量
// ============================================================

const EFFICIENCY_MODULES = {
    correction: { label: '数据修正', stages: THREE_STAGE_LABELS },
    issue: { label: '数据开发', stages: THREE_STAGE_LABELS },
    collab: { label: '数据协作', stages: THREE_STAGE_LABELS },
    sys: { label: '系统迭代', stages: THREE_STAGE_LABELS },
};

const CORRECTION_DONE_STATUS = 'ARCHIVED';
const CORRECTION_ABORTED_STATUSES = ['REJECTED', 'VOIDED'];
const ISSUE_DONE_STATUS = '已关闭';
const ISSUE_ABORTED_STATUSES = ['已拒绝', '已暂缓'];
const SYS_ABORTED_STATUSES = ['已暂缓', '已拒绝', '已作废'];

/** 用 SQLite 自己的 datetime('now','localtime') 当"现在"，与库内其它时间戳字段同格式同基准。 */
async function getDbNowLocal(dbGetAsync) {
    const row = await dbGetAsync("SELECT datetime('now','localtime') AS now");
    return row.now;
}

// ============================================================
// DB Loader（依赖注入 dbAllAsync，不直接碰 server.js 全局 db——server 与 verify 脚本共用同一份）
// ============================================================

/**
 * 从状态历史行提取三段边界（correction/issue 通用）：
 * t1 = 首次进入 responseStatus / t2 = 首次进入 submitStatus / last = 末行（终态判定与时刻）
 */
function extractHistoryBoundaries(rows, responseStatus, submitStatus) {
    let t1 = null;
    let t2 = null;
    for (const r of rows) {
        if (t1 === null && r.to_status === responseStatus) t1 = r.created_at;
        if (t2 === null && r.to_status === submitStatus) t2 = r.created_at;
    }
    const last = rows.length ? rows[rows.length - 1] : null;
    return { t1, t2, last };
}

// ---- 数据修正：correction_requests + correction_status_history ----
// type 维度 = correction_type（single/batch 受控枚举）。返工时间折入"验收归档"段（见文件头）。
async function loadCorrectionEfficiencyRecords(dbAllAsync, startDate, endDate, nowIso) {
    let where = '';
    const params = [];
    if (startDate && endDate) {
        where = 'WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate + ' 23:59:59');
    }
    const bases = await dbAllAsync(
        `SELECT id, location_info AS title, created_at, status, correction_type AS type FROM correction_requests ${where} ORDER BY id`,
        params
    );
    if (bases.length === 0) return [];
    const ids = bases.map((b) => b.id);
    const placeholders = ids.map(() => '?').join(',');
    const historyRows = await dbAllAsync(
        `SELECT correction_request_id AS parent_id, to_status, created_at FROM correction_status_history
         WHERE correction_request_id IN (${placeholders}) ORDER BY correction_request_id ASC, created_at ASC, id ASC`,
        ids
    );
    const byParent = new Map();
    for (const row of historyRows) {
        if (!byParent.has(row.parent_id)) byParent.set(row.parent_id, []);
        byParent.get(row.parent_id).push(row);
    }
    return bases.map((b) => {
        const rows = byParent.get(b.id) || [];
        const statusGroup = CORRECTION_ABORTED_STATUSES.includes(b.status)
            ? 'aborted'
            : (b.status === CORRECTION_DONE_STATUS ? 'done' : 'inflight');
        const { t1, t2, last } = extractHistoryBoundaries(rows, 'IN_PROGRESS', 'FIXED');
        const t3 = (statusGroup === 'done' && last) ? last.created_at : null;
        const frontierEnd = statusGroup === 'inflight' ? nowIso : (statusGroup === 'aborted' ? (last ? last.created_at : null) : null);
        const { stageHours, totalHours } = computeThreeStageRecord(b.created_at, t1, t2, t3, frontierEnd);
        return {
            id: b.id, title: b.title || `#${b.id}`, created_at: b.created_at, status: b.status, type: b.type || '(未分类)',
            statusGroup, stageHours, totalHours, terminalAt: t3,
        };
    });
}

// ---- 数据开发：issues + issue_status_history ----
// type 维度 = issues.type（7 类受控枚举，落库即中文）。
async function loadIssueEfficiencyRecords(dbAllAsync, startDate, endDate, nowIso) {
    let where = '';
    const params = [];
    if (startDate && endDate) {
        where = 'WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate + ' 23:59:59');
    }
    const bases = await dbAllAsync(
        `SELECT id, title, created_at, status, type FROM issues ${where} ORDER BY id`,
        params
    );
    if (bases.length === 0) return [];
    const ids = bases.map((b) => b.id);
    const placeholders = ids.map(() => '?').join(',');
    const historyRows = await dbAllAsync(
        `SELECT issue_id AS parent_id, to_status, created_at FROM issue_status_history
         WHERE issue_id IN (${placeholders}) ORDER BY issue_id ASC, created_at ASC, id ASC`,
        ids
    );
    const byParent = new Map();
    for (const row of historyRows) {
        if (!byParent.has(row.parent_id)) byParent.set(row.parent_id, []);
        byParent.get(row.parent_id).push(row);
    }
    return bases.map((b) => {
        const rows = byParent.get(b.id) || [];
        const statusGroup = ISSUE_ABORTED_STATUSES.includes(b.status)
            ? 'aborted'
            : (b.status === ISSUE_DONE_STATUS ? 'done' : 'inflight');
        const { t1, t2, last } = extractHistoryBoundaries(rows, '处理中', '待验证');
        const t3 = (statusGroup === 'done' && last) ? last.created_at : null;
        const frontierEnd = statusGroup === 'inflight' ? nowIso : (statusGroup === 'aborted' ? (last ? last.created_at : null) : null);
        const { stageHours, totalHours } = computeThreeStageRecord(b.created_at, t1, t2, t3, frontierEnd);
        return {
            id: b.id, title: b.title || `#${b.id}`, created_at: b.created_at, status: b.status, type: b.type || '(未分类)',
            statusGroup, stageHours, totalHours, terminalAt: t3,
        };
    });
}

// ---- 数据协作：collab_requests + collab_operation_logs（响应动作时刻） ----
async function loadCollabEfficiencyRecords(dbAllAsync, startDate, endDate, nowIso) {
    let where = '';
    const params = [];
    if (startDate && endDate) {
        where = 'WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate + ' 23:59:59');
    }
    const rows = await dbAllAsync(
        `SELECT id, description AS title, created_at, status, request_type AS type,
                submitted_at, done_at, archived_at, archived_final_at
         FROM collab_requests ${where} ORDER BY id`,
        params
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const responseRows = await dbAllAsync(
        `SELECT collab_request_id AS parent_id, MIN(created_at) AS response_at
         FROM collab_operation_logs
         WHERE collab_request_id IN (${placeholders}) AND operation_type = 'dev_estimate_reply'
         GROUP BY collab_request_id`,
        ids
    );
    const responseByParent = new Map(responseRows.map((r) => [r.parent_id, r.response_at]));

    return rows.map((r) => {
        const isAborted = !!r.archived_at;
        const isDone = !isAborted && (r.status === 'DONE' || r.status === 'ARCHIVED');
        const statusGroup = isAborted ? 'aborted' : (isDone ? 'done' : 'inflight');
        const t1 = responseByParent.get(r.id) || null;
        const t3 = isDone ? (r.archived_final_at || r.done_at) : null;
        const frontierEnd = statusGroup === 'inflight' ? nowIso : (statusGroup === 'aborted' ? r.archived_at : null);
        const { stageHours, totalHours } = computeThreeStageRecord(r.created_at, t1, r.submitted_at, t3, frontierEnd);
        return {
            id: r.id, title: r.title || `#${r.id}`, created_at: r.created_at, status: r.status, type: r.type || '(未分类)',
            statusGroup, stageHours, totalHours, terminalAt: t3,
        };
    });
}

// ---- 系统迭代：sys_issues + sys_issue_timeline（响应动作时刻，estimate+feasibility 双源） ----
async function loadSysEfficiencyRecords(dbAllAsync, startDate, endDate, nowIso) {
    let where = '';
    const params = [];
    if (startDate && endDate) {
        where = 'WHERE created_at BETWEEN ? AND ?';
        params.push(startDate, endDate + ' 23:59:59');
    }
    const rows = await dbAllAsync(
        `SELECT id, title, created_at, status, type, updated_at, first_submitted_at, released_at, closed_at
         FROM sys_issues ${where} ORDER BY id`,
        params
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const responseRows = await dbAllAsync(
        `SELECT issue_id AS parent_id, MIN(created_at) AS response_at
         FROM sys_issue_timeline
         WHERE issue_id IN (${placeholders}) AND event_type IN ('estimate', 'feasibility')
         GROUP BY issue_id`,
        ids
    );
    const responseByParent = new Map(responseRows.map((r) => [r.parent_id, r.response_at]));
    // [C3 对抗审 M-P3 回填] t2（提交）改用 timeline 首次 GATE（进「待验证」）时刻，非
    // first_submitted_at（首个人提交）——多开发单两者可能相差数天，GATE 才是"全员完成"的真实
    // 提交边界，与 issue 模块"首次进入 待验证"同构；first_submitted_at 审计语义不受影响。
    const gateRows = await dbAllAsync(
        `SELECT issue_id AS parent_id, MIN(created_at) AS gate_at
         FROM sys_issue_timeline
         WHERE issue_id IN (${placeholders}) AND event_type = 'status_change' AND to_status = '待验证'
         GROUP BY issue_id`,
        ids
    );
    const gateByParent = new Map(gateRows.map((r) => [r.parent_id, r.gate_at]));

    return rows.map((r) => {
        const isAborted = SYS_ABORTED_STATUSES.includes(r.status);
        // ⭐ [C9 读点标注·方案 v1.7 §10.1 逐点标注要求] **本读点显式声明：不区分「已上线」的来源。**
        //   C9 起「已上线」有三条明示入口（[预筛 LOW-3] 组 B·SB2 新增第三条后由两条订正为三条）——批次发布
        //   （release_publish）、免上线直翻（no_commit_acceptance，零 commit 单验收通过当场翻牌）、先行上线
        //   直上（authorized_fastlane，bug 快车道授权后 submit 勾选直上）。本处 t3（归档终态）只问"这单
        //   什么时候算交付完成"，三条路径写的都是同一根 released_at 列、语义都是"业务上已生效"，故**有意
        //   合并统计、不按 online_source 分流**（authorized_fastlane 沿用同一豁免，不需要为它单独改代码，
        //   见 verify-sys-fastlane-submit.js [7e] 静态断言）。
        //   理由：交付效率看的是"从建单到用户能用上花了多久"，一个配置类需求不需要走批次并不让它交付得
        //   "更不算数"；真按来源拆开反而会让免上线单凭空少掉一段本就不存在的批次等待时间，制造两套不可比的口径。
        //   ⚠️ 若将来要按来源做分组统计，改这里之前先回 deriveOnlineSourceKind（唯一权威派生函数）取 kind，
        //     不要在本文件重新判 release_id/online_source——那会是第二份判据。
        const releasedish = r.closed_at || r.released_at;
        const isDone = !isAborted && !!releasedish;
        const statusGroup = isAborted ? 'aborted' : (isDone ? 'done' : 'inflight');
        const t1 = responseByParent.get(r.id) || null;
        const t2 = gateByParent.get(r.id) || null;
        const t3 = isDone ? releasedish : null;
        const frontierEnd = statusGroup === 'inflight' ? nowIso : (statusGroup === 'aborted' ? (r.updated_at || null) : null);
        const { stageHours, totalHours } = computeThreeStageRecord(r.created_at, t1, t2, t3, frontierEnd);
        return {
            id: r.id, title: r.title || `#${r.id}`, created_at: r.created_at, status: r.status, type: r.type || '(未分类)',
            statusGroup, stageHours, totalHours, terminalAt: t3,
        };
    });
}

const EFFICIENCY_LOADERS = {
    correction: loadCorrectionEfficiencyRecords,
    issue: loadIssueEfficiencyRecords,
    collab: loadCollabEfficiencyRecords,
    sys: loadSysEfficiencyRecords,
};

// ============================================================
// 聚合（纯函数——聚合层仅完结单，三段平均严格可加 = 总平均）
// ============================================================

/**
 * 核心统计块：stageStats/totalStats 只对完结单（到达归档终态且 totalHours 非空）计算——
 * 三段与总同批样本、每单三段全非空（fallback 后），平均严格可加；在途单只进 counts.inflight
 * 计数与明细层（D4 价值由明细层承担，聚合层不混样本拉偏可加性——2026-07-10 主会话 API 实测
 * 抓到旧口径三段 count=3/1/2 各不同、Σavg 519.7 ≠ totalAvg 272.3 的问题后修正）。
 * round1 只在此出口做：展示层三段四舍五入之和与 totalStats.avg 最多差 ±0.2（显示噪声）。
 */
function computeStatsForRecords(stageLabels, records) {
    const doneRecords = records.filter((r) => r.statusGroup === 'done' && r.totalHours != null);

    const stageStats = stageLabels.map((label, idx) => {
        const values = doneRecords.map((r) => r.stageHours[idx]).filter((v) => v !== null && v !== undefined);
        return {
            label,
            median: round1(median(values)),
            avg: round1(average(values)),
            count: values.length,
        };
    });
    const totalValues = doneRecords.map((r) => r.totalHours);
    const totalStats = {
        median: round1(median(totalValues)),
        avg: round1(average(totalValues)),
        count: totalValues.length,
    };

    const doneCount = records.filter((r) => r.statusGroup === 'done').length;
    const abortedCount = records.filter((r) => r.statusGroup === 'aborted').length;

    return {
        stageStats,
        totalStats,
        counts: {
            done: doneCount,
            inflight: records.length - doneCount - abortedCount,
            aborted: abortedCount,
            total: records.length,
        },
    };
}

/**
 * 单模块聚合：完结单口径统计块 + byType 类型细分（每组同构，"某一类任务的平均耗时"下钻）。
 * byType 为数组按 total 数量降序（保序供前端表格，非 map）。
 */
function summarizeModule(moduleKey, records) {
    const meta = EFFICIENCY_MODULES[moduleKey];
    const core = computeStatsForRecords(meta.stages, records);

    const typeMap = new Map();
    for (const r of records) {
        const t = r.type || '(未分类)';
        if (!typeMap.has(t)) typeMap.set(t, []);
        typeMap.get(t).push(r);
    }
    const byType = [...typeMap.entries()]
        .map(([type, recs]) => ({ type, ...computeStatsForRecords(meta.stages, recs) }))
        .sort((a, b) => b.counts.total - a.counts.total);

    return {
        module: moduleKey,
        label: meta.label,
        stages: meta.stages,
        ...core,
        byType,
    };
}

/**
 * 总周期月度趋势：仅 done 单，按归档终态月份分桶，各模块独立取当月中位数（保留原口径不动）。
 */
function buildTrend(perModuleRecords, moduleKeys) {
    const trendByMonth = new Map();
    for (const key of moduleKeys) {
        for (const r of perModuleRecords[key] || []) {
            if (r.statusGroup !== 'done' || !r.terminalAt || r.totalHours == null) continue;
            const month = String(r.terminalAt).slice(0, 7); // 'YYYY-MM'
            if (!trendByMonth.has(month)) {
                const empty = {};
                moduleKeys.forEach((k) => { empty[k] = []; });
                trendByMonth.set(month, empty);
            }
            trendByMonth.get(month)[key].push(r.totalHours);
        }
    }
    return [...trendByMonth.keys()].sort().map((month) => {
        const bucket = trendByMonth.get(month);
        const point = { month };
        for (const key of moduleKeys) point[key] = round1(median(bucket[key]));
        return point;
    });
}

module.exports = {
    median,
    average,
    round1,
    hoursBetween,
    THREE_STAGE_LABELS,
    CORRECTION_DONE_STATUS,
    CORRECTION_ABORTED_STATUSES,
    ISSUE_DONE_STATUS,
    ISSUE_ABORTED_STATUSES,
    SYS_ABORTED_STATUSES,
    fillSkippedBoundaries,
    normalizeBoundaries,
    computeBoundaryStages,
    computeThreeStageRecord,
    extractHistoryBoundaries,
    EFFICIENCY_MODULES,
    EFFICIENCY_LOADERS,
    getDbNowLocal,
    computeStatsForRecords,
    summarizeModule,
    buildTrend,
};
