import { cloudMode } from "@/lib/cloud-config.server";
import { createCloudJob, cloudJobKey } from "@/lib/cloud-jobs.server";
import { SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { json } from "@/lib/http";
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
    if (cloudMode())
      return json(
        await createCloudJob(
          user.id,
          tokenHash(request.cookies.get(SESSION_COOKIE)!.value),
          {
            kind: "backup",
            ...(request.nextUrl.searchParams.has("backupId")
              ? { backupId: request.nextUrl.searchParams.get("backupId")! }
              : {}),
          },
          cloudJobKey(user.id, request.headers.get("Idempotency-Key")),
        ),
        202,
      );
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
