import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_OPERATOR_ENABLED: "0",
  MYRA_WRITES_ENABLED: "1",
  MYRA_ALLOWED_EMAILS: "ankit@lyrashieldai.com",
}))

vi.mock("@lyrashield/config", () => ({
  env,
  isMyraAllowedEmail: (email: string, allowlist: string) =>
    allowlist.split(",").includes(email.trim().toLowerCase()),
}))

const { myraPrincipalEnabled, myraWritesEnabled } = await import("./_lib")

describe("Myra account rollout gate", () => {
  beforeEach(() => {
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
  })

  it("admits only the verified allowlisted user", () => {
    const ankit = {
      kind: "user" as const,
      accountId: "account-1",
      sessionId: "session-1",
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    expect(myraPrincipalEnabled(ankit)).toBe(true)
    expect(myraWritesEnabled(ankit)).toBe(true)
    expect(myraPrincipalEnabled({ ...ankit, email: "other@example.com" })).toBe(false)
    expect(myraWritesEnabled({ ...ankit, emailVerified: false })).toBe(false)
    expect(myraWritesEnabled()).toBe(false)
  })
})
