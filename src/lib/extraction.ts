import { z } from "zod";
import {
  convertWeight,
  isWeight,
  quantity,
  type Product,
  type Unit,
} from "./domain";
import { normalizeName, type ReviewLine } from "./import-types";

export const extractionSchema = z
  .object({
    detectedRestaurant: z.string().max(100).nullable(),
    unreadableContent: z.boolean(),
    lines: z
      .array(
        z
          .object({
            sourceLine: z.number().int().min(1).max(200),
            sourceText: z.string().max(3000),
            productText: z.string().max(100).nullable(),
            quantity: z.string().max(30).nullable(),
            unitText: z.string().max(30).nullable(),
            uncertain: z.boolean(),
            quantityText: z.string().max(100).nullable().optional(),
            quantityStatus: z
              .enum(["present", "blank", "unreadable"])
              .optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type ExtractionResult = z.infer<typeof extractionSchema>;
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    detectedRestaurant: { type: ["string", "null"] },
    unreadableContent: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceLine: { type: "integer" },
          sourceText: { type: "string" },
          productText: { type: ["string", "null"] },
          quantity: { type: ["string", "null"] },
          unitText: { type: ["string", "null"] },
          uncertain: { type: "boolean" },
          quantityText: { type: ["string", "null"] },
          quantityStatus: {
            type: "string",
            enum: ["present", "blank", "unreadable"],
          },
        },
        required: [
          "sourceLine",
          "sourceText",
          "productText",
          "quantity",
          "unitText",
          "uncertain",
          "quantityText",
          "quantityStatus",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["detectedRestaurant", "unreadableContent", "lines"],
  additionalProperties: false,
};
const equivalents: Record<string, Unit> = {
  kg: "kg",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  公斤: "kg",
  千克: "kg",
  g: "g",
  gram: "g",
  grams: "g",
  克: "g",
  包: "包",
  pack: "包",
  packs: "包",
  pkt: "包",
  pkts: "包",
  packet: "包",
  packets: "包",
  箱: "箱",
  box: "箱",
  boxes: "箱",
  粒: "粒",
  piece: "粒",
  pieces: "粒",
  pcs: "粒",
  pc: "粒",
  biji: "粒",
  条: "条",
  支: "支",
};
export const normalizeUnit = (value: string | null): Unit | "" =>
  value ? (equivalents[normalizeName(value)] ?? "") : "";
export function sourceLines(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter((l) => l.text.length > 0);
}

/** Parse one literal requirement; missing units may use a unique saved unit. */
export function parseTextLocally(
  text: string,
  products: Product[],
): ReviewLine[] {
  const units = Object.keys(equivalents)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const pattern = new RegExp(
    `^([^\\d]+?)\\s*(?:[x×:：]\\s*)?(\\d+(?:\\.\\d+)?)\\s*(${units})?$`,
    "iu",
  );
  return buildReview(
    {
      detectedRestaurant: null,
      unreadableContent: false,
      lines: sourceLines(text).map(({ text: source, line }) => {
        const match = source.match(pattern);
        const label = match?.[1].trim() ?? source;
        return {
          sourceLine: line,
          sourceText: source,
          productText: label.length <= 100 ? label : null,
          quantity: match?.[2] ?? null,
          unitText: match?.[3] ?? null,
          uncertain: false,
        };
      }),
    },
    text,
    products,
  );
}

export function matchProduct(
  term: string,
  products: Product[],
): { id: string; by: ReviewLine["matchedBy"]; candidates: string[] } {
  const normalized = normalizeName(term);
  if (!normalized) return { id: "", by: "unknown", candidates: [] };
  const active = products.filter((p) => p.active);
  const names = active.filter((p) => normalizeName(p.name) === normalized);
  if (names.length === 1)
    return { id: names[0].id, by: "name", candidates: [names[0].id] };
  const aliases = active.filter((p) =>
    p.aliases.some((a) => normalizeName(a) === normalized),
  );
  if (aliases.length === 1)
    return { id: aliases[0].id, by: "alias", candidates: [aliases[0].id] };
  if (aliases.length > 1)
    return { id: "", by: "ambiguous", candidates: aliases.map((p) => p.id) };
  // A bilingual label is one product, not a substring match (黄瓜 ≠ 日本黄瓜).
  if (/\p{Script=Han}/u.test(normalized) && /[a-z]/i.test(normalized)) {
    const fragments = [
      normalized.replace(/[a-z][a-z\s'-]*/gi, " ").trim(),
      normalized
        .replace(/[^a-z\s'-]/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ];
    const matches = active.filter((p) =>
      fragments.some(
        (part) =>
          part &&
          [p.name, ...p.aliases].some((name) => normalizeName(name) === part),
      ),
    );
    if (matches.length === 1)
      return { id: matches[0].id, by: "alias", candidates: [matches[0].id] };
    if (matches.length > 1)
      return { id: "", by: "ambiguous", candidates: matches.map((p) => p.id) };
  }
  // Suggestions never choose a product, including similar Timun varieties.
  const suggestions = active
    .filter((p) =>
      [p.name, ...p.aliases].some((name) => {
        const candidate = normalizeName(name);
        return (
          normalized.length >= 2 &&
          (candidate.includes(normalized) || normalized.includes(candidate))
        );
      }),
    )
    .slice(0, 5);
  return {
    id: "",
    by: suggestions.length ? "suggested" : "unknown",
    candidates: suggestions.map((p) => p.id),
  };
}
export function blankLine(
  sourceText = "",
  sourceLine = 0,
  id = `manual-${Date.now()}`,
): ReviewLine {
  return {
    id,
    sourceLine,
    sourceText,
    productText: "",
    productId: "",
    quantity: "",
    unit: "",
    matchedBy: "manual",
    candidates: [],
    extractionIssues: [],
    disposition: "item",
    ignoreReason: "",
    reviewed: false,
    saveAlias: false,
  };
}
function literalQuantity(value: string, source: string): boolean {
  const tokens = source.match(/\d+(?:\.\d+)?/g) ?? [];
  return tokens.some((token) => {
    try {
      return quantity(token) === quantity(value);
    } catch {
      return false;
    }
  });
}
export function buildReview(
  result: ExtractionResult,
  text: string | null,
  products: Product[],
): ReviewLine[] {
  const originals = text === null ? null : sourceLines(text);
  const proposals: {
    raw: ExtractionResult["lines"][number] | null;
    source: string;
    line: number;
  }[] = [];
  if (originals) {
    for (const original of originals) {
      const entries = result.lines.filter(
        (line) => line.sourceLine === original.line,
      );
      if (!entries.length)
        proposals.push({
          raw: null,
          source: original.text,
          line: original.line,
        });
      else
        for (const raw of entries)
          proposals.push({ raw, source: original.text, line: original.line });
    }
  } else
    result.lines.forEach((raw) =>
      proposals.push({
        raw,
        source:
          raw.quantityText && !raw.sourceText.includes(raw.quantityText)
            ? `${raw.sourceText} ${raw.quantityText}`
            : raw.sourceText,
        line: raw.sourceLine,
      }),
    );
  return proposals.map(({ raw, source, line }, index) => {
    const entry = blankLine(source, line, `line-${index + 1}`);
    if (!raw) {
      entry.extractionIssues.push("此原文行未被模型识别，请手动处理或明确忽略");
      return entry;
    }
    if (
      text === null &&
      raw.quantityStatus === "blank" &&
      !raw.uncertain &&
      !raw.quantity &&
      !raw.unitText &&
      !raw.quantityText?.trim() &&
      !/\d/.test(source) &&
      !/[?？]|unreadable|看不清|无法辨认|模糊/i.test(source)
    ) {
      entry.productText = raw.productText ?? "";
      entry.disposition = "ignored";
      entry.ignoreReason = "数量栏空白，本次未订购";
      return entry;
    }
    const evidence = normalizeName(source);
    const productText = raw.productText ?? "";
    entry.productText = productText;
    const issues: string[] = [];
    if (originals && normalizeName(raw.sourceText) !== evidence)
      issues.push("模型原文与粘贴内容不一致，请逐项核对");
    const groundedProduct =
      productText && evidence.includes(normalizeName(productText));
    const match = matchProduct(groundedProduct ? productText : "", products);
    entry.productId = match.id;
    entry.matchedBy = match.by;
    entry.candidates = match.candidates;
    if (productText && !groundedProduct)
      issues.push("商品文字无法在原文中核实，请手动选择");
    // Prefer the literal quantity cell, never a model-converted quantity/unit.
    const cell =
      text === null && raw.quantityText?.trim()
        ? raw.quantityText.trim().match(/^(\d+(?:\.\d+)?)\s*([^\d\s]+)?$/u)
        : null;
    const rawQuantity = cell?.[1] ?? raw.quantity;
    const rawUnit = cell ? (cell[2] ?? null) : raw.unitText;
    if (rawQuantity) {
      try {
        const q = quantity(rawQuantity);
        if (!literalQuantity(q, source) || /\d+\.(?!\d)|\d+,\d/.test(source))
          issues.push("数量不完整或无法核实，请手动填写");
        else entry.quantity = q;
      } catch {
        issues.push("数量无效，请手动填写");
      }
    }
    const normalized = normalizeUnit(rawUnit);
    const unitLiteral = rawUnit
      ? normalizeName(rawUnit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : "";
    const unitEvidence =
      unitLiteral &&
      new RegExp(
        `(?:\\d\\s*${unitLiteral}(?![a-z])|(?<![a-z])${unitLiteral}\\s*\\d)`,
        "iu",
      ).test(evidence);
    if (normalized && unitEvidence) entry.unit = normalized;
    else if (rawUnit) issues.push("单位无法核实或无法换算，请手动选择");
    const product = products.find((p) => p.id === entry.productId);
    const units = [...new Set(product?.units.map((u) => u.orderUnit) ?? [])];
    if (
      !entry.unit &&
      !rawUnit &&
      entry.quantity &&
      units.length === 1 &&
      new RegExp(`\\d(?:\\.\\d+)?\\s*$`).test(source)
    ) {
      entry.unit = units[0];
      entry.unitNote = "沿用商品已设单位";
    }
    if (
      entry.quantity &&
      isWeight(entry.unit) &&
      !units.includes(entry.unit as Unit)
    ) {
      const weights = units.filter(isWeight);
      if (weights.length === 1) {
        const original = `${entry.quantity} ${entry.unit}`;
        try {
          const converted = quantity(
            convertWeight(entry.quantity, entry.unit, weights[0]),
          );
          entry.quantity = converted;
          entry.unit = weights[0];
          entry.unitNote = `原单 ${original}`;
        } catch {
          issues.push("重量换算超出数量范围，请手动核对");
        }
      }
    }
    if (entry.unit && !isWeight(entry.unit) && entry.quantity.includes(".")) {
      entry.quantity = "";
      issues.push("按件商品的数量需要人工确认");
    }
    if (raw.uncertain || raw.quantityStatus === "unreadable")
      issues.push("模型标记内容不确定，请对照原文核对");
    entry.extractionIssues = issues;
    return entry;
  });
}
export function lineProblems(line: ReviewLine, products: Product[]): string[] {
  if (line.disposition === "ignored")
    return line.ignoreReason.trim() ? [] : ["请填写忽略原因"];
  const errors: string[] = [];
  const product = products.find((p) => p.id === line.productId && p.active);
  if (!product) errors.push("请选择商品");
  try {
    quantity(line.quantity);
  } catch {
    errors.push("请填写有效数量");
  }
  if (!line.unit) errors.push("请选择订购单位");
  else if (product && !product.units.some((u) => u.orderUnit === line.unit))
    errors.push("商品未设置此订购单位");
  if (
    line.unit &&
    !isWeight(line.unit) &&
    line.quantity &&
    Number(line.quantity) % 1 !== 0
  )
    errors.push("按件数量必须是整数");
  return errors;
}
