import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const page = readFileSync(new URL("../pages/scan.astro", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const home = readFileSync(new URL("../pages/index.astro", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const homeScan = readFileSync(
  new URL("../components/landing/HomeLiteScan.astro", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const assurancePreview = readFileSync(
  new URL("../components/landing/AssuranceRecord.astro", import.meta.url),
  "utf8"
)

describe("Lite Check marketing surface", () => {
  it("keeps the founder-provided promise and permission copy", () => {
    expect(page).toContain("Free security check for AI-built apps")
    expect(page).toContain("Scan my app")
    expect(page).toContain("Scan only apps you own or have permission to test")
    expect(page).toContain("We only read what your app already sends to any visitor.")
  })

  it("labels the result as a limited Lite Check, never the official score", () => {
    expect(page).toContain("Lite Check · not the LyraShield Score")
    expect(page).toContain("a clean result here isn't a guarantee")
    expect(page).not.toMatch(/your app is secure|no vulnerabilities found/i)
  })

  it("does not gate the on-screen result behind email", () => {
    expect(page.indexOf('id="results"')).toBeLessThan(page.indexOf('id="capture-form"'))
    expect(page).toContain('source: "lite_scanner"')
  })

  it("documents passive limits and privacy-safe sharing", () => {
    expect(page).toContain("no active RLS test")
    expect(page).toContain("It never queries a table or collection")
    expect(page).toContain("target_domain_hash")
    expect(page).toContain("needsAttention: s.needsAttention")
    expect(page).not.toContain("secretValue")
  })

  it("publishes WebApplication and FAQ structured data behind the global indexability gate", () => {
    expect(page).toContain('"@type": "WebApplication"')
    expect(page).toContain('"@type": "FAQPage"')
    expect(page).toContain("canonical={canonical}")
  })

  it("fails closed when the separately deployed app API has no public origin", () => {
    expect(page).toContain("const scannerAvailable = Boolean(appOrigin)")
    expect(page).toContain("disabled={!scannerAvailable}")
    expect(page).toContain(
      "This preview will not send a target to localhost or another fallback service."
    )
    expect(page).not.toContain('|| "http://localhost:3001"')
  })

  it("does not claim that fix PR execution is already available", () => {
    expect(page).toContain("prepares a fix proposal")
    expect(page).toContain("PR execution stays blocked")
    expect(page).not.toContain("opens a fix PR")
  })

  it("shows honest scan activity without inventing a completion percentage", () => {
    expect(page).toContain("Reading the public surface")
    expect(page).toContain('data-status="Reading public HTML and same-origin assets."')
    expect(page).toContain('role="status"')
    expect(page).toContain("prefers-reduced-motion: reduce")
    expect(page).toContain("active >= steps.length")
    expect(page).toContain("await progress.finished")
    expect(page).not.toContain("setInterval")
    expect(page).not.toMatch(/scan-progress|\d+% complete/i)
  })

  it("accepts bare domains and normalizes them to HTTPS before scanning", () => {
    expect(page).toContain('id="scan-url" name="url" type="text" inputmode="url"')
    expect(page).toContain("return /^https?:\\/\\//i.test(value) ? value : `https://${value}`")
    expect(page).toContain("lyrashieldai.com or https://your-app.com")
    expect(homeScan).toContain("lyrashieldai.com or https://your-app.com")
  })

  it("previews the future product with clearly labeled sample and registry data", () => {
    expect(assurancePreview).toContain("Illustrative product preview · sample data")
    expect(assurancePreview).toContain("Counts show product states, not production performance.")
    expect(assurancePreview).toContain("Vibe Security 50 registry")
    expect(assurancePreview).toContain(">43<")
    expect(assurancePreview).toContain(">7<")
    expect(assurancePreview).toContain(">50<")
    expect(assurancePreview).toContain('href="/sample-report"')
  })

  it("starts the real Lite Check from the homepage without putting the target in the URL", () => {
    expect(home).toContain("<HomeLiteScan />")
    expect(homeScan).toContain('id="free-scan"')
    expect(homeScan).toContain('sessionStorage.setItem("lyrashield-lite-target", target)')
    expect(homeScan).toContain('location.assign("/scan?start=1")')
    expect(homeScan).toContain("Enter a valid public HTTP or HTTPS URL without credentials.")
    expect(homeScan).toContain('href="/terms"')
    expect(page).toContain('sessionStorage.getItem("lyrashield-lite-target")')
    expect(page).toContain("scanForm?.requestSubmit()")
    expect(homeScan).not.toMatch(/location\.assign\([^)]*target/)
  })
})
