import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { getDb, type Transaction } from "./db";
import { AppError } from "./errors";
import { finalTotals, itemWarning } from "./billing";
import {
  lineAmount,
  quantity,
  type Order,
  type OrderItem,
  type Workspace,
  UNITS,
} from "./domain";
import { renderDeliveryPdf } from "./pdf.server";
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const documentSnapshotSchema = z
  .object({
    shopName: z.string().min(1).max(80),
    restaurantName: z.string().min(1).max(80),
    date: z.string(),
    number: z.string(),
    revision: z.number().int().positive(),
    draft: z.boolean(),
    createdAt: z.string(),
    issues: z.array(z.string()),
    items: z
      .array(
        z.object({
          name: z.string().max(80),
          quantity: z.string().nullable(),
          unit: z.enum(UNITS).nullable(),
          price: z.string().nullable(),
          billingUnit: z.enum(UNITS),
          amount: z.string().nullable(),
          unavailable: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
    subtotal: z.string(),
    rounding: z.string(),
    total: z.string().nullable(),
  })
  .strict();
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;
export async function requireOwner(tx: Transaction, actor: string) {
  if (
    !(
      await tx.query(
        "SELECT id FROM users WHERE id=$1 AND role IN ('owner','admin')",
        [actor],
      )
    ).rows.length
  )
    throw new AppError("此操作只限店主", 403);
}
export async function loadOrder(
  tx: Transaction,
  id: string,
  includeDeleted = false,
): Promise<Order> {
  const order = (
    await tx.query<Order>(
      "SELECT *,delivery_date::text AS delivery_date FROM orders WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!order || (!includeDeleted && order.deleted_at))
    throw new AppError("订单不存在或已删除", 404);
  const items = (
    await tx.query<OrderItem>(
      "SELECT i.*,t.state picking_state,t.version task_version FROM order_items i JOIN picking_tasks t ON t.order_item_id=i.id WHERE i.order_id=$1 ORDER BY i.position,i.id",
      [id],
    )
  ).rows;
  return { ...order, items };
}
export async function documentState(tx: Transaction, id: string) {
  const order = await loadOrder(tx, id);
  const shop = (
    await tx.query<Workspace["shop"]>(
      "SELECT name,small_weight_percent::text,large_weight_percent::text FROM shop WHERE id=1",
    )
  ).rows[0];
  const issues: string[] = [];
  if (!order.items.length) issues.push("订单没有商品");
  const items: DocumentSnapshot["items"] = order.items.map((item) => {
    if (item.picking_state === "pending")
      issues.push(`${item.product_name}：尚未配货`);
    if (item.unavailable)
      return {
        name: item.product_name,
        quantity: "0",
        unit: item.billing_unit,
        price: item.price_snapshot,
        billingUnit: item.billing_unit,
        amount: "0.00",
        unavailable: true,
      };
    if (!item.actual_confirmed || !item.actual_quantity || !item.actual_unit)
      issues.push(`${item.product_name}：实供待确认`);
    if (item.price_snapshot === null)
      issues.push(`${item.product_name}：待定价`);
    const warning = itemWarning(item, shop);
    if (warning?.warning && item.discrepancy_ack !== warning.key)
      issues.push(`${item.product_name}：重量差异待确认`);
    const amount =
      item.actual_confirmed &&
      item.actual_quantity &&
      item.actual_unit &&
      item.price_snapshot !== null
        ? lineAmount(
            item.actual_quantity,
            item.actual_unit,
            item.billing_unit,
            item.price_snapshot,
          )
        : null;
    return {
      name: item.product_name,
      quantity:
        item.actual_confirmed && item.actual_quantity
          ? quantity(item.actual_quantity)
          : null,
      unit: item.actual_confirmed ? item.actual_unit : null,
      price: item.price_snapshot,
      billingUnit: item.billing_unit,
      amount,
      unavailable: false,
    };
  });
  const totals = finalTotals(items.map((i) => i.amount ?? "0"));
  const snapshot: DocumentSnapshot = {
    shopName: shop.name,
    restaurantName: order.restaurant_name,
    date: order.delivery_date,
    number: "DRAFT",
    revision: 1,
    draft: true,
    createdAt: new Date().toISOString(),
    issues,
    items,
    ...totals,
    total: issues.length ? null : totals.total,
  };
  const token = digest(JSON.stringify([order, shop]));
  return { order, snapshot, token };
}
export async function documentPreview(id: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const state = await documentState(tx, id);
    const documents = (
      await tx.query<{
        id: string;
        number: string;
        revision: number;
        superseded_at: string | null;
        created_at: string;
      }>(
        "SELECT id,number,revision,superseded_at,created_at FROM documents WHERE order_id=$1 ORDER BY revision DESC",
        [id],
      )
    ).rows;
    const finalized = state.order.finalized_document_id
      ? (
          await tx.query<{ snapshot: DocumentSnapshot }>(
            "SELECT snapshot FROM documents WHERE id=$1",
            [state.order.finalized_document_id],
          )
        ).rows[0]
      : null;
    return {
      snapshot: finalized?.snapshot ?? state.snapshot,
      token: state.token,
      documents,
      finalizedDocumentId: state.order.finalized_document_id,
      orderVersion: state.order.version,
    };
  });
}
export const documentActionSchemas = [
  z.object({
    action: z.literal("finalizeOrder"),
    id: z.string().max(100),
    token: z.string().length(64),
    finalChecked: z.literal(true),
  }),
  z.object({
    action: z.literal("reopenOrder"),
    id: z.string().max(100),
    version: z.number().int().positive(),
    acknowledgeShared: z.literal(true),
  }),
] as const;
export type DocumentAction = z.infer<(typeof documentActionSchemas)[number]>;
export async function applyDocument(
  tx: Transaction,
  actor: string,
  a: DocumentAction,
) {
  await requireOwner(tx, actor);
  const state = await documentState(tx, a.id);
  if (a.action === "reopenOrder") {
    if (state.order.version !== a.version)
      throw new AppError("订单已更新，请重新读取", 409);
    if (!state.order.finalized_document_id)
      throw new AppError("此订单尚未定稿", 409);
    await tx.query(
      "UPDATE orders SET finalized_document_id=NULL,version=version+1 WHERE id=$1",
      [a.id],
    );
  } else {
    if (state.order.finalized_document_id)
      throw new AppError("订单已定稿，请下载已有送货单", 409);
    if (state.token !== a.token)
      throw new AppError("订单或设置已变化，请重新核对后定稿", 409);
    if (state.snapshot.issues.length)
      throw new AppError(`尚不能定稿：${state.snapshot.issues.join("；")}`);
    const previous = (
      await tx.query<{
        id: string;
        revision: number;
        snapshot: DocumentSnapshot;
      }>(
        "SELECT id,revision,snapshot FROM documents WHERE order_id=$1 ORDER BY revision DESC",
        [a.id],
      )
    ).rows;
    const revision = (previous[0]?.revision ?? 0) + 1;
    const seq = (
      await tx.query<{ seq: string }>(
        "SELECT nextval('delivery_document_no')::text seq",
      )
    ).rows[0].seq;
    const number = `DO-${state.order.delivery_date.replaceAll("-", "")}-${seq.padStart(6, "0")}`;
    const snapshot = { ...state.snapshot, draft: false, number, revision };
    const pdf = await renderDeliveryPdf(snapshot);
    const id = randomUUID();
    await tx.query(
      "INSERT INTO documents(id,order_id,number,revision,sequence_no,snapshot,pdf,pdf_sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        a.id,
        number,
        revision,
        seq,
        JSON.stringify(snapshot),
        pdf,
        digest(pdf),
        actor,
      ],
    );
    for (const old of previous.filter((d) => d.revision === revision - 1)) {
      const superseded = await renderDeliveryPdf(
        old.snapshot,
        `已被第 ${revision} 版替代 / SUPERSEDED`,
      );
      await tx.query(
        "UPDATE documents SET superseded_at=now(),superseded_pdf=$1 WHERE id=$2",
        [superseded, old.id],
      );
    }
    await tx.query(
      "UPDATE orders SET finalized_document_id=$1,version=version+1 WHERE id=$2",
      [id, a.id],
    );
  }
  await tx.query(
    "INSERT INTO change_records(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, a.action, a.id, JSON.stringify({})],
  );
  return { id: a.id };
}
export async function documentPdf(id: string) {
  const db = await getDb();
  const row = (
    await db.query<{
      pdf: Uint8Array;
      superseded_pdf: Uint8Array | null;
      number: string;
    }>("SELECT pdf,superseded_pdf,number FROM documents WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new AppError("送货单不存在", 404);
  return { bytes: row.superseded_pdf ?? row.pdf, number: row.number };
}
export async function draftPdf(id: string) {
  const db = await getDb();
  const snapshot = await db.transaction(
    async (tx) => (await documentState(tx, id)).snapshot,
  );
  return renderDeliveryPdf(snapshot);
}
