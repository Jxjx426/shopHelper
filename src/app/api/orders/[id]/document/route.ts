import { respondFile } from "@/lib/file-response.server";
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
      return respondFile(
        await draftPdf(id),
        "application/pdf",
        "DRAFT-delivery-order.pdf",
        false,
      );
    return json(await documentPreview(id));
  } catch (error) {
    return failure(error);
  }
}
