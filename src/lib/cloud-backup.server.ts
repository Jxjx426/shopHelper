import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { Transaction } from "./db";
import { getDb } from "./db";
import { collectBackupIn, finishBackup } from "./service";
import { loadBlob, storeBlob } from "./file-store.server";
import { AppError } from "./errors";
const zip = promisify(gzip),
  unzip = promisify(gunzip);
export async function saveCloudBackup(
  tx: Transaction,
  id: string,
  kind: "daily" | "safety",
) {
  const manifest = {
    format: "shop-cloud-manifest-v1",
    data: await collectBackupIn(tx),
  };
  const bytes = await zip(Buffer.from(JSON.stringify(manifest)));
  const file = await storeBlob(
    tx,
    bytes,
    "application/gzip",
    "backup_manifest",
  );
  await tx.query(
    "INSERT INTO backup_records(id,asset_id,kind) VALUES($1,$2,$3)",
    [id, file.assetId, kind],
  );
  return file.assetId!;
}
export async function exportCloudRecord(id: string) {
  const row = (
    await (
      await getDb()
    ).query<{ asset_id: string }>(
      "SELECT asset_id FROM backup_records WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError("备份记录不存在", 404);
  const bytes = await loadBlob(null, row.asset_id),
    manifest = JSON.parse((await unzip(bytes)).toString("utf8"));
  if (manifest.format !== "shop-cloud-manifest-v1")
    throw new AppError("云内备份格式无效");
  return finishBackup(manifest.data);
}
