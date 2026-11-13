/**
 * 数据层：SQLite（Node 内置 node:sqlite），带版本化迁移。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowIso } from "./util.ts";

export type Sqlite = DatabaseSync;

let database: DatabaseSync | null = null;

/**
 * 当前程序支持的数据库结构版本。
 * 规则：每次改动 schema 必须 ①追加 SCHEMA_Vx 常量 ②在 migrate() 里补一行分支 ③把这里 +1。
 * 老库会被逐级升级（v1→v2→…→最新），数据保留；新库直接从 v1 建到最新。
 */
export const SCHEMA_VERSION = 13;

/** 本次启动实际发生的迁移（from → to，相等表示无需迁移） */
let migration: { from: number; to: number } = { from: 0, to: 0 };

export function migrationInfo(): { from: number; to: number } {
  return migration;
}

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
 * v2：代理 / 分销管理
 *   - channels：代理主数据
 *   - cdk_batches.channel_id / unit_price：批次归属代理与结算单价（单位：分）
 *   - licenses.channel_id / unit_price：激活时从批次继承，用于按代理统计营收
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

/**
 * v4：员工/代理权限体系 + 卡密计费类型 + 代理额度
 *   - admin_users.role: owner / staff（员工）/ agent（代理）
 *   - admin_users.permissions: JSON { menus[], features[] }
 *   - admin_users.channel_id: 代理关联的代理
 *   - term_type: day / month / year / hour / count（term_value 为空时回落到 days）
 *   - licenses.max_usages / used_usages: 次数型授权的总额度与已用量
 *   - channels.credit: 代理的卡密余额（单位：张）
 */
const SCHEMA_V4 = `
ALTER TABLE admin_users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';
ALTER TABLE admin_users ADD COLUMN channel_id TEXT;
ALTER TABLE cdk_batches ADD COLUMN term_type TEXT NOT NULL DEFAULT 'day';
ALTER TABLE cdk_batches ADD COLUMN term_value INTEGER;

ALTER TABLE cdks ADD COLUMN term_type TEXT NOT NULL DEFAULT 'day';
ALTER TABLE cdks ADD COLUMN term_value INTEGER;

ALTER TABLE licenses ADD COLUMN term_type TEXT NOT NULL DEFAULT 'day';
ALTER TABLE licenses ADD COLUMN term_value INTEGER;
ALTER TABLE licenses ADD COLUMN max_usages INTEGER;
ALTER TABLE licenses ADD COLUMN used_usages INTEGER NOT NULL DEFAULT 0;

ALTER TABLE channels ADD COLUMN credit INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_admin_channel ON admin_users(channel_id);
CREATE INDEX IF NOT EXISTS idx_licenses_term ON licenses(term_type);
`;

/**
 * v5：代理按金额结算
 *   - channels.balance：代理账户余额（单位：分），生成卡密按价格扣费
 *   - admin_users.agent_profile：代理可售范围 JSON { product_ids[], module_ids[], term_types[] }
 *   - agent_prices：卡密价格表（产品级默认价 + 模块可覆盖，按卡类型定价，单位：分/单位）
 */
const SCHEMA_V5 = `
ALTER TABLE channels ADD COLUMN balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN agent_profile TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS agent_prices (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  module_id  TEXT NOT NULL DEFAULT '',
  term_type  TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id, module_id, term_type)
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON agent_prices(product_id, term_type);
`;

/**
 * v6：价格三层 + 试用按产品
 *   - agent_prices 增加 channel_id（'' = 全局默认价，非空 = 该代理的覆盖价）
 *     SQLite 不能改 UNIQUE 约束，因此重建表并保留原数据（原数据视为全局默认价）
 *   - products.trial_config：每个产品一份试用配置 JSON（空串 = 沿用全局默认）
 */
const SCHEMA_V6 = `
CREATE TABLE agent_prices_v6 (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL,
  module_id  TEXT NOT NULL DEFAULT '',
  term_type  TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, product_id, module_id, term_type)
);
INSERT INTO agent_prices_v6 (id, channel_id, product_id, module_id, term_type, unit_price, created_at, updated_at)
  SELECT id, '', product_id, module_id, term_type, unit_price, created_at, updated_at FROM agent_prices;
DROP TABLE agent_prices;
ALTER TABLE agent_prices_v6 RENAME TO agent_prices;
CREATE INDEX IF NOT EXISTS idx_prices_product ON agent_prices(product_id, term_type);
CREATE INDEX IF NOT EXISTS idx_prices_channel ON agent_prices(channel_id, product_id);

ALTER TABLE products ADD COLUMN trial_config TEXT NOT NULL DEFAULT '';
`;

/**
 * v7：概念统一——「代理」全部改名为「代理」
 *   - 表 channels → channels
 *   - 各表外键列 channel_id → channel_id
 *   - 相关索引重建为新名字
 * 注意：SQLite 的 RENAME 会自动同步索引/外键定义中的表名与列名，这里仅统一索引名称。
 */
const SCHEMA_V7 = `
ALTER TABLE channels RENAME TO agents;
ALTER TABLE cdk_batches RENAME COLUMN channel_id TO agent_id;
ALTER TABLE licenses RENAME COLUMN channel_id TO agent_id;
ALTER TABLE admin_users RENAME COLUMN channel_id TO agent_id;
ALTER TABLE agent_prices RENAME COLUMN channel_id TO agent_id;

DROP INDEX IF EXISTS idx_channels_status;
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status, created_at DESC);
DROP INDEX IF EXISTS idx_cdk_batches_channel;
CREATE INDEX IF NOT EXISTS idx_cdk_batches_agent ON cdk_batches(agent_id, created_at DESC);
DROP INDEX IF EXISTS idx_licenses_channel;
CREATE INDEX IF NOT EXISTS idx_licenses_agent ON licenses(agent_id, created_at DESC);
DROP INDEX IF EXISTS idx_admin_channel;
CREATE INDEX IF NOT EXISTS idx_admin_agent ON admin_users(agent_id);
DROP INDEX IF EXISTS idx_prices_channel;
CREATE INDEX IF NOT EXISTS idx_prices_agent ON agent_prices(agent_id, product_id);
`;

/**
 * v9：模块级到期
 *   - license_modules：每条授权下每个模块各自的到期时间
 *     到期为空表示跟随授权本身；独立设置后以模块到期为准（客户端按模块判断可用性）。
 */
const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS license_modules (
  id         TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  module_id  TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (license_id, module_id)
);
CREATE INDEX IF NOT EXISTS idx_licmod_license ON license_modules(license_id);
`;

/**
 * v10：远程变量
 *   - remote_vars：按产品维护一组可远程下发的参数，支持 text / image / json 三种载荷
 *     仅登录客户可读取（客户端接口需要客户会话 token）。
 */
const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS remote_vars (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',
  value       TEXT NOT NULL DEFAULT '',
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (product_id, key)
);
CREATE INDEX IF NOT EXISTS idx_vars_product ON remote_vars(product_id);
`;

/**
 * v11：模块自己携带计费信息
 *   - license_modules.term_type / term_value：该模块自己的计费类型与数值
 *   - 老数据从所属授权继承 term_type / term_value，行为与 v10 一致
 *   - 次数型授权仍然在授权层面计次（模块级计次留到后续版本）
 */
const SCHEMA_V11 = `
ALTER TABLE license_modules ADD COLUMN term_type TEXT;
ALTER TABLE license_modules ADD COLUMN term_value INTEGER;

UPDATE license_modules
   SET term_type = COALESCE((SELECT l.term_type FROM licenses l WHERE l.id = license_modules.license_id), 'day'),
       term_value = (SELECT l.term_value FROM licenses l WHERE l.id = license_modules.license_id)
 WHERE term_type IS NULL;
`;

/**
 * v12：模块级试用 + 模块级计次
 *   - modules.trial_config：每个模块自己的试用配置 JSON（空串 = 沿用产品级/全局）
 *   - license_modules.max_usages / used_usages：次数型模块自己的额度与已用
 *     没有 max_usages 的模块仍走授权级计次（老数据行为不变）
 */
const SCHEMA_V12 = `
ALTER TABLE modules ADD COLUMN trial_config TEXT NOT NULL DEFAULT '';
ALTER TABLE license_modules ADD COLUMN max_usages INTEGER;
ALTER TABLE license_modules ADD COLUMN used_usages INTEGER NOT NULL DEFAULT 0;
`;

/**
 * v13：设备解绑原因
 *   - devices.released_reason：manual（后台/客户手动解绑）/ expired（授权到期自动释放）
 *     到期释放的机器在续费恢复后可以自动回来占回席位；手动解绑的不会自己回来。
 */
const SCHEMA_V13 = `
ALTER TABLE devices ADD COLUMN released_reason TEXT;
`;

/**
 * v8：授权到期上限
 *   - licenses.max_expires_at：该授权允许的最大到期时间（= CDK 激活时算出的实际到期时间）
 *     代理调整到期时间可以缩短、也可以恢复，但不能超过这个上限；管理员不受此限制。
 */
const SCHEMA_V8 = `
ALTER TABLE licenses ADD COLUMN max_expires_at TEXT;
UPDATE licenses SET max_expires_at = expires_at WHERE max_expires_at IS NULL;
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

  const from = readUserVersion(db);
  // 降级保护：库比程序新（例如回滚到旧镜像）会让旧代码写坏新结构，直接拒绝启动
  if (from > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `数据库结构版本 v${from} 高于当前程序支持的 v${SCHEMA_VERSION}：请升级到更新版本的程序，` +
        `或从备份恢复数据库后再用当前版本启动。`,
    );
  }
  // 已有数据且需要升级时，先做一份快照，升级出问题可以立刻回滚
  if (from > 0 && from < SCHEMA_VERSION && path !== ":memory:") {
    backupBeforeMigration(db, path, from);
  }

  migrate(db);
  migration = { from, to: readUserVersion(db) };
  database = db;
  return db;
}

function readUserVersion(conn: DatabaseSync): number {
  const row = conn.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** 升级前快照；失败只告警，不阻止启动 */
function backupBeforeMigration(conn: DatabaseSync, dbPath: string, fromVersion: number): void {
  try {
    const dir = join(dirname(dbPath), "backups");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dir, `pre-v${fromVersion}-${stamp}.db`);
    conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`[db] 升级前已自动备份：${target}`);
  } catch (err) {
    console.warn(`[db] 升级前备份失败（不阻止启动）：${(err as Error).message}`);
  }
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
  const version = readUserVersion(db);

  if (version < 1) runMigration(db, SCHEMA_V1, 1);
  if (version < 2) runMigration(db, SCHEMA_V2, 2);
  if (version < 3) runMigration(db, SCHEMA_V3, 3);
  if (version < 4) runMigration(db, SCHEMA_V4, 4);
  if (version < 5) runMigration(db, SCHEMA_V5, 5);
  if (version < 6) runMigration(db, SCHEMA_V6, 6);
  if (version < 7) runMigration(db, SCHEMA_V7, 7);
  if (version < 8) runMigration(db, SCHEMA_V8, 8);
  if (version < 9) runMigration(db, SCHEMA_V9, 9);
  if (version < 10) runMigration(db, SCHEMA_V10, 10);
  if (version < 11) runMigration(db, SCHEMA_V11, 11);
  if (version < 12) runMigration(db, SCHEMA_V12, 12);
  if (version < 13) runMigration(db, SCHEMA_V13, 13);
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
