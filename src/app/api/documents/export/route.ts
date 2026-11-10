import { cloudMode } from "@/lib/cloud-config.server";
import { createCloudJob, cloudJobKey } from "@/lib/cloud-jobs.server";
import { SESSION_COOKIE, tokenHash } from "@/lib/auth";
import { json } from "@/lib/http";
import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser } from "@/lib/http";
import { rangeDocumentPdf } from "@/lib/document-export.server";
import { pdfSummarySchema, pdfLanguageSchema } from "@/lib/pdf-options";
import { AppError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const p = request.nextUrl.searchParams,
      from = p.get("from") ?? "",
      to = p.get("to") ?? "";
    const summary = pdfSummarySchema.safeParse(p.get("summary") ?? "first");
    if (!summary.success) throw new AppError("请选择有效的汇总页位置");
    const language = pdfLanguageSchema.safeParse(p.get("language") ?? "zh");
    if (!language.success) throw new AppError("请选择中文或英文单据");
    if (cloudMode())
      return json(
        await createCloudJob(
          user.id,
          tokenHash(request.cookies.get(SESSION_COOKIE)!.value),
          {
            kind: "pdf-range",
            from,
            to,
            query: p.get("query") ?? "",
            summary: summary.data,
            language: language.data,
          },
          cloudJobKey(user.id, request.headers.get("Idempotency-Key")),
        ),
        202,
      );
    const result = await rangeDocumentPdf({
      from,
      to,
      query: p.get("query") ?? "",
      summary: summary.data,
      language: language.data,
    });
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Order-List-${from}-${to}${language.data === "en" ? "-en" : ""}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Order-Count": String(result.count),
      },
    });
  } catch (error) {
    return failure(error);
  }
}
