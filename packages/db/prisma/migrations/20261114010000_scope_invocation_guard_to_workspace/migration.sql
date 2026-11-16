-- A single unresolved invocation guard must not freeze source-authority writes
-- for every tenant. When the caller has a workspace context the pending check is
-- scoped to that workspace, so an unresolved guard blocks only its own operation.
-- A write with no workspace context cannot be attributed, so the global check
-- still applies and the fence stays closed. The zero-argument signature is
-- unchanged, so no caller moves.
CREATE OR REPLACE FUNCTION app.scan_execution_invocation_pending() RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE workspace_id TEXT;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'invocation observer cannot inspect forced private authority' USING ERRCODE='42501';
 END IF;
 workspace_id := app.current_workspace_id();
 IF workspace_id IS NULL THEN
  RETURN EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" g
   WHERE NOT EXISTS(SELECT 1 FROM public."ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id));
 END IF;
 RETURN EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" g
  WHERE g."workspaceId"=workspace_id
   AND NOT EXISTS(SELECT 1 FROM public."ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id));
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_pending() FROM PUBLIC;