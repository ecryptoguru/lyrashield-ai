import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { z } from "zod"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
const scopeSchema = z
  .object({
    operationId: identity,
    workerInstanceId: identity.optional(),
    workerGrantId: identity.optional(),
    authorityEpochId: identity.optional(),
    attemptId: identity.optional(),
  })
  .strict()
type Scope = z.infer<typeof scopeSchema>
const credentialContext = new AsyncLocalStorage<
  Scope & { credentialHash: string; credential: string }
>()

function denied(): never {
  throw new ScanDispatchAuthorityError("WORKER_GRANT_INVALID", "Worker authority is unavailable")
}

/** Request identity is checked against persisted assignment before the action commits. */
export function withScanDispatchWorkerCredential<T>(
  credential: string,
  scope: Scope,
  action: () => Promise<T>
): Promise<T> {
  if (
    credential.length < 32 ||
    credential.length > 1024 ||
    credential.trim() !== credential ||
    /[\r\n]/.test(credential)
  )
    denied()
  const parsed = scopeSchema.parse(scope)
  return credentialContext.run(
    {
      ...parsed,
      credential,
      credentialHash: createHash("sha256").update(credential).digest("hex"),
    },
    action
  )
}

export function scanDispatchWorkerRequestOperation(): string | undefined {
  return credentialContext.getStore()?.operationId
}

/** Forward only the current operation's credential to the protected native receipt service. */
export function scanDispatchWorkerReceiptCredential(operationId: string): string | undefined {
  const context = credentialContext.getStore()
  if (!context) return undefined
  if (context.operationId !== operationId) denied()
  return context.credential
}

/** Run on the action's connection, after its source locks and before COMMIT. */
export async function requireScanDispatchWorkerAssignment(client: PoolClient, operationId: string) {
  return requireAssignment(client, operationId, "execution")
}

/** Ledger staging holds a shared source gate; native freeze rechecks exclusively. */
export async function requireScanDispatchWorkerStage(client: PoolClient, operationId: string) {
  return requireAssignment(client, operationId, "stage")
}

/** Retained checked assignment is usable only by STOP/RECONCILE transactions. */
export async function requireScanDispatchWorkerCleanup(client: PoolClient, operationId: string) {
  return requireAssignment(client, operationId, "cleanup")
}

async function requireAssignment(
  client: PoolClient,
  operationId: string,
  phase: "stage" | "execution" | "cleanup"
) {
  const context = credentialContext.getStore()
  if (!context) return
  if (context.operationId !== operationId) denied()
  const gate = await client.query<{ held: boolean }>(
    phase === "stage"
      ? "SELECT pg_try_advisory_xact_lock_shared(1819234670,1) AS held"
      : "SELECT pg_try_advisory_xact_lock(1819234670,1) AS held"
  )
  if (gate.rows[0]?.held !== true)
    throw new ScanDispatchAuthorityError("PREPARATION_AUTHORITY_BUSY", "Worker authority is busy")
  const result = await client.query<{
    workerGrantId: string
    workerInstanceId: string
    authorityEpochId: string
    attemptId: string | null
  }>(
    phase === "stage"
      ? "SELECT * FROM app.require_scan_dispatch_worker_stage($1,$2)"
      : phase === "cleanup"
        ? "SELECT * FROM app.require_scan_dispatch_worker_cleanup($1,$2)"
        : "SELECT * FROM app.require_scan_dispatch_worker($1,$2)",
    [operationId, context.credentialHash]
  )
  const assigned = result.rows[0]
  if (
    result.rowCount !== 1 ||
    !assigned ||
    (context.workerGrantId !== undefined && context.workerGrantId !== assigned.workerGrantId) ||
    (context.workerInstanceId !== undefined &&
      context.workerInstanceId !== assigned.workerInstanceId) ||
    (context.authorityEpochId !== undefined &&
      context.authorityEpochId !== assigned.authorityEpochId) ||
    (context.attemptId !== undefined && context.attemptId !== assigned.attemptId)
  )
    denied()
}
