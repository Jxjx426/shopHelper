import { loadBlob } from "./file-store.server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, type Transaction } from "./db";
import { resolvePrice } from "./pricing.server";
import { discrepancy } from "./billing";
import { copyPlan } from "./history.server";
import {
  applyDocument,
  documentActionSchemas,
  loadOrder,
  requireOwner,
} from "./documents.server";
import {
  UNITS,
  isWeight,
  lineAmount,
  price,
  quantity,
  validDate,
  type Order,
  type OrderItem,
  type Product,
  type Restaurant,
  type Workspace,
  type Zone,
} from "./domain";

import { AppError } from "./errors";
import { requirePermission, actionPermission } from "./permissions.server";
import { saveStaff, userActionSchema } from "./users.server";
export { AppError } from "./errors";
const id = z.string().min(1).max(100);
const name = z.string().trim().min(1, "名称不能为空").max(80, "名称最多80个字");
const unit = z.enum(UNITS);
const version = z.number().int().positive();
const aliases = z.array(z.string().trim().min(1).max(80)).max(60).default([]);
const date = z.string().refine(validDate, "请选择有效日期");
const amount = z.string().max(30);
const schemas = [
  userActionSchema,
  z.object({ action: z.literal("saveShop"), name, version }),
  z.object({
    action: z.literal("saveThresholds"),
    version,
    small: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
    large: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
  }),
  z.object({
    action: z.literal("saveRestaurantPrice"),
    restaurantId: id,
    productId: id,
    billingUnit: unit,
    price: amount.nullable(),
    expectedVersion: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("setOrderDeleted"),
    id,
    version,
    deleted: z.boolean(),
  }),
  z.object({
    action: z.literal("copyOrder"),
    id,
    version,
    date,
    token: z.string().length(64),
    mode: z.enum(["new", "replace"]),
    targetVersion: version.optional(),
  }),
  ...documentActionSchemas,
  z.object({
    action: z.literal("saveZone"),
    id: id.optional(),
    version: version.optional(),
    name,
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("moveZone"),
    id,
    version,
    direction: z.enum(["up", "down"]),
  }),
  z.object({
    action: z.literal("saveRestaurant"),
    id: id.optional(),
    version: version.optional(),
    name,
    aliases,
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("saveProduct"),
    id: id.optional(),
    version: version.optional(),
    name,
    aliases,
    zoneId: id,
    sortOrder: z.number().int().min(0).max(9999),
    active: z.boolean(),
    units: z
      .array(
        z.object({
          orderUnit: unit,
          billingUnit: unit,
          price: amount.nullable(),
        }),
      )
      .min(1)
      .max(7),
  }),
  z.object({
    action: z.literal("saveOrder"),
    id: id.optional(),
    version: version.optional(),
    restaurantId: id,
    date,
    urgent: z.boolean(),
    items: z
      .array(z.object({ productId: id, quantity: amount, unit }))
      .min(1, "请至少添加一项商品")
      .max(200),
  }),
  z.object({
    action: z.literal("setUrgent"),
    id,
    version,
    urgent: z.boolean(),
  }),
  z.object({
    action: z.literal("setPicking"),
    id,
    version,
    picked: z.boolean(),
  }),
  z.object({
    action: z.literal("setUnavailable"),
    id,
    version,
    taskVersion: version,
    unavailable: z.boolean(),
  }),
  z.object({
    action: z.literal("saveActual"),
    id,
    version,
    quantity: amount,
    unit,
    acknowledgeDiscrepancy: z.boolean().default(false),
    expectedDiscrepancyKey: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("refreshPrice"),
    id,
    version,
    expectedPrice: amount,
  }),
] as const;
export const actionSchema = z.discriminatedUnion("action", schemas);
export type Action = z.infer<typeof actionSchema>;

function ensure(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(message, status);
}
async function row<T>(
  tx: Transaction,
  table: string,
  entityId: string,
): Promise<T> {
  // Table names are internal constants; all values use SQL parameters.
  const result = await tx.query<T>(
    `SELECT *${table === "orders" ? ",delivery_date::text AS delivery_date" : ""} FROM ${table} WHERE id=$1`,
    [entityId],
  );
  ensure(result.rows[0], "记录不存在，请刷新页面", 404);
  return result.rows[0];
}
function checkVersion(record: { version: number }, expected?: number) {
  ensure(
    expected === record.version,
    "这条记录已被修改。请刷新后重新操作；你的输入尚未保存。",
    409,
  );
}
async function record(
  tx: Transaction,
  actor: string,
  action: string,
  entity: string,
  details: unknown,
) {
  await tx.query(
    "INSERT INTO change_records(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, action, entity, JSON.stringify(details)],
  );
}

export async function workspace(selectedDate: string): Promise<Workspace> {
  ensure(validDate(selectedDate), "请选择有效日期");
  const db = await getDb();
  // A single transaction gives this date workspace a consistent snapshot.
  return db.transaction(async (tx) => {
    const shop = (
      await tx.query<Workspace["shop"]>(
        "SELECT name,version,small_weight_percent::text,large_weight_percent::text FROM shop WHERE id=1",
      )
    ).rows[0];
    const zones = (
      await tx.query<Zone>("SELECT * FROM zones ORDER BY sort_order,id")
    ).rows;
    const restaurants = (
      await tx.query<Restaurant>("SELECT * FROM restaurants ORDER BY name,id")
    ).rows;
    const products = (
      await tx.query<Product>(
        `SELECT p.*,coalesce((SELECT jsonb_agg(jsonb_build_object('orderUnit',u.order_unit,'billingUnit',u.billing_unit,'price',pr.amount::text) ORDER BY u.order_unit) FROM product_units u LEFT JOIN prices pr ON pr.product_id=u.product_id AND pr.billing_unit=u.billing_unit WHERE u.product_id=p.id),'[]'::jsonb) units FROM products p ORDER BY p.sort_order,p.name,p.id`,
      )
    ).rows;
    const orders = (
      await tx.query<Omit<Order, "items">>(
        "SELECT id,restaurant_id,restaurant_name,delivery_date::text,urgent,picking_started_at,version,created_at,deleted_at,finalized_document_id FROM orders WHERE delivery_date=$1::date AND deleted_at IS NULL ORDER BY created_at,id",
        [selectedDate],
      )
    ).rows;
    const items = (
      await tx.query<OrderItem>(
        `SELECT i.*,t.state picking_state,t.version task_version,(SELECT u.name FROM change_records c JOIN users u ON u.id=c.actor_id WHERE c.entity_id=i.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) last_changed_by FROM order_items i JOIN picking_tasks t ON t.order_item_id=i.id JOIN orders o ON o.id=i.order_id WHERE o.delivery_date=$1::date AND o.deleted_at IS NULL ORDER BY i.position,i.id`,
        [selectedDate],
      )
    ).rows;
    return {
      generation: (
        await tx.query<{ generation: string }>(
          "SELECT generation FROM app_state WHERE id=1",
        )
      ).rows[0].generation,
      shop,
      zones,
      restaurants,
      products,
      date: selectedDate,
      restaurantPrices: (
        await tx.query<Workspace["restaurantPrices"][number]>(
          "SELECT restaurant_id,product_id,billing_unit,amount::text,version FROM restaurant_prices",
        )
      ).rows,
      orders: orders.map((order) => ({
        ...order,
        items: items.filter((item) => item.order_id === order.id),
      })),
    };
  });
}

export async function apply(
  tx: Transaction,
  actor: string,
  a: Action,
): Promise<{ id: string }> {
  await requirePermission(tx, actor, actionPermission(a.action));
  if (a.action === "saveStaff") return saveStaff(tx, actor, a);
  if (a.action === "finalizeOrder" || a.action === "reopenOrder")
    return applyDocument(tx, actor, a);
  if (a.action === "saveThresholds") {
    await requireOwner(tx, actor);
    checkVersion(
      (
        await tx.query<{ version: number }>(
          "SELECT version FROM shop WHERE id=1",
        )
      ).rows[0],
      a.version,
    );
    ensure(
      Number(a.small) <= 100 && Number(a.large) <= 100,
      "差异阈值须在 0 至 100% 之间",
    );
    await tx.query(
      "UPDATE shop SET small_weight_percent=$1,large_weight_percent=$2,version=version+1 WHERE id=1",
      [a.small, a.large],
    );
    await record(tx, actor, a.action, "1", { small: a.small, large: a.large });
    return { id: "1" };
  }
  if (a.action === "saveRestaurantPrice") {
    await requireOwner(tx, actor);
    await row<Restaurant>(tx, "restaurants", a.restaurantId);
    ensure(
      (
        await tx.query(
          "SELECT 1 FROM product_units WHERE product_id=$1 AND billing_unit=$2",
          [a.productId, a.billingUnit],
        )
      ).rows.length,
      "商品未配置此计价单位",
    );
    const previous = (
      await tx.query<{ version: number }>(
        "SELECT version FROM restaurant_prices WHERE restaurant_id=$1 AND product_id=$2 AND billing_unit=$3",
        [a.restaurantId, a.productId, a.billingUnit],
      )
    ).rows[0];
    ensure(
      (previous?.version ?? 0) === a.expectedVersion,
      "餐馆价格已变化，请重新读取",
      409,
    );
    const value = price(a.price);
    if (value === null)
      await tx.query(
        "DELETE FROM restaurant_prices WHERE restaurant_id=$1 AND product_id=$2 AND billing_unit=$3",
        [a.restaurantId, a.productId, a.billingUnit],
      );
    else
      await tx.query(
        "INSERT INTO restaurant_prices(restaurant_id,product_id,billing_unit,amount,version) VALUES($1,$2,$3,$4,nextval('restaurant_price_version')) ON CONFLICT(restaurant_id,product_id,billing_unit) DO UPDATE SET amount=excluded.amount,version=nextval('restaurant_price_version')",
        [a.restaurantId, a.productId, a.billingUnit, value],
      );
    await record(tx, actor, a.action, a.restaurantId, {
      productId: a.productId,
      unit: a.billingUnit,
      price: value,
    });
    return { id: a.restaurantId };
  }
  if (a.action === "setOrderDeleted") {
    await requireOwner(tx, actor);
    const order = await loadOrder(tx, a.id, true);
    checkVersion(order, a.version);
    ensure(
      Boolean(order.deleted_at) !== a.deleted,
      a.deleted ? "订单已删除" : "订单已恢复",
      409,
    );
    if (!a.deleted)
      ensure(
        !(
          await tx.query(
            "SELECT id FROM orders WHERE restaurant_id=$1 AND delivery_date=$2::date AND deleted_at IS NULL AND id<>$3",
            [order.restaurant_id, order.delivery_date, order.id],
          )
        ).rows.length,
        "当天已有另一份订单，请先处理原订单，避免重复需求",
        409,
      );
    await tx.query(
      "UPDATE orders SET deleted_at=CASE WHEN $1 THEN now() ELSE NULL END,version=version+1 WHERE id=$2",
      [a.deleted, a.id],
    );
    await record(tx, actor, a.action, a.id, { deleted: a.deleted });
    return { id: a.id };
  }
  if (a.action === "copyOrder") {
    await requireOwner(tx, actor);
    const planned = await copyPlan(tx, a.id, a.date);
    const { source, target } = planned;
    checkVersion(source, a.version);
    ensure(
      planned.token === a.token,
      "目标订单或现价已变化，请重新核对复制预览",
      409,
    );
    ensure(
      !target || a.mode === "replace",
      "目标日期已有订单，请核对后明确选择替换，或更改日期",
      409,
    );
    ensure(target || a.mode === "new", "目标订单已变化，请重新读取", 409);
    if (target) checkVersion(target, a.targetVersion);
    const result = await apply(tx, actor, {
      action: "saveOrder",
      ...(target ? { id: target.id, version: target.version } : {}),
      restaurantId: source.restaurant_id,
      date: a.date,
      urgent: false,
      items: source.items.map((i) => ({
        productId: i.product_id,
        quantity: quantity(i.ordered_quantity),
        unit: i.ordered_unit,
      })),
    });
    await record(tx, actor, a.action, result.id, { from: a.id, date: a.date });
    return result;
  }
  if (a.action === "saveShop") {
    checkVersion(
      (
        await tx.query<{ version: number }>(
          "SELECT version FROM shop WHERE id=1",
        )
      ).rows[0],
      a.version,
    );
    await tx.query("UPDATE shop SET name=$1,version=version+1 WHERE id=1", [
      a.name,
    ]);
    await record(tx, actor, a.action, "1", { name: a.name });
    return { id: "1" };
  }
  if (a.action === "saveZone") {
    const entityId = a.id ?? randomUUID();
    if (a.id) {
      checkVersion(await row<Zone>(tx, "zones", a.id), a.version);
      if (!a.active)
        ensure(
          !(
            await tx.query(
              "SELECT id FROM products WHERE zone_id=$1 AND active=true LIMIT 1",
              [a.id],
            )
          ).rows.length,
          "这个区域还有启用中的商品，请先转移或停用商品",
        );
      await tx.query(
        "UPDATE zones SET name=$1,active=$2,version=version+1 WHERE id=$3",
        [a.name, a.active, a.id],
      );
    } else
      await tx.query(
        "INSERT INTO zones(id,name,sort_order,active) VALUES($1,$2,(SELECT coalesce(max(sort_order),0)+1 FROM zones),$3)",
        [entityId, a.name, a.active],
      );
    await record(tx, actor, a.action, entityId, {
      name: a.name,
      active: a.active,
    });
    return { id: entityId };
  }
  if (a.action === "moveZone") {
    const current = await row<Zone>(tx, "zones", a.id);
    checkVersion(current, a.version);
    const all = (
      await tx.query<Zone>("SELECT * FROM zones ORDER BY sort_order,id")
    ).rows;
    const index = all.findIndex((zone) => zone.id === a.id);
    const other = all[index + (a.direction === "up" ? -1 : 1)];
    if (other) {
      await tx.query(
        "UPDATE zones SET sort_order=$1,version=version+1 WHERE id=$2",
        [other.sort_order, current.id],
      );
      await tx.query(
        "UPDATE zones SET sort_order=$1,version=version+1 WHERE id=$2",
        [current.sort_order, other.id],
      );
    }
    await record(tx, actor, a.action, a.id, { direction: a.direction });
    return { id: a.id };
  }
  if (a.action === "saveRestaurant") {
    const entityId = a.id ?? randomUUID();
    if (a.id) {
      checkVersion(await row<Restaurant>(tx, "restaurants", a.id), a.version);
      await tx.query(
        "UPDATE restaurants SET name=$1,aliases=$2,active=$3,version=version+1 WHERE id=$4",
        [a.name, a.aliases, a.active, a.id],
      );
    } else
      await tx.query(
        "INSERT INTO restaurants(id,name,aliases,active) VALUES($1,$2,$3,$4)",
        [entityId, a.name, a.aliases, a.active],
      );
    await record(tx, actor, a.action, entityId, {
      name: a.name,
      active: a.active,
    });
    return { id: entityId };
  }
  if (a.action === "saveProduct") {
    const zone = await row<Zone>(tx, "zones", a.zoneId);
    ensure(!a.active || zone.active, "启用的商品必须放在启用的区域");
    ensure(
      new Set(a.units.map((u) => u.orderUnit)).size === a.units.length,
      "同一个订购单位只能设置一次",
    );
    const priceMap = new Map<string, string | null>();
    for (const rule of a.units) {
      ensure(
        (isWeight(rule.orderUnit) && rule.billingUnit === "kg") ||
          (!isWeight(rule.orderUnit) &&
            (rule.billingUnit === rule.orderUnit || rule.billingUnit === "kg")),
        "重量按公斤计价；按件订购可按原单位或公斤计价",
      );
      const value = price(rule.price);
      ensure(
        !priceMap.has(rule.billingUnit) ||
          priceMap.get(rule.billingUnit) === value,
        "同一个计价单位的价格必须一致",
      );
      priceMap.set(rule.billingUnit, value);
    }
    const entityId = a.id ?? randomUUID();
    if (a.id) {
      checkVersion(await row<Product>(tx, "products", a.id), a.version);
      await tx.query(
        "UPDATE products SET name=$1,aliases=$2,zone_id=$3,sort_order=$4,active=$5,version=version+1 WHERE id=$6",
        [a.name, a.aliases, a.zoneId, a.sortOrder, a.active, a.id],
      );
      await tx.query("DELETE FROM product_units WHERE product_id=$1", [a.id]);
      await tx.query("DELETE FROM prices WHERE product_id=$1", [a.id]);
    } else
      await tx.query(
        "INSERT INTO products(id,name,aliases,zone_id,sort_order,active) VALUES($1,$2,$3,$4,$5,$6)",
        [entityId, a.name, a.aliases, a.zoneId, a.sortOrder, a.active],
      );
    for (const rule of a.units)
      await tx.query(
        "INSERT INTO product_units(product_id,order_unit,billing_unit) VALUES($1,$2,$3)",
        [entityId, rule.orderUnit, rule.billingUnit],
      );
    for (const [billingUnit, value] of priceMap)
      await tx.query(
        "INSERT INTO prices(product_id,billing_unit,amount) VALUES($1,$2,$3)",
        [entityId, billingUnit, value],
      );
    await record(tx, actor, a.action, entityId, {
      name: a.name,
      units: a.units,
    });
    return { id: entityId };
  }
  if (a.action === "saveOrder") {
    const restaurant = await row<Restaurant>(tx, "restaurants", a.restaurantId);
    ensure(restaurant.active, "餐馆已停用，请先在设置中启用");
    const entityId = a.id ?? randomUUID();
    if (a.id) {
      const existing = await row<Order>(tx, "orders", a.id);
      ensure(
        !existing.deleted_at && !existing.finalized_document_id,
        "此订单已删除或定稿，不能修改",
        409,
      );
      checkVersion(existing, a.version);
      ensure(
        !existing.picking_started_at,
        "已开始配货，不能增加、删除或修改订购项目",
        409,
      );
      ensure(
        existing.restaurant_id === a.restaurantId &&
          String(existing.delivery_date).slice(0, 10) === a.date,
        "不能更改原订单的日期或餐馆",
      );
      await tx.query("DELETE FROM order_items WHERE order_id=$1", [a.id]);
      await tx.query(
        "UPDATE orders SET urgent=$1,version=version+1 WHERE id=$2",
        [a.urgent, a.id],
      );
    } else {
      ensure(
        !(
          await tx.query(
            "SELECT id FROM orders WHERE restaurant_id=$1 AND delivery_date=$2::date AND deleted_at IS NULL",
            [a.restaurantId, a.date],
          )
        ).rows.length,
        "这家餐馆当天已有订单。请返回订单列表，选择修改现有订单。",
        409,
      );
      await tx.query(
        "INSERT INTO orders(id,restaurant_id,restaurant_name,delivery_date,urgent) VALUES($1,$2,$3,$4,$5)",
        [entityId, a.restaurantId, restaurant.name, a.date, a.urgent],
      );
    }
    const seen = new Set<string>();
    for (const [position, line] of a.items.entries()) {
      const product = await row<Product>(tx, "products", line.productId);
      ensure(product.active, `${product.name} 已停用，请调整订单`);
      const key = `${line.productId}:${line.unit}`;
      ensure(
        !seen.has(key),
        `${product.name} 的 ${line.unit} 项目重复，请先手动合并数量`,
      );
      seen.add(key);
      const ordered = quantity(line.quantity);
      ensure(
        isWeight(line.unit) || !ordered.includes("."),
        "包、箱、粒、条、支请输入整数数量",
      );
      const rule = (
        await tx.query<{ billing_unit: string; amount: string | null }>(
          "SELECT u.billing_unit,p.amount::text FROM product_units u LEFT JOIN prices p ON p.product_id=u.product_id AND p.billing_unit=u.billing_unit WHERE u.product_id=$1 AND u.order_unit=$2",
          [line.productId, line.unit],
        )
      ).rows[0];
      ensure(rule, `${product.name} 不支持这个订购单位`);
      const itemId = randomUUID();
      await tx.query(
        "INSERT INTO order_items(id,order_id,product_id,product_name,zone_id,position,ordered_quantity,ordered_unit,billing_unit,price_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          itemId,
          entityId,
          product.id,
          product.name,
          product.zone_id,
          position,
          ordered,
          line.unit,
          rule.billing_unit,
          await resolvePrice(tx, a.restaurantId, product.id, rule.billing_unit),
        ],
      );
      await tx.query(
        "INSERT INTO picking_tasks(id,order_item_id) VALUES($1,$2)",
        [randomUUID(), itemId],
      );
    }
    await record(tx, actor, a.action, entityId, {
      restaurantId: a.restaurantId,
      date: a.date,
      itemCount: a.items.length,
    });
    return { id: entityId };
  }
  if (a.action === "setUrgent") {
    const order = await row<Order>(tx, "orders", a.id);
    ensure(!order.deleted_at, "订单已删除", 409);
    checkVersion(order, a.version);
    await tx.query(
      "UPDATE orders SET urgent=$1,version=version+1 WHERE id=$2",
      [a.urgent, a.id],
    );
    await record(tx, actor, a.action, a.id, { urgent: a.urgent });
    return { id: a.id };
  }
  const item = await row<OrderItem>(tx, "order_items", a.id);
  const order = await row<Order>(tx, "orders", item.order_id);
  ensure(!order.deleted_at, "订单已删除，请刷新", 409);
  ensure(
    !order.finalized_document_id,
    "送货单已定稿，请先由店主重新打开修订",
    409,
  );
  if (a.action === "setPicking") {
    const task = (
      await tx.query<{ version: number; state: string }>(
        "SELECT * FROM picking_tasks WHERE order_item_id=$1",
        [a.id],
      )
    ).rows[0];
    checkVersion(task, a.version);
    ensure(!item.unavailable, "缺货项目不能标记为已配货，请先取消缺货");
    await tx.query(
      "UPDATE picking_tasks SET state=$1,completed_by=$2,version=version+1,updated_at=now() WHERE order_item_id=$3",
      [a.picked ? "picked" : "pending", a.picked ? actor : null, a.id],
    );
    if (a.picked && !order.picking_started_at)
      await tx.query(
        "UPDATE orders SET picking_started_at=now(),version=version+1 WHERE id=$1",
        [order.id],
      );
    await record(tx, actor, a.action, a.id, { picked: a.picked });
    return { id: a.id };
  }
  checkVersion(item, a.version);
  if (a.action === "setUnavailable") {
    checkVersion(
      (
        await tx.query<{ version: number }>(
          "SELECT version FROM picking_tasks WHERE order_item_id=$1",
          [a.id],
        )
      ).rows[0],
      a.taskVersion,
    );
    await tx.query(
      "UPDATE order_items SET unavailable=$1,actual_quantity=NULL,actual_unit=NULL,actual_confirmed=false,discrepancy_ack=NULL,amount=$2,version=version+1,updated_at=now() WHERE id=$3",
      [a.unavailable, a.unavailable ? "0.00" : null, a.id],
    );
    await tx.query(
      "UPDATE picking_tasks SET state=$1,completed_by=$2,version=version+1,updated_at=now() WHERE order_item_id=$3",
      [
        a.unavailable ? "unavailable" : "pending",
        a.unavailable ? actor : null,
        a.id,
      ],
    );
    if (a.unavailable && !order.picking_started_at)
      await tx.query(
        "UPDATE orders SET picking_started_at=now(),version=version+1 WHERE id=$1",
        [order.id],
      );
    await record(tx, actor, a.action, a.id, { unavailable: a.unavailable });
    return { id: a.id };
  }
  if (a.action === "saveActual") {
    ensure(!item.unavailable, "此项目已标记缺货，请先取消缺货");
    const actual = quantity(a.quantity);
    ensure(
      isWeight(item.billing_unit)
        ? isWeight(a.unit)
        : a.unit === item.billing_unit,
      "实供单位与计价单位不兼容",
    );
    ensure(isWeight(a.unit) || !actual.includes("."), "按件商品请输入整数数量");
    const thresholds = (
      await tx.query<Workspace["shop"]>(
        "SELECT small_weight_percent::text,large_weight_percent::text FROM shop WHERE id=1",
      )
    ).rows[0];
    const warning = discrepancy(
      item.ordered_quantity,
      item.ordered_unit,
      actual,
      a.unit,
      thresholds,
    );
    if (warning?.warning)
      ensure(
        a.acknowledgeDiscrepancy && a.expectedDiscrepancyKey === warning.key,
        `重量${warning.direction} ${warning.percent}%，超过 ${warning.threshold}%，请核对并确认此重量`,
        422,
      );
    const total =
      item.price_snapshot === null
        ? null
        : lineAmount(actual, a.unit, item.billing_unit, item.price_snapshot);
    await tx.query(
      "UPDATE order_items SET actual_quantity=$1,actual_unit=$2,actual_confirmed=true,amount=$3,discrepancy_ack=$5,version=version+1,updated_at=now() WHERE id=$4",
      [actual, a.unit, total, a.id, warning?.warning ? warning.key : null],
    );
    // Quantity entry never changes picking state or the picking-start lock.
    await record(tx, actor, a.action, a.id, {
      actual,
      unit: a.unit,
      amount: total,
    });
    return { id: a.id };
  }
  if (a.action === "refreshPrice") {
    const current = await resolvePrice(
      tx,
      order.restaurant_id,
      item.product_id,
      item.billing_unit,
    );
    ensure(
      current !== null && current !== undefined,
      "商品尚未设置这个计价单位的价格，请先到设置中填写",
    );
    ensure(
      price(a.expectedPrice) === current,
      "现价刚刚发生变化，请刷新后重新查看",
      409,
    );
    const total =
      item.actual_confirmed && item.actual_quantity !== null && item.actual_unit
        ? lineAmount(
            item.actual_quantity,
            item.actual_unit,
            item.billing_unit,
            current,
          )
        : null;
    await tx.query(
      "UPDATE order_items SET price_snapshot=$1,amount=$2,version=version+1,updated_at=now() WHERE id=$3",
      [current, total, a.id],
    );
    await record(tx, actor, a.action, a.id, {
      from: item.price_snapshot,
      to: current,
    });
    return { id: a.id };
  }
  throw new AppError("不支持的操作");
}

export async function runAction(
  actor: string,
  requestId: string,
  input: unknown,
) {
  return runActionIn(await getDb(), actor, requestId, input);
}
export async function runActionIn(
  db: import("./db").Database,
  actor: string,
  requestId: string,
  input: unknown,
) {
  ensure(/^[a-zA-Z0-9-]{16,100}$/.test(requestId), "操作编号无效，请刷新页面");
  const parsed = actionSchema.safeParse(input);
  ensure(
    parsed.success,
    parsed.success ? "" : (parsed.error.issues[0]?.message ?? "输入无效"),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(parsed.data))
    .digest("hex");
  try {
    return await db.transaction(async (tx) => {
      await requirePermission(tx, actor, actionPermission(parsed.data!.action));
      const prior = (
        await tx.query<{
          actor_id: string;
          payload_hash: string;
          response: { id: string };
        }>("SELECT * FROM operation_requests WHERE key=$1", [requestId])
      ).rows[0];
      if (prior) {
        ensure(
          prior.actor_id === actor && prior.payload_hash === hash,
          "操作编号已使用，请重新操作",
          409,
        );
        return prior.response;
      }
      const response = await apply(tx, actor, parsed.data);
      await tx.query(
        "INSERT INTO operation_requests(key,actor_id,payload_hash,response) VALUES($1,$2,$3,$4)",
        [requestId, actor, hash, JSON.stringify(response)],
      );
      return response;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as { code?: string }).code;
    if (code === "23505")
      throw new AppError("名称或当天餐馆订单已存在，请检查后再试", 409);
    if (code === "23503")
      throw new AppError("关联记录不存在，请刷新后再试", 409);
    throw error;
  }
}

export async function exportBackup() {
  const db = await getDb();
  const data = await db.transaction(collectBackupIn);
  return finishBackup(data);
}
export async function collectBackupIn(tx: Transaction) {
  const tables: Record<string, unknown[]> = {};
  // Sessions, password hashes and API keys intentionally never leave the server.
  for (const table of [
    "shop",
    "zones",
    "restaurants",
    "products",
    "product_units",
    "prices",
    "restaurant_prices",
    "orders",
    "order_items",
    "picking_tasks",
    "change_records",
    "import_drafts",
    "extraction_attempts",
  ])
    tables[table] = (
      await tx.query(
        `SELECT *${table === "orders" || table === "import_drafts" ? ",delivery_date::text AS delivery_date" : ""} FROM ${table}`,
      )
    ).rows;
  tables.import_images = (
    await tx.query(
      "SELECT draft_id,original_mime,encode(original_image,'base64') original_base64,prepared_mime,encode(prepared_image,'base64') prepared_base64,original_asset_id,prepared_asset_id FROM import_images",
    )
  ).rows;
  tables.documents = (
    await tx.query(
      "SELECT id,order_id,number,revision,sequence_no::text,snapshot,pdf_sha256,superseded_at,created_by,created_at,encode(pdf,'base64') pdf_base64,encode(superseded_pdf,'base64') superseded_base64,pdf_asset_id,superseded_asset_id FROM documents",
    )
  ).rows;
  const actors = (await tx.query("SELECT id,name,role FROM users")).rows;
  const data = {
    format: "fresh-helper-stage3",
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    timezone: "Asia/Kuala_Lumpur",
    actors,
    tables,
  };
  return data;
}
export async function finishBackup(
  data: Awaited<ReturnType<typeof collectBackupIn>>,
  tx?: Transaction,
) {
  for (const image of data.tables.import_images as Record<string, any>[]) {
    for (const part of ["original", "prepared"]) {
      if (!image[`${part}_base64`])
        image[`${part}_base64`] = (
          await loadBlob(null, image[`${part}_asset_id`], tx)
        ).toString("base64");
      delete image[`${part}_asset_id`];
    }
  }
  for (const doc of data.tables.documents as Record<string, any>[]) {
    if (!doc.pdf_base64)
      doc.pdf_base64 = (await loadBlob(null, doc.pdf_asset_id, tx)).toString(
        "base64",
      );
    if (!doc.superseded_base64 && doc.superseded_asset_id)
      doc.superseded_base64 = (
        await loadBlob(null, doc.superseded_asset_id, tx)
      ).toString("base64");
    delete doc.pdf_asset_id;
    delete doc.superseded_asset_id;
  }
  const { backupChecksum } = await import("./backup-checksum");
  return { ...data, checksum: backupChecksum(data) };
}
export async function backupIn(tx: Transaction) {
  return finishBackup(await collectBackupIn(tx), tx);
}
