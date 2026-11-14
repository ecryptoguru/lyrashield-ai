import { beforeEach, describe, expect, it, vi } from "vitest"
import { LyraShieldClient } from "../client"
import { getSetupHealth } from "../resources/setup-health"

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

const snapshot = {
  version: "lyrashield-setup-health/1.0.0",
  status: "blocked",
  allowed: false,
  checkedAt: "2026-11-05T00:00:00.000Z",
  expiresAt: "2026-11-05T00:01:00.000Z",
  scopeFingerprint: "a".repeat(64),
  scope: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "TEST_APP",
    mode: "STANDARD",
    workflow: "REVIEW_TARGET",
    policyFingerprint: null,
    attachmentFingerprint: null,
    authorizationFingerprint: null,
    sourceRevision: null,
  },
  checks: [
    {
      code: "DOMAIN_VERIFICATION_REQUIRED",
      status: "blocked",
      explanation: "Verify control of this domain once.",
      recoveryAction: "VERIFY_DOMAIN",
    },
  ],
  primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
  limitations: [],
}

describe("getSetupHealth", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: LyraShieldClient

  beforeEach(() => {
    fetchMock = vi.fn()
    client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      workspaceId: "ws-1",
      fetchFn: fetchMock as unknown as typeof fetch,
    })
  })

  it("calls the shared setup-health endpoint and preserves reason/recovery codes", async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, data: snapshot }))

    const result = await getSetupHealth(client, {
      targetId: "target-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      workflow: "REVIEW_TARGET",
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("GET")
    expect(new URL(url).pathname).toBe("/api/v1/setup-health")
    expect(new URL(url).searchParams.get("workspaceId")).toBe("ws-1")
    expect(new URL(url).searchParams.get("targetId")).toBe("target-1")
    expect(result.primaryCheck).toBe("DOMAIN_VERIFICATION_REQUIRED")
    expect(result.checks[0]?.recoveryAction).toBe("VERIFY_DOMAIN")
  })

  it("forwards policy, refs and repeated attachment IDs", async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, data: snapshot }))

    await getSetupHealth(client, {
      targetId: "target-1",
      goal: "CHECK_PR",
      mode: "QUICK",
      workflow: "REVIEW_CHANGES",
      policyId: "policy-1",
      baseRef: "main",
      headRef: "feature/42",
      attachmentIds: ["att-1", "att-2"],
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.searchParams.get("policyId")).toBe("policy-1")
    expect(parsed.searchParams.get("baseRef")).toBe("main")
    expect(parsed.searchParams.get("headRef")).toBe("feature/42")
    expect(parsed.searchParams.getAll("attachmentIds")).toEqual(["att-1", "att-2"])
  })
})
