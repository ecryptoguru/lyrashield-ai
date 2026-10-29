import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MARKETING_EVENT_ALLOWLIST, sanitizeMarketingProperties } from "../lib/posthog-privacy"
import { LITE_SCAN_HREF, LITE_TARGET_KEY, submitLiteHandoff } from "../lib/lite-handoff"

const hero = readFileSync(
  new URL("../components/landing/PremiumHero.astro", import.meta.url),
  "utf8"
)
const homeScan = readFileSync(
  new URL("../components/landing/HomeLiteScan.astro", import.meta.url),
  "utf8"
)
const handoff = readFileSync(new URL("../lib/lite-handoff.ts", import.meta.url), "utf8")

describe("hero URL field handoff (item 3.1b)", () => {
  it("parks the target in sessionStorage and never in the query string", () => {
    const parked: Array<[string, string]> = []
    const navigated: string[] = []
    const original = globalThis.sessionStorage
    // A minimal stand-in so the handoff can be exercised without a browser.
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        setItem: (key: string, value: string) => parked.push([key, value]),
        getItem: () => null,
        removeItem: () => {},
      },
    })
    try {
      const result = submitLiteHandoff("https://app.example.com", {
        navigate: (href) => navigated.push(href),
      })
      expect(result.ok).toBe(true)
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original })
    }

    expect(parked).toEqual([[LITE_TARGET_KEY, "https://app.example.com/"]])

    // The navigation carries the start flag only. The target must not be in it.
    expect(navigated).toEqual([LITE_SCAN_HREF])
    expect(navigated[0]).not.toContain("app.example.com")
    expect(LITE_SCAN_HREF).toBe("/scan?start=1")
  })

  it("rejects an invalid URL without parking or navigating", () => {
    const parked: Array<[string, string]> = []
    const navigated: string[] = []
    const original = globalThis.sessionStorage
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        setItem: (key: string, value: string) => parked.push([key, value]),
        getItem: () => null,
        removeItem: () => {},
      },
    })
    try {
      for (const bad of ["", "   ", "localhost", "ftp://example.com", "https://user:pw@a.com"]) {
        const result = submitLiteHandoff(bad, { navigate: (href) => navigated.push(href) })
        expect(result.ok, `${bad} must be rejected`).toBe(false)
      }
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original })
    }
    expect(parked).toEqual([])
    expect(navigated).toEqual([])
  })

  it("keeps one consent-bound URL form and a distinct sample section", () => {
    // Duplicate ids would make the consent box and the error line ambiguous.
    for (const id of [
      "hero-lite-form",
      "hero-scan-url",
      "hero-scan-authorized",
      "hero-scan-error",
    ]) {
      expect(hero, `hero must own ${id}`).toContain(`id="${id}"`)
    }
    for (const id of [
      "home-lite-scan-form",
      "home-scan-url",
      "home-scan-authorized",
      "home-scan-error",
    ]) {
      expect(homeScan, `the sample must not repeat ${id}`).not.toContain(`id="${id}"`)
    }
    const heroIds = [...hero.matchAll(/id="([^"]+)"/g)].map((match) => match[1])
    const scanIds = [...homeScan.matchAll(/id="([^"]+)"/g)].map((match) => match[1])
    for (const id of heroIds) expect(scanIds).not.toContain(id)
  })

  it("makes no network request from the hero", () => {
    expect(hero).not.toContain("fetch(")
    expect(hero).not.toContain("XMLHttpRequest")
    expect(hero).not.toContain("sendBeacon")
  })

  it("shares one handoff implementation instead of forking it", () => {
    // The single homepage form uses the shared privacy-preserving handoff.
    expect(hero).toContain('from "../../lib/lite-handoff"')
    expect(homeScan).not.toContain("<form")
    expect(handoff).toContain('export const LITE_TARGET_KEY = "lyrashield-lite-target"')
    expect(handoff).toContain('export const LITE_SCAN_HREF = "/scan?start=1"')
    // The navigation call must not be handed the target.
    expect(handoff).toContain("navigate(LITE_SCAN_HREF)")
    expect(handoff).not.toMatch(/navigate\([^)]*target/)
  })

  it("requires consent before handing off", () => {
    // /scan pre-checks its own box and auto-submits, so a hero form with no
    // recorded consent would start a scan the visitor never agreed to.
    expect(handoff).toContain("if (consent && !consent.checked)")
    expect(hero).toContain('consentId: "hero-scan-authorized"')
    expect(hero).toContain("I own this app or have permission to test it")
    expect(hero).toContain('href="/terms"')
  })

  it("degrades without JavaScript and when the scanner is not connected", () => {
    // With JS off the submit button does nothing, so the field must sit next to
    // a real link to /scan.
    expect(hero).toContain('href="/scan"')
    // The sole input retains a clear unavailable state.
    expect(hero).toContain("disabled={!scannerAvailable}")
    expect(hero).toContain(
      "The separately protected scanner API is not connected in this environment."
    )
    expect(homeScan).toContain('href="/scan"')
  })

  it("sends only a CTA id and a boolean to analytics", () => {
    expect(MARKETING_EVENT_ALLOWLIST.hero_lite_check_submit).toEqual(["cta_id", "valid"])
    const sanitized = sanitizeMarketingProperties("hero_lite_check_submit", {
      cta_id: "hero_lite_check_submit",
      valid: true,
      url: "https://victim.example",
      target_url: "https://victim.example",
      target_domain_hash: "abc123",
    })
    expect(sanitized).toEqual({ cta_id: "hero_lite_check_submit", valid: true })
    // The typed value is not a property anywhere in the component.
    expect(hero).not.toMatch(/capture\([^)]*input\.value/)
  })
})
