import { describe, it, expect, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-key-at-least-32-characters-long" },
}))

import { createInstallState, verifyInstallState } from "./github-install-state"

describe("github install state (S2)", () => {
  it("round-trips a workspace id through sign/verify", () => {
    const state = createInstallState("ws_abc123")
    const result = verifyInstallState(state)
    expect(result).toEqual({ valid: true, workspaceId: "ws_abc123" })
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
    const state = createInstallState("ws_abc123", past)
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
})
