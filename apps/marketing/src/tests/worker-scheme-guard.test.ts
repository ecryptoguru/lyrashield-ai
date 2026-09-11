import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * VULN-P-001 — marketing served content over plaintext HTTP with no redirect.
 * Astro middleware cannot fix it: the adapter's generated worker returns
 * static assets before app middleware runs, so the scheme guard lives in a
 * postbuild wrapper around dist/server/entry.mjs. These tests execute the
 * exact wrapper source the build emits — not a copy.
 */

// eslint-disable-next-line security/detect-non-literal-fs-filename
const script = readFileSync(
  new URL("../../scripts/apply-worker-scheme-guard.mjs", import.meta.url),
  "utf8"
)

/** Extract the WRAPPER template literal and build a callable fetch handler. */
function buildGuardFetch() {
  const match = script.match(/const WRAPPER = `([\s\S]*?)`\n\nwriteFileSync/)
  expect(match, "WRAPPER template not found in apply-worker-scheme-guard.mjs").toBeTruthy()

  const wrapper = match![1]!
    // The real wrapper imports the generated entry; in tests we delegate to
    // a stub that echoes a marker so "pass-through" is observable.
    .replace(/import generated from "[^"]*"/, "")
    .replace(/return generated\.fetch\(request, env, ctx\)/, 'return new Response("generated-ok")')
    .replace(/export default/, "module.exports =")

  // Evaluate the module source in a CommonJS-shaped sandbox.
  const module = { exports: {} as { fetch: (r: Request) => Promise<Response> } }
  new Function("module", "exports", wrapper)(module, module.exports)
  return module.exports.fetch
}

describe("worker scheme guard (VULN-P-001)", () => {
  const fetch = buildGuardFetch()

  it("301s every http request on the apex domain to https", async () => {
    for (const path of ["/", "/pricing", "/compare/strix"]) {
      const res = await fetch(new Request(`http://lyrashieldai.com${path}`))
      expect(res.status).toBe(301)
      expect(res.headers.get("location")).toBe(`https://lyrashieldai.com${path}`)
    }
  })

  it("301s http on www (redirect chain: http www → https www → apex)", async () => {
    const res = await fetch(new Request("http://www.lyrashieldai.com/pricing"))
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("https://www.lyrashieldai.com/pricing")
  })

  it("delegates https requests to the generated worker untouched", async () => {
    const res = await fetch(new Request("https://lyrashieldai.com/"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("generated-ok")
  })

  it("exempts loopback hosts so wrangler dev/miniflare never redirect-loop", async () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "dev.localhost"]) {
      const res = await fetch(new Request(`http://${host}/`))
      expect(res.status, host).toBe(200)
      expect(await res.text()).toBe("generated-ok")
    }
  })

  it("postbuild installs the wrapper as dist/server/entry.mjs and is idempotent", () => {
    expect(script).toContain("renameSync(entry, generated)")
    // Re-runs must not stack wrappers or fail on a second build.
    expect(script).toContain("existsSync(generated)")
    // Fails closed if the generated entry stops exporting fetch.
    expect(script).toContain("no longer exports a fetch handler")
  })
})
