// No products, quantities, customer names or secrets travel over Realtime.
// At most one revision change per database transaction, including bulk imports.
export function syncSchema(schemaName = "public") {
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(schemaName))
    throw new Error("Invalid schema");
  const tables = [
    "shop",
    "users",
    "sessions",
    "zones",
    "restaurants",
    "products",
    "product_units",
    "prices",
    "restaurant_prices",
    "orders",
    "order_items",
    "picking_tasks",
    "documents",
    "change_records",
    "import_drafts",
    "import_images",
    "extraction_attempts",
  ];
  return `ALTER TABLE app_state ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS sync_txid bigint;
CREATE OR REPLACE FUNCTION ${schemaName}.bump_shop_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=${schemaName},public AS $$
DECLARE rev bigint;
BEGIN
  UPDATE ${schemaName}.app_state SET revision=revision+1,sync_txid=txid_current() WHERE id=1 AND sync_txid IS DISTINCT FROM txid_current() RETURNING revision INTO rev;
  IF FOUND THEN
    PERFORM pg_notify('shop_sync',rev::text);
    IF to_regclass('public.shop_sync') IS NOT NULL THEN
      UPDATE public.shop_sync SET revision=rev WHERE id=1;
    END IF;
  END IF;
  RETURN NULL;
END $$;
${tables.map((t) => `DROP TRIGGER IF EXISTS shop_revision ON ${schemaName}.${t}; CREATE TRIGGER shop_revision AFTER INSERT OR UPDATE OR DELETE ON ${schemaName}.${t} FOR EACH STATEMENT EXECUTE FUNCTION ${schemaName}.bump_shop_revision();`).join("\n")}`;
}
export function realtimeSchema(schemaName = "shop_private") {
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(schemaName))
    throw new Error("Invalid schema");
  return `
REVOKE ALL ON SCHEMA ${schemaName} FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA ${schemaName} FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schemaName} FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schemaName} FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaName} REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
CREATE TABLE IF NOT EXISTS public.shop_sync (id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL);
INSERT INTO public.shop_sync VALUES(1,(SELECT revision FROM ${schemaName}.app_state WHERE id=1)) ON CONFLICT(id) DO NOTHING;
ALTER TABLE public.shop_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_sync FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.shop_sync TO authenticated;
CREATE OR REPLACE FUNCTION public.shop_sync_session_valid() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=${schemaName},pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ${schemaName}.sessions s JOIN ${schemaName}.users u ON u.id=s.user_id WHERE s.token_hash=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'shop_session') AND u.active=true AND u.role IN ('owner','admin','staff') AND s.expires_at>now());
$$;
REVOKE ALL ON FUNCTION public.shop_sync_session_valid() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.shop_sync_session_valid() TO authenticated;
DROP POLICY IF EXISTS app_session_read ON public.shop_sync;
CREATE POLICY app_session_read ON public.shop_sync FOR SELECT TO authenticated USING (public.shop_sync_session_valid());
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='shop_sync') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.shop_sync; END IF;
END $$;
`;
}
