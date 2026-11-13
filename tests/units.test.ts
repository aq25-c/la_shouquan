/**
 * 单元测试（不依赖 HTTP）：数据库迁移结构、权限模型、计费类型计算。
 * 与 api.test.ts 分开跑（node --test 每个文件独立进程，互不影响）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const { openDb, closeDb, db } = await import("../src/db.ts");
const perm = await import("../src/permissions.ts");

before(() => {
  openDb(":memory:");
});

after(() => {
  closeDb();
});

function columns(table: string): string[] {
  return (db().prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((r) => r.name);
}

test("数据库迁移到 v6，新增列齐全", () => {
  const version = (db().prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(version, 6);

  const admin = columns("admin_users");
  assert.ok(admin.includes("permissions"), "admin_users.permissions");
  assert.ok(admin.includes("channel_id"), "admin_users.channel_id");
  assert.ok(admin.includes("agent_profile"), "admin_users.agent_profile");

  const ch = columns("channels");
  assert.ok(ch.includes("credit"), "channels.credit");
  assert.ok(ch.includes("balance"), "channels.balance");

  const price = columns("agent_prices");
  for (const c of ["product_id", "module_id", "term_type", "unit_price"]) {
    assert.ok(price.includes(c), `agent_prices.${c}`);
  }

  const lic = columns("licenses");
  for (const c of ["term_type", "term_value", "max_usages", "used_usages"]) {
    assert.ok(lic.includes(c), `licenses.${c}`);
  }
  for (const t of ["cdks", "cdk_batches"]) {
    const cols = columns(t);
    assert.ok(cols.includes("term_type") && cols.includes("term_value"), `${t} 计费类型列`);
  }
});

test("权限模型：owner / agent / staff", () => {
  const owner = perm.parsePermissions(null, "owner");
  assert.equal(owner.menus.length, perm.ALL_MENUS.length);
  assert.equal(owner.features.length, perm.ALL_FEATURES.length);
  assert.ok(perm.hasFeature(owner, "staff.manage"));

  const agent = perm.parsePermissions(null, "agent");
  assert.deepEqual(agent.menus, ["cdks"], "代理只看 CDK 页");
  assert.ok(perm.hasFeature(agent, "cdk.generate"));
  assert.equal(perm.hasFeature(agent, "staff.manage"), false, "代理不能管理员工");
  assert.equal(perm.hasMenu(agent, "licenses"), false);

  // 序列化会过滤掉不存在的菜单/功能
  const staffStr = perm.serializePermissions({
    menus: ["cdks", "licenses", "bad-menu"],
    features: ["cdk.generate", "nope"],
  });
  const parsedStaff = JSON.parse(staffStr);
  assert.deepEqual(parsedStaff.menus, ["cdks", "licenses"]);
  assert.deepEqual(parsedStaff.features, ["cdk.generate"]);

  const staff = perm.parsePermissions(staffStr, "staff");
  assert.ok(perm.hasFeature(staff, "cdk.generate"));
  assert.equal(perm.hasFeature(staff, "nope"), false);
  assert.equal(perm.hasMenu(staff, "audit"), false);

  // 空/损坏的 JSON 不炸
  assert.deepEqual(perm.parsePermissions("not-json", "staff"), { menus: [], features: [] });
  assert.deepEqual(perm.parsePermissions(null, "staff"), { menus: [], features: [] });
});

test("计费类型：小时 / 天 / 月 / 年 / 次数", () => {
  const start = Date.parse("2026-01-31T10:00:00.000Z");

  assert.equal(perm.computeExpiry("hour", 3, start), start + 3 * 3_600_000);
  assert.equal(perm.computeExpiry("day", 7, start), start + 7 * 86_400_000);

  // 1/31 + 1 月 → 2/28（自然月边界）
  const month = new Date(perm.computeExpiry("month", 1, start));
  assert.equal(month.getUTCMonth(), 1, "应落到 2 月");
  assert.equal(month.getUTCDate(), 28, "1/31 加一个月应回落到 2/28");

  const year = new Date(perm.computeExpiry("year", 1, start));
  assert.equal(year.getUTCFullYear(), 2027);

  // 次数型给远期到期，真正的约束是次数
  const count = perm.computeExpiry("count", 50, start);
  assert.ok(count > start + 50 * 365 * 86_400_000, "次数型应为远期到期");

  assert.ok(perm.computeExpiry("month", 3, start) > perm.computeExpiry("day", 30, start));
});

test("计费类型：旧数据兼容与展示", () => {
  // term_value 为空时回落到 days
  assert.deepEqual(perm.normalizeTerm(null, null, 30), { termType: "day", termValue: 30 });
  assert.deepEqual(perm.normalizeTerm("month", 3, 30), { termType: "month", termValue: 3 });
  assert.deepEqual(perm.normalizeTerm("weird", 5, 30), { termType: "day", termValue: 5 });
  assert.deepEqual(perm.normalizeTerm("count", 0, 100), { termType: "count", termValue: 100 });

  assert.equal(perm.termLabel("month", 3), "3 个月");
  assert.equal(perm.termLabel("count", 100), "100 次");
  assert.equal(perm.termLabel("unknown", 7), "7 天");
});
