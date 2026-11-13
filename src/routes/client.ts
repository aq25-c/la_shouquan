/**
 * 客户端 API（供被授权程序调用）
 *   - 账号注册 / 登录
 *   - CDK 预检 / 激活（在线激活 + 离线许可证文件）
 *   - 心跳（滚动续期）、设备解绑
 *   - 公钥分发
 */
import { config } from "../config.ts";
import {
  generateLicenseKey,
  hashPassword,
  sha256hex,
  verifyPassword,
} from "../crypto.ts";
import {
  badRequest,
  bearerToken,
  q,
  bodyInt,
  bodyStr,
  bodyStrArray,
  conflict,
  created,
  forbidden,
  get,
  locked,
  needStr,
  notFound,
  ok,
  post,
  raw,
  unauthorized,
} from "../http.ts";
import { buildApiDocs, renderDocsPage } from "../api-spec.ts";
import type { Ctx } from "../http.ts";
import { customerTtl, currentCustomer, grantSession, requireCustomer } from "../auth.ts";
import { buildLicenseFile, licenseView } from "../issuer.ts";
import { publicKeyInfo, signingKeys } from "../keys.ts";
import { withTx } from "../db.ts";
import { audit, listAuditByTargets } from "../store/audit.ts";
import {
  createCustomer,
  findCustomerByEmail,
  findCustomerById,
  revokeSessionsFor,
  touchCustomerLogin,
  updateCustomer,
} from "../store/accounts.ts";
import { findModuleById, findModuleByCode, findProductByCode, findProductById, listModules, listProducts, moduleCodesFor } from "../store/catalog.ts";
import {
  canStartModuleTrial,
  getTrialConfig,
  trialCountForModule,
  trialModulesForProduct,
} from "../store/trials.ts";
import {
  activeDeviceCount,
  seatUsageForProduct,
  addLicenseModuleIds,
  applyModuleTerms,
  findModuleTermConflicts,
  recomputeLicenseExpiry,
  setModuleTerm,
  consumeModuleUsage,
  consumeUsage,
  effectiveStatus,
  findReusableLicense,
  listLicenseModules,
  termCategory,
  extendLicenseExpiry,
  addLicenseUsages,
  findCdkByCode,
  findDevice,
  findLicenseById,
  findLicenseByKeyHash,
  listDevices,
  listDevicesForGroup,
  licenseGroup,
  licenseGroupIds,
  listLicensesByCustomer,
  markCdkUsed,
  moduleIdsOf,
  releaseDevice,
  releaseAllDevices,
  rotateLicenseKey,
  touchDevice,
  touchLicenseHeartbeat,
  upsertDevice,
  createLicense,
  updateLicense,
} from "../store/licensing.ts";
import { varsForClient } from "../store/vars.ts";
import type { LicenseRow } from "../types.ts";
import { isEmail, normalizeEmail } from "../util.ts";

const SERVER_VERSION = "1.0.0";

function customerView(customer: { id: string; email: string | null; name: string | null; created_at: string }) {
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    created_at: customer.created_at,
  };
}

/** 客户会话（注册/登录后在本次响应里返回 token，客户端自行保存） */
function sessionPayload(ctx: Ctx, customerId: string) {
  const session = grantSession("customer", customerId, customerTtl(), ctx);
  return { token: session.token, expires_at: session.expires_at };
}

function daysLeft(expiresAt: string): number {
  // 加 1 分钟容差，避免"刚开通 30 天"因毫秒漂移显示成 29 天
  const ms = Date.parse(expiresAt) - Date.now() + 60_000;
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/**
 * 登录 / 鉴权时返回的授权快照：
 *   - 试用期 → 给试用到期时间（is_trial = true）
 *   - 已激活 → 给卡密授权到期时间
 *   - 次数卡 → 额外给剩余次数 usages.remaining
 */
function licenseSnapshot(customerId: string) {
  const now = Date.now();
  const items = listLicensesByCustomer(customerId).map((row) => {
    const status = effectiveStatus(row, now);
    const isCount = row.term_type === "count";
    const expiresMs = row.expires_at ? Date.parse(row.expires_at) : null;
    const maxUsages = row.max_usages ?? 0;
    const usedUsages = row.used_usages ?? 0;
    return {
      license_id: row.id,
      license_no: row.license_no,
      product_id: row.product_id,
      product_code: row.product_code,
      product_name: row.product_name,
      kind: row.kind,
      is_trial: row.kind === "trial",
      status,
      term_type: row.term_type,
      term_value: row.term_value,
      starts_at: row.starts_at,
      expires_at: row.expires_at,
      days_left: status === "active" && expiresMs ? Math.max(0, Math.ceil((expiresMs - now) / 86_400_000)) : 0,
      usages: isCount
        ? { max: maxUsages, used: usedUsages, remaining: Math.max(0, maxUsages - usedUsages) }
        : null,
      // v9：每个模块各自的到期时间（未单独设置时跟随授权到期）
      modules: listLicenseModules(row.id).map((lm) => {
        const mod = findModuleById(lm.module_id);
        const modExpiry = lm.expires_at ?? row.expires_at ?? null;
        const modMs = modExpiry ? Date.parse(modExpiry) : null;
        return {
          module_id: lm.module_id,
          module_code: mod?.code ?? lm.module_id,
          module_name: mod?.name ?? lm.module_id,
          module_description: mod?.description ?? null,
          expires_at: modExpiry,
          days_left: modMs ? Math.max(0, Math.ceil((modMs - now) / 86_400_000)) : 0,
          active: status === "active" && (!modMs || modMs > now),
        };
      }),
    };
  });

  // 优先取「已激活的正式授权」，其次「试用中」，都没有则 null
  const activeLicense =
    items.find((item) => item.status === "active" && !item.is_trial) ??
    items.find((item) => item.status === "active") ??
    null;

  return { licenses: items, active_license: activeLicense };
}

export function registerClientRoutes(): void {
  /* ---------------------------- 元信息 ---------------------------- */

  get("/api/v1/server-info", () =>
    ok({
      server: "license-server",
      version: SERVER_VERSION,
      heartbeat_interval_hours: config.heartbeatIntervalHours,
      offline_grace_days: config.offlineGraceDays,
      server_time: new Date().toISOString(),
    }),
  );

  get("/api/v1/public-key", () => ok(publicKeyInfo()));

  /** 公开的 API 文档（JSON）：无需鉴权，供外部工具/文档站抓取 */
  get("/api/v1/docs", () => ok(buildApiDocs()));

  /** 公开的 API 文档（网页版）：无需登录，可直接把链接发给客户端开发者 */
  get("/docs", (ctx) => {
    const forwardedProto = ctx.headers["x-forwarded-proto"];
    const proto =
      config.trustProxy && typeof forwardedProto === "string"
        ? forwardedProto.split(",")[0].trim()
        : "http";
    const host = ctx.headers.host ?? `localhost:${config.port}`;
    return raw(renderDocsPage(buildApiDocs(), `${proto}://${host}`), "text/html; charset=utf-8", 200, {
      "Cache-Control": "no-cache",
    });
  });

  /* ---------------------------- 账号 ---------------------------- */

  post("/api/v1/auth/register", async (ctx) => {
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });

    if (!isEmail(email)) throw badRequestEmail();
    if (password.length < 6) {
      throw conflict("密码至少 6 位", "WEAK_PASSWORD");
    }
    if (findCustomerByEmail(email)) {
      throw conflict("该邮箱已注册，请直接登录", "EMAIL_TAKEN");
    }
    const passwordHash = await hashPassword(password);
    const customer = createCustomer({ email, passwordHash, name });
    audit({
      actorType: "customer",
      actorId: customer.id,
      actorLabel: email,
      action: "customer.register",
      targetType: "customer",
      targetId: customer.id,
      ip: ctx.ip,
    });
    return created({
      customer: customerView(customer),
      session: sessionPayload(ctx, customer.id),
      licenses: [],
      active_license: null,
    });
  });

  post("/api/v1/auth/login", async (ctx) => {
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const customer = findCustomerByEmail(email);
    if (!customer || !customer.password_hash) {
      throw unauthorized("邮箱或密码不正确", "INVALID_CREDENTIALS");
    }
    if (!(await verifyPassword(password, customer.password_hash))) {
      audit({
        actorType: "anonymous",
        actorLabel: email,
        action: "customer.login_failed",
        ip: ctx.ip,
      });
      throw unauthorized("邮箱或密码不正确", "INVALID_CREDENTIALS");
    }
    if (customer.status !== "active") {
      throw forbidden("账号已被停用，请联系服务商", "CUSTOMER_DISABLED");
    }
    touchCustomerLogin(customer.id);
    audit({
      actorType: "customer",
      actorId: customer.id,
      actorLabel: email,
      action: "customer.login",
      ip: ctx.ip,
    });
    return ok({
      customer: customerView(customer),
      session: sessionPayload(ctx, customer.id),
      ...licenseSnapshot(customer.id),
    });
  });

  get("/api/v1/auth/me", (ctx) => {
    const customer = requireCustomer(ctx);
    const snapshot = licenseSnapshot(customer.id);
    const rows = listLicensesByCustomer(customer.id);
    const devicesById = new Map(
      rows.map((row) => [row.id, listDevices(row.id).filter((d) => d.status === "active")]),
    );
    return ok({
      customer: customerView(customer),
      licenses: snapshot.licenses.map((item) => ({
        ...item,
        devices: devicesById.get(item.license_id) ?? [],
      })),
      active_license: snapshot.active_license,
    });
  });

  /* ---------------------------- 远程变量 ---------------------------- */

  /**
   * 远程变量（必须登录）：未登录直接 401，避免被匿名抓取。
   * 不传 product 时默认取该客户名下第一个有效授权对应的产品。
   */
  get("/api/v1/vars", (ctx) => {
    const code = q(ctx, "product");

    // 客户端一般只保存了 license_key，没有客户会话 —— 两种身份都认。
    // 此前只支持客户会话，客户端调这个接口会拿到 401「请先登录客户账号」，
    // 表现出来就是客户端「软件参数加载失败」。
    const raw = bearerToken(ctx.req);
    const byKey = raw ? findLicenseByKeyHash(sha256hex(raw)) : null;
    if (byKey) {
      if (effectiveStatus(byKey) === "revoked") throw locked("授权已被吊销", "LICENSE_REVOKED");
      const own = findProductById(byKey.product_id);
      const product = (code ? findProductByCode(code) : null) ?? own;
      if (!product) throw notFound("没有可读取的产品", "PRODUCT_NOT_FOUND");
      return ok({
        product: { code: product.code, name: product.name },
        vars: varsForClient(product.id),
        // 顺手把席位相关的事实返回，客户端不用再猜
        license: {
          license_no: byKey.license_no,
          status: effectiveStatus(byKey),
          seats: byKey.seats,
          active_devices: byKey.active_devices,
          expires_at: byKey.expires_at,
        },
      });
    }

    const customer = requireCustomer(ctx);

    let product = code ? findProductByCode(code) : null;
    if (!product) {
      const mine = listLicensesByCustomer(customer.id).filter((r) => r.status !== "revoked");
      product = mine.length ? findProductById(mine[0].product_id) : null;
    }
    if (!product) throw notFound("没有可读取的产品，请先激活或指定 ?product=", "PRODUCT_NOT_FOUND");

    return ok({
      product: { code: product.code, name: product.name },
      vars: varsForClient(product.id),
    });
  });

  /**
   * 客户门户的授权总览：一次拿全账号 + 每条授权的模块明细与设备，
   * 避免门户为了拼一张卡片发四五个请求。
   */
  get("/api/v1/me/overview", (ctx) => {
    const customer = requireCustomer(ctx);
    const rows = listLicensesByCustomer(customer.id);
    const nowMs = Date.now();

    const licenses = rows.map((row) => {
      const modules = listLicenseModules(row.id).map((lm) => {
        const mod = findModuleById(lm.module_id);
        const exp = lm.expires_at ?? row.expires_at ?? null;
        const ms = exp ? Date.parse(exp) : null;
        const withinTerm = !ms || ms > nowMs;
        return {
          code: mod?.code ?? lm.module_id,
          name: mod?.name ?? lm.module_id,
          description: mod?.description ?? null,
          expires_at: exp,
          days_left: ms ? Math.max(0, Math.ceil((ms - nowMs) / 86_400_000)) : 0,
          active: row.status === "active" && withinTerm,
          // 次数型模块顺带给出额度，前端不用再查
          max_usages: lm.max_usages ?? null,
          used_usages: lm.used_usages ?? 0,
        };
      });
      return {
        id: row.id,
        license_no: row.license_no,
        kind: row.kind,
        source: row.source,
        status: effectiveStatus(row),
        starts_at: row.starts_at,
        expires_at: row.expires_at,
        days_left: daysLeft(row.expires_at),
        seats: row.seats,
        active_devices: row.active_devices,
        product: { code: row.product_code, name: row.product_name },
        modules,
        // 设备按「同一客户 + 同一软件」共享：试用卡与 CDK 卡显示同一批设备
        devices: listDevicesForGroup(row.customer_id, row.product_id)
          .filter((d) => d.status === "active")
          .map((d) => ({
            device_id: d.device_id,
            device_name: d.device_name,
            platform: d.platform,
            last_seen_at: d.last_seen_at,
          })),
      };
    });

    const activeLicenses = licenses.filter((l) => l.status === "active");
    return ok({
      customer: customerView(customer),
      licenses,
      summary: {
        licenses: licenses.length,
        active: activeLicenses.length,
        expiring_7d: activeLicenses.filter((l) => l.days_left !== null && l.days_left <= 7).length,
        active_modules: licenses.reduce((n, l) => n + l.modules.filter((m) => m.active).length, 0),
      },
    });
  });

  /**
   * 客户自助改密码：原密码 + 新密码。
   * 改完把该账号的其它会话全部作废，再发一个新会话给当前这台设备，
   * 免得用户改完密码自己被踢出去。
   */
  post("/api/v1/auth/password", async (ctx) => {
    const customer = requireCustomer(ctx);
    const current = needStr(ctx, "current_password", 200);
    const next = needStr(ctx, "new_password", 200);
    if (next.length < 8) throw badRequest("新密码至少 8 位", "WEAK_PASSWORD");
    if (next === current) throw badRequest("新密码不能和原密码一样", "SAME_PASSWORD");
    if (!customer.password_hash || !(await verifyPassword(current, customer.password_hash))) {
      throw unauthorized("原密码不正确", "INVALID_CREDENTIALS");
    }

    updateCustomer(customer.id, { password_hash: await hashPassword(next) });
    revokeSessionsFor("customer", customer.id);
    audit({
      actorType: "customer",
      actorId: customer.id,
      actorLabel: customer.email,
      action: "customer.password_change",
      targetType: "customer",
      targetId: customer.id,
      ip: ctx.ip,
    });
    return ok({ changed: true, relogin_others: true, ...sessionPayload(ctx, customer.id) });
  });

  /* ---------------------------- 试用 ---------------------------- */

  /** 试用配置（公开）：按模块下发，客户端可据此让用户挑模块试用 */
  get("/api/v1/trial/info", () => {
    const trialGlobal = getTrialConfig();
    const configured = trialGlobal.product_id ? findProductById(trialGlobal.product_id) : null;
    const targets = configured ? [configured] : listProducts().filter((p) => p.status === "active");
    const modules = targets.flatMap((p) =>
      trialModulesForProduct(p.id).map(({ module, config }) => ({
        product_code: p.code,
        code: module.code,
        name: module.name,
        description: module.description,
        mode: config.mode,
        value: config.value,
        days: config.days,
        seats: config.seats,
        max_per_customer: config.max_per_customer,
      })),
    );
    return ok({
      enabled: modules.length > 0,
      seats: trialGlobal.seats,
      max_per_customer: trialGlobal.max_per_customer,
      days: trialGlobal.days,
      product: configured ? { code: configured.code, name: configured.name } : null,
      module_codes: modules.map((m) => m.code),
      modules,
    });
  });

  /** 我的试用情况（需客户登录）：按模块给出已用次数与是否还能试用 */
  get("/api/v1/trial/status", (ctx) => {
    const customer = requireCustomer(ctx);
    const trialGlobal = getTrialConfig();
    const items = listProducts()
      .filter((p) => p.status === "active")
      .map((p) => {
        const modules = trialModulesForProduct(p.id).map(({ module, config }) => {
          const used = trialCountForModule(customer.id, module.id);
          const guard = canStartModuleTrial(customer.id, module.id);
          return {
            code: module.code,
            name: module.name,
            mode: config.mode,
            value: config.value,
            days: config.days,
            max_per_customer: config.max_per_customer,
            used,
            remaining: Math.max(0, config.max_per_customer - used),
            available: guard.ok,
            reason: guard.ok ? null : guard.message,
          };
        });
        return { product: { code: p.code, name: p.name }, modules };
      })
      .filter((p) => p.modules.length > 0);
    return ok({
      enabled: items.length > 0,
      seats: trialGlobal.seats,
      max_per_customer: trialGlobal.max_per_customer,
      days: trialGlobal.days,
      items,
    });
  });

  /** 自助开通试用：按模块的开通配置生成 trial 授权并绑定当前设备 */
  post("/api/v1/trial/start", (ctx) => {
    const customer = requireCustomer(ctx);
    const deviceId = needStr(ctx, "device_id", 190);
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 });
    const productCode = bodyStr(ctx, "product_code", { max: 64 });
    const requestedCodes = bodyStrArray(ctx, "module_codes");

    const trialGlobal = getTrialConfig();

    let product = trialGlobal.product_id ? findProductById(trialGlobal.product_id) : null;
    if (!product && productCode) product = findProductByCode(productCode);
    if (!product) {
      const candidate = listProducts().find(
        (p) => p.status === "active" && trialModulesForProduct(p.id).length > 0,
      );
      product = candidate ? findProductById(candidate.id) : null;
    }
    if (!product) throw notFound("没有可试用的产品", "PRODUCT_NOT_FOUND");
    if (product.status !== "active") throw conflict("该产品当前不开放试用", "PRODUCT_DISABLED");

    // v12：试用按模块配置，只列开放试用的模块
    const eligible = trialModulesForProduct(product.id);
    if (!eligible.length) throw locked("该产品没有开放试用的模块", "TRIAL_DISABLED");

    // 没指定就默认开通全部可试用模块
    let picked = eligible;
    if (requestedCodes && requestedCodes.length) {
      const wanted = new Set(requestedCodes.map((c) => String(c).trim().toLowerCase()));
      picked = eligible.filter((e) => wanted.has(e.module.code.toLowerCase()));
      if (picked.length !== wanted.size) {
        throw forbidden("所选模块不在试用范围内", "MODULE_NOT_ALLOWED");
      }
    }

    // 逐个模块校验：是否开放、次数是否用完、是否已有正式授权
    for (const { module } of picked) {
      const g = canStartModuleTrial(customer.id, module.id);
      if (!g.ok) throw locked(g.message, g.code, { module_code: module.code });
    }

    const first = picked[0].config;
    const terms = picked.map(({ module, config }) => ({
      module,
      config,
      termType: (config.mode === "count" ? "count" : "day") as "count" | "day",
      termValue: config.value,
    }));

    const licenseKey = generateLicenseKey();
    const license = withTx(() => {
      const row = createLicense({
        customerId: customer.id,
        productId: product.id,
        cdkId: null,
        moduleIds: [], // 先建壳，下面逐模块写入各自的计费
        // 席位是软件级的：所有模块共用产品 / 全局的试用席位（默认 1）
        seats: first.seats,
        days: first.days,
        termType: terms[0].termType,
        termValue: terms[0].termValue,
        offlineGraceDays: first.offline_grace_days ?? undefined,
        keyHash: sha256hex(licenseKey),
        note: `试用 ${picked.map((p) => p.module.code).join("+")}`,
        kind: "trial",
        source: "trial",
      });
      addLicenseModuleIds(row.id, terms.map((t) => t.module.id));
      for (const t of terms) setModuleTerm(row.id, t.module.id, t.termType, t.termValue);
      return recomputeLicenseExpiry(row.id) ?? row;
    });

    upsertDevice({ licenseId: license.id, deviceId, deviceName, platform, ip: ctx.ip });

    const issued = buildLicenseFile({
      license,
      productCode: product.code,
      deviceId,
      keys: signingKeys(),
    });

    audit({
      actorType: "customer",
      actorId: customer.id,
      actorLabel: customer.email,
      action: "license.trial_start",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
      detail: {
        product: product.code,
        modules: picked.map((p) => p.module.code),
        device_id: deviceId,
      },
    });

    return created({
      license: licenseView(license),
      license_key: licenseKey,
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      starts_at: license.starts_at,
      expires_at: license.expires_at,
      days_left: daysLeft(license.expires_at),
      product: { code: product.code, name: product.name },
      module_codes: issued.payload.mod,
      modules: terms.map((t) => ({
        code: t.module.code,
        name: t.module.name,
        mode: t.config.mode,
        value: t.config.value,
        expires_at:
          listLicenseModules(license.id).find((r) => r.module_id === t.module.id)?.expires_at ?? null,
      })),
      heartbeat_interval_hours: config.heartbeatIntervalHours,
      server_time: new Date().toISOString(),
    });
  });

  /* ---------------------------- CDK ---------------------------- */

  post("/api/v1/cdks/inspect", (ctx) => {
    const cdk = findCdkByCode(needStr(ctx, "cdk", 64));
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    const product = findProductById(cdk.product_id);
    return ok({
      code: cdk.code,
      status: cdk.status,
      product: product ? { code: product.code, name: product.name } : null,
      module_codes: moduleCodesFor(moduleIdsOf(cdk)),
      // 带上模块名称，前端不用再拿 code 猜这是哪个功能
      modules: moduleIdsOf(cdk).map((id) => {
        const mod = findModuleById(id);
        return { code: mod?.code ?? id, name: mod?.name ?? id };
      }),
      days: cdk.days,
      seats: cdk.seats,
      redeem_before: cdk.expires_at,
      usable: cdk.status === "unused" && (!cdk.expires_at || Date.parse(cdk.expires_at) > Date.now()),
    });
  });

  /* ---------------------------- 激活 ---------------------------- */

  post("/api/v1/licenses/activate", async (ctx) => {
    const cdkInput = needStr(ctx, "cdk", 64);
    // bind_device=false：网页端激活只把卡绑到账号，不占席位（设备留给客户端之后绑）
    const bindDevice = ctx.body.bind_device !== false;
    const deviceId = bodyStr(ctx, "device_id", { max: 190 }) ?? (bindDevice ? null : "web");
    if (bindDevice && !deviceId) throw badRequest("缺少 device_id（或传 bind_device=false）", "MISSING_FIELD");
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 }) ?? (bindDevice ? null : "web");
    /** 签发许可证 / 审计用的设备标识；网页激活时是个占位值，不落设备表 */
    const deviceRef = deviceId ?? "web";

    const cdk = findCdkByCode(cdkInput);
    if (!cdk) throw notFound("CDK 不存在，请检查输入是否正确", "CDK_NOT_FOUND");
    if (cdk.status === "used") throw conflict("该 CDK 已被使用", "CDK_ALREADY_USED");
    if (cdk.status === "revoked") throw conflict("该 CDK 已被作废", "CDK_REVOKED");
    if (cdk.expires_at && Date.parse(cdk.expires_at) <= Date.now()) {
      throw conflict("该 CDK 已超过兑换期限", "CDK_EXPIRED");
    }
    const product = findProductById(cdk.product_id);
    if (!product) throw notFound("CDK 关联的产品不存在", "PRODUCT_NOT_FOUND");
    if (product.status !== "active") throw conflict("该产品当前不可激活", "PRODUCT_DISABLED");

    /* --- 模块范围：默认按 CDK 授权全开；客户端可取消部分模块，但至少要保留 1 个 --- */
    const cdkModuleIds = moduleIdsOf(cdk);
    const requestedModules = bodyStrArray(ctx, "module_ids");
    let activeModuleIds = cdkModuleIds;
    if (requestedModules && requestedModules.length) {
      const invalid = requestedModules.filter((m) => !cdkModuleIds.includes(m));
      if (invalid.length) {
        throw badRequest("所选模块不在该 CDK 的授权范围内", "MODULE_NOT_ALLOWED", { invalid });
      }
      activeModuleIds = requestedModules;
    }
    if (!activeModuleIds.length) {
      throw badRequest("请至少勾选一个模块", "MISSING_FIELD", { field: "module_ids" });
    }

    /* --- 账号归属：先做异步校验（scrypt），再进事务做同步写入 --- */
    type Plan =
      | { kind: "existing"; customerId: string }
      | { kind: "new"; email: string | null; passwordHash: string | null; name: string | null };

    let plan: Plan;
    const signedIn = currentCustomer(ctx);
    if (signedIn) {
      if (signedIn.status !== "active") throw forbidden("账号已被停用", "CUSTOMER_DISABLED");
      plan = { kind: "existing", customerId: signedIn.id };
    } else {
      const emailRaw = bodyStr(ctx, "email", { max: 190 });
      const password = bodyStr(ctx, "password", { max: 200 });
      const name = bodyStr(ctx, "name", { max: 120 });
      if (emailRaw) {
        const email = normalizeEmail(emailRaw);
        if (!isEmail(email)) throw badRequestEmail();
        const existing = findCustomerByEmail(email);
        if (existing) {
          if (existing.status !== "active") throw forbidden("账号已被停用", "CUSTOMER_DISABLED");
          if (!password) throw unauthorized("该邮箱已注册，请提供密码或先登录", "PASSWORD_REQUIRED");
          if (!existing.password_hash || !(await verifyPassword(password, existing.password_hash))) {
            throw unauthorized("邮箱或密码不正确", "INVALID_CREDENTIALS");
          }
          touchCustomerLogin(existing.id);
          plan = { kind: "existing", customerId: existing.id };
        } else {
          if (!password || password.length < 6) throw conflict("新账号密码至少 6 位", "WEAK_PASSWORD");
          plan = { kind: "new", email, passwordHash: await hashPassword(password), name };
        }
      } else {
        // 匿名激活：建一条不可登录的客户记录，后续可用 CDK 号找服务商迁移
        plan = { kind: "new", email: null, passwordHash: null, name: name ?? "匿名激活" };
      }
    }

    let licenseKey = generateLicenseKey();
    const outcome = withTx(() => {
      const customerId =
        plan.kind === "existing"
          ? plan.customerId
          : createCustomer({
              email: plan.email,
              passwordHash: plan.passwordHash,
              name: plan.name,
            }).id;

      const newTermType = (cdk.term_type ?? "day") as "hour" | "day" | "month" | "year" | "count";
      const newTermValue = cdk.term_value ?? cdk.days;

      // v8：同客户同产品已有有效授权时「叠加续费」
      // v11：时长型改成「逐模块叠加」——CDK 里每个模块从它自己的到期时间往后加，
      //      新模块从当前时间起算，本次 CDK 没带的模块完全不动。
      //      次数型仍按整张授权累加（模块级计次留到后续版本）。
      const reusable = findReusableLicense(customerId, cdk.product_id);
      const isCountTerm = termCategory(newTermType) === "count";

      if (reusable && !isCountTerm) {
        // 同一模块不能既有时长卡又压次数卡；不同模块互不影响
        const conflicts = findModuleTermConflicts(reusable.id, activeModuleIds, newTermType);
        if (conflicts.length) {
          const names = conflicts
            .map((c) => findModuleById(c.moduleId)?.code ?? c.moduleId)
            .join("、");
          throw conflict(`模块 ${names} 当前是次数卡，不能叠加时长卡`, "TERM_CONFLICT", {
            modules: conflicts.map((c) => ({ module_id: c.moduleId, term_type: c.termType })),
          });
        }
      }
      if (reusable && isCountTerm && termCategory(reusable.term_type ?? "day") !== "count") {
        throw conflict("当前授权是时长卡（尚未到期），不能叠加次数卡", "TERM_CONFLICT", {
          existing_term_type: reusable.term_type ?? "day",
          new_term_type: newTermType,
        });
      }

      let license: LicenseRow;
      let merged = false;
      if (reusable) {
        // 叠加到现有授权，并重新签发密钥（旧密钥作废，客户端需保存新的）
        licenseKey = generateLicenseKey();
        rotateLicenseKey(reusable.id, sha256hex(licenseKey));
        // 席位取较大值：新卡承诺的台数必须生效，续费时也不会把席位翻倍。
        // （此前合并完全不看 cdk.seats，买了 3 席位的卡仍然只能绑 1 台）
        if (cdk.seats > reusable.seats) {
          updateLicense(reusable.id, { seats: cdk.seats });
        }
        // 归属跟随最后一次激活的卡：A 的卡激活过就归 A，后来用 B 的卡就转给 B
        // （客户端/服务商侧看到的「客户归属」按授权上的 agent_id 算）
        updateLicense(reusable.id, { agent_id: cdk.agent_id ?? null, unit_price: cdk.unit_price ?? 0 });
        if (isCountTerm) {
          license = addLicenseUsages(reusable.id, newTermValue);
        } else {
          // 逐模块算账：已有模块从原到期叠加，新模块从今天起算
          addLicenseModuleIds(reusable.id, activeModuleIds);
          applyModuleTerms(reusable.id, activeModuleIds, newTermType, newTermValue);
          license = recomputeLicenseExpiry(reusable.id) ?? reusable;
        }
        merged = true;
      } else {
        license = createLicense({
          customerId,
          productId: cdk.product_id,
          cdkId: cdk.id,
          moduleIds: activeModuleIds,
          seats: cdk.seats,
          days: cdk.days,
          keyHash: sha256hex(licenseKey),
          note: `CDK ${cdk.code}`,
          // v2：代理与单价从 CDK 批次继承下来，供后台按代理统计营收
          agentId: cdk.agent_id,
          unitPrice: cdk.unit_price,
          // v4：计费类型从 CDK 继承（天/月/年/小时/次数）
          termType: newTermType,
          termValue: newTermValue,
        });
      }

      if (!markCdkUsed(cdk.id, customerId, license.id)) {
        throw conflict("该 CDK 刚刚已被使用，请更换", "CDK_ALREADY_USED");
      }
      const device = bindDevice
        ? upsertDevice({
            licenseId: license.id,
            deviceId: deviceRef,
            deviceName,
            platform,
            ip: ctx.ip,
          })
        : null;
      return { customerId, license, deviceId: device?.device_id ?? null, merged };
    });

    const issued = buildLicenseFile({
      license: outcome.license,
      productCode: product.code,
      deviceId: deviceRef,
      keys: signingKeys(),
    });

    audit({
      actorType: "customer",
      actorId: outcome.customerId,
      action: "license.activate",
      targetType: "license",
      targetId: outcome.license.id,
      ip: ctx.ip,
      detail: { cdk: cdk.code, product: product.code, device_id: bindDevice ? deviceRef : null, web: !bindDevice },
    });

    return created({
      license: licenseView(outcome.license),
      license_key: licenseKey, // 只出现这一次，客户端必须本地保存
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      expires_at: outcome.license.expires_at,
      days_left: daysLeft(outcome.license.expires_at),
      product: { code: product.code, name: product.name },
      module_codes: issued.payload.mod,
      heartbeat_interval_hours: config.heartbeatIntervalHours,
      server_time: new Date().toISOString(),
      /** true 表示本次是同类型卡的叠加续费（沿用原授权与设备，密钥已重新签发） */
      merged: outcome.merged,
      /** false = 网页端激活，只绑账号不占席位，设备留给客户端首次启动时绑 */
      device_bound: bindDevice,
      ...(plan.kind === "new" && plan.email
        ? { session: sessionPayload(ctx, outcome.customerId) }
        : {}),
    });
  });

  /* ---------------------------- 心跳 ---------------------------- */

  post("/api/v1/licenses/heartbeat", (ctx) => {
    const licenseKey = needStr(ctx, "license_key", 200);
    const deviceId = needStr(ctx, "device_id", 190);

    const license = findLicenseByKeyHash(sha256hex(licenseKey));
    if (!license) throw notFound("许可证密钥无效", "INVALID_LICENSE_KEY");

    const eff = effectiveStatus(license);

    if (license.status === "revoked") {
      throw locked("授权已被吊销", "LICENSE_REVOKED", { expires_at: license.expires_at });
    }
    if (license.status === "suspended") {
      throw locked("授权已被暂停", "LICENSE_SUSPENDED", { expires_at: license.expires_at });
    }
    const customer = findCustomerById(license.customer_id);
    if (!customer || customer.status !== "active") {
      throw locked("账号已被停用", "CUSTOMER_DISABLED");
    }
    // v11：到期不再拒绝心跳。账号和授权信息照常返回，只是过期模块的功能不可用
    //      （客户端按 modules[].active 判断）。吊销 / 暂停 / 停用仍然直接拒绝。
    if (eff === "pending") {
      throw locked("授权尚未生效", "LICENSE_NOT_STARTED", { starts_at: license.starts_at });
    }

    // 到期后设备会被统一解绑（把席位释放出来），所以这里不能用「设备未绑定」把它挡在门外：
    // 拿到过期授权仍然正常回 200 + 各模块 active=false，客户端据此关功能即可。
    let device = findDevice(license.id, deviceId);
    if (eff !== "expired") {
      if (!device) throw notFound("该设备未绑定此授权，请重新激活", "DEVICE_NOT_BOUND");
      if (device.status !== "active") {
        // 只有「到期自动释放」的机器能在续费后自己回来；手动解绑的不许自动复位
        const usage = seatUsageForProduct(license.customer_id, license.product_id);
        if (device.released_reason === "expired" && usage.active_devices < usage.seats) {
          upsertDevice({
            licenseId: license.id,
            deviceId,
            deviceName: device.device_name,
            platform: device.platform,
            ip: ctx.ip,
          });
          device = findDevice(license.id, deviceId);
        } else {
          throw notFound("该设备未绑定此授权，请重新激活", "DEVICE_NOT_BOUND");
        }
      }
    }

    if (eff === "expired") {
      // 过期即释放席位：这台机器不再占用名额，续费激活后从 0 台重新绑定
      releaseAllDevices(license.id, "expired");
    }

    if (device && device.status === "active") touchDevice(device.id, ctx.ip);
    touchLicenseHeartbeat(license.id);

    // 重新读取，保证响应里的 last_heartbeat_at 是本次心跳时间
    const fresh = findLicenseById(license.id) ?? license;
    const issued = buildLicenseFile({
      license: fresh,
      productCode: fresh.product_code,
      deviceId,
      keys: signingKeys(),
    });

    return ok({
      license: licenseView(fresh),
      // v9：逐模块返回到期时间，客户端按模块判断可用性
      // v11：模块到期是权威来源，不再受授权整体状态牵连（到期变成软状态）
      modules: (() => {
        const nowMs = Date.now();
        return listLicenseModules(fresh.id).map((lm) => {
          const mod = findModuleById(lm.module_id);
          const exp = lm.expires_at ?? fresh.expires_at ?? null;
          const ms = exp ? Date.parse(exp) : null;
          const withinTerm = !ms || ms > nowMs;
          return {
            module_id: lm.module_id,
            module_code: mod?.code ?? lm.module_id,
            module_name: mod?.name ?? lm.module_id,
            module_description: mod?.description ?? null,
            expires_at: exp,
            days_left: ms ? Math.max(0, Math.ceil((ms - nowMs) / 86_400_000)) : 0,
            active: fresh.status === "active" && withinTerm,
          };
        });
      })(),
      /** v11：active / expired 属于软状态；revoked / suspended 走上面的 403 */
      status: eff,
      expired: eff === "expired",
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      expires_at: fresh.expires_at,
      days_left: daysLeft(fresh.expires_at),
      module_codes: issued.payload.mod,
      heartbeat_interval_hours: config.heartbeatIntervalHours,
      server_time: new Date().toISOString(),
    });
  });

  /* ---------------------------- 席位加绑 ---------------------------- */

  /**
   * 同一授权在多台设备上使用：用 license_key 为新设备占用一个席位。
   * 席位已满时返回 SEAT_LIMIT，需要先解绑旧设备或由后台扩容。
   */
  post("/api/v1/licenses/enroll", (ctx) => {
    const licenseKey = needStr(ctx, "license_key", 200);
    const deviceId = needStr(ctx, "device_id", 190);
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 });

    const license = findLicenseByKeyHash(sha256hex(licenseKey));
    if (!license) throw notFound("许可证密钥无效", "INVALID_LICENSE_KEY");

    const eff = effectiveStatus(license);
    if (eff === "revoked") throw locked("授权已被吊销", "LICENSE_REVOKED");
    if (eff === "suspended") throw locked("授权已被暂停", "LICENSE_SUSPENDED");
    if (eff === "expired") throw locked("授权已到期", "LICENSE_EXPIRED", { expires_at: license.expires_at });
    if (eff === "pending") throw locked("授权尚未生效", "LICENSE_NOT_STARTED", { starts_at: license.starts_at });

    const existing = findDevice(license.id, deviceId);
    if (!existing || existing.status !== "active") {
      // 席位按「软件」算：同一客户同产品的多条授权共用一个席位池
      const usage = seatUsageForProduct(license.customer_id, license.product_id);
      if (usage.active_devices >= usage.seats) {
        throw conflict("席位已满，请先在其他设备上解绑或联系服务商扩容", "SEAT_LIMIT", {
          seats: usage.seats,
          active_devices: usage.active_devices,
        });
      }
      upsertDevice({ licenseId: license.id, deviceId, deviceName, platform, ip: ctx.ip });
      // 首次绑定也进日志：客户端自助加设备是「谁在什么时候加了哪台机」的关键记录
      audit({
        actorType: "customer",
        actorId: license.customer_id,
        action: "license.bind_device",
        targetType: "license",
        targetId: license.id,
        ip: ctx.ip,
        detail: { device_id: deviceId, device_name: deviceName || null, platform: platform || null, by: "client" },
      });
    } else {
      touchDevice(existing.id, ctx.ip);
    }

    const issued = buildLicenseFile({
      license,
      productCode: license.product_code,
      deviceId,
      keys: signingKeys(),
    });

    return ok({
      license: licenseView(license),
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      expires_at: license.expires_at,
      days_left: daysLeft(license.expires_at),
      module_codes: issued.payload.mod,
      heartbeat_interval_hours: config.heartbeatIntervalHours,
      server_time: new Date().toISOString(),
    });
  });

  /* ---------------------------- 次数型消耗 ---------------------------- */

  /**
   * 消耗次数型授权的次数（客户端每用一次调一次）。
   * 原子扣减：额度不足时返回 403 USAGE_EXHAUSTED，并发下也不会超扣。
   */
  post("/api/v1/licenses/consume", (ctx) => {
    const licenseKey = needStr(ctx, "license_key", 200);
    const deviceId = needStr(ctx, "device_id", 190);
    const count = bodyInt(ctx, "count", { min: 1, max: 1000 }) ?? 1;
    const moduleCode = bodyStr(ctx, "module_code", { max: 64 });

    const license = findLicenseByKeyHash(sha256hex(licenseKey));
    if (!license) throw notFound("许可证密钥无效", "INVALID_LICENSE_KEY");

    // v12：指定模块且该模块自带额度时，按模块扣，不受「整张卡必须是次数型」的限制
    let targetModuleId: string | null = null;
    if (moduleCode) {
      const mod = findModuleByCode(license.product_id, moduleCode);
      if (!mod) throw notFound("模块不存在", "MODULE_NOT_FOUND");
      const lm = listLicenseModules(license.id).find((r) => r.module_id === mod.id);
      if (lm && lm.max_usages !== null && lm.max_usages !== undefined) targetModuleId = mod.id;
    }

    if (!targetModuleId && (license.term_type !== "count" || license.max_usages === null)) {
      throw conflict("该授权不是按次数计费，无需消耗次数", "NOT_COUNT_LICENSE");
    }

    const device = findDevice(license.id, deviceId);
    if (!device || device.status !== "active") {
      throw notFound("该设备未绑定此授权，请重新激活", "DEVICE_NOT_BOUND");
    }

    if (license.status === "revoked") throw locked("授权已被吊销", "LICENSE_REVOKED");
    if (license.status === "suspended") throw locked("授权已被暂停", "LICENSE_SUSPENDED");
    const customer = findCustomerById(license.customer_id);
    if (!customer || customer.status !== "active") throw locked("账号已被停用", "CUSTOMER_DISABLED");

    let result: { ok: boolean; max: number | null; used: number; remaining: number } | null = null;
    if (targetModuleId) result = consumeModuleUsage(license.id, targetModuleId, count);
    if (!result) result = consumeUsage(license.id, count);
    if (!result.ok) {
      throw locked(`次数已用完（总额度 ${result.max ?? 0} 次）`, "USAGE_EXHAUSTED", {
        max: result.max,
        used: result.used,
        remaining: result.remaining,
      });
    }

    touchDevice(device.id, ctx.ip);
    const fresh = findLicenseById(license.id) ?? license;
    const issued = buildLicenseFile({
      license: fresh,
      productCode: license.product_code,
      deviceId,
      keys: signingKeys(),
    });

    audit({
      actorType: "customer",
      actorId: license.customer_id,
      action: "license.consume",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
      detail: { device_id: deviceId, count, remaining: result.remaining },
    });

    return ok({
      consumed: count,
      remaining: result.remaining,
      max: result.max,
      used: result.used,
      license_file: issued.license_file,
      offline_expires_at: issued.offline_expires_at,
      server_time: new Date().toISOString(),
    });
  });

  /* ---------------------------- 解绑 ---------------------------- */

  post("/api/v1/licenses/release", (ctx) => {
    const licenseKey = needStr(ctx, "license_key", 200);
    const deviceId = needStr(ctx, "device_id", 190);
    const license = findLicenseByKeyHash(sha256hex(licenseKey));
    if (!license) throw notFound("许可证密钥无效", "INVALID_LICENSE_KEY");
    const released = releaseDevice(license.id, deviceId);
    audit({
      actorType: "customer",
      actorId: license.customer_id,
      action: "license.release_device",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
      detail: { device_id: deviceId, released },
    });
    return ok({ released });
  });

  /* ---------------------------- 客户自助 ---------------------------- */

  get("/api/v1/licenses", (ctx) => {
    const customer = requireCustomer(ctx);
    const items = listLicensesByCustomer(customer.id).map((row) => ({
      ...licenseView(row),
      devices: listDevices(row.id).filter((d) => d.status === "active"),
    }));
    return ok({ items, total: items.length });
  });

  get("/api/v1/licenses/:id", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权查看该授权");
    return ok({
      ...licenseView(license),
      devices: listDevices(license.id),
      module_codes: moduleCodesFor(moduleIdsOf(license)),
    });
  });

  /** 客户端丢失本地密钥时，登录后重新签发（旧密钥立即失效） */
  post("/api/v1/licenses/:id/rotate-key", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权操作该授权");
    if (license.status === "revoked") throw locked("授权已被吊销，无法重置密钥", "LICENSE_REVOKED");

    const deviceId = bodyStr(ctx, "device_id", { max: 190 });
    const newKey = generateLicenseKey();
    rotateLicenseKey(license.id, sha256hex(newKey));

    const reloaded = findLicenseById(license.id) as LicenseRow;
    const file = deviceId
      ? buildLicenseFile({
          license: reloaded,
          productCode: license.product_code,
          deviceId,
          keys: signingKeys(),
        })
      : null;

    audit({
      actorType: "customer",
      actorId: customer.id,
      action: "license.rotate_key",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
    });

    return ok({
      license_key: newKey,
      ...(file ? { license_file: file.license_file, offline_expires_at: file.offline_expires_at } : {}),
    });
  });

  /** 客户自助解绑自己的设备（换机时用） */
  post("/api/v1/licenses/:id/devices/:deviceId/release", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权操作该授权");
    const released = releaseDevice(license.id, ctx.params.deviceId);
    audit({
      actorType: "customer",
      actorId: customer.id,
      action: "license.release_device",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
      detail: { device_id: ctx.params.deviceId, released, by: "customer" },
    });
    return ok({ released });
  });

  /**
   * 客户自助：某条授权下的设备与操作记录。
   * 设备与日志都按「同一客户 + 同一软件」返回（和后台口径一致），
   * 但操作人只显示「服务商 / 我」，不暴露内部账号邮箱与 IP。
   */
  get("/api/v1/me/licenses/:id/devices", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权查看该授权");
    return ok({
      license: { id: license.id, license_no: license.license_no },
      group: licenseGroup(license.customer_id, license.product_id),
      devices: listDevicesForGroup(license.customer_id, license.product_id).map((d) => ({
        device_id: d.device_id,
        device_name: d.device_name,
        platform: d.platform,
        status: d.status,
        license_no: d.license_no,
        first_seen_at: d.first_seen_at,
        last_seen_at: d.last_seen_at,
        released_at: d.released_at,
        released_reason: d.released_reason ?? null,
      })),
    });
  });

  get("/api/v1/me/licenses/:id/logs", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权查看该授权");
    const ids = licenseGroupIds(license.customer_id, license.product_id);
    const group = licenseGroup(license.customer_id, license.product_id);
    const noOf = (lid: string) => group.find((g) => g.id === lid)?.license_no ?? null;
    return ok({
      items: listAuditByTargets(ids, 200).map((row) => ({
        at: row.at,
        action: row.action,
        license_no: noOf(row.target_id ?? ""),
        actor: row.actor_type === "customer" ? "我" : row.actor_type === "agent" ? "代理商" : "服务商",
        detail: stripInternalFields(row.detail),
      })),
    });
  });

  /** 客户自助解绑：按设备找，不要求知道它挂在哪条授权下 */
  post("/api/v1/me/devices/:deviceId/release", (ctx) => {
    const customer = requireCustomer(ctx);
    const deviceId = ctx.params.deviceId;
    const rows = listLicensesByCustomer(customer.id);
    const hit = rows
      .map((row) => ({ row, device: findDevice(row.id, deviceId) }))
      .find((x) => x.device && x.device.status === "active");
    if (!hit) throw notFound("找不到这台正在使用的设备", "DEVICE_NOT_BOUND");
    const released = releaseDevice(hit.row.id, deviceId);
    audit({
      actorType: "customer",
      actorId: customer.id,
      action: "license.release_device",
      targetType: "license",
      targetId: hit.row.id,
      ip: ctx.ip,
      detail: { device_id: deviceId, released, by: "customer" },
    });
    return ok({ released, license_no: hit.row.license_no });
  });

  /** 重新拉取当前设备的签名许可证（客户端缓存丢失时用） */
  post("/api/v1/licenses/:id/reenroll", (ctx) => {
    const customer = requireCustomer(ctx);
    const license = findLicenseById(ctx.params.id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    if (license.customer_id !== customer.id) throw forbidden("无权操作该授权");
    const deviceId = needStr(ctx, "device_id", 190);
    const eff = effectiveStatus(license);
    if (eff === "revoked" || eff === "expired" || eff === "suspended") {
      throw locked("授权当前不可用", "LICENSE_LOCKED", { status: eff });
    }
    const device = findDevice(license.id, deviceId);
    if (!device) {
      throw notFound("该设备未绑定此授权，请使用 CDK 重新激活", "DEVICE_NOT_BOUND");
    }
    const issued = buildLicenseFile({
      license,
      productCode: license.product_code,
      deviceId,
      keys: signingKeys(),
    });
    return ok({
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      expires_at: license.expires_at,
    });
  });
}

function badRequestEmail() {
  return badRequest("邮箱格式不正确", "INVALID_EMAIL");
}

/** 客户侧日志：去掉内部字段（邮箱、代理、结算价、IP 由响应层不带出） */
function stripInternalFields(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  let d: unknown;
  try {
    d = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const drop = new Set(["customer", "customer_email", "agent_id", "unit_price", "ip"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    if (v === null || v === "" || typeof v === "object") continue;
    out[k] = v;
  }
  return out;
}
