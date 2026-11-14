import { createHash } from "node:crypto"
import { canonicalJson, IndependentAuthorityError } from "@lyrashield/runtime-control"
import { projectSandboxToolHistory } from "./sandbox-tool-history"
import { SandboxToolJournal, type SandboxToolEvent } from "./sandbox-tool-journal"
import {
  SandboxToolResponses,
  sandboxToolResponseBindingSchema,
  type SandboxToolResponseBinding,
  type SandboxToolRetainedResponse,
} from "./sandbox-tool-response"
import {
  observeSandboxToolTerminal,
  validateSandboxToolOutput,
  type SandboxToolTerminalObserver,
} from "./sandbox-tool-terminal"

/** The caller authenticates the attempt and holds the current action fence. */
export class SandboxToolAcknowledgements {
  private readonly serial = new Map<string, Promise<void>>()

  constructor(
    private readonly journal: SandboxToolJournal,
    private readonly responses: SandboxToolResponses,
    private readonly observer?: SandboxToolTerminalObserver
  ) {}

  private exclusive<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.serial.get(requestId) ?? Promise.resolve()).then(operation)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.serial.set(requestId, settled)
    return run.finally(() => {
      if (this.serial.get(requestId) === settled) this.serial.delete(requestId)
    })
  }

  private async state(binding: SandboxToolResponseBinding, requestId: string) {
    const events = await this.journal.load()
    const entries = projectSandboxToolHistory(events.map((record) => record.payload)).get(requestId)
    const first = entries?.[0]
    if (
      !first ||
      first.binding.attemptId !== binding.attemptId ||
      first.binding.operationId !== binding.operationId ||
      first.binding.authorityEpochId !== binding.authorityEpochId ||
      first.tool.handleChecksum !==
        createHash("sha256").update(canonicalJson(binding.sandboxHandle)).digest("hex")
    )
      throw new Error("sandbox tool response is unavailable")
    if (first.tool.maxOutputBytes === undefined)
      throw new Error("sandbox tool output limit is unavailable")
    return entries!
  }

  private async append(
    previous: SandboxToolEvent,
    type: "tool_response" | "tool_ack",
    proof: SandboxToolRetainedResponse
  ): Promise<void> {
    await this.journal.append({
      ...previous,
      type,
      observedAt: new Date().toISOString(),
      tool: { ...previous.tool, ...proof },
    })
  }

  async complete(binding: SandboxToolResponseBinding, requestId: string) {
    binding = sandboxToolResponseBindingSchema.parse(binding)
    return this.exclusive(requestId, async () => {
      const entries = await this.state(binding, requestId)
      const latest = entries.at(-1)!
      if (latest.type === "tool_response" || latest.type === "tool_ack") {
        const proof = this.proof(latest)
        validateSandboxToolOutput(await this.responses.load(binding, requestId, proof), latest)
        return proof
      }
      if (latest.type !== "tool_started") throw new Error("sandbox tool outcome unresolved")
      if (!this.observer) throw new Error("sandbox terminal observer unavailable")
      const response = await observeSandboxToolTerminal(this.observer, binding, latest)
      const proof = await this.responses.retain(binding, requestId, response)
      await this.append(latest, "tool_response", proof)
      return proof
    })
  }

  async recoverRetained(binding: SandboxToolResponseBinding, requestId: string) {
    binding = sandboxToolResponseBindingSchema.parse(binding)
    return this.exclusive(requestId, async () => {
      const latest = (await this.state(binding, requestId)).at(-1)!
      if (latest.type !== "tool_started") throw new Error("sandbox tool outcome unresolved")
      if (!this.observer) throw new Error("sandbox terminal observer unavailable")
      const observed = await observeSandboxToolTerminal(this.observer, binding, latest)
      const { response, proof } = await this.responses.recover(binding, requestId)
      validateSandboxToolOutput(response, latest)
      if (canonicalJson(observed) !== canonicalJson(response))
        throw new Error("recovered sandbox terminal observation differs")
      await this.append(latest, "tool_response", proof)
      return response
    })
  }

  async acknowledge(
    binding: SandboxToolResponseBinding,
    requestId: string,
    responseChecksum: string
  ) {
    binding = sandboxToolResponseBindingSchema.parse(binding)
    return this.exclusive(requestId, async () => {
      let entries: SandboxToolEvent[]
      try {
        entries = await this.state(binding, requestId)
      } catch (error) {
        if (!(error instanceof IndependentAuthorityError) || error.code !== "REPLAY_REQUIRED")
          throw error
        await this.journal.recoverAcknowledgement(
          binding,
          requestId,
          responseChecksum,
          async (proof, event) => {
            validateSandboxToolOutput(await this.responses.load(binding, requestId, proof), event)
          }
        )
        entries = await this.state(binding, requestId)
      }
      const latest = entries.at(-1)!
      if (latest.type !== "tool_response" && latest.type !== "tool_ack")
        throw new Error("sandbox tool response is unavailable")
      const proof = this.proof(latest)
      if (proof.responseChecksum !== responseChecksum)
        throw new Error("sandbox response receipt differs")
      validateSandboxToolOutput(await this.responses.load(binding, requestId, proof), latest)
      if (latest.type === "tool_response") await this.append(latest, "tool_ack", proof)
      return { binding, requestId, status: "ACKNOWLEDGED" as const, responseChecksum }
    })
  }

  async replay(binding: SandboxToolResponseBinding, requestId: string, actionChecksum: string) {
    binding = sandboxToolResponseBindingSchema.parse(binding)
    return this.exclusive(requestId, async () => {
      const latest = (await this.state(binding, requestId)).at(-1)!
      if (
        (latest.type !== "tool_response" && latest.type !== "tool_ack") ||
        latest.tool.actionChecksum !== actionChecksum
      )
        throw new Error("sandbox tool response is unavailable")
      return validateSandboxToolOutput(
        await this.responses.load(binding, requestId, this.proof(latest)),
        latest
      )
    })
  }

  private proof(event: SandboxToolEvent): SandboxToolRetainedResponse {
    if (!event.tool.responseChecksum || !event.tool.objectDigest)
      throw new Error("sandbox tool response proof unavailable")
    return { responseChecksum: event.tool.responseChecksum, objectDigest: event.tool.objectDigest }
  }
}
