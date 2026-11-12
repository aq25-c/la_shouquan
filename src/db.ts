/**
 * 数据层：SQLite（Node 内置 node:sqlite），带版本化迁移。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./util.ts";

export type Sqlite = DatabaseSync;

let database: DatabaseSync | null = null;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  UNIQUE (product_id, code)
);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,
  name          TEXT,
  company       TEXT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS cdk_batches (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  count      INTEGER NOT NULL,
  days       INTEGER NOT NULL,
  seats      INTEGER NOT NULL,
  module_ids TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cdk_batches_product ON cdk_batches(product_id, created_at);

CREATE TABLE IF NOT EXISTS cdks (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  batch_id       TEXT,
  product_id     TEXT NOT NULL REFERENCES products(id),
  module_ids     TEXT NOT NULL DEFAULT '[]',
  days           INTEGER NOT NULL,
  seats          INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unused',
  expires_at     TEXT,
  customer_id    TEXT,
  license_id     TEXT,
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  used_at        TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_cdks_status ON cdks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cdks_batch ON cdks(batch_id);
CREATE INDEX IF NOT EXISTS idx_cdks_customer ON cdks(customer_id);

CREATE TABLE IF NOT EXISTS licenses (
  id                 TEXT PRIMARY KEY,
  license_no         TEXT NOT NULL UNIQUE,
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  product_id         TEXT NOT NULL REFERENCES products(id),
  cdk_id             TEXT,
  module_ids         TEXT NOT NULL DEFAULT '[]',
  seats              INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'active',
  starts_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  offline_grace_days INTEGER NOT NULL DEFAULT 7,
  key_hash           TEXT NOT NULL,
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_heartbeat_at  TEXT,
  revoked_at         TEXT,
  revoked_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key_hash);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  license_id    TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  device_name   TEXT,
  platform      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  released_at   TEXT,
  last_ip       TEXT,
  UNIQUE (license_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id, status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  actor_label  TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  ip           TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, at DESC);
`;

/**
 * v2：渠道 / 分销管理
 *   - channels：渠道主数据
 *   - cdk_batches.channel_id / unit_price：批次归属渠道与结算单价（单位：分）
 *   - licenses.channel_id / unit_price：激活时从批次继承，用于按渠道统计营收
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  contact    TEXT,
  phone      TEXT,
  email      TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status, created_at DESC);

ALTER TABLE cdk_batches ADD COLUMN channel_id TEXT;
ALTER TABLE cdk_batches ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;

ALTER TABLE licenses ADD COLUMN channel_id TEXT;
ALTER TABLE licenses ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_cdk_batches_channel ON cdk_batches(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_licenses_channel ON licenses(channel_id, created_at DESC);
`;

/**
 * v3：试用授权
 *   - licenses.kind：paid（正式）/ trial（试用）
 *   - licenses.source：来源（cdk / manual / trial），便于按开通方式统计
 *   试用配置本身存在 settings 表（trial.*），不需要新表。
 */
const SCHEMA_V3 = `
ALTER TABLE licenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'cdk';
CREATE INDEX IF NOT EXISTS idx_licenses_kind ON licenses(kind, created_at DESC);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  database = db;
  return db;
}

export function db(): DatabaseSync {
  if (!database) throw new Error("数据库尚未初始化");
  return database;
}

export function closeDb(): void {
  if (database) {
    database.close();
    database = null;
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);

  if (version < 1) runMigration(db, SCHEMA_V1, 1);
  if (version < 2) runMigration(db, SCHEMA_V2, 2);
  if (version < 3) runMigration(db, SCHEMA_V3, 3);
}

/** 执行一次迁移：成功则写入 user_version，失败整体回滚。 */
function runMigration(db: DatabaseSync, sql: string, toVersion: number): void {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${toVersion}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 忽略回滚失败 */
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 事务                                                                */
/* ------------------------------------------------------------------ */

let txDepth = 0;

/** 单写者事务；嵌套调用自动并入外层事务。 */
export function withTx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  txDepth += 1;
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      /* 忽略回滚失败 */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

/** 计数辅助：返回单行单列的第一个数值 */
export function scalar(sql: string, ...params: (string | number | null)[]): number {
  const row = db().prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const first = Object.values(row)[0];
  return typeof first === "number" ? first : Number(first ?? 0);
}
