/**
 * 远程变量：按产品维护一组可远程下发的参数。
 * 载荷支持三种：文本 / 图片（URL 或 data URI）/ JSON 字符串。
 * 客户端接口需要客户登录后才可读取。
 */
import { db } from "../db.ts";
import { newId, nowIso, nz, toJson } from "../util.ts";

export type RemoteVarKind = "text" | "image" | "json";

export const REMOTE_VAR_KINDS: RemoteVarKind[] = ["text", "image", "json"];

export type RemoteVarRow = {
  id: string;
  product_id: string;
  key: string;
  kind: RemoteVarKind;
  value: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export function listVars(productId: string): RemoteVarRow[] {
  return db()
    .prepare("SELECT * FROM remote_vars WHERE product_id = ? ORDER BY key")
    .all(productId) as unknown as RemoteVarRow[];
}

export function findVar(productId: string, key: string): RemoteVarRow | null {
  const row = db()
    .prepare("SELECT * FROM remote_vars WHERE product_id = ? AND key = ?")
    .get(productId, key) as unknown as RemoteVarRow | undefined;
  return row ?? null;
}

/** 新增或覆盖（同产品下 key 唯一） */
export function upsertVar(input: {
  productId: string;
  key: string;
  kind: RemoteVarKind;
  value: string;
  description?: string | null;
}): RemoteVarRow {
  const at = nowIso();
  const existing = findVar(input.productId, input.key);
  if (existing) {
    db()
      .prepare("UPDATE remote_vars SET kind = ?, value = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(input.kind, input.value, nz(input.description), at, existing.id);
    return findVar(input.productId, input.key) as RemoteVarRow;
  }
  const id = newId("var");
  db()
    .prepare(
      `INSERT INTO remote_vars (id, product_id, key, kind, value, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.productId, input.key, input.kind, input.value, nz(input.description), at, at);
  return findVar(input.productId, input.key) as RemoteVarRow;
}

export function deleteVar(productId: string, key: string): boolean {
  const res = db().prepare("DELETE FROM remote_vars WHERE product_id = ? AND key = ?").run(productId, key);
  return Number(res.changes) > 0;
}

/** 客户端读取：json 类型自动解析，其余原样返回 */
export function varsForClient(productId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of listVars(productId)) {
    if (row.kind === "json") {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value; // 配置写坏时原样返回，避免客户端拿不到
      }
    } else {
      out[row.key] = row.value;
    }
  }
  return out;
}

/** 供后台列表展示：把 json 值格式化一下 */
export function varView(row: RemoteVarRow): RemoteVarRow & { preview: string } {
  const preview =
    row.kind === "json"
      ? (() => {
          try {
            return toJson(JSON.parse(row.value));
          } catch {
            return row.value;
          }
        })()
      : row.value;
  return { ...row, preview };
}
