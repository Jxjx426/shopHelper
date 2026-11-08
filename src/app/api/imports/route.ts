import { NextRequest } from "next/server";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
import { createImport, listDrafts } from "@/lib/imports.server";
import { extractionConfig } from "@/lib/gemini.server";
import { todayMalaysia } from "@/lib/domain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    return json({
      drafts: await listDrafts(
        user.id,
        request.nextUrl.searchParams.get("date") ?? todayMalaysia(),
      ),
      config: extractionConfig(),
      deletedDrafts: await listDrafts(
        user.id,
        request.nextUrl.searchParams.get("date") ?? todayMalaysia(),
        true,
      ),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    guardOrigin(request);
    const user = await requireUser(request);
    return json(
      await createImport(
        user.id,
        request.headers.get("idempotency-key") ?? "",
        await readBody(request, 16 * 1024 * 1024),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
