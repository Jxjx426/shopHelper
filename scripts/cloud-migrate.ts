import { loadEnvConfig } from "@next/env";
import { cloudConfig } from "../src/lib/cloud-config.server";
import { cloudPoolConfig } from "../src/lib/cloud-pool-config.server";
import { createPostgresDatabase } from "../src/lib/postgres.server";
import { getDb } from "../src/lib/db";
import {
  migrationSource,
  migrateEmptyCloud,
} from "../src/lib/cloud-migration.server";
import { businessFingerprint } from "../src/lib/cloud-migration.server";
import { readFile } from "node:fs/promises";
import { validateBackup } from "../src/lib/backup.server";
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
async function main() {
  if (!process.argv.includes("--apply")) {
    console.log(
      "Dry run only. No database opened or changed. Migration requires stopped local server, a separate source backup, an initialized EMPTY cloud target, and --apply. Existing accounts/password hashes and business files are verified; the local source is retained. No deployment.",
    );
    return;
  }
  const config = cloudConfig();
  const index = process.argv.indexOf("--source-backup"),
    filename = index >= 0 ? process.argv[index + 1] : undefined;
  if (!filename)
    throw new Error("A verified separate JSON source backup is required");
  const saved = await validateBackup(
    JSON.parse(await readFile(filename, "utf8")),
  );
  // Acquire the existing single-writer local lock. Never connect to a running source.
  process.env.SHOP_BACKEND = "local";
  delete process.env.NETLIFY;
  process.env.SHOP_AUTO_BACKUP = "false";
  const source = await getDb();
  let target: ReturnType<typeof createPostgresDatabase> | undefined;
  try {
    const bundle = await migrationSource(source);
    if (businessFingerprint(saved) !== businessFingerprint(bundle.backup))
      throw new Error(
        "Source changed since backup; export a new complete backup first",
      );
    target = createPostgresDatabase(await cloudPoolConfig(config.databaseUrl));
    const result = await migrateEmptyCloud(target, bundle);
    console.log(
      `Verified migration: ${result.accounts} accounts, ${result.orders} orders. Source retained; sessions require fresh login. Nothing deployed.`,
    );
  } finally {
    await source.close();
    await target?.close();
  }
}
main().catch(() => {
  console.error(
    "Migration stopped. Source data retained; no deployment or paid fallback. Check an empty initialized target and stop the local server before retrying.",
  );
  process.exitCode = 1;
});
