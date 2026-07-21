import { describe, expect, it } from "vitest"
import { isBetaInviteAllowed } from "./beta-invites"

describe("beta invite allowlist", () => {
  it("matches normalized invited addresses and fails closed when unset", () => {
    expect(
      isBetaInviteAllowed(" invited@example.com ", "INVITED@example.com, second@example.com")
    ).toBe(true)
    expect(isBetaInviteAllowed("other@example.com", "invited@example.com")).toBe(false)
    expect(isBetaInviteAllowed("invited@example.com", "")).toBe(false)
  })
})
