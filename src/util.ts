/**
 * 通用工具：时间、ID、base64url、JSON、校验。
 * 运行时由 Node 24 的类型剥离直接执行，不需要编译。
 */
import { randomBytes, randomInt } from "node:crypto";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function nowMs(): number {
  return Date.now();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}

export function plusDays(days: number, fromMs: number = Date.now()): string {
  return isoFrom(fromMs + days * DAY);
}

export function plusHours(hours: number, fromMs: number = Date.now()): string {
  return isoFrom(fromMs + hours * HOUR);
}

export function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function isPast(iso: string | null | undefined, refMs: number = Date.now()): boolean {
  const ms = toMs(iso);
  return ms > 0 && ms <= refMs;
}

export function secondsUntil(iso: string | null | undefined, refMs: number = Date.now()): number {
  const ms = toMs(iso);
  if (ms <= 0) return 0;
  return Math.max(0, Math.floor((ms - refMs) / SECOND));
}

/** 生成带前缀的短 ID，例如 prd_9f2c... */
export function newId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

export function fromB64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function intFrom(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = intFrom(value, fallback);
  return Math.min(max, Math.max(min, n));
}

export function strOrNull(value: unknown, maxLen = 500): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function boolFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(raw: string): boolean {
  return raw.length <= 190 && EMAIL_RE.test(raw);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** SQLite 不接受 undefined，统一折叠成 null。 */
export function nz<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : value;
}

/** 用于拼接 SQL 的 LIKE 模糊查询串（转义 % 与 _）。 */
export function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}
