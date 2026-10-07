-- Require an explicit public-session or trusted-operator context for every
-- row operation. The existing permissive unbound policy remains the trusted
-- operator path; this restrictive policy prevents context-free runtime SQL
-- from using it accidentally.
CREATE POLICY myra_public_sessions_trusted_boundary
  ON "myra_public_sessions" AS RESTRICTIVE
  FOR ALL
  USING (
    app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

-- These invoker functions reference only pg_catalog builtins and/or trigger
-- NEW fields. Pinning their path removes ambient schema lookup without
-- changing execution privileges.
ALTER FUNCTION app.current_account_id() SET search_path = pg_catalog;
ALTER FUNCTION app.bind_agent_operation_principal() SET search_path = pg_catalog;
