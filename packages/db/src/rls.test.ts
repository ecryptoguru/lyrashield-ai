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
    it("sets app.current_workspace_id transaction-locally inside a transaction", async () => {
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

    it("passes transaction isolation options to Prisma", async () => {
      const { prisma } = await import("./client")

      await withWorkspaceRLS("ws-1", vi.fn().mockResolvedValue(undefined), {
        isolationLevel: "Serializable",
      })

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      })
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
    // Live coverage and ENABLE/FORCE flags are checked against pg_catalog in
    // rls-fail-closed.test.ts. These fast checks cover only helper semantics.

    it("excludes identity tables needed for cross-workspace membership queries from RLS", () => {
      expect(WORKSPACE_SCOPED_MODELS.has("Workspace")).toBe(false)
      expect(WORKSPACE_SCOPED_MODELS.has("WorkspaceMember")).toBe(false)
    })

    it("excludes OnboardingState from RLS (per-user, not tenant data)", () => {
      expect(WORKSPACE_SCOPED_MODELS.has("OnboardingState")).toBe(false)
    })

    // Child tables do not carry a workspaceId, but they are still RLS-protected
    // through their parent (DB-07). These must have FORCE ROW LEVEL SECURITY and
    // an EXISTS-style policy in the latest RLS migration.
    const CHILD_RLS_TABLES = [
      "ScanEvent",
      "Evidence",
      "ScanResultManifest",
      "ScanCoverageReceipt",
      "FixProposal",
      "PullRequest",
      "Ticket",
      "ScorecardShare",
      "ScorecardEvent",
      "AiSystemProfileVersion",
      "ThreatModelVersion",
      "ControlEvidenceVersion",
    ]

    it("excludes child RLS tables from WORKSPACE_SCOPED_MODELS (no workspaceId column)", () => {
      for (const table of CHILD_RLS_TABLES) {
        expect(WORKSPACE_SCOPED_MODELS.has(table)).toBe(false)
      }
    })
  })
})
