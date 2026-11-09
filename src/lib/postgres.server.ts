import { Pool, type PoolConfig } from "pg";
import type { Database, Transaction } from "./database-types";
import { AppError } from "./errors";
import { requestSession } from "./request-session.server";
export const CLOUD_SCHEMA = "shop_private";
export const SHOP_LOCK = 719307244;
export function createPostgresDatabase(
  options: PoolConfig,
  schemaName = CLOUD_SCHEMA,
): Database {
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(schemaName))
    throw new Error("Invalid private schema");
  const pool = new Pool({
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 120000,
    ...options,
  });
  pool.on("error", () => {}); // Errors are reported by the next operation, never with connection credentials.
  const transaction = async <T>(work: (tx: Transaction) => Promise<T>) => {
    const client = await pool.connect();
    try {
      // Supavisor transaction pooling: no session-level SET, named prepared
      // statements or session advisory locks. All app writers share this lock.
      // These are fixed constants and a validated identifier, no user input.
      // One simple-protocol batch avoids five extra database roundtrips.
      await client.query(
        `BEGIN; SET LOCAL lock_timeout='10s'; SELECT pg_advisory_xact_lock(${SHOP_LOCK}); SET LOCAL search_path TO "${schemaName}", pg_catalog; SET LOCAL statement_timeout='120s'`,
      );
      const tx: Transaction = {
        backend: "postgres",
        query: async <T>(sql: string, params?: any[]) => {
          const r = await client.query(sql, params);
          return { rows: r.rows as T[], affectedRows: r.rowCount ?? 0 };
        },
        exec: (sql) => client.query(sql),
      };
      const token = requestSession.getStore();
      if (
        token !== undefined &&
        !(
          await tx.query(
            "SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true AND u.role IN ('owner','admin','staff')",
            [token],
          )
        ).rows.length
      )
        throw new AppError("登录已失效，请重新登录；未提交输入仍保留", 401);
      const value = await work(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    backend: "postgres",
    transaction,
    read: async <T>(sql: string, params?: any[]) => {
      if (!/^\s*SELECT\b/i.test(sql))
        throw new Error("Committed reads require SELECT");
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], affectedRows: r.rowCount ?? 0 };
    },
    query: (sql, params) => transaction((tx) => tx.query(sql, params)),
    exec: (sql) => transaction((tx) => tx.exec(sql)),
    close: () => pool.end(),
  };
}
