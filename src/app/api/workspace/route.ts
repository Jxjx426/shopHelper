import { NextRequest } from "next/server";
import { workspace } from "@/lib/service";
import { todayMalaysia } from "@/lib/domain";
import { failure, json, requireUser } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const data = await workspace(
      request.nextUrl.searchParams.get("date") ?? todayMalaysia(),
    );
    return json({ ...data, user });
  } catch (error) {
    return failure(error);
  }
}
