-- Historical observation and owned STOP cleanup remain distinct from the live
-- invocation gate. Neither reader authorizes a new execution or provider call.
CREATE FUNCTION app.read_scan_native_retained_guard(guard_id TEXT)
RETURNS TABLE("bindingInputJson" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF session_user<>'app_native_origin_reader' OR NOT app.scan_native_origin_reader_eligible()
   OR current_setting('transaction_read_only')<>'on' OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'retained native observation requires restricted READ ONLY root reader' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g."bindingInputJson" FROM "ScanExecutionInvocationGuard" g
 JOIN "ScanDispatchAttempt" a ON a."operationId"=g."operationId" AND a."attemptId"=g."attemptId"
   AND a."scanId"=g."scanId" AND a."workspaceId"=g."workspaceId" AND a."authorityEpochId"=g."authorityEpochId"
 WHERE g.id=guard_id AND g."nativeBackendPid" IS NOT NULL AND g."nativeBackendStart" IS NOT NULL
   AND g."bindingInputJson"=app.scan_preparation_plan_json(g."bindingInputJson"::jsonb)
   AND g."bindingInputJson"::jsonb->>'operationId'=g."operationId"
   AND g."bindingInputJson"::jsonb->>'attemptId'=g."attemptId"
   AND g."bindingInputJson"::jsonb->>'scanId'=g."scanId"
   AND g."bindingInputJson"::jsonb->>'workspaceId'=g."workspaceId"
   AND g."bindingInputJson"::jsonb->>'authorityEpochId'=g."authorityEpochId"
   AND g."bindingInputJson"::jsonb->>'phase'=g.phase
   AND g."bindingInputJson"::jsonb->>'authorityChecksum'=g."authorityChecksum"
   AND g."bindingInputJson"::jsonb->>'actionChecksum'=g."actionChecksum";
END $$;

CREATE FUNCTION app.read_scan_native_retirement_guard(guard_id TEXT)
RETURNS TABLE("bindingInputJson" TEXT,"commandInputJson" TEXT,"commandInputChecksum" TEXT,
 "originalInputJson" TEXT,"wrapperInputJson" TEXT,"headInputJson" TEXT,
 "confirmedSequence" TEXT,"streamId" TEXT,"sourceSequence" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 -- The retained reader proves the same fixed role and immutable scope first.
 IF NOT EXISTS(SELECT 1 FROM app.read_scan_native_retained_guard(guard_id)) THEN
  RAISE EXCEPTION 'original native guard is unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g."bindingInputJson",c."commandInputJson",c."commandInputChecksum",
   j."originalInputJson",j."wrapperInputJson",s."headInputJson",s."confirmedSequence"::text,s.id,j.sequence::text
 FROM "ScanExecutionInvocationGuard" g
 JOIN "ScanDispatchAttempt" a ON a."operationId"=g."operationId" AND a."attemptId"=g."attemptId"
   AND a."scanId"=g."scanId" AND a."workspaceId"=g."workspaceId" AND a."authorityEpochId"=g."authorityEpochId"
 JOIN "ScanDispatchOutbox" c ON c."operationId"=g."operationId" AND c."attemptId"=g."attemptId" AND c."commandType"='STOP'
 JOIN "ScanSupervisorReceipt" r ON r."commandId"=c.id AND r."operationId"=g."operationId" AND r."attemptId"=g."attemptId"
   AND r."authorityEpochId"=g."authorityEpochId" AND r."eventType"='command_intent'
 JOIN "ScanSupervisorJournalRecord" j ON j.id=r."journalRecordId" AND j."workspaceId"=g."workspaceId"
   AND j."operationId"=g."operationId" AND j."attemptId"=g."attemptId"
 JOIN "ScanSupervisorJournalStream" s ON s.id=j."streamId" AND s."authorityEpochId"=g."authorityEpochId"
   AND s."supervisorInstanceId"=r."supervisorInstanceId"
 WHERE g.id=guard_id AND g.phase IN ('EXECUTOR_CREATE','EXECUTOR_START')
   AND c."commandInputJson"=app.scan_preparation_plan_json(c."commandInputJson"::jsonb)
   AND c."commandInputChecksum"=encode(public.digest(convert_to(c."commandInputJson",'UTF8'),'sha256'),'hex')
   AND c."commandInputJson"::jsonb->>'type'='STOP' AND c."commandInputJson"::jsonb->>'commandId'=c.id
   AND c."commandInputJson"::jsonb->>'attemptId'=g."attemptId"
   AND j.sequence<=s."confirmedSequence" AND s."headInputJson" IS NOT NULL
   AND r."receiptHash"=j."originalHash" AND r.signature=j."originalInputJson"::jsonb->>'signature'
   AND j."originalInputJson"::jsonb#>>'{payload,type}'='command_intent'
   AND j."originalInputJson"::jsonb#>'{payload,command}'=c."commandInputJson"::jsonb
 ORDER BY c.sequence DESC,j.sequence LIMIT 2;
END $$;

-- Extend only the fixed read role's reviewed private read closure. Other role
-- guards and every live current-action gate remain unchanged.
DO $$ DECLARE definition TEXT; original TEXT; replacement TEXT; BEGIN
 SELECT pg_get_functiondef('app.scan_native_origin_reader_eligible()'::regprocedure) INTO definition;
 original := $old$'app.read_scan_native_origin_guard(text)'::regprocedure))$old$;
 replacement := $new$'app.read_scan_native_origin_guard(text)'::regprocedure,
       'app.read_scan_native_retained_guard(text)'::regprocedure,
       'app.read_scan_native_retirement_guard(text)'::regprocedure))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unknown native read role closure'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION app.read_scan_native_retained_guard(TEXT),app.read_scan_native_retirement_guard(TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.read_scan_native_retained_guard(TEXT),app.read_scan_native_retirement_guard(TEXT) TO app_native_origin_reader;
 END IF;
END $$;
