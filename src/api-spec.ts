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
  "POST /api/v1/auth/login": { title: "客户登录", auth: "public", params: "`email`、`password`", desc: "返回 `customer` 与 `session.token`（后续自助接口用）。" },
  "GET /api/v1/auth/me": { title: "我的账号与授权", auth: "customer", desc: "返回当前客户信息 + 名下全部授权（含在用设备）。" },

  /* ---------------- 客户端 · 授权 ---------------- */
  "POST /api/v1/cdks/inspect": { title: "CDK 预检", auth: "public", params: "`cdk`", desc: "查询卡密是否可用、天数、席位、模块，**不核销**。" },
  "POST /api/v1/licenses/activate": {
    title: "用 CDK 激活",
    auth: "public",
    params: "`cdk`✅、`device_id`✅、`device_name?`、`platform?`、`email?`、`password?`、`name?`",
    desc: "核销 CDK 并签发授权：返回 `license_key`（只返回一次）、`license_file`（离线验签用）、到期时间与模块。",
    notes: "带 `email`/`password` 会自动注册或绑定账号；都不带则为匿名激活。并发下 CDK 只可能被核销一次。",
  },
  "POST /api/v1/licenses/heartbeat": {
    title: "心跳续期",
    auth: "public",
    params: "`license_key`✅、`device_id`✅",
    desc: "返回新的 `license_file` 与最新 `expires_at`，滚动离线有效期。",
    notes: "403 = 授权不可用（到期/吊销/暂停/客户停用）；404 = 密钥失效或设备未绑定，需重新激活。",
  },
  "POST /api/v1/licenses/enroll": { title: "加绑设备", auth: "public", params: "`license_key`✅、`device_id`✅、`device_name?`、`platform?`", desc: "为同一授权加绑新设备占用一个席位，席位满返回 409 SEAT_LIMIT。" },
  "POST /api/v1/licenses/release": { title: "解绑设备", auth: "public", params: "`license_key`✅、`device_id`✅", desc: "释放席位，返回 `{released}`。" },
  "GET /api/v1/licenses": { title: "我的授权列表", auth: "customer", desc: "当前客户的授权，每项附在用设备。" },
  "POST /api/v1/licenses/consume": {
    title: "消耗次数（次数型）",
    auth: "public",
    params: "`license_key`✅、`device_id`✅、`count?`（默认 1）",
    desc: "按次数计费的授权每次使用调用一次，原子扣减并返回剩余次数与重新签名的许可证文件。",
    notes: "403 USAGE_EXHAUSTED（次数用完）、409 NOT_COUNT_LICENSE（不是次数型）、404 DEVICE_NOT_BOUND。",
  },
  "GET /api/v1/licenses/:id": { title: "授权详情", auth: "customer", desc: "授权信息 + 全部设备记录 + 模块编码。" },
  "POST /api/v1/licenses/:id/rotate-key": { title: "重置许可证密钥", auth: "customer", params: "`device_id?`", desc: "旧密钥立即失效；带 `device_id` 时一并返回新签发的许可证文件。" },
  "POST /api/v1/licenses/:id/devices/:deviceId/release": { title: "自助解绑设备", auth: "customer", desc: "客户解绑自己的设备（换机用）。" },
  "POST /api/v1/licenses/:id/reenroll": { title: "重新获取许可证文件", auth: "customer", params: "`device_id`✅", desc: "本地缓存丢失时重新拉取签名文件。" },

  /* ---------------- 客户端 · 试用 ---------------- */
  "GET /api/v1/trial/info": { title: "试用配置", auth: "public", desc: "是否开放自助试用、天数、席位、次数上限、限定产品与模块。" },
  "GET /api/v1/trial/status": { title: "我的试用额度", auth: "customer", desc: "每个在售产品的已用次数与剩余次数。" },
  "POST /api/v1/trial/start": {
    title: "开通试用",
    auth: "customer",
    params: "`device_id`✅、`device_name?`、`platform?`、`product_code?`",
    desc: "按试用配置创建 `kind=trial` 授权并绑定设备，返回结构与激活一致。",
    notes: "403 TRIAL_DISABLED / TRIAL_ALREADY_USED / TRIAL_PRODUCT_LIMIT。",
  },

  /* ---------------- 管理 · 认证 ---------------- */
  "POST /admin/api/auth/login": { title: "管理员登录", auth: "public", params: "`email`、`password`", desc: "返回 `token`（后续管理接口放在 Authorization: Bearer 里）。限流 10 次/分钟。" },
  "POST /admin/api/auth/logout": { title: "管理员登出", auth: "admin", desc: "使当前会话失效。" },
  "GET /admin/api/auth/me": { title: "当前管理员", auth: "admin", desc: "管理员信息 + 签名公钥 + 策略参数。" },
  "POST /admin/api/auth/password": { title: "修改密码", auth: "admin", params: "`current_password`、`new_password`", desc: "改完所有会话失效，需重新登录。" },
  "GET /admin/api/admins": { title: "管理员列表", auth: "admin", desc: "全部管理员账号（旧接口，等同 /staff）。" },
  "POST /admin/api/admins": { title: "新增管理员", auth: "admin", params: "`email`、`password`(≥10位)、`name?`", desc: "创建管理端账号（旧接口，建议改用 /staff 以便配置权限）。" },

  /* ---------------- 管理 · 员工与代理 ---------------- */
  "GET /admin/api/staff/options": {
    title: "权限可选项",
    auth: "admin",
    desc: "返回可配置的目录权限（menus）与软件功能（features）清单，以及代理的固定权限，供前端渲染勾选。",
  },
  "GET /admin/api/staff": { title: "员工与代理列表", auth: "admin", desc: "含角色、目录权限、功能权限、所属渠道。" },
  "POST /admin/api/staff": {
    title: "新增员工 / 代理",
    auth: "admin",
    params: "`email`✅、`password`✅(≥8位)、`name?`、`role`(staff|agent)、`menus[]`、`features[]`、`channel_id?`",
    desc: "role=staff 时按 menus/features 授权；role=agent 必须绑定 channel_id，权限固定为「只看卡密页」。仅超级管理员可调用。",
    notes: "400 MISSING_FIELD（代理缺渠道）/ INVALID_FIELD（role 非法）/ WEAK_PASSWORD；409 EMAIL_TAKEN；403 FORBIDDEN_OWNER。",
  },
  "PATCH /admin/api/staff/:id": {
    title: "编辑员工 / 代理",
    auth: "admin",
    params: "`name?`、`status?`、`password?`、`menus[]?`、`features[]?`、`channel_id?`",
    desc: "改权限/状态/密码；停用或改密后该账号的会话立即失效。仅超级管理员可调用。",
  },
  "DELETE /admin/api/staff/:id": { title: "删除员工 / 代理", auth: "admin", desc: "不能删除超级管理员与自己；删除后会话失效。" },

  /* ---------------- 管理 · 概览 ---------------- */
  "GET /admin/api/overview": { title: "概览数据", auth: "admin", desc: "统计（授权/CDK/设备/心跳）+ 渠道汇总 + 14 天内到期 + 最近开通。" },

  /* ---------------- 管理 · 渠道 ---------------- */
  "GET /admin/api/channels": { title: "渠道列表（含统计）", auth: "admin", params: "`q?`、`status?`", desc: "每个渠道带 CDK 生成/核销数、激活率、授权数、营收（累计与近30天）、续费次数；顶层另有 `summary`。" },
  "POST /admin/api/channels": { title: "新增渠道", auth: "admin", params: "`code`（小写）、`name`、`contact?`、`phone?`、`email?`、`note?`", desc: "`code` 自动转小写，重复返回 409 CODE_TAKEN。" },
  "POST /admin/api/channels/:id/credit": {
    title: "充值卡密余额（张数）",
    auth: "admin",
    params: "`amount`✅（正=充值，负=扣减）",
    desc: "调整渠道的**卡密张数额度**（管理员代生成时按张扣减）。代理自行生成请用 `/balance`（按金额）。",
  },
  "GET /admin/api/prices": { title: "卡密价格列表", auth: "admin", params: "`product_id?`", desc: "按产品+模块+卡类型列出价格（单位：分/单位）；`module_id` 为空表示该产品的默认价。" },
  "POST /admin/api/prices": {
    title: "设置卡密价格",
    auth: "admin",
    params: "`product_id`✅、`module_id?`（留空=产品默认价）、`term_type`✅、`unit_price`✅（分/单位）",
    desc: "幂等覆盖同产品/模块/卡类型的价格。解析顺序：模块覆盖价 → 产品默认价 → 未配置则拒绝出卡（PRICE_NOT_CONFIGURED）。",
  },
  "DELETE /admin/api/prices/:id": { title: "删除价格", auth: "admin" },
  "POST /admin/api/channels/:id/balance": {
    title: "充值账户余额（金额）",
    auth: "admin",
    params: "`amount`✅（单位：分，正=充值，负=扣减）",
    desc: "代理生成卡密时按「单价 × 时长/次数 × 张数」从余额扣费，不足返回 409 BALANCE_INSUFFICIENT。",
  },
  "POST /admin/api/channels/batch-balance": {
    title: "一键批量充值",
    auth: "admin",
    params: "`amount`✅（分）、`channel_ids?`（不传=全部渠道）",
    desc: "给多个代理统一充值，返回 `{updated, amount}`。",
  },
  "GET /admin/api/channels/:id": { title: "渠道详情", auth: "admin", desc: "单渠道 + 统计。" },
  "PATCH /admin/api/channels/:id": { title: "编辑渠道", auth: "admin", params: "`name?`、`contact?`、`phone?`、`email?`、`note?`、`status?`", desc: "`status` 只能是 active / disabled。" },
  "DELETE /admin/api/channels/:id": { title: "删除渠道", auth: "admin", desc: "已被 CDK 批次或授权引用时返回 409 CHANNEL_IN_USE，此时应改为停用。" },

  /* ---------------- 管理 · 产品与模块 ---------------- */
  "GET /admin/api/products": { title: "产品列表", auth: "admin", desc: "含模块数、授权数、有效授权数、未使用 CDK 数。" },
  "POST /admin/api/products": { title: "新增产品", auth: "admin", params: "`code`、`name`、`description?`", desc: "`code` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`。" },
  "PATCH /admin/api/products/:id": { title: "编辑产品", auth: "admin", params: "`name?`、`description?`、`status?`", desc: "`status`: active / disabled。" },
  "DELETE /admin/api/products/:id": { title: "删除产品", auth: "admin", desc: "已有授权或 CDK 时返回 409 PRODUCT_IN_USE。" },
  "GET /admin/api/products/:id/modules": { title: "产品下的模块", auth: "admin", desc: "该产品的模块列表。" },
  "POST /admin/api/products/:id/modules": { title: "新增模块", auth: "admin", params: "`code`、`name`、`description?`", desc: "同产品内编码唯一。" },
  "GET /admin/api/modules": { title: "全部模块", auth: "admin", desc: "跨产品查询，附带 product_code。" },
  "PATCH /admin/api/modules/:id": { title: "编辑模块", auth: "admin", params: "`name?`、`description?`、`status?`" },
  "DELETE /admin/api/modules/:id": { title: "删除模块", auth: "admin", desc: "不影响已签发授权。" },

  /* ---------------- 管理 · CDK ---------------- */
  "POST /admin/api/cdks/generate": {
    title: "批量生成 CDK",
    auth: "admin",
    params: "`product_id`✅、`days`✅、`count`✅、`module_ids?`、`seats?`、`note?`、`redeem_before?`、`channel_id?`、`unit_price?`",
    desc: "生成批次卡密，返回码列表与 CSV；`unit_price` 单位为**分**。",
    notes: "单个批次最多 5000 个；`module_ids` 必须属于该产品；`channel_id` 不存在返回 404 CHANNEL_NOT_FOUND。",
  },
  "GET /admin/api/cdks": { title: "CDK 列表", auth: "admin", params: "`product_id?`、`batch_id?`、`status?`、`channel_id?`（`__none__`=直销）、`q?`、分页", desc: "含渠道、结算单价，以及激活后产生的 `license_expires_at` / `license_kind`。" },
  "GET /admin/api/cdk-batches": { title: "CDK 批次", auth: "admin", params: "`product_id?`", desc: "批次列表，含已核销数量。" },
  "POST /admin/api/cdks/:id/revoke": { title: "作废 CDK", auth: "admin", params: "`reason?`", desc: "只有未使用的 CDK 可作废。" },
  "GET /admin/api/cdks/export": { title: "导出 CDK（CSV）", auth: "admin", params: "`batch_id?`、`product_id?`、`status?`", desc: "返回 text/csv（含 BOM，Excel 可直接打开）。" },

  /* ---------------- 管理 · 客户 ---------------- */
  "GET /admin/api/customers": { title: "客户列表", auth: "admin", params: "`q?`、`status?`、分页", desc: "含授权数、有效授权数与最近到期。" },
  "POST /admin/api/customers": { title: "新增客户", auth: "admin", params: "`email?`、`password?`、`name?`、`company?`、`phone?`、`note?`", desc: "邮箱留空即建「匿名客户」；`password` 留空则该客户不能登录；重复邮箱 409 EMAIL_TAKEN。" },
  "GET /admin/api/customers/:id": { title: "客户详情", auth: "admin", desc: "客户信息 + 名下授权（各附设备）。" },
  "PATCH /admin/api/customers/:id": { title: "编辑客户", auth: "admin", params: "`name?`、`company?`、`phone?`、`note?`、`status?`", desc: "停用后该客户心跳立即被拒。" },
  "POST /admin/api/customers/:id/reset-password": { title: "重置客户密码", auth: "admin", desc: "生成临时密码（只返回一次），并使其会话全部失效。" },
  "POST /admin/api/customers/:id/adjust-expiry": { title: "按客户调整到期", auth: "admin", params: "`days?` 或 `expires_at?`、`license_ids?`", desc: "批量调整该客户名下授权的到期时间；`days` 正数延长/负数缩短，`license_ids` 省略则作用于全部未吊销授权。" },

  /* ---------------- 管理 · 授权 ---------------- */
  "GET /admin/api/licenses": { title: "授权列表", auth: "admin", params: "`status?`、`kind?`(paid/trial)、`product_id?`、`customer_id?`、`channel_id?`、`expiring_within_days?`、`q?`、分页", desc: "含 `eff_status`（实时计算）、渠道与设备数。" },
  "POST /admin/api/licenses": { title: "手动开通授权", auth: "admin", params: "`product_id`✅、`customer_id` 或 `customer_email`、`days`✅、`seats?`、`module_ids?`、`note?`、`channel_id?`、`unit_price?`", desc: "不走 CDK 直接开授权，返回 `license_key`（只显示一次）。" },
  "GET /admin/api/licenses/:id": { title: "授权详情", auth: "admin", desc: "授权 + 设备列表 + 模块编码 + 客户信息。" },
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
  { name: "管理 · 渠道", test: (_m, p) => p.includes("/channels") || p.includes("/prices") },
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
  conventions: { title: string; text: string }[];
};

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
      { title: "心跳与到期同步", text: "客户端每次心跳都会拿到最新 `expires_at` 与重新签名的 `license_file`，因此后台改到期后最迟一个心跳周期生效。" },
      { title: "错误码", text: "`401 UNAUTHORIZED`、`403 LICENSE_*` / `TRIAL_*`、`404 CDK_NOT_FOUND`/`INVALID_LICENSE_KEY`/`DEVICE_NOT_BOUND`、`409 SEAT_LIMIT`/`CODE_TAKEN`/`EMAIL_TAKEN`/`CHANNEL_IN_USE`、`429 RATE_LIMITED`。" },
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
    .map((c) => `<div class="conv-item"><h3>${escHtml(c.title)}</h3><p>${inlineCode(c.text)}</p></div>`)
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
  .conv-item p { margin:0; font-size:12.5px; color:var(--muted); }
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
