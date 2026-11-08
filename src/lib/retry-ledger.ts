// Device-only retry identifiers. The server remains the source of truth.
// Never persist account forms, which can contain passwords.
export function retryKey(
  storage: Pick<Storage, "getItem" | "setItem">,
  user: string,
  signature: string,
  create: () => string,
) {
  const key = `fresh-helper-retries:${user}`;
  let entries: [string, string][] = [];
  try {
    entries = JSON.parse(storage.getItem(key) ?? "[]");
  } catch {
    /* ignore invalid device cache */
  }
  if (!Array.isArray(entries)) entries = [];
  const found = entries.find((e) => Array.isArray(e) && e[0] === signature);
  if (found) return found[1];
  const id = create();
  storage.setItem(
    key,
    JSON.stringify([...entries.slice(-29), [signature, id]]),
  );
  return id;
}
export function forgetRetry(
  storage: Pick<Storage, "getItem" | "setItem">,
  user: string,
  signature: string,
) {
  const key = `fresh-helper-retries:${user}`;
  try {
    const entries = JSON.parse(storage.getItem(key) ?? "[]");
    if (Array.isArray(entries))
      storage.setItem(
        key,
        JSON.stringify(entries.filter((e: string[]) => e[0] !== signature)),
      );
  } catch {
    /* A stale retry identifier cannot bypass server versions. */
  }
}
