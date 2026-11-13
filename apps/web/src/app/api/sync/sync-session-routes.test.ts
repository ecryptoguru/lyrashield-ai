import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(),
  licenseUpdate: vi.fn(),
  systemLicenseUpdate: vi.fn(),
  syncCursorFindUnique: vi.fn(),
  syncCursorUpdate: vi.fn(),
  findLicenseById: vi.fn(),
  findLicenseByKeyHash: vi.fn(),
}))

vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "a".repeat(48) },
}))
vi.mock("@lyrashield/auth/server", () => ({
  requireAuth: mocks.requireAuth,
  requirePermission: mocks.requirePermission,
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    license: { update: mocks.licenseUpdate },
    workspace: { findUnique: vi.fn() },
  },
  getSystemPrisma: () => ({ license: { update: mocks.systemLicenseUpdate } }),
  findLicenseForSyncById: mocks.findLicenseById,
  findLicenseForSyncByKeyHash: mocks.findLicenseByKeyHash,
  withWorkspaceRLS: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
    callback({
      syncCursor: {
        findUnique: mocks.syncCursorFindUnique,
        update: mocks.syncCursorUpdate,
      },
    })
  ),
}))
vi.mock("../../../lib/licenses/license-service", () => ({ hashLicenseKey: () => "key_hash" }))

import { POST as connect } from "./connect/route"
import { PUT as cursor } from "./cursor/route"
import { createSyncSessionToken, verifySyncSessionToken } from "../../../lib/sync-session"

const session = {
  userId: "user_1",
  userEmail: "dev@example.com",
  userName: "Dev",
  userImage: null,
  sessionId: "apikey:key_1",
  apiKey: {
    keyId: "key_1",
    workspaceId: "workspace_1",
    scopes: ["write"],
    prefix: "lsk_test",
  },
}
const license = {
  id: "license_1",
  workspaceId: "workspace_1",
  sku: "sync_addon",
  revoked: false,
}
const cursorRow = {
  id: "cursor_1",
  seq: BigInt(3),
  lastSyncedAt: new Date("2026-08-24T12:00:00Z"),
  lastSyncedFindingId: "finding_3",
}

describe("sync session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(session)
    mocks.requirePermission.mockResolvedValue({ workspace: { role: "OWNER" } })
    mocks.findLicenseByKeyHash.mockResolvedValue({ license })
    mocks.syncCursorFindUnique.mockResolvedValue(cursorRow)
    mocks.syncCursorUpdate.mockResolvedValue(cursorRow)
  })

  it("returns a session-bound token from connect without returning the raw license", async () => {
    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).not.toHaveProperty("licenseKey")
    expect(body.data.syncSessionExpiresAt).toBeTruthy()
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_1", "finding:update")
    expect(
      verifySyncSessionToken(body.data.syncSessionToken, {
        workspaceId: "workspace_1",
        session,
      })
    ).toEqual({ valid: true, licenseId: "license_1" })
  })

  it("links an unbound license through the system client", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({ license: { ...license, workspaceId: null } })
    mocks.systemLicenseUpdate.mockResolvedValue({ ...license, workspaceId: "workspace_1" })

    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_1", "finding:update")
    expect(mocks.systemLicenseUpdate).toHaveBeenCalledWith({
      where: { id: "license_1" },
      data: { workspaceId: "workspace_1" },
    })
    expect(mocks.licenseUpdate).not.toHaveBeenCalled()
  })

  it("accepts the short-lived token on cursor reads and rechecks the license by id", async () => {
    const { token } = createSyncSessionToken({
      workspaceId: "workspace_1",
      licenseId: "license_1",
      session,
    })
    mocks.findLicenseById.mockResolvedValue(license)

    const response = await cursor(
      new Request("http://localhost/api/sync/cursor", {
        method: "PUT",
        body: JSON.stringify({ workspaceId: "workspace_1", syncSessionToken: token }),
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_1", "finding:update")
    expect(mocks.findLicenseById).toHaveBeenCalledWith("license_1")
    expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
  })

  it("refuses license transfer without write permission in its owning workspace", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({
      license: { ...license, workspaceId: "other_workspace" },
    })
    mocks.requirePermission.mockResolvedValueOnce({ workspace: { role: "OWNER" } })
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))
    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe("LICENSE_ALREADY_LINKED")
    expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
    expect(mocks.licenseUpdate).not.toHaveBeenCalled()
    expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
  })

  it("transfers through the system client after both workspace write permissions pass", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({
      license: { ...license, workspaceId: "other_workspace" },
    })
    mocks.requirePermission.mockResolvedValueOnce({ workspace: { role: "OWNER" } })
    mocks.requirePermission.mockResolvedValueOnce({ workspace: { role: "OWNER" } })
    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenNthCalledWith(2, "other_workspace", "finding:update")
    expect(mocks.systemLicenseUpdate).toHaveBeenCalledWith({
      where: { id: license.id },
      data: { workspaceId: "workspace_1" },
    })
    expect(mocks.licenseUpdate).not.toHaveBeenCalled()
  })

  it("rejects transfer by a destination writer who is only a viewer in the owning workspace", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({
      license: { ...license, workspaceId: "other_workspace" },
    })
    mocks.requirePermission.mockResolvedValueOnce({ workspace: { role: "OWNER" } })
    mocks.requirePermission.mockResolvedValueOnce({ workspace: { role: "VIEWER" } })

    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )

    expect(response.status).toBe(403)
    expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
    expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ["connect", connect, "http://localhost/api/sync/connect", { licenseKey: "raw-license-key" }],
    ["cursor", cursor, "http://localhost/api/sync/cursor", { syncSessionToken: "session-token" }],
  ] as const)(
    "denies a Viewer on sync %s before writing",
    async (_name, route, url, credential) => {
      mocks.requirePermission.mockResolvedValue({ workspace: { role: "VIEWER" } })
      const response = await route(
        new Request(url, {
          method: _name === "connect" ? "POST" : "PUT",
          body: JSON.stringify({ workspaceId: "workspace_1", ...credential }),
        })
      )

      expect(response.status).toBe(403)
      expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_1", "finding:update")
      expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
      expect(mocks.findLicenseById).not.toHaveBeenCalled()
      expect(mocks.syncCursorFindUnique).not.toHaveBeenCalled()
      expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
      expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      "suspended member",
      "connect",
      connect,
      "http://localhost/api/sync/connect",
      { licenseKey: "raw-license-key" },
    ],
    [
      "suspended member",
      "cursor",
      cursor,
      "http://localhost/api/sync/cursor",
      { syncSessionToken: "session-token" },
    ],
  ] as const)(
    "denies a %s on sync %s before writes",
    async (_membershipState, _name, route, url, credential) => {
      mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
      const response = await route(
        new Request(url, {
          method: _name === "connect" ? "POST" : "PUT",
          body: JSON.stringify({ workspaceId: "workspace_1", ...credential }),
        })
      )

      expect(response.status).toBe(403)
      expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_1", "finding:update")
      expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
      expect(mocks.findLicenseById).not.toHaveBeenCalled()
      expect(mocks.syncCursorFindUnique).not.toHaveBeenCalled()
      expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
      expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["connect", connect, "http://localhost/api/sync/connect", { licenseKey: "raw-license-key" }],
    ["cursor", cursor, "http://localhost/api/sync/cursor", { syncSessionToken: "session-token" }],
  ] as const)(
    "rejects %s for an API key scoped to a different workspace before authorization or writes",
    async (_name, route, url, credential) => {
      const response = await route(
        new Request(url, {
          method: _name === "connect" ? "POST" : "PUT",
          body: JSON.stringify({ workspaceId: "workspace_2", ...credential }),
        })
      )

      expect(response.status).toBe(403)
      expect(mocks.requirePermission).not.toHaveBeenCalled()
      expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
      expect(mocks.findLicenseById).not.toHaveBeenCalled()
      expect(mocks.syncCursorFindUnique).not.toHaveBeenCalled()
      expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
      expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["connect", connect, "http://localhost/api/sync/connect", { licenseKey: "raw-license-key" }],
    ["cursor", cursor, "http://localhost/api/sync/cursor", { syncSessionToken: "session-token" }],
  ] as const)(
    "authorizes the requested destination workspace for sync %s before writes",
    async (_name, route, url, credential) => {
      const cookieSession = { ...session, apiKey: undefined }
      mocks.requireAuth.mockResolvedValue(cookieSession)
      mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

      const response = await route(
        new Request(url, {
          method: _name === "connect" ? "POST" : "PUT",
          body: JSON.stringify({ workspaceId: "workspace_2", ...credential }),
        })
      )

      expect(response.status).toBe(403)
      expect(mocks.requirePermission).toHaveBeenCalledWith("workspace_2", "finding:update")
      expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
      expect(mocks.findLicenseById).not.toHaveBeenCalled()
      expect(mocks.syncCursorFindUnique).not.toHaveBeenCalled()
      expect(mocks.systemLicenseUpdate).not.toHaveBeenCalled()
      expect(mocks.syncCursorUpdate).not.toHaveBeenCalled()
    }
  )
})
