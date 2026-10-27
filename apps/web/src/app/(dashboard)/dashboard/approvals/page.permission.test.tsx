import { Children, isValidElement, type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ role: "DEVELOPER" }))
vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "u1" }),
  getCachedWorkspaceId: async () => "ws1",
  getCachedWorkspaces: async () => [{ id: "ws1", role: state.role }],
}))
vi.mock("@lyrashield/db", () => ({
  listApprovals: async () => ({ items: [] }),
  listRecentAgentOperations: async () => [],
  withWorkspaceRLS: async (_workspaceId: string, fn: (tx: unknown) => unknown) =>
    fn({ fixProposal: { count: async () => 0 } }),
}))
vi.mock("./approvals-client", () => ({ ApprovalsClient: () => null }))
import ApprovalsPage from "./page"
import { ApprovalsClient } from "./approvals-client"

describe("approval decision permissions", () => {
  it.each([
    ["DEVELOPER", false],
    ["APPSEC_MANAGER", false],
    ["OWNER", true],
    ["SECURITY_ADMIN", true],
    ["ADMIN", true],
  ])("passes decision permission for %s", async (role, expected) => {
    state.role = role
    const page = await ApprovalsPage()
    const child = Children.toArray(page?.props.children).find(
      (node) => isValidElement(node) && node.type === ApprovalsClient
    ) as ReactElement<{ canDecide: boolean }>
    expect(child.props.canDecide).toBe(expected)
  })
})
