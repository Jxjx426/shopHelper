import Decimal from "decimal.js";
import { convertWeight, isWeight, quantity, type OrderItem } from "./domain";
export type Thresholds = {
  small_weight_percent: string;
  large_weight_percent: string;
};
export function discrepancy(
  ordered: string,
  orderedUnit: string,
  actual: string,
  actualUnit: string,
  thresholds: Thresholds,
) {
  if (!isWeight(orderedUnit) || !isWeight(actualUnit)) return null;
  const orderedKg = new Decimal(
    convertWeight(quantity(ordered), orderedUnit, "kg"),
  );
  const actualKg = new Decimal(
    convertWeight(quantity(actual), actualUnit, "kg"),
  );
  const threshold = new Decimal(
    orderedKg.lt("0.5")
      ? thresholds.small_weight_percent
      : thresholds.large_weight_percent,
  );
  const percent = actualKg.minus(orderedKg).abs().div(orderedKg).mul(100);
  return {
    warning: percent.gt(threshold),
    percent: percent.toDecimalPlaces(2, Decimal.ROUND_UP).toString(),
    threshold: threshold.toString(),
    key: JSON.stringify([
      orderedKg.toString(),
      actualKg.toString(),
      threshold.toString(),
    ]),
    direction: actualKg.lt(orderedKg) ? "少供" : "超出",
  };
}
export function finalTotals(amounts: string[]) {
  const sum = amounts.reduce(
    (s, a) => s.plus(new Decimal(a).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)),
    new Decimal(0),
  );
  const total = sum
    .div("0.10")
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .mul("0.10");
  return {
    subtotal: sum.toFixed(2),
    rounding: total.minus(sum).toFixed(2),
    total: total.toFixed(2),
  };
}
export function itemWarning(item: OrderItem, settings: Thresholds) {
  return !item.unavailable &&
    item.actual_confirmed &&
    item.actual_quantity &&
    item.actual_unit
    ? discrepancy(
        item.ordered_quantity,
        item.ordered_unit,
        item.actual_quantity,
        item.actual_unit,
        settings,
      )
    : null;
}
