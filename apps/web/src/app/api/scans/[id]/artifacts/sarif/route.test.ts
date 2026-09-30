import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

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
  revalidate: vi.fn(),
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
vi.mock("../../../../../../lib/cache", () => ({
  revalidateDashboardAggregates: mocks.revalidate,
}))
import { POST } from "./route"
import { parseSarifReport } from "@lyrashield/security"

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
function sarifDedupeKey(body: unknown = sarif) {
  const parsed = parseSarifReport(body, "target-1")
  if ("error" in parsed) throw new Error(parsed.error)
  return parsed.findings[0]!.dedupeKey
}
function rawSql(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join("?")
}
function rawValues(call: unknown[]) {
  return call.slice(1).flat(Infinity)
}
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested: unknown) =>
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.entries(nested).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0
            )
          )
        : nested
    ) ?? "null"
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.raw.mockResolvedValue(1)
  mocks.permission.mockResolvedValue({ session: { userId: "user-1" } })
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
describe("SARIF import route", () => {
  it("requires write permission and binds reads to the requested workspace", async () => {
    mocks.permission.mockRejectedValue(new Error("FORBIDDEN"))
    expect((await POST(request(), params)).status).toBe(403)
    expect(mocks.scan).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
  it("does not extend scan-create OAuth grants to arbitrary imports", async () => {
    mocks.permission.mockResolvedValue({
      session: { userId: "user-1", oauth: { connectionId: "c" } },
    })
    expect((await POST(request(), params)).status).toBe(403)
    expect(mocks.createFindings).not.toHaveBeenCalled()
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
    expect(mocks.createFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            workspaceId: "ws-1",
            verified: false,
            verificationStatus: "DETECTED",
            category: "external_import",
          }),
        ],
        skipDuplicates: true,
      })
    )
    expect(mocks.createCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            findingId: "finding-1",
            scannerSource: "external_import",
          }),
        ],
        skipDuplicates: true,
      })
    )
    expect(mocks.audit).toHaveBeenCalled()
    expect(mocks.gate).toHaveBeenCalledWith("ws-1", "target-1")
    expect(mocks.revalidate).toHaveBeenCalledWith("ws-1")
  })
  it("coalesces same-import duplicates to the highest severity without placeholder updates", async () => {
    const body = {
      version: "2.1.0",
      runs: [
        {
          results: [
            { ruleId: "test", level: "note", message: { text: "Detection" } },
            { ruleId: "test", level: "error", message: { text: "Detection" } },
          ],
        },
      ],
    }
    const parsed = parseSarifReport(body, "target-1")
    if ("error" in parsed) throw new Error(parsed.error)
    const selected = parsed.findings[1]!

    const response = await POST(request(body), params)

    expect(response.status).toBe(200)
    expect((await response.json()).data.imported).toBe(1)
    expect(mocks.createFindings).toHaveBeenCalledTimes(1)
    expect(mocks.createFindings.mock.calls[0]![0].data).toHaveLength(1)
    expect(mocks.createFindings.mock.calls[0]![0].data[0]).toMatchObject({
      severity: "HIGH",
      summary: "Detection",
    })
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
    const candidate = mocks.createCandidates.mock.calls[0]![0].data[0]
    expect(mocks.createCandidates.mock.calls[0]![0].data).toHaveLength(1)
    expect(candidate.payload).toEqual(selected.payload)
    expect(candidate.evidenceHash).toBe(
      createHash("sha256").update(canonicalJson(selected.payload)).digest("hex")
    )
    expect(mocks.raw.mock.calls.some((call) => rawSql(call).includes('UPDATE "Finding"'))).toBe(
      false
    )
  })
  it("replays without overwriting existing findings or candidate evidence", async () => {
    await POST(request(), params)
    const candidate = mocks.createCandidates.mock.calls[0]![0].data[0]
    mocks.candidates.mockResolvedValue([
      { dedupeKey: candidate.dedupeKey, evidenceHash: candidate.evidenceHash },
    ])
    mocks.findings.mockResolvedValue([{ id: "finding-1", dedupeKey: candidate.dedupeKey }])
    const response = await POST(request(), params)
    expect((await response.json()).data).toMatchObject({ imported: 0, corroborated: 1 })
    expect(mocks.createFindings).toHaveBeenCalledTimes(1)
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
  })
  it.each(["FIXED", "FIXED_PENDING_RETEST"])(
    "refreshes a new assessment and reopens a %s external detection",
    async (status) => {
      mocks.findings.mockResolvedValue([
        {
          dedupeKey: sarifDedupeKey(),
          id: "finding-1",
          scanId: "scan-old",
          scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
          status,
          severity: "MEDIUM",
        },
      ])
      expect((await POST(request(), params)).status).toBe(200)
      const refresh = mocks.raw.mock.calls.find((call) => rawSql(call).includes('UPDATE "Finding"'))
      expect(refresh).toBeDefined()
      expect(rawValues(refresh!)).toContain("finding-1")
      expect(rawValues(refresh!)).toContain("HIGH")
      expect(rawValues(refresh!)).toContain(true)
      expect(rawSql(refresh!)).toContain('"fixedAt"')
      expect(mocks.gate).toHaveBeenCalledWith("ws-1", "target-1")
    }
  )
  it("retains stronger severity and deliberate human dispositions on a new detection", async () => {
    mocks.findings.mockResolvedValue([
      {
        dedupeKey: sarifDedupeKey(),
        id: "finding-1",
        scanId: "scan-old",
        scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
        status: "ACCEPTED_RISK",
        severity: "CRITICAL",
      },
    ])
    expect((await POST(request(), params)).status).toBe(200)
    const refresh = mocks.raw.mock.calls.find((call) => rawSql(call).includes('UPDATE "Finding"'))
    expect(rawValues(refresh!)).toContain("CRITICAL")
    expect(rawValues(refresh!)).toContain(false)
  })
  it("does not replace a newer assessment when importing an older scan", async () => {
    mocks.findings.mockResolvedValue([
      {
        dedupeKey: sarifDedupeKey(),
        id: "finding-1",
        scanId: "scan-newer",
        scan: { createdAt: new Date("2026-09-14T00:00:00Z") },
        status: "FIXED",
        severity: "MEDIUM",
      },
    ])
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.raw.mock.calls.some((call) => rawSql(call).includes('UPDATE "Finding"'))).toBe(
      false
    )
    expect(mocks.createCandidates).toHaveBeenCalled()
  })
  it("preserves verification when replaying a candidate after a finding was resolved", async () => {
    await POST(request(), params)
    const dedupeKey = mocks.createCandidates.mock.calls[0]![0].data[0].dedupeKey
    mocks.candidates.mockResolvedValue([
      { dedupeKey, evidenceHash: mocks.createCandidates.mock.calls[0]![0].data[0].evidenceHash },
    ])
    mocks.findings.mockResolvedValue([
      {
        id: "finding-1",
        dedupeKey,
        scanId: "scan-1",
        scan: { createdAt: new Date("2026-09-13T00:00:00Z") },
        status: "FIXED",
        severity: "HIGH",
      },
    ])
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.raw.mock.calls.some((call) => rawSql(call).includes('UPDATE "Finding"'))).toBe(
      false
    )
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
  })
  it("keeps semantic hashes stable when replayed JSON object keys change order", async () => {
    await POST(request(), params)
    const original = mocks.createCandidates.mock.calls[0]![0].data[0]
    mocks.candidates.mockResolvedValue([original])
    mocks.findings.mockResolvedValue([{ id: "finding-1", dedupeKey: original.dedupeKey }])
    const reordered = {
      version: "2.1.0",
      runs: [{ results: [{ message: { text: "Detection" }, level: "error", ruleId: "test" }] }],
    }
    expect((await POST(request(reordered), params)).status).toBe(200)
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
  })
  it("accepts semantic replay of legacy insertion-order hashes without rewriting them", async () => {
    await POST(request(), params)
    const original = mocks.createCandidates.mock.calls[0]![0].data[0]
    mocks.candidates
      .mockResolvedValueOnce([{ ...original, evidenceHash: "legacy-order-sensitive-hash" }])
      .mockResolvedValueOnce([{ dedupeKey: original.dedupeKey, payload: original.payload }])
    mocks.findings.mockResolvedValue([{ id: "finding-1", dedupeKey: original.dedupeKey }])
    expect((await POST(request(), params)).status).toBe(200)
    expect(mocks.candidates).toHaveBeenCalledTimes(3)
    expect(mocks.candidates.mock.calls[2]![0].where.OR).toContainEqual({
      dedupeKey: original.dedupeKey,
      payload: { equals: original.payload },
    })
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
  })
  it("rejects conflicting immutable evidence before saving any part of the report", async () => {
    await POST(request(), params)
    const original = mocks.createCandidates.mock.calls[0]![0].data[0]
    vi.clearAllMocks()
    mocks.candidates.mockResolvedValue([original])
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
    expect(mocks.createFindings).not.toHaveBeenCalled()
    expect(mocks.createCandidates).not.toHaveBeenCalled()
    expect(
      mocks.raw.mock.calls.filter((call) => rawSql(call).includes('UPDATE "Finding"'))
    ).toHaveLength(0)
    expect(mocks.event).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
  })
  it("rejects conflicting non-severity evidence inside the first import", async () => {
    const conflict = {
      version: "2.1.0",
      runs: [
        {
          results: [
            { ruleId: "test", level: "error", message: { text: "Detection" } },
            {
              ruleId: "test",
              level: "warning",
              message: { text: "Detection" },
              properties: { sourceRevision: "different" },
            },
          ],
        },
      ],
    }
    expect((await POST(request(conflict), params)).status).toBe(409)
    expect(mocks.createFindings).not.toHaveBeenCalled()
  })
  it("rejects malformed nested structures before writes", async () => {
    expect((await POST(request({ version: "2.1.0", runs: [null] }), params)).status).toBe(400)
    expect(mocks.createFindings).not.toHaveBeenCalled()
  })
  it("bounds streamed request bodies even when Content-Length is absent", async () => {
    const oversized = new Request("http://localhost/api/scans/s/artifacts/sarif?workspaceId=ws-1", {
      method: "POST",
      body: "a".repeat(5 * 1024 * 1024 + 1),
    })
    expect((await POST(oversized, params)).status).toBe(413)
    expect(mocks.createFindings).not.toHaveBeenCalled()
  })

  it("imports the 2,000-result limit in a bounded number of database calls", async () => {
    const results = Array.from({ length: 2_000 }, (_, index) =>
      index === 0
        ? { ruleId: "test", level: "error", message: { text: "Detection" } }
        : { ruleId: `rule-${index}`, level: "error", message: { text: `Detection ${index}` } }
    )
    const body = { version: "2.1.0", runs: [{ results }] }
    const parsed = parseSarifReport(body, "target-1")
    if ("error" in parsed) throw new Error(parsed.error)
    const [replay, older, reopen, stronger] = parsed.findings
    await POST(request(), params)
    const priorCandidate = mocks.createCandidates.mock.calls[0]![0].data[0]
    vi.clearAllMocks()
    mocks.candidates.mockResolvedValue([priorCandidate])
    mocks.findings.mockResolvedValue([
      {
        id: "finding-older",
        dedupeKey: older!.dedupeKey,
        scanId: "scan-newer",
        status: "OPEN",
        severity: "MEDIUM",
        scan: { createdAt: new Date("2026-09-14T00:00:00Z") },
      },
      {
        id: "finding-fixed",
        dedupeKey: reopen!.dedupeKey,
        scanId: "scan-old",
        status: "FIXED",
        severity: "LOW",
        scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
      },
      {
        id: "finding-accepted",
        dedupeKey: stronger!.dedupeKey,
        scanId: "scan-old",
        status: "ACCEPTED_RISK",
        severity: "CRITICAL",
        scan: { createdAt: new Date("2026-09-12T00:00:00Z") },
      },
      {
        id: "finding-replay",
        dedupeKey: replay!.dedupeKey,
        scanId: "scan-1",
        status: "OPEN",
        severity: "HIGH",
        scan: { createdAt: new Date("2026-09-13T00:00:00Z") },
      },
    ])
    mocks.createFindings.mockImplementation(async ({ data }: { data: { dedupeKey: string }[] }) =>
      data.map((finding, index) => ({ id: `finding-${index + 1}`, dedupeKey: finding.dedupeKey }))
    )

    const response = await POST(request(body), params)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ imported: 1_996, corroborated: 4 })
    expect(mocks.findings).toHaveBeenCalledTimes(1)
    expect(mocks.candidates).toHaveBeenCalledTimes(1)
    expect(mocks.createFindings).toHaveBeenCalledTimes(1)
    expect(mocks.createFindings.mock.calls[0]![0].data).toHaveLength(1_996)
    expect(mocks.createCandidates).toHaveBeenCalledTimes(1)
    expect(mocks.createCandidates.mock.calls[0]![0].data).toHaveLength(1_999)
    const updates = mocks.raw.mock.calls.filter((call) => rawSql(call).includes('UPDATE "Finding"'))
    expect(updates).toHaveLength(1)
    expect(updates[0]![1]).toEqual(["finding-fixed", "finding-accepted"])
    expect(updates[0]![4]).toEqual(["HIGH", "CRITICAL"])
    expect(updates[0]![5]).toEqual([true, false])
    expect(rawSql(updates[0]!)).toContain('ELSE f."status"')
  })
})
