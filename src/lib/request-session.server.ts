import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
// Recheck a queued request under the database transaction lock. Revocation or
// restoration must invalidate requests that passed authentication before waiting.
export const requestSession = new AsyncLocalStorage<string>();
export function withRequestSession<T>(
  request: NextRequest,
  work: () => Promise<T>,
) {
  const token = request.cookies.get("fresh_session")?.value;
  return requestSession.run(
    token ? createHash("sha256").update(token).digest("hex") : "",
    work,
  );
}
