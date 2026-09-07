import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const policy = {
  id: "policy-1",
  workspaceId: "workspace-1",
  name: "Default",
  description: null,
  scanWindow: null,
  blockedPaths: [],
  allowedDomains: [],
  rateLimit: null,
  networkEgressPolicy: "target_only",
  destructiveTestsAllowed: false,
  approvalRequired: false,
  maxBudgetUsd: null,
  maxDurationMinutes: 60,
  piiRedactionEnabled: true,
  evidenceRetentionDays: 30,
}
const policyFingerprint = createHash("sha256")
  .update(
    JSON.stringify(
      Object.fromEntries(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b)))
    )
  )
  .digest("hex")

vi.mock("./client", () => ({
  prisma: {
    gateVerdict: { findFirst: vi.fn() },
    policy: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findFirst: vi.fn() },
    findingVerification: { findFirst: vi.fn() },
  },
}))
vi.mock("./rls", () => ({
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => {
    const { prisma } = await import("./client")
    return fn(prisma)
  }),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { prisma } from "./client"
import { getCurrentGateVerdict } from "./gate-service"

describe("getCurrentGateVerdict", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.policy.findFirst).mockResolvedValue(policy as never)
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.finding.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.findingVerification.findFirst).mockResolvedValue(null)
  })

  it("returns READY only for the bound commit before expiry", async () => {
    vi.mocked(prisma.gateVerdict.findFirst).mockResolvedValue({
      state: "READY",
      evaluatedAt: new Date(1_000),
      assessmentSnapshot: {
        version: 2,
        scanId: "scan-1",
        completedAtMs: 1_000,
        manifestChecksum: "a".repeat(64),
        manifestVersion: 7,
        policyId: "policy-1",
        policyFingerprint,
        identity: { kind: "COMMIT", value: "b".repeat(40) },
      },
    } as never)

    const result = await getCurrentGateVerdict("workspace-1", "target-1", {
      expectedCommit: "b".repeat(40),
      now: new Date(1_001),
    })

    expect(result).toMatchObject({ state: "READY", applicability: { applicable: true } })
  })

  it("fails closed for legacy history and a changed release", async () => {
    vi.mocked(prisma.gateVerdict.findFirst).mockResolvedValue({
      state: "READY",
      evaluatedAt: new Date(1_000),
      assessmentSnapshot: null,
    } as never)
    const legacy = await getCurrentGateVerdict("workspace-1", "target-1", {
      expectedCommit: "b".repeat(40),
      now: new Date(1_001),
    })
    expect(legacy).toMatchObject({
      state: "INSUFFICIENT_EVIDENCE",
      applicability: { applicable: false },
    })
  })
})
