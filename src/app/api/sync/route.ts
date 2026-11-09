import { NextRequest } from "next/server";
import { failure, json } from "@/lib/http";
import { SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { syncConfiguration, syncSessionState } from "@/lib/sync.server";
import { AppError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new AppError("请先登录", 401);
    const hash = tokenHash(token),
      session = await syncSessionState(hash);
    if (!session) throw new AppError("请先登录", 401);
    const state = {
      revision: session.revision,
      generation: session.generation,
    };
    return json(
      request.nextUrl.searchParams.has("light")
        ? state
        : await syncConfiguration(session.user_id, hash, state),
    );
  } catch (e) {
    return failure(e);
  }
}
