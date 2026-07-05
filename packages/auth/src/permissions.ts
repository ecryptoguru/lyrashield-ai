import type { MemberRole } from "@lyrashield/db"

const ROLE_HIERARCHY: Record<MemberRole, number> = {
  OWNER: 100,
  ADMIN: 80,
  SECURITY_ADMIN: 75,
  APPSEC_MANAGER: 70,
  BILLING_ADMIN: 60,
  DEVELOPER: 40,
  MEMBER: 30,
  EXTERNAL_PENTESTER: 20,
  AUDITOR: 15,
  VIEWER: 10,
}

export const PERMISSIONS = {
  workspace: {
    create: "workspace:create",
    update: "workspace:update",
    delete: "workspace:delete",
  },
  member: {
    invite: "member:invite",
    remove: "member:remove",
    updateRole: "member:update_role",
  },
  project: {
    create: "project:create",
    update: "project:update",
    delete: "project:delete",
  },
  target: {
    create: "target:create",
    update: "target:update",
    delete: "target:delete",
    validate: "target:validate",
  },
  scan: {
    view: "scan:view",
    create: "scan:create",
    cancel: "scan:cancel",
    retry: "scan:retry",
  },
  finding: {
    view: "finding:view",
    update: "finding:update",
    acceptRisk: "finding:accept_risk",
    falsePositive: "finding:false_positive",
  },
  fix: {
    create: "fix:create",
    createPr: "fix:create_pr",
  },
  report: {
    create: "report:create",
    download: "report:download",
  },
  policy: {
    create: "policy:create",
    update: "policy:update",
    delete: "policy:delete",
  },
  audit: {
    view: "audit:view",
    export: "audit:export",
  },
  billing: {
    manage: "billing:manage",
  },
  integration: {
    manage: "integration:manage",
  },
} as const

// Derive a type-safe union of every permission string from PERMISSIONS.
// (Replaces the previous `type Permission = string`, which let typo'd permission
// strings silently fail closed.)
type PermissionGroups = typeof PERMISSIONS
export type Permission = {
  [G in keyof PermissionGroups]: PermissionGroups[G][keyof PermissionGroups[G]]
}[keyof PermissionGroups]

const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  OWNER: Object.values(PERMISSIONS).flatMap((group) => Object.values(group)) as Permission[],
  ADMIN: [
    PERMISSIONS.workspace.update,
    PERMISSIONS.member.invite,
    PERMISSIONS.member.remove,
    PERMISSIONS.member.updateRole,
    PERMISSIONS.project.create,
    PERMISSIONS.project.update,
    PERMISSIONS.project.delete,
    PERMISSIONS.target.create,
    PERMISSIONS.target.update,
    PERMISSIONS.target.delete,
    PERMISSIONS.target.validate,
    PERMISSIONS.scan.view,
    PERMISSIONS.scan.create,
    PERMISSIONS.scan.cancel,
    PERMISSIONS.scan.retry,
    PERMISSIONS.finding.view,
    PERMISSIONS.finding.update,
    PERMISSIONS.finding.acceptRisk,
    PERMISSIONS.finding.falsePositive,
    PERMISSIONS.fix.create,
    PERMISSIONS.fix.createPr,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
    // Governance permissions — an org ADMIN must be able to view/export audit logs
    // and manage scan policies. Previously these were held only by SECURITY_ADMIN
    // (a lower hierarchy rank), so an ADMIN could not view audit logs.
    PERMISSIONS.policy.create,
    PERMISSIONS.policy.update,
    PERMISSIONS.policy.delete,
    PERMISSIONS.audit.view,
    PERMISSIONS.audit.export,
    PERMISSIONS.integration.manage,
  ],
  SECURITY_ADMIN: [
    PERMISSIONS.scan.view,
    PERMISSIONS.target.create,
    PERMISSIONS.target.update,
    PERMISSIONS.target.validate,
    PERMISSIONS.scan.create,
    PERMISSIONS.scan.cancel,
    PERMISSIONS.scan.retry,
    PERMISSIONS.finding.view,
    PERMISSIONS.finding.update,
    PERMISSIONS.finding.acceptRisk,
    PERMISSIONS.finding.falsePositive,
    PERMISSIONS.fix.create,
    PERMISSIONS.fix.createPr,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
    PERMISSIONS.policy.create,
    PERMISSIONS.policy.update,
    PERMISSIONS.audit.view,
    PERMISSIONS.audit.export,
  ],
  APPSEC_MANAGER: [
    PERMISSIONS.scan.view,
    PERMISSIONS.target.create,
    PERMISSIONS.target.validate,
    PERMISSIONS.scan.create,
    PERMISSIONS.scan.cancel,
    PERMISSIONS.finding.view,
    PERMISSIONS.finding.update,
    PERMISSIONS.finding.acceptRisk,
    PERMISSIONS.fix.create,
    PERMISSIONS.fix.createPr,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  BILLING_ADMIN: [
    PERMISSIONS.billing.manage,
    PERMISSIONS.finding.view,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  DEVELOPER: [
    PERMISSIONS.scan.view,
    PERMISSIONS.target.create,
    PERMISSIONS.target.validate,
    PERMISSIONS.scan.create,
    PERMISSIONS.scan.cancel,
    PERMISSIONS.finding.view,
    PERMISSIONS.fix.create,
    PERMISSIONS.fix.createPr,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  MEMBER: [
    PERMISSIONS.project.create,
    PERMISSIONS.scan.view,
    PERMISSIONS.target.create,
    PERMISSIONS.scan.create,
    PERMISSIONS.finding.view,
    PERMISSIONS.fix.create,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  EXTERNAL_PENTESTER: [
    PERMISSIONS.scan.view,
    PERMISSIONS.scan.create,
    PERMISSIONS.finding.view,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  AUDITOR: [
    PERMISSIONS.scan.view,
    PERMISSIONS.finding.view,
    PERMISSIONS.audit.view,
    PERMISSIONS.audit.export,
    PERMISSIONS.report.create,
    PERMISSIONS.report.download,
  ],
  VIEWER: [PERMISSIONS.scan.view, PERMISSIONS.finding.view, PERMISSIONS.report.download],
}

export function hasPermission(role: MemberRole, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role]
  return perms?.includes(permission) ?? false
}

export function hasMinimumRole(role: MemberRole, minimumRole: MemberRole): boolean {
  return (ROLE_HIERARCHY[role] ?? 0) >= (ROLE_HIERARCHY[minimumRole] ?? 0)
}

export function getRolePermissions(role: MemberRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? []
}

export function isWorkspaceAdmin(role: MemberRole): boolean {
  return hasMinimumRole(role, "ADMIN")
}

export function isWorkspaceOwner(role: MemberRole): boolean {
  return role === "OWNER"
}
