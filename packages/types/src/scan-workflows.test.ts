import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  buildScanExecutionPlan,
  SCAN_EXECUTION_PLAN_VERSION,
  ScanWorkflowSchema,
} from "./scan-execution-plan"
import { CreateScanInputSchema, CreateScanSchema, FindingVerificationStatusSchema } from "./index"

/**
 * The checked-in scan-workflows fixture is the single parity contract every
 * client (SDK, CLI, MCP, GitHub Action, Desktop) and the API share. Tests in
 * each package consume it; this suite proves the fixture itself stays aligned
 * with the schemas and plan builder it describes.
 */
const fixture = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in parity fixture
  readFileSync(fileURLToPath(new URL("./fixtures/scan-workflows.json", import.meta.url)), "utf8")
) as {
  version: string
  workflows: string[]
  verificationStatuses: {
    trustTiers: string[]
    nonConclusive: string[]
    neverConflate: boolean
  }
  cases: Array<{
    name: string
    targetType: "REPO" | "WEB_APP" | "API"
    request: Record<string, unknown>
    expectedPlan?: {
      workflow: string
      targetType: string
      depth: string
      scope: string
    }
    expectError?: string
  }>
}

const FULL_SHA = "a".repeat(40)

describe("scan-workflows parity fixture", () => {
  it("covers exactly the workflows the contract exposes", () => {
    expect([...fixture.workflows].sort()).toEqual([...ScanWorkflowSchema.options].sort())
    expect(fixture.version).toBe("scan-workflows/1.0.0")
  })

  it("keeps verification trust tiers distinct and complete", () => {
    const all = [
      ...fixture.verificationStatuses.trustTiers,
      ...fixture.verificationStatuses.nonConclusive,
    ]
    // Fixture tiers cover the shared enum exactly — nothing collapses.
    expect([...all].sort()).toEqual([...FindingVerificationStatusSchema.options].sort())
    expect(new Set(all).size).toBe(all.length)
    expect(fixture.verificationStatuses.neverConflate).toBe(true)
    // DETECTED is detection only — never VALIDATED or VERIFIED.
    expect(fixture.verificationStatuses.trustTiers[0]).toBe("DETECTED")
    expect(fixture.verificationStatuses.trustTiers).toContain("VALIDATED")
    expect(fixture.verificationStatuses.trustTiers).toContain("VERIFIED")
  })

  it("requires a REVIEW_CHANGES fixture for REPO and rejections for live targets", () => {
    const diffCases = fixture.cases.filter((c) => c.request.workflow === "REVIEW_CHANGES")
    expect(diffCases.some((c) => c.targetType === "REPO" && c.expectedPlan)).toBe(true)
    for (const c of diffCases.filter((c) => c.targetType !== "REPO")) {
      expect(c.expectError).toBe("SCAN_PLAN_INVALID")
    }
  })

  it.each(fixture.cases)("case $name parses as a create-scan input", (c) => {
    const parsed = CreateScanInputSchema.safeParse({
      workspaceId: "ws-fixture",
      targetId: "target-fixture",
      goal: "TEST_APP",
      ...c.request,
    })
    expect(parsed.success).toBe(true)
    // The plain object schema used by OpenAPI generation stays in parity.
    const plain = CreateScanSchema.safeParse({
      workspaceId: "ws-fixture",
      targetId: "target-fixture",
      goal: "TEST_APP",
      ...c.request,
    })
    expect(plain.success).toBe(true)
  })

  it.each(fixture.cases.filter((c) => c.expectedPlan))(
    "case $name builds the expected server-owned plan",
    (c) => {
      const plan = buildScanExecutionPlan({
        workflow: c.request.workflow as "REVIEW_TARGET" | "REVIEW_CHANGES",
        targetType: c.targetType,
        mode: c.request.mode as string,
        ...(c.request.workflow === "REVIEW_CHANGES"
          ? {
              source: {
                revision: FULL_SHA,
                baseRevision: "b".repeat(40),
                mergeBaseRevision: "c".repeat(40),
              },
            }
          : {}),
      })
      expect(plan).toMatchObject({
        version: SCAN_EXECUTION_PLAN_VERSION,
        ...c.expectedPlan,
      })
    }
  )

  it.each(fixture.cases.filter((c) => c.expectError === "SCAN_PLAN_INVALID"))(
    "case $name cannot produce a valid plan",
    (c) => {
      expect(() =>
        buildScanExecutionPlan({
          workflow: "REVIEW_CHANGES",
          targetType: c.targetType,
          mode: c.request.mode as string,
          source: {
            revision: FULL_SHA,
            baseRevision: "b".repeat(40),
            mergeBaseRevision: "c".repeat(40),
          },
        })
      ).toThrowError()
    }
  )

  it("case 'authenticated assessment is unavailable' builds no plan without an authorization ref", () => {
    expect(() =>
      buildScanExecutionPlan({
        workflow: "AUTHENTICATED_ASSESSMENT",
        targetType: "WEB_APP",
        mode: "DEEP",
      })
    ).toThrowError(/authorization reference/i)
  })

  it("requires authorizationRef at the input schema for AUTHENTICATED_ASSESSMENT only", () => {
    const base = {
      workspaceId: "ws-1",
      targetId: "t-1",
      goal: "TEST_APP",
      mode: "DEEP",
    }
    // Missing on the beta workflow → rejected.
    expect(
      CreateScanInputSchema.safeParse({ ...base, workflow: "AUTHENTICATED_ASSESSMENT" }).success
    ).toBe(false)
    // Present on any other workflow → rejected; the reference can never leak
    // into a plan that does not verify it.
    expect(
      CreateScanInputSchema.safeParse({
        ...base,
        workflow: "REVIEW_TARGET",
        authorizationRef: "authz_1",
      }).success
    ).toBe(false)
    // Well-formed beta input parses — the server still applies the gated
    // admission and verifies the recorded authorization.
    expect(
      CreateScanInputSchema.safeParse({
        ...base,
        workflow: "AUTHENTICATED_ASSESSMENT",
        authorizationRef: "authz_1",
      }).success
    ).toBe(true)
  })

  it("never derives scan depth from target shape", () => {
    // Depth comes from the explicit mode only: the same STANDARD request must
    // map to STANDARD on every target type, never to a target-implied tier.
    for (const targetType of ["REPO", "WEB_APP", "API"] as const) {
      const plan = buildScanExecutionPlan({
        workflow: "REVIEW_TARGET",
        targetType,
        mode: "STANDARD",
      })
      expect(plan.depth).toBe("STANDARD")
    }
  })
})
