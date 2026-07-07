#!/usr/bin/env node

/*
 * mcp-sandbox — 数仓沙箱 MCP
 *
 * 连接: 192.168.1.196 / Repo, 用低权账号 repo_sandbox。
 * DB 层权限(授权脚本 08 已跑):
 *   - dbo(已有 ODS/DIM/DWD 127 张表): 只读(SELECT), 写被 DENY 硬拦
 *   - sandbox schema: 可读写建删(SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP)
 * 双保险: 除了 DB 层 DENY, 本文件应用层再加一道——
 *   - query_* 走只读白名单(同 warehouse)
 *   - execute_sandbox 走"目标对象必须落 sandbox"守卫, 任何写 dbo 的语句应用层先拒
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import sql from 'mssql';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = join(__dirname, 'config.json');

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('无法读取配置文件:', err.message);
  process.exit(1);
}

const DEFAULT_SCHEMA = config.sandbox.default_schema || 'sandbox';

// 连接池缓存
const pools = new Map();

async function getPool(dbName = 'sandbox') {
  if (pools.has(dbName)) {
    const existingPool = pools.get(dbName);
    if (existingPool.connected) {
      return existingPool;
    }
    pools.delete(dbName);
  }

  const dbConfig = config[dbName];
  if (!dbConfig) {
    throw new Error(`未找到数据库配置: ${dbName}`);
  }

  const poolConfig = {
    server: dbConfig.server,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    options: {
      encrypt: config.options.encrypt,
      trustServerCertificate: config.options.trustServerCertificate,
      requestTimeout: config.options.requestTimeout
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

  const pool = new sql.ConnectionPool(poolConfig);
  await pool.connect();
  pools.set(dbName, pool);
  return pool;
}

// ============================================================
// 只读守卫(同 warehouse: 白名单开头 + 黑名单独立关键词扫描)
// 用于 query_sandbox
// ============================================================
function isReadOnlyQuery(sqlText) {
  const noComments = sqlText.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const normalized = noComments.trim().toUpperCase();
  if (!normalized) return false;

  const statements = normalized.split(/;\s*/).filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!(trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('DECLARE') || trimmed.startsWith('SET @'))) {
      return false;
    }
  }

  const noStrings = normalized.replace(/'[^']*'/g, "''");
  const dmlKeywords = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+INDEX|DROP\s+VIEW|ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+INDEX|CREATE\s+VIEW|EXEC\s|EXECUTE\s|GRANT\s|REVOKE\s)\b/;
  if (dmlKeywords.test(noStrings)) {
    return false;
  }

  return statements.length > 0;
}

// ============================================================
// 沙箱写守卫(execute_sandbox 专用)
// 核心: 任何"落对象"的操作(CREATE/ALTER/DROP TABLE|VIEW, INSERT INTO,
//       UPDATE, DELETE FROM, TRUNCATE)其目标对象必须在 sandbox schema。
// 判定: 拿掉字符串/注释后, 提取每条 DML/DDL 的目标对象名——
//   - 显式带 schema 前缀的, 前缀必须是 sandbox
//   - 不带前缀的, 默认落 sandbox(账号 DEFAULT_SCHEMA=sandbox), 放行
//   - 显式带 dbo. / 其它 schema 前缀的, 拒绝
// 返回 { ok: true } 或 { ok: false, reason }
// ============================================================
function checkSandboxScope(sqlText) {
  const noComments = sqlText.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // 去字符串字面量, 避免 'dbo.xxx' 这类字符串误判
  const noStrings = noComments.replace(/'[^']*'/g, "''");
  const upper = noStrings.toUpperCase();

  if (!upper.trim()) {
    return { ok: false, reason: 'SQL 为空' };
  }

  // 目标对象提取: 匹配写操作动词后紧跟的对象名
  // 覆盖: CREATE/ALTER/DROP TABLE|VIEW, INSERT INTO, UPDATE, DELETE FROM, TRUNCATE TABLE, MERGE INTO
  // 对象名形如 [schema].[name] / schema.name / name / [name]
  const targetPatterns = [
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([^\s(;]+)/g,
    /\bINSERT\s+INTO\s+([^\s(;]+)/g,
    /\bUPDATE\s+([^\s(;]+)\s+SET\b/g,
    /\bDELETE\s+FROM\s+([^\s(;]+)/g,
    /\bTRUNCATE\s+TABLE\s+([^\s(;]+)/g,
    /\bMERGE\s+(?:INTO\s+)?([^\s(;]+)/g,
  ];

  const targets = [];
  for (const re of targetPatterns) {
    let m;
    while ((m = re.exec(upper)) !== null) {
      targets.push(m[1]);
    }
  }

  // 没有写目标 → 可能是纯读 / 纯 SELECT INTO(下面单独处理) / 其它
  // SELECT ... INTO <target> 也会建表, 单独扫
  const selectIntoRe = /\bSELECT\b[\s\S]*?\bINTO\s+([^\s(;]+)/g;
  let sm;
  while ((sm = selectIntoRe.exec(upper)) !== null) {
    targets.push(sm[1]);
  }

  if (targets.length === 0) {
    // 没识别到写目标(如纯 SELECT / SET / DECLARE)——execute_sandbox 允许跑,
    // 反正 DB 层 repo_sandbox 权限兜底; 这里只拦"明确写到 dbo"的场景
    return { ok: true };
  }

  for (const rawTarget of targets) {
    // 去方括号/引号, 拆 schema.name
    const cleaned = rawTarget.replace(/[\[\]"`]/g, '');
    const parts = cleaned.split('.');
    let schemaPart;
    if (parts.length >= 2) {
      // schema.name 或 db.schema.name(取倒数第二段为 schema)
      schemaPart = parts[parts.length - 2];
    } else {
      // 无前缀 → 默认落 sandbox
      schemaPart = DEFAULT_SCHEMA.toUpperCase();
    }
    if (schemaPart.toUpperCase() !== DEFAULT_SCHEMA.toUpperCase()) {
      return {
        ok: false,
        reason: `写目标 "${cleaned}" 不在 ${DEFAULT_SCHEMA} schema(检测到 schema="${schemaPart.toLowerCase()}")。execute_sandbox 只允许写 ${DEFAULT_SCHEMA}.* 对象；读 dbo 请用 query_sandbox。`
      };
    }
  }

  return { ok: true };
}

function addTopLimit(sqlText, limit = 1000) {
  const normalized = sqlText.trim().toUpperCase();
  if (normalized.startsWith('SELECT') && !normalized.includes(' TOP ')) {
    return sqlText.replace(/^SELECT/i, `SELECT TOP ${limit}`);
  }
  return sqlText;
}

const server = new Server(
  { name: 'mcp-sandbox', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query_sandbox',
        description: '在数仓 Repo 库执行只读 SQL 查询(自动限制返回 1000 行)。低权账号 repo_sandbox 连接，可读 dbo(ODS/DIM/DWD 全部表)与 sandbox schema。用于探查源表、验证候选 DWD 结果。',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SELECT SQL 语句(可跨 dbo/sandbox 查询)' },
            limit: { type: 'number', description: '返回行数限制(默认 1000,最大 5000)' }
          },
          required: ['sql']
        }
      },
      {
        name: 'execute_sandbox',
        description: '在 sandbox schema 执行写操作 SQL(CREATE/ALTER/DROP TABLE、INSERT/UPDATE/DELETE、SELECT INTO 等)。用于 MCP 自己建表验证候选 DWD 模型。⚠️ 应用层强制: 写目标对象必须落 sandbox schema(不带前缀默认落 sandbox); 任何写 dbo 会被应用层拒绝, DB 层 repo_sandbox 账号也无 dbo 写权限。多语句用分号分隔，作为一个批次执行。',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: '写操作 SQL(目标对象须为 sandbox.*，或不带前缀)' }
          },
          required: ['sql']
        }
      },
      {
        name: 'describe_table',
        description: '获取表的字段结构信息(字段名、类型、可空、主键、注释)。可查 dbo 或 sandbox 表。',
        inputSchema: {
          type: 'object',
          properties: {
            table_name: { type: 'string', description: '表名(可含 schema，如 dbo.dim_build_company 或 sandbox.xxx)' }
          },
          required: ['table_name']
        }
      },
      {
        name: 'list_tables',
        description: '列出 Repo 库中的表清单，支持按 schema 与名称模糊搜索。默认 dbo；查沙箱建的表传 schema=sandbox。',
        inputSchema: {
          type: 'object',
          properties: {
            schema: { type: 'string', description: 'Schema 名称(默认 dbo；沙箱表用 sandbox)' },
            pattern: { type: 'string', description: '表名模糊匹配(如 dwd_% 或 %salary%)' }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'query_sandbox': {
        const sqlText = args.sql;
        if (!isReadOnlyQuery(sqlText)) {
          return { content: [{ type: 'text', text: '错误：query_sandbox 只允许 SELECT 查询。写操作请用 execute_sandbox(仅限 sandbox schema)。' }] };
        }
        const pool = await getPool('sandbox');
        const limit = Math.min(args.limit || 1000, 5000);
        const safeSql = addTopLimit(sqlText, limit);
        const result = await pool.request().query(safeSql);
        return {
          content: [{
            type: 'text',
            text: `查询成功,返回 ${result.recordset.length} 行\n\n${JSON.stringify(result.recordset, null, 2)}`
          }]
        };
      }

      case 'execute_sandbox': {
        const sqlText = args.sql;
        const scope = checkSandboxScope(sqlText);
        if (!scope.ok) {
          return { content: [{ type: 'text', text: `错误(应用层守卫)：${scope.reason}` }] };
        }
        const pool = await getPool('sandbox');
        // 用 batch() 支持 CREATE/多语句 DDL; recordset 可能为空
        const result = await pool.request().batch(sqlText);
        const affected = Array.isArray(result.rowsAffected)
          ? result.rowsAffected.reduce((a, b) => a + b, 0)
          : (result.rowsAffected || 0);
        let text = `执行成功(sandbox schema)。影响行数: ${affected}`;
        if (result.recordset && result.recordset.length > 0) {
          text += `\n\n返回 ${result.recordset.length} 行:\n${JSON.stringify(result.recordset, null, 2)}`;
        }
        return { content: [{ type: 'text', text }] };
      }

      case 'describe_table': {
        const pool = await getPool('sandbox');
        let schema = 'dbo';
        let tableName = args.table_name;
        if (tableName.includes('.')) {
          const parts = tableName.split('.');
          schema = parts[0];
          tableName = parts[1];
        }
        const result = await pool.request()
          .input('schema', sql.NVarChar, schema)
          .input('table', sql.NVarChar, tableName)
          .query(`
            SELECT
              c.COLUMN_NAME as column_name,
              c.DATA_TYPE as data_type,
              c.CHARACTER_MAXIMUM_LENGTH as max_length,
              c.NUMERIC_PRECISION as precision,
              c.NUMERIC_SCALE as scale,
              c.IS_NULLABLE as is_nullable,
              ISNULL(CAST(ep.value AS NVARCHAR(500)), '') as comment,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE '' END as is_primary_key
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME
              AND sc.object_id = OBJECT_ID(@schema + '.' + @table)
            LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id
              AND ep.minor_id = sc.column_id AND ep.name = 'MS_Description'
            LEFT JOIN (
              SELECT ku.COLUMN_NAME
              FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
              JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
            ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
            ORDER BY c.ORDINAL_POSITION
          `);
        if (result.recordset.length === 0) {
          return { content: [{ type: 'text', text: `表 ${schema}.${tableName} 不存在或无法访问` }] };
        }
        let output = `表 ${schema}.${tableName} 结构(共 ${result.recordset.length} 个字段)\n\n`;
        output += '| 字段名 | 类型 | 可空 | 主键 | 注释 |\n';
        output += '|--------|------|------|------|------|\n';
        for (const col of result.recordset) {
          let typeStr = col.data_type;
          if (col.max_length && col.max_length !== -1) {
            typeStr += `(${col.max_length})`;
          } else if (col.precision) {
            typeStr += `(${col.precision}${col.scale ? ',' + col.scale : ''})`;
          } else if (col.max_length === -1) {
            typeStr += '(MAX)';
          }
          output += `| ${col.column_name} | ${typeStr} | ${col.is_nullable} | ${col.is_primary_key} | ${col.comment} |\n`;
        }
        return { content: [{ type: 'text', text: output }] };
      }

      case 'list_tables': {
        const pool = await getPool('sandbox');
        const schema = args.schema || 'dbo';
        const pattern = args.pattern || '%';
        const result = await pool.request()
          .input('schema', sql.NVarChar, schema)
          .input('pattern', sql.NVarChar, pattern)
          .query(`
            SELECT
              t.TABLE_SCHEMA as schema_name,
              t.TABLE_NAME as table_name,
              t.TABLE_TYPE as table_type,
              ISNULL(CAST(ep.value AS NVARCHAR(500)), '') as table_comment,
              (SELECT SUM(p.rows) FROM sys.partitions p
               WHERE p.object_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
               AND p.index_id IN (0, 1)) as row_count
            FROM INFORMATION_SCHEMA.TABLES t
            LEFT JOIN sys.extended_properties ep
              ON ep.major_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
              AND ep.minor_id = 0 AND ep.name = 'MS_Description'
            WHERE t.TABLE_SCHEMA = @schema
              AND t.TABLE_NAME LIKE @pattern
              AND t.TABLE_TYPE = 'BASE TABLE'
            ORDER BY t.TABLE_NAME
          `);
        let output = `Schema: ${schema},匹配模式: ${pattern}\n`;
        output += `共找到 ${result.recordset.length} 张表\n\n`;
        if (result.recordset.length > 0) {
          output += '| 表名 | 行数 | 注释 |\n';
          output += '|------|------|------|\n';
          for (const t of result.recordset) {
            const rowCount = t.row_count ? t.row_count.toLocaleString() : '0';
            output += `| ${t.table_name} | ${rowCount} | ${t.table_comment} |\n`;
          }
        }
        return { content: [{ type: 'text', text: output }] };
      }

      default:
        return { content: [{ type: 'text', text: `未知工具: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `执行失败: ${err.message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP 服务器启动失败:', err);
  process.exit(1);
});
