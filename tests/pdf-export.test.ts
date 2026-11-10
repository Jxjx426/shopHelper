import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { hashPassword, makeSession, SESSION_COOKIE } from "../src/lib/auth";
import {
  renderDeliveryPdf,
  renderOrderListPdf,
  combinedDocumentTotal,
} from "../src/lib/pdf.server";
import {
  rangeDocumentEntries,
  presentedDocumentPdf,
  rangeDocumentPdf,
} from "../src/lib/document-export.server";
import {
  documentPdf,
  digest,
  type DocumentSnapshot,
} from "../src/lib/documents.server";
import { GET } from "../src/app/api/documents/export/route";
const actor = randomUUID(),
  restaurant = randomUUID();
let token: string, historicalId: string, archived: Buffer;
let sequence = 0;
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `pdf-export-${randomUUID()}`,
  );
  const db = await getDb();
  await db.query(
    "INSERT INTO users(id,name,password_hash) VALUES($1,'测试店主',$2)",
    [actor, hashPassword("pdf-test-only")],
  );
  await db.query("INSERT INTO restaurants(id,name) VALUES($1,'测试餐馆')", [
    restaurant,
  ]);
  token = await db.transaction((tx) => makeSession(tx, actor));
  const first = await fixture("2026-11-08", "37.50");
  historicalId = first.doc;
  archived = first.pdf;
  await db.query("UPDATE documents SET superseded_at=now() WHERE id=$1", [
    first.doc,
  ]);
  await fixture("2026-11-08", "37.50", first.order, 2);
  await fixture("2026-11-09", "10.10");
  await fixture("2026-11-07", "99.00");
  const deleted = await fixture("2026-11-10", "88.00");
  await db.query("UPDATE orders SET deleted_at=now() WHERE id=$1", [
    deleted.order,
  ]);
  await db.query(
    "INSERT INTO orders(id,restaurant_id,restaurant_name,delivery_date) VALUES($1,$2,'测试餐馆','2026-11-11')",
    [randomUUID(), restaurant],
  );
});
after(async () => {
  await (await getDb()).close();
});
async function fixture(
  date: string,
  total: string,
  existing?: string,
  revision = 1,
) {
  const db = await getDb(),
    order = existing ?? randomUUID(),
    doc = randomUUID();
  sequence++;
  if (!existing)
    await db.query(
      "INSERT INTO orders(id,restaurant_id,restaurant_name,delivery_date) VALUES($1,$2,'测试餐馆',$3)",
      [order, restaurant, date],
    );
  const number = `DO-${date.replaceAll("-", "")}-${String(sequence).padStart(6, "0")}`;
  const snapshot: DocumentSnapshot = {
    shopName: "排版测试（非营业数据）",
    restaurantName: "测试餐馆",
    date,
    number,
    revision,
    draft: false,
    createdAt: "2026-11-08T04:00:00.000Z",
    issues: [],
    items: [
      {
        name: total === "37.50" ? "苹果" : "小白菜",
        quantity: total === "37.50" ? "2.5" : "1.005",
        unit: "kg",
        price: total === "37.50" ? "15.00" : "10.00",
        billingUnit: "kg",
        amount: total === "37.50" ? "37.50" : "10.05",
        unavailable: false,
      },
    ],
    subtotal: total === "37.50" ? "37.50" : "10.05",
    rounding: total === "37.50" ? "0.00" : "0.05",
    total,
  };
  const pdf = await renderDeliveryPdf(snapshot);
  await db.query(
    "INSERT INTO documents(id,order_id,number,revision,sequence_no,snapshot,pdf,pdf_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      doc,
      order,
      number,
      revision,
      sequence,
      JSON.stringify(snapshot),
      pdf,
      digest(pdf),
      actor,
    ],
  );
  await db.query("UPDATE orders SET finalized_document_id=$1 WHERE id=$2", [
    doc,
    order,
  ]);
  return { doc, order, pdf };
}
test("range includes both date boundaries and only the latest finalized, nondeleted orders", async () => {
  const rows = await rangeDocumentEntries({
    from: "2026-11-08",
    to: "2026-11-11",
    query: "测试",
  });
  assert.deepEqual(
    rows.map((r) => [r.snapshot.date, r.snapshot.revision, r.snapshot.total]),
    [
      ["2026-11-08", 2, "37.50"],
      ["2026-11-09", 1, "10.10"],
    ],
  );
  const single = await rangeDocumentEntries({
    from: "2026-11-08",
    to: "2026-11-08",
  });
  assert.equal(single.length, 1);
  await assert.rejects(
    rangeDocumentEntries({ from: "2026-11-09", to: "2026-11-08" }),
    /起止日期/,
  );
  await assert.rejects(
    rangeDocumentEntries({ from: "bad", to: "2026-11-08" }),
    /起止日期/,
  );
  await assert.rejects(
    rangeDocumentEntries({ from: "2026-11-08", to: "2028-11-08" }),
    /最多导出一年/,
  );
  await assert.rejects(
    rangeDocumentEntries({
      from: "2026-11-08",
      to: "2026-11-09",
      query: "不存在",
    }),
    /没有符合条件/,
  );
});
test("authenticated date export downloads one combined PDF, while anonymous requests are rejected", async () => {
  const url =
    "http://127.0.0.1:3001/api/documents/export?from=2026-11-08&to=2026-11-09";
  assert.equal((await GET(new NextRequest(url))).status, 401);
  const response = await GET(
    new NextRequest(url, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Order-Count"), "2");
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  const pdf = Buffer.from(await response.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  await mkdir("output/pdf", { recursive: true });
  await writeFile("output/pdf/order-list-date-range-sample.pdf", pdf);
});
test("simplified presentation leaves original archived bytes and historical amounts untouched", async () => {
  const rendered = await presentedDocumentPdf(historicalId);
  assert.equal(rendered.number.startsWith("DO-"), true);
  const row = (
    await (
      await getDb()
    ).query<{ pdf: Uint8Array; snapshot: DocumentSnapshot }>(
      "SELECT pdf,snapshot FROM documents WHERE id=$1",
      [historicalId],
    )
  ).rows[0];
  assert.deepEqual(Buffer.from(row.pdf), archived);
  assert.equal(row.snapshot.total, "37.50");
  assert.deepEqual(
    Buffer.from((await documentPdf(historicalId)).bytes),
    archived,
  );
});

test("range summaries use saved final totals, support first/last/none, and do not re-round the combined amount", async () => {
  const entries = await rangeDocumentEntries({
    from: "2026-11-08",
    to: "2026-11-09",
  });
  assert.equal(combinedDocumentTotal(entries), "47.60");
  const count = (pdf: Buffer) =>
    (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
  const first = await rangeDocumentPdf({
    from: "2026-11-08",
    to: "2026-11-09",
  });
  const last = await rangeDocumentPdf({
    from: "2026-11-08",
    to: "2026-11-09",
    summary: "last",
  });
  const none = await rangeDocumentPdf({
    from: "2026-11-08",
    to: "2026-11-09",
    summary: "none",
  });
  assert.equal(count(first.bytes), 3);
  assert.equal(count(last.bytes), 3);
  assert.equal(count(none.bytes), 2);
  const cents = entries.map((e, i) => ({
    snapshot: { ...e.snapshot, total: i ? "0.02" : "0.01" },
  }));
  assert.equal(combinedDocumentTotal(cents), "0.03");
  assert.throws(
    () =>
      combinedDocumentTotal([
        { snapshot: { ...entries[0].snapshot, total: null } },
      ]),
    /已定稿/,
  );
  assert.throws(
    () =>
      combinedDocumentTotal([
        { snapshot: { ...entries[0].snapshot, draft: true } },
      ]),
    /已定稿/,
  );
  await writeFile("output/pdf/order-summary-first-zh.pdf", first.bytes);
  await writeFile("test-results/order-summary-last.pdf", last.bytes);
  const many = Array.from({ length: 42 }, (_, i) => ({
    snapshot: {
      ...entries[0].snapshot,
      restaurantName: `长名称餐馆 ${i + 1} 分店`,
      number: `DO-20261108-${String(i + 1).padStart(6, "0")}`,
    },
  }));
  const long = await renderOrderListPdf(many, { summary: "first" });
  assert(
    count(long) > 43,
    "summary must paginate independently of the 42 order pages",
  );
  await writeFile("test-results/order-summary-long.pdf", long);
});
test("invalid export languages and summary positions are rejected before document generation", async () => {
  for (const param of ["language=fr", "summary=middle"]) {
    const response = await GET(
      new NextRequest(
        `http://127.0.0.1:3001/api/documents/export?from=2026-11-08&to=2026-11-09&${param}`,
        { headers: { Cookie: `${SESSION_COOKIE}=${token}` } },
      ),
    );
    assert.equal(response.status, 400);
  }
});
