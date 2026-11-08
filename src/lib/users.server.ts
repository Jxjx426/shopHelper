import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "./auth";
import { AppError } from "./errors";
import { getDb, type Transaction } from "./db";
import { requirePermission } from "./permissions.server";
import type { CurrentUser } from "./permissions";
export const userActionSchema = z.object({
  action: z.literal("saveStaff"),
  id: z.string().max(100).optional(),
  version: z.number().int().positive().optional(),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "登录名须为3至32位英文字母或数字"),
  name: z.string().trim().min(1).max(40),
  password: z.string().min(8).max(128).optional(),
  active: z.boolean(),
  canImport: z.boolean(),
  canFinalize: z.boolean(),
});
export async function listStaff(actor: string) {
  return (await getDb()).transaction(async (tx) => {
    await requirePermission(tx, actor, "manage");
    return (
      await tx.query<CurrentUser & { active: boolean; version: number }>(
        "SELECT id,name,username,role,active,can_import,can_finalize,version FROM users WHERE role IN ('owner','admin','staff') ORDER BY created_at,id",
      )
    ).rows;
  });
}
export async function saveStaff(
  tx: Transaction,
  actor: string,
  a: z.infer<typeof userActionSchema>,
) {
  await requirePermission(tx, actor, "manage");
  const id = a.id ?? randomUUID();
  if (a.id) {
    const previous = (
      await tx.query<{ role: string; version: number }>(
        "SELECT role,version FROM users WHERE id=$1",
        [a.id],
      )
    ).rows[0];
    if (!previous || previous.role !== "staff")
      throw new AppError("只能在此管理员工账号", 403);
    if (previous.version !== a.version)
      throw new AppError("账号已被修改，请重新读取", 409);
    await tx.query(
      "UPDATE users SET username=$1,name=$2,active=$3,can_import=$4,can_finalize=$5,password_hash=coalesce($6,password_hash),version=version+1 WHERE id=$7",
      [
        a.username,
        a.name,
        a.active,
        a.canImport,
        a.canFinalize,
        a.password ? hashPassword(a.password) : null,
        id,
      ],
    );
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
  } else {
    if (!a.password) throw new AppError("请设置员工密码，至少8位");
    if (
      (
        await tx.query<{ count: number }>(
          "SELECT count(*)::int count FROM users WHERE role='staff'",
        )
      ).rows[0].count >= 20
    )
      throw new AppError("此单店版本最多20个员工账号");
    await tx.query(
      "INSERT INTO users(id,username,name,password_hash,role,active,can_import,can_finalize) VALUES($1,$2,$3,$4,'staff',$5,$6,$7)",
      [
        id,
        a.username,
        a.name,
        hashPassword(a.password),
        a.active,
        a.canImport,
        a.canFinalize,
      ],
    );
  }
  await tx.query(
    "INSERT INTO change_records(id,actor_id,action,entity_id,details) VALUES($1,$2,'saveStaff',$3,$4)",
    [
      randomUUID(),
      actor,
      id,
      JSON.stringify({
        name: a.name,
        active: a.active,
        canImport: a.canImport,
        canFinalize: a.canFinalize,
        passwordChanged: !!a.password,
      }),
    ],
  );
  return { id };
}
