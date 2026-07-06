import { describe, it, expect } from "vitest"
import {
  applyQueryGuards,
  runWithWorkspaceContext,
  getWorkspaceContext,
  SOFT_DELETE_MODELS,
  WORKSPACE_SCOPED_MODELS,
} from "./scoping"

// These tests exercise the REAL guard logic + model sets imported from
// scoping.ts (no Prisma client needed — scoping.ts has no Prisma import).

describe("Prisma Extension — Query Guards (soft-delete)", () => {
  it("adds deletedAt: null to soft-delete models on findMany", () => {
    expect(applyQueryGuards("Finding", "findMany", {}, null).where).toEqual({ deletedAt: null })
  })

  it("adds deletedAt: null to Project on findUnique", () => {
    expect(applyQueryGuards("Project", "findUnique", {}, null).where).toEqual({ deletedAt: null })
  })

  it("adds deletedAt: null to ScanEvent on findFirst", () => {
    expect(applyQueryGuards("ScanEvent", "findFirst", {}, null).where).toEqual({ deletedAt: null })
  })

  it("preserves existing where conditions", () => {
    expect(applyQueryGuards("Finding", "findMany", { where: { severity: "HIGH" } }, null).where).toEqual({
      severity: "HIGH",
      deletedAt: null,
    })
  })

  it("does NOT add deletedAt to non-soft-delete models (User)", () => {
    expect(applyQueryGuards("User", "findMany", {}, null).where).toBeUndefined()
  })

  // Regression: these models have NO deletedAt column. Injecting deletedAt
  // would throw a Prisma validation error at runtime (this previously broke
  // getWorkspaceMembership's findUnique on WorkspaceMember).
  it.each(["WorkspaceMember", "CredentialSet", "AuditLog", "Retest"])(
    "does NOT inject deletedAt for %s (no deletedAt column)",
    (model) => {
      const result = applyQueryGuards(model, "findMany", {}, null)
      expect(result.where ?? {}).not.toHaveProperty("deletedAt")
    }
  )

  it("does NOT add deletedAt on write operations (create/update)", () => {
    expect(applyQueryGuards("Finding", "create", { data: {} }, null)).toEqual({ data: {} })
    expect(applyQueryGuards("Finding", "update", { where: { id: "x" } }, null)).toEqual({
      where: { id: "x" },
    })
  })
})

describe("Prisma Extension — Query Guards (workspace scoping)", () => {
  it("adds workspaceId when context is set", () => {
    expect(applyQueryGuards("Project", "findMany", {}, "ws-123").where).toEqual({
      deletedAt: null,
      workspaceId: "ws-123",
    })
  })

  it("does NOT add workspaceId when context is null", () => {
    const where = applyQueryGuards("Project", "findMany", {}, null).where as Record<string, unknown>
    expect(where).toEqual({ deletedAt: null })
    expect(where).not.toHaveProperty("workspaceId")
  })

  it("does NOT override an existing workspaceId in where", () => {
    expect(
      applyQueryGuards("Project", "findMany", { where: { workspaceId: "ws-other" } }, "ws-123").where
    ).toEqual({ workspaceId: "ws-other", deletedAt: null })
  })

  it("scopes AuditLog by workspaceId but does NOT inject deletedAt (no column)", () => {
    expect(applyQueryGuards("AuditLog", "findMany", {}, "ws-456").where).toEqual({ workspaceId: "ws-456" })
  })

  // Regression: these models have NO workspaceId column. Injecting workspaceId
  // would throw a Prisma validation error the moment a workspace context is active.
  it.each(["ScanEvent", "Evidence", "FixProposal", "PullRequest", "Ticket"])(
    "does NOT inject workspaceId for %s (no workspaceId column)",
    (model) => {
      const where = (applyQueryGuards(model, "findMany", {}, "ws-123").where ?? {}) as Record<string, unknown>
      expect(where).not.toHaveProperty("workspaceId")
    }
  )

  it("does NOT auto-scope WorkspaceMember (queried cross-workspace)", () => {
    const where = (applyQueryGuards("WorkspaceMember", "findMany", {}, "ws-123").where ?? {}) as Record<
      string,
      unknown
    >
    expect(where).not.toHaveProperty("workspaceId")
  })
})

describe("Prisma Extension — request-scoped context isolation", () => {
  it("returns null outside any context", () => {
    expect(getWorkspaceContext()).toBeNull()
  })

  it("isolates workspace context across concurrent async executions", async () => {
    // Simulate two interleaved requests; each must only ever see its own id.
    const results: Record<string, string[]> = { a: [], b: [] }

    async function work(tag: "a" | "b", ws: string) {
      return runWithWorkspaceContext(ws, async () => {
        results[tag].push(getWorkspaceContext() ?? "null")
        await new Promise((r) => setTimeout(r, 5))
        // After awaiting (yielding the event loop to the other "request"),
        // context must still be this execution's workspace, not the other's.
        results[tag].push(getWorkspaceContext() ?? "null")
      })
    }

    await Promise.all([work("a", "ws-A"), work("b", "ws-B")])

    expect(results.a).toEqual(["ws-A", "ws-A"])
    expect(results.b).toEqual(["ws-B", "ws-B"])
    // And context is cleared once the runs complete.
    expect(getWorkspaceContext()).toBeNull()
  })
})

describe("Prisma Extension — model set correctness (matches schema columns)", () => {
  it("soft-delete set contains only models with a deletedAt column (19)", () => {
    expect(SOFT_DELETE_MODELS.size).toBe(19)
    for (const m of ["WorkspaceMember", "CredentialSet", "AuditLog", "Retest", "Evidence", "User"]) {
      expect(SOFT_DELETE_MODELS.has(m)).toBe(false)
    }
    expect(SOFT_DELETE_MODELS.has("ScanEvent")).toBe(true)
  })

  it("workspace-scoped set contains only auto-scopable models with workspaceId (18)", () => {
    expect(WORKSPACE_SCOPED_MODELS.size).toBe(18)
    for (const m of ["ScanEvent", "Evidence", "FixProposal", "PullRequest", "Ticket", "Workspace", "WorkspaceMember", "OnboardingState"]) {
      expect(WORKSPACE_SCOPED_MODELS.has(m)).toBe(false)
    }
    expect(WORKSPACE_SCOPED_MODELS.has("AuditLog")).toBe(true)
  })
})
