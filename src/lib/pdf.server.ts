import PDFDocument from "pdfkit";
import path from "node:path";
import type { DocumentSnapshot } from "./documents.server";
export async function renderDeliveryPdf(
  snapshot: DocumentSnapshot,
  superseded?: string,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 36, bottom: 38, left: 36, right: 36 },
    bufferPages: true,
    font: path.join(
      process.cwd(),
      "assets/pdf-fonts/NotoSansCJKsc-Regular.otf",
    ),
    info: {
      Title: `送货单 ${snapshot.number}`,
      Author: snapshot.shopName,
      CreationDate: new Date(snapshot.createdAt),
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
    text("送货单 / Delivery Order", left, y, width, 21);
    y += 36;
    if (snapshot.draft || superseded) {
      text(superseded ?? "草稿 / DRAFT - 未定稿", left, y, width, 13);
      y += 26;
    }
    const restaurant = `餐馆：${snapshot.restaurantName}`;
    text(restaurant, left, y, width, 13);
    y += doc.fontSize(13).heightOfString(restaurant, { width, lineGap: 3 }) + 7;
    text(
      `送货日期：${snapshot.date}    版本：${snapshot.revision}`,
      left,
      y,
      width,
      11,
    );
    y += 23;
    text(`单号：${snapshot.number}`, left, y, width, 11);
    y += 27;
    doc.rect(left, y, width, 29).fill("#eef3ed");
    ["商品", "实供数量", "单价 / 计价单位", "金额 (RM)"].forEach((s, i) =>
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
      `${item.name}${item.unavailable ? "\n缺货 / 未供货" : ""}`,
      item.quantity === null ? "待确认" : `${item.quantity} ${item.unit ?? ""}`,
      item.price === null
        ? item.unavailable
          ? "—"
          : "待定价"
        : `RM ${item.price} / ${item.billingUnit}`,
      item.amount ?? "待确认",
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
  if (y + 133 > bottom) {
    doc.addPage();
    header();
  }
  y += 17;
  const totals = [
    [
      snapshot.total === null ? "已确认小计" : "小计",
      `RM ${snapshot.subtotal}`,
    ],
    [
      "舍入调整",
      `${snapshot.rounding.startsWith("-") ? "" : "+"}RM ${snapshot.rounding}`,
    ],
    ["总额", snapshot.total === null ? "待完成" : `RM ${snapshot.total}`],
  ];
  totals.forEach(([label, value], index) => {
    let size = index === 2 ? 17 : 12;
    while (size > 8 && doc.fontSize(size).widthOfString(value) > 147) size--;
    text(label, 285, y, 120, index === 2 ? 14 : 11);
    text(value, 405, y, 147, size, "right");
    y += index === 2 ? 34 : 25;
  });
  if (snapshot.draft) {
    text("草稿仅供核对，不能作为已定稿送货单。", left, y + 7, width, 10);
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(9)
      .fillColor("#4a574e")
      .text(
        `${snapshot.draft ? "草稿 / DRAFT" : superseded ? "已被替代 / SUPERSEDED" : snapshot.number}    第 ${i + 1} / ${pages.count} 页`,
        left,
        807,
        { width, align: "center", lineBreak: false },
      );
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return output;
}
