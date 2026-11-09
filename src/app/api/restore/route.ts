import { cloudMode } from "@/lib/cloud-config.server";
import { createCloudJob, cloudJobKey } from "@/lib/cloud-jobs.server";
import { SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { withRequestSession } from "@/lib/request-session.server";
import { NextRequest } from "next/server";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
import { confirmRestore, previewRestore } from "@/lib/backup.server";
export const runtime = "nodejs";
async function post(request: NextRequest) {
  try {
    guardOrigin(request);
    const user = await requireUser(request);
    const body = await readBody(
      request,
      cloudMode() ? 65536 : 128 * 1024 * 1024,
    );
    if (cloudMode())
      return json(
        await createCloudJob(
          user.id,
          tokenHash(request.cookies.get(SESSION_COOKIE)!.value),
          body?.action === "confirm"
            ? {
                kind: "restore-confirm",
                token: body.token,
                shopName: body.shopName,
                confirm: body.confirm,
              }
            : { kind: "restore-preview", uploadId: body.uploadId },
          cloudJobKey(user.id, request.headers.get("Idempotency-Key")),
        ),
        202,
      );
    return json(
      body?.action === "confirm"
        ? await confirmRestore(user.id, body)
        : await previewRestore(user.id, body?.backup),
    );
  } catch (error) {
    return failure(error);
  }
}

export function POST(request: NextRequest) {
  return withRequestSession(request, () => post(request));
}
