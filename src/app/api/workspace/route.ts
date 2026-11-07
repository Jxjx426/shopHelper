import { NextRequest } from "next/server";
import { workspace } from "@/lib/service";
import { todayMalaysia } from "@/lib/domain";
import { failure, json, requireUser } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    return json(
      await workspace(
        request.nextUrl.searchParams.get("date") ?? todayMalaysia(),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
