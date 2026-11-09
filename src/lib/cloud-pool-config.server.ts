import { readFile } from "node:fs/promises";
import type { PoolConfig } from "pg";
export async function cloudPoolConfig(
  databaseUrl: string,
): Promise<PoolConfig> {
  const url = new URL(databaseUrl);
  // pg connection-string ssl options otherwise override the verified SSL object.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(key);
  const ca = process.env.SHOP_DB_CA_FILE
    ? await readFile(process.env.SHOP_DB_CA_FILE, "utf8")
    : undefined;
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  };
}
