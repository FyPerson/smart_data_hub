'use strict';
// routes/it-ledger/inspection-collect.js — 采集共用模块（长任务 E · C3）
//   方案 SSOT = docs/local/信息化资产_轻量版/巡检台账改版_方案_20260923_v0.4.md §2.5/§3.1/§5.4
//   执行派单 = E:/tmp/insp-sheet-review/c3/spec-C3.md
//
// 从 inspections.js 抽出（长任务 E · C3 时，inspections.js 还承载服务器单独采集的写路径，与
// 巡检单采集共用这里全部函数）。C7 单独设备巡检整体退役后，inspections.js 只保留两条只读路由：
//   - target()：采集资格判定（实时资产状态，不是任何快照）。C7 后只被巡检单采集
//     （inspection-sheets.js 的 POST /:id/items/:itemId/collect）调用。
//   - reverifyTarget()：第二次写事务内重新判资格并核对与第一次身份（sn+host）一致，不一致 409。
//     C7 后只被巡检单采集调用。
//   - collectSnapshot()：按 host 的单飞集合（原两个入口共用同一份 active 集合、不形成两把锁，C7
//     单独设备巡检退役后那个入口已删，现在只有巡检单采集这一个入口在用，实现不变）+ 锁外调用
//     collector.collect() + 身份不符改写为 failed 快照。
//   - deviceJudgementError()：方案 §3.1 最后一条"完全沿用现有设备判断规则"（原 inspections.js
//     123/125 两行），原与服务器单独判断共用同一份实现，C7 退役后现在只有巡检单完整性
//     （inspection-sheets.js 的 sheetProgress）在调用。
//   - it_device_inspections 的建表与两列兼容（方案 §2.5）：exists/ensure/deviceInspectionColumns/
//     ensureDeviceInspectionColumns，从 inspections.js 移过来，单一实现（inspections.js 与
//     inspection-sheets.js 都只从这里取，不各自维护一份 DDL）。
//   - view()：把原始行的 snapshot_json 还原成对象，两个入口的响应整形共用。
module.exports = function createInspectionCollect({ collector, recordManagement }) {
  const active = new Set();
  const error = (status, code, message) => Object.assign(new Error(message), { status, code });
  const bad = (message) => error(400, 'LEDGER_BAD_REQUEST', message);
  function attrs(row) { try { return JSON.parse(row.attrs || '{}'); } catch (_e) { return {}; } }

  // ============================================================
  // 一、资格判定（原 inspections.js:20，逐字搬迁，行为不变）
  // ============================================================
  async function target(q, assetId) {
    await recordManagement.assertActive(q, assetId);
    const a = await q.get('SELECT id,name,sn,category,status,attrs FROM it_assets WHERE id=?', [assetId]);
    const host = collector.host();
    if (!a || a.category !== 'server' || a.status !== 'in_service' || !host || attrs(a).ip !== host) throw bad('该设备未配置可用的服务器采集连接');
    if (!a.sn) throw bad('采集设备须登记序列号以核对身份');
    return { ...a, host };
  }

  // 第二个写事务内的复核：重新判资格，并核对与第一次判资格时是否为同一台设备（sn+host 均不变）。
  // 不一致（采集期间资产被改名、换绑 IP、或换了另一台设备接了同一个 host）一律 409，不落库。两个
  // 入口共用同一份判据——inspections.js 的标准态既有测试全绿即证明本函数与原逻辑等价。
  async function reverifyTarget(q, assetId, first) {
    const current = await target(q, assetId);
    if (current.sn !== first.sn || current.host !== first.host) throw error(409, 'VERSION_CONFLICT', '采集期间资产身份发生变化，请重新采集');
    return current;
  }

  function failedSnapshot(host, started, message) {
    return {
      schema_version: 1, source_host: host, server: null, volumes: [], physical_disks: [], virtual_disks: [], enclosures: [],
      alerts: [], component_errors: [message], cleanup_warnings: [], collection_status: 'failed', started_at: started, completed_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // 二、单飞采集（原 inspections.js POST / 107-112 行迁来，两个入口共用同一个 active 集合，不形成
  //   两把锁，方案 §5.4 第一条明文要求）。
  //   C3b L2（占用范围如实订正）：原 inspections.js 里 active.delete(lock) 是在整个路由处理器最外层
  //   的 finally 里做的——单飞锁从"进 collect() 之前"一直占到"第二个写事务（INSERT）跑完之后"，
  //   覆盖了整条采集流程。搬进这个独立函数后，active.delete(a.host) 收进了本函数自己的 finally，
  //   在 collector.collect() 返回（含身份核对改写失败快照）后立刻释放——不再覆盖调用方之后各自的
  //   第二个写事务。这是有意收窄，不是遗漏：单飞锁存在的意义是"同一个 host 不能有两个真实采集在
  //   跑"（保护的是外部采集器这个独占、慢的资源），不是给"落库"这一步串行化——落库的串行化已经由
  //   模块自己的 itTxnMutex（withWrite 取锁）保证，不需要单飞集合重复保护第二次。收窄后的效果：
  //   collect() 一返回，同一 host 立刻能再发起下一次采集，即便上一次的落库事务还没跑完；两次落库
  //   本身仍然互不冲突（各自的 withWrite 串行执行，各自复核各自的资产/单据状态）。
  // ============================================================
  async function collectSnapshot(a) {
    if (active.has(a.host) || active.size >= 2) throw error(409, 'INSPECTION_BUSY', '该设备正在采集，请等待完成，不要重复点击');
    active.add(a.host);
    try {
      const started = new Date().toISOString();
      let snapshot;
      try { snapshot = await collector.collect(); } catch (_e) { snapshot = failedSnapshot(a.host, started, '采集失败或超时，请检查连接后重试'); }
      if (snapshot.source_host !== a.host || (snapshot.server && String(snapshot.server.serial_number).trim().toUpperCase() !== a.sn.trim().toUpperCase())) {
        snapshot = failedSnapshot(a.host, started, '远端身份与登记设备不一致，本次未保存其硬件数据');
      }
      return snapshot;
    } finally {
      active.delete(a.host); // 见上方注释：锁到这里就释放，不覆盖调用方随后的第二个写事务。
    }
  }

  // ============================================================
  // 三、设备判断规则（方案 §3.1 最后一条，原 inspections.js:123/125，逐字保留判据）——原为服务器单独
  //   判断（POST /inspections/:id/review）与巡检单完整性（sheetProgress）共用，C7 单独设备巡检整体
  //   退役后那条路由已删，现在只有巡检单完整性（sheetProgress）在调用。collection 是调用方查好传入
  //   的 {collectionStatus, alertsCount, cleanupWarningsCount}，本函数不查库（sheetProgress 是纯
  //   函数，不能自己查库——C2c L6 photos.state 同一先例）。judgement ∈ {'normal','attention'}，与
  //   （已退役的）inspections.js 请求体曾用的 judgement 同一套词汇；调用方按
  //   result==='bad'?'attention':'normal' 把巡检单的 check 结果翻译成这套词汇。返回错误文案
  //   （string）或 null（无问题）。
  // ============================================================
  function deviceJudgementError(collection, judgement, note) {
    if (!collection) return null;
    if (collection.collectionStatus === 'failed' && judgement === 'normal') return '采集失败不能判断为正常，请选择需要关注';
    // C3c M7（37T）：只判 !note 会把纯空格字符串当成"已说明"放行——改成 trim 后非空，与
    // inspection-sheets.js 的 validateItemPatch（C2c L1）对普通检查项说明的判空口径一致。
    if (judgement === 'normal' && (collection.collectionStatus !== 'success' || collection.alertsCount || collection.cleanupWarningsCount) && !(note && note.trim())) return '本次存在自动告警或采集不完整，判断正常须说明理由';
    return null;
  }

  // ============================================================
  // 四、it_device_inspections 建表与两列兼容（方案 §2.5，原 inspections.js:12-18 的 ensure() 搬来，
  //   新增 sheet_id/detached_from_sheet_id 两列 + 表级 CHECK 两列不同时非空——新建表直接带，旧表靠
  //   下面的 ensureDeviceInspectionColumns 补）。
  // ============================================================
  async function exists(q) { return !!(await q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='it_device_inspections'")); }
  async function ensure(q) {
    await q.run(`CREATE TABLE IF NOT EXISTS it_device_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, asset_name TEXT NOT NULL, source_host TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, collection_status TEXT NOT NULL CHECK(collection_status IN ('success','partial','failed')),
      snapshot_json TEXT NOT NULL, requested_by INTEGER NOT NULL, judgement TEXT CHECK(judgement IN ('normal','attention')),
      judgement_note TEXT, reviewed_by INTEGER, reviewed_at TEXT,
      sheet_id INTEGER, detached_from_sheet_id INTEGER,
      CHECK((judgement IS NULL AND judgement_note IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (judgement IS NOT NULL AND judgement_note IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK(sheet_id IS NULL OR detached_from_sheet_id IS NULL)
    )`);
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_device_inspections_asset ON it_device_inspections(asset_id,id)');
    // C3坑：sheet_id 索引不能在这里无条件建——旧表（ensureDeviceInspectionColumns 还没来得及给它
    // 补 sheet_id 列）此刻这张表可能根本没有 sheet_id 这一列，CREATE INDEX ON (sheet_id) 会直接报
    // "no such column: sheet_id"（新建表没问题，因为上面 CREATE TABLE 已经把两列都带上了；出问题
    // 的是"表已存在但缺列"这条兼容路径）。索引改到 ensureDeviceInspectionColumns 里、确认列已经
    // 存在（不管是刚新建表带出来的，还是刚 ALTER 补出来的）之后再建，同样幂等（IF NOT EXISTS）。
  }
  // 读路径：只读 PRAGMA table_info，不做任何写操作，供调用方决定 SELECT 列表怎么拼、GET /:id 之类
  // 的显式列查询要不要给 sheet_id/detached_from_sheet_id 补 NULL 别名。
  async function deviceInspectionColumns(q) {
    const rows = await q.all('PRAGMA table_info(it_device_inspections)');
    const names = new Set(rows.map((r) => r.name));
    return { hasSheetId: names.has('sheet_id'), hasDetached: names.has('detached_from_sheet_id') };
  }
  // 写路径共用：在同一个写事务里，对缺失的列执行 ALTER TABLE ADD COLUMN，幂等（已存在则跳过）。
  // 调用前必须先 ensure(q)（保证表本身存在——ALTER 一张不存在的表会报错，见调用方注释）。sheet_id
  // 索引也在这里建（见上方 ensure() 里的坑注释）——此刻两列必已就绪（刚补上或本来就有）。
  // C3c（codex 37S M，改正 C3b L4 的错误结论）：C3b 曾记录"ALTER TABLE 补列时加不上 CHECK"——
  // 这是错的，只对了一半：SQLite 的 ALTER TABLE 确实不能给**已有**列/表追加约束，但 ADD COLUMN
  // 本身的列定义里可以带 CHECK（含引用同表其它列的 CHECK，如「sheet_id IS NULL OR
  // detached_from_sheet_id IS NULL」这种跨列条件），已实测验证（`ALTER TABLE t ADD COLUMN
  // detached_from_sheet_id INTEGER CHECK (sheet_id IS NULL OR detached_from_sheet_id IS NULL)`
  // 建表成功且约束真正生效）。新逻辑：缺两列时，先补没有约束的 sheet_id，再补带上这条互斥 CHECK
  // 的 detached_from_sheet_id（此时 sheet_id 已存在，CHECK 可以引用它）；只缺其中一列时，在新增的
  // 那一列上直接带同样的 CHECK（另一列已经在表里，同样可引用）。**唯一仍不受 DB 层保护的情况**：
  // 两列在本次修复之前就已经都存在的旧库（该库从未在这条 CHECK 保护下运行过，ALTER 又不能给已有
  // 列追加约束，只能整表迁移，不在本次范围内）——这种情况继续靠写路径纪律（sheet_id 与
  // detached_from_sheet_id 从不在同一条 UPDATE/INSERT 里都赋非空值），保留为文档记录的例外，不再
  // 笼统声称"补列做不到 CHECK"。新建表（含测试夹具用的全新 SQLite 文件）不受影响，CHECK 从建表
  // 那一刻就在。
  async function ensureDeviceInspectionColumns(q) {
    const cols = await deviceInspectionColumns(q);
    const mutualCheck = 'CHECK (sheet_id IS NULL OR detached_from_sheet_id IS NULL)';
    if (!cols.hasSheetId && !cols.hasDetached) {
      await q.run('ALTER TABLE it_device_inspections ADD COLUMN sheet_id INTEGER');
      await q.run(`ALTER TABLE it_device_inspections ADD COLUMN detached_from_sheet_id INTEGER ${mutualCheck}`);
    } else if (!cols.hasSheetId) {
      await q.run(`ALTER TABLE it_device_inspections ADD COLUMN sheet_id INTEGER ${mutualCheck}`);
    } else if (!cols.hasDetached) {
      await q.run(`ALTER TABLE it_device_inspections ADD COLUMN detached_from_sheet_id INTEGER ${mutualCheck}`);
    }
    // else：两列都已存在——见上方注释，唯一仍不受 DB 层保护的例外，本次不处理。
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_device_inspections_sheet ON it_device_inspections(sheet_id)');
  }

  // ============================================================
  // 五、响应整形（原 inspections.js:22，逐字搬迁）——两个入口共用，snapshot_json 还原成对象。
  // ============================================================
  // C3b L3：旧表（缺 sheet_id/detached_from_sheet_id 两列）上取出的 row 对象根本没有这两个 key
  // （SELECT * 选不出不存在的列），JSON.stringify 会把值为 undefined 的键整个丢掉，不是"值为
  // null"而是"键消失"——调用方（前端/API消费者）没法用同一套判空逻辑处理新旧两种表。这里统一
  // 补上默认值 null，保证响应里这两个键永远存在，语义与"读路径缺列按 NULL 返回"（方案 §2.5）
  // 一致，不只是数据库查询层面缺列按 NULL，响应体也要缺列按 NULL。
  function view(row) {
    const { snapshot_json, ...rest } = row;
    return { ...rest, sheet_id: rest.sheet_id ?? null, detached_from_sheet_id: rest.detached_from_sheet_id ?? null, snapshot: JSON.parse(snapshot_json) };
  }

  return { target, reverifyTarget, collectSnapshot, deviceJudgementError, exists, ensure, deviceInspectionColumns, ensureDeviceInspectionColumns, view };
};
