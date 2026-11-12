/**
 * 导出签名私钥的 base64，用于「多实例/迁移」时注入 `SIGNING_PRIVATE_KEY_B64`。
 *
 * 用法：
 *   docker compose exec -T license-server node src/tools/export-key.ts > my-key.b64
 *   DATA_DIR=/var/lib/license-server node src/tools/export-key.ts
 *
 * ⚠️ 输出等同于服务端私钥：泄露即可伪造任意许可证。只写到安全的文件里，不要贴进聊天/工单/日志。
 */
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";

if (!existsSync(config.keysFile)) {
  console.error(`[export-key] 找不到密钥文件：${config.keysFile}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(config.keysFile, "utf8")) as {
  kid?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
};

if (!raw.privateKeyPem) {
  console.error(`[export-key] 密钥文件缺少 privateKeyPem：${config.keysFile}`);
  process.exit(1);
}

console.error(
  `[export-key] kid=${raw.kid ?? "k1"} —— 以下内容为敏感私钥，请妥善保存（已输出 base64 到 stdout）`,
);
console.log(Buffer.from(raw.privateKeyPem, "utf8").toString("base64"));
