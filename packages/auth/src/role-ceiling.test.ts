import { describe, it, expect } from "vitest"
import { canGrantRole } from "./permissions"

describe("canGrantRole (role-ceiling, S6)", () => {
  it("lets OWNER grant any role, including OWNER and ADMIN", () => {
    expect(canGrantRole("OWNER", "OWNER")).toBe(true)
    expect(canGrantRole("OWNER", "ADMIN")).toBe(true)
    expect(canGrantRole("OWNER", "VIEWER")).toBe(true)
  })

  it("forbids ADMIN from granting an equal or higher role", () => {
    expect(canGrantRole("ADMIN", "ADMIN")).toBe(false) // no peer-cloning
    expect(canGrantRole("ADMIN", "OWNER")).toBe(false) // no escalation
  })

  it("lets ADMIN grant strictly-lower roles", () => {
    expect(canGrantRole("ADMIN", "SECURITY_ADMIN")).toBe(true)
    expect(canGrantRole("ADMIN", "MEMBER")).toBe(true)
    expect(canGrantRole("ADMIN", "VIEWER")).toBe(true)
  })

  it("forbids a lower role from granting a higher one", () => {
    expect(canGrantRole("MEMBER", "ADMIN")).toBe(false)
    expect(canGrantRole("DEVELOPER", "SECURITY_ADMIN")).toBe(false)
    expect(canGrantRole("VIEWER", "MEMBER")).toBe(false)
  })
})
