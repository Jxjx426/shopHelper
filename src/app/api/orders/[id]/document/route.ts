import { NextRequest, NextResponse } from "next/server";
import { failure, json, requireUser } from "@/lib/http";
import { documentPreview, draftPdf } from "@/lib/documents.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
    const { id } = await context.params;
    if (request.nextUrl.searchParams.get("pdf") === "draft")
      return new NextResponse(new Uint8Array(await draftPdf(id)), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="DRAFT-delivery-order.pdf"',
          "Cache-Control": "private, no-store",
        },
      });
    return json(await documentPreview(id));
  } catch (error) {
    return failure(error);
  }
}
