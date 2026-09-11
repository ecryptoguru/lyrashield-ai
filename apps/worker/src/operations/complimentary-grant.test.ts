import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  rows: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn().mockResolvedValue({}),
  grant: vi.fn().mockResolvedValue({ created: true, minutes: 6000 }),
}))
vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({
    user: { findUnique: mocks.user },
    billingAccount: { findMany: mocks.rows, upsert: mocks.upsert },
    workspaceMember: { findFirst: vi.fn().mockResolvedValue(null) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ deletedAt: null }) },
  }),
  prisma: { auditLog: { create: mocks.audit } },
  withAccountRLS: vi.fn(),
}))
vi.mock("@lyrashield/billing", () => ({
  grantMonthlyPool: mocks.grant,
  resolveAllowanceCycle: ({ periodStart }: { periodStart: Date }) => ({ cycleStart: periodStart }),
}))
import { main } from "./complimentary-grant"
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: "account",
    emailVerified: true,
    platformRole: "PLATFORM_OPERATOR",
  })
  mocks.rows.mockResolvedValue([])
  mocks.upsert.mockResolvedValue({ id: "comp", currentPeriodStart: new Date("2026-09-01") })
})
describe("complimentary account operation", () => {
  it("dry run performs no writes", async () => {
    await main(["--email", "ankit@lyrashieldai.com"])
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.grant).not.toHaveBeenCalled()
  })
  it("grants and audits an account with no workspace without changing workspace plans", async () => {
    await main([
      "--email",
      "ankit@lyrashieldai.com",
      "--apply",
      "--confirm",
      "GRANT COMPLIMENTARY LAUNCH ASSURANCE",
      "--audit-workspace",
      "audit-ws",
      "--actor-user",
      "operator",
    ])
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ accountId: "account", workspaceId: null }),
      })
    )
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account", workspaceId: null, billingAccountId: "comp" })
    )
    expect(mocks.audit).toHaveBeenCalledTimes(2)
  })
  it("refuses to mutate without audit identity", async () => {
    await expect(
      main([
        "--email",
        "ankit@lyrashieldai.com",
        "--apply",
        "--confirm",
        "GRANT COMPLIMENTARY LAUNCH ASSURANCE",
      ])
    ).rejects.toThrow("audit_workspace_and_actor_required")
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
