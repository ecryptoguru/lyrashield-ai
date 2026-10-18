import { beforeEach, describe, expect, it, vi } from "vitest"
import { resendSignupVerificationEmail } from "./signup-verification"

const sendVerificationEmail = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/auth", () => ({ authClient: { sendVerificationEmail } }))

describe("signup verification resend", () => {
  beforeEach(() => {
    sendVerificationEmail.mockReset()
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
  })

  it("preserves transport failures for the page's recovery state", async () => {
    sendVerificationEmail.mockRejectedValue(new Error("Offline"))
    await expect(
      resendSignupVerificationEmail("example@example.invalid", "/onboarding")
    ).rejects.toThrow("Offline")
  })
})
