import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const headersMock = vi.fn()
vi.mock("next/headers", () => ({ headers: () => headersMock() }))

const getSessionApi = vi.fn()
vi.mock("./auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionApi(...args) } },
}))

const userFindUnique = vi.fn()
const userUpdate = vi.fn()
const sessionFindUnique = vi.fn()
vi.mock("@lyrashield/db", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUnique(...args),
      update: (...args: unknown[]) => userUpdate(...args),
    },
    session: { findUnique: (...args: unknown[]) => sessionFindUnique(...args) },
  },
  setWorkspaceContext: vi.fn(),
  verifyApiKey: vi.fn(),
}))
vi.mock("./oauth", () => ({ verifyOAuthBearer: vi.fn().mockResolvedValue(null) }))
vi.mock("@lyrashield/config", () => ({
  env: { PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com" },
}))

import {
  isPlatformOperator,
  requirePlatformAdmin,
  requirePlatformAdminCandidateIdentity,
  requirePlatformAdminIdentity,
  requirePlatformOperator,
} from "./session"

afterEach(() => vi.useRealTimers())

function browserHeaders(extra?: Record<string, string>) {
  return new Headers({ cookie: "better-auth.session_token=signed", ...extra })
}

function browserSession(
  email = "ecryptoguru@gmail.com",
  createdAt = new Date("2026-08-20T10:00:00.000Z")
) {
  return {
    user: { id: "user-2", email, emailVerified: true, name: "Admin", image: null },
    session: { id: "sess-1", createdAt },
  }
}

function adminUser(overrides: Record<string, unknown> = {}) {
  return {
    email: "ecryptoguru@gmail.com",
    emailVerified: true,
    platformRole: "PLATFORM_OPERATOR",
    twoFactorEnabled: true,
    ...overrides,
  }
}

describe("platform-admin authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date("2026-08-24T10:15:00.000Z"))
    headersMock.mockResolvedValue(browserHeaders())
    getSessionApi.mockResolvedValue(browserSession())
    userFindUnique.mockResolvedValue(adminUser())
    sessionFindUnique.mockResolvedValue({
      userId: "user-2",
      twoFactorVerifiedAt: new Date("2026-08-24T10:00:00.000Z"),
    })
  })

  it("allows only exact allowlisted, verified PLATFORM_OPERATOR users with TOTP and fresh elevation", async () => {
    const session = await requirePlatformAdmin()

    expect(session.userId).toBe("user-2")
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-2" },
      select: {
        email: true,
        emailVerified: true,
        platformRole: true,
        twoFactorEnabled: true,
      },
    })
    expect(sessionFindUnique).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      select: { userId: true, twoFactorVerifiedAt: true },
    })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it("denies global reads when the current session has no TOTP stamp", async () => {
    sessionFindUnique.mockResolvedValue(null)

    await expect(requirePlatformAdminIdentity()).rejects.toThrow("ADMIN_REAUTH_REQUIRED")
    await expect(requirePlatformAdminCandidateIdentity()).resolves.toMatchObject({
      userId: "user-2",
    })
  })

  it("normalizes email case but rejects aliases, plus-addresses, and unlisted users", async () => {
    userFindUnique.mockResolvedValue(adminUser({ email: " AnKit@LyraShieldAI.com " }))
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ userId: "user-2" })

    for (const email of [
      "ankit+admin@lyrashieldai.com",
      "e.crypto.guru@gmail.com",
      "admin@lyrashieldai.com",
    ]) {
      userFindUnique.mockResolvedValue(adminUser({ email }))
      await expect(requirePlatformAdmin()).rejects.toThrow("FORBIDDEN")
    }
  })

  it("rejects missing verification, platform role, TOTP enrollment, or recent elevation", async () => {
    for (const override of [
      { emailVerified: false },
      { platformRole: null },
      { platformRole: "ADMIN" },
      { twoFactorEnabled: false },
    ]) {
      userFindUnique.mockResolvedValue(adminUser(override))
      await expect(requirePlatformAdmin()).rejects.toThrow("FORBIDDEN")
    }

    userFindUnique.mockResolvedValue(adminUser())
    sessionFindUnique.mockResolvedValue({
      userId: "user-2",
      twoFactorVerifiedAt: new Date("2026-08-24T09:29:59Z"),
    })
    await expect(requirePlatformAdmin()).rejects.toThrow("ADMIN_REAUTH_REQUIRED")

    sessionFindUnique.mockResolvedValue({
      userId: "different-user",
      twoFactorVerifiedAt: new Date("2026-08-24T10:14:00Z"),
    })
    await expect(requirePlatformAdmin()).rejects.toThrow("ADMIN_REAUTH_REQUIRED")
  })

  it("allows callers to shorten but never extend the elevation window", async () => {
    await expect(requirePlatformAdmin({ maxElevationAgeMs: 10 * 60 * 1000 })).rejects.toThrow(
      "ADMIN_REAUTH_REQUIRED"
    )
    await expect(requirePlatformAdmin({ maxElevationAgeMs: 31 * 60 * 1000 })).rejects.toThrow(
      "INVALID_ADMIN_ELEVATION_WINDOW"
    )
  })

  it("rejects API-key, OAuth, device, and other bearer credentials even with a valid cookie", async () => {
    for (const authorization of [
      "Bearer lsk_test",
      "Bearer oauth-token",
      "Bearer device-token",
      "Basic dXNlcjpwYXNz",
    ]) {
      headersMock.mockResolvedValue(browserHeaders({ authorization }))
      await expect(requirePlatformAdmin()).rejects.toThrow("UNAUTHORIZED")
    }
    expect(getSessionApi).not.toHaveBeenCalled()
  })

  it("requires a browser cookie and never auto-promotes an allowlisted account", async () => {
    headersMock.mockResolvedValue(new Headers())
    await expect(requirePlatformAdmin()).rejects.toThrow("UNAUTHORIZED")

    headersMock.mockResolvedValue(browserHeaders())
    userFindUnique.mockResolvedValue(adminUser({ platformRole: null }))
    await expect(requirePlatformAdmin()).rejects.toThrow("FORBIDDEN")
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it("keeps the legacy operator guard on the hardened admin boundary", async () => {
    await expect(requirePlatformOperator()).resolves.toMatchObject({ userId: "user-2" })
  })
})

describe("platform-operator identity lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date("2026-08-24T10:15:00.000Z"))
    headersMock.mockResolvedValue(browserHeaders())
    getSessionApi.mockResolvedValue(browserSession())
    userFindUnique.mockResolvedValue(adminUser())
    sessionFindUnique.mockResolvedValue({
      userId: "user-2",
      twoFactorVerifiedAt: new Date("2026-08-24T10:00:00.000Z"),
    })
  })

  it("is a safe eligibility helper, not a role-only authorization shortcut", async () => {
    expect(await isPlatformOperator("user-2")).toBe(true)
    expect(await isPlatformOperator("different-user")).toBe(false)

    headersMock.mockResolvedValue(browserHeaders({ authorization: "Bearer lsk_test" }))
    expect(await isPlatformOperator("user-2")).toBe(false)
  })
})
