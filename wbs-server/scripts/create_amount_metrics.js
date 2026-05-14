/**
 * 批量创建合同金额指标体系 (L1-L6)
 * L0 合同总金额 (ID=53) 已创建
 */
const http = require('http');

function request(method, path, data, token) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const opts = {
      hostname: '192.168.1.100', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const BASE_WHERE = `is_out = 1`;
const VALID_WHERE = `${BASE_WHERE}\n  AND state_display IN ('扫描件已归档','审批通过','自动顺延合同审批通过')`;
const CORE_WHERE = `${VALID_WHERE}\n  AND contract_type_std NOT IN ('收入合同-子合同','收入合同-备忘录','收入合同-终止合同')`;
const REPORT_WHERE = `${CORE_WHERE}\n  AND is_report_included = 1`;
const ONETIME_WHERE = `${REPORT_WHERE}\n  AND renew_method_name = '一次性合同'`;
const DUE_WHERE = `${REPORT_WHERE}\n  AND (renew_method_name IS NULL OR renew_method_name <> '一次性合同')`;
const RENEWED_WHERE = `${DUE_WHERE}\n  AND is_renewed_name = '已续签'`;
const NOT_RENEWED_WHERE = `${DUE_WHERE}\n  AND is_renewed_name = '未续签'`;

function dax(name, filters) {
  let code = `${name} =\nCALCULATE(\n    [cont_total_amount]`;
  for (const f of filters) {
    code += `,\n    ${f}`;
  }
  code += '\n)';
  return code;
}

const DAX_IS_OUT = `'dwd_cont_header_df'[is_out] = 1`;
const DAX_VALID = `'dwd_cont_header_df'[state_display] IN {\n        "扫描件已归档", "审批通过", "自动顺延合同审批通过"\n    }`;
const DAX_CORE = `NOT 'dwd_cont_header_df'[contract_type_std] IN {\n        "收入合同-子合同", "收入合同-备忘录", "收入合同-终止合同"\n    }`;
const DAX_REPORT = `'dwd_cont_header_df'[is_report_included] = 1`;
const DAX_ONETIME = `'dwd_cont_header_df'[renew_method_name] = "一次性合同"`;
const DAX_DUE = `'dwd_cont_header_df'[renew_method_name] <> "一次性合同"`;
const DAX_RENEWED = `'dwd_cont_header_df'[is_renewed_name] = "已续签"`;
const DAX_NOT_RENEWED = `'dwd_cont_header_df'[is_renewed_name] = "未续签"`;

// parentKey 指向上一级的 metric_code
const metrics = [
  {
    metric_code: 'cont_income_amount',
    metric_name: '收入合同金额',
    biz_def: '对外签订的收入类合同金额汇总，排除支出合同。通过 is_out=1 筛选（L1）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${BASE_WHERE}`,
    dax_def: dax('cont_income_amount', [DAX_IS_OUT]),
    formula: '合同总金额 WHERE is_out = 1',
    parentKey: 'cont_total_amount',
    sort_order: 120
  },
  {
    metric_code: 'cont_income_valid_amount',
    metric_name: '有效收入合同金额',
    biz_def: '处于有效状态的收入合同金额汇总。排除已作废、已终止、审批中等非生效状态，仅保留"扫描件已归档"、"审批通过"、"自动顺延合同审批通过"三种有效状态（L2）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${VALID_WHERE}`,
    dax_def: dax('cont_income_valid_amount', [DAX_IS_OUT, DAX_VALID]),
    formula: '收入合同金额 WHERE state_display IN (扫描件已归档, 审批通过, 自动顺延合同审批通过)',
    parentKey: 'cont_income_amount',
    sort_order: 130
  },
  {
    metric_code: 'cont_income_core_amount',
    metric_name: '核心收入合同金额',
    biz_def: '有效收入合同中，排除子合同、备忘录、终止合同后的核心合同金额汇总（L3）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${CORE_WHERE}`,
    dax_def: dax('cont_income_core_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE]),
    formula: '有效收入合同金额 WHERE contract_type_std NOT IN (子合同, 备忘录, 终止合同)',
    parentKey: 'cont_income_valid_amount',
    sort_order: 140
  },
  {
    metric_code: 'cont_report_income_amount',
    metric_name: '报表口径收入合同金额',
    biz_def: '核心收入合同中纳入报表主体的合同金额汇总。筛选条件：is_report_included = 1（L4）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${REPORT_WHERE}`,
    dax_def: dax('cont_report_income_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE, DAX_REPORT]),
    formula: '核心收入合同金额 WHERE is_report_included = 1',
    parentKey: 'cont_income_core_amount',
    sort_order: 150
  },
  {
    metric_code: 'cont_onetime_amount',
    metric_name: '一次性合同金额',
    biz_def: '报表口径收入合同中，续签方式为"一次性合同"的合同金额汇总（L5）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${ONETIME_WHERE}`,
    dax_def: dax('cont_onetime_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE, DAX_REPORT, DAX_ONETIME]),
    formula: null,
    parentKey: 'cont_report_income_amount',
    sort_order: 160
  },
  {
    metric_code: 'cont_due_renewal_amount',
    metric_name: '应续签合同金额',
    biz_def: '报表口径收入合同中，排除一次性合同后的应续签合同金额汇总（L5）。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${DUE_WHERE}`,
    dax_def: dax('cont_due_renewal_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE, DAX_REPORT, DAX_DUE]),
    formula: null,
    parentKey: 'cont_report_income_amount',
    sort_order: 165
  },
  {
    metric_code: 'cont_renewed_amount',
    metric_name: '已续签合同金额',
    biz_def: '应续签合同中，已完成续签的合同金额汇总（L6）。筛选条件：is_renewed_name = "已续签"。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${RENEWED_WHERE}`,
    dax_def: dax('cont_renewed_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE, DAX_REPORT, DAX_DUE, DAX_RENEWED]),
    formula: null,
    parentKey: 'cont_due_renewal_amount',
    sort_order: 170
  },
  {
    metric_code: 'cont_not_renewed_amount',
    metric_name: '未续签合同金额',
    biz_def: '应续签合同中，尚未完成续签的合同金额汇总（L6）。筛选条件：is_renewed_name = "未续签"。',
    tech_def: `SELECT SUM(total_amount) FROM dwd_cont_header_df\nWHERE ${NOT_RENEWED_WHERE}`,
    dax_def: dax('cont_not_renewed_amount', [DAX_IS_OUT, DAX_VALID, DAX_CORE, DAX_REPORT, DAX_DUE, DAX_NOT_RENEWED]),
    formula: null,
    parentKey: 'cont_due_renewal_amount',
    sort_order: 176
  }
];

async function main() {
  const login = await request('POST', '/api/auth/login', { username: 'admin', password: process.env.API_PASSWORD || 'change_me_on_first_login' });
  const token = login.token;
  console.log('Login OK\n');

  // ID 映射
  const ids = { cont_total_amount: 53 };

  for (const m of metrics) {
    const { parentKey, ...rest } = m;
    const payload = {
      ...rest,
      parent_metric_id: ids[parentKey],
      domain_id: 1,
      metric_type: 'derived',
      data_type: 'DECIMAL',
      unit: '元',
      source_table: 'dwd_cont_header_df',
      linked_model_id: 52
    };

    const r = await request('POST', '/api/metrics', payload, token);
    if (r.id) {
      ids[m.metric_code] = r.id;
      console.log(`✅ ${m.metric_name} (${m.metric_code}) → ID:${r.id} | parent:${ids[parentKey]}`);
    } else {
      console.log(`❌ ${m.metric_code}:`, JSON.stringify(r));
    }
  }

  console.log('\n全部完成，共创建', Object.keys(ids).length - 1, '个派生指标');
}

main().catch(e => console.error(e));
