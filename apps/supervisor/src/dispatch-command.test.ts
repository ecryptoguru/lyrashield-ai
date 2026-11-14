import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { createInstalledDispatchCommandReader } from "./dispatch-command"

vi.mock("@lyrashield/db/src/scan-execution-action-intent", () => ({
  bindScanExecutionAuthorityContext: vi.fn(async () => undefined),
}))
vi.mock("@lyrashield/db/src/scan-dispatch-worker-assignment", () => ({
  requireScanDispatchWorkerAssignment: vi.fn(async () => undefined),
  requireScanDispatchWorkerCleanup: vi.fn(async () => undefined),
}))

const command = {
  type: "STOP",
  commandId: "command-test",
  attemptId: "attempt-test",
  expectedReceiptHash: "a".repeat(64),
}
function fixture(overrides: Record<string, unknown> = {}, held = true) {
  const bytes = canonicalJson(command)
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory")) return { rows: [{ held }] }
    if (sql.includes('FROM "ScanDispatchOutbox"'))
      return {
        rows: [
          {
            commandInputJson: bytes,
            commandInputChecksum: sha256Hex(bytes),
            commandType: command.type,
            attemptId: command.attemptId,
            scanId: "scan-test",
            workspaceId: "workspace-test",
            authorityEpochId: "epoch-test",
            ...overrides,
          },
        ],
      }
    return { rows: [] }
  })
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query, release }))
  return {
    read: createInstalledDispatchCommandReader(
      { connect } as unknown as Pick<pg.Pool, "connect">,
      "epoch-test"
    ),
    query,
    release,
    connect,
  }
}
describe("installed immutable command selector", () => {
  it("selects only exact persisted canonical bytes in a restricted READ ONLY transaction", async () => {
    const f = fixture()
    await expect(
      f.read({ operationId: "operation-test", commandId: command.commandId })
    ).resolves.toEqual(command)
    expect(f.query).toHaveBeenCalledWith("BEGIN READ ONLY")
    expect(f.query).toHaveBeenCalledWith("SELECT app.require_scan_execution_action_role()")
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FROM "ScanDispatchOutbox"'), [
      command.commandId,
      "operation-test",
      "epoch-test",
    ])
    expect(f.query).toHaveBeenCalledWith("COMMIT")
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false)
  })
  it.each([
    { commandInputChecksum: "b".repeat(64) },
    { attemptId: "foreign-attempt" },
    { commandType: "START_PAID" },
  ])("rejects changed immutable binding %j", async (changed) => {
    const f = fixture(changed)
    await expect(
      f.read({ operationId: "operation-test", commandId: command.commandId })
    ).rejects.toThrow()
    expect(f.query).toHaveBeenCalledWith("ROLLBACK")
    expect(f.release).toHaveBeenCalledOnce()
  })
  it("rejects a caller command body before connecting and never reads through an unavailable gate", async () => {
    const f = fixture({}, false)
    await expect(
      f.read({ operationId: "operation-test", commandId: command.commandId, command })
    ).rejects.toThrow()
    expect(f.connect).not.toHaveBeenCalled()
    await expect(
      f.read({ operationId: "operation-test", commandId: command.commandId })
    ).rejects.toThrow("busy")
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM "ScanDispatchOutbox"'))).toBe(
      false
    )
  })
})
