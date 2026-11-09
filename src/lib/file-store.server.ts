import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { cloudConfig } from "./cloud-config.server";
import { getDb, type Transaction } from "./db";
import { AppError } from "./errors";
export type FilePart = { path: string; size: number };
export type FileStore = {
  put(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(path: string): Promise<Buffer>;
  signRead(path: string): Promise<string>;
  signUpload(path: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
};
declare global {
  var shopFileStore: FileStore | undefined;
}
export function fileStore(): FileStore {
  if (globalThis.shopFileStore) return globalThis.shopFileStore;
  const config = cloudConfig();
  const client = createClient(config.url, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(60000) }),
    },
  });
  const bucket = client.storage.from(config.bucket);
  const store: FileStore = {
    async put(path, bytes, mime) {
      const { error } = await bucket.upload(path, bytes, {
        contentType: mime,
        upsert: false,
      });
      if (error) {
        // Content-addressed objects can remain after a rolled-back transaction.
        const { data } = await bucket.download(path);
        if (
          !data ||
          hash(Buffer.from(await data.arrayBuffer())) !== hash(bytes)
        )
          throw new AppError("云端文件保存失败，请检查免费存储额度与连接", 503);
      }
    },
    async get(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data)
        throw new AppError("云端文件读取失败，请检查连接和存储状态", 503);
      return Buffer.from(await data.arrayBuffer());
    },
    async signRead(path) {
      const { data, error } = await bucket.createSignedUrl(path, 120);
      if (error || !data)
        throw new AppError("文件下载链接未能生成，请重试", 503);
      return data.signedUrl;
    },
    async signUpload(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path, {
        upsert: false,
      });
      if (error || !data)
        throw new AppError("文件上传暂不可用，请检查免费存储额度", 503);
      return data.signedUrl;
    },
    async remove(paths) {
      if (paths.length) {
        const { error } = await bucket.remove(paths);
        if (error) throw new AppError("临时文件清理失败", 503);
      }
    },
  };
  globalThis.shopFileStore = store;
  return store;
}
export const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function storeBlob(
  tx: Transaction,
  bytes: Uint8Array,
  mime: string,
  kind = "business",
  expiresAt?: string,
) {
  if (tx.backend !== "postgres")
    return { bytes, assetId: null as string | null };
  const id = hash(bytes);
  const previous = (
    await tx.query("SELECT id FROM file_assets WHERE id=$1", [id])
  ).rows[0];
  if (!previous) {
    const usage = (
      await tx.query<{ size: string }>(
        "SELECT coalesce(sum(size),0)::text size FROM file_assets",
      )
    ).rows[0];
    const staged = (
      await tx.query<{ size: string }>(
        "SELECT coalesce(sum(size),0)::text size FROM staged_uploads",
      )
    ).rows[0];
    // Leave room for a downloadable full backup instead of consuming all
    // free storage with business files. Provider quota remains authoritative.
    const ceiling = kind === "temporary" ? 850 : 700;
    if (
      Number(usage.size) + bytes.length > ceiling * 1024 * 1024 ||
      Number(usage.size) + Number(staged.size) + bytes.length >
        900 * 1024 * 1024
    )
      throw new AppError(
        "云端文件接近免费容量保护上限，请先导出备份并由店主处理空间；不会自动升级",
        507,
      );
    const parts: FilePart[] = [];
    const chunkSize =
      mime === "application/json" ||
      mime === "application/gzip" ||
      bytes.length > 40 * 1024 * 1024
        ? 8 * 1024 * 1024
        : Math.max(bytes.length, 1);
    if (bytes.length > 128 * 1024 * 1024)
      throw new AppError("文件超过128MB限制");
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize),
        path = `objects/${id}/${parts.length}`;
      await fileStore().put(path, chunk, mime);
      parts.push({ path, size: chunk.length });
    }
    await tx.query(
      "INSERT INTO file_assets(id,mime,size,parts,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
      [id, mime, bytes.length, JSON.stringify(parts), kind, expiresAt ?? null],
    );
  }
  return { bytes: null, assetId: id };
}
export async function loadBlob(
  bytes: Uint8Array | null | undefined,
  id: string | null | undefined,
  tx?: Transaction,
): Promise<Buffer> {
  if (bytes) return Buffer.from(bytes);
  if (!id) throw new AppError("文件引用不完整，请检查备份", 409);
  const db = tx ?? (await getDb()),
    row = (
      await db.query<{ parts: FilePart[]; size: string }>(
        "SELECT parts,size FROM file_assets WHERE id=$1",
        [id],
      )
    ).rows[0];
  if (!row) throw new AppError("文件不存在", 404);
  const parts: Buffer[] = [];
  for (const part of row.parts) {
    const chunk = await fileStore().get(part.path);
    if (chunk.length !== part.size)
      throw new AppError("云端文件不完整，请重试", 503);
    parts.push(chunk);
  }
  const result = Buffer.concat(parts);
  if (result.length !== Number(row.size) || hash(result) !== id)
    throw new AppError("云端文件校验失败，未使用损坏内容", 503);
  return result;
}
export async function fileTicket(id: string, filename: string) {
  const row = (
    await (
      await getDb()
    ).query<{ parts: FilePart[]; size: string; mime: string }>(
      "SELECT parts,size,mime FROM file_assets WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError("文件不存在", 404);
  const parts = [];
  for (const part of row.parts) {
    const url = new URL(await fileStore().signRead(part.path));
    url.searchParams.set("download", filename);
    parts.push({ url: url.toString(), size: part.size });
  }
  return { filename, mime: row.mime, size: Number(row.size), parts };
}
