import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { requirePermission } from "./permissions.server";
import { cloudConfig } from "./cloud-config.server";
import { fileStore, type FilePart } from "./file-store.server";
import { AppError } from "./errors";
export async function prepareUpload(actor: string, input: unknown) {
  const a = input as { kind?: string; mime?: string; size?: number };
  if (
    !["image", "backup"].includes(a.kind ?? "") ||
    !Number.isSafeInteger(a.size) ||
    !a.size ||
    a.size < 1 ||
    a.size > (a.kind === "image" ? 5 : 128) * 1024 * 1024 ||
    !(
      a.kind === "image"
        ? ["image/png", "image/jpeg", "image/webp"]
        : ["application/json"]
    ).includes(a.mime ?? "")
  )
    throw new AppError("上传文件类型或大小无效");
  const db = await getDb();
  if (db.backend !== "postgres") return { direct: false as const };
  return db.transaction(async (tx) => {
    await requirePermission(
      tx,
      actor,
      a.kind === "image" ? "import" : "manage",
    );
    const usage = (
      await tx.query<{ size: string }>(
        "SELECT coalesce(sum(size),0)::text size FROM staged_uploads",
      )
    ).rows[0];
    const files = (
      await tx.query<{ size: string }>(
        "SELECT coalesce(sum(size),0)::text size FROM file_assets",
      )
    ).rows[0];
    if (Number(files.size) + Number(usage.size) + a.size! > 900 * 1024 * 1024)
      throw new AppError(
        "云端存储接近免费保护上限，请先下载备份并处理空间",
        507,
      );
    if (Number(usage.size) + a.size! > 150 * 1024 * 1024)
      throw new AppError("待处理上传占用较多，请先完成已有上传", 429);
    if (
      (
        await tx.query<{ count: number }>(
          "SELECT count(*)::int count FROM staged_uploads WHERE actor_id=$1 AND expires_at>now()",
          [actor],
        )
      ).rows[0].count >= 20
    )
      throw new AppError("待处理上传较多，请先完成已有导入或稍后重试", 429);
    const id = randomUUID(),
      parts: FilePart[] = [],
      urls = [];
    for (let offset = 0; offset < a.size!; offset += 8 * 1024 * 1024) {
      const path = `staging/${actor}/${id}/${parts.length}`,
        size = Math.min(8 * 1024 * 1024, a.size! - offset);
      parts.push({ path, size });
      urls.push({ url: await fileStore().signUpload(path), size });
    }
    await tx.query(
      "INSERT INTO staged_uploads(id,actor_id,kind,mime,size,parts,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '2 hours')",
      [id, actor, a.kind, a.mime, a.size, JSON.stringify(parts)],
    );
    return {
      direct: true as const,
      id,
      parts: urls,
      publishableKey: cloudConfig().publishableKey,
    };
  });
}
export async function stagedFile(actor: string, id: string, kind: string) {
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    await requirePermission(tx, actor, kind === "image" ? "import" : "manage");
    return (
      await tx.query<{ parts: FilePart[]; size: string; mime: string }>(
        "SELECT parts,size,mime FROM staged_uploads WHERE id=$1 AND actor_id=$2 AND kind=$3 AND expires_at>now()",
        [id, actor, kind],
      )
    ).rows[0];
  });
  if (!row) throw new AppError("上传文件已过期或不属于此账号，请重新选择", 404);
  const parts = [];
  for (const part of row.parts) {
    const bytes = await fileStore().get(part.path);
    if (bytes.length !== part.size)
      throw new AppError("文件上传未完整完成，请重试", 409);
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== Number(row.size))
    throw new AppError("上传文件大小不符", 409);
  return { bytes, mime: row.mime };
}
