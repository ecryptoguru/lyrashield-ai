import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The /terms intro previously rendered "OurPrivacy page explains how we handle
 * data" — the JSX line break between the word "Our" and the anchor swallowed the
 * space — and the two inline links carried no colour or underline.
 *
 * The swallowed-space class of bug is covered across every template by
 * swallowed-space.test.ts; this file pins the specific page the report named.
 */
const terms = readFileSync(new URL("../pages/terms.astro", import.meta.url), "utf8")

const INTRO_LINK_CLASS =
  'class="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"'

function intro(): string {
  return terms.slice(
    terms.indexOf("These terms are an agreement"),
    terms.indexOf('<div class="prose')
  )
}

describe("Terms intro links", () => {
  it("keeps a space between 'Our' and the Privacy link", () => {
    // The explicit {" "} is what stops the compiler dropping the gap.
    expect(intro()).toMatch(/Our\{" "\}/)
    expect(intro()).not.toMatch(/Our\n\s*<a/)
  })

  it("styles both intro links with the accent colour and an underline", () => {
    expect(intro()).toContain('href="/terms-of-sale"')
    expect(intro()).toContain('href="/privacy"')
    expect(intro().split(INTRO_LINK_CLASS).length - 1).toBe(2)
  })
})
