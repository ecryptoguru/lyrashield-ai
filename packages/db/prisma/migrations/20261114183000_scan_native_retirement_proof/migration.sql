-- A confirmed, original owned-removal receipt retires a guard without replaying
-- its invocation or claiming a missing create/start acknowledgement.
CREATE FUNCTION app.scan_native_retirement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE g public."ScanExecutionInvocationGuard"%ROWTYPE;
 r public."ScanSupervisorReceipt"%ROWTYPE; j public."ScanSupervisorJournalRecord"%ROWTYPE;
 s public."ScanSupervisorJournalStream"%ROWTYPE; i public."ScanExecutionActionIntent"%ROWTYPE;
 e JSONB; p JSONB; removal JSONB; ownership JSONB; tool_proof JSONB; descriptor JSONB;
 command_checksum TEXT; phase TEXT;
BEGIN
 IF TG_OP<>'INSERT' OR NOT app.scan_preparation_gate_held() OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'native retirement requires its exclusive confirmed source fence' USING ERRCODE='23514'; END IF;
 SELECT * INTO g FROM "ScanExecutionInvocationGuard" WHERE id=NEW."guardId" AND "workspaceId"=app.current_workspace_id();
 SELECT * INTO r FROM "ScanSupervisorReceipt" WHERE id=NEW."receiptId";
 SELECT * INTO j FROM "ScanSupervisorJournalRecord" WHERE id=r."journalRecordId";
 SELECT * INTO s FROM "ScanSupervisorJournalStream" WHERE id=j."streamId" FOR UPDATE;
 e:=j."originalInputJson"::jsonb->'payload'; ownership:=e->'ownership'; removal:=e->'nativeRemovalProof';
 phase:=coalesce(e->>'phase','EXECUTOR_START');
 IF phase='SANDBOX_TOOL' THEN
  SELECT * INTO i FROM "ScanExecutionActionIntent" intent WHERE intent."operationId"=g."operationId" AND intent."attemptId"=g."attemptId"
    AND intent."workspaceId"=g."workspaceId" AND intent."authorityEpochId"=g."authorityEpochId" AND intent.phase='SANDBOX_TOOL'
    AND intent."requestId"=g."requestId" AND intent."actionChecksum"=g."actionChecksum" AND intent."authorityChecksum"=g."authorityChecksum";
  tool_proof:=e->'nativeToolRetirementProof'; descriptor:=i."actionInputJson"::jsonb;
 END IF;
 SELECT c."commandInputChecksum" INTO command_checksum FROM "ScanDispatchOutbox" c WHERE c.id=g."commandId"
  AND c."operationId"=g."operationId" AND c."attemptId"=g."attemptId" AND c."commandInputJson" IS NOT NULL;
 SELECT q."originalInputJson"::jsonb->'payload' INTO p FROM "ScanSupervisorJournalRecord" q
  WHERE q."streamId"=j."streamId" AND q."workspaceId"=g."workspaceId" AND q."operationId"=g."operationId" AND q."attemptId"=g."attemptId"
   AND q.sequence<j.sequence AND q."originalInputJson"::jsonb#>>'{payload,type}'='native_invocation_planned'
   AND q."originalInputJson"::jsonb#>>'{payload,guardId}'=g.id ORDER BY q.sequence DESC LIMIT 1;
 IF g.id IS NULL OR r.id IS NULL OR j.id IS NULL OR s.id IS NULL OR (phase<>'SANDBOX_TOOL' AND p IS NULL) OR command_checksum IS NULL
  OR e->>'type' IS DISTINCT FROM 'native_invocation_retired' OR e->>'nativeOperation' IS DISTINCT FROM 'CONTAINER_REMOVED'
  OR phase NOT IN ('EXECUTOR_CREATE','EXECUTOR_START','SANDBOX_TOOL') OR g.phase IS DISTINCT FROM phase OR (phase<>'SANDBOX_TOOL' AND coalesce(p->>'phase','EXECUTOR_START') IS DISTINCT FROM phase)
  OR j.sequence>s."confirmedSequence" OR r."receiptHash" IS DISTINCT FROM j."originalHash"
  OR r.signature IS DISTINCT FROM j."originalInputJson"::jsonb->>'signature' OR r."eventType" IS DISTINCT FROM e->>'type' OR r."terminalStatus" IS NOT NULL
  OR NEW."proofInputJson"::jsonb IS DISTINCT FROM e OR app.scan_preparation_plan_json(e) IS DISTINCT FROM NEW."proofInputJson"
  OR NEW."proofChecksum" IS DISTINCT FROM encode(public.digest(convert_to(NEW."proofInputJson",'UTF8'),'sha256'),'hex')
  OR e->>'guardId' IS DISTINCT FROM g.id OR e->>'nativeRequestId' IS DISTINCT FROM g.id
  OR e->>'commandId' IS DISTINCT FROM g."commandId" OR r."commandId" IS DISTINCT FROM g."commandId"
  OR e->>'attemptId' IS DISTINCT FROM g."attemptId" OR r."attemptId" IS DISTINCT FROM g."attemptId"
  OR e->>'operationId' IS DISTINCT FROM g."operationId" OR r."operationId" IS DISTINCT FROM g."operationId"
  OR j."workspaceId" IS DISTINCT FROM g."workspaceId" OR j."operationId" IS DISTINCT FROM g."operationId" OR j."attemptId" IS DISTINCT FROM g."attemptId"
  OR e->>'authorityEpochId' IS DISTINCT FROM g."authorityEpochId" OR r."authorityEpochId" IS DISTINCT FROM g."authorityEpochId"
  OR s."authorityEpochId" IS DISTINCT FROM g."authorityEpochId" OR e->>'supervisorInstanceId' IS DISTINCT FROM s."supervisorInstanceId"
  OR r."supervisorInstanceId" IS DISTINCT FROM s."supervisorInstanceId"
  OR e->>'executorKey' IS DISTINCT FROM g."executorKey" OR ownership->>'executorKey' IS DISTINCT FROM g."executorKey"
  OR ownership->>'kind' IS DISTINCT FROM 'container' OR coalesce(ownership->>'containerId','') !~ '^[a-f0-9]{64}$'
  OR (phase<>'SANDBOX_TOOL' AND ownership->>'ownershipId' IS DISTINCT FROM 'own_'||substring(encode(public.digest(convert_to(g."attemptId",'UTF8')||decode('00','hex')||convert_to(g."commandId",'UTF8')||decode('00','hex')||convert_to(g."executorKey",'UTF8'),'sha256'),'hex') FROM 1 FOR 40))
  OR e->'inspection' IS DISTINCT FROM '{"state":"ABSENT"}'::jsonb
  OR e->>'bindingInputChecksum' IS DISTINCT FROM encode(public.digest(convert_to(g."bindingInputJson",'UTF8'),'sha256'),'hex')
  OR e->>'actionChecksum' IS DISTINCT FROM g."actionChecksum" OR (phase<>'SANDBOX_TOOL' AND g."actionChecksum" IS DISTINCT FROM command_checksum)
  OR e->>'commandInputChecksum' IS DISTINCT FROM command_checksum
  OR (phase<>'SANDBOX_TOOL' AND EXISTS(SELECT 1 FROM unnest(ARRAY['guardId','nativeRequestId','commandId','attemptId','operationId','authorityEpochId','executorKey','bindingInputChecksum','actionChecksum','commandInputChecksum']) k WHERE p->k IS DISTINCT FROM e->k))
  OR NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" stop JOIN "ScanSupervisorJournalRecord" intent
    ON intent."streamId"=j."streamId" AND intent."workspaceId"=g."workspaceId" AND intent."operationId"=g."operationId" AND intent."attemptId"=g."attemptId"
    AND intent.sequence<j.sequence AND intent."originalInputJson"::jsonb#>>'{payload,type}'='command_intent'
    AND intent."originalInputJson"::jsonb#>'{payload,command}'=stop."commandInputJson"::jsonb
    WHERE stop.id=e->>'stopCommandId' AND stop."operationId"=g."operationId" AND stop."attemptId"=g."attemptId"
      AND stop."commandType"='STOP' AND stop."commandInputChecksum"=encode(public.digest(convert_to(stop."commandInputJson",'UTF8'),'sha256'),'hex'))
  OR (phase<>'SANDBOX_TOOL' AND e ? 'nativeToolRetirementProof')
  OR (phase='SANDBOX_TOOL' AND (
    i.id IS NULL OR g."executorKey" IS DISTINCT FROM 'sandbox' OR i."prepareCommandId" IS DISTINCT FROM g."commandId"
    OR removal IS NOT NULL OR jsonb_typeof(tool_proof) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(tool_proof))<>16
    OR tool_proof->>'schema' IS DISTINCT FROM 'lyrashield-native-tool-retirement/1' OR tool_proof->>'phase' IS DISTINCT FROM phase
    OR tool_proof->>'bindingInputJson' IS DISTINCT FROM g."bindingInputJson" OR tool_proof->>'requestId' IS DISTINCT FROM g."requestId"
    OR tool_proof->'ownership' IS DISTINCT FROM ownership OR tool_proof->'inspection' IS DISTINCT FROM e->'inspection'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['guardId','nativeRequestId','commandId','stopCommandId','operationId','attemptId','authorityEpochId','actionChecksum','commandInputChecksum']) k WHERE tool_proof->k IS DISTINCT FROM e->k)
    OR tool_proof->>'receiptSha256' IS DISTINCT FROM encode(public.digest(convert_to(app.scan_preparation_plan_json(tool_proof-'receiptSha256'),'UTF8'),'sha256'),'hex')
    OR i."actionInputJson" IS DISTINCT FROM app.scan_preparation_plan_json(descriptor)
    OR i."actionChecksum" IS DISTINCT FROM encode(public.digest(convert_to(i."actionInputJson",'UTF8'),'sha256'),'hex')
    OR descriptor->>'schema' IS DISTINCT FROM 'lyrashield-sandbox-tool-exec/1' OR descriptor->'ownership' IS DISTINCT FROM ownership
    OR descriptor#>>'{request,requestId}' IS DISTINCT FROM g."requestId"
    OR descriptor#>>'{request,binding,operationId}' IS DISTINCT FROM g."operationId" OR descriptor#>>'{request,binding,attemptId}' IS DISTINCT FROM g."attemptId"
    OR descriptor#>>'{request,binding,authorityEpochId}' IS DISTINCT FROM g."authorityEpochId"
    OR descriptor#>>'{request,binding,sandboxHandle}' IS DISTINCT FROM ownership->>'ownershipId'
    OR NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" c WHERE c.id=g."commandId" AND c."commandType"='PREPARE')
    OR NOT EXISTS(SELECT 1 FROM "ScanSupervisorReceipt" owned JOIN "ScanSupervisorJournalRecord" started ON started.id=owned."journalRecordId"
      WHERE owned.id=i."ownershipReceiptId" AND owned."operationId"=g."operationId" AND owned."attemptId"=g."attemptId"
        AND owned."authorityEpochId"=g."authorityEpochId" AND owned."eventType"='resource_started' AND owned."executorKey"='sandbox'
        AND started."streamId"=j."streamId" AND started."workspaceId"=g."workspaceId" AND started."operationId"=g."operationId" AND started."attemptId"=g."attemptId"
        AND started.sequence<j.sequence AND started.sequence<=s."confirmedSequence" AND started."originalHash"=owned."receiptHash"
        AND started."originalInputJson"::jsonb#>'{payload,ownership}'=ownership)))
  OR (phase='EXECUTOR_START' AND (p->'ownership' IS DISTINCT FROM ownership OR removal IS NOT NULL))
  OR (phase='EXECUTOR_CREATE' AND (
    p#>>'{ownership,containerId}' IS NOT NULL OR p#>>'{ownership,ownershipId}' IS DISTINCT FROM ownership->>'ownershipId'
    OR p#>>'{ownership,executorKey}' IS DISTINCT FROM g."executorKey" OR p#>>'{ownership,kind}' IS DISTINCT FROM 'container'
    OR removal->>'schema' IS DISTINCT FROM 'lyrashield-native-removal/1' OR removal->>'phase' IS DISTINCT FROM 'EXECUTOR_CREATE'
    OR removal->'ownership' IS DISTINCT FROM ownership OR removal->'inspection' IS DISTINCT FROM e->'inspection'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['guardId','nativeRequestId','commandId','stopCommandId','operationId','attemptId','authorityEpochId','bindingInputChecksum','actionChecksum']) k WHERE removal->k IS DISTINCT FROM e->k)
    OR removal->>'receiptSha256' IS DISTINCT FROM encode(public.digest(convert_to(app.scan_preparation_plan_json(removal-'receiptSha256'),'UTF8'),'sha256'),'hex'))) THEN
  RAISE EXCEPTION 'native retirement lacks exact original owned-removal proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.scan_native_retirement_guard() FROM PUBLIC;
DROP TRIGGER scan_execution_invocation_resolution_guard ON "ScanExecutionInvocationResolution";
CREATE TRIGGER scan_execution_invocation_resolution_guard BEFORE INSERT ON "ScanExecutionInvocationResolution"
 FOR EACH ROW WHEN (NEW."proofInputJson"::jsonb->>'type' IS DISTINCT FROM 'native_invocation_retired')
 EXECUTE FUNCTION app.scan_execution_invocation_resolution_guard();
CREATE TRIGGER scan_execution_invocation_resolution_immutable BEFORE UPDATE OR DELETE ON "ScanExecutionInvocationResolution"
 FOR EACH ROW EXECUTE FUNCTION app.scan_execution_invocation_resolution_guard();
CREATE TRIGGER scan_native_retirement_guard BEFORE INSERT ON "ScanExecutionInvocationResolution"
 FOR EACH ROW WHEN (NEW."proofInputJson"::jsonb->>'type'='native_invocation_retired')
 EXECUTE FUNCTION app.scan_native_retirement_guard();
