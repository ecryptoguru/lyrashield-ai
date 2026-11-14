import { canonicalJson } from "@lyrashield/runtime-control"
import type { SandboxToolEvent } from "./sandbox-tool-journal"

export function projectSandboxToolHistory(
  events: SandboxToolEvent[]
): Map<string, SandboxToolEvent[]> {
  const states = new Map<string, SandboxToolEvent[]>()
  const execIds = new Set<string>()
  const commandIds = new Set<string>()
  const unresolvedAttempts = new Map<string, string>()
  for (const event of events) {
    const existing = states.get(event.tool.requestId) ?? []
    const first = existing[0]
    const expected = [
      "tool_intent",
      "tool_created",
      "tool_starting",
      "tool_started",
      "tool_response",
      "tool_ack",
    ][existing.length]
    if (
      event.type !== expected ||
      (first &&
        (canonicalJson(first.binding) !== canonicalJson(event.binding) ||
          first.tool.kind !== event.tool.kind ||
          first.tool.commandId !== event.tool.commandId ||
          first.tool.prepareCommandId !== event.tool.prepareCommandId ||
          first.tool.invocationGuardId !== event.tool.invocationGuardId ||
          first.tool.actionChecksum !== event.tool.actionChecksum ||
          first.tool.handleChecksum !== event.tool.handleChecksum ||
          first.tool.containerId !== event.tool.containerId ||
          first.tool.maxOutputBytes !== event.tool.maxOutputBytes ||
          (existing[1] && existing[1].tool.execId !== event.tool.execId) ||
          (event.type === "tool_ack" &&
            (existing[4]?.tool.responseChecksum !== event.tool.responseChecksum ||
              existing[4]?.tool.objectDigest !== event.tool.objectDigest))))
    )
      throw new Error("sandbox tool history conflicts")
    if (event.type === "tool_created") {
      if (!event.tool.execId || execIds.has(event.tool.execId))
        throw new Error("sandbox tool exec identity was reused")
      execIds.add(event.tool.execId)
    }
    if (event.type === "tool_intent") {
      if (commandIds.has(event.tool.commandId) || unresolvedAttempts.has(event.binding.attemptId))
        throw new Error("sandbox tool operation conflicts with retained history")
      commandIds.add(event.tool.commandId)
      unresolvedAttempts.set(event.binding.attemptId, event.tool.requestId)
    }
    if (event.type === "tool_ack") {
      if (unresolvedAttempts.get(event.binding.attemptId) !== event.tool.requestId)
        throw new Error("sandbox tool acknowledgement conflicts with retained history")
      unresolvedAttempts.delete(event.binding.attemptId)
    }
    existing.push(event)
    states.set(event.tool.requestId, existing)
  }
  return states
}
