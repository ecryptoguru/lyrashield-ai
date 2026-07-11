import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()
const deleteUserAccount = vi.fn()
class AccountDeletionBlockedError extends Error {
  constructor(public workspaces: Array<{ id: string; name: string }>) {
    super("blocked")
  }
}

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/db", () => ({ deleteUserAccount, AccountDeletionBlockedError }))
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

  it("requires explicit destructive confirmation", async () => {
    expect((await DELETE(request("delete"))).status).toBe(400)
    expect(deleteUserAccount).not.toHaveBeenCalled()
  })

  it("deletes the authenticated account", async () => {
    deleteUserAccount.mockResolvedValue({ workspaceIds: ["ws-1"] })
    expect((await DELETE(request("DELETE"))).status).toBe(200)
    expect(deleteUserAccount).toHaveBeenCalledWith("user-1")
  })

  it("blocks sole owners until ownership is transferred", async () => {
    deleteUserAccount.mockRejectedValue(
      new AccountDeletionBlockedError([{ id: "ws-1", name: "Security" }])
    )
    const response = await DELETE(request("DELETE"))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "OWNERSHIP_TRANSFER_REQUIRED" },
    })
  })
})
