import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { getDb, type Database } from "../src/lib/db";
import { runAction, workspace, exportBackup } from "../src/lib/service";
import { hashPassword, makeSession, SESSION_COOKIE } from "../src/lib/auth";
import {
  documentPreview,
  documentPdf,
  type DocumentSnapshot,
} from "../src/lib/documents.server";
import {
  englishDocumentEntries,
  presentedDocumentEntry,
  rangeDocumentPdf,
} from "../src/lib/document-export.server";
import { renderOrderListPdf } from "../src/lib/pdf.server";
import {
  validateBackup,
  previewRestore,
  confirmRestore,
} from "../src/lib/backup.server";
import { upgradeEnglishNames } from "../src/lib/cloud-upgrade.server";
import { GET } from "../src/app/api/documents/[id]/pdf/route";
const actor = randomUUID(),
  day = "2026-11-10";
let product: string,
  restaurant: string,
  zone: string,
  documentId: string,
  session: string;
let frozen: DocumentSnapshot, archived: Buffer;
const action = (a: unknown) => runAction(actor, randomUUID(), a);
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `pdf-language-${randomUUID()}`,
  );
  const db = await getDb();
  await db.query(
    "INSERT INTO users(id,name,password_hash) VALUES($1,'PDF 测试店主',$2)",
    [actor, hashPassword("pdf-language-only")],
  );
  await action({
    action: "saveShop",
    version: (await workspace(day)).shop.version,
    name: "KY",
  });
  zone = (await action({ action: "saveZone", name: "A区", active: true })).id;
  product = (
    await action({
      action: "saveProduct",
      name: "苹果",
      englishName: "Apple",
      aliases: ["apple"],
      zoneId: zone,
      sortOrder: 1,
      active: true,
      units: [{ orderUnit: "kg", billingUnit: "kg", price: "15.00" }],
    })
  ).id;
  restaurant = (
    await action({
      action: "saveRestaurant",
      name: "Fukumiya",
      aliases: [],
      active: true,
    })
  ).id;
  const orderId = (
    await action({
      action: "saveOrder",
      restaurantId: restaurant,
      date: day,
      urgent: false,
      items: [{ productId: product, quantity: "2.5", unit: "kg" }],
    })
  ).id;
  let item = (await workspace(day)).orders.find((o) => o.id === orderId)!
    .items[0];
  await action({
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2.5",
    unit: "kg",
  });
  const review = await documentPreview(orderId);
  await action({
    action: "finalizeOrder",
    id: orderId,
    token: review.token,
    finalChecked: true,
  });
  const ready = await documentPreview(orderId);
  documentId = ready.finalizedDocumentId!;
  frozen = ready.snapshot;
  archived = Buffer.from((await documentPdf(documentId)).bytes);
  session = await db.transaction((tx) => makeSession(tx, actor));
  await mkdir("output/pdf", { recursive: true });
});
after(async () => {
  await (await getDb()).close();
  globalThis.shopDatabase = undefined;
});
test("new financial snapshots freeze English names; catalog edits and legacy clients preserve that history", async () => {
  assert.equal(frozen.items[0].productId, product);
  assert.equal(frozen.items[0].nameEnglish, "Apple");
  const p = (await workspace(day)).products.find((p) => p.id === product)!;
  for (const englishName of ["x".repeat(81), "two\nlines"]) {
    await assert.rejects(
      action({
        action: "saveProduct",
        id: p.id,
        version: p.version,
        name: p.name,
        englishName,
        aliases: p.aliases,
        zoneId: p.zone_id,
        sortOrder: p.sort_order,
        active: true,
        units: p.units,
      }),
    );
  }
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    englishName: "Fresh Apple",
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: p.sort_order,
    active: true,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "99.00" }],
  });
  const next = (await workspace(day)).products.find((p) => p.id === product)!;
  await action({
    action: "saveProduct",
    id: next.id,
    version: next.version,
    name: next.name,
    aliases: next.aliases,
    zoneId: next.zone_id,
    sortOrder: next.sort_order,
    active: true,
    units: next.units,
  });
  assert.equal(
    (await workspace(day)).products.find((p) => p.id === product)!.english_name,
    "Fresh Apple",
  );
  const current = await presentedDocumentEntry(documentId, "en");
  assert.equal(current.snapshot.items[0].nameEnglish, "Apple");
  assert.equal(current.snapshot.items[0].price, "15.00");
  assert.equal(current.snapshot.total, "37.50");
  assert.deepEqual(
    Buffer.from((await documentPdf(documentId)).bytes),
    archived,
  );
  const en = await rangeDocumentPdf({ from: day, to: day, language: "en" });
  await writeFile("output/pdf/order-summary-first-en.pdf", en.bytes);
  const zh = await rangeDocumentPdf({ from: day, to: day, language: "zh" });
  await writeFile("output/pdf/order-summary-example-zh.pdf", zh.bytes);
  await writeFile("output/pdf/order-summary-example-en.pdf", en.bytes);
});
test("legacy snapshots use only unique saved translations; missing or ambiguous English names block export", async () => {
  const old = structuredClone(frozen);
  delete old.items[0].productId;
  delete old.items[0].nameEnglish;
  const translated = await englishDocumentEntries([{ snapshot: old }], "en");
  assert.equal(translated[0].snapshot.items[0].nameEnglish, "Fresh Apple");
  assert.equal(old.items[0].nameEnglish, undefined);
  assert.equal(translated[0].snapshot.total, old.total);
  const missing = {
    ...old,
    items: [{ ...old.items[0], name: "未设英文名的商品" }],
  };
  await assert.rejects(
    englishDocumentEntries([{ snapshot: missing }], "en"),
    /补填英文商品名.*未设英文名/,
  );
  await assert.rejects(
    renderOrderListPdf([{ snapshot: missing }], { language: "en" }),
    /缺少/,
  );
  await action({
    action: "saveProduct",
    name: "另一款苹果",
    englishName: "Other Apple",
    aliases: ["shared"],
    zoneId: zone,
    sortOrder: 2,
    active: true,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "1.00" }],
  });
  await (
    await getDb()
  ).query(
    "UPDATE products SET aliases=array_append(aliases,'shared') WHERE id=$1",
    [product],
  );
  await assert.rejects(
    englishDocumentEntries(
      [{ snapshot: { ...old, items: [{ ...old.items[0], name: "shared" }] } }],
      "en",
    ),
    /补填/,
  );
});
test("English PDF preflight is authenticated; original archived downloads cannot be silently translated", async () => {
  const url = `http://127.0.0.1:3001/api/documents/${documentId}/pdf?language=en&check=1`;
  assert.equal(
    (
      await GET(new NextRequest(url), {
        params: Promise.resolve({ id: documentId }),
      })
    ).status,
    401,
  );
  const headers = { Cookie: `${SESSION_COOKIE}=${session}` };
  const ready = await GET(new NextRequest(url, { headers }), {
    params: Promise.resolve({ id: documentId }),
  });
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
  for (const query of ["language=fr", "language=en&original=1"]) {
    const r = await GET(
      new NextRequest(url.split("?")[0] + "?" + query, { headers }),
      { params: Promise.resolve({ id: documentId }) },
    );
    assert.equal(r.status, 400);
  }
  const response = await GET(
    new NextRequest(url.replace("&check=1", "&download=1"), { headers }),
    { params: Promise.resolve({ id: documentId }) },
  );
  assert.equal(response.status, 200);
  assert(response.headers.get("Content-Disposition")!.includes("-en.pdf"));
});
test("English catalog fields and frozen snapshots survive a complete validated backup restoration", async () => {
  const backup = await exportBackup();
  await validateBackup(backup);
  const preview = await previewRestore(actor, backup);
  await confirmRestore(actor, {
    token: preview.token,
    confirm: true,
    shopName: preview.shopName,
  });
  assert.equal(
    (await workspace(day)).products.find((p) => p.id === product)!.english_name,
    "Fresh Apple",
  );
  assert.equal(
    (await presentedDocumentEntry(documentId, "en")).snapshot.items[0]
      .nameEnglish,
    "Apple",
  );
  assert.deepEqual(
    Buffer.from((await documentPdf(documentId)).bytes),
    archived,
  );
});
test("the explicit cloud upgrade is additive and safe to repeat on an older database", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE cloud_schema_version(id integer,version integer); INSERT INTO cloud_schema_version VALUES(1,1); CREATE TABLE products(id text PRIMARY KEY,name text); INSERT INTO products VALUES('keep','保留商品');",
    );
    await upgradeEnglishNames(db as unknown as Database);
    await db.query(
      "UPDATE products SET english_name='Saved name' WHERE id='keep'",
    );
    await upgradeEnglishNames(db as unknown as Database);
    assert.deepEqual((await db.query("SELECT * FROM products")).rows, [
      { id: "keep", name: "保留商品", english_name: "Saved name" },
    ]);
  } finally {
    await db.close();
  }
});
