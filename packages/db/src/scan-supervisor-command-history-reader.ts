import pg from "pg"
import {
  readInstalledJournalSealControlPolicy,
  type JournalSealControlPolicy,
  canonicalJson,
} from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"
import { authenticateRetainedSupervisorHistoryBytes } from "./scan-supervisor-authority-source-verifier"
import {
  checkReceiptKeys,
  receiptFailure,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"
import {
  readRetainedSupervisorCommand,
  supervisorCommandHistoryInputSchema,
  type SupervisorCommandHistoryInput,
} from "./scan-supervisor-command-history"
import { bindScanPreparationContext } from "./scan-preparation-context"
import { sha256Hex } from "./scan-supervisor-receipt-verifier"
import {
  withCurrentPersistedPrepare,
  type CurrentPersistedPrepare,
} from "./scan-supervisor-current-command"

type History = Awaited<ReturnType<typeof readRetainedSupervisorCommand>>
async function bindAuthenticatedHistory(
  client: pg.PoolClient,
  input: SupervisorCommandHistoryInput,
  authority: SupervisorReceiptAuthority
) {
  const rows = (
    await client.query<{ originalInputJson: string; wrapperInputJson: string }>(
      `SELECT j."originalInputJson",j."wrapperInputJson" FROM "ScanSupervisorJournalRecord" j
 JOIN "ScanSupervisorJournalStream" s ON s.id=j."streamId"
 WHERE s.id=$1 AND s."authorityEpochId"=$2 AND s."supervisorInstanceId"=$3 AND s."originalKeyHash"=$4 AND s."wrapperKeyHash"=$5
 AND j.sequence<=s."confirmedSequence" AND j."attemptId"=$6
 AND j."originalInputJson"::jsonb->'payload'->>'type'='command_intent'
 AND coalesce(j."originalInputJson"::jsonb->'payload'->>'commandId',j."originalInputJson"::jsonb->'payload'->'command'->>'commandId')=$7
 ORDER BY j.sequence LIMIT 2`,
      [
        authority.streamId,
        authority.authorityEpochId,
        authority.supervisorInstanceId,
        authority.originalKeyHash,
        authority.wrapperKeyHash,
        input.attemptId,
        input.commandId,
      ]
    )
  ).rows
  if (rows.length !== 1) receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  const source = authenticateRetainedSupervisorHistoryBytes(rows[0]!, authority)
  if (
    source.original.payload.type !== "command_intent" ||
    sha256Hex(canonicalJson(source.original.payload.command)) !== input.requestHash ||
    source.wrapper.payload.attemptId !== input.attemptId
  )
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  await bindScanPreparationContext(client, source.wrapper.payload.operationId)
}

/** Root-installed private source only. Caller already holds the protected independent stream gate.
 * The native DB gate remains held through the witness CAS callback; this never authorizes absence. */
export class SupervisorCommandHistoryReader {
  readonly #authority: SupervisorReceiptAuthority
  readonly #pool: pg.Pool
  readonly #policy: JournalSealControlPolicy | null
  private constructor(config: SupervisorReceiptAuthority, policy: JournalSealControlPolicy | null) {
    this.#authority = Object.freeze({ ...config })
    checkReceiptKeys(this.#authority)
    this.#policy = policy
    this.#pool = new pg.Pool({
      ...createPgConnectionConfig(config.connectionString),
      max: 2,
      connectionTimeoutMillis: 3000,
    })
    this.#pool.on("error", () => undefined)
  }
  static installed(config: SupervisorReceiptAuthority) {
    const source = process.env.LYRASHIELD_PRODUCT_REVISION
    if (!source || !/^[a-f0-9]{40}$/.test(source))
      receiptFailure("SUPERVISOR_INSTALLED_HISTORY_UNAVAILABLE")
    const policy = readInstalledJournalSealControlPolicy(source)
    if (
      policy.streamId !== config.streamId ||
      policy.epochId !== config.authorityEpochId ||
      policy.supervisorInstanceId !== config.supervisorInstanceId ||
      policy.originalKeyHash !== config.originalKeyHash ||
      policy.wrapperKeyHash !== config.wrapperKeyHash
    )
      receiptFailure("SUPERVISOR_INSTALLED_HISTORY_UNAVAILABLE")
    return new SupervisorCommandHistoryReader(config, policy)
  }
  static disposableForTest(config: SupervisorReceiptAuthority) {
    if (process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1")
      receiptFailure("SUPERVISOR_DISPOSABLE_HISTORY_UNAVAILABLE")
    return new SupervisorCommandHistoryReader(config, null)
  }
  static isInstalled(value: unknown): value is SupervisorCommandHistoryReader {
    return (
      value instanceof SupervisorCommandHistoryReader && #policy in value && value.#policy !== null
    )
  }
  private assertInstalledPolicy() {
    if (
      this.#policy &&
      canonicalJson(readInstalledJournalSealControlPolicy(this.#policy.productRevision)) !==
        canonicalJson(this.#policy)
    )
      receiptFailure("SUPERVISOR_INSTALLED_HISTORY_UNAVAILABLE")
  }
  async withRead<T>(
    input: SupervisorCommandHistoryInput,
    action: (history: History, assertActive: () => void) => Promise<T>
  ): Promise<T> {
    const authority = this.#authority
    const parsed = supervisorCommandHistoryInputSchema.parse(input)
    if (
      parsed.streamId !== authority.streamId ||
      parsed.authorityEpochId !== authority.authorityEpochId
    )
      receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
    return this.withGate(async (client, assertActive) => {
      await bindAuthenticatedHistory(client, parsed, authority)
      const history = await readRetainedSupervisorCommand(client, parsed, authority)
      return action(history, assertActive)
    })
  }
  async withCurrentPrepare<T>(
    input: { command: unknown; requestHash: string },
    action: (verified: CurrentPersistedPrepare, assertActive: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.withGate((client, assertConnectionActive) =>
      withCurrentPersistedPrepare(client, input, async (verified, assertAuthorityActive) => {
        if (verified.command.attempt.authorityEpochId !== this.#authority.authorityEpochId)
          receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
        const assertActive = async () => {
          assertConnectionActive()
          await assertAuthorityActive()
          this.assertInstalledPolicy()
        }
        await assertActive()
        const result = await action(verified, assertActive)
        await assertActive()
        return result
      })
    )
  }
  private async withGate<T>(
    action: (client: pg.PoolClient, assertActive: () => void) => Promise<T>
  ): Promise<T> {
    this.assertInstalledPolicy()
    const client = await this.#pool.connect()
    let failed = true,
      active = true
    const end = () => {
      active = false
    }
    client.on("error", end)
    client.on("end", end)
    const assertActive = () => {
      if (!active) receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
    }
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
      await client.query("SET LOCAL statement_timeout='5s'")
      await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'")
      const held = await client.query<{ held: boolean }>(
        "SELECT pg_try_advisory_xact_lock(1819234670,1) AS held"
      )
      if (held.rows[0]?.held !== true) receiptFailure("SUPERVISOR_AUTHORITY_BUSY")
      assertActive()
      const result = await action(client, assertActive)
      assertActive()
      this.assertInstalledPolicy()
      await client.query("COMMIT")
      failed = false
      return result
    } finally {
      active = false
      client.off("error", end)
      client.off("end", end)
      if (failed)
        try {
          await client.query("ROLLBACK")
        } catch {
          /* Discard dead connection. */
        }
      client.release(failed)
    }
  }

  async close() {
    await this.#pool.end()
  }
}
export function createSupervisorCommandHistoryReader(config: SupervisorReceiptAuthority) {
  return SupervisorCommandHistoryReader.installed(config)
}
export function createDisposableSupervisorCommandHistoryReader(config: SupervisorReceiptAuthority) {
  return SupervisorCommandHistoryReader.disposableForTest(config)
}
