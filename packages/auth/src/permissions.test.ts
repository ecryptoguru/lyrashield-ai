import { describe, it, expect } from "vitest"
import { PERMISSIONS, hasPermission, getRolePermissions } from "./permissions"

const ALL_ROLES = [
  "OWNER",
  "ADMIN",
  "SECURITY_ADMIN",
  "APPSEC_MANAGER",
  "BILLING_ADMIN",
  "DEVELOPER",
  "MEMBER",
  "EXTERNAL_PENTESTER",
  "AUDITOR",
  "VIEWER",
] as const

describe("affiliate authority is platform-only (no tenant role)", () => {
  it("removes affiliate admin/review entries from the PERMISSIONS map", () => {
    expect("admin" in PERMISSIONS.affiliate).toBe(false)
    expect("review" in PERMISSIONS.affiliate).toBe(false)
    expect("manage" in PERMISSIONS.affiliate).toBe(true)
  })

  it("grants no tenant role affiliate:admin or affiliate:review", () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, "affiliate:admin")).toBe(false)
      expect(hasPermission(role, "affiliate:review")).toBe(false)
    }
  })

  it("keeps affiliate:admin/review out of every role's permission list", () => {
    for (const role of ALL_ROLES) {
      const perms = getRolePermissions(role)
      expect(perms).not.toContain("affiliate:admin")
      expect(perms).not.toContain("affiliate:review")
    }
  })

  it("still lets OWNER self-manage their own affiliate dashboard", () => {
    expect(hasPermission("OWNER", "affiliate:manage")).toBe(true)
  })
})

describe("billing management authority", () => {
  it("allows only owners and billing administrators", () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PERMISSIONS.billing.manage)).toBe(
        role === "OWNER" || role === "BILLING_ADMIN"
      )
    }
  })
})
