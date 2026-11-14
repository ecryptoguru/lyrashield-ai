import { z } from "zod"
import type pg from "pg"
import type { loadDatabaseSupervisorAuthority } from "./database-authority"
import { nativeExecutorRequestSchema } from "./native-executor-protocol"
type NativeRequest = z.infer<typeof nativeExecutorRequestSchema>
type Installed = NonNullable<ReturnType<typeof loadDatabaseSupervisorAuthority>>
import {
  authorityActionSchema,
  canonicalJson,
  resourceOwnershipSchema,
  sha256Hex,
  sandboxToolExecDescriptorSchema,
} from "@lyrashield/runtime-control"
import {
  readScanNativeRetainedGuard,
  readScanNativeRetirementGuard,
} from "@lyrashield/db/src/scan-native-retained-authority-reader"
const originSchema = z
  .object({
    guardId: z.string(),
    plan: z
      .object({ action: authorityActionSchema, ownership: resourceOwnershipSchema })
      .passthrough(),
  })
  .passthrough()

export async function readNativeHostRequest(
  request: NativeRequest,
  origin: unknown,
  installed: Installed,
  connection: pg.PoolClient
) {
  if (request.method === "inspect") throw new Error("Passive observation is root-ledger scoped")
  if (request.method === "pty-read") {
    const retained = originSchema.parse(origin)
    await readScanNativeRetainedGuard(connection, retained.plan.action, retained.guardId)
    if (canonicalJson(request.ownership) !== canonicalJson(retained.plan.ownership))
      throw new Error()
    return { schema: 1, method: request.method }
  }
  if (request.method === "result-read") {
    const retained = originSchema.parse(origin)
    await readScanNativeRetainedGuard(connection, retained.plan.action, retained.guardId)
    if (
      retained.plan.action.phase !== "EXECUTOR_CREATE" ||
      retained.plan.ownership.executorKey !== "engine" ||
      request.ownership.executorKey !== "engine" ||
      request.ownership.ownershipId !== retained.plan.ownership.ownershipId
    )
      throw new Error()
    return { schema: 1, method: request.method }
  }
  if (request.method === "stop") {
    // Cleanup is authorized only by the original immutable operation and a stored STOP.
    const retained = originSchema.parse(origin)
    const action = retained.plan.action
    const stop = await readScanNativeRetirementGuard(
      connection,
      action,
      retained.guardId,
      installed.supervisorAuthority
    )
    if (request.ownership.ownershipId !== retained.plan.ownership.ownershipId) throw new Error()
    const pendingTools =
      retained.plan.ownership.executorKey === "sandbox"
        ? (
            await connection.query(`SELECT * FROM app.read_scan_native_pending_tool_guards($1)`, [
              retained.guardId,
            ])
          ).rows
        : []
    if (pendingTools.length > 32) throw new Error()
    const seen = new Set<string>()
    for (const row of pendingTools) {
      const binding = authorityActionSchema.parse(JSON.parse(row.bindingInputJson))
      const descriptor = sandboxToolExecDescriptorSchema.parse(JSON.parse(row.actionInputJson))
      if (
        seen.has(row.guardId) ||
        canonicalJson(binding) !== row.bindingInputJson ||
        canonicalJson(descriptor) !== row.actionInputJson ||
        sha256Hex(row.actionInputJson) !== row.actionChecksum ||
        binding.phase !== "SANDBOX_TOOL" ||
        binding.executorKey !== "sandbox" ||
        binding.actionChecksum !== row.actionChecksum ||
        !/^[a-f0-9]{64}$/.test(row.commandInputChecksum) ||
        ["operationId", "attemptId", "workspaceId", "authorityEpochId"].some(
          (key) => Reflect.get(binding, key) !== Reflect.get(action, key)
        ) ||
        descriptor.request.requestId !== binding.requestId ||
        descriptor.request.binding.operationId !== binding.operationId ||
        descriptor.request.binding.attemptId !== binding.attemptId ||
        descriptor.request.binding.authorityEpochId !== binding.authorityEpochId ||
        descriptor.ownership.ownershipId !== retained.plan.ownership.ownershipId ||
        descriptor.ownership.executorKey !== "sandbox" ||
        (request.ownership.containerId !== undefined &&
          descriptor.ownership.containerId !== request.ownership.containerId)
      )
        throw new Error()
      seen.add(row.guardId)
    }
    return { schema: 1, method: request.method, stopCommandId: stop.commandId, pendingTools }
  }
  const action = request.action
  if (request.method === "tool-observe") {
    const retained = originSchema.parse(origin)
    await readScanNativeRetainedGuard(connection, action, request.guardId)
    if (
      retained.guardId !== request.guardId ||
      canonicalJson(retained.plan.action) !== canonicalJson(action)
    )
      throw new Error()
    return { schema: 1, method: request.method }
  }
  return undefined
}
