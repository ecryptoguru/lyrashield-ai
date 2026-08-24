import { beforeEach, describe, expect, it, vi } from "vitest"

const createAuthClient = vi.fn(() => ({
  getSession: vi.fn(),
  sendVerificationEmail: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn(),
  useSession: vi.fn(),
}))
const twoFactorClient = vi.fn((options) => ({ id: "two-factor", options }))

vi.mock("better-auth/client", () => ({ createAuthClient }))
vi.mock("better-auth/client/plugins", () => ({
  inferAdditionalFields: vi.fn(() => ({ id: "fields" })),
  twoFactorClient,
  deviceAuthorizationClient: vi.fn(() => ({ id: "device" })),
}))
describe("auth client", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses Better Auth's same-origin endpoint instead of a build-time app URL", async () => {
    await import("./client")

    expect(createAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: expect.any(Array) })
    )
    expect(twoFactorClient).toHaveBeenCalledWith({ twoFactorPage: "/two-factor" })
  })

  it("accepts only local callback paths", async () => {
    const { safeAuthCallbackPath } = await import("./client")

    expect(safeAuthCallbackPath("/oauth/consent?client_id=one")).toBe(
      "/oauth/consent?client_id=one"
    )
    expect(safeAuthCallbackPath("//evil.example/steal")).toBe("/dashboard")
    expect(safeAuthCallbackPath("https://evil.example/steal")).toBe("/dashboard")
    for (const unsafe of [
      "/\\evil.example/steal",
      "/%5cevil.example/steal",
      "/%2fevil.example/steal",
      "/\\/evil.example/steal",
      "/safe\u0000/evil",
      "/%0Aevil.example/steal",
      "/%2e%2e//evil.example/steal",
      "/foo/..//evil.example/steal",
      "/.//evil.example/steal",
    ]) {
      expect(safeAuthCallbackPath(unsafe)).toBe("/dashboard")
    }
    expect(safeAuthCallbackPath("/oauth/consent?client_id=one&scope=read#confirm")).toBe(
      "/oauth/consent?client_id=one&scope=read#confirm"
    )
  })
})
