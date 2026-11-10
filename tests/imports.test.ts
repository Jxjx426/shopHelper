import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "../src/lib/db";
import { runAction, workspace, exportBackup } from "../src/lib/service";
import {
  createImport,
  getDraft,
  saveDraft,
  extractDraft,
  previewImport,
  confirmImport,
  imageForDraft,
  listDrafts,
  supplementDraft,
  setDraftDeleted,
} from "../src/lib/imports.server";
import {
  PRIVACY_VERSION,
  type ImportDraft,
  type ReviewLine,
} from "../src/lib/import-types";
import {
  ExtractionFailure,
  type OrderExtractionProvider,
} from "../src/lib/gemini.server";
import { blankLine, type ExtractionResult } from "../src/lib/extraction";
import { validateBackup } from "../src/lib/backup.server";
const actor = randomUUID(),
  stranger = randomUUID();
let zone: string, product: string, japanese: string, box: string;
const date = "2026-11-08";
const action = (a: unknown) => runAction(actor, randomUUID(), a);
before(async () => {
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `imports-${randomUUID()}`,
  );
  process.env.GEMINI_API_KEY = "fixture-key-not-real";
  process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
  process.env.GEMINI_FREE_TIER_CONFIRMED = "true";
  process.env.GEMINI_MAX_RPM = "10";
  process.env.GEMINI_MAX_RPD = "100";
  const db = await getDb();
  for (const id of [actor, stranger])
    await db.query(
      "INSERT INTO users(id,name,password_hash) VALUES($1,'测试用户','not-a-real-hash')",
      [id],
    );
  zone = (await action({ action: "saveZone", name: "区域", active: true })).id;
  for (const [variable, name, units] of [
    [
      "product",
      "Timun",
      [{ orderUnit: "kg", billingUnit: "kg", price: "6.00" }],
    ],
    [
      "japanese",
      "日本 Timun",
      [{ orderUnit: "kg", billingUnit: "kg", price: "8.00" }],
    ],
    [
      "box",
      "Carrot",
      [
        { orderUnit: "kg", billingUnit: "kg", price: "10.00" },
        { orderUnit: "箱", billingUnit: "箱", price: "24.00" },
      ],
    ],
  ] as const) {
    const id = (
      await action({
        action: "saveProduct",
        name,
        aliases: [],
        zoneId: zone,
        sortOrder: 1,
        active: true,
        units,
      })
    ).id;
    if (variable === "product") product = id;
    else if (variable === "japanese") japanese = id;
    else box = id;
  }
});
beforeEach(async () => {
  const db = await getDb();
  await db.query(
    "UPDATE extraction_attempts SET started_at=now()-interval '10 minutes' WHERE status<>'pending'",
  );
  await db.query("DELETE FROM extraction_cooldown");
});
after(async () => {
  if (globalThis.shopDatabase) await (await globalThis.shopDatabase).close();
  globalThis.shopDatabase = undefined;
});
async function restaurant(name = `餐馆-${randomUUID()}`) {
  return (
    await action({ action: "saveRestaurant", name, aliases: [], active: true })
  ).id;
}
async function draft(text = "Timun 2kg", restaurantId?: string) {
  const r = restaurantId ?? (await restaurant());
  const created = await createImport(actor, randomUUID(), {
    restaurantId: r,
    date,
    kind: "text",
    text,
  });
  return getDraft(actor, created.id);
}
function serialize(lines: ReviewLine[]) {
  return lines.map(
    ({
      id,
      productText,
      productId,
      quantity,
      unit,
      disposition,
      ignoreReason,
      reviewed,
      saveAlias,
    }) => ({
      id,
      productText,
      productId,
      quantity,
      unit,
      disposition,
      ignoreReason,
      reviewed,
      saveAlias,
    }),
  );
}
async function reviewed(
  d: ImportDraft,
  changes?: Partial<ReviewLine>,
  options: { ack?: boolean; checked?: boolean } = {},
) {
  const lines = d.lines.map((line, index) => ({
    ...line,
    productId: product,
    productText: "Timun",
    quantity: "2",
    unit: "kg" as const,
    reviewed: true,
    ...(index === 0 ? changes : {}),
  }));
  await saveDraft(actor, d.id, randomUUID(), {
    version: d.version,
    restaurantId: d.restaurant_id,
    lines: serialize(lines),
    restaurantAcknowledged: options.ack ?? false,
    sourceChecked: options.checked ?? true,
  });
  return getDraft(actor, d.id);
}
const raw = (sourceText = "Timun 2kg"): ExtractionResult => ({
  detectedRestaurant: null,
  unreadableContent: false,
  lines: [
    {
      sourceLine: 1,
      sourceText,
      productText: "Timun",
      quantity: "2",
      unitText: "kg",
      uncertain: false,
    },
  ],
});
function mock(
  result: ExtractionResult = raw(),
  callback?: () => void,
): OrderExtractionProvider {
  return {
    name: "fixture",
    extract: async () => {
      callback?.();
      return result;
    },
  };
}
async function extract(d: ImportDraft, provider = mock(), key = randomUUID()) {
  await extractDraft(
    actor,
    d.id,
    key,
    {
      version: d.version,
      privacyVersion: PRIVACY_VERSION,
      redacted: true,
      replaceExisting: true,
      force: true,
    },
    provider,
  );
  return getDraft(actor, d.id);
}
async function confirm(
  d: ImportDraft,
  mode: "new" | "append" | "replace" = "new",
  ack = false,
) {
  const preview = await previewImport(actor, d.id, d.version, mode);
  const result = await confirmImport(actor, d.id, randomUUID(), {
    version: d.version,
    token: preview.token,
    identicalAcknowledged: ack,
  });
  return { preview, id: result.id };
}

test("saved drafts are idempotent, resumable, date-isolated and never create picking demand", async () => {
  const r = await restaurant();
  const input = { restaurantId: r, date, kind: "text", text: "Timun 2kg" };
  const key = randomUUID();
  const first = await createImport(actor, key, input),
    retry = await createImport(actor, key, input),
    same = await createImport(actor, randomUUID(), input);
  assert.equal(first.id, retry.id);
  assert.equal(first.id, same.id);
  assert.equal(same.reused, true);
  assert((await listDrafts(actor, date)).some((d) => d.id === first.id));
  assert(
    !(await listDrafts(actor, "2026-11-09")).some((d) => d.id === first.id),
  );
  assert(!(await workspace(date)).orders.some((o) => o.restaurant_id === r));
});
test("all source lines must be processed explicitly; missing fields and missing final checking block confirmation", async () => {
  let d = await draft("Timun 2kg\n餐馆标题");
  await assert.rejects(
    saveDraft(actor, d.id, randomUUID(), {
      version: d.version,
      restaurantId: d.restaurant_id,
      lines: serialize(d.lines.slice(0, 1)),
      restaurantAcknowledged: false,
      sourceChecked: false,
    }),
    /不能静默删除/,
  );
  await assert.rejects(
    previewImport(actor, d.id, d.version, "new"),
    /对照原文/,
  );
  await assert.rejects(reviewed(d, { quantity: "" }), /尚未填写完整/);
  d = await reviewed(d, undefined, { checked: false });
  await assert.rejects(
    previewImport(actor, d.id, d.version, "new"),
    /对照原文/,
  );
});
test("Gemini outputs stay unconfirmed; text omissions, unknowns and incomplete 青龙菜1. remain visible", async () => {
  let d = await draft("Timun 2kg\n青龙菜1.\n未知备注");
  d = await extract(d);
  assert.equal(d.lines.length, 3);
  assert.equal(d.lines[0].productId, product);
  assert.equal(d.lines[1].quantity, "");
  assert.equal(d.lines[1].unit, "");
  assert(d.lines.every((l) => !l.reviewed));
  assert(
    !(await workspace(date)).orders.some(
      (o) => o.restaurant_id === d.restaurant_id,
    ),
  );
});
test("consent and free-project configuration are checked before any provider call", async () => {
  const d = await draft();
  let calls = 0;
  await assert.rejects(
    extractDraft(
      actor,
      d.id,
      randomUUID(),
      {
        version: d.version,
        privacyVersion: "wrong",
        redacted: true,
        replaceExisting: true,
      },
      mock(raw(), () => calls++),
    ),
    /数据说明/,
  );
  const old = process.env.GEMINI_FREE_TIER_CONFIRMED;
  process.env.GEMINI_FREE_TIER_CONFIRMED = "false";
  await assert.rejects(
    extract(
      d,
      mock(raw(), () => calls++),
    ),
    /billing/,
  );
  process.env.GEMINI_FREE_TIER_CONFIRMED = old;
  assert.equal(calls, 0);
});
test("request replay never repeats extraction, and invalid output never creates operations", async () => {
  const d = await draft();
  let calls = 0;
  const key = randomUUID();
  const provider = mock(raw(), () => calls++);
  await extract(d, provider, key);
  await extract(d, provider, key);
  assert.equal(calls, 1);
  const other = await draft();
  const invalid = {
    name: "fixture",
    extract: async () =>
      ({ lines: [], price: 12 }) as unknown as ExtractionResult,
  };
  const failed = await extract(other, invalid);
  assert.equal(failed.status, "failed");
  assert.equal(failed.lines[0].sourceText, "Timun 2kg");
  assert.equal(failed.lines[0].productId, other.lines[0].productId);
});
test("provider failures preserve manual corrections and source; explicit manual fallback can still confirm", async () => {
  let d = await reviewed(await draft());
  const before = JSON.stringify(d.lines);
  let calls = 0;
  const provider: OrderExtractionProvider = {
    name: "fixture",
    extract: async () => {
      calls++;
      throw new ExtractionFailure("测试连接失败，草稿已保留", "network");
    },
  };
  d = await extract(d, provider);
  assert.equal(calls, 1);
  assert.equal(d.status, "failed");
  assert.equal(JSON.stringify(d.lines), before);
  assert((await confirm(d)).id);
});
test("same-product same-unit lines only combine in the displayed final preview, and confirmation is idempotent", async () => {
  let d = await reviewed(await draft("Timun 2kg\nTimun 2kg"));
  const preview = await previewImport(actor, d.id, d.version, "new");
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0].quantity, "4");
  assert.equal(preview.mergedRows, 1);
  const key = randomUUID(),
    body = {
      version: d.version,
      token: preview.token,
      identicalAcknowledged: false,
    };
  const first = await confirmImport(actor, d.id, key, body),
    second = await confirmImport(actor, d.id, key, body);
  assert.equal(first.id, second.id);
  const order = (await workspace(date)).orders.find((o) => o.id === first.id)!;
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].ordered_quantity, "4.000");
});
test("restaurant mismatches require resolution without silently switching the selected restaurant", async () => {
  const otherName = `另一餐馆-${randomUUID()}`;
  await restaurant(otherName);
  let d = await reviewed(await draft(`${otherName}\nTimun 2kg`));
  await assert.rejects(
    previewImport(actor, d.id, d.version, "new"),
    /餐馆名称/,
  );
  d = await reviewed(d, undefined, { ack: true });
  const p = await previewImport(actor, d.id, d.version, "new");
  assert.equal(p.restaurantName, d.restaurant_name);
});
test("explicit alias confirmation teaches future imports without merging distinct products", async () => {
  let d = await reviewed(await draft("Gobis 2kg"), {
    productId: box,
    productText: "Gobis",
    saveAlias: true,
  });
  await confirm(d);
  const data = await workspace(date);
  assert(data.products.find((p) => p.id === box)!.aliases.includes("Gobis"));
  const next = await draft("Gobis 2kg");
  const output = raw("Gobis 2kg");
  output.lines[0].productText = "Gobis";
  const parsed = await extract(next, mock(output));
  assert.equal(parsed.lines[0].productId, box);
  assert(data.products.some((p) => p.id === product));
  assert(data.products.some((p) => p.id === japanese));
});
test("new products created during review can be selected and confirmed", async () => {
  const id = (
    await action({
      action: "saveProduct",
      name: `新菜-${randomUUID()}`,
      aliases: [],
      zoneId: zone,
      sortOrder: 1,
      active: true,
      units: [{ orderUnit: "包", billingUnit: "包", price: null }],
    })
  ).id;
  const d = await reviewed(await draft("未知菜 3包"), {
    productId: id,
    productText: "未知菜",
    quantity: "3",
    unit: "包",
  });
  const p = await previewImport(actor, d.id, d.version, "new");
  assert.equal(p.missingPrices, 1);
  assert.equal(p.lines[0].price, null);
  assert((await confirm(d)).id);
});
test("append preserves existing task IDs and price snapshots; different units remain separate", async () => {
  const first = await reviewed(await draft());
  const initial = await confirm(first);
  const before = (await workspace(date)).orders.find(
    (o) => o.id === initial.id,
  )!;
  const p = (await workspace(date)).products.find((p) => p.id === product)!;
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: 1,
    active: true,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "9.00" }],
  });
  const second = await reviewed(await draft("Timun 3kg", first.restaurant_id), {
    quantity: "3",
  });
  await assert.rejects(
    previewImport(actor, second.id, second.version, "new"),
    /当天已有订单/,
  );
  const added = await confirm(second, "append");
  assert.equal(added.id, initial.id);
  assert.equal(added.preview.lines[0].price, "6.00");
  const after = (await workspace(date)).orders.find(
    (o) => o.id === initial.id,
  )!;
  assert.equal(after.items[0].id, before.items[0].id);
  assert.equal(after.items[0].price_snapshot, "6.00");
  assert.equal(after.items[0].ordered_quantity, "5.000");
  let count = await reviewed(await draft("Carrot 1箱\nCarrot 2kg"), {
    productId: box,
    quantity: "1",
    unit: "箱",
  });
  const changes = count.lines.map((line, i) => ({
    ...line,
    productId: box,
    quantity: i ? "2" : "1",
    unit: i ? ("kg" as const) : ("箱" as const),
  }));
  await saveDraft(actor, count.id, randomUUID(), {
    version: count.version,
    restaurantId: count.restaurant_id,
    lines: serialize(changes),
    sourceChecked: true,
    restaurantAcknowledged: false,
  });
  count = await getDraft(actor, count.id);
  assert.equal(
    (await previewImport(actor, count.id, count.version, "new")).lines.length,
    2,
  );
});
test("identical confirmed content warns before append, and requires a second explicit acknowledgement", async () => {
  const first = await reviewed(await draft());
  await confirm(first);
  const next = await reviewed(await draft("Timun 2kg", first.restaurant_id));
  const p = await previewImport(actor, next.id, next.version, "append");
  assert.equal(p.identicalSource, true);
  await assert.rejects(
    confirmImport(actor, next.id, randomUUID(), {
      version: next.version,
      token: p.token,
      identicalAcknowledged: false,
    }),
    /此前|已经导入/,
  );
  await confirmImport(actor, next.id, randomUUID(), {
    version: next.version,
    token: p.token,
    identicalAcknowledged: true,
  });
});
test("replacement refreshes prices explicitly and picking-start blocks both append and replacement", async () => {
  const first = await reviewed(await draft());
  const original = await confirm(first);
  const next = await reviewed(await draft("Timun 8kg", first.restaurant_id), {
    quantity: "8",
  });
  const replaced = await confirm(next, "replace");
  assert.equal(replaced.id, original.id);
  const order = (await workspace(date)).orders.find(
    (o) => o.id === original.id,
  )!;
  assert.equal(order.items[0].ordered_quantity, "8.000");
  await action({
    action: "setPicking",
    id: order.items[0].id,
    version: order.items[0].task_version,
    picked: true,
  });
  const blocked = await reviewed(
    await draft("Timun 1kg", first.restaurant_id),
    { quantity: "1" },
  );
  await assert.rejects(
    previewImport(actor, blocked.id, blocked.version, "append"),
    /已开始配货/,
  );
  await assert.rejects(
    previewImport(actor, blocked.id, blocked.version, "replace"),
    /已开始配货/,
  );
});
test("final previews invalidate after price changes or picking begins; server never silently confirms stale plans", async () => {
  const d = await reviewed(await draft());
  const preview = await previewImport(actor, d.id, d.version, "new");
  const p = (await workspace(date)).products.find((p) => p.id === product)!;
  await action({
    action: "saveProduct",
    id: p.id,
    version: p.version,
    name: p.name,
    aliases: p.aliases,
    zoneId: p.zone_id,
    sortOrder: 1,
    active: true,
    units: [{ orderUnit: "kg", billingUnit: "kg", price: "7.00" }],
  });
  await assert.rejects(
    confirmImport(actor, d.id, randomUUID(), {
      version: d.version,
      token: preview.token,
      identicalAcknowledged: false,
    }),
    /已改变/,
  );
  assert(
    !(await workspace(date)).orders.some(
      (o) => o.restaurant_id === d.restaurant_id,
    ),
  );
});
test("source ownership, review version checks, supplemental text and image validation are enforced", async () => {
  const d = await draft();
  await assert.rejects(getDraft(stranger, d.id), /不存在/);
  await supplementDraft(actor, d.id, randomUUID(), d.version, "额外项目\n");
  const updated = await getDraft(actor, d.id);
  assert.equal(updated.lines.length, 2);
  assert.equal(updated.lines[1].sourceText, "额外项目");
  await assert.rejects(reviewed(d), /草稿已更新/);
  await assert.rejects(
    createImport(actor, randomUUID(), {
      restaurantId: d.restaurant_id,
      date,
      kind: "image",
      original: {
        mime: "image/png",
        base64: Buffer.from("not an image").toString("base64"),
      },
      prepared: {
        mime: "image/png",
        base64: Buffer.from("not an image").toString("base64"),
      },
    }),
    /图片/,
  );
});
test("screenshots retain a private original while extraction receives only the prepared raster", async () => {
  const original = await sharp({
    create: { width: 80, height: 80, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const prepared = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "black" },
  })
    .png()
    .toBuffer();
  const r = await restaurant();
  const c = await createImport(actor, randomUUID(), {
    restaurantId: r,
    date,
    kind: "image",
    original: { mime: "image/png", base64: original.toString("base64") },
    prepared: { mime: "image/png", base64: prepared.toString("base64") },
  });
  let d = await getDraft(actor, c.id);
  assert.equal(d.original_mime, "image/png");
  let captured = 0;
  d = await extract(d, {
    name: "fixture",
    extract: async (input) => {
      assert.equal(input.kind, "image");
      if (input.kind === "image") {
        const meta = await sharp(input.data).metadata();
        assert.equal(meta.width, 20);
        captured++;
      }
      return raw();
    },
  });
  assert.equal(captured, 1);
  assert.equal(d.status, "review");
  assert.equal(
    (await sharp((await imageForDraft(actor, d.id, false)).bytes).metadata())
      .width,
    80,
  );
  await assert.rejects(imageForDraft(stranger, d.id, false), /不存在/);
  const backup = await exportBackup();
  assert(backup.tables.import_images.length > 0);
  assert(!JSON.stringify(backup).includes("fixture-key-not-real"));
});
test("quota failures set a persistent cooldown and never auto-retry or discard the draft", async () => {
  const d = await draft();
  let calls = 0;
  const provider: OrderExtractionProvider = {
    name: "fixture",
    extract: async () => {
      calls++;
      throw new ExtractionFailure("测试配额耗尽", "quota", 120);
    },
  };
  const failed = await extract(d, provider);
  assert.equal(calls, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.original_text, "Timun 2kg");
  await assert.rejects(extract(failed, provider), /冷却/);
  assert.equal(calls, 1);
});

test("server downsizes prepared screenshots and preserves full original pixels", async () => {
  const image = await sharp({
    create: { width: 3200, height: 6000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const payload = { mime: "image/png", base64: image.toString("base64") };
  const created = await createImport(actor, randomUUID(), {
    restaurantId: await restaurant(),
    date,
    kind: "image",
    original: payload,
    prepared: payload,
  });
  const original = await sharp(
    (await imageForDraft(actor, created.id, false)).bytes,
  ).metadata();
  const prepared = await sharp(
    (await imageForDraft(actor, created.id, true)).bytes,
  ).metadata();
  assert.equal(original.width, 3200);
  assert.equal(original.height, 6000);
  assert.equal(prepared.width, 1600);
  assert.equal(prepared.height, 3000);
  assert.equal(prepared.format, "jpeg");
  // Simulate a draft saved before resizing was introduced.
  await (
    await getDb()
  ).query(
    "UPDATE import_images SET prepared_image=$1,prepared_mime='image/png' WHERE draft_id=$2",
    [image, created.id],
  );
  await extract(await getDraft(actor, created.id), {
    name: "legacy-image-fixture",
    extract: async (input) => {
      assert.equal(input.kind, "image");
      if (input.kind === "image") {
        const meta = await sharp(input.data).metadata();
        assert.equal(meta.width, 1600);
        assert.equal(meta.height, 3000);
      }
      return raw();
    },
  });
  assert.equal(
    (
      await sharp(
        (await imageForDraft(actor, created.id, false)).bytes,
      ).metadata()
    ).width,
    3200,
  );
});
test("drafts, screenshots, attempts and reviewed corrections survive database reopening", async () => {
  const d = await reviewed(await draft());
  const db = await getDb();
  await db.close();
  globalThis.shopDatabase = undefined;
  const reopened = await getDraft(actor, d.id);
  assert.equal(reopened.lines[0].reviewed, true);
  assert.equal(reopened.source_checked, true);
  assert.equal(reopened.original_text, "Timun 2kg");
});

test("project-wide daily and per-minute application limits prevent calls before consuming more quota", async () => {
  let calls = 0;
  const provider = mock(raw(), () => calls++);
  try {
    process.env.GEMINI_MAX_RPD = "1";
    const d = await draft();
    await assert.rejects(extract(d, provider), /今日识别上限/);
    assert.equal(calls, 0);
    process.env.GEMINI_MAX_RPD = "100";
    process.env.GEMINI_MAX_RPM = "1";
    await extract(d, provider);
    const other = await draft();
    await assert.rejects(extract(other, provider), /每分钟识别上限/);
    assert.equal(calls, 1);
  } finally {
    process.env.GEMINI_MAX_RPM = "10";
    process.env.GEMINI_MAX_RPD = "100";
  }
});
test("simultaneous extraction attempts cannot issue two requests for the same review version", async () => {
  const d = await draft();
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: OrderExtractionProvider = {
    name: "fixture",
    extract: async () => {
      calls++;
      started();
      await gate;
      return raw();
    },
  };
  const first = extract(d, provider);
  await active;
  try {
    await assert.rejects(extract(d, provider), /草稿已更新|正在识别/);
  } finally {
    release();
  }
  await first;
  assert.equal(calls, 1);
});
test("straightforward text needs no provider, while unresolved-only extraction preserves resolved rows", async () => {
  let calls = 0;
  const input = {
    privacyVersion: PRIVACY_VERSION,
    redacted: true,
    replaceExisting: false,
    scope: "unresolved",
  };
  const d = await draft();
  await extractDraft(
    actor,
    d.id,
    randomUUID(),
    { ...input, version: d.version },
    mock(raw(), () => calls++),
  );
  assert.equal(calls, 0);
  assert.equal((await getDraft(actor, d.id)).version, d.version);
  const mixed = await draft("Timun 2kg\n青龙菜1.");
  const provider: OrderExtractionProvider = {
    name: "partial-fixture",
    extract: async (value) => {
      calls++;
      assert.equal(value.kind, "text");
      if (value.kind === "text") assert.equal(value.text, "\n青龙菜1.");
      return {
        detectedRestaurant: null,
        unreadableContent: false,
        lines: [
          {
            sourceLine: 2,
            sourceText: "青龙菜1.",
            productText: "青龙菜",
            quantity: null,
            unitText: null,
            uncertain: true,
          },
        ],
      };
    },
  };
  await extractDraft(
    actor,
    mixed.id,
    randomUUID(),
    { ...input, version: mixed.version },
    provider,
  );
  const next = await getDraft(actor, mixed.id);
  assert.deepEqual(next.lines[0], mixed.lines[0]);
  assert.equal(next.lines[1].quantity, "");
  assert.equal(calls, 1);
});

test("saved extraction results survive reopening and bypass quota; changed input and explicit force do not reuse", async () => {
  let calls = 0;
  const provider = { ...mock(raw(), () => calls++), name: "cache-fixture" };
  const input = {
    privacyVersion: PRIVACY_VERSION,
    redacted: true,
    replaceExisting: true,
    scope: "all",
  };
  const first = await draft();
  await extractDraft(
    actor,
    first.id,
    randomUUID(),
    { ...input, version: first.version },
    provider,
  );
  const db = await getDb();
  await db.close();
  globalThis.shopDatabase = undefined;
  const second = await draft();
  await (
    await getDb()
  ).query(
    "INSERT INTO extraction_cooldown(id,until_at) VALUES(1,now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET until_at=excluded.until_at",
  );
  const reused = await extractDraft(
    actor,
    second.id,
    randomUUID(),
    { ...input, version: second.version },
    provider,
  );
  assert.equal("cached" in reused && reused.cached, true);
  assert.equal(calls, 1);
  const refreshed = await getDraft(actor, second.id);
  await assert.rejects(
    extractDraft(
      actor,
      second.id,
      randomUUID(),
      { ...input, version: refreshed.version, force: true },
      provider,
    ),
    /冷却/,
  );
  const changed = await draft("Timun 3kg");
  await assert.rejects(
    extractDraft(
      actor,
      changed.id,
      randomUUID(),
      { ...input, version: changed.version },
      provider,
    ),
    /冷却/,
  );
  await (await getDb()).query("DELETE FROM extraction_cooldown");
  await extractDraft(
    actor,
    second.id,
    randomUUID(),
    { ...input, version: refreshed.version, force: true },
    provider,
  );
  assert.equal(calls, 2);
});

test("older untouched text drafts also use rules before Gemini and preserve manual corrections", async () => {
  const d = await draft("Timun 2kg\nCarrot 1箱");
  const manual = { ...d.lines[1], quantity: "3", matchedBy: "manual" as const };
  await (
    await getDb()
  ).query("UPDATE import_drafts SET lines=$1 WHERE id=$2", [
    JSON.stringify([blankLine("Timun 2kg", 1, d.lines[0].id), manual]),
    d.id,
  ]);
  let calls = 0;
  await extractDraft(
    actor,
    d.id,
    randomUUID(),
    {
      version: d.version,
      privacyVersion: PRIVACY_VERSION,
      redacted: true,
      replaceExisting: false,
      scope: "unresolved",
    },
    mock(raw(), () => calls++),
  );
  const next = await getDraft(actor, d.id);
  assert.equal(calls, 0);
  assert.equal(next.lines[0].productId, product);
  assert.equal(next.lines[0].quantity, "2");
  assert.equal(next.lines[0].reviewed, false);
  assert.deepEqual(next.lines[1], manual);
});

test("draft deletion is recoverable, owner-only and versioned; source and orders are preserved", async () => {
  const d = await draft("Timun 2kg");
  const key = randomUUID();
  await assert.rejects(
    setDraftDeleted(stranger, d.id, key, { version: d.version, deleted: true }),
    /不存在/,
  );
  await assert.rejects(
    setDraftDeleted(actor, d.id, key, {
      version: d.version + 1,
      deleted: true,
    }),
    /草稿已更新/,
  );
  await setDraftDeleted(actor, d.id, key, {
    version: d.version,
    deleted: true,
  });
  await setDraftDeleted(actor, d.id, key, {
    version: d.version,
    deleted: true,
  });
  assert(!(await listDrafts(actor, date)).some((row) => row.id === d.id));
  const deleted = (await listDrafts(actor, date, true)).find(
    (row) => row.id === d.id,
  )!;
  assert(deleted);
  await assert.rejects(getDraft(actor, d.id), /草稿已删除/);
  const replacement = await draft("Timun 2kg", d.restaurant_id);
  assert.notEqual(replacement.id, d.id);
  await setDraftDeleted(actor, d.id, randomUUID(), {
    version: deleted.version,
    deleted: false,
  });
  const restored = await getDraft(actor, d.id);
  assert.equal(restored.original_text, d.original_text);
  assert.deepEqual(restored.lines, d.lines);
  const ready = await reviewed(restored);
  const confirmed = await confirm(ready);
  const after = await getDraft(actor, d.id);
  await assert.rejects(
    setDraftDeleted(actor, d.id, randomUUID(), {
      version: after.version,
      deleted: true,
    }),
    /已确认/,
  );
  assert(
    (await workspace(date)).orders.some((order) => order.id === confirmed.id),
  );
  const extracting = await draft();
  await (
    await getDb()
  ).query("UPDATE import_drafts SET status='extracting' WHERE id=$1", [
    extracting.id,
  ]);
  await assert.rejects(
    setDraftDeleted(actor, extracting.id, randomUUID(), {
      version: extracting.version,
      deleted: true,
    }),
    /正在识别/,
  );
});

test("conflicting alias creation fails atomically without creating an order", async () => {
  const d = await reviewed(await draft("Gobis 2kg"), {
    productText: "Gobis",
    productId: product,
    saveAlias: true,
  });
  const preview = await previewImport(actor, d.id, d.version, "new");
  await assert.rejects(
    confirmImport(actor, d.id, randomUUID(), {
      version: d.version,
      token: preview.token,
      identicalAcknowledged: false,
    }),
    /已用于其他商品/,
  );
  assert(
    !(await workspace(date)).orders.some(
      (o) => o.restaurant_id === d.restaurant_id,
    ),
  );
});

test("unique saved units survive draft saving and confirmation; exact restaurant headers stay outside picking demand", async () => {
  const r = await restaurant("唯一单位测试餐馆");
  let d = await draft("唯一单位测试餐馆\nTimun 5", r);
  assert.equal(d.lines[0].disposition, "ignored");
  assert.equal(d.lines[0].reviewed, false);
  assert.equal(d.lines[1].quantity, "5");
  assert.equal(d.lines[1].unit, "kg");
  assert.equal(d.lines[1].unitNote, "沿用商品已设单位");
  assert.equal(d.attempts, 0);
  await saveDraft(actor, d.id, randomUUID(), {
    version: d.version,
    restaurantId: r,
    lines: serialize(d.lines.map((l) => ({ ...l, reviewed: true }))),
    sourceChecked: true,
    restaurantAcknowledged: false,
  });
  d = await getDraft(actor, d.id);
  assert.equal(d.lines[1].unitNote, "沿用商品已设单位");
  const backup = await validateBackup(await exportBackup());
  const savedDraft = backup.tables.import_drafts.find(
    (row: any) => row.id === d.id,
  ) as any;
  assert.equal(savedDraft.lines[1].unitNote, "沿用商品已设单位");
  const confirmed = await confirm(d);
  assert.equal(confirmed.preview.lines.length, 1);
  assert.equal(confirmed.preview.lines[0].quantity, "5");
  assert.equal(confirmed.preview.lines[0].unit, "kg");
  const order = (await workspace(date)).orders.find(
    (o) => o.id === confirmed.id,
  )!;
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].product_id, product);
});
test("supplemented text uses the same quantity/unit rules and manual correction clears inferred unit notes", async () => {
  let d = await draft();
  await supplementDraft(actor, d.id, randomUUID(), d.version, "Timun 7");
  d = await getDraft(actor, d.id);
  const extra = d.lines.at(-1)!;
  assert.equal(extra.quantity, "7");
  assert.equal(extra.unit, "kg");
  assert.equal(extra.unitNote, "沿用商品已设单位");
  assert.equal(d.attempts, 0);
  await saveDraft(actor, d.id, randomUUID(), {
    version: d.version,
    restaurantId: d.restaurant_id,
    lines: serialize(
      d.lines.map((l) => (l.id === extra.id ? { ...l, quantity: "8" } : l)),
    ),
    sourceChecked: false,
    restaurantAcknowledged: false,
  });
  const corrected = (await getDraft(actor, d.id)).lines.at(-1)!;
  assert.equal(corrected.quantity, "8");
  assert.equal(corrected.unitNote, undefined);
});

test("table extraction persists literal quantity cells and blank rows through review, preview and confirmation", async () => {
  const r = await restaurant();
  const image = await sharp({
    create: { width: 400, height: 220, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const file = { mime: "image/png", base64: image.toString("base64") };
  const created = await createImport(actor, randomUUID(), {
    restaurantId: r,
    date,
    kind: "image",
    original: file,
    prepared: file,
  });
  let d = await getDraft(actor, created.id);
  let calls = 0;
  d = await extract(
    d,
    mock(
      {
        detectedRestaurant: null,
        unreadableContent: false,
        lines: [
          {
            sourceLine: 1,
            sourceText: "本地黄瓜 Timun",
            productText: "本地黄瓜 Timun",
            quantity: "0.5",
            unitText: "kg",
            quantityText: "500g",
            quantityStatus: "present",
            uncertain: false,
          },
          {
            sourceLine: 2,
            sourceText: "玻璃生菜 Ice Berg Lettuce",
            productText: "玻璃生菜 Ice Berg Lettuce",
            quantity: null,
            unitText: null,
            quantityText: null,
            quantityStatus: "blank",
            uncertain: false,
          },
        ],
      },
      () => calls++,
    ),
  );
  assert.equal(calls, 1);
  assert.equal(d.lines[0].productId, product);
  assert.equal(d.lines[0].quantity, "0.5");
  assert.equal(d.lines[0].unit, "kg");
  assert.equal(d.lines[0].sourceText, "本地黄瓜 Timun 500g");
  assert.equal(d.lines[1].disposition, "ignored");
  assert(d.lines.every((l) => !l.reviewed));
  await assert.rejects(
    previewImport(actor, d.id, d.version, "new"),
    /确认|核对|处理/,
  );
  await saveDraft(actor, d.id, randomUUID(), {
    version: d.version,
    restaurantId: r,
    lines: serialize(d.lines.map((l) => ({ ...l, reviewed: true }))),
    sourceChecked: true,
    restaurantAcknowledged: false,
  });
  d = await getDraft(actor, d.id);
  const confirmed = await confirm(d);
  assert.equal(confirmed.preview.lines.length, 1);
  assert.equal(confirmed.preview.lines[0].quantity, "0.5");
  assert.equal((await getDraft(actor, d.id)).attempts, 1);
});
