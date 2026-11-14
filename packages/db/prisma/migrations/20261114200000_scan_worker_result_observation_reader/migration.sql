-- Existing root worker observer reads only its exact live worker's retained
-- operations. No worker/publisher principal, credentials or writes are exposed.
CREATE FUNCTION app.read_scan_installed_worker_operations(epoch_id TEXT,epoch_number INTEGER,
 worker_instance_id TEXT,worker_grant_id TEXT,credential_digest TEXT,
 operation_id TEXT DEFAULT NULL,after_operation_id TEXT DEFAULT NULL)
RETURNS TABLE("operationId" TEXT,"workspaceId" TEXT,"scanId" TEXT,"attemptId" TEXT,state TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF session_user<>'app_native_origin_reader' OR NOT app.scan_native_origin_reader_eligible()
   OR current_setting('transaction_read_only')<>'on' OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'worker operation observation requires restricted READ ONLY root reader' USING ERRCODE='42501';
 END IF;
 IF operation_id IS NOT NULL AND operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$'
   OR after_operation_id IS NOT NULL AND after_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$'
   OR operation_id IS NOT NULL AND after_operation_id IS NOT NULL THEN
  RAISE EXCEPTION 'worker operation observation scope is invalid' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM app.read_scan_installed_worker_grant(epoch_id,epoch_number,
     worker_instance_id,worker_grant_id,credential_digest)) THEN RETURN; END IF;
 RETURN QUERY SELECT o."operationId",o."workspaceId",o."scanId",a."attemptId",o.state::text
 FROM "ScanDispatchWorkerAssignment" assigned
 JOIN "ScanDispatchOperation" o ON o."operationId"=assigned."operationId" AND o."workspaceId"=assigned."workspaceId"
 JOIN "Scan" s ON s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
 JOIN "ScanDispatchAttempt" a ON a."operationId"=o."operationId" AND a."scanId"=s.id AND a."workspaceId"=o."workspaceId"
 WHERE assigned."workerGrantId"=worker_grant_id AND assigned."authorityEpochId"=epoch_id
   AND a."workerInstanceGrantId"=worker_grant_id AND a."authorityEpochId"=epoch_id
   AND o.state IN ('PREPARING','PREPARED','START_PENDING','ACTIVE','STOPPING','UNKNOWN','TERMINATED')
   AND (operation_id IS NULL OR o."operationId"=operation_id)
   AND (after_operation_id IS NULL OR o."operationId">after_operation_id)
   AND (s.status IN ('QUEUED','PREFLIGHT','RUNNING','VERIFYING')
     OR EXISTS(SELECT 1 FROM "UserScanSlot" slot WHERE slot."scanId"=s.id AND slot."userId"=s."createdById")
     OR EXISTS(SELECT 1 FROM "ScanCapacityReservation" capacity WHERE capacity."scanId"=s.id
       AND capacity."accountId"=coalesce(s."sponsorAccountId",s."createdById") AND capacity.state IN ('WAITING','RESERVED','RUNNING')))
 ORDER BY o."operationId" LIMIT 32;
END $$;
DO $$ DECLARE definition TEXT; original TEXT; replacement TEXT; BEGIN
 SELECT pg_get_functiondef('app.scan_native_origin_reader_eligible()'::regprocedure) INTO definition;
 original := $old$'app.read_scan_native_pending_tool_guards(text)'::regprocedure))$old$;
 replacement := $new$'app.read_scan_native_pending_tool_guards(text)'::regprocedure,
       'app.read_scan_installed_worker_operations(text,integer,text,text,text,text,text)'::regprocedure))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unknown native read role closure'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION app.read_scan_installed_worker_operations(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_operations(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT) TO app_native_origin_reader;
 END IF;
END $$;
