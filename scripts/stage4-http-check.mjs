// Disposable, loopback-only production-server test. Never point at shop data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:3001",
  password = "stage4-test-only",
  date = "2026-11-08";
const report = {
  fourSessions: false,
  differentItems: false,
  sameItem: false,
  pickingConflict: false,
  availabilityConflict: false,
  permissions: false,
  syncMilliseconds: 0,
  responseLostRetry: false,
  duplicateOrderPrevented: false,
  documentRetry: false,
  revocation: false,
  liveGeminiCalls: 0,
};
async function call(
  cookie,
  route,
  body,
  expected = 200,
  key = randomUUID(),
  destination = base,
) {
  const r = await fetch(destination + route, {
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
  const value = await r.json();
  assert.equal(r.status, expected, JSON.stringify(value));
  return { value, response: r };
}
const auth = (await call("", "/api/auth")).value;
assert.equal(
  auth.configured,
  false,
  "Refusing to run on an existing installation",
);
await call("", "/api/auth", {
  action: "setup",
  password,
  shopName: "Stage4四人共享测试店（非营业数据）",
});
async function login(username) {
  return (
    await call("", "/api/auth", { action: "login", username, password })
  ).response.headers
    .get("set-cookie")
    .split(";")[0];
}
const owner = await login("owner");
const action = async (cookie, input, key) =>
  (await call(cookie, "/api/actions", input, 200, key)).value;
const ws = async (cookie = owner, d = date) =>
  (await call(cookie, `/api/workspace?date=${d}`)).value;
const staff = [];
for (let n = 1; n <= 4; n++) {
  await action(owner, {
    action: "saveStaff",
    username: `staff${n}`,
    name: `员工${n}`,
    password,
    active: true,
    canImport: n === 3,
    canFinalize: n === 4,
  });
  staff.push(await login(`staff${n}`));
}
assert.equal(new Set(staff).size, 4);
assert.equal(
  new Set((await Promise.all(staff.map((c) => ws(c)))).map((w) => w.user.id))
    .size,
  4,
);
report.fourSessions = true;
assert.equal(
  (await call(owner, `/api/imports?date=${date}`)).value.config.enabled,
  false,
  "Live AI must be disabled",
);
const zone = (
  await action(owner, { action: "saveZone", name: "并发测试区", active: true })
).id;
const restaurant = (
  await action(owner, {
    action: "saveRestaurant",
    name: "并发测试餐馆",
    aliases: [],
    active: true,
  })
).id;
const products = [];
for (let n = 1; n <= 4; n++)
  products.push(
    (
      await action(owner, {
        action: "saveProduct",
        name: `并发商品${n}`,
        aliases: [],
        zoneId: zone,
        sortOrder: n,
        active: true,
        units: [{ orderUnit: "kg", billingUnit: "kg", price: "6.00" }],
      })
    ).id,
  );
const newOrder = (d) => ({
  action: "saveOrder",
  restaurantId: restaurant,
  date: d,
  urgent: false,
  items: products.map((productId) => ({
    productId,
    quantity: "10",
    unit: "kg",
  })),
});
const orderId = (await action(owner, newOrder(date))).id;
let items = (await ws()).orders[0].items;
await Promise.all(
  staff.map((cookie, n) =>
    action(cookie, {
      action: "saveActual",
      id: items[n].id,
      version: items[n].version,
      quantity: String(10 + n / 10),
      unit: "kg",
    }),
  ),
);
items = (await ws()).orders[0].items;
assert.deepEqual(
  items.map((i) => i.amount),
  ["60.00", "60.60", "61.20", "61.80"],
);
report.differentItems = true;
items = (await ws()).orders[0].items;
const version = items[0].version;
const edits = await Promise.all(
  staff.map((cookie, n) =>
    fetch(base + "/api/actions", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        action: "saveActual",
        id: items[0].id,
        version,
        quantity: String(10 + n / 10),
        unit: "kg",
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  ),
);
assert.equal(edits.filter((r) => r.status === 200).length, 1);
assert.equal(edits.filter((r) => r.status === 409).length, 3);
report.sameItem = true;
items = (await ws()).orders[0].items;
await Promise.all(
  staff.map((cookie, n) =>
    action(cookie, {
      action: "setPicking",
      id: items[n].id,
      version: items[n].task_version,
      picked: true,
    }),
  ),
);
items = (await ws()).orders[0].items;
const pickEdits = await Promise.all(
  staff.map((cookie) =>
    fetch(base + "/api/actions", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        action: "setPicking",
        id: items[0].id,
        version: items[0].task_version,
        picked: false,
      }),
    }).then((r) => r.status),
  ),
);
assert.equal(pickEdits.filter((s) => s === 200).length, 1);
assert.equal(pickEdits.filter((s) => s === 409).length, 3);
report.pickingConflict = true;
items = (await ws()).orders[0].items;
const availabilityBase = items[3];
await action(staff[0], {
  action: "setPicking",
  id: availabilityBase.id,
  version: availabilityBase.task_version,
  picked: false,
});
await call(
  staff[2],
  "/api/actions",
  {
    action: "setUnavailable",
    id: availabilityBase.id,
    version: availabilityBase.version,
    taskVersion: availabilityBase.task_version,
    unavailable: true,
  },
  409,
);
const availabilityCurrent = (await ws()).orders[0].items[3];
assert.equal(availabilityCurrent.unavailable, false);
await action(staff[0], {
  action: "setPicking",
  id: availabilityCurrent.id,
  version: availabilityCurrent.task_version,
  picked: true,
});
report.availabilityConflict = true;
await action(staff[0], {
  action: "setPicking",
  id: items[0].id,
  version: items[0].task_version,
  picked: true,
});
const start = Date.now();
items = (await ws()).orders[0].items;
await action(staff[0], {
  action: "saveActual",
  id: items[1].id,
  version: items[1].version,
  quantity: "10.5",
  unit: "kg",
});
await new Promise((r) => setTimeout(r, 2000));
for (const w of await Promise.all(staff.map((c) => ws(c)))) {
  assert.equal(Number(w.orders[0].items[1].actual_quantity), 10.5);
  assert.equal(w.orders[0].items[1].last_changed_by, "员工1");
}
report.syncMilliseconds = Date.now() - start;
assert(report.syncMilliseconds < 3000);
for (const cookie of staff) {
  await call(cookie, "/api/users", undefined, 403);
  await call(cookie, "/api/backup", undefined, 403);
  await call(cookie, "/api/restore", { action: "preview", backup: {} }, 403);
  await call(
    cookie,
    "/api/actions",
    { action: "saveZone", name: "禁止", active: true },
    403,
  );
}
await call(
  staff[0],
  "/api/imports",
  { kind: "text", text: "并发商品1 2kg", restaurantId: restaurant, date },
  403,
);
await call(staff[2], "/api/imports", {
  kind: "text",
  text: "并发商品1 2kg",
  restaurantId: restaurant,
  date,
});
report.permissions = true;
// Drop the response only after the upstream transaction has committed.
let drop = true,
  droppedStatus = 0;
const proxy = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(base + req.url, {
    method: req.method,
    headers: { ...req.headers, host: "127.0.0.1:3001", origin: base },
    body: Buffer.concat(chunks),
    duplex: "half",
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (drop) {
    drop = false;
    droppedStatus = upstream.status;
    res.destroy();
    return;
  }
  res.writeHead(upstream.status, { "Content-Type": "application/json" });
  res.end(bytes);
});
await new Promise((r) => proxy.listen(3002, "127.0.0.1", r));
try {
  const key = randomUUID(),
    input = newOrder("2026-11-09");
  await assert.rejects(
    call(owner, "/api/actions", input, 200, key, "http://127.0.0.1:3002"),
  );
  assert.equal(droppedStatus, 200);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => action(owner, input, key)),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  const copied = (await ws(owner, "2026-11-09")).orders;
  assert.equal(copied.length, 1);
  assert.equal(copied[0].items.length, 4);
  report.responseLostRetry = true;
  report.duplicateOrderPrevented = true;
  const review = (await call(owner, `/api/orders/${orderId}/document`)).value;
  await call(
    staff[0],
    "/api/actions",
    {
      action: "finalizeOrder",
      id: orderId,
      token: review.token,
      finalChecked: true,
    },
    403,
  );
  const finalKey = randomUUID(),
    finalInput = {
      action: "finalizeOrder",
      id: orderId,
      token: review.token,
      finalChecked: true,
    };
  drop = true;
  await assert.rejects(
    call(
      staff[3],
      "/api/actions",
      finalInput,
      200,
      finalKey,
      "http://127.0.0.1:3002",
    ),
  );
  assert.equal(droppedStatus, 200);
  await action(staff[3], finalInput, finalKey);
  const frozen = (await call(owner, `/api/orders/${orderId}/document`)).value;
  assert.equal(frozen.documents.length, 1);
  const pdf = await fetch(
    base + `/api/documents/${frozen.finalizedDocumentId}/pdf`,
    { headers: { Cookie: staff[0] } },
  );
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  report.documentRetry = true;
} finally {
  await new Promise((r) => proxy.close(r));
}
const account = (await call(owner, "/api/users")).value.users.find(
  (u) => u.username === "staff2",
);
await action(owner, {
  action: "saveStaff",
  id: account.id,
  version: account.version,
  username: account.username,
  name: account.name,
  active: false,
  canImport: false,
  canFinalize: false,
});
await call(staff[1], "/api/workspace?date=" + date, undefined, 401);
await call(
  "",
  "/api/auth",
  { action: "login", username: "staff2", password },
  401,
);
report.revocation = true;
await writeFile(
  "test-results/stage4-http-qa.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
