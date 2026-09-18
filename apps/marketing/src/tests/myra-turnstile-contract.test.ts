/**
 * Regression contract for the Myra Turnstile configuration and the marketing
 * panel flag (audit findings UF-01/UF-02).
 *
 * Two production defects motivated these assertions:
 *  1. `myra-session.ts` rendered the Turnstile widget with `size: "invisible"`,
 *     which Turnstile rejects — the widget never rendered, so no token could be
 *     minted and every credential-issuing Myra call failed closed with
 *     "Please retry the abuse check." forever. The valid invisibility mechanism
 *     is `appearance: "interaction-only"`.
 *  2. `Base.astro` read `import.meta.env.PUBLIC_MYRA_MARKETING_ENABLED`, which
 *     the marketing build never populates (wrangler vars are not build env), so
 *     the launcher could never mount even with the wrangler var set to "1".
 *
 * These are source contracts: they fail loudly if either regression returns.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL(path, import.meta.url), "utf8")
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("Myra Turnstile configuration", () => {
  const session = stripComments(read("../components/myra/myra-session.ts"))

  it("never passes the invalid size value to Turnstile", () => {
    expect(session).not.toContain('size: "invisible"')
    expect(session).not.toContain("'invisible'")
  })

  it("renders the widget with a valid size and the interaction-only appearance", () => {
    expect(session).toContain('size: "flexible"')
    expect(session).toContain('appearance: "interaction-only"')
  })

  it("uses explicit execute() execution to match the execute call", () => {
    expect(session).toContain('execution: "execute"')
  })

  it("re-selects a visible host per request instead of pinning one widget", () => {
    expect(session).toContain("querySelectorAll")
    expect(session).not.toContain("turnstileWidgetId")
    expect(session).not.toContain("turnstileInFlight")
  })

  it("does not declare the rejected size value in its Turnstile typings", () => {
    expect(session).not.toMatch(/size\?:[^\n]*invisible/)
  })

  it("prefers a visible challenge host so a required interaction can be completed", () => {
    expect(session).toContain("MYRA_TURNSTILE_SELECTOR")
    expect(session).toContain("getClientRects")
  })
})

describe("Myra panel + demo challenge hosts", () => {
  it("exposes a challenge host in the panel markup", () => {
    const panel = read("../components/myra/MyraPanel.astro")
    const hostIndex = panel.indexOf("data-myra-turnstile")
    const panelIndex = panel.indexOf('id="myra-panel"')
    expect(hostIndex).toBeGreaterThan(-1)
    expect(hostIndex).toBeLessThan(panelIndex)
  })

  it("exposes a challenge host and an honest, retryable failure surface on /demo", () => {
    const demo = read("../pages/demo.astro")
    expect(demo).toContain("data-myra-turnstile")
    expect(demo).toContain("demo-slots-retry")
    // The failure can be a server or browser/network error.
    expect(demo).not.toContain("Check your connection")
    expect(demo).not.toContain("not your connection")
  })

  it("keeps the /demo host outside the mutually-exclusive booking steps", () => {
    const demo = read("../pages/demo.astro")
    // The host must follow the last step section so it stays visible no
    // matter which step is showing — a challenge inside #demo-step-slot is
    // hidden the moment a time is chosen.
    const hostIndex = demo.indexOf("data-myra-turnstile")
    const lastStepIndex = demo.indexOf('id="demo-step-manage"')
    const noscriptIndex = demo.indexOf("<noscript>")
    expect(hostIndex).toBeGreaterThan(lastStepIndex)
    expect(hostIndex).toBeGreaterThan(-1)
    expect(hostIndex).toBeLessThan(noscriptIndex)
  })
})

describe("marketing Myra launcher flag", () => {
  it("reads the build define rather than import.meta.env", () => {
    const base = stripComments(read("../layouts/Base.astro"))
    expect(base).toContain("const myraEnabled = __MARKETING_MYRA_ENABLED__")
    expect(base).not.toContain("import.meta.env.PUBLIC_MYRA_MARKETING_ENABLED")
  })

  it("resolves the flag from the wrangler var in astro.config.mjs", () => {
    const config = read("../../astro.config.mjs")
    expect(config).toContain('wranglerVar("PUBLIC_MYRA_MARKETING_ENABLED")')
    expect(config).toContain("__MARKETING_MYRA_ENABLED__")
  })
})
