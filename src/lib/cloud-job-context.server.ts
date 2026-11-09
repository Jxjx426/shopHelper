import { AsyncLocalStorage } from "node:async_hooks";
import type { Transaction } from "./db";
export const jobContext = new AsyncLocalStorage<string>();
export async function completeRestoreJob(tx: Transaction, response: unknown) {
  const id = jobContext.getStore();
  if (id)
    await tx.query(
      "UPDATE cloud_jobs SET status='succeeded',response=$1,finished_at=now() WHERE id=$2",
      [JSON.stringify(response), id],
    );
}
