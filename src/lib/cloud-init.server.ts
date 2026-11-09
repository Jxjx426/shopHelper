import type { Database } from "./db";
import { schema } from "./db";
import { syncSchema, realtimeSchema } from "./sync-schema";
import { CLOUD_SCHEMA } from "./postgres.server";
import { AppError } from "./errors";
export async function initialiseCloudDatabase(db: Database) {
  const roles = (
    await db.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')",
    )
  ).rows;
  if (roles.length !== 2)
    throw new AppError("目标数据库缺少 Supabase 角色，未初始化");
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${CLOUD_SCHEMA}`);
  await db.transaction(async (tx) => {
    await tx.exec(schema);
    await tx.exec(syncSchema(CLOUD_SCHEMA));
    await tx.exec(realtimeSchema(CLOUD_SCHEMA));
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS cloud_schema_version(id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL,source_fingerprint text,migrated_at timestamptz); INSERT INTO cloud_schema_version(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING",
    );
  });
}
