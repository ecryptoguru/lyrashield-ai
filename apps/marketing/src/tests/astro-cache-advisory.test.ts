import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const astroRoot = dirname(require.resolve("astro/package.json"))
const remoteCacheSource = await readFile(resolve(astroRoot, "dist/assets/build/remote.js"), "utf8")

describe("Astro's http-cache-semantics advisory exposure", () => {
  it("does not route caller cache directives through max-stale evaluation", () => {
    // GHSA-ch52-4w7c-c8xp affects evaluateRequest's shared-cache max-stale
    // branch. Astro creates a fresh request from the configured asset URL and
    // uses the policy to calculate whether/how long the fetched asset is stored.
    expect(remoteCacheSource).toContain("new Request(src)")
    expect(remoteCacheSource).toContain("policy.timeToLive()")
    expect(remoteCacheSource).not.toMatch(/\.(?:evaluateRequest|satisfiesWithoutRevalidation)\s*\(/)
  })
})
