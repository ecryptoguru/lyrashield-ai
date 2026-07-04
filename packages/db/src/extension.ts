import { Prisma } from "./generated/prisma"

const SOFT_DELETE_MODELS = new Set([
  "Workspace",
  "WorkspaceMember",
  "Project",
  "Target",
  "CredentialSet",
  "Policy",
  "Scan",
  "ScanEvent",
  "Finding",
  "FixProposal",
  "PullRequest",
  "Ticket",
  "Integration",
  "UsageRecord",
  "AuditLog",
  "Report",
  "Notification",
  "Schedule",
  "BillingAccount",
  "Invitation",
  "WebhookEvent",
  "ApiKey",
  "Retest",
])

const WORKSPACE_SCOPED_MODELS = new Set([
  "WorkspaceMember",
  "Project",
  "Target",
  "CredentialSet",
  "Policy",
  "Scan",
  "ScanEvent",
  "ApiKey",
  "Finding",
  "Evidence",
  "FixProposal",
  "PullRequest",
  "Ticket",
  "Integration",
  "UsageRecord",
  "AuditLog",
  "Report",
  "Notification",
  "Schedule",
  "BillingAccount",
  "Invitation",
  "WebhookEvent",
  "Retest",
])

let currentWorkspaceId: string | null = null

export function setWorkspaceContext(workspaceId: string | null) {
  currentWorkspaceId = workspaceId
}

export function getWorkspaceContext(): string | null {
  return currentWorkspaceId
}

const READ_OPS = new Set([
  "findMany",
  "findUnique",
  "findFirst",
  "findRaw",
  "count",
  "aggregate",
  "groupBy",
])

function applyQueryGuards(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!model) return args
  if (!READ_OPS.has(operation)) return args

  const where = (args.where as Record<string, unknown> | undefined) ?? {}
  const additions: Record<string, unknown> = {}

  if (SOFT_DELETE_MODELS.has(model)) {
    additions.deletedAt = null
  }

  if (WORKSPACE_SCOPED_MODELS.has(model) && currentWorkspaceId && !("workspaceId" in where)) {
    additions.workspaceId = currentWorkspaceId
  }

  if (Object.keys(additions).length === 0) return args

  return {
    ...args,
    where: {
      ...where,
      ...additions,
    },
  }
}

export const workspaceExtension = Prisma.defineExtension({
  query: {
    $allOperations({ model, operation, args, query }) {
      const guardedArgs = applyQueryGuards(model, operation, args as Record<string, unknown>)

      if (
        (operation === "delete" || operation === "deleteMany") &&
        model &&
        SOFT_DELETE_MODELS.has(model)
      ) {
        return query({
          ...guardedArgs,
          data: { deletedAt: new Date() },
        })
      }

      return query(guardedArgs)
    },
  },
})
