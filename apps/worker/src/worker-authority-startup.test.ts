import { beforeEach, describe, it, expect, vi } from "vitest"
const mocked = vi.hoisted(() => ({ load: vi.fn(), adapter: vi.fn() }))
vi.mock("./installed-worker-authority", () => ({
  loadProtectedWorkerBrokerInstallation: mocked.load,
}))
vi.mock("./jobs/run-scan/broker-authority", () => ({
  createBrokerWorkerAuthorityAdapter: mocked.adapter,
  retainedBrokerScanResult: (errorCategory: string) => ({ status: "failed", errorCategory }),
}))
vi.mock("./jobs/run-scan.job", () => ({ processScanJob: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocked.load.mockResolvedValue(undefined)
})
describe("explicit installed worker authority startup", () => {
  it("keeps imports closed without reading config or starting authority", async () => {
    const startup = await import("./worker-authority-startup")
    expect(startup.workerAuthorityStartup).toEqual({ kind: "closed" })
    expect(mocked.load).not.toHaveBeenCalled()
    expect(startup.legacyWorkerLifecycleEnabled()).toBe(false)
  })
  it("initializes one installed authority only once and remains closed until it completes", async () => {
    let resolve!: (value: unknown) => void
    mocked.load.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const installed = { authority: {}, broker: {} }
    const adapter = { isCurrent: vi.fn(), process: vi.fn(), reconcileRetained: vi.fn() }
    mocked.adapter.mockReturnValue(adapter)
    const startup = await import("./worker-authority-startup")
    const first = startup.initializeWorkerAuthorityStartup(),
      second = startup.initializeWorkerAuthorityStartup()
    expect(first).toBe(second)
    expect(startup.workerAuthorityStartup).toEqual({ kind: "closed" })
    resolve(installed)
    expect(await first).toEqual({ kind: "broker", adapter })
    expect(startup.workerAuthorityStartup).toEqual({ kind: "broker", adapter })
    expect(mocked.load).toHaveBeenCalledTimes(1)
    expect(mocked.adapter).toHaveBeenCalledExactlyOnceWith(installed)
    expect(await startup.initializeWorkerAuthorityStartup()).toEqual({ kind: "broker", adapter })
    expect(mocked.load).toHaveBeenCalledTimes(1)
  })
  it("keeps missing or rejected installations closed without retrying through imports", async () => {
    mocked.load.mockRejectedValue(new Error("root authority unavailable"))
    const startup = await import("./worker-authority-startup")
    expect(await startup.initializeWorkerAuthorityStartup()).toEqual({ kind: "closed" })
    expect(await startup.initializeWorkerAuthorityStartup()).toEqual({ kind: "closed" })
    expect(mocked.load).toHaveBeenCalledTimes(1)
    expect(mocked.adapter).not.toHaveBeenCalled()
  })
  it("keeps CLI-imported processors closed then uses the initialized adapter without a stale closed closure", async () => {
    const adapter = {
      process: vi
        .fn()
        .mockResolvedValue({ status: "failed", errorCategory: "BROKER_RESULT_PENDING" }),
    }
    mocked.adapter.mockReturnValue(adapter)
    mocked.load.mockResolvedValue({ authority: {} })
    const startup = await import("./worker-authority-startup")
    const processor = await import("./jobs/scan-job-processor")
    const jobFixture = {
      id: "scan-one",
      data: {
        scanId: "scan-one",
        workspaceId: "workspace-one",
        targetId: "target-one",
        goal: "TEST_APP",
        mode: "SAFE",
      },
    }
    const job = jobFixture as Parameters<typeof processor.processWorkerScanJob>[0]
    expect(await processor.processWorkerScanJob(job)).toMatchObject({
      errorCategory: "BROKER_AUTHORITY_CLOSED",
    })
    expect(mocked.load).not.toHaveBeenCalled()
    await startup.initializeWorkerAuthorityStartup()
    expect(await processor.processWorkerScanJob(job)).toMatchObject({
      errorCategory: "BROKER_RESULT_PENDING",
    })
    expect(adapter.process).toHaveBeenCalledExactlyOnceWith(job)
  })
})
