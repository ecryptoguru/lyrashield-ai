import { createId } from "@paralleldrive/cuid2"
import pg from "pg"
import {
  canonicalJson,
  type AuthorityHead,
  type SupervisorJournalCursor,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import { projectSupervisorSnapshot } from "./scan-supervisor-receipt-ingestion-projection"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"
import {
  requireScanDispatchWorkerAssignment,
  requireScanDispatchWorkerCleanup,
  scanDispatchWorkerRequestOperation,
} from "./scan-dispatch-worker-assignment"
import {
  checkReceiptKeys,
  receiptFailure,
  verifyReceiptPage,
  type IngestedSupervisorRecord,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import type { SupervisorReceiptCleanupScope } from "./scan-supervisor-receipt-ingestion-projection"

type InstalledStream = {
  confirmedSequence: string
  originalHash: string
  wrapperHash: string
  headInputJson: string | null
}

async function bindWorkerOperationContext(client: pg.PoolClient, operationId: string) {
  const result = await client.query<{ workspaceId: string }>(
    'SELECT "workspaceId" FROM app.scan_preparation_context($1)',
    [operationId]
  )
  const workspaceId = result.rows[0]?.workspaceId
  if (!workspaceId)
    throw new ScanDispatchAuthorityError("WORKER_GRANT_INVALID", "Worker authority is unavailable")
  await client.query("SELECT set_config('app.current_workspace_id',$1,true)", [workspaceId])
}

async function workerReceiptAuthority(
  client: pg.PoolClient,
  authority: SupervisorReceiptAuthority,
  operationId: string
): Promise<SupervisorReceiptCleanupScope | undefined> {
  await bindWorkerOperationContext(client, operationId)
  try {
    await requireScanDispatchWorkerAssignment(client, operationId)
    return undefined
  } catch (error) {
    if (!(error instanceof ScanDispatchAuthorityError) || error.code !== "WORKER_GRANT_INVALID")
      throw error
  }
  await requireScanDispatchWorkerCleanup(client, operationId)
  const result = await client.query<{
    attemptId: string
    prepareJson: string
    prepareChecksum: string
    commandId: string
    commandInputJson: string
    commandInputChecksum: string
  }>(
    `SELECT a."attemptId",p."commandInputJson" AS "prepareJson",p."commandInputChecksum" AS "prepareChecksum",
      c.id AS "commandId",c."commandInputJson",c."commandInputChecksum"
     FROM "ScanDispatchAttempt" a JOIN "ScanDispatchOutbox" p ON p."operationId"=a."operationId"
       AND p."attemptId"=a."attemptId" AND p."commandType"='PREPARE'
     JOIN "ScanDispatchOutbox" c ON c."operationId"=a."operationId" AND c."attemptId"=a."attemptId"
       AND c."commandType" IN ('STOP','RECONCILE')
     WHERE a."operationId"=$1 AND a."workspaceId"=app.current_workspace_id()
       AND a."authorityEpochId"=$2 AND a."authorityAcceptedAt" IS NOT NULL`,
    [operationId, authority.authorityEpochId]
  )
  const attempts = new Set<string>(),
    commands: string[] = []
  for (const row of result.rows) {
    const prepare = readStoredDispatchCommand(row.prepareJson, row.prepareChecksum)
    const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    if (
      !prepare ||
      prepare.type !== "PREPARE" ||
      !command ||
      !["STOP", "RECONCILE"].includes(command.type) ||
      command.commandId !== row.commandId ||
      !("attemptId" in command) ||
      command.attemptId !== row.attemptId ||
      prepare.attempt.attemptId !== row.attemptId ||
      prepare.attempt.operationId !== operationId ||
      prepare.attempt.authorityEpochId !== authority.authorityEpochId
    )
      throw new ScanDispatchAuthorityError(
        "WORKER_GRANT_INVALID",
        "Worker cleanup authority is unavailable"
      )
    attempts.add(row.attemptId)
    commands.push(command.commandId)
  }
  if (attempts.size !== 1 || !commands.length)
    throw new ScanDispatchAuthorityError(
      "WORKER_GRANT_INVALID",
      "Worker cleanup authority is unavailable"
    )
  return { attemptId: [...attempts][0]!, commandIds: commands }
}

async function installedStream(client: pg.PoolClient, authority: SupervisorReceiptAuthority) {
  const role = await client.query<{ safe: boolean }>(`SELECT session_user=current_user
    AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
    AND NOT has_table_privilege(current_user,'"ScanSupervisorJournalStream"','INSERT,DELETE,TRUNCATE,TRIGGER')
    AND NOT has_table_privilege(current_user,'"ScanSupervisorJournalRecord"','UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND NOT has_schema_privilege(current_user,'public','CREATE')
    AND NOT has_schema_privilege(current_user,'app','CREATE')
    AND NOT EXISTS (SELECT 1 FROM pg_roles reachable WHERE pg_has_role(current_user,reachable.oid,'MEMBER')
      AND (reachable.rolsuper OR reachable.rolbypassrls OR reachable.rolcreaterole OR reachable.rolcreatedb
        OR has_schema_privilege(reachable.oid,'public','CREATE') OR has_schema_privilege(reachable.oid,'app','CREATE')
        OR has_table_privilege(reachable.oid,'"ScanSupervisorJournalStream"','INSERT,DELETE,TRUNCATE,TRIGGER')
        OR has_table_privilege(reachable.oid,'"ScanSupervisorJournalRecord"','UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR has_table_privilege(reachable.oid,'"ScanDispatchAttempt"','INSERT,DELETE,TRUNCATE,TRIGGER')
        OR has_column_privilege(reachable.oid,'"ScanSupervisorJournalStream"','originalKeyHash','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanSupervisorJournalStream"','wrapperKeyHash','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanSupervisorJournalStream"','authorityEpochId','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanSupervisorJournalStream"','supervisorInstanceId','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanAuthorityEpoch"','isOpen','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanAuthorityEpoch"','openKey','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanDispatchOutbox"','commandInputJson','UPDATE')
        OR has_column_privilege(reachable.oid,'"ScanDispatchOutbox"','commandInputChecksum','UPDATE'))) AS safe
    FROM pg_roles WHERE rolname=current_user`)
  if (role.rows[0]?.safe !== true) receiptFailure("SUPERVISOR_CONSUMER_ROLE_UNAVAILABLE")
  const result = await client.query<InstalledStream>(
    `SELECT "confirmedSequence"::text,
    "originalHash","wrapperHash","headInputJson" FROM "ScanSupervisorJournalStream"
    WHERE id=$1 AND "authorityEpochId"=$2 AND "supervisorInstanceId"=$3
      AND "originalKeyHash"=$4 AND "wrapperKeyHash"=$5`,
    [
      authority.streamId,
      authority.authorityEpochId,
      authority.supervisorInstanceId,
      authority.originalKeyHash,
      authority.wrapperKeyHash,
    ]
  )
  if (!result.rows[0]) receiptFailure("SUPERVISOR_STREAM_NOT_INSTALLED")
  return result.rows[0]
}

async function receiptTransaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
  let committing = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE")
    await client.query("SET LOCAL statement_timeout='15s'")
    await client.query("SET LOCAL lock_timeout='3s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'")
    await client.query("SET LOCAL synchronous_commit='remote_apply'")
    const result = await work()
    committing = true
    await client.query("COMMIT")
    return result
  } catch (error) {
    if (committing) receiptFailure("SUPERVISOR_RECEIPT_COMMIT_UNKNOWN")
    try {
      await client.query("ROLLBACK")
    } catch {
      /* The caller discards a broken client. */
    }
    throw error
  }
}

async function acquireReceiptAuthorityGate(client: pg.PoolClient) {
  // Same exclusive DB fence as native invocation. Unconfirmed staging is inert;
  // a confirmed head or physical disposition cannot change during that action.
  const result = await client.query<{ held: boolean }>(
    "SELECT pg_try_advisory_xact_lock(1819234670,1) AS held"
  )
  if (result.rows[0]?.held !== true) receiptFailure("SUPERVISOR_AUTHORITY_BUSY")
}

async function stageRecords(
  client: pg.PoolClient,
  streamId: string,
  records: IngestedSupervisorRecord[]
) {
  await receiptTransaction(client, async () => {
    for (const record of records) {
      const originalJson = canonicalJson(record.payload.payload)
      const wrapperJson = canonicalJson(record)
      await client.query(
        `INSERT INTO "ScanSupervisorJournalRecord"(id,"streamId",sequence,
        "workspaceId","operationId","attemptId","originalHash","wrapperHash","originalInputJson","wrapperInputJson")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT("streamId",sequence) DO NOTHING`,
        [
          createId(),
          streamId,
          record.sequence,
          record.payload.workspaceId,
          record.payload.operationId,
          record.payload.attemptId,
          record.payload.payload.hash,
          record.hash,
          originalJson,
          wrapperJson,
        ]
      )
      const retained = await client.query<{ originalInputJson: string; wrapperInputJson: string }>(
        `SELECT "originalInputJson","wrapperInputJson" FROM "ScanSupervisorJournalRecord" WHERE "streamId"=$1 AND sequence=$2`,
        [streamId, record.sequence]
      )
      if (
        retained.rows[0]?.originalInputJson !== originalJson ||
        retained.rows[0]?.wrapperInputJson !== wrapperJson
      )
        receiptFailure("SUPERVISOR_RETAINED_RECORD_CONFLICT")
    }
  })
}

async function readPage(authority: SupervisorReceiptAuthority, cursor: SupervisorJournalCursor) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      authority.readJournal(cursor),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("supervisor journal read deadline exceeded")),
          5000
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function ingestSnapshot(client: pg.PoolClient, authority: SupervisorReceiptAuthority) {
  checkReceiptKeys(authority)
  const workerOperationId = scanDispatchWorkerRequestOperation()
  if (workerOperationId !== undefined)
    await receiptTransaction(client, async () => {
      await workerReceiptAuthority(client, authority, workerOperationId)
    })
  const lock = await client.query<{ held: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
    [`supervisor-receipts:${authority.streamId}`]
  )
  if (lock.rows[0]?.held !== true) receiptFailure("SUPERVISOR_CONSUMER_BUSY")
  let completed = false
  try {
    const stored = await installedStream(client, authority)
    let cursor: SupervisorJournalCursor = {
      epochId: authority.authorityEpochId,
      supervisorInstanceId: authority.supervisorInstanceId,
      afterSequence: Number(stored.confirmedSequence),
      afterHash: stored.originalHash,
      limit: 100,
    }
    let previousWrapperHash = stored.wrapperHash
    let snapshot: AuthorityHead | null | undefined
    for (;;) {
      const page = verifyReceiptPage(
        await readPage(authority, cursor),
        authority,
        cursor,
        previousWrapperHash,
        snapshot
      )
      snapshot = page.head
      await stageRecords(client, authority.streamId, page.records)
      cursor = page.nextCursor
      previousWrapperHash = page.wrapperHash
      if (!page.hasMore) break
    }
    // A complete first response is not enough: reread the fixed final head so
    // newly appended recovery holds invalidate staging before any projection.
    const final = verifyReceiptPage(
      await readPage(authority, cursor),
      authority,
      cursor,
      previousWrapperHash,
      snapshot
    )
    if (final.records.length || final.hasMore) receiptFailure("SUPERVISOR_SNAPSHOT_CHANGED")
    await receiptTransaction(client, async () => {
      await acquireReceiptAuthorityGate(client)
      if (workerOperationId !== undefined) {
        await workerReceiptAuthority(client, authority, workerOperationId)
      }
      const result = await client.query(
        `UPDATE "ScanSupervisorJournalStream" SET
        "confirmedSequence"=$2,"originalHash"=$3,"wrapperHash"=$4,"headInputJson"=$5,"updatedAt"=CURRENT_TIMESTAMP
        WHERE id=$1 AND "confirmedSequence"=$6 AND "originalHash"=$7 AND "wrapperHash"=$8`,
        [
          authority.streamId,
          cursor.afterSequence,
          cursor.afterHash,
          previousWrapperHash,
          snapshot ? canonicalJson(snapshot) : null,
          stored.confirmedSequence,
          stored.originalHash,
          stored.wrapperHash,
        ]
      )
      if (result.rowCount !== 1) receiptFailure("SUPERVISOR_CONFIRMED_HEAD_CONFLICT")
    })
    completed = true
    return {
      sequence: cursor.afterSequence,
      originalHash: cursor.afterHash,
      wrapperHash: previousWrapperHash,
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `supervisor-receipts:${authority.streamId}`,
      ])
    } catch (error) {
      // Never replace the original uncertain COMMIT disposition with a cleanup error.
      // Failed callers discard this connection, releasing its session lock.
      if (completed) throw error
    }
  }
}

/** Optional protected installation; the public broker supplies no caller key or reader. */
export function createSupervisorReceiptConsumer(
  installation: SupervisorReceiptAuthority,
  lockOperation: DispatchBrokerContext["lockOperation"],
  cleanupLockOperation: DispatchBrokerContext["lockOperation"]
) {
  const authority = Object.freeze({ ...installation })
  const pool = new pg.Pool({
    ...createPgConnectionConfig(authority.connectionString),
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    idleTimeoutMillis: 10000,
  })
  pool.on("error", () => undefined)
  pool.on("connect", (client) => client.on("error", () => undefined))
  return {
    async ingest() {
      const client = await pool.connect()
      let failed = true
      try {
        const result = await ingestSnapshot(client, authority)
        failed = false
        return result
      } catch (error) {
        if (error instanceof ScanDispatchAuthorityError) throw error

        // PostgreSQL detail and transport errors can contain private signed input.
        receiptFailure("SUPERVISOR_RECEIPT_REJECTED")
      } finally {
        client.release(failed)
      }
    },
    async consume(operationId: unknown) {
      const requestedOperation = scanDispatchWorkerRequestOperation()
      if (requestedOperation !== undefined && requestedOperation !== operationId)
        throw new ScanDispatchAuthorityError(
          "WORKER_GRANT_INVALID",
          "Worker authority is unavailable"
        )
      const client = await pool.connect()
      let failed = true
      try {
        const snapshot = await ingestSnapshot(client, authority)
        const result = await receiptTransaction(client, async () => {
          await acquireReceiptAuthorityGate(client)
          const workerOperationId = scanDispatchWorkerRequestOperation()
          let cleanup: SupervisorReceiptCleanupScope | undefined
          if (workerOperationId !== undefined) {
            cleanup = await workerReceiptAuthority(client, authority, workerOperationId)
          }
          return projectSupervisorSnapshot(
            client,
            authority,
            operationId,
            snapshot.sequence,
            cleanup ? cleanupLockOperation : lockOperation,
            cleanup
          )
        })
        failed = false
        return result
      } catch (error) {
        if (error instanceof ScanDispatchAuthorityError) throw error

        // PostgreSQL detail and transport errors can contain private signed input.
        receiptFailure("SUPERVISOR_RECEIPT_REJECTED")
      } finally {
        client.release(failed)
      }
    },
    async close() {
      await pool.end()
    },
  }
}
