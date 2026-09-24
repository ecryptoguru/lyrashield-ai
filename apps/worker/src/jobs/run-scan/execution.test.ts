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
  resolveAuthenticatedAssessmentAuthorization: vi.fn(),
  resolveRelaySessionBinding: vi.fn(),
  AuthSessionError: class AuthSessionError extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))

vi.mock("@lyrashield/evidence-storage", () => ({
  uploadEncryptedArtifact: mocks.uploadEncryptedArtifact,
}))
vi.mock("@lyrashield/db", () => ({
  addScanEvent: mocks.addScanEvent,
  prisma: mocks.prisma,
  resolveAuthenticatedAssessmentAuthorization: mocks.resolveAuthenticatedAssessmentAuthorization,
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
vi.mock("./auth-session", () => ({
  resolveRelaySessionBinding: mocks.resolveRelaySessionBinding,
  AuthSessionError: mocks.AuthSessionError,
}))

import { buildScanExecutionPlan } from "@lyrashield/types"
import { executeScanTarget, resolveEngineTerminalError } from "./execution"

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

  it("cleans a deterministic checkout when event persistence fails before handoff", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    mocks.checkoutDeterministicRetest.mockResolvedValue({
      checkoutPath: "/tmp/retest",
      sourceRevision: "abc123",
      cleanup,
    })
    mocks.addScanEvent.mockRejectedValue(new Error("event storage unavailable"))

    await expect(
      executeScanTarget(
        params({
          deterministicRetest: true,
          target: { ...target, repoProvider: "github", repoFullName: "owner/repo" } as never,
        })
      )
    ).rejects.toThrow("event storage unavailable")

    expect(cleanup).toHaveBeenCalledOnce()
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

  it("forwards the stored execution plan into the engine command config", async () => {
    const plan = buildScanExecutionPlan({
      workflow: "REVIEW_CHANGES",
      targetType: "REPO",
      mode: "DEEP",
      source: {
        revision: "a".repeat(40),
        baseRevision: "b".repeat(40),
        mergeBaseRevision: "c".repeat(40),
      },
    })
    const repoTarget = {
      ...target,
      type: "REPO",
      url: null,
      repoFullName: "acme/app",
      repoProvider: "github",
    } as never

    const result = await executeScanTarget(
      params({
        target: repoTarget,
        urlEngineBacked: false,
        scanProfile: null,
        executionPlan: plan,
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(mocks.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ executionPlan: plan }),
      "scan-1",
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    // No relay grant is minted for a repository Review Changes run.
    expect(mocks.mintScanRelayGrant).not.toHaveBeenCalled()
  })

  it("uses a smaller recorded budget and engine ceiling for an ordinary repository plan", async () => {
    const built = buildScanExecutionPlan({ targetType: "REPO", mode: "DEEP" })
    const plan = {
      ...built,
      limits: {
        ...built.limits,
        maxBudgetUsd: 0.7,
        maxDurationMs: 180_000,
        maxEngineMs: 120_000,
        scannerReserveMs: 60_000,
      },
    }
    mocks.resolveEngineRuntimeBudgetMs.mockReturnValue(200_000)

    const result = await executeScanTarget(
      params({
        target: { ...target, type: "REPO", repoFullName: "acme/app", url: null } as never,
        urlEngineBacked: false,
        executionPlan: plan,
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(mocks.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 0.7 }),
      "scan-1",
      120_000,
      expect.anything(),
      expect.anything()
    )
  })
})

describe("executeScanTarget authenticated staging beta", () => {
  const betaPlan = () =>
    buildScanExecutionPlan({
      workflow: "AUTHENTICATED_ASSESSMENT",
      targetType: "WEB_APP",
      mode: "DEEP",
      authorizationRef: "authz_1",
    })
  const stagingTarget = { ...target, environment: "STAGING" } as never
  const authorization = {
    planId: "authz_1",
    approvedHost: "app.example.com",
    credentialId: "cred-1",
    credentialKind: "BEARER_TOKEN",
    credentialVaultRef: "env:LYRASHIELD_TEST_SESSION_ACME",
    credentialScope: null,
    credentialExpiresAt: new Date(Date.now() + 3_600_000),
  }
  const sessionBinding = {
    headers: { authorization: "Bearer test-session-material" },
    hosts: ["app.example.com"],
    exp: Date.now() + 3_600_000,
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolveScanBudgetUsd.mockReturnValue(5)
    mocks.resolveEngineProfile.mockReturnValue({ model: "engine-model" })
    mocks.requireEngineModel.mockImplementation((model: string) => model)
    mocks.resolveEngineRuntimeBudgetMs.mockReturnValue(20 * 60 * 1000)
    mocks.normalizeDomainForProof.mockReturnValue("app.example.com")
    mocks.resolveRelayRuntimeConfig.mockReturnValue(relayConfig)
    mocks.prisma.targetDomainVerification.findFirst.mockResolvedValue({ id: "ver-1" })
    mocks.mintScanRelayGrant.mockReturnValue({
      grant: "grant-1",
      scope: {
        hosts: ["app.example.com"],
        methods: ["GET", "HEAD", "OPTIONS"],
        maxRequests: 25,
        exp: Date.now() + 60_000,
      },
    })
    mocks.registerRelayGrant.mockResolvedValue(undefined)
    mocks.resolveSpecServerHosts.mockResolvedValue([])
    mocks.fetchRelayAudit.mockResolvedValue([])
    mocks.revokeRelayGrant.mockResolvedValue(undefined)
    mocks.addScanEvent.mockResolvedValue({ id: "evt-1" })
    mocks.runEngine.mockResolvedValue(engineResult)
    mocks.resolveAuthenticatedAssessmentAuthorization.mockResolvedValue(authorization)
    mocks.resolveRelaySessionBinding.mockReturnValue(sessionBinding)
  })

  it("mints a read-only beta grant with the exact plan ceilings and registers the session", async () => {
    const plan = betaPlan()
    const result = await executeScanTarget(
      params({
        target: stagingTarget,
        executionPlan: plan,
        policy: { blockedPaths: ["/internal"], destructiveTestsAllowed: false } as never,
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(mocks.mintScanRelayGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: "scan-1",
        authenticatedBeta: { maxRequests: 25, maxResponseBytes: 1_048_576 },
        destructiveTestsAllowed: false,
        blockedPaths: expect.arrayContaining(["/internal", "/logout", "/admin"]),
      }),
      relayConfig
    )
    // The engine grant expiry narrows to the plan's engine budget.
    const mintInput = mocks.mintScanRelayGrant.mock.calls[0]![0] as {
      engineBudgetMs: number
    }
    expect(mintInput.engineBudgetMs).toBeLessThanOrEqual(plan.limits.maxEngineMs)
    // The resolved session binding is registered on the admin channel —
    // never minted into the grant.
    expect(mocks.registerRelayGrant).toHaveBeenCalledWith(
      "scan-1",
      "grant-1",
      relayConfig,
      sessionBinding
    )
    expect(mocks.resolveRelaySessionBinding).toHaveBeenCalledWith(
      authorization,
      expect.objectContaining({ grantExpiresAtMs: expect.any(Number) })
    )
    // Budget clamps to the $5 plan ceiling.
    expect(mocks.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ maxBudgetUsd: 5 }),
      "scan-1",
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    // The binding receipt records references, never session material.
    const boundEvent = mocks.addScanEvent.mock.calls.find(
      (call) => call[1] === "auth_session_bound"
    )
    expect(boundEvent).toBeDefined()
    expect(JSON.stringify(mocks.addScanEvent.mock.calls)).not.toContain("test-session-material")
  })

  it("is a bounded stop when the authorization was revoked mid-run", async () => {
    mocks.resolveAuthenticatedAssessmentAuthorization.mockRejectedValue(
      new Error("AUTH_ASSESSMENT_AUTH_NOT_READY")
    )

    await expect(
      executeScanTarget(params({ target: stagingTarget, executionPlan: betaPlan() }))
    ).resolves.toEqual({
      ok: false,
      result: {
        status: "failed",
        errorCategory: "SCAN_AUTHORIZATION_REVOKED",
        errorMessage: expect.stringContaining("authorization"),
      },
    })
    expect(mocks.mintScanRelayGrant).not.toHaveBeenCalled()
    expect(mocks.registerRelayGrant).not.toHaveBeenCalled()
    expect(mocks.runEngine).not.toHaveBeenCalled()
  })

  it("fails closed when the recorded test session cannot be applied", async () => {
    mocks.resolveRelaySessionBinding.mockImplementation(() => {
      throw new mocks.AuthSessionError("AUTH_SESSION_UNAVAILABLE")
    })

    await expect(
      executeScanTarget(params({ target: stagingTarget, executionPlan: betaPlan() }))
    ).resolves.toEqual({
      ok: false,
      result: expect.objectContaining({
        status: "failed",
        errorCategory: "AUTH_SESSION_UNAVAILABLE",
      }),
    })
    // The minted grant is never registered; the engine never runs.
    expect(mocks.registerRelayGrant).not.toHaveBeenCalled()
    expect(mocks.runEngine).not.toHaveBeenCalled()
  })
})

describe("resolveEngineTerminalError runtime deadline mapping", () => {
  const base = {
    scanId: "scan-1",
    engineBacked: true,
    deterministicRetest: false,
    priorError: null,
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("keeps filed findings as PARTIAL when the engine reports a runtime deadline", async () => {
    const result = await resolveEngineTerminalError({
      ...base,
      engineResult: {
        exitCode: 2,
        output: {
          vulnerabilities: [{ title: "finding" }],
          runRecord: { terminal_reason: "runtime_deadline" },
        },
      } as never,
      exitInterpretation: { status: "FAILED", category: "VULNERABILITIES_FOUND", message: "x" },
    })

    expect(result).toEqual({
      status: "PARTIAL",
      errorCategory: "ENGINE_RUNTIME_DEADLINE",
      errorMessage: "Engine reached its runtime limit; partial findings preserved",
    })
  })

  it("fails without findings when the engine reports a runtime deadline", async () => {
    // The engine exits 5 when the deadline fires before any finding is filed;
    // the run record, not the exit code, must decide the category.
    const result = await resolveEngineTerminalError({
      ...base,
      engineResult: {
        exitCode: 5,
        output: {
          vulnerabilities: [],
          runRecord: { terminal_reason: "runtime_deadline" },
        },
      } as never,
      exitInterpretation: { status: "FAILED", category: "ENGINE_INCOMPLETE", message: "x" },
    })

    expect(result).toEqual({
      status: "FAILED",
      errorCategory: "ENGINE_RUNTIME_DEADLINE",
      errorMessage: "Engine reached its runtime limit; partial findings preserved",
    })
  })

  it("leaves the generic incomplete path for a run record without the deadline reason", async () => {
    const result = await resolveEngineTerminalError({
      ...base,
      engineResult: {
        exitCode: 5,
        output: { vulnerabilities: [], runRecord: { terminal_reason: "incomplete" } },
      } as never,
      exitInterpretation: { status: "FAILED", category: "ENGINE_INCOMPLETE", message: "x" },
    })

    expect(result).toEqual({
      status: "FAILED",
      errorCategory: "ENGINE_INCOMPLETE",
      errorMessage: "Engine did not produce a completed, valid result receipt",
    })
  })
})
