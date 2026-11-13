/** 许可证签发与对外视图。 */
import { config } from "./config.ts";
import { deviceBinding, signLicenseFile } from "./crypto.ts";
import type { LicensePayload, SigningKeys } from "./crypto.ts";
import { moduleCodesFor } from "./store/catalog.ts";
import { moduleIdsOf } from "./store/licensing.ts";
import { DAY, toMs } from "./util.ts";
import type { LicenseRow } from "./types.ts";

/**
 * 离线有效期 = min(授权到期时间, 现在 + 离线宽限天数)。
 * 这样断网客户端最多用到宽限期，联网心跳后自动滚动续期。
 */
export function offlineExpiryMs(license: LicenseRow, nowMs: number = Date.now()): number {
  const grace = Number.isFinite(license.offline_grace_days)
    ? license.offline_grace_days
    : config.offlineGraceDays;
  return Math.min(toMs(license.expires_at), nowMs + grace * DAY);
}

export type IssuedLicense = {
  license_file: string;
  offline_expires_at: string;
  payload: LicensePayload;
};

export function buildLicenseFile(input: {
  license: LicenseRow;
  productCode: string;
  deviceId: string;
  keys: SigningKeys;
}): IssuedLicense {
  const nowMs = Date.now();
  const expMs = offlineExpiryMs(input.license, nowMs);
  const payload: LicensePayload = {
    v: 1,
    kid: input.keys.kid,
    lic: input.license.id,
    lic_no: input.license.license_no,
    cus: input.license.customer_id,
    prd: input.productCode,
    mod: moduleCodesFor(moduleIdsOf(input.license)),
    dev: deviceBinding(input.deviceId, input.license.id),
    seat: input.license.seats,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(expMs / 1000),
    grace_until: Math.floor(toMs(input.license.expires_at) / 1000),
    status: input.license.status,
    term: {
      type: input.license.term_type ?? "day",
      value: Number(input.license.term_value ?? 0),
    },
    usage:
      input.license.max_usages !== null && input.license.max_usages !== undefined
        ? { max: input.license.max_usages, used: input.license.used_usages }
        : null,
  };
  return {
    license_file: signLicenseFile(input.keys, payload),
    offline_expires_at: new Date(expMs).toISOString(),
    payload,
  };
}

/** 对外视图：剔除敏感字段（密钥哈希） */
export function licenseView<T extends LicenseRow>(license: T): Omit<T, "key_hash"> {
  const { key_hash: _ignored, ...rest } = license;
  return rest;
}
