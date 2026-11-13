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
/* 代理 / 分销 */
let agentId = "";
let agentCdkCodes: string[] = [];
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

test("授权到期后心跳仍可通行，但模块全部不可用", async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const patched = await api("PATCH", `/admin/api/licenses/${licenseId}`, { expires_at: past }, adminToken);
  assert.equal(patched.status, 200);

  // v11：到期是软状态——心跳不再 403，账号和授权信息照常返回，
  //      客户端按 modules[].active 判断功能是否可用。
  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: licenseKey,
    device_id: "DEV-A",
  });
  assert.equal(hb.status, 200, "到期不应再拒绝心跳");
  assert.equal(hb.json.data.expired, true);
  assert.equal(hb.json.data.status, "expired");
  assert.equal(
    hb.json.data.modules.every((m: Json) => m.active === false),
    true,
    "过期后所有模块都不可用",
  );
  assert.deepEqual(hb.json.data.module_codes, [], "老客户端看到的模块列表为空，功能随之下线");

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

/* ==================== 代理 / 分销 ==================== */

test("代理：创建、编码校验与列表统计", async () => {
  const created = await api(
    "POST",
    "/admin/api/agents",
    { code: "TAOBAO", name: "淘宝旗舰店", contact: "张三", phone: "13800000000", note: "年框代理" },
    adminToken,
  );
  assert.equal(created.status, 201);
  agentId = created.json.data.agent.id;
  assert.equal(created.json.data.agent.code, "taobao", "代理编码应自动转小写");
  assert.equal(created.json.data.agent.status, "active");

  const dup = await api("POST", "/admin/api/agents", { code: "taobao", name: "重复" }, adminToken);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "CODE_TAKEN");

  const bad = await api("POST", "/admin/api/agents", { code: "BAD CODE!", name: "非法" }, adminToken);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_CODE");

  const list = await api("GET", "/admin/api/agents", undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.items.some((c: Json) => c.id === agentId));
  assert.ok(list.json.data.summary.agents >= 1);

  const detail = await api("GET", `/admin/api/agents/${agentId}`, undefined, adminToken);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.agent.code, "taobao");
  assert.equal(detail.json.data.agent.cdk_total, 0, "新代理还没有 CDK");

  const missing = await api("GET", "/admin/api/agents/chn_not_exist", undefined, adminToken);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "AGENT_NOT_FOUND");
});

test("代理：CDK 批次归属代理并携带结算单价", async () => {
  // v4：代理生成卡密要扣卡密余额，先充值
  const recharge = await api("POST", `/admin/api/agents/${agentId}/credit`, { amount: 100 }, adminToken);
  assert.equal(recharge.status, 200);
  assert.equal(recharge.json.data.agent.credit, 100);

  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: moduleIds,
      days: 365,
      seats: 1,
      count: 2,
      note: "代理批次",
      agent_id: agentId,
      unit_price: 19900, // 199.00 元
    },
    adminToken,
  );
  assert.equal(gen.status, 201);
  assert.equal(gen.json.data.batch.agent_id, agentId);
  assert.equal(gen.json.data.batch.unit_price, 19900);
  agentCdkCodes = gen.json.data.codes;

  const filtered = await api("GET", `/admin/api/cdks?agent_id=${agentId}`, undefined, adminToken);
  assert.equal(filtered.json.data.total, 2);
  assert.equal(filtered.json.data.items[0].agent_code, "taobao");
  assert.equal(filtered.json.data.items[0].unit_price, 19900);

  const direct = await api("GET", "/admin/api/cdks?agent_id=__none__", undefined, adminToken);
  assert.ok(direct.json.data.items.length > 0, "之前生成的 CDK 都属于直销");
  assert.ok(direct.json.data.items.every((c: Json) => c.agent_id === null));

  const badAgent = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [], days: 30, count: 1, agent_id: "chn_not_exist" },
    adminToken,
  );
  assert.equal(badAgent.status, 404);
  assert.equal(badAgent.json.error.code, "AGENT_NOT_FOUND");
});

test("代理：激活时继承代理与单价，并按代理聚合统计", async () => {
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: agentCdkCodes[0],
    device_id: "CHAN-DEV-1",
    device_name: "代理测试机",
    email: "agent-buyer@test.local",
    password: "ChanBuyer123",
    name: "代理客户",
  });
  assert.equal(act.status, 201);
  assert.equal(act.json.data.license.agent_id, agentId, "授权应继承 CDK 批次的代理");
  assert.equal(act.json.data.license.unit_price, 19900, "授权应继承单价");

  const byAgent = await api("GET", `/admin/api/licenses?agent_id=${agentId}`, undefined, adminToken);
  assert.equal(byAgent.status, 200);
  assert.equal(byAgent.json.data.total, 1);
  assert.equal(byAgent.json.data.items[0].agent_code, "taobao");
  assert.equal(byAgent.json.data.items[0].agent_name, "淘宝旗舰店");

  const direct = await api("GET", "/admin/api/licenses?agent_id=__none__", undefined, adminToken);
  assert.ok(direct.json.data.items.every((l: Json) => l.agent_id === null), "直销筛选不应包含代理授权");

  const chDetail = await api("GET", `/admin/api/agents/${agentId}`, undefined, adminToken);
  const c = chDetail.json.data.agent;
  assert.equal(c.cdk_total, 2);
  assert.equal(c.cdk_used, 1);
  assert.equal(c.cdk_unused, 1);
  assert.equal(c.license_total, 1);
  assert.equal(c.license_active, 1);
  assert.equal(c.revenue_total, 19900, "营收 = 已激活授权单价之和");
  assert.ok(Math.abs(c.activation_rate - 0.5) < 1e-9, "激活率 = 已核销 / 已生成");

  const overview = await api("GET", "/admin/api/overview", undefined, adminToken);
  assert.ok(overview.json.data.agents.attributed_licenses >= 1);
  assert.ok(overview.json.data.agents.revenue_total >= 19900);
});

test("代理：被引用时禁止删除，可改为停用", async () => {
  const del = await api("DELETE", `/admin/api/agents/${agentId}`, undefined, adminToken);
  assert.equal(del.status, 409);
  assert.equal(del.json.error.code, "AGENT_IN_USE");
  assert.ok(del.json.error.details.batches >= 1);
  assert.ok(del.json.error.details.licenses >= 1);

  const patched = await api(
    "PATCH",
    `/admin/api/agents/${agentId}`,
    { status: "disabled", note: "代理停用测试" },
    adminToken,
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.agent.status, "disabled");
  assert.equal(patched.json.data.agent.note, "代理停用测试");

  // 没被引用的代理可以删除
  const tmp = await api("POST", "/admin/api/agents", { code: "tmp-chan", name: "临时代理" }, adminToken);
  assert.equal(tmp.status, 201);
  const delTmp = await api("DELETE", `/admin/api/agents/${tmp.json.data.agent.id}`, undefined, adminToken);
  assert.equal(delTmp.status, 200);
  assert.equal(delTmp.json.data.deleted, true);
});

test("代理：手动开通授权也可归属代理与单价", async () => {
  const manual = await api(
    "POST",
    "/admin/api/licenses",
    {
      product_id: productId,
      customer_email: "buyer@test.local",
      days: 30,
      seats: 1,
      module_ids: [moduleIds[0]],
      agent_id: agentId,
      unit_price: 9900,
    },
    adminToken,
  );
  assert.equal(manual.status, 201);
  assert.equal(manual.json.data.license.agent_id, agentId);
  assert.equal(manual.json.data.license.unit_price, 9900);

  const chDetail = await api("GET", `/admin/api/agents/${agentId}`, undefined, adminToken);
  assert.equal(chDetail.json.data.agent.license_total, 2);
  assert.equal(chDetail.json.data.agent.revenue_total, 19900 + 9900);
});

test("代理：审计日志记录了代理操作", async () => {
  const auditList = await api("GET", "/admin/api/audit?page_size=100", undefined, adminToken);
  const actions = auditList.json.data.items.map((i: Json) => i.action);
  for (const expected of ["agent.create", "agent.update", "agent.delete", "cdk.generate", "license.create"]) {
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
  assert.ok(item.modules.length >= 1, "应列出可试用的模块");
  assert.equal(item.modules[0].remaining, 1);

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

test("模块级试用：每个模块按自己的天数开通", async () => {
  const DAY_MS = 86_400_000;
  // core 试用 7 天，report 试用 3 天
  const cfgA = await api(
    "PATCH",
    `/admin/api/modules/${moduleIds[0]}/trial`,
    { enabled: true, mode: "day", value: 7, seats: 1, max_per_customer: 2 },
    adminToken,
  );
  assert.equal(cfgA.status, 200);
  assert.equal(cfgA.json.data.config.value, 7);
  assert.equal(cfgA.json.data.custom, true, "应标记为模块自定义");
  const cfgB = await api(
    "PATCH",
    `/admin/api/modules/${moduleIds[1]}/trial`,
    { enabled: true, mode: "day", value: 3, seats: 1, max_per_customer: 2 },
    adminToken,
  );
  assert.equal(cfgB.json.data.config.value, 3);

  const reg = await api("POST", "/api/v1/auth/register", {
    email: "modtrial@test.local",
    password: "ModTrial123",
  });
  const token = reg.json.data.session.token;

  const info = await api("GET", "/api/v1/trial/info");
  const ia = info.json.data.modules.find((m: Json) => m.code === "core");
  const ib = info.json.data.modules.find((m: Json) => m.code === "report");
  assert.equal(ia.days, 7, "core 应下发 7 天");
  assert.equal(ib.days, 3, "report 应下发 3 天");

  const before = Date.now();
  const started = await api("POST", "/api/v1/trial/start", { device_id: "MT-1" }, token);
  assert.equal(started.status, 201);
  const ma = started.json.data.modules.find((m: Json) => m.code === "core");
  const mb = started.json.data.modules.find((m: Json) => m.code === "report");
  assert.ok(
    Math.abs(Date.parse(ma.expires_at) - (before + 7 * DAY_MS)) < 15000,
    "core 模块应试用 7 天",
  );
  assert.ok(
    Math.abs(Date.parse(mb.expires_at) - (before + 3 * DAY_MS)) < 15000,
    "report 模块应试用 3 天",
  );
  assert.ok(Date.parse(mb.expires_at) < Date.parse(ma.expires_at), "两个模块到期时间应不同");

  // 清理模块级配置，避免影响后续用例（回到继承产品/全局）
  await api("DELETE", `/admin/api/modules/${moduleIds[0]}/trial`, undefined, adminToken);
  await api("DELETE", `/admin/api/modules/${moduleIds[1]}/trial`, undefined, adminToken);
});

test("模块级试用：次数型按模块各自扣减", async () => {
  // 只让 report 按次数试用（2 次），core 关闭试用
  await api("PATCH", `/admin/api/modules/${moduleIds[0]}/trial`, { enabled: false }, adminToken);
  const cfg = await api(
    "PATCH",
    `/admin/api/modules/${moduleIds[1]}/trial`,
    { enabled: true, mode: "count", value: 2, seats: 1, max_per_customer: 3 },
    adminToken,
  );
  assert.equal(cfg.json.data.config.mode, "count");

  const reg = await api("POST", "/api/v1/auth/register", {
    email: "modcount@test.local",
    password: "ModCount123",
  });
  const token = reg.json.data.session.token;
  const started = await api("POST", "/api/v1/trial/start", { device_id: "MC-1" }, token);
  assert.equal(started.status, 201);
  assert.equal(started.json.data.module_codes.length, 1, "只有 report 开放试用");
  const key = started.json.data.license_key;

  const consume = () =>
    api("POST", "/api/v1/licenses/consume", {
      license_key: key,
      device_id: "MC-1",
      module_code: "report",
    });

  const c1 = await consume();
  assert.equal(c1.status, 200);
  assert.equal(c1.json.data.remaining, 1, "模块自己的额度应扣到 1");
  const c2 = await consume();
  assert.equal(c2.json.data.remaining, 0);
  const c3 = await consume();
  assert.equal(c3.status, 403);
  assert.equal(c3.json.error.code, "USAGE_EXHAUSTED");

  // 清理模块级配置
  await api("DELETE", `/admin/api/modules/${moduleIds[0]}/trial`, undefined, adminToken);
  await api("DELETE", `/admin/api/modules/${moduleIds[1]}/trial`, undefined, adminToken);
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

test("代理账号：绑定代理、权限固定、只能碰卡密", async () => {
  const created = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-e2e@test.local", password: "AgentPass123", name: "代理甲", role: "agent", agent_id: agentId },
    adminToken,
  );
  assert.equal(created.status, 201);
  assert.equal(created.json.data.staff.role, "agent");
  assert.equal(created.json.data.staff.agent_id, agentId);
  assert.deepEqual(created.json.data.staff.permissions.menus, ["cdks", "customers"], "代理可看卡密页与自己名下的客户");

  const login = await api("POST", "/admin/api/auth/login", {
    email: "agent-e2e@test.local",
    password: "AgentPass123",
  });
  const agentToken = login.json.data.token;

  // 代理被限制在卡密相关接口
  for (const p of ["/admin/api/licenses", "/admin/api/agents"]) {
    const res = await api("GET", p, undefined, agentToken);
    assert.equal(res.status, 403, `${p} 应被代理拒绝`);
  }

  // 代理不能管员工
  const staffRes = await api("GET", "/admin/api/staff", undefined, agentToken);
  assert.equal(staffRes.status, 403);
});

test("员工/代理创建的参数校验", async () => {
  const noAgent = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-noc@test.local", password: "AgentPass123", role: "agent" },
    adminToken,
  );
  assert.equal(noAgent.status, 400);
  assert.equal(noAgent.json.error.code, "MISSING_FIELD");

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
  const ch = await api("POST", "/admin/api/agents", { code: "gift-test", name: "赠送测试" }, adminToken);
  const cid = ch.json.data.agent.id;

  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 5, agent_id: cid },
    adminToken,
  );
  assert.equal(gen.status, 201, "余额为 0 时管理员仍可出卡");

  const detail = await api("GET", `/admin/api/agents/${cid}`, undefined, adminToken);
  assert.equal(detail.json.data.agent.balance, 0, "管理员出卡不应扣金额");
  assert.equal(detail.json.data.agent.credit, 0, "也不应扣张数");
});

test("代理登录后生成卡密受自己代理余额限制", async () => {
  // v5：代理按金额扣费，先配价并充值余额
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 50 }, adminToken);
  await api("POST", `/admin/api/agents/${agentId}/balance`, { amount: 500000 }, adminToken);  // 用已充值的代理建代理（此时余额 5）
  const created = await api(
    "POST",
    "/admin/api/staff",
    { email: "agent-credit@test.local", password: "AgentCredit123", role: "agent", agent_id: agentId },
    adminToken,
  );
  assert.equal(created.status, 201);

  const login = await api("POST", "/admin/api/auth/login", {
    email: "agent-credit@test.local",
    password: "AgentCredit123",
  });
  const agentToken = login.json.data.token;

  // 代理生成的卡密自动归属自己代理
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 2 },
    agentToken,
  );
  assert.equal(gen.status, 201);
  assert.equal(gen.json.data.batch.agent_id, agentId, "代理生成的卡密必须归属自己的代理");

  // 代理只能看到自己代理的卡密（即使传了 __none__ 也会被强制回自己代理）
  const list = await api("GET", "/admin/api/cdks?agent_id=__none__", undefined, agentToken);
  assert.ok(list.json.data.items.length > 0, "代理应能看到自己代理的卡密");
  assert.ok(
    list.json.data.items.every((c: Json) => c.agent_id === agentId),
    "代理不能看到其它代理或直销的卡密",
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

  const ch = await api("POST", "/admin/api/agents", { code: "agent-pay", name: "按价代理" }, adminToken);
  const cid = ch.json.data.agent.id;

  const agent = await api(
    "POST",
    "/admin/api/staff",
    {
      email: "agent-pay@test.local",
      password: "AgentPay123",
      role: "agent",
      agent_id: cid,
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
  const topup = await api("POST", `/admin/api/agents/${cid}/balance`, { amount: 10000 }, adminToken);
  assert.equal(topup.json.data.agent.balance, 10000);

  // 生成成功并扣费
  const ok = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "day", term_value: 30, count: 1 },
    agentToken,
  );
  assert.equal(ok.status, 201);
  const after = await api("GET", `/admin/api/agents/${cid}`, undefined, adminToken);
  assert.equal(after.json.data.agent.balance, 4000, "10000 - 6000 = 4000");

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
  const batch = await api("POST", "/admin/api/agents/batch-balance", { amount: 5000 }, adminToken);
  assert.equal(batch.status, 200);
  assert.ok(batch.json.data.updated >= 2, "应对全部代理生效");
  const cidAfter = await api("GET", `/admin/api/agents/${cid}`, undefined, adminToken);
  assert.equal(cidAfter.json.data.agent.balance, 9000, "4000 + 5000");
});


/* ==================== 价格三层 + 页面拆分 ==================== */

test("价格三层：代理覆盖优先、未配则回落全局；员工列表不含代理；产品试用配置", async () => {
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 100 }, adminToken);

  const ch = await api("POST", "/admin/api/agents", { code: "tier-test", name: "分层定价代理" }, adminToken);
  const cid = ch.json.data.agent.id;

  await api(
    "POST",
    "/admin/api/staff",
    {
      email: "tier-agent@test.local",
      password: "TierAgent123",
      role: "agent",
      agent_id: cid,
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
    { agent_id: cid, product_id: productId, term_type: "day", unit_price: 60 },
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

/* ==================== 登录返回实际到期时间 ==================== */

test("客户登录返回实际到期时间：试用给试用期、激活给卡密到期、次数卡给剩余次数", async () => {
  // 1) 新注册客户：还没有任何授权
  const trialReg = await api("POST", "/api/v1/auth/register", {
    email: "login-trial@test.local",
    password: "TrialLogin123",
  });
  assert.equal(trialReg.status, 201);
  assert.equal(trialReg.json.data.active_license, null, "新客户还没有授权");
  const tToken = trialReg.json.data.session.token;

  await api("PATCH", "/admin/api/settings/trial", { enabled: true, mode: "day", value: 7 }, adminToken);
  // 产品级配置优先于全局，这里显式改回按天，避免受前面用例影响
  await api(
    "PATCH",
    `/admin/api/products/${productId}/trial`,
    { enabled: true, mode: "day", value: 7 },
    adminToken,
  );
  const started = await api("POST", "/api/v1/trial/start", { device_id: "LOGIN-TRIAL-1" }, tToken);
  assert.equal(started.status, 201);

  // 试用期内登录 → 直接返回试用到期时间
  const trialLogin = await api("POST", "/api/v1/auth/login", {
    email: "login-trial@test.local",
    password: "TrialLogin123",
  });
  assert.equal(trialLogin.status, 200);
  const al = trialLogin.json.data.active_license;
  assert.ok(al, "试用期内登录应返回授权信息");
  assert.equal(al.is_trial, true, "应标记为试用");
  assert.equal(al.status, "active");
  assert.ok(al.expires_at, "应返回试用到期时间");
  assert.ok(al.days_left >= 0 && al.days_left <= 7, `剩余天数应在 0~7，实际 ${al.days_left}`);

  // 2) 已通过卡密激活的客户 → 返回卡密到期时间
  const buyerLogin = await api("POST", "/api/v1/auth/login", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  const bl = buyerLogin.json.data.active_license;
  assert.ok(bl, "已激活客户应返回授权");
  assert.equal(bl.is_trial, false);
  assert.ok(bl.expires_at, "应返回卡密授权到期时间");

  // 3) 次数卡 → 返回剩余次数
  await api("POST", "/api/v1/auth/register", {
    email: "login-count@test.local",
    password: "CountLogin123",
  });
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "count", term_value: 10, count: 1, seats: 1 },
    adminToken,
  );
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: gen.json.data.codes[0],
    device_id: "LOGIN-COUNT-1",
    email: "login-count@test.local",
    password: "CountLogin123",
  });
  assert.equal(act.status, 201);

  const countLogin = await api("POST", "/api/v1/auth/login", {
    email: "login-count@test.local",
    password: "CountLogin123",
  });
  const cl = countLogin.json.data.active_license;
  assert.ok(cl, "次数卡客户应返回授权");
  assert.equal(cl.term_type, "count");
  assert.equal(cl.usages.max, 10);
  assert.equal(cl.usages.remaining, 10, "次数卡应返回剩余次数");
});

/* ==================== 叠加续费 + 代理管客户 ==================== */

test("同类型卡叠加、异类型互斥", async () => {
  await api("POST", "/api/v1/auth/register", { email: "stack@test.local", password: "StackPass123" });

  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "day", term_value: 30, count: 2, seats: 2 },
    adminToken,
  );
  const [cdk1, cdk2] = gen.json.data.codes;

  const act1 = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdk1,
    device_id: "STACK-1",
    email: "stack@test.local",
    password: "StackPass123",
  });
  assert.equal(act1.status, 201);
  assert.equal(act1.json.data.merged, false, "首次激活不算叠加");
  const exp1 = Date.parse(act1.json.data.expires_at);

  // 第二张 30 天卡：叠加到同一授权，到期从原到期日继续加
  const act2 = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdk2,
    device_id: "STACK-1",
    email: "stack@test.local",
    password: "StackPass123",
  });
  assert.equal(act2.status, 201);
  assert.equal(act2.json.data.merged, true, "同类型卡应叠加");
  assert.equal(act2.json.data.license.id, act1.json.data.license.id, "应叠加到同一授权");
  const exp2 = Date.parse(act2.json.data.expires_at);
  assert.ok(Math.abs(exp2 - exp1 - 30 * 86_400_000) < 10_000, "到期应再延长约 30 天");

  // 时长卡未到期时叠加次数卡 → 互斥
  const genCount = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "count", term_value: 5, count: 1, seats: 1 },
    adminToken,
  );
  const bad = await api("POST", "/api/v1/licenses/activate", {
    cdk: genCount.json.data.codes[0],
    device_id: "STACK-1",
    email: "stack@test.local",
    password: "StackPass123",
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error.code, "TERM_CONFLICT");
});

test("代理管自己名下客户：可见、可改资料、到期可缩短可恢复但不超上限", async () => {
  const agentId = (
    await api("POST", "/admin/api/agents", { code: "cust-agent", name: "客户代理" }, adminToken)
  ).json.data.agent.id;
  // 配价 + 充值，让代理能出卡
  await api("POST", "/admin/api/prices", { product_id: productId, term_type: "day", unit_price: 10 }, adminToken);
  await api("POST", `/admin/api/agents/${agentId}/balance`, { amount: 100000 }, adminToken);

  const agentToken = (
    await api(
      "POST",
      "/admin/api/staff",
      { email: "cust-agent@test.local", password: "CustAgent123", role: "agent", agent_id: agentId },
      adminToken,
    ).catch(() => null)
  )?.json?.data?.token;
  const aToken =
    agentToken ??
    (await api("POST", "/admin/api/auth/login", { email: "cust-agent@test.local", password: "CustAgent123" })).json.data.token;

  // 代理出卡
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], term_type: "day", term_value: 30, count: 1, seats: 1 },
    aToken,
  );
  assert.equal(gen.status, 201);

  // 客户用它激活 → 归属该代理
  await api("POST", "/api/v1/auth/register", { email: "agent-cust@test.local", password: "AgentCust123" });
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: gen.json.data.codes[0],
    device_id: "AGENT-CUST-1",
    email: "agent-cust@test.local",
    password: "AgentCust123",
  });
  assert.equal(act.status, 201);
  const capExpiry = Date.parse(act.json.data.expires_at);
  const customerId = act.json.data.license.customer_id;

  // 代理能看见自己名下客户
  const list = await api("GET", "/admin/api/customers", undefined, aToken);
  assert.equal(list.status, 200);
  assert.ok(
    list.json.data.items.some((c: Json) => c.id === customerId),
    "代理应能看到自己名下客户",
  );

  // 代理不能新增客户
  const denyCreate = await api("POST", "/admin/api/customers", { email: "x@test.local" }, aToken);
  assert.equal(denyCreate.status, 403);

  // 代理可改客户资料（姓名 + 邮箱）
  const renamed = await api(
    "PATCH",
    `/admin/api/customers/${customerId}`,
    { name: "代理改的名字", phone: "13800000000" },
    aToken,
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.data.customer.name, "代理改的名字");

  // 缩短可以
  const shorter = await api(
    "POST",
    `/admin/api/customers/${customerId}/adjust-expiry`,
    { days: -10 },
    aToken,
  );
  assert.equal(shorter.status, 200);
  const shortened = Date.parse(shorter.json.data.licenses[0].expires_at);
  assert.ok(shortened < capExpiry, "应被缩短");

  // 恢复：可以延长，但不得超过 CDK 授予的上限
  const restore = await api(
    "POST",
    `/admin/api/customers/${customerId}/adjust-expiry`,
    { days: 60 },
    aToken,
  );
  assert.equal(restore.status, 200);
  const restored = Date.parse(restore.json.data.licenses[0].expires_at);
  assert.ok(restored <= capExpiry + 1000, "代理延长不得超过 CDK 激活时的实际到期时间");
  assert.ok(Math.abs(restored - capExpiry) < 10_000, "恢复后应回到上限附近");
});

/* ==================== 模块级：选择、增减与到期 ==================== */

test("激活可选模块子集、后台可增减（至少一个）、登录返回每模块到期", async () => {
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: [moduleIds[0], moduleIds[1]],
      term_type: "day",
      term_value: 30,
      count: 2,
      seats: 1,
    },
    adminToken,
  );
  assert.equal(gen.status, 201);
  const [cdkA, cdkB] = gen.json.data.codes;

  await api("POST", "/api/v1/auth/register", { email: "mods@test.local", password: "ModsPass123" });

  // ① 传了 CDK 范围外的模块 → 拒绝
  const outside = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkA,
    device_id: "MODS-0",
    email: "mods@test.local",
    password: "ModsPass123",
    module_ids: ["mod_not_exists"],
  });
  assert.equal(outside.status, 400);
  assert.equal(outside.json.error.code, "MODULE_NOT_ALLOWED");

  // ② 只开通第一个模块
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkA,
    device_id: "MODS-1",
    email: "mods@test.local",
    password: "ModsPass123",
    module_ids: [moduleIds[0]],
  });
  assert.equal(act.status, 201);
  assert.equal(act.json.data.module_codes.length, 1, "只应开通勾选的 1 个模块");

  const licId = act.json.data.license.id;
  const exp0 = act.json.data.expires_at;

  // ③ 登录返回模块级到期
  const login = await api("POST", "/api/v1/auth/login", {
    email: "mods@test.local",
    password: "ModsPass123",
  });
  const active = login.json.data.active_license;
  assert.ok(active.modules?.length === 1, "登录应返回模块明细");
  assert.equal(active.modules[0].module_id, moduleIds[0]);
  assert.ok(active.modules[0].expires_at, "模块应带到期时间");
  assert.equal(active.modules[0].active, true);

  // ④ 后台把模块清空 → 拒绝
  const empty = await api("PATCH", `/admin/api/licenses/${licId}`, { module_ids: [] }, adminToken);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, "MISSING_FIELD");

  // ⑤ 增加到两个模块 → 成功且新模块继承授权到期
  const added = await api(
    "PATCH",
    `/admin/api/licenses/${licId}`,
    { module_ids: [moduleIds[0], moduleIds[1]] },
    adminToken,
  );
  assert.equal(added.status, 200);
  const detail = await api("GET", `/admin/api/licenses/${licId}`, undefined, adminToken);
  assert.equal(detail.json.data.modules.length, 2);
  assert.equal(detail.json.data.modules.every((m: Json) => m.expires_at === exp0), true, "模块默认跟随授权到期");

  // ⑥ 单独设置某模块到期
  const custom = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const patched = await api(
    "PATCH",
    `/admin/api/licenses/${licId}`,
    { module_expiries: [{ module_id: moduleIds[1], expires_at: custom }] },
    adminToken,
  );
  assert.equal(patched.status, 200);

  const relogin = await api("POST", "/api/v1/auth/login", {
    email: "mods@test.local",
    password: "ModsPass123",
  });
  const mods = relogin.json.data.active_license.modules;
  const target = mods.find((m: Json) => m.module_id === moduleIds[1]);
  assert.ok(target, "应能找到单独设置到期的模块");
  assert.ok(Math.abs(Date.parse(target.expires_at) - Date.parse(custom)) < 2000, "该模块到期应为单独设置的值");
  const other = mods.find((m: Json) => m.module_id === moduleIds[0]);
  assert.ok(Math.abs(Date.parse(other.expires_at) - Date.parse(exp0)) < 2000, "未设置的模块应仍跟随授权");

  // ⑦ 第二个 CDK 激活（同为 30 天 / 两个模块）→ 每个模块从自己的到期时间叠加
  const act2 = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkB,
    device_id: "MODS-1",
    email: "mods@test.local",
    password: "ModsPass123",
  });
  assert.equal(act2.status, 201);
  assert.equal(act2.json.data.merged, true);

  const after = await api("GET", `/admin/api/licenses/${licId}`, undefined, adminToken);
  const m0 = after.json.data.modules.find((m: Json) => m.id === moduleIds[0]);
  const m1 = after.json.data.modules.find((m: Json) => m.id === moduleIds[1]);
  const DAY_MS = 86_400_000;
  assert.ok(
    Math.abs(Date.parse(m0.expires_at) - (Date.parse(exp0) + 30 * DAY_MS)) < 5000,
    "模块 0 应从自己的原到期时间叠加 30 天",
  );
  assert.ok(
    Math.abs(Date.parse(m1.expires_at) - (Date.parse(custom) + 30 * DAY_MS)) < 5000,
    "单独设过到期的模块也从自己的时间叠加，不被别的模块带跑",
  );
  assert.equal(
    Date.parse(act2.json.data.expires_at),
    Math.max(Date.parse(m0.expires_at), Date.parse(m1.expires_at)),
    "授权整体到期 = 各模块里最晚的那个",
  );
  assert.notEqual(m0.expires_at, m1.expires_at, "两个模块的到期时间应各自独立");
});

/* ==================== 逐模块叠加（v11） ==================== */

test("逐模块叠加：已有模块累加，新模块从今天起算", async () => {
  const DAY_MS = 86_400_000;
  const gen = (moduleIdsIn: string[]) =>
    api(
      "POST",
      "/admin/api/cdks/generate",
      {
        product_id: productId,
        module_ids: moduleIdsIn,
        term_type: "day",
        term_value: 30,
        count: 1,
        seats: 1,
      },
      adminToken,
    );

  await api("POST", "/api/v1/auth/register", { email: "stack@test.local", password: "StackPass123" });

  // ① 先只买模块 A（30 天）
  const genA = await gen([moduleIds[0]]);
  const cdkA = genA.json.data.codes[0];
  const act1 = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkA,
    device_id: "STACK-1",
    email: "stack@test.local",
    password: "StackPass123",
  });
  assert.equal(act1.status, 201);
  const licId = act1.json.data.license.id;
  const expA0 = act1.json.data.expires_at;

  // ② 再买一张卡：模块 A + 模块 B，各 30 天
  const genB = await gen([moduleIds[0], moduleIds[1]]);
  const cdkB = genB.json.data.codes[0];
  const before = Date.now();
  const act2 = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkB,
    device_id: "STACK-1",
    email: "stack@test.local",
    password: "StackPass123",
  });
  assert.equal(act2.status, 201);
  assert.equal(act2.json.data.merged, true);

  const detail = await api("GET", `/admin/api/licenses/${licId}`, undefined, adminToken);
  const a = detail.json.data.modules.find((m: Json) => m.id === moduleIds[0]);
  const b = detail.json.data.modules.find((m: Json) => m.id === moduleIds[1]);
  assert.ok(a && b, "两个模块都应在授权上");

  // A 是已有的：从它自己的原到期时间往后加
  assert.ok(
    Math.abs(Date.parse(a.expires_at) - (Date.parse(expA0) + 30 * DAY_MS)) < 5000,
    "已有模块 A 应叠加到原到期时间之后",
  );
  // B 是新增的：从当前时间起算
  assert.ok(
    Math.abs(Date.parse(b.expires_at) - (before + 30 * DAY_MS)) < 10000,
    "新模块 B 应从当前时间起算，不与 A 的到期时间对齐",
  );
  assert.ok(Date.parse(b.expires_at) < Date.parse(a.expires_at), "新模块到期应早于叠加后的老模块");
  // 授权整体 = 最晚的模块
  assert.equal(act2.json.data.expires_at, a.expires_at, "授权整体到期取最晚的模块");
});

test("逐模块到期：一个模块过期不影响另一个", async () => {
  // 承接上一个用例：把模块 B 的到期改成过去
  const list = await api("GET", "/admin/api/customers?q=stack@test.local", undefined, adminToken);
  const customerId = list.json.data.items[0].id;
  const detail = await api("GET", `/admin/api/customers/${customerId}`, undefined, adminToken);
  const licId = detail.json.data.licenses[0].id;

  const modules = (await api("GET", `/admin/api/licenses/${licId}`, undefined, adminToken)).json.data.modules;
  const aId = modules.find((m: Json) => m.id === moduleIds[0]).id;
  const bId = modules.find((m: Json) => m.id === moduleIds[1]).id;

  const past = new Date(Date.now() - 86_400_000).toISOString();
  const patched = await api(
    "PATCH",
    `/admin/api/licenses/${licId}`,
    { module_expiries: [{ module_id: bId, expires_at: past }] },
    adminToken,
  );
  assert.equal(patched.status, 200);

  // 客户端登录：B 不可用，A 仍可用
  const login = await api("POST", "/api/v1/auth/login", {
    email: "stack@test.local",
    password: "StackPass123",
  });
  const mods = login.json.data.active_license.modules;
  const a = mods.find((m: Json) => m.module_id === aId);
  const b = mods.find((m: Json) => m.module_id === bId);
  assert.equal(a.active, true, "未过期的模块仍然可用");
  assert.equal(b.active, false, "过期的模块单独失效");
  assert.ok(
    login.json.data.active_license.expires_at,
    "授权整体仍然有效（因为还有一个模块没过期）",
  );
});

/* ==================== 远程变量 + 模块说明 ==================== */

test("远程变量：未登录 401，登录后按产品读取文本/图片/JSON", async () => {
  // ① 未登录无法获取
  const anon = await api("GET", "/api/v1/vars");
  assert.equal(anon.status, 401, "未登录必须拿不到远程变量");

  // ② 管理员配置三种类型
  const t = await api(
    "POST",
    `/admin/api/products/${productId}/vars`,
    { key: "notice", kind: "text", value: "系统维护公告" },
    adminToken,
  );
  assert.equal(t.status, 200);
  await api(
    "POST",
    `/admin/api/products/${productId}/vars`,
    { key: "banner", kind: "image", value: "https://example.com/a.png" },
    adminToken,
  );
  await api(
    "POST",
    `/admin/api/products/${productId}/vars`,
    { key: "conf", kind: "json", value: JSON.stringify({ min_version: "1.2.0" }) },
    adminToken,
  );

  // ③ json 类型写坏内容 → 拒绝
  const bad = await api(
    "POST",
    `/admin/api/products/${productId}/vars`,
    { key: "bad", kind: "json", value: "{not json" },
    adminToken,
  );
  assert.equal(bad.status, 400);

  // ④ 客户登录后可读，json 已解析成对象
  const login = await api("POST", "/api/v1/auth/login", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  const token = login.json.data.session.token;
  const vars = await api("GET", "/api/v1/vars?product=app-pro", undefined, token);
  assert.equal(vars.status, 200);
  assert.equal(vars.json.data.vars.notice, "系统维护公告");
  assert.equal(vars.json.data.vars.banner, "https://example.com/a.png");
  assert.deepEqual(vars.json.data.vars.conf, { min_version: "1.2.0" });

  // ⑤ 后台列表能看到变量
  const list = await api("GET", `/admin/api/products/${productId}/vars`, undefined, adminToken);
  assert.ok(list.json.data.items.length >= 3);

  // ⑥ 删除
  const del = await api("DELETE", `/admin/api/products/${productId}/vars/notice`, undefined, adminToken);
  assert.equal(del.status, 200);
});

test("模块说明：后台可改，客户端登录后能读到", async () => {
  const patched = await api(
    "PATCH",
    `/admin/api/modules/${moduleIds[0]}`,
    { description: "核心能力：导出与报表" },
    adminToken,
  );
  assert.equal(patched.status, 200);

  const login = await api("POST", "/api/v1/auth/login", {
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  const token = login.json.data.session.token;

  const me = await api("GET", "/api/v1/auth/me", undefined, token);
  const licenses = me.json.data.licenses ?? [];
  const mods = licenses.flatMap((l: Json) => l.modules ?? []);
  const target = mods.find((m: Json) => m.module_id === moduleIds[0]);
  assert.ok(target, "客户授权里应包含该模块");
  assert.equal(target.module_description, "核心能力：导出与报表");

  // 心跳同样返回模块说明
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 1, seats: 1 },
    adminToken,
  );
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: gen.json.data.codes[0],
    device_id: "DESC-1",
    email: "buyer@test.local",
    password: "buyerPass123",
  });
  assert.equal(act.status, 201);
  const hb = await api("POST", "/api/v1/licenses/heartbeat", {
    license_key: act.json.data.license_key,
    device_id: "DESC-1",
  });
  assert.equal(hb.status, 200);
  const hbMod = (hb.json.data.modules ?? []).find((m: Json) => m.module_id === moduleIds[0]);
  assert.ok(hbMod, "心跳应返回模块明细");
  assert.equal(hbMod.module_description, "核心能力：导出与报表");
});

test("删除代理时级联删除其登录账号，并让已登录会话失效", async () => {
  const ag = await api("POST", "/admin/api/agents", { code: "cascade-agent", name: "级联删除代理" }, adminToken);
  assert.equal(ag.status, 201);
  const agentId = ag.json.data.agent.id;

  const staff = await api(
    "POST",
    "/admin/api/staff",
    { email: "cascade@test.local", password: "Cascade123", role: "agent", agent_id: agentId },
    adminToken,
  );
  assert.equal(staff.status, 201);

  const login = await api("POST", "/admin/api/auth/login", {
    email: "cascade@test.local",
    password: "Cascade123",
  });
  assert.equal(login.status, 200);
  const agentToken = login.json.data.token;

  // 删除代理
  const del = await api("DELETE", `/admin/api/agents/${agentId}`, undefined, adminToken);
  assert.equal(del.status, 200);

  // 账号随代理一起删除 → 无法再登录
  const relogin = await api("POST", "/admin/api/auth/login", {
    email: "cascade@test.local",
    password: "Cascade123",
  });
  assert.equal(relogin.status, 401, "代理账号应随代理一起删除");

  // 已登录的会话立即失效
  const me = await api("GET", "/admin/api/auth/me", undefined, agentToken);
  assert.equal(me.status, 401, "旧会话应立即失效");

  // 代理账号列表里也没有了
  const list = await api("GET", "/admin/api/staff?role=agent", undefined, adminToken);
  assert.ok(
    !list.json.data.items.some((a: Json) => a.email === "cascade@test.local"),
    "列表中不应再出现该账号",
  );
});

/* ==================== 请求体解析的容错与提示 ==================== */

test("请求体解析：空 body 视为空对象，表单编码与非对象给出可操作提示", async () => {
  const raw = (body: string, ct: string) =>
    fetch(`${base}/api/v1/cdks/inspect`, {
      method: "POST",
      headers: { "Content-Type": ct },
      body,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));

  // ① 空 body：不应报 INVALID_JSON（应由业务层提示缺参数）
  const empty = await api("POST", "/api/v1/cdks/inspect", undefined);
  assert.equal(empty.status, 400);
  assert.notEqual(empty.json.error.code, "INVALID_JSON", "空 body 应视为 {}，不该报 JSON 错误");

  // ② 表单编码 → 提示改用 JSON
  const form = await raw("cdk=ABC-123&x=1", "application/x-www-form-urlencoded");
  assert.equal(form.status, 400);
  assert.equal(form.json.error.code, "INVALID_JSON");
  assert.match(form.json.error.message, /表单编码/, "应提示这是表单编码问题");

  // ③ 合法 JSON 但不是对象 → 提示必须是对象
  const str = await raw('"just-a-string"', "application/json");
  assert.equal(str.status, 400);
  assert.equal(str.json.error.code, "INVALID_JSON");
  assert.match(str.json.error.message, /必须是 JSON 对象/, "应提示需要 JSON 对象");
  assert.equal(str.json.error.details.received_type, "string");

  // ④ 语法错误（单引号）→ 提示检查引号
  const bad = await raw("{'cdk': 'ABC'}", "application/json");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_JSON");
  assert.match(bad.json.error.message, /双引号|合法 JSON/);

  // ⑤ 数组仍被兼容包装成 { items: [...] }
  const arr = await raw('["a","b"]', "application/json");
  assert.equal(arr.status, 400, "数组会被包装，但仍因缺 cdk 参数被拒");
  assert.notEqual(arr.json.error.code, "INVALID_JSON");
});

/* ==================== CDK 修改与删除 ==================== */

test("CDK 修改与删除：未激活可改可删（模块至少一个），已激活一律拒绝", async () => {
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: [moduleIds[0], moduleIds[1]],
      term_type: "day",
      term_value: 30,
      count: 2,
      seats: 1,
    },
    adminToken,
  );
  assert.equal(gen.status, 201);
  const [cdkA, cdkB] = gen.json.data.codes;

  const findId = async (code: string) => {
    const list = await api("GET", `/admin/api/cdks?q=${encodeURIComponent(code)}`, undefined, adminToken);
    const row = list.json.data.items.find((c: Json) => c.code === code);
    assert.ok(row, `应能查到 ${code}`);
    return row.id as string;
  };

  const cdkId = await findId(cdkA);
  const detail = await api("GET", `/admin/api/cdks/${cdkId}`, undefined, adminToken);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.activated, false);
  assert.equal(detail.json.data.modules.length, 2, "详情应列出 2 个模块");

  // 改模块 / 席位 / 计费数量
  const patched = await api(
    "PATCH",
    `/admin/api/cdks/${cdkId}`,
    { module_ids: [moduleIds[0]], seats: 3, term_type: "day", term_value: 60 },
    adminToken,
  );
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json.data.cdk.module_ids, [moduleIds[0]]);
  assert.equal(patched.json.data.cdk.seats, 3);
  assert.equal(patched.json.data.cdk.term_value, 60, "改 term_value 应同步");

  // 模块清空 → 拒绝
  const empty = await api("PATCH", `/admin/api/cdks/${cdkId}`, { module_ids: [] }, adminToken);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, "MISSING_FIELD");

  // 删除未激活的 → 成功
  const del = await api("DELETE", `/admin/api/cdks/${cdkId}`, undefined, adminToken);
  assert.equal(del.status, 200);
  const gone = await api("GET", `/admin/api/cdks/${cdkId}`, undefined, adminToken);
  assert.equal(gone.status, 404, "删除后应查不到");

  // 激活第二张卡后，修改/删除都要被拒
  const act = await api("POST", "/api/v1/licenses/activate", {
    cdk: cdkB,
    device_id: "CDK-EDIT-1",
    email: "cdkedit@test.local",
    password: "CdkEdit123",
  });
  assert.equal(act.status, 201);
  const usedId = await findId(cdkB);

  const patchUsed = await api("PATCH", `/admin/api/cdks/${usedId}`, { seats: 2 }, adminToken);
  assert.equal(patchUsed.status, 409);
  assert.equal(patchUsed.json.error.code, "CDK_ACTIVATED");

  const delUsed = await api("DELETE", `/admin/api/cdks/${usedId}`, undefined, adminToken);
  assert.equal(delUsed.status, 409);
  assert.equal(delUsed.json.error.code, "CDK_ACTIVATED");

  // 已激活的 CDK 详情里 activated 应为 true
  const usedDetail = await api("GET", `/admin/api/cdks/${usedId}`, undefined, adminToken);
  assert.equal(usedDetail.json.data.activated, true);
});

/* ==================== 字段改名后的兼容性 ==================== */

test("接口兼容：旧的 channel_id 作为 agent_id 仍可正常使用", async () => {
  const ag = await api("POST", "/admin/api/agents", { code: "legacy-agent", name: "旧字段代理" }, adminToken);
  assert.equal(ag.status, 201);
  const agentId = ag.json.data.agent.id;

  // ① 请求体用旧字段名提交
  const gen = await api(
    "POST",
    "/admin/api/cdks/generate",
    { product_id: productId, module_ids: [moduleIds[0]], days: 30, count: 1, seats: 1, channel_id: agentId },
    adminToken,
  );
  assert.equal(gen.status, 201);
  const code = gen.json.data.codes[0];

  // ② 归属确实记到了该代理（新字段名查）
  const byNew = await api("GET", `/admin/api/cdks?agent_id=${agentId}`, undefined, adminToken);
  assert.ok(
    byNew.json.data.items.some((c: Json) => c.code === code),
    "旧请求字段应能正确归属到代理",
  );

  // ③ 查询参数用旧字段名也生效
  const byLegacy = await api("GET", `/admin/api/cdks?channel_id=${agentId}`, undefined, adminToken);
  assert.equal(byLegacy.status, 200);
  assert.ok(byLegacy.json.data.items.some((c: Json) => c.code === code), "旧查询字段应被识别");

  // ④ 新字段名优先级更高（两个都传时以 agent_id 为准）
  const other = await api("POST", "/admin/api/agents", { code: "legacy-agent-2", name: "另一个代理" }, adminToken);
  const otherId = other.json.data.agent.id;
  const gen2 = await api(
    "POST",
    "/admin/api/cdks/generate",
    {
      product_id: productId,
      module_ids: [moduleIds[0]],
      days: 30,
      count: 1,
      seats: 1,
      agent_id: otherId,
      channel_id: agentId,
    },
    adminToken,
  );
  assert.equal(gen2.status, 201);
  const byOther = await api("GET", `/admin/api/cdks?agent_id=${otherId}`, undefined, adminToken);
  assert.ok(
    byOther.json.data.items.some((c: Json) => c.code === gen2.json.data.codes[0]),
    "同时传两个字段时应以新字段 agent_id 为准",
  );
});
