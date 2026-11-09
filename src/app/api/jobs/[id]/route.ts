import { NextRequest } from "next/server";
import { getSession, SESSION_COOKIE } from "@/lib/auth";
import { jobStatus } from "@/lib/cloud-jobs.server";
import { failure, json } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSession(request.cookies.get(SESSION_COOKIE)?.value);
    return json(
      await jobStatus(
        user?.id ?? null,
        (await context.params).id,
        request.headers.get("X-Job-Receipt") ?? undefined,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
