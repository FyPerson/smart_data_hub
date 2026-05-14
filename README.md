# Smart Data Hub · 智数协同平台

> 面向中小型数据团队（5-20 人）的轻量级一站式工作台。集成 **任务协作 / 数据建模 / 指标管理 / 文档知识库** 四块能力，配合数仓建设的全流程。

[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-3.x-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ 项目背景

这是一个**真实生产环境运行**的内部协作平台（不是示例项目）。从 2024 年起累积约 18 个月的迭代，服务一个 ~20 人规模的数据团队，覆盖数仓建设、报表交付、跨部门数据需求协作的端到端流程。

本仓库是**脱敏后的代码快照**，移除了：
- 公司业务上下文（合作方、客户、业务域）
- 真实生产数据（任务记录、用户数据、附件）
- 内部凭证（IP、数据库账号、API key、密钥）

保留了完整的技术架构、所有核心功能模块、以及可独立运行的能力。

## 🎯 核心模块

| 模块 | 解决什么问题 | 关键技术 |
|---|---|---|
| **任务协作** | 数据需求 → 开发任务 → 审核 → 验收 → 归档的全生命周期闭环；多角色协作（Admin / Publisher / Developer / Viewer） | 状态机 + 操作日志 + 工作流持久化 |
| **数据协作模块**（D3 系列）| 跨部门临时取数需求收集 → SQL 智能验证 → 钉钉通知 → 协作摩擦归因记录 | **4 层 SQL 安全防御** / Mutex 全局互斥 / 启动恢复 / 钉钉机器人推送 |
| **模型中心** | ODS/DIM/DWD 模型注册 → DDL 自动生成 → ETL 脚本生成 → FDL 调度配置脚本生成 | 模板引擎 + 模型版本控制 |
| **指标中心** | 业务指标定义 → 版本控制 → 父子层级 → 标签筛选 → 依赖关系 | DAG 依赖图 + 软删除版本 |
| **统计中心** | 数仓建设进度、任务交付、用户活跃度的可视化 | ECharts |
| **文档中心** | Markdown 文档浏览、分类、标签 | marked.js |
| **用户管理** | 基于角色的权限控制 + 钉钉用户绑定 | JWT + BCrypt + 钉钉企业 API |

## 🛡 SQL 安全 4 层防御（技术亮点）

数据协作模块允许业务方提交 SQL 取数需求，平台跑 smoke test 验证 SQL 是否能在业务库上正常执行。**用户输入 SQL → 真实跑在生产 SQL Server** 是经典安全攻击面，本项目实现 4 层纵深防御：

```
开发上传 SQL
   ↓
[层 0] 词法状态机 token 扫描
   先挖除字符串字面值/注释/方括号标识符，再扫危险关键字
   黑名单：EXEC/EXECUTE/WAITFOR/OPENROWSET/OPENDATASOURCE/OPENQUERY/BULK
          + xp_*/sp_* 系列扩展存储过程
   ↓
[层 1] node-sql-parser AST 解析
   解析失败拒 / 多语句拒 / 非 SELECT 语句拒
   ↓
[层 2] AST walker 递归校验
   SELECT INTO 拒 / 跨库三段名拒 / 两段名歧义拒 / UNION 边界处理
   ↓
[层 3] TOP 100 智能注入
   AST 节点级注入 TOP 100，sqlify 失败直接拒（不字符串包外层 fallback）
   ↓
拿到只读账号连接池 → 真实执行 → 20s 超时
```

配合**纵深防御策略**：源数据库账号本身 `GRANT SELECT only` + DBA 撤销 `xp_*/sp_*` 执行权 + 关闭 `Ad Hoc Distributed Queries`。应用层 + 数据库层双重隔离。

更多细节见 [`wbs-server/utils/sql-validator.js`](wbs-server/utils/sql-validator.js)（约 430 行，含 ~50 端到端测试用例）。

## 🧰 技术栈

| 层级 | 技术 | 备注 |
|---|---|---|
| 前端 | HTML5 + CSS3 + 原生 JavaScript | 无构建工具，单 HTML 文件应用，面向小团队部署友好 |
| 后端 | Node.js 18+ + Express | 单体应用，便于部署 |
| 数据库 | SQLite 3 | 平台元数据存储 |
| 业务库 | SQL Server / MySQL | 通过 `db_connections` 表配置多源连接 |
| 认证 | JWT + BCrypt | 单点登录，token 即时失效 |
| 可视化 | ECharts | 统计图表 |
| 进程管理 | PM2 | 生产部署 |
| 钉钉集成 | 钉钉企业内部应用 API | 单点推送 + 已读回执 |
| SQL 解析 | node-sql-parser | SQL 安全验证 |

## 📦 项目结构

```
smart-data-hub-public/
├── README.md                        # 本文档
├── LICENSE                          # MIT License
├── scripts/
│   ├── deploy-ssh.ps1               # 远程部署脚本（PowerShell）
│   ├── api-call.js                  # API 调用 CLI 工具
│   └── setup_server_env.ps1         # 服务器环境初始化
├── docs/
│   ├── guide/                       # 用户手册
│   └── standard/                    # 数仓开发通用标准（分层 / 命名 / 验收）
└── wbs-server/
    ├── server.js                    # Express 主程序（~11000 行，按模块组织）
    ├── package.json
    ├── .env.example                 # 环境变量模板
    ├── utils/
    │   ├── sql-validator.js         # SQL 4 层防御
    │   ├── dingtalk-notify.js       # 钉钉通知模块
    │   ├── collab-attachment-versioning.js  # 附件版本化 + 启动巡检
    │   └── collab-submit-helpers.js # 提交流程辅助 + Mutex + 真实 smoke test
    ├── scripts/
    │   ├── test-sql-validator-e2e.js        # SQL 验证 50 用例端到端
    │   ├── test-sql-validator-layer0.js     # 层 0 词法 38 用例
    │   ├── test-collab-submit-e2e.js        # 提交 endpoint 6 用例
    │   ├── test-collab-bypass-e2e.js        # 旁路 endpoint 14 用例
    │   ├── test-collab-friction-e2e.js      # 协作摩擦 15 用例
    │   ├── test-mutex-unit.js               # Mutex 单元测试
    │   ├── test-collab-resume.js            # 启动恢复 3 场景
    │   └── ast-snapshot-probe.js            # T-SQL AST 探针（编码前先看真相）
    └── public/                      # 前端静态文件
        ├── Task_Pool.html           # 任务池
        ├── Data_Collab.html         # 数据协作模块
        ├── Model_Center.html        # 模型中心
        ├── Metrics.html             # 指标中心
        ├── Statistics.html          # 统计中心
        ├── Asset_Center.html        # 资产中心
        ├── Doc_Viewer.html          # 文档中心
        ├── admin.html               # 管理后台
        ├── login.html               # 登录
        └── assets/                  # 静态资源
            ├── css/style.css
            └── js/app.js
```

## 🚀 快速开始

### 环境要求

- Node.js ≥ 18
- npm ≥ 9

### 安装与运行

```bash
cd wbs-server

# 安装依赖
npm install

# 复制环境变量模板并修改
cp .env.example .env
# 编辑 .env，至少修改：
#   JWT_SECRET（建议 openssl rand -base64 32）
#   DB_ENCRYPTION_KEY（32 bytes 随机串）

# 启动
npm start
```

首次启动会自动创建 `task_pool.db`（SQLite）并初始化默认管理员：

```
用户名: admin
密码:   change_me_on_first_login
```

**首次登录后请立刻修改密码**。

访问 http://localhost:3000

> ⚠️ **首次启动注意**：第一次 `npm start` 时，由于 SQLite 表创建和启动巡检任务存在 race condition，可能在创建完默认管理员后进程退出（stderr 会看到 `SQLITE_ERROR: no such table` 多条）。**此时 `task_pool.db` 已正确生成 + 默认账号已创建 + 所有 ALTER 已跑完**。再跑一次 `npm start` 即可正常 listen 端口。这是已知 issue，长期运行不会触发。

### 部署到生产服务器

```powershell
# Windows 远程部署（参考 scripts/deploy-ssh.ps1）
# 需提前配置 SSH 免密 + git production remote
.\scripts\deploy-ssh.ps1
```

## 🧪 测试

```bash
cd wbs-server

# SQL 验证器测试
node scripts/test-sql-validator-layer0.js   # 38 用例
node scripts/test-sql-validator-e2e.js      # 50 用例（需配置目标业务库）

# 数据协作模块端到端
node scripts/test-collab-submit-e2e.js      # 6 用例
node scripts/test-collab-bypass-e2e.js      # 14 用例
node scripts/test-collab-friction-e2e.js    # 15 用例

# Mutex 与启动恢复
node scripts/test-mutex-unit.js
node scripts/test-collab-resume.js
```

## 🧬 设计决策与迭代过程

本项目的关键模块都经过多轮迭代 + 严格的安全审查。一些代表性决策：

- **SQL 安全 4 层防御**：从最初"AST 主防线 + 正则字符串字面量挖除兜底"升级到 4 层纵深，因为发现 `OPENROWSET / EXEC / WAITFOR` 直接走 node-sql-parser 会解析失败
- **附件版本化**：开发可覆盖式重传 SQL → 旧版本进入 `superseded` 状态而非物理删除 → 启动巡检识别 orphan 文件
- **smoke test 全局互斥**：单实例部署 + 长跑 SQL（最长 20s）→ 用 FIFO Mutex 队列（显式 `locked + waiters` 状态机）防止并发雪崩；超时回到 `queued` 状态前端可重试
- **状态机字段 UPDATE 三件套**：双条件守卫（status + sql_validation_status）+ changes 检查 + 失败阻断业务
- **协作摩擦归因记录**：DONE 后由 admin 标注（需求不清 / 技术误解 / 其他），用于运营复盘

## 📐 数仓建设规范

`docs/standard/` 提供数仓建设的通用规范，可独立参考：

- [分层标准](docs/standard/分层标准.md) - ODS / DWD / DIM / DWS 分层语义
- [命名标准](docs/standard/命名标准.md) - 表名 / 字段名 / 任务名命名规则
- [通用字段标准](docs/standard/通用字段标准.md) - 审计字段 / 加密字段 / 软删除字段
- [DIM 层开发验收规范](docs/standard/DIM层开发验收规范.md) - 维度表全量初始化 + 增量 hash 一致性校验
- [数据仓库术语说明](docs/standard/数据仓库术语说明.md) - 内部术语对照表

## 📜 License

MIT License - 详见 [LICENSE](LICENSE)

## ⚠️ 安全注意

本仓库默认配置仅用于本地开发。生产部署前**必须**：

1. 修改 `JWT_SECRET` 为高强度随机串（≥ 32 bytes）
2. 修改 `DB_ENCRYPTION_KEY` 为 32 bytes 随机串
3. 通过 admin 后台修改默认 admin 密码
4. 配置反向代理（Nginx / Caddy）+ HTTPS
5. 数据库账号本身配置 `GRANT SELECT only`（应用层 SQL 验证不可作为唯一防线）
6. 审计生产部署的网络隔离策略

## 🙏 致谢

- [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) - SQL AST 解析
- [ECharts](https://echarts.apache.org/) - 可视化
- [Express](https://expressjs.com/) - 后端框架
