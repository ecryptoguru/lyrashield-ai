-- Disposable ls_hardening database only; mirrors ci.yml runtime grants.
\set ON_ERROR_STOP on
SELECT current_database() = 'ls_hardening' AS disposable_database \gset
\if :disposable_database
ALTER ROLE ls_test_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE ls_hardening TO ls_test_runtime;
GRANT USAGE ON SCHEMA public, app TO ls_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ls_test_owner IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ls_test_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ls_test_runtime;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN
      ('PlatformAdminElevation', 'PlatformAdminChallengeLimit', 'PlatformAdminAudit', 'billing_reconciliation_state')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO ls_test_runtime', item.tablename);
  END LOOP;
  FOR item IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO ls_test_runtime', item.sequencename);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.enqueue_artifact_deletion_task(text, text, text) TO ls_test_runtime;
GRANT EXECUTE ON FUNCTION app.enqueue_scan_attachment_deletion_task(text, text, text) TO ls_test_runtime;
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
FROM pg_roles WHERE rolname = 'ls_test_runtime';
SELECT has_schema_privilege('ls_test_runtime', 'app', 'USAGE') AS app_usage,
       has_table_privilege('ls_test_runtime', 'billing_reconciliation_state', 'SELECT') AS reconciliation_select,
       has_table_privilege('ls_test_runtime', '"PlatformAdminElevation"', 'SELECT') AS elevation_select;
\else
\echo 'Refusing grants outside disposable ls_hardening database'
\quit 1
\endif
