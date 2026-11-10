import { cloudMode } from "@/lib/cloud-config.server";
import { cloudDocumentAsset, redirectAsset } from "@/lib/file-response.server";
import { NextRequest, NextResponse } from "next/server";
import { failure, requireUser, json } from "@/lib/http";
import { documentPdf } from "@/lib/documents.server";
import {
  presentedDocumentPdf,
  presentedDocumentEntry,
} from "@/lib/document-export.server";
import { pdfLanguageSchema } from "@/lib/pdf-options";
import { AppError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
    const id = (await context.params).id;
    const language = pdfLanguageSchema.safeParse(
      request.nextUrl.searchParams.get("language") ?? "zh",
    );
    if (!language.success) throw new AppError("请选择中文或英文单据");
    const original = request.nextUrl.searchParams.get("original") === "1";
    if (original && language.data !== "zh")
      throw new AppError("存档原件不能切换语言，请使用英文预览或下载");
    if (request.nextUrl.searchParams.get("check") === "1") {
      await presentedDocumentEntry(id, language.data);
      return json({ ready: true });
    }
    if (cloudMode()) {
      const asset = await cloudDocumentAsset(
        id,
        request.nextUrl.searchParams.get("original") === "1",
        language.data,
      );
      return redirectAsset(
        asset.id,
        `${asset.number}${language.data === "en" ? "-en" : ""}.pdf`,
        request.nextUrl.searchParams.has("download"),
      );
    }
    const result = await (request.nextUrl.searchParams.get("original") === "1"
      ? documentPdf(id)
      : presentedDocumentPdf(id, language.data));
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${request.nextUrl.searchParams.has("download") ? "attachment" : "inline"}; filename="${result.number.replace(/[^A-Za-z0-9-]/g, "")}${language.data === "en" ? "-en" : ""}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
