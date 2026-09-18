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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
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
    expect(read("../components/myra/MyraPanel.astro")).toContain("data-myra-turnstile")
  })

  it("exposes a challenge host and an honest, retryable failure surface on /demo", () => {
    const demo = read("../pages/demo.astro")
    expect(demo).toContain("data-myra-turnstile")
    expect(demo).toContain("demo-slots-retry")
    // The old copy blamed the visitor's connection for a server-side outage.
    expect(demo).not.toContain("Check your connection")
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
