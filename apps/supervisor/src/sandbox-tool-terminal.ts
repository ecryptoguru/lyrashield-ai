import { z } from "zod"
import { canonicalJson } from "@lyrashield/runtime-control"
import {
  sandboxToolResponseBindingSchema,
  type SandboxToolResponseBinding,
} from "./sandbox-tool-response"
import type { SandboxToolEvent } from "./sandbox-tool-journal"

const encoded = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .max(1_398_104)
const responseBase = {
  binding: sandboxToolResponseBindingSchema,
  requestId: z.string().uuid(),
  status: z.literal("COMPLETED"),
}
const execResponse = z
  .object({
    ...responseBase,
    exitCode: z.number().int().min(-255).max(255),
    stdoutBase64: encoded,
    stderrBase64: encoded,
  })
  .strict()
const ptyResponse = z
  .object({
    ...responseBase,
    sessionId: z.number().int().positive().safe(),
    outputBase64: encoded,
    outputCursor: z.number().int().nonnegative().safe(),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    originalTokenCount: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()
const observationSchema = z
  .object({
    execId: z.string().regex(/^[a-f0-9]{64}$/),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    invocationGuardId: z.string().min(3).max(192),
    actionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["RUNNING", "EXITED"]),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    response: z.unknown(),
  })
  .strict()

// Only protected composition may implement this with native exact-exec inspect
// and authenticated, durably retained output. No default observer is installed.
export interface SandboxToolTerminalObserver {
  observe(binding: SandboxToolResponseBinding, original: SandboxToolEvent): Promise<unknown>
}

function bytes(value: string): number {
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value) throw new Error("invalid sandbox output")
  return decoded.byteLength
}

export function validateSandboxToolOutput(input: unknown, original: SandboxToolEvent) {
  const outputLimit = original.tool.maxOutputBytes
  if (
    typeof outputLimit !== "number" ||
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 1 ||
    outputLimit > 1024 * 1024
  )
    throw new Error("sandbox tool output limit is unavailable")
  const response =
    original.tool.kind === "exec" ? execResponse.parse(input) : ptyResponse.parse(input)
  const total =
    "stdoutBase64" in response
      ? bytes(response.stdoutBase64) + bytes(response.stderrBase64)
      : bytes(response.outputBase64)
  if (total > outputLimit) throw new Error("sandbox output is too large")
  return response
}

export async function observeSandboxToolTerminal(
  observer: SandboxToolTerminalObserver,
  binding: SandboxToolResponseBinding,
  original: SandboxToolEvent
) {
  if (original.type !== "tool_started") throw new Error("sandbox invocation is unresolved")
  const expectedBinding = Object.freeze(sandboxToolResponseBindingSchema.parse(binding))
  const observation = observationSchema.parse(
    await observer.observe(expectedBinding, structuredClone(original))
  )
  if (
    observation.execId !== original.tool.execId ||
    observation.containerId !== original.tool.containerId ||
    observation.invocationGuardId !== original.tool.invocationGuardId ||
    observation.actionChecksum !== original.tool.actionChecksum
  )
    throw new Error("sandbox terminal identity differs")
  const response = validateSandboxToolOutput(observation.response, original)
  if (
    response.requestId !== original.tool.requestId ||
    canonicalJson(response.binding) !== canonicalJson(expectedBinding) ||
    (observation.state === "RUNNING" &&
      (original.tool.kind !== "pty/start" || response.exitCode !== null)) ||
    (observation.state === "EXITED" &&
      (observation.exitCode === null || response.exitCode !== observation.exitCode)) ||
    (observation.state === "RUNNING" && observation.exitCode !== null)
  )
    throw new Error("sandbox terminal observation differs")
  return response
}
