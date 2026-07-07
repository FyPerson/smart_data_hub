import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'node', args: ['e:\\数据开发与治理规范手册\\mcp-sandbox\\index.js'] });
const client = new Client({ name: 'ac', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const exec = async (sql) => (await client.callTool({ name: 'execute_sandbox', arguments: { sql } })).content.map(c => c.text).join('\n');
const q = async (sql) => (await client.callTool({ name: 'query_sandbox', arguments: { sql } })).content.map(c => c.text).join('\n');

const T = 'dwd_tight_salary_metric_month_df';
const cols = [
  ['metric_month', '统计月份(yyyy-MM)'],
  ['build_company_id', '项目部ID(业务主键之一,= dim_build_company.build_company_id)'],
  ['build_company_name', '项目部名称'],
  ['customer_id', '客户ID'],
  ['customer_name', '客户单位名称'],
  ['org_id', '分公司ID'],
  ['org_name', '分公司名称'],
  ['business_type_id', '业务类别ID(11=业务分包(紧密型))'],
  ['business_type_name', '业务类别名称'],
  ['custom_staff_ids', '客服人员IDs(逗号分隔的BMS StaffID,下游据此把项目部指标归集到95人白名单/交付人员)'],
  ['settle_count', '结算条数(ods_statement_df: StatementType=1 AND State=3, 按项目部+当月计数)[已抽检验证]'],
  ['invoice_amount', '开票金额(SUM InvMoney, 当月为负按0计发-绩效规则)[已抽检验证]'],
  ['invoice_amount_raw', '开票金额原值(未做负数归0,审计留痕)'],
  ['service_headcount', '服务人数(ods_hrd_project_staff_df: state=20901在职快照, 按proId计DISTINCT员工)[已抽检验证;是否限当月在职=R2待业务定]'],
  ['income_contract_count', '收入合同数(经ods_statement_df归集: IsOut=1 AND Status=3)。⚠️项目部级计数:同一合同关联多项目部时各计1次,跨项目部求和会重复(6月合计14871 vs 去重2132);合同→主项目部归集口径=R1待业务定,下游去重后使用'],
  ['dw_load_ts', '数据加载时间'],
  ['dw_update_ts', '数据更新时间'],
  ['dw_src_sys', '来源系统标识'],
  ['dw_batch_id', 'ETL批次号'],
];

console.log('### 补表注释');
console.log(await exec(`
IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id=OBJECT_ID('sandbox.${T}') AND minor_id=0 AND name='MS_Description')
    EXEC sys.sp_dropextendedproperty @name=N'MS_Description', @level0type=N'SCHEMA',@level0name=N'sandbox', @level1type=N'TABLE',@level1name=N'${T}';
EXEC sys.sp_addextendedproperty @name=N'MS_Description',
  @value=N'紧密型算薪·项目部月度量化指标事实表(客观计数底表;粒度=项目部×月;含结算条数/开票金额/服务人数/收入合同数4指标;只存原始计数不乘单价不过滤白名单不算绩效,算薪计算留PBI层;范围=全部紧密型biz=11且有客服的项目部)',
  @level0type=N'SCHEMA',@level0name=N'sandbox', @level1type=N'TABLE',@level1name=N'${T}';
`));

console.log('\n### 补字段注释(逐列)');
for (const [c, desc] of cols) {
  const safe = desc.replace(/'/g, "''");
  const r = await exec(`
IF EXISTS (SELECT 1 FROM sys.extended_properties ep JOIN sys.columns sc ON ep.major_id=sc.object_id AND ep.minor_id=sc.column_id WHERE ep.major_id=OBJECT_ID('sandbox.${T}') AND sc.name='${c}' AND ep.name='MS_Description')
    EXEC sys.sp_dropextendedproperty @name=N'MS_Description', @level0type=N'SCHEMA',@level0name=N'sandbox', @level1type=N'TABLE',@level1name=N'${T}', @level2type=N'COLUMN',@level2name=N'${c}';
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'${safe}',
  @level0type=N'SCHEMA',@level0name=N'sandbox', @level1type=N'TABLE',@level1name=N'${T}', @level2type=N'COLUMN',@level2name=N'${c}';
`);
  console.log(`  ${c}: ${r.includes('成功') ? 'ok' : r}`);
}

console.log('\n### 验证: describe 读回注释(前几列)');
console.log((await client.callTool({ name: 'describe_table', arguments: { table_name: 'sandbox.dwd_tight_salary_metric_month_df' } })).content.map(c=>c.text).join('\n'));

console.log('\n### 数据仍在?');
console.log(await q(`SELECT metric_month, COUNT(*) AS rows FROM sandbox.dwd_tight_salary_metric_month_df GROUP BY metric_month`));

await client.close();
console.log('\n=== DONE ===');
