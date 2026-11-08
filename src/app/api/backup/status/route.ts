import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { backupStatus } from "@/lib/scheduled-backup.server";
import { requirePermission } from "@/lib/permissions.server";
import { failure, json, requireUser } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    await (
      await getDb()
    ).transaction((tx) => requirePermission(tx, user.id, "manage"));
    return json({
      enabled: process.env.SHOP_AUTO_BACKUP === "true",
      ...backupStatus,
    });
  } catch (error) {
    return failure(error);
  }
}
