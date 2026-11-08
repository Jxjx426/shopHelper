export type CurrentUser = {
  id: string;
  name: string;
  username: string;
  role: string;
  can_import: boolean;
  can_finalize: boolean;
};
export type Permission = "work" | "manage" | "import" | "finalize";
export function allowed(user: CurrentUser | undefined, permission: Permission) {
  if (!user) return false;
  if (user.role === "owner" || user.role === "admin") return true;
  if (user.role !== "staff") return false;
  return (
    permission === "work" ||
    (permission === "import" && user.can_import) ||
    (permission === "finalize" && user.can_finalize)
  );
}
