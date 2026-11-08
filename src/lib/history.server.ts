import { getDb } from "./db";
import { loadOrder } from "./documents.server";
import { AppError } from "./errors";
import { validDate } from "./domain";
import type { Order, Unit } from "./domain";
import type { Transaction } from "./db";
import { digest } from "./documents.server";
import { resolvePrice } from "./pricing.server";
export async function copyPlan(tx: Transaction, id: string, date: string) {
  if (!validDate(date)) throw new AppError("请选择有效目标日期");
  const source = await loadOrder(tx, id, true);
  const target =
    (
      await tx.query<Order>(
        "SELECT * FROM orders WHERE restaurant_id=$1 AND delivery_date=$2::date AND deleted_at IS NULL",
        [source.restaurant_id, date],
      )
    ).rows[0] ?? null;
  const items = [];
  for (const item of source.items) {
    const p = (
      await tx.query<{ name: string; active: boolean }>(
        "SELECT name,active FROM products WHERE id=$1",
        [item.product_id],
      )
    ).rows[0];
    const rule = (
      await tx.query<{ billing_unit: Unit }>(
        "SELECT billing_unit FROM product_units WHERE product_id=$1 AND order_unit=$2",
        [item.product_id, item.ordered_unit],
      )
    ).rows[0];
    items.push({
      productId: item.product_id,
      name: p?.name ?? item.product_name,
      active: !!p?.active,
      quantity: item.ordered_quantity,
      unit: item.ordered_unit,
      billingUnit: rule?.billing_unit ?? null,
      price: rule
        ? await resolvePrice(
            tx,
            source.restaurant_id,
            item.product_id,
            rule.billing_unit,
          )
        : null,
    });
  }
  const token = digest(
    JSON.stringify([
      source.id,
      source.version,
      date,
      target?.id,
      target?.version,
      items,
    ]),
  );
  return { source, target, items, token, date };
}
export async function copyPreview(id: string, date: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const plan = await copyPlan(tx, id, date);
    return {
      sourceVersion: plan.source.version,
      restaurantName: plan.source.restaurant_name,
      target: plan.target,
      items: plan.items,
      token: plan.token,
      date,
    };
  });
}
export async function orderHistory(input: {
  query?: string;
  from?: string;
  to?: string;
  deleted?: boolean;
  page?: number;
}) {
  const { query = "", from = "", to = "", deleted = false, page = 1 } = input;
  if (
    query.length > 80 ||
    (from && !validDate(from)) ||
    (to && !validDate(to)) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100000
  )
    throw new AppError("历史筛选无效");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const args = [deleted, `%${query}%`, from || null, to || null];
    const where =
      "(o.deleted_at IS NOT NULL)=$1 AND o.restaurant_name ILIKE $2 AND ($3::date IS NULL OR o.delivery_date>=$3::date) AND ($4::date IS NULL OR o.delivery_date<=$4::date)";
    const total = (
      await tx.query<{ count: number }>(
        `SELECT count(*)::int count FROM orders o WHERE ${where}`,
        args,
      )
    ).rows[0].count;
    const orders = (
      await tx.query(
        `SELECT o.id,o.restaurant_id,o.restaurant_name,o.delivery_date::text,o.version,o.deleted_at,o.picking_started_at,o.finalized_document_id,(SELECT count(*)::int FROM order_items i WHERE i.order_id=o.id) item_count FROM orders o WHERE ${where} ORDER BY o.delivery_date DESC,o.created_at DESC,o.id LIMIT 20 OFFSET $5`,
        [...args, (page - 1) * 20],
      )
    ).rows;
    return { orders, total, page, pages: Math.max(1, Math.ceil(total / 20)) };
  });
}
export async function historyDetail(id: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const order = await loadOrder(tx, id, true);
    const documents = (
      await tx.query(
        "SELECT id,number,revision,superseded_at,created_at FROM documents WHERE order_id=$1 ORDER BY revision DESC",
        [id],
      )
    ).rows;
    return { order, documents };
  });
}
