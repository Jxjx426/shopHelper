import { NextRequest } from "next/server";
import { runAction } from "@/lib/service";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
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
