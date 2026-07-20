import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../Dockerfile", import.meta.url)),
  "utf8"
)

describe("worker Docker runtime", () => {
  it("starts with the vendored TypeScript runner without invoking Corepack", () => {
    const workerStage = dockerfile.slice(dockerfile.indexOf("FROM node:22-alpine AS worker"))

    expect(workerStage).not.toContain("corepack")
    expect(workerStage).toContain(
      'CMD ["./apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]'
    )
  })
})
