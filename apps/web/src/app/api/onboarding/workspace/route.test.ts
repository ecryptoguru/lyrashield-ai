import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ session: vi.fn(), choose: vi.fn(), list: vi.fn() }))
vi.mock("@lyrashield/auth/server", () => ({ getSession: mocks.session }))
vi.mock("@/lib/onboarding-workspace", async (original) => ({
  ...(await original<typeof import("@/lib/onboarding-workspace")>()),
  chooseOrCreateOnboardingWorkspace: mocks.choose,
  listOnboardingWorkspaces: mocks.list,
}))
import { POST, GET } from "./route"
import { OnboardingWorkspaceError } from "@/lib/onboarding-workspace"
const stamp = "2026-10-30T00:00:00.000Z"
const request = (body: unknown, headers?: HeadersInit) =>
  new Request("http://localhost:3000/api/onboarding/workspace", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ userId: "browser-user" })
  mocks.choose.mockResolvedValue({
    state: { updatedAt: new Date(stamp), workspaceId: "ws-selected" },
    workspace: { id: "ws-selected", name: "Beta", role: "DEVELOPER", canManageGitHub: false },
    trialStarted: false,
  })
  mocks.list.mockResolvedValue([{ id: "ws-selected", name: "Beta", role: "DEVELOPER" }])
})
it("uses the browser principal and one validated choose-or-create request", async () => {
  const response = await POST(
    request({ kind: "select", workspaceId: "ws-selected", expectedUpdatedAt: stamp })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    success: true,
    data: {
      state: { workspaceId: "ws-selected", updatedAt: stamp },
      workspace: { role: "DEVELOPER" },
    },
  })
  expect(mocks.choose).toHaveBeenCalledWith("browser-user", {
    kind: "select",
    workspaceId: "ws-selected",
    expectedUpdatedAt: stamp,
  })
})
it.each([
  null,
  { userId: "user", apiKey: { workspaceId: "ws" } },
  { userId: "user", oauth: { workspaceId: "ws" } },
])("rejects unauthenticated and workspace-bound credentials before selection", async (session) => {
  mocks.session.mockResolvedValue(session)
  expect(
    (await POST(request({ kind: "create", name: "Mine", expectedUpdatedAt: stamp }))).status
  ).toBe(session ? 403 : 401)
  expect((await GET()).status).toBe(session ? 403 : 401)
  expect(mocks.choose).not.toHaveBeenCalled()
  expect(mocks.list).not.toHaveBeenCalled()
})
it.each([
  { kind: "create", name: "   ", expectedUpdatedAt: stamp },
  { kind: "create", name: "Mine" },
  { kind: "select", workspaceId: "ws-selected", name: "Extra", expectedUpdatedAt: stamp },
  { kind: "create", name: "Mine", expectedUpdatedAt: stamp, userId: "another-user" },
])("rejects invalid or ambiguous input before mutation", async (input) => {
  expect((await POST(request(input))).status).toBe(400)
  expect(mocks.choose).not.toHaveBeenCalled()
})
it("rejects a cross-origin cookie mutation", async () => {
  expect(
    (
      await POST(
        request(
          { kind: "create", name: "Mine", expectedUpdatedAt: stamp },
          { cookie: "session=test", origin: "https://other.example" }
        )
      )
    ).status
  ).toBe(403)
  expect(mocks.choose).not.toHaveBeenCalled()
})
it.each([
  ["WORKSPACE_UNAVAILABLE", 403],
  ["ONBOARDING_CHANGED", 409],
] as const)("reports %s with recoverable status", async (code, status) => {
  mocks.choose.mockRejectedValue(new OnboardingWorkspaceError(code))
  const response = await POST(
    request({ kind: "select", workspaceId: "ws-selected", expectedUpdatedAt: stamp })
  )
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ success: false, error: { code } })
})
it("lists eligible options with names and roles", async () => {
  expect(await (await GET()).json()).toEqual({
    success: true,
    data: [{ id: "ws-selected", name: "Beta", role: "DEVELOPER" }],
  })
})
