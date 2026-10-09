import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

/**
 * P2-8 — accepted/rejected payload parity between the API route and the
 * published OpenAPI spec.
 *
 * The routes used to declare their own request schemas while
 * `packages/types/src/openapi/build.ts` generated the spec from a second,
 * drifted copy. The copies had already diverged: `targetId` was accepted by
 * POST /api/reports but absent from the spec, and the schedule/finding routes
 * had their own cron and search rules. Identical-schema-object assertions
 * cannot catch that, so this suite drives the SAME payloads through the route
 * handler and through the schema the spec publishes, and requires the two
 * verdicts to agree.
 *
 * The spec schema is rehydrated with `z.fromJSONSchema`, which is the only
 * reading a consumer of the published document has.
 */

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb: unknown) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    scan: { findFirst: vi.fn() },
    target: { findFirst: vi.fn() },
    schedule: { findFirst: vi.fn() },
    finding: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  listReports: vi.fn(),
  createReport: vi.fn(),
  listSchedules: vi.fn(),
  createSchedule: vi.fn(),
  getSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getNextRunAt: vi.fn(),
  listFindings: vi.fn(),
  getFindingStats: vi.fn(),
  validateFindingScope: vi.fn(),
  getFindingReference: vi.fn(),
  updateFindingStatus: vi.fn(),
  markFalsePositive: vi.fn(),
  acceptRisk: vi.fn(),
  getShareableReport: vi.fn(),
  generateShareToken: vi.fn(),
  revokeShareToken: vi.fn(),
  getLaunchReportDetail: vi.fn(),
  resolveReportDelegationTarget: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: {
    report: { create: "report:create", download: "report:download" },
    schedule: {
      view: "schedule:view",
      create: "schedule:create",
      update: "schedule:update",
      delete: "schedule:delete",
    },
    finding: {
      view: "finding:view",
      update: "finding:update",
      falsePositive: "finding:false-positive",
      acceptRisk: "finding:accept-risk",
    },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock("@/lib/cache", () => ({ revalidateDashboardAggregates: vi.fn() }))
vi.mock("@/lib/recorded-operation", () => ({
  recordedOperation: vi.fn(
    async (
      _request: Request,
      _params: unknown,
      execute: (outcome: { confirmNotSubmitted: () => void }) => Promise<Response>
    ) => execute({ confirmNotSubmitted: vi.fn() })
  ),
}))

import { buildOpenApiSpec } from "@lyrashield/types/openapi"
import { prisma } from "@lyrashield/db"
import { POST as postReport } from "../reports/route"
import { POST as postReportAction } from "../reports/[id]/route"
import { POST as postSchedule } from "../schedules/route"
import { PATCH as patchSchedule } from "../schedules/[id]/route"
import { PATCH as patchFinding } from "../findings/[id]/route"

const spec = buildOpenApiSpec() as {
  components: { schemas: Record<string, Record<string, unknown>> }
}

/**
 * Rebuild the validator a spec consumer would derive from the published
 * component. Fails loudly if the component is missing — a spec that documents
 * nothing is the defect under test.
 */
function specValidator(component: string): { safeParse: (value: unknown) => boolean } {
  const jsonSchema = spec.components.schemas[component]
  expect(jsonSchema, `spec is missing the ${component} component`).toBeDefined()
  const clone = JSON.parse(JSON.stringify(jsonSchema)) as Record<string, unknown>
  delete clone.$schema
  const schema = z.fromJSONSchema(clone as never)
  return { safeParse: (value) => schema.safeParse(value).success }
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * A payload is "accepted by the route" when validation got far enough to reach
 * a non-validation outcome. The handlers answer 400/422 for a schema failure
 * and anything else (auth, not-found, conflict, success) once the body parsed.
 */
function routeRejected(status: number): boolean {
  return status === 400 || status === 422
}

describe("POST /api/reports request-schema parity", () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: "workspace and title only", body: { workspaceId: "ws-1", title: "Report" } },
    {
      name: "scanId",
      body: { workspaceId: "ws-1", scanId: "scan-1", title: "Report" },
    },
    {
      name: "targetId (the field the spec used to omit)",
      body: { workspaceId: "ws-1", targetId: "target-1", title: "Report" },
    },
    {
      name: "type",
      body: { workspaceId: "ws-1", title: "Report", type: "compliance" },
    },
    { name: "empty workspaceId", body: { workspaceId: "", title: "Report" } },
    { name: "missing title", body: { workspaceId: "ws-1" } },
    { name: "empty title", body: { workspaceId: "ws-1", title: "" } },
    { name: "over-long title", body: { workspaceId: "ws-1", title: "a".repeat(201) } },
    { name: "unknown report type", body: { workspaceId: "ws-1", title: "R", type: "nope" } },
    { name: "numeric title", body: { workspaceId: "ws-1", title: 7 } },
    { name: "array body", body: [] },
  ]

  it.each(cases)("agrees with the spec on $name", async ({ body }) => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null as never)
    const response = await postReport(jsonRequest("http://localhost/api/reports", "POST", body))
    expect(specValidator("CreateReport").safeParse(body)).toBe(!routeRejected(response.status))
  })

  it("publishes targetId, the field that scoped a report but was undocumented", () => {
    const properties = spec.components.schemas.CreateReport?.properties as
      Record<string, unknown> | undefined
    expect(properties?.targetId).toBeDefined()
  })
})

describe("POST /api/reports/:id request-schema parity", () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: "share", body: { workspaceId: "ws-1", action: "share" } },
    { name: "revoke", body: { workspaceId: "ws-1", action: "revoke" } },
    { name: "unknown action", body: { workspaceId: "ws-1", action: "delete" } },
    { name: "missing action", body: { workspaceId: "ws-1" } },
    { name: "empty workspaceId", body: { workspaceId: "", action: "share" } },
  ]

  it.each(cases)("agrees with the spec on $name", async ({ body }) => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null as never)
    const response = await postReportAction(
      jsonRequest("http://localhost/api/reports/report-1", "POST", body),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(specValidator("ReportAction").safeParse(body)).toBe(!routeRejected(response.status))
  })
})

describe("POST /api/schedules request-schema parity", () => {
  const base = { workspaceId: "ws-1", targetId: "target-1", goal: "TEST_APP" }
  const cases: Array<{ name: string; body: unknown }> = [
    { name: "weekly cron", body: { ...base, cron: "0 0 * * 0" } },
    { name: "daily cron", body: { ...base, cron: "30 8 * * *" } },
    { name: "wildcard cron", body: { ...base, cron: "* * * * *" } },
    { name: "padded cron", body: { ...base, cron: "  0 0 * * 0  " } },
    { name: "leading-zero cron", body: { ...base, cron: "07 08 * * 06" } },
    { name: "default mode", body: { ...base, cron: "0 0 * * 0" } },
    { name: "explicit mode", body: { ...base, cron: "0 0 * * 0", mode: "DEEP" } },
    { name: "step cron", body: { ...base, cron: "*/15 * * * *" } },
    { name: "day-of-month cron", body: { ...base, cron: "0 0 31 2 *" } },
    { name: "minute out of range", body: { ...base, cron: "60 0 * * 0" } },
    { name: "hour out of range", body: { ...base, cron: "0 24 * * 0" } },
    { name: "weekday out of range", body: { ...base, cron: "0 0 * * 7" } },
    { name: "four fields", body: { ...base, cron: "0 0 * *" } },
    { name: "six fields", body: { ...base, cron: "0 0 * * 0 1" } },
    { name: "empty cron", body: { ...base, cron: "" } },
    { name: "missing cron", body: base },
    {
      name: "missing targetId",
      body: { workspaceId: "ws-1", cron: "0 0 * * 0", goal: "TEST_APP" },
    },
    { name: "empty targetId", body: { ...base, targetId: "", cron: "0 0 * * 0" } },
    { name: "unknown goal", body: { ...base, cron: "0 0 * * 0", goal: "NOPE" } },
    { name: "unknown mode", body: { ...base, cron: "0 0 * * 0", mode: "TURBO" } },
  ]

  it.each(cases)("agrees with the spec on $name", async ({ body }) => {
    vi.mocked(prisma.target.findFirst).mockResolvedValue(null as never)
    const response = await postSchedule(jsonRequest("http://localhost/api/schedules", "POST", body))
    expect(specValidator("CreateSchedule").safeParse(body)).toBe(!routeRejected(response.status))
  })
})

describe("PATCH /api/schedules/:id request-schema parity", () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: "enabled only", body: { workspaceId: "ws-1", enabled: false } },
    { name: "cron only", body: { workspaceId: "ws-1", cron: "0 0 * * 0" } },
    { name: "padded cron", body: { workspaceId: "ws-1", cron: "  0 0 * * 0  " } },
    { name: "goal only", body: { workspaceId: "ws-1", goal: "LAUNCH_REVIEW" } },
    { name: "unknown goal", body: { workspaceId: "ws-1", goal: "NOPE" } },
    { name: "step cron", body: { workspaceId: "ws-1", cron: "*/15 * * * *" } },
    { name: "empty cron", body: { workspaceId: "ws-1", cron: "" } },
    { name: "empty workspaceId", body: { workspaceId: "" } },
    { name: "missing workspaceId", body: { enabled: true } },
    { name: "mode", body: { workspaceId: "ws-1", mode: "QUICK" } },
    { name: "unknown mode", body: { workspaceId: "ws-1", mode: "TURBO" } },
  ]

  it.each(cases)("agrees with the spec on $name", async ({ body }) => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(null as never)
    const response = await patchSchedule(
      jsonRequest("http://localhost/api/schedules/sched-1", "PATCH", body),
      { params: Promise.resolve({ id: "sched-1" }) }
    )
    expect(specValidator("PatchSchedule").safeParse(body)).toBe(!routeRejected(response.status))
  })
})

describe("PATCH /api/findings/:id request-schema parity", () => {
  const cases: Array<{ name: string; body: unknown }> = [
    {
      name: "false_positive with reason",
      body: { workspaceId: "ws-1", action: "false_positive", reason: "not exploitable" },
    },
    {
      name: "accept_risk with reason",
      body: { workspaceId: "ws-1", action: "accept_risk", reason: "accepted" },
    },
    {
      name: "update_status with a settable status",
      body: { workspaceId: "ws-1", action: "update_status", status: "FIXED" },
    },
    {
      name: "canonicalFindingId",
      body: { workspaceId: "ws-1", action: "update_status", canonicalFindingId: "finding-1" },
    },
    { name: "unknown action", body: { workspaceId: "ws-1", action: "delete" } },
    { name: "missing action", body: { workspaceId: "ws-1" } },
    { name: "empty workspaceId", body: { workspaceId: "", action: "update_status" } },
    {
      name: "status the route never sets (TICKET_CREATED)",
      body: { workspaceId: "ws-1", action: "update_status", status: "TICKET_CREATED" },
    },
    {
      name: "unknown status",
      body: { workspaceId: "ws-1", action: "update_status", status: "NOPE" },
    },
    {
      name: "over-long reason",
      body: { workspaceId: "ws-1", action: "update_status", reason: "a".repeat(1001) },
    },
  ]

  it.each(cases)("agrees with the spec on $name", async ({ body }) => {
    vi.mocked(prisma.finding.findFirst).mockResolvedValue(null as never)
    const response = await patchFinding(
      jsonRequest("http://localhost/api/findings/finding-1", "PATCH", body),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(specValidator("PatchFinding").safeParse(body)).toBe(!routeRejected(response.status))
  })

  /**
   * The one documented, deliberate asymmetry: `false_positive` and
   * `accept_risk` require a reason, enforced by a `superRefine` that JSON
   * Schema cannot express. The route must reject the payload the spec accepts
   * here, and this test pins that direction so a future change that silently
   * drops the refinement fails loudly.
   */
  it("still enforces the reason requirement the spec cannot express", async () => {
    const body = { workspaceId: "ws-1", action: "false_positive" }
    vi.mocked(prisma.finding.findFirst).mockResolvedValue(null as never)
    const response = await patchFinding(
      jsonRequest("http://localhost/api/findings/finding-1", "PATCH", body),
      { params: Promise.resolve({ id: "finding-1" }) }
    )
    expect(routeRejected(response.status)).toBe(true)
    expect(specValidator("PatchFinding").safeParse(body)).toBe(true)
  })
})

describe("GET /api/findings query parity", () => {
  // The findings query is a GET, so it is driven through the published
  // FindingQuery component rather than a request body. `queryParamsFromSchema`
  // turns that component into the documented query parameters, so every
  // accepted parameter must round-trip through it.
  it("documents exactly the parameters the route validates", () => {
    const properties = spec.components.schemas.FindingQuery?.properties as
      Record<string, unknown> | undefined
    expect(properties).toBeDefined()
    expect(Object.keys(properties!).sort()).toEqual(
      [
        "workspaceId",
        "targetId",
        "observedInScanId",
        "scanId",
        "severity",
        "status",
        "verified",
        "category",
        "q",
        "stats",
        "cursor",
        "limit",
      ].sort()
    )
  })

  it("publishes the 120-character search bound as a machine-readable pattern", () => {
    const q = (
      spec.components.schemas.FindingQuery?.properties as Record<string, { pattern?: string }>
    ).q
    expect(typeof q?.pattern).toBe("string")
  })

  const searchCases: Array<{ name: string; value: string; accepted: boolean }> = [
    { name: "short term", value: "xss", accepted: true },
    { name: "trimmed term", value: "  xss  ", accepted: true },
    { name: "exactly 120", value: "a".repeat(120), accepted: true },
    { name: "121 characters", value: "a".repeat(121), accepted: false },
    { name: "121 trimmed from padded 124", value: `  ${"a".repeat(120)}  `, accepted: true },
    { name: "padded past 120", value: `  ${"a".repeat(121)}  `, accepted: false },
    { name: "whitespace only", value: "   ", accepted: true },
  ]

  it.each(searchCases)("agrees with the spec on the q bound: $name", ({ value, accepted }) => {
    expect(specValidator("FindingQuery").safeParse({ workspaceId: "ws-1", q: value })).toBe(
      accepted
    )
  })
})
