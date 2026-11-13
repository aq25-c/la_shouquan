/** 会话鉴权：管理员 / 客户。 */
import { config } from "./config.ts";
import { randomToken, sha256hex } from "./crypto.ts";
import { HttpError, bearerToken, forbidden, unauthorized } from "./http.ts";
import type { Ctx } from "./http.ts";
import { findAdminById, findCustomerById, findSessionByTokenHash, createSession } from "./store/accounts.ts";
import { hasFeature, parsePermissions } from "./permissions.ts";
import type { Permissions, StaffRole } from "./permissions.ts";
import type { AdminRow, CustomerRow } from "./types.ts";
import { plusHours } from "./util.ts";

export type AuthContext = {
  sessionId: string;
  admin?: AdminRow;
  customer?: CustomerRow;
};

function sessionFromCtx(ctx: Ctx) {
  const token = ctx.token ?? bearerToken(ctx.req);
  if (!token) return null;
  const session = findSessionByTokenHash(sha256hex(token));
  if (!session) return null;
  return session;
}

export function currentAdmin(ctx: Ctx): AdminRow | null {
  const session = sessionFromCtx(ctx);
  if (!session || session.subject_type !== "admin") return null;
  const admin = findAdminById(session.subject_id);
  if (!admin || admin.status !== "active") return null;
  return admin;
}

export function requireAdmin(ctx: Ctx): AdminRow {
  const admin = currentAdmin(ctx);
  if (!admin) throw unauthorized("管理员未登录或登录已过期");
  return admin;
}

/** 员工/代理的完整身份：角色 + 目录权限 + 功能权限 + 所属渠道 */
export type StaffContext = {
  admin: AdminRow;
  role: StaffRole;
  permissions: Permissions;
  /** 代理关联的渠道；非代理为 null */
  channelId: string | null;
  isOwner: boolean;
  isAgent: boolean;
};

export function requireStaff(ctx: Ctx): StaffContext {
  const admin = requireAdmin(ctx);
  const role = (["owner", "staff", "agent"].includes(admin.role) ? admin.role : "owner") as StaffRole;
  return {
    admin,
    role,
    permissions: parsePermissions(admin.permissions, role),
    channelId: admin.channel_id ?? null,
    isOwner: role === "owner",
    isAgent: role === "agent",
  };
}

/** 要求某个软件功能权限（员工没配就 403） */
export function requireFeature(ctx: Ctx, feature: string): StaffContext {
  const staffCtx = requireStaff(ctx);
  if (!hasFeature(staffCtx.permissions, feature)) {
    throw forbidden(`缺少功能权限：${feature}`, "FORBIDDEN_FEATURE", { feature });
  }
  return staffCtx;
}

/** 仅超级管理员（角色 owner）可操作，例如员工/代理管理 */
export function requireOwner(ctx: Ctx): StaffContext {
  const staffCtx = requireStaff(ctx);
  if (!staffCtx.isOwner) {
    throw forbidden("仅超级管理员可执行该操作", "FORBIDDEN_OWNER");
  }
  return staffCtx;
}

export function currentCustomer(ctx: Ctx): CustomerRow | null {
  const session = sessionFromCtx(ctx);
  if (!session || session.subject_type !== "customer") return null;
  const customer = findCustomerById(session.subject_id);
  if (!customer) return null;
  return customer;
}

export function requireCustomer(ctx: Ctx): CustomerRow {
  const customer = currentCustomer(ctx);
  if (!customer) throw unauthorized("请先登录客户账号");
  if (customer.status !== "active") throw forbidden("账号已被停用", "CUSTOMER_DISABLED");
  return customer;
}

export function currentSession(ctx: Ctx) {
  return sessionFromCtx(ctx);
}

/** 生成会话并返回明文 token（只在此处出现一次）。 */
export function grantSession(
  subjectType: "admin" | "customer",
  subjectId: string,
  ttlHours: number,
  ctx: Ctx,
): { token: string; expires_at: string; session_id: string } {
  const token = randomToken(32);
  const expiresAt = plusHours(ttlHours);
  const session = createSession({
    subjectType,
    subjectId,
    tokenHash: sha256hex(token),
    expiresAt,
    ip: ctx.ip,
    userAgent: ctx.headers["user-agent"] ?? null,
  });
  return { token, expires_at: expiresAt, session_id: session.id };
}

export function adminTtl(): number {
  return config.adminTokenTtlHours;
}

export function customerTtl(): number {
  return config.customerTokenTtlHours;
}

/** 把 HttpError 之外的异常打上上下文，便于日志定位 */
export function asHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  return new HttpError(500, "INTERNAL_ERROR", err instanceof Error ? err.message : "服务内部错误");
}
