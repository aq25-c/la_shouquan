/**
 * 在线备份：用 SQLite 的 `VACUUM INTO` 生成一致性快照。
 *
 * 服务运行中也可以执行（WAL 模式下 VACUUM 会拿到一致的完整副本）。
 *
 * 用法：
 *   node src/tools/backup.ts                    # 备份到 $DATA_DIR/backups/license-<时间>.db
 *   node src/tools/backup.ts /path/to/out.db    # 指定目标文件（必须不存在）
 *   docker compose exec license-server node src/tools/backup.ts
 */
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";

function defaultTarget(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(config.dataDir, "backups", `license-${stamp}.db`);
}

function main(): void {
  const source = config.dbPath;
  if (!existsSync(source)) {
    console.error(`[backup] 数据库不存在：${source}`);
    process.exit(1);
  }

  const target = process.argv[2] ?? defaultTarget();
  if (existsSync(target)) {
    console.error(`[backup] 目标文件已存在，拒绝覆盖：${target}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });

  // 先写临时文件再改名，避免中途失败留下半个可用文件名
  const tmp = `${target}.partial`;
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const escaped = tmp.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  renameSync(tmp, target);

  // 自检：备份能打开、表结构完整
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    const tables = check
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number };
    const licenses = check.prepare("SELECT COUNT(*) AS n FROM licenses").get() as { n: number };
    const cdks = check.prepare("SELECT COUNT(*) AS n FROM cdks").get() as { n: number };
    const size = statSync(target).size;
    console.log(
      `[backup] 完成 ${target}\n` +
        `[backup] 大小 ${(size / 1024).toFixed(1)} KB · 表 ${Number(tables.n)} 个 · ` +
        `授权 ${Number(licenses.n)} 条 · CDK ${Number(cdks.n)} 条`,
    );
  } finally {
    check.close();
  }
}

main();
