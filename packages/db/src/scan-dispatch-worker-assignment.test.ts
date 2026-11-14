import { createHash, randomBytes } from "node:crypto"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import {
  requireScanDispatchWorkerAssignment,
  requireScanDispatchWorkerStage,
  requireScanDispatchWorkerCleanup,
  scanDispatchWorkerRequestOperation,
  withScanDispatchWorkerCredential,
} from "./scan-dispatch-worker-assignment"

const credential = randomBytes(32).toString("hex")
const scope = {
  operationId: "operation-1",
  workerGrantId: "grant-1",
  workerInstanceId: "worker-1",
  authorityEpochId: "epoch-1",
}
function connection(row = { ...scope, attemptId: "attempt-1" }, held = true) {
  const query = vi.fn(async (sql: string) =>
    sql.includes("pg_try_advisory_xact_lock")
      ? { rowCount: 1, rows: [{ held }] }
      : { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
  )
  return { client: { query } as unknown as PoolClient, query }
}

describe("assigned worker request authority", () => {
  it("uses a separate retained verifier solely for cleanup and keeps exact original scope", async () => {
    const { client, query } = connection()
    await withScanDispatchWorkerCredential(credential, { ...scope, attemptId: "attempt-1" }, () =>
      requireScanDispatchWorkerCleanup(client, scope.operationId)
    )
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM app.require_scan_dispatch_worker_cleanup($1,$2)",
      [scope.operationId, createHash("sha256").update(credential).digest("hex")]
    )
    await expect(
      withScanDispatchWorkerCredential(credential, { ...scope, attemptId: "foreign-attempt" }, () =>
        requireScanDispatchWorkerCleanup(client, scope.operationId)
      )
    ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
  })
  it("verifies only the credential digest and exact assigned scope inside the action gate", async () => {
    const { client, query } = connection()
    await withScanDispatchWorkerCredential(credential, scope, () =>
      requireScanDispatchWorkerAssignment(client, scope.operationId)
    )
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_xact_lock(1819234670,1) AS held"
    )
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT * FROM app.require_scan_dispatch_worker($1,$2)",
      [scope.operationId, createHash("sha256").update(credential).digest("hex")]
    )
    expect(JSON.stringify(query.mock.calls)).not.toContain(credential)
    expect(scanDispatchWorkerRequestOperation()).toBeUndefined()
  })

  it("rejects another operation, worker, epoch or attempt without accepting a partial match", async () => {
    for (const changed of [
      { workerGrantId: "grant-other" },
      { workerInstanceId: "worker-other" },
      { authorityEpochId: "epoch-other" },
      { attemptId: "attempt-other" },
    ]) {
      const { client } = connection()
      await expect(
        withScanDispatchWorkerCredential(credential, { ...scope, ...changed }, () =>
          requireScanDispatchWorkerAssignment(client, scope.operationId)
        )
      ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
    }
    const { client, query } = connection()
    await expect(
      withScanDispatchWorkerCredential(credential, scope, () =>
        requireScanDispatchWorkerAssignment(client, "operation-other")
      )
    ).rejects.toMatchObject({ code: "WORKER_GRANT_INVALID" })
    expect(query).not.toHaveBeenCalled()
  })

  it("refuses a busy source gate before reading credential authority", async () => {
    const { client, query } = connection(undefined, false)
    await expect(
      withScanDispatchWorkerCredential(credential, scope, () =>
        requireScanDispatchWorkerAssignment(client, scope.operationId)
      )
    ).rejects.toMatchObject({ code: "PREPARATION_AUTHORITY_BUSY" })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("checks ledger staging under the shared gate without upgrading into native authority", async () => {
    const { client, query } = connection()
    await withScanDispatchWorkerCredential(credential, scope, () =>
      requireScanDispatchWorkerStage(client, scope.operationId)
    )
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_xact_lock_shared(1819234670,1) AS held"
    )
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT * FROM app.require_scan_dispatch_worker_stage($1,$2)",
      [scope.operationId, createHash("sha256").update(credential).digest("hex")]
    )
  })

  it("keeps concurrent request identities isolated and leaves control-only calls unchanged", async () => {
    const { client, query } = connection()
    await requireScanDispatchWorkerAssignment(client, scope.operationId)
    expect(query).not.toHaveBeenCalled()
    const operations = [scope.operationId, "operation-2"]
    expect(
      await Promise.all(
        operations.map((operationId) =>
          withScanDispatchWorkerCredential(credential, { operationId }, async () => {
            await Promise.resolve()
            return scanDispatchWorkerRequestOperation()
          })
        )
      )
    ).toEqual(operations)
    expect(scanDispatchWorkerRequestOperation()).toBeUndefined()
  })

  it("rejects malformed credentials before opening request authority", () => {
    for (const value of ["short", `${credential}\n`, "a".repeat(1025)])
      expect(() => withScanDispatchWorkerCredential(value, scope, async () => undefined)).toThrow()
  })
})
