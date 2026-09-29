'use strict';

// One dictionary for validation and the meta API. Labels are also frozen in each
// close event, so later wording changes cannot rewrite an existing archive.
const reasons = Object.freeze([
  ['new_business', '新增业务需要'],
  ['process_improvement', '既有业务流程优化'],
  ['rule_change', '业务规则或管理要求变化'],
  ['system_defect', '本系统功能或逻辑问题'],
  ['external_system', '外部系统变更或异常影响'],
  ['historical_data', '历史数据或迁移遗留'],
  ['operation_process', '人工操作或流程执行问题'],
  ['routine_maintenance', '日常运维或配置需要'],
  ['other', '其他'],
].map(([code, label]) => Object.freeze({ code, label })));

function normalize(payload) {
  const code = payload && payload.archive_origin_code;
  if (code === undefined || code === '') return { code: 'ARCHIVE_ORIGIN_REQUIRED', error: '请选择任务产生原因' };
  const reason = reasons.find(item => item.code === code);
  if (typeof code !== 'string' || !reason) return { code: 'ARCHIVE_ORIGIN_INVALID', error: '任务产生原因无效，请重新选择' };
  const raw = payload.archive_origin_note;
  if (raw !== undefined && typeof raw !== 'string') return { code: 'ARCHIVE_ORIGIN_NOTE_INVALID', error: '补充说明必须是文字' };
  const note = (raw || '').trim();
  if ([...note].length > 500) return { code: 'ARCHIVE_ORIGIN_NOTE_TOO_LONG', error: '补充说明不能超过 500 字' };
  if (code === 'other' && !note) return { code: 'ARCHIVE_ORIGIN_NOTE_REQUIRED', error: '选择其他时请填写补充说明' };
  return { value: { version: 1, code, label: reason.label, note } };
}

module.exports = { reasons, normalize };
