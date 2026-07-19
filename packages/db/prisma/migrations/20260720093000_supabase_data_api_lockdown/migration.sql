-- LyraShield uses direct Prisma connections and Better Auth. No browser or
-- server path uses Supabase's Data API, so its database roles must not reach
-- application objects even if the platform integration is re-enabled.
DO $data_api_lockdown$
DECLARE
  data_api_role text;
BEGIN
  FOREACH data_api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    -- Local/CI Postgres does not define Supabase's platform roles.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = data_api_role) THEN
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', data_api_role);
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        data_api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        data_api_role
      );
      EXECUTE format(
        'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I',
        data_api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
        'ON TABLES FROM %I',
        data_api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM %I',
        data_api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'REVOKE EXECUTE ON FUNCTIONS FROM %I',
        data_api_role
      );
    END IF;
  END LOOP;
END
$data_api_lockdown$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Supabase's security advisor flags mutable function search paths. Pin each
-- function to only the schemas it needs.
ALTER FUNCTION app.current_workspace_id() SET search_path = pg_catalog, app;
ALTER FUNCTION public.prevent_workspace_hard_delete() SET search_path = pg_catalog, public;
