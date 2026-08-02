import { describe, it, expect, afterEach } from "vitest"
import { readFile, stat } from "node:fs/promises"
import { refreshWorkerReadiness, removeWorkerReadiness } from "./index"

describe("worker readiness lifecycle", () => {
  afterEach(async () => {
    await removeWorkerReadiness()
  })

  it("writes an ISO timestamp to the readiness marker with 0o600 permissions", async () => {
    await refreshWorkerReadiness()

    const content = await readFile("/tmp/lyrashield-worker-ready", "utf8")
    expect(Date.parse(content)).not.toBeNaN()

    const { mode } = await stat("/tmp/lyrashield-worker-ready")
    expect(mode & 0o777).toBe(0o600)
  })

  it("removes the readiness marker without throwing when it is missing", async () => {
    await removeWorkerReadiness()
    await expect(removeWorkerReadiness()).resolves.toBeUndefined()
  })
})
