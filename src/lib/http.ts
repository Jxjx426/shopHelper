import { NextRequest, NextResponse } from "next/server";
import { getSession, SESSION_COOKIE } from "./auth";
import { AppError } from "./service";
import { ValidationError } from "./domain";
export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function guardOrigin(request: NextRequest) {
  // Next normalizes a loopback nextUrl hostname to localhost. The HTTP Host
  // retains the browser-facing address (127.0.0.1 or a LAN IP).
  const host = request.headers.get("host");
  const expected = host
    ? `${request.nextUrl.protocol}//${host}`
    : request.nextUrl.origin;
  if (request.headers.get("origin") !== expected)
    throw new AppError("请求来源无效，请重新打开页面", 403);
}
export async function readBody(request: NextRequest, max = 131072) {
  if (
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  )
    throw new AppError("请求格式无效", 415);
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new AppError("输入内容太多", 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > max) throw new AppError("输入内容太多", 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("输入格式有误");
  }
}
export async function requireUser(request: NextRequest) {
  const user = await getSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) throw new AppError("请先登录", 401);
  return user;
}
export function failure(error: unknown) {
  if (error instanceof ValidationError)
    return json({ error: error.message }, 400);
  if (error instanceof AppError)
    return json({ error: error.message }, error.status);
  // Never serialize raw database exceptions or request bodies into responses/logs.
  console.error(
    "Shop operation failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return json(
    { error: "保存失败，输入仍保留。请检查服务是否运行，再重试。" },
    500,
  );
}
