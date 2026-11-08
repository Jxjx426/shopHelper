import { getDb } from "./db";
import { validDate } from "./domain";
import { AppError } from "./errors";
import {
  renderDeliveryPdf,
  renderOrderListPdf,
  type PdfEntry,
} from "./pdf.server";
import type { DocumentSnapshot } from "./documents.server";

// Present saved financial snapshots with the current layout. Original PDF bytes
// and snapshots remain untouched in storage and business backups.
export async function presentedDocumentPdf(id: string) {
  const row = (
    await (
      await getDb()
    ).query<{
      snapshot: DocumentSnapshot;
      number: string;
      superseded_at: string | null;
    }>("SELECT snapshot,number,superseded_at FROM documents WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new AppError("送货单不存在", 404);
  return {
    number: row.number,
    bytes: await renderDeliveryPdf(
      row.snapshot,
      row.superseded_at ? "已被替代 / SUPERSEDED" : undefined,
    ),
  };
}
export async function rangeDocumentEntries(input: {
  from: string;
  to: string;
  query?: string;
}) {
  const { from, to, query = "" } = input;
  if (!validDate(from) || !validDate(to) || from > to || query.length > 80)
    throw new AppError("请选择有效的起止日期，结束日期不能早于开始日期");
  if (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86400000 >
    365
  )
    throw new AppError("一次最多导出一年，请缩短日期范围");
  const rows = (
    await (
      await getDb()
    ).query<{ snapshot: DocumentSnapshot }>(
      "SELECT d.snapshot FROM orders o JOIN documents d ON d.id=o.finalized_document_id AND d.order_id=o.id WHERE o.deleted_at IS NULL AND d.superseded_at IS NULL AND o.delivery_date BETWEEN $1::date AND $2::date AND o.restaurant_name ILIKE $3 ORDER BY o.delivery_date,o.restaurant_name,d.number LIMIT 501",
      [from, to, `%${query}%`],
    )
  ).rows;
  if (!rows.length)
    throw new AppError("所选日期内没有符合条件的已定稿单据", 404);
  if (
    rows.length > 500 ||
    rows.reduce((n, r) => n + r.snapshot.items.length, 0) > 20000
  )
    throw new AppError("单据较多，请缩短日期范围或指定餐馆");
  return rows.map((row) => ({ snapshot: row.snapshot }) satisfies PdfEntry);
}
export async function rangeDocumentPdf(input: {
  from: string;
  to: string;
  query?: string;
}) {
  const entries = await rangeDocumentEntries(input);
  return { bytes: await renderOrderListPdf(entries), count: entries.length };
}
