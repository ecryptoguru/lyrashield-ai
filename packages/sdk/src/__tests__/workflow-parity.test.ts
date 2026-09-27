import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { LyraShieldClient } from "../client"
import { createScan, getScan } from "../resources/scans"
import { ScanSchema, FindingSchema } from "../schemas"

/**
 * Parity matrix driven by the shared scan-workflows fixture
 * (packages/types/src/fixtures/scan-workflows.json). The same request fields
 * go out identically from every client — this suite pins the SDK's wire shape
 * to that contract and proves the response schemas expose the recorded
 * workflow/scope/provenance plan plus the distinct verification tiers.
 */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../types/src/fixtures/scan-workflows.json", import.meta.url)),
    "utf8"
  )
) as {
  version: string
  cases: Array<{
    name: string
    targetType: string
    request: {
      mode: string
      workflow?: string
      baseRef?: string
      headRef?: string
    }
    expectedPlan?: { workflow: string; targetType: string; depth: string; scope: string }
    expectError?: string
  }>
}

function mockResponse(body: unknown, status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

describe("scan workflow parity matrix", () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: LyraShieldClient

  beforeEach(() => {
    mockFetch = vi.fn()
    client = new LyraShieldClient({
      apiKey: "test-key",
      apiUrl: "http://localhost:3000",
      workspaceId: "ws-parity",
      fetchFn: mockFetch as unknown as typeof fetch,
    })
  })

  it.each(fixture.cases)("serializes the fixture request verbatim: $name", async (fixtureCase) => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          id: "scan-1",
          goal: "TEST_APP",
          mode: fixtureCase.request.mode,
          status: "QUEUED",
          createdAt: "2026-09-19T00:00:00.000Z",
        },
      })
    )

    await createScan(client, {
      targetId: `target-${fixtureCase.targetType.toLowerCase()}`,
      goal: "TEST_APP",
      ...fixtureCase.request,
    })

    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    // The request fields cross the wire unchanged — no renaming, no
    // inference, no client-supplied plan fields.
    for (const [key, value] of Object.entries(fixtureCase.request)) {
      expect(body[key]).toEqual(value)
    }
    expect(body).not.toHaveProperty("executionPlan")
    expect(body).not.toHaveProperty("executionPlanHash")
    expect(body).not.toHaveProperty("limits")
    expect(body).not.toHaveProperty("capabilities")
  })

  it("forwards attachmentIds as immutable input references", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          id: "scan-2",
          goal: "TEST_APP",
          mode: "STANDARD",
          status: "QUEUED",
          createdAt: "2026-09-19T00:00:00.000Z",
        },
      })
    )

    await createScan(client, {
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "STANDARD",
      attachmentIds: ["att_01", "att_02"],
    })

    const init = mockFetch.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body.attachmentIds).toEqual(["att_01", "att_02"])
  })

  it("parses the recorded execution plan on a scan result", async () => {
    const plan = {
      version: "lyrashield-scan-plan/1.0.0",
      workflow: "REVIEW_CHANGES",
      targetType: "REPO",
      depth: "QUICK",
      profileId: "REPO_QUICK",
      scope: "DIFF",
      source: {
        revision: "a".repeat(40),
        baseRevision: "b".repeat(40),
        mergeBaseRevision: "c".repeat(40),
      },
      limits: {
        maxDurationMs: 900000,
        maxEngineMs: 720000,
        scannerReserveMs: 180000,
        maxBudgetUsd: 1.2,
      },
      capabilities: ["engine", "sca"],
      attachmentIds: [],
    }
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        {
          success: true,
          data: {
            id: "scan-rc",
            goal: "CHECK_PR",
            mode: "QUICK",
            status: "QUEUED",
            createdAt: "2026-09-19T00:00:00.000Z",
            executionPlan: plan,
            executionPlanHash: "f".repeat(64),
          },
        },
        200
      )
    )

    const scan = await getScan(client, "scan-rc")
    expect(ScanSchema.parse(scan).executionPlan).toMatchObject({
      workflow: "REVIEW_CHANGES",
      scope: "DIFF",
      source: { mergeBaseRevision: "c".repeat(40) },
    })
  })

  it("treats a missing execution plan as not recorded, never fabricated", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        {
          success: true,
          data: {
            id: "legacy-1",
            goal: "TEST_APP",
            mode: "SAFE",
            status: "COMPLETED",
            createdAt: "2026-01-01T00:00:00.000Z",
            executionPlan: null,
            executionPlanHash: null,
          },
        },
        200
      )
    )
    const scan = await getScan(client, "legacy-1")
    const parsed = ScanSchema.parse(scan)
    expect(parsed.executionPlan).toBeNull()
  })

  it("keeps verification tiers distinct on finding payloads", () => {
    const base = {
      id: "f-1",
      workspaceId: "ws-parity",
      scanId: "s-1",
      title: "t",
      severity: "HIGH",
      status: "OPEN",
      createdAt: "2026-09-19T00:00:00.000Z",
    }
    const detected = FindingSchema.parse({
      ...base,
      verified: false,
      verificationStatus: "DETECTED",
      verificationMethod: "ENGINE_CLAIM",
    })
    expect(detected.verificationStatus).toBe("DETECTED")
    const verified = FindingSchema.parse({
      ...base,
      verified: true,
      verificationStatus: "VERIFIED",
      verificationMethod: "RETEST",
    })
    expect(verified.verificationStatus).toBe("VERIFIED")
    // A bogus tier fails validation instead of silently normalizing.
    expect(FindingSchema.safeParse({ ...base, verificationStatus: "PROVEN" }).success).toBe(false)
  })
})
