/**
 * 员工 / 代理的权限模型。
 *
 * - 目录权限（menus）：员工能看到的后台页面
 * - 软件功能授权（features）：员工能执行的操作
 * - 代理（role = agent）：只能看 CDK 页并生成卡密，且数据被限制在自己代理
 */

export type StaffRole = "owner" | "staff" | "agent";

export type Permissions = { menus: string[]; features: string[] };

/** 后台页面（id 与前端 VIEWS 的 key 保持一致） */
export const MENUS = [
  { id: "overview", label: "概览" },
  { id: "products", label: "产品与模块" },
  { id: "cdks", label: "CDK" },
  { id: "agents", label: "代理 / 代理" },
  { id: "licenses", label: "授权" },
  { id: "customers", label: "客户" },
  { id: "audit", label: "审计日志" },
  { id: "staff", label: "员工与代理" },
  { id: "params", label: "软件参数" },
  { id: "apiDocs", label: "API 文档" },
  { id: "settings", label: "设置与公钥" },
] as const;

/** 软件功能（后端接口按这些 id 做鉴权） */
export const FEATURES = [
  { id: "product.manage", label: "产品与模块维护" },
  { id: "cdk.generate", label: "生成卡密" },
  { id: "cdk.revoke", label: "作废卡密" },
  { id: "license.manage", label: "续费 / 改到期 / 吊销" },
  { id: "license.device", label: "绑定与解绑设备" },
  { id: "license.create", label: "手动开通授权" },
  { id: "customer.manage", label: "新增与编辑客户" },
  { id: "customer.expiry", label: "调整客户到期" },
  { id: "agent.manage", label: "代理维护与充值" },
  { id: "trial.config", label: "修改试用配置" },
  { id: "staff.manage", label: "员工与代理管理" },
  { id: "audit.view", label: "查看审计日志" },
] as const;

export const ALL_MENUS: string[] = MENUS.map((m) => m.id);
export const ALL_FEATURES: string[] = FEATURES.map((f) => f.id);

export const OWNER_PERMISSIONS: Permissions = { menus: ALL_MENUS, features: ALL_FEATURES };

/** 代理：只看自己的卡密页、只能生成卡密 */
export const AGENT_PERMISSIONS: Permissions = {
  // 代理：首页 + 卡密 + 自己名下的客户
  menus: ["overview", "cdks", "customers"],
  features: ["cdk.generate", "cdk.revoke", "customer.manage", "customer.expiry"],
};

export function parsePermissions(raw: string | null | undefined, role: StaffRole): Permissions {
  if (role === "owner") return OWNER_PERMISSIONS;
  if (role === "agent") {
    // 代理权限固定，避免误配成能看别人的数据
    return AGENT_PERMISSIONS;
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const obj = (parsed ?? {}) as { menus?: unknown; features?: unknown };
  return {
    menus: Array.isArray(obj.menus) ? obj.menus.filter((m): m is string => typeof m === "string") : [],
    features: Array.isArray(obj.features) ? obj.features.filter((f): f is string => typeof f === "string") : [],
  };
}

export function serializePermissions(perms: Partial<Permissions>): string {
  const clean = (list: unknown, allowed: string[]) =>
    Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && allowed.includes(x)))] : [];
  return JSON.stringify({
    menus: clean(perms.menus, ALL_MENUS),
    features: clean(perms.features, ALL_FEATURES),
  });
}

export function hasMenu(perms: Permissions, menu: string): boolean {
  return perms.menus.includes(menu) || perms.menus.includes("*");
}

export function hasFeature(perms: Permissions, feature: string): boolean {
  return perms.features.includes(feature) || perms.features.includes("*");
}

/* ------------------------------------------------------------------ */
/* 卡密计费类型                                                        */
/* ------------------------------------------------------------------ */

export type TermType = "hour" | "day" | "month" | "year" | "count";

export const TERM_TYPES: { id: TermType; label: string; unit: string }[] = [
  { id: "hour", label: "按小时", unit: "小时" },
  { id: "day", label: "按天", unit: "天" },
  { id: "month", label: "按月", unit: "个月" },
  { id: "year", label: "按年", unit: "年" },
  { id: "count", label: "按次数", unit: "次" },
];

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 按自然月加减（处理 1/31 + 1 月这类边界，落回当月最后一天） */
function addMonths(baseMs: number, months: number): number {
  const d = new Date(baseMs);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

/**
 * 由计费类型算出到期时间。
 * 次数型（count）不按时间到期，给一个远期到期时间，真正的约束是 max_usages。
 */
export function computeExpiry(termType: TermType, termValue: number, startMs: number): number {
  switch (termType) {
    case "hour":
      return startMs + termValue * HOUR;
    case "day":
      return startMs + termValue * DAY;
    case "month":
      return addMonths(startMs, termValue);
    case "year":
      return addMonths(startMs, termValue * 12);
    case "count":
      return addMonths(startMs, 12 * 100); // 100 年，实际由次数控制
    default:
      return startMs + termValue * DAY;
  }
}

/** 归一化计费类型：兼容只有 days 的老数据 */
export function normalizeTerm(
  termType: string | null | undefined,
  termValue: number | null | undefined,
  fallbackDays: number,
): { termType: TermType; termValue: number } {
  const valid: TermType[] = ["hour", "day", "month", "year", "count"];
  const t = (termType && valid.includes(termType as TermType) ? termType : "day") as TermType;
  const v = Number.isFinite(termValue as number) && (termValue as number) > 0 ? (termValue as number) : fallbackDays;
  return { termType: t, termValue: v };
}

export function termLabel(termType: string, termValue: number | null | undefined): string {
  const t = TERM_TYPES.find((x) => x.id === termType);
  if (!t) return `${termValue ?? "-"} 天`;
  return `${termValue ?? "-"} ${t.unit}`;
}

/* ------------------------------------------------------------------ */
/* 管理接口 → 所需功能权限                                             */
/* ------------------------------------------------------------------ */

/**
 * 路由级的权限规则表。集中维护在 server.ts 的 dispatch 里统一校验，
 * 这样新增接口时只要在这里补一行，不必在每个 handler 里重复写 requireFeature。
 */
const ADMIN_FEATURE_RULES: { pattern: RegExp; feature: string }[] = [
  { pattern: /^POST \/admin\/api\/cdks\/generate$/, feature: "cdk.generate" },
  { pattern: /^POST \/admin\/api\/cdks\/[^/]+\/revoke$/, feature: "cdk.revoke" },
  { pattern: /^(POST|PATCH|DELETE) \/admin\/api\/products(\/.*)?$/, feature: "product.manage" },
  { pattern: /^(PATCH|DELETE) \/admin\/api\/modules\/[^/]+$/, feature: "product.manage" },
  { pattern: /^POST \/admin\/api\/customers\/[^/]+\/adjust-expiry$/, feature: "customer.expiry" },
  { pattern: /^(POST|PATCH) \/admin\/api\/customers(\/.*)?$/, feature: "customer.manage" },
  { pattern: /^POST \/admin\/api\/licenses$/, feature: "license.create" },
  { pattern: /^(POST|GET) \/admin\/api\/licenses\/[^/]+\/devices(\/.*)?$/, feature: "license.device" },
  { pattern: /^POST \/admin\/api\/licenses\/[^/]+\/(extend|revoke|rotate-key|reissue|reset-devices)$/, feature: "license.manage" },
  { pattern: /^PATCH \/admin\/api\/licenses\/[^/]+$/, feature: "license.manage" },
  { pattern: /^(POST|PATCH|DELETE) \/admin\/api\/agents(\/.*)?$/, feature: "agent.manage" },
  { pattern: /^PATCH \/admin\/api\/settings\/trial$/, feature: "trial.config" },
  { pattern: /^(GET|POST|PATCH|DELETE) \/admin\/api\/staff(\/.*)?$/, feature: "staff.manage" },
  { pattern: /^(GET|POST) \/admin\/api\/admins$/, feature: "staff.manage" },
];

/** 返回该管理接口所需的功能权限；null 表示登录即可访问 */
export function featureForAdminRoute(method: string, path: string): string | null {
  // 登录/登出/改密/me 等自身账号操作不额外要求功能权限
  if (/^\/admin\/api\/auth\//.test(path)) return null;
  const key = `${method.toUpperCase()} ${path}`;
  for (const rule of ADMIN_FEATURE_RULES) {
    if (rule.pattern.test(key)) return rule.feature;
  }
  return null;
}

