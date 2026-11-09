"use client";
import type { SupabaseClient } from "@supabase/supabase-js";
export type SyncHealth = "connecting" | "live" | "slow" | "offline";
export function startWorkspaceSync(
  onChange: () => void,
  onHealth: (health: SyncHealth) => void,
  onExpired: () => void,
) {
  let stopped = false,
    epoch = 0,
    source: EventSource | null = null,
    client: SupabaseClient | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | undefined,
    renewTimer: ReturnType<typeof setTimeout> | undefined;
  let revision = "",
    healthy = false;
  const clear = () => {
    epoch++;
    if (checkTimer) clearTimeout(checkTimer);
    if (renewTimer) clearTimeout(renewTimer);
    source?.close();
    source = null;
    if (client) {
      void client.removeAllChannels();
      void client.realtime.disconnect();
      client = null;
    }
  };
  const changed = (next: string) => {
    if (next !== revision) {
      revision = next;
      onChange();
    }
  };
  const check = async () => {
    if (stopped || document.hidden || !navigator.onLine) return;
    const current = epoch;
    try {
      const r = await fetch("/api/sync?light=1", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      if (current !== epoch || stopped) return;
      if (r.status === 401) {
        onExpired();
        return;
      }
      if (!r.ok) throw new Error();
      const value = await r.json();
      if (current !== epoch || stopped) return;
      changed(`${value.generation}:${value.revision}`);
      if (!healthy) onHealth("slow");
    } catch {
      if (current === epoch && !stopped) onHealth("offline");
    }
    if (current !== epoch) return;
    if (!stopped && !document.hidden)
      checkTimer = setTimeout(() => void check(), healthy ? 60000 : 15000);
  };
  const connect = async () => {
    clear();
    if (stopped || document.hidden || !navigator.onLine) {
      onHealth("offline");
      return;
    }
    const current = epoch;
    healthy = false;
    onHealth("connecting");
    try {
      const r = await fetch("/api/sync", {
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      if (r.status === 401) {
        onExpired();
        return;
      }
      if (!r.ok) throw new Error();
      const value = await r.json();
      if (stopped || current !== epoch) return;
      changed(`${value.generation}:${value.revision}`);
      if (value.mode === "local") {
        source = new EventSource("/api/sync/events");
        source.onopen = () => {
          healthy = true;
          onHealth("live");
          onChange();
        };
        source.onmessage = (e) => changed(`${value.generation}:${e.data}`);
        source.onerror = () => {
          healthy = false;
          onHealth("slow");
        };
      } else {
        const { createClient } = await import("@supabase/supabase-js");
        if (stopped || current !== epoch) return;
        client = createClient(value.url, value.publishableKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
          realtime: {
            heartbeatIntervalMs: 30000,
            reconnectAfterMs: (attempt) =>
              Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)),
          },
        });
        await client.realtime.setAuth(value.token);
        client
          .channel("shop-revision")
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "shop_sync",
              filter: "id=eq.1",
            },
            (payload) => changed(`${value.generation}:${payload.new.revision}`),
          )
          .subscribe((status) => {
            if (stopped || current !== epoch) return;
            healthy = status === "SUBSCRIBED";
            onHealth(healthy ? "live" : "slow");
            if (healthy) onChange();
          });
        // JWT stays in memory. Its server-side signing key never reaches the browser.
        renewTimer = setTimeout(() => void connect(), 8 * 60 * 1000);
      }
      checkTimer = setTimeout(() => void check(), 60000);
    } catch {
      if (current === epoch) {
        onHealth("offline");
        checkTimer = setTimeout(() => void connect(), 30000);
      }
    }
  };
  const visibility = () => {
    if (document.hidden) clear();
    else void connect();
  };
  const online = () => void connect(),
    offline = () => {
      clear();
      onHealth("offline");
    };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  void connect();
  return () => {
    stopped = true;
    clear();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("online", online);
    window.removeEventListener("offline", offline);
  };
}
