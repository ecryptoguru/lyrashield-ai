import { z } from "zod"
import type pg from "pg"
import type { loadDatabaseSupervisorAuthority } from "./database-authority"
import { nativeExecutorRequestSchema } from "./native-executor-protocol"
type NativeRequest = z.infer<typeof nativeExecutorRequestSchema>
type Installed = NonNullable<ReturnType<typeof loadDatabaseSupervisorAuthority>>
import {
  resourceOwnershipSchema,
  sha256Hex,
  sandboxToolExecDescriptorSchema,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import { readStoredDispatchCommand } from "@lyrashield/db/src/scan-dispatch-command-descriptor"
import { createScanNativeOriginAuthorityVerifier } from "@lyrashield/db/src/scan-native-origin-authority-reader"
import { loadProtectedResourceInstallation } from "./protected-resource-installation"
import { containerCreateCommand } from "./container-create-command"
import { ProviderGatewayClient } from "./provider-client"
import {
  issueNativeRootSandboxGrant,
  issueNativeRootSandboxGrantRenewal,
  type NativeSandboxGrantInput,
} from "./root-sandbox-grant-native"
import { issueNativeDisposableSandboxGrant } from "./root-disposable-sandbox-grant"
import { hasInstalledProductionSandboxAuthority } from "./root-sandbox-grant"
type WriteRequest = Extract<NativeRequest, { method: "create" | "start" | "tool" }>

function readManifest(origin: unknown) {
  return z
    .object({ manifestInputJson: z.string().min(2).max(16384) })
    .strict()
    .safeParse(origin)
}
async function signNativeEngineGrant(
  input: Omit<NativeSandboxGrantInput, "manifestInputJson">,
  origin: unknown
) {
  const manifest = readManifest(origin)
  if (manifest.success)
    return (
      hasInstalledProductionSandboxAuthority()
        ? issueNativeRootSandboxGrant
        : issueNativeDisposableSandboxGrant
    )({ ...input, manifestInputJson: manifest.data.manifestInputJson })
}
async function signNativeRenewal(
  input: Omit<NativeSandboxGrantInput, "manifestInputJson">,
  origin: unknown
) {
  const manifest = readManifest(origin)
  if (manifest.success)
    return (
      hasInstalledProductionSandboxAuthority()
        ? issueNativeRootSandboxGrantRenewal
        : issueNativeDisposableSandboxGrant
    )({ ...input, manifestInputJson: manifest.data.manifestInputJson })
}

async function compileNativeRequest(
  request: WriteRequest,
  installed: Installed,
  connection: pg.PoolClient
) {
  const action = request.action
  const verify = createScanNativeOriginAuthorityVerifier({
    approvedProviderPolicies: new Map(),
    supervisorAuthority: installed.supervisorAuthority,
  })
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
  return { action, preparation, executorKey, spec: executor.spec, resources, compiled }
}

export async function planNativeHostRequest(
  request: WriteRequest,
  origin: unknown,
  installed: Installed,
  connection: pg.PoolClient
) {
  const { action, preparation, executorKey, spec, resources, compiled } =
    await compileNativeRequest(request, installed, connection)
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
    engineGrant = await signNativeEngineGrant(
      {
        connection,
        action,
        guardId: request.guardId,
        preparation,
        supervisorAuthority: installed.supervisorAuthority,
        productRevision: process.env.LYRASHIELD_PRODUCT_REVISION!,
      },
      origin
    )
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
      renewedGrant = await signNativeRenewal(
        {
          connection,
          action,
          guardId: request.guardId,
          preparation,
          supervisorAuthority: installed.supervisorAuthority,
          productRevision: process.env.LYRASHIELD_PRODUCT_REVISION!,
        },
        origin
      )
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
    image: spec.image,
    network: spec.network,
    createArgs: compiled.args,
    spec: spec,
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
}
