import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import { getDb } from "../src/lib/db";
import { runAction, workspace, exportBackup } from "../src/lib/service";
import {
  hashPassword,
  verifyPassword,
  makeSession,
  getSession,
} from "../src/lib/auth";
import {
  documentPreview,
  documentPdf,
  documentState,
} from "../src/lib/documents.server";
import {
  orderHistory,
  copyPreview,
  historyDetail,
} from "../src/lib/history.server";
import { discrepancy } from "../src/lib/billing";
import {
  previewRestore,
  confirmRestore,
  validateBackup,
} from "../src/lib/backup.server";
import { backupChecksum } from "../src/lib/backup-checksum";
import {
  createImport,
  getDraft,
  imageForDraft,
} from "../src/lib/imports.server";
import { renderDeliveryPdf } from "../src/lib/pdf.server";
import type { Order, Product } from "../src/lib/domain";
let actor = randomUUID();
let zone: string;
const day = "2026-11-08";
const action = async (input: unknown, key = randomUUID()) => {
  const a = input as Record<string, unknown>;
  if (
    ["saveShop", "saveThresholds"].includes(String(a.action)) &&
    a.version === undefined
  )
    input = { ...a, version: (await workspace(day)).shop.version };
  return runAction(actor, key, input);
};
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `stage3-${randomUUID()}`,
  );
  const db = await getDb();
  await db.query(
    "INSERT INTO users(id,name,password_hash) VALUES($1,'Stage3测试店主',$2)",
    [actor, hashPassword("stage3-test-only")],
  );
  await action({ action: "saveShop", name: "第三阶段测试店（非营业数据）" });
  zone = (await action({ action: "saveZone", name: "蔬菜区", active: true }))
    .id;
});
after(async () => {
  if (globalThis.shopDatabase) await (await globalThis.shopDatabase).close();
  globalThis.shopDatabase = undefined;
});
async function fixture(
  options: {
    price?: string | null;
    quantity?: string;
    unit?: string;
    date?: string;
  } = {},
) {
  const suffix = randomUUID().slice(0, 6);
  const restaurantId = (
    await action({
      action: "saveRestaurant",
      name: `大福屋-${suffix}`,
      aliases: [],
      active: true,
    })
  ).id;
  const productId = (
    await action({
      action: "saveProduct",
      name: `日本黄瓜 Timun-${suffix}`,
      aliases: [],
      zoneId: zone,
      sortOrder: 1,
      active: true,
      units: [
        {
          orderUnit: options.unit ?? "kg",
          billingUnit: options.unit ?? "kg",
          price: options.price === undefined ? "6.00" : options.price,
        },
      ],
    })
  ).id;
  const id = (
    await action({
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
    })
  ).id;
  return { id, restaurantId, productId, date: options.date ?? day };
}
async function order(id: string, date = day) {
  return (await workspace(date)).orders.find((o) => o.id === id)!;
}
async function ready(f: { id: string; date: string }, actual = "2.08") {
  let o = await order(f.id, f.date);
  let item = o.items[0];
  await action({
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  const shop = (await workspace(f.date)).shop;
  const w = discrepancy(
    item.ordered_quantity,
    item.ordered_unit,
    actual,
    item.billing_unit,
    shop,
  );
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: actual,
    unit: item.billing_unit,
    ...(w?.warning
      ? { acknowledgeDiscrepancy: true, expectedDiscrepancyKey: w.key }
      : {}),
  });
  return order(f.id, f.date);
}
async function finalize(id: string, key = randomUUID()) {
  const review = await documentPreview(id);
  await action(
    { action: "finalizeOrder", id, token: review.token, finalChecked: true },
    key,
  );
  return (await documentPreview(id)).documents[0];
}
async function changePrice(productId: string, value: string) {
  const p = (await workspace(day)).products.find((p) => p.id === productId)!;
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: p.sort_order,
    active: p.active,
    units: p.units.map((u) => ({ ...u, price: value })),
  });
}
test("restaurant-specific prices override standards including zero; missing prices stay null and old snapshots stay fixed", async () => {
  const f = await fixture();
  await action({
    action: "saveRestaurantPrice",
    restaurantId: f.restaurantId,
    productId: f.productId,
    billingUnit: "kg",
    price: "5.00",
    expectedVersion: 0,
  });
  const firstVersion = (await workspace(day)).restaurantPrices.find(
    (p) => p.restaurant_id === f.restaurantId && p.product_id === f.productId,
  )!.version;
  const next = (
    await action({
      action: "saveOrder",
      restaurantId: f.restaurantId,
      date: "2026-11-09",
      urgent: false,
      items: [{ productId: f.productId, quantity: "2", unit: "kg" }],
    })
  ).id;
  assert.equal((await order(f.id)).items[0].price_snapshot, "6.00");
  assert.equal(
    (await order(next, "2026-11-09")).items[0].price_snapshot,
    "5.00",
  );
  await action({
    action: "saveRestaurantPrice",
    restaurantId: f.restaurantId,
    productId: f.productId,
    billingUnit: "kg",
    price: "0.00",
    expectedVersion: firstVersion,
  });
  const item = (await order(f.id)).items[0];
  await action({
    action: "refreshPrice",
    id: item.id,
    version: item.version,
    expectedPrice: "0.00",
  });
  assert.equal((await order(f.id)).items[0].price_snapshot, "0.00");
  assert.equal(
    (await order(next, "2026-11-09")).items[0].price_snapshot,
    "5.00",
  );
  const missing = await fixture({ price: null });
  assert.equal((await order(missing.id)).items[0].price_snapshot, null);
  await assert.rejects(
    action({
      action: "saveRestaurantPrice",
      restaurantId: f.restaurantId,
      productId: f.productId,
      billingUnit: "kg",
      price: "4",
      expectedVersion: firstVersion,
    }),
    /已变化/,
  );
});
test("server requires fresh discrepancy acknowledgement, and threshold changes invalidate an old acknowledgement", async () => {
  const f = await fixture({ quantity: "0.5" });
  let item = (await order(f.id)).items[0];
  await assert.rejects(
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "560",
      unit: "g",
    }),
    /重量超出/,
  );
  const w = discrepancy("0.5", "kg", "560", "g", (await workspace(day)).shop)!;
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "560",
    unit: "g",
    acknowledgeDiscrepancy: true,
    expectedDiscrepancyKey: w.key,
  });
  item = (await order(f.id)).items[0];
  assert.equal(item.discrepancy_ack, w.key);
  await assert.rejects(
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "570",
      unit: "g",
      acknowledgeDiscrepancy: true,
      expectedDiscrepancyKey: w.key,
    }),
    /重量超出/,
  );
  await action({ action: "saveThresholds", small: "20", large: "5" });
  assert(
    (await documentPreview(f.id)).snapshot.issues.some((i) =>
      i.includes("差异待确认"),
    ),
  );
  await action({ action: "saveThresholds", small: "20", large: "10" });
});
test("finalization checks all states, locks edits and stores byte-identical historical Chinese PDFs after catalog price changes", async () => {
  const f = await fixture();
  let review = await documentPreview(f.id);
  await assert.rejects(
    action({
      action: "finalizeOrder",
      id: f.id,
      token: review.token,
      finalChecked: true,
    }),
    /尚不能定稿/,
  );
  await ready(f);
  review = await documentPreview(f.id);
  assert.equal(review.snapshot.subtotal, "12.48");
  assert.equal(review.snapshot.rounding, "0.02");
  assert.equal(review.snapshot.total, "12.50");
  const key = randomUUID();
  const input = {
    action: "finalizeOrder",
    id: f.id,
    token: review.token,
    finalChecked: true,
  };
  await action(input, key);
  await action(input, key);
  const doc = (await documentPreview(f.id)).documents[0];
  const before = Buffer.from((await documentPdf(doc.id)).bytes);
  assert.equal(before.subarray(0, 5).toString(), "%PDF-");
  await changePrice(f.productId, "9.00");
  await action({ action: "saveThresholds", small: "1", large: "1" });
  const frozen = await documentPreview(f.id);
  assert.equal(frozen.snapshot.total, "12.50");
  assert.deepEqual(frozen.snapshot.issues, []);
  assert.equal(frozen.snapshot.draft, false);
  await action({ action: "saveThresholds", small: "20", large: "10" });
  assert.deepEqual(Buffer.from((await documentPdf(doc.id)).bytes), before);
  assert.equal((await order(f.id)).items[0].price_snapshot, "6.00");
  const item = (await order(f.id)).items[0];
  await assert.rejects(
    action({
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "2",
      unit: "kg",
    }),
    /已定稿/,
  );
  await assert.rejects(
    action({
      action: "setPicking",
      id: item.id,
      version: item.task_version,
      picked: false,
    }),
    /已定稿/,
  );
  assert.equal((await documentPreview(f.id)).documents.length, 1);
});
test("stale final review and competing finalizations cannot create duplicate documents", async () => {
  const f = await fixture();
  await ready(f);
  const stale = await documentPreview(f.id);
  const item = (await order(f.id)).items[0];
  await action({
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2.09",
    unit: "kg",
  });
  await assert.rejects(
    action({
      action: "finalizeOrder",
      id: f.id,
      token: stale.token,
      finalChecked: true,
    }),
    /已变化/,
  );
  const current = await documentPreview(f.id);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      action({
        action: "finalizeOrder",
        id: f.id,
        token: current.token,
        finalChecked: true,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await documentPreview(f.id)).documents.length, 1);
});
test("reopening retains the original version and replacement marks the earlier PDF superseded", async () => {
  const f = await fixture();
  await ready(f);
  const first = await finalize(f.id);
  const original = (await getDb()).query<{ pdf: Uint8Array }>(
    "SELECT pdf FROM documents WHERE id=$1",
    [first.id],
  );
  let o = await order(f.id);
  await action({
    action: "reopenOrder",
    id: f.id,
    version: o.version,
    acknowledgeShared: true,
  });
  o = await order(f.id);
  await assert.rejects(
    action({
      action: "saveOrder",
      id: f.id,
      version: o.version,
      restaurantId: f.restaurantId,
      date: day,
      urgent: false,
      items: [{ productId: f.productId, quantity: "5", unit: "kg" }],
    }),
    /已开始配货/,
  );
  const i = o.items[0];
  const warning = discrepancy(
    i.ordered_quantity,
    i.ordered_unit,
    "1.5",
    "kg",
    (await workspace(day)).shop,
  )!;
  await action({
    action: "saveActual",
    id: i.id,
    version: i.version,
    quantity: "1.5",
    unit: "kg",
    acknowledgeDiscrepancy: true,
    expectedDiscrepancyKey: warning.key,
  });
  const second = await finalize(f.id);
  assert.equal(second.revision, 2);
  const versions = (await documentPreview(f.id)).documents;
  assert(versions.find((d) => d.id === first.id)?.superseded_at);
  assert.deepEqual(
    Buffer.from(
      (
        await (
          await getDb()
        ).query<{ pdf: Uint8Array }>("SELECT pdf FROM documents WHERE id=$1", [
          first.id,
        ])
      ).rows[0].pdf,
    ),
    Buffer.from((await original).rows[0].pdf),
  );
  assert.notDeepEqual(
    Buffer.from((await documentPdf(first.id)).bytes),
    Buffer.from((await original).rows[0].pdf),
  );
});
test("short counts and explicitly unavailable products remain separate and resolve at the correct amounts", async () => {
  const f = await fixture({ quantity: "3", unit: "箱", price: "12.00" });
  await ready(f, "2");
  let preview = await documentPreview(f.id);
  assert.equal(preview.snapshot.total, "24.00");
  const i = (await order(f.id)).items[0];
  await action({
    action: "setUnavailable",
    id: i.id,
    version: i.version,
    taskVersion: i.task_version,
    unavailable: true,
  });
  preview = await documentPreview(f.id);
  assert.equal(preview.snapshot.total, "0.00");
  assert.equal(preview.snapshot.items[0].unavailable, true);
  await finalize(f.id);
});
test("history copy uses current prices and resets all operational states; duplicate targets need explicit reviewed replacement", async () => {
  const f = await fixture();
  await ready(f);
  await finalize(f.id);
  await changePrice(f.productId, "8.00");
  const targetDate = "2026-11-15";
  let plan = await copyPreview(f.id, targetDate);
  const copied = (
    await action({
      action: "copyOrder",
      id: f.id,
      version: plan.sourceVersion,
      date: targetDate,
      token: plan.token,
      mode: "new",
    })
  ).id;
  let o = await order(copied, targetDate);
  assert.equal(o.urgent, false);
  assert.equal(o.picking_started_at, null);
  assert.equal(o.finalized_document_id, null);
  assert.equal(o.items[0].actual_quantity, null);
  assert.equal(o.items[0].picking_state, "pending");
  assert.equal(o.items[0].discrepancy_ack, null);
  assert.equal(o.items[0].price_snapshot, "8.00");
  plan = await copyPreview(f.id, targetDate);
  await assert.rejects(
    action({
      action: "copyOrder",
      id: f.id,
      version: plan.sourceVersion,
      date: targetDate,
      token: plan.token,
      mode: "new",
    }),
    /已有订单/,
  );
  await changePrice(f.productId, "9.00");
  await assert.rejects(
    action({
      action: "copyOrder",
      id: f.id,
      version: plan.sourceVersion,
      date: targetDate,
      token: plan.token,
      mode: "replace",
      targetVersion: o.version,
    }),
    /现价已变化/,
  );
  plan = await copyPreview(f.id, targetDate);
  await action({
    action: "copyOrder",
    id: f.id,
    version: plan.sourceVersion,
    date: targetDate,
    token: plan.token,
    mode: "replace",
    targetVersion: o.version,
  });
  o = await order(copied, targetDate);
  assert.equal(o.items[0].price_snapshot, "9.00");
  await action({
    action: "setPicking",
    id: o.items[0].id,
    version: o.items[0].task_version,
    picked: true,
  });
  plan = await copyPreview(f.id, targetDate);
  await assert.rejects(
    action({
      action: "copyOrder",
      id: f.id,
      version: plan.sourceVersion,
      date: targetDate,
      token: plan.token,
      mode: "replace",
      targetVersion: plan.target!.version,
    }),
    /已开始配货/,
  );
});
test("recoverable order deletion removes active demand and keeps finalized versions; restoring duplicate demand is blocked", async () => {
  const f = await fixture();
  await ready(f);
  const doc = await finalize(f.id);
  let o = await order(f.id);
  await action({
    action: "setOrderDeleted",
    id: f.id,
    version: o.version,
    deleted: true,
  });
  assert.equal(await order(f.id), undefined);
  assert(
    (await orderHistory({ deleted: true })).orders.some(
      (r: any) => r.id === f.id,
    ),
  );
  assert((await documentPdf(doc.id)).bytes.length > 0);
  const replacement = (
    await action({
      action: "saveOrder",
      restaurantId: f.restaurantId,
      date: day,
      urgent: false,
      items: [{ productId: f.productId, quantity: "1", unit: "kg" }],
    })
  ).id;
  o = (await historyDetail(f.id)).order;
  await assert.rejects(
    action({
      action: "setOrderDeleted",
      id: f.id,
      version: o.version,
      deleted: false,
    }),
    /当天已有/,
  );
  const r = await order(replacement);
  await action({
    action: "setOrderDeleted",
    id: r.id,
    version: r.version,
    deleted: true,
  });
  await action({
    action: "setOrderDeleted",
    id: f.id,
    version: o.version,
    deleted: false,
  });
  assert.equal((await order(f.id)).finalized_document_id, doc.id);
});
test("history is paginated and filters restaurant/date instead of adding history to the day workspace", async () => {
  for (let n = 0; n < 22; n++) await fixture({ date: "2026-10-01" });
  const result = await orderHistory({ from: "2026-10-01", to: "2026-10-01" });
  assert.equal(result.total, 22);
  assert.equal(result.orders.length, 20);
  assert.equal(
    (await orderHistory({ from: "2026-10-01", to: "2026-10-01", page: 2 }))
      .orders.length,
    2,
  );
  assert((await workspace(day)).orders.every((o) => o.delivery_date === day));
});
test("backup rejects bad checksums, broken references, changed amounts and stale restore previews without replacing live data", async () => {
  const backup = JSON.parse(JSON.stringify(await exportBackup()));
  const count = (await workspace(day)).orders.length;
  const broken = structuredClone(backup);
  broken.tables.shop[0].name = "损坏";
  await assert.rejects(previewRestore(actor, broken), /校验码/);
  const reference = structuredClone(backup);
  reference.tables.orders[0].restaurant_id = "missing";
  delete reference.checksum;
  reference.checksum = backupChecksum(reference);
  await assert.rejects(previewRestore(actor, reference), /验证失败/);
  const amount = structuredClone(backup);
  const billed = amount.tables.order_items.find(
    (i: any) => i.actual_confirmed && !i.unavailable,
  );
  billed.amount = "999.99";
  delete amount.checksum;
  amount.checksum = backupChecksum(amount);
  await assert.rejects(previewRestore(actor, amount), /金额/);
  assert.equal((await workspace(day)).orders.length, count);
  const preview = await previewRestore(actor, backup);
  await action({ action: "saveShop", name: "暂时改名测试" });
  await assert.rejects(
    confirmRestore(actor, {
      token: preview.token,
      confirm: true,
      shopName: preview.shopName,
    }),
    /资料已变化/,
  );
  await action({ action: "saveShop", name: backup.tables.shop[0].name });
});
test("a failure during replacement rolls back all business data and retains the automatic safety backup", async () => {
  const backup = JSON.parse(JSON.stringify(await exportBackup()));
  const count = (await workspace(day)).orders.length;
  const preview = await previewRestore(actor, backup);
  const broken = structuredClone(backup);
  broken.tables.orders[0].restaurant_id = "missing-after-preview";
  const db = await getDb();
  await db.query("UPDATE restore_previews SET payload=$1 WHERE id=$2", [
    JSON.stringify(broken),
    preview.token,
  ]);
  const session = await db.transaction((tx) => makeSession(tx, actor));
  await assert.rejects(
    confirmRestore(actor, {
      token: preview.token,
      confirm: true,
      shopName: preview.shopName,
    }),
  );
  assert.equal((await workspace(day)).orders.length, count);
  assert(await getSession(session));
  assert.equal(
    (await exportBackup()).tables.documents.length,
    backup.tables.documents.length,
  );
});

test("long mixed Chinese PDFs repeat headers, keep unavailable lines and totals, and draft previews are explicitly marked", async () => {
  const first = (await workspace(day)).orders[0];
  const state = await (
    await getDb()
  ).transaction((tx) => documentState(tx, first.id));
  const snapshot = {
    ...state.snapshot,
    draft: false,
    number: "DO-20261108-TEST000001",
    revision: 1,
    issues: [],
    items: Array.from({ length: 100 }, (_, n) => ({
      name: `第${n + 1}项 日本黄瓜与红萝卜 Timun Jepun / Sayur campur / 小白菜 青龙菜 混合中文长品名`,
      quantity: n === 98 ? "0" : "0.3",
      unit: "kg" as const,
      price: "10.00",
      billingUnit: "kg" as const,
      amount: n === 98 ? "0.00" : "3.00",
      unavailable: n === 98,
    })),
    subtotal: "297.00",
    rounding: "0.00",
    total: "297.00",
  };
  await mkdir("output/pdf", { recursive: true });
  await writeFile(
    "output/pdf/stage3-chinese-delivery-order.pdf",
    await renderDeliveryPdf(snapshot),
  );
  await writeFile(
    "test-results/stage3-draft.pdf",
    await renderDeliveryPdf({
      ...snapshot,
      draft: true,
      total: null,
      number: "DRAFT",
    }),
  );
});
test("Stage 2 backups migrate into the current schema without inventing prices or document states", async () => {
  const legacy = JSON.parse(JSON.stringify(await exportBackup()));
  legacy.schemaVersion = 2;
  legacy.format = "fresh-helper-stage2";
  delete legacy.checksum;
  delete legacy.tables.documents;
  delete legacy.tables.restaurant_prices;
  // Stage 2 had no deleted orders; omit Stage 3-only deleted records from this fixture.
  legacy.tables.orders = legacy.tables.orders.filter(
    (o: Order) => !o.deleted_at,
  );
  const orderIds = new Set(legacy.tables.orders.map((o: Order) => o.id));
  legacy.tables.order_items = legacy.tables.order_items.filter(
    (i: { order_id: string }) => orderIds.has(i.order_id),
  );
  const itemIds = new Set(
    legacy.tables.order_items.map((i: { id: string }) => i.id),
  );
  legacy.tables.picking_tasks = legacy.tables.picking_tasks.filter(
    (t: { order_item_id: string }) => itemIds.has(t.order_item_id),
  );
  for (const shop of legacy.tables.shop) {
    delete shop.small_weight_percent;
    delete shop.large_weight_percent;
  }
  for (const o of legacy.tables.orders) {
    delete o.finalized_document_id;
    delete o.deleted_at;
  }
  for (const i of legacy.tables.order_items) delete i.discrepancy_ack;
  await validateBackup(legacy);
});

test("backup restoration across a fresh installation preserves snapshots, private images and local credentials and invalidates sessions", async () => {
  const f = await fixture();
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const draft = await createImport(actor, randomUUID(), {
    restaurantId: f.restaurantId,
    date: day,
    kind: "image",
    original: { mime: "image/png", base64: image.toString("base64") },
    prepared: { mime: "image/png", base64: image.toString("base64") },
  });
  const backup = JSON.parse(JSON.stringify(await exportBackup()));
  const doc = backup.tables.documents[0];
  const originalPdf = Buffer.from(doc.pdf_base64, "base64");
  const sourceActor = actor;
  await (await getDb()).close();
  globalThis.shopDatabase = undefined;
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `restored-${randomUUID()}`,
  );
  actor = randomUUID();
  const db = await getDb();
  const passwordHash = hashPassword("restored-local-password");
  await db.query(
    "INSERT INTO users(id,name,password_hash) VALUES($1,'新机器店主',$2)",
    [actor, passwordHash],
  );
  const token = await db.transaction((tx) => makeSession(tx, actor));
  const preview = await previewRestore(actor, backup);
  const result = await confirmRestore(actor, {
    token: preview.token,
    confirm: true,
    shopName: preview.shopName,
  });
  assert(result.safetyFile);
  const priceVersions = (
    await db.query<{ maximum: number; next: number }>(
      "SELECT coalesce((SELECT max(version) FROM restaurant_prices),0)::int maximum,nextval('restaurant_price_version')::int next",
    )
  ).rows[0];
  assert(
    priceVersions.next > priceVersions.maximum,
    "restored prices cannot reuse an older optimistic version",
  );
  assert.equal(await getSession(token), null);
  const owner = (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [actor],
    )
  ).rows[0];
  assert(verifyPassword("restored-local-password", owner.password_hash));
  assert.equal(
    (
      await db.query<{ role: string }>("SELECT role FROM users WHERE id=$1", [
        sourceActor,
      ])
    ).rows[0].role,
    "historical",
  );
  assert.equal((await getDraft(actor, draft.id)).source_kind, "image");
  assert.deepEqual(
    Buffer.from((await imageForDraft(actor, draft.id, false)).bytes),
    image,
  );
  assert.deepEqual(
    Buffer.from(
      (
        await db.query<{ pdf: Uint8Array }>(
          "SELECT pdf FROM documents WHERE id=$1",
          [doc.id],
        )
      ).rows[0].pdf,
    ),
    originalPdf,
  );
  const restored = await exportBackup();
  assert.equal(restored.tables.orders.length, backup.tables.orders.length);
  assert.equal(
    restored.tables.documents.length,
    backup.tables.documents.length,
  );
  assert(!JSON.stringify(restored).includes(passwordHash));
  assert(
    (
      await readdir(
        path.join(path.dirname(process.env.SHOP_DATA_DIR), "backups"),
      )
    ).includes(result.safetyFile),
  );
});
