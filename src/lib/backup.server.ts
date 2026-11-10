import { loadBlob, storeBlob } from "./file-store.server";
import { saveCloudBackup } from "./cloud-backup.server";
import { completeRestoreJob } from "./cloud-job-context.server";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { getDb, schema, type Transaction } from "./db";
import { AppError } from "./errors";
import { backupIn } from "./service";
import { backupChecksum } from "./backup-checksum";
import {
  documentSnapshotSchema,
  digest,
  requireOwner,
} from "./documents.server";
import { finalTotals } from "./billing";
import {
  isWeight,
  lineAmount,
  price,
  quantity,
  UNITS,
  validDate,
} from "./domain";
type Row = Record<string, unknown>;
type Backup = {
  format: string;
  schemaVersion: number;
  exportedAt: string;
  timezone: string;
  actors: Row[];
  tables: Record<string, Row[]>;
  checksum?: string;
};
const tables = [
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
  "documents",
  "change_records",
  "import_drafts",
  "import_images",
  "extraction_attempts",
] as const;
const reviewLine = z
  .object({
    id: z.string().max(200),
    sourceLine: z.number().int().min(0).max(200),
    sourceText: z.string().max(20000),
    productText: z.string().max(20000),
    productId: z.string().max(100),
    quantity: z.string().max(30),
    unit: z.enum([...UNITS, ""]),
    unitNote: z.string().max(100).optional(),
    matchedBy: z.enum([
      "name",
      "alias",
      "ambiguous",
      "suggested",
      "unknown",
      "manual",
    ]),
    candidates: z.array(z.string().max(100)).max(200),
    extractionIssues: z.array(z.string().max(3000)).max(30),
    disposition: z.enum(["item", "ignored"]),
    ignoreReason: z.string().max(3000),
    reviewed: z.boolean(),
    saveAlias: z.boolean(),
  })
  .strict();
function check(value: unknown, message: string): asserts value {
  if (!value) throw new AppError(`备份无效：${message}`);
}
function pdfBytes(value: unknown) {
  check(
    typeof value === "string" &&
      value.length < 32 * 1024 * 1024 &&
      /^[A-Za-z0-9+/=\s]+$/.test(value),
    "PDF 编码或大小",
  );
  const bytes = Buffer.from(value, "base64");
  check(bytes.subarray(0, 5).toString() === "%PDF-", "PDF 文件损坏");
  return bytes;
}
function payload(input: unknown): Backup {
  check(
    input && typeof input === "object" && !Array.isArray(input),
    "文件格式",
  );
  const data = input as Backup;
  check(
    [1, 2, 3].includes(data.schemaVersion) &&
      data.format === `fresh-helper-stage${data.schemaVersion}`,
    "不支持的备份版本",
  );
  check(
    Object.keys(data).every((k) =>
      [
        "format",
        "schemaVersion",
        "exportedAt",
        "timezone",
        "actors",
        "tables",
        "checksum",
      ].includes(k),
    ),
    "包含未知内容",
  );
  check(
    data.timezone === "Asia/Kuala_Lumpur" &&
      Number.isFinite(Date.parse(data.exportedAt)),
    "时区或导出日期",
  );
  check(
    Array.isArray(data.actors) &&
      data.actors.length > 0 &&
      data.actors.length <= 100,
    "操作人列表",
  );
  check(
    data.tables &&
      typeof data.tables === "object" &&
      Object.keys(data.tables).every((k) =>
        (tables as readonly string[]).includes(k),
      ),
    "数据表",
  );
  if (data.schemaVersion === 3) {
    const { checksum, ...base } = data;
    check(checksum === backupChecksum(base), "校验码不符，文件可能不完整");
  }
  for (const t of [
    "shop",
    "zones",
    "restaurants",
    "products",
    "product_units",
    "prices",
    "orders",
    "order_items",
    "picking_tasks",
    "change_records",
  ])
    check(Array.isArray(data.tables[t]), `缺少 ${t}`);
  check(
    data.tables.shop.length === 1 && data.tables.shop[0].id === 1,
    "店铺记录",
  );
  for (const key of ["small_weight_percent", "large_weight_percent"]) {
    const v = data.tables.shop[0][key];
    if (v !== undefined)
      check(
        typeof v === "string" &&
          /^\d+(\.\d{1,2})?$/.test(v) &&
          Number(v) <= 100,
        "差异阈值",
      );
  }
  let count = 0;
  for (const t of tables) {
    check(!data.tables[t] || Array.isArray(data.tables[t]), `${t} 格式`);
    count += data.tables[t]?.length ?? 0;
  }
  check(count <= 200000, "记录超过 200000 条");
  for (const t of tables)
    for (const row of data.tables[t] ?? [])
      check(row && typeof row === "object" && !Array.isArray(row), `${t} 记录`);
  for (const t of ["shop", "zones", "products", "restaurants"])
    for (const row of data.tables[t] ?? []) {
      check(
        typeof row.name === "string" &&
          row.name.trim().length > 0 &&
          row.name.length <= 80,
        `${t} 名称`,
      );
      if (row.aliases !== undefined)
        check(
          Array.isArray(row.aliases) &&
            row.aliases.length <= 60 &&
            row.aliases.every((s) => typeof s === "string" && s.length <= 80),
          `${t} 别名`,
        );
    }
  for (const row of data.tables.products)
    check(
      row.english_name === undefined ||
        row.english_name === null ||
        (typeof row.english_name === "string" &&
          row.english_name.length <= 80 &&
          !/[\r\n\t\x00-\x1f]/.test(row.english_name)),
      "商品英文名",
    );
  for (const row of data.tables.product_units)
    check(
      UNITS.includes(row.order_unit as never) &&
        UNITS.includes(row.billing_unit as never) &&
        (isWeight(String(row.order_unit))
          ? isWeight(String(row.billing_unit))
          : row.order_unit === row.billing_unit ||
            isWeight(String(row.billing_unit))),
      "商品订购/计价单位",
    );
  for (const row of data.tables.orders)
    check(
      typeof row.delivery_date === "string" && validDate(row.delivery_date),
      "送货日期",
    );
  for (const row of data.tables.prices) price(row.amount);
  for (const row of data.tables.restaurant_prices ?? [])
    check(price(row.amount) !== null, "餐馆专价");
  for (const row of data.tables.order_items) {
    const ordered = quantity(row.ordered_quantity);
    check(
      UNITS.includes(row.ordered_unit as never) &&
        UNITS.includes(row.billing_unit as never),
      "订单单位",
    );
    check(
      isWeight(String(row.ordered_unit)) || !ordered.includes("."),
      "按件订购数量必须为整数",
    );
    const unitPrice = price(row.price_snapshot);
    if (row.unavailable)
      check(
        (row.amount === "0.00" || row.amount === "0") &&
          !row.actual_confirmed &&
          row.actual_quantity === null &&
          row.actual_unit === null,
        "缺货项目状态或金额",
      );
    else if (row.actual_confirmed) {
      const actual = quantity(row.actual_quantity);
      check(UNITS.includes(row.actual_unit as never), "实供单位");
      check(
        isWeight(String(row.actual_unit)) || !actual.includes("."),
        "实供件数必须为整数",
      );
      const amount =
        unitPrice === null
          ? null
          : lineAmount(
              actual,
              String(row.actual_unit),
              String(row.billing_unit),
              unitPrice,
            );
      check(row.amount === amount, "商品金额与实供/价格不一致");
    } else check(row.amount === null, "未确认项目不能有金额");
  }
  for (const row of data.tables.documents ?? []) {
    const parsed = documentSnapshotSchema.safeParse(row.snapshot);
    check(parsed.success, "送货单快照");
    const s = parsed.data;
    check(
      !s.draft &&
        !s.issues.length &&
        s.number === row.number &&
        s.revision === row.revision &&
        validDate(s.date),
      "定稿编号或状态",
    );
    for (const item of s.items) {
      check(
        item.amount !== null && item.quantity !== null && item.unit,
        "定稿实供不完整",
      );
      if (item.unavailable) check(item.amount === "0.00", "定稿缺货金额");
      else {
        quantity(item.quantity);
        check(price(item.price) !== null, "定稿价格");
        check(
          item.amount ===
            lineAmount(item.quantity, item.unit, item.billingUnit, item.price!),
          "定稿商品金额",
        );
      }
    }
    const totals = finalTotals(s.items.map((i) => i.amount!));
    check(
      totals.subtotal === s.subtotal &&
        totals.rounding === s.rounding &&
        totals.total === s.total,
      "定稿总额",
    );
    const bytes = pdfBytes(row.pdf_base64);
    check(digest(bytes) === row.pdf_sha256, "PDF 校验码");
    if (row.superseded_base64) pdfBytes(row.superseded_base64);
  }
  return data;
}
export async function insertBackup(
  tx: Transaction,
  data: Backup,
  owner?: string,
  migration = false,
) {
  for (const actor of data.actors) {
    check(
      Object.keys(actor).every((k) => ["id", "name", "role"].includes(k)) &&
        typeof actor.id === "string" &&
        actor.id.length <= 100 &&
        typeof actor.name === "string" &&
        actor.name.length <= 80,
      "操作人",
    );
    await tx.query(
      "INSERT INTO users(id,name,password_hash,role) VALUES($1,$2,'historical-disabled','historical') ON CONFLICT(id) DO NOTHING",
      [actor.id, actor.name],
    );
  }
  for (const table of tables) {
    const columns = (
      await tx.query<{ column_name: string; data_type: string }>(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
        [table],
      )
    ).rows;
    for (const raw of data.tables[table] ?? []) {
      const row = { ...raw };
      if (table === "documents") {
        row.pdf = pdfBytes(row.pdf_base64);
        row.superseded_pdf = row.superseded_base64
          ? pdfBytes(row.superseded_base64)
          : null;
        if (tx.backend === "postgres") {
          const pdf = await storeBlob(
            tx,
            row.pdf as Uint8Array,
            "application/pdf",
          );
          row.pdf = pdf.bytes;
          row.pdf_asset_id = pdf.assetId;
          if (row.superseded_pdf) {
            const old = await storeBlob(
              tx,
              row.superseded_pdf as Uint8Array,
              "application/pdf",
            );
            row.superseded_pdf = old.bytes;
            row.superseded_asset_id = old.assetId;
          }
        }
        delete row.pdf_base64;
        delete row.superseded_base64;
      }
      if (table === "import_images") {
        for (const kind of ["original", "prepared"]) {
          check(typeof row[`${kind}_base64`] === "string", "截图编码");
          const bytes = Buffer.from(row[`${kind}_base64`] as string, "base64");
          check(
            bytes.length <= 10 * 1024 * 1024 && bytes.length > 0,
            "截图大小",
          );
          check(
            ["image/png", "image/jpeg", "image/webp"].includes(
              String(row[`${kind}_mime`]),
            ),
            "截图格式",
          );
          const meta = await sharp(bytes, {
            limitInputPixels: 24000000,
          }).metadata();
          check(
            ["png", "jpeg", "webp"].includes(meta.format ?? "") &&
              (!meta.pages || meta.pages === 1),
            "截图内容",
          );
          const stored = await storeBlob(
            tx,
            bytes,
            String(row[`${kind}_mime`]),
          );
          row[`${kind}_image`] = stored.bytes;
          if (stored.assetId) row[`${kind}_asset_id`] = stored.assetId;
          delete row[`${kind}_base64`];
        }
      }
      if (table === "import_drafts") {
        check(
          z.array(reviewLine).max(200).safeParse(row.lines).success &&
            typeof row.original_text === "string" &&
            row.original_text.length <= 20000,
          "导入草稿",
        );
        if (owner) row.created_by = owner;
        if (!migration) row.preview = null;
        if (!migration && row.status === "extracting") {
          row.status = "failed";
          row.error_message = "备份中的识别已中断，请手动审核或重试。";
        }
      }
      if (
        !migration &&
        table === "extraction_attempts" &&
        row.status === "pending"
      ) {
        row.status = "failed";
        row.error_code = "restored";
        row.finished_at = new Date().toISOString();
      }
      const keys = Object.keys(row);
      check(
        keys.length > 0 &&
          keys.every((k) => columns.some((c) => c.column_name === k)),
        `${table} 包含未知字段`,
      );
      for (const key of keys) {
        const c = columns.find((c) => c.column_name === key)!;
        const v = row[key];
        if (v === null) continue;
        if (c.data_type === "integer")
          check(
            typeof v === "number" &&
              Number.isInteger(v) &&
              (!["version", "revision"].includes(key) || v > 0),
            `${table}.${key} 必须为有效整数`,
          );
        if (c.data_type === "boolean")
          check(typeof v === "boolean", `${table}.${key} 必须为是/否`);
        if (c.data_type === "jsonb") row[key] = JSON.stringify(v);
      }
      await tx.query(
        `INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => row[k]),
      );
    }
  }
  check(
    !(
      await tx.query(
        "SELECT i.id FROM order_items i JOIN picking_tasks t ON t.order_item_id=i.id WHERE i.unavailable<>(t.state='unavailable') LIMIT 1",
      )
    ).rows.length,
    "配货与缺货状态不一致",
  );
  check(
    !(
      await tx.query(
        "SELECT i.id FROM order_items i LEFT JOIN picking_tasks t ON t.order_item_id=i.id WHERE t.id IS NULL LIMIT 1",
      )
    ).rows.length,
    "缺少配货任务",
  );
  check(
    !(
      await tx.query(
        "SELECT o.id FROM orders o LEFT JOIN documents d ON d.id=o.finalized_document_id WHERE o.finalized_document_id IS NOT NULL AND (d.id IS NULL OR d.order_id<>o.id OR d.superseded_at IS NOT NULL) LIMIT 1",
      )
    ).rows.length,
    "定稿引用损坏",
  );
  check(
    !(
      await tx.query(
        "SELECT o.id FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id HAVING count(i.id)=0 OR count(i.id)>200 LIMIT 1",
      )
    ).rows.length,
    "订单商品数不完整",
  );
  const max = (
    await tx.query<{ maximum: string | null }>(
      "SELECT max(sequence_no)::text maximum FROM documents",
    )
  ).rows[0].maximum;
  const sequence = (
    await tx.query<{ value: string; is_called: boolean }>(
      "SELECT last_value::text value,is_called FROM delivery_document_no",
    )
  ).rows[0];
  await tx.query(
    "SELECT setval('delivery_document_no',greatest($1::bigint,$2::bigint),$3)",
    [max ?? "1", sequence.value, !!max || sequence.is_called],
  );
  await tx.query(
    "SELECT setval('restaurant_price_version',greatest((SELECT last_value FROM restaurant_price_version),coalesce((SELECT max(version) FROM restaurant_prices),1)),true)",
  );
}
export async function validateBackup(input: unknown) {
  let temp: PGlite | undefined;
  try {
    const data = payload(input);
    temp = new PGlite();
    await temp.waitReady;
    await temp.exec(schema);
    await temp.transaction(async (tx) => {
      await tx.query("DELETE FROM shop");
      await insertBackup(tx, data);
    });
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "备份验证失败：数据、金额或关联记录不完整，未修改现有资料。",
    );
  } finally {
    if (temp) await temp.close();
  }
}
async function stateHash(tx: Transaction) {
  const row = (
    await tx.query("SELECT generation,revision::text FROM app_state WHERE id=1")
  ).rows[0];
  return digest(JSON.stringify(row));
}
export async function previewRestore(actor: string, input: unknown) {
  const db = await getDb();
  await db.transaction((tx) => requireOwner(tx, actor));
  const data = await validateBackup(input);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM restore_previews WHERE expires_at<now()");
    const file =
      tx.backend === "postgres"
        ? await storeBlob(
            tx,
            Buffer.from(JSON.stringify(data)),
            "application/json",
            "temporary",
            new Date(Date.now() + 3600000).toISOString(),
          )
        : null;
    await tx.query(
      "INSERT INTO restore_previews(id,actor_id,payload,state_hash,expires_at,payload_asset_id) VALUES($1,$2,$3,$4,now()+interval '30 minutes',$5)",
      [
        id,
        actor,
        file ? "{}" : JSON.stringify(data),
        await stateHash(tx),
        file?.assetId ?? null,
      ],
    );
  });
  return {
    token: id,
    shopName: String(data.tables.shop[0].name),
    exportedAt: data.exportedAt,
    orders: data.tables.orders.length,
    products: data.tables.products.length,
    documents: data.tables.documents?.length ?? 0,
  };
}
export async function confirmRestore(actor: string, input: unknown) {
  const a = input as { token?: string; confirm?: boolean; shopName?: string };
  check(
    a &&
      typeof a.token === "string" &&
      a.confirm === true &&
      typeof a.shopName === "string",
    "请明确确认恢复",
  );
  const db = await getDb();
  return db.transaction(async (tx) => {
    await requireOwner(tx, actor);
    const preview = (
      await tx.query<{
        payload: Backup;
        state_hash: string;
        payload_asset_id: string | null;
      }>(
        "SELECT payload,state_hash,payload_asset_id FROM restore_previews WHERE id=$1 AND actor_id=$2 AND expires_at>now()",
        [a.token, actor],
      )
    ).rows[0];
    check(preview, "验证已过期，请重新选择文件");
    if (preview.payload_asset_id)
      preview.payload = JSON.parse(
        (await loadBlob(null, preview.payload_asset_id, tx)).toString("utf8"),
      );
    check(
      a.shopName === preview.payload.tables.shop[0].name,
      "请输入备份中的店名确认",
    );
    if ((await stateHash(tx)) !== preview.state_hash)
      throw new AppError("现有资料已变化，请重新验证备份后再恢复", 409);
    const safetyFile = `pre-restore-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
    if (tx.backend === "postgres")
      await saveCloudBackup(tx, safetyFile, "safety");
    else {
      const before = await backupIn(tx);
      const folder = path.join(
        path.dirname(
          process.env.SHOP_DATA_DIR ??
            path.join(process.cwd(), "data/postgres"),
        ),
        "backups",
      );
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, safetyFile), JSON.stringify(before), {
        flag: "wx",
      });
    }
    await tx.query("DELETE FROM operation_requests");
    await tx.query("DELETE FROM extraction_cache");
    await tx.query("DELETE FROM extraction_cooldown");
    for (const table of [...tables].reverse())
      await tx.query(`DELETE FROM ${table}`);
    await insertBackup(tx, preview.payload, actor);
    await tx.query("DELETE FROM sessions");
    await tx.query("UPDATE app_state SET generation=$1 WHERE id=1", [
      randomUUID(),
    ]);
    await tx.query("DELETE FROM restore_previews");
    await tx.query(
      "INSERT INTO change_records(id,actor_id,action,entity_id,details) VALUES($1,$2,'restoreBackup','1',$3)",
      [randomUUID(), actor, JSON.stringify({ safetyFile })],
    );
    const result = { restored: true, safetyFile };
    await completeRestoreJob(tx, result);
    return result;
  });
}
