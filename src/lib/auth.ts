import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { getDb, type Transaction } from "./db";
import type { CurrentUser } from "./permissions";
export const SESSION_COOKIE = "fresh_session";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const hash = scryptSync(password, salt, 64);
  const other = Buffer.from(expected, "hex");
  return hash.length === other.length && timingSafeEqual(hash, other);
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function makeSession(tx: Transaction, userId: string) {
  const token = randomBytes(32).toString("hex");
  await tx.query("DELETE FROM sessions WHERE expires_at < now()");
  await tx.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '7 days')",
    [tokenHash(token), userId],
  );
  return token;
}
export async function getSession(token?: string) {
  if (!token) return null;
  const db = await getDb();
  const prefix = db.read ? "shop_private." : "";
  const result = await (db.read ?? db.query.bind(db))<CurrentUser>(
    `SELECT u.id,u.name,u.username,u.role,u.can_import,u.can_finalize FROM ${prefix}users u JOIN ${prefix}sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true AND u.role IN ('owner','admin','staff')`,
    [tokenHash(token)],
  );
  return result.rows[0] ?? null;
}
