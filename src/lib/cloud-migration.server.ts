import type { Database } from "./db";
import { backupIn } from "./service";
import { validateBackup, insertBackup } from "./backup.server";
import { backupChecksum } from "./backup-checksum";
import { AppError } from "./errors";
type Row = Record<string, any>;
export function businessFingerprint(backup: {
  actors: unknown;
  tables: unknown;
}) {
  const canonical = (value: any, key = ""): any => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && key.endsWith("_base64"))
      return Buffer.from(value, "base64").toString("base64");
    if (Array.isArray(value))
      return value
        .map((v) => canonical(v))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, canonical(value[k], k)]),
      );
    return value;
  };
  // Sort database rows only. Order within JSON snapshots/lines is business data.
  const tables = backup.tables as Record<string, Row[]>;
  const normalize = (value: any, key = ""): any => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && key.endsWith("_base64"))
      return Buffer.from(value, "base64").toString("base64");
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, normalize(value[k], k)]),
      );
    return value;
  };
  return backupChecksum({
    actors: canonical(backup.actors),
    tables: Object.fromEntries(
      Object.keys(tables)
        .sort()
        .map((t) => [
          t,
          tables[t]
            .map((r) => normalize(r))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ]),
    ),
  });
}
export async function migrationSource(source: Database) {
  return source.transaction(async (tx) => ({
    backup: await backupIn(tx),
    users: (await tx.query<Row>("SELECT * FROM users")).rows,
    cache: (await tx.query<Row>("SELECT * FROM extraction_cache")).rows,
    cooldown: (await tx.query<Row>("SELECT * FROM extraction_cooldown")).rows,
  }));
}
export async function migrateEmptyCloud(
  target: Database,
  bundle: Awaited<ReturnType<typeof migrationSource>>,
) {
  const validated = await validateBackup(bundle.backup);
  const fingerprint = businessFingerprint(bundle.backup);
  await target.transaction(async (tx) => {
    const used = (
      await tx.query(
        "SELECT id FROM users UNION ALL SELECT id FROM orders UNION ALL SELECT id FROM products UNION ALL SELECT id FROM zones UNION ALL SELECT id FROM restaurants UNION ALL SELECT id FROM file_assets LIMIT 1",
      )
    ).rows.length;
    const prior = (
      await tx.query(
        "SELECT source_fingerprint FROM cloud_schema_version WHERE id=1",
      )
    ).rows[0];
    if (used || prior?.source_fingerprint)
      throw new AppError("目标云端已有资料，迁移已停止；不会覆盖现有店铺", 409);
    await tx.query("DELETE FROM shop");
    const keys = [
      "id",
      "name",
      "password_hash",
      "role",
      "created_at",
      "username",
      "active",
      "can_import",
      "can_finalize",
      "version",
    ];
    for (const user of bundle.users)
      await tx.query(
        `INSERT INTO users(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => user[k]),
      );
    await insertBackup(tx, validated, undefined, true);
    for (const row of bundle.cache)
      await tx.query(
        "INSERT INTO extraction_cache(cache_key,actor_id,result,created_at) VALUES($1,$2,$3,$4)",
        [
          row.cache_key,
          row.actor_id,
          JSON.stringify(row.result),
          row.created_at,
        ],
      );
    for (const row of bundle.cooldown)
      await tx.query(
        "INSERT INTO extraction_cooldown(id,until_at) VALUES($1,$2)",
        [row.id, row.until_at],
      );
    const actual = await backupIn(tx);
    if (businessFingerprint(actual) !== fingerprint)
      throw new AppError("迁移校验不符，数据库事务已取消");
    const users = (await tx.query<Row>("SELECT * FROM users")).rows;
    if (
      backupChecksum(users.sort((a, b) => a.id.localeCompare(b.id))) !==
      backupChecksum([...bundle.users].sort((a, b) => a.id.localeCompare(b.id)))
    )
      throw new AppError("账号迁移校验不符，数据库事务已取消");
    await tx.query(
      "UPDATE cloud_schema_version SET source_fingerprint=$1,migrated_at=now() WHERE id=1",
      [fingerprint],
    );
  });
  return {
    fingerprint,
    accounts: bundle.users.length,
    orders: bundle.backup.tables.orders.length,
  };
}
