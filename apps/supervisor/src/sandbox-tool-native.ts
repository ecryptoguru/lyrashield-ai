import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  resourceInspectionSchema,
  sha256Hex,
  type AuthorityAction,
  type SandboxToolExecDescriptor,
  type ScanAuthorityContext,
} from "@lyrashield/runtime-control"
import { requestNativeExecutor } from "./native-executor-client"
import type { SandboxToolTerminalObserver } from "./sandbox-tool-terminal"

export const nativeSandboxMutationSchema = z
  .object({
    status: z.literal("MUTATED"),
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
  })
  .strict()
const started = z
  .object({ execId: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal("STARTED") })
  .strict()
export interface SandboxToolNative {
  start(action: AuthorityAction, descriptor: SandboxToolExecDescriptor): Promise<{ execId: string }>
}

/** The supervisor has no Docker socket; only the checked root service performs effects. */
export class RootSandboxToolNative implements SandboxToolNative {
  constructor(private readonly authority: ScanAuthorityContext) {}

  async mutate(action: AuthorityAction, descriptor: SandboxToolExecDescriptor) {
    const current = this.authority.current()
    if (
      !current ||
      current.binding.phase !== "SANDBOX_TOOL" ||
      canonicalJson(current.binding) !== canonicalJson(action) ||
      sha256Hex(canonicalJson(descriptor)) !== action.actionChecksum ||
      (descriptor.resultKind !== "pty/stdin" && descriptor.resultKind !== "pty/terminate")
    )
      throw new Error("Current sandbox mutation capability is unavailable")
    current.assertActive()
    const result = nativeSandboxMutationSchema.parse(
      await requestNativeExecutor({
        schema: 1,
        method: "tool",
        guardId: current.guardId,
        action: current.binding,
      })
    )
    current.assertActive()
    if (result.nativeMutationId !== current.guardId)
      throw new Error("Native sandbox mutation identity differs")
    return result
  }
  async start(action: AuthorityAction, descriptor: SandboxToolExecDescriptor) {
    const current = this.authority.current()
    if (
      !current ||
      current.binding.phase !== "SANDBOX_TOOL" ||
      canonicalJson(current.binding) !== canonicalJson(action) ||
      sha256Hex(canonicalJson(descriptor)) !== action.actionChecksum
    )
      throw new Error("Current sandbox invocation capability is unavailable")
    current.assertActive()
    const result = started.parse(
      await requestNativeExecutor({
        schema: 1,
        method: "tool",
        guardId: current.guardId,
        action: current.binding,
      })
    )
    current.assertActive()
    return { execId: result.execId }
  }
}

export const rootSandboxToolTerminalObserver: SandboxToolTerminalObserver = {
  async observe(_binding, original) {
    if (!original.tool.bindingInputJson || !original.tool.timeoutSeconds)
      throw new Error("Retained native tool authority is unavailable")
    const action = authorityActionSchema.parse(JSON.parse(original.tool.bindingInputJson))
    if (
      canonicalJson(action) !== original.tool.bindingInputJson ||
      action.phase !== "SANDBOX_TOOL" ||
      action.actionChecksum !== original.tool.actionChecksum ||
      action.requestId !== original.tool.requestId ||
      action.operationId !== original.binding.operationId ||
      action.attemptId !== original.binding.attemptId ||
      action.authorityEpochId !== original.binding.authorityEpochId
    )
      throw new Error("Retained native tool authority differs")
    const deadline = Date.parse(original.observedAt) + original.tool.timeoutSeconds * 1000 + 5000
    do {
      const result = await requestNativeExecutor({
        schema: 1,
        method: "tool-observe",
        guardId: original.tool.invocationGuardId,
        action,
      })
      if (typeof result !== "object" || !result || Reflect.get(result, "status") !== "RUNNING")
        return result
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw new Error("Native sandbox terminal outcome is unavailable")
  },
}

export async function inspectNativeSandbox(descriptor: SandboxToolExecDescriptor) {
  const inspection = resourceInspectionSchema.parse(
    await requestNativeExecutor({
      schema: 1,
      method: "inspect",
      ownership: descriptor.ownership,
    })
  )
  if (
    inspection.state !== "PRESENT" ||
    inspection.running !== true ||
    canonicalJson(inspection.ownership) !== canonicalJson(descriptor.ownership)
  )
    throw new Error("Exact native sandbox is unavailable")
  return inspection
}
