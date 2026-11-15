# 变更说明（客户端相关）

只记录**会影响对接/使用**的改动，按版本从新到旧。完整提交见 git log。

---

## v2.27.0 / v2.27.1（当前）

**设备丢了密钥不用再重置**

- 新增：登录接口在“这台设备已绑定该授权”时，`licenses[]` 里会多返回 `license_key` 和 `key_recovered: true`
- 服务端把密钥加密存一份（`licenses.key_enc`，AES-256-GCM，密钥文件 `data/license-secret.key`）
- 取回方式：`POST /api/v1/auth/login`，带 `username`、`password`、`product_code`、`device_id`
- 老授权（v2.27 之前签发）没有加密副本，取不回；后台重置一次密钥即可写入，之后就能自愈
- 备份要带上 `data/license-secret.key`

**文档**：README、`docs/client-integration.md`、`docs/DEPLOY.md` 全部按新流程重写

---

## v2.26.0

**到期时间精确到秒**

- 后台、门户所有到期/生效相关显示从“到日/到分”改成 `YYYY-MM-DD HH:mm:ss`
- 接口返回本来就是 ISO-8601（带秒），没有变化

---

## v2.25.0 / v2.25.1

- 同一台设备在“试用授权 + 正式授权”里只显示一行（激活时把设备行迁移过去，席位按设备去重）
- 试用转正式不再显示“吊销”，改成自然到期 + 日志「试用转正式」
- 修复改用用户名后，CDK/授权列表的“绑定客户/客户”列不显示的问题

---

## v2.24.0 / v2.24.1

**后台账号也改用用户名**

- 管理员、员工、代理登录：`email` → `username`（老账号自动把原邮箱当用户名，用邮箱仍可登）
- 全站“邮箱”文案改为“用户名/账号”
- 接口文档 `/docs` 只保留客户端接口，管理接口不再列出（接口本身照常可用）

---

## v2.23.0 / v2.23.1

**客户账号改用用户名 + 登录流程重构**

- 注册/登录参数 `email` → `username`（传 `email` 仍兼容，会被当作用户名）
- 用户名 3–20 位字母/数字/下划线，不区分大小写、唯一；**不再需要邮箱**
- 登录带 `product_code` + `device_id` 时：自动开试用、自动绑设备、席位满了直接 `403 SEATS_FULL`
- 网页登录（不带 `product_code`）也正常返回授权列表；不做试用/绑定/席位校验
- 新增 `client{product,trial_started,device_bound,seats,active_devices}` 字段

**破坏性变更：激活必须登录**

- `POST /api/v1/licenses/activate` 匿名调用 → `401 LOGIN_REQUIRED`
- 激活请求里带 `email`/`password` 自动建号的路径已取消，响应也不再带 `session`
- 查卡密 `POST /api/v1/cdks/inspect` 仍可匿名

**试用接续**

- 试用没到期的模块，正式授权开始时间 = 试用结束时间，再往后加卡内时长

**错误码**

- 新增 `401 LOGIN_REQUIRED`、`403 SEATS_FULL`、`400 INVALID_USERNAME`
- 注册重名：`EMAIL_TAKEN` → `USERNAME_TAKEN`

---

## v2.22.0 ~ v2.22.3

**卡密按实付结算 + 代理余额流水**

- 每张卡记录实付金额 `cdks.paid_amount`
- 代理改卡按差价补/退（改大补钱、改小退款，余额不够拒绝）
- 删除未激活卡退款；作废不退
- 新增代理余额明细接口：`GET /admin/api/agents/:id/ledger`、`GET /admin/api/agent-home/ledger`
- 赠送卡（代理名下、实付 0）代理不能改，只能删除/作废；管理员可改任何卡
- CDK 页面去掉批量操作（接口保留）

---

## v2.19.0 ~ v2.21.1

- 代理可看自己名下客户的授权、设备与日志，可解绑（绑定/重绑仍仅管理员）
- 后台客户列表新增“归属”列（最后一次激活卡所属代理，直销显示直销）
- 修复 http 环境下复制失败（三级兜底）
- 月卡/年卡按真实天数入库（1 年 = 365 天）

---

## v2.13 ~ v2.16

- 设备到期自动释放（`released_reason=expired`），续费后同机自动回绑
- 客户可自助改密码、查看设备与操作记录、解绑
- 门户 `/` 与后台入口分离（入口可配置，默认 `upadmin`）

---

## 升级注意

1. 数据库自动迁移（当前 v19），启动前自动备份到 `data/backups/pre-v<旧版本>-<时间>.db`
2. 备份目录要包含：`license.db`、`keys.json`、`license-secret.key`
3. 客户端最低要求：激活前先登录（v2.23 起）
