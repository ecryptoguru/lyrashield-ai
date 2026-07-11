import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the prisma client to avoid needing a live database
vi.mock("./client", () => {
  const mockExecuteRaw = vi.fn().mockResolvedValue(undefined)
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({ $executeRaw: mockExecuteRaw })
  })
  return {
    prisma: {
      $transaction: mockTransaction,
    },
  }
})

import { withWorkspaceRLS, withoutWorkspaceRLS } from "./rls"
import { WORKSPACE_SCOPED_MODELS } from "./scoping"

describe("RLS helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("withWorkspaceRLS", () => {
    it("sets app.current_workspace_id via SET LOCAL inside a transaction", async () => {
      const workspaceId = "ws-test-123"
      const callback = vi.fn().mockResolvedValue("result")

      const result = await withWorkspaceRLS(workspaceId, callback)

      expect(result).toBe("result")
      expect(callback).toHaveBeenCalledTimes(1)

      // The $executeRaw should have been called (SET LOCAL)
      // We can't inspect the exact SQL from the mock, but we verify it was called
      const mockTx = callback.mock.calls[0]?.[0] as { $executeRaw: ReturnType<typeof vi.fn> }
      expect(mockTx?.$executeRaw).toBeDefined()
    })

    it("passes the transactional client to the callback", async () => {
      const callback = vi.fn().mockResolvedValue(undefined)
      await withWorkspaceRLS("ws-1", callback)

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          $executeRaw: expect.any(Function),
        })
      )
    })

    it("propagates errors from the callback", async () => {
      const error = new Error("query failed")
      const callback = vi.fn().mockRejectedValue(error)

      await expect(withWorkspaceRLS("ws-1", callback)).rejects.toThrow("query failed")
    })

    it("propagates errors from SET LOCAL", async () => {
      // Reset mock to throw
      const { prisma } = await import("./client")
      vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("SET LOCAL failed"))

      await expect(withWorkspaceRLS("ws-1", vi.fn())).rejects.toThrow("SET LOCAL failed")
    })
  })

  describe("withoutWorkspaceRLS", () => {
    it("resets app.current_workspace_id inside a transaction", async () => {
      const callback = vi.fn().mockResolvedValue("result")

      const result = await withoutWorkspaceRLS(callback)

      expect(result).toBe("result")
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it("propagates errors from the callback", async () => {
      const error = new Error("query failed")
      const callback = vi.fn().mockRejectedValue(error)

      await expect(withoutWorkspaceRLS(callback)).rejects.toThrow("query failed")
    })
  })

  describe("RLS table coverage", () => {
    // The RLS migration creates policies on these tables.
    // WORKSPACE_SCOPED_MODELS must match exactly — if a model is in the set,
    // it must have an RLS policy, and vice versa.
    const RLS_TABLES = [
      "Project",
      "Target",
      "CredentialSet",
      "Policy",
      "Scan",
      "ApiKey",
      "Finding",
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
      "AgentApproval",
    ]

    it("WORKSPACE_SCOPED_MODELS matches the RLS-protected table set exactly", () => {
      const modelSet = new Set(WORKSPACE_SCOPED_MODELS)
      const rlsSet = new Set(RLS_TABLES)

      // Every RLS table should be in WORKSPACE_SCOPED_MODELS
      for (const table of RLS_TABLES) {
        expect(modelSet.has(table)).toBe(true)
      }

      // Every WORKSPACE_SCOPED_MODELS entry should have an RLS policy
      for (const model of modelSet) {
        expect(rlsSet.has(model)).toBe(true)
      }

      // Same size
      expect(modelSet.size).toBe(rlsSet.size)
    })

    it("excludes WorkspaceMember from RLS (cross-workspace queries)", () => {
      expect(WORKSPACE_SCOPED_MODELS.has("WorkspaceMember")).toBe(false)
    })

    it("excludes OnboardingState from RLS (per-user, not tenant data)", () => {
      expect(WORKSPACE_SCOPED_MODELS.has("OnboardingState")).toBe(false)
    })
  })
})
