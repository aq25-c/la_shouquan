/**
 * 端到端集成测试：真实 HTTP 服务 + 真实 SQLite。
 * 覆盖 注册 → CDK 激活 → 席位加绑 → 心跳 → 续费 → 到期 → 吊销 → 离线验签 → 审计。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ---------- 环境必须在加载被测模块之前设好 ---------- */
const dataDir = mkdtempSync(join(tmpdir(), "license-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.DB_PATH = join(dataDir, "test.db");
process.env.KEYS_FILE = join(dataDir, "keys.json");
process.env.ADMIN_EMAIL = "root@test.local";
process.env.ADMIN_PASSWORD = "RootPassw0rd!";
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_PER_MIN = "0";
process.env.OFFLINE_GRACE_DAYS = "7";

const { bootstrap } = await import("../src/bootstrap.ts");
const { buildServer } = await import("../src/server.ts");
const { closeDb } = await import("../src/db.ts");
const { verifyLicenseFile } = await import("../src/crypto.ts");

type Json = Record<string, any>;

let server: any;
let base = "";
let adminToken = "";
let productId = "";
let moduleIds: string[] = [];
let codes: string[] = [];
let licenseKey = "";
let licenseId = "";
let licenseFile = "";
let publicKeyPem = "";
let customerToken = "";
/* 渠道 / 分销 */
let channelId = "";
let channelCdkCodes: string[] = [];
/* 客户/试用 */
let adminCreatedCustomerId = "";
let trialLicenseId = "";

async function api(
  method: string,
  path: string,
  body?: Json,
  token?: string,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

before(async () => {
  await bootstrap();
  server = buildServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

test("健康检查与公钥分发", async () => {
  const health = await api("GET", "/healthz");
  assert.equal(health.status, 200);

  const pk = await api("GET", "/api/v1/public-key");
  assert.equal(pk.status, 200);
  publicKeyPem = pk.json.data.public_key_pem;
  assert.match(publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.equal(pk.json.data.algorithm, "Ed25519");

  const info = await api("GET", "/api/v1/server-info");
  assert.equal(info.json.data.offline_grace_days, 7);
});

test("密码错误不能登录后台", async () => {
  const bad = await api("POST", "/admin/api/auth/login", {
    email: "root@test.local",
    password: "wrong-password",
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "INVALID_CREDENTIALS");
});

test("管理员登录", async () => {
  const login = await api("POST", "/admin/api/auth/login", {
    email: "root@test.local",
    password: "RootPassw0rd!",
  });
  assert.equal(login.status, 200);
  adminToken = login.json.data.token;
  assert.ok(adminToken.length > 20);
});

test("未授权访问管理接口被拒绝", async () => {
  const res = await api("GET", "/admin/api/products");
  assert.equal(res.status, 401);
});

test("创建产品与模块", async () => {
  const product = await api(
    "POST",
    "/admin/api/products",
    { code: "app-pro", name: "专业版客户端", description: "端到端测试产品" },
    adminToken,
  );
  assert.equal(product.status, 201);
  productId = product.json.data.product.id;

  for (const [code, name] of [
    ["core", "核心模块"],
    ["report", "报表模块"],
  ] as const) {
    const mod = await api("POST", `/admin/api/products/${productId}/modules`, { code, name }, adminToken);
    assert.equal(mod.status, 201);
    moduleIds.push(mod.json.data.module.id);
  }

  const dup = await api("POST", "/admin/api/products", { code: "app-pro", name: "重复" }, adminToken);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "CODE_TAKEN");

  const list = await api("GET", "/admin/api/products", undefined, adminToken);
  assert.equal(list.json.data.items.length, 1);
  assert.equal(list.json.data.items[0].module_count, 2);
});

test("批量生成 CDK 并导出 CSV", async () => {
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: moduleIds, days: 30, seats: 2, count: 3, note: "e2e 批次" },
    adminToken,
  );
  assert.equal(gen.status, 201);
  codes = gen.json.data.codes;
  assert.equal(codes.length, 3);
  assert.match(codes[0], /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(gen.json.data.csv, /code,product,days,seats,modules,note/);

  const batchId = gen.json.data.batch.id;
  const exported = await api("GET", `/admin/api/cdks/export?batch_id=${batchId}`, undefined, adminToken);
  assert.equal(exported.status, 200);
  assert.ok(exported.text.includes(codes[0]));

  const list = await api("GET", `/admin/api/cdks?product_id=${productId}&status=unused`, undefined, adminToken);
  assert.equal(list.json.data.total, 3);
  assert.equal(list.json.data.items[0].product_code, "app-pro");
});

test("CDK 预检不核销", async () => {
  const peek = await api("POST", "/api/v1/cdks/inspect", { cdk: codes[0].toLowerCase() });
  assert.equal(peek.status, 200);
  assert.equal(peek.json.data.usable, true);
  assert.equal(peek.json.data.days, 30);
  assert.equal(peek.json.data.seats, 2);
  assert.deepEqual(peek.json.data.module_codes.sort(), ["core", "report"]);
});

test("客户注册", async () => {
  const reg = await api("POST", "/api/v1/auth/register", {
    email: "buyer@test.local",
    password: "buyerPass123",
    name: "采购方",
  });
  assert.equal(reg.status, 201);
  assert.ok(reg.json.data.session.token);

  const dup = await api("POST", "/api/v1/auth/register", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "EMAIL_TAKEN");
});

test("激活 CDK：签发可离线验签的许可证文件", async () => {
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: codes[0],
    device_id: "DEV-A",
    device_name: "测试工作站",
    platform: "win32",
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  assert.equal(act.status, 201);
  licenseKey = act.json.data.license_key;
  licenseId = act.json.data.license.id;
  licenseFile = act.json.data.license_file;

  assert.match(licenseKey, /^LK-/);
  assert.equal(act.json.data.license_no, undefined);
  assert.ok(act.json.data.days_left >= 29 && act.json.data.days_left <= 30);
  assert.equal(act.json.data.license.key_hash, undefined, "响应不能泄露密钥哈希");
  assert.equal(act.json.data.heartbeat_interval_hours, 24);

  // 离线验签：客户端只用公钥 + 许可证文件
  const verified = verifyLicenseFile(licenseFile, publicKeyPem);
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.equal(verified.payload.prd, "app-pro");
    assert.equal(verified.payload.lic, licenseId);
    assert.deepEqual([...verified.payload.mod].sort(), ["core", "report"]);
    // 离线有效期不得超过「现在 + 宽限天数」
    const graceDeadline = Math.floor(Date.now() / 1000) + 7 * 86_400 + 60;
    assert.ok(verified.payload.exp <= graceDeadline);
    // 30 天授权 > 7 天宽限，故 exp 取宽限期上限，grace_until 记录真实到期时间
    assert.ok(verified.payload.exp < verified.payload.grace_until);
    assert.ok(Math.abs(verified.payload.exp - (Math.floor(Date.now() / 1000) + 7 * 86_400)) < 120);
  }

  // 篡改 payload 后验签必须失败
  // 注意：不要用「替换末尾 N 个 base64url 字符」来构造篡改样本 —— Ed25519 的 64 字节签名
  // 编码成 86 个字符，最后一个字符的低 4 位是无效位，解码时会被丢弃，因此那样改有可能
  // 解码出与原签名完全相同的字节，导致这条断言偶发通过（约 1/4096）。改 payload 首字符最稳。
  const dotIndex = licenseFile.indexOf(".");
  const body = licenseFile.slice(0, dotIndex);
  const signature = licenseFile.slice(dotIndex + 1);

  const tamperedBody = (body[0] === "e" ? "f" : "e") + body.slice(1);
  assert.equal(
    verifyLicenseFile(tamperedBody + "." + signature, publicKeyPem).valid,
    false,
    "篡改 payload 后必须验签失败",
  );

  // 篡改签名的第一个字符（6 bit 全部有效）也必须失败
  const tamperedSig = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  assert.equal(
    verifyLicenseFile(body + "." + tamperedSig, publicKeyPem).valid,
    false,
    "篡改签名后必须验签失败",
  );
});

test("同一个 CDK 不能二次激活", async () => {
  const again = await api("POST", "/api/v1/licenses/activate", {
    cdk: codes[0],
    device_id: "DEV-A",
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "CDK_ALREADY_USED");
});

test("席位加绑与名额上限", async () => {
  const enroll = await api("POST", "/api/v1/licenses/enroll", {
    license_key: licenseKey,
    device_id: "DEV-B",
    device_name: "第二台机器",
  });
  assert.equal(enroll.status, 200);
  assert.equal(verifyLicenseFile(enroll.json.data.license_file, publicKeyPem).valid, true);

  const overflow = await api("POST", "/api/v1/licenses/enroll", {
    license_key: licenseKey,
    device_id: "DEV-C",
  });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.json.error.code, "SEAT_LIMIT");
  assert.equal(overflow.json.error.details.seats, 2);

  // 解绑一台后可以再占用
  const released = await api("POST", "/api/v1/licenses/release", {
    license_key: licenseKey,
    device_id: "DEV-B",
  });
  assert.equal(released.status, 200);
  assert.equal(released.json.data.released, true);

  const retry = await api("POST", "/api/v1/licenses/enroll", {
    license_key: licenseKey,
    device_id: "DEV-C",
  });
  assert.equal(retry.status, 200);
});

test("心跳滚动续期", async () => {
  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.status, 200);
  assert.equal(hb.json.data.license.id, licenseId);
  assert.equal(hb.json.data.license.last_heartbeat_at !== null, true);
  assert.equal(verifyLicenseFile(hb.json.data.license_file, publicKeyPem).valid, true);

  const unknownDevice = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-UNKNOWN",
  });
  assert.equal(unknownDevice.status, 404);
  assert.equal(unknownDevice.json.error.code, "DEVICE_NOT_BOUND");

  const badKey = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: "LK-not-a-real-key",
    device_id: "DEV-A",
  });
  assert.equal(badKey.status, 404);
  assert.equal(badKey.json.error.code, "INVALID_LICENSE_KEY");
});

test("后台续费延长到期时间", async () => {
  const before = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  const beforeExpiry = before.json.data.expires_at;

  const ext = await api("POST", `/admin/api/licenses/${licenseId}/extend`, { days: 365 }, adminToken);
  assert.equal(ext.status, 200);
  const afterExpiry = ext.json.data.license.expires_at;
  assert.ok(Date.parse(afterExpiry) > Date.parse(beforeExpiry), "续费后到期时间应更晚");

  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.json.data.expires_at, afterExpiry);
  // 离线文件有效期仍受宽限期约束，不会因为续费变长
  const verified = verifyLicenseFile(hb.json.data.license_file, publicKeyPem);
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.ok(verified.payload.exp <= Math.floor(Date.now() / 1000) + 7 * 86_400 + 60);
  }
});

test("授权到期后心跳被拒绝", async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const patched = await api("PATCH", `/admin/api/licenses/${licenseId}`, { expires_at: past }, adminToken);
  assert.equal(patched.status, 200);

  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.status, 403);
  assert.equal(hb.json.error.code, "LICENSE_EXPIRED");

  const list = await api("GET", "/admin/api/licenses?status=expired", undefined, adminToken);
  assert.equal(list.json.data.total, 1);
  assert.equal(list.json.data.items[0].eff_status, "expired");
});

test("吊销授权后心跳被拒绝", async () => {
  const revoked = await api("POST", `/admin/api/licenses/${licenseId}/revoke`, { reason: "测试吊销" }, adminToken);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.data.license.status, "revoked");

  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.status, 403);
  assert.equal(hb.json.error.code, "LICENSE_REVOKED");

  const enroll = await api("POST", "/api/v1/licenses/enroll", {
    license_key: licenseKey,
    device_id: "DEV-D",
  });
  assert.equal(enroll.status, 403);
});

test("恢复授权后心跳重新通过", async () => {
  const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const restored = await api(
    "PATCH",
    `/admin/api/licenses/${licenseId}`,
    { status: "active", expires_at: future },
    adminToken,
  );
  assert.equal(restored.status, 200);

  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.status, 200);
  assert.ok(hb.json.data.days_left >= 89);
});

test("客户自助查看授权与解绑设备", async () => {
  const login = await api("POST", "/api/v1/auth/login", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  assert.equal(login.status, 200);
  customerToken = login.json.data.session.token;

  const mine = await api("GET", "/api/v1/licenses", undefined, customerToken);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.data.total, 1);
  assert.equal(mine.json.data.items[0].key_hash, undefined);
  assert.ok(mine.json.data.items[0].devices.length >= 1);

  const detail = await api("GET", `/api/v1/licenses/${licenseId}`, undefined, customerToken);
  assert.deepEqual(detail.json.data.module_codes.sort(), ["core", "report"]);

  const unbound = await api(
    "POST",
    `/api/v1/licenses/${licenseId}/devices/DEV-C/release`,
    undefined,
    customerToken,
  );
  assert.equal(unbound.status, 200);

  // 后台也能解绑单个设备：解绑后该设备心跳应立即失效
  const adminRelease = await api(
    "POST",
    `/admin/api/licenses/${licenseId}/devices/DEV-A/release`,
    undefined,
    adminToken,
  );
  assert.equal(adminRelease.status, 200);
  assert.equal(adminRelease.json.data.released, true);

  const afterRelease = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(afterRelease.status, 404);
  assert.equal(afterRelease.json.error.code, "DEVICE_NOT_BOUND");

  // 重新加绑，供后续用例使用
  const rebind = await api("POST", "/api/v1/licenses/enroll", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(rebind.status, 200);
});

test("重置许可证密钥后旧密钥失效", async () => {
  const rotated = await api(
    "POST",
    `/admin/api/licenses/${licenseId}/rotate-key`,
    undefined,
    adminToken,
  );
  assert.equal(rotated.status, 200);
  const newKey = rotated.json.data.license_key;
  assert.notEqual(newKey, licenseKey);

  const oldKey = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(oldKey.status, 404);

  const newKeyHb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: newKey,
    device_id: "DEV-A",
  });
  assert.equal(newKeyHb.status, 200);
  licenseKey = newKey;
});

test("后台手动开通授权（不走 CDK）", async () => {
  const manual = await api(
    "POST",
    "/admin/api/licenses",
    { product_id: productId, customer_email: "buyer@test.local", days: 10, seats: 1, module_ids: [moduleIds[0]] },
    adminToken,
  );
  assert.equal(manual.status, 201);
  assert.match(manual.json.data.license_key, /^LK-/);
  assert.equal(manual.json.data.days_left, 10);
});

test("概览统计与审计日志", async () => {
  const overview = await api("GET", "/admin/api/overview", undefined, adminToken);
  assert.equal(overview.status, 200);
  const stats = overview.json.data.stats;
  assert.equal(stats.products, 1);
  assert.equal(stats.modules, 2);
  assert.equal(stats.licenses_total, 2);
  assert.ok(stats.cdk_unused >= 2);
  assert.ok(stats.devices_active >= 1);

  const auditList = await api("GET", "/admin/api/audit?page_size=50", undefined, adminToken);
  assert.equal(auditList.status, 200);
  assert.ok(auditList.json.data.total > 10);
  const actions = auditList.json.data.items.map((i: Json) => i.action);
  for (const expected of ["admin.login", "product.create", "cdk.generate", "license.activate", "license.extend", "license.revoke"]) {
    assert.ok(actions.includes(expected), `审计日志应包含 ${expected}`);
  }
});

test("参数校验与错误结构", async () => {
  const missing = await api("POST", "/api/v1/licenses/activate", { cdk: "AAAA-BBBB-CCCC-DDDD" });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, "MISSING_FIELD");

  const notFoundCdk = await api("POST", "/api/v1/licenses/activate", {
    cdk: "AAAA-BBBB-CCCC-DDDD",
    device_id: "DEV-X",
  });
  assert.equal(notFoundCdk.status, 404);
  assert.equal(notFoundCdk.json.error.code, "CDK_NOT_FOUND");

  const badJson = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(badJson.status, 400);

  const unknownPath = await api("GET", "/api/v1/nope");
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.json.error.code, "NOT_FOUND");
});

/* ==================== 渠道 / 分销 ==================== */

test("渠道：创建、编码校验与列表统计", async () => {
  const created = await api(
    "POST",
    "/admin/api/channels",
    { code: "TAOBAO", name: "淘宝旗舰店", contact: "张三", phone: "13800000000", note: "年框渠道" },
    adminToken,
  );
  assert.equal(created.status, 201);
  channelId = created.json.data.channel.id;
  assert.equal(created.json.data.channel.code, "taobao", "渠道编码应自动转小写");
  assert.equal(created.json.data.channel.status, "active");

  const dup = await api("POST", "/admin/api/channels", { code: "taobao", name: "重复" }, adminToken);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "CODE_TAKEN");

  const bad = await api("POST", "/admin/api/channels", { code: "BAD CODE!", name: "非法" }, adminToken);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_CODE");

  const list = await api("GET", "/admin/api/channels", undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.items.some((c: Json) => c.id === channelId));
  assert.ok(list.json.data.summary.channels >= 1);

  const detail = await api("GET", `/admin/api/channels/${channelId}`, undefined, adminToken);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.channel.code, "taobao");
  assert.equal(detail.json.data.channel.cdk_total, 0, "新渠道还没有 CDK");

  const missing = await api("GET", "/admin/api/channels/chn_not_exist", undefined, adminToken);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "CHANNEL_NOT_FOUND");
});

test("渠道：CDK 批次归属渠道并携带结算单价", async () => {
  // v4：渠道生成卡密要扣卡密余额，先充值
  const recharge = await api("POST", `/admin/api/channels/${channelId}/credit`, { amount: 100 }, adminToken);
  assert.equal(recharge.status, 200);
  assert.equal(recharge.json.data.channel.credit, 100);

  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: moduleIds,
      days: 365,
      seats: 1,
      count: 2,
      note: "渠道批次",
      channel_id: channelId,
      unit_price: 19900, // 199.00 元
    },
    adminToken,
  );
  assert.equal(gen.status, 201);
  assert.equal(gen.json.data.batch.channel_id, channelId);
  assert.equal(gen.json.data.batch.unit_price, 19900);
  channelCdkCodes = gen.json.data.codes;

  const filtered = await api("GET", `/admin/api/cdks?channel_id=${channelId}`, undefined, adminToken);
  assert.equal(filtered.json.data.total, 2);
  assert.equal(filtered.json.data.items[0].channel_code, "taobao");
  assert.equal(filtered.json.data.items[0].unit_price, 19900);

  const direct = await api("GET", "/admin/api/cdks?channel_id=__none__", undefined, adminToken);
  assert.ok(direct.json.data.items.length > 0, "之前生成的 CDK 都属于直销");
  assert.ok(direct.json.data.items.every((c: Json) => c.channel_id === null));

  const badChannel = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [], days: 30, count: 1, channel_id: "chn_not_exist" },
    adminToken,
  );
  assert.equal(badChannel.status, 404);
  assert.equal(badChannel.json.error.code, "CHANNEL_NOT_FOUND");
});

test("渠道：激活时继承渠道与单价，并按渠道聚合统计", async () => {
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: channelCdkCodes[0],
    device_id: "CHAN-DEV-1",
    device_name: "渠道测试机",
    email: "channel-buyer@test.local",
    password: "ChanBuyer123",
    name: "渠道客户",
  });
  assert.equal(act.status, 201);
  assert.equal(act.json.data.license.channel_id, channelId, "授权应继承 CDK 批次的渠道");
  assert.equal(act.json.data.license.unit_price, 19900, "授权应继承单价");

  const byChannel = await api("GET", `/admin/api/licenses?channel_id=${channelId}`, undefined, adminToken);
  assert.equal(byChannel.status, 200);
  assert.equal(byChannel.json.data.total, 1);
  assert.equal(byChannel.json.data.items[0].channel_code, "taobao");
  assert.equal(byChannel.json.data.items[0].channel_name, "淘宝旗舰店");

  const direct = await api("GET", "/admin/api/licenses?channel_id=__none__", undefined, adminToken);
  assert.ok(direct.json.data.items.every((l: Json) => l.channel_id === null), "直销筛选不应包含渠道授权");

  const chDetail = await api("GET", `/admin/api/channels/${channelId}`, undefined, adminToken);
  const c = chDetail.json.data.channel;
  assert.equal(c.cdk_total, 2);
  assert.equal(c.cdk_used, 1);
  assert.equal(c.cdk_unused, 1);
  assert.equal(c.license_total, 1);
  assert.equal(c.license_active, 1);
  assert.equal(c.revenue_total, 19900, "营收 = 已激活授权单价之和");
  assert.ok(Math.abs(c.activation_rate - 0.5) < 1e-9, "激活率 = 已核销 / 已生成");

  const overview = await api("GET", "/admin/api/overview", undefined, adminToken);
  assert.ok(overview.json.data.channels.attributed_licenses >= 1);
  assert.ok(overview.json.data.channels.revenue_total >= 19900);
});

test("渠道：被引用时禁止删除，可改为停用", async () => {
  const del = await api("DELETE", `/admin/api/channels/${channelId}`, undefined, adminToken);
  assert.equal(del.status, 409);
  assert.equal(del.json.error.code, "CHANNEL_IN_USE");
  assert.ok(del.json.error.details.batches >= 1);
  assert.ok(del.json.error.details.licenses >= 1);

  const patched = await api(
    "PATCH",
    `/admin/api/channels/${channelId}`,
    { status: "disabled", note: "渠道停用测试" },
    adminToken,
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.channel.status, "disabled");
  assert.equal(patched.json.data.channel.note, "渠道停用测试");

  // 没被引用的渠道可以删除
  const tmp = await api("POST", "/admin/api/channels", { code: "tmp-chan", name: "临时渠道" }, adminToken);
  assert.equal(tmp.status, 201);
  const delTmp = await api("DELETE", `/admin/api/channels/${tmp.json.data.channel.id}`, undefined, adminToken);
  assert.equal(delTmp.status, 200);
  assert.equal(delTmp.json.data.deleted, true);
});

test("渠道：手动开通授权也可归属渠道与单价", async () => {
  const manual = await api(
    "POST",
    "/admin/api/licenses",
    {
      product_id: productId,
      customer_email: "buyer@test.local",
      days: 30,
      seats: 1,
      module_ids: [moduleIds[0]],
      channel_id: channelId,
      unit_price: 9900,
    },
    adminToken,
  );
  assert.equal(manual.status, 201);
  assert.equal(manual.json.data.license.channel_id, channelId);
  assert.equal(manual.json.data.license.unit_price, 9900);

  const chDetail = await api("GET", `/admin/api/channels/${channelId}`, undefined, adminToken);
  assert.equal(chDetail.json.data.channel.license_total, 2);
  assert.equal(chDetail.json.data.channel.revenue_total, 19900 + 9900);
});

test("渠道：审计日志记录了渠道操作", async () => {
  const auditList = await api("GET", "/admin/api/audit?page_size=100", undefined, adminToken);
  const actions = auditList.json.data.items.map((i: Json) => i.action);
  for (const expected of ["channel.create", "channel.update", "channel.delete", "cdk.generate", "license.create"]) {
    assert.ok(actions.includes(expected), `审计日志应包含 ${expected}`);
  }
});

/* ==================== 客户新增 / 到期调整 / 设备重绑 / 试用 ==================== */

test("客户：后台新增客户", async () => {
  const created = await api(
    "POST",
    "/admin/api/customers",
    {
      email: "admin-created@test.local",
      password: "AdminCreated123",
      name: "后台建的客户",
      company: "某某公司",
      phone: "13700001234",
    },
    adminToken,
  );
  assert.equal(created.status, 201);
  assert.equal(created.json.data.customer.email, "admin-created@test.local");
  assert.equal(created.json.data.customer.company, "某某公司");
  assert.equal(created.json.data.customer.password_hash, undefined, "响应不应泄露密码哈希");
  adminCreatedCustomerId = created.json.data.customer.id;

  const dup = await api("POST", "/admin/api/customers", { email: "admin-created@test.local", name: "重复" }, adminToken);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "EMAIL_TAKEN");

  const weak = await api("POST", "/admin/api/customers", { email: "weak-pwd@test.local", password: "123" }, adminToken);
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, "WEAK_PASSWORD");

  const anon = await api("POST", "/admin/api/customers", { name: "匿名线下客户" }, adminToken);
  assert.equal(anon.status, 201);
  assert.equal(anon.json.data.customer.email, null, "允许创建无邮箱的匿名客户");

  const list = await api("GET", "/admin/api/customers?q=admin-created", undefined, adminToken);
  assert.ok(list.json.data.items.some((c: Json) => c.email === "admin-created@test.local"));
});

test("客户：按客户批量调整到期时间", async () => {
  const a = await api(
    "POST",
    "/admin/api/licenses",
    { product_id: productId, customer_email: "admin-created@test.local", days: 30, seats: 1, module_ids: [moduleIds[0]] },
    adminToken,
  );
  const b = await api(
    "POST",
    "/admin/api/licenses",
    { product_id: productId, customer_email: "admin-created@test.local", days: 30, seats: 1, module_ids: [moduleIds[0]] },
    adminToken,
  );
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const expA = a.json.data.license.expires_at;

  // 全部 +30 天
  const all = await api(
    "POST",
    `/admin/api/customers/${adminCreatedCustomerId}/adjust-expiry`,
    { days: 30 },
    adminToken,
  );
  assert.equal(all.status, 200);
  assert.equal(all.json.data.updated, 2);
  const newA = all.json.data.licenses.find((l: Json) => l.id === a.json.data.license.id);
  assert.equal(Date.parse(newA.expires_at) - Date.parse(expA), 30 * 86_400_000);

  // 只把其中一个设到指定日期
  const target = "2030-06-01T00:00:00.000Z";
  const one = await api(
    "POST",
    `/admin/api/customers/${adminCreatedCustomerId}/adjust-expiry`,
    { expires_at: target, license_ids: [b.json.data.license.id] },
    adminToken,
  );
  assert.equal(one.json.data.updated, 1);
  assert.equal(one.json.data.licenses[0].expires_at, target);

  // 两个参数都没给 → 400
  const bad = await api("POST", `/admin/api/customers/${adminCreatedCustomerId}/adjust-expiry`, {}, adminToken);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "MISSING_FIELD");
});

test("设备：后台重绑不重置到期时间，且有事件历史", async () => {
  const lic = await api(
    "POST",
    "/admin/api/licenses",
    { product_id: productId, customer_email: "admin-created@test.local", days: 100, seats: 2, module_ids: [moduleIds[0]] },
    adminToken,
  );
  const id = lic.json.data.license.id;
  const exp = lic.json.data.license.expires_at;
  const start = lic.json.data.license.starts_at;

  const bind1 = await api("POST", `/admin/api/licenses/${id}/devices`, { device_id: "RB-DEV-1", device_name: "第一台" }, adminToken);
  assert.equal(bind1.status, 200);
  assert.equal(bind1.json.data.expires_at, exp, "绑设备不能改到期时间");
  assert.equal(bind1.json.data.starts_at, start, "起始时间也不能变");
  assert.ok(bind1.json.data.license_file.length > 100);

  const bind2 = await api("POST", `/admin/api/licenses/${id}/devices`, { device_id: "RB-DEV-2", device_name: "第二台" }, adminToken);
  assert.equal(bind2.status, 200);
  assert.equal(bind2.json.data.active_devices, 2);

  // 席位已满（seats=2，已有两台在用）
  const full = await api("POST", `/admin/api/licenses/${id}/devices`, { device_id: "RB-DEV-3" }, adminToken);
  assert.equal(full.status, 409);
  assert.equal(full.json.error.code, "SEAT_LIMIT");
  assert.equal(full.json.error.details.seats, 2);

  // 解绑一台释放席位
  const rel = await api("POST", `/admin/api/licenses/${id}/devices/RB-DEV-1/release`, undefined, adminToken);
  assert.equal(rel.status, 200);
  assert.equal(rel.json.data.released, true);

  // 换机重绑：到期时间必须与首次激活一致（不重置）
  const bind3 = await api("POST", `/admin/api/licenses/${id}/devices`, { device_id: "RB-DEV-3", device_name: "换的新机器" }, adminToken);
  assert.equal(bind3.status, 200);
  assert.equal(bind3.json.data.expires_at, exp, "重绑后到期时间必须与首次激活一致");
  assert.equal(bind3.json.data.starts_at, start);

  // 事件历史：设备记录 + 审计
  const events = await api("GET", `/admin/api/licenses/${id}/events`, undefined, adminToken);
  assert.equal(events.status, 200);
  assert.ok(events.json.data.devices.length >= 3);
  const released = events.json.data.devices.find((d: Json) => d.device_id === "RB-DEV-1");
  assert.equal(released.status, "released");
  assert.ok(released.released_at, "解绑设备应有 released_at");
  const actions = events.json.data.audits.map((x: Json) => x.action);
  assert.ok(actions.includes("license.bind_device"), "事件历史应包含绑定记录");
  assert.ok(actions.includes("license.release_device"), "事件历史应包含解绑记录");
});

test("试用：配置读写、自助申请、次数限制与延长", async () => {
  const cfg = await api(
    "PATCH",
    "/admin/api/settings/trial",
    { enabled: true, days: 10, seats: 1, max_per_customer: 1, product_id: productId, offline_grace_days: 3 },
    adminToken,
  );
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.data.config.days, 10);
  assert.equal(cfg.json.data.config.product_id, productId);
  assert.equal(cfg.json.data.config.offline_grace_days, 3);

  const info = await api("GET", "/api/v1/trial/info");
  assert.equal(info.status, 200);
  assert.equal(info.json.data.enabled, true);
  assert.equal(info.json.data.days, 10);

  const reg = await api("POST", "/api/v1/auth/register", {
    email: "trial-e2e@test.local",
    password: "TrialE2e123",
    name: "试用测试",
  });
  const tToken = reg.json.data.session.token;

  const status = await api("GET", "/api/v1/trial/status", undefined, tToken);
  assert.equal(status.json.data.enabled, true);
  const item = status.json.data.items.find((x: Json) => x.product.code === "app-pro");
  assert.equal(item.remaining, 1);

  const started = await api("POST", "/api/v1/trial/start", { device_id: "TRIAL-DEV-1", device_name: "试用机" }, tToken);
  assert.equal(started.status, 201);
  assert.equal(started.json.data.license.kind, "trial");
  assert.equal(started.json.data.license.source, "trial");
  assert.equal(started.json.data.license.offline_grace_days, 3, "试用应使用配置的离线宽限");
  assert.ok(started.json.data.days_left >= 9 && started.json.data.days_left <= 10);
  trialLicenseId = started.json.data.license.id;

  // 同一产品不可再次试用
  const again = await api("POST", "/api/v1/trial/start", { device_id: "TRIAL-DEV-2" }, tToken);
  assert.equal(again.status, 403);
  assert.equal(again.json.error.code, "TRIAL_ALREADY_USED");

  // 后台延长试用
  const before = started.json.data.license.expires_at;
  const ext = await api("POST", `/admin/api/licenses/${trialLicenseId}/extend`, { days: 10 }, adminToken);
  assert.equal(Date.parse(ext.json.data.license.expires_at) - Date.parse(before), 10 * 86_400_000);

  // 按类型筛选
  const trials = await api("GET", "/admin/api/licenses?kind=trial", undefined, adminToken);
  assert.ok(trials.json.data.items.every((l: Json) => l.kind === "trial"));

  // 关闭试用后不能再申请
  await api("PATCH", "/admin/api/settings/trial", { enabled: false }, adminToken);
  const reg2 = await api("POST", "/api/v1/auth/register", { email: "trial-off@test.local", password: "TrialOff123" });
  const off = await api("POST", "/api/v1/trial/start", { device_id: "TRIAL-DEV-3" }, reg2.json.data.session.token);
  assert.equal(off.status, 403);
  assert.equal(off.json.error.code, "TRIAL_DISABLED");

  // 恢复试用开关
  const restored = await api("PATCH", "/admin/api/settings/trial", { enabled: true }, adminToken);
  assert.equal(restored.json.data.config.enabled, true);
});

test("CDK：列表带出激活后的到期时间", async () => {
  const list = await api("GET", "/admin/api/cdks?status=used", undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.items.length > 0);
  const withExpiry = list.json.data.items.filter((c: Json) => c.license_expires_at);
  assert.ok(withExpiry.length > 0, "已使用的 CDK 应带出授权到期时间");
  assert.ok(["paid", "trial"].includes(withExpiry[0].license_kind));
});

test("API 文档公开可访问（无需登录）", async () => {
  // JSON：无需 token
  const json = await api("GET", "/api/v1/docs");
  assert.equal(json.status, 200, "文档 JSON 不应要求鉴权");
  assert.ok(json.json.data.total >= 60, "应包含全部已注册路由");
  assert.equal(json.json.data.missing.length, 0, "所有路由都应有说明");
  assert.ok(json.json.data.groups.length >= 10);

  // 网页版：无需登录，返回完整 HTML
  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.toLowerCase().startsWith("<!doctype html>"));
  assert.ok(html.includes("API 文档"));
  assert.ok(html.includes("/api/v1/licenses/activate"), "页面应列出客户端接口");
  assert.ok(html.includes("/admin/api/licenses"), "页面应列出管理接口（全部公开）");

  // 后台端点保留，仍要求管理员 token
  const adminDocs = await api("GET", "/admin/api/docs");
  assert.equal(adminDocs.status, 401);
});

/* ==================== 员工与代理权限 ==================== */

test("员工账号：按菜单/功能权限受限", async () => {
  const created = await api(
    "POST",
    "/admin/api/staff",
    {
      email: "staff-e2e@test.local",
      password: "StaffPass123",
      name: "受限员工",
      role: "staff",
      menus: ["cdks", "licenses"],
      features: ["cdk.generate"],
    },
    adminToken,
  );
  assert.equal(created.status, 201);
  const staffId = created.json.data.staff.id;
  assert.equal(created.json.data.staff.role, "staff");
  assert.deepEqual(created.json.data.staff.permissions.menus, ["cdks", "licenses"]);
  assert.deepEqual(created.json.data.staff.permissions.features, ["cdk.generate"]);

  const login = await api("POST", "/admin/api/auth/login", {
    email: "staff-e2e@test.local",
    password: "StaffPass123",
  });
  assert.equal(login.status, 200);
  const staffToken = login.json.data.token;
  assert.deepEqual(login.json.data.admin.permissions.features, ["cdk.generate"], "登录响应应带权限");

  // 有权限：生成卡密
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 1 },
    staffToken,
  );
  assert.equal(gen.status, 201, "员工有 cdk.generate 应该能生成");

  // 无权限：改产品 → 403
  const patchProduct = await api("PATCH", `/admin/api/products/${productId}`, { name: "改名" }, staffToken);
  assert.equal(patchProduct.status, 403);
  assert.equal(patchProduct.json.error.code, "FORBIDDEN_FEATURE");

  // 非 owner：不能管员工
  const staffList = await api("GET", "/admin/api/staff", undefined, staffToken);
  assert.equal(staffList.status, 403);

  // owner 能管
  const ownerList = await api("GET", "/admin/api/staff", undefined, adminToken);
  assert.ok(ownerList.json.data.items.some((s: Json) => s.id === staffId));

  // 停用后会话立即失效
  const disabled = await api("PATCH", `/admin/api/staff/${staffId}`, { status: "disabled" }, adminToken);
  assert.equal(disabled.status, 200);
  const afterDisable = await api("GET", "/admin/api/cdks", undefined, staffToken);
  assert.equal(afterDisable.status, 401, "停用员工后其会话应立即失效");
});

test("代理账号：绑定渠道、权限固定、只能碰卡密", async () => {
  const created = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-e2e@test.local", password: "AgentPass123", name: "代理甲", role: "agent", channel_id: channelId },
    adminToken,
  );
  assert.equal(created.status, 201);
  assert.equal(created.json.data.staff.role, "agent");
  assert.equal(created.json.data.staff.channel_id, channelId);
  assert.deepEqual(created.json.data.staff.permissions.menus, ["cdks"], "代理只看卡密页");

  const login = await api("POST", "/admin/api/auth/login", {
    email: "agent-e2e@test.local",
    password: "AgentPass123",
  });
  const agentToken = login.json.data.token;

  // 代理被限制在卡密相关接口
  for (const p of ["/admin/api/licenses", "/admin/api/customers", "/admin/api/channels"]) {
    const res = await api("GET", p, undefined, agentToken);
    assert.equal(res.status, 403, `${p} 应被代理拒绝`);
  }

  // 代理不能管员工
  const staffRes = await api("GET", "/admin/api/staff", undefined, agentToken);
  assert.equal(staffRes.status, 403);
});

test("员工/代理创建的参数校验", async () => {
  const noChannel = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-noc@test.local", password: "AgentPass123", role: "agent" },
    adminToken,
  );
  assert.equal(noChannel.status, 400);
  assert.equal(noChannel.json.error.code, "MISSING_FIELD");

  const badRole = await api(
    "POST",
    "/admin/api/staff",
    { email: "x-role@test.local", password: "StaffPass123", role: "owner" },
    adminToken,
  );
  assert.equal(badRole.status, 400);
  assert.equal(badRole.json.error.code, "INVALID_FIELD");

  const weak = await api(
    "POST",
    "/admin/api/staff",
    { email: "x-weak@test.local", password: "123", role: "staff" },
    adminToken,
  );
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, "WEAK_PASSWORD");
});

/* ==================== 卡密计费类型 ==================== */

test("次数型卡密：激活后按次消耗，用完拒绝", async () => {
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: [moduleIds[0]],
      term_type: "count",
      term_value: 5,
      count: 1,
      seats: 1,
      note: "次数卡",
    },
    adminToken,
  );
  assert.equal(gen.status, 201);
  assert.equal(gen.json.data.batch.term_type, "count");
  assert.equal(gen.json.data.batch.term_value, 5);

  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: gen.json.data.codes[0],
    device_id: "COUNT-DEV-1",
    email: "count-buyer@test.local",
    password: "CountPass123",
  });
  assert.equal(act.status, 201);
  assert.equal(act.json.data.license.term_type, "count");
  assert.equal(act.json.data.license.max_usages, 5);
  assert.equal(act.json.data.license_payload.usage.max, 5);
  assert.equal(act.json.data.license_payload.usage.used, 0);
  const key = act.json.data.license_key;

  const c1 = await api("POST", "/api/v1/licenses/consume", { license_key: key, device_id: "COUNT-DEV-1", count: 3 });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.data.remaining, 2);

  const over = await api("POST", "/api/v1/licenses/consume", { license_key: key, device_id: "COUNT-DEV-1", count: 3 });
  assert.equal(over.status, 403);
  assert.equal(over.json.error.code, "USAGE_EXHAUSTED");
  assert.equal(over.json.error.details.remaining, 2);

  const exact = await api("POST", "/api/v1/licenses/consume", { license_key: key, device_id: "COUNT-DEV-1", count: 2 });
  assert.equal(exact.json.data.remaining, 0);

  const after = await api("POST", "/api/v1/licenses/consume", { license_key: key, device_id: "COUNT-DEV-1" });
  assert.equal(after.status, 403);
  assert.equal(after.json.error.code, "USAGE_EXHAUSTED");
});

test("按时长计费：小时卡与天卡到期精确，月卡落在合理区间", async () => {
  const cases = [
    { type: "hour", value: 6, expect: 6 * 3_600_000 },
    { type: "day", value: 3, expect: 3 * 86_400_000 },
  ];
  for (const c of cases) {
    const gen = await api(
      "POST",
      "/admin/api/cdks/generate",
      { product_id: productId, module_ids: [moduleIds[0]], term_type: c.type, term_value: c.value, count: 1, seats: 1 },
      adminToken,
    );
    assert.equal(gen.status, 201);
    const act = await api("POST", "/api/v1/licenses/activate", {
      cdk: gen.json.data.codes[0],
      device_id: `TERM-${c.type}-1`,
      email: `term-${c.type}@test.local`,
      password: "TermPass123",
    });
    assert.equal(act.status, 201);
    assert.equal(act.json.data.license.term_type, c.type);
    const delta = Date.parse(act.json.data.expires_at) - Date.parse(act.json.data.license.starts_at);
    assert.equal(delta, c.expect, `${c.type} 类型到期时长应正确`);
  }

  const monthGen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "month", term_value: 2, count: 1, seats: 1 },
    adminToken,
  );
  const monthAct = await api("POST", "/api/v1/licenses/activate", {
    cdk: monthGen.json.data.codes[0],
    device_id: "TERM-MONTH-1",
    email: "term-month@test.local",
    password: "TermPass123",
  });
  const ms = Date.parse(monthAct.json.data.expires_at) - Date.parse(monthAct.json.data.license.starts_at);
  assert.ok(ms >= 58 * 86_400_000 && ms <= 62 * 86_400_000, "2 个自然月应落在 58~62 天之间");
});

test("非次数型授权调用消耗接口被拒", async () => {
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 1, seats: 1 },
    adminToken,
  );
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: gen.json.data.codes[0],
    device_id: "NONCOUNT-1",
    email: "noncount@test.local",
    password: "NonCount123",
  });
  const res = await api("POST", "/api/v1/licenses/consume", {
    license_key: act.json.data.license_key,
    device_id: "NONCOUNT-1",
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "NOT_COUNT_LICENSE");
});

/* ==================== 代理额度 ==================== */

test("管理员出卡不扣代理额度（属赠送）", async () => {
  const ch = await api("POST", "/admin/api/channels", { code: "gift-test", name: "赠送测试" }, adminToken);
  const cid = ch.json.data.channel.id;

  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 5, channel_id: cid },
    adminToken,
  );
  assert.equal(gen.status, 201, "余额为 0 时管理员仍可出卡");

  const detail = await api("GET", `/admin/api/channels/${cid}`, undefined, adminToken);
  assert.equal(detail.json.data.channel.balance, 0, "管理员出卡不应扣金额");
  assert.equal(detail.json.data.channel.credit, 0, "也不应扣张数");
});

test("代理登录后生成卡密受自己渠道余额限制", async () => {
  // v5：代理按金额扣费，先配价并充值余额
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 50 }, adminToken);
  await api("POST", `/admin/api/channels/${channelId}/balance`, { amount: 500000 }, adminToken);  // 用已充值的渠道建代理（此时余额 5）
  const created = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-credit@test.local", password: "AgentCredit123", role: "agent", channel_id: channelId },
    adminToken,
  );
  assert.equal(created.status, 201);

  const login = await api("POST", "/admin/api/auth/login", {
    email: "agent-credit@test.local",
    password: "AgentCredit123",
  });
  const agentToken = login.json.data.token;

  // 代理生成的卡密自动归属自己渠道
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 2 },
    agentToken,
  );
  assert.equal(gen.status, 201);
  assert.equal(gen.json.data.batch.channel_id, channelId, "代理生成的卡密必须归属自己的渠道");

  // 代理只能看到自己渠道的卡密（即使传了 __none__ 也会被强制回自己渠道）
  const list = await api("GET", "/admin/api/cdks?channel_id=__none__", undefined, agentToken);
  assert.ok(list.json.data.items.length > 0, "代理应能看到自己渠道的卡密");
  assert.ok(
    list.json.data.items.every((c: Json) => c.channel_id === channelId),
    "代理不能看到其它渠道或直销的卡密",
  );
});

test("试用按次数模式配置生效，已购客户不能再试用", async () => {
  const patched = await api(
    "PATCH",
    "/admin/api/settings/trial",
    { enabled: true, mode: "count", value: 3 },
    adminToken,
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.config.mode, "count");
  assert.equal(patched.json.data.config.value, 3);

  // 已有正式授权的客户不允许再试用
  const login = await api("POST", "/api/v1/auth/login", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  const buyerToken = login.json.data.session.token;
  const denied = await api("POST", "/api/v1/trial/start", { device_id: "TRIAL-BUYER-1" }, buyerToken);
  assert.equal(denied.status, 403);
  assert.ok(
    ["TRIAL_NOT_ALLOWED", "TRIAL_ALREADY_USED"].includes(denied.json.error.code),
    `应拒绝试用，实际 ${denied.json.error.code}`,
  );

  // 恢复按天模式，避免影响其他用例
  await api("PATCH", "/admin/api/settings/trial", { mode: "day", value: 14 }, adminToken);
});

/* ==================== 代理按价格扣费 ==================== */

test("代理按价格扣费：可售范围、价格缺失、余额不足、批量充值", async () => {
  // 价格：产品默认 day=100 分/天，模块 core 覆盖 200 分/天，month=5000 分/月
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 100 }, adminToken);
  await api(
    "POST",
    "/admin/api/prices",
    { product_id: productId, module_id: moduleIds[0], term_type: "day", unit_price: 200 },
    adminToken,
  );
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "month", unit_price: 5000 }, adminToken);

  const prices = await api("GET", `/admin/api/prices?product_id=${productId}`, undefined, adminToken);
  assert.ok(prices.json.data.items.length >= 3);

  const ch = await api("POST", "/admin/api/channels", { code: "agent-pay", name: "按价代理" }, adminToken);
  const cid = ch.json.data.channel.id;

  const agent = await api(
    "POST",
    "/admin/api/staff",
    {
      email: "agent-pay@test.local",
      password: "AgentPay123",
      role: "agent",
      channel_id: cid,
      term_types: ["day", "month"],
    },
    adminToken,
  );
  assert.equal(agent.status, 201);
  const agentId = agent.json.data.staff.id;
  const agentToken = (
    await api("POST", "/admin/api/auth/login", { email: "agent-pay@test.local", password: "AgentPay123" })
  ).json.data.token;

  // 余额 0：模块覆盖价 200 × 30 天 = 6000 分 → 余额不足
  const noBal = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "day", term_value: 30, count: 1 },
    agentToken,
  );
  assert.equal(noBal.status, 409);
  assert.equal(noBal.json.error.code, "BALANCE_INSUFFICIENT");
  assert.equal(noBal.json.error.details.needed, 6000, "应使用模块覆盖价 200×30");

  // 充值 100 元
  const topup = await api("POST", `/admin/api/channels/${cid}/balance`, { amount: 10000 }, adminToken);
  assert.equal(topup.json.data.channel.balance, 10000);

  // 生成成功并扣费
  const ok = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "day", term_value: 30, count: 1 },
    agentToken,
  );
  assert.equal(ok.status, 201);
  const after = await api("GET", `/admin/api/channels/${cid}`, undefined, adminToken);
  assert.equal(after.json.data.channel.balance, 4000, "10000 - 6000 = 4000");

  // 卡类型不在可售范围
  const badTerm = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "hour", term_value: 2, count: 1 },
    agentToken,
  );
  assert.equal(badTerm.status, 403);
  assert.equal(badTerm.json.error.code, "AGENT_TERM_DENIED");

  // 放开 count 类型但未配价 → PRICE_NOT_CONFIGURED
  await api("PATCH", `/admin/api/staff/${agentId}`, { term_types: ["day", "month", "count"] }, adminToken);
  const noPrice = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "count", term_value: 5, count: 1 },
    agentToken,
  );
  assert.equal(noPrice.status, 409);
  assert.equal(noPrice.json.error.code, "PRICE_NOT_CONFIGURED");

  // 一键批量充值
  const batch = await api("POST", "/admin/api/channels/batch-balance", { amount: 5000 }, adminToken);
  assert.equal(batch.status, 200);
  assert.ok(batch.json.data.updated >= 2, "应对全部渠道生效");
  const cidAfter = await api("GET", `/admin/api/channels/${cid}`, undefined, adminToken);
  assert.equal(cidAfter.json.data.channel.balance, 9000, "4000 + 5000");
});


/* ==================== 价格三层 + 页面拆分 ==================== */

test("价格三层：代理覆盖优先、未配则回落全局；员工列表不含代理；产品试用配置", async () => {
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 100 }, adminToken);

  const ch = await api("POST", "/admin/api/channels", { code: "tier-test", name: "分层定价代理" }, adminToken);
  const cid = ch.json.data.channel.id;

  await api(
    "POST",
    "/admin/api/staff",
    {
      email: "tier-agent@test.local",
      password: "TierAgent123",
      role: "agent",
      channel_id: cid,
      term_types: ["day"],
    },
    adminToken,
  );
  const agentToken = (
    await api("POST", "/admin/api/auth/login", { email: "tier-agent@test.local", password: "TierAgent123" })
  ).json.data.token;

  // 代理没配覆盖价 → 回落全局 100
  const estGlobal = await api(
    "POST",
    "/admin/api/cdks/estimate",
    { product_id: productId, module_ids: [], term_type: "day", term_value: 10, count: 1 },
    agentToken,
  );
  assert.equal(estGlobal.json.data.unit_price, 100, "应回落全局价");
  assert.equal(estGlobal.json.data.total_price, 1000);

  // 配代理覆盖价 60 → 估价优先取覆盖价
  await api(
    "POST",
    "/admin/api/prices",
    { channel_id: cid, product_id: productId, term_type: "day", unit_price: 60 },
    adminToken,
  );
  const estOwn = await api(
    "POST",
    "/admin/api/cdks/estimate",
    { product_id: productId, module_ids: [], term_type: "day", term_value: 10, count: 1 },
    agentToken,
  );
  assert.equal(estOwn.json.data.unit_price, 60, "应优先用代理覆盖价");
  assert.equal(estOwn.json.data.total_price, 600);

  // 员工列表只含员工，代理列表只含代理
  const staffList = await api("GET", "/admin/api/staff?role=staff", undefined, adminToken);
  assert.ok(
    staffList.json.data.items.every((a: Json) => a.role === "staff"),
    "员工列表不应出现代理",
  );
  const agentList = await api("GET", "/admin/api/staff?role=agent", undefined, adminToken);
  assert.ok(
    agentList.json.data.items.some((a: Json) => a.email === "tier-agent@test.local"),
    "代理列表应包含该代理",
  );

  // 产品级试用配置
  const trialGet = await api("GET", `/admin/api/products/${productId}/trial`, undefined, adminToken);
  assert.ok(trialGet.json.data.global, "应同时返回全局默认值");
  const trialSet = await api(
    "PATCH",
    `/admin/api/products/${productId}/trial`,
    { enabled: true, mode: "count", value: 5 },
    adminToken,
  );
  assert.equal(trialSet.json.data.config.mode, "count");
  assert.equal(trialSet.json.data.config.value, 5);
});
