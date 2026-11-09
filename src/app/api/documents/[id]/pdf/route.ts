import { cloudMode } from "@/lib/cloud-config.server";
import { cloudDocumentAsset, redirectAsset } from "@/lib/file-response.server";
import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser } from "@/lib/http";
import { documentPdf } from "@/lib/documents.server";
import { presentedDocumentPdf } from "@/lib/document-export.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
    const id = (await context.params).id;
    if (cloudMode()) {
      const asset = await cloudDocumentAsset(
        id,
        request.nextUrl.searchParams.get("original") === "1",
      );
      return redirectAsset(
        asset.id,
        `${asset.number}.pdf`,
        request.nextUrl.searchParams.has("download"),
      );
    }
    const result = await (request.nextUrl.searchParams.get("original") === "1"
      ? documentPdf(id)
      : presentedDocumentPdf(id));
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${request.nextUrl.searchParams.has("download") ? "attachment" : "inline"}; filename="${result.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
