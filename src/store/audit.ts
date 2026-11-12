/** 审计日志：管理端与客户端的写操作留痕。 */
import { db } from "../db.ts";
import { newId, nowIso } from "../util.ts";
import type { AuditRow } from "../types.ts";

export type AuditInput = {
  actorType: "admin" | "customer" | "system" | "anonymous";
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  detail?: unknown;
};

export function audit(input: AuditInput): void {
  try {
    db()
      .prepare(
        `INSERT INTO audit_logs (id, at, actor_type, actor_id, actor_label, action, target_type, target_id, ip, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("aud"),
        nowIso(),
        input.actorType,
        input.actorId ?? null,
        input.actorLabel ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.ip ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      );
  } catch (err) {
    // 审计失败不能影响主流程
    console.error("[audit] 写入失败", err);
  }
}

export function listAudit(opts: {
  limit: number;
  offset: number;
  action?: string | null;
  actorType?: string | null;
  q?: string | null;
}): { items: AuditRow[]; total: number } {  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  if (opts.actorType) {
    where.push("actor_type = ?");
    params.push(opts.actorType);
  }
  if (opts.q) {
    where.push("(actor_label LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    const p = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(p, p, p);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = db()
    .prepare(`SELECT * FROM audit_logs ${clause} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as unknown as AuditRow[];
  const totalRow = db()
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs ${clause}`)
    .get(...params) as { n: number } | undefined;
  return { items, total: Number(totalRow?.n ?? 0) };
}

/** 某个对象（授权/客户等）的审计记录，用于展示「绑定 / 解绑历史」 */
export function listAuditByTarget(targetId: string, limit = 100): AuditRow[] {
  return db()
    .prepare("SELECT * FROM audit_logs WHERE target_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(targetId, limit) as unknown as AuditRow[];
}
