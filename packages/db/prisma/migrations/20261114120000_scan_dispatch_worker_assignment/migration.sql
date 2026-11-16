-- Single-worker launch only. No production grants, activation or legacy backfill.
CREATE TABLE "ScanDispatchWorkerAssignment" (
  "operationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "workerGrantId" TEXT NOT NULL,
  "authorityEpochId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanDispatchWorkerAssignment_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "ScanDispatchWorkerAssignment_operationId_fkey" FOREIGN KEY ("operationId")
    REFERENCES "ScanDispatchOperation"("operationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScanDispatchWorkerAssignment_workerGrantId_fkey" FOREIGN KEY ("workerGrantId")
    REFERENCES "ScanWorkerInstanceGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ScanDispatchWorkerAssignment_authorityEpochId_fkey" FOREIGN KEY ("authorityEpochId")
    REFERENCES "ScanAuthorityEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ScanDispatchWorkerAssignment_workspaceId_workerGrantId_idx"
  ON "ScanDispatchWorkerAssignment"("workspaceId","workerGrantId");

CREATE FUNCTION app.guard_scan_dispatch_worker_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'worker assignments are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "ScanDispatchOperation" o
    JOIN "ScanWorkerInstanceGrant" g ON g.id=NEW."workerGrantId"
    JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
    WHERE o."operationId"=NEW."operationId" AND o."workspaceId"=NEW."workspaceId"
      AND g."authorityEpochId"=NEW."authorityEpochId" AND e."isOpen" AND e."openKey"='open'
      AND g."revokedAt" IS NULL AND g."issuedAt"<=clock_timestamp() AND g."expiresAt">clock_timestamp()) THEN
    RAISE EXCEPTION 'worker assignment identity is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scan_dispatch_worker_assignment_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON "ScanDispatchWorkerAssignment" FOR EACH ROW EXECUTE FUNCTION app.guard_scan_dispatch_worker_assignment();
CREATE TRIGGER scan_preparation_writer_gate BEFORE INSERT OR UPDATE OR DELETE
  ON "ScanDispatchWorkerAssignment" FOR EACH STATEMENT EXECUTE FUNCTION app.scan_preparation_writer_gate();

-- Only a trusted publisher receives EXECUTE. It cannot select a requested worker.
CREATE FUNCTION app.assign_scan_dispatch_worker(operation_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE scope_id TEXT; grant_id TEXT; epoch_id TEXT; existing public."ScanDispatchWorkerAssignment"%ROWTYPE;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(1819234670,1) THEN
    RAISE EXCEPTION 'assignment authority is busy' USING ERRCODE='55000';
  END IF;
  SELECT o."workspaceId" INTO scope_id FROM "ScanDispatchOperation" o
    JOIN "Scan" s ON s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
    JOIN "ScanQueueOutbox" q ON q."operationId"=o."operationId" AND q."scanId"=s.id
    WHERE o."operationId"=operation_id
      AND o."workspaceId"=current_setting('app.current_workspace_id',true)
      AND o.state IN ('QUEUED','WAITING_CAPACITY') AND s."deletedAt" IS NULL
      AND q."jobId"=s.id AND q."payloadInputJson" IS NOT NULL
      AND q."payloadDigest"=encode(public.digest(convert_to(q."payloadInputJson",'UTF8'),'sha256'),'hex')
      AND o."requestDigest"=app.scan_dispatch_scope_digest(s.id)
    FOR UPDATE OF o;
  IF scope_id IS NULL THEN
    RAISE EXCEPTION 'assignment source is unavailable' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM "ScanAuthorityEpoch" WHERE "isOpen")<>1 THEN
    RAISE EXCEPTION 'single worker epoch is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT id INTO epoch_id FROM "ScanAuthorityEpoch" WHERE "isOpen" AND "openKey"='open'
    AND epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch") FOR SHARE;
  IF epoch_id IS NULL OR (SELECT count(*) FROM "ScanWorkerInstanceGrant"
    WHERE "authorityEpochId"=epoch_id AND "revokedAt" IS NULL
      AND "issuedAt"<=clock_timestamp() AND "expiresAt">clock_timestamp())<>1 THEN
    RAISE EXCEPTION 'single live worker grant is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT id INTO grant_id FROM "ScanWorkerInstanceGrant" WHERE "authorityEpochId"=epoch_id
    AND "revokedAt" IS NULL AND "issuedAt"<=clock_timestamp() AND "expiresAt">clock_timestamp() FOR SHARE;
  SELECT * INTO existing FROM "ScanDispatchWorkerAssignment" WHERE "operationId"=operation_id;
  IF FOUND THEN
    IF existing."workspaceId"<>scope_id OR existing."workerGrantId"<>grant_id
      OR existing."authorityEpochId"<>epoch_id THEN
      RAISE EXCEPTION 'existing worker assignment cannot be replaced' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM "ScanQueueOutbox" WHERE "operationId"=operation_id AND state<>'PENDING') THEN
    RAISE EXCEPTION 'assignment must precede publication' USING ERRCODE='23514';
  END IF;
  INSERT INTO "ScanDispatchWorkerAssignment"("operationId","workspaceId","workerGrantId","authorityEpochId")
    VALUES(operation_id,scope_id,grant_id,epoch_id);
END $$;
REVOKE ALL ON FUNCTION app.assign_scan_dispatch_worker(TEXT) FROM PUBLIC;

-- Read only, exact-operation credential proof. Source writers are fenced on
-- the same connection until the caller commits; no stored hash is returned.
CREATE FUNCTION app.require_scan_dispatch_worker(operation_id TEXT, credential_digest TEXT)
RETURNS TABLE("workerGrantId" TEXT,"workerInstanceId" TEXT,"authorityEpochId" TEXT,"attemptId" TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT app.scan_preparation_gate_held() OR credential_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'worker verification requires current authority gate' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT g.id,g."instanceId",g."authorityEpochId",a."attemptId"
    FROM "ScanDispatchWorkerAssignment" assigned
    JOIN "ScanDispatchOperation" o ON o."operationId"=assigned."operationId" AND o."workspaceId"=assigned."workspaceId"
    JOIN "ScanWorkerInstanceGrant" g ON g.id=assigned."workerGrantId" AND g."authorityEpochId"=assigned."authorityEpochId"
    JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
    LEFT JOIN "ScanDispatchAttempt" a ON a."operationId"=o."operationId"
    WHERE o."operationId"=operation_id
      AND o."workspaceId"=current_setting('app.current_workspace_id',true)
      AND g."credentialHash"=credential_digest AND g."revokedAt" IS NULL
      AND g."issuedAt"<=clock_timestamp() AND g."expiresAt">clock_timestamp()
      AND e."isOpen" AND e."openKey"='open' AND e.epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch")
      AND (SELECT count(*) FROM "ScanAuthorityEpoch" WHERE "isOpen")=1
      AND (SELECT count(*) FROM "ScanWorkerInstanceGrant" live WHERE live."authorityEpochId"=e.id
        AND live."revokedAt" IS NULL AND live."issuedAt"<=clock_timestamp() AND live."expiresAt">clock_timestamp())=1
      AND (a."attemptId" IS NULL OR (a."workerInstanceGrantId"=g.id AND a."authorityEpochId"=e.id));
END $$;
REVOKE ALL ON FUNCTION app.require_scan_dispatch_worker(TEXT,TEXT) FROM PUBLIC;

-- Ledger-only staging cannot consume native authority; freeze rechecks the exclusive gate.
CREATE FUNCTION app.require_scan_dispatch_worker_stage(operation_id TEXT, credential_digest TEXT)
RETURNS TABLE("workerGrantId" TEXT,"workerInstanceId" TEXT,"authorityEpochId" TEXT,"attemptId" TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
    AND pid=pg_backend_pid() AND classid=1819234670 AND objid=1 AND objsubid=2
    AND mode IN ('ShareLock','ExclusiveLock') AND granted) OR credential_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'worker verification requires current authority gate' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT g.id,g."instanceId",g."authorityEpochId",a."attemptId"
    FROM "ScanDispatchWorkerAssignment" assigned
    JOIN "ScanDispatchOperation" o ON o."operationId"=assigned."operationId" AND o."workspaceId"=assigned."workspaceId"
    JOIN "ScanWorkerInstanceGrant" g ON g.id=assigned."workerGrantId" AND g."authorityEpochId"=assigned."authorityEpochId"
    JOIN "ScanAuthorityEpoch" e ON e.id=g."authorityEpochId"
    LEFT JOIN "ScanDispatchAttempt" a ON a."operationId"=o."operationId"
    WHERE o."operationId"=operation_id
      AND o."workspaceId"=current_setting('app.current_workspace_id',true)
      AND g."credentialHash"=credential_digest AND g."revokedAt" IS NULL
      AND g."issuedAt"<=clock_timestamp() AND g."expiresAt">clock_timestamp()
      AND e."isOpen" AND e."openKey"='open' AND e.epoch=(SELECT max(epoch) FROM "ScanAuthorityEpoch")
      AND (SELECT count(*) FROM "ScanAuthorityEpoch" WHERE "isOpen")=1
      AND (SELECT count(*) FROM "ScanWorkerInstanceGrant" live WHERE live."authorityEpochId"=e.id
        AND live."revokedAt" IS NULL AND live."issuedAt"<=clock_timestamp() AND live."expiresAt">clock_timestamp())=1
      AND (a."attemptId" IS NULL OR (a."workerInstanceGrantId"=g.id AND a."authorityEpochId"=e.id))
    FOR SHARE OF g,e;
END $$;
REVOKE ALL ON FUNCTION app.require_scan_dispatch_worker_stage(TEXT,TEXT) FROM PUBLIC;

ALTER TABLE "ScanDispatchWorkerAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScanDispatchWorkerAssignment" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "ScanDispatchWorkerAssignment" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['app_runtime_prod','app_system_prod','app_runtime_ci'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public."ScanDispatchWorkerAssignment" FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION app.assign_scan_dispatch_worker(TEXT) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION app.require_scan_dispatch_worker(TEXT,TEXT) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION app.require_scan_dispatch_worker_stage(TEXT,TEXT) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;

-- Preserve the role isolation contract; only the read-only worker verifier is reachable.
CREATE OR REPLACE FUNCTION app.require_scan_preparation_role() RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE name TEXT; column_name TEXT; role_name TEXT;
BEGIN
  IF session_user IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'preparation requires a direct restricted login' USING ERRCODE='42501';
  END IF;
  FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles WHERE pg_has_role(current_user,oid,'SET') LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
    OR has_schema_privilege(role_name,'public','CREATE') OR has_schema_privilege(role_name,'app','CREATE')
    OR has_database_privilege(role_name,current_database(),'CREATE')
    OR has_database_privilege(role_name,current_database(),'TEMPORARY') THEN
    RAISE EXCEPTION 'preparation broker role can bypass authority isolation' USING ERRCODE='42501';
  END IF;
  FOREACH name IN ARRAY ARRAY['Workspace','WorkspaceMember','users','BillingAccount','agent_connections',
    'agent_operations','delegated_scan_provenance','Target','Policy'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
      RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['Scan','UserScanSlot','ScanCapacityReservation','ScanAuthorityEpoch','ScanWorkerInstanceGrant'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
    END IF;
    FOR column_name IN SELECT attname FROM pg_catalog.pg_attribute
      WHERE attrelid=format('public.%I',name)::regclass AND attnum>0 AND NOT attisdropped AND attname<>'updatedAt' LOOP
      IF has_column_privilege(role_name,format('public.%I',name),column_name,'UPDATE') THEN
        RAISE EXCEPTION 'preparation broker role has authority writer privileges' USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanDispatchStart','ScanSupervisorReceipt','ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'INSERT,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege(role_name,format('public.%I',name),'UPDATE') THEN
      RAISE EXCEPTION 'preparation broker role can consume physical authority' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanDispatchOutbox','ScanPhysicalExecution','ScanQueueOutbox'] LOOP
    IF has_table_privilege(role_name,format('public.%I',name),'DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'preparation broker role can bypass immutable intent' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef
      AND p.oid NOT IN ('app.scan_preparation_context(text)'::regprocedure,
        'app.require_scan_dispatch_worker(text,text)'::regprocedure)
      AND has_function_privilege(role_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'preparation broker role can reach an unreviewed definer' USING ERRCODE='42501';
  END IF;
  END LOOP;
END $$;
