-- An external native observer reads the original live guard; it never acquires
-- or impersonates the originating session's gate and has no writer privileges.
CREATE FUNCTION app.scan_native_origin_reader_eligible() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF session_user<>'app_native_origin_reader' OR NOT EXISTS(
   SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin AND NOT rolsuper
     AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit
 ) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user))
   OR has_database_privilege(session_user,current_database(),'CREATE,TEMPORARY')
   OR EXISTS(SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(session_user,n.oid,'CREATE'))
   -- PostgreSQL permits settings-view updates as SET, never as data/role grants.
   OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind IN ('r','p','v','m','f') AND c.oid<>'pg_catalog.pg_settings'::regclass
     AND (has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE,REFERENCES')))
   OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind='S' AND has_sequence_privilege(session_user,c.oid,'USAGE,UPDATE'))
   OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosecdef AND has_function_privilege(session_user,p.oid,'EXECUTE')
     AND p.oid NOT IN ('app.scan_preparation_context(text)'::regprocedure,
       'app.scan_native_executor_origin_gate_held(text)'::regprocedure,
       'app.read_scan_native_origin_guard(text)'::regprocedure)) THEN
  RETURN false;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION app.require_scan_native_origin_reader() RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,app AS $$
BEGIN
 IF session_user IS DISTINCT FROM current_user OR NOT app.scan_native_origin_reader_eligible()
   OR current_setting('transaction_read_only')<>'on'
   OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'native origin observer requires its direct restricted READ ONLY login' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION app.scan_native_executor_origin_gate_held(guard_id TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF NOT app.scan_native_origin_reader_eligible() OR current_setting('transaction_read_only')<>'on'
   OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RETURN false;
 END IF;
 PERFORM pg_stat_clear_snapshot();
 RETURN EXISTS(
  SELECT 1 FROM "ScanExecutionInvocationGuard" g
  JOIN "ScanDispatchAttempt" a ON a."operationId"=g."operationId" AND a."attemptId"=g."attemptId"
    AND a."scanId"=g."scanId" AND a."workspaceId"=g."workspaceId" AND a."authorityEpochId"=g."authorityEpochId"
  JOIN "ScanWorkerInstanceGrant" w ON w.id=a."workerInstanceGrantId" AND w."authorityEpochId"=g."authorityEpochId"
  JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
  JOIN pg_stat_activity backend ON backend.pid=g."nativeBackendPid" AND backend.backend_start=g."nativeBackendStart"
    AND backend.datid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND backend.backend_type='client backend' AND backend.pid<>pg_backend_pid()
  JOIN pg_locks held_lock ON held_lock.pid=backend.pid AND held_lock.locktype='advisory' AND held_lock.classid=1819234670
    AND held_lock.objid=1 AND held_lock.objsubid=2 AND held_lock.mode='ExclusiveLock' AND held_lock.granted
  WHERE g.id=guard_id AND g.phase IN ('PREPARE','EXECUTOR_CREATE','EXECUTOR_START','PROVIDER_DISPATCH','SANDBOX_TOOL')
    AND g."nativeBackendPid" IS NOT NULL AND g."nativeBackendStart" IS NOT NULL
    AND g."bindingInputJson"=app.scan_preparation_plan_json(g."bindingInputJson"::jsonb)
    AND g."bindingInputJson"::jsonb->>'operationId'=g."operationId"
    AND g."bindingInputJson"::jsonb->>'attemptId'=g."attemptId"
    AND g."bindingInputJson"::jsonb->>'scanId'=g."scanId"
    AND g."bindingInputJson"::jsonb->>'workspaceId'=g."workspaceId"
    AND g."bindingInputJson"::jsonb->>'authorityEpochId'=g."authorityEpochId"
    AND g."bindingInputJson"::jsonb->>'phase'=g.phase
    AND g."bindingInputJson"::jsonb->>'authorityChecksum'=g."authorityChecksum"
    AND g."bindingInputJson"::jsonb->>'actionChecksum'=g."actionChecksum"
    AND a."authorityAcceptedAt" IS NOT NULL AND a."expiresAt">clock_timestamp() AT TIME ZONE 'UTC'
    AND (g.phase<>'PREPARE' OR a."authorityDeadlineAt">clock_timestamp() AT TIME ZONE 'UTC')
    AND g."createdAt"<=clock_timestamp() AT TIME ZONE 'UTC'
    AND g."createdAt"+interval '10 seconds'>clock_timestamp() AT TIME ZONE 'UTC'
    AND w."revokedAt" IS NULL AND w."issuedAt"<=clock_timestamp() AT TIME ZONE 'UTC'
    AND w."expiresAt">clock_timestamp() AT TIME ZONE 'UTC' AND e."isOpen" AND e."closedAt" IS NULL
    AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)
 );
END $$;

CREATE FUNCTION app.read_scan_native_origin_guard(guard_id TEXT)
RETURNS TABLE("bindingInputJson" TEXT,"deadlineAt" TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF NOT app.scan_native_executor_origin_gate_held(guard_id) THEN
  RAISE EXCEPTION 'original native invocation is unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT g."bindingInputJson",least(g."createdAt"+interval '10 seconds',a."expiresAt",
   CASE WHEN g.phase='PREPARE' THEN a."authorityDeadlineAt" ELSE a."expiresAt" END,w."expiresAt") AT TIME ZONE 'UTC'
 FROM "ScanExecutionInvocationGuard" g JOIN "ScanDispatchAttempt" a
   ON a."operationId"=g."operationId" AND a."attemptId"=g."attemptId"
 JOIN "ScanWorkerInstanceGrant" w ON w.id=a."workerInstanceGrantId"
 WHERE g.id=guard_id;
END $$;

CREATE FUNCTION app.scan_native_origin_read_scope() RETURNS JSONB
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,app AS $$
DECLARE binding JSONB;
BEGIN
 -- RLS initplans may run before a policy's outer CASE. Ordinary roles must
 -- receive NULL without needing EXECUTE on the private guard reader.
 IF session_user<>'app_native_origin_reader' THEN RETURN NULL; END IF;
 SELECT g."bindingInputJson"::jsonb INTO binding
 FROM app.read_scan_native_origin_guard(current_setting('app.native_origin_guard_id',true)) g;
 RETURN binding;
END $$;

-- Private dispatch tables otherwise have no reader policy. These SELECT-only
-- policies expose the exact checked origin, never an arbitrary workspace GUC.
-- TO PUBLIC avoids creating a login or enabling credentials in a migration;
-- all other sessions take the false branch before any private helper call.
DO $$ DECLARE name TEXT; origin TEXT; predicate TEXT; BEGIN
 origin := '(SELECT app.scan_native_origin_read_scope())';
 FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanDispatchOutbox','ScanPhysicalExecution','ScanDispatchStart','ScanSupervisorReceipt'] LOOP
  predicate := format('"operationId"=(%s->>''operationId'')',origin);
  IF name<>'ScanDispatchOperation' THEN
   predicate := predicate || format(' AND "attemptId"=(%s->>''attemptId'')',origin);
  END IF;
  EXECUTE format('CREATE POLICY scan_native_origin_reader ON public.%I FOR SELECT TO PUBLIC USING (CASE WHEN session_user=''app_native_origin_reader'' THEN %s ELSE false END)',name,predicate);
 END LOOP;
 EXECUTE format('CREATE POLICY scan_native_origin_reader ON public."ScanAuthorityEpoch" FOR SELECT TO PUBLIC USING (CASE WHEN session_user=''app_native_origin_reader'' THEN id=(%s->>''authorityEpochId'') ELSE false END)',origin);
 EXECUTE format('CREATE POLICY scan_native_origin_reader ON public."ScanWorkerInstanceGrant" FOR SELECT TO PUBLIC USING (CASE WHEN session_user=''app_native_origin_reader'' THEN id=(SELECT a."workerInstanceGrantId" FROM public."ScanDispatchAttempt" a WHERE a."operationId"=(%s->>''operationId'') AND a."attemptId"=(%s->>''attemptId'')) ELSE false END)',origin,origin);
END $$;

-- Reuse every existing current-source predicate. The private guard selector
-- alone grants nothing: the bridge checks the direct role, real READ ONLY
-- transaction, original backend identity, live lock and immutable scoped guard.
DO $$ DECLARE definition TEXT; original TEXT; replacement TEXT; BEGIN
 SELECT pg_get_functiondef('app.check_scan_current_execution_authority(text,timestamp,text)'::regprocedure) INTO definition;
 original := $old$  PERFORM app.require_scan_preparation_role();
  IF phase='PREPARE' AND NOT app.scan_preparation_gate_held() THEN
    RAISE EXCEPTION 'PREPARE requires exclusive authority gate' USING ERRCODE='23514';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' OR NOT app.scan_execution_gate_held() THEN
    RAISE EXCEPTION 'preparation requires its READ COMMITTED transaction gate' USING ERRCODE='23514';
  END IF;$old$;
 replacement := $new$  IF session_user='app_native_origin_reader' THEN
    PERFORM app.require_scan_native_origin_reader();
    IF NOT app.scan_native_executor_origin_gate_held(current_setting('app.native_origin_guard_id',true))
      OR NOT EXISTS(SELECT 1 FROM public."ScanExecutionInvocationGuard" native_guard
        WHERE native_guard.id=current_setting('app.native_origin_guard_id',true)
          AND native_guard."scanId"=scan_id AND native_guard.phase=check_scan_current_execution_authority.phase) THEN
      RAISE EXCEPTION 'original native execution gate is unavailable' USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM app.require_scan_preparation_role();
    IF phase='PREPARE' AND NOT app.scan_preparation_gate_held() THEN
      RAISE EXCEPTION 'PREPARE requires exclusive authority gate' USING ERRCODE='23514';
    END IF;
    IF current_setting('transaction_isolation') <> 'read committed' OR NOT app.scan_execution_gate_held() THEN
      RAISE EXCEPTION 'preparation requires its READ COMMITTED transaction gate' USING ERRCODE='23514';
    END IF;
  END IF;$new$;
 IF position(original IN definition)=0 THEN
  RAISE EXCEPTION 'native reader cannot replace an unknown authority gate';
 END IF;
 EXECUTE replace(definition,original,replacement);
END $$;

REVOKE ALL ON FUNCTION app.scan_native_origin_reader_eligible(),app.require_scan_native_origin_reader(),
 app.scan_native_executor_origin_gate_held(TEXT),app.read_scan_native_origin_guard(TEXT) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_native_origin_reader') THEN
  GRANT EXECUTE ON FUNCTION app.scan_native_origin_reader_eligible(),app.require_scan_native_origin_reader(),
   app.scan_native_executor_origin_gate_held(TEXT),app.read_scan_native_origin_guard(TEXT) TO app_native_origin_reader;
 END IF;
END $$;
