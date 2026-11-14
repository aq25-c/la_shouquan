/**
 * 代理余额流水（agent_ledger）
 *
 * 所有会让 agents.balance 变化的操作都必须走 changeBalance()，
 * 这样「余额」和「流水」永远对得上，出问题能逐笔查。
 *
 * kind：
 *   opening       期初余额（升级时补的一条，用来平账）
 *   recharge      充值
 *   consume       生成卡密扣费
 *   adjust_up     改卡补差（扣钱）
 *   adjust_down   改卡退款（退钱）
 *   refund_delete 删除未激活卡退款
 *   manual        管理员手工调整（直接改余额）
 */
import { db, withTx } from "../db.ts";
import { newId, nowIso } from "../util.ts";
import type { AgentLedgerRow } from "../types.ts";

export type LedgerKind =
  | "opening"
  | "recharge"
  | "consume"
  | "adjust_up"
  | "adjust_down"
  | "refund_delete"
  | "manual";

export type LedgerMeta = {
  kind: LedgerKind;
  refType?: "cdk" | "batch" | "license" | null;
  refId?: string | null;
  refLabel?: string | null;
  note?: string | null;
  actorType?: string | null;
  actorLabel?: string | null;
  ip?: string | null;
};

/** 只写一条流水（余额已由别处改好时用，比如期初单） */
export function addLedger(agentId: string, amount: number, balanceAfter: number, meta: LedgerMeta): AgentLedgerRow {
  const id = newId("led");
  db()
    .prepare(
      `INSERT INTO agent_ledger
         (id, agent_id, at, kind, amount, balance_after, ref_type, ref_id, ref_label, note, actor_type, actor_label, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      agentId,
      nowIso(),
      meta.kind,
      Math.trunc(amount),
      Math.trunc(balanceAfter),
      meta.refType ?? null,
      meta.refId ?? null,
      meta.refLabel ?? null,
      meta.note ?? null,
      meta.actorType ?? null,
      meta.actorLabel ?? null,
      meta.ip ?? null,
    );
  return db().prepare("SELECT * FROM agent_ledger WHERE id = ?").get(id) as unknown as AgentLedgerRow;
}

/**
 * 改余额 + 记流水（一个事务）。
 * 扣钱时余额不足直接返回 ok=false，不做任何修改。
 */
export function changeBalance(
  agentId: string,
  delta: number,
  meta: LedgerMeta,
): { ok: boolean; balance: number; entry: AgentLedgerRow | null; reason?: string } {
  const amount = Math.trunc(delta);
  const agent = db().prepare("SELECT balance FROM agents WHERE id = ?").get(agentId) as
    | { balance: number }
    | undefined;
  if (!agent) return { ok: false, balance: 0, entry: null, reason: "代理不存在" };

  const current = Number(agent.balance ?? 0);
  if (amount < 0 && current + amount < 0) {
    return { ok: false, balance: current, entry: null, reason: "余额不足" };
  }
  if (amount === 0) {
    return { ok: true, balance: current, entry: null };
  }

  const next = current + amount;
  const entry = withTx(() => {
    db().prepare("UPDATE agents SET balance = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), agentId);
    return addLedger(agentId, amount, next, meta);
  });
  return { ok: true, balance: next, entry };
}

export type LedgerSummary = {
  recharge: number;
  consume: number;
  adjust_up: number;
  adjust_down: number;
  refund_delete: number;
  manual: number;
  opening: number;
  /** 流水条数 */
  entries: number;
};

export function listLedger(
  agentId: string,
  opts: { page: number; pageSize: number },
): { items: AgentLedgerRow[]; total: number } {
  const items = db()
    .prepare("SELECT * FROM agent_ledger WHERE agent_id = ? ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?")
    .all(agentId, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as AgentLedgerRow[];
  const row = db().prepare("SELECT COUNT(*) AS n FROM agent_ledger WHERE agent_id = ?").get(agentId) as
    | { n: number }
    | undefined;
  return { items, total: Number(row?.n ?? 0) };
}

export function ledgerSummary(agentId: string): LedgerSummary & { balance: number } {
  const rows = db()
    .prepare("SELECT kind, SUM(amount) AS total, COUNT(*) AS n FROM agent_ledger WHERE agent_id = ? GROUP BY kind")
    .all(agentId) as unknown as { kind: string; total: number; n: number }[];
  const out: LedgerSummary = {
    recharge: 0,
    consume: 0,
    adjust_up: 0,
    adjust_down: 0,
    refund_delete: 0,
    manual: 0,
    opening: 0,
    entries: 0,
  };
  for (const r of rows) {
    const k = r.kind as keyof LedgerSummary;
    if (k in out && k !== "entries") out[k] = Number(r.total ?? 0);
    out.entries += Number(r.n ?? 0);
  }
  const agent = db().prepare("SELECT balance FROM agents WHERE id = ?").get(agentId) as
    | { balance: number }
    | undefined;
  return { ...out, balance: Number(agent?.balance ?? 0) };
}
