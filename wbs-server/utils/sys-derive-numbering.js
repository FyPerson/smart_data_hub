// utils/sys-derive-numbering.js —— 系统迭代·派生单子编号「#根_序」数据层核心判定函数
//   （方案 20260813_v1.8 §15.2·S12-a 批·2026-08-14）
//
// 职责：给 sys_issues 的 derive_root_id / derive_seq（派生单自身）+ derive_seq_alloc（根单已分配最大序号）
//   三列提供**唯一权威判定实现**——启动迁移链的存量回填（routes/sys-iteration/index.js runSysMigration）
//   与独立回填脚本（scripts/backfill-sys-derive-root-seq.js）**同源调用本模块**，不各写一份（同规则禁双
//   实现，防漂移；同 issue-notify.js / dingtalk-notify.js 等既有 utils 无状态共享件先例）。verify 脚本
//   （scripts/verify-sys-derive-numbering.js）同样 require 本模块直调真实逻辑（RC-L2 防复刻漂移）。
//
// 依赖注入：本模块不持有数据库连接——全部函数以 `all(sql, params) => Promise<rows>` /
//   `get(sql, params) => Promise<row|undefined>` / `run(sql, params) => Promise<{changes,lastID}>` 三个
//   promisified 函数作为入参（index.js 用既有 dbAllAsync/dbGetAsync/dbRunAsync 原样传入；独立脚本自建
//   sqlite3.Database 连接后包一层同签名 promisify，见该脚本头部）。
//
// 取号口径（378-H2·唯一权威）：root = 现有 derive_root_id ?? 直接父 id；号码来自根单
//   derive_seq_alloc 分配计数（COALESCE(...,0)+1），不依赖 MAX(derive_seq) 重算——号码分配持久不回退，
//   派生单被硬删除后其序号永不复用（对照系数据修正模块 rework_seq 用 `MAX(rework_seq)+1`，那条口径会在
//   删除最高序号返工单后复用旧号，本模块刻意不采用，见 verify 里的"对照组"用例）。
'use strict';

const DERIVE_MAX_CHAIN_DEPTH = 50;   // 与 index.js 既有 M-1 防环阈值同源（复制常量而非 require index.js——
  // index.js 是装配依赖注入闭包的工厂函数，脚本是独立进程，同 backfill-sys-deadlock-reopen-round.js
  // electRepresentativeInline「复刻而非复用」先例：数值本身极不易变，复制的漂移风险远低于引入循环依赖）

// ── 单点：沿 origin_issue_id 链回溯求根（origin_issue_id IS NULL 的那个祖先）──────────────────────
//   rowId=待求根的派生单自身 id；firstOriginId=该行当前的 origin_issue_id（调用方保证非空才调本函数）。
//   返回 { ok:true, root, depth } 或 { ok:false, code, detail }；code ∈
//   SELF_REFERENCE / CYCLE / CHAIN_TOO_DEEP / BROKEN_CHAIN（含"根不存在"——链顶引用的祖先行不存在，
//   与链中段引用缺失是同一失败形态，统一归类，detail 文本区分具体是哪一跳缺失）。
async function walkDeriveChainRoot(get, rowId, firstOriginId) {
  const rid = Number(rowId);
  if (firstOriginId === null || firstOriginId === undefined) {
    return { ok: false, code: 'BROKEN_CHAIN', detail: `#${rid} origin_issue_id 为空，非派生单，不应调用求根` };
  }
  const firstOriginNum = Number(firstOriginId);
  if (firstOriginNum === rid) {
    return { ok: false, code: 'SELF_REFERENCE', detail: `#${rid} 自引用（origin_issue_id 指向自身）` };
  }
  const path = [rid];
  let cursor = firstOriginNum;
  let depth = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (path.includes(cursor)) {
      return { ok: false, code: 'CYCLE', detail: `#${rid} 血缘链成环（路径：${path.join('→')}→${cursor}）` };
    }
    path.push(cursor);
    depth++;
    if (depth > DERIVE_MAX_CHAIN_DEPTH) {
      return { ok: false, code: 'CHAIN_TOO_DEEP', detail: `#${rid} 血缘链过深（>${DERIVE_MAX_CHAIN_DEPTH}，路径样本：${path.slice(0, 6).join('→')}...）` };
    }
    const parentRow = await get('SELECT id, origin_issue_id FROM sys_issues WHERE id = ?', [cursor]);
    if (!parentRow) {
      return { ok: false, code: 'BROKEN_CHAIN', detail: `#${rid} 血缘链断裂：祖先 #${cursor} 不存在（可能已被删除或从未存在）` };
    }
    if (parentRow.origin_issue_id === null || parentRow.origin_issue_id === undefined) {
      return { ok: true, root: cursor, depth };
    }
    cursor = Number(parentRow.origin_issue_id);
  }
}

// ── 全库只读分类扫描：区分「待首次回填」「已回填稳态」与「各类熔断违例」──────────────────────────
//   一次遍历完成两件事（比"先写后查"更保守——任一类违例存在即不写任何东西，见模块头部说明）：
//     ① 待回填候选（origin_issue_id 非空 ∧ root/seq 双空 ∧ 链可求根）—— 379-H4' 合法未回填类别，非异常；
//     ② 已回填稳态复核（root/seq 双非空）——只验根链一致 + seq 正整数（不要求稠密名次，空洞合法）。
//   violations 各桶收集 { id, ...detail }，供迁移链/脚本拼熔断文案 + 输出具体 issue id 清单。
async function classifySysDeriveNumbering(all, get) {
  // [预筛 M1] ORDER BY id——把 toBackfill/alreadyFilled 的输入序从「碰巧的 rowid 物理序」变成结构性确定
  // （SQLite 无 ORDER BY 时的返回序不受任何契约保证，虽历史上多与 rowid 一致，但不能拿"历史上如此"当
  // 不变量）；下游 planFirstBackfillAssignments 的族内排序另有独立的 (created_at,id) comparator，本行
  // 只保证"喂给它的原始行序"本身可复现，双保险不冗余（comparator 是族内排序，这里是全表扫描序）。
  // [预筛 H2] 补 derive_seq_alloc——mixedFamily 检测需要判断"族根是否已初始化过 alloc"，仅凭
  // alreadyFilled/toBackfill 两个派生集合看不到根行自身这一列的值（根行本身从不进这两个集合）。
  const rows = await all('SELECT id, origin_issue_id, derive_root_id, derive_seq, derive_seq_alloc, created_at FROM sys_issues ORDER BY id', []);
  const violations = {
    halfFilled: [], selfReference: [], cycle: [], chainTooDeep: [], brokenChain: [],
    wrongRoot: [], seqNonPositive: [], mixedFamily: [],
  };
  const toBackfill = [];      // { id, root, created_at }
  const alreadyFilled = [];   // { id, root, seq }

  for (const row of rows) {
    const hasRoot = row.derive_root_id !== null && row.derive_root_id !== undefined;
    const hasSeq = row.derive_seq !== null && row.derive_seq !== undefined;
    const isDerived = row.origin_issue_id !== null && row.origin_issue_id !== undefined;

    if (hasRoot !== hasSeq) {
      // 半填：root/seq 仅一列非空——首次回填原子性下结构性不应出现，出现即熔断（数据被绕过本模块直连写入）。
      violations.halfFilled.push({ id: row.id, derive_root_id: row.derive_root_id, derive_seq: row.derive_seq });
      continue;
    }
    if (!isDerived) {
      // 非派生单（origin_issue_id 空）不应有 root/seq——只有派生单才该有这两列（根单自身恒为 NULL，
      // 根单的"号码"体现在 derive_seq_alloc，不体现在 derive_root_id/derive_seq 上）。
      if (hasRoot && hasSeq) {
        violations.halfFilled.push({
          id: row.id, derive_root_id: row.derive_root_id, derive_seq: row.derive_seq,
          note: '非派生单（origin_issue_id 为空）不应有 derive_root_id/derive_seq',
        });
      }
      continue;
    }
    // 到这里：isDerived=true 且 hasRoot===hasSeq
    if (!hasRoot) {
      // ② 379-H4'：合法未回填候选——走链求根
      const walk = await walkDeriveChainRoot(get, row.id, row.origin_issue_id);
      if (!walk.ok) {
        const bucket = walk.code === 'SELF_REFERENCE' ? 'selfReference'
          : walk.code === 'CYCLE' ? 'cycle'
          : walk.code === 'CHAIN_TOO_DEEP' ? 'chainTooDeep' : 'brokenChain';
        violations[bucket].push({ id: row.id, detail: walk.detail });
      } else {
        toBackfill.push({ id: Number(row.id), root: Number(walk.root), created_at: row.created_at });
      }
    } else {
      // 已回填稳态：seq 正整数 + 根链一致（重算 origin 链求根，与存量 derive_root_id 比对）
      const seqNum = Number(row.derive_seq);
      if (!Number.isInteger(seqNum) || seqNum <= 0) {
        violations.seqNonPositive.push({ id: row.id, derive_seq: row.derive_seq });
      }
      const walk = await walkDeriveChainRoot(get, row.id, row.origin_issue_id);
      if (!walk.ok) {
        violations.brokenChain.push({ id: row.id, detail: `稳态根链重算失败：${walk.detail}` });
      } else if (Number(walk.root) !== Number(row.derive_root_id)) {
        violations.wrongRoot.push({ id: row.id, stored_root: row.derive_root_id, recomputed_root: walk.root });
      }
      alreadyFilled.push({ id: Number(row.id), root: Number(row.derive_root_id), seq: seqNum });
    }
  }

  // [预筛 H2] mixedFamily 检测——按 root 聚合，找出"同一族里既有已填成员（或族根 alloc 已初始化）
  // 又有待回填候选"的混杂态。§15.2 只定义了两种族态：全空族（首次回填对象）与已填稳态（只读复核对象）
  // ——没有第三种"半新半旧"的续号态。此前 planFirstBackfillAssignments 的"续号"设计会把这类混杂态
  // 当成正常输入自动继续赋号，属于方案未定义行为下的自作主张修复；本模块的一贯哲学是"异常不自动猜测
  // 修复，出清单交人工核实"（同半填/自引用等其余违例类别），混杂族必须同等对待——熔断，不续填。
  //   触发条件（root 上任一成立即算混杂）：
  //     ① 该 root 下 alreadyFilled 非空（已有正确完整回填过的成员）
  //     ② 该 root 行自身 derive_seq_alloc 非空（哪怕暂时没有 alreadyFilled 成员——alloc 已初始化本身
  //        就说明这个族不是"全空"，可能是运行时已通过 insertDerivedSysIssue 正常派生过、只是那些子单
  //        后来被物理删除了，family 表面看起来又"全空"但 alloc 记忆仍在，仍不属于"首次回填"范畴）
  //   且该 root 同时在 toBackfill 里有候选，才构成"部分已填 + 部分待填"的混杂。
  const toBackfillByRoot = new Map();
  for (const t of toBackfill) {
    if (!toBackfillByRoot.has(t.root)) toBackfillByRoot.set(t.root, []);
    toBackfillByRoot.get(t.root).push(t.id);
  }
  if (toBackfillByRoot.size > 0) {
    const alreadyFilledByRoot = new Map();
    for (const f of alreadyFilled) {
      if (!alreadyFilledByRoot.has(f.root)) alreadyFilledByRoot.set(f.root, []);
      alreadyFilledByRoot.get(f.root).push(f.id);
    }
    const rootAllocById = new Map();
    for (const r of rows) {
      if (r.derive_seq_alloc !== null && r.derive_seq_alloc !== undefined) {
        rootAllocById.set(Number(r.id), r.derive_seq_alloc);
      }
    }
    for (const [rootId, backfillIds] of toBackfillByRoot) {
      const filledIds = alreadyFilledByRoot.get(rootId) || [];
      const allocValue = rootAllocById.has(rootId) ? rootAllocById.get(rootId) : null;
      if (filledIds.length > 0 || allocValue !== null) {
        violations.mixedFamily.push({
          id: rootId,
          note: `族根 #${rootId} 混杂态：已填成员 ${filledIds.length ? filledIds.map((i) => `#${i}`).join(',') : '无'}${allocValue !== null ? `（derive_seq_alloc 已初始化=${allocValue}）` : ''}，待回填成员 ${backfillIds.map((i) => `#${i}`).join(',')}——同一族不允许部分已填部分待填并存，需人工核实`,
        });
      }
    }
  }

  const hasViolations = Object.values(violations).some((arr) => arr.length > 0);
  return { rows, toBackfill, alreadyFilled, violations, hasViolations };
}

// ── 首次回填赋号方案（纯计算，不写）─────────────────────────────────────────────────────────────
//   按 root 分组、族内按 (created_at, id) 双键升序（确定性：同秒写入靠 id 兜底、重跑同输入恒同输出）。
//   [预筛 H2 收窄] 本函数只服务**全空族**（§15.2 唯一定义的首次回填场景：整族 root/seq 均待赋号，
//   无任何已填成员、根单 alloc 亦未初始化）——从 1 起顺序赋号，不做"续号"。
//   ⚠️ 旧版本这里曾有"续号"设计：若该族已有已填成员或根单已有 alloc，就把新号接在现有最大值之后
//   续起，声称是为了"对任意起始状态的健壮性"。这个设计是错的——它把 §15.2 未定义的第三种族态
//   （"部分已填+部分待填"混杂族）当成合法输入自动吞掉，属于方案之外的自作主张修复，与本模块"异常
//   不自动猜测修复，出清单交人工核实"的一贯哲学（半填/自引用/环等其余违例类别都是这样处理的）相悖。
//   混杂族现在由 classifySysDeriveNumbering 的 mixedFamily 违例类别在上游拦截熔断（调用方必须先查
//   `hasViolations` 才能走到这里）；`alreadyFilled`/`existingAllocByRoot` 两个入参仍保留（不破坏既有
//   调用签名），但仅用作**防御性断言**——若算出的起始号 usedMax>0，说明上游漏拦了一个混杂族，直接
//   throw（结构性不可达：正常业务路径不会让这里看到非零 usedMax）。
function planFirstBackfillAssignments(toBackfill, alreadyFilled, existingAllocByRoot) {
  const byRoot = new Map();
  for (const item of toBackfill) {
    if (!byRoot.has(item.root)) byRoot.set(item.root, []);
    byRoot.get(item.root).push(item);
  }
  const usedMaxByRoot = new Map();
  for (const f of alreadyFilled || []) {
    usedMaxByRoot.set(f.root, Math.max(usedMaxByRoot.get(f.root) || 0, f.seq));
  }
  if (existingAllocByRoot) {
    for (const [root, alloc] of existingAllocByRoot) {
      if (alloc !== null && alloc !== undefined) {
        usedMaxByRoot.set(root, Math.max(usedMaxByRoot.get(root) || 0, Number(alloc)));
      }
    }
  }
  const assignments = [];   // { id, root, seq }
  const allocByRoot = new Map();   // root -> 本次回填后该族应有的 alloc（= 族内最大 seq，全空族恒等于成员数）
  for (const [root, items] of byRoot) {
    const usedMax = usedMaxByRoot.get(root) || 0;
    if (usedMax > 0) {
      throw new Error(`[planFirstBackfillAssignments] 族根 #${root} 检测到已有已填成员/已初始化 alloc（usedMax=${usedMax}）但仍传入了 ${items.length} 条待回填候选——这是 §15.2 未定义的混杂族状态，结构性不可达：调用方必须先经 classifySysDeriveNumbering 的 mixedFamily 违例拦截，走到这里说明上游漏拦（防御性断言，非正常业务失败）`);
    }
    // [预筛 M1 修复] created_at 归一后再比——原始松散比较（a.created_at < b.created_at）在两侧任一为
    // NULL 或格式异构（'T' 分隔 vs 空格分隔的 ISO 变体）时不自洽：JS 里 `null < 'x'` 与 `'x' < null`
    // 可以同时为 false，破坏"总序"要求，排序结果会退化成依赖输入数组的原始顺序（不确定）。归一为空
    // 字符串占位（NULL 恒排最前——早于任何真实时间戳）后，比较关系变为总序自洽，与"重跑同输入恒同
    // 输出"的确定性声称一致；id 仍作同值兜底（同秒或同为 NULL 时）。
    items.sort((a, b) => {
      const ca = a.created_at == null ? '' : String(a.created_at);
      const cb = b.created_at == null ? '' : String(b.created_at);
      if (ca !== cb) return ca < cb ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });
    let next = 1;   // 全空族恒从 1 起（收窄后不再有"续号"分支）
    for (const item of items) {
      assignments.push({ id: item.id, root, seq: next });
      next++;
    }
    allocByRoot.set(root, next - 1);
  }
  return { assignments, allocByRoot };
}

// ── 应用首次回填（写入，调用方须已持有事务/写锁）───────────────────────────────────────────────
//   alloc 写入用 `derive_seq_alloc IS NULL OR derive_seq_alloc < ?` 双重守卫——把"单调不减、仅 NULL
//   初始化"不变量直接编码进 SQL WHERE，不仅依赖上游计算正确（378-H2 单调不减不变量的写入侧兜底）。
async function applyFirstBackfillAssignments(run, assignments, allocByRoot) {
  for (const a of assignments) {
    const upd = await run('UPDATE sys_issues SET derive_root_id = ?, derive_seq = ? WHERE id = ?', [a.root, a.seq, a.id]);
    if (!upd || upd.changes !== 1) {
      throw new Error(`[applyFirstBackfillAssignments] #${a.id} 回填写入 changes=${upd && upd.changes}（期望 1）`);
    }
  }
  for (const [root, allocValue] of allocByRoot) {
    await run(
      'UPDATE sys_issues SET derive_seq_alloc = ? WHERE id = ? AND (derive_seq_alloc IS NULL OR derive_seq_alloc < ?)',
      [allocValue, root, allocValue]
    );
  }
}

// ── 建唯一索引前脏数据探针（同 corrections.js :444-452 rework_root_id/rework_seq 同款范式）────────
//   [预筛 M1] 补稳定排序的成员 id 列表——GROUP_CONCAT 聚合内元素顺序不受 SQL 标准/各 SQLite 版本一致
//   保证，此处显式取回后按数值升序重排，确保同一批违例每次重跑输出逐字节相同（熔断文案与 verify
//   断言都依赖这个稳定性，不能让"顺序不确定"混进本该确定性的诊断信息里）。
async function findDuplicateSeqGroups(all) {
  const groups = await all(
    `SELECT derive_root_id, derive_seq, COUNT(*) c, GROUP_CONCAT(id) ids FROM sys_issues
      WHERE derive_root_id IS NOT NULL AND derive_seq IS NOT NULL
      GROUP BY derive_root_id, derive_seq HAVING c > 1`, []
  );
  return groups.map((g) => ({
    ...g,
    ids: (g.ids || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b),
  }));
}

// ── alloc 不变量探针：derive_seq_alloc ≥ 现存该族 MAX(derive_seq)；有子单却 alloc 未初始化同样判违例 ──
//   [预筛 H3] 扩三类值域/位置校验（原来只有末两类"数量关系"判定，未校验 alloc 本身是否合法）：
//     ① 位置：alloc 非空但该行 derive_root_id 也非空——这行本身是派生单，alloc 只应存在于族根
//        （derive_root_id 为空的原生单）身上，派生单自己持有 alloc 说明数据结构被破坏。
//     ② 类型：typeof(derive_seq_alloc) 不是 'integer' 也不是 'null'——SQLite 动态类型下文本/小数值
//        能被塞进这一列而不报错（列无 CHECK，见 index.js SYS_DERIVE_NUMBERING_ISSUE_COLS 注释），
//        但取号 UPDATE 的 `COALESCE(alloc,0)+1` 对非法类型会做隐式数值转换而非报错（如 'abc'+1=1），
//        必须在这里当场拦下，不能留给算术运算"悄悄洗白"。
//     ③ 值域：alloc ≤ 0——取号计数器必须是正整数，非正值说明被直接篡改或写坏。
//   三类中任一命中即判违例，且**不再叠加**原有"数量关系"判定（类型/值域已非法时，拿它去跟
//   MAX(derive_seq) 比较没有意义，report 一条最相关的原因即可，避免同一行报出自相矛盾的多条理由）。
async function findAllocInvariantViolations(all) {
  const rows = await all(
    `SELECT s.id, s.derive_seq_alloc, s.derive_root_id, typeof(s.derive_seq_alloc) AS alloc_type,
            (SELECT MAX(c.derive_seq) FROM sys_issues c WHERE c.derive_root_id = s.id) AS max_child_seq
       FROM sys_issues s
      WHERE s.derive_seq_alloc IS NOT NULL
         OR EXISTS (SELECT 1 FROM sys_issues c WHERE c.derive_root_id = s.id)`, []
  );
  const violations = [];
  for (const r of rows) {
    const hasAlloc = r.alloc_type !== 'null';
    // ② 类型校验（最先判——类型都不对时，后续任何"数值"判定都没有意义）
    if (hasAlloc && r.alloc_type !== 'integer') {
      violations.push({ id: r.id, reason: `derive_seq_alloc 存储类型异常（typeof=${r.alloc_type}，期望 integer 或 null，实值=${JSON.stringify(r.derive_seq_alloc)}）——文本/小数值会破坏取号计数器的整数语义` });
      continue;
    }
    const alloc = hasAlloc ? Number(r.derive_seq_alloc) : null;
    // ③ 值域校验：alloc ≤ 0
    if (alloc !== null && alloc <= 0) {
      violations.push({ id: r.id, reason: `derive_seq_alloc(${alloc}) ≤ 0——取号计数器必须是正整数` });
      continue;
    }
    // ① 位置校验：派生单（derive_root_id 非空）不得持有 alloc——alloc 只应存在于族根行
    const isDerived = r.derive_root_id !== null && r.derive_root_id !== undefined;
    if (alloc !== null && isDerived) {
      violations.push({ id: r.id, reason: `派生单自身持有 derive_seq_alloc(${alloc})——alloc 只应存在于族根行（derive_root_id 为空的原生单），本行 derive_root_id=${r.derive_root_id} 说明它自己是派生单` });
      continue;
    }
    // 既有两条：alloc 与现存 MAX(child seq) 的数量关系
    const maxSeq = (r.max_child_seq === null || r.max_child_seq === undefined) ? 0 : Number(r.max_child_seq);
    if (maxSeq > 0 && alloc === null) {
      violations.push({ id: r.id, reason: `有派生子单（现存 MAX(derive_seq)=${maxSeq}）但 derive_seq_alloc 未初始化` });
    } else if (alloc !== null && alloc < maxSeq) {
      violations.push({ id: r.id, reason: `derive_seq_alloc(${alloc}) < 现存 MAX(derive_seq)(${maxSeq})——号码可能被复用` });
    }
  }
  return violations;
}

// ── 人类可读违例摘要（供 logger.error / console.error 直接拼串，两处调用方共用同一措辞）─────────────
const VIOLATION_LABELS = {
  halfFilled: '半填（root/seq 仅一列非空）',
  selfReference: '自引用',
  cycle: '血缘环',
  chainTooDeep: '血缘链过深',
  brokenChain: '血缘链断裂/根不存在',
  wrongRoot: '错根（存量 derive_root_id 与重算根不一致）',
  seqNonPositive: 'derive_seq 非正整数',
  mixedFamily: '混杂族（同族部分已填部分待填）',
};
function formatViolationSummary(violations) {
  const parts = [];
  for (const [key, label] of Object.entries(VIOLATION_LABELS)) {
    const arr = violations[key] || [];
    if (arr.length > 0) {
      // [预筛 L1 修复] 附上每行 note（若有）——运维读到的是这句拼接串（503/日志文案），不是内部结构化
      // 字段；此前 note（如"非派生单却带 root/seq"，与半填桶的通用标题"root/seq 仅一列非空"字面矛盾）
      // 只落在 violations 数组里从未拼进用户可见文案，读者会被"仅一列非空"这句误导去找错方向。
      parts.push(`${label} ${arr.length} 例（${arr.map((v) => `#${v.id}${v.note ? `[${v.note}]` : ''}`).join(',')}）`);
    }
  }
  return parts.join('；');
}

// ── 派生单展示号 helper（S12-b·方案 §15.3 helper 契约）────────────────────────────────────────────
//   服务端**唯一**权威取号实现——全部通知/timeline 拼单号文案处经它取号，不各写一份字符串拼接
//   （同规则禁双实现，同本模块其余函数一致的立场）。S13 前端会有一份对应实现，两端各自单点、互不
//   require（前端不能 require 后端 utils），但共用同一份 fixture（见 utils/sys-issue-display-no.
//   fixtures.js）跑一致性断言，防止两端各自演进后悄悄输出不同文本。
//   入参 row 只需含 { id, derive_root_id, derive_seq } 三个字段（任何携带这三者的对象都可直接传入——
//   sys_issues 整行、SELECT 投影出的最小子集、甚至手工拼的 plain object 均可）：
//     · derive_root_id 与 derive_seq **两列都非 null/undefined** ⇒ 派生单，返回 `#${root}_${seq}`；
//     · 任一为 null/undefined（含双缺省、半缺——半缺是结构异常态，见 classifySysDeriveNumbering 的
//       halfFilled 违例类，但本函数不做校验、只负责"缺了就退")⇒ 一律回退 `#${id}`（根单本就应该长
//       这样：根单自身 derive_root_id/derive_seq 恒为 NULL，回退到 #id 正是它的正确展示形态，不是
//       "异常兜底"，是"根单的正常路径"）。
//   ⚠️ 判空用 `!= null`（同时排除 null 与 undefined）而非真值判断——`derive_seq` 为 0 时若误用真值
//   判断（`if (row.derive_seq)`）会把它错误当成"缺省"回退成 #id；虽然 0 不是业务上会出现的合法序号
//   （seq 恒从 1 起，见 planFirstBackfillAssignments），但 helper 的职责是"如实格式化已有数据"，不是
//   "校验数据合法性"（校验是 classifySysDeriveNumbering/findAllocInvariantViolations 的职责），两个
//   职责不能在这一个函数里混在一起，故用严格判空，不掺入值域校验。
function sysIssueDisplayNo(row) {
  if (!row) return '';
  const hasRoot = row.derive_root_id !== null && row.derive_root_id !== undefined;
  const hasSeq = row.derive_seq !== null && row.derive_seq !== undefined;
  if (hasRoot && hasSeq) {
    return `#${row.derive_root_id}_${row.derive_seq}`;
  }
  return `#${row.id}`;
}

module.exports = {
  sysIssueDisplayNo,
  DERIVE_MAX_CHAIN_DEPTH,
  walkDeriveChainRoot,
  classifySysDeriveNumbering,
  planFirstBackfillAssignments,
  applyFirstBackfillAssignments,
  findDuplicateSeqGroups,
  findAllocInvariantViolations,
  formatViolationSummary,
};
