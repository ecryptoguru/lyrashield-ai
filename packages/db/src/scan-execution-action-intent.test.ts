import { describe, expect, it, vi } from "vitest"
import {
  canonicalJson,
  sha256Hex,
  type AuthorityAction,
  type AuthoritySqlConnection,
} from "@lyrashield/runtime-control"
import {
  createScanExecutionActionAuthorityVerifier,
  parseProviderActionIntent,
} from "./scan-execution-action-intent"

function fixture() {
  const request = {
    grantRequestId: "grant-original",
    attemptId: "attempt-original",
    scanId: "scan-original",
    workspaceId: "workspace-original",
    operationId: "operation-original",
    authorityEpochId: "epoch-original",
    authorityRevision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    providerId: "fixture",
    maxRequests: 3,
    costReservationMicros: 10,
    maxReservedCostMicros: 100,
  }
  const policy = {
    version: 1,
    endpoint: "/responses?api-version=fixture",
    models: { approved: { inputMicrosPerMillion: 10 } },
  }
  const authorityInput = { request, policy }
  const actionInput = {
    requestId: "request-original",
    providerId: "fixture",
    path: "/responses",
    query: "?api-version=fixture",
    method: "POST",
    contentType: "application/json",
    accept: "application/json",
    bodyHash: "a".repeat(64),
  }
  const binding: AuthorityAction = {
    phase: "PROVIDER_DISPATCH",
    operationId: request.operationId,
    attemptId: request.attemptId,
    scanId: request.scanId,
    workspaceId: request.workspaceId,
    authorityEpochId: request.authorityEpochId,
    authorityRevision: 1,
    requestId: actionInput.requestId,
    authorityChecksum: sha256Hex(canonicalJson(authorityInput)),
    actionChecksum: sha256Hex(canonicalJson(actionInput)),
  }
  return {
    input: { binding, authorityInput, actionInput },
    policies: new Map([["fixture", canonicalJson(policy)]]),
  }
}
describe("exact protected provider action evidence", () => {
  it("retains the exact original full policy, grant and normalized action bytes", () => {
    const f = fixture(),
      parsed = parseProviderActionIntent(f.input, f.policies)
    expect(parsed.authorityInputJson).toBe(canonicalJson(f.input.authorityInput))
    expect(parsed.actionInputJson).toBe(canonicalJson(f.input.actionInput))
  })
  it.each(["operationId", "attemptId", "scanId", "workspaceId", "authorityEpochId"] as const)(
    "rejects changed %s even with rehashed payload",
    (key) => {
      const f = fixture()
      f.input.authorityInput.request[key] = "changed-authority"
      f.input.binding.authorityChecksum = sha256Hex(canonicalJson(f.input.authorityInput))
      expect(() => parseProviderActionIntent(f.input, f.policies)).toThrow()
    }
  )
  it("rejects a caller supplied provider policy despite its valid checksum", () => {
    const f = fixture()
    f.input.authorityInput.policy.models.approved.inputMicrosPerMillion = 0
    f.input.binding.authorityChecksum = sha256Hex(canonicalJson(f.input.authorityInput))
    expect(() => parseProviderActionIntent(f.input, f.policies)).toThrow()
  })
  it("rejects mismatched request, endpoint, method, negotiation and body hash", () => {
    for (const change of [
      { requestId: "request-fresh" },
      { query: "?api-version=other" },
      { method: "GET" },
      { contentType: "text/plain" },
      { accept: "" },
      { bodyHash: "wrong" },
    ]) {
      const f = fixture()
      Object.assign(f.input.actionInput, change)
      f.input.binding.actionChecksum = sha256Hex(canonicalJson(f.input.actionInput))
      expect(() => parseProviderActionIntent(f.input, f.policies)).toThrow()
    }
  })
  it("rejects absent approval or independent checksum mismatch", () => {
    const f = fixture()
    expect(() => parseProviderActionIntent(f.input, new Map())).toThrow()
    f.input.binding.actionChecksum = "b".repeat(64)
    expect(() => parseProviderActionIntent(f.input, f.policies)).toThrow()
  })
})

describe("sandbox tool authority", () => {
  it("fails closed even with a bound workspace and the preparation gate held", async () => {
    const rows = [
      [{ workspaceId: "workspace-original", accountId: "account", userId: "user" }],
      [],
      [{ held: true }],
    ]
    const query = vi
      .fn<AuthoritySqlConnection["query"]>()
      .mockImplementation(async () => ({ rows: rows.shift() ?? [] }))
    const connection = { query, release: vi.fn() }
    const verify = createScanExecutionActionAuthorityVerifier({
      approvedProviderPolicies: new Map(),
    })
    const { binding } = fixture().input

    await expect(
      verify(connection, {
        ...binding,
        phase: "SANDBOX_TOOL",
        commandId: "prepare-original",
        executorKey: "sandbox",
      })
    ).rejects.toThrow("Current scan execution action authority is unavailable")
    expect(query).toHaveBeenCalledTimes(3)
  })
})
