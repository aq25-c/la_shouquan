# API 参考

所有接口返回 JSON（`/admin/api/cdks/export` 除外，返回 CSV）。

---

## 通用约定

- **Base URL**：`http://<host>:8080`
- **请求体**：`Content-Type: application/json`，大小上限 `MAX_BODY_BYTES`（默认 256 KB）
- **时间**：全部为 ISO-8601 UTC 字符串，如 `2027-11-12T08:00:00.000Z`
- **成功响应**：

  ```json
  { "ok": true, "data": { } }
  ```

- **失败响应**：

  ```json
  { "ok": false, "error": { "code": "CDK_NOT_FOUND", "message": "CDK 不存在，请检查输入是否正确", "details": { } } }
  ```

  `details` 可选，`code` 稳定可用于程序判断，`message` 用于展示。

- **鉴权**：需要登录的接口带 `Authorization: Bearer <token>`
  - 客户端会话：`/api/v1/auth/login` 或 `/api/v1/auth/register` 返回
  - 管理员会话：`/admin/api/auth/login` 返回
- **分页**：`?page=1&page_size=20`（`page_size` 上限 200；审计日志上限受 `page_size` 约束）
- **限流**：单 IP `RATE_LIMIT_PER_MIN`（默认 600/分钟）；管理端登录额外限制 10 次/分钟；超限返回 `429 RATE_LIMITED`

---

## 一、公共接口

### GET /healthz
健康检查（Docker HEALTHCHECK 使用）。无需鉴权。

```json
{ "ok": true, "data": { "ok": true, "status": "healthy", "time": "2026-11-12T05:43:47.582Z" } }
```

### GET /api/v1/server-info
服务信息与策略参数。

```json
{
  "ok": true,
  "data": {
    "server": "license-server",
    "version": "1.0.0",
    "heartbeat_interval_hours": 24,
    "offline_grace_days": 7,
    "server_time": "2026-11-12T05:43:47.582Z"
  }
}
```

### GET /api/v1/public-key
许可证验签公钥（内置到客户端）。

```json
{
  "ok": true,
  "data": {
    "kid": "k1",
    "algorithm": "Ed25519",
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n",
    "public_key_b64": "MCowBQYDK2VwAyEA...",
    "created_at": "2026-11-12T05:30:00.000Z"
  }
}
```

---

## 二、客户端接口

### POST /api/v1/auth/register
注册客户账号。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `email` | string | ✅ | 邮箱，≤190 |
| `password` | string | ✅ | 密码，≥8 位 |
| `name` | string | | 显示名 |

```json
{
  "ok": true,
  "data": {
    "customer": { "id": "cus_xx", "email": "buyer@example.com", "name": "张三", "created_at": "…" },
    "session": { "token": "…", "expires_at": "2027-01-01T00:00:00.000Z" }
  }
}
```

错误：`409 EMAIL_TAKEN`（已注册）、`409 WEAK_PASSWORD`、`400 INVALID_EMAIL`。

### POST /api/v1/auth/login
客户登录。参数 `email`、`password`。成功返回 `customer` + `session`。
错误：`401 INVALID_CREDENTIALS`、`403 CUSTOMER_DISABLED`。

### GET /api/v1/auth/me 🔒
当前客户信息 + 其全部授权（含在用设备列表）。需客户 token。

### POST /api/v1/cdks/inspect
预检 CDK，**不核销**。

```json
{
  "ok": true,
  "data": {
    "code": "Q3GP-2WUW-7RFC-XPY2",
    "status": "unused",
    "product": { "code": "app-pro", "name": "专业版客户端" },
    "module_codes": ["core", "report"],
    "days": 365,
    "seats": 2,
    "redeem_before": null,
    "usable": true
  }
}
```

### POST /api/v1/licenses/activate
用 CDK 激活，签发授权与许可证文件。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `cdk` | string | ✅ | 卡密，大小写/分隔符不敏感 |
| `device_id` | string | ✅ | 设备指纹，≤190 |
| `device_name` | string | | 设备显示名 |
| `platform` | string | | 平台标识（`win32`/`darwin`/`linux`） |
| `email` | string | | 绑定/创建客户账号（省略则匿名激活） |
| `password` | string | | 配合 `email`；新账号 ≥8 位 |
| `name` | string | | 账号显示名 |

也可带客户 token（`Authorization`）直接绑到已登录账号。

```json
{
  "ok": true,
  "data": {
    "license": { "id": "lic_xx", "license_no": "LIC-2026-00001", "product_id": "…", "seats": 2,
                 "status": "active", "starts_at": "…", "expires_at": "…", "offline_grace_days": 7,
                 "module_ids": ["mod_a","mod_b"], "last_heartbeat_at": null },
    "license_key": "LK-…",
    "license_file": "eyJ2Ijox….MEUCIQ…",
    "license_payload": { "…" : "…" },
    "offline_expires_at": "…",
    "expires_at": "…",
    "days_left": 365,
    "product": { "code": "app-pro", "name": "专业版客户端" },
    "module_codes": ["core", "report"],
    "heartbeat_interval_hours": 24,
    "server_time": "…",
    "session": { "token": "…", "expires_at": "…" }
  }
}
```

`session` 仅在本次通过 `email`+`password` 新建账号时返回。

错误：`404 CDK_NOT_FOUND`、`409 CDK_ALREADY_USED`、`409 CDK_REVOKED`、`409 CDK_EXPIRED`、`409 PRODUCT_DISABLED`、`401 PASSWORD_REQUIRED`、`401 INVALID_CREDENTIALS`、`409 WEAK_PASSWORD`。

### POST /api/v1/licenses/heartbeat
心跳续期，返回新的签名许可证文件。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `license_key` | ✅ | 激活时返回的密钥 |
| `device_id` | ✅ | 必须已绑定 |

```json
{
  "ok": true,
  "data": {
    "license": { "…": "…" },
    "license_file": "…",
    "license_payload": { "…": "…" },
    "offline_expires_at": "…",
    "expires_at": "…",
    "days_left": 365,
    "module_codes": ["core", "report"],
    "heartbeat_interval_hours": 24,
    "server_time": "…"
  }
}
```

错误：

| HTTP | code | 含义 |
| --- | --- | --- |
| 404 | `INVALID_LICENSE_KEY` | 密钥不存在或已被重置 |
| 404 | `DEVICE_NOT_BOUND` | 该设备未绑定此授权（需重新激活） |
| 403 | `LICENSE_EXPIRED` | 已到期（`details.expires_at`） |
| 403 | `LICENSE_REVOKED` | 已被吊销 |
| 403 | `LICENSE_SUSPENDED` | 已被暂停 |
| 403 | `LICENSE_NOT_STARTED` | 尚未生效（`details.starts_at`） |
| 403 | `CUSTOMER_DISABLED` | 客户账号被停用 |

### POST /api/v1/licenses/enroll
为同一授权加绑新设备（占用一个席位）。

参数：`license_key`（✅）、`device_id`（✅）、`device_name`、`platform`。
成功返回与心跳相同的结构；席位已满返回 `409 SEAT_LIMIT`（`details.seats` / `details.active_devices`）。
设备已绑定时幂等成功（重新签发文件）。

### POST /api/v1/licenses/release
解绑设备，释放席位。参数：`license_key`（✅）、`device_id`（✅）。返回 `{ "released": true|false }`。

### GET /api/v1/licenses 🔒
当前客户的授权列表（需客户 token），每项附带 `devices`（在用设备）。

### GET /api/v1/licenses/:id 🔒
授权详情，含全部设备记录与 `module_codes`。非本人授权返回 `403 FORBIDDEN`。

### POST /api/v1/licenses/:id/rotate-key 🔒
客户自助重置许可证密钥（旧密钥立即失效）。可选 `device_id`，一并返回新的许可证文件。

### POST /api/v1/licenses/:id/devices/:deviceId/release 🔒
客户自助解绑自己的设备。

### POST /api/v1/licenses/:id/reenroll 🔒
重新拉取当前设备的签名许可证。参数 `device_id`（✅）。

---

## 三、管理接口

除 `login` 外全部需要管理员 token：`Authorization: Bearer <token>`，否则 `401 UNAUTHORIZED`。

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/api/auth/login` | `{email, password}` → `{admin, token, expires_at}`；失败 `401 INVALID_CREDENTIALS`；限流 10 次/分钟 |
| POST | `/admin/api/auth/logout` | 使当前会话失效 |
| GET | `/admin/api/auth/me` | `{admin, signing_key, config}` |
| POST | `/admin/api/auth/password` | `{current_password, new_password}`；成功后所有会话失效 |
| GET | `/admin/api/admins` | 管理员列表 |
| POST | `/admin/api/admins` | `{email, password, name}`；密码 ≥10 位 |

### 概览

**GET /admin/api/overview**

```json
{
  "ok": true,
  "data": {
    "stats": {
      "products": 1, "modules": 3, "customers": 2,
      "licenses_total": 3, "licenses_active": 2, "licenses_expiring_7d": 0, "licenses_expired": 0,
      "cdk_unused": 4, "cdk_used": 2, "devices_active": 3, "heartbeats_24h": 3, "stale_devices": 0
    },
    "expiring": [ ],
    "recent_licenses": [ ],
    "config": { "offline_grace_days": 7, "heartbeat_interval_hours": 24, "heartbeat_stale_hours": 72 }
  }
}
```

### 产品与模块

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/products` | 产品列表（含 `module_count`、`license_count`、`active_license_count`、`cdk_unused_count`） |
| POST | `/admin/api/products` | `{code, name, description}`；`code` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`；重复 `409 CODE_TAKEN` |
| PATCH | `/admin/api/products/:id` | `{name?, description?, status?}`；`status`: `active` / `disabled` |
| DELETE | `/admin/api/products/:id` | 有授权或 CDK 时 `409 PRODUCT_IN_USE` |
| GET | `/admin/api/products/:id/modules` | 该产品的模块列表 |
| POST | `/admin/api/products/:id/modules` | `{code, name, description}`；产品内编码唯一 |
| GET | `/admin/api/modules` | 全部模块（含 `product_code`） |
| PATCH | `/admin/api/modules/:id` | `{name?, description?, status?}` |
| DELETE | `/admin/api/modules/:id` | 不影响已签发授权 |

### CDK

**POST /admin/api/cdks/generate**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `product_id` | ✅ | 产品 ID |
| `module_ids` | | 模块 ID 数组（必须属于该产品） |
| `days` | ✅ | 授权天数，1~3650 |
| `seats` | | 席位数，1~100，默认 1 |
| `count` | ✅ | 生成数量，1~5000 |
| `note` | | 批次备注 |
| `redeem_before` | | 兑换截止时间（ISO），过期为不可兑换 |

```json
{
  "ok": true,
  "data": {
    "batch": { "id": "cdb_xx", "product_id": "…", "count": 6, "days": 365, "seats": 2, "module_ids": "[…]", "created_at": "…" },
    "codes": ["Q3GP-2WUW-7RFC-XPY2", "…"],
    "csv": "\ufeffcode,product,days,seats,modules,note\nQ3GP-…,…",
    "product": { "code": "app-pro", "name": "专业版客户端" },
    "module_codes": ["core", "report", "batch"]
  }
}
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/cdks` | 筛选：`product_id`、`batch_id`、`status`(`unused`/`used`/`revoked`)、`q`（码/备注/客户邮箱）、分页 |
| GET | `/admin/api/cdk-batches` | 批次列表（含 `used_count`），可 `?product_id=` |
| POST | `/admin/api/cdks/:id/revoke` | `{reason}`；仅未使用可作废，否则 `409 CDK_NOT_UNUSED` |
| GET | `/admin/api/cdks/export` | 导出 CSV（`?batch_id=` 或 `?product_id=&status=`）；带 BOM，Excel 可直接打开 |

### 客户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/customers` | 筛选：`q`（邮箱/姓名/公司/电话）、`status`、分页；含授权计数与最近到期 |
| GET | `/admin/api/customers/:id` | `{customer, licenses[]}`，每个授权附 `devices` |
| PATCH | `/admin/api/customers/:id` | `{name?, company?, phone?, note?, status?}`；`status`: `active`/`disabled`（停用后心跳立即拒绝） |
| POST | `/admin/api/customers/:id/reset-password` | 生成临时密码（**只返回一次**），并使其所有会话失效 |

### 授权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/licenses` | 筛选：`q`（单号/客户）、`status`(`active`/`expired`/`pending`/`suspended`/`revoked`)、`product_id`、`customer_id`、`expiring_within_days`、分页 |
| GET | `/admin/api/licenses/:id` | `{license, devices[], module_codes[], customer}` |
| PATCH | `/admin/api/licenses/:id` | `{status?, expires_at?, starts_at?, seats?, module_ids?, offline_grace_days?, note?}` |
| POST | `/admin/api/licenses/:id/extend` | `{days, from_now?}`；`days` 可为负；`from_now=true` 从当前时间起算（已过期授权续费建议开启） |
| POST | `/admin/api/licenses/:id/revoke` | `{reason}`，不可恢复 |
| POST | `/admin/api/licenses/:id/reset-devices` | 解绑全部设备，返回 `{released: N}` |
| POST | `/admin/api/licenses/:id/rotate-key` | 重置许可证密钥，返回新 `license_key`（只显示一次） |
| POST | `/admin/api/licenses/:id/reissue` | `{device_id?}`，为指定/首台在用设备重新签发许可证文件 |
| POST | `/admin/api/licenses/:id/devices/:deviceId/release` | 解绑单个设备，返回 `{released}` |
| POST | `/admin/api/licenses` | 手动开通（不走 CDK）：`{product_id, customer_id 或 customer_email, days, seats?, module_ids?, note?}` → 返回 `license` + `license_key` |

**授权对象里 `eff_status` 是计算状态**（按当前时间与状态实时判定）：`active` / `expired` / `pending` / `suspended` / `revoked`。

### 审计与密钥

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/audit` | 筛选 `q`、`action`、`actor_type`，分页；倒序 |
| GET | `/admin/api/signing-key` | 验签公钥信息 |
| GET | `/admin/api/heartbeat-health` | 超过 `HEARTBEAT_STALE_HOURS` 未心跳的有效授权 |

审计动作（`action`）常见值：
`admin.login`、`admin.login_failed`、`admin.logout`、`admin.password_change`、`admin.create`、
`customer.register`、`customer.login`、`customer.login_failed`、`customer.update`、`customer.reset_password`、
`product.create`、`product.update`、`product.delete`、`module.create`、`module.update`、`module.delete`、
`cdk.generate`、`cdk.revoke`、
`license.activate`、`license.create`、`license.update`、`license.extend`、`license.revoke`、
`license.reset_devices`、`license.release_device`、`license.rotate_key`、`license.reissue`。

---

## 四、错误码一览

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `MISSING_FIELD` / `INVALID_FIELD` / `FIELD_TOO_LONG` | 参数缺失或格式错误 |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_EMAIL` / `WEAK_PASSWORD` / `INVALID_CODE` / `INVALID_MODULES` | 字段语义校验失败 |
| 401 | `UNAUTHORIZED` | 未登录或会话过期 |
| 401 | `INVALID_CREDENTIALS` / `PASSWORD_REQUIRED` | 账号密码错误 / 需要密码 |
| 403 | `FORBIDDEN` | 无权访问该资源 |
| 403 | `LICENSE_EXPIRED` / `LICENSE_REVOKED` / `LICENSE_SUSPENDED` / `LICENSE_NOT_STARTED` / `CUSTOMER_DISABLED` / `LICENSE_LOCKED` | 授权不可用 |
| 404 | `NOT_FOUND` | 接口或资源不存在 |
| 404 | `CDK_NOT_FOUND` / `INVALID_LICENSE_KEY` / `DEVICE_NOT_BOUND` | 卡密/密钥/设备找不到 |
| 409 | `CDK_ALREADY_USED` / `CDK_REVOKED` / `CDK_EXPIRED` / `CDK_NOT_UNUSED` | 卡密状态冲突 |
| 409 | `SEAT_LIMIT` | 席位已满 |
| 409 | `EMAIL_TAKEN` / `CODE_TAKEN` / `PRODUCT_IN_USE` / `NO_ACTIVE_DEVICE` | 唯一性或引用冲突 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大 |
| 429 | `RATE_LIMITED` | 触发限流 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

---

## 五、curl 快速验证

```bash
BASE=http://localhost:8080

# 管理员登录并取 token
TOKEN=$(curl -s -X POST $BASE/admin/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"你的密码"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 建产品 + 模块
PRD=$(curl -s -X POST $BASE/admin/api/products -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"app-pro","name":"专业版"}' | grep -o '"id":"prd_[^"]*' | cut -d'"' -f4)
curl -s -X POST $BASE/admin/api/products/$PRD/modules -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"core","name":"核心模块"}'

# 生成 1 个 CDK
curl -s -X POST $BASE/admin/api/cdks/generate -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"product_id\":\"$PRD\",\"days\":365,\"seats\":1,\"count\":1}"

# 客户端：注册 + 激活 + 心跳
curl -s -X POST $BASE/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"buyer@example.com","password":"BuyerPass123"}'
curl -s -X POST $BASE/api/v1/licenses/activate -H 'Content-Type: application/json' \
  -d '{"cdk":"卡密","device_id":"PC-001","email":"buyer@example.com","password":"BuyerPass123"}'
curl -s -X POST $BASE/api/v1/licenses/heartbeat -H 'Content-Type: application/json' \
  -d '{"license_key":"LK-…","device_id":"PC-001"}'
```
