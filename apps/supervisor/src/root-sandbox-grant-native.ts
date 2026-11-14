import { z } from "zod"
import {
  canonicalJson,
  sha256Hex,
  authorityActionSchema,
  resourceOwnershipSchema,
  sandboxToolExecDescriptorSchema,
  type AuthorityAction,
  type AuthoritySqlConnection,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import { createScanNativeOriginAuthorityVerifier } from "@lyrashield/db/src/scan-native-origin-authority-reader"
import { createScanExecutionActionAuthorityVerifier } from "@lyrashield/db/src/scan-execution-action-intent"
import { readRetainedSupervisorAuthoritySource } from "@lyrashield/db/src/scan-supervisor-authority-source"
import { authenticateRetainedSupervisorAuthoritySource } from "@lyrashield/db/src/scan-supervisor-authority-source-verifier"
import type { SupervisorReceiptAuthority } from "@lyrashield/db/src/scan-supervisor-receipt-ingestion-verifier"
import { RootSandboxGrantSigner } from "./root-sandbox-grant"

function unavailable(): never {
  throw new Error("Native sandbox grant scope unavailable")
}

export type NativeSandboxGrantInput = {
  connection: AuthoritySqlConnection
  action: AuthorityAction
  guardId: string
  preparation: PrepareCommand
  supervisorAuthority: SupervisorReceiptAuthority
  productRevision: string
  manifestInputJson: string
}

/** Same live native gate and authentic sandbox START history for issuance and renewal. */
export async function confirmNativeSandboxGrantAuthority(input: NativeSandboxGrantInput) {
  if (process.getuid?.() !== 0) unavailable()
  const action = authorityActionSchema.parse(input.action)
  if (!(
    (action.phase === "EXECUTOR_CREATE" && action.executorKey === "engine") ||
    (action.phase === "SANDBOX_TOOL" && action.executorKey === "sandbox")
  ))
    unavailable()
  const policy = {
    approvedProviderPolicies: new Map(),
    supervisorAuthority: input.supervisorAuthority,
  }
  const origin = await createScanNativeOriginAuthorityVerifier(policy)(
    input.connection,
    action,
    input.guardId
  )
  const connection: AuthoritySqlConnection = {
    query(text, values = []) {
      if (text === "SELECT app.require_scan_execution_action_role()")
        return input.connection.query("SELECT app.require_scan_native_origin_reader()", values)
      if (!text.includes("app.scan_preparation_gate_held()"))
        return input.connection.query(text, values)
      const parameters = [...values, input.guardId]
      return input.connection.query(
        text.replaceAll(
          "app.scan_preparation_gate_held()",
          `app.scan_native_executor_origin_gate_held($${parameters.length})`
        ),
        parameters
      )
    },
    release() {
      unavailable()
    },
  }
  // This deadline is the current immutable attempt/account bound, not the short native invocation lease.
  const current = await createScanExecutionActionAuthorityVerifier(policy)(connection, action)
  const rows = (
    await connection.query(
      `SELECT r.id,r."receiptHash",r."commandId",a."maxRuntimeMs"
    FROM "ScanSupervisorReceipt" r
    JOIN "ScanDispatchAttempt" a ON a."operationId"=r."operationId" AND a."attemptId"=r."attemptId" AND a."workspaceId"=$5
    JOIN "ScanDispatchOutbox" c ON c.id=r."commandId" AND c."operationId"=r."operationId" AND c."attemptId"=r."attemptId"
    JOIN "ScanExecutionInvocationGuard" cg ON cg."commandId"=c.id AND cg."operationId"=c."operationId" AND cg."attemptId"=c."attemptId" AND cg.phase='EXECUTOR_CREATE' AND cg."executorKey"='sandbox'
    JOIN "ScanExecutionInvocationResolution" cr ON cr."guardId"=cg.id
    JOIN "ScanExecutionInvocationGuard" sg ON sg."commandId"=c.id AND sg."operationId"=c."operationId" AND sg."attemptId"=c."attemptId" AND sg.phase='EXECUTOR_START' AND sg."executorKey"='sandbox'
    JOIN "ScanExecutionInvocationResolution" sr ON sr."guardId"=sg.id
    WHERE r."operationId"=$1 AND r."attemptId"=$2 AND r."authorityEpochId"=$3 AND r."supervisorInstanceId"=$4
      AND r."eventType"='resource_started' AND r."executorKey"='sandbox' AND r."journalRecordId" IS NOT NULL
      AND cg."workspaceId"=$5 AND sg."workspaceId"=$5 AND cg."actionChecksum"=c."commandInputChecksum" AND sg."actionChecksum"=c."commandInputChecksum"
    ORDER BY r."observedAt" DESC LIMIT 2`,
      [
        action.operationId,
        action.attemptId,
        action.authorityEpochId,
        input.supervisorAuthority.supervisorInstanceId,
        action.workspaceId,
      ]
    )
  ).rows
  if (rows.length !== 1) unavailable()
  const row = z
    .object({
      id: z.string(),
      receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      commandId: z.string(),
      maxRuntimeMs: z
        .number()
        .int()
        .positive()
        .max(45 * 60_000),
    })
    .parse(rows[0])
  const source = await readRetainedSupervisorAuthoritySource(connection, {
    operationId: action.operationId,
    attemptId: action.attemptId,
    commandId: row.commandId,
    authorityEpochId: action.authorityEpochId,
    supervisorInstanceId: input.supervisorAuthority.supervisorInstanceId,
    receiptHash: row.receiptHash,
    executorKey: "sandbox",
  })
  const confirmed = await authenticateRetainedSupervisorAuthoritySource(
    source,
    input.supervisorAuthority,
    connection
  )
  const bound = confirmed.ownership[0]
  if (
    !bound ||
    confirmed.uncertain ||
    confirmed.receiptId !== row.id ||
    confirmed.original.payload.type !== "resource_started" ||
    confirmed.original.payload.executorKey !== "sandbox" ||
    canonicalJson(bound.preparation) !== canonicalJson(input.preparation)
  )
    unavailable()
  const ownership = resourceOwnershipSchema.parse(confirmed.original.payload.ownership)
  if (canonicalJson(ownership) !== canonicalJson(bound.ownership)) unavailable()
  const sandbox = bound.preparation.executors.find((entry) => entry.key === "sandbox")
  if (!sandbox || sandbox.spec.kind !== "container" || !sandbox.spec.resourceDescriptor)
    unavailable()
  const now = Date.now()
  if (origin.deadlineAt.getTime() <= now || current.deadlineAt.getTime() <= now) unavailable()
  const expires = Math.min(
    current.deadlineAt.getTime(),
    Date.parse(bound.preparation.attempt.expiresAt),
    now + row.maxRuntimeMs
  )
  if (!Number.isFinite(expires) || expires <= now || expires - now > 45 * 60_000) unavailable()
  if (action.phase === "SANDBOX_TOOL") {
    if (!action.requestId) unavailable()
    const row = (
      await connection.query(
        `SELECT "actionInputJson","actionChecksum" FROM "ScanExecutionActionIntent"
      WHERE "operationId"=$1 AND "attemptId"=$2 AND "workspaceId"=$3 AND phase='SANDBOX_TOOL' AND "requestId"=$4`,
        [action.operationId, action.attemptId, action.workspaceId, action.requestId]
      )
    ).rows[0]
    if (!row) unavailable()
    const intent = z
      .object({ actionInputJson: z.string(), actionChecksum: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(row)
    if (
      intent.actionChecksum !== action.actionChecksum ||
      sha256Hex(intent.actionInputJson) !== action.actionChecksum
    )
      unavailable()
    const descriptor = sandboxToolExecDescriptorSchema.parse(JSON.parse(intent.actionInputJson))
    if (
      (descriptor.resultKind as string) !== "state/renew" ||
      canonicalJson(descriptor) !== intent.actionInputJson ||
      descriptor.workspaceRoot !== sandbox.spec.resourceDescriptor.workspaceRoot ||
      canonicalJson(descriptor.ownership) !== canonicalJson(ownership)
    )
      unavailable()
  }
  return {
    signingInput: {
      scope: {
        schema: "lyrashield-sandbox-tool-capability/1" as const,
        authorityEpochId: action.authorityEpochId,
        operationId: action.operationId,
        attemptId: action.attemptId,
        scanId: action.scanId,
        workspaceId: action.workspaceId,
        authorityRevision: action.authorityRevision,
        prepareCommandId: bound.preparation.commandId,
        prepareCommandInputChecksum: sha256Hex(canonicalJson(bound.preparation)),
        authorityChecksum: action.authorityChecksum,
        ownershipReceiptId: row.id,
        ownership,
        sandboxHandle: ownership.ownershipId,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(expires).toISOString(),
      },
      descriptor: sandbox.spec.resourceDescriptor,
      manifestInputJson: input.manifestInputJson,
      exposedPorts: [48080],
      deadlineAt: new Date(expires),
    },
    assertCurrent() {
      if (origin.deadlineAt.getTime() <= Date.now()) unavailable()
    },
  }
}

export async function issueNativeRootSandboxGrant(input: NativeSandboxGrantInput) {
  if (input.action.phase !== "EXECUTOR_CREATE" || input.action.executorKey !== "engine")
    unavailable()
  const confirmed = await confirmNativeSandboxGrantAuthority(input)
  const result = RootSandboxGrantSigner.load(input.productRevision).issue(confirmed.signingInput)
  confirmed.assertCurrent()
  return result
}

export async function issueNativeRootSandboxGrantRenewal(input: NativeSandboxGrantInput) {
  if (input.action.phase !== "SANDBOX_TOOL" || input.action.executorKey !== "sandbox") unavailable()
  const confirmed = await confirmNativeSandboxGrantAuthority(input)
  const { grant, runtimeAuthority, ownership } = RootSandboxGrantSigner.load(
    input.productRevision
  ).issue(confirmed.signingInput)
  confirmed.assertCurrent()
  return { grant, runtimeAuthority, ownership }
}
