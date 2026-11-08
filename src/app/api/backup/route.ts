import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions.server";
import { NextRequest, NextResponse } from "next/server";
import { exportBackup } from "@/lib/service";
import { todayMalaysia } from "@/lib/domain";
import { failure, requireUser } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    await (
      await getDb()
    ).transaction((tx) => requirePermission(tx, user.id, "manage"));
    return new NextResponse(JSON.stringify(await exportBackup(), null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="fresh-helper-${todayMalaysia()}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
