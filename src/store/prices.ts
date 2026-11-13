/**
 * 代理卡密价格表：产品级默认价（module_id = ''）+ 模块可覆盖。
 * 金额单位统一为「分」。
 */
import { db } from "../db.ts";
import { newId, nowIso } from "../util.ts";

export type PriceRow = {
  id: string;
  /** '' = 全局默认价；非空 = 该代理的覆盖价 */
  agent_id: string;
  product_id: string;
  /** '' 表示该产品的默认价（对所有模块生效）；否则只对该模块生效 */
  module_id: string;
  term_type: string;
  unit_price: number;
  created_at: string;
  updated_at: string;
};

export type PriceListItem = PriceRow & {
  product_code: string;
  product_name: string;
  module_code: string | null;
  module_name: string | null;
};

export function listPrices(productId?: string | null, agentId?: string | null): PriceListItem[] {
  const where: string[] = ["p.agent_id = ?"];
  const params: string[] = [agentId ?? ""];
  if (productId) {
    where.push("p.product_id = ?");
    params.push(productId);
  }
  return db()
    .prepare(
      `SELECT p.*, pr.code AS product_code, pr.name AS product_name,
              m.code AS module_code, m.name AS module_name
       FROM agent_prices p
       JOIN products pr ON pr.id = p.product_id
       LEFT JOIN modules m ON m.id = p.module_id
       WHERE ${where.join(" AND ")}
       ORDER BY pr.created_at, p.term_type, p.module_id`,
    )
    .all(...params) as unknown as PriceListItem[];
}

export function findPrice(id: string): PriceRow | null {
  const row = db().prepare("SELECT * FROM agent_prices WHERE id = ?").get(id) as unknown as PriceRow | undefined;
  return row ?? null;
}

/** 设价（同产品/模块/卡类型幂等覆盖） */
export function upsertPrice(input: {
  agentId?: string | null;
  productId: string;
  moduleId: string | null;
  termType: string;
  unitPrice: number;
}): PriceRow {
  const agentId = input.agentId ?? "";
  const moduleId = input.moduleId ?? "";
  const at = nowIso();
  const existing = db()
    .prepare(
      "SELECT * FROM agent_prices WHERE agent_id = ? AND product_id = ? AND module_id = ? AND term_type = ?",
    )
    .get(agentId, input.productId, moduleId, input.termType) as unknown as PriceRow | undefined;

  if (existing) {
    db()
      .prepare("UPDATE agent_prices SET unit_price = ?, updated_at = ? WHERE id = ?")
      .run(Math.max(0, Math.trunc(input.unitPrice)), at, existing.id);
    return findPrice(existing.id) as PriceRow;
  }

  const id = newId("prc");
  db()
    .prepare(
      `INSERT INTO agent_prices (id, agent_id, product_id, module_id, term_type, unit_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, agentId, input.productId, moduleId, input.termType, Math.max(0, Math.trunc(input.unitPrice)), at, at);
  return findPrice(id) as PriceRow;
}

export function deletePrice(id: string): boolean {
  const res = db().prepare("DELETE FROM agent_prices WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/**
 * 解析单价（分/单位），三层优先级：
 *   1) 该代理的覆盖价（agent_id = 代理代理）：模块价 → 产品默认价
 *   2) 全局默认价（agent_id = ''）：模块价 → 产品默认价
 *   3) 都没配 → null（调用方应拒绝生成，避免免费出卡）
 */
export function resolveUnitPrice(
  productId: string,
  moduleIds: string[],
  termType: string,
  agentId?: string | null,
): number | null {
  const stmt = db().prepare(
    "SELECT unit_price FROM agent_prices WHERE agent_id = ? AND product_id = ? AND module_id = ? AND term_type = ?",
  );
  const lookup = (owner: string): number | null => {
    for (const moduleId of moduleIds) {
      const hit = stmt.get(owner, productId, moduleId, termType) as { unit_price: number } | undefined;
      if (hit) return Number(hit.unit_price);
    }
    const fallback = stmt.get(owner, productId, "", termType) as { unit_price: number } | undefined;
    return fallback ? Number(fallback.unit_price) : null;
  };

  const own = agentId ? lookup(agentId) : null;
  if (own !== null) return own;
  return lookup("");
}

/** 总价（分）= 单价 × 数量（天/月/年/时/次）× 张数 */
export function totalPrice(unitPrice: number, termValue: number, count: number): number {
  return Math.max(0, Math.trunc(unitPrice)) * Math.max(0, Math.trunc(termValue)) * Math.max(0, Math.trunc(count));
}

/* ---------------------------- 代理可售范围 ---------------------------- */

export type AgentProfile = { product_ids: string[]; module_ids: string[]; term_types: string[] };

export function parseAgentProfile(raw: string | null | undefined): AgentProfile {
  let obj: unknown = null;
  try {
    obj = raw ? JSON.parse(raw) : null;
  } catch {
    obj = null;
  }
  const o = (obj ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { product_ids: pick(o.product_ids), module_ids: pick(o.module_ids), term_types: pick(o.term_types) };
}

export function serializeAgentProfile(profile: Partial<AgentProfile>): string {
  const pick = (v: unknown) => [...new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])];
  return JSON.stringify({
    product_ids: pick(profile.product_ids),
    module_ids: pick(profile.module_ids),
    term_types: pick(profile.term_types),
  });
}

/** 校验代理是否有权卖这个产品/模块/卡类型（空数组 = 不限制） */
export function checkAgentScope(
  profile: AgentProfile,
  input: { productId: string; moduleIds: string[]; termType: string },
): { ok: true } | { ok: false; code: string; message: string } {
  if (profile.product_ids.length && !profile.product_ids.includes(input.productId)) {
    return { ok: false, code: "AGENT_PRODUCT_DENIED", message: "该产品不在你的可售范围内" };
  }
  if (profile.module_ids.length) {
    const denied = input.moduleIds.filter((m) => !profile.module_ids.includes(m));
    if (denied.length) {
      return { ok: false, code: "AGENT_MODULE_DENIED", message: "包含不在可售范围内的模块" };
    }
  }
  if (profile.term_types.length && !profile.term_types.includes(input.termType)) {
    return { ok: false, code: "AGENT_TERM_DENIED", message: "该卡类型不在你的可售范围内" };
  }
  return { ok: true };
}
