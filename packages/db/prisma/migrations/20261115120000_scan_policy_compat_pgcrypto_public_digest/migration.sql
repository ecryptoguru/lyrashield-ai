-- Production (Supabase) installs pgcrypto in the `extensions` schema, so
-- `public.digest(...)` used by app.scan_policy_digest does not exist there.
-- CI/disposable PostgreSQL installs pgcrypto in `public`, so this stays a no-op
-- outside production. `20261113130000_scan_policy_authority_v2` assumed
-- `public.digest` and failed midway; this compat migration completes it.

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

-- The v2 migration created every artifact except the binding guard, which the
-- digest failure prevented from ever running. Complete it here, idempotently,
-- so a fresh CI/dev replay of v2-then-compat produces the same end state.
CREATE OR REPLACE FUNCTION app.scan_policy_start_binding_guard() RETURNS trigger
LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."ScanDispatchAttempt" a
    WHERE a."attemptId"=NEW."attemptId" AND a."operationId"=NEW."operationId"
      AND a."scopeDigest"=app.scan_dispatch_scope_digest(a."scanId")
      AND a."policyDigest"=app.scan_policy_digest(a."policyId")
      AND NEW."policyDigest"=a."policyDigest"
  ) THEN
    RAISE EXCEPTION 'START requires its current original policy binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS scan_policy_start_binding_guard ON "ScanDispatchStart";
CREATE TRIGGER scan_policy_start_binding_guard BEFORE INSERT ON "ScanDispatchStart"
  FOR EACH ROW EXECUTE FUNCTION app.scan_policy_start_binding_guard();
