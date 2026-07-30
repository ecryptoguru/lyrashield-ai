import { describe, it, expect, vi } from "vitest"
import { handleApprovals } from "../commands/approvals.js"
import type { Output } from "../output.js"

function makeOutput(): Output & { lines: unknown[] } {
  const lines: unknown[] = []
  return {
    json: false,
    quiet: false,
    log(...args) {
      lines.push(args.join(" "))
    },
    notice(...args) {
      lines.push(args.join(" "))
    },
    warn(...args) {
      lines.push(`warning: ${args.join(" ")}`)
    },
    error(...args) {
      lines.push(`error: ${args.join(" ")}`)
    },
    result(data) {
      lines.push({ result: data })
    },
    fail(error) {
      throw new Error(error)
    },
    lines,
  }
}

const mockApprovals = {
  items: [
    { id: "apv-1", actionName: "lyrashield_scan_target", status: "PENDING" },
    { id: "apv-2", actionName: "lyrashield_create_report", status: "APPROVED" },
  ],
  nextCursor: null,
}

vi.mock("@lyrashield/sdk", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>
  return {
    ...mod,
    listAgentApprovals: vi.fn(async () => mockApprovals),
    createAgentApproval: vi.fn(async () => ({
      id: "apv-3",
      actionName: "lyrashield_scan_target",
      status: "PENDING",
    })),
    approveAgentApproval: vi.fn(async () => ({ id: "apv-1", status: "APPROVED" })),
    denyAgentApproval: vi.fn(async () => ({ id: "apv-1", status: "DENIED" })),
  }
})

vi.mock("../client.js", () => ({
  createClient: vi.fn(() => ({ apiKey: "test" })),
}))

vi.mock("../credentials.js", () => ({
  getEffectiveCredentials: vi.fn(async () => ({ apiKey: "test", workspaceId: "ws-1" })),
  requireWorkspace: vi.fn(() => "ws-1"),
}))

describe("lyrashield approvals command conformance", () => {
  it("lists approvals", async () => {
    const output = makeOutput()
    const code = await handleApprovals(["list"], output)
    expect(code).toBe(0)
    expect(output.lines).toHaveLength(1)
    expect((output.lines[0] as { result: unknown }).result).toEqual(mockApprovals)
  })

  it("creates an approval", async () => {
    const output = makeOutput()
    const code = await handleApprovals(
      ["create", "lyrashield_scan_target", "--input", '{"targetId":"t-1"}'],
      output
    )
    expect(code).toBe(0)
    expect((output.lines[0] as { result: unknown }).result).toEqual({
      id: "apv-3",
      actionName: "lyrashield_scan_target",
      status: "PENDING",
    })
  })

  it("approves an approval", async () => {
    const output = makeOutput()
    const code = await handleApprovals(
      ["approve", "apv-1", "--input", '{"targetId":"t-1"}'],
      output
    )
    expect(code).toBe(0)
    expect((output.lines[0] as { result: unknown }).result).toEqual({
      id: "apv-1",
      status: "APPROVED",
    })
  })

  it("denies an approval", async () => {
    const output = makeOutput()
    const code = await handleApprovals(["deny", "apv-1"], output)
    expect(code).toBe(0)
    expect((output.lines[0] as { result: unknown }).result).toEqual({
      id: "apv-1",
      status: "DENIED",
    })
  })

  it("shows usage when called without subcommand", async () => {
    const output = makeOutput()
    const code = await handleApprovals([], output)
    expect(code).toBe(0)
    expect(output.lines.some((l) => typeof l === "string" && l.includes("Subcommands"))).toBe(true)
  })
})
