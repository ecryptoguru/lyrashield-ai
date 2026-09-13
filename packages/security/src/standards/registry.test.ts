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
    expect(STANDARDS_REGISTRY_VERSION).toBe("standards-registry/1.1.0")
  })

  it("ships 11 reviewed mappings with 5 on the default surface", () => {
    expect(STANDARDS_REGISTRY).toHaveLength(11)
    expect(
      defaultStandards()
        .map((s) => s.id)
        .sort()
    ).toEqual(["asvs-l1", "cwe-top25", "owasp-api-top10", "owasp-llm-top10", "owasp-top10"])
  })

  it("does not expose unverified external standard identifiers", () => {
    for (const id of ["mitre-atlas", "cis-benchmarks", "aisvs", "iso27001-evidence", "slsa"]) {
      expect(STANDARDS_REGISTRY.find((standard) => standard.id === id)).toBeUndefined()
    }
  })

  it("pins every standard to an explicit version", () => {
    for (const standard of STANDARDS_REGISTRY) {
      expect(standard.version.length).toBeGreaterThan(0)
      expect(standard.categories.length).toBeGreaterThan(0)
    }
  })

  it("pins the actual OWASP category editions rather than relabeling older lists", () => {
    expect(STANDARDS_REGISTRY.find((standard) => standard.id === "owasp-top10")?.version).toBe(
      "2021"
    )
    expect(STANDARDS_REGISTRY.find((standard) => standard.id === "owasp-llm-top10")?.version).toBe(
      "2025"
    )
  })

  it("matches MITRE's 2024 Top 25 membership and ranking", () => {
    const expected = [
      79, 787, 89, 352, 22, 125, 78, 416, 862, 434, 94, 20, 77, 287, 269, 502, 200, 863, 918, 119,
      476, 798, 190, 400, 306,
    ]
    expect(
      STANDARDS_REGISTRY.find((standard) => standard.id === "cwe-top25")?.categories.map(
        (category) => category.id
      )
    ).toEqual(expected.map((id) => `CWE-${id}`))
  })

  it("uses real ASVS 5.0 L1 references and discloses its selected subset", () => {
    const asvs = STANDARDS_REGISTRY.find((standard) => standard.id === "asvs-l1")!
    expect(asvs.badge).toContain("not a complete ASVS assessment")
    expect(asvs.categories.map((category) => category.id)).toEqual([
      "V1.2.1",
      "V1.2.4",
      "V1.2.5",
      "V1.3.2",
      "V3.3.1",
      "V3.4.1",
      "V3.4.2",
      "V6.1.1",
      "V8.1.1",
      "V8.2.1",
      "V8.2.2",
      "V11.3.1",
      "V11.3.2",
      "V11.4.1",
      "V12.2.1",
      "V13.4.1",
    ])
  })

  it("does not credit crypto-only SAST with memory safety, injection or authorization coverage", () => {
    const receipts = [{ scanner: "sast", controlId: "sast", status: "COMPLETED" }]
    const cwe = renderStandard(
      STANDARDS_REGISTRY.find((standard) => standard.id === "cwe-top25")!,
      receipts,
      []
    )
    expect(cwe.evaluated).toBe(0)
    const api = renderStandard(
      STANDARDS_REGISTRY.find((standard) => standard.id === "owasp-api-top10")!,
      receipts,
      []
    )
    expect(api.evaluated).toBe(0)
    const web = renderStandard(
      STANDARDS_REGISTRY.find((standard) => standard.id === "owasp-top10")!,
      receipts,
      []
    )
    expect(
      web.categories
        .filter((category) => category.state === "evaluated")
        .map((category) => category.id)
    ).toEqual(["A02", "A05", "A07"])
  })

  it("does not map a different OWASP edition's tag onto the same category number", () => {
    const web = STANDARDS_REGISTRY.find((standard) => standard.id === "owasp-top10")!
    const view = renderStandard(web, [], [{ owaspCategory: "A02:2025-Security Misconfiguration" }])
    expect(view.violationSignals).toBe(0)
    expect(
      renderStandard(web, [], [{ owaspCategory: "A02:2021-Cryptographic Failures" }])
        .violationSignals
    ).toBe(1)
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

  it("counts a finding once when both CWE and OWASP tags match a category", () => {
    const view = renderStandard(standard, [], [{ cwe: "CWE-89", owaspCategory: "T-1" }])
    expect(view.categories.find((category) => category.id === "T-1")?.violationSignals).toBe(1)
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

  it("keeps organizational attestation required when scanner evidence exists", () => {
    const mapped: Standard = {
      ...standard,
      categories: [
        {
          id: "ORG-1",
          title: "Organization-owned control",
          evaluators: ["engine"],
          attestable: true,
        },
      ],
    }
    const view = renderStandard(
      mapped,
      [{ scanner: "engine", controlId: "engine", status: "COMPLETED" }],
      []
    )
    expect(view.categories[0]).toMatchObject({ state: "evaluated", attestable: true })
    expect(view.evaluated).toBe(1)
    expect(view.requiresAttestation).toBe(1)
  })

  it("renders the full registry without throwing", () => {
    const views = renderStandards(STANDARDS_REGISTRY, [], [])
    expect(views).toHaveLength(11)
    for (const view of views) {
      expect(
        view.evaluated +
          view.categories.filter((category) => category.state === "requires-attestation").length +
          view.notEvaluated
      ).toBe(view.categories.length)
    }
  })
})
