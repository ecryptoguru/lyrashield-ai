import { randomBytes } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import {
  canonicalJson,
  sha256Hex,
  executorKeySchema,
  supervisorAttemptProofSchema,
  verifySupervisorAttemptProof,
  type SupervisorAttemptProof,
  type SupervisorAttemptProofInput,
} from "@lyrashield/runtime-control"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"
import { startUnmeteredDispatch } from "./scan-dispatch-authority-broker-methods"
import { startPaidDispatch } from "./scan-dispatch-authority-broker-start"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"
import type {
  StartPaidDispatchInput,
  StartPaidDispatchResult,
  StopDispatchInput,
  ReconcileDispatchInput,
} from "./scan-dispatch-authority-broker"

function unavailable(): never {
  throw new ScanDispatchAuthorityError(
    "PREPARATION_AUTHORITY_UNAVAILABLE",
    "Authenticated lifecycle authority is unavailable"
  )
}
type ProofAuthority = Pick<
  SupervisorReceiptAuthority,
  "authorityEpochId" | "supervisorInstanceId" | "attemptProofPublicKey" | "readAttemptProof"
>

type Scope = {
  workspaceId: string
  scanId: string
  workerGrantId: string
  workerInstanceId: string
  authorityEpochId: string
  prepareChecksum: string
  checked: boolean
  grantLive: boolean
}

export function createScanDispatchLifecycle(options: {
  context: DispatchBrokerContext
  nativeTransaction: DispatchBrokerContext["transaction"]
  cleanupTransaction: DispatchBrokerContext["transaction"]
  cleanupLockOperation: DispatchBrokerContext["lockOperation"]
  stageTransaction?: DispatchBrokerContext["transaction"]
  authority?: ProofAuthority
}) {
  const authority = options.authority
  async function readScope(
    input: StartPaidDispatchInput | ReconcileDispatchInput,
    phase: "execution" | "cleanup"
  ): Promise<Scope> {
    const transaction = phase === "cleanup" ? options.cleanupTransaction : options.nativeTransaction
    const result = await transaction(input.operationId, async (client) => {
      await (phase === "cleanup" ? options.cleanupLockOperation : options.context.lockOperation)(
        client,
        input
      )
      const row = (
        await client.query<Scope>(
          `SELECT a."workspaceId",a."scanId",a."workerInstanceGrantId" AS "workerGrantId",
        g."instanceId" AS "workerInstanceId",a."authorityEpochId",p."commandInputChecksum" AS "prepareChecksum",
        (a."authorityAcceptedAt" IS NOT NULL) AS checked,
        (g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp() AT TIME ZONE 'UTC') AS "grantLive"
        FROM "ScanDispatchAttempt" a
        JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId"
        JOIN "ScanDispatchOutbox" p ON p."operationId"=a."operationId" AND p."attemptId"=a."attemptId" AND p."commandType"='PREPARE'
        WHERE a."operationId"=$1 AND a."attemptId"=$2 AND a."workspaceId"=app.current_workspace_id()`,
          [input.operationId, input.attemptId]
        )
      ).rows[0]
      if (
        !row ||
        !row.checked ||
        (phase === "execution" && row.grantLive !== true) ||
        row.workerGrantId !== input.workerGrantId ||
        row.workerInstanceId !== input.workerInstanceId ||
        row.authorityEpochId !== input.authorityEpochId
      )
        unavailable()
      return row
    })
    if (result.kind !== "committed") unavailable()
    return result.value
  }
  async function proof(
    input: StartPaidDispatchInput | ReconcileDispatchInput,
    scope: Scope,
    type: SupervisorAttemptProofInput["type"],
    commandId: string
  ) {
    if (!authority?.readAttemptProof || authority.authorityEpochId !== scope.authorityEpochId)
      unavailable()
    const requested: SupervisorAttemptProofInput = {
      operationId: input.operationId,
      attemptId: input.attemptId,
      workspaceId: scope.workspaceId,
      scanId: scope.scanId,
      authorityEpochId: scope.authorityEpochId,
      type,
      commandId,
      challenge: randomBytes(32).toString("hex"),
      ...(type.startsWith("START_")
        ? { executorKey: executorKeySchema.parse((input as StartPaidDispatchInput).executorKey) }
        : {}),
    }
    const value = verifySupervisorAttemptProof(
      await authority.readAttemptProof(requested),
      requested,
      {
        publicKey: authority.attemptProofPublicKey ?? "",
        supervisorInstanceId: authority.supervisorInstanceId,
      }
    )
    if (value.prepareChecksum !== scope.prepareChecksum) unavailable()
    return value
  }
  async function readStart(client: pg.PoolClient, input: StartPaidDispatchInput) {
    const row = (
      await client.query<{
        startId: string
        kind: string
        authorityProofInputJson: string | null
        authorityProofChecksum: string | null
        createdAt: Date
      }>(
        `SELECT s."startId",s.kind::text,s."authorityProofInputJson",s."authorityProofChecksum",s."createdAt" AT TIME ZONE 'UTC' AS "createdAt"
      FROM "ScanDispatchStart" s JOIN "ScanDispatchAttempt" a ON a."operationId"=s."operationId" AND a."attemptId"=s."attemptId"
      WHERE s."operationId"=$1 AND s."attemptId"=$2 AND a."workspaceId"=app.current_workspace_id()`,
        [input.operationId, input.attemptId]
      )
    ).rows[0]
    if (!row) return null
    if (
      !authority ||
      !row.authorityProofInputJson ||
      sha256Hex(row.authorityProofInputJson) !== row.authorityProofChecksum
    )
      unavailable()
    const retained = supervisorAttemptProofSchema.parse(JSON.parse(row.authorityProofInputJson))
    verifySupervisorAttemptProof(
      retained,
      {
        ...retained.input,
        operationId: input.operationId,
        attemptId: input.attemptId,
        authorityEpochId: input.authorityEpochId,
      },
      {
        publicKey: authority.attemptProofPublicKey ?? "",
        supervisorInstanceId: authority.supervisorInstanceId,
      },
      row.createdAt
    )
    return row
  }
  async function insert(
    client: pg.PoolClient,
    input: StartPaidDispatchInput | ReconcileDispatchInput,
    value: SupervisorAttemptProof
  ) {
    if (!authority) unavailable()
    if (
      value.command.type.startsWith("START_") &&
      (
        await client.query(
          `SELECT 1 FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType" IN ('START_PAID','START_UNMETERED')
        AND status IN ('PENDING','LEASED','DELIVERED','ACCEPTED') LIMIT 1`,
          [input.operationId, input.attemptId]
        )
      ).rowCount
    )
      throw new ScanDispatchAuthorityError(
        "PREPARATION_AUTHORITY_BUSY",
        "Previous executor must complete before the next command is frozen"
      )
    verifySupervisorAttemptProof(value, value.input, {
      publicKey: authority.attemptProofPublicKey ?? "",
      supervisorInstanceId: authority.supervisorInstanceId,
    })
    const bytes = canonicalJson(value),
      commandBytes = canonicalJson(value.command)
    if (
      (
        await client.query(
          "SELECT app.scan_dispatch_lifecycle_proof_current($1,false) AS current",
          [bytes]
        )
      ).rows[0]?.current !== true
    )
      unavailable()
    await client.query(
      `INSERT INTO "ScanDispatchOutbox" (id,"operationId","attemptId","commandType","executorKey",sequence,"commandDigest","commandInputJson","commandInputChecksum","authorityProofInputJson","authorityProofChecksum",status,attempts,"availableAt","createdAt","updatedAt")
      VALUES($1,$2,$3,$4::"ScanDispatchCommandType",$5,$6,$7,$8,$7,$9,$10,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        value.command.commandId,
        input.operationId,
        input.attemptId,
        value.command.type,
        "executorKey" in value.command ? value.command.executorKey : "",
        value.command.type.startsWith("START_") ? 2 : value.command.type === "STOP" ? 3 : 4,
        sha256Hex(commandBytes),
        commandBytes,
        bytes,
        sha256Hex(bytes),
      ]
    )
    return value.command.commandId
  }
  return {
    async start(
      input: StartPaidDispatchInput,
      kind: "PAID" | "UNMETERED"
    ): Promise<StartPaidDispatchResult> {
      if (!options.stageTransaction || !authority?.readAttemptProof) unavailable()
      const executorKey = executorKeySchema.parse(input.executorKey)
      const scope = await readScope(input, "execution"),
        type = kind === "PAID" ? "START_PAID" : "START_UNMETERED"
      const existing = await options.nativeTransaction(input.operationId, async (client) => {
        const stage = await readStart(client, input)
        if (stage && stage.kind !== kind) unavailable()
        const command = (
          await client.query<{ id: string }>(
            `SELECT id FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"=$3::"ScanDispatchCommandType" AND "executorKey"=$4`,
            [input.operationId, input.attemptId, type, executorKey]
          )
        ).rows[0]
        return { stage, command }
      })
      if (existing.kind !== "committed") return existing
      if (existing.value.stage && existing.value.command)
        return {
          kind: "committed",
          operationId: input.operationId,
          state: "START_PENDING",
          attemptId: input.attemptId,
          startId: existing.value.stage.startId,
          commandId: existing.value.command.id,
        }
      const commandId = createId()
      let startId = existing.value.stage?.startId
      if (!startId) {
        const initial = await proof(input, scope, type, commandId)
        const context = {
          ...options.context,
          preparationAuthority: undefined,
          stageProof: initial,
          transaction: options.stageTransaction,
        }
        const staged =
          kind === "PAID"
            ? await startPaidDispatch(context, input)
            : await startUnmeteredDispatch(context, input)
        if (staged.kind !== "committed") return staged
        startId = staged.startId
      }
      const fresh = await proof(input, scope, type, commandId)
      const frozen = await options.nativeTransaction(input.operationId, async (client) => {
        await options.context.lockOperation(client, input)
        const stage = await readStart(client, input)
        if (!stage || stage.kind !== kind || stage.startId !== startId) unavailable()
        const id = await insert(client, input, fresh)
        return {
          state: "START_PENDING" as const,
          attemptId: input.attemptId,
          startId: stage.startId,
          commandId: id,
        }
      })
      return frozen.kind === "committed"
        ? { kind: "committed", operationId: input.operationId, ...frozen.value }
        : frozen
    },
    async cleanup(input: StopDispatchInput | ReconcileDispatchInput, type: "STOP" | "RECONCILE") {
      // Cleanup keeps the original checked identity; signed STOP and retained native
      // ownership authorize removal after the worker's execution grant is retired.
      const scope = await readScope(input, "cleanup")
      const replay = await options.cleanupTransaction(input.operationId, async (client) => {
        let selectedType = type
        if (type === "RECONCILE") {
          // Root retirement requires an original signed STOP. Reconciliation
          // can request that first STOP, but never invent prior cleanup history.
          const stop = (
            await client.query<{
              id: string
              commandInputJson: string
              commandInputChecksum: string
            }>(
              `SELECT id,"commandInputJson","commandInputChecksum" FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"='STOP' AND "executorKey"=''`,
              [input.operationId, input.attemptId]
            )
          ).rows[0]
          if (!stop) selectedType = "STOP"
          else {
            const command = readStoredDispatchCommand(
              stop.commandInputJson,
              stop.commandInputChecksum
            )
            if (
              !command ||
              command.type !== "STOP" ||
              command.commandId !== stop.id ||
              command.attemptId !== input.attemptId
            )
              unavailable()
          }
        }
        const existing = (
          await client.query<{ id: string }>(
            `SELECT id FROM "ScanDispatchOutbox" WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"=$3::"ScanDispatchCommandType" AND "executorKey"=''`,
            [input.operationId, input.attemptId, selectedType]
          )
        ).rows[0]
        return { commandId: existing?.id, type: selectedType }
      })
      if (replay.kind !== "committed") return replay
      type = replay.value.type
      if (replay.value.commandId)
        return {
          kind: "committed" as const,
          operationId: input.operationId,
          state: type === "STOP" ? ("STOPPING" as const) : ("UNKNOWN" as const),
          attemptId: input.attemptId,
          commandId: replay.value.commandId,
        }
      const fresh = await proof(input, scope, type, createId())
      const outcome = await options.cleanupTransaction(input.operationId, async (client) => {
        const operation = await options.cleanupLockOperation(client, input)
        if (
          type === "RECONCILE"
            ? operation.state !== "UNKNOWN"
            : !["PREPARING", "PREPARED", "START_PENDING", "ACTIVE", "STOPPING", "UNKNOWN"].includes(
                operation.state
              )
        )
          unavailable()
        const commandId = await insert(client, input, fresh)
        // UNKNOWN remains sticky until authenticated physical cleanup resolves it.
        if (type === "STOP" && operation.state !== "UNKNOWN")
          await client.query(
            `UPDATE "ScanDispatchOperation" SET state='STOPPING',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1 AND "workspaceId"=app.current_workspace_id()`,
            [input.operationId]
          )
        return {
          state: type === "STOP" ? ("STOPPING" as const) : ("UNKNOWN" as const),
          attemptId: input.attemptId,
          commandId,
        }
      })
      return outcome.kind === "committed"
        ? { kind: "committed" as const, operationId: input.operationId, ...outcome.value }
        : outcome
    },
  }
}
