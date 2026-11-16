-- The native executor validates the original live session, never a caller's PID.
-- Legacy guards remain unavailable. No historical invocation is backfilled.
ALTER TABLE "ScanExecutionInvocationGuard"
 ADD COLUMN "nativeBackendPid" INTEGER,
 ADD COLUMN "nativeBackendStart" TIMESTAMPTZ(6);

CREATE FUNCTION app.scan_execution_invocation_backend_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT app.scan_preparation_gate_held() THEN
  RAISE EXCEPTION 'native guard requires its original session gate' USING ERRCODE='23514';
 END IF;
 NEW."nativeBackendPid":=pg_backend_pid();
 SELECT backend_start INTO NEW."nativeBackendStart" FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF NEW."nativeBackendStart" IS NULL THEN
  RAISE EXCEPTION 'native backend identity is unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.scan_execution_invocation_backend_stamp() FROM PUBLIC;
CREATE TRIGGER scan_execution_invocation_backend_stamp
 BEFORE INSERT ON "ScanExecutionInvocationGuard"
 FOR EACH ROW EXECUTE FUNCTION app.scan_execution_invocation_backend_stamp();
