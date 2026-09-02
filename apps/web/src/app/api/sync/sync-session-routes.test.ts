import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  workspaceMemberFindUnique: vi.fn(),
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
vi.mock("@lyrashield/auth/server", () => ({ requireAuth: mocks.requireAuth }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {
    license: { update: mocks.licenseUpdate },
    workspaceMember: { findUnique: mocks.workspaceMemberFindUnique },
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
    mocks.workspaceMemberFindUnique.mockResolvedValue({ status: "active" })
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
    expect(mocks.findLicenseById).toHaveBeenCalledWith("license_1")
    expect(mocks.findLicenseByKeyHash).not.toHaveBeenCalled()
  })

  it("refuses license transfer without active membership in its owning workspace", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({
      license: { ...license, workspaceId: "other_workspace" },
    })
    mocks.workspaceMemberFindUnique
      .mockResolvedValueOnce({ status: "active" })
      .mockResolvedValueOnce(null)
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

  it("transfers through the system client after both workspace memberships pass", async () => {
    mocks.findLicenseByKeyHash.mockResolvedValue({
      license: { ...license, workspaceId: "other_workspace" },
    })
    const response = await connect(
      new Request("http://localhost/api/sync/connect", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_1", licenseKey: "raw-license-key" }),
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.workspaceMemberFindUnique).toHaveBeenNthCalledWith(2, {
      where: { workspaceId_userId: { workspaceId: "other_workspace", userId: session.userId } },
    })
    expect(mocks.systemLicenseUpdate).toHaveBeenCalledWith({
      where: { id: license.id },
      data: { workspaceId: "workspace_1" },
    })
    expect(mocks.licenseUpdate).not.toHaveBeenCalled()
  })
})
