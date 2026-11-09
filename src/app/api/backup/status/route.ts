import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { backupStatus } from "@/lib/scheduled-backup.server";
import { requirePermission } from "@/lib/permissions.server";
import { failure, json, requireUser } from "@/lib/http";
import { cloudMode } from "@/lib/cloud-config.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    await (
      await getDb()
    ).transaction((tx) => requirePermission(tx, user.id, "manage"));
    if (cloudMode()) {
      const db = await getDb();
      const records = (
        await db.query(
          "SELECT id,kind,created_at FROM backup_records ORDER BY created_at DESC LIMIT 14",
        )
      ).rows;
      const last = (
        await db.query(
          "SELECT created_at FROM backup_records WHERE kind='daily' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      const job = (
        await db.query(
          "SELECT status,error FROM cloud_jobs WHERE kind='daily-backup' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      const usage = (
        await db.query(
          "SELECT coalesce(sum(size),0)::text bytes FROM file_assets",
        )
      ).rows[0];
      return json({
        cloud: true,
        enabled: process.env.SHOP_AUTO_BACKUP === "true",
        lastSuccess: last?.created_at ?? null,
        error: job?.status === "failed" ? job.error : null,
        records,
        bytes: Number(usage.bytes),
      });
    }
    return json({
      cloud: false,
      enabled: process.env.SHOP_AUTO_BACKUP === "true",
      ...backupStatus,
    });
  } catch (error) {
    return failure(error);
  }
}
