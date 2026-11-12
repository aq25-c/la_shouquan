/** 渠道 / 分销：渠道主数据，以及按渠道聚合的销售统计。 */
import { db, scalar } from "../db.ts";
import { DAY, newId, nowIso, nz } from "../util.ts";
import type { ChannelRow } from "../types.ts";

/** 渠道 + 统计（金额单位统一为「分」） */
export type ChannelListItem = ChannelRow & {
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

/** 统计子查询：所有渠道共用同一套口径，口径变化只需改这里。 */
function channelStatsSelect(): string {
  return `
    (SELECT COUNT(*) FROM cdk_batches b WHERE b.channel_id = ch.id) AS batch_count,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.channel_id = ch.id) AS cdk_total,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.channel_id = ch.id AND k.status = 'used') AS cdk_used,
    (SELECT COUNT(*) FROM cdks k JOIN cdk_batches b ON b.id = k.batch_id
       WHERE b.channel_id = ch.id AND k.status = 'unused') AS cdk_unused,
    (SELECT COUNT(*) FROM licenses l WHERE l.channel_id = ch.id) AS license_total,
    (SELECT COUNT(*) FROM licenses l
       WHERE l.channel_id = ch.id AND l.status = 'active' AND l.expires_at > ?) AS license_active,
    (SELECT COALESCE(SUM(l.unit_price), 0) FROM licenses l WHERE l.channel_id = ch.id) AS revenue_total,
    (SELECT COALESCE(SUM(l.unit_price), 0) FROM licenses l
       WHERE l.channel_id = ch.id AND l.created_at >= ?) AS revenue_30d,
    (SELECT COUNT(*) FROM licenses l
       WHERE l.channel_id = ch.id AND l.created_at >= ?) AS activated_30d,
    (SELECT COUNT(*) FROM audit_logs a JOIN licenses l ON l.id = a.target_id
       WHERE a.action = 'license.extend' AND l.channel_id = ch.id) AS renew_count,
    (SELECT MAX(l.created_at) FROM licenses l WHERE l.channel_id = ch.id) AS last_activated_at`;
}

function withDerived(row: ChannelListItem): ChannelListItem {
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

export function listChannels(opts: { q?: string | null; status?: string | null } = {}): ChannelListItem[] {
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
      `SELECT ch.*, ${channelStatsSelect()}
       FROM channels ch
       ${clause}
       ORDER BY ch.created_at DESC`,
    )
    .all(now, since, since, ...params) as unknown as ChannelListItem[];

  return rows.map(withDerived);
}

export function findChannelById(id: string): ChannelListItem | null {
  const now = nowIso();
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const row = db()
    .prepare(`SELECT ch.*, ${channelStatsSelect()} FROM channels ch WHERE ch.id = ?`)
    .get(now, since, since, id) as unknown as ChannelListItem | undefined;
  return row ? withDerived(row) : null;
}

export function findChannelByCode(code: string): ChannelRow | null {
  const row = db().prepare("SELECT * FROM channels WHERE code = ?").get(code.trim().toLowerCase()) as
    | unknown as ChannelRow
    | undefined;
  return row ?? null;
}

export function createChannel(input: {
  code: string;
  name: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
}): ChannelRow {
  const id = newId("chn");
  const at = nowIso();
  db()
    .prepare(
      `INSERT INTO channels (id, code, name, contact, phone, email, note, status, created_at, updated_at)
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
  const row = db().prepare("SELECT * FROM channels WHERE id = ?").get(id) as unknown as ChannelRow;
  return row;
}

export function updateChannel(
  id: string,
  patch: Partial<Pick<ChannelRow, "name" | "contact" | "phone" | "email" | "note" | "status">>,
): ChannelRow | null {
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
    db().prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  const row = db().prepare("SELECT * FROM channels WHERE id = ?").get(id) as unknown as ChannelRow | undefined;
  return row ?? null;
}

/** 渠道被批次或授权引用时不允许删除（返回引用数量，便于提示改停用）。 */
export function channelReferences(id: string): { batches: number; licenses: number } {
  return {
    batches: scalar("SELECT COUNT(*) FROM cdk_batches WHERE channel_id = ?", id),
    licenses: scalar("SELECT COUNT(*) FROM licenses WHERE channel_id = ?", id),
  };
}

export function deleteChannel(id: string): boolean {
  const res = db().prepare("DELETE FROM channels WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** 概览页用的渠道汇总。 */
export function channelSummary(): {
  channels: number;
  channels_active: number;
  attributed_licenses: number;
  unattributed_licenses: number;
  revenue_total: number;
  revenue_30d: number;
} {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  return {
    channels: scalar("SELECT COUNT(*) AS n FROM channels"),
    channels_active: scalar("SELECT COUNT(*) AS n FROM channels WHERE status = 'active'"),
    attributed_licenses: scalar("SELECT COUNT(*) AS n FROM licenses WHERE channel_id IS NOT NULL"),
    unattributed_licenses: scalar("SELECT COUNT(*) AS n FROM licenses WHERE channel_id IS NULL"),
    revenue_total: scalar("SELECT COALESCE(SUM(unit_price), 0) AS n FROM licenses"),
    revenue_30d: scalar("SELECT COALESCE(SUM(unit_price), 0) AS n FROM licenses WHERE created_at >= ?", since),
  };
}
