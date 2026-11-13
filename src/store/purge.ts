/**
 * 客户彻底删除（硬删除）。
 *
 * 规则：
 *   - 只有「名下所有授权都已过期或已吊销」才允许删除；
 *     仍有有效期内的授权、或状态为 suspended 的授权，都会拦住。
 *   - 删除是硬删除：客户行、授权、设备、模块记录一并清掉。
 *   - CDK 不删行，改标 revoked 并断开引用——历史对账还在，但码不能再激活。
 *   - 调用方必须在同一个事务里写入审计快照（见 admin 路由），否则不可恢复。
 */
import { db, withTx } from "../db.ts";
import { nowIso } from "../util.ts";
import { findCustomerById } from "./accounts.ts";
import { listDevices, listLicensesByCustomer, moduleIdsOf } from "./licensing.ts";
import type { LicenseRow } from "../types.ts";

export type PurgeBlocker = {
  license_no: string;
  status: string;
  expires_at: string | null;
  reason: string;
};

/** 检查该客户能否被删除；不能则返回每一条阻止原因 */
export function checkCustomerPurgeable(
  customerId: string,
): { ok: true } | { ok: false; blocking: PurgeBlocker[] } {
  const now = Date.now();
  const blocking: PurgeBlocker[] = [];

  for (const l of listLicensesByCustomer(customerId) as LicenseRow[]) {
    if (l.status === "revoked") continue; // 手动吊销过，可以删

    if (l.status === "suspended") {
      blocking.push({
        license_no: l.license_no,
        status: l.status,
        expires_at: l.expires_at ?? null,
        reason: "授权处于暂停状态，请先恢复或吊销",
      });
      continue;
    }

    const ms = l.expires_at ? Date.parse(l.expires_at) : Number.NaN;
    if (!Number.isFinite(ms)) {
      blocking.push({
        license_no: l.license_no,
        status: l.status,
        expires_at: null,
        reason: "授权没有到期时间（如次数卡），请先吊销",
      });
    } else if (ms > now) {
      blocking.push({
        license_no: l.license_no,
        status: l.status,
        expires_at: l.expires_at ?? null,
        reason: "授权仍在有效期内",
      });
    }
  }

  return blocking.length ? { ok: false, blocking } : { ok: true };
}

/** 采集删除前的完整快照（写进审计日志，删除后只能靠它追溯） */
export function customerPurgeSnapshot(customerId: string) {
  const customer = findCustomerById(customerId);
  if (!customer) return null;

  const licenses = listLicensesByCustomer(customerId) as LicenseRow[];

  const devices = licenses.flatMap((l) =>
    listDevices(l.id).map((d) => ({
      license_no: l.license_no,
      device_id: d.device_id,
      device_name: d.device_name,
      platform: d.platform,
      status: d.status,
      first_seen_at: d.first_seen_at,
      last_seen_at: d.last_seen_at,
      last_ip: d.last_ip ?? null,
    })),
  );

  const cdks = db()
    .prepare(
      `SELECT k.code, k.status, k.batch_id, k.used_at, k.created_at, p.code AS product_code
         FROM cdks k
         LEFT JOIN products p ON p.id = k.product_id
        WHERE k.customer_id = ?
        ORDER BY k.code`,
    )
    .all(customerId) as unknown as {
    code: string;
    status: string;
    batch_id: string | null;
    used_at: string | null;
    created_at: string;
    product_code: string | null;
  }[];

  return {
    deleted_at: nowIso(),
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      company: customer.company,
      phone: customer.phone,
      status: customer.status,
      note: customer.note,
      created_at: customer.created_at,
      last_login_at: customer.last_login_at ?? null,
    },
    // 不记录 password_hash / 许可证密钥哈希：删掉之后不需要再留凭证
    licenses: licenses.map((l) => ({
      id: l.id,
      license_no: l.license_no,
      kind: l.kind,
      source: l.source,
      status: l.status,
      starts_at: l.starts_at,
      expires_at: l.expires_at,
      term_type: l.term_type ?? null,
      term_value: l.term_value ?? null,
      seats: l.seats,
      module_codes: moduleIdsOf(l),
      agent_id: l.agent_id ?? null,
      unit_price: l.unit_price ?? 0,
      created_at: l.created_at,
    })),
    devices,
    cdks,
    totals: {
      licenses: licenses.length,
      devices: devices.length,
      cdks: cdks.length,
    },
  };
}

/**
 * 执行硬删除。调用方负责先后顺序：先 audit 快照，再调用本函数，
 * 两者应在同一个事务里（本函数内部用的是可嵌套事务）。
 */
export function purgeCustomer(customerId: string): {
  licenses: number;
  devices: number;
  cdks: number;
  modules: number;
} | null {
  return withTx(() => {
    const customer = findCustomerById(customerId);
    if (!customer) return null;

    const licenses = listLicensesByCustomer(customerId) as LicenseRow[];
    const at = nowIso();
    let modules = 0;
    let devices = 0;

    for (const l of licenses) {
      devices += listDevices(l.id).length;
      const res = db().prepare("DELETE FROM license_modules WHERE license_id = ?").run(l.id);
      modules += Number(res.changes);
    }

    // 卡密不删行：标成作废并断开对已删对象的引用，历史还能查
    const cdkRes = db()
      .prepare(
        `UPDATE cdks
            SET status = 'revoked', customer_id = NULL, license_id = NULL,
                revoked_at = ?, revoked_reason = '客户已删除'
          WHERE customer_id = ?`,
      )
      .run(at, customerId);

    const licRes = db().prepare("DELETE FROM licenses WHERE customer_id = ?").run(customerId);
    // 设备有 ON DELETE CASCADE，随授权一起消失
    db().prepare("DELETE FROM sessions WHERE subject_type = 'customer' AND subject_id = ?").run(
      customerId,
    );
    db().prepare("DELETE FROM customers WHERE id = ?").run(customerId);

    return {
      licenses: Number(licRes.changes),
      devices,
      cdks: Number(cdkRes.changes),
      modules,
    };
  });
}
