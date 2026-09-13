import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  gate: vi.fn(),
  lock: vi.fn(),
  scan: vi.fn(),
  find: vi.fn(),
  upsert: vi.fn(),
  candidate: vi.fn(),
  candidates: vi.fn(),
  legacyCandidate: vi.fn(),
  event: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  prisma: { scan: { findFirst: mocks.scan }, auditLog: { create: mocks.audit } },
  withWorkspaceRLS: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $executeRaw: mocks.lock,
      finding: { findFirst: mocks.find, upsert: mocks.upsert },
      findingCandidate: {
        upsert: mocks.candidate,
        findMany: mocks.candidates,
        findFirst: mocks.legacyCandidate,
      },
      scanEvent: { create: mocks.event },
    }),
  evaluateGateForTarget: mocks.gate,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.permission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { scan: { create: "scan:create" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
import { POST } from "./route"

const sarif = {
  version: "2.1.0",
  runs: [{ results: [{ ruleId: "test", level: "error", message: { text: "Detection" } }] }],
}
const params = { params: Promise.resolve({ id: "scan-1" }) }
function request(body: unknown = sarif) {
  return new Request("http://localhost/api/scans/scan-1/artifacts/sarif?workspaceId=ws-1", {
    method: "POST",
    body: JSON.stringify(body),
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.permission.mockResolvedValue({ session: { userId: "user-1" } })
  mocks.scan.mockResolvedValue({
    id: "scan-1",
    targetId: "target-1",
    createdAt: new Date("2026-09-13T00:00:00Z"),
  })
  mocks.candidates.mockResolvedValue([])
  mocks.find.mockResolvedValue(null)
  mocks.upsert.mockResolvedValue({ id: "finding-1" })
})
describe("SARIF import route", () => {
  it("requires write permission and binds reads to the requested workspace", async () => {
    mocks.permission.mockRejectedValue(new Error("FORBIDDEN"))
    expect((await POST(request(), params)).status).toBe(403)
    expect(mocks.scan).not.toHaveBeenCalled()
  })
  it("does not extend scan-create OAuth grants to arbitrary imports", async () => {
    mocks.permission.mockResolvedValue({
      session: { userId: "user-1", oauth: { connectionId: "c" } },
    })
    expect((await POST(request(), params)).status).toBe(403)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
  it("returns not found without reading import data from another workspace", async () => {
    mocks.scan.mockResolvedValue(null)
    expect((await POST(request(), params)).status).toBe(404)
    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "scan-1", workspaceId: "ws-1", deletedAt: null } })
    )
  })
  it("imports only DETECTED candidates and refreshes the target verdict", async () => {
    const response = await POST(request(), params)
    expect(response.status).toBe(200)
    expect((await response.json()).data.imported).toBe(1)
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: "ws-1",
          verified: false,
          verificationStatus: "DETECTED",
          category: "external_import",
        }),
        update: {},
      })
    )
    expect(mocks.candidate).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          findingId: "finding-1",
          scannerSource: "external_import",
        }),
        update: {},
      })
    )
    expect(mocks.audit).toHaveBeenCalled()
    expect(mocks.gate).toHaveBeenCalledWith("ws-1", "target-1")
  })
  it("replays without overwriting existing findings or candidate evidence", async () => {
    await POST(request(), params)
    mocks.candidates.mockResolvedValue([
      {
        dedupeKey: mocks.candidate.mock.calls[0]![0].create.dedupeKey,
        evidenceHash: mocks.candidate.mock.calls[0]![0].create.evidenceHash,
      },
    ])
    mocks.find.mockResolvedValue({ id: "finding-1" })
    const response = await POST(request(), params)
    expect((await response.json()).data).toMatchObject({ imported: 0, corroborated: 1 })
    expect(mocks.upsert.mock.calls[1]![0].update).toEqual({})
    expect(mocks.candidate.mock.calls[1]![0].update).toEqual({})
  })
  it.each(["FIXED", "FIXED_PENDING_RETEST"])(
    "refreshes a new assessment and reopens a %s external detection",
    async (status) => {
      mocks.find.mockResolvedValue({
        id: "finding-1",
        scanId: "scan-old",
        scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
        status,
        severity: "MEDIUM",
      })
      expect((await POST(request(), params)).status).toBe(200)
      expect(mocks.upsert.mock.calls[0]![0].update).toMatchObject({
        scanId: "scan-1",
        lastSeenAt: expect.any(Date),
        severity: "HIGH",
        status: "OPEN",
        fixedAt: null,
        verified: false,
        verificationStatus: "DETECTED",
      })
      expect(mocks.gate).toHaveBeenCalledWith("ws-1", "target-1")
    }
  )
  it("retains stronger severity and deliberate human dispositions on a new detection", async () => {
    mocks.find.mockResolvedValue({
      id: "finding-1",
      scanId: "scan-old",
      scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
      status: "ACCEPTED_RISK",
      severity: "CRITICAL",
    })
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.upsert.mock.calls[0]![0].update).toMatchObject({ severity: "CRITICAL" })
    expect(mocks.upsert.mock.calls[0]![0].update).not.toHaveProperty("status")
  })
  it("does not replace a newer assessment when importing an older scan", async () => {
    mocks.find.mockResolvedValue({
      id: "finding-1",
      scanId: "scan-newer",
      scan: { createdAt: new Date("2026-09-14T00:00:00Z") },
      status: "FIXED",
      severity: "MEDIUM",
    })
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.upsert.mock.calls[0]![0].update).toEqual({})
    expect(mocks.candidate).toHaveBeenCalled()
  })
  it("preserves verification when replaying a candidate after a finding was resolved", async () => {
    await POST(request(), params)
    const dedupeKey = mocks.candidate.mock.calls[0]![0].create.dedupeKey
    mocks.candidates.mockResolvedValue([
      { dedupeKey, evidenceHash: mocks.candidate.mock.calls[0]![0].create.evidenceHash },
    ])
    mocks.find.mockResolvedValue({
      id: "finding-1",
      scanId: "scan-1",
      scan: { createdAt: new Date("2026-09-13T00:00:00Z") },
      status: "FIXED",
      severity: "HIGH",
    })
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.upsert.mock.calls[1]![0].update).toEqual({})
    expect(mocks.candidate.mock.calls[1]![0].update).toEqual({})
  })
  it("keeps semantic hashes stable when replayed JSON object keys change order", async () => {
    await POST(request(), params)
    const original = mocks.candidate.mock.calls[0]![0].create
    mocks.candidates.mockResolvedValue([original])
    mocks.find.mockResolvedValue({ id: "finding-1" })
    const reordered = {
      version: "2.1.0",
      runs: [{ results: [{ message: { text: "Detection" }, level: "error", ruleId: "test" }] }],
    }
    expect((await POST(request(reordered), params)).status).toBe(200)
    expect(mocks.candidate.mock.calls[1]![0].create.evidenceHash).toBe(original.evidenceHash)
    expect(mocks.candidate.mock.calls[1]![0].update).toEqual({})
    expect(mocks.legacyCandidate).not.toHaveBeenCalled()
  })
  it("accepts semantic replay of legacy insertion-order hashes without rewriting them", async () => {
    await POST(request(), params)
    const original = mocks.candidate.mock.calls[0]![0].create
    mocks.candidates.mockResolvedValue([
      { ...original, evidenceHash: "legacy-order-sensitive-hash" },
    ])
    mocks.legacyCandidate.mockResolvedValue({ id: "candidate-1" })
    mocks.find.mockResolvedValue({ id: "finding-1" })
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.legacyCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws-1",
          payload: { equals: original.payload },
        }),
      })
    )
    expect(mocks.candidate.mock.calls[1]![0].update).toEqual({})
  })
  it("rejects conflicting immutable evidence before saving any part of the report", async () => {
    await POST(request(), params)
    const original = mocks.candidate.mock.calls[0]![0].create
    vi.clearAllMocks()
    mocks.candidates.mockResolvedValue([original])
    mocks.legacyCandidate.mockResolvedValue(null)
    const conflict = {
      version: "2.1.0",
      runs: [
        {
          results: [
            { ruleId: "brand-new", message: { text: "Must not persist" } },
            { ruleId: "test", level: "warning", message: { text: "Detection" } },
          ],
        },
      ],
    }
    expect((await POST(request(conflict), params)).status).toBe(409)
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.candidate).not.toHaveBeenCalled()
    expect(mocks.event).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
  })
  it("rejects conflicting duplicate results inside the first import", async () => {
    const conflict = {
      version: "2.1.0",
      runs: [
        {
          results: [
            { ruleId: "test", level: "error", message: { text: "Detection" } },
            { ruleId: "test", level: "warning", message: { text: "Detection" } },
          ],
        },
      ],
    }
    expect((await POST(request(conflict), params)).status).toBe(409)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
  it("rejects malformed nested structures before writes", async () => {
    expect((await POST(request({ version: "2.1.0", runs: [null] }), params)).status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
  it("bounds streamed request bodies even when Content-Length is absent", async () => {
    const oversized = new Request("http://localhost/api/scans/s/artifacts/sarif?workspaceId=ws-1", {
      method: "POST",
      body: "a".repeat(5 * 1024 * 1024 + 1),
    })
    expect((await POST(oversized, params)).status).toBe(413)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
