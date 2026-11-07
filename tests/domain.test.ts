import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertWeight,
  lineAmount,
  price,
  quantity,
  subtotal,
  totalDemand,
  validDate,
} from "../src/lib/domain";

test("decimal-safe line amounts match the PRD and round each line half-up", () => {
  assert.equal(lineAmount("2.08", "kg", "kg", "6.00"), "12.48");
  assert.equal(lineAmount("300", "g", "kg", "10.00"), "3.00");
  assert.equal(lineAmount("1.005", "kg", "kg", "1.00"), "1.01");
  assert.equal(lineAmount("2", "箱", "箱", "12.35"), "24.70");
  assert.equal(
    subtotal([{ amount: "1.01" }, { amount: "2.01" }, { amount: null }]),
    "3.02",
  );
});
test("only compatible weights convert and incompatible demand remains separate", () => {
  assert.equal(convertWeight("300", "g", "kg"), "0.3");
  assert.equal(convertWeight("2.08", "kg", "g"), "2080");
  assert.throws(() => convertWeight("1", "箱", "kg"));
  assert.throws(() => lineAmount("1", "箱", "kg", "5"));
  assert.equal(
    totalDemand([
      { ordered_quantity: "300", ordered_unit: "g" },
      { ordered_quantity: "2", ordered_unit: "kg" },
      { ordered_quantity: "1", ordered_unit: "箱" },
    ]),
    "2.3 kg + 1 箱",
  );
});
test("blank, zero, negative, excessive precision and unsafe numeric inputs are rejected", () => {
  for (const input of [
    "",
    " ",
    "0",
    "-1",
    "1.0001",
    "1e3",
    "Infinity",
    "NaN",
    "100000000",
    1,
  ])
    assert.throws(() => quantity(input));
  assert.equal(quantity("2.080"), "2.08");
  assert.equal(price(""), null);
  assert.equal(price("0"), "0.00");
  assert.throws(() => price("1.001"));
  assert.throws(() => price("-1"));
});
test("dates reject rollover and invalid delivery-date syntax", () => {
  assert.equal(validDate("2026-11-07"), true);
  for (const value of ["2026-02-30", "2026-13-01", "2026-1-1", "not-a-date"])
    assert.equal(validDate(value), false);
});
