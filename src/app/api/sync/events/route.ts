import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { failure, requireUser } from "@/lib/http";
import { syncState } from "@/lib/sync.server";
import { cloudMode } from "@/lib/cloud-config.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    if (cloudMode()) return new Response(null, { status: 404 });
    const db = await getDb();
    let cleanup = () => {};
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (text: string) => {
          if (!closed)
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              cleanup();
            }
        };
        const unsubscribe = await db.listen!("shop_sync", (revision) =>
          send(`data: ${revision}\n\n`),
        );
        const timer = setInterval(() => send(": keepalive\n\n"), 25000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          void unsubscribe();
        };
        request.signal.addEventListener(
          "abort",
          () => {
            cleanup();
            try {
              controller.close();
            } catch {}
          },
          { once: true },
        );
        send(`retry: 10000\ndata: ${(await syncState()).revision}\n\n`);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
