/**
 * 密码学相关：Ed25519 许可证签名、口令哈希、随机凭证、CDK 码。
 * 只使用 Node 内置 crypto，无第三方依赖。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  scrypt,
  scryptSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { b64url, fromB64url, nowIso } from "./util.ts";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/* ------------------------------------------------------------------ */
/* Ed25519 签名密钥                                                    */
/* ------------------------------------------------------------------ */

export type SigningKeys = {
  kid: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
  publicKeyB64: string;
};

function publicKeyB64FromPem(pem: string): string {
  const key = createPublicKey(pem);
  const der = key.export({ type: "spki", format: "der" });
  return (der as Buffer).toString("base64");
}

function buildKeys(privatePem: string, publicPem: string, kid = "k1", createdAt = nowIso()): SigningKeys {
  // 校验两把钥匙确实配对，避免配置错导致签出的许可证无法验签。
  const probe = Buffer.from("key-pair-selftest");
  const sig = edSign(null, probe, createPrivateKey(privatePem));
  if (!edVerify(null, probe, createPublicKey(publicPem), sig)) {
    throw new Error("签名密钥自检失败：SIGNING_PRIVATE_KEY 与公钥不匹配");
  }
  return {
    kid,
    algorithm: "Ed25519",
    publicKeyPem: publicPem,
    privateKeyPem: privatePem,
    createdAt,
    publicKeyB64: publicKeyB64FromPem(publicPem),
  };
}

/**
 * 加载或生成签名密钥。
 * 优先级：环境变量 SIGNING_PRIVATE_KEY_B64 > keys 文件 > 新生成（写入 keys 文件）。
 */
export function loadOrCreateSigningKeys(keysFile: string, privateKeyB64FromEnv: string): SigningKeys {
  if (privateKeyB64FromEnv) {
    const pem = Buffer.from(privateKeyB64FromEnv, "base64").toString("utf8");
    const priv = createPrivateKey(pem);
    const pubPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
    return buildKeys(pem, pubPem, "env", nowIso());
  }

  if (existsSync(keysFile)) {
    const raw = JSON.parse(readFileSync(keysFile, "utf8")) as Partial<SigningKeys>;
    if (!raw.privateKeyPem || !raw.publicKeyPem) {
      throw new Error(`签名密钥文件损坏：${keysFile}`);
    }
    return buildKeys(raw.privateKeyPem, raw.publicKeyPem, raw.kid ?? "k1", raw.createdAt ?? nowIso());
  }

  // 新生成：Ed25519，格式 PKCS8 / SPKI
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  mkdirSync(dirname(keysFile), { recursive: true });
  const keys = buildKeys(privatePem, publicPem, "k1", nowIso());
  writeFileSync(keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return keys;
}

/* ------------------------------------------------------------------ */
/* 许可证文件（离线验签用）                                             */
/* ------------------------------------------------------------------ */

export type LicensePayload = {
  v: number;
  kid: string;
  lic: string;
  lic_no: string;
  cus: string;
  prd: string;
  mod: string[];
  dev: string;
  seat: number;
  iat: number;
  exp: number;
  grace_until: number;
  status: string;
  /** v4：计费类型与数量（hour/day/month/year/count） */
  term?: { type: string; value: number };
  /** v4：次数型授权的额度与已用量（其余类型为 null） */
  usage?: { max: number; used: number } | null;
  /**
   * v11：逐模块到期（新客户端读这个，按模块判断功能）。
   * exp 为 Unix 秒；active=false 表示该模块已过期。
   * 老客户端忽略本字段，继续用 mod + exp，行为不变。
   */
  mods?: { c: string; exp?: number; active: boolean }[];
};

/**
 * 许可证文件格式：`base64url(payload-json) + "." + base64url(ed25519-signature)`。
 * 客户端拿到公钥后可完全离线校验：签名 + exp + 设备指纹。
 */
export function signLicenseFile(keys: SigningKeys, payload: LicensePayload): string {
  const body = b64url(JSON.stringify(payload));
  const signature = edSign(null, Buffer.from(body, "utf8"), createPrivateKey(keys.privateKeyPem));
  return `${body}.${b64url(signature)}`;
}

export type VerifyResult =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: string };

export function verifyLicenseFile(file: string, publicKeyPem: string): VerifyResult {
  const dot = file.indexOf(".");
  if (dot <= 0) return { valid: false, reason: "malformed" };
  const body = file.slice(0, dot);
  const sigPart = file.slice(dot + 1);
  try {
    const ok = edVerify(
      null,
      Buffer.from(body, "utf8"),
      createPublicKey(publicKeyPem),
      fromB64url(sigPart),
    );
    if (!ok) return { valid: false, reason: "bad-signature" };
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as LicensePayload;
    if (payload.exp * 1000 <= Date.now()) return { valid: false, reason: "expired" };
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}

/* ------------------------------------------------------------------ */
/* 口令哈希（scrypt）                                                   */
/* ------------------------------------------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, "base64");
    const derived = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 随机凭证 / 摘要                                                     */
/* ------------------------------------------------------------------ */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 设备指纹绑定值：绑定到具体授权，换授权/换机后失效 */
export function deviceBinding(deviceId: string, licenseId: string): string {
  return sha256hex(`dev|${deviceId}|${licenseId}`).slice(0, 32);
}

/** 接入方 IP 脱敏，只保留前两段，避免日志泄露完整地址 */
export function maskIp(ip: string): string {
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    return `${parts.slice(0, 3).join(":")}::`;
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  return ip;
}

/* ------------------------------------------------------------------ */
/* CDK 码                                                              */
/* ------------------------------------------------------------------ */

/** 去掉了易混淆的 I / O / 0 / 1，共 32 个字符 */
const CDK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCdkCode(groups = 4, groupSize = 4): string {
  const chars: string[] = [];
  for (let i = 0; i < groups * groupSize; i += 1) {
    chars.push(CDK_ALPHABET[randomInt(0, CDK_ALPHABET.length)]);
  }
  const out: string[] = [];
  for (let i = 0; i < groups; i += 1) {
    out.push(chars.slice(i * groupSize, (i + 1) * groupSize).join(""));
  }
  return out.join("-");
}

export function normalizeCdkCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatCdkCode(normalized: string): string {
  return (normalized.match(/.{1,4}/g) ?? [normalized]).join("-");
}

/** 运营商单号，例如 LIC-2025-0F3A9C */
export function generateLicenseNo(): string {
  const year = new Date().getUTCFullYear();
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `LIC-${year}-${rand}`;
}

/** 许可证密钥（客户端保存，用于心跳）。仅在签发时明文返回一次。 */
export function generateLicenseKey(): string {
  return `LK-${randomBytes(24).toString("base64url")}`;
}

// 供一次性脚本/测试使用
export const _internal = { scryptSync };
