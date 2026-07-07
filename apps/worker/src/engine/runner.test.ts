import { describe, it, expect, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    LYRASHIELD_ENGINE_PATH: "",
    LYRASHIELD_IMAGE: "",
    REDIS_URL: "redis://localhost:6379",
  },
}))
vi.mock("@lyrashield/db", () => ({
  addScanEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { interpretExitCode, createKillEscalation } from "./runner"

describe("interpretExitCode", () => {
  it("maps exit 0 to COMPLETED", () => {
    const result = interpretExitCode(0)
    expect(result.status).toBe("COMPLETED")
    expect(result.category).toBe("SUCCESS")
  })

  it("maps exit 1 to COMPLETED (non-critical)", () => {
    const result = interpretExitCode(1)
    expect(result.status).toBe("COMPLETED")
    expect(result.category).toBe("SUCCESS")
  })

  it("maps exit 2 to COMPLETED with VULNERABILITIES_FOUND", () => {
    const result = interpretExitCode(2)
    expect(result.status).toBe("COMPLETED")
    expect(result.category).toBe("VULNERABILITIES_FOUND")
  })

  it("maps exit 3+ to FAILED", () => {
    const result = interpretExitCode(3)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("ENGINE_ERROR")
    expect(result.message).toContain("code 3")
  })

  it("maps negative exit codes to FAILED", () => {
    const result = interpretExitCode(-1)
    expect(result.status).toBe("FAILED")
    expect(result.category).toBe("ENGINE_ERROR")
  })

  it("maps exit -1 (timeout) to FAILED", () => {
    const result = interpretExitCode(-1)
    expect(result.status).toBe("FAILED")
    expect(result.message).toContain("code -1")
  })
})

describe("createKillEscalation (S5)", () => {
  it("sends SIGKILL after the grace window when the process has NOT exited", () => {
    vi.useFakeTimers()
    const kills: string[] = []
    const child = { kill: (sig?: NodeJS.Signals) => (kills.push(String(sig)), true) }
    const esc = createKillEscalation(child, 5000)
    esc.onTimeout()
    expect(kills).toEqual(["SIGTERM"])
    vi.advanceTimersByTime(5000)
    expect(kills).toEqual(["SIGTERM", "SIGKILL"])
    vi.useRealTimers()
  })

  it("does NOT send SIGKILL if the process exits within the grace window", () => {
    vi.useFakeTimers()
    const kills: string[] = []
    const child = { kill: (sig?: NodeJS.Signals) => (kills.push(String(sig)), true) }
    const esc = createKillEscalation(child, 5000)
    esc.onTimeout()
    esc.markExited() // process closed before the grace window elapsed
    vi.advanceTimersByTime(5000)
    expect(kills).toEqual(["SIGTERM"])
    vi.useRealTimers()
  })
})
