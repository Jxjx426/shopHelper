import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../src/lib/db";
import {
  hashPassword,
  makeSession,
  getSession,
  tokenHash,
} from "../src/lib/auth";
import { runAction, workspace } from "../src/lib/service";
import { createImport } from "../src/lib/imports.server";
import { documentPreview } from "../src/lib/documents.server";
import { listStaff } from "../src/lib/users.server";
import { requestSession } from "../src/lib/request-session.server";
import { retryKey, forgetRetry } from "../src/lib/retry-ledger";
import { dailyBackup } from "../src/lib/scheduled-backup.server";
import { validateBackup } from "../src/lib/backup.server";
import { acquireDatabaseLock } from "../src/lib/database-lock.server";
const owner = randomUUID(),
  day = "2026-11-08";
const staff: string[] = [],
  tokens: string[] = [];
let orderId: string, zone: string, restaurant: string;
const act = (actor: string, input: unknown, key = randomUUID()) =>
  runAction(actor, key, input);
const current = async () =>
  (await workspace(day)).orders.find((o) => o.id === orderId)!;
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `stage4-${randomUUID()}`,
  );
  process.env.GEMINI_FREE_TIER_CONFIRMED = "false";
  const db = await getDb();
  await db.query(
    "INSERT INTO users(id,name,username,password_hash) VALUES($1,'并发测试店主','owner',$2)",
    [owner, hashPassword("stage4-test-only")],
  );
  for (let n = 0; n < 4; n++) {
    staff.push(
      (
        await act(owner, {
          action: "saveStaff",
          name: `员工${n + 1}`,
          username: `staff${n + 1}`,
          password: "stage4-test-only",
          active: true,
          canImport: n === 2,
          canFinalize: n === 3,
        })
      ).id,
    );
    tokens.push(await db.transaction((tx) => makeSession(tx, staff[n])));
  }
  zone = (
    await act(owner, { action: "saveZone", name: "并发测试区", active: true })
  ).id;
  restaurant = (
    await act(owner, {
      action: "saveRestaurant",
      name: "并发测试餐馆",
      aliases: [],
      active: true,
    })
  ).id;
  const products = [];
  for (let n = 0; n < 4; n++)
    products.push(
      (
        await act(owner, {
          action: "saveProduct",
          name: `并发商品${n + 1}`,
          aliases: [],
          zoneId: zone,
          sortOrder: n,
          active: true,
          units: [{ orderUnit: "kg", billingUnit: "kg", price: "6.00" }],
        })
      ).id,
    );
  orderId = (
    await act(owner, {
      action: "saveOrder",
      restaurantId: restaurant,
      date: day,
      urgent: false,
      items: products.map((productId) => ({
        productId,
        quantity: "10",
        unit: "kg",
      })),
    })
  ).id;
});
after(async () => {
  await (await getDb()).close();
});
test("four independent staff sessions authenticate without sharing credentials or identities", async () => {
  assert.equal(new Set(tokens).size, 4);
  const users = await Promise.all(tokens.map(getSession));
  assert.deepEqual(
    users.map((u) => u?.id),
    staff,
  );
  assert.equal(new Set(users.map((u) => u?.username)).size, 4);
  assert(!JSON.stringify(await listStaff(owner)).includes("password"));
});
test("four concurrent changes to different items all commit and keep independent amounts and actor records", async () => {
  const items = (await current()).items;
  const results = await Promise.all(
    items.map((item, n) =>
      act(staff[n], {
        action: "saveActual",
        id: item.id,
        version: item.version,
        quantity: String(10 + n / 10),
        unit: "kg",
      }),
    ),
  );
  assert.equal(results.length, 4);
  const saved = (await current()).items;
  assert.deepEqual(
    saved.map((i) => i.amount),
    ["60.00", "60.60", "61.20", "61.80"],
  );
  assert.deepEqual(
    saved.map((i) => i.last_changed_by),
    ["员工1", "员工2", "员工3", "员工4"],
  );
});
test("four concurrent same-item edits produce one save and three explicit version conflicts", async () => {
  const item = (await current()).items[0];
  const values = ["9.6", "9.7", "9.8", "9.9"];
  const results = await Promise.allSettled(
    staff.map((actor, n) =>
      act(actor, {
        action: "saveActual",
        id: item.id,
        version: item.version,
        quantity: values[n],
        unit: "kg",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results)
    if (r.status === "rejected") assert.equal(r.reason.status, 409);
  const winner = results.findIndex((r) => r.status === "fulfilled");
  const saved = (await current()).items[0];
  assert.equal(Number(saved.actual_quantity), Number(values[winner]));
  assert.equal(saved.last_changed_by, `员工${winner + 1}`);
});
test("same picking checkbox conflicts, while an independent actual-quantity edit is preserved", async () => {
  let item = (await current()).items[0];
  const picking = await Promise.allSettled(
    staff.map((actor) =>
      act(actor, {
        action: "setPicking",
        id: item.id,
        version: item.task_version,
        picked: true,
      }),
    ),
  );
  assert.equal(picking.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    picking.filter((r) => r.status === "rejected" && r.reason.status === 409)
      .length,
    3,
  );
  item = (await current()).items[1];
  await Promise.all([
    act(staff[0], {
      action: "setPicking",
      id: item.id,
      version: item.task_version,
      picked: true,
    }),
    act(staff[1], {
      action: "saveActual",
      id: item.id,
      version: item.version,
      quantity: "10.4",
      unit: "kg",
    }),
  ]);
  const saved = (await current()).items[1];
  assert.equal(saved.picking_state, "picked");
  assert.equal(Number(saved.actual_quantity), 10.4);
});
test("an old unavailable confirmation cannot overwrite a newer picking checkbox change", async () => {
  const item = (await current()).items[2];
  await act(staff[0], {
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  await assert.rejects(
    act(staff[2], {
      action: "setUnavailable",
      id: item.id,
      version: item.version,
      taskVersion: item.task_version,
      unavailable: true,
    }),
    (e: unknown) => (e as { status: number }).status === 409,
  );
  const saved = (await current()).items[2];
  assert.equal(saved.picking_state, "picked");
  assert.equal(saved.unavailable, false);
  assert.equal(saved.actual_quantity, item.actual_quantity);
});
test("staff cannot bypass catalog, prices, account, deletion, restore or import permissions", async () => {
  const data = await workspace(day),
    item = (await current()).items[0];
  const forbidden = [
    { action: "saveShop", name: "禁止", version: data.shop.version },
    { action: "saveZone", name: "禁止", active: true },
    { action: "saveRestaurant", name: "禁止", aliases: [], active: true },
    {
      action: "setOrderDeleted",
      id: orderId,
      version: (await current()).version,
      deleted: true,
    },
    {
      action: "refreshPrice",
      id: item.id,
      version: item.version,
      expectedPrice: "6.00",
    },
    {
      action: "saveStaff",
      name: "禁止",
      username: "blocked",
      password: "stage4-test-only",
      active: true,
      canImport: true,
      canFinalize: true,
    },
    {
      action: "saveOrder",
      restaurantId: restaurant,
      date: "2026-11-09",
      urgent: false,
      items: [{ productId: item.product_id, quantity: "1", unit: "kg" }],
    },
  ];
  for (const input of forbidden)
    await assert.rejects(
      act(staff[0], input),
      (e: unknown) => (e as { status: number }).status === 403,
    );
  await assert.rejects(listStaff(staff[0]), /没有操作权限/);
  await assert.rejects(
    createImport(staff[0], randomUUID(), {
      restaurantId: restaurant,
      date: day,
      kind: "text",
      text: "并发商品1 2kg",
    }),
    /没有操作权限/,
  );
});
test("an explicitly authorized importer can create a draft, while drafts stay private to their author", async () => {
  const draft = await createImport(staff[2], randomUUID(), {
    restaurantId: restaurant,
    date: day,
    kind: "text",
    text: "并发商品1 2kg",
  });
  assert(draft.id);
  const { getDraft } = await import("../src/lib/imports.server");
  assert.equal((await getDraft(staff[2], draft.id)).id, draft.id);
  await assert.rejects(getDraft(owner, draft.id), /不存在/);
});
test("only authorized staff can finalize and only the owner can reopen immutable documents", async () => {
  for (const item of (await current()).items)
    if (item.picking_state === "pending")
      await act(staff[0], {
        action: "setPicking",
        id: item.id,
        version: item.task_version,
        picked: true,
      });
  const review = await documentPreview(orderId);
  await assert.rejects(
    act(staff[0], {
      action: "finalizeOrder",
      id: orderId,
      token: review.token,
      finalChecked: true,
    }),
    /没有操作权限/,
  );
  await act(staff[3], {
    action: "finalizeOrder",
    id: orderId,
    token: review.token,
    finalChecked: true,
  });
  assert((await current()).finalized_document_id);
  await assert.rejects(
    act(staff[3], {
      action: "reopenOrder",
      id: orderId,
      version: (await current()).version,
      acknowledgeShared: true,
    }),
    /没有操作权限/,
  );
  await act(owner, {
    action: "reopenOrder",
    id: orderId,
    version: (await current()).version,
    acknowledgeShared: true,
  });
});
test("concurrent retries of the same committed request return one result without duplicate tasks or audit entries", async () => {
  const item = (await current()).items[2],
    key = randomUUID();
  const input = {
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "10.5",
    unit: "kg",
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () => act(staff[0], input, key)),
  );
  assert(results.every((r) => r.id === item.id));
  const changes = (
    await (
      await getDb()
    ).query<{ count: number }>(
      "SELECT count(*)::int count FROM change_records WHERE entity_id=$1 AND action='saveActual' AND details->>'actual'='10.5'",
      [item.id],
    )
  ).rows[0].count;
  assert.equal(changes, 1);
  assert.equal((await current()).items.length, 4);
});
test("permission changes revoke existing sessions, and disabled accounts cannot write through a queued request", async () => {
  const account = (await listStaff(owner)).find((u) => u.id === staff[1])!;
  await act(owner, {
    action: "saveStaff",
    id: account.id,
    version: account.version,
    username: account.username,
    name: account.name,
    active: false,
    canImport: false,
    canFinalize: false,
  });
  assert.equal(await getSession(tokens[1]), null);
  await assert.rejects(
    act(staff[1], {
      action: "setPicking",
      id: (await current()).items[3].id,
      version: (await current()).items[3].task_version,
      picked: true,
    }),
    /没有操作权限/,
  );
});
test("a request authenticated before revocation is checked again inside its queued transaction", async () => {
  const db = await getDb();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (started = r));
  const block = db.transaction(async (tx) => {
    started();
    await gate;
    await tx.query("DELETE FROM sessions WHERE token_hash=$1", [
      tokenHash(tokens[0]),
    ]);
  });
  await entered;
  // No additional read is queued ahead of releasing the gate.
  const pending = requestSession.run(tokenHash(tokens[0]), () =>
    act(staff[0], { action: "saveShop", name: "不应写入", version: 1 }),
  );
  const rejected = assert.rejects(
    pending,
    (e: unknown) => (e as { status: number }).status === 401,
  );
  release();
  await block;
  await rejected;
});
test("shop settings require their reviewed version instead of silently overwriting another device", async () => {
  const { shop } = await workspace(day);
  await act(owner, {
    action: "saveShop",
    name: "共享测试店",
    version: shop.version,
  });
  await assert.rejects(
    act(owner, {
      action: "saveThresholds",
      small: "20",
      large: "10",
      version: shop.version,
    }),
    /已被修改/,
  );
});
test("recreated restaurant prices cannot reuse an old version and accept a stale edit", async () => {
  const productId = (await current()).items[0].product_id;
  const input = {
    action: "saveRestaurantPrice",
    restaurantId: restaurant,
    productId,
    billingUnit: "kg",
  };
  await act(owner, { ...input, price: "5.00", expectedVersion: 0 });
  const first = (await workspace(day)).restaurantPrices.find(
    (p) => p.product_id === productId,
  )!.version;
  await act(owner, { ...input, price: null, expectedVersion: first });
  await act(owner, { ...input, price: "7.00", expectedVersion: 0 });
  const newer = (await workspace(day)).restaurantPrices.find(
    (p) => p.product_id === productId,
  )!.version;
  assert(newer > first);
  await assert.rejects(
    act(owner, { ...input, price: "8.00", expectedVersion: first }),
    /已变化/,
  );
});
test("device retry identities survive refresh, remain isolated by account and generation, and are discarded on success", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const signature = JSON.stringify({ action: "saveOrder", date: day });
  const key = retryKey(storage, "user-a:generation-1", signature, randomUUID);
  assert.equal(
    retryKey(storage, "user-a:generation-1", signature, randomUUID),
    key,
  );
  assert.notEqual(
    retryKey(storage, "user-b:generation-1", signature, randomUUID),
    key,
  );
  assert.notEqual(
    retryKey(storage, "user-a:generation-2", signature, randomUUID),
    key,
  );
  forgetRetry(storage, "user-a:generation-1", signature);
  assert.notEqual(
    retryKey(storage, "user-a:generation-1", signature, randomUUID),
    key,
  );
});
test("daily backup produces a validated complete business snapshot without staff passwords", async () => {
  process.env.SHOP_BACKUP_DIR = path.join(
    process.cwd(),
    "test-results",
    `daily-backup-${randomUUID()}`,
  );
  await dailyBackup();
  const { todayMalaysia } = await import("../src/lib/domain");
  const raw = await readFile(
    path.join(process.env.SHOP_BACKUP_DIR, `daily-${todayMalaysia()}.json`),
    "utf8",
  );
  const backup = await validateBackup(JSON.parse(raw));
  assert(backup.tables.documents.length > 0);
  assert.equal(backup.tables.orders.length, 1);
  assert(!raw.includes("stage4-test-only"));
  assert(!raw.includes("password_hash"));
  await dailyBackup();
});
test("the persistent directory refuses a second writer process and its lock can be released safely", async () => {
  const dir = path.join(process.cwd(), "test-results", `lock-${randomUUID()}`);
  await mkdir(dir);
  const release = await acquireDatabaseLock(dir);
  await assert.rejects(acquireDatabaseLock(dir), /另一个服务/);
  await release();
  const releaseAgain = await acquireDatabaseLock(dir);
  await releaseAgain();
});
test("restart preserves a deleted historical order and a replacement active order for the same restaurant and date", async () => {
  const original = await current();
  await act(owner, {
    action: "setOrderDeleted",
    id: original.id,
    version: original.version,
    deleted: true,
  });
  const replacement = await act(owner, {
    action: "saveOrder",
    restaurantId: restaurant,
    date: day,
    urgent: false,
    items: original.items.map((i) => ({
      productId: i.product_id,
      quantity: "10",
      unit: "kg",
    })),
  });
  await (await getDb()).close();
  globalThis.shopDatabase = undefined;
  const restored = await workspace(day);
  assert.equal(restored.orders.length, 1);
  assert.equal(restored.orders[0].id, replacement.id);
  assert(
    (
      await (
        await getDb()
      ).query("SELECT id FROM orders WHERE id=$1 AND deleted_at IS NOT NULL", [
        original.id,
      ])
    ).rows.length,
  );
  assert(
    (
      await (
        await getDb()
      ).query("SELECT id FROM documents WHERE order_id=$1", [original.id])
    ).rows.length,
  );
});
