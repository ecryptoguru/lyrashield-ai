import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
describe("v26 precise public claims", () => {
  it("conditions a fix on complete deterministic evidence and leaves incomplete retests inconclusive", () => {
    const source = read("../pages/compare/[slug].astro")
    expect(source).not.toContain("a fresh retest confirms a fix")
    expect(source).toContain("complete deterministic retest")
    expect(source).toContain("matching evidence and coverage")
    expect(source).toContain("inconclusive")
  })
  it("defines rounding and plan-specific availability next to pricing claims", () => {
    const source = read("../pages/pricing.astro")
    expect(source).toContain("Positive partial minutes round up before the multiplier")
    expect(source).toContain("plan.deepAllowed ?")
    expect(source).toContain("Availability and delivery terms are agreed with Sales")
    expect(
      source.match(/Positive partial minutes round up before the multiplier/g)?.length
    ).toBeGreaterThanOrEqual(3)
  })
  it.each(["whitepaper", "yellowpaper"])(
    "keeps %s historical assessments distinct from applicability without append-only guarantees",
    (name) => {
      const source = read(`../../../../docs/${name}.md`)
      expect(source).not.toMatch(
        /Historical verdicts are immutable|immutable historical verdict|separate from immutable history|whether an immutable assessment/
      )
      expect(source).toContain("stored historical assessment")
      expect(source).toMatch(/immutable (?:worker )?digest|immutable vendor marketplace release/)
    }
  )
})
