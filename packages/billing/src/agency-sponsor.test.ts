import { beforeEach, expect, it, vi } from "vitest"

const { workspaceFind, memberFind, billingFind } = vi.hoisted(() => ({
  workspaceFind: vi.fn(),
  memberFind: vi.fn(),
  billingFind: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    workspace: { findUnique: workspaceFind },
    workspaceMember: { findFirst: memberFind },
  },
  withAccountRLS: vi.fn(async (_accountId: string, fn: (tx: unknown) => unknown) =>
    fn({ billingAccount: { findMany: billingFind } })
  ),
  bindAccountRLSContext: vi.fn(),
}))

vi.mock("./account", () => ({
  resolveAccountBilling: vi.fn(),
}))

import { resolveAccountBilling } from "./account"
import { resolveWorkspaceScanSponsor } from "./agency-sponsor"

beforeEach(() => {
  vi.clearAllMocks()
  workspaceFind.mockResolvedValue({ agencySponsorAccountId: "buyer" })
  memberFind.mockResolvedValue({ id: "member" })
  vi.mocked(resolveAccountBilling).mockResolvedValue({ effectivePlan: "LAUNCH_ASSURANCE" } as never)
})

it("binds an Agency teammate to the buyer's active account", async () => {
  expect(await resolveWorkspaceScanSponsor("ws", "teammate")).toEqual({
    accountId: "buyer",
    agency: true,
    agencyActive: true,
  })
  expect(memberFind).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ userId: "buyer", role: "OWNER", status: "active" }),
    })
  )
  expect(resolveAccountBilling).toHaveBeenCalledWith("buyer", expect.anything())
})

it("does not substitute a buyer who is no longer an active owner", async () => {
  memberFind.mockImplementation(async ({ where }) =>
    where.role === "OWNER" ? null : { id: "member" }
  )
  expect(await resolveWorkspaceScanSponsor("ws", "teammate")).toBeNull()
  expect(resolveAccountBilling).not.toHaveBeenCalled()
})

it("reports a lapsed Agency subscription without falling back to the teammate's account", async () => {
  vi.mocked(resolveAccountBilling).mockResolvedValue({ effectivePlan: "PRO" } as never)
  expect(await resolveWorkspaceScanSponsor("ws", "teammate")).toEqual({
    accountId: "buyer",
    agency: true,
    agencyActive: false,
  })
})
