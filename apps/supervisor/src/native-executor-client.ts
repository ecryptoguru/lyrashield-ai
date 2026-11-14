import { connect } from "node:net"
import { z } from "zod"
import {
  resourceInspectionSchema,
  parseNativeRemovalProof,
  parseSandboxToolRetirementProof,
  type ExecutorKey,
  type ExecutorSpec,
  type ResourceOwnership,
  type ScanAuthorityContext,
} from "@lyrashield/runtime-control"
import type { ExecutorContext, NativeRetirement, RuntimeExecutor } from "./executor"
import {
  nativeExecutorRequestSchema,
  NATIVE_EXECUTOR_SOCKET,
  NATIVE_REQUEST_BYTES,
  NATIVE_RESPONSE_BYTES,
  type NativeExecutorRequest,
} from "./native-executor-protocol"

const responseSchema = z
  .object({ schema: z.literal(1), ok: z.literal(true), result: z.unknown() })
  .strict()

/** Fixed private transport: callers cannot submit Docker arguments, images or patches. */
export async function requestNativeExecutor(input: NativeExecutorRequest): Promise<unknown> {
  const request = Buffer.from(JSON.stringify(nativeExecutorRequestSchema.parse(input)) + "\n")
  if (request.length > NATIVE_REQUEST_BYTES) throw new Error("Native request exceeds its bound")
  return new Promise((resolve, reject) => {
    const socket = connect(NATIVE_EXECUTOR_SOCKET)
    let bytes = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    socket.setTimeout(9_000, () => finish(new Error("Native execution outcome is unavailable")))
    socket.once("connect", () => socket.end(request))
    socket.on("error", () => finish(new Error("Protected native executor is unavailable")))
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > NATIVE_RESPONSE_BYTES)
        finish(new Error("Native response exceeds its bound"))
    })
    socket.on("end", () => {
      try {
        if (!bytes.length || bytes[bytes.length - 1] !== 10) throw new Error()
        finish(undefined, responseSchema.parse(JSON.parse(bytes.toString("utf8"))).result)
      } catch {
        finish(new Error("Native execution outcome is unavailable"))
      }
    })
  })
}

/** The per-instance checked fence capability is supplied only by installed composition. */
export class RootNativeRuntimeExecutor implements RuntimeExecutor {
  constructor(private readonly authority: ScanAuthorityContext) {}

  private effect(
    method: "create" | "start",
    context: ExecutorContext,
    ownership?: ResourceOwnership
  ) {
    const capability = this.authority.current()
    if (
      !capability ||
      !context.nativeInvocation ||
      capability.guardId !== context.nativeInvocation.requestId ||
      capability.binding.attemptId !== context.attemptId ||
      capability.binding.commandId !== context.commandId ||
      capability.binding.phase !== (method === "create" ? "EXECUTOR_CREATE" : "EXECUTOR_START")
    )
      throw new Error("Current native invocation capability is unavailable")
    context.assertActive()
    capability.assertActive()
    return method === "create"
      ? requestNativeExecutor({
          schema: 1,
          method,
          guardId: capability.guardId,
          action: capability.binding,
        })
      : requestNativeExecutor({
          schema: 1,
          method,
          guardId: capability.guardId,
          action: capability.binding,
          ownership: ownership!,
        })
  }

  async create(
    key: ExecutorKey,
    spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (spec.kind !== "container" || this.authority.current()?.binding.executorKey !== key)
      throw new Error("Native container identity is unavailable")
    const inspection = resourceInspectionSchema.parse(await this.effect("create", context))
    context.assertActive()
    if (inspection.state !== "PRESENT" || inspection.running !== false || !inspection.ownership)
      throw new Error("Native create acknowledgement is unavailable")
    await context.nativeInvocation!.acknowledge({
      operation: "CONTAINER_CREATE_ACK",
      nativeRequestId: context.nativeInvocation!.requestId,
      inspection,
    })
    context.assertActive()
    return inspection.ownership
  }

  async start(
    ownership: ResourceOwnership,
    spec: ExecutorSpec,
    context: ExecutorContext
  ): Promise<ResourceOwnership> {
    if (spec.kind !== "container") throw new Error("Native container identity is unavailable")
    const inspection = resourceInspectionSchema.parse(
      await this.effect("start", context, ownership)
    )
    context.assertActive()
    if (
      inspection.state !== "PRESENT" ||
      inspection.running !== true ||
      !inspection.ownership ||
      inspection.ownership.containerId !== ownership.containerId
    )
      throw new Error("Native start acknowledgement is unavailable")
    await context.nativeInvocation!.acknowledge({
      operation: "CONTAINER_START_ACK",
      nativeRequestId: context.nativeInvocation!.requestId,
      inspection,
    })
    context.assertActive()
    return inspection.ownership
  }

  async inspect(ownership: ResourceOwnership) {
    return resourceInspectionSchema.parse(
      await requestNativeExecutor({ schema: 1, method: "inspect", ownership })
    )
  }

  async stop(ownership: ResourceOwnership, _graceMs?: number, retirement?: NativeRetirement) {
    const result = z
      .object({
        inspection: resourceInspectionSchema,
        nativeRemovalProof: z.unknown().optional(),
        nativeToolRetirements: z.array(z.unknown()).max(32).optional(),
      })
      .strict()
      .parse(await requestNativeExecutor({ schema: 1, method: "stop", ownership }))
    const inspection = result.inspection
    const proof = result.nativeRemovalProof
      ? parseNativeRemovalProof(result.nativeRemovalProof)
      : undefined
    if (
      proof &&
      (proof.ownership.ownershipId !== ownership.ownershipId ||
        proof.ownership.executorKey !== ownership.executorKey ||
        (ownership.containerId !== undefined &&
          proof.ownership.containerId !== ownership.containerId))
    )
      throw new Error("Native removal ownership differs")
    if (inspection.state === "ABSENT" && retirement)
      await retirement.acknowledge({
        ownership: proof?.ownership ?? ownership,
        inspection,
        ...(result.nativeRemovalProof ? { nativeRemovalProof: result.nativeRemovalProof } : {}),
      })
    const tools = (result.nativeToolRetirements ?? []).map(parseSandboxToolRetirementProof)
    if (tools.length) {
      if (
        inspection.state !== "ABSENT" ||
        !retirement?.acknowledgeTools ||
        tools.some(
          (entry) =>
            entry.ownership.ownershipId !== ownership.ownershipId ||
            entry.ownership.containerId !== ownership.containerId ||
            entry.ownership.executorKey !== "sandbox"
        )
      )
        throw new Error("Native tool retirement ownership differs")
      await retirement.acknowledgeTools(tools)
    }
    return inspection
  }
}
