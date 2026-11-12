/** 启动引导：数据库、签名密钥、初始管理员。 */
import { config } from "./config.ts";
import { hashPassword, randomToken } from "./crypto.ts";
import { openDb } from "./db.ts";
import { initSigningKeys } from "./keys.ts";
import { countAdmins, createAdmin, purgeExpiredSessions } from "./store/accounts.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type BootstrapInfo = {
  dbPath: string;
  kid: string;
  publicKeyPem: string;
  adminCreated: boolean;
  adminEmail: string;
  generatedPasswordFile: string | null;
};

export async function bootstrap(): Promise<BootstrapInfo> {
  const dbPath = config.dbPath;
  openDb(dbPath);
  const keys = initSigningKeys();
  purgeExpiredSessions();

  let adminCreated = false;
  let generatedPasswordFile: string | null = null;

  if (countAdmins() === 0) {
    const email = config.initialAdmin.email;
    let password = config.initialAdmin.password;
    if (!password) {
      password = randomToken(12);
      generatedPasswordFile = join(config.dataDir, "initial-admin.txt");
      writeFileSync(
        generatedPasswordFile,
        `初始管理员账号（请登录后立即修改密码，并删除本文件）\nemail: ${email}\npassword: ${password}\ncreated: ${new Date().toISOString()}\n`,
        { mode: 0o600 },
      );
    }
    await createAdmin({
      email,
      passwordHash: await hashPassword(password),
      name: config.initialAdmin.name,
    });
    adminCreated = true;
  }

  return {
    dbPath,
    kid: keys.kid,
    publicKeyPem: keys.publicKeyPem,
    adminCreated,
    adminEmail: config.initialAdmin.email,
    generatedPasswordFile,
  };
}
