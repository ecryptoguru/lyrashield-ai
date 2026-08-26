import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()
const deleteUserAccount = vi.fn()
const drainArtifactDeletionTasks = vi.fn()
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
class AccountDeletionActiveScanError extends Error {
  constructor(public workspaces: Array<{ id: string; name: string }>) {
    super("active scans")
  }
}
class AccountDeletionUnsupportedArtifactError extends Error {
  constructor(public workspaces: Array<{ id: string; name: string }>) {
    super("unsupported artifact")
  }
}

vi.mock("@lyrashield/auth/server", () => ({ getSession }))
vi.mock("@lyrashield/db", () => ({
  deleteUserAccount,
  AccountDeletionBlockedError,
  AccountDeletionConfirmationRequiredError,
  AccountDeletionActiveScanError,
  AccountDeletionUnsupportedArtifactError,
}))
vi.mock("@lyrashield/evidence-storage", () => ({ drainArtifactDeletionTasks }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

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
    drainArtifactDeletionTasks.mockResolvedValue({
      claimed: 0,
      deleted: 0,
      retrying: 0,
      deadLettered: 0,
    })
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
    deleteUserAccount.mockResolvedValue({
      workspaceIds: ["ws-1"],
      artifactDeletionTaskIds: ["task-1"],
    })
    expect((await DELETE(request("DELETE"))).status).toBe(200)
    expect(deleteUserAccount).toHaveBeenCalledWith("user-1", "DELETE")
    expect(drainArtifactDeletionTasks).toHaveBeenCalledWith({
      taskIds: ["task-1"],
      limit: 1,
    })
  })

  it("returns success when eager cleanup fails after durable account deletion", async () => {
    deleteUserAccount.mockResolvedValue({
      workspaceIds: [],
      artifactDeletionTaskIds: ["task-1"],
    })
    drainArtifactDeletionTasks.mockRejectedValue(new Error("system database unavailable"))

    expect((await DELETE(request("DELETE"))).status).toBe(200)
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

  it("blocks deletion while a workspace has active scans", async () => {
    deleteUserAccount.mockRejectedValue(
      new AccountDeletionActiveScanError([{ id: "ws-1", name: "Launch" }])
    )
    const response = await DELETE(request("DELETE"))
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ACTIVE_SCANS")
  })

  it("blocks deletion for legacy external artifact contracts", async () => {
    deleteUserAccount.mockRejectedValue(
      new AccountDeletionUnsupportedArtifactError([{ id: "ws-1", name: "Legacy" }])
    )
    const response = await DELETE(request("DELETE"))
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_EXTERNAL_ARTIFACT"
    )
  })
})
