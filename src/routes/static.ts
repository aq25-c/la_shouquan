/** 静态资源：承载管理后台单页（无外部依赖，可直接离线使用）。 */
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { config } from "../config.ts";
import { raw } from "../http.ts";
import type { Ctx, Reply } from "../http.ts";

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

export function serveStatic(ctx: Ctx): Reply {
  const pathname = ctx.path === "/" ? "/index.html" : ctx.path;
  const resolved = safeResolve(pathname);
  if (!resolved) return raw("404 Not Found", "text/plain; charset=utf-8", 404);

  const body = readIfFile(resolved);
  if (body) {
    const ext = extname(resolved).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    // 资源文件不常变，允许短缓存；HTML 不缓存，保证升级后立即生效
    const cache = ext === ".html" ? "no-cache" : "public, max-age=300";
    return raw(body, type, 200, { "Cache-Control": cache });
  }

  // SPA 回退：非静态资源路径统一交给 index.html
  if (!extname(resolved)) {
    const index = readIfFile(join(config.publicDir, "index.html"));
    if (index) return raw(index, MIME[".html"], 200, { "Cache-Control": "no-cache" });
  }
  return raw("404 Not Found", "text/plain; charset=utf-8", 404);
}
