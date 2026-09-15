/**
 * Unit tests for the guided-flow definitions (spec §13.2). Flows are
 * deterministic step graphs: every verification check must reference a real
 * read-only tool, every deep link must resolve in the route manifest, and
 * route suggestions must not point at dead routes.
 */
import { describe, expect, it } from "vitest"
import { MYRA_TOOL_NAMES } from "./contracts"
import { GUIDED_FLOWS, getFlow, suggestFlows } from "./flows"
import { isManifestRoute } from "./route-manifest"

/** Tools the spec marks read-only — the only kind a flow check may run. */
const READ_ONLY_CHECK_TOOLS = new Set([
  "search_public_help",
  "read_product_catalog",
  "instant_suggest",
  "get_my_context",
  "get_scan_status",
  "get_connection_health",
  "verify_resolution",
  "read_memory",
  "read_own_case",
])

describe("GUIDED_FLOWS structure", () => {
  it("has unique flow ids", () => {
    const ids = GUIDED_FLOWS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every flow has required fields and unique step ids", () => {
    for (const flow of GUIDED_FLOWS) {
      expect(flow.id.length, flow.id).toBeGreaterThan(0)
      expect(flow.title.length, flow.id).toBeGreaterThan(0)
      expect(flow.surfaces.length, flow.id).toBeGreaterThan(0)
      for (const surface of flow.surfaces) {
        expect(["marketing", "app"]).toContain(surface)
      }
      expect(flow.steps.length, flow.id).toBeGreaterThan(0)
      const stepIds = flow.steps.map((s) => s.id)
      expect(new Set(stepIds).size, flow.id).toBe(stepIds.length)
      for (const step of flow.steps) {
        expect(step.title.length, `${flow.id}.${step.id}`).toBeGreaterThan(0)
        expect(step.instruction.length, `${flow.id}.${step.id}`).toBeGreaterThan(0)
      }
    }
  })

  it("every step check references a registered tool", () => {
    for (const flow of GUIDED_FLOWS) {
      for (const step of flow.steps) {
        if (!step.check) continue
        expect(
          MYRA_TOOL_NAMES as readonly string[],
          `${flow.id}.${step.id} check.tool`
        ).toContain(step.check.tool)
        expect(step.check.expect.length, `${flow.id}.${step.id}`).toBeGreaterThan(0)
      }
    }
  })

  it("every step check is a read-only tool (steps never write)", () => {
    for (const flow of GUIDED_FLOWS) {
      for (const step of flow.steps) {
        if (!step.check) continue
        expect(
          READ_ONLY_CHECK_TOOLS.has(step.check.tool),
          `${flow.id}.${step.id} uses non-read tool ${step.check.tool}`
        ).toBe(true)
      }
    }
  })

  it("every ctaRoute resolves in the route manifest", () => {
    for (const flow of GUIDED_FLOWS) {
      for (const step of flow.steps) {
        if (!step.ctaRoute) continue
        expect(
          isManifestRoute(step.ctaRoute),
          `${flow.id}.${step.id} ctaRoute ${step.ctaRoute}`
        ).toBe(true)
      }
    }
  })

  it("every suggestOnRoutes entry is a real manifest route", () => {
    for (const flow of GUIDED_FLOWS) {
      for (const route of flow.suggestOnRoutes) {
        expect(isManifestRoute(route), `${flow.id} suggests dead route ${route}`).toBe(true)
      }
    }
  })
})

describe("flow lookup helpers", () => {
  it("getFlow returns the definition or undefined", () => {
    expect(getFlow("scan_wont_start")?.title).toBe("Get your scan running")
    expect(getFlow("does_not_exist")).toBeUndefined()
  })

  it("suggestFlows matches the route context", () => {
    expect(suggestFlows("/dashboard/scans").map((f) => f.id).sort()).toEqual([
      "scan_wont_start",
      "understand_result",
    ])
    expect(suggestFlows("/pricing").map((f) => f.id)).toEqual(["trial_help"])
    expect(suggestFlows("/dashboard").map((f) => f.id).sort()).toEqual([
      "scan_wont_start",
      "trial_help",
    ])
  })

  it("suggestFlows returns nothing for missing or unknown routes", () => {
    expect(suggestFlows(null)).toEqual([])
    expect(suggestFlows(undefined)).toEqual([])
    expect(suggestFlows("")).toEqual([])
    expect(suggestFlows("/not-a-route")).toEqual([])
  })
})
