import Decimal from "decimal.js";
export class ValidationError extends Error {}

export const UNITS = ["kg", "g", "包", "箱", "粒", "条", "支"] as const;
export type Unit = (typeof UNITS)[number];
export const UNIT_LABELS: Record<Unit, string> = {
  kg: "kg 公斤",
  g: "g 克",
  包: "包 / pack",
  箱: "箱 / box",
  粒: "粒 / piece",
  条: "条",
  支: "支",
};
export const isWeight = (unit: string) => unit === "g" || unit === "kg";
export const todayMalaysia = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const money = (value: string | number | null) =>
  value === null ? "待定价" : `RM ${new Decimal(value).toFixed(2)}`;
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function quantity(value: unknown, allowZero = false): string {
  if (typeof value !== "string" || !/^\d{1,8}(\.\d{1,3})?$/.test(value.trim()))
    throw new ValidationError("请输入有效数量，最多三位小数");
  const number = new Decimal(value.trim());
  if (allowZero ? number.lt(0) : number.lte(0))
    throw new ValidationError(
      allowZero ? "数量不能小于零" : "数量必须大于零；不供货请标记缺货",
    );
  return number.toString();
}
export function price(value: unknown): string | null {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{1,7}(\.\d{1,2})?$/.test(value))
    throw new ValidationError("价格最多两位小数，不能为负数");
  return new Decimal(value).toFixed(2);
}
export function convertWeight(value: string, from: string, to: string) {
  if (!isWeight(from) || !isWeight(to))
    throw new ValidationError("只允许克与公斤自动换算");
  const amount = new Decimal(value);
  return (
    from === to ? amount : from === "g" ? amount.div(1000) : amount.mul(1000)
  ).toString();
}
export function lineAmount(
  actual: string,
  actualUnit: string,
  billingUnit: string,
  unitPrice: string,
): string {
  const normalized = isWeight(billingUnit)
    ? convertWeight(actual, actualUnit, billingUnit)
    : actualUnit === billingUnit
      ? actual
      : null;
  if (normalized === null)
    throw new ValidationError("实供单位与计价单位不兼容");
  const result = new Decimal(normalized)
    .mul(unitPrice)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  if (new Decimal(result).gt("999999999999.99"))
    throw new ValidationError("单项金额过大，请核对数量、单位与价格");
  return result;
}
export function subtotal(items: Pick<OrderItem, "amount">[]): string {
  return items
    .reduce((sum, item) => sum.plus(item.amount ?? "0"), new Decimal(0))
    .toFixed(2);
}
export function totalDemand(
  items: Pick<OrderItem, "ordered_quantity" | "ordered_unit">[],
): string {
  const totals = new Map<string, Decimal>();
  for (const item of items) {
    const unit = isWeight(item.ordered_unit) ? "kg" : item.ordered_unit;
    const amount = isWeight(item.ordered_unit)
      ? convertWeight(item.ordered_quantity, item.ordered_unit, "kg")
      : item.ordered_quantity;
    totals.set(unit, (totals.get(unit) ?? new Decimal(0)).plus(amount));
  }
  return [...totals]
    .map(([unit, amount]) => `${amount.toString()} ${unit}`)
    .join(" + ");
}
export type Zone = {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
  version: number;
};
export type Restaurant = {
  id: string;
  name: string;
  aliases: string[];
  active: boolean;
  version: number;
};
export type UnitRule = {
  orderUnit: Unit;
  billingUnit: Unit;
  price: string | null;
};
export type Product = {
  id: string;
  name: string;
  aliases: string[];
  zone_id: string;
  sort_order: number;
  active: boolean;
  version: number;
  units: UnitRule[];
};
export type OrderItem = {
  last_changed_by?: string | null;
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  zone_id: string;
  ordered_quantity: string;
  ordered_unit: Unit;
  billing_unit: Unit;
  price_snapshot: string | null;
  actual_quantity: string | null;
  actual_unit: Unit | null;
  actual_confirmed: boolean;
  unavailable: boolean;
  amount: string | null;
  version: number;
  position: number;
  picking_state: "pending" | "picked" | "unavailable";
  task_version: number;
  discrepancy_ack: string | null;
};
export type Order = {
  id: string;
  restaurant_id: string;
  restaurant_name: string;
  delivery_date: string;
  urgent: boolean;
  picking_started_at: string | null;
  version: number;
  created_at: string;
  items: OrderItem[];
  deleted_at: string | null;
  finalized_document_id: string | null;
};
export type Workspace = {
  generation: string;
  user?: import("./permissions").CurrentUser;
  shop: {
    version: number;
    name: string;
    small_weight_percent: string;
    large_weight_percent: string;
  };
  zones: Zone[];
  restaurants: Restaurant[];
  products: Product[];
  orders: Order[];
  date: string;
  restaurantPrices: {
    restaurant_id: string;
    product_id: string;
    billing_unit: Unit;
    amount: string;
    version: number;
  }[];
};
export const pickedResolved = (item: OrderItem) =>
  item.picking_state !== "pending";
export const billedResolved = (item: OrderItem) =>
  item.unavailable || (item.actual_confirmed && item.price_snapshot !== null);
