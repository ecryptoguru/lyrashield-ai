import { describe, expect, it } from "vitest"
import { authorityActionSchema } from "@lyrashield/runtime-control"

const action = {
  phase: "SANDBOX_TOOL",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityEpochId: "epoch-1",
  authorityRevision: 1,
  authorityChecksum: "a".repeat(64),
  actionChecksum: "b".repeat(64),
  commandId: "original-prepare-1",
  requestId: "tool-request-1",
  executorKey: "sandbox",
}

describe("sandbox tool action binding", () => {
  it("binds the original prepare command and the specific sandbox request", () => {
    expect(authorityActionSchema.parse(action)).toEqual(action)
  })

  it.each([
    { commandId: undefined },
    { requestId: undefined },
    { executorKey: undefined },
    { executorKey: "engine" },
    { actionChecksum: "invalid" },
    { requestId: "../outside" },
    { sandboxHandle: "caller-selected" },
  ])("rejects an incomplete or foreign binding: %o", (change) => {
    expect(authorityActionSchema.safeParse({ ...action, ...change }).success).toBe(false)
  })

  it("does not accept a tool request as a different action phase", () => {
    for (const phase of ["PREPARE", "EXECUTOR_CREATE", "EXECUTOR_START", "PROVIDER_DISPATCH"]) {
      expect(authorityActionSchema.safeParse({ ...action, phase }).success).toBe(false)
    }
  })
})
