import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleDoctor } from "../commands/doctor.js"
import type { Output } from "../output.js"

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  offlineCredentials: vi.fn(),
  request: vi.fn(),
}))

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: mocks.credentials,
  getOfflineCredentials: mocks.offlineCredentials,
}))
vi.mock("../client.js", () => ({
  createClient: vi.fn(async () => ({ request: mocks.request })),
}))
vi.mock("@lyrashield/agent-registry", () => ({ AGENTS: [], listAgents: () => [] }))
vi.mock("../installers/detect.js", () => ({
  detectAgent: vi.fn(),
  findDetectedLocations: vi.fn(),
}))

const output = {
  error: vi.fn(),
  log: vi.fn(),
  notice: vi.fn(),
  result: vi.fn(),
  warn: vi.fn(),
  json: true,
} as unknown as Output

beforeEach(() => {
  vi.clearAllMocks()
  mocks.request.mockResolvedValue([])
})

describe("doctor credential diagnostics", () => {
  it("consumes the shared setup-health result and gives strict blocking a stable exit code", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "lsk_testkey123",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "api-key",
      source: "environment",
      workspaceId: "ws-1",
    })
    mocks.request.mockResolvedValueOnce([{ id: "ws-1", name: "Workspace" }]).mockResolvedValueOnce({
      version: "lyrashield-setup-health/1.0.0",
      status: "blocked",
      allowed: false,
      checkedAt: "2026-11-05T00:00:00.000Z",
      expiresAt: "2026-11-05T00:01:00.000Z",
      scopeFingerprint: "a".repeat(64),
      scope: {},
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
    })

    expect(
      await handleDoctor(
        ["--target", "target-1", "--goal", "TEST_APP", "--mode", "STANDARD", "--strict"],
        output
      )
    ).toBe(5)

    const [method, path] = mocks.request.mock.calls[1] as [string, string]
    const url = new URL(path, "https://app.lyrashieldai.com")
    expect(method).toBe("GET")
    expect(url.pathname).toBe("/setup-health")
    expect(url.searchParams.get("targetId")).toBe("target-1")
    expect(output.result).toHaveBeenLastCalledWith(
      expect.objectContaining({
        setupHealth: expect.objectContaining({
          status: "blocked",
          primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
        }),
      })
    )
  })

  it("returns unknown setup health as exit code 6 only in strict mode", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "lsk_testkey123",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "api-key",
      source: "environment",
      workspaceId: "ws-1",
    })
    mocks.request.mockResolvedValueOnce([{ id: "ws-1", name: "Workspace" }]).mockResolvedValueOnce({
      version: "lyrashield-setup-health/1.0.0",
      status: "unknown",
      allowed: false,
      checkedAt: "2026-11-05T00:00:00.000Z",
      expiresAt: "2026-11-05T00:01:00.000Z",
      scopeFingerprint: "a".repeat(64),
      scope: {},
      checks: [],
      primaryCheck: "WORKER_READINESS_UNAVAILABLE",
      limitations: [],
    })

    expect(
      await handleDoctor(["--target", "target-1", "--mode", "STANDARD", "--strict"], output)
    ).toBe(6)
  })

  it("resolves stored credentials offline without OAuth refresh or any fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline doctor must not fetch"))
    mocks.offlineCredentials.mockResolvedValue({
      apiKey: "stored-access-token",
      credentialKind: "oauth",
      apiUrl: "https://app.lyrashieldai.com",
      workspaceId: "ws-1",
      installId: "install-1",
      source: "file",
    })
    mocks.credentials.mockRejectedValue(new Error("offline doctor must not refresh OAuth"))

    expect(await handleDoctor(["--offline"], output)).toBe(0)

    expect(mocks.offlineCredentials).toHaveBeenCalledTimes(1)
    expect(mocks.credentials).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(output.result).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credential: "OAuth access token",
        credentialKind: "oauth",
        credentialSource: "file",
        workspaceId: "ws-1",
        apiStatus: "skipped (offline)",
      })
    )
    fetchSpy.mockRestore()
  })

  it("labels OAuth without presenting its bearer token as an API key", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "oauth-bearer-token",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "oauth",
      source: "file",
    })

    expect(await handleDoctor([], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: "OAuth access token",
        credentialKind: "oauth",
        credentialSource: "file",
        apiKey: "not set",
      })
    )
  })

  it("keeps API keys redacted", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "lsk_testkey123",
      apiUrl: "https://app.lyrashieldai.com",
      credentialKind: "api-key",
      source: "environment",
    })

    expect(await handleDoctor([], output)).toBe(0)
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: "lsk_y123",
        credentialKind: "api-key",
        apiKey: "lsk_y123",
      })
    )
  })
})
