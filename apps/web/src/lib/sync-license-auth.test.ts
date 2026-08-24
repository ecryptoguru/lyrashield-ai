import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByKeyHash: vi.fn(),
  findWorkspace: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "a".repeat(48) },
}))
vi.mock("@lyrashield/db", () => ({
  findLicenseForSyncById: mocks.findById,
  findLicenseForSyncByKeyHash: mocks.findByKeyHash,
  prisma: { workspace: { findUnique: mocks.findWorkspace } },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: mocks.warn } }))
vi.mock("./licenses/license-service", () => ({ hashLicenseKey: () => "key_hash" }))

import { markLegacySyncResponse, resolveSyncCredential } from "./sync-license-auth"
import { createSyncSessionToken } from "./sync-session"

const session = { userId: "user_1", sessionId: "apikey:key_1" }

describe("sync license authorization", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rechecks token license revocation and workspace binding", async () => {
    const { token } = createSyncSessionToken({
      workspaceId: "workspace_1",
      licenseId: "license_1",
      session,
    })
    mocks.findById.mockResolvedValueOnce({
      id: "license_1",
      workspaceId: "workspace_1",
      sku: "sync_addon",
      revoked: true,
    })
    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session, syncSessionToken: token })
    ).resolves.toMatchObject({ ok: false, code: "LICENSE_REVOKED" })

    mocks.findById.mockResolvedValueOnce({
      id: "license_1",
      workspaceId: "workspace_2",
      sku: "sync_addon",
      revoked: false,
    })
    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session, syncSessionToken: token })
    ).resolves.toMatchObject({ ok: false, code: "LICENSE_WORKSPACE_MISMATCH" })
  })

  it("keeps raw license fallback for one release and emits a warning", async () => {
    mocks.findByKeyHash.mockResolvedValue({
      license: {
        id: "license_1",
        workspaceId: "workspace_1",
        sku: "sync_addon",
        revoked: false,
      },
    })

    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session, licenseKey: "legacy-key" })
    ).resolves.toMatchObject({ ok: true, legacyLicenseKey: true })
    expect(mocks.warn).toHaveBeenCalledOnce()

    const response = markLegacySyncResponse(new Response(), true)
    expect(response.headers.get("Deprecation")).toBe("true")
    expect(response.headers.get("Sunset")).toBe("Thu, 01 Oct 2026 00:00:00 GMT")
    expect(response.headers.get("Warning")).toContain("Raw license keys for sync are deprecated")
  })

  it("rechecks current Cloud entitlement for legacy and session credentials", async () => {
    const license = {
      id: "license_1",
      workspaceId: "workspace_1",
      sku: "individual_launch",
      revoked: false,
    }
    mocks.findWorkspace.mockResolvedValue({ plan: "FREE" })
    mocks.findByKeyHash.mockResolvedValue({ license })
    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session, licenseKey: "legacy-key" })
    ).resolves.toMatchObject({ ok: false, code: "SYNC_NOT_ENTITLED" })

    const { token } = createSyncSessionToken({
      workspaceId: "workspace_1",
      licenseId: "license_1",
      session,
    })
    mocks.findById.mockResolvedValue(license)
    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session, syncSessionToken: token })
    ).resolves.toMatchObject({ ok: false, code: "SYNC_NOT_ENTITLED" })
  })

  it("rejects missing or invalid session credentials without raw-key fallback", async () => {
    await expect(
      resolveSyncCredential({ workspaceId: "workspace_1", session })
    ).resolves.toMatchObject({ ok: false, code: "SYNC_CREDENTIAL_REQUIRED" })
    await expect(
      resolveSyncCredential({
        workspaceId: "workspace_1",
        session,
        syncSessionToken: "tampered.token",
        licenseKey: "legacy-key",
      })
    ).resolves.toMatchObject({ ok: false, code: "SYNC_SESSION_INVALID" })
    expect(mocks.findByKeyHash).not.toHaveBeenCalled()
  })

  it("fails closed after the one-release compatibility sunset", async () => {
    await expect(
      resolveSyncCredential({
        workspaceId: "workspace_1",
        session,
        licenseKey: "legacy-key",
        now: Date.parse("2026-10-01T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({ ok: false, code: "SYNC_CREDENTIAL_REQUIRED" })
    expect(mocks.findByKeyHash).not.toHaveBeenCalled()
  })
})
