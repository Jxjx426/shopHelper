import { NextResponse } from "next/server";
import { cloudMode } from "./cloud-config.server";
import { getDb } from "./db";
import { fileTicket, storeBlob, hash } from "./file-store.server";
import { AppError } from "./errors";
import type { PdfLanguage } from "./pdf-options";
import { englishDocumentEntries } from "./document-export.server";
export async function respondFile(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  download: boolean,
) {
  if (cloudMode()) {
    const asset = await (
      await getDb()
    ).transaction((tx) =>
      storeBlob(
        tx,
        bytes,
        mime,
        "temporary",
        new Date(Date.now() + 86400000).toISOString(),
      ),
    );
    return redirectAsset(asset.assetId!, filename, download);
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
export async function redirectAsset(
  id: string,
  filename: string,
  download: boolean,
) {
  const ticket = await fileTicket(id, filename);
  if (ticket.parts.length !== 1)
    throw new AppError("此文件需使用分段下载", 409);
  const url = new URL(ticket.parts[0].url);
  if (download) url.searchParams.set("download", filename);
  else url.searchParams.delete("download");
  const r = NextResponse.redirect(url, 302);
  r.headers.set("Cache-Control", "private, no-store");
  return r;
}
export async function cloudDocumentAsset(
  id: string,
  original = false,
  language: PdfLanguage = "zh",
) {
  if (original && language !== "zh")
    throw new AppError("存档原件不能切换语言，请使用英文预览或下载");
  const db = await getDb();
  const row = (
    await db.query<any>(
      "SELECT number,snapshot,superseded_at,pdf_asset_id,superseded_asset_id FROM documents WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError("送货单不存在", 404);
  if (original && (row.superseded_asset_id || row.pdf_asset_id))
    return {
      id: row.superseded_asset_id ?? row.pdf_asset_id,
      number: row.number,
    };
  const [entry] = await englishDocumentEntries(
    [
      {
        snapshot: row.snapshot,
        superseded: row.superseded_at
          ? language === "en"
            ? "SUPERSEDED"
            : "已被替代 / SUPERSEDED"
          : undefined,
      },
    ],
    language,
  );
  const key = hash(
    JSON.stringify([
      "order-list-layout-v3",
      entry.snapshot,
      !!row.superseded_at,
      original,
      language,
    ]),
  );
  let asset = (
    await db.query<{ asset_id: string }>(
      "SELECT asset_id FROM document_views WHERE cache_key=$1",
      [key],
    )
  ).rows[0]?.asset_id;
  if (!asset) {
    const { renderDeliveryPdf } = await import("./pdf.server"),
      { documentPdf } = await import("./documents.server");
    const pdf = original
      ? await documentPdf(id)
      : {
          bytes: await renderDeliveryPdf(entry.snapshot, entry.superseded, {
            language,
          }),
        };
    asset = await db.transaction(async (tx) => {
      const stored = await storeBlob(tx, pdf.bytes, "application/pdf");
      await tx.query(
        "INSERT INTO document_views(cache_key,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [key, stored.assetId],
      );
      return stored.assetId!;
    });
  }
  return { id: asset, number: row.number };
}
