/**
 * 「API 文档」页面的数据源。
 *
 * 设计要点：路由清单**不手写**，由 http.listRoutes() 在运行时从真实路由表生成，
 * 因此永远不会出现"文档里写了但代码没实现"或"实现了但文档漏了"的情况。
 * 本文件只负责补充人类可读的标题、说明、鉴权方式与关键参数。
 */
import { listRoutes } from "./http.ts";

export type ApiAuth = "public" | "admin" | "customer";

export type ApiDocEntry = {
  title: string;
  auth: ApiAuth;
  desc?: string;
  params?: string;
  notes?: string;
  /** 关键返回字段（客户端解析用） */
  returns?: string;
  /** 该接口常见错误码 */
  errors?: string;
};

/** key = `${METHOD} ${path}` */
const ENTRIES: Record<string, ApiDocEntry> = {
  /* ---------------- 公共 ---------------- */
  "GET /healthz": { title: "健康检查", auth: "public", desc: "存活探针，供 Docker HEALTHCHECK 与监控使用，不写日志。" },
  "GET /api/v1/server-info": { title: "服务信息", auth: "public", desc: "返回服务版本、心跳周期、离线宽限天数与服务器时间。" },
  "GET /api/v1/public-key": { title: "验签公钥", auth: "public", desc: "Ed25519 公钥（PEM / Base64），内置到客户端用于离线验签。" },
  "GET /api/v1/docs": {
    title: "API 文档（JSON）",
    auth: "public",
    desc: "全部接口的结构化清单：路由骨架取自真实路由表，含分组、鉴权要求、参数与通用约定。供工具或文档站抓取。",
  },
  "GET /docs": {
    title: "API 文档（网页）",
    auth: "public",
    desc: "本页面的可直接分享版本：无需登录即可访问，适合发给客户端开发者。",
  },

  /* ---------------- 客户端 · 账号 ---------------- */
  "POST /api/v1/auth/register": { title: "客户注册", auth: "public", params: "`email`、`password`(≥8位)、`name?`", desc: "创建客户账号，返回客户信息与登录会话 token。" },
  "POST /api/v1/auth/login": {
    title: "客户登录",
    auth: "public",
    params: "`email`、`password`",
    desc: "返回 `customer`、`session.token`，以及授权快照 `licenses` / `active_license`：试用期返回试用到期时间（`is_trial=true`），激活后返回卡密授权到期时间，次数卡额外返回 `usages.remaining` 剩余次数。",
    notes: "登录本身不校验授权是否到期，客户端可依据 `active_license.status`（active/expired/revoked/suspended）自行决定是否放行。",
  },
  "GET /api/v1/auth/me": {
    title: "我的账号与授权",
    auth: "customer",
    desc: "返回客户信息、名下全部授权（含在用设备与 `days_left`、`usages.remaining`），以及优先展示用的 `active_license`。",
  },
  "POST /api/v1/auth/password": {
    title: "修改密码（客户自助）",
    auth: "customer",
    params: "`current_password`✅、`new_password`✅（至少 8 位）",
    desc: "校验原密码后改密。改完该账号的**其它会话全部失效**，同时返回一个新的 `token` 给当前设备，避免改完自己被踢下线。",
    notes: "401 INVALID_CREDENTIALS（原密码不对）、400 WEAK_PASSWORD / SAME_PASSWORD。",
  },
  "GET /api/v1/me/overview": {
    title: "授权总览（客户门户用）",
    auth: "customer",
    desc: "一次返回账号 + 名下每条授权 + 每条授权的模块明细（名称、到期、剩余天数、次数额度）+ 在用设备，门户不用再拼多个请求。",
    returns: "`customer`、`licenses[]`（含 `modules[]` / `devices[]` / `seats` / `active_devices`）、`summary`（授权数 / 有效数 / 7 天内到期 / 可用模块数）",
  },

  /* ---------------- 客户端 · 授权 ---------------- */
  "POST /api/v1/cdks/inspect": { title: "CDK 预检", auth: "public", params: "`cdk`", desc: "查询卡密是否可用、天数、席位、模块，**不核销**。" },
  "POST /api/v1/licenses/activate": {
    title: "用 CDK 激活",
    auth: "public",
    params: "`cdk`✅、`device_id`（`bind_device=false` 时不需要）、`device_name?`、`platform?`、`email?`、`password?`、`name?`、`bind_device?`",
    desc: "核销 CDK 并签发授权：返回 `license_key`（只返回一次）、`license_file`（离线验签用）、到期时间与模块。",
    notes: "带 `email`/`password` 会自动注册或绑定账号；都不带则为匿名激活。并发下 CDK 只可能被核销一次。**网页端激活传 `bind_device=false`**：只把卡绑到账号、不占席位（设备留给客户端首次启动时绑），返回 `device_bound=false`。**席位是软件级的**：并进已有授权时取 `max(原席位, 新卡席位)`；授权全部过期后重新激活会新建授权，席位按新卡从默认 1 起算。",
  },
  "POST /api/v1/licenses/heartbeat": {
    title: "心跳续期",
    auth: "public",
    params: "`license_key`✅、`device_id`✅",
    desc: "返回新的 `license_file` 与最新 `expires_at`，滚动离线有效期。",
    notes: "**到期不拒绝心跳**：返回 200 + `expired=true` + 各模块 `active=false`，客户端据此关功能。403 只用于吊销 / 暂停 / 客户停用（`LICENSE_REVOKED` / `LICENSE_SUSPENDED` / `CUSTOMER_DISABLED`）；404 是密钥无效或设备未绑定。授权到期后设备会被自动释放，续费恢复后同一台机器下次心跳会自动复位；手动解绑的设备不会自己回来。",
  },
  "POST /api/v1/licenses/enroll": { title: "加绑设备", auth: "public", params: "`license_key`✅、`device_id`✅、`device_name?`、`platform?`", desc: "为同一授权加绑新设备占用一个席位，席位满返回 409 SEAT_LIMIT。" },
  "POST /api/v1/licenses/release": { title: "解绑设备", auth: "public", params: "`license_key`✅、`device_id`✅", desc: "释放席位，返回 `{released}`。" },
  "GET /api/v1/licenses": { title: "我的授权列表", auth: "customer", desc: "当前客户的授权，每项附在用设备。" },
  "POST /api/v1/licenses/consume": {
    title: "消耗次数（次数型）",
    auth: "public",
    params: "`license_key`✅、`device_id`✅、`count?`（默认 1）、`module_code?`（v12：按模块扣次）",
    desc: "按次数计费的授权每次使用调用一次，原子扣减并返回剩余次数与重新签名的许可证文件。传 `module_code` 且该模块自己带额度时按模块扣，否则回落到整张授权的额度。",
    notes: "403 USAGE_EXHAUSTED（次数用完）、409 NOT_COUNT_LICENSE（既不是次数型、模块也没有额度）、404 DEVICE_NOT_BOUND / MODULE_NOT_FOUND。",
  },
  "GET /api/v1/licenses/:id": { title: "授权详情", auth: "customer", desc: "授权信息 + 全部设备记录 + 模块编码。" },
  "POST /api/v1/licenses/:id/rotate-key": { title: "重置许可证密钥", auth: "customer", params: "`device_id?`", desc: "旧密钥立即失效；带 `device_id` 时一并返回新签发的许可证文件。" },
  "POST /api/v1/licenses/:id/devices/:deviceId/release": { title: "自助解绑设备", auth: "customer", desc: "客户解绑自己的设备（换机用）。" },
  "POST /api/v1/licenses/:id/reenroll": { title: "重新获取许可证文件", auth: "customer", params: "`device_id`✅", desc: "本地缓存丢失时重新拉取签名文件。" },

  /* ---------------- 客户端 · 试用 ---------------- */
  "GET /api/v1/vars": {
    title: "远程变量（客户会话或 license_key）",
    auth: "customer",
    params: "`product?`（产品编码，留空取当前授权 / 客户第一个有效授权对应的产品）",
    desc: "返回该产品配置的远程变量 `vars`，值为 text / image / json 三种载荷（json 已解析为对象）。鉴权二选一：客户登录会话，或直接用 `Authorization: Bearer <license_key>`——客户端一般只有密钥，不需要再登录。用密钥调用时会额外返回 `license`（单号、状态、seats、active_devices、expires_at）。",
    notes: "两种身份都没有才 401；授权已吊销返回 403 LICENSE_REVOKED；图片通常是 URL 或 data URI 字符串。",
  },
  "GET /api/v1/trial/info": { title: "试用配置", auth: "public", desc: "按模块下发：每个开放试用的模块带自己的 days / mode / value / seats / max_per_customer。`module_codes` 保留为兼容字段。", returns: "`enabled`、`modules[]`（`code`、`name`、`mode`、`value`、`days`、`seats`、`max_per_customer`）、`module_codes`" },
  "GET /api/v1/trial/status": { title: "我的试用额度", auth: "customer", desc: "按产品 → 模块返回已用次数、剩余次数与是否还能试用（`available` / `reason`）。", returns: "`items[].product`、`items[].modules[]`" },
  "POST /api/v1/trial/start": {
    title: "开通试用",
    auth: "customer",
    params: "`device_id`✅、`device_name?`、`platform?`、`product_code?`、`module_codes?`（不传 = 全部可试用模块）",
    desc: "按试用配置创建 `kind=trial` 授权并绑定设备，返回结构与激活一致。",
    notes: "403 TRIAL_DISABLED / TRIAL_ALREADY_USED / TRIAL_PRODUCT_LIMIT。",
  },

  /* ---------------- 管理 · 认证 ---------------- */
  "POST /admin/api/auth/login": { title: "管理员登录", auth: "public", params: "`email`、`password`", desc: "返回 `token`（后续管理接口放在 Authorization: Bearer 里）。限流 10 次/分钟。" },
  "POST /admin/api/auth/logout": { title: "管理员登出", auth: "admin", desc: "使当前会话失效。" },
  "GET /admin/api/auth/me": { title: "当前管理员", auth: "admin", desc: "管理员信息 + 签名公钥 + 策略参数。" },
  "GET /admin/api/entry": { title: "读取后台入口", auth: "admin", returns: "`path`、`default_path`、`is_default`、`root_is_portal`", desc: "根路径 `/` 是客户门户，管理后台走这里返回的入口（默认 `upadmin`）。" },
  "PATCH /admin/api/entry": { title: "修改后台入口", auth: "admin", params: "`path`✅", desc: "仅超级管理员。小写字母 / 数字 / 中划线，2-32 位，且不能是保留字；改完立即生效，旧地址马上失效。400 INVALID_ENTRY_PATH。" },
  "POST /admin/api/auth/password": { title: "修改密码", auth: "admin", params: "`current_password`、`new_password`", desc: "改完所有会话失效，需重新登录。" },
  "GET /admin/api/admins": { title: "管理员列表", auth: "admin", desc: "全部管理员账号（旧接口，等同 /staff）。" },
  "POST /admin/api/admins": { title: "新增管理员", auth: "admin", params: "`email`、`password`(≥10位)、`name?`", desc: "创建管理端账号（旧接口，建议改用 /staff 以便配置权限）。" },

  /* ---------------- 管理 · 员工与代理 ---------------- */
  "GET /admin/api/staff/options": {
    title: "权限可选项",
    auth: "admin",
    desc: "返回可配置的目录权限（menus）与软件功能（features）清单，以及代理的固定权限，供前端渲染勾选。",
  },
  "GET /admin/api/staff": { title: "员工与代理列表", auth: "admin", desc: "含角色、目录权限、功能权限、所属代理。" },
  "POST /admin/api/staff": {
    title: "新增员工 / 代理",
    auth: "admin",
    params: "`email`✅、`password`✅(≥8位)、`name?`、`role`(staff|agent)、`menus[]`、`features[]`、`agent_id?`",
    desc: "role=staff 时按 menus/features 授权；role=agent 必须绑定 agent_id，权限固定为「只看卡密页」。仅超级管理员可调用。",
    notes: "400 MISSING_FIELD（代理缺代理）/ INVALID_FIELD（role 非法）/ WEAK_PASSWORD；409 EMAIL_TAKEN；403 FORBIDDEN_OWNER。",
  },
  "PATCH /admin/api/staff/:id": {
    title: "编辑员工 / 代理",
    auth: "admin",
    params: "`name?`、`status?`、`password?`、`menus[]?`、`features[]?`、`agent_id?`",
    desc: "改权限/状态/密码；停用或改密后该账号的会话立即失效。仅超级管理员可调用。",
  },
  "DELETE /admin/api/staff/:id": { title: "删除员工 / 代理", auth: "admin", desc: "不能删除超级管理员与自己；删除后会话失效。" },

  /* ---------------- 管理 · 概览 ---------------- */
  "GET /admin/api/overview": { title: "概览数据", auth: "admin", desc: "统计（授权/CDK/设备/心跳）+ 代理汇总 + 14 天内到期 + 最近开通。" },

  /* ---------------- 管理 · 代理 ---------------- */
  "GET /admin/api/agents": { title: "代理列表（含统计）", auth: "admin", params: "`q?`、`status?`", desc: "每个代理带 CDK 生成/核销数、激活率、授权数、营收（累计与近30天）、续费次数；顶层另有 `summary`。" },
  "POST /admin/api/agents": { title: "新增代理", auth: "admin", params: "`code`（小写）、`name`、`contact?`、`phone?`、`email?`、`note?`", desc: "`code` 自动转小写，重复返回 409 CODE_TAKEN。" },
  "POST /admin/api/agents/:id/credit": {
    title: "充值卡密余额（张数）",
    auth: "admin",
    params: "`amount`✅（正=充值，负=扣减）",
    desc: "调整代理的**卡密张数额度**（管理员代生成时按张扣减）。代理自行生成请用 `/balance`（按金额）。",
  },
  "GET /admin/api/prices": { title: "卡密价格列表", auth: "admin", params: "`product_id?`", desc: "按产品+模块+卡类型列出价格（单位：分/单位）；`module_id` 为空表示该产品的默认价。" },
  "POST /admin/api/prices": {
    title: "设置卡密价格",
    auth: "admin",
    params: "`product_id`✅、`module_id?`（留空=产品默认价）、`term_type`✅、`unit_price`✅（分/单位）",
    desc: "幂等覆盖同产品/模块/卡类型的价格。解析顺序：模块覆盖价 → 产品默认价 → 未配置则拒绝出卡（PRICE_NOT_CONFIGURED）。",
  },
  "DELETE /admin/api/prices/:id": { title: "删除价格", auth: "admin" },
  "POST /admin/api/agents/:id/balance": {
    title: "充值账户余额（金额）",
    auth: "admin",
    params: "`amount`✅（单位：分，正=充值，负=扣减）",
    desc: "代理生成卡密时按「单价 × 时长/次数 × 张数」从余额扣费，不足返回 409 BALANCE_INSUFFICIENT。",
  },
  "POST /admin/api/agents/batch-balance": {
    title: "一键批量充值",
    auth: "admin",
    params: "`amount`✅（分）、`agent_ids?`（不传=全部代理）",
    desc: "给多个代理统一充值，返回 `{updated, amount}`。",
  },
  "GET /admin/api/agents/:id": { title: "代理详情", auth: "admin", desc: "单代理 + 统计。" },
  "PATCH /admin/api/agents/:id": { title: "编辑代理", auth: "admin", params: "`name?`、`contact?`、`phone?`、`email?`、`note?`、`status?`", desc: "`status` 只能是 active / disabled。" },
  "DELETE /admin/api/agents/:id": { title: "删除代理", auth: "admin", desc: "已被 CDK 批次或授权引用时返回 409 AGENT_IN_USE，此时应改为停用。" },

  /* ---------------- 管理 · 产品与模块 ---------------- */
  "GET /admin/api/products": { title: "产品列表", auth: "admin", desc: "含模块数、授权数、有效授权数、未使用 CDK 数。" },
  "POST /admin/api/products": { title: "新增产品", auth: "admin", params: "`code`、`name`、`description?`", desc: "`code` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`。" },
  "PATCH /admin/api/products/:id": { title: "编辑产品", auth: "admin", params: "`name?`、`description?`、`status?`", desc: "`status`: active / disabled。" },
  "DELETE /admin/api/products/:id": { title: "删除产品", auth: "admin", desc: "已有授权或 CDK 时返回 409 PRODUCT_IN_USE。" },
  "GET /admin/api/products/:id/vars": {
    title: "远程变量列表",
    auth: "admin",
    desc: "按产品列出远程变量（含 kind、value、preview）。",
  },
  "POST /admin/api/products/:id/vars": {
    title: "新增/修改变量",
    auth: "admin",
    params: "`key`✅（字母数字下划线点横线）、`kind`（text/image/json，默认 text）、`value`、`description?`",
    desc: "同产品下 key 唯一，存在即覆盖；json 类型会校验 value 必须是合法 JSON。",
  },
  "DELETE /admin/api/products/:id/vars/:key": { title: "删除变量", auth: "admin" },
  "GET /admin/api/products/:id/trial": {
    title: "读取产品试用配置",
    auth: "admin",
    desc: "返回该产品生效的试用配置（未配置字段已由全局默认填充）以及全局默认值 `global`。",
  },
  "PATCH /admin/api/products/:id/trial": {
    title: "修改产品试用配置",
    auth: "admin",
    params: "`enabled?`、`mode?`(day/count)、`value?`、`seats?`、`max_per_customer?`、`module_ids?`",
    desc: "只覆盖传入字段，其余沿用全局默认，实现「按产品/模块」单独配置试用。",
  },
  "GET /admin/api/products/:id/modules": { title: "产品下的模块", auth: "admin", desc: "该产品的模块列表。" },
  "POST /admin/api/products/:id/modules": { title: "新增模块", auth: "admin", params: "`code`、`name`、`description?`", desc: "同产品内编码唯一。" },
  "GET /admin/api/modules": { title: "全部模块", auth: "admin", desc: "跨产品查询，附带 product_code 与每个模块的试用配置（`trial` = 合并后的结果，`trial_custom` = 是否单独配过）。" },
  "GET /admin/api/modules/:id/trial": { title: "模块试用配置", auth: "admin", returns: "`module`、`config`（合并后的完整配置）、`custom`（是否模块自定义）、`inherited_from`", desc: "模块级配置优先，未配置的字段回落产品级 / 全局。" },
  "PATCH /admin/api/modules/:id/trial": { title: "修改模块试用配置", auth: "admin", params: "`enabled?`、`mode?`（day/count）、`value?`、`max_per_customer?`、`offline_grace_days?`", desc: "只覆盖传入字段；传 null 表示清空该字段、回到继承上层。**席位是软件级的，模块里不设**：传 `seats` 直接 400 SEATS_NOT_MODULE_LEVEL。" },
  "DELETE /admin/api/modules/:id/trial": { title: "清除模块试用配置", auth: "admin", desc: "清空该模块的试用配置，回到继承产品级 / 全局。" },
  "PATCH /admin/api/modules/:id": { title: "编辑模块", auth: "admin", params: "`name?`、`description?`、`status?`" },
  "DELETE /admin/api/modules/:id": { title: "删除模块", auth: "admin", desc: "不影响已签发授权。" },

  /* ---------------- 管理 · CDK ---------------- */
  "POST /admin/api/cdks/estimate": {
    title: "生成前估价",
    auth: "admin",
    params: "`product_id`✅、`term_value`✅、`count`、`term_type?`、`module_ids[]?`",
    desc: "不扣费、不核销。返回本次应付金额、单价与代理余额；管理员生成时 `payable=false`（属赠送不扣费）。",
  },
  "POST /admin/api/cdks/generate": {    title: "批量生成 CDK",
    auth: "admin",
    params: "`product_id`✅、`days`✅、`count`✅、`module_ids?`、`seats?`、`note?`、`redeem_before?`、`agent_id?`、`unit_price?`",
    desc: "生成批次卡密，返回码列表与 CSV；`unit_price` 单位为**分**。",
    notes: "单个批次最多 5000 个；`module_ids` 必须属于该产品；`agent_id` 不存在返回 404 AGENT_NOT_FOUND。",
  },
  "GET /admin/api/cdks": { title: "CDK 列表", auth: "admin", params: "`product_id?`、`batch_id?`、`status?`、`agent_id?`（`__none__`=直销）、`q?`、分页", desc: "含代理、结算单价，以及激活后产生的 `license_expires_at` / `license_kind`。" },
  "GET /admin/api/cdk-batches": { title: "CDK 批次", auth: "admin", params: "`product_id?`", desc: "批次列表，含已核销数量。" },
  "GET /admin/api/cdks/:id": {
    title: "CDK 详情",
    auth: "admin",
    desc: "返回 CDK 本体、产品、模块（含名称）、绑定客户与 `activated` 标记（是否已激活）。",
  },
  "PATCH /admin/api/cdks/:id": {
    title: "修改 CDK（仅未激活）",
    auth: "admin",
    params: "`module_ids[]?`（至少 1 个）、`expires_at?`（null 取消兑换期限）、`seats?`、`note?`、`term_type?`、`term_value?`",
    desc: "只有未激活的 CDK 可以修改；已激活返回 409 CDK_ACTIVATED。改 term_value 会同步旧字段 days。",
  },
  "DELETE /admin/api/cdks/:id": {
    title: "删除 CDK（仅未激活）",
    auth: "admin",
    desc: "未激活的（含已作废但从未激活）可删除；已激活的一律拒绝（409 CDK_ACTIVATED）。",
  },
  "POST /admin/api/cdks/:id/revoke": { title: "作废 CDK", auth: "admin", params: "`reason?`", desc: "只有未使用的 CDK 可作废。" },
  "GET /admin/api/cdks/export": { title: "导出 CDK（CSV）", auth: "admin", params: "`batch_id?`、`product_id?`、`status?`", desc: "返回 text/csv（含 BOM，Excel 可直接打开）。" },

  /* ---------------- 管理 · 客户 ---------------- */
  "GET /admin/api/customers": { title: "客户列表", auth: "admin", params: "`q?`、`status?`、分页", desc: "含授权数、有效授权数与最近到期。" },
  "POST /admin/api/customers": { title: "新增客户", auth: "admin", params: "`email?`、`password?`、`name?`、`company?`、`phone?`、`note?`", desc: "邮箱留空即建「匿名客户」；`password` 留空则该客户不能登录；重复邮箱 409 EMAIL_TAKEN。" },
  "GET /admin/api/customers/:id": { title: "客户详情", auth: "admin", desc: "客户信息 + 名下授权（各附设备）+ `purgeable` / `purge_blocking`（能否删除及原因）。" },
  "PATCH /admin/api/customers/:id": { title: "编辑客户", auth: "admin", params: "`name?`、`company?`、`phone?`、`note?`、`status?`", desc: "停用后该客户心跳立即被拒。" },
  "POST /admin/api/customers/:id/reset-password": { title: "重置客户密码", auth: "admin", desc: "生成临时密码（只返回一次），并使其会话全部失效。" },
  "POST /admin/api/customers/:id/adjust-expiry": { title: "按客户调整到期", auth: "admin", params: "`days?` 或 `expires_at?`、`license_ids?`", desc: "批量调整该客户名下授权的到期时间；`days` 正数延长/负数缩短，`license_ids` 省略则作用于全部未吊销授权。" },
  "DELETE /admin/api/customers/:id": { title: "删除客户（硬删除，仅超级管理员）", auth: "admin", desc: "需要 owner 权限。要求名下授权全部已过期或已吊销（暂停的不算），否则 409 CUSTOMER_HAS_ACTIVE_LICENSE。删除客户、授权、设备、模块记录以及关联的 CDK。删除前会把完整快照（含每张 CDK 的码与批次）写进审计日志（action=customer.delete），日志写不进去则整体回滚。" },

  /* ---------------- 管理 · 授权 ---------------- */
  "GET /admin/api/licenses": { title: "授权列表", auth: "admin", params: "`status?`、`kind?`(paid/trial)、`product_id?`、`customer_id?`、`agent_id?`、`expiring_within_days?`、`q?`、分页", desc: "含 `eff_status`（实时计算）、代理与设备数。" },
  "POST /admin/api/licenses": { title: "手动开通授权", auth: "admin", params: "`product_id`✅、`customer_id` 或 `customer_email`、`days`✅、`seats?`、`module_ids?`、`note?`、`agent_id?`、`unit_price?`", desc: "不走 CDK 直接开授权，返回 `license_key`（只显示一次）。" },
  "GET /admin/api/licenses/:id": { title: "授权详情", auth: "admin", desc: "授权 + 设备列表 + 模块编码 + 客户信息。每台设备带 `status` 与 `released_reason`（`manual` = 手动解绑；`expired` = 授权到期自动释放，续费后可自动复位）。" },
  "PATCH /admin/api/licenses/:id": { title: "编辑授权", auth: "admin", params: "`status?`、`expires_at?`、`starts_at?`、`seats?`、`module_ids?`、`offline_grace_days?`、`note?`", desc: "改到期时间后，客户端下次心跳即同步。" },
  "POST /admin/api/licenses/:id/extend": { title: "延长 / 缩短到期", auth: "admin", params: "`days`（可为负）、`from_now?`", desc: "试用延长也用这个接口；`from_now=true` 从当前时间起算。" },
  "POST /admin/api/licenses/:id/revoke": { title: "吊销授权", auth: "admin", params: "`reason?`", desc: "不可恢复。" },
  "POST /admin/api/licenses/:id/reset-devices": { title: "重置全部设备", auth: "admin", desc: "解绑所有设备，返回 `{released}`。" },
  "POST /admin/api/licenses/:id/rotate-key": { title: "重置许可证密钥", auth: "admin", desc: "旧密钥立即失效，新密钥只显示一次。" },
  "POST /admin/api/licenses/:id/reissue": { title: "重新签发许可证文件", auth: "admin", params: "`device_id?`", desc: "为指定/首台在用设备重新签发签名文件。" },
  "POST /admin/api/licenses/:id/devices": { title: "绑定新设备（换机）", auth: "admin", params: "`device_id`✅、`device_name?`、`platform?`", desc: "到期时间沿用首次激活，**不重置**；席位满 409 SEAT_LIMIT。" },
  "POST /admin/api/licenses/:id/devices/:deviceId/release": { title: "解绑单个设备", auth: "admin", desc: "释放席位，返回 `{released}`。" },
  "GET /admin/api/licenses/:id/events": { title: "设备绑解绑历史", auth: "admin", desc: "设备记录（含 `released_at`）+ 该授权的审计记录。" },

  /* ---------------- 管理 · 试用配置 ---------------- */
  "GET /admin/api/settings/trial": { title: "读取试用配置", auth: "admin", desc: "`config`（开关/天数/席位/次数/限定产品/离线宽限）+ `summary`（试用总数/有效/转正式客户数）。" },
  "PATCH /admin/api/settings/trial": { title: "修改试用配置", auth: "admin", params: "`enabled?`、`mode?`(day/count)、`value?`、`days?`、`seats?`、`max_per_customer?`、`product_id?`、`module_ids?`、`offline_grace_days?`", desc: "`mode=day` 表示试用几天、`mode=count` 表示试用几次（value 为对应数量）；`product_id: null` 取消产品限定，`offline_grace_days: null` 回落到全局默认。只有未购买正式授权的客户才能试用。" },

  /* ---------------- 管理 · 审计与密钥 ---------------- */
  "GET /admin/api/audit": { title: "审计日志", auth: "admin", params: "`action?`、`actor_type?`、`q?`、分页", desc: "倒序，含操作者、目标、IP 与变更详情。" },
  "GET /admin/api/signing-key": { title: "签名公钥信息", auth: "admin", desc: "kid、算法、PEM 与 Base64。" },
  "GET /admin/api/heartbeat-health": { title: "心跳异常授权", auth: "admin", desc: "超过 HEARTBEAT_STALE_HOURS 未心跳的有效授权。" },
  "GET /admin/api/docs": {
    title: "API 文档数据",
    auth: "admin",
    desc: "本页数据源：路由骨架取自真实路由表，标题与说明来自 `src/api-spec.ts`；会列出缺少说明的路由。",
  },
};

/** 按路径前缀归组，顺序即页面展示顺序 */
const GROUP_RULES: { name: string; test: (m: string, p: string) => boolean }[] = [
  { name: "公共接口", test: (_m, p) => p === "/healthz" || p === "/docs" || p === "/api/v1/docs" || p === "/api/v1/server-info" || p === "/api/v1/public-key" },
  { name: "客户端 · 账号", test: (_m, p) => p.startsWith("/api/v1/auth") },
  { name: "客户端 · 授权", test: (_m, p) => p.startsWith("/api/v1/licenses") || p.startsWith("/api/v1/cdks") },
  { name: "客户端 · 试用", test: (_m, p) => p.startsWith("/api/v1/trial") },
  { name: "管理 · 认证", test: (_m, p) => p.startsWith("/admin/api/auth") },
  { name: "管理 · 员工与代理", test: (_m, p) => p.includes("/staff") || p.includes("/admins") },
  { name: "管理 · 概览", test: (_m, p) => p === "/admin/api/overview" },
  { name: "管理 · 代理", test: (_m, p) => p.includes("/agents") || p.includes("/prices") },
  { name: "管理 · 产品与模块", test: (_m, p) => p.includes("/products") || p.includes("/modules") },
  { name: "管理 · CDK", test: (_m, p) => p.includes("/cdks") || p.includes("/cdk-batches") },
  { name: "管理 · 客户", test: (_m, p) => p.includes("/customers") },
  { name: "管理 · 授权", test: (_m, p) => p.includes("/licenses") },
  { name: "管理 · 试用配置", test: (_m, p) => p.includes("/settings/trial") },
  { name: "管理 · 审计与密钥", test: (_m, p) => p.includes("/audit") || p.includes("/signing-key") || p.includes("/heartbeat-health") },
];

export type ApiDocEndpoint = ApiDocEntry & { method: string; path: string; documented: boolean };
export type ApiDocGroup = { name: string; endpoints: ApiDocEndpoint[] };
export type ApiDocs = {
  version: string;
  total: number;
  missing: string[];
  groups: ApiDocGroup[];
  conventions: { title: string; text?: string; codes?: string[] }[];
};

/**
 * 核心接口的「返回字段 / 常见错误」补充表。
 * 单独维护，不改动上面已有条目，避免大段编辑出错。
 */
const EXTRA_DOCS: Record<string, { returns?: string; errors?: string }> = {
  "POST /api/v1/licenses/activate": {
    returns:
      "`license`、`license_key`（仅返回这一次，客户端必须本地保存）、`license_file`（离线许可证）、`license_payload`、`offline_expires_at`、`expires_at`、`days_left`、`module_codes`、`merged`（true=同类型卡叠加续费）、`session`（新客户时附带）",
    errors:
      "`404 CDK_NOT_FOUND`、`409 CDK_ALREADY_USED` / `CDK_REVOKED` / `CDK_EXPIRED` / `SEAT_LIMIT` / `TERM_CONFLICT`、`400 MODULE_NOT_ALLOWED`（模块超出 CDK 范围）/ `MISSING_FIELD`、`403 LICENSE_*`",
  },
  "POST /api/v1/licenses/heartbeat": {
    returns: "`license`、`modules`（每个模块的 `expires_at` / `days_left` / `active`）、`status`（active / expired）、`expired`（全部模块到期时为 true，仍是 200）、`license_file`（滚动续期）、`offline_expires_at`、`expires_at`、`days_left`、`heartbeat_interval_hours`",
    errors: "`404 INVALID_LICENSE_KEY` / `DEVICE_NOT_BOUND`、`403 LICENSE_REVOKED` / `LICENSE_SUSPENDED`（到期不再返回 403）",
  },
  "POST /api/v1/cdks/inspect": {
    returns: "`code`、`status`、`product`、`module_codes`、`days`、`seats`、`redeem_before`、`usable`（是否可激活）",
    errors: "`404 CDK_NOT_FOUND`",
  },
  "POST /api/v1/auth/login": {
    returns: "`customer`、`session.token`、`licenses`（含 `modules` 逐模块到期）、`active_license`（优先正式授权，其次试用，都没有为 null）",
    errors: "`401 INVALID_CREDENTIALS`、`403 CUSTOMER_DISABLED`",
  },
  "POST /api/v1/licenses/consume": {
    returns: "`consumed`、`remaining`、`max`、`used`、`license_file`（含最新 `usage`）",
    errors: "`403 USAGE_EXHAUSTED`、`409 NOT_COUNT_LICENSE`、`404 DEVICE_NOT_BOUND` / `INVALID_LICENSE_KEY`",
  },
  "GET /api/v1/vars": {
    returns: "`product`（code/name）、`vars`（对象，json 类型已解析）、`license`（仅用 license_key 鉴权时返回：单号/状态/席位/已绑设备/到期）",
    errors: "`401 UNAUTHORIZED`（两种身份都没有）、`403 LICENSE_REVOKED`、`404 PRODUCT_NOT_FOUND`",
  },
  "POST /admin/api/cdks/generate": {
    returns: "`batch`（含 `term_type` / `term_value` / `count`）、`codes`（卡密明文数组）",
    errors: "`404 PRODUCT_NOT_FOUND` / `AGENT_NOT_FOUND`、`400 INVALID_MODULES` / `MISSING_FIELD`、`409 BALANCE_INSUFFICIENT` / `PRICE_NOT_CONFIGURED`（代理按价格扣费时）、`403 AGENT_*_DENIED`",
  },
  "POST /admin/api/staff": {
    returns: "`staff`（含 `role` / `permissions` / `agent_id` / `agent_profile`）",
    errors: "`409 EMAIL_TAKEN`、`400 MISSING_FIELD`（代理缺 agent_id）/ `INVALID_FIELD`（role 非法）/ `WEAK_PASSWORD`、`403 FORBIDDEN`（非 owner）",
  },
  "POST /admin/api/agents": {
    returns: "`agent`（`code` / `name` / `credit` / `balance`）",
    errors: "`409 CODE_TAKEN`、`400 INVALID_FIELD`（编码格式）",
  },
  "PATCH /admin/api/licenses/:id": {
    returns: "`license`（更新后的授权）",
    errors: "`404 LICENSE_NOT_FOUND`、`400 INVALID_FIELD` / `MISSING_FIELD`（`module_ids` 为空）/ `INVALID_MODULES`",
  },
  "POST /admin/api/customers/:id/adjust-expiry": {
    returns: "`updated`（受影响的授权数）、`licenses`（更新后的授权列表）",
    errors: "`404 CUSTOMER_NOT_FOUND`、`400 MISSING_FIELD`、`403 FORBIDDEN_AGENT_SCOPE`（客户不归该代理）；代理延长会**自动钳制**到 CDK 授予的上限，不报错",
  },
  "DELETE /admin/api/cdks/:id": {
    returns: "`deleted: true`",
    errors: "`404 CDK_NOT_FOUND`、`409 CDK_ACTIVATED`（已激活的不能删）",
  },
};

for (const [key, extra] of Object.entries(EXTRA_DOCS)) {
  const entry = ENTRIES[key];
  if (entry) Object.assign(entry, extra);
}

export function buildApiDocs(): ApiDocs {
  const routes = listRoutes().filter((r) => r.method !== "ANY");
  const missing: string[] = [];
  const buckets = new Map<string, ApiDocEndpoint[]>();

  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    const entry = ENTRIES[key];
    if (!entry) missing.push(key);
    const group =
      GROUP_RULES.find((g) => g.test(r.method, r.path))?.name ?? "其它";
    const list = buckets.get(group) ?? [];
    list.push({
      method: r.method,
      path: r.path,
      documented: Boolean(entry),
      auth: entry?.auth ?? (r.path.startsWith("/admin/") ? "admin" : "public"),
      title: entry?.title ?? "（未补充描述）",
      desc: entry?.desc,
      params: entry?.params,
      returns: entry?.returns,
      errors: entry?.errors,
      notes: entry?.notes,
    });
    buckets.set(group, list);
  }

  const groups: ApiDocGroup[] = GROUP_RULES.map((g) => ({
    name: g.name,
    endpoints: (buckets.get(g.name) ?? []).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  })).filter((g) => g.endpoints.length > 0);

  const others = buckets.get("其它");
  if (others?.length) groups.push({ name: "其它", endpoints: others });

  return {
    version: "1.3.0",
    total: routes.length,
    missing,
    groups,
    conventions: [
      { title: "统一响应", text: "成功：`{ ok: true, data: {...} }`；失败：`{ ok: false, error: { code, message, details? } }`。" },
      { title: "鉴权", text: "客户端接口用客户会话 token，管理接口用管理员 token，均放在请求头 `Authorization: Bearer <token>`。" },
      { title: "时间与金额", text: "时间为 ISO-8601 UTC 字符串；金额单位统一为「分」（整数）。" },
      { title: "分页", text: "`?page=1&page_size=20`，`page_size` 上限 200。" },
      { title: "心跳与到期同步", text: "客户端每次心跳都会拿到最新 `expires_at`、逐模块的 `modules[]` 与重新签名的 `license_file`，因此后台改到期后最迟一个心跳周期生效。到期是软状态：心跳仍返回 200，只是 `expired=true`、过期模块 `active=false`，账号与授权信息照常可读。" },
      {
        title: "错误码",
        codes: [
          "401 UNAUTHORIZED",
          "403 FORBIDDEN",
          "403 LICENSE_EXPIRED",
          "403 LICENSE_REVOKED",
          "403 LICENSE_SUSPENDED",
          "403 TRIAL_ALREADY_USED",
          "403 TRIAL_NOT_ALLOWED",
          "404 CDK_NOT_FOUND",
          "404 INVALID_LICENSE_KEY",
          "404 DEVICE_NOT_BOUND",
          "409 SEAT_LIMIT",
          "409 CODE_TAKEN",
          "409 EMAIL_TAKEN",
          "409 AGENT_IN_USE",
          "409 BALANCE_INSUFFICIENT",
          "409 TERM_CONFLICT",
          "429 RATE_LIMITED",
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 公开文档页（服务端渲染，无需登录）                                   */
/* ------------------------------------------------------------------ */

const AUTH_LABELS: Record<string, string> = { public: "公开", admin: "管理员", customer: "客户登录" };

function escHtml(input: unknown): string {
  return String(input ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

function inlineCode(text: string): string {
  return escHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * 渲染成一份完整、可独立访问的 HTML 文档（`GET /docs`）。
 * 不依赖后台前端，任何人不登录也能看，便于把接口文档直接发给外部开发者。
 */
export function renderDocsPage(docs: ApiDocs, baseUrl: string): string {
  const groupsHtml = docs.groups
    .map(
      (g) => `
    <section class="group">
      <h2>${escHtml(g.name)}<span class="count">${g.endpoints.length}</span></h2>
      ${g.endpoints
        .map(
          (e) => `
      <details class="ep" data-search="${escHtml(`${e.method} ${e.path} ${e.title} ${e.desc ?? ""}`.toLowerCase())}">
        <summary>
          <span class="m m-${e.method.toLowerCase()}">${escHtml(e.method)}</span>
          <code class="p">${escHtml(e.path)}</code>
          <span class="t">${escHtml(e.title)}</span>
          <span class="auth a-${escHtml(e.auth)}">${escHtml(AUTH_LABELS[e.auth] ?? e.auth)}</span>
        </summary>
        <div class="body">
          ${e.desc ? `<p>${inlineCode(e.desc)}</p>` : ""}
          ${e.params ? `<p class="kv"><b>参数</b> ${inlineCode(e.params)}</p>` : ""}
          ${e.returns ? `<p class="kv"><b>返回</b> ${inlineCode(e.returns)}</p>` : ""}
          ${e.errors ? `<p class="note"><b>常见错误</b> ${inlineCode(e.errors)}</p>` : ""}
          ${e.notes ? `<p class="note">${inlineCode(e.notes)}</p>` : ""}
          <pre><code>curl -X ${escHtml(e.method)} '${escHtml(baseUrl + e.path)}'</code></pre>
        </div>
      </details>`,
        )
        .join("")}
    </section>`,
    )
    .join("");

  const conventionsHtml = docs.conventions
    .map((c) =>
      c.codes?.length
        ? `<div class="conv-item"><h3>${escHtml(c.title)}</h3><div class="err-list">${c.codes
            .map((x) => `<code>${escHtml(x)}</code>`)
            .join("")}</div></div>`
        : `<div class="conv-item"><h3>${escHtml(c.title)}</h3><p>${inlineCode(c.text ?? "")}</p></div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API 文档 · license-server</title>
<style>
  :root { --bg:#f5f6f8; --surface:#fff; --border:#e3e6eb; --text:#1c2330; --muted:#6b7480; --primary:#2563eb; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Roboto,Arial,sans-serif; }
  code { font-family:var(--mono); font-size:12.5px; background:#f0f2f5; padding:1px 5px; border-radius:4px; }
  header { background:var(--surface); border-bottom:1px solid var(--border); padding:20px 24px; position:sticky; top:0; z-index:5; }
  header h1 { margin:0; font-size:20px; }
  .sub { color:var(--muted); font-size:13px; margin:4px 0 12px; }
  .row { display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:12px; flex-wrap:wrap; }
  .row span { color:var(--muted); }
  #q { width:100%; max-width:420px; font:inherit; padding:8px 12px; border:1px solid var(--border); border-radius:8px; }
  #q:focus { outline:none; border-color:var(--primary); box-shadow:0 0 0 3px #eef4ff; }
  main { max-width:1080px; margin:0 auto; padding:20px 24px 80px; }
  .conventions { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-bottom:22px; }
  .conv-item { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .conv-item h3 { margin:0 0 6px; font-size:13px; color:var(--primary); }
  .conv-item p { margin:0; font-size:12.5px; color:var(--muted); overflow-wrap:anywhere; }
  .offline-body { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:18px 20px; }
  .offline-body .lead { margin:0 0 14px; font-size:13.5px; }
  .offline-body h3 { margin:18px 0 8px; font-size:14px; color:var(--primary); }
  .offline-body p { margin:0 0 8px; font-size:13px; color:var(--muted); overflow-wrap:anywhere; }
  .offline-body pre { margin:0 0 10px; overflow-x:auto; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; }
  .offline-body pre code { font-size:12px; line-height:1.6; white-space:pre; }
  .offline-table { width:100%; border-collapse:collapse; margin:8px 0 12px; font-size:12.5px; }
  .offline-table th, .offline-table td { border:1px solid var(--border); padding:7px 10px; text-align:left; vertical-align:top; }
  .offline-table th { background:var(--bg); color:var(--primary); font-weight:600; }
  .offline-list { margin:6px 0 0; padding-left:20px; font-size:12.5px; color:var(--muted); }
  .offline-list li { margin-bottom:4px; }
  .err-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
  .err-list code { white-space:nowrap; background:var(--bg); border:1px solid var(--border); padding:2px 7px; border-radius:6px; font-size:12px; }
  .group { background:var(--surface); border:1px solid var(--border); border-radius:10px; margin-bottom:16px; overflow:hidden; }
  .group h2 { margin:0; padding:13px 16px; font-size:14px; border-bottom:1px solid var(--border); background:#fafbfc; display:flex; align-items:center; gap:8px; }
  .count { font-size:12px; font-weight:400; color:var(--muted); background:#f1f3f6; padding:1px 8px; border-radius:999px; }
  .ep { border-bottom:1px solid #f1f3f6; }
  .ep:last-child { border-bottom:0; }
  .ep > summary { display:flex; align-items:center; gap:10px; padding:10px 16px; cursor:pointer; list-style:none; }
  .ep > summary::-webkit-details-marker { display:none; }
  .ep > summary:hover { background:#fafbfd; }
  .ep[open] > summary { background:#f7faff; }
  .m { font:600 11px/1 var(--mono); padding:4px 7px; border-radius:5px; color:#fff; background:#6b7480; }
  .m-get { background:#2563eb; } .m-post { background:#15803d; } .m-patch { background:#b45309; } .m-delete { background:#dc2626; }
  .p { font-family:var(--mono); font-size:12.5px; white-space:nowrap; }
  .t { color:var(--muted); font-size:13px; flex:1; min-width:0; }
  .auth { font-size:11.5px; padding:2px 8px; border-radius:999px; background:#f1f3f6; color:var(--muted); }
  .a-admin { background:#fffbeb; color:#92400e; } .a-customer { background:#eef4ff; color:#1d4ed8; } .a-public { background:#f0fdf4; color:#15803d; }
  .body { padding:2px 16px 16px; display:flex; flex-direction:column; gap:10px; }
  .body p { margin:0; font-size:13px; }
  .body .kv b { color:var(--muted); font-weight:600; margin-right:6px; }
  .body .note { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:8px; padding:8px 10px; font-size:12.5px; }
  .body pre { margin:0; background:#0f172a; color:#e2e8f0; border-radius:8px; padding:10px 12px; overflow-x:auto; }
  .body pre code { background:none; color:inherit; padding:0; font-size:12px; }
  footer { text-align:center; color:var(--muted); font-size:12px; padding:24px; }
</style>
</head>
<body>
<header>
  <h1>API 文档</h1>
  <p class="sub">v${escHtml(docs.version)} · 共 ${docs.total} 个接口 · 由服务端真实路由表自动生成，不会与实现脱节</p>
  <div class="row"><span>Base URL</span> <code>${escHtml(baseUrl)}</code> <span>· 客户端 <code>/api/v1</code> · 管理 <code>/admin/api</code></span></div>
  <input id="q" placeholder="搜索路径 / 方法 / 说明…" autocomplete="off" />
</header>
<main>
  <div class="conventions">${conventionsHtml}</div>
  ${groupsHtml}

  <section class="group" id="flow">
    <h2>软件使用流程</h2>
    <div class="offline-body">
      <h3>① 服务商（管理员）开通流程</h3>
      <table class="offline-table">
        <thead><tr><th>步骤</th><th>在哪做</th><th>做什么</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>产品与模块</td><td>新建产品（如 <code>app-pro</code>），再为它建模块（如 <code>core</code>、<code>export</code>）——模块是授权的功能单位</td></tr>
          <tr><td>2</td><td>产品与模块 → 试用</td><td>（可选）给该产品配试用：允许试用几天 / 几次、席位、每个客户可试用次数</td></tr>
          <tr><td>3</td><td>软件参数</td><td>配置<b>全局默认卡密价格</b>（按产品/模块/卡类型，单位「元 / 单位」）；代理未单独定价时用它结算</td></tr>
          <tr><td>4</td><td>CDK</td><td>批量生成卡密：选产品、勾模块、选计费方式（按时/天/月/年/次数）、数量、席位、兑换截止时间</td></tr>
          <tr><td>5</td><td>客户 / 授权</td><td>客户激活后在这里管理：延长期限、编辑模块、绑定/解绑设备、暂停、吊销或恢复</td></tr>
        </tbody>
      </table>

      <h3>② 代理商分销流程（可选）</h3>
      <table class="offline-table">
        <thead><tr><th>步骤</th><th>在哪做</th><th>做什么</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>代理</td><td>新建代理（编码 + 名称）</td></tr>
          <tr><td>2</td><td>代理 → 充值</td><td>给代理账户充值余额（金额，元）；代理生成卡密时按「单价 × 时长/次数 × 张数」扣费</td></tr>
          <tr><td>3</td><td>代理 → 定价</td><td>（可选）为这个代理单独定价；留空则沿用全局默认价</td></tr>
          <tr><td>4</td><td>代理 → 账号</td><td>创建代理的登录账号，并勾选它能卖的产品与卡类型（不勾 = 不限）</td></tr>
          <tr><td>5</td><td>代理自己登录</td><td>只能看到 CDK 页与「自己名下的客户」；出卡自动归属自己并扣余额</td></tr>
        </tbody>
      </table>
      <p class="lead"><b>注意：</b>管理员代代理出的卡属于「赠送」，<b>不扣</b>代理余额；只有代理自己登录出的卡才扣。</p>

      <h3>③ 客户端（软件）接入流程</h3>
      <table class="offline-table">
        <thead><tr><th>步骤</th><th>调用</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td>1</td><td><code>POST /api/v1/auth/register</code></td><td>(可选) 注册客户账号；不注册也能激活，但拿不到客户中心能力</td></tr>
          <tr><td>2</td><td><code>POST /api/v1/cdks/inspect</code></td><td>(可选) 预检卡密：看产品、模块、时长、是否可用，不核销</td></tr>
          <tr><td>3</td><td><code>POST /api/v1/licenses/activate</code></td><td>用 CDK 激活，<b>必须联网一次</b>；可用 <code>module_ids</code> 只开通部分模块。返回 <code>license_file</code>（离线许可证）+ <code>license_key</code>（本地保存）</td></tr>
          <tr><td>4</td><td>本地验签</td><td>每次启动用内置公钥验签 <code>license_file</code>，完全离线（详见下方「离线验证使用说明」）</td></tr>
          <tr><td>5</td><td><code>POST /api/v1/licenses/heartbeat</code></td><td>按 <code>heartbeat_interval_hours</code>（默认 24 小时）续期，拿新的 <code>license_file</code></td></tr>
          <tr><td>6</td><td><code>POST /api/v1/licenses/consume</code></td><td>次数卡每使用一次扣一次（需联网）</td></tr>
          <tr><td>7</td><td><code>GET /api/v1/vars</code></td><td>(可选) 读远程变量（公告/图片/JSON 配置），需登录</td></tr>
        </tbody>
      </table>

      <h3>④ 授权状态与客户端应对</h3>
      <table class="offline-table">
        <thead><tr><th>状态</th><th>含义</th><th>客户端应做</th></tr></thead>
        <tbody>
          <tr><td><code>active</code></td><td>有效期内</td><td>正常放行</td></tr>
          <tr><td><code>expired</code></td><td>到期</td><td>提示续费</td></tr>
          <tr><td><code>suspended</code></td><td>被暂停</td><td>提示联系服务商</td></tr>
          <tr><td><code>revoked</code></td><td>被吊销</td><td>停止使用（后台可恢复）</td></tr>
          <tr><td>离线许可证 <code>exp</code> 到期</td><td>太久没联网（授权可能仍有效）</td><td>提示「请联网验证」，别当成到期</td></tr>
        </tbody>
      </table>

      <h3>⑤ 接口兼容性约定</h3>
      <ul class="offline-list">
        <li><b>字段改名兼容</b>：v2.0 起「渠道」统一改名「代理」，但请求里仍传旧的 <code>channel_id</code> / <code>channel_name</code> / <code>channel_code</code> 依然可用（内部映射到 <code>agent_*</code>）；两者同时出现时以新字段为准。</li>
        <li><b>响应成功/失败恒为固定包裹</b>：成功 <code>{ ok: true, data }</code>，失败 <code>{ ok: false, error: { code, message, details? } }</code>，可据此统一处理。</li>
        <li><b>空请求体合法</b>：无参数的 POST 可以不传 body（等价于 <code>{}</code>）；若传了表单编码（<code>a=1&amp;b=2</code>）会明确提示需要 JSON。</li>
        <li><b>新增字段只加不改</b>：后续版本只在响应里追加字段，不重命名已发布字段；确需改名时保留旧字段一段时间。</li>
        <li><b>数据库自动迁移</b>：升级镜像时结构逐版本自动升级，且升级前自动快照，见 README「数据库版本与兼容升级」。</li>
      </ul>
    </div>
  </section>

  <section class="group" id="offline">
    <h2>离线验证使用说明</h2>
    <div class="offline-body">
      <p class="lead"><b>一句话：</b>许可证文件本身可以完全离线校验（Ed25519 签名），但 <b>首次激活必须联网一次</b> —— 因为要核销 CDK 并绑定设备指纹。</p>

      <h3>① 许可证文件长什么样</h3>
      <p>激活与每次心跳都会返回 <code>license_file</code>，格式是 <code>payload 的 base64url . 签名的 base64url</code>。解开后：</p>
      <pre><code class="lang-json">{
  "v": 1,
  "kid": "k1",                  // 签名密钥编号
  "lic": "lic_xxx",             // 授权 ID
  "lic_no": "LIC-2026-00001",   // 授权单号
  "cus": "cus_xxx",             // 客户 ID
  "prd": "app-pro",             // 产品编码
  "mod": ["core", "export"],    // 已开通模块（不含未勾选的）
  "dev": "a3f8…",               // 设备指纹哈希，绑死这台机器
  "seat": 2,                    // 席位
  "iat": 1763000000,            // 签发时间（Unix 秒）
  "exp": 1763604800,            // 离线有效期 ← 注意见下文
  "grace_until": 1765600000,    // 授权真实到期时间
  "status": "active",
  "term": { "type": "day", "value": 30 },
  "usage": null                 // 次数卡时为 { max, used }
}</code></pre>

      <h3>② 客户端验签四步（Node.js 示例）</h3>
      <pre><code class="lang-js">const { createPublicKey, verify } = require("node:crypto");

// 公钥内置在客户端（也可首次联网时取自 GET /api/v1/public-key 并缓存）
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----
…
-----END PUBLIC KEY-----';

function verifyLicenseFile(file) {
  const dot = file.indexOf(".");
  if (dot &lt;= 0) throw new Error("许可证格式错误");
  const body = file.slice(0, dot);
  const sig = Buffer.from(file.slice(dot + 1), "base64url");

  // ① 验签：确认是本服务签发、且内容未被篡改
  if (!verify(null, Buffer.from(body, "utf8"), createPublicKey(PUBLIC_KEY_PEM), sig)) {
    throw new Error("许可证签名无效");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

  // ② 设备绑定：dev 必须等于本机指纹的哈希
  if (payload.dev !== myDeviceHash()) throw new Error("许可证不属于本机");

  // ③ 状态
  if (payload.status === "revoked") throw new Error("授权已吊销");

  // ④ 时间：区分「需要联网」与「真的到期」
  const now = Date.now() / 1000;
  if (payload.exp &lt;= now) {
    if (payload.grace_until &gt; now) throw new Error("NEED_ONLINE");  // 只是太久没联网
    throw new Error("EXPIRED");                                      // 真的到期了
  }
  return payload;    // payload.mod 即当前可用模块
}</code></pre>

      <h3>③ ⚠️ 最容易踩的坑：<code>exp</code> 不是授权到期时间</h3>
      <p><code>exp = min(授权真实到期时间, 签发时刻 + 该授权的最长离线时间)</code>。所以 <code>exp</code> 过期只代表「太久没联网」，不代表授权过期。</p>
      <table class="offline-table">
        <thead><tr><th>情况</th><th>含义</th><th>客户端应该怎么做</th></tr></thead>
        <tbody>
          <tr><td><code>exp</code> 未到</td><td>完全正常</td><td>直接放行</td></tr>
          <tr><td><code>exp</code> 已过，<code>grace_until</code> 未到</td><td>只是很久没联网，授权其实还有效</td><td>提示「请联网验证」，<b>不要</b>显示「授权已过期」</td></tr>
          <tr><td><code>grace_until</code> 已过</td><td>真的到期</td><td>提示续费</td></tr>
        </tbody>
      </table>
      <p>「最长离线时间」可在授权详情里逐条设置（默认取全局 <code>OFFLINE_GRACE_DAYS</code>）；改动后点「重新签发许可证文件」立即生效，否则下一次心跳后按新值计算。</p>

      <h3>④ 三种部署场景</h3>
      <table class="offline-table">
        <thead><tr><th>场景</th><th>做法</th></tr></thead>
        <tbody>
          <tr><td>能联网（最常见）</td><td>正常激活 → 本地保存 <code>license_file</code> → 每次启动本地验签；建议按 <code>heartbeat_interval_hours</code>（默认 24 小时）心跳换新文件。</td></tr>
          <tr><td>偶尔联网</td><td>把 <code>OFFLINE_GRACE_DAYS</code> 调大（如 30～90 天），给「偶尔联网」留窗口。代价：真实吊销/到期后，最坏要等这么久客户端才会知道。</td></tr>
          <tr><td>永久不能联网</td><td>当前不支持「离线首次激活」（设备指纹必须先上报）。可行做法：让该机器通过手机热点/临时网线联网激活一次；或联系服务商按设备指纹代签。</td></tr>
        </tbody>
      </table>

      <h3>⑤ 相关接口</h3>
      <ul class="offline-list">
        <li><code>POST /api/v1/licenses/activate</code> —— 激活并获取首份 <code>license_file</code>（需联网一次）</li>
        <li><code>POST /api/v1/licenses/heartbeat</code> —— 滚动续期，返回新的 <code>license_file</code></li>
        <li><code>GET /api/v1/public-key</code> —— 取验签公钥（建议内置到客户端）</li>
        <li><code>POST /api/v1/licenses/consume</code> —— 次数卡消耗（需联网）</li>
        <li><code>GET /api/v1/vars</code> —— 远程变量（需登录，可用于下发最新公告/配置）</li>
      </ul>
    </div>
  </section>
</main>
<footer>license-server v${escHtml(docs.version)} · 本文档页无需登录，可直接分享给客户端开发者</footer>
<script>
  (function () {
    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      var s = q.value.trim().toLowerCase();
      document.querySelectorAll('.ep').forEach(function (el) {
        el.hidden = !!(s && el.dataset.search.indexOf(s) === -1);
      });
      document.querySelectorAll('.group').forEach(function (g) {
        var any = Array.prototype.some.call(g.querySelectorAll('.ep'), function (e) { return !e.hidden; });
        g.hidden = !any;
      });
    });
  })();
</script>
</body>
</html>`;
}
