import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    target: { findFirst: vi.fn() },
    aiSystemProfile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiSystemProfileVersion: { create: vi.fn() },
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
  buildAiSystemInventorySummary,
  upsertAiSystemProfile,
  validateAiSystemProfile,
  type AiSystemProfileInput,
} from "./ai-system-profile-service"

const input: AiSystemProfileInput = {
  systemName: "Support assistant",
  systemPurpose: "Help customers find documentation",
  modelProviders: [{ provider: "Azure AI", model: "gpt-5.6-luna", deployment: null }],
  dataClasses: ["support content"],
  dataSources: ["approved help center"],
  storageSystems: ["Postgres"],
  toolIntegrations: [],
  retentionSummary: "Thirty days",
  humanOversightSummary: "Support team review",
}

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $executeRaw: ReturnType<typeof vi.fn>
}

describe("AI system profile service", () => {
  beforeEach(() => vi.clearAllMocks())

  it("requires retention when customer-declared data sources exist", () => {
    expect(() => validateAiSystemProfile({ ...input, retentionSummary: null })).toThrow(
      "AI_SYSTEM_PROFILE_RETENTION_SUMMARY_REQUIRED"
    )
  })

  it("rejects unbounded customer declarations", () => {
    expect(() =>
      validateAiSystemProfile({ ...input, dataClasses: Array.from({ length: 51 }, () => "data") })
    ).toThrow("AI_SYSTEM_PROFILE_DATA_CLASSES_INVALID")
  })

  it("creates a checksummed immutable version and an inventory summary without verification claims", async () => {
    mockPrisma.target.findFirst.mockResolvedValue({ id: "target-1" })
    mockPrisma.aiSystemProfile.findFirst.mockResolvedValue(null)
    mockPrisma.aiSystemProfile.create.mockResolvedValue({
      id: "profile-1",
      version: 1,
      currentVersionId: null,
    })
    mockPrisma.aiSystemProfileVersion.create.mockResolvedValue({ id: "version-1", version: 1 })
    mockPrisma.aiSystemProfile.update.mockResolvedValue({ id: "profile-1", version: 1 })

    const result = await upsertAiSystemProfile({
      workspaceId: "ws-1",
      targetId: "target-1",
      createdById: "user-1",
      profile: input,
    })

    expect(result.version).toEqual({ id: "version-1", version: 1 })
    expect(mockPrisma.aiSystemProfileVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      })
    )
    expect(buildAiSystemInventorySummary(input)).toContain("Data sources: approved help center")
    expect(buildAiSystemInventorySummary(input)).toContain("Customer-declared")
    expect(buildAiSystemInventorySummary(input)).toContain("not independently verified")
  })
})
