import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $executeRaw: vi.fn(),
    targetDomainVerification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    liveAiSafetySettings: { upsert: vi.fn() },
    workspace: { findUnique: vi.fn() },
    target: { findFirst: vi.fn() },
    credentialSet: { findFirst: vi.fn() },
    liveAiSafetyPlan: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}))
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => {
    const { prisma } = await import("./client")
    return fn(prisma)
  }),
}))

import { prisma } from "./client"
import {
  createLiveAiSafetyPlan,
  issueDnsDomainVerification,
  LiveAiSafetyError,
  resolveAuthenticatedAssessmentAuthorization,
  verifyDnsDomainVerification,
} from "./live-ai-safety-service"
import { AI_SAFETY_TEST_CATALOG } from "@lyrashield/types"

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $executeRaw: ReturnType<typeof vi.fn>
}
const now = new Date("2026-08-14T00:00:00.000Z")
const plan = {
  workspaceId: "ws-1",
  targetId: "target-1",
  endpointUrl: "https://staging.example.com/safety",
  approvedHost: "staging.example.com",
  authMode: "NO_AUTH" as const,
  incidentContact: "security@example.com",
  maxRequests: 1,
  maxDurationSeconds: 60,
  maxResponseBytes: 1024,
  rawSampleStorage: "DISABLED" as const,
  destructiveTestsAllowed: false as const,
  cases: [AI_SAFETY_TEST_CATALOG[0]],
  createdById: "user-1",
}

describe("live AI safety service", () => {
  beforeEach(() => vi.clearAllMocks())

  it("issues a DNS proof without putting the proof token in the audit log", async () => {
    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue(null)
    mockPrisma.targetDomainVerification.create.mockResolvedValue({ id: "proof-1" })
    const issued = await issueDnsDomainVerification({
      workspaceId: "ws-1",
      domain: "https://Staging.Example.com/path",
      createdById: "user-1",
      now,
    })
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,256}$/)
    expect(mockPrisma.targetDomainVerification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ domain: "staging.example.com" }) })
    )
    expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain(issued.token)
  })

  it("records a fresh verification only after DNS returns the exact split TXT token", async () => {
    const token = "a".repeat(48)
    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue({
      id: "proof-1",
      domain: "staging.example.com",
      challengeToken: token,
      expiresAt: new Date(now.getTime() + 1),
    })
    mockPrisma.targetDomainVerification.update.mockResolvedValue({
      id: "proof-1",
      domain: "staging.example.com",
      method: "DNS_TXT",
    })
    await verifyDnsDomainVerification({
      workspaceId: "ws-1",
      verificationId: "proof-1",
      actorUserId: "user-1",
      now,
      resolveTxt: async () => [[token.slice(0, 16), token.slice(16)]],
    })
    expect(mockPrisma.targetDomainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "proof-1",
          workspaceId: "ws-1",
          challengeToken: token,
          expiresAt: new Date(now.getTime() + 1),
        },
        data: expect.objectContaining({ status: "VERIFIED" }),
      })
    )
  })

  it("does not verify a replacement challenge using an in-flight old DNS result", async () => {
    const token = "a".repeat(48)
    const expiresAt = new Date(now.getTime() + 60_000)
    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue({
      id: "proof-1",
      domain: "staging.example.com",
      challengeToken: token,
      expiresAt,
    })
    await expect(
      verifyDnsDomainVerification({
        workspaceId: "ws-1",
        verificationId: "proof-1",
        actorUserId: "user-1",
        now,
        resolveTxt: async () => {
          // Reissuance commits while DNS is in flight; Prisma cannot match the
          // old token/expiry predicate when finalizing the stale verification.
          mockPrisma.targetDomainVerification.update.mockRejectedValueOnce({ code: "P2025" })
          return [[token]]
        },
      })
    ).rejects.toMatchObject({ code: "DOMAIN_VERIFICATION_PROOF_CHANGED" })
    expect(mockPrisma.targetDomainVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proof-1", workspaceId: "ws-1", challengeToken: token, expiresAt },
      })
    )
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("reissuance resets a previous verified record and returns only the new token", async () => {
    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue({ id: "proof-1" })
    mockPrisma.targetDomainVerification.update.mockResolvedValue({ id: "proof-1" })
    const issued = await issueDnsDomainVerification({
      workspaceId: "ws-1",
      domain: "staging.example.com",
      createdById: "user-1",
      now,
    })
    expect(mockPrisma.targetDomainVerification.update).toHaveBeenCalledWith({
      where: { id: "proof-1" },
      data: expect.objectContaining({
        status: "PENDING",
        challengeToken: issued.token,
        verifiedAt: null,
        lastCheckedAt: null,
      }),
    })
  })

  it("rejects live plans for production targets before creating a run", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    mockPrisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://staging.example.com/safety",
      environment: "PRODUCTION",
    })
    await expect(createLiveAiSafetyPlan(plan)).rejects.toMatchObject<Partial<LiveAiSafetyError>>({
      code: "LIVE_AI_SAFETY_NON_PRODUCTION_REQUIRED",
    })
    expect(mockPrisma.liveAiSafetyPlan.create).not.toHaveBeenCalled()
  })

  it("requires a paid workspace and current verified domain before creating a ready plan", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    mockPrisma.target.findFirst.mockResolvedValue({
      id: "target-1",
      type: "WEB_APP",
      url: "https://staging.example.com/safety",
      environment: "STAGING",
    })
    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue(null)
    await expect(createLiveAiSafetyPlan(plan)).rejects.toMatchObject<Partial<LiveAiSafetyError>>({
      code: "DOMAIN_VERIFICATION_REQUIRED",
    })

    mockPrisma.targetDomainVerification.findFirst.mockResolvedValue({ id: "proof-1" })
    mockPrisma.liveAiSafetyPlan.create.mockResolvedValue({ id: "plan-1", status: "READY" })
    await expect(createLiveAiSafetyPlan(plan)).resolves.toMatchObject({
      id: "plan-1",
      status: "READY",
    })
  })
})

describe("resolveAuthenticatedAssessmentAuthorization", () => {
  const input = {
    workspaceId: "ws-1",
    targetId: "target-1",
    authorizationRef: "plan-1",
    now: new Date("2026-09-19T12:00:00.000Z"),
  }
  const readyPlan = {
    id: "plan-1",
    targetId: "target-1",
    status: "READY",
    approvedHost: "staging.example.com",
    authMode: "TEST_CREDENTIAL",
    credentialId: "cred-1",
    incidentContact: "security@example.com",
    domainVerification: {
      id: "proof-1",
      status: "VERIFIED",
      expiresAt: new Date("2026-09-20T00:00:00.000Z"),
    },
  }
  const stagingTarget = {
    id: "target-1",
    type: "WEB_APP",
    url: "https://staging.example.com/app",
    environment: "STAGING",
  }
  const testCredential = {
    id: "cred-1",
    kind: "SESSION_COOKIE",
    vaultRef: "env:LYRASHIELD_TEST_SESSION_ACME",
    scope: { role: "viewer" },
    expiresAt: new Date("2026-09-19T13:00:00.000Z"),
    createdAt: new Date("2026-09-19T11:30:00.000Z"),
  }

  beforeEach(() => {
    mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue(readyPlan)
    mockPrisma.target.findFirst.mockResolvedValue(stagingTarget)
    mockPrisma.credentialSet.findFirst.mockResolvedValue(testCredential)
  })

  it("resolves a READY authorization covering the exact staging host", async () => {
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).resolves.toMatchObject({
      planId: "plan-1",
      approvedHost: "staging.example.com",
      credentialId: "cred-1",
      credentialKind: "SESSION_COOKIE",
      credentialVaultRef: "env:LYRASHIELD_TEST_SESSION_ACME",
    })
    expect(mockPrisma.liveAiSafetyPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1", workspaceId: "ws-1" },
      })
    )
    expect(mockPrisma.credentialSet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "cred-1",
          workspaceId: "ws-1",
          OR: [{ targetId: null }, { targetId: "target-1" }],
        }),
      })
    )
  })

  it("rejects a missing or cross-target authorization reference", async () => {
    mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue(null)
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_AUTH_NOT_FOUND",
    })
    mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue({
      ...readyPlan,
      targetId: "other-target",
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_AUTH_NOT_FOUND",
    })
  })

  it.each(["STOPPED", "COMPLETED", "FAILED", "RUNNING", "DRAFT", "PENDING_APPROVAL"] as const)(
    "rejects a %s authorization — only READY may run",
    async (status) => {
      mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue({ ...readyPlan, status })
      await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
        Partial<LiveAiSafetyError>
      >({
        code: "AUTH_ASSESSMENT_AUTH_NOT_READY",
      })
    }
  )

  it.each(["PRODUCTION", null, "DR"] as const)(
    "rejects a %s target environment — staging/preview only",
    async (environment) => {
      mockPrisma.target.findFirst.mockResolvedValue({ ...stagingTarget, environment })
      await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
        Partial<LiveAiSafetyError>
      >({
        code: "AUTH_ASSESSMENT_PRODUCTION_DENIED",
      })
    }
  )

  it("rejects an authorization that does not cover the exact target host", async () => {
    mockPrisma.target.findFirst.mockResolvedValue({
      ...stagingTarget,
      url: "https://other.example.com/app",
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_HOST_MISMATCH",
    })
  })

  it("rejects when the domain proof lapsed after the authorization was recorded", async () => {
    mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue({
      ...readyPlan,
      domainVerification: {
        id: "proof-1",
        status: "VERIFIED",
        expiresAt: new Date("2026-09-19T11:00:00.000Z"),
      },
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "DOMAIN_VERIFICATION_REQUIRED",
    })
  })

  it("rejects plans without a bound test-session credential", async () => {
    mockPrisma.liveAiSafetyPlan.findFirst.mockResolvedValue({
      ...readyPlan,
      authMode: "NO_AUTH",
      credentialId: null,
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_SESSION_REQUIRED",
    })
  })

  it("rejects expired and long-lived credentials", async () => {
    mockPrisma.credentialSet.findFirst.mockResolvedValue({
      ...testCredential,
      expiresAt: new Date("2026-09-19T11:00:00.000Z"),
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_SESSION_EXPIRED",
    })
    mockPrisma.credentialSet.findFirst.mockResolvedValue({
      ...testCredential,
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      expiresAt: new Date("2026-09-20T00:00:00.000Z"),
    })
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_SESSION_TOO_LONG",
    })
  })

  it("rejects a credential row that does not resolve in the workspace/target scope", async () => {
    mockPrisma.credentialSet.findFirst.mockResolvedValue(null)
    await expect(resolveAuthenticatedAssessmentAuthorization(input)).rejects.toMatchObject<
      Partial<LiveAiSafetyError>
    >({
      code: "AUTH_ASSESSMENT_SESSION_NOT_FOUND",
    })
  })
})
