import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()
const deleteUserAccount = vi.fn()
class AccountDeletionBlockedError extends Error {
  constructor(public workspaces: Array<{ id: string; name: string; members?: unknown[] }>) {
    super("blocked")
  }
}
class AccountDeletionConfirmationRequiredError extends Error {
  constructor(
    public deletableWorkspaces: Array<{ id: string; name: string }>,
    public expectedConfirmation: string
  ) {
    super("confirmation required")
  }
}

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/db", () => ({
  deleteUserAccount,
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const { DELETE } = await import("./route")

function request(confirmation: unknown) {
  return new Request("http://localhost/api/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation }),
  })
}

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "user-1" })
  })

  it("requires an authenticated session", async () => {
    getSession.mockResolvedValue(null)
    expect((await DELETE(request("DELETE"))).status).toBe(401)
  })

  it("requires a non-empty confirmation string", async () => {
    expect((await DELETE(request(""))).status).toBe(400)
    expect(deleteUserAccount).not.toHaveBeenCalled()
  })

  it("deletes the authenticated account", async () => {
    deleteUserAccount.mockResolvedValue({ workspaceIds: ["ws-1"] })
    expect((await DELETE(request("DELETE"))).status).toBe(200)
    expect(deleteUserAccount).toHaveBeenCalledWith("user-1", "DELETE")
  })

  it("blocks sole owners until ownership is transferred", async () => {
    deleteUserAccount.mockRejectedValue(
      new AccountDeletionBlockedError([
        { id: "ws-1", name: "Security", members: [{ id: "user-2" }] },
      ])
    )
    const response = await DELETE(request("DELETE"))
    expect(response.status).toBe(409)
    const json = (await response.json()) as { error: { code: string; details?: unknown } }
    expect(json.error.code).toBe("OWNERSHIP_TRANSFER_REQUIRED")
    expect(json.error.details).toMatchObject({ blockedWorkspaces: [{ id: "ws-1" }] })
  })

  it("returns the required confirmation when a workspace must be destroyed", async () => {
    deleteUserAccount.mockRejectedValue(
      new AccountDeletionConfirmationRequiredError([{ id: "ws-1", name: "Launch" }], "Launch")
    )
    const response = await DELETE(request("DELETE"))
    expect(response.status).toBe(400)
    const json = (await response.json()) as { error: { code: string; details?: unknown } }
    expect(json.error.code).toBe("CONFIRMATION_REQUIRED")
    expect(json.error.details).toMatchObject({
      deletableWorkspaces: [{ id: "ws-1", name: "Launch" }],
      expectedConfirmation: "Launch",
    })
  })
})
