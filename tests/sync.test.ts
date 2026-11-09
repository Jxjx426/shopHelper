import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { startWorkspaceSync } from "../src/lib/workspace-sync.client";
import { getDb } from "../src/lib/db";
import { makeSession } from "../src/lib/auth";
import { GET as events } from "../src/app/api/sync/events/route";
import { NextRequest } from "next/server";

test("idle sync requests only light metadata once per minute; hidden/offline pages close connections and stop polling; cleanup ignores late responses", async (t) => {
  const saved = Object.fromEntries(
    ["document", "window", "navigator", "EventSource", "fetch"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const doc = new EventTarget() as EventTarget & { hidden: boolean };
  doc.hidden = false;
  const win = new EventTarget(),
    nav = { onLine: true },
    calls: string[] = [],
    health: string[] = [];
  let changes = 0;
  class Source {
    static all: Source[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public url: string) {
      Source.all.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const install = (k: string, value: unknown) =>
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value,
    });
  install("document", doc);
  install("window", win);
  install("navigator", nav);
  install("EventSource", Source);
  install("fetch", async (url: string) => {
    calls.push(url);
    return new Response(
      JSON.stringify({ mode: "local", generation: "test", revision: "1" }),
    );
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  let stop = () => {};
  try {
    stop = startWorkspaceSync(
      () => changes++,
      (value) => health.push(value),
      () => {},
    );
    await flush();
    assert.deepEqual(calls, ["/api/sync"]);
    Source.all[0].onopen?.();
    const initial = changes;
    t.mock.timers.tick(59000);
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(calls, ["/api/sync", "/api/sync?light=1"]);
    assert.equal(changes, initial);
    Source.all[0].onmessage?.({ data: "2" });
    assert.equal(changes, initial + 1);
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    assert(Source.all[0].closed);
    const before = calls.length;
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(calls.length, before);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(calls.at(-1), "/api/sync");
    nav.onLine = false;
    win.dispatchEvent(new Event("offline"));
    assert(Source.all.at(-1)!.closed);
    const offline = calls.length;
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(calls.length, offline);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await flush();
    assert.equal(calls.length, offline + 1);
    Source.all.at(-1)!.onerror?.();
    t.mock.timers.tick(60000);
    await flush();
    const slow = calls.length;
    t.mock.timers.tick(15000);
    await flush();
    assert.equal(calls.length, slow + 1);
    stop();
    const ended = calls.length;
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(calls.length, ended);
    assert(!calls.some((u) => u.includes("workspace")));
    assert(health.includes("slow"));
  } finally {
    stop();
    t.mock.timers.reset();
    for (const [k, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
test("local SSE receives committed revision notifications without periodic full workspace reads and closes on abort", async () => {
  process.env.SHOP_BACKEND = "local";
  process.env.SHOP_DATA_DIR = path.join(
    process.cwd(),
    "test-results",
    `sync-${randomUUID()}`,
  );
  const db = await getDb(),
    actor = randomUUID();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = new AbortController();
  try {
    await db.query(
      "INSERT INTO users(id,name,password_hash) VALUES($1,'同步测试','test-disabled')",
      [actor],
    );
    const token = await db.transaction((tx) => makeSession(tx, actor));
    const response = await events(
      new NextRequest("http://127.0.0.1/api/sync/events", {
        signal: abort.signal,
        headers: { cookie: `fresh_session=${token}` },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert(first.includes("retry: 10000"));
    const next = reader.read();
    await db.query("UPDATE shop SET name='同步事件已提交'");
    const message = new TextDecoder().decode((await next).value);
    assert.match(message, /data: \d+/);
    assert(!message.includes("同步事件已提交"));
  } finally {
    abort.abort();
    await reader?.cancel();
    await db.close();
    globalThis.shopDatabase = undefined;
  }
});
