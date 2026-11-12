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
  unauthorized,
} from "../http.ts";
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
import { findProductById, moduleCodesFor } from "../store/catalog.ts";
import {
  activeDeviceCount,
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
    return ok({ customer: customerView(customer), session: sessionPayload(ctx, customer.id) });
  });

  get("/api/v1/auth/me", (ctx) => {
    const customer = requireCustomer(ctx);
    return ok({
      customer: customerView(customer),
      licenses: listLicensesByCustomer(customer.id).map((row) => ({
        ...licenseView(row),
        devices: listDevices(row.id).filter((d) => d.status === "active"),
      })),
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
