import type { Transaction } from "./db";
import { AppError } from "./errors";
import { allowed, type CurrentUser, type Permission } from "./permissions";
export async function requirePermission(
  tx: Transaction,
  actor: string,
  permission: Permission,
) {
  const user = (
    await tx.query<CurrentUser>(
      "SELECT id,name,username,role,can_import,can_finalize FROM users WHERE id=$1 AND active=true",
      [actor],
    )
  ).rows[0];
  if (!allowed(user, permission))
    throw new AppError("此账号没有操作权限，请联系店主", 403);
  return user;
}
export function actionPermission(action: string): Permission {
  if (["setPicking", "setUnavailable", "saveActual"].includes(action))
    return "work";
  if (["saveOrder", "setUrgent"].includes(action)) return "import";
  if (action === "finalizeOrder") return "finalize";
  return "manage";
}
