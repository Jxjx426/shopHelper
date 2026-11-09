import { cloudMode } from "@/lib/cloud-config.server";
import { createCloudJob, cloudJobKey } from "@/lib/cloud-jobs.server";
import { SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { json } from "@/lib/http";
import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser } from "@/lib/http";
import { rangeDocumentPdf } from "@/lib/document-export.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const p = request.nextUrl.searchParams,
      from = p.get("from") ?? "",
      to = p.get("to") ?? "";
    if (cloudMode())
      return json(
        await createCloudJob(
          user.id,
          tokenHash(request.cookies.get(SESSION_COOKIE)!.value),
          { kind: "pdf-range", from, to, query: p.get("query") ?? "" },
          cloudJobKey(user.id, request.headers.get("Idempotency-Key")),
        ),
        202,
      );
    const result = await rangeDocumentPdf({
      from,
      to,
      query: p.get("query") ?? "",
    });
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Order-List-${from}-${to}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Order-Count": String(result.count),
      },
    });
  } catch (error) {
    return failure(error);
  }
}
