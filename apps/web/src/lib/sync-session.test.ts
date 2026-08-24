import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: { BETTER_AUTH_SECRET: "a".repeat(48) },
}))

import { createSyncSessionToken, verifySyncSessionToken } from "./sync-session"

const session = { userId: "user_1", sessionId: "session_1" }

describe("sync session tokens", () => {
  it("binds a 15-minute token to workspace, user, and session", () => {
    const now = Date.UTC(2026, 7, 24, 12)
    const issued = createSyncSessionToken(
      { workspaceId: "workspace_1", licenseId: "license_1", session },
      now
    )

    expect(issued.expiresAt.getTime()).toBe(now + 15 * 60 * 1000)
    expect(
      verifySyncSessionToken(issued.token, { workspaceId: "workspace_1", session }, now)
    ).toEqual({ valid: true, licenseId: "license_1" })
    expect(
      verifySyncSessionToken(issued.token, { workspaceId: "workspace_2", session }, now)
    ).toEqual({ valid: false, reason: "identity_mismatch" })
    expect(
      verifySyncSessionToken(
        issued.token,
        { workspaceId: "workspace_1", session: { ...session, sessionId: "session_2" } },
        now
      )
    ).toEqual({ valid: false, reason: "identity_mismatch" })
    expect(
      verifySyncSessionToken(issued.token, { workspaceId: "workspace_1", session }, now + 900_000)
    ).toEqual({ valid: false, reason: "expired" })

    const [payload, signature] = issued.token.split(".")
    expect(
      verifySyncSessionToken(
        `${payload}x.${signature}`,
        { workspaceId: "workspace_1", session },
        now
      )
    ).toEqual({ valid: false, reason: "bad_signature" })
  })
})
