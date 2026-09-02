import { describe, expect, it } from "vitest"

import {
  AI_BUILT_FAILURE_TAXONOMY,
  AI_BUILT_FAILURE_MAP,
  AI_BUILT_TAXONOMY_VERSION,
  classesCoveredBy,
  coveredSurfaces,
} from "./ai-built-failure-taxonomy"
import { VIBE_SECURITY_CONTROLS } from "./vibe-security-controls"
import { WEBMCP_CONTROLS_BY_ID } from "./webmcp/controls"

describe("AI-Built Failure Taxonomy (WP6)", () => {
  it("is named and versioned", () => {
    expect(AI_BUILT_TAXONOMY_VERSION).toBe("ai-built-failure-taxonomy/1.0.0")
  })

  it("has unique, stable class ids", () => {
    const ids = AI_BUILT_FAILURE_TAXONOMY.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^AIB-\d{2}$/)
  })

  it("every class has a description, a why-ai-built mechanism, and at least one detection surface", () => {
    for (const c of AI_BUILT_FAILURE_TAXONOMY) {
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.whyAiBuilt.length).toBeGreaterThan(0)
      expect(c.coveredBy.length).toBeGreaterThan(0)
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(c.severity)
    }
  })

  it("maps each class to a detection surface that exists", () => {
    const valid = new Set([
      "engine",
      "sca",
      "secrets",
      "sast",
      "agent_config",
      "ai_app_security",
      "url",
      "webmcp",
    ])
    for (const c of AI_BUILT_FAILURE_TAXONOMY) {
      for (const s of c.coveredBy) expect(valid.has(s)).toBe(true)
    }
  })

  it("every referenced controlId resolves to a real registry entry (traceability)", () => {
    // Existence, not just format: a controlId that drifts out of its registry
    // (a control removed or renumbered) breaks the taxonomy's coverage claim
    // silently — this pins every id against the live registries.
    const vibeRanks = new Set(VIBE_SECURITY_CONTROLS.map((c) => c.rank))
    for (const c of AI_BUILT_FAILURE_TAXONOMY) {
      for (const id of c.controlIds) {
        expect(id === "" || /^(vibe-\d{2}|WEBMCP-\d{2})$/.test(id)).toBe(true)
        if (id.startsWith("vibe-")) {
          const rank = Number(id.slice("vibe-".length))
          expect(vibeRanks.has(rank)).toBe(true)
        } else if (id !== "") {
          expect(id in WEBMCP_CONTROLS_BY_ID).toBe(true)
        }
      }
    }
  })

  it("carries no benchmark or detection-rate claims (copy discipline)", () => {
    const json = JSON.stringify(AI_BUILT_FAILURE_TAXONOMY).toLowerCase()
    for (const banned of [
      "% ",
      "percent",
      "detection rate",
      "accuracy",
      "false positive rate",
      "benchmark",
      "%",
    ]) {
      expect(json.includes(banned)).toBe(false)
    }
  })

  it("AI_BUILT_FAILURE_MAP is a complete lookup", () => {
    expect(Object.keys(AI_BUILT_FAILURE_MAP).length).toBe(AI_BUILT_FAILURE_TAXONOMY.length)
    expect(AI_BUILT_FAILURE_MAP["AIB-01"]?.title).toContain("Service keys")
  })

  it("coverage helpers are consistent with the catalog", () => {
    const surfaces = coveredSurfaces()
    expect(surfaces.length).toBeGreaterThan(0)
    for (const c of AI_BUILT_FAILURE_TAXONOMY) {
      for (const s of c.coveredBy) {
        expect(classesCoveredBy(s).some((x) => x.id === c.id)).toBe(true)
      }
    }
  })
})
