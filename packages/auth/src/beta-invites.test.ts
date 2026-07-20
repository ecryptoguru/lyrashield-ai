import { describe, expect, it } from "vitest"
import { isBetaInviteAllowed, isBetaUserCreationAllowed } from "./beta-invites"

describe("beta invite allowlist", () => {
  it("matches normalized invited addresses and fails closed when unset", () => {
    expect(
      isBetaInviteAllowed(" invited@example.com ", "INVITED@example.com, second@example.com")
    ).toBe(true)
    expect(isBetaInviteAllowed("other@example.com", "invited@example.com")).toBe(false)
    expect(isBetaInviteAllowed("invited@example.com", "")).toBe(false)
  })

  it("allows unrestricted local creation but requires the production invite allowlist", () => {
    expect(isBetaUserCreationAllowed(false, "anyone@example.com", undefined)).toBe(true)
    expect(isBetaUserCreationAllowed(true, "invited@example.com", "INVITED@example.com")).toBe(true)
    expect(isBetaUserCreationAllowed(true, "other@example.com", "invited@example.com")).toBe(false)
    expect(isBetaUserCreationAllowed(true, "invited@example.com", undefined)).toBe(false)
  })
})
