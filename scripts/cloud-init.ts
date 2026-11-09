import { loadEnvConfig } from "@next/env";
import { cloudConfig } from "../src/lib/cloud-config.server";
import { createPostgresDatabase } from "../src/lib/postgres.server";
import { initialiseCloudDatabase } from "../src/lib/cloud-init.server";
import { createClient } from "@supabase/supabase-js";
import { cloudPoolConfig } from "../src/lib/cloud-pool-config.server";
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log(
      "Dry run: no account, database, storage or deployment changes. Required server settings: DATABASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, SHOP_PUBLIC_ORIGIN, SHOP_CLOUD_FREE_TIER_CONFIRMED=true. Use --apply only after testing and explicit deployment preparation.",
    );
    return;
  }
  const config = cloudConfig();
  const db = createPostgresDatabase(await cloudPoolConfig(config.databaseUrl));
  try {
    await initialiseCloudDatabase(db);
    const client = createClient(config.url, config.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const existing = await client.storage.getBucket(config.bucket);
    if (existing.data?.public)
      throw new Error(
        "The storage bucket must be private; do not upload shop data",
      );
    if (!existing.data) {
      const result = await client.storage.createBucket(config.bucket, {
        public: false,
        fileSizeLimit: 50 * 1024 * 1024,
        allowedMimeTypes: [
          "image/png",
          "image/jpeg",
          "image/webp",
          "application/pdf",
          "application/json",
          "application/gzip",
        ],
      });
      if (result.error)
        throw new Error("Unable to create private storage bucket");
    }
    console.log(
      "Private schema, revision-only Realtime policy and private bucket are prepared. Nothing was deployed.",
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "Cloud preparation failed; verify server configuration and private bucket. No paid fallback or deployment was performed.",
  );
  process.exitCode = 1;
});
