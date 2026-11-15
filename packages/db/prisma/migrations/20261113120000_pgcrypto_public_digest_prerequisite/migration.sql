-- Must sort BEFORE 20261113130000_scan_policy_authority_v2: that migration
-- declares `app.scan_policy_digest` as LANGUAGE sql, which PostgreSQL
-- validates at CREATE time, so `public.digest` has to exist first.
-- Production (Supabase) keeps pgcrypto in `extensions`; CI/disposable
-- PostgreSQL keeps it in `public`, where this is a no-op. Without this,
-- replaying the migration chain into a fresh Supabase-shaped database fails.
DO $compat$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'digest'
  ) AND EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'extensions' AND p.proname = 'digest'
  ) THEN
    EXECUTE 'CREATE FUNCTION public.digest(bytea, text) RETURNS bytea
      LANGUAGE sql STABLE STRICT AS $func$ SELECT extensions.digest($1, $2) $func$';
  END IF;
END
$compat$;
