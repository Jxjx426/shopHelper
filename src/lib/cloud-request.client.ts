"use client";
// Reuse only after a lost HTTP response. Completed requests release the key;
// background execution itself is never automatically submitted again.
const pending = new Map<string, string>();
export async function startFileRequest(url: string, init: RequestInit = {}) {
  const fingerprint = `${init.method ?? "GET"}:${url}:${typeof init.body === "string" ? init.body : ""}`;
  const key = pending.get(fingerprint) ?? crypto.randomUUID();
  pending.set(fingerprint, key);
  const headers = new Headers(init.headers);
  headers.set("Idempotency-Key", key);
  const response = await fetch(url, { ...init, headers });
  if (response.ok || response.status < 500) pending.delete(fingerprint);
  return response;
}
