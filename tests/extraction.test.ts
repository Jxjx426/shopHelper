import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReview,
  extractionSchema,
  matchProduct,
  normalizeUnit,
  type ExtractionResult,
} from "../src/lib/extraction";
import {
  extractionConfig,
  ExtractionFailure,
  GeminiExtractionProvider,
} from "../src/lib/gemini.server";
import type { Product } from "../src/lib/domain";
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
  assert.equal(lines[1].unit, "g");
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
