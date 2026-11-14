import { randomUUID } from "node:crypto"
import type pg from "pg"
import { z } from "zod"
import { verifyStoredScanExecutionPlan } from "./scan-execution-plan"
import {
  ScanQueueOutboxError,
  verifyScanQueuePayload,
  type ScanQueueIdentity,
} from "./scan-queue-payload"
import { verifyScanQueuePublicationProof } from "./scan-queue-publication-proof"
import {
  createScanQueuePublicationProof,
  type ScanQueueJobSnapshot,
} from "./scan-queue-publication-proof"

export const queueOutboxScopeSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
  })
  .strict()
export type QueueOutboxScope = z.infer<typeof queueOutboxScopeSchema>
export type QueueOutboxRow = ScanQueueIdentity & {
  outboxId: string
  operationId: string
  jobId: string
  payloadDigest: string
  payloadInputJson: string | null
  publicationReceiptInputJson: string | null
  publicationReceiptChecksum: string | null
  state: "PENDING" | "LEASED" | "PUBLISHED" | "UNKNOWN"
  operationState: string
  requestDigest: string
  currentScopeDigest: string | null
  executionPlan: unknown
  executionPlanHash: string | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  leaseLive: boolean
  live: boolean
}

export type QueueOutboxStoreResult =
  | { kind: "leased"; row: QueueOutboxRow; token: string }
  | { kind: "recoverable"; row: QueueOutboxRow }
  | { kind: "published"; row: QueueOutboxRow }
  | { kind: "busy" | "closed" | "missing" }
  | { kind: "unknown"; reasonCode: string }

/** Same user/workspace/target/account/scan/operation/outbox lock order as broker. */
async function lockQueueOutbox(client: pg.PoolClient, scope: QueueOutboxScope, readOnly = false) {
  await client.query("SELECT set_config('app.current_workspace_id',$1,true)", [scope.workspaceId])
  const pre = (
    await client.query<{
      scanId: string
      userId: string
      sponsorId: string
      targetId: string
    }>(
      `SELECT o."scanId", s."createdById" AS "userId", s."targetId",
       coalesce(s."sponsorAccountId",s."createdById") AS "sponsorId"
       FROM "ScanDispatchOperation" o JOIN "Scan" s ON s.id=o."scanId"
       WHERE o."operationId"=$1 AND o."workspaceId"=$2 AND s."workspaceId"=$2`,
      [scope.operationId, scope.workspaceId]
    )
  ).rows[0]
  if (!pre) return null
  await client.query(
    "SELECT set_config('app.current_scan_user_id',$1,true), set_config('app.current_account_id',$2,true)",
    [pre.userId, pre.sponsorId]
  )
  if (!readOnly) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `scan-user:${pre.userId}`,
    ])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope.workspaceId])
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pre.targetId])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `account:${pre.sponsorId}`,
    ])
    await client.query('SELECT id FROM "Scan" WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE', [
      pre.scanId,
      scope.workspaceId,
    ])
    await client.query(
      'SELECT "operationId" FROM "ScanDispatchOperation" WHERE "operationId"=$1 AND "workspaceId"=$2 FOR UPDATE',
      [scope.operationId, scope.workspaceId]
    )
  }
  const row = (
    await client.query<QueueOutboxRow>(
      `SELECT s.id, s."workspaceId", s."targetId", s.goal, s.mode, s."policyId",
      q.id AS "outboxId", q."operationId", q."jobId", q."payloadDigest", q."payloadInputJson",
      q."publicationReceiptInputJson", q."publicationReceiptChecksum", q.state,
      q."leaseOwner", q."leaseExpiresAt", coalesce(q."leaseExpiresAt" > clock_timestamp(),false) AS "leaseLive",
      o.state AS "operationState", o."requestDigest",
      s."executionPlan", s."executionPlanHash", app.scan_dispatch_scope_digest(s.id) AS "currentScopeDigest",
      (s."deletedAt" IS NULL AND w."deletedAt" IS NULL AND t."deletedAt" IS NULL
       AND s.status IN ('QUEUED','PREFLIGHT') AND s."accountingVersion"=2
       AND EXISTS (SELECT 1 FROM "UserScanSlot" slot WHERE slot."scanId"=s.id AND slot."userId"=s."createdById")
       AND EXISTS (SELECT 1 FROM "ScanCapacityReservation" r WHERE r."scanId"=s.id
         AND r."accountId"=coalesce(s."sponsorAccountId",s."createdById") AND r.state IN ('WAITING','RESERVED'))
       AND NOT EXISTS (SELECT 1 FROM "ScanEvent" e WHERE e."scanId"=s.id AND e.stage='billable_boundary')) AS live
      FROM "ScanQueueOutbox" q JOIN "ScanDispatchOperation" o ON o."operationId"=q."operationId"
      JOIN "Scan" s ON s.id=q."scanId" AND s.id=o."scanId" AND s."workspaceId"=o."workspaceId"
      JOIN "Workspace" w ON w.id=s."workspaceId" JOIN "Target" t ON t.id=s."targetId" AND t."workspaceId"=s."workspaceId"
      WHERE q."operationId"=$1 AND s."workspaceId"=$2 ${readOnly ? "" : "FOR UPDATE OF q"}`,
      [scope.operationId, scope.workspaceId]
    )
  ).rows[0]
  return row ?? null
}

/** Same persisted publication facts, without row mutations or publisher capability. */
export async function readPublishedScanQueueAuthority(
  client: pg.PoolClient,
  scope: QueueOutboxScope
) {
  const row = await lockQueueOutbox(client, queueOutboxScopeSchema.parse(scope), true)
  if (!row || !["QUEUED", "WAITING_CAPACITY", "PREPARED"].includes(row.operationState)) return null
  verifyPublishedQueueOutbox(row)
  return row
}

export function verifyQueueOutboxAuthority(row: QueueOutboxRow, requireLive = true) {
  if (
    (requireLive && !row.live) ||
    row.requestDigest !== row.currentScopeDigest ||
    row.jobId !== row.id
  )
    throw new ScanQueueOutboxError("QUEUE_ADMISSION_SCOPE_CHANGED")
  if (!verifyStoredScanExecutionPlan(row.executionPlan, row.executionPlanHash).ok)
    throw new ScanQueueOutboxError("QUEUE_ADMITTED_PLAN_INVALID")
  return verifyScanQueuePayload(row.payloadInputJson, row.payloadDigest, row)
}

export function verifyPublishedQueueOutbox(row: QueueOutboxRow, requireLive = true) {
  if (row.state !== "PUBLISHED") throw new ScanQueueOutboxError("QUEUE_PUBLICATION_NOT_CONFIRMED")
  const payload = verifyQueueOutboxAuthority(row, requireLive)
  verifyScanQueuePublicationProof(
    row,
    row.publicationReceiptInputJson,
    row.publicationReceiptChecksum
  )
  return payload
}

/** Consumer/broker fence: a queued transport item is insufficient authority. */
export async function requirePublishedScanQueueAuthority(
  client: pg.PoolClient,
  scope: QueueOutboxScope,
  replay = false
) {
  const row = await lockQueueOutbox(client, scope)
  if (
    !row ||
    row.operationState === "UNKNOWN" ||
    (!replay && !["QUEUED", "WAITING_CAPACITY"].includes(row.operationState))
  )
    throw new ScanQueueOutboxError("QUEUE_DISPATCH_OPERATION_CLOSED")
  return { row, payload: verifyPublishedQueueOutbox(row, !replay) }
}

function assertStoreBounds(pool: pg.Pool, leaseMs: number) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000)
    throw new ScanQueueOutboxError("QUEUE_LEASE_BOUND_INVALID")
  if (
    !pool.options.connectionTimeoutMillis ||
    pool.options.connectionTimeoutMillis > 5000 ||
    !pool.options.query_timeout ||
    pool.options.query_timeout > 5000
  )
    throw new ScanQueueOutboxError("QUEUE_DATABASE_BOUNDS_REQUIRED")
}

export function createScanQueueOutboxStore(pool: pg.Pool, leaseMs: number) {
  assertStoreBounds(pool, leaseMs)

  async function transaction(
    scope: QueueOutboxScope,
    work: (client: pg.PoolClient, row: QueueOutboxRow | null) => Promise<QueueOutboxStoreResult>
  ) {
    let client: pg.PoolClient | undefined
    let commitAttempted = false
    try {
      client = await pool.connect()
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE")
      await client.query(
        "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='10s'; SET LOCAL synchronous_commit='remote_apply'"
      )
      await client.query(
        "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id','',true),set_config('app.current_scan_user_id','',true)",
        [scope.workspaceId]
      )
      const result = await work(client, await lockQueueOutbox(client, scope))
      commitAttempted = true
      await client.query("COMMIT")
      return result
    } catch {
      if (client && !commitAttempted) await client.query("ROLLBACK").catch(() => undefined)
      return {
        kind: "unknown",
        reasonCode: commitAttempted ? "QUEUE_DB_COMMIT_UNKNOWN" : "QUEUE_DB_UNAVAILABLE",
      } as const
    } finally {
      client?.release(true)
    }
  }

  async function quarantine(client: pg.PoolClient, row: QueueOutboxRow, reasonCode: string) {
    if (row.state === "PENDING" || row.state === "LEASED")
      await client.query(
        'UPDATE "ScanQueueOutbox" SET state=\'UNKNOWN\', "lastErrorCode"=$2, "updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',
        [row.outboxId, reasonCode]
      )
    return { kind: "unknown", reasonCode } as const
  }

  return {
    fence(scope: QueueOutboxScope, snapshot: ScanQueueJobSnapshot) {
      return transaction(scope, async (_client, row) => {
        if (!row || !["QUEUED", "WAITING_CAPACITY"].includes(row.operationState))
          return { kind: "closed" }
        try {
          verifyPublishedQueueOutbox(row)
          createScanQueuePublicationProof(row, row.payloadInputJson!, snapshot)
          return { kind: "published", row }
        } catch {
          return { kind: "unknown", reasonCode: "QUEUE_DISPATCH_FENCE_REJECTED" }
        }
      })
    },
    claim(scope: QueueOutboxScope) {
      return transaction(scope, async (client, row) => {
        if (!row) return { kind: "missing" }
        if (!["QUEUED", "WAITING_CAPACITY"].includes(row.operationState)) return { kind: "closed" }
        try {
          verifyQueueOutboxAuthority(row)
        } catch {
          return quarantine(client, row, "QUEUE_ADMISSION_SCOPE_CHANGED")
        }
        if (row.state === "PUBLISHED") {
          try {
            verifyPublishedQueueOutbox(row)
          } catch {
            return { kind: "unknown", reasonCode: "QUEUE_PUBLICATION_PROOF_INVALID" }
          }
          return { kind: "published", row }
        }
        if (row.state === "UNKNOWN") return { kind: "recoverable", row }
        if (row.state === "LEASED") {
          if (!row.leaseLive) return quarantine(client, row, "QUEUE_LEASE_EXPIRED_UNKNOWN")
          return { kind: "busy" }
        }
        await client.query("SELECT app.assign_scan_dispatch_worker($1)", [scope.operationId])
        const token = randomUUID()
        await client.query(
          `UPDATE "ScanQueueOutbox" SET state='LEASED', "attempts"="attempts"+1,
          "leaseOwner"=$2,"leaseExpiresAt"=clock_timestamp()+$3*interval '1 millisecond',
          "lastErrorCode"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 AND state='PENDING'`,
          [row.outboxId, token, leaseMs]
        )
        return { kind: "leased", row, token }
      })
    },
    unknown(scope: QueueOutboxScope, token: string, reasonCode: string) {
      return transaction(scope, async (client, row) => {
        if (!row) return { kind: "missing" }
        if (row.state === "PUBLISHED") {
          try {
            verifyPublishedQueueOutbox(row)
            return { kind: "published", row }
          } catch {
            return { kind: "unknown", reasonCode: "QUEUE_PUBLICATION_PROOF_INVALID" }
          }
        }
        if (row.state !== "LEASED" || row.leaseOwner !== token)
          return { kind: "unknown", reasonCode: "QUEUE_LEASE_OWNERSHIP_UNKNOWN" }
        return quarantine(client, row, reasonCode)
      })
    },
    confirm(
      scope: QueueOutboxScope,
      identity: QueueOutboxRow,
      token: string | null,
      proof: { input: string; checksum: string }
    ) {
      return transaction(scope, async (client, row) => {
        if (!row) return { kind: "missing" }
        if (!["QUEUED", "WAITING_CAPACITY"].includes(row.operationState)) return { kind: "closed" }
        try {
          verifyQueueOutboxAuthority(row)
          verifyScanQueuePublicationProof(row, proof.input, proof.checksum)
          if (
            row.outboxId !== identity.outboxId ||
            row.payloadDigest !== identity.payloadDigest ||
            row.payloadInputJson !== identity.payloadInputJson
          )
            throw new ScanQueueOutboxError("QUEUE_PUBLICATION_IDENTITY_CHANGED")
          if (row.state === "PUBLISHED") {
            verifyPublishedQueueOutbox(row)
            return { kind: "published", row }
          }
          if (
            row.state !== "UNKNOWN" &&
            (row.state !== "LEASED" || row.leaseOwner !== token || !row.leaseLive)
          )
            return quarantine(client, row, "QUEUE_LEASE_OWNERSHIP_UNKNOWN")
        } catch {
          return quarantine(client, row, "QUEUE_PUBLICATION_IDENTITY_CHANGED")
        }
        await client.query(
          `UPDATE "ScanQueueOutbox" SET state='PUBLISHED',"publishedAt"=CURRENT_TIMESTAMP,
          "publicationReceiptInputJson"=$2,"publicationReceiptChecksum"=$3,"lastErrorCode"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
          [row.outboxId, proof.input, proof.checksum]
        )
        return {
          kind: "published",
          row: {
            ...row,
            state: "PUBLISHED",
            publicationReceiptInputJson: proof.input,
            publicationReceiptChecksum: proof.checksum,
          },
        }
      })
    },
  }
}
