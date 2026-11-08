import { PGlite } from "@electric-sql/pglite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { requestSession } from "./request-session.server";
import { AppError } from "./errors";
import { acquireDatabaseLock } from "./database-lock.server";
// Internal additive migration revision; business backup format remains version 3.
const SCHEMA_REVISION = 9;

export const schema = `
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
CREATE TABLE IF NOT EXISTS order_items (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id text NOT NULL REFERENCES products(id), product_name text NOT NULL, zone_id text NOT NULL REFERENCES zones(id), position integer NOT NULL, ordered_quantity numeric(12,3) NOT NULL CHECK(ordered_quantity>0), ordered_unit text NOT NULL, billing_unit text NOT NULL, price_snapshot numeric(12,2), actual_quantity numeric(12,3) CHECK(actual_quantity>=0), actual_unit text, actual_confirmed boolean NOT NULL DEFAULT false, unavailable boolean NOT NULL DEFAULT false, amount numeric(14,2), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS picking_tasks (id text PRIMARY KEY, order_item_id text NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','picked','unavailable')), completed_by text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS change_records (id text PRIMARY KEY, actor_id text REFERENCES users(id), action text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS change_entity_latest_idx ON change_records(entity_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS operation_requests (key text PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS orders_date_idx ON orders(delivery_date);
CREATE INDEX IF NOT EXISTS items_order_idx ON order_items(order_id);
CREATE TABLE IF NOT EXISTS import_drafts (
 id text PRIMARY KEY, created_by text NOT NULL REFERENCES users(id), restaurant_id text NOT NULL REFERENCES restaurants(id),
 delivery_date date NOT NULL, source_kind text NOT NULL CHECK(source_kind IN ('text','image')), original_text text NOT NULL DEFAULT '', source_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft', lines jsonb NOT NULL DEFAULT '[]', detected_restaurant text,
 restaurant_acknowledged boolean NOT NULL DEFAULT false, source_checked boolean NOT NULL DEFAULT false,
 error_message text, extraction_warning boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 preview jsonb, confirmed_order_id text REFERENCES orders(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS import_images (
 draft_id text PRIMARY KEY REFERENCES import_drafts(id), original_image bytea NOT NULL, original_mime text NOT NULL,
 prepared_image bytea NOT NULL, prepared_mime text NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_attempts (
 id text PRIMARY KEY, draft_id text NOT NULL REFERENCES import_drafts(id), actor_id text NOT NULL REFERENCES users(id), request_key text NOT NULL UNIQUE,
 provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL, schema_version integer NOT NULL,
 status text NOT NULL DEFAULT 'pending', error_code text, quota_day text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS extraction_cache (
 cache_key text PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS extraction_cooldown (id integer PRIMARY KEY CHECK(id=1), until_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS import_date_idx ON import_drafts(delivery_date,created_by);
CREATE INDEX IF NOT EXISTS import_hash_idx ON import_drafts(source_hash,restaurant_id,delivery_date);
CREATE INDEX IF NOT EXISTS attempt_started_idx ON extraction_attempts(started_at);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_text text;
ALTER TABLE import_drafts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]';
INSERT INTO schema_version VALUES (2) ON CONFLICT DO NOTHING;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS small_weight_percent numeric(5,2) NOT NULL DEFAULT 20;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS large_weight_percent numeric(5,2) NOT NULL DEFAULT 10;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS finalized_document_id text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discrepancy_ack text;
DROP INDEX IF EXISTS restaurant_date_unique;
CREATE UNIQUE INDEX IF NOT EXISTS active_restaurant_date_unique ON orders(restaurant_id,delivery_date) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS restaurant_prices (
 restaurant_id text NOT NULL REFERENCES restaurants(id), product_id text NOT NULL REFERENCES products(id), billing_unit text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>=0), version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(restaurant_id,product_id,billing_unit)
);
CREATE SEQUENCE IF NOT EXISTS delivery_document_no;
CREATE TABLE IF NOT EXISTS documents (
 id text PRIMARY KEY,order_id text NOT NULL REFERENCES orders(id),number text NOT NULL UNIQUE,
 revision integer NOT NULL,sequence_no bigint NOT NULL UNIQUE,snapshot jsonb NOT NULL,pdf bytea NOT NULL,pdf_sha256 text NOT NULL,
 superseded_at timestamptz,superseded_pdf bytea,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,revision)
);
CREATE TABLE IF NOT EXISTS restore_previews (
 id text PRIMARY KEY,actor_id text NOT NULL REFERENCES users(id),payload jsonb NOT NULL,state_hash text NOT NULL,expires_at timestamptz NOT NULL
);
INSERT INTO schema_version VALUES (3) ON CONFLICT DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_import boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_finalize boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
UPDATE users SET username='owner' WHERE id=(SELECT id FROM users WHERE role IN ('owner','admin') ORDER BY created_at,id LIMIT 1) AND username IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_login_unique ON users(lower(username)) WHERE username IS NOT NULL;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1), generation text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text));
INSERT INTO app_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE SEQUENCE IF NOT EXISTS restaurant_price_version;
SELECT setval('restaurant_price_version',greatest((SELECT last_value FROM restaurant_price_version),coalesce((SELECT max(version) FROM restaurant_prices),1)),true);
`;

declare global {
  var shopDatabase: Promise<PGlite> | undefined;
  var shopDatabaseSchema: number | undefined;
  var shopDatabaseGuards: WeakSet<PGlite> | undefined;
  var shopDatabaseLocks: WeakSet<PGlite> | undefined;
}
export async function getDb() {
  if (
    !globalThis.shopDatabase ||
    globalThis.shopDatabaseSchema !== SCHEMA_REVISION
  ) {
    const prior = globalThis.shopDatabase;
    globalThis.shopDatabaseSchema = SCHEMA_REVISION;
    globalThis.shopDatabase = (async () => {
      const directory =
        process.env.SHOP_DATA_DIR ??
        path.join(process.cwd(), "data", "postgres");
      await mkdir(directory, { recursive: true });
      const locks = (globalThis.shopDatabaseLocks ??= new WeakSet<PGlite>());
      const old = prior ? await prior : null;
      const release =
        old && locks.has(old) ? null : await acquireDatabaseLock(directory);
      const db = prior ? await prior : new PGlite(directory);
      await db.waitReady;
      await db.exec(schema);
      if (release) {
        locks.add(db);
        const close = db.close.bind(db);
        let stopBackup = () => {};
        db.close = async () => {
          stopBackup();
          await close();
          await release();
        };
        if (process.env.SHOP_AUTO_BACKUP === "true") {
          const timer = setTimeout(() => {
            void import("./scheduled-backup.server").then(
              ({ startScheduledBackups }) => {
                stopBackup = startScheduledBackups();
              },
            );
          }, 0);
          timer.unref();
        }
      }
      const guarded = (globalThis.shopDatabaseGuards ??= new WeakSet<PGlite>());
      if (!guarded.has(db)) {
        guarded.add(db);
        const transaction = db.transaction.bind(db);
        db.transaction = ((callback: (tx: Transaction) => Promise<unknown>) =>
          transaction(async (tx) => {
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
              throw new AppError(
                "登录已失效，请重新登录；未提交输入仍保留",
                401,
              );
            return callback(tx);
          })) as typeof db.transaction;
      }
      return db;
    })().catch((error) => {
      globalThis.shopDatabase = undefined;
      throw error;
    });
  }
  return globalThis.shopDatabase;
}
export type Database = Awaited<ReturnType<typeof getDb>>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
