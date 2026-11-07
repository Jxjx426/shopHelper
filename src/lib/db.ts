import { PGlite } from "@electric-sql/pglite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const schema = `
CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);
INSERT INTO schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS shop (id integer PRIMARY KEY DEFAULT 1 CHECK (id=1), name text NOT NULL DEFAULT '鲜配助手');
INSERT INTO shop(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, name text NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'owner', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS zones (id text PRIMARY KEY, name text NOT NULL CHECK(length(name)>0), sort_order integer NOT NULL, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS zone_name_unique ON zones(lower(name));
CREATE TABLE IF NOT EXISTS restaurants (id text PRIMARY KEY, name text NOT NULL CHECK(length(name)>0), aliases text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_name_unique ON restaurants(lower(name));
CREATE TABLE IF NOT EXISTS products (id text PRIMARY KEY, name text NOT NULL CHECK(length(name)>0), aliases text[] NOT NULL DEFAULT '{}', zone_id text NOT NULL REFERENCES zones(id), sort_order integer NOT NULL, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS product_name_unique ON products(lower(name));
CREATE TABLE IF NOT EXISTS product_units (product_id text NOT NULL REFERENCES products(id), order_unit text NOT NULL, billing_unit text NOT NULL, PRIMARY KEY(product_id,order_unit));
CREATE TABLE IF NOT EXISTS prices (product_id text NOT NULL REFERENCES products(id), billing_unit text NOT NULL, amount numeric(12,2) CHECK(amount>=0), PRIMARY KEY(product_id,billing_unit));
CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, restaurant_id text NOT NULL REFERENCES restaurants(id), restaurant_name text NOT NULL, delivery_date date NOT NULL, urgent boolean NOT NULL DEFAULT false, picking_started_at timestamptz, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_date_unique ON orders(restaurant_id,delivery_date);
CREATE TABLE IF NOT EXISTS order_items (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id text NOT NULL REFERENCES products(id), product_name text NOT NULL, zone_id text NOT NULL REFERENCES zones(id), position integer NOT NULL, ordered_quantity numeric(12,3) NOT NULL CHECK(ordered_quantity>0), ordered_unit text NOT NULL, billing_unit text NOT NULL, price_snapshot numeric(12,2), actual_quantity numeric(12,3) CHECK(actual_quantity>=0), actual_unit text, actual_confirmed boolean NOT NULL DEFAULT false, unavailable boolean NOT NULL DEFAULT false, amount numeric(14,2), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS picking_tasks (id text PRIMARY KEY, order_item_id text NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','picked','unavailable')), completed_by text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS change_records (id text PRIMARY KEY, actor_id text REFERENCES users(id), action text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS operation_requests (key text PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS orders_date_idx ON orders(delivery_date);
CREATE INDEX IF NOT EXISTS items_order_idx ON order_items(order_id);
`;

declare global {
  var shopDatabase: Promise<PGlite> | undefined;
}
export async function getDb() {
  if (!globalThis.shopDatabase)
    globalThis.shopDatabase = (async () => {
      const directory =
        process.env.SHOP_DATA_DIR ??
        path.join(process.cwd(), "data", "postgres");
      await mkdir(directory, { recursive: true });
      const db = new PGlite(directory);
      await db.waitReady;
      await db.exec(schema);
      return db;
    })().catch((error) => {
      globalThis.shopDatabase = undefined;
      throw error;
    });
  return globalThis.shopDatabase;
}
export type Database = Awaited<ReturnType<typeof getDb>>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
