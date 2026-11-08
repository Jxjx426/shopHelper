import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser } from "@/lib/http";
import { documentPdf } from "@/lib/documents.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
    const result = await documentPdf((await context.params).id);
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
