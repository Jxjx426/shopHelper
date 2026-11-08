import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../src/lib/db";
import { exportBackup, runAction, workspace } from "../src/lib/service";
import { hashPassword, verifyPassword } from "../src/lib/auth";
const actor = randomUUID();
let zoneId: string;
const day = "2026-11-07";
const nextDay = "2026-11-08";
const action = (body: unknown, key = randomUUID()) =>
  runAction(actor, key, body);
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `database-${randomUUID()}`,
  );
  await mkdir(process.env.SHOP_DATA_DIR, { recursive: true });
  const db = await getDb();
  await db.query(
    "INSERT INTO users(id,name,password_hash) VALUES($1,'测试店主',$2)",
    [actor, hashPassword("test-only-password")],
  );
  zoneId = (
    await action({ action: "saveZone", name: "测试区域", active: true })
  ).id;
});
after(async () => {
  if (globalThis.shopDatabase) {
    await (await globalThis.shopDatabase).close();
    globalThis.shopDatabase = undefined;
  }
});
async function fixture(
  options: {
    unit?: string;
    billingUnit?: string;
    price?: string | null;
    quantity?: string;
    date?: string;
  } = {},
) {
  const suffix = randomUUID().slice(0, 8);
  const restaurantId = (
    await action({
      action: "saveRestaurant",
      name: `测试餐馆-${suffix}`,
      aliases: [],
      active: true,
    })
  ).id;
  const productId = (
    await action({
      action: "saveProduct",
      name: `测试商品-${suffix}`,
      aliases: ["测试别名"],
      zoneId,
      sortOrder: 1,
      active: true,
      units: [
        {
          orderUnit: options.unit ?? "kg",
          billingUnit: options.billingUnit ?? "kg",
          price: options.price === undefined ? "6.00" : options.price,
        },
      ],
    })
  ).id;
  const payload = {
    action: "saveOrder",
    restaurantId,
    date: options.date ?? day,
    urgent: false,
    items: [
      {
        productId,
        quantity: options.quantity ?? "2",
        unit: options.unit ?? "kg",
      },
    ],
  };
  const result = await action(payload);
  const data = await workspace(options.date ?? day);
  return {
    restaurantId,
    productId,
    order: data.orders.find((o) => o.id === result.id)!,
    payload,
  };
}
test("password hashes are salted and verify without storing plaintext", () => {
  const one = hashPassword("fixture-secret"),
    two = hashPassword("fixture-secret");
  assert.notEqual(one, two);
  assert.equal(one.includes("fixture-secret"), false);
  assert.equal(verifyPassword("fixture-secret", one), true);
  assert.equal(verifyPassword("wrong-secret", one), false);
});
test("orders and picking tasks are strictly isolated by delivery date", async () => {
  const first = await fixture(),
    second = await fixture({ date: nextDay });
  const today = await workspace(day),
    tomorrow = await workspace(nextDay);
  assert(today.orders.some((o) => o.id === first.order.id));
  assert(!today.orders.some((o) => o.id === second.order.id));
  assert(tomorrow.orders.some((o) => o.id === second.order.id));
  assert.equal((await workspace("2027-01-01")).orders.length, 0);
});
test("same restaurant/date duplicates are blocked and idempotent retries create one order", async () => {
  const f = await fixture();
  await assert.rejects(action(f.payload), /已有订单/);
  const key = randomUUID();
  const payload = { ...f.payload, date: "2026-11-09" };
  const one = await action(payload, key),
    two = await action(payload, key);
  assert.equal(one.id, two.id);
  assert.equal(
    (await workspace("2026-11-09")).orders.filter(
      (o) => o.restaurant_id === f.restaurantId,
    ).length,
    1,
  );
  await assert.rejects(
    action({ ...payload, urgent: true }, key),
    /操作编号已使用/,
  );
});
test("picking is per restaurant item and never fills an actual quantity", async () => {
  const f = await fixture();
  const restaurantId = (
    await action({
      action: "saveRestaurant",
      name: `另一餐馆-${randomUUID()}`,
      aliases: [],
      active: true,
    })
  ).id;
  const otherId = (await action({ ...f.payload, restaurantId })).id;
  const item = f.order.items[0];
  await action({
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  const data = await workspace(day);
  const updated = data.orders.find((o) => o.id === f.order.id)!;
  assert.equal(updated.items[0].picking_state, "picked");
  assert.equal(updated.items[0].actual_quantity, null);
  assert.equal(updated.items[0].actual_confirmed, false);
  assert(updated.picking_started_at);
  assert.equal(
    data.orders.find((o) => o.id === otherId)!.items[0].picking_state,
    "pending",
  );
});
test("actual weight saves a decimal-safe amount without completing picking", async () => {
  const f = await fixture();
  const item = f.order.items[0];
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2.08",
    unit: "kg",
  });
  const updated = (await workspace(day)).orders.find(
    (o) => o.id === f.order.id,
  )!;
  assert.equal(updated.items[0].amount, "12.48");
  assert.equal(updated.items[0].actual_confirmed, true);
  assert.equal(updated.items[0].picking_state, "pending");
  assert.equal(updated.picking_started_at, null);
});
test("grams and count-ordered weight-billed items use the explicit billing rule", async () => {
  for (const options of [
    { unit: "g", quantity: "300" },
    { unit: "粒", quantity: "2" },
  ]) {
    const f = await fixture({ ...options, billingUnit: "kg", price: "10.00" });
    const item = f.order.items[0];
    await action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "300",
      unit: "g",
    });
    const updated = (await workspace(day)).orders.find(
      (o) => o.id === f.order.id,
    )!.items[0];
    assert.equal(updated.amount, "3.00");
    assert.equal(updated.ordered_unit, options.unit);
  }
});
test("fixed-unit counts are proposals until explicitly confirmed and permit short supply", async () => {
  const f = await fixture({
    unit: "箱",
    billingUnit: "箱",
    price: "12.00",
    quantity: "3",
  });
  const item = f.order.items[0];
  assert.equal(item.actual_quantity, null);
  assert.equal(item.amount, null);
  assert.equal(item.actual_confirmed, false);
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2",
    unit: "箱",
  });
  const updated = (await workspace(day)).orders.find(
    (o) => o.id === f.order.id,
  )!.items[0];
  assert.equal(updated.amount, "24.00");
  assert.equal(updated.picking_state, "pending");
  await assert.rejects(
    action({
      action: "saveActual",
      id: item.id,
      version: updated.version,
      quantity: "1.5",
      unit: "箱",
    }),
    /整数/,
  );
});
test("catalog price changes preserve snapshots and an explicit price refresh shows expected price", async () => {
  const f = await fixture();
  const data = await workspace(day);
  const p = data.products.find((p) => p.id === f.productId)!;
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: p.sort_order,
    active: p.active,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "8.00" }],
  });
  let item = (await workspace(day)).orders.find((o) => o.id === f.order.id)!
    .items[0];
  assert.equal(item.price_snapshot, "6.00");
  await assert.rejects(
    action({
      action: "refreshPrice",
      id: item.id,
      version: item.version,
      expectedPrice: "7.00",
    }),
    /现价刚刚/,
  );
  await action({
    action: "refreshPrice",
    id: item.id,
    version: item.version,
    expectedPrice: "8.00",
  });
  item = (await workspace(day)).orders.find((o) => o.id === f.order.id)!
    .items[0];
  assert.equal(item.price_snapshot, "8.00");
  const nextId = (await action({ ...f.payload, date: nextDay })).id;
  assert.equal(
    (await workspace(nextDay)).orders.find((o) => o.id === nextId)!.items[0]
      .price_snapshot,
    "8.00",
  );
});
test("missing price is null rather than zero, including after saving actual weight", async () => {
  const f = await fixture({ price: null });
  const item = f.order.items[0];
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2",
    unit: "kg",
  });
  const updated = (await workspace(day)).orders.find(
    (o) => o.id === f.order.id,
  )!.items[0];
  assert.equal(updated.price_snapshot, null);
  assert.equal(updated.amount, null);
});
test("unavailable is explicitly resolved at zero and undo returns to pending", async () => {
  const f = await fixture();
  let item = f.order.items[0];
  await action({
    action: "setUnavailable",
    id: item.id,
    version: item.version,
    taskVersion: item.task_version,
    unavailable: true,
  });
  item = (await workspace(day)).orders.find((o) => o.id === f.order.id)!
    .items[0];
  assert.equal(item.unavailable, true);
  assert.equal(item.amount, "0.00");
  assert.equal(item.picking_state, "unavailable");
  await assert.rejects(
    action({
      action: "setPicking",
      id: item.id,
      version: item.task_version,
      picked: true,
    }),
    /缺货/,
  );
  await action({
    action: "setUnavailable",
    id: item.id,
    version: item.version,
    taskVersion: item.task_version,
    unavailable: false,
  });
  item = (await workspace(day)).orders.find((o) => o.id === f.order.id)!
    .items[0];
  assert.equal(item.unavailable, false);
  assert.equal(item.picking_state, "pending");
  assert.equal(item.actual_quantity, null);
  assert.equal(item.amount, null);
});
test("first picking action locks ordered items permanently even after undo", async () => {
  const f = await fixture();
  let item = f.order.items[0];
  await action({
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  let order = (await workspace(day)).orders.find((o) => o.id === f.order.id)!;
  item = order.items[0];
  await action({
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: false,
  });
  order = (await workspace(day)).orders.find((o) => o.id === f.order.id)!;
  await assert.rejects(
    action({ ...f.payload, id: order.id, version: order.version }),
    /已开始配货/,
  );
});
test("pre-picking edits replace demand atomically and reject duplicate product/unit rows", async () => {
  const f = await fixture();
  await action({
    ...f.payload,
    id: f.order.id,
    version: f.order.version,
    items: [{ productId: f.productId, quantity: "10", unit: "kg" }],
  });
  const order = (await workspace(day)).orders.find((o) => o.id === f.order.id)!;
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].ordered_quantity, "10.000");
  await assert.rejects(
    action({
      ...f.payload,
      id: order.id,
      version: order.version,
      items: [...f.payload.items, ...f.payload.items],
    }),
    /重复/,
  );
  assert.equal(
    (await workspace(day)).orders.find((o) => o.id === f.order.id)!.items[0]
      .ordered_quantity,
    "10.000",
  );
});
test("invalid inputs and stale versions never overwrite saved quantities", async () => {
  const f = await fixture();
  const item = f.order.items[0];
  for (const value of ["", "0", "-1", "2.1234"]) {
    await assert.rejects(
      action({
        action: "saveActual",
        id: item.id,
        version: item.version,
        quantity: value,
        unit: "kg",
      }),
    );
  }
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2.08",
    unit: "kg",
  });
  await assert.rejects(
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "3",
      unit: "kg",
    }),
    /已被修改/,
  );
  assert.equal(
    (await workspace(day)).orders.find((o) => o.id === f.order.id)!.items[0]
      .amount,
    "12.48",
  );
});
test("two simultaneous edits to one item yield one success and one conflict", async () => {
  const f = await fixture();
  const item = f.order.items[0];
  const results = await Promise.allSettled([
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "2",
      unit: "kg",
    }),
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "3",
      unit: "kg",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});
test("zones cannot deactivate active products; catalog deactivation preserves historical items", async () => {
  const f = await fixture();
  let data = await workspace(day);
  const zone = data.zones.find((z) => z.id === zoneId)!;
  await assert.rejects(
    action({
      action: "saveZone",
      id: zoneId,
      version: zone.version,
      name: zone.name,
      active: false,
    }),
    /启用中的商品/,
  );
  const p = data.products.find((p) => p.id === f.productId)!;
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: p.sort_order,
    active: false,
    units: p.units,
  });
  data = await workspace(day);
  assert.equal(
    data.orders.find((o) => o.id === f.order.id)!.items[0].product_name,
    p.name,
  );
  await assert.rejects(action({ ...f.payload, date: nextDay }), /已停用/);
});
test("backup includes all dates and actor references but excludes credentials", async () => {
  const backup = await exportBackup();
  const serialized = JSON.stringify(backup);
  assert.equal(backup.schemaVersion, 3);
  assert(backup.tables.orders.length > 0);
  assert(backup.actors.length > 0);
  assert(!serialized.includes("password_hash"));
  assert(!serialized.includes("token_hash"));
  assert(!serialized.includes("GEMINI_API_KEY"));
  assert(
    backup.tables.orders.some((o: any) =>
      String(o.delivery_date).includes(nextDay),
    ),
  );
});
test("saved PostgreSQL records survive closing and reopening the database", async () => {
  const f = await fixture();
  const db = await getDb();
  await db.close();
  globalThis.shopDatabase = undefined;
  const data = await workspace(day);
  assert.equal(
    data.orders.find((o) => o.id === f.order.id)!.items[0].price_snapshot,
    "6.00",
  );
});
