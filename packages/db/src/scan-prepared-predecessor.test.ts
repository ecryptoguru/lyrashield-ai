import { describe, expect, it } from "vitest"
import type { PrepareCommand } from "@lyrashield/runtime-control"
import { assertPreparedEventMatchesCommand } from "./scan-prepared-predecessor"
const command: PrepareCommand = {
  type: "PREPARE",
  commandId: "prepare-one",
  attempt: {
    attemptId: "attempt-one",
    scanId: "scan-one",
    workspaceId: "workspace-one",
    operationId: "operation-one",
    authorityEpochId: "epoch-one",
    authorityRevision: 1,
    workerIdentity: "worker-one",
    billingMode: "UNMETERED",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  executors: [
    {
      key: "engine",
      spec: {
        kind: "process",
        command: "/fixture",
        args: [],
        cwd: "/fixture",
        cgroupPath: "/fixture",
        env: {},
        grantEnvName: "LLM_API_KEY",
      },
    },
  ],
}
const event = {
  type: "attempt_prepared",
  commandId: command.commandId,
  binding: command.attempt,
  executors: command.executors,
}
describe("genuine preparation receipt binding", () => {
  it("accepts exact prepared bytes without changing their event semantics", () => {
    expect(() => assertPreparedEventMatchesCommand(event, command)).not.toThrow()
    expect(event.type).toBe("attempt_prepared")
  })
  it.each([
    { ...event, commandId: "different-command" },
    { ...event, binding: { ...command.attempt, workerIdentity: "different-worker" } },
    { ...event, binding: { ...command.attempt, authorityRevision: 2 } },
    { ...event, executors: [] },
    { ...event, provider: { providerId: "unauthorized" } },
    { ...event, type: "command_terminal", status: "UNKNOWN" },
  ])("rejects changed original execution authority or uncertainty", (changed) => {
    expect(() => assertPreparedEventMatchesCommand(changed, command)).toThrow()
  })
})
