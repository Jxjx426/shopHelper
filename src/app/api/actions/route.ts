import { withRequestSession } from "@/lib/request-session.server";
import { NextRequest } from "next/server";
import { runAction } from "@/lib/service";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
export const runtime = "nodejs";
async function post(request: NextRequest) {
  try {
    guardOrigin(request);
    const user = await requireUser(request);
    const body = await readBody(request);
    return json(
      await runAction(
        user.id,
        request.headers.get("idempotency-key") ?? "",
        body,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}

export function POST(request: NextRequest) {
  return withRequestSession(request, () => post(request));
}
