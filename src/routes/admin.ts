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
import { adminTtl, grantSession, requireAdmin, requireFeature, requireOwner, requireStaff } from "../auth.ts";
import type { StaffContext } from "../auth.ts";
import { currentSession } from "../auth.ts";
import {
  AGENT_GRANTABLE,
  AGENT_PERMISSIONS,
  FEATURES,
  MENUS,
  parsePermissions,
  serializePermissions,
} from "../permissions.ts";
import type { StaffRole, TermType } from "../permissions.ts";
import { buildLicenseFile, licenseView } from "../issuer.ts";
import { publicKeyInfo, signingKeys } from "../keys.ts";
import { db, withTx } from "../db.ts";
import { audit, listAudit, listAuditByTarget, listAuditByTargets } from "../store/audit.ts";
import { buildApiDocs } from "../api-spec.ts";
import { batchCdks, batchLicenses, cardValue } from "../store/batch.ts";
import { changeBalance, ledgerSummary, listLedger } from "../store/ledger.ts";
import type { BatchOptions } from "../store/batch.ts";

/** 代理只能看/碰自己出的卡密（管理员不受限） */
function assertAgentCanSeeCdk(
  staffCtx: { isAgent: boolean; agentId: string | null },
  cdk: { agent_id: string | null },
): void {
  if (!staffCtx.isAgent) return;
  if (cdk.agent_id !== (staffCtx.agentId ?? "__none__")) {
    throw forbidden("该卡密不属于你的代理", "FORBIDDEN_AGENT_SCOPE");
  }
}

/** 代理只能看/碰自己名下客户的授权（管理员不受限） */
function assertAgentCanSeeLicense(staffCtx: StaffContext, license: { customer_id: string }): void {
  if (!staffCtx.isAgent) return;
  if (!customerBelongsToAgent(license.customer_id, staffCtx.agentId ?? "")) {
    throw forbidden("该授权不属于你的代理", "FORBIDDEN_AGENT_SCOPE");
  }
}

/** 每分钟每个 IP 的后台登录尝试上限（测试里可调高，避免整库用例被判成暴力破解） */
const ADMIN_LOGIN_LIMIT = Math.max(1, Number(process.env.ADMIN_LOGIN_RATE_LIMIT ?? 10) || 10);
import { checkCustomerPurgeable, customerPurgeSnapshot, purgeCustomer } from "../store/purge.ts";
import {
  DEFAULT_ADMIN_PATH,
  getAdminPath,
  isDefaultAdminPath,
  isUsableAdminPath,
  setAdminPath,
} from "../store/entry.ts";
import {
  availableTiers,
  billableUnits,
  checkAgentScope,
  deletePrice,
  findPrice,
  listPrices,
  parseAgentProfile,
  resolvePrice,
  resolveUnitPrice,
  seatFactor,
  serializeAgentProfile,
  totalPrice,
  upsertPrice,
} from "../store/prices.ts";
import { REMOTE_VAR_KINDS, deleteVar, listVars, upsertVar, varView } from "../store/vars.ts";
import type { RemoteVarKind } from "../store/vars.ts";
import { normalizeTerm } from "../permissions.ts";
import {
  agentHome,
  agentReferences,
  agentSummary,
  consumeCredit,
  createAgent,
  deleteAgent,
  findAgentByCode,
  findAgentById,
  listAgents,
  consumeBalance,
  rechargeBalance,
  rechargeAgent,
  updateAgent,
} from "../store/agents.ts";
import {
  createAdmin,
  createCustomer,
  deleteStaff,
  deleteAgentAccounts,
  findAdminByEmail,
  findAdminById,
  findCustomerByEmail,
  findCustomerById,
  customerBelongsToAgent,
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
  listDevicesForGroup,
  seatUsageForProduct,
  licenseGroupIds,
  licenseGroup,
  listLicenses,
  listLicensesByCustomer,
  listLicenseModules,
  setLicenseModuleExpiry,
  syncLicenseModules,
  syncModuleExpiry,
  moduleIdsOf,
  releaseAllDevices,
  releaseDevice,
  revokeCdk,
  updateCdk,
  deleteCdk,
  revokeLicense,
  rotateLicenseKey,
  stats,
  updateLicense,
  upsertDevice,
} from "../store/licensing.ts";
import {
  clearModuleTrialConfig,
  getModuleTrialConfig,
  getProductTrialConfig,
  getTrialConfig,
  moduleHasTrialConfig,
  setModuleTrialConfig,
  setProductTrialConfig,
  setTrialConfig,
  trialSummary,
} from "../store/trials.ts";
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
    agent_id: admin.agent_id ?? null,
    agent_name: admin.agent_id ? (findAgentById(admin.agent_id)?.name ?? null) : null,
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
    if (!checkStrictLimit(`admin-login:${ctx.ip}`, ADMIN_LOGIN_LIMIT)) throw tooMany("登录尝试过于频繁，请稍后再试");
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
    if (next.length < 6) throw badRequest("新密码至少 6 位", "WEAK_PASSWORD");
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
      agents: agentSummary(),
      expiring: expiringLicenses(14, 12),
      recent_licenses: listLicenses({ page: 1, pageSize: 8 }).items,
      config: publicConfig(),
    });
  });

  /** 代理看自己的余额明细 */
  get(`${P}/agent-home/ledger`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    if (!staffCtx.agentId) throw forbidden("代理账号未绑定代理", "AGENT_NOT_BOUND");
    const { page, pageSize } = paging(ctx);
    const result = listLedger(staffCtx.agentId, { page, pageSize });
    return ok({
      items: result.items,
      total: result.total,
      page,
      page_size: pageSize,
      summary: ledgerSummary(staffCtx.agentId),
    });
  });

  /**
   * 代理首页：只返回「我自己名下」的数据。
   * 管理员带 ?agent_id= 也可以查某个代理的首页。
   */
  get(`${P}/agent-home`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const agentId = staffCtx.isAgent ? staffCtx.agentId : (q(ctx, "agent_id") ?? null);
    if (!agentId) throw forbidden("请指定代理", "AGENT_REQUIRED");
    const data = agentHome(agentId);
    if (!data.agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    return ok(data);
  });

  /** 代理余额明细（管理员查看任意代理） */
  get(`${P}/agents/:id/ledger`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findAgentById(id)) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    const { page, pageSize } = paging(ctx);
    const result = listLedger(id, { page, pageSize });
    return ok({
      items: result.items,
      total: result.total,
      page,
      page_size: pageSize,
      summary: ledgerSummary(id),
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
    // ?role=staff / agent 用于「员工」与「代理」两个页面分别取数
    const role = q(ctx, "role");
    const items = role ? listAdmins().filter((a) => a.role === role) : listAdmins();
    return ok({ items: items.map(adminView) });
  });

  post(`${P}/staff`, async (ctx) => {
    const actor = requireOwner(ctx).admin;
    const email = normalizeEmail(needStr(ctx, "email", 190));
    const password = needStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });
    const roleInput = bodyStr(ctx, "role", { max: 20 }) ?? "staff";

    if (!["staff", "agent"].includes(roleInput)) throw badRequest("role 只能是 staff / agent", "INVALID_FIELD");
    if (!isEmail(email)) throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    if (password.length < 6) throw badRequest("密码至少 6 位", "WEAK_PASSWORD");
    if (findAdminByEmail(email)) throw conflict("该邮箱已存在", "EMAIL_TAKEN");

    let agentId: string | null = null;
    let agentProfile = "{}";
    if (roleInput === "agent") {
      const agentInput = bodyStr(ctx, "agent_id", 64);
      if (!agentInput) throw badRequest("代理必须绑定一个代理", "MISSING_FIELD", { field: "agent_id" });
      const agent = findAgentById(agentInput);
      if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
      agentId = agent.id;
      // 可售范围：产品 / 模块 / 卡类型（空数组表示不限制）
      agentProfile = serializeAgentProfile({
        product_ids: bodyStrArray(ctx, "product_ids") ?? [],
        module_ids: bodyStrArray(ctx, "module_ids") ?? [],
        term_types: bodyStrArray(ctx, "term_types") ?? [],
      });
    }

    // 代理：基础权限固定，只接受白名单里的额外功能（批量操作）；员工按勾选配置
    const permissions =
      roleInput === "agent"
        ? JSON.stringify({
            features: (bodyStrArray(ctx, "features") ?? []).filter((f) => AGENT_GRANTABLE.includes(f)),
          })
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
      agentId,
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
      detail: { email, role: roleInput, agent_id: agentId },
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
      if (password.length < 6) throw badRequest("密码至少 6 位", "WEAK_PASSWORD");
      patchData.password_hash = await hashPassword(password);
    }

    if (target.role === "agent") {
      const agentInput = bodyStr(ctx, "agent_id", 64);
      if (agentInput) {
        const agent = findAgentById(agentInput);
        if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
        patchData.agent_id = agent.id;
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
      // 代理默认权限写死，只有白名单里的功能可以单独开通（目前是批量操作）
      const grantFeatures = bodyStrArray(ctx, "features");
      if (grantFeatures) {
        const granted = grantFeatures.filter((f) => AGENT_GRANTABLE.includes(f));
        patchData.permissions = JSON.stringify({ features: granted });
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

  del(`${P}/staff/:id`, (ctx) => {
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

  /* ---------------------------- 代理 / 分销 ---------------------------- */

  get(`${P}/agents`, (ctx) => {
    requireAdmin(ctx);
    return ok({
      items: listAgents({ q: q(ctx, "q"), status: q(ctx, "status") }),
      summary: agentSummary(),
    });
  });

  post(`${P}/agents`, (ctx) => {
    const admin = requireAdmin(ctx);
    const code = needStr(ctx, "code", 64).toLowerCase();
    const name = needStr(ctx, "name", 120);
    const contact = bodyStr(ctx, "contact", { max: 120 });
    const phone = bodyStr(ctx, "phone", { max: 40 });
    const email = bodyStr(ctx, "email", { max: 190 });
    const note = bodyStr(ctx, "note", { max: 1000 });
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      throw badRequest("代理编码只能是小写字母、数字、- 和 _（1~64 位）", "INVALID_CODE");
    }
    if (findAgentByCode(code)) throw conflict("代理编码已存在", "CODE_TAKEN");
    const agent = createAgent({ code, name, contact, phone, email, note });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.create",
      targetType: "agent",
      targetId: agent.id,
      ip: ctx.ip,
      detail: { code, name },
    });
    return created({ agent });
  });

  get(`${P}/agents/:id`, (ctx) => {
    requireAdmin(ctx);
    const agent = findAgentById(slash(ctx, "id"));
    if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    return ok({ agent });
  });

  patch(`${P}/agents/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findAgentById(id)) throw notFound("代理不存在", "AGENT_NOT_FOUND");

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

    const agent = updateAgent(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.update",
      targetType: "agent",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ agent });
  });

  del(`${P}/agents/:id`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const agent = findAgentById(id);
    if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    const refs = agentReferences(id);
    if (refs.batches > 0 || refs.licenses > 0) {
      throw conflict("该代理已有 CDK 批次或授权，不能删除（建议改为停用）", "AGENT_IN_USE", refs);
    }

    // 级联：删除该代理的登录账号，并让已登录会话立即失效（否则会留下指向已删代理的悬空账号）
    const removedAccounts = deleteAgentAccounts(id);
    for (const acc of removedAccounts) revokeSessionsFor("admin", acc.id);

    deleteAgent(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.delete",
      targetType: "agent",
      targetId: id,
      ip: ctx.ip,
      detail: { code: agent.code, deleted_accounts: removedAccounts.map((a) => a.email) },
    });
    return ok({ deleted: true });
  });

  /** 给代理（代理）充值卡密余额；amount 可为负用于人工修正 */
  post(`${P}/agents/:id/credit`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const agent = findAgentById(id);
    if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    const amount = needInt(ctx, "amount", { min: -1_000_000, max: 1_000_000 });
    if (amount === 0) throw badRequest("充值/扣减数量不能为 0", "INVALID_FIELD");

    const updated = rechargeAgent(id, amount);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.recharge",
      targetType: "agent",
      targetId: id,
      ip: ctx.ip,
      detail: { amount, credit_after: updated?.credit ?? null },
    });
    return ok({
      agent: updated
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
    const staffCtx = requireStaff(ctx);
    // 代理只能看自己的覆盖价；管理员可用 ?agent_id= 查指定代理（留空=全局默认价）
    const agentId = staffCtx.isAgent ? staffCtx.agentId : q(ctx, "agent_id");
    return ok({ items: listPrices(q(ctx, "product_id"), agentId) });
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
    // 每多 1 个席位加价百分比（0~1000，默认 0 表示席位不影响价格）
    const seatRatio = bodyInt(ctx, "seat_ratio", { min: 0, max: 1000 }) ?? 0;

    // agent_id 留空 = 全局默认价；填了 = 该代理的覆盖价
    const agentIdInput = bodyStr(ctx, "agent_id", 64);
    if (agentIdInput && !findAgentById(agentIdInput)) {
      throw notFound("代理不存在", "AGENT_NOT_FOUND");
    }

    const price = upsertPrice({
      agentId: agentIdInput ?? null,
      productId,
      moduleId: moduleId ?? null,
      termType,
      unitPrice,
      seatRatio,
    });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "price.upsert",
      targetType: "price",
      targetId: price.id,
      ip: ctx.ip,
      detail: {
        agent_id: agentIdInput ?? "",
        product_id: productId,
        module_id: moduleId,
        term_type: termType,
        unit_price: unitPrice,
        seat_ratio: seatRatio,
      },
    });
    return ok({ price });
  });

  del(`${P}/prices/:id`, (ctx) => {
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

  /** 单代理充值/扣减余额（单位：分） */
  post(`${P}/agents/:id/balance`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findAgentById(id)) throw notFound("代理不存在", "AGENT_NOT_FOUND");
    const amount = needInt(ctx, "amount", { min: -100_000_000, max: 100_000_000 });
    if (amount === 0) throw badRequest("金额不能为 0", "INVALID_FIELD");

    changeBalance(id, amount, {
      kind: "recharge",
      note: "管理员充值",
      actorType: "admin",
      actorLabel: admin.email,
      ip: ctx.ip,
    });
    const updated = findAgentById(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.recharge_balance",
      targetType: "agent",
      targetId: id,
      ip: ctx.ip,
      detail: { amount, balance_after: updated?.balance ?? null },
    });
    return ok({
      agent: updated
        ? { id: updated.id, code: updated.code, name: updated.name, balance: updated.balance }
        : null,
    });
  });

  /** 一键批量充值：不传 agent_ids 则作用于全部代理（统一配置） */
  post(`${P}/agents/batch-balance`, (ctx) => {
    const admin = requireAdmin(ctx);
    const amount = needInt(ctx, "amount", { min: 1, max: 100_000_000 });
    const ids = bodyStrArray(ctx, "agent_ids");
    const targets = ids && ids.length ? ids : listAgents().map((c) => c.id);

    let updated = 0;
    for (const id of targets) {
      const r = changeBalance(id, amount, {
        kind: "recharge",
        note: "管理员批量充值",
        actorType: "admin",
        actorLabel: admin.email,
        ip: ctx.ip,
      });
      if (r.ok) updated += 1;
    }
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "agent.batch_recharge",
      targetType: "agent",
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

  /** 产品级试用配置：未配置的字段回落全局默认（「产品与模块」里按产品设） */
  get(`${P}/products/:id/trial`, (ctx) => {
    requireStaff(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    return ok({ config: getProductTrialConfig(id), global: getTrialConfig() });
  });

  patch(`${P}/products/:id/trial`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");

    const patchData: Partial<TrialConfig> = {};
    if (ctx.body.enabled !== undefined) patchData.enabled = ctx.body.enabled === true;

    const mode = bodyStr(ctx, "mode", 10);
    if (mode) {
      if (!["day", "count"].includes(mode)) throw badRequest("mode 只能是 day / count", "INVALID_FIELD");
      patchData.mode = mode as "day" | "count";
    }
    const value = bodyInt(ctx, "value", { min: 1, max: 3650 });
    if (value !== null) patchData.value = value;

    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 });
    if (seats !== null) patchData.seats = seats;

    const maxPer = bodyInt(ctx, "max_per_customer", { min: 1, max: 20 });
    if (maxPer !== null) patchData.max_per_customer = maxPer;

    const moduleIds = bodyStrArray(ctx, "module_ids");
    if (moduleIds) {
      validateModuleIds(id, moduleIds);
      patchData.module_ids = moduleIds;
    }

    const updated = setProductTrialConfig(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "product.trial_config",
      targetType: "product",
      targetId: id,
      ip: ctx.ip,
      detail: patchData,
    });
    return ok({ config: updated });
  });

  /* ---------------------------- 远程变量 ---------------------------- */

  /** 远程变量：按产品维护可下发的参数（text / image / json） */
  get(`${P}/products/:id/vars`, (ctx) => {
    requireStaff(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    return ok({ items: listVars(id).map(varView) });
  });

  post(`${P}/products/:id/vars`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");

    const key = needStr(ctx, "key", 64);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
      throw badRequest("key 只能是字母 / 数字 / 下划线 / 点 / 横线", "INVALID_FIELD");
    }
    const kindInput = (bodyStr(ctx, "kind", 20) ?? "text") as RemoteVarKind;
    if (!REMOTE_VAR_KINDS.includes(kindInput)) {
      throw badRequest("kind 只能是 text / image / json", "INVALID_FIELD");
    }
    const value = bodyStr(ctx, "value", { max: 200000 }) ?? "";
    if (kindInput === "json" && value.trim()) {
      try {
        JSON.parse(value);
      } catch {
        throw badRequest("json 类型的 value 必须是合法 JSON", "INVALID_FIELD");
      }
    }
    const description = bodyStr(ctx, "description", { max: 500 });

    const variable = upsertVar({ productId: id, key, kind: kindInput, value, description });
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "var.upsert",
      targetType: "product",
      targetId: id,
      ip: ctx.ip,
      detail: { key, kind: kindInput, bytes: value.length },
    });
    return ok({ variable: varView(variable) });
  });

  del(`${P}/products/:id/vars/:key`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const key = slash(ctx, "key");
    if (!deleteVar(id, key)) throw notFound("变量不存在", "VAR_NOT_FOUND");
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "var.delete",
      targetType: "product",
      targetId: id,
      ip: ctx.ip,
      detail: { key },
    });
    return ok({ deleted: true });
  });

  get(`${P}/products/:id/modules`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    if (!findProductById(id)) throw notFound("产品不存在", "PRODUCT_NOT_FOUND");
    // v12：带上每个模块的试用配置（含从产品/全局继承的结果）
    return ok({
      items: listModules(id).map((m) => ({
        ...m,
        trial: getModuleTrialConfig(m.id),
        trial_custom: moduleHasTrialConfig(m.id),
      })),
    });
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
      items: listAllModules().map((m) => ({
        ...m,
        product_code: codes.get(m.product_id) ?? null,
        trial: getModuleTrialConfig(m.id),
        trial_custom: moduleHasTrialConfig(m.id),
      })),
    });
  });

  /** v12：读取某个模块的试用配置（含继承来源） */
  get(`${P}/modules/:id/trial`, (ctx) => {
    requireAdmin(ctx);
    const id = slash(ctx, "id");
    const mod = findModuleById(id);
    if (!mod) throw notFound("模块不存在", "MODULE_NOT_FOUND");
    return ok({
      module: { id: mod.id, code: mod.code, name: mod.name },
      config: getModuleTrialConfig(id),
      custom: moduleHasTrialConfig(id),
      inherited_from: moduleHasTrialConfig(id) ? "module" : "product/global",
    });
  });

  /** v12：写入模块级试用配置（只覆盖传入字段；传 null 清空该字段回到继承） */
  patch(`${P}/modules/:id/trial`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const mod = findModuleById(id);
    if (!mod) throw notFound("模块不存在", "MODULE_NOT_FOUND");

    const patch: Partial<TrialConfig> = {};
    const enabled = typeof ctx.body.enabled === "boolean" ? ctx.body.enabled : undefined;
    if (enabled !== undefined) patch.enabled = enabled;
    const mode = bodyStr(ctx, "mode", { max: 10 });
    if (mode) {
      if (!["day", "count"].includes(mode)) throw badRequest("mode 只能是 day / count", "INVALID_FIELD");
      patch.mode = mode as "day" | "count";
    }
    const value = bodyInt(ctx, "value", { min: 1, max: 100000 });
    if (value !== null) patch.value = value;
    // 席位是「软件 / 授权」级的（决定同一账号能登录几台设备），模块里不设
    if (ctx.body.seats !== undefined) {
      throw badRequest(
        "席位是软件级的，不能在模块里设置；请到 CDK 或授权里调整",
        "SEATS_NOT_MODULE_LEVEL",
      );
    }
    const maxPerCustomer = bodyInt(ctx, "max_per_customer", { min: 0, max: 100 });
    if (maxPerCustomer !== null) patch.max_per_customer = maxPerCustomer;
    const grace = bodyInt(ctx, "offline_grace_days", { min: 0, max: 365 });
    if (grace !== null) patch.offline_grace_days = grace;

    const config = setModuleTrialConfig(id, patch);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "module.trial_update",
      targetType: "module",
      targetId: id,
      ip: ctx.ip,
      detail: { code: mod.code, ...patch },
    });
    return ok({ config, custom: moduleHasTrialConfig(id) });
  });

  /** v12：清空模块级试用配置，回到继承产品 / 全局 */
  del(`${P}/modules/:id/trial`, (ctx) => {
    const admin = requireAdmin(ctx);
    const id = slash(ctx, "id");
    const mod = findModuleById(id);
    if (!mod) throw notFound("模块不存在", "MODULE_NOT_FOUND");
    clearModuleTrialConfig(id);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "module.trial_reset",
      targetType: "module",
      targetId: id,
      ip: ctx.ip,
      detail: { code: mod.code },
    });
    return ok({ config: getModuleTrialConfig(id), custom: false });
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

    // v2：归属代理。结算单价不再由前端传（输入框已取消），一律取定价表
    const agentInput = bodyStr(ctx, "agent_id", 64);

    // v4：代理只能给自己的代理生成，且受"卡密余额"限制
    const staffCtx = requireStaff(ctx);
    let agentId: string | null = null;
    if (staffCtx.isAgent) {
      if (!staffCtx.agentId) throw forbidden("代理账号未绑定代理", "AGENT_NOT_BOUND");
      agentId = staffCtx.agentId;
    } else if (agentInput) {
      const agent = findAgentById(agentInput);
      if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
      agentId = agent.id;
    }

    const termInfo = normalizeTerm(termTypeInput ?? null, termValueInput ?? null, days);
    // 结算单价一律取定价表（代理覆盖价 → 全局价），前端传什么都不认
    const priced = resolvePrice(productId, moduleIds, termInfo.termType, agentId);
    const unitPrice = priced?.unit_price ?? 0;
    const seatRatio = priced?.seat_ratio ?? 100;
    // 单张卡的价值（退/补差都以它为准），总扣费 = 单卡价 × 张数
    const perCard = priced ? totalPrice(unitPrice, termInfo.termValue, 1, seats, seatRatio) : 0;
    const amount = perCard * count;

    const result = withTx(() => {
      // 代理生成：校验可售范围 → 按价格扣账户余额（金额）
      if (staffCtx.isAgent) {
        if (!agentId) throw forbidden("代理账号未绑定代理", "AGENT_NOT_BOUND");
        const profile = parseAgentProfile(staffCtx.admin.agent_profile);
        const scope = checkAgentScope(profile, {
          productId,
          moduleIds,
          termType: termInfo.termType,
        });
        if (!scope.ok) throw forbidden(scope.message, scope.code);

        if (!priced) {
          throw conflict("该产品 / 卡类型尚未配置价格，请联系管理员", "PRICE_NOT_CONFIGURED", {
            product_id: productId,
            term_type: termInfo.termType,
          });
        }
        const paid = changeBalance(agentId, -amount, {
          kind: "consume",
          refType: "batch",
          refLabel: `${product.code} · ${termInfo.termValue}${{ hour: "小时", day: "天", month: "月", year: "年", count: "次" }[termInfo.termType]} × ${count} 张`,
          note: `生成卡密 ${count} 张`,
          actorType: staffCtx.isAgent ? "agent" : "admin",
          actorLabel: admin.email,
          ip: ctx.ip,
        });
        if (!paid.ok) {
          throw conflict(
            `账户余额不足（当前 ¥${(paid.balance / 100).toFixed(2)}，本次需要 ¥${(amount / 100).toFixed(2)}）`,
            "BALANCE_INSUFFICIENT",
            { balance: paid.balance, needed: amount },
          );
        }
      } else {
        // 管理员代生成：属于管理赠送，不扣代理商任何额度（不扣金额、不扣张数）
        // 仍按定价表记录结算单价，方便统计营收
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
        agentId,
        unitPrice,
        termType: (termTypeInput ?? "day") as TermType,
        termValue: termValueInput ?? undefined,
        // 代理生成才记实付；管理员赠送为 0（删卡/改卡都不涉及钱）
        paidPerCard: staffCtx.isAgent ? perCard : 0,
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
        agent_id: agentId,
        unit_price: unitPrice,
        seat_ratio: seatRatio,
        amount,
      },
    });

    return created({
      batch: result.batch,
      codes: result.codes,
      csv: buildCdkCsv(result.codes, product.code, termInfo.days, seats, moduleCodesFor(moduleIds), note, termInfo),
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
      // 代理只能看到自己代理的卡密（没绑代理的账号看到空，而不是全部）
      agentId: staffCtx.isAgent ? (staffCtx.agentId ?? "__none__") : q(ctx, "agent_id"),
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
    const staffCtx = requireStaff(ctx);
    return ok({
      items: listBatches(q(ctx, "product_id"), staffCtx.isAgent ? (staffCtx.agentId ?? "__none__") : null),
    });
  });

  /** CDK 详情：含产品、模块（名称）、绑定客户与批次 */
  get(`${P}/cdks/export`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const batchId = q(ctx, "batch_id");
    const productId = q(ctx, "product_id");
    const status = q(ctx, "status");
    const rows = listCdks({
      batchId,
      productId,
      status,
      agentId: staffCtx.isAgent ? (staffCtx.agentId ?? "__none__") : null,
      page: 1,
      pageSize: 5000,
    }).items;
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

  get(`${P}/cdks/:id`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const id = slash(ctx, "id");
    const cdk = findCdkById(id);
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    assertAgentCanSeeCdk(staffCtx, cdk);
    const product = findProductById(cdk.product_id);
    const customer = cdk.customer_id ? findCustomerById(cdk.customer_id) : null;
    // 归属：卡属于哪个代理（生成时定的）；已激活的话再给出授权当前的归属
    const cdkAgent = cdk.agent_id ? findAgentById(cdk.agent_id) : null;
    const lic = cdk.license_id ? findLicenseById(cdk.license_id) : null;
    const licAgent = lic?.agent_id ? findAgentById(lic.agent_id) : null;
    return ok({
      cdk: { ...cdk, module_ids: parseJson<string[]>(cdk.module_ids, []) },
      agent: cdkAgent ? { id: cdkAgent.id, code: cdkAgent.code, name: cdkAgent.name, unit_price: cdk.unit_price } : null,
      license_agent: licAgent ? { id: licAgent.id, code: licAgent.code, name: licAgent.name } : null,
      license_agent_is_direct: Boolean(lic && !lic.agent_id),
      product: product ? { id: product.id, code: product.code, name: product.name } : null,
      modules: moduleIdsOf(cdk).map((mid) => {
        const m = findModuleById(mid);
        return { id: mid, code: m?.code ?? mid, name: m?.name ?? mid };
      }),
      customer: customer ? { id: customer.id, email: customer.email, name: customer.name } : null,
      activated: cdk.status === "used" || Boolean(cdk.customer_id),
    });
  });

  /** 修改 CDK：只有未激活的卡可以改（模块至少保留 1 个） */
  patch(`${P}/cdks/:id`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    const cdk = findCdkById(id);
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    assertAgentCanSeeCdk(staffCtx, cdk);
    if (cdk.status === "used" || cdk.customer_id) {
      throw conflict("该 CDK 已被激活，不能修改", "CDK_ACTIVATED");
    }

    const patchData: Parameters<typeof updateCdk>[1] = {};
    const moduleIds = bodyStrArray(ctx, "module_ids");
    if (moduleIds) {
      if (!moduleIds.length) throw badRequest("请至少保留一个模块", "MISSING_FIELD", { field: "module_ids" });
      validateModuleIds(cdk.product_id, moduleIds);
      patchData.moduleIds = moduleIds;
    }
    if (ctx.body.expires_at !== undefined) {
      const expiresAt = isoOrNull(ctx, "expires_at");
      patchData.expiresAt = expiresAt; // null = 取消兑换期限
    }
    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 });
    if (seats !== null) patchData.seats = seats;
    const note = bodyStr(ctx, "note", { max: 500 });
    if (note !== null) patchData.note = note;
    const termType = bodyStr(ctx, "term_type", 20);
    if (termType) {
      if (!["hour", "day", "month", "year", "count"].includes(termType)) {
        throw badRequest("term_type 只能是 hour/day/month/year/count", "INVALID_FIELD");
      }
      patchData.termType = termType as TermType;
    }
    const termValue = bodyInt(ctx, "term_value", { min: 1, max: 100000 });
    if (termValue !== null) patchData.termValue = termValue;

    // 代理改卡：按「新价值 − 实付」结算差价（1 天换 1 个月必须补钱）
    // 赠送卡实付 0，改它不收费
    let settleDiff = 0;
    if (staffCtx.isAgent && staffCtx.agentId && Number(cdk.paid_amount ?? 0) > 0) {
      const value = cardValue(
        staffCtx.agentId,
        cdk.product_id,
        patchData.moduleIds ?? parseJson<string[]>(cdk.module_ids, []),
        patchData.termType ?? cdk.term_type ?? "day",
        patchData.termValue ?? cdk.term_value ?? cdk.days,
        patchData.seats ?? cdk.seats,
      );
      if (value === null) {
        throw conflict("该卡类型还没有定价，不能改；请联系管理员先配价", "PRICE_NOT_CONFIGURED", {
          term_type: patchData.termType ?? cdk.term_type,
        });
      }
      settleDiff = value - Number(cdk.paid_amount ?? 0);
      patchData.paidAmount = value;
      if (settleDiff !== 0) {
        const pay = changeBalance(staffCtx.agentId, -settleDiff, {
          kind: settleDiff > 0 ? "adjust_up" : "adjust_down",
          refType: "cdk",
          refId: id,
          refLabel: cdk.code,
          note: settleDiff > 0 ? "改卡补差价" : "改卡退款",
          actorType: "agent",
          actorLabel: admin.email,
          ip: ctx.ip,
        });
        if (!pay.ok) {
          throw conflict(`余额不足，还差 ¥${(settleDiff / 100).toFixed(2)}`, "BALANCE_INSUFFICIENT", {
            balance: pay.balance,
            needed: settleDiff,
          });
        }
      }
    }

    const updated = updateCdk(id, patchData);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "cdk.update",
      targetType: "cdk",
      targetId: id,
      ip: ctx.ip,
      detail: { code: cdk.code, ...patchData, settle_diff: settleDiff || undefined },
    });
    return ok({
      cdk: { ...updated, module_ids: parseJson<string[]>((updated ?? cdk).module_ids, []) },
      settle_diff: settleDiff || 0,
    });
  });

  /** 删除 CDK：只有未激活的可以删（已作废但没激活的也能删） */
  del(`${P}/cdks/:id`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    const cdk = findCdkById(id);
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    assertAgentCanSeeCdk(staffCtx, cdk);
    if (cdk.status === "used" || cdk.customer_id) {
      throw conflict("该 CDK 已被激活，不能删除（只能作废）", "CDK_ACTIVATED");
    }
    const refund = Number(cdk.paid_amount ?? 0);
    deleteCdk(id);
    // 删卡退钱：按这张卡的实付金额退回（赠送卡实付 0，不退）
    if (refund > 0 && cdk.agent_id) {
      changeBalance(cdk.agent_id, refund, {
        kind: "refund_delete",
        refType: "cdk",
        refId: id,
        refLabel: cdk.code,
        note: "删除未激活卡密退款",
        actorType: staffCtx.isAgent ? "agent" : "admin",
        actorLabel: admin.email,
        ip: ctx.ip,
      });
    }
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "cdk.delete",
      targetType: "cdk",
      targetId: id,
      ip: ctx.ip,
      detail: { code: cdk.code, status: cdk.status, refund },
    });
    return ok({ deleted: true, refund });
  });

  post(`${P}/cdks/:id/revoke`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    const cdk = findCdkById(id);
    if (!cdk) throw notFound("CDK 不存在", "CDK_NOT_FOUND");
    assertAgentCanSeeCdk(staffCtx, cdk);
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

  /* ---------------------------- 客户 ---------------------------- */

  /** 后台手动新增客户（不依赖客户端注册） */
  post(`${P}/customers`, async (ctx) => {
    const staffCtx = requireFeature(ctx, "customer.manage");
    const admin = staffCtx.admin;
    // 代理不直接建客户：客户由卡密激活产生，创建后无从归属
    if (staffCtx.isAgent) throw forbidden("代理不能直接新增客户，客户请由卡密激活产生", "FORBIDDEN_AGENT_SCOPE");
    const emailInput = bodyStr(ctx, "email", 190);
    const password = bodyStr(ctx, "password", 200);
    const name = bodyStr(ctx, "name", { max: 120 });
    const company = bodyStr(ctx, "company", { max: 190 });
    const phone = bodyStr(ctx, "phone", { max: 40 });
    const note = bodyStr(ctx, "note", { max: 1000 });

    const email = emailInput ? normalizeEmail(emailInput) : null;
    if (email && !isEmail(email)) throw badRequest("邮箱格式不正确", "INVALID_EMAIL");
    if (email && findCustomerByEmail(email)) throw conflict("该邮箱已存在", "EMAIL_TAKEN");
    if (password && password.length < 6) throw badRequest("密码至少 6 位", "WEAK_PASSWORD");

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
    const staffCtx = requireFeature(ctx, "customer.manage");
    const { page, pageSize } = paging(ctx);
    // 代理只能看到自己名下的客户
    const result = listCustomers({
      q: q(ctx, "q"),
      status: q(ctx, "status"),
      page,
      pageSize,
      agentId: staffCtx.isAgent ? staffCtx.agentId : null,
    });
    return ok({
      items: result.items.map((row) => ({ ...row, password_hash: undefined })),
      total: result.total,
      page,
      page_size: pageSize,
    });
  });

  get(`${P}/customers/:id`, (ctx) => {
    const staffCtx = requireFeature(ctx, "customer.manage");
    const id = slash(ctx, "id");
    const customer = findCustomerById(id);
    if (!customer) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    if (staffCtx.isAgent && !customerBelongsToAgent(id, staffCtx.agentId ?? "")) {
      throw forbidden("该客户不属于你的代理", "FORBIDDEN_AGENT_SCOPE");
    }
    // 设备与席位按「同一客户 + 同一软件」共享，这里带上共享池口径，
    // 避免同一客户的多条授权显示出不一样的设备数量
    const poolCache = new Map<string, { seats: number; active_devices: number }>();
    const licenses = listLicensesByCustomer(id).map((row) => {
      if (!poolCache.has(row.product_id)) {
        const u = seatUsageForProduct(id, row.product_id);
        poolCache.set(row.product_id, { seats: u.seats, active_devices: u.active_devices });
      }
      return {
        ...licenseView(row),
        devices: listDevicesForGroup(id, row.product_id),
        pool_seats: poolCache.get(row.product_id)?.seats ?? row.seats,
        pool_active_devices: poolCache.get(row.product_id)?.active_devices ?? 0,
      };
    });
    // v13：把「能不能删」一并告诉前端，避免点了才报错
    const purge = checkCustomerPurgeable(id);
    return ok({
      customer: { ...customer, password_hash: undefined },
      licenses,
      purgeable: purge.ok,
      purge_blocking: purge.ok ? [] : purge.blocking,
    });
  });

  /**
   * v13：彻底删除客户（硬删除）。
   * 前提：名下授权全部过期或已吊销；仅超级管理员可操作。
   * 先写审计快照再删数据，同一个事务，日志落不了盘就整体回滚。
   */
  del(`${P}/customers/:id`, (ctx) => {
    const staffCtx = requireOwner(ctx);
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    if (!findCustomerById(id)) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");

    const check = checkCustomerPurgeable(id);
    if (!check.ok) {
      throw conflict(
        "该客户还有未过期或未吊销的授权，不能删除",
        "CUSTOMER_HAS_ACTIVE_LICENSE",
        { blocking: check.blocking },
      );
    }

    const snapshot = customerPurgeSnapshot(id);
    const result = withTx(() => {
      audit({
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        action: "customer.delete",
        targetType: "customer",
        targetId: id,
        ip: ctx.ip,
        detail: snapshot ?? { customer_id: id },
        strict: true, // 删除不可逆，日志必须落盘
      });
      return purgeCustomer(id);
    });

    return ok({ deleted: true, ...(result ?? {}) });
  });

  patch(`${P}/customers/:id`, async (ctx) => {
    const staffCtx = requireFeature(ctx, "customer.manage");
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    if (!findCustomerById(id)) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    if (staffCtx.isAgent && !customerBelongsToAgent(id, staffCtx.agentId ?? "")) {
      throw forbidden("该客户不属于你的代理", "FORBIDDEN_AGENT_SCOPE");
    }
    const patchData: Record<string, string | null> = {};
    // v8：允许修改登录邮箱与密码（代理也能改自己名下客户的登录信息）
    const emailInput = bodyStr(ctx, "email", 190);
    if (emailInput !== null) {
      const normalized = normalizeEmail(emailInput);
      if (!normalized) {
        patchData.email = null;
      } else {
        if (!isEmail(normalized)) throw badRequest("邮箱格式不正确", "INVALID_FIELD");
        const exists = findCustomerByEmail(normalized);
        if (exists && exists.id !== id) throw conflict("该邮箱已被其它客户使用", "EMAIL_TAKEN");
        patchData.email = normalized;
      }
    }
    const passwordInput = bodyStr(ctx, "password", 200);
    if (passwordInput) {
      if (passwordInput.length < 6) throw conflict("密码至少 6 位", "WEAK_PASSWORD");
      patchData.password_hash = await hashPassword(passwordInput);
    }
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
    const staffCtx = requireFeature(ctx, "customer.expiry");
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    const customer = findCustomerById(id);
    if (!customer) throw notFound("客户不存在", "CUSTOMER_NOT_FOUND");
    if (staffCtx.isAgent && !customerBelongsToAgent(id, staffCtx.agentId ?? "")) {
      throw forbidden("该客户不属于你的代理", "FORBIDDEN_AGENT_SCOPE");
    }

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
        // 代理：可缩短也能恢复，但不得超过 CDK 授予的上限；管理员不受限
        capByMaxExpiry: staffCtx.isAgent,
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

    // 每条授权的天数增减单独留痕：授权的「操作记录」里要能看出加了多少天、原到期、新到期
    for (const ch of result.changes) {
      if (ch.days === 0 && !ch.capped) continue;
      audit({
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        action: "license.adjust_expiry",
        targetType: "license",
        targetId: ch.license_id,
        ip: ctx.ip,
        detail: {
          days: ch.days,
          from_expires_at: ch.from,
          to_expires_at: ch.to,
          capped: ch.capped,
          by: staffCtx.isAgent ? "agent" : "admin",
        },
      });
    }

    return ok({
      updated: result.updated,
      capped: result.changes.filter((c) => c.capped).map((c) => ({ license_no: c.license_no, to: c.to })),
      changes: result.changes,
      licenses: result.items.map((row) => ({
        ...licenseView(row),
        module_ids: moduleIdsOf(row),
      })),
    });
  });

  /* ---------------------------- 批量操作 ---------------------------- */

  /**
   * 批量延期 / 批量改模块。
   * - preview 只算影响面，不落库
   * - apply 逐条执行，失败的单条返回原因，不影响其它条
   * - 代理需要单独开通 batch.operation 权限，且只能动自己名下的数据
   */
  const runBatch = (ctx: Ctx, kind: "cdk" | "license", apply: boolean) => {
    const staffCtx = requireStaff(ctx);
    const admin = staffCtx.admin;
    // bodyStrArray 默认最多 200 个，这里放宽到 500
    const ids = (bodyStrArray(ctx, "ids", 500) ?? []).slice(0, 500);
    if (!ids.length) throw badRequest("请先选择要操作的记录", "MISSING_FIELD", { field: "ids" });

    const opts: BatchOptions = {
      expire_days: bodyInt(ctx, "expire_days", { min: -3650, max: 3650 }),
      expires_at: isoOrNull(ctx, "expires_at"),
      term_type: bodyStr(ctx, "term_type", { max: 20 }),
      term_value: bodyInt(ctx, "term_value", { min: 1, max: 100000 }),
      module_ids: bodyStrArray(ctx, "module_ids"),
      agent_id: staffCtx.isAgent ? (staffCtx.agentId ?? "__none__") : null,
    };
    if (!opts.expire_days && !opts.expires_at && !opts.term_type && !opts.term_value && !opts.module_ids) {
      throw badRequest("请至少填写一项要修改的内容", "MISSING_FIELD");
    }

    const result = kind === "cdk" ? batchCdks(ids, opts, apply) : batchLicenses(ids, opts, apply);

    if (apply && result.changed.length) {
      audit({
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        action: kind === "cdk" ? "cdk.batch_update" : "license.batch_update",
        targetType: kind === "cdk" ? "cdk_batch" : "license",
        targetId: null,
        ip: ctx.ip,
        detail: {
          updated: result.updated,
          skipped: result.skipped.length,
          failed: result.failed.length,
          expire_days: opts.expire_days ?? null,
          expires_at: opts.expires_at ?? null,
          term_type: opts.term_type ?? null,
          term_value: opts.term_value ?? null,
          modules: opts.module_ids ?? null,
          by_agent: staffCtx.isAgent ? staffCtx.agentId : null,
        },
      });
      // 逐条留痕，授权详情里的操作记录能看到「批量 +30 天」
      for (const ch of result.changed) {
        audit({
          actorType: "admin",
          actorId: admin.id,
          actorLabel: admin.email,
          action: kind === "cdk" ? "cdk.update" : "license.adjust_expiry",
          targetType: kind === "cdk" ? "cdk" : "license",
          targetId: ch.id,
          ip: ctx.ip,
          detail: {
            batch: true,
            days: ch.days || undefined,
            from_expires_at: ch.from,
            to_expires_at: ch.to,
            modules: ch.modules ?? undefined,
            by: staffCtx.isAgent ? "agent" : "admin",
          },
        });
      }
    }

    return ok({ applied: apply, ...result });
  };

  post(`${P}/cdks/batch/preview`, (ctx) => runBatch(ctx, "cdk", false));
  post(`${P}/cdks/batch/apply`, (ctx) => runBatch(ctx, "cdk", true));
  post(`${P}/licenses/batch/preview`, (ctx) => runBatch(ctx, "license", false));
  post(`${P}/licenses/batch/apply`, (ctx) => runBatch(ctx, "license", true));

  /* ---------------------------- 授权 ---------------------------- */

  get(`${P}/licenses`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    // 代理只能看自己代理下的授权，传什么筛选都无效
    const agentFilter = staffCtx.isAgent ? (staffCtx.agentId ?? "__none__") : q(ctx, "agent_id");
    const { page, pageSize } = paging(ctx);
    const expiring = q(ctx, "expiring_within_days");
    const result = listLicenses({
      q: q(ctx, "q"),
      status: q(ctx, "status"),
      productId: q(ctx, "product_id"),
      customerId: q(ctx, "customer_id"),
      agentId: agentFilter,
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
    const staffCtx = requireStaff(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (license) assertAgentCanSeeLicense(staffCtx, license);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    const customer = findCustomerById(license.customer_id);
    return ok({
      license: { ...licenseView(license), module_ids: parseJson<string[]>(license.module_ids, []) },
      // 设备按「同一客户 + 同一软件」共享：试用卡和 CDK 卡看到的是同一批设备
      devices: listDevicesForGroup(license.customer_id, license.product_id),
      group_license_ids: licenseGroupIds(license.customer_id, license.product_id),
      group: licenseGroup(license.customer_id, license.product_id),
      module_codes: moduleCodesFor(moduleIdsOf(license)),
      // 前端按名称展示模块（不再只显示代码或数量）
      modules: moduleIdsOf(license).map((mid) => {
        const m = findModuleById(mid);
        const row = listLicenseModules(id).find((r) => r.module_id === mid);
        return {
          id: mid,
          code: m?.code ?? mid,
          name: m?.name ?? mid,
          expires_at: row?.expires_at ?? license.expires_at ?? null,
          custom_expiry: Boolean(row?.expires_at && row.expires_at !== license.expires_at),
        };
      }),
      customer: customer ? { ...customer, password_hash: undefined } : null,
    });
  });

  /** 授权的操作日志（绑定/解绑/加时/冻结…），按「同一客户 + 同一软件」合并展示 */
  get(`${P}/licenses/:id/logs`, (ctx) => {
    const staffCtx = requireStaff(ctx);
    const id = slash(ctx, "id");
    const license = findLicenseById(id);
    if (!license) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    assertAgentCanSeeLicense(staffCtx, license);
    const ids = licenseGroupIds(license.customer_id, license.product_id);
    return ok({
      items: listAuditByTargets(ids, 200),
      license_ids: ids,
      scope: "customer_product",
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
      if (!moduleIds.length) throw badRequest("请至少保留一个模块", "MISSING_FIELD", { field: "module_ids" });
      validateModuleIds(license.product_id, moduleIds);
      patchData.module_ids = JSON.stringify(moduleIds);
    }

    // v9：逐个模块设置到期时间（expires_at 传 null 表示恢复跟随授权到期）
    const moduleExpiries = Array.isArray(ctx.body.module_expiries) ? ctx.body.module_expiries : null;

    const updated = updateLicense(id, patchData as Partial<LicenseRow>);

    // 管理员直接改到期：超过原上限就把上限一起抬高（否则代理之后无法正常续期）
    if (expiresAt && updated?.expires_at) {
      const cap = license.max_expires_at ? Date.parse(license.max_expires_at) : null;
      if (!cap || Date.parse(updated.expires_at) > cap) {
        db().prepare("UPDATE licenses SET max_expires_at = ? WHERE id = ?").run(updated.expires_at, id);
      }
    }

    // v11：模块到期是权威来源。管理员改授权到期时同步到所有模块，
    //      需要单独控制某个模块时用下面的 module_expiries 覆盖。
    if (expiresAt) syncModuleExpiry(id, expiresAt);

    if (moduleExpiries) {
      for (const item of moduleExpiries) {
        const rec = item as { module_id?: unknown; expires_at?: unknown };
        const mid = typeof rec.module_id === "string" ? rec.module_id : "";
        if (!mid) continue;
        const raw = typeof rec.expires_at === "string" ? rec.expires_at : null;
        const ms = raw ? Date.parse(raw) : null;
        if (raw && !Number.isFinite(ms)) throw badRequest("module_expiries.expires_at 时间格式不合法", "INVALID_FIELD");
        setLicenseModuleExpiry(id, mid, raw ? new Date(ms as number).toISOString() : null);
      }
    }

    // 模块集合或到期变动后，同步模块记录（module_ids 变化时补建/清理，其余情况只保证记录存在）
    if (moduleIds || moduleExpiries) {
      syncLicenseModules(id, moduleIdsOf(updated ?? license), updated?.expires_at ?? license.expires_at ?? nowIso());
    }

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
    // 管理员加时超过原上限时同步抬高上限，代理之后才能继续续期
    if (updated?.expires_at) {
      const cap = license.max_expires_at ? Date.parse(license.max_expires_at) : null;
      if (!cap || Date.parse(updated.expires_at) > cap) {
        db().prepare("UPDATE licenses SET max_expires_at = ? WHERE id = ?").run(updated.expires_at, id);
      }
    }
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "license.extend",
      targetType: "license",
      targetId: id,
      ip: ctx.ip,
      detail: {
        days,
        from_now: fromNow,
        from_expires_at: license.expires_at,
        new_expires_at: updated?.expires_at,
        to_expires_at: updated?.expires_at,
      },
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
    const staffCtx = requireStaff(ctx);
    const admin = staffCtx.admin;
    const id = slash(ctx, "id");
    const deviceId = slash(ctx, "deviceId");
    const lic = findLicenseById(id);
    if (!lic) throw notFound("授权不存在", "LICENSE_NOT_FOUND");
    assertAgentCanSeeLicense(staffCtx, lic);
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

    // v2：可选归属代理与结算单价（单价单位：分）
    const agentInput = bodyStr(ctx, "agent_id", 64);
    const unitPrice = bodyInt(ctx, "unit_price", { min: 0, max: 100_000_000 }) ?? 0;
    let agentId: string | null = null;
    if (agentInput) {
      const agent = findAgentById(agentInput);
      if (!agent) throw notFound("代理不存在", "AGENT_NOT_FOUND");
      agentId = agent.id;
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
        agentId,
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
        agent_id: agentId,
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

  /** 管理后台入口地址：根路径留给客户门户，后台走可配置的隐藏入口 */
  get(`${P}/entry`, (ctx) => {
    requireAdmin(ctx);
    return ok({
      path: getAdminPath(),
      default_path: DEFAULT_ADMIN_PATH,
      is_default: isDefaultAdminPath(),
      root_is_portal: true,
    });
  });

  patch(`${P}/entry`, (ctx) => {
    const staffCtx = requireOwner(ctx);
    const admin = staffCtx.admin;
    const next = String(ctx.body.path ?? "").trim();
    const check = isUsableAdminPath(next);
    if (!check.ok) throw badRequest(check.reason, "INVALID_ENTRY_PATH");

    const previous = getAdminPath();
    const path = setAdminPath(next);
    audit({
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      action: "settings.entry_update",
      targetType: "settings",
      targetId: "entry.admin_path",
      ip: ctx.ip,
      detail: { from: previous, to: path },
    });
    return ok({ path, previous, login_url: `/${path}`, restart_required: false });
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

    const seats = bodyInt(ctx, "seats", { min: 1, max: 100 }) ?? 1;
    const agentId = staffCtx.isAgent ? staffCtx.agentId : null;
    const price = resolvePrice(productId, moduleIds, termType, agentId);
    const total = price ? totalPrice(price.unit_price, termValue, count, seats, price.seat_ratio) : null;

    // 只有代理需要付费；管理员生成属于赠送，不显示金额
    const payable = staffCtx.isAgent;
    const agent = payable && agentId ? findAgentById(agentId) : null;
    const balance = agent ? agent.balance : null;
    const units = price ? billableUnits(termValue, seats, price.seat_ratio) : null;

    return ok({
      payable,
      unit_price: price?.unit_price ?? null,
      seat_ratio: price?.seat_ratio ?? 0,
      seat_factor: price ? seatFactor(seats, price.seat_ratio) : null,
      billable_units: units,
      total_price: total,
      term_type: termType,
      term_value: termValue,
      seats,
      count,
      balance,
      shortfall: payable && total !== null && balance !== null ? Math.max(0, total - balance) : 0,
      sufficient: !payable || (total !== null && balance !== null && balance >= total),
      priced: price !== null,
      // 代理端只用「定价档位」，把已配好的档位和价格一起给前端
      tiers: availableTiers(productId, moduleIds, agentId),
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
  term?: { termType: string; termValue: number },
): string {
  const header = "code,product,term,value,days,seats,modules,note";
  const rows = codes.map((code) =>
    [
      csvCell(code),
      csvCell(productCode),
      csvCell(term?.termType ?? "day"),
      csvCell(term?.termValue ?? days),
      csvCell(days),
      csvCell(seats),
      csvCell(moduleCodes.join("|")),
      csvCell(note ?? ""),
    ].join(","),
  );
  return `\ufeff${header}\n${rows.join("\n")}\n`;
}


