import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { resolvePrice } from "./pricing.server";
import { preparedImageSize } from "./image-limits";
import Decimal from "decimal.js";
import { z } from "zod";
import { getDb, type Transaction } from "./db";
import { AppError, apply, workspace } from "./service";
import {
  UNITS,
  quantity,
  validDate,
  type Order,
  type Product,
  type Restaurant,
  type Unit,
} from "./domain";
import {
  blankLine,
  buildReview,
  parseTextLocally,
  extractionSchema,
  lineProblems,
  sourceLines,
} from "./extraction";
import {
  extractionConfig,
  ExtractionFailure,
  GeminiExtractionProvider,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type OrderExtractionProvider,
  type ExtractionInput,
} from "./gemini.server";
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  PRIVACY_VERSION,
  normalizeName,
  type ConfirmationMode,
  type DraftSummary,
  type ImportDraft,
  type ImportPreview,
  type PlannedLine,
  type ReviewLine,
} from "./import-types";

const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function ensure(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new AppError(message, status);
}
const keySchema = z.string().regex(/^[a-zA-Z0-9-]{16,100}$/);
const imageInput = z
  .object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().max(7 * 1024 * 1024),
  })
  .strict();
const createSchema = z
  .object({
    restaurantId: z.string().min(1).max(100),
    date: z.string().refine(validDate),
    kind: z.enum(["text", "image"]),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    original: imageInput.optional(),
    prepared: imageInput.optional(),
  })
  .strict();
export const reviewLineInput = z
  .object({
    id: z.string().min(1).max(100),
    productText: z.string().max(100),
    productId: z.string().max(100),
    quantity: z.string().max(30),
    unit: z.union([z.enum(UNITS), z.literal("")]),
    disposition: z.enum(["item", "ignored"]),
    ignoreReason: z.string().max(200),
    reviewed: z.boolean(),
    saveAlias: z.boolean(),
  })
  .strict();
export const saveDraftSchema = z
  .object({
    version: z.number().int().positive(),
    restaurantId: z.string().min(1).max(100),
    lines: z.array(reviewLineInput).max(200),
    restaurantAcknowledged: z.boolean(),
    sourceChecked: z.boolean(),
  })
  .strict();
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

async function draftRow(
  tx: Transaction,
  actor: string,
  id: string,
  includeDeleted = false,
): Promise<ImportDraft> {
  const draft = (
    await tx.query<ImportDraft>(
      `SELECT d.*,d.delivery_date::text AS delivery_date,r.name restaurant_name,i.original_mime,i.prepared_mime,(SELECT count(*)::int FROM extraction_attempts a WHERE a.draft_id=d.id) attempts FROM import_drafts d JOIN restaurants r ON r.id=d.restaurant_id LEFT JOIN import_images i ON i.draft_id=d.id WHERE d.id=$1 AND d.created_by=$2`,
      [id, actor],
    )
  ).rows[0];
  ensure(draft, "导入草稿不存在", 404);
  ensure(
    includeDeleted || !draft.deleted_at,
    "草稿已删除，可在已删除草稿中恢复",
    404,
  );
  return draft;
}
function editable(draft: ImportDraft, version: number) {
  ensure(
    draft.version === version,
    "草稿已更新，请重新读取。不会覆盖其他更改。",
    409,
  );
  ensure(
    draft.status !== "confirmed",
    "这份草稿已确认，不会重复创建配货需求",
    409,
  );
  ensure(
    draft.status !== "extracting",
    "正在识别，请稍候。手动更改不会被覆盖。",
    409,
  );
}
async function audit(
  tx: Transaction,
  actor: string,
  action: string,
  id: string,
  details: unknown = {},
) {
  await tx.query(
    "INSERT INTO change_records(id,actor_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, action, id, JSON.stringify(details)],
  );
}
async function replay<T>(
  tx: Transaction,
  actor: string,
  key: string,
  hash: string,
  work: () => Promise<T>,
): Promise<T> {
  ensure(keySchema.safeParse(key).success, "操作编号无效");
  const prior = (
    await tx.query<{ actor_id: string; payload_hash: string; response: T }>(
      "SELECT * FROM operation_requests WHERE key=$1",
      [key],
    )
  ).rows[0];
  if (prior) {
    ensure(
      prior.actor_id === actor && prior.payload_hash === hash,
      "操作编号已用于其他内容",
      409,
    );
    return prior.response;
  }
  const response = await work();
  await tx.query(
    "INSERT INTO operation_requests(key,actor_id,payload_hash,response) VALUES($1,$2,$3,$4)",
    [key, actor, hash, JSON.stringify(response)],
  );
  return response;
}
async function raster(input: z.infer<typeof imageInput>, prepare = false) {
  ensure(/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64), "图片编码无效");
  const bytes = Buffer.from(input.base64, "base64");
  ensure(
    bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES,
    "图片不能超过5MB，请裁剪或另存较小截图",
  );
  try {
    const image = sharp(bytes, { limitInputPixels: 24000000, animated: false });
    const meta = await image.metadata();
    ensure(
      ["png", "jpeg", "webp"].includes(meta.format ?? "") &&
        (!meta.pages || meta.pages === 1),
      "只支持静态 PNG、JPG 或 WebP 截图",
    );
    ensure(
      meta.width && meta.height && meta.width <= 20000 && meta.height <= 20000,
      "图片尺寸不支持，请分成较小截图",
    );
    // Re-encoding removes EXIF and embedded metadata; originals remain visually intact.
    const dimensions =
      meta.orientation && meta.orientation >= 5
        ? { width: meta.height!, height: meta.width! }
        : { width: meta.width!, height: meta.height! };
    const cleaned = prepare
      ? await image
          .rotate()
          .resize(preparedImageSize(dimensions.width, dimensions.height))
          .jpeg({ quality: 94 })
          .toBuffer()
      : await image.rotate().png().toBuffer();
    ensure(
      cleaned.length <= MAX_IMAGE_BYTES * 2,
      "图片展开后太大，请裁剪成较小截图",
    );
    return { bytes: cleaned, mime: prepare ? "image/jpeg" : "image/png" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.startsWith("截图太长"))
      throw new AppError(error.message);
    throw new AppError("图片无法读取，请使用手机截图的 PNG/JPG 格式");
  }
}

export async function createImport(actor: string, key: string, input: unknown) {
  const parsed = createSchema.safeParse(input);
  ensure(parsed.success, "导入内容或日期无效");
  const a = parsed.data;
  if (a.kind === "text") {
    ensure(a.text?.trim(), "请先粘贴订单文字");
    ensure(
      a.text!.split(/\r\n?|\n/).length <= 200,
      "一次最多200行，请拆成较短订单",
    );
    ensure(!a.original && !a.prepared, "文字导入不能夹带图片");
  } else ensure(a.original && a.prepared, "请选择截图并确认用于识别的图片");
  const original = a.kind === "image" ? await raster(a.original!) : null;
  const prepared = a.kind === "image" ? await raster(a.prepared!, true) : null;
  const text = a.kind === "text" ? a.text!.replace(/\r\n?/g, "\n").trim() : "";
  const sourceHash = sha(a.kind === "text" ? text : original!.bytes);
  const inputHash = sha(JSON.stringify({ action: "createImport", ...a }));
  const db = await getDb();
  return db.transaction((tx) =>
    replay(tx, actor, key, inputHash, async () => {
      const restaurant = (
        await tx.query<Restaurant>(
          "SELECT * FROM restaurants WHERE id=$1 AND active=true",
          [a.restaurantId],
        )
      ).rows[0];
      ensure(restaurant, "请选择启用的餐馆");
      const previous = (
        await tx.query<{ id: string }>(
          "SELECT id FROM import_drafts WHERE created_by=$1 AND restaurant_id=$2 AND delivery_date=$3::date AND source_hash=$4 AND status<>'confirmed' AND deleted_at IS NULL ORDER BY created_at DESC",
          [actor, a.restaurantId, a.date, sourceHash],
        )
      ).rows;
      for (const prior of previous) {
        if (a.kind === "text") return { id: prior.id, reused: true };
        const image = (
          await tx.query<{ prepared_image: Uint8Array }>(
            "SELECT prepared_image FROM import_images WHERE draft_id=$1",
            [prior.id],
          )
        ).rows[0];
        if (image && sha(image.prepared_image) === sha(prepared!.bytes))
          return { id: prior.id, reused: true };
      }
      const id = randomUUID();
      const lines =
        a.kind === "text" ? parseTextLocally(text, await catalogIn(tx)) : [];
      await tx.query(
        "INSERT INTO import_drafts(id,created_by,restaurant_id,delivery_date,source_kind,original_text,source_hash,lines) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          actor,
          a.restaurantId,
          a.date,
          a.kind,
          text,
          sourceHash,
          JSON.stringify(lines),
        ],
      );
      if (original && prepared)
        await tx.query(
          "INSERT INTO import_images(draft_id,original_image,original_mime,prepared_image,prepared_mime) VALUES($1,$2,$3,$4,$5)",
          [id, original.bytes, original.mime, prepared.bytes, prepared.mime],
        );
      await audit(tx, actor, "createImport", id, {
        kind: a.kind,
        date: a.date,
      });
      return { id, reused: false };
    }),
  );
}
export async function getDraft(actor: string, id: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const draft = await draftRow(tx, actor, id);
    if (draft.status === "extracting") {
      const active = (
        await tx.query<{ started_at: Date }>(
          "SELECT started_at FROM extraction_attempts WHERE draft_id=$1 AND status='pending' ORDER BY started_at DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      if (
        Date.now() -
          new Date(active?.started_at ?? draft.updated_at).getTime() >
        70000
      ) {
        await tx.query(
          "UPDATE extraction_attempts SET status='failed',error_code='interrupted',finished_at=now() WHERE draft_id=$1 AND status='pending'",
          [id],
        );
        await tx.query(
          "UPDATE import_drafts SET status='failed',error_message='上次识别已中断，草稿仍保留。可手动重试或直接审核。',version=version+1,updated_at=now() WHERE id=$1",
          [id],
        );
        return draftRow(tx, actor, id);
      }
    }
    return draft;
  });
}
export async function listDrafts(actor: string, date: string, deleted = false) {
  ensure(validDate(date), "日期无效");
  const db = await getDb();
  return (
    await db.query<DraftSummary>(
      "SELECT d.id,r.name restaurant_name,d.delivery_date::text,d.source_kind,d.status,d.updated_at,d.version FROM import_drafts d JOIN restaurants r ON r.id=d.restaurant_id WHERE d.created_by=$1 AND d.delivery_date=$2::date AND d.status<>'confirmed' AND (d.deleted_at IS NOT NULL)=$3 ORDER BY d.updated_at DESC LIMIT 100",
      [actor, date, deleted],
    )
  ).rows;
}
export async function setDraftDeleted(
  actor: string,
  id: string,
  key: string,
  input: unknown,
) {
  const parsed = z
    .object({ version: z.number().int().positive(), deleted: z.boolean() })
    .strict()
    .safeParse(input);
  ensure(parsed.success, "删除请求无效，请重新读取草稿");
  const db = await getDb();
  return db.transaction((tx) =>
    replay(
      tx,
      actor,
      key,
      sha(JSON.stringify({ action: "setDraftDeleted", id, ...parsed.data })),
      async () => {
        const draft = await draftRow(tx, actor, id, true);
        editable(draft, parsed.data.version);
        ensure(
          Boolean(draft.deleted_at) !== parsed.data.deleted,
          parsed.data.deleted ? "草稿已删除" : "草稿已恢复",
          409,
        );
        await tx.query(
          "UPDATE import_drafts SET deleted_at=CASE WHEN $1 THEN now() ELSE NULL END,preview=NULL,version=version+1,updated_at=now() WHERE id=$2",
          [parsed.data.deleted, id],
        );
        await audit(
          tx,
          actor,
          parsed.data.deleted ? "deleteDraft" : "restoreDraft",
          id,
        );
        return { id };
      },
    ),
  );
}

export async function imageForDraft(
  actor: string,
  id: string,
  prepared: boolean,
) {
  const db = await getDb();
  await db.transaction((tx) => draftRow(tx, actor, id));
  const image = (
    await db.query<{
      original_image: Uint8Array;
      original_mime: string;
      prepared_image: Uint8Array;
      prepared_mime: string;
    }>("SELECT * FROM import_images WHERE draft_id=$1", [id])
  ).rows[0];
  ensure(image, "原图不存在", 404);
  return prepared
    ? { bytes: image.prepared_image, mime: image.prepared_mime }
    : { bytes: image.original_image, mime: image.original_mime };
}
export async function saveDraft(
  actor: string,
  id: string,
  key: string,
  input: unknown,
) {
  const parsed = saveDraftSchema.safeParse(input);
  ensure(parsed.success, "审核内容格式无效");
  const a = parsed.data;
  const db = await getDb();
  return db.transaction((tx) =>
    replay(tx, actor, key, sha(JSON.stringify({ id, ...a })), async () => {
      const draft = await draftRow(tx, actor, id);
      editable(draft, a.version);
      const restaurant = (
        await tx.query<Restaurant>(
          "SELECT * FROM restaurants WHERE id=$1 AND active=true",
          [a.restaurantId],
        )
      ).rows[0];
      ensure(restaurant, "请选择启用的餐馆");
      const ids = new Set(a.lines.map((l) => l.id));
      ensure(ids.size === a.lines.length, "审核行重复，请重新读取");
      ensure(
        draft.lines.every((line) => ids.has(line.id)),
        "不能静默删除原文行；请明确选择忽略并填写原因",
      );
      const catalog = await catalogIn(tx);
      const lines = a.lines.map((input) => {
        const original = draft.lines.find((l) => l.id === input.id);
        ensure(original || input.id.startsWith("manual-"), "不能伪造原文行");
        const line: ReviewLine = {
          ...(original ?? blankLine("", 0, input.id)),
          ...input,
          matchedBy:
            original?.productId === input.productId
              ? original.matchedBy
              : "manual",
        };
        if (line.reviewed)
          ensure(
            !lineProblems(line, catalog).length,
            `「${line.sourceText || "手动项目"}」尚未填写完整，不能确认此项`,
          );
        return line;
      });
      await tx.query(
        "UPDATE import_drafts SET restaurant_id=$1,lines=$2,restaurant_acknowledged=$3,source_checked=$4,status='review',preview=NULL,error_message=NULL,version=version+1,updated_at=now() WHERE id=$5",
        [
          a.restaurantId,
          JSON.stringify(lines),
          a.restaurantAcknowledged,
          a.sourceChecked,
          id,
        ],
      );
      return { id, version: draft.version + 1 };
    }),
  );
}
async function catalogIn(tx: Transaction): Promise<Product[]> {
  return (
    await tx.query<Product>(
      `SELECT p.*,coalesce((SELECT jsonb_agg(jsonb_build_object('orderUnit',u.order_unit,'billingUnit',u.billing_unit,'price',pr.amount::text)) FROM product_units u LEFT JOIN prices pr ON pr.product_id=u.product_id AND pr.billing_unit=u.billing_unit WHERE u.product_id=p.id),'[]'::jsonb) units FROM products p`,
    )
  ).rows;
}
export function restaurantMismatch(
  draft: Pick<
    ImportDraft,
    "restaurant_id" | "detected_restaurant" | "original_text"
  >,
  restaurants: Restaurant[],
): string[] {
  const lines = sourceLines(draft.original_text).map((l) =>
    normalizeName(l.text),
  );
  const detected = draft.detected_restaurant
    ? normalizeName(draft.detected_restaurant)
    : "";
  const other = restaurants.filter(
    (r) =>
      r.id !== draft.restaurant_id &&
      [r.name, ...r.aliases].some(
        (n) =>
          normalizeName(n) === detected || lines.includes(normalizeName(n)),
      ),
  );
  const selected = restaurants.find((r) => r.id === draft.restaurant_id);
  const unknownDetected =
    detected &&
    selected &&
    ![selected.name, ...selected.aliases].some(
      (n) => normalizeName(n) === detected,
    );
  return [
    ...new Set([
      ...other.map((r) => r.name),
      ...(unknownDetected ? [draft.detected_restaurant!] : []),
    ]),
  ];
}

export async function extractDraft(
  actor: string,
  id: string,
  key: string,
  input: unknown,
  provider: OrderExtractionProvider = new GeminiExtractionProvider(),
) {
  const a = z
    .object({
      version: z.number().int().positive(),
      privacyVersion: z.literal(PRIVACY_VERSION),
      redacted: z.literal(true),
      replaceExisting: z.boolean(),
      scope: z.enum(["unresolved", "all"]).default("all"),
      force: z.boolean().default(false),
    })
    .strict()
    .safeParse(input);
  ensure(a.success, "请先阅读免费层数据说明，并确认已去除敏感信息");
  ensure(keySchema.safeParse(key).success, "操作编号无效");
  const db = await getDb();
  const reservation = await db.transaction(async (tx) => {
    const prior = (
      await tx.query<{ draft_id: string; status: string }>(
        "SELECT draft_id,status FROM extraction_attempts WHERE request_key=$1 AND actor_id=$2",
        [key, actor],
      )
    ).rows[0];
    if (prior) {
      ensure(prior.draft_id === id, "此识别编号已用于其他草稿", 409);
      return { replayed: true as const };
    }
    const draft = await draftRow(tx, actor, id);
    editable(draft, a.data.version);
    const catalog = await catalogIn(tx);
    let rulesChanged = false;
    if (
      draft.source_kind === "text" &&
      a.data.scope === "unresolved" &&
      draft.version === 1 &&
      draft.status === "draft"
    ) {
      const local = parseTextLocally(draft.original_text, catalog);
      draft.lines = draft.lines.map((line) => {
        // Only untouched blank source rows from older drafts may be filled.
        if (
          line.reviewed ||
          line.disposition !== "item" ||
          line.productText ||
          line.productId ||
          line.quantity ||
          line.unit ||
          line.extractionIssues.length
        )
          return line;
        if (
          draft.lines.filter((other) => other.sourceLine === line.sourceLine)
            .length !== 1
        )
          return line;
        const parsed = local.find(
          (candidate) =>
            candidate.sourceLine === line.sourceLine &&
            candidate.sourceText === line.sourceText,
        );
        if (
          !parsed ||
          (!parsed.productText && !parsed.quantity && !parsed.unit)
        )
          return line;
        rulesChanged = true;
        return { ...parsed, id: line.id };
      });
    }
    const targets =
      draft.source_kind === "text" && a.data.scope === "unresolved"
        ? new Set(
            draft.lines
              .filter(
                (l) =>
                  !l.reviewed &&
                  l.disposition !== "ignored" &&
                  (lineProblems(l, catalog).length ||
                    l.extractionIssues.length) &&
                  !draft.lines.some(
                    (other) =>
                      other.sourceLine === l.sourceLine &&
                      (other.reviewed || other.disposition === "ignored"),
                  ),
              )
              .map((l) => l.sourceLine)
              .filter((n) => n > 0),
          )
        : null;
    if (targets && !targets.size) {
      if (rulesChanged)
        await tx.query(
          "UPDATE import_drafts SET lines=$1,preview=NULL,version=version+1,updated_at=now() WHERE id=$2",
          [JSON.stringify(draft.lines), id],
        );
      return { replayed: true as const };
    }
    ensure(
      targets ||
        a.data.replaceExisting ||
        !draft.lines.some(
          (l) => l.reviewed || l.productId || l.quantity || l.unit,
        ),
      "重新识别会替换审核项目，请明确确认后再试",
    );
    const config = extractionConfig();
    const image =
      draft.source_kind === "image"
        ? (
            await tx.query<{
              prepared_image: Uint8Array;
              prepared_mime: string;
            }>(
              "SELECT prepared_image,prepared_mime FROM import_images WHERE draft_id=$1",
              [id],
            )
          ).rows[0]
        : null;
    // Older saved drafts may still contain an oversized prepared image.
    if (image) {
      const raster = sharp(image.prepared_image, {
        limitInputPixels: 24000000,
      });
      const meta = await raster.metadata();
      let size;
      try {
        size = preparedImageSize(meta.width!, meta.height!);
      } catch {
        throw new AppError(
          "截图太长，缩小后文字难以辨认，请裁剪或分成多张截图",
        );
      }
      if (size.width !== meta.width || size.height !== meta.height) {
        image.prepared_image = await raster
          .resize(size)
          .jpeg({ quality: 94 })
          .toBuffer();
        image.prepared_mime = "image/jpeg";
        await tx.query(
          "UPDATE import_images SET prepared_image=$1,prepared_mime=$2 WHERE draft_id=$3",
          [image.prepared_image, image.prepared_mime, id],
        );
      }
    }
    // Blank excluded lines to retain original physical line numbers.
    const providerInput: ExtractionInput =
      draft.source_kind === "text"
        ? {
            kind: "text",
            text: targets
              ? draft.original_text
                  .split("\n")
                  .map((line, i) => (targets.has(i + 1) ? line : ""))
                  .join("\n")
              : draft.original_text,
          }
        : {
            kind: "image",
            data: image!.prepared_image,
            mimeType: image!.prepared_mime,
          };
    const cacheKey = sha(
      JSON.stringify([
        actor,
        provider.name,
        config.model,
        PROMPT_VERSION,
        SCHEMA_VERSION,
        providerInput.kind === "text"
          ? providerInput.text
          : [providerInput.mimeType, sha(providerInput.data)],
      ]),
    );
    const cached = !a.data.force
      ? (
          await tx.query<{ result: unknown }>(
            "SELECT result FROM extraction_cache WHERE cache_key=$1 AND actor_id=$2",
            [cacheKey, actor],
          )
        ).rows[0]
      : null;
    const cachedResult = cached
      ? extractionSchema.safeParse(cached.result)
      : null;
    const cache = cachedResult?.success ? cachedResult.data : null;
    if (!cache && !config.enabled) return { disabled: config.reason };
    const cooldown = (
      await tx.query<{ until_at: Date }>(
        "SELECT until_at FROM extraction_cooldown WHERE id=1 AND until_at>now()",
      )
    ).rows[0];
    ensure(
      cache || !cooldown,
      "Gemini 正在冷却，请稍后重试或直接手动审核。草稿已保留。",
      429,
    );
    const quotaDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const counts = (
      await tx.query<{ minute_count: number; day_count: number }>(
        "SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute_count,count(*) FILTER(WHERE quota_day=$1)::int AS day_count FROM extraction_attempts",
        [quotaDay],
      )
    ).rows[0];
    ensure(
      cache || counts.minute_count < config.maxRpm,
      "已达到本店每分钟识别上限，请稍后重试或手动审核。",
      429,
    );
    ensure(
      cache || counts.day_count < config.maxRpd,
      "已达到本店今日识别上限，请使用手动审核。不会启用付费服务。",
      429,
    );
    const attemptId = randomUUID();
    if (!cache)
      await tx.query(
        "INSERT INTO extraction_attempts(id,draft_id,actor_id,request_key,provider,model,prompt_version,schema_version,quota_day) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          attemptId,
          id,
          actor,
          key,
          provider.name,
          config.model,
          PROMPT_VERSION,
          SCHEMA_VERSION,
          quotaDay,
        ],
      );
    await tx.query(
      "UPDATE import_drafts SET status='extracting',lines=$2,error_message=NULL,preview=NULL,version=version+1,updated_at=now() WHERE id=$1",
      [id, JSON.stringify(draft.lines)],
    );
    await audit(tx, actor, "geminiConsent", id, {
      privacyVersion: PRIVACY_VERSION,
      redacted: true,
      model: config.model,
    });
    return {
      draft,
      attemptId: cache ? null : attemptId,
      reservedVersion: draft.version + 1,
      providerInput,
      cache,
      cacheKey,
      targets,
    };
  });
  if ("replayed" in reservation) return { id, replayed: true };
  if ("disabled" in reservation) throw new AppError(reservation.disabled!, 503);
  try {
    const raw =
      reservation.cache ?? (await provider.extract(reservation.providerInput));
    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.lines.length)
      throw new ExtractionFailure(
        "识别结果无效，草稿仍保留，请手动审核。",
        "invalid_output",
      );
    await db.transaction(async (tx) => {
      const current = await draftRow(tx, actor, id);
      ensure(
        current.version === reservation.reservedVersion &&
          current.status === "extracting",
        "识别期间草稿已改变，未覆盖你的内容",
        409,
      );
      const catalog = await catalogIn(tx);
      let lines = buildReview(
        parsed.data,
        reservation.draft.source_kind === "text"
          ? reservation.draft.original_text
          : null,
        catalog,
      );
      if (reservation.targets) {
        const replacements = lines
          .filter((l) => reservation.targets!.has(l.sourceLine))
          .map((l) => ({ ...l, id: `ai-${randomUUID()}` }));
        lines = [
          ...current.lines.filter(
            (l) => !reservation.targets!.has(l.sourceLine),
          ),
          ...replacements,
        ].sort((a, b) => (a.sourceLine || 201) - (b.sourceLine || 201));
      }
      ensure(
        lines.length > 0 && lines.length <= 200,
        "识别项目太多或没有可读内容，请手动处理",
      );
      let detected = parsed.data.detectedRestaurant;
      if (
        detected &&
        reservation.draft.source_kind === "text" &&
        !normalizeName(reservation.draft.original_text).includes(
          normalizeName(detected),
        )
      )
        detected = null;
      const warning =
        parsed.data.unreadableContent ||
        reservation.draft.source_kind === "image" ||
        parsed.data.lines.some(
          (l) => !lines.some((r) => r.sourceLine === l.sourceLine),
        );
      await tx.query(
        "UPDATE import_drafts SET lines=$1,detected_restaurant=$2,restaurant_acknowledged=false,source_checked=false,status='review',extraction_warning=$3,version=version+1,updated_at=now() WHERE id=$4",
        [JSON.stringify(lines), detected, warning, id],
      );
      await tx.query(
        "INSERT INTO extraction_cache(cache_key,actor_id,result) VALUES($1,$2,$3) ON CONFLICT(cache_key) DO UPDATE SET result=excluded.result,created_at=now()",
        [reservation.cacheKey, actor, JSON.stringify(parsed.data)],
      );
      if (reservation.attemptId)
        await tx.query(
          "UPDATE extraction_attempts SET status='succeeded',finished_at=now() WHERE id=$1",
          [reservation.attemptId],
        );
    });
    return { id, replayed: false, cached: !!reservation.cache };
  } catch (error) {
    const failure =
      error instanceof ExtractionFailure
        ? error
        : new ExtractionFailure(
            "识别未完成，原稿和手动内容仍保留，请重新读取后审核。",
            "interrupted",
          );
    await db.transaction(async (tx) => {
      if (reservation.attemptId)
        await tx.query(
          "UPDATE extraction_attempts SET status='failed',error_code=$1,finished_at=now() WHERE id=$2",
          [failure.code, reservation.attemptId],
        );
      await tx.query(
        "UPDATE import_drafts SET status='failed',error_message=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 AND status='extracting'",
        [failure.message, id, reservation.reservedVersion],
      );
      if (failure.cooldownSeconds)
        await tx.query(
          "INSERT INTO extraction_cooldown(id,until_at) VALUES(1,now()+$1::integer*interval '1 second') ON CONFLICT(id) DO UPDATE SET until_at=greatest(extraction_cooldown.until_at,excluded.until_at)",
          [failure.cooldownSeconds],
        );
    });
    return { id, error: failure.message };
  }
}

async function plan(
  tx: Transaction,
  actor: string,
  draft: ImportDraft,
  mode: ConfirmationMode,
): Promise<ImportPreview> {
  ensure(draft.source_checked, "请先对照原文或原图，确认没有遗漏内容");
  const catalog = await catalogIn(tx);
  ensure(
    draft.lines.length &&
      draft.lines.every((l) => l.reviewed && !lineProblems(l, catalog).length),
    "还有项目未确认，请逐项确认或明确忽略",
  );
  const included = draft.lines.filter((l) => l.disposition === "item");
  ensure(included.length, "至少需要一项已确认商品");
  const restaurants = (await tx.query<Restaurant>("SELECT * FROM restaurants"))
    .rows;
  ensure(
    !restaurantMismatch(draft, restaurants).length ||
      draft.restaurant_acknowledged,
    "原文餐馆名称与所选餐馆不一致，请先明确处理",
  );
  const restaurant = restaurants.find(
    (r) => r.id === draft.restaurant_id && r.active,
  );
  ensure(restaurant, "餐馆已停用");
  const existing = (
    await tx.query<Order>(
      "SELECT *,delivery_date::text AS delivery_date FROM orders WHERE restaurant_id=$1 AND delivery_date=$2::date AND deleted_at IS NULL",
      [draft.restaurant_id, draft.delivery_date],
    )
  ).rows[0];
  ensure(
    !existing || !existing.picking_started_at,
    "该餐馆已开始配货，不能追加、替换或更改订购项目",
    409,
  );
  ensure(
    existing ? mode !== "new" : mode === "new",
    existing
      ? "当天已有订单，请明确选择追加或替换"
      : "当天没有原订单，请选择新增",
    409,
  );
  const groups = new Map<string, PlannedLine>();
  if (existing && mode === "append") {
    const items = (
      await tx.query<{
        id: string;
        product_id: string;
        product_name: string;
        ordered_quantity: string;
        ordered_unit: Unit;
        billing_unit: Unit;
        price_snapshot: string | null;
        actual_confirmed: boolean;
      }>("SELECT * FROM order_items WHERE order_id=$1 ORDER BY position", [
        existing.id,
      ])
    ).rows;
    for (const item of items)
      groups.set(`${item.product_id}:${item.ordered_unit}`, {
        productId: item.product_id,
        name: item.product_name,
        quantity: quantity(item.ordered_quantity),
        unit: item.ordered_unit,
        billingUnit: item.billing_unit,
        price: item.price_snapshot,
        existingItemId: item.id,
        sourceLineIds: [],
        changesQuantity: false,
        resetsActual: false,
      });
  }
  let merged = 0;
  for (const line of included) {
    const p = catalog.find((p) => p.id === line.productId && p.active)!;
    const rule = p.units.find((u) => u.orderUnit === line.unit)!;
    const key = `${p.id}:${line.unit}`;
    const prior = groups.get(key);
    if (prior) {
      ensure(
        prior.billingUnit === rule.billingUnit,
        `${p.name} 的计价方式与原订单不同，请使用明确替换流程`,
      );
      prior.quantity = quantity(
        new Decimal(prior.quantity).plus(line.quantity).toString(),
      );
      prior.changesQuantity = true;
      prior.sourceLineIds.push(line.id);
      merged++;
      if (prior.existingItemId)
        prior.resetsActual = Boolean(
          (
            await tx.query<{ actual_confirmed: boolean }>(
              "SELECT actual_confirmed FROM order_items WHERE id=$1",
              [prior.existingItemId],
            )
          ).rows[0]?.actual_confirmed,
        );
    } else
      groups.set(key, {
        productId: p.id,
        name: p.name,
        quantity: quantity(line.quantity),
        unit: line.unit as Unit,
        billingUnit: rule.billingUnit,
        price: await resolvePrice(
          tx,
          draft.restaurant_id,
          p.id,
          rule.billingUnit,
        ),
        existingItemId: null,
        sourceLineIds: [line.id],
        changesQuantity: false,
        resetsActual: false,
      });
  }
  const identical =
    (
      await tx.query(
        "SELECT id FROM import_drafts WHERE id<>$1 AND restaurant_id=$2 AND delivery_date=$3::date AND source_hash=$4 AND status='confirmed' LIMIT 1",
        [draft.id, draft.restaurant_id, draft.delivery_date, draft.source_hash],
      )
    ).rows.length > 0;
  const result = {
    mode,
    orderId: existing?.id ?? null,
    orderVersion: existing?.version ?? null,
    restaurantName: restaurant.name,
    date: draft.delivery_date,
    lines: [...groups.values()],
    mergedRows: merged,
    missingPrices: [...groups.values()].filter((l) => l.price === null).length,
    identicalSource: identical,
  };
  return { ...result, token: sha(JSON.stringify(result)) };
}
export async function previewImport(
  actor: string,
  id: string,
  version: number,
  mode: ConfirmationMode,
) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const draft = await draftRow(tx, actor, id);
    editable(draft, version);
    const preview = await plan(tx, actor, draft, mode);
    await tx.query("UPDATE import_drafts SET preview=$1 WHERE id=$2", [
      JSON.stringify(preview),
      id,
    ]);
    return preview;
  });
}
export async function confirmImport(
  actor: string,
  id: string,
  key: string,
  input: unknown,
) {
  const parsed = z
    .object({
      version: z.number().int().positive(),
      token: z.string().length(64),
      identicalAcknowledged: z.boolean(),
    })
    .strict()
    .safeParse(input);
  ensure(parsed.success, "请先核对最终订单预览");
  const a = parsed.data;
  const db = await getDb();
  return db.transaction((tx) =>
    replay(tx, actor, key, sha(JSON.stringify({ id, ...a })), async () => {
      const draft = await draftRow(tx, actor, id);
      if (draft.status === "confirmed" && draft.confirmed_order_id)
        return { id: draft.confirmed_order_id };
      editable(draft, a.version);
      const stored = (
        await tx.query<{ preview: ImportPreview | null }>(
          "SELECT preview FROM import_drafts WHERE id=$1",
          [id],
        )
      ).rows[0].preview;
      ensure(stored && stored.token === a.token, "请重新核对最终订单预览", 409);
      const current = await plan(tx, actor, draft, stored.mode);
      ensure(
        current.token === a.token,
        "商品、价格或原订单已改变，请重新预览。草稿仍保留。",
        409,
      );
      ensure(
        !current.identicalSource ||
          current.mode !== "append" ||
          a.identicalAcknowledged,
        "这份原文已经导入过，请确认确实需要追加相同数量",
      );
      for (const line of draft.lines.filter(
        (l) => l.disposition === "item" && l.saveAlias,
      )) {
        const term = line.productText.trim();
        ensure(
          term &&
            term.length <= 80 &&
            normalizeName(line.sourceText).includes(normalizeName(term)),
          "别名必须来自原文中的商品文字",
        );
        const products = await catalogIn(tx);
        const chosen = products.find((p) => p.id === line.productId)!;
        const collision = products.some(
          (p) =>
            p.id !== chosen.id &&
            [p.name, ...p.aliases].some(
              (n) => normalizeName(n) === normalizeName(term),
            ),
        );
        ensure(
          !collision,
          `「${term}」已用于其他商品，请取消保存别名并核对商品选择`,
        );
        if (
          ![chosen.name, ...chosen.aliases].some(
            (n) => normalizeName(n) === normalizeName(term),
          )
        )
          await tx.query(
            "UPDATE products SET aliases=array_append(aliases,$1),version=version+1 WHERE id=$2",
            [term, chosen.id],
          );
      }
      let orderId = current.orderId;
      if (current.mode !== "append") {
        const urgent = current.orderId
          ? Boolean(
              (
                await tx.query<{ urgent: boolean }>(
                  "SELECT urgent FROM orders WHERE id=$1",
                  [current.orderId],
                )
              ).rows[0]?.urgent,
            )
          : false;
        const result = await apply(tx, actor, {
          action: "saveOrder",
          ...(current.mode === "replace"
            ? { id: current.orderId!, version: current.orderVersion! }
            : {}),
          restaurantId: draft.restaurant_id,
          date: draft.delivery_date,
          urgent,
          items: current.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unit: l.unit,
          })),
        });
        orderId = result.id;
      } else {
        for (const line of current.lines.filter(
          (l) => l.sourceLineIds.length,
        )) {
          if (line.existingItemId)
            await tx.query(
              "UPDATE order_items SET ordered_quantity=$1,actual_quantity=NULL,actual_unit=NULL,actual_confirmed=false,amount=NULL,version=version+1,updated_at=now() WHERE id=$2",
              [line.quantity, line.existingItemId],
            );
          else {
            const p = (
              await tx.query<{ zone_id: string }>(
                "SELECT zone_id FROM products WHERE id=$1",
                [line.productId],
              )
            ).rows[0];
            const itemId = randomUUID();
            await tx.query(
              "INSERT INTO order_items(id,order_id,product_id,product_name,zone_id,position,ordered_quantity,ordered_unit,billing_unit,price_snapshot) VALUES($1,$2,$3,$4,$5,(SELECT coalesce(max(position),-1)+1 FROM order_items WHERE order_id=$2),$6,$7,$8,$9)",
              [
                itemId,
                orderId,
                line.productId,
                line.name,
                p.zone_id,
                line.quantity,
                line.unit,
                line.billingUnit,
                line.price,
              ],
            );
            await tx.query(
              "INSERT INTO picking_tasks(id,order_item_id) VALUES($1,$2)",
              [randomUUID(), itemId],
            );
          }
        }
        await tx.query("UPDATE orders SET version=version+1 WHERE id=$1", [
          orderId,
        ]);
      }
      for (const line of current.lines.filter((l) => l.sourceLineIds.length)) {
        const refs = line.sourceLineIds.map((lineId) => ({
          draftId: id,
          lineId,
        }));
        await tx.query(
          "UPDATE order_items SET source_refs=source_refs || $1::jsonb WHERE order_id=$2 AND product_id=$3 AND ordered_unit=$4",
          [JSON.stringify(refs), orderId, line.productId, line.unit],
        );
      }
      const source =
        draft.source_kind === "text" ? draft.original_text : `[截图导入 ${id}]`;
      await tx.query(
        "UPDATE orders SET original_text=CASE WHEN $1='append' AND original_text IS NOT NULL THEN original_text || E'\\n\\n' || $2 ELSE $2 END WHERE id=$3",
        [current.mode, source, orderId],
      );
      await tx.query(
        "UPDATE import_drafts SET status='confirmed',confirmed_order_id=$1,preview=NULL,version=version+1,updated_at=now() WHERE id=$2",
        [orderId, id],
      );
      await audit(tx, actor, "confirmImport", id, {
        orderId,
        mode: current.mode,
        mergedRows: current.mergedRows,
      });
      return { id: orderId! };
    }),
  );
}

export async function supplementDraft(
  actor: string,
  id: string,
  key: string,
  version: number,
  text: string,
) {
  ensure(text.trim() && text.length <= MAX_TEXT_LENGTH, "请输入需要补充的文字");
  const db = await getDb();
  return db.transaction((tx) =>
    replay(
      tx,
      actor,
      key,
      sha(JSON.stringify({ id, version, text })),
      async () => {
        const draft = await draftRow(tx, actor, id);
        editable(draft, version);
        const extra = sourceLines(text).map((line, index) =>
          blankLine(line.text, 0, `manual-${randomUUID()}-${index}`),
        );
        ensure(
          draft.lines.length + extra.length <= 200,
          "最多200项，请分开处理",
        );
        await tx.query(
          "UPDATE import_drafts SET lines=$1,status='review',source_checked=false,preview=NULL,version=version+1,updated_at=now() WHERE id=$2",
          [JSON.stringify([...draft.lines, ...extra]), id],
        );
        return { id };
      },
    ),
  );
}
