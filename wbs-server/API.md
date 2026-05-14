# 智数协同平台 API 文档

## 概述

- **基础URL**: `http://localhost:3000`
- **认证方式**: JWT Bearer Token
- **Content-Type**: `application/json` (除文件上传外)

## 认证

### 登录
```
POST /api/auth/login
```
**请求体**:
```json
{
  "username": "string",
  "password": "string"
}
```
**响应**:
```json
{
  "token": "jwt_token",
  "user": { "id": 1, "username": "admin", "role": "admin", "display_name": "管理员" }
}
```

### 新建用户（管理员）
```
POST /api/users
Authorization: Bearer <token>
```
**权限**: admin

---

## 任务管理

### 获取任务列表
```
GET /api/pool
Authorization: Bearer <token>
```

### 创建任务
```
POST /api/create
Authorization: Bearer <token>
```
**权限**: admin, publisher
**请求体**:
```json
{
  "title": "任务标题（必填，1-200字符）",
  "desc": "任务描述（可选）",
  "category": "ODS_SYNC|DIM_DEV|DWD_DEV|ADS_RPT|DATA_FIX",
  "priority": "P0|P1|P2|P3",
  "linked_model_id": "可选，关联模型ID"
}
```

### 批量创建任务
```
POST /api/create/batch
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 领取任务
```
POST /api/claim
Authorization: Bearer <token>
```
**请求体**: `{ "id": 1 }`

### 获取单个任务详情
```
GET /api/tasks/:id
Authorization: Bearer <token>
```

### 提交任务
```
POST /api/submit2
Authorization: Bearer <token>
Content-Type: multipart/form-data
```
**字段**: `id` / `submission` / `attachmentTypes`（JSON 数组）/ `files`（多附件）
**约束**: 仅任务 owner 或 admin/publisher 可提交；任务必须处于 CLAIMED 状态。

### 确认/归档任务
```
POST /api/confirm
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 放弃任务
```
POST /api/unclaim
Authorization: Bearer <token>
```
**权限**: 任务 owner 或 admin/publisher

### 撤回任务
```
POST /api/withdraw
Authorization: Bearer <token>
```
**权限**: 任务 owner 或 admin/publisher；仅 DONE 状态可撤回

### 删除任务
```
POST /api/delete
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 重新打开任务
```
POST /api/reopen
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 更新任务
```
POST /api/update
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 分配任务
```
POST /api/tasks/:id/assign
Authorization: Bearer <token>
```
**权限**: admin, publisher

### 标记存疑（ON_HOLD）
```
POST /api/tasks/:id/hold
Authorization: Bearer <token>
```
**请求体**: `{ "reason": "存疑原因" }`
**权限**: 任务 owner 或 admin/publisher

### 解除存疑
```
POST /api/tasks/:id/resolve
Authorization: Bearer <token>
```
**请求体**: `{ "reason": "可选说明" }`
**权限**: 任务 owner 或 admin/publisher

### 获取任务附件
```
GET /api/tasks/:id/attachments
Authorization: Bearer <token>
```
> 兼容旧路径 `GET /api/attachments/:taskId`

---

## 附件管理

> 附件通过 `POST /api/submit2` 的 multipart 一并上传，没有独立上传接口。获取附件见"获取任务附件"。

---

## 模型管理

### 获取模型列表
```
GET /api/models
Authorization: Bearer <token>
```

### 检查模型名称
```
GET /api/models/check?name=xxx
Authorization: Bearer <token>
```

### 创建模型
```
POST /api/models
Authorization: Bearer <token>
```

### 更新模型
```
PUT /api/models/:id
Authorization: Bearer <token>
```

### 删除模型
```
DELETE /api/models/:id
Authorization: Bearer <token>
```
**权限**: admin, publisher

---

## 主题域管理

### 获取主题域列表
```
GET /api/domains
Authorization: Bearer <token>
```

### 创建主题域
```
POST /api/domains
Authorization: Bearer <token>
```
**权限**: admin

### 更新主题域
```
PUT /api/domains/:id
Authorization: Bearer <token>
```
**权限**: admin

### 删除主题域
```
DELETE /api/domains/:id
Authorization: Bearer <token>
```
**权限**: admin

---

## 源系统管理

### 获取源系统列表
```
GET /api/source-systems
Authorization: Bearer <token>
```

### 创建源系统
```
POST /api/source-systems
Authorization: Bearer <token>
```
**权限**: admin

### 删除源系统
```
DELETE /api/source-systems/:id
Authorization: Bearer <token>
```
**权限**: admin

---

## 用户管理

### 获取用户列表（管理员）
```
GET /api/users
Authorization: Bearer <token>
```
**权限**: admin

### 获取活跃用户（普通用户可用，用于下拉/指派）
```
GET /api/users/active
Authorization: Bearer <token>
```

---

## 状态码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未认证或token无效 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 413 | 文件过大 |
| 500 | 服务器错误 |

---

## 任务类型

| 代码 | 说明 |
|------|------|
| ODS_SYNC | ODS同步 |
| DIM_DEV | DIM开发 |
| DWD_DEV | DWD开发 |
| ADS_RPT | ADS报表 |
| DATA_FIX | 数据修复 |

## 任务状态

| 状态 | 说明 |
|------|------|
| OPEN | 待领取 |
| CLAIMED | 进行中 |
| HOLD | 暂挂 |
| DONE | 待验收 |
| ARCHIVED | 已归档 |

## 用户角色

| 角色 | 权限 |
|------|------|
| admin | 全部权限 |
| publisher | 任务发布、管理 |
| developer | 领取、开发任务 |
| viewer | 只读查看 |
