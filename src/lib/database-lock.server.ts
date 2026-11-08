import { open, readFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { AppError } from "./errors";
// PGlite is a single-process database. Refuse a second writer instead of risking
// a second Next.js instance opening the same persistent directory.
export async function acquireDatabaseLock(directory: string) {
  const filename = `${directory}.server.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(filename, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      const cleanup = () => {
        try {
          unlinkSync(filename);
        } catch {
          /* Already released. */
        }
      };
      process.once("exit", cleanup);
      return async () => {
        process.removeListener("exit", cleanup);
        await unlink(filename).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(filename, "utf8"));
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error(
          "Database lock is invalid; verify that all servers are stopped before removing the lock file",
        );
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(filename);
          continue;
        }
        throw probe;
      }
      throw new AppError(
        "数据库已由另一个服务打开，请先停止重复启动的服务，或使用原服务。",
        503,
      );
    }
  }
  throw new Error("Unable to acquire shop database lock");
}
