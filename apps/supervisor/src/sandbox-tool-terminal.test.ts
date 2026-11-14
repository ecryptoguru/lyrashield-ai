import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { SandboxToolEvent } from "./sandbox-tool-journal"
import { validateSandboxToolOutput } from "./sandbox-tool-terminal"

const binding = {
  attemptId: "attempt-1",
  operationId: "operation-1",
  authorityEpochId: "epoch-1",
  sandboxHandle: "sandbox-1",
}
const requestId = "1d5b3040-b775-43a0-a7fb-ac5965fb91fa"
function original(kind: "files/read" | "workspace/persist"): SandboxToolEvent {
  return {
    type: "tool_started",
    supervisorInstanceId: "supervisor-1.tools",
    observedAt: "2026-11-14T00:00:00.000Z",
    binding: {
      attemptId: binding.attemptId,
      operationId: binding.operationId,
      authorityEpochId: binding.authorityEpochId,
      scanId: "scan-1",
      workspaceId: "workspace-1",
    },
    tool: {
      kind,
      requestId,
      commandId: requestId,
      prepareCommandId: "prepare-1",
      invocationGuardId: "guard-1",
      actionChecksum: "a".repeat(64),
      handleChecksum: "b".repeat(64),
      containerId: "c".repeat(64),
      execId: "d".repeat(64),
      maxOutputBytes: 1024 * 1024,
    },
  }
}
function response(data: Buffer, field: "dataBase64" | "archiveBase64") {
  return {
    binding,
    requestId,
    status: "COMPLETED",
    exitCode: 0,
    [field]: data.toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
  }
}
describe("sandbox file terminal proof", () => {
  it.each([
    ["files/read", "dataBase64"],
    ["workspace/persist", "archiveBase64"],
  ] as const)("accepts exact checksummed %s bytes at the declared cap", (kind, field) => {
    const value = response(Buffer.alloc(512 * 1024), field)
    expect(validateSandboxToolOutput(value, original(kind))).toEqual(value)
  })
  it.each([
    ["files/read", "dataBase64"],
    ["workspace/persist", "archiveBase64"],
  ] as const)(
    "keeps capped %s incomplete during terminal and cache/replay checks",
    (kind, field) => {
      const value = response(Buffer.alloc(512 * 1024 + 1), field)
      expect(() => validateSandboxToolOutput(value, original(kind))).toThrow(
        "capped and incomplete"
      )
    }
  )
  it("rejects corrupted file bytes and noncanonical encoding", () => {
    const value = response(Buffer.from("fixture"), "dataBase64")
    expect(() =>
      validateSandboxToolOutput({ ...value, sha256: "f".repeat(64) }, original("files/read"))
    ).toThrow("checksum differs")
    expect(() =>
      validateSandboxToolOutput({ ...value, dataBase64: "YQ" }, original("files/read"))
    ).toThrow("invalid sandbox output")
  })
})
