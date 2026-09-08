import { describe, it, expect } from "vitest"
import {
  PERMISSIONS,
  hasPermission,
  getRolePermissions,
  OPERATIONAL_PERMISSIONS,
} from "./permissions"

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

describe("automatic operational access for every member role", () => {
  it.each(ALL_ROLES)("grants %s the complete operational set consistently", (role) => {
    for (const permission of OPERATIONAL_PERMISSIONS) {
      expect(hasPermission(role, permission), `${role}:${permission}`).toBe(true)
      expect(getRolePermissions(role)).toContain(permission)
    }
    expect(new Set(getRolePermissions(role)).size).toBe(getRolePermissions(role).length)
  })

  it.each(["VIEWER", "AUDITOR", "MEMBER", "DEVELOPER", "EXTERNAL_PENTESTER"] as const)(
    "does not promote %s to workspace or credential administrator",
    (role) => {
      for (const permission of [
        ...Object.values(PERMISSIONS.member),
        ...Object.values(PERMISSIONS.workspace),
        PERMISSIONS.billing.manage,
        PERMISSIONS.integration.manage,
        PERMISSIONS.agent.approve,
        ...Object.values(PERMISSIONS.policy),
      ])
        expect(hasPermission(role, permission), `${role}:${permission}`).toBe(false)
    }
  )
})
