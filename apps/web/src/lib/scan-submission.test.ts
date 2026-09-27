import { describe, expect, it, vi } from "vitest"
import {
  beginScanSubmission,
  clearPendingScanSubmission,
  readPendingScanSubmission,
  recordAcceptedScan,
  recordScanOperation,
  runScanSubmission,
  type ScanSubmissionScope,
  type ScanSubmissionStorage,
} from "./scan-submission"

class MemoryStorage implements ScanSubmissionStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

const scope: ScanSubmissionScope = {
  principalId: "user-1",
  workspaceId: "workspace-1",
  surface: "dashboard",
}
const payload = { workspaceId: "workspace-1", targetId: "target-1", goal: "TEST_APP" }
const firstKey = "11111111-1111-4111-8111-111111111111"
const secondKey = "22222222-2222-4222-8222-222222222222"

describe("recoverable scan submissions", () => {
  it("keeps the same key after an accepted response is lost and the page reloads", () => {
    const storage = new MemoryStorage()
    const started = beginScanSubmission(scope, payload, storage, () => firstKey)

    // The server accepted the request, but the client received a timeout.
    const afterReload = readPendingScanSubmission(scope, storage)
    const retried = beginScanSubmission(scope, payload, storage, () => secondKey)

    expect(started.kind).toBe("created")
    expect(afterReload?.idempotencyKey).toBe(firstKey)
    expect(retried).toMatchObject({ kind: "existing", submission: { idempotencyKey: firstKey } })
  })

  it("starts a new attempt after the accepted scan is retained in the UI", () => {
    const storage = new MemoryStorage()
    const started = beginScanSubmission(scope, payload, storage, () => firstKey)
    expect(started.kind).toBe("created")
    recordScanOperation(scope, firstKey, "operation-1", storage)
    const accepted = recordAcceptedScan(scope, firstKey, "scan-1", "operation-1", storage)
    const retried = beginScanSubmission(scope, payload, storage, () => secondKey)

    expect(accepted).toMatchObject({
      state: "accepted",
      scanId: "scan-1",
      operationId: "operation-1",
    })
    expect(retried).toMatchObject({
      kind: "created",
      submission: { idempotencyKey: secondKey, state: "pending" },
    })
  })

  it("allows a different target after an accepted scan", () => {
    const storage = new MemoryStorage()
    beginScanSubmission(scope, payload, storage, () => firstKey)
    recordAcceptedScan(scope, firstKey, "scan-1", undefined, storage)

    expect(
      beginScanSubmission(scope, { ...payload, targetId: "target-2" }, storage, () => secondKey)
    ).toMatchObject({
      kind: "created",
      submission: { idempotencyKey: secondKey, state: "pending" },
    })
  })

  it("does not reuse a key for changed input until the old submission is explicitly cleared", () => {
    const storage = new MemoryStorage()
    beginScanSubmission(scope, payload, storage, () => firstKey)

    const changed = beginScanSubmission(
      scope,
      { ...payload, goal: "AUDIT" },
      storage,
      () => secondKey
    )
    expect(changed).toMatchObject({ kind: "conflict", submission: { idempotencyKey: firstKey } })

    expect(clearPendingScanSubmission(scope, firstKey, storage)).toBe(true)
    expect(
      beginScanSubmission(scope, { ...payload, goal: "AUDIT" }, storage, () => secondKey)
    ).toMatchObject({
      kind: "created",
      submission: { idempotencyKey: secondKey },
    })
  })

  it("keeps principals and workspaces in separate recovery scopes", () => {
    const storage = new MemoryStorage()
    beginScanSubmission(scope, payload, storage, () => firstKey)
    const otherPrincipal = { ...scope, principalId: "user-2" }
    const otherWorkspace = { ...scope, workspaceId: "workspace-2" }

    expect(beginScanSubmission(otherPrincipal, payload, storage, () => secondKey)).toMatchObject({
      kind: "created",
      submission: { idempotencyKey: secondKey },
    })
    expect(readPendingScanSubmission(scope, storage)?.idempotencyKey).toBe(firstKey)
    expect(readPendingScanSubmission(otherWorkspace, storage)).toBeNull()
  })

  it("guards double-clicks while a request is in flight", async () => {
    const lock = { current: false }
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = vi.fn(async () => blocked)

    const first = runScanSubmission(lock, submit)
    const second = await runScanSubmission(lock, submit)
    expect(submit).toHaveBeenCalledOnce()
    expect(second).toBeUndefined()

    release()
    await first
    expect(lock.current).toBe(false)
  })

  it("does not discard unreadable recovery state", () => {
    const storage = new MemoryStorage()
    storage.setItem("lyrashield:scan-submission:v1:user-1:workspace-1:dashboard", "not-json")

    expect(() => readPendingScanSubmission(scope, storage)).toThrow(/unreadable/)
  })
})
