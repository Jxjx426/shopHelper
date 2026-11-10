import { getDb } from "./db";
import { validDate } from "./domain";
import { AppError } from "./errors";
import {
  renderDeliveryPdf,
  renderOrderListPdf,
  type PdfEntry,
} from "./pdf.server";
import type { DocumentSnapshot } from "./documents.server";
import {
  pdfSummarySchema,
  pdfLanguageSchema,
  type PdfSummary,
  type PdfLanguage,
} from "./pdf-options";
import { normalizeName } from "./import-types";

export async function englishDocumentEntries(
  entries: readonly PdfEntry[],
  language: PdfLanguage,
) {
  if (language !== "en") return [...entries];
  const needed = entries.flatMap((e) =>
    e.snapshot.items.filter((i) => !i.nameEnglish?.trim()),
  );
  const products = needed.length
    ? (
        await (
          await getDb()
        ).query<{
          id: string;
          name: string;
          aliases: string[];
          english_name: string | null;
        }>(
          "SELECT p.id,p.name,p.aliases,to_jsonb(p)->>'english_name' AS english_name FROM products p WHERE p.id=ANY($1::text[]) OR lower(p.name)=ANY($2::text[]) OR EXISTS(SELECT 1 FROM unnest(p.aliases) alias WHERE lower(alias)=ANY($2::text[]))",
          [
            needed.map((i) => i.productId).filter(Boolean),
            [...new Set(needed.map((i) => normalizeName(i.name)))],
          ],
        )
      ).rows
    : [];
  const missing = new Set<string>();
  const result = entries.map((entry) => ({
    ...entry,
    snapshot: {
      ...entry.snapshot,
      items: entry.snapshot.items.map((item) => {
        if (item.nameEnglish?.trim()) return { ...item };
        const exact = item.productId
          ? products.filter((p) => p.id === item.productId)
          : products.filter(
              (p) => normalizeName(p.name) === normalizeName(item.name),
            );
        const candidates = exact.length
          ? exact
          : item.productId
            ? []
            : products.filter((p) =>
                p.aliases.some(
                  (a) => normalizeName(a) === normalizeName(item.name),
                ),
              );
        const nameEnglish =
          candidates.length === 1
            ? candidates[0].english_name?.trim()
            : undefined;
        if (!nameEnglish) missing.add(item.name);
        return { ...item, ...(nameEnglish ? { nameEnglish } : {}) };
      }),
    },
  }));
  if (missing.size)
    throw new AppError(
      `请先到「设置 → 商品价格」补填英文商品名：${[...missing].slice(0, 12).join("、")}${missing.size > 12 ? ` 等 ${missing.size} 项` : ""}`,
    );
  return result;
}

// Present saved financial snapshots with the current layout. Original PDF bytes
// and snapshots remain untouched in storage and business backups.
export async function presentedDocumentEntry(
  id: string,
  language: PdfLanguage = "zh",
) {
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
  return { number: row.number, ...entry };
}
export async function presentedDocumentPdf(
  id: string,
  language: PdfLanguage = "zh",
) {
  const entry = await presentedDocumentEntry(id, language);
  return {
    number: entry.number,
    bytes: await renderDeliveryPdf(entry.snapshot, entry.superseded, {
      language,
    }),
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
  summary?: PdfSummary;
  language?: PdfLanguage;
}) {
  const summary = pdfSummarySchema.safeParse(input.summary ?? "first");
  if (!summary.success) throw new AppError("请选择有效的汇总页位置");
  const language = pdfLanguageSchema.safeParse(input.language ?? "zh");
  if (!language.success) throw new AppError("请选择中文或英文单据");
  const entries = await englishDocumentEntries(
    await rangeDocumentEntries(input),
    language.data,
  );
  return {
    bytes: await renderOrderListPdf(entries, {
      language: language.data,
      summary: summary.data,
      from: input.from,
      to: input.to,
    }),
    count: entries.length,
  };
}
