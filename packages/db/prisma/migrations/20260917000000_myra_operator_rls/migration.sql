-- v18 1.3 hardening — beyond the finding, founder heads-up requested.
--
-- The six dual-owner Myra tables previously admitted the unbound trusted
-- path whenever no owner context was bound: any code path that forgot to
-- bind silently read or wrote every row. This migration adds
-- app.myra_operator_id() (mirroring app.myra_public_session_id()) and a
-- RESTRICTIVE boundary on each dual-owner table: the unbound path now
-- requires the operator context to be bound, so trusted internal paths
-- (operator inbox, retention sweep, manage-token booking reads, account
-- deletion) must declare themselves through withMyraOperatorRLS or an
-- equivalent transaction-local setting.
--
-- Owner paths are unchanged: the restrictive expression also admits any
-- bound account or public-session context, so the existing permissive
-- owner policies keep working exactly as before.
--
-- Additive only: no existing policy, function or table is altered.

CREATE OR REPLACE FUNCTION app.myra_operator_id() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT NULLIF(current_setting('app.myra_operator_id', true), '')
$$;

-- Every role that already executes the public-session context function gets
-- the operator context function too (runtime + system roles alike).
DO $myra_operator_grant$
DECLARE
  grantee_role TEXT;
BEGIN
  FOR grantee_role IN
    SELECT DISTINCT grantee
    FROM information_schema.routine_privileges
    WHERE specific_schema = 'app'
      AND routine_name = 'myra_public_session_id'
      AND grantee NOT IN ('PUBLIC')
      AND grantee <> current_user
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.myra_operator_id() TO %I', grantee_role);
  END LOOP;
END
$myra_operator_grant$;

CREATE POLICY myra_conversations_trusted_boundary ON "myra_conversations" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

CREATE POLICY myra_messages_trusted_boundary ON "myra_messages" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

CREATE POLICY myra_operations_trusted_boundary ON "myra_operations" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

CREATE POLICY support_cases_trusted_boundary ON "support_cases" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

CREATE POLICY support_case_replies_trusted_boundary ON "support_case_replies" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );

CREATE POLICY demo_bookings_trusted_boundary ON "demo_bookings" AS RESTRICTIVE
  FOR ALL USING (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  )
  WITH CHECK (
    app.current_account_id() IS NOT NULL
    OR app.myra_public_session_id() IS NOT NULL
    OR app.myra_operator_id() IS NOT NULL
  );
