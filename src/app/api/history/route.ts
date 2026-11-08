import { NextRequest } from "next/server";
import { failure, json, requireUser } from "@/lib/http";
import { orderHistory, historyDetail, copyPreview } from "@/lib/history.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const p = request.nextUrl.searchParams;
    return json(
      p.has("id")
        ? p.has("copyTo")
          ? await copyPreview(p.get("id")!, p.get("copyTo")!)
          : await historyDetail(p.get("id")!)
        : await orderHistory({
            query: p.get("query") ?? "",
            from: p.get("from") ?? "",
            to: p.get("to") ?? "",
            deleted: p.get("deleted") === "true",
            page: Number(p.get("page") ?? 1),
          }),
    );
  } catch (error) {
    return failure(error);
  }
}
