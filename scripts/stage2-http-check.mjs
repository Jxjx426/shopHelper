// Extends scripts/http-check.mjs, strictly on the disposable port 3001 server.
// No Gemini calls: the test server must set GEMINI_FREE_TIER_CONFIRMED=false.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3001";
let cookie = "";
async function call(
  route,
  body,
  expected = 200,
  key = randomUUID(),
  authenticated = true,
) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
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
const login = await call("/api/auth", {
  action: "login",
  password: "stage1-test-only",
});
cookie = login.response.headers.get("set-cookie").split(";")[0];
let data = (await call("/api/workspace?date=2026-11-08")).value;
assert.equal(
  data.shop.name,
  "浏览器测试店（非营业数据）",
  "Refusing to change a non-fixture shop",
);
const config = (await call("/api/imports?date=2026-11-08")).value.config;
assert.equal(
  config.enabled,
  false,
  "AI must be disabled in HTTP QA; never use a real key here",
);
async function action(body) {
  return (await call("/api/actions", body)).value;
}
const restaurant = (
  await action({
    action: "saveRestaurant",
    name: `导入审核餐馆-${randomUUID().slice(0, 6)}（非营业）`,
    aliases: [],
    active: true,
  })
).id;
const selected = (
  await call("/api/workspace?date=2026-11-08")
).value.restaurants.find((r) => r.id === restaurant);
const vegetable = (
  await action({
    action: "saveProduct",
    name: `青龙菜-${randomUUID().slice(0, 6)}`,
    aliases: [],
    zoneId: data.zones[0].id,
    sortOrder: 10,
    active: true,
    units: [{ orderUnit: "包", billingUnit: "包", price: "2.00" }],
  })
).id;
const text = `${selected.name}\nTimun 2kg\n青龙菜1.\nCarrot 1箱`;
const createBody = {
  restaurantId: restaurant,
  date: "2026-11-08",
  kind: "text",
  text,
};
const key = randomUUID();
const created = (await call("/api/imports", createBody, 200, key)).value;
assert.equal(
  (await call("/api/imports", createBody, 200, key)).value.id,
  created.id,
);
assert.equal((await call("/api/imports", createBody)).value.id, created.id);
let draft = (await call(`/api/imports/${created.id}`)).value;
assert.equal(draft.lines.length, 4);
assert(draft.lines.every((l) => !l.reviewed && l.unit === ""));
await call(
  `/api/imports/${draft.id}`,
  {
    action: "extract",
    version: draft.version,
    privacyVersion: "wrong",
    redacted: true,
    replaceExisting: false,
  },
  400,
);
await call(
  `/api/imports/${draft.id}`,
  {
    action: "extract",
    version: draft.version,
    privacyVersion: "gemini-unpaid-2026-11-v1",
    redacted: true,
    replaceExisting: false,
  },
  503,
);
assert.equal((await call(`/api/imports/${draft.id}`)).value.attempts, 0);
await call(
  `/api/imports/${draft.id}`,
  { action: "preview", version: draft.version, mode: "new" },
  400,
);
const product = data.products.find((p) => p.name === "Timun").id,
  carrot = data.products.find((p) => p.name === "Carrot / 红萝卜").id;
const edits = draft.lines.map((line, i) => ({
  id: line.id,
  productText: i === 1 ? "Timun" : i === 2 ? "青龙菜" : i === 3 ? "Carrot" : "",
  productId: i === 1 ? product : i === 2 ? vegetable : i === 3 ? carrot : "",
  quantity: i === 1 ? "2" : i ? "1" : "",
  unit: i === 1 ? "kg" : i === 2 ? "包" : i === 3 ? "箱" : "",
  disposition: i ? "item" : "ignored",
  ignoreReason: i ? "" : "餐馆名称或标题",
  reviewed: true,
  saveAlias: i === 2,
}));
await call(`/api/imports/${draft.id}`, {
  action: "save",
  version: draft.version,
  restaurantId: restaurant,
  lines: edits,
  sourceChecked: true,
  restaurantAcknowledged: false,
});
draft = (await call(`/api/imports/${draft.id}`)).value;
const preview = (
  await call(`/api/imports/${draft.id}`, {
    action: "preview",
    version: draft.version,
    mode: "new",
  })
).value;
assert.equal(preview.lines.length, 3);
const confirmKey = randomUUID(),
  confirmBody = {
    action: "confirm",
    version: draft.version,
    token: preview.token,
    identicalAcknowledged: false,
  };
const confirmed = (
  await call(`/api/imports/${draft.id}`, confirmBody, 200, confirmKey)
).value;
assert.equal(
  (await call(`/api/imports/${draft.id}`, confirmBody, 200, confirmKey)).value
    .id,
  confirmed.id,
);
data = (await call("/api/workspace?date=2026-11-08")).value;
let order = data.orders.find((o) => o.id === confirmed.id);
assert(
  data.products.find((p) => p.id === vegetable).aliases.includes("青龙菜"),
);
assert.equal(order.items.length, 3);
assert.equal(
  order.items.find((i) => i.product_id === product).price_snapshot,
  "6.00",
);
const duplicate = (await call("/api/imports", createBody)).value;
let dd = (await call(`/api/imports/${duplicate.id}`)).value;
await call(`/api/imports/${dd.id}`, {
  action: "save",
  version: dd.version,
  restaurantId: restaurant,
  lines: edits,
  sourceChecked: true,
  restaurantAcknowledged: false,
});
dd = (await call(`/api/imports/${dd.id}`)).value;
const appended = (
  await call(`/api/imports/${dd.id}`, {
    action: "preview",
    version: dd.version,
    mode: "append",
  })
).value;
assert.equal(appended.identicalSource, true);
assert.equal(appended.lines.find((l) => l.productId === product).quantity, "4");
await call(
  `/api/imports/${dd.id}`,
  {
    action: "confirm",
    version: dd.version,
    token: appended.token,
    identicalAcknowledged: false,
  },
  400,
);
await call(`/api/imports/${dd.id}`, {
  action: "confirm",
  version: dd.version,
  token: appended.token,
  identicalAcknowledged: true,
});
data = (await call("/api/workspace?date=2026-11-08")).value;
order = data.orders.find((o) => o.id === confirmed.id);
assert.equal(order.items.length, 3);
assert.equal(
  order.items.find((i) => i.product_id === product).ordered_quantity,
  "4.000",
);
const imageRestaurant = (
  await action({
    action: "saveRestaurant",
    name: `截图审核-${randomUUID().slice(0, 6)}（非营业）`,
    aliases: [],
    active: true,
  })
).id;
const image = await sharp(
  Buffer.from(
    '<svg width="700" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="700" height="500" fill="white"/><text x="40" y="70" font-family="Arial" font-size="30" fill="black">TEST ORDER (not business data)</text><text x="40" y="150" font-family="Arial" font-size="32">Timun 2kg</text><text x="40" y="220" font-family="Arial" font-size="32">Carrot 1box</text><text x="40" y="310" font-family="Arial" font-size="26">PRIVATE CONTACT - COVER BEFORE SENDING</text></svg>',
  ),
)
  .png()
  .toBuffer();
await mkdir("test-results", { recursive: true });
await writeFile("test-results/stage2-sample-order.png", image);
const payload = { mime: "image/png", base64: image.toString("base64") };
const screenshot = (
  await call("/api/imports", {
    restaurantId: imageRestaurant,
    date: "2026-11-08",
    kind: "image",
    original: payload,
    prepared: payload,
  })
).value;
await call(
  `/api/imports/${screenshot.id}`,
  {
    action: "extract",
    version: 1,
    privacyVersion: "gemini-unpaid-2026-11-v1",
    redacted: true,
    replaceExisting: false,
  },
  503,
);
const unauthorized = await fetch(`${base}/api/imports/${screenshot.id}/image`);
assert.equal(unauthorized.status, 401);
const original = await fetch(`${base}/api/imports/${screenshot.id}/image`, {
  headers: { Cookie: cookie },
});
assert.equal(original.status, 200);
assert.equal(original.headers.get("content-type"), "image/png");
await call(`/api/imports/${screenshot.id}`, {
  action: "supplement",
  version: 1,
  text: "Timun 2kg",
});
const sd = (await call(`/api/imports/${screenshot.id}`)).value;
const row = sd.lines[0];
await call(`/api/imports/${screenshot.id}`, {
  action: "save",
  version: sd.version,
  restaurantId: imageRestaurant,
  lines: [
    {
      id: row.id,
      productText: "Timun",
      productId: product,
      quantity: "2",
      unit: "kg",
      disposition: "item",
      ignoreReason: "",
      reviewed: true,
      saveAlias: false,
    },
  ],
  sourceChecked: true,
  restaurantAcknowledged: false,
});
const ready = (await call(`/api/imports/${screenshot.id}`)).value;
const sp = (
  await call(`/api/imports/${screenshot.id}`, {
    action: "preview",
    version: ready.version,
    mode: "new",
  })
).value;
assert.equal(sp.lines[0].price, "6.00");
// Leave this screenshot draft unconfirmed for interactive review QA.
const backup = (await call("/api/backup")).value;
assert.equal(backup.schemaVersion, 2);
assert(backup.tables.import_images.length > 0);
assert(!JSON.stringify(backup).includes("GEMINI_API_KEY"));
await call("/api/imports?date=2026-11-08", undefined, 401, randomUUID(), false);
await writeFile(
  "test-results/stage2-qa.json",
  JSON.stringify(
    {
      screenshotDraftId: screenshot.id,
      restaurantId: imageRestaurant,
      sourceRestaurantId: restaurant,
    },
    null,
    2,
  ),
);
console.log(
  "Stage 2 HTTP checks passed: drafts, image privacy, schema validation, missing-key fallback, review, aliases/products, duplicate preview, idempotent confirmation, append, price snapshots and backups. No external AI request was made.",
);
