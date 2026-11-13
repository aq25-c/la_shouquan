/** 试用（trial）：全局试用配置 + 每客户试用次数限制。配置存放在 settings 表。 */
import { db, getSetting, scalar, setSetting } from "../db.ts";
import { nowIso, parseJson, toJson } from "../util.ts";

export type TrialConfig = {
  /** 是否允许客户自助申请试用 */
  enabled: boolean;
  /** v4：试用模式 —— day（试用几天）/ count（试用几次） */
  mode: "day" | "count";
  /** v4：试用量（天数或次数） */
  value: number;
  /** 兼容字段：mode=day 时等于 value */
  days: number;
  /** 试用席位数（可绑定设备数） */
  seats: number;
  /** 限定只能试用该产品；null = 不限制（申请时需传 product_id） */
  product_id: string | null;
  /** 试用包含的模块；空数组 = 该产品全部模块 */
  module_ids: string[];
  /** 同一客户最多可试用几次（按产品分别计） */
  max_per_customer: number;
  /** 试用离线宽限天数；null = 用全局默认 */
  offline_grace_days: number | null;
};

const KEYS = {
  enabled: "trial.enabled",
  mode: "trial.mode",
  value: "trial.value",
  days: "trial.days",
  seats: "trial.seats",
  productId: "trial.product_id",
  moduleIds: "trial.module_ids",
  maxPerCustomer: "trial.max_per_customer",
  graceDays: "trial.offline_grace_days",
} as const;

const DEFAULTS: TrialConfig = {
  enabled: true,
  mode: "day",
  value: 14,
  days: 14,
  seats: 1,
  product_id: null,
  module_ids: [],
  max_per_customer: 1,
  offline_grace_days: null,
};

function intSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getTrialConfig(): TrialConfig {
  const enabledRaw = getSetting(KEYS.enabled);
  const productRaw = getSetting(KEYS.productId);
  const graceRaw = getSetting(KEYS.graceDays);
  const modeRaw = getSetting(KEYS.mode);
  const mode = modeRaw === "count" ? "count" : "day";
  const daysSetting = intSetting(KEYS.days, DEFAULTS.days);
  const value = intSetting(KEYS.value, daysSetting);
  return {
    enabled: enabledRaw === null ? DEFAULTS.enabled : enabledRaw === "1",
    mode,
    value,
    days: mode === "day" ? value : daysSetting,
    seats: intSetting(KEYS.seats, DEFAULTS.seats),
    product_id: productRaw && productRaw !== "" ? productRaw : null,
    module_ids: parseJson<string[]>(getSetting(KEYS.moduleIds), []),
    max_per_customer: intSetting(KEYS.maxPerCustomer, DEFAULTS.max_per_customer),
    offline_grace_days: graceRaw && graceRaw !== "" ? Number.parseInt(graceRaw, 10) : null,
  };
}

export function setTrialConfig(patch: Partial<TrialConfig>): TrialConfig {
  if (patch.enabled !== undefined) setSetting(KEYS.enabled, patch.enabled ? "1" : "0");
  if (patch.mode !== undefined) setSetting(KEYS.mode, patch.mode);
  if (patch.value !== undefined) setSetting(KEYS.value, String(patch.value));
  if (patch.days !== undefined) setSetting(KEYS.days, String(patch.days));
  if (patch.seats !== undefined) setSetting(KEYS.seats, String(patch.seats));
  if (patch.product_id !== undefined) setSetting(KEYS.productId, patch.product_id ?? "");
  if (patch.module_ids !== undefined) setSetting(KEYS.moduleIds, toJson(patch.module_ids));
  if (patch.max_per_customer !== undefined) {
    setSetting(KEYS.maxPerCustomer, String(patch.max_per_customer));
  }
  if (patch.offline_grace_days !== undefined) {
    setSetting(KEYS.graceDays, patch.offline_grace_days === null ? "" : String(patch.offline_grace_days));
  }
  return getTrialConfig();
}

/** 某客户在某产品上已经开通过的试用次数 */
export function trialCountFor(customerId: string, productId: string): number {
  return scalar(
    "SELECT COUNT(*) AS n FROM licenses WHERE customer_id = ? AND product_id = ? AND kind = 'trial'",
    customerId,
    productId,
  );
}

/* ---------------------------- 按产品覆盖 ---------------------------- */

/**
 * 读取某产品的试用配置：产品自己配过的字段覆盖全局默认，未配的沿全局。
 * 这样「产品与模块」里只需要填这个产品关心的几项。
 */
export function getProductTrialConfig(productId: string): TrialConfig {
  const base = getTrialConfig();
  const row = db().prepare("SELECT trial_config FROM products WHERE id = ?").get(productId) as
    | { trial_config: string }
    | undefined;
  const raw = row?.trial_config ?? "";
  if (!raw) return { ...base, product_id: productId };
  const patch = parseJson<Partial<TrialConfig>>(raw, {});
  return { ...base, ...patch, product_id: productId };
}

/** 写入产品级试用配置（只覆盖传进来的字段） */
export function setProductTrialConfig(productId: string, patch: Partial<TrialConfig>): TrialConfig {
  const row = db().prepare("SELECT trial_config FROM products WHERE id = ?").get(productId) as
    | { trial_config: string }
    | undefined;
  const merged = parseJson<Record<string, unknown>>(row?.trial_config ?? "", {});
  for (const [key, value] of Object.entries(patch)) {
    if (key === "product_id") continue; // 产品由路径决定
    if (value !== undefined) merged[key] = value;
  }
  db().prepare("UPDATE products SET trial_config = ?, updated_at = ? WHERE id = ?").run(
    toJson(merged),
    nowIso(),
    productId,
  );
  return getProductTrialConfig(productId);
}

export type TrialGuard = { ok: true } | { ok: false; code: string; message: string };

/** 校验客户是否可以发起试用 */
export function canStartTrial(customerId: string, productId: string): TrialGuard {
  const config = getProductTrialConfig(productId);
  if (!config.enabled) {
    return { ok: false, code: "TRIAL_DISABLED", message: "当前未开放自助试用，请联系服务商" };
  }
  if (config.product_id && config.product_id !== productId) {
    return { ok: false, code: "TRIAL_PRODUCT_LIMIT", message: "试用仅限指定产品" };
  }
  const used = trialCountFor(customerId, productId);
  if (used >= config.max_per_customer) {
    return {
      ok: false,
      code: "TRIAL_ALREADY_USED",
      message: `该产品试用次数已用完（上限 ${config.max_per_customer} 次）`,
    };
  }
  // 只有还没买过正式授权的客户才能试用
  const paid = scalar(
    "SELECT COUNT(*) AS n FROM licenses WHERE customer_id = ? AND product_id = ? AND kind = 'paid'",
    customerId,
    productId,
  );
  if (paid > 0) {
    return {
      ok: false,
      code: "TRIAL_NOT_ALLOWED",
      message: "该产品已有正式授权，无需试用",
    };
  }
  return { ok: true };
}

/** 试用概览（后台用） */
export function trialSummary(): { total: number; active: number; converted: number } {
  return {
    total: scalar("SELECT COUNT(*) AS n FROM licenses WHERE kind = 'trial'"),
    active: scalar(
      "SELECT COUNT(*) AS n FROM licenses WHERE kind = 'trial' AND status = 'active' AND expires_at > datetime('now')",
    ),
    converted: scalar("SELECT COUNT(*) AS n FROM customers c WHERE EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id AND l.kind = 'paid') AND EXISTS (SELECT 1 FROM licenses l WHERE l.customer_id = c.id AND l.kind = 'trial')"),
  };
}
