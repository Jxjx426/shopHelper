// Exactly one text and one synthetic screenshot request. No business data.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { getDb } from "../src/lib/db";
import {
  createImport,
  extractDraft,
  getDraft,
} from "../src/lib/imports.server";
import { extractionConfig } from "../src/lib/gemini.server";
import { PRIVACY_VERSION } from "../src/lib/import-types";
const environmentRequire = createRequire(
  path.join(process.cwd(), "package.json"),
);
environmentRequire("@next/env").loadEnvConfig(process.cwd(), false, {
  info() {},
  error() {},
});
const config = extractionConfig();
if (!config.enabled) throw new Error(config.reason);
process.env.SHOP_DATA_DIR = path.join(
  process.cwd(),
  "test-results",
  `live-gemini-${randomUUID()}`,
);
async function main() {
  let requests = 0;
  try {
    const db = await getDb(),
      actor = randomUUID(),
      restaurant = randomUUID();
    await db.query(
      "INSERT INTO users(id,name,password_hash) VALUES($1,'匿名测试','not-a-login-hash')",
      [actor],
    );
    await db.query(
      "INSERT INTO restaurants(id,name) VALUES($1,'匿名测试，不是营业数据')",
      [restaurant],
    );
    const text = "Timun 2kg\nCarrot 1box\nUnknown veg 1.";
    const image = await sharp(
      Buffer.from(
        '<svg width="900" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="500" fill="white"/><text x="45" y="100" font-family="Arial" font-size="48" fill="black">Timun 2kg</text><text x="45" y="210" font-family="Arial" font-size="48" fill="black">Carrot 1box</text><text x="45" y="320" font-family="Arial" font-size="48" fill="black">Unknown veg 1.</text></svg>',
      ),
    )
      .png()
      .toBuffer();
    for (const kind of ["text", "image"] as const) {
      const payload = { mime: "image/png", base64: image.toString("base64") };
      const { id } = await createImport(actor, randomUUID(), {
        restaurantId: restaurant,
        date: "2026-11-08",
        kind,
        ...(kind === "text"
          ? { text }
          : { original: payload, prepared: payload }),
      });
      requests++;
      const result = await extractDraft(actor, id, randomUUID(), {
        version: 1,
        privacyVersion: PRIVACY_VERSION,
        redacted: true,
        replaceExisting: false,
      });
      const draft = await getDraft(actor, id);
      if ("error" in result || draft.status !== "review")
        throw new Error(
          draft.error_message ??
            ("error" in result ? result.error : "识别未完成"),
        );
      assert(
        draft.lines.length >= 3,
        "Every synthetic input line must remain visible",
      );
      const timun = draft.lines.find((line) =>
        line.sourceText.toLowerCase().includes("timun"),
      );
      assert(timun, "Timun line missing");
      assert.equal(timun.quantity, "2");
      assert.equal(timun.unit, "kg");
      const ambiguous = draft.lines.find((line) =>
        line.sourceText.toLowerCase().includes("unknown"),
      );
      assert(ambiguous, "Ambiguous line must remain visible");
      assert.equal(ambiguous.quantity, "");
      assert.equal(ambiguous.unit, "");
      assert(draft.lines.every((line) => !line.reviewed));
      console.log(
        `${kind}: live Gemini structured extraction and server uncertainty validation passed; nothing confirmed into picking.`,
      );
    }
    console.log(
      `Live checks passed with ${config.model}: ${requests} anonymous requests. No real orders, catalogs, prices or personal information were sent.`,
    );
  } finally {
    if (globalThis.shopDatabase) {
      await (await globalThis.shopDatabase).close();
      globalThis.shopDatabase = undefined;
    }
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Live Gemini validation failed",
  );
  process.exitCode = 1;
});
