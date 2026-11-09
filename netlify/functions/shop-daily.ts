import type { Config } from "@netlify/functions";
import { getDb } from "../../src/lib/db";
import { createCloudJob } from "../../src/lib/cloud-jobs.server";
import { todayMalaysia } from "../../src/lib/domain";
export default async () => {
  const owner = (
    await (
      await getDb()
    ).query<{ id: string }>(
      "SELECT id FROM users WHERE active=true AND role IN ('owner','admin') ORDER BY created_at,id LIMIT 1",
    )
  ).rows[0];
  if (owner)
    await createCloudJob(
      owner.id,
      null,
      {
        kind:
          process.env.SHOP_AUTO_BACKUP === "true"
            ? "daily-backup"
            : "maintenance",
      },
      `daily:${todayMalaysia()}`,
    );
};
// UTC 18:00 = 02:00 Malaysia. Scheduled functions have no public HTTP endpoint.
export const config: Config = { schedule: "0 18 * * *" };
