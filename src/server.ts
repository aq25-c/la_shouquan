/**
 * HTTP 入口：请求分发、安全头、CORS、限流、错误处理。
 */
import { SCHEMA_VERSION, migrationInfo } from "./db.ts";
import { getAdminPath } from "./store/entry.ts";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { bootstrap } from "./bootstrap.ts";
import {
  HttpError,
  badRequest,
  bearerToken,
  checkRateLimit,
  clientIp,
  matchRoute,
  newRequestId,
  ok,
  readBody,
  tooMany,
} from "./http.ts";
import type { Ctx, Reply } from "./http.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerClientRoutes } from "./routes/client.ts";
import { serveStatic } from "./routes/static.ts";
import { publicKeyInfo } from "./keys.ts";
import { requireFeature, requireStaff } from "./auth.ts";
import { featureForAdminRoute } from "./permissions.ts";
import { forbidden } from "./http.ts";

const SERVER_NAME = "license-server";
const SERVER_VERSION = "2.22.2";

function applyCommonHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  const isApi = (req.url ?? "").startsWith("/api/");
  if (!isApi || !origin) return false;
  // 客户端可能来自浏览器/XHR，API 允许跨域；管理后台同源。
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function writeReply(res: ServerResponse, req: IncomingMessage, reply: Reply | void): void {
  if (!reply) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (reply.kind === "stream") {
    res.statusCode = reply.status;
    res.end();
    return;
  }
  if (reply.kind === "raw") {
    res.statusCode = reply.status;
    res.setHeader("Content-Type", reply.contentType);
    for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
    res.end(req.method === "HEAD" ? undefined : reply.body);
    return;
  }
  res.statusCode = reply.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(reply.body));
}

function errorReply(err: unknown): Reply {
  if (err instanceof HttpError) {
    return {
      kind: "json",
      status: err.status,
      body: {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      },
    };
  }
  console.error("[error]", err);
  const message = err instanceof Error ? err.message : "服务内部错误";
  return {
    kind: "json",
    status: 500,
    body: { ok: false, error: { code: "INTERNAL_ERROR", message } },
  };
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const method = (req.method ?? "GET").toUpperCase();
  const requestId = newRequestId();
  applyCommonHeaders(res);
  res.setHeader("X-Request-Id", requestId);

  let path = "/";
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    path = url.pathname;
    const isApi = path.startsWith("/api/") || path.startsWith("/admin/api/") || path === "/healthz";
    applyCors(req, res);

    if (method === "OPTIONS" && isApi) {
      res.statusCode = 204;
      res.end();
      return;
    }

    const ip = clientIp(req);
    if (!checkRateLimit(ip, config.rateLimitPerMin)) {
      writeReply(res, req, errorReply(tooMany()));
      return;
    }

    // 健康检查：给 Docker HEALTHCHECK 用，不记日志
    if (path === "/healthz") {
      writeReply(res, req, ok({ ok: true, status: "healthy", time: new Date().toISOString() }));
      return;
    }

    const matched = matchRoute(method, path);
    if (!matched) {
      if (isApi) {
        writeReply(res, req, errorReply(new HttpError(404, "NOT_FOUND", `接口不存在：${method} ${path}`)));
        return;
      }
      writeReply(res, req, serveStatic({ path } as Ctx));
      return;
    }

    const rawBody = await readBody(req, config.maxBodyBytes);
    let body: Record<string, unknown> = {};
    if (rawBody.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        const trimmed = rawBody.trim();
        // 常见误用：把表单编码/查询串当 JSON 发过来（如 a=1&b=2），或用了单引号/尾逗号
        const looksLikeForm = /^[^\s{[][^=&\s]*=/.test(trimmed) || /^[\w.-]+=[^&]*$/.test(trimmed);
        throw badRequest(
          looksLikeForm
            ? "请求体看起来是表单编码（如 a=1&b=2）。本服务只接受 JSON，请设置 Content-Type: application/json 并发送 JSON 对象"
            : "请求体不是合法 JSON：请检查是否使用了双引号、没有尾逗号，且 Content-Type 为 application/json",
          "INVALID_JSON",
          { length: rawBody.length, first_char: trimmed.slice(0, 1) },
        );
      }
      if (Array.isArray(parsed)) {
        body = { items: parsed as unknown[] };
      } else if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      } else {
        throw badRequest(
          `请求体必须是 JSON 对象（形如 {"key":"value"}），当前收到的是 ${parsed === null ? "null" : typeof parsed}`,
          "INVALID_JSON",
          { received_type: parsed === null ? "null" : typeof parsed },
        );
      }
    }

    const ctx: Ctx = {
      req,
      res,
      method,
      path,
      query: url.searchParams,
      params: matched.params,
      headers: req.headers,
      body,
      rawBody,
      ip,
      requestId,
      token: bearerToken(req),
    };

    // 员工/代理的权限：
    //   1) 登录校验（login 除外）
    //   2) 代理只能访问卡密相关接口（数据隔离在 handler 里按 agent 过滤）
    //   3) 按路由表校验功能权限
    if (path.startsWith("/admin/api/") && !path.startsWith("/admin/api/auth/login")) {
      const staffCtx = requireStaff(ctx);
      // 代理还需要读产品/模块列表来生成卡密（写操作仍被功能权限挡住）
      if (
        staffCtx.isAgent &&
        !/^\/admin\/api\/(cdks|cdk-batches|auth|products|modules|customers|agent-home|licenses)/.test(path)
      ) {
        throw forbidden("代理账号只能访问卡密相关接口", "FORBIDDEN_AGENT_SCOPE");
      }
      const requiredFeature = featureForAdminRoute(method, path);
      if (requiredFeature) requireFeature(ctx, requiredFeature);
    }

    const reply = await matched.handler(ctx);
    writeReply(res, req, reply);
  } catch (err) {
    writeReply(res, req, errorReply(err));
  } finally {
    if (config.nodeEnv !== "test" && path !== "/healthz") {
      const elapsed = Date.now() - started;
      console.log(`${method} ${path} ${res.statusCode} ${elapsed}ms`);
    }
  }
}

export function buildServer(): Server {
  registerClientRoutes();
  registerAdminRoutes();
  return createServer((req, res) => {
    void handleRequest(req, res);
  });
}

export async function start(): Promise<void> {
  const info = await bootstrap();
  const server = buildServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const key = publicKeyInfo();
  console.log("──────────────────────────────────────────────");
  console.log(` ${SERVER_NAME} v${SERVER_VERSION} 已启动`);
  console.log(` 监听:        http://${config.host}:${config.port}`);
  console.log(` 客户门户:    http://localhost:${config.port}/`);
  console.log(` 管理后台:    http://localhost:${config.port}/${getAdminPath()}`);
  const mig = migrationInfo();
  const schemaText = mig.from === mig.to ? `v${mig.to}` : `v${mig.from} → v${mig.to}（已自动升级）`;
  console.log(` 数据库:      ${info.dbPath}（结构版本 ${schemaText}，程序支持 v${SCHEMA_VERSION}）`);
  console.log(` 签名密钥:    kid=${key.kid} (${key.algorithm})`);
  console.log(` 离线宽限:    ${config.offlineGraceDays} 天 / 心跳周期 ${config.heartbeatIntervalHours} 小时`);
  if (info.adminCreated) {
    console.log(` 已创建管理员: ${info.adminEmail}`);
    if (info.generatedPasswordFile) {
      console.log(` 初始密码写入: ${info.generatedPasswordFile}（请登录后立即修改并删除）`);
    }
  }
  console.log("──────────────────────────────────────────────");
  console.log(" 客户端验签公钥（内置到客户端即可）:");
  console.log(key.public_key_pem.trim());

  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain = process.argv[1] ? import.meta.filename === process.argv[1] : false;
if (isMain) {
  start().catch((err) => {
    console.error("启动失败:", err);
    process.exit(1);
  });
}
