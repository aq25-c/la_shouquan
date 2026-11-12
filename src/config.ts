/**
 * 运行配置：全部来自环境变量，带合理默认值。
 */
import { resolve } from "node:path";

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function envInt(name: string, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const dataDir = resolve(envStr("DATA_DIR", "./data"));

export const config = {
  port: envInt("PORT", 8080, 1, 65535),
  host: envStr("HOST", "0.0.0.0"),
  nodeEnv: envStr("NODE_ENV", "production"),
  isProd: envStr("NODE_ENV", "production") !== "development",

  dataDir,
  dbPath: envStr("DB_PATH", resolve(dataDir, "license.db")),
  keysFile: envStr("KEYS_FILE", resolve(dataDir, "keys.json")),

  initialAdmin: {
    email: envStr("ADMIN_EMAIL", "admin@example.com").toLowerCase(),
    password: envStr("ADMIN_PASSWORD", ""),
    name: envStr("ADMIN_NAME", "系统管理员"),
  },

  /** 离线宽限天数：签名许可证文件的离线有效期上限 */
  offlineGraceDays: envInt("OFFLINE_GRACE_DAYS", 7, 0, 3650),
  /** 建议客户端心跳周期（小时） */
  heartbeatIntervalHours: envInt("HEARTBEAT_INTERVAL_HOURS", 24, 1, 24 * 30),
  /** 超过多久没心跳算异常（小时），仅用于后台统计与告警，不影响离线验签 */
  heartbeatStaleHours: envInt("HEARTBEAT_STALE_HOURS", 72, 1, 24 * 365),

  adminTokenTtlHours: envInt("ADMIN_TOKEN_TTL_HOURS", 12, 1, 24 * 30),
  customerTokenTtlHours: envInt("CUSTOMER_TOKEN_TTL_HOURS", 720, 1, 24 * 365),

  maxBodyBytes: envInt("MAX_BODY_BYTES", 256 * 1024, 1024, 8 * 1024 * 1024),
  rateLimitPerMin: envInt("RATE_LIMIT_PER_MIN", 600, 0, 1_000_000),
  trustProxy: envBool("TRUST_PROXY", false),

  signingPrivateKeyB64: envStr("SIGNING_PRIVATE_KEY_B64", ""),
  publicDir: resolve(import.meta.dirname, "public"),
};

export type Config = typeof config;
