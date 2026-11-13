/** CDK、授权、设备席位。 */
import { config } from "../config.ts";
import { db, withTx } from "../db.ts";
import { formatCdkCode, generateCdkCode, normalizeCdkCode } from "../crypto.ts";
import { computeExpiry, normalizeTerm } from "../permissions.ts";
import type { TermType } from "../permissions.ts";
import { DAY, newId, nowIso, nz, parseJson, toJson, toMs } from "../util.ts";
import type { CdkBatchRow, CdkRow, DeviceRow, EffectiveLicenseStatus, LicenseRow } from "../types.ts";

/* ============================ CDK ============================ */

export type CdkListItem = CdkRow & {
  product_code: string;
  product_name: string;
  customer_email: string | null;
  license_no: string | null;
  /** 激活后产生的授权到期时间与类型（未激活为 null） */
  license_expires_at: string | null;
  license_kind: string | null;
  /** 以下字段来自所属 CDK 批次（v2 代理 / 单价） */
  agent_id: string | null;
  unit_price: number;
  agent_code: string | null;
  agent_name: string | null;
};

function cdkSelect(): string {
  return `SELECT k.*, p.code AS product_code, p.name AS product_name,
                 c.email AS customer_email, l.license_no AS license_no,
                 l.expires_at AS license_expires_at, l.kind AS license_kind,
                 b.agent_id AS agent_id, b.unit_price AS unit_price,
                 ch.code AS agent_code, ch.name AS agent_name
          FROM cdks k
          JOIN products p ON p.id = k.product_id
          LEFT JOIN customers c ON c.id = k.customer_id
          LEFT JOIN licenses l ON l.id = k.license_id
          LEFT JOIN cdk_batches b ON b.id = k.batch_id
          LEFT JOIN agents ch ON ch.id = b.agent_id`;
}

export function findCdkByCode(raw: string): CdkListItem | null {
  const code = formatCdkCode(normalizeCdkCode(raw));
  const row = db().prepare(`${cdkSelect()} WHERE k.code = ?`).get(code) as unknown as CdkListItem | undefined;
  return row ?? null;
}

export function findCdkById(id: string): CdkListItem | null {
  const row = db().prepare(`${cdkSelect()} WHERE k.id = ?`).get(id) as unknown as CdkListItem | undefined;
  return row ?? null;
}

export function createCdkBatch(input: {
  productId: string;
  moduleIds: string[];
  days: number;
  seats: number;
  count: number;
  note: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  /** v2：归属代理（null / 未传 = 直销） */
  agentId?: string | null;
  /** v2：结算单价，单位「分」 */
  unitPrice?: number;
  /** v4：计费类型（hour/day/month/year/count），未传按 day + days */
  termType?: TermType;
  termValue?: number | null;
}): { batch: CdkBatchRow; codes: string[] } {
  return withTx(() => {
    const batchId = newId("cdb");
    const at = nowIso();
    const term = normalizeTerm(input.termType ?? null, input.termValue ?? null, input.days);
    db()
      .prepare(
        `INSERT INTO cdk_batches
           (id, product_id, count, days, seats, module_ids, note, created_by, created_at,
            agent_id, unit_price, term_type, term_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batchId,
        input.productId,
        input.count,
        input.days,
        input.seats,
        toJson(input.moduleIds),
        nz(input.note),
        nz(input.createdBy),
        at,
        nz(input.agentId),
        Math.max(0, Math.trunc(input.unitPrice ?? 0)),
        term.termType,
        term.termValue,
      );

    const insert = db().prepare(
      `INSERT OR IGNORE INTO cdks
         (id, code, batch_id, product_id, module_ids, days, seats, status, expires_at, note, created_by, created_at,
          term_type, term_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?, ?, ?, ?, ?)`,
    );
    const codes: string[] = [];
    let attempts = 0;
    const maxAttempts = input.count * 8 + 100;
    while (codes.length < input.count && attempts < maxAttempts) {
      attempts += 1;
      const code = generateCdkCode();
      const res = insert.run(
        newId("cdk"),
        code,
        batchId,
        input.productId,
        toJson(input.moduleIds),
        input.days,
        input.seats,
        nz(input.expiresAt),
        nz(input.note),
        nz(input.createdBy),
        at,
        term.termType,
        term.termValue,
      );
      if (Number(res.changes) > 0) codes.push(code);
    }
    if (codes.length < input.count) {
      throw new Error(`CDK 生成不足：需要 ${input.count}，实际 ${codes.length}`);
    }
    const batch = db().prepare("SELECT * FROM cdk_batches WHERE id = ?").get(batchId) as unknown as CdkBatchRow;
    return { batch, codes };
  });
}

export function listCdks(opts: {
  productId?: string | null;
  batchId?: string | null;
  status?: string | null;
  q?: string | null;
  /** v2：按代理筛选；传 "__none__" 表示只看无代理（直销）的批次 */
  agentId?: string | null;
  page: number;
  pageSize: number;
}): { items: CdkListItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.productId) {
    where.push("k.product_id = ?");
    params.push(opts.productId);
  }
  if (opts.batchId) {
    where.push("k.batch_id = ?");
    params.push(opts.batchId);
  }
  if (opts.status) {
    where.push("k.status = ?");
    params.push(opts.status);
  }
  if (opts.q) {
    const p = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(k.code LIKE ? ESCAPE '\\' OR k.note LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')");
    params.push(p, p, p);
  }
  if (opts.agentId === "__none__") {
    where.push("b.agent_id IS NULL");
  } else if (opts.agentId) {
    where.push("b.agent_id = ?");
    params.push(opts.agentId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = db()
    .prepare(`${cdkSelect()} ${clause} ORDER BY k.created_at DESC, k.rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as CdkListItem[];
  const totalRow = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM cdks k
       JOIN products p ON p.id = k.product_id
       LEFT JOIN customers c ON c.id = k.customer_id
       LEFT JOIN cdk_batches b ON b.id = k.batch_id
       ${clause}`,
    )
    .get(...params) as { n: number } | undefined;
  return { items, total: Number(totalRow?.n ?? 0) };
}

export function listBatchCdks(batchId: string): CdkRow[] {
  return db().prepare("SELECT * FROM cdks WHERE batch_id = ? ORDER BY code ASC").all(batchId) as unknown as CdkRow[];
}

export function listBatches(productId?: string | null): (CdkBatchRow & { product_code: string; product_name: string; used_count: number })[] {
  const where = productId ? "WHERE b.product_id = ?" : "";
  const params = productId ? [productId] : [];
  return db()
    .prepare(
      `SELECT b.*, p.code AS product_code, p.name AS product_name,
              (SELECT COUNT(*) FROM cdks k WHERE k.batch_id = b.id AND k.status = 'used') AS used_count
       FROM cdk_batches b JOIN products p ON p.id = b.product_id
       ${where}
       ORDER BY b.created_at DESC`,
    )
    .all(...params) as unknown as (CdkBatchRow & { product_code: string; product_name: string; used_count: number })[];
}

/** 原子核销 CDK：返回 false 表示已被并发核销。 */
export function markCdkUsed(id: string, customerId: string, licenseId: string): boolean {
  const res = db()
    .prepare("UPDATE cdks SET status = 'used', customer_id = ?, license_id = ?, used_at = ? WHERE id = ? AND status = 'unused'")
    .run(customerId, licenseId, nowIso(), id);
  return Number(res.changes) > 0;
}

export function revokeCdk(id: string, reason: string | null): CdkRow | null {
  db()
    .prepare("UPDATE cdks SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ? AND status = 'unused'")
    .run(nowIso(), nz(reason), id);
  const row = db().prepare("SELECT * FROM cdks WHERE id = ?").get(id) as unknown as CdkRow | undefined;
  return row ?? null;
}

/* ============================ 授权 ============================ */

export type LicenseListItem = LicenseRow & {
  customer_email: string | null;
  customer_name: string | null;
  product_code: string;
  product_name: string;
  /** v2：来源代理（null = 直销） */
  agent_code: string | null;
  agent_name: string | null;
  active_devices: number;
  eff_status: EffectiveLicenseStatus;
};

/** 计算状态：到期/未生效是动态判定的，不落库，避免定时任务。 */
export function effectiveStatus(row: LicenseRow, refMs: number = Date.now()): EffectiveLicenseStatus {
  if (row.status === "revoked") return "revoked";
  if (row.status === "suspended") return "suspended";
  if (toMs(row.expires_at) <= refMs) return "expired";
  if (toMs(row.starts_at) > refMs) return "pending";
  return "active";
}

function licenseSelect(): string {
  return `SELECT l.*, c.email AS customer_email, c.name AS customer_name,
                 p.code AS product_code, p.name AS product_name,
                 ch.code AS agent_code, ch.name AS agent_name,
                 (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id AND d.status = 'active') AS active_devices,
                 CASE
                   WHEN l.status = 'revoked' THEN 'revoked'
                   WHEN l.status = 'suspended' THEN 'suspended'
                   WHEN l.expires_at <= ? THEN 'expired'
                   WHEN l.starts_at > ? THEN 'pending'
                   ELSE 'active'
                 END AS eff_status
          FROM licenses l
          JOIN customers c ON c.id = l.customer_id
          JOIN products p ON p.id = l.product_id
          LEFT JOIN agents ch ON ch.id = l.agent_id`;
}

export function findLicenseById(id: string): LicenseListItem | null {
  const now = nowIso();
  const row = db().prepare(`${licenseSelect()} WHERE l.id = ?`).get(now, now, id) as unknown as
    | LicenseListItem
    | undefined;
  return row ?? null;
}

export function findLicenseByKeyHash(keyHash: string): LicenseListItem | null {
  const now = nowIso();
  const row = db().prepare(`${licenseSelect()} WHERE l.key_hash = ?`).get(now, now, keyHash) as unknown as
    | LicenseListItem
    | undefined;
  return row ?? null;
}

export function listLicensesByCustomer(customerId: string): LicenseListItem[] {
  const now = nowIso();
  return db()
    .prepare(`${licenseSelect()} WHERE l.customer_id = ? ORDER BY l.created_at DESC`)
    .all(now, now, customerId) as unknown as LicenseListItem[];
}

export function listLicenses(opts: {
  q?: string | null;
  status?: string | null;
  productId?: string | null;
  customerId?: string | null;
  /** v2：按代理筛选；传 "__none__" 表示只看无代理（直销）的授权 */
  agentId?: string | null;
  /** v3：按授权类型筛选（paid / trial） */
  kind?: string | null;
  expiringWithinDays?: number | null;
  page: number;
  pageSize: number;
}): { items: LicenseListItem[]; total: number } {
  const now = nowIso();
  const outer: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    const p = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    outer.push("(license_no LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\')");
    params.push(p, p, p);
  }
  if (opts.status) {
    outer.push("eff_status = ?");
    params.push(opts.status);
  }
  if (opts.productId) {
    outer.push("product_id = ?");
    params.push(opts.productId);
  }
  if (opts.customerId) {
    outer.push("customer_id = ?");
    params.push(opts.customerId);
  }
  if (opts.agentId === "__none__") {
    outer.push("agent_id IS NULL");
  } else if (opts.agentId) {
    outer.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.kind) {
    outer.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.expiringWithinDays !== null && opts.expiringWithinDays !== undefined) {
    outer.push("expires_at > ? AND expires_at <= ?");
    params.push(now, new Date(Date.now() + opts.expiringWithinDays * DAY).toISOString());
  }
  const clause = outer.length ? `WHERE ${outer.join(" AND ")}` : "";
  const items = db()
    .prepare(`SELECT * FROM (${licenseSelect()}) ${clause} ORDER BY expires_at ASC LIMIT ? OFFSET ?`)
    .all(now, now, ...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as LicenseListItem[];
  const totalRow = db()
    .prepare(`SELECT COUNT(*) AS n FROM (${licenseSelect()}) ${clause}`)
    .get(now, now, ...params) as { n: number } | undefined;
  return { items, total: Number(totalRow?.n ?? 0) };
}

export function createLicense(input: {
  customerId: string;
  productId: string;
  cdkId: string | null;
  moduleIds: string[];
  seats: number;
  days: number;
  startsAt?: string;
  offlineGraceDays?: number;
  keyHash: string;
  note: string | null;
  /** v2：来源代理（通常从 CDK 批次继承） */
  agentId?: string | null;
  /** v2：结算单价，单位「分」 */
  unitPrice?: number;
  /** v3：授权类型，默认正式 */
  kind?: "paid" | "trial";
  /** v3：开通来源（cdk / manual / trial），默认 cdk */
  source?: string;
  /** v4：计费类型（未传按 day + days） */
  termType?: TermType;
  termValue?: number | null;
}): LicenseRow {
  const id = newId("lic");
  const at = nowIso();
  const startsAt = input.startsAt ?? at;
  const startMs = toMs(startsAt) || Date.now();
  const term = normalizeTerm(input.termType ?? null, input.termValue ?? null, input.days);
  const expiresAt = new Date(computeExpiry(term.termType, term.termValue, startMs)).toISOString();
  // 次数型：max_usages 记录总额度，到期只是远期占位
  const maxUsages = term.termType === "count" ? term.termValue : null;
  db()
    .prepare(
      `INSERT INTO licenses
         (id, license_no, customer_id, product_id, cdk_id, module_ids, seats, status, starts_at, expires_at,
          offline_grace_days, key_hash, note, created_at, updated_at, agent_id, unit_price, kind, source,
          term_type, term_value, max_usages, used_usages, max_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      nextLicenseNo(),
      input.customerId,
      input.productId,
      nz(input.cdkId),
      toJson(input.moduleIds),
      input.seats,
      startsAt,
      expiresAt,
      input.offlineGraceDays ?? config.offlineGraceDays,
      input.keyHash,
      nz(input.note),
      at,
      at,
      nz(input.agentId),
      Math.max(0, Math.trunc(input.unitPrice ?? 0)),
      input.kind ?? "paid",
      input.source ?? "cdk",
      term.termType,
      term.termValue,
      maxUsages,
      expiresAt, // v8：上限 = CDK 授予的实际到期时间
    );
  // v9：为每个模块建立到期记录（默认跟随授权到期）
  syncLicenseModules(id, input.moduleIds, expiresAt);
  return db().prepare("SELECT * FROM licenses WHERE id = ?").get(id) as unknown as LicenseRow;
}

/**
 * 消耗次数型授权的次数（原子扣减）。
 * ok=false 表示额度已用完或该授权不是次数型。
 */
export function consumeUsage(
  licenseId: string,
  count = 1,
): { ok: boolean; max: number | null; used: number; remaining: number } {
  const res = db()
    .prepare(
      `UPDATE licenses SET used_usages = used_usages + ?, updated_at = ?
       WHERE id = ? AND max_usages IS NOT NULL AND used_usages + ? <= max_usages`,
    )
    .run(count, nowIso(), licenseId, count);
  const row = db()
    .prepare("SELECT max_usages, used_usages FROM licenses WHERE id = ?")
    .get(licenseId) as { max_usages: number | null; used_usages: number } | undefined;
  const max = row?.max_usages ?? null;
  const used = Number(row?.used_usages ?? 0);
  return {
    ok: Number(res.changes) > 0,
    max,
    used,
    remaining: max === null ? 0 : Math.max(0, max - used),
  };
}

function nextLicenseNo(): string {
  const year = new Date().getUTCFullYear();
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM licenses WHERE license_no LIKE ?")
    .get(`LIC-${year}-%`) as { n: number } | undefined;
  const seq = Number(row?.n ?? 0) + 1;
  return `LIC-${year}-${String(seq).padStart(5, "0")}`;
}

export function updateLicense(
  id: string,
  patch: Partial<Pick<LicenseRow, "status" | "expires_at" | "starts_at" | "seats" | "module_ids" | "note" | "offline_grace_days">>,
): LicenseRow | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value as string | number | null);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    db().prepare(`UPDATE licenses SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  const row = db().prepare("SELECT * FROM licenses WHERE id = ?").get(id) as unknown as LicenseRow | undefined;
  return row ?? null;
}

/** 延长/缩短授权：在原到期时间（若已过期则从当前时间）基础上加减天数。 */
export function extendLicense(id: string, days: number, fromNow = false): LicenseRow | null {
  const row = db().prepare("SELECT * FROM licenses WHERE id = ?").get(id) as unknown as LicenseRow | undefined;
  if (!row) return null;
  const current = toMs(row.expires_at);
  const base = fromNow || current <= Date.now() ? Date.now() : current;
  return updateLicense(id, { expires_at: new Date(base + days * DAY).toISOString() });
}

/**
 * 按客户批量调整到期时间（后台「客户列表 → 调整到期」用）。
 * - days：在原到期时间上加减（已过期则从当前时间起算）
 * - expiresAt：直接设为指定时间
 * - licenseIds：只调整指定授权（省略 = 该客户全部未吊销授权）
 */
export function adjustCustomerExpiry(
  customerId: string,
  opts: { days?: number; expiresAt?: string; licenseIds?: string[]; capByMaxExpiry?: boolean },
): { updated: number; items: LicenseRow[] } {
  const rows = db()
    .prepare("SELECT * FROM licenses WHERE customer_id = ? AND status != 'revoked'")
    .all(customerId) as unknown as LicenseRow[];

  const wanted = opts.licenseIds && opts.licenseIds.length ? new Set(opts.licenseIds) : null;
  const targets = wanted ? rows.filter((r) => wanted.has(r.id)) : rows;

  const items: LicenseRow[] = [];
  for (const row of targets) {
    let updated = opts.expiresAt
      ? updateLicense(row.id, { expires_at: opts.expiresAt })
      : typeof opts.days === "number"
        ? extendLicense(row.id, opts.days)
        : null;
    if (!updated) continue;
    if (!updated.expires_at) {
      items.push(updated);
      continue;
    }

    const cap = updated.max_expires_at ?? row.max_expires_at ?? null;
    const nextMs = toMs(updated.expires_at);
    if (opts.capByMaxExpiry && cap && nextMs > toMs(cap)) {
      // 代理：可以缩短、也可以恢复，但不得超过 CDK 授予的上限
      updated = updateLicense(updated.id, { expires_at: cap }) ?? updated;
    } else if (!opts.capByMaxExpiry && (!cap || nextMs > toMs(cap))) {
      // 管理员：延长时同步抬高上限，之后代理仍可恢复到该值
      db().prepare("UPDATE licenses SET max_expires_at = ? WHERE id = ?").run(updated.expires_at, updated.id);
    }
    items.push(updated);
  }
  return { updated: items.length, items };
}

export function revokeLicense(id: string, reason: string | null): LicenseRow | null {
  db()
    .prepare("UPDATE licenses SET status = 'revoked', revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nz(reason), nowIso(), id);
  const row = db().prepare("SELECT * FROM licenses WHERE id = ?").get(id) as unknown as LicenseRow | undefined;
  return row ?? null;
}

export function rotateLicenseKey(id: string, keyHash: string): void {
  db().prepare("UPDATE licenses SET key_hash = ?, updated_at = ? WHERE id = ?").run(keyHash, nowIso(), id);
}

export function touchLicenseHeartbeat(id: string): void {
  db().prepare("UPDATE licenses SET last_heartbeat_at = ? WHERE id = ?").run(nowIso(), id);
}

/* ============================ 设备 ============================ */

export function findDevice(licenseId: string, deviceId: string): DeviceRow | null {
  const row = db()
    .prepare("SELECT * FROM devices WHERE license_id = ? AND device_id = ?")
    .get(licenseId, deviceId) as unknown as DeviceRow | undefined;
  return row ?? null;
}

export function listDevices(licenseId: string): DeviceRow[] {
  return db()
    .prepare("SELECT * FROM devices WHERE license_id = ? ORDER BY first_seen_at ASC")
    .all(licenseId) as unknown as DeviceRow[];
}

export function activeDeviceCount(licenseId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE license_id = ? AND status = 'active'")
    .get(licenseId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function upsertDevice(input: {
  licenseId: string;
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  ip: string | null;
}): DeviceRow {
  const at = nowIso();
  const existing = findDevice(input.licenseId, input.deviceId);
  if (existing) {
    db()
      .prepare(
        "UPDATE devices SET status = 'active', last_seen_at = ?, released_at = NULL, device_name = COALESCE(?, device_name), platform = COALESCE(?, platform), last_ip = ? WHERE id = ?",
      )
      .run(at, nz(input.deviceName), nz(input.platform), nz(input.ip), existing.id);
    return findDevice(input.licenseId, input.deviceId) as DeviceRow;
  }
  db()
    .prepare(
      `INSERT INTO devices (id, license_id, device_id, device_name, platform, status, first_seen_at, last_seen_at, last_ip)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(newId("dev"), input.licenseId, input.deviceId, nz(input.deviceName), nz(input.platform), at, at, nz(input.ip));
  return findDevice(input.licenseId, input.deviceId) as DeviceRow;
}

export function touchDevice(id: string, ip: string | null): void {
  db().prepare("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?").run(nowIso(), nz(ip), id);
}

export function releaseDevice(licenseId: string, deviceId: string): boolean {
  const res = db()
    .prepare("UPDATE devices SET status = 'released', released_at = ? WHERE license_id = ? AND device_id = ? AND status = 'active'")
    .run(nowIso(), licenseId, deviceId);
  return Number(res.changes) > 0;
}

export function releaseAllDevices(licenseId: string): number {
  const res = db()
    .prepare("UPDATE devices SET status = 'released', released_at = ? WHERE license_id = ? AND status = 'active'")
    .run(nowIso(), licenseId);
  return Number(res.changes);
}

/* ============================ 汇总统计 ============================ */

export function stats(): {
  products: number;
  modules: number;
  customers: number;
  licenses_total: number;
  licenses_active: number;
  licenses_expiring_7d: number;
  licenses_expired: number;
  cdk_unused: number;
  cdk_used: number;
  devices_active: number;
  heartbeats_24h: number;
  stale_devices: number;
} {
  const now = nowIso();
  const in7d = new Date(Date.now() + 7 * DAY).toISOString();
  const staleBefore = new Date(Date.now() - config.heartbeatStaleHours * 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - DAY).toISOString();
  const n = (sql: string, ...params: (string | number)[]) => {
    const row = db().prepare(sql).get(...params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  };
  return {
    products: n("SELECT COUNT(*) AS n FROM products"),
    modules: n("SELECT COUNT(*) AS n FROM modules"),
    customers: n("SELECT COUNT(*) AS n FROM customers"),
    licenses_total: n("SELECT COUNT(*) AS n FROM licenses"),
    licenses_active: n("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at > ?", now),
    licenses_expiring_7d: n(
      "SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at > ? AND expires_at <= ?",
      now,
      in7d,
    ),
    licenses_expired: n("SELECT COUNT(*) AS n FROM licenses WHERE expires_at <= ?", now),
    cdk_unused: n("SELECT COUNT(*) AS n FROM cdks WHERE status = 'unused'"),
    cdk_used: n("SELECT COUNT(*) AS n FROM cdks WHERE status = 'used'"),
    devices_active: n("SELECT COUNT(*) AS n FROM devices WHERE status = 'active'"),
    heartbeats_24h: n("SELECT COUNT(*) AS n FROM devices WHERE last_seen_at > ?", dayAgo),
    stale_devices: n("SELECT COUNT(*) AS n FROM devices WHERE status = 'active' AND last_seen_at < ?", staleBefore),
  };
}

/** 未来 N 天内到期的授权（后台首页看板用）。 */
export function expiringLicenses(days: number, limit = 10): LicenseListItem[] {
  const now = nowIso();
  const until = new Date(Date.now() + days * DAY).toISOString();
  return db()
    .prepare(
      `SELECT * FROM (${licenseSelect()})
       WHERE status = 'active' AND expires_at > ? AND expires_at <= ?
       ORDER BY expires_at ASC LIMIT ?`,
    )
    .all(now, now, now, until, limit) as unknown as LicenseListItem[];
}

export function moduleIdsOf(row: { module_ids: string }): string[] {
  return parseJson<string[]>(row.module_ids, []);
}

/* ---------------------------- 计费大类与叠加续费 ---------------------------- */

export type TermCategory = "time" | "count";

/** 计费大类：时长型（hour/day/month/year）与次数型（count），两类互斥 */
export function termCategory(termType: string): TermCategory {
  return termType === "count" ? "count" : "time";
}

/** 找该客户在该产品下「仍在有效期内」的正式授权（用于续费叠加） */
export function findReusableLicense(customerId: string, productId: string): LicenseRow | null {
  const now = nowIso();
  return (db()
    .prepare(
      `SELECT * FROM licenses
       WHERE customer_id = ? AND product_id = ? AND status = 'active' AND kind = 'paid'
         AND starts_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(customerId, productId, now, now) ?? null) as unknown as LicenseRow | null;
}

/** 时长型叠加：从「原到期时间」起算再加，而不是覆盖 */
export function extendLicenseExpiry(licenseId: string, termType: TermType, termValue: number): LicenseRow {
  const row = findLicenseById(licenseId);
  if (!row) throw new Error("license not found");
  const baseMs = Math.max(Date.now(), row.expires_at ? Date.parse(row.expires_at) : 0);
  const nextMs = computeExpiry(termType, termValue, baseMs);
  const nextIso = new Date(nextMs).toISOString();
  db()
    .prepare(
      "UPDATE licenses SET expires_at = ?, term_type = ?, term_value = ?, max_expires_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(nextIso, termType, termValue, nextIso, nowIso(), licenseId); // v8：叠加同时抬高上限
  syncModuleExpiry(licenseId, nextIso); // v9：模块一并展期
  return findLicenseById(licenseId) as LicenseRow;
}

/** 次数型叠加：累加可用次数，已消耗次数保持不变 */
export function addLicenseUsages(licenseId: string, count: number): LicenseRow {
  db()
    .prepare(
      `UPDATE licenses SET max_usages = COALESCE(max_usages, 0) + ?, term_type = 'count', updated_at = ? WHERE id = ?`,
    )
    .run(Math.max(0, Math.trunc(count)), nowIso(), licenseId);
  return findLicenseById(licenseId) as LicenseRow;
}

/* ---------------------------- 模块级到期 ---------------------------- */

export type LicenseModuleRow = {
  id: string;
  license_id: string;
  module_id: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listLicenseModules(licenseId: string): LicenseModuleRow[] {
  return db()
    .prepare("SELECT * FROM license_modules WHERE license_id = ? ORDER BY module_id")
    .all(licenseId) as unknown as LicenseModuleRow[];
}

/** 同步授权包含的模块：新增缺失（默认继承授权到期）、删除已移除 */
export function syncLicenseModules(licenseId: string, moduleIds: string[], expiresAt: string): void {
  const at = nowIso();
  const keep = new Set(moduleIds);
  const existing = listLicenseModules(licenseId);
  for (const row of existing) {
    if (!keep.has(row.module_id)) db().prepare("DELETE FROM license_modules WHERE id = ?").run(row.id);
  }
  const known = new Set(existing.map((r) => r.module_id));
  for (const mid of moduleIds) {
    if (known.has(mid)) continue;
    db()
      .prepare(
        `INSERT OR IGNORE INTO license_modules (id, license_id, module_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId("lmd"), licenseId, mid, expiresAt, at, at);
  }
}

/** 让所有模块跟随授权到期（叠加续费 / 调整到期时调用） */
export function syncModuleExpiry(licenseId: string, expiresAt: string): void {
  db()
    .prepare("UPDATE license_modules SET expires_at = ?, updated_at = ? WHERE license_id = ?")
    .run(expiresAt, nowIso(), licenseId);
}

/** 单独设置某模块到期；null 表示跟随授权 */
export function setLicenseModuleExpiry(
  licenseId: string,
  moduleId: string,
  expiresAt: string | null,
): LicenseModuleRow | null {
  db()
    .prepare("UPDATE license_modules SET expires_at = ?, updated_at = ? WHERE license_id = ? AND module_id = ?")
    .run(expiresAt, nowIso(), licenseId, moduleId);
  const row = db()
    .prepare("SELECT * FROM license_modules WHERE license_id = ? AND module_id = ?")
    .get(licenseId, moduleId) as unknown as LicenseModuleRow | undefined;
  return row ?? null;
}
