import { backupChecksum } from "./backup-checksum";
import { todayMalaysia } from "./domain";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { z } from "zod";
import { getDb } from "./db";
import { cloudConfig } from "./cloud-config.server";
import { fileTicket, storeBlob, hash } from "./file-store.server";
import { requirePermission } from "./permissions.server";
import { requestSession } from "./request-session.server";
import { jobContext } from "./cloud-job-context.server";
import { AppError } from "./errors";
import { pdfSummarySchema, pdfLanguageSchema } from "./pdf-options";
const inputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("backup"),
    backupId: z.string().max(200).optional(),
  }),
  z.object({ kind: z.literal("daily-backup") }),
  z.object({ kind: z.literal("maintenance") }),
  z.object({ kind: z.literal("restore-preview"), uploadId: z.string().uuid() }),
  z.object({
    kind: z.literal("restore-confirm"),
    token: z.string().uuid(),
    shopName: z.string().max(80),
    confirm: z.literal(true),
  }),
  z.object({
    kind: z.literal("pdf-range"),
    from: z.string().max(10),
    to: z.string().max(10),
    query: z.string().max(80).default(""),
    summary: pdfSummarySchema.default("first"),
    language: pdfLanguageSchema.default("zh"),
  }),
]);
declare global {
  var shopJobDispatch:
    ((id: string, secret: string) => Promise<void>) | undefined;
}
export function cloudJobKey(actor: string, key: string | null) {
  if (!key) return undefined;
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(key)) throw new AppError("操作编号无效");
  return `${actor}:${key}`;
}
export async function createCloudJob(
  actor: string,
  sessionHash: string | null,
  input: unknown,
  dedupeKey?: string,
) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("后台任务输入无效");
  const a = parsed.data,
    db = await getDb(),
    id = randomUUID(),
    secret = randomBytes(32).toString("hex");
  const makeReceipt = (jobId: string) =>
    createHmac("sha256", cloudConfig().jwtSecret)
      .update(`receipt:${actor}:${jobId}`)
      .digest("hex");
  const receipt = makeReceipt(id);
  const result = await db.transaction(async (tx) => {
    await requirePermission(
      tx,
      actor,
      a.kind === "pdf-range" ? "work" : "manage",
    );
    if (dedupeKey) {
      const prior = (
        await tx.query<{ id: string; actor_id: string; input: unknown }>(
          "SELECT id,actor_id,input FROM cloud_jobs WHERE dedupe_key=$1",
          [dedupeKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.actor_id !== actor ||
          backupChecksum(prior.input) !== backupChecksum(a)
        )
          throw new AppError("操作编号已使用", 409);
        return { id: prior.id, reused: true };
      }
    }
    const pending = (
      await tx.query<{ count: number }>(
        "SELECT count(*)::int count FROM cloud_jobs WHERE actor_id=$1 AND status IN ('queued','running') AND created_at>now()-interval '20 minutes'",
        [actor],
      )
    ).rows[0].count;
    if (pending >= 2) throw new AppError("已有任务正在处理，请先等它完成", 429);
    await tx.query(
      "INSERT INTO cloud_jobs(id,actor_id,session_hash,kind,input,token_hash,receipt_hash,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        actor,
        sessionHash,
        a.kind,
        JSON.stringify(a),
        hash(secret),
        hash(receipt),
        dedupeKey ?? null,
      ],
    );
    return { id, reused: false };
  });
  if (!result.reused) {
    try {
      if (globalThis.shopJobDispatch)
        await globalThis.shopJobDispatch(id, secret);
      else {
        const response = await fetch(
          `${cloudConfig().origin}/.netlify/functions/shop-background`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, secret }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) throw new Error();
      }
    } catch {
      await db.query(
        "UPDATE cloud_jobs SET status='failed',error='后台任务未能启动，请检查连接后重试',finished_at=now() WHERE id=$1 AND status='queued'",
        [id],
      );
    }
  }
  return { jobId: result.id, receipt: makeReceipt(result.id) };
}
export async function jobStatus(
  actor: string | null,
  id: string,
  receipt?: string,
) {
  const db = await getDb();
  const row = (
    await db.query<any>(
      "SELECT id,actor_id,kind,status,response,error,receipt_hash FROM cloud_jobs WHERE id=$1 AND created_at>now()-interval '1 day'",
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError("任务不存在", 404);
  const receiptAllowed =
    row.kind === "restore-confirm" &&
    !!receipt &&
    hash(receipt) === row.receipt_hash &&
    row.status === "succeeded";
  if (actor !== row.actor_id && !receiptAllowed)
    throw new AppError("请使用原账号读取此任务", 403);
  if (!receiptAllowed)
    await db.transaction((tx) =>
      requirePermission(
        tx,
        actor!,
        row.kind === "pdf-range" ? "work" : "manage",
      ),
    );
  await db.query(
    "UPDATE cloud_jobs SET status='failed',error='任务已超时，请核对后重试',finished_at=now() WHERE id=$1 AND status IN ('running','queued') AND created_at<now()-interval '20 minutes'",
    [id],
  );
  if (row.status === "succeeded" && row.response?.assetId) {
    const ticket = await fileTicket(
      row.response.assetId,
      row.response.filename,
    );
    return {
      status: row.status,
      result: { ...ticket, count: row.response.count },
    };
  }
  return { status: row.status, result: row.response, error: row.error };
}
export async function processCloudJob(id: string, secret: string) {
  const db = await getDb();
  const job = await requestSession.exit(() =>
    db.transaction(async (tx) => {
      const row = (
        await tx.query<any>(
          "SELECT * FROM cloud_jobs WHERE id=$1 AND created_at>now()-interval '20 minutes'",
          [id],
        )
      ).rows[0];
      if (!row || row.token_hash !== hash(secret))
        throw new AppError("后台任务凭证无效", 403);
      if (row.status !== "queued") return null;
      await tx.query(
        "UPDATE cloud_jobs SET status='running',started_at=now() WHERE id=$1",
        [id],
      );
      return row;
    }),
  );
  if (!job) return;
  const work = () =>
    jobContext.run(id, async () => {
      try {
        await db.transaction((tx) =>
          requirePermission(
            tx,
            job.actor_id,
            job.kind === "pdf-range" ? "work" : "manage",
          ),
        );
        let response: unknown;
        if (job.kind === "maintenance") {
          const { cleanupCloudFiles } =
            await import("./cloud-maintenance.server");
          await cleanupCloudFiles();
          response = { cleaned: true };
        } else if (job.kind === "daily-backup") {
          const { saveCloudBackup } = await import("./cloud-backup.server"),
            { todayMalaysia } = await import("./domain");
          const backupId = `daily-${todayMalaysia()}.json`;
          await db.transaction((tx) => saveCloudBackup(tx, backupId, "daily"));
          const { cleanupCloudFiles } =
            await import("./cloud-maintenance.server");
          await cleanupCloudFiles();
          response = { backupId };
        } else if (job.kind === "restore-preview") {
          const { stagedFile } = await import("./uploads.server"),
            { previewRestore } = await import("./backup.server");
          const file = await stagedFile(
            job.actor_id,
            job.input.uploadId,
            "backup",
          );
          response = await previewRestore(
            job.actor_id,
            JSON.parse(file.bytes.toString("utf8")),
          );
        } else if (job.kind === "restore-confirm") {
          const { confirmRestore } = await import("./backup.server");
          response = await confirmRestore(job.actor_id, job.input);
        } else if (job.kind === "pdf-range") {
          const { rangeDocumentPdf } = await import("./document-export.server");
          const result = await rangeDocumentPdf(job.input);
          const file = await db.transaction((tx) =>
            storeBlob(
              tx,
              result.bytes,
              "application/pdf",
              "temporary",
              new Date(Date.now() + 86400000).toISOString(),
            ),
          );
          response = {
            assetId: file.assetId,
            filename: `Order-List-${job.input.from}-${job.input.to}${job.input.language === "en" ? "-en" : ""}.pdf`,
            count: result.count,
          };
        } else {
          const { exportBackup } = await import("./service"),
            { exportCloudRecord } = await import("./cloud-backup.server");
          const data = job.input.backupId
            ? await exportCloudRecord(job.input.backupId)
            : await exportBackup();
          const file = await db.transaction((tx) =>
            storeBlob(
              tx,
              Buffer.from(JSON.stringify(data)),
              "application/json",
              "temporary",
              new Date(Date.now() + 86400000).toISOString(),
            ),
          );
          response = {
            assetId: file.assetId,
            filename: `fresh-helper-${todayMalaysia()}.json`,
          };
        }
        // Restore writes its own completion in the same transaction as replacement.
        await requestSession.exit(() =>
          db.query(
            "UPDATE cloud_jobs SET status='succeeded',response=$1,finished_at=now() WHERE id=$2 AND status='running'",
            [JSON.stringify(response), id],
          ),
        );
      } catch (error) {
        await requestSession.exit(() =>
          db.query(
            "UPDATE cloud_jobs SET status='failed',error=$1,finished_at=now() WHERE id=$2 AND status='running'",
            [
              error instanceof AppError
                ? error.message
                : "后台处理失败，原数据未自动重试，请核对后再试",
              id,
            ],
          ),
        );
      }
    });
  if (job.session_hash) await requestSession.run(job.session_hash, work);
  else await requestSession.exit(work);
}
