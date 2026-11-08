import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser } from "@/lib/http";
import { imageForDraft } from "@/lib/imports.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const image = await imageForDraft(
      user.id,
      (await params).id,
      request.nextUrl.searchParams.get("kind") === "prepared",
    );
    return new NextResponse(new Uint8Array(image.bytes).buffer, {
      headers: {
        "Content-Type": image.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
