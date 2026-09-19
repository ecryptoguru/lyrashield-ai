import { describe, expect, it } from "vitest"
import { buildOpenApiSpec } from "./build"

const spec = buildOpenApiSpec() as {
  components: { schemas: Record<string, Record<string, unknown>> }
  paths: Record<string, Record<string, Record<string, unknown>>>
}

function responseSchema(path: string, method: string, status: string): unknown {
  const responses = spec.paths[path]?.[method]?.responses as
    | Record<string, Record<string, unknown>>
    | undefined
  return responses?.[status]?.content?.["application/json"]?.schema
}

describe("openapi workflow/provenance contract", () => {
  it("exposes the immutable execution plan component", () => {
    const plan = spec.components.schemas.ScanExecutionPlan
    expect(plan).toBeDefined()
    const props = plan.properties as Record<string, unknown>
    for (const field of [
      "version",
      "workflow",
      "targetType",
      "depth",
      "profileId",
      "scope",
      "source",
      "limits",
      "capabilities",
      "attachmentIds",
    ]) {
      expect(props[field]).toBeDefined()
    }
    const workflow = props.workflow as { enum?: string[] }
    expect(workflow.enum).toEqual(
      expect.arrayContaining([
        "REVIEW_TARGET",
        "REVIEW_CHANGES",
        "AUTHENTICATED_ASSESSMENT",
      ])
    )
    const scope = props.scope as { enum?: string[] }
    expect(scope.enum).toEqual(["SNAPSHOT", "DIFF", "LIVE"])
  })

  it("exposes distinct verification tiers on the Finding component", () => {
    const status = spec.components.schemas.FindingVerificationStatus
    expect(status?.enum).toEqual([
      "DETECTED",
      "VALIDATED",
      "VERIFIED",
      "BLOCKED",
      "INCONCLUSIVE",
    ])
    const finding = spec.components.schemas.Finding
    const props = finding?.properties as Record<string, unknown>
    expect(props.verified).toBeDefined()
    expect(props.verificationStatus).toBeDefined()
    // The doc must never collapse the tiers into the boolean.
    expect(String(finding?.description)).toContain("DETECTED")
    expect(String(finding?.description)).toContain("VERIFIED")
  })

  it("documents the recorded workflow inputs on CreateScan", () => {
    const createScan = spec.components.schemas.CreateScan
    const props = createScan.properties as Record<string, unknown>
    expect(props.workflow).toBeDefined()
    expect(props.baseRef).toBeDefined()
    expect(props.headRef).toBeDefined()
    expect(props.attachmentIds).toBeDefined()
  })

  it("returns typed Scan results from scan endpoints", () => {
    const scanRef = { $ref: "#/components/schemas/Scan" }
    for (const [path, method, status] of [
      ["/scans", "get", "200"],
      ["/scans", "post", "201"],
      ["/scans/{id}", "get", "200"],
    ] as const) {
      expect(JSON.stringify(responseSchema(path, method, status))).toContain(
        scanRef.$ref
      )
    }
    expect(
      JSON.stringify(responseSchema("/findings", "get", "200"))
    ).toContain("#/components/schemas/Finding")
  })
})
