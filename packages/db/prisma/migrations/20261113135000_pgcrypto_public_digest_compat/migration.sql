-- Production (Supabase) installs pgcrypto in the `extensions` schema; CI and
-- disposable PostgreSQL install it in `public`. Several pending migrations
-- reference `public.digest(...)` at CREATE time, so order this compat before
-- them. Idempotent and a no-op where pgcrypto already lives in `public`.

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
