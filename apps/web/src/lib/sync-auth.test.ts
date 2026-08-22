import { describe, expect, it } from "vitest"
import { hasSyncWriteAccess } from "./sync-auth"

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
