import { describe, it, expect } from "vitest"
import { PERMISSIONS, hasPermission } from "./permissions"
import type { MemberRole } from "@lyrashield/db"

describe("Agent Permissions", () => {
  it("defines agent.view, agent.act, agent.approve permissions", () => {
    expect(PERMISSIONS.agent.view).toBe("agent:view")
    expect(PERMISSIONS.agent.act).toBe("agent:act")
    expect(PERMISSIONS.agent.approve).toBe("agent:approve")
  })

  it("ADMIN has all agent permissions", () => {
    expect(hasPermission("ADMIN", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("ADMIN", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("ADMIN", PERMISSIONS.agent.approve)).toBe(true)
  })

  it("SECURITY_ADMIN has all agent permissions", () => {
    expect(hasPermission("SECURITY_ADMIN", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("SECURITY_ADMIN", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("SECURITY_ADMIN", PERMISSIONS.agent.approve)).toBe(true)
  })

  it("APPSEC_MANAGER has agent.view and agent.act but not agent.approve", () => {
    expect(hasPermission("APPSEC_MANAGER", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("APPSEC_MANAGER", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("APPSEC_MANAGER", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("DEVELOPER has agent.view and agent.act but not agent.approve", () => {
    expect(hasPermission("DEVELOPER", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("DEVELOPER", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("DEVELOPER", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("MEMBER has operational agent access but not connection administration", () => {
    expect(hasPermission("MEMBER", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("MEMBER", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("MEMBER", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("VIEWER has operational agent access but not connection administration", () => {
    expect(hasPermission("VIEWER", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("VIEWER", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("VIEWER", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("AUDITOR has operational agent access but not connection administration", () => {
    expect(hasPermission("AUDITOR", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("AUDITOR", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("AUDITOR", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("EXTERNAL_PENTESTER has operational agent access but not connection administration", () => {
    expect(hasPermission("EXTERNAL_PENTESTER", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("EXTERNAL_PENTESTER", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("EXTERNAL_PENTESTER", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("BILLING_ADMIN has operational agent access but not connection administration", () => {
    expect(hasPermission("BILLING_ADMIN", PERMISSIONS.agent.view)).toBe(true)
    expect(hasPermission("BILLING_ADMIN", PERMISSIONS.agent.act)).toBe(true)
    expect(hasPermission("BILLING_ADMIN", PERMISSIONS.agent.approve)).toBe(false)
  })

  it("every role has agent.view", () => {
    const roles: MemberRole[] = [
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
    ]
    for (const role of roles) {
      expect(hasPermission(role, PERMISSIONS.agent.view)).toBe(true)
    }
  })
})
