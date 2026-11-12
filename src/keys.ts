/** 签名密钥单例：全进程共用一把 Ed25519 私钥。 */
import { loadOrCreateSigningKeys } from "./crypto.ts";
import type { SigningKeys } from "./crypto.ts";
import { config } from "./config.ts";

let cached: SigningKeys | null = null;

export function initSigningKeys(): SigningKeys {
  if (!cached) {
    cached = loadOrCreateSigningKeys(config.keysFile, config.signingPrivateKeyB64);
  }
  return cached;
}

export function signingKeys(): SigningKeys {
  if (!cached) throw new Error("签名密钥尚未初始化");
  return cached;
}

export function publicKeyInfo() {
  const keys = signingKeys();
  return {
    kid: keys.kid,
    algorithm: keys.algorithm,
    public_key_pem: keys.publicKeyPem,
    public_key_b64: keys.publicKeyB64,
    created_at: keys.createdAt,
  };
}
