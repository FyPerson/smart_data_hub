'use strict';
// routes/it-ledger/inspection-period.js — 巡检周期判据（#200 C0，方案 v1.5 第四节）
//
// 口径：
//   - 两档周期：week = 自然周，周一为第一天、周日为最后一天；month = 自然月。默认 week。
//   - 「今天」由调用方给出，取服务器本地日期（概览里是 SQLite date(<现在秒数>,'unixepoch','localtime')，「现在」生产为 Date.now()），格式 YYYY-MM-DD。
//   - 本模块只做日期字符串运算：解析用 Date.UTC，取星期用 getUTCDay，格式化用 UTC 取值；
//     不读时钟、不依赖进程时区。periodOf 的日期入参格式不合法（含 2026-02-30 这类不存在的日期）直接抛错；
//     inPeriod 不校验，只做字符串字典序比较，入参须是已规范化的 YYYY-MM-DD 或空值（null / undefined 返回 false）。
//   - 来源：环境变量 IT_INSPECTION_CYCLE（wbs-server/.env）；未设置或取值不是 week / month 时按 week。
const CYCLES = ['week', 'month'];
const DEFAULT_CYCLE = 'week';
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86400000;

function resolveCycle(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return CYCLES.includes(text) ? text : DEFAULT_CYCLE;
}

function readCycleFromEnv(env = process.env) {
  const raw = env.IT_INSPECTION_CYCLE;
  const cycle = resolveCycle(raw);
  const valid = raw === undefined || (typeof raw === 'string' && cycle === raw.trim().toLowerCase());
  return { cycle, raw, valid };
}

// 启动日志一行：只描述实际生效的周期与原因，由 inspection-sheets.js 在模块装配时打印一次。
function cycleLogLine(info) {
  const head = '[it-ledger] 巡检周期=' + info.cycle;
  if (info.raw === undefined) return head + '（IT_INSPECTION_CYCLE 未设置，用默认）';
  if (!info.valid) return head + '（IT_INSPECTION_CYCLE=' + JSON.stringify(info.raw) + ' 不合法，用默认）';
  return head;
}

function parseDay(day) {
  const m = typeof day === 'string' ? DAY_RE.exec(day) : null;
  if (!m) throw new Error('日期格式无效，应为 YYYY-MM-DD：' + String(day));
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error('日期不存在：' + day);
  return { y, mo, d, ms };
}

function formatDay(ms) {
  const t = new Date(ms);
  const pad = (n, w) => String(n).padStart(w, '0');
  return pad(t.getUTCFullYear(), 4) + '-' + pad(t.getUTCMonth() + 1, 2) + '-' + pad(t.getUTCDate(), 2);
}

function periodOf(today, cycle) {
  const { y, mo, ms } = parseDay(today);
  if (cycle === 'month') {
    const lastDay = Date.UTC(y, mo, 1) - MS_PER_DAY;
    return { cycle: 'month', start: formatDay(Date.UTC(y, mo - 1, 1)), end: formatDay(lastDay) };
  }
  if (cycle !== 'week') throw new Error('周期无效：' + String(cycle));
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  const start = ms - sinceMonday * MS_PER_DAY;
  return { cycle: 'week', start: formatDay(start), end: formatDay(start + 6 * MS_PER_DAY) };
}

// day 只接受已规范化的 YYYY-MM-DD（概览里来自 SQLite date()）或空值；不做格式校验，带后缀等非规范串按字典序比较，结果无意义。
function inPeriod(day, period) {
  if (day === null || day === undefined) return false;
  return period.start <= day && day <= period.end;
}

module.exports = { CYCLES, resolveCycle, readCycleFromEnv, cycleLogLine, periodOf, inPeriod };
