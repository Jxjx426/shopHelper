import type { Database } from "./database-types";
import { AppError } from "./errors";

/** Additive only. Run explicitly before publishing English product editing. */
export async function upgradeEnglishNames(db: Database) {
  await db.transaction(async (tx) => {
    const installed = await tx.query<{ version: number }>(
      "SELECT version FROM cloud_schema_version WHERE id=1",
    );
    if (installed.rows[0]?.version !== 1)
      throw new AppError("目标不是已初始化的店铺数据库，未更新");
    await tx.exec(
      "ALTER TABLE products ADD COLUMN IF NOT EXISTS english_name text",
    );
    const column = await tx.query<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='products' AND column_name='english_name'",
    );
    if (column.rows[0]?.data_type !== "text")
      throw new AppError("英文名称字段类型不匹配，未更新");
  });
}
