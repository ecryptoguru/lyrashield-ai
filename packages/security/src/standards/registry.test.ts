import { describe, expect, it } from "vitest"
import { VIBE_SECURITY_CONTROLS } from "../vibe-security-controls"
import {
  STANDARDS_REGISTRY,
  STANDARDS_REGISTRY_VERSION,
  defaultStandards,
  type Standard,
} from "./registry"
import { renderStandard, renderStandards } from "./render"

const VIBE_RANKS = new Set(VIBE_SECURITY_CONTROLS.map((c) => c.rank))
const FAMILY_NAMES = new Set([
  "engine",
  "sca",
  "secrets",
  "agent_config",
  "ml_supply_chain",
  "ai_app_security",
  "sast",
  "iac",
  "url",
  "external_import",
])

describe("standards registry", () => {
  it("is named and versioned", () => {
    expect(STANDARDS_REGISTRY_VERSION).toBe("standards-registry/1.0.0")
  })

  it("ships 16 standards with 5 on the default surface", () => {
    expect(STANDARDS_REGISTRY).toHaveLength(16)
    expect(defaultStandards().map((s) => s.id).sort()).toEqual([
      "asvs-l1",
      "cwe-top25",
      "owasp-api-top10",
      "owasp-llm-top10",
      "owasp-top10",
    ])
  })

  it("pins every standard to an explicit version", () => {
    for (const standard of STANDARDS_REGISTRY) {
      expect(standard.version.length).toBeGreaterThan(0)
      expect(standard.categories.length).toBeGreaterThan(0)
    }
  })

  it("every mapped controlId resolves to a real vibe control rank", () => {
    for (const standard of STANDARDS_REGISTRY) {
      for (const category of standard.categories) {
        for (const rank of category.controlIds ?? []) {
          expect(VIBE_RANKS.has(rank), `${standard.id}/${category.id} → vibe-${rank}`).toBe(true)
        }
      }
    }
  })

  it("every evaluator is a real scanner family", () => {
    for (const standard of STANDARDS_REGISTRY) {
      for (const category of standard.categories) {
        for (const family of category.evaluators ?? []) {
          expect(FAMILY_NAMES.has(family), `${standard.id}/${category.id} → ${family}`).toBe(true)
        }
      }
    }
  })

  it("category ids are unique within each standard", () => {
    for (const standard of STANDARDS_REGISTRY) {
      const ids = standard.categories.map((c) => c.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe("renderStandard", () => {
  const standard: Standard = {
    id: "test-standard",
    name: "Test Standard",
    version: "1.0",
    defaultSurface: false,
    categories: [
      {
        id: "T-1",
        title: "Scanner-covered",
        evaluators: ["sast"],
        cweHints: ["CWE-89"],
      },
      { id: "T-2", title: "Attestable only", evaluators: [], attestable: true },
      { id: "T-3", title: "Engine-only", evaluators: ["engine"], controlIds: [5] },
      { id: "T-4", title: "Nothing mapped", evaluators: [] },
    ],
  }

  it("marks evaluated only when a family completed or a finding signals", () => {
    const view = renderStandard(
      standard,
      [
        { controlId: "sast", scanner: "sast", status: "COMPLETED" },
        { controlId: "engine", scanner: "engine", status: "COMPLETED" },
      ],
      []
    )
    const states = Object.fromEntries(view.categories.map((c) => [c.id, c.state]))
    expect(states["T-1"]).toBe("evaluated")
    expect(states["T-2"]).toBe("requires-attestation")
    expect(states["T-3"]).toBe("evaluated")
    expect(states["T-4"]).toBe("not-evaluated")
    expect(view.evaluated).toBe(2)
  })

  it("treats a blocked family as not-evaluated, never as coverage", () => {
    const view = renderStandard(
      standard,
      [{ controlId: "sast", scanner: "sast", status: "BLOCKED" }],
      []
    )
    expect(view.categories.find((c) => c.id === "T-1")?.state).toBe("not-evaluated")
  })

  it("counts CWE-matched findings as violation signals with evaluation", () => {
    const view = renderStandard(standard, [], [{ cwe: "CWE-89" }])
    const cat = view.categories.find((c) => c.id === "T-1")
    expect(cat?.state).toBe("evaluated")
    expect(cat?.violationSignals).toBe(1)
    expect(view.violationSignals).toBe(1)
  })

  it("ignores control receipts when looking up families", () => {
    // A vibe-05 control receipt is not the engine family receipt.
    const view = renderStandard(
      standard,
      [{ controlId: "vibe-05", scanner: "engine", status: "COMPLETED" }],
      []
    )
    expect(view.categories.find((c) => c.id === "T-3")?.state).toBe("not-evaluated")
  })

  it("renders the full registry without throwing", () => {
    const views = renderStandards(STANDARDS_REGISTRY, [], [])
    expect(views).toHaveLength(16)
    for (const view of views) {
      expect(view.evaluated + view.requiresAttestation + view.notEvaluated).toBe(
        view.categories.length
      )
    }
  })
})
