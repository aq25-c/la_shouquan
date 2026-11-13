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
  bodyInt,
  bodyStr,
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
import { audit } from "../store/audit.ts";
import {
  createCustomer,
  findCustomerByEmail,
  findCustomerById,
  touchCustomerLogin,
} from "../store/accounts.ts";
import { findProductByCode, findProductById, listModules, listProducts, moduleCodesFor } from "../store/catalog.ts";
import { canStartTrial, getProductTrialConfig, getTrialConfig, trialCountFor } from "../store/trials.ts";
import {
  activeDeviceCount,
  consumeUsage,
  effectiveStatus,
  findCdkByCode,
  findDevice,
  findLicenseById,
  findLicenseByKeyHash,
  listDevices,
  listLicensesByCustomer,
  markCdkUsed,
  moduleIdsOf,
  releaseDevice,
  rotateLicenseKey,
  touchDevice,
  touchLicenseHeartbeat,
  upsertDevice,
  createLicense,
} from "../store/licensing.ts";
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
    if (password.length < 8) {
      throw conflict("密码至少 8 位", "WEAK_PASSWORD");
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

  /* ---------------------------- 试用 ---------------------------- */

  /** 试用配置（公开）：客户端可据此决定是否引导用户自助试用 */
  get("/api/v1/trial/info", () => {
    const trialConfig = getTrialConfig();
    const product = trialConfig.product_id ? findProductById(trialConfig.product_id) : null;
    return ok({
      enabled: trialConfig.enabled,
      days: trialConfig.days,
      seats: trialConfig.seats,
      max_per_customer: trialConfig.max_per_customer,
      product: product ? { code: product.code, name: product.name } : null,
      module_codes: trialConfig.module_ids.length ? moduleCodesFor(trialConfig.module_ids) : [],
    });
  });

  /** 我的试用情况（需客户登录） */
  get("/api/v1/trial/status", (ctx) => {
    const customer = requireCustomer(ctx);
    const trialConfig = getTrialConfig();
    const items = listProducts()
      .filter((p) => p.status === "active")
      .map((p) => {
        const used = trialCountFor(customer.id, p.id);
        return {
          product: { code: p.code, name: p.name },
          used,
          remaining: Math.max(0, trialConfig.max_per_customer - used),
        };
      });
    return ok({
      enabled: trialConfig.enabled,
      days: trialConfig.days,
      seats: trialConfig.seats,
      max_per_customer: trialConfig.max_per_customer,
      items,
    });
  });

  /** 自助开通试用：按试用配置生成 trial 授权并绑定当前设备 */
  post("/api/v1/trial/start", (ctx) => {
    const customer = requireCustomer(ctx);
    const deviceId = needStr(ctx, "device_id", 190);
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 });
    const productCode = bodyStr(ctx, "product_code", { max: 64 });

    const trialGlobal = getTrialConfig();

    let product = trialGlobal.product_id ? findProductById(trialGlobal.product_id) : null;
    if (!product && productCode) product = findProductByCode(productCode);
    if (!product) {
      const candidate = listProducts().find((p) => p.status === "active");
      product = candidate ? findProductById(candidate.id) : null;
    }
    if (!product) throw notFound("没有可试用的产品", "PRODUCT_NOT_FOUND");
    if (product.status !== "active") throw conflict("该产品当前不开放试用", "PRODUCT_DISABLED");

    // v6：试用参数按产品配置，未配置的字段回落全局
    const trialConfig = getProductTrialConfig(product.id);

    const guard = canStartTrial(customer.id, product.id);
    if (!guard.ok) throw locked(guard.message, guard.code);

    // 试用模块：配置里指定则用它，否则给该产品全部模块
    const moduleIds = trialConfig.module_ids.length
      ? trialConfig.module_ids
      : listModules(product.id).map((m) => m.id);

    const licenseKey = generateLicenseKey();
    const license = withTx(() =>
      createLicense({
        customerId: customer.id,
        productId: product.id,
        cdkId: null,
        moduleIds,
        seats: trialConfig.seats,
        // v4：试用支持"试用几天"或"试用几次"
        days: trialConfig.mode === "day" ? trialConfig.value : 30,
        termType: trialConfig.mode,
        termValue: trialConfig.value,
        offlineGraceDays: trialConfig.offline_grace_days ?? undefined,
        keyHash: sha256hex(licenseKey),
        note: trialConfig.mode === "day" ? `试用 ${trialConfig.value} 天` : `试用 ${trialConfig.value} 次`,
        kind: "trial",
        source: "trial",
      }),
    );

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
      detail: { product: product.code, days: trialConfig.days, device_id: deviceId },
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
      days: cdk.days,
      seats: cdk.seats,
      redeem_before: cdk.expires_at,
      usable: cdk.status === "unused" && (!cdk.expires_at || Date.parse(cdk.expires_at) > Date.now()),
    });
  });

  /* ---------------------------- 激活 ---------------------------- */

  post("/api/v1/licenses/activate", async (ctx) => {
    const cdkInput = needStr(ctx, "cdk", 64);
    const deviceId = needStr(ctx, "device_id", 190);
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 });

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
          if (!password || password.length < 8) throw conflict("新账号密码至少 8 位", "WEAK_PASSWORD");
          plan = { kind: "new", email, passwordHash: await hashPassword(password), name };
        }
      } else {
        // 匿名激活：建一条不可登录的客户记录，后续可用 CDK 号找服务商迁移
        plan = { kind: "new", email: null, passwordHash: null, name: name ?? "匿名激活" };
      }
    }

    const licenseKey = generateLicenseKey();
    const outcome = withTx(() => {
      const customerId =
        plan.kind === "existing"
          ? plan.customerId
          : createCustomer({
              email: plan.email,
              passwordHash: plan.passwordHash,
              name: plan.name,
            }).id;

      const license = createLicense({
        customerId,
        productId: cdk.product_id,
        cdkId: cdk.id,
        moduleIds: moduleIdsOf(cdk),
        seats: cdk.seats,
        days: cdk.days,
        keyHash: sha256hex(licenseKey),
        note: `CDK ${cdk.code}`,
        // v2：渠道与单价从 CDK 批次继承下来，供后台按渠道统计营收
        channelId: cdk.channel_id,
        unitPrice: cdk.unit_price,
        // v4：计费类型从 CDK 继承（天/月/年/小时/次数）
        termType: (cdk.term_type ?? "day") as "hour" | "day" | "month" | "year" | "count",
        termValue: cdk.term_value ?? cdk.days,
      });
      if (!markCdkUsed(cdk.id, customerId, license.id)) {
        throw conflict("该 CDK 刚刚已被使用，请更换", "CDK_ALREADY_USED");
      }
      const device = upsertDevice({
        licenseId: license.id,
        deviceId,
        deviceName,
        platform,
        ip: ctx.ip,
      });
      return { customerId, license, deviceId: device.device_id };
    });

    const issued = buildLicenseFile({
      license: outcome.license,
      productCode: product.code,
      deviceId,
      keys: signingKeys(),
    });

    audit({
      actorType: "customer",
      actorId: outcome.customerId,
      action: "license.activate",
      targetType: "license",
      targetId: outcome.license.id,
      ip: ctx.ip,
      detail: { cdk: cdk.code, product: product.code, device_id: deviceId },
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

    const device = findDevice(license.id, deviceId);
    if (!device || device.status !== "active") {
      throw notFound("该设备未绑定此授权，请重新激活", "DEVICE_NOT_BOUND");
    }

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
    const eff = effectiveStatus(license);
    if (eff === "expired") {
      throw locked("授权已到期，请续费后重试", "LICENSE_EXPIRED", {
        expires_at: license.expires_at,
      });
    }
    if (eff === "pending") {
      throw locked("授权尚未生效", "LICENSE_NOT_STARTED", { starts_at: license.starts_at });
    }

    touchDevice(device.id, ctx.ip);
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
      const active = activeDeviceCount(license.id);
      if (active >= license.seats) {
        throw conflict("席位已满，请先在其他设备上解绑或联系服务商扩容", "SEAT_LIMIT", {
          seats: license.seats,
          active_devices: active,
        });
      }
      upsertDevice({ licenseId: license.id, deviceId, deviceName, platform, ip: ctx.ip });
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

    const license = findLicenseByKeyHash(sha256hex(licenseKey));
    if (!license) throw notFound("许可证密钥无效", "INVALID_LICENSE_KEY");

    if (license.term_type !== "count" || license.max_usages === null) {
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

    const result = consumeUsage(license.id, count);
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
