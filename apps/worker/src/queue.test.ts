import { describe, it, expect } from "vitest"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"

describe("Queue Configuration", () => {
  it("uses the correct queue name", () => {
    expect(SCAN_QUEUE_NAME).toBe("scans")
  })
})

describe("ScanJobData type", () => {
  it("has required fields", () => {
    const data: ScanJobData = {
      scanId: "scan-123",
      workspaceId: "ws-123",
      targetId: "target-123",
      goal: "TEST_APP",
      mode: "SAFE",
    }
    expect(data.scanId).toBe("scan-123")
    expect(data.workspaceId).toBe("ws-123")
    expect(data.targetId).toBe("target-123")
    expect(data.goal).toBe("TEST_APP")
    expect(data.mode).toBe("SAFE")
    expect(data.policyId).toBeUndefined()
  })

  it("supports optional policyId", () => {
    const data: ScanJobData = {
      scanId: "scan-456",
      workspaceId: "ws-123",
      targetId: "target-123",
      goal: "FULL_PENTEST",
      mode: "DEEP",
      policyId: "policy-123",
    }
    expect(data.policyId).toBe("policy-123")
  })
})

describe("ScanJobResult type", () => {
  it("supports completed result", () => {
    const result: ScanJobResult = {
      status: "completed",
      summary: "Scan completed successfully",
    }
    expect(result.status).toBe("completed")
    expect(result.summary).toBe("Scan completed successfully")
  })

  it("supports failed result", () => {
    const result: ScanJobResult = {
      status: "failed",
      errorCategory: "PREFLIGHT",
      errorMessage: "Target not found",
    }
    expect(result.status).toBe("failed")
    expect(result.errorCategory).toBe("PREFLIGHT")
    expect(result.errorMessage).toBe("Target not found")
  })
})
