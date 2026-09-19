import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  MYRA_DASHBOARD_ENABLED: "1",
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_OPERATOR_ENABLED: "0",
  MYRA_WRITES_ENABLED: "1",
  MYRA_ALLOWED_EMAILS: "ankit@lyrashieldai.com",
  MYRA_PUBLIC_BOOKING_ENABLED: "0",
}))

vi.mock("@lyrashield/config", () => ({
  env,
  isMyraAllowedEmail: (email: string, allowlist: string) =>
    allowlist.split(",").includes(email.trim().toLowerCase()),
  myraDashboardAllowed: (input: { email: string; emailVerified: boolean; allowlist: string }) =>
    input.emailVerified && input.allowlist.split(",").includes(input.email.trim().toLowerCase()),
}))

const { myraPrincipalEnabled, myraWritesEnabled } = await import("./_lib")

describe("Myra account rollout gate", () => {
  beforeEach(() => {
    env.MYRA_DASHBOARD_ENABLED = "1"
    env.MYRA_WRITES_ENABLED = "1"
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    env.MYRA_PUBLIC_BOOKING_ENABLED = "0"
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

  it("denies every write while MYRA_WRITES_ENABLED is off", () => {
    env.MYRA_WRITES_ENABLED = "0"
    const ankit = {
      kind: "user" as const,
      accountId: "account-1",
      sessionId: "session-1",
      email: "ankit@lyrashieldai.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    expect(myraWritesEnabled(ankit)).toBe(false)
    expect(myraWritesEnabled(anonymous)).toBe(false)
  })

  it("denies anonymous writes while an allowlist is set", () => {
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    expect(myraWritesEnabled(anonymous)).toBe(false)
    expect(myraWritesEnabled(anonymous, "book_demo")).toBe(false)
  })

  it("admits an anonymous principal only for public-booking operations when the flag is on", () => {
    env.MYRA_ALLOWED_EMAILS = "ankit@lyrashieldai.com"
    env.MYRA_PUBLIC_BOOKING_ENABLED = "1"
    const anonymous = { kind: "anonymous" as const, publicSessionId: "ps-1" }
    // Coarse route check (operation unknown until the proposal loads) and the
    // operation-specific checks agree on the booking pair.
    expect(myraWritesEnabled(anonymous)).toBe(true)
    expect(myraWritesEnabled(anonymous, "book_demo")).toBe(true)
    expect(myraWritesEnabled(anonymous, "manage_own_demo")).toBe(true)
    // Every other operation keeps the deny — case replies and support cases
    // never go public under the booking flag.
    expect(myraWritesEnabled(anonymous, "send_case_reply")).toBe(false)
    expect(myraWritesEnabled(anonymous, "submit_support_case")).toBe(false)
  })

  it("admits user writes when the allowlist is empty outside production", () => {
    env.MYRA_ALLOWED_EMAILS = ""
    const dev = {
      kind: "user" as const,
      accountId: "account-2",
      sessionId: "session-2",
      email: "dev@example.com",
      emailVerified: true,
      workspaceId: null,
      role: null,
    }
    expect(myraWritesEnabled(dev)).toBe(true)
    // The dashboard gate stays closed without an allowlist entry regardless.
    expect(myraPrincipalEnabled(dev)).toBe(false)
  })
})
