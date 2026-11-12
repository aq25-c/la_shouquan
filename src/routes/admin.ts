/**
 * 管理 API（后台）：
 *   产品/模块维护、客户管理、CDK 批量生成与导出、授权管理与到期控制、审计日志、公钥分发。
 */
import { config } from "../config.ts";
import {
  generateLicenseKey,
  hashPassword,
  randomToken,
  sha256hex,
  verifyPassword,
} from "../crypto.ts";
import {
  badRequest,
  bodyInt,
  bodyStr,
  bodyStrArray,
  checkStrictLimit,
  conflict,
  created,
  forbidden,
  get,
  needInt,
  needStr,
  notFound,
  ok,
  patch,
  post,
  q,
  qInt,
  raw,
  tooMany,
  unauthorized,
  del,
} from "../http.ts";
import type { Ctx } from "../http.ts";
import { adminTtl, grantSession, requireAdmin } from "../auth.ts";
import { currentSession } from "../auth.ts";
import { buildLicenseFile, licenseView } from "../issuer.ts";
import { publicKeyInfo, signingKeys } from "../keys.ts";
import { withTx } from "../db.ts";
import { audit, listAudit } from "../store/audit.ts";
import {
  createAdmin,
  findAdminByEmail,
  findCustomerByEmail,
  findCustomerById,
  listAdmins,
  listCustomers,
  revokeSession,
  revokeSessionsFor,
  touchAdminLogin,
  updateAdminPassword,
  updateCustomer,
} from "../store/accounts.ts";
import {
  createModule,
  createProduct,
  deleteModule,
  deleteProduct,
  findModuleByCode,
  findModuleById,
  findProductByCode,
  findProductById,
  listAllModules,
  listModules,
  listProducts,
  moduleCodesFor,
  updateModule,
  updateProduct,
} from "../store/catalog.ts";
import {
  createCdkBatch,
  createLicense,
  extendLicense,
  expiringLicenses,
  findCdkById,
  findLicenseById,
  listBatches,
  listCdks,
  listDevices,
  listLicenses,
  listLicensesByCustomer,
  moduleIdsOf,
  releaseAllDevices,
  releaseDevice,
  revokeCdk,
  revokeLicense,
  rotateLicenseKey,
  stats,
  updateLicense,
  upsertDevice,
} from "../store/licensing.ts";
import type { LicenseRow } from "../types.ts";
import { DAY, isEmail, normalizeEmail, parseJson, toMs } from "../util.ts";

const P = "/admin/api";

/* ---------------------------- 小工具 ---------------------------- */

function adminView(admin: { id: string; email: string; name: string | null; role: string; status: string; created_at: string; last_login_at: string | null }) {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    status: admin.status,
    created_at: admin.created_at,
    last_login_at: admin.last_login_at,
  };
}

function isoOrNull(ctx: Ctx, name: string): string | null {
  const value = bodyStr(ctx, name, { max: 40 });
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(`参数 ${name} 需要合法的时间格式`, "INVALID_FIELD");
  return new Date(ms).toISOString();
}

function paging(ctx: Ctx): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, qInt(ctx, "page", 1));
  const pageSize = Math.min(200, Math.max(1, qInt(ctx, "page_size", 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function validateModuleIds(productId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const allowed = new Set(listModules(productId).map((m) => m.id));
  const invalid = ids.filter((id) => !allowed.has(id));
  if (invalid.length) {
    throw badRequest("存在不属于该产品的模块", "INVALID_MODULES", { invalid });
  }
  return ids;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // 防 Excel 公式注入
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function slash(ctx: Ctx, name: string): string {
  const value = ctx.params[name];
  if (!value) throw badRequest(`缺少路径参数 ${name}`);
  return value;
}

/* ---------------------------- 路由 ---------------------------- */

export function registerAdminRoutes(): void {
  /* ---------------------------- 登录 / 会话 ---------------------------- */

  post(`${P}/auth/login`, async (ctx) => {
    if (!checkStrictLimit(`admin-login:${ctx.ip}`, 10)) throw tooMany("登录尝试过于频繁，请稍后再试");
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const admin = findAdminByEmail(email);
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      audit({ actorType: "anonymous", actorLabel: email, action: "admin.login_failed", ip: ctx.ip });
      throw unauthorized("邮箱或密码不正确", "INVALID_CREDENTIALS");
    }
    if (admin.status !== "active") throw forbidden("该管理员账号已停用", "ADMIN_DISABLED");
    touchAdminLogin(admin.id);
    const session = grantSession("admin", admin.id, adminTtl(), ctx);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "admin.login",
      ip: ctx.ip,
    });
    return ok({ admin: adminView(admin), token: session.token, expires_at: session.expires_at });
  });

  post(`${P}/auth/logout`, (ctx) => {
    const admin = requireAdmin(ctx);
    const session = currentSession(ctx);
    if (session) revokeSession(session.id);
    audit({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.logout", ip: ctx.ip });
    return ok({ loggedOut: true });
  });

  get(`${P}/auth/me`, (ctx) => {
    const admin = requireAdmin(ctx);
    return ok({ admin: adminView(admin), signing_key: publicKeyInfo(), config: publicConfig() });
  });

  post(`${P}/auth/password`, async (ctx) => {
    const admin = requireAdmin(ctx);
    const current = needStr(ctx, "current_password", 200);
    const next = needStr(ctx, "new_password", 200);
    if (next.length < 8) throw badRequest("新密码至少 8 位", "WEAK_PASSWORD");
    if (!(await verifyPassword(current, admin.password_hash))) {
      throw unauthorized("当前密码不正确", "INVALID_CREDENTIALS");
    }
    updateAdminPassword(admin.id, await hashPassword(next));
    revokeSessionsFor("admin", admin.id);
    audit({ actorType: "admin", actorId: admin.id, actorLabel: admin.email, action: "admin.password_change", ip: ctx.ip });
    return ok({ changed: true, relogin: true });
  });

  get(`${P}/admins`, (ctx) => {
    requireAdmin(ctx);
    return ok({ items: listAdmins().map(adminView) });
  });

  post(`${P}/admins`, async (ctx) => {
    const actor = requireAdmin(ctx);
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });
    if (!isEmail(email)) throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    if (password.length < 10) throw badRequest("管理员密码至少 10 位", "WEAK_PASSWORD");
    if (findAdminByEmail(email)) throw conflict("该邮箱已存在管理员", "EMAIL_TAKEN");
    const createdAdmin = await createAdmin({ email, passwordHash: await hashPassword(password), name, role: "admin" });
    audit({
      actorType: "admin",
      actorId: actor.id,
      actorLabel: actor.email,
      action: "admin.create",
      targetType: "admin",
      targetId: createdAdmin.id,
      ip: ctx.ip,
      detail: { email },
    });
    return created({ admin: adminView(createdAdmin) });
  });

  /* ---------------------------- 概览 ---------------------------- */

  get(`${P}/overview`, (ctx) => {
    requireAdmin(ctx);
    return ok({
      stats: stats(),
      expiring: expiringLicenses(14, 12),
      recent_licenses: listLicenses({ page: 1, pageSize: 8 }).items,
      config: publicConfig(),
    });
  });

  /* ---------------------------- 产品与模块 ---------------------------- */

  get(`${P}/products`, (ctx) => {
    requireAdmin(ctx);
    return ok({ items: listProducts() });
  });

  post(`${P}/products`, (ctx) => {
    const admin = requireAdmin(ctx);
    const code = needStr(ctx, "code", 64).toLowerCase();
    const name = needStr(ctx, "name", 120);
    const description = bodyStr(ctx, "description", { max: 1000 });
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      throw badRequest("产品编码只能是小写字母、数字、- 和 _（1~64 位）", "INVALID_CODE");
    }
    if (findProductByCode(code)) throw conflict("产品编码已存在", "CODE_TAKEN");
    const product = createProduct({ code, name, description });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "product.create",
      targetType: "product",
      targetId: product.id,
      ip: ctx.ip,
      detail: { code, name },
    });
    return created({ product });
  });

  patch(`${P}/products/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    const patchData: Record<string, string> = {};
    const name = bodyStr(ctx, "name", { max: 120 });
    if (name) patchData.name = name;
    const description = bodyStr(ctx, "description", { max: 1000 });
    if (description !== null) patchData.description = description;
    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "disabled"].includes(status)) throw badRequest("status 只能是 active / disabled");
      patchData.status = status;
    }
    const product = updateProduct(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "product.update",
      targetType: "product",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ product });
  });

  del(`${P}/products/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const product = findProductById(id);
    if (!product) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    const licenseCount = listLicenses({ productId: id, page: 1, pageSize: 1 }).total;
    const cdkCount = listCdks({ productId: id, page: 1, pageSize: 1 }).total;
    if (licenseCount > 0 || cdkCount > 0) {
      throw conflict("该产品已有授权或 CDK，不能删除（可改为停用）", "PRODUCT_IN_USE", {
        licenses: licenseCount,
        cdks: cdkCount,
      });
    }
    deleteProduct(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "product.delete",
      targetType: "product",
      targetId: id,
      ip: ctx.ip,
      detail: { code: product.code },
    });
    return ok({ deleted: true });
  });

  get(`${P}/products/:id/modules`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    return ok({ items: listModules(id) });
  });

  post(`${P}/products/:id/modules`, (ctx) => {
    const admin = requireAdmin(ctx);
    const productId = slash(ctx, "id");
    const product = findProductById(productId);
    if (!product) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    const code = needStr(ctx, "code", 64).toLowerCase();
    const name = needStr(ctx, "name", 120);
    const description = bodyStr(ctx, "description", { max: 1000 });
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(code)) {
      throw badRequest("模块编码只能是小写字母、数字、- _ .", "INVALID_CODE");
    }
    if (findModuleByCode(productId, code)) throw conflict("该产品下已存在同名模块编码", "CODE_TAKEN");
    const module = createModule({ productId, code, name, description });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "module.create",
      targetType: "module",
      targetId: module.id,
      ip: ctx.ip,
      detail: { product: product.code, code, name },
    });
    return created({ module });
  });

  get(`${P}/modules`, (ctx) => {
    requireAdmin(ctx);
    const codes = new Map(listProducts().map((p) => [p.id, p.code]));
    return ok({
      items: listAllModules().map((m) => ({ ...m, product_code: codes.get(m.product_id) ?? null })),
    });
  });

  patch(`${P}/modules/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findModuleById(id)) throw notFound("模块不存在", "MODULE_NOT_FOUND");
    const patchData: Record<string, string> = {};
    const name = bodyStr(ctx, "name", { max: 120 });
    if (name) patchData.name = name;
    const description = bodyStr(ctx, "description", { max: 1000 });
    if (description !== null) patchData.description = description;
    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "disabled"].includes(status)) throw badRequest("status 只能是 active / disabled");
      patchData.status = status;
    }
    const module = updateModule(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "module.update",
      targetType: "module",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ module });
  });

  del(`${P}/modules/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findModuleById(id)) throw notFound("模块不存在", "MODULE_NOT_FOUND");
    deleteModule(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "module.delete",
      targetType: "module",
      targetId: id,
      ip: ctx.ip,
    });
    return ok({ deleted: true });
  });

  /* ---------------------------- CDK ---------------------------- */

  post(`${P}/cdks/generate`, (ctx) => {
    const admin = requireAdmin(ctx);
    const productId = needStr(ctx, "product_id", 64);
    const product = findProductById(productId);
    if (!product) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    const moduleIds = validateModuleIds(productId, bodyStrArray(ctx, "module_ids") ?? []);
    const days = needInt(ctx, "days", { min: 1, max: 3650 });
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 }) ?? 1;
    const count = needInt(ctx, "count", { min: 1, max: 5000 });
    const note = bodyStr(ctx, "note", { max: 500 });
    const redeemBefore = isoOrNull(ctx, "redeem_before");

    const result = withTx(() =>
      createCdkBatch({
        productId,
        moduleIds,
        days,
        seats,
        count,
        note,
        expiresAt: redeemBefore,
        createdBy: admin.id,
      }),
    );

    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "cdk.generate",
      targetType: "cdk_batch",
      targetId: result.batch.id,
      ip: ctx.ip,
      detail: { product: product.code, count, days, seats, modules: moduleIds.length },
    });

    return created({
      batch: result.batch,
      codes: result.codes,
      csv: buildCdkCsv(result.codes, product.code, days, seats, moduleCodesFor(moduleIds), note),
      product: { code: product.code, name: product.name },
      module_codes: moduleCodesFor(moduleIds),
    });
  });

  get(`${P}/cdks`, (ctx) => {
    requireAdmin(ctx);
    const { page, pageSize } = paging(ctx);
    const result = listCdks({
      productId: q(ctx, "product_id"),
      batchId: q(ctx, "batch_id"),
      status: q(ctx, "status"),
      q: q(ctx, "q"),
      page,
      pageSize,
    });
    return ok({
      items: result.items.map((row) => ({ ...row, module_ids: parseJson<string[]>(row.module_ids, []) })),
      total: result.total,
      page,
      page_size: pageSize,
    });
  });

  get(`${P}/cdk-batches`, (ctx) => {
    requireAdmin(ctx);
    return ok({ items: listBatches(q(ctx, "product_id")) });
  });

  post(`${P}/cdks/:id/revoke`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const cdk = findCdkById(id);
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    if (cdk.status !== "unused") throw conflict("只有未使用的 CDK 可以作废", "CDK_NOT_UNUSED");
    const reason = bodyStr(ctx, "reason", { max: 500 });
    revokeCdk(id, reason);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "cdk.revoke",
      targetType: "cdk",
      targetId: id,
      ip: ctx.ip,
      detail: { code: cdk.code, reason },
    });
    return ok({ revoked: true });
  });

  /** CSV 导出：按批次或按当前筛选条件 */
  get(`${P}/cdks/export`, (ctx) => {
    requireAdmin(ctx);
    const batchId = q(ctx, "batch_id");
    const productId = q(ctx, "product_id");
    const status = q(ctx, "status");
    const rows = listCdks({ batchId, productId, status, page: 1, pageSize: 5000 }).items;
    const filename = batchId ? `cdks-batch-${batchId}.csv` : "cdks.csv";
    const csv = `\ufeff${["code", "product", "days", "seats", "modules", "note", "created_at"]
      .join(",")}\n${rows
      .map((r) =>
        [
          csvCell(r.code),
          csvCell(r.product_code),
          csvCell(r.days),
          csvCell(r.seats),
          csvCell(moduleCodesFor(parseJson<string[]>(r.module_ids, [])).join("|")),
          csvCell(r.note ?? ""),
          csvCell(r.created_at),
        ].join(","),
      )
      .join("\n")}\n`;
    return raw(csv, "text/csv; charset=utf-8", 200, {
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  });

  /* ---------------------------- 客户 ---------------------------- */

  get(`${P}/customers`, (ctx) => {
    requireAdmin(ctx);
    const { page, pageSize } = paging(ctx);
    const result = listCustomers({ q: q(ctx, "q"), status: q(ctx, "status"), page, pageSize });
    return ok({
      items: result.items.map((row) => ({ ...row, password_hash: undefined })),
      total: result.total,
      page,
      page_size: pageSize,
    });
  });

  get(`${P}/customers/:id`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    const customer = findCustomerById(id);
    if (!customer) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    const licenses = listLicensesByCustomer(id).map((row) => ({
      ...licenseView(row),
      devices: listDevices(row.id),
    }));
    return ok({ customer: { ...customer, password_hash: undefined }, licenses });
  });

  patch(`${P}/customers/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findCustomerById(id)) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    const patchData: Record<string, string | null> = {};
    const name = bodyStr(ctx, "name", { max: 120 });
    if (name) patchData.name = name;
    const company = bodyStr(ctx, "company", { max: 190 });
    if (company !== null) patchData.company = company;
    const phone = bodyStr(ctx, "phone", { max: 40 });
    if (phone !== null) patchData.phone = phone;
    const note = bodyStr(ctx, "note", { max: 1000 });
    if (note !== null) patchData.note = note;
    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "disabled"].includes(status)) throw badRequest("status 只能是 active / disabled");
      patchData.status = status;
    }
    const customer = updateCustomer(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "customer.update",
      targetType: "customer",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ customer: customer ? { ...customer, password_hash: undefined } : null });
  });

  post(`${P}/customers/:id/reset-password`, async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const customer = findCustomerById(id);
    if (!customer) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    const password = randomToken(9);
    updateCustomer(id, { password_hash: await hashPassword(password) });
    revokeSessionsFor("customer", id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "customer.reset_password",
      targetType: "customer",
      targetId: id,
      ip: ctx.ip,
    });
    return ok({ password, note: "临时密码只显示一次，请转交客户后让其修改" });
  });

  /* ---------------------------- 授权 ---------------------------- */

  get(`${P}/licenses`, (ctx) => {
    requireAdmin(ctx);
    const { page, pageSize } = paging(ctx);
    const expiring = q(ctx, "expiring_within_days");
    const result = listLicenses({
      q: q(ctx, "q"),
      status: q(ctx, "status"),
      productId: q(ctx, "product_id"),
      customerId: q(ctx, "customer_id"),
      expiringWithinDays: expiring === null ? null : Number.parseInt(expiring, 10),
      page,
      pageSize,
    });
    return ok({
      items: result.items.map((row) => ({
        ...licenseView(row),
        module_ids: parseJson<string[]>(row.module_ids, []),
      })),
      total: result.total,
      page,
      page_size: pageSize,
    });
  });

  get(`${P}/licenses/:id`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const customer = findCustomerById(license.customer_id);
    return ok({
      license: { ...licenseView(license), module_ids: parseJson<string[]>(license.module_ids, []) },
      devices: listDevices(id),
      module_codes: moduleCodesFor(moduleIdsOf(license)),
      customer: customer ? { ...customer, password_hash: undefined } : null,
    });
  });

  patch(`${P}/licenses/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");

    const patchData: Record<string, string | number | null> = {};
    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "suspended", "revoked"].includes(status)) {
        throw badRequest("status 只能是 active / suspended / revoked", "INVALID_FIELD");
      }
      patchData.status = status;
    }
    const expiresAt = isoOrNull(ctx, "expires_at");
    if (expiresAt) patchData.expires_at = expiresAt;
    const startsAt = isoOrNull(ctx, "starts_at");
    if (startsAt) patchData.starts_at = startsAt;
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 });
    if (seats !== null) patchData.seats = seats;
    const graceDays = bodyInt(ctx, "offline_grace_days", { min: 0, max: 365 });
    if (graceDays !== null) patchData.offline_grace_days = graceDays;
    const note = bodyStr(ctx, "note", { max: 1000 });
    if (note !== null) patchData.note = note;
    const moduleIds = bodyStrArray(ctx, "module_ids");
    if (moduleIds) {
      validateModuleIds(license.product_id, moduleIds);
      patchData.module_ids = JSON.stringify(moduleIds);
    }

    const updated = updateLicense(id, patchData as Partial<LicenseRow>);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.update",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ license: updated ? { ...licenseView(updated), module_ids: moduleIdsOf(updated) } : null });
  });

  post(`${P}/licenses/:id/extend`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const days = needInt(ctx, "days", { min: -3650, max: 3650 });
    const fromNow = Boolean(ctx.body.from_now);
    const updated = extendLicense(id, days, fromNow);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.extend",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: { days, from_now: fromNow, new_expires_at: updated?.expires_at },
    });
    return ok({
      license: updated ? { ...licenseView(updated), module_ids: moduleIdsOf(updated) } : null,
    });
  });

  post(`${P}/licenses/:id/revoke`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findLicenseById(id)) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const reason = bodyStr(ctx, "reason", { max: 500 });
    const updated = revokeLicense(id, reason);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.revoke",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: { reason },
    });
    return ok({ license: updated ? { ...licenseView(updated), module_ids: moduleIdsOf(updated) } : null });
  });

  post(`${P}/licenses/:id/reset-devices`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findLicenseById(id)) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const count = releaseAllDevices(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.reset_devices",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: { released: count },
    });
    return ok({ released: count });
  });

  /** 后台解绑单个设备（释放席位，便于客户换机） */
  post(`${P}/licenses/:id/devices/:deviceId/release`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const deviceId = slash(ctx, "deviceId");
    if (!findLicenseById(id)) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const released = releaseDevice(id, deviceId);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.release_device",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: { device_id: deviceId, released, by: "admin" },
    });
    return ok({ released });
  });

  post(`${P}/licenses/:id/rotate-key`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findLicenseById(id)) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const newKey = generateLicenseKey();
    rotateLicenseKey(id, sha256hex(newKey));
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.rotate_key",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
    });
    return ok({ license_key: newKey, note: "新密钥只显示一次，旧密钥立即失效" });
  });

  /** 后台代为签发：给指定设备（默认第一台活跃设备）重新下发许可证文件 */
  post(`${P}/licenses/:id/reissue`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const requested = bodyStr(ctx, "device_id", { max: 190 });
    const devices = listDevices(id).filter((d) => d.status === "active");
    const deviceId = requested ?? devices[0]?.device_id ?? null;
    if (!deviceId) throw conflict("该授权还没有绑定设备，请让客户端先激活", "NO_ACTIVE_DEVICE");
    if (requested && !devices.some((d) => d.device_id === requested)) {
      throw conflict("该设备未绑定此授权", "DEVICE_NOT_BOUND");
    }
    const issued = buildLicenseFile({
      license,
      productCode: license.product_code,
      deviceId,
      keys: signingKeys(),
    });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.reissue",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: { device_id: deviceId },
    });
    return ok({
      license_file: issued.license_file,
      license_payload: issued.payload,
      offline_expires_at: issued.offline_expires_at,
      device_id: deviceId,
    });
  });

  /** 手动开通授权（不走 CDK）：给已有客户直接开一个授权 */
  post(`${P}/licenses`, (ctx) => {
    const admin = requireAdmin(ctx);
    const productId = needStr(ctx, "product_id", 64);
    const product = findProductById(productId);
    if (!product) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");

    const customerIdInput = bodyStr(ctx, "customer_id", 64);
    const emailInput = bodyStr(ctx, "customer_email", 190);
    let customer = customerIdInput ? findCustomerById(customerIdInput) : null;
    if (!customer && emailInput) customer = findCustomerByEmail(normalizeEmail(emailInput));
    if (!customer) {
      throw notFound("客户不存在，请先创建客户或用邮箱开通", "CUSTOMER_NOT_FOUND");
    }

    const moduleIds = validateModuleIds(productId, bodyStrArray(ctx, "module_ids") ?? []);
    const days = needInt(ctx, "days", { min: 1, max: 3650 });
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 }) ?? 1;
    const note = bodyStr(ctx, "note", { max: 500 });
    const licenseKey = generateLicenseKey();

    const license = withTx(() =>
      createLicense({
        customerId: customer.id,
        productId,
        cdkId: null,
        moduleIds,
        seats,
        days,
        keyHash: sha256hex(licenseKey),
        note: note ?? "后台手动开通",
      }),
    );

    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.create",
      targetType: "license",
      targetId: license.id,
      ip: ctx.ip,
      detail: { product: product.code, customer: customer.email, days, seats },
    });

    return created({
      license: { ...licenseView(license), module_ids: moduleIdsOf(license) },
      license_key: licenseKey,
      days_left: Math.max(0, Math.floor((toMs(license.expires_at) - Date.now() + 60_000) / DAY)),
    });
  });

  /* ---------------------------- 审计与密钥 ---------------------------- */

  get(`${P}/audit`, (ctx) => {
    requireAdmin(ctx);
    const { page, pageSize } = paging(ctx);
    const result = listAudit({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      action: q(ctx, "action"),
      actorType: q(ctx, "actor_type"),
      q: q(ctx, "q"),
    });
    return ok({ items: result.items, total: result.total, page, page_size: pageSize });
  });

  get(`${P}/signing-key`, (ctx) => {
    requireAdmin(ctx);
    return ok(publicKeyInfo());
  });

  /** 心跳健康：列出长时间未心跳的授权（运营排查用） */
  get(`${P}/heartbeat-health`, (ctx) => {
    requireAdmin(ctx);
    const { items } = listLicenses({ status: "active", page: 1, pageSize: 200 });
    const threshold = Date.now() - config.heartbeatStaleHours * 3_600_000;
    const stale = items.filter((row) => {
      const last = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : 0;
      return last < threshold;
    });
    return ok({ stale, threshold_hours: config.heartbeatStaleHours });
  });
}

/* ---------------------------- 辅助 ---------------------------- */

function publicConfig() {
  return {
    offline_grace_days: config.offlineGraceDays,
    heartbeat_interval_hours: config.heartbeatIntervalHours,
    heartbeat_stale_hours: config.heartbeatStaleHours,
  };
}

function buildCdkCsv(
  codes: string[],
  productCode: string,
  days: number,
  seats: number,
  moduleCodes: string[],
  note: string | null,
): string {
  const header = "code,product,days,seats,modules,note";
  const rows = codes.map((code) =>
    [csvCell(code), csvCell(productCode), csvCell(days), csvCell(seats), csvCell(moduleCodes.join("|")), csvCell(note ?? "")].join(","),
  );
  return `\ufeff${header}\n${rows.join("\n")}\n`;
}


