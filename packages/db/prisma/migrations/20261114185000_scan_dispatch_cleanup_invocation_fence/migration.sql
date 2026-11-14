-- Physical release cannot clear a one-use native invocation whose original
-- effect is still uncertain. Its ACK or authenticated owned retirement is
-- required independently of a signed STOP terminal.
CREATE FUNCTION app.scan_dispatch_cleanup_invocation_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" g
    WHERE g."operationId"=NEW."operationId"
      AND NOT EXISTS(SELECT 1 FROM public."ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)) THEN
    RAISE EXCEPTION 'physical cleanup has an unresolved native invocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scan_physical_cleanup_invocation_fence
BEFORE INSERT ON "ScanPhysicalExecutionTransition"
FOR EACH ROW WHEN (NEW."toState" IN ('STOPPED','NEVER_DISPATCHED'))
EXECUTE FUNCTION app.scan_dispatch_cleanup_invocation_fence();
CREATE TRIGGER scan_release_cleanup_invocation_fence
BEFORE INSERT ON "ScanDispatchReleaseReceipt"
FOR EACH ROW EXECUTE FUNCTION app.scan_dispatch_cleanup_invocation_fence();
REVOKE ALL ON FUNCTION app.scan_dispatch_cleanup_invocation_fence() FROM PUBLIC;
