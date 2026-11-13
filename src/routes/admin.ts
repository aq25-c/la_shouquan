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
import { adminTtl, grantSession, requireAdmin, requireOwner, requireStaff } from "../auth.ts";
import { currentSession } from "../auth.ts";
import {
  AGENT_PERMISSIONS,
  FEATURES,
  MENUS,
  parsePermissions,
  serializePermissions,
} from "../permissions.ts";
import type { StaffRole, TermType } from "../permissions.ts";
import { buildLicenseFile, licenseView } from "../issuer.ts";
import { publicKeyInfo, signingKeys } from "../keys.ts";
import { withTx } from "../db.ts";
import { audit, listAudit, listAuditByTarget } from "../store/audit.ts";
import { buildApiDocs } from "../api-spec.ts";
import {
  checkAgentScope,
  deletePrice,
  findPrice,
  listPrices,
  parseAgentProfile,
  resolveUnitPrice,
  serializeAgentProfile,
  totalPrice,
  upsertPrice,
} from "../store/prices.ts";
import { normalizeTerm } from "../permissions.ts";
import {
  channelReferences,
  channelSummary,
  consumeCredit,
  createChannel,
  deleteChannel,
  findChannelByCode,
  findChannelById,
  listChannels,
  consumeBalance,
  rechargeBalance,
  rechargeChannel,
  updateChannel,
} from "../store/channels.ts";
import {
  createAdmin,
  createCustomer,
  deleteStaff,
  findAdminByEmail,
  findAdminById,
  findCustomerByEmail,
  findCustomerById,
  listAdmins,
  listCustomers,
  revokeSession,
  revokeSessionsFor,
  touchAdminLogin,
  updateAdminPassword,
  updateCustomer,
  updateStaff,
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
  activeDeviceCount,
  adjustCustomerExpiry,
  createCdkBatch,
  createLicense,
  effectiveStatus,
  extendLicense,
  expiringLicenses,
  findCdkById,
  findDevice,
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
import { getTrialConfig, setTrialConfig, trialSummary } from "../store/trials.ts";
import type { TrialConfig } from "../store/trials.ts";
import type { LicenseRow } from "../types.ts";
import { DAY, isEmail, normalizeEmail, parseJson, toMs } from "../util.ts";

const P = "/admin/api";

/* ---------------------------- 小工具 ---------------------------- */

function adminView(admin: AdminRow) {
  const role = (["owner", "staff", "agent"].includes(admin.role) ? admin.role : "owner") as StaffRole;
  const perms = parsePermissions(admin.permissions, role);
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role,
    status: admin.status,
    created_at: admin.created_at,
    last_login_at: admin.last_login_at,
    /** 目录权限（可见页面）与功能权限（可执行操作） */
    permissions: perms,
    channel_id: admin.channel_id ?? null,
    channel_name: admin.channel_id ? (findChannelById(admin.channel_id)?.name ?? null) : null,
    /** 代理可售范围（非代理为 null） */
    agent_profile: role === "agent" ? parseAgentProfile(admin.agent_profile) : null,
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
      channels: channelSummary(),
      expiring: expiringLicenses(14, 12),
      recent_licenses: listLicenses({ page: 1, pageSize: 8 }).items,
      config: publicConfig(),
    });
  });

  /* ---------------------------- 员工与代理 ---------------------------- */

  /** 权限可选项：前端据此渲染"目录权限 / 软件功能"勾选清单 */
  get(`${P}/staff/options`, (ctx) => {
    requireStaff(ctx);
    return ok({
      menus: MENUS,
      features: FEATURES,
      roles: [
        { id: "staff", label: "员工" },
        { id: "agent", label: "代理" },
      ],
      agent_permissions: AGENT_PERMISSIONS,
    });
  });

  get(`${P}/staff`, (ctx) => {
    requireStaff(ctx);
    return ok({ items: listAdmins().map(adminView) });
  });

  post(`${P}/staff`, async (ctx) => {
    const actor = requireOwner(ctx).admin;
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });
    const roleInput = bodyStr(ctx, "role", { max: 20 }) ?? "staff";

    if (!["staff", "agent"].includes(roleInput)) throw badRequest("role 只能是 staff / agent", "INVALID_FIELD");
    if (!isEmail(email)) throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    if (password.length < 8) throw badRequest("密码至少 8 位", "WEAK_PASSWORD");
    if (findAdminByEmail(email)) throw conflict("该邮箱已存在", "EMAIL_TAKEN");

    let channelId: string | null = null;
    let agentProfile = "{}";
    if (roleInput === "agent") {
      const channelInput = bodyStr(ctx, "channel_id", 64);
      if (!channelInput) throw badRequest("代理必须绑定一个渠道", "MISSING_FIELD", { field: "channel_id" });
      const channel = findChannelById(channelInput);
      if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
      channelId = channel.id;
      // 可售范围：产品 / 模块 / 卡类型（空数组表示不限制）
      agentProfile = serializeAgentProfile({
        product_ids: bodyStrArray(ctx, "product_ids") ?? [],
        module_ids: bodyStrArray(ctx, "module_ids") ?? [],
        term_types: bodyStrArray(ctx, "term_types") ?? [],
      });
    }

    // 代理权限固定（只看自己的卡密），员工按勾选配置
    const permissions =
      roleInput === "agent"
        ? serializePermissions(AGENT_PERMISSIONS)
        : serializePermissions({
            menus: bodyStrArray(ctx, "menus") ?? [],
            features: bodyStrArray(ctx, "features") ?? [],
          });

    const newStaff = await createAdmin({
      email,
      passwordHash: await hashPassword(password),
      name,
      role: roleInput,
      permissions,
      channelId,
      agentProfile,
    });

    audit({
      actorType: "admin",
      actorId: actor.id,
      actorLabel: actor.email,
      action: "staff.create",
      targetType: "staff",
      targetId: newStaff.id,
      ip: ctx.ip,
      detail: { email, role: roleInput, channel_id: channelId },
    });
    return created({ staff: adminView(newStaff) });
  });

  patch(`${P}/staff/:id`, async (ctx) => {
    const actor = requireOwner(ctx).admin;
    const id = slash(ctx, "id");
    const target = findAdminById(id);
    if (!target) throw notFound("员工不存在", "STAFF_NOT_FOUND");
    if (target.role === "owner" && target.id !== actor.id) {
      throw forbidden("不能修改其他超级管理员", "FORBIDDEN_OWNER");
    }

    const patchData: Record<string, string | null> = {};
    const name = bodyStr(ctx, "name", { max: 120 });
    if (name !== null) patchData.name = name;

    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "disabled"].includes(status)) {
        throw badRequest("status 只能是 active / disabled", "INVALID_FIELD");
      }
      patchData.status = status;
    }

    const password = bodyStr(ctx, "password", 200);
    if (password) {
      if (password.length < 8) throw badRequest("密码至少 8 位", "WEAK_PASSWORD");
      patchData.password_hash = await hashPassword(password);
    }

    if (target.role === "agent") {
      const channelInput = bodyStr(ctx, "channel_id", 64);
      if (channelInput) {
        const channel = findChannelById(channelInput);
        if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
        patchData.channel_id = channel.id;
      }
      const productIds = bodyStrArray(ctx, "product_ids");
      const moduleIds = bodyStrArray(ctx, "module_ids");
      const termTypes = bodyStrArray(ctx, "term_types");
      if (productIds || moduleIds || termTypes) {
        const current = parseAgentProfile(target.agent_profile);
        patchData.agent_profile = serializeAgentProfile({
          product_ids: productIds ?? current.product_ids,
          module_ids: moduleIds ?? current.module_ids,
          term_types: termTypes ?? current.term_types,
        });
      }
    } else if (target.role !== "owner") {
      const menus = bodyStrArray(ctx, "menus");
      const features = bodyStrArray(ctx, "features");
      if (menus || features) {
        const current = parsePermissions(target.permissions, "staff");
        patchData.permissions = serializePermissions({
          menus: menus ?? current.menus,
          features: features ?? current.features,
        });
      }
    }

    const updated = updateStaff(id, patchData);
    // 停用或重置密码后，强制该账号下线
    if (patchData.status === "disabled" || patchData.password_hash) {
      revokeSessionsFor("admin", id);
    }
    audit({
      actorType: "admin",
      actorId: actor.id,
      actorLabel: actor.email,
      action: "staff.update",
      targetType: "staff",
      targetId: id,
      ip: ctx.ip,
      detail: { status: patchData.status ?? null, permissions: patchData.permissions ?? null },
    });
    return ok({ staff: updated ? adminView(updated) : null });
  });

  delete(`${P}/staff/:id`, (ctx) => {
    const actor = requireOwner(ctx).admin;
    const id = slash(ctx, "id");
    const target = findAdminById(id);
    if (!target) throw notFound("员工不存在", "STAFF_NOT_FOUND");
    if (target.role === "owner") throw forbidden("不能删除超级管理员", "FORBIDDEN_OWNER");
    if (target.id === actor.id) throw forbidden("不能删除自己", "FORBIDDEN_SELF");
    deleteStaff(id);
    revokeSessionsFor("admin", id);
    audit({
      actorType: "admin",
      actorId: actor.id,
      actorLabel: actor.email,
      action: "staff.delete",
      targetType: "staff",
      targetId: id,
      ip: ctx.ip,
      detail: { email: target.email },
    });
    return ok({ deleted: true });
  });

  /* ---------------------------- 渠道 / 分销 ---------------------------- */

  get(`${P}/channels`, (ctx) => {
    requireAdmin(ctx);
    return ok({
      items: listChannels({ q: q(ctx, "q"), status: q(ctx, "status") }),
      summary: channelSummary(),
    });
  });

  post(`${P}/channels`, (ctx) => {
    const admin = requireAdmin(ctx);
    const code = needStr(ctx, "code", 64).toLowerCase();
    const name = needStr(ctx, "name", 120);
    const contact = bodyStr(ctx, "contact", { max: 120 });
    const phone = bodyStr(ctx, "phone", { max: 40 });
    const email = bodyStr(ctx, "email", { max: 190 });
    const note = bodyStr(ctx, "note", { max: 1000 });
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      throw badRequest("渠道编码只能是小写字母、数字、- 和 _（1~64 位）", "INVALID_CODE");
    }
    if (findChannelByCode(code)) throw conflict("渠道编码已存在", "CODE_TAKEN");
    const channel = createChannel({ code, name, contact, phone, email, note });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.create",
      targetType: "channel",
      targetId: channel.id,
      ip: ctx.ip,
      detail: { code, name },
    });
    return created({ channel });
  });

  get(`${P}/channels/:id`, (ctx) => {
    requireAdmin(ctx);
    const channel = findChannelById(slash(ctx, "id"));
    if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
    return ok({ channel });
  });

  patch(`${P}/channels/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findChannelById(id)) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");

    const patchData: Record<string, string> = {};
    const name = bodyStr(ctx, "name", { max: 120 });
    if (name) patchData.name = name;
    const contact = bodyStr(ctx, "contact", { max: 120 });
    if (contact !== null) patchData.contact = contact;
    const phone = bodyStr(ctx, "phone", { max: 40 });
    if (phone !== null) patchData.phone = phone;
    const email = bodyStr(ctx, "email", { max: 190 });
    if (email !== null) patchData.email = email;
    const note = bodyStr(ctx, "note", { max: 1000 });
    if (note !== null) patchData.note = note;
    const status = bodyStr(ctx, "status", { max: 20 });
    if (status) {
      if (!["active", "disabled"].includes(status)) {
        throw badRequest("status 只能是 active / disabled", "INVALID_FIELD");
      }
      patchData.status = status;
    }

    const channel = updateChannel(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.update",
      targetType: "channel",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ channel });
  });

  del(`${P}/channels/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const channel = findChannelById(id);
    if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
    const refs = channelReferences(id);
    if (refs.batches > 0 || refs.licenses > 0) {
      throw conflict("该渠道已有 CDK 批次或授权，不能删除（建议改为停用）", "CHANNEL_IN_USE", refs);
    }
    deleteChannel(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.delete",
      targetType: "channel",
      targetId: id,
      ip: ctx.ip,
      detail: { code: channel.code },
    });
    return ok({ deleted: true });
  });

  /** 给渠道（代理）充值卡密余额；amount 可为负用于人工修正 */
  post(`${P}/channels/:id/credit`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const channel = findChannelById(id);
    if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
    const amount = needInt(ctx, "amount", { min: -1_000_000, max: 1_000_000 });
    if (amount === 0) throw badRequest("充值/扣减数量不能为 0", "INVALID_FIELD");

    const updated = rechargeChannel(id, amount);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.recharge",
      targetType: "channel",
      targetId: id,
      ip: ctx.ip,
      detail: { amount, credit_after: updated?.credit ?? null },
    });
    return ok({
      channel: updated
        ? {
            id: updated.id,
            code: updated.code,
            name: updated.name,
            credit: updated.credit,
          }
        : null,
    });
  });

  /* ---------------------------- 卡密价格 ---------------------------- */

  get(`${P}/prices`, (ctx) => {
    requireStaff(ctx);
    return ok({ items: listPrices(q(ctx, "product_id")) });
  });

  /** 设价：module_id 留空 = 该产品的默认价（对所有模块生效），填了则覆盖该模块 */
  post(`${P}/prices`, (ctx) => {
    const admin = requireAdmin(ctx);
    const productId = needStr(ctx, "product_id", 64);
    if (!findProductById(productId)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");

    const moduleId = bodyStr(ctx, "module_id", 64);
    if (moduleId) {
      const mod = findModuleById(moduleId);
      if (!mod || mod.product_id !== productId) throw badRequest("模块不属于该产品", "INVALID_MODULE");
    }

    const termType = needStr(ctx, "term_type", 10);
    if (!["hour", "day", "month", "year", "count"].includes(termType)) {
      throw badRequest("term_type 只能是 hour/day/month/year/count", "INVALID_FIELD");
    }
    const unitPrice = needInt(ctx, "unit_price", { min: 0, max: 100_000_000 });

    const price = upsertPrice({ productId, moduleId: moduleId ?? null, termType, unitPrice });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "price.upsert",
      targetType: "price",
      targetId: price.id,
      ip: ctx.ip,
      detail: { product_id: productId, module_id: moduleId, term_type: termType, unit_price: unitPrice },
    });
    return ok({ price });
  });

  delete(`${P}/prices/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findPrice(id)) throw notFound("价格不存在", "PRICE_NOT_FOUND");
    deletePrice(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "price.delete",
      targetType: "price",
      targetId: id,
      ip: ctx.ip,
    });
    return ok({ deleted: true });
  });

  /* ---------------------------- 代理余额 ---------------------------- */

  /** 单渠道充值/扣减余额（单位：分） */
  post(`${P}/channels/:id/balance`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findChannelById(id)) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
    const amount = needInt(ctx, "amount", { min: -100_000_000, max: 100_000_000 });
    if (amount === 0) throw badRequest("金额不能为 0", "INVALID_FIELD");

    const updated = rechargeBalance(id, amount);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.recharge_balance",
      targetType: "channel",
      targetId: id,
      ip: ctx.ip,
      detail: { amount, balance_after: updated?.balance ?? null },
    });
    return ok({
      channel: updated
        ? { id: updated.id, code: updated.code, name: updated.name, balance: updated.balance }
        : null,
    });
  });

  /** 一键批量充值：不传 channel_ids 则作用于全部渠道（统一配置） */
  post(`${P}/channels/batch-balance`, (ctx) => {
    const admin = requireAdmin(ctx);
    const amount = needInt(ctx, "amount", { min: 1, max: 100_000_000 });
    const ids = bodyStrArray(ctx, "channel_ids");
    const targets = ids && ids.length ? ids : listChannels().map((c) => c.id);

    let updated = 0;
    for (const id of targets) {
      if (rechargeBalance(id, amount)) updated += 1;
    }
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "channel.batch_recharge",
      targetType: "channel",
      targetId: "*",
      ip: ctx.ip,
      detail: { amount, updated },
    });
    return ok({ updated, amount });
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
    // v4：支持按天/月/年/小时/次数；未传 term 时沿用 days
    const termTypeInput = bodyStr(ctx, "term_type", 20);
    const termValueInput = bodyInt(ctx, "term_value", { min: 1, max: 100000 });
    const days = termValueInput ?? needInt(ctx, "days", { min: 1, max: 3650 });
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 }) ?? 1;
    const count = needInt(ctx, "count", { min: 1, max: 5000 });
    const note = bodyStr(ctx, "note", { max: 500 });
    const redeemBefore = isoOrNull(ctx, "redeem_before");

    // v2：渠道与结算单价（单价单位：分）
    const channelInput = bodyStr(ctx, "channel_id", 64);
    const unitPrice = bodyInt(ctx, "unit_price", { min: 0, max: 100_000_000 }) ?? 0;

    // v4：代理只能给自己的渠道生成，且受"卡密余额"限制
    const staffCtx = requireStaff(ctx);
    let channelId: string | null = null;
    if (staffCtx.isAgent) {
      if (!staffCtx.channelId) throw forbidden("代理账号未绑定渠道", "AGENT_NO_CHANNEL");
      channelId = staffCtx.channelId;
    } else if (channelInput) {
      const channel = findChannelById(channelInput);
      if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
      channelId = channel.id;
    }

    const result = withTx(() => {
      // 代理生成：校验可售范围 → 按价格扣账户余额（金额）
      if (staffCtx.isAgent) {
        if (!channelId) throw forbidden("代理账号未绑定渠道", "AGENT_NO_CHANNEL");
        const profile = parseAgentProfile(staffCtx.admin.agent_profile);
        const termInfo = normalizeTerm(termTypeInput ?? null, termValueInput ?? null, days);
        const scope = checkAgentScope(profile, {
          productId,
          moduleIds,
          termType: termInfo.termType,
        });
        if (!scope.ok) throw forbidden(scope.message, scope.code);

        const unit = resolveUnitPrice(productId, moduleIds, termInfo.termType);
        if (unit === null) {
          throw conflict("该产品 / 卡类型尚未配置价格，请联系管理员", "PRICE_NOT_CONFIGURED", {
            product_id: productId,
            term_type: termInfo.termType,
          });
        }
        const amount = totalPrice(unit, termInfo.termValue, count);
        const paid = consumeBalance(channelId, amount);
        if (!paid.ok) {
          throw conflict(
            `账户余额不足（当前 ¥${(paid.balance / 100).toFixed(2)}，本次需要 ¥${(amount / 100).toFixed(2)}）`,
            "BALANCE_INSUFFICIENT",
            { balance: paid.balance, needed: amount },
          );
        }
      } else {
        // 管理员代生成：属于管理赠送，不扣代理商任何额度（不扣金额、不扣张数）
        // 代理自行生成时才按价格从余额扣费（见上面的分支）
      }
      return createCdkBatch({
        productId,
        moduleIds,
        days,
        seats,
        count,
        note,
        expiresAt: redeemBefore,
        createdBy: admin.id,
        channelId,
        unitPrice,
        termType: (termTypeInput ?? "day") as TermType,
        termValue: termValueInput ?? undefined,
      });
    });

    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "cdk.generate",
      targetType: "cdk_batch",
      targetId: result.batch.id,
      ip: ctx.ip,
      detail: {
        product: product.code,
        count,
        days,
        seats,
        modules: moduleIds.length,
        channel_id: channelId,
        unit_price: unitPrice,
      },
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
    const staffCtx = requireStaff(ctx);
    const { page, pageSize } = paging(ctx);
    const result = listCdks({
      productId: q(ctx, "product_id"),
      batchId: q(ctx, "batch_id"),
      status: q(ctx, "status"),
      q: q(ctx, "q"),
      // 代理只能看到自己渠道的卡密
      channelId: staffCtx.isAgent ? staffCtx.channelId : q(ctx, "channel_id"),
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

  /** 后台手动新增客户（不依赖客户端注册） */
  post(`${P}/customers`, async (ctx) => {
    const admin = requireAdmin(ctx);
    const emailInput = bodyStr(ctx, "email", 190);
    const password = bodyStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });
    const company = bodyStr(ctx, "company", { max: 190 });
    const phone = bodyStr(ctx, "phone", { max: 40 });
    const note = bodyStr(ctx, "note", { max: 1000 });

    const email = emailInput ? normalizeEmail(emailInput) : null;
    if (email && !isEmail(email)) throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    if (email && findCustomerByEmail(email)) throw conflict("该邮箱已存在", "EMAIL_TAKEN");
    if (password && password.length < 8) throw badRequest("密码至少 8 位", "WEAK_PASSWORD");

    const customer = createCustomer({
      email,
      passwordHash: password ? await hashPassword(password) : null,
      name,
      company,
      phone,
      note,
    });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "customer.create",
      targetType: "customer",
      targetId: customer.id,
      ip: ctx.ip,
      detail: { email, has_password: Boolean(password) },
    });
    return created({ customer: { ...customer, password_hash: undefined } });
  });

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

  /** 按客户批量调整到期时间（可只调整指定授权） */
  post(`${P}/customers/:id/adjust-expiry`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const customer = findCustomerById(id);
    if (!customer) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");

    const days = bodyInt(ctx, "days", { min: -3650, max: 3650 });
    const expiresAt = isoOrNull(ctx, "expires_at");
    const licenseIds = bodyStrArray(ctx, "license_ids");
    if (days === null && !expiresAt) {
      throw badRequest("请提供 days（按天调整）或 expires_at（指定到期时间）", "MISSING_FIELD");
    }

    const result = withTx(() =>
      adjustCustomerExpiry(id, {
        days: days ?? undefined,
        expiresAt: expiresAt ?? undefined,
        licenseIds: licenseIds ?? undefined,
      }),
    );

    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "customer.adjust_expiry",
      targetType: "customer",
      targetId: id,
      ip: ctx.ip,
      detail: { days, expires_at: expiresAt, license_ids: licenseIds, updated: result.updated },
    });

    return ok({
      updated: result.updated,
      licenses: result.items.map((row) => ({
        ...licenseView(row),
        module_ids: moduleIdsOf(row),
      })),
    });
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
      channelId: q(ctx, "channel_id"),
      kind: q(ctx, "kind"),
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
    const termTypeInput = bodyStr(ctx, "term_type", 20);
    const termValueInput = bodyInt(ctx, "term_value", { min: 1, max: 100000 });
    const days = termValueInput ?? needInt(ctx, "days", { min: 1, max: 3650 });
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 }) ?? 1;
    const note = bodyStr(ctx, "note", { max: 500 });

    // v2：可选归属渠道与结算单价（单价单位：分）
    const channelInput = bodyStr(ctx, "channel_id", 64);
    const unitPrice = bodyInt(ctx, "unit_price", { min: 0, max: 100_000_000 }) ?? 0;
    let channelId: string | null = null;
    if (channelInput) {
      const channel = findChannelById(channelInput);
      if (!channel) throw notFound("渠道不存在", "CHANNEL_NOT_FOUND");
      channelId = channel.id;
    }

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
        channelId,
        unitPrice,
        termType: (termTypeInput ?? "day") as TermType,
        termValue: termValueInput ?? undefined,
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
      detail: {
        product: product.code,
        customer: customer.email,
        days,
        seats,
        channel_id: channelId,
        unit_price: unitPrice,
      },
    });

    return created({
      license: { ...licenseView(license), module_ids: moduleIdsOf(license) },
      license_key: licenseKey,
      days_left: Math.max(0, Math.floor((toMs(license.expires_at) - Date.now() + 60_000) / DAY)),
    });
  });

  /** 后台把新设备绑定到已有授权（换机/重装）：到期时间沿用首次激活，不重置 */
  post(`${P}/licenses/:id/devices`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");

    const deviceId = needStr(ctx, "device_id", 190);
    const deviceName = bodyStr(ctx, "device_name", { max: 190 });
    const platform = bodyStr(ctx, "platform", { max: 64 });

    const eff = effectiveStatus(license);
    if (eff === "revoked") throw locked("授权已被吊销，无法绑定设备", "LICENSE_REVOKED");
    if (eff === "expired") throw locked("授权已到期，续费后才能绑定设备", "LICENSE_EXPIRED");

    const existing = findDevice(id, deviceId);
    if (!existing || existing.status !== "active") {
      const active = activeDeviceCount(id);
      if (active >= license.seats) {
        throw conflict("席位已满，请先解绑其它设备或扩容", "SEAT_LIMIT", {
          seats: license.seats,
          active_devices: active,
        });
      }
    }

    const device = upsertDevice({ licenseId: id, deviceId, deviceName, platform, ip: ctx.ip });
    // 关键：只绑定设备，绝不改动 starts_at / expires_at —— 到期时间从首次激活起算
    const fresh = findLicenseById(id) as LicenseRow;
    const issued = buildLicenseFile({
      license: fresh,
      productCode: license.product_code,
      deviceId,
      keys: signingKeys(),
    });

    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.bind_device",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: {
        device_id: deviceId,
        rebind: Boolean(existing),
        expires_at: fresh.expires_at,
        not_reset: true,
      },
    });

    return ok({
      device,
      license_file: issued.license_file,
      offline_expires_at: issued.offline_expires_at,
      starts_at: fresh.starts_at,
      expires_at: fresh.expires_at,
      seats: fresh.seats,
      active_devices: activeDeviceCount(id),
    });
  });

  /** 授权的设备绑定/解绑历史 + 相关审计记录 */
  get(`${P}/licenses/:id/events`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findLicenseById(id)) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    return ok({
      devices: listDevices(id),
      audits: listAuditByTarget(id, 100),
    });
  });

  /* ---------------------------- 试用配置 ---------------------------- */

  get(`${P}/settings/trial`, (ctx) => {
    requireAdmin(ctx);
    return ok({ config: getTrialConfig(), summary: trialSummary() });
  });

  patch(`${P}/settings/trial`, (ctx) => {
    const admin = requireAdmin(ctx);
    const patchData: Partial<TrialConfig> = {};

    if (ctx.body.enabled !== undefined) patchData.enabled = ctx.body.enabled === true;

    const mode = bodyStr(ctx, "mode", 10);
    if (mode) {
      if (!["day", "count"].includes(mode)) throw badRequest("mode 只能是 day / count", "INVALID_FIELD");
      patchData.mode = mode as "day" | "count";
    }

    const value = bodyInt(ctx, "value", { min: 1, max: 3650 });
    if (value !== null) patchData.value = value;

    const days = bodyInt(ctx, "days", { min: 1, max: 365 });
    if (days !== null) patchData.days = days;

    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 });
    if (seats !== null) patchData.seats = seats;

    const maxPer = bodyInt(ctx, "max_per_customer", { min: 1, max: 20 });
    if (maxPer !== null) patchData.max_per_customer = maxPer;

    // offline_grace_days 传 null = 取消覆盖（回落到全局默认）
    if (ctx.body.offline_grace_days === null) {
      patchData.offline_grace_days = null;
    } else {
      const graceDays = bodyInt(ctx, "offline_grace_days", { min: 0, max: 365 });
      if (graceDays !== null) patchData.offline_grace_days = graceDays;
    }

    // product_id 传 null / 空字符串 = 取消产品限定（允许试用任意在售产品）
    if (ctx.body.product_id !== undefined) {
      const raw = bodyStr(ctx, "product_id", 64);
      if (raw) {
        const product = findProductById(raw);
        if (!product) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
        patchData.product_id = product.id;
      } else {
        patchData.product_id = null;
      }
    }

    const moduleIds = bodyStrArray(ctx, "module_ids");
    if (moduleIds) {
      if (patchData.product_id) validateModuleIds(patchData.product_id, moduleIds);
      patchData.module_ids = moduleIds;
    }

    const updated = setTrialConfig(patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "trial.config_update",
      targetType: "settings",
      targetId: "trial",
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ config: updated });
  });

  /** 生成前的实时估价：不扣费、不核销，仅供前端显示「本次需 ¥X / 当前余额 ¥Y」 */
  post(`${P}/cdks/estimate`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const productId = needStr(ctx, "product_id", 64);
    const moduleIds = bodyStrArray(ctx, "module_ids") ?? [];
    const termType = (bodyStr(ctx, "term_type", 20) ?? "day") as TermType;
    const termValue = needInt(ctx, "term_value", { min: 1, max: 100000 });
    const count = bodyInt(ctx, "count", { min: 1, max: 5000 }) ?? 1;

    const unit = resolveUnitPrice(productId, moduleIds, termType);
    const total = unit === null ? null : totalPrice(unit, termValue, count);

    // 只有代理需要付费；管理员生成属于赠送，不显示金额
    const payable = staffCtx.isAgent;
    const channel = payable && staffCtx.channelId ? findChannelById(staffCtx.channelId) : null;
    const balance = channel ? channel.balance : null;

    return ok({
      payable,
      unit_price: unit,
      total_price: total,
      term_type: termType,
      term_value: termValue,
      count,
      balance,
      sufficient: !payable || (total !== null && balance !== null && balance >= total),
      priced: unit !== null,
    });
  });

  /** API 文档：路由骨架来自真实路由表，描述来自 api-spec.ts */
  get(`${P}/docs`, (ctx) => {
    requireAdmin(ctx);
    return ok(buildApiDocs());
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


