import { z } from "zod"
import { canonicalJson } from "@lyrashield/runtime-control"
import { createHash } from "node:crypto"
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
const fileResponseBase = {
  ...responseBase,
  exitCode: z.literal(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
const fileReadResponse = z.object({ ...fileResponseBase, dataBase64: encoded }).strict()
const workspaceResponse = z.object({ ...fileResponseBase, archiveBase64: encoded }).strict()
const fileWriteResponse = z.object(fileResponseBase).strict()
const stateResponse = z
  .object({
    ...responseBase,
    exitCode: z.literal(0),
    running: z.literal(true),
    grant: z.unknown(),
    runtimeAuthority: z.unknown(),
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
const terminateResponse = z
  .object({
    ...responseBase,
    exitCode: z.literal(0),
    terminatedCount: z.number().int().nonnegative().max(32),
  })
  .strict()
const mutationObservationSchema = z
  .object({
    nativeMutationId: z.string().min(3).max(192),
    targets: z
      .array(
        z
          .object({
            execId: z.string().regex(/^[a-f0-9]{64}$/),
            originalGuardId: z.string().min(3).max(192),
            sessionId: z.number().int().positive().safe(),
          })
          .strict()
      )
      .max(32),
    nativeReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    response: z.unknown(),
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
    original.tool.kind === "exec"
      ? execResponse.parse(input)
      : original.tool.kind === "pty/start" || original.tool.kind === "pty/stdin"
        ? ptyResponse.parse(input)
        : original.tool.kind === "pty/terminate"
          ? terminateResponse.parse(input)
          : original.tool.kind === "state/renew"
            ? stateResponse.parse(input)
            : original.tool.kind === "files/read"
              ? fileReadResponse.parse(input)
              : original.tool.kind === "workspace/persist"
                ? workspaceResponse.parse(input)
                : fileWriteResponse.parse(input)
  const total =
    "stdoutBase64" in response
      ? bytes(response.stdoutBase64) + bytes(response.stderrBase64)
      : "outputBase64" in response
        ? bytes(response.outputBase64)
        : typeof Reflect.get(response, "dataBase64") === "string"
          ? bytes(Reflect.get(response, "dataBase64") as string)
          : typeof Reflect.get(response, "archiveBase64") === "string"
            ? bytes(Reflect.get(response, "archiveBase64") as string)
            : 0
  if (total > outputLimit) throw new Error("sandbox output is too large")
  if (
    original.tool.kind === "state/renew" &&
    Buffer.byteLength(canonicalJson(response)) > outputLimit
  )
    throw new Error("Sandbox state output is too large")
  if (
    (original.tool.kind === "files/read" || original.tool.kind === "workspace/persist") &&
    total > 512 * 1024
  )
    throw new Error("Sandbox file output is capped and incomplete")
  const fileData = Reflect.get(response, "dataBase64") ?? Reflect.get(response, "archiveBase64")
  if (
    typeof fileData === "string" &&
    createHash("sha256").update(Buffer.from(fileData, "base64")).digest("hex") !==
      Reflect.get(response, "sha256")
  )
    throw new Error("Sandbox file checksum differs")
  return response
}

export async function observeSandboxToolTerminal(
  observer: SandboxToolTerminalObserver,
  binding: SandboxToolResponseBinding,
  original: SandboxToolEvent
) {
  if (original.type !== "tool_started" && original.type !== "tool_mutated")
    throw new Error("sandbox invocation is unresolved")
  const expectedBinding = Object.freeze(sandboxToolResponseBindingSchema.parse(binding))
  if (original.type === "tool_mutated") {
    const observation = mutationObservationSchema.parse(
      await observer.observe(expectedBinding, structuredClone(original))
    )
    if (
      observation.nativeMutationId !== original.tool.nativeMutationId ||
      observation.nativeReceiptSha256 !== original.tool.nativeReceiptSha256 ||
      canonicalJson(observation.targets) !== canonicalJson(original.tool.nativeTargets)
    )
      throw new Error("Sandbox mutation terminal identity differs")
    const response = validateSandboxToolOutput(observation.response, original)
    if (
      response.requestId !== original.tool.requestId ||
      canonicalJson(response.binding) !== canonicalJson(expectedBinding) ||
      (original.tool.kind === "pty/stdin" &&
        Reflect.get(response, "sessionId") !== original.tool.nativeTargets?.[0]?.sessionId) ||
      (original.tool.kind === "pty/terminate" &&
        Reflect.get(response, "terminatedCount") !== original.tool.nativeTargets?.length)
    )
      throw new Error("Sandbox mutation terminal response differs")
    return response
  }
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
