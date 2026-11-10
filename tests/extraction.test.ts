import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReview,
  extractionSchema,
  matchProduct,
  normalizeUnit,
  parseTextLocally,
  type ExtractionResult,
} from "../src/lib/extraction";
import {
  extractionConfig,
  ExtractionFailure,
  GeminiExtractionProvider,
} from "../src/lib/gemini.server";
import type { Product } from "../src/lib/domain";
import { preparedImageSize } from "../src/lib/image-limits";
const product = (
  id: string,
  name: string,
  aliases: string[] = [],
): Product => ({
  id,
  name,
  aliases,
  active: true,
  zone_id: "zone",
  sort_order: 1,
  version: 1,
  units: [
    { orderUnit: "kg", billingUnit: "kg", price: "6.00" },
    { orderUnit: "粒", billingUnit: "粒", price: "2.00" },
  ],
});
const catalog = [
  product("timun", "Timun"),
  product("japanese", "日本 Timun", ["日本timun"]),
  product("cabbage", "包菜", ["Gobis"]),
  product("ambiguous", "大包菜", ["Gobis"]),
];
const result = (
  lines: Partial<ExtractionResult["lines"][number]>[],
): ExtractionResult => ({
  detectedRestaurant: null,
  unreadableContent: false,
  lines: lines.map((l, i) => ({
    sourceLine: i + 1,
    sourceText: "",
    productText: null,
    quantity: null,
    unitText: null,
    uncertain: false,
    ...l,
  })),
});
test("canonical names and aliases never merge distinct Timun products or choose an ambiguous alias", () => {
  assert.equal(matchProduct("Timun", catalog).id, "timun");
  assert.equal(matchProduct("日本timun", catalog).id, "japanese");
  assert.equal(matchProduct("Gobis", catalog).id, "");
  assert.equal(matchProduct("Gobis", catalog).by, "ambiguous");
  assert.equal(matchProduct("Japanese Timun", catalog).id, "");
  assert.equal(matchProduct("Japanese Timun", catalog).by, "suggested");
});

test("local parsing uses exact saved aliases and literal quantities without guessing incomplete fields", () => {
  const lines = parseTextLocally(
    "Timun 2kg\n日本timun 500g\nGobis 1kg\n青龙菜1.\nTimun 2\nUnknown 3 box",
    catalog,
  );
  assert.equal(lines[0].productId, "timun");
  assert.equal(lines[0].quantity, "2");
  assert.equal(lines[0].reviewed, false);
  assert.equal(lines[1].productId, "japanese");
  assert.equal(lines[1].unit, "kg");
  assert.equal(lines[1].quantity, "0.5");
  assert.equal(lines[2].productId, "");
  assert.equal(lines[2].matchedBy, "ambiguous");
  assert.equal(lines[3].quantity, "");
  assert.equal(lines[3].unit, "");
  assert.equal(lines[4].quantity, "2");
  assert.equal(lines[4].unit, "");
  assert.equal(lines[5].productId, "");
  assert.equal(lines[5].quantity, "3");
  assert.equal(lines[5].unit, "箱");
});

test("prepared screenshots downsize without upscaling or making long screenshots too narrow", () => {
  assert.deepEqual(preparedImageSize(3000, 6000), {
    width: 1600,
    height: 3200,
  });
  assert.deepEqual(preparedImageSize(1080, 8000), {
    width: 1080,
    height: 8000,
  });
  assert.deepEqual(preparedImageSize(800, 600), { width: 800, height: 600 });
  assert.throws(() => preparedImageSize(1000, 20000), /截图太长/);
});
test("every pasted nonempty line remains visible even if Gemini omitted a header or unreadable line", () => {
  const raw = result([
    {
      sourceLine: 2,
      sourceText: "Timun 2kg",
      productText: "Timun",
      quantity: "2",
      unitText: "kg",
    },
  ]);
  const lines = buildReview(raw, "fukumiya\nTimun 2kg\n\n看不清的菜?", catalog);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].sourceText, "fukumiya");
  assert.equal(lines[2].sourceText, "看不清的菜?");
  assert(lines.every((l) => !l.reviewed));
  assert.equal(lines[1].productId, "timun");
});
test("incomplete quantities, invented products and guessed units remain unresolved", () => {
  const raw = result([
    {
      sourceText: "青龙菜1.",
      productText: "青龙菜",
      quantity: "1",
      unitText: "kg",
    },
    { sourceText: "包菜1", productText: "包菜", quantity: "1", unitText: "包" },
    {
      sourceText: "Timun 2kg",
      productText: "日本 Timun",
      quantity: "8",
      unitText: "kg",
    },
  ]);
  const lines = buildReview(raw, "青龙菜1.\n包菜1\nTimun 2kg", catalog);
  assert.equal(lines[0].quantity, "");
  assert.equal(lines[0].unit, "");
  assert.equal(lines[1].unit, "");
  assert.equal(lines[2].productId, "");
  assert.equal(lines[2].quantity, "");
});
test("mixed-language unit labels normalize while original text and independent units remain", () => {
  const raw = result([
    {
      sourceText: "包菜3biji",
      productText: "包菜",
      quantity: "3",
      unitText: "biji",
    },
    {
      sourceText: "Timun 300g",
      productText: "Timun",
      quantity: "300",
      unitText: "g",
    },
  ]);
  const lines = buildReview(raw, null, catalog);
  assert.equal(lines[0].unit, "粒");
  assert.equal(lines[0].sourceText, "包菜3biji");
  assert.equal(lines[1].unit, "kg");
  assert.equal(lines[1].quantity, "0.3");
  assert.equal(normalizeUnit("batang"), "");
  assert.equal(normalizeUnit("box"), "箱");
});
test("structured schema rejects AI prices, unknown fields, numeric quantities and malformed output", () => {
  assert.equal(
    extractionSchema.safeParse({ ...result([]), price: 0 }).success,
    false,
  );
  assert.equal(
    extractionSchema.safeParse(result([{ quantity: 2 as unknown as string }]))
      .success,
    false,
  );
  assert.equal(extractionSchema.safeParse({ lines: [] }).success, false);
});
async function configTest(work: () => Promise<void>) {
  const saved = {
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
    confirmed: process.env.GEMINI_FREE_TIER_CONFIRMED,
  };
  process.env.GEMINI_API_KEY = "synthetic-test-key-never-real";
  process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
  process.env.GEMINI_FREE_TIER_CONFIRMED = "true";
  try {
    await work();
  } finally {
    for (const [key, value] of Object.entries({
      GEMINI_API_KEY: saved.key,
      GEMINI_MODEL: saved.model,
      GEMINI_FREE_TIER_CONFIRMED: saved.confirmed,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
test("provider uses pinned Gemini REST JSON schema with a header-only key and no catalog/prices", () =>
  configTest(async () => {
    let calls = 0;
    const provider = new GeminiExtractionProvider(async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
      );
      assert(!String(url).includes("synthetic-test-key"));
      assert.equal(
        (init!.headers as Record<string, string>)["x-goog-api-key"],
        process.env.GEMINI_API_KEY,
      );
      const body = JSON.parse(String(init!.body));
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert(body.generationConfig.responseJsonSchema);
      assert.equal(body.tools, undefined);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify(
                      result([
                        {
                          sourceText: "Timun 2kg",
                          productText: "Timun",
                          quantity: "2",
                          unitText: "kg",
                        },
                      ]),
                    ),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    const output = await provider.extract({ kind: "text", text: "Timun 2kg" });
    assert.equal(output.lines[0].quantity, "2");
    assert.equal(calls, 1);
  }));
test("provider accepts image input and sends only the given prepared bytes", () =>
  configTest(async () => {
    const provider = new GeminiExtractionProvider(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.deepEqual(body.contents[0].parts[1].inlineData, {
        mimeType: "image/png",
        data: Buffer.from("prepared-only").toString("base64"),
      });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify(result([{ sourceText: "Timun 2kg" }])),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    await provider.extract({
      kind: "image",
      data: Buffer.from("prepared-only"),
      mimeType: "image/png",
    });
  }));
test("quota failure makes exactly one request, exposes no provider error body, and never switches models", () =>
  configTest(async () => {
    let calls = 0;
    const provider = new GeminiExtractionProvider(async () => {
      calls++;
      return new Response("sensitive-provider-debug", {
        status: 429,
        headers: { "retry-after": "120" },
      });
    });
    await assert.rejects(
      provider.extract({ kind: "text", text: "test" }),
      (e: unknown) =>
        e instanceof ExtractionFailure &&
        e.code === "quota" &&
        e.cooldownSeconds === 120 &&
        !e.message.includes("sensitive"),
    );
    assert.equal(calls, 1);
  }));
test("missing key, paid/unverified model, and unconfirmed free project prevent every external request", () =>
  configTest(async () => {
    let calls = 0;
    const provider = new GeminiExtractionProvider(async () => {
      calls++;
      throw new Error("must not call");
    });
    delete process.env.GEMINI_API_KEY;
    assert.equal(extractionConfig().enabled, false);
    await assert.rejects(provider.extract({ kind: "text", text: "test" }));
    process.env.GEMINI_API_KEY = "synthetic";
    process.env.GEMINI_MODEL = "paid-only-model";
    await assert.rejects(provider.extract({ kind: "text", text: "test" }));
    process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
    process.env.GEMINI_FREE_TIER_CONFIRMED = "false";
    await assert.rejects(provider.extract({ kind: "text", text: "test" }));
    assert.equal(calls, 0);
  }));
test("truncation, refusal, invalid JSON and network failures preserve failure semantics without retry", () =>
  configTest(async () => {
    for (const envelope of [
      { candidates: [{ finishReason: "MAX_TOKENS" }] },
      { candidates: [{ finishReason: "SAFETY" }] },
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "not json" }] } },
        ],
      },
    ]) {
      let calls = 0;
      const provider = new GeminiExtractionProvider(async () => {
        calls++;
        return new Response(JSON.stringify(envelope));
      });
      await assert.rejects(provider.extract({ kind: "text", text: "test" }));
      assert.equal(calls, 1);
    }
    let calls = 0;
    const provider = new GeminiExtractionProvider(async () => {
      calls++;
      throw new Error("secret network diagnostics");
    });
    await assert.rejects(
      provider.extract({ kind: "text", text: "test" }),
      /连接失败/,
    );
    assert.equal(calls, 1);
  }));
import { lineProblems } from "../src/lib/extraction";
const single = (
  id: string,
  name: string,
  aliases: string[],
  unit: "kg" | "包" | "粒",
) => ({
  ...product(id, name, aliases),
  units: [{ orderUnit: unit, billingUnit: unit, price: "1.00" }],
});
const shopCatalog = [
  single("jp", "日本黄瓜", ["日本timun"], "kg"),
  single("cu", "黄瓜", ["cucumber"], "kg"),
  single("sh", "白玉菇", ["shimeji mushroom"], "包"),
  single("en", "金针菇", ["enoki", "enoki mushroom"], "包"),
  single("to", "豆腐", ["tofu"], "粒"),
  single("ch", "Cherry tomato", ["小番茄"], "kg"),
  single("ok", "羊角豆", ["okra"], "kg"),
  single("ka", "芥兰", ["kale"], "包"),
  single("gr", "青龙菜", ["Green dragon cabbage"], "包"),
  single("ca", "包菜", ["cabbage"], "粒"),
];
test("the shop's seven-line pasted order fills literal quantities and unique saved units without AI", () => {
  const lines = parseTextLocally(
    "大福屋\n日本黄瓜 2kg\n黄瓜 2kg\n白玉菇 5\nenoki 6\ntofu 5\ncherry tomato 1kg\n羊角豆 1kg",
    shopCatalog,
  );
  assert.deepEqual(
    lines.slice(1).map((l) => [l.productId, l.quantity, l.unit]),
    [
      ["jp", "2", "kg"],
      ["cu", "2", "kg"],
      ["sh", "5", "包"],
      ["en", "6", "包"],
      ["to", "5", "粒"],
      ["ch", "1", "kg"],
      ["ok", "1", "kg"],
    ],
  );
  assert(
    lines
      .slice(1)
      .every(
        (l) =>
          !l.reviewed &&
          !lineProblems(l, shopCatalog).length &&
          !l.extractionIssues.length,
      ),
  );
  assert(lines.slice(3, 6).every((l) => l.unitNote === "沿用商品已设单位"));
  assert.equal(lines[0].quantity, "");
});
test("bilingual table rows retain right-column quantities, normalize pkt/pcs, convert g with code, and separate blank cells", () => {
  const rows = [
    ["包菜 Cabbage", "1pcs", "ca", "1", "粒"],
    ["芥兰 Kale", "8pkt", "ka", "8", "包"],
    ["青龙菜 Green Dragon Cabbage", "3pkt", "gr", "3", "包"],
    ["本地黄瓜 Cucumber", "500g", "cu", "0.5", "kg"],
    ["日本黄瓜 Japanese Cucumber", "500g", "jp", "0.5", "kg"],
  ];
  const raw = result(
    rows.map(([label, cell]) => ({
      sourceText: label,
      productText: label,
      quantityText: cell,
      quantityStatus: "present",
    })),
  );
  raw.lines.push({
    ...result([
      {
        sourceText: "玻璃生菜 Ice Berg Lettuce",
        productText: "玻璃生菜 Ice Berg Lettuce",
        quantityStatus: "blank",
      },
    ]).lines[0],
    sourceLine: 6,
  });
  raw.lines.push({
    ...result([
      {
        sourceText: "香菜 [看不清数量]",
        productText: "香菜",
        quantityStatus: "unreadable",
        uncertain: true,
      },
    ]).lines[0],
    sourceLine: 7,
  });
  const lines = buildReview(raw, null, shopCatalog);
  assert.deepEqual(
    lines.slice(0, 5).map((l) => [l.productId, l.quantity, l.unit]),
    rows.map((r) => r.slice(2)),
  );
  assert(
    lines
      .slice(0, 5)
      .every(
        (l) =>
          !lineProblems(l, shopCatalog).length && !l.extractionIssues.length,
      ),
  );
  assert.equal(lines[5].disposition, "ignored");
  assert.equal(lines[5].reviewed, false);
  assert.equal(lines[6].disposition, "item");
  assert(lines[6].extractionIssues.length);
  assert.equal(lines[3].sourceText, "本地黄瓜 Cucumber 500g");
});
test("missing units are never taken from ambiguous units, explicit unsupported labels, or contradictory bilingual names", () => {
  const lines = parseTextLocally(
    "Timun 2\n白玉菇 5lb\n白玉菇1.\n白玉菇\n日本黄瓜 Cucumber 2kg",
    [...catalog, ...shopCatalog],
  );
  assert.equal(lines[0].quantity, "2");
  assert.equal(lines[0].unit, "");
  assert.equal(lines[1].unit, "");
  assert.equal(lines[2].quantity, "");
  assert.equal(lines[3].quantity, "");
  assert.equal(lines[4].productId, "");
  assert.equal(lines[4].matchedBy, "ambiguous");
});
test("an asserted blank quantity never hides conflicting numeric or unreadable evidence", () => {
  const lines = buildReview(
    result([
      {
        sourceText: "包菜 Cabbage 2",
        productText: "包菜 Cabbage",
        quantityStatus: "blank",
      },
      {
        sourceText: "芥兰 Kale",
        productText: "芥兰 Kale",
        quantityStatus: "blank",
        uncertain: true,
      },
      {
        sourceText: "芥兰 Kale 8pkt",
        productText: "芥兰 Kale",
        quantityText: "8pkt",
        quantityStatus: "unreadable",
        uncertain: false,
      },
    ]),
    null,
    shopCatalog,
  );
  assert(lines.every((l) => l.disposition === "item"));
  assert(lines[2].extractionIssues.length > 0);
});
test("long unmatched source lines remain recoverable and weight conversion never rounds unsupported precision", () => {
  const source = "聊天备注".repeat(40);
  const lines = parseTextLocally(`${source}\n黄瓜 0.5g`, shopCatalog);
  assert.equal(lines[0].sourceText, source);
  assert.equal(lines[0].productText, "");
  assert.equal(lines[1].quantity, "0.5");
  assert.equal(lines[1].unit, "g");
  assert(lines[1].extractionIssues.length > 0);
  assert(lineProblems(lines[1], shopCatalog).length > 0);
});
