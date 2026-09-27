import { describe, expect, it } from "vitest"
import { hasSyncFindingWriteRole, hasSyncWriteAccess } from "./sync-auth"

const baseSession = {
  userId: "user-1",
  userEmail: "user@example.com",
  userName: "User",
  userImage: null,
  sessionId: "session-1",
}

describe("hasSyncWriteAccess", () => {
  it("requires a write key scoped to the requested workspace", () => {
    expect(
      hasSyncWriteAccess(
        {
          ...baseSession,
          apiKey: { keyId: "key-1", workspaceId: "ws-1", scopes: ["write"], prefix: "lsk" },
        },
        "ws-1"
      )
    ).toBe(true)
    expect(
      hasSyncWriteAccess(
        {
          ...baseSession,
          apiKey: { keyId: "key-1", workspaceId: "ws-2", scopes: ["write"], prefix: "lsk" },
        },
        "ws-1"
      )
    ).toBe(false)
    expect(
      hasSyncWriteAccess(
        {
          ...baseSession,
          apiKey: { keyId: "key-1", workspaceId: "ws-1", scopes: ["read"], prefix: "lsk" },
        },
        "ws-1"
      )
    ).toBe(false)
  })
})

describe("hasSyncFindingWriteRole", () => {
  it.each(["OWNER", "ADMIN", "SECURITY_ADMIN", "APPSEC_MANAGER"] as const)(
    "allows %s to sync findings",
    (role) => {
      expect(hasSyncFindingWriteRole(role)).toBe(true)
    }
  )

  it.each([
    "DEVELOPER",
    "MEMBER",
    "EXTERNAL_PENTESTER",
    "AUDITOR",
    "BILLING_ADMIN",
    "VIEWER",
  ] as const)("denies %s from syncing findings", (role) => {
    expect(hasSyncFindingWriteRole(role)).toBe(false)
  })
})
