import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("local mail fixture request logging", () => {
  it("suppresses bearer URL request logs only for an enabled local fixture", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("LYRASHIELD_TEST_AUTH_MAIL_DIR", "/tmp/lyrashield-auth-mail-fixture")
    expect((await import("../../next.config")).default.logging).toEqual({
      incomingRequests: false,
      browserToTerminal: false,
      serverFunctions: false,
    })
  })

  it.each(["production", "development"])(
    "retains normal %s logging without capture",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv)
      vi.stubEnv("LYRASHIELD_TEST_AUTH_MAIL_DIR", "")
      expect((await import("../../next.config")).default.logging).toBeUndefined()
    }
  )
})
