import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import { describe, expect, it } from "vitest"
import { CTA_LABEL, TRIAL_LINE, TRIAL_SUMMARY, buildTrialLine } from "../lib/site-copy"

const marketingRoot = fileURLToPath(new URL("../", import.meta.url))

/** Every .astro / .ts source under src, excluding tests, blog content and the hero. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "content") continue
      sourceFiles(full, found)
      continue
    }
    if (!name.endsWith(".astro") && !name.endsWith(".ts")) continue
    // The hero CTA labels are owned by Wave 3 item 3.1, which is blocked on the
    // five-second test (D12). It is excluded here until that item lands.
    if (full.endsWith("components/landing/PremiumHero.astro")) continue
    found.push(full)
  }
  return found
}

/** Strip HTML and block comments so explanatory prose is not matched. */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("site copy single source", () => {
  it("builds the trial line from the TRIAL catalog entry", () => {
    const trial = CLOUD_PLAN_MAP.TRIAL
    expect(TRIAL_LINE).toContain(`${trial.agentMinutes} agent-minutes`)
    expect(TRIAL_LINE).toContain("7 days")
    expect(TRIAL_LINE).toContain(`${trial.targetCaps} targets`)
    expect(TRIAL_LINE).toContain("no card")
    // The line is derived, not hardcoded: a catalog change moves the copy.
    expect(buildTrialLine({ days: 9, agentMinutes: 42, targets: 4 })).toBe(
      "9 days · 42 agent-minutes · 4 targets · no card"
    )
    expect(TRIAL_SUMMARY).toBe("7-day limited trial: 60 agent-minutes, up to 3 targets, no card")
  })

  it("exports the single sign-up CTA label", () => {
    expect(CTA_LABEL.signUp).toBe("Start free trial")
    expect(CTA_LABEL.liteCheck).toBe("Run Lite Check")
  })

  it("keeps the retired sign-up labels out of every marketing page source", () => {
    // The vocabulary lock retires these labels from product and trust pages.
    // Blog posts are published history and are excluded by the content skip.
    const retired = [
      "Get started",
      "Start a review",
      "Create an account",
      "Create account",
      "Create free account",
      "Create a free account",
      "Start Free Trial",
      "Review this app for real",
    ]
    const violations: string[] = []
    for (const file of sourceFiles(marketingRoot)) {
      const body = stripComments(readFileSync(file, "utf8"))
      for (const label of retired) {
        if (body.includes(label)) violations.push(`${file.replace(marketingRoot, "")}: ${label}`)
      }
    }
    expect(violations).toEqual([])
  })
})
