import { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  getSession,
  hashPassword,
  makeSession,
  SESSION_COOKIE,
  tokenHash,
  verifyPassword,
} from "@/lib/auth";
import { failure, guardOrigin, json, readBody } from "@/lib/http";
import { AppError } from "@/lib/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
declare global {
  var shopLoginAttempts: Map<string, number[]> | undefined;
}
export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const configured =
      (await db.query("SELECT id FROM users LIMIT 1")).rows.length > 0;
    return json({
      configured,
      user: await getSession(request.cookies.get(SESSION_COOKIE)?.value),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    guardOrigin(request);
    const body = z
      .object({
        action: z.enum(["setup", "login", "logout"]),
        password: z.string().max(128).optional(),
        shopName: z.string().trim().max(80).optional(),
      })
      .safeParse(await readBody(request, 4096));
    if (!body.success) throw new AppError("输入格式无效");
    const a = body.data;
    const db = await getDb();
    if (a.action === "logout") {
      const token = request.cookies.get(SESSION_COOKIE)?.value;
      if (token)
        await db.query("DELETE FROM sessions WHERE token_hash=$1", [
          tokenHash(token),
        ]);
      const response = json({ ok: true });
      response.cookies.delete(SESSION_COOKIE);
      return response;
    }
    const attempts = (globalThis.shopLoginAttempts ??= new Map<
      string,
      number[]
    >());
    const attemptKey = "owner"; // Single-owner local edition: one shared brute-force budget.
    const recent = (attempts.get(attemptKey) ?? []).filter(
      (t) => Date.now() - t < 300000,
    );
    if (recent.length >= 10)
      throw new AppError("尝试次数太多，请5分钟后再试", 429);
    attempts.set(attemptKey, [...recent, Date.now()]);
    if (!a.password || a.password.length < 8) throw new AppError("密码至少8位");
    const token = await db.transaction(async (tx) => {
      const existing = (
        await tx.query<{ id: string; password_hash: string }>(
          "SELECT id,password_hash FROM users LIMIT 1",
        )
      ).rows[0];
      if (a.action === "setup") {
        if (existing) throw new AppError("已完成设置，请登录", 409);
        if (!a.shopName) throw new AppError("请填写店名");
        const userId = randomUUID();
        await tx.query(
          "INSERT INTO users(id,name,password_hash) VALUES($1,'店主',$2)",
          [userId, hashPassword(a.password!)],
        );
        await tx.query("UPDATE shop SET name=$1 WHERE id=1", [a.shopName]);
        return makeSession(tx, userId);
      }
      if (!existing || !verifyPassword(a.password!, existing.password_hash))
        throw new AppError("密码不正确，请重新输入", 401);
      return makeSession(tx, existing.id);
    });
    attempts.delete(attemptKey);
    const response = json({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 604800,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
