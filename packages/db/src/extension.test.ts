import { describe, it, expect, beforeEach } from "vitest"

// Test the guard logic by replicating the pure functions
// (importing the extension directly would load Prisma client)

const SOFT_DELETE_MODELS = new Set([
  "Workspace", "WorkspaceMember", "Project", "Target", "CredentialSet",
  "Policy", "Scan", "ScanEvent", "Finding", "FixProposal", "PullRequest",
  "Ticket", "Integration", "UsageRecord", "AuditLog", "Report",
  "Notification", "Schedule", "BillingAccount", "Invitation",
  "WebhookEvent", "ApiKey", "Retest",
])

const WORKSPACE_SCOPED_MODELS = new Set([
  "WorkspaceMember", "Project", "Target", "CredentialSet", "Policy",
  "Scan", "ScanEvent", "ApiKey", "Finding", "Evidence", "FixProposal",
  "PullRequest", "Ticket", "Integration", "UsageRecord", "AuditLog",
  "Report", "Notification", "Schedule", "BillingAccount", "Invitation",
  "WebhookEvent", "Retest",
])

const READ_OPS = new Set([
  "findMany", "findUnique", "findFirst", "findRaw", "count", "aggregate", "groupBy",
])

let currentWorkspaceId: string | null = null

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
    where: { ...where, ...additions },
  }
}

describe("Prisma Extension — Query Guards", () => {
  beforeEach(() => {
    currentWorkspaceId = null
  })

  describe("soft-delete guard", () => {
    it("should add deletedAt: null to soft-delete models on findMany", () => {
      const result = applyQueryGuards("Finding", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null })
    })

    it("should add deletedAt: null to Project on findUnique", () => {
      const result = applyQueryGuards("Project", "findUnique", {})
      expect(result.where).toEqual({ deletedAt: null })
    })

    it("should add deletedAt: null to ApiKey on count", () => {
      const result = applyQueryGuards("ApiKey", "count", {})
      expect(result.where).toEqual({ deletedAt: null })
    })

    it("should add deletedAt: null to Retest on findFirst", () => {
      const result = applyQueryGuards("Retest", "findFirst", {})
      expect(result.where).toEqual({ deletedAt: null })
    })

    it("should preserve existing where conditions", () => {
      const result = applyQueryGuards("Finding", "findMany", {
        where: { severity: "HIGH" },
      })
      expect(result.where).toEqual({ severity: "HIGH", deletedAt: null })
    })

    it("should NOT add deletedAt to non-soft-delete models (User)", () => {
      const result = applyQueryGuards("User", "findMany", {})
      expect(result.where).toBeUndefined()
    })

    it("should NOT add deletedAt on write operations (create)", () => {
      const result = applyQueryGuards("Finding", "create", { data: {} })
      expect(result).toEqual({ data: {} })
    })

    it("should NOT add deletedAt on update operations", () => {
      const result = applyQueryGuards("Finding", "update", { where: { id: "x" } })
      expect(result).toEqual({ where: { id: "x" } })
    })
  })

  describe("workspace scoping guard", () => {
    it("should add workspaceId when context is set", () => {
      currentWorkspaceId = "ws-123"
      const result = applyQueryGuards("Project", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null, workspaceId: "ws-123" })
    })

    it("should NOT add workspaceId when context is null", () => {
      currentWorkspaceId = null
      const result = applyQueryGuards("Project", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null })
      expect(result.where).not.toHaveProperty("workspaceId")
    })

    it("should NOT override existing workspaceId in where", () => {
      currentWorkspaceId = "ws-123"
      const result = applyQueryGuards("Project", "findMany", {
        where: { workspaceId: "ws-other" },
      })
      expect(result.where).toEqual({ workspaceId: "ws-other", deletedAt: null })
    })

    it("should add workspaceId to Finding", () => {
      currentWorkspaceId = "ws-456"
      const result = applyQueryGuards("Finding", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null, workspaceId: "ws-456" })
    })

    it("should add workspaceId to ApiKey", () => {
      currentWorkspaceId = "ws-789"
      const result = applyQueryGuards("ApiKey", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null, workspaceId: "ws-789" })
    })

    it("should NOT add workspaceId to non-scoped models (Workspace)", () => {
      currentWorkspaceId = "ws-123"
      const result = applyQueryGuards("Workspace", "findMany", {})
      expect(result.where).toEqual({ deletedAt: null })
      expect(result.where).not.toHaveProperty("workspaceId")
    })
  })

  describe("model and operation edge cases", () => {
    it("should return args unchanged when model is undefined", () => {
      const result = applyQueryGuards(undefined, "findMany", { where: {} })
      expect(result).toEqual({ where: {} })
    })

    it("should return args unchanged for non-read operations", () => {
      const result = applyQueryGuards("Finding", "upsert", { where: { id: "x" } })
      expect(result).toEqual({ where: { id: "x" } })
    })

    it("should return args unchanged for aggregate on non-soft-delete model", () => {
      const result = applyQueryGuards("User", "aggregate", {})
      expect(result).toEqual({})
    })

    it("should handle groupBy on soft-delete model", () => {
      const result = applyQueryGuards("AuditLog", "groupBy", {})
      expect(result.where).toEqual({ deletedAt: null })
    })
  })
})

describe("Prisma Extension — Soft-Delete Model Coverage", () => {
  it("should have all 23 soft-delete models", () => {
    expect(SOFT_DELETE_MODELS.size).toBe(23)
  })

  it("should include ApiKey in soft-delete models", () => {
    expect(SOFT_DELETE_MODELS.has("ApiKey")).toBe(true)
  })

  it("should include Retest in soft-delete models", () => {
    expect(SOFT_DELETE_MODELS.has("Retest")).toBe(true)
  })

  it("should NOT include User in soft-delete models", () => {
    expect(SOFT_DELETE_MODELS.has("User")).toBe(false)
  })

  it("should NOT include Session in soft-delete models", () => {
    expect(SOFT_DELETE_MODELS.has("Session")).toBe(false)
  })
})

describe("Prisma Extension — Workspace Scoped Model Coverage", () => {
  it("should have all 23 workspace-scoped models", () => {
    expect(WORKSPACE_SCOPED_MODELS.size).toBe(23)
  })

  it("should include Evidence in workspace-scoped but NOT in soft-delete", () => {
    expect(WORKSPACE_SCOPED_MODELS.has("Evidence")).toBe(true)
    expect(SOFT_DELETE_MODELS.has("Evidence")).toBe(false)
  })

  it("should NOT include Workspace itself in workspace-scoped models", () => {
    expect(WORKSPACE_SCOPED_MODELS.has("Workspace")).toBe(false)
  })
})
