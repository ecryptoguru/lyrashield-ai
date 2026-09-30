import { createRequire } from "node:module"
import { expect, it } from "vitest"

it("resolves patched Undici 8 through Astro's actual font-loader dependency", () => {
  const require = createRequire(import.meta.url)
  const astroRequire = createRequire(require.resolve("astro/package.json"))
  const fontRequire = createRequire(astroRequire.resolve("unifont"))
  const { version } = fontRequire("undici/package.json") as { version: string }
  expect(version).toMatch(/^8\.\d+\.\d+$/)
  const [, minor, patch] = version.split(".").map(Number)
  // GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-vp8m-p9jh-q5pm.
  expect(minor! > 10 || (minor === 10 && patch! >= 2), `Resolved Undici ${version}`).toBe(true)
  for (const packageName of ["security", "egress-proxy"]) {
    const consumerRequire = createRequire(
      new URL(`../../../../packages/${packageName}/package.json`, import.meta.url)
    )
    expect(consumerRequire("undici/package.json").version).toBe(version)
  }
})
