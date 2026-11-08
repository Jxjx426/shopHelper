import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { todayMalaysia } from "./domain";
import { backupIn } from "./service";
import { getDb } from "./db";
import { requestSession } from "./request-session.server";
export const backupStatus: {
  lastSuccess: string | null;
  error: string | null;
} = { lastSuccess: null, error: null };
export async function dailyBackup() {
  const folder =
    process.env.SHOP_BACKUP_DIR ??
    path.join(
      path.dirname(
        process.env.SHOP_DATA_DIR ?? path.join(process.cwd(), "data/postgres"),
      ),
      "backups",
    );
  const filename = `daily-${todayMalaysia()}.json`;
  await mkdir(folder, { recursive: true });
  try {
    const existing = await stat(path.join(folder, filename));
    backupStatus.lastSuccess = existing.mtime.toISOString();
    backupStatus.error = null;
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const backup = await (await getDb()).transaction(backupIn);
  // A temporary file prevents a power interruption from leaving a valid-looking
  // daily backup. Publish only after the full write and sync have completed.
  const { open, rename } = await import("node:fs/promises");
  const temporary = path.join(folder, `${filename}.${process.pid}.tmp`);
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(backup));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path.join(folder, filename));
  backupStatus.lastSuccess = new Date().toISOString();
  backupStatus.error = null;
  const files = (await readdir(/* turbopackIgnore: true */ folder))
    .filter((name) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse();
  // Only application-generated daily snapshots rotate. Never delete exports or
  // the pre-restore safety copies.
  for (const file of files.slice(14)) await unlink(path.join(folder, file));
}
export function startScheduledBackups() {
  if (process.env.SHOP_AUTO_BACKUP !== "true") return () => {};
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await requestSession.exit(() => dailyBackup());
    } catch {
      backupStatus.error =
        "自动备份失败，请检查备份目录和剩余空间，并立即手动导出。";
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void run(), 5000);
  const timer = setInterval(() => void run(), 60000);
  initial.unref();
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
