// Only the disposable shop initialized by scripts/http-check.mjs on port 3001.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3001";
let cookie = "";
async function call(route, body, expected = 200, key = randomUUID()) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body
        ? {
            "Content-Type": "application/json",
            Origin: base,
            "Idempotency-Key": key,
          }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return { value, response };
}
async function login() {
  const result = await call("/api/auth", {
    action: "login",
    password: "stage1-test-only",
  });
  cookie = result.response.headers.get("set-cookie").split(";")[0];
}
const action = async (body) => (await call("/api/actions", body)).value;
await login();
const date = "2026-11-08";
let data = (await call(`/api/workspace?date=${date}`)).value;
assert.equal(
  data.shop.name,
  "浏览器测试店（非营业数据）",
  "Refusing to modify a non-fixture shop",
);
assert.equal(
  (await call(`/api/imports?date=${date}`)).value.config.enabled,
  false,
  "AI must be disabled in this QA server",
);
const product = data.products.find((p) => p.name === "Timun");
const carrot = data.products.find((p) => p.name === "Carrot / 红萝卜");
const tofu = data.products.find((p) => p.name === "豆腐");
const restaurantId = (
  await action({
    action: "saveRestaurant",
    name: "送货单测试餐馆（非营业）",
    aliases: [],
    active: true,
  })
).id;
await action({
  action: "saveRestaurantPrice",
  restaurantId,
  productId: product.id,
  billingUnit: "kg",
  price: "5.50",
  expectedVersion: 0,
});
const orderId = (
  await action({
    action: "saveOrder",
    restaurantId,
    date,
    urgent: false,
    items: [
      { productId: product.id, quantity: "0.5", unit: "kg" },
      { productId: carrot.id, quantity: "2", unit: "箱" },
      { productId: tofu.id, quantity: "1", unit: "包" },
    ],
  })
).id;
async function current() {
  return (await call(`/api/workspace?date=${date}`)).value.orders.find(
    (o) => o.id === orderId,
  );
}
let order = await current();
assert.equal(order.items[0].price_snapshot, "5.50");
let preview = (await call(`/api/orders/${orderId}/document`)).value;
await call(
  "/api/actions",
  {
    action: "finalizeOrder",
    id: orderId,
    token: preview.token,
    finalChecked: true,
  },
  400,
);
let item = order.items[0];
await call(
  "/api/actions",
  {
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "560",
    unit: "g",
  },
  422,
);
await action({
  action: "saveActual",
  id: item.id,
  version: item.version,
  quantity: "560",
  unit: "g",
  acknowledgeDiscrepancy: true,
  expectedDiscrepancyKey: JSON.stringify(["0.5", "0.56", "10"]),
});
await action({
  action: "setPicking",
  id: item.id,
  version: item.task_version,
  picked: true,
});
order = await current();
item = order.items[1];
await action({
  action: "saveActual",
  id: item.id,
  version: item.version,
  quantity: "1",
  unit: "箱",
});
await action({
  action: "setPicking",
  id: item.id,
  version: item.task_version,
  picked: true,
});
item = order.items[2];
await action({
  action: "setUnavailable",
  id: item.id,
  version: item.version,
  taskVersion: item.task_version,
  unavailable: true,
});
preview = (await call(`/api/orders/${orderId}/document`)).value;
assert.equal(preview.snapshot.subtotal, "27.08");
assert.equal(preview.snapshot.rounding, "0.02");
assert.equal(preview.snapshot.total, "27.10");
const draftPdf = await fetch(
  `${base}/api/orders/${orderId}/document?pdf=draft`,
  { headers: { Cookie: cookie } },
);
assert.equal(draftPdf.status, 200);
await writeFile(
  "test-results/stage3-http-draft.pdf",
  Buffer.from(await draftPdf.arrayBuffer()),
);
const key = randomUUID(),
  finalize = {
    action: "finalizeOrder",
    id: orderId,
    token: preview.token,
    finalChecked: true,
  };
await call("/api/actions", finalize, 200, key);
await call("/api/actions", finalize, 200, key);
preview = (await call(`/api/orders/${orderId}/document`)).value;
assert.equal(preview.documents.length, 1);
const doc = preview.documents[0];
const pdf = await fetch(`${base}/api/documents/${doc.id}/pdf`, {
  headers: { Cookie: cookie },
});
assert.equal(pdf.status, 200);
assert.equal(pdf.headers.get("content-type"), "application/pdf");
const bytes = Buffer.from(await pdf.arrayBuffer());
assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
await writeFile("test-results/stage3-http-final.pdf", bytes);
assert.equal((await fetch(`${base}/api/documents/${doc.id}/pdf`)).status, 401);
await action({
  action: "saveRestaurantPrice",
  restaurantId,
  productId: product.id,
  billingUnit: "kg",
  price: "7.00",
  expectedVersion: (
    await call(`/api/workspace?date=${date}`)
  ).value.restaurantPrices.find(
    (p) => p.restaurant_id === restaurantId && p.product_id === product.id,
  ).version,
});
assert.equal(
  createHash("sha256")
    .update(
      Buffer.from(
        await (
          await fetch(`${base}/api/documents/${doc.id}/pdf`, {
            headers: { Cookie: cookie },
          })
        ).arrayBuffer(),
      ),
    )
    .digest("hex"),
  createHash("sha256").update(bytes).digest("hex"),
);
let plan = (await call(`/api/history?id=${orderId}&copyTo=2026-11-09`)).value;
assert.equal(plan.items[0].price, "7.00");
const copied = (
  await action({
    action: "copyOrder",
    id: orderId,
    version: plan.sourceVersion,
    date: "2026-11-09",
    mode: "new",
    token: plan.token,
  })
).id;
const copy = (await call("/api/workspace?date=2026-11-09")).value.orders.find(
  (o) => o.id === copied,
);
assert.equal(copy.items[0].actual_quantity, null);
assert.equal(copy.items[0].picking_state, "pending");
assert.equal(copy.items[0].price_snapshot, "7.00");
await action({
  action: "setOrderDeleted",
  id: copied,
  version: copy.version,
  deleted: true,
});
assert(
  !(await call("/api/workspace?date=2026-11-09")).value.orders.some(
    (o) => o.id === copied,
  ),
);
assert(
  (
    await call("/api/history?deleted=true&from=2026-11-09&to=2026-11-09")
  ).value.orders.some((o) => o.id === copied),
);
const backup = (await call("/api/backup")).value;
assert.equal(backup.schemaVersion, 3);
assert(backup.tables.documents.length > 0);
assert(!JSON.stringify(backup).includes("password_hash"));
const temporary = (
  await action({
    action: "saveRestaurant",
    name: "恢复时应移除的测试餐馆",
    aliases: [],
    active: true,
  })
).id;
const restore = (await call("/api/restore", { action: "preview", backup }))
  .value;
assert(restore.documents > 0);
const restored = (
  await call("/api/restore", {
    action: "confirm",
    token: restore.token,
    shopName: restore.shopName,
    confirm: true,
  })
).value;
assert(restored.restored);
await call(`/api/workspace?date=${date}`, undefined, 401);
await login();
data = (await call(`/api/workspace?date=${date}`)).value;
assert(!data.restaurants.some((r) => r.id === temporary));
assert.equal(
  data.orders.find((o) => o.id === orderId).items[0].price_snapshot,
  "5.50",
);
assert.equal(
  data.orders.find((o) => o.id === orderId).finalized_document_id,
  doc.id,
);
const after = Buffer.from(
  await (
    await fetch(`${base}/api/documents/${doc.id}/pdf`, {
      headers: { Cookie: cookie },
    })
  ).arrayBuffer(),
);
assert.deepEqual(after, bytes);
await writeFile(
  "test-results/stage3-http-qa.json",
  JSON.stringify(
    {
      date,
      orderId,
      restaurantId,
      documentId: doc.id,
      number: doc.number,
      copiedOrderId: copied,
      safetyFile: restored.safetyFile,
    },
    null,
    2,
  ),
);
console.log(
  "Stage 3 HTTP checks passed: restaurant prices, strict warning acknowledgement, short counts, unavailable items, rounding, locked finalization, immutable PDF download, copy, deletion, validated restore and session invalidation. No live Gemini request.",
);
