/**
 * 许可证密钥保管箱：库里存哈希用于校验，另外加密存一份明文，
 * 让「已绑定的设备登录时」能自动取回密钥（客户端重装/丢密钥不用再重置）。
 *
 * 加密密钥放在 data 目录（license-secret.key，0600），跟数据库分开；
 * 单独泄露数据库也解不出密钥。
 */
import { Buffer } from "node:buffer";
import { config } from "../config.ts";
import { db } from "../db.ts";
import { decryptSecret, encryptSecret, generateLicenseKey, loadOrCreateLocalSecret, sha256hex } from "../crypto.ts";
import { nowIso } from "../util.ts";

let cachedSecret: Buffer | null = null;

function secret(): Buffer {
  if (!cachedSecret) cachedSecret = loadOrCreateLocalSecret(config.licenseSecretFile);
  return cachedSecret;
}

/** 保存这把密钥（同时把 key_hash 更新成它） */
export function setLicenseKey(licenseId: string, key: string): void {
  const enc = encryptSecret(key, secret());
  db()
    .prepare("UPDATE licenses SET key_hash = ?, key_enc = ?, updated_at = ? WHERE id = ?")
    .run(sha256hex(key), enc, nowIso(), licenseId);
}

/** 生成一把新密钥、写库、返回明文（重置/认领/并卡时用） */
export function rotateLicenseKeyAndKeep(licenseId: string): string {
  const key = generateLicenseKey();
  setLicenseKey(licenseId, key);
  return key;
}

/** 取回当前密钥（老数据没有加密副本时返回 null） */
export function readLicenseKey(licenseId: string): string | null {
  const row = db().prepare("SELECT key_enc FROM licenses WHERE id = ?").get(licenseId) as
    | { key_enc: string | null }
    | undefined;
  if (!row?.key_enc) return null;
  return decryptSecret(row.key_enc, secret());
}
