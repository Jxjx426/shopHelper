import { withRequestSession } from "@/lib/request-session.server";
import { NextRequest } from "next/server";
import { z } from "zod";
import { failure, guardOrigin, json, readBody, requireUser } from "@/lib/http";
import {
  confirmImport,
  extractDraft,
  getDraft,
  previewImport,
  saveDraft,
  supplementDraft,
  setDraftDeleted,
} from "@/lib/imports.server";
import { AppError } from "@/lib/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    return json(await getDraft(user.id, (await context.params).id));
  } catch (error) {
    return failure(error);
  }
}
async function post(request: NextRequest, context: Context) {
  try {
    guardOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const body = await readBody(request, 512 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError("导入请求格式无效");
    const { action, ...input } = body;
    const key = request.headers.get("idempotency-key") ?? "";
    if (action === "setDeleted")
      return json(await setDraftDeleted(user.id, id, key, input));
    if (action === "save")
      return json(await saveDraft(user.id, id, key, input));
    if (action === "extract")
      return json(await extractDraft(user.id, id, key, input));
    if (action === "confirm")
      return json(await confirmImport(user.id, id, key, input));
    if (action === "preview") {
      const a = z
        .object({
          version: z.number().int().positive(),
          mode: z.enum(["new", "replace", "append"]),
        })
        .strict()
        .safeParse(input);
      if (!a.success) throw new AppError("请明确选择新增、追加或替换");
      return json(
        await previewImport(user.id, id, a.data.version, a.data.mode),
      );
    }
    if (action === "supplement") {
      const a = z
        .object({
          version: z.number().int().positive(),
          text: z.string().max(20000),
        })
        .strict()
        .safeParse(input);
      if (!a.success) throw new AppError("补充文字格式无效");
      return json(
        await supplementDraft(user.id, id, key, a.data.version, a.data.text),
      );
    }
    throw new AppError("不支持的导入操作");
  } catch (error) {
    return failure(error);
  }
}

export function POST(request: NextRequest, context: Context) {
  return withRequestSession(request, () => post(request, context));
}
