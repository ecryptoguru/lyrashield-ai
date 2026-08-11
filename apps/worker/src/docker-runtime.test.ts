import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../Dockerfile", import.meta.url)),
  "utf8"
)
// The path is anchored to this test module rather than derived from external input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const imageVerifier = readFileSync(
  fileURLToPath(new URL("../scripts/verify-worker-image.sh", import.meta.url)),
  "utf8"
)

describe("worker Docker runtime", () => {
  it("starts with the vendored TypeScript runner without invoking Corepack", () => {
    const workerStage = dockerfile.slice(dockerfile.indexOf("FROM node:24-alpine AS worker"))

    expect(workerStage).not.toContain("corepack")
    expect(workerStage).toContain(
      'CMD ["./apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]'
    )
  })

  it("installs the engine non-editably and omits its build checkout", () => {
    const workerMarker = "FROM node:24-alpine AS worker\n"
    const engineStage = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-alpine AS worker-engine"),
      dockerfile.indexOf(workerMarker)
    )
    const workerStage = dockerfile.slice(dockerfile.indexOf(workerMarker))

    expect(engineStage).toContain("--no-editable")
    expect(workerStage).not.toContain(
      "COPY --from=worker-engine /opt/lyrashield-engine /opt/lyrashield-engine"
    )
    expect(dockerfile).toContain(
      "pnpm --filter @lyrashield/worker deploy --prod --legacy /worker-runtime"
    )
    expect(workerStage).toContain("COPY --from=workspace-builder /worker-runtime ./apps/worker")
    expect(workerStage).not.toContain("COPY --from=deps /app/node_modules ./node_modules")
    expect(workerStage).not.toContain("COPY --from=workspace-builder /app/packages ./packages")
    expect(workerStage).toContain(
      "COPY --from=worker-engine /opt/lyrashield-venv /opt/lyrashield-venv"
    )
    expect(workerStage).toContain('-name "*.test.ts"')
    expect(workerStage).toContain("-delete")
  })

  it("audits private-key content without rejecting public certificate bundles", () => {
    expect(imageVerifier).toContain("BEGIN ([A-Z0-9 ]*)PRIVATE KEY")
    expect(imageVerifier).not.toContain('-name "*.pem"')
    expect(imageVerifier).toContain("/opt/lyrashield-engine")
    expect(imageVerifier).toContain("interface/viewer/frontend")
  })
})
