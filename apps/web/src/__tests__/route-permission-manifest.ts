import { expect } from "vitest"
import type { Permission } from "@lyrashield/auth"

type PermissionedMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT"

const ROUTE_PERMISSION_MANIFEST = [
  { route: "/api/ai-assurance/evidence", method: "GET", permission: "aiAssurance:view" },
  { route: "/api/ai-assurance/evidence", method: "POST", permission: "aiAssurance:manage" },
  {
    route: "/api/ai-assurance/evidence/[id]/artifacts",
    method: "POST",
    permission: "aiAssurance:manage",
  },
  {
    route: "/api/ai-assurance/evidence/[id]/review",
    method: "POST",
    permission: "aiAssurance:review",
  },
  {
    route: "/api/ai-assurance/evidence/not-applicable",
    method: "POST",
    permission: "aiAssurance:manage",
  },
  { route: "/api/ai-assurance/threat-model", method: "GET", permission: "aiAssurance:view" },
  { route: "/api/ai-assurance/threat-model", method: "POST", permission: "aiAssurance:manage" },
  { route: "/api/billing/topup", method: "POST", permission: "billing:manage" },
  { route: "/api/billing/usage", method: "GET", permission: "billing:manage" },
  { route: "/api/findings/[id]/history", method: "GET", permission: "finding:view" },
  { route: "/api/findings/evidence", method: "GET", permission: "finding:view" },
  { route: "/api/fix-proposals", method: "GET", permission: "finding:view" },
  { route: "/api/integrations/github/install", method: "GET", permission: "integration:manage" },
  { route: "/api/integrations/github/install", method: "POST", permission: "integration:manage" },
  { route: "/api/integrations/slack/install", method: "GET", permission: "integration:manage" },
  { route: "/api/integrations/slack/install", method: "POST", permission: "integration:manage" },
  { route: "/api/launch-readiness", method: "GET", permission: "finding:view" },
  { route: "/api/live-ai-safety", method: "GET", permission: "agent:view" },
  { route: "/api/live-ai-safety", method: "PUT", permission: "aiAssurance:manage" },
  { route: "/api/live-ai-safety", method: "POST", permission: "agent:act" },
  { route: "/api/reports", method: "GET", permission: "report:download" },
  { route: "/api/reports", method: "POST", permission: "report:create" },
  { route: "/api/reports/[id]", method: "GET", permission: "report:download" },
  { route: "/api/reports/[id]", method: "POST", permission: "report:create" },
  { route: "/api/reports/[id]/download", method: "GET", permission: "report:download" },
  { route: "/api/scans/[id]", method: "GET", permission: "scan:view" },
  { route: "/api/scans/[id]", method: "POST", permission: "scan:cancel" },
  { route: "/api/scans/[id]", method: "DELETE", permission: "scan:remove" },
  { route: "/api/scans/eligibility", method: "GET", permission: "scan:create" },
  { route: "/api/schedules", method: "GET", permission: "schedule:view" },
  { route: "/api/schedules", method: "POST", permission: "schedule:create" },
  { route: "/api/schedules/[id]", method: "GET", permission: "schedule:view" },
  { route: "/api/schedules/[id]", method: "PATCH", permission: "schedule:update" },
  { route: "/api/schedules/[id]", method: "DELETE", permission: "schedule:delete" },
] as const satisfies readonly {
  route: string
  method: PermissionedMethod
  permission: Permission
}[]

function routePermission(route: string, method: PermissionedMethod): Permission {
  const match = ROUTE_PERMISSION_MANIFEST.find(
    (entry) => entry.route === route && entry.method === method
  )
  if (!match) throw new Error(`Missing route permission manifest entry: ${method} ${route}`)
  return match.permission
}

function expectRoutePermissionCall(
  calls: readonly unknown[][],
  workspaceId: string,
  route: string,
  method: PermissionedMethod
): void {
  expect(calls).toContainEqual([workspaceId, routePermission(route, method)])
}

export function expectPermissionDenied(
  response: Response,
  calls: readonly unknown[][],
  workspaceId: string,
  route: string,
  method: PermissionedMethod
): void {
  expect(response.status).toBe(403)
  expectRoutePermissionCall(calls, workspaceId, route, method)
}
