import PDFDocument from "pdfkit";
import path from "node:path";
import Decimal from "decimal.js";
import type { DocumentSnapshot } from "./documents.server";
import type { PdfOptions } from "./pdf-options";
import type { Unit } from "./domain";
const englishUnits: Record<Unit, string> = {
  kg: "kg",
  g: "g",
  包: "pack",
  箱: "box",
  粒: "pc",
  条: "pc",
  支: "pc",
};
export type PdfEntry = { snapshot: DocumentSnapshot; superseded?: string };
export function combinedDocumentTotal(entries: readonly PdfEntry[]) {
  return entries
    .reduce((sum, { snapshot }) => {
      if (
        snapshot.draft ||
        snapshot.total === null ||
        !/^\d+\.\d{2}$/.test(snapshot.total)
      )
        throw new Error("汇总只接受金额完整的已定稿单据");
      return sum.plus(snapshot.total);
    }, new Decimal(0))
    .toFixed(2);
}
export function renderDeliveryPdf(
  snapshot: DocumentSnapshot,
  superseded?: string,
  options: PdfOptions = {},
) {
  return renderOrderListPdf([{ snapshot, superseded }], {
    ...options,
    summary: "none",
  });
}
export async function renderOrderListPdf(
  entries: readonly PdfEntry[],
  options: PdfOptions = {},
): Promise<Buffer> {
  if (!entries.length) throw new Error("没有可导出的单据");
  if (
    options.language === "en" &&
    entries.some((e) => e.snapshot.items.some((i) => !i.nameEnglish?.trim()))
  )
    throw new Error("英文单据缺少已确认的英文商品名");
  const summaryTotal =
    options.summary && options.summary !== "none"
      ? combinedDocumentTotal(entries)
      : null;
  const first = entries[0].snapshot;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 36, bottom: 38, left: 36, right: 36 },
    bufferPages: true,
    font: path.join(
      process.cwd(),
      "assets/pdf-fonts/NotoSansCJKsc-Regular.otf",
    ),
    info: {
      Title: "Order List",
      Author: first.shopName,
      CreationDate: new Date(first.createdAt),
    },
  });
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 36,
    right = 559,
    width = 523,
    bottom = 786;
  const cols = [
    { x: 36, w: 225 },
    { x: 261, w: 90 },
    { x: 351, w: 112 },
    { x: 463, w: 96 },
  ];
  const en = options.language === "en";
  const unit = (value: Unit | null) =>
    value ? (en ? englishUnits[value] : value) : "";
  const summary = options.summary ?? "none";
  function summaryPages() {
    const total = summaryTotal!;
    const startPage = doc.bufferedPageRange().count - 1;
    const columns = [
      { x: 36, w: 85 },
      { x: 121, w: 175 },
      { x: 296, w: 170 },
      { x: 466, w: 93 },
    ];
    let y = 36;
    function header() {
      y = 36;
      doc
        .fontSize(16)
        .fillColor("#17251e")
        .text(first.shopName, left, y, { width });
      y = doc.y + 14;
      doc
        .fontSize(21)
        .text(en ? "Order Summary" : "订单汇总", left, y, { width });
      y = doc.y + 12;
      const dates = entries.map((e) => e.snapshot.date).sort();
      const from = options.from ?? dates[0],
        to = options.to ?? dates.at(-1);
      const period = from === to ? from : `${from} - ${to}`;
      doc
        .fontSize(11)
        .text(
          `${period}   |   ${entries.length} ${en ? (entries.length === 1 ? "order" : "orders") : "张单据"}`,
          left,
          y,
          { width },
        );
      y = doc.y + 14;
      doc
        .fontSize(14)
        .text(en ? "Grand Total" : "最终总额", left, y, { width: 200 });
      doc.fontSize(17).text(`RM ${total}`, left + 200, y, {
        width: width - 200,
        align: "right",
      });
      y = doc.y + 18;
      doc.rect(left, y, width, 29).fill("#eef3ed");
      [
        en ? "Date" : "日期",
        en ? "Restaurant" : "餐馆",
        en ? "Order No." : "单号",
        en ? "Total (RM)" : "总额 (RM)",
      ].forEach((label, i) => {
        doc
          .fontSize(10)
          .fillColor("#17251e")
          .text(label, columns[i].x + 6, y + 7, {
            width: columns[i].w - 12,
            align: i === 3 ? "right" : "left",
          });
      });
      y += 29;
    }
    header();
    for (const { snapshot } of entries) {
      const values = [
        snapshot.date,
        snapshot.restaurantName,
        snapshot.number,
        snapshot.total!,
      ];
      const height = Math.max(
        36,
        ...values.map(
          (v, i) =>
            doc
              .fontSize(10)
              .heightOfString(v, { width: columns[i].w - 12, lineGap: 2 }) + 14,
        ),
      );
      if (y + height > bottom) {
        doc.addPage();
        header();
      }
      values.forEach((value, i) =>
        doc
          .fontSize(10)
          .fillColor("#17251e")
          .text(value, columns[i].x + 6, y + 7, {
            width: columns[i].w - 12,
            align: i === 3 ? "right" : "left",
            lineGap: 2,
          }),
      );
      y += height;
      doc
        .moveTo(left, y)
        .lineTo(right, y)
        .strokeColor("#ccd5cd")
        .lineWidth(0.5)
        .stroke();
    }
    const lastPage = doc.bufferedPageRange().count - 1;
    for (let page = startPage; page <= lastPage; page++) {
      doc.switchToPage(page);
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(9)
        .fillColor("#4a574e")
        .text(
          `${en ? "Summary" : "汇总"} ${page - startPage + 1} / ${lastPage - startPage + 1}`,
          left,
          807,
          { width, align: "center", lineBreak: false },
        );
      doc.page.margins.bottom = margin;
    }
    doc.switchToPage(lastPage);
  }
  if (summary === "first") summaryPages();
  for (const [entryIndex, { snapshot, superseded }] of entries.entries()) {
    if (entryIndex || summary === "first") doc.addPage();
    const firstPage = doc.bufferedPageRange().count - 1;
    let y = 36;
    const text = (
      value: string,
      x: number,
      top: number,
      w: number,
      size = 11,
      align: "left" | "right" = "left",
    ) => {
      doc
        .fontSize(size)
        .fillColor("#17251e")
        .text(value, x, top, { width: w, align, lineGap: 3 });
    };
    function header() {
      y = 36;
      text(snapshot.shopName, left, y, width, 16);
      y +=
        doc
          .fontSize(16)
          .heightOfString(snapshot.shopName, { width, lineGap: 3 }) + 8;
      text("Order List", left, y, width, 21);
      y += 36;
      if (snapshot.draft || superseded) {
        text(
          superseded ??
            (en ? "DRAFT - Not finalized" : "草稿 / DRAFT - 未定稿"),
          left,
          y,
          width,
          13,
        );
        y += 26;
      }
      const restaurant = `${en ? "Restaurant: " : "餐馆："}${snapshot.restaurantName}`;
      text(restaurant, left, y, width, 13);
      y +=
        doc.fontSize(13).heightOfString(restaurant, { width, lineGap: 3 }) + 7;
      text(
        `${en ? "Delivery date: " : "送货日期："}${snapshot.date}`,
        left,
        y,
        width,
        11,
      );
      y += 23;
      text(
        `${en ? "Order No.: " : "单号："}${snapshot.number}`,
        left,
        y,
        width,
        11,
      );
      y += 27;
      doc.rect(left, y, width, 29).fill("#eef3ed");
      (en
        ? ["Product", "Supplied", "Price / unit", "Amount (RM)"]
        : ["商品", "实供数量", "单价 / 计价单位", "金额 (RM)"]
      ).forEach((s, i) =>
        text(
          s,
          cols[i].x + 7,
          y + 6,
          cols[i].w - 14,
          10,
          i === 3 ? "right" : "left",
        ),
      );
      y += 29;
    }
    header();
    snapshot.items.forEach((item) => {
      const values = [
        `${en ? item.nameEnglish! : item.name}${item.unavailable ? (en ? "\nNot supplied" : "\n缺货 / 未供货") : ""}`,
        item.quantity === null
          ? en
            ? "Pending"
            : "待确认"
          : `${item.quantity} ${unit(item.unit)}`,
        item.price === null
          ? item.unavailable
            ? "—"
            : en
              ? "Price pending"
              : "待定价"
          : `RM ${item.price} / ${unit(item.billingUnit)}`,
        item.amount ?? (en ? "Pending" : "待确认"),
      ];
      const sizes = values.map((value, i) => {
        let size = 11;
        if (i === 2)
          while (
            size > 8 &&
            doc.fontSize(size).widthOfString(value) > cols[i].w - 14
          )
            size -= 0.5;
        return size;
      });
      const height = Math.max(
        42,
        ...values.map(
          (v, i) =>
            doc
              .fontSize(sizes[i])
              .heightOfString(v, { width: cols[i].w - 14, lineGap: 3 }) + 18,
        ),
      );
      if (y + height > bottom) {
        doc.addPage();
        header();
      }
      values.forEach((v, i) =>
        text(
          v,
          cols[i].x + 7,
          y + 8,
          cols[i].w - 14,
          sizes[i],
          i === 3 ? "right" : "left",
        ),
      );
      y += height;
      doc
        .moveTo(left, y)
        .lineTo(right, y)
        .strokeColor("#ccd5cd")
        .lineWidth(0.5)
        .stroke();
    });
    if (y + 73 > bottom) {
      doc.addPage();
      header();
    }
    y += 17;
    const total =
      snapshot.total === null
        ? en
          ? "Pending"
          : "待完成"
        : `RM ${snapshot.total}`;
    let totalSize = 17;
    while (totalSize > 8 && doc.fontSize(totalSize).widthOfString(total) > 147)
      totalSize--;
    text(en ? "Total" : "最终总额", 285, y, 120, 14);
    text(total, 405, y, 147, totalSize, "right");
    y += 34;
    if (snapshot.draft) {
      text(
        en
          ? "Draft for review only. Not a finalized order."
          : "草稿仅供核对，不能作为已定稿送货单。",
        left,
        y + 7,
        width,
        10,
      );
    }
    const pages = doc.bufferedPageRange();
    for (let i = firstPage; i < pages.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(9)
        .fillColor("#4a574e")
        .text(
          `${snapshot.draft ? (en ? "DRAFT" : "草稿 / DRAFT") : superseded ? (en ? "SUPERSEDED" : "已被替代 / SUPERSEDED") : snapshot.number}    ${en ? `Page ${i - firstPage + 1} / ${pages.count - firstPage}` : `第 ${i - firstPage + 1} / ${pages.count - firstPage} 页`}`,
          left,
          807,
          { width, align: "center", lineBreak: false },
        );
      doc.page.margins.bottom = bottomMargin;
    }
  }
  if (summary === "last") {
    doc.addPage();
    summaryPages();
  }
  doc.end();
  return output;
}
