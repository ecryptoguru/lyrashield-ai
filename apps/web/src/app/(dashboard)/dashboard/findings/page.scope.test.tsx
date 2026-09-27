import { Children, isValidElement, type ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  workspaceId: "workspace-a",
  listFixProposals: vi.fn(),
}))

vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "user-a" }),
  getCachedWorkspaceId: async () => state.workspaceId,
}))
vi.mock("@lyrashield/db", () => ({
  prisma: {},
  listFindings: vi.fn(),
  findingScopeWhere: vi.fn(),
  listFixProposals: state.listFixProposals,
  validateFindingScope: async ({ targetId, observedInScanId }: Record<string, string>) => ({
    available: true,
    target: targetId ? { id: targetId, name: targetId } : null,
    scanId: observedInScanId ?? null,
  }),
}))
vi.mock("./findings-client", () => ({ FindingsClient: () => null }))
vi.mock("./evidence-list", () => ({ EvidenceList: () => null }))
vi.mock("./fixes-client", () => ({ FixesClient: () => null }))
vi.mock("@/components/dashboard-section-tabs", () => ({ DashboardSectionTabs: () => null }))

import FindingsPage from "./page"
import { EvidenceList } from "./evidence-list"
import { FixesClient } from "./fixes-client"

async function listBoundary(tab: string, target?: string, scanId?: string) {
  const page = await FindingsPage({ searchParams: Promise.resolve({ tab, target, scanId }) })
  const children = Children.toArray(page?.props.children)
  const child = children.find(
    (node) =>
      isValidElement(node) && node.type === (tab === "evidence" ? EvidenceList : FixesClient)
  )
  expect(isValidElement(child)).toBe(true)
  return child as ReactElement<{ targetId?: string; observedInScanId?: string }>
}

beforeEach(() => {
  state.workspaceId = "workspace-a"
  state.listFixProposals.mockResolvedValue({ items: [], nextCursor: null })
})

describe.each(["evidence", "fixes"])("%s list navigation", (tab) => {
  it("replaces the stateful list when target, scan, or workspace changes", async () => {
    const original = await listBoundary(tab, "target-a", "scan-a")
    const refreshed = await listBoundary(tab, "target-a", "scan-a")
    const targetChanged = await listBoundary(tab, "target-b", "scan-a")
    const scanChanged = await listBoundary(tab, "target-a", "scan-b")
    state.workspaceId = "workspace-b"
    const workspaceChanged = await listBoundary(tab, "target-a", "scan-a")

    // React uses these element identities to discard old rows and pending page
    // callbacks on navigation, while preserving pagination in the same scope.
    expect(refreshed.key).toBe(original.key)
    expect(
      new Set([original.key, targetChanged.key, scanChanged.key, workspaceChanged.key]).size
    ).toBe(4)
    expect(targetChanged.props.targetId).toBe("target-b")
    expect(scanChanged.props.observedInScanId).toBe("scan-b")
  })

  it("replaces the list when its scan and target scope are cleared", async () => {
    const scoped = await listBoundary(tab, "target-a", "scan-a")
    const unscoped = await listBoundary(tab)
    expect(unscoped.key).not.toBe(scoped.key)
    expect(unscoped.props.targetId).toBeUndefined()
    expect(unscoped.props.observedInScanId).toBeUndefined()
  })
})
