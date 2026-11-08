import { NextRequest } from "next/server";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
import { confirmRestore, previewRestore } from "@/lib/backup.server";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    guardOrigin(request);
    const user = await requireUser(request);
    const body = await readBody(request, 128 * 1024 * 1024);
    return json(
      body?.action === "confirm"
        ? await confirmRestore(user.id, body)
        : await previewRestore(user.id, body?.backup),
    );
  } catch (error) {
    return failure(error);
  }
}
