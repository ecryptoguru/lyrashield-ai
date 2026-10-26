import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resendSignupVerificationEmail, signupVerificationErrorStatus } from "./signup-verification"

const { sendVerificationEmail, signOut, invalidateAnalyticsPreference } = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  signOut: vi.fn(),
  invalidateAnalyticsPreference: vi.fn(),
}))
vi.mock("@lyrashield/auth", () => ({ authClient: { sendVerificationEmail, signOut } }))
vi.mock("@/lib/analytics", () => ({ invalidateAnalyticsPreference }))

afterEach(() => vi.unstubAllGlobals())

describe("signup verification resend", () => {
  beforeEach(() => {
    sendVerificationEmail.mockReset()
    signOut.mockReset()
    invalidateAnalyticsPreference.mockReset()
  })

  it("rejects a returned API error instead of confirming delivery", async () => {
    const error = { code: "RATE_LIMITED", message: "Try later", status: 429 }
    sendVerificationEmail.mockResolvedValue({ data: null, error })
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding?plan=PRO")
    ).rejects.toBe(error)
  })

  it("confirms only a successful request and preserves the intended destination", async () => {
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null })
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding?plan=PRO")
    ).resolves.toBeUndefined()
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "example@example.invalid",
      callbackURL: "/onboarding?plan=PRO",
    })
    expect(signOut).not.toHaveBeenCalled()
  })

  it("only signs out after explicit recovery and before requesting verification", async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null })
    sendVerificationEmail.mockImplementation(async () => {
      expect(signOut).toHaveBeenCalledOnce()
      return { data: { status: true }, error: null }
    })
    await resendSignupVerificationEmail("example@example.invalid", "/onboarding?plan=PRO", true)
    expect(sendVerificationEmail).toHaveBeenCalledWith({
      email: "example@example.invalid",
      callbackURL: "/onboarding?plan=PRO",
    })
  })

  it("clears the previous account's finding snapshots before resending", async () => {
    const stored = new Map([
      ["lyrashield:findings-list:previous-account", "private snapshot"],
      ["unrelated-preference", "keep"],
    ])
    vi.stubGlobal("window", {
      sessionStorage: {
        get length() {
          return stored.size
        },
        key: (index: number) => [...stored.keys()][index] ?? null,
        removeItem: (key: string) => stored.delete(key),
      },
    })
    signOut.mockResolvedValue({ data: { success: true }, error: null })
    sendVerificationEmail.mockImplementation(async () => {
      expect(stored.has("lyrashield:findings-list:previous-account")).toBe(false)
      expect(stored.get("unrelated-preference")).toBe("keep")
      expect(invalidateAnalyticsPreference).toHaveBeenCalledOnce()
      return { data: { status: true }, error: null }
    })
    await resendSignupVerificationEmail("example@example.invalid", "/onboarding", true)
  })

  it("does not resend if explicit sign-out fails", async () => {
    const error = { code: "SESSION_ERROR", message: "Try later", status: 500 }
    signOut.mockResolvedValue({ data: null, error })
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null })
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding", true)
    ).rejects.toBe(error)
    expect(sendVerificationEmail).not.toHaveBeenCalled()
    expect(invalidateAnalyticsPreference).not.toHaveBeenCalled()
  })

  it("does not resend when sign-out has a transport failure", async () => {
    signOut.mockRejectedValue(new Error("Offline"))
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding", true)
    ).rejects.toThrow("Offline")
    expect(sendVerificationEmail).not.toHaveBeenCalled()
    expect(invalidateAnalyticsPreference).not.toHaveBeenCalled()
  })

  it("preserves transport failures for the page's recovery state", async () => {
    sendVerificationEmail.mockRejectedValue(new Error("Offline"))
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding")
    ).rejects.toThrow("Offline")
  })
})

describe("signup verification recovery", () => {
  it.each([
    [{ code: "EMAIL_MISMATCH" }, "email-mismatch"],
    [{ code: "EMAIL_ALREADY_VERIFIED" }, "already-verified"],
    [{ code: "RATE_LIMITED" }, "error"],
    [null, "error"],
    [new Error("Offline"), "error"],
  ])("maps %j to the appropriate recovery state", (error, expected) => {
    expect(signupVerificationErrorStatus(error)).toBe(expected)
  })
})
