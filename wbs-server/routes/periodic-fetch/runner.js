// routes/periodic-fetch/runner.js — 周期取数推送模块 ③ 跑数引擎 helper（集成点2 新增）
//   业务 SSOT = docs/local/周期取数推送/周期取数推送模块_方案_20260703_v1.0.md §3.2/§4.2/§4.4/§5.2
//   任务书 SSOT = docs/local/周期取数推送/周期取数推送_Sonnet任务书_20260705_v1.0.md 附录 A.2/A.3
//
// 职责（纯逻辑 helper，不碰 DB/express，供 routes/periodic-fetch/index.js require）：
//   1. Asia/Shanghai 写死时区的"上月"日期区间计算（方案 §3.2，不依赖服务器/容器默认时区）。
//   2. source 全量执行（OT-2 结论）：
//      - SQL Server：request.stream=true 边读边计数，超行数上限立即 request.cancel()，避免大结果集
//        全量进内存后才判定超限（mssql request.query() 非流式模式会等待全部 recordset 到位才返回，
//        100k 行×宽列可能在"判断超限"之前就已吃满内存——流式模式把峰值内存锁定在 maxRows 量级）。
//      - MySQL：mysql2/promise 无对等的行级流式 Promise API（仅底层 callback Connection 支持
//        `.query(sql).on('result',...)`，promise 封装未暴露），本模块沿用现有 smoke test
//        （utils/collab-submit-helpers.js runRealSmokeTest 的 mysql 分支）同款 `pool.query({sql,timeout})`
//        缓冲后置行数校验——与 smoke 现状同等风险等级，非本次新增回归（自审报告已标注此不对称）。
//   3. 结果 xlsx 生成（buffer，供落盘）。
//   4. 结果文件落盘路径安全 helper：非 public 目录 + 随机文件名 + realpath 校验落在子树内（防路径穿越）+
//      删除守卫（自建，不复用 server.js safeDeleteFileSync/ALLOWED_FILE_DIRS —— 任务书附录 A.2 明确要求
//      不把新目录塞进存量白名单，避免存量附件删除逻辑与本模块敏感目录产生耦合）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

// 结果文件落盘根目录：wbs-server 根下新建 periodic-results/。
//   ⚠️ 硬红线：绝不落 UPLOAD_DIR（server.js:666 `app.use('/uploads', express.static(UPLOAD_DIR))`
//   把它挂成了静态公开目录，结果 xlsx 含身份证/银行账号，落进去=拼 URL 就能下别人敏感数据）。
//   本目录不挂 express.static，只能通过 index.js 的鉴权下载端点读取。
const PERIODIC_RESULTS_DIR = path.join(__dirname, '..', '..', 'periodic-results');

function ensurePeriodicResultsDir() {
  fs.mkdirSync(PERIODIC_RESULTS_DIR, { recursive: true });
  return PERIODIC_RESULTS_DIR;
}

// ============================================================
// 一、Asia/Shanghai 写死时区的"上月"区间计算（方案 §3.2）
// ============================================================
// 用 Intl.DateTimeFormat 显式指定 timeZone:'Asia/Shanghai' 取当前"墙钟"年月日，不依赖
// process.env.TZ / 服务器系统时区——同一进程无论部署在哪个时区的机器上，结果一致。
function computeLastMonthRangeShanghai(now) {
  now = now || new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  const pad2 = (n) => String(n).padStart(2, '0');
  const thisMonthStart = `${y}-${pad2(m)}-01`;
  let ly = y;
  let lm = m - 1;
  if (lm === 0) { lm = 12; ly = y - 1; }
  const lastMonthStart = `${ly}-${pad2(lm)}-01`;
  // 左闭右开：[上月首日, 本月首日)（方案 §3.1，对齐 #21 原写法 >=/< ，避免"月末 23:59:59"边界坑）
  return { start: lastMonthStart, end: thisMonthStart };
}

// ============================================================
// 二、结果文件落盘（随机文件名 + realpath 越界校验 + 删除守卫）
// ============================================================
function generateRandomResultFileName() {
  return `${crypto.randomBytes(16).toString('hex')}.xlsx`;
}

function writeResultFile(buffer) {
  ensurePeriodicResultsDir();
  const fileName = generateRandomResultFileName();
  const absPath = path.join(PERIODIC_RESULTS_DIR, fileName);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

// realpath 校验：目标必须真实存在且落在 periodic-results 子树内（防路径穿越/防 DB 里路径被篡改），
//   不存在/越界一律返回 null，调用方据此自愈 file_status='missing'。
function resolveSafeResultPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  let real;
  try { real = fs.realpathSync(storedPath); } catch (e) { return null; }
  let rootReal;
  try { rootReal = fs.realpathSync(ensurePeriodicResultsDir()); } catch (e) { return null; }
  const rel = path.relative(rootReal, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

// 删除守卫（自建，见文件头注释——不复用 safeDeleteFileSync/ALLOWED_FILE_DIRS）。
function deleteResultFileGuarded(storedPath) {
  const real = resolveSafeResultPath(storedPath);
  if (!real) return { ok: false, reason: 'NOT_FOUND_OR_OUTSIDE' };
  try {
    fs.unlinkSync(real);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'UNLINK_FAILED', error: e.message };
  }
}

// ============================================================
// 三、结果 xlsx 生成
// ============================================================
function formatCellValue(v) {
  if (v === undefined || v === null) return null;
  if (Buffer.isBuffer(v)) return `[binary:${v.length}bytes]`;
  return v; // string/number/boolean/Date：交给 XLSX.utils.aoa_to_sheet 原生处理（Date 会被识别为日期类型单元格）
}

function buildResultXlsxBuffer(columns, rows) {
  const cols = Array.isArray(columns) && columns.length > 0 ? columns : ['(无列)'];
  const aoa = [cols];
  for (const r of (rows || [])) {
    aoa.push(cols.map((c) => formatCellValue(r ? r[c] : undefined)));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Result');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ============================================================
// 四、source 全量执行（OT-2）
// ============================================================
// SQL Server：request.stream=true。事件顺序（mssql/tedious 官方语义，见
//   node_modules/mssql/lib/base/request.js query()）：stream 模式下 'error' 与 'done' 都可能触发，
//   但 Promise 本身在 stream 模式下 err 会被置 null 后仍 resolve——即 request.query(sql) 返回的 Promise
//   总会在整个请求真正结束（含 cancel 之后）才 resolve，不会因查询失败而 reject。故用它的 .then() 做
//   "真正结束"的信号，配合 'error' 事件里记录的 queryError 判定最终结果，而不是依赖 'done' 事件本身。
function runMssqlFullQuery(pool, sql, opts) {
  const maxRows = (opts && opts.maxRows) || 100000;
  const timeoutMs = (opts && opts.timeoutMs) || 60000;
  return new Promise((resolve) => {
    let request;
    try {
      request = pool.request();
    } catch (e) {
      resolve({ ok: false, code: 'POOL_REQUEST_FAILED', error: e });
      return;
    }
    request.stream = true;
    request.timeout = timeoutMs;

    let columns = null;
    const rows = [];
    let rowCount = 0;
    let limitExceeded = false;
    let duplicateColumns = false;   // E-1
    let queryError = null;

    request.on('recordset', (cols) => {
      if (!columns) {
        columns = Object.keys(cols || {});
        // E-1（集成审）：重名输出列检测。mssql stream 非 arrayRowMode 下，recordset 元数据对象按列名做
        //   键、同名列被折叠（Object.keys 只剩一个），row 对象里同名列也被底层合并成数组 → 若直接生成
        //   xlsx 会静默丢敏感列/塞进数组值，admin 无从察觉。检测手段：createColumns 给每列 metadata 带
        //   `index`（0..N-1 物理列序），同名列后写覆盖前写但保留其 index；故 max(index)+1 = 物理列数 N，
        //   而 Object.keys 长度 = 唯一列名数 M。N>M 即存在重名列 → 立即 cancel + 判 DUPLICATE_COLUMNS
        //   落 failed（宁可失败不可静默丢敏感列）。名字无法从折叠对象逐一还原，报总数即可，文案提示加别名。
        const colVals = Object.values(cols || {});
        const maxIndex = colVals.length
          ? Math.max(...colVals.map((c) => (c && typeof c.index === 'number') ? c.index : 0))
          : -1;
        const physicalCount = maxIndex + 1;
        if (physicalCount > columns.length) {
          duplicateColumns = true;
          try { request.cancel(); } catch (e) { /* best-effort */ }
        }
      }
    });
    request.on('row', (row) => {
      if (limitExceeded || duplicateColumns) return; // cancel() 已发出，在途 row 丢弃不计入
      rowCount++;
      if (rowCount > maxRows) {
        limitExceeded = true;
        try { request.cancel(); } catch (e) { /* best-effort，取消失败不影响后续判定为超限失败 */ }
        return;
      }
      rows.push(row);
    });
    request.on('error', (err) => {
      // limitExceeded / duplicateColumns 场景下的 error（多为 cancel 触发的 "Canceled." 类错误）不视为
      // 真实查询失败，由对应标记单独判定 ROW_LIMIT_EXCEEDED / DUPLICATE_COLUMNS。
      if (!limitExceeded && !duplicateColumns && !queryError) queryError = err;
    });

    const settle = () => {
      if (duplicateColumns) {
        resolve({ ok: false, code: 'DUPLICATE_COLUMNS', columns: columns || [] });
        return;
      }
      if (limitExceeded) {
        resolve({ ok: false, code: 'ROW_LIMIT_EXCEEDED', rowCount, columns: columns || [] });
        return;
      }
      if (queryError) {
        const isTimeout = queryError.code === 'ETIMEOUT' || /timeout/i.test(queryError.message || '');
        resolve({ ok: false, code: isTimeout ? 'QUERY_TIMEOUT' : 'QUERY_ERROR', error: queryError, columns: columns || [] });
        return;
      }
      resolve({ ok: true, rows, columns: columns || [], rowCount });
    };

    request.query(sql).then(settle).catch((err) => {
      // 兜底：stream 模式下 mssql 库理论上不会 reject（err 已被置 null），此处防未来版本行为变化。
      if (!queryError) queryError = err;
      settle();
    });
  });
}

// MySQL：见文件头注释——沿用 smoke 同款缓冲 pool.query({sql,timeout}) + 后置行数校验（非流式提前 cancel）。
async function runMysqlFullQuery(pool, sql, opts) {
  const maxRows = (opts && opts.maxRows) || 100000;
  const timeoutMs = (opts && opts.timeoutMs) || 60000;
  try {
    const [rows, fields] = await pool.query({ sql, timeout: timeoutMs });
    const rowArr = Array.isArray(rows) ? rows : [];
    // fields 是有序数组、含重复列名（mysql2 每物理列一项）；rows 默认按列名做对象键，同名列后写覆盖前写
    //   → 静默丢列。故先检测：fields.length（物理列数）> 唯一列名数 → DUPLICATE_COLUMNS（E-1，同 mssql）。
    const fieldNames = (Array.isArray(fields) && fields.length > 0)
      ? fields.map((f) => f.name)
      : (rowArr[0] ? Object.keys(rowArr[0]) : []);
    if (fieldNames.length > new Set(fieldNames).size) {
      const dupNames = [...new Set(fieldNames.filter((n, i) => fieldNames.indexOf(n) !== i))];
      return { ok: false, code: 'DUPLICATE_COLUMNS', columns: fieldNames, duplicateColumns: dupNames };
    }
    const columns = fieldNames;
    if (rowArr.length > maxRows) {
      return { ok: false, code: 'ROW_LIMIT_EXCEEDED', rowCount: rowArr.length, columns };
    }
    return { ok: true, rows: rowArr, columns, rowCount: rowArr.length };
  } catch (err) {
    const isTimeout = /timeout/i.test(err.message || '') || err.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
    return { ok: false, code: isTimeout ? 'QUERY_TIMEOUT' : 'QUERY_ERROR', error: err, columns: [] };
  }
}

module.exports = {
  PERIODIC_RESULTS_DIR,
  ensurePeriodicResultsDir,
  computeLastMonthRangeShanghai,
  generateRandomResultFileName,
  writeResultFile,
  resolveSafeResultPath,
  deleteResultFileGuarded,
  buildResultXlsxBuffer,
  formatCellValue,
  runMssqlFullQuery,
  runMysqlFullQuery,
};
