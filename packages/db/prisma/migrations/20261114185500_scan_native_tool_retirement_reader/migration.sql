-- A root-only retained read returns pending tools of the exact original sandbox
-- CREATE guard, only after an authenticated stored STOP has been confirmed.
CREATE FUNCTION app.read_scan_native_pending_tool_guards(original_create_guard_id TEXT)
RETURNS TABLE("guardId" TEXT,"bindingInputJson" TEXT,"actionInputJson" TEXT,"actionChecksum" TEXT,"commandInputChecksum" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE original public."ScanExecutionInvocationGuard"%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.read_scan_native_retirement_guard(original_create_guard_id)) THEN
  RAISE EXCEPTION 'pending tool cleanup requires authenticated original STOP authority' USING ERRCODE='42501'; END IF;
 SELECT * INTO original FROM "ScanExecutionInvocationGuard" WHERE id=original_create_guard_id AND phase='EXECUTOR_CREATE' AND "executorKey"='sandbox';
 IF original.id IS NULL THEN RAISE EXCEPTION 'original sandbox CREATE is unavailable' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM "ScanExecutionInvocationGuard" g WHERE g.phase='SANDBOX_TOOL'
   AND g."operationId"=original."operationId" AND g."attemptId"=original."attemptId" AND g."workspaceId"=original."workspaceId" AND g."authorityEpochId"=original."authorityEpochId"
   AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id))>32 THEN
  RAISE EXCEPTION 'pending tool retirement exceeds supported bound' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT g.id,g."bindingInputJson",i."actionInputJson",g."actionChecksum",c."commandInputChecksum"
 FROM "ScanExecutionInvocationGuard" g JOIN "ScanExecutionActionIntent" i
 ON i."operationId"=g."operationId" AND i."attemptId"=g."attemptId" AND i."workspaceId"=g."workspaceId" AND i."authorityEpochId"=g."authorityEpochId"
   AND i.phase=g.phase AND i."requestId"=g."requestId" AND i."actionChecksum"=g."actionChecksum" AND i."authorityChecksum"=g."authorityChecksum"
 JOIN "ScanDispatchOutbox" c ON c.id=g."commandId" AND c.id=i."prepareCommandId" AND c."operationId"=g."operationId" AND c."attemptId"=g."attemptId" AND c."commandType"='PREPARE'
 WHERE g.phase='SANDBOX_TOOL' AND g."executorKey"='sandbox' AND g."operationId"=original."operationId" AND g."attemptId"=original."attemptId"
   AND g."workspaceId"=original."workspaceId" AND g."authorityEpochId"=original."authorityEpochId"
   AND g."nativeBackendPid" IS NOT NULL AND g."nativeBackendStart" IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)
   AND g."bindingInputJson"=app.scan_preparation_plan_json(g."bindingInputJson"::jsonb)
   AND g."bindingInputJson"::jsonb->>'phase'=g.phase AND g."bindingInputJson"::jsonb->>'executorKey'=g."executorKey"
   AND g."bindingInputJson"::jsonb->>'operationId'=g."operationId" AND g."bindingInputJson"::jsonb->>'attemptId'=g."attemptId"
   AND g."bindingInputJson"::jsonb->>'workspaceId'=g."workspaceId" AND g."bindingInputJson"::jsonb->>'authorityEpochId'=g."authorityEpochId"
   AND g."bindingInputJson"::jsonb->>'actionChecksum'=g."actionChecksum" AND g."bindingInputJson"::jsonb->>'authorityChecksum'=g."authorityChecksum"
   AND g."bindingInputJson"::jsonb->>'requestId'=g."requestId" AND g."bindingInputJson"::jsonb->>'commandId'=g."commandId"
   AND i."actionInputJson"=app.scan_preparation_plan_json(i."actionInputJson"::jsonb)
   AND i."actionChecksum"=encode(public.digest(convert_to(i."actionInputJson",'UTF8'),'sha256'),'hex')
   AND c."commandInputJson"=app.scan_preparation_plan_json(c."commandInputJson"::jsonb)
   AND c."commandInputChecksum"=encode(public.digest(convert_to(c."commandInputJson",'UTF8'),'sha256'),'hex');
END $$;
DO $$ DECLARE definition TEXT; original TEXT; replacement TEXT; BEGIN
 SELECT pg_get_functiondef('app.scan_native_origin_reader_eligible()'::regprocedure) INTO definition;
 original := $old$'app.read_scan_installed_worker_grant(text,integer,text,text,text)'::regprocedure))$old$;
 replacement := $new$'app.read_scan_installed_worker_grant(text,integer,text,text,text)'::regprocedure,
       'app.read_scan_native_pending_tool_guards(text)'::regprocedure))$new$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'unknown native read role closure'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
REVOKE ALL ON FUNCTION app.read_scan_native_pending_tool_guards(TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.read_scan_native_pending_tool_guards(TEXT) TO app_native_origin_reader;
 END IF;
END $$;
