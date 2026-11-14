import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  resourceOwnershipSchema,
  sha256Hex,
  sandboxToolExecDescriptorSchema,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import {
  readScanNativeRetainedGuard,
  readScanNativeRetirementGuard,
} from "@lyrashield/db/src/scan-native-retained-authority-reader"
import { readStoredDispatchCommand } from "@lyrashield/db/src/scan-dispatch-command-descriptor"
import { createScanNativeOriginAuthorityVerifier } from "@lyrashield/db/src/scan-native-origin-authority-reader"
import { loadDatabaseSupervisorAuthority } from "./database-authority"
import { nativeExecutorRequestSchema, NATIVE_REQUEST_BYTES } from "./native-executor-protocol"
import { loadProtectedResourceInstallation } from "./protected-resource-installation"
import { containerCreateCommand } from "./container-create-command"
import { ProviderGatewayClient } from "./provider-client"
import {
  issueNativeRootSandboxGrant,
  issueNativeRootSandboxGrantRenewal,
} from "./root-sandbox-grant-native"
import { issueNativeDisposableSandboxGrant } from "./root-disposable-sandbox-grant"
import { hasInstalledProductionSandboxAuthority } from "./root-sandbox-grant"

const inputSchema = z
  .object({ request: nativeExecutorRequestSchema, origin: z.unknown().nullable() })
  .strict()
const originSchema = z
  .object({
    guardId: z.string(),
    plan: z
      .object({ action: authorityActionSchema, ownership: resourceOwnershipSchema })
      .passthrough(),
  })
  .passthrough()

/** Fixed root-owned image entrypoint. Its input is the root socket request, never argv. */
async function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error()
  let bytes = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk as Buffer])
    if (bytes.length > 512 * 1024 + NATIVE_REQUEST_BYTES) throw new Error()
  }
  const { request, origin } = inputSchema.parse(JSON.parse(bytes.toString("utf8")))
  const installed = loadDatabaseSupervisorAuthority({
    signingSecret: process.env.LYRASHIELD_SUPERVISOR_SIGNING_SECRET!,
    supervisorInstanceId: process.env.LYRASHIELD_SUPERVISOR_INSTANCE_ID!,
    controlToken: process.env.LYRASHIELD_SUPERVISOR_CONTROL_TOKEN!,
  })
  if (!installed) throw new Error()
  const connection = await installed.pool.connect()
  try {
    await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
    await connection.query("SET LOCAL statement_timeout = '2s'")
    const verify = createScanNativeOriginAuthorityVerifier({
      approvedProviderPolicies: new Map(),
      supervisorAuthority: installed.supervisorAuthority,
    })
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
    const checked = await verify(connection, action, request.guardId)
    if (checked.deadlineAt.getTime() <= Date.now()) throw new Error()
    const row = (
      await connection.query(
        `SELECT "commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND "commandType"='PREPARE'`,
        [action.operationId, action.attemptId, action.workspaceId]
      )
    ).rows[0]
    const command = row && readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    if (!command || command.type !== "PREPARE") throw new Error()
    const preparation: PrepareCommand = command
    const executorKey = action.executorKey
    const executor = preparation.executors.find((entry) => entry.key === executorKey)
    if (
      !executorKey ||
      !executor ||
      executor.spec.kind !== "container" ||
      !executor.spec.resourceDescriptor ||
      !executor.spec.readOnly ||
      !/@sha256:[a-f0-9]{64}$/.test(executor.spec.image)
    )
      throw new Error()
    const resources = await loadProtectedResourceInstallation(
      executor.spec.resourceDescriptor,
      action.attemptId,
      executor.spec.network
    )
    const context = {
      attemptId: action.attemptId,
      commandId: action.commandId!,
      assertActive: () => {
        if (checked.deadlineAt.getTime() <= Date.now()) throw new Error("Native action expired")
      },
    }
    const compiled = containerCreateCommand(executorKey, executor.spec, context, resources)
    if (request.method === "create" && preparation.provider) {
      const gateway = new ProviderGatewayClient(
        process.env.LYRASHIELD_PROVIDER_GATEWAY_URL!,
        process.env.LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN!
      )
      const grant = await gateway.findGrantByRequest(action.commandId!)
      if (
        !grant ||
        grant.attemptId !== action.attemptId ||
        grant.providerId !== preparation.provider.providerId ||
        Date.parse(grant.expiresAt) <= Date.now()
      )
        throw new Error()
      const bound = containerCreateCommand(
        executorKey,
        executor.spec,
        {
          ...context,
          provider: {
            token: grant.token,
            providerId: grant.providerId,
            gatewayUrl: process.env.LYRASHIELD_PROVIDER_GATEWAY_URL!,
            scanId: action.scanId,
          },
        },
        resources
      )
      compiled.args = bound.args
      compiled.providerEnv = bound.providerEnv
    }
    let ownership = { executorKey, kind: "container" as const, ownershipId: compiled.ownershipId }
    if (
      request.method === "start" &&
      (request.ownership.ownershipId !== ownership.ownershipId ||
        request.ownership.executorKey !== executorKey ||
        !/^[a-f0-9]{64}$/.test(request.ownership.containerId ?? ""))
    )
      throw new Error()
    let descriptor: unknown
    let engineGrant:
      | Awaited<ReturnType<typeof issueNativeRootSandboxGrant>>
      | Awaited<ReturnType<typeof issueNativeDisposableSandboxGrant>>
      | undefined
    let renewedGrant:
      | Awaited<ReturnType<typeof issueNativeRootSandboxGrantRenewal>>
      | Awaited<ReturnType<typeof issueNativeDisposableSandboxGrant>>
      | undefined
    let relayRequired: boolean | undefined
    if (request.method === "create" && executorKey === "engine") {
      const sandbox = preparation.executors.find((entry) => entry.key === "sandbox")
      if (!sandbox || sandbox.spec.kind !== "container" || !sandbox.spec.resourceDescriptor)
        throw new Error()
      relayRequired = z.boolean().parse(sandbox.spec.resourceDescriptor.egress.relayRequired)
      // These bytes come only from the root daemon's exact-image SDK builder;
      // the supervisor socket envelope has no manifest/signing inputs.
      const manifest = z
        .object({ manifestInputJson: z.string().min(2).max(16384) })
        .strict()
        .safeParse(origin)
      if (manifest.success)
        engineGrant = await (
          hasInstalledProductionSandboxAuthority()
            ? issueNativeRootSandboxGrant
            : issueNativeDisposableSandboxGrant
        )({
          connection,
          action,
          guardId: request.guardId,
          preparation,
          supervisorAuthority: installed.supervisorAuthority,
          productRevision: process.env.LYRASHIELD_PRODUCT_REVISION!,
          manifestInputJson: manifest.data.manifestInputJson,
        })
    }
    if (request.method === "tool") {
      const intent = (
        await connection.query(
          `SELECT "actionInputJson","actionChecksum" FROM "ScanExecutionActionIntent" WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND phase='SANDBOX_TOOL' AND "requestId"=$4`,
          [action.operationId, action.attemptId, action.workspaceId, action.requestId]
        )
      ).rows[0]
      if (
        !intent ||
        intent.actionChecksum !== action.actionChecksum ||
        sha256Hex(intent.actionInputJson) !== action.actionChecksum
      )
        throw new Error()
      descriptor = sandboxToolExecDescriptorSchema.parse(JSON.parse(intent.actionInputJson))
      ownership = resourceOwnershipSchema.parse(
        (descriptor as { ownership?: unknown }).ownership
      ) as typeof ownership
      if ((descriptor as { resultKind?: string }).resultKind === "state/renew") {
        const manifest = z
          .object({ manifestInputJson: z.string().min(2).max(16384) })
          .strict()
          .safeParse(origin)
        if (manifest.success)
          renewedGrant = await (
            hasInstalledProductionSandboxAuthority()
              ? issueNativeRootSandboxGrantRenewal
              : issueNativeDisposableSandboxGrant
          )({
            connection,
            action,
            guardId: request.guardId,
            preparation,
            supervisorAuthority: installed.supervisorAuthority,
            productRevision: process.env.LYRASHIELD_PRODUCT_REVISION!,
            manifestInputJson: manifest.data.manifestInputJson,
          })
      }
    }
    return {
      schema: 1,
      method: request.method,
      guardId: request.guardId,
      action,
      epochId: action.authorityEpochId,
      sourceRevision: process.env.LYRASHIELD_PRODUCT_REVISION,
      ownership: request.method === "start" ? request.ownership : ownership,
      image: executor.spec.image,
      network: executor.spec.network,
      createArgs: compiled.args,
      spec: executor.spec,
      resources,
      ...(compiled.providerEnv?.LLM_API_KEY
        ? { providerEnv: { LLM_API_KEY: compiled.providerEnv.LLM_API_KEY } }
        : {}),
      ...(descriptor ? { descriptor } : {}),
      ...(request.method === "create" && executorKey === "engine"
        ? { manifestRequired: true, relayRequired }
        : {}),
      ...(engineGrant
        ? {
            engineEnv: engineGrant.env,
            sandboxGrant: engineGrant.grant,
            sandboxRuntimeAuthority: engineGrant.runtimeAuthority,
            expectedSandboxOwnership: engineGrant.ownership,
          }
        : {}),
      ...(renewedGrant
        ? {
            stateResult: {
              grant: renewedGrant.grant,
              runtimeAuthority: renewedGrant.runtimeAuthority,
              running: true,
            },
            expectedSandboxOwnership: renewedGrant.ownership,
          }
        : {}),
    }
  } finally {
    await connection.query("ROLLBACK")
    connection.release()
    await installed.close()
  }
}

main()
  .then((plan) => {
    const raw = JSON.stringify(plan)
    if (Buffer.byteLength(raw) > 512 * 1024) throw new Error()
    process.stdout.write(raw + "\n")
  })
  .catch(() => {
    process.stderr.write("Native action authority unavailable\n")
    process.exitCode = 1
  })
