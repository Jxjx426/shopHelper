import { loadEnvConfig } from "@next/env";
import { cloudConfig } from "../src/lib/cloud-config.server";
import { cloudPoolConfig } from "../src/lib/cloud-pool-config.server";
import { createPostgresDatabase } from "../src/lib/postgres.server";
import { upgradeEnglishNames } from "../src/lib/cloud-upgrade.server";
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
async function main() {
  if (!process.argv.includes("--apply")) {
    console.log(
      "Dry run only: adds optional products.english_name. No data is replaced, no accounts/services are created, and nothing is deployed. --apply requires the shop owner's approval.",
    );
    return;
  }
  const config = cloudConfig();
  const db = createPostgresDatabase(await cloudPoolConfig(config.databaseUrl));
  try {
    await upgradeEnglishNames(db);
    console.log(
      "Optional English-name field prepared; existing shop data preserved. Nothing was deployed.",
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "Cloud update failed. No data migration or deployment was performed. Check the private shop connection and retry only after review.",
  );
  process.exitCode = 1;
});
