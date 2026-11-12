/** 产品与功能模块（CDK 绑定的目标）。 */
import { db } from "../db.ts";
import { newId, nowIso, nz } from "../util.ts";
import type { ModuleRow, ProductRow } from "../types.ts";

/* ---------------------------- 产品 ---------------------------- */

export type ProductListItem = ProductRow & {
  module_count: number;
  license_count: number;
  active_license_count: number;
  cdk_unused_count: number;
};

export function listProducts(): ProductListItem[] {
  const now = nowIso();
  return db()
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM modules m WHERE m.product_id = p.id) AS module_count,
              (SELECT COUNT(*) FROM licenses l WHERE l.product_id = p.id) AS license_count,
              (SELECT COUNT(*) FROM licenses l WHERE l.product_id = p.id AND l.status = 'active' AND l.expires_at > ?) AS active_license_count,
              (SELECT COUNT(*) FROM cdks k WHERE k.product_id = p.id AND k.status = 'unused') AS cdk_unused_count
       FROM products p
       ORDER BY p.created_at ASC`,
    )
    .all(now) as unknown as ProductListItem[];
}

export function findProductById(id: string): ProductRow | null {
  const row = db().prepare("SELECT * FROM products WHERE id = ?").get(id) as unknown as ProductRow | undefined;
  return row ?? null;
}

export function findProductByCode(code: string): ProductRow | null {
  const row = db().prepare("SELECT * FROM products WHERE code = ?").get(code) as unknown as ProductRow | undefined;
  return row ?? null;
}

export function createProduct(input: {
  code: string;
  name: string;
  description: string | null;
}): ProductRow {
  const id = newId("prd");
  const at = nowIso();
  db()
    .prepare(
      `INSERT INTO products (id, code, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, input.code, input.name, nz(input.description), at, at);
  return findProductById(id) as ProductRow;
}

export function updateProduct(
  id: string,
  patch: Partial<Pick<ProductRow, "code" | "name" | "description" | "status">>,
): ProductRow | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value as string | null);
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    db().prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  return findProductById(id);
}

export function deleteProduct(id: string): boolean {
  const res = db().prepare("DELETE FROM products WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/* ---------------------------- 模块 ---------------------------- */

export function listModules(productId: string): ModuleRow[] {
  return db()
    .prepare("SELECT * FROM modules WHERE product_id = ? ORDER BY created_at ASC")
    .all(productId) as unknown as ModuleRow[];
}

export function listAllModules(): ModuleRow[] {
  return db().prepare("SELECT * FROM modules ORDER BY product_id, created_at ASC").all() as unknown as ModuleRow[];
}

export function findModuleById(id: string): ModuleRow | null {
  const row = db().prepare("SELECT * FROM modules WHERE id = ?").get(id) as unknown as ModuleRow | undefined;
  return row ?? null;
}

export function findModuleByCode(productId: string, code: string): ModuleRow | null {
  const row = db()
    .prepare("SELECT * FROM modules WHERE product_id = ? AND code = ?")
    .get(productId, code) as unknown as ModuleRow | undefined;
  return row ?? null;
}

export function createModule(input: {
  productId: string;
  code: string;
  name: string;
  description: string | null;
}): ModuleRow {
  const id = newId("mod");
  db()
    .prepare(
      `INSERT INTO modules (id, product_id, code, name, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, input.productId, input.code, input.name, nz(input.description), nowIso());
  return findModuleById(id) as ModuleRow;
}

export function updateModule(
  id: string,
  patch: Partial<Pick<ModuleRow, "code" | "name" | "description" | "status">>,
): ModuleRow | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value as string | null);
  }
  if (sets.length) {
    params.push(id);
    db().prepare(`UPDATE modules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  return findModuleById(id);
}

export function deleteModule(id: string): boolean {
  const res = db().prepare("DELETE FROM modules WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** 把模块 id 列表映射成 code 列表（签发许可证时用 code 更稳定）。 */
export function moduleCodesFor(ids: string[]): string[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT code FROM modules WHERE id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...ids) as unknown as { code: string }[];
  return rows.map((r) => r.code);
}
