import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), error: vi.fn() }))

vi.mock("@lyrashield/evidence-storage", () => ({
  assertEvidenceStorageConfigured: mocks.evidence,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: mocks.error } }))

import { GET } from "./route"

describe("GET /api/ready/evidence", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports local evidence configuration without storage or Redis I/O", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { evidence: true },
    })
  })

  it("fails closed without exposing configuration errors", async () => {
    mocks.evidence.mockImplementationOnce(() => {
      throw new Error("secret material and private storage URI")
    })

    const response = await GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: "not_ready",
      checks: { evidence: false },
    })
    expect(mocks.error).toHaveBeenCalledWith("Evidence storage readiness check failed", {
      evidence: false,
    })
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("secret material")
  })
})
