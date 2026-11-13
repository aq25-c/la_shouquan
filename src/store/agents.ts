/** 代理 / 分销：代理主数据，以及按代理聚合的销售统计。 */
import { db, scalar } from "../db.ts";
import { DAY, newId, nowIso, nz } from "../util.ts";
import type { AgentRow } from "../types.ts";

/** 代理 + 统计（金额单位统一为「分」） */
export type AgentListItem = AgentRow & {
  batch_count: number;
  cdk_total: number;
  cdk_used: number;
  cdk_unused: number;
  license_total: number;
  license_active: number;
  revenue_total: number;
  revenue_30d: number;
  activated_30d: number;
  renew_count: number;
  last_activated_at: string | null;
  /** 激活率（已核销 CDK / 已生成 CDK），0~1 */
  activation_rate: number;
};

/** 统计子查询：所有代理共用同一套口径，口径变化只需改这里。 */
function agentStatsSelect(): string {
  return `
    (SELECT COUNT(*) FROM cdk_batches b WHERE b.agent_id = ch.id) AS batch_count,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.agent_id = ch.id) AS cdk_total,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.agent_id = ch.id AND k.status = 'used') AS cdk_used,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.agent_id = ch.id AND k.status = 'unused') AS cdk_unused,
    (SELECT COUNT(*) FROM licenses l WHERE l.agent_id = ch.id) AS license_total,
    (SELECT COUNT(*) FROM licenses l
       WHERE l.agent_id = ch.id AND l.status = 'active' AND l.expires_at > ?) AS license_active,
    (SELECT COALESCE(SUM(l.unit_price), 0) FROM licenses l WHERE l.agent_id = ch.id) AS revenue_total,
    (SELECT COALESCE(SUM(l.unit_price), 0) FROM licenses l
       WHERE l.agent_id = ch.id AND l.created_at >= ?) AS revenue_30d,
    (SELECT COUNT(*) FROM licenses l
       WHERE l.agent_id = ch.id AND l.created_at >= ?) AS activated_30d,
    (SELECT COUNT(*) FROM audit_logs a JOIN licenses l ON l.id = a.target_id
       WHERE a.action = 'license.extend' AND l.agent_id = ch.id) AS renew_count,
    (SELECT MAX(l.created_at) FROM licenses l WHERE l.agent_id = ch.id) AS last_activated_at`;
}

function withDerived(row: AgentListItem): AgentListItem {
  const total = Number(row.cdk_total ?? 0);
  const used = Number(row.cdk_used ?? 0);
  return {
    ...row,
    batch_count: Number(row.batch_count ?? 0),
    cdk_total: total,
    cdk_used: used,
    cdk_unused: Number(row.cdk_unused ?? 0),
    license_total: Number(row.license_total ?? 0),
    license_active: Number(row.license_active ?? 0),
    revenue_total: Number(row.revenue_total ?? 0),
    revenue_30d: Number(row.revenue_30d ?? 0),
    activated_30d: Number(row.activated_30d ?? 0),
    renew_count: Number(row.renew_count ?? 0),
    activation_rate: total > 0 ? used / total : 0,
  };
}

export function listAgents(opts: { q?: string | null; status?: string | null } = {}): AgentListItem[] {
  const now = nowIso();
  const since = new Date(Date.now() - 30 * DAY).toISOString();

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    where.push("(ch.code LIKE ? ESCAPE '\\' OR ch.name LIKE ? ESCAPE '\\' OR ch.contact LIKE ? ESCAPE '\\')");
    const p = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(p, p, p);
  }
  if (opts.status) {
    where.push("ch.status = ?");
    params.push(opts.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db()
    .prepare(
      `SELECT ch.*, ${agentStatsSelect()}
       FROM agents ch
       ${clause}
       ORDER BY ch.created_at DESC`,
    )
    .all(now, since, since, ...params) as unknown as AgentListItem[];

  return rows.map(withDerived);
}

export function findAgentById(id: string): AgentListItem | null {
  const now = nowIso();
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const row = db()
    .prepare(`SELECT ch.*, ${agentStatsSelect()} FROM agents ch WHERE ch.id = ?`)
    .get(now, since, since, id) as unknown as AgentListItem | undefined;
  return row ? withDerived(row) : null;
}

export function findAgentByCode(code: string): AgentRow | null {
  const row = db().prepare("SELECT * FROM agents WHERE code = ?").get(code.trim().toLowerCase()) as
    | unknown as AgentRow
    | undefined;
  return row ?? null;
}

export function createAgent(input: {
  code: string;
  name: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
}): AgentRow {
  const id = newId("chn");
  const at = nowIso();
  db()
    .prepare(
      `INSERT INTO agents (id, code, name, contact, phone, email, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      input.code.trim().toLowerCase(),
      input.name,
      nz(input.contact),
      nz(input.phone),
      nz(input.email),
      nz(input.note),
      at,
      at,
    );
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow;
  return row;
}

export function updateAgent(
  id: string,
  patch: Partial<Pick<AgentRow, "name" | "contact" | "phone" | "email" | "note" | "status">>,
): AgentRow | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value as string | null);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    db().prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
  return row ?? null;
}

/** 代理被批次或授权引用时不允许删除（返回引用数量，便于提示改停用）。 */
export function agentReferences(id: string): { batches: number; licenses: number } {
  return {
    batches: scalar("SELECT COUNT(*) FROM cdk_batches WHERE agent_id = ?", id),
    licenses: scalar("SELECT COUNT(*) FROM licenses WHERE agent_id = ?", id),
  };
}

export function deleteAgent(id: string): boolean {
  const res = db().prepare("DELETE FROM agents WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/* ---------------------------- 卡密余额（代理额度） ---------------------------- */

/** 充值/扣减卡密余额（amount 可为负，用于人工修正） */
export function rechargeAgent(id: string, amount: number): AgentRow | null {
  db().prepare("UPDATE agents SET credit = credit + ?, updated_at = ? WHERE id = ?").run(amount, nowIso(), id);
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
  return row ?? null;
}

/**
 * 原子扣减卡密余额：余额不足时不扣减并返回 ok=false。
 * 生成卡密时先扣额度，失败则整个事务回滚，不会出现"扣了额度但没出卡"。
 */
export function consumeCredit(id: string, count: number): { ok: boolean; credit: number } {
  const res = db()
    .prepare("UPDATE agents SET credit = credit - ?, updated_at = ? WHERE id = ? AND credit >= ?")
    .run(count, nowIso(), id, count);
  const row = db().prepare("SELECT credit FROM agents WHERE id = ?").get(id) as { credit: number } | undefined;
  return { ok: Number(res.changes) > 0, credit: Number(row?.credit ?? 0) };
}

/* ---------------------------- 账户余额（按金额结算） ---------------------------- */

/** 充值/扣减账户余额（单位：分） */
export function rechargeBalance(id: string, amount: number): AgentRow | null {
  db().prepare("UPDATE agents SET balance = balance + ?, updated_at = ? WHERE id = ?").run(amount, nowIso(), id);
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
  return row ?? null;
}

/** 原子扣减余额（分）：不足则不扣并返回 ok=false，避免并发超扣 */
export function consumeBalance(id: string, amount: number): { ok: boolean; balance: number } {
  const value = Math.max(0, Math.trunc(amount));
  const res = db()
    .prepare("UPDATE agents SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?")
    .run(value, nowIso(), id, value);
  const row = db().prepare("SELECT balance FROM agents WHERE id = ?").get(id) as { balance: number } | undefined;
  return { ok: Number(res.changes) > 0, balance: Number(row?.balance ?? 0) };
}

/** 概览页用的代理汇总。 */
export function agentSummary(): {
  agents: number;
  agents_active: number;
  attributed_licenses: number;
  unattributed_licenses: number;
  revenue_total: number;
  revenue_30d: number;
} {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  return {
    agents: scalar("SELECT COUNT(*) AS n FROM agents"),
    agents_active: scalar("SELECT COUNT(*) AS n FROM agents WHERE status = 'active'"),
    attributed_licenses: scalar("SELECT COUNT(*) AS n FROM licenses WHERE agent_id IS NOT NULL"),
    unattributed_licenses: scalar("SELECT COUNT(*) AS n FROM licenses WHERE agent_id IS NULL"),
    revenue_total: scalar("SELECT COALESCE(SUM(unit_price), 0) AS n FROM licenses"),
    revenue_30d: scalar("SELECT COALESCE(SUM(unit_price), 0) AS n FROM licenses WHERE created_at >= ?", since),
  };
}

/**
 * 代理首页数据：全部只看「我自己名下」的东西。
 * 卡密按批次归属统计；客户与到期按授权上的 agent_id 统计（= 最后一次激活的卡）。
 */
export function agentHome(agentId: string) {
  const agent = findAgentById(agentId);
  const cdk = db()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN k.status = 'unused' THEN 1 ELSE 0 END) AS unused,
         SUM(CASE WHEN k.status = 'used' THEN 1 ELSE 0 END) AS used,
         SUM(CASE WHEN k.status = 'revoked' THEN 1 ELSE 0 END) AS revoked
       FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.agent_id = ?`,
    )
    .get(agentId) as { total: number; unused: number; used: number; revoked: number } | undefined;

  const now = Date.now();
  const rows = db()
    .prepare(
      `SELECT l.id, l.license_no, l.expires_at, l.status, l.seats,
              c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
              p.code AS product_code, p.name AS product_name
         FROM licenses l
         JOIN customers c ON c.id = l.customer_id
         JOIN products p ON p.id = l.product_id
        WHERE l.agent_id = ? AND l.status != 'revoked'
        ORDER BY l.expires_at ASC`,
    )
    .all(agentId) as {
    id: string;
    license_no: string;
    expires_at: string | null;
    status: string;
    seats: number;
    customer_id: string;
    customer_name: string | null;
    customer_email: string | null;
    product_code: string;
    product_name: string;
  }[];

  const withDays = rows.map((r) => {
    const ms = r.expires_at ? Date.parse(r.expires_at) : NaN;
    const daysLeft = Number.isFinite(ms) ? Math.ceil((ms - now) / DAY) : null;
    return { ...r, days_left: daysLeft };
  });

  const expired = withDays.filter((r) => r.days_left !== null && r.days_left < 0);
  const in7 = withDays.filter((r) => r.days_left !== null && r.days_left >= 0 && r.days_left <= 7);
  const in30 = withDays.filter((r) => r.days_left !== null && r.days_left > 7 && r.days_left <= 30);
  const customerIds = new Set(withDays.map((r) => r.customer_id));

  return {
    agent: agent
      ? { id: agent.id, name: agent.name, code: agent.code, balance: agent.balance, credit: agent.credit, status: agent.status }
      : null,
    cdk: {
      total: Number(cdk?.total ?? 0),
      unused: Number(cdk?.unused ?? 0),
      used: Number(cdk?.used ?? 0),
      revoked: Number(cdk?.revoked ?? 0),
    },
    customers: {
      total: customerIds.size,
      expired: expired.length,
      in_7d: in7.length,
      in_30d: in30.length,
    },
    // 近期到期：已过期 + 7 天内（给前端直接列）
    expiring: [...expired, ...in7].slice(0, 20),
    upcoming: in30.slice(0, 20),
  };
}
