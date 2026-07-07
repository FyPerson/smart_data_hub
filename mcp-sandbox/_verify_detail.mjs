import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'node', args: ['e:\\数据开发与治理规范手册\\mcp-sandbox\\index.js'] });
const client = new Client({ name: 'vd', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const q = async (sql) => (await client.callTool({ name: 'query_sandbox', arguments: { sql } })).content.map(c => c.text).join('\n');

// 抽检项目部 111776 (嘉兴中移, 底表: settle=32 invoice=2000520.35 service=0 contract=57)
const B = 111776;
console.log(`### 抽检项目部 ${B} — 底表 vs 源表明细对齐`);
console.log('\n-- 底表这一行:');
console.log(await q(`SELECT settle_count, invoice_amount, invoice_amount_raw, service_headcount, income_contract_count FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month='2026-06' AND build_company_id=${B}`));

console.log('\n-- 源表核对 结算/开票 (应 settle=32, invoice_raw=2000520.35):');
console.log(await q(`SELECT COUNT(*) AS settle_cnt, SUM(ISNULL(InvMoney,0)) AS invoice_raw FROM dbo.ods_statement_df WHERE StatementType=1 AND State=3 AND BuildCompanyID=${B} AND StatementTime>='2026-06-01' AND StatementTime<'2026-07-01'`));

console.log('\n-- 源表核对 服务人数 (应 service=0):');
console.log(await q(`SELECT COUNT(DISTINCT staffId) AS svc FROM dbo.ods_hrd_project_staff_df WHERE state='20901' AND proId=${B}`));

console.log('\n-- 源表核对 合同数 (应 contract=57):');
console.log(await q(`SELECT COUNT(DISTINCT sc2.ContractID) AS contract_cnt FROM dbo.ods_statement_df sc2 INNER JOIN dbo.ods_contract_df c ON c.ContractID=sc2.ContractID WHERE sc2.BuildCompanyID=${B} AND sc2.ContractID IS NOT NULL AND c.IsOut=1 AND c.Status=3`));

// 第二个抽检: 5001084 (service=46 有服务人数的)
const B2 = 5001084;
console.log(`\n\n### 抽检项目部 ${B2} (验服务人数口径) — 底表 settle=27 service=46 contract=0`);
console.log(await q(`SELECT settle_count, service_headcount, income_contract_count FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month='2026-06' AND build_company_id=${B2}`));
console.log('-- 源表服务人数(应 46):');
console.log(await q(`SELECT COUNT(DISTINCT staffId) AS svc FROM dbo.ods_hrd_project_staff_df WHERE state='20901' AND proId=${B2}`));

// 全 0 项目部占比(客观事实, 多数项目部当月无量正常)
console.log('\n\n### 全 0 项目部占比(客观事实健康度):');
console.log(await q(`SELECT SUM(CASE WHEN settle_count=0 AND invoice_amount=0 AND service_headcount=0 AND income_contract_count=0 THEN 1 ELSE 0 END) AS all_zero, COUNT(*) AS total FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month='2026-06'`));

await client.close();
console.log('\n=== DONE ===');
