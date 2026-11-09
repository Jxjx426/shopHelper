import { loadEnvConfig } from "@next/env";
import { cloudConfig } from "../src/lib/cloud-config.server";
import { cloudPoolConfig } from "../src/lib/cloud-pool-config.server";
import { createPostgresDatabase } from "../src/lib/postgres.server";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
async function main() {
  if (!process.argv.includes("--connect")) {
    console.log(
      "Offline check: no connections, account changes or deployment. Local mode remains available. Run npm run typecheck, npm test and npm run test:cloud for isolated tests. After account setup, --connect checks configured TLS, private schema/bucket and Realtime authentication without modifying business data.",
    );
    return;
  }
  const config = cloudConfig(),
    db = createPostgresDatabase(await cloudPoolConfig(config.databaseUrl));
  const client = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    if (
      (await db.query("SELECT version FROM cloud_schema_version WHERE id=1"))
        .rows[0]?.version !== 1
    )
      throw new Error();
    const policy = (
      await db.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid='public.shop_sync'::regclass",
      )
    ).rows[0];
    if (!policy?.relrowsecurity) throw new Error();
    if (
      (
        await db.query(
          "SELECT has_schema_privilege('authenticated','shop_private','USAGE') visible",
        )
      ).rows[0]?.visible
    )
      throw new Error();
    const admin = createClient(config.url, config.serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      bucket = await admin.storage.getBucket(config.bucket);
    if (bucket.error || !bucket.data || bucket.data.public) throw new Error();
    const token = await new SignJWT({
      role: "authenticated",
      shop_session: "connect-check-no-session",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode(config.jwtSecret));
    await client.realtime.setAuth(token);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error()), 12000);
      client
        .channel("cloud-connection-check")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "shop_sync" },
          () => {},
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {
            clearTimeout(timer);
            reject(new Error());
          }
        });
    });
    console.log(
      "Read-only cloud check passed: verified TLS, schema version, private business schema, private bucket and Realtime JWT acceptance. No business changes or deployment. Free-plan status must still be verified in both dashboards.",
    );
  } finally {
    await client.removeAllChannels();
    await client.realtime.disconnect();
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "Cloud check failed. Check server variables, SSL certificate, initialized private schema/bucket, Realtime publication and legacy JWT acceptance. No paid fallback, business changes or deployment.",
  );
  process.exitCode = 1;
});
