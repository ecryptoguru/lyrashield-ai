import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $executeRaw: vi.fn(),
    targetDomainVerification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    liveAiSafetySettings: { upsert: vi.fn() },
    workspace: { findUnique: vi.fn() },
    target: { findFirst: vi.fn() },
    credentialSet: { findFirst: vi.fn() },
    liveAiSafetyPlan: { create: vi.fn() },
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
      expect.objectContaining({ data: expect.objectContaining({ status: "VERIFIED" }) })
    )
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
