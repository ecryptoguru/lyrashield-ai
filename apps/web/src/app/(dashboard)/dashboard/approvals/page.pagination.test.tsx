import { Children, isValidElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ list: vi.fn(), recent: vi.fn() }))
vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "u1" }),
  getCachedWorkspaceId: async () => "ws1",
  getCachedWorkspaces: async () => [{ id: "ws1", role: "OWNER" }],
}))
vi.mock("@lyrashield/db", () => ({
  listApprovals: mocks.list,
  listRecentAgentOperations: mocks.recent,
  withWorkspaceRLS: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ fixProposal: { count: async () => 0 } }),
}))
vi.mock("./approvals-client", () => ({ ApprovalsClient: () => null }))
import ApprovalsPage from "./page"
import { ApprovalsClient } from "./approvals-client"
it("exposes further pending requests and older operations with independent scoped cursors", async () => {
  mocks.list.mockResolvedValue({ items: [], nextCursor: "approval-next" })
  mocks.recent.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: `op-${i}` })))
  const html = renderToStaticMarkup(
    await ApprovalsPage({
      searchParams: Promise.resolve({
        approvalsCursor: "approval-current",
        operationsCursor: "op-current",
      }),
    })
  )
  expect(mocks.list).toHaveBeenCalledWith({
    workspaceId: "ws1",
    status: "PENDING",
    limit: 50,
    cursor: "approval-current",
  })
  expect(mocks.recent).toHaveBeenCalledWith("ws1", 21, "op-current")
  expect(html).toContain("More pending approvals")
  expect(html).toContain("Older operations")
  expect(html).toContain("approvalsCursor=approval-next")
  expect(html).toContain("operationsCursor=op-19")
})

it.each([undefined, "approval-current"])(
  "binds the pending client page identity to cursor %s",
  async (cursor) => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null })
    mocks.recent.mockResolvedValue([])
    const page = await ApprovalsPage({ searchParams: Promise.resolve({ approvalsCursor: cursor }) })
    const client = Children.toArray(page?.props.children).find(
      (node) => isValidElement(node) && node.type === ApprovalsClient
    ) as ReactElement<{ pendingCursor: string | null }>
    expect(client.props.pendingCursor).toBe(cursor ?? null)
  }
)
