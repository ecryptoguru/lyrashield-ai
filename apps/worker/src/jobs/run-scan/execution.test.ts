import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  prisma: {
    targetDomainVerification: { findFirst: vi.fn() },
  },
  addScanEvent: vi.fn(),
  uploadEncryptedArtifact: vi.fn(),
  authorizeDeterministicRetest: vi.fn(),
  checkoutDeterministicRetest: vi.fn(),
  fetchRelayAudit: vi.fn(),
  mintScanRelayGrant: vi.fn(),
  registerRelayGrant: vi.fn(),
  resolveRelayRuntimeConfig: vi.fn(),
  resolveSpecServerHosts: vi.fn(),
  revokeRelayGrant: vi.fn(),
  interpretExitCode: vi.fn(),
  resolveEngineProfile: vi.fn(),
  runEngine: vi.fn(),
  resolveScanBudgetUsd: vi.fn(),
  requireEngineModel: vi.fn(),
  resolveEngineRuntimeBudgetMs: vi.fn(),
  normalizeDomainForProof: vi.fn(),
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: mocks.uploadEncryptedArtifact,
}))
vi.mock("@lyrashield/db", () => ({
  addScanEvent: mocks.addScanEvent,
  prisma: mocks.prisma,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("@lyrashield/security", () => ({
  buildUrlTargetInstruction: vi.fn(() => "instruction"),
  buildVibeSecurityInstruction: vi.fn(() => "instruction"),
  normalizeDomainForProof: mocks.normalizeDomainForProof,
}))
vi.mock("../../engine/deterministic-retest", () => ({
  authorizeDeterministicRetest: mocks.authorizeDeterministicRetest,
  checkoutDeterministicRetest: mocks.checkoutDeterministicRetest,
}))
vi.mock("../../engine/relay-client", () => ({
  fetchRelayAudit: mocks.fetchRelayAudit,
  mintScanRelayGrant: mocks.mintScanRelayGrant,
  registerRelayGrant: mocks.registerRelayGrant,
  resolveRelayRuntimeConfig: mocks.resolveRelayRuntimeConfig,
  resolveSpecServerHosts: mocks.resolveSpecServerHosts,
  revokeRelayGrant: mocks.revokeRelayGrant,
}))
vi.mock("../../engine/runner", () => ({
  interpretExitCode: mocks.interpretExitCode,
  resolveEngineProfile: mocks.resolveEngineProfile,
  runEngine: mocks.runEngine,
}))
vi.mock("../../engine/command-builder", () => ({
  resolveScanBudgetUsd: mocks.resolveScanBudgetUsd,
}))
vi.mock("./lifecycle-utils", () => ({
  requireEngineModel: mocks.requireEngineModel,
  resolveEngineRuntimeBudgetMs: mocks.resolveEngineRuntimeBudgetMs,
}))

import { executeScanTarget } from "./execution"

const relayConfig = { url: "https://relay.internal", token: "t" } as never

const target = {
  id: "target-1",
  type: "WEB_APP",
  name: "app",
  url: "https://app.example.com",
  repoFullName: null,
  branch: null,
  apiSpecUrl: null,
  environment: null,
  installationId: null,
  repoProvider: null,
} as never

function params(over: Partial<Parameters<typeof executeScanTarget>[0]> = {}) {
  return {
    scanId: "scan-1",
    workspaceId: "ws-1",
    goal: "review",
    mode: "DEEP",
    focus: null,
    target,
    policy: null,
    policyMaxBudgetUsd: undefined,
    scanRuntimeBudgetMs: 300_000,
    elapsedScanMs: () => 0,
    isScanCancelled: vi.fn().mockResolvedValue(false),
    markGlobalScanTimeout: vi.fn(),
    markBillablePhaseStarted: vi.fn(),
    deterministicRetest: false,
    engineBacked: true,
    urlEngineBacked: true,
    scanProfile: { canonicalMode: "DEEP" },
    ...over,
  } as Parameters<typeof executeScanTarget>[0]
}

const engineResult = {
  exitCode: 0,
  cancelled: false,
  timedOut: false,
  sourceCheckoutPath: null,
  output: {
    vulnerabilities: [],
    runRecord: null,
    findingCount: 0,
    summary: "done",
    findingsComplete: true,
  },
} as never

describe("executeScanTarget relay lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolveScanBudgetUsd.mockReturnValue(5)
    mocks.resolveEngineProfile.mockReturnValue({ model: "engine-model" })
    mocks.requireEngineModel.mockImplementation((model: string) => model)
    mocks.resolveEngineRuntimeBudgetMs.mockReturnValue(60_000)
    mocks.normalizeDomainForProof.mockReturnValue("app.example.com")
    mocks.resolveRelayRuntimeConfig.mockReturnValue(relayConfig)
    mocks.prisma.targetDomainVerification.findFirst.mockResolvedValue({ id: "ver-1" })
    mocks.mintScanRelayGrant.mockReturnValue({
      grant: "grant-1",
      scope: { hosts: ["app.example.com"], methods: ["GET"], maxRequests: 100 },
    })
    mocks.registerRelayGrant.mockResolvedValue(undefined)
    mocks.resolveSpecServerHosts.mockResolvedValue([])
    mocks.fetchRelayAudit.mockResolvedValue([])
    mocks.revokeRelayGrant.mockResolvedValue(undefined)
    mocks.addScanEvent.mockResolvedValue({ id: "evt-1" })
    mocks.runEngine.mockResolvedValue(engineResult)
  })

  it("revokes the relay grant in finally when the engine throws", async () => {
    mocks.runEngine.mockRejectedValue(new Error("engine crashed"))

    await expect(executeScanTarget(params())).rejects.toThrow("engine crashed")

    // Audit is drained before the grant dies; revocation still runs.
    expect(mocks.fetchRelayAudit).toHaveBeenCalledWith("scan-1", relayConfig)
    expect(mocks.revokeRelayGrant).toHaveBeenCalledWith("scan-1", relayConfig)
    expect(mocks.fetchRelayAudit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revokeRelayGrant.mock.invocationCallOrder[0]!
    )
  })

  it("persists the relay audit trail before revoking on engine failure", async () => {
    mocks.fetchRelayAudit.mockResolvedValue([{ host: "app.example.com", status: 200 }])
    mocks.uploadEncryptedArtifact.mockResolvedValue({ storageUri: "s3://bucket/audit" })
    mocks.runEngine.mockRejectedValue(new Error("engine crashed"))

    await expect(executeScanTarget(params())).rejects.toThrow("engine crashed")

    expect(mocks.uploadEncryptedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", type: "relay_audit" })
    )
    expect(mocks.revokeRelayGrant).toHaveBeenCalledWith("scan-1", relayConfig)
  })

  it("revokes the grant after a successful engine run too", async () => {
    const result = await executeScanTarget(params())

    expect(result).toMatchObject({ ok: true })
    expect(mocks.revokeRelayGrant).toHaveBeenCalledWith("scan-1", relayConfig)
  })

  it("denies the engine run without a verified domain and never mints a grant", async () => {
    mocks.prisma.targetDomainVerification.findFirst.mockResolvedValue(null)

    await expect(executeScanTarget(params())).resolves.toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "RELAY_SCOPE_UNAVAILABLE",
        errorMessage: expect.stringContaining("verified domain"),
      },
    })

    expect(mocks.mintScanRelayGrant).not.toHaveBeenCalled()
    expect(mocks.runEngine).not.toHaveBeenCalled()
    expect(mocks.revokeRelayGrant).not.toHaveBeenCalled()
  })

  it("denies the engine run when the relay is not configured", async () => {
    mocks.resolveRelayRuntimeConfig.mockReturnValue(null)

    await expect(executeScanTarget(params())).resolves.toMatchObject({
      ok: false,
      result: { errorCategory: "RELAY_SCOPE_UNAVAILABLE" },
    })
    expect(mocks.runEngine).not.toHaveBeenCalled()
  })

  it("fails closed when the relay grant cannot be minted", async () => {
    mocks.mintScanRelayGrant.mockImplementation(() => {
      throw new Error("scope overflow")
    })

    await expect(executeScanTarget(params())).resolves.toMatchObject({
      ok: false,
      result: { errorCategory: "RELAY_SCOPE_UNAVAILABLE" },
    })
    expect(mocks.runEngine).not.toHaveBeenCalled()
  })
})
