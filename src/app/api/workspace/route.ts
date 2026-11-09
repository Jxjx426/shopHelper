import { NextRequest } from "next/server";
import { workspace } from "@/lib/service";
import { todayMalaysia } from "@/lib/domain";
import { failure, json, requireUser } from "@/lib/http";
import { syncState } from "@/lib/sync.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const state = await syncState();
    const etag = `"${state.generation}:${state.revision}:${user.id}:${request.nextUrl.searchParams.get("date") ?? todayMalaysia()}"`;
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-store" },
      });
    const data = await workspace(
      request.nextUrl.searchParams.get("date") ?? todayMalaysia(),
    );
    const response = json({ ...data, user });
    response.headers.set("ETag", etag);
    return response;
  } catch (error) {
    return failure(error);
  }
}
