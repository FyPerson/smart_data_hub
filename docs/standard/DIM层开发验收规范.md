# DIM 层开发验收规范

> **版本**: v1.1
> **创建日期**: 2026-01-26
> **更新日期**: 2026-01-26
> **适用范围**: 公共维度层（DIM）表的开发与验收

---

## 一、概述

本规范定义 DIM（公共维度层）表开发的标准流程和验收要求，确保维度表开发质量和交付物完整性。

### 1.1 DIM 层特点

| 特点 | 说明 |
|------|------|
| SCD 类型 | 支持 SCD1（直接覆盖）和 SCD2（历史版本追踪） |
| 数据来源 | 主要来自 ODS 层，可能关联多张源表和字典表 |
| 更新频率 | T+1 批量更新 |
| 质量要求 | 高（下游 DWD/DWS 层依赖） |

---

## 二、开发流程

```
需求分析 → 模型设计 → 脚本开发 → 自测验证 → 代码评审 → 归档发布
```

---

## 三、交付物清单

### 3.1 必须提交的脚本

DIM 层开发完成后，必须提交以下 **4 类脚本**：

| 序号 | 脚本类型 | 文件命名规范 | 说明 |
|------|----------|--------------|------|
| 01 | **DDL 建表** | `01_dim_ddl_xxx表建表.sql` | 表结构、索引、约束 |
| 02 | **全量初始化** | `02_dim_etl_init_全量初始化.sql` | 首次加载历史数据 |
| 03 | **增量 ETL** | `03_dim_etl_incr_xxx_增量ETL.sql` | 日常 T+1 增量更新（可提供多版本） |
| 04 | **审计规则** | `04_audit_rule_审计规则.md` | 审计类型和监控字段说明 |

**增量 ETL 脚本版本说明**：

| 版本 | 文件后缀 | 用途 |
|------|----------|------|
| SSMS 版 | `_ssms_增量ETL手动执行.sql` | 在 SSMS 中手动执行，含 PRINT 输出 |
| FDL 版 | `_fdl_增量ETL调度执行.sql` | FineDataLink 数据开发任务，使用 `${cyctime}` 参数 |

> 两个版本的核心逻辑一致，仅批次号获取方式和输出方式不同。生产环境建议使用 FDL 版进行自动化调度。

### 3.2 目录结构示例

```
E:\projects\data-warehouse\docs\dim_xxx\        （数仓线独立仓·2026-08-08 迁出）
├── 01_dim_ddl_xxx表建表.sql
├── 02_dim_etl_init_全量初始化.sql
├── 03_dim_etl_incr_ssms_增量ETL手动执行.sql   # SSMS 手动执行版
├── 03_dim_etl_incr_fdl_增量ETL调度执行.sql    # FDL 调度版（推荐）
└── 04_audit_rule_审计规则.md
```

---

## 四、各脚本规范

### 4.1 DDL 建表脚本

**必须包含**：

| 内容 | 说明 |
|------|------|
| 代理键 | `sk_xxx BIGINT IDENTITY(1,1) PRIMARY KEY` |
| 业务键 | 源系统主键字段 |
| 业务字段 | 需要追踪的业务属性 |
| SCD 控制字段 | `dw_eff_dt`, `dw_exp_dt`, `dw_is_current_flg` |
| 审计字段 | `dw_load_ts`, `dw_src_sys`, `dw_batch_id` |
| 字段注释 | 所有字段必须有中文注释 |
| 索引 | 业务键索引、当前版本索引 |

**SCD2 控制字段规范**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dw_eff_dt` | DATE | 版本生效日期 |
| `dw_exp_dt` | DATE | 版本失效日期（当前版本为 9999-12-31） |
| `dw_is_current_flg` | BIT | 是否当前版本（1=是, 0=否） |
| `dw_is_initial_flg` | BIT | 是否期初版本（1=是, 0=否） |

---

### 4.2 全量初始化脚本

**执行时机**：建表后执行一次

**必须包含**：

| 步骤 | 说明 |
|------|------|
| 批次号声明 | `@batch_id = 'INIT_' + FORMAT(GETDATE(), 'yyyyMMddHHmmss')` |
| 清空目标表 | `TRUNCATE TABLE dim_xxx` |
| 版本链计算 | 使用窗口函数计算生效/失效日期 |
| 数据加载 | 插入全量历史数据 |
| 结果验证 | 输出加载统计信息 |

---

### 4.3 增量 ETL 脚本

**执行时机**：每日 T+1 调度

**必须包含的步骤**：

| 步骤 | 说明 | 审计类型 |
|------|------|----------|
| Step 1 | 删除检测 | DELETED |
| Step 2 | 变更检测与版本更新 | MODIFIED |
| Step 3 | 新增记录插入 | - |
| Step 4 | 版本链完整性修复 | REBUILD |
| Step 5 | 一致性校验 | INCONSISTENT |

---

### 4.4 审计规则文档

每个 DIM 表必须提交审计规则说明文档，模板见第五节。

---

## 五、审计规则模板

```markdown
# dim_xxx 审计规则

## 基本信息

| 项目 | 内容 |
|------|------|
| 表名 | dim_xxx |
| 数据层级 | DIM |
| SCD 类型 | SCD2 |
| 审计表 | dw_audit_log（公共） |

## 审计类型配置

| 审计类型 | 触发条件 | 审计级别 | 记录内容 |
|----------|----------|----------|----------|
| DELETED | 源表记录删除 | WARN | 完整快照 |
| MODIFIED | 业务字段变更 | INFO | before/after + diff_fields |
| REBUILD | 版本链异常修复 | INFO | 修复详情 |
| INCONSISTENT | DIM与源表数据不一致 | ERROR | 差异字段对比 |

## 监控字段范围

### 监控字段（参与变更检测）

| 字段名 | 说明 |
|--------|------|
| xxx_name | xxx名称 |
| xxx_code | xxx编码 |
| ... | ... |

### 非监控字段（不参与变更检测）

| 字段名 | 说明 | 不监控原因 |
|--------|------|------------|
| dw_eff_dt | 生效日期 | ETL 控制字段 |
| dw_load_ts | 加载时间 | 审计字段 |
| ... | ... | ... |

## diff_fields 示例

变更时记录的差异字段格式：

```
name, customer_line_id, org_id
```

## 审计记录示例

### DELETED 示例
```json
{
  "audit_type": "DELETED",
  "table_name": "dim_xxx",
  "data_layer": "DIM",
  "record_key": "{\"xxx_id\": 123}",
  "audit_level": "WARN",
  "audit_detail": "{\"snapshot\": {...完整字段快照...}}"
}
```

### MODIFIED 示例
```json
{
  "audit_type": "MODIFIED",
  "table_name": "dim_xxx",
  "data_layer": "DIM",
  "record_key": "{\"xxx_id\": 123, \"change_id\": 456}",
  "audit_level": "INFO",
  "diff_fields": "name, org_id",
  "audit_detail": "{\"before\": {...}, \"after\": {...}}"
}
```
```

---

## 六、验收检查清单

### 6.1 脚本完整性检查

| 检查项 | 通过 |
|--------|------|
| 01_DDL 建表脚本已提交 | [ ] |
| 02_全量初始化脚本已提交 | [ ] |
| 03_增量 ETL 脚本已提交 | [ ] |
| 04_审计规则文档已提交 | [ ] |

### 6.2 DDL 检查

| 检查项 | 通过 |
|--------|------|
| 包含代理键（sk_xxx） | [ ] |
| 包含业务键字段 | [ ] |
| 包含 SCD 控制字段（dw_eff_dt, dw_exp_dt, dw_is_current_flg） | [ ] |
| 包含审计字段（dw_load_ts, dw_src_sys, dw_batch_id） | [ ] |
| 所有字段有中文注释 | [ ] |
| 业务键有索引 | [ ] |

### 6.3 ETL 检查

| 检查项 | 通过 |
|--------|------|
| 初始化脚本可正确执行 | [ ] |
| 增量脚本包含删除检测 | [ ] |
| 增量脚本包含变更检测 | [ ] |
| 增量脚本包含一致性校验 | [ ] |
| 审计日志正确写入 dw_audit_log | [ ] |

### 6.4 数据质量检查

| 检查项 | 通过 |
|--------|------|
| 当前版本记录数 = 业务键去重数 | [ ] |
| dw_is_current_flg=1 的记录 dw_exp_dt='9999-12-31' | [ ] |
| 无重复的当前版本记录 | [ ] |
| 版本链连续（前一版本失效日期 = 后一版本生效日期） | [ ] |

---

## 七、参考文档

- 审计日志表 DDL：`E:\projects\data-warehouse\docs\_common\01_dw_audit_log_ddl_审计日志表建表_v2.sql`（数仓线独立仓·2026-08-08 迁出）
- dim_official_customer 示例：`E:\projects\data-warehouse\docs\dim_official_customer\`（同上）
- [DWD 开发验收流程](../local/DWD开发验收流程.md)

---

*文档版本: v1.1 | 更新日期: 2026-01-26*
