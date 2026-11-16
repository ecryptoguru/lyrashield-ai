import { randomBytes } from "node:crypto"
import type pg from "pg"

/** Two separately scoped disposable roles exercise the real stage/freeze boundary. */
export async function installLifecycleFixtureRoles(owner: pg.Pool) {
  const password = randomBytes(24).toString("hex")
  await owner.query(`
CREATE ROLE dispatch_proof_fixture LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA app TO dispatch_proof_fixture;
GRANT EXECUTE ON FUNCTION app.require_scan_dispatch_proof_role(),app.register_scan_dispatch_lifecycle_proof(text) TO dispatch_proof_fixture;
CREATE ROLE dispatch_start_stage LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE dispatch_native_fixture LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
GRANT dispatch_prepare_broker TO dispatch_native_fixture;
GRANT USAGE ON SCHEMA public,app TO dispatch_start_stage;
GRANT SELECT ON "Workspace","WorkspaceMember",users,"BillingAccount","Target","Policy","Scan","ScanAuthorityEpoch","ScanWorkerInstanceGrant","ScanDispatchOperation","ScanDispatchAttempt","ScanPhysicalExecution","ScanDispatchOutbox","ScanDispatchStart","ScanCapacityReservation","UserScanSlot","ScanEvent",agent_connections,agent_operations,delegated_scan_provenance TO dispatch_start_stage;
GRANT UPDATE("updatedAt") ON "ScanAuthorityEpoch","ScanWorkerInstanceGrant" TO dispatch_start_stage;
GRANT UPDATE(state,"updatedAt") ON "ScanDispatchOperation","ScanCapacityReservation" TO dispatch_start_stage;
GRANT UPDATE(status,"startedAt","updatedAt") ON "Scan" TO dispatch_start_stage;
GRANT INSERT ON "ScanDispatchStart","ScanEvent" TO dispatch_start_stage;
GRANT EXECUTE ON FUNCTION app.scan_preparation_context(text),app.scan_dispatch_scope_digest(text),app.scan_target_snapshot_digest(text),app.scan_policy_digest(text),app.require_scan_dispatch_stage_role(),app.require_scan_dispatch_worker_stage(text,text),app.scan_dispatch_lifecycle_proof_current(text,boolean),public.digest(bytea,text) TO dispatch_start_stage;
GRANT SELECT ON "ScanSupervisorJournalRecord","ScanSupervisorJournalStream" TO dispatch_native_fixture;
GRANT SELECT,INSERT ON "ScanExecutionActionIntent" TO dispatch_native_fixture;
GRANT SELECT ON "ScanDispatchStart" TO dispatch_receipt_consumer;
DO $$ DECLARE n TEXT; BEGIN
 FOREACH n IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanPhysicalExecution','ScanDispatchStart','ScanDispatchOutbox'] LOOP
  IF n IN ('ScanDispatchOperation','ScanDispatchAttempt','ScanPhysicalExecution') THEN
   EXECUTE format('CREATE POLICY lifecycle_stage ON public.%I FOR ALL TO dispatch_start_stage USING ("workspaceId"=app.current_workspace_id()) WITH CHECK ("workspaceId"=app.current_workspace_id())',n);
  ELSE
   EXECUTE format('CREATE POLICY lifecycle_stage ON public.%I FOR ALL TO dispatch_start_stage USING (EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"=%I."attemptId" AND a."workspaceId"=app.current_workspace_id()))',n,n);
  END IF;
 END LOOP;
END $$;
CREATE POLICY lifecycle_stage_grant ON "ScanWorkerInstanceGrant" FOR ALL TO dispatch_start_stage USING(true);
CREATE POLICY lifecycle_stage_epoch ON "ScanAuthorityEpoch" FOR ALL TO dispatch_start_stage USING(true);
CREATE POLICY lifecycle_native_journal ON "ScanSupervisorJournalRecord" FOR SELECT TO dispatch_native_fixture USING(true);
CREATE POLICY lifecycle_native_stream ON "ScanSupervisorJournalStream" FOR SELECT TO dispatch_native_fixture USING(true);
CREATE POLICY lifecycle_receipt_start ON "ScanDispatchStart" FOR SELECT TO dispatch_receipt_consumer USING(EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"="ScanDispatchStart"."attemptId" AND a."workspaceId"=app.current_workspace_id()));
`)
  const roleUrl = (role: string) => {
    const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
    url.username = role
    url.password = password
    return url.toString()
  }
  return {
    stageUrl: roleUrl("dispatch_start_stage"),
    nativeUrl: roleUrl("dispatch_native_fixture"),
    proofUrl: roleUrl("dispatch_proof_fixture"),
  }
}
