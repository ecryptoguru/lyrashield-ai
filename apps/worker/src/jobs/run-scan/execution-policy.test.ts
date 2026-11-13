import { beforeEach, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ read: vi.fn(), scoped: vi.fn() }))
vi.mock("@lyrashield/db", () => ({
  withWorkspaceRLS: db.scoped,
  updateScanStatus: vi.fn(),
}))
vi.mock("../../notifications", () => ({ notifyScanFailed: vi.fn() }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn() } }))
import { readExecutionPolicy } from "./execution-policy"

beforeEach(() => {
  vi.clearAllMocks()
  db.scoped.mockImplementation(async (_workspaceId, fn) => fn({ policy: { findFirst: db.read } }))
})
it("reads the policy through the selected workspace transaction with its exact identity", async () => {
  const policy = { maxBudgetUsd: "1.50", maxDurationMinutes: 5 }
  db.read.mockResolvedValue(policy)
  expect(await readExecutionPolicy("policy-a", "workspace-a")).toBe(policy)
  expect(db.scoped).toHaveBeenCalledWith("workspace-a", expect.any(Function))
  expect(db.read).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "policy-a", workspaceId: "workspace-a", deletedAt: null },
    })
  )
})
it("keeps an out-of-workspace or deleted policy absent", async () => {
  db.read.mockResolvedValue(null)
  expect(await readExecutionPolicy("policy-a", "workspace-b")).toBeNull()
  expect(db.scoped).toHaveBeenCalledWith("workspace-b", expect.any(Function))
  expect(db.read).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "policy-a", workspaceId: "workspace-b", deletedAt: null },
    })
  )
})
it("does not open a database transaction when no policy is selected", async () => {
  expect(await readExecutionPolicy(undefined, "workspace-a")).toBeNull()
  expect(db.scoped).not.toHaveBeenCalled()
  expect(db.read).not.toHaveBeenCalled()
})
