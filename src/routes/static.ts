/**
 * 静态资源：
 *   - `/`            → 客户门户（portal.html）
 *   - `/<后台入口>`   → 管理后台（index.html），入口可配置，默认 upadmin
 *   - 其余真实文件    → 按扩展名给 MIME
 *   - 其他未知路径    → 回落到客户门户（前端自己做视图切换）
 */
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { config } from "../config.ts";
import { raw } from "../http.ts";
import type { Ctx, Reply } from "../http.ts";
import { getAdminPath } from "../store/entry.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function safeResolve(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(config.publicDir, decoded));
  const root = normalize(config.publicDir + sep);
  if (!candidate.startsWith(root) && candidate !== normalize(config.publicDir)) return null;
  return candidate;
}

function readIfFile(path: string): Buffer | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** 直接读 public 下的某个 HTML 页面 */
function sendPage(name: string): Reply {
  const body = readIfFile(join(config.publicDir, name));
  if (!body) return raw("404 Not Found", "text/plain; charset=utf-8", 404);
  return raw(body, MIME[".html"], 200, { "Cache-Control": "no-cache" });
}

/** 按路径返回静态文件；找不到返回 null（交给上层兜底） */
function serveFile(pathname: string): Reply | null {
  const resolved = safeResolve(pathname);
  if (!resolved) return null;
  const body = readIfFile(resolved);
  if (!body) return null;
  const ext = extname(resolved).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  // 资源文件不常变，允许短缓存；HTML 不缓存，保证升级后立即生效
  const cache = ext === ".html" ? "no-cache" : "public, max-age=300";
  return raw(body, type, 200, { "Cache-Control": cache });
}

export function serveStatic(ctx: Ctx): Reply {
  const path = ctx.path;

  // /admin/api/* 归 API 路由，静态层不许兜底成页面
  if (path.startsWith("/admin/api/")) {
    return raw("404 Not Found", "text/plain; charset=utf-8", 404);
  }

  const adminHome = `/${getAdminPath()}`;

  // 管理后台入口：/<entry> 和 /<entry>/xxx（后者是后台自己的静态资源）
  if (path === adminHome || path === `${adminHome}/`) return sendPage("index.html");
  if (path.startsWith(`${adminHome}/`)) {
    return serveFile(path.slice(adminHome.length)) ?? sendPage("index.html");
  }

  // 客户门户
  if (path === "/" || path === "/portal") return sendPage("portal.html");

  // 真实存在的静态文件（app.js / styles.css / portal.js …）
  const file = serveFile(path);
  if (file) return file;

  // 其他未知路径一律回门户，前端自己决定显示哪个视图
  return sendPage("portal.html");
}
