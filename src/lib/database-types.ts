export type Transaction = {
  backend?: "local" | "postgres";
  // Result shapes are supplied by the caller, matching the existing SQL API.
  query<T = Record<string, any>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
};
export type Database = Transaction & {
  // Optional single-statement committed read. SQL must qualify its schema;
  // used only for session/metadata reads, never a read-then-write operation.
  read?: Transaction["query"];
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  listen?(
    channel: string,
    listener: (payload: string) => void,
  ): Promise<() => Promise<void>>;
};
