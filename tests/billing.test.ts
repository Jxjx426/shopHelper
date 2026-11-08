import { test } from "node:test";
import assert from "node:assert/strict";
import { discrepancy, finalTotals } from "../src/lib/billing";
import { lineAmount } from "../src/lib/domain";
const settings = { small_weight_percent: "20", large_weight_percent: "10" };
test("weight warnings use ordered weight, strict boundaries, both directions and equivalent g/kg", () => {
  for (const [ordered, unit, actual, actualUnit, warn, threshold] of [
    ["300", "g", "360", "g", false, "20"],
    ["300", "g", "360.001", "g", true, "20"],
    ["300", "g", "240", "g", false, "20"],
    ["300", "g", "239.999", "g", true, "20"],
    ["499.999", "g", "550", "g", false, "20"],
    ["500", "g", "550", "g", false, "10"],
    ["500", "g", "550.001", "g", true, "10"],
    ["0.5", "kg", "0.45", "kg", false, "10"],
    ["0.5", "kg", "449.999", "g", true, "10"],
    ["2", "kg", "2.08", "kg", false, "10"],
    ["300", "g", "370", "g", true, "20"],
    ["500", "g", "560", "g", true, "10"],
  ] as const) {
    const result = discrepancy(ordered, unit, actual, actualUnit, settings)!;
    assert.equal(result.warning, warn);
    assert.equal(result.threshold, threshold);
  }
  assert.equal(discrepancy("2", "粒", "2", "kg", settings), null);
  assert.throws(() => discrepancy("0", "kg", "2", "kg", settings));
  assert.throws(() => discrepancy("2", "kg", "-1", "kg", settings));
});
test("rounding happens on each line to cents, then once to ten cents with half-up ties", () => {
  for (const [subtotal, total, rounding] of [
    ["103.24", "103.20", "-0.04"],
    ["103.25", "103.30", "0.05"],
    ["103.27", "103.30", "0.03"],
    ["0.04", "0.00", "-0.04"],
    ["0.05", "0.10", "0.05"],
    ["0", "0.00", "0.00"],
  ] as const)
    assert.deepEqual(finalTotals([subtotal]), {
      subtotal: Number(subtotal).toFixed(2),
      total,
      rounding,
    });
  assert.equal(lineAmount("0.005", "kg", "kg", "1.00"), "0.01");
  assert.equal(
    finalTotals([
      lineAmount("0.005", "kg", "kg", "1.00"),
      lineAmount("0.005", "kg", "kg", "1.00"),
    ]).subtotal,
    "0.02",
  );
  assert.equal(
    finalTotals(Array(200).fill("999999999999.99")).total,
    "199999999999998.00",
  );
  assert.throws(
    () => lineAmount("99999999", "kg", "kg", "9999999.99"),
    /金额过大/,
  );
});
