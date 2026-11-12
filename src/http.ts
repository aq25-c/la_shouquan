/**
 * 极简 HTTP 框架：路由、body 解析、统一响应、鉴权、限流。
 * 用 node:http 手写，不引入 express/fastify。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { nowMs } from "./util.ts";

/* ------------------------------------------------------------------ */
/* 错误与响应                                                          */
/* ------------------------------------------------------------------ */

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = "未登录或登录已过期", code = "UNAUTHORIZED") =>
  new HttpError(401, code, message);
export const forbidden = (message = "无权访问", code = "FORBIDDEN") => new HttpError(403, code, message);
export const notFound = (message = "资源不存在", code = "NOT_FOUND") => new HttpError(404, code, message);
export const conflict = (message: string, code = "CONFLICT", details?: unknown) =>
  new HttpError(409, code, message, details);
export const tooMany = (message = "请求过于频繁，请稍后再试", code = "RATE_LIMITED") =>
  new HttpError(429, code, message);
export const locked = (message: string, code = "LICENSE_LOCKED", details?: unknown) =>
  new HttpError(403, code, message, details);

export type Reply =
  | { kind: "json"; body: unknown; status: number }
  | {
      kind: "raw";
      body: string | Buffer;
      contentType: string;
      status: number;
      headers?: Record<string, string>;
    }
  | { kind: "stream"; status: number };

export function ok(body: unknown, status = 200): Reply {
  return { kind: "json", body: { ok: true, data: body }, status };
}

export function created(body: unknown): Reply {
  return { kind: "json", body: { ok: true, data: body }, status: 201 };
}

export function raw(
  body: string | Buffer,
  contentType: string,
  status = 200,
  headers?: Record<string, string>,
): Reply {
  return { kind: "raw", body, contentType, status, headers };
}

export function noContent(): Reply {
  return { kind: "stream", status: 204 };
}

/* ------------------------------------------------------------------ */
/* 上下文                                                              */
/* ------------------------------------------------------------------ */

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  rawBody: string;
  ip: string;
  requestId: string;
  token: string | null;
};

export type Handler = (ctx: Ctx) => Promise<Reply | void> | Reply | void;

/** 读取 query 参数（字符串） */
export function q(ctx: Ctx, name: string): string | null {
  const v = ctx.query.get(name);
  return v === null || v === "" ? null : v;
}

export function qInt(ctx: Ctx, name: string, fallback: number): number {
  const v = ctx.query.get(name);
  if (v === null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function bodyStr(ctx: Ctx, name: string, opts: { required?: boolean; max?: number; trim?: boolean } = {}): string | null {
  const raw = ctx.body[name];
  if (raw === undefined || raw === null) {
    if (opts.required) throw badRequest(`缺少参数 ${name}`, "MISSING_FIELD", { field: name });
    return null;
  }
  const max = opts.max ?? 500;
  let s = String(raw);
  if (s.length > max) throw badRequest(`参数 ${name} 过长（上限 ${max} 字符）`, "FIELD_TOO_LONG", { field: name });
  if (opts.trim !== false) s = s.trim();
  if (s === "") {
    if (opts.required) throw badRequest(`参数 ${name} 不能为空`, "MISSING_FIELD", { field: name });
    return null;
  }
  return s;
}

export function bodyInt(
  ctx: Ctx,
  name: string,
  opts: { required?: boolean; min?: number; max?: number } = {},
): number | null {
  const raw = ctx.body[name];
  if (raw === undefined || raw === null || raw === "") {
    if (opts.required) throw badRequest(`缺少参数 ${name}`, "MISSING_FIELD", { field: name });
    return null;
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) throw badRequest(`参数 ${name} 必须是整数`, "INVALID_FIELD", { field: name });
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (n < min || n > max) {
    throw badRequest(`参数 ${name} 超出范围（${min} ~ ${max}）`, "INVALID_FIELD", { field: name });
  }
  return Math.trunc(n);
}

export function bodyStrArray(ctx: Ctx, name: string, max = 200): string[] | null {
  const raw = ctx.body[name];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw badRequest(`参数 ${name} 必须是数组`, "INVALID_FIELD", { field: name });
  const out = raw
    .map((v) => String(v).trim())
    .filter((v) => v !== "")
    .slice(0, max);
  return [...new Set(out)];
}

/** 必填字符串，返回非 null 类型 */
export function needStr(ctx: Ctx, name: string, max = 200): string {
  const value = bodyStr(ctx, name, { required: true, max });
  if (value === null) throw badRequest(`缺少参数 ${name}`, "MISSING_FIELD", { field: name });
  return value;
}

/** 必填整数，返回非 null 类型 */
export function needInt(ctx: Ctx, name: string, opts: { min?: number; max?: number } = {}): number {
  const value = bodyInt(ctx, name, { ...opts, required: true });
  if (value === null) throw badRequest(`缺少参数 ${name}`, "MISSING_FIELD", { field: name });
  return value;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

type Route = {
  method: string;
  segments: string[];
  handler: Handler;
};

const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler): void {
  routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
}

export const get = (path: string, handler: Handler) => route("GET", path, handler);
export const post = (path: string, handler: Handler) => route("POST", path, handler);
export const patch = (path: string, handler: Handler) => route("PATCH", path, handler);
export const del = (path: string, handler: Handler) => route("DELETE", path, handler);

/**
 * 列出所有已注册路由（供「API 文档」页面自动同步，新增接口无需手写清单）。
 * 返回形如 `{ method: "GET", path: "/admin/api/licenses/:id" }`。
 */
export function listRoutes(): { method: string; path: string }[] {
  return routes.map((r) => ({ method: r.method, path: "/" + r.segments.join("/") }));
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

export function matchRoute(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {  const parts = splitPath(path);
  for (const r of routes) {
    if (r.method !== method && r.method !== "ANY") continue;
    const params: Record<string, string> = {};
    const last = r.segments[r.segments.length - 1];
    if (last === "*") {
      const fixed = r.segments.length - 1;
      if (parts.length < fixed) continue;
      let matched = true;
      for (let i = 0; i < fixed; i += 1) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      params.rest = parts.slice(fixed).map(decodeURIComponent).join("/");
      return { handler: r.handler, params };
    }
    if (r.segments.length !== parts.length) continue;
    let matched = true;
    for (let i = 0; i < r.segments.length; i += 1) {
      const seg = r.segments[i];
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]);
      } else if (seg !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: r.handler, params };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 请求体                                                              */
/* ------------------------------------------------------------------ */

export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", `请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const value = Array.isArray(xff) ? xff[0] : xff;
    if (value) {
      const first = value.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers["x-real-ip"];
    const realValue = Array.isArray(real) ? real[0] : real;
    if (realValue) return realValue.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

export function newRequestId(): string {
  return randomBytes(6).toString("hex");
}

/* ------------------------------------------------------------------ */
/* 限流（内存滑动窗口，按 IP 计数）                                     */
/* ------------------------------------------------------------------ */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export function checkRateLimit(ip: string, limitPerMin: number): boolean {
  if (limitPerMin <= 0) return true;
  const now = nowMs();
  if (now - lastSweep > 60_000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    lastSweep = now;
  }
  const existing = buckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= limitPerMin;
}

/** 针对敏感接口的更严格限流（登录、激活） */
const strictBuckets = new Map<string, Bucket>();

export function checkStrictLimit(key: string, limitPerMin: number): boolean {
  if (limitPerMin <= 0) return true;
  const now = nowMs();
  const existing = strictBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    strictBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= limitPerMin;
}

export function resetRateLimits(): void {
  buckets.clear();
  strictBuckets.clear();
}
