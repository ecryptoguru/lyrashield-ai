import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ withAccountRLS: vi.fn() }))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "account-1" } }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/billing", () => ({
  resolveAccountBilling: vi.fn().mockResolvedValue({
    id: "billing-1",
    provider: "complimentary",
    effectivePlan: "LAUNCH_ASSURANCE",
  }),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { auditLog: { create: vi.fn() } },
  withAccountRLS: mocks.withAccountRLS,
}))
vi.mock("@lyrashield/logger", async () => (await import("@/__tests__/mocks")).loggerModule())
vi.mock("@/lib/api-auth", () => ({
  withCookieMutation: (handler: (request: Request) => Promise<Response>) => handler,
  authErrorResponse: () => null,
}))

import { POST } from "./route"

it("refuses overage spend on complimentary Launch Assurance", async () => {
  const response = await POST(
    new Request("https://app.lyrashieldai.com/api/billing/spend-limit?workspaceId=workspace-1", {
      method: "POST",
      body: JSON.stringify({ cents: 1000 }),
    })
  )

  expect(response.status).toBe(403)
  expect(mocks.withAccountRLS).not.toHaveBeenCalled()
})
