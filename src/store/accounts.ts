/** 管理员、客户、会话。 */
import { db } from "../db.ts";
import { newId, nowIso, nz } from "../util.ts";
import type { AdminRow, CustomerRow, SessionRow } from "../types.ts";

/* ---------------------------- 管理员 ---------------------------- */

export function countAdmins(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM admin_users").get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function findAdminByEmail(email: string): AdminRow | null {
  const row = db().prepare("SELECT * FROM admin_users WHERE email = ?").get(email.toLowerCase()) as
    | unknown as AdminRow
    | undefined;
  return row ?? null;
}

export function findAdminById(id: string): AdminRow | null {
  const row = db().prepare("SELECT * FROM admin_users WHERE id = ?").get(id) as unknown as AdminRow | undefined;
  return row ?? null;
}

export function listAdmins(): AdminRow[] {
  return db().prepare("SELECT * FROM admin_users ORDER BY created_at ASC").all() as unknown as AdminRow[];
}

export function createAdmin(input: {
  email: string;
  passwordHash: string;
  name: string | null;
  role?: string;
}): AdminRow {
  const id = newId("adm");
  db()
    .prepare(
      `INSERT INTO admin_users (id, email, password_hash, name, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, input.email.toLowerCase(), input.passwordHash, nz(input.name), input.role ?? "owner", nowIso());
  return findAdminById(id) as AdminRow;
}

export function updateAdminPassword(id: string, passwordHash: string): void {
  db().prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function touchAdminLogin(id: string): void {
  db().prepare("UPDATE admin_users SET last_login_at = ? WHERE id = ?").run(nowIso(), id);
}

/* ---------------------------- 客户 ---------------------------- */

export function findCustomerById(id: string): CustomerRow | null {
  const row = db().prepare("SELECT * FROM customers WHERE id = ?").get(id) as unknown as CustomerRow | undefined;
  return row ?? null;
}

export function findCustomerByEmail(email: string): CustomerRow | null {
  const row = db().prepare("SELECT * FROM customers WHERE email = ?").get(email.toLowerCase()) as
    | unknown as CustomerRow
    | undefined;
  return row ?? null;
}

export function createCustomer(input: {
  email: string | null;
  passwordHash: string | null;
  name: string | null;
  company?: string | null;
  phone?: string | null;
  note?: string | null;
}): CustomerRow {
  const id = newId("cus");
  const at = nowIso();
  db()
    .prepare(
      `INSERT INTO customers (id, email, password_hash, name, company, phone, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      id,
      input.email ? input.email.toLowerCase() : null,
      nz(input.passwordHash),
      nz(input.name),
      nz(input.company),
      nz(input.phone),
      nz(input.note),
      at,
      at,
    );
  return findCustomerById(id) as CustomerRow;
}

export function updateCustomer(
  id: string,
  patch: Partial<Pick<CustomerRow, "email" | "name" | "company" | "phone" | "status" | "note" | "password_hash">>,
): CustomerRow | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value === undefined ? null : (value as string | null));
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    db().prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  return findCustomerById(id);
}

export function touchCustomerLogin(id: string, at: string = nowIso()): void {
  db().prepare("UPDATE customers SET last_login_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
}

export type CustomerListItem = CustomerRow & {
  license_count: number;
  active_license_count: number;
  last_expires_at: string | null;
};

export function listCustomers(opts: {
  q?: string | null;
  status?: string | null;
  page: number;
  pageSize: number;
}): { items: CustomerListItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    const p = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
    params.push(p, p, p, p);
  }
  if (opts.status) {
    where.push("c.status = ?");
    params.push(opts.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const now = nowIso();
  const items = db()
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count,
              (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id AND l.status = 'active' AND l.expires_at > ?) AS active_license_count,
              (SELECT MAX(l.expires_at) FROM licenses l WHERE l.customer_id = c.id) AS last_expires_at
       FROM customers c
       ${clause}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(now, ...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as CustomerListItem[];
  const totalRow = db()
    .prepare(`SELECT COUNT(*) AS n FROM customers c ${clause}`)
    .get(...params) as { n: number } | undefined;
  return { items, total: Number(totalRow?.n ?? 0) };
}

/* ---------------------------- 会话 ---------------------------- */

export function createSession(input: {
  subjectType: "admin" | "customer";
  subjectId: string;
  tokenHash: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}): SessionRow {
  const id = newId("ses");
  db()
    .prepare(
      `INSERT INTO sessions (id, token_hash, subject_type, subject_id, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.tokenHash,
      input.subjectType,
      input.subjectId,
      nowIso(),
      input.expiresAt,
      nz(input.ip),
      nz(input.userAgent, 400),
    );
  return findSessionByTokenHash(input.tokenHash) as SessionRow;
}

export function findSessionByTokenHash(tokenHash: string): SessionRow | null {
  const row = db().prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | unknown as SessionRow
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

export function revokeSession(id: string): void {
  db().prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
}

export function revokeSessionsFor(subjectType: string, subjectId: string): number {
  const res = db()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL")
    .run(nowIso(), subjectType, subjectId);
  return Number(res.changes);
}

export function purgeExpiredSessions(): number {
  const res = db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  return Number(res.changes);
}
