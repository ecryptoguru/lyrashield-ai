import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  gate: vi.fn(),
  raw: vi.fn(),
  scan: vi.fn(),
  findings: vi.fn(),
  createFindings: vi.fn(),
  createCandidates: vi.fn(),
  candidates: vi.fn(),
  event: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { scan: { findFirst: mocks.scan }, auditLog: { create: mocks.audit } },
  withWorkspaceRLS: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: mocks.raw,
      finding: { findMany: mocks.findings, createManyAndReturn: mocks.createFindings },
      findingCandidate: {
        createMany: mocks.createCandidates,
        findMany: mocks.candidates,
      },
      scanEvent: { create: mocks.event },
    }),
  evaluateGateForTarget: mocks.gate,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.permission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { scan: { create: "scan:create" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { POST } from "./route"
import { POST as DashboardPOST } from "../../../../../scans/[id]/artifacts/sarif/route"

const sarif = {
  version: "2.1.0",
  runs: [{ results: [{ ruleId: "test", level: "error", message: { text: "Detection" } }] }],
}
const params = { params: Promise.resolve({ id: "scan-1" }) }

/** Bearer-only request — no cookie, so `withCookieMutation` must not 403. */
function bearerRequest(body: unknown = sarif) {
  return new Request("http://localhost/api/v1/scans/scan-1/artifacts/sarif?workspaceId=ws-1", {
    method: "POST",
    headers: { Authorization: "Bearer lsk_test" },
    body: JSON.stringify(body),
  })
}

describe("v1 SARIF import route", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.raw.mockResolvedValue(1)
    mocks.permission.mockResolvedValue({ session: { userId: "user-1", apiKey: {} } })
    mocks.scan.mockResolvedValue({
      id: "scan-1",
      targetId: "target-1",
      createdAt: new Date("2026-09-13T00:00:00Z"),
    })
    mocks.candidates.mockResolvedValue([])
    mocks.findings.mockResolvedValue([])
    mocks.createFindings.mockImplementation(async ({ data }: { data: { dedupeKey: string }[] }) =>
      data.map((finding, index) => ({ id: `finding-${index + 1}`, dedupeKey: finding.dedupeKey }))
    )
    mocks.createCandidates.mockResolvedValue({ count: 1 })
  })

  it("exports the same POST handler the dashboard route serves", () => {
    expect(POST).toBe(DashboardPOST)
  })

  it("lets a bearer API key through the mutation wrapper and imports a fixture", async () => {
    const response = await POST(bearerRequest(), params)
    expect(response.status).toBe(200)
    expect(mocks.permission).toHaveBeenCalledWith("ws-1", "scan:create")
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.data.imported).toBe(1)
  })
})
