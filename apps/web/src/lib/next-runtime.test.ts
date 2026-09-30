import { createRequire } from "node:module"
import { expect, it } from "vitest"

it("resolves a stable Next 16 runtime patched for GHSA-vcvr-r3jv-pc5j", () => {
  // Resolve from the web app, rather than accepting only a manifest/override floor.
  const require = createRequire(import.meta.url)
  const { version } = require("next/package.json") as { version: string }
  expect(version).toMatch(/^16\.\d+\.\d+$/)
  const [, minor, patch] = version.split(".").map(Number)
  expect(minor! > 3 || (minor === 3 && patch! >= 6), `Resolved Next ${version}`).toBe(true)
})
