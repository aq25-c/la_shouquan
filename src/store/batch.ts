/**
 * 批量操作：未激活卡密 / 已激活授权。
 *
 * 设计要点：
 *   - 先预览（不落库）再执行，前端把影响面写清楚
 *   - 逐条处理，单条失败不影响其它条（失败原因逐条返回，方便单独重试）
 *   - 代理只能操作自己名下：卡密看批次归属，授权看 authorization.agent_id
 *   - 授权延期受 max_expires_at 限制；管理员延长时自动抬高上限
 */
import { db } from "../db.ts";
import { DAY, parseJson, toMs } from "../util.ts";
import {
  findCdkById,
  findLicenseById,
  syncLicenseModules,
  syncModuleExpiry,
  updateCdk,
  updateLicense,
} from "./licensing.ts";
import { findModuleById } from "./catalog.ts";
import { resolvePrice, totalPrice } from "./prices.ts";
import { changeBalance } from "./ledger.ts";

/**
 * 一张卡的价值（分）：单价 × 折算数量 × 席位系数。
 * 没配价返回 null（改卡时说明该档位还没定价）。
 */
export function cardValue(
  agentId: string | null | undefined,
  productId: string,
  moduleIds: string[],
  termType: string,
  termValue: number,
  seats: number,
): number | null {
  const price = resolvePrice(productId, moduleIds, termType, agentId ?? null);
  if (!price) return null;
  return totalPrice(price.unit_price, termValue, 1, Math.max(1, seats), price.seat_ratio);
}

export type BatchItemProblem = { id: string; label: string; reason: string };

export type BatchChanged = {
  id: string;
  label: string;
  from: string | null;
  to: string | null;
  days: number;
  modules: string | null;
};

export type BatchResult = {
  total: number;
  updated: number;
  skipped: BatchItemProblem[];
  failed: BatchItemProblem[];
  /** 实际改动的条目（写日志用） */
  changed: BatchChanged[];
  /** 卡密批量改动涉及的钱：补差 / 退款（分） */
  money: { charged: number; refunded: number };
};

export type BatchOptions = {
  /** 兑换截止 / 授权到期：按天增减 */
  expire_days?: number | null;
  /** 直接设定时间（优先于按天） */
  expires_at?: string | null;
  /** 卡内时长（只对未激活卡密有意义） */
  term_type?: string | null;
  term_value?: number | null;
  /** 模块整体覆盖；null/undefined = 不改 */
  module_ids?: string[] | null;
  /** 代理身份：只能动自己名下 */
  agent_id?: string | null;
};

const MAX_ITEMS = 500;

function validModules(productId: string, ids: string[]): string | null {
  if (!ids.length) return "至少保留一个模块";
  for (const id of ids) {
    const m = findModuleById(id);
    if (!m || m.product_id !== productId) return `模块 ${id} 不属于该产品`;
  }
  return null;
}

/** 把「当前到期 + 偏移」算成新的到期时间；没有到期时间就从现在算 */
function shiftExpiry(current: string | null, days: number): string {
  const base = current && toMs(current) > 0 ? toMs(current) : Date.now();
  return new Date(base + days * DAY).toISOString();
}

/* ------------------------------ 卡密 ------------------------------ */

type CdkPlan = {
  id: string;
  code: string;
  productId: string;
  patch: Parameters<typeof updateCdk>[1];
  before: { expires_at: string | null; term_type: string | null; term_value: number | null; module_ids: string };
  /** 代理改卡时的差价（正=要补，负=要退）；null = 不涉及钱 */
  settle: { diff: number; newValue: number } | null;
};

function planCdk(
  id: string,
  opts: BatchOptions,
): { plan?: CdkPlan; skip?: BatchItemProblem } {
  const cdk = findCdkById(id);
  if (!cdk) return { skip: { id, label: id, reason: "卡密不存在" } };
  const label = cdk.code;

  if (opts.agent_id && cdk.agent_id !== opts.agent_id) {
    return { skip: { id, label, reason: "不属于你的代理" } };
  }
  if (cdk.status !== "unused" || cdk.customer_id) {
    return {
      skip: {
        id,
        label,
        reason: cdk.status === "revoked" ? "已作废" : "已激活，请到授权里批量处理",
      },
    };
  }

  const patch: Parameters<typeof updateCdk>[1] = {};

  // ① 兑换截止时间
  if (opts.expires_at) {
    patch.expiresAt = opts.expires_at;
  } else if (typeof opts.expire_days === "number" && opts.expire_days !== 0) {
    patch.expiresAt = shiftExpiry(cdk.expires_at, opts.expire_days);
  }

  // ② 卡内时长（选了类型就必须给数量，否则算不出天数）
  if (opts.term_type) {
    if (!opts.term_value || opts.term_value < 1) {
      return { skip: { id, label, reason: "填了计费类型但没填数量" } };
    }
    patch.termType = opts.term_type as never;
    patch.termValue = Math.trunc(opts.term_value);
  } else if (typeof opts.term_value === "number" && opts.term_value > 0) {
    patch.termType = (cdk.term_type ?? "day") as never;
    patch.termValue = Math.trunc(opts.term_value);
  }

  // ③ 模块整体覆盖
  if (opts.module_ids) {
    const bad = validModules(cdk.product_id, opts.module_ids);
    if (bad) return { skip: { id, label, reason: bad } };
    patch.moduleIds = opts.module_ids;
  }

  if (!Object.keys(patch).length) {
    return { skip: { id, label, reason: "没有要改的内容" } };
  }

  // 代理改卡：按「新价值 − 实付」结算差价（改大补钱、改小退钱）
  // 实付为 0 的是赠送卡，改它不收费也不退钱
  let settle: { diff: number; newValue: number } | null = null;
  if (opts.agent_id && Number(cdk.paid_amount ?? 0) > 0) {
    const newModules = patch.moduleIds ?? parseJson<string[]>(cdk.module_ids, []);
    const newTermType = patch.termType ?? cdk.term_type ?? "day";
    const newTermValue = patch.termValue ?? cdk.term_value ?? cdk.days;
    const value = cardValue(opts.agent_id, cdk.product_id, newModules, newTermType, newTermValue, cdk.seats);
    if (value === null) {
      return { skip: { id, label, reason: "该卡类型还没定价，改不了" } };
    }
    const diff = value - Number(cdk.paid_amount ?? 0);
    settle = { diff, newValue: value };
    patch.paidAmount = value;
  }

  return {
    plan: {
      id,
      code: label,
      productId: cdk.product_id,
      patch,
      before: {
        expires_at: cdk.expires_at,
        term_type: cdk.term_type,
        term_value: cdk.term_value,
        module_ids: cdk.module_ids,
      },
      settle,
    },
  };
}

export function batchCdks(ids: string[], opts: BatchOptions, apply: boolean): BatchResult {
  const list = ids.slice(0, MAX_ITEMS);
  const result: BatchResult = {
    total: list.length,
    updated: 0,
    skipped: [],
    failed: [],
    changed: [],
    money: { charged: 0, refunded: 0 },
  };

  for (const id of list) {
    const { plan, skip } = planCdk(id, opts);
    if (skip) {
      result.skipped.push(skip);
      continue;
    }
    if (!apply) {
      result.updated += 1;
      continue;
    }
    try {
      // 代理改卡先结算差价：补钱时余额不够就这条失败，不动卡
      if (plan!.settle && plan!.settle.diff !== 0) {
        const pay = changeBalance(opts.agent_id!, -plan!.settle.diff, {
          kind: plan!.settle.diff > 0 ? "adjust_up" : "adjust_down",
          refType: "cdk",
          refId: plan!.id,
          refLabel: plan!.code,
          note: plan!.settle.diff > 0 ? "改卡补差价" : "改卡退款",
          actorType: "agent",
        });
        if (!pay.ok) {
          result.failed.push({
            id,
            label: plan!.code,
            reason: `余额不足，还差 ¥${(plan!.settle.diff / 100).toFixed(2)}`,
          });
          continue;
        }
      }
      const updated = updateCdk(plan!.id, plan!.patch);
      if (!updated) {
        result.failed.push({ id, label: plan!.code, reason: "写入失败" });
        continue;
      }
      result.updated += 1;
      if (plan!.settle && plan!.settle.diff !== 0) {
        if (plan!.settle.diff > 0) result.money.charged += plan!.settle.diff;
        else result.money.refunded += -plan!.settle.diff;
      }
      result.changed.push({
        id,
        label: plan!.code,
        from: plan!.before.expires_at,
        to: updated.expires_at ?? null,
        days: 0,
        modules: plan!.patch.moduleIds ? plan!.patch.moduleIds.join(",") : null,
      });
    } catch (err) {
      result.failed.push({ id, label: plan!.code, reason: (err as Error).message || "写入失败" });
    }
  }
  return result;
}

/* ------------------------------ 授权 ------------------------------ */

type LicensePlan = {
  id: string;
  label: string;
  patch: Parameters<typeof updateLicense>[1];
  from: string | null;
  to: string | null;
  days: number;
  raiseCap: boolean;
};

function planLicense(
  id: string,
  opts: BatchOptions,
): { plan?: LicensePlan; skip?: BatchItemProblem } {
  const lic = findLicenseById(id);
  if (!lic) return { skip: { id, label: id, reason: "授权不存在" } };
  const label = lic.license_no;

  if (opts.agent_id && lic.agent_id !== opts.agent_id) {
    return { skip: { id, label, reason: "不属于你的代理" } };
  }
  if (lic.status === "revoked") {
    return { skip: { id, label, reason: "已吊销" } };
  }

  const patch: Parameters<typeof updateLicense>[1] = {};
  const from = lic.expires_at ?? null;
  let to = from;
  let raiseCap = false;

  // 到期：直接设定 > 按天
  if (opts.expires_at) {
    to = opts.expires_at;
  } else if (typeof opts.expire_days === "number" && opts.expire_days !== 0) {
    to = shiftExpiry(from, opts.expire_days);
  }

  if (to && to !== from) {
    // 代理受上限约束；管理员延长时同步抬高上限
    if (opts.agent_id) {
      const cap = lic.max_expires_at ?? null;
      // 只有「往后延且超过上限」才拦；缩短（哪怕当前已经超了）一律放行，
      // 否则数据里一旦超上限，代理连往回改都改不了
      const isExtend = from ? toMs(to) > toMs(from) : true;
      if (cap && isExtend && toMs(to) > toMs(cap)) {
        return {
          skip: {
            id,
            label,
            reason: `超出当前最大时间，最多只能调整到 ${new Date(toMs(cap)).toISOString().slice(0, 10)}`,
          },
        };
      }
    } else if (!lic.max_expires_at || toMs(to) > toMs(lic.max_expires_at)) {
      raiseCap = true;
    }
    patch.expires_at = to;
  }

  // 模块整体覆盖
  if (opts.module_ids) {
    const bad = validModules(lic.product_id, opts.module_ids);
    if (bad) return { skip: { id, label, reason: bad } };
    patch.module_ids = JSON.stringify(opts.module_ids);
  }

  if (!Object.keys(patch).length) {
    return { skip: { id, label, reason: "没有要改的内容" } };
  }

  const days =
    from && to && from !== to ? Math.round((toMs(to) - toMs(from)) / DAY) : 0;

  return { plan: { id, label, patch, from, to: to ?? null, days, raiseCap } };
}

export function batchLicenses(ids: string[], opts: BatchOptions, apply: boolean): BatchResult {
  const list = ids.slice(0, MAX_ITEMS);
  const result: BatchResult = {
    total: list.length,
    updated: 0,
    skipped: [],
    failed: [],
    changed: [],
    money: { charged: 0, refunded: 0 },
  };

  for (const id of list) {
    const { plan, skip } = planLicense(id, opts);
    if (skip) {
      result.skipped.push(skip);
      continue;
    }
    if (!apply) {
      result.updated += 1;
      continue;
    }
    try {
      const p = plan!;
      const updated = updateLicense(p.id, p.patch);
      if (!updated) {
        result.failed.push({ id, label: p.label, reason: "写入失败" });
        continue;
      }
      if (p.raiseCap && updated.expires_at) {
        // 管理员延长超过原上限时，把上限一起抬高，否则代理之后再调整会被老上限卡住
        db().prepare("UPDATE licenses SET max_expires_at = ? WHERE id = ?").run(updated.expires_at, p.id);
      }
      // 模块与到期联动：到期变了同步所有模块；模块变了补建/清理记录
      if (p.patch.expires_at) syncModuleExpiry(p.id, p.patch.expires_at);
      if (p.patch.module_ids) {
        const expires = updated.expires_at ?? p.to ?? new Date().toISOString();
        syncLicenseModules(p.id, JSON.parse(p.patch.module_ids), expires);
      }
      result.updated += 1;
      result.changed.push({
        id,
        label: p.label,
        from: p.from,
        to: updated.expires_at ?? p.to,
        days: p.days,
        modules: p.patch.module_ids ? (JSON.parse(p.patch.module_ids as string) as string[]).join(",") : null,
      });
    } catch (err) {
      result.failed.push({ id, label: plan!.label, reason: (err as Error).message || "写入失败" });
    }
  }
  return result;
}
