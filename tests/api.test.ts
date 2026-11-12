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

  // 篡改内容后验签必须失败
  const tampered = `${licenseFile.slice(0, -2)}AA`;
  assert.equal(verifyLicenseFile(tampered, publicKeyPem).valid, false);
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
