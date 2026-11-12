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

it("binds preparation fixture credentials and disposal confirmation to that exact file", () => {
  const keys = [
    "DISPATCH_AUTHORITY_REVOKER_PASSWORD",
    "DISPATCH_PREPARATION_BROKER_PASSWORD",
    "LYRASHIELD_TEST_DB_DISPOSABLE",
  ]
  const source = keys.map((key) => `process.env.${key}`).join("; ")
  expect(
    findUnownedEnvReads(source, "packages/db/scripts/tests/scan-preparation-fixture.ts", new Set())
  ).toEqual([])
  expect(findUnownedEnvReads(source, "packages/db/scripts/tests/other.ts", new Set())).toEqual(
    [...keys].sort()
  )
  expect(findUnownedEnvReads(source, "apps/web/src/other.ts", new Set())).toEqual([...keys].sort())
})

it("binds cold worker launcher values to the database epoch guard only", () => {
  const keys = ["LYRASHIELD_COLD_DATABASE_EPOCH_SHA256", "LYRASHIELD_COLD_SINGLE_WORKER"]
  const source = keys.map((key) => `process.env.${key}`).join("; ")
  expect(findUnownedEnvReads(source, "apps/worker/src/cold-database-epoch.ts", new Set())).toEqual(
    []
  )
  expect(findUnownedEnvReads(source, "apps/worker/src/other.ts", new Set())).toEqual(keys)
  expect(findUnownedEnvReads(source, "apps/web/src/other.ts", new Set())).toEqual(keys)
})
