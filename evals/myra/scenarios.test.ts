/**
 * Corpus integrity test — every scenario fixture parses and satisfies the
 * harness's required shape. Runs under the root vitest config
 * (`pnpm test:core`); it does not execute scenarios (that's `run.ts`).
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { MYRA_TOOL_NAMES } from "../../packages/myra/src/contracts"
import { isManifestRoute } from "../../packages/myra/src/route-manifest"

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), "scenarios")

const CATEGORIES = new Set([
  "knowledge",
  "diagnostic",
  "permission",
  "action",
  "handoff",
  "accessibility",
])
const PERSONAS = new Set(["anonymous", "user", "operator"])
const OUTCOMES = new Set([
  "answered",
  "abstained",
  "escalated",
  "action_proposed",
  "action_done",
  "error",
])
const EXPECT_KEYS = new Set([
  "outcome",
  "toolsUsed",
  "toolsNotUsed",
  "mustContain",
  "mustNotContain",
  "components",
  "proposalRequired",
  "denied",
  "sanitized",
  "memoryKeysOnly",
  "bookingCount",
  "caseCount",
  "completedOperationCount",
  "providerCalls",
  "maxCtaComponents",
  "anyOf",
])
const ACTION_TYPES = new Set([
  "confirm",
  "revokeRole",
  "switchWorkspace",
  "takeover",
  "message",
  "suggest",
])
const TOOL_NAME_SET = new Set<string>(MYRA_TOOL_NAMES)

interface Fixture {
  id: string
  title: string
  category: string
  persona: string
  requiresProvider?: boolean
  routeContext?: string
  input: string
  actions?: { type: string }[]
  expect: Record<string, unknown>
}

const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json"))
const fixtures: [string, Fixture][] = files.map((f) => [
  f,
  JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")) as Fixture,
])

describe("myra scenario corpus", () => {
  it("has at least 24 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(24)
  })

  it("has unique ids matching filenames", () => {
    const ids = fixtures.map(([, f]) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [file, f] of fixtures) {
      expect(f.id, `${file}: id should equal filename`).toBe(file.replace(/\.json$/, ""))
    }
  })

  it("covers all 20 required adversarial scenarios plus knowledge cases", () => {
    const ids = new Set(fixtures.map(([, f]) => f.id))
    for (let i = 1; i <= 20; i++) {
      const adv = [...ids].find((id) => id.startsWith(`adv-${String(i).padStart(2, "0")}-`))
      expect(adv, `missing adversarial scenario ${i}`).toBeTruthy()
    }
    expect(fixtures.filter(([, f]) => f.category === "knowledge").length).toBeGreaterThanOrEqual(4)
    for (const cat of ["diagnostic", "handoff", "accessibility", "permission", "action"]) {
      expect(
        fixtures.some(([, f]) => f.category === cat),
        `missing category ${cat}`
      ).toBe(true)
    }
  })

  it("every fixture has the required shape", () => {
    for (const [file, f] of fixtures) {
      expect(typeof f.title, file).toBe("string")
      expect(CATEGORIES.has(f.category), `${file} category`).toBe(true)
      expect(PERSONAS.has(f.persona), `${file} persona`).toBe(true)
      expect(typeof f.input === "string" && f.input.length > 0, `${file} input`).toBe(true)
      expect(typeof f.expect === "object" && f.expect !== null, `${file} expect`).toBe(true)
    }
  })

  it("every expect uses recognized keys and valid values", () => {
    const check = (exp: Record<string, unknown>, where: string) => {
      for (const k of Object.keys(exp)) {
        expect(EXPECT_KEYS.has(k), `${where}: unknown expect key ${k}`).toBe(true)
      }
      const outcomes = Array.isArray(exp.outcome)
        ? exp.outcome
        : exp.outcome !== undefined
          ? [exp.outcome]
          : []
      for (const o of outcomes) {
        expect(OUTCOMES.has(o as string), `${where}: bad outcome ${String(o)}`).toBe(true)
      }
      for (const key of ["toolsUsed", "toolsNotUsed"] as const) {
        for (const tool of (exp[key] as string[] | undefined) ?? []) {
          expect(TOOL_NAME_SET.has(tool), `${where}: unknown tool ${tool}`).toBe(true)
        }
      }
      for (const alt of (exp.anyOf as Record<string, unknown>[] | undefined) ?? []) {
        check(alt, `${where}.anyOf`)
      }
    }
    for (const [file, f] of fixtures) check(f.expect, file)
  })

  it("every action uses a supported type", () => {
    for (const [file, f] of fixtures) {
      for (const a of f.actions ?? []) {
        expect(ACTION_TYPES.has(a.type), `${file}: bad action ${a.type}`).toBe(true)
      }
    }
  })

  it("routeContext values resolve in the manifest", () => {
    for (const [file, f] of fixtures) {
      if (f.routeContext) {
        expect(
          isManifestRoute(f.routeContext),
          `${file}: dead routeContext ${f.routeContext}`
        ).toBe(true)
      }
    }
  })
})
