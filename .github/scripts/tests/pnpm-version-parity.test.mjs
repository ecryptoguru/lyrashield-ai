import assert from "node:assert/strict"
import { test } from "node:test"
import { findPnpmPinDrift } from "../verify-pnpm-pin.mjs"

const baseline = {
  packageManager: "pnpm@12.2.0",
  dockerfile: [
    "RUN corepack enable && corepack prepare pnpm@12.2.0 --activate",
    "RUN corepack enable && corepack prepare pnpm@12.2.0 --activate",
  ].join("\n"),
  scanWorkflow: "if ! npm install --global --no-audit --no-fund pnpm@12.2.0 >/dev/null 2>&1; then",
}

test("accepts Docker build and scan pins matching packageManager", () => {
  assert.deepEqual(findPnpmPinDrift(baseline), [])
})

test("rejects version drift and missing runtime pins", () => {
  assert.ok(
    findPnpmPinDrift({
      ...baseline,
      dockerfile: baseline.dockerfile.replace("pnpm@12.2.0", "pnpm@12.1.0"),
    }).some((issue) => issue.includes("Dockerfile uses pnpm@12.1.0"))
  )
  assert.ok(
    findPnpmPinDrift({ ...baseline, scanWorkflow: "npm install --global pnpm" }).some((issue) =>
      issue.includes("must pin pnpm once")
    )
  )
})
