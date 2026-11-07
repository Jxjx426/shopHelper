// Disposable local integration environment only. Never target an existing shop.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.SHOP_TEST_URL ?? "http://127.0.0.1:3001";
if (!/^http:\/\/(127\.0\.0\.1|localhost):3001$/.test(base))
  throw new Error(
    "HTTP checks may only target the disposable port 3001 environment.",
  );
const date = "2026-11-07";
let cookie = "";
async function call(
  route,
  body,
  expected = 200,
  key = randomUUID(),
  origin = base,
) {
  const response = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body
        ? {
            "Content-Type": "application/json",
            Origin: origin,
            "Idempotency-Key": key,
          }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return { data, response };
}
const initial = await call("/api/auth");
if (initial.data.configured)
  throw new Error(
    "Refusing to change an already-configured database. Use a fresh SHOP_DATA_DIR for the test server.",
  );
await call(`/api/workspace?date=${date}`, undefined, 401);
const setup = await call("/api/auth", {
  action: "setup",
  shopName: "浏览器测试店（非营业数据）",
  password: "stage1-test-only",
});
cookie = setup.response.headers.get("set-cookie").split(";")[0];
assert(setup.response.headers.get("set-cookie").includes("HttpOnly"));
assert(setup.response.headers.get("set-cookie").includes("SameSite=strict"));
await call(
  "/api/auth",
  { action: "setup", shopName: "不应覆盖", password: "stage1-test-only" },
  409,
);
await call(
  "/api/actions",
  { action: "saveShop", name: "不应保存" },
  403,
  randomUUID(),
  "https://example.invalid",
);
async function action(body, key) {
  return (await call("/api/actions", body, 200, key)).data;
}
const zone = (
  await action({ action: "saveZone", name: "萝卜 / Timun 区", active: true })
).id;
const tofu = (
  await action({ action: "saveZone", name: "豆腐区", active: true })
).id;
const restaurants = [];
for (const name of ["大福屋", "乱乱炒"])
  restaurants.push(
    (
      await action({
        action: "saveRestaurant",
        name,
        aliases: [],
        active: true,
      })
    ).id,
  );
const products = [];
for (const p of [
  {
    name: "Timun",
    zoneId: zone,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "6.00" }],
  },
  {
    name: "日本 Timun",
    zoneId: zone,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "8.00" }],
  },
  {
    name: "Carrot / 红萝卜",
    zoneId: zone,
    units: [
      { orderUnit: "g", billingUnit: "kg", price: "10.00" },
      { orderUnit: "箱", billingUnit: "箱", price: "24.00" },
    ],
  },
  {
    name: "豆腐",
    zoneId: tofu,
    units: [{ orderUnit: "包", billingUnit: "包", price: "3.50" }],
  },
])
  products.push(
    (
      await action({
        action: "saveProduct",
        ...p,
        aliases: [],
        sortOrder: products.length + 1,
        active: true,
      })
    ).id,
  );
const order = {
  action: "saveOrder",
  restaurantId: restaurants[0],
  date,
  urgent: true,
  items: [
    { productId: products[0], quantity: "2", unit: "kg" },
    { productId: products[1], quantity: "1", unit: "kg" },
    { productId: products[2], quantity: "300", unit: "g" },
    { productId: products[2], quantity: "1", unit: "箱" },
    { productId: products[3], quantity: "3", unit: "包" },
  ],
};
const key = randomUUID();
const first = await action(order, key);
assert.equal((await action(order, key)).id, first.id);
await call("/api/actions", order, 409);
await action({
  action: "saveOrder",
  restaurantId: restaurants[1],
  date,
  urgent: false,
  items: [
    { productId: products[0], quantity: "1.3", unit: "kg" },
    { productId: products[3], quantity: "4", unit: "包" },
  ],
});
let data = (await call(`/api/workspace?date=${date}`)).data;
assert.equal(data.orders.length, 2);
assert.equal(data.products.length, 4);
let item = data.orders.find((o) => o.id === first.id).items[0];
await call(
  "/api/actions",
  {
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "-1",
    unit: "kg",
  },
  400,
);
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
  quantity: "2.08",
  unit: "kg",
});
data = (await call(`/api/workspace?date=${date}`)).data;
item = data.orders.find((o) => o.id === first.id).items[0];
assert.equal(item.amount, "12.48");
assert.equal(item.picking_state, "picked");
await call(
  "/api/actions",
  { action: "saveActual", id: item.id, version: 1, quantity: "3", unit: "kg" },
  409,
);
assert.equal(
  (await call("/api/workspace?date=2026-11-08")).data.orders.length,
  0,
);
const backup = (await call("/api/backup")).data;
assert.equal(backup.tables.orders.length, 2);
assert(!JSON.stringify(backup).includes("password_hash"));
await call("/api/auth", { action: "logout" });
await call(`/api/workspace?date=${date}`, undefined, 401);
await call(
  "/api/auth",
  { action: "login", password: "incorrect-fixture" },
  401,
);
const login = await call("/api/auth", {
  action: "login",
  password: "stage1-test-only",
});
assert(login.response.headers.get("set-cookie"));
console.log(
  "HTTP checks passed: setup/login/logout, authentication, CSRF, catalog, dates, duplicates, picking, weighing, snapshots, conflicts, backup.",
);
console.log(
  "Disposable browser QA data is ready at http://127.0.0.1:3001. The main database is untouched.",
);
