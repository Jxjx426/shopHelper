import { getDb } from "./db";
import { fileStore, type FilePart } from "./file-store.server";
import { cloudConfig } from "./cloud-config.server";
export async function cleanupCloudFiles() {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const expired = (
      await tx.query<{ id: string; parts: FilePart[] }>(
        "SELECT id,parts FROM staged_uploads WHERE expires_at<now()-interval '1 hour' LIMIT 100",
      )
    ).rows;
    for (const row of expired) {
      await fileStore().remove(row.parts.map((p) => p.path));
      await tx.query("DELETE FROM staged_uploads WHERE id=$1", [row.id]);
    }
    await tx.query("DELETE FROM restore_previews WHERE expires_at<now()");
    await tx.query(
      "DELETE FROM backup_records WHERE kind='daily' AND id IN (SELECT id FROM backup_records WHERE kind='daily' ORDER BY created_at DESC OFFSET 14)",
    );
    await tx.query(
      "UPDATE file_assets SET expires_at=now() WHERE kind='backup_manifest' AND NOT EXISTS(SELECT 1 FROM backup_records b WHERE b.asset_id=file_assets.id)",
    );
    const unused = (
      await tx.query<{ id: string; parts: FilePart[] }>(
        `SELECT f.id,f.parts FROM file_assets f WHERE f.expires_at<now() AND NOT EXISTS(SELECT 1 FROM backup_records b WHERE b.asset_id=f.id) AND NOT EXISTS(SELECT 1 FROM restore_previews r WHERE r.payload_asset_id=f.id) AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.pdf_asset_id=f.id OR d.superseded_asset_id=f.id) AND NOT EXISTS(SELECT 1 FROM import_images i WHERE i.original_asset_id=f.id OR i.prepared_asset_id=f.id) AND NOT EXISTS(SELECT 1 FROM document_views v WHERE v.asset_id=f.id) LIMIT 100`,
      )
    ).rows;
    for (const row of unused) {
      await fileStore().remove(row.parts.map((p) => p.path));
      await tx.query("DELETE FROM file_assets WHERE id=$1", [row.id]);
    }
    await tx.query(
      "DELETE FROM cloud_jobs WHERE created_at<now()-interval '7 days' AND status NOT IN ('queued','running')",
    );
    // Storage writes are outside the SQL transaction. Clean only unreferenced
    // content-addressed objects older than a day, while holding the writer lock.
    // Never delete catalogue rows directly: removal must go through Storage API.
    if (
      (await tx.query("SELECT to_regclass('storage.objects') object_table"))
        .rows[0]?.object_table
    ) {
      const orphans = (
        await tx.query<{ name: string }>(
          "SELECT name FROM storage.objects o WHERE bucket_id=$1 AND created_at<now()-interval '1 day' AND name ~ '^objects/[a-f0-9]{64}/[0-9]+$' AND NOT EXISTS(SELECT 1 FROM file_assets f WHERE f.id=split_part(o.name,'/',2)) LIMIT 100",
          [cloudConfig().bucket],
        )
      ).rows;
      await fileStore().remove(orphans.map((o) => o.name));
    }
  });
}
