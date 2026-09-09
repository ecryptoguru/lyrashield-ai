import { describe, it, expect, vi } from "vitest"
import { createHmac } from "crypto"

vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-key-at-least-32-characters-long" },
}))

import { createInstallState, verifyInstallState } from "./github-install-state"

describe("github install state (S2)", () => {
  it("round-trips a workspace id through sign/verify", () => {
    const state = createInstallState("ws_abc123")
    const result = verifyInstallState(state)
    expect(result).toEqual({ valid: true, workspaceId: "ws_abc123", returnTo: "integrations" })
  })

  it("round-trips an allowlisted onboarding return destination", () => {
    const state = createInstallState("ws_abc123", "onboarding")
    expect(verifyInstallState(state)).toEqual({
      valid: true,
      workspaceId: "ws_abc123",
      returnTo: "onboarding",
    })
  })

  it("accepts an unexpired legacy state during a mixed-version rollout", () => {
    const workspace = Buffer.from("ws_abc123").toString("base64url")
    const payload = `${workspace}.legacy-nonce.${Date.now() + 60_000}`
    const signature = createHmac("sha256", "test-secret-key-at-least-32-characters-long")
      .update(payload)
      .digest("base64url")
    expect(verifyInstallState(`${payload}.${signature}`)).toEqual({
      valid: true,
      workspaceId: "ws_abc123",
      returnTo: "integrations",
    })
  })

  it("rejects a tampered workspace id (signature mismatch)", () => {
    const state = createInstallState("ws_abc123")
    // Swap the first segment (base64url workspaceId) for a different workspace.
    const parts = state.split(".")
    parts[0] = Buffer.from("ws_attacker").toString("base64url")
    const forged = parts.join(".")
    const result = verifyInstallState(forged)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toBe("bad_signature")
  })

  it("rejects an expired token", () => {
    const past = Date.now() - 60 * 60 * 1000 // signed an hour ago
    const state = createInstallState("ws_abc123", "integrations", past)
    const result = verifyInstallState(state)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toBe("expired")
  })

  it("rejects a malformed token", () => {
    expect(verifyInstallState("not-a-valid-token").valid).toBe(false)
    expect(verifyInstallState("a.b.c").valid).toBe(false)
  })

  it("rejects a raw workspaceId used as state (the old, vulnerable format)", () => {
    // Pre-fix callers passed state=<workspaceId> directly; that must no longer verify.
    const result = verifyInstallState("ws_abc123")
    expect(result.valid).toBe(false)
  })

  it("rejects a disallowed return destination", () => {
    const state = createInstallState("ws_abc123", "onboarding")
    const parts = state.split(".")
    parts[1] = "attacker"
    const result = verifyInstallState(parts.join("."))
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toBe("malformed")
  })
})

it("retains each signed OAuth return independently across an install round trip", () => {
  const first = createInstallState("ws", "onboarding", 1000, "first-signed-return")
  const second = createInstallState("ws", "onboarding", 1000, "second-signed-return")
  expect(verifyInstallState(first, 1001)).toMatchObject({
    valid: true,
    oauthReturnState: "first-signed-return",
  })
  expect(verifyInstallState(second, 1001)).toMatchObject({
    valid: true,
    oauthReturnState: "second-signed-return",
  })
  expect(verifyInstallState(first, 1000000).valid).toBe(false)
})
