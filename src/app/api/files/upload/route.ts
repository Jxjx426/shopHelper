import { NextRequest } from "next/server";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
import { prepareUpload } from "@/lib/uploads.server";
import { withRequestSession } from "@/lib/request-session.server";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  return withRequestSession(request, async () => {
    try {
      guardOrigin(request);
      const user = await requireUser(request);
      return json(await prepareUpload(user.id, await readBody(request, 4096)));
    } catch (e) {
      return failure(e);
    }
  });
}
