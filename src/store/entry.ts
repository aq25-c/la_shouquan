/**
 * 管理后台入口地址（默认 upadmin）。
 *
 * 根路径留给客户门户，后台走隐藏入口；入口地址存在 settings 表，
 * 后台「设置」里可以改，改完立刻生效（静态路由每次请求现读）。
 */
import { getSetting, setSetting } from "../db.ts";

const KEY = "entry.admin_path";

export const DEFAULT_ADMIN_PATH = "upadmin";

/** 会跟已有路由或静态资源撞车的名字 */
const RESERVED = new Set([
  "admin",
  "api",
  "docs",
  "healthz",
  "portal",
  "assets",
  "static",
  "public",
  "index.html",
  "app.js",
  "styles.css",
  "portal.js",
  "portal.css",
  "favicon.ico",
]);

/** 小写字母/数字/中划线，2-32 位，且首尾必须是字母或数字 */
const PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function isUsableAdminPath(value: string): { ok: true } | { ok: false; reason: string } {
  const v = String(value ?? "").trim().toLowerCase();
  if (!PATTERN.test(v)) {
    return { ok: false, reason: "只能用小写字母、数字、中划线，2-32 位，并且首尾都要是字母或数字" };
  }
  if (RESERVED.has(v)) return { ok: false, reason: `「${v}」是系统保留路径，请换一个` };
  return { ok: true };
}

/** 当前生效的后台入口（不带斜杠），异常值一律回落到默认值 */
export function getAdminPath(): string {
  const raw = String(getSetting(KEY) ?? "").trim().toLowerCase();
  return PATTERN.test(raw) && !RESERVED.has(raw) ? raw : DEFAULT_ADMIN_PATH;
}

export function setAdminPath(value: string): string {
  const check = isUsableAdminPath(value);
  if (!check.ok) throw new Error(check.reason);
  setSetting(KEY, value.trim().toLowerCase());
  return getAdminPath();
}

/** 是不是默认值（前端用来提示「还在用默认入口」） */
export function isDefaultAdminPath(): boolean {
  return getAdminPath() === DEFAULT_ADMIN_PATH;
}
