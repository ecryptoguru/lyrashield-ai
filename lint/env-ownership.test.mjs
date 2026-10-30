import { expect, it } from "vitest"
import { findUnownedEnvReads } from "./env-ownership.mjs"
it("checks application-owned reads without requiring external SDK/CI keys in the central schema", () => {
  const source = "process.env.OWNED; process.env.CI; process.env['MISSING']; process.env.OWNED"
  expect(findUnownedEnvReads(source, "file.ts", new Set(["OWNED"]), { CI: ["file.ts"] })).toEqual([
    "MISSING",
  ])
  expect(findUnownedEnvReads("process.env.CI", "other.ts", new Set(), { CI: ["file.ts"] })).toEqual(
    ["CI"]
  )
})
