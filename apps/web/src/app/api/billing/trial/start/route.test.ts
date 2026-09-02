import { beforeEach, expect, it, vi } from "vitest"
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn() }))
vi.mock("@lyrashield/billing", () => ({ startTrial: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/api-auth", () => ({
  authErrorResponse: (error: Error) =>
    error.message === "denied" ? new Response(null, { status: 403 }) : null,
}))
import { requirePermission } from "@lyrashield/auth/server"
import { startTrial } from "@lyrashield/billing"
import { POST } from "./route"
const request = () =>
  new Request("http://localhost/api/billing/trial/start", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "ws" }),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user" } } as never)
})
it("requires billing manage before starting a trial", async () => {
  vi.mocked(requirePermission).mockRejectedValue(new Error("denied"))
  expect((await POST(request())).status).toBe(403)
  expect(requirePermission).toHaveBeenCalledWith("ws", "billing:manage")
  expect(startTrial).not.toHaveBeenCalled()
})
it("returns a paid-plan conflict instead of downgrading", async () => {
  vi.mocked(startTrial).mockRejectedValue(new Error("TRIAL_PAID_PLAN"))
  const response = await POST(request())
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe("TRIAL_PAID_PLAN")
})
it("returns an already-used conflict without requiring a trial end timestamp", async () => {
  vi.mocked(startTrial).mockResolvedValue({ started: false, alreadyUsed: true, trialEndsAt: null })
  const response = await POST(request())
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe("TRIAL_ALREADY_USED")
})
