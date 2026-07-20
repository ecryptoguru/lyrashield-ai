import { beforeEach, describe, expect, it, vi } from "vitest"

const createAuthClient = vi.fn(() => ({
  getSession: vi.fn(),
  sendVerificationEmail: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn(),
  useSession: vi.fn(),
}))

vi.mock("better-auth/client", () => ({ createAuthClient }))
describe("auth client", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses Better Auth's same-origin endpoint instead of a build-time app URL", async () => {
    await import("./client")

    expect(createAuthClient).toHaveBeenCalledWith()
  })
})
