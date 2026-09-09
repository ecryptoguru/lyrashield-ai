import { describe, expect, it } from "vitest"
import { resolveOperationPrincipal } from "@lyrashield/db"

describe("operation principal identity (W3-01)", () => {
  it("keeps the connection-bound identity for OAuth connections", () => {
    expect(resolveOperationPrincipal({ connectionId: "conn-1" })).toEqual({
      principalType: "OAUTH_CONNECTION",
      principalId: "conn-1",
      connectionId: "conn-1",
    })
  })

  it("binds API-key principals to the key id without fabricating a connection", () => {
    const identity = resolveOperationPrincipal({ apiKeyId: "key-1" })
    expect(identity.principalType).toBe("API_KEY")
    expect(identity.principalId).toBe("key-1")
    expect(identity.connectionId).toBeUndefined()
  })

  it("binds browser-session principals to the user id", () => {
    expect(resolveOperationPrincipal({ userId: "user-1" })).toEqual({
      principalType: "BROWSER_SESSION",
      principalId: "user-1",
    })
  })

  it("fails closed when no principal is supplied", () => {
    expect(() => resolveOperationPrincipal({})).toThrow("OPERATION_PRINCIPAL_REQUIRED")
  })

  it("prefers the connection identity when several are present", () => {
    expect(
      resolveOperationPrincipal({ connectionId: "conn-1", apiKeyId: "key-1", userId: "user-1" })
    ).toEqual({
      principalType: "OAUTH_CONNECTION",
      principalId: "conn-1",
      connectionId: "conn-1",
    })
  })
})
