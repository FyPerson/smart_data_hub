import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'node', args: ['e:\\数据开发与治理规范手册\\mcp-sandbox\\index.js'] });
const client = new Client({ name: 'build', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const exec = async (sql) => (await client.callTool({ name: 'execute_sandbox', arguments: { sql } })).content.map(c => c.text).join('\n');
const q = async (sql, limit) => (await client.callTool({ name: 'query_sandbox', arguments: { sql, limit } })).content.map(c => c.text).join('\n');

// ============ Step 1: 建表(sandbox schema, 无 dbo 前缀=默认落 sandbox, 但显式写 sandbox. 更清晰) ============
console.log('### Step 1: DROP + CREATE sandbox.dwd_tight_salary_metric_month_df');
console.log(await exec(`
IF OBJECT_ID(N'sandbox.dwd_tight_salary_metric_month_df', N'U') IS NOT NULL
    DROP TABLE sandbox.dwd_tight_salary_metric_month_df;
CREATE TABLE sandbox.dwd_tight_salary_metric_month_df (
    metric_month             CHAR(7)         NOT NULL,
    build_company_id         INT             NOT NULL,
    build_company_name       NVARCHAR(200)   NULL,
    customer_id              INT             NULL,
    customer_name            NVARCHAR(200)   NULL,
    org_id                   INT             NULL,
    org_name                 NVARCHAR(100)   NULL,
    business_type_id         NVARCHAR(20)    NULL,
    business_type_name       NVARCHAR(50)    NULL,
    custom_staff_ids         NVARCHAR(MAX)   NULL,
    settle_count             INT             NOT NULL DEFAULT 0,
    invoice_amount           DECIMAL(18,2)   NOT NULL DEFAULT 0,
    invoice_amount_raw       DECIMAL(18,2)   NOT NULL DEFAULT 0,
    service_headcount        INT             NOT NULL DEFAULT 0,
    income_contract_count    INT             NOT NULL DEFAULT 0,
    dw_load_ts               DATETIME        NOT NULL DEFAULT GETDATE(),
    dw_update_ts             DATETIME        NULL,
    dw_src_sys               VARCHAR(50)     NOT NULL DEFAULT 'BMS+HRD',
    dw_batch_id              VARCHAR(50)     NULL,
    CONSTRAINT PK_sb_dwd_tight_salary PRIMARY KEY CLUSTERED (metric_month, build_company_id)
);
`));

// ============ Step 2: 灌 2026-06 数据 ============
console.log('\n### Step 2: INSERT 2026-06');
console.log(await exec(`
DECLARE @statmonth CHAR(7) = '2026-06';
DECLARE @month_start DATETIME = CAST(@statmonth + '-01' AS DATETIME);
DECLARE @month_end   DATETIME = DATEADD(MONTH, 1, @month_start);
DECLARE @batch_id VARCHAR(50) = 'SANDBOX_' + REPLACE(@statmonth,'-','');

DELETE FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month = @statmonth;

;WITH
scope AS (
    SELECT d.build_company_id, d.build_company_name, d.customer_id, d.customer_name,
           d.org_id, d.org_name, d.business_type_id, d.business_type_name, d.custom_staff_ids
    FROM dbo.dim_build_company d
    WHERE d.business_type_id = '11'
      AND NULLIF(LTRIM(RTRIM(d.custom_staff_ids)), '') IS NOT NULL
),
settle AS (
    SELECT s.BuildCompanyID AS build_company_id, COUNT(*) AS settle_count,
           SUM(ISNULL(s.InvMoney, 0)) AS invoice_amount_raw
    FROM dbo.ods_statement_df s
    WHERE s.StatementType = 1 AND s.State = 3
      AND s.StatementTime >= @month_start AND s.StatementTime < @month_end
    GROUP BY s.BuildCompanyID
),
service AS (
    SELECT ps.proId AS build_company_id, COUNT(DISTINCT ps.staffId) AS service_headcount
    FROM dbo.ods_hrd_project_staff_df ps WHERE ps.state = '20901' GROUP BY ps.proId
),
contract AS (
    SELECT sc2.BuildCompanyID AS build_company_id, COUNT(DISTINCT sc2.ContractID) AS income_contract_count
    FROM dbo.ods_statement_df sc2
    INNER JOIN dbo.ods_contract_df c ON c.ContractID = sc2.ContractID
    WHERE sc2.ContractID IS NOT NULL AND sc2.BuildCompanyID IS NOT NULL
      AND c.IsOut = 1 AND c.Status = 3
    GROUP BY sc2.BuildCompanyID
)
INSERT INTO sandbox.dwd_tight_salary_metric_month_df (
    metric_month, build_company_id, build_company_name, customer_id, customer_name,
    org_id, org_name, business_type_id, business_type_name, custom_staff_ids,
    settle_count, invoice_amount, invoice_amount_raw, service_headcount, income_contract_count,
    dw_load_ts, dw_update_ts, dw_src_sys, dw_batch_id)
SELECT @statmonth, sc.build_company_id, sc.build_company_name, sc.customer_id, sc.customer_name,
    sc.org_id, sc.org_name, sc.business_type_id, sc.business_type_name, sc.custom_staff_ids,
    ISNULL(st.settle_count, 0),
    CASE WHEN ISNULL(st.invoice_amount_raw,0) < 0 THEN 0 ELSE ISNULL(st.invoice_amount_raw,0) END,
    ISNULL(st.invoice_amount_raw, 0),
    ISNULL(sv.service_headcount, 0),
    ISNULL(ct.income_contract_count, 0),
    GETDATE(), NULL, 'BMS+HRD', @batch_id
FROM scope sc
LEFT JOIN settle   st ON st.build_company_id = sc.build_company_id
LEFT JOIN service  sv ON sv.build_company_id = sc.build_company_id
LEFT JOIN contract ct ON ct.build_company_id = sc.build_company_id;
`));

// ============ Step 3: 质检汇总 ============
console.log('\n### Step 3: 质检 - 总行数 + 各指标合计 + 有量项目部数');
console.log(await q(`
SELECT
  COUNT(*) AS total_rows,
  SUM(settle_count) AS sum_settle,
  SUM(invoice_amount) AS sum_invoice,
  SUM(invoice_amount_raw) AS sum_invoice_raw,
  SUM(service_headcount) AS sum_service,
  SUM(income_contract_count) AS sum_contract,
  SUM(CASE WHEN settle_count>0 OR invoice_amount>0 OR service_headcount>0 OR income_contract_count>0 THEN 1 ELSE 0 END) AS builds_with_any_metric
FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month='2026-06'
`));

console.log('\n### Step 4: TOP 10 有结算量的项目部(抽检用)');
console.log(await q(`
SELECT TOP 10 build_company_id, build_company_name, customer_name, custom_staff_ids,
  settle_count, invoice_amount, service_headcount, income_contract_count
FROM sandbox.dwd_tight_salary_metric_month_df WHERE metric_month='2026-06'
ORDER BY settle_count DESC, invoice_amount DESC
`));

await client.close();
console.log('\n=== DONE ===');
