import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PERMISSIONS, hasPermission, getRolePermissions, type Permission } from "@lyrashield/auth"
import type { MemberRole } from "@lyrashield/db"
import { TeamClient } from "./team-client"

const ALL_ROLES: MemberRole[] = [
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

const baseProps = {
  workspaceId: "ws-1",
  initialData: {
    members: [
      {
        id: "m1",
        userId: "u1",
        name: "Ada",
        email: "ada@example.com",
        image: null,
        role: "VIEWER" as MemberRole,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    invitations: [],
  },
  actorRole: "OWNER" as MemberRole,
  canManage: true,
  canRemove: true,
  canUpdateRole: true,
}

describe("team permission projection (W1-08)", () => {
  it("discloses Option 3: every active member has operational access", () => {
    const html = renderToStaticMarkup(<TeamClient {...baseProps} />)
    expect(html).toContain("Every active member can run scans")
    expect(html).toContain("Roles control administrative access")
    // The invite form is collapsed until canManage triggers it; its role
    // labels are part of the source contract.
    const source = readFileSync(join(__dirname, "team-client.tsx"), "utf8")
    expect(source).toContain("Viewer — operational read/write")
    expect(source).toContain("Auditor — operational read/write")
  })

  // UI and API must agree for every persisted role: the operational set is
  // granted everywhere, and administrative capabilities follow the same
  // projection the page uses to gate invite/remove/role-change controls.
  it.each(ALL_ROLES)("projects %s permissions identically for UI and API", (role) => {
    const permissions = getRolePermissions(role)
    for (const permission of [
      PERMISSIONS.scan.create,
      PERMISSIONS.finding.update,
      PERMISSIONS.fix.createPr,
      PERMISSIONS.retest.create,
      PERMISSIONS.report.create,
      PERMISSIONS.schedule.create,
    ] as Permission[]) {
      expect(hasPermission(role, permission), `${role}:${permission}`).toBe(true)
      expect(permissions).toContain(permission)
    }
  })

  it.each(["VIEWER", "AUDITOR", "BILLING_ADMIN", "DEVELOPER", "MEMBER"] as MemberRole[])(
    "keeps %s out of membership administration in the projection",
    (role) => {
      const permissions = getRolePermissions(role)
      expect(hasPermission(role, PERMISSIONS.member.invite)).toBe(false)
      expect(hasPermission(role, PERMISSIONS.member.remove)).toBe(false)
      expect(hasPermission(role, PERMISSIONS.member.updateRole)).toBe(false)
      expect(permissions).not.toContain(PERMISSIONS.member.invite)
    }
  )
})
