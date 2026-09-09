import { describe, expect, it } from "vitest"
import { toOperationStatusView, type AgentOperation } from "@lyrashield/db"

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    workspaceId: "ws-1",
    connectionId: "conn-1",
    operationName: "scan.create",
    idempotencyKey: "key-1",
    inputHash: "hash",
    principalType: "OAUTH_CONNECTION",
    principalId: "conn-1",
    authorizationVersion: 1,
    status: "EXECUTING",
    resultReference: null,
    result: null,
    error: null,
    createdAt: new Date("2026-09-09T00:00:00Z"),
    updatedAt: new Date("2026-09-09T00:01:00Z"),
    ...overrides,
  } as unknown as AgentOperation
}

describe("operation status contract (W3-08)", () => {
  it("maps each state to its one permissible recovery", () => {
    expect(toOperationStatusView(operation({ status: "EXECUTING" })).recovery).toBe("poll")
    expect(toOperationStatusView(operation({ status: "PENDING" })).recovery).toBe("poll")

    const completed = toOperationStatusView(
      operation({ status: "COMPLETED", resultReference: "scan-9" })
    )
    expect(completed.recovery).toBe("none")
    expect(completed.resultLocation).toBe("scan-9")

    const failed = toOperationStatusView(
      operation({ status: "FAILED", error: "raw provider body" })
    )
    expect(failed.recovery).toBe("retry_new_key")
    // The raw error text never leaves the service; only the safe reason code.
    expect(failed.reasonCode).toBe("OPERATION_FAILED")
    expect(JSON.stringify(failed)).not.toContain("raw provider")
  })

  it("keeps the stable operation identity across reconnect retries", () => {
    const view = toOperationStatusView(operation({ id: "op-stable" }))
    expect(view.operationId).toBe("op-stable")
  })
})
