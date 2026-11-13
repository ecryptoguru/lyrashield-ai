import { beforeEach, describe, expect, it, vi } from "vitest"
import { SCAN_STATE_FILTERS, scanStateStatuses } from "@/lib/scan-presentation"

const { listScans, findMany, findIntegration } = vi.hoisted(() => ({
  listScans: vi.fn(),
  findMany: vi.fn(),
  findIntegration: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  listScans,
  prisma: { target: { findMany }, integration: { findFirst: findIntegration } },
}))
vi.mock("@lyrashield/auth", () => ({
  hasPermission: () => false,
  PERMISSIONS: { billing: { manage: "billing" } },
}))
vi.mock("@/lib/cache", () => ({
  getCachedSession: async () => ({ userId: "member-1" }),
  getCachedWorkspaceId: async () => "workspace-1",
  getCachedWorkspaceContext: async () => ({ workspaces: [{ id: "workspace-1", role: "MEMBER" }] }),
}))
vi.mock("./scans-client", () => ({ ScansClient: () => null }))
vi.mock("../schedules/schedules-client", () => ({ SchedulesClient: () => null }))
import ScansPage from "./page"
import { ScansClient } from "./scans-client"
import { TargetsClient } from "../targets/targets-client"

function row(status: string) {
  return {
    id: `${status}-scan`,
    status,
    goal: "TEST_APP",
    mode: "SAFE",
    triggerType: "MANUAL",
    startedAt: null,
    endedAt: null,
    summary: null,
    errorCategory: null,
    errorMessage: null,
    findingCount: 0,
    target: null,
    createdAt: new Date("2026-09-01"),
  }
}

describe("scan page invalid target recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findMany.mockResolvedValue([])
    findIntegration.mockResolvedValue(null)
    listScans.mockImplementation(async (query) => ({
      items: query.targetId ? [] : [row(query.statuses?.[0] ?? "COMPLETED")],
      nextCursor: query.targetId ? null : "fallback-cursor",
    }))
  })

  it("opens source setup for a first scan and reads only the active workspace integration", async () => {
    findIntegration.mockResolvedValue({ metadata: { accountLogin: "example" } })
    const page = await ScansPage({ searchParams: Promise.resolve({ new: "1" }) })
    expect(page.type).toBe(TargetsClient)
    expect(page.props).toMatchObject({
      scanSetup: true,
      workspaceId: "workspace-1",
      githubConnected: true,
      githubAccountLogin: "example",
    })
    expect(findIntegration).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1", type: "GITHUB", status: "active", deletedAt: null },
    })
  })

  it("allows another source with existing targets, then opens confirmation for the saved target", async () => {
    const target = { id: "target-existing", name: "Existing app", type: "WEB_APP" }
    findMany.mockResolvedValue([target])
    const setup = await ScansPage({ searchParams: Promise.resolve({ new: "1", source: "url" }) })
    expect(setup.type).toBe(TargetsClient)
    const page = await ScansPage({ searchParams: Promise.resolve({ new: "1", target: target.id }) })
    const client = page.props.children.find(
      (child: { type: unknown }) => child.type === ScansClient
    )
    expect(client.props).toMatchObject({
      initialShowCreate: true,
      initialTargetId: target.id,
      initialRecoveryUnavailable: false,
    })
  })

  for (const target of ["deleted-target", "not-a-cuid/invalid", "foreign-workspace-target"]) {
    for (const state of SCAN_STATE_FILTERS) {
      if (target !== "deleted-target" && state !== "ALL") continue
      it(`preserves ${state} when ${target} is unavailable`, async () => {
        const page = await ScansPage({ searchParams: Promise.resolve({ target, state, new: "1" }) })
        const client = page.props.children.find(
          (child: { type: unknown }) => child.type === ScansClient
        )
        const statuses = scanStateStatuses(state)
        expect(listScans).toHaveBeenLastCalledWith({
          workspaceId: "workspace-1",
          limit: 25,
          ...(statuses ? { statuses } : {}),
        })
        expect(client.props.initialData.map((scan: { status: string }) => scan.status)).toEqual([
          statuses?.[0] ?? "COMPLETED",
        ])
        expect(client.props.initialStateFilter).toBe(state)
        expect(client.props.initialTargetFilter).toBe("")
        expect(client.props.initialNextCursor).toBe("fallback-cursor")
        expect(client.props.initialRecoveryUnavailable).toBe(true)
        expect(client.props.initialFilterUnavailable).toBe(true)
        expect(
          findMany.mock.calls.every(
            ([query]) => query.where.workspaceId === "workspace-1" && query.where.deletedAt === null
          )
        ).toBe(true)
      })
    }
  }
})
