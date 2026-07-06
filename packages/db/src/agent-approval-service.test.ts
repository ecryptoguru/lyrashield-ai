import { describe, it, expect, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    agentApproval: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { hashInput, verifyInputHash } from "./agent-approval-service"

describe("Agent Approval Service — hash functions", () => {
  it("produces a deterministic SHA-256 hash", () => {
    const hash1 = hashInput("run-scan", { targetId: "t1", mode: "SAFE" })
    const hash2 = hashInput("run-scan", { targetId: "t1", mode: "SAFE" })
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
  })

  it("produces different hashes for different actions", () => {
    const h1 = hashInput("run-scan", { targetId: "t1" })
    const h2 = hashInput("list-targets", { targetId: "t1" })
    expect(h1).not.toBe(h2)
  })

  it("produces different hashes for different inputs", () => {
    const h1 = hashInput("run-scan", { targetId: "t1" })
    const h2 = hashInput("run-scan", { targetId: "t2" })
    expect(h1).not.toBe(h2)
  })

  it("verifies matching input hash", () => {
    const hash = hashInput("run-scan", { targetId: "t1", mode: "DEEP" })
    expect(verifyInputHash("run-scan", { targetId: "t1", mode: "DEEP" }, hash)).toBe(true)
  })

  it("rejects mismatched input hash", () => {
    const hash = hashInput("run-scan", { targetId: "t1" })
    expect(verifyInputHash("run-scan", { targetId: "t2" }, hash)).toBe(false)
  })
})
