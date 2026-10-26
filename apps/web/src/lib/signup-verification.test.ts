import { beforeEach, describe, expect, it, vi } from "vitest"
import { resendSignupVerificationEmail } from "./signup-verification"

const { sendVerificationEmail, signOut } = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock("@lyrashield/auth", () => ({ authClient: { sendVerificationEmail, signOut } }))

describe("signup verification resend", () => {
  beforeEach(() => {
    sendVerificationEmail.mockReset()
    signOut.mockReset()
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

  it("does not resend if explicit sign-out fails", async () => {
    const error = { code: "SESSION_ERROR", message: "Try later", status: 500 }
    signOut.mockResolvedValue({ data: null, error })
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null })
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding", true)
    ).rejects.toBe(error)
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it("does not resend when sign-out has a transport failure", async () => {
    signOut.mockRejectedValue(new Error("Offline"))
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding", true)
    ).rejects.toThrow("Offline")
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it("preserves transport failures for the page's recovery state", async () => {
    sendVerificationEmail.mockRejectedValue(new Error("Offline"))
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding")
    ).rejects.toThrow("Offline")
  })
})
