import { createHmac, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type pg from "pg"
import { z } from "zod"
import {
  SignedJournal,
  canonicalJson,
  authorityEventSchema,
  type SupervisorJournalCursor,
} from "@lyrashield/runtime-control"
import { sha256Hex } from "../../src/scan-supervisor-receipt-verifier"
import type { SupervisorReceiptAuthority } from "../../src/scan-supervisor-receipt-ingestion-verifier"
import type { PreparationFixture } from "./scan-preparation-fixture"

export async function installReceiptRole(owner: pg.Pool) {
  if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
    throw new Error("Disposable fixture required")
  const password = randomBytes(24).toString("hex")
  await owner.query(`CREATE ROLE dispatch_receipt_consumer LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA public,app TO dispatch_receipt_consumer;
GRANT SELECT ON "ScanSupervisorJournalStream","ScanSupervisorJournalRecord","ScanDispatchOperation","ScanDispatchAttempt","ScanDispatchOutbox","ScanPhysicalExecution","ScanSupervisorReceipt","ScanPhysicalExecutionTransition","ScanAuthorityEpoch","Scan","Workspace","WorkspaceMember",users,"BillingAccount","Target","Policy" TO dispatch_receipt_consumer;
GRANT SELECT ON "ScanExecutionActionIntent","ScanExecutionInvocationGuard","ScanExecutionInvocationResolution" TO dispatch_receipt_consumer;
GRANT INSERT ON "ScanExecutionInvocationResolution" TO dispatch_receipt_consumer;
GRANT SELECT,INSERT ON "ScanDispatchReleaseReceipt" TO dispatch_receipt_consumer;
GRANT INSERT ON "ScanSupervisorJournalRecord","ScanSupervisorReceipt","ScanPhysicalExecutionTransition" TO dispatch_receipt_consumer;
GRANT UPDATE("confirmedSequence","originalHash","wrapperHash","headInputJson","projectionSequence","projectionHash","updatedAt") ON "ScanSupervisorJournalStream" TO dispatch_receipt_consumer;
GRANT UPDATE("updatedAt") ON "Scan","ScanAuthorityEpoch" TO dispatch_receipt_consumer;
GRANT UPDATE("terminalReason") ON "ScanDispatchOperation" TO dispatch_receipt_consumer;
GRANT UPDATE(state,"updatedAt") ON "ScanDispatchOperation" TO dispatch_receipt_consumer;
GRANT UPDATE(status,"deliveredAt","updatedAt") ON "ScanDispatchOutbox" TO dispatch_receipt_consumer;
GRANT UPDATE(state,revision,"unresolvedKey","lastReceiptId","updatedAt") ON "ScanPhysicalExecution" TO dispatch_receipt_consumer;
GRANT EXECUTE ON FUNCTION app.require_scan_dispatch_worker(text,text),app.scan_preparation_context(text),app.scan_preparation_gate_held(),app.scan_preparation_plan_json(jsonb),app.scan_supervisor_preparation_completed(text),app.current_workspace_id(),public.digest(bytea,text) TO dispatch_receipt_consumer;
DO $$ BEGIN IF to_regprocedure('app.require_scan_dispatch_worker_cleanup(text,text)') IS NOT NULL THEN GRANT EXECUTE ON FUNCTION app.require_scan_dispatch_worker_cleanup(TEXT,TEXT) TO dispatch_receipt_consumer; END IF; END $$;
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['ScanDispatchOperation','ScanDispatchAttempt','ScanDispatchOutbox','ScanPhysicalExecution','ScanSupervisorReceipt','ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt'] LOOP
  IF name IN ('ScanDispatchOperation','ScanDispatchAttempt','ScanPhysicalExecution') THEN
   EXECUTE format('CREATE POLICY fixture_receipt_scope ON public.%I FOR ALL TO dispatch_receipt_consumer USING ("workspaceId"=app.current_workspace_id()) WITH CHECK ("workspaceId"=app.current_workspace_id())',name);
  ELSE
   EXECUTE format('CREATE POLICY fixture_receipt_scope ON public.%I FOR ALL TO dispatch_receipt_consumer USING (EXISTS(SELECT 1 FROM "ScanDispatchAttempt" a WHERE a."attemptId"=%I."attemptId" AND a."workspaceId"=app.current_workspace_id()))',name,name);
  END IF;
 END LOOP;
END $$;
CREATE POLICY fixture_receipt_epoch ON "ScanAuthorityEpoch" FOR SELECT TO dispatch_receipt_consumer USING(true);
CREATE POLICY fixture_receipt_epoch_lock ON "ScanAuthorityEpoch" FOR UPDATE TO dispatch_receipt_consumer USING(true);`)
  const url = new URL(process.env.DISPATCH_PREPARATION_BROKER_DATABASE_URL!)
  url.username = "dispatch_receipt_consumer"
  url.password = password
  return url.toString()
}

export async function receiptJournal(
  owner: pg.Pool,
  f: PreparationFixture,
  connectionString: string,
  hold = true,
  alterCommand = false,
  positiveAfterHold = false
) {
  const root = await mkdtemp(join(tmpdir(), "receipt-pg-"))
  const command = (
    await owner.query(
      'SELECT "commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox" WHERE "operationId"=$1',
      [f.operationId]
    )
  ).rows[0]
  const input = JSON.parse(command.commandInputJson)
  if (alterCommand) input.executors[0].spec.env.FORGED = "not-approved"
  const originalSecret = randomBytes(32).toString("hex"),
    wrapperSecret = randomBytes(32).toString("hex")
  const original = new SignedJournal(
    join(root, "original"),
    originalSecret,
    (value) => value as Record<string, unknown>
  )
  const wrapped = new SignedJournal(
    join(root, "wrapped"),
    wrapperSecret,
    authorityEventSchema(z.unknown()).parse
  )
  const binding = {
    epochId: f.epochId,
    operationId: f.operationId,
    scanId: f.scanId,
    workspaceId: f.workspaceId,
    attemptId: input.attempt.attemptId,
  }
  const records = []
  const events: Record<string, unknown>[] = [
    { type: "command_intent", command: input },
    {
      type: "command_terminal",
      commandId: input.commandId,
      attemptId: input.attempt.attemptId,
      status: "PREPARED",
    },
  ]
  for (let i = 0; i < events.length; i++) {
    const signed = await original.append({
      ...events[i],
      supervisorInstanceId: f.instanceId,
      observedAt: "2026-11-13T10:00:00.000Z",
    })
    records.push(
      await wrapped.append({ ...binding, eventId: `supervisor:${signed.hash}`, payload: signed })
    )
    if (hold && i === 1)
      events.push({
        type: "command_recovery_hold",
        commandId: input.commandId,
        attemptId: input.attempt.attemptId,
        expectedCommandHash: command.commandInputChecksum,
        recoveredSequence: signed.sequence,
        recoveredHash: signed.hash,
      })
    if (positiveAfterHold && i === 2)
      events.push({
        type: "command_terminal",
        commandId: input.commandId,
        attemptId: input.attempt.attemptId,
        status: "PREPARED",
      })
  }
  await original.close()
  await wrapped.close()
  const tail = records.at(-1)!
  const unsigned = {
    schema: "lyrashield-independent-authority-head/1" as const,
    supervisorInstanceId: f.instanceId,
    ...binding,
    eventId: tail.payload.eventId,
    sequence: tail.sequence,
    previousHash: tail.previousHash,
    recordHash: tail.hash,
  }
  const head = {
    ...unsigned,
    signature: createHmac("sha256", wrapperSecret).update(canonicalJson(unsigned)).digest("hex"),
  }
  const streamId = `stream-${f.operationId}`
  await owner.query(
    'INSERT INTO "ScanSupervisorJournalStream"(id,"authorityEpochId","supervisorInstanceId","originalKeyHash","wrapperKeyHash","updatedAt") VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',
    [streamId, f.epochId, f.instanceId, sha256Hex(originalSecret), sha256Hex(wrapperSecret)]
  )
  const readJournal = async (cursor: SupervisorJournalCursor) => {
    const selected = records
      .filter((record) => record.sequence > cursor.afterSequence)
      .slice(0, Math.min(cursor.limit, 2))
    const last = selected.at(-1)
    const nextCursor = {
      ...cursor,
      afterSequence: last?.sequence ?? cursor.afterSequence,
      afterHash: last?.payload.payload.hash ?? cursor.afterHash,
      snapshotSequence: head.sequence,
      snapshotHash: head.recordHash,
    }
    return {
      records: selected,
      snapshotHead: head,
      nextCursor,
      hasMore: nextCursor.afterSequence < head.sequence,
    }
  }
  const authority: SupervisorReceiptAuthority = {
    connectionString,
    streamId,
    authorityEpochId: f.epochId,
    supervisorInstanceId: f.instanceId,
    originalSigningSecret: originalSecret,
    wrapperSigningSecret: wrapperSecret,
    originalKeyHash: sha256Hex(originalSecret),
    wrapperKeyHash: sha256Hex(wrapperSecret),
    readJournal,
  }
  return {
    authority,
    records,
    commandId: input.commandId,
    attemptId: input.attempt.attemptId,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
