import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn(), spawn: vi.fn(), event: vi.fn() }))
vi.mock("child_process", () => ({ spawn: mocks.spawn }))
vi.mock("@lyrashield/db", () => ({ prisma: { $queryRaw: mocks.query } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("./runner-config", () => ({ buildEngineEnv: () => ({}) }))
vi.mock("./runner-events", () => ({ emitScanEvent: mocks.event }))
vi.mock("./runner-output", () => ({ parseEngineProgressFingerprint: () => null }))
vi.mock("./runner-tail", () => ({
  appendEngineStreamTail: vi.fn(),
  createEngineStreamTail: () => ({}),
  flushEngineStreamTail: vi.fn(),
  persistEngineStreamTail: vi.fn().mockResolvedValue(undefined),
}))

const epoch = "1794480000.123456"
const command = (kind: string) => ({ executable: "fixture-engine", args: [kind], workDir: "/tmp" })
const profile: Parameters<typeof import("./runner-process").runEngineProcess>[4] = {
  model: "fixture",
  reasoningEffort: "medium",
  delegateModel: "fixture",
  delegateReasoningEffort: "medium",
}

function childFixture() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.query.mockResolvedValue([{ epoch }])
  mocks.event.mockResolvedValue(undefined)
  vi.stubEnv("LYRASHIELD_COLD_SINGLE_WORKER", "1")
  vi.stubEnv(
    "LYRASHIELD_COLD_DATABASE_EPOCH_SHA256",
    createHash("sha256").update(epoch).digest("hex")
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("cold main and triage process boundary", () => {
  it.each(["scan", "ai-security-triage"])(
    "prevents %s native/provider dispatch after a database incarnation change",
    async (kind) => {
      const { runEngineProcess } = await import("./runner-process")
      mocks.query.mockResolvedValue([{ epoch: "1794481000.123456" }])
      await expect(
        runEngineProcess(command(kind), "/tmp", "scan-1", null, profile)
      ).rejects.toThrow("admission remains closed")
      expect(mocks.spawn).not.toHaveBeenCalled()
      expect(mocks.event).not.toHaveBeenCalled()
    }
  )

  it.each(["scan", "ai-security-triage"])(
    "terminates active %s through existing escalation and permanently closes later dispatch",
    async (kind) => {
      const { runEngineProcess } = await import("./runner-process")
      const { configureColdDatabaseEpochFailureHandler } = await import("../cold-database-epoch")
      const closeWorker = vi.fn()
      configureColdDatabaseEpochFailureHandler(closeWorker)
      const child = childFixture()
      mocks.spawn.mockReturnValue(child)
      const running = runEngineProcess(command(kind), "/tmp", "scan-1", null, profile)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.spawn).toHaveBeenCalledOnce()
      mocks.query.mockResolvedValue([{ epoch: "1794481000.123456" }])
      await vi.advanceTimersByTimeAsync(1000)
      expect(closeWorker).toHaveBeenCalledOnce()
      expect(child.kill).toHaveBeenCalledWith("SIGTERM")
      await vi.advanceTimersByTimeAsync(5000)
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      child.emit("close", null)
      await expect(running).rejects.toThrow("admission remains closed")
      mocks.query.mockResolvedValue([{ epoch }])
      await expect(
        runEngineProcess(command(kind), "/tmp", "scan-1", null, profile)
      ).rejects.toThrow("admission remains closed")
      expect(mocks.spawn).toHaveBeenCalledOnce()
    }
  )

  it("coalesces stalled database checks and terminates on the bounded read deadline", async () => {
    const { runEngineProcess } = await import("./runner-process")
    const child = childFixture()
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile)
    await vi.advanceTimersByTimeAsync(0)
    mocks.query.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(mocks.query).toHaveBeenCalledTimes(2)
    child.emit("close", null)
    await expect(running).rejects.toThrow("admission remains closed")
  })

  it("terminates when the runtime epoch becomes unavailable despite an uncancelled scan", async () => {
    const { runEngineProcess } = await import("./runner-process")
    const child = childFixture()
    const shouldCancel = vi.fn().mockResolvedValue(false)
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile, shouldCancel)
    await vi.advanceTimersByTimeAsync(0)
    mocks.query.mockRejectedValue(new Error("connection unavailable"))
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(shouldCancel).not.toHaveBeenCalled()
    child.emit("close", null)
    await expect(running).rejects.toThrow("admission remains closed")
  })

  it("retains an epoch interruption and live-child escalation when kill emits an error", async () => {
    const { runEngineProcess, terminateActiveEngineProcesses } = await import("./runner-process")
    const child = childFixture()
    child.kill.mockImplementation(() => {
      child.emit("error", new Error("fixture kill denied"))
      return false
    })
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile)
    const rejected = expect(running).rejects.toThrow("admission remains closed")
    await vi.advanceTimersByTimeAsync(0)
    mocks.query.mockResolvedValue([{ epoch: "1794481000.123456" }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(terminateActiveEngineProcesses()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    child.emit("close", null)
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(terminateActiveEngineProcesses()).toBe(0)
  })

  it("preserves an ordinary process error when the database epoch remains valid", async () => {
    const { runEngineProcess, terminateActiveEngineProcesses } = await import("./runner-process")
    const child = childFixture()
    const original = new Error("fixture spawn failure")
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile)
    await vi.advanceTimersByTimeAsync(0)
    const rejected = expect(running).rejects.toBe(original)
    let settled = false
    void running.catch(() => {
      settled = true
    })
    child.emit("error", original)
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    expect(terminateActiveEngineProcesses()).toBe(1)
    child.emit("close", null)
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(terminateActiveEngineProcesses()).toBe(0)
  })

  it.each(["scan", "ai-security-triage"])(
    "retains %s as unknown when a kill error never establishes close",
    async (kind) => {
      const {
        runEngineProcess,
        EngineProcessStopUnconfirmedError,
        terminateActiveEngineProcesses,
      } = await import("./runner-process")
      const { configureColdDatabaseEpochFailureHandler } = await import("../cold-database-epoch")
      const closeWorker = vi.fn()
      configureColdDatabaseEpochFailureHandler(closeWorker)
      const child = childFixture()
      child.kill.mockImplementation(() => {
        child.emit("error", new Error("fixture kill denied"))
        return false
      })
      mocks.spawn.mockReturnValue(child)
      const running = runEngineProcess(
        command(kind),
        "/tmp",
        "scan-1",
        null,
        profile,
        vi.fn().mockResolvedValue(true)
      )
      const rejected = expect(running).rejects.toBeInstanceOf(EngineProcessStopUnconfirmedError)
      let settled = false
      void running.catch(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(9999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(closeWorker).toHaveBeenCalledOnce()
      await expect(
        runEngineProcess(command(kind), "/tmp", "scan-2", null, profile)
      ).rejects.toBeInstanceOf(EngineProcessStopUnconfirmedError)
      expect(mocks.spawn).toHaveBeenCalledOnce()
      expect(terminateActiveEngineProcesses()).toBe(1)
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      child.emit("close", null)
      await vi.advanceTimersByTimeAsync(0)
      expect(terminateActiveEngineProcesses()).toBe(0)
    }
  )

  it("keeps checking epochs when an existing cancellation status read hangs", async () => {
    const { runEngineProcess } = await import("./runner-process")
    const child = childFixture()
    const shouldCancel = vi.fn(() => new Promise<boolean>(() => {}))
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile, shouldCancel)
    await vi.advanceTimersByTimeAsync(1000)
    expect(shouldCancel).toHaveBeenCalledOnce()
    mocks.query.mockResolvedValue([{ epoch: "1794481000.123456" }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    child.emit("close", null)
    await expect(running).rejects.toThrow("admission remains closed")
  })

  it("preserves ordinary cancellation without querying a database incarnation", async () => {
    vi.stubEnv("LYRASHIELD_COLD_SINGLE_WORKER", undefined)
    const { runEngineProcess } = await import("./runner-process")
    const child = childFixture()
    const shouldCancel = vi.fn().mockResolvedValue(true)
    mocks.spawn.mockReturnValue(child)
    const running = runEngineProcess(command("scan"), "/tmp", "scan-1", null, profile, shouldCancel)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(shouldCancel).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    child.emit("close", null)
    await expect(running).resolves.toMatchObject({ cancelled: true })
  })
})
