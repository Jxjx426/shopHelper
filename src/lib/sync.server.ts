import { getDb } from "./db";
import { cloudMode, cloudConfig } from "./cloud-config.server";
import { SignJWT } from "jose";
export async function syncState() {
  const db = await getDb();
  return (
    await (db.read ?? db.query.bind(db))<{
      revision: string;
      generation: string;
    }>(
      `SELECT revision::text,generation FROM ${db.read ? "shop_private." : ""}app_state WHERE id=1`,
    )
  ).rows[0];
}
export async function syncSessionState(sessionHash: string) {
  const db = await getDb();
  const query = db.read ?? db.query.bind(db),
    prefix = db.read ? "shop_private." : "";
  return (
    await query<{ user_id: string; revision: string; generation: string }>(
      `SELECT s.user_id,a.revision::text,a.generation FROM ${prefix}app_state a JOIN ${prefix}sessions s ON s.token_hash=$1 JOIN ${prefix}users u ON u.id=s.user_id WHERE a.id=1 AND s.expires_at>now() AND u.active=true AND u.role IN ('owner','admin','staff')`,
      [sessionHash],
    )
  ).rows[0];
}
export async function syncConfiguration(
  userId: string,
  sessionHash: string,
  snapshot?: { revision: string; generation: string },
) {
  const state = snapshot ?? (await syncState());
  if (!cloudMode()) return { mode: "local" as const, ...state };
  const config = cloudConfig(),
    expiresAt = Math.floor(Date.now() / 1000) + 600;
  const token = await new SignJWT({
    role: "authenticated",
    shop_session: sessionHash,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(config.jwtSecret));
  return {
    mode: "supabase" as const,
    url: config.url,
    publishableKey: config.publishableKey,
    token,
    expiresAt,
    ...state,
  };
}
