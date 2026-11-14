-- Retained cleanup can authorize only an already checked immutable attempt.
-- Live execution/readiness/output functions are unchanged.
CREATE FUNCTION app.require_scan_dispatch_worker_cleanup(operation_id TEXT,credential_digest TEXT)
RETURNS TABLE("workerGrantId" TEXT,"workerInstanceId" TEXT,"authorityEpochId" TEXT,"attemptId" TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.scan_preparation_gate_held() OR credential_digest !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'retained worker cleanup requires original authority gate' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g.id,g."instanceId",g."authorityEpochId",a."attemptId"
 FROM "ScanDispatchWorkerAssignment" assigned
 JOIN "ScanDispatchOperation" o ON o."operationId"=assigned."operationId" AND o."workspaceId"=assigned."workspaceId"
 JOIN "ScanWorkerInstanceGrant" g ON g.id=assigned."workerGrantId" AND g."authorityEpochId"=assigned."authorityEpochId"
 JOIN "ScanDispatchAttempt" a ON a."operationId"=o."operationId" AND a."scanId"=o."scanId" AND a."workspaceId"=o."workspaceId"
 JOIN "ScanDispatchOutbox" p ON p."operationId"=a."operationId" AND p."attemptId"=a."attemptId" AND p."commandType"='PREPARE'
 WHERE o."operationId"=operation_id AND o."workspaceId"=current_setting('app.current_workspace_id',true)
   AND g."credentialHash"=credential_digest AND a."workerInstanceGrantId"=g.id AND a."authorityEpochId"=g."authorityEpochId"
   AND a."authorityAcceptedAt" IS NOT NULL AND o.state IN ('PREPARING','PREPARED','START_PENDING','ACTIVE','STOPPING','UNKNOWN','TERMINATED')
   AND app.scan_dispatch_command_input_valid(p."commandInputJson",p."commandInputChecksum",p."commandDigest")
   AND p."commandInputJson"::jsonb->'attempt'->>'operationId'=o."operationId"
   AND p."commandInputJson"::jsonb->'attempt'->>'attemptId'=a."attemptId"
   AND p."commandInputJson"::jsonb->'attempt'->>'scanId'=a."scanId"
   AND p."commandInputJson"::jsonb->'attempt'->>'workspaceId'=a."workspaceId"
   AND p."commandInputJson"::jsonb->'attempt'->>'authorityEpochId'=a."authorityEpochId";
END $$;
REVOKE ALL ON FUNCTION app.require_scan_dispatch_worker_cleanup(TEXT,TEXT) FROM PUBLIC;
DO $$ DECLARE role_name TEXT; definition TEXT; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname<>'PUBLIC' AND NOT rolsuper
   AND has_function_privilege(oid,'app.require_scan_dispatch_worker(text,text)','EXECUTE') LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.require_scan_dispatch_worker_cleanup(TEXT,TEXT) TO %I',role_name);
 END LOOP;
 SELECT pg_get_functiondef('app.require_scan_preparation_role()'::regprocedure) INTO definition;
 IF position($marker$'app.require_scan_dispatch_worker(text,text)'::regprocedure$marker$ IN definition)=0 THEN
  RAISE EXCEPTION 'unknown preparation role closure';
 END IF;
 EXECUTE replace(definition,$old$'app.require_scan_dispatch_worker(text,text)'::regprocedure$old$,
   $new$'app.require_scan_dispatch_worker(text,text)'::regprocedure,'app.require_scan_dispatch_worker_cleanup(text,text)'::regprocedure$new$);
END $$;
-- Root's installed worker observer supplies only IDs and the credential digest
-- derived from verified protected policy/files. No worker can call this reader.
CREATE FUNCTION app.read_scan_installed_worker_cleanup_grant(epoch_id TEXT,epoch_number INTEGER,
 worker_instance_id TEXT,worker_grant_id TEXT,credential_digest TEXT)
RETURNS TABLE("expiresAt" TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF session_user<>'app_native_origin_reader' OR NOT app.scan_native_origin_reader_eligible()
   OR current_setting('transaction_read_only')<>'on' OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'installed worker observation requires restricted READ ONLY root reader' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g."expiresAt" AT TIME ZONE 'UTC'
 FROM "ScanWorkerInstanceGrant" g JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
 WHERE e.id=epoch_id AND e.epoch=epoch_number
   AND g.id=worker_grant_id AND g."instanceId"=worker_instance_id AND g."credentialHash"=credential_digest
   AND credential_digest~'^[a-f0-9]{64}$'
   AND EXISTS(SELECT 1 FROM "ScanDispatchWorkerAssignment" assigned
    JOIN "ScanDispatchAttempt" a ON a."operationId"=assigned."operationId" AND a."workspaceId"=assigned."workspaceId"
    WHERE assigned."workerGrantId"=g.id AND assigned."authorityEpochId"=e.id
      AND a."workerInstanceGrantId"=g.id AND a."authorityEpochId"=e.id AND a."authorityAcceptedAt" IS NOT NULL);
END $$;
-- Existing root worker observer reads only its exact live worker's retained
-- operations. No worker/publisher principal, credentials or writes are exposed.
CREATE FUNCTION app.read_scan_installed_worker_cleanup_operations(epoch_id TEXT,epoch_number INTEGER,
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
 IF NOT EXISTS(SELECT 1 FROM app.read_scan_installed_worker_cleanup_grant(epoch_id,epoch_number,
     worker_instance_id,worker_grant_id,credential_digest)) THEN RETURN; END IF;
 RETURN QUERY SELECT o."operationId",o."workspaceId",o."scanId",a."attemptId",o.state::text
 FROM "ScanDispatchWorkerAssignment" assigned
 JOIN "ScanDispatchOperation" o ON o."operationId"=assigned."operationId" AND o."workspaceId"=assigned."workspaceId"
 JOIN "Scan" s ON s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
 JOIN "ScanDispatchAttempt" a ON a."operationId"=o."operationId" AND a."scanId"=s.id AND a."workspaceId"=o."workspaceId"
 WHERE assigned."workerGrantId"=worker_grant_id AND assigned."authorityEpochId"=epoch_id
   AND a."workerInstanceGrantId"=worker_grant_id AND a."authorityEpochId"=epoch_id AND a."authorityAcceptedAt" IS NOT NULL
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
 original := $old$'app.read_scan_installed_worker_operations(text,integer,text,text,text,text,text)'::regprocedure))$old$;
 replacement := $new$'app.read_scan_installed_worker_operations(text,integer,text,text,text,text,text)'::regprocedure,
 'app.read_scan_installed_worker_cleanup_grant(text,integer,text,text,text)'::regprocedure,
 'app.read_scan_installed_worker_cleanup_operations(text,integer,text,text,text,text,text)'::regprocedure))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unknown native read role closure'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION app.read_scan_installed_worker_cleanup_grant(TEXT,INTEGER,TEXT,TEXT,TEXT),app.read_scan_installed_worker_cleanup_operations(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.read_scan_installed_worker_cleanup_grant(TEXT,INTEGER,TEXT,TEXT,TEXT),app.read_scan_installed_worker_cleanup_operations(TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT) TO app_native_origin_reader;
 END IF;
END $$;
