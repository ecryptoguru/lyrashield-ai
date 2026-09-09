import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@lyrashield/db", () => ({
  claimOrGetAgentOperation: vi.fn(),
  completeAgentOperation: vi.fn(),
  failAgentOperation: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
} from "@lyrashield/db"
import { recordedOperation } from "./recorded-operation"
import { apiSuccess, apiError } from "./api-response"

const params = {
  workspaceId: "ws",
  operationName: "report.create",
  input: { title: "A report" },
  session: { userId: "user", oauth: { connectionId: "conn", authorizationVersion: 3 } },
} as unknown as Parameters<typeof recordedOperation>[1]
const request = () =>
  new Request("https://example.invalid", { headers: { "Idempotency-Key": "retry-key" } })

describe("durable REST operation execution", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(failAgentOperation).mockResolvedValue({} as never)
  })
  for (const status of ["FAILED", "IN_PROGRESS", "REPLAY"]) {
    it(`never executes ${status} without a stored result`, async () => {
      vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
        status,
        operation: { id: "op" },
      } as never)
      const execute = vi.fn()
      expect((await recordedOperation(request(), params, execute)).status).toBe(409)
      expect(execute).not.toHaveBeenCalled()
    })
  }
  it("binds OAuth identity and returns the same result on replay", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op" },
    } as never)
    const execute = vi.fn(async () => apiSuccess({ id: "report" }, 201))
    const created = await recordedOperation(request(), params, execute)
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn", userId: undefined, authorizationVersion: 3 })
    )
    expect(completeAgentOperation).toHaveBeenCalledWith("op", "ws", {
      resultReference: "report",
      result: { id: "report" },
    })
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "REPLAY",
      operation: { id: "op", result: { id: "report" } },
    } as never)
    const replay = await recordedOperation(request(), params, execute)
    expect(await replay.json()).toEqual(await created.json())
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it("permits a fresh request only after confirmed non-submission", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op" },
    } as never)
    const response = await recordedOperation(request(), params, async ({ confirmNotSubmitted }) => {
      confirmNotSubmitted()
      return apiError("SCAN_SERVICE_UNAVAILABLE", "Worker unavailable", 503, {
        "Retry-After": "30",
      })
    })
    expect(failAgentOperation).toHaveBeenCalledWith("op", "ws", {
      error: "OPERATION_NOT_SUBMITTED",
    })
    expect(response.headers.get("Retry-After")).toBe("30")
    expect((await response.json()).error.details.operationId).toBe("op")
  })
  it("keeps an existing retest non-retryable", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op" },
    } as never)
    await recordedOperation(request(), params, async () =>
      apiError("RETEST_IN_PROGRESS", "Already running", 409)
    )
    expect(failAgentOperation).toHaveBeenCalledWith("op", "ws", {
      error: "OPERATION_OUTCOME_UNKNOWN",
    })
  })

  it("records uncertain failures without allowing automatic re-execution", async () => {
    vi.mocked(claimOrGetAgentOperation).mockResolvedValue({
      status: "NEW",
      operation: { id: "op" },
    } as never)
    await expect(
      recordedOperation(request(), params, async () => {
        throw new Error("lost response")
      })
    ).rejects.toThrow("lost response")
    expect(failAgentOperation).toHaveBeenCalledWith("op", "ws", {
      error: "OPERATION_OUTCOME_UNKNOWN",
    })
  })
})
