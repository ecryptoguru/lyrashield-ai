import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const activation = readFileSync(
  new URL("./src/screens/ActivationScreen.tsx", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const setup = readFileSync(new URL("./src/screens/SetupScreen.tsx", import.meta.url), "utf8")
// eslint-disable-next-line security/detect-non-literal-fs-filename
const scan = readFileSync(new URL("./src/screens/ScanScreen.tsx", import.meta.url), "utf8")

describe("desktop setup accessibility", () => {
  it("keeps newly labeled forms usable in short and narrow windows", () => {
    expect(activation).toContain("min-h-screen items-center justify-center bg-background p-4")
    expect(setup.match(/min-h-screen items-center justify-center bg-background p-4/g)).toHaveLength(
      3
    )
    expect(activation).toContain("p-6 shadow-sm sm:p-8")
    expect(setup.match(/p-6 shadow-sm sm:p-8/g)).toHaveLength(2)
  })

  it("labels sensitive inputs and announces setup failures", () => {
    expect(activation).toContain('htmlFor="license-key"')
    expect(activation).toContain("spellCheck={false}")
    expect(setup).toContain('htmlFor="azure-api-key"')
    expect(setup).toContain('htmlFor="azure-endpoint"')
    expect(setup).toContain('type="url"')
    expect(setup.match(/role="alert"/g)).toHaveLength(2)
  })

  it("labels and bounds the BYOK scan budget before launch", () => {
    expect(scan).toContain('htmlFor="scan-budget"')
    expect(scan).toContain('id="scan-budget-help"')
    expect(scan).toContain('min="0.01"')
    expect(scan).toContain('max="100"')
    expect(scan).toContain("aria-invalid={!budgetValid}")
    expect(scan).toContain('role="alert"')
    expect(scan).toContain("onClick={() => setMode(m.value)}")
    for (const id of ["scan-path", "scan-branch", "scan-instruction"]) {
      expect(scan).toContain(`htmlFor="${id}"`)
      expect(scan).toContain(`id="${id}"`)
    }
    expect(scan).toContain("BYOK maximum model budget")
  })

  it("offers only the three public depths and keeps URL targets visibly disabled", () => {
    // Depth choices are derived from the shared profile contract fixture, not
    // a hand-maintained list — and retired modes can never be launched.
    expect(scan).toContain('fixtures/scan-depths.json"')
    expect(scan).toContain("DEPTH_OPTIONS.map((m)")
    expect(scan).not.toContain('"url"')
    expect(scan).not.toContain('"safe"')
    expect(scan).not.toContain('"custom"')
    // The URL target kind stays visible as a disabled choice with a reason,
    // never a silent BYOK-billed AI substitution.
    expect(scan).toContain("URL_TARGET_UNAVAILABLE_REASON")
    expect(scan).toContain('aria-disabled="true"')
  })
})
