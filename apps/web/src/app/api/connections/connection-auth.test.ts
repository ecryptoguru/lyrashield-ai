import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermission = vi.fn()
const getAgentConnection = vi.fn()

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}))
vi.mock("@lyrashield/db", () => ({
  getAgentConnection: (...args: unknown[]) => getAgentConnection(...args),
}))

import { requireBrowserConnectionManager } from "./connection-auth"

describe("connection management authorization", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects OAuth credentials, including read-only credentials", async () => {
    requirePermission.mockResolvedValue({
      session: { userId: "user-1", oauth: { scopes: ["lyrashield.read"] } },
      workspace: { role: "ADMIN" },
    })
    await expect(requireBrowserConnectionManager("ws-1")).rejects.toThrow("FORBIDDEN")
  })

  it("prevents a developer from revoking another user's connection", async () => {
    requirePermission.mockResolvedValue({
      session: { userId: "user-1" },
      workspace: { role: "DEVELOPER" },
    })
    getAgentConnection.mockResolvedValue({ id: "conn-1", userId: "user-2" })
    await expect(requireBrowserConnectionManager("ws-1", "conn-1")).rejects.toThrow("FORBIDDEN")
  })

  it("allows an administrator to manage another user's connection", async () => {
    requirePermission.mockResolvedValue({
      session: { userId: "admin-1" },
      workspace: { role: "ADMIN" },
    })
    getAgentConnection.mockResolvedValue({ id: "conn-1", userId: "user-2" })
    await expect(requireBrowserConnectionManager("ws-1", "conn-1")).resolves.toMatchObject({
      connection: { id: "conn-1" },
    })
  })
})
