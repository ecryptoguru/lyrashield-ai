import { beforeEach, describe, expect, it, vi } from "vitest"

const headersMock = vi.fn()
vi.mock("next/headers", () => ({ headers: () => headersMock() }))

const getSessionApi = vi.fn()
vi.mock("./auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionApi(...args) } },
}))

const userFindUnique = vi.fn()
vi.mock("@lyrashield/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUnique(...args) },
  },
  setWorkspaceContext: vi.fn(),
  verifyApiKey: vi.fn(),
}))
vi.mock("./oauth", () => ({ verifyOAuthBearer: vi.fn().mockResolvedValue(null) }))

import { isPlatformOperator, requirePlatformOperator } from "./session"

describe("platform-operator identity (independent of tenant roles)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userFindUnique.mockResolvedValue(null)
    headersMock.mockResolvedValue({ get: () => null })
  })

  it("allows only the exact PLATFORM_OPERATOR value", async () => {
    userFindUnique.mockResolvedValue({ platformRole: "PLATFORM_OPERATOR" })
    expect(await isPlatformOperator("user-1")).toBe(true)

    for (const role of ["PLATFORM_operator", " platform_operator", "ADMIN", "", null]) {
      userFindUnique.mockResolvedValue(role === null ? null : { platformRole: role })
      expect(await isPlatformOperator("user-1")).toBe(false)
    }
  })

  it("looks up User.platformRole directly, never workspace membership", async () => {
    userFindUnique.mockResolvedValue({ platformRole: "PLATFORM_OPERATOR" })
    await isPlatformOperator("user-9")
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-9" },
      select: { platformRole: true },
    })
  })

  it("throws UNAUTHORIZED without a session and FORBIDDEN otherwise", async () => {
    getSessionApi.mockResolvedValue(null)
    await expect(requirePlatformOperator()).rejects.toThrow("UNAUTHORIZED")

    getSessionApi.mockResolvedValue({
      user: { id: "user-2", email: "a@b.c", name: "A", image: null },
      session: { id: "sess-1" },
    })
    headersMock.mockResolvedValue({ get: () => null })

    userFindUnique.mockResolvedValue({ platformRole: null })
    await expect(requirePlatformOperator()).rejects.toThrow("FORBIDDEN")

    // OWNER-tier tenant role does not help — authority comes only from
    // User.platformRole.
    userFindUnique.mockResolvedValue({ platformRole: "SOMETHING_ELSE" })
    await expect(requirePlatformOperator()).rejects.toThrow("FORBIDDEN")

    userFindUnique.mockResolvedValue({ platformRole: "PLATFORM_OPERATOR" })
    const session = await requirePlatformOperator()
    expect(session.userId).toBe("user-2")
  })
})
