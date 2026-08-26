import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// eslint-disable-next-line security/detect-non-literal-fs-filename
const activation = readFileSync(
  new URL("./src/screens/ActivationScreen.tsx", import.meta.url),
  "utf8"
)
// eslint-disable-next-line security/detect-non-literal-fs-filename
const setup = readFileSync(new URL("./src/screens/SetupScreen.tsx", import.meta.url), "utf8")

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
})
