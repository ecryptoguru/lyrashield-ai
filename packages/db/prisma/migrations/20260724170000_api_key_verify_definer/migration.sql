-- API-key verification must work PRE-AUTH: the workspace is unknown until the
-- key has been resolved, so `app.current_workspace_id()` is NULL at lookup
-- time. Since 20260721033000_strict_workspace_rls dropped the permissive
-- "no-context" policy and FORCEd RLS on "ApiKey", a by-hash lookup performed by
-- the restricted (NOBYPASSRLS) application role matches the strict policy
-- (`"workspaceId" = app.current_workspace_id()` → `= NULL` → no rows) and
-- returns nothing — breaking all Bearer API-key / MCP / remote-MCP auth.
--
-- Fix: expose the narrow, single-purpose pre-auth operations through
-- SECURITY DEFINER functions. They run with the privileges of their OWNER, so
-- they must be created by a role that can read past RLS on "ApiKey" (a
-- BYPASSRLS role — e.g. the migration/admin/`postgres` role, which is how
-- migrations are applied). The functions expose only the columns auth needs for
-- exactly one hash; they do NOT open the table to arbitrary no-context reads,
-- so the workspace-scoped RLS backstop on "ApiKey" stays intact for
-- create/list/revoke.
--
-- OPS NOTE: these functions must be created by a BYPASSRLS role. EXECUTE is
-- granted below to every role that currently holds SELECT on "ApiKey" (i.e. the
-- application role), so no hard-coded role name is required.

CREATE OR REPLACE FUNCTION app.verify_api_key(p_hash text)
RETURNS TABLE (
  id text,
  "workspaceId" text,
  scopes text[],
  "createdById" text,
  prefix text,
  "hashedKey" text,
  "revokedAt" timestamp(3),
  "expiresAt" timestamp(3),
  "deletedAt" timestamp(3),
  "lastUsedAt" timestamp(3)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, public
AS $$
  SELECT
    id,
    "workspaceId",
    scopes,
    "createdById",
    prefix,
    "hashedKey",
    "revokedAt",
    "expiresAt",
    "deletedAt",
    "lastUsedAt"
  FROM public."ApiKey"
  WHERE "hashedKey" = p_hash
  LIMIT 1
$$;

-- Throttled usage tracking (best-effort; also RLS-blocked pre-auth otherwise).
CREATE OR REPLACE FUNCTION app.touch_api_key_last_used(p_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app, public
AS $$
  UPDATE public."ApiKey" SET "lastUsedAt" = now() WHERE id = p_id
$$;

-- Least privilege: no blanket PUBLIC execute (matches the Data-API lockdown).
REVOKE EXECUTE ON FUNCTION app.verify_api_key(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.touch_api_key_last_used(text) FROM PUBLIC;

-- Grant EXECUTE to whichever role(s) can already read "ApiKey" (the app role),
-- without hard-coding an environment-specific role name.
DO $grant_verify$
DECLARE
  grantee_role text;
BEGIN
  FOR grantee_role IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'ApiKey'
      AND privilege_type = 'SELECT'
      AND grantee NOT IN ('PUBLIC')
      AND grantee <> current_user
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.verify_api_key(text) TO %I', grantee_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.touch_api_key_last_used(text) TO %I', grantee_role);
  END LOOP;
END
$grant_verify$;
